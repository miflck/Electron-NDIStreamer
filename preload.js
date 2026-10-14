const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // Folder / sketch
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  launchSketch: (opts) => ipcRenderer.invoke('launch-sketch', opts),
  closeSketch: () => ipcRenderer.invoke('close-sketch'),

  // NDI
  ndiStart: (opts) => ipcRenderer.invoke('ndi:start', opts),
  ndiStop: () => ipcRenderer.invoke('ndi:stop'),
  ndiStatus: () => ipcRenderer.invoke('ndi:status'),

  // Displays
  getDisplays: () => ipcRenderer.invoke('get-displays'),

  // Events from main
  onDisplaysUpdated: (cb) => ipcRenderer.on('displays-updated', (_e, d) => cb(d)),
  onNdiStatus: (cb) => ipcRenderer.on('ndi-status', (_e, s) => cb(s)),
  onSketchStatus: (cb) => ipcRenderer.on('sketch-status', (_e, s) => cb(s)),
})
