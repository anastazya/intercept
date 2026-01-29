/**
 * Meshtastic Mode
 * Mesh network monitoring and configuration
 */

const Meshtastic = (function() {
    // State
    let isConnected = false;
    let eventSource = null;
    let messages = [];
    let channels = [];
    let nodeInfo = null;
    let uniqueNodes = new Set();
    let currentFilter = '';
    let editingChannelIndex = null;

    // Map state
    let meshMap = null;
    let meshMarkers = {};  // nodeId -> marker
    let localNodeId = null;

    /**
     * Initialize the Meshtastic mode
     */
    function init() {
        initMap();
        loadPorts();
        checkStatus();
        setupEventDelegation();
    }

    /**
     * Setup event delegation for dynamically created elements
     */
    function setupEventDelegation() {
        // Handle traceroute button clicks in Leaflet popups
        document.addEventListener('click', function(e) {
            const tracerouteBtn = e.target.closest('.mesh-traceroute-btn');
            if (tracerouteBtn) {
                const nodeId = tracerouteBtn.dataset.nodeId;
                if (nodeId) {
                    sendTraceroute(nodeId);
                }
            }
        });
    }

    /**
     * Load available serial ports and populate dropdown
     */
    async function loadPorts() {
        try {
            const response = await fetch('/meshtastic/ports');
            const data = await response.json();

            const select = document.getElementById('meshStripDevice');
            if (!select) return;

            // Clear existing options except auto-detect
            select.innerHTML = '<option value="">Auto-detect</option>';

            if (data.status === 'ok' && data.ports && data.ports.length > 0) {
                data.ports.forEach(port => {
                    const option = document.createElement('option');
                    option.value = port;
                    option.textContent = port;
                    select.appendChild(option);
                });

                // If multiple ports, select the first one by default to avoid auto-detect failure
                if (data.ports.length > 1) {
                    select.value = data.ports[0];
                    showStatusMessage(`Multiple ports detected. Selected ${data.ports[0]}`, 'warning');
                }
            }
        } catch (err) {
            console.error('Failed to load ports:', err);
        }
    }

    /**
     * Initialize the Leaflet map
     */
    function initMap() {
        if (meshMap) return;

        const mapContainer = document.getElementById('meshMap');
        if (!mapContainer) return;

        // Default to center of US
        const defaultLat = 39.8283;
        const defaultLon = -98.5795;

        meshMap = L.map('meshMap').setView([defaultLat, defaultLon], 4);
        window.meshMap = meshMap;

        // Use settings manager for tile layer (allows runtime changes)
        if (typeof Settings !== 'undefined' && Settings.createTileLayer) {
            Settings.createTileLayer().addTo(meshMap);
            Settings.registerMap(meshMap);
        } else {
            L.tileLayer('https://cartodb-basemaps-{s}.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
                maxZoom: 19,
                subdomains: 'abcd'
            }).addTo(meshMap);
        }

        // Handle resize
        setTimeout(() => {
            if (meshMap) meshMap.invalidateSize();
        }, 100);
    }

    /**
     * Check current connection status
     */
    async function checkStatus() {
        try {
            const response = await fetch('/meshtastic/status');
            const data = await response.json();

            if (!data.available) {
                showStatusMessage('SDK not installed. Install with: pip install meshtastic', 'warning');
                return;
            }

            if (data.running) {
                isConnected = true;
                updateConnectionUI(true, data.device);
                if (data.node_info) {
                    updateNodeInfo(data.node_info);
                    localNodeId = data.node_info.num;
                }
                loadChannels();
                loadMessages();
                loadNodes();
                startStream();
            }
        } catch (err) {
            console.error('Failed to check Meshtastic status:', err);
        }
    }

    /**
     * Start Meshtastic connection
     */
    async function start() {
        // Try strip device select first, then sidebar
        const stripDeviceSelect = document.getElementById('meshStripDevice');
        const sidebarDeviceSelect = document.getElementById('meshDeviceSelect');
        let device = stripDeviceSelect?.value || sidebarDeviceSelect?.value || null;

        // Check if auto-detect is selected but multiple ports exist
        if (!device && stripDeviceSelect && stripDeviceSelect.options.length > 2) {
            // Multiple ports available - prompt user to select one
            showStatusMessage('Multiple ports detected. Please select a specific device from the dropdown.', 'warning');
            updateStatusIndicator('disconnected', 'Select a device');
            return;
        }

        updateStatusIndicator('connecting', 'Connecting...');

        // Update strip status
        const stripDot = document.getElementById('meshStripDot');
        const stripStatus = document.getElementById('meshStripStatus');
        if (stripDot) stripDot.className = 'mesh-strip-dot connecting';
        if (stripStatus) stripStatus.textContent = 'Connecting...';

        try {
            const response = await fetch('/meshtastic/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device: device || undefined })
            });

            const data = await response.json();

            if (data.status === 'started' || data.status === 'already_running') {
                isConnected = true;
                updateConnectionUI(true, data.device);
                if (data.node_info) {
                    updateNodeInfo(data.node_info);
                    localNodeId = data.node_info.num;
                }
                loadChannels();
                loadNodes();
                startStream();
                showNotification('Meshtastic', 'Connected to device');
            } else {
                updateStatusIndicator('disconnected', data.message || 'Connection failed');
                showStatusMessage(data.message || 'Failed to connect', 'error');
            }
        } catch (err) {
            console.error('Failed to start Meshtastic:', err);
            updateStatusIndicator('disconnected', 'Connection error');
            showStatusMessage('Connection error: ' + err.message, 'error');
        }
    }

    /**
     * Stop Meshtastic connection
     */
    async function stop() {
        try {
            await fetch('/meshtastic/stop', { method: 'POST' });
            isConnected = false;
            stopStream();
            updateConnectionUI(false);
            showNotification('Meshtastic', 'Disconnected');
        } catch (err) {
            console.error('Failed to stop Meshtastic:', err);
        }
    }

    /**
     * Update connection UI state
     */
    function updateConnectionUI(connected, device) {
        const connectBtn = document.getElementById('meshConnectBtn');
        const disconnectBtn = document.getElementById('meshDisconnectBtn');
        const nodeSection = document.getElementById('meshNodeSection');
        const channelsSection = document.getElementById('meshChannelsSection');
        const statsSection = document.getElementById('meshStatsSection');
        const filterSection = document.getElementById('meshFilterSection');
        const composeBox = document.getElementById('meshCompose');

        // Strip controls
        const stripConnectBtn = document.getElementById('meshStripConnectBtn');
        const stripDisconnectBtn = document.getElementById('meshStripDisconnectBtn');
        const stripDot = document.getElementById('meshStripDot');
        const stripStatus = document.getElementById('meshStripStatus');

        if (connected) {
            updateStatusIndicator('connected', device ? `Connected to ${device}` : 'Connected');
            if (connectBtn) connectBtn.style.display = 'none';
            if (disconnectBtn) disconnectBtn.style.display = 'block';
            if (nodeSection) nodeSection.style.display = 'block';
            if (channelsSection) channelsSection.style.display = 'block';
            if (statsSection) statsSection.style.display = 'block';
            if (filterSection) filterSection.style.display = 'block';
            if (composeBox) composeBox.style.display = 'block';

            // Update strip
            if (stripConnectBtn) stripConnectBtn.style.display = 'none';
            if (stripDisconnectBtn) stripDisconnectBtn.style.display = 'inline-block';
            if (stripDot) {
                stripDot.className = 'mesh-strip-dot connected';
            }
            if (stripStatus) stripStatus.textContent = device || 'Connected';
        } else {
            updateStatusIndicator('disconnected', 'Disconnected');
            if (connectBtn) connectBtn.style.display = 'block';
            if (disconnectBtn) disconnectBtn.style.display = 'none';
            if (nodeSection) nodeSection.style.display = 'none';
            if (channelsSection) channelsSection.style.display = 'none';
            if (statsSection) statsSection.style.display = 'none';
            if (filterSection) filterSection.style.display = 'none';
            if (composeBox) composeBox.style.display = 'none';

            // Reset strip
            if (stripConnectBtn) stripConnectBtn.style.display = 'inline-block';
            if (stripDisconnectBtn) stripDisconnectBtn.style.display = 'none';
            if (stripDot) {
                stripDot.className = 'mesh-strip-dot disconnected';
            }
            if (stripStatus) stripStatus.textContent = 'Disconnected';

            // Reset strip node info
            const stripNodeName = document.getElementById('meshStripNodeName');
            const stripNodeId = document.getElementById('meshStripNodeId');
            const stripModel = document.getElementById('meshStripModel');
            if (stripNodeName) stripNodeName.textContent = '--';
            if (stripNodeId) stripNodeId.textContent = '--';
            if (stripModel) stripModel.textContent = '--';
        }
    }

    /**
     * Update status indicator
     */
    function updateStatusIndicator(status, text) {
        const dot = document.querySelector('.mesh-status-dot');
        const textEl = document.getElementById('meshStatusText');

        if (dot) {
            dot.classList.remove('connected', 'connecting', 'disconnected');
            dot.classList.add(status);
        }
        if (textEl) {
            textEl.textContent = text;
        }
    }

    /**
     * Update node info display
     */
    function updateNodeInfo(info) {
        nodeInfo = info;

        // Sidebar elements
        const nameEl = document.getElementById('meshNodeName');
        const idEl = document.getElementById('meshNodeId');
        const modelEl = document.getElementById('meshNodeModel');
        const posRow = document.getElementById('meshNodePosRow');
        const posEl = document.getElementById('meshNodePosition');

        // Strip elements
        const stripNodeName = document.getElementById('meshStripNodeName');
        const stripNodeId = document.getElementById('meshStripNodeId');
        const stripModel = document.getElementById('meshStripModel');

        const nodeName = info.long_name || info.short_name || '--';
        const nodeId = info.user_id || formatNodeId(info.num) || '--';
        const hwModel = info.hw_model || '--';

        // Update sidebar
        if (nameEl) nameEl.textContent = nodeName;
        if (idEl) idEl.textContent = nodeId;
        if (modelEl) modelEl.textContent = hwModel;

        // Update strip
        if (stripNodeName) stripNodeName.textContent = nodeName;
        if (stripNodeId) stripNodeId.textContent = nodeId;
        if (stripModel) stripModel.textContent = hwModel;

        // Position is nested in the response
        const pos = info.position;
        if (pos && pos.latitude && pos.longitude) {
            if (posRow) posRow.style.display = 'flex';
            if (posEl) posEl.textContent = `${pos.latitude.toFixed(5)}, ${pos.longitude.toFixed(5)}`;
        } else {
            if (posRow) posRow.style.display = 'none';
        }
    }

    /**
     * Load channels from device
     */
    async function loadChannels() {
        try {
            const response = await fetch('/meshtastic/channels');
            const data = await response.json();

            if (data.status === 'ok') {
                channels = data.channels;
                renderChannels();
                updateChannelFilter();
                updateComposeChannels();
            }
        } catch (err) {
            console.error('Failed to load channels:', err);
        }
    }

    /**
     * Render channel list
     */
    function renderChannels() {
        const container = document.getElementById('meshChannelsList');
        if (!container) return;

        if (channels.length === 0) {
            container.innerHTML = '<p style="color: var(--text-dim); font-size: 11px; text-align: center; padding: 20px;">No channels configured</p>';
            return;
        }

        container.innerHTML = channels.map(ch => {
            const isDisabled = !ch.name && ch.role === 'DISABLED';
            const roleBadge = ch.role === 'PRIMARY' ? 'mesh-badge-primary' : 'mesh-badge-secondary';
            const encBadge = ch.encrypted ? 'mesh-badge-encrypted' : 'mesh-badge-unencrypted';
            const encText = ch.encrypted ? (ch.psk_length === 32 ? 'AES-256' : ch.psk_length === 16 ? 'AES-128' : 'ENCRYPTED') : 'NONE';

            return `
                <div class="mesh-channel-item ${isDisabled ? 'disabled' : ''}">
                    <div class="mesh-channel-info">
                        <span class="mesh-channel-index">${ch.index}</span>
                        <span class="mesh-channel-name">${ch.name || (isDisabled ? '(disabled)' : '(unnamed)')}</span>
                    </div>
                    <div class="mesh-channel-badges">
                        <span class="mesh-channel-badge ${roleBadge}">${ch.role || 'SECONDARY'}</span>
                        <span class="mesh-channel-badge ${encBadge}">${encText}</span>
                        <button class="mesh-channel-configure" onclick="Meshtastic.openChannelModal(${ch.index})">Configure</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    /**
     * Refresh channels
     */
    function refreshChannels() {
        loadChannels();
    }

    /**
     * Open channel configuration modal
     */
    function openChannelModal(index) {
        editingChannelIndex = index;
        const channel = channels.find(ch => ch.index === index);

        const modal = document.getElementById('meshChannelModal');
        const indexEl = document.getElementById('meshModalChannelIndex');
        const nameInput = document.getElementById('meshModalChannelName');
        const pskFormat = document.getElementById('meshModalPskFormat');

        if (indexEl) indexEl.textContent = index;
        if (nameInput) nameInput.value = channel?.name || '';
        if (pskFormat) pskFormat.value = 'keep';

        onPskFormatChange();

        if (modal) modal.classList.add('show');
    }

    /**
     * Close channel configuration modal
     */
    function closeChannelModal() {
        const modal = document.getElementById('meshChannelModal');
        if (modal) modal.classList.remove('show');
        editingChannelIndex = null;
    }

    /**
     * Handle PSK format change
     */
    function onPskFormatChange() {
        const format = document.getElementById('meshModalPskFormat')?.value;
        const inputContainer = document.getElementById('meshModalPskInputContainer');
        const pskInput = document.getElementById('meshModalPskValue');
        const warning = document.getElementById('meshModalPskWarning');

        // Show input for formats that need a value
        const needsInput = ['simple', 'base64', 'hex'].includes(format);
        if (inputContainer) inputContainer.style.display = needsInput ? 'block' : 'none';

        // Update placeholder based on format
        if (pskInput) {
            const placeholders = {
                'simple': 'Enter passphrase...',
                'base64': 'Enter base64 key...',
                'hex': 'Enter hex key (0x...)...'
            };
            pskInput.placeholder = placeholders[format] || '';
            pskInput.value = '';
        }

        // Show warning for default key
        if (warning) warning.style.display = format === 'default' ? 'block' : 'none';
    }

    /**
     * Save channel configuration
     */
    async function saveChannelConfig() {
        if (editingChannelIndex === null) return;

        const nameInput = document.getElementById('meshModalChannelName');
        const pskFormat = document.getElementById('meshModalPskFormat')?.value;
        const pskValue = document.getElementById('meshModalPskValue')?.value;

        const body = {};
        const name = nameInput?.value.trim();
        if (name) body.name = name;

        // Build PSK value based on format
        if (pskFormat && pskFormat !== 'keep') {
            switch (pskFormat) {
                case 'none':
                    body.psk = 'none';
                    break;
                case 'default':
                    body.psk = 'default';
                    break;
                case 'random':
                    body.psk = 'random';
                    break;
                case 'simple':
                    if (pskValue) body.psk = 'simple:' + pskValue;
                    break;
                case 'base64':
                    if (pskValue) body.psk = 'base64:' + pskValue;
                    break;
                case 'hex':
                    if (pskValue) body.psk = pskValue.startsWith('0x') ? pskValue : '0x' + pskValue;
                    break;
            }
        }

        if (Object.keys(body).length === 0) {
            closeChannelModal();
            return;
        }

        try {
            const response = await fetch(`/meshtastic/channels/${editingChannelIndex}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            const data = await response.json();

            if (data.status === 'ok') {
                showNotification('Meshtastic', 'Channel configured successfully');
                closeChannelModal();
                loadChannels();
            } else {
                showStatusMessage(data.message || 'Failed to configure channel', 'error');
            }
        } catch (err) {
            console.error('Failed to configure channel:', err);
            showStatusMessage('Error configuring channel: ' + err.message, 'error');
        }
    }

    /**
     * Load message history
     */
    async function loadMessages(limit) {
        try {
            let url = '/meshtastic/messages';
            const params = new URLSearchParams();
            if (limit) params.set('limit', limit);
            if (currentFilter) params.set('channel', currentFilter);
            if (params.toString()) url += '?' + params.toString();

            const response = await fetch(url);
            const data = await response.json();

            if (data.status === 'ok') {
                messages = data.messages;
                data.messages.forEach(msg => {
                    if (msg.from) uniqueNodes.add(msg.from);
                });
                updateStats();
                renderMessages();
            }
        } catch (err) {
            console.error('Failed to load messages:', err);
        }
    }

    /**
     * Load nodes and update map
     */
    async function loadNodes() {
        try {
            const response = await fetch('/meshtastic/nodes');
            const data = await response.json();

            if (data.status === 'ok') {
                updateMapStats(data.count, data.with_position_count);

                // Update markers for all nodes with positions
                data.nodes.forEach(node => {
                    // Track node in uniqueNodes set for stats
                    if (node.num) uniqueNodes.add(node.num);

                    if (node.has_position) {
                        updateNodeMarker(node);
                    }
                });

                // Update stats to reflect loaded nodes
                updateStats();

                // Fit map to show all nodes if we have any
                const nodesWithPos = data.nodes.filter(n => n.has_position);
                if (nodesWithPos.length > 0 && meshMap) {
                    const bounds = nodesWithPos.map(n => [n.latitude, n.longitude]);
                    if (bounds.length === 1) {
                        meshMap.setView(bounds[0], 12);
                    } else {
                        meshMap.fitBounds(bounds, { padding: [50, 50] });
                    }
                }
            }
        } catch (err) {
            console.error('Failed to load nodes:', err);
        }
    }

    /**
     * Update or create a node marker on the map
     */
    function updateNodeMarker(node) {
        if (!meshMap || !node.latitude || !node.longitude) return;

        const nodeId = node.id || `!${node.num.toString(16).padStart(8, '0')}`;
        const isLocal = node.num === localNodeId;

        // Determine if node is stale (no update in 30 minutes)
        let isStale = false;
        if (node.last_heard) {
            const lastHeard = new Date(node.last_heard);
            const now = new Date();
            isStale = (now - lastHeard) > 30 * 60 * 1000;
        }

        // Create marker icon
        const markerClass = `mesh-node-marker ${isLocal ? 'local' : ''} ${isStale ? 'stale' : ''}`;
        const shortName = node.short_name || nodeId.slice(-4);

        const icon = L.divIcon({
            className: 'mesh-marker-wrapper',
            html: `<div class="${markerClass}">${shortName.slice(0, 2).toUpperCase()}</div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
            popupAnchor: [0, -14]
        });

        // Build telemetry section
        let telemetryHtml = '';
        if (node.voltage !== null || node.channel_utilization !== null || node.air_util_tx !== null) {
            telemetryHtml += '<div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border-color);">';
            telemetryHtml += '<span style="color: var(--text-dim); font-size: 9px; text-transform: uppercase;">Device Telemetry</span><br>';
            if (node.voltage !== null) {
                telemetryHtml += `<span style="color: var(--text-dim);">Voltage:</span> ${node.voltage.toFixed(2)}V<br>`;
            }
            if (node.channel_utilization !== null) {
                telemetryHtml += `<span style="color: var(--text-dim);">Ch Util:</span> ${node.channel_utilization.toFixed(1)}%<br>`;
            }
            if (node.air_util_tx !== null) {
                telemetryHtml += `<span style="color: var(--text-dim);">Air TX:</span> ${node.air_util_tx.toFixed(1)}%<br>`;
            }
            telemetryHtml += '</div>';
        }

        // Build environment section
        let envHtml = '';
        if (node.temperature !== null || node.humidity !== null || node.barometric_pressure !== null) {
            envHtml += '<div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border-color);">';
            envHtml += '<span style="color: var(--text-dim); font-size: 9px; text-transform: uppercase;">Environment</span><br>';
            if (node.temperature !== null) {
                telemetryHtml += `<span style="color: var(--text-dim);">Temp:</span> ${node.temperature.toFixed(1)}°C<br>`;
            }
            if (node.humidity !== null) {
                envHtml += `<span style="color: var(--text-dim);">Humidity:</span> ${node.humidity.toFixed(1)}%<br>`;
            }
            if (node.barometric_pressure !== null) {
                envHtml += `<span style="color: var(--text-dim);">Pressure:</span> ${node.barometric_pressure.toFixed(1)} hPa<br>`;
            }
            envHtml += '</div>';
        }

        // Build popup content
        const popupContent = `
            <div style="min-width: 150px;">
                <strong style="color: var(--accent-cyan);">${node.long_name || shortName}</strong><br>
                <span style="color: var(--text-dim);">ID:</span> ${nodeId}<br>
                <span style="color: var(--text-dim);">Model:</span> ${node.hw_model || 'Unknown'}<br>
                <span style="color: var(--text-dim);">Position:</span> ${node.latitude.toFixed(5)}, ${node.longitude.toFixed(5)}<br>
                ${node.altitude ? `<span style="color: var(--text-dim);">Altitude:</span> ${node.altitude}m<br>` : ''}
                ${node.battery_level !== null ? `<span style="color: var(--text-dim);">Battery:</span> ${node.battery_level}%<br>` : ''}
                ${node.snr !== null ? `<span style="color: var(--text-dim);">SNR:</span> ${node.snr.toFixed(1)} dB<br>` : ''}
                ${node.last_heard ? `<span style="color: var(--text-dim);">Last heard:</span> ${new Date(node.last_heard).toLocaleTimeString()}<br>` : ''}
                ${telemetryHtml}
                ${envHtml}
                ${!isLocal ? `<button class="mesh-traceroute-btn" data-node-id="${nodeId}">Traceroute</button>` : ''}
            </div>
        `;

        // Update or create marker
        if (meshMarkers[nodeId]) {
            meshMarkers[nodeId].setLatLng([node.latitude, node.longitude]);
            meshMarkers[nodeId].setIcon(icon);
            meshMarkers[nodeId].setPopupContent(popupContent);
        } else {
            const marker = L.marker([node.latitude, node.longitude], { icon })
                .bindPopup(popupContent)
                .addTo(meshMap);
            meshMarkers[nodeId] = marker;
        }
    }

    /**
     * Update map stats display
     */
    function updateMapStats(total, withGps) {
        const totalEl = document.getElementById('meshMapNodeCount');
        const gpsEl = document.getElementById('meshMapGpsCount');
        if (totalEl) totalEl.textContent = total;
        if (gpsEl) gpsEl.textContent = withGps;
    }

    /**
     * Start SSE stream
     */
    function startStream() {
        if (eventSource) {
            eventSource.close();
        }

        eventSource = new EventSource('/meshtastic/stream');

        eventSource.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.type === 'meshtastic') {
                    handleMessage(data);
                }
            } catch (err) {
                console.error('Failed to parse SSE message:', err);
            }
        };

        eventSource.onerror = () => {
            console.warn('Meshtastic SSE error, will reconnect...');
            setTimeout(() => {
                if (isConnected) startStream();
            }, 3000);
        };
    }

    /**
     * Stop SSE stream
     */
    function stopStream() {
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
    }

    /**
     * Handle incoming message
     */
    function handleMessage(msg) {
        console.log('Received message:', msg);
        console.log('from_name:', msg.from_name, 'timestamp:', msg.timestamp, 'type:', typeof msg.timestamp);
        messages.push(msg);
        if (msg.from) uniqueNodes.add(msg.from);

        // Keep messages limited
        if (messages.length > 500) {
            messages.shift();
        }

        updateStats();

        // Only render if passes filter
        if (!currentFilter || msg.channel == currentFilter) {
            prependMessage(msg);
        }

        // Refresh nodes if we got position or nodeinfo data
        const portnum = msg.portnum || msg.app_type || '';
        if (portnum.includes('POSITION') || portnum.includes('NODEINFO')) {
            // Debounce node refresh to avoid too many requests
            clearTimeout(handleMessage._nodeRefreshTimeout);
            handleMessage._nodeRefreshTimeout = setTimeout(() => {
                loadNodes();
            }, 2000);
        }
    }

    /**
     * Update statistics display
     */
    function updateStats() {
        // Sidebar stats
        const msgCountEl = document.getElementById('meshMsgCount');
        const nodeCountEl = document.getElementById('meshNodeCount');

        // Strip stats
        const stripMsgCount = document.getElementById('meshStripMsgCount');
        const stripNodeCount = document.getElementById('meshStripNodeCount');

        const msgCount = messages.length;
        const nodeCount = uniqueNodes.size;

        if (msgCountEl) msgCountEl.textContent = msgCount;
        if (nodeCountEl) nodeCountEl.textContent = nodeCount;
        if (stripMsgCount) stripMsgCount.textContent = msgCount;
        if (stripNodeCount) stripNodeCount.textContent = nodeCount;
    }

    /**
     * Render all messages
     */
    function renderMessages() {
        const container = document.getElementById('meshMessagesGrid');
        if (!container) return;

        const filtered = currentFilter
            ? messages.filter(m => m.channel == currentFilter)
            : messages;

        if (filtered.length === 0) {
            container.innerHTML = `
                <div class="mesh-messages-empty">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <circle cx="12" cy="12" r="3"/>
                        <path d="M12 2v4m0 12v4M2 12h4m12 0h4"/>
                    </svg>
                    <p>No messages received yet</p>
                </div>
            `;
            return;
        }

        container.innerHTML = filtered
            .slice()
            .reverse()
            .map(msg => renderMessageCard(msg))
            .join('');
    }

    /**
     * Prepend a single message to the feed
     */
    function prependMessage(msg) {
        const container = document.getElementById('meshMessagesGrid');
        if (!container) return;

        // Remove empty state if present
        const empty = container.querySelector('.mesh-messages-empty');
        if (empty) empty.remove();

        const card = document.createElement('div');
        card.innerHTML = renderMessageCard(msg);
        container.insertBefore(card.firstElementChild, container.firstChild);

        // Limit displayed messages
        while (container.children.length > 100) {
            container.lastElementChild.remove();
        }
    }

    /**
     * Render a single message card
     */
    function renderMessageCard(msg) {
        const typeClass = getMessageTypeClass(msg.app_type || msg.portnum);
        // Use name if available, fall back to ID
        const fromDisplay = msg.from_name || formatNodeId(msg.from);
        const toDisplay = msg.to === 'broadcast' || msg.to === '^all'
            ? '<span class="broadcast">^all</span>'
            : (msg.to_name || formatNodeId(msg.to));

        const time = msg.timestamp
            ? new Date(msg.timestamp * 1000).toLocaleTimeString()
            : '--:--:--';

        let body;
        if (msg.text) {
            body = `<div class="mesh-message-body">${escapeHtml(msg.text)}</div>`;
        } else {
            body = `<div class="mesh-message-body app-type">[${msg.app_type || msg.portnum || 'UNKNOWN'}]</div>`;
        }

        let signalInfo = '';
        if (msg.rssi != null || msg.snr != null) {
            const rssiHtml = msg.rssi != null
                ? `<div class="mesh-signal-item"><span class="mesh-signal-label">RSSI</span><span class="mesh-signal-value rssi">${msg.rssi}dBm</span></div>`
                : '';
            const snrClass = msg.snr != null ? (msg.snr < 0 ? 'bad' : msg.snr < 5 ? 'poor' : '') : '';
            const snrHtml = msg.snr != null
                ? `<div class="mesh-signal-item"><span class="mesh-signal-label">SNR</span><span class="mesh-signal-value snr ${snrClass}">${msg.snr.toFixed(1)}</span></div>`
                : '';
            signalInfo = `<div class="mesh-message-signal">${rssiHtml}${snrHtml}</div>`;
        }

        // Handle pending/sent messages
        const isPending = msg._pending;
        const isFailed = msg._failed;
        const pendingClass = isPending ? 'pending' : (isFailed ? 'failed' : '');
        const pendingAttr = isPending ? 'data-pending="true"' : '';

        // Status indicator for sent messages
        let statusIndicator = '';
        if (isPending) {
            statusIndicator = '<span class="mesh-message-status sending">Sending...</span>';
        } else if (isFailed) {
            statusIndicator = '<span class="mesh-message-status failed">Failed</span>';
        }

        return `
            <div class="mesh-message-card ${typeClass} ${pendingClass}" ${pendingAttr}>
                <div class="mesh-message-header">
                    <div class="mesh-message-route">
                        <span class="mesh-message-from">${fromDisplay}</span>
                        <span class="mesh-message-arrow">-></span>
                        <span class="mesh-message-to">${toDisplay}</span>
                        ${statusIndicator}
                    </div>
                    <div class="mesh-message-meta">
                        <span class="mesh-message-channel">[CH${msg.channel !== undefined ? msg.channel : '?'}]</span>
                        <span class="mesh-message-time">${time}</span>
                    </div>
                </div>
                ${body}
                ${signalInfo}
            </div>
        `;
    }

    /**
     * Get message type CSS class
     */
    function getMessageTypeClass(appType) {
        if (!appType) return '';
        const type = appType.toLowerCase();
        if (type.includes('text')) return 'text-message';
        if (type.includes('position')) return 'position-message';
        if (type.includes('telemetry')) return 'telemetry-message';
        if (type.includes('nodeinfo')) return 'nodeinfo-message';
        return '';
    }

    /**
     * Format node ID for display
     */
    function formatNodeId(id) {
        if (!id) return '--';
        if (typeof id === 'number') {
            return '!' + id.toString(16).padStart(8, '0');
        }
        if (typeof id === 'string' && !id.startsWith('!') && !id.startsWith('^')) {
            // Try to format as hex if it's a numeric string
            const num = parseInt(id, 10);
            if (!isNaN(num)) {
                return '!' + num.toString(16).padStart(8, '0');
            }
        }
        return id;
    }

    /**
     * Apply message filter
     */
    function applyFilter() {
        // Read from either filter dropdown (sidebar or visuals header)
        const sidebarFilter = document.getElementById('meshChannelFilter');
        const visualsFilter = document.getElementById('meshVisualsFilter');

        // Use whichever one has a value, preferring the one that was just changed
        const value = sidebarFilter?.value || visualsFilter?.value || '';
        currentFilter = value;

        // Sync both dropdowns
        if (sidebarFilter) sidebarFilter.value = value;
        if (visualsFilter) visualsFilter.value = value;

        renderMessages();
    }

    /**
     * Update channel filter dropdowns
     */
    function updateChannelFilter() {
        const selects = [
            document.getElementById('meshChannelFilter'),
            document.getElementById('meshVisualsFilter')
        ];

        selects.forEach(select => {
            if (!select) return;
            const currentValue = select.value;
            select.innerHTML = '<option value="">All Channels</option>';

            channels.forEach(ch => {
                if (ch.name || ch.role === 'PRIMARY') {
                    const option = document.createElement('option');
                    option.value = ch.index;
                    option.textContent = `[${ch.index}] ${ch.name || 'Primary'}`;
                    select.appendChild(option);
                }
            });

            select.value = currentValue;
        });
    }

    /**
     * Escape HTML for safe display
     */
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Show status message
     */
    function showStatusMessage(message, type) {
        if (typeof showNotification === 'function') {
            showNotification('Meshtastic', message);
        } else {
            console.log(`[Meshtastic ${type}] ${message}`);
        }
    }

    /**
     * Show help modal
     */
    function showHelp() {
        let modal = document.getElementById('meshtasticHelpModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'meshtasticHelpModal';
            modal.className = 'signal-details-modal';
            document.body.appendChild(modal);
        }

        modal.innerHTML = `
            <div class="signal-details-modal-backdrop" onclick="Meshtastic.closeHelp()"></div>
            <div class="signal-details-modal-content">
                <div class="signal-details-modal-header">
                    <h3>About Meshtastic</h3>
                    <button class="signal-details-modal-close" onclick="Meshtastic.closeHelp()">&times;</button>
                </div>
                <div class="signal-details-modal-body">
                    <div class="signal-details-section">
                        <div class="signal-details-title">What is Meshtastic?</div>
                        <p style="color: var(--text-secondary); font-size: 12px; line-height: 1.6;">
                            Meshtastic is an open-source mesh networking platform for LoRa radios. It enables
                            long-range, low-power communication between devices without requiring cellular or WiFi
                            infrastructure. Messages hop through the mesh to reach their destination.
                        </p>
                    </div>
                    <div class="signal-details-section">
                        <div class="signal-details-title">Supported Hardware</div>
                        <p style="color: var(--text-secondary); font-size: 12px; line-height: 1.6;">
                            Common Meshtastic devices include Heltec LoRa32, LILYGO T-Beam, RAK WisBlock, and
                            many others. Connect your device via USB to start monitoring the mesh.
                        </p>
                    </div>
                    <div class="signal-details-section">
                        <div class="signal-details-title">Channel Encryption</div>
                        <ul style="color: var(--text-secondary); font-size: 12px; line-height: 1.6; padding-left: 20px;">
                            <li><strong>None:</strong> Messages are unencrypted (not recommended)</li>
                            <li><strong>Default:</strong> Uses a known public key (NOT SECURE)</li>
                            <li><strong>Random:</strong> Generates a new AES-256 key</li>
                            <li><strong>Passphrase:</strong> Derives a key from a passphrase</li>
                            <li><strong>Base64/Hex:</strong> Use your own pre-shared key</li>
                        </ul>
                    </div>
                    <div class="signal-details-section">
                        <div class="signal-details-title">Requirements</div>
                        <p style="color: var(--text-secondary); font-size: 12px; line-height: 1.6;">
                            Install the Meshtastic Python SDK: <code style="background: var(--bg-secondary); padding: 2px 6px; border-radius: 3px;">pip install meshtastic</code>
                        </p>
                    </div>
                </div>
            </div>
        `;

        modal.classList.add('show');
    }

    /**
     * Close help modal
     */
    function closeHelp() {
        const modal = document.getElementById('meshtasticHelpModal');
        if (modal) modal.classList.remove('show');
    }

    /**
     * Handle keydown in compose input
     */
    function handleComposeKeydown(event) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    }

    /**
     * Send a message to the mesh
     */
    async function sendMessage() {
        const textInput = document.getElementById('meshComposeText');
        const channelSelect = document.getElementById('meshComposeChannel');
        const toInput = document.getElementById('meshComposeTo');
        const sendBtn = document.querySelector('.mesh-compose-send');

        const text = textInput?.value.trim();
        if (!text) return;

        const channel = parseInt(channelSelect?.value || '0', 10);
        const toValue = toInput?.value.trim();
        // Convert empty or "^all" to null for broadcast
        const to = (toValue && toValue !== '^all') ? toValue : null;

        // Show sending state immediately
        if (sendBtn) {
            sendBtn.disabled = true;
            sendBtn.classList.add('sending');
        }

        // Optimistically add message to feed immediately
        const localNodeName = nodeInfo?.short_name || nodeInfo?.long_name || null;
        const localNodeIdStr = nodeInfo ? formatNodeId(nodeInfo.num) : '!local';
        const optimisticMsg = {
            type: 'meshtastic',
            from: localNodeIdStr,
            from_name: localNodeName,
            to: to || '^all',
            text: text,
            channel: channel,
            timestamp: Date.now() / 1000,
            portnum: 'TEXT_MESSAGE_APP',
            _pending: true  // Mark as pending
        };

        // Add to messages and render
        messages.push(optimisticMsg);
        prependMessage(optimisticMsg);

        // Clear input immediately for snappy feel
        const sentText = text;
        textInput.value = '';
        updateCharCount();

        try {
            console.log('Sending message:', { text: sentText, channel, to });
            const response = await fetch('/meshtastic/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: sentText, channel, to: to || undefined })
            });

            console.log('Send response status:', response.status);

            if (!response.ok) {
                // HTTP error
                let errorMsg = `HTTP ${response.status}`;
                try {
                    const errData = await response.json();
                    errorMsg = errData.message || errorMsg;
                } catch (e) {
                    // Response wasn't JSON
                }
                throw new Error(errorMsg);
            }

            const data = await response.json();
            console.log('Send response data:', data);

            if (data.status === 'sent') {
                // Mark optimistic message as confirmed
                optimisticMsg._pending = false;
                updatePendingMessage(optimisticMsg, false);
            } else {
                // Mark as failed
                optimisticMsg._failed = true;
                updatePendingMessage(optimisticMsg, true);
                if (typeof showNotification === 'function') {
                    showNotification('Meshtastic', data.message || 'Failed to send');
                }
            }
        } catch (err) {
            console.error('Failed to send message:', err);
            optimisticMsg._failed = true;
            updatePendingMessage(optimisticMsg, true);
            if (typeof showNotification === 'function') {
                showNotification('Meshtastic', 'Send error: ' + err.message);
            }
        } finally {
            if (sendBtn) {
                sendBtn.disabled = false;
                sendBtn.classList.remove('sending');
            }
            textInput?.focus();
        }
    }

    /**
     * Update a pending message's visual state
     */
    function updatePendingMessage(msg, failed) {
        // Find the message card and update its state
        const cards = document.querySelectorAll('.mesh-message-card');
        cards.forEach(card => {
            if (card.dataset.pending === 'true') {
                card.classList.remove('pending');
                card.dataset.pending = 'false';

                // Update the status indicator
                const statusEl = card.querySelector('.mesh-message-status');
                if (statusEl) {
                    if (failed) {
                        statusEl.className = 'mesh-message-status failed';
                        statusEl.textContent = 'Failed';
                    } else {
                        // Remove the status indicator on success
                        statusEl.remove();
                    }
                }

                if (failed) {
                    card.classList.add('failed');
                } else {
                    card.classList.add('sent');
                    // Remove sent indicator after a moment
                    setTimeout(() => card.classList.remove('sent'), 2000);
                }
            }
        });
    }

    /**
     * Update character count display
     */
    function updateCharCount() {
        const input = document.getElementById('meshComposeText');
        const counter = document.getElementById('meshComposeCount');
        if (input && counter) {
            counter.textContent = input.value.length;
        }
    }

    /**
     * Update compose channel dropdown
     */
    function updateComposeChannels() {
        const select = document.getElementById('meshComposeChannel');
        if (!select) return;

        select.innerHTML = channels.map(ch => {
            if (ch.role === 'DISABLED') return '';
            const name = ch.name || (ch.role === 'PRIMARY' ? 'Primary' : `CH ${ch.index}`);
            return `<option value="${ch.index}">${name}</option>`;
        }).filter(Boolean).join('');

        // Default to first channel (usually primary)
        if (channels.length > 0) {
            select.value = channels[0].index;
        }
    }

    // Public API
    /**
     * Toggle main sidebar collapsed state
     */
    /**
     * Toggle the main application sidebar visibility
     */
    function toggleSidebar() {
        const mainContent = document.querySelector('.main-content');
        if (mainContent) {
            mainContent.classList.toggle('mesh-sidebar-hidden');
            // Resize map after sidebar toggle
            setTimeout(() => {
                if (meshMap) meshMap.invalidateSize();
            }, 100);
        }
    }

    /**
     * Toggle the Meshtastic options panel within the sidebar
     */
    function toggleOptionsPanel() {
        const modePanel = document.getElementById('meshtasticMode');
        const icon = document.getElementById('meshSidebarIcon');
        if (modePanel) {
            modePanel.classList.toggle('mesh-sidebar-collapsed');
            if (icon) {
                icon.textContent = modePanel.classList.contains('mesh-sidebar-collapsed') ? '▶' : '▼';
            }
        }
    }

    /**
     * Send traceroute to a node
     */
    async function sendTraceroute(destination) {
        if (!destination) return;

        // Show traceroute modal with loading state
        showTracerouteModal(destination, null, true);

        try {
            const response = await fetch('/meshtastic/traceroute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ destination, hop_limit: 7 })
            });

            const data = await response.json();

            if (data.status === 'sent') {
                // Start polling for results
                pollTracerouteResults(destination);
            } else {
                showTracerouteModal(destination, { error: data.message || 'Failed to send traceroute' }, false);
            }
        } catch (err) {
            console.error('Traceroute error:', err);
            showTracerouteModal(destination, { error: err.message }, false);
        }
    }

    /**
     * Poll for traceroute results
     */
    async function pollTracerouteResults(destination, attempts = 0) {
        const maxAttempts = 30;  // 30 seconds timeout
        const pollInterval = 1000;

        if (attempts >= maxAttempts) {
            showTracerouteModal(destination, { error: 'Traceroute timeout - no response received' }, false);
            return;
        }

        try {
            const response = await fetch('/meshtastic/traceroute/results?limit=5');
            const data = await response.json();

            if (data.status === 'ok' && data.results) {
                // Find result matching our destination
                const result = data.results.find(r => r.destination_id === destination);
                if (result) {
                    showTracerouteModal(destination, result, false);
                    return;
                }
            }

            // Continue polling
            setTimeout(() => pollTracerouteResults(destination, attempts + 1), pollInterval);
        } catch (err) {
            console.error('Error polling traceroute:', err);
            setTimeout(() => pollTracerouteResults(destination, attempts + 1), pollInterval);
        }
    }

    /**
     * Show traceroute modal
     */
    function showTracerouteModal(destination, result, loading) {
        let modal = document.getElementById('meshTracerouteModal');
        if (!modal) return;

        const destEl = document.getElementById('meshTracerouteDest');
        const contentEl = document.getElementById('meshTracerouteContent');

        if (destEl) destEl.textContent = destination;

        if (loading) {
            contentEl.innerHTML = `
                <div class="mesh-traceroute-loading">
                    <div class="mesh-traceroute-spinner"></div>
                    <p>Waiting for traceroute response...</p>
                </div>
            `;
        } else if (result && result.error) {
            contentEl.innerHTML = `
                <div class="mesh-traceroute-error">
                    <p>Error: ${escapeHtml(result.error)}</p>
                </div>
            `;
        } else if (result) {
            contentEl.innerHTML = renderTracerouteVisualization(result);
        }

        modal.classList.add('show');
    }

    /**
     * Close traceroute modal
     */
    function closeTracerouteModal() {
        const modal = document.getElementById('meshTracerouteModal');
        if (modal) modal.classList.remove('show');
    }

    /**
     * Render traceroute visualization
     */
    function renderTracerouteVisualization(result) {
        if (!result.route || result.route.length === 0) {
            if (result.route_back && result.route_back.length > 0) {
                // Only have return path - show it
                return renderRoutePath('Return Path', result.route_back, result.snr_back);
            }
            return '<p style="color: var(--text-dim);">Direct connection (no intermediate hops)</p>';
        }

        let html = '';

        // Forward route
        if (result.route && result.route.length > 0) {
            html += renderRoutePath('Forward Path', result.route, result.snr_towards);
        }

        // Return route
        if (result.route_back && result.route_back.length > 0) {
            html += renderRoutePath('Return Path', result.route_back, result.snr_back);
        }

        // Timestamp
        if (result.timestamp) {
            html += `<div class="mesh-traceroute-timestamp">Completed: ${new Date(result.timestamp).toLocaleString()}</div>`;
        }

        return html;
    }

    /**
     * Render a single route path
     */
    function renderRoutePath(label, route, snrValues) {
        let html = `<div class="mesh-traceroute-section">
            <div class="mesh-traceroute-label">${label}</div>
            <div class="mesh-traceroute-path">`;

        route.forEach((nodeId, index) => {
            // Look up node name if available
            const nodeName = lookupNodeName(nodeId) || nodeId.slice(-4);
            const snr = snrValues && snrValues[index] !== undefined ? snrValues[index] : null;
            const snrClass = snr !== null ? getSnrClass(snr) : '';

            html += `<div class="mesh-traceroute-hop">
                <div class="mesh-traceroute-hop-node">${escapeHtml(nodeName)}</div>
                <div class="mesh-traceroute-hop-id">${nodeId}</div>
                ${snr !== null ? `<div class="mesh-traceroute-snr ${snrClass}">${snr.toFixed(1)} dB</div>` : ''}
            </div>`;

            // Add arrow between hops
            if (index < route.length - 1) {
                html += '<div class="mesh-traceroute-arrow">→</div>';
            }
        });

        html += '</div></div>';
        return html;
    }

    /**
     * Get SNR quality class
     */
    function getSnrClass(snr) {
        if (snr >= 10) return 'snr-good';
        if (snr >= 0) return 'snr-ok';
        if (snr >= -10) return 'snr-poor';
        return 'snr-bad';
    }

    /**
     * Look up node name from our tracked nodes
     */
    function lookupNodeName(nodeId) {
        // This would ideally look up from our cached nodes
        // For now, return null to use ID
        return null;
    }

    return {
        init,
        start,
        stop,
        loadPorts,
        refreshChannels,
        openChannelModal,
        closeChannelModal,
        onPskFormatChange,
        saveChannelConfig,
        applyFilter,
        showHelp,
        closeHelp,
        sendMessage,
        updateCharCount,
        invalidateMap,
        handleComposeKeydown,
        toggleSidebar,
        toggleOptionsPanel,
        sendTraceroute,
        closeTracerouteModal
    };

    /**
     * Invalidate the map size (call after container resize)
     */
    function invalidateMap() {
        if (meshMap) {
            setTimeout(() => meshMap.invalidateSize(), 100);
        }
    }
})();

// Initialize when DOM is ready (will be called by selectMode)
document.addEventListener('DOMContentLoaded', function() {
    // Initialization happens via selectMode when Meshtastic mode is activated
});
