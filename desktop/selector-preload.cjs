const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('regionSelector', { done: rect => ipcRenderer.send('selector:done', rect) });
