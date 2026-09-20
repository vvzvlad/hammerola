// ui/src/viewport/handle.js — the grip on the section plane.
//
// There is no GPU here and nothing below looks at a pixel, which is the same
// discipline the rest of this suite keeps — but the grip is a group of MESHES in
// the library's scene now, so what is assertable has moved with it. Where it
// stands is a world point rather than a projection; which way it points is a
// rotation taken into the world rather than a CSS angle; how big it is drawn is
// `scene3d.js`'s one scale, and that module's own suite asks about it. Left here
// are the questions only this file can answer: WHERE the arrow is put, WHICH WAY
// it lies, WHAT it is built out of, WHEN it refuses to be drawn at all, what a
// press on it does — and what one whole drag does to the plane and says at the
// end of it.
//
// A FRAME HERE IS THE LIBRARY DRAWING ONE, `rendered(viewer)` — the fork calls
// `onBeforeRender` at the top of `Viewer.update` and the grip is placed there,
// in the frame that then draws it (`scene3d.js`). Nothing in this file runs a
// timer, and the teardown says so for every test in it.
//
// THE CAMERA IS TWO OBJECTS, exactly as in scene3d.test.js: this directory's own
// model of an ortho projection, which every measurement is taken against, and a
// real `THREE.OrthographicCamera` at the same pose installed where `getCamera()`
// answers, because the press is a ray and a ray needs matrices. This camera puts
// 20 px on a world unit along both screen axes (800 px per 40 world across,
// 600 px per 30 up), so the seed at the middle of the frame projects to
// (400, 300) and one world unit along +X is 20 px to the right.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'

// `dragSection` is the one call this module makes into the section that a test
// can only see the ARGUMENTS of — the deltas are the whole claim, and the world
// distance they produce is section.js's own suite's business. It is spied on
// while still doing its real work, so the plane really moves and the readback at
// the release is a real one; everything else in the module stays untouched.
vi.mock('../src/viewport/section.js', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, dragSection: vi.fn((...args) => real.dragSection(...args)) }
})

import { EVENT_FACE } from '../src/viewport/events.js'
import { createHandle } from '../src/viewport/handle.js'
import { internals } from '../src/viewport/internals.js'
import {
  HANDLE_CASE_PX, HANDLE_HEAD_PX, HANDLE_HIT_PX, HANDLE_PX, HANDLE_RING_PX,
  HANDLE_SHAFT_PX, SECTION_INDEX,
} from '../src/viewport/options.js'
import { HANDLE_ORDER } from '../src/viewport/scene3d.js'
import {
  applySection, captureSection, dragSection, placeSectionPlane, restoreSection,
  sectionAxis, sectionGripAxis, sectionOffset,
} from '../src/viewport/section.js'
import { RECT, framesAsked, rendered, stubFrames } from './component.js'
import { fakeViewer, fakeViewport, orthoCamera, realCamera } from './fakes.js'

const handles = []

beforeEach(() => {
  vi.clearAllMocks()
  // STUBBED SO THAT NOTHING CAN ASK FOR A FRAME UNSEEN (ui/tests/component.js).
  // Nothing here drives one: the grip is placed from inside the library's render
  // pass, and `framesAsked` below is what says so after every test.
  stubFrames()
})

afterEach(() => {
  // Before the next test dispatches on the window: a handle left standing would
  // leave a dead viewport's capture-phase listeners there to answer for it.
  while (handles.length) handles.pop().destroy()
  expect(framesAsked(), 'the grip asks for no animation frames').toBe(0)
  vi.unstubAllGlobals()
})

/** Where the seed projects on an 800x600 canvas: the middle of it. */
const MIDDLE = [400, 300]

/**
 * A viewport with a cut on it, a scene to stand the grip in, and the grip.
 *
 * THE CANVAS IS A REAL NODE, for the reason rings.test.js gives for its own: the
 * press is read in a capture-phase listener on the WINDOW that declines any
 * target but the canvas, so it has to be an event the DOM really dispatched at
 * one. The rect is stubbed on because jsdom computes no layout.
 */
function scene({ normal = [1, 0, 0], point = [0, 0, 45], camera } = {}) {
  const model = camera || orthoCamera()
  realCamera(THREE, model)
  const viewer = fakeViewer({ camera: model, rect: RECT })
  const canvas = document.createElement('div')
  canvas.getBoundingClientRect = () => ({ ...RECT })
  document.body.appendChild(canvas)
  viewer.canvas = canvas
  viewer.renderer.domElement = canvas
  viewer.scene = new THREE.Scene()

  const vp = fakeViewport(viewer, { cut: true })
  vp.dispatchEvent = vi.fn()
  const g = internals(viewer)
  expect(placeSectionPlane(vp, g, normal, point)).toBe(true)
  vp.sectionSeed.id = '/Group/wall'
  vp.sectionSeed.name = 'wall'
  const handle = createHandle(vp)
  handles.push(handle)
  // What `show()` does on the far side of `render()`: the group joins the scene
  // the library has just built, the namespace comes with it, and the widget asks
  // for the frame that then places it — the scene on screen was drawn before it
  // was there.
  handle.attach(THREE)
  const group = viewer.scene.children.find((child) => child.isGroup)
  return { model, viewer, vp, g, canvas, handle, group }
}

const shown = (group) => group.visible

/** Where the arrow stands, in world coordinates. */
const stands = (group) => group.position.toArray()

/** Which way the arrow lies: its own +Y, taken into the world.
 *
 * The geometry is built along +Y — three's own axis for a cylinder and a cone —
 * so this is the direction the whole widget was turned to, read back the way the
 * renderer will read it.
 */
const along = (group) =>
  new THREE.Vector3(0, 1, 0).applyQuaternion(group.quaternion).toArray()

/** Two directions, to nine places — which is how everything below that is an
 *  orientation rather than a number is compared. */
function isVector(actual, expected) {
  expected.forEach((v, at) => expect(actual[at]).toBeCloseTo(v, 9))
}

/** The ARROW's own meshes.
 *
 * The rings' are not among them, and that is the whole reason this is a
 * function: a ring hangs under a node of its own, one level deeper, so
 * everything measured off the group's direct children is about the arrow it
 * was written for.
 */
const arrowPieces = (group) => group.children.filter((child) => child.isMesh)

/** ...and the two ring nodes, in the order `build` adds them: the ring that
 *  tilts the normal about the group's local +X, then the one about local +Z. */
const ringNodes = (group) => group.children.filter((child) => !child.isMesh)

/** What one ring DRAWS, outermost band first. */
const ringBands = (node) => node.children.filter((child) => child.visible)

/** A vector of a node's own frame, read out in the frame of its parent. */
const facing = (node, v) =>
  new THREE.Vector3(...v).applyQuaternion(node.quaternion).toArray()

/** ...and one ring's own axis IN THE WORLD: where its node's +Z points once the
 *  group's own orientation has carried it there. `getWorldQuaternion` composes
 *  up the parents itself, so this answers for whatever the last frame placed. */
const worldAxis = (node) => new THREE.Vector3(0, 0, 1)
  .applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion())).toArray()

/** The extent of what is DRAWN, in the group's own units — which are CSS pixels.
 *
 * In the group's frame and not in the world, so the answer is the widget's own
 * size rather than the size the camera happens to leave of it. The invisible
 * pick target is left out by the same test the renderer applies.
 */
function inkPieces(group) {
  // THE INK AND NOT THE CASING. The arrow is drawn twice -- a white copy two
  // pixels proud of a dark one, which is how one colour stands on both themes
  // (`HANDLE_CASE_PX` in options.js) -- and `HANDLE_PX` is a promise about the
  // DARK one. The casing stands outside it deliberately, exactly as the rotation
  // handles' rim stands outside `RING_PX`. Told apart by `renderOrder`, which is
  // what the renderer itself sorts them by: the casing is -1, the ink 0.
  return arrowPieces(group).filter(
    (child) => child.visible && child.renderOrder === 0)
}

function inkBox(group) {
  const box = new THREE.Box3()
  for (const child of inkPieces(group)) {
    child.updateMatrix()
    child.geometry.computeBoundingBox()
    box.union(child.geometry.boundingBox.clone().applyMatrix4(child.matrix))
  }
  return box
}

/** A press on the canvas, with both refusals watched. */
function grab(canvas, [clientX, clientY] = MIDDLE, button = 0) {
  const event = new MouseEvent('pointerdown', {
    button, clientX, clientY, bubbles: true, cancelable: true,
  })
  vi.spyOn(event, 'stopImmediatePropagation')
  vi.spyOn(event, 'preventDefault')
  canvas.dispatchEvent(event)
  return event
}

/** The rest of the gesture. It goes to the WINDOW, which is where the press put
 *  the listeners — a drag that starts on the arrow can end anywhere. */
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

describe('when there is nothing to grab', () => {
  it('draws nothing while the cut is switched off', () => {
    // The cut is a THING THAT IS ON, and turning it off parks the plane where it
    // cuts nothing while keeping the seed. A grip on a plane that is not cutting
    // would offer a gesture with no visible effect.
    const { viewer, vp, group } = scene()
    rendered(viewer)
    expect(shown(group), 'the premise: it is on screen with a cut standing').toBe(true)

    vp.state = { ...vp.state, cut: false }
    rendered(viewer)
    expect(shown(group)).toBe(false)
  })

  it('draws nothing when no plane was ever placed', () => {
    const { viewer, vp, group } = scene()
    rendered(viewer)
    expect(shown(group)).toBe(true)

    vp.sectionSeed = null
    rendered(viewer)
    expect(shown(group)).toBe(false)
  })

  it('draws nothing when the seed cannot be measured', () => {
    // The seed is checked whole in `placeSectionPlane` and this is the state
    // nothing else guards: a normal that is not a direction. `set` on a NaN
    // leaves the group at no position at all and `setFromUnitVectors` on a zero
    // vector leaves a rotation nothing can undo — both of them silent, and both
    // of them permanent, because the group is built once and kept.
    const { viewer, vp, group } = scene()
    rendered(viewer)
    expect(shown(group)).toBe(true)

    vp.sectionSeed = { ...vp.sectionSeed, normal: [0, Number.NaN, 0] }
    rendered(viewer)
    expect(shown(group)).toBe(false)
  })

  it('takes no press once it is off the screen', () => {
    // Both halves of the module have to agree about a grip that is not drawn:
    // three's raycaster tests an object's LAYERS and never its visibility, so a
    // widget the last frame hid would otherwise go on taking presses at
    // wherever it was last placed — stealing the reader's orbit with nothing on
    // screen to explain it.
    const { viewer, vp, canvas, group } = scene()
    rendered(viewer)
    vp.state = { ...vp.state, cut: false }
    rendered(viewer)
    expect(shown(group)).toBe(false)

    const press = grab(canvas)
    pointerMove([440, 300])
    expect(dragSection).not.toHaveBeenCalled()
    expect(press.stopImmediatePropagation).not.toHaveBeenCalled()
  })
})

describe('what it is built out of', () => {
  it('is a double-headed arrow `HANDLE_PX` long, measured in pixels', () => {
    // The group's own units are CSS pixels — `scene3d.js` scales it so — which
    // is what keeps the grip the same size on a 2 mm part and a 200 mm one. The
    // two heads reach exactly half the length either side of the anchor, because
    // the plane moves BOTH ways from there.
    const { group } = scene()
    const box = inkBox(group)
    expect(box.max.y).toBeCloseTo(HANDLE_PX / 2, 9)
    expect(box.min.y).toBeCloseTo(-HANDLE_PX / 2, 9)
    // Its widest point is a head's base, and nothing about the arrow is wider.
    expect(box.max.x).toBeCloseTo(HANDLE_HEAD_PX / 2, 9)
  })

  it('stands the dark ink on a white casing, drawn under it', () => {
    // ONE COLOUR FOR BOTH THEMES is what every widget over this canvas claims,
    // and for a 2 px dark shaft on the DARK theme it is only true with something
    // light behind it. The DOM layer bought that with a `drop-shadow` filter,
    // which means nothing to a mesh; the casing is the same idea as geometry.
    //
    // UNDER IT, not merely present: with no depth test the renderer's order IS
    // the stacking, so a casing that sorted after the ink would paint the arrow
    // out entirely. That is what `renderOrder` -1 against 0 says, and three
    // sorts a group's subtree by it.
    const { group } = scene()
    const casing = arrowPieces(group).filter(
      (child) => child.visible && child.renderOrder < 0)
    expect(casing.length).toBe(inkPieces(group).length)
    expect(casing.every((child) => child.renderOrder
      < inkPieces(group)[0].renderOrder)).toBe(true)
    // And it really is proud of the ink on every side, or it would not show.
    const box = new THREE.Box3()
    for (const child of casing) {
      child.updateMatrix()
      child.geometry.computeBoundingBox()
      box.union(child.geometry.boundingBox.clone().applyMatrix4(child.matrix))
    }
    const ink = inkBox(group)
    expect(box.max.y).toBeCloseTo(ink.max.y + HANDLE_CASE_PX, 9)
    expect(box.min.y).toBeCloseTo(ink.min.y - HANDLE_CASE_PX, 9)
    expect(box.max.x).toBeCloseTo(ink.max.x + HANDLE_CASE_PX, 9)
  })

  it('stands in the grip`s own band, in the one list all three widgets share', () => {
    // TWO HALVES OF ONE ANSWER, and neither is worth anything without the
    // other. The band is where this widget is drawn among the three that stand
    // in this scene — over the rings, under the move manipulator, which is the
    // reverse of the order `element.js` builds them in, because the widget that
    // wins a contested press has to be the one the reader can see. And
    // `transparent` is what puts all three in ONE of the renderer's lists at
    // all: three sorts by that flag before it looks at any order, so an opaque
    // grip beside a blended ring is drawn FIRST whatever band it carries, and
    // the band decides nothing.
    const { group } = scene()
    expect(group.renderOrder).toBe(HANDLE_ORDER)
    // EVERY MESH AND NOT ONLY THE ARROW'S: the rings are children of this same
    // group, so one opaque band anywhere in the subtree would carry the whole
    // widget into the renderer's other list.
    group.traverse((child) => {
      if (child.isMesh) {
        expect(child.material.transparent, child.geometry.type).toBe(true)
      }
    })
  })

  it('points both heads outwards', () => {
    // A cone is built pointing +Y, so one of the two has to be turned over. Both
    // left as they came, the lower end would be an arrowhead pointing back up
    // the shaft — a picture of a different gesture.
    const { group } = scene()
    const heads = inkPieces(group).filter(
      (child) => child.geometry.type === 'ConeGeometry')
    expect(heads).toHaveLength(2)
    const aims = heads.map((head) => Math.sign(
      new THREE.Vector3(0, 1, 0).applyQuaternion(head.quaternion).y))
    expect(aims.sort()).toEqual([-1, 1])
  })

  it('is grabbed by something fatter than the ink, and never draws it', () => {
    // THE TARGET IS FAT AND THE INK IS THIN, which is the requirement
    // `HANDLE_HIT_PX` carried over from the DOM box: a hand cannot reliably hit
    // a 2 px shaft. Eight pixels off the axis, at the middle of the arrow, is
    // outside everything that is drawn there — and still takes the press.
    const { viewer, canvas, group } = scene()
    rendered(viewer)
    expect(inkBox(group).max.z).toBeLessThan(HANDLE_HIT_PX / 2)
    expect(HANDLE_HIT_PX / 2).toBeGreaterThan(HANDLE_SHAFT_PX / 2)

    expect(grab(canvas, [400, 308]).stopImmediatePropagation).toHaveBeenCalled()
    pointerUp([400, 308])
    // And not the whole canvas: past the cylinder the press belongs to the model
    // again, or a grip 56 px long would swallow the orbit around it.
    expect(grab(canvas, [400, 312]).stopImmediatePropagation).not.toHaveBeenCalled()
  })

  it('carries two rings, in the two planes that tilt the plane`s own normal', () => {
    // FIXED IN THE GROUP'S OWN FRAME, which is why there is no basis derived
    // anywhere in the module: `place` puts local +Y on the plane's normal, so a
    // ring whose axis is local +X lies in local YZ and one whose axis is local
    // +Z lies in local XY. three sweeps a torus about its own +Z, so where a
    // node's +Z points IS the axis its ring turns the plane about.
    const { group } = scene()
    const nodes = ringNodes(group)
    expect(nodes).toHaveLength(2)
    isVector(facing(nodes[0], [0, 0, 1]), [1, 0, 0])
    isVector(facing(nodes[1], [0, 0, 1]), [0, 0, 1])
    // AND WHERE THE PAIR THE ANGLE IS READ IN POINTS, which is the node's own
    // +X and +Y — so what is drawn and what is measured are the same two
    // directions rather than two spellings of them. The SIGN is not pinned
    // here and cannot be: a quaternion has no handedness to read back, and a
    // pair swapped in `TURNS` mirrors the drawing and the arithmetic together,
    // which cancels. What pins it is where the plane really ends up after a
    // quarter turn — `one whole turn`, below.
    isVector(facing(nodes[0], [1, 0, 0]), [0, 1, 0])
    isVector(facing(nodes[0], [0, 1, 0]), [0, 0, 1])
    isVector(facing(nodes[1], [1, 0, 0]), [1, 0, 0])
    isVector(facing(nodes[1], [0, 1, 0]), [0, 1, 0])
  })

  it('stands both rings clear of the arrowheads', () => {
    // A REAL QUESTION HERE AND NOT A TIDY ONE. Both rings tilt the normal, so
    // both lie in a plane that CONTAINS it — and the arrow lies along it. Every
    // ring therefore crosses the arrow's own axis, at its radius, twice, and
    // `HANDLE_RING_PX` is the clearance over the head.
    const { group } = scene()
    for (const node of ringNodes(group)) {
      const bands = ringBands(node)
      // The ink is the innermost band and its OUTER edge is what the constant
      // names, exactly as `HANDLE_PX` names the arrow's ink.
      const ink = bands[bands.length - 1].geometry.parameters
      expect(ink.radius + ink.tube).toBeCloseTo(HANDLE_RING_PX, 9)
      // The outermost band is the one that has to clear the casing over the
      // tip, which stands `HANDLE_CASE_PX` outside the arrow's half-length.
      const rim = bands[0].geometry.parameters
      expect(rim.radius - rim.tube)
        .toBeGreaterThan(HANDLE_PX / 2 + HANDLE_CASE_PX)
    }
  })

  it('draws a ring in the grip`s own ink, rimmed, and under the arrow', () => {
    // THE GRIP'S INK AND NOT A THIRD PALETTE — the same material object the
    // arrow is drawn with, which is what keeps these two from ever becoming the
    // world triad's red, green and blue. That colour means "X, Y, Z" everywhere
    // else in this interface and these rings are neither.
    //
    // UNDER THE ARROW, which is what the orders say and is not tidiness: a ring
    // seen at an angle projects an ellipse whose narrow direction can be
    // shorter than the arrow's own reach, so the two really do cross on screen,
    // and with no depth test the paint order IS the stacking.
    const { group } = scene()
    const bands = ringBands(ringNodes(group)[0])
    expect(bands).toHaveLength(3)
    expect(bands[2].material).toBe(inkPieces(group)[0].material)
    expect(bands[1].material).toBe(arrowPieces(group).find(
      (child) => child.visible && child.renderOrder < 0).material)
    // The rim is the third colour of the widget, and each band is fatter than
    // the one painted over it or there would be nothing of it left showing.
    expect(bands[0].material).not.toBe(bands[1].material)
    const tube = (mesh) => mesh.geometry.parameters.tube
    expect(tube(bands[0])).toBeGreaterThan(tube(bands[1]))
    expect(tube(bands[1])).toBeGreaterThan(tube(bands[2]))
    expect(bands[0].renderOrder).toBeLessThan(bands[1].renderOrder)
    expect(bands[1].renderOrder).toBeLessThan(bands[2].renderOrder)
    expect(bands[2].renderOrder)
      .toBeLessThan(Math.min(...arrowPieces(group).map((m) => m.renderOrder)))
  })

  it('answers a ray with the ring`s own target and never with what is drawn', () => {
    // three tests an object's LAYERS and never its visibility, so a band of ink
    // is a target in its own right unless it is told otherwise — and what tells
    // the two gestures of this widget apart is the MESH the ray landed on, so a
    // curve taking a ray would be a press on a ring read as a press on the
    // arrow. One hit mesh per ring is the whole of what answers.
    const { viewer, g, group } = scene()
    rendered(viewer)
    const node = ringNodes(group)[1]
    const caster = new THREE.Raycaster()
    group.updateMatrixWorld(true)
    caster.setFromCamera(ndcOf(onRing(HELD_T)), g.cam)
    const hits = caster.intersectObject(node, true)
    expect(hits.length).toBeGreaterThan(0)
    for (const hit of hits) expect(hit.object.visible).toBe(false)
  })
})

describe('where it is drawn', () => {
  it('stands on the point the plane meets the face, in world coordinates', () => {
    // No projection anywhere in this answer, which is the whole of what the move
    // into the scene changed here: the widget is AT the anchor, and the camera
    // is what puts it on the screen.
    const { viewer, group } = scene()
    rendered(viewer)
    expect(shown(group)).toBe(true)
    expect(stands(group)).toEqual([0, 0, 45])
  })

  it('walks with the offset, along the SEED normal', () => {
    // `state.cutOffset` is where the plane stands, counted from the face — so
    // the grip is on the plane rather than on the face it was placed from.
    const { viewer, vp, g, group } = scene()
    vp.state.cutOffset = 4
    applySection(vp, g)                       // what `reconcile` does first
    rendered(viewer)
    expect(stands(group)[0]).toBeCloseTo(4, 9)
  })

  it('asks for no render while it is being placed by one', () => {
    // The grip is placed from INSIDE the library's render pass, so anything on
    // this path that asked for a frame would be a render asking for a render —
    // a loop with nothing on screen to show for it, and the reason `place` only
    // reads the plane and the seed and only writes to the group.
    const { viewer } = scene()
    viewer.update.mockClear()

    rendered(viewer)
    expect(viewer.update).toHaveBeenCalledTimes(1)
  })
})

describe('which way it lies', () => {
  it('lies along the plane`s normal in the world', () => {
    // The camera looks down -Z, so a plane whose normal is +X stands across the
    // view and the arrow with it.
    const { viewer, group } = scene()
    rendered(viewer)
    const [x, y, z] = along(group)
    expect(x).toBeCloseTo(1, 9)
    expect(y).toBeCloseTo(0, 9)
    expect(z).toBeCloseTo(0, 9)
  })

  it('turns with the plane and not with the camera', () => {
    // The one claim that was impossible to make when this was a div: the
    // direction is a fact about the WORLD. A camera rolled by 30 degrees leaves
    // it exactly where it was — the widget is turned by the projection, like
    // everything else in the scene, rather than by arithmetic of its own.
    const roll = Math.PI / 6
    const rolled = scene({
      camera: orthoCamera({
        right: [Math.cos(roll), Math.sin(roll), 0],
        up: [-Math.sin(roll), Math.cos(roll), 0],
        forward: [0, 0, -1],
      }),
    })
    const square = scene()
    rendered(rolled.viewer)
    rendered(square.viewer)

    expect(along(rolled.group)[0]).toBeCloseTo(1, 9)
    expect(along(rolled.group)).toEqual(along(square.group))
  })

  it('reads the plane the reader is looking straight at, the same way', () => {
    // The zone the DOM widget had a whole fallback for: the normal points at the
    // camera, its projection on the screen is a stub and `sectionAxis` declines.
    // There is nothing to decline here — the arrow is turned to the normal and
    // the camera sees it end-on, which is what an arrow pointing at the reader
    // looks like.
    const { viewer, vp, g, group } = scene({ normal: [0, 0, 1] })
    expect(sectionAxis(vp.viewer, g, [0, 0, 45]),
           'the premise: this is the zone sectionAxis declines').toBeNull()

    rendered(viewer)
    expect(shown(group)).toBe(true)
    expect(along(group)[2]).toBeCloseTo(-1, 9)
  })
})

describe('one whole drag', () => {
  it('moves the plane by the delta since the PREVIOUS event, and says so once', () => {
    const { viewer, vp, canvas } = scene()
    rendered(viewer)

    const press = grab(canvas)
    // The press is kept off the trackball and off tools.js's own listener, and
    // the compatibility mouse events with it.
    expect(press.stopImmediatePropagation).toHaveBeenCalled()
    expect(press.preventDefault).toHaveBeenCalled()

    pointerMove([440, 300])
    pointerMove([450, 330])

    expect(dragSection).toHaveBeenCalledTimes(2)
    expect(dragSection.mock.calls[0].slice(3)).toEqual([40, 0])
    expect(dragSection.mock.calls[1].slice(3)).toEqual([10, 30])
    // ONE axis for the whole gesture: the camera cannot move under a press this
    // one owns, and re-measuring per frame would let the plane drift.
    expect(dragSection.mock.calls[0][2]).toBe(dragSection.mock.calls[1][2])
    // Nothing is announced while the drag runs — the interface would re-render
    // on every frame of it.
    expect(details(vp, EVENT_FACE)).toEqual([])
    expect(vp.state.cutOffset).toBe(0)

    pointerUp([450, 330])

    // Once, at the end, through the same `reportCut` the canvas drag ends in —
    // so `state.cutOffset` and the number the interface prints have one writer.
    const faces = details(vp, EVENT_FACE)
    expect(faces).toHaveLength(1)
    expect(faces[0].id).toBe('/Group/wall')
    expect(faces[0].offset).toBe(vp.state.cutOffset)
    expect(vp.state.cutOffset).toBeCloseTo(sectionOffset(vp), 9)
    expect(Math.abs(vp.state.cutOffset)).toBeGreaterThan(0.5)

    // And the gesture really ended: the window listeners went with it, so a
    // pointer that moves on past the release moves no plane.
    pointerMove([600, 330])
    expect(dragSection).toHaveBeenCalledTimes(2)
  })

  it('ignores every button but the primary one', () => {
    // The right button is a gesture of its own here — it opens the part menu,
    // and the library pans on it. Taking the press would take both, and it is
    // now the grip's own answer that decides: a press the widget declines is
    // left entirely alone, so it reaches the canvas exactly as it would with no
    // grip on screen at all.
    const { viewer, vp, canvas } = scene()
    rendered(viewer)

    const press = grab(canvas, MIDDLE, 2)
    // Not even the refusals: a press this one does not want is a press it has
    // no business taking away from anybody else.
    expect(press.preventDefault).not.toHaveBeenCalled()
    expect(press.stopImmediatePropagation).not.toHaveBeenCalled()

    pointerMove([440, 300])
    expect(dragSection).not.toHaveBeenCalled()
    expect(details(vp, EVENT_FACE)).toEqual([])
  })

  it('says nothing when the press never moved', () => {
    // `reportCut` emits `hmr:face`, and the interface answers that by disarming
    // whatever tool is up — so a bare click on the arrow would silently put down
    // the measure or comment tool the reader was holding. The canvas drag has
    // always guarded this with `p.moved`; this is the same rule.
    const { viewer, vp, canvas } = scene()
    rendered(viewer)

    grab(canvas)
    pointerUp(MIDDLE)

    expect(details(vp, EVENT_FACE)).toEqual([])
    expect(dragSection).not.toHaveBeenCalled()
  })

  it('drags on the plane seen face-on, where there is no projected axis left', () => {
    // The gesture the widget's own geometry cannot give it. Looking straight down
    // the normal, the arrow is a disc and the screen direction it would be
    // dragged along has collapsed — so the press measures with
    // `sectionGripAxis`, whose vertical fallback turns 40 px DOWN into 2 world
    // units along the plane's own normal at this camera's 20 px per unit.
    const { viewer, vp, canvas } = scene({ normal: [0, 0, 1] })
    rendered(viewer)

    grab(canvas)
    pointerMove([400, 340])
    expect(dragSection).toHaveBeenCalledTimes(1)
    const axis = dragSection.mock.calls[0][2]
    expect(axis.sx).toBe(0)
    expect(axis.sy).toBeCloseTo(20, 9)
    // POSITIVE, i.e. down the screen pushes the plane along its own normal —
    // the convention `sectionGripAxis` fixes, since there is no projection left
    // to take it from.
    expect(sectionOffset(vp)).toBeCloseTo(2, 9)

    // Across the arrow is across the gesture: the least-squares projection of a
    // purely horizontal delta onto a vertical axis is zero.
    pointerMove([600, 340])
    expect(sectionOffset(vp)).toBeCloseTo(2, 9)
  })

  it('refuses a press on a scene that cannot be measured, and leaves it alone', () => {
    // A clip plane the library cannot hand back is not a plane the drag can be
    // measured against: `sectionGripAxis` declines and the grip answers `false`,
    // which hands the press straight back to the model. It used to swallow it
    // and do nothing, which is the one thing worse than either.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { viewer, vp, g, canvas } = scene()
    rendered(viewer)

    vp.viewer.getClipNormal = () => { throw new Error('plane gone') }
    expect(sectionGripAxis(vp.viewer, g, [0, 0, 45]),
           'the premise: this is a scene the axis cannot answer for').toBeNull()

    const press = grab(canvas)
    pointerMove([440, 300])
    expect(dragSection).not.toHaveBeenCalled()
    expect(press.stopImmediatePropagation).not.toHaveBeenCalled()
  })

  it('holds the grab cursor for the whole drag, and hands the canvas back', () => {
    // THE CANVAS IS THE LIBRARY'S ELEMENT, not ours, and the widget has none of
    // its own -- so where the DOM grip got both halves of this free (a
    // `grabbing` on its own div, cleared with the gesture), a mesh has to write
    // them by hand. What makes it more than a nicety is that the hand LEAVES the
    // grip: the target cylinder is 18 px across, and a few pixels of across-axis
    // travel carry the pointer off it while the drag is still running. A cursor
    // recomputed from the ray would say the gesture had ended.
    const { viewer, canvas } = scene()
    rendered(viewer)

    canvas.dispatchEvent(new MouseEvent('pointermove', {
      clientX: MIDDLE[0], clientY: MIDDLE[1], bubbles: true,
    }))
    expect(canvas.style.cursor).toBe('grab')

    grab(canvas)
    expect(canvas.style.cursor).toBe('grabbing')
    pointerMove([440, 300])
    expect(canvas.style.cursor, 'the hand is off the target by now').toBe('grabbing')

    pointerUp([440, 300])
    canvas.dispatchEvent(new MouseEvent('pointermove', {
      clientX: 700, clientY: 550, bubbles: true,
    }))
    expect(canvas.style.cursor).toBe('')
  })

  it('lets the cursor go when the scene is pulled out from under the hand', () => {
    // The same claim for the ending nobody makes: `endDrag` runs from `show()`,
    // with the reader's finger still down. A `grabbing` left behind would be a
    // grab cursor over the whole model for the rest of the page's life.
    const { viewer, canvas, handle } = scene()
    rendered(viewer)
    grab(canvas)
    expect(canvas.style.cursor).toBe('grabbing')

    handle.endDrag()
    canvas.dispatchEvent(new MouseEvent('pointermove', {
      clientX: 700, clientY: 550, bubbles: true,
    }))
    expect(canvas.style.cursor).toBe('')
  })

  it('lets the cursor go on a cancelled pointer too', () => {
    const { viewer, canvas } = scene()
    rendered(viewer)
    grab(canvas)
    expect(canvas.style.cursor).toBe('grabbing')

    pointerCancel()
    canvas.dispatchEvent(new MouseEvent('pointermove', {
      clientX: 700, clientY: 550, bubbles: true,
    }))
    expect(canvas.style.cursor).toBe('')
  })

  it('concludes a drag the scene is being pulled out from under', () => {
    // The twin of `vp.endGesture`, and the reason it is a second call rather
    // than the same one: the press was taken in a window listener of the grip's
    // own, so neither that gesture nor the idle clock that defers the swap ever
    // saw it. Ending it CONCLUDES rather than abandons — `restoreSection`
    // subtracts `state.cutOffset` from the captured point, so a stale one would
    // put the seed off the face that was clicked.
    const { viewer, vp, canvas, handle } = scene()
    rendered(viewer)

    grab(canvas)
    pointerMove([440, 300])
    expect(vp.state.cutOffset).toBe(0)

    handle.endDrag()

    const faces = details(vp, EVENT_FACE)
    expect(faces).toHaveLength(1)
    expect(vp.state.cutOffset).toBeCloseTo(sectionOffset(vp), 9)
    expect(Math.abs(vp.state.cutOffset)).toBeGreaterThan(0)

    // And it really ended, so the release that never came cannot report twice.
    pointerMove([500, 300])
    pointerUp([500, 300])
    expect(details(vp, EVENT_FACE)).toHaveLength(1)
  })

  it('lets go on a cancelled pointer, and says nothing about it', () => {
    // A capture-phase listener left on the window is the silent failure here:
    // the gesture would go on moving the plane from a pointer the browser has
    // already taken away — a touch turned into a scroll, a window that lost
    // focus mid-drag. Nothing is announced, because a cancelled gesture is not
    // a placement the reader made.
    const { viewer, vp, canvas } = scene()
    rendered(viewer)

    grab(canvas)
    pointerMove([440, 300])
    expect(dragSection).toHaveBeenCalledTimes(1)

    pointerCancel()
    expect(details(vp, EVENT_FACE)).toEqual([])

    pointerMove([500, 300])
    expect(dragSection).toHaveBeenCalledTimes(1)
  })

  it('stays under the hand while the drag runs, before anything is reported', () => {
    // The whole of what makes this a grip rather than a picture. The anchor
    // reads the PLANE every frame, so the arrow travels with it; an anchor
    // taken from `state.cutOffset` would stand still for the whole gesture and
    // jump at the release, because `reportCut` is the only writer of that field
    // and it runs on the way up.
    const { viewer, vp, canvas, group } = scene()
    rendered(viewer)
    expect(stands(group)[0]).toBe(0)

    grab(canvas)
    pointerMove([440, 300])
    rendered(viewer)

    // The field a naive anchor would read is still exactly zero at this point,
    // which is what makes the assertion below say something.
    expect(vp.state.cutOffset).toBe(0)
    const moved = sectionOffset(vp)
    // POSITIVE, i.e. the plane followed the hand: the normal is +X and the drag
    // went +40 px, which is to the right on this camera. Without the sign this
    // would still pass with a plane running away from the cursor.
    expect(moved).toBeGreaterThan(0)
    expect(stands(group)[0]).toBeCloseTo(moved, 9)
  })
})

// -- the rings -----------------------------------------------------------------
//
// THE ARITHMETIC IS NOT TAKEN FROM THE MODULE. With the default fixture — the
// plane's normal +X, the camera looking down -Z — the group is turned so that
// its local +Y is world +X, which puts local +X on world -Y and leaves local +Z
// on world +Z. So the second ring's axis is world +Z, square on to this camera:
// its circle is `HANDLE_RING_PX` about the middle of the canvas, its own `u` is
// world -Y (which this camera puts DOWN the screen) and its `v` is world +X (to
// the right). The first ring's axis is world -Y, which lies across the view, so
// that one is edge-on and off the screen.

/** Where that second ring carries the point of its own circle at angle `t`, in
 *  canvas pixels — `centre + R (u cos t + v sin t)`, projected by hand. A press
 *  there really lands on the ring, and sweeping `t` by `+pi/2` is a positive
 *  quarter turn about world +Z whatever the picture looks like. */
const onRing = (t, [cx, cy] = MIDDLE) =>
  [cx + HANDLE_RING_PX * Math.sin(t), cy + HANDLE_RING_PX * Math.cos(t)]

/** Where a press is taken on that circle: twenty degrees round from its own
 *  zero, and OFF the tessellation's seams.
 *
 * A torus is a grid of quads. A ray aimed exactly along one of its 64 vertex
 * rings meets only the edges two quads share, and `intersectTriangle` can
 * refuse both — which reads as "the widget declined the press" and would pass a
 * test of that whatever the code did. `t = 0` is the worst of them, being the
 * seam where the geometry closes, and it is exactly where a circle's own zero
 * puts a press. Twenty degrees is three and a half of those rings clear of one,
 * and fourteen pixels clear of the seam at the radius these are drawn at.
 */
const HELD_T = Math.PI / 9

/** A canvas pixel in the NDC a raycaster is set from. */
const ndcOf = ([x, y]) => new THREE.Vector2(
  (x / RECT.width) * 2 - 1, -((y / RECT.height) * 2 - 1))

/** Looking down world -Y, where the two rings of the same fixture trade places:
 *  the first ring's axis is world -Y and is now square on to the reader, and
 *  the second's is world +Z and lies across the view.
 *
 * `right x up = -forward`, which every camera in this suite keeps and which is
 * not decoration: `realCamera` writes the three straight onto a rotation
 * matrix (`makeBasis`), and a left-handed triple is not a rotation at all — the
 * quaternion three derives from one is nothing in particular, so the MODEL goes
 * on projecting correctly while every ray cast through the real camera lands
 * somewhere else entirely. */
const FROM_ABOVE = { eye: [0, 60, 45], right: [1, 0, 0], up: [0, 0, -1],
                     forward: [0, -1, 0] }

/** Where the FIRST ring carries the point of its own circle at angle `t` under
 *  that camera, in canvas pixels.
 *
 * Its axis is world -Y, its `u` is world +X — which this camera puts to the
 * RIGHT — and its `v` is world +Z, which it puts DOWN the screen, `up` being
 * -Z. So the circle is `HANDLE_RING_PX` about the middle of the canvas and `t`
 * runs from the right towards the bottom. Worked out here rather than read off
 * the module, exactly as `onRing` is. */
const onRingAbove = (t) => [MIDDLE[0] + HANDLE_RING_PX * Math.cos(t),
                            MIDDLE[1] + HANDLE_RING_PX * Math.sin(t)]

/** Looking mostly DOWN the plane's own normal, which is where the second ring's
 *  hit tube reaches in over the arrow.
 *
 * Four fifths along world +X — the normal, and the arrow with it — and three
 * fifths along +Z. So the arrow keeps three fifths of its 56 px on the screen,
 * while the ring about world +Z keeps `|axis . view| = 0.6` of itself: a minor
 * semi-axis of 25.2 px, comfortably over `RING_MIN_PX`, and still drawn. Its
 * hit tube is 9 px about a circle whose projection crosses the arrow's own line
 * 24.6 px out, so the tube reaches in to 15.6 px — over an arrow whose body
 * reaches out to 18. That overlap is the whole subject of the test below, and
 * it is the geometry `BANDS` in handle.js describes.
 */
const CROSSING = { eye: [-12, 0, 36], right: [0, 1, 0], up: [0.6, 0, -0.8],
                   forward: [0.8, 0, 0.6] }

/** Where the two cross on the canvas: 16 px down the screen from the centre,
 *  which is inside the arrow's casing and inside the ring's hit tube, and 2 px
 *  across it.
 *
 * ACROSS, AND NOT ON THE MIDDLE LINE, which is the torus's own spelling of the
 * trap `HELD_T` is written for. A ray aimed at x = 400 lies IN the plane of one
 * of the torus's 64 vertex rings, where it can only meet the edges two quads
 * share and `intersectTriangle` refuses both — the ring answers nothing at all
 * and the press reads as a slide whatever the code does. Two pixels puts it
 * halfway across a quad.
 */
const CROSS_AT = [MIDDLE[0] - 2, MIDDLE[1] + 16]

describe('which rings are on the screen', () => {
  it('takes the ring seen edge-on off it and leaves the other', () => {
    const { viewer, group } = scene()
    rendered(viewer)
    expect(ringNodes(group).map((node) => node.visible)).toEqual([false, true])
  })

  it('asks each ring`s OWN axis, and not the widget`s', () => {
    // The same cut from a camera a quarter turn away: the two swap, which is
    // the whole claim — the floor is `|axis . view|` per ring rather than one
    // answer about the group. Measured against `RING_MIN_PX`, whose argument
    // here is the hit tube: under it a ring stops being a hoop and becomes a
    // filled sliver taking presses meant for the arrow inside it.
    const { viewer, group } = scene({ camera: orthoCamera(FROM_ABOVE) })
    rendered(viewer)
    expect(ringNodes(group).map((node) => node.visible)).toEqual([true, false])
  })

  it('answers no ray at all while a ring is off the screen', () => {
    // `scene3d.js` casts its own ray for the CURSOR and knows nothing of this
    // widget's structure, so the floor has to be said on the hit mesh itself —
    // three's raycaster consults an object's LAYERS and never its visibility,
    // and a canvas wearing `grab` over a ring that is not drawn promises a grab
    // the press then refuses.
    //
    // LOOKING STRAIGHT DOWN THE NORMAL, where BOTH rings are edge-on: the arrow
    // is a disc and the rings are two lines crossing it. 30 px below the middle
    // is on the first ring's own circle — its hit tube really does lie under
    // that pixel — and clear of everything else in the group: the arrow's
    // target is an 18 px disc there, and the second ring is a horizontal line
    // through it.
    const { viewer, canvas, group } = scene({ normal: [0, 0, 1] })
    rendered(viewer)
    expect(ringNodes(group).map((node) => node.visible)).toEqual([false, false])

    const off = [400, 330]
    canvas.dispatchEvent(new MouseEvent('pointermove', {
      clientX: off[0], clientY: off[1], bubbles: true,
    }))
    expect(canvas.style.cursor).toBe('')
    expect(grab(canvas, off).stopImmediatePropagation).not.toHaveBeenCalled()

    // The premise: the widget is on the screen and the arrow still takes both.
    canvas.dispatchEvent(new MouseEvent('pointermove', {
      clientX: MIDDLE[0], clientY: MIDDLE[1], bubbles: true,
    }))
    expect(canvas.style.cursor).toBe('grab')
    expect(grab(canvas, MIDDLE).stopImmediatePropagation).toHaveBeenCalled()
    pointerUp(MIDDLE)
  })
})

describe('one whole turn', () => {
  it('tips the plane about the ring`s world axis, in whole degrees', () => {
    const { viewer, vp, canvas, group } = scene()
    rendered(viewer)
    viewer.setClipNormal.mockClear()

    const press = grab(canvas, onRing(HELD_T))
    expect(press.stopImmediatePropagation).toHaveBeenCalled()
    // 45.4 degrees round the circle, because a hand is not a number: what the
    // plane does is the whole degree, for the reason rings.js gives at its own
    // snap — the angle travels to an agent in a sentence.
    pointerMove(onRing(HELD_T + (45.4 * Math.PI) / 180))

    const half = Math.SQRT1_2
    isVector(vp.sectionSeed.normal, [half, half, 0])
    // ONE WRITE, carrying the normal AND the slider that belongs with it, which
    // is what `applySection` is the door for: a normal set without its value
    // parks the plane at the far edge of the grid, i.e. cuts the model away.
    expect(viewer.setClipNormal).toHaveBeenCalledTimes(1)
    expect(Number.isFinite(viewer.setClipNormal.mock.calls[0][2]),
           'the library reads a null value as `none given` and parks the plane '
           + 'at the far edge of the grid, which cuts the whole model away')
      .toBe(true)
    isVector(viewer.getClipNormal(SECTION_INDEX), [half, half, 0])
    // AND IT IS THE OTHER GESTURE'S DOOR THAT STAYS SHUT: a turn is not a slide
    // measured differently, and nothing here moves the plane along its normal.
    expect(dragSection).not.toHaveBeenCalled()

    rendered(viewer)
    isVector(along(group), [half, half, 0])
  })

  it('holds the ring the hand is on still in the world while it turns', () => {
    // WHAT THE READER SEES, and the one thing the composed orientation in
    // `place` buys: the ring under the finger does not move while the plane
    // turns inside it.
    //
    // NOT IN THE FIXTURE ABOVE, and this is the trap worth stating plainly.
    // `setFromUnitVectors` measures from world +Y, and re-deriving it per frame
    // leaves the twist about the normal free — but that twist is ZERO for a
    // ring whose axis is square across the reference, which is exactly the
    // second ring under the default camera. Written there this test passes with
    // the fix and without it. The ring it shows on is the one whose axis lies
    // ALONG world -Y: the FIRST of the two, which the camera from above shows
    // square on and which is therefore the one a ray can reach here.
    const { viewer, vp, canvas, group } = scene(
      { camera: orthoCamera(FROM_ABOVE) })
    rendered(viewer)
    const ring = ringNodes(group)[0]
    expect(ring.visible,
           'the premise: this is the ring on the screen here').toBe(true)
    const held = worldAxis(ring)
    isVector(held, [0, -1, 0])

    grab(canvas, onRingAbove(HELD_T))
    for (const degrees of [15, 45, 90]) {
      pointerMove(onRingAbove(HELD_T + (degrees * Math.PI) / 180))
      rendered(viewer)
      // Re-derived from the normal alone, this swings by the whole angle swept
      // so far: at 90 degrees the ring stood at world +X — edge-on, off the
      // screen, with the hand still on it.
      isVector(worldAxis(ring), held)
    }
    expect(ring.visible, 'and it is still there to hold').toBe(true)
    // AND THE PLANE WENT WHERE THE HAND ASKED, which is the half the composed
    // orientation must not have changed: +X turned a quarter turn about -Y.
    isVector(vp.sectionSeed.normal, [0, 0, 1])
    isVector(along(group), [0, 0, 1])
  })

  it('leaves the rings where the hand let go of them', () => {
    // THE FRAME AFTER THE RELEASE, which is the half of the composed pose that
    // does not live in the drag: with the gesture gone, an orientation derived
    // from the normal alone is free to pick any twist about it, so the pair
    // would snap round the arrow at the exact moment the hand came off — and
    // the ring the reader had hold of can fall under `RING_MIN_PX` and go off
    // the screen with it. The kept pose (`posed`) is what answers this frame.
    //
    // THE SAME CAMERA AND THE SAME RING as the test above, for the reason it
    // states: the free twist is ZERO for a ring whose axis stands square across
    // world +Y, so on the default fixture this would pass either way.
    const { viewer, vp, canvas, group } = scene(
      { camera: orthoCamera(FROM_ABOVE) })
    rendered(viewer)
    const ring = ringNodes(group)[0]
    const held = worldAxis(ring)
    isVector(held, [0, -1, 0])

    grab(canvas, onRingAbove(HELD_T))
    pointerMove(onRingAbove(HELD_T + Math.PI / 2))
    pointerUp(onRingAbove(HELD_T + Math.PI / 2))
    rendered(viewer)

    // THE PREMISE THAT MAKES THE TWO BELOW MEAN ANYTHING: the quarter turn
    // really landed, so the normal the pose would be re-derived from is a
    // different one from the normal it was first derived on.
    isVector(vp.sectionSeed.normal, [0, 0, 1])
    isVector(worldAxis(ring), held)
    expect(ring.visible, 'the ring the hand was on went off the screen')
      .toBe(true)
  })

  it('pivots about the plane, and not about the face the seed is on', () => {
    // With the plane slid out along its normal the two are different places,
    // and a pivot about the seed would swing the plane away from the hand AND
    // change the depth the interface prints — for a gesture that never touched
    // it. So the POINT moves to keep the anchor where it stands.
    const { viewer, vp, g, canvas, group } = scene()
    vp.state.cutOffset = 4
    applySection(vp, g)                       // what `reconcile` does first
    rendered(viewer)
    // 4 world units along +X is 80 px to the right on this camera, and that is
    // where the ring is now drawn.
    const at = [MIDDLE[0] + 80, MIDDLE[1]]
    expect(stands(group)).toEqual([4, 0, 45])

    grab(canvas, onRing(HELD_T, at))
    pointerMove(onRing(HELD_T + Math.PI / 2, at))

    isVector(vp.sectionSeed.normal, [0, 1, 0])
    expect(sectionOffset(vp)).toBeCloseTo(4, 9)
    // The seed has walked to keep the plane where it was: a quarter turn about
    // +Z with the plane 4 units out along +X leaves the face 4 units back along
    // the NEW normal.
    isVector(vp.sectionSeed.point, [4, -4, 45])
    rendered(viewer)
    isVector(stands(group), [4, 0, 45])
  })

  it('says where the plane ended up once, and stops naming the face', () => {
    // A turned plane no longer lies on the face it was placed from, and the
    // panel heads the cut with that face's name — so the fact travels out on
    // the report the grip's slide already uses. Once, at the end, because the
    // interface re-renders on every one of these.
    const { viewer, vp, canvas } = scene()
    rendered(viewer)

    grab(canvas, onRing(HELD_T))
    pointerMove(onRing(HELD_T + Math.PI / 4))
    pointerMove(onRing(HELD_T + Math.PI / 2))
    expect(details(vp, EVENT_FACE)).toEqual([])

    pointerUp(onRing(HELD_T + Math.PI / 2))
    const faces = details(vp, EVENT_FACE)
    expect(faces).toHaveLength(1)
    expect(faces[0].turned).toBe(true)
    isVector(faces[0].normal, [0, 1, 0])
    expect(faces[0].offset).toBe(vp.state.cutOffset)

    // AND A SLIDE AFTERWARDS DOES NOT BRING THE FACE BACK, which is why the
    // fact is kept on the SEED rather than carried out by the gesture that
    // noticed it: the plane is off that face for good, and the arrow's own
    // release reports through the very same door.
    grab(canvas, MIDDLE)
    pointerMove([400, 340])
    pointerUp([400, 340])
    expect(dragSection).toHaveBeenCalledTimes(1)
    expect(details(vp, EVENT_FACE)).toHaveLength(2)
    expect(details(vp, EVENT_FACE)[1].turned).toBe(true)
  })

  it('says nothing at all when the press never moved', () => {
    // The arrow's own rule, on the other gesture: `reportCut` emits `hmr:face`
    // and the interface answers by disarming whatever tool is up, so a bare
    // click on a ring would put down the measure or comment tool the reader was
    // holding — and a plane nobody turned must not be written to the library at
    // all.
    const { viewer, vp, canvas } = scene()
    rendered(viewer)
    viewer.setClipNormal.mockClear()

    const press = grab(canvas, onRing(HELD_T))
    expect(press.stopImmediatePropagation,
           'the premise: the ring really took this press').toHaveBeenCalled()
    pointerUp(onRing(HELD_T))

    expect(details(vp, EVENT_FACE)).toEqual([])
    expect(viewer.setClipNormal).not.toHaveBeenCalled()
  })

  it('comes back turned after a live reload, carrying nothing of its own', () => {
    // THE NORMAL FOR FREE AND THE FLAG BY HAND, which is the whole division of
    // labour here. `captureSection` reads the normal out of the LIBRARY, so a
    // turned plane is simply what it finds; `turned` is not in the library at
    // all and has to be carried across the swap on purpose. Lost there, the
    // next slide would announce the cut as untouched and the interface would go
    // back to labelling it with the face the reader has turned it away from.
    //
    // Nothing about a turn is written into `hmr:state` — the cut does not
    // survive a page reload today and this is not the place that changes it.
    const { viewer, vp, canvas } = scene()
    rendered(viewer)
    grab(canvas, onRing(HELD_T))
    pointerMove(onRing(HELD_T + Math.PI / 2))
    pointerUp(onRing(HELD_T + Math.PI / 2))

    const keep = captureSection(vp)
    isVector(keep.normal, [0, 1, 0])
    expect(keep.turned).toBe(true)
    // The swap: the seed dies with the scene it was measured on, and the
    // restore is what puts a plane back on the one that replaced it.
    vp.sectionSeed = null
    expect(restoreSection(vp, keep)).toBe(true)
    isVector(vp.sectionSeed.normal, [0, 1, 0])
    expect(vp.sectionSeed.turned).toBe(true)
    isVector(viewer.getClipNormal(SECTION_INDEX), [0, 1, 0])
  })

  it('gives a press where the two cross to the ARROW, not to the ring', () => {
    // WHAT IS DRAWN THERE IS WHAT TAKES THE PRESS, and the nearest hit is not
    // that: `BANDS` paints every band of a ring UNDER the arrow, so where the
    // ring's fat hit tube reaches in over the arrow's own body the reader is
    // aiming at the arrow while the ray meets the ring first. Left to the
    // nearest, a press on the arrow's visible ink turns the plane.
    const { viewer, vp, g, canvas, group } = scene(
      { camera: orthoCamera(CROSSING) })
    rendered(viewer)
    const ring = ringNodes(group)[1]
    expect(ring.visible,
           'the premise: this is the ring on the screen here').toBe(true)

    // THE PREMISES ARE CAST RATHER THAN TRUSTED, because both of them are
    // arithmetic about one pixel: the nearest thing under it is the ring's own
    // hit torus, and something the arrow DRAWS is under it too — here the white
    // casing over the lower head, which stands `renderOrder` -1 against the
    // ring's -4, -3 and -2.
    const caster = new THREE.Raycaster()
    group.updateMatrixWorld(true)
    caster.setFromCamera(ndcOf(CROSS_AT), g.cam)
    const hits = caster.intersectObject(group, true)
    const torus = ring.children.find((child) => !child.visible)
    expect(hits[0] && hits[0].object, 'the ring is not the nearest hit here')
      .toBe(torus)
    const drawn = arrowPieces(group).filter((child) => child.visible)
    expect(hits.some((hit) => drawn.includes(hit.object)),
           'the arrow draws nothing under this pixel').toBe(true)

    const press = grab(canvas, CROSS_AT)
    expect(press.stopImmediatePropagation).toHaveBeenCalled()
    pointerMove([CROSS_AT[0] + 40, CROSS_AT[1]])

    // A SLIDE AND NOT A TURN: the plane moved along its own normal and the
    // normal itself never budged.
    expect(dragSection).toHaveBeenCalledTimes(1)
    isVector(vp.sectionSeed.normal, [1, 0, 0])
    pointerUp([CROSS_AT[0] + 40, CROSS_AT[1]])
  })
})
