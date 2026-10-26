// Path helpers for the renderer.
//
// The renderer has no access to Node's `path`, but it does need to resolve
// relative image and link targets against the folder of the document being
// read. These handle both separators so a Windows path from IPC works as-is.

const SEPARATOR_RE = /[\\/]+$/

export function isAbsolute(p) {
  if (typeof p !== 'string' || p.length === 0) return false
  if (p.startsWith('/')) return true
  if (p.startsWith('\\\\')) return true // UNC
  return /^[a-zA-Z]:[\\/]/.test(p)
}

export function dirname(p) {
  if (typeof p !== 'string' || p.length === 0) return '.'
  const trimmed = p.replace(SEPARATOR_RE, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut < 0) return '.'
  if (cut === 0) return trimmed.slice(0, 1)
  // Keep the trailing slash of a drive root: "C:\notes" -> "C:\"
  const head = trimmed.slice(0, cut)
  if (/^[a-zA-Z]:$/.test(head)) return head + '\\'
  return head
}

export function normalize(p) {
  if (typeof p !== 'string') return ''
  const unified = p.replace(/\\/g, '/')
  const isUnc = unified.startsWith('//')
  const segments = unified.split('/')

  const out = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      const last = out[out.length - 1]
      if (last !== undefined && last !== '..' && !/^[a-zA-Z]:$/.test(last)) {
        out.pop()
      } else if (!isUnc) {
        out.push('..')
      }
      continue
    }
    out.push(segment)
  }

  const joined = out.join('\\')
  if (isUnc) return '\\\\' + joined.replace(/^\\+/, '')
  return joined
}

/** Resolves `relative` against `baseDir`; absolute inputs are normalised as-is. */
export function resolveRelative(baseDir, relative) {
  if (typeof relative !== 'string') return ''
  if (isAbsolute(relative)) return normalize(relative)
  if (!baseDir) return normalize(relative)
  return normalize(baseDir.replace(SEPARATOR_RE, '') + '\\' + relative)
}

/** True when the href points at another file rather than the network. */
export function isExternalUrl(href) {
  return typeof href === 'string' && /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(href)
}

/**
 * True when `target` is `root` itself or lives beneath it.
 *
 * Compared case-insensitively: this app is Windows-only, and the paths reaching
 * the renderer come from Windows dialogs and drag-and-drop. The trailing
 * separator matters, or a sibling like `C:\notes-evil` would match `C:\notes`.
 */
export function isPathInside(target, root) {
  if (typeof target !== 'string' || typeof root !== 'string') return false
  if (target.length === 0 || root.length === 0) return false

  const t = normalize(target).toLowerCase()
  const r = normalize(root).toLowerCase()
  if (t === r) return true

  return t.startsWith(r.endsWith('\\') ? r : r + '\\')
}

export function isMarkdownPath(p) {
  return typeof p === 'string' && /\.(md|markdown|mdown|mkd|txt)$/i.test(p)
}

/** True when two paths name the same file (normalised, case-insensitive). */
export function isSamePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length === 0 || b.length === 0) return false
  return normalize(a).toLowerCase() === normalize(b).toLowerCase()
}
