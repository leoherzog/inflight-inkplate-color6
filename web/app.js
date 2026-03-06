// ── Constants ──────────────────────────────────────────────────────────────────

const SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0';
const CMD_UUID     = '12345678-1234-5678-1234-56789abcdef1';
const DATA_UUID    = '12345678-1234-5678-1234-56789abcdef2';

const WIDTH = 600, HEIGHT = 448;
const CHUNK_SIZE = 500;

// 7-color ACeP e-ink palette
const PALETTE = [
    [0,   0,   0],    // 0 Black
    [255, 255, 255],  // 1 White
    [0,   128, 0],    // 2 Green
    [0,   0,   128],  // 3 Blue
    [196, 0,   0],    // 4 Red
    [255, 255, 0],    // 5 Yellow
    [255, 128, 0],    // 6 Orange
];

// ── CIELAB Color Distance ────────────────────────────────────────────────────

function srgbToLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function rgbToLab(r, g, b) {
    const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
    let x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
    let y =  0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb;
    let z = (0.0193339 * lr + 0.1191920 * lg + 0.9503041 * lb) / 1.08883;
    const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

const PALETTE_LAB = PALETTE.map(c => rgbToLab(c[0], c[1], c[2]));

// ── Saturation / Contrast Pre-boost ─────────────────────────────────────────

function boostSaturationContrast(imageData, satMul = 2.0, contrastMul = 1.3) {
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
        let r = (d[i]   - 128) * contrastMul + 128;
        let g = (d[i+1] - 128) * contrastMul + 128;
        let b = (d[i+2] - 128) * contrastMul + 128;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = lum + (r - lum) * satMul;
        g = lum + (g - lum) * satMul;
        b = lum + (b - lum) * satMul;
        d[i]   = Math.max(0, Math.min(255, Math.round(r)));
        d[i+1] = Math.max(0, Math.min(255, Math.round(g)));
        d[i+2] = Math.max(0, Math.min(255, Math.round(b)));
    }
}

// ── State ──────────────────────────────────────────────────────────────────────

const devices = []; // { device, server, cmdChar, dataChar, name }
let lastPacked = null;
let gpsPosition = null;
let gpsReady = false;

// ── DOM refs ───────────────────────────────────────────────────────────────────

const logEl         = document.getElementById('log');
const captureBtn    = document.getElementById('capture-btn');
const sendBtn       = document.getElementById('send-btn');
const pairBtn       = document.getElementById('pair-btn');
const editBtn       = document.getElementById('edit-btn');
const deviceList    = document.getElementById('device-list');
const previewEl     = document.getElementById('preview');
const progressEl    = document.getElementById('progress');
const mapContainer  = document.getElementById('map-container');
const mapButtons    = document.getElementById('map-buttons');
const previewButtons = document.getElementById('preview-buttons');

// ── Logging ────────────────────────────────────────────────────────────────────

function log(msg) {
    const ts = new Date().toLocaleTimeString();
    logEl.textContent += `[${ts}] ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
}

// ── Map ────────────────────────────────────────────────────────────────────────

const hasSavedView = localStorage.getItem('map-center') !== null;
const savedCenter = JSON.parse(localStorage.getItem('map-center')) || [-98.5, 39.8];
const savedZoom = parseFloat(localStorage.getItem('map-zoom')) || 4;

const map = new maplibregl.Map({
    container: 'map',
    style: './eink-style.json',
    center: savedCenter,
    zoom: savedZoom,
    dragRotate: false,
    touchZoomRotate: true,
    pitchWithRotate: false,
    canvasContextAttributes: { preserveDrawingBuffer: true },
});

map.touchZoomRotate.disableRotation();

map.on('moveend', () => {
    const c = map.getCenter();
    localStorage.setItem('map-center', JSON.stringify([c.lng, c.lat]));
    localStorage.setItem('map-zoom', map.getZoom());
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');

class RecenterControl {
    onAdd() {
        this._container = document.createElement('div');
        this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        this._container.innerHTML = '<button type="button" title="Re-center on GPS"><span>&#x1F4CD;</span></button>';
        this._container.addEventListener('click', () => {
            if (gpsPosition) map.flyTo({ center: gpsPosition, zoom: map.getZoom() });
        });
        return this._container;
    }
    onRemove() { this._container.remove(); }
}
map.addControl(new RecenterControl(), 'top-left');

// Disable capture until map is ready
captureBtn.disabled = true;
map.on('load', () => {
    captureBtn.disabled = false;
    log('Map loaded');

    // GPS dot source + layers (rendered on WebGL canvas, not HTML)
    map.addSource('gps', {
        type: 'geojson',
        data: { type: 'Point', coordinates: [0, 0] },
    });
    map.addLayer({
        id: 'gps-halo',
        type: 'circle',
        source: 'gps',
        paint: {
            'circle-radius': 10,
            'circle-color': '#ffffff',
            'circle-opacity': 1,
        },
    });
    map.addLayer({
        id: 'gps-dot',
        type: 'circle',
        source: 'gps',
        paint: {
            'circle-radius': 7,
            'circle-color': '#000080',
        },
    });
});

// ── GPS ────────────────────────────────────────────────────────────────────────

if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition(
        (pos) => {
            gpsPosition = [pos.coords.longitude, pos.coords.latitude];
            const src = map.getSource('gps');
            if (src) src.setData({ type: 'Point', coordinates: gpsPosition });

            if (!gpsReady) {
                gpsReady = true;
                if (!hasSavedView) {
                    map.flyTo({ center: gpsPosition, zoom: 12 });
                }
                log('GPS fix acquired');
            }
        },
        (err) => log(`GPS error: ${err.message}`),
        { enableHighAccuracy: true }
    );
}

function showPreviewMode() {
    mapContainer.classList.add('preview-mode');
    mapButtons.style.display = 'none';
    previewButtons.style.display = '';
    updateSendButton();
}

function showMapMode() {
    mapContainer.classList.remove('preview-mode');
    mapButtons.style.display = '';
    previewButtons.style.display = 'none';
    map.resize();
}

editBtn.addEventListener('click', showMapMode);

// ── Dithering ──────────────────────────────────────────────────────────────────

function closestColor(r, g, b) {
    const lab = rgbToLab(
        Math.max(0, Math.min(255, r)),
        Math.max(0, Math.min(255, g)),
        Math.max(0, Math.min(255, b))
    );
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < PALETTE_LAB.length; i++) {
        const dL = lab[0] - PALETTE_LAB[i][0];
        const da = lab[1] - PALETTE_LAB[i][1];
        const db2 = lab[2] - PALETTE_LAB[i][2];
        const d = dL * dL + da * da + db2 * db2;
        if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
}

function ditherImage(imageData) {
    const w = imageData.width, h = imageData.height;
    const buf = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
        buf[i * 3]     = imageData.data[i * 4];
        buf[i * 3 + 1] = imageData.data[i * 4 + 1];
        buf[i * 3 + 2] = imageData.data[i * 4 + 2];
    }

    const result = new Uint8Array(w * h);

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 3;
            const r = buf[i], g = buf[i + 1], b = buf[i + 2];
            const ci = closestColor(r, g, b);
            result[y * w + x] = ci;

            const er = r - PALETTE[ci][0];
            const eg = g - PALETTE[ci][1];
            const eb = b - PALETTE[ci][2];

            const spread = (dx, dy, f) => {
                const nx = x + dx, ny = y + dy;
                if (nx >= 0 && nx < w && ny < h) {
                    const ni = (ny * w + nx) * 3;
                    buf[ni]     += er * f;
                    buf[ni + 1] += eg * f;
                    buf[ni + 2] += eb * f;
                }
            };
            spread(1,  0, 7 / 16);
            spread(-1, 1, 3 / 16);
            spread(0,  1, 5 / 16);
            spread(1,  1, 1 / 16);
        }
    }
    return result;
}

function packBuffer(indices) {
    const packed = new Uint8Array(WIDTH * HEIGHT / 2);
    for (let i = 0; i < indices.length; i += 2) {
        packed[i / 2] = (indices[i] << 4) | indices[i + 1];
    }
    return packed;
}

// ── Capture ────────────────────────────────────────────────────────────────────

captureBtn.addEventListener('click', () => {
    try {
        log('Capturing map...');
        captureBtn.disabled = true;

        // Read pixels directly from the WebGL canvas via readPixels
        const mapCanvas = map.getCanvas();
        const gl = mapCanvas.getContext('webgl2') || mapCanvas.getContext('webgl');
        if (!gl) throw new Error('Cannot get WebGL context');

        const glW = gl.drawingBufferWidth;
        const glH = gl.drawingBufferHeight;
        const pixels = new Uint8Array(glW * glH * 4);
        gl.readPixels(0, 0, glW, glH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        // readPixels gives bottom-up rows; flip to top-down into an ImageData
        const offscreen = document.createElement('canvas');
        offscreen.width = glW;
        offscreen.height = glH;
        const ctx = offscreen.getContext('2d');
        const srcData = ctx.createImageData(glW, glH);
        for (let y = 0; y < glH; y++) {
            const srcRow = (glH - 1 - y) * glW * 4;
            const dstRow = y * glW * 4;
            srcData.data.set(pixels.subarray(srcRow, srcRow + glW * 4), dstRow);
        }
        ctx.putImageData(srcData, 0, 0);

        // Scale to 600x448 (cover + center crop)
        const out = document.createElement('canvas');
        out.width = WIDTH;
        out.height = HEIGHT;
        const outCtx = out.getContext('2d');
        outCtx.fillStyle = 'white';
        outCtx.fillRect(0, 0, WIDTH, HEIGHT);
        const scale = Math.max(WIDTH / glW, HEIGHT / glH);
        const sw = glW * scale, sh = glH * scale;
        outCtx.drawImage(offscreen, (WIDTH - sw) / 2, (HEIGHT - sh) / 2, sw, sh);

        const imageData = outCtx.getImageData(0, 0, WIDTH, HEIGHT);

        boostSaturationContrast(imageData);
        log('Dithering to 7 colors...');
        const indices = ditherImage(imageData);
        lastPacked = packBuffer(indices);

        // Show dithered preview
        const previewCtx = previewEl.getContext('2d');
        const preview = previewCtx.createImageData(WIDTH, HEIGHT);
        for (let i = 0; i < indices.length; i++) {
            const c = PALETTE[indices[i]];
            preview.data[i * 4]     = c[0];
            preview.data[i * 4 + 1] = c[1];
            preview.data[i * 4 + 2] = c[2];
            preview.data[i * 4 + 3] = 255;
        }
        previewCtx.putImageData(preview, 0, 0);

        log(`Capture ready (${lastPacked.length} bytes packed)`);
        showPreviewMode();
    } catch (e) {
        log(`Capture error: ${e.message}`);
    } finally {
        captureBtn.disabled = false;
    }
});

// ── BLE Multi-Device Manager ───────────────────────────────────────────────────

function updateDeviceList() {
    if (devices.length === 0) {
        deviceList.innerHTML = '<li><small>No displays paired yet.</small></li>';
        return;
    }
    deviceList.innerHTML = '';
    for (const d of devices) {
        const connected = d.server && d.server.connected;
        const li = document.createElement('li');
        li.innerHTML = `<span><span class="status-dot ${connected ? 'connected' : 'disconnected'}"></span>${d.name}</span>`;
        deviceList.appendChild(li);
    }
    updateSendButton();
}

function updateSendButton() {
    const hasConnected = devices.some(d => d.server && d.server.connected);
    sendBtn.disabled = !lastPacked || !hasConnected;
}

pairBtn.addEventListener('click', async () => {
    try {
        log('Scanning for Inkplate displays...');
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [SERVICE_UUID] }],
        });

        // Don't add duplicates
        if (devices.find(d => d.device.id === device.id)) {
            log(`${device.name} already paired`);
            return;
        }

        log(`Connecting to ${device.name}...`);
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);
        const cmdChar = await service.getCharacteristic(CMD_UUID);
        const dataChar = await service.getCharacteristic(DATA_UUID);

        const entry = { device, server, cmdChar, dataChar, name: device.name || 'Inkplate' };
        devices.push(entry);

        device.addEventListener('gattserverdisconnected', () => {
            log(`${entry.name} disconnected`);
            entry.server = null;
            entry.cmdChar = null;
            entry.dataChar = null;
            updateDeviceList();
        });

        log(`${entry.name} connected`);
        updateDeviceList();
    } catch (e) {
        log(`Pair error: ${e.message}`);
    }
});

// ── Send to All ────────────────────────────────────────────────────────────────

async function sendToDevice(entry, packed) {
    if (!entry.cmdChar || !entry.dataChar) {
        throw new Error(`${entry.name} not connected`);
    }

    // START
    await entry.cmdChar.writeValueWithResponse(new Uint8Array([0x01]));

    const totalChunks = Math.ceil(packed.length / CHUNK_SIZE);

    for (let i = 0; i < totalChunks; i++) {
        const offset = i * CHUNK_SIZE;
        const chunk = packed.subarray(offset, offset + CHUNK_SIZE);
        const packet = new Uint8Array(2 + chunk.length);
        packet[0] = i & 0xFF;
        packet[1] = (i >> 8) & 0xFF;
        packet.set(chunk, 2);
        await entry.dataChar.writeValueWithoutResponse(packet);
    }

    // END
    await entry.cmdChar.writeValueWithResponse(new Uint8Array([0x02]));
}

sendBtn.addEventListener('click', async () => {
    if (!lastPacked) return;

    const connected = devices.filter(d => d.server && d.server.connected);
    if (connected.length === 0) return;

    sendBtn.disabled = true;
    captureBtn.disabled = true;
    progressEl.style.display = '';
    progressEl.value = 0;

    log(`Sending to ${connected.length} display(s)...`);

    try {
        // Send to all connected devices concurrently
        const totalChunks = Math.ceil(lastPacked.length / CHUNK_SIZE);

        // For progress tracking, wrap sendToDevice with progress updates
        const promises = connected.map(async (entry) => {
            try {
                // START
                await entry.cmdChar.writeValueWithResponse(new Uint8Array([0x01]));
                log(`${entry.name}: START`);

                for (let i = 0; i < totalChunks; i++) {
                    const offset = i * CHUNK_SIZE;
                    const chunk = lastPacked.subarray(offset, offset + CHUNK_SIZE);
                    const packet = new Uint8Array(2 + chunk.length);
                    packet[0] = i & 0xFF;
                    packet[1] = (i >> 8) & 0xFF;
                    packet.set(chunk, 2);
                    await entry.dataChar.writeValueWithoutResponse(packet);

                    // Update progress (average across devices)
                    if (i % 20 === 0) {
                        progressEl.value = Math.round((i / totalChunks) * 100);
                    }
                }

                // END
                await entry.cmdChar.writeValueWithResponse(new Uint8Array([0x02]));
                log(`${entry.name}: done, refreshing (~12s)`);
            } catch (e) {
                log(`${entry.name}: send error - ${e.message}`);
            }
        });

        await Promise.all(promises);
        progressEl.value = 100;
        log('All transfers complete.');
    } catch (e) {
        log(`Send error: ${e.message}`);
    } finally {
        sendBtn.disabled = false;
        captureBtn.disabled = false;
        setTimeout(() => { progressEl.style.display = 'none'; }, 2000);
    }
});
