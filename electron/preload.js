const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('strata', {
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  pickImage: () => ipcRenderer.invoke('image:pick'),
  pickAudio: () => ipcRenderer.invoke('audio:pick'),
  pickMedia: () => ipcRenderer.invoke('media:pick'),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  pickSaveAs: (defaultName, format) => ipcRenderer.invoke('saveas:pick', defaultName, format),
  saveProject: (data) => ipcRenderer.invoke('project:save', data),
  openProject: () => ipcRenderer.invoke('project:open'),
  onProjectOpen: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('project:open-from-file', handler);
    return () => ipcRenderer.removeListener('project:open-from-file', handler);
  },
  // ── Dirty-state sync + save-on-quit/update prompt ──────────────────────
  // Renderer pushes its dirty flag here whenever it changes; main keeps a
  // cached copy so it can decide on quit/update whether to prompt for save.
  setDirty: (dirty) => ipcRenderer.send('project:set-dirty', !!dirty),
  // Main asks the renderer to perform a Save (it has the project state).
  // Renderer replies with `saveRequestResponse({ ok, path, canceled, error })`.
  onSaveRequest: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('project:save-request', handler);
    return () => ipcRenderer.removeListener('project:save-request', handler);
  },
  saveRequestResponse: (result) => ipcRenderer.send('project:save-response', result),
  // Main asks the renderer to show the custom save-prompt modal (in-app
  // styling instead of the native OS dialog). Renderer replies with one of
  // 'save' | 'dont-save' | 'cancel'.
  onSavePromptRequest: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('project:save-prompt-request', handler);
    return () => ipcRenderer.removeListener('project:save-prompt-request', handler);
  },
  savePromptResponse: (choice) => ipcRenderer.send('project:save-prompt-response', choice),
  editVideo: (payload) => ipcRenderer.invoke('video:edit', payload),
  mergeClips: (payload) => ipcRenderer.invoke('editor:concatClips', payload),
  onMergeProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('editor:merge-progress', handler);
    return () => ipcRenderer.removeListener('editor:merge-progress', handler);
  },
  makeProxy: (payload) => ipcRenderer.invoke('editor:makeProxy', payload),
  onProxyProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('editor:proxy-progress', handler);
    return () => ipcRenderer.removeListener('editor:proxy-progress', handler);
  },
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
