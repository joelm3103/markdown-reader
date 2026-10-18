'use strict'

// Serves the built renderer over a privileged `app://` scheme.
//
// Why not file://: Chromium blocks ES modules loaded from file://, which Vite's
// output relies on. A registered standard scheme behaves like https for the
// renderer's purposes.
//
// The same scheme also serves images referenced by the markdown being read,
// via app://local/__file?p=<absolute path>. Those are validated against the
// current document's folder, so a document cannot pull in arbitrary files.

const fs = require('node:fs')
const path = require('node:path')
const { protocol } = require('electron')
const { isInside, isPathAllowed } = require('./fsapi')

const SCHEME = 'app'
const HOST = 'local'
const RENDERER_URL = `${SCHEME}://${HOST}/renderer/index.html`
const FILE_ROUTE = '/__file'

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8'
}

// Where document-local assets (images) may be read from. Updated by the main
// process whenever a document is opened; deliberately narrow.
let assetScope = { root: null, files: [], docDir: null }

/** Called before app ready. */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

function setAssetScope(next) {
  assetScope = {
    root: next && next.root ? next.root : null,
    files: next && Array.isArray(next.files) ? next.files : [],
    docDir: next && next.docDir ? next.docDir : null
  }
}

function isAssetAllowed(target) {
  if (assetScope.docDir && isInside(target, assetScope.docDir)) return true
  return isPathAllowed(target, assetScope)
}

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

function fileResponse(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  }
  return new Response(fs.readFileSync(filePath), {
    status: 200,
    headers: {
      'content-type': mimeFor(filePath),
      'cache-control': 'no-store'
    }
  })
}

function errorResponse(status, message) {
  return new Response(message, { status, headers: { 'content-type': 'text/plain' } })
}

/** Called after app ready. `appRoot` is the directory holding main.js. */
function handle(appRoot) {
  protocol.handle(SCHEME, async (request) => {
    let url
    try {
      url = new URL(request.url)
    } catch {
      return errorResponse(400, 'Bad request')
    }

    if (url.hostname !== HOST) return errorResponse(403, 'Forbidden')

    const pathname = decodeURIComponent(url.pathname)

    // Document-local asset (images inside the markdown being read).
    if (pathname === FILE_ROUTE) {
      const requested = url.searchParams.get('p')
      if (!requested) return errorResponse(400, 'Missing path')
      const target = path.resolve(requested)
      if (!isAssetAllowed(target)) return errorResponse(403, 'Forbidden')
      return fileResponse(target)
    }

    // Renderer bundle, served strictly from the app directory.
    const target = path.resolve(appRoot, '.' + pathname)
    if (!isInside(target, appRoot)) return errorResponse(403, 'Forbidden')
    return fileResponse(target)
  })
}

module.exports = { SCHEME, HOST, RENDERER_URL, FILE_ROUTE, registerScheme, handle, setAssetScope, isAssetAllowed }
