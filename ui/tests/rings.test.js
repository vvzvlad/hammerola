// ui/src/viewport/rings.js — the turn tool's three rings.
//
// There is no GPU here and nothing below looks at a pixel, the same discipline
// gizmo.test.js and handle.test.js keep beside it. What IS assertable is
// everything that decides whether the reader can see and use the rings at all:
// WHERE they are put (a projection, in px, of the selected part's centre), the
// SHAPE each one is drawn as (the 2x2 matrix that turns a unit circle into the
// projected ellipse), WHEN one is taken off the screen — a ring seen edge-on,
// and five different reasons for the whole widget — WHICH ring a press lands
// on, and what one whole drag does to the part and says at the end of it.
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
// halfH up), so the ring radius `RING_PX / 20` is 3.2 world units, world +X
// reads as +64 px across the screen and world +Y as -64 px up it — which makes
// the Z ring, seen square on, the circle `matrix(64, 0, 0, -64, 0, 0)`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HmrViewport } from '../src/viewport/element.js'
import { EVENT_PROPOSALTURN, EVENT_TURNED } from '../src/viewport/events.js'
import { createGizmo } from '../src/viewport/gizmo.js'
import { createRings } from '../src/viewport/rings.js'
import { cross3 } from '../src/viewport/math.js'
import { after, quaternionOf, turned } from '../src/viewport/parts.js'
import {
  CLICK_PX, RING_HIT_PX, RING_PX, RING_SHAFT_PX,
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
 * A viewport with the Turn tool armed over a movable part, and the rings
 * installed over it.
 *
 * Built on the real prototype so `activeTool`, `isOverlay` and `overlayBody` are
 * the element's own — a fake that re-implemented them would let this file agree
 * with itself instead of with the code.
 *
 * THE CANVAS IS A REAL NODE HERE, which is the one thing this fixture does that
 * gizmo.test.js's does not have to. An arrow takes its own press, so that file
 * dispatches at the arrow; this layer takes NO press at all (a div is a filled
 * box however round it is made, and a target would swallow every press inside
 * the ring) and reads the canvas's own press in the capture phase instead. So
 * the press has to be an event the DOM really dispatched at the canvas, and the
 * fake's canvas is a plain object. The rect is stubbed onto it because jsdom
 * computes no layout — the same rect as `box`, so the two cancel exactly as
 * they do on the page.
 */
function scene({
  selected = [PART], groups = { [PART]: solid(PART) }, camera, gridSize = 100,
  tool = 'turn', overlay = null,
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
  const rings = createRings(vp)
  layers.push(rings)
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

/** Where the module put the ring on the layer, in pixels. NOT assumed to be the
 *  middle of the canvas: a part sits where the camera puts it, and only a
 *  camera looking straight at the part's centre puts it there. */
const centreOf = (ring) => [Number.parseFloat(ring.style.left),
                            Number.parseFloat(ring.style.top)]

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

/** Circle-space angles halfway between two crossings, where exactly one ring is
 *  under the pointer: the three rings meet at the six world axes, which are
 *  every multiple of `pi/2` in each ring's own parametrisation. */
const CLEAR_OF_CROSSINGS = Math.PI / 4

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
 *  the listeners — a drag that starts on a ring can end anywhere. */
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
// its `v` is world +Y, which the camera puts UP — i.e. towards a smaller y.
const CENTRE = [400, 300]
const AT_X = [400 + RING_PX, 300]
const AT_Y = [400, 300 - RING_PX]
const AT_MINUS_X = [400 - RING_PX, 300]
const AT_MINUS_Y = [400, 300 + RING_PX]

describe('when there is nothing to put rings round', () => {
  it('draws nothing while no tool is armed', () => {
    const { vp, rings, z } = scene()
    drawn(rings)
    expect(shown(z), 'the premise: it is on screen with Turn armed').toBe(true)

    vp.state = { ...vp.state, tool: null }
    drawn(rings)
    expect(shown(z)).toBe(false)
  })

  it('draws nothing while the MOVE tool is the one armed', () => {
    // The two widgets stand on the same point and answer to different tools, so
    // rings up under Move would be offering a gesture the press is not for —
    // and they would be drawn across the arrows that ARE.
    const { rings, z } = scene({ tool: 'move' })
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
    // on a ring that is on screen only until the next frame.
    const { vp, rings, canvas } = scene()
    drawn(rings)
    vp.state = { ...vp.state, selected: [] }

    press(canvas, AT_X)
    pointerMove(AT_Y)

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
    // THE WHOLE OF THE DRAWING. The div is two pixels across with
    // `border-radius: 50%`, so its edge is the unit circle, and the matrix maps
    // that circle onto `cos t * a + sin t * b` — which IS the projection of the
    // world circle. Square on to Z: `u` is world +X at 64 px to the right, `v`
    // is world +Y at 64 px UP, and up the screen is a NEGATIVE y.
    const { rings, z } = scene()
    drawn(rings)

    expect(z.style.width).toBe('2px')
    expect(z.style.height).toBe('2px')
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
    // The border is in the SAME local units the circle is, so the matrix
    // multiplies it by `RING_PX` along with everything else. `box-sizing` keeps
    // the outer edge exactly on the unit circle, so the ring's size does not
    // depend on how heavy its line is.
    const { rings, z } = scene()
    drawn(rings)

    expect(z.style.boxSizing).toBe('border-box')
    expect(Number.parseFloat(z.style.borderTopWidth) * RING_PX)
      .toBeCloseTo(RING_SHAFT_PX, 9)
  })

  it('spells its three axes in the inks the move arrows use', () => {
    // ONE TRIAD AND NOT TWO. Red, green and blue for X, Y and Z is the
    // convention every CAD tool the reader has used, and the two widgets stand
    // on the same point — so a ring that disagreed with the arrow for the same
    // axis would be saying they were about different things.
    const { vp, rings } = scene()
    drawn(rings)
    const gizmo = createGizmo({ ...vp, state: { ...vp.state, tool: 'move' } })
    gizmo.refresh()
    runFrames()

    const arrows = [...gizmo.root.children].map(
      (arrow) => arrow.firstElementChild.style.backgroundColor)
    expect(arrows.filter(Boolean)).toHaveLength(3)
    expect([...rings.root.children].map((ring) => ring.style.borderTopColor))
      .toEqual(arrows)
    gizmo.destroy()
  })
})

describe('which rings are drawn at all', () => {
  it('takes the two rings the reader is looking edge-on off the screen', () => {
    // A ring seen edge-on is a line: it cannot be read, it cannot be aimed at —
    // every pixel inside it is within the hit tolerance of the curve — and its
    // 2x2 basis is singular, so neither the hit test nor the angle the drag is
    // measured in has an answer. Looking straight down Z, the X and Y rings are
    // exactly that.
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
    // world +X (the first column, 64 px right) and `v` is world +Y (the second,
    // 64 px up). X cross Y is Z, and the part turns the way the hand went.
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

describe('which ring a press lands on', () => {
  it('leaves a press that missed every ring completely alone', () => {
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

    pointerMove(AT_Y)
    expect(at(groups[PART])).toEqual([0, 0, 0])
    expect(facing(groups[PART])).toEqual([0, 0, 0, 1])
    expect(vp.moved.size).toBe(0)
  })

  it('takes a press that landed on the curve, from the trackball with it', () => {
    const { rings, canvas } = scene()
    drawn(rings)

    const event = press(canvas, AT_X)
    expect(event.stopPropagation).toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('takes a press within the tolerance and refuses one past it', () => {
    const { vp, rings, canvas } = scene()
    drawn(rings)

    press(canvas, [400 + RING_PX + RING_HIT_PX - 1, 300])
    pointerMove(AT_Y)
    expect(vp.moved.size, 'inside the tolerance').toBe(1)

    const far = scene()
    drawn(far.rings)
    press(far.canvas, [400 + RING_PX + RING_HIT_PX + 1, 300])
    pointerMove(AT_Y)
    expect(far.vp.moved.size, 'past it').toBe(0)
  })

  it('ignores every button but the primary one', () => {
    // The right button is a gesture of its own on this page — it opens the part
    // menu, and the library pans on it.
    const { vp, rings, canvas, groups } = scene()
    drawn(rings)

    const event = press(canvas, AT_X, 2)
    // Not even the refusals: a press this one does not want is a press it has
    // no business taking away from anybody else.
    expect(event.preventDefault).not.toHaveBeenCalled()

    pointerMove(AT_Y)
    expect(facing(groups[PART])).toEqual([0, 0, 0, 1])
    expect(details(vp, EVENT_TURNED)).toEqual([])
  })

  it('takes the nearer of two rings that are both hit', () => {
    // THREE RINGS CROSS AT SIX POINTS, one per world axis, and near a crossing
    // both answers are honest — the tolerance is eight pixels and the two
    // curves are inside it of each other. What decides is the distance to each
    // curve, so two presses a few pixels apart on either side of one crossing
    // have to come back as two different axes. Built off the matrices the
    // module itself wrote, so the points really are ON the curves.
    const oblique = () => {
      const made = scene({ camera: orthoCamera(OBLIQUE) })
      drawn(made.rings)
      return made
    }
    const step = (4 * Math.PI) / 180

    const first = oblique()
    // The Z ring's `u` is world +X, and the Y ring's `v` is world +X too — so
    // the two curves cross where both are at their own +X, and four degrees to
    // either side of it is a pair of points four pixels apart.
    const onZ = onRing(first.z, step)
    const onY = onRing(first.y, Math.PI / 2 + step)
    expect(Math.hypot(onZ[0] - onY[0], onZ[1] - onY[1]))
      .toBeLessThan(RING_HIT_PX)

    press(first.canvas, onZ)
    pointerMove([onZ[0] + 40, onZ[1] + 40])
    pointerUp([onZ[0] + 40, onZ[1] + 40])

    const second = oblique()
    press(second.canvas, onY)
    pointerMove([onY[0] + 40, onY[1] + 40])
    pointerUp([onY[0] + 40, onY[1] + 40])

    // One turn each, about two different axes — and the axis is read off which
    // of the three angles the gesture wrote.
    const spun = (vp) => vp.moved.get(PART).turn.findIndex((angle) => angle !== 0)
    expect(spun(first.vp), 'the press on the Z ring').toBe(2)
    expect(spun(second.vp), 'the press on the Y ring').toBe(1)
  })
})

describe('one whole drag', () => {
  it('turns the part about the axis grabbed, the way the hand went', async () => {
    // THE CLAIM THIS FILE EXISTS FOR. The camera looks down -Z with +X to the
    // right and +Y up, so a hand carried from the ring's +X point to its +Y
    // point goes anticlockwise on the screen — which about +Z is a POSITIVE
    // quarter turn, right-handed. A sign taken off a screen-space `atan2`
    // instead would be the other one, and would look every bit as plausible.
    const { vp, rings, canvas, groups } = scene()
    drawn(rings)

    press(canvas, AT_X)
    pointerMove(AT_Y)
    pointerUp(AT_Y)
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

    press(canvas, AT_X)
    pointerMove(AT_Y)

    expect(at(groups[PART])).toEqual([0, 0, 0])
  })

  it('says where it ended up once, and only when the hand comes off', async () => {
    // THE RELEASE IS THE ONLY REPORT, and it is the same one the two move
    // gestures end in: the interface answers a recorded statement by opening
    // the panel, which re-stages, and a re-stage ends the gesture the reader
    // has not let go of.
    const { vp, rings, canvas } = scene()
    drawn(rings)

    press(canvas, AT_X)
    pointerMove(AT_Y)
    await settled()
    expect(details(vp, EVENT_TURNED), 'it spoke mid-drag').toEqual([])

    pointerUp(AT_Y)
    await settled()

    const reports = details(vp, EVENT_TURNED)
    expect(reports).toHaveLength(1)
    expect(reports[0].turn).toEqual([0, 0, 90])
    expect(reports[0].paths).toEqual([PART])
    expect(reports[0].build).toBe('build-1')

    // And the gesture really ended: the window listeners went with it, so a
    // pointer that moves on past the release turns no part.
    pointerMove(AT_MINUS_X)
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

    press(canvas, AT_X)
    pointerMove(AT_Y)
    pointerMove(AT_MINUS_X)
    pointerMove(AT_MINUS_Y)
    pointerUp(AT_MINUS_Y)
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

    press(canvas, AT_X)
    // A tenth of a radian along the curve, which is 5.729... degrees.
    const t = 0.1
    pointerMove([400 + RING_PX * Math.cos(t), 300 - RING_PX * Math.sin(t)])
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

    press(canvas, AT_X)
    pointerMove(AT_Y)
    pointerUp(AT_Y)
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

    press(canvas, AT_X)
    pointerMove(AT_Y)
    pointerUp(AT_Y)
    await settled()

    expect(vp.moved.get(PART)).toEqual({ delta: [1, 2, 3], turn: [0, 0, 90] })
  })

  it('says nothing when the press never moved', async () => {
    // A bare click on a ring is not a statement: reported, it would write a
    // node the document already has and open the panel to show the reader
    // nothing new.
    const { vp, rings, canvas } = scene()
    drawn(rings)

    press(canvas, AT_X)
    pointerUp(AT_X)
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

    press(canvas, AT_X)
    pointerMove([AT_X[0] + CLICK_PX - 1, AT_X[1] + CLICK_PX - 1])
    expect(facing(groups[PART]), 'still a click').toEqual([0, 0, 0, 1])
    pointerUp([AT_X[0] + CLICK_PX - 1, AT_X[1] + CLICK_PX - 1])
    await settled()
    expect(details(vp, EVENT_TURNED)).toEqual([])

    // And one pixel past it the same gesture is a drag, carrying the whole
    // travel from the PRESS rather than from where the threshold was crossed.
    press(canvas, AT_X)
    pointerMove([AT_X[0], AT_X[1] + CLICK_PX])
    expect(vp.moved.get(PART).turn).toEqual(
      [0, 0, Math.round((-Math.atan2(CLICK_PX, RING_PX) * 180) / Math.PI)])
  })

  it('is concluded when the pointer is taken away', async () => {
    // A TURN IS REPORTED FROM EVERY ENDING, which is where this parts company
    // with the section grip: a cancelled cut is dropped, and a cancelled turn
    // leaves the part standing at an angle the document does not claim, so the
    // next reconcile would straighten it and the gesture would be silently
    // undone.
    const { vp, rings, canvas } = scene()
    drawn(rings)

    press(canvas, AT_X)
    pointerMove(AT_Y)
    pointerCancel()
    await settled()

    expect(details(vp, EVENT_TURNED)).toHaveLength(1)

    // And it really ended.
    pointerMove(AT_MINUS_X)
    expect(details(vp, EVENT_TURNED)).toHaveLength(1)
  })

  it('concludes a drag the scene is being pulled out from under', async () => {
    // The twin of `vp.endGesture`, and the reason it is a fourth call rather
    // than the same one: the press was taken in a window listener this layer
    // owns, so neither that gesture nor the idle clock that defers the swap
    // ever saw it.
    const { vp, rings, canvas } = scene()
    drawn(rings)

    press(canvas, AT_X)
    pointerMove(AT_Y)

    rings.endDrag()
    expect(details(vp, EVENT_TURNED), 'the report went out inside the render')
      .toEqual([])

    await settled()
    expect(details(vp, EVENT_TURNED)).toHaveLength(1)

    // And the release that never came cannot report a second time.
    pointerUp(AT_Y)
    await settled()
    expect(details(vp, EVENT_TURNED)).toHaveLength(1)
  })

  it('is concluded when another press arrives with it still live', async () => {
    const { vp, rings, canvas } = scene()
    drawn(rings)

    press(canvas, AT_X)
    pointerMove(AT_Y)
    press(canvas, AT_Y)
    await settled()

    expect(details(vp, EVENT_TURNED)).toHaveLength(1)
    pointerUp(AT_Y)
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

    press(canvas, AT_X)
    pointerMove(AT_Y)
    pointerUp(AT_Y)
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

    press(canvas, AT_X)
    pointerMove(AT_Y)
    pointerUp(AT_Y)
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

    press(canvas, AT_X)
    // The camera rolls a quarter turn under the live gesture. Measured again,
    // the pointer below would land somewhere else entirely on the new ellipse.
    viewer.model.right = [0, 1, 0]
    viewer.model.up = [-1, 0, 0]
    pointerMove(AT_Y)

    expect(vp.moved.get(PART).turn).toEqual([0, 0, 90])
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
   *  starting clear of the six crossings. The press point is on the curve the
   *  module drew; the rest of the gesture is read in circle space, so where it
   *  passes is not the point. */
  const sweep = async (made, axis, radians) => {
    const ring = made.rings.root.children[axis]
    const from = CLEAR_OF_CROSSINGS
    press(made.canvas, onRing(ring, from))
    pointerMove(onRing(ring, from + radians))
    pointerUp(onRing(ring, from + radians))
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
