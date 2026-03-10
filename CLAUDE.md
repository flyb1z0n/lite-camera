# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Lite Camera is a browser-based camera app (vanilla HTML/CSS/JS, no build tools or dependencies). It captures photos from a webcam and saves them to a local folder using the File System Access API (Chromium-only).

## Development

Open `index.html` directly in Chrome/Edge, or serve with any static file server:

```
npx serve .
```

No build step, no tests, no linting configured.

## Architecture

Three files, single IIFE in `app.js`:

- **`index.html`** — Static markup: viewfinder, overlays, controls, filmstrip, lightbox
- **`app.js`** — All application logic in one self-executing function. Key subsystems:
  - **Directory persistence** — Stores the selected folder handle in IndexedDB (`lite-camera-handles` DB) so it survives page reloads. `restoreDirHandle()` / `persistDirHandle()` / `ensureDirHandle()`.
  - **Camera** — `startCamera()` requests getUserMedia at 4K ideal resolution. `refreshCameraList()` populates the camera dropdown. Listens for `devicechange`.
  - **Capture** — `capture()` draws the video frame to a canvas, exports PNG, saves via File System Access API. Supports optional countdown timer (3/5/10s) with cancel. Plays a synthesized shutter sound via Web Audio API.
  - **Filmstrip** — `loadPhotosFromDir()` reads existing photos from the directory on startup, sorted newest-first by `lastModified`. `addFilmstripItem()` prepends new captures. Thumbnails are 200px-wide JPEG data URLs.
  - **Lightbox** — Full-res preview with arrow key navigation and two-click delete confirmation.
- **`style.css`** — Dark theme, fullscreen viewfinder layout with floating controls. CSS custom properties in `:root`.

## Key Patterns

- Photos are named `photo-YYYY-MM-DD-HHmmss.png` and filtered by this prefix when loading from directory.
- The `photos` array is the source of truth; filmstrip indices map directly to array indices.
- Directory permission is checked with `queryPermission()` before reading; `requestPermission()` is called on user gesture (capture/pick).
- Browser support gate: if `showDirectoryPicker` is missing, the app shows an unsupported-browser overlay and returns early.
