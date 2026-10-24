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

import { EVENT_PIN } from '../src/viewport/events.js'
import {
  PIN_CASE_PX, PIN_HEAD_WIDTH_PX, PIN_PX,
} from '../src/viewport/options.js'
import { createPins, pinDirection } from '../src/viewport/pins.js'
import { PINS_ORDER, RINGS_ORDER } from '../src/viewport/scene3d.js'
import { RECT, framesAsked, rendered, stubFrames } from './component.js'
import { fakeViewer, fakeViewport, orthoCamera, realCamera } from './fakes.js'

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

/**
 * A viewport with a scene, and the arrows for `pins` standing in it, the way
 * `reconcile` and `show()` get them there: the list first, the scene after.
 *
 * The canvas is a real node because the press is read in a capture-phase
 * listener on the window that declines any target but the canvas.
 */
function scene(pins) {
  const model = orthoCamera()
  realCamera(THREE, model)
  const viewer = fakeViewer({ camera: model, rect: RECT })
  const canvas = document.createElement('div')
  canvas.getBoundingClientRect = () => ({ ...RECT })
  document.body.appendChild(canvas)
  viewer.canvas = canvas
  viewer.renderer.domElement = canvas
  viewer.scene = new THREE.Scene()
  const vp = fakeViewport(viewer)
  vp.dispatchEvent = vi.fn()
  const arrows = createPins(vp)
  widgets.push(arrows)
  arrows.setPins(pins)
  arrows.attach(THREE)
  const group = viewer.scene.children.find((child) => child.isGroup)
  return { model, viewer, vp, canvas, arrows, group }
}

/** Where a point of one arrow's own frame (CSS pixels, +Y from the tip along
 *  the body) is in the world after the last frame. */
function world(group, node, local) {
  group.updateMatrixWorld(true)
  return node.localToWorld(new THREE.Vector3(...local)).toArray()
}

function isPoint(actual, expected) {
  expected.forEach((v, at) => expect(actual[at]).toBeCloseTo(v, 9))
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

  it('touches the point, its body out along the normal, PIN_PX pixels long', () => {
    const { group } = scene([
      { id: 'side', p: [1, 2, 45], n: [-2, 0, 0] },
      { id: 'old', p: [3, 4, 45], n: null },
    ])
    const [side, old] = group.children
    isPoint(world(group, side, [0, 0, 0]), [1, 2, 45])
    isPoint(world(group, side, [0, PIN_PX, 0]), [1 - PIN_PX * K, 2, 45])
    isPoint(world(group, old, [0, 0, 0]), [3, 4, 45])
    isPoint(world(group, old, [0, PIN_PX, 0]), [3, 4, 45 + PIN_PX * K])
  })

  it('keeps the tip on the point when the zoom changes the pixel scale', () => {
    // `scene3d.js` scales the one group by world units per pixel AFTER `place`,
    // so an arrow standing at a world point of its own has to divide that scale
    // out on every frame; one that did not would slide towards the origin as the
    // reader zoomed in.
    const { model, viewer, group } = scene([{ id: 'c1', p: [1, 2, 45], n: [0, 0, 1] }])
    // The real camera is what `g.cam` answers with here (`realCamera`), and its
    // frustum is what the scale is read off.
    model.zoom = 2
    model.cam.zoom = 2
    rendered(viewer)
    const [node] = group.children
    isPoint(world(group, node, [0, 0, 0]), [1, 2, 45])
    isPoint(world(group, node, [0, PIN_PX, 0]), [1, 2, 45 + (PIN_PX * K) / 2])
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
    // Two comments on one part resolve to one anchor, so their arrows stand on
    // each other; with no depth test the last drawn is on top, and the open one
    // is drawn last. The band under the rings keeps every control standing over
    // an arrow above it.
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
})
