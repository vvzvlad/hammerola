// ui/src/viewport/holdkey.js — hold C and the cut is up, let go and it is gone.
//
// Most of this file is about the release that NEVER ARRIVES. A tool that is
// still up when the reader comes back does not read as a mode nobody left; it
// reads as a viewer that has broken, and every net below covers a way the keyup
// really goes missing: Cmd swallowing it on macOS, a system menu opening over
// the page, the tab going to the background, the element being torn down
// mid-hold. Those are the tests worth having here, because none of them can be
// noticed by hand — they all look like nothing happening.
//
// jsdom is enough for all of it: the whole module is `addEventListener` on the
// window and the document, and the events it reads carry no layout.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installHoldKey, isHoldKey, typingTarget } from '../src/viewport/holdkey.js'

/** A key event as the browser delivers one, bubbling from `target`. */
function key(type, init = {}, target = document.body) {
  const event = new KeyboardEvent(type, {
    bubbles: true, cancelable: true, code: 'KeyC', key: 'c', ...init,
  })
  target.dispatchEvent(event)
  return event
}

/** Run `fn` with the document reporting itself as hidden, then put it back.
 *
 *  `document.visibilityState` lives on the prototype as a getter with no setter,
 *  so it is shadowed rather than assigned — and removed again afterwards, or
 *  every test that runs later inherits a backgrounded tab.
 */
function hidden(fn) {
  Object.defineProperty(document, 'visibilityState',
                        { value: 'hidden', configurable: true })
  try {
    fn()
  } finally {
    delete document.visibilityState
  }
}

describe('isHoldKey', () => {
  it('matches the PHYSICAL key, so a Cyrillic layout still works', () => {
    // The same key produces "с" (U+0441) there, and `key` would not match.
    expect(isHoldKey({ code: 'KeyC', key: 'с' })).toBe(true)
  })

  it('does not match another key that happens to type a c', () => {
    expect(isHoldKey({ code: 'KeyV', key: 'c' })).toBe(false)
  })

  it('falls back to `key` for an input path that reports no code', () => {
    expect(isHoldKey({ key: 'c' })).toBe(true)
    expect(isHoldKey({ key: 'C' })).toBe(true)
    expect(isHoldKey({ key: 'v' })).toBe(false)
    expect(isHoldKey({})).toBe(false)
  })
})

describe('typingTarget', () => {
  const focused = (html) => {
    document.body.innerHTML = html
    const el = document.body.firstElementChild
    el.focus()
    return el
  }

  afterEach(() => { document.body.innerHTML = '' })

  it('is true for the things a sentence is written into', () => {
    focused('<textarea></textarea>')
    expect(typingTarget()).toBe(true)
    focused('<input type="text">')
    expect(typingTarget()).toBe(true)
    focused('<input>')                      // no type at all is a text input
    expect(typingTarget()).toBe(true)
  })

  it('is true for a select, which jumps to an option by its first letter', () => {
    focused('<select><option>c</option></select>')
    expect(typingTarget()).toBe(true)
  })

  it('is true for a contenteditable', () => {
    const el = focused('<div contenteditable="true"></div>')
    // jsdom does not implement isContentEditable off the attribute.
    Object.defineProperty(el, 'isContentEditable', { value: true })
    expect(typingTarget()).toBe(true)
  })

  it('is FALSE for the library\'s own inputs, which are not text at all', () => {
    // The tab strip is `<input>` and so are the Clip panel's checkboxes. Under
    // an "any input" rule one click on a checkbox would cost the reader the
    // shortcut with nothing on screen to explain it.
    focused('<input type="checkbox">')
    expect(typingTarget()).toBe(false)
    focused('<input type="radio">')
    expect(typingTarget()).toBe(false)
    focused('<input type="range">')
    expect(typingTarget()).toBe(false)
    focused('<button></button>')
    expect(typingTarget()).toBe(false)
  })

  it('is false when nothing is focused at all', () => {
    document.body.innerHTML = ''
    expect(typingTarget()).toBe(false)
  })
})

describe('installHoldKey', () => {
  let hold
  let release
  let escape
  let off

  beforeEach(() => {
    hold = vi.fn()
    release = vi.fn()
    escape = vi.fn()
    off = installHoldKey({ onHold: hold, onRelease: release, onEscape: escape })
  })

  afterEach(() => {
    off()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('holds on the way down and releases on the way up', () => {
    key('keydown')
    expect(hold).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()
    key('keyup')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('ignores another key entirely', () => {
    key('keydown', { code: 'KeyX', key: 'x' })
    expect(hold).not.toHaveBeenCalled()
  })

  it('treats auto-repeat as the same press, not as a second one', () => {
    key('keydown')
    key('keydown', { repeat: true })
    key('keydown', { repeat: true })
    expect(hold).toHaveBeenCalledTimes(1)
  })

  it('releases at most once, however many endings arrive', () => {
    key('keydown')
    key('keyup')
    key('keyup')
    dispatchEvent(new Event('blur'))
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('releases nothing when nothing was held', () => {
    key('keyup')
    dispatchEvent(new Event('blur'))
    expect(release).not.toHaveBeenCalled()
  })

  it('stays out of the way of a browser or OS shortcut', () => {
    // Cmd+C is copy, and the platform may well keep its keyup to itself.
    for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
      key('keydown', { [mod]: true })
    }
    expect(hold).not.toHaveBeenCalled()
  })

  it('stays out of the way of somebody writing a comment', () => {
    document.body.innerHTML = '<textarea></textarea>'
    document.body.firstElementChild.focus()
    key('keydown')
    expect(hold).not.toHaveBeenCalled()
  })

  it('runs before anything downstream can swallow the key', () => {
    // The listeners are in the CAPTURE phase on the WINDOW, and that is not
    // decoration: the library binds a shortcut table to its own container and
    // answers a key it recognises with `stopPropagation()`. Capture on the
    // window runs first, so this still fires even if `c` joins that table.
    document.body.innerHTML = '<div></div>'
    const greedy = document.body.firstElementChild
    greedy.addEventListener('keydown', (e) => e.stopPropagation(), true)
    key('keydown', {}, greedy)
    expect(hold).toHaveBeenCalledTimes(1)
  })

  describe('the nets against a key that never comes back up', () => {
    it('takes Escape as a release, and says so separately', () => {
      const order = []
      off()
      off = installHoldKey({
        onHold: hold,
        onRelease: () => { order.push('release'); release() },
        onEscape: () => { order.push('escape'); escape() },
      })

      key('keydown')
      key('keydown', { code: 'Escape', key: 'Escape' })
      expect(order).toEqual(['release', 'escape'])
    })

    it('reports an Escape with nothing held as an escape and not a release', () => {
      // The interface still wants to hear it: Escape cancels whatever tool the
      // reader armed, hold key or not.
      key('keydown', { code: 'Escape', key: 'Escape' })
      expect(escape).toHaveBeenCalledTimes(1)
      expect(release).not.toHaveBeenCalled()
    })

    it('is not undone by a finger that never lifted after Escape', () => {
      key('keydown')
      key('keydown', { code: 'Escape', key: 'Escape' })
      key('keydown', { repeat: true })
      expect(hold).toHaveBeenCalledTimes(1)
      expect(release).toHaveBeenCalledTimes(1)
    })

    it('takes Command itself as the release, because the keyup will not come', () => {
      // Press C, then Cmd, then let C go: macOS does not deliver that keyup.
      // From the moment Cmd is down the real release cannot be relied on.
      key('keydown')
      key('keydown', { code: 'MetaLeft', key: 'Meta' })
      expect(release).toHaveBeenCalledTimes(1)
    })

    it('releases when the window loses focus', () => {
      key('keydown')
      dispatchEvent(new Event('blur'))
      expect(release).toHaveBeenCalledTimes(1)
    })

    it('releases when the page is going away', () => {
      key('keydown')
      dispatchEvent(new Event('pagehide'))
      expect(release).toHaveBeenCalledTimes(1)
    })

    it('releases when the tab goes to the background', () => {
      key('keydown')
      hidden(() => document.dispatchEvent(new Event('visibilitychange')))
      expect(release).toHaveBeenCalledTimes(1)
    })

    it('does NOT release on a visibilitychange back to visible', () => {
      key('keydown')
      document.dispatchEvent(new Event('visibilitychange'))
      expect(release).not.toHaveBeenCalled()
    })

    it('releases when the viewport is torn down mid-hold', () => {
      key('keydown')
      off()
      expect(release).toHaveBeenCalledTimes(1)
    })
  })

  it('unbinds everything on teardown', () => {
    off()
    key('keydown')
    key('keyup')
    key('keydown', { code: 'Escape', key: 'Escape' })
    dispatchEvent(new Event('blur'))
    dispatchEvent(new Event('pagehide'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(hold).not.toHaveBeenCalled()
    expect(escape).not.toHaveBeenCalled()
    // The teardown's own release is the only call, and it did not fire here:
    // nothing was held.
    expect(release).not.toHaveBeenCalled()
  })
})
