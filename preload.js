'use strict'

// The only bridge between the renderer and the main process.
//
// The renderer never sees `require`, `fs` or any Node API: it can only call the
// named operations below, and every filesystem operation is re-checked against
// the allowed path scope in the main process.

const { contextBridge, ipcRenderer, webUtils } = require('electron')

function onCommand(handler) {
  ipcRenderer.on('app:command', (_event, command, payload) => handler(command, payload))
}

const api = {
  init: () => ipcRenderer.invoke('app:init'),

  // --- dialogs ---------------------------------------------------------------
  openFileDialog: () => ipcRenderer.invoke('dialog:open-file'),
  openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),
  confirmDiscard: (message) => ipcRenderer.invoke('app:confirm-discard', message),

  // --- filesystem ------------------------------------------------------------
  list: (dirPath) => ipcRenderer.invoke('fs:list', dirPath),
  read: (filePath) => ipcRenderer.invoke('fs:read', filePath),
  save: (filePath, content) => ipcRenderer.invoke('fs:save', { path: filePath, content }),

  // --- app state -------------------------------------------------------------
  registerDropped: (filePath) => ipcRenderer.invoke('app:register-dropped', filePath),
  setCurrentDoc: (filePath) => ipcRenderer.invoke('app:set-current-doc', filePath),
  setDocState: (state) => ipcRenderer.invoke('app:set-doc-state', state),
  saveSettings: (patch) => ipcRenderer.invoke('app:settings', patch),
  // The tabs on/off preference. Dedicated rather than part of saveSettings so
  // the main process can keep the View-menu checkbox in step with it.
  setTabs: (enabled) => ipcRenderer.invoke('app:set-tabs', enabled),
  closeConfirmed: () => ipcRenderer.invoke('app:close'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  reportError: (message, detail) => ipcRenderer.invoke('app:error', { message, detail }),

  onCommand,

  /**
   * Resolves the real path of a dropped File.
   *
   * Recent Electron removed the legacy `File.path` property, so this is the only
   * supported way to find out what was dropped. Returns '' when unavailable.
   */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },

  // Exposed so the smoke test can prove the drag-and-drop path is actually wired
  // rather than silently missing (which is how this API usually fails).
  hasWebUtils: typeof webUtils?.getPathForFile === 'function'
}

contextBridge.exposeInMainWorld('mdapi', api)
