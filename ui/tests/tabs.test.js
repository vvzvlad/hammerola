// The tab strip under the header: the projects this browser has been in lately.
//
// A TAB IS A LINK, and every test here is a restatement of that one sentence
// (issue #45). The strip is navigation memory beside the address — a list of
// `<a href>`s at `/project/<pid>/` — and it is deliberately NOT application
// state competing with the URL. So:
//
//   * WHICH TAB IS ACTIVE is not stored, is not in `state`, and is not decided
//     here at all: it is `PAGE.pid`, read off the address. The test for it moves
//     the address and touches nothing else, because that is the only way the
//     highlight is allowed to move;
//   * CLICKING ONE is an ordinary same-window navigation, so the assertion is
//     that an `<a href>` exists with the right target — no `target`, no
//     `window.open`, nothing this file has to drive;
//   * CLOSING ONE goes nowhere, including the tab the reader is standing on.
//     `preventDefault` is what makes that true — the ✕ sits inside the anchor,
//     so stopping React's synthetic bubbling alone would leave the browser's own
//     navigation to fire and closing a tab would open it.
//
// NOTHING IS MOUNTED, the arrangement every file in this directory uses: the
// instance is the real prototype with the state spelled out, `computed()` and
// `render()` are the real ones, and what they drew is read straight off the
// returned element objects (ui/tests/eltree.js). The layout AROUND those values
// is checked from Python against the source (tests/test_ui_source.py).
//
// THE STORAGE DOUBLE BELOW IS LOAD-BEARING, for the reason ui/tests/store.test.js
// states at length: this runner has no `localStorage` of its own, and every
// access in store.js reads its absence as "nothing was remembered". Without a
// double, `closeTab` would forget nothing, `readTabs()` would answer with an
// empty strip, and "the tab is gone" would be green against a store that never
// stored anything. Hence the close tests assert what SURVIVES as well as what
// went: a strip wiped by an absent storage fails them.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// `vi.hoisted` and ONE MUTABLE OBJECT, exactly as ui/tests/header.test.js does
// it and for the same reason: `PAGE.pid` is read at the moment `computed()`
// runs, so moving the address is a field assignment rather than a re-mock.
const { PAGE } = vi.hoisted(() => ({
  PAGE: { pid: 'proj1', slot: 'latest', base: '/project/proj1/latest/' },
}))

// The two hub fetches `load()` makes are mocked and nothing else is, exactly as
// ui/tests/revswitch.test.js does it: they are the only things in this file that
// would talk to a hub. Every other test here never reaches them.
vi.mock('../src/hub.js', async (importOriginal) => ({
  ...(await importOriginal()),
  PAGE,
  loadMeta: vi.fn(),
  loadBuilds: vi.fn(),
}))

import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { indexTree, loadBuilds, loadMeta } from '../src/hub.js'
import { forgetTab, readTabs, rememberTab } from '../src/store.js'
import { collect, links } from './eltree.js'

/** The smallest thing store.js can tell from the real one. */
function fakeStorage() {
  const cells = new Map()
  return {
    cells,
    getItem: (k) => (cells.has(k) ? cells.get(k) : null),
    setItem: (k, v) => { cells.set(k, String(v)) },
    removeItem: (k) => { cells.delete(k) },
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: fakeStorage(), configurable: true, writable: true,
  })
  // Every test starts on this project's own page, the way its URL would have it.
  PAGE.pid = 'proj1'
  PAGE.slot = 'latest'
  PAGE.base = '/project/proj1/latest/'
})

afterEach(() => {
  vi.restoreAllMocks()
  delete globalThis.localStorage
})

/**
 * The component as `computed()` and `render()` see it, holding `tabs`.
 *
 * `parts: {}` deliberately: a build that ships no files draws no download rows,
 * and those are `<a>` elements too. What is left under `/project/` is the strip
 * and nothing else, which is what makes the readings below exact.
 */
function component({ tabs = [] } = {}) {
  const c = Object.create(HammerolaViewer.prototype)
  c.props = { ...HammerolaViewer.defaultProps }
  c.home = null
  c.host = { current: null }
  c.setState = vi.fn((patch) => { Object.assign(c.state, patch) })
  c.state = {
    meta: {
      project: 'fixture', title: 'Fixture bracket', commit: 'abc1234',
      built: '2026-08-27T18:20:00Z', parts: {},
      views: [{ id: 'assembled', name: 'assembled', file: 'a.json',
                parts: [], gzip: 1000 }],
    },
    builds: null,
    tree: indexTree({ id: '/model', name: 'model', children: [] }),
    error: null, viewError: null, pending: null,
    view: 'assembled', tool: null, held: false,
    sel: null, selName: '', hidden: [], ghost: [], expanded: {},
    secOn: false, secOff: 0, secRange: null, secFlip: false, hatch: true,
    secFace: null, secPop: false,
    revOpen: false, dlOpen: false, cmp: [], compare: false, diffShow: 'both',
    bannerGone: false, rail: null, menu: { id: null, x: 0, y: 0 },
    notePop: null, noteDraft: '', notes: {},
    feed: [], activePin: null, composer: null, sending: false,
    measure: null, toast: null,
    token: 'sekrit', tokenPop: false, tokenDraft: '',
    theme: 'light',
    tabs,
  }
  return c
}

/** One entry as the store hands it over. */
const entry = (pid, title, seen) => ({ pid, title, seen })

/** Every project link the page drew, in draw order. */
const tabHrefs = (c) => links(c.render())
  .map((el) => el.props.href)
  .filter((href) => /^\/project\//.test(String(href)))

/** The `<a>` elements of the strip itself. */
const tabAnchors = (c) => links(c.render())
  .filter((el) => /^\/project\//.test(String(el.props.href)))

/** The ✕ beside each tab, identified by what it tells the reader it does. */
const closers = (c) => collect(
  c.render(), (el) => (el.props.title === 'forget this project' ? el : undefined))

/** A click, with the two things the close handler has to do to it recorded. */
const clickEvent = () => ({
  prevented: false, stopped: false,
  preventDefault() { this.prevented = true },
  stopPropagation() { this.stopped = true },
})

// -- how a project gets onto the strip in the first place ---------------------
//
// EVERY OTHER TEST IN THIS FILE HANDS THE STRIP ITS TABS, which leaves the one
// line that ever fills it — `rememberTab` in `load()` — held up by nothing:
// delete it and the strip stays empty for ever while both suites go on passing.
// So this runs the real `load()` over the real store, mocking only the two hub
// fetches, and asks the question those tests cannot: did arriving here put this
// project on the strip.

describe('how a project reaches the strip', () => {
  /** `load()` over a hub that answers with the fixture and no build history. */
  const arrive = async (meta) => {
    const c = component()
    if (meta) c.state.meta = meta
    loadMeta.mockResolvedValue(c.state.meta)
    // A project with no builds.json is a project with an empty picker, which
    // `load()` treats as a non-event — the same shape revswitch.test.js uses.
    loadBuilds.mockResolvedValue(null)
    await c.load()
    return c
  }

  it('is recorded by arriving, under the name meta.json gives the project', async () => {
    const c = await arrive()
    expect(readTabs().map((t) => t.pid)).toEqual(['proj1'])
    expect(readTabs()[0].title).toBe('Fixture bracket')
  })

  it('seeds the strip the page draws from the store, in the same breath', async () => {
    // Two halves of one arrival and both are needed: the write puts this project
    // in storage, and the read is what the row on screen is built from. A write
    // with no re-read draws the strip this browser had BEFORE it got here.
    rememberTab('alpha', 'Alpha')
    const c = await arrive()
    expect(c.state.tabs.map((t) => t.pid)).toEqual(['alpha', 'proj1'])
  })

  it('falls back to the latin name when the model gave the project no title', async () => {
    // `meta.title` is optional on the wire and defaults to `project` server-side;
    // a strip of blank pills is what reading only the first would give.
    const c = component()
    const { title, ...untitled } = c.state.meta
    await arrive(untitled)
    expect(readTabs()[0].title).toBe('fixture')
  })
})

// -- when there is nothing worth showing --------------------------------------

describe('a strip with fewer than two tabs', () => {
  it('is not drawn at all when nothing has been remembered', () => {
    const c = component({ tabs: [] })
    expect(c.computed().tabsShown).toBe(false)
    expect(tabHrefs(c)).toEqual([])
  })

  it('is not drawn for the one project on screen', () => {
    // A strip offering only the model already in front of the reader is a row
    // of chrome that navigates nowhere. NOT `display:none` — absent: the row it
    // would occupy is taken off the page rather than left standing empty.
    const c = component({ tabs: [entry('proj1', 'Fixture bracket', 1000)] })
    expect(c.computed().tabsShown).toBe(false)
    expect(tabHrefs(c)).toEqual([])
  })

  it('appears as soon as there is somewhere else to go', () => {
    const c = component({
      tabs: [entry('proj1', 'Fixture bracket', 1000), entry('alpha', 'Alpha', 900)],
    })
    expect(c.computed().tabsShown).toBe(true)
    expect(tabHrefs(c)).toHaveLength(2)
  })
})

// -- a tab is a link ----------------------------------------------------------

describe('what a tab links at', () => {
  const THREE = [
    entry('alpha', 'Alpha', 900),
    entry('proj1', 'Fixture bracket', 1000),
    entry('beta', 'Beta', 800),
  ]

  it('is the project, at the URL that names no pointer', () => {
    // A TAB IS A PROJECT AND NOT A BUILD. The pointer-less URL opens whichever
    // of `latest` and `dev` this reader was last on (hub.projectUrl), and this
    // page is standing on `/latest/` — so a strip that linked at where it is
    // would overwrite that memory on every click.
    const c = component({ tabs: THREE })
    expect(PAGE.slot).toBe('latest')
    expect(tabHrefs(c)).toEqual(['/project/alpha/', '/project/proj1/', '/project/beta/'])
  })

  it('is an ordinary same-window navigation', () => {
    // No `target`, no `window.open`, no history games — which is why there is
    // nothing here for this file to drive. The strip is next to the address bar
    // and behaves like it.
    const c = component({ tabs: THREE })
    tabAnchors(c).forEach((el) => {
      expect(el.props.target).toBeUndefined()
      expect(typeof el.props.href).toBe('string')
    })
  })

  it('is drawn in the order the projects were opened', () => {
    // POSITION IS THE ORDER OF OPENING and the stamps say otherwise on purpose:
    // `beta` is the coldest and still draws last, because it was opened last.
    // A strip sorted by recency moves a link out from under a reader aiming at
    // it. (The store is what keeps the order; this asks that the page draws it
    // rather than sorting on the way to the screen.)
    const c = component({ tabs: THREE })
    expect(tabHrefs(c)).toEqual(['/project/alpha/', '/project/proj1/', '/project/beta/'])
  })

  it('shows the stored title, and keeps a long one from widening the page', () => {
    const c = component({
      tabs: [entry('alpha', 'Alpha', 900), entry('proj1', 'Fixture bracket', 1000)],
    })
    const v = c.computed()
    expect(v.tabs.map((t) => t.label)).toEqual(['Alpha', 'Fixture bracket'])
    v.tabs.forEach((t) => {
      expect(t.style).toContain('max-width')
      expect(t.labelStyle).toContain('text-overflow:ellipsis')
    })
  })

  it('breaks its line rather than losing its tail off the edge', () => {
    // A FULL STRIP IS WIDER THAN THE WINDOW: ten pills at the `max-width` above,
    // plus their gaps and the row's padding, comes to about 2000px. The root of
    // this interface is `overflow:hidden`, so a row that cannot wrap does not
    // scroll — it is cut off, silently, and the tabs past the cut are gone with
    // nothing on screen to say they exist. Then the eleventh project opened
    // evicts the coldest tab and the visible strip never changes, which is the
    // strip lying about what it holds.
    //
    // Pinned here rather than argued in a comment: `flex-wrap` is one token, and
    // it is one token away from the failure at every edit.
    const full = Array.from({ length: 10 }, (unused, i) => (
      entry(`p${i}`, `Project number ${i}`, 1000 + i)))
    const v = component({ tabs: full }).computed()
    expect(v.tabs).toHaveLength(10)
    expect(v.tabsStyle).toContain('flex-wrap:wrap')
    expect(v.tabsStyle).not.toContain('overflow:hidden')
  })
})

// -- the active tab is the address --------------------------------------------

describe('which tab is drawn as the active one', () => {
  const THREE = [
    entry('alpha', 'Alpha', 900),
    entry('proj1', 'Fixture bracket', 1000),
    entry('beta', 'Beta', 800),
  ]

  /**
   * The pill this page draws the thing you are looking at with.
   *
   * Read off the VIEW switcher rather than written out here, and that is the
   * assertion as much as the fixture: the strip is supposed to reuse the one
   * pill helper, so a second visual language invented for one row shows up as
   * these prefixes ceasing to match.
   */
  const activePill = (c) => c.computed().viewTabs[0].style

  /** A tab's key is its pid — the strip is keyed by what it links at. */
  const pids = (c) => c.computed().tabs.map((t) => t.key)

  const activePids = (c) => {
    const pill = activePill(c)
    return c.computed().tabs.filter((t) => t.style.startsWith(pill)).map((t) => t.key)
  }

  it('is the one whose pid is in the address, and there is exactly one', () => {
    const c = component({ tabs: THREE })
    expect(pids(c)).toEqual(['alpha', 'proj1', 'beta'])
    expect(activePids(c)).toEqual(['proj1'])
  })

  it('moves when the ADDRESS moves, with nothing stored changing', () => {
    // The whole reason nothing remembers which tab is active. Same strip, same
    // state, same storage — a different page, and the highlight is on the tab
    // that page belongs to. There is no field anywhere that could have been
    // left pointing at `proj1`.
    const c = component({ tabs: THREE })
    expect(activePids(c)).toEqual(['proj1'])

    PAGE.pid = 'beta'
    PAGE.base = '/project/beta/latest/'
    expect(c.state.tabs).toEqual(THREE)
    expect(activePids(c)).toEqual(['beta'])
  })

  it('is nobody at all on a project that is not on the strip', () => {
    // Reachable: the reader followed a link to a project the strip has already
    // evicted. Every pill draws inactive, which is honest — none of these links
    // is the page you are on — rather than lighting the first one up.
    PAGE.pid = 'gamma'
    PAGE.base = '/project/gamma/latest/'
    const c = component({ tabs: THREE })
    expect(activePids(c)).toEqual([])
  })
})

// -- closing one --------------------------------------------------------------

describe('closing a tab', () => {
  /** Three projects on the strip, remembered through the real store. */
  const opened = () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    rememberTab('alpha', 'Alpha')
    vi.spyOn(Date, 'now').mockReturnValue(2000)
    rememberTab('proj1', 'Fixture bracket')
    vi.spyOn(Date, 'now').mockReturnValue(3000)
    rememberTab('beta', 'Beta')
    return component({ tabs: readTabs() })
  }

  it('is a bare span, the way every other close control on this page is', () => {
    // `tests/test_ui_source.py` forbids `innerHTML`, so the mark is a JSX
    // entity; a `<button>` inside an `<a>` is not markup a browser is required
    // to make sense of. Six of these already exist in this file's render.
    const c = opened()
    const marks = closers(c)
    expect(marks).toHaveLength(3)
    marks.forEach((el) => expect(el.type).toBe('span'))
  })

  it('forgets the project and goes nowhere', () => {
    const c = opened()
    const event = clickEvent()
    closers(c)[0].props.onClick(event)

    // `preventDefault` IS the claim: the ✕ is inside the anchor, so without it
    // the browser navigates to the very project just closed.
    expect(event.prevented, 'closing a tab follows its own link').toBe(true)
    expect(event.stopped).toBe(true)

    // What went, AND what stayed. The survivors are the half that fails if the
    // storage double is not installed, since a gutted store answers every read
    // with an empty strip.
    expect(readTabs().map((t) => t.pid)).toEqual(['proj1', 'beta'])
    expect(c.state.tabs.map((t) => t.pid)).toEqual(['proj1', 'beta'])
    expect(tabHrefs(c)).toEqual(['/project/proj1/', '/project/beta/'])
  })

  it('leaves the reader on the page when the tab closed is the one they are on', () => {
    // A tab is a link, so closing the one you are standing on is forgetting a
    // link and not leaving a page. The address does not move, the build stays on
    // screen, and since the address is the only thing that ever said which tab
    // was active there is nothing left pointing at what is gone.
    const c = opened()
    closers(c)[1].props.onClick(clickEvent())

    expect(PAGE.pid).toBe('proj1')
    expect(PAGE.base).toBe('/project/proj1/latest/')
    expect(readTabs().map((t) => t.pid)).toEqual(['alpha', 'beta'])
    expect(c.computed().title).toBe('Fixture bracket')
    expect(tabHrefs(c)).toEqual(['/project/alpha/', '/project/beta/'])
  })

  it('takes the strip away once one project is left', () => {
    const c = opened()
    closers(c)[0].props.onClick(clickEvent())
    closers(c)[0].props.onClick(clickEvent())
    expect(readTabs().map((t) => t.pid)).toEqual(['beta'])
    expect(c.computed().tabsShown).toBe(false)
    expect(tabHrefs(c)).toEqual([])
  })

  it('re-reads the strip rather than editing the copy it is drawing', () => {
    // The store is the one answer. Filtering `state.tabs` in place would leave
    // the page and the storage free to disagree the moment either changed for
    // another reason — an eviction on the next arrival, say.
    const c = opened()
    forgetTab('alpha')
    expect(c.state.tabs.map((t) => t.pid)).toEqual(['alpha', 'proj1', 'beta'])
    closers(c)[2].props.onClick(clickEvent())
    expect(c.state.tabs.map((t) => t.pid)).toEqual(['proj1'])
  })
})
