const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('thermal', {
  onConfig: (cb) => ipcRenderer.on('config', (_e, c) => cb(c)),
  onOps: (cb) => ipcRenderer.on('ops', (_e, o) => cb(o)),
  onCommand: (cb) => ipcRenderer.on('command', (_e, c) => cb(c)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  setIgnoreMouse: (v) => ipcRenderer.send('ignore-mouse', v),
  openMenu: () => ipcRenderer.send('open-menu'),
  receiptMenu: (data) => ipcRenderer.send('receipt-menu', data),
  ready: () => ipcRenderer.send('ready'),
});
