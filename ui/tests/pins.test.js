// ui/src/viewport/pins.js — the comments on the model, as red arrows standing
// in the library's scene.
//
// No GPU and nothing below looks at a pixel, as in handle.test.js: an arrow is
// a node of meshes in a real three scene, so where it stands is read back as
// world points, and a press is a real ray through a real
// `THREE.OrthographicCamera` at the pose of this directory's camera model
// (fakes.js). A frame is the library drawing one, `rendered(viewer)`.
//
// The camera looks down -Z from z = 60 and puts 20 px on a world unit (800 px
// across 40 world units), so the point [0, 0, 45] projects to the middle of the
// canvas, (400, 300), and one world unit along +X is 20 px to the right.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'

// The cut face's owner, which needs a standing section to answer; what it does
// with one is tools.test.js's subject. Null, as with no cut, unless a case says.
vi.mock('../src/viewport/picking.js', async (importOriginal) => ({
  ...(await importOriginal()),
  capOwnerAt: vi.fn(() => null),
}))

import { EVENT_PIN } from '../src/viewport/events.js'
import { capOwnerAt } from '../src/viewport/picking.js'
import {
  PIN_CASE_PX, PIN_HEAD_WIDTH_PX, PIN_LENGTH_FRACTION, PIN_PX,
} from '../src/viewport/options.js'
import { createPins, pinDirection } from '../src/viewport/pins.js'
import { PINS_ORDER, RINGS_ORDER } from '../src/viewport/scene3d.js'
import { RECT, framesAsked, rendered, stubFrames } from './component.js'
import { fakeGroup, fakeViewer, fakeViewport, orthoCamera, realCamera } from './fakes.js'

const widgets = []

beforeEach(() => {
  vi.clearAllMocks()
  stubFrames()
})

afterEach(() => {
  // Before the next test dispatches on the window: arrows left standing would
  // leave a dead viewport's capture-phase listeners there to answer for it.
  while (widgets.length) widgets.pop().destroy()
  expect(framesAsked(), 'the arrows ask for no animation frames').toBe(0)
  vi.unstubAllGlobals()
})

/** World units per CSS pixel on this camera: 30 world units over 600 px. */
const K = 30 / 600

/** The bounding box the hub publishes with a view (`payload.bb`), which is what
 *  an arrow's length is a fraction of. This one spans 60 x 0 x 80, so
 *  `hypot(60, 0, 80) / 2` is a half-diagonal of 50 world units. */
const BB = { xmin: -30, xmax: 30, ymin: 0, ymax: 0, zmin: 5, zmax: 85 }
const BB_HALF = 50

/** How long an arrow standing on that model is, in world units. */
const LENGTH = PIN_LENGTH_FRACTION * BB_HALF

/**
 * A viewport with a scene, and the arrows for `pins` standing in it, the way
 * `reconcile` and `show()` get them there: the list first, the scene after.
 *
 * `payload` is the fetched view document the element keeps, the one place the
 * model's own size is written down; the default is the box above.
 *
 * The canvas is a real node because the press is read in a capture-phase
 * listener on the window that declines any target but the canvas.
 *
 * The library's GPU picker answers the background — no part under any pixel —
 * until a test stands a part there (`picks`).
 */
function scene(pins, payload = { bb: BB }) {
  const model = orthoCamera()
  realCamera(THREE, model)
  const viewer = fakeViewer({ camera: model, rect: RECT })
  viewer.idPicker.pickAt = vi.fn(() => null)
  const canvas = document.createElement('div')
  canvas.getBoundingClientRect = () => ({ ...RECT })
  document.body.appendChild(canvas)
  viewer.canvas = canvas
  viewer.renderer.domElement = canvas
  viewer.scene = new THREE.Scene()
  const vp = fakeViewport(viewer)
  vp.payload = payload
  vp.dispatchEvent = vi.fn()
  const arrows = createPins(vp)
  widgets.push(arrows)
  arrows.setPins(pins)
  arrows.attach(THREE)
  const group = viewer.scene.children.find((child) => child.isGroup)
  return { model, viewer, vp, canvas, arrows, group }
}

/** Where a point of one arrow's own frame (pin units, +Y from the tip along
 *  the body) is in the world after the last frame. */
function world(group, node, local) {
  group.updateMatrixWorld(true)
  return node.localToWorld(new THREE.Vector3(...local)).toArray()
}

/** How long one arrow is IN THE WORLD after the last frame: how far its tail
 *  stands from its tip, through every scale between it and the scene. */
function length(group, node) {
  const tip = world(group, node, [0, 0, 0])
  const tail = world(group, node, [0, PIN_PX, 0])
  return Math.hypot(tail[0] - tip[0], tail[1] - tip[1], tail[2] - tip[2])
}

function isPoint(actual, expected) {
  expected.forEach((v, at) => expect(actual[at]).toBeCloseTo(v, 9))
}

/**
 * Stand the solid at `path` under every pixel, `opacity` on its face material,
 * with the library's GPU picker answering `point` on it — in the shape
 * `IdPicker.pickAt` answers (viewer/src/rendering/id-picking.ts): the registry's
 * entry for a face inside the solid, and the world point off the position
 * attachment.
 */
function picks(viewer, path, point, opacity) {
  const solid = fakeGroup()
  solid.front.material.opacity = opacity
  viewer.nestedGroup.groups[path] = solid
  viewer.idPicker.pickAt = vi.fn(() => ({
    id: 7,
    info: { id: 7, path: `${path}/faces/faces_0`, name: 'faces_0', topo: 'face',
            subtype: 'solid', solidPath: path },
    point: new THREE.Vector3(...point),
  }))
}

/** A press on the canvas, with both refusals watched. */
function press(canvas, [clientX, clientY], button = 0) {
  const event = new MouseEvent('pointerdown', {
    button, clientX, clientY, bubbles: true, cancelable: true,
  })
  vi.spyOn(event, 'stopImmediatePropagation')
  canvas.dispatchEvent(event)
  return event
}

/** What every `hmr:pin` carried, in order. */
const opened = (vp) => vp.dispatchEvent.mock.calls
  .map(([event]) => event)
  .filter((event) => event.type === EVENT_PIN)
  .map((event) => event.detail)

describe('which way an arrow stands', () => {
  it('is the normal made unit, and straight down from above where there is none', () => {
    // Null is every comment left before normals were stored, and every one
    // hanging at a part's centre on another build: those come from +Z, the
    // viewer's up axis.
    expect(pinDirection([0, 3, 4])).toEqual([0, 0.6, 0.8])
    for (const missing of [null, undefined, [0, 0, 0], [Number.NaN, 0, 1], [1, 2]]) {
      expect(pinDirection(missing), String(missing)).toEqual([0, 0, 1])
    }
  })
})

describe('where an arrow stands', () => {
  it('is drawn tip first: a point at the origin of its frame, the body along +Y', () => {
    // The geometry is built so the node's origin IS the tip, which is what
    // makes "put the node on the point" mean "the arrow touches the point".
    const { group } = scene([{ id: 'c1', p: [0, 0, 45] }])
    const [node] = group.children
    const white = (mesh) => mesh.material.color.getHex() === 0xffffff
    const bounds = (meshes) => {
      const box = new THREE.Box3()
      for (const mesh of meshes) {
        mesh.geometry.computeBoundingBox()
        box.union(mesh.geometry.boundingBox)
      }
      return box
    }
    const ink = bounds(node.children.filter((mesh) => !white(mesh)))
    expect(ink.min.y).toBeCloseTo(0, 9)
    expect(ink.max.y).toBeCloseTo(PIN_PX, 9)
    expect(ink.max.x).toBeCloseTo(PIN_HEAD_WIDTH_PX / 2, 9)
    // The white casing stands PIN_CASE_PX out of the ink all round, the tip and
    // the tail included.
    const rim = bounds(node.children.filter(white))
    expect(rim.min.y).toBeCloseTo(-PIN_CASE_PX, 9)
    expect(rim.max.y).toBeCloseTo(PIN_PX + PIN_CASE_PX, 9)
    expect(rim.max.x).toBeCloseTo(PIN_HEAD_WIDTH_PX / 2 + PIN_CASE_PX, 9)
    const head = node.children.find(
      (mesh) => mesh.geometry.type === 'ConeGeometry' && !white(mesh))
    const at = head.geometry.getAttribute('position')
    for (let i = 0; i < at.count; i += 1) {
      if (Math.abs(at.getY(i)) > 1e-9) continue
      expect(Math.hypot(at.getX(i), at.getZ(i)), 'the tip is a point').toBeCloseTo(0, 9)
    }
  })

  it('touches the point, its body out along the normal, as long as the model says', () => {
    const { group } = scene([
      { id: 'side', p: [1, 2, 45], n: [-2, 0, 0] },
      { id: 'old', p: [3, 4, 45], n: null },
    ])
    const [side, old] = group.children
    isPoint(world(group, side, [0, 0, 0]), [1, 2, 45])
    isPoint(world(group, side, [0, PIN_PX, 0]), [1 - LENGTH, 2, 45])
    isPoint(world(group, old, [0, 0, 0]), [3, 4, 45])
    isPoint(world(group, old, [0, PIN_PX, 0]), [3, 4, 45 + LENGTH])
  })

  it('is as long as the model is big, and the zoom does not touch it', () => {
    // The whole of "an object in the scene and not a sticker over the picture":
    // the length is a fraction of the model's half-diagonal, so a bigger model
    // carries a bigger arrow and zooming in grows the arrow on the screen along
    // with the part it points into.
    const near = scene([{ id: 'c1', p: [1, 2, 45], n: [0, 0, 1] }])
    expect(length(near.group, near.group.children[0])).toBeCloseTo(LENGTH, 9)

    // Twice the box across the diagonal, twice the arrow.
    const big = scene([{ id: 'c1', p: [1, 2, 45], n: [0, 0, 1] }],
                      { bb: { xmin: -60, xmax: 60, ymin: 0, ymax: 0, zmin: 5, zmax: 165 } })
    expect(length(big.group, big.group.children[0])).toBeCloseTo(2 * LENGTH, 9)

    // The camera is what a screen widget follows: at zoom 2 a pixel is half as
    // many world units. The arrow does not move at all. The real camera is what
    // `g.cam` answers with here (`realCamera`), and its frustum is what the
    // pixel scale is read off.
    near.model.zoom = 2
    near.model.cam.zoom = 2
    rendered(near.viewer)
    const [node] = near.group.children
    expect(length(near.group, node)).toBeCloseTo(LENGTH, 9)
    isPoint(world(near.group, node, [0, 0, 0]), [1, 2, 45])
  })

  it('falls back to its old on-screen size where the view carries no box', () => {
    // A view that answers with no usable box would otherwise leave an arrow of
    // length zero; `PIN_PX * k` is exactly the size it had while it was
    // measured in pixels.
    for (const payload of [
      null,
      {},
      { bb: { xmin: 0, xmax: 1, ymin: 0, ymax: 1 } },
      { bb: { xmin: 0, xmax: 0, ymin: 0, ymax: 0, zmin: 0, zmax: 0 } },
      { bb: { xmin: 0, xmax: Number.NaN, ymin: 0, ymax: 1, zmin: 0, zmax: 1 } },
    ]) {
      const { group } = scene([{ id: 'c1', p: [0, 0, 45], n: [0, 0, 1] }], payload)
      expect(length(group, group.children[0]), String(payload && payload.bb))
        .toBeCloseTo(PIN_PX * K, 9)
    }

    // And it IS the screen size: at zoom 2 a pixel is half the world, so the
    // fallback arrow is half as long.
    const { model, viewer, group } = scene(
      [{ id: 'c1', p: [0, 0, 45], n: [0, 0, 1] }], null)
    model.zoom = 2
    model.cam.zoom = 2
    rendered(viewer)
    expect(length(group, group.children[0])).toBeCloseTo((PIN_PX * K) / 2, 9)
  })

  it('follows the list: new comments get an arrow, gone ones lose theirs', () => {
    const { viewer, arrows, group } = scene([
      { id: 'a', p: [0, 0, 45] }, { id: 'b', p: [1, 0, 45] },
    ])
    const kept = group.children[1]
    arrows.setPins([{ id: 'b', p: [1, 0, 45] }, { id: 'c', p: [2, 0, 45] }])
    expect(group.children).toHaveLength(2)
    expect(group.children[0], 'the same arrow for the same comment').toBe(kept)

    arrows.setPins([])
    expect(group.children).toHaveLength(0)
    expect(group.visible, 'and the frame setPins asked for took it off').toBe(false)
    expect(viewer.scene.children).toContain(group)
  })

  it('asks for a frame only when an arrow changed', () => {
    // The list arrives on every push — every tree click, every section-slider
    // step — and a frame is a render of the whole scene. The page mints new
    // arrays each time, so "unchanged" has to be by value.
    const a = { id: 'a', p: [0, 0, 45], n: [1, 0, 0] }
    const b = { id: 'b', p: [1, 0, 45] }
    const { viewer, arrows } = scene([a])
    viewer.update.mockClear()
    arrows.setPins([{ ...a, p: [0, 0, 45], n: [1, 0, 0] }])
    expect(viewer.update, 'the same list again').not.toHaveBeenCalled()

    for (const [what, next] of [
      ['a moved point', [{ ...a, p: [0, 0, 46] }]],
      ['a turned normal', [{ ...a, p: [0, 0, 46], n: [0, 1, 0] }]],
      ['an opened comment', [{ ...a, p: [0, 0, 46], n: [0, 1, 0], active: true }]],
      ['an added arrow', [{ ...a, p: [0, 0, 46], n: [0, 1, 0], active: true }, b]],
      ['a removed arrow', [b]],
    ]) {
      viewer.update.mockClear()
      arrows.setPins(next)
      expect(viewer.update, what).toHaveBeenCalledTimes(1)
    }
  })
})

describe('the open comment', () => {
  it('is darker and drawn over the others, in the bottom band of all', () => {
    // Two comments on one part resolve to one anchor, so their arrows are the
    // same shape at the same depth, where the depth test passes and the last
    // drawn is on top; the open one is drawn last. The band under the rings
    // keeps every control standing over an arrow above it.
    const { group } = scene([
      { id: 'a', p: [0, 0, 45] }, { id: 'b', p: [0, 0, 45], active: true },
    ])
    const [shut, open] = group.children
    const luminance = (node) => {
      const { r, g, b } = node.children[0].material.color
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    expect(luminance(open)).toBeLessThan(luminance(shut))
    // Every piece of the open arrow, its white rim included, over every piece
    // of the other; and in each arrow the rim under the ink.
    const orders = (node) => node.children.map((mesh) => mesh.renderOrder)
    expect(Math.min(...orders(open))).toBeGreaterThan(Math.max(...orders(shut)))
    for (const node of [shut, open]) {
      const rims = node.children.filter((m) => m.material.color.getHex() === 0xffffff)
      const inks = node.children.filter((m) => m.material.color.getHex() !== 0xffffff)
      expect(rims).toHaveLength(2)
      expect(Math.max(...rims.map((m) => m.renderOrder)))
        .toBeLessThan(Math.min(...inks.map((m) => m.renderOrder)))
    }
    expect(group.renderOrder).toBe(PINS_ORDER)
    expect(PINS_ORDER).toBeLessThan(RINGS_ORDER)
  })
})

describe('what an arrow is made of', () => {
  it('is depth-tested, and the casing shows only its far side', () => {
    // Depth-tested, or the arrow is painted over the glass and over the wall it
    // is standing inside — the sticker the owner refused. The casing is the
    // arrow grown all round, so it ENCLOSES the ink: drawn whole it would cover
    // the ink and the arrow would come out white, and back faces only leaves it
    // showing as the white rim around the silhouette (SPEC §4).
    const { group } = scene([{ id: 'c1', p: [0, 0, 45], n: [0, 0, 1] }])
    const [node] = group.children
    const white = (mesh) => mesh.material.color.getHex() === 0xffffff
    const casings = node.children.filter(white)
    const inks = node.children.filter((mesh) => !white(mesh))
    expect(casings).toHaveLength(2)
    expect(inks).toHaveLength(2)
    for (const mesh of [...casings, ...inks]) {
      expect(mesh.material.depthTest).toBe(true)
      expect(mesh.material.depthWrite).toBe(true)
      expect(mesh.material.transparent).toBe(false)
    }
    for (const mesh of casings) expect(mesh.material.side).toBe(THREE.BackSide)
    for (const mesh of inks) expect(mesh.material.side).not.toBe(THREE.BackSide)
  })
})

describe('a press on an arrow', () => {
  // Along +X the arrow runs right from the middle of the canvas, so 6 px right
  // of it is on the head.
  const ON_HEAD = [406, 300]

  it('says which comment it is, and takes the press from the model', () => {
    const { vp, canvas } = scene([{ id: 'c1', p: [0, 0, 45], n: [1, 0, 0] }])
    const event = press(canvas, ON_HEAD)
    expect(opened(vp)).toEqual([{ id: 'c1' }])
    expect(event.stopImmediatePropagation).toHaveBeenCalled()
  })

  it('leaves every button but the primary one to the model', () => {
    const { vp, canvas } = scene([{ id: 'c1', p: [0, 0, 45], n: [1, 0, 0] }])
    const event = press(canvas, ON_HEAD, 2)
    expect(opened(vp)).toEqual([])
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
  })

  it('goes to the open arrow where two stand on one point, the draft included', () => {
    const { vp, canvas, arrows } = scene([
      { id: 'c1', p: [0, 0, 45], n: [1, 0, 0] },
      { id: 'c2', p: [0, 0, 45], n: [1, 0, 0], active: true },
    ])
    press(canvas, ON_HEAD)
    arrows.setPins([
      { id: 'c1', p: [0, 0, 45], n: [1, 0, 0], active: true },
      { id: 'c2', p: [0, 0, 45], n: [1, 0, 0] },
    ])
    press(canvas, ON_HEAD)
    arrows.setPins([
      { id: 'c1', p: [0, 0, 45], n: [1, 0, 0] },
      { id: 'draft', p: [0, 0, 45], n: [1, 0, 0], active: true },
    ])
    press(canvas, ON_HEAD)
    expect(opened(vp)).toEqual([{ id: 'c2' }, { id: 'c1' }, { id: 'draft' }])
  })

  it('goes to the nearer arrow where two overlap, even with the open one behind', () => {
    // Under the depth test the arrow on top is the nearer one, so that is the
    // one the reader pressed; the open one wins only where the two coincide
    // (above). The camera looks down -Z, so z = 50 is in front of z = 40.
    const { vp, canvas } = scene([
      { id: 'near', p: [0, 0, 50], n: [1, 0, 0] },
      { id: 'far', p: [0, 0, 40], n: [1, 0, 0], active: true },
    ])
    press(canvas, ON_HEAD)
    expect(opened(vp)).toEqual([{ id: 'near' }])
  })

  it('leaves the press to the model where an opaque part stands in front of the arrow', () => {
    // The ray meets only arrows, so without asking the picker a click on a
    // wall would open the comment standing behind it. Glass does not hide an
    // arrow, which shows through it, and a part behind the arrow does not
    // either. The arrow's head is at z = 45, 15 in front of the camera.
    for (const [what, point, opacity, taken] of [
      ['an opaque part in front', [0.3, 0, 50], 1, false],
      ['a translucent part in front', [0.3, 0, 50], 0.5, true],
      ['an opaque part behind', [0.3, 0, 40], 1, true],
    ]) {
      const { vp, viewer, canvas } = scene([{ id: 'c1', p: [0, 0, 45], n: [1, 0, 0] }])
      picks(viewer, '/model/wall', point, opacity)
      const event = press(canvas, ON_HEAD)
      // At the canvas pixel of the press, as the tools pick (`canvasXY`).
      expect(viewer.idPicker.pickAt, what).toHaveBeenCalledWith(...ON_HEAD, {})
      expect(opened(vp), what).toEqual(taken ? [{ id: 'c1' }] : [])
      expect(event.stopImmediatePropagation.mock.calls.length > 0, what).toBe(taken)
    }
  })

  it('leaves the press to the model where a cut face stands in front of the arrow', () => {
    // The picker reads through the stencil cap (it answers nothing here), and
    // the cap is opaque: its owner's point on the cut plane is what hides the
    // arrow at that pixel.
    const { vp, viewer, canvas } = scene([{ id: 'c1', p: [0, 0, 45], n: [1, 0, 0] }])
    viewer.nestedGroup.groups['/model/wall'] = fakeGroup()
    capOwnerAt.mockImplementationOnce(() => ({
      id: '/model/wall', name: 'wall', path: '/model/wall', topo: 'face', point: [0.3, 0, 50],
    }))
    const event = press(canvas, ON_HEAD)
    expect(capOwnerAt).toHaveBeenCalledTimes(1)
    expect(capOwnerAt.mock.calls[0][0]).toBe(vp)
    expect(opened(vp)).toEqual([])
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
  })
})
