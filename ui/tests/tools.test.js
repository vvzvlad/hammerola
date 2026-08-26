// What a press on the canvas MEANS — the one branch that decides it, and the
// one moment it is decided at.
//
// The branch is the reason `activeTool` exists. The hold key (holdkey.js) puts
// the cut up for as long as it is down WITHOUT writing to `state.tool`, because
// the interface owns that field and a momentary mode that edited it would leave
// the two disagreeing the moment a release went missing. So a press that read
// `state.tool` would take the plain-pick branch while the interface's own
// indicator — fed by `hmr:tool` — said a cut was armed. Nothing throws in that
// state and nothing is logged: the reader asks for a section and gets a
// selection.
//
// The moment matters as much as the branch. The tool is read ONCE, at
// pointerdown, and lives on `press` until the gesture ends, so letting the key
// go half-way through a drag cannot turn a cut that is already under way into
// something else.
//
// NO GPU HERE, and nothing that needs one is faked into existence:
// `internals()` is satisfied by the fake viewer, and the two calls a click ends
// in — `faceNormalAt` for the cut, `pickEntity` for the pick — are mocked,
// because WHICH of the two is reached is the whole question. The element's real
// `activeTool` getter is used rather than a stand-in: a fake that
// re-implemented it would let this file agree with itself instead of with the
// code.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Only the two the branch ends in are replaced; everything else in the module
// stays real, because measure.js imports from it too and a stubbed-out module
// would fail to load rather than fail a test.
vi.mock('../src/viewport/picking.js', async (importOriginal) => ({
  ...(await importOriginal()),
  faceNormalAt: vi.fn(() => null),
  pickEntity: vi.fn(() => null),
}))

import { HmrViewport } from '../src/viewport/element.js'
import { EVENT_FACE, EVENT_PICK } from '../src/viewport/events.js'
import { internals } from '../src/viewport/internals.js'
import { faceNormalAt, pickEntity } from '../src/viewport/picking.js'
import { placeSectionPlane, sectionOffset } from '../src/viewport/section.js'
import { installTools } from '../src/viewport/tools.js'
import { fakeViewer, fakeViewport } from './fakes.js'

const teardowns = []

/**
 * The viewport `installTools` is handed.
 *
 * Built on the real prototype so `activeTool` is the element's own getter. Two
 * of its fields are deliberately not the real thing:
 *
 *   * `box` hands its listener back instead of being a DOM node. `onDown`
 *     refuses any press whose `event.target` is not the library's canvas, and
 *     the fake canvas is not a node an event could be dispatched at;
 *   * `dispatchEvent` is a spy. The object's prototype chain reaches
 *     HTMLElement, but nothing built it through the DOM, so the inherited one
 *     would throw.
 */
function toolViewport(state = {}) {
  const viewer = fakeViewer()
  const vp = Object.create(HmrViewport.prototype)
  Object.assign(vp, fakeViewport(viewer, state))
  vp.holdActive = false
  vp.dispatchEvent = vi.fn()
  vp.box = {
    down: null,
    addEventListener(type, fn) { if (type === 'pointerdown') this.down = fn },
    removeEventListener() {},
  }
  teardowns.push(installTools(vp))
  return vp
}

/** A press on the canvas. The event is returned so a test can ask who got it. */
function pointerDown(vp, [clientX, clientY] = [100, 100]) {
  const event = {
    button: 0,
    target: vp.viewer.canvas,
    clientX,
    clientY,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  }
  vp.box.down(event)
  return event
}

/** The release. It goes to the WINDOW, which is where onDown put the listener. */
function pointerUp([clientX, clientY] = [100, 100]) {
  window.dispatchEvent(new MouseEvent('pointerup', { clientX, clientY }))
}

/** A drag, to the same place. Far enough to be past CLICK_PX. */
function pointerMove([clientX, clientY]) {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY }))
}

const emitted = (vp) => vp.dispatchEvent.mock.calls.map(([event]) => event.type)

beforeEach(() => { vi.clearAllMocks() })

afterEach(() => {
  // Before the next test dispatches on the window: a teardown left undone would
  // leave a dead viewport's capture-phase listeners there to answer for it.
  while (teardowns.length) teardowns.pop()()
})

describe('which branch a click takes', () => {
  it('cuts while the hold key is down, though the interface armed no tool', () => {
    const vp = toolViewport({ tool: null })
    vp.holdActive = true
    pointerDown(vp)
    pointerUp()
    expect(faceNormalAt).toHaveBeenCalledTimes(1)
    expect(pickEntity).not.toHaveBeenCalled()
    expect(emitted(vp)).not.toContain(EVENT_PICK)
  })

  it('picks when the key is not down and nothing else is armed', () => {
    const vp = toolViewport({ tool: null })
    pointerDown(vp)
    pointerUp()
    expect(pickEntity).toHaveBeenCalledTimes(1)
    expect(faceNormalAt).not.toHaveBeenCalled()
    // The background is an answer too — it is how a reader deselects.
    expect(emitted(vp)).toEqual([EVENT_PICK])
  })

  it('still honours the tool the interface armed', () => {
    // The hold key overrides `state.tool`; it does not replace it. With the key
    // up, `activeTool` has to be exactly what the interface asked for.
    const vp = toolViewport({ tool: 'measure' })
    pointerDown(vp)
    pointerUp()
    // A measure click on nothing clears the tape and redraws rather than
    // reporting a selection.
    expect(vp.overlay.refresh).toHaveBeenCalled()
    expect(emitted(vp)).not.toContain(EVENT_PICK)
  })

  it('keeps the cut for the whole gesture when the key goes up mid-press', () => {
    const vp = toolViewport({ tool: null })
    vp.holdActive = true
    pointerDown(vp)
    vp.holdActive = false
    pointerUp()
    expect(faceNormalAt).toHaveBeenCalledTimes(1)
    expect(pickEntity).not.toHaveBeenCalled()
  })
})

describe('who owns the press', () => {
  it('is taken from the trackball while the hold key is down', () => {
    // Otherwise the model rotates under the gesture: the library's own handler
    // runs after this capture-phase one and would start a rotation.
    const vp = toolViewport({ tool: null })
    vp.holdActive = true
    const event = pointerDown(vp)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalled()
    pointerUp()
  })

  it('is left with the trackball when no tool is in force', () => {
    // With nothing armed the press is only WATCHED, so a release that never
    // moved can be reported as a pick and the rotation stays the library's.
    const vp = toolViewport({ tool: null })
    const event = pointerDown(vp)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
    pointerUp()
  })
})

describe('where the section drag says the plane ended up', () => {
  /** A viewport with the cut tool armed and a plane already laid on a face, in
   *  an orientation the drag can actually move: the fake camera looks down -Z,
   *  and a normal along X is the one whose screen projection has not collapsed. */
  function cutting() {
    const vp = toolViewport({ tool: 'cut' })
    placeSectionPlane(vp, internals(vp.viewer), [1, 0, 0], [0, 0, 0])
    vp.sectionSeed.id = '/Group/wall'
    vp.sectionSeed.name = 'wall'
    vi.clearAllMocks()
    return vp
  }

  /** A press, a drag of 200 px along the plane's own screen axis. */
  const dragFrom = (vp) => {
    pointerDown(vp, [100, 100])
    pointerMove([300, 100])
  }

  it('is announced once, at the release', () => {
    const vp = cutting()
    // Nothing is written while the drag runs: the number the interface shows is
    // a readback, and sixty of them a second is a re-render per frame.
    dragFrom(vp)
    expect(vp.state.cutOffset).toBe(0)
    expect(emitted(vp)).not.toContain(EVENT_FACE)

    pointerUp([300, 100])
    expect(emitted(vp)).toContain(EVENT_FACE)
    expect(Math.abs(vp.state.cutOffset)).toBeGreaterThan(0.5)
    expect(vp.state.cutOffset).toBeCloseTo(sectionOffset(vp), 9)
  })

  it('is announced by a SWAP that ends the gesture too', () => {
    // `show()` ends a gesture the reader has not let go of, because everything
    // it holds was measured against the scene about to be torn down — and a swap
    // can arrive mid-drag, since the interface waits for the hand to come off
    // the model but gives up after a deadline. Ending the gesture without this
    // readback leaves `state.cutOffset` at the depth from BEFORE the drag: the
    // plane still lands right, because the restore subtracts that same stale
    // number and the seed absorbs the difference, but the seed is no longer on
    // the face that was clicked and the interface prints a depth the plane has
    // not been at since the drag began.
    const vp = cutting()
    dragFrom(vp)

    vp.endGesture()

    expect(emitted(vp)).toContain(EVENT_FACE)
    expect(Math.abs(vp.state.cutOffset)).toBeGreaterThan(0.5)
    expect(vp.state.cutOffset).toBeCloseTo(sectionOffset(vp), 9)
  })

  it('says nothing when the gesture never moved the plane', () => {
    // A press the reader has not dragged is a click, and a click that a swap
    // interrupts placed nothing. Announcing an offset there would report a depth
    // for a plane that is exactly where it was.
    const vp = cutting()
    pointerDown(vp, [100, 100])

    vp.endGesture()

    expect(emitted(vp)).not.toContain(EVENT_FACE)
    expect(vp.state.cutOffset).toBe(0)
  })
})
