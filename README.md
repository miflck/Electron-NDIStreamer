# p5.js → NDI Sender

Electron app that loads a local p5.js sketch folder, renders it in a window, and broadcasts the output as an NDI source on your network.

## Prerequisites

- **Node.js** ≥ 18
- **Xcode Command-Line Tools** (macOS): `xcode-select --install`
- **NDI Tools runtime** (free): https://ndi.video/tools — install the NDI runtime so the SDK libraries are available

## Setup

```bash
npm install
npx @electron/rebuild   # rebuild grandiose native addon for Electron
npm start
```

## Usage

1. **Choose Folder** — pick a folder containing your p5.js sketch (must have an `index.html`)
2. **Launch Sketch** — opens the sketch in a separate window at the chosen resolution
3. **Start NDI** — begins capturing the sketch window and broadcasting via NDI

The NDI source will appear in any NDI receiver on your network (OBS, vMix, Resolume, etc.) under the name you specify.

Press **ESC** in the sketch window to close it.

## How It Works

- Express serves the sketch folder on a local port
- A BrowserWindow loads the sketch URL
- `webContents.capturePage()` grabs BGRA frames
- `grandiose` (rse fork) sends them as NDI video frames

## Folder Structure

Your p5.js sketch folder should look like:

```
my-sketch/
  index.html      ← entry point
  sketch.js       ← your p5.js code
  libraries/
    p5.min.js     ← p5.js library
  assets/         ← images, fonts, etc.
```
