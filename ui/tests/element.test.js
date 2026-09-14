// <hmr-viewport> — the DIFFING, and nothing that needs a WebGL context.
//
// Every `hmr:state` runs through `setState`, which decides whether a patch is a
// reload, a live swap or an ordinary change — and only an ORDINARY one runs on
// into `reconcile`, which brings the scene in line with `state` while writing as
// little as it can get away with. A PATCH THAT DECIDES ON A LOAD DOES NOT, and
// the test `does not reconcile on the way to a reload` is what pins it:
// `setState` hands off to `load()` and returns before reaching `reconcile()`.
// `reconcile` then comes out of `show` on the way back. State
// arrives far oftener than a reader changes anything — dragging the
// section-plane slider pushes state per step (`setSecOff` in HammerolaViewer
// goes through `set`, which syncs) — which is why what these two DON'T write is
// the subject here.
//
// There is no GPU in a test runner, so the instance below is the prototype with
// exactly the fields these two methods read. `load` is stubbed wherever a test
// only cares that it was reached.
//
// `load` ITSELF IS EXERCISED in one place, and only as far as it gets without
// the library: the view that names no file and the fetch that comes back 404.
// Both are about what the element REMEMBERS afterwards, and
// that memory is what stops the interface's next patch — one arrives on every
// click in the tree — from asking the hub for the same missing file again.
//
// The library calls are mocked, and this is the one file where that is the right
// answer rather than a shortcut: what is being asked is "was `applyHidden`
// called at all", and a real `applyHidden` would answer that only indirectly,
// through a scene. Each of those functions has its own tests in parts.test.js
// and section.test.js, against the real thing.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

vi.mock('../src/viewport/parts.js', () => ({
  applyGhost: vi.fn(),
  applyHidden: vi.fn(),
  applySelected: vi.fn(),
  resetMoves: vi.fn(),
  statesOf: vi.fn(() => ({})),
  treeFromShapes: vi.fn(() => ({})),
}))

vi.mock('../src/viewport/section.js', () => ({
  applySection: vi.fn(),
  keepSectionCut: vi.fn(),
  suspendSectionCut: vi.fn(),
}))

// The hatch, mocked for ONE question this file can answer and hatch.test.js
// cannot: is it reached at all, and does the toggle reach it from reconcile.
// What it DOES with a scene, and that a throw from it never leaves it, are
// properties of the module and are tested against the real thing over there.
vi.mock('../src/viewport/hatch.js', () => ({
  safeHatch: vi.fn(() => 0),
  setCutHatch: vi.fn(() => 0),
}))

// The library's own loader, replaced so `show()` can be driven as far as its
// FAILURE path — which is the only part of it that runs without a GPU. Nothing
// else here reaches it: every other test either stops before `show` or never
// gets past the fetch.
vi.mock('../src/viewport/library.js', () => ({
  loadViewerLibrary: vi.fn(async () => { throw new Error('no library here') }),
}))

// The registration of `<hmr-viewport>`, for the one describe block below that
// really upgrades the element. Importing it is what makes `document.createElement`
// build an HmrViewport rather than an unknown inline box.
import '../src/viewport/index.js'
import { HmrViewport } from '../src/viewport/element.js'
import { EVENT_ERROR, EVENT_MODEL, TAG } from '../src/viewport/events.js'
import { safeHatch, setCutHatch } from '../src/viewport/hatch.js'
import { loadViewerLibrary } from '../src/viewport/library.js'
import {
  applyGhost, applyHidden, applySelected, resetMoves,
} from '../src/viewport/parts.js'
import { applySection, suspendSectionCut } from '../src/viewport/section.js'
import { fakeViewer } from './fakes.js'

/**
 * The element as `reconcile` and `setState` see it: the real prototype, and the
 * fields `connectedCallback` would have set.
 *
 * `applied` starts exactly as the element starts it, `selected` UNDEFINED rather
 * than an empty list — the sentinel that makes the first reconcile clear a
 * highlight the library may have painted on its own. `state.selected` is a LIST
 * of paths since issue #75, because a tree row may stand for several copies of
 * one part.
 */
function element(state = {}, viewer = fakeViewer()) {
  const vp = Object.create(HmrViewport.prototype)
  vp.viewer = viewer
  vp.booted = true
  vp.state = {
    hidden: [], ghost: [], selected: [], camera: null,
    cut: false, cutOffset: 0, cutFlip: false, cutHatch: true, pins: [],
    base: null, views: [], view: null, buildKey: null, tool: null,
    ...state,
  }
  vp.applied = {
    hidden: null, ghost: null, selected: undefined, camera: null,
    cutHatch: null,
  }
  vp.sectionSeed = null
  vp.moved = new Map()
  vp.partHome = new Map()
  vp.measurePicks = []
  vp.measureLabel = null
  vp.loadToken = 0
  vp.loadFailed = null
  vp.overlay = { setPins: vi.fn(), refresh: vi.fn() }
  // The up-events go through `dispatchEvent`, which is a real DOM method on a
  // real element and refuses to run on an object the DOM never built — the same
  // reason the note above `calledWithViewport` gives about `getAttributeNames`.
  vp.dispatchEvent = vi.fn()
  return vp
}

/** The one up-event a call emitted, or null. */
const emitted = (vp) => (vp.dispatchEvent.mock.calls.length === 1
  ? vp.dispatchEvent.mock.calls[0][0] : null)

/** A viewport that has already been reconciled once, so the next call is a diff. */
function settled(state, viewer) {
  const vp = element(state, viewer)
  vp.reconcile()
  vi.clearAllMocks()
  return vp
}

/** `expect(fn).toHaveBeenCalledWith(vp)` is not available here: a deep compare
 *  of an object whose prototype chain reaches HTMLElement makes the printer walk
 *  it, and jsdom refuses — `getAttributeNames` on something the DOM never built
 *  throws. Identity is what these assertions mean anyway; the argument IS the
 *  viewport.
 */
const calledWithViewport = (fn, vp, times = 1) => {
  expect(fn).toHaveBeenCalledTimes(times)
  for (const call of fn.mock.calls) expect(call[0]).toBe(vp)
}

beforeEach(() => { vi.clearAllMocks() })

describe('reconcile', () => {
  it('does nothing at all before there is a viewer', () => {
    const vp = element()
    vp.viewer = null
    vp.reconcile()
    expect(applyHidden).not.toHaveBeenCalled()
    expect(vp.overlay.setPins).not.toHaveBeenCalled()
  })

  it('applies everything on the first pass, because nothing is applied yet', () => {
    const vp = element({ hidden: ['/Group/a'], ghost: ['/Group/b'] })
    vp.reconcile()
    expect(applyHidden).toHaveBeenCalledWith(vp.viewer, ['/Group/a'])
    expect(applyGhost).toHaveBeenCalledWith(vp.viewer, ['/Group/b'])
    // Even though nothing is selected: `applied.selected` is `undefined` until
    // the first pass, so this is the call that clears whatever the library
    // highlighted on its own.
    expect(applySelected).toHaveBeenCalledWith(vp.viewer, [])
  })

  it('writes nothing on a second pass with the same state', () => {
    const vp = settled({ hidden: ['/Group/a'], selected: ['/Group/b'] })
    vp.reconcile()
    expect(applyHidden).not.toHaveBeenCalled()
    expect(applyGhost).not.toHaveBeenCalled()
    expect(applySelected).not.toHaveBeenCalled()
  })

  it('touches only the list that changed', () => {
    const vp = settled({ hidden: ['/Group/a'], ghost: ['/Group/b'] })
    vp.state = { ...vp.state, hidden: ['/Group/a', '/Group/c'] }
    vp.reconcile()
    expect(applyHidden).toHaveBeenCalledTimes(1)
    expect(applyGhost).not.toHaveBeenCalled()
    expect(applySelected).not.toHaveBeenCalled()
  })

  it('compares lists BY VALUE, which is what makes it safe under React', () => {
    // React hands a fresh array on every render; identity would make every
    // render a re-apply, and re-applying `hidden` is a `setStates` and a
    // re-render of the scene.
    const vp = settled({ hidden: ['/Group/a'] })
    vp.state = { ...vp.state, hidden: ['/Group/a'] }   // equal, not identical
    vp.reconcile()
    expect(applyHidden).not.toHaveBeenCalled()
  })

  it('notices a reordered list, because order is not a set here', () => {
    const vp = settled({ hidden: ['/Group/a', '/Group/b'] })
    vp.state = { ...vp.state, hidden: ['/Group/b', '/Group/a'] }
    vp.reconcile()
    expect(applyHidden).toHaveBeenCalledTimes(1)
  })

  it('applies a selection change, including back to nothing', () => {
    const vp = settled({ selected: ['/Group/a'] })
    vp.state = { ...vp.state, selected: [] }
    vp.reconcile()
    expect(applySelected).toHaveBeenCalledWith(vp.viewer, [])
  })

  it('compares the SELECTION by value too, which React makes necessary', () => {
    // The selection became a list in issue #75, and `selectedPaths` in
    // HammerolaViewer mints a fresh one on EVERY push — all three of its
    // branches build a new array, so this is not a property of the empty
    // selection in particular. An identity check here would therefore re-paint
    // the highlight on every `hmr:state`, and one of those goes out per step of
    // the section-plane slider — while `hidden` and `ghost` beside it are
    // handed straight out of state by `sync` and do keep their identity.
    const vp = settled({ selected: ['/Group/a'] })
    vp.state = { ...vp.state, selected: ['/Group/a'] }   // equal, not identical
    vp.reconcile()
    expect(applySelected).not.toHaveBeenCalled()

    // …and a copy MORE is a change, so the guard is not simply always silent.
    vp.state = { ...vp.state, selected: ['/Group/a', '/Group/b'] }
    vp.reconcile()
    expect(applySelected).toHaveBeenCalledWith(vp.viewer, ['/Group/a', '/Group/b'])
  })

  describe('the camera', () => {
    const frame = { position: [1, 2, 3], target: [0, 0, 0], zoom: 2 }

    it('is written when the interface names one', () => {
      const vp = element({ camera: frame })
      vp.reconcile()
      const [call] = vp.viewer.locationCalls
      expect(call.position).toEqual(frame.position)
      expect(call.zoom).toBe(2)
      // `notify: false` — this is the interface restoring a frame, not the
      // reader moving the camera, and a notification would come straight back
      // as another state patch.
      expect(call.notify).toBe(false)
    })

    it('is not re-written for a frame equal to the one already applied', () => {
      // The reader is dragging the trackball; a re-applied frame would snap the
      // camera back under their hand.
      const vp = settled({ camera: frame })
      vp.state = { ...vp.state, camera: { ...frame } }
      vp.reconcile()
      expect(vp.viewer.setCameraLocationSettings).not.toHaveBeenCalled()
    })

    it('is left alone when the interface names none', () => {
      const vp = element({ camera: null })
      vp.reconcile()
      expect(vp.viewer.setCameraLocationSettings).not.toHaveBeenCalled()
    })
  })

  describe('the cut', () => {
    it('is asserted when it is on and a plane has been placed', () => {
      const vp = element({ cut: true })
      vp.sectionSeed = { normal: [0, 0, -1], point: [0, 0, 0], placed: true }
      vp.reconcile()
      calledWithViewport(applySection, vp)
      expect(suspendSectionCut).not.toHaveBeenCalled()
    })

    it('is suspended when it is off, which leaves the plane where it was', () => {
      // Off is not "forget it": turning it back on must need no second click.
      const vp = element({ cut: false })
      vp.sectionSeed = { normal: [0, 0, -1], point: [0, 0, 0], placed: true }
      vp.reconcile()
      calledWithViewport(suspendSectionCut, vp)
      expect(applySection).not.toHaveBeenCalled()
    })

    it('does neither when it is on but nothing has been cut yet', () => {
      // Armed and waiting for a face. Suspending here would be harmless and
      // asserting would cut by a number nobody chose.
      const vp = element({ cut: true })
      vp.reconcile()
      expect(applySection).not.toHaveBeenCalled()
      expect(suspendSectionCut).not.toHaveBeenCalled()
    })
  })

  describe('the hatch over the cut', () => {
    it('reaches the scene when cutHatch changes, and only then', () => {
      // The toggle is a uniform write inside the library's materials, not a
      // reload and not a recompile — but it is still work per state event, and
      // one event goes out per section-slider step, so it is memo'd against
      // `applied` like the three fields above it.
      const vp = settled({ cutHatch: true })
      vp.state = { ...vp.state, cutHatch: false }
      vp.reconcile()
      expect(setCutHatch).toHaveBeenCalledTimes(1)
      expect(setCutHatch.mock.calls[0][1]).toBe(false)
      expect(vp.applied.cutHatch).toBe(false)
      vp.reconcile()
      expect(setCutHatch).toHaveBeenCalledTimes(1)   // equal again: nothing written
    })

    it('re-asserts itself after a render has rebuilt the caps', () => {
      // `show()` patches fresh materials with the current answer and resets
      // `applied`; the first reconcile afterwards asserts the same value once,
      // the same way `hidden` and `ghost` do.
      const vp = settled({ cutHatch: false })
      vp.applied.cutHatch = null
      vp.reconcile()
      expect(setCutHatch).toHaveBeenCalledTimes(1)
      expect(setCutHatch.mock.calls[0][1]).toBe(false)
    })
  })

  it('hands the pins to the overlay on every pass', () => {
    // No diffing here on purpose: the overlay redraws from scratch and the pins
    // move with the camera, so there is no state to compare against.
    const vp = element({ pins: [{ id: 1 }] })
    vp.reconcile()
    vp.reconcile()
    expect(vp.overlay.setPins).toHaveBeenCalledTimes(2)
    expect(vp.overlay.setPins).toHaveBeenLastCalledWith(vp.state.pins)
  })
})

describe('setState', () => {
  it('ignores a patch that is not an object', () => {
    const vp = element({ hidden: ['/Group/a'] })
    vp.setState(null)
    vp.setState('hidden')
    expect(vp.state.hidden).toEqual(['/Group/a'])
  })

  it('merges rather than replaces', () => {
    const vp = element({ hidden: ['/Group/a'], ghost: ['/Group/b'] })
    vp.setState({ hidden: [] })
    expect(vp.state.hidden).toEqual([])
    expect(vp.state.ghost).toEqual(['/Group/b'])
  })

  describe('the three imperative flags', () => {
    it('acts on __resetMove and does not leave it in state', () => {
      const vp = element()
      vp.setState({ __resetMove: true })
      calledWithViewport(resetMoves, vp)
      expect('__resetMove' in vp.state).toBe(false)
    })

    it('drops the plane and the offset on __resetCut', () => {
      const vp = element({ cutOffset: 12 })
      vp.sectionSeed = { normal: [0, 0, -1], point: [0, 0, 0], placed: true }
      vp.setState({ __resetCut: true })
      expect(vp.sectionSeed).toBeNull()
      expect(vp.state.cutOffset).toBe(0)
      // Twice, and that is the design rather than a slip: the flag parks the
      // slider, and the reconcile that follows finds `cut: false` and parks it
      // again. Suspending is idempotent — it writes the value the library's own
      // reset writes — so the second call costs nothing and the alternative is a
      // special case in `reconcile` for "somebody already did this".
      calledWithViewport(suspendSectionCut, vp, 2)
      expect('__resetCut' in vp.state).toBe(false)
    })

    it('clears the tape and redraws on __clearMeasure', () => {
      const vp = element()
      vp.measurePicks = [{ point: [0, 0, 0] }]
      vp.measureLabel = 'something'
      vp.setState({ __clearMeasure: true })
      expect(vp.measurePicks).toEqual([])
      expect(vp.measureLabel).toBeNull()
      expect(vp.overlay.refresh).toHaveBeenCalled()
      expect('__clearMeasure' in vp.state).toBe(false)
    })

    it('leaves the flag out even when it is false', () => {
      // Otherwise `state` carries a permanent `__resetMove: false`, which is
      // exactly the sort of field somebody later writes a condition against.
      const vp = element()
      vp.setState({ __resetMove: false })
      expect(resetMoves).not.toHaveBeenCalled()
      expect('__resetMove' in vp.state).toBe(false)
    })
  })

  describe('what counts as a reload', () => {
    const views = [{ id: 'a', file: 'a.json' }, { id: 'b', file: 'b.json' }]

    it('a different view reloads, and NOT as a live swap', () => {
      // A different view is a different arrangement of the same parts, whose own
      // extent the camera has to be re-fitted to.
      const vp = element({ views, view: 'a', buildKey: 'k1' })
      vp.load = vi.fn()
      vp.setState({ view: 'b' })
      expect(vp.load).toHaveBeenCalledWith({ live: false })
    })

    it('a new buildKey under the same view is a LIVE swap', () => {
      const vp = element({ views, view: 'a', buildKey: 'k1' })
      vp.load = vi.fn()
      vp.setState({ buildKey: 'k2' })
      expect(vp.load).toHaveBeenCalledWith({ live: true })
    })

    it('both at once is a reload, not a swap: the frame does not survive', () => {
      const vp = element({ views, view: 'a', buildKey: 'k1' })
      vp.load = vi.fn()
      vp.setState({ view: 'b', buildKey: 'k2' })
      expect(vp.load).toHaveBeenCalledWith({ live: false })
    })

    it('the FIRST buildKey is not a swap — there is nothing to keep', () => {
      const vp = element({ views, view: 'a', buildKey: null })
      vp.load = vi.fn()
      vp.setState({ buildKey: 'k1' })
      expect(vp.load).not.toHaveBeenCalled()
    })

    it('a new BASE alone is a live swap too', () => {
      // Choosing another revision in the picker, which no longer reloads the
      // page (issue #62). `base` is where the view file is fetched from,
      // so the same view id under a new base names a DIFFERENT FILE.
      //
      // ALONE, because that really happens: `latest` and the revision it points
      // at carry the SAME commit, so switching between the two moves nothing but
      // the address. Without the base in this rule the element would keep the
      // scene it had and quietly disagree with the URL — a page that says one
      // revision and shows another.
      const vp = element({ views, view: 'a', base: '/project/p/latest/', buildKey: 'k1' })
      vp.load = vi.fn()
      vp.setState({ base: '/project/p/abc/' })
      expect(vp.load).toHaveBeenCalledWith({ live: true })
    })

    it('and with the build key beside it, which is how the swap really arrives', () => {
      // Two revisions of one project differ in both, and the interface sends
      // them in one patch. Still a live swap and NOT a reload: the reader is
      // comparing two builds from one angle, which is the whole reason the frame
      // has to survive.
      const vp = element({ views, view: 'a', base: '/project/p/one/', buildKey: 'k1' })
      vp.load = vi.fn()
      vp.setState({ base: '/project/p/two/', buildKey: 'k2' })
      expect(vp.load).toHaveBeenCalledWith({ live: true })
    })

    it('the FIRST base is not a swap either', () => {
      // The element starts with `base: null` and the interface fills it in
      // beside the first `view`. That is a load with nothing to keep, and it is
      // reached as a first load rather than as a swap.
      const vp = element({ views, view: 'a', base: null, buildKey: null }, null)
      vp.load = vi.fn()
      vp.setState({ base: '/project/p/one/', buildKey: 'k1', view: 'a' })
      expect(vp.load).toHaveBeenCalledWith({ live: false })
    })

    it('loads when a view is named and no scene has been built yet', () => {
      const vp = element({ views, view: 'a' }, null)
      vp.load = vi.fn()
      vp.setState({ hidden: [] })
      expect(vp.load).toHaveBeenCalled()
    })

    it('reconciles instead of reloading for an ordinary patch', () => {
      const vp = element({ views, view: 'a', buildKey: 'k1' })
      vp.load = vi.fn()
      vp.setState({ hidden: ['/Group/a'] })
      expect(vp.load).not.toHaveBeenCalled()
      expect(applyHidden).toHaveBeenCalledWith(vp.viewer, ['/Group/a'])
    })

    it('does not reconcile on the way to a reload', () => {
      // The scene is about to be rebuilt and `applied` reset with it; applying
      // the new state to the OLD scene is work thrown away.
      const vp = element({ views, view: 'a', buildKey: 'k1' })
      vp.load = vi.fn()
      vp.setState({ view: 'b', hidden: ['/Group/a'] })
      expect(applyHidden).not.toHaveBeenCalled()
    })
  })
})

describe('load', () => {
  const views = [{ id: 'a', file: 'a.json' }, { id: 'b', file: 'b.json' }]

  describe('the exits that never reach the library', () => {
    it('says so when the chosen view names no file', async () => {
      // Reachable with a perfectly ordinary `views` list — one entry of it
      // simply carries no file. Nothing is fetched, so the scene stays empty;
      // without an event the interface's `viewError` stays null and block 11's
      // panel is not drawn, which leaves the reader looking at a frame around a
      // hole with nothing anywhere saying why.
      const vp = element({ views: [{ id: 'a' }], view: 'a' }, null)
      await vp.load()
      const event = emitted(vp)
      expect(event.type).toBe(EVENT_ERROR)
      expect(event.detail.stage).toBe('load')
      expect(event.detail.view).toBe('a')
    })

    it('says so when the build lists no views at all', async () => {
      const vp = element({ views: [], view: 'a' }, null)
      await vp.load()
      expect(emitted(vp).type).toBe(EVENT_ERROR)
    })
  })

  describe('the token a guarded document wants', () => {
    // One view file on this site is behind EDIT_TOKEN — the scene of a
    // comparison (issue #10) — and this element is what fetches it, because it
    // fetches every view file it renders and there is deliberately no second
    // entrance. So the secret arrives in `hmr:state` like everything else, and
    // what these two pin is that it is spent on exactly the fetch that wants it.
    afterEach(() => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    const refusing = () => {
      const fetching = vi.fn(async () => ({ ok: false, status: 500 }))
      vi.stubGlobal('fetch', fetching)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      return fetching
    }

    it('sends the header where the interface put a token in the state', async () => {
      const fetching = refusing()
      const vp = element({ views,
                           view: 'a',
                           base: '/project/p/aaa/compare/bbb/',
                           token: 'sekrit' }, null)

      await vp.load()

      expect(fetching).toHaveBeenCalledWith('/project/p/aaa/compare/bbb/a.json',
                                            { headers: { Authorization: 'Bearer sekrit' } })
    })

    it('sends none for a build\'s own view file, which is public', async () => {
      // Sending the secret that publishes with every two-megabyte view fetch
      // would be this element deciding on its own that a public document is a
      // guarded one.
      const fetching = refusing()
      const vp = element({ views, view: 'a', base: '/project/p/dev/' }, null)

      await vp.load()

      expect(fetching).toHaveBeenCalledWith('/project/p/dev/a.json', undefined)
    })
  })

  describe('a failure the element remembers', () => {
    it('is not fetched a second time by an ordinary patch', async () => {
      // The storm this closes: the interface sends `hmr:state` on every `set()`
      // — a node opened in the tree, a view tab, a pin — and the first-load
      // branch fires on `view && !viewer`, which a failed load leaves true.
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const fetching = vi.fn(async () => ({ ok: false, status: 404 }))
      vi.stubGlobal('fetch', fetching)

      const vp = element({ views, view: 'a', base: '/project/p/dev/' }, null)
      await vp.load()
      expect(fetching).toHaveBeenCalledTimes(1)
      expect(vp.loadFailed).toBe('a.json')

      vp.setState({ hidden: ['/Group/a'] })
      vp.setState({ selected: ['/Group/a'] })
      expect(fetching).toHaveBeenCalledTimes(1)

      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    it('stops counting when the reader asks for a different view', () => {
      const vp = element({ views, view: 'a', buildKey: 'k1' }, null)
      vp.loadFailed = 'a.json'
      vp.load = vi.fn()
      vp.setState({ view: 'b' })
      expect(vp.load).toHaveBeenCalledWith({ live: false })
      expect(vp.loadFailed).toBeNull()
    })

    it('stops counting when a new build lands', () => {
      // The likeliest recovery of all: the push that failed to produce a view
      // file is followed by one that did.
      const vp = element({ views, view: 'a', buildKey: 'k1' }, null)
      vp.loadFailed = 'a.json'
      vp.load = vi.fn()
      vp.setState({ buildKey: 'k2' })
      expect(vp.load).toHaveBeenCalledWith({ live: true })
      expect(vp.loadFailed).toBeNull()
    })

    it('stops counting when the reader asks for it again', () => {
      // THE DELIBERATE REPEAT, which the memory above used to take away with the
      // accidental one. Choosing a revision is a whole navigation and
      // `showView` returns at once for the id already on screen, so on a build
      // with a single view a fetch that failed had no way back short of
      // reloading the page. `__retry` is the interface's Retry button.
      const vp = element({ views, view: 'a', buildKey: 'k1' }, null)
      vp.loadFailed = 'a.json'
      vp.load = vi.fn()
      vp.setState({ __retry: true })
      expect(vp.loadFailed).toBeNull()
      expect(vp.load).toHaveBeenCalledWith({ live: false })
      // Acted on and taken back out, like the other three imperative flags: left
      // in `state` it would read as a viewport permanently retrying.
      expect('__retry' in vp.state).toBe(false)
    })

    it('keeps the frame on a retry of the view that is on screen', () => {
      // A LIVE SWAP WHOSE FETCH FAILED: the previous build is still standing
      // under the reader's camera, and the retry is the same view again, so
      // there is a frame worth carrying across.
      const vp = element({ views, view: 'a', buildKey: 'k2' })
      vp.view = 'a'
      vp.loadFailed = 'a.json'
      vp.load = vi.fn()
      vp.setState({ __retry: true })
      expect(vp.load).toHaveBeenCalledWith({ live: true })
    })

    it('does not, when what is on screen is a different view', () => {
      // A view SWITCH whose fetch failed. Keeping that camera would put the new
      // arrangement under a frame fitted to the old one, which is exactly what
      // an ordinary view change refuses to do.
      const vp = element({ views, view: 'b', buildKey: 'k1' })
      vp.view = 'a'
      vp.loadFailed = 'b.json'
      vp.load = vi.fn()
      vp.setState({ __retry: true })
      expect(vp.load).toHaveBeenCalledWith({ live: false })
    })
  })
})

describe('show', () => {
  const views = [{ id: 'a', file: 'a.json' }]


  /** A `show()` that runs to the END, and the only one in this file.
   *
   * Every other test here stops at one of the early exits, because the loader is
   * mocked into throwing — right for them, and useless for the one question
   * below: IS THE HATCH REACHED AT ALL. Nothing else can ask it. The hatch is
   * applied on exactly one line, on the far side of `render()`, and a viewport
   * that stopped calling it renders a perfect page with a flat fill where the
   * cut should be hatched — no error, no warning, nothing to notice.
   *
   * `new Viewer(...)` handing back a prepared object is not a trick: a
   * constructor that returns an object returns that object, which is what lets
   * the real pipeline run against `fakeViewer()` — the same fake `internals()`,
   * `reconcile()` and the whole section suite already drive. Only the two
   * methods `show()` itself calls are added on top of it.
   */
  function rendering() {
    const viewer = fakeViewer()
    viewer.render = vi.fn()
    viewer.resizeCadView = vi.fn()
    // THE UNDO IS REGISTERED BY THE FUNCTION THAT FILLS THE QUEUE, before it
    // fills it. `vi.clearAllMocks` (the beforeEach at the top of this file)
    // clears CALLS and not queued implementations, so a `mockImplementationOnce`
    // that nothing consumed — a test that failed before reaching `show`, or one
    // added later that stops calling it — is taken by whichever test runs NEXT,
    // which then silently drives a library that loads instead of one that
    // throws. `onTestFinished` runs per test at the point of use, so the cleanup
    // cannot be separated from what it cleans up and no test's safety depends on
    // which test sits after it in the file. An `afterEach` elsewhere in the
    // describe would do the same job while being exactly that: positional.
    onTestFinished(() => loadViewerLibrary.mockReset())
    loadViewerLibrary.mockImplementationOnce(async () => ({
      Viewer: function Viewer() { return viewer },
      Display: function Display() {},
    }))
    const vp = element({ views, view: 'a' }, null)
    // What `connectedCallback` would have set. The box carries no
    // `.tcv_cad_viewer`, so `measureChrome` returns before touching a layout
    // jsdom does not compute.
    vp.box = document.createElement('div')
    vp.chrome = [0, 0]
    return { vp, viewer }
  }

  it('hatches the cut faces of the scene it has just rendered', async () => {
    const { vp, viewer } = rendering()
    await vp.show({ parts: [] }, { view: 'a', token: 0 })

    // It really reached the end — the model event, not the error panel. Without
    // this the assertions below could all hold on a `show()` that threw before
    // the hatch and told the reader so.
    const types = vp.dispatchEvent.mock.calls.map(([event]) => event.type)
    expect(types).toContain(EVENT_MODEL)
    expect(types).not.toContain(EVENT_ERROR)
    expect(vp.loadFailed).toBeNull()

    // The guarded entry point, once, on THIS scene's internals — carrying the
    // checkbox's current answer, so a scene never renders hatched against the
    // reader's setting.
    expect(safeHatch).toHaveBeenCalledTimes(1)
    expect(safeHatch.mock.calls[0][0].clipping).toBe(viewer.clipping)
    expect(safeHatch.mock.calls[0][1]).toBe(vp.state.cutHatch)
    // ...and AFTER `render()`, which is the whole of when it is possible: the
    // library builds the cap meshes in there and throws them away on `clear()`,
    // so the same call one line earlier would patch nothing and say nothing.
    expect(safeHatch.mock.invocationCallOrder[0])
      .toBeGreaterThan(viewer.render.mock.invocationCallOrder[0])
  })

  it('renders a scene unhatched when the box is unticked', async () => {
    // The flag is the point of the wire: without it the viewport would hatch
    // every cut face whatever the section popover says.
    const { vp, viewer } = rendering()
    vp.state = { ...vp.state, cutHatch: false }
    await vp.show({ parts: [] }, { view: 'a', token: 0 })

    const types = vp.dispatchEvent.mock.calls.map(([event]) => event.type)
    expect(types).toContain(EVENT_MODEL)
    expect(safeHatch).toHaveBeenCalledTimes(1)
    expect(safeHatch.mock.calls[0][0].clipping).toBe(viewer.clipping)
    expect(safeHatch.mock.calls[0][1]).toBe(false)
  })

  it('colours each cut face with the part it cuts', async () => {
    // THE FEATURE, and the only place anything can check it: the flag is handed
    // to the library and everything it does with it is on a GPU. Asserted on the
    // options object that REACHES `render()` rather than on the constant in
    // options.js, so it covers the delivery as well as the value — a `render`
    // that stopped being given `viewerOptions` would pass a pin on the constant.
    //
    // What is lost without it is not subtle. The library's default colours a cap
    // by `PLANE_COLORS[theme][index]` — by WHICH CLIP PLANE cut it — so every
    // cut this viewport makes comes back the same red, and a plate, a post and a
    // cap read as one material, which is the one thing a section drawing is for.
    // The hatch inherits the same loss: its ink is mixed from `diffuse`, which is
    // the cap's colour, so the lines would go red with the fill.
    const { vp, viewer } = rendering()
    await vp.show({ parts: [] }, { view: 'a', token: 0 })

    expect(viewer.render).toHaveBeenCalledTimes(1)
    const [, , options] = viewer.render.mock.calls[0]
    expect(options.clipObjectColors).toBe(true)
  })

  it('undoes the loader it queued, with nothing in the test doing it by hand', () => {
    // THE MINE AND ITS UNDO, in one test and without ordering: `rendering()`
    // queues a one-shot implementation, and this deliberately never calls
    // `show()` — exactly what a test that failed early would leave behind.
    //
    // The assertion is registered BEFORE `rendering()` on purpose. Vitest runs
    // `onTestFinished` hooks in REVERSE registration order (verified, not
    // assumed), so the helper's own undo — registered second — runs first, and
    // this then observes whatever it left. That is what makes this test execute
    // the real cleanup instead of a copy of it: calling `mockReset()` here by
    // hand would have proved only that vitest's `mockReset` works.
    //
    // Both failures it catches are silent and both land in an unrelated test: a
    // cleanup that never ran leaves a loader that LOADS, and a `mockClear` in
    // place of `mockReset` leaves the queue untouched while looking like tidying.
    onTestFinished(() => expect(loadViewerLibrary()).rejects.toThrow('no library here'))
    rendering()
  })

  it('says so when the payload is not a model at all', async () => {
    // A view file that parsed into a JSON scalar. This exit used to say nothing,
    // and silence costs both halves of block 11 at once: no `hmr:error`, so the
    // interface's panel is never drawn, and no `loadFailed`, so the next
    // `hmr:state` — one arrives on every click in the tree — fetches it again.
    const vp = element({ views, view: 'a' }, null)
    await vp.show(42, { view: 'a', token: 0 })
    const event = emitted(vp)
    expect(event.type).toBe(EVENT_ERROR)
    expect(event.detail.stage).toBe('render')
    expect(event.detail.view).toBe('a')

    vp.load = vi.fn()
    vp.setState({ hidden: ['/Group/a'] })
    expect(vp.load).not.toHaveBeenCalled()
  })

  it('remembers a render failure even for a view with no name', async () => {
    // `loadFailed` is only ever READ as a yes/no, and the name it stores is
    // perfectly able to be null: a build whose views carry no `id`, on an
    // element that has not settled one either. Storing that null switches the
    // guard off at the one moment it is there for — so this stores `true`,
    // exactly as the no-file exit in `load` does.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const vp = element({ views: [{ id: null, file: 'a.json' }], view: 'a' }, null)
    await vp.show({ parts: [] }, { view: null, token: 0 })
    expect(vp.loadFailed).toBe(true)
    expect(emitted(vp).detail.stage).toBe('render')

    vp.load = vi.fn()
    vp.setState({ hidden: ['/Group/a'] })
    expect(vp.load).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})

describe('the widgets connectedCallback puts on the page', () => {
  // THE ELEMENT IS REALLY UPGRADED HERE, and this is the only block in the file
  // that does it. Nothing on this path reaches the library: `connectedCallback`
  // builds the container, the overlay and the view cube, and the viewer itself
  // is not constructed until `show()`.
  //
  // WHAT IT IS FOR: nothing else, anywhere, notices whether the cube is mounted.
  // Deleting the two lines in `element.js` that create and append it left every
  // JS and Python test green with the widget simply absent from the page. The
  // module sets NO class name on its root — a deliberate decision with reasons
  // of its own — and that also opts it out of
  // `test_every_class_the_viewport_sets_is_styled_here`, which was the one
  // mechanism that would otherwise have caught it.
  //
  // `ResizeObserver` is the one thing jsdom does not have and the element does
  // use; it is stubbed, exactly as live.test.js stubs it, because what it
  // observes here is a box that never resizes.
  beforeEach(() => {
    // The element reads a remembered pointing device on boot, and there is no
    // localStorage in this environment; the read is guarded, so all that reaches
    // the test is the warning.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
  })

  afterEach(async () => {
    // `disconnectedCallback` defers its teardown by a microtask — it has to,
    // since a React move is a removal followed by an insertion — so the flush is
    // part of the cleanup rather than an optimisation.
    document.body.innerHTML = ''
    await Promise.resolve()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const mount = () => {
    const el = document.createElement(TAG)
    document.body.appendChild(el)
    return el
  }

  /** The cube's root, found the ONE way anything outside the module can find
   *  it: its placement. It carries no class name on purpose — see the comment
   *  at the top of createViewCube — so there is nothing else to match on. */
  const cubeIn = (el) => [...el.children].find(
    (child) => child.style.left === '16px' && child.style.bottom === '14px')

  it('mounts the view cube, after the overlay', () => {
    const el = mount()
    const cube = cubeIn(el)
    expect(cube).toBeTruthy()
    expect(cube.querySelector('svg')).toBeTruthy()
    // AFTER the overlay, so a cell stays clickable where a pin happens to be
    // over the same corner: the overlay's layer covers the whole canvas, and the
    // later sibling is the one that gets the press.
    const kids = [...el.children]
    expect(kids.indexOf(cube))
      .toBeGreaterThan(kids.findIndex((c) => c.className === 'hmr_overlay'))
  })

  it('takes it down again when the element leaves the document', () => {
    // Not merely tidiness: the cube owns a rAF loop, and one left running holds
    // the element, its `vp` and the scene behind it for the life of the page.
    const el = mount()
    expect(cubeIn(el)).toBeTruthy()
    el.destroy()
    expect(cubeIn(el)).toBeUndefined()
    expect(el.querySelector('svg')).toBeNull()
  })
})

describe('activeTool', () => {
  it('is the hold key while it is down, whatever the interface asked for', () => {
    const vp = element({ tool: 'measure' })
    vp.holdActive = true
    expect(vp.activeTool).toBe('cut')
  })

  it('falls back to the interface\'s tool, and to null rather than to ""', () => {
    const vp = element({ tool: 'measure' })
    vp.holdActive = false
    expect(vp.activeTool).toBe('measure')
    vp.state = { ...vp.state, tool: '' }
    expect(vp.activeTool).toBeNull()
  })
})
