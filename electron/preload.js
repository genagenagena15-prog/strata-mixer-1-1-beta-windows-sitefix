const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('strata', {
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  pickImage: () => ipcRenderer.invoke('image:pick'),
  pickAudio: () => ipcRenderer.invoke('audio:pick'),
  pickMedia: () => ipcRenderer.invoke('media:pick'),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  pickSaveAs: (defaultName, format) => ipcRenderer.invoke('saveas:pick', defaultName, format),
  editVideo: (payload) => ipcRenderer.invoke('video:edit', payload),
  listFonts: () => ipcRenderer.invoke('fonts:list'),
  onEditProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('edit-progress', handler);
    return () => ipcRenderer.removeListener('edit-progress', handler);
  },
  openFolder: (folder) => ipcRenderer.invoke('folder:open', folder),
  revealFile: (filePath) => ipcRenderer.invoke('file:reveal', filePath),
  detectRender: () => ipcRenderer.invoke('system:detectRender'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  startProcessing: (payload) => ipcRenderer.invoke('process:start', payload),
  stopProcessing: () => ipcRenderer.invoke('process:stop'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  saveTheme: (theme) => ipcRenderer.invoke('theme:save', theme),
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return file?.path || ''; }
  },
  onProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('progress', handler);
    return () => ipcRenderer.removeListener('progress', handler);
  },
  onLog: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('log', handler);
    return () => ipcRenderer.removeListener('log', handler);
  },
  onDone: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('done', handler);
    return () => ipcRenderer.removeListener('done', handler);
  },
  appVersion: () => ipcRenderer.invoke('app:version'),
  platform: process.platform,
  update: {
    getState: () => ipcRenderer.invoke('update:getState'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onState: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('update:state', handler);
      return () => ipcRenderer.removeListener('update:state', handler);
    }
  },
  notifications: {
    get: () => ipcRenderer.invoke('notifications:get'),
    refresh: () => ipcRenderer.invoke('notifications:refresh'),
    onData: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('notifications:data', handler);
      return () => ipcRenderer.removeListener('notifications:data', handler);
    }
  }
});
