"""
TSCM (Technical Surveillance Countermeasures) Routes

Provides endpoints for counter-surveillance sweeps, baseline management,
threat detection, and reporting.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import time
from datetime import datetime
from typing import Any

from flask import Blueprint, Response, jsonify, request

from data.tscm_frequencies import (
    SWEEP_PRESETS,
    get_all_sweep_presets,
    get_sweep_preset,
)
from utils.database import (
    add_tscm_threat,
    acknowledge_tscm_threat,
    create_tscm_sweep,
    delete_tscm_baseline,
    get_active_tscm_baseline,
    get_all_tscm_baselines,
    get_tscm_baseline,
    get_tscm_sweep,
    get_tscm_threat_summary,
    get_tscm_threats,
    set_active_tscm_baseline,
    update_tscm_sweep,
)
from utils.tscm.baseline import BaselineComparator, BaselineRecorder
from utils.tscm.correlation import (
    CorrelationEngine,
    get_correlation_engine,
    reset_correlation_engine,
)
from utils.tscm.detector import ThreatDetector

logger = logging.getLogger('intercept.tscm')

tscm_bp = Blueprint('tscm', __name__, url_prefix='/tscm')

# =============================================================================
# Global State (will be initialized from app.py)
# =============================================================================

# These will be set by app.py
tscm_queue: queue.Queue | None = None
tscm_lock: threading.Lock | None = None

# Local state
_sweep_thread: threading.Thread | None = None
_sweep_running = False
_current_sweep_id: int | None = None
_baseline_recorder = BaselineRecorder()


def init_tscm_state(tscm_q: queue.Queue, lock: threading.Lock) -> None:
    """Initialize TSCM state from app.py."""
    global tscm_queue, tscm_lock
    tscm_queue = tscm_q
    tscm_lock = lock


def _emit_event(event_type: str, data: dict) -> None:
    """Emit an event to the SSE queue."""
    if tscm_queue:
        try:
            tscm_queue.put_nowait({
                'type': event_type,
                'timestamp': datetime.now().isoformat(),
                **data
            })
        except queue.Full:
            logger.warning("TSCM queue full, dropping event")


# =============================================================================
# Sweep Endpoints
# =============================================================================

def _check_available_devices(wifi: bool, bt: bool, rf: bool) -> dict:
    """Check which scanning devices are available."""
    import os
    import platform
    import shutil
    import subprocess

    available = {
        'wifi': False,
        'bluetooth': False,
        'rf': False,
        'wifi_reason': 'Not checked',
        'bt_reason': 'Not checked',
        'rf_reason': 'Not checked',
    }

    # Check WiFi
    if wifi:
        if platform.system() == 'Darwin':
            # macOS: Check for airport utility
            airport_path = '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport'
            if os.path.exists(airport_path):
                try:
                    result = subprocess.run(
                        [airport_path, '-I'],
                        capture_output=True,
                        text=True,
                        timeout=5
                    )
                    if result.returncode == 0:
                        available['wifi'] = True
                        available['wifi_reason'] = 'macOS WiFi available'
                    else:
                        available['wifi_reason'] = 'WiFi interface not active'
                except (subprocess.TimeoutExpired, subprocess.SubprocessError):
                    available['wifi_reason'] = 'Cannot access WiFi interface'
            else:
                available['wifi_reason'] = 'macOS airport utility not found'
        else:
            # Linux: Check for wireless tools
            if shutil.which('iwlist') or shutil.which('iw'):
                try:
                    result = subprocess.run(
                        ['iwconfig'],
                        capture_output=True,
                        text=True,
                        timeout=5
                    )
                    if 'no wireless extensions' not in result.stderr.lower() and result.stdout.strip():
                        available['wifi'] = True
                        available['wifi_reason'] = 'Wireless interface detected'
                    else:
                        available['wifi_reason'] = 'No wireless interfaces found'
                except (subprocess.TimeoutExpired, FileNotFoundError):
                    # Try iw as fallback
                    try:
                        result = subprocess.run(
                            ['iw', 'dev'],
                            capture_output=True,
                            text=True,
                            timeout=5
                        )
                        if 'Interface' in result.stdout:
                            available['wifi'] = True
                            available['wifi_reason'] = 'Wireless interface detected'
                        else:
                            available['wifi_reason'] = 'No wireless interfaces found'
                    except (subprocess.TimeoutExpired, FileNotFoundError):
                        available['wifi_reason'] = 'Cannot detect wireless interfaces'
            else:
                available['wifi_reason'] = 'WiFi tools not installed (wireless-tools)'

    # Check Bluetooth
    if bt:
        if platform.system() == 'Darwin':
            # macOS: Check for Bluetooth via system_profiler
            try:
                result = subprocess.run(
                    ['system_profiler', 'SPBluetoothDataType'],
                    capture_output=True,
                    text=True,
                    timeout=10
                )
                if 'Bluetooth' in result.stdout and result.returncode == 0:
                    available['bluetooth'] = True
                    available['bt_reason'] = 'macOS Bluetooth available'
                else:
                    available['bt_reason'] = 'Bluetooth not available'
            except (subprocess.TimeoutExpired, FileNotFoundError):
                available['bt_reason'] = 'Cannot detect Bluetooth'
        else:
            # Linux: Check for Bluetooth tools
            if shutil.which('bluetoothctl') or shutil.which('hcitool'):
                try:
                    result = subprocess.run(
                        ['hciconfig'],
                        capture_output=True,
                        text=True,
                        timeout=5
                    )
                    if 'hci' in result.stdout.lower():
                        available['bluetooth'] = True
                        available['bt_reason'] = 'Bluetooth adapter detected'
                    else:
                        available['bt_reason'] = 'No Bluetooth adapters found'
                except (subprocess.TimeoutExpired, FileNotFoundError):
                    # Try bluetoothctl as fallback
                    try:
                        result = subprocess.run(
                            ['bluetoothctl', 'list'],
                            capture_output=True,
                            text=True,
                            timeout=5
                        )
                        if result.stdout.strip():
                            available['bluetooth'] = True
                            available['bt_reason'] = 'Bluetooth adapter detected'
                        else:
                            available['bt_reason'] = 'No Bluetooth adapters found'
                    except (subprocess.TimeoutExpired, FileNotFoundError):
                        available['bt_reason'] = 'Cannot detect Bluetooth adapters'
            else:
                available['bt_reason'] = 'Bluetooth tools not installed (bluez)'

    # Check RF/SDR
    if rf:
        try:
            from utils.sdr import SDRFactory
            devices = SDRFactory.detect_devices()
            if devices:
                available['rf'] = True
                available['rf_reason'] = f'{len(devices)} SDR device(s) detected'
            else:
                available['rf_reason'] = 'No SDR devices found'
        except ImportError:
            available['rf_reason'] = 'SDR detection unavailable'

    return available


@tscm_bp.route('/sweep/start', methods=['POST'])
def start_sweep():
    """Start a TSCM sweep."""
    global _sweep_running, _sweep_thread, _current_sweep_id

    if _sweep_running:
        return jsonify({'status': 'error', 'message': 'Sweep already running'})

    data = request.get_json() or {}
    sweep_type = data.get('sweep_type', 'standard')
    baseline_id = data.get('baseline_id')
    wifi_enabled = data.get('wifi', True)
    bt_enabled = data.get('bluetooth', True)
    rf_enabled = data.get('rf', True)

    # Get interface selections
    wifi_interface = data.get('wifi_interface', '')
    bt_interface = data.get('bt_interface', '')
    sdr_device = data.get('sdr_device')

    # Check for available devices
    devices = _check_available_devices(wifi_enabled, bt_enabled, rf_enabled)

    warnings = []
    if wifi_enabled and not devices['wifi']:
        warnings.append(f"WiFi: {devices['wifi_reason']}")
    if bt_enabled and not devices['bluetooth']:
        warnings.append(f"Bluetooth: {devices['bt_reason']}")
    if rf_enabled and not devices['rf']:
        warnings.append(f"RF: {devices['rf_reason']}")

    # If no devices available at all, return error
    if not any([devices['wifi'], devices['bluetooth'], devices['rf']]):
        return jsonify({
            'status': 'error',
            'message': 'No scanning devices available',
            'details': warnings
        }), 400

    # Create sweep record
    _current_sweep_id = create_tscm_sweep(
        sweep_type=sweep_type,
        baseline_id=baseline_id,
        wifi_enabled=wifi_enabled,
        bt_enabled=bt_enabled,
        rf_enabled=rf_enabled
    )

    _sweep_running = True

    # Start sweep thread
    _sweep_thread = threading.Thread(
        target=_run_sweep,
        args=(sweep_type, baseline_id, wifi_enabled, bt_enabled, rf_enabled,
              wifi_interface, bt_interface, sdr_device),
        daemon=True
    )
    _sweep_thread.start()

    logger.info(f"Started TSCM sweep: type={sweep_type}, id={_current_sweep_id}")

    return jsonify({
        'status': 'success',
        'message': 'Sweep started',
        'sweep_id': _current_sweep_id,
        'sweep_type': sweep_type,
        'warnings': warnings if warnings else None,
        'devices': {
            'wifi': devices['wifi'],
            'bluetooth': devices['bluetooth'],
            'rf': devices['rf']
        }
    })


@tscm_bp.route('/sweep/stop', methods=['POST'])
def stop_sweep():
    """Stop the current TSCM sweep."""
    global _sweep_running

    if not _sweep_running:
        return jsonify({'status': 'error', 'message': 'No sweep running'})

    _sweep_running = False

    if _current_sweep_id:
        update_tscm_sweep(_current_sweep_id, status='aborted', completed=True)

    _emit_event('sweep_stopped', {'reason': 'user_requested'})

    logger.info("TSCM sweep stopped by user")

    return jsonify({'status': 'success', 'message': 'Sweep stopped'})


@tscm_bp.route('/sweep/status')
def sweep_status():
    """Get current sweep status."""
    status = {
        'running': _sweep_running,
        'sweep_id': _current_sweep_id,
    }

    if _current_sweep_id:
        sweep = get_tscm_sweep(_current_sweep_id)
        if sweep:
            status['sweep'] = sweep

    return jsonify(status)


@tscm_bp.route('/sweep/stream')
def sweep_stream():
    """SSE stream for real-time sweep updates."""
    def generate():
        while True:
            try:
                if tscm_queue:
                    msg = tscm_queue.get(timeout=1)
                    yield f"data: {json.dumps(msg)}\n\n"
                else:
                    time.sleep(1)
                    yield f"data: {json.dumps({'type': 'keepalive'})}\n\n"
            except queue.Empty:
                yield f"data: {json.dumps({'type': 'keepalive'})}\n\n"

    return Response(
        generate(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        }
    )


@tscm_bp.route('/devices')
def get_tscm_devices():
    """Get available scanning devices for TSCM sweeps."""
    import platform
    import shutil
    import subprocess

    devices = {
        'wifi_interfaces': [],
        'bt_adapters': [],
        'sdr_devices': []
    }

    # Detect WiFi interfaces
    if platform.system() == 'Darwin':  # macOS
        try:
            result = subprocess.run(
                ['networksetup', '-listallhardwareports'],
                capture_output=True, text=True, timeout=5
            )
            lines = result.stdout.split('\n')
            for i, line in enumerate(lines):
                if 'Wi-Fi' in line or 'AirPort' in line:
                    # Get the hardware port name (e.g., "Wi-Fi")
                    port_name = line.replace('Hardware Port:', '').strip()
                    for j in range(i + 1, min(i + 3, len(lines))):
                        if 'Device:' in lines[j]:
                            device = lines[j].split('Device:')[1].strip()
                            devices['wifi_interfaces'].append({
                                'name': device,
                                'display_name': f'{port_name} ({device})',
                                'type': 'internal',
                                'monitor_capable': False
                            })
                            break
        except (FileNotFoundError, subprocess.TimeoutExpired, subprocess.SubprocessError):
            pass
    else:  # Linux
        try:
            result = subprocess.run(
                ['iw', 'dev'],
                capture_output=True, text=True, timeout=5
            )
            current_iface = None
            for line in result.stdout.split('\n'):
                line = line.strip()
                if line.startswith('Interface'):
                    current_iface = line.split()[1]
                elif current_iface and 'type' in line:
                    iface_type = line.split()[-1]
                    devices['wifi_interfaces'].append({
                        'name': current_iface,
                        'display_name': f'Wireless ({current_iface}) - {iface_type}',
                        'type': iface_type,
                        'monitor_capable': True
                    })
                    current_iface = None
        except (FileNotFoundError, subprocess.TimeoutExpired, subprocess.SubprocessError):
            # Fall back to iwconfig
            try:
                result = subprocess.run(
                    ['iwconfig'],
                    capture_output=True, text=True, timeout=5
                )
                for line in result.stdout.split('\n'):
                    if 'IEEE 802.11' in line:
                        iface = line.split()[0]
                        devices['wifi_interfaces'].append({
                            'name': iface,
                            'display_name': f'Wireless ({iface})',
                            'type': 'managed',
                            'monitor_capable': True
                        })
            except (FileNotFoundError, subprocess.TimeoutExpired, subprocess.SubprocessError):
                pass

    # Detect Bluetooth adapters
    if platform.system() == 'Linux':
        try:
            result = subprocess.run(
                ['hciconfig'],
                capture_output=True, text=True, timeout=5
            )
            import re
            blocks = re.split(r'(?=^hci\d+:)', result.stdout, flags=re.MULTILINE)
            for idx, block in enumerate(blocks):
                if block.strip():
                    first_line = block.split('\n')[0]
                    match = re.match(r'(hci\d+):', first_line)
                    if match:
                        iface_name = match.group(1)
                        is_up = 'UP RUNNING' in block or '\tUP ' in block
                        devices['bt_adapters'].append({
                            'name': iface_name,
                            'display_name': f'Bluetooth Adapter ({iface_name})',
                            'type': 'hci',
                            'status': 'up' if is_up else 'down'
                        })
        except (FileNotFoundError, subprocess.TimeoutExpired, subprocess.SubprocessError):
            # Try bluetoothctl as fallback
            try:
                result = subprocess.run(
                    ['bluetoothctl', 'list'],
                    capture_output=True, text=True, timeout=5
                )
                for line in result.stdout.split('\n'):
                    if 'Controller' in line:
                        # Format: Controller XX:XX:XX:XX:XX:XX Name
                        parts = line.split()
                        if len(parts) >= 3:
                            addr = parts[1]
                            name = ' '.join(parts[2:]) if len(parts) > 2 else 'Bluetooth'
                            devices['bt_adapters'].append({
                                'name': addr,
                                'display_name': f'{name} ({addr[-8:]})',
                                'type': 'controller',
                                'status': 'available'
                            })
            except (FileNotFoundError, subprocess.TimeoutExpired, subprocess.SubprocessError):
                pass
    elif platform.system() == 'Darwin':
        # macOS has built-in Bluetooth - get more info via system_profiler
        try:
            result = subprocess.run(
                ['system_profiler', 'SPBluetoothDataType'],
                capture_output=True, text=True, timeout=10
            )
            # Extract controller info
            bt_name = 'Built-in Bluetooth'
            bt_addr = ''
            for line in result.stdout.split('\n'):
                if 'Address:' in line:
                    bt_addr = line.split('Address:')[1].strip()
                    break
            devices['bt_adapters'].append({
                'name': 'default',
                'display_name': f'{bt_name}' + (f' ({bt_addr[-8:]})' if bt_addr else ''),
                'type': 'macos',
                'status': 'available'
            })
        except (FileNotFoundError, subprocess.TimeoutExpired, subprocess.SubprocessError):
            devices['bt_adapters'].append({
                'name': 'default',
                'display_name': 'Built-in Bluetooth',
                'type': 'macos',
                'status': 'available'
            })

    # Detect SDR devices
    try:
        from utils.sdr import SDRFactory
        sdr_list = SDRFactory.detect_devices()
        for sdr in sdr_list:
            # SDRDevice is a dataclass with attributes, not a dict
            sdr_type_name = sdr.sdr_type.value if hasattr(sdr.sdr_type, 'value') else str(sdr.sdr_type)
            # Create a friendly display name
            display_name = sdr.name
            if sdr.serial and sdr.serial not in ('N/A', 'Unknown'):
                display_name = f'{sdr.name} (SN: {sdr.serial[-8:]})'
            devices['sdr_devices'].append({
                'index': sdr.index,
                'name': sdr.name,
                'display_name': display_name,
                'type': sdr_type_name,
                'serial': sdr.serial,
                'driver': sdr.driver
            })
    except ImportError:
        logger.debug("SDR module not available")
    except Exception as e:
        logger.warning(f"Error detecting SDR devices: {e}")

    return jsonify({'status': 'success', 'devices': devices})


def _scan_wifi_networks(interface: str) -> list[dict]:
    """Scan for WiFi networks using system tools."""
    import platform
    import re
    import subprocess

    networks = []

    if platform.system() == 'Darwin':
        # macOS: Use airport utility
        airport_path = '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport'
        try:
            result = subprocess.run(
                [airport_path, '-s'],
                capture_output=True, text=True, timeout=15
            )
            # Parse airport output
            # Format: SSID BSSID RSSI CHANNEL HT CC SECURITY
            lines = result.stdout.strip().split('\n')
            for line in lines[1:]:  # Skip header
                if not line.strip():
                    continue
                # Parse the line - format is space-separated but SSID can have spaces
                parts = line.split()
                if len(parts) >= 7:
                    # BSSID is always XX:XX:XX:XX:XX:XX format
                    bssid_idx = None
                    for i, p in enumerate(parts):
                        if re.match(r'^[0-9a-fA-F:]{17}$', p):
                            bssid_idx = i
                            break
                    if bssid_idx is not None:
                        ssid = ' '.join(parts[:bssid_idx]) if bssid_idx > 0 else '[Hidden]'
                        bssid = parts[bssid_idx]
                        rssi = parts[bssid_idx + 1] if len(parts) > bssid_idx + 1 else '-100'
                        channel = parts[bssid_idx + 2] if len(parts) > bssid_idx + 2 else '0'
                        security = ' '.join(parts[bssid_idx + 5:]) if len(parts) > bssid_idx + 5 else ''
                        networks.append({
                            'bssid': bssid.upper(),
                            'essid': ssid or '[Hidden]',
                            'power': rssi,
                            'channel': channel,
                            'privacy': security
                        })
        except (FileNotFoundError, subprocess.TimeoutExpired, subprocess.SubprocessError) as e:
            logger.warning(f"macOS WiFi scan failed: {e}")

    else:
        # Linux: Try iwlist scan
        iface = interface or 'wlan0'
        try:
            result = subprocess.run(
                ['iwlist', iface, 'scan'],
                capture_output=True, text=True, timeout=30
            )
            current_network = {}
            for line in result.stdout.split('\n'):
                line = line.strip()
                if 'Cell' in line and 'Address:' in line:
                    if current_network.get('bssid'):
                        networks.append(current_network)
                    bssid = line.split('Address:')[1].strip()
                    current_network = {'bssid': bssid.upper(), 'essid': '[Hidden]'}
                elif 'ESSID:' in line:
                    essid = line.split('ESSID:')[1].strip().strip('"')
                    current_network['essid'] = essid or '[Hidden]'
                elif 'Channel:' in line:
                    channel = line.split('Channel:')[1].strip()
                    current_network['channel'] = channel
                elif 'Signal level=' in line:
                    match = re.search(r'Signal level[=:]?\s*(-?\d+)', line)
                    if match:
                        current_network['power'] = match.group(1)
                elif 'Encryption key:' in line:
                    encrypted = 'on' in line.lower()
                    current_network['encrypted'] = encrypted
                elif 'WPA' in line or 'WPA2' in line:
                    current_network['privacy'] = 'WPA2' if 'WPA2' in line else 'WPA'
            if current_network.get('bssid'):
                networks.append(current_network)
        except (FileNotFoundError, subprocess.TimeoutExpired, subprocess.SubprocessError) as e:
            logger.warning(f"Linux WiFi scan failed: {e}")

    return networks


def _scan_bluetooth_devices(interface: str, duration: int = 10) -> list[dict]:
    """Scan for Bluetooth devices using system tools."""
    import platform
    import os
    import re
    import shutil
    import subprocess

    devices = []
    seen_macs = set()

    logger.info(f"Starting Bluetooth scan (duration={duration}s, interface={interface})")

    if platform.system() == 'Darwin':
        # macOS: Use system_profiler for basic Bluetooth info
        try:
            result = subprocess.run(
                ['system_profiler', 'SPBluetoothDataType', '-json'],
                capture_output=True, text=True, timeout=15
            )
            import json
            data = json.loads(result.stdout)
            bt_data = data.get('SPBluetoothDataType', [{}])[0]

            # Get connected/paired devices
            for section in ['device_connected', 'device_title']:
                section_data = bt_data.get(section, {})
                if isinstance(section_data, dict):
                    for name, info in section_data.items():
                        if isinstance(info, dict):
                            mac = info.get('device_address', '')
                            if mac and mac not in seen_macs:
                                seen_macs.add(mac)
                                devices.append({
                                    'mac': mac.upper(),
                                    'name': name,
                                    'type': info.get('device_minorType', 'unknown'),
                                    'connected': section == 'device_connected'
                                })
            logger.info(f"macOS Bluetooth scan found {len(devices)} devices")
        except (FileNotFoundError, subprocess.TimeoutExpired, subprocess.SubprocessError, json.JSONDecodeError) as e:
            logger.warning(f"macOS Bluetooth scan failed: {e}")

    else:
        # Linux: Try multiple methods
        iface = interface or 'hci0'

        # Method 1: Try hcitool scan (simpler, more reliable)
        if shutil.which('hcitool'):
            try:
                logger.info("Trying hcitool scan...")
                result = subprocess.run(
                    ['hcitool', '-i', iface, 'scan', '--flush'],
                    capture_output=True, text=True, timeout=duration + 5
                )
                for line in result.stdout.split('\n'):
                    line = line.strip()
                    if line and '\t' in line:
                        parts = line.split('\t')
                        if len(parts) >= 1 and ':' in parts[0]:
                            mac = parts[0].strip().upper()
                            name = parts[1].strip() if len(parts) > 1 else 'Unknown'
                            if mac not in seen_macs:
                                seen_macs.add(mac)
                                devices.append({'mac': mac, 'name': name})
                logger.info(f"hcitool scan found {len(devices)} classic BT devices")
            except (subprocess.TimeoutExpired, subprocess.SubprocessError) as e:
                logger.warning(f"hcitool scan failed: {e}")

        # Method 2: Try btmgmt for BLE devices
        if shutil.which('btmgmt'):
            try:
                logger.info("Trying btmgmt find...")
                result = subprocess.run(
                    ['btmgmt', 'find'],
                    capture_output=True, text=True, timeout=duration + 5
                )
                for line in result.stdout.split('\n'):
                    # Parse btmgmt output: "dev_found: XX:XX:XX:XX:XX:XX type LE..."
                    if 'dev_found' in line.lower() or ('type' in line.lower() and ':' in line):
                        mac_match = re.search(
                            r'([0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:'
                            r'[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2})',
                            line
                        )
                        if mac_match:
                            mac = mac_match.group(1).upper()
                            if mac not in seen_macs:
                                seen_macs.add(mac)
                                # Try to extract name
                                name_match = re.search(r'name\s+(.+?)(?:\s|$)', line, re.I)
                                name = name_match.group(1) if name_match else 'Unknown BLE'
                                devices.append({
                                    'mac': mac,
                                    'name': name,
                                    'type': 'ble' if 'le' in line.lower() else 'classic'
                                })
                logger.info(f"btmgmt found {len(devices)} total devices")
            except (subprocess.TimeoutExpired, subprocess.SubprocessError) as e:
                logger.warning(f"btmgmt find failed: {e}")

        # Method 3: Try bluetoothctl as last resort
        if not devices and shutil.which('bluetoothctl'):
            try:
                import pty
                import select

                logger.info("Trying bluetoothctl scan...")
                master_fd, slave_fd = pty.openpty()
                process = subprocess.Popen(
                    ['bluetoothctl'],
                    stdin=slave_fd,
                    stdout=slave_fd,
                    stderr=slave_fd,
                    close_fds=True
                )
                os.close(slave_fd)

                # Start scanning
                time.sleep(0.3)
                os.write(master_fd, b'power on\n')
                time.sleep(0.3)
                os.write(master_fd, b'scan on\n')

                # Collect devices for specified duration
                scan_end = time.time() + min(duration, 10)  # Cap at 10 seconds
                buffer = ''

                while time.time() < scan_end:
                    readable, _, _ = select.select([master_fd], [], [], 1.0)
                    if readable:
                        try:
                            data = os.read(master_fd, 4096)
                            if not data:
                                break
                            buffer += data.decode('utf-8', errors='replace')

                            while '\n' in buffer:
                                line, buffer = buffer.split('\n', 1)
                                line = re.sub(r'\x1b\[[0-9;]*m', '', line).strip()

                                if 'Device' in line:
                                    match = re.search(
                                        r'([0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:'
                                        r'[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2})\s*(.*)',
                                        line
                                    )
                                    if match:
                                        mac = match.group(1).upper()
                                        name = match.group(2).strip()
                                        # Remove RSSI from name if present
                                        name = re.sub(r'\s*RSSI:\s*-?\d+\s*', '', name).strip()

                                        if mac not in seen_macs:
                                            seen_macs.add(mac)
                                            devices.append({
                                                'mac': mac,
                                                'name': name or '[Unknown]'
                                            })
                        except OSError:
                            break

                # Stop scanning and cleanup
                try:
                    os.write(master_fd, b'scan off\n')
                    time.sleep(0.2)
                    os.write(master_fd, b'quit\n')
                except OSError:
                    pass

                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()

                try:
                    os.close(master_fd)
                except OSError:
                    pass

                logger.info(f"bluetoothctl scan found {len(devices)} devices")

            except (FileNotFoundError, subprocess.SubprocessError) as e:
                logger.warning(f"bluetoothctl scan failed: {e}")

    return devices


def _scan_rf_signals(sdr_device: int | None, duration: int = 30) -> list[dict]:
    """
    Scan for RF signals using SDR (rtl_power).

    Scans common surveillance frequency bands:
    - 88-108 MHz: FM broadcast (potential FM bugs)
    - 315 MHz: Common ISM band (wireless devices)
    - 433 MHz: ISM band (European wireless devices, car keys)
    - 868 MHz: European ISM band
    - 915 MHz: US ISM band
    - 1.2 GHz: Video transmitters
    - 2.4 GHz: WiFi, Bluetooth, video transmitters
    """
    import os
    import shutil
    import subprocess
    import tempfile

    signals = []

    logger.info(f"Starting RF scan (device={sdr_device})")

    rtl_power_path = shutil.which('rtl_power')
    if not rtl_power_path:
        logger.warning("rtl_power not found in PATH, RF scanning unavailable")
        return signals

    logger.info(f"Found rtl_power at: {rtl_power_path}")

    # Define frequency bands to scan (in Hz) - focus on common bug frequencies
    # Format: (start_freq, end_freq, bin_size, description)
    scan_bands = [
        (88000000, 108000000, 100000, 'FM Broadcast'),       # FM bugs
        (315000000, 316000000, 10000, '315 MHz ISM'),        # US ISM
        (433000000, 434000000, 10000, '433 MHz ISM'),        # EU ISM
        (868000000, 869000000, 10000, '868 MHz ISM'),        # EU ISM
        (902000000, 928000000, 100000, '915 MHz ISM'),       # US ISM
        (1200000000, 1300000000, 100000, '1.2 GHz Video'),   # Video TX
        (2400000000, 2500000000, 500000, '2.4 GHz ISM'),     # WiFi/BT/Video
    ]

    # Create temp file for output
    with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False) as tmp:
        tmp_path = tmp.name

    try:
        # Build device argument
        device_arg = ['-d', str(sdr_device if sdr_device is not None else 0)]

        # Scan each band and look for strong signals
        for start_freq, end_freq, bin_size, band_name in scan_bands:
            if not _sweep_running:
                break

            logger.info(f"Scanning {band_name} ({start_freq/1e6:.1f}-{end_freq/1e6:.1f} MHz)")

            try:
                # Run rtl_power for a quick sweep of this band
                cmd = [
                    rtl_power_path,
                    '-f', f'{start_freq}:{end_freq}:{bin_size}',
                    '-g', '40',           # Gain
                    '-i', '1',            # Integration interval (1 second)
                    '-1',                 # Single shot mode
                    '-c', '20%',          # Crop 20% of edges
                ] + device_arg + [tmp_path]

                logger.debug(f"Running: {' '.join(cmd)}")

                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=30
                )

                if result.returncode != 0:
                    logger.warning(f"rtl_power returned {result.returncode}: {result.stderr}")

                # Parse the CSV output
                if os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 0:
                    with open(tmp_path, 'r') as f:
                        for line in f:
                            parts = line.strip().split(',')
                            if len(parts) >= 7:
                                try:
                                    # CSV format: date, time, hz_low, hz_high, hz_step, samples, db_values...
                                    hz_low = int(parts[2])
                                    hz_high = int(parts[3])
                                    hz_step = float(parts[4])
                                    db_values = [float(x) for x in parts[6:] if x.strip()]

                                    # Find peaks above noise floor (typically -60 dBm is strong)
                                    noise_floor = sum(db_values) / len(db_values) if db_values else -100
                                    threshold = noise_floor + 15  # Signal must be 15dB above noise

                                    for idx, db in enumerate(db_values):
                                        if db > threshold and db > -50:  # Strong signal
                                            freq_hz = hz_low + (idx * hz_step)
                                            freq_mhz = freq_hz / 1000000

                                            signals.append({
                                                'frequency': freq_mhz,
                                                'frequency_hz': freq_hz,
                                                'power': db,
                                                'band': band_name,
                                                'noise_floor': noise_floor,
                                                'signal_strength': db - noise_floor
                                            })
                                except (ValueError, IndexError):
                                    continue

                    # Clear file for next band
                    open(tmp_path, 'w').close()

            except subprocess.TimeoutExpired:
                logger.warning(f"RF scan timeout for band {band_name}")
            except Exception as e:
                logger.warning(f"RF scan error for band {band_name}: {e}")

    finally:
        # Cleanup temp file
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    # Deduplicate nearby frequencies (within 100kHz)
    if signals:
        signals.sort(key=lambda x: x['frequency'])
        deduped = [signals[0]]
        for sig in signals[1:]:
            if sig['frequency'] - deduped[-1]['frequency'] > 0.1:  # 100 kHz
                deduped.append(sig)
            elif sig['power'] > deduped[-1]['power']:
                deduped[-1] = sig  # Keep stronger signal
        signals = deduped

    logger.info(f"RF scan found {len(signals)} signals")
    return signals


def _run_sweep(
    sweep_type: str,
    baseline_id: int | None,
    wifi_enabled: bool,
    bt_enabled: bool,
    rf_enabled: bool,
    wifi_interface: str = '',
    bt_interface: str = '',
    sdr_device: int | None = None
) -> None:
    """
    Run the TSCM sweep in a background thread.

    This orchestrates data collection from WiFi, BT, and RF sources,
    then analyzes results for threats using the correlation engine.
    """
    global _sweep_running, _current_sweep_id

    try:
        # Get baseline for comparison if specified
        baseline = None
        if baseline_id:
            baseline = get_tscm_baseline(baseline_id)

        # Get sweep preset
        preset = get_sweep_preset(sweep_type) or SWEEP_PRESETS.get('standard')
        duration = preset.get('duration_seconds', 300)

        _emit_event('sweep_started', {
            'sweep_id': _current_sweep_id,
            'sweep_type': sweep_type,
            'duration': duration,
            'wifi': wifi_enabled,
            'bluetooth': bt_enabled,
            'rf': rf_enabled,
        })

        # Initialize detector and correlation engine
        detector = ThreatDetector(baseline)
        correlation = get_correlation_engine()
        # Clear old profiles from previous sweeps (keep 24h history)
        correlation.clear_old_profiles(24)

        # Collect and analyze data
        threats_found = 0
        severity_counts = {'critical': 0, 'high': 0, 'medium': 0, 'low': 0}
        all_wifi = {}  # Use dict for deduplication by BSSID
        all_bt = {}    # Use dict for deduplication by MAC
        all_rf = []

        start_time = time.time()
        last_wifi_scan = 0
        last_bt_scan = 0
        last_rf_scan = 0
        wifi_scan_interval = 15  # Scan WiFi every 15 seconds
        bt_scan_interval = 20   # Scan Bluetooth every 20 seconds
        rf_scan_interval = 60   # Scan RF every 60 seconds (it's slower)

        while _sweep_running and (time.time() - start_time) < duration:
            current_time = time.time()

            # Perform WiFi scan
            if wifi_enabled and (current_time - last_wifi_scan) >= wifi_scan_interval:
                try:
                    wifi_networks = _scan_wifi_networks(wifi_interface)
                    for network in wifi_networks:
                        bssid = network.get('bssid', '')
                        if bssid and bssid not in all_wifi:
                            all_wifi[bssid] = network
                            # Emit device event for frontend
                            is_threat = False
                            # Analyze for threats
                            threat = detector.analyze_wifi_device(network)
                            if threat:
                                _handle_threat(threat)
                                threats_found += 1
                                is_threat = True
                                sev = threat.get('severity', 'low').lower()
                                if sev in severity_counts:
                                    severity_counts[sev] += 1
                            # Classify device and get correlation profile
                            classification = detector.classify_wifi_device(network)
                            profile = correlation.analyze_wifi_device(network)
                            # Send device to frontend
                            _emit_event('wifi_device', {
                                'bssid': bssid,
                                'ssid': network.get('essid', 'Hidden'),
                                'channel': network.get('channel', ''),
                                'signal': network.get('power', ''),
                                'security': network.get('privacy', ''),
                                'is_threat': is_threat,
                                'is_new': not classification.get('in_baseline', False),
                                'classification': profile.risk_level.value,
                                'reasons': classification.get('reasons', []),
                                'score': profile.total_score,
                                'indicators': [{'type': i.type.value, 'desc': i.description} for i in profile.indicators],
                                'recommended_action': profile.recommended_action,
                            })
                    last_wifi_scan = current_time
                except Exception as e:
                    logger.error(f"WiFi scan error: {e}")

            # Perform Bluetooth scan
            if bt_enabled and (current_time - last_bt_scan) >= bt_scan_interval:
                try:
                    bt_devices = _scan_bluetooth_devices(bt_interface, duration=8)
                    for device in bt_devices:
                        mac = device.get('mac', '')
                        if mac and mac not in all_bt:
                            all_bt[mac] = device
                            is_threat = False
                            # Analyze for threats
                            threat = detector.analyze_bt_device(device)
                            if threat:
                                _handle_threat(threat)
                                threats_found += 1
                                is_threat = True
                                sev = threat.get('severity', 'low').lower()
                                if sev in severity_counts:
                                    severity_counts[sev] += 1
                            # Classify device and get correlation profile
                            classification = detector.classify_bt_device(device)
                            profile = correlation.analyze_bluetooth_device(device)
                            # Send device to frontend
                            _emit_event('bt_device', {
                                'mac': mac,
                                'name': device.get('name', 'Unknown'),
                                'type': device.get('type', ''),
                                'rssi': device.get('rssi', ''),
                                'is_threat': is_threat,
                                'is_new': not classification.get('in_baseline', False),
                                'classification': profile.risk_level.value,
                                'reasons': classification.get('reasons', []),
                                'is_audio_capable': classification.get('is_audio_capable', False),
                                'score': profile.total_score,
                                'indicators': [{'type': i.type.value, 'desc': i.description} for i in profile.indicators],
                                'recommended_action': profile.recommended_action,
                            })
                    last_bt_scan = current_time
                except Exception as e:
                    logger.error(f"Bluetooth scan error: {e}")

            # Perform RF scan using SDR
            if rf_enabled and sdr_device is not None and (current_time - last_rf_scan) >= rf_scan_interval:
                try:
                    _emit_event('sweep_progress', {
                        'progress': min(100, int(((current_time - start_time) / duration) * 100)),
                        'status': 'Scanning RF spectrum...',
                        'wifi_count': len(all_wifi),
                        'bt_count': len(all_bt),
                        'rf_count': len(all_rf),
                    })
                    rf_signals = _scan_rf_signals(sdr_device)
                    for signal in rf_signals:
                        freq_key = f"{signal['frequency']:.3f}"
                        if freq_key not in [f"{s['frequency']:.3f}" for s in all_rf]:
                            all_rf.append(signal)
                            is_threat = False
                            # Analyze RF signal for threats
                            threat = detector.analyze_rf_signal(signal)
                            if threat:
                                _handle_threat(threat)
                                threats_found += 1
                                is_threat = True
                                sev = threat.get('severity', 'low').lower()
                                if sev in severity_counts:
                                    severity_counts[sev] += 1
                            # Classify signal and get correlation profile
                            classification = detector.classify_rf_signal(signal)
                            profile = correlation.analyze_rf_signal(signal)
                            # Send signal to frontend
                            _emit_event('rf_signal', {
                                'frequency': signal['frequency'],
                                'power': signal['power'],
                                'band': signal['band'],
                                'signal_strength': signal.get('signal_strength', 0),
                                'is_threat': is_threat,
                                'is_new': not classification.get('in_baseline', False),
                                'classification': profile.risk_level.value,
                                'reasons': classification.get('reasons', []),
                                'score': profile.total_score,
                                'indicators': [{'type': i.type.value, 'desc': i.description} for i in profile.indicators],
                                'recommended_action': profile.recommended_action,
                            })
                    last_rf_scan = current_time
                except Exception as e:
                    logger.error(f"RF scan error: {e}")

            # Update progress
            elapsed = time.time() - start_time
            progress = min(100, int((elapsed / duration) * 100))

            _emit_event('sweep_progress', {
                'progress': progress,
                'elapsed': int(elapsed),
                'duration': duration,
                'wifi_count': len(all_wifi),
                'bt_count': len(all_bt),
                'rf_count': len(all_rf),
                'threats_found': threats_found,
                'severity_counts': severity_counts,
            })

            time.sleep(2)  # Update every 2 seconds

        # Complete sweep
        if _sweep_running and _current_sweep_id:
            # Run cross-protocol correlation analysis
            correlations = correlation.correlate_devices()
            findings = correlation.get_all_findings()

            update_tscm_sweep(
                _current_sweep_id,
                status='completed',
                results={
                    'wifi_devices': len(all_wifi),
                    'bt_devices': len(all_bt),
                    'rf_signals': len(all_rf),
                    'severity_counts': severity_counts,
                    'correlation_summary': findings.get('summary', {}),
                },
                threats_found=threats_found,
                completed=True
            )

            # Emit correlation findings
            _emit_event('correlation_findings', {
                'correlations': correlations,
                'high_interest_count': findings['summary'].get('high_interest', 0),
                'needs_review_count': findings['summary'].get('needs_review', 0),
            })

            _emit_event('sweep_completed', {
                'sweep_id': _current_sweep_id,
                'threats_found': threats_found,
                'wifi_count': len(all_wifi),
                'bt_count': len(all_bt),
                'rf_count': len(all_rf),
                'severity_counts': severity_counts,
                'high_interest_devices': findings['summary'].get('high_interest', 0),
                'needs_review_devices': findings['summary'].get('needs_review', 0),
                'correlations_found': len(correlations),
            })

    except Exception as e:
        logger.error(f"Sweep error: {e}")
        _emit_event('sweep_error', {'error': str(e)})
        if _current_sweep_id:
            update_tscm_sweep(_current_sweep_id, status='error', completed=True)

    finally:
        _sweep_running = False


def _handle_threat(threat: dict) -> None:
    """Handle a detected threat."""
    if not _current_sweep_id:
        return

    # Add to database
    threat_id = add_tscm_threat(
        sweep_id=_current_sweep_id,
        threat_type=threat['threat_type'],
        severity=threat['severity'],
        source=threat['source'],
        identifier=threat['identifier'],
        name=threat.get('name'),
        signal_strength=threat.get('signal_strength'),
        frequency=threat.get('frequency'),
        details=threat.get('details')
    )

    # Emit event
    _emit_event('threat_detected', {
        'threat_id': threat_id,
        **threat
    })

    logger.warning(
        f"TSCM threat detected: {threat['threat_type']} - "
        f"{threat['identifier']} ({threat['severity']})"
    )


# =============================================================================
# Baseline Endpoints
# =============================================================================

@tscm_bp.route('/baseline/record', methods=['POST'])
def record_baseline():
    """Start recording a new baseline."""
    data = request.get_json() or {}
    name = data.get('name', f'Baseline {datetime.now().strftime("%Y-%m-%d %H:%M")}')
    location = data.get('location')
    description = data.get('description')

    baseline_id = _baseline_recorder.start_recording(name, location, description)

    return jsonify({
        'status': 'success',
        'message': 'Baseline recording started',
        'baseline_id': baseline_id
    })


@tscm_bp.route('/baseline/stop', methods=['POST'])
def stop_baseline():
    """Stop baseline recording."""
    result = _baseline_recorder.stop_recording()

    if 'error' in result:
        return jsonify({'status': 'error', 'message': result['error']})

    return jsonify({
        'status': 'success',
        'message': 'Baseline recording complete',
        **result
    })


@tscm_bp.route('/baseline/status')
def baseline_status():
    """Get baseline recording status."""
    return jsonify(_baseline_recorder.get_recording_status())


@tscm_bp.route('/baselines')
def list_baselines():
    """List all baselines."""
    baselines = get_all_tscm_baselines()
    return jsonify({'status': 'success', 'baselines': baselines})


@tscm_bp.route('/baseline/<int:baseline_id>')
def get_baseline(baseline_id: int):
    """Get a specific baseline."""
    baseline = get_tscm_baseline(baseline_id)
    if not baseline:
        return jsonify({'status': 'error', 'message': 'Baseline not found'}), 404

    return jsonify({'status': 'success', 'baseline': baseline})


@tscm_bp.route('/baseline/<int:baseline_id>/activate', methods=['POST'])
def activate_baseline(baseline_id: int):
    """Set a baseline as active."""
    success = set_active_tscm_baseline(baseline_id)
    if not success:
        return jsonify({'status': 'error', 'message': 'Baseline not found'}), 404

    return jsonify({'status': 'success', 'message': 'Baseline activated'})


@tscm_bp.route('/baseline/<int:baseline_id>', methods=['DELETE'])
def remove_baseline(baseline_id: int):
    """Delete a baseline."""
    success = delete_tscm_baseline(baseline_id)
    if not success:
        return jsonify({'status': 'error', 'message': 'Baseline not found'}), 404

    return jsonify({'status': 'success', 'message': 'Baseline deleted'})


@tscm_bp.route('/baseline/active')
def get_active_baseline():
    """Get the currently active baseline."""
    baseline = get_active_tscm_baseline()
    if not baseline:
        return jsonify({'status': 'success', 'baseline': None})

    return jsonify({'status': 'success', 'baseline': baseline})


# =============================================================================
# Threat Endpoints
# =============================================================================

@tscm_bp.route('/threats')
def list_threats():
    """List threats with optional filters."""
    sweep_id = request.args.get('sweep_id', type=int)
    severity = request.args.get('severity')
    acknowledged = request.args.get('acknowledged')
    limit = request.args.get('limit', 100, type=int)

    ack_filter = None
    if acknowledged is not None:
        ack_filter = acknowledged.lower() in ('true', '1', 'yes')

    threats = get_tscm_threats(
        sweep_id=sweep_id,
        severity=severity,
        acknowledged=ack_filter,
        limit=limit
    )

    return jsonify({'status': 'success', 'threats': threats})


@tscm_bp.route('/threats/summary')
def threat_summary():
    """Get threat count summary by severity."""
    summary = get_tscm_threat_summary()
    return jsonify({'status': 'success', 'summary': summary})


@tscm_bp.route('/threats/<int:threat_id>', methods=['PUT'])
def update_threat(threat_id: int):
    """Update a threat (acknowledge, add notes)."""
    data = request.get_json() or {}

    if data.get('acknowledge'):
        notes = data.get('notes')
        success = acknowledge_tscm_threat(threat_id, notes)
        if not success:
            return jsonify({'status': 'error', 'message': 'Threat not found'}), 404

    return jsonify({'status': 'success', 'message': 'Threat updated'})


# =============================================================================
# Preset Endpoints
# =============================================================================

@tscm_bp.route('/presets')
def list_presets():
    """List available sweep presets."""
    presets = get_all_sweep_presets()
    return jsonify({'status': 'success', 'presets': presets})


@tscm_bp.route('/presets/<preset_name>')
def get_preset(preset_name: str):
    """Get details for a specific preset."""
    preset = get_sweep_preset(preset_name)
    if not preset:
        return jsonify({'status': 'error', 'message': 'Preset not found'}), 404

    return jsonify({'status': 'success', 'preset': preset})


# =============================================================================
# Data Feed Endpoints (for adding data during sweeps/baselines)
# =============================================================================

@tscm_bp.route('/feed/wifi', methods=['POST'])
def feed_wifi():
    """Feed WiFi device data for baseline recording."""
    data = request.get_json()
    if data:
        _baseline_recorder.add_wifi_device(data)
    return jsonify({'status': 'success'})


@tscm_bp.route('/feed/bluetooth', methods=['POST'])
def feed_bluetooth():
    """Feed Bluetooth device data for baseline recording."""
    data = request.get_json()
    if data:
        _baseline_recorder.add_bt_device(data)
    return jsonify({'status': 'success'})


@tscm_bp.route('/feed/rf', methods=['POST'])
def feed_rf():
    """Feed RF signal data for baseline recording."""
    data = request.get_json()
    if data:
        _baseline_recorder.add_rf_signal(data)
    return jsonify({'status': 'success'})


# =============================================================================
# Correlation & Findings Endpoints
# =============================================================================

@tscm_bp.route('/findings')
def get_findings():
    """
    Get comprehensive TSCM findings from the correlation engine.

    Returns all device profiles organized by risk level, cross-protocol
    correlations, and summary statistics with client-safe disclaimers.
    """
    correlation = get_correlation_engine()
    findings = correlation.get_all_findings()

    # Add client-safe disclaimer
    findings['legal_disclaimer'] = (
        "DISCLAIMER: This TSCM screening system identifies wireless and RF anomalies "
        "and indicators. Results represent potential items of interest, NOT confirmed "
        "surveillance devices. No content has been intercepted or decoded. Findings "
        "require professional analysis and verification. This tool does not prove "
        "malicious intent or illegal activity."
    )

    return jsonify({
        'status': 'success',
        'findings': findings
    })


@tscm_bp.route('/findings/high-interest')
def get_high_interest():
    """Get only high-interest devices (score >= 6)."""
    correlation = get_correlation_engine()
    high_interest = correlation.get_high_interest_devices()

    return jsonify({
        'status': 'success',
        'count': len(high_interest),
        'devices': [d.to_dict() for d in high_interest],
        'disclaimer': (
            "High-interest classification indicates multiple indicators warrant "
            "investigation. This does NOT confirm surveillance activity."
        )
    })


@tscm_bp.route('/findings/correlations')
def get_correlations():
    """Get cross-protocol correlation analysis."""
    correlation = get_correlation_engine()
    correlations = correlation.correlate_devices()

    return jsonify({
        'status': 'success',
        'count': len(correlations),
        'correlations': correlations,
        'explanation': (
            "Correlations identify devices across different protocols (Bluetooth, "
            "WiFi, RF) that exhibit related behavior patterns. Cross-protocol "
            "activity is one indicator among many in TSCM analysis."
        )
    })


@tscm_bp.route('/findings/device/<identifier>')
def get_device_profile(identifier: str):
    """Get detailed profile for a specific device."""
    correlation = get_correlation_engine()

    # Search all protocols for the identifier
    for protocol in ['bluetooth', 'wifi', 'rf']:
        key = f"{protocol}:{identifier}"
        if key in correlation.device_profiles:
            profile = correlation.device_profiles[key]
            return jsonify({
                'status': 'success',
                'profile': profile.to_dict()
            })

    return jsonify({
        'status': 'error',
        'message': 'Device not found'
    }), 404


# =============================================================================
# Meeting Window Endpoints (for time correlation)
# =============================================================================

@tscm_bp.route('/meeting/start', methods=['POST'])
def start_meeting():
    """
    Mark the start of a sensitive period (meeting, briefing, etc.).

    Devices detected during this window will receive additional scoring
    for meeting-correlated activity.
    """
    correlation = get_correlation_engine()
    correlation.start_meeting_window()

    _emit_event('meeting_started', {
        'timestamp': datetime.now().isoformat(),
        'message': 'Sensitive period monitoring active'
    })

    return jsonify({
        'status': 'success',
        'message': 'Meeting window started - devices detected now will be flagged'
    })


@tscm_bp.route('/meeting/end', methods=['POST'])
def end_meeting():
    """Mark the end of a sensitive period."""
    correlation = get_correlation_engine()
    correlation.end_meeting_window()

    _emit_event('meeting_ended', {
        'timestamp': datetime.now().isoformat()
    })

    return jsonify({
        'status': 'success',
        'message': 'Meeting window ended'
    })


@tscm_bp.route('/meeting/status')
def meeting_status():
    """Check if currently in a meeting window."""
    correlation = get_correlation_engine()
    in_meeting = correlation.is_during_meeting()

    return jsonify({
        'status': 'success',
        'in_meeting': in_meeting,
        'windows': [
            {
                'start': start.isoformat(),
                'end': end.isoformat() if end else None
            }
            for start, end in correlation.meeting_windows
        ]
    })


# =============================================================================
# Report Generation Endpoints
# =============================================================================

@tscm_bp.route('/report')
def generate_report():
    """
    Generate a comprehensive TSCM sweep report.

    Includes all findings, correlations, indicators, and recommended actions
    in a client-presentable format with appropriate disclaimers.
    """
    correlation = get_correlation_engine()
    findings = correlation.get_all_findings()

    # Build the report structure
    report = {
        'generated_at': datetime.now().isoformat(),
        'report_type': 'TSCM Wireless Surveillance Screening',

        'executive_summary': {
            'total_devices_analyzed': findings['summary']['total_devices'],
            'high_interest_items': findings['summary']['high_interest'],
            'items_requiring_review': findings['summary']['needs_review'],
            'cross_protocol_correlations': findings['summary']['correlations_found'],
            'assessment': _generate_assessment(findings['summary']),
        },

        'methodology': {
            'protocols_scanned': ['Bluetooth Low Energy', 'WiFi 802.11', 'RF Spectrum'],
            'analysis_techniques': [
                'Device fingerprinting',
                'Signal stability analysis',
                'Cross-protocol correlation',
                'Time-based pattern detection',
                'Manufacturer identification',
            ],
            'scoring_model': {
                'informational': '0-2 points - Known or expected devices',
                'needs_review': '3-5 points - Unusual devices requiring assessment',
                'high_interest': '6+ points - Multiple indicators warrant investigation',
            }
        },

        'findings': {
            'high_interest': findings['devices']['high_interest'],
            'needs_review': findings['devices']['needs_review'],
            'informational': findings['devices']['informational'],
        },

        'correlations': findings['correlations'],

        'disclaimers': {
            'legal': (
                "This report documents findings from a wireless and RF surveillance "
                "screening. Results indicate anomalies and items of interest, NOT "
                "confirmed surveillance devices. No communications content has been "
                "intercepted, recorded, or decoded. This screening does not prove "
                "malicious intent, illegal activity, or the presence of surveillance "
                "equipment. All findings require professional verification."
            ),
            'technical': (
                "Detection capabilities are limited by equipment sensitivity, "
                "environmental factors, and the technical sophistication of any "
                "potential devices. Absence of findings does NOT guarantee absence "
                "of surveillance equipment."
            ),
            'recommendations': (
                "High-interest items should be investigated by qualified TSCM "
                "professionals using appropriate physical inspection techniques. "
                "This electronic sweep is one component of comprehensive TSCM."
            )
        }
    }

    return jsonify({
        'status': 'success',
        'report': report
    })


def _generate_assessment(summary: dict) -> str:
    """Generate an assessment summary based on findings."""
    high = summary.get('high_interest', 0)
    review = summary.get('needs_review', 0)
    correlations = summary.get('correlations_found', 0)

    if high > 0 or correlations > 0:
        return (
            f"ELEVATED CONCERN: {high} high-interest item(s) and "
            f"{correlations} cross-protocol correlation(s) detected. "
            "Professional TSCM inspection recommended."
        )
    elif review > 3:
        return (
            f"MODERATE CONCERN: {review} items requiring review. "
            "Further analysis recommended to characterize unknown devices."
        )
    elif review > 0:
        return (
            f"LOW CONCERN: {review} item(s) flagged for review. "
            "Likely benign but verification recommended."
        )
    else:
        return (
            "BASELINE ENVIRONMENT: No significant anomalies detected. "
            "Environment appears consistent with expected wireless activity."
        )
