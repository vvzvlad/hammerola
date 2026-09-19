// ui/src/viewport/rings.js — the move tool's three rotation handles.
//
// There is no GPU here and nothing below looks at a pixel, the same discipline
// gizmo.test.js and handle.test.js keep beside it. What IS assertable is
// everything that decides whether the reader can see and use the rings at all:
// WHERE they are put (a projection, in px, of the selected part's centre), the
// SHAPE each one is drawn as (the 2x2 matrix that turns a unit circle into the
// projected ellipse), HOW MUCH of it is drawn — an arc through the handle at
// rest, the whole circle under the cursor — WHEN one is taken off the screen
// (a ring seen edge-on, and five different reasons for the whole widget),
// WHICH ring a press lands on, and what one whole drag does to the part and
// says at the end of it.
//
// THE PRESS BELONGS TO THE DISC, which is what most of the middle of this file
// is now about. Three full circles of one radius about one point cross six
// times and knot where they meet, so the reader could not hit the axis they
// meant; the module answers with one compact handle per axis, at the parameter
// bisecting its ring's two world axes, and takes the press THERE and nowhere
// else. So the two halves of that are pinned: a press on the curve away from
// the handle is left for the trackball, and the three handles land in three
// different places under one camera.
//
// THE ONE CLAIM THIS FILE EXISTS FOR IS THE SIGN. A ring can be drawn perfectly,
// hit perfectly and read perfectly and still turn the part the wrong way: the
// screen's y axis points down, the projection flips a ring seen from behind, and
// `atan2` knows nothing about either. The module answers by measuring the angle
// in CIRCLE SPACE — the pointer mapped back through the ellipse's own basis —
// and the tests below pin the two halves of that: which pair of world axes spans
// each ring (`turnsAboutTheAxisItIsDrawnFor`, through the matrix the module
// writes) and where a part really ends up after a quarter turn.
//
// AND NOT ONLY ON THE Z RING UNDER THE DEFAULT CAMERA, which is the one
// arrangement where the ring's own `(u, v)` and the screen's axes line up — and
// therefore the one arrangement a sign taken off screen pixels would also get
// right. The last describe is the rest of the claim: the X and the Y ring, a
// ring watched from the far side of its own plane, and a part that was already
// standing turned when the hand arrived.
//
// The arithmetic is not taken from the module. This fake camera puts 20 px on a
// world unit along both screen axes (400 px per 20 halfW across, 300 px per 15
// halfH up), so the ring radius `RING_PX / 20` is 5.25 world units, world +X
// reads as +105 px across the screen and world +Y as -105 px up it — which
// makes the Z ring, seen square on, the circle `matrix(105, 0, 0, -105, 0, 0)`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HmrViewport } from '../src/viewport/element.js'
import {
  EVENT_MOVED, EVENT_PROPOSALTURN, EVENT_TURNED,
} from '../src/viewport/events.js'
import { createGizmo } from '../src/viewport/gizmo.js'
import { createRings } from '../src/viewport/rings.js'
import { cross3 } from '../src/viewport/math.js'
import { after, quaternionOf, turned } from '../src/viewport/parts.js'
import {
  CLICK_PX, RING_ARC_DEG, RING_CASE_PX, RING_DISC_PX, RING_PX, RING_RIM_PX,
  RING_SHAFT_PX,
} from '../src/viewport/options.js'
import {
  fakeGroup, fakeShapeSolid, fakeViewer, fakeViewport, orthoCamera,
} from './fakes.js'

const RECT = { left: 0, top: 0, width: 800, height: 600 }

const PART = '/Group/plate'

/** Looking down the diagonal, where all three rings are open enough to aim at.
 *  gizmo.test.js uses the same basis for the same reason: every axis sits at
 *  the same angle to the camera, so nothing in the answer depends on which of
 *  the three is being asked about. */
const OBLIQUE = { right: [1, -1, 0], up: [1, 1, -2], forward: [-1, -1, -1] }

// -- the rAF loop, driven by hand ---------------------------------------------
// Same shape as gizmo.test.js: the module's loop re-arms itself from inside the
// frame it is running, so a snapshot is taken before the callbacks run and what
// they queue lands in the next one.
let frames = new Map()
let nextFrame = 0
const runFrames = () => {
  const due = [...frames.values()]
  frames.clear()
  for (const callback of due) callback(0)
}

const layers = []

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
  // Before the next test dispatches anything: a layer left standing would leave
  // a dead viewport's capture-phase listeners on the window — and this one keeps
  // a `pointerdown` there for its whole life rather than only while a gesture
  // runs, so it would answer for every press the next test makes.
  while (layers.length) layers.pop().destroy()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

/** A solid whose world centre is `at`, as `partCentre` reads one: a bounding box
 *  computed off the tessellation and an identity `matrixWorld`. */
const solid = (name, at = [0, 0, 45]) => fakeShapeSolid(name, {
  positions: [at[0] - 5, at[1] - 5, at[2] - 5, at[0] + 5, at[1] + 5, at[2] + 5],
  index: [0, 1, 2],
})

/**
 * A viewport with the Move tool armed over a movable part, and the rings
 * installed over it.
 *
 * `move` AND NOT A TOOL OF THEIR OWN, which is the whole of what the merge
 * changed in this file. The rings are one half of a single manipulator — the
 * arrows, the plane quads and the origin dot are the other — and both halves
 * answer to the tool that puts the widget on the part.
 *
 * Built on the real prototype so `activeTool`, `isOverlay` and `overlayBody` are
 * the element's own — a fake that re-implemented them would let this file agree
 * with itself instead of with the code.
 *
 * THE CANVAS IS A REAL NODE HERE, which is the one thing this fixture does that
 * gizmo.test.js's does not have to. An arrow takes its own press, so that file
 * dispatches at the arrow; this layer takes NO press at all (a div is a filled
 * box however round it is made, so three handles would take the presses aimed
 * past their corners) and reads the canvas's own press in the capture phase. So
 * the press has to be an event the DOM really dispatched at the canvas, and the
 * fake's canvas is a plain object. The rect is stubbed onto it because jsdom
 * computes no layout — the same rect as `box`, so the two cancel exactly as
 * they do on the page.
 */
function scene({
  selected = [PART], groups = { [PART]: solid(PART) }, camera, gridSize = 100,
  tool = 'move', overlay = null,
} = {}) {
  const viewer = fakeViewer({
    camera: camera || orthoCamera(), rect: RECT, groups, gridSize,
  })
  const canvas = document.createElement('div')
  canvas.getBoundingClientRect = () => ({ ...RECT })
  document.body.appendChild(canvas)
  viewer.canvas = canvas
  viewer.renderer.domElement = canvas

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
  // THE OTHER HALF OF THE WIDGET, as `element.js` hangs it on the element. A
  // press on the canvas ends the arrows' gesture as well as this layer's — one
  // tool means both can be live at once, and two live drags on one part
  // overwrite each other (`onDown`). A stub by default, replaced with the real
  // layer by the tests that run the pair against each other.
  vp.gizmo = { refresh: vi.fn(), endDrag: vi.fn(), destroy: vi.fn() }
  // AND THE DOOR ONTO THE CANVAS GESTURE, which `installTools` publishes on the
  // element. A press this layer KEEPS ends that too, because `stopPropagation`
  // is what stops tools.js's own `onDown` concluding it.
  vp.endGesture = vi.fn()
  const rings = createRings(vp)
  layers.push(rings)
  vp.rings = rings
  rings.refresh()
  const [x, y, z] = rings.root.children
  return { viewer, vp, groups, canvas, rings, x, y, z }
}

/** Wake the loop and let one frame of it run. */
const drawn = (rings) => {
  rings.refresh()
  runFrames()
}

const shown = (ring) => ring.style.display !== 'none'

/** One of the six circles an axis is drawn out of, by name.
 *
 * THE OUTERMOST OF THEM IS THE AXIS'S OWN ELEMENT — the arc's dark rim — and
 * the other five are laid inside it, in ITS coordinates, so that one matrix
 * moves the whole widget (`build` in rings.js). Which is why everything below
 * that asks where a ring is asks the group itself: the matrix it carries is the
 * ring's own `(a, b)`, and the five children are boxes in local pixels that the
 * browser puts through it.
 *
 * `pieces` IN rings.js IS THE ORDER, outermost first: the curve's dark rim, its
 * white casing and its ink, then the disc's three the same way round. Named
 * here rather than indexed at the call sites, because `children[3]` in an
 * assertion about a casing is a test nobody can check by reading.
 */
const AT = { arcCase: 0, arc: 1, discRim: 2, discCase: 3, disc: 4 }
const piece = (group, name) =>
  (name === 'arcRim' ? group : group.children[AT[name]])

/** A circle's radius and its stroke, in pixels at the ring's widest point.
 *  Both are written in LOCAL pixels, which the matrix multiplies by `RING_PX`
 *  — so both come back out by multiplying by it here. */
const radiusOf = (el) => (Number.parseFloat(el.style.width) / 2) * RING_PX
const bandOf = (el) => Number.parseFloat(el.style.borderTopWidth) * RING_PX

/** The four numbers of the matrix the module wrote: `[a.x, a.y, b.x, b.y]`.
 *
 * READ AS TWO COLUMNS AND NOT AS FOUR NUMBERS, which is what several of the
 * assertions below are really about: the first pair is where the ring's `u`
 * axis lands on the screen and the second is where its `v` does, so the ORDER
 * of the two is the handedness of the whole gesture. Swap them and exactly the
 * same ellipse is drawn.
 */
const matrixOf = (ring) => {
  const match = /matrix\(([^)]+)\)/.exec(ring.style.transform)
  expect(match, `no matrix in ${ring.style.transform}`).toBeTruthy()
  // The last two are the translation, which is always zero: the centring is
  // `translate(-50%,-50%)` in front of this, and the part's own place is
  // `left`/`top`.
  const numbers = match[1].split(',').map(Number)
  expect(numbers.slice(4)).toEqual([0, 0])
  return numbers.slice(0, 4)
}

/** The same four, checked against a hand-worked answer rather than compared —
 *  every one of them is the end of a chain of projections, so `-0` and a part
 *  in 10^-14 are the shapes an exact comparison would fail on. */
const expectMatrix = (ring, wanted) => {
  const got = matrixOf(ring)
  got.forEach((value, at) => expect(value).toBeCloseTo(wanted[at], 9))
}

/** Where the module put one circle on the layer, in pixels. NOT assumed to be
 *  the middle of the canvas: a part sits where the camera puts it, and only a
 *  camera looking straight at the part's centre puts it there. */
const centreOf = (ring) => [Number.parseFloat(ring.style.left),
                            Number.parseFloat(ring.style.top)]

/** The same, against a hand-worked answer — a projection's worth of floating
 *  point away from it, exactly as `expectMatrix` allows for. */
const expectSpot = (ring, wanted) => centreOf(ring)
  .forEach((value, at) => expect(value).toBeCloseTo(wanted[at], 6))

/** A point ON one ring's drawn curve, at the ring's own circle-space angle `t`.
 *
 * BUILT OUT OF THE MATRIX AND THE CENTRE THE MODULE ITSELF WROTE, so a press
 * there really lands on the ellipse instead of near where one was expected —
 * which is what lets the drags below aim at a ring the camera has squashed, and
 * aim at it AWAY from the six points where the three rings cross. `t` is the
 * angle in the plane the ring's `(u, v)` spans, so sweeping it by `+pi/2` is a
 * positive quarter turn about that ring's own axis whatever the camera is
 * doing to the picture. */
const onRing = (ring, t) => {
  const [ax, ay, bx, by] = matrixOf(ring)
  const C = centreOf(ring)
  return [C[0] + Math.cos(t) * ax + Math.sin(t) * bx,
          C[1] + Math.cos(t) * ay + Math.sin(t) * by]
}

/** Where each ring carries its disc, in its own circle space: the bisector of
 *  the two world axes spanning its plane, which is 45 degrees from `u` towards
 *  `v`. Hand-worked like everything else here — the module's own `DISC_AT`.
 *
 * WHICH IS ALSO HALFWAY BETWEEN TWO CROSSINGS, and that is the point of it:
 * the three rings meet at the six world axes, every multiple of `pi/2` in each
 * ring's own parametrisation, so a handle at 45 degrees is as far from its
 * neighbours as the circle allows. */
const DISC_T = Math.PI / 4

/** The middle of one axis's disc, in canvas pixels: the point of its own curve
 *  at `DISC_T`, read off the matrix the module wrote so that a press there
 *  lands on the handle whatever the camera has done to the picture. */
const onDisc = (group) => onRing(group, DISC_T)

/** How far a canvas point is from one axis's disc, IN THAT RING'S OWN PLANE and
 *  in units of the disc's own radius — under 1 is a point on the handle.
 *
 * THE INVERSE OF THE SAME 2x2, hand-worked here as everything else in this file
 * is: inverting the basis is what undoes the camera (`circleSpace`), and a disc
 * that is a circle in the ring's plane is a circle again once it has been
 * undone. It exists for one test — the one where two handles overlap, where
 * "both of them really do answer" is the premise the assertion rests on and
 * cannot be read off the picture. */
const intoDisc = (group, point) => {
  const [ax, ay, bx, by] = matrixOf(group)
  const C = centreOf(group)
  const det = ax * by - ay * bx
  const dx = point[0] - C[0]
  const dy = point[1] - C[1]
  const x = (by * dx - bx * dy) / det
  const y = (ax * dy - ay * dx) / det
  return Math.hypot(x - Math.cos(DISC_T), y - Math.sin(DISC_T))
    / (RING_DISC_PX / 2 / RING_PX)
}

/** What one axis is masked with. At rest it carries the conic fade — which
 *  reaches the five circles inside it, the mask being a property of the whole
 *  subtree — and under the cursor it is drawn whole. */
const fade = (group) => group.style.maskImage
const faded = (group) => fade(group).startsWith('conic-gradient')

/** How light the disc's own ink is, as the sum of its three channels — which is
 *  all "the disc lightens" needs, and it needs no second copy of the hexes. */
const brightness = (el) => {
  const match = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(el.style.backgroundColor)
  expect(match, `no colour in ${el.style.backgroundColor}`).toBeTruthy()
  return Number(match[1]) + Number(match[2]) + Number(match[3])
}

/** A press on the canvas, with both refusals watched. */
function press(canvas, [clientX, clientY], button = 0) {
  const event = new MouseEvent('pointerdown', {
    button, clientX, clientY, bubbles: true, cancelable: true,
  })
  vi.spyOn(event, 'stopPropagation')
  vi.spyOn(event, 'preventDefault')
  canvas.dispatchEvent(event)
  return event
}

/** The rest of the gesture. It goes to the WINDOW, which is where the press put
 *  the listeners — a drag that starts on a ring can end anywhere, and a move
 *  the reader made over their own toolbar still carries the drag.
 *
 * WHICH IS ALSO A MOVE OVER SOMETHING THAT IS NOT THE CANVAS, and the tests
 * below lean on that: the layer reads the same `event.target` for a hover that
 * `onDown` reads for a press, so a move dispatched anywhere else is a cursor
 * standing over some other widget. `hoverAt` is the one that says otherwise. */
const pointerMove = ([clientX, clientY]) =>
  window.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY }))

/** The cursor standing over the CANVAS at a point, which is what a hover is.
 *
 * DISPATCHED AT THE CANVAS AND NOT AT THE WINDOW, because a hover is a promise
 * that pressing here will turn this axis — and the press is taken only off the
 * canvas (`onDown`). It still reaches the layer's listener, which is on the
 * window in the CAPTURE phase: capture runs from the window down whatever the
 * event was dispatched at. */
const hoverAt = (canvas, [clientX, clientY]) =>
  canvas.dispatchEvent(new MouseEvent('pointermove', {
    clientX, clientY, bubbles: true,
  }))
const pointerUp = ([clientX, clientY]) =>
  window.dispatchEvent(new MouseEvent('pointerup', { clientX, clientY }))
const pointerCancel = () =>
  window.dispatchEvent(new MouseEvent('pointercancel', {}))

/** What was carried by every event of one name, in the order they went out. */
const details = (vp, type) => vp.dispatchEvent.mock.calls
  .map(([event]) => event)
  .filter((event) => event.type === type)
  .map((event) => event.detail)

/** Which way a group ended up facing, as four numbers. */
const facing = (group) => [group.quaternion.x, group.quaternion.y,
                           group.quaternion.z, group.quaternion.w]

/** Where a group ended up, as three numbers. */
const at = (group) => [group.position.x, group.position.y, group.position.z]

/** One turn of the microtask queue — both reports are deferred by exactly one
 *  (`reportProposalMove` in tools.js says why). */
const settled = () => Promise.resolve()

// The Z ring, seen square on: a circle of `RING_PX` about the middle of an
// 800x600 canvas. Its `u` is world +X, which the camera puts to the RIGHT, and
// its `v` is world +Y, which the camera puts UP — i.e. towards a smaller y. So
// the point of that curve at circle-space angle `t` is the one below, worked
// out here rather than read back off the module.
const CENTRE = [400, 300]
const onZ = (t) => [400 + RING_PX * Math.cos(t), 300 - RING_PX * Math.sin(t)]

/** The Z ring's disc, and the curve a quarter turn back from it — which is
 *  where the handle is NOT, and is what a press has to be refused at. */
const AT_DISC = onZ(DISC_T)
const AT_CURVE = onZ(DISC_T - Math.PI / 2)

/** Where a hand that grabbed that disc carries it: a quarter, a half and three
 *  quarters of a turn along the ring's own circle.
 *
 * THE SAME THREE ANGLES THE DRAGS BELOW ALWAYS SWEPT, and that is deliberate.
 * They used to be the world axes themselves, because the press was taken
 * anywhere on the curve and starting at +X was as good as anywhere; the press
 * is the disc's now, so every one of them is measured from `DISC_T` instead.
 * The angles SWEPT are unchanged, so every turn reported below is the number it
 * was before the widget was rebuilt — which is the assertion that says the
 * arithmetic in circle space was left alone. */
const AT_QUARTER = onZ(DISC_T + Math.PI / 2)
const AT_HALF = onZ(DISC_T + Math.PI)
const AT_THREE_QUARTERS = onZ(DISC_T + (3 * Math.PI) / 2)

describe('when there is nothing to put rings round', () => {
  it('draws nothing while no tool is armed', () => {
    const { vp, rings, z } = scene()
    drawn(rings)
    expect(shown(z), 'the premise: it is on screen with Move armed').toBe(true)

    vp.state = { ...vp.state, tool: null }
    drawn(rings)
    expect(shown(z)).toBe(false)
  })

  it('draws nothing for the retired tool value', () => {
    // `turn` WAS A TOOL AND IS NOT ONE ANY MORE. The rings were its whole
    // gesture, so a reader who wanted to slide a part and then turn it had to
    // swap tools between the two halves of one widget. Both halves answer to
    // `move` now, and this pins that nothing is left behind answering to the
    // old value — a widget that came up under a name the interface no longer
    // writes would be unreachable and invisible in one move.
    const { rings, z } = scene({ tool: 'turn' })
    drawn(rings)
    expect(shown(z)).toBe(false)
  })

  it('draws nothing while the hold key has the cut up', () => {
    // `activeTool` AND NOT `state.tool`: the hold key puts the cut up without
    // writing to `state`, so rings read off the state field would stand there
    // offering a turn while the very next press placed a section plane.
    const { vp, rings, z } = scene()
    drawn(rings)
    expect(shown(z)).toBe(true)

    vp.holdActive = true
    drawn(rings)
    expect(shown(z)).toBe(false)
  })

  it('draws nothing with an empty selection', () => {
    const { rings, z } = scene({ selected: [] })
    drawn(rings)
    expect(shown(z)).toBe(false)
  })

  it('draws nothing when a selected path is one the scene cannot move', () => {
    // THE SAME GRABBABLE TEST THE PRESS APPLIES, asked of EVERY path: one
    // gesture turns the whole row, and `movePart` refuses a row it cannot move
    // whole. So rings over a selection carrying one lost path would advertise a
    // turn that then silently does nothing.
    const { rings, z } = scene({ selected: [PART, '/Group/gone'] })
    drawn(rings)
    expect(shown(z)).toBe(false)
  })

  it('draws nothing on a part whose centre the scene cannot give', () => {
    // A node of the tree carries no tessellation, so it has no box and no
    // centre (`partCentre`) — there is no point to stand the rings on, and
    // `movePart` refuses to turn such a thing in any case.
    const { rings, z } = scene({ groups: { [PART]: fakeGroup() } })
    drawn(rings)
    expect(shown(z)).toBe(false)
  })

  it('draws nothing for a selection that mixes a body with a part', () => {
    // REFUSED WHOLE, exactly as the move refuses one: a proposal body and a
    // part of the build are opposite claims about the model, and there is no
    // such thing as half of either. One overlay path makes this a proposal
    // gesture, and then a model path has no body name and is not grabbable
    // into it.
    const BODY = '/Group/proposal/plate'
    const { rings, z } = scene({
      selected: [BODY, PART],
      groups: { [BODY]: solid(BODY), [PART]: solid(PART) },
      overlay: [{ name: 'plate' }],
    })
    drawn(rings)
    expect(shown(z)).toBe(false)
  })

  it('takes no gesture from a ring the next frame would remove', () => {
    // Both halves of the module have to agree about what is grabbable — `place`
    // takes the ring off and the press takes no gesture — or a press would land
    // on a handle that is on screen only until the next frame.
    const { vp, rings, canvas } = scene()
    drawn(rings)
    vp.state = { ...vp.state, selected: [] }

    press(canvas, AT_DISC)
    pointerMove(onZ(DISC_T + Math.PI / 2))

    expect(vp.moved.size).toBe(0)
  })
})

describe('how a ring is drawn', () => {
  it('stands on the part`s centre, in canvas pixels', () => {
    // The part's box is centred on the view axis, so it projects to the middle
    // of an 800x600 canvas.
    const { rings, z } = scene()
    drawn(rings)

    expect(shown(z)).toBe(true)
    expect(z.style.left).toBe('400px')
    expect(z.style.top).toBe('300px')
    // THE CENTRE IS THE FIXED POINT, unlike an arrow's tail: a ring is drawn
    // round the part, so the box is pulled back by half of itself and the
    // matrix works about the middle.
    expect(z.style.transform.startsWith('translate(-50%,-50%)')).toBe(true)
    expect(z.style.transformOrigin).toBe('50% 50%')
  })

  it('follows the part off centre', () => {
    // Four world units along +X at 20 px each is 80 px right of the middle.
    const { rings, z } = scene({ groups: { [PART]: solid(PART, [4, 0, 45]) } })
    drawn(rings)

    expect(z.style.left).toBe('480px')
    expect(z.style.top).toBe('300px')
  })

  it('is a unit circle under the projection`s own 2x2 matrix', () => {
    // THE WHOLE OF THE DRAWING. The ink is a box two pixels across with
    // `border-radius: 50%`, so its edge is the unit circle, and the matrix maps
    // that circle onto `cos t * a + sin t * b` — which IS the projection of the
    // world circle. Square on to Z: `u` is world +X at 105 px to the right, `v`
    // is world +Y at 105 px UP, and up the screen is a NEGATIVE y.
    //
    // THE MATRIX IS ON THE AXIS AND THE CIRCLE IS INSIDE IT, which is the one
    // thing to keep straight about this widget's DOM: the local pixel that
    // matrix multiplies by `RING_PX` is the unit every box inside is written
    // in, so the sizes below are read against it rather than against the
    // screen.
    const { rings, z } = scene()
    drawn(rings)

    expect(piece(z, 'arc').style.width).toBe('2px')
    expect(piece(z, 'arc').style.height).toBe('2px')
    expect(piece(z, 'arc').style.borderRadius).toBe('50%')
    expect(z.style.borderRadius).toBe('50%')
    expectMatrix(z, [RING_PX, 0, 0, -RING_PX])
  })

  it('reads at the same pixel size however far away the part is', () => {
    // A RING IS WORLD GEOMETRY, unlike the arrows, so this is the one thing it
    // has to be given that they do not: at a fixed WORLD radius the widget
    // would swell and shrink with the zoom and be a thread round a big part.
    // Twice the zoom is twice the pixels per world unit, so the ring is drawn
    // at half the world radius and comes out exactly as big.
    const near = scene({ camera: orthoCamera({ zoom: 2 }) })
    drawn(near.rings)
    expectMatrix(near.z, [RING_PX, 0, 0, -RING_PX])

    const far = scene({ camera: orthoCamera({ zoom: 0.25 }) })
    drawn(far.rings)
    expectMatrix(far.z, [RING_PX, 0, 0, -RING_PX])
  })

  it('draws its line thin enough for the matrix to make it RING_SHAFT_PX', () => {
    // The border is written in the SAME local pixels the boxes are, so the
    // matrix multiplies it by `RING_PX` along with everything else.
    // `box-sizing` keeps each outer edge exactly on the circle its own `r`
    // names, so the ring's size does not depend on how heavy its line is — and
    // the six circles of one axis stay concentric.
    const { rings, z } = scene()
    drawn(rings)

    expect(piece(z, 'arc').style.boxSizing).toBe('border-box')
    expect(bandOf(piece(z, 'arc'))).toBeCloseTo(RING_SHAFT_PX, 9)
  })

  it('carries its disc ON the curve, squashed exactly as the ring is', () => {
    // THE HANDLE IS A CIRCLE IN THE RING'S OWN PLANE and not a dot on the
    // screen, which is what makes it possible to say it is ON the curve at
    // all. It is a box inside the axis's own element, so the ring's matrix
    // reaches it like everything else: it flattens with its ring instead of
    // floating over it as a perfect circle, and it is carried out to the
    // handle's place by an offset in the ring's OWN coordinates — `(cos, sin)`
    // of the parameter that bisects the ring's two world axes.
    const { rings, z } = scene()
    drawn(rings)

    // The curve's own circles sit in the middle of the axis, which is where
    // the part is.
    expectSpot(z, CENTRE)
    const middle = Number.parseFloat(piece(z, 'arc').style.left)
    expect(Number.parseFloat(piece(z, 'arc').style.top)).toBeCloseTo(middle, 9)
    // And the disc's three are one local unit of the curve away along the
    // bisector — all three on that same point rather than beside each other.
    for (const name of ['discRim', 'discCase', 'disc']) {
      const el = piece(z, name)
      expect(Number.parseFloat(el.style.left) - middle, name)
        .toBeCloseTo(Math.cos(DISC_T), 9)
      expect(Number.parseFloat(el.style.top) - middle, name)
        .toBeCloseTo(Math.sin(DISC_T), 9)
    }
    // Which, square on to Z where nothing is flattened, is a disc
    // `RING_DISC_PX` across standing on the curve at that parameter.
    expect(radiusOf(piece(z, 'discRim'))).toBeCloseTo(RING_DISC_PX / 2, 9)
    expect(onRing(z, DISC_T)).toEqual(AT_DISC)
  })

  it('lays a white casing inside a dark rim round both', () => {
    // FUSION'S CONSTRUCTION AND NOT ITS PALETTE (options.js, `RING_CASE_PX`).
    // The complaint this answers is that the rings drowned in the geometry: a
    // red ring on a red part is invisible whatever red it is, and the canvas
    // under it is white or near-black depending on the reader's own answer. A
    // light casing inside a dark rim is legible against every one of those, and
    // it is GEOMETRY — concentric circles of their own — because `filter` and
    // `box-shadow` are computed in the element's own space and would come back
    // multiplied by the radius.
    const { rings, z } = scene()
    drawn(rings)

    // The curve: three bands about one circle, the ink's outer edge on
    // `RING_PX` and each of the other two standing that much further out.
    const radius = (name) => radiusOf(piece(z, name))
    expect(radius('arc')).toBeCloseTo(RING_PX, 9)
    expect(radius('arcCase')).toBeCloseTo(RING_PX + RING_CASE_PX, 9)
    expect(radius('arcRim')).toBeCloseTo(RING_PX + RING_CASE_PX + RING_RIM_PX, 9)
    // And each band is wide enough to show its own width on BOTH sides of the
    // ink, which is what a casing on a line means.
    expect(bandOf(piece(z, 'arcCase')))
      .toBeCloseTo(RING_SHAFT_PX + 2 * RING_CASE_PX, 9)
    expect(bandOf(piece(z, 'arcRim')))
      .toBeCloseTo(RING_SHAFT_PX + 2 * (RING_CASE_PX + RING_RIM_PX), 9)

    // The disc: three FILLED circles instead, the widest of them the handle's
    // whole width, so the rim is a boundary and the casing a band inside it.
    expect(radius('discRim')).toBeCloseTo(RING_DISC_PX / 2, 9)
    expect(radius('discCase')).toBeCloseTo(RING_DISC_PX / 2 - RING_RIM_PX, 9)
    expect(radius('disc'))
      .toBeCloseTo(RING_DISC_PX / 2 - RING_RIM_PX - RING_CASE_PX, 9)
    for (const name of ['discRim', 'discCase', 'disc']) {
      expect(piece(z, name).style.borderTopWidth, name).toBe('')
    }

    // The two construction inks are one pair for the whole widget: whatever the
    // axis, the casing is the light one and the rim is the dark one.
    const paint = (name) => piece(z, name).style.borderTopColor
      || piece(z, name).style.backgroundColor
    expect(paint('arcCase')).toBe(paint('discCase'))
    expect(paint('arcRim')).toBe(paint('discRim'))
    expect(brightness(piece(z, 'discCase')))
      .toBeGreaterThan(brightness(piece(z, 'discRim')))
  })

  it('spells its three axes in the inks the move arrows use', () => {
    // ONE TRIAD AND NOT TWO. Red, green and blue for X, Y and Z is the
    // convention every CAD tool the reader has used, and the two widgets stand
    // on the same point — so a ring that disagreed with the arrow for the same
    // axis would be saying they were about different things. Fusion's own
    // handles are grey and we deliberately do not copy that: half a widget in
    // grey beside arrows in colour would be worse than either.
    const { vp, rings } = scene()
    drawn(rings)
    const gizmo = createGizmo(vp)
    gizmo.refresh()
    runFrames()

    // THE FIRST THREE CHILDREN ARE THE ARROWS, which is the order that layer
    // builds in — arrows, then the three plane quads, then the origin dot. The
    // shaft is an arrow's own first child and carries the axis ink; a quad's is
    // its white casing and the dot's is the same, so the slice is what keeps
    // this about the triad rather than about the construction.
    const arrows = [...gizmo.root.children].slice(0, 3).map(
      (arrow) => arrow.firstElementChild.style.backgroundColor)
    expect(arrows.filter(Boolean)).toHaveLength(3)
    const groups = [...rings.root.children]
    expect(groups.map((group) => piece(group, 'arc').style.borderTopColor))
      .toEqual(arrows)
    // And the disc is the same ink as the arc it sits on, so the handle says
    // which axis it is before anything is hovered.
    expect(groups.map((group) => piece(group, 'disc').style.backgroundColor))
      .toEqual(arrows)
    gizmo.destroy()
  })
})

describe('which rings are drawn at all', () => {
  it('takes the two rings the reader is looking edge-on off the screen', () => {
    // A ring seen edge-on is a line, and so is its DISC — which is squashed
    // exactly as the ring is, so what is left to press is a sliver a hand
    // cannot aim at. `GIZMO_MIN_SCALE`'s rule, one widget over: a control the
    // reader can see and cannot use is worse than no control, and turning the
    // model a little brings it back. (Its 2x2 basis is singular as well, so the
    // angle the drag is measured in has no answer either — true, and not what
    // sets the floor; `RING_MIN_PX` carries that argument.) Looking straight
    // down Z, the X and Y rings are exactly that.
    const { rings, x, y, z } = scene()
    drawn(rings)

    expect(shown(z), 'the premise: the ring square on is up').toBe(true)
    expect(shown(x)).toBe(false)
    expect(shown(y)).toBe(false)
  })

  it('draws all three on an oblique camera, each squashed the same', () => {
    // Looking down the diagonal: each ring's plane sits at the same angle to
    // the camera, so all three come out at the same shape — the widest point
    // `RING_PX`, which is a property of the projection rather than of the ring
    // (rings.js says why every ring has a direction square on to the reader),
    // and the minor axis at `RING_PX / sqrt(3)`.
    const { rings, x, y, z } = scene({ camera: orthoCamera(OBLIQUE) })
    drawn(rings)

    for (const ring of [x, y, z]) {
      expect(shown(ring)).toBe(true)
      const [ax, ay, bx, by] = matrixOf(ring)
      const A = ax * ax + ay * ay
      const B = bx * bx + by * by
      const C = ax * bx + ay * by
      const half = (A + B) / 2
      const root = Math.hypot((A - B) / 2, C)
      expect(Math.sqrt(half + root)).toBeCloseTo(RING_PX, 6)
      expect(Math.sqrt(half - root)).toBeCloseTo(RING_PX / Math.sqrt(3), 6)
    }
  })
})

describe('the pair of axes each ring spans', () => {
  it('is the one with u x v pointing along the ring`s own axis', () => {
    // THE SIGN OF THE WHOLE GESTURE, pinned where it is decided. The drag
    // measures its angle in the ring's own `(u, v)` plane, so a positive angle
    // there is a right-handed turn about `+k` only while `u x v` IS `+k`. Both
    // orders draw the same ellipse, and the matrix the module writes is the one
    // thing outside it that can still tell them apart: square on to Z, `u` is
    // world +X (the first column, 105 px right) and `v` is world +Y (the
    // second, 105 px up). X cross Y is Z, and the part turns the way the hand
    // went.
    const { rings, z } = scene()
    drawn(rings)
    const [ax, ay, bx, by] = matrixOf(z)

    // The world vectors those two screen columns are the projection of, at this
    // camera's 20 px to the world unit and with the screen's y counted down.
    const round = (v) => v.map((c) => Math.round(c * 1e9) / 1e9 || 0)
    const u = round([ax / RING_PX, -ay / RING_PX, 0])
    const v = round([bx / RING_PX, -by / RING_PX, 0])
    expect(u).toEqual([1, 0, 0])
    expect(v).toEqual([0, 1, 0])
    expect(round(cross3(u, v))).toEqual([0, 0, 1])
  })
})

describe('what takes the press', () => {
  it('leaves a press that missed every disc completely alone', () => {
    // THE PRICE OF A LAYER THAT TAKES NO PRESSES, and what it buys: the press
    // goes on to the tools' own listener and to the trackball behind it, so the
    // reader can still orbit, pick and open the part menu with the tool armed.
    // A widget that answered every press inside the ring would have taken the
    // middle of the model away from all three.
    const { vp, rings, canvas, groups } = scene()
    drawn(rings)

    const event = press(canvas, CENTRE)
    expect(event.stopPropagation).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()

    pointerMove(onZ(DISC_T + Math.PI / 2))
    expect(at(groups[PART])).toEqual([0, 0, 0])
    expect(facing(groups[PART])).toEqual([0, 0, 0, 1])
    expect(vp.moved.size).toBe(0)
  })

  it('leaves a press on the CURVE, away from the disc, alone as well', () => {
    // THE CURVE IS NOT A TARGET ANY MORE, which is the whole of the answer to
    // "you cannot hit the axis you mean": a ring is 660 px of circumference and
    // three of them cross six times, so a press on the curve was a press the
    // module had to guess an axis for. Now the drawn arc is a sign saying which
    // way the part will go and the disc is the thing to press — and everything
    // else about that ring goes back to the trackball, which is what the reader
    // means by dragging over the model.
    const { vp, rings, canvas, groups } = scene()
    drawn(rings)

    const event = press(canvas, AT_CURVE)
    expect(event.stopPropagation).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()

    pointerMove(onZ(DISC_T))
    expect(facing(groups[PART])).toEqual([0, 0, 0, 1])
    expect(vp.moved.size).toBe(0)
  })

  it('takes a press that landed on the disc, from the trackball with it', () => {
    const { rings, canvas } = scene()
    drawn(rings)

    const event = press(canvas, AT_DISC)
    expect(event.stopPropagation).toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('declines one that landed on a piece of the arrows` layer instead', () => {
    // THE CLAIM THAT LETS ONE TOOL DRIVE TWO LAYERS, checked rather than
    // assumed. Both are on screen at once now, they stand on the same point,
    // and they take their presses by completely different means: an arrow, a
    // quad and the origin dot are BOXES and take theirs on their own elements,
    // while this layer takes none at all and reads the canvas's own press in a
    // capture listener on the window. Capture runs from the window DOWN, so
    // this listener sees a press aimed at an arrow BEFORE the arrow does — and
    // the single line that keeps it from stealing it is `event.target !==
    // g.canvas`.
    //
    // SO THE SAME PIXEL IS PRESSED TWICE, which is the only way to show it: at
    // the Z disc's own position, once at the arrow and once at the canvas. The
    // first has to slide the part and turn nothing; the second has to turn it.
    const { vp, rings, canvas } = scene()
    drawn(rings)
    const gizmo = createGizmo(vp)
    layers.push(gizmo)
    // IN THE DOCUMENT, because a press dispatched at a detached element never
    // reaches the window listener this test is about.
    document.body.appendChild(gizmo.root)
    gizmo.refresh()
    runFrames()

    const arrow = gizmo.root.firstElementChild
    arrow.dispatchEvent(new MouseEvent('pointerdown', {
      clientX: AT_DISC[0], clientY: AT_DISC[1], bubbles: true, cancelable: true,
    }))
    pointerMove([AT_DISC[0] + 200, AT_DISC[1] + 60])

    const said = vp.moved.get(PART)
    expect(said, 'the arrow took its own press').toBeTruthy()
    expect(said.turn, 'and the rings did not take it too').toEqual([0, 0, 0])
    expect(said.delta[0]).not.toBe(0)

    // And the same point on the CANVAS is still the disc's, so the rings have
    // lost nothing by sharing the reach.
    const other = scene()
    drawn(other.rings)
    press(other.canvas, AT_DISC)
    pointerMove(AT_QUARTER)
    expect(other.vp.moved.get(PART).turn).not.toEqual([0, 0, 0])
  })

  it('ends the other layer`s drag, and is ended by it, either way round', async () => {
    // TWO LIVE GESTURES ON ONE PART, which is what the merge made possible and
    // neither layer defended against. Both `onDown`s already conclude their OWN
    // previous gesture, so a second pointer is treated as real input here; what
    // could not happen before was the CROSS case — this layer wanted `turn` and
    // the arrows wanted `move`, so only one was ever alive to be interrupted.
    //
    // AND TWO ARE WORSE THAN A STALE ONE. Both `onMove`s are on the window and
    // neither filters by pointer id, so both run on every move; each then calls
    // `movePart`, which writes position AND orientation together from its own
    // snapshot of the other's half — so left alone they overwrite each other
    // frame by frame and both report at the release.
    //
    // CONCLUDED AND NOT ABANDONED, which is `concludeMove`'s argument: the part
    // is standing where the reader left it and only the document can be wrong
    // about that. So each direction below asserts the report went out, and then
    // that the interrupted layer really has let go — the field it was writing
    // stops moving while the field the new gesture writes goes on.
    const both = () => {
      const s = scene()
      drawn(s.rings)
      const gizmo = createGizmo(s.vp)
      layers.push(gizmo)
      s.vp.gizmo = gizmo
      // IN THE DOCUMENT, or a press dispatched at an arrow never reaches the
      // window listener this layer reads its own presses in.
      document.body.appendChild(gizmo.root)
      gizmo.refresh()
      runFrames()
      return { ...s, gizmo, arrow: gizmo.root.firstElementChild }
    }
    const pressArrow = (arrow, [clientX, clientY]) => arrow.dispatchEvent(
      new MouseEvent('pointerdown', {
        clientX, clientY, bubbles: true, cancelable: true,
      }))

    // A TURN IN PROGRESS, INTERRUPTED BY A PRESS ON AN ARROW.
    const a = both()
    press(a.canvas, AT_DISC)
    pointerMove(AT_QUARTER)
    const turned = a.vp.moved.get(PART).turn
    expect(turned, 'the premise: the part really is being turned')
      .not.toEqual([0, 0, 0])

    pressArrow(a.arrow, [100, 100])
    await settled()
    expect(details(a.vp, EVENT_TURNED), 'the turn was dropped rather than said')
      .toHaveLength(1)

    pointerMove([300, 160])
    // The handles have let go — the angle stands where the hand left it — while
    // the arrow that took over is writing the offset.
    expect(a.vp.moved.get(PART).turn).toEqual(turned)
    expect(a.vp.moved.get(PART).delta).not.toEqual([0, 0, 0])

    // AND THE SAME THING THE OTHER WAY ROUND: a slide in progress, interrupted
    // by a press on a disc.
    const b = both()
    pressArrow(b.arrow, [100, 100])
    pointerMove([300, 160])
    const slid = b.vp.moved.get(PART).delta
    expect(slid, 'the premise: the part really is being slid').not.toEqual([0, 0, 0])

    press(b.canvas, AT_DISC)
    await settled()
    expect(details(b.vp, EVENT_MOVED), 'the slide was dropped rather than said')
      .toHaveLength(1)

    pointerMove(AT_QUARTER)
    // The arrow has let go, and the offset it left behind is carried through the
    // turn rather than straightened — `turnRecord` reads it off `vp.moved`,
    // which the conclusion above had already written.
    expect(b.vp.moved.get(PART).delta).toEqual(slid)
    expect(b.vp.moved.get(PART).turn).not.toEqual([0, 0, 0])

    // AND ON A PRESS THAT MISSES EVERY DISC, which the module states as a rule
    // and nothing checked: the `endDrag` is taken BEFORE the hit test, so a
    // second finger landing on the bare model ends the arrow's drag exactly as
    // one landing on a handle does. It is the same reader stranding the same
    // gesture. Moved below the hit test, everything else in this file stays
    // green.
    const c = both()
    pressArrow(c.arrow, [100, 100])
    pointerMove([300, 160])
    expect(c.vp.moved.get(PART).delta, 'the premise: a slide is running')
      .not.toEqual([0, 0, 0])

    press(c.canvas, AT_CURVE)
    await settled()
    expect(details(c.vp, EVENT_MOVED), 'the slide was dropped rather than said')
      .toHaveLength(1)

    const left = c.vp.moved.get(PART).delta
    pointerMove([500, 300])
    expect(c.vp.moved.get(PART).delta, 'the arrow was still listening')
      .toEqual(left)
  })

  it('hands the canvas gesture on only for a press it actually keeps', async () => {
    // THE THIRD THING THAT CAN BE LIVE, and the one neither layer can end by
    // itself. tools.js concludes its own previous press at the head of its
    // `onDown` — and that listener sees every press aimed at the canvas, so a
    // press this layer DECLINES needs nothing from us. What opens the hole is
    // `stopPropagation`: a press this layer KEEPS never reaches that listener,
    // so the free drag a first finger started stays live, and then both
    // `onMove`s run on every move with `dragPart` measuring from the first
    // finger's ndc to wherever the second one is.
    //
    // SO THE CALL BELONGS TO THE KEPT PRESS ALONE, and that is what this pins
    // rather than merely that the call exists. `endGesture` CONCLUDES, and
    // concluding a cut means `reportCut`, which the interface answers by
    // disarming the armed tool — which is exactly why tools.js's own `onDown`
    // calls `concludeMove` and not `conclude`. Hoisted above the hit test to
    // sit beside the `endDrag`, this would do that on every ordinary canvas
    // press with a cut still live.
    const taken = scene()
    drawn(taken.rings)
    press(taken.canvas, AT_DISC)
    expect(taken.vp.endGesture).toHaveBeenCalled()

    const missed = scene()
    drawn(missed.rings)
    press(missed.canvas, AT_CURVE)
    expect(missed.vp.endGesture).not.toHaveBeenCalled()
    // And the press really did go on to whatever is behind this layer, which is
    // what makes tools.js's own conclusion the right one to rely on.
    const event = press(missed.canvas, AT_CURVE)
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })

  it('takes a press to the disc`s edge and refuses one past it', () => {
    // THE TARGET IS AS WIDE AS WHAT IS DRAWN, which is what replaced the old
    // curve test's invented tolerance: the disc is `RING_DISC_PX` across and
    // the hit test is the distance to its centre, measured in the ring's own
    // plane. Square on to Z that plane is the screen, so the edge is exactly
    // half of `RING_DISC_PX` away in any direction.
    const half = RING_DISC_PX / 2
    const { vp, rings, canvas } = scene()
    drawn(rings)

    press(canvas, [AT_DISC[0] + half - 1, AT_DISC[1]])
    pointerMove(onZ(DISC_T + Math.PI / 2))
    expect(vp.moved.size, 'inside the disc').toBe(1)

    const far = scene()
    drawn(far.rings)
    press(far.canvas, [AT_DISC[0] + half + 1, AT_DISC[1]])
    pointerMove(onZ(DISC_T + Math.PI / 2))
    expect(far.vp.moved.size, 'past its edge').toBe(0)
  })

  it('ignores every button but the primary one', () => {
    // The right button is a gesture of its own on this page — it opens the part
    // menu, and the library pans on it.
    const { vp, rings, canvas, groups } = scene()
    drawn(rings)

    const event = press(canvas, AT_DISC, 2)
    // Not even the refusals: a press this one does not want is a press it has
    // no business taking away from anybody else.
    expect(event.preventDefault).not.toHaveBeenCalled()

    pointerMove(onZ(DISC_T + Math.PI / 2))
    expect(facing(groups[PART])).toEqual([0, 0, 0, 1])
    expect(details(vp, EVENT_TURNED)).toEqual([])
  })

  it('puts the three discs in three different places under one camera', () => {
    // THE SEPARATION IS THE WIDGET'S WHOLE CLAIM. Three circles of one radius
    // about one point are indistinguishable near their crossings; three
    // handles, each at the bisector of its own ring's two world axes, are 60
    // degrees apart in the world and land in three different corners of the
    // picture. Looking down the diagonal — the camera where all three rings are
    // equally open — no two of them are within a disc's width of each other,
    // so there is no press that could be meant for two axes.
    const { rings, x, y, z } = scene({ camera: orthoCamera(OBLIQUE) })
    drawn(rings)

    const discs = [x, y, z].map(onDisc)
    for (const [first, second] of [[0, 1], [0, 2], [1, 2]]) {
      const apart = Math.hypot(discs[first][0] - discs[second][0],
                               discs[first][1] - discs[second][1])
      expect(apart, `${'XYZ'[first]} and ${'XYZ'[second]}`)
        .toBeGreaterThan(RING_DISC_PX)
    }
  })

  it('takes the nearer of two discs that are both hit', () => {
    // TWO HANDLES CAN LAND ON ONE POINT, and that is the tie `aimAt` breaks.
    // What it takes is a camera looking down the DIFFERENCE of two handles'
    // world directions — `h_X - h_Z` is `(Z - X)/sqrt2`, so down `(1, 0, -1)` —
    // and this one looks a tenth of the way off it: the two discs come out a
    // few pixels apart, overlapping, and a press between them is honestly on
    // both. Near such a press both answers are true and only the distance to
    // each handle's own centre says which one the hand was aiming at.
    //
    // THE THIRD RING IS GONE WHILE THEY OVERLAP, which is not a coincidence and
    // is what bounds this to two: that difference is square on to the third
    // axis — `(Z - X)` to Y — so a camera looking down it lies in the third
    // ring's own plane, and `RING_MIN_PX` has already taken that ring off the
    // screen. With all three up the handles are `RING_PX * GIZMO_MIN_SCALE`
    // apart at the very least, which is wider than a disc.
    const aimed = () => {
      const made = scene({ camera: orthoCamera({
        forward: [1, 0.1, -1], right: [1, 0, 1], up: [0.1, -2, -0.1],
      }) })
      drawn(made.rings)
      return made
    }

    const first = aimed()
    expect(shown(first.y), 'the third ring is edge-on and gone').toBe(false)
    const onX = onDisc(first.x)
    const onZ = onDisc(first.z)
    const apart = Math.hypot(onX[0] - onZ[0], onX[1] - onZ[1])
    expect(apart, 'the premise: the two handles overlap')
      .toBeLessThan(RING_DISC_PX / 2)

    // Two presses either side of the midpoint, two pixels along the line
    // joining the centres: each is nearer one handle and on both of them.
    const mid = [(onX[0] + onZ[0]) / 2, (onX[1] + onZ[1]) / 2]
    const step = [(2 * (onX[0] - onZ[0])) / apart,
                  (2 * (onX[1] - onZ[1])) / apart]
    const nearX = [mid[0] + step[0], mid[1] + step[1]]
    const nearZ = [mid[0] - step[0], mid[1] - step[1]]
    for (const point of [nearX, nearZ]) {
      expect(intoDisc(first.x, point), 'off the X handle').toBeLessThan(1)
      expect(intoDisc(first.z, point), 'off the Z handle').toBeLessThan(1)
    }

    // One turn each, on its own scene — a second gesture on the first would
    // write a second angle into the same triple and there would be no reading
    // the axis back out of it.
    const spun = (made) => made.vp.moved.get(PART).turn
      .findIndex((angle) => angle !== 0)
    const drag = (made, from) => {
      press(made.canvas, from)
      pointerMove([from[0] + 40, from[1] + 40])
      pointerUp([from[0] + 40, from[1] + 40])
    }

    drag(first, nearX)
    const second = aimed()
    drag(second, nearZ)

    expect(spun(first), 'the press nearer the X handle').toBe(0)
    expect(spun(second), 'the press nearer the Z handle').toBe(2)
  })

  it('turns about the axis whose disc was pressed, and no other', () => {
    // The other half of the same claim, and the one that says the separation is
    // the MODULE's and not this file's arithmetic: each of the three handles,
    // pressed where it is drawn, starts a turn about its own axis.
    for (const axis of [0, 1, 2]) {
      const made = scene({ camera: orthoCamera(OBLIQUE) })
      drawn(made.rings)
      const group = made.rings.root.children[axis]

      press(made.canvas, onDisc(group))
      pointerMove(onRing(group, DISC_T + Math.PI / 2))
      pointerUp(onRing(group, DISC_T + Math.PI / 2))

      const turn = made.vp.moved.get(PART).turn
      expect(turn.findIndex((angle) => angle !== 0),
             `the ${'XYZ'[axis]} disc`).toBe(axis)
    }
  })
})

describe('one whole drag', () => {
  it('turns the part about the axis grabbed, the way the hand went', async () => {
    // THE CLAIM THIS FILE EXISTS FOR. The camera looks down -Z with +X to the
    // right and +Y up, so a hand carried from the Z ring's disc — up and to the
    // right of the part, on the bisector of +X and +Y — a quarter turn along
    // the curve goes anticlockwise on the screen, which about +Z is a POSITIVE
    // quarter turn, right-handed. A sign taken off a screen-space `atan2`
    // instead would be the other one, and would look every bit as plausible.
    const { vp, rings, canvas, groups } = scene()
    drawn(rings)

    press(canvas, AT_DISC)
    pointerMove(AT_QUARTER)
    pointerUp(AT_QUARTER)
    await settled()

    expect(vp.moved.get(PART)).toEqual({ delta: [0, 0, 0], turn: [0, 0, 90] })
    // AND WHERE THE PART REALLY ENDED UP, which is the half a sign cannot lie
    // about: the group's own quaternion, asked where it sends the world +X
    // axis. A quarter turn about +Z sends it to +Y.
    const q = facing(groups[PART])
    expect(q).toEqual(quaternionOf([0, 0, 90]))
    const sent = turned(q, [1, 0, 0])
    expect(sent[0]).toBeCloseTo(0, 9)
    expect(sent[1]).toBeCloseTo(1, 9)
    expect(sent[2]).toBeCloseTo(0, 9)
  })

  it('turns it about its own centre, so it does not swing across the scene', () => {
    // The group's origin is not the part's centre — a leaf's vertices are its
    // own coordinates and its `loc` is where the view puts it — so a quaternion
    // written on its own would throw the part across the model. `movePart`
    // takes both fields, and here the two cancel exactly: a part turned about
    // its own centre stands where it stood.
    const { rings, canvas, groups } = scene()
    drawn(rings)

    press(canvas, AT_DISC)
    pointerMove(AT_QUARTER)

    expect(at(groups[PART])).toEqual([0, 0, 0])
  })

  it('says where it ended up once, and only when the hand comes off', async () => {
    // THE RELEASE IS THE ONLY REPORT, and it is the same one the two move
    // gestures end in: the interface answers a recorded statement by opening
    // the panel, which re-stages, and a re-stage ends the gesture the reader
    // has not let go of.
    const { vp, rings, canvas } = scene()
    drawn(rings)

    press(canvas, AT_DISC)
    pointerMove(AT_QUARTER)
    await settled()
    expect(details(vp, EVENT_TURNED), 'it spoke mid-drag').toEqual([])

    pointerUp(AT_QUARTER)
    await settled()

    const reports = details(vp, EVENT_TURNED)
    expect(reports).toHaveLength(1)
    expect(reports[0].turn).toEqual([0, 0, 90])
    expect(reports[0].paths).toEqual([PART])
    expect(reports[0].build).toBe('build-1')

    // And the gesture really ended: the window listeners went with it, so a
    // pointer that moves on past the release turns no part.
    pointerMove(AT_HALF)
    expect(vp.moved.get(PART).turn).toEqual([0, 0, 90])
  })

  it('carries a gesture past the seam and lands where the hand left it', async () => {
    // `atan2` comes back in (-pi, pi], so a hand carried past the seam reads as
    // a jump of nearly a whole turn the other way unless the STEP between two
    // events is what is accumulated, which is what `onMove` does.
    //
    // THREE QUARTERS THE POSITIVE WAY IS A QUARTER SHORT OF HOME, and that is
    // the assertion: minus ninety and not plus ninety. What a node stores is
    // three angles read back out of a ROTATION (`anglesOf` in math.js), and a
    // rotation does not remember how many times round the hand went — so 270
    // and -90 are one orientation and this is the spelling of it.
    const { vp, rings, canvas, groups } = scene()
    drawn(rings)

    press(canvas, AT_DISC)
    pointerMove(AT_QUARTER)
    pointerMove(AT_HALF)
    pointerMove(AT_THREE_QUARTERS)
    pointerUp(AT_THREE_QUARTERS)
    await settled()

    expect(details(vp, EVENT_TURNED)[0].turn).toEqual([0, 0, -90])
    // And the part is really standing there: three quarters anticlockwise sends
    // world +X to -Y, where one quarter the other way would have sent it to +Y.
    const sent = turned(facing(groups[PART]), [1, 0, 0])
    expect(sent[0]).toBeCloseTo(0, 9)
    expect(sent[1]).toBeCloseTo(-1, 9)
    expect(sent[2]).toBeCloseTo(0, 9)
  })

  it('snaps to whole degrees', async () => {
    // A number this gesture produces travels to an agent in a sentence, and
    // 31.7413 degrees claims a precision no hand has. A degree is also the step
    // the row's own field takes, so a turn made with a ring and a turn typed
    // into the panel land on the same grid.
    const { vp, rings, canvas } = scene()
    drawn(rings)

    press(canvas, AT_DISC)
    // A tenth of a radian along the curve, which is 5.729... degrees.
    pointerMove(onZ(DISC_T + 0.1))
    pointerUp(CENTRE)
    await settled()

    expect(details(vp, EVENT_TURNED)[0].turn).toEqual([0, 0, 6])
  })

  it('leaves the two axes it is not on exactly as it found them', async () => {
    // AN ANGLE ALREADY STANDING NEED NOT BE A WHOLE DEGREE. It comes from the
    // proposal document, whose `turn.<axis>` fields the reader types by hand —
    // so rounding all three would turn the part about an axis this gesture
    // never touched, a number written as 12.3 coming back as 12.
    const { vp, rings, canvas } = scene()
    drawn(rings)
    vp.moved.set(PART, { delta: [0, 0, 0], turn: [12.3, 0, 0] })

    press(canvas, AT_DISC)
    pointerMove(AT_QUARTER)
    pointerUp(AT_QUARTER)
    await settled()

    expect(details(vp, EVENT_TURNED)[0].turn).toEqual([12.3, 0, 90])
  })

  it('carries the offset the part is already standing at', async () => {
    // `movePart` writes position and orientation together on every call, so a
    // turn that left the delta out would send a part the reader had dragged
    // home the instant they turned it — an answer to a question they did not
    // ask, from a gesture that says nothing about where the part goes.
    const { vp, rings, canvas } = scene()
    drawn(rings)
    vp.moved.set(PART, { delta: [1, 2, 3], turn: [0, 0, 0] })

    press(canvas, AT_DISC)
    pointerMove(AT_QUARTER)
    pointerUp(AT_QUARTER)
    await settled()

    expect(vp.moved.get(PART)).toEqual({ delta: [1, 2, 3], turn: [0, 0, 90] })
  })

  it('says nothing when the press never moved', async () => {
    // A bare click on a ring is not a statement: reported, it would write a
    // node the document already has and open the panel to show the reader
    // nothing new.
    const { vp, rings, canvas } = scene()
    drawn(rings)

    press(canvas, AT_DISC)
    pointerUp(AT_DISC)
    await settled()

    expect(details(vp, EVENT_TURNED)).toEqual([])
  })

  it('does nothing for a hand that shook, and everything a pixel later', async () => {
    // A CLICK IS NOT A ONE-PIXEL DRAG, which the canvas gesture spells out and
    // this one has to spell the same way. Below `CLICK_PX` there is nothing the
    // reader could have meant: nothing selects on a ring, so the only thing a
    // twitch between press and release can do is turn the part a degree and
    // file a node — and the interface answers a filed node by opening the
    // panel.
    const { vp, rings, canvas, groups } = scene()
    drawn(rings)

    press(canvas, AT_DISC)
    pointerMove([AT_DISC[0] + CLICK_PX - 1, AT_DISC[1] + CLICK_PX - 1])
    expect(facing(groups[PART]), 'still a click').toEqual([0, 0, 0, 1])
    pointerUp([AT_DISC[0] + CLICK_PX - 1, AT_DISC[1] + CLICK_PX - 1])
    await settled()
    expect(details(vp, EVENT_TURNED)).toEqual([])

    // And exactly one pixel further the same gesture IS a drag: `CLICK_PX` of
    // travel on either axis is the boundary, so a move of exactly that much is
    // past it.
    //
    // CARRYING THE WHOLE TRAVEL FROM THE PRESS, not from where the threshold
    // was crossed, which is the other half and the one a refused event could
    // quietly break: the twitch above must not have advanced the angle this
    // sweep is measured against. Straight down the screen from the handle, the
    // curve at that point is `atan2` of the two circle-space coordinates the
    // press and the travel make — a degree and a half of the ring, backwards,
    // where an angle that had crept forward with the twitch would answer plus
    // one.
    press(canvas, AT_DISC)
    pointerMove([AT_DISC[0] + CLICK_PX - 1, AT_DISC[1] + CLICK_PX - 1])
    pointerMove([AT_DISC[0], AT_DISC[1] + CLICK_PX])
    const swept = Math.atan2(Math.SQRT1_2 - CLICK_PX / RING_PX, Math.SQRT1_2)
      - DISC_T
    expect(vp.moved.get(PART).turn)
      .toEqual([0, 0, Math.round((swept * 180) / Math.PI)])
  })

  it('is concluded when the pointer is taken away', async () => {
    // A TURN IS REPORTED FROM EVERY ENDING, which is where this parts company
    // with the section grip: a cancelled cut is dropped, and a cancelled turn
    // leaves the part standing at an angle the document does not claim, so the
    // next reconcile would straighten it and the gesture would be silently
    // undone.
    const { vp, rings, canvas } = scene()
    drawn(rings)

    press(canvas, AT_DISC)
    pointerMove(AT_QUARTER)
    pointerCancel()
    await settled()

    expect(details(vp, EVENT_TURNED)).toHaveLength(1)

    // And it really ended.
    pointerMove(AT_HALF)
    expect(details(vp, EVENT_TURNED)).toHaveLength(1)
  })

  it('concludes a drag the scene is being pulled out from under', async () => {
    // The twin of `vp.endGesture`, and the reason it is a fourth call rather
    // than the same one: the press was taken in a window listener this layer
    // owns, so neither that gesture nor the idle clock that defers the swap
    // ever saw it.
    const { vp, rings, canvas } = scene()
    drawn(rings)

    press(canvas, AT_DISC)
    pointerMove(AT_QUARTER)

    rings.endDrag()
    expect(details(vp, EVENT_TURNED), 'the report went out inside the render')
      .toEqual([])

    await settled()
    expect(details(vp, EVENT_TURNED)).toHaveLength(1)

    // And the release that never came cannot report a second time.
    pointerUp(AT_QUARTER)
    await settled()
    expect(details(vp, EVENT_TURNED)).toHaveLength(1)
  })

  it('is concluded when another press arrives with it still live', async () => {
    const { vp, rings, canvas } = scene()
    drawn(rings)

    press(canvas, AT_DISC)
    pointerMove(AT_QUARTER)
    press(canvas, AT_QUARTER)
    await settled()

    expect(details(vp, EVENT_TURNED)).toHaveLength(1)
    pointerUp(AT_QUARTER)
  })

  it('edits the panel`s document for a body the proposal staged', async () => {
    // THE SECOND MEANING OF THE SAME GESTURE, and the rings reach it through
    // the same dispatch the two drags use. A body of the proposal is the
    // reader's OWN drawing: it turns for the eye alone while the hand is down,
    // nothing is recorded for it, and the release names the body to the panel.
    //
    // AND WHAT IT SAYS IS HOW FAR THIS GESTURE WENT, not where the body now
    // stands: the document holds a body's `rot` and this side has never read
    // it, so the panel adds what arrives to what it has.
    const BODY = '/Group/proposal/plate'
    const { vp, rings, canvas, groups } = scene({
      selected: [BODY],
      groups: { [BODY]: solid(BODY) },
      // `origin` IS THE BODY'S OWN `at`, which the panel puts on every part it
      // builds (proposalgeom.js) because the scene cannot answer for it: a
      // staged body carries an identity `loc` with the whole placement baked
      // into its vertices. Here it is the world origin, which is the one case
      // where a body's own origin and the centre of its box happen to be told
      // apart by nothing — the test below this one is the one that tells them
      // apart.
      overlay: [{ name: 'plate', origin: [0, 0, 0] }],
    })
    drawn(rings)
    expect(shown(rings.root.children[2]),
           'the premise: a body is grabbable like any part').toBe(true)

    press(canvas, AT_DISC)
    pointerMove(AT_QUARTER)
    pointerUp(AT_QUARTER)
    await settled()

    const [report] = details(vp, EVENT_PROPOSALTURN)
    expect(report.name).toBe('plate')
    expect(report.turn).toEqual([0, 0, 90])
    // It really turned while the hand was down, and about its own origin.
    expect(facing(groups[BODY])).toEqual(quaternionOf([0, 0, 90]))
    expect(at(groups[BODY])).toEqual([0, 0, 0])
    // And none of what a part of the build leaves behind.
    expect(vp.moved.size, 'an offset was written for it').toBe(0)
    expect(vp.partHome.size, 'a home was remembered for it').toBe(0)
    expect(vp.partFacing.size, 'a pose was remembered for it').toBe(0)
    expect(vp.partPivot.size, 'a pivot was remembered for it').toBe(0)
    expect(details(vp, EVENT_TURNED)).toEqual([])
  })

  it('turns a body about the point the DOCUMENT turns it about', async () => {
    // THE PREVIEW'S JOB IS TO SHOW WHAT WILL HAPPEN, and what will happen is
    // `placed` in proposalgeom.js: a body is rotated in its OWN coordinates and
    // only then carried to `at`, so `at` is the single world point a change of
    // `rot` leaves exactly where it is. The centre of the body's BOX is a
    // different point for every op that is not centred on its own origin — an
    // extrusion runs its profile up from `z = 0`, so its box centre sits at
    // `h/2` whatever the profile is — and a preview taken about that swings the
    // body away and lets it jump back on release.
    //
    // THE TWO ARE TOLD APART HERE BY PUTTING THEM IN DIFFERENT PLACES: the
    // body's box is centred on `[0, 0, 45]` (which is where the rings stand)
    // and its own origin is `[10, 0, 20]`.
    const BODY = '/Group/proposal/block'
    const ORIGIN = [10, 0, 20]
    const { rings, canvas, groups } = scene({
      selected: [BODY],
      groups: { [BODY]: solid(BODY) },
      overlay: [{ name: 'block', origin: ORIGIN }],
    })
    drawn(rings)

    press(canvas, AT_DISC)
    pointerMove(AT_QUARTER)
    pointerUp(AT_QUARTER)
    await settled()

    // WHERE A WORLD POINT OF THE BODY ENDS UP is `position + q·p`, which is what
    // three.js composes the group's world matrix out of. The body's own origin
    // has to come back to itself: that is what "turned about this point" means.
    const stood = at(groups[BODY])
    const q = facing(groups[BODY])
    const lands = (p) => turned(q, p).map((value, axis) => value + stood[axis])
    lands(ORIGIN).forEach((value, axis) => expect(value).toBeCloseTo(ORIGIN[axis], 9))
    // And the negative control, so this is not just a body that did not move:
    // the centre of its box, which is where the old pivot was, HAS gone round.
    expect(lands([0, 0, 45])[1]).toBeCloseTo(-10, 9)
  })

  it('holds the frame it was measured on for the whole gesture', () => {
    // THE CAMERA MUST NOT BE ABLE TO CHANGE THE FRAME MID-DRAG, which is the
    // rule both existing manipulators keep. Here the frame is the ellipse's own
    // basis, and re-measuring per event would mean the angle a hand had already
    // swept was suddenly read against a different plane — the part jumping away
    // from the hand on any frame the reader also happened to be orbiting in.
    const { vp, rings, canvas, viewer } = scene()
    drawn(rings)

    press(canvas, AT_DISC)
    // The camera rolls a quarter turn under the live gesture. Measured again,
    // the pointer below would land somewhere else entirely on the new ellipse.
    viewer.model.right = [0, 1, 0]
    viewer.model.up = [-1, 0, 0]
    pointerMove(AT_QUARTER)

    expect(vp.moved.get(PART).turn).toEqual([0, 0, 90])
  })
})

describe('what the cursor says about which axis is about to turn', () => {
  /** All three rings open, and the pointer put somewhere with a frame drawn
   *  after it — which is the order the module reads them in: `onMove` records
   *  where the cursor is and `place` asks about it once a frame. */
  const watching = (where) => {
    const made = scene({ camera: orthoCamera(OBLIQUE) })
    drawn(made.rings)
    if (where) hoverAt(made.canvas, where(made))
    drawn(made.rings)
    return made
  }

  it('draws no full circle at rest', () => {
    // THE COMPLAINT THIS ANSWERS. Three closed curves of one radius, drawn
    // round a part in three colours the part may itself be painted, are three
    // things to look past rather than a control — and the reader who wants to
    // turn something needs to be shown WHERE to press, not the entire orbit of
    // every axis at once. So at rest each ring is an arc through its own
    // handle, faded out at both ends. One mask carries it for the whole axis,
    // which is what keeps the three circles of the curve in step: an ink that
    // stopped at the arc while its casing ran on round would be a white circle
    // with a coloured segment in it.
    const { x, y, z } = watching(null)

    for (const group of [x, y, z]) {
      expect(shown(group), 'the premise: all three are up').toBe(true)
      expect(faded(group)).toBe(true)
      // It runs out at `RING_ARC_DEG` either side of the handle, which is
      // twice that from end to end, and there is nothing after it: what a
      // conic gradient does past its last stop is hold that stop's colour, and
      // that colour has to be the transparent one.
      expect(fade(group)).toContain(`${2 * RING_ARC_DEG}deg`)
      expect(fade(group).endsWith(`0) ${2 * RING_ARC_DEG}deg)`)).toBe(true)
    }
  })

  it('fades over the ring`s own circle, measured from the handle`s angle', () => {
    // THE TWO NUMBERS IN THAT GRADIENT THAT NOTHING ELSE WOULD CATCH, read back
    // into the ring's own parametrisation rather than compared as text.
    //
    // THE `from` ANGLE is a conversion: CSS measures a conic gradient from
    // twelve o'clock and runs it clockwise, which in an element's own axes — y
    // downwards — is 90 degrees ahead of the circle-space angle `(cos t, sin t)`
    // names. Lose that 90 and the arc is drawn a quarter of the way round from
    // the handle it is supposed to run through, which is a widget pointing at
    // nothing.
    //
    // THE PLATEAU is the other: the mask reaches the whole subtree, the disc
    // included, so the ink has to be at full alpha across the handle's own
    // width or the rim that holds the handle against the model goes
    // translucent. That width is `asin` of the disc's radius in the ring's own
    // units — the half-angle the handle subtends at the ring's centre.
    const { z } = watching(null)
    const stops = [...fade(z).matchAll(/([-\d.]+)deg/g)].map((m) => Number(m[1]))
    expect(stops, 'from, and four stops').toHaveLength(5)

    const [from, ...offsets] = stops
    const degrees = (radians) => (radians * 180) / Math.PI
    // Where each stop lands on the ring's own circle, in degrees.
    const circle = offsets.map((offset) => from + offset - 90)
    const handle = degrees(DISC_T)
    const half = degrees(Math.asin(RING_DISC_PX / 2 / RING_PX))

    expect(circle[0]).toBeCloseTo(handle - RING_ARC_DEG, 6)
    expect(circle[1]).toBeCloseTo(handle - half, 6)
    expect(circle[2]).toBeCloseTo(handle + half, 6)
    expect(circle[3]).toBeCloseTo(handle + RING_ARC_DEG, 6)
  })

  it('draws the whole circle of the ring under the cursor, and of no other', () => {
    // THE FULL CIRCLE IS HOVER FEEDBACK, which is what it is for: the disc says
    // where to press and the circle that appears under the cursor says what
    // pressing there will DO — the plane the part is about to turn in, shown
    // before the reader has committed to anything.
    const { x, y, z } = watching((made) => onDisc(made.z))

    expect(fade(z)).toBe('none')
    for (const group of [x, y]) {
      expect(faded(group), 'a neighbour was lit too').toBe(true)
    }
  })

  it('lightens the disc it is on, and puts it back when the cursor leaves', () => {
    // Fusion's own second half of the same signal, and the one a reader takes
    // in without looking away from the handle they are aiming at. It changes
    // how light the ink is and not WHICH ink it is, because the colour is the
    // thing the handle exists to say.
    const made = scene({ camera: orthoCamera(OBLIQUE) })
    drawn(made.rings)
    const disc = piece(made.z, 'disc')
    const rest = brightness(disc)
    const neighbour = brightness(piece(made.x, 'disc'))

    hoverAt(made.canvas, onDisc(made.z))
    drawn(made.rings)
    expect(brightness(disc)).toBeGreaterThan(rest)
    expect(brightness(piece(made.x, 'disc')), 'a neighbour lightened too')
      .toBe(neighbour)

    // And it goes back when the cursor leaves for the middle of the widget,
    // where the part is and no handle is — still over the canvas, so this is
    // the handle being left rather than the canvas being left.
    hoverAt(made.canvas, centreOf(made.z))
    drawn(made.rings)
    expect(brightness(disc)).toBe(rest)
    expect(faded(made.z), 'and the circle went back to an arc').toBe(true)
  })

  it('keeps the ring it is TURNING lit wherever the pointer has gone', () => {
    // A DRAG OWNS THE LIGHT FOR AS LONG AS IT RUNS. The pointer leaves the disc
    // immediately — turning the part is exactly the act of carrying the hand
    // away from where it pressed — so a widget that lit only what the cursor
    // was over would go back to a faded arc under the hand holding it, which
    // reads as the gesture having ended.
    const made = scene({ camera: orthoCamera(OBLIQUE) })
    drawn(made.rings)

    press(made.canvas, onDisc(made.z))
    // Right across the widget and onto another axis's handle.
    pointerMove(onDisc(made.x))
    drawn(made.rings)

    expect(fade(made.z), 'the ring being turned').toBe('none')
    expect(faded(made.x), 'the ring the pointer happens to be over').toBe(true)
    pointerUp(onDisc(made.x))
  })

  it('says nothing about a disc the press would not reach', () => {
    // A LIGHT IS A PROMISE THAT PRESSING HERE TURNS THIS AXIS, and this layer
    // is the one widget on the page that cannot keep that promise by itself:
    // it takes no press of its own (`pointer-events: none`) and reads the
    // canvas's instead, so a press that lands on the toolbar, on a comment pin
    // or on the view cube goes to THOSE and turns nothing. A disc lying under
    // one of them is under the cursor geometrically and is not pressable —
    // and at a radius of 105 px this widget reaches further into that chrome
    // than it did at 64.
    const made = scene({ camera: orthoCamera(OBLIQUE) })
    drawn(made.rings)
    const chrome = document.createElement('div')
    document.body.appendChild(chrome)

    // The very point that would light the Z ring, arriving from something else.
    chrome.dispatchEvent(new MouseEvent('pointermove', {
      clientX: onDisc(made.z)[0], clientY: onDisc(made.z)[1], bubbles: true,
    }))
    drawn(made.rings)
    expect(faded(made.z), 'a disc under other chrome was offered').toBe(true)

    // The premise, and the whole of the difference: the same point, reached
    // over the canvas, is a hover.
    hoverAt(made.canvas, onDisc(made.z))
    drawn(made.rings)
    expect(fade(made.z)).toBe('none')
  })
})

describe('the two rings the default camera cannot show, and the far side', () => {
  // EVERY DRAG ABOVE IS ON THE Z RING UNDER THE DEFAULT CAMERA, which is the
  // one arrangement where the ring's own `(u, v)` and the screen's axes line up
  // — and it is therefore the one arrangement a sign taken off screen pixels
  // would also get right. This file says the SIGN is what it exists for, so the
  // other five cases are here: the two rings the reader has to orbit to see at
  // all, and a ring watched from the far side of its own plane, where the
  // projection runs the curve round the screen the other way.

  /** One whole drag on one ring, swept by `radians` in the ring's own plane,
   *  starting at its disc. The press point is the handle the module drew, built
   *  off its own matrix; the rest of the gesture is read in circle space, so
   *  where it passes is not the point. */
  const sweep = async (made, axis, radians) => {
    const ring = made.rings.root.children[axis]
    press(made.canvas, onRing(ring, DISC_T))
    pointerMove(onRing(ring, DISC_T + radians))
    pointerUp(onRing(ring, DISC_T + radians))
    await settled()
    // THE LATEST REPORT AND NOT THE FIRST: a second gesture on the same scene
    // is exactly what one of the tests below is about, and the dispatch spy
    // keeps every event the viewport ever raised.
    return details(made.vp, EVENT_TURNED).at(-1).turn
  }

  /** Where a quaternion sends the three world axes, as nine numbers. */
  const sends = (q) => [[1, 0, 0], [0, 1, 0], [0, 0, 1]].flatMap((v) => turned(q, v))

  const expectSends = (q, wanted) => sends(q)
    .forEach((value, at) => expect(value).toBeCloseTo(sends(wanted)[at], 9))

  it('turns about X for the X ring and about Y for the Y ring', async () => {
    // Looking down the diagonal so all three rings are open enough to aim at.
    // A quarter turn swept in the ring's own plane is a quarter turn about that
    // ring's own axis — right-handed, because `u x v` is `+k` (the pair above).
    for (const [axis, wanted] of [[0, [90, 0, 0]], [1, [0, 90, 0]]]) {
      const made = scene({ camera: orthoCamera(OBLIQUE) })
      drawn(made.rings)

      const turn = await sweep(made, axis, Math.PI / 2)

      expect(turn, `the ${'XYZ'[axis]} ring`).toEqual(wanted)
      expectSends(facing(made.groups[PART]), quaternionOf(wanted))
    }
  })

  it('turns the same way seen from the far side of the ring`s plane', async () => {
    // THE PROJECTION FLIPS A RING SEEN FROM BEHIND, and nothing about that
    // reaches the angle: it is a property of `a` and `b`, and inverting the
    // basis takes it back out. So the same quarter turn about +Z comes out of a
    // hand that went the other way round the SCREEN — which is what a sign
    // hand-picked off screen pixels could not do, and would look every bit as
    // plausible while doing it.
    const behind = { eye: [0, 0, -60], right: [-1, 0, 0], forward: [0, 0, 1] }
    const made = scene({
      camera: orthoCamera(behind),
      // In front of this camera rather than behind it: the part the default
      // fixture puts at `z = 45` is past the far plane from over here, and
      // `frameAt` takes such a ring off the screen.
      groups: { [PART]: solid(PART, [0, 0, -45]) },
    })
    drawn(made.rings)
    // The premise, and the whole of what "from behind" means here: world +X is
    // drawn to the LEFT and +Y still up, so the ring runs round the screen the
    // opposite way from the one every drag above went.
    expectMatrix(made.rings.root.children[2], [-RING_PX, 0, 0, -RING_PX])

    const turn = await sweep(made, 2, Math.PI / 2)

    expect(turn).toEqual([0, 0, 90])
    expectSends(facing(made.groups[PART]), quaternionOf([0, 0, 90]))
  })

  it('turns about the ring`s own axis on a part already standing turned', async () => {
    // THE CLAIM AT THE HEAD OF rings.js: each ring turns the part about THAT
    // AXIS ONLY. Adding the swept angle to one of the three angles keeps that
    // promise exactly once — while the part is square. `quaternionOf` reads the
    // triple as `Rz·Ry·Rx`, so adding to x is a turn about world x only while y
    // and z are both zero: from `(0, 0, 90)`, thirty added on x turns the part
    // about world Y. The rings are drawn on the WORLD axes and do not move with
    // the part, so that is the reader holding the RED ring and watching the
    // part spin around the green one, on their second gesture.
    const made = scene({ camera: orthoCamera(OBLIQUE) })
    drawn(made.rings)

    const first = await sweep(made, 2, Math.PI / 2)
    expect(first, 'the premise: it is standing at a quarter turn about Z')
      .toEqual([0, 0, 90])

    drawn(made.rings)
    const second = await sweep(made, 0, Math.PI / 6)

    // THE THREE STORED ANGLES ARE NOT WHOLE DEGREES, and that is the trade this
    // is pinned to rather than a rounding that got away: the reader swept a
    // whole thirty about the axis they grabbed, and `(0, -30, 90)` is the
    // orientation that produces. `(30, 0, 90)` — what the addition wrote — is a
    // different part, facing somewhere the hand never sent it.
    expect(second).toEqual([0, -30, 90])
    // AND WHERE THE PART REALLY ENDED UP, which is the half no spelling of the
    // angles can lie about: the pose it was standing at, with a turn about
    // world X composed on top of it.
    expectSends(
      facing(made.groups[PART]),
      after(quaternionOf([30, 0, 0]), quaternionOf([0, 0, 90])))
  })
})

// -- the two halves of one widget ---------------------------------------------

describe('what puts the widget on the part', () => {
  it('stands on the part beside the arrows, under the one tool', () => {
    // THE MERGE ITSELF, and it is assertable only with both layers up: Fusion's
    // triad is one widget carrying an origin, three arrows, three plane quads
    // and three rotation handles at once, and the reader must not have to put a
    // part down before they may turn it.
    //
    // DOWN THE DIAGONAL, which is the one camera where every piece of both
    // layers is open enough to be drawn — square on, the Z arrow is end-on and
    // two of the three quads are edge-on, so a count taken there would be about
    // the camera rather than about the merge.
    const { vp, rings, x, y, z } = scene({ camera: orthoCamera(OBLIQUE) })
    drawn(rings)
    const gizmo = createGizmo(vp)
    layers.push(gizmo)
    gizmo.refresh()
    runFrames()

    // Seven pieces on the arrows' layer — three arrows, three quads, the dot —
    // and the three handles standing among them rather than instead of them.
    expect([...gizmo.root.children].filter((el) => el.style.display !== 'none'))
      .toHaveLength(7)
    expect([x, y, z].map(shown)).toEqual([true, true, true])
  })

  it('shows both halves or neither, over every refusal either one makes', () => {
    // ONE WIDGET AND THEREFORE ONE CONDITION. `held()` in this file and `held()`
    // in gizmo.js are the same body character for character, and both files say
    // in prose that they have to be: two halves of one manipulator that came up
    // on different conditions would be a widget with a piece missing — rotation
    // handles round a part the arrows have refused to stand on, or the reverse.
    //
    // WHICH IS A SENTENCE IN A COMMENT UNTIL IT IS A TEST. Every refusal below
    // is already covered in ONE of the two files, separately, so either half
    // could drift — a clause dropped here, a clause added there — and the suite
    // would stay green while the widget came up in pieces. This is the only
    // place both factories answer the same question about the same viewport.
    //
    // DOWN THE DIAGONAL, where the widget is whole: every arrow, every quad and
    // every handle is open enough to be drawn, so "up" is an exact count and a
    // half-drawn widget is not mistaken for a hidden one.
    const BODY = '/Group/proposal/plate'
    const GROUP = '/Group/proposal'

    const bothOn = (over, tweak) => {
      const s = scene({ camera: orthoCamera(OBLIQUE), ...over })
      const gizmo = createGizmo(s.vp)
      layers.push(gizmo)
      s.vp.gizmo = gizmo
      if (tweak) tweak(s.vp)
      s.rings.refresh()
      gizmo.refresh()
      runFrames()
      return [
        [...gizmo.root.children].filter(shown).length,
        [...s.rings.root.children].filter(shown).length,
      ]
    }

    // `[arrows, handles]` when the widget is whole: three arrows, three plane
    // quads and the origin dot on one layer, three rotation handles on the
    // other.
    const WHOLE = [7, 3]
    const GONE = [0, 0]

    const cases = [
      ['a movable part under the move tool', {}, null, WHOLE],
      ['a body of the proposal the panel can name', {
        selected: [BODY],
        groups: { [BODY]: solid(BODY) },
        overlay: [{ name: 'plate' }],
      }, null, WHOLE],

      ['no tool armed', { tool: null }, null, GONE],
      ['the retired turn value', { tool: 'turn' }, null, GONE],
      ['some other tool armed', { tool: 'measure' }, null, GONE],
      ['the hold key holding the cut up', {},
       (vp) => { vp.holdActive = true }, GONE],
      ['an empty selection', { selected: [] }, null, GONE],
      ['a selection that is not a list', {}, (vp) => {
        vp.state = { ...vp.state, selected: null }
      }, GONE],
      ['a path the scene cannot move', { selected: [PART, '/Group/gone'] },
       null, GONE],
      // The overlay's own group node: the scene CAN move it, so this is refused
      // by the clause about naming alone — `overlayBody` answers null for it,
      // and a body the panel cannot name is a body no report could be about.
      ['a proposal body the panel cannot name', {
        selected: [GROUP],
        groups: { [GROUP]: solid(GROUP) },
        overlay: [{ name: 'plate' }],
      }, null, GONE],
      // One overlay path makes the whole gesture a proposal one, and then a
      // part of the build has no body name and is not grabbable into it.
      ['a mixed selection', {
        selected: [BODY, PART],
        groups: { [BODY]: solid(BODY), [PART]: solid(PART) },
        overlay: [{ name: 'plate' }],
      }, null, GONE],
    ]

    for (const [name, over, tweak, want] of cases) {
      expect(bothOn(over, tweak), name).toEqual(want)
    }
  })
})
