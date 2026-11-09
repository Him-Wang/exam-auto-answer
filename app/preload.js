const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  run: (step, opts) => ipcRenderer.invoke('run', { step, opts }),
  openWorkDir: () => ipcRenderer.invoke('openWorkDir'),
  readFile: (name) => ipcRenderer.invoke('readFile', name),
  onLog: (cb) => {
    ipcRenderer.on('log', (_e, chunk) => cb(chunk));
  },
});
