// CodeMirror 6 source pane.
//
// Markdown language support with embedded code-block highlighting, line numbers
// and a theme that matches the rest of the app. Everything the renderer needs is
// exposed as small methods so the mode switcher can drive it without knowing
// anything about CodeMirror.

import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { syntaxHighlighting, bracketMatching, indentOnInput, HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

const baseTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '14px',
      backgroundColor: 'var(--editor-bg)',
      color: 'var(--text)'
    },
    '.cm-scroller': {
      fontFamily: 'var(--mono)',
      lineHeight: '1.65',
      overflow: 'auto'
    },
    '.cm-content': { padding: '18px 0 40vh 0', caretColor: 'var(--accent)' },
    '.cm-line': { padding: '0 20px' },
    '.cm-gutters': {
      backgroundColor: 'var(--editor-bg)',
      color: 'var(--muted)',
      border: 'none',
      borderRight: '1px solid var(--border)',
      paddingRight: '4px'
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.035)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgba(90,150,240,0.28)'
    },
    '.cm-selectionMatch': { backgroundColor: 'rgba(90,150,240,0.18)' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'rgba(90,150,240,0.22)',
      outline: 'none'
    },
    '.cm-panels': { backgroundColor: 'var(--panel-bg)', color: 'var(--text)' },
    '.cm-foldPlaceholder': { backgroundColor: 'var(--panel-bg)', border: 'none', color: 'var(--muted)' }
  },
  { dark: true }
)

// Markdown flavours for the source pane: markers muted, content coloured.
const markdownHighlight = HighlightStyle.define(
  [
    { tag: t.heading, color: '#7fb2ff', fontWeight: '600' },
    { tag: t.strong, color: '#ffd479', fontWeight: '700' },
    { tag: t.emphasis, color: '#ffd479', fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--muted)' },
    { tag: t.link, color: '#66d9c8', textDecoration: 'underline' },
    { tag: t.url, color: '#7f9bb5' },
    { tag: t.quote, color: '#a8c7a0', fontStyle: 'italic' },
    { tag: t.monospace, color: '#e59cff' },
    { tag: t.list, color: '#c0c6d0' },
    { tag: t.contentSeparator, color: 'var(--muted)' },
    { tag: t.processingInstruction, color: 'var(--muted)' },
    { tag: t.labelName, color: '#e59cff' },
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: '#c792ea' },
    { tag: [t.string, t.special(t.string)], color: '#c3e88d' },
    { tag: [t.number, t.bool, t.null], color: '#f78c6c' },
    { tag: [t.comment, t.lineComment, t.blockComment], color: '#6b7a8d', fontStyle: 'italic' },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#82aaff' },
    { tag: [t.definition(t.variableName), t.variableName], color: '#d6deeb' },
    { tag: [t.typeName, t.className, t.namespace], color: '#ffcb6b' },
    { tag: [t.propertyName, t.attributeName], color: '#80cbc4' },
    { tag: t.operator, color: '#89ddff' },
    { tag: t.tagName, color: '#f07178' },
    { tag: t.invalid, color: '#ff5370' }
  ],
  { themeType: 'dark' }
)

/**
 * Creates the source editor inside `parent`.
 *
 * Callbacks:
 *   onChange(text)   — document changed by the user
 *   onScroll()       — the pane was scrolled (used for scroll sync)
 */
export function createEditor({ parent, doc = '', onChange, onScroll }) {
  // Documents open read-only; this compartment lets the renderer switch editing on
  // and off without rebuilding the editor.
  const editable = new Compartment()

  // Kept in a variable so setText() can rebuild the state with exactly the same
  // configuration (see below).
  const extensions = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    indentOnInput(),
    bracketMatching(),
    EditorState.allowMultipleSelections.of(true),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(markdownHighlight),
    baseTheme,
    editable.of(EditorView.editable.of(false)),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && typeof onChange === 'function') {
        onChange(update.state.doc.toString())
      }
    })
  ]

  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions })
  })

  const scroller = view.scrollDOM
  if (typeof onScroll === 'function') {
    scroller.addEventListener('scroll', onScroll, { passive: true })
  }

  return {
    view,

    getText() {
      return view.state.doc.toString()
    },

    /**
     * Replaces the document without reporting it as a user edit.
     *
     * The state is rebuilt rather than patched, which resets the undo history.
     * An annotation alone is not enough: history from the previous document would
     * still be live, and an undo after opening a second file could restore the
     * first file's text. Loading is not an edit, and nothing before it should be
     * undoable.
     */
    setText(text) {
      const current = view.state.doc.toString()
      if (current === text) return false
      view.setState(EditorState.create({ doc: text, extensions }))
      return true
    },

    /**
     * Replaces the document and discards its history, unconditionally.
     *
     * Unlike setText() this never short-circuits on equal text: two different
     * documents can have identical content, and swapping between them must
     * still swap histories.
     */
    resetTo(text) {
      view.setState(EditorState.create({ doc: text, extensions }))
    },

    /**
     * The live CodeMirror state: document, selection, undo history and the
     * editable compartment. Capture it when a document tab is left behind and
     * hand it back to setState() to restore everything at once.
     */
    getState() {
      return view.state
    },

    /** Swaps in a state captured with getState(), history and all. */
    setState(cmState) {
      view.setState(cmState)
    },

    focus() {
      view.focus()
    },

    /** Switches the pane between read-only and editable. */
    setEditable(value) {
      const next = Boolean(value)
      view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(next)) })
      return next
    },

    /** Whether the user can currently change the document. */
    isEditable() {
      return view.state.facet(EditorView.editable)
    },

    /**
     * Undo/redo through CodeMirror's own history.
     *
     * The Edit menu routes here rather than using Electron's role:'undo', which
     * performs a native DOM undo. CodeMirror owns the document, so a native undo
     * cannot keep its state — or this app's dirty tracking — in step.
     * Returns false when there is nothing to undo/redo.
     */
    undo() {
      return undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })
    },

    redo() {
      return redo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })
    },

    /** 1-based line number currently at the top of the viewport. */
    lineAtTop() {
      const height = scroller.scrollTop
      const block = view.lineBlockAtHeight(height)
      return view.state.doc.lineAt(block.from).number
    },

    /** Scrolls so that `line` sits at the top of the viewport. */
    scrollToLine(line) {
      const clamped = Math.max(1, Math.min(view.state.doc.lines, Math.round(line)))
      const block = view.lineBlockAt(view.state.doc.line(clamped).from)
      scroller.scrollTop = block.top
    },

    scrollTop() {
      return scroller.scrollTop
    },

    /** Scrolls the pane to an exact pixel offset (restores a reading position). */
    setScrollTop(px) {
      scroller.scrollTop = Math.max(0, Number(px) || 0)
    },

    scrollMax() {
      return Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    },

    refresh() {
      view.requestMeasure()
    },

    destroy() {
      if (typeof onScroll === 'function') scroller.removeEventListener('scroll', onScroll)
      view.destroy()
    }
  }
}
