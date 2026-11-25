const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('platform', {
  os: process.platform,
});

contextBridge.exposeInMainWorld('api', {
  // Resolume preset I/O
  openResolumeFile: () => ipcRenderer.invoke('resolume:open-file'),
  openResolumePath: (path) => ipcRenderer.invoke('resolume:open-path', path),
  saveResolumeFile: (path, text) => ipcRenderer.invoke('resolume:save-file', path, text),
  listPresets: () => ipcRenderer.invoke('resolume:list-presets'),

  // Sidecar JSON (clerical Labels)
  readSidecar: (presetPath) => ipcRenderer.invoke('sidecar:read', presetPath),
  writeSidecar: (presetPath, data) => ipcRenderer.invoke('sidecar:write', presetPath, data),

  // Folder watcher
  watchFolder: (folder) => ipcRenderer.invoke('watcher:watch', folder),
  unwatchFolder: () => ipcRenderer.invoke('watcher:unwatch'),
  defaultPresetsFolder: () => ipcRenderer.invoke('watcher:default-folder'),
  onWatcherChange: (callback) => {
    const listener = (_e, evt) => callback(evt);
    ipcRenderer.on('watcher:change', listener);
    return () => ipcRenderer.removeListener('watcher:change', listener);
  },

  // MIDI input
  listMidiInputs: () => ipcRenderer.invoke('midi:list-inputs'),
  openMidiInput: (name) => ipcRenderer.invoke('midi:open-input', name),
  closeMidiInput: (name) => ipcRenderer.invoke('midi:close-input', name),
  onMidiMessage: (callback) => {
    const listener = (_e, payload) => callback(payload);
    ipcRenderer.on('midi:message', listener);
    return () => ipcRenderer.removeListener('midi:message', listener);
  },

  // Menu commands
  onMenuCommand: (callback) => {
    const channels = ['menu:open', 'menu:save', 'menu:save-as', 'menu:undo', 'menu:redo'];
    const wrapped = channels.map((ch) => {
      const listener = () => callback(ch);
      ipcRenderer.on(ch, listener);
      return [ch, listener];
    });
    return () => wrapped.forEach(([ch, l]) => ipcRenderer.removeListener(ch, l));
  },

  // Unsaved-changes tracking (main intercepts window close / Cmd+Q when dirty)
  setDirty: (dirty) => ipcRenderer.send('app:set-dirty', dirty),

  // Local error log (best-effort, one-way — no response expected)
  logError: (payload) => ipcRenderer.send('log:renderer-error', payload),
});
