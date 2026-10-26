'use strict'

// Persisted UI state (window bounds, last opened folder, view mode, tabs).
//
// The app ships as a portable folder, so settings prefer to live next to the
// executable and only fall back to Electron's userData when that location is not
// writable (Program Files, a read-only USB stick, a mounted image).
//
// In development `process.execPath` points at node_modules/electron, so writing
// beside it would pollute the source tree — hence the app.isPackaged check.

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const FILE_NAME = 'markdown-reader-settings.json'

const DEFAULTS = Object.freeze({
  windowBounds: { width: 1200, height: 820 },
  lastFolder: null,
  mode: 'split',
  // Multi-document tabs are on unless the user turned them off. Only the
  // preference is persisted; open tabs themselves are session-only.
  tabs: true
})

const VALID_MODES = new Set(['split', 'source', 'preview'])

let cachedPath = null

function isDirWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

function resolveSettingsPath() {
  if (cachedPath) return cachedPath

  if (app.isPackaged) {
    const portableDir = path.dirname(process.execPath)
    if (isDirWritable(portableDir)) {
      // If a settings file already exists but is read-only, do not pretend we
      // can update it — fall through to userData instead.
      const candidate = path.join(portableDir, FILE_NAME)
      let usable = true
      if (fs.existsSync(candidate)) {
        try {
          fs.accessSync(candidate, fs.constants.W_OK)
        } catch {
          usable = false
        }
      }
      if (usable) {
        cachedPath = candidate
        return cachedPath
      }
    }
  }

  cachedPath = path.join(app.getPath('userData'), FILE_NAME)
  return cachedPath
}

function sanitize(raw) {
  const out = { ...DEFAULTS }
  if (!raw || typeof raw !== 'object') return out

  const bounds = raw.windowBounds
  if (bounds && typeof bounds === 'object') {
    const width = Number(bounds.width)
    const height = Number(bounds.height)
    out.windowBounds = {
      width: Number.isFinite(width) ? Math.max(400, Math.min(10000, Math.round(width))) : DEFAULTS.windowBounds.width,
      height: Number.isFinite(height) ? Math.max(300, Math.min(10000, Math.round(height))) : DEFAULTS.windowBounds.height
    }
    if (Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
      out.windowBounds.x = Math.round(bounds.x)
      out.windowBounds.y = Math.round(bounds.y)
    }
  }

  if (typeof raw.lastFolder === 'string' && raw.lastFolder.length > 0) {
    out.lastFolder = raw.lastFolder
  }

  if (typeof raw.mode === 'string' && VALID_MODES.has(raw.mode)) {
    out.mode = raw.mode
  }

  if (typeof raw.tabs === 'boolean') {
    out.tabs = raw.tabs
  }

  return out
}

function load() {
  try {
    const raw = fs.readFileSync(resolveSettingsPath(), 'utf8')
    return sanitize(JSON.parse(raw))
  } catch {
    // Missing or corrupt settings are not an error — fall back to defaults.
    return sanitize(null)
  }
}

function save(settings) {
  const target = resolveSettingsPath()
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(sanitize(settings), null, 2), 'utf8')
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Merges a partial update into what is already on disk and persists it. */
function update(patch) {
  return save({ ...load(), ...patch })
}

module.exports = { load, save, update, resolveSettingsPath, DEFAULTS }
