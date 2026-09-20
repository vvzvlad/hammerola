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

import {
  EVENT_FACE, EVENT_MENU, EVENT_MOVED, EVENT_PICK,
} from '../src/viewport/events.js'
import { projectPoint } from '../src/viewport/camera.js'
import { internals } from '../src/viewport/internals.js'
import { CLICK_PX } from '../src/viewport/options.js'
import { faceNormalAt, pickEntity } from '../src/viewport/picking.js'
import { placeSectionPlane, sectionOffset } from '../src/viewport/section.js'
import { installTools } from '../src/viewport/tools.js'
import { makeViewport, RECT, settled } from './component.js'
import {
  fakeCapUnits, fakeGroup, fakeShapeSolid, fakeViewer, fakeViewport, orthoCamera,
} from './fakes.js'

const teardowns = []

/**
 * The viewport `installTools` is handed.
 *
 * Built on the real prototype so `activeTool` is the element's own getter. Two
 * of its fields are deliberately not the real thing:
 *
 *   * `box` hands its listener back instead of being a DOM node, which is why
 *     it is spelled here rather than taken from the shared fixture. `onDown`
 *     refuses any press whose `event.target` is not the library's canvas, and
 *     the fake canvas is not a node an event could be dispatched at;
 *   * `dispatchEvent` is a spy — `makeViewport`'s, for the reason it gives
 *     there: the object's prototype chain reaches HTMLElement, but nothing
 *     built it through the DOM, so the inherited one would throw.
 */
function toolViewport(state = {}, viewer = fakeViewer()) {
  const vp = makeViewport({
    ...fakeViewport(viewer, state),
    box: {
      down: null,
      // Every listener by type, not just the press: the right-button menu also
      // needs the browser's own context menu kept off the canvas, and that is a
      // second listener on this same element.
      on: {},
      addEventListener(type, fn) {
        this.on[type] = fn
        if (type === 'pointerdown') this.down = fn
      },
      removeEventListener() {},
    },
  })
  teardowns.push(installTools(vp))
  return vp
}

/** A press on the canvas. The event is returned so a test can ask who got it. */
function pointerDown(vp, [clientX, clientY] = [100, 100], button = 0) {
  const event = {
    button,
    target: vp.viewer.canvas,
    clientX,
    clientY,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  }
  vp.box.down(event)
  return event
}

/** The other button: the one the part menu hangs off. */
const rightDown = (vp, at) => pointerDown(vp, at, 2)

/** The release. It goes to the WINDOW, which is where onDown put the listener. */
function pointerUp([clientX, clientY] = [100, 100]) {
  window.dispatchEvent(new MouseEvent('pointerup', { clientX, clientY }))
}

/** A drag, to the same place. Far enough to be past CLICK_PX. */
function pointerMove([clientX, clientY]) {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY }))
}

const emitted = (vp) => vp.dispatchEvent.mock.calls.map(([event]) => event.type)

/** What was carried by every event of one name, in the order they went out. */
const details = (vp, type) => vp.dispatchEvent.mock.calls
  .map(([event]) => event)
  .filter((event) => event.type === type)
  .map((event) => event.detail)

beforeEach(() => {
  vi.clearAllMocks()
  // `clearAllMocks` clears the CALLS and leaves the implementation standing, so
  // a `mockReturnValue` set by one test goes on answering for every test after
  // it — in file order, silently, and only for the ones that never set their
  // own. Both probes go back to MISSING here, which is what the module factory
  // at the top of this file says they do.
  faceNormalAt.mockReturnValue(null)
  pickEntity.mockReturnValue(null)
})

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

  it('has no branch left for the retired turn value', () => {
    // `turn` WAS A TOOL AND HAD A BRANCH HERE — `press.tool = null`, because
    // its whole gesture was on the rings and every press that reached this
    // listener had missed one. The rings answer to `move` now, so the value
    // never arrives and the branch is gone; what is pinned is that its absence
    // costs nothing, because an unknown tool falls past every branch and
    // reaches the two lines at the foot of `onDown` exactly as `comment` does.
    const vp = toolViewport({ tool: 'turn' })
    const event = pointerDown(vp)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalled()

    pointerUp()
    expect(emitted(vp)).toEqual([EVENT_PICK])
    expect(faceNormalAt).not.toHaveBeenCalled()
  })

  it('leaves the press alone under the move tool', () => {
    // THE WIDGET OWNS ITS OWN PRESSES AND NOTHING ELSE, and this is the line
    // that keeps the model turnable while it is armed. Every piece of the
    // manipulator takes its press off the canvas in a capture listener on the
    // WINDOW and stops it there, so a press that reaches HERE is one that
    // missed all of them — and it belongs to the trackball exactly as it would
    // with no tool armed.
    //
    // WHAT THE MISSING LINE WOULD COST is silent and total: every other armed
    // tool falls through to the two lines at the foot of `onDown`, which take
    // the press away from the controls. A reader who armed the tool that moves
    // a PART would find they could no longer turn the VIEW.
    const vp = toolViewport({ tool: 'move' })
    const event = pointerDown(vp)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()

    // AND IT MEANS WHAT A PLAIN PRESS MEANS: a click still selects, so the
    // reader reaches the part they meant without leaving the tool first.
    pointerUp()
    expect(emitted(vp)).toEqual([EVENT_PICK])
    expect(faceNormalAt).not.toHaveBeenCalled()
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

const PLATE = { id: '/model/plate', name: 'plate', point: [1, 2, 3] }

describe('the right button: a menu or a pan', () => {
  it('asks for the part menu when the press did not travel', () => {
    const vp = toolViewport({ tool: null })
    pickEntity.mockReturnValueOnce(PLATE)

    rightDown(vp, [140, 90])
    pointerUp([140, 90])

    expect(details(vp, EVENT_MENU)).toEqual([
      // The CURSOR, because that is where a context menu opens, and the
      // identifier `pickEntity` gives — the same one a selection would carry, so
      // the interface looks it up in the same tree.
      { id: '/model/plate', name: 'plate', x: 140, y: 90 },
    ])
  })

  it('says nothing when the press travelled — that was a pan', () => {
    // The library pans on this button (wheel.js), so travel is the only thing
    // that tells the two apart, and the threshold is the one already used to
    // decide a left-button press was a click.
    // Nothing is asked of `pickEntity` here, and that is part of the claim: a
    // pan must not even resolve what is under the cursor.
    const vp = toolViewport({ tool: null })

    rightDown(vp, [140, 90])
    pointerMove([140 + CLICK_PX, 90])
    pointerUp([140 + CLICK_PX, 90])

    expect(emitted(vp)).not.toContain(EVENT_MENU)
    expect(pickEntity).not.toHaveBeenCalled()
  })

  it('still opens one just under the threshold', () => {
    // The other side of the same line, so a threshold quietly changed to zero
    // (or to "any movement at all") fails here rather than making the menu
    // unreachable on a mouse that jitters.
    const vp = toolViewport({ tool: null })
    pickEntity.mockReturnValue(PLATE)

    rightDown(vp, [140, 90])
    pointerMove([140 + CLICK_PX - 1, 90])
    pointerUp([140 + CLICK_PX - 1, 90])

    expect(details(vp, EVENT_MENU)).toHaveLength(1)
  })

  it('leaves the press with the library, so panning keeps working', () => {
    // Nothing is taken here — unlike a tool's press, which is stopped in the
    // capture phase precisely so the controls never see it. Both readings of a
    // right press stay live until the release decides between them.
    const vp = toolViewport({ tool: null })
    const event = rightDown(vp)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
    pointerUp()
  })

  it('reports empty space as a menu with no id, which is how the menu closes', () => {
    // `pickEntity` misses — the state `beforeEach` puts it back into.
    const vp = toolViewport({ tool: null })

    rightDown(vp, [10, 10])
    pointerUp([10, 10])

    expect(details(vp, EVENT_MENU)).toEqual([{ id: null, name: null, x: 10, y: 10 }])
  })

  it('does not move the selection while opening a menu', () => {
    // A tree row's menu leaves the selection alone, and one menu with two
    // behaviours is worse than either. A PICK going out beside the menu is
    // exactly how the second behaviour would arrive.
    const vp = toolViewport({ tool: null })
    pickEntity.mockReturnValue(PLATE)

    rightDown(vp, [140, 90])
    pointerUp([140, 90])

    expect(emitted(vp)).toEqual([EVENT_MENU])
  })

  it('opens the menu whatever tool the interface armed', () => {
    // The tools all live on the LEFT button; this gesture is not a tool and does
    // not consult `activeTool`. A cut armed with the menu unreachable would be a
    // mode a reader has to leave in order to look at a part.
    const vp = toolViewport({ tool: 'measure' })
    pickEntity.mockReturnValue(PLATE)

    rightDown(vp, [140, 90])
    pointerUp([140, 90])

    expect(details(vp, EVENT_MENU)).toHaveLength(1)
    expect(faceNormalAt).not.toHaveBeenCalled()
  })

  it('keeps the browser\'s own menu off the canvas', () => {
    // Ours would otherwise open under the native one — and on every platform but
    // Windows the native one comes up on the PRESS, before the release that
    // opens ours has happened.
    const vp = toolViewport({ tool: null })
    const event = { preventDefault: vi.fn() }
    vp.box.on.contextmenu(event)
    expect(event.preventDefault).toHaveBeenCalled()
  })
})

describe('with a section cut standing', () => {
  // ISSUE #73. The stencil cap that closes a cut off carries no component id,
  // so the picker reads straight through it to the part flush underneath —
  // measured in a browser, the cut face of `plate` answered `reference_spacer`.
  // BOTH BUTTONS therefore ask about the cut face FIRST, and only while a cut
  // stands: the menu on the right and the plain selection on the left, through
  // one resolver so that one pixel cannot name two parts. That is why this
  // block sits at the top level rather than under either button's own.
  //
  // `pickEntity` is the mock this file already installs, and here it is the
  // WITNESS: whether it was consulted at all is what says which of the two
  // paths a press took.

  // A 2 mm cube. It used to be the same tessellation `outline.test.js` uses
  // and is no longer: that one was rewound outward when the contour started
  // measuring the SIGNED area of a cut face, which three inward-facing
  // triangles made come out as zero. Nothing here notices, and the copy is
  // deliberately left as it was — `insideSection` counts ray crossings by
  // parity, so which way a triangle faces cannot reach its answer, and a
  // fixture that does not care is better evidence of that than one that was
  // fixed to match.
  const CUBE_POSITIONS = new Float32Array([
    0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0,
    0, 0, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2,
  ])
  const CUBE_INDEX = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7,
    0, 5, 4, 0, 1, 5, 3, 2, 6, 3, 6, 7,
    0, 3, 7, 0, 7, 4, 1, 2, 6, 1, 6, 5,
  ])
  /** A viewport over one cube, looking down -Z, with the real cut laid on its
   *  +z face. `standing` is the renderer's clipping flag: switched off, the
   *  plane and the seed stay exactly where they are and nothing is cut — the
   *  state `suspendSectionCut` leaves behind. */
  function plateScene({ standing = true } = {}) {
    const camera = orthoCamera({
      eye: [0, 0, 80], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1],
    })
    const solid = fakeShapeSolid('model|plate', {
      positions: CUBE_POSITIONS, index: CUBE_INDEX,
    })
    const viewer = fakeViewer({
      camera, groups: { '/model/plate': solid },
      capUnits: fakeCapUnits([solid]), rect: RECT,
    })
    const vp = toolViewport({ tool: null }, viewer)
    expect(placeSectionPlane(vp, internals(viewer), [0, 0, 1], [1, 1, 1]))
      .toBe(true)
    viewer.setLocalClipping(standing)
    return { solid, viewer, vp }
  }

  /** The client pixel a world point sits under. The canvas is at the page
   *  origin here, so the NDC the module's own `projectPoint` gives is the
   *  whole of the conversion. */
  function clientOver(vp, x, y) {
    const [nx, ny] = projectPoint(internals(vp.viewer), [x, y, 0])
    return [((nx + 1) / 2) * RECT.width, ((1 - ny) / 2) * RECT.height]
  }

  it('opens the menu on the part the cut belongs to, not on what lies behind', () => {
    const { vp } = plateScene()
    const at = clientOver(vp, 1, 1)

    rightDown(vp, at)
    pointerUp(at)

    expect(details(vp, EVENT_MENU)).toEqual([
      { id: '/model/plate', name: 'plate', x: at[0], y: at[1] },
    ])
    // And the picker was never asked. It is what used to answer here, and its
    // answer was the part underneath.
    expect(pickEntity).not.toHaveBeenCalled()
  })

  it('still closes the menu on empty space while a cut stands', () => {
    // The other side of the same branch, and the one that keeps the menu
    // dismissable: a pixel the cut face does not cover falls through to the
    // picker exactly as it always did, and a miss there is still `id: null`.
    const { vp } = plateScene()
    const at = clientOver(vp, 9, 9)

    rightDown(vp, at)
    pointerUp(at)

    expect(pickEntity).toHaveBeenCalledTimes(1)
    expect(details(vp, EVENT_MENU))
      .toEqual([{ id: null, name: null, x: at[0], y: at[1] }])
  })

  it('leaves the same pixel entirely to the picker when no cut stands', () => {
    // Nothing new runs without a cut on screen. The plane and the seed are
    // exactly where the test above has them — `suspendSectionCut` keeps both,
    // so that turning the cut back on needs no second click — and the very
    // pixel that resolved to the cut face goes to `pickEntity` instead, whose
    // answer is used unchanged.
    const { vp } = plateScene({ standing: false })
    pickEntity.mockReturnValue(PLATE)
    const at = clientOver(vp, 1, 1)

    rightDown(vp, at)
    pointerUp(at)

    expect(pickEntity).toHaveBeenCalledTimes(1)
    expect(details(vp, EVENT_MENU)).toEqual([
      { id: '/model/plate', name: 'plate', x: at[0], y: at[1] },
    ])
  })

  it('selects the part the cut belongs to, not what lies behind', () => {
    // THE OTHER HALF OF THE SAME PIXEL. A right click here already named
    // `plate` while a left click named the surface the cap hides — the part
    // flush underneath, invisible at that pixel: two answers about one place,
    // and the left one a part the reader cannot see. A selection is an IDENTITY and
    // nothing more (`onPick` reads `id` and `name`), so the cap answers it as
    // completely as the picker would; measure, comment and move are the ones
    // that need a point on a real surface.
    const { vp } = plateScene()
    // WHAT LIES BEHIND, spelled out rather than left as an absent answer: with
    // the picker mocked to null the test would pass on `null` too, and the
    // failure a reverted correction produces would read "null instead of
    // plate" rather than naming the part the reader was actually given.
    pickEntity.mockReturnValue({
      id: '/model/spacer', name: 'spacer', point: [1, 1, 0],
    })
    const at = clientOver(vp, 1, 1)

    pointerDown(vp, at)
    pointerUp(at)

    const [pick] = details(vp, EVENT_PICK)
    expect({ id: pick.id, name: pick.name })
      .toEqual({ id: '/model/plate', name: 'plate' })
    expect(pickEntity).not.toHaveBeenCalled()
    // AND THE POINT IS ON THE CUT PLANE, asked of the plane itself rather
    // than pinned to a literal: the cap stands a hair inside the solid, and a
    // test carrying that offset as a number would be reporting the arithmetic
    // back to itself. `onPick` reads no point, but a caller that ever does
    // must not be handed the surface the picker would have read THROUGH.
    expect(pick.point[0]).toBeCloseTo(1, 6)
    expect(pick.point[1]).toBeCloseTo(1, 6)
    const [px, py, pz] = pick.point
    expect(internals(vp.viewer).plane.distanceToPoint({ x: px, y: py, z: pz }))
      .toBeCloseTo(0, 6)
  })

  it('still deselects on empty space while a cut stands', () => {
    // The road out. If the cap answered a pixel it does not cover, a reader
    // standing in front of a cut could no longer put the selection down.
    const { vp } = plateScene()
    const at = clientOver(vp, 9, 9)

    pointerDown(vp, at)
    pointerUp(at)

    expect(pickEntity).toHaveBeenCalledTimes(1)
    expect(details(vp, EVENT_PICK))
      .toEqual([{ id: null, name: null, point: null }])
  })

  it('leaves the pick entirely to the picker when no cut stands', () => {
    // Nothing new runs without a cut on screen, the selection included: the
    // plane and the seed are where they were, and the very pixel that
    // resolved to the cut face goes to `pickEntity`, whose answer is used
    // unchanged — the POINT included, which is the field the cap would have
    // spelled differently.
    const { vp } = plateScene({ standing: false })
    pickEntity.mockReturnValue(PLATE)
    const at = clientOver(vp, 1, 1)

    pointerDown(vp, at)
    pointerUp(at)

    expect(pickEntity).toHaveBeenCalledTimes(1)
    expect(details(vp, EVENT_PICK)).toEqual([PLATE])
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

  it('is still DROPPED by the two endings that always dropped it', () => {
    // `onCancel` — the platform claiming the pointer — and the leading
    // `finish()` in `onDown`, a second button or finger coming down mid-drag.
    // Both tear the listeners down and say nothing, which does leave
    // `state.cutOffset` at the depth from before the drag while the plane stands
    // somewhere else — the same staleness `endGesture` prevents, reached by a
    // right-click. Making bodies of the proposal draggable put a `conclude`
    // within reach of these two endings, and the CUT half was deliberately left
    // out of it: answering `hmr:face` DISARMS the armed tool, so reporting here
    // would start turning the cut tool off on an interrupted drag — a change to
    // a tool this work was not about. If that staleness is ever taken on, it is
    // its own change with its own reason, and this test is the one to flip.
    const endings = {
      'the pointer taken away': () => window.dispatchEvent(
        new MouseEvent('pointercancel', {})),
      'a second press': (vp) => rightDown(vp, [300, 100]),
    }
    for (const [what, interrupt] of Object.entries(endings)) {
      const vp = cutting()
      const before = vp.state.cutOffset
      dragFrom(vp)

      interrupt(vp)

      expect(emitted(vp), `${what} announced the cut`).not.toContain(EVENT_FACE)
      expect(vp.state.cutOffset).toBe(before)
    }
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

describe('with the move tool armed', () => {
  // THE FREE DRAG IS GONE, and what stands in its place is the absence of a
  // branch: a press under `move` takes the plain path, so the trackball keeps
  // the canvas and the only thing that moves a part is the manipulator standing
  // on it (gizmo.js, rings.js), which takes its presses somewhere else.
  //
  // THE SELECTION IS WHAT MAKES THESE TESTS BITE. The removed branch dragged a
  // standing selection from a press on EMPTY SPACE — `wanted[0]`, the fallback
  // that had no part under the cursor to grab — so a fixture with nothing
  // selected would pass whether the branch is there or not.

  const PINS = ['/Group/pin', '/Group/pin(2)']

  /** The move tool, armed, with the whole row selected. */
  function moving(selected = PINS) {
    const groups = Object.fromEntries(
      [...PINS, '/Group/lid'].map((path) => [path, fakeGroup()]))
    const vp = toolViewport({ tool: 'move', selected }, fakeViewer({ groups }))
    vp.drawnKey = 'build-1'
    return { groups, vp }
  }

  /** Where a group ended up, as three numbers. */
  const at = (group) => [group.position.x, group.position.y, group.position.z]

  it('leaves a drag from empty space to the trackball, moving nothing', async () => {
    // The press that used to drag the selection: nothing under the cursor, a
    // row selected, and 200 px of travel. What it must do now is what it does
    // with no tool armed at all — go to the library, which orbits the model.
    const { groups, vp } = moving()
    pickEntity.mockReturnValue(null)

    const event = pointerDown(vp, [100, 100])
    pointerMove([300, 100])
    pointerUp([300, 100])
    await settled()

    for (const path of [...PINS, '/Group/lid']) {
      expect(at(groups[path]), `${path} moved anyway`).toEqual([0, 0, 0])
    }
    expect(vp.moved.size).toBe(0)
    expect(emitted(vp)).not.toContain(EVENT_MOVED)
    // And it went to the library, which is what turns the model: nothing was
    // taken from the trackball in the capture phase.
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })

  it('still selects on a click, so the next part is reachable', async () => {
    // A press ON the selected part, released without travelling: the reader
    // reaching for another object without leaving the tool first. It selects,
    // like any click with nothing armed — and it is not taken from the
    // trackball, which is the half that would have been true of the old branch
    // only when there was nothing to grab.
    const { groups, vp } = moving()
    pickEntity.mockReturnValue({ id: PINS[0], name: 'pin', point: [1, 2, 3] })

    const event = pointerDown(vp, [100, 100])
    pointerUp([100, 100])
    await settled()

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(details(vp, EVENT_PICK)).toEqual([
      { id: PINS[0], name: 'pin', point: [1, 2, 3] },
    ])
    expect(at(groups[PINS[0]])).toEqual([0, 0, 0])
    expect(emitted(vp)).not.toContain(EVENT_MOVED)
  })
})

