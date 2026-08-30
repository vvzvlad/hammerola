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

import HammerolaViewer from '../src/HammerolaViewer.jsx'
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

/** Both views the fixture build declares, in the order meta.json lists them. */
const VIEWS = [
  { id: 'assembled', name: 'assembled', file: 'a.json', parts: 2, gzip: 1000 },
  { id: 'printables', name: 'printables', file: 'p.json', parts: 2, gzip: 900 },
]

/** A build of the target revision, with whichever views it is given. */
const build = (variants = VIEWS) => ({
  project: 'fixture', title: '', commit: B, built: '2026-08-28T09:00:00Z',
  downloads: {}, variants,
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

/** The tree on screen: two parts. */
const TREE = {
  id: '/model',
  name: 'model',
  children: [{ id: '/model/plate', name: 'plate' }, { id: '/model/post', name: 'post' }],
}

/** The same model one revision later: `plate` renumbered, `post` gone. */
const TREE_B = {
  id: '/model',
  name: 'model',
  children: [{ id: '/model/0', name: 'plate' }],
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
  c.host = { current: null }
  c.state = {
    meta: {
      project: 'fixture', commit: A, built: '2026-08-27T18:20:00Z', downloads: {},
      variants: VIEWS,
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
    comments: [], activePin: null, composer: null,
    measure: null, moved: null, toast: null,
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
    const c = component({ pending: { commit: 'ccc', variants: VIEWS } })
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
    const c = component({ pending: { commit: 'ccc', variants: VIEWS } })
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
    // list, nor dispatch a state event for a change that did not happen.
    const c = component({ hidden: ['/model/plate'], ghost: ['/model/post'] })

    c.onModel({ tree: TREE, view: 'assembled', live: true })

    expect(c.state.hidden).toEqual(['/model/plate'])
    expect(c.state.ghost).toEqual(['/model/post'])
    expect(c.sync).not.toHaveBeenCalled()
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
      revOpen: true, dlOpen: true, secPop: true, tokenPop: true, tokenDraft: 'x',
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
    expect(c.state.secPop).toBe(false)
    expect(c.state.tokenPop).toBe(false)
    expect(c.state.notePop).toBeNull()
    expect(c.state.noteDraft).toBe('')
    expect(c.state.measure).toBeNull()
    expect(c.state.moved).toBeNull()
  })

  it('takes the poll\'s offer down with the slot it belonged to', async () => {
    // The banner names a build that arrived under the pointer this page is
    // leaving. On a pinned revision there is nothing for it to offer at all.
    const c = component({ pending: { commit: 'ccc', variants: VIEWS }, bannerGone: false })
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
    const c = component({
      composer: {
        part: 'plate', partId: '/model/plate', p: [1, 2, 3],
        text: 'this hole is', photo: null,
        meas: '3.00 mm', move: 'plate by 2 mm',
      },
    })
    loadMeta.mockResolvedValue(build())

    await c.switchBuild('proj1', B)

    expect(c.state.composer.text).toBe('this hole is')
    expect(c.state.composer.part).toBe('')
    expect(c.state.composer.partId).toBeNull()
    expect(c.state.composer.p).toBeNull()
    expect(c.state.composer.meas).toBeNull()
    expect(c.state.composer.move).toBeNull()
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

  it('drops the comments filed in this session, and the pin that was open', async () => {
    // This list only ever holds what the reader posted while the page was open,
    // each one against the commit it was posted on. Kept, the rail would attribute
    // them to a revision they say nothing about.
    const c = component({
      comments: [{ id: 'c1', label: '1', part: 'plate', pin: [1, 2, 3],
                   text: 'too thin', resolved: false }],
      activePin: 'c1',
    })
    loadMeta.mockResolvedValue(build())

    await c.switchBuild('proj1', B)

    expect(c.state.comments).toEqual([])
    expect(c.state.activePin).toBeNull()
  })

  it('sends the viewport no pin belonging to the build it left', async () => {
    // THE OBSERVABLE HALF, and the reason that list cannot simply stay: a pin is
    // a POINT IN THE MODEL SPACE of the build it was placed on, `sync` reads the
    // pins straight off `comments` on every frame, and the new build need not
    // contain that point at all — so the old ones would be drawn on geometry that
    // never carried them. The draft's own pin goes the same way, through the
    // composer's anchor.
    const c = component({
      comments: [{ id: 'c1', label: '1', part: 'plate', pin: [1, 2, 3], resolved: false }],
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
    pending: { commit: 'ccc', built: '2026-08-29T10:00:00Z', downloads: {}, variants: VIEWS },
    ...over,
  })

  it('sends the viewport no pin belonging to the build the banner replaced', () => {
    // THE TWIN of the swap's own claim above, and the reason it had to be
    // written twice: a pin is a POINT IN THE MODEL SPACE of the build it was
    // placed on, `sync` reads the pins straight off `comments` on every frame,
    // and the build the banner is offering need not contain that point at all.
    // Without it the old pins were drawn on geometry that never carried them —
    // invisible as a defect, because a pin looks like a pin wherever it lands.
    const c = offered({
      comments: [{ id: 'c1', label: '1', part: 'plate', pin: [1, 2, 3], resolved: false }],
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
    expect(c.state.comments).toEqual([])
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
        part: 'plate', partId: '/model/plate', p: [1, 2, 3],
        text: 'this hole is', photo: null, meas: '3.00 mm', move: 'plate by 2 mm',
      },
    })

    c.takePending()

    expect(c.state.composer.text).toBe('this hole is')
    expect(c.state.composer.part).toBe('')
    expect(c.state.composer.partId).toBeNull()
    expect(c.state.composer.p).toBeNull()
    expect(c.state.composer.meas).toBeNull()
    expect(c.state.composer.move).toBeNull()
  })

  it('drops the selection, the menu and every popover', () => {
    // `sel` is a solid path of the build that left and goes to the viewport as
    // `selected` on the next frame; the rest are menus about a model that is no
    // longer under them.
    const c = offered({
      sel: '/model/plate', selName: 'plate',
      menu: { id: '/model/plate', x: 10, y: 20 },
      revOpen: true, dlOpen: true, secPop: true, tokenPop: true, tokenDraft: 'x',
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
    expect(c.state.secPop).toBe(false)
    expect(c.state.tokenPop).toBe(false)
    expect(c.state.notePop).toBeNull()
    expect(c.state.noteDraft).toBe('')
    expect(c.state.measure).toBeNull()
    expect(c.state.moved).toBeNull()
    // And the viewport is told, since a selection is its state too.
    expect(seen[0].selected).toBeNull()
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
    const c = component({ pending: { commit: 'ccc', variants: VIEWS } })
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
    const offer = { commit: 'ccc', variants: VIEWS }
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
    const c = component({ pending: { commit: 'ccc', variants: VIEWS } })
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
    const c = component({ pending: { commit: 'ccc', variants: VIEWS } })
    const live = c.computed().bannerSwitchStyle

    c.setState({ swapping: true })
    const spent = c.computed().bannerSwitchStyle

    expect(live).toContain('cursor:pointer')
    expect(spent, 'the cursor still promises a click').not.toContain('cursor:pointer')
    expect(spent, 'and it is still painted the colour of a live button')
      .not.toContain('background:#1f7ae0')
  })

  it('is a live button again once that swap has failed', async () => {
    // THE HALF THAT MUST NOT BE PAID FOR BY THE OTHER. Nothing about the offer
    // was answered — it was postponed by a few hundred milliseconds of network —
    // so a revision that 404s must leave the reader able to take it after all.
    // Emptying `pending` would have been the cheap way to make the button inert
    // and would have thrown the offer away with it.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const offer = { commit: 'ccc', built: '2026-08-29T10:00:00Z', downloads: {},
                    variants: VIEWS }
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
    // actually broken is invisible — `authorNote` looks those names up in the
    // NEW build's `meta.notes`, and every row's menu builds its download links
    // on the NEW base.
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
  // It rides in `meta.notes` — written in model.py, published with the build —
  // so a swap that replaces `meta` replaces the notes with it. THAT IS ASSERTED
  // RATHER THAN ASSUMED: a stale note is the worst thing this box can show,
  // because it is a sentence about a part that is no longer the part on screen,
  // and nothing about it would look wrong. Everything else about the two notes
  // is in `notes.test.js`; this is the one claim that needs a real swap.
  //
  // THE PART IS PICKED AGAIN AFTERWARDS, because a swap drops the selection on
  // purpose (above) — which is also the reader's own gesture: they click the
  // part in the model that has just arrived.
  const on = (id, name) => ({ sel: id, selName: name })

  it('is the new revision\'s once the swap has landed', async () => {
    const c = component({ ...on('/model/plate', 'plate'),
                          meta: { project: 'fixture', commit: A, built: '', downloads: {},
                                  variants: VIEWS, notes: { plate: 'M3x8 DIN912' } } })
    expect(c.computed().authorNote).toBe('M3x8 DIN912')

    loadMeta.mockResolvedValue({ ...build(), notes: { plate: 'M4x10, was M3' } })
    await c.switchBuild('proj1', B)
    c.onModel({ tree: TREE_B, view: 'assembled', live: true })
    c.setState(on('/model/0', 'plate'))

    expect(c.computed().authorNote).toBe('M4x10, was M3')
  })

  it('is gone when the revision switched TO carries none', async () => {
    // The direction that fails silently: `meta.notes` is absent on most builds,
    // and a note left over from the previous one would be attributed to a model
    // that never said it.
    const c = component({ ...on('/model/plate', 'plate'),
                          meta: { project: 'fixture', commit: A, built: '', downloads: {},
                                  variants: VIEWS, notes: { plate: 'M3x8 DIN912' } } })

    loadMeta.mockResolvedValue(build())
    await c.switchBuild('proj1', B)
    c.onModel({ tree: TREE_B, view: 'assembled', live: true })
    c.setState(on('/model/0', 'plate'))

    expect(c.state.meta.notes).toBeUndefined()
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
 * The source of one method, from `at` to the line that closes it.
 *
 * Methods of this class close on a `}` indented by two spaces, and nothing
 * inside one is indented that shallowly — the nested blocks close at four and
 * six — so this is the method body and not the rest of the file.
 */
function methodFrom(at) {
  const end = SOURCE.indexOf('\n  }\n', at)
  return SOURCE.slice(at, end === -1 ? SOURCE.length : end)
}

describe('every door into another build', () => {
  it('is a call that keeps both halves of the answer', () => {
    const doors = []
    const call = /this\.leaveBuild\(/g
    for (let m = call.exec(SOURCE); m; m = call.exec(SOURCE)) {
      const line = SOURCE.slice(SOURCE.lastIndexOf('\n', m.index) + 1, m.index)
      const named = /(?:const|let|var)\s+(\w+)\s*=\s*$/.exec(line)
      doors.push({ at: m.index, held: named ? named[1] : null, line: line.trim() })
    }

    // A regex that stopped matching is a check that vanished with the suite
    // still green — the failure `ci/smoke.py` counts its verdicts to avoid.
    expect(doors.length, 'no call to leaveBuild was found at all').toBeGreaterThan(1)

    doors.forEach((door) => {
      // Held in a variable, because an answer nobody holds is an answer both
      // halves of which were dropped.
      expect(door.held, `leaveBuild's answer is thrown away: ${door.line}`).not.toBeNull()
      const body = methodFrom(door.at)
      expect(body, `${door.held}.state never reaches setState`)
        .toContain(`...${door.held}.state`)
      // THE HALF THE DOCSTRING WARNS ABOUT. Without it the plane stays in the
      // scene while every control on this side says there is no cut.
      expect(body, `${door.held}.extra never reaches the viewport`)
        .toContain(`sync(${door.held}.extra)`)
    })
  })
})
