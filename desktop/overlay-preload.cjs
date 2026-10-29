const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('overlay', { onData: callback => ipcRenderer.on('overlay:data', (_e, value) => callback(value)) });
