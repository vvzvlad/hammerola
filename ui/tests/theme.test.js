// The canvas theme — the one viewport option a reader is allowed to change, and
// the only one of them that outlives the page.
//
// THE STORAGE IS A DOUBLE, for the reason ui/tests/store.test.js sets out at
// length and which applies word for word here: this runner has no `localStorage`
// of its own — Node's global of that name is undefined and wins over jsdom's —
// and every access in ui/src/viewport/options.js is inside a try/catch that
// reads an absent storage as "nothing was remembered". So against the bare
// runner a gutted `writeTheme` passes every assertion below. `expectTheDouble()`
// runs before each test and says that out loud, because the failure it guards
// against does not look like one: it looks like a green suite.
//
// The key is written out here rather than imported, exactly as store.test.js
// writes out its three: it is the OBSERVABLE — what a reader's browser carries
// between visits — and reusing the module's own expression would give a test
// that agrees with itself whatever the key is changed to.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { indexTree } from '../src/hub.js'
import {
  DEFAULT_THEME, displayOptions, readTheme, writeTheme,
} from '../src/viewport/options.js'

const THEME_KEY = 'hammerola.viewport_theme'

/** The smallest thing options.js can tell from the real one, plus a way to fail. */
function fakeStorage({ failing = false } = {}) {
  const cells = new Map()
  return {
    cells,
    getItem: (k) => {
      if (failing) throw new Error('storage is off')
      return cells.has(k) ? cells.get(k) : null
    },
    setItem: (k, v) => {
      if (failing) throw new Error('storage is off')
      cells.set(k, String(v))
    },
    removeItem: (k) => { cells.delete(k) },
  }
}

let storage

function install(replacement) {
  storage = replacement
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage, configurable: true, writable: true,
  })
}

function expectTheDouble() {
  if (typeof localStorage === 'undefined' || localStorage !== storage) {
    throw new Error(
      'ui/tests/theme.test.js: the storage double is not installed at the start '
      + 'of this test. Nothing below is testing anything: this runner has no '
      + '`localStorage` of its own, and every access in ui/src/viewport/options.js '
      + 'catches the absence and reports it as "nothing was remembered" — so a '
      + 'writeTheme that stores nothing passes every assertion in this file.')
  }
}

beforeEach(() => {
  install(fakeStorage())
  expectTheDouble()
})

afterEach(() => {
  vi.restoreAllMocks()
  delete globalThis.localStorage
})

describe('the remembered theme', () => {
  it('opens on light when nothing was ever stored', () => {
    // The default is the whole point of the setting: every part of the interface
    // around the viewport is light, and a dark canvas in the middle of it reads
    // as two programs sharing one window.
    expect(storage.cells.has(THEME_KEY)).toBe(false)
    expect(readTheme()).toBe('light')
    expect(DEFAULT_THEME).toBe('light')
  })

  it('stores the answer and reads it back', () => {
    expect(writeTheme('dark')).toBe('dark')
    expect(storage.getItem(THEME_KEY)).toBe('dark')
    expect(readTheme()).toBe('dark')

    writeTheme('light')
    expect(storage.getItem(THEME_KEY)).toBe('light')
    expect(readTheme()).toBe('light')
  })

  it('is not keyed by project, unlike the token and the notes', () => {
    // A theme is a property of the eyes in front of the screen. Somebody who
    // set it on one model meant it for the next one too, and a per-project key
    // would make them say so again on every model they open.
    writeTheme('dark')
    expect([...storage.cells.keys()]).toEqual([THEME_KEY])
  })

  it('reads anything it does not recognise as the default', () => {
    // The cell is a string a person or an older version of this page can put
    // anything into, and it goes straight into the library's options.
    storage.setItem(THEME_KEY, 'midnight')
    expect(readTheme()).toBe('light')
    storage.setItem(THEME_KEY, '')
    expect(readTheme()).toBe('light')
  })

  it('corrects an unknown value on the way in, and says what it took', () => {
    // The return value is what the caller shows. Storing one thing and showing
    // another is how a button ends up disagreeing with the canvas under it.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(writeTheme('midnight')).toBe('light')
    expect(storage.getItem(THEME_KEY)).toBe('light')
    expect(writeTheme(undefined)).toBe('light')
  })
})

describe('a storage that will not answer', () => {
  it('reads as the default rather than taking the interface down', () => {
    // A private window, cleared site data, a browser set to block storage: all
    // three throw, and this read happens while the page is being built.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    install(fakeStorage({ failing: true }))
    expect(readTheme()).toBe('light')
  })

  it('lets the setting hold for this page even when it cannot be written', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    install(fakeStorage({ failing: true }))
    expect(writeTheme('dark')).toBe('dark')
  })

  it('survives a `localStorage` that throws on the property itself', () => {
    // The one the try/catch is really there for: in a private window the getter
    // throws, so nothing here ever gets as far as calling a method on it.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('blocked') },
    })
    expect(readTheme()).toBe('light')
    expect(writeTheme('dark')).toBe('dark')
  })
})

describe('what the library is started with', () => {
  it('is the remembered answer, read when the viewer is built', () => {
    // `displayOptions.theme` is a getter, and this is what that buys: the option
    // object is built once when the module loads, long before anybody has been
    // asked anything, while element.js spreads it at the moment it constructs
    // the viewer. A plain value would have frozen the answer at import time.
    expect(displayOptions.theme).toBe('light')
    writeTheme('dark')
    expect(displayOptions.theme).toBe('dark')
    writeTheme('light')
    expect(displayOptions.theme).toBe('light')
  })
})

// -- the button in the viewport's own strip ----------------------------------
//
// The component is built the way ui/tests/downloads.test.js builds it — the
// prototype, a state object spelled out in full, and the real `computed()` — for
// the same reason: what is under test is a DECISION, and the decision is only
// visible once the thing that makes it has run.
//
// `setState` is the one thing replaced. `Object.create(prototype)` has no
// updater behind it, so React's own would throw; and what the assertions want is
// the PATCH rather than a re-render, which is exactly what the double keeps.

/** The component, with a fake viewport element under `el()`. */
function component({ theme = 'light', viewer = {} } = {}) {
  const c = Object.create(HammerolaViewer.prototype)
  c.props = { commentsOpen: false }
  c.home = null
  c.host = { current: viewer === null ? null : { viewer } }
  c.patches = []
  c.setState = vi.fn((patch) => {
    c.patches.push(patch)
    Object.assign(c.state, patch)
  })
  c.state = {
    meta: {
      project: 'fixture', commit: 'abc1234', built: '',
      parts: { lid: { kind: 'printable', files: { stl: 'lid.stl' } } },
      views: [{ id: 'assembled', name: 'assembled', file: 'a.json',
                parts: ['lid'], gzip: 1000 }],
    },
    builds: null,
    tree: indexTree({ id: '/model', name: 'model', children: [] }),
    error: null, viewError: null, pending: null,
    view: 'assembled', tool: null, held: false,
    sel: null, selName: '', hidden: [], ghost: [], expanded: {},
    secOn: false, secOff: 0, secRange: null, secFlip: false, hatch: true,
    secFace: null, secPop: false,
    revOpen: false, dlOpen: false, cmp: [], compare: false, diffShow: 'both',
    bannerGone: false, rail: false, menu: { id: null, x: 0, y: 0 },
    notePop: null, noteDraft: '', notes: {},
    comments: [], activePin: null, composer: null,
    measure: null, moved: null, toast: null,
    token: null, tokenPop: false, tokenDraft: '',
    theme,
  }
  return c
}

describe('the theme toggle', () => {
  it('names the mode the reader is IN and offers the other one', () => {
    // The button is a STATE READOUT with the action in its tooltip, like the
    // access button beside the token. A label naming the destination and a
    // tooltip naming the destination too would leave nothing on screen saying
    // which of the two the canvas is actually in.
    const light = component({ theme: 'light' }).computed()
    expect(light.themeLabel).toBe('Light')
    expect(light.themeDark).toBe(false)
    expect(light.themeTitle).toContain('light canvas')
    expect(light.themeTitle).toContain('click for dark')

    const dark = component({ theme: 'dark' }).computed()
    expect(dark.themeLabel).toBe('Dark')
    expect(dark.themeDark).toBe(true)
    expect(dark.themeTitle).toContain('dark canvas')
    expect(dark.themeTitle).toContain('click for light')
  })

  it('stores the answer, shows it, and tells the live scene', () => {
    const viewer = { setTheme: vi.fn() }
    const c = component({ theme: 'light', viewer })
    c.computed().toggleTheme()
    expect(storage.getItem(THEME_KEY)).toBe('dark')
    expect(c.patches).toEqual([{ theme: 'dark' }])
    // Through the VIEWER and not the element: the library resolves the theme
    // once, at construction, and re-asserts that value at the end of every
    // render, so an option or an attribute set from outside holds only until the
    // next view switch. `setTheme` is its public answer to exactly this.
    expect(viewer.setTheme).toHaveBeenCalledWith('dark')
  })

  it('turns back, so the button is a toggle and not a one-way trip', () => {
    const viewer = { setTheme: vi.fn() }
    const c = component({ theme: 'dark', viewer })
    c.computed().toggleTheme()
    expect(storage.getItem(THEME_KEY)).toBe('light')
    expect(viewer.setTheme).toHaveBeenCalledWith('light')
  })

  it('shows what writeTheme TOOK, not what it was handed', () => {
    // THE WHOLE POINT OF THAT FUNCTION'S RETURN VALUE, and the assertion has to
    // go through `applyTheme` rather than the toggle to make it: the toggle only
    // ever asks for 'light' or 'dark', both of which storage accepts unchanged,
    // so nothing a click can do tells "stores the return" from "stores its own
    // argument" apart. `applyTheme` is the method the toggle is one line of, and
    // it is reachable with a value storage corrects — which is how a button ends
    // up naming a theme the canvas under it is not in.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const viewer = { setTheme: vi.fn() }
    const c = component({ theme: 'dark', viewer })
    c.applyTheme('midnight')
    expect(c.state.theme).toBe('light')
    expect(storage.getItem(THEME_KEY)).toBe('light')
    expect(viewer.setTheme).toHaveBeenCalledWith('light')
  })

  it('is one line over applyTheme, and asks it for the OTHER mode', () => {
    const c = component({ theme: 'light' })
    c.applyTheme = vi.fn()
    c.computed().toggleTheme()
    expect(c.applyTheme).toHaveBeenCalledWith('dark')

    const dark = component({ theme: 'dark' })
    dark.applyTheme = vi.fn()
    dark.computed().toggleTheme()
    expect(dark.applyTheme).toHaveBeenCalledWith('light')
  })

  it('still stores and shows it with no viewport on the page', () => {
    // Guarded end to end because every step is allowed to be missing: no
    // adapter mounted, a viewport that has not rendered, an older library with
    // no `setTheme`. The setting has to survive all three — the next page load
    // comes up in it.
    for (const c of [component({ viewer: null }), component({ viewer: {} }),
                     component({ viewer: { setTheme: 'not a function' } })]) {
      c.computed().toggleTheme()
      expect(c.state.theme).toBe('dark')
      expect(storage.getItem(THEME_KEY)).toBe('dark')
    }
  })

  it('survives a viewer whose setTheme throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = component({
      viewer: { setTheme: () => { throw new Error('older library') } },
    })
    expect(() => c.computed().toggleTheme()).not.toThrow()
    expect(c.state.theme).toBe('dark')
    expect(storage.getItem(THEME_KEY)).toBe('dark')
    expect(warn).toHaveBeenCalled()
  })
})
