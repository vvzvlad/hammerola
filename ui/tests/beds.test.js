// ui/src/viewport/beds.js — the printer's beds under the `print` view.
//
// No GPU, as in pins.test.js: a bed is a mesh in a real three scene, so where
// it stands is read back off the scene, and the click that opens its menu is a
// real ray through a real `THREE.OrthographicCamera` at the pose of this
// directory's camera model (fakes.js). That camera looks down -Z and puts 20 px
// on a world unit, with the world origin at the middle of the 800 x 600 canvas:
// the world point (x, y) is under the pixel (400 + 20x, 300 - 20y).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'

import { createBeds, framedWithBeds } from '../src/viewport/beds.js'
import { RECT, rendered, stubFrames } from './component.js'
import { fakeViewer, fakeViewport, orthoCamera, realCamera } from './fakes.js'

const widgets = []

beforeEach(() => {
  stubFrames()
})

afterEach(() => {
  while (widgets.length) widgets.pop().destroy()
})

/** The `print` view's meta.json entry with two 8 x 6 beds: bed 1 round the
 *  origin, lying at z -3, and bed 2 round (12, 0) at z 4. */
const PRINT = {
  id: 'print', file: 'print.json',
  plates: { 1: 'print.3mf', 2: 'print-2.3mf' },
  bed: { size_mm: [8, 6], centres: { 2: [12, 0, 4], 1: [0, 0, -3] } },
}

/** A viewport with a scene, the beds of `entry` in it, and one frame drawn. */
function scene(entry) {
  const model = orthoCamera()
  realCamera(THREE, model)
  const viewer = fakeViewer({ camera: model, rect: RECT })
  const canvas = document.createElement('div')
  canvas.getBoundingClientRect = () => ({ ...RECT })
  viewer.canvas = canvas
  viewer.renderer.domElement = canvas
  viewer.scene = new THREE.Scene()
  const beds = createBeds(fakeViewport(viewer))
  widgets.push(beds)
  beds.setBeds(entry)
  beds.attach(THREE)
  rendered(viewer)
  const group = viewer.scene.children.find((child) => child.isGroup)
  return { beds, group, canvas }
}

/** A click at the world point (x, y), as `openMenu` hands it over. */
const over = (canvas, x, y) => ({ target: canvas, clientX: 400 + 20 * x, clientY: 300 - 20 * y })

describe('the printer\'s beds', () => {
  it('lie one per bed, as large as the printer\'s, centred where the build put them', () => {
    const { group } = scene(PRINT)
    const faces = group.children.filter((piece) => piece.isMesh)
    expect(faces.map((face) => face.position.toArray())).toEqual([[0, 0, -3], [12, 0, 4]])
    for (const face of faces) {
      face.geometry.computeBoundingBox()
      const size = new THREE.Vector3()
      face.geometry.boundingBox.getSize(size)
      expect(size.toArray()).toEqual([8, 6, 0])
    }
    // Each with its outline.
    expect(group.children.filter((piece) => piece.isLineSegments)).toHaveLength(2)
  })

  it('answer a click with the bed under it, and empty space with none', () => {
    const { beds, canvas } = scene(PRINT)
    expect(beds.bedAt(over(canvas, 1, 1))).toBe(1)
    expect(beds.bedAt(over(canvas, 13, -2))).toBe(2)
    expect(beds.bedAt(over(canvas, 6, 0))).toBeNull()
  })

  it('are not there for a view that names no printer', () => {
    const { beds, group, canvas } = scene({ id: 'print', file: 'print.json' })
    expect(group.children).toHaveLength(0)
    expect(beds.bedAt(over(canvas, 0, 0))).toBeNull()
  })

  it('are inside the box the camera is framed on, beside the parts', () => {
    // The parts: a 2 x 2 x 5 layout standing on bed 1.
    const box = { xmin: -1, xmax: 1, ymin: -1, ymax: 1, zmin: -3, zmax: 2 }
    const document = { name: 'Group', parts: [], bb: { ...box } }
    const framed = framedWithBeds(document, PRINT)
    expect(framed.bb).toEqual({ xmin: -4, xmax: 16, ymin: -3, ymax: 3, zmin: -3, zmax: 4 })
    expect(framed.parts).toBe(document.parts)
    // The document as fetched keeps the parts' box, and a view without beds
    // is framed on it as it is.
    expect(document.bb).toEqual(box)
    expect(framedWithBeds(document, { id: 'print', file: 'print.json' })).toBe(document)
  })
})
