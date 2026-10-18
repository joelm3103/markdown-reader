'use strict'

// Filesystem helpers shared by the main process and scripts/smoke.js.
//
// Deliberately free of any `electron` import so it can be exercised in plain
// Node/Electron tests without a window. Every read and write in the app funnels
// through here, so this is the single place where path safety is enforced.

const fs = require('node:fs')
const path = require('node:path')

// Files the reader will show in the folder tree.
const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt'])

const IS_WINDOWS = process.platform === 'win32'

function isMarkdownFile(name) {
  return MARKDOWN_EXTS.has(path.extname(name).toLowerCase())
}

/**
 * Windows paths are case-insensitive, so comparisons must be too.
 * Returns a path with separators normalised and, on Windows, lower-cased for
 * comparison purposes only — never use the result to open a file.
 */
function normalizeForCompare(target) {
  const resolved = path.resolve(target)
  return IS_WINDOWS ? resolved.toLowerCase() : resolved
}

/**
 * True when `target` is `root` itself or lives beneath it.
 *
 * The trailing separator in the prefix test matters: without it, a sibling such
 * as `C:\notes-evil` would look like it lives under `C:\notes`.
 */
function isInside(target, root) {
  const t = normalizeForCompare(target)
  const r = normalizeForCompare(root)
  if (t === r) return true
  return t.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

/**
 * Access check used by the IPC layer.
 *
 * `scope` is `{ root, files }`:
 *   root  — the folder the user opened, or null when they only opened a file
 *   files — absolute paths of files the user explicitly opened or dropped
 *
 * A dropped file counts as explicit consent, which is why it is allowed even
 * outside the open folder.
 */
function isPathAllowed(target, scope) {
  if (typeof target !== 'string' || target.length === 0) return false
  if (!scope) return false

  const candidate = normalizeForCompare(target)

  if (scope.root && isInside(candidate, scope.root)) return true

  if (Array.isArray(scope.files)) {
    for (const allowed of scope.files) {
      if (normalizeForCompare(allowed) === candidate) return true
    }
  }

  return false
}

/**
 * Lists one directory level. Never recurses — the whole point of this app is
 * that opening a folder does not scan a vault.
 */
function listDir(dirPath) {
  let entries
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch (err) {
    return { ok: false, error: describeFsError(err) }
  }

  const dirs = []
  const files = []

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue

    const full = path.join(dirPath, entry.name)

    if (entry.isDirectory()) {
      dirs.push({ name: entry.name, path: full, type: 'dir' })
      continue
    }

    if (entry.isFile() && isMarkdownFile(entry.name)) {
      files.push({ name: entry.name, path: full, type: 'file' })
    }
  }

  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  dirs.sort(byName)
  files.sort(byName)

  return { ok: true, path: dirPath, entries: [...dirs, ...files] }
}

function readFile(filePath) {
  try {
    let content = fs.readFileSync(filePath, 'utf8')
    // Strip a UTF-8 BOM so the first heading renders instead of showing as text.
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
    return { ok: true, path: filePath, content }
  } catch (err) {
    return { ok: false, error: describeFsError(err) }
  }
}

function saveFile(filePath, content) {
  if (typeof content !== 'string') {
    return { ok: false, error: 'Content must be a string.' }
  }
  try {
    fs.writeFileSync(filePath, content, 'utf8')
    return { ok: true, path: filePath, bytes: Buffer.byteLength(content, 'utf8') }
  } catch (err) {
    return { ok: false, error: describeFsError(err) }
  }
}

function describeFsError(err) {
  if (err && typeof err === 'object' && 'code' in err) {
    switch (err.code) {
      case 'ENOENT':
        return 'That file or folder no longer exists.'
      case 'EACCES':
      case 'EPERM':
        return 'Permission denied.'
      case 'EISDIR':
        return 'That is a folder, not a file.'
      case 'ENOTDIR':
        return 'Part of that path is not a folder.'
      case 'EBUSY':
        return 'The file is locked by another program.'
      default:
        return `${err.code}: ${err.message}`
    }
  }
  return err instanceof Error ? err.message : String(err)
}

module.exports = {
  MARKDOWN_EXTS,
  isMarkdownFile,
  isInside,
  isPathAllowed,
  listDir,
  readFile,
  saveFile,
  describeFsError
}
