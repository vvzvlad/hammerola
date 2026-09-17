// Switching revisions IN PLACE — issue #62.
//
// The gesture used to be `location.href = …`: the browser threw the document
// away and built it again — template, bundle, viewer, view file — so the camera,
// the hidden parts, the section and the view tab were all lost at exactly the
// moment they are worth the most, which is somebody comparing two builds of one
// part from one angle. Everything that differs between two revisions of a
// project is one meta.json and one view payload; the rest of the page is the
// same kind of thing rebuilt from different data.
//
// SO THE CLAIMS UNDER TEST ARE TWO. The address still says which geometry this
// is — pushed, not loaded, so the link copies and opens exactly as before — and
// what the reader set up survives, except for the things that would be lies if
// they did.
//
// THE URL IS REAL AND SO IS `PAGE`. `vi.hoisted` runs before every import in
// this file, which is the only place early enough to put jsdom on a build page:
// `PAGE` is derived at module scope off `location.pathname`, and a stubbed one
// would let the file agree with itself about the very field the whole entry
// turns on — nothing re-derives `PAGE`, so a swap that forgot it would go on
// fetching the revision that had just left the screen. Only the two hub fetches
// a swap makes are mocked — `loadMeta` and `loadBuilds` — because they are the
// only things here that talk to a hub; everything else is the real module.
//
// NOTHING IS RENDERED, the arrangement every file in this directory uses: the
// instance is the real prototype with the state spelled out, and the real
// methods run over it.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

const { A, B } = vi.hoisted(() => {
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  window.history.replaceState(null, '', `/project/proj1/${a}/`)
  return { A: a, B: b }
})

vi.mock('../src/hub.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadMeta: vi.fn(),
  loadBuilds: vi.fn(),
}))

import HammerolaViewer, { UNDO_DEPTH } from '../src/HammerolaViewer.jsx'
import { STATE } from '../src/events.js'
import { PAGE, indexTree, loadBuilds, loadMeta } from '../src/hub.js'
import { guardPage } from './pageguard.js'

const path = (slot) => `/project/proj1/${slot}/`

// `PAGE` became module-level MUTABLE state the day the swap started writing to
// it, so it gets the fixture this project's convention asks of one: put back and
// CHECKED, both before and after every test. Before-only is what sends the
// debugging into whichever test happened to run next — see pageguard.js.
guardPage(path(A))

/** The mocks, back to what this file starts every test from. */
beforeEach(() => {
  loadMeta.mockReset()
  // The picker's list is refreshed after every swap. It answers with the same
  // history the fixture starts from, so a test about something else does not
  // have to say anything about it.
  loadBuilds.mockReset()
  loadBuilds.mockResolvedValue(BUILDS())
})

// `history.pushState` is spied on in half the tests here and it is the REAL
// object's method, so a spy left standing counts the calls of every test after
// it — which is a suite that reports "pushed 14 times" for a test that pushed
// nothing at all.
afterEach(() => { vi.restoreAllMocks() })

/**
 * Both views the fixture build declares, in the order meta.json lists them.
 *
 * `parts` NAMES the catalogue keys a view shows rather than counting them
 * (issue #75), which is what lets the tab strip say what is in a tab without
 * fetching the geometry.
 */
const VIEWS = [
  { id: 'assembled', name: 'assembled', file: 'a.json',
    parts: ['plate', 'post'], gzip: 1000 },
  { id: 'printables', name: 'printables', file: 'p.json',
    parts: ['plate', 'post'], gzip: 900 },
]

/** The parts both views draw on, as `meta.parts` publishes them. */
const PARTS = {
  plate: { kind: 'printable', files: { stl: 'plate.stl' } },
  post: { kind: 'printable', files: { stl: 'post.stl' } },
}

/** A build of the target revision, with whichever views it is given. */
const build = (views = VIEWS) => ({
  project: 'fixture', title: '', commit: B, built: '2026-08-28T09:00:00Z',
  parts: PARTS, views,
})

/**
 * The project's history, as `builds.json` gives it. A FUNCTION rather than a
 * constant: a swap refreshes this list and the fixture holds it, so two tests
 * sharing one object would leave one another's swap in their state.
 */
const BUILDS = () => ({
  has_dev: false,
  latest: null,
  builds: [{ commit: A, built: '2026-08-27T18:20:00Z' },
           { commit: B, built: '2026-08-26T10:00:00Z' }],
})

/** The tree on screen: two parts, each naming its catalogue key. */
const TREE = {
  id: '/model',
  name: 'model',
  children: [{ id: '/model/plate', name: 'plate', key: 'plate' },
             { id: '/model/post', name: 'post', key: 'post' }],
}

/** The same model one revision later: `plate` renumbered, `post` gone. */
const TREE_B = {
  id: '/model',
  name: 'model',
  children: [{ id: '/model/0', name: 'plate', key: 'plate' }],
}

/**
 * The component as `switchBuild` and `onModel` see it.
 *
 * `setState` is the real one's CONTRACT and not React's — merge, then run the
 * callback — because the callback is where a swap tells the viewport.
 */
function component(over = {}) {
  const c = Object.create(HammerolaViewer.prototype)
  c.props = { ...HammerolaViewer.defaultProps }
  c.home = null
  c.carry = null
  c.history = []
  c.host = { current: null }
  c.state = {
    meta: {
      project: 'fixture', commit: A, built: '2026-08-27T18:20:00Z',
      parts: PARTS, views: VIEWS,
    },
    builds: BUILDS(),
    tree: indexTree(TREE),
    error: null, viewError: null, pending: null,
    view: 'assembled', tool: null, held: false,
    sel: null, selName: '', hidden: [], ghost: [], expanded: {},
    secOn: false, secOff: 0, secRange: null, secFlip: false, hatch: true,
    secFace: null, secPop: false,
    revOpen: false, dlOpen: false, cmp: [], compare: false, diffShow: 'both',
    bannerGone: false, rail: false, menu: null, swapping: false,
    notePop: null, noteDraft: '', notes: {},
    feed: [], activePin: null, composer: null,
    measure: null, toast: null,
    token: 'sekrit', tokenPop: false, tokenDraft: '',
    theme: 'light',
    ...over,
  }
  c.setState = vi.fn((patch, done) => {
    const next = typeof patch === 'function' ? patch(c.state) : patch
    c.state = { ...c.state, ...next }
    if (done) done()
  })
  c.sync = vi.fn()
  c.schedulePoll = vi.fn()
  c.toast = vi.fn()
  return c
}

/**
 * Record what the page hands to the BROWSER as a navigation, without letting
 * jsdom try one.
 *
 * `window.location` is a getter here, so the whole object can be stood in for —
 * and it has to be, since a write to `location.href` is the one thing on this
 * page that cannot be observed any other way: jsdom refuses the navigation, says
 * so on its own console and leaves every readable field exactly as it was. The
 * three reads the code makes are delegated to the real one so nothing else
 * changes meaning.
 */
function watchNavigation() {
  const real = Object.getOwnPropertyDescriptor(window, 'location')
  const at = () => real.get.call(window)
  const went = []
  const view = {
    get href() { return at().href },
    set href(value) { went.push(value) },
    get pathname() { return at().pathname },
    get search() { return at().search },
    get origin() { return at().origin },
  }
  Object.defineProperty(window, 'location', { configurable: true, get: () => view })
  onTestFinished(() => Object.defineProperty(window, 'location', real))
  return went
}

/** Let a handler that was fired and not awaited finish its fetch. */
const flush = () => new Promise((resolve) => { setTimeout(resolve, 0) })

/** The URL the last `pushState` wrote, or null. */
const pushed = (spy) => (spy.mock.calls.length ? spy.mock.calls.at(-1)[2] : null)

// -- the address --------------------------------------------------------------

describe('picking a revision', () => {
  it('pushes the address rather than loading the page', async () => {
    // The comment on `onPick` says a build is an ADDRESS, and that is about the
    // address bar rather than about the document: `pushState` keeps every word
    // of it — the URL changes, the link copies and opens as before — while the
    // page, the viewer and everything in front of the reader stay standing.
    const c = component()
    const went = watchNavigation()
    const push = vi.spyOn(history, 'pushState')
    loadMeta.mockResolvedValue(build())

    // THROUGH THE ROW, because the claim is about the picker and not about a
    // method: `computed()` builds the handler afresh on every call, so this is
    // the one the reader's click would reach.
    const row = c.computed().revRows.find((r) => r.key === B)
    row.onPick({ stopPropagation() {} })
    await flush()

    expect(went, 'the picker still navigates — the page is being thrown away')
      .toEqual([])
    expect(pushed(push)).toBe(path(B))
    expect(location.pathname).toBe(path(B))
  })

  it('re-derives PAGE, which is what everything else fetches through', async () => {
    // THE BUG THIS EXISTS TO CATCH, and it has no symptom of its own: `PAGE` is
    // computed once at import and nothing re-derives it, so a swap that moved
    // the URL and left the record alone would fetch meta.json, the view file,
    // the downloads and the comment route against the revision that had just
    // left the screen — silently, for as long as the page stayed open.
    const c = component()
    loadMeta.mockResolvedValue(build())

    await c.switchBuild('proj1', B)

    expect(PAGE.pid).toBe('proj1')
    expect(PAGE.slot).toBe(B)
    expect(PAGE.base).toBe(path(B))
  })

  it('sends the viewport the new base and the new build key', async () => {
    // The other half of the line above: `base` is where the geometry is fetched
    // from and `buildKey` is what makes the element treat the swap as a live
    // reload rather than a first load. Both are read off `PAGE` and `meta` at
    // the moment the event is dispatched, so the real `sync` is what is asked.
    const c = component()
    delete c.sync
    loadMeta.mockResolvedValue(build())
    const seen = []
    const listen = (event) => seen.push(event.detail)
    window.addEventListener(STATE, listen)
    onTestFinished(() => window.removeEventListener(STATE, listen))

    await c.switchBuild('proj1', B)

    expect(seen).toHaveLength(1)
    expect(seen[0].base).toBe(path(B))
    expect(seen[0].buildKey).toBe(B)
    expect(seen[0].view).toBe('assembled')
  })

  it('keeps ?v= when the target declares that view', async () => {
    // `load()` reads `?v=` on a fresh open, so the pushed URL has to carry it —
    // otherwise the address in the bar, copied and sent, shows a different view
    // than the person who sent it was looking at.
    const c = component({ view: 'printables' })
    const push = vi.spyOn(history, 'pushState')
    loadMeta.mockResolvedValue(build())

    await c.switchBuild('proj1', B)

    expect(pushed(push)).toBe(`${path(B)}?v=printables`)
    expect(c.state.view).toBe('printables')
  })

  it('carries the reader\'s own tab across, not the one the address still names',
    async () => {
      // A `?v=` in the bar is the view the ENTRY was pushed with, and the reader
      // has moved on from it: a view tab writes state and not the address, so a
      // row click that read the query would quietly put the page back on a tab
      // they had left. `popstate` is the one caller that wants the entry's view,
      // and it says so by not pushing.
      const c = component({ view: 'printables' })
      const push = vi.spyOn(history, 'pushState')
      loadMeta.mockResolvedValue(build())
      window.history.replaceState(null, '', `${path(A)}?v=assembled`)

      await c.switchBuild('proj1', B)

      expect(c.state.view, 'the swap took the address bar\'s view over the reader\'s')
        .toBe('printables')
      expect(pushed(push)).toBe(`${path(B)}?v=printables`)
    })

  it('drops it when the target has no such view, and falls back to the first',
    async () => {
      // Exactly what a fresh load of that URL does with a `?v=` naming a view
      // the build does not have. Carrying the query on would put a name in the
      // address that the page then ignores.
      const c = component({ view: 'printables' })
      const push = vi.spyOn(history, 'pushState')
      loadMeta.mockResolvedValue(build([VIEWS[0]]))

      await c.switchBuild('proj1', B)

      expect(pushed(push)).toBe(path(B))
      expect(c.state.view).toBe('assembled')
    })

  it('closes the picker before the fetch rather than after it', async () => {
    // The only sign the click landed on a gesture that now waits on the network
    // — and, since the menu leaves the screen with it, what stops a second row
    // being picked while the first swap is still in flight, which would leave
    // two of them racing to push two entries and settle two different `PAGE`s.
    const c = component({ revOpen: true })
    let settle = null
    loadMeta.mockReturnValue(new Promise((resolve) => { settle = resolve }))

    const swapping = c.switchBuild('proj1', B)
    expect(c.state.revOpen).toBe(false)

    settle(build())
    await swapping
  })

  it('closes the picker and fetches nothing for the build already on screen',
    async () => {
      const c = component({ revOpen: true })
      await c.switchBuild('proj1', A)
      expect(c.state.revOpen).toBe(false)
      expect(loadMeta).not.toHaveBeenCalled()
      expect(loadBuilds).not.toHaveBeenCalled()
    })

  it('re-reads the history the picker itself lists', async () => {
    // WHAT THE RELOAD USED TO DO FOR FREE. `builds.json` is read once on mount,
    // so without this a session of switching would go on offering the history as
    // it stood when the page opened — and a revision published meanwhile could
    // not be reached from the menu at all, on the one page whose job is to
    // move between revisions.
    const c = component()
    const C = 'c'.repeat(64)
    loadMeta.mockResolvedValue(build())
    loadBuilds.mockResolvedValue({
      has_dev: true, latest: C,
      builds: [{ commit: C, built: '2026-08-29T12:00:00Z' },
               ...BUILDS().builds],
    })

    await c.switchBuild('proj1', B)
    await flush()

    expect(c.state.builds.builds.map((b) => b.commit)).toEqual([C, A, B])
    expect(c.computed().revRows.some((r) => r.key === C)).toBe(true)
  })

  it('swaps anyway when that list will not load', async () => {
    // A menu is not worth a failed swap: the model is what the reader asked for
    // and the history is a list behind a button they are not looking at.
    const c = component()
    loadMeta.mockResolvedValue(build())
    loadBuilds.mockRejectedValue(new Error('nope'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await c.switchBuild('proj1', B)
    await flush()

    expect(c.state.meta.commit).toBe(B)
    expect(c.state.builds).toEqual(BUILDS())
    expect(warn).toHaveBeenCalled()
  })
})

// -- what a row says ----------------------------------------------------------

describe('the message on a picker row', () => {
  it('is what the revision said it was, and the pointers have none', () => {
    // The menu is a column of twelve hex characters and a column of timestamps:
    // between them they tell two revisions APART without saying what either one
    // is. `builds.json` carries the subject of a revision that was pushed with
    // `-m` (issue #67), and the row is where it lands.
    //
    // `dev` and `latest` are NAMES that resolve to whatever is current, so
    // there is no one revision for them to describe — an empty string, which is
    // also what keeps their rows the shape every row used to be.
    const c = component({
      builds: {
        has_dev: true,
        latest: A,
        builds: [{ commit: A, built: '2026-08-27T18:20:00Z',
                   message: 'the bracket got thicker' },
                 { commit: B, built: '2026-08-26T10:00:00Z' }],
      },
    })

    const rows = new Map(c.computed().revRows.map((r) => [r.key, r]))
    expect(rows.get(A).message).toBe('the bracket got thicker')
    // Pushed before the field existed, or pushed without `-m`: the row draws
    // exactly as it drew when the spacer was in that place.
    expect(rows.get(B).message).toBe('')
    expect(rows.get('dev').message).toBe('')
    expect(rows.get('latest').message).toBe('')
  })

  it('takes the free width and stays on one line', () => {
    // It sits where the spacer sat, which is the whole reason a message can be
    // put here at all: the row is a flex line and that element is what grows,
    // so an eighty-character subject has to give the width back by ellipsis
    // rather than by wrapping the date onto a second line.
    const c = component({
      builds: { has_dev: false, latest: null,
                builds: [{ commit: A, built: '2026-08-27T18:20:00Z',
                           message: 'x'.repeat(200) }] },
    })

    const style = c.computed().revRows[0].messageStyle
    expect(style).toContain('flex:1')
    expect(style).toContain('min-width:0')
    expect(style).toContain('white-space:nowrap')
    expect(style).toContain('text-overflow:ellipsis')
  })
})

// -- back and forward ---------------------------------------------------------

describe('popstate', () => {
  /** The component with its real listeners on the window. */
  const mounted = () => {
    // `readNotes` runs on mount and this runner has no `localStorage`; store.js
    // catches that and says so, which is one line of noise per test here.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = component()
    // The first load is what `componentDidMount` does before the listeners go
    // up; it is not what this block is about, and it would reach a hub.
    c.load = vi.fn(async () => {})
    c.componentDidMount()
    onTestFinished(() => c.componentWillUnmount())
    return c
  }

  it('switches back the same way, and does not push again', async () => {
    // The entries this page pushed are entries it now has to answer for: Back
    // that moved the address bar and left the previous revision on screen would
    // be a worse lie than the reload this replaced.
    const c = mounted()
    const push = vi.spyOn(history, 'pushState')
    loadMeta.mockResolvedValue(build())

    window.history.replaceState(null, '', path(B))
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flush()

    expect(PAGE.slot).toBe(B)
    expect(c.state.meta.commit).toBe(B)
    expect(push, 'a popstate that pushes buries the entry the reader came back to')
      .not.toHaveBeenCalled()
  })

  it('restores the view the entry names, not the tab that is open', async () => {
    // A `popstate` is the browser putting an entry BACK on the screen, and the
    // `?v=` on it is the state being restored. Reading the current tab instead
    // would leave the address bar saying one view while the page showed another
    // — the same failure this whole entry is about, spelled with Back.
    const c = mounted()
    loadMeta.mockResolvedValue(build())

    window.history.replaceState(null, '', `${path(B)}?v=printables`)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flush()

    expect(c.state.view).toBe('printables')
  })

  it('ignores an entry that names the build already on screen', async () => {
    const c = mounted()
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flush()
    expect(loadMeta).not.toHaveBeenCalled()
  })

  it('calls a swap off without taking another', async () => {
    // COMING BACK TO THE BUILD ON SCREEN IS NOT A TRIP. The entry used to be
    // thrown away as a no-op — "already here" was asked against `PAGE.slot`,
    // which during a swap still names the build being LEFT — so the swap landed
    // under an address bar saying otherwise. The answer to that is to cancel,
    // and cancelling is where the second version went wrong: it ran the whole
    // of `switchBuild` against the build that had never left the screen.
    //
    // What that cost is asserted here rather than described, because none of it
    // looks like a failure at the time. `leaveBuild` throws away the reader's
    // own work over a gesture that asked for nothing; and the viewport is then
    // handed a payload identical to the one it holds, which it reads as nothing
    // to load — so no `hmr:model` comes back, `onModel` never runs, and the two
    // things it spends stay armed for an unrelated event to trip over later.
    const c = mounted()
    const push = vi.spyOn(history, 'pushState')
    const answers = {}
    loadMeta.mockImplementation((fresh, base) => new Promise((resolve) => {
      answers[base] = resolve
    }))
    // The reader's own state, none of which this gesture is about.
    c.setState({ sel: '/model/plate', selName: 'plate' })
    c.carry = null

    // Onto B: a swap starts and stays on the network.
    window.history.replaceState(null, '', path(B))
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flush()
    expect(PAGE.slot, 'the swap landed early, so the window is gone').toBe(A)

    // And straight back onto A — the entry that names the build on screen.
    window.history.replaceState(null, '', path(A))
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flush()
    // The cancelled swap answers anyway; nothing may come of it.
    answers[path(B)](build())
    await flush()

    expect(c.state.meta.commit, 'the cancelled swap landed').toBe(A)
    expect(PAGE.slot).toBe(A)
    expect(loadMeta.mock.calls.map((call) => call[1]),
           'the build already on screen was fetched again').toEqual([path(B)])
    expect(push, 'staying put pushed an entry').not.toHaveBeenCalled()

    // Nothing of the reader's was thrown away…
    expect(c.state.sel, 'the selection went over a gesture that asked to stay')
      .toBe('/model/plate')
    // …and nothing was left armed for a later event to spend.
    expect(c._refit, 'a refit is waiting for a model event that will never come')
      .toBeFalsy()
    expect(c.carry, 'a carry is waiting for a model event that will never come')
      .toBeNull()
    // The banner's Switch is a live button again: the swap that raised the flag
    // is not coming back to lower it.
    expect(c.state.swapping).toBe(false)
  })

  it('restores the view the entry names while calling the swap off', async () => {
    // The one thing that CAN still be out of step when the build does not move.
    // The field is written bare rather than through `showView` — which on a page
    // with a comparison up is not a view switch at all but a restart of the
    // comparison, address and all (compare.test.js, `restores an entry's view
    // without restarting the comparison on it`). Here there is no comparison, so
    // the two answers are the same one and this test cannot tell them apart;
    // what it holds is that the entry's `?v=` still lands.
    const c = mounted()
    loadMeta.mockImplementation(() => new Promise(() => {}))

    window.history.replaceState(null, '', path(B))
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flush()

    window.history.replaceState(null, '', `${path(A)}?v=printables`)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flush()

    expect(c.state.view).toBe('printables')
  })

  it('leaves the destination where the page really is, so that build is reachable',
    async () => {
      // `_want` is where the page is GOING, and the swap that was going there is
      // dead. Left standing on the build the reader turned back from, it makes
      // every later gesture asking for that build — from either door — look like
      // a request for what is already on its way, and be swallowed. The row goes
      // on eating clicks for the rest of the page's life.
      const c = mounted()
      const answers = {}
      loadMeta.mockImplementation((fresh, base) => new Promise((resolve) => {
        answers[base] = resolve
      }))

      window.history.replaceState(null, '', path(B))
      window.dispatchEvent(new PopStateEvent('popstate'))
      await flush()
      window.history.replaceState(null, '', path(A))
      window.dispatchEvent(new PopStateEvent('popstate'))
      await flush()

      // And now the reader asks for that revision again, deliberately.
      loadMeta.mockClear()
      const live = c.switchBuild('proj1', B)
      await flush()
      expect(loadMeta, 'the gesture was swallowed as one already on its way')
        .toHaveBeenCalled()
      answers[path(B)](build())
      await live

      expect(c.state.meta.commit).toBe(B)
      expect(PAGE.slot).toBe(B)
    })

  it('goes back to being a no-op once a swap has failed', async () => {
    // The destination is only a destination while the page is still going
    // there. A target that 404'd is not, and left standing in `_want` it would
    // make the entry naming the build ON SCREEN look like a real move — one
    // fetch of a revision that never left it.
    const c = mounted()
    loadMeta.mockRejectedValue(new Error('meta.json -> HTTP 404'))

    window.history.replaceState(null, '', path(B))
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flush()
    expect(c.state.viewError, 'the swap did not fail, so nothing is under test')
      .toContain('did not load')

    loadMeta.mockClear()
    window.history.replaceState(null, '', path(A))
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flush()

    expect(loadMeta, 'the build already on screen was fetched again')
      .not.toHaveBeenCalled()
  })

  it('overrules a pick still on the wire rather than doubling it', async () => {
    // BACK IS A GESTURE LIKE ANY OTHER and is supposed to win, which is the
    // second way two swaps used to end up in flight together. This one never
    // went through the picker at all, so closing the menu was never going to
    // reach it — and its own "already here" guard reads `PAGE.slot`, which a
    // swap moves only after its fetch answers. So Back during a slow pick sails
    // straight through and starts a second swap; whichever answered last then
    // decided what the reader was looking at.
    const C = 'c'.repeat(64)
    const c = mounted()
    const push = vi.spyOn(history, 'pushState')
    const answers = {}
    loadMeta.mockImplementation((fresh, base) => new Promise((resolve) => {
      answers[base] = resolve
    }))

    // A revision picked from the menu, gone to the network and staying there.
    const picked = c.switchBuild('proj1', C)
    // Back, onto the entry before it, while that fetch is still out.
    window.history.replaceState(null, '', path(B))
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flush()

    // The pick answers LAST, so nothing here is decided by the network.
    answers[path(B)](build())
    await flush()
    answers[path(C)]({ ...build(), commit: C })
    await picked
    await flush()

    expect(PAGE.slot, 'the overtaken pick landed on top of Back').toBe(B)
    expect(c.state.meta.commit).toBe(B)
    expect(push, 'the superseded pick pushed an entry on its way out')
      .not.toHaveBeenCalled()
  })
})

// -- two of them in flight at once --------------------------------------------
//
// The picker closes before the fetch, and this file used to read that as a lock
// on picking a second row. It is not one: `revToggle` reopens the menu with one
// click and `onPick` asks nothing before calling `switchBuild` again. So the
// ordering has to be in the method — by number, not by refusing the gesture.

describe('a second revision picked while the first is fetching', () => {
  /** Two swaps held at the network, answered by base, one at a time. */
  function held() {
    const answers = {}
    loadMeta.mockImplementation((fresh, base) => new Promise((resolve, reject) => {
      answers[base] = { resolve, reject }
    }))
    return answers
  }

  it('lands the build asked for LAST, whichever answers first', async () => {
    // The reader picks B, reopens the menu, picks C. Both fetches are out, and
    // without a generation the page settles in the order the NETWORK answered:
    // C arrives, then B arrives on top of it, and a reader whose last word was C
    // is looking at B. The history behind them reads `push B, push C, push B`,
    // which no sequence of gestures could have produced.
    const C = 'c'.repeat(64)
    const c = component()
    const push = vi.spyOn(history, 'pushState')
    const answers = held()

    const first = c.switchBuild('proj1', B)
    // What `revToggle` does, which is all it takes to get here.
    c.setState({ revOpen: true })
    const second = c.switchBuild('proj1', C)

    answers[path(C)].resolve({ ...build(), commit: C })
    await second
    answers[path(B)].resolve(build())
    await first

    expect(c.state.meta.commit, 'the older swap landed on top of the newer').toBe(C)
    expect(PAGE.slot).toBe(C)
    expect(push.mock.calls.map((call) => call[2]),
           'the overtaken swap left an entry in the history').toEqual([path(C)])
  })

  it('does not let the older one\'s failure hand the banner back', async () => {
    // THE PROPERTY THIS ROUND ADDED, cancelled by its own error path: `swapping`
    // is what takes the banner's Switch out of service while a revision is
    // fetching, and `swapFailed` lowers it. A stale swap answering 404 therefore
    // lowered it under a swap that was still on the wire — reopening exactly the
    // window the flag exists to close, from the one place nobody looks.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const C = 'c'.repeat(64)
    const c = component({ pending: { commit: 'ccc', parts: PARTS, views: VIEWS } })
    c.el = () => null
    const answers = held()

    const first = c.switchBuild('proj1', B)
    const second = c.switchBuild('proj1', C)

    answers[path(B)].reject(new Error('meta.json -> HTTP 404'))
    await first

    expect(c.state.swapping, 'the stale 404 put the banner back in service')
      .toBe(true)
    expect(c.computed().bannerSwitchStyle).not.toContain('cursor:pointer')
    // And it says nothing on screen about a build nobody is waiting for.
    expect(c.state.viewError,
           'a swap the reader had already replaced reported its failure').toBeNull()
    c.computed().bannerSwitch()
    expect(c.state.meta.commit, 'the banner ran in the middle of a live swap')
      .toBe(A)

    // The live one still owns the flag and still puts it down.
    answers[path(C)].resolve({ ...build(), commit: C })
    await second
    expect(c.state.swapping).toBe(false)
  })

  it('is not cancelled by a click on the row it is already going to', async () => {
    // WHERE THE NUMBER IS TAKEN, which is the other half of the decision: after
    // the "already going there" guard rather than above it. A click on the row
    // the swap is fetching asks for exactly what is on its way, so a bump here
    // would kill the fetch and leave nothing at all to land — the page frozen on
    // the old build with the picker closed and no error anywhere.
    const c = component()
    const answers = held()

    const live = c.switchBuild('proj1', B)
    // The reader reopens the picker and clicks the row they already picked.
    c.setState({ revOpen: true })
    await c.switchBuild('proj1', B)
    answers[path(B)].resolve(build())
    await live

    expect(c.state.meta.commit, 'the swap the click asked for was cancelled').toBe(B)
    expect(PAGE.slot).toBe(B)
    expect(c.state.revOpen, 'the picker stayed open over a row that was clicked')
      .toBe(false)
  })

  it('is called off by a click on the row still on screen', async () => {
    // THE SAME GESTURE AS FORWARD-ONTO-THE-CURRENT-BUILD, through the other
    // door, and it has to mean the same thing: the picker highlights the build
    // on SCREEN, so clicking it while a swap is carrying the page elsewhere is
    // the reader saying they want to stay. Cancel the trip, take no other, and
    // leave the reader's own work alone — this used to leave the swap running
    // and hand them a revision they had just declined.
    const c = component({ sel: '/model/plate' })
    const answers = held()

    const live = c.switchBuild('proj1', B)
    c.setState({ revOpen: true })
    await c.switchBuild('proj1', A)
    // The cancelled fetch answers anyway; nothing may come of it.
    answers[path(B)].resolve(build())
    await live

    expect(c.state.meta.commit, 'the declined build arrived anyway').toBe(A)
    expect(PAGE.slot).toBe(A)
    expect(c.state.sel, 'the selection went with a build that never left').toBe('/model/plate')
    expect(c.state.swapping, 'the banner was left holding a swap nobody is waiting for')
      .toBe(false)
  })

  it('puts the address back when it was a popstate that started the swap',
    async () => {
      // THE COMBINATION NEITHER DOOR COVERED ON ITS OWN. A picked swap moves
      // nothing until its fetch answers, so calling one off leaves the bar where
      // it was — which is what the test above measures, and why it cannot see
      // this. A `popstate` swap is the other way round: it exists BECAUSE the
      // browser moved first. Forward onto B, then a click on the row for A still
      // on screen, and the page stays on A under an address saying B — F5 opens
      // the build the reader just declined, the copied link points at it, and
      // the next Back reads as "nothing happened". Nothing else on the page
      // brings the two back together.
      const c = component({ sel: '/model/plate' })
      const answers = held()

      // Forward: the browser has moved the address, and the swap is what
      // `popstate` starts behind it.
      window.history.replaceState(null, '', path(B))
      const live = c.switchBuild('proj1', B, { push: false })

      // Seeing nothing happen yet, the reader opens the picker and clicks the
      // row that is still on screen — "no, I am staying here".
      const push = vi.spyOn(history, 'pushState')
      c.setState({ revOpen: true })
      await c.switchBuild('proj1', A)
      answers[path(B)].resolve(build())
      await live

      expect(PAGE.slot).toBe(A)
      // The whole address, query included: the view showing IS this build's
      // first, so the address that opens on it carries no `?v=` at all.
      expect(`${location.pathname}${location.search}`,
             'the bar was left naming the build the reader declined').toBe(path(A))
      // A cancelled navigation is not a navigation: a third entry here would
      // send the next Back straight back to the build just declined.
      expect(push, 'calling a swap off pushed a history entry').not.toHaveBeenCalled()
    })

  it('takes the view showing into the address it puts right', async () => {
    // The address is assembled the way a landing swap assembles it, `?v=` and
    // all. Writing the bare path instead would repair the divergence over the
    // BUILD and open one over the VIEW: F5 would then land on the build's first
    // view rather than the tab the reader is looking at.
    //
    // AND THE VIEW IS THE ONE ON SCREEN, not the one the abandoned entry names.
    // The entry being cancelled here says `assembled`; the page never got there,
    // so the tab in front of the reader is still `printables` and that is what
    // the address has to describe.
    const c = component({ view: 'printables' })
    const answers = held()

    window.history.replaceState(null, '', `${path(B)}?v=assembled`)
    const live = c.switchBuild('proj1', B, { push: false })
    c.setState({ revOpen: true })
    await c.switchBuild('proj1', A)
    answers[path(B)].resolve(build())
    await live

    expect(`${location.pathname}${location.search}`)
      .toBe(`${path(A)}?v=printables`)
  })

  it('leaves the view tab alone, because a row click says nothing about views',
    async () => {
      // The other half of the restore above: calling a swap off puts the ENTRY's
      // `?v=` back only when an entry is what asked. Here the reader picked the
      // tab after that entry was pushed, so the view the address still names is
      // out of date rather than wanted — and a click on a build row would be a
      // strange thing to lose a view tab to.
      const c = component({ view: 'printables' })
      const answers = held()
      window.history.replaceState(null, '', `${path(A)}?v=assembled`)

      const live = c.switchBuild('proj1', B)
      c.setState({ revOpen: true })
      await c.switchBuild('proj1', A)
      answers[path(B)].resolve(build())
      await live

      expect(c.state.view, 'a build row put the address bar\'s view back')
        .toBe('printables')
      // NOR THE OTHER WAY ROUND. Nothing diverged here — a picked swap moves no
      // address — so the branch has nothing to repair and writes nothing. An
      // unconditional replace would carry the reader's tab into an entry they
      // did not touch, which is the same sentence read backwards.
      expect(`${location.pathname}${location.search}`,
             'a row click rewrote the entry the reader was standing on')
        .toBe(`${path(A)}?v=assembled`)
    })

  it('does not lay a second entry over the one the reader is standing on',
    async () => {
      // THE PICKER USED TO ASK `PAGE.slot`, and `PAGE` lags a swap by a fetch.
      // Forward onto B starts one; the reader, seeing nothing happen yet, opens
      // the picker and clicks row B. The click read as a real gesture, and
      // `pushState` laid a SECOND entry for B on top of the one they were
      // standing on: one Back afterwards looks like nothing happened, and the
      // forward history is cut off.
      const c = component()
      const push = vi.spyOn(history, 'pushState')
      const answers = held()

      // What `popstate` does: the browser has already moved the address, and
      // the swap that follows must not push it again.
      window.history.replaceState(null, '', path(B))
      const live = c.switchBuild('proj1', B, { push: false })
      c.setState({ revOpen: true })
      await c.switchBuild('proj1', B)
      answers[path(B)].resolve(build())
      await live

      expect(PAGE.slot).toBe(B)
      expect(push, 'the click duplicated the history entry it was standing on')
        .not.toHaveBeenCalled()
    })

  it('still reports the failure of the swap nobody replaced', async () => {
    // The control on the line above: silence belongs to the OVERTAKEN swap
    // alone. A 404 on the swap the reader is actually waiting for is the one
    // thing `viewError` is for, and a generation check written a line too wide
    // would take it away.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = component()
    loadMeta.mockRejectedValue(new Error('meta.json -> HTTP 404'))

    await c.switchBuild('proj1', B)

    expect(c.state.viewError).toContain('did not load')
    expect(c.state.swapping).toBe(false)
  })
})

// -- what survives ------------------------------------------------------------

describe('the camera', () => {
  it('is not re-homed by a rebuild landing under the pointer', () => {
    // `home` is the frame the LIBRARY fitted, and it is the whole of what Fit
    // means. A live reload arrives with the reader's own frame already restored
    // by the viewport, so reading the camera back here would record that as "fit"
    // and leave the button doing nothing at all.
    const c = component()
    c.captureHome = vi.fn()

    c.onModel({ tree: TREE, view: 'assembled', live: true })
    expect(c.captureHome).not.toHaveBeenCalled()

    c.onModel({ tree: TREE, view: 'assembled', live: false })
    expect(c.captureHome).toHaveBeenCalledTimes(1)
  })

  it('IS re-homed by a revision switch, once, when its model lands', async () => {
    // The exception to the line above, and the failure it closes has no symptom
    // of its own. A swap takes the same live path, but the model that arrives is
    // a DIFFERENT BUILD with a bounding box of its own — so a `home` left alone
    // stays the frame fitted to the build this page opened FIRST, and Fit then
    // shows a part that grew three times over cropped, silently, with the button
    // looking exactly as it always does.
    const c = component()
    c.captureHome = vi.fn()
    loadMeta.mockResolvedValue(build())

    await c.switchBuild('proj1', B)
    expect(c.captureHome, 'homed before the new geometry had even arrived')
      .not.toHaveBeenCalled()

    c.onModel({ tree: TREE_B, view: 'assembled', live: true })
    expect(c.captureHome).toHaveBeenCalledTimes(1)

    // And the flag is SPENT, exactly like `carry`: a live reload after the swap
    // is a rebuild of the build now on screen, and homing on one of those would
    // overwrite the fit with wherever the reader happened to be looking.
    c.onModel({ tree: TREE_B, view: 'assembled', live: true })
    expect(c.captureHome).toHaveBeenCalledTimes(1)
  })

  it('IS re-homed by taking the banner\'s build, for the same reason', async () => {
    // Switch on the "new build" banner opens a build too — a different commit,
    // built from different sources, with a box of its own — and it reaches the
    // viewport by the same live path as a revision switch. Fit reads "back to
    // the frame this view opened in", so leaving `home` alone here would keep it
    // pointing at the build the page was loaded with, however many builds ago
    // that was.
    const c = component({ pending: { commit: 'ccc', parts: PARTS, views: VIEWS } })
    c.captureHome = vi.fn()
    c.el = () => null

    c.takePending()
    expect(c.state.meta.commit, 'the offer was not taken at all').toBe('ccc')
    expect(c.captureHome, 'homed before the new geometry had arrived')
      .not.toHaveBeenCalled()

    c.onModel({ tree: TREE_B, view: 'assembled', live: true })
    expect(c.captureHome).toHaveBeenCalledTimes(1)

    // Spent, like the swap's: the next live model is a rebuild of the build now
    // on screen, and homing on one of those records wherever the reader is
    // looking as the fit.
    c.onModel({ tree: TREE_B, view: 'assembled', live: true })
    expect(c.captureHome).toHaveBeenCalledTimes(1)
  })

  it('is not re-homed by an offer the viewport was too busy to take', async () => {
    // The flag is set where the swap COMMITS, not at the top of the method: the
    // busy branch returns having changed nothing, and a flag left standing there
    // would be spent by whichever rebuild happened to land next — re-homing the
    // camera on a build nobody switched to.
    const c = component({ pending: { commit: 'ccc', parts: PARTS, views: VIEWS } })
    c.captureHome = vi.fn()
    c.el = () => ({ isBusy: () => true })

    c.takePending()
    expect(c.state.meta.commit, 'swapped while the reader had hold of it').toBe(A)

    c.onModel({ tree: TREE, view: 'assembled', live: true })
    expect(c.captureHome).not.toHaveBeenCalled()
    clearTimeout(c._swap)
  })

  it('rides across on the element, which is what `live` buys', async () => {
    // What actually keeps the frame is one flag on the viewport's own load: the
    // base changed under the same view, so the element captures the camera, the
    // visibility and the section, renders the new geometry and puts them back.
    // The element half of that is asserted in element.test.js; this is the
    // interface asking for it.
    const c = component()
    delete c.sync
    loadMeta.mockResolvedValue(build())
    const seen = []
    const listen = (event) => seen.push(event.detail)
    window.addEventListener(STATE, listen)
    onTestFinished(() => window.removeEventListener(STATE, listen))

    await c.switchBuild('proj1', B)

    // Same view, different base: the two conditions the element reads as a live
    // swap rather than as a fresh arrangement to re-fit to.
    expect(seen[0].view).toBe('assembled')
    expect(seen[0].base).not.toBe(path(A))
  })
})

describe('hidden and translucent parts', () => {
  it('are re-resolved by NAME, and one that vanished is dropped', async () => {
    // They are held as leaf ids, and an id is a solid path a rebuild is free to
    // renumber; a name is what the person recognises and what they meant. A part
    // that is gone cannot stay hidden, so it is simply dropped — carrying the
    // name on would leave a list of instructions about parts nobody can see or
    // unhide.
    const c = component({ hidden: ['/model/plate'], ghost: ['/model/post'] })
    loadMeta.mockResolvedValue(build())

    await c.switchBuild('proj1', B)
    c.onModel({ tree: TREE_B, view: 'assembled', live: true })

    expect(c.state.hidden).toEqual(['/model/0'])
    expect(c.state.ghost).toEqual([])
  })

  it('reach the viewport, rather than only this side', async () => {
    // The re-resolved ids are new strings the element has never seen, and a
    // state event is the only road there. Without one the tree would draw the
    // right part greyed out while the scene showed it.
    const c = component({ hidden: ['/model/plate'] })
    loadMeta.mockResolvedValue(build())

    await c.switchBuild('proj1', B)
    c.sync.mockClear()
    c.onModel({ tree: TREE_B, view: 'assembled', live: true })

    expect(c.sync).toHaveBeenCalledTimes(1)
  })

  it('survive a swap whose view never rendered, into the build opened instead',
    async () => {
      // THE THIRD PATH, and the one where the carry is worth the most: the swap
      // that failed left an UNSPENT carry standing — `rejoin` is consumed by a
      // model event, and the model event of a view that would not render never
      // arrives — while `onViewError` cleared the tree those names were read
      // off. A reader who answers that failure by opening ANOTHER build rather
      // than pressing Retry then arrives at `leaveBuild` with no tree, and
      // recomputing the carry there answered "nothing was hidden" and threw away
      // names that were still exactly right. Every hidden part back on screen,
      // over a failure two gestures ago, with nothing saying why.
      const C = 'c'.repeat(64)
      const c = component({ hidden: ['/model/plate'] })
      c.captureHome = vi.fn()
      loadMeta.mockResolvedValue(build())

      await c.switchBuild('proj1', B)
      c.onViewError({ message: 'a.json -> HTTP 503' })
      expect(c.state.tree, 'the tree stood, so nothing here is under test').toBeNull()

      await c.switchBuild('proj1', C)
      c.onModel({ tree: TREE_B, view: 'assembled', live: true })

      expect(c.state.hidden, 'the part came back because its name was forgotten')
        .toEqual(['/model/0'])
    })

  it('are not resurrected by a carry the reader has already overruled',
    async () => {
      // THE MIRROR OF THE TEST ABOVE, and it is what keeping the carry cost
      // until `setVisibility` was added. The carry is a SNAPSHOT, taken when a
      // build opens and spent when its model lands, and between those two the
      // reader can still work the tree — which is exactly the state a failed
      // view leaves them in. The three buttons over the panel are rendered
      // outside the `hasTree` branch, so "show all parts" is live with no tree
      // at all: press it, open another build, and a part the reader had just
      // unhidden came back HIDDEN, resurrected by a list taken before they
      // touched it.
      const C = 'c'.repeat(64)
      const c = component({ hidden: ['/model/plate'] })
      c.captureHome = vi.fn()
      loadMeta.mockResolvedValue(build())

      await c.switchBuild('proj1', B)
      c.onViewError({ message: 'a.json -> HTTP 503' })
      // Through the handler the page renders, on the button that is reachable
      // in this state — not through `setVisibility`, which would be the test
      // asserting its own fix.
      c.computed().showAll()
      expect(c.state.hidden, 'show all parts did not unhide anything').toEqual([])

      await c.switchBuild('proj1', C)
      c.onModel({ tree: TREE_B, view: 'assembled', live: true })

      expect(c.state.hidden, 'the part came back hidden, two gestures later')
        .toEqual([])
    })

  it('follow a part hidden while the new build was still on the wire',
    async () => {
      // THE WINDOW THIS ALL TURNS ON, and the one no test used to enter. It is
      // not the meta fetch — `leaveBuild` runs after that answers — it is the
      // geometry download and the render, the long part, and it is spent with
      // the LEAVING build's tree on screen and its rows live. A click there
      // writes an id of the old tree, and only the snapshot, taken in names,
      // can carry it across.
      //
      // Dropping the snapshot instead left the id an id. On this tree — the two
      // parts rebuilt onto each other's paths, which is what a renumber looks
      // like — `/model/plate` is `post` afterwards, so the reader hid one part
      // and a DIFFERENT one disappeared. Losing the gesture would have been the
      // better failure of the two.
      const SWAPPED = {
        id: '/model',
        name: 'model',
        children: [{ id: '/model/post', name: 'plate' },
                   { id: '/model/plate', name: 'post' }],
      }
      // Expanded, because the panel emits a row for a part only under an open
      // group — an unexpanded tree has one row and it is the whole model.
      const c = component({ expanded: { '/model': true } })
      c.captureHome = vi.fn()
      loadMeta.mockResolvedValue(build())

      await c.switchBuild('proj1', B)
      expect(c.state.tree, 'the leaving tree was cleared, so the window is gone')
        .toBeTruthy()
      expect(c.carry, 'no snapshot was taken, so nothing here is under test')
        .toEqual({ hidden: [], ghost: [] })

      // Through the row the panel renders, not through `setVisibility` — a test
      // that called the fix directly would assert only that it exists.
      const row = c.computed().rows.find((r) => r.key === '/model/plate')
      row.onVis({ stopPropagation() {} })
      expect(c.state.hidden, 'the eye did not hide anything').toEqual(['/model/plate'])

      c.onModel({ tree: SWAPPED, view: 'assembled', live: true })

      expect(c.state.hidden, 'the old id was applied to the new tree, where it '
        + 'belongs to another part').toEqual(['/model/post'])
    })

  it('do not start a carry on a page where no build is opening', () => {
    // The other half of the recompute, and why it is `if (this.carry)`. Writing
    // a snapshot on every visibility gesture would leave one standing on an
    // ordinary page, and `rejoin` spends whatever it finds on the NEXT model
    // event of any kind — a live reload, a view tab — re-seating ids by name
    // across a build nobody switched away from.
    const c = component({ hidden: ['/model/plate'] })

    c.computed().showAll()

    expect(c.carry, 'a gesture with no swap behind it left a carry').toBeNull()
  })

  it('carry nothing at all when no tree has ever landed', () => {
    // The other end of the same rule, and the reason it is `if (tree)` rather
    // than `carry || …`: a first load that failed has no names to keep and none
    // to read, so `rejoin` must go on answering "there is nothing to rejoin".
    // An empty carry is a different answer — it is an instruction to unhide
    // everything.
    const c = component({ tree: null, hidden: ['/model/plate'] })

    c.leaveBuild(true)

    expect(c.carry).toBeNull()
  })

  it('ARE cleared by a build that genuinely has no parts', () => {
    // "No tree" and "a tree with nothing in it" are not the same fact and the
    // code can tell them apart: `indexTree` always answers with an object, so a
    // build with no solids is truthy here and its empty answer is one somebody
    // established. Nothing in it can be hidden, so the carry goes.
    const c = component({ tree: indexTree({ id: '/model', name: 'model', children: [] }),
                          hidden: ['/model/plate'] })
    c.carry = { hidden: ['plate'], ghost: [] }

    c.leaveBuild(true)

    expect(c.carry).toEqual({ hidden: [], ghost: [] })
  })

  it('are left alone by an ordinary live reload', () => {
    // Every model event that is not a swap — a first load, a rebuild arriving
    // under a pointer, a view tab — has nothing carried and must change neither
    // list.
    const c = component({ hidden: ['/model/plate'], ghost: ['/model/post'] })

    c.onModel({ tree: TREE, view: 'assembled', live: true })

    expect(c.state.hidden).toEqual(['/model/plate'])
    expect(c.state.ghost).toEqual(['/model/post'])
    // THE STATE EVENT GOES OUT ANYWAY, which it did not before issue #33: it was
    // withheld unless something had been rejoined, on the ground that nothing
    // else in it had changed. A comment pin now hangs on the catalogue key and
    // is placed by asking the viewport where that part IS, so every model event
    // moves pins — the tree that has just landed is a rebuild free to have
    // renumbered or moved the part a comment names.
    expect(c.sync).toHaveBeenCalledTimes(1)
  })
})

// -- taking one of those gestures back ----------------------------------------
//
// Issue #84. The tree's controls are the one place on this page where a single
// click changes many rows at once — Isolate hides everything the reader did not
// point at — and until now nothing put them back. The stack lives on the
// instance rather than in state, so what these tests read is what the reader
// reads: the two lists, and the scene event they are sent on.

describe('Ctrl+Z over the tree', () => {
  /** Three parts, so an Isolate has more than one thing to hide. */
  const THREE = {
    id: '/model',
    name: 'model',
    children: [{ id: '/model/plate', name: 'plate', key: 'plate' },
               { id: '/model/post', name: 'post', key: 'post' },
               { id: '/model/lid', name: 'lid', key: 'lid' }],
  }

  // Expanded, because the panel emits a row for a part only under an open
  // group — an unexpanded tree has one row and it is the whole model.
  const opened = (over = {}) => component({
    tree: indexTree(THREE), expanded: { '/model': true }, ...over,
  })

  const row = (c, id) => c.computed().rows.find((r) => r.key === id)
  const click = { stopPropagation() {}, preventDefault() {} }

  it('puts back BOTH lists as the last gesture found them', () => {
    // Both, and not only the one the gesture named: a step is the pair, which
    // is what makes a snapshot of the two a whole step to go back to. An undo
    // that restored `hidden` alone would take the reader's translucent parts
    // with it every time they unhid something.
    const c = opened({ ghost: ['/model/lid'] })

    row(c, '/model/plate').onVis(click)
    expect(c.state.hidden, 'the eye hid nothing').toEqual(['/model/plate'])

    c.undoVisibility()

    expect(c.state.hidden).toEqual([])
    expect(c.state.ghost).toEqual(['/model/lid'])
  })

  it('brings back everything Isolate hid, in ONE step', () => {
    // The gesture this feature is really for: one click, every other row gone.
    const c = opened()
    c.state.menu = { id: '/model/plate', x: 0, y: 0 }

    c.computed().menuItems.find((m) => m.label === 'Isolate').onClick(click)
    expect(c.state.hidden).toEqual(['/model/post', '/model/lid'])

    c.undoVisibility()

    expect(c.state.hidden).toEqual([])
  })

  it('does nothing on an empty stack, the viewport included', () => {
    // There is no toast and no disabled button to say why: a page with nothing
    // to take back has nothing to say, and a state event dispatched for a
    // change that did not happen is a re-render nobody asked for.
    const c = opened({ hidden: ['/model/post'] })
    c.sync.mockClear()

    c.undoVisibility()

    expect(c.state.hidden).toEqual(['/model/post'])
    expect(c.sync, 'an undo with nothing to undo still told the viewport')
      .not.toHaveBeenCalled()
  })

  it('goes with the build when another one is opened', async () => {
    // Every entry holds leaf IDS of the build being left, and a rebuild is free
    // to renumber those paths onto other parts — the argument `leaveBuild`
    // already makes about the carry. Restoring one after the swap would not put
    // a step back, it would hide somebody else's part.
    const c = opened()
    c.captureHome = vi.fn()
    loadMeta.mockResolvedValue(build())

    row(c, '/model/plate').onVis(click)
    await c.switchBuild('proj1', B)
    c.onModel({ tree: TREE_B, view: 'assembled', live: true })

    const landed = c.state.hidden
    c.undoVisibility()

    expect(c.state.hidden, 'a step of the departed build was applied to this one')
      .toEqual(landed)
  })

  it('is ignored while the reader is typing, because the field has its own', () => {
    // The comment composer is a textarea and Ctrl+Z in it is the browser's undo
    // over the sentence being written — the same sentence this file's own test
    // about a half-written comment calls the most expensive thing to lose.
    //
    // `readNotes` runs on mount and this runner has no `localStorage`; store.js
    // catches that and says so, which is one line of noise per test.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = opened()
    c.load = vi.fn(async () => {})
    c.componentDidMount()
    onTestFinished(() => c.componentWillUnmount())

    row(c, '/model/plate').onVis(click)
    const box = document.createElement('textarea')
    document.body.appendChild(box)
    onTestFinished(() => box.remove())
    box.focus()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
    expect(c.state.hidden, 'the shortcut fired inside a text field')
      .toEqual(['/model/plate'])

    // And the same keystroke with the field let go, so what the test above
    // observes is the guard rather than a listener that was never wired up.
    box.blur()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
    expect(c.state.hidden).toEqual([])
  })

  it('drops the OLDEST step when it overflows, never the newest', () => {
    // `UNDO_DEPTH`'s comment says which end goes, and `shift()` against `pop()`
    // is one word apart: getting it backwards would silently throw away the one
    // step the reader is about to take back, which is the entire feature, while
    // leaving a stack of fifty that all look fine. So the sentence is held here.
    const c = opened()
    // One more gesture than the cap, each landing on a state of its own, so the
    // entry that falls off the bottom is identifiable by what it is NOT.
    for (let i = 0; i <= UNDO_DEPTH; i += 1) {
      c.setVisibility({ hidden: [`/model/p${i}`] })
    }
    expect(c.history).toHaveLength(UNDO_DEPTH)

    // The newest step is still there: one press goes back to where the last
    // gesture found the page, not to somewhere fifty gestures ago.
    c.undoVisibility()
    expect(c.state.hidden, 'the overflow ate the step about to be taken back')
      .toEqual([`/model/p${UNDO_DEPTH - 1}`])

    // And walking the rest of the stack out stops at the first gesture's own
    // state rather than at the empty list the page started on — that empty one
    // IS the entry that was dropped.
    for (let i = 0; i < UNDO_DEPTH; i += 1) c.undoVisibility()
    expect(c.history).toHaveLength(0)
    expect(c.state.hidden).toEqual(['/model/p0'])
  })

  it('fires on a Cyrillic layout, where that key does not say "z"', () => {
    // The reader presses a PHYSICAL key, and `holdkey.js` paid for this finding
    // in full over the hold key: with a Russian layout up the Z key reports
    // `key: "я"`. Matched on `key`, the chord is then a shortcut this page's own
    // author does not have — and it fails silently, with nothing on screen to
    // say why the step was not taken. Hence `code`, and hence this test: the
    // fallback path (no `code` at all) is what every other test in this block
    // exercises, so only this one holds the rule up.
    //
    // `readNotes` runs on mount and this runner has no `localStorage`; store.js
    // catches that and says so, which is one line of noise per test.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = opened()
    c.load = vi.fn(async () => {})
    c.componentDidMount()
    onTestFinished(() => c.componentWillUnmount())

    row(c, '/model/plate').onVis(click)
    expect(c.state.hidden).toEqual(['/model/plate'])

    window.dispatchEvent(new KeyboardEvent(
      'keydown', { key: 'я', code: 'KeyZ', ctrlKey: true }))

    expect(c.state.hidden, 'the undo chord missed the physical Z key')
      .toEqual([])
  })
})

describe('the section plane', () => {
  const cut = (over) => component({
    secOn: true, secOff: 5, secRange: [-30, 30], secFace: 'top', secFlip: true,
    ...over,
  })

  it('survives where it still means something', async () => {
    const c = cut()
    loadMeta.mockResolvedValue(build())

    await c.switchBuild('proj1', B)

    expect(c.state.secOn).toBe(true)
    expect(c.state.secOff).toBe(5)
    expect(c.state.secFace).toBe('top')
    expect(c.sync).toHaveBeenCalledWith(null)
  })

  it('is put away when the offset is outside the extent it was measured in',
    async () => {
      // A plane is a number in model space and the model may have moved under
      // it. Left standing, a cut at 50 mm on a part that is now 20 mm deep
      // slices through empty air.
      const c = cut({ secOff: 50 })
      loadMeta.mockResolvedValue(build())

      await c.switchBuild('proj1', B)

      expect(c.state.secOn).toBe(false)
      expect(c.state.secOff).toBe(0)
      expect(c.state.secFace).toBeNull()
      expect(c.state.secRange).toBeNull()
      // And the viewport is told, because the plane is its own state as well.
      expect(c.sync).toHaveBeenCalledWith({ __resetCut: true })
    })

  it('is put away when the view falls back to another one', async () => {
    // A different view is a different arrangement of the same parts, so the
    // depth was taken from a face that is not where it was.
    const c = cut({ view: 'printables' })
    loadMeta.mockResolvedValue(build([VIEWS[0]]))

    await c.switchBuild('proj1', B)

    expect(c.state.secOn).toBe(false)
    expect(c.sync).toHaveBeenCalledWith({ __resetCut: true })
  })
})

describe('what does not survive', () => {
  it('drops the selection, the menu and every popover', async () => {
    // Momentary things, and a selection pointing at a part that may not be in
    // this build at all is worse than none.
    const c = component({
      sel: '/model/plate', selName: 'plate',
      menu: { id: '/model/plate', x: 10, y: 20 },
      revOpen: true, dlOpen: true, viewsOpen: true, secPop: true,
      tokenPop: true, tokenDraft: 'x',
      notePop: 'plate', noteDraft: 'half a note',
      measure: { text: '3.00 mm', note: '', full: '3.00 mm' },
      moved: { id: '/model/plate', name: 'plate', mag: 2 },
    })
    loadMeta.mockResolvedValue(build())

    await c.switchBuild('proj1', B)

    expect(c.state.sel).toBeNull()
    expect(c.state.selName).toBe('')
    expect(c.state.menu).toBeNull()
    expect(c.state.revOpen).toBe(false)
    expect(c.state.dlOpen).toBe(false)
    expect(c.state.viewsOpen).toBe(false)
    expect(c.state.secPop).toBe(false)
    expect(c.state.tokenPop).toBe(false)
    expect(c.state.notePop).toBeNull()
    expect(c.state.noteDraft).toBe('')
    expect(c.state.measure).toBeNull()
  })

  it('takes the poll\'s offer down with the slot it belonged to', async () => {
    // The banner names a build that arrived under the pointer this page is
    // leaving. On a pinned revision there is nothing for it to offer at all.
    const c = component({ pending: { commit: 'ccc', parts: PARTS, views: VIEWS }, bannerGone: false })
    loadMeta.mockResolvedValue(build())

    await c.switchBuild('proj1', B)

    expect(c.state.pending).toBeNull()
  })

  it('leaves a half-written comment alone', async () => {
    // The one deliberate exception, and the same reason Escape spares it: typed
    // text is the most expensive thing on this page to lose, and the comment
    // lands on the revision now on screen — the one the reader is looking at
    // while they finish the sentence.
    const c = component({ composer: { part: 'plate', text: 'this hole is', p: null } })
    loadMeta.mockResolvedValue(build())

    await c.switchBuild('proj1', B)

    expect(c.state.composer.text).toBe('this hole is')
  })

  it('takes that comment\'s ANCHOR away, the part\'s name included', async () => {
    // The half the exception above does not cover. `sendComment` posts to
    // `meta.commit`, so a draft carried across whole files the previous build's
    // solid path, the previous build's 3D point, a measurement taken on geometry
    // that is gone and a drag of a part the rebuild has already put back — every
    // one of them as a fact about the build now on screen, and the two numbers
    // among them reach an agent as a task.
    //
    // THE NAME GOES TOO, though a name is the one thing a rebuild does not
    // renumber. It is what `composerPart` renders while `sendComment` sends
    // `partId`, so keeping it shows the reader an attachment the posted comment
    // will not carry — a mismatch with nothing on screen to reveal it.
    //
    // AND SO DOES `key`, which is the same argument read backwards and the one
    // worth a line of its own: the catalogue key is the field DESIGNED to
    // outlive a rebuild, so of everything here it is the one a reader of the
    // code expects to stay. It cannot. Nothing on screen shows a key — the
    // composer draws `part` — so a draft that kept it would look unattached and
    // post anchored to a part the reader never picked on this build.
    const c = component({
      composer: {
        part: 'plate', partId: '/model/plate', key: 'plate', p: [1, 2, 3],
        text: 'this hole is', photo: null,
        meas: '3.00 mm',
      },
    })
    loadMeta.mockResolvedValue(build())

    await c.switchBuild('proj1', B)

    expect(c.state.composer.text).toBe('this hole is')
    expect(c.state.composer.part).toBe('')
    expect(c.state.composer.partId).toBeNull()
    expect(c.state.composer.key).toBeNull()
    expect(c.state.composer.p).toBeNull()
    expect(c.state.composer.meas).toBeNull()
  })

  it('shows no part on the draft afterwards, with the text still in it', async () => {
    // The state above as the reader meets it: `composerPart` is what the header
    // of the composer renders, so this is the assertion that the draft on screen
    // has stopped claiming an attachment while the sentence is still there to
    // finish.
    const c = component({
      composer: {
        part: 'plate', partId: '/model/plate', p: [1, 2, 3],
        text: 'this hole is', photo: null, meas: null, move: null,
      },
    })
    loadMeta.mockResolvedValue(build())

    await c.switchBuild('proj1', B)

    const v = c.computed()
    expect(v.composerPart).toBe('')
    expect(v.composerText).toBe('this hole is')
  })

  it('keeps the project\'s queue and drops only the pin that was open', async () => {
    // THE QUEUE IS THE PROJECT'S and not this build's (SPEC 7A.3): the same
    // items are open on the revision being opened, so it is not refetched and
    // not cleared. What does belong to the build that left is the pin the reader
    // had OPENED — it named a comment drawn over geometry that is going.
    const queue = [{ id: 'c1', commit: A, view: 'assembled', part: '/model/plate',
                     key: 'plate', point: [1, 2, 3], text: 'too thin',
                     status: 'open', created: '2026-08-27T18:30:00Z' }]
    const c = component({ feed: queue, activePin: 'c1' })
    loadMeta.mockResolvedValue(build())

    await c.switchBuild('proj1', B)

    expect(c.state.feed).toEqual(queue)
    expect(c.state.activePin).toBeNull()
  })

  it('sends the viewport no pin at the coordinate the build it left recorded', async () => {
    // A STORED POINT IS ONLY TRUE ON THE BUILD IT WAS TAKEN ON, and that is what
    // survives of the old claim here: `anchorFor` reads the coordinate when the
    // record's commit AND view are the ones on screen, and after a swap neither
    // is, so the numbers are not handed to the new geometry — which need not
    // contain that point at all. Where the comment goes instead is wherever its
    // catalogue key is drawn, a place only `partPoint` can answer; there is no
    // viewport in this fixture (`host.current` is null), so nothing answers and
    // no pin is sent. The draft's own pin goes the other way, through the
    // composer's anchor.
    const c = component({
      feed: [{ id: 'c1', commit: A, view: 'assembled', part: '/model/plate',
               key: 'plate', point: [1, 2, 3], status: 'open',
               created: '2026-08-27T18:30:00Z' }],
      activePin: 'c1',
      composer: { part: 'plate', partId: '/model/plate', p: [4, 5, 6], text: 'x' },
    })
    delete c.sync
    loadMeta.mockResolvedValue(build())
    const seen = []
    const listen = (event) => seen.push(event.detail)
    window.addEventListener(STATE, listen)
    onTestFinished(() => window.removeEventListener(STATE, listen))

    await c.switchBuild('proj1', B)

    expect(seen).toHaveLength(1)
    expect(seen[0].pins).toEqual([])
  })
})

// -- the OTHER door into another build ----------------------------------------
//
// Switch on the "new build" banner. It is a revision switch by every fact that
// matters — another commit, built from other sources, with a bounding box of its
// own and parts the previous build need not have had — and the list above used
// to be written out in `switchBuild` and nowhere else, so none of it happened
// here. `leaveBuild` is now the one list and both doors call it; these are the
// same claims asked of the second door, and each one was a live defect until the
// method existed.
//
// The offer is a build with the SAME views the fixture is on, so the view id
// survives and the section is asked the question it is meant to be asked. The
// viewport is absent (`host.current` is null), which `takePending` reads as "not
// busy" — the deferring is interface.test.js's subject, not this one's.

describe('taking the banner\'s build', () => {
  /** The page with an offer standing, on a build with a section laid on it. */
  const offered = (over) => component({
    pending: { commit: 'ccc', built: '2026-08-29T10:00:00Z', parts: PARTS, views: VIEWS },
    ...over,
  })

  it('sends the viewport no pin at the coordinate the banner\'s build replaced', () => {
    // THE TWIN of the swap's own claim above, and the reason it had to be
    // written twice: the stored coordinate was measured on the build the banner
    // is replacing, and the one it offers need not contain that point at all.
    // Without it the old pins were drawn on geometry that never carried them —
    // invisible as a defect, because a pin looks like a pin wherever it lands.
    const queue = [{ id: 'c1', commit: A, view: 'assembled', part: '/model/plate',
                     key: 'plate', point: [1, 2, 3], status: 'open',
                     created: '2026-08-27T18:30:00Z' }]
    const c = offered({
      feed: queue,
      activePin: 'c1',
      composer: { part: 'plate', partId: '/model/plate', p: [4, 5, 6], text: 'x' },
    })
    delete c.sync
    const seen = []
    const listen = (event) => seen.push(event.detail)
    window.addEventListener(STATE, listen)
    onTestFinished(() => window.removeEventListener(STATE, listen))

    c.takePending()

    expect(c.state.meta.commit, 'the offer was not taken at all').toBe('ccc')
    expect(seen).toHaveLength(1)
    expect(seen[0].pins).toEqual([])
    expect(c.state.feed, 'the queue is the project\'s and outlives the offer')
      .toEqual(queue)
    expect(c.state.activePin).toBeNull()
  })

  it('takes the draft\'s anchor away and leaves the sentence', () => {
    // The half that leaves the browser. `sendComment` posts to `meta.commit`,
    // which is the BANNER's the moment this lands, carrying `part`, `partId`,
    // the 3D point and the measurement — every one of them observed on the
    // build that has just gone, every one of them filed as a fact about the one
    // that replaced it, and the numbers among them reaching an agent as a task.
    const c = offered({
      composer: {
        part: 'plate', partId: '/model/plate', key: 'plate', p: [1, 2, 3],
        text: 'this hole is', photo: null, meas: '3.00 mm',
      },
    })

    c.takePending()

    expect(c.state.composer.text).toBe('this hole is')
    expect(c.state.composer.part).toBe('')
    expect(c.state.composer.partId).toBeNull()
    expect(c.state.composer.key).toBeNull()
    expect(c.state.composer.p).toBeNull()
    expect(c.state.composer.meas).toBeNull()
  })

  it('drops the selection, the menu and every popover', () => {
    // `sel` is a solid path of the build that left and goes to the viewport as
    // `selected` on the next frame; the rest are menus about a model that is no
    // longer under them.
    const c = offered({
      sel: '/model/plate', selName: 'plate',
      menu: { id: '/model/plate', x: 10, y: 20 },
      revOpen: true, dlOpen: true, viewsOpen: true, secPop: true,
      tokenPop: true, tokenDraft: 'x',
      notePop: 'plate', noteDraft: 'half a note',
      measure: { text: '3.00 mm', note: '', full: '3.00 mm' },
      moved: { id: '/model/plate', name: 'plate', mag: 2 },
    })
    delete c.sync
    const seen = []
    const listen = (event) => seen.push(event.detail)
    window.addEventListener(STATE, listen)
    onTestFinished(() => window.removeEventListener(STATE, listen))

    c.takePending()

    expect(c.state.sel).toBeNull()
    expect(c.state.selName).toBe('')
    expect(c.state.menu).toBeNull()
    expect(c.state.revOpen).toBe(false)
    expect(c.state.dlOpen).toBe(false)
    expect(c.state.viewsOpen).toBe(false)
    expect(c.state.secPop).toBe(false)
    expect(c.state.tokenPop).toBe(false)
    expect(c.state.notePop).toBeNull()
    expect(c.state.noteDraft).toBe('')
    expect(c.state.measure).toBeNull()
    // And the viewport is told, since a selection is its state too. An EMPTY
    // LIST and not a null: a selection is the paths of a row since issue #75,
    // because a row may stand for several copies of one part.
    expect(seen[0].selected).toEqual([])
  })

  it('puts the section plane away when the model may have moved under it', () => {
    // `sectionAcross` was never asked on this path, and its own argument — "the
    // model could have moved under it" — is about a rebuild, which is exactly
    // what the banner is offering. A cut at 50 mm on a part that is now 20 mm
    // deep slices through empty air.
    const c = offered({ secOn: true, secOff: 50, secRange: [-30, 30],
                        secFace: 'top', secFlip: true })

    c.takePending()

    expect(c.state.secOn).toBe(false)
    expect(c.state.secOff).toBe(0)
    expect(c.state.secFace).toBeNull()
    expect(c.state.secRange).toBeNull()
    // The viewport holds a cut of its own, so the patch alone would leave the
    // plane standing in the scene with the slider back at zero.
    expect(c.sync).toHaveBeenCalledWith({ __resetCut: true })
  })

  it('leaves it standing where it still means something', () => {
    // The control on the line above: the same view id and an offset still inside
    // the extent the slider was given is the strongest question that can be
    // asked from this side, and it answers "keep".
    const c = offered({ secOn: true, secOff: 5, secRange: [-30, 30], secFace: 'top' })

    c.takePending()

    expect(c.state.secOn).toBe(true)
    expect(c.state.secOff).toBe(5)
    expect(c.sync).toHaveBeenCalledWith(null)
  })

  it('leaves a download chain running, because no href moved', () => {
    // THE ONE THING THE SWAP DOES THAT THIS DOES NOT, and the boundary is the
    // claim: `leaveBuild` carries what goes with the BUILD, while a download
    // chain goes with the ADDRESS — `fileHref` is `PAGE.base` plus a name, and
    // `PAGE.base` does not move here. So every href still to come resolves to
    // the pointer the reader pressed the button on, which is what they asked
    // for.
    //
    // Cutting it here was tried and is the worse failure: "Download all" on ten
    // STLs takes two seconds, so a Switch pressed a moment later left the reader
    // three files of ten with nothing on the screen saying so — off to print an
    // incomplete set. The mixing this was meant to prevent does not need Switch
    // at all: the pointer starts serving the new build WHEN THE HUB PUBLISHES
    // IT, which is before the poll notices and before the banner is even up.
    // Later, on the same banner, cancels nothing and never did.
    const clicked = []
    const timers = []
    const c = offered()

    c.downloadAll([`${path(A)}plate.stl`, `${path(A)}post.stl`],
                  { click: (href) => clicked.push(href),
                    schedule: (fn, ms) => { timers.push({ fn, ms }) } })
    expect(clicked).toHaveLength(1)

    c.takePending()
    timers.shift().fn()

    expect(clicked, 'the chain was cut off by a gesture that changed no href')
      .toEqual([`${path(A)}plate.stl`, `${path(A)}post.stl`])
  })

  it('re-resolves the hidden and translucent parts by NAME, as the picker does',
    () => {
      // THE TWIN of the swap's own claim, and it was missing for exactly as long
      // as the list was written out in `switchBuild` alone: this door set no
      // carry, `rejoin` answered null, and the ids of the build that left were
      // handed straight to the build that replaced it. Ids are solid paths and a
      // rebuild renumbers them freely — `plate` is `/model/plate` here and
      // `/model/0` in the next build — so the part the reader hid came back on
      // screen, or, where the old path had been renumbered onto somebody else,
      // a part they never touched vanished instead. The toast over all of that
      // read "your frame and tree are kept".
      const c = offered({ hidden: ['/model/plate'], ghost: ['/model/post'] })
      c.captureHome = vi.fn()

      c.takePending()
      c.onModel({ tree: TREE_B, view: 'assembled', live: true })

      expect(c.state.hidden, 'the hidden part was named by an id of the build that left')
        .toEqual(['/model/0'])
      // `post` is not in the new build at all, and a part that is gone cannot
      // stay hidden.
      expect(c.state.ghost).toEqual([])
    })
})

// -- the banner's own Switch, still waiting, when a revision is picked --------

describe('a deferred take of the banner\'s build', () => {
  it('is cancelled by picking a revision, before it can land inside the swap', async () => {
    // THE SEQUENCE, and the reason the cancel is before the fetch rather than
    // after it: Switch on the banner defers while the reader's hand is on the
    // model and retries every 250 ms for five seconds, which is shorter than a
    // network round trip. A reader who pressed Switch, saw nothing happen and
    // picked a revision instead used to get the deferred take landing INSIDE
    // this await — `meta` replaced by the banner's build, its geometry fetched,
    // "Now viewing ccc" toasted — and then the revision they actually asked for
    // arriving on top of it. One wasted load, and a toast naming a build that is
    // not on the screen.
    vi.useFakeTimers()
    onTestFinished(() => vi.useRealTimers())
    const c = component({ pending: { commit: 'ccc', parts: PARTS, views: VIEWS } })
    c.el = () => ({ isBusy: () => true })

    c.takePending()
    expect(vi.getTimerCount(), 'nothing was deferred, so nothing is under test').toBe(1)

    // The swap goes to the network and stays there.
    let answer = null
    loadMeta.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    const swapping = c.switchBuild('proj1', B)

    // The hand comes off the model, so a timer still armed would fire and take
    // the offer.
    c.el = () => null
    vi.advanceTimersByTime(60000)
    expect(c.state.meta.commit, 'the deferred take landed in the middle of the swap')
      .toBe(A)

    answer(build())
    await swapping
    expect(c.state.meta.commit).toBe(B)
  })

  it('leaves the offer itself standing, so a swap that fails loses nothing', async () => {
    // Only the WAIT is cancelled. The banner and its Switch are still there, and
    // a revision that 404s puts nothing away — the reader's second thought about
    // the offer is still available to them.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    onTestFinished(() => vi.useRealTimers())
    const offer = { commit: 'ccc', parts: PARTS, views: VIEWS }
    const c = component({ pending: offer })
    c.el = () => ({ isBusy: () => true })
    c.takePending()
    loadMeta.mockRejectedValue(new Error('meta.json -> HTTP 404'))

    await c.switchBuild('proj1', B)

    expect(vi.getTimerCount(), 'the wait outlived the gesture that replaced it').toBe(0)
    expect(c.state.pending).toBe(offer)
  })

  it('takes a toast about the build that left down with it', async () => {
    // A toast stands for 2.6 s and says what the page was doing for the build it
    // was raised on. Left alone it sits over the build that replaced it saying
    // something that has stopped being true — and its timer, which nothing else
    // would ever clear, fires into the new page to take it away.
    vi.useFakeTimers()
    onTestFinished(() => vi.useRealTimers())
    const c = component()
    // The real one, because what is under test is the timer it arms.
    delete c.toast
    loadMeta.mockResolvedValue(build())

    c.toast('copied: plate')
    expect(c.state.toast).toBe('copied: plate')
    expect(vi.getTimerCount()).toBe(1)

    await c.switchBuild('proj1', B)

    expect(c.state.toast).toBeNull()
    expect(vi.getTimerCount(), 'the toast\'s own timer outlived the build').toBe(0)
  })
})

// -- and the banner's Switch pressed OUTRIGHT while that revision is fetching --
//
// The deferred take above needs a busy viewport to exist at all. A direct press
// needs nothing, lands in the same window, and used to run the whole of
// `takePending` — which is why closing the picker was never enough: the banner
// is not in the picker.

describe('the banner\'s Switch while a picked revision is on the wire', () => {
  /** A swap held at the fetch, and the resolver that lets it finish. */
  function inFlight(c) {
    let answer = null
    loadMeta.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    return { swapping: c.switchBuild('proj1', B), answer }
  }

  it('does not run, however directly it is pressed', async () => {
    // THROUGH THE HANDLER THE PAGE ACTUALLY RENDERS, not through `takePending`:
    // what is under test is that the button on the screen is inert, and a test
    // that called the method would pass on a page whose Switch still worked.
    //
    // Without the refusal this press swaps `meta` to the banner's build, tells
    // the viewport to fetch its geometry and toasts "Now viewing ccc" — and then
    // the revision the reader picked lands on top of it. One wasted load of a
    // model nobody chose, and a toast naming a build that is not there.
    const c = component({ pending: { commit: 'ccc', parts: PARTS, views: VIEWS } })
    // Not busy, so nothing defers: a press either runs now or is refused.
    c.el = () => null
    const swap = inFlight(c)

    c.computed().bannerSwitch()

    expect(c.state.meta.commit, 'the banner\'s build landed in the middle of the swap')
      .toBe(A)
    expect(c.toast).not.toHaveBeenCalled()

    swap.answer(build())
    await swap.swapping
    expect(c.state.meta.commit).toBe(B)
  })

  it('says so, instead of looking exactly as clickable as it did', () => {
    // A button that ignores the click while still looking like a button is the
    // failure the refusal was added to prevent, wearing the refusal's clothes:
    // the reader presses it, nothing happens, and there is nothing on the screen
    // to read that off.
    const c = component({ pending: { commit: 'ccc', parts: PARTS, views: VIEWS } })
    const live = c.computed().bannerSwitchStyle

    c.setState({ swapping: true })
    const spent = c.computed().bannerSwitchStyle

    expect(live).toContain('cursor:pointer')
    expect(spent, 'the cursor still promises a click').not.toContain('cursor:pointer')
    expect(spent, 'and it is still painted the colour of a live button')
      .not.toContain('background:var(--accent)')
  })

  it('is a live button again once that swap has failed', async () => {
    // THE HALF THAT MUST NOT BE PAID FOR BY THE OTHER. Nothing about the offer
    // was answered — it was postponed by a few hundred milliseconds of network —
    // so a revision that 404s must leave the reader able to take it after all.
    // Emptying `pending` would have been the cheap way to make the button inert
    // and would have thrown the offer away with it.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const offer = { commit: 'ccc', built: '2026-08-29T10:00:00Z',
                    parts: PARTS, views: VIEWS }
    const c = component({ pending: offer })
    c.el = () => null
    loadMeta.mockRejectedValue(new Error('meta.json -> HTTP 404'))

    await c.switchBuild('proj1', B)

    expect(c.state.pending, 'the offer went down with the swap that failed').toBe(offer)
    expect(c.state.swapping, 'Switch is still out of service after the fetch ended')
      .toBe(false)
    expect(c.computed().bannerSwitchStyle).toContain('cursor:pointer')

    c.computed().bannerSwitch()

    expect(c.state.meta.commit, 'the second press was refused too').toBe('ccc')
  })
})

// -- a swap whose view never renders ------------------------------------------

describe('a swap the viewport would not render', () => {
  it('clears the tree, which is still the build that left', async () => {
    // The page is half moved and nothing about it looks wrong: `meta`, the
    // title, the picker and `PAGE.base` are the new build's, while the panel on
    // the left lists the parts of the old one under real part names. What is
    // actually broken is invisible — `authorNote` looks their catalogue keys up
    // in the NEW build's `meta.parts`, and every row's menu builds its download
    // links on the NEW base.
    const c = component()
    loadMeta.mockResolvedValue(build())
    expect(c.state.tree).not.toBeNull()

    await c.switchBuild('proj1', B)
    c.onViewError({ message: 'a.json -> HTTP 503' })

    expect(c.state.viewError).toContain('503')
    expect(c.state.tree).toBeNull()
  })

  it('leaves the tree alone when no swap was landing', async () => {
    // The ordinary failure: a view that would not render on the build already on
    // screen. The tree describes THAT build, so emptying the panel would be
    // throwing away something true.
    const c = component()

    c.onViewError({ message: 'p.json -> HTTP 503' })

    expect(c.state.viewError).toContain('503')
    expect(c.state.tree).not.toBeNull()
  })

  it('does not empty the panel on a swap that works', async () => {
    // The price of clearing the tree at the swap instead, which is why it is
    // done here: the panel would blink empty on every switch that lands, for the
    // sake of the rare one that does not.
    const c = component()
    loadMeta.mockResolvedValue(build())

    await c.switchBuild('proj1', B)

    expect(c.state.tree, 'the panel went empty on a swap that worked').not.toBeNull()
  })

  it('still re-homes Fit on a Retry that works', async () => {
    // `_refit` is what says "a swap is landing and its model has not arrived",
    // and it is read here rather than spent: the model event a successful Retry
    // produces is still the first of that swap, so the frame Fit goes back to
    // still has to be re-read on it.
    const c = component()
    c.captureHome = vi.fn()
    loadMeta.mockResolvedValue(build())

    await c.switchBuild('proj1', B)
    c.onViewError({ message: 'a.json -> HTTP 503' })
    c.retryView()
    c.onModel({ tree: TREE_B, view: 'assembled', live: true })

    expect(c.captureHome).toHaveBeenCalledTimes(1)
    expect(c.state.tree).not.toBeNull()
    expect(c.state.viewError).toBeNull()
  })
})

// -- what was already in flight when the swap landed --------------------------

describe('a poll waiting on its answer', () => {
  /**
   * A poll and a swap, each answered separately.
   *
   * They share one `loadMeta`, and telling them apart by the base they ask for is
   * the point rather than a convenience: the poll builds its URL out of `PAGE`
   * BEFORE the swap moves it, which is exactly how the two come to disagree.
   */
  function inFlight(c) {
    let answer = null
    loadMeta.mockImplementation((fresh, base) => (
      base === path(A)
        ? new Promise((resolve) => { answer = resolve })
        : Promise.resolve(build())))
    const polling = c.poll()
    return { polling, answer: (meta) => answer(meta) }
  }

  /** A third build, as `latest` would have picked it up mid-flight. */
  const C = 'c'.repeat(64)

  it('does not offer what it found once the page has moved on', async () => {
    // The banner is the visible symptom and a pinned revision is where it is
    // worst: `switchBuild` clears `pending` precisely because a pinned build has
    // nothing to offer, and an answer landing a moment later put it straight back
    // up. (The poll is started by hand because this fixture sits on a revision
    // and nothing arms one there — which is the sequence itself: armed under
    // `latest`, answered after the reader pinned a revision.)
    const c = component()
    const poll = inFlight(c)

    await c.switchBuild('proj1', B)
    c.schedulePoll.mockClear()
    poll.answer({ ...build(), commit: C })
    await poll.polling

    expect(c.state.pending, 'the answer about the slot we left was offered anyway')
      .toBeNull()
    expect(c.state.meta.commit).toBe(B)
    // Nor does it re-arm: the swap already armed the poll for the slot it moved
    // to, and a second timer from the poll it superseded is one more fetch than
    // this page asked for.
    expect(c.schedulePoll).not.toHaveBeenCalled()
  })

  it('still offers it when no swap happened while it waited', async () => {
    // The other side of the same guard: the generation only bites on a swap, so
    // an ordinary poll goes on doing exactly what it always did.
    const c = component()
    const poll = inFlight(c)

    poll.answer({ ...build(), commit: C })
    await poll.polling

    expect(c.state.pending.commit).toBe(C)
    expect(c.schedulePoll).toHaveBeenCalled()
  })
})

describe('a download chain still handing over files', () => {
  it('is called off, so the rest of the old build is not downloaded', async () => {
    // The hrefs were built out of `PAGE.base` when the button was pressed, and
    // the chain outlives that gesture by a fifth of a second per file — six
    // seconds on a thirty-file build. Without this, a reader who switched
    // revision goes on receiving files of the build they left, silently, because
    // nothing on the screen says which build a download came from.
    const clicked = []
    const timers = []
    const c = component()
    loadMeta.mockResolvedValue(build())

    // The fake clock hands back NOTHING, deliberately: a handle that happened to
    // be a small integer would be passed to `clearTimeout` on the cancel below,
    // and jsdom's own timer ids are small integers too.
    c.downloadAll([`${path(A)}plate.stl`, `${path(A)}post.stl`],
                  { click: (href) => clicked.push(href),
                    schedule: (fn, ms) => { timers.push({ fn, ms }) } })
    expect(clicked).toHaveLength(1)

    await c.switchBuild('proj1', B)
    timers.shift().fn()

    expect(clicked, 'the rest of the chain downloaded the build that had left')
      .toEqual([`${path(A)}plate.stl`])
  })
})

// -- what the new revision brings with it -------------------------------------

describe('the author\'s note on a part', () => {
  // It rides INSIDE the build's catalogue record for the part — `note` in
  // `meta.parts[key]`, written in model.py and published with the build — so a
  // swap that replaces `meta` replaces the notes with it. THAT IS ASSERTED
  // RATHER THAN ASSUMED: a stale note is the worst thing this box can show,
  // because it is a sentence about a part that is no longer the part on screen,
  // and nothing about it would look wrong. Everything else about the two notes
  // is in `notes.test.js`; this is the one claim that needs a real swap.
  //
  // THE PART IS PICKED AGAIN AFTERWARDS, because a swap drops the selection on
  // purpose (above) — which is also the reader's own gesture: they click the
  // part in the model that has just arrived.
  const on = (id, name) => ({ sel: id, selName: name })

  /** The fixture's catalogue with one note written into it. */
  const saying = (note) => ({ ...PARTS, plate: { ...PARTS.plate, note } })

  it('is the new revision\'s once the swap has landed', async () => {
    const c = component({ ...on('/model/plate', 'plate'),
                          meta: { project: 'fixture', commit: A, built: '',
                                  parts: saying('M3x8 DIN912'), views: VIEWS } })
    expect(c.computed().authorNote).toBe('M3x8 DIN912')

    loadMeta.mockResolvedValue({ ...build(), parts: saying('M4x10, was M3') })
    await c.switchBuild('proj1', B)
    c.onModel({ tree: TREE_B, view: 'assembled', live: true })
    c.setState(on('/model/0', 'plate'))

    expect(c.computed().authorNote).toBe('M4x10, was M3')
  })

  it('is gone when the revision switched TO carries none', async () => {
    // The direction that fails silently: most parts carry no note, and one left
    // over from the previous revision would be attributed to a model that never
    // said it.
    const c = component({ ...on('/model/plate', 'plate'),
                          meta: { project: 'fixture', commit: A, built: '',
                                  parts: saying('M3x8 DIN912'), views: VIEWS } })

    loadMeta.mockResolvedValue(build())
    await c.switchBuild('proj1', B)
    c.onModel({ tree: TREE_B, view: 'assembled', live: true })
    c.setState(on('/model/0', 'plate'))

    expect(c.state.meta.parts.plate.note).toBeUndefined()
    expect(c.computed().authorNote).toBe('')
  })
})

// -- when it does not work ----------------------------------------------------

describe('a target that will not load', () => {
  it('leaves the previous revision on screen and says so', async () => {
    // NOTHING IS MOVED UNTIL THE TARGET HAS ANSWERED, which is the whole reason
    // meta.json is fetched against a base of its own: the address, `PAGE` and
    // the model all stay where they were, and the reader is told in the panel
    // this page already has for "what you asked for is not what is on screen".
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = component()
    const push = vi.spyOn(history, 'pushState')
    loadMeta.mockRejectedValue(new Error('meta.json -> HTTP 404'))

    await c.switchBuild('proj1', B)

    expect(push).not.toHaveBeenCalled()
    expect(PAGE.slot).toBe(A)
    expect(PAGE.base).toBe(path(A))
    expect(c.state.meta.commit).toBe(A)
    expect(c.state.viewError).toContain(B.slice(0, 7))
    expect(c.state.revOpen).toBe(false)
  })

  it('refuses a build that lists no views at all', async () => {
    // A meta.json that parsed and carries nothing to render. Same answer: the
    // swap would put a frame around a hole.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = component()
    loadMeta.mockResolvedValue(build([]))

    await c.switchBuild('proj1', B)

    expect(PAGE.slot).toBe(A)
    expect(c.state.viewError).toBeTruthy()
  })
})

describe('another project', () => {
  it('is still a real navigation', async () => {
    // Everything changes there at once — the title, the picker, the notes, the
    // queue, every download — which is a new page by any honest reading. This
    // page's own picker only ever lists one project, so this is a guard for the
    // day something else calls it rather than a path anybody takes.
    const c = component()
    const went = watchNavigation()
    const push = vi.spyOn(history, 'pushState')

    await c.switchBuild('other', 'latest')

    expect(went).toEqual(['/project/other/'])
    expect(loadMeta).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    expect(PAGE.pid).toBe('proj1')
  })
})

// -- the shape of `leaveBuild`'s answer, held against its callers -------------
//
// `leaveBuild` returns TWO halves — `state` for this side, `extra` for the
// viewport, which holds a section plane of its own — and its own docstring names
// what a caller that spread the first and dropped the second would leave behind:
// the plane standing in the scene with the slider back at zero. Both callers do
// it right today and both are tested doing it. THE THIRD ONE IS THE PROBLEM.
// Nothing about the method makes half of the answer hard to drop, and the only
// thing standing between that and production is a paragraph, which the next
// person writing a third door is not obliged to read.
//
// SO THE CALLERS ARE READ OUT OF THE SOURCE rather than listed here — a list
// would go stale the same way, silently, and the check would pass by knowing
// about fewer doors than exist. The genre is not new in this repository:
// tests/test_workflow_steps.py hashes the bodies of workflow steps that must
// stay identical, for the same reason.
//
// THE OTHER WAY OUT WAS TO CHANGE THE SHAPE — have `leaveBuild` call `sync`
// itself, or return one object the caller cannot half-spread — and it is
// deliberately not taken. The two-half return has been through review twice, the
// callers need the state merged with fields of their own BEFORE it reaches
// `setState`, and moving code that works is a worse trade than checking it.

// From `process.cwd()` and not from `import.meta.url`: this file runs under
// jsdom, where the module URL is an http one and `fileURLToPath` refuses it —
// the same note hatch.test.js carries. Vitest's cwd is its config root, `ui/`.
const SOURCE = readFileSync(resolve(process.cwd(), 'src/HammerolaViewer.jsx'), 'utf8')

/**
 * The same source with its comments taken out, and nothing else moved.
 *
 * THE GUARD BELOW CANNOT READ RAW TEXT, because this file's prose quotes the
 * very code it is about: `leaveBuild`'s own docstring spells out `...gone.state`
 * and `sync(gone.extra)` as the two halves a caller must keep. A `toContain`
 * over raw text therefore passed for a door that only TALKED about keeping them
 * — as long as the talking sat after the call, inside the slice — and went red
 * for a door that did everything right but explained itself above the call
 * instead. Both answers were about where the prose was.
 *
 * The three quote characters are tracked, so a `//` inside a string is not a
 * comment. Regex literals are NOT, and do not have to be: a `/` is read as a
 * comment only when the next character is `/` or `*`, and this file has no
 * regex containing either (no escaped slash anywhere in it). Newlines survive,
 * so offsets still land on the line they came from.
 */
function stripComments(js) {
  let out = ''
  let quote = null
  for (let i = 0; i < js.length; i += 1) {
    const c = js[i]
    if (quote) {
      out += c
      if (c === '\\') { out += js[i + 1] || ''; i += 1 } else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; continue }
    if (c === '/' && js[i + 1] === '/') {
      while (i < js.length && js[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (c === '/' && js[i + 1] === '*') {
      const end = js.indexOf('*/', i + 2)
      const block = js.slice(i, end === -1 ? js.length : end + 2)
      out += block.replace(/[^\n]/g, '')
      i += block.length - 1
      continue
    }
    out += c
  }
  return out
}

/**
 * The source of one method, from `at` to the line that closes it, or null.
 *
 * Methods of this class close on a `}` indented by two spaces, and nothing
 * inside one is indented that shallowly — the nested blocks close at four and
 * six. That is a CONVENTION of this file rather than a fact about JavaScript,
 * so both ways it can be wrong answer for themselves instead of being assumed:
 * a closing line that is not found comes back null rather than quietly handing
 * back the whole rest of the file, and a slice that ran PAST the method is
 * caught by the thing it would then have to contain — the signature of the next
 * one, which is the only other place this file indents a name by two spaces.
 */
function methodFrom(code, at) {
  const end = code.indexOf('\n  }\n', at)
  if (end === -1) return null
  const body = code.slice(at, end)
  return /^ {2}[A-Za-z_$][\w$]*\s*\(/m.test(body) ? null : body
}

/**
 * Every door in `source`, and one complaint per thing wrong with one.
 *
 * A FUNCTION OVER A STRING, not a check written against this one file, so that
 * the guard can be handed a door built to fail. A test that reads source is
 * worth what it can be shown to reject; until then it is a regex nobody has
 * seen go red.
 *
 * IT STRIPS ITS OWN INPUT rather than being handed stripped text: reading the
 * prose is the mistake this whole arrangement is here to make impossible, and a
 * call site free to pass the raw file is that mistake still available.
 */
function auditDoors(source) {
  const code = stripComments(source)
  const doors = []
  const bad = []
  const call = /this\.leaveBuild\(/g
  for (let m = call.exec(code); m; m = call.exec(code)) {
    // BACK OVER THE NEWLINE, not along the line only: `const gone =` breaks
    // onto its own line the moment the call is long enough, and a guard reading
    // one line called that door an answer thrown away — a red test for code
    // that was right, which is the kind that gets the check deleted.
    const before = code.slice(Math.max(0, m.index - 200), m.index)
    const named = /(?:const|let|var)\s+(\w+)\s*=\s*$/.exec(before)
    const where = `${before.slice(-60).replace(/\s+/g, ' ').trim()} this.leaveBuild(…)`
    doors.push({ at: m.index, held: named ? named[1] : null, where })
  }

  doors.forEach((door) => {
    // BOTH READINGS ARE NAMED, because the guard cannot tell them apart: the
    // answer really is dropped, or it is taken in a shape this regex does not
    // know (destructured, assigned to a field, passed straight on).
    if (!door.held) {
      bad.push(`leaveBuild's answer is not held in a plain variable — either it `
               + `is thrown away, or it is taken in a form this guard cannot `
               + `read: ${door.where}`)
      return
    }
    const body = methodFrom(code, door.at)
    if (body === null) {
      bad.push(`the method around ${door.where} does not end where this file's `
               + `indentation says it should, so nothing was checked`)
      return
    }
    if (!body.includes(`...${door.held}.state`)) {
      bad.push(`${door.held}.state never reaches setState: ${door.where}`)
    }
    // THE HALF THE DOCSTRING WARNS ABOUT. Without it the plane stays in the
    // scene while every control on this side says there is no cut.
    if (!body.includes(`sync(${door.held}.extra)`)) {
      bad.push(`${door.held}.extra never reaches the viewport: ${door.where}`)
    }
  })

  return { doors, bad }
}

describe('every door into another build', () => {
  it('is a call that keeps both halves of the answer', () => {
    const audit = auditDoors(SOURCE)

    // A regex that stopped matching is a check that vanished with the suite
    // still green — the failure `ci/smoke.py` counts its verdicts to avoid.
    expect(audit.doors.length, 'no call to leaveBuild was found at all')
      .toBeGreaterThan(1)
    expect(audit.bad).toEqual([])
  })

  // -- and the guard against itself -------------------------------------------

  it('is read out of the code and not out of the prose around it', () => {
    // The door this guard used to pass: it says every word the check looks for
    // and does none of it. The second method is the control — the same words,
    // actually executed — so a guard that simply always complained would fail
    // here too.
    const fake = [
      'class Fake {',
      '  onPick(slot) {',
      '    // Takes the answer whole: `const gone = this.leaveBuild(keep)`, then',
      '    // `...gone.state` into the setState below and `sync(gone.extra)` for',
      '    /* the viewport, exactly like the door underneath this one. */',
      '    this.leaveBuild(this.state.keep);',
      '    this.setState({ slot });',
      '  }',
      '',
      '  onPop(slot) {',
      '    const gone = this.leaveBuild(this.state.keep);',
      '    this.setState({ ...gone.state, slot }, () => this.sync(gone.extra));',
      '  }',
      '}',
      '',
    ].join('\n')
    const audit = auditDoors(fake)

    expect(audit.doors.length, 'a door quoted in a comment was counted as one').toBe(2)
    expect(audit.bad).toHaveLength(1)
    expect(audit.bad[0]).toMatch(/not held in a plain variable/)
  })

  it('reads an answer taken on the line above the call', () => {
    // The other way the old guard was wrong, and the more expensive one: it
    // looked left along ONE line, so a call long enough to wrap read as a door
    // throwing its answer away. A guard that goes red on correct code is worth
    // less than no guard, because it is the guard that gets deleted.
    const wrapped = [
      'class Fake {',
      '  onPick(slot) {',
      '    const gone =',
      '      this.leaveBuild(this.state.keepEverythingTheViewportIsHoldingNow);',
      '    this.setState({ ...gone.state, slot }, () => this.sync(gone.extra));',
      '  }',
      '}',
      '',
    ].join('\n')

    expect(auditDoors(wrapped).bad).toEqual([])
  })

  it('says so instead of checking nothing when a method does not end', () => {
    // `methodFrom` finds the end of a method by this file's indentation, which
    // is a convention and not a rule. When it does not hold, the answer has to
    // be a complaint: the old version sliced to the end of the file instead,
    // where every string it was looking for could be found in some other
    // method — a check that passes precisely because it lost its bearings.
    // No line closes at two spaces at all, so the end is not found.
    const runOn = [
      'class Fake {',
      '    onPick(slot) {',
      '        const gone = this.leaveBuild(1);',
      '    }',
      '}',
      '',
    ].join('\n')
    // And the worse one: an end IS found, but it belongs to a later method, so
    // the slice carries somebody else's body — where both strings the guard is
    // looking for happen to be. This is the shape that passes while checking
    // the wrong door, and the only sign of it is the signature it swallowed.
    const overshoot = [
      'class Fake {',
      '    onPick(slot) {',
      '        const gone = this.leaveBuild(1);',
      '    }',
      '',
      '  onPop(slot) {',
      '    const left = this.leaveBuild(1);',
      '    this.setState({ ...gone.state }, () => this.sync(gone.extra));',
      '  }',
      '}',
      '',
    ].join('\n')

    expect(auditDoors(runOn).bad[0]).toMatch(/does not end where/)
    expect(auditDoors(overshoot).bad[0]).toMatch(/does not end where/)
  })
})

// -- and every writer of `hidden` / `ghost` ----------------------------------
//
// The same genre for the same reason: `setVisibility` is what keeps a swap's
// snapshot in step with the reader, six controls call it, and nothing about
// `this.set` stops a seventh from writing those two lists directly. Only ONE of
// the six is reachable by a behaviour test in this file, so for the other five
// this guard is the whole of the coverage — which is why it reads the call
// rather than a shape of the line the call happens to be written on.

/** How far a bracket at `open` in `code` reaches, string-aware. */
function balanced(code, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const want = []
  let quote = null
  for (let i = open; i < code.length; i += 1) {
    const c = code[i]
    if (quote) {
      if (c === '\\') i += 1
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (pairs[c]) { want.push(pairs[c]); continue }
    if (c === want[want.length - 1]) {
      want.pop()
      if (!want.length) return i
    }
  }
  return -1
}

/**
 * The state fields one call to `set` / `setState` WRITES, out of its arguments.
 *
 * THREE POSITIONS AND NO OTHERS, because a patch can only reach `setState` in
 * three ways: it stands at the top of the argument list (`{ … }`, and either
 * arm of a `cond ? { … } : { … }` stands there too), it is what a functional
 * updater RETURNS (`return { … }`, at whatever block depth inside the body —
 * which covers a `function` updater as well, since nothing here reads how the
 * function was spelled), or it is what a concise body evaluates to (`=> ({ … })`
 * and equally `=> (cond ? { … } : null)`, since the frame is what is labelled
 * and not the two characters before the brace). Every other `{` in the
 * arguments is somebody else's object and is skipped whole.
 * The one at the top that is NOT a patch is a body opening there — the
 * completion callback's `() => {` — and it is excluded by what precedes it.
 *
 * COUNTING NESTING DEPTH INSTEAD IS WHAT THIS REPLACES, and it was wrong in
 * both directions at once. A `{` was an object unless it followed `=>`, so
 * `if (…) {` inside a callback counted as a level and pushed a real
 * `return { hidden: [] }` below the one depth being read — the write went
 * unseen. Widening the block rule to fix that then broke the other way, on this
 * file's own code: `setVisibility` rebuilds the carry as `… ? { hidden, ghost }
 * : null` inside an `if` inside a callback, and every wider rule reads that as
 * a write and goes red on correct code. Naming the three positions has no such
 * knob: the ternary is in none of them, the return is in one.
 *
 * THE KEY IS READ TO ITS TERMINATOR — `:` for a plain key, `,` or `}` for the
 * shorthand `{ hidden }`, which the colon-only regex before this let through
 * even though it is the idiomatic spelling the moment a local of that name
 * exists.
 *
 * It errs toward complaining in exactly one place: a `return { hidden }` inside
 * some nested closure of the arguments is not a patch, and is flagged anyway.
 * Nothing in this file is written that way, and a complaint about an unreadable
 * form is the failure this guard is allowed to have.
 */
function patchKeys(args) {
  const found = []
  const stack = []
  let quote = null
  let expectKey = false
  for (let i = 0; i < args.length; i += 1) {
    const c = args[i]
    if (quote) {
      if (c === '\\') i += 1
      else if (c === quote) quote = null
      continue
    }
    if (expectKey && !/\s/.test(c)) {
      const key = /^['"]?([A-Za-z_$][\w$]*)['"]?\s*[:,}]/.exec(args.slice(i))
      if (key) found.push(key[1])
      expectKey = false
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') {
      const before = args.slice(0, i)
      const patch = (!stack.length && !/(?:=>|\))\s*$/.test(before))
        || /\breturn\s*$/.test(before)
        || stack[stack.length - 1] === 'concise'
      stack.push(patch ? 'patch' : 'other')
      expectKey = patch
      continue
    }
    // A `(` straight after `=>` wraps a concise body, and what that body
    // evaluates to is the patch — however it gets there. Labelling the frame
    // rather than matching `=> ({` covers the arm of a ternary inside it, which
    // the literal reading walked past.
    if (c === '(') { stack.push(/=>\s*$/.test(args.slice(0, i)) ? 'concise' : 'other'); continue }
    if (c === '[') { stack.push('other'); continue }
    if (c === '}' || c === ')' || c === ']') { stack.pop(); expectKey = false; continue }
    if (c === ',' && stack[stack.length - 1] === 'patch') expectKey = true
  }
  return found
}

/**
 * Complaints about who writes `hidden` and `ghost` in `source`.
 *
 * ONE WRITER IS ALLOWED AND IT IS NAMED BY METHOD: `onModel` is the build
 * ARRIVING, which is the other end of the same mechanism — it is where `rejoin`
 * spends the snapshot, so it has nothing to keep in step. Excluded by name
 * rather than by how the call is written, because the way it is written is
 * exactly what this guard must not depend on.
 *
 * WHAT IT STILL CANNOT SEE, said out loud rather than implied. A patch built
 * into a variable first (`const patch = { hidden: [] }; this.set(patch)`): the
 * argument is an identifier by then and no reading of the call site can follow
 * it. And a patch ASSEMBLED BY A CALL (`this.set(Object.assign({ hidden: [] },
 * …))`), which is left open deliberately rather than missed — closing it means
 * reading a `{` at the top of a call inside the arguments as a patch, and that
 * is the exact shape of `this.set({ menu: null }, () => this.sync({ hidden }))`,
 * a correct line this file's own style produces. A guard that goes red on that
 * is the guard that gets deleted, which is worse than one hole nothing in this
 * file stands in. Every writer here is written inline today, and the six that
 * matter are one-liners inside `computed`.
 */
const VISIBILITY_KEYS = ['hidden', 'ghost']
const MAY_WRITE_VISIBILITY = ['onModel']

function auditVisibility(source) {
  const code = stripComments(source)
  const bad = []
  const writers = code.match(/this\.setVisibility\(/g) || []
  // A regex that stopped matching is a check that vanished with the suite still
  // green, here exactly as above.
  if (writers.length < 2) bad.push('nothing calls setVisibility any more')

  // THE WINDOW IS A HOLE, so it is bounded by the same reading the doors above
  // use rather than by "to the end of the file if I cannot find the end". That
  // fallback is what makes this the worst check in the file to get wrong:
  // `onModel` sits ABOVE all six writers, so a window that ran on would exempt
  // every one of them at once and the guard would go green while checking
  // nothing at all. `methodFrom` refuses both ways it can lose its bearings — no
  // closing line, or one belonging to a later method — and a refusal here is a
  // complaint, exactly like the exemption not resolving.
  const exempt = MAY_WRITE_VISIBILITY.map((name) => {
    const at = new RegExp(`^  ${name}\\s*\\(`, 'm').exec(code)
    if (!at) return null
    const from = at.index + at[0].length
    const body = methodFrom(code, from)
    return body === null ? null : [at.index, from + body.length]
  }).filter(Boolean)
  if (exempt.length !== MAY_WRITE_VISIBILITY.length) {
    bad.push(`a method allowed to write these was not found, or does not end `
             + `where this file's indentation says it should: ${MAY_WRITE_VISIBILITY}`)
  }

  const call = /this\.set(?:State)?\s*\(/g
  for (let m = call.exec(code); m; m = call.exec(code)) {
    if (exempt.some(([from, to]) => m.index >= from && m.index < to)) continue
    const open = m.index + m[0].length - 1
    const close = balanced(code, open)
    if (close === -1) { bad.push(`unbalanced call at ${m.index}`); continue }
    const args = code.slice(open + 1, close)
    patchKeys(args).filter((k) => VISIBILITY_KEYS.includes(k)).forEach((k) => {
      bad.push(`${k} is written past setVisibility: ${args.replace(/\s+/g, ' ').slice(0, 70)}`)
    })
  }
  return bad
}

/** A method of two spaces' indentation, as this file writes them. */
const method = (name, ...body) => [`  ${name}(detail) {`, ...body.map((l) => `    ${l}`), '  }']

/** The exempt writer, doing nothing this guard is about. */
const ONMODEL = method('onModel', 'this.setState({ tree: detail.tree });')

/**
 * A class the guard can read: the two live calls it counts, then `extra`.
 *
 * `onModel` is in every one of these because the guard checks that its own
 * exemption still resolves — a fixture without it is testing that, and one
 * test below does exactly that on purpose.
 */
const klass = (lines, extra = ONMODEL) => [
  'class F {', '  a() {',
  '    this.setVisibility({ hidden: [] });',
  '    this.setVisibility({ ghost: [] });',
  ...lines.map((l) => `    ${l}`),
  '  }', '', ...extra, '}', '',
].join('\n')

describe('the reader changing what they can see', () => {
  it('never writes hidden or ghost through plain set()', () => {
    expect(auditVisibility(SOURCE)).toEqual([])
  })

  it('is read out of the code here too', () => {
    // Same guard-against-itself as the doors above: a rule about `this.set` is
    // easy to write in a way that trips over a comment SAYING `this.set`, and a
    // check nobody has watched go red is a regex, not a check.
    const talking = klass(['// never this.set({ hidden: [] }) — it would strand the snapshot',
                           'this.setVisibility({ hidden: this.toggle(s.hidden, n.leaves) });'])
    const doing = talking.replace('this.setVisibility({ hidden: this.toggle',
                                  'this.set({ hidden: this.toggle')

    expect(auditVisibility(talking)).toEqual([])
    expect(auditVisibility(doing)).toHaveLength(1)
    expect(auditVisibility(doing)[0]).toMatch(/hidden is written past setVisibility/)
  })

  it('catches every shape one of these is written in', () => {
    // THE FORMS THE OLD RULE LET THROUGH, and it let them through because it
    // wanted `({` and stopped at the first `}`: it was a rule about how the line
    // reads, so a writer only had to be idiomatic to slip past it. The first is
    // the one that was measured going green with the whole suite — and it is the
    // form this file already uses in `onModel`.
    const forms = [
      'this.setState((s2) => ({ hidden: this.toggle(s2.hidden, n.leaves) }));',
      'this.setState((s2) => { return { hidden: [] }; });',
      'this.set({ composer: { part: null }, hidden: [] });',
      'this.set( { hidden: [] } );',
      "this.set({ 'hidden': [] });",
      'this.set({\n      ghost: [],\n    });',
      // A patch returned from INSIDE a block of the updater, which is what an
      // updater that has a condition in it looks like. The depth-counting rule
      // this replaces read the `if` as a level and never saw the write.
      'this.setState((s2) => { if (s2.tree) { return { hidden: [] }; } return null; });',
      // The same updater spelled `function`, since nothing here may depend on
      // how it was written.
      'this.setState(function (s2) { return { ghost: [] }; });',
      // And the shorthand, which is what this is written as the moment a local
      // of that name exists. A key regex wanting a colon walks straight past it.
      'this.set({ hidden });',
      'this.set({ tool: null, ghost });',
      // Either arm of a conditional patch is still a patch: both stand where
      // the argument stands — and so does an arm of one inside a concise body,
      // which is the same sentence one frame in.
      'this.set(s.tree ? { hidden: [] } : null);',
      'this.setState((s2) => (s2.tree ? { hidden: [] } : null));',
    ]

    forms.forEach((line) => {
      expect(auditVisibility(klass([line])), line).toHaveLength(1)
    })
  })

  it('reads none of the objects a call merely carries', () => {
    // The control on the list above, and the reason the three positions are
    // named rather than a nesting depth counted: every one of these is a `{`
    // inside the arguments of a real `setState` in this file's own style, and
    // none of them is a patch. The last is `setVisibility`'s own body — the
    // carry rebuilt as a ternary inside an `if` inside the completion callback
    // — and it is what every wider rule tried here went red on.
    const carried = [
      'this.setState({ detail: { hidden: s.hidden } });',
      'this.set({ menu: null }, () => this.sync({ ghost: s.ghost }));',
      'this.setState(patch, () => { this.emit({ hidden: [] }); });',
      'this.setState(patch, () => {\n'
      + '      if (this.carry) {\n'
      + '        this.carry = this.state.tree ? { hidden: [], ghost: [] } : null;\n'
      + '      }\n'
      + '    });',
    ]

    carried.forEach((line) => {
      expect(auditVisibility(klass([line])), line).toEqual([])
    })
  })

  it('leaves alone a key of that name that is not a state field', () => {
    // The cost of over-reaching, and why this counts levels rather than scanning
    // for the word: `sync` hands the viewport a detail object with a `hidden` in
    // it, and a guard that flagged nested keys would go red on code that is
    // right. That is the guard that gets deleted.
    const nested = klass(['this.setState({ detail: { hidden: s.hidden, ghost: s.ghost } });'])

    expect(auditVisibility(nested)).toEqual([])
  })

  it('exempts the build ARRIVING, and does it by method name', () => {
    // `onModel` is where the snapshot is SPENT rather than kept in step, so it
    // is allowed to write these two — and it is named, not pattern-matched,
    // because the shape of the call is the thing this guard must not lean on.
    // The same body under any other name is the defect itself.
    const writes = 'this.setState((s) => ({ tree: detail.tree, hidden: [], ghost: [] }));'

    expect(auditVisibility(klass([], method('onModel', writes)))).toEqual([])
    expect(auditVisibility(klass([], [...method('onVis', writes), '', ...ONMODEL])))
      .toHaveLength(2)
  })

  it('says so when the method it exempts is gone', () => {
    // An exemption is a hole, and a hole that stops matching its method widens
    // silently — the guard would go on passing while checking a class it no
    // longer recognises. So the lookup failing is itself a complaint.
    expect(auditVisibility(klass([], []))[0])
      .toMatch(/allowed to write these was not found/)
  })

  it('does not let the exemption run past the method it belongs to', () => {
    // THE WORST WAY THIS GUARD CAN FAIL, and the only one that is silent. The
    // window used to end at the end of the FILE when the method's closing line
    // was not found where this file's indentation says — and `onModel` is above
    // every writer, so one method that did not close took the exemption over
    // all of them and the guard passed while checking nothing. Here the close
    // it finds belongs to the method BELOW, which is the shape that swallows a
    // real write: the complaint has to be about the window, and the write below
    // it has to be caught as well.
    const swallowed = [
      'class F {',
      '  a() {',
      '    this.setVisibility({ hidden: [] });',
      '    this.setVisibility({ ghost: [] });',
      '  }',
      '',
      '  onModel(detail) {',
      '      this.setState({ tree: detail.tree });',
      '    }',
      '',
      '  onVis(detail) {',
      '    this.setState({ hidden: [] });',
      '  }',
      '}',
      '',
    ].join('\n')
    const bad = auditVisibility(swallowed)

    expect(bad[0]).toMatch(/does not end where/)
    expect(bad.some((b) => /hidden is written past setVisibility/.test(b)),
           'the widened window swallowed a real write').toBe(true)
  })
})
