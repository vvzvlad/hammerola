// <hmr-viewport> — the DIFFING, and nothing that needs a WebGL context.
//
// Two halves are under test and they are the two the element does on every
// keystroke somewhere in the interface: `setState`, which decides whether a
// patch is a reload, a live swap or an ordinary change, and `reconcile`, which
// brings the scene in line with `state` while writing as little as it can get
// away with.
//
// THE ELEMENT IS NEVER UPGRADED HERE. `connectedCallback` builds a real
// three-cad-viewer against a real canvas, and there is no GPU in a test runner;
// the instance below is the prototype with exactly the fields these two methods
// read. `show()` is left out for the same reason — it builds the widget out of a
// payload, which is the half that needs the library — and `load` is stubbed
// wherever a test only cares that it was reached.
//
// `load` ITSELF IS EXERCISED in one place, and only as far as it gets without
// the library: its two early exits, the view that names no file and the fetch
// that comes back 404. Both are about what the element REMEMBERS afterwards, and
// that memory is what stops the interface's next patch — one arrives on every
// click in the tree — from asking the hub for the same missing file again.
//
// The library calls are mocked, and this is the one file where that is the right
// answer rather than a shortcut: what is being asked is "was `applyHidden`
// called at all", and a real `applyHidden` would answer that only indirectly,
// through a scene. Each of those functions has its own tests in parts.test.js
// and section.test.js, against the real thing.

import { beforeEach, describe, expect, it, vi } from 'vitest'

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

// The library's own loader, replaced so `show()` can be driven as far as its
// FAILURE path — which is the only part of it that runs without a GPU. Nothing
// else here reaches it: every other test either stops before `show` or never
// gets past the fetch.
vi.mock('../src/viewport/library.js', () => ({
  loadViewerLibrary: vi.fn(async () => { throw new Error('no library here') }),
}))

import { HmrViewport } from '../src/viewport/element.js'
import { EVENT_ERROR } from '../src/viewport/events.js'
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
 * than null — the sentinel that makes the first reconcile clear a highlight the
 * library may have painted on its own.
 */
function element(state = {}, viewer = fakeViewer()) {
  const vp = Object.create(HmrViewport.prototype)
  vp.viewer = viewer
  vp.booted = true
  vp.state = {
    hidden: [], ghost: [], selected: null, camera: null,
    cut: false, cutOffset: 0, cutFlip: false, pins: [],
    base: null, views: [], view: null, buildKey: null, tool: null,
    ...state,
  }
  vp.applied = { hidden: null, ghost: null, selected: undefined, camera: null }
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
    // Even though the selection is null: `applied.selected` is `undefined` until
    // the first pass, so this is the call that clears whatever the library
    // highlighted on its own.
    expect(applySelected).toHaveBeenCalledWith(vp.viewer, null)
  })

  it('writes nothing on a second pass with the same state', () => {
    const vp = settled({ hidden: ['/Group/a'], selected: '/Group/b' })
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
    const vp = settled({ selected: '/Group/a' })
    vp.state = { ...vp.state, selected: null }
    vp.reconcile()
    expect(applySelected).toHaveBeenCalledWith(vp.viewer, null)
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
      vp.setState({ selected: '/Group/a' })
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
