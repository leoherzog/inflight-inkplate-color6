# AGENTS.md

This file provides guidance to Claude Code, Gemini, Codex, etc when working with code in this repository.

## Project Overview

Road-trip portable map display system. A PWA on Android Chrome captures a map view, dithers it to 7 colors (Floyd-Steinberg), and sends it via BLE to one or more Inkplate 6COLOR e-paper displays (600x448, ESP32-WROVER-E).

## Architecture

Two independent components communicating over BLE:

- **`web/index.html`** — Single-file PWA (all JS/CSS inline). MapLibre GL JS map at 600x448, Floyd-Steinberg dithering to 7-color palette, Web Bluetooth multi-device manager. Libraries from CDN (PicoCSS, MapLibre GL JS). No bundler, no build step.
- **`inflight-inkplate-color6.ino`** — Arduino sketch for Inkplate 6COLOR. NimBLE-Arduino BLE server receives chunked 4-bit packed pixel data into PSRAM, then memcpys to `display.DMemory4Bit` framebuffer.
- **`web/sw.js`** — No-op service worker (fetch listener only). Exists solely to satisfy PWA installability requirements; does not cache anything.
- **`web/test.html`** — Standalone BLE test page that sends a static splash image to verify firmware connectivity.

## Development

### Web App

Serve `web/` with any static HTTP server. Web Bluetooth requires a secure context:
- **Desktop:** `http://localhost` works (Chrome treats it as secure)
- **Android via USB:** Chrome DevTools port forwarding (`chrome://inspect/#devices`)
- **Production:** Hosted on Cloudflare Pages for HTTPS

No build, no dependencies to install. Edit `web/index.html` directly.

### Firmware

Arduino IDE with Soldered Inkplate 6COLOR board:
1. Board URL: `https://soldered.com/package_soldered_index.json`
2. Board: **Soldered Inkplate Boards > Soldered Inkplate 6COLOR**
3. Required libraries: `Inkplate`, `NimBLE-Arduino`

Monitor serial at 115200 baud for transfer status and debug output.

## BLE Protocol

Service UUID: `12345678-1234-5678-1234-56789abcdef0`
- CMD char (`...def1`, Write): `0x01`=START, `0x02`=END
- DATA char (`...def2`, Write Without Response): `[2-byte LE chunk index][up to 500 bytes pixel data]`
- Color indices: 0=Black, 1=White, 2=Green, 3=Blue, 4=Red, 5=Yellow, 6=Orange
- Pixel packing: 2 pixels per byte (4 bits each), high nibble first. Total: 134,400 bytes
- Firmware reverses buffer and swaps nibbles on END to correct 180° panel rotation

## Key Constraints

- E-paper refresh takes ~12 seconds — firmware logs status to Serial only (no screen updates during transfer)
- Firmware runs at 80MHz with light sleep to save power; WiFi is disabled
- BLE MTU negotiated to 517; chunk payload is 500 bytes to fit within MTU
- The web app is a single HTML file with inline JS/CSS — keep it that way (no separate .js/.css files, no bundler)
- Use native browser APIs, not libraries, for non-map functionality
- MapLibre requires `preserveDrawingBuffer: true` for canvas export
