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
  // Like the four above it: what this file asks is whether a re-stage reaches
  // it at all, because that is a decision `show` makes and nothing else can be
  // asked about from here. What it DOES to a scene's groups — re-offsetting
  // every moved part onto the ones `render()` just built — is parts.test.js's
  // subject, against the real module.
  restageMoves: vi.fn(),
  statesOf: vi.fn(() => ({})),
  treeFromShapes: vi.fn(() => ({})),
}))

vi.mock('../src/viewport/section.js', () => ({
  applySection: vi.fn(),
  keepSectionCut: vi.fn(),
  suspendSectionCut: vi.fn(),
  // NOT REACHED FROM element.js AT ALL — `live.js` imports these two, and
  // `live.js` is deliberately the real thing here. A LIVE show is what
  // `restage()` performs, so leaving them off the factory makes them
  // `undefined`, `captureLive` throws where nothing catches it but `show`'s own
  // `try`, and every re-stage turns into block 11's error panel. What they DO
  // with a scene is section.test.js's subject, against the real module.
  captureSection: vi.fn(() => null),
  restoreSection: vi.fn(),
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
  applyGhost, applyHidden, applySelected, resetMoves, restageMoves,
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
  // The two sources a scene is made of, as `connectedCallback` starts them.
  // `payload` is `null` and not `undefined` on purpose: it is the field that
  // says whether there is anything to re-stage, and a helper that left it off
  // would let a test assert the right thing about the wrong absence.
  vp.payload = null
  vp.overlayParts = []
  vp.overlay = { setPins: vi.fn(), refresh: vi.fn() }
  // The section handle draws itself from `sectionSeed` and a rAF loop of its
  // own; here it is a stub for the same reason the overlay is one. What
  // `reconcile` owes it is the wake-up, and what `show` owes it is the end of a
  // drag — both are asked about below.
  vp.handle = { refresh: vi.fn(), endDrag: vi.fn() }
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

  it('wakes the section handle on every pass', () => {
    // THE ONLY CALLER OF `refresh` ANYWHERE. The handle's rAF loop stops itself
    // whenever there is no cut, so this line is what starts it again when one
    // appears — delete it and there is no grip on any plane, ever, with the
    // whole suite still green. Every pass, and not only when the cut changed:
    // the loop is what draws, and re-arming an already-running one costs a
    // boolean.
    const vp = element({ cut: true })
    vp.reconcile()
    vp.reconcile()
    expect(vp.handle.refresh).toHaveBeenCalledTimes(2)
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

  it('ends a drag of the section handle before it replaces the scene', async () => {
    // The grip's press lands on a layer that is a sibling of `vp.box`, so
    // neither `endGesture` nor the idle clock that defers this swap ever sees
    // it: without this call a reader holding the arrow when a build lands keeps
    // dragging against a scene that is gone, and the depth the interface prints
    // stops matching the plane. BEFORE `render()` is the whole of it — the
    // gesture has to conclude against the scene it was measured on.
    const { vp, viewer } = rendering()
    await vp.show({ parts: [] }, { view: 'a', token: 0 })

    const types = vp.dispatchEvent.mock.calls.map(([event]) => event.type)
    expect(types).toContain(EVENT_MODEL)
    expect(vp.handle.endDrag).toHaveBeenCalledTimes(1)
    expect(vp.handle.endDrag.mock.invocationCallOrder[0])
      .toBeLessThan(viewer.render.mock.invocationCallOrder[0])
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

describe('the overlay laid over the model', () => {
  // THE SECOND SOURCE OF PARTS: a rough body the sketch panel assembled in the
  // browser (ui/src/sketchgeom.js), which belongs to no build and is fetched
  // from nowhere. Everything here is about the one property that cannot be read
  // off the source — that the two sources are composed in ONE place, so a
  // rebuild landing under an open panel puts the overlay back without anybody
  // asking it to.
  //
  // The whole pipeline runs, exactly as the `show` block above runs it once: the
  // loader is given a working implementation for the length of the test, because
  // a re-stage is a SECOND render and there is no way to ask about the second
  // one without reaching the first.
  const views = [{ id: 'a', file: 'a.json' }]

  /** A part in the shape `buildSketch` hands over: a name, a colour, a mesh. */
  const body = (name) => ({
    id: `/sketch/${name}`,
    type: 'shapes',
    subtype: 'solid',
    name,
    color: '#9aa3ad',
    alpha: 1,
    state: [1, 1],
    loc: [[0, 0, 0], [0, 0, 0, 1]],
    shape: { vertices: [], triangles: [], normals: [], edges: [], obj_vertices: [] },
  })

  /** A view document in the shape the hub publishes one. */
  const model = (...parts) => ({
    version: 3,
    name: 'Group',
    id: '/Group',
    loc: [[0, 0, 0], [0, 0, 0, 1]],
    bb: { xmin: 0, xmax: 1, ymin: 0, ymax: 1, zmin: 0, zmax: 1 },
    normal_len: 0,
    parts: (parts.length ? parts : ['plate'])
      .map((part) => ({ ...body(part), id: `/Group/${part}` })),
  })

  /**
   * What a `render()` call was given, read at both storeys.
   *
   * `names` and `ids` are the ROOT's own children — where the model's parts sit
   * and where the overlay's group sits beside them — and `sketch` is that group,
   * `undefined` when there is no overlay at all. Two storeys because the
   * composition now has two: the bodies hang under a group of their own so that
   * a mock named after the part it mocks cannot take that part's path.
   */
  const rendered = (viewer, nth = -1) => {
    const calls = viewer.render.mock.calls
    const [scene] = calls.at(nth)
    const sketch = scene.parts.find((part) => Array.isArray(part.parts))
    return {
      scene,
      sketch,
      names: scene.parts.map((part) => part.name),
      ids: scene.parts.map((part) => part.id),
      bodies: sketch ? sketch.parts.map((part) => part.name) : [],
      bodyIds: sketch ? sketch.parts.map((part) => part.id) : [],
    }
  }

  /**
   * A viewport whose library LOADS, for as many renders as the test asks for.
   *
   * `rendering()` in the block above queues one implementation because one
   * render is all it needs; here the subject is the second and the third, so the
   * implementation stands for the test and is reset at the end of it — the same
   * `onTestFinished` arrangement, and for the same reason: a queued loader that
   * nothing consumed is a mine for whichever test runs next.
   *
   * `clear` and `getCameraLocationSettings` are added on top of `fakeViewer()`
   * for the two things a re-stage does that a first render does not: it replaces
   * a scene that is already there, and it carries the reader's frame across.
   */
  function staging() {
    const viewer = fakeViewer()
    viewer.render = vi.fn()
    viewer.resizeCadView = vi.fn()
    viewer.clear = vi.fn()
    viewer.getCameraLocationSettings = () => ({
      position: [1, 2, 3], quaternion: [0, 0, 0, 1], target: [0, 0, 0], zoom: 2,
    })
    onTestFinished(() => loadViewerLibrary.mockReset())
    loadViewerLibrary.mockImplementation(async () => ({
      Viewer: function Viewer() { return viewer },
      Display: function Display() {},
    }))
    const vp = element({ views, view: 'a', base: '/project/p/dev/' }, null)
    vp.box = document.createElement('div')
    vp.chrome = [0, 0]
    return { vp, viewer }
  }

  it('lays its parts beside the model\'s own, in one document', async () => {
    const { vp, viewer } = staging()
    await vp.show(model(), { view: 'a', token: 0 })
    expect(rendered(viewer).names).toEqual(['plate'])

    await vp.setOverlay([body('result'), body('krepezh1')])

    expect(viewer.render).toHaveBeenCalledTimes(2)
    // UNDER A GROUP OF THEIR OWN, which is the one storey between them and the
    // model's parts. The library descends into anything carrying `parts`
    // (`isShapeTree`), so this is the shape a pushed view file already uses for
    // the model's own groups — and it is what makes a name collision below
    // impossible rather than unlikely.
    expect(rendered(viewer).names).toEqual(['plate', 'sketch'])
    expect(rendered(viewer).bodies).toEqual(['result', 'krepezh1'])
    // A group answers for no catalogue record, which is the rule
    // `treeFromShapes` keeps and the reason it puts a `key` on leaves only.
    expect('key' in rendered(viewer).sketch).toBe(false)
  })

  it('cannot take a model part\'s path, however the bodies are named', async () => {
    // NAMING A MOCK AFTER THE THING IT MOCKS IS THE POINT of the panel — the
    // motor the bracket has to clear, the wall it bolts to — so a body called
    // `post` over a model that has a `post` is the expected case and not an edge
    // one. Flat beside the model's parts the two shared `/Group/post`: one entry
    // in `nestedGroup.groups`, one row in the tree, one path in the measurement
    // backend, and the real part's eye hiding the sketch body instead of it.
    const { vp, viewer } = staging()
    await vp.show(model('post'), { view: 'a', token: 0 })

    await vp.setOverlay([body('post')])

    expect(rendered(viewer).ids).toEqual(['/Group/post', '/Group/sketch'])
    expect(rendered(viewer).bodyIds).toEqual(['/Group/sketch/post'])

    // AND THE TREE SAYS THE SAME, which is the half that decides it: every path
    // the interface sends back in `hidden`, `ghost` and `selected` is spelled by
    // the walk and not by the id. The REAL `treeFromShapes` — this file mocks it
    // for every other question — because agreeing with it is the whole point of
    // the surgery, and a mock cannot disagree with anything.
    const { treeFromShapes: walk } = await vi.importActual('../src/viewport/parts.js')
    const tree = walk(rendered(viewer).scene, null)
    expect(tree.children.map((row) => row.id)).toEqual(['/Group/post', '/Group/sketch'])
    expect(tree.children[1].children.map((row) => row.id))
      .toEqual(['/Group/sketch/post'])
    // The group is a group to the walk as well — no `key`, and children rather
    // than a leaf's `known`.
    expect(tree.children[1].key).toBeUndefined()
  })

  it('steps aside for a model that has published a group of that name', async () => {
    // A model may legitimately call one of its own groups `sketch`. The overlay
    // takes the first free name instead of merging into it — the same "first
    // free" the panel mints param names by — so the collision above stays
    // impossible rather than merely unlikely.
    const { vp, viewer } = staging()
    await vp.show(model('sketch', 'sketch2'), { view: 'a', token: 0 })

    await vp.setOverlay([body('result')])

    expect(rendered(viewer).names).toEqual(['sketch', 'sketch2', 'sketch3'])
    expect(rendered(viewer).bodyIds).toEqual(['/Group/sketch3/result'])
  })

  it('tells its own bodies from the model\'s parts when the interface asks', async () => {
    // WHAT THE INTERFACE CANNOT WORK OUT FOR ITSELF. It refuses the Comment tool
    // a body of the sketch — a task filed in the build's terms about a body that
    // is in no build — and reads the same answer to tell a drag of a mock, which
    // edits the panel's document, from a drag of a part, which files one. All
    // either tool carries is a path. The group's name is minted HERE, against
    // the model's own parts, so a model that publishes a `sketch` of its own is
    // exactly the case a `sketch|sketch2` match over paths would answer wrongly:
    // `/Group/sketch/post` is that model's own part, and the overlay is next
    // door under `sketch2`.
    const { vp } = staging()
    await vp.show(model('sketch'), { view: 'a', token: 0 })

    // Nothing is staged yet, so nothing on screen is the overlay's.
    expect(vp.isOverlay('/Group/sketch2/result')).toBe(false)

    await vp.setOverlay([body('result')])

    expect(vp.isOverlay('/Group/sketch2/result')).toBe(true)
    expect(vp.isOverlay('/Group/sketch/post')).toBe(false)
    expect(vp.isOverlay('/Group/post')).toBe(false)
    // THE GROUP ITSELF COUNTS, and "nothing picks it in the scene" is only half
    // the doors: it is a ROW OF THE TREE, a row is selected with the mouse, and
    // the selection the interface sends is the node's own id. Selected, it heads
    // a measurement's comment `sketch` — the same task about a body in no build
    // that one of its children would be.
    expect(vp.isOverlay('/Group/sketch2')).toBe(true)
    // AND THE BOUNDARY IT SITS ON, because the lazy spelling of the line above
    // — `startsWith(at)`, no separator and no equality — passes every other
    // assertion in this file while claiming a model part honestly called
    // `sketch2x` for the overlay, and dragging it as a body of the sketch.
    expect(vp.isOverlay('/Group/sketch2x')).toBe(false)
  })

  it('names the body a path is, which is what the panel can find a node by', async () => {
    // ONE SEGMENT FURTHER IN than the question above, and the Move tool is what
    // asks it: a drag of a mock reaches the panel as `hmr:sketchmove` naming the
    // BODY, because the sketch document holds bodies by name and has no paths in
    // it at all. The name is the part's own `name` in the payload the panel
    // built, and the group it hangs under is minted here — so this is the only
    // side that can spell the pair.
    const { vp } = staging()
    await vp.show(model('sketch'), { view: 'a', token: 0 })
    await vp.setOverlay([body('result'), body('bore')])

    expect(vp.overlayBody('/Group/sketch2/result')).toBe('result')
    expect(vp.overlayBody('/Group/sketch2/bore')).toBe('bore')
    // Nothing of the model's is a body of it, whatever it is called.
    expect(vp.overlayBody('/Group/sketch/post')).toBeNull()
    // AND NEITHER IS THE GROUP, which is the decision rather than the edge case:
    // it is a row of the tree and can be selected and dragged from empty space,
    // but it stands for no node — a report naming `sketch2` would move nothing
    // and leave the mock displaced with the document saying otherwise. Refused
    // at the press instead (viewport/tools.js).
    expect(vp.overlayBody('/Group/sketch2')).toBeNull()
  })

  it('is holding the NEW document by the time a concluded gesture reports', async () => {
    // WHAT THE DEFERRED REPORT IN `tools.js` LEANS ON, and the reason it is
    // deferred at all. `show()` calls `endGesture()` — the way a drag the reader
    // has not let go of is ended when a build lands under it — AFTER its only
    // `await` and BEFORE `this.payload = shapes`, which is deliberately the last
    // thing a successful render does. A sketch drag's report comes back in
    // through `setOverlay` and `restage()`, and `restage()` renders
    // `this.payload`: raised synchronously from in there it would compose the
    // moved body into the document being REPLACED, wait on its own `await` while
    // this render finished, and then repaint the previous build and write its
    // payload back — under the same load token, so nothing notices, and the
    // reader is left on the old build with no reload coming.
    //
    // ONE MICROTASK IS THE WHOLE FIX, and this line is what makes it one: by the
    // time a microtask queued from `endGesture` runs, the payload is the new
    // build's. An `await` added between those two points would take that away
    // silently.
    const { vp } = staging()
    await vp.show(model('plate'), { view: 'a', token: 0 })
    await vp.setOverlay([body('result')])

    let seen = 'nothing ran at all'
    vp.endGesture = () => queueMicrotask(() => { seen = vp.payload })
    const next = model('plate', 'post')

    await vp.show(next, { view: 'a', token: 0 })
    await Promise.resolve()

    expect(seen).toBe(next)
  })

  it('is still on screen after the model under it has been fetched again', async () => {
    // THE ASSERTION THE `load()` DOCSTRING'S WARNING IS ABOUT, and the reason
    // the composition lives inside `show` rather than at its call sites. A `dev`
    // slot rebuilds under a reader with the panel open perhaps once a minute;
    // an overlay re-applied by the CALLER remembering to is an overlay that
    // vanishes on the one event nobody is watching for, with nothing thrown and
    // nothing logged. Driven through the real `load()` — a fetch and all —
    // because that is the path a rebuild takes.
    const { vp, viewer } = staging()
    await vp.show(model(), { view: 'a', token: 0 })
    await vp.setOverlay([body('result')])
    expect(rendered(viewer).bodies).toEqual(['result'])

    const next = model('post')
    const fetching = vi.fn(async () => ({ ok: true, json: async () => next }))
    vi.stubGlobal('fetch', fetching)
    onTestFinished(() => vi.unstubAllGlobals())

    await vp.load({ live: true })

    expect(fetching).toHaveBeenCalledWith('/project/p/dev/a.json', undefined)
    expect(rendered(viewer).names).toEqual(['post', 'sketch'])
    expect(rendered(viewer).bodies).toEqual(['result'])
  })

  it('keys each part by where it sits in the tree, not by the id it arrived with', async () => {
    // The library keys `nestedGroup.groups` and the picker's `solidPath` by a
    // part's own `id`; its navigation tree — and so `getStates`, and so every
    // path the interface sends back in `hidden`, `ghost` and `selected` — by
    // where the part sits. In a pushed view file those are the same string. An
    // overlay built elsewhere carries `/sketch/result`, and left alone it
    // renders perfectly while ghosting and selecting it do nothing at all.
    const { vp, viewer } = staging()
    await vp.show(model(), { view: 'a', token: 0 })

    const part = body('result')
    await vp.setOverlay([part])

    expect(rendered(viewer).bodyIds).toEqual(['/Group/sketch/result'])
    // ...and the caller's own object is left as it was: the interface holds the
    // parts it built and hands the same array over on the next commit.
    expect(part.id).toBe('/sketch/result')
  })

  it('composes from the document as it arrived, not from the last thing shown', async () => {
    // A stage that fed its own output back in would grow the scene by one copy
    // of the overlay per edit — the sort of defect that looks like nothing at
    // all for the first few of them.
    const { vp, viewer } = staging()
    await vp.show(model(), { view: 'a', token: 0 })

    await vp.setOverlay([body('result')])
    await vp.setOverlay([body('result'), body('bore')])
    await vp.setOverlay([body('result')])

    expect(rendered(viewer).names).toEqual(['plate', 'sketch'])
    expect(rendered(viewer).bodies).toEqual(['result'])
    expect(vp.payload.parts.map((part) => part.name)).toEqual(['plate'])
  })

  it('does not stage an overlay that is already on the screen', async () => {
    // A STAGE IS A WHOLE SCENE: `clear()` disposes every geometry and every
    // material, `render()` builds them again, and the tree goes up to React
    // behind it. The panel really does ask for this — it sets an empty overlay
    // over an empty one every time it opens on a document nothing has been put
    // in yet, and again every time it closes — so the answer to "the same thing
    // you already have" has to be no work at all rather than a cheap render.
    const { vp, viewer } = staging()
    await vp.show(model(), { view: 'a', token: 0 })
    expect(viewer.render).toHaveBeenCalledTimes(1)

    // Nothing over nothing.
    await vp.setOverlay([])
    await vp.clearOverlay()
    expect(viewer.render).toHaveBeenCalledTimes(1)

    await vp.setOverlay([body('result')])
    expect(viewer.render).toHaveBeenCalledTimes(2)

    // The same bodies again, rebuilt from a document that came out the same —
    // fresh objects, so this is a comparison by VALUE and not by identity.
    await vp.setOverlay([body('result')])
    expect(viewer.render).toHaveBeenCalledTimes(2)

    // ...and a body that really did change is not mistaken for one that did not.
    const moved = body('result')
    moved.loc = [[0, 0, 5], [0, 0, 0, 1]]
    await vp.setOverlay([moved])
    expect(viewer.render).toHaveBeenCalledTimes(3)
  })

  it('goes away again on clearOverlay, and takes nothing of the model with it', async () => {
    const { vp, viewer } = staging()
    await vp.show(model(), { view: 'a', token: 0 })
    await vp.setOverlay([body('result')])

    await vp.clearOverlay()

    expect(rendered(viewer).names).toEqual(['plate'])
    expect(rendered(viewer).scene).toBe(vp.payload)
  })

  it('remembers nothing of a document that failed to render', async () => {
    // Otherwise `setOverlay` would hand the same unrenderable document back to
    // the library once per keystroke, and every one of those draws block 11's
    // panel over a page that is already showing it. The loader here is the
    // file's default — the one that throws — so this is the real failure path.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => vi.restoreAllMocks())
    const vp = element({ views, view: 'a' }, null)

    await vp.show(model(), { view: 'a', token: 0 })
    expect(vp.payload).toBeNull()
    const said = () => vp.dispatchEvent.mock.calls
      .filter(([event]) => event.type === EVENT_ERROR).length
    expect(said()).toBe(1)

    await vp.setOverlay([body('result')])

    expect(said()).toBe(1)
  })

  it('is remembered when it is set before any view has landed', async () => {
    // The panel is open and the reader picks another revision: the overlay is
    // set against a viewport with nothing in it, and the load that follows is
    // what has to carry it.
    const { vp, viewer } = staging()
    await vp.setOverlay([body('result')])
    expect(viewer.render).not.toHaveBeenCalled()

    await vp.show(model(), { view: 'a', token: 0 })

    expect(rendered(viewer).names).toEqual(['plate', 'sketch'])
    expect(rendered(viewer).bodies).toEqual(['result'])
  })

  it('re-stages live, so the frame and the tree the reader set survive an edit', async () => {
    // An edit to the sketch is not a new view: the reader is looking at one
    // thing from one angle and changing a number. A stage that re-fitted the
    // camera would move the model on every keystroke.
    const { vp, viewer } = staging()
    await vp.show(model(), { view: 'a', token: 0 })
    vi.clearAllMocks()

    await vp.setOverlay([body('result')])

    expect(viewer.setStates).toHaveBeenCalledTimes(1)
    expect(viewer.locationCalls).toEqual([{
      position: [1, 2, 3], quaternion: [0, 0, 0, 1], target: [0, 0, 0],
      zoom: 2, notify: false,
    }])
    const model_ = vp.dispatchEvent.mock.calls
      .map(([event]) => event).find((event) => event.type === EVENT_MODEL)
    expect(model_.detail.live).toBe(true)
    // The view it is a stage OF, so the interface is not told the reader
    // switched tabs every time they commit a digit.
    expect(model_.detail.view).toBe('a')
    // AND IT SAYS IT IS A RE-STAGE, which `live` cannot: a rebuild landing
    // under the reader's camera is live too, and the interface spends the
    // difference — `onModel` drops the measurement and the drag on a model
    // event and must not on this one.
    expect(model_.detail.restage).toBe(true)
  })

  it('does not say re-stage about a load, which is where the chips are right to go', async () => {
    const { vp, viewer } = staging()
    await vp.show(model(), { view: 'a', token: 0 })
    const said = () => vp.dispatchEvent.mock.calls.map(([event]) => event)
      .filter((event) => event.type === EVENT_MODEL).at(-1).detail.restage
    expect(said()).toBe(false)
    expect(viewer.render).toHaveBeenCalledTimes(1)
  })

  it('leaves the measurement and the moved part where the reader put them', async () => {
    // THE DEFECT THIS BLOCK EXISTS FOR MOST. A re-stage runs the whole of
    // `show`, and `show` clears the tape and the offsets on the way through —
    // right for a rebuild, where every part goes back to where the model puts it
    // (ui-brief block 6) and a distance was measured between faces that may be
    // gone, and wrong for a scene composed out of the document already on
    // screen. Left in, opening the sketch panel — or closing it, or committing
    // one digit into it — snapped a dragged part home and dropped a live
    // measurement, with `partHome` gone so the move could not even be undone.
    const { vp } = staging()
    await vp.show(model(), { view: 'a', token: 0 })
    vp.measurePicks = [{ path: '/Group/plate/faces/face_0' }]
    vp.measureLabel = { text: '2.4 mm', point: [0, 0, 0] }
    vp.moved.set('/Group/plate', [0, 0, 3])
    vp.partHome.set('/Group/plate', [0, 0, 0])

    await vp.setOverlay([body('result')])

    expect(vp.measurePicks).toHaveLength(1)
    expect(vp.measureLabel.text).toBe('2.4 mm')
    expect([...vp.moved.entries()]).toEqual([['/Group/plate', [0, 0, 3]]])
    expect(vp.partHome.get('/Group/plate')).toEqual([0, 0, 0])
    // AND THE OFFSETS ARE PUT BACK ON THE SCENE, which is not the same thing as
    // keeping the map: `clear()` disposed the ObjectGroups the drag was written
    // on and `render()` built new ones at the model's own positions, so a map
    // that survived alone would describe a part standing exactly at home.
    expect(restageMoves).toHaveBeenCalledTimes(1)
    expect(restageMoves.mock.calls[0][0]).toBe(vp)
  })

  it('takes both away on a LOAD, which is a different model underneath', async () => {
    const { vp } = staging()
    await vp.show(model(), { view: 'a', token: 0 })
    vp.measurePicks = [{ path: '/Group/plate/faces/face_0' }]
    vp.measureLabel = { text: '2.4 mm', point: [0, 0, 0] }
    vp.moved.set('/Group/plate', [0, 0, 3])
    vp.partHome.set('/Group/plate', [0, 0, 0])

    await vp.show(model(), { view: 'a', token: 0 })

    expect(vp.measurePicks).toEqual([])
    expect(vp.measureLabel).toBeNull()
    expect(vp.moved.size).toBe(0)
    expect(vp.partHome.size).toBe(0)
    expect(restageMoves).not.toHaveBeenCalled()
  })

  it('does not take the load token off a fetch that is already on its way', async () => {
    // A bumped token would make an overlay edit typed during a fetch cancel the
    // build on its way to the screen — `show` refuses any token but the newest,
    // so the arriving model would be dropped with nothing said about it.
    const { vp, viewer } = staging()
    await vp.show(model(), { view: 'a', token: 0 })
    vp.loadToken = 7

    await vp.setOverlay([body('result')])

    expect(vp.loadToken).toBe(7)
    expect(rendered(viewer).bodies).toEqual(['result'])
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

  /** The section grip's layer, found by the one thing distinctive about it: it
   *  holds the arrow, and the arrow is the only element the viewport puts on
   *  the page offering a grab cursor. Like the cube, it carries no class name,
   *  which is what keeps it out of the stylesheet check too. */
  const gripIn = (el) => [...el.children].find(
    (child) => child.firstElementChild
      && child.firstElementChild.style.cursor === 'grab')

  it('mounts the section grip, after the view cube', () => {
    // The same hole the cube's test above was written for, and the same reason
    // it has to be closed here: delete the two lines in `element.js` that
    // create and append the grip and nothing anywhere else goes red — the
    // handle simply is not on the page, and the drag it advertises goes back to
    // being a gesture only the initiated know about.
    const el = mount()
    const grip = gripIn(el)
    expect(grip).toBeTruthy()

    // AFTER the cube, so the live grip wins where the two overlap: the grip's
    // layer covers the whole canvas and the cube sits in one corner of it, and
    // the later sibling is the one that takes the press.
    const kids = [...el.children]
    expect(kids.indexOf(grip)).toBeGreaterThan(kids.indexOf(cubeIn(el)))
  })

  it('takes the grip down too when the element leaves the document', () => {
    // Its rAF loop stops itself when there is no cut, but a page that never had
    // one still leaves the layer and its window listeners holding the element.
    const el = mount()
    expect(gripIn(el)).toBeTruthy()
    el.destroy()
    expect(gripIn(el)).toBeUndefined()
  })

  it('lets the remembered view document go with everything else', () => {
    // `show` keeps the fetched document so an overlay edit needs no second
    // fetch, which is a couple of megabytes of buffers with a field of this
    // element pointing at them. A detached element can sit in a React tree for a
    // while, and left standing that is a leak with no symptom short of a heap
    // snapshot — this element's own note about the payload used to say it kept
    // none, and that is exactly what changed.
    const el = mount()
    el.payload = { name: 'Group', parts: [] }
    el.overlayParts = [{ name: 'result' }]
    el.destroy()
    expect(el.payload).toBeNull()
    expect(el.overlayParts).toEqual([])
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
