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
import { EVENT_FACE, EVENT_MENU, EVENT_MOVED, EVENT_PICK } from '../src/viewport/events.js'
import { internals } from '../src/viewport/internals.js'
import { CLICK_PX } from '../src/viewport/options.js'
import { faceNormalAt, pickEntity } from '../src/viewport/picking.js'
import { placeSectionPlane, sectionOffset } from '../src/viewport/section.js'
import { installTools } from '../src/viewport/tools.js'
import { fakeGroup, fakeViewer, fakeViewport } from './fakes.js'

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

describe('the right button: a menu or a pan', () => {
  const PLATE = { id: '/model/plate', name: 'plate', point: [1, 2, 3] }

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
    return { groups, vp }
  }

  /** Where a group ended up, as three numbers. */
  const at = (group) => [group.position.x, group.position.y, group.position.z]

  /** A press on the canvas and a drag of 200 px across it. */
  const dragFrom = (vp) => {
    pointerDown(vp, [100, 100])
    pointerMove([300, 100])
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

  it('reports how many went, so the chip does not claim the whole row', () => {
    const { vp } = moving(PINS)
    pickEntity.mockReturnValue({ id: PINS[0], name: 'pin', point: [0, 0, 0] })
    dragFrom(vp)

    const [first] = details(vp, EVENT_MOVED)
    expect(first.count).toBe(2)
    expect(first.id).toBe(PINS[0])
  })

  it('takes the one part that was grabbed when nothing is selected', () => {
    // The viewport is told which paths are selected and knows nothing about the
    // rest, so a grab out of the blue moves what was grabbed. The pick this
    // press emits is what puts the whole row under the next drag.
    const { groups, vp } = moving([])
    pickEntity.mockReturnValue({ id: PINS[0], name: 'pin', point: [0, 0, 0] })
    dragFrom(vp)

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
    function droveOneCopy(grabbed) {
      const { groups, vp } = moving([])
      pickEntity.mockReturnValue({ id: grabbed, name: 'pin', point: [0, 0, 0] })
      dragFrom(vp)
      pointerUp([300, 100])

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

    it('leaves the grabbed copy where it was and brings the row to it', () => {
      // The reader keeps hold of the SECOND copy — the one carrying the offset
      // — so it must not snap back towards home under the cursor. The same
      // travel a second time therefore lands it at twice the first delta, which
      // is exactly what a jump home would not do.
      const { groups, vp, first } = droveOneCopy(PINS[1])
      expect(at(groups[PINS[0]]), 'the sibling came along on the first drag')
        .toEqual([0, 0, 0])

      dragFrom(vp)

      const delta = lastDelta(vp)
      expect(delta).toEqual(first.delta.map((v) => v * 2))
      expect(at(groups[PINS[1]]), 'the copy under the hand jumped').toEqual(delta)
      expect(at(groups[PINS[0]]), 'the row did not close up').toEqual(delta)
    })

    it('does the same when the grabbed copy is the row\'s first', () => {
      // The other side of the rule, and the case where the anchor and the
      // `wanted[0]` it falls back to are the same path — so this one cannot
      // fail on that regression, and the test above is what does. It is here
      // because "the copy under the hand" has to hold whichever copy that is:
      // an anchor read off the END of the list passes the test above — where
      // the end and the grabbed copy are the same path — and fails this one.
      const { groups, vp, first } = droveOneCopy(PINS[0])

      dragFrom(vp)

      const delta = lastDelta(vp)
      expect(delta).toEqual(first.delta.map((v) => v * 2))
      expect(at(groups[PINS[0]]), 'the copy under the hand jumped').toEqual(delta)
      expect(at(groups[PINS[1]])).toEqual(delta)
    })
  })

  it('refuses the whole row when one copy of it is not in the scene', () => {
    // All or nothing: half a row moved is two copies of one part standing in
    // different places under a chip that calls it a move of the row. Refused at
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
})
