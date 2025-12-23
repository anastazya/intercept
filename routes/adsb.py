"""ADS-B aircraft tracking routes."""

from __future__ import annotations

import json
import queue
import shutil
import socket
import subprocess
import threading
import time
from typing import Any, Generator

from flask import Blueprint, jsonify, request, Response, render_template

import app as app_module
from utils.logging import adsb_logger as logger

adsb_bp = Blueprint('adsb', __name__, url_prefix='/adsb')

# Track if using service
adsb_using_service = False


def check_dump1090_service():
    """Check if dump1090 SBS port (30003) is available."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(2)
        result = sock.connect_ex(('localhost', 30003))
        sock.close()
        if result == 0:
            return 'localhost:30003'
    except Exception:
        pass
    return None


def parse_sbs_stream(service_addr):
    """Parse SBS format data from dump1090 port 30003."""
    global adsb_using_service

    host, port = service_addr.split(':')
    port = int(port)

    logger.info(f"SBS stream parser started, connecting to {host}:{port}")

    while adsb_using_service:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(5)
            sock.connect((host, port))
            logger.info("Connected to SBS stream")

            buffer = ""
            last_update = time.time()
            pending_updates = set()

            while adsb_using_service:
                try:
                    data = sock.recv(4096).decode('utf-8', errors='ignore')
                    if not data:
                        break
                    buffer += data

                    while '\n' in buffer:
                        line, buffer = buffer.split('\n', 1)
                        line = line.strip()
                        if not line:
                            continue

                        parts = line.split(',')
                        if len(parts) < 11 or parts[0] != 'MSG':
                            continue

                        msg_type = parts[1]
                        icao = parts[4].upper()
                        if not icao:
                            continue

                        aircraft = app_module.adsb_aircraft.get(icao, {'icao': icao})

                        if msg_type == '1' and len(parts) > 10:
                            callsign = parts[10].strip()
                            if callsign:
                                aircraft['callsign'] = callsign

                        elif msg_type == '3' and len(parts) > 15:
                            if parts[11]:
                                try:
                                    aircraft['alt'] = int(float(parts[11]))
                                except (ValueError, TypeError):
                                    pass
                            if parts[14] and parts[15]:
                                try:
                                    aircraft['lat'] = float(parts[14])
                                    aircraft['lon'] = float(parts[15])
                                except (ValueError, TypeError):
                                    pass

                        elif msg_type == '4' and len(parts) > 13:
                            if parts[12]:
                                try:
                                    aircraft['speed'] = int(float(parts[12]))
                                except (ValueError, TypeError):
                                    pass
                            if parts[13]:
                                try:
                                    aircraft['heading'] = int(float(parts[13]))
                                except (ValueError, TypeError):
                                    pass

                        elif msg_type == '5' and len(parts) > 11:
                            if parts[10]:
                                callsign = parts[10].strip()
                                if callsign:
                                    aircraft['callsign'] = callsign
                            if parts[11]:
                                try:
                                    aircraft['alt'] = int(float(parts[11]))
                                except (ValueError, TypeError):
                                    pass

                        elif msg_type == '6' and len(parts) > 17:
                            if parts[17]:
                                aircraft['squawk'] = parts[17]

                        app_module.adsb_aircraft[icao] = aircraft
                        pending_updates.add(icao)

                        now = time.time()
                        if now - last_update >= 1.0:
                            for update_icao in pending_updates:
                                if update_icao in app_module.adsb_aircraft:
                                    app_module.adsb_queue.put({
                                        'type': 'aircraft',
                                        **app_module.adsb_aircraft[update_icao]
                                    })
                            pending_updates.clear()
                            last_update = now

                except socket.timeout:
                    continue

            sock.close()
        except Exception as e:
            logger.warning(f"SBS connection error: {e}, reconnecting...")
            time.sleep(2)

    logger.info("SBS stream parser stopped")


@adsb_bp.route('/tools')
def check_adsb_tools():
    """Check for ADS-B decoding tools."""
    return jsonify({
        'dump1090': shutil.which('dump1090') is not None or shutil.which('dump1090-mutability') is not None or shutil.which('dump1090-fa') is not None,
        'rtl_adsb': shutil.which('rtl_adsb') is not None
    })


@adsb_bp.route('/start', methods=['POST'])
def start_adsb():
    """Start ADS-B tracking."""
    global adsb_using_service

    with app_module.adsb_lock:
        if app_module.adsb_process and app_module.adsb_process.poll() is None:
            return jsonify({'status': 'already_running', 'message': 'ADS-B already running'})
        if adsb_using_service:
            return jsonify({'status': 'already_running', 'message': 'ADS-B already running (using service)'})

    data = request.json or {}
    gain = data.get('gain', '40')
    device = data.get('device', '0')

    dump1090_path = shutil.which('dump1090') or shutil.which('dump1090-mutability') or shutil.which('dump1090-fa')

    if not dump1090_path:
        return jsonify({'status': 'error', 'message': 'dump1090 not found.'})

    cmd = [dump1090_path, '--net', '--gain', gain, '--device-index', str(device), '--quiet']

    try:
        app_module.adsb_process = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )

        time.sleep(3)

        if app_module.adsb_process.poll() is not None:
            return jsonify({'status': 'error', 'message': 'dump1090 failed to start.'})

        adsb_using_service = True
        thread = threading.Thread(target=parse_sbs_stream, args=('localhost:30003',), daemon=True)
        thread.start()

        return jsonify({'status': 'success', 'message': 'ADS-B tracking started'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)})


@adsb_bp.route('/stop', methods=['POST'])
def stop_adsb():
    """Stop ADS-B tracking."""
    global adsb_using_service

    with app_module.adsb_lock:
        if app_module.adsb_process:
            app_module.adsb_process.terminate()
            try:
                app_module.adsb_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                app_module.adsb_process.kill()
            app_module.adsb_process = None
        adsb_using_service = False

    app_module.adsb_aircraft = {}
    return jsonify({'status': 'stopped'})


@adsb_bp.route('/stream')
def stream_adsb():
    """SSE stream for ADS-B aircraft."""
    def generate():
        while True:
            try:
                msg = app_module.adsb_queue.get(timeout=1)
                yield f"data: {json.dumps(msg)}\n\n"
            except queue.Empty:
                yield f"data: {json.dumps({'type': 'keepalive'})}\n\n"

    response = Response(generate(), mimetype='text/event-stream')
    response.headers['Cache-Control'] = 'no-cache'
    response.headers['X-Accel-Buffering'] = 'no'
    return response


@adsb_bp.route('/dashboard')
def adsb_dashboard():
    """Popout ADS-B dashboard."""
    return render_template('adsb_dashboard.html')
