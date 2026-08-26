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
// read. `load()` and `show()` are left out for the same reason — they fetch a
// view file and build the widget out of it, which is the half that needs the
// library — and `load` is stubbed wherever a test only cares that it was
// reached.
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

import { HmrViewport } from '../src/viewport/element.js'
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
  vp.overlay = { setPins: vi.fn(), refresh: vi.fn() }
  return vp
}

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
