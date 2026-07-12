'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexUsage', {
  get: () => ipcRenderer.invoke('usage:get'),
  refresh: () => ipcRenderer.invoke('usage:refresh'),
  openMenu: () => ipcRenderer.send('ui:menu'),
  openSettings: () => ipcRenderer.send('ui:settings'),
  hide: () => ipcRenderer.send('ui:hide'),
  resize: (height) => ipcRenderer.send('ui:resize', height),
  getBackgroundImage: () => ipcRenderer.invoke('theme:image'),
  onUpdate: (cb) => ipcRenderer.on('usage:update', (_e, payload) => cb(payload)),
});

contextBridge.exposeInMainWorld('codexSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  setTheme: (patch) => ipcRenderer.invoke('settings:set-theme', patch),
  setPrefs: (patch) => ipcRenderer.invoke('settings:set-prefs', patch),
  pickImage: () => ipcRenderer.invoke('settings:pick-image'),
  resetTheme: () => ipcRenderer.invoke('settings:reset-theme'),
  setPlugin: (payload) => ipcRenderer.invoke('plugins:set', payload),
  reloadPlugins: () => ipcRenderer.invoke('plugins:reload'),
  openPluginDir: () => ipcRenderer.invoke('plugins:open-dir'),
  openDataDir: () => ipcRenderer.invoke('data:open-dir'),
  clearHistory: () => ipcRenderer.invoke('data:clear-history'),
  exportHistory: (format) => ipcRenderer.invoke('data:export', format),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  onUpdate: (cb) => ipcRenderer.on('settings:update', (_e, payload) => cb(payload)),
});
