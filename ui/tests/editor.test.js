// The text pane of the Files window (src/editor/editor.js), mounted for real:
// the contract the window, and the editing that comes after it, hold it to.
// Every case destroys the pane before it returns, so CodeMirror's first
// measurement, which jsdom cannot do, never runs.

import { redo, undo } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'

import { mount } from '../src/editor/editor.js'

/** `mount` in a box on the page, and the view it made. */
function opened(options) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const pane = mount(element, { language: '', readOnly: false, theme: 'light', ...options })
  return { element, pane, view: EditorView.findFromDOM(element.querySelector('.cm-editor')) }
}

describe('the text pane', () => {
  it('shows the text, highlighted by the language named and plain with none', () => {
    const python = opened({ text: 'def f():\n    return 1\n', language: 'python' })
    const plain = opened({ text: 'def f():\n    return 1\n' })
    try {
      expect(python.element.querySelector('.cm-content').textContent).toBe('def f():    return 1')
      expect(python.element.querySelector('.tok-keyword').textContent).toBe('def')
      expect(plain.element.querySelector('.tok-keyword')).toBeNull()
    } finally {
      python.pane.destroy()
      plain.pane.destroy()
    }
  })

  it('refuses typing when read-only, and hands back each change and the text as it stands', () => {
    const shut = opened({ text: 'a', readOnly: true })
    const onChange = vi.fn()
    const open = opened({ text: 'x = 1\r\n', onChange })
    try {
      expect([shut.view.state.readOnly, open.view.state.readOnly]).toEqual([true, false])
      // CodeMirror splits lines on `\r\n` and joins them with `\n`.
      expect(open.pane.getText()).toBe('x = 1\n')
      open.view.dispatch({ changes: { from: 4, to: 5, insert: '2' } })
      expect(onChange.mock.calls).toEqual([['x = 2\n']])
      expect(open.pane.getText()).toBe('x = 2\n')
      // Locked and unlocked in place, as the window does while a Commit runs.
      open.pane.setReadOnly(true)
      expect([open.view.state.readOnly, open.pane.getText()]).toEqual([true, 'x = 2\n'])
      shut.pane.setReadOnly(false)
      expect(shut.view.state.readOnly).toBe(false)
    } finally {
      shut.pane.destroy()
      open.pane.destroy()
    }
  })

  it('undoes and redoes a change, the window hearing each, and undoes nothing while read-only', () => {
    const onChange = vi.fn()
    const { pane, view } = opened({ text: 'x = 1\n', onChange })
    try {
      view.dispatch({ changes: { from: 4, to: 5, insert: '2' } })
      expect([undo(view), pane.getText()]).toEqual([true, 'x = 1\n'])
      expect([redo(view), pane.getText()]).toEqual([true, 'x = 2\n'])
      expect(onChange.mock.calls).toEqual([['x = 2\n'], ['x = 1\n'], ['x = 2\n']])
      pane.setReadOnly(true)
      expect([undo(view), pane.getText()]).toEqual([false, 'x = 2\n'])
    } finally {
      pane.destroy()
    }
  })

  it('leaves nothing behind once destroyed', () => {
    const { element, pane } = opened({ text: 'a' })
    pane.destroy()
    expect(element.innerHTML).toBe('')
  })
})
