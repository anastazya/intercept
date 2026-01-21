/**
 * Bluetooth Mode Controller
 * Uses the new unified Bluetooth API at /api/bluetooth/
 */

const BluetoothMode = (function() {
    'use strict';

    // State
    let isScanning = false;
    let eventSource = null;
    let devices = new Map();
    let baselineSet = false;
    let baselineCount = 0;

    // DOM elements (cached)
    let startBtn, stopBtn, messageContainer, deviceContainer;
    let adapterSelect, scanModeSelect, transportSelect, durationInput, minRssiInput;
    let baselineStatusEl, capabilityStatusEl;

    // Stats tracking
    let deviceStats = {
        strong: 0,
        medium: 0,
        weak: 0,
        trackers: []
    };

    // Zone counts for proximity display
    let zoneCounts = { veryClose: 0, close: 0, nearby: 0, far: 0 };

    // New visualization components
    let radarInitialized = false;
    let radarPaused = false;

    // Device list filter
    let currentDeviceFilter = 'all';

    /**
     * Initialize the Bluetooth mode
     */
    function init() {
        console.log('[BT] Initializing BluetoothMode');

        // Cache DOM elements
        startBtn = document.getElementById('startBtBtn');
        stopBtn = document.getElementById('stopBtBtn');
        messageContainer = document.getElementById('btMessageContainer');
        deviceContainer = document.getElementById('btDeviceListContent');
        adapterSelect = document.getElementById('btAdapterSelect');
        scanModeSelect = document.getElementById('btScanMode');
        transportSelect = document.getElementById('btTransport');
        durationInput = document.getElementById('btScanDuration');
        minRssiInput = document.getElementById('btMinRssi');
        baselineStatusEl = document.getElementById('btBaselineStatus');
        capabilityStatusEl = document.getElementById('btCapabilityStatus');

        // Check capabilities on load
        checkCapabilities();

        // Check scan status (in case page was reloaded during scan)
        checkScanStatus();

        // Initialize proximity visualization
        initProximityRadar();

        // Initialize legacy heatmap (zone counts)
        initHeatmap();

        // Initialize device list filters
        initDeviceFilters();

        // Set initial panel states
        updateVisualizationPanels();
    }

    /**
     * Initialize device list filter buttons
     */
    function initDeviceFilters() {
        const filterContainer = document.getElementById('btDeviceFilters');
        if (!filterContainer) return;

        filterContainer.addEventListener('click', (e) => {
            const btn = e.target.closest('.bt-filter-btn');
            if (!btn) return;

            const filter = btn.dataset.filter;
            if (!filter) return;

            // Update active state
            filterContainer.querySelectorAll('.bt-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Apply filter
            currentDeviceFilter = filter;
            applyDeviceFilter();
        });
    }

    /**
     * Apply current filter to device list
     */
    function applyDeviceFilter() {
        if (!deviceContainer) return;

        const cards = deviceContainer.querySelectorAll('[data-bt-device-id]');
        cards.forEach(card => {
            const isNew = card.dataset.isNew === 'true';
            const hasName = card.dataset.hasName === 'true';
            const rssi = parseInt(card.dataset.rssi) || -100;

            let visible = true;
            switch (currentDeviceFilter) {
                case 'new':
                    visible = isNew;
                    break;
                case 'named':
                    visible = hasName;
                    break;
                case 'strong':
                    visible = rssi >= -70;
                    break;
                case 'all':
                default:
                    visible = true;
            }

            card.style.display = visible ? '' : 'none';
        });

        // Update visible count
        updateFilteredCount();
    }

    /**
     * Update the device count display based on visible devices
     */
    function updateFilteredCount() {
        const countEl = document.getElementById('btDeviceListCount');
        if (!countEl || !deviceContainer) return;

        if (currentDeviceFilter === 'all') {
            countEl.textContent = devices.size;
        } else {
            const visible = deviceContainer.querySelectorAll('[data-bt-device-id]:not([style*="display: none"])').length;
            countEl.textContent = visible + '/' + devices.size;
        }
    }

    /**
     * Initialize the new proximity radar component
     */
    function initProximityRadar() {
        const radarContainer = document.getElementById('btProximityRadar');
        if (!radarContainer) return;

        if (typeof ProximityRadar !== 'undefined') {
            ProximityRadar.init('btProximityRadar', {
                onDeviceClick: (deviceKey) => {
                    // Find device by key and show modal
                    const device = Array.from(devices.values()).find(d => d.device_key === deviceKey);
                    if (device) {
                        selectDevice(device.device_id);
                    }
                }
            });
            radarInitialized = true;

            // Setup radar controls
            setupRadarControls();
        }
    }

    /**
     * Setup radar control button handlers
     */
    function setupRadarControls() {
        // Filter buttons
        document.querySelectorAll('#btRadarControls button[data-filter]').forEach(btn => {
            btn.addEventListener('click', () => {
                const filter = btn.getAttribute('data-filter');
                if (typeof ProximityRadar !== 'undefined') {
                    ProximityRadar.setFilter(filter);

                    // Update button states
                    document.querySelectorAll('#btRadarControls button[data-filter]').forEach(b => {
                        b.classList.remove('active');
                    });
                    if (ProximityRadar.getFilter() === filter) {
                        btn.classList.add('active');
                    }
                }
            });
        });

        // Pause button
        const pauseBtn = document.getElementById('btRadarPauseBtn');
        if (pauseBtn) {
            pauseBtn.addEventListener('click', () => {
                radarPaused = !radarPaused;
                if (typeof ProximityRadar !== 'undefined') {
                    ProximityRadar.setPaused(radarPaused);
                }
                pauseBtn.textContent = radarPaused ? 'Resume' : 'Pause';
                pauseBtn.classList.toggle('active', radarPaused);
            });
        }
    }

    /**
     * Update the proximity radar with current devices
     */
    function updateRadar() {
        if (!radarInitialized || typeof ProximityRadar === 'undefined') return;

        // Convert devices map to array for radar
        const deviceList = Array.from(devices.values()).map(d => ({
            device_key: d.device_key || d.device_id,
            device_id: d.device_id,
            name: d.name,
            address: d.address,
            rssi_current: d.rssi_current,
            rssi_ema: d.rssi_ema,
            estimated_distance_m: d.estimated_distance_m,
            proximity_band: d.proximity_band || 'unknown',
            distance_confidence: d.distance_confidence || 0.5,
            is_new: d.is_new || !d.in_baseline,
            is_randomized_mac: d.is_randomized_mac,
            in_baseline: d.in_baseline,
            heuristic_flags: d.heuristic_flags || [],
            age_seconds: d.age_seconds || 0,
        }));

        ProximityRadar.updateDevices(deviceList);

        // Update zone counts from radar
        const counts = ProximityRadar.getZoneCounts();
        updateProximityZoneCounts(counts);
    }

    /**
     * Update proximity zone counts display (new system)
     */
    function updateProximityZoneCounts(counts) {
        const immediateEl = document.getElementById('btZoneImmediate');
        const nearEl = document.getElementById('btZoneNear');
        const farEl = document.getElementById('btZoneFar');

        if (immediateEl) immediateEl.textContent = counts.immediate || 0;
        if (nearEl) nearEl.textContent = counts.near || 0;
        if (farEl) farEl.textContent = counts.far || 0;
    }

    /**
     * Initialize proximity zones display
     */
    function initHeatmap() {
        updateProximityZones();
    }

    /**
     * Update proximity zone counts (simple HTML, no canvas)
     */
    function updateProximityZones() {
        zoneCounts = { veryClose: 0, close: 0, nearby: 0, far: 0 };

        devices.forEach(device => {
            const rssi = device.rssi_current;
            if (rssi == null) return;

            if (rssi >= -40) zoneCounts.veryClose++;
            else if (rssi >= -55) zoneCounts.close++;
            else if (rssi >= -70) zoneCounts.nearby++;
            else zoneCounts.far++;
        });

        // Update DOM elements
        const veryCloseEl = document.getElementById('btZoneVeryClose');
        const closeEl = document.getElementById('btZoneClose');
        const nearbyEl = document.getElementById('btZoneNearby');
        const farEl = document.getElementById('btZoneFar');

        if (veryCloseEl) veryCloseEl.textContent = zoneCounts.veryClose;
        if (closeEl) closeEl.textContent = zoneCounts.close;
        if (nearbyEl) nearbyEl.textContent = zoneCounts.nearby;
        if (farEl) farEl.textContent = zoneCounts.far;
    }

    // Currently selected device
    let selectedDeviceId = null;

    /**
     * Show device detail panel
     */
    function showDeviceDetail(deviceId) {
        const device = devices.get(deviceId);
        if (!device) return;

        selectedDeviceId = deviceId;

        const placeholder = document.getElementById('btDetailPlaceholder');
        const content = document.getElementById('btDetailContent');
        if (!placeholder || !content) return;

        const rssi = device.rssi_current;
        const rssiColor = getRssiColor(rssi);
        const flags = device.heuristic_flags || [];
        const protocol = device.protocol || 'ble';

        // Update panel elements
        document.getElementById('btDetailName').textContent = device.name || formatDeviceId(device.address);
        document.getElementById('btDetailAddress').textContent = device.address;

        // RSSI
        const rssiEl = document.getElementById('btDetailRssi');
        rssiEl.textContent = rssi != null ? rssi : '--';
        rssiEl.style.color = rssiColor;

        // Badges
        const badgesEl = document.getElementById('btDetailBadges');
        let badgesHtml = `<span class="bt-detail-badge ${protocol}">${protocol.toUpperCase()}</span>`;
        badgesHtml += `<span class="bt-detail-badge ${device.in_baseline ? 'baseline' : 'new'}">${device.in_baseline ? '✓ KNOWN' : '● NEW'}</span>`;
        flags.forEach(f => {
            badgesHtml += `<span class="bt-detail-badge flag">${f.replace(/_/g, ' ').toUpperCase()}</span>`;
        });
        badgesEl.innerHTML = badgesHtml;

        // Stats grid
        document.getElementById('btDetailMfr').textContent = device.manufacturer_name || '--';
        document.getElementById('btDetailMfrId').textContent = device.manufacturer_id != null
            ? '0x' + device.manufacturer_id.toString(16).toUpperCase().padStart(4, '0')
            : '--';
        document.getElementById('btDetailAddrType').textContent = device.address_type || '--';
        document.getElementById('btDetailSeen').textContent = (device.seen_count || 0) + '×';
        document.getElementById('btDetailRange').textContent = device.range_band || '--';

        // Min/Max combined
        const minMax = [];
        if (device.rssi_min != null) minMax.push(device.rssi_min);
        if (device.rssi_max != null) minMax.push(device.rssi_max);
        document.getElementById('btDetailRssiRange').textContent = minMax.length === 2
            ? minMax[0] + '/' + minMax[1]
            : '--';

        document.getElementById('btDetailFirstSeen').textContent = device.first_seen
            ? new Date(device.first_seen).toLocaleTimeString()
            : '--';
        document.getElementById('btDetailLastSeen').textContent = device.last_seen
            ? new Date(device.last_seen).toLocaleTimeString()
            : '--';

        // Services
        const servicesContainer = document.getElementById('btDetailServices');
        const servicesList = document.getElementById('btDetailServicesList');
        if (device.service_uuids && device.service_uuids.length > 0) {
            servicesContainer.style.display = 'block';
            servicesList.textContent = device.service_uuids.join(', ');
        } else {
            servicesContainer.style.display = 'none';
        }

        // Show content, hide placeholder
        placeholder.style.display = 'none';
        content.style.display = 'block';

        // Highlight selected device in list
        highlightSelectedDevice(deviceId);
    }

    /**
     * Clear device selection
     */
    function clearSelection() {
        selectedDeviceId = null;

        const placeholder = document.getElementById('btDetailPlaceholder');
        const content = document.getElementById('btDetailContent');
        if (placeholder) placeholder.style.display = 'flex';
        if (content) content.style.display = 'none';

        // Remove highlight from device list
        if (deviceContainer) {
            deviceContainer.querySelectorAll('.bt-device-row.selected').forEach(el => {
                el.classList.remove('selected');
            });
        }
    }

    /**
     * Highlight selected device in the list
     */
    function highlightSelectedDevice(deviceId) {
        if (!deviceContainer) return;

        // Remove existing highlights
        deviceContainer.querySelectorAll('.bt-device-row.selected').forEach(el => {
            el.classList.remove('selected');
        });

        // Add highlight to selected device
        const escapedId = CSS.escape(deviceId);
        const card = deviceContainer.querySelector(`[data-bt-device-id="${escapedId}"]`);
        if (card) {
            card.classList.add('selected');
        }
    }

    /**
     * Copy selected device address to clipboard
     */
    function copyAddress() {
        if (!selectedDeviceId) return;
        const device = devices.get(selectedDeviceId);
        if (!device) return;

        navigator.clipboard.writeText(device.address).then(() => {
            const btn = document.querySelector('.bt-detail-btn');
            if (btn) {
                const originalText = btn.textContent;
                btn.textContent = 'Copied!';
                btn.style.background = '#22c55e';
                setTimeout(() => {
                    btn.textContent = originalText;
                    btn.style.background = '';
                }, 1500);
            }
        });
    }

    /**
     * Select a device - opens modal with details
     */
    function selectDevice(deviceId) {
        showDeviceDetail(deviceId);
    }

    /**
     * Format device ID for display (when no name available)
     */
    function formatDeviceId(address) {
        if (!address) return 'Unknown Device';
        const parts = address.split(':');
        if (parts.length === 6) {
            return parts[0] + ':' + parts[1] + ':...:' + parts[4] + ':' + parts[5];
        }
        return address;
    }

    /**
     * Check system capabilities
     */
    async function checkCapabilities() {
        try {
            const response = await fetch('/api/bluetooth/capabilities');
            const data = await response.json();

            if (!data.available) {
                showCapabilityWarning(['Bluetooth not available on this system']);
                return;
            }

            if (adapterSelect && data.adapters && data.adapters.length > 0) {
                adapterSelect.innerHTML = data.adapters.map(a => {
                    const status = a.powered ? 'UP' : 'DOWN';
                    return `<option value="${a.id}">${a.id} - ${a.name || 'Bluetooth Adapter'} [${status}]</option>`;
                }).join('');
            } else if (adapterSelect) {
                adapterSelect.innerHTML = '<option value="">No adapters found</option>';
            }

            if (data.issues && data.issues.length > 0) {
                showCapabilityWarning(data.issues);
            } else {
                hideCapabilityWarning();
            }

            if (scanModeSelect && data.preferred_backend) {
                const option = scanModeSelect.querySelector(`option[value="${data.preferred_backend}"]`);
                if (option) option.selected = true;
            }

        } catch (err) {
            console.error('Failed to check capabilities:', err);
            showCapabilityWarning(['Failed to check Bluetooth capabilities']);
        }
    }

    function showCapabilityWarning(issues) {
        if (!capabilityStatusEl) return;
        capabilityStatusEl.style.display = 'block';
        capabilityStatusEl.innerHTML = `
            <div style="color: #f59e0b; padding: 10px; background: rgba(245,158,11,0.1); border-radius: 6px; font-size: 12px;">
                ${issues.map(i => `<div>⚠ ${i}</div>`).join('')}
            </div>
        `;
    }

    function hideCapabilityWarning() {
        if (capabilityStatusEl) {
            capabilityStatusEl.style.display = 'none';
            capabilityStatusEl.innerHTML = '';
        }
    }

    async function checkScanStatus() {
        try {
            const response = await fetch('/api/bluetooth/scan/status');
            const data = await response.json();

            if (data.is_scanning) {
                setScanning(true);
                startEventStream();
            }

            if (data.baseline_count > 0) {
                baselineSet = true;
                baselineCount = data.baseline_count;
                updateBaselineStatus();
            }

        } catch (err) {
            console.error('Failed to check scan status:', err);
        }
    }

    async function startScan() {
        const adapter = adapterSelect?.value || '';
        const mode = scanModeSelect?.value || 'auto';
        const transport = transportSelect?.value || 'auto';
        const duration = parseInt(durationInput?.value || '0', 10);
        const minRssi = parseInt(minRssiInput?.value || '-100', 10);

        try {
            const response = await fetch('/api/bluetooth/scan/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: mode,
                    adapter_id: adapter || undefined,
                    duration_s: duration > 0 ? duration : undefined,
                    transport: transport,
                    rssi_threshold: minRssi
                })
            });

            const data = await response.json();

            if (data.status === 'started' || data.status === 'already_scanning') {
                setScanning(true);
                startEventStream();
            } else {
                showErrorMessage(data.message || 'Failed to start scan');
            }

        } catch (err) {
            console.error('Failed to start scan:', err);
            showErrorMessage('Failed to start scan: ' + err.message);
        }
    }

    async function stopScan() {
        try {
            await fetch('/api/bluetooth/scan/stop', { method: 'POST' });
            setScanning(false);
            stopEventStream();
        } catch (err) {
            console.error('Failed to stop scan:', err);
        }
    }

    function setScanning(scanning) {
        isScanning = scanning;

        if (startBtn) startBtn.style.display = scanning ? 'none' : 'block';
        if (stopBtn) stopBtn.style.display = scanning ? 'block' : 'none';

        if (scanning && deviceContainer) {
            deviceContainer.innerHTML = '';
            devices.clear();
            resetStats();
        }

        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        if (statusDot) statusDot.classList.toggle('running', scanning);
        if (statusText) statusText.textContent = scanning ? 'Scanning...' : 'Idle';
    }

    function resetStats() {
        deviceStats = {
            strong: 0,
            medium: 0,
            weak: 0,
            trackers: []
        };
        updateVisualizationPanels();
        updateProximityZones();

        // Clear radar
        if (radarInitialized && typeof ProximityRadar !== 'undefined') {
            ProximityRadar.clear();
        }
    }

    function startEventStream() {
        if (eventSource) eventSource.close();

        eventSource = new EventSource('/api/bluetooth/stream');

        eventSource.addEventListener('device_update', (e) => {
            try {
                const device = JSON.parse(e.data);
                handleDeviceUpdate(device);
            } catch (err) {
                console.error('Failed to parse device update:', err);
            }
        });

        eventSource.addEventListener('scan_started', (e) => {
            setScanning(true);
        });

        eventSource.addEventListener('scan_stopped', (e) => {
            setScanning(false);
        });

        eventSource.onerror = () => {
            console.warn('Bluetooth SSE connection error');
        };
    }

    function stopEventStream() {
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
    }

    function handleDeviceUpdate(device) {
        devices.set(device.device_id, device);
        renderDevice(device);
        updateDeviceCount();
        updateStatsFromDevices();
        updateVisualizationPanels();
        updateProximityZones();

        // Update new proximity radar
        updateRadar();
    }

    /**
     * Update stats from all devices
     */
    function updateStatsFromDevices() {
        // Reset counts
        deviceStats.strong = 0;
        deviceStats.medium = 0;
        deviceStats.weak = 0;
        deviceStats.trackers = [];

        devices.forEach(d => {
            const name = (d.name || '').toLowerCase();
            const rssi = d.rssi_current;

            // Signal strength classification
            if (rssi != null) {
                if (rssi >= -50) deviceStats.strong++;
                else if (rssi >= -70) deviceStats.medium++;
                else deviceStats.weak++;
            }

            // Tracker detection - check for known tracker patterns
            const isTracker = name.includes('tile') || name.includes('airtag') ||
                             name.includes('smarttag') || name.includes('chipolo') ||
                             name.includes('tracker') || name.includes('tag');

            if (isTracker) {
                if (!deviceStats.trackers.find(t => t.address === d.address)) {
                    deviceStats.trackers.push(d);
                }
            }
        });
    }

    /**
     * Update visualization panels
     */
    function updateVisualizationPanels() {
        // Signal Distribution
        const total = devices.size || 1;
        const strongBar = document.getElementById('btSignalStrong');
        const mediumBar = document.getElementById('btSignalMedium');
        const weakBar = document.getElementById('btSignalWeak');
        const strongCount = document.getElementById('btSignalStrongCount');
        const mediumCount = document.getElementById('btSignalMediumCount');
        const weakCount = document.getElementById('btSignalWeakCount');

        if (strongBar) strongBar.style.width = (deviceStats.strong / total * 100) + '%';
        if (mediumBar) mediumBar.style.width = (deviceStats.medium / total * 100) + '%';
        if (weakBar) weakBar.style.width = (deviceStats.weak / total * 100) + '%';
        if (strongCount) strongCount.textContent = deviceStats.strong;
        if (mediumCount) mediumCount.textContent = deviceStats.medium;
        if (weakCount) weakCount.textContent = deviceStats.weak;

        // Tracker Detection
        const trackerList = document.getElementById('btTrackerList');
        if (trackerList) {
            if (devices.size === 0) {
                trackerList.innerHTML = '<div style="color:#666;padding:10px;text-align:center;font-size:11px;">Start scanning to detect trackers</div>';
            } else if (deviceStats.trackers.length === 0) {
                trackerList.innerHTML = '<div style="color:#22c55e;padding:10px;text-align:center;font-size:11px;">✓ No known trackers detected</div>';
            } else {
                trackerList.innerHTML = deviceStats.trackers.map(t => `
                    <div style="padding:8px;border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;" onclick="BluetoothMode.selectDevice('${t.device_id}')">
                        <div style="display:flex;justify-content:space-between;">
                            <span style="color:#f97316;font-size:11px;">${escapeHtml(t.name || formatDeviceId(t.address))}</span>
                            <span style="color:#666;font-size:10px;">${t.rssi_current || '--'} dBm</span>
                        </div>
                        <div style="font-size:9px;color:#666;font-family:monospace;">${t.address}</div>
                    </div>
                `).join('');
            }
        }

    }

    function updateDeviceCount() {
        updateFilteredCount();
    }

    function renderDevice(device) {
        if (!deviceContainer) {
            deviceContainer = document.getElementById('btDeviceListContent');
            if (!deviceContainer) return;
        }

        const escapedId = CSS.escape(device.device_id);
        const existingCard = deviceContainer.querySelector('[data-bt-device-id="' + escapedId + '"]');
        const cardHtml = createSimpleDeviceCard(device);

        if (existingCard) {
            existingCard.outerHTML = cardHtml;
        } else {
            deviceContainer.insertAdjacentHTML('afterbegin', cardHtml);
        }

        // Re-apply filter after rendering
        if (currentDeviceFilter !== 'all') {
            applyDeviceFilter();
        }
    }

    function createSimpleDeviceCard(device) {
        const protocol = device.protocol || 'ble';
        const rssi = device.rssi_current;
        const rssiColor = getRssiColor(rssi);
        const inBaseline = device.in_baseline || false;
        const isNew = !inBaseline;
        const hasName = !!device.name;

        // Calculate RSSI bar width (0-100%)
        // RSSI typically ranges from -100 (weak) to -30 (very strong)
        const rssiPercent = rssi != null ? Math.max(0, Math.min(100, ((rssi + 100) / 70) * 100)) : 0;

        const displayName = device.name || formatDeviceId(device.address);
        const name = escapeHtml(displayName);
        const addr = escapeHtml(device.address || 'Unknown');
        const mfr = device.manufacturer_name ? escapeHtml(device.manufacturer_name) : '';
        const seenCount = device.seen_count || 0;
        const deviceIdEscaped = escapeHtml(device.device_id).replace(/'/g, "\\'");

        // Protocol badge - compact
        const protoBadge = protocol === 'ble'
            ? '<span class="bt-proto-badge ble">BLE</span>'
            : '<span class="bt-proto-badge classic">CLASSIC</span>';

        // Status indicator
        const statusDot = isNew
            ? '<span class="bt-status-dot new"></span>'
            : '<span class="bt-status-dot known"></span>';

        // Build secondary info line
        let secondaryParts = [addr];
        if (mfr) secondaryParts.push(mfr);
        secondaryParts.push('Seen ' + seenCount + '×');
        const secondaryInfo = secondaryParts.join(' · ');

        return '<div class="bt-device-row" data-bt-device-id="' + escapeHtml(device.device_id) + '" data-is-new="' + isNew + '" data-has-name="' + hasName + '" data-rssi="' + (rssi || -100) + '" onclick="BluetoothMode.selectDevice(\'' + deviceIdEscaped + '\')" style="border-left-color:' + rssiColor + ';">' +
            '<div class="bt-row-main">' +
                '<div class="bt-row-left">' +
                    protoBadge +
                    '<span class="bt-device-name">' + name + '</span>' +
                '</div>' +
                '<div class="bt-row-right">' +
                    '<div class="bt-rssi-container">' +
                        '<div class="bt-rssi-bar-bg"><div class="bt-rssi-bar" style="width:' + rssiPercent + '%;background:' + rssiColor + ';"></div></div>' +
                        '<span class="bt-rssi-value" style="color:' + rssiColor + ';">' + (rssi != null ? rssi : '--') + '</span>' +
                    '</div>' +
                    statusDot +
                '</div>' +
            '</div>' +
            '<div class="bt-row-secondary">' + secondaryInfo + '</div>' +
        '</div>';
    }

    function getRssiColor(rssi) {
        if (rssi == null) return '#666';
        if (rssi >= -50) return '#22c55e';
        if (rssi >= -60) return '#84cc16';
        if (rssi >= -70) return '#eab308';
        if (rssi >= -80) return '#f97316';
        return '#ef4444';
    }

    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    }

    async function setBaseline() {
        try {
            const response = await fetch('/api/bluetooth/baseline/set', { method: 'POST' });
            const data = await response.json();

            if (data.status === 'success') {
                baselineSet = true;
                baselineCount = data.device_count;
                updateBaselineStatus();
            }
        } catch (err) {
            console.error('Failed to set baseline:', err);
        }
    }

    async function clearBaseline() {
        try {
            const response = await fetch('/api/bluetooth/baseline/clear', { method: 'POST' });
            const data = await response.json();

            if (data.status === 'success') {
                baselineSet = false;
                baselineCount = 0;
                updateBaselineStatus();
            }
        } catch (err) {
            console.error('Failed to clear baseline:', err);
        }
    }

    function updateBaselineStatus() {
        if (!baselineStatusEl) return;

        if (baselineSet) {
            baselineStatusEl.textContent = `Baseline: ${baselineCount} devices`;
            baselineStatusEl.style.color = '#22c55e';
        } else {
            baselineStatusEl.textContent = 'No baseline';
            baselineStatusEl.style.color = '';
        }
    }

    function exportData(format) {
        window.open(`/api/bluetooth/export?format=${format}`, '_blank');
    }

    function showErrorMessage(message) {
        console.error('[BT] Error:', message);
    }

    // Public API
    return {
        init,
        startScan,
        stopScan,
        checkCapabilities,
        setBaseline,
        clearBaseline,
        exportData,
        selectDevice,
        clearSelection,
        copyAddress,
        getDevices: () => Array.from(devices.values()),
        isScanning: () => isScanning
    };
})();

// Global functions for onclick handlers
function btStartScan() { BluetoothMode.startScan(); }
function btStopScan() { BluetoothMode.stopScan(); }
function btCheckCapabilities() { BluetoothMode.checkCapabilities(); }
function btSetBaseline() { BluetoothMode.setBaseline(); }
function btClearBaseline() { BluetoothMode.clearBaseline(); }
function btExport(format) { BluetoothMode.exportData(format); }

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        if (document.getElementById('bluetoothMode')) {
            BluetoothMode.init();
        }
    });
} else {
    if (document.getElementById('bluetoothMode')) {
        BluetoothMode.init();
    }
}

window.BluetoothMode = BluetoothMode;
