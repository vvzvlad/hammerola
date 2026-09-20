// ui/src/viewport/rings.js — the move tool's three rotation handles.
//
// There is no GPU here and nothing below looks at a pixel, which is the same
// discipline the rest of this suite keeps — but a ring is a circle IN THE SCENE
// now, so what is assertable has moved with it exactly as it did for the
// section grip. Where the widget stands is a world point rather than a
// projection; which plane a ring lies in is a rotation taken into the world
// rather than a 2x2 matrix that had to be measured and inverted; how big it is
// drawn is `scene3d.js`'s one scale, and that module's own suite asks about it.
// Left here are the questions only this file can answer: WHAT a ring is built
// out of, HOW MUCH of it is drawn — an arc through the knob at rest, the whole
// circle under the cursor — WHEN one is taken off the screen, WHICH ring a
// press lands on, and what one whole drag does to the part and says at the end
// of it.
//
// A FRAME HERE IS THE LIBRARY DRAWING ONE, `rendered(viewer)` — the fork calls
// `onBeforeRender` at the top of `Viewer.update` and the rings are placed there,
// in the frame that then draws them. Nothing in this file runs a timer, and the
// teardown says so for every test that does not also stand up the axis arrows,
// which are still a DOM layer with a loop of their own.
//
// THE CAMERA IS TWO OBJECTS, exactly as in scene3d.test.js and handle.test.js:
// this directory's own model of an ortho projection, which every point below is
// worked out against, and a real `THREE.OrthographicCamera` at the same pose
// installed where `getCamera()` answers, because both the press and the hover
// are rays and a ray needs matrices.
//
// THE ONE CLAIM THIS FILE EXISTS FOR IS STILL THE SIGN. A ring can be drawn
// perfectly, hit perfectly and read perfectly and still turn the part the wrong
// way. The module answers by putting each ring's circle in the world plane its
// own axis is normal to, in the cyclic pair `u x v = +k`, and taking the angle
// where the pointer's RAY meets that plane — so the tests below pin the pair
// (through the rotation the module writes on each ring's node) and then pin
// where the part really ends up after a quarter turn.
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
// halfH up), so `scene3d.js`'s scale is a twentieth of a world unit per pixel
// and the ring's world radius is `RING_PX / 20` — 5.25 units. World +X reads as
// +105 px across the screen and world +Y as -105 px up it, which makes the Z
// ring, seen square on, the circle `onZ` below walks.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'

import {
  EVENT_MOVED, EVENT_PROPOSALTURN, EVENT_TURNED,
} from '../src/viewport/events.js'
import { createGizmo } from '../src/viewport/gizmo.js'
import { createRings } from '../src/viewport/rings.js'
import { after, quaternionOf, turned } from '../src/viewport/parts.js'
import {
  CLICK_PX, GIZMO_PX, RING_ARC_DEG, RING_CASE_PX, RING_DISC_PX, RING_MIN_PX,
  RING_PX, RING_RIM_PX, RING_SHAFT_PX,
} from '../src/viewport/options.js'
import { RINGS_ORDER } from '../src/viewport/scene3d.js'
import {
  makeViewport, RECT, framesAsked, rendered, settled, stubFrames,
} from './component.js'
import {
  fakeGroup, fakeShapeSolid, fakeViewer, fakeViewport, orthoCamera, realCamera,
} from './fakes.js'

const PART = '/Group/plate'

/** Looking down the diagonal, where all three rings are open enough to aim at.
 *  gizmo.test.js uses the same basis for the same reason: every axis sits at
 *  the same angle to the camera, so nothing in the answer depends on which of
 *  the three is being asked about. */
const OBLIQUE = { right: [1, -1, 0], up: [1, 1, -2], forward: [-1, -1, -1] }

const widgets = []

beforeEach(() => {
  vi.clearAllMocks()
  // STUBBED SO THAT NOTHING CAN ASK FOR A FRAME UNSEEN (ui/tests/component.js).
  // The rings drive none: they are placed from inside the library's render
  // pass, and `framesAsked` below is what says so after every test.
  stubFrames()
})

afterEach(() => {
  // Before the next test dispatches anything: a widget left standing would
  // leave a dead viewport's capture-phase listeners on the window — and these
  // keep a `pointerdown` and a `pointermove` there for their whole life rather
  // than only while a gesture runs, so they would answer for every press and
  // every movement the next test makes.
  while (widgets.length) widgets.pop().destroy()
  // NOT ONE ANIMATION FRAME, and now for BOTH halves of the manipulator: a
  // widget in the scene is placed by the render, so an idle page with the move
  // tool armed asks for nothing at all — and the way a loop creeps back in is
  // somebody re-arming one beside the render, which nothing else here would
  // show.
  expect(framesAsked(), 'the manipulator asks for no animation frames').toBe(0)
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

/** A solid whose world centre is `at`, as `partCentre` reads one: a bounding box
 *  computed off the tessellation and an identity `matrixWorld`. */
const solid = (name, at = [0, 0, 45]) => fakeShapeSolid(name, {
  positions: [at[0] - 5, at[1] - 5, at[2] - 5, at[0] + 5, at[1] + 5, at[2] + 5],
  index: [0, 1, 2],
})

/** Where the default fixture's part stands, which is where the rings stand. */
const CENTRE_AT = [0, 0, 45]

/**
 * A viewport with the Move tool armed over a movable part, a scene to stand the
 * rings in, and the rings.
 *
 * `move` AND NOT A TOOL OF THEIR OWN, which is what the tool merge settled. The
 * rings are one half of a single manipulator — the arrows, the plane quads and
 * the origin dot are the other — and both halves answer to the tool that puts
 * the widget on the part.
 *
 * Built on the real prototype so `activeTool`, `isOverlay` and `overlayBody`
 * are the element's own — a fake that re-implemented them would let this file
 * agree with itself instead of with the code.
 *
 * THE CANVAS IS A REAL NODE, for the reason handle.test.js gives for its own:
 * both the press and the hand-over are read in capture-phase listeners on the
 * WINDOW that decline any target but the canvas, so they have to be events the
 * DOM really dispatched at one. The rect is stubbed on because jsdom computes
 * no layout.
 *
 * `arrows` STANDS THE OTHER HALF UP FOR REAL, and it does it BEFORE the rings
 * because `element.js` does: both halves now read their press off the canvas in
 * a capture-phase listener on the window, and `stopImmediatePropagation`
 * silences only what was registered LATER — so construction order is the whole
 * of which one wins a contested press, and a fixture that built them the other
 * way round would be testing a page that does not exist.
 * `tests/test_ui_source.py` is what holds the real order.
 */
function scene({
  selected = [PART], groups = { [PART]: solid(PART) }, camera, gridSize = 100,
  tool = 'move', overlay = null, arrows = false,
} = {}) {
  const model = camera || orthoCamera()
  realCamera(THREE, model)
  const viewer = fakeViewer({ camera: model, rect: RECT, groups, gridSize })
  const canvas = document.createElement('div')
  canvas.getBoundingClientRect = () => ({ ...RECT })
  document.body.appendChild(canvas)
  viewer.canvas = canvas
  viewer.renderer.domElement = canvas
  viewer.scene = new THREE.Scene()

  const vp = makeViewport({
    ...fakeViewport(viewer, { tool, selected }),
    // The two fields `isOverlay` reads. Null and empty — which is what the
    // shared fixture defaults to — is a page with no proposal panel open, where
    // every path on screen is the model's own.
    payload: overlay ? { name: 'Group', parts: [] } : null,
    overlayParts: overlay || [],
    // THE OTHER HALF OF THE WIDGET, as `element.js` hangs it on the element. A
    // press on the canvas ends the arrows' gesture as well as this one's — one
    // tool means both can be live at once, and two live drags on one part
    // overwrite each other (`handOver`). A stub by default, replaced with the
    // real widget by the tests that run the pair against each other.
    gizmo: { refresh: vi.fn(), endDrag: vi.fn(), destroy: vi.fn() },
    // AND THE DOOR ONTO THE CANVAS GESTURE, which `installTools` publishes on
    // the element. A press this widget KEEPS ends that too, because the refusal
    // `scene3d.js` makes on our answer is what stops tools.js's own `onDown`
    // concluding it.
    endGesture: vi.fn(),
  })
  const gizmo = arrows ? createGizmo(vp) : null
  if (gizmo) {
    widgets.push(gizmo)
    vp.gizmo = gizmo
  }
  const rings = createRings(vp)
  widgets.push(rings)
  vp.rings = rings
  // What `show()` does on the far side of `render()`: each group joins the scene
  // the library has just built, the namespace comes with it, and the widget asks
  // for the frame that then places it. The RINGS go in first here, which no
  // press depends on — the listeners were registered above — and which is what
  // lets the two groups be told apart by the order they arrived in.
  rings.attach(THREE)
  const group = viewer.scene.children.find((child) => child.isGroup)
  if (gizmo) gizmo.attach(THREE)
  const arrowGroup = gizmo
    ? viewer.scene.children.find((child) => child.isGroup && child !== group)
    : null
  return { model, viewer, vp, groups, canvas, rings, group, gizmo, arrowGroup }
}

/** The whole widget, and one ring of it. */
const shown = (s) => s.group.visible
const ringOf = (s, axis) => s.group.children[axis]
const upright = (s, axis) => s.group.visible && ringOf(s, axis).visible

/** The three pieces one ring is built out of, in the order `build` adds them:
 *  the resting arc, the whole circle that replaces it under the cursor, and the
 *  node the knob is carried on. */
const AT = { arc: 0, whole: 1, knob: 2 }
const piece = (s, axis, name) => ringOf(s, axis).children[AT[name]]

/** One band of a piece, OUTERMOST FIRST — the dark rim, the white casing and
 *  the ink, which is the order `BANDS` in rings.js lists them in and the order
 *  they are painted in. */
const BAND = { rim: 0, casing: 1, ink: 2 }
const band = (s, axis, name, which) => piece(s, axis, name).children[BAND[which]]

/** How far one drawn band reaches from the ring's own centre, in the group's
 *  units — which are CSS pixels. Measured off the geometry rather than off a
 *  number the module wrote beside it. */
function reach(mesh) {
  mesh.geometry.computeBoundingBox()
  return mesh.position.x + mesh.geometry.boundingBox.max.x
}

/** Where one ring carries its knob, as an angle of that ring's own circle. */
function knobAt(s, axis) {
  const knob = piece(s, axis, 'knob')
  const spot = new THREE.Vector3(RING_PX, 0, 0).applyEuler(knob.rotation)
  return Math.atan2(spot.y, spot.x)
}

/** Where one ring's knob is DRAWN, on the canvas, in pixels.
 *
 * Through the group's own world matrix and this directory's camera, which is
 * the only way to ask whether the thing the reader sees is under their hand. */
function knobSpot(s, axis) {
  s.group.updateMatrixWorld(true)
  const world = band(s, axis, 'knob', 'ink')
    .getWorldPosition(new THREE.Vector3())
  return canvasAt(s, world.toArray())
}

/** A world point on the canvas, in pixels — the projection this directory
 *  models, with `spot`'s own arithmetic for the two rects, which are equal. */
function canvasAt(s, point) {
  const [nx, ny] = s.model.project(point)
  return [(nx * 0.5 + 0.5) * RECT.width, (-ny * 0.5 + 0.5) * RECT.height]
}

/** The world-unit radius the rings are drawn at under one camera: `RING_PX` of
 *  this camera's world units per pixel, which is the scale `scene3d.js` gives
 *  the group. Worked out here rather than read back off the group. */
const worldRadius = (model) =>
  (RING_PX * 2 * model.halfH) / model.zoom / RECT.height

/** The three world axes, for the pair that spans each ring's plane. */
const AXIS = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

/** Where the point of one ring's own circle at angle `t` lands on the canvas.
 *
 * `centre + R (u cos t + v sin t)`, projected — so a press there really lands
 * on the ring, and sweeping `t` by `+pi/2` is a positive quarter turn about
 * that ring's own axis whatever the camera is doing to the picture. */
const onRing = (s, axis, t, centre = CENTRE_AT) => {
  const r = worldRadius(s.model)
  const u = AXIS[(axis + 1) % 3]
  const v = AXIS[(axis + 2) % 3]
  return canvasAt(s, centre.map(
    (c, i) => c + r * (u[i] * Math.cos(t) + v[i] * Math.sin(t))))
}

/** Where each ring carries its knob, in its own circle's parametrisation: the
 *  bisector of the two world axes spanning its plane, which is 45 degrees from
 *  `u` towards `v`. Hand-worked like everything else here — the module's own
 *  `DISC_AT`.
 *
 * WHICH IS ALSO HALFWAY BETWEEN TWO CROSSINGS, and that is the point of it:
 * the three rings meet at the six world axes, every multiple of `pi/2` in each
 * ring's own parametrisation, so a knob at 45 degrees is as far from its
 * neighbours as the circle allows. */
const DISC_T = Math.PI / 4

/** The knob of one ring, on the canvas. */
const onKnob = (s, axis) => onRing(s, axis, DISC_T)

/** A pixel ON one knob but OFF its exact centre, for the tests that put the
 *  ray through a knob seen NEARLY EDGE-ON.
 *
 * The disc is a fan of triangles and its centre is their shared apex, so a ray
 * aimed exactly there lands on every one of the 24 edges at once and three's
 * `intersectTriangle` can refuse the lot — which reads as "the widget declined
 * the press" and would pass a test of that whatever the code did. Five pixels
 * round the ring's own circle is a fifth of the way to the rim of a 20 px disc,
 * so it is inside the disc under any camera and inside ONE triangle. */
const nearKnob = (s, axis) =>
  onRing(s, axis, DISC_T + RING_DISC_PX / 4 / RING_PX)

// The Z ring, seen square on by the default camera: a circle of `RING_PX` about
// the middle of an 800x600 canvas. Its `u` is world +X, which the camera puts
// to the RIGHT, and its `v` is world +Y, which it puts UP — i.e. towards a
// smaller y. Worked out here rather than read back off the module.
const MIDDLE = [400, 300]
const onZ = (t) => [400 + RING_PX * Math.cos(t), 300 - RING_PX * Math.sin(t)]

/** The Z ring's knob, and the curve a quarter turn back from it — which is
 *  where the knob is NOT, and is what a press has to be refused at. */
const AT_KNOB = onZ(DISC_T)
const AT_CURVE = onZ(DISC_T - Math.PI / 2)

/** Where a hand that grabbed that knob carries it: a quarter, a half and three
 *  quarters of a turn along the ring's own circle. */
const AT_QUARTER = onZ(DISC_T + Math.PI / 2)
const AT_HALF = onZ(DISC_T + Math.PI)
const AT_THREE_QUARTERS = onZ(DISC_T + (3 * Math.PI) / 2)

/** A press on the canvas, with both refusals watched.
 *
 * `stopImmediatePropagation` AND NOT `stopPropagation`, which is the one thing
 * about the press that changed with the move: `scene3d.js` makes the refusal
 * for every widget standing in the scene, and it makes the immediate one
 * because the section grip reads its press off this very node too. */
function press(canvas, [clientX, clientY], button = 0) {
  const event = new MouseEvent('pointerdown', {
    button, clientX, clientY, bubbles: true, cancelable: true,
  })
  vi.spyOn(event, 'stopImmediatePropagation')
  vi.spyOn(event, 'preventDefault')
  canvas.dispatchEvent(event)
  return event
}

/** The rest of the gesture. It goes to the WINDOW, which is where the widget's
 *  own listener is — a drag that starts on a ring can end anywhere, and a move
 *  the reader made over their own toolbar still carries the drag.
 *
 * WHICH IS ALSO A MOVE OVER SOMETHING THAT IS NOT THE CANVAS, and the tests
 * below lean on that: the widget reads the same `event.target` for a hover that
 * `handOver` reads for a press, so a move dispatched anywhere else is a cursor
 * standing over some other widget. `hoverAt` is the one that says otherwise. */
const pointerMove = ([clientX, clientY]) =>
  window.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY }))

/** The cursor standing over the CANVAS at a point, which is what a hover is. */
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

/** The three axis arrows, the three plane quads and the origin dot, in the
 *  order gizmo.js builds them. Read off the OTHER group in the scene, which is
 *  as much of that widget's structure as this file needs to know. */
const armOf = (s, axis) => s.arrowGroup.children[axis]
const arrowInk = (s, axis) =>
  armOf(s, axis).children[4].material.color.getHex()

/** A point ON one axis arrow, in canvas pixels: halfway out along its shaft,
 *  which is past the origin dot's rim and short of the head. That widget's
 *  group is scaled in CSS pixels too, so the conversion is `worldRadius`'s. */
const onArrow = (s, axis, along = GIZMO_PX / 2) => {
  const perPx = (2 * s.model.halfH) / s.model.zoom / RECT.height
  return canvasAt(s, CENTRE_AT.map(
    (c, i) => c + (i === axis ? along * perPx : 0)))
}

describe('when there is nothing to put rings round', () => {
  it('draws nothing while no tool is armed', () => {
    const s = scene()
    rendered(s.viewer)
    expect(shown(s), 'the premise: it is on screen with Move armed').toBe(true)

    s.vp.state = { ...s.vp.state, tool: null }
    rendered(s.viewer)
    expect(shown(s)).toBe(false)
  })

  it('draws nothing for the retired tool value', () => {
    // `turn` WAS A TOOL AND IS NOT ONE ANY MORE. The rings were its whole
    // gesture, so a reader who wanted to slide a part and then turn it had to
    // swap tools between the two halves of one widget. Both halves answer to
    // `move` now, and this pins that nothing is left behind answering to the
    // old value — a widget that came up under a name the interface no longer
    // writes would be unreachable and invisible in one move.
    const s = scene({ tool: 'turn' })
    rendered(s.viewer)
    expect(shown(s)).toBe(false)
  })

  it('draws nothing while the hold key has the cut up', () => {
    // `activeTool` AND NOT `state.tool`: the hold key puts the cut up without
    // writing to `state`, so rings read off the state field would stand there
    // offering a turn while the very next press placed a section plane.
    const s = scene()
    rendered(s.viewer)
    expect(shown(s)).toBe(true)

    s.vp.holdActive = true
    rendered(s.viewer)
    expect(shown(s)).toBe(false)
  })

  it('draws nothing with an empty selection', () => {
    const s = scene({ selected: [] })
    rendered(s.viewer)
    expect(shown(s)).toBe(false)
  })

  it('draws nothing when a selected path is one the scene cannot move', () => {
    // THE SAME GRABBABLE TEST THE PRESS APPLIES, asked of EVERY path: one
    // gesture turns the whole row, and `movePart` refuses a row it cannot move
    // whole. So rings over a selection carrying one lost path would advertise a
    // turn that then silently does nothing.
    const s = scene({ selected: [PART, '/Group/gone'] })
    rendered(s.viewer)
    expect(shown(s)).toBe(false)
  })

  it('draws nothing on a part whose centre the scene cannot give', () => {
    // A node of the tree carries no tessellation, so it has no box and no
    // centre (`partCentre`) — there is no point to stand the rings on, and
    // `movePart` refuses to turn such a thing in any case. `place` ANSWERS
    // rather than hiding, which is `scene3d.js`'s contract, and the flag on the
    // shared group is what comes off.
    const s = scene({ groups: { [PART]: fakeGroup() } })
    rendered(s.viewer)
    expect(shown(s)).toBe(false)
  })

  it('draws nothing for a selection that mixes a body with a part', () => {
    // REFUSED WHOLE, exactly as the move refuses one: a proposal body and a
    // part of the build are opposite claims about the model, and there is no
    // such thing as half of either.
    const BODY = '/Group/proposal/plate'
    const s = scene({
      selected: [BODY, PART],
      groups: { [BODY]: solid(BODY), [PART]: solid(PART) },
      overlay: [{ name: 'plate' }],
    })
    rendered(s.viewer)
    expect(shown(s)).toBe(false)
  })

  it('takes no gesture from a ring the next frame would remove', () => {
    // Both halves of the module have to agree about what is grabbable — three's
    // raycaster tests an object's LAYERS and never its visibility, so without
    // the question being asked again at the press a knob the last frame took
    // off the screen would go on answering at wherever it was last drawn.
    const s = scene()
    rendered(s.viewer)
    s.vp.state = { ...s.vp.state, selected: [] }
    rendered(s.viewer)

    const event = press(s.canvas, AT_KNOB)
    pointerMove(AT_QUARTER)

    expect(s.vp.moved.size).toBe(0)
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
  })
})

describe('what a ring is built out of', () => {
  it('lies in the world plane its own axis is normal to', () => {
    // THE SIGN OF THE WHOLE GESTURE, pinned where it is now decided — on the
    // rotation the module writes onto each ring's node, which is the one place
    // the pair is spelled at all. three builds a torus in local XY sweeping
    // from +X towards +Y, so putting local +X on `u`, local +Y on `v` and local
    // +Z on the ring's own axis is what makes the drawn curve run the
    // right-handed way round it — and `ringAngle` reads its `atan2` in that
    // very pair. Both orders draw the same circle and only one turns the part
    // the way the hand went.
    const s = scene({ camera: orthoCamera(OBLIQUE) })
    rendered(s.viewer)

    for (const axis of [0, 1, 2]) {
      const q = ringOf(s, axis).quaternion
      const sent = (v) => new THREE.Vector3(...v).applyQuaternion(q).toArray()
      const near = (got, want) => got.forEach(
        (value, k) => expect(value, `${'XYZ'[axis]} -> ${want}`)
          .toBeCloseTo(want[k], 9))
      near(sent([1, 0, 0]), AXIS[(axis + 1) % 3])
      near(sent([0, 1, 0]), AXIS[(axis + 2) % 3])
      near(sent([0, 0, 1]), AXIS[axis])
    }
  })

  it('is a circle of `RING_PX`, measured in pixels', () => {
    // The group's own units are CSS pixels — `scene3d.js` scales it so — which
    // is what keeps the widget the same size on a 2 mm part and a 200 mm one.
    // The ink's OUTER edge is `RING_PX` exactly, which is what lets the rest of
    // the module go on saying the ring's widest point is that number, and a
    // tube of `RING_SHAFT_PX` about a centre line half a shaft inside it is
    // what puts it there.
    const s = scene()
    const ink = band(s, 2, 'whole', 'ink')
    expect(ink.geometry.type).toBe('TorusGeometry')
    expect(ink.geometry.parameters.radius)
      .toBeCloseTo(RING_PX - RING_SHAFT_PX / 2, 9)
    expect(2 * ink.geometry.parameters.tube).toBeCloseTo(RING_SHAFT_PX, 9)
    expect(reach(ink)).toBeCloseTo(RING_PX, 4)
  })

  it('stands the ink on a white casing inside a dark rim, drawn under it', () => {
    // FUSION'S CONSTRUCTION AND NOT ITS PALETTE (options.js, `RING_CASE_PX`).
    // The complaint this answers is that the rings drowned in the geometry: a
    // red ring on a red part is invisible whatever red it is, and the canvas
    // under it is white or near-black depending on the reader's own answer. A
    // light casing inside a dark rim is legible against every one of those, and
    // it is GEOMETRY — three tubes about one circle — rather than a filter.
    //
    // UNDER IT, not merely present: with no depth test the renderer's order IS
    // the stacking, so a casing that sorted after the ink would paint the ring
    // out entirely. Every piece is BLENDED for that reason as well — three
    // draws its opaque list before its transparent one, and a faded arc beside
    // an opaque knob would be painted over the knob.
    const s = scene()
    const edge = (which) => reach(band(s, 2, 'whole', which))
    expect(edge('ink')).toBeCloseTo(RING_PX, 4)
    expect(edge('casing')).toBeCloseTo(RING_PX + RING_CASE_PX, 4)
    expect(edge('rim')).toBeCloseTo(RING_PX + RING_CASE_PX + RING_RIM_PX, 4)

    const order = (which) => band(s, 2, 'whole', which).renderOrder
    expect(order('rim')).toBeLessThan(order('casing'))
    expect(order('casing')).toBeLessThan(order('ink'))
    for (const which of ['rim', 'casing', 'ink']) {
      expect(band(s, 2, 'whole', which).material.transparent, which).toBe(true)
    }
    // The two construction inks are one pair for the whole widget, and the
    // knob's three are the same three colours the other way round: a filled
    // disc sharing its OUTER edge with the rim rather than a band about a line.
    const paint = (name, which) => band(s, 2, name, which).material.color.getHex()
    expect(paint('knob', 'casing')).toBe(paint('whole', 'casing'))
    expect(paint('knob', 'rim')).toBe(paint('whole', 'rim'))
    expect(paint('knob', 'ink')).toBe(paint('whole', 'ink'))
    const radius = (which) =>
      band(s, 2, 'knob', which).geometry.parameters.radius
    expect(radius('rim')).toBeCloseTo(RING_DISC_PX / 2, 9)
    expect(radius('casing')).toBeCloseTo(RING_DISC_PX / 2 - RING_RIM_PX, 9)
    expect(radius('ink'))
      .toBeCloseTo(RING_DISC_PX / 2 - RING_RIM_PX - RING_CASE_PX, 9)
    // And the knob is drawn OVER the curve, which is the other half of the
    // ladder: it sits ON the circle, so the ink of the arc runs underneath it.
    expect(band(s, 2, 'knob', 'rim').renderOrder)
      .toBeGreaterThan(band(s, 2, 'whole', 'ink').renderOrder)
  })

  it('stands in the lowest band, in the one list all three widgets share', () => {
    // TWO HALVES OF ONE ANSWER. The band is where this widget is drawn among
    // the three standing in this scene, and it is the LOWEST because
    // `element.js` builds the rings LAST and the earliest-built keeps a
    // contested press — what the reader presses has to be what they can see. A
    // knob over a quad it does not answer for is the exact failure this widget
    // exists to avoid.
    //
    // AND `transparent` IS WHY THE BAND CAN SAY THAT AT ALL: three sorts into
    // its opaque and its transparent lists by that flag before it looks at any
    // order, so the rings blended beside two opaque neighbours were drawn LAST
    // whatever number anybody gave them — over the grip and over the whole
    // manipulator.
    const s = scene()
    expect(s.group.renderOrder).toBe(RINGS_ORDER)
    for (const ring of s.group.children) {
      for (const node of ring.children) {
        for (const mesh of node.children) {
          expect(mesh.material.transparent, mesh.geometry.type).toBe(true)
        }
      }
    }
  })

  it('carries its knob ON the curve, at the bisector of the ring`s two axes', () => {
    // THE KNOB IS A CIRCLE IN THE RING'S OWN PLANE and not a dot on the screen,
    // which is what makes it possible to say it is ON the curve at all: it is a
    // disc in the same plane the ring lies in, so the camera squashes it with
    // its ring instead of leaving it a perfect circle floating over one.
    const s = scene()
    expect(knobAt(s, 2)).toBeCloseTo(DISC_T, 9)
    for (const which of ['rim', 'casing', 'ink']) {
      const disc = band(s, 2, 'knob', which)
      expect(disc.geometry.type, which).toBe('CircleGeometry')
      expect(disc.position.x, which).toBeCloseTo(RING_PX, 9)
      expect(disc.position.y, which).toBeCloseTo(0, 9)
      expect(disc.position.z, which).toBeCloseTo(0, 9)
    }
    // Which, square on to Z where nothing is flattened, is a knob standing on
    // the curve at that parameter.
    rendered(s.viewer)
    knobSpot(s, 2).forEach((value, k) => expect(value).toBeCloseTo(AT_KNOB[k], 6))
  })

  it('draws the knob whole, standing proud of the ring`s own rim', () => {
    // THE FIRST OF THE TWO BUGS THE FLAT WIDGET HAD. The knob's outer rim
    // reaches `RING_PX + RING_DISC_PX / 2` — 115 px — and the outermost band of
    // the curve stops at `RING_PX + RING_CASE_PX + RING_RIM_PX`, which is 108.
    // The at-rest fade was a `mask-image` on the element whose box was exactly
    // that second circle, and `mask-clip` is the BORDER BOX by default, so the
    // mask cut the whole subtree to it: seven of the knob's twenty pixels were
    // taken off, and the tell was that the HOVERED ring's knob came out whole
    // because lighting it set `maskImage` to `none`.
    //
    // There is nothing to clip a subtree here, and the assertion is what that
    // buys: a WHOLE disc of `RING_DISC_PX`, reaching past the ring's own rim by
    // the seven pixels the mask used to take.
    const s = scene()
    const rim = band(s, 2, 'knob', 'rim')
    rim.geometry.computeBoundingBox()
    const box = rim.geometry.boundingBox
    expect(rim.position.x + box.max.x)
      .toBeCloseTo(RING_PX + RING_DISC_PX / 2, 6)
    expect(rim.position.x + box.min.x)
      .toBeCloseTo(RING_PX - RING_DISC_PX / 2, 6)
    // ROUND AND NOT A SEGMENT OF ONE, which is what a mask would have left: the
    // disc reaches its own radius on every side of its own centre.
    expect(box.max.y).toBeCloseTo(RING_DISC_PX / 2, 6)
    expect(box.min.y).toBeCloseTo(-RING_DISC_PX / 2, 6)

    const cut = reach(band(s, 2, 'whole', 'rim'))
    expect(cut).toBeCloseTo(RING_PX + RING_CASE_PX + RING_RIM_PX, 4)
    expect(rim.position.x + box.max.x - cut)
      .toBeCloseTo(RING_DISC_PX / 2 - RING_CASE_PX - RING_RIM_PX, 4)

    // AND NOTHING ELSE TAKES A PIECE OFF IT EITHER, which is the same claim in
    // the only terms this representation has for one: a material carrying clip
    // planes is cut by the very section the reader may have standing, and one
    // that consults the depth buffer is swallowed by the part it is a handle
    // for.
    for (const which of ['rim', 'casing', 'ink']) {
      const material = band(s, 2, 'knob', which).material
      expect(material.clippingPlanes, which).toEqual([])
      expect(material.depthTest, which).toBe(false)
    }
  })

  it('draws a short arc at rest, fading to nothing at both ends', () => {
    // THE COMPLAINT THIS ANSWERS. Three closed curves of one radius, drawn
    // round a part in three colours the part may itself be painted, are three
    // things to look past rather than a control. So at rest each ring is an arc
    // through its own knob — `RING_ARC_DEG` either side of it, which a
    // `TorusGeometry` takes as its `arc` — and the soft ends the CSS mask used
    // to draw are per-vertex alpha, because a mask is a picture over a box and
    // there is no box any more.
    const s = scene()
    const arc = band(s, 2, 'arc', 'ink')
    const span = (2 * RING_ARC_DEG * Math.PI) / 180
    expect(arc.geometry.parameters.arc).toBeCloseTo(span, 9)
    // Centred on the knob: the arc is drawn from its own zero and turned back
    // by half its span, so it runs through the knob's resting angle.
    expect(piece(s, 2, 'arc').rotation.z).toBeCloseTo(DISC_T - span / 2, 9)

    // THE FADE ITSELF, read back off the vertices rather than compared as text.
    // Nothing at both ends, full across the knob's own width — which is what
    // the knob subtends at the ring's centre, and is where the ramp has to have
    // finished or the arc would show through the casing the knob stands on.
    const colour = arc.geometry.getAttribute('color')
    expect(colour.itemSize, 'alpha needs a fourth channel').toBe(4)
    expect(arc.material.vertexColors).toBe(true)
    expect(arc.material.transparent).toBe(true)

    // Every vertex, by how far round the arc it stands from the knob at the
    // middle of it. A torus puts a vertex at `((R + r cos v) cos u, ..., sin u)`
    // with `R > r`, so `atan2(y, x)` is the sweep parameter exactly and the
    // tube has no say in it.
    const position = arc.geometry.getAttribute('position')
    const fade = []
    for (let k = 0; k < position.count; k += 1) {
      const t = Math.atan2(position.getY(k), position.getX(k))
      fade.push([Math.abs(t - span / 2), colour.getW(k)])
      // The three channels the ink itself comes through on are left alone.
      expect(colour.getX(k)).toBe(1)
    }
    const half = Math.asin(RING_DISC_PX / 2 / RING_PX)
    for (const [away, alpha] of fade) {
      if (away <= half) expect(alpha, `${away} from the knob`).toBe(1)
      else expect(alpha, `${away} from the knob`).toBeLessThan(1)
      expect(alpha).toBeGreaterThanOrEqual(0)
    }
    // Nothing at all at the two ends, and a ramp that only ever falls on the
    // way out to them — a fade with a step in it would be a second edge.
    const ends = fade.filter(([away]) => away > span / 2 - 1e-9)
    expect(ends.length, 'the arc has two ends').toBeGreaterThan(0)
    // `toBeCloseTo` and not `toBe`: the angle these are read back at is an
    // `atan2` of two floats, so an end vertex lands a billionth inside the span
    // rather than exactly on it.
    for (const [, alpha] of ends) expect(alpha).toBeCloseTo(0, 6)
    const ramp = [...fade].sort((a, b) => a[0] - b[0])
    ramp.forEach(([, alpha], k) => {
      if (k) expect(alpha, `step ${k}`).toBeLessThanOrEqual(ramp[k - 1][1])
    })
    // And it really is a fade rather than a switch: halfway out along the ramp
    // the ink is about half there.
    const middling = ramp.find(([away]) => away > (half + span / 2) / 2)[1]
    expect(middling).toBeGreaterThan(0.4)
    expect(middling).toBeLessThan(0.6)
  })

  it('spells its three axes in the inks the move arrows use', () => {
    // ONE TRIAD AND NOT TWO. Red, green and blue for X, Y and Z is the
    // convention every CAD tool the reader has used, and the two widgets stand
    // on the same point — so a ring that disagreed with the arrow for the same
    // axis would be saying they were about different things. Fusion's own
    // handles are grey and we deliberately do not copy that: half a widget in
    // grey beside arrows in colour would be worse than either.
    //
    // ONE SPELLING NOW THAT BOTH ARE MESHES, which is what the arrows' own move
    // into the scene made of it: this used to be a CSS string on one side and a
    // hex on the other, and the comparison had to go through a regex.
    const s = scene({ arrows: true })
    // THE FIRST THREE CHILDREN ARE THE ARROWS, which is the order that widget
    // builds in — arrows, then the three plane quads, then the origin dot — and
    // the ink is its third band.
    const inks = [0, 1, 2].map((axis) => arrowInk(s, axis))
    expect(new Set(inks).size, 'three different inks').toBe(3)
    expect([0, 1, 2].map((axis) =>
      band(s, axis, 'whole', 'ink').material.color.getHex())).toEqual(inks)
    expect([0, 1, 2].map((axis) =>
      band(s, axis, 'arc', 'ink').material.color.getHex())).toEqual(inks)
    // And the knob is the same ink as the arc it sits on, so it says which axis
    // it is before anything is hovered.
    expect([0, 1, 2].map((axis) =>
      band(s, axis, 'knob', 'ink').material.color.getHex())).toEqual(inks)
  })
})

describe('which rings are drawn at all', () => {
  it('takes the two rings the reader is looking edge-on off the screen', () => {
    // A ring seen edge-on is a line, and so is its KNOB — a disc in the ring's
    // own plane, squashed exactly as the ring is, so what is left to press is a
    // sliver a hand cannot aim at. `GIZMO_MIN_SCALE`'s rule, one widget over: a
    // control the reader can see and cannot use is worse than no control, and
    // turning the model a little brings it back. Looking straight down Z, the X
    // and Y rings are exactly that.
    const s = scene()
    rendered(s.viewer)

    expect(upright(s, 2), 'the premise: the ring square on is up').toBe(true)
    expect(upright(s, 0)).toBe(false)
    expect(upright(s, 1)).toBe(false)
  })

  it('draws all three on an oblique camera', () => {
    // Looking down the diagonal: each ring's plane sits at the same angle to
    // the camera, so all three are open by the same amount — which is
    // `RING_PX / sqrt(3)`, comfortably over the floor.
    const s = scene({ camera: orthoCamera(OBLIQUE) })
    rendered(s.viewer)

    expect([0, 1, 2].map((axis) => upright(s, axis)))
      .toEqual([true, true, true])
    expect(RING_PX / Math.sqrt(3)).toBeGreaterThan(RING_MIN_PX)
  })

  /** A camera turned off the Z axis by `sin`, which is exactly the fraction of
   *  the X ring `RING_MIN_PX` reads — and leaves the Z ring wide open, so the
   *  widget itself is up either side of the floor. */
  const tilted = (sin) => {
    const cos = Math.sqrt(1 - sin * sin)
    return orthoCamera({
      forward: [-sin, 0, -cos], right: [cos, 0, -sin], up: [0, 1, 0],
    })
  }

  it('takes no press and offers no cursor on a ring the floor has removed', () => {
    // THE TWO HALVES HAVE TO AGREE AND CANNOT BE MADE TO BY CONSTRUCTION:
    // three's raycaster reads an object's LAYERS and never its visibility, so a
    // ring taken off the screen is still a 20 px disc standing nearly edge-on
    // in the scene. The CURSOR is the half that is easy to lose, because it is
    // cast by `scene3d.js`, which knows nothing of this widget's own floor —
    // and a canvas wearing `grab` over a ring nobody can see is a promise the
    // press then refuses.
    const open = scene({ camera: tilted(0.25) })
    rendered(open.viewer)
    expect(upright(open, 0), 'the premise: over the floor the ring is up')
      .toBe(true)
    hoverAt(open.canvas, nearKnob(open, 0))
    expect(open.canvas.style.cursor, 'the premise: the ray does land here')
      .toBe('grab')

    // The same disc at the same angle, a hair the other side of the floor.
    const s = scene({ camera: tilted(0.15) })
    rendered(s.viewer)
    expect(upright(s, 0), 'the premise: the X ring is off the screen')
      .toBe(false)

    hoverAt(s.canvas, nearKnob(s, 0))
    expect(s.canvas.style.cursor).toBe('')

    const event = press(s.canvas, nearKnob(s, 0))
    pointerMove([400, 200])
    expect(s.vp.moved.size).toBe(0)
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
  })
})

describe('what takes the press', () => {
  it('leaves a press that missed every knob completely alone', () => {
    // THE WHOLE PURCHASE OF READING THE PRESS OFF THE CANVAS: a press that
    // misses is not ours, so it goes on to the tools' own listener and to the
    // trackball behind it, and the reader can still orbit, pick and open the
    // part menu with the tool armed.
    const s = scene()
    rendered(s.viewer)

    const event = press(s.canvas, MIDDLE)
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()

    pointerMove(AT_QUARTER)
    expect(at(s.groups[PART])).toEqual([0, 0, 0])
    expect(facing(s.groups[PART])).toEqual([0, 0, 0, 1])
    expect(s.vp.moved.size).toBe(0)
  })

  it('leaves a press on the CURVE, away from the knob, alone as well', () => {
    // THE CURVE IS NOT A TARGET, which is the whole of the answer to "you
    // cannot hit the axis you mean": a ring is 660 px of circumference and
    // three of them cross six times, so a press on the curve was a press the
    // module had to guess an axis for. The drawn arc is a sign saying which way
    // the part will go and the knob is the thing to press — which in the scene
    // is said to the RAYCASTER rather than assumed, since the tubes are meshes
    // standing in front of the knobs like everything else.
    const s = scene()
    rendered(s.viewer)

    const event = press(s.canvas, AT_CURVE)
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()

    pointerMove(AT_KNOB)
    expect(facing(s.groups[PART])).toEqual([0, 0, 0, 1])
    expect(s.vp.moved.size).toBe(0)
  })

  it('takes a press that landed on the knob, from the trackball with it', () => {
    const s = scene()
    rendered(s.viewer)

    const event = press(s.canvas, AT_KNOB)
    expect(event.stopImmediatePropagation).toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('takes a press to the knob`s edge and refuses one past it', () => {
    // THE TARGET IS AS WIDE AS WHAT IS DRAWN, which is what replaced the old
    // curve test's invented tolerance: the knob is `RING_DISC_PX` across and so
    // is the disc the ray meets. Square on to Z the ring's plane is the screen,
    // so the edge is exactly half of that away in any direction.
    const half = RING_DISC_PX / 2
    const s = scene()
    rendered(s.viewer)

    press(s.canvas, [AT_KNOB[0] + half - 1, AT_KNOB[1]])
    pointerMove(AT_QUARTER)
    expect(s.vp.moved.size, 'inside the knob').toBe(1)

    const far = scene()
    rendered(far.viewer)
    press(far.canvas, [AT_KNOB[0] + half + 1, AT_KNOB[1]])
    pointerMove(AT_QUARTER)
    expect(far.vp.moved.size, 'past its edge').toBe(0)
  })

  it('ignores every button but the primary one', () => {
    // The right button is a gesture of its own on this page — it opens the part
    // menu, and the library pans on it. A press this widget does not want is a
    // press it has no business taking away from anybody else.
    const s = scene()
    rendered(s.viewer)

    const event = press(s.canvas, AT_KNOB, 2)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()

    pointerMove(AT_QUARTER)
    expect(facing(s.groups[PART])).toEqual([0, 0, 0, 1])
    expect(details(s.vp, EVENT_TURNED)).toEqual([])
  })

  it('puts the three knobs in three different places under one camera', () => {
    // THE SEPARATION IS THE WIDGET'S WHOLE CLAIM. Three circles of one radius
    // about one point are indistinguishable near their crossings; three knobs,
    // each at the bisector of its own ring's two world axes, are 60 degrees
    // apart in the world and land in three different corners of the picture.
    // Looking down the diagonal — the camera where all three rings are equally
    // open — no two of them are within a knob's width of each other, so there
    // is no press that could be meant for two axes.
    const s = scene({ camera: orthoCamera(OBLIQUE) })
    rendered(s.viewer)

    const knobs = [0, 1, 2].map((axis) => onKnob(s, axis))
    for (const [first, second] of [[0, 1], [0, 2], [1, 2]]) {
      const apart = Math.hypot(knobs[first][0] - knobs[second][0],
                               knobs[first][1] - knobs[second][1])
      expect(apart, `${'XYZ'[first]} and ${'XYZ'[second]}`)
        .toBeGreaterThan(RING_DISC_PX)
    }
  })

  it('turns about the axis whose knob was pressed, and no other', () => {
    // The other half of the same claim, and the one that says the separation is
    // the MODULE's and not this file's arithmetic: each of the three knobs,
    // pressed where it is drawn, starts a turn about its own axis.
    for (const axis of [0, 1, 2]) {
      const s = scene({ camera: orthoCamera(OBLIQUE) })
      rendered(s.viewer)

      press(s.canvas, onKnob(s, axis))
      pointerMove(onRing(s, axis, DISC_T + Math.PI / 2))
      pointerUp(onRing(s, axis, DISC_T + Math.PI / 2))

      const turn = s.vp.moved.get(PART).turn
      expect(turn.findIndex((angle) => angle !== 0),
             `the ${'XYZ'[axis]} knob`).toBe(axis)
    }
  })

  it('takes one of two knobs that overlap, and turns about that one alone', () => {
    // TWO KNOBS CAN LAND ON ONE POINT, and what breaks the tie is now the ray
    // itself: `intersectObject` answers with the NEAREST hit, so the knob
    // standing in front is the one the hand gets. What it takes to arrange is a
    // camera looking down the DIFFERENCE of two knobs' world directions —
    // `h_X - h_Z` is `(Z - X)/sqrt2`, so down `(1, 0, -1)` — and this one looks
    // a tenth of the way off it.
    //
    // THE THIRD RING IS GONE WHILE THEY OVERLAP, which is not a coincidence and
    // is what bounds this to two: that difference is square on to the third
    // axis, so a camera looking down it lies in the third ring's own plane and
    // `RING_MIN_PX` has already taken that ring off the screen.
    const s = scene({ camera: orthoCamera({
      forward: [1, 0.1, -1], right: [1, 0, 1], up: [-0.1, 2, 0.1],
    }) })
    rendered(s.viewer)
    expect(upright(s, 1), 'the third ring is edge-on and gone').toBe(false)
    const onX = onKnob(s, 0)
    const onZ2 = onKnob(s, 2)
    const apart = Math.hypot(onX[0] - onZ2[0], onX[1] - onZ2[1])
    expect(apart, 'the premise: the two knobs overlap')
      .toBeLessThan(RING_DISC_PX / 2)

    const mid = [(onX[0] + onZ2[0]) / 2, (onX[1] + onZ2[1]) / 2]
    const event = press(s.canvas, mid)
    pointerMove([mid[0] + 40, mid[1] + 40])
    pointerUp([mid[0] + 40, mid[1] + 40])

    expect(event.stopImmediatePropagation, 'the press was refused outright')
      .toHaveBeenCalled()
    // ONE axis and not two: a widget that could not decide would either turn
    // nothing or write two angles into one triple.
    const turn = s.vp.moved.get(PART).turn
    expect(turn.filter((angle) => angle !== 0)).toHaveLength(1)
    expect(turn[1], 'the ring that is not on screen').toBe(0)
  })

  it('leaves the arrows theirs and keeps its own, on the one canvas', () => {
    // THE CLAIM THAT LETS ONE TOOL DRIVE TWO WIDGETS, checked rather than
    // assumed — and it is a different claim now that both halves are objects in
    // the scene. They used to be told apart by the DOM: an arrow was a BOX and
    // took its press on its own element, and the single line that kept these
    // window listeners from stealing it was `event.target !== g.canvas`. Both
    // read the same canvas now, so what keeps them out of each other's way is
    // that each answers only for a ray that landed on its OWN meshes — and,
    // where two really do overlap, the order `element.js` builds them in, which
    // `tests/test_ui_source.py` holds.
    //
    // SO THE TWO TARGETS ARE PRESSED IN TURN, on one canvas, in one scene.
    const s = scene({ arrows: true })
    rendered(s.viewer)

    const arrow = onArrow(s, 0)
    press(s.canvas, arrow)
    pointerMove([arrow[0] + 200, arrow[1] + 60])

    const said = s.vp.moved.get(PART)
    expect(said, 'the arrow took its own press').toBeTruthy()
    expect(said.turn, 'and the rings did not take it too').toEqual([0, 0, 0])
    expect(said.delta[0]).not.toBe(0)

    // And the knob's own pixel is still the knob's, with the arrows standing.
    const other = scene({ arrows: true })
    rendered(other.viewer)
    press(other.canvas, AT_KNOB)
    pointerMove(AT_QUARTER)
    expect(other.vp.moved.get(PART).turn).not.toEqual([0, 0, 0])
    expect(other.vp.moved.get(PART).delta, 'and the arrows did not take it')
      .toEqual([0, 0, 0])
  })

  it('ends the other half`s drag, and is ended by it, either way round', async () => {
    // TWO LIVE GESTURES ON ONE PART, which is what the tool merge made possible
    // and neither half defended against. Both ends already conclude their OWN
    // previous gesture; what could not happen before was the CROSS case — this
    // widget wanted `turn` and the arrows wanted `move`, so only one was ever
    // alive to be interrupted.
    //
    // AND TWO ARE WORSE THAN A STALE ONE. Both `onMove`s are on the window and
    // neither filters by pointer id, so both run on every move; each then calls
    // `movePart`, which writes position AND orientation together from its own
    // snapshot of the other's half — so left alone they overwrite each other
    // frame by frame and both report at the release.
    //
    // CONCLUDED AND NOT ABANDONED, which is `concludeMove`'s argument: the part
    // is standing where the reader left it and only the document can be wrong
    // about that.
    const both = () => {
      const made = scene({ arrows: true })
      rendered(made.viewer)
      return { ...made, arrow: onArrow(made, 0) }
    }
    const slide = (made) =>
      pointerMove([made.arrow[0] + 200, made.arrow[1] + 60])

    // A TURN IN PROGRESS, INTERRUPTED BY A PRESS ON AN ARROW.
    const a = both()
    press(a.canvas, AT_KNOB)
    pointerMove(AT_QUARTER)
    const spun = a.vp.moved.get(PART).turn
    expect(spun, 'the premise: the part really is being turned')
      .not.toEqual([0, 0, 0])

    press(a.canvas, a.arrow)
    await settled()
    expect(details(a.vp, EVENT_TURNED), 'the turn was dropped rather than said')
      .toHaveLength(1)

    slide(a)
    // The handles have let go — the angle stands where the hand left it — while
    // the arrow that took over is writing the offset.
    expect(a.vp.moved.get(PART).turn).toEqual(spun)
    expect(a.vp.moved.get(PART).delta).not.toEqual([0, 0, 0])

    // AND THE SAME THING THE OTHER WAY ROUND: a slide in progress, interrupted
    // by a press on a knob.
    const b = both()
    press(b.canvas, b.arrow)
    slide(b)
    const slid = b.vp.moved.get(PART).delta
    expect(slid, 'the premise: the part really is being slid').not.toEqual([0, 0, 0])

    press(b.canvas, AT_KNOB)
    await settled()
    expect(details(b.vp, EVENT_MOVED), 'the slide was dropped rather than said')
      .toHaveLength(1)

    pointerMove(AT_QUARTER)
    // The arrow has let go, and the offset it left behind is carried through the
    // turn rather than straightened — `turnRecord` reads it off `vp.moved`,
    // which the conclusion above had already written.
    expect(b.vp.moved.get(PART).delta).toEqual(slid)
    expect(b.vp.moved.get(PART).turn).not.toEqual([0, 0, 0])

    // AND ON A PRESS THAT MISSES EVERY KNOB, which is the whole reason the
    // hand-over is a listener of its own rather than the head of the press
    // `scene3d.js` routes: that one is called only for a press the ray LANDED
    // on. This is the same reader stranding the same gesture with a second
    // finger on the bare model.
    const c = both()
    press(c.canvas, c.arrow)
    slide(c)
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

  it('hands the canvas gesture on only for a press it actually keeps', () => {
    // THE THIRD THING THAT CAN BE LIVE, and the one neither half can end by
    // itself. tools.js concludes its own previous press at the head of its
    // `onDown` — and that listener sees every press aimed at the canvas, so a
    // press this widget DECLINES needs nothing from us. What opens the hole is
    // the refusal `scene3d.js` makes on our answer: a press this widget KEEPS
    // never reaches that listener, so the free drag a first finger started
    // stays live.
    //
    // SO THE CALL BELONGS TO THE KEPT PRESS ALONE, and that is what this pins
    // rather than merely that the call exists. `endGesture` CONCLUDES, and
    // concluding a cut means `reportCut`, which the interface answers by
    // disarming the armed tool — which is exactly why tools.js's own `onDown`
    // calls `concludeMove` and not `conclude`. Hoisted into `handOver`, this
    // would do that on every ordinary canvas press with a cut still live.
    const taken = scene()
    rendered(taken.viewer)
    press(taken.canvas, AT_KNOB)
    expect(taken.vp.endGesture).toHaveBeenCalled()

    const missed = scene()
    rendered(missed.viewer)
    press(missed.canvas, AT_CURVE)
    expect(missed.vp.endGesture).not.toHaveBeenCalled()
  })
})

describe('one whole drag', () => {
  it('turns the part about the axis grabbed, the way the hand went', async () => {
    // THE CLAIM THIS FILE EXISTS FOR. The camera looks down -Z with +X to the
    // right and +Y up, so a hand carried from the Z ring's knob — up and to the
    // right of the part, on the bisector of +X and +Y — a quarter turn along
    // the curve goes anticlockwise on the screen, which about +Z is a POSITIVE
    // quarter turn, right-handed. A sign taken off a screen-space `atan2`
    // instead would be the other one, and would look every bit as plausible.
    const s = scene()
    rendered(s.viewer)

    press(s.canvas, AT_KNOB)
    pointerMove(AT_QUARTER)
    pointerUp(AT_QUARTER)
    await settled()

    expect(s.vp.moved.get(PART)).toEqual({ delta: [0, 0, 0], turn: [0, 0, 90] })
    // AND WHERE THE PART REALLY ENDED UP, which is the half a sign cannot lie
    // about: the group's own quaternion, asked where it sends the world +X
    // axis. A quarter turn about +Z sends it to +Y.
    const q = facing(s.groups[PART])
    expect(q).toEqual(quaternionOf([0, 0, 90]))
    const sent = turned(q, [1, 0, 0])
    expect(sent[0]).toBeCloseTo(0, 9)
    expect(sent[1]).toBeCloseTo(1, 9)
    expect(sent[2]).toBeCloseTo(0, 9)
  })

  it('carries the knob round under the hand while the drag runs', () => {
    // THE SECOND OF THE TWO BUGS THE FLAT WIDGET HAD, and the one that had to
    // be done deliberately rather than hoped for. The knob's angle used to be
    // written once into a static child offset at build time, and the frame
    // rewrote only the group's position and its 2x2 — so `swept` was never read
    // at draw time and the knob stood still while the part turned under the
    // hand. Here the angle is geometry: the knob sits at its resting place plus
    // the angle swept so far, which is what a handle means.
    //
    // A SWEEP THAT IS NOT A WHOLE NUMBER OF DEGREES, deliberately: the part is
    // turned in whole degrees and the knob follows the HAND, so one radian of
    // sweep puts the knob at one radian and the part at 57. A knob drawn off
    // the part's own angle would land a twentieth of a degree away and pass
    // every assertion but this one.
    const s = scene()
    rendered(s.viewer)
    expect(knobAt(s, 2), 'at rest it sits on the bisector').toBeCloseTo(DISC_T, 9)

    const hand = onZ(DISC_T + 1)
    press(s.canvas, AT_KNOB)
    pointerMove(hand)
    rendered(s.viewer)

    expect(s.vp.moved.get(PART).turn, 'the part moved in whole degrees')
      .toEqual([0, 0, Math.round(180 / Math.PI)])
    expect(knobAt(s, 2)).toBeCloseTo(DISC_T + 1, 6)
    // AND IT IS REALLY UNDER THE HAND, which is the whole of the claim: the
    // knob as DRAWN projects onto the pointer that is dragging it.
    knobSpot(s, 2).forEach((value, k) => expect(value).toBeCloseTo(hand[k], 6))

    // And it goes back to its resting place when the hand comes off — the rings
    // stay on the world axes, so the knob does too.
    pointerUp(hand)
    rendered(s.viewer)
    expect(knobAt(s, 2)).toBeCloseTo(DISC_T, 9)
  })

  it('leaves the other two rings` knobs exactly where they were', () => {
    // A drag turns ONE ring's knob, because it is the one the hand is on. The
    // other two are still saying where to press for their own axes.
    const s = scene({ camera: orthoCamera(OBLIQUE) })
    rendered(s.viewer)

    press(s.canvas, onKnob(s, 2))
    pointerMove(onRing(s, 2, DISC_T + 1))
    rendered(s.viewer)

    expect(knobAt(s, 2)).toBeCloseTo(DISC_T + 1, 6)
    expect(knobAt(s, 0)).toBeCloseTo(DISC_T, 9)
    expect(knobAt(s, 1)).toBeCloseTo(DISC_T, 9)
  })

  it('turns it about its own centre, so it does not swing across the scene', () => {
    // The group's origin is not the part's centre — a leaf's vertices are its
    // own coordinates and its `loc` is where the view puts it — so a quaternion
    // written on its own would throw the part across the model. `movePart`
    // takes both fields, and here the two cancel exactly: a part turned about
    // its own centre stands where it stood.
    const s = scene()
    rendered(s.viewer)

    press(s.canvas, AT_KNOB)
    pointerMove(AT_QUARTER)

    expect(at(s.groups[PART])).toEqual([0, 0, 0])
  })

  it('says where it ended up once, and only when the hand comes off', async () => {
    // THE RELEASE IS THE ONLY REPORT, and it is the same one the two move
    // gestures end in: the interface answers a recorded statement by opening
    // the panel, which re-stages, and a re-stage ends the gesture the reader
    // has not let go of.
    const s = scene()
    rendered(s.viewer)

    press(s.canvas, AT_KNOB)
    pointerMove(AT_QUARTER)
    await settled()
    expect(details(s.vp, EVENT_TURNED), 'it spoke mid-drag').toEqual([])

    pointerUp(AT_QUARTER)
    await settled()

    const reports = details(s.vp, EVENT_TURNED)
    expect(reports).toHaveLength(1)
    expect(reports[0].turn).toEqual([0, 0, 90])
    expect(reports[0].paths).toEqual([PART])
    expect(reports[0].build).toBe('build-1')

    // And the gesture really ended: the window listeners went with it, so a
    // pointer that moves on past the release turns no part.
    pointerMove(AT_HALF)
    expect(s.vp.moved.get(PART).turn).toEqual([0, 0, 90])
  })

  it('carries a gesture past the seam and lands where the hand left it', async () => {
    // `atan2` comes back in (-pi, pi], so a hand carried past the seam reads as
    // a jump of nearly a whole turn the other way unless the STEP between two
    // events is what is accumulated, which is what `onMove` does.
    //
    // THREE QUARTERS THE POSITIVE WAY IS A QUARTER SHORT OF HOME, and that is
    // the assertion: minus ninety and not plus ninety. What a node stores is
    // three angles read back out of a ROTATION (`anglesOf` in math.js), and a
    // rotation does not remember how many times round the hand went.
    const s = scene()
    rendered(s.viewer)

    press(s.canvas, AT_KNOB)
    pointerMove(AT_QUARTER)
    pointerMove(AT_HALF)
    pointerMove(AT_THREE_QUARTERS)
    pointerUp(AT_THREE_QUARTERS)
    await settled()

    expect(details(s.vp, EVENT_TURNED)[0].turn).toEqual([0, 0, -90])
    // And the part is really standing there: three quarters anticlockwise sends
    // world +X to -Y, where one quarter the other way would have sent it to +Y.
    const sent = turned(facing(s.groups[PART]), [1, 0, 0])
    expect(sent[0]).toBeCloseTo(0, 9)
    expect(sent[1]).toBeCloseTo(-1, 9)
    expect(sent[2]).toBeCloseTo(0, 9)
  })

  it('snaps to whole degrees', async () => {
    // A number this gesture produces travels to an agent in a sentence, and
    // 31.7413 degrees claims a precision no hand has. A degree is also the step
    // the row's own field takes, so a turn made with a ring and a turn typed
    // into the panel land on the same grid.
    const s = scene()
    rendered(s.viewer)

    press(s.canvas, AT_KNOB)
    // A tenth of a radian along the curve, which is 5.729... degrees.
    pointerMove(onZ(DISC_T + 0.1))
    pointerUp(MIDDLE)
    await settled()

    expect(details(s.vp, EVENT_TURNED)[0].turn).toEqual([0, 0, 6])
  })

  it('leaves the two axes it is not on exactly as it found them', async () => {
    // AN ANGLE ALREADY STANDING NEED NOT BE A WHOLE DEGREE. It comes from the
    // proposal document, whose `turn.<axis>` fields the reader types by hand —
    // so rounding all three would turn the part about an axis this gesture
    // never touched, a number written as 12.3 coming back as 12.
    const s = scene()
    rendered(s.viewer)
    s.vp.moved.set(PART, { delta: [0, 0, 0], turn: [12.3, 0, 0] })

    press(s.canvas, AT_KNOB)
    pointerMove(AT_QUARTER)
    pointerUp(AT_QUARTER)
    await settled()

    expect(details(s.vp, EVENT_TURNED)[0].turn).toEqual([12.3, 0, 90])
  })

  it('carries the offset the part is already standing at', async () => {
    // `movePart` writes position and orientation together on every call, so a
    // turn that left the delta out would send a part the reader had dragged
    // home the instant they turned it — an answer to a question they did not
    // ask, from a gesture that says nothing about where the part goes.
    const s = scene()
    rendered(s.viewer)
    s.vp.moved.set(PART, { delta: [1, 2, 3], turn: [0, 0, 0] })

    press(s.canvas, AT_KNOB)
    pointerMove(AT_QUARTER)
    pointerUp(AT_QUARTER)
    await settled()

    expect(s.vp.moved.get(PART)).toEqual({ delta: [1, 2, 3], turn: [0, 0, 90] })
  })

  it('says nothing when the press never moved', async () => {
    // A bare click on a ring is not a statement: reported, it would write a
    // node the document already has and open the panel to show the reader
    // nothing new.
    const s = scene()
    rendered(s.viewer)

    press(s.canvas, AT_KNOB)
    pointerUp(AT_KNOB)
    await settled()

    expect(details(s.vp, EVENT_TURNED)).toEqual([])
  })

  it('does nothing for a hand that shook, and everything a pixel later', async () => {
    // A CLICK IS NOT A ONE-PIXEL DRAG, which the canvas gesture spells out and
    // this one has to spell the same way. Below `CLICK_PX` there is nothing the
    // reader could have meant: nothing selects on a ring, so the only thing a
    // twitch between press and release can do is turn the part a degree and
    // file a node — and the interface answers a filed node by opening the
    // panel.
    const s = scene()
    rendered(s.viewer)

    press(s.canvas, AT_KNOB)
    pointerMove([AT_KNOB[0] + CLICK_PX - 1, AT_KNOB[1] + CLICK_PX - 1])
    expect(facing(s.groups[PART]), 'still a click').toEqual([0, 0, 0, 1])
    pointerUp([AT_KNOB[0] + CLICK_PX - 1, AT_KNOB[1] + CLICK_PX - 1])
    await settled()
    expect(details(s.vp, EVENT_TURNED)).toEqual([])

    // And exactly one pixel further the same gesture IS a drag: `CLICK_PX` of
    // travel on either axis is the boundary, so a move of exactly that much is
    // past it.
    //
    // CARRYING THE WHOLE TRAVEL FROM THE PRESS, not from where the threshold
    // was crossed, which is the other half and the one a refused event could
    // quietly break: the twitch above must not have advanced the angle this
    // sweep is measured against. Straight down the screen from the knob, the
    // ring's own angle there is `atan2` of the two coordinates the press and
    // the travel make — a degree and a half backwards, where an angle that had
    // crept forward with the twitch would answer plus one.
    const again = scene()
    rendered(again.viewer)
    press(again.canvas, AT_KNOB)
    pointerMove([AT_KNOB[0] + CLICK_PX - 1, AT_KNOB[1] + CLICK_PX - 1])
    pointerMove([AT_KNOB[0], AT_KNOB[1] + CLICK_PX])
    const swept = Math.atan2(Math.SQRT1_2 - CLICK_PX / RING_PX, Math.SQRT1_2)
      - DISC_T
    expect(again.vp.moved.get(PART).turn)
      .toEqual([0, 0, Math.round((swept * 180) / Math.PI)])
  })

  it('is concluded when the pointer is taken away', async () => {
    // A TURN IS REPORTED FROM EVERY ENDING, which is where this parts company
    // with the section grip: a cancelled cut is dropped, and a cancelled turn
    // leaves the part standing at an angle the document does not claim, so the
    // next reconcile would straighten it and the gesture would be silently
    // undone.
    const s = scene()
    rendered(s.viewer)

    press(s.canvas, AT_KNOB)
    pointerMove(AT_QUARTER)
    pointerCancel()
    await settled()

    expect(details(s.vp, EVENT_TURNED)).toHaveLength(1)

    // And it really ended.
    pointerMove(AT_HALF)
    expect(details(s.vp, EVENT_TURNED)).toHaveLength(1)
  })

  it('concludes a drag the scene is being pulled out from under', async () => {
    // The twin of `vp.endGesture`, and the reason it is a fourth call rather
    // than the same one: the press was taken in a window listener this widget
    // owns, so neither that gesture nor the idle clock that defers the swap
    // ever saw it.
    const s = scene()
    rendered(s.viewer)

    press(s.canvas, AT_KNOB)
    pointerMove(AT_QUARTER)

    s.rings.endDrag()
    expect(details(s.vp, EVENT_TURNED), 'the report went out inside the render')
      .toEqual([])

    await settled()
    expect(details(s.vp, EVENT_TURNED)).toHaveLength(1)

    // And the release that never came cannot report a second time.
    pointerUp(AT_QUARTER)
    await settled()
    expect(details(s.vp, EVENT_TURNED)).toHaveLength(1)
  })

  it('is concluded when another press arrives with it still live', async () => {
    const s = scene()
    rendered(s.viewer)

    press(s.canvas, AT_KNOB)
    pointerMove(AT_QUARTER)
    press(s.canvas, AT_QUARTER)
    await settled()

    expect(details(s.vp, EVENT_TURNED)).toHaveLength(1)
    pointerUp(AT_QUARTER)
  })

  it('holds the ring it was pressed on, and reads the angle off the world', () => {
    // THE PLANE IS MEASURED ONCE AND HELD, which is the rule both the other
    // manipulators keep, and in this representation the plane is the whole of
    // what there is to hold: the ring's axis and the part's centre. A turn
    // about the part's own centre leaves that centre where it was, so nothing
    // else about the gesture can move under it.
    //
    // AND WHAT IS NOT HELD IS THE CAMERA, deliberately. The angle is where the
    // pointer's RAY meets that plane, so a camera that rolls mid-drag changes
    // nothing about the answer as long as the hand follows the point it was
    // holding: the same world point on the Z ring is a quarter turn from where
    // the press landed, however the screen has been turned under it. A gesture
    // measured in screen pixels would have read the roll as a turn of its own,
    // and the pointer below really has moved a hundred pixels.
    const roll = Math.PI / 6
    const s = scene()
    rendered(s.viewer)

    press(s.canvas, AT_KNOB)
    s.model.right = [Math.cos(roll), Math.sin(roll), 0]
    s.model.up = [-Math.sin(roll), Math.cos(roll), 0]
    realCamera(THREE, s.model)
    const hand = onRing(s, 2, DISC_T + Math.PI / 2)
    expect(Math.hypot(hand[0] - AT_KNOB[0], hand[1] - AT_KNOB[1]))
      .toBeGreaterThan(CLICK_PX)
    pointerMove(hand)

    expect(s.vp.moved.get(PART).turn).toEqual([0, 0, 90])
  })

  it('edits the panel`s document for a body the proposal staged', async () => {
    // THE SECOND MEANING OF THE SAME GESTURE, and the rings reach it through
    // the same dispatch the two drags use. A body of the proposal is the
    // reader's OWN drawing: it turns for the eye alone while the hand is down,
    // nothing is recorded for it, and the release names the body to the panel.
    const BODY = '/Group/proposal/plate'
    const s = scene({
      selected: [BODY],
      groups: { [BODY]: solid(BODY) },
      // `origin` IS THE BODY'S OWN `at`, which the panel puts on every part it
      // builds (proposalgeom.js) because the scene cannot answer for it.
      overlay: [{ name: 'plate', origin: [0, 0, 0] }],
    })
    rendered(s.viewer)
    expect(shown(s), 'the premise: a body is grabbable like any part').toBe(true)

    press(s.canvas, AT_KNOB)
    pointerMove(AT_QUARTER)
    pointerUp(AT_QUARTER)
    await settled()

    const [report] = details(s.vp, EVENT_PROPOSALTURN)
    expect(report.name).toBe('plate')
    expect(report.turn).toEqual([0, 0, 90])
    // It really turned while the hand was down, and about its own origin.
    expect(facing(s.groups[BODY])).toEqual(quaternionOf([0, 0, 90]))
    expect(at(s.groups[BODY])).toEqual([0, 0, 0])
    // And none of what a part of the build leaves behind.
    expect(s.vp.moved.size, 'an offset was written for it').toBe(0)
    expect(s.vp.partHome.size, 'a home was remembered for it').toBe(0)
    expect(s.vp.partFacing.size, 'a pose was remembered for it').toBe(0)
    expect(s.vp.partPivot.size, 'a pivot was remembered for it').toBe(0)
    expect(details(s.vp, EVENT_TURNED)).toEqual([])
  })

  it('turns a body about the point the DOCUMENT turns it about', async () => {
    // THE PREVIEW'S JOB IS TO SHOW WHAT WILL HAPPEN, and what will happen is
    // `placed` in proposalgeom.js: a body is rotated in its OWN coordinates and
    // only then carried to `at`, so `at` is the single world point a change of
    // `rot` leaves exactly where it is. The centre of the body's BOX is a
    // different point for every op that is not centred on its own origin, and a
    // preview taken about that swings the body away and lets it jump back on
    // release.
    const BODY = '/Group/proposal/block'
    const ORIGIN = [10, 0, 20]
    const s = scene({
      selected: [BODY],
      groups: { [BODY]: solid(BODY) },
      overlay: [{ name: 'block', origin: ORIGIN }],
    })
    rendered(s.viewer)

    press(s.canvas, AT_KNOB)
    pointerMove(AT_QUARTER)
    pointerUp(AT_QUARTER)
    await settled()

    // WHERE A WORLD POINT OF THE BODY ENDS UP is `position + q·p`, which is what
    // three.js composes the group's world matrix out of. The body's own origin
    // has to come back to itself: that is what "turned about this point" means.
    const stood = at(s.groups[BODY])
    const q = facing(s.groups[BODY])
    const lands = (p) => turned(q, p).map((value, axis) => value + stood[axis])
    lands(ORIGIN).forEach((value, axis) =>
      expect(value).toBeCloseTo(ORIGIN[axis], 9))
    // And the negative control, so this is not just a body that did not move:
    // the centre of its box, which is where the old pivot was, HAS gone round.
    expect(lands([0, 0, 45])[1]).toBeCloseTo(-10, 9)
  })
})

describe('what the cursor says about which axis is about to turn', () => {
  /** All three rings open, and the pointer put somewhere with a frame drawn
   *  after it — which is the order the module reads them in: the move handler
   *  casts the ray and asks the library to draw, and `place` applies it. */
  const watching = (where) => {
    const made = scene({ camera: orthoCamera(OBLIQUE) })
    rendered(made.viewer)
    if (where) hoverAt(made.canvas, where(made))
    rendered(made.viewer)
    return made
  }

  /** Whether one ring is drawn as an arc — the resting form — or whole. */
  const arcOnly = (s, axis) => piece(s, axis, 'arc').visible
    && !piece(s, axis, 'whole').visible
  const drawnWhole = (s, axis) => piece(s, axis, 'whole').visible
    && !piece(s, axis, 'arc').visible

  /** How light one knob's ink is, as the sum of its three channels — which is
   *  all "the knob lightens" needs, and it needs no second copy of the hexes. */
  const brightness = (s, axis) => {
    const hex = band(s, axis, 'knob', 'ink').material.color.getHex()
    return ((hex >> 16) & 255) + ((hex >> 8) & 255) + (hex & 255)
  }

  it('draws no full circle at rest', () => {
    const s = watching(null)
    for (const axis of [0, 1, 2]) {
      expect(upright(s, axis), 'the premise: all three are up').toBe(true)
      expect(arcOnly(s, axis), `the ${'XYZ'[axis]} ring`).toBe(true)
    }
  })

  it('draws the whole circle of the ring under the cursor, and of no other', () => {
    // THE FULL CIRCLE IS HOVER FEEDBACK, which is what it is for: the knob says
    // where to press and the circle that appears under the cursor says what
    // pressing there will DO — the plane the part is about to turn in, shown
    // before the reader has committed to anything.
    const s = watching((made) => onKnob(made, 2))

    expect(drawnWhole(s, 2)).toBe(true)
    expect(arcOnly(s, 0), 'a neighbour was lit too').toBe(true)
    expect(arcOnly(s, 1), 'a neighbour was lit too').toBe(true)
  })

  it('lightens the knob it is on, and puts it back when the cursor leaves', () => {
    // Fusion's own second half of the same signal, and the one a reader takes
    // in without looking away from the knob they are aiming at. It changes how
    // light the ink is and not WHICH ink it is, because the colour is the thing
    // the knob exists to say.
    const s = scene({ camera: orthoCamera(OBLIQUE) })
    rendered(s.viewer)
    const rest = brightness(s, 2)
    const neighbour = brightness(s, 0)

    hoverAt(s.canvas, onKnob(s, 2))
    rendered(s.viewer)
    expect(brightness(s, 2)).toBeGreaterThan(rest)
    expect(brightness(s, 0), 'a neighbour lightened too').toBe(neighbour)

    // And it goes back when the cursor leaves for the middle of the widget,
    // where the part is and no knob is — still over the canvas, so this is the
    // knob being left rather than the canvas being left.
    hoverAt(s.canvas, canvasAt(s, CENTRE_AT))
    rendered(s.viewer)
    expect(brightness(s, 2)).toBe(rest)
    expect(arcOnly(s, 2), 'and the circle went back to an arc').toBe(true)
  })

  it('keeps the ring it is TURNING lit wherever the pointer has gone', () => {
    // A DRAG OWNS THE LIGHT FOR AS LONG AS IT RUNS. The pointer leaves the knob
    // immediately — turning the part is exactly the act of carrying the hand
    // away from where it pressed — so a widget that lit only what the cursor
    // was over would go back to a faded arc under the hand holding it, which
    // reads as the gesture having ended.
    const s = scene({ camera: orthoCamera(OBLIQUE) })
    rendered(s.viewer)

    press(s.canvas, onKnob(s, 2))
    // Right across the widget and onto another axis's knob.
    pointerMove(onKnob(s, 0))
    rendered(s.viewer)

    expect(drawnWhole(s, 2), 'the ring being turned').toBe(true)
    expect(arcOnly(s, 0), 'the ring the pointer happens to be over').toBe(true)
    pointerUp(onKnob(s, 0))
  })

  it('puts the light out when the gesture ends, wherever the hand is', () => {
    // A DRAG OWNS THE LIGHT WHILE IT RUNS AND GIVES IT BACK THE MOMENT IT DOES
    // NOT, which is not the same thing as the hover coming back: `lit` is
    // written only by a pointer move with NO drag running, so at the release it
    // still names the knob this gesture was taken on — a knob the hand left
    // within a few degrees of turning. On a mouse the next move would correct a
    // ring left standing as a full lit circle; on a touch there is no next move
    // and it would stay drawn until something else repainted.
    const s = scene({ camera: orthoCamera(OBLIQUE) })
    rendered(s.viewer)
    const rest = brightness(s, 2)
    hoverAt(s.canvas, onKnob(s, 2))
    rendered(s.viewer)
    expect(drawnWhole(s, 2), 'the premise: the hover lit it').toBe(true)
    expect(brightness(s, 2)).toBeGreaterThan(rest)
    const away = onRing(s, 2, DISC_T + Math.PI / 2)

    press(s.canvas, onKnob(s, 2))
    pointerMove(away)
    pointerUp(away)
    rendered(s.viewer)

    expect(arcOnly(s, 2)).toBe(true)
    expect(brightness(s, 2), 'and the knob went back to its own ink').toBe(rest)
  })

  it('says nothing about a knob the press would not reach', () => {
    // A LIGHT IS A PROMISE THAT PRESSING HERE TURNS THIS AXIS, and this widget
    // cannot keep that promise by itself: it reads the canvas's press in a
    // window listener, so a press that lands on the toolbar, on a comment pin
    // or on the view cube goes to THOSE and turns nothing. A knob lying under
    // one of them is under the cursor geometrically and is not pressable.
    const s = scene({ camera: orthoCamera(OBLIQUE) })
    rendered(s.viewer)
    const chrome = document.createElement('div')
    document.body.appendChild(chrome)

    // The very point that would light the Z ring, arriving from something else.
    const spot = onKnob(s, 2)
    chrome.dispatchEvent(new MouseEvent('pointermove', {
      clientX: spot[0], clientY: spot[1], bubbles: true,
    }))
    rendered(s.viewer)
    expect(arcOnly(s, 2), 'a knob under other chrome was offered').toBe(true)

    // The premise, and the whole of the difference: the same point, reached
    // over the canvas, is a hover.
    hoverAt(s.canvas, spot)
    rendered(s.viewer)
    expect(drawnWhole(s, 2)).toBe(true)
  })

  it('asks for a frame only when the light actually changes', () => {
    // THE HOVER IS READ OFF A RAY ON EVERY POINTER MOVE, and the library draws
    // on demand — so a light that changed would be invisible until something
    // else happened to repaint, and a light recomputed into a render request
    // would repaint the whole scene, the grid and the orientation marker on
    // every pixel of pointer travel.
    const s = scene({ camera: orthoCamera(OBLIQUE) })
    rendered(s.viewer)
    const knob = onKnob(s, 2)
    s.viewer.update.mockClear()

    hoverAt(s.canvas, [knob[0] + 200, knob[1] + 120])
    expect(s.viewer.update, 'nothing under the cursor, nothing to draw')
      .not.toHaveBeenCalled()

    hoverAt(s.canvas, knob)
    expect(s.viewer.update).toHaveBeenCalledTimes(1)
    hoverAt(s.canvas, [knob[0] + 1, knob[1]])
    expect(s.viewer.update, 'still the same knob').toHaveBeenCalledTimes(1)
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
   *  starting at its knob. */
  const sweep = async (s, axis, radians, centre = CENTRE_AT) => {
    press(s.canvas, onRing(s, axis, DISC_T, centre))
    pointerMove(onRing(s, axis, DISC_T + radians, centre))
    pointerUp(onRing(s, axis, DISC_T + radians, centre))
    await settled()
    // THE LATEST REPORT AND NOT THE FIRST: a second gesture on the same scene
    // is exactly what one of the tests below is about, and the dispatch spy
    // keeps every event the viewport ever raised.
    return details(s.vp, EVENT_TURNED).at(-1).turn
  }

  /** Where a quaternion sends the three world axes, as nine numbers. */
  const sends = (q) => [[1, 0, 0], [0, 1, 0], [0, 0, 1]].flatMap((v) => turned(q, v))

  const expectSends = (q, wanted) => sends(q)
    .forEach((value, k) => expect(value).toBeCloseTo(sends(wanted)[k], 9))

  it('turns about X for the X ring and about Y for the Y ring', async () => {
    // Looking down the diagonal so all three rings are open enough to aim at.
    // A quarter turn swept in the ring's own plane is a quarter turn about that
    // ring's own axis — right-handed, because `u x v` is `+k`.
    for (const [axis, wanted] of [[0, [90, 0, 0]], [1, [0, 90, 0]]]) {
      const s = scene({ camera: orthoCamera(OBLIQUE) })
      rendered(s.viewer)

      const turn = await sweep(s, axis, Math.PI / 2)

      expect(turn, `the ${'XYZ'[axis]} ring`).toEqual(wanted)
      expectSends(facing(s.groups[PART]), quaternionOf(wanted))
    }
  })

  it('turns the same way seen from the far side of the ring`s plane', async () => {
    // THE PROJECTION RUNS A RING SEEN FROM BEHIND ROUND THE SCREEN THE OTHER
    // WAY, and nothing about that reaches the angle: the ring is a circle in a
    // world plane and the angle is taken there. So the same quarter turn about
    // +Z comes out of a hand that went the other way round the SCREEN — which
    // is what a sign hand-picked off screen pixels could not do, and would look
    // every bit as plausible while doing it.
    const behind = { eye: [0, 0, -60], right: [-1, 0, 0], forward: [0, 0, 1] }
    const centre = [0, 0, -45]
    const s = scene({
      camera: orthoCamera(behind),
      // In front of this camera rather than behind it.
      groups: { [PART]: solid(PART, centre) },
    })
    rendered(s.viewer)
    // The premise, and the whole of what "from behind" means here: world +X is
    // drawn to the LEFT and +Y still up, so the ring runs round the screen the
    // opposite way from the one every drag above went.
    const east = onRing(s, 2, 0, centre)
    const north = onRing(s, 2, Math.PI / 2, centre)
    expect(east[0]).toBeLessThan(400)
    expect(north[1]).toBeLessThan(300)

    const turn = await sweep(s, 2, Math.PI / 2, centre)

    expect(turn).toEqual([0, 0, 90])
    expectSends(facing(s.groups[PART]), quaternionOf([0, 0, 90]))
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
    const s = scene({ camera: orthoCamera(OBLIQUE) })
    rendered(s.viewer)

    const first = await sweep(s, 2, Math.PI / 2)
    expect(first, 'the premise: it is standing at a quarter turn about Z')
      .toEqual([0, 0, 90])

    rendered(s.viewer)
    const second = await sweep(s, 0, Math.PI / 6)

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
      facing(s.groups[PART]),
      after(quaternionOf([30, 0, 0]), quaternionOf([0, 0, 90])))
  })

  it('stands on the part`s own centre wherever the part is', () => {
    // A ring is drawn round the part, so the widget's one written field is
    // where it stands — read off the SCENE every frame, exactly as the arrows'
    // anchor is, because a part that was DRAGGED between two presses has moved.
    const s = scene({ groups: { [PART]: solid(PART, [4, -2, 45]) } })
    rendered(s.viewer)

    expect(s.group.position.toArray()).toEqual([4, -2, 45])
  })
})

// -- the two halves of one widget ---------------------------------------------

describe('what puts the widget on the part', () => {
  it('stands on the part beside the arrows, under the one tool', () => {
    // THE MERGE ITSELF, and it is assertable only with both halves up: Fusion's
    // triad is one widget carrying an origin, three arrows, three plane quads
    // and three rotation handles at once, and the reader must not have to put a
    // part down before they may turn it.
    //
    // DOWN THE DIAGONAL, which is the one camera where every piece of both
    // halves is open enough to be drawn — square on, the Z arrow is end-on and
    // two of the three quads are edge-on, so a count taken there would be about
    // the camera rather than about the merge.
    const s = scene({ camera: orthoCamera(OBLIQUE), arrows: true })
    rendered(s.viewer)

    // Seven pieces in the arrows' own group — three arrows, three quads, the
    // dot — and the three rings standing among them rather than instead.
    expect(s.arrowGroup.visible).toBe(true)
    expect(s.arrowGroup.children.filter((node) => node.visible))
      .toHaveLength(7)
    expect([0, 1, 2].map((axis) => upright(s, axis)))
      .toEqual([true, true, true])
  })

  it('shows both halves or neither, over every refusal either one makes', () => {
    // ONE WIDGET AND THEREFORE ONE CONDITION. `held()` in rings.js and `held()`
    // in gizmo.js are the same body character for character, and both files say
    // in prose that they have to be: two halves of one manipulator that came up
    // on different conditions would be a widget with a piece missing — rotation
    // handles round a part the arrows have refused to stand on, or the reverse.
    //
    // WHICH IS A SENTENCE IN A COMMENT UNTIL IT IS A TEST. Every refusal below
    // is already covered in ONE of the two files, separately, so either half
    // could drift — a clause dropped here, a clause added there — and the suite
    // would stay green while the widget came up in pieces.
    const BODY = '/Group/proposal/plate'
    const GROUP = '/Group/proposal'

    const bothOn = (over, tweak) => {
      const s = scene({ camera: orthoCamera(OBLIQUE), arrows: true, ...over })
      if (tweak) tweak(s.vp)
      rendered(s.viewer)
      return [
        s.arrowGroup.visible
          ? s.arrowGroup.children.filter((node) => node.visible).length : 0,
        [0, 1, 2].filter((axis) => upright(s, axis)).length,
      ]
    }

    // `[arrows, rings]` when the widget is whole: three arrows, three plane
    // quads and the origin dot in one group, three rotation handles in the
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
