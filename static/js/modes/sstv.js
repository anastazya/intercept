/**
 * SSTV Mode
 * ISS Slow-Scan Television decoder interface
 */

const SSTV = (function() {
    // State
    let isRunning = false;
    let eventSource = null;
    let images = [];
    let currentMode = null;
    let progress = 0;
    let globeAnimationId = null;
    let issPosition = null;
    let issUpdateInterval = null;

    // ISS frequency
    const ISS_FREQ = 145.800;

    /**
     * Initialize the SSTV mode
     */
    function init() {
        checkStatus();
        loadImages();
        loadLocationInputs();
        loadIssSchedule();
        initGlobe();
        startIssTracking();
    }

    /**
     * Load location into input fields
     */
    function loadLocationInputs() {
        const latInput = document.getElementById('sstvObsLat');
        const lonInput = document.getElementById('sstvObsLon');

        const storedLat = localStorage.getItem('observerLat');
        const storedLon = localStorage.getItem('observerLon');

        if (latInput && storedLat) latInput.value = storedLat;
        if (lonInput && storedLon) lonInput.value = storedLon;

        // Add change handlers to save and refresh
        if (latInput) latInput.addEventListener('change', saveLocationFromInputs);
        if (lonInput) lonInput.addEventListener('change', saveLocationFromInputs);
    }

    /**
     * Save location from input fields
     */
    function saveLocationFromInputs() {
        const latInput = document.getElementById('sstvObsLat');
        const lonInput = document.getElementById('sstvObsLon');

        const lat = parseFloat(latInput?.value);
        const lon = parseFloat(lonInput?.value);

        if (!isNaN(lat) && lat >= -90 && lat <= 90 &&
            !isNaN(lon) && lon >= -180 && lon <= 180) {
            localStorage.setItem('observerLat', lat.toString());
            localStorage.setItem('observerLon', lon.toString());
            loadIssSchedule(); // Refresh pass predictions
        }
    }

    /**
     * Use GPS to get location
     */
    function useGPS(btn) {
        if (!navigator.geolocation) {
            showNotification('SSTV', 'GPS not available in this browser');
            return;
        }

        const originalText = btn.innerHTML;
        btn.innerHTML = '<span style="opacity: 0.7;">...</span>';
        btn.disabled = true;

        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const latInput = document.getElementById('sstvObsLat');
                const lonInput = document.getElementById('sstvObsLon');

                const lat = pos.coords.latitude.toFixed(4);
                const lon = pos.coords.longitude.toFixed(4);

                if (latInput) latInput.value = lat;
                if (lonInput) lonInput.value = lon;

                localStorage.setItem('observerLat', lat);
                localStorage.setItem('observerLon', lon);

                btn.innerHTML = originalText;
                btn.disabled = false;

                showNotification('SSTV', 'Location updated from GPS');
                loadIssSchedule();
            },
            (err) => {
                btn.innerHTML = originalText;
                btn.disabled = false;

                let msg = 'Failed to get location';
                if (err.code === 1) msg = 'Location access denied';
                else if (err.code === 2) msg = 'Location unavailable';
                showNotification('SSTV', msg);
            },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    }

    /**
     * Update TLE data from CelesTrak
     */
    async function updateTLE(btn) {
        const originalText = btn.innerHTML;
        btn.innerHTML = '<span style="opacity: 0.7;">Updating...</span>';
        btn.disabled = true;

        try {
            const response = await fetch('/satellite/update-tle', { method: 'POST' });
            const data = await response.json();

            if (data.status === 'success') {
                showNotification('SSTV', `TLE updated: ${data.updated?.length || 0} satellites`);
                loadIssSchedule(); // Refresh predictions with new TLE
            } else {
                showNotification('SSTV', data.message || 'TLE update failed');
            }
        } catch (err) {
            console.error('TLE update error:', err);
            showNotification('SSTV', 'Failed to update TLE');
        }

        btn.innerHTML = originalText;
        btn.disabled = false;
    }

    /**
     * Initialize 3D globe
     */
    function initGlobe() {
        const canvas = document.getElementById('sstvGlobe');
        if (!canvas) return;

        renderGlobe();
    }

    /**
     * Start ISS position tracking
     */
    function startIssTracking() {
        updateIssPosition();
        // Update every 5 seconds
        if (issUpdateInterval) clearInterval(issUpdateInterval);
        issUpdateInterval = setInterval(updateIssPosition, 5000);
    }

    /**
     * Stop ISS tracking
     */
    function stopIssTracking() {
        if (issUpdateInterval) {
            clearInterval(issUpdateInterval);
            issUpdateInterval = null;
        }
        if (globeAnimationId) {
            cancelAnimationFrame(globeAnimationId);
            globeAnimationId = null;
        }
    }

    /**
     * Fetch current ISS position
     */
    async function updateIssPosition() {
        const storedLat = localStorage.getItem('observerLat') || '51.5074';
        const storedLon = localStorage.getItem('observerLon') || '-0.1278';

        try {
            const url = `/sstv/iss-position?latitude=${storedLat}&longitude=${storedLon}`;
            const response = await fetch(url);
            const data = await response.json();

            if (data.status === 'ok') {
                issPosition = data;
                updateIssDisplay();
                renderGlobe();
                console.log('ISS position updated:', data.lat.toFixed(1), data.lon.toFixed(1));
            } else {
                console.warn('ISS position error:', data.message);
            }
        } catch (err) {
            console.error('Failed to get ISS position:', err);
        }
    }

    /**
     * Update ISS position display
     */
    function updateIssDisplay() {
        if (!issPosition) return;

        const latEl = document.getElementById('sstvIssLat');
        const lonEl = document.getElementById('sstvIssLon');
        const altEl = document.getElementById('sstvIssAlt');

        if (latEl) latEl.textContent = issPosition.lat.toFixed(1) + '°';
        if (lonEl) lonEl.textContent = issPosition.lon.toFixed(1) + '°';
        if (altEl) altEl.textContent = Math.round(issPosition.altitude);
    }

    // Accurate world map continent outlines (lon, lat pairs)
    const continents = {
        // North America mainland
        northAmerica: [
            [-168, 66], [-166, 62], [-164, 60], [-160, 59], [-152, 60], [-146, 61],
            [-141, 60], [-139, 60], [-137, 59], [-135, 56], [-133, 55], [-130, 54],
            [-127, 51], [-124, 48], [-124, 42], [-120, 39], [-117, 33], [-114, 31],
            [-110, 31], [-108, 31], [-105, 29], [-101, 26], [-97, 26], [-97, 28],
            [-94, 29], [-90, 29], [-89, 30], [-85, 29], [-83, 29], [-81, 25],
            [-80, 25], [-81, 28], [-81, 31], [-77, 35], [-75, 36], [-75, 38],
            [-73, 41], [-70, 42], [-70, 44], [-67, 45], [-66, 44], [-64, 46],
            [-61, 47], [-64, 52], [-59, 48], [-55, 52], [-57, 58], [-62, 58],
            [-68, 60], [-73, 62], [-77, 64], [-78, 69], [-85, 70], [-95, 70],
            [-102, 72], [-115, 72], [-125, 72], [-135, 70], [-145, 70], [-155, 71],
            [-165, 68], [-168, 66]
        ],
        // Greenland
        greenland: [
            [-45, 60], [-43, 60], [-40, 62], [-38, 65], [-30, 68], [-25, 72],
            [-20, 76], [-22, 80], [-35, 83], [-50, 82], [-60, 78], [-68, 76],
            [-72, 73], [-60, 70], [-52, 66], [-48, 62], [-45, 60]
        ],
        // Central America
        centralAmerica: [
            [-97, 26], [-97, 22], [-95, 19], [-92, 18], [-90, 16], [-88, 16],
            [-86, 14], [-84, 11], [-82, 9], [-79, 8], [-77, 9], [-80, 9],
            [-83, 10], [-86, 12], [-88, 14], [-90, 15], [-92, 16], [-95, 17],
            [-97, 20], [-97, 26]
        ],
        // South America
        southAmerica: [
            [-79, 8], [-77, 9], [-73, 11], [-72, 12], [-67, 11], [-63, 10],
            [-60, 8], [-57, 6], [-52, 5], [-50, 2], [-50, 0], [-48, -2],
            [-44, -3], [-39, -4], [-35, -7], [-35, -10], [-37, -13], [-39, -18],
            [-41, -22], [-44, -23], [-47, -24], [-49, -29], [-52, -33], [-54, -34],
            [-57, -38], [-62, -39], [-65, -41], [-66, -45], [-66, -52], [-68, -55],
            [-72, -53], [-74, -50], [-75, -47], [-75, -41], [-73, -37], [-71, -33],
            [-71, -29], [-70, -24], [-70, -18], [-75, -15], [-76, -12], [-81, -6],
            [-81, -2], [-80, 1], [-79, 8]
        ],
        // UK and Ireland
        ukIreland: [
            [-10, 51], [-9, 52], [-10, 54], [-8, 55], [-6, 55], [-6, 58],
            [-3, 59], [0, 58], [2, 53], [1, 51], [-2, 50], [-5, 50], [-6, 52],
            [-10, 51]
        ],
        // Iceland
        iceland: [
            [-24, 64], [-22, 66], [-18, 66], [-14, 65], [-14, 64], [-18, 63],
            [-22, 64], [-24, 64]
        ],
        // Europe mainland
        europe: [
            [-10, 36], [-9, 38], [-9, 43], [-2, 44], [3, 43], [4, 44], [1, 46],
            [-2, 47], [-5, 48], [-3, 49], [2, 51], [4, 52], [7, 54], [8, 55],
            [12, 55], [14, 54], [19, 55], [23, 55], [28, 56], [28, 60], [24, 60],
            [23, 64], [26, 66], [25, 70], [21, 70], [18, 69], [15, 69], [11, 64],
            [12, 58], [10, 58], [8, 58], [6, 58], [5, 62], [7, 65], [15, 69],
            [25, 71], [30, 70], [28, 66], [31, 65], [29, 60], [32, 55], [40, 55],
            [50, 55], [60, 55], [68, 56], [70, 66], [60, 70], [50, 68], [40, 67],
            [32, 70], [28, 70], [25, 71], [21, 70], [17, 68], [10, 64], [12, 56],
            [8, 54], [5, 54], [4, 52], [2, 51], [-3, 49], [-5, 48], [-2, 47],
            [1, 46], [4, 44], [3, 43], [-2, 44], [-9, 43], [-9, 41], [-8, 40],
            [-9, 38], [-7, 37], [-6, 37], [-5, 36], [-2, 36], [0, 38], [3, 42],
            [6, 43], [8, 44], [13, 44], [14, 42], [16, 41], [14, 38], [12, 38],
            [15, 37], [18, 40], [20, 40], [24, 38], [26, 39], [28, 41], [26, 42],
            [29, 45], [22, 45], [20, 42], [16, 42], [14, 44], [10, 46], [7, 46],
            [7, 48], [10, 48], [15, 47], [17, 49], [15, 51], [14, 53], [10, 54],
            [7, 54], [4, 52]
        ],
        // Scandinavia (simplified)
        scandinavia: [
            [5, 58], [6, 62], [8, 64], [14, 66], [18, 68], [20, 70], [28, 71],
            [31, 70], [30, 67], [27, 65], [24, 60], [18, 60], [16, 57], [11, 56],
            [8, 56], [5, 58]
        ],
        // Africa
        africa: [
            [-17, 21], [-17, 15], [-16, 13], [-15, 11], [-8, 5], [-5, 5],
            [0, 5], [2, 6], [10, 4], [10, 1], [9, -1], [12, -5], [14, -5],
            [17, -12], [23, -18], [26, -23], [28, -28], [28, -33], [23, -35],
            [18, -34], [16, -29], [14, -22], [12, -17], [14, -10], [20, -3],
            [30, 5], [35, 5], [42, 11], [44, 11], [49, 12], [51, 11], [43, 5],
            [41, -2], [40, -10], [36, -20], [33, -26], [28, -33], [23, -35],
            [18, -34], [16, -29], [13, -25], [10, -18], [9, -6], [5, 4],
            [-5, 5], [-10, 8], [-17, 15], [-17, 21], [-13, 24], [-8, 28],
            [-2, 35], [3, 37], [10, 37], [11, 34], [9, 31], [10, 28], [17, 32],
            [25, 32], [32, 31], [35, 32], [36, 30], [33, 27], [35, 22], [43, 13],
            [42, 11], [35, 5], [33, 10], [31, 10], [30, 5], [20, -3], [14, -10],
            [12, -17], [17, -12], [14, -5], [12, -5], [9, -1], [10, 1], [10, 4],
            [2, 6], [0, 5], [-5, 5], [-8, 5], [-15, 11], [-16, 13], [-17, 15],
            [-17, 21]
        ],
        // Madagascar
        madagascar: [
            [50, -12], [50, -16], [47, -24], [44, -25], [44, -20], [47, -15],
            [49, -12], [50, -12]
        ],
        // Middle East / Arabian Peninsula
        middleEast: [
            [35, 32], [36, 30], [40, 29], [48, 30], [52, 26], [56, 25], [57, 21],
            [55, 17], [52, 13], [44, 13], [43, 13], [35, 22], [33, 27], [35, 32]
        ],
        // Asia mainland
        asia: [
            [60, 55], [70, 55], [80, 55], [90, 55], [100, 55], [110, 55], [120, 53],
            [130, 48], [135, 45], [135, 42], [130, 43], [123, 40], [120, 35],
            [117, 30], [118, 25], [118, 22], [110, 20], [108, 22], [107, 17],
            [103, 10], [100, 14], [99, 7], [104, 2], [104, -2], [117, -8],
            [120, -10], [115, -8], [107, -6], [105, -6], [106, -2], [103, 1],
            [99, 7], [100, 14], [103, 10], [105, 12], [107, 17], [108, 22],
            [105, 22], [102, 22], [98, 24], [90, 22], [89, 26], [92, 28],
            [88, 28], [84, 28], [80, 30], [77, 35], [72, 37], [68, 37],
            [60, 40], [52, 42], [50, 46], [55, 50], [60, 55]
        ],
        // India
        india: [
            [68, 24], [70, 22], [72, 21], [73, 17], [75, 12], [77, 8], [80, 10],
            [80, 14], [83, 15], [86, 20], [90, 22], [89, 26], [88, 28], [84, 28],
            [80, 30], [77, 30], [75, 25], [72, 25], [68, 24]
        ],
        // Southeast Asia
        southeastAsia: [
            [100, 14], [103, 10], [105, 12], [107, 17], [108, 22], [105, 22],
            [102, 22], [98, 24], [98, 19], [100, 14]
        ],
        // Japan
        japan: [
            [130, 32], [131, 34], [135, 35], [137, 37], [140, 38], [141, 41],
            [141, 43], [145, 44], [145, 42], [142, 39], [140, 36], [137, 35],
            [135, 34], [130, 32]
        ],
        // Korea
        korea: [
            [126, 34], [126, 38], [129, 38], [130, 43], [128, 42], [124, 40],
            [125, 37], [126, 34]
        ],
        // Philippines
        philippines: [
            [117, 7], [120, 10], [122, 13], [124, 17], [122, 19], [120, 16],
            [118, 12], [117, 7]
        ],
        // Indonesia (simplified)
        indonesia: [
            [95, 6], [98, 4], [103, 1], [106, -2], [106, -6], [110, -7],
            [115, -8], [120, -10], [127, -8], [131, -2], [136, -2], [141, -5],
            [141, -9], [131, -8], [120, -10], [115, -8], [110, -7], [106, -6],
            [106, -2], [103, 1], [98, 4], [95, 6]
        ],
        // Australia
        australia: [
            [114, -22], [114, -26], [115, -32], [117, -35], [122, -34], [129, -32],
            [132, -32], [134, -33], [137, -35], [140, -38], [144, -38], [147, -38],
            [150, -37], [153, -29], [153, -25], [149, -21], [145, -15], [142, -11],
            [136, -12], [130, -15], [129, -17], [123, -17], [119, -20], [114, -22]
        ],
        // New Zealand
        newZealand: [
            [166, -46], [168, -45], [171, -41], [175, -37], [178, -37], [178, -42],
            [174, -41], [170, -43], [167, -44], [166, -46]
        ],
        // Taiwan
        taiwan: [
            [120, 22], [121, 23], [122, 25], [121, 25], [120, 24], [120, 22]
        ],
        // Sri Lanka
        sriLanka: [
            [80, 6], [80, 8], [82, 10], [82, 7], [80, 6]
        ]
    };

    /**
     * Project lat/lon to x/y on globe with rotation
     */
    function projectPoint(lat, lon, cx, cy, radius, rotation) {
        const lonRad = (lon + rotation) * Math.PI / 180;
        const latRad = lat * Math.PI / 180;

        // Check if point is on visible hemisphere
        const x3d = Math.cos(latRad) * Math.sin(lonRad);
        const z3d = Math.cos(latRad) * Math.cos(lonRad);

        if (z3d < 0) return null; // Behind globe

        const x = cx + x3d * radius;
        const y = cy - Math.sin(latRad) * radius;

        return { x, y, z: z3d };
    }

    /**
     * Render 3D globe with ISS position and world map
     */
    function renderGlobe() {
        const canvas = document.getElementById('sstvGlobe');
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const radius = Math.min(cx, cy) - 10;

        // Globe rotation - center on ISS longitude if available
        const globeRotation = issPosition ? -issPosition.lon : 0;

        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw ocean background
        const oceanGradient = ctx.createRadialGradient(cx - radius * 0.3, cy - radius * 0.3, 0, cx, cy, radius);
        oceanGradient.addColorStop(0, '#1a5a8e');
        oceanGradient.addColorStop(0.5, '#0d3a5a');
        oceanGradient.addColorStop(1, '#061828');

        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fillStyle = oceanGradient;
        ctx.fill();

        // Draw continents
        ctx.fillStyle = 'rgba(34, 139, 87, 0.7)';
        ctx.strokeStyle = 'rgba(50, 180, 120, 0.8)';
        ctx.lineWidth = 1;

        for (const [name, coords] of Object.entries(continents)) {
            ctx.beginPath();
            let started = false;
            let lastVisible = false;

            for (let i = 0; i < coords.length; i++) {
                const [lon, lat] = coords[i];
                const point = projectPoint(lat, lon, cx, cy, radius, globeRotation);

                if (point) {
                    if (!started || !lastVisible) {
                        ctx.moveTo(point.x, point.y);
                        started = true;
                    } else {
                        ctx.lineTo(point.x, point.y);
                    }
                    lastVisible = true;
                } else {
                    lastVisible = false;
                }
            }

            ctx.fill();
            ctx.stroke();
        }

        // Draw latitude/longitude grid
        ctx.strokeStyle = 'rgba(0, 212, 255, 0.2)';
        ctx.lineWidth = 0.5;

        // Latitude lines
        for (let lat = -60; lat <= 60; lat += 30) {
            ctx.beginPath();
            for (let lon = -180; lon <= 180; lon += 5) {
                const point = projectPoint(lat, lon, cx, cy, radius, globeRotation);
                if (point) {
                    if (lon === -180 || !projectPoint(lat, lon - 5, cx, cy, radius, globeRotation)) {
                        ctx.moveTo(point.x, point.y);
                    } else {
                        ctx.lineTo(point.x, point.y);
                    }
                }
            }
            ctx.stroke();
        }

        // Longitude lines
        for (let lon = -180; lon < 180; lon += 30) {
            ctx.beginPath();
            for (let lat = -90; lat <= 90; lat += 5) {
                const point = projectPoint(lat, lon, cx, cy, radius, globeRotation);
                if (point) {
                    if (lat === -90 || !projectPoint(lat - 5, lon, cx, cy, radius, globeRotation)) {
                        ctx.moveTo(point.x, point.y);
                    } else {
                        ctx.lineTo(point.x, point.y);
                    }
                }
            }
            ctx.stroke();
        }

        // Draw ISS position
        if (issPosition) {
            const issLat = issPosition.lat;
            const issLon = issPosition.lon;
            // Project ISS using same rotation as continents
            const point = projectPoint(issLat, issLon, cx, cy, radius, globeRotation);

            if (point) {
                const x = point.x;
                const y = point.y;

                // ISS orbit trail (where it's been)
                // ISS orbit is inclined at 51.6 degrees
                ctx.strokeStyle = 'rgba(0, 212, 255, 0.3)';
                ctx.lineWidth = 2;
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                let trailStarted = false;
                for (let offset = -60; offset <= 0; offset += 3) {
                    // Calculate trail position accounting for orbital inclination
                    const trailLon = issLon + offset;
                    // Approximate latitude change based on orbit inclination (51.6°)
                    const orbitPhase = (offset / 360) * 2 * Math.PI;
                    const trailLat = issLat - Math.sin(orbitPhase) * 20;
                    const trailPoint = projectPoint(trailLat, trailLon, cx, cy, radius, globeRotation);
                    if (trailPoint) {
                        if (!trailStarted) {
                            ctx.moveTo(trailPoint.x, trailPoint.y);
                            trailStarted = true;
                        } else {
                            ctx.lineTo(trailPoint.x, trailPoint.y);
                        }
                    }
                }
                ctx.stroke();
                ctx.setLineDash([]);

                // ISS glow
                const issGradient = ctx.createRadialGradient(x, y, 0, x, y, 25);
                issGradient.addColorStop(0, 'rgba(255, 200, 0, 0.9)');
                issGradient.addColorStop(0.3, 'rgba(255, 150, 0, 0.5)');
                issGradient.addColorStop(1, 'rgba(255, 100, 0, 0)');

                ctx.beginPath();
                ctx.arc(x, y, 25, 0, Math.PI * 2);
                ctx.fillStyle = issGradient;
                ctx.fill();

                // ISS dot
                ctx.beginPath();
                ctx.arc(x, y, 6, 0, Math.PI * 2);
                ctx.fillStyle = '#ffcc00';
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();

                // ISS label
                ctx.fillStyle = '#ffcc00';
                ctx.font = 'bold 10px JetBrains Mono, monospace';
                ctx.textAlign = 'center';
                ctx.fillText('ISS', x, y - 18);
            }
        }

        // Draw globe edge highlight
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0, 212, 255, 0.5)';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Atmospheric glow
        const atmoGradient = ctx.createRadialGradient(cx, cy, radius - 5, cx, cy, radius + 12);
        atmoGradient.addColorStop(0, 'rgba(100, 180, 255, 0)');
        atmoGradient.addColorStop(0.5, 'rgba(100, 180, 255, 0.15)');
        atmoGradient.addColorStop(1, 'rgba(100, 180, 255, 0)');

        ctx.beginPath();
        ctx.arc(cx, cy, radius + 12, 0, Math.PI * 2);
        ctx.fillStyle = atmoGradient;
        ctx.fill();
    }

    /**
     * Check current decoder status
     */
    async function checkStatus() {
        try {
            const response = await fetch('/sstv/status');
            const data = await response.json();

            if (!data.available) {
                updateStatusUI('unavailable', 'Decoder not installed');
                showStatusMessage('SSTV decoder not available. Install slowrx: apt install slowrx', 'warning');
                return;
            }

            if (data.running) {
                isRunning = true;
                updateStatusUI('listening', 'Listening...');
                startStream();
            } else {
                updateStatusUI('idle', 'Idle');
            }

            // Update image count
            updateImageCount(data.image_count || 0);
        } catch (err) {
            console.error('Failed to check SSTV status:', err);
        }
    }

    /**
     * Start SSTV decoder
     */
    async function start() {
        const freqInput = document.getElementById('sstvFrequency');
        const deviceSelect = document.getElementById('sstvDevice');

        const frequency = parseFloat(freqInput?.value || ISS_FREQ);
        const device = parseInt(deviceSelect?.value || '0', 10);

        updateStatusUI('connecting', 'Starting...');

        try {
            const response = await fetch('/sstv/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ frequency, device })
            });

            const data = await response.json();

            if (data.status === 'started' || data.status === 'already_running') {
                isRunning = true;
                updateStatusUI('listening', `${frequency} MHz`);
                startStream();
                showNotification('SSTV', `Listening on ${frequency} MHz`);
            } else {
                updateStatusUI('idle', 'Start failed');
                showStatusMessage(data.message || 'Failed to start decoder', 'error');
            }
        } catch (err) {
            console.error('Failed to start SSTV:', err);
            updateStatusUI('idle', 'Error');
            showStatusMessage('Connection error: ' + err.message, 'error');
        }
    }

    /**
     * Stop SSTV decoder
     */
    async function stop() {
        try {
            await fetch('/sstv/stop', { method: 'POST' });
            isRunning = false;
            stopStream();
            updateStatusUI('idle', 'Stopped');
            showNotification('SSTV', 'Decoder stopped');
        } catch (err) {
            console.error('Failed to stop SSTV:', err);
        }
    }

    /**
     * Update status UI elements
     */
    function updateStatusUI(status, text) {
        const dot = document.getElementById('sstvStripDot');
        const statusText = document.getElementById('sstvStripStatus');
        const startBtn = document.getElementById('sstvStartBtn');
        const stopBtn = document.getElementById('sstvStopBtn');

        if (dot) {
            dot.className = 'sstv-strip-dot';
            if (status === 'listening' || status === 'detecting') {
                dot.classList.add('listening');
            } else if (status === 'decoding') {
                dot.classList.add('decoding');
            } else {
                dot.classList.add('idle');
            }
        }

        if (statusText) {
            statusText.textContent = text || status;
        }

        if (startBtn && stopBtn) {
            if (status === 'listening' || status === 'decoding') {
                startBtn.style.display = 'none';
                stopBtn.style.display = 'inline-block';
            } else {
                startBtn.style.display = 'inline-block';
                stopBtn.style.display = 'none';
            }
        }

        // Update live content area
        const liveContent = document.getElementById('sstvLiveContent');
        if (liveContent) {
            if (status === 'idle' || status === 'unavailable') {
                liveContent.innerHTML = renderIdleState();
            }
        }
    }

    /**
     * Render idle state HTML
     */
    function renderIdleState() {
        return `
            <div class="sstv-idle-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M3 9h2M19 9h2M3 15h2M19 15h2"/>
                </svg>
                <h4>ISS SSTV Decoder</h4>
                <p>Click Start to listen for SSTV transmissions on 145.800 MHz</p>
            </div>
        `;
    }

    /**
     * Start SSE stream
     */
    function startStream() {
        if (eventSource) {
            eventSource.close();
        }

        eventSource = new EventSource('/sstv/stream');

        eventSource.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.type === 'sstv_progress') {
                    handleProgress(data);
                }
            } catch (err) {
                console.error('Failed to parse SSE message:', err);
            }
        };

        eventSource.onerror = () => {
            console.warn('SSTV SSE error, will reconnect...');
            setTimeout(() => {
                if (isRunning) startStream();
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
     * Handle progress update
     */
    function handleProgress(data) {
        currentMode = data.mode || currentMode;
        progress = data.progress || 0;

        // Update status based on decode state
        if (data.status === 'decoding') {
            updateStatusUI('decoding', `Decoding ${currentMode || 'image'}...`);
            renderDecodeProgress(data);
        } else if (data.status === 'complete' && data.image) {
            // New image decoded
            images.unshift(data.image);
            updateImageCount(images.length);
            renderGallery();
            showNotification('SSTV', 'New image decoded!');
            updateStatusUI('listening', 'Listening...');
        } else if (data.status === 'detecting') {
            updateStatusUI('listening', data.message || 'Listening...');
        }
    }

    /**
     * Render decode progress in live area
     */
    function renderDecodeProgress(data) {
        const liveContent = document.getElementById('sstvLiveContent');
        if (!liveContent) return;

        liveContent.innerHTML = `
            <div class="sstv-canvas-container">
                <canvas id="sstvCanvas" width="320" height="256"></canvas>
            </div>
            <div class="sstv-decode-info">
                <div class="sstv-mode-label">${data.mode || 'Detecting mode...'}</div>
                <div class="sstv-progress-bar">
                    <div class="progress" style="width: ${data.progress || 0}%"></div>
                </div>
                <div class="sstv-status-message">${data.message || 'Decoding...'}</div>
            </div>
        `;
    }

    /**
     * Load decoded images
     */
    async function loadImages() {
        try {
            const response = await fetch('/sstv/images');
            const data = await response.json();

            if (data.status === 'ok') {
                images = data.images || [];
                updateImageCount(images.length);
                renderGallery();
            }
        } catch (err) {
            console.error('Failed to load SSTV images:', err);
        }
    }

    /**
     * Update image count display
     */
    function updateImageCount(count) {
        const countEl = document.getElementById('sstvImageCount');
        const stripCount = document.getElementById('sstvStripImageCount');

        if (countEl) countEl.textContent = count;
        if (stripCount) stripCount.textContent = count;
    }

    /**
     * Render image gallery
     */
    function renderGallery() {
        const gallery = document.getElementById('sstvGallery');
        if (!gallery) return;

        if (images.length === 0) {
            gallery.innerHTML = `
                <div class="sstv-gallery-empty">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="3" width="18" height="18" rx="2"/>
                        <circle cx="8.5" cy="8.5" r="1.5"/>
                        <polyline points="21 15 16 10 5 21"/>
                    </svg>
                    <p>No images decoded yet</p>
                </div>
            `;
            return;
        }

        gallery.innerHTML = images.map(img => `
            <div class="sstv-image-card" onclick="SSTV.showImage('${escapeHtml(img.url)}')">
                <img src="${escapeHtml(img.url)}" alt="SSTV Image" class="sstv-image-preview" loading="lazy">
                <div class="sstv-image-info">
                    <div class="sstv-image-mode">${escapeHtml(img.mode || 'Unknown')}</div>
                    <div class="sstv-image-timestamp">${formatTimestamp(img.timestamp)}</div>
                </div>
            </div>
        `).join('');
    }

    /**
     * Load ISS pass schedule
     */
    async function loadIssSchedule() {
        // Try to get user's location from settings
        const storedLat = localStorage.getItem('observerLat');
        const storedLon = localStorage.getItem('observerLon');

        // Check if location is actually set
        const hasLocation = storedLat !== null && storedLon !== null;
        const lat = storedLat || 51.5074;
        const lon = storedLon || -0.1278;

        try {
            const response = await fetch(`/sstv/iss-schedule?latitude=${lat}&longitude=${lon}&hours=48`);
            const data = await response.json();

            if (data.status === 'ok' && data.passes && data.passes.length > 0) {
                renderIssInfo(data.passes[0], hasLocation);
            } else {
                renderIssInfo(null, hasLocation);
            }
        } catch (err) {
            console.error('Failed to load ISS schedule:', err);
            renderIssInfo(null, hasLocation);
        }
    }

    /**
     * Render ISS pass info
     */
    function renderIssInfo(nextPass, hasLocation = true) {
        const container = document.getElementById('sstvIssInfo');
        if (!container) return;

        if (!nextPass) {
            const locationMsg = hasLocation
                ? 'No passes in next 48 hours'
                : 'Set location in Settings > Location tab';
            const noteMsg = hasLocation
                ? 'Check ARISS.org for SSTV event schedules'
                : 'Click the gear icon to open Settings';

            container.innerHTML = `
                <div class="sstv-iss-info">
                    <svg class="sstv-iss-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M13 7L9 3 5 7l4 4"/>
                        <path d="m17 11 4 4-4 4-4-4"/>
                        <path d="m8 12 4 4 6-6-4-4-6 6"/>
                    </svg>
                    <div class="sstv-iss-details">
                        <div class="sstv-iss-label">Next ISS Pass</div>
                        <div class="sstv-iss-value">${locationMsg}</div>
                        <div class="sstv-iss-note">${noteMsg}</div>
                    </div>
                </div>
            `;
            return;
        }

        container.innerHTML = `
            <div class="sstv-iss-info">
                <svg class="sstv-iss-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M13 7L9 3 5 7l4 4"/>
                    <path d="m17 11 4 4-4 4-4-4"/>
                    <path d="m8 12 4 4 6-6-4-4-6 6"/>
                </svg>
                <div class="sstv-iss-details">
                    <div class="sstv-iss-label">Next ISS Pass</div>
                    <div class="sstv-iss-value">${nextPass.startTime} (${nextPass.maxEl}° max elevation)</div>
                    <div class="sstv-iss-note">Duration: ${nextPass.duration} min | Check ARISS.org for SSTV events</div>
                </div>
            </div>
        `;
    }

    /**
     * Show full-size image in modal
     */
    function showImage(url) {
        let modal = document.getElementById('sstvImageModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'sstvImageModal';
            modal.className = 'sstv-image-modal';
            modal.innerHTML = `
                <button class="sstv-modal-close" onclick="SSTV.closeImage()">&times;</button>
                <img src="" alt="SSTV Image">
            `;
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeImage();
            });
            document.body.appendChild(modal);
        }

        modal.querySelector('img').src = url;
        modal.classList.add('show');
    }

    /**
     * Close image modal
     */
    function closeImage() {
        const modal = document.getElementById('sstvImageModal');
        if (modal) modal.classList.remove('show');
    }

    /**
     * Format timestamp for display
     */
    function formatTimestamp(isoString) {
        if (!isoString) return '--';
        try {
            const date = new Date(isoString);
            return date.toLocaleString();
        } catch {
            return isoString;
        }
    }

    /**
     * Escape HTML for safe display
     */
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Show status message
     */
    function showStatusMessage(message, type) {
        if (typeof showNotification === 'function') {
            showNotification('SSTV', message);
        } else {
            console.log(`[SSTV ${type}] ${message}`);
        }
    }

    // Public API
    return {
        init,
        start,
        stop,
        loadImages,
        loadIssSchedule,
        showImage,
        closeImage,
        useGPS,
        updateTLE,
        stopIssTracking
    };
})();

// Initialize when DOM is ready (will be called by selectMode)
document.addEventListener('DOMContentLoaded', function() {
    // Initialization happens via selectMode when SSTV mode is activated
});
