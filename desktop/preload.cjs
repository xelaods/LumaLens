'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (channel, ...args) => {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (!response.ok) throw new Error(response.error);
  return response.value;
};
const subscribe = (channel, callback) => { const handler = (_event, value) => callback(value); ipcRenderer.on(channel, handler); return () => ipcRenderer.removeListener(channel, handler); };
contextBridge.exposeInMainWorld('luma', {
  bootstrap: () => invoke('bootstrap'), saveSettings: s => invoke('settings:save', s),
  models: () => invoke('provider:models'), testProvider: () => invoke('provider:test'),
  sources: () => invoke('sources:list'), selectSource: id => invoke('sources:select', id),
  selectRegion: () => invoke('region:select'), processFrame: f => invoke('frame:process', f), cancel: () => invoke('frame:cancel'),
  updateOverlay: r => invoke('overlay:update', r), hideOverlay: () => invoke('overlay:hide'), minimize: () => invoke('window:minimize'),
  copy: text => invoke('clipboard:write', text), clearHistory: () => invoke('history:clear'), exportHistory: f => invoke('history:export', f),
  onProgress: cb => subscribe('progress', cb), onOcrProgress: cb => subscribe('ocr-progress', cb), onShortcut: cb => subscribe('shortcut', cb)
});
