// Markdown to safe HTML.
//
// Two things matter here beyond "render markdown":
//
// 1. Every top-level block is rendered inside its own <div data-line="N">
//    wrapper. That gives scroll sync an exact, verifiable anchor per block
//    instead of an estimated percentage, and the wrapper is emitted only when a
//    block actually produced output, so wrapper order always matches the line
//    map order.
//
// 2. All HTML passes through DOMPurify before it reaches the DOM. Markdown files
//    are ordinary files on disk and may contain raw HTML, so rendering one must
//    not be able to run script or phone home.
//
// The renderer has no Node APIs, so the app:// constants below mirror the ones
// in src/appProtocol.js (main process).

import { Marked } from 'marked'
import hljs from 'highlight.js/lib/common'
import DOMPurify from 'dompurify'

import { buildLineMap, countNewlines, isMonotonic } from './linemap.js'
import { resolveRelative } from './paths.js'

export const APP_SCHEME = 'app'
export const ASSET_ROUTE = '/__file'

/** Builds an app:// URL the main process will serve, scoped to the document. */
export function assetUrl(absolutePath) {
  return `${APP_SCHEME}://local${ASSET_ROUTE}?p=${encodeURIComponent(absolutePath)}`
}

// DOMPurify's default allow-list, with the app: scheme added so document-local
// images survive sanitisation. Without this the src attribute is stripped.
const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|app):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i

const PURIFY_CONFIG = {
  ALLOWED_URI_REGEXP,
  ADD_ATTR: ['data-line', 'align'],
  // Form and framing elements have no place in a document being read. `input` is
  // allowed here only so GFM task-list checkboxes survive; the hook below strips
  // them down to inert decoration.
  FORBID_TAGS: ['form', 'textarea', 'select', 'button', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'svg', 'math'],
  USE_PROFILES: { html: true }
}

// Set by renderMarkdown so the hooks know how to resolve relative image paths.
let currentDocDir = null

let hooksInstalled = false

function installHooks() {
  if (hooksInstalled) return
  hooksInstalled = true

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!node || !node.tagName) return

    if (node.tagName === 'INPUT') {
      const isChecked = node.hasAttribute('checked')
      // Reduce to decorative checkbox: no name, value, or interactivity.
      for (const attr of Array.from(node.attributes)) node.removeAttribute(attr.name)
      node.setAttribute('type', 'checkbox')
      node.setAttribute('disabled', '')
      if (isChecked) node.setAttribute('checked', '')
      node.setAttribute('aria-label', isChecked ? 'completed' : 'not completed')
      return
    }

    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src')
      if (!src) return
      // Leave network, data and already-rewritten app: URLs alone.
      if (/^(?:https?|data|blob|app):/i.test(src)) return
      if (!currentDocDir) return
      const absolute = resolveRelative(currentDocDir, decodeURI(src))
      if (absolute) node.setAttribute('src', assetUrl(absolute))
      return
    }

    if (node.tagName === 'A') {
      const href = node.getAttribute('href') || ''
      if (/^https?:\/\//i.test(href)) {
        node.setAttribute('rel', 'noreferrer noopener')
      }
    }
  })
}

const marked = new Marked({ gfm: true, breaks: false })

/**
 * Highlights fenced code blocks in place.
 *
 * This walks the token tree rather than using marked-highlight because that
 * plugin does its work in a `walkTokens` hook, and `marked.parser()` — which this
 * module calls per block so each block can carry its own source line — never runs
 * those hooks. Doing it here keeps highlighting working on the per-block path,
 * and also reaches code blocks nested inside lists and blockquotes.
 *
 * Setting `escaped` tells marked's code renderer that `text` is already HTML, so
 * the highlighted markup is emitted as-is instead of being escaped again.
 */
function highlightCodeTokens(tokens) {
  for (const token of tokens || []) {
    if (!token) continue

    if (token.type === 'code') {
      const language = String(token.lang || '')
        .trim()
        .split(/\s+/)[0]
        .toLowerCase()
      if (language && language !== 'text' && hljs.getLanguage(language)) {
        token.text = hljs.highlight(token.text, { language }).value
        token.escaped = true
      }
      // Unknown or absent language: left alone, so it renders as plain escaped
      // code rather than being guessed at and mis-highlighted.
      continue
    }

    if (token.type === 'list') {
      for (const item of token.items || []) highlightCodeTokens(item.tokens)
      continue
    }

    if (token.type === 'blockquote') {
      highlightCodeTokens(token.tokens)
      continue
    }

    if (token.type === 'table') {
      for (const cell of token.header || []) highlightCodeTokens(cell.tokens)
      for (const row of token.rows || []) {
        for (const cell of row) highlightCodeTokens(cell.tokens)
      }
    }
  }
}

/**
 * Renders `source` into sanitised HTML plus the block anchor map.
 *
 * Returns `{ html, lineMap, blockCount, monotonic, documentLines }`.
 * `lineMap[i].line` is the 1-based source line of the i-th wrapper in `html`.
 */
export function renderMarkdown(source, options = {}) {
  installHooks()

  const text = typeof source === 'string' ? source : ''
  currentDocDir = options.docDir || null

  const tokens = marked.lexer(text)

  // Highlight first: it mutates code tokens in place and leaves `raw` (which the
  // line map depends on) untouched.
  highlightCodeTokens(tokens)

  // Pass 1: render each top-level block on its own so blocks that produce no
  // output (whitespace, link definitions) simply do not get a wrapper.
  const fragments = new Array(tokens.length)
  const visible = new Set()

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    let html = ''
    try {
      // The reference-link table lives on the token array, not the tokens, so it
      // has to be carried across when parsing a block in isolation.
      const single = [token]
      single.links = tokens.links
      html = marked.parser(single)
    } catch (err) {
      html = `<pre class="md-render-error">${escapeHtml(err instanceof Error ? err.message : String(err))}</pre>`
    }

    if (html && html.trim() !== '') {
      fragments[i] = html
      visible.add(i)
    }
  }

  // Pass 2: same walk, same predicate, so line map and wrappers stay aligned.
  const lineMap = buildLineMap(tokens, (_token, index) => visible.has(index))

  let assembled = ''
  for (let i = 0; i < lineMap.length; i += 1) {
    const entry = lineMap[i]
    const fragment = fragments[entry.tokenIndex]
    if (fragment === undefined || fragment === null) continue
    assembled += `<div class="md-block" data-line="${entry.line}">${fragment}</div>\n`
  }

  const html = DOMPurify.sanitize(assembled, PURIFY_CONFIG)

  return {
    html,
    lineMap,
    blockCount: lineMap.length,
    monotonic: isMonotonic(lineMap),
    documentLines: countNewlines(text) + 1
  }
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Sanitises a standalone HTML string (used by tests and the error banner). */
export function sanitizeHtml(html) {
  installHooks()
  return DOMPurify.sanitize(html, PURIFY_CONFIG)
}

export { hljs }
