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
import {
  EVENT_FACE, EVENT_MENU, EVENT_MOVED, EVENT_PICK, EVENT_PROPOSALMOVE,
} from '../src/viewport/events.js'
import { projectPoint } from '../src/viewport/camera.js'
import { internals } from '../src/viewport/internals.js'
import { CLICK_PX } from '../src/viewport/options.js'
import { faceNormalAt, pickEntity } from '../src/viewport/picking.js'
import { placeSectionPlane, sectionOffset } from '../src/viewport/section.js'
import { installTools } from '../src/viewport/tools.js'
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
 *   * `box` hands its listener back instead of being a DOM node. `onDown`
 *     refuses any press whose `event.target` is not the library's canvas, and
 *     the fake canvas is not a node an event could be dispatched at;
 *   * `dispatchEvent` is a spy. The object's prototype chain reaches
 *     HTMLElement, but nothing built it through the DOM, so the inherited one
 *     would throw.
 */
function toolViewport(state = {}, viewer = fakeViewer()) {
  const vp = Object.create(HmrViewport.prototype)
  Object.assign(vp, fakeViewport(viewer, state))
  vp.holdActive = false
  vp.dispatchEvent = vi.fn()
  vp.box = {
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
  }
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

  it('leaves the press alone when the move tool has nothing to grab', () => {
    // THE WIDGET OWNS ITS OWN PRESSES AND NOTHING ELSE, and this is the line
    // that keeps the model turnable while it is armed. The arrows, the quads
    // and the origin dot take theirs on their own elements, which are siblings
    // of this one; the rotation handles take theirs off the canvas in a capture
    // listener on the WINDOW and stop it there. So a press that reaches HERE is
    // one that missed every piece of the widget, and with nothing under it to
    // grab it belongs to the trackball exactly as it would with no tool armed.
    //
    // WHAT THE MISSING LINE WOULD COST is silent and total: every other armed
    // tool falls through to the two lines at the foot of `onDown`, which take
    // the press away from the controls. A reader who armed the tool that moves
    // a PART would find they could no longer turn the VIEW.
    const vp = toolViewport({ tool: 'move' })
    const event = pointerDown(vp)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()

    // AND IT DEGRADES RATHER THAN BEING DROPPED: a click still selects, so the
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
  const RECT = { left: 0, top: 0, width: 800, height: 600 }

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

describe('what a drag with the move tool takes with it', () => {
  // A ROW MAY STAND FOR SEVERAL SOLIDS (issue #75): the interface collapses
  // adjacent copies of one part into `pin ×5` and sends every one of their paths
  // as the selection, so a drag moves the row rather than the first of it. The
  // paths are the fake scene's own groups; the camera is the same one the
  // section drag above is written against.

  const PINS = ['/Group/pin', '/Group/pin(2)']

  /** The move tool, armed, over a scene of three movable solids. */
  function moving(selected) {
    const groups = Object.fromEntries(
      [...PINS, '/Group/lid'].map((path) => [path, fakeGroup()]))
    const viewer = fakeViewer({ groups })
    const vp = toolViewport({ tool: 'move', selected }, viewer)
    // WHICH BUILD THE GEOMETRY IS OF, which on a real element is written in
    // `show()` beside the payload and is deliberately NOT `state.buildKey` —
    // that one moves when a swap is ANNOUNCED and the scene arrives later. A
    // fixture that left this null would test a viewport that has rendered
    // nothing.
    vp.drawnKey = 'build-1'
    return { groups, vp }
  }

  /** Where a group ended up, as three numbers. */
  const at = (group) => [group.position.x, group.position.y, group.position.z]

  /** A press on the canvas and a drag of 200 px across it. */
  const dragFrom = (vp) => {
    pointerDown(vp, [100, 100])
    pointerMove([300, 100])
  }

  /**
   * One turn of the microtask queue.
   *
   * BOTH REPORTS ARE DEFERRED BY ONE, and every assertion about either has to
   * wait that long — see `reportProposalMove` and `reportModelMove`, which say
   * why: one of the endings that raise them is `endGesture`, and `endGesture` is
   * called from inside `show()`, where a report that comes back as a stage would
   * render the document that render is in the middle of replacing.
   */
  const settled = () => Promise.resolve()

  /** The same drag, released — which is the only thing that reports it. */
  const dragAndDrop = async (vp) => {
    dragFrom(vp)
    pointerUp([300, 100])
    await settled()
  }

  it('takes every path of the selected row, from one grab on one of them', () => {
    const { groups, vp } = moving(PINS)
    pickEntity.mockReturnValue({ id: PINS[0], name: 'pin', point: [0, 0, 0] })
    dragFrom(vp)

    expect(vp.moved.size, 'the second copy stayed behind').toBe(2)
    expect(at(groups[PINS[1]])).toEqual(at(groups[PINS[0]]))
    expect(at(groups[PINS[0]])).not.toEqual([0, 0, 0])
    expect(at(groups['/Group/lid']), 'a part outside the row was dragged too')
      .toEqual([0, 0, 0])
  })

  it('carries the turn the part is already standing at through the drag', async () => {
    // `movePart` writes the group's quaternion on EVERY call, the identity
    // included — so a drag that said nothing about the turn would flatten a part
    // the reader had turned in the panel, under their own hand, with the
    // document still saying it is turned. The press reads the anchor's turn once
    // and hands it back on every step.
    //
    // THE PIVOT IS SEEDED WITH WHAT THE SCENE WOULD HAVE ANSWERED, because these
    // fakes carry no tessellation and a part whose centre cannot be read is one
    // `movePart` refuses to turn at all (parts.test.js pins that refusal).
    const { groups, vp } = moving(PINS)
    for (const path of PINS) {
      vp.moved.set(path, { delta: [0, 0, 0], turn: [0, 0, 90] })
      vp.partPivot.set(path, [1, 3, 0])
    }
    pickEntity.mockReturnValue({ id: PINS[0], name: 'pin', point: [0, 0, 0] })

    await dragAndDrop(vp)

    expect(vp.moved.get(PINS[0]).turn).toEqual([0, 0, 90])
    expect(groups[PINS[0]].quaternion.w)
      .toBeCloseTo(Math.cos((45 * Math.PI) / 180), 12)
    // AND THE REPORT SAYS NOTHING ABOUT THE TURN, because a drag is about where:
    // the node the interface edits keeps the turn it was already carrying.
    const [report] = details(vp, EVENT_MOVED)
    expect(report.delta).not.toEqual([0, 0, 0])
    expect(report.turn).toBeUndefined()
  })

  it('reports every path that went, and how many they were', async () => {
    // `count` is what the NAME is written with — `pin ×2` and not `pin` — and
    // `paths` is what the interface records the displacement under. Both are
    // reported rather than looked up on the other side, because the viewport is
    // the only half that knows what this gesture actually took hold of.
    const { vp } = moving(PINS)
    pickEntity.mockReturnValue({ id: PINS[0], name: 'pin', point: [0, 0, 0] })
    await dragAndDrop(vp)

    const [first] = details(vp, EVENT_MOVED)
    expect(first.count).toBe(2)
    expect(first.id).toBe(PINS[0])
    expect(first.paths).toEqual(PINS)
  })

  it('says nothing until the hand comes off, so the drag survives the answer', async () => {
    // THE RELEASE IS THE ONLY REPORT, and this is the line that holds it. The
    // interface answers a recorded move by OPENING THE PANEL, which changes the
    // overlay — and a changed overlay reaches `restage()`, `restage()` calls
    // `show()`, and `show()` ends the gesture the reader has not let go of
    // (`endGesture`, element.js). Reported per snap step, that tore the press
    // and its window listeners down one step into the drag: the part travelled
    // a few millimetres and froze under the cursor.
    const { groups, vp } = moving(PINS)
    pickEntity.mockReturnValue({ id: PINS[0], name: 'pin', point: [0, 0, 0] })

    dragFrom(vp)
    await settled()

    expect(at(groups[PINS[0]]), 'the part did not follow the hand')
      .not.toEqual([0, 0, 0])
    expect(emitted(vp)).not.toContain(EVENT_MOVED)

    pointerUp([300, 100])
    await settled()
    expect(details(vp, EVENT_MOVED)).toHaveLength(1)
  })

  it('is concluded when the scene is swapped — but never inside the render', async () => {
    // TWO ASSERTIONS THAT PULL AGAINST EACH OTHER, which is why they are one
    // test, and the same pair the proposal body carries below. `show()` ends a
    // gesture the reader has not let go of, because a build can land mid-drag;
    // abandoned, the part stands displaced in `vp.moved` with no node in the
    // document claiming it, and the next `reconcileMoves` sends it home.
    //
    // AND YET IT MUST NOT GO OUT FROM INSIDE THAT RENDER. `endGesture` is called
    // from `show()` after its only `await` and BEFORE the payload of the new
    // build is remembered, and the interface answers this report by writing the
    // document and pushing it back — which for a document holding bodies is a
    // stage, and a stage reads that payload. One microtask is the whole fix.
    const { vp } = moving(PINS)
    pickEntity.mockReturnValue({ id: PINS[0], name: 'pin', point: [0, 0, 0] })
    dragFrom(vp)

    vp.endGesture()

    expect(emitted(vp), 'the report went out inside the render')
      .not.toContain(EVENT_MOVED)

    await settled()
    expect(details(vp, EVENT_MOVED)).toHaveLength(1)
  })

  it('is concluded when the pointer is taken away', async () => {
    // `pointercancel` — the platform claiming the gesture, a touch turning into
    // a scroll. No `pointerup` follows one, so a cancel that only tore the
    // listeners down would leave the part displaced with nothing in the document
    // claiming it: the next push sends it home and the drag is silently undone.
    const { vp } = moving(PINS)
    pickEntity.mockReturnValue({ id: PINS[0], name: 'pin', point: [0, 0, 0] })
    dragFrom(vp)

    window.dispatchEvent(new MouseEvent('pointercancel', {}))
    await settled()

    expect(details(vp, EVENT_MOVED)).toHaveLength(1)
  })

  it('is concluded when another press arrives with it still live', async () => {
    // `onDown` opens by finishing whatever press is standing — a gesture whose
    // release this page never saw, or a second button or finger coming down
    // mid-drag. That ending is an ending like any other: the part is already
    // standing somewhere else, and only the document can be wrong about it.
    const { vp } = moving(PINS)
    pickEntity.mockReturnValue({ id: PINS[0], name: 'pin', point: [0, 0, 0] })
    dragFrom(vp)

    rightDown(vp, [300, 100])
    await settled()

    expect(details(vp, EVENT_MOVED)).toHaveLength(1)
    pointerUp([300, 100])
  })

  it('reports a number somebody could have typed, not the arithmetic', async () => {
    // WHAT `snap` ACTUALLY PRODUCES. The step comes off the grid in 1-2-5
    // decades, and a 20 mm assembly lands on 0.1 — where `Math.round(v / step) *
    // step` is exact on paper and binary here: six steps of a tenth come out of
    // that as `0.6000000000000001`. The drag below is six of them.
    //
    // WHERE THAT NUMBER GOES IF IT IS NOT ROUNDED HERE: into `vp.moved`, out on
    // this event, and from there into the proposal document — which `reconcile
    // Moves` then compares against the map element by element, so a document
    // rounded anywhere else disagrees with the map about a part nobody touched
    // and every push re-applies a move that is already standing. The panel draws
    // it and the agent reads it, too, and nobody dragged anything to fifteen
    // decimal places.
    const groups = { '/Group/pin': fakeGroup() }
    const vp = toolViewport({ tool: 'move', selected: [] },
                            fakeViewer({ groups, gridSize: 20 }))
    pickEntity.mockReturnValue({ id: '/Group/pin', name: 'pin', point: [0, 0, 0] })

    pointerDown(vp, [100, 100])
    pointerMove([112, 100])
    pointerUp([112, 100])
    await settled()

    const [report] = details(vp, EVENT_MOVED)
    expect(report.delta).toEqual([0.6, 0, 0])
    // And the scene and the map carry that same one, which is the whole point of
    // rounding at the source rather than on the way out.
    expect(vp.moved.get('/Group/pin')).toEqual({ delta: [0.6, 0, 0], turn: [0, 0, 0] })
    expect(at(groups['/Group/pin'])).toEqual([0.6, 0, 0])
  })

  it('says nothing for a gesture that left the part where it already was', async () => {
    // A drag past CLICK_PX that never crossed a snap step — or that came back to
    // the one it started on — moved nothing. Announced, it would write a node
    // the document already has and open the panel to show the reader nothing
    // new.
    const { vp } = moving(PINS)
    pickEntity.mockReturnValue({ id: PINS[0], name: 'pin', point: [0, 0, 0] })

    pointerDown(vp, [100, 100])
    pointerMove([300, 100])
    pointerMove([100, 100])
    pointerUp([100, 100])
    await settled()

    expect(emitted(vp)).not.toContain(EVENT_MOVED)
  })

  it('says which build the numbers were measured on, as of the PRESS', async () => {
    // WITHOUT THIS THE WHOLE FEATURE CAN DIE SILENTLY. The interface drops a
    // report whose stamp is not the build it is showing, so a report that
    // carries no stamp at all is one every drag on the real page throws away —
    // and every test on that side fakes the field into its own dispatches, so
    // none of them would notice. This is the only place the field is asserted to
    // exist.
    //
    // AS OF THE PRESS AND NOT THE RELEASE, which is what makes it a stamp: the
    // scene can be replaced under a hand that has not come off the model, and
    // what these paths and this offset describe is the assembly that was on
    // screen when the grab was made.
    const { vp } = moving(PINS)
    pickEntity.mockReturnValue({ id: PINS[0], name: 'pin', point: [0, 0, 0] })

    pointerDown(vp, [100, 100])
    pointerMove([300, 100])
    vp.drawnKey = 'build-2'
    pointerUp([300, 100])
    await settled()

    expect(details(vp, EVENT_MOVED)[0].build).toBe('build-1')
  })

  it('takes the build off the SCENE, not off the announcement', async () => {
    // THE DOWNLOAD WINDOW. `state.buildKey` moves in `setState()` the moment the
    // interface announces a swap — both `takePending` and `switchBuild` commit
    // their `meta` before that — and the geometry arrives later, after the
    // `await fetch` in `load()`. Nothing disarms the Move tool across it. So a
    // press begun in that window, stamped off the announcement, would carry the
    // NEW key, match on arrival, and file paths read off the assembly that was
    // still being looked at — and across a revision the same path can be a
    // different part altogether.
    //
    // `drawnKey` is written in `show()` beside the payload, which is the line
    // that means the new scene is really up, so the press below is stamped with
    // the build it was actually made on and the report is thrown away.
    const { vp } = moving(PINS)
    pickEntity.mockReturnValue({ id: PINS[0], name: 'pin', point: [0, 0, 0] })

    // The announcement, with the geometry still the old build's.
    vp.state = { ...vp.state, buildKey: 'build-2' }
    pointerDown(vp, [100, 100])
    pointerMove([300, 100])
    // ...and now the scene really swaps, which is what ends the gesture.
    vp.drawnKey = 'build-2'
    vp.endGesture()
    await settled()

    expect(details(vp, EVENT_MOVED)[0].build).toBe('build-1')
  })

  it('speaks up when the ANCHOR came back but its siblings did not', async () => {
    // THE GUARD IS ASKED OF EVERY PATH, and this is the gesture that made it
    // have to be. One copy is dragged out alone, so the row stands apart: one at
    // the offset, one at home. The row is then selected and the DISPLACED copy
    // grabbed — the anchor, so the drag starts from its offset — carried out and
    // brought back to exactly where it began. Nothing happened to the anchor.
    // Everything happened to its sibling, which one delta applied to every path
    // (`movePart`) has carried the whole way across.
    //
    // Asked about the anchor alone this reads as a gesture that went nowhere,
    // and the sibling is left standing at an offset no node in the document
    // claims — until the next push jerks it home under the reader's hand.
    const { groups, vp } = moving([])
    pickEntity.mockReturnValue({ id: PINS[1], name: 'pin', point: [0, 0, 0] })
    await dragAndDrop(vp)
    const [first] = details(vp, EVENT_MOVED)
    expect(at(groups[PINS[0]]), 'the sibling came along on the first drag')
      .toEqual([0, 0, 0])
    vp.state = { ...vp.state, selected: PINS }

    pointerDown(vp, [100, 100])
    pointerMove([300, 100])
    pointerMove([100, 100])
    pointerUp([100, 100])
    await settled()

    expect(details(vp, EVENT_MOVED)).toHaveLength(2)
    const [, second] = details(vp, EVENT_MOVED)
    expect(second.delta).toEqual(first.delta)
    expect(second.paths).toEqual(PINS)
    expect(at(groups[PINS[0]]), 'the sibling did not come to the anchor')
      .toEqual(first.delta)
  })

  it('announces the retraction when a part is dragged back home', async () => {
    // A ZERO IS NOT SILENCE. The guard above asks whether the gesture CHANGED
    // anything, not whether the delta is nothing: a part standing displaced and
    // dragged back to where the build puts it has changed a great deal, and the
    // interface answers this by deleting the node rather than by writing a move
    // of (0, 0, 0) into the projection.
    const { groups, vp } = moving([])
    pickEntity.mockReturnValue({ id: PINS[0], name: 'pin', point: [0, 0, 0] })
    await dragAndDrop(vp)

    // From where the part now stands, the same travel back the way it came.
    pointerDown(vp, [300, 100])
    pointerMove([100, 100])
    pointerUp([100, 100])
    await settled()

    const [, back] = details(vp, EVENT_MOVED)
    expect(back.delta).toEqual([0, 0, 0])
    expect(at(groups[PINS[0]])).toEqual([0, 0, 0])
  })

  it('announces the delta that LANDED, not the one that was refused', async () => {
    // `stood` EXISTS FOR THIS AND ONLY THIS. Past its pre-check `movePart` is not
    // atomic: a `position.set` that throws part way down a row leaves the paths
    // before it displaced and answers `false` without unwinding (parts.js says
    // why). The snapped delta has to advance whatever happens, or a step that
    // fails is retried on every pointermove for the rest of the gesture — so the
    // two are separate fields, and what the release announces is the last offset
    // the whole gesture is known to have reached.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { groups, vp } = moving(PINS)
    pickEntity.mockReturnValue({ id: PINS[0], name: 'pin', point: [0, 0, 0] })

    pointerDown(vp, [100, 100])
    pointerMove([300, 100])
    const landed = [...vp.moved.get(PINS[0]).delta]
    groups[PINS[1]].position.set = () => { throw new Error('gone') }
    pointerMove([500, 100])
    pointerUp([500, 100])
    await settled()

    const [report] = details(vp, EVENT_MOVED)
    expect(report.delta).toEqual(landed)
    // The scene really is out of step — the first path took the refused step
    // before the throw — and settling that is `reconcileMoves`'s job, off the
    // document this delta is about to be written into.
    expect(at(groups[PINS[0]])).toEqual(landed.map((v) => v * 2))
  })

  it('takes the one part that was grabbed when nothing is selected', async () => {
    // The viewport is told which paths are selected and knows nothing about the
    // rest, so a grab out of the blue moves what was grabbed. The pick this
    // press emits is what puts the whole row under the next drag.
    const { groups, vp } = moving([])
    pickEntity.mockReturnValue({ id: PINS[0], name: 'pin', point: [0, 0, 0] })
    await dragAndDrop(vp)

    expect(vp.moved.size).toBe(1)
    expect(at(groups[PINS[1]])).toEqual([0, 0, 0])
    expect(details(vp, EVENT_MOVED)[0].count).toBe(1)
    expect(emitted(vp)).toContain(EVENT_PICK)
  })

  it('moves nothing when the grab lands on a part outside the selection', () => {
    const { groups, vp } = moving(PINS)
    pickEntity.mockReturnValue({ id: '/Group/lid', name: 'lid', point: [0, 0, 0] })
    const event = pointerDown(vp, [100, 100])
    pointerMove([300, 100])

    expect(vp.moved.size).toBe(0)
    for (const path of [...PINS, '/Group/lid']) {
      expect(at(groups[path]), `${path} moved anyway`).toEqual([0, 0, 0])
    }
    expect(emitted(vp)).not.toContain(EVENT_MOVED)
    // And the press DEGRADED rather than being swallowed: it was left with the
    // trackball, so the drag rotates the model instead of doing nothing at all.
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  describe('a second drag, after one copy went on its own', () => {
    // THE ORDINARY WAY the copies of a row end up standing apart — the other is
    // `movePart` throwing half way down its list, which is a failure rather than
    // a gesture (see the anchor note in `tools.js`). With nothing
    // selected a grab drags the copy it hit, and the pick that same press emits
    // selects the whole row — so the very next drag is a drag of all of it. The
    // second gesture applies one delta to every path from its OWN home, so they
    // converge whatever happens here; what the anchor decides is WHICH of them
    // arrives at the meeting point by jumping.

    /** The first gesture: one copy, dragged alone out of an empty selection. */
    async function droveOneCopy(grabbed) {
      const { groups, vp } = moving([])
      pickEntity.mockReturnValue({ id: grabbed, name: 'pin', point: [0, 0, 0] })
      await dragAndDrop(vp)

      const [first] = details(vp, EVENT_MOVED)
      expect(first.count, 'the first gesture took more than the grabbed copy')
        .toBe(1)
      expect(first.delta.some((v) => v !== 0), 'it moved nowhere').toBe(true)
      // What the interface does with that pick, spelled out: the row is
      // selected now.
      vp.state = { ...vp.state, selected: PINS }
      return { groups, vp, first }
    }

    /** The delta of the last `hmr:moved` that went out. */
    const lastDelta = (vp) => details(vp, EVENT_MOVED).pop().delta

    it('leaves the grabbed copy where it was and brings the row to it', async () => {
      // The reader keeps hold of the SECOND copy — the one carrying the offset
      // — so it must not snap back towards home under the cursor. The same
      // travel a second time therefore lands it at twice the first delta, which
      // is exactly what a jump home would not do.
      const { groups, vp, first } = await droveOneCopy(PINS[1])
      expect(at(groups[PINS[0]]), 'the sibling came along on the first drag')
        .toEqual([0, 0, 0])

      await dragAndDrop(vp)

      const delta = lastDelta(vp)
      expect(delta).toEqual(first.delta.map((v) => v * 2))
      expect(at(groups[PINS[1]]), 'the copy under the hand jumped').toEqual(delta)
      expect(at(groups[PINS[0]]), 'the row did not close up').toEqual(delta)
    })

    it('does the same when the grabbed copy is the row\'s first', async () => {
      // The other side of the rule, and the case where the anchor and the
      // `wanted[0]` it falls back to are the same path — so this one cannot
      // fail on that regression, and the test above is what does. It is here
      // because "the copy under the hand" has to hold whichever copy that is:
      // an anchor read off the END of the list passes the test above — where
      // the end and the grabbed copy are the same path — and fails this one.
      const { groups, vp, first } = await droveOneCopy(PINS[0])

      await dragAndDrop(vp)

      const delta = lastDelta(vp)
      expect(delta).toEqual(first.delta.map((v) => v * 2))
      expect(at(groups[PINS[0]]), 'the copy under the hand jumped').toEqual(delta)
      expect(at(groups[PINS[1]])).toEqual(delta)
    })
  })

  it('refuses the whole row when one copy of it is not in the scene', () => {
    // All or nothing: half a row moved is two copies of one part standing in
    // different places under one node that calls it a move of the row. Refused at
    // the PRESS, which is what leaves the gesture to the trackball — refusing it
    // in `movePart` alone would arm a drag that then quietly does nothing.
    const { groups, vp } = moving([...PINS, '/Group/pin(3)'])
    pickEntity.mockReturnValue({ id: PINS[0], name: 'pin', point: [0, 0, 0] })
    const event = pointerDown(vp, [100, 100])
    pointerMove([300, 100])

    expect(vp.moved.size).toBe(0)
    for (const path of PINS) expect(at(groups[path])).toEqual([0, 0, 0])
    expect(emitted(vp)).not.toContain(EVENT_MOVED)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  describe('a body the proposal panel staged over the model', () => {
    // A body of the thing the model has to fit, assembled in the panel and
    // composed into the document (`staged()` in element.js). It is an ordinary
    // group in `nestedGroup` and an ordinary pick target, so the move tool drags
    // it like any part — and what the drag MEANS is the whole subject here. A
    // part of the build moved is a statement to the agent: a move node in the
    // proposal, and `hmr:moved` filing the paths in the build's terms. A
    // proposal body moved is
    // the reader editing their OWN drawing, so it ends in `hmr:proposalmove`
    // naming the body, and the panel writes the number into the `at` fields it
    // is already showing.
    //
    // NOTHING MAY BE RECORDED FOR IT, which is the half that would fail
    // silently. `vp.moved` is re-applied after every re-stage (`restageMoves`)
    // and the panel re-stages on the next edit, so an offset left there would be
    // added on top of the position the document by then carries — the body walks
    // away by twice the distance on the next keystroke — and the move node that
    // is the only door onto taking it back is deliberately never written.
    //
    // THE ELEMENT'S OWN `isOverlay`/`overlayBody` ANSWER, like `activeTool`
    // above, off the two fields they read. Agreeing with the group name minted
    // against the document's own parts is the whole reason those questions
    // belong to the viewport rather than to a regex over the path.
    const GROUP = '/Group/proposal'
    // One part per body of the document, under the body's own name: the solids
    // and, translucent, the holes (proposalgeom.js).
    const BODY = `${GROUP}/plate`
    const HOLE = `${GROUP}/bore`

    /** The scene above with the body staged into it, group node and all. */
    function overlaid(selected) {
      const groups = Object.fromEntries([...PINS, '/Group/lid', GROUP, BODY,
                                         HOLE].map((path) => [path, fakeGroup()]))
      const vp = toolViewport({ tool: 'move', selected }, fakeViewer({ groups }))
      vp.payload = { name: 'Group', parts: [] }
      vp.overlayParts = [{ name: 'plate' }, { name: 'bore' }]
      return { groups, vp }
    }

    /** A press on one body, a drag, and the release that reports it. */
    async function dragBody(vp, id, name) {
      pickEntity.mockReturnValue({ id, name, point: [0, 0, 0] })
      dragFrom(vp)
      pointerUp([300, 100])
      await settled()
      return details(vp, EVENT_PROPOSALMOVE)
    }

    it('follows the hand, and says which body it was when the hand comes off', async () => {
      const { groups, vp } = overlaid([])

      const [report] = await dragBody(vp, BODY, 'plate')

      // The name and nothing else: the panel's document holds bodies by name and
      // has no paths in it at all.
      expect(report.name).toBe('plate')
      expect(report.delta.some((v) => v !== 0), 'it moved nowhere').toBe(true)
      expect(at(groups[BODY])).toEqual(report.delta)
      // And none of what a part of the build leaves behind.
      expect(vp.moved.size, 'an offset was written for it').toBe(0)
      expect(vp.partHome.size, 'a home was remembered for it').toBe(0)
      expect(emitted(vp)).not.toContain(EVENT_MOVED)
    })

    it('takes the press away from the trackball, like any other drag', () => {
      // The press is the gesture now rather than degrading into a rotation, so
      // it has to be stopped in the capture phase — otherwise the model turns
      // under the body being dragged.
      const { vp } = overlaid([])
      pickEntity.mockReturnValue({ id: BODY, name: 'plate', point: [0, 0, 0] })

      const event = pointerDown(vp, [100, 100])

      expect(event.preventDefault).toHaveBeenCalled()
      expect(event.stopPropagation).toHaveBeenCalled()
      pointerUp([100, 100])
    })

    it('says nothing until the hand comes off', async () => {
      // THE RELEASE IS THE ONLY REPORT, and it is not a detail: the panel
      // answers this by editing its document, which rebuilds the bodies and has
      // the whole scene disposed and rendered again. Per snap step, that is a
      // re-stage every few pixels while the reader is still dragging.
      const { groups, vp } = overlaid([])
      pickEntity.mockReturnValue({ id: BODY, name: 'plate', point: [0, 0, 0] })

      dragFrom(vp)
      await settled()

      expect(at(groups[BODY]), 'the body did not follow the hand')
        .not.toEqual([0, 0, 0])
      expect(emitted(vp)).not.toContain(EVENT_PROPOSALMOVE)

      pointerUp([300, 100])
      await settled()
      expect(details(vp, EVENT_PROPOSALMOVE)).toHaveLength(1)
    })

    it('names the one hole that was grabbed, and moves only it', async () => {
      // A hole is a part of its own in the payload, so it is grabbable on its
      // own — and a hole dragged through the body is the thing the fields make
      // hardest to aim by hand.
      const { groups, vp } = overlaid([])

      const [report] = await dragBody(vp, HOLE, 'bore')

      expect(report.name).toBe('bore')
      expect(at(groups[HOLE])).toEqual(report.delta)
      expect(at(groups[BODY]), 'the other body went with it').toEqual([0, 0, 0])
    })

    it('is concluded when the scene is swapped — but never inside the render', async () => {
      // TWO ASSERTIONS THAT PULL AGAINST EACH OTHER, which is why they are one
      // test. `show()` ends a gesture the reader has not let go of, because a
      // build can land mid-drag; abandoned, the body stands where it was dragged
      // with the panel's numbers still describing where it was, and the panel's
      // next edit stages it back home — the drag silently undone.
      //
      // AND YET IT MUST NOT GO OUT FROM INSIDE THAT RENDER. `endGesture` is
      // called from `show()` after its only `await` and BEFORE the payload of
      // the new build is remembered, and this report comes back as a re-stage —
      // which reads that payload. Sent synchronously, the re-stage would compose
      // the overlay into the document being REPLACED, sleep on its own await
      // while the outer render finished, and then repaint the previous build
      // under the same load token: the reader left looking at the old build with
      // nothing coming to correct it. One microtask is the whole fix, and this
      // is the line that holds it.
      const { vp } = overlaid([])
      pickEntity.mockReturnValue({ id: BODY, name: 'plate', point: [0, 0, 0] })
      dragFrom(vp)

      vp.endGesture()

      expect(emitted(vp), 'the report went out inside the render')
        .not.toContain(EVENT_PROPOSALMOVE)

      await settled()
      expect(details(vp, EVENT_PROPOSALMOVE)).toHaveLength(1)
    })

    it('is concluded when the pointer is taken away', async () => {
      // `pointercancel` — the platform claiming the gesture, a touch turning
      // into a scroll. No `pointerup` follows one, so a cancel that only tore
      // the listeners down left the body displaced and the document holding the
      // place it had left.
      const { vp } = overlaid([])
      pickEntity.mockReturnValue({ id: BODY, name: 'plate', point: [0, 0, 0] })
      dragFrom(vp)

      window.dispatchEvent(new MouseEvent('pointercancel', {}))
      await settled()

      expect(details(vp, EVENT_PROPOSALMOVE)).toHaveLength(1)
    })

    it('is concluded when another press arrives with it still live', async () => {
      // `onDown` opens by finishing whatever press is standing — a gesture whose
      // release this page never saw, or a second button or finger coming down
      // mid-drag. That ending is an ending like any other: the body is already
      // standing somewhere else, and only the document can be wrong about it.
      const { vp } = overlaid([])
      pickEntity.mockReturnValue({ id: BODY, name: 'plate', point: [0, 0, 0] })
      dragFrom(vp)

      rightDown(vp, [300, 100])
      await settled()

      expect(details(vp, EVENT_PROPOSALMOVE)).toHaveLength(1)
      pointerUp([300, 100])
    })

    it('starts the next drag from where the document now puts it', async () => {
      // THE HOME IS READ AT EVERY PRESS and never remembered, which is what
      // `vp.partHome` would have done. The panel answers the first report by
      // moving the node's `at` and staging the document again — the group is
      // disposed and built anew, at the place the body now belongs — so a
      // remembered home would measure the second drag from where the body stood
      // before the first, and the body would jump back under the cursor.
      const { groups, vp } = overlaid([])
      const [first] = await dragBody(vp, BODY, 'plate')

      // The re-stage: a NEW group, standing where the document now says.
      groups[BODY] = fakeGroup(first.delta)

      const [, second] = await dragBody(vp, BODY, 'plate')

      expect(second.delta).toEqual(first.delta)
      expect(at(groups[BODY]), 'the body jumped back under the hand')
        .toEqual(first.delta.map((v) => v * 2))
    })

    it('refuses the whole grab when a part of the model came with it', async () => {
      // The selection holds both. There is no gesture that is half a statement
      // about the build and half an edit of the proposal, so a mixed grab is
      // refused whole — the same all-or-nothing the copies of a row get.
      const { groups, vp } = overlaid(['/Group/lid', BODY])
      pickEntity.mockReturnValue({ id: '/Group/lid', name: 'lid', point: [0, 0, 0] })
      pointerDown(vp, [100, 100])
      pointerMove([300, 100])
      await settled()

      expect(vp.moved.size).toBe(0)
      for (const path of ['/Group/lid', BODY]) {
        expect(at(groups[path]), `${path} moved anyway`).toEqual([0, 0, 0])
      }
      expect(emitted(vp)).not.toContain(EVENT_MOVED)
      expect(emitted(vp)).not.toContain(EVENT_PROPOSALMOVE)
    })

    it('does not go under a press that missed, when its GROUP is selected', async () => {
      // THE GROUP ROW IS SELECTED FROM THE TREE, which is the door the scene's
      // own picking hides: nothing picks a group node under the cursor, but a
      // click on its row writes `sel` and the interface sends the node's OWN id
      // as the selection. A press that then MISSES the model hits `wanted[0]` —
      // the fallback that drags a standing selection from empty space — and the
      // library registers the group in `nestedGroup.groups` like any other.
      //
      // IT STANDS FOR NO BODY (`overlayBody` answers null for it), so there is
      // nothing for a report to name: the panel would be told `proposal` moved,
      // no node answers to that, and the body would be left displaced with the
      // document saying otherwise.
      const { groups, vp } = overlaid([GROUP])
      pickEntity.mockReturnValue(null)
      const event = pointerDown(vp, [100, 100])
      pointerMove([300, 100])
      await settled()

      expect(at(groups[GROUP]), 'the assembly followed the mouse')
        .toEqual([0, 0, 0])
      expect(vp.moved.size).toBe(0)
      expect(emitted(vp)).not.toContain(EVENT_MOVED)
      expect(emitted(vp)).not.toContain(EVENT_PROPOSALMOVE)
      expect(event.preventDefault).not.toHaveBeenCalled()
    })

    it('leaves a part of the model dragged under the same tool exactly as it was', async () => {
      // The other half of one gesture with two meanings, asserted HERE as well
      // as above because the fixture is the one with both kinds of part in it: a
      // press on the build still files the move, paths and count and all, and
      // says nothing about the proposal.
      const { groups, vp } = overlaid([])
      pickEntity.mockReturnValue({ id: '/Group/lid', name: 'lid', point: [0, 0, 0] })
      dragFrom(vp)
      pointerUp([300, 100])
      await settled()

      const [moved] = details(vp, EVENT_MOVED)
      expect(moved.id).toBe('/Group/lid')
      expect(moved.paths).toEqual(['/Group/lid'])
      expect(moved.count).toBe(1)
      expect(at(groups['/Group/lid'])).toEqual(moved.delta)
      expect(vp.moved.get('/Group/lid')).toEqual({ delta: moved.delta, turn: [0, 0, 0] })
      expect(emitted(vp)).not.toContain(EVENT_PROPOSALMOVE)
    })
  })
})
