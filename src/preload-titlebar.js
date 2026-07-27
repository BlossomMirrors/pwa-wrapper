const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  minimize:    () => ipcRenderer.send('window-control', 'minimize'),
  maximize:    () => ipcRenderer.send('window-control', 'maximize'),
  close:       () => ipcRenderer.send('window-control', 'close'),
  navBack:     () => ipcRenderer.send('nav-action', 'back'),
  navForward:  () => ipcRenderer.send('nav-action', 'forward'),
  reportHeight:(h) => ipcRenderer.send('titlebar-resize', h),
  reportColor: (c) => ipcRenderer.send('titlebar-color', c),
  onInit:      (cb) => ipcRenderer.once('titlebar-init', (_, d) => cb(d)),
  onThemeColor:(cb) => ipcRenderer.on('theme-color', (_, c) => cb(c)),
  onMaximize:  (cb) => ipcRenderer.on('window-maximized', (_, v) => cb(v)),
  onNavState:  (cb) => ipcRenderer.on('nav-state', (_, s) => cb(s)),
  onFullscreen:     (cb) => ipcRenderer.on('fullscreen', (_, v) => cb(v)),
  onFocusChange:    (cb) => ipcRenderer.on('focus-change', (_, v) => cb(v)),
});
