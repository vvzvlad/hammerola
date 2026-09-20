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
  HANDLE_CASE_PX, HANDLE_HEAD_PX, HANDLE_HIT_PX, HANDLE_PX, HANDLE_SHAFT_PX,
} from '../src/viewport/options.js'
import { HANDLE_ORDER } from '../src/viewport/scene3d.js'
import {
  applySection, dragSection, placeSectionPlane, sectionAxis, sectionGripAxis,
  sectionOffset,
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
  return group.children.filter(
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
    const casing = group.children.filter(
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
    for (const child of group.children) {
      expect(child.material.transparent, child.geometry.type).toBe(true)
    }
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
