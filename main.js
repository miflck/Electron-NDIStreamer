const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const express = require('express')

// ---------------------------------------------------------------------------
// NDI setup via grandiose (rse fork with sender support)
// ---------------------------------------------------------------------------
let grandiose
try {
  grandiose = require('grandiose')
  console.log('[NDI] Loaded grandiose — NDI version:', grandiose.version())
} catch (err) {
  console.error('[NDI] Failed to load grandiose:', err.message)
  console.error('[NDI] Did you run: npm install && npx @electron/rebuild ?')
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let mainWindow = null
let sketchWindow = null
let ndiSender = null
let webAppServer = null
let sending = false
let offscreenMode = false
let fps = 30
let frameCount = 0
let currentPort = null

// ---------------------------------------------------------------------------
// Main control window
// ---------------------------------------------------------------------------
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 700,
    height: 620,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.loadFile('index.html')
  mainWindow.on('closed', () => {
    mainWindow = null
    closeSketchWindow()
    stopWebAppServer()
  })

  mainWindow.webContents.once('dom-ready', () => {
    updateDisplayInfo()
  })
}

// ---------------------------------------------------------------------------
// Display enumeration
// ---------------------------------------------------------------------------
let availableDisplays = []

function updateDisplayInfo() {
  availableDisplays = screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    index: i,
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    primary: d.id === screen.getPrimaryDisplay().id,
    label: `Display ${i + 1} (${d.bounds.width}×${d.bounds.height})${d.id === screen.getPrimaryDisplay().id ? ' — Primary' : ''}`,
  }))
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('displays-updated', availableDisplays)
  }
}

// ---------------------------------------------------------------------------
// Express server for serving the p5.js sketch folder
// ---------------------------------------------------------------------------
function startWebAppServer(folderPath) {
  return new Promise((resolve, reject) => {
    const expressApp = express()
    expressApp.use(express.static(folderPath))

    const startPort = 3100
    const maxPort = startPort + 100

    function tryPort(port) {
      const server = expressApp.listen(port, 'localhost', () => {
        console.log(`[Server] Serving ${folderPath} on http://localhost:${port}`)
        webAppServer = server
        resolve(port)
      })
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && port < maxPort) {
          setTimeout(() => tryPort(port + 1), 50)
        } else {
          reject(err)
        }
      })
    }
    tryPort(startPort)
  })
}

function stopWebAppServer() {
  if (webAppServer) {
    webAppServer.close()
    webAppServer = null
    currentPort = null
    console.log('[Server] Stopped')
  }
}

// ---------------------------------------------------------------------------
// Sketch window — renders web content, this is what we NDI-capture
// Accepts either a localhost port (local folder) or a remote URL
//
// Two render modes:
//   offscreen: true  → hidden window, frames arrive via 'paint' event (efficient)
//   offscreen: false → visible window, frames grabbed via capturePage() polling
// ---------------------------------------------------------------------------
function createSketchWindow(url, displayBounds, windowSize, offscreen) {
  const width = windowSize?.width || 1280
  const height = windowSize?.height || 720
  offscreenMode = !!offscreen

  sketchWindow = new BrowserWindow({
    width,
    height,
    x: (!offscreen && displayBounds) ? displayBounds.x + Math.round((displayBounds.width - width) / 2) : undefined,
    y: (!offscreen && displayBounds) ? displayBounds.y + Math.round((displayBounds.height - height) / 2) : undefined,
    frame: !offscreen,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      offscreen: offscreen,
    },
  })

  sketchWindow.loadURL(url)
  if (!offscreen) sketchWindow.setMenuBarVisibility(false)

  if (offscreen) {
    // In offscreen mode, set the frame rate and start painting immediately
    sketchWindow.webContents.setFrameRate(fps)
    console.log(`[Sketch] Offscreen mode — ${width}×${height} @ ${fps}fps`)
  }

  sketchWindow.once('ready-to-show', () => {
    if (!offscreen) {
      sketchWindow.show()
      console.log('[Sketch] Window visible')
    } else {
      console.log('[Sketch] Offscreen rendering started')
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sketch-status', { open: true, offscreen })
    }
  })

  sketchWindow.on('closed', () => {
    console.log('[Sketch] Window closed')
    sending = false
    sketchWindow = null
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sketch-status', { open: false })
      mainWindow.webContents.send('ndi-status', { sending: false, frameCount })
    }
  })

  if (!offscreen) {
    sketchWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.key === 'Escape') {
        closeSketchWindow()
      }
    })
  }
}

function closeSketchWindow() {
  sending = false
  stopOffscreenCapture()
  stopVisibleCapture()
  if (sketchWindow && !sketchWindow.isDestroyed()) {
    sketchWindow.close()
  }
  sketchWindow = null
}

// ---------------------------------------------------------------------------
// NDI sender lifecycle
// ---------------------------------------------------------------------------
async function createNdiSender(name) {
  if (!grandiose) return null
  try {
    const sender = await grandiose.send({
      name: name || 'Electron NDI',
      clockVideo: true,
      clockAudio: false,
    })
    console.log('[NDI] Sender created:', name || 'Electron NDI')
    return sender
  } catch (err) {
    console.error('[NDI] Failed to create sender:', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Frame capture + NDI send
//
// Offscreen mode:  webContents 'paint' event pushes frames — no polling needed
// Visible mode:    capturePage() polling loop (original approach)
// ---------------------------------------------------------------------------
let paintHandler = null

function startOffscreenCapture() {
  if (!sketchWindow || sketchWindow.isDestroyed() || !ndiSender) return

  // Update frame rate to match requested fps
  sketchWindow.webContents.setFrameRate(fps)

  paintHandler = async (_event, _dirty, image) => {
    if (!sending || !ndiSender) return

    const size = image.getSize()
    if (size.width === 0 || size.height === 0) return

    try {
      const bitmap = image.toBitmap()

      await ndiSender.video({
        xres: size.width,
        yres: size.height,
        fourCC: grandiose.FOURCC_BGRA,
        frameRateN: fps * 1000,
        frameRateD: 1001,
        pictureAspectRatio: size.width / size.height,
        frameFormatType: grandiose.FORMAT_TYPE_PROGRESSIVE,
        lineStrideBytes: size.width * 4,
        data: bitmap,
      })

      frameCount++

      if (frameCount % 60 === 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ndi-status', { sending: true, frameCount })
      }
    } catch (err) {
      if (frameCount === 0) {
        console.error('[NDI] Offscreen send error:', err.message)
      }
    }
  }

  sketchWindow.webContents.on('paint', paintHandler)
  // Trigger initial paint
  sketchWindow.webContents.invalidate()
  console.log('[NDI] Offscreen paint capture started')
}

function stopOffscreenCapture() {
  if (paintHandler && sketchWindow && !sketchWindow.isDestroyed()) {
    sketchWindow.webContents.removeListener('paint', paintHandler)
  }
  paintHandler = null
}

// Visible-mode polling capture (fallback)
// Uses setInterval keyed to the requested fps rather than a raw setTimeout(1)
// so frame rate is actually controlled. A guard flag prevents overlapping
// captures if capturePage() takes longer than one interval.
let captureTimer = null
let captureInFlight = false

async function captureAndSend() {
  if (!sending || !sketchWindow || sketchWindow.isDestroyed() || !ndiSender) return
  if (captureInFlight) return  // previous frame still encoding — skip this tick
  captureInFlight = true

  try {
    const image = await sketchWindow.webContents.capturePage()
    const size = image.getSize()

    if (size.width > 0 && size.height > 0) {
      const bitmap = image.toBitmap()

      await ndiSender.video({
        xres: size.width,
        yres: size.height,
        fourCC: grandiose.FOURCC_BGRA,
        frameRateN: fps * 1000,
        frameRateD: 1001,
        pictureAspectRatio: size.width / size.height,
        frameFormatType: grandiose.FORMAT_TYPE_PROGRESSIVE,
        lineStrideBytes: size.width * 4,
        data: bitmap,
      })

      frameCount++

      if (frameCount % 60 === 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ndi-status', { sending: true, frameCount })
      }
    }
  } catch (err) {
    if (frameCount === 0) {
      console.error('[NDI] Send error:', err.message)
    }
  }

  captureInFlight = false
}

function startVisibleCapture() {
  captureInFlight = false
  captureTimer = setInterval(captureAndSend, Math.round(1000 / fps))
  console.log(`[NDI] Visible capture timer started at ${fps} fps (${Math.round(1000 / fps)} ms/frame)`)
}

function stopVisibleCapture() {
  if (captureTimer) {
    clearInterval(captureTimer)
    captureTimer = null
  }
  captureInFlight = false
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select p5.js Sketch Folder',
  })

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, error: 'No folder selected' }
  }

  const folderPath = result.filePaths[0]
  const files = fs.readdirSync(folderPath)
  const hasHtml = files.some(f => f.endsWith('.html') || f.endsWith('.htm'))

  if (!hasHtml) {
    return { success: false, error: 'No HTML file found in folder. A p5.js sketch needs an index.html.' }
  }

  stopWebAppServer()

  try {
    const port = await startWebAppServer(folderPath)
    currentPort = port
    return { success: true, path: folderPath, port, files }
  } catch (err) {
    return { success: false, error: `Server failed: ${err.message}` }
  }
})

ipcMain.handle('launch-sketch', async (_event, options) => {
  const { port, url, displayId, width, height, offscreen } = options
  const display = availableDisplays.find(d => d.id === displayId)

  // Determine the URL to load: either a remote URL or a local server
  const loadUrl = url || `http://localhost:${port}`

  closeSketchWindow()
  createSketchWindow(loadUrl, display?.bounds, { width: width || 1280, height: height || 720 }, !!offscreen)
  console.log(`[Sketch] Loading: ${loadUrl}`)
  return { success: true, offscreen: !!offscreen, url: loadUrl }
})

ipcMain.handle('close-sketch', () => {
  closeSketchWindow()
  return { success: true }
})

ipcMain.handle('ndi:start', async (_event, opts) => {
  if (!grandiose) return { ok: false, error: 'grandiose not loaded — check native build' }
  if (!sketchWindow || sketchWindow.isDestroyed()) return { ok: false, error: 'No sketch window open' }

  if (!ndiSender) {
    ndiSender = await createNdiSender(opts?.name || 'p5.js Sketch')
  }
  if (!ndiSender) return { ok: false, error: 'Failed to create NDI sender' }

  fps = opts?.fps || 30
  sending = true
  frameCount = 0

  if (offscreenMode) {
    startOffscreenCapture()
  } else {
    startVisibleCapture()
  }

  console.log(`[NDI] Sending started at ${fps} fps (${offscreenMode ? 'offscreen' : 'visible'} mode)`)
  return { ok: true }
})

ipcMain.handle('ndi:stop', () => {
  sending = false
  stopOffscreenCapture()
  stopVisibleCapture()
  const finalCount = frameCount
  if (ndiSender) {
    ndiSender.destroy?.()
    ndiSender = null
  }
  console.log(`[NDI] Stopped (${finalCount} frames sent)`)
  return { ok: true, frameCount: finalCount }
})

ipcMain.handle('ndi:status', () => ({
  available: !!grandiose,
  sending,
  frameCount,
  hasSketchWindow: !!(sketchWindow && !sketchWindow.isDestroyed()),
}))

ipcMain.handle('get-displays', () => {
  updateDisplayInfo()
  return availableDisplays
})

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  createMainWindow()

  screen.on('display-added', updateDisplayInfo)
  screen.on('display-removed', updateDisplayInfo)
  screen.on('display-metrics-changed', updateDisplayInfo)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  sending = false
  stopWebAppServer()
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  sending = false
  ndiSender = null
  stopWebAppServer()
})
