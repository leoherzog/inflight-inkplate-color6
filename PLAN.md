# Inkplate 6COLOR Map Broadcaster Project Plan

A road-trip companion system: a web app on Android Chrome captures a map view with your GPS position, dithers it to 7 colors, and broadcasts it via BLE to one or more Inkplate 6COLOR e-paper displays.

1.  **Web Application** (`pwa/`) — plain web page (not an installable PWA) running on Android Chrome. Hosted on **Cloudflare Pages** for HTTPS (required by Web Bluetooth).
2.  **Firmware** (`inflight-inkplate-color6.ino`) — Arduino sketch for the Soldered Inkplate 6COLOR (ESP32-WROVER-E).

---

## 1. System Architecture

### 1.1 Web Application (`pwa/`)

Separate static files with no bundler: `index.html`, `app.js`, `style.css`. All libraries loaded from CDN.

*   **UI/Styling:** [PicoCSS](https://picocss.com/) (CDN) for a clean, minimal, responsive, classless design.
*   **Mapping:** [MapLibre GL JS](https://maplibre.org/) (CDN) with [OpenFreeMap](https://openfreemap.org/) **Bright** style vector tiles. `preserveDrawingBuffer: true` to allow canvas export.
*   **Map Canvas:** Fixed at **600x448 pixels** (matching the Inkplate resolution). What you see is what you get on the display.
*   **GPS:** Show the user's current position as a dot on the map. The user can freely pan and zoom; a **re-center button** snaps back to the GPS location.
*   **Image Processing:** Canvas API exports the map at 600x448. Floyd-Steinberg dithering maps it to the 7-color palette. A **dithered preview** is shown on-screen before sending, so the user can verify the result.
*   **Web Bluetooth:** Multi-device manager from day one. Discovers, connects, and manages multiple Inkplate devices simultaneously. Slices the dithered image buffer into MTU-sized chunks and broadcasts to all connected devices over GATT.

### 1.2 Firmware (`inflight-inkplate-color6.ino`)

The firmware runs on the ESP32-WROVER-E with 8 MB PSRAM.

*   **Framework:** Arduino IDE with the official `Inkplate` library.
*   **BLE Stack:** `NimBLE-Arduino` library (not the standard ESP32 BLE stack) to preserve RAM/PSRAM.
*   **Boot Behavior:** Displays a "Ready" status message on the e-paper on first boot. After that, the e-paper only updates when a new image arrives. All ongoing status (connection events, transfer progress) goes to **Serial output only** to avoid unnecessary 12-second e-paper refreshes.
*   **Display Logic:** Receives 4-bit packed pixel data into a PSRAM buffer. On END, `memcpy`s the buffer directly into the Inkplate's public `DMemory4Bit` framebuffer (the pixel packing format is identical), then calls `display.display()`. No per-pixel unpacking needed.
*   **Always Listening:** The BLE server runs continuously. Multiple image transfers can be sent back-to-back — each START clears the buffer for the next image. No reconnection required between updates.

### 1.3 Local Development

Web Bluetooth requires a secure context. Options for local testing:
*   **Desktop:** `http://localhost` is treated as secure by Chrome. Any static file server works.
*   **Android via USB:** Chrome DevTools port forwarding (`chrome://inspect/#devices`) maps the phone's `localhost:8000` to the dev machine. Cleanest approach.
*   **Android via LAN (fallback):** `chrome://flags/#unsafely-treat-insecure-origin-as-secure` — add the exact origin (e.g. `http://192.168.1.100:8000`). No wildcards supported.

---

## 2. BLE Communication Protocol

A 600x448 image at 7 colors is ~134.4 KB — far exceeding single BLE packet limits. A custom chunking protocol handles the transfer.

*   **Data Encoding:**
    *   Color indices: 0=Black, 1=White, 2=Green, 3=Blue, 4=Red, 5=Yellow, 6=Orange.
    *   Pack 2 pixels per byte (4 bits each). Total payload: **134,400 bytes**.
*   **GATT Service & Characteristics:**
    *   **Service UUID:** `12345678-1234-5678-1234-56789abcdef0`
    *   **CMD Characteristic (Write):** UUID `...def1`. Control signals (START, END).
    *   **DATA Characteristic (Write Without Response):** UUID `...def2`. High-speed data transfer.

**Packet Structure:**
1.  **START Command (`0x01`):** Sent to CMD. Firmware allocates/clears the PSRAM buffer.
2.  **DATA Packets:** Sent to DATA characteristic.
    *   Format: `[2-byte chunk index] [Up to 500 bytes of pixel data]`
    *   Android Chrome negotiates an MTU of 512. ~500 byte payloads maximize throughput.
3.  **END Command (`0x02`):** Sent to CMD. Firmware `memcpy`s the receive buffer into `display.DMemory4Bit` and triggers the ~12-second e-paper refresh.

---

## 3. File Structure

```
inflight-inkplate-color6.ino   # Inkplate Arduino sketch (NimBLE) [DONE]
pwa/
  index.html                   # HTML shell with PicoCSS (CDN)
  app.js                       # Map init, GPS, dithering, BLE manager
  style.css                    # Custom styles
```

---

## 4. Implementation Phases

### Phase 1: Web App Shell & Map (`pwa/`)
1.  Set up `index.html` with PicoCSS from CDN.
2.  Initialize MapLibre GL JS with OpenFreeMap **Bright** tiles and `preserveDrawingBuffer: true`.
3.  Fix the map canvas to **600x448** (the Inkplate's native resolution).
4.  Add GPS geolocation: show a position dot on the map, with a re-center button.

### Phase 2: Capture & Dither
1.  Implement a "Capture" button that exports the map canvas to a 600x448 `ImageData`.
2.  Implement Floyd-Steinberg dithering in JS against the 7-color palette.
3.  Pack the dithered result into a `Uint8Array` of 134,400 bytes (2 pixels per byte).
4.  Render the dithered image on a **preview canvas** so the user can verify before sending.

### Phase 3: BLE Multi-Device Manager
1.  Create a "Pair New Display" UI section.
2.  Implement `navigator.bluetooth.requestDevice` filtered by the custom Service UUID.
3.  Maintain an array of connected `BluetoothRemoteGATTServer` objects with status indicators.
4.  Implement "Send to All": broadcast START, DATA chunks, and END to every connected device (concurrently via `Promise.all`).

### Phase 4: Inkplate Firmware (`inflight-inkplate-color6.ino`) — DONE
1.  Include `Inkplate.h` and `NimBLEDevice.h`.
2.  On boot: `display.begin()`, show "Ready" text on e-paper, then start BLE server.
3.  Pre-allocate 134,400-byte receive buffer in PSRAM via `ps_malloc`.
4.  BLE Service and Characteristics with callbacks:
    *   **START (`0x01`):** Clear receive buffer with white fill (`0x11`).
    *   **DATA:** Copy incoming chunk to buffer at `chunkIndex * 500` offset.
    *   **END (`0x02`):** `memcpy` receive buffer → `display.DMemory4Bit`, call `display.display()`.
5.  All transfer status logged via `Serial.println()` only.
6.  Always listening — multiple images can be sent back-to-back without reconnecting.

### Phase 5: Integration & Tuning
1.  Test single-device end-to-end transfer from Android Chrome.
2.  Monitor ESP32 serial output for dropped packets. If drops occur, add a small delay (`await new Promise(r => setTimeout(r, 5))`) between GATT writes in the web app.
3.  Test multi-device pairing and simultaneous broadcast to 2+ Inkplates.