// The Settings card at the right end of the floating toolbar, and the one answer
// it holds: whether the model is drawn at the display's full density.
//
// NOTHING IS MOUNTED, this directory's arrangement (viewmenu.test.js): the real
// prototype over a hand-spelled state, the real `computed()` and handlers. `sync`
// is the REAL one, because the answer only matters once it has reached the
// viewport — and that is the `hmr:state` event it puts on the window.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { STATE } from '../src/events.js'
import { readRetina } from '../src/store.js'
import { css } from '../src/style.jsx'
import { makeComponent, replaceState } from './component.js'
import { texts } from './eltree.js'

const click = { stopPropagation() {}, preventDefault() {} }

// A storage double for the whole file: this runner has no `localStorage`
// (store.test.js says why), and the toggle remembers its answer there.
beforeEach(() => {
  const cells = new Map()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k) => (cells.has(k) ? cells.get(k) : null),
      setItem: (k, v) => { cells.set(k, String(v)) },
      removeItem: (k) => { cells.delete(k) },
    },
    configurable: true, writable: true,
  })
})

afterEach(() => {
  delete globalThis.localStorage
  vi.restoreAllMocks()
})

/** The page with the toolbar's menus spelled out, all shut unless asked. */
function component(over = {}) {
  return makeComponent(HammerolaViewer, {
    setState: replaceState,
    state: {
      retina: true, settingsOpen: false, viewsOpen: false, opsOpen: false,
      ...over,
    },
  })
}

/** The detail of every `hmr:state` event from here on. */
function listening() {
  const seen = []
  const listen = (event) => seen.push(event.detail)
  window.addEventListener(STATE, listen)
  onTestFinished(() => window.removeEventListener(STATE, listen))
  return seen
}

describe('the Settings card', () => {
  it('opens on its button and shuts the other popovers, token or not', () => {
    // Unlike `Add primitive` it is drawn for a reader with no token: what it
    // holds is about this screen, not about the model.
    const c = component({
      token: null, viewsOpen: true, opsOpen: true, revOpen: true, dlOpen: true,
      tokenPop: true,
    })
    expect(css(c.computed().settingsMenuStyle).display).toBe('none')

    c.computed().tSettings(click)
    expect(c.state.settingsOpen).toBe(true)
    for (const other of ['viewsOpen', 'opsOpen', 'revOpen', 'dlOpen', 'tokenPop']) {
      expect(c.state[other], other).toBe(false)
    }
    expect(css(c.computed().settingsMenuStyle).display).toBe('block')
    expect(texts(c.render())).toContain('Settings')
    expect(texts(c.render())).toContain('Retina resolution')

    c.computed().tSettings(click)
    expect(css(c.computed().settingsMenuStyle).display).toBe('none')
  })

  it('shuts when either of the other two toolbar menus opens', () => {
    // Three cards open upwards from buttons a few pixels apart; two at once
    // would overlap.
    const views = component({ settingsOpen: true })
    views.computed().viewsToggle(click)
    expect(views.state.settingsOpen).toBe(false)

    const ops = component({ settingsOpen: true })
    ops.computed().tProposal(click)
    expect(ops.state.settingsOpen).toBe(false)
  })

  it('goes away on a click anywhere else on the page', () => {
    const c = component({ settingsOpen: true })
    c.computed().rootClick()
    expect(c.state.settingsOpen).toBe(false)
  })

  it('raises the whole toolbar while it is open, and puts it back after', () => {
    // The same layer the other two menus of this toolbar raise it to, and for
    // the same reason (viewmenu.test.js): the card opens INSIDE the toolbar.
    const c = component()
    expect(css(c.computed().toolbarStyle).zIndex).toBe('12')

    c.computed().tSettings(click)
    expect(css(c.computed().toolbarStyle).zIndex).toBe('17')

    c.computed().tSettings(click)
    expect(css(c.computed().toolbarStyle).zIndex).toBe('12')
  })

  it('flips Retina resolution on its row, remembers it and tells the viewport', () => {
    const seen = listening()
    const c = component({ settingsOpen: true })
    expect(c.computed().retinaMark).toBe('✓')

    c.computed().toggleRetina(click)
    expect(c.state.retina).toBe(false)
    expect(seen.at(-1).retina).toBe(false)
    expect(readRetina()).toBe(false)
    expect(c.computed().retinaMark).toBe('')

    c.computed().toggleRetina(click)
    expect(c.state.retina).toBe(true)
    expect(seen.at(-1).retina).toBe(true)
    expect(readRetina()).toBe(true)
  })

  it('comes up with the answer this browser remembered', () => {
    // The last link of "remembered": a page built after the reader turned it
    // off must start off, or the model is drawn at 2x under an unticked box.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(new HammerolaViewer({}).state.retina).toBe(true)

    localStorage.setItem('hammerola.retina', 'off')
    expect(new HammerolaViewer({}).state.retina).toBe(false)
  })
})
