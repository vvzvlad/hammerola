// ui/src/viewport/gizmo.js — the move tool's axis arrows.
//
// There is no GPU here and nothing below looks at a pixel, the same discipline
// handle.test.js keeps beside it. What IS assertable is everything that decides
// whether the reader can see and use the arrows at all: WHERE they are put (a
// projection, in px, of the selected part's centre), WHICH WAY each one points
// (the screen direction of its world axis), HOW LONG it is drawn (the
// foreshortening of that axis against the camera's projection axis), WHEN an
// arrow is taken off the screen — an axis seen end-on, and four different
// reasons for the whole widget — and what one whole drag does to the part and
// says at the end of it.
//
// THE ONE CLAIM THIS FILE EXISTS FOR is that a drag is CONSTRAINED: the free
// drag (tools.js) turns a screen gesture into a world displacement on all three
// axes at once, and an arrow takes the component along its own and drops the
// rest. Every drag below therefore travels diagonally, and the assertion is
// about what did NOT move.
//
// The arithmetic the angles and distances are checked against does not come from
// the module: this fake camera puts 20 px on a world unit along both screen axes
// (400 px per 20 halfW across, 300 px per 15 halfH up), so world +X reads 0
// degrees, world +Y reads -90 (screen y grows downwards and so does a CSS
// rotation), and world +Z — which this camera looks straight down — is the axis
// that has to disappear.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HmrViewport } from '../src/viewport/element.js'
import { EVENT_MOVED, EVENT_PROPOSALMOVE } from '../src/viewport/events.js'
import { createGizmo } from '../src/viewport/gizmo.js'
import { CLICK_PX, GIZMO_MIN_SCALE, GIZMO_PX } from '../src/viewport/options.js'
import {
  fakeGroup, fakeShapeSolid, fakeViewer, fakeViewport, orthoCamera,
} from './fakes.js'

const RECT = { left: 0, top: 0, width: 800, height: 600 }

const PART = '/Group/plate'

// -- the rAF loop, driven by hand ---------------------------------------------
// Same shape as handle.test.js: the module's loop re-arms itself from inside the
// frame it is running, so a snapshot is taken before the callbacks run and what
// they queue lands in the next one.
let frames = new Map()
let nextFrame = 0
const runFrames = () => {
  const due = [...frames.values()]
  frames.clear()
  for (const callback of due) callback(0)
}

const gizmos = []

beforeEach(() => {
  vi.clearAllMocks()
  frames = new Map()
  nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback) => {
    nextFrame += 1
    frames.set(nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id) => frames.delete(id))
})

afterEach(() => {
  // Before the next test dispatches on the window: a gizmo left standing would
  // leave a dead viewport's capture-phase listeners there to answer for it.
  while (gizmos.length) gizmos.pop().destroy()
  vi.unstubAllGlobals()
})

/** A solid whose world centre is `at`, as `partCentre` reads one: a bounding box
 *  computed off the tessellation and an identity `matrixWorld`. */
const solid = (name, at = [0, 0, 45]) => fakeShapeSolid(name, {
  positions: [at[0] - 5, at[1] - 5, at[2] - 5, at[0] + 5, at[1] + 5, at[2] + 5],
  index: [0, 1, 2],
})

/**
 * A viewport with the Move tool armed over a movable part, and the arrows
 * installed over it.
 *
 * Built on the real prototype so `activeTool`, `isOverlay` and `overlayBody` are
 * the element's own — a fake that re-implemented them would let this file agree
 * with itself instead of with the code, which is the same reason tools.test.js
 * builds its viewport this way.
 *
 * `box` is the container the placement is measured against — jsdom computes no
 * layout, so it is the same rect as the canvas and the two cancel, which is
 * exactly what they do on the page.
 */
function scene({
  selected = [PART], groups = { [PART]: solid(PART) }, camera, gridSize = 100,
  tool = 'move', overlay = null,
} = {}) {
  const viewer = fakeViewer({
    camera: camera || orthoCamera(), rect: RECT, groups, gridSize,
  })
  const vp = Object.create(HmrViewport.prototype)
  Object.assign(vp, fakeViewport(viewer, { tool, selected }))
  vp.holdActive = false
  // WHICH BUILD THE GEOMETRY IS OF — on a real element written in `show()`
  // beside the payload. A fixture that left it null would test a viewport that
  // has rendered nothing.
  vp.drawnKey = 'build-1'
  // The two fields `isOverlay` reads. Null and empty is a page with no proposal
  // panel open, where every path on screen is the model's own.
  vp.payload = overlay ? { name: 'Group', parts: [] } : null
  vp.overlayParts = overlay || []
  vp.box = { getBoundingClientRect: () => ({ ...RECT }) }
  vp.dispatchEvent = vi.fn()
  const gizmo = createGizmo(vp)
  gizmos.push(gizmo)
  gizmo.refresh()
  const [x, y, z] = gizmo.root.children
  return { viewer, vp, groups, gizmo, x, y, z }
}

/** Wake the loop and let one frame of it run. */
const drawn = (gizmo) => {
  gizmo.refresh()
  runFrames()
}

const shown = (arrow) => arrow.style.display !== 'none'

/** The rotation the module wrote, in degrees. */
const angleOf = (arrow) => {
  const match = /rotate\((-?[\d.e-]+)deg\)/.exec(arrow.style.transform)
  expect(match, `no rotation in ${arrow.style.transform}`).toBeTruthy()
  return Number(match[1])
}

/** How much of its length the arrow is drawn at, as a fraction of `GIZMO_PX`.
 *
 * READ OFF THE SAME ELEMENT THE ROTATION IS ON, which is the widget's geometry
 * rather than a shortcut in the test. The box takes the press and the shaft and
 * head are laid out against its edges, so its width IS the length of the arrow:
 * target and drawing are one thing along that axis. The section grip keeps them
 * apart — a wrapper inside a box that never changes size — because there is only
 * one grip and nothing behind it; three arrows meet at the part, and a box
 * outliving its ink would be an invisible tail lying across the neighbour drawn
 * before it.
 */
const inkOf = (arrow) => {
  // ASSERTED ON EVERY READ: the width means nothing unless the shaft and the
  // head are the box's own children. Moved back inside a wrapper, they would be
  // drawn at whatever the wrapper's width happened to be while the box went on
  // carrying a perfectly correct number.
  expect(arrow.children.length, 'the box holds the shaft and the head').toBe(2)
  const match = /^([\d.e-]+)px$/.exec(arrow.style.width)
  expect(match, `no width in ${arrow.style.width}`).toBeTruthy()
  return Number(match[1]) / GIZMO_PX
}

/** A press on one arrow, with both refusals watched. */
function grab(arrow, [clientX, clientY]) {
  const event = new MouseEvent('pointerdown', {
    clientX, clientY, bubbles: true, cancelable: true,
  })
  vi.spyOn(event, 'stopPropagation')
  vi.spyOn(event, 'preventDefault')
  arrow.dispatchEvent(event)
  return event
}

/** The rest of the gesture. It goes to the WINDOW, which is where the press put
 *  the listeners — a drag that starts on an arrow can end anywhere. */
const pointerMove = ([clientX, clientY]) =>
  window.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY }))
const pointerUp = ([clientX, clientY]) =>
  window.dispatchEvent(new MouseEvent('pointerup', { clientX, clientY }))
const pointerCancel = () =>
  window.dispatchEvent(new MouseEvent('pointercancel', {}))

/** What was carried by every event of one name, in the order they went out. */
const details = (vp, type) => vp.dispatchEvent.mock.calls
  .map(([event]) => event)
  .filter((event) => event.type === type)
  .map((event) => event.detail)

/** Where a group ended up, as three numbers. */
const at = (group) => [group.position.x, group.position.y, group.position.z]

/** One turn of the microtask queue — both reports are deferred by exactly one
 *  (`reportProposalMove` in tools.js says why). */
const settled = () => Promise.resolve()

/**
 * A DIAGONAL drag: 200 px right and 60 px down from the same start.
 *
 * In world terms that is +10 along X and -3 along Y (20 px to the world unit on
 * both screen axes), so the free drag would produce `[10, -3, 0]` and each arrow
 * has to produce one component of it and nothing else. A drag that went straight
 * along one screen axis would pass with no projection in the module at all.
 */
const dragDiagonally = () => {
  pointerMove([300, 160])
}

describe('when there is nothing to put arrows on', () => {
  it('draws nothing while no tool is armed', () => {
    // The arrows are the MOVE TOOL's, and a widget offering a drag the press
    // would not take is a promise the page cannot keep.
    const { vp, gizmo, x } = scene()
    drawn(gizmo)
    expect(shown(x), 'the premise: they are on screen with Move armed').toBe(true)

    vp.state = { ...vp.state, tool: null }
    drawn(gizmo)
    expect(shown(x)).toBe(false)
  })

  it('draws nothing while the hold key has the cut up', () => {
    // `activeTool` AND NOT `state.tool`: the hold key puts the cut up without
    // writing to `state`, so arrows read off the state field would stand there
    // offering a move while the very next press placed a section plane.
    const { vp, gizmo, x } = scene()
    drawn(gizmo)
    expect(shown(x)).toBe(true)

    vp.holdActive = true
    drawn(gizmo)
    expect(shown(x)).toBe(false)
  })

  it('draws nothing with an empty selection', () => {
    const { gizmo, x, y } = scene({ selected: [] })
    drawn(gizmo)
    expect(shown(x)).toBe(false)
    expect(shown(y)).toBe(false)
  })

  it('draws nothing when a selected path is one the scene cannot move', () => {
    // THE SAME GRABBABLE TEST `onDown` APPLIES, asked of EVERY path: one gesture
    // moves the whole row, and `movePart` refuses a row it cannot move whole. So
    // arrows over a selection carrying one path the scene has lost would advertise
    // a drag that then silently does nothing.
    const { gizmo, x } = scene({ selected: [PART, '/Group/gone'] })
    drawn(gizmo)
    expect(shown(x)).toBe(false)
  })

  it('draws nothing on a part whose centre the scene cannot give', () => {
    // A node of the tree carries no tessellation, so it has no box and no
    // centre (`partCentre`) — there is no point to stand the arrows on.
    const { gizmo, x } = scene({ groups: { [PART]: fakeGroup() } })
    drawn(gizmo)
    expect(shown(x)).toBe(false)
  })

  it('takes no gesture from an arrow the next frame would remove', () => {
    // Both halves of the module have to agree about what is grabbable — `place`
    // takes the arrow off and `onDown` takes no gesture — or a press would land
    // on an arrow that is on screen only until the next frame.
    const { vp, gizmo, x } = scene()
    drawn(gizmo)
    vp.state = { ...vp.state, selected: [] }

    grab(x, [100, 100])
    dragDiagonally()

    expect(vp.moved.size).toBe(0)
  })
})

describe('where the arrows are drawn', () => {
  it('stands every one of them on the part`s centre, in canvas pixels', () => {
    // The part's box is centred on the view axis, so it projects to the middle
    // of an 800x600 canvas.
    const { gizmo, x, y } = scene()
    drawn(gizmo)

    for (const arrow of [x, y]) {
      expect(shown(arrow)).toBe(true)
      expect(arrow.style.left).toBe('400px')
      expect(arrow.style.top).toBe('300px')
      // THE TAIL IS THE FIXED POINT, not the middle: an arrow stands ON the part
      // and points away along its axis, so the box is lifted by half its height
      // and turned about the middle of its left edge.
      expect(arrow.style.transform.startsWith('translate(0,-50%)')).toBe(true)
      expect(arrow.style.transformOrigin).toBe('0 50%')
    }
  })

  it('follows the part off centre', () => {
    // Four world units along +X at 20 px each is 80 px right of the middle.
    const { gizmo, x } = scene({ groups: { [PART]: solid(PART, [4, 0, 45]) } })
    drawn(gizmo)

    expect(x.style.left).toBe('480px')
    expect(x.style.top).toBe('300px')
  })
})

describe('which way they point', () => {
  it('lies along the screen direction of its own world axis', () => {
    // The camera looks down -Z with +X to the right and +Y up, and a CSS
    // rotation turns the way screen y runs — so +Y reads -90 rather than +90.
    const { gizmo, x, y } = scene()
    drawn(gizmo)

    expect(angleOf(x)).toBeCloseTo(0, 9)
    expect(angleOf(y)).toBeCloseTo(-90, 9)
  })

  it('turns with the camera and not with the world', () => {
    // A camera basis rolled by 30 degrees. The world axes are unchanged; what
    // moves is the screen they are seen on, which is the only thing the
    // projection knows about. Both screen axes are 20 px per world unit here, so
    // the tilt is not distorted.
    const roll = Math.PI / 6
    const camera = orthoCamera({
      right: [Math.cos(roll), Math.sin(roll), 0],
      up: [-Math.sin(roll), Math.cos(roll), 0],
      forward: [0, 0, -1],
    })
    const { gizmo, x } = scene({ camera })
    drawn(gizmo)

    expect(angleOf(x)).toBeCloseTo(30, 6)
  })
})

describe('how long they are drawn', () => {
  it('draws an axis square across the view at its full length', () => {
    const { gizmo, x, y } = scene()
    drawn(gizmo)
    expect(inkOf(x)).toBeCloseTo(1, 9)
    expect(inkOf(y)).toBeCloseTo(1, 9)
  })

  it('takes the axis the reader is looking down off the screen entirely', () => {
    // THE DECISION THIS WIDGET DIFFERS FROM THE SECTION GRIP ON. The grip floors
    // its ink and the stub still drags, because the fallback it drags on is a
    // different axis. An axis arrow has no fallback: the world displacement a
    // screen gesture spans lies in the plane of the screen, so an axis pointing
    // at the reader takes almost nothing from it however far the hand goes. A
    // floored stub would be a visible control that does not move the part.
    const { gizmo, x, y, z } = scene()
    drawn(gizmo)

    expect(shown(x), 'the premise: the other two are up').toBe(true)
    expect(shown(y)).toBe(true)
    expect(shown(z)).toBe(false)
  })

  it('foreshortens the three together on an oblique camera', () => {
    // Looking down the diagonal: each axis sits at the same angle to the
    // camera's projection axis, so all three are drawn at `sqrt(2/3)` — well
    // clear of the floor, so what is pinned is the PROPORTION rather than the
    // threshold.
    const camera = orthoCamera({
      right: [1, -1, 0], up: [1, 1, -2], forward: [-1, -1, -1],
    })
    const { gizmo, x, y, z } = scene({ camera })
    drawn(gizmo)

    for (const arrow of [x, y, z]) {
      expect(shown(arrow)).toBe(true)
      expect(inkOf(arrow)).toBeCloseTo(Math.sqrt(2 / 3), 9)
      expect(Math.sqrt(2 / 3)).toBeGreaterThan(GIZMO_MIN_SCALE)
    }
  })

  it('shortens the box that takes the press along with the arrow', () => {
    // WHERE THIS PARTS COMPANY WITH THE SECTION GRIP, and the reason is that
    // there are three of these. The grip holds its target at full length so it
    // stays easy to hit where it collapses, and nothing is behind it to take the
    // press from. Here a box longer than its ink lies invisibly across the
    // arrows drawn before it — the reader presses the one they can see and drags
    // the one they cannot, since the three are siblings with no `z-index` and
    // the last built wins.
    const square = scene()
    drawn(square.gizmo)
    const oblique = scene({
      camera: orthoCamera({ right: [1, -1, 0], up: [1, 1, -2], forward: [-1, -1, -1] }),
    })
    drawn(oblique.gizmo)

    expect(inkOf(oblique.x)).toBeLessThan(inkOf(square.x))
    expect(Number.parseFloat(oblique.x.style.width))
      .toBeLessThan(Number.parseFloat(square.x.style.width))
    // ACROSS the arrow nothing shrinks: the press is still taken over the full
    // `GIZMO_HIT_PX`, against a shaft of two.
    expect(oblique.x.style.height).toBe(square.x.style.height)
    expect(oblique.x.style.pointerEvents).toBe('auto')
  })
})

describe('one whole drag', () => {
  it('moves the part along the axis grabbed and along nothing else', async () => {
    // THE WHOLE POINT OF THE WIDGET. The same gesture drives both arrows below;
    // free, it would have produced `[10, -3, 0]`, which is a delta on two axes
    // from a hand that named one.
    const across = scene()
    drawn(across.gizmo)
    const press = grab(across.x, [100, 100])
    // The press is kept off the canvas — belt and braces beside tools.js's own
    // `event.target !== g.canvas` — and the compatibility mouse events with it.
    expect(press.stopPropagation).toHaveBeenCalled()
    expect(press.preventDefault).toHaveBeenCalled()
    dragDiagonally()

    expect(at(across.groups[PART])).toEqual([10, 0, 0])

    const up = scene()
    drawn(up.gizmo)
    grab(up.y, [100, 100])
    dragDiagonally()

    expect(at(up.groups[PART])).toEqual([0, -3, 0])
  })

  it('moves nothing at all for a drag square across its own axis', () => {
    // The projection of a displacement perpendicular to the axis is zero, which
    // is the other half of "along that axis only": the part stands still rather
    // than creeping.
    const { gizmo, groups, x } = scene()
    drawn(gizmo)

    grab(x, [100, 100])
    pointerMove([100, 160])

    expect(at(groups[PART])).toEqual([0, 0, 0])
  })

  it('says where the part ended up once, and only when the hand comes off', async () => {
    // THE RELEASE IS THE ONLY REPORT, and it is the same one the canvas drag
    // ends in: the interface answers a recorded move by opening the panel, which
    // re-stages, and a re-stage ends the gesture the reader has not let go of.
    const { vp, gizmo, x } = scene()
    drawn(gizmo)

    grab(x, [100, 100])
    dragDiagonally()
    await settled()
    expect(details(vp, EVENT_MOVED), 'it spoke mid-drag').toEqual([])

    pointerUp([300, 160])
    await settled()

    const reports = details(vp, EVENT_MOVED)
    expect(reports).toHaveLength(1)
    expect(reports[0].delta).toEqual([10, 0, 0])
    expect(reports[0].paths).toEqual([PART])
    expect(reports[0].build).toBe('build-1')

    // And the gesture really ended: the window listeners went with it, so a
    // pointer that moves on past the release moves no part.
    pointerMove([500, 160])
    expect(at(vp.viewer.nestedGroup.groups[PART])).toEqual([10, 0, 0])
  })

  it('rounds to the same step the free drag rounds to', async () => {
    // ONE VOCABULARY FOR ONE DOCUMENT. `niceStep` and `snap` are imported from
    // tools.js rather than copied, so a 20 mm assembly lands on tenths here
    // exactly as it does under a free drag — `0.6` and not the
    // `0.6000000000000001` six steps of a tenth come to in binary.
    const { vp, gizmo, groups, x } = scene({ gridSize: 20 })
    drawn(gizmo)

    grab(x, [100, 100])
    pointerMove([112, 160])
    pointerUp([112, 160])
    await settled()

    expect(details(vp, EVENT_MOVED)[0].delta).toEqual([0.6, 0, 0])
    expect(vp.moved.get(PART)).toEqual({ delta: [0.6, 0, 0], turn: [0, 0, 0] })
    expect(at(groups[PART])).toEqual([0.6, 0, 0])
  })

  it('ignores every button but the primary one', () => {
    // The right button is a gesture of its own on this page — it opens the part
    // menu, and the library pans on it.
    const { vp, gizmo, groups, x } = scene()
    drawn(gizmo)

    const press = new MouseEvent('pointerdown', {
      button: 2, clientX: 100, clientY: 100, bubbles: true, cancelable: true,
    })
    vi.spyOn(press, 'preventDefault')
    x.dispatchEvent(press)
    // Not even the refusals: a press this one does not want is a press it has no
    // business taking away from anybody else.
    expect(press.preventDefault).not.toHaveBeenCalled()

    dragDiagonally()
    expect(at(groups[PART])).toEqual([0, 0, 0])
    expect(details(vp, EVENT_MOVED)).toEqual([])
  })

  it('says nothing when the press never moved', async () => {
    // A bare click on an arrow is not a placement: reported, it would write a
    // node the document already has and open the panel to show the reader
    // nothing new.
    const { vp, gizmo, x } = scene()
    drawn(gizmo)

    grab(x, [100, 100])
    pointerUp([100, 100])
    await settled()

    expect(details(vp, EVENT_MOVED)).toEqual([])
  })

  it('does nothing for a hand that shook, and everything a pixel later', async () => {
    // A CLICK IS NOT A ONE-PIXEL DRAG, which the canvas gesture spells out and
    // this one has to spell the same way. Below `CLICK_PX` there is nothing the
    // reader could have meant: nothing selects on an arrow, so the only thing a
    // twitch between press and release can do is snap the part a step and file a
    // move node — and the interface answers a filed move by opening the panel.
    //
    // A GRID THAT MAKES THE TWITCH COUNT: at 20 the step is a tenth and 20 px go
    // to the world unit, so three pixels is already three steps. Measured with a
    // step too coarse to cross, this test would pass with no threshold at all.
    const { vp, gizmo, groups, x } = scene({ gridSize: 20 })
    drawn(gizmo)
    grab(x, [100, 100])

    pointerMove([100 + CLICK_PX - 1, 100 + CLICK_PX - 1])
    expect(at(groups[PART]), 'still a click').toEqual([0, 0, 0])
    pointerUp([100 + CLICK_PX - 1, 100 + CLICK_PX - 1])
    await settled()
    expect(details(vp, EVENT_MOVED)).toEqual([])

    // And one pixel past it the same gesture is a drag, carrying the whole
    // travel from the PRESS rather than from where the threshold was crossed —
    // the part must not lag the hand by the width of the dead zone.
    grab(x, [100, 100])
    pointerMove([100 + CLICK_PX, 100])
    expect(at(groups[PART])).toEqual([CLICK_PX / 20, 0, 0])
  })

  it('keeps the part under the cursor on an oblique camera', async () => {
    // THE ONE THING DIRECT MANIPULATION HAS TO GET RIGHT, and the arithmetic
    // that gets it wrong is invisible face-on. The world vector a screen
    // displacement spans lies IN the plane of the screen, so of the axis it sees
    // only the part lying there too — `sine` of it. Walking the part by `t`
    // moves its projection by `t * sine`, and dotting that with the axis takes
    // another `sine`: a bare dot answers `t * sine^2`. Every other drag in this
    // file looks square down an axis, where `sine` is 1 and the error cannot
    // show; here it is `sqrt(2/3)`, so a missing division leaves the part at two
    // thirds of where the hand went.
    const camera = orthoCamera({
      right: [1, -1, 0], up: [1, 1, -2], forward: [-1, -1, -1],
    })
    const { vp, gizmo, groups, x } = scene({ camera })
    drawn(gizmo)

    grab(x, [100, 100])
    dragDiagonally()
    pointerUp([300, 160])
    await settled()

    // The gesture's world displacement, rebuilt from the basis this test
    // declares rather than taken from the module: 10 units along `right` and -3
    // along `up`, at the 20 px to the world unit this fixture's camera gives.
    // `dragDiagonally`'s `[10, -3, 0]` is the SQUARE-ON camera's answer and not
    // this one's.
    const unit = (v) => v.map((c) => c / Math.hypot(...v))
    const right = unit([1, -1, 0])
    const up = unit([1, 1, -2])
    const world = right.map((v, i) => v * 10 + up[i] * -3)
    const step = 0.5
    const round = (v) => Math.round(v / step) * step
    // Dotted with X — which is `world[0]` — and divided by `sine^2`.
    const along = round(world[0] / (2 / 3))

    expect(at(groups[PART])).toEqual([along, 0, 0])
    expect(details(vp, EVENT_MOVED)[0].delta).toEqual([along, 0, 0])
    // NOT WHAT A BARE DOT ANSWERS, which is the whole of the defect and the
    // reason this camera is here: face-on the two are the same number.
    expect(round(world[0])).not.toBe(along)
  })

  it('leaves the two axes it is not on exactly as it found them', async () => {
    // AN OFFSET ALREADY STANDING NEED NOT BE ON THIS GRID. It comes from the
    // proposal document, whose `delta.<axis>` fields the reader types by hand —
    // so passing all three components through `snap` rounds the two this gesture
    // never touched. A drag along X would then move the part along Y as well and
    // report it, a number written as 12.3 coming back as 12.5.
    const { vp, gizmo, groups, x } = scene({ gridSize: 20 })
    drawn(gizmo)
    vp.moved.set(PART, { delta: [0, 12.34, -0.07], turn: [0, 0, 0] })

    grab(x, [100, 100])
    pointerMove([120, 100])
    pointerUp([120, 100])
    await settled()

    expect(at(groups[PART])).toEqual([1, 12.34, -0.07])
    expect(details(vp, EVENT_MOVED)[0].delta).toEqual([1, 12.34, -0.07])
  })

  it('is concluded when the pointer is taken away', async () => {
    // A MOVE IS REPORTED FROM EVERY ENDING, which is where this parts company
    // with the section grip: a cancelled cut is dropped, and a cancelled move
    // leaves the part standing somewhere the document does not claim, so the
    // next reconcile would send it home and the drag would be silently undone.
    const { vp, gizmo, x } = scene()
    drawn(gizmo)

    grab(x, [100, 100])
    dragDiagonally()
    pointerCancel()
    await settled()

    expect(details(vp, EVENT_MOVED)).toHaveLength(1)

    // And it really ended.
    pointerMove([500, 160])
    expect(details(vp, EVENT_MOVED)).toHaveLength(1)
  })

  it('concludes a drag the scene is being pulled out from under', async () => {
    // The twin of `vp.endGesture`, and the reason it is a third call rather than
    // the same one: the press landed on a sibling of `vp.box`, so neither that
    // gesture nor the idle clock that defers the swap ever saw it.
    const { vp, gizmo, x } = scene()
    drawn(gizmo)

    grab(x, [100, 100])
    dragDiagonally()

    gizmo.endDrag()
    expect(details(vp, EVENT_MOVED), 'the report went out inside the render')
      .toEqual([])

    await settled()
    expect(details(vp, EVENT_MOVED)).toHaveLength(1)

    // And the release that never came cannot report a second time.
    pointerUp([300, 160])
    await settled()
    expect(details(vp, EVENT_MOVED)).toHaveLength(1)
  })

  it('is concluded when another press arrives with it still live', async () => {
    const { vp, gizmo, x, y } = scene()
    drawn(gizmo)

    grab(x, [100, 100])
    dragDiagonally()
    grab(y, [300, 160])
    await settled()

    expect(details(vp, EVENT_MOVED)).toHaveLength(1)
    pointerUp([300, 160])
  })

  it('edits the panel`s document for a body the proposal staged', async () => {
    // THE SECOND MEANING OF THE SAME GESTURE, and the arrows reach it through
    // the same `reportMove` the canvas drag does. A body of the proposal is the
    // reader's OWN drawing: it moves for the eye alone while the hand is down,
    // nothing is recorded for it, and the release names the body to the panel.
    const BODY = '/Group/proposal/plate'
    const { vp, gizmo, groups, x } = scene({
      selected: [BODY],
      groups: { [BODY]: solid(BODY) },
      overlay: [{ name: 'plate' }],
    })
    drawn(gizmo)
    expect(shown(x), 'the premise: a body is grabbable like any part').toBe(true)

    grab(x, [100, 100])
    dragDiagonally()
    pointerUp([300, 160])
    await settled()

    const [report] = details(vp, EVENT_PROPOSALMOVE)
    expect(report.name).toBe('plate')
    expect(report.delta).toEqual([10, 0, 0])
    expect(at(groups[BODY])).toEqual([10, 0, 0])
    // And none of what a part of the build leaves behind.
    expect(vp.moved.size, 'an offset was written for it').toBe(0)
    expect(vp.partHome.size, 'a home was remembered for it').toBe(0)
    expect(details(vp, EVENT_MOVED)).toEqual([])
  })

  it('stays on the part while the drag runs', async () => {
    // What makes this a widget the reader is holding rather than a picture
    // beside one: the anchor reads the SCENE every frame. The part's group has
    // moved by here, and the arrows are drawn from where it now stands.
    const { vp, gizmo, groups, x } = scene()
    drawn(gizmo)
    expect(x.style.left).toBe('400px')

    grab(x, [100, 100])
    dragDiagonally()
    // The scene's own matrix is what `partCentre` reads, and only a real render
    // refreshes it — so the fake is walked by hand to the place the group now
    // claims, which is what the library would have written.
    groups[PART].front.matrixWorld.elements[12] = at(groups[PART])[0]
    drawn(gizmo)

    // Ten world units at 20 px each, and nothing has been reported yet.
    expect(details(vp, EVENT_MOVED)).toEqual([])
    expect(x.style.left).toBe('600px')
  })
})
