// The theme — which of the two palettes the whole interface is painted in, and
// the one remembered answer the SERVER has to know about.
//
// IT IS A COOKIE AND IT USED TO BE A localStorage KEY, and that is the change
// this file was rewritten for (issue #35). While the theme meant "the colour of
// the 3D canvas" it was a viewport setting, kept in
// `ui/src/viewport/options.js` under `hammerola.viewport_theme`, and nothing
// outside the browser ever needed to know it. It is the whole page's palette
// now: every `var(--…)` in the interface resolves against `data-theme` on
// `<html>`, and that attribute has to be right in the first byte the browser
// parses or the page flashes the other theme. Only the server can do that, the
// two script-side ways of avoiding the flash are both closed (the CSP refuses an
// inline pre-paint script; the resolver page runs no bundle at all), and a
// cookie is the one thing a browser sends WITH the request for the page. So the
// reader and the writer moved to ui/src/store.js, with the rest of the
// per-reader state, and what is checked here is the cookie.
//
// THE JAR IS REAL AND ITS ABSENCE WOULD BE SILENT, which is the lesson this file
// inherits word for word from the localStorage version and from
// ui/tests/store.test.js. Every access in store.js sits inside a try/catch that
// reads a failure as "nothing was remembered", so against a runner with no
// working `document.cookie` a `writeTheme` that stores nothing passes every
// assertion below. jsdom has one; `expectTheJar()` runs before each test and
// says so out loud, because the failure it guards against does not look like a
// failure — it looks like a green suite.
//
// The cookie's name is written out here rather than imported, exactly as
// store.test.js writes out its keys: it is the OBSERVABLE — what a reader's
// browser carries between visits, and what `src/render.py` reads on the other
// side of the wire — so reusing the module's own expression would give a test
// that agrees with itself whatever the name is changed to.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { indexTree } from '../src/hub.js'
import { DEFAULT_THEME, readTheme, writeTheme } from '../src/store.js'
import * as viewport from '../src/viewport/options.js'
import { displayOptions } from '../src/viewport/options.js'

const THEME_COOKIE = 'hammerola.theme'

/** Every `name=value` pair the jar currently holds, as a map. */
function jar() {
  const out = {}
  for (const part of document.cookie.split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    out[part.slice(0, at).trim()] = part.slice(at + 1).trim()
  }
  return out
}

const stored = () => jar()[THEME_COOKIE]

/** Put the jar and the document back the way a first visit finds them. */
function clearJar() {
  for (const name of Object.keys(jar())) {
    document.cookie = `${name}=;Path=/;Max-Age=0`
  }
  document.documentElement.removeAttribute('data-theme')
}

function expectTheJar() {
  document.cookie = 'hammerola.canary=1;Path=/'
  const written = jar()['hammerola.canary'] === '1'
  document.cookie = 'hammerola.canary=;Path=/;Max-Age=0'
  if (!written) {
    throw new Error(
      'ui/tests/theme.test.js: this runner has no working `document.cookie`. '
      + 'Nothing below is testing anything: every access in ui/src/store.js '
      + 'catches a failing jar and reports it as "nothing was remembered" — so a '
      + 'writeTheme that stores nothing passes every assertion in this file.')
  }
}

beforeEach(() => {
  clearJar()
  expectTheJar()
})

afterEach(() => {
  vi.restoreAllMocks()
  // The throwing double some tests install is an OWN property shadowing the
  // accessor on Document.prototype; deleting it is what gives the real jar back.
  delete document.cookie
  clearJar()
})

describe('the remembered theme', () => {
  it('opens on light when nothing was ever stored', () => {
    // The default is what every first visit gets, on all three pages, and the
    // server answers the same way from the same absence (`render.cookie_theme`).
    expect(stored()).toBe(undefined)
    expect(readTheme()).toBe('light')
    expect(DEFAULT_THEME).toBe('light')
  })

  it('stores the answer and reads it back', () => {
    expect(writeTheme('dark')).toBe('dark')
    expect(stored()).toBe('dark')
    expect(readTheme()).toBe('dark')

    writeTheme('light')
    expect(stored()).toBe('light')
    expect(readTheme()).toBe('light')
  })

  it('stamps the attribute the page is actually painted from', () => {
    // THE HALF A COOKIE CANNOT DO. The cookie is read by the server on the NEXT
    // page load; this page is not going to be sent again, and every `var(--…)`
    // in the interface resolves against this attribute. Without this line the
    // toggle stores an answer and changes nothing on screen until you navigate.
    writeTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    writeTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('sends it to every page of this hub, for a year', () => {
    // `Path=/` because the answer is the reader's and not the project's: it is
    // written on a build page under /project/<pid>/<commit>/ and has to be read
    // on `/` and on the resolver. A cookie with no Path is scoped to the
    // DIRECTORY it was written in, so the front page would never see it.
    //
    // `Max-Age` because a session cookie forgets the answer when the browser
    // closes, and this is a preference rather than a login. And NO `Secure`:
    // the hub is reachable over plain HTTP, where a Secure cookie is simply
    // never sent — the setting would look like a hub that does not remember.
    //
    // `SameSite=Lax` is checked with the other three rather than left to the
    // paragraph about it in store.js. It is what every browser now defaults an
    // unmarked cookie to, which is exactly what makes it the attribute somebody
    // deletes as noise — and "the default happens to agree today" is a property
    // of browsers rather than of this cookie.
    const written = []
    const jarNow = document.cookie
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => jarNow,
      set: (value) => written.push(value),
    })
    writeTheme('dark')
    delete document.cookie
    expect(written).toHaveLength(1)
    expect(written[0]).toContain(`${THEME_COOKIE}=dark`)
    expect(written[0]).toMatch(/;\s*Path=\//i)
    expect(written[0]).toMatch(/;\s*Max-Age=\d{6,}/i)
    expect(written[0]).toMatch(/;\s*SameSite=Lax/i)
    expect(written[0]).not.toMatch(/;\s*Secure/i)
  })

  it('is not keyed by project, unlike the token and the notes', () => {
    // A theme is a property of the eyes in front of the screen. Somebody who
    // set it on one model meant it for the next one too, and a per-project key
    // would make them say so again on every model they open.
    writeTheme('dark')
    expect(Object.keys(jar())).toEqual([THEME_COOKIE])
  })

  it('reads anything it does not recognise as the default', () => {
    // The jar holds whatever any version of this page ever wrote, whatever else
    // is set on this host, and whatever was typed into a browser's cookie
    // inspector — and the value goes straight into the library's options.
    document.cookie = `${THEME_COOKIE}=midnight;Path=/`
    expect(readTheme()).toBe('light')
    document.cookie = `${THEME_COOKIE}=;Path=/`
    expect(readTheme()).toBe('light')
  })

  it('is not confused by the other cookies on the host', () => {
    // The parse is four lines of our own rather than a library's for exactly
    // this: a jar is a shared namespace, and a name that merely ENDS with ours
    // must not answer for it.
    document.cookie = `not_${THEME_COOKIE}=dark;Path=/`
    document.cookie = 'something_else=whatever;Path=/'
    expect(readTheme()).toBe('light')
    document.cookie = `${THEME_COOKIE}=dark;Path=/`
    expect(readTheme()).toBe('dark')
  })

  it('corrects an unknown value on the way in, and says what it took', () => {
    // The return value is what the caller shows. Storing one thing and showing
    // another is how a button ends up disagreeing with the page under it.
    expect(writeTheme('midnight')).toBe('light')
    expect(stored()).toBe('light')
    expect(writeTheme(undefined)).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
})

describe('a jar that will not answer', () => {
  /** `document.cookie` that throws on both halves, as a sandboxed frame does. */
  function breakTheJar() {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get() { throw new Error('cookies are off') },
      set() { throw new Error('cookies are off') },
    })
  }

  it('reads as the default rather than taking the interface down', () => {
    // This read happens while the page is being built, so an uncaught throw
    // here is a blank page over a preference.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    breakTheJar()
    expect(readTheme()).toBe('light')
  })

  it('lets the setting hold for this page even when it cannot be written', () => {
    // The attribute is set separately and still lands, which is what makes this
    // "the answer will not outlive the page" rather than "the answer is lost".
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    breakTheJar()
    expect(writeTheme('dark')).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
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

  it('is the one implementation, with no second name pointing at it', () => {
    // The viewport RE-EXPORTED `readTheme`/`writeTheme` for exactly one caller:
    // HammerolaViewer.jsx had always asked this module for them, and could not
    // be touched while the palette was being moved out of it. It imports them
    // from store.js now and the alias is gone — and what is asserted here is
    // that it stays gone, because a name is free to become an implementation
    // and a second implementation is the failure that hides: it would read the
    // same cookie, pass every test above, and write no attribute at all.
    //
    // The test above is the other half: `displayOptions.theme` still follows
    // `writeTheme`, so the viewport is reaching the one implementation rather
    // than having stopped asking.
    expect(Object.keys(viewport)).not.toContain('readTheme')
    expect(Object.keys(viewport)).not.toContain('writeTheme')
  })
})

// -- the button, which now stands beside the comments ------------------------
//
// WHERE it is drawn is ui/tests/narrow.test.js's — that file has both widths
// and reads the header row off the render. What is here is what the button
// SAYS and what pressing it does.
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
    feed: [], activePin: null, composer: null,
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
    // which of the two the page is actually in.
    //
    // AND IT SAYS "INTERFACE", NOT "CANVAS", which is the wording half of the
    // move: while this lived under the model it named what it changed — "the
    // model sits on a light canvas" — and that sentence is now false in the
    // half of the page that is not the canvas.
    const light = component({ theme: 'light' }).computed()
    expect(light.themeLabel).toBe('Light')
    expect(light.themeDark).toBe(false)
    expect(light.themeTitle).toContain('interface is light')
    expect(light.themeTitle).toContain('click for dark')
    expect(light.themeTitle).not.toContain('canvas')

    const dark = component({ theme: 'dark' }).computed()
    expect(dark.themeLabel).toBe('Dark')
    expect(dark.themeDark).toBe(true)
    expect(dark.themeTitle).toContain('interface is dark')
    expect(dark.themeTitle).toContain('click for light')
    expect(dark.themeTitle).not.toContain('canvas')
  })

  it('stores the answer, shows it, and tells the live scene', () => {
    const viewer = { setTheme: vi.fn() }
    const c = component({ theme: 'light', viewer })
    c.computed().toggleTheme()
    expect(stored()).toBe('dark')
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
    expect(stored()).toBe('light')
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
    const viewer = { setTheme: vi.fn() }
    const c = component({ theme: 'dark', viewer })
    c.applyTheme('midnight')
    expect(c.state.theme).toBe('light')
    expect(stored()).toBe('light')
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
      expect(stored()).toBe('dark')
      clearJar()
    }
  })

  it('survives a viewer whose setTheme throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = component({
      viewer: { setTheme: () => { throw new Error('older library') } },
    })
    expect(() => c.computed().toggleTheme()).not.toThrow()
    expect(c.state.theme).toBe('dark')
    expect(stored()).toBe('dark')
    expect(warn).toHaveBeenCalled()
  })
})
