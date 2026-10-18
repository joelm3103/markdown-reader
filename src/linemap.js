// Source-line map for scroll sync.
//
// Pure functions over marked's top-level token list — no DOM, no marked import,
// so this can be exercised directly by the smoke test.
//
// Markdown is lexed into a flat list of top-level tokens whose `raw` strings
// concatenate back into the original source. Counting newlines as we walk that
// list therefore gives the exact 1-based source line where each block starts.
// Scroll sync anchors on those lines instead of on raw percentages, which is
// what keeps the two panes together when a long code block or table sits in the
// middle of a document.

/** Number of newline characters in a chunk of source. */
export function countNewlines(raw) {
  if (typeof raw !== 'string') return 0
  let count = 0
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) === 10) count += 1
  }
  return count
}

/**
 * Builds `[{ index, tokenIndex, line, type }]` for the blocks that produce
 * visible output.
 *
 * `index` is the ordinal among visible blocks (which is also the position of the
 * matching wrapper element in the rendered HTML); `tokenIndex` is the position in
 * the original token array, so the caller can pair a map entry back to the HTML
 * fragment it rendered for that token.
 *
 * Whitespace-only and definition tokens are still walked — they occupy source
 * lines — but are not given an index, because they render to nothing and so have
 * no anchor element. `isVisible` may be overridden by the caller, which is what
 * keeps this in step with the fragment renderer.
 */
export function buildLineMap(tokens, isVisible = defaultIsVisible) {
  const map = []
  let line = 1
  let index = 0

  for (let tokenIndex = 0; tokenIndex < (tokens || []).length; tokenIndex += 1) {
    const token = tokens[tokenIndex]
    if (isVisible(token, tokenIndex)) {
      map.push({ index, tokenIndex, line, type: token ? token.type : 'unknown' })
      index += 1
    }
    line += countNewlines(token && token.raw)
  }

  return map
}

/** Token types that never produce output on their own. */
function defaultIsVisible(token) {
  if (!token) return false
  return token.type !== 'space' && token.type !== 'def'
}

/** Total source lines, used to size the proportional fallback. */
export function totalLines(tokens) {
  let line = 1
  for (const token of tokens || []) line += countNewlines(token && token.raw)
  return line
}

/**
 * Nearest block at or before `line` — the anchor the preview should scroll to.
 * Returns -1 when the map is empty.
 */
export function blockIndexForLine(map, line) {
  if (!Array.isArray(map) || map.length === 0) return -1

  let low = 0
  let high = map.length - 1
  let found = 0

  while (low <= high) {
    const mid = (low + high) >> 1
    if (map[mid].line <= line) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return found
}

/** Source line for a block index, or 1 when out of range. */
export function lineForBlockIndex(map, index) {
  if (!Array.isArray(map) || map.length === 0) return 1
  if (index < 0) return map[0].line
  if (index >= map.length) return map[map.length - 1].line
  return map[index].line
}

/**
 * True when the map is usable as an anchor set: non-empty, and every block line
 * increases. A non-monotonic map means the lexer produced something unexpected,
 * and the caller should fall back to proportional scrolling.
 */
export function isMonotonic(map) {
  if (!Array.isArray(map) || map.length === 0) return false
  for (let i = 1; i < map.length; i += 1) {
    if (map[i].line < map[i - 1].line) return false
  }
  return true
}

/**
 * Source line -> pixel offset, using measured block offsets.
 *
 * Between two anchors the value is interpolated in proportion to source lines,
 * so scrolling through a 200-line section still moves the other pane smoothly
 * instead of jumping anchor to anchor.
 */
export function lineToOffset(map, offsets, line) {
  if (!Array.isArray(map) || map.length === 0) return 0
  if (!Array.isArray(offsets) || offsets.length !== map.length) return 0

  const i = blockIndexForLine(map, line)
  if (i < 0) return 0

  const anchorOffset = offsets[i] || 0
  const next = map[i + 1]
  if (!next) return anchorOffset

  const lineSpan = next.line - map[i].line
  if (lineSpan <= 0) return anchorOffset

  const t = Math.max(0, Math.min(1, (line - map[i].line) / lineSpan))
  return anchorOffset + ((offsets[i + 1] || anchorOffset) - anchorOffset) * t
}

/**
 * Pixel offset -> source line. The inverse of lineToOffset, used when the
 * preview pane is the one being scrolled.
 */
export function offsetToLine(map, offsets, offset) {
  if (!Array.isArray(map) || map.length === 0) return 1
  if (!Array.isArray(offsets) || offsets.length !== map.length) return 1

  if (offset <= (offsets[0] || 0)) return map[0].line

  // Offsets increase with document order, so a linear scan finds the last anchor
  // at or above the viewport top.
  let i = 0
  for (let k = 0; k < offsets.length; k += 1) {
    if ((offsets[k] || 0) <= offset) i = k
    else break
  }

  const next = map[i + 1]
  if (!next) return map[i].line

  const pixelSpan = (offsets[i + 1] || 0) - (offsets[i] || 0)
  if (pixelSpan <= 0) return map[i].line

  const t = Math.max(0, Math.min(1, (offset - (offsets[i] || 0)) / pixelSpan))
  return Math.round(map[i].line + (next.line - map[i].line) * t)
}

/**
 * Percentage fallback used when the anchor map is unusable. Crude on purpose:
 * it exists so scrolling still does something sensible rather than nothing.
 */
export function proportionalOffset(value, valueMax, targetMax) {
  if (!Number.isFinite(value) || !Number.isFinite(valueMax) || valueMax <= 0) return 0
  const t = Math.max(0, Math.min(1, value / valueMax))
  return t * (Number.isFinite(targetMax) ? Math.max(0, targetMax) : 0)
}
