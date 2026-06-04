const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  minimize: () => ipcRenderer.send('window-control', 'minimize'),
  maximize: () => ipcRenderer.send('window-control', 'maximize'),
  close: () => ipcRenderer.send('window-control', 'close'),
  onInit: (cb) => ipcRenderer.once('shell-init', (_, data) => cb(data)),
  onThemeColor: (cb) => ipcRenderer.on('theme-color', (_, color) => cb(color)),
  onMaximize: (cb) => ipcRenderer.on('window-maximized', (_, isMax) => cb(isMax)),
  onResize: (cb) => ipcRenderer.on('window-resize', (_, dims) => cb(dims)),
  notifyWebviewReady: (id) => ipcRenderer.send('webview-ready', id),
});
