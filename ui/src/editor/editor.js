// The text pane of the Files window (files.jsx): CodeMirror 6 over one file.
// Built into a file of its own, `static/_v/hammerola-editor.js`, which the
// window imports the first time it opens a text file, so a page that never
// opens one never downloads it.
//
// It imports CodeMirror, Lezer and this folder and nothing else
// (tests/test_ui_editor.py): a module shared with the entry would be reached
// through the entry's minified export names, and a tab opened before a deploy
// would load the new chunk against its old entry. What it needs from the page
// comes in as arguments, and the colours as the page's CSS variables
// (static/_v/tokens.css), which resolve against the theme on `<html>`.

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';

const LANGUAGES = new Map([['python', python], ['json', json]]);

// `classHighlighter` marks tokens with `tok-*` classes; their colours are the
// hub's `--code-*` tokens. A class not named here is drawn in the text colour.
const look = (dark) => EditorView.theme({
  '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--card-bg)', fontSize: '12.5px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--hmr-mono)', lineHeight: '20px' },
  '.cm-content': { caretColor: 'var(--text)' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-gutters': {
    backgroundColor: 'var(--card-bg)', color: 'var(--text-faint)', borderRight: '1px solid var(--line-soft)',
  },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--accent-bg)',
  },
  '.cm-searchMatch': { backgroundColor: 'var(--warn-bg)', outline: '1px solid var(--warn-line)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent-bg)' },
  '.cm-panels': { backgroundColor: 'var(--sunken-bg)', color: 'var(--text)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-textfield': {
    backgroundColor: 'var(--card-bg)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: '4px',
  },
  '.cm-button': {
    backgroundImage: 'none', backgroundColor: 'var(--card-bg)', color: 'var(--text)',
    border: '1px solid var(--line)', borderRadius: '4px',
  },
  '.tok-keyword': { color: 'var(--code-keyword)' },
  '.tok-string, .tok-string2': { color: 'var(--code-string)' },
  '.tok-number, .tok-bool, .tok-atom, .tok-literal': { color: 'var(--code-number)' },
  '.tok-comment, .tok-meta': { color: 'var(--code-comment)' },
  '.tok-definition, .tok-className, .tok-typeName': { color: 'var(--code-name)' },
}, { dark });

/**
 * CodeMirror over `text`, inside `element`. `language` is a name out of
 * `editorLanguage` (filesview.js), '' for plain text; `readOnly` refuses every
 * change, and `setReadOnly(flag)` turns that on and off in place, the text,
 * the cursor and the scroll kept; Ctrl/Cmd+Z undoes a change and
 * Ctrl+Y or Shift+Cmd+Z redoes it; `onChange(text)`, when given, hears each
 * change, undone and redone ones too; `theme` is the page's, `light` or `dark`.
 * -> `{getText, setReadOnly, destroy}`.
 */
export function mount(element, { text, language, readOnly, onChange, theme }) {
  const highlight = LANGUAGES.get(language);
  const locked = new Compartment();
  const view = new EditorView({
    parent: element,
    state: EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        drawSelection(),
        search(),
        history(),
        keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]),
        syntaxHighlighting(classHighlighter),
        highlight ? highlight() : [],
        locked.of(EditorState.readOnly.of(!!readOnly)),
        onChange ? EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString());
        }) : [],
        look(theme === 'dark'),
      ],
    }),
  });
  return {
    getText: () => view.state.doc.toString(),
    setReadOnly: (flag) => view.dispatch({ effects: locked.reconfigure(EditorState.readOnly.of(!!flag)) }),
    destroy: () => view.destroy(),
  };
}
