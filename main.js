'use strict'

const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron')

const fsapi = require('./src/fsapi')
const settings = require('./src/settings')
const appProtocol = require('./src/appProtocol')

const APP_ROOT = __dirname

let mainWindow = null
let settingsState = settings.load()

// Renderer-owned state mirrored here so the main process can guard the window
// close and enable/disable menu items. `dirty` is the active document; `anyDirty`
// is every open document, because an inactive tab with unsaved changes must also
// block the window from closing.
let docState = { dirty: false, anyDirty: false, hasFile: false, title: 'markdown-reader' }

// Set once the renderer has resolved its unsaved-changes prompt.
let allowClose = false

// Paths the renderer is permitted to read/write: the folder the user opened via
// the native dialog, plus files they explicitly opened or dropped.
let scope = { root: null, files: [] }

// The document currently on screen. Its folder is where relative images are
// resolved from, so it is tracked explicitly rather than inferred from `scope`.
let currentDocPath = null

function rendererBundleExists() {
  return fs.existsSync(path.join(APP_ROOT, 'renderer', 'index.html'))
}

function currentDocDir() {
  if (currentDocPath) return path.dirname(currentDocPath)
  return scope.root || null
}

function syncAssetScope() {
  appProtocol.setAssetScope({ root: scope.root, files: scope.files, docDir: currentDocDir() })
}

function persistBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMaximized() || mainWindow.isFullScreen()) return
  settingsState = { ...settingsState, windowBounds: mainWindow.getBounds() }
  settings.update({ windowBounds: settingsState.windowBounds })
}

function createWindow() {
  const bounds = settingsState.windowBounds || settings.DEFAULTS.windowBounds

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 520,
    minHeight: 360,
    show: false,
    backgroundColor: '#1c1d21',
    title: 'markdown-reader',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  mainWindow.on('close', (event) => {
    if (!allowClose && (docState.anyDirty || docState.dirty)) {
      event.preventDefault()
      mainWindow.webContents.send('app:command', 'request-close')
      return
    }
    persistBounds()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // This app only ever shows its own UI: anything trying to navigate or open a
  // new window is either an external link or something we do not want.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${appProtocol.SCHEME}://`)) {
      event.preventDefault()
      if (/^https?:/i.test(url)) shell.openExternal(url)
    }
  })

  mainWindow.loadURL(appProtocol.RENDERER_URL)
  buildMenu()
  return mainWindow
}

function sendCommand(command, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:command', command, payload)
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin'

  const template = [
    {
      label: '&File',
      submenu: [
        { label: 'Open File…', id: 'open-file', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('open-file') },
        { label: 'Open Folder…', id: 'open-folder', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendCommand('open-folder') },
        { type: 'separator' },
        {
          label: 'Save',
          id: 'save',
          accelerator: 'CmdOrCtrl+S',
          enabled: false,
          click: () => sendCommand('save')
        },
        {
          label: 'Close File',
          id: 'close-file',
          accelerator: 'CmdOrCtrl+W',
          enabled: false,
          click: () => sendCommand('close-file')
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: '&Edit',
      submenu: [
        // Not role:'undo' / role:'redo': those run Chromium's native undo, which
        // cannot keep CodeMirror's document (or the dirty flag) in sync. These
        // route to the editor's own history instead.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendCommand('undo') },
        { label: 'Redo', accelerator: isMac ? 'Shift+Cmd+Z' : 'Ctrl+Y', click: () => sendCommand('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: '&View',
      submenu: [
        { label: 'Split', accelerator: 'CmdOrCtrl+1', click: () => sendCommand('mode', 'split') },
        { label: 'Source', accelerator: 'CmdOrCtrl+2', click: () => sendCommand('mode', 'source') },
        { label: 'Preview', accelerator: 'CmdOrCtrl+3', click: () => sendCommand('mode', 'preview') },
        { type: 'separator' },
        {
          label: 'Toggle Editing',
          id: 'toggle-editing',
          accelerator: 'CmdOrCtrl+E',
          click: () => sendCommand('toggle-editing')
        },
        { type: 'separator' },
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => sendCommand('toggle-sidebar')
        },
        {
          // Checkbox, not a plain toggle: the renderer decides whether the
          // change actually happened (closing other tabs can be cancelled), and
          // app:set-tabs puts this item back in step afterwards.
          label: 'Tabs',
          id: 'tabs',
          type: 'checkbox',
          checked: Boolean(settingsState.tabs),
          click: (item) => sendCommand('toggle-tabs', item.checked)
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        {
          label: 'Toggle Developer Tools',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => mainWindow && mainWindow.webContents.toggleDevTools()
        }
      ]
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'About markdown-reader',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About markdown-reader',
              message: `markdown-reader ${app.getVersion()}`,
              detail:
                'A fast, portable markdown reader.\n\n' +
                'Ctrl+1–3 switch between Split, Source and Preview.\n' +
                'Ctrl+S saves; editing is never autosaved.\n\n' +
                `Settings file: ${settings.resolveSettingsPath()}`
            })
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function setSaveEnabled(enabled) {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  const item = menu.getMenuItemById('save')
  if (item) item.enabled = Boolean(enabled)
}

function setCloseFileEnabled(enabled, label) {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  const item = menu.getMenuItemById('close-file')
  if (item) {
    item.enabled = Boolean(enabled)
    if (typeof label === 'string' && label.length > 0) item.label = label
  }
}

function setTabsChecked(checked) {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  const item = menu.getMenuItemById('tabs')
  if (item) item.checked = Boolean(checked)
}

function refreshTitle() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setTitle(docState.title || 'markdown-reader')
}

/**
 * Finds a markdown file passed on the command line.
 * `electron . file.md` puts the file at argv[2]; a packaged build puts it at
 * argv[1]. Flags and the app path itself are ignored.
 */
function fileFromArgv() {
  const args = process.argv.slice(app.isPackaged ? 1 : 2)
  for (const arg of args) {
    if (!arg || arg.startsWith('-')) continue
    const candidate = path.resolve(arg)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // Not a path we can use; keep looking.
    }
  }
  return null
}

function fileFilters() {
  return [
    { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
    { name: 'Text', extensions: ['txt'] },
    { name: 'All Files', extensions: ['*'] }
  ]
}

// Reads a file into the renderer: the renderer drives this via fs:read and
// app:set-current-doc, so the only job here is remembering the last folder so
// the tree can reopen it next launch.
function registerOpenedFile(filePath) {
  if (!scope.files.includes(filePath)) scope.files = [...scope.files, filePath]
  currentDocPath = filePath
  syncAssetScope()

  settingsState = { ...settingsState, lastFolder: path.dirname(filePath) }
  settings.update({ lastFolder: settingsState.lastFolder })
}

function registerIpc() {
  ipcMain.handle('app:init', () => ({
    version: app.getVersion(),
    platform: process.platform,
    initialFile: fileFromArgv(),
    lastFolder: settingsState.lastFolder,
    mode: settingsState.mode,
    tabs: settingsState.tabs !== false
  }))

  // The tabs on/off preference. The renderer calls this only once a toggle has
  // actually completed (or been cancelled and reverted), so the menu checkbox
  // and the persisted value always agree with what is on screen.
  ipcMain.handle('app:set-tabs', (_event, enabled) => {
    const value = Boolean(enabled)
    settingsState = { ...settingsState, tabs: value }
    settings.update({ tabs: value })
    setTabsChecked(value)
    return { ok: true, tabs: value }
  })

  ipcMain.handle('app:settings', (_event, patch) => {
    if (patch && typeof patch === 'object') {
      settingsState = { ...settingsState, ...patch }
      settings.update(patch)
    }
    return { ok: true }
  })

  ipcMain.handle('fs:list', (_event, dirPath) => {
    if (!fsapi.isPathAllowed(dirPath, scope)) {
      return { ok: false, error: 'That folder is outside the opened folder.' }
    }
    return fsapi.listDir(dirPath)
  })

  ipcMain.handle('fs:read', (_event, filePath) => {
    if (!fsapi.isPathAllowed(filePath, scope)) {
      return { ok: false, error: 'That file is outside the opened folder.' }
    }
    return fsapi.readFile(filePath)
  })

  ipcMain.handle('fs:save', (_event, payload) => {
    const filePath = payload && payload.path
    if (!fsapi.isPathAllowed(filePath, scope)) {
      return { ok: false, error: 'That file is outside the opened folder.' }
    }
    return fsapi.saveFile(filePath, payload.content)
  })

  // Native dialogs. The folder scope is only ever set here, in the main process.
  ipcMain.handle('dialog:open-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open markdown file',
      properties: ['openFile'],
      filters: fileFilters()
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    const filePath = result.filePaths[0]
    if (!scope.files.includes(filePath)) scope.files = [...scope.files, filePath]
    syncAssetScope()
    registerOpenedFile(filePath)
    return { ok: true, path: filePath }
  })

  ipcMain.handle('dialog:open-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open folder',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    scope = { root: result.filePaths[0], files: [] }
    syncAssetScope()
    settingsState = { ...settingsState, lastFolder: scope.root }
    settings.update({ lastFolder: scope.root })
    return { ok: true, path: scope.root }
  })

  // Dropped files bypass the folder dialog, so they are registered explicitly.
  ipcMain.handle('app:register-dropped', (_event, filePath) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return { ok: false, error: 'No path supplied.' }
    }
    let stat
    try {
      stat = fs.statSync(filePath)
    } catch (err) {
      return { ok: false, error: fsapi.describeFsError(err) }
    }

    if (stat.isDirectory()) {
      scope = { root: filePath, files: [] }
      syncAssetScope()
      settingsState = { ...settingsState, lastFolder: filePath }
      settings.update({ lastFolder: filePath })
      return { ok: true, type: 'dir', path: filePath }
    }

    if (!stat.isFile()) return { ok: false, error: 'Drop a markdown file or a folder.' }

    if (!scope.files.includes(filePath)) scope.files = [...scope.files, filePath]
    syncAssetScope()
    return { ok: true, type: 'file', path: filePath }
  })

  ipcMain.handle('app:set-current-doc', (_event, filePath) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      currentDocPath = null
      syncAssetScope()
      return { ok: true }
    }
    currentDocPath = filePath
    if (!scope.files.includes(filePath)) scope.files = [...scope.files, filePath]
    syncAssetScope()
    return { ok: true }
  })

  ipcMain.handle('app:set-doc-state', (_event, next) => {
    if (next && typeof next === 'object') {
      docState = {
        dirty: Boolean(next.dirty),
        anyDirty: Boolean(next.anyDirty === undefined ? next.dirty : next.anyDirty),
        hasFile: Boolean(next.hasFile),
        title: typeof next.title === 'string' && next.title.length > 0 ? next.title : 'markdown-reader'
      }
      setSaveEnabled(docState.dirty)
      setCloseFileEnabled(docState.hasFile, next.closeLabel)
      refreshTitle()
    }
    return { ok: true }
  })

  // Unsaved-changes prompt. Returns 'save' | 'discard' | 'cancel' so the renderer
  // stays in charge of actually writing the file.
  ipcMain.handle('app:confirm-discard', async (_event, message) => {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Save', 'Discard changes', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      message: message || 'You have unsaved changes.',
      detail: 'Saving writes to the file on disk. Editing is never autosaved.'
    })
    if (result.response === 0) return 'save'
    if (result.response === 1) return 'discard'
    return 'cancel'
  })

  ipcMain.handle('app:close', () => {
    allowClose = true
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
    return { ok: true }
  })

  ipcMain.handle('shell:open-external', (_event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'Only http and https links can be opened.' }
    }
    shell.openExternal(url)
    return { ok: true }
  })

  ipcMain.handle('app:error', (_event, info) => {
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'markdown-reader',
      message: (info && info.message) || 'Something went wrong.',
      detail: (info && info.detail) || undefined
    })
    return { ok: true }
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

appProtocol.registerScheme()

app.whenReady().then(() => {
  appProtocol.handle(APP_ROOT)

  // The folder from the last session was chosen by the user, so it is a
  // reasonable starting scope — it is only ever listed one level at a time.
  if (settingsState.lastFolder) {
    try {
      if (fs.statSync(settingsState.lastFolder).isDirectory()) {
        scope.root = settingsState.lastFolder
      }
    } catch {
      settingsState = { ...settingsState, lastFolder: null }
      settings.update({ lastFolder: null })
    }
  }

  // A file named on the command line is an explicit request to read that file, so
  // it joins the allowed scope up front. Without this the app would reject the
  // very file it was launched with, because no folder has been opened yet.
  const initialFile = fileFromArgv()
  if (initialFile) {
    scope.files = [initialFile]
    currentDocPath = initialFile
  }

  syncAssetScope()

  registerIpc()

  if (!rendererBundleExists()) {
    dialog.showErrorBox(
      'Renderer build missing',
      'The renderer has not been built yet.\n\nRun:  npm run build\n\n(or simply use  npm start , which builds first)'
    )
    app.quit()
    return
  }

  createWindow()
})
