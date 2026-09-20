// ui/src/viewport/gizmo.js — the move tool's manipulator: an origin dot, three
// axis arrows and three plane quads. Its fourth piece, the rotation handles, is
// rings.js and has its own file beside this one.
//
// There is no GPU here and nothing below looks at a pixel, which is the same
// discipline the rest of this suite keeps — but the widget is a group of MESHES
// in the library's scene now, so what is assertable has moved with it exactly as
// it did for the grip and the rings. Where it stands is a world point rather
// than a projection; which way an arrow points is a rotation taken into the
// world rather than a CSS angle; how long it is drawn is geometry and the camera
// does the foreshortening; how big it is drawn is `scene3d.js`'s one scale, and
// that module's own suite asks about it. Left here are the questions only this
// file can answer: WHAT each of the seven pieces is built out of, WHEN one is
// taken off the screen, WHICH of the six that take a press one lands on, and
// what one whole drag does to the part and says at the end of it.
//
// THE ONE CLAIM THIS FILE EXISTS FOR is that a drag is CONSTRAINED. Under an
// ortho camera a screen gesture carries a world displacement on all three axes
// at once, and each piece puts that displacement back on its own geometry —
// which is the whole of why this widget exists, gizmo.js says, and why the free
// drag it replaced is gone from tools.js. Every drag below therefore travels
// diagonally, and the assertion is about what did NOT move. The origin dot is
// the drawn centre those six are measured from and takes no press at all.
//
// AND THE TWO CONSTRUCTIONS ARE NOT ONE, which is the thing the quad tests are
// really guarding. An arrow takes the NEAREST POINT of its line, because a line
// and the ray through the cursor do not meet in three dimensions. A quad takes
// the point where that ray CUTS its plane, because a plane and a ray do — so
// only the quad can promise that the part follows the pointer, and the
// orthogonal projection that would be the arrow's answer read backwards is a
// DIFFERENT and wrong one for it. Face-on the two agree exactly, so every claim
// about the difference is made on an oblique camera.
//
// A FRAME HERE IS THE LIBRARY DRAWING ONE, `rendered(viewer)` — the fork calls
// `onBeforeRender` at the top of `Viewer.update` and the widget is placed there,
// in the frame that then draws it. Nothing in this file runs a timer, and the
// teardown says so for every test in it.
//
// THE CAMERA IS TWO OBJECTS, exactly as in scene3d.test.js, handle.test.js and
// rings.test.js: this directory's own model of an ortho projection, which every
// point below is worked out against, and a real `THREE.OrthographicCamera` at
// the same pose installed where `getCamera()` answers, because both the press
// and the hover are rays and a ray needs matrices.
//
// The arithmetic is not taken from the module. This fake camera puts 20 px on a
// world unit along both screen axes (400 px per 20 halfW across, 300 px per 15
// halfH up), so `scene3d.js`'s scale is a twentieth of a world unit per pixel
// and every length the module writes in pixels is that many twentieths of a
// world unit. Every camera below is placed so the part lands in the middle of
// an 800x600 canvas, which is what makes a press point something a reader could
// really have aimed at.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'

import { EVENT_MOVED, EVENT_PROPOSALMOVE } from '../src/viewport/events.js'
import { createGizmo } from '../src/viewport/gizmo.js'
import {
  CLICK_PX, GIZMO_CASE_PX, GIZMO_DOT_PX, GIZMO_HEAD_PX, GIZMO_HIT_PX,
  GIZMO_MIN_SCALE, GIZMO_PLANE_GAP_PX, GIZMO_PLANE_PX, GIZMO_PX, GIZMO_RIM_PX,
  GIZMO_SHAFT_PX,
} from '../src/viewport/options.js'
import { GIZMO_ORDER } from '../src/viewport/scene3d.js'
import {
  makeViewport, RECT, framesAsked, rendered, settled, stubFrames,
} from './component.js'
import {
  fakeGroup, fakeShapeSolid, fakeViewer, fakeViewport, orthoCamera, realCamera,
} from './fakes.js'

const PART = '/Group/plate'

/** Where the default fixture's part stands, which is where the widget stands. */
const PART_AT = [0, 0, 45]

/** The three world axes, for the pair that spans each quad's plane. */
const AXIS = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

const unit = (v) => v.map((c) => c / Math.hypot(...v))

/** A camera at a given basis, placed so the part lands mid-canvas.
 *
 * THE EYE IS NOT PART OF ANY ANSWER — under an ortho projection the basis alone
 * decides what a screen displacement spans and how much of an axis survives —
 * but it decides WHERE the widget is drawn, and every press below is aimed at a
 * piece of it. Fifteen world units back is well inside the fixture's far plane.
 */
const looking = (basis) => {
  const forward = unit(basis.forward)
  return orthoCamera({
    ...basis, eye: PART_AT.map((v, i) => v - forward[i] * 15),
  })
}

/** Looking down the diagonal, where EVERY piece of the widget is open enough to
 *  be drawn and to be dragged.
 *
 * Square on — the default camera below — the Z arrow is end-on and two of the
 * three quads are edge-on, which is the right answer and the wrong fixture for
 * anything about a quad. The one quad that survives there is the one whose
 * plane FACES the reader, and that is the single camera where every candidate
 * construction agrees: the hand cannot produce a component along the held axis
 * at all, so no correction of any kind is applied and a drag would pass with
 * the plane arithmetic missing altogether. rings.test.js takes the same basis
 * for the same reason. */
const OBLIQUE = { right: [1, -1, 0], up: [1, 1, -2], forward: [-1, -1, -1] }

const widgets = []

beforeEach(() => {
  vi.clearAllMocks()
  // STUBBED SO THAT NOTHING CAN ASK FOR A FRAME UNSEEN (ui/tests/component.js).
  // This widget drives none: it is placed from inside the library's render
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
  // NOT ONE ANIMATION FRAME. A widget in the scene is placed by the render, so
  // an idle page with the move tool armed asks for nothing at all — and the way
  // a loop creeps back in is somebody re-arming one beside the render, which
  // nothing else here would show.
  expect(framesAsked(), 'the arrows ask for no animation frames').toBe(0)
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

/** A solid whose world centre is `at`, as `partCentre` reads one: a bounding box
 *  computed off the tessellation and an identity `matrixWorld`. */
const solid = (name, at = PART_AT) => fakeShapeSolid(name, {
  positions: [at[0] - 5, at[1] - 5, at[2] - 5, at[0] + 5, at[1] + 5, at[2] + 5],
  index: [0, 1, 2],
})

/**
 * A viewport with the Move tool armed over a movable part, a scene to stand the
 * widget in, and the widget.
 *
 * Built on the real prototype so `activeTool`, `isOverlay` and `overlayBody` are
 * the element's own — a fake that re-implemented them would let this file agree
 * with itself instead of with the code, which is the same reason tools.test.js
 * builds its viewport this way.
 *
 * THE CANVAS IS A REAL NODE, for the reason handle.test.js gives for its own:
 * the press is read in a capture-phase listener on the WINDOW that declines any
 * target but the canvas, so it has to be an event the DOM really dispatched at
 * one. The rect is stubbed on because jsdom computes no layout.
 */
function scene({
  selected = [PART], groups = { [PART]: solid(PART) }, camera, gridSize = 100,
  tool = 'move', overlay = null,
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
    // THE OTHER HALF OF THE WIDGET, as `element.js` hangs it on the element.
    // A press on any piece ends the rotation handles' gesture as well as this
    // one's — one tool means both can be live at once, and two live drags on one
    // part overwrite each other (`onDown`). A stub here because this file is
    // about the arrows; `rings.test.js` runs the real pair against each other.
    rings: { refresh: vi.fn(), endDrag: vi.fn(), destroy: vi.fn() },
    // AND THE DOOR ONTO THE CANVAS GESTURE, which `installTools` publishes on the
    // element. A press this widget KEEPS ends that too, because the refusal
    // `scene3d.js` makes on our answer is what stops tools.js's own `onDown`
    // from ever seeing the press and finishing it.
    endGesture: vi.fn(),
  })
  const gizmo = createGizmo(vp)
  widgets.push(gizmo)
  vp.gizmo = gizmo
  // What `show()` does on the far side of `render()`: the group joins the scene
  // the library has just built, the namespace comes with it, and the widget asks
  // for the frame that then places it.
  gizmo.attach(THREE)
  const group = viewer.scene.children.find((child) => child.isGroup)
  return { model, viewer, vp, groups, canvas, gizmo, group }
}

/** The whole widget, and one piece of it.
 *
 * SEVEN NODES IN THE ORDER THE MODULE BUILDS THEM: the three arrows, then the
 * three quads, then the origin dot.
 *
 * A QUAD IS NAMED FOR THE PLANE IT LIES IN and the module indexes it by the axis
 * it is NORMAL to, which are the two ways of saying the same thing: the quad at
 * index 0 holds X still and lies in YZ. */
const shown = (s) => s.group.visible
const armOf = (s, axis) => s.group.children[axis]
const quadOf = (s, axis) => s.group.children[3 + axis]
const dotOf = (s) => s.group.children[6]
const upright = (s, node) => s.group.visible && node.visible

/** The one mesh of a piece that answers a ray: built last, and never drawn. */
const hitOf = (node) => node.children.at(-1)

/** One band of a piece, OUTERMOST FIRST — the dark rim, the white casing and
 *  the ink, which is the order `BANDS` in gizmo.js lists them in and the order
 *  they are painted in. An arrow carries two meshes per band, a shaft and a
 *  head; a quad and the dot carry one. */
const BAND = { rim: 0, casing: 1, ink: 2 }
const band = (node, which) => node.children[BAND[which]]
const armBand = (node, which, part) =>
  node.children[2 * BAND[which] + (part === 'head' ? 1 : 0)]

/** The extent of what is DRAWN in one band, in the piece's own units — which
 *  are CSS pixels. In the piece's own frame and not in the world, so the answer
 *  is the widget's own size rather than the size the camera leaves of it. */
function boxOf(meshes) {
  const box = new THREE.Box3()
  for (const mesh of meshes) {
    mesh.updateMatrix()
    mesh.geometry.computeBoundingBox()
    box.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrix))
  }
  return box
}

const armBox = (node, which) =>
  boxOf([armBand(node, which, 'shaft'), armBand(node, which, 'head')])

/** World units per CSS pixel under one camera, which is the scale `scene3d.js`
 *  gives the group. Worked out here rather than read back off it. */
const perPx = (model) => (2 * model.halfH) / model.zoom / RECT.height

/** A world point on the canvas, in pixels — the projection this directory
 *  models, with `spot`'s own arithmetic for the two rects, which are equal. */
function canvasAt(s, point) {
  const [nx, ny] = s.model.project(point)
  return [(nx * 0.5 + 0.5) * RECT.width, (-ny * 0.5 + 0.5) * RECT.height]
}

/** A point of the widget's own geometry — offsets along the three WORLD axes,
 *  in the group's pixel units — put on the canvas. */
const at = (s, offsets, centre = PART_AT) => canvasAt(
  s, centre.map((c, i) => c + offsets[i] * perPx(s.model)))

/** The widget's own centre on the canvas: the middle of it. */
const MIDDLE = [400, 300]

/** A point ON one arrow, `along` pixels out from the part's centre. Halfway is
 *  the middle of the shaft, well past the dot's rim and well short of the tip. */
const onArrow = (s, axis, along = GIZMO_PX / 2) =>
  at(s, AXIS[axis].map((v) => v * along))

/** A point ON one quad, at a fraction of its side along each of the two axes
 *  that span it.
 *
 * THREE QUARTERS AND A QUARTER, DELIBERATELY OFF THE MIDDLE. A `PlaneGeometry`
 * is two triangles sharing a diagonal, and that diagonal runs exactly through
 * the square's own centre — a ray aimed there lands on the shared edge of both,
 * which `intersectTriangle` may refuse for either. This point is inside one
 * triangle under any camera.
 */
const onQuad = (s, axis, u = 0.75, v = 0.25) => {
  const offsets = [0, 0, 0]
  offsets[(axis + 1) % 3] = GIZMO_PLANE_GAP_PX + GIZMO_PLANE_PX * u
  offsets[(axis + 2) % 3] = GIZMO_PLANE_GAP_PX + GIZMO_PLANE_PX * v
  return at(s, offsets)
}

/** A point ON the dot but OFF its exact centre.
 *
 * THE SAME TRAP ONE SHAPE OVER: a `CircleGeometry` is a fan and its centre is
 * the shared apex of all twenty-four triangles, so a ray aimed exactly there
 * can be refused by every one of them — which reads as "the widget declined the
 * press" and would pass a test of that whatever the code did. Three and two
 * pixels out is well inside a 12 px disc and inside ONE triangle.
 */
const onDot = (s) => {
  const [x, y] = canvasAt(s, PART_AT)
  return [x + 3, y + 2]
}

/** A press on the canvas, with both refusals watched.
 *
 * `stopImmediatePropagation` AND NOT `stopPropagation`, which is the one thing
 * about the press that changed with the move: `scene3d.js` makes the refusal
 * for every widget standing in the scene, and it makes the immediate one
 * because the grip and the rings read their presses off this very node too.
 */
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
 *  own listeners are — a drag that starts on an arrow can end anywhere. */
const pointerMove = ([clientX, clientY]) =>
  window.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY }))
const pointerUp = ([clientX, clientY]) =>
  window.dispatchEvent(new MouseEvent('pointerup', { clientX, clientY }))
const pointerCancel = () =>
  window.dispatchEvent(new MouseEvent('pointercancel', {}))

/** The cursor standing over the CANVAS at a point, which is what a hover is. */
const hoverAt = (canvas, [clientX, clientY]) =>
  canvas.dispatchEvent(new MouseEvent('pointermove', {
    clientX, clientY, bubbles: true,
  }))

/** Everything under a canvas point, nearest first — a ray of the test's own.
 *
 * FOR THE PREMISES AND NOT FOR THE ANSWERS: which meshes a ray really crosses
 * is what makes "the press went to this one and not that one" a claim about
 * priority rather than about geometry that happened not to overlap. Placed
 * first, because a group nothing has drawn has no world matrix and the ray
 * would be cast against the origin.
 */
const rayAt = (s, [x, y], root = s.group) => {
  rendered(s.viewer)
  s.group.updateMatrixWorld(true)
  const caster = new THREE.Raycaster()
  caster.setFromCamera(new THREE.Vector2(
    (x / RECT.width) * 2 - 1, 1 - (y / RECT.height) * 2), s.model.cam)
  return caster.intersectObject(root, true)
}

/** What was carried by every event of one name, in the order they went out. */
const details = (vp, type) => vp.dispatchEvent.mock.calls
  .map(([event]) => event)
  .filter((event) => event.type === type)
  .map((event) => event.detail)

/** Where a group ended up, as three numbers. */
const stands = (group) => [group.position.x, group.position.y, group.position.z]

/**
 * A DIAGONAL drag: 200 px right and 60 px down from wherever the press landed.
 *
 * In world terms that is +10 along X and -3 along Y under the square-on camera
 * (20 px to the world unit on both screen axes), so the unconstrained
 * displacement is `[10, -3, 0]` and each arrow has to produce one component of
 * it and nothing else. A drag that went straight along one screen axis would
 * pass with no projection in the module at all.
 *
 * FROM THE PRESS AND NOT FROM A FIXED POINT, which is the whole of what changed
 * when the press moved onto the canvas: every gesture here is measured as a
 * DIFFERENCE of two ndc readings, so the numbers below are the numbers the DOM
 * layer produced as long as the hand travels the same distance.
 */
const DRAG = [200, 60]
const dragged = (from) => [from[0] + DRAG[0], from[1] + DRAG[1]]
const dragFrom = (from) => pointerMove(dragged(from))

/**
 * That same drag as a WORLD displacement under the oblique camera, rebuilt from
 * the basis this file declares rather than read back off the module: 10 world
 * units along `right` and -3 along `up`, at the 20 px to the world unit the
 * fixture's camera gives.
 *
 * The square-on camera's `[10, -3, 0]` has a zero in it, and the whole point of
 * taking it obliquely is that this one has all three components — so a quad
 * that failed to hold its normal axis would show.
 */
const RIGHT = unit(OBLIQUE.right)
const UP = unit(OBLIQUE.up)
/** The direction every pixel of this ortho canvas looks along. The module takes
 *  it from `cameraBasis().view`, which points from the eye at the target; which
 *  end of the axis it names makes no difference to anything below, because it
 *  enters the plane construction once above the line and once below it. */
const VIEW = unit(OBLIQUE.forward)
/** The scalar product, spelled out here so nothing below borrows the
 *  module's. `scalar` and not `dot`, which is taken: the origin dot is one of
 *  the seven pieces, and two different things under one name in one file is how
 *  the wrong one gets read. */
const scalar = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0)
const OBLIQUE_WORLD = RIGHT.map((v, i) => v * 10 + UP[i] * -3)

/** Where a world displacement lands ON THE SCREEN, in px — rebuilt from the
 *  basis the test declares rather than read back off the module. 20 px to the
 *  world unit on both screen axes (400 px per 20 halfW, 300 px per 15 halfH),
 *  whatever the basis, and screen y runs DOWN. */
const onScreen = (v, right = RIGHT, up = UP) =>
  [20 * scalar(v, right), -20 * scalar(v, up)]

/**
 * A camera that sees the XY quad — the plane normal to Z — at exactly `face` of
 * itself, which is the quantity `place` floors a quad on and the quantity
 * `acrossPlane` divides by.
 *
 * `|view . z|` IS `face` BY CONSTRUCTION: the view axis is tilted out of the XY
 * plane by that cosine and the screen basis is completed round it. WHICH ALSO
 * FIXES THE Z ARROW, at the complementary `sqrt(1 - face^2)` — the two are the
 * two readings of one angle, so this one camera family reaches both floors.
 */
const facingZ = (face) => {
  const side = Math.sqrt(1 - face * face)
  return looking({
    forward: [0, -side, -face], right: [1, 0, 0], up: [0, face, -side],
  })
}

/** ...and the same family named by what it leaves of the Z ARROW. */
const alongZ = (sine) => facingZ(Math.sqrt(1 - sine * sine))

/**
 * The displacement a QUAD drag should produce: the point where the ray through
 * the moved cursor cuts the plane through the point the drag started from,
 * `w - view (w.n)/(view.n)`.
 *
 * WRITTEN OUT HERE AND NOT IMPORTED, which is the whole value of it: the module
 * has its own copy and this is the independent statement of what that copy is
 * supposed to compute.
 */
const intoPlane = (normal) => OBLIQUE_WORLD.map((v, i) =>
  v - VIEW[i] * (scalar(OBLIQUE_WORLD, normal) / scalar(VIEW, normal)))

/** What the ORTHOGONAL projection would have produced instead — the nearest
 *  point of the plane rather than the one under the cursor. Kept so the tests
 *  below can show the gap rather than assert it by absence. */
const ontoPlane = (normal) => OBLIQUE_WORLD.map((v, i) =>
  v - normal[i] * scalar(OBLIQUE_WORLD, normal))

/** What `snap` lands on at the fixture's default grid of 100. */
const STEP = 0.5
const round = (v) => Math.round(v / STEP) * STEP

/** The snapped delta a quad drag lands on, with the held axis left at zero. */
const heldAt = (normal) => intoPlane(normal)
  .map((v, i) => (normal[i] ? 0 : round(v)))

describe('when there is nothing to put the widget on', () => {
  it('draws nothing while no tool is armed', () => {
    // The arrows are the MOVE TOOL's, and a widget offering a drag the press
    // would not take is a promise the page cannot keep.
    const s = scene()
    rendered(s.viewer)
    expect(shown(s), 'the premise: it is on screen with Move armed').toBe(true)

    s.vp.state = { ...s.vp.state, tool: null }
    rendered(s.viewer)
    expect(shown(s)).toBe(false)
  })

  it('draws nothing for the retired tool value', () => {
    // `turn` WAS A TOOL AND IS NOT ONE ANY MORE. It armed the rotation handles
    // alone, so the reader had to swap tools between the two halves of one
    // widget; both halves answer to `move` now. Nothing must be left answering
    // to the old value — a widget that came up under a name the interface no
    // longer writes would be unreachable and invisible in one move.
    const s = scene({ tool: 'turn' })
    rendered(s.viewer)
    expect(shown(s)).toBe(false)
  })

  it('draws nothing while the hold key has the cut up', () => {
    // `activeTool` AND NOT `state.tool`: the hold key puts the cut up without
    // writing to `state`, so arrows read off the state field would stand there
    // offering a move while the very next press placed a section plane.
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
    // THE SAME GRABBABLE TEST `onDown` APPLIES, asked of EVERY path: one gesture
    // moves the whole row, and `movePart` refuses a row it cannot move whole. So
    // arrows over a selection carrying one path the scene has lost would
    // advertise a drag that then silently does nothing.
    const s = scene({ selected: [PART, '/Group/gone'] })
    rendered(s.viewer)
    expect(shown(s)).toBe(false)
  })

  it('draws nothing on a part whose centre the scene cannot give', () => {
    // A node of the tree carries no tessellation, so it has no box and no
    // centre (`partCentre`) — there is no point to stand the widget on. `place`
    // ANSWERS rather than hiding, which is `scene3d.js`'s contract, and the flag
    // on the shared group is what comes off.
    const s = scene({ groups: { [PART]: fakeGroup() } })
    rendered(s.viewer)
    expect(shown(s)).toBe(false)
  })

  it('takes no gesture from a piece the next frame would remove', () => {
    // Both halves of the module have to agree about what is grabbable — three's
    // raycaster tests an object's LAYERS and never its visibility, so without
    // the question being asked again at the press a piece the last frame took
    // off the screen would go on answering at wherever it was last drawn.
    const s = scene()
    rendered(s.viewer)
    const spot = onArrow(s, 0)
    s.vp.state = { ...s.vp.state, selected: [] }
    rendered(s.viewer)

    const event = press(s.canvas, spot)
    dragFrom(spot)

    expect(s.vp.moved.size).toBe(0)
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
  })
})

describe('what the one tool puts on the part', () => {
  it('puts every piece of the widget up under the one tool', () => {
    // FUSION'S TRIAD IS ONE COMMAND — an origin, three arrows, three plane
    // quads and three rotation handles at once — and this is the half of it
    // that lives here. The handles are the other half and stand up under the
    // same tool; rings.test.js pins the two widgets together.
    //
    // DOWN THE DIAGONAL, because square on the count would be about the camera:
    // the Z arrow is end-on and two quads are edge-on there, correctly.
    const s = scene({ camera: looking(OBLIQUE) })
    rendered(s.viewer)

    expect(s.group.children).toHaveLength(7)
    expect(s.group.children.filter((node) => node.visible)).toHaveLength(7)
  })

  it('stands on the part`s own centre, wherever the part is', () => {
    // READ OFF THE SCENE EVERY FRAME AND NOT OUT OF THE MOVE RECORD, which is
    // the whole of whether this is a widget the reader is holding or a picture
    // beside one: the record's `base` is where a drag STARTED, and a widget
    // anchored on it would stand still while the part slid out from under it.
    const s = scene({ groups: { [PART]: solid(PART, [4, -2, 45]) } })
    rendered(s.viewer)

    expect(stands(s.group)).toEqual([4, -2, 45])
  })
})

describe('what an arrow is built out of', () => {
  it('points along its own world axis, out of the part`s centre', () => {
    // three builds a cylinder and a cone along +Y, so the whole arrow is
    // oriented by one rotation from that axis onto the world axis it is named
    // for — which is what makes it point along the axis rather than along a
    // picture of one. Asked on an oblique camera, where no two of the three
    // could be confused for a screen direction.
    const s = scene({ camera: looking(OBLIQUE) })
    rendered(s.viewer)

    for (const axis of [0, 1, 2]) {
      const out = new THREE.Vector3(0, 1, 0)
        .applyQuaternion(armOf(s, axis).quaternion).toArray()
      out.forEach((value, k) => expect(value, `${'XYZ'[axis]}`)
        .toBeCloseTo(AXIS[axis][k], 9))
    }
  })

  it('is `GIZMO_PX` long, measured in pixels, with the head at the tip', () => {
    // The group's own units are CSS pixels — `scene3d.js` scales it so — which
    // is what keeps the widget the same size on a 2 mm part and a 200 mm one.
    // ONE HEAD AND NOT TWO, at the far end: the arrow points AWAY from the part
    // along the direction its axis is named for, and the drag goes both ways.
    const s = scene()
    const box = armBox(armOf(s, 0), 'ink')
    expect(box.min.y).toBeCloseTo(0, 9)
    expect(box.max.y).toBeCloseTo(GIZMO_PX, 9)
    // Its widest point is the head's base, and the shaft is the thin one.
    expect(box.max.x).toBeCloseTo(GIZMO_HEAD_PX / 2, 9)
    const shaft = armBand(armOf(s, 0), 'ink', 'shaft')
    expect(2 * shaft.geometry.parameters.radiusTop)
      .toBeCloseTo(GIZMO_SHAFT_PX, 9)
    const head = armBand(armOf(s, 0), 'ink', 'head')
    expect(head.geometry.parameters.height).toBeCloseTo(GIZMO_HEAD_PX, 9)
    expect(2 * head.geometry.parameters.radius).toBeCloseTo(GIZMO_HEAD_PX, 9)
  })

  it('stands the ink on a white casing inside a dark rim, drawn under it', () => {
    // THE CONSTRUCTION AND NOT A PALETTE (options.js, `GIZMO_CASE_PX`). The
    // arrows used to bring their own contrast as a CSS `filter` halo, which is
    // a picture over a box and there is no box any more — so they take the
    // geometry every other piece of this widget and of the rings already takes:
    // a light casing inside a dark rim, legible on a red part and on either
    // canvas.
    //
    // UNDER IT, not merely present: with no depth test the renderer's order IS
    // the stacking, so a casing that sorted after the ink would paint the arrow
    // out entirely.
    const s = scene()
    const arm = armOf(s, 0)
    const wide = (which) => armBox(arm, which).max.x
    expect(wide('ink')).toBeCloseTo(GIZMO_HEAD_PX / 2, 9)
    expect(wide('casing')).toBeCloseTo(GIZMO_HEAD_PX / 2 + GIZMO_CASE_PX, 9)
    expect(wide('rim'))
      .toBeCloseTo(GIZMO_HEAD_PX / 2 + GIZMO_CASE_PX + GIZMO_RIM_PX, 9)
    // And the tip goes with it, exactly as the rotation handles' rim stands
    // outside `RING_PX`: the casing is proud of the ink at the point as well.
    expect(armBox(arm, 'casing').max.y).toBeCloseTo(GIZMO_PX + GIZMO_CASE_PX, 9)

    const order = (which) => armBand(arm, which, 'shaft').renderOrder
    expect(order('rim')).toBeLessThan(order('casing'))
    expect(order('casing')).toBeLessThan(order('ink'))
    // The two construction inks are one pair for the whole widget: the quads
    // and the dot are the same three colours the other way round, filled shapes
    // sharing an OUTER edge rather than bodies about a line.
    const paint = (node, which) => (node === armOf(s, 0)
      ? armBand(node, which, 'shaft') : band(node, which)).material.color.getHex()
    for (const which of ['rim', 'casing']) {
      expect(paint(quadOf(s, 2), which)).toBe(paint(armOf(s, 0), which))
      expect(paint(dotOf(s), which)).toBe(paint(armOf(s, 0), which))
    }
  })

  it('takes its press over a fat cylinder that starts at the dot`s rim', () => {
    // THE TARGET IS FAT AND THE INK IS THIN, which is the requirement the DOM
    // box carried and the reason `GIZMO_HIT_PX` survives the move: a hand
    // cannot reliably hit a 2 px shaft.
    //
    // AND IT STARTS AT `GIZMO_DOT_PX / 2` OUT, which is what leaves the middle
    // of the widget answering no ray at all: the dot is drawn there and takes
    // no press, and three hit cylinders crossing under it would make the one
    // place the reader cannot tell the axes apart the easiest place to grab one
    // of them by accident.
    const s = scene()
    const hit = hitOf(armOf(s, 0))
    expect(hit.visible, 'hit and never drawn').toBe(false)
    expect(hit.geometry.type).toBe('CylinderGeometry')
    expect(2 * hit.geometry.parameters.radiusTop).toBeCloseTo(GIZMO_HIT_PX, 9)
    const box = boxOf([hit])
    expect(box.min.y).toBeCloseTo(GIZMO_DOT_PX / 2, 9)
    expect(box.max.y).toBeCloseTo(GIZMO_PX, 9)
    // AND NOTHING ELSE OF THE ARROW ANSWERS A RAY, which in this representation
    // has to be said to the raycaster rather than assumed: every band is a mesh
    // standing in front of its neighbours, and three tests an object's LAYERS
    // and never its visibility.
    const found = rayAt(s, onArrow(s, 0), armOf(s, 0))
    expect(found.length, 'the premise: the ray does cross the arrow')
      .toBeGreaterThan(0)
    for (const one of found) expect(one.object).toBe(hit)
  })
})

describe('which arrows are drawn at all', () => {
  it('takes the axis the reader is looking down off the screen entirely', () => {
    // THE DECISION THIS WIDGET DIFFERS FROM THE SECTION GRIP ON. The grip
    // collapses to a disc and STILL DRAGS, because the fallback it drags on is
    // a different axis. An axis arrow has no fallback: the world displacement a
    // screen gesture spans lies in the plane of the screen, so an axis pointing
    // at the reader takes almost nothing from it however far the hand goes, and
    // `alongAxis` divides by that fraction SQUARED.
    const s = scene()
    rendered(s.viewer)

    expect(upright(s, armOf(s, 0)), 'the premise: the other two are up')
      .toBe(true)
    expect(upright(s, armOf(s, 1))).toBe(true)
    expect(upright(s, armOf(s, 2))).toBe(false)
  })

  it('draws all three on an oblique camera', () => {
    // Looking down the diagonal: each axis sits at the same angle to the
    // camera's projection axis, so all three keep `sqrt(2/3)` of themselves —
    // well clear of the floor, so what is pinned is that three arrows really
    // can stand at once rather than the threshold.
    const s = scene({ camera: looking(OBLIQUE) })
    rendered(s.viewer)

    expect([0, 1, 2].map((axis) => upright(s, armOf(s, axis))))
      .toEqual([true, true, true])
    expect(Math.sqrt(2 / 3)).toBeGreaterThan(GIZMO_MIN_SCALE)
  })

  it('floors on the fraction of the axis the projection leaves', () => {
    // WHICH IS ONE COMPONENT OF `cameraBasis().view` AND NOTHING ELSE, now that
    // the camera does the projection: `sine` is `sqrt(1 - view[k]^2)`, the
    // angle between the axis and the direction every pixel of an ortho canvas
    // looks along. Pinned at the floor itself, a hundredth either side, because
    // the number is what `alongAxis` divides the square of.
    const above = scene({ camera: alongZ(GIZMO_MIN_SCALE + 0.01) })
    rendered(above.viewer)
    expect(upright(above, armOf(above, 2))).toBe(true)

    const below = scene({ camera: alongZ(GIZMO_MIN_SCALE - 0.01) })
    rendered(below.viewer)
    expect(upright(below, armOf(below, 2))).toBe(false)
  })
})

describe('where the quads are drawn', () => {
  it('lies in the world plane its own axis is normal to', () => {
    // A QUAD IS A SQUARE IN ITS PLANE and not a picture of one, which is what
    // the move bought here: three builds a plane in its own XY, so putting
    // local +X on `u`, local +Y on `v` and local +Z on the axis the quad holds
    // still is what makes it lie ON the model and foreshorten with the two
    // arrows that span it.
    const s = scene({ camera: looking(OBLIQUE) })
    rendered(s.viewer)

    for (const axis of [0, 1, 2]) {
      const q = quadOf(s, axis).quaternion
      const sent = (v) => new THREE.Vector3(...v).applyQuaternion(q).toArray()
      const near = (got, want) => got.forEach(
        (value, k) => expect(value, `${'XYZ'[axis]} -> ${want}`)
          .toBeCloseTo(want[k], 9))
      near(sent([1, 0, 0]), AXIS[(axis + 1) % 3])
      near(sent([0, 1, 0]), AXIS[(axis + 2) % 3])
      near(sent([0, 0, 1]), AXIS[axis])
    }
  })

  it('stands its near corner off the centre along both spanning axes', () => {
    // WHICH IS WHAT KEEPS IT CLEAR OF THE BLOT where the three shafts cross,
    // and inside the arrowheads at its far corner — measured off the geometry
    // in the group's own pixel units rather than off a number written beside
    // it.
    const s = scene()
    const quad = quadOf(s, 2)
    const box = boxOf([band(quad, 'rim')])
        .applyMatrix4(new THREE.Matrix4().compose(
          quad.position, quad.quaternion, quad.scale))
    expect(box.min.x).toBeCloseTo(GIZMO_PLANE_GAP_PX, 9)
    expect(box.min.y).toBeCloseTo(GIZMO_PLANE_GAP_PX, 9)
    expect(box.max.x).toBeCloseTo(GIZMO_PLANE_GAP_PX + GIZMO_PLANE_PX, 9)
    expect(box.max.y).toBeCloseTo(GIZMO_PLANE_GAP_PX + GIZMO_PLANE_PX, 9)
    // Flat: the quad has no thickness in the axis it holds still.
    expect(box.max.z).toBeCloseTo(0, 9)
    // AND WELL INSIDE THE ARROWHEADS, which is the other half of the placement.
    expect(GIZMO_PLANE_GAP_PX + GIZMO_PLANE_PX).toBeLessThan(GIZMO_PX)
  })

  it('stands its ink on a casing inside a rim, and takes the press whole', () => {
    // THE RINGS' CONSTRUCTION AGAIN, as three squares sharing a centre rather
    // than three bodies about a line — a filled shape grows inwards. The target
    // is the quad's OWN size, which is the dividend of a filled target: there
    // is no tolerance left to invent, because what the ray meets is exactly
    // what is drawn.
    const s = scene()
    const quad = quadOf(s, 2)
    const side = (which) => band(quad, which).geometry.parameters.width
    expect(side('rim')).toBeCloseTo(GIZMO_PLANE_PX, 9)
    expect(side('casing')).toBeCloseTo(GIZMO_PLANE_PX - 2 * GIZMO_RIM_PX, 9)
    expect(side('ink'))
      .toBeCloseTo(GIZMO_PLANE_PX - 2 * (GIZMO_RIM_PX + GIZMO_CASE_PX), 9)
    const order = (which) => band(quad, which).renderOrder
    expect(order('rim')).toBeLessThan(order('casing'))
    expect(order('casing')).toBeLessThan(order('ink'))
    // SEEN FROM EITHER SIDE, because a world plane is: the reader orbits past
    // it and a single-sided square would simply vanish halfway round.
    for (const which of ['rim', 'casing', 'ink']) {
      expect(band(quad, which).material.side, which).toBe(THREE.DoubleSide)
    }
    const hit = hitOf(quad)
    expect(hit.visible).toBe(false)
    expect(hit.geometry.parameters.width).toBeCloseTo(GIZMO_PLANE_PX, 9)
  })

  it('takes a plane seen edge-on off the screen entirely', () => {
    // THE ARROWS' OWN FLOOR, asked about the complementary quantity, and the
    // two answers are complementary too: looking straight down Z, the Z arrow
    // is gone and the XY quad is at its widest, while the two quads whose
    // planes contain Z are edge-on and go.
    const s = scene()
    rendered(s.viewer)

    expect(upright(s, armOf(s, 2)), 'the premise: Z is the end-on axis')
      .toBe(false)
    expect(upright(s, quadOf(s, 2)), 'and its own plane faces the reader')
      .toBe(true)
    expect([0, 1].map((axis) => upright(s, quadOf(s, axis))))
      .toEqual([false, false])
  })

  it('draws all three on an oblique camera', () => {
    // A third of the way round from every axis: each plane keeps `1/sqrt(3)` of
    // itself, which is clear of the floor — so what is pinned is that three
    // quads really can stand at once rather than the threshold.
    const s = scene({ camera: looking(OBLIQUE) })
    rendered(s.viewer)

    expect([0, 1, 2].map((axis) => upright(s, quadOf(s, axis))))
      .toEqual([true, true, true])
    expect(1 / Math.sqrt(3)).toBeGreaterThan(GIZMO_MIN_SCALE)
  })
})

describe('where the dot is drawn', () => {
  it('is turned to face the reader, whatever the camera is doing', () => {
    // THE ONE PIECE WITH NO AXIS IN IT: it marks the origin the other six are
    // measured from, so there is nothing about the camera for it to
    // foreshorten to. A flat disc standing in the world would collapse to a
    // line on some camera; this one carries the camera's own orientation, so
    // it is a circle on every one.
    for (const camera of [orthoCamera(), looking(OBLIQUE), facingZ(0.3)]) {
      const s = scene({ camera })
      rendered(s.viewer)
      const node = dotOf(s)
      const out = new THREE.Vector3(0, 0, 1)
        .applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion()))
        .toArray()
      // Its own normal, taken into the world, is the direction the camera looks
      // BACK along — which is what "square to the screen" means.
      out.forEach((value, k) =>
        expect(value).toBeCloseTo(-unit(camera.forward)[k], 9))
      // And it stands at the widget's own centre, with no offset of its own.
      expect(node.position.toArray()).toEqual([0, 0, 0])
    }
  })

  it('is three circles of `GIZMO_DOT_PX`, drawn over the arrows` tails', () => {
    // The same casing and rim as everything else, as concentric discs sharing
    // an OUTER edge — and ABOVE the arrows in the paint order, because the
    // three shafts run underneath it and this is the piece that covers the
    // blot they make where they meet.
    const s = scene()
    const node = dotOf(s)
    const radius = (which) => band(node, which).geometry.parameters.radius
    expect(band(node, 'rim').geometry.type).toBe('CircleGeometry')
    expect(radius('rim')).toBeCloseTo(GIZMO_DOT_PX / 2, 9)
    expect(radius('casing')).toBeCloseTo(GIZMO_DOT_PX / 2 - GIZMO_RIM_PX, 9)
    expect(radius('ink'))
      .toBeCloseTo(GIZMO_DOT_PX / 2 - GIZMO_RIM_PX - GIZMO_CASE_PX, 9)
    // THE BANDS AND NOTHING ELSE: every other piece carries ONE MORE mesh,
    // built last, that answers the ray — a fourth on a quad, a seventh on an
    // arrow, which is why `hitOf` takes the last child rather than an index —
    // and this one has none at all. See 'takes no press and offers no cursor on
    // the origin dot' for what that buys.
    expect(node.children).toHaveLength(3)

    const lowest = Math.min(...['rim', 'casing', 'ink']
      .map((which) => band(node, which).renderOrder))
    const highest = Math.max(...[0, 1, 2].flatMap((axis) =>
      ['rim', 'casing', 'ink'].map(
        (which) => armBand(armOf(s, axis), which, 'shaft').renderOrder)))
    expect(lowest).toBeGreaterThan(highest)
  })

  it('is cut by nothing and swallowed by nothing, like every other piece', () => {
    // A material carrying clip planes is cut by the very section the reader may
    // have standing, and one that consults the depth buffer is swallowed by the
    // part it is a handle for — the grip stands ON a cut face, and these stand
    // ON the part they move. `scene3d.js` carries the argument; this is the
    // claim asked of all seven pieces at once.
    const s = scene()
    for (const node of s.group.children) {
      for (const mesh of node.children) {
        expect(mesh.material.clippingPlanes).toEqual([])
        expect(mesh.material.depthTest).toBe(false)
        expect(mesh.material.depthWrite).toBe(false)
      }
    }
  })

  it('stands in the topmost band, in the one list all three widgets share', () => {
    // TWO HALVES OF ONE ANSWER. The band is where this widget is drawn among
    // the three standing in this scene, and it is the TOPMOST because
    // `element.js` builds this one FIRST and the earliest-built keeps a
    // contested press — what the reader presses has to be what they can see.
    // A quad and a knob really do cross, so the pair that matters is this band
    // against the rings'.
    //
    // AND `transparent` IS WHAT MAKES THE BAND MEAN ANYTHING: three sorts into
    // its opaque and its transparent lists by that flag before it looks at any
    // order, so an opaque manipulator beside the blended rings is drawn FIRST
    // whatever number it carries — which is exactly how the rings came to cover
    // it.
    const s = scene()
    expect(s.group.renderOrder).toBe(GIZMO_ORDER)
    for (const node of s.group.children) {
      for (const mesh of node.children) {
        expect(mesh.material.transparent, mesh.geometry.type).toBe(true)
      }
    }
  })
})

describe('what takes the press', () => {
  it('leaves a press that missed every piece completely alone', () => {
    // THE WHOLE PURCHASE OF READING THE PRESS OFF THE CANVAS: a press that
    // misses is not ours, so it goes on to the tools' own listener and to the
    // trackball behind it, and the reader can still orbit, pick and open the
    // part menu with the tool armed. That is what the DOM layer bought with
    // `pointer-events: none` on its root, said the way a widget in the scene
    // has to say it.
    const s = scene()
    rendered(s.viewer)

    const event = press(s.canvas, [MIDDLE[0] + 150, MIDDLE[1] + 150])
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()

    pointerMove([MIDDLE[0] + 350, MIDDLE[1] + 210])
    expect(stands(s.groups[PART])).toEqual([0, 0, 0])
    expect(s.vp.moved.size).toBe(0)
    // AND THE CANVAS GESTURE IS LEFT WHERE IT IS. `endGesture` CONCLUDES, and
    // concluding a cut means `reportCut`, which the interface answers by
    // disarming the armed tool — so a press this widget declines must not make
    // that call. tools.js's own listener sees every press aimed at the canvas
    // and finishes its own — which is not the same thing, and is why declining
    // costs nothing here.
    expect(s.vp.endGesture).not.toHaveBeenCalled()
  })

  it('takes a press that landed on an arrow, from the trackball with it', () => {
    const s = scene()
    rendered(s.viewer)

    const event = press(s.canvas, onArrow(s, 0))
    expect(event.stopImmediatePropagation).toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('offers a grab cursor over a piece and takes it back off one', () => {
    // The DOM layer got this from the browser for nothing — a div with
    // `cursor: grab` on it, hit-tested by the engine. A widget in the scene is
    // not an element, so `scene3d.js` casts a ray and writes the canvas by
    // hand, and the floor below has to hold for that ray as well as for ours.
    const s = scene()
    rendered(s.viewer)

    hoverAt(s.canvas, onArrow(s, 0))
    expect(s.canvas.style.cursor).toBe('grab')
    hoverAt(s.canvas, [MIDDLE[0] + 150, MIDDLE[1] + 150])
    expect(s.canvas.style.cursor).toBe('')
  })

  it('takes no press and offers no cursor on an arrow the floor has removed', () => {
    // THE TWO HALVES HAVE TO AGREE AND CANNOT BE MADE TO BY CONSTRUCTION:
    // three's raycaster reads an object's LAYERS and never its visibility, so
    // an arrow taken off the screen is still a 14 px cylinder standing nearly
    // end-on in the scene. The CURSOR is the half that is easy to lose, because
    // it is cast by `scene3d.js`, which knows nothing of this widget's own
    // floor — and a canvas wearing `grab` over an arrow nobody can see is a
    // promise the press then refuses.
    const open = scene({ camera: alongZ(GIZMO_MIN_SCALE + 0.05) })
    rendered(open.viewer)
    expect(upright(open, armOf(open, 2)), 'the premise: over the floor it is up')
      .toBe(true)
    hoverAt(open.canvas, onArrow(open, 2, 60))
    expect(open.canvas.style.cursor, 'the premise: the ray does land here')
      .toBe('grab')

    // The same cylinder at nearly the same angle, the other side of the floor.
    const s = scene({ camera: alongZ(GIZMO_MIN_SCALE - 0.05) })
    rendered(s.viewer)
    expect(upright(s, armOf(s, 2)), 'the premise: the Z arrow is gone')
      .toBe(false)

    const spot = onArrow(s, 2, 60)
    hoverAt(s.canvas, spot)
    expect(s.canvas.style.cursor).toBe('')

    const event = press(s.canvas, spot)
    dragFrom(spot)
    expect(s.vp.moved.size).toBe(0)
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
  })

  it('ignores every button but the primary one', () => {
    // The right button is a gesture of its own on this page — it opens the part
    // menu, and the library pans on it. A press this widget does not want is a
    // press it has no business taking away from anybody else.
    const s = scene()
    rendered(s.viewer)

    const spot = onArrow(s, 0)
    const event = press(s.canvas, spot, 2)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()

    dragFrom(spot)
    expect(stands(s.groups[PART])).toEqual([0, 0, 0])
    expect(details(s.vp, EVENT_MOVED)).toEqual([])
  })

  it('takes no press and offers no cursor on the origin dot', () => {
    // THE DOT IS DRAWN AND NEVER PRESSED. It used to be the free drag's own
    // handle and that gesture is gone (tools.js), so nothing of it may answer a
    // ray: a cursor over it would promise a grab the press then refuses, and a
    // press it swallowed would be an orbit the reader never got.
    //
    // FACE ON IS WHERE THE ARROWS DO NOT COVER FOR IT, which is what makes this
    // a claim about the dot. Their hit cylinders start at its rim IN THE WORLD
    // and the quads stand further out still, so a ray through the middle of the
    // widget crosses nothing whatever — the Z arrow, which would lie along it,
    // is the one the floor takes off the screen here.
    const s = scene()
    rendered(s.viewer)
    const spot = onDot(s)
    expect(band(dotOf(s), 'ink').visible, 'the premise: the dot is drawn')
      .toBe(true)
    expect(rayAt(s, spot), 'something of the widget answered here').toEqual([])

    hoverAt(s.canvas, spot)
    expect(s.canvas.style.cursor).toBe('')

    const event = press(s.canvas, spot)
    dragFrom(spot)

    expect(stands(s.groups[PART])).toEqual([0, 0, 0])
    expect(s.vp.moved.size).toBe(0)
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('gives an overlapping press to the quad rather than to the arrow', () => {
    // THE OTHER RUNG OF THE SAME LADDER. A quad is filled to its edges and an
    // arrow's target is a 14 px cylinder round a 2 px shaft, so where the two
    // cross the reader is aiming at the quad — which is what the flat widget
    // got from building the quads after the arrows.
    //
    // THE CAMERA IS WHAT MAKES THEM CROSS: looking down `(1, 1, -1)`, the world
    // direction `X + Y` and the world axis Z project onto the SAME screen ray,
    // so the XY quad — which stands out along both X and Y — lands squarely on
    // the Z arrow's screen image.
    const s = scene({ camera: looking({
      forward: [1, 1, -1], right: [1, -1, 0], up: [1, 1, 2],
    }) })
    rendered(s.viewer)
    expect(upright(s, armOf(s, 2)), 'the premise: the Z arrow is drawn')
      .toBe(true)
    expect(upright(s, quadOf(s, 2)), 'the premise: the XY quad is drawn')
      .toBe(true)

    const spot = onQuad(s, 2)
    expect(rayAt(s, spot).map((one) => one.object),
           'the premise: both pieces answer this ray')
      .toEqual(expect.arrayContaining([hitOf(armOf(s, 2)), hitOf(quadOf(s, 2))]))

    press(s.canvas, spot)
    dragFrom(spot)

    // THE PLANE'S OWN CONSTRAINT: Z is held and the other two moved, where the
    // arrow would have moved Z and nothing else.
    const moved = stands(s.groups[PART])
    expect(moved[2]).toBe(0)
    expect(moved[0]).not.toBe(0)
    expect(moved[1]).not.toBe(0)
  })
})

/** A row of two copies of one part, which is what the interface sends as the
 *  selection for a `pin x2` row (issue #75): one gesture applies one delta to
 *  every path of it.
 *
 * BOTH COPIES STAND ON THE SAME CENTRE, and nothing below reads where either of
 * them is DRAWN — the widget stands on the first selected path, so this is what
 * keeps one press point valid however the row is selected. What the tests using
 * it ask about is `vp.moved` and what the release announces.
 */
const PINS = ['/Group/pin', '/Group/pin(2)']
const row = (selected = PINS) => scene({
  selected, groups: Object.fromEntries(PINS.map((p) => [p, solid(p)])),
})

describe('one whole drag', () => {
  it('moves the part along the axis grabbed and along nothing else', () => {
    // THE WHOLE POINT OF THE WIDGET. The same gesture drives both arrows below;
    // free, it would have produced `[10, -3, 0]`, which is a delta on two axes
    // from a hand that named one.
    const across = scene()
    rendered(across.viewer)
    const onX = onArrow(across, 0)
    press(across.canvas, onX)
    dragFrom(onX)

    expect(stands(across.groups[PART])).toEqual([10, 0, 0])

    const up = scene()
    rendered(up.viewer)
    const onY = onArrow(up, 1)
    press(up.canvas, onY)
    dragFrom(onY)

    expect(stands(up.groups[PART])).toEqual([0, -3, 0])
  })

  it('moves nothing at all for a drag square across its own axis', () => {
    // The projection of a displacement perpendicular to the axis is zero, which
    // is the other half of "along that axis only": the part stands still rather
    // than creeping.
    const s = scene()
    rendered(s.viewer)

    const spot = onArrow(s, 0)
    press(s.canvas, spot)
    pointerMove([spot[0], spot[1] + 60])

    expect(stands(s.groups[PART])).toEqual([0, 0, 0])
  })

  it('says where the part ended up once, and only when the hand comes off', async () => {
    // THE RELEASE IS THE ONLY REPORT: the interface answers a recorded move by
    // opening the panel, which re-stages, and a re-stage ends the gesture the
    // reader has not let go of.
    const s = scene()
    rendered(s.viewer)

    const spot = onArrow(s, 0)
    press(s.canvas, spot)
    dragFrom(spot)
    await settled()
    expect(details(s.vp, EVENT_MOVED), 'it spoke mid-drag').toEqual([])

    pointerUp(dragged(spot))
    await settled()

    const reports = details(s.vp, EVENT_MOVED)
    expect(reports).toHaveLength(1)
    expect(reports[0].delta).toEqual([10, 0, 0])
    expect(reports[0].paths).toEqual([PART])
    expect(reports[0].build).toBe('build-1')

    // And the gesture really ended: the window listeners went with it, so a
    // pointer that moves on past the release moves no part.
    pointerMove([spot[0] + 400, spot[1] + 60])
    expect(stands(s.groups[PART])).toEqual([10, 0, 0])
  })

  it('says nothing for a drag that came back to the offset it started on', async () => {
    // MEASURED AGAINST WHAT WAS ALREADY STANDING AND NOT AGAINST ZERO, which is
    // the guard in `reportModelMove` and the reason it is asked of `bases`: a
    // part of the build, unlike a body of the proposal, may already be
    // displaced when this press lands. A drag that crossed a snap step and came
    // back to the one it started on has changed nothing, and announcing it
    // would write a node the document already has — which the interface answers
    // by opening the panel on nothing new.
    const s = scene()
    rendered(s.viewer)
    s.vp.moved.set(PART, { delta: [4, 0, 0], turn: [0, 0, 0] })

    const spot = onArrow(s, 0)
    press(s.canvas, spot)
    dragFrom(spot)
    expect(stands(s.groups[PART]), 'the premise: it really did go somewhere')
      .toEqual([14, 0, 0])
    pointerMove(spot)
    pointerUp(spot)
    await settled()

    expect(stands(s.groups[PART])).toEqual([4, 0, 0])
    expect(details(s.vp, EVENT_MOVED)).toEqual([])
  })

  it('announces the delta that LANDED, not the one that was refused', async () => {
    // `stood` EXISTS FOR THIS AND ONLY THIS. Past its pre-check `movePart` is
    // not atomic: a `position.set` that throws part way down a row leaves the
    // paths before it displaced and answers `false` without unwinding (parts.js
    // says why). The snapped delta has to advance whatever happens, or a step
    // that failed would be retried on every event for the rest of the gesture —
    // so the two are separate fields, and what the release announces is the
    // last offset the whole gesture is known to have reached.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = row()
    rendered(s.viewer)

    const spot = onArrow(s, 0)
    press(s.canvas, spot)
    dragFrom(spot)
    const landed = [...s.vp.moved.get(PINS[0]).delta]
    s.groups[PINS[1]].position.set = () => { throw new Error('gone') }
    const far = [spot[0] + 2 * DRAG[0], spot[1] + DRAG[1]]
    pointerMove(far)
    pointerUp(far)
    await settled()

    const [report] = details(s.vp, EVENT_MOVED)
    expect(report.delta).toEqual(landed)
    // The scene really is out of step — the first path took the refused step
    // before the throw — and settling that is `reconcileMoves`'s job, off the
    // document this delta is about to be written into.
    expect(stands(s.groups[PINS[0]])).toEqual(landed.map((v) => v * 2))
  })

  it('speaks up when the ANCHOR came back but its siblings did not', async () => {
    // THE GUARD IS ASKED OF EVERY PATH, and this is the gesture that made it
    // have to be. One copy is dragged out on its own, so the row stands apart:
    // one at the offset, one at home. The row is then selected with the
    // DISPLACED copy FIRST — it is the anchor, so the drag starts from its
    // offset — carried out and brought back to exactly where it began. Nothing
    // happened to the anchor. Everything happened to its sibling, which one
    // delta applied to every path (`movePart`) has carried the whole way
    // across.
    //
    // Asked about the anchor alone this reads as a gesture that went nowhere,
    // and the sibling is left standing at an offset no node in the document
    // claims — until the next push jerks it home under the reader's hand.
    const s = row([PINS[1]])
    rendered(s.viewer)
    const spot = onArrow(s, 0)
    press(s.canvas, spot)
    dragFrom(spot)
    pointerUp(dragged(spot))
    await settled()
    const [first] = details(s.vp, EVENT_MOVED)
    expect(stands(s.groups[PINS[0]]), 'the sibling came along on the first drag')
      .toEqual([0, 0, 0])

    s.vp.state = { ...s.vp.state, selected: [PINS[1], PINS[0]] }
    rendered(s.viewer)
    press(s.canvas, spot)
    dragFrom(spot)
    pointerMove(spot)
    pointerUp(spot)
    await settled()

    const reports = details(s.vp, EVENT_MOVED)
    expect(reports).toHaveLength(2)
    expect(reports[1].delta).toEqual(first.delta)
    expect(reports[1].paths).toEqual([PINS[1], PINS[0]])
    expect(stands(s.groups[PINS[0]]), 'the sibling did not come to the anchor')
      .toEqual(first.delta)
  })

  it('stamps the build at the PRESS, whatever arrives mid-drag', async () => {
    // AS OF THE PRESS AND NOT THE RELEASE, which is what makes it a stamp
    // rather than a reading: the scene can be replaced under a hand that has
    // not come off the model, and what these paths and this offset describe is
    // the assembly that was on screen when the grab was made. The other side
    // drops a report whose stamp is not the build it is showing, so one stamped
    // at the release would be filed against the wrong assembly — and across a
    // revision the same path can be a different part altogether.
    //
    // `drawnKey` AND NOT `state.buildKey`, which is what the fixture moves
    // here: the state field goes the moment a swap is ANNOUNCED and the
    // geometry arrives after the `await fetch` in `load()`, while `show()`
    // writes `drawnKey` beside the payload — the line that means the new scene
    // is really up.
    const s = scene()
    rendered(s.viewer)

    const spot = onArrow(s, 0)
    press(s.canvas, spot)
    dragFrom(spot)
    s.vp.drawnKey = 'build-2'
    pointerUp(dragged(spot))
    await settled()

    expect(details(s.vp, EVENT_MOVED)[0].build).toBe('build-1')
  })

  it('announces the retraction when a part is dragged back home', async () => {
    // A ZERO IS NOT SILENCE, and it is the half of the guard the test above
    // cannot reach. `reportModelMove` asks whether the gesture CHANGED
    // anything, not whether the delta is nothing: a part standing displaced and
    // dragged back to where the build puts it has changed a great deal, and the
    // interface answers that by deleting the move node rather than by writing a
    // displacement of (0, 0, 0) into the projection. An early return on a zero
    // delta would pass everything else in this file and lose exactly this.
    const s = scene()
    rendered(s.viewer)
    const out = onArrow(s, 0)
    press(s.canvas, out)
    dragFrom(out)
    pointerUp(dragged(out))
    await settled()
    expect(stands(s.groups[PART])).not.toEqual([0, 0, 0])

    // From where the part now stands, the same travel back the way it came.
    rendered(s.viewer)
    const home = onArrow(s, 0)
    const there = [home[0] - DRAG[0], home[1] - DRAG[1]]
    press(s.canvas, home)
    pointerMove(there)
    pointerUp(there)
    await settled()

    // `-0` ON THE AXIS THAT CAME BACK, which is what `Math.round` answers for a
    // negative landing on zero, so the question is asked the way arithmetic
    // asks it rather than the way `Object.is` does. It is the same number
    // everywhere it goes from here — `-0 === 0` for the guard in
    // `reportModelMove`, and `JSON.stringify` writes `0` into the document.
    const [, back] = details(s.vp, EVENT_MOVED)
    expect(back.delta.every((v) => v === 0), 'the delta did not come home')
      .toBe(true)
    expect(stands(s.groups[PART]).every((v) => v === 0), 'the part did not')
      .toBe(true)
  })

  it('carries the turn the part is already standing at through the drag', async () => {
    // `movePart` writes the group's quaternion on EVERY call, the identity
    // included — so a drag that said nothing about the turn would flatten a
    // part the reader had turned in the panel, under their own hand, with the
    // document still saying it is turned. `moveRecord` reads the anchor's turn
    // once at the press and hands it back on every step.
    //
    // NO PIVOT IS SEEDED, unlike the version of this that lived in
    // tools.test.js: `solid()` above carries real positions and a bounding box,
    // so `partCentre` answers and `partPivot` fills itself on the first turn
    // (parts.js). A part whose centre cannot be read is one `movePart` refuses
    // to turn at all, which parts.test.js pins separately.
    const s = row()
    for (const path of PINS) {
      s.vp.moved.set(path, { delta: [0, 0, 0], turn: [0, 0, 90] })
    }
    rendered(s.viewer)

    const spot = onArrow(s, 0)
    press(s.canvas, spot)
    dragFrom(spot)
    pointerUp(dragged(spot))
    await settled()

    expect(s.vp.moved.get(PINS[0]).turn).toEqual([0, 0, 90])
    expect(s.groups[PINS[0]].quaternion.w)
      .toBeCloseTo(Math.cos((45 * Math.PI) / 180), 12)
    // AND THE REPORT SAYS NOTHING ABOUT THE TURN, because a drag is about
    // WHERE: the node the interface edits keeps the turn it was already
    // carrying.
    const [report] = details(s.vp, EVENT_MOVED)
    expect(report.delta).not.toEqual([0, 0, 0])
    expect(report.turn).toBeUndefined()
  })

  it('rounds to the step tools.js sets, not to the arithmetic', async () => {
    // ONE VOCABULARY FOR ONE DOCUMENT. `niceStep` and `snap` are imported from
    // tools.js rather than copied, so a 20 mm assembly lands on tenths here
    // exactly as it does under a quad or a disc — `0.6` and not the
    // `0.6000000000000001` six steps of a tenth come to in binary.
    const s = scene({ gridSize: 20 })
    rendered(s.viewer)

    const spot = onArrow(s, 0)
    press(s.canvas, spot)
    pointerMove([spot[0] + 12, spot[1] + 60])
    pointerUp([spot[0] + 12, spot[1] + 60])
    await settled()

    expect(details(s.vp, EVENT_MOVED)[0].delta).toEqual([0.6, 0, 0])
    expect(s.vp.moved.get(PART)).toEqual({ delta: [0.6, 0, 0], turn: [0, 0, 0] })
    expect(stands(s.groups[PART])).toEqual([0.6, 0, 0])
  })

  it('says nothing when the press never moved', async () => {
    // A bare click on an arrow is not a placement: reported, it would write a
    // node the document already has and open the panel to show the reader
    // nothing new.
    const s = scene()
    rendered(s.viewer)

    const spot = onArrow(s, 0)
    press(s.canvas, spot)
    pointerUp(spot)
    await settled()

    expect(details(s.vp, EVENT_MOVED)).toEqual([])
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
    const s = scene({ gridSize: 20 })
    rendered(s.viewer)
    const spot = onArrow(s, 0)
    press(s.canvas, spot)

    pointerMove([spot[0] + CLICK_PX - 1, spot[1] + CLICK_PX - 1])
    expect(stands(s.groups[PART]), 'still a click').toEqual([0, 0, 0])
    pointerUp([spot[0] + CLICK_PX - 1, spot[1] + CLICK_PX - 1])
    await settled()
    expect(details(s.vp, EVENT_MOVED)).toEqual([])

    // And one pixel past it the same gesture is a drag, carrying the whole
    // travel from the PRESS rather than from where the threshold was crossed —
    // the part must not lag the hand by the width of the dead zone.
    press(s.canvas, spot)
    pointerMove([spot[0] + CLICK_PX, spot[1]])
    expect(stands(s.groups[PART])).toEqual([CLICK_PX / 20, 0, 0])
  })

  it('keeps the part under the cursor on an oblique camera', async () => {
    // THE ONE THING DIRECT MANIPULATION HAS TO GET RIGHT, and the arithmetic
    // that gets it wrong is invisible face-on. The world vector a screen
    // displacement spans lies IN the plane of the screen, so of the axis it sees
    // only the part lying there too — `sine` of it. Walking the part by `t`
    // moves its projection by `t * sine`, and dotting that with the axis takes
    // another `sine`: a bare dot answers `t * sine^2`. Every other arrow drag in
    // this file looks square down an axis, where `sine` is 1 and the error
    // cannot show; here it is `sqrt(2/3)`, so a missing division leaves the part
    // at two thirds of where the hand went.
    const s = scene({ camera: looking(OBLIQUE) })
    rendered(s.viewer)

    const spot = onArrow(s, 0)
    press(s.canvas, spot)
    dragFrom(spot)
    pointerUp(dragged(spot))
    await settled()

    // Dotted with X — which is `OBLIQUE_WORLD[0]` — and divided by `sine^2`.
    const along = round(OBLIQUE_WORLD[0] / (2 / 3))

    expect(stands(s.groups[PART])).toEqual([along, 0, 0])
    expect(details(s.vp, EVENT_MOVED)[0].delta).toEqual([along, 0, 0])
    // NOT WHAT A BARE DOT ANSWERS, which is the whole of the defect and the
    // reason this camera is here: face-on the two are the same number.
    expect(round(OBLIQUE_WORLD[0])).not.toBe(along)
  })

  it('leaves the two axes it is not on exactly as it found them', async () => {
    // AN OFFSET ALREADY STANDING NEED NOT BE ON THIS GRID. It comes from the
    // proposal document, whose `delta.<axis>` fields the reader types by hand —
    // so passing all three components through `snap` rounds the two this gesture
    // never touched. A drag along X would then move the part along Y as well and
    // report it, a number written as 12.34 coming back as 12.5.
    const s = scene({ gridSize: 20 })
    rendered(s.viewer)
    s.vp.moved.set(PART, { delta: [0, 12.34, -0.07], turn: [0, 0, 0] })

    const spot = onArrow(s, 0)
    press(s.canvas, spot)
    pointerMove([spot[0] + 20, spot[1]])
    pointerUp([spot[0] + 20, spot[1]])
    await settled()

    expect(stands(s.groups[PART])).toEqual([1, 12.34, -0.07])
    expect(details(s.vp, EVENT_MOVED)[0].delta).toEqual([1, 12.34, -0.07])
  })

  it('is concluded when the pointer is taken away', async () => {
    // A MOVE IS REPORTED FROM EVERY ENDING, which is where this parts company
    // with the section grip: a cancelled cut is dropped, and a cancelled move
    // leaves the part standing somewhere the document does not claim, so the
    // next reconcile would send it home and the drag would be silently undone.
    const s = scene()
    rendered(s.viewer)

    const spot = onArrow(s, 0)
    press(s.canvas, spot)
    dragFrom(spot)
    pointerCancel()
    await settled()

    expect(details(s.vp, EVENT_MOVED)).toHaveLength(1)

    // And it really ended.
    pointerMove([spot[0] + 400, spot[1] + 60])
    expect(details(s.vp, EVENT_MOVED)).toHaveLength(1)
  })

  it('concludes a drag the scene is being pulled out from under', async () => {
    // The twin of `vp.endGesture`, and the reason it is a third call rather than
    // the same one: the press was taken in a window listener this widget owns,
    // so neither that gesture nor the idle clock that defers the swap ever saw
    // it.
    const s = scene()
    rendered(s.viewer)

    const spot = onArrow(s, 0)
    press(s.canvas, spot)
    dragFrom(spot)

    s.gizmo.endDrag()
    expect(details(s.vp, EVENT_MOVED), 'the report went out inside the render')
      .toEqual([])

    await settled()
    expect(details(s.vp, EVENT_MOVED)).toHaveLength(1)

    // And the release that never came cannot report a second time.
    pointerUp(dragged(spot))
    await settled()
    expect(details(s.vp, EVENT_MOVED)).toHaveLength(1)
  })

  it('is concluded when another press arrives with it still live', async () => {
    const s = scene()
    rendered(s.viewer)

    const spot = onArrow(s, 0)
    press(s.canvas, spot)
    dragFrom(spot)
    press(s.canvas, onArrow(s, 1))
    await settled()

    expect(details(s.vp, EVENT_MOVED)).toHaveLength(1)
    pointerUp(dragged(spot))
  })

  it('edits the panel`s document for a body the proposal staged', async () => {
    // THE SECOND MEANING OF THE SAME GESTURE, and the arrows reach it through
    // the same `reportMove` the quads and the discs do. A body of the proposal
    // is the reader's OWN drawing: it moves for the eye alone while the hand
    // is down, nothing is recorded for it, and the release names the body to
    // the panel.
    const BODY = '/Group/proposal/plate'
    const s = scene({
      selected: [BODY],
      groups: { [BODY]: solid(BODY) },
      overlay: [{ name: 'plate' }],
    })
    rendered(s.viewer)
    expect(shown(s), 'the premise: a body is grabbable like any part').toBe(true)

    const spot = onArrow(s, 0)
    press(s.canvas, spot)
    dragFrom(spot)
    pointerUp(dragged(spot))
    await settled()

    const [report] = details(s.vp, EVENT_PROPOSALMOVE)
    expect(report.name).toBe('plate')
    expect(report.delta).toEqual([10, 0, 0])
    expect(stands(s.groups[BODY])).toEqual([10, 0, 0])
    // And none of what a part of the build leaves behind.
    expect(s.vp.moved.size, 'an offset was written for it').toBe(0)
    expect(s.vp.partHome.size, 'a home was remembered for it').toBe(0)
    expect(details(s.vp, EVENT_MOVED)).toEqual([])
  })

  it('stays on the part while the drag runs', () => {
    // What makes this a widget the reader is holding rather than a picture
    // beside one: the anchor reads the SCENE every frame. The part's group has
    // moved by here, and the widget is placed from where it now stands.
    const s = scene()
    rendered(s.viewer)
    expect(stands(s.group)).toEqual(PART_AT)

    const spot = onArrow(s, 0)
    press(s.canvas, spot)
    dragFrom(spot)
    // The scene's own matrix is what `partCentre` reads, and only a real render
    // refreshes it — so the fake is walked by hand to the place the group now
    // claims, which is what the library would have written.
    s.groups[PART].front.matrixWorld.elements[12] = stands(s.groups[PART])[0]
    rendered(s.viewer)

    expect(details(s.vp, EVENT_MOVED)).toEqual([])
    expect(stands(s.group)).toEqual([10, 0, 45])
  })
})

describe('one whole drag of a quad', () => {
  it('keeps the grabbed point under the cursor on an oblique plane', () => {
    // THE CLAIM THE WHOLE CONSTRUCTION EXISTS FOR, and the only one that tells
    // the two candidate formulas apart. Under an ortho camera every pixel looks
    // along one fixed direction, so the displacement that leaves the grabbed
    // point under the pointer AND in the plane is where the ray through the
    // moved cursor cuts the plane through where the drag began. The orthogonal
    // projection `w - n(w.n)` answers a different question — the nearest point
    // of the plane to where the bare displacement would have gone — and lags
    // the hand by whatever it threw away.
    //
    // SO THE ASSERTION IS ABOUT THE SCREEN AND NOT ABOUT THE HELD AXIS. Both
    // formulas hold the normal axis perfectly; only one of them puts the part
    // back under the cursor, so a test that checked the held axis alone would
    // pass on either.
    //
    // AND THE FACE-ON CASE CANNOT CATCH IT. Square on to a plane the normal IS
    // the view direction, so `view (w.n)/(view.n)` reduces to `n (w.n)` and the
    // two formulas are the same expression — and worse, a screen-plane
    // displacement then has no component along the normal at all, so both
    // corrections are zero and the two agree on the answer as well as on the
    // arithmetic. Only an oblique plane separates them.
    const s = scene({ camera: looking(OBLIQUE) })
    rendered(s.viewer)

    const spot = onQuad(s, 2)
    press(s.canvas, spot)
    dragFrom(spot)   // 200 px right and 60 px down, from the press

    // HOW CLOSE IS CLOSE ENOUGH: `snap` can move each of the plane's two world
    // coordinates by half a step, which at 20 px to the world unit is at most
    // `STEP * 20` px on the screen once both are counted. Nothing else stands
    // between the hand and the part.
    const slack = STEP * 20
    const went = onScreen(stands(s.groups[PART]))
    expect(Math.abs(went[0] - 200)).toBeLessThan(slack)
    expect(Math.abs(went[1] - 60)).toBeLessThan(slack)

    // AND THE OLD ANSWER IS NOWHERE NEAR IT — about 40 px adrift up the screen,
    // three times the whole slack, which is what this test would have caught.
    const ortho = onScreen(ontoPlane([0, 0, 1]).map(round))
    expect(Math.abs(ortho[1] - 60)).toBeGreaterThan(3 * slack)
  })

  it('is fenced against its own divisor by the very floor that hides it', () => {
    // KEEP THESE TWO IN STEP, which is why it is a test and not a sentence in a
    // comment. `acrossPlane` divides by `view . n` and adds no guard of its
    // own; what makes that safe is that `place` hides a quad below
    // `GIZMO_MIN_SCALE` of `face`, and `face` IS `|view . n|` — one component
    // of `cameraBasis().view`, since a quad's normal is a world axis. They are
    // one number today. Floor `place` on something else — the projected area in
    // px, the way `RING_MIN_PX` does for a ring — and the division loses its
    // fence in silence, with every other test in this file still green.
    //
    // SO THE TRANSITION IS PINNED AT THE FLOOR ITSELF, a hundredth either side:
    // above it the quad is on screen and can be pressed, below it there is
    // nothing to press and the small divisors are unreachable.
    const camera = facingZ(GIZMO_MIN_SCALE + 0.01)
    const above = scene({ camera })
    rendered(above.viewer)
    expect(upright(above, quadOf(above, 2))).toBe(true)

    const below = scene({ camera: facingZ(GIZMO_MIN_SCALE - 0.01) })
    rendered(below.viewer)
    expect(upright(below, quadOf(below, 2))).toBe(false)

    // AND THE WORST DRAG STILL REACHABLE IS AN ORDINARY ONE. At the floor the
    // divisor is a fifth and the factor five, so the correction along the view
    // axis is large and perfectly finite — and the part still lands under the
    // cursor, which is the whole claim holding at the one camera where it is
    // under most strain.
    const spot = onQuad(above, 2)
    press(above.canvas, spot)
    dragFrom(spot)

    const went = onScreen(stands(above.groups[PART]), camera.right, camera.up)
    expect(went.every(Number.isFinite), 'the divisor blew up').toBe(true)
    expect(Math.abs(went[0] - 200)).toBeLessThan(STEP * 20)
    expect(Math.abs(went[1] - 60)).toBeLessThan(STEP * 20)
    // And the axis the plane holds is still held, at the very edge of the fence.
    expect(stands(above.groups[PART])[2]).toBe(0)
  })

  it('moves the part on the plane`s two axes and holds the third', () => {
    // THE CONSTRAINT ITSELF, beside the tracking above: whatever the two axes
    // of the plane do, the third does not move at all.
    //
    // THE PREMISE IS THAT THERE WAS SOMETHING TO HOLD. Square on to the screen
    // the hand cannot produce a Z component in the first place, so this camera
    // is what makes the claim mean anything.
    expect(Math.abs(OBLIQUE_WORLD[2]), 'the drag really does reach Z')
      .toBeGreaterThan(STEP)

    const s = scene({ camera: looking(OBLIQUE) })
    rendered(s.viewer)

    const spot = onQuad(s, 2)
    press(s.canvas, spot)
    dragFrom(spot)

    expect(stands(s.groups[PART])).toEqual(heldAt([0, 0, 1]))
  })

  it('takes the same two axes for whichever plane was grabbed', () => {
    // ONE QUAD PER PLANE AND EACH ONE ITS OWN, which a single quad could not
    // show: the YZ quad has to hold X exactly as the XY quad holds Z, and each
    // meets the cursor's ray with its OWN plane. The same gesture drives both.
    const yz = scene({ camera: looking(OBLIQUE) })
    rendered(yz.viewer)
    const onYZ = onQuad(yz, 0)
    press(yz.canvas, onYZ)
    dragFrom(onYZ)

    expect(stands(yz.groups[PART])).toEqual(heldAt([1, 0, 0]))

    const zx = scene({ camera: looking(OBLIQUE) })
    rendered(zx.viewer)
    const onZX = onQuad(zx, 1)
    press(zx.canvas, onZX)
    dragFrom(onZX)

    expect(stands(zx.groups[PART])).toEqual(heldAt([0, 1, 0]))
  })

  it('leaves the axis it holds exactly as it found it', () => {
    // AN OFFSET ALREADY STANDING NEED NOT BE ON THIS GRID, which is the arrows'
    // own rule and the reason the held axis is handed through rather than
    // passed to `snap` with nothing added to it. The number arrives from the
    // proposal document, whose `delta.<axis>` fields the reader types by hand:
    // rounded here, a drag on the XY plane would report a Z the reader wrote as
    // 12.34 coming back as 12.5, as part of a gesture that never touched it.
    const s = scene({ camera: looking(OBLIQUE), gridSize: 20 })
    rendered(s.viewer)
    s.vp.moved.set(PART, { delta: [0, 0, 12.34], turn: [0, 0, 0] })

    const spot = onQuad(s, 2)
    press(s.canvas, spot)
    dragFrom(spot)

    expect(stands(s.groups[PART])[2]).toBe(12.34)
  })

  it('says where the part ended up in the same sentence an arrow does', async () => {
    // ONE VOCABULARY FOR ONE DOCUMENT. A quad's drag ends in the same
    // `reportMove` the arrows and the discs end in, so what reaches the panel
    // is a move node like any other — the same `delta`, the same paths,
    // the same build stamp, once, and only when the hand comes off.
    const s = scene({ camera: looking(OBLIQUE) })
    rendered(s.viewer)

    const spot = onQuad(s, 2)
    press(s.canvas, spot)
    dragFrom(spot)
    await settled()
    expect(details(s.vp, EVENT_MOVED), 'it spoke mid-drag').toEqual([])

    pointerUp(dragged(spot))
    await settled()

    const reports = details(s.vp, EVENT_MOVED)
    expect(reports).toHaveLength(1)
    expect(reports[0].delta).toEqual(heldAt([0, 0, 1]))
    expect(reports[0].paths).toEqual([PART])
    expect(reports[0].build).toBe('build-1')
    expect(s.vp.moved.get(PART))
      .toEqual({ delta: heldAt([0, 0, 1]), turn: [0, 0, 0] })
  })
})

describe('a press this widget does take', () => {
  it('ends every other gesture that could be live', () => {
    // THREE THINGS CAN BE RUNNING WHEN A PIECE IS PRESSED, and until the tools
    // were merged only the first could: this widget's own drag, the rotation
    // handles' drag, and the canvas gesture in tools.js — which under `move` is
    // either a cut the hold key put up or the ordinary press that missed every
    // piece of the widget. The first two write the same part through
    // `movePart`, which sets position AND orientation together from its own
    // snapshot of the other's half, so the two live at once overwrite each
    // other frame by frame and both report at the release; the third goes on
    // dragging the clipping plane under a hand that has left it, or, as a plain
    // press, ends in a pick that changes the selection mid-drag.
    //
    // THE CANVAS ONE IS THE ONE A PRESS HERE CANNOT OTHERWISE REACH. tools.js
    // finishes its own previous press at the head of its `onDown`, and that
    // listener DOES see every press aimed at the canvas — so what opens the
    // hole is the refusal `scene3d.js` makes on our answer, which takes the
    // press away before that listener runs.
    //
    // THE SECTION GRIP IS THE FOURTH AND IS DELIBERATELY NOT ENDED: it drives
    // the clipping plane, and nothing it writes is anything this reads.
    const s = scene({ camera: looking(OBLIQUE) })
    rendered(s.viewer)

    for (const spot of [onArrow(s, 0), onQuad(s, 2)]) {
      s.vp.rings.endDrag.mockClear()
      s.vp.endGesture.mockClear()
      press(s.canvas, spot)
      pointerUp(spot)
      expect(s.vp.rings.endDrag, 'the handles were left running')
        .toHaveBeenCalled()
      expect(s.vp.endGesture, 'the canvas gesture was left running')
        .toHaveBeenCalled()
    }
  })
})
