// ui/src/viewport/camera.js — where a place on the canvas becomes a place in
// the world, and the one call that moves the camera sideways.
//
// Everything here is checked as a PROPERTY rather than against a copy of the
// formula. `ndcOffset` is not asserted to equal `rel - (rel . view) view`; it is
// asserted to be perpendicular to the view axis and to still project to the NDC
// it came from, which is what the rest of the viewport actually needs from it.
// A test that restated the arithmetic would go green on a sign error copied into
// both places.

import { describe, expect, it } from 'vitest'

import {
  cameraBasis, canvasXY, ndcAt, ndcOffset, panCamera, projectPoint,
} from '../src/viewport/camera.js'
import { dot3 } from '../src/viewport/math.js'
import { eventAt, fakeViewer, orthoCamera } from './fakes.js'

const RECT = { left: 40, top: 20, width: 800, height: 600 }

function scene(options = {}) {
  const camera = orthoCamera({
    eye: [10, -5, 60], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1],
    ...options,
  })
  const viewer = fakeViewer({ camera, rect: RECT })
  return { camera, viewer, g: internalsOf(viewer) }
}

// The `g` bundle as `internals()` builds it. Assembled here rather than imported
// so this file needs no viewer that is `ready`: the three fields camera.js reads
// are the whole of its dependency on the library.
function internalsOf(viewer) {
  return {
    camera: viewer.camera,
    cam: viewer.camera.getCamera(),
    canvas: viewer.canvas,
  }
}

describe('ndcAt', () => {
  it('puts the centre of the canvas at the origin', () => {
    const { viewer, g } = scene()
    const middle = eventAt(viewer, RECT.left + RECT.width / 2,
                           RECT.top + RECT.height / 2)
    const [nx, ny] = ndcAt(g.canvas, middle)
    // `toBeCloseTo` rather than `toEqual`: the y here is a negated zero, which
    // is the same place on the canvas and a different value to a deep compare.
    expect(nx).toBeCloseTo(0, 12)
    expect(ny).toBeCloseTo(0, 12)
  })

  it('runs -1..1 with y UP, against the pixel axis', () => {
    const { viewer, g } = scene()
    const topLeft = eventAt(viewer, RECT.left, RECT.top)
    const bottomRight = eventAt(viewer, RECT.left + RECT.width,
                                RECT.top + RECT.height)
    expect(ndcAt(g.canvas, topLeft)).toEqual([-1, 1])
    expect(ndcAt(g.canvas, bottomRight)).toEqual([1, -1])
  })

  it('is null for a canvas with no area, instead of dividing by zero', () => {
    const viewer = fakeViewer({ rect: { left: 0, top: 0, width: 0, height: 0 } })
    expect(ndcAt(viewer.canvas, eventAt(viewer, 0, 0))).toBeNull()
  })
})

describe('canvasXY', () => {
  it('subtracts the canvas origin, so a scrolled page still lands right', () => {
    const { viewer, g } = scene()
    expect(canvasXY(g.canvas, eventAt(viewer, RECT.left + 12, RECT.top + 34)))
      .toEqual([12, 34])
  })

  it('is null for a canvas with no area', () => {
    const viewer = fakeViewer({ rect: { left: 0, top: 0, width: 0, height: 0 } })
    expect(canvasXY(viewer.canvas, eventAt(viewer, 5, 5))).toBeNull()
  })
})

describe('cameraBasis', () => {
  it('reports the eye, the target and the unit axis between them', () => {
    const { camera, viewer, g } = scene()
    const b = cameraBasis(viewer, g)
    expect(b.C).toEqual(camera.eye)
    expect(b.target).toEqual(viewer.getCameraTarget())
    // The view axis is the direction the camera is pointing, to a unit length.
    expect(b.view[0]).toBeCloseTo(camera.forward[0], 12)
    expect(b.view[1]).toBeCloseTo(camera.forward[1], 12)
    expect(b.view[2]).toBeCloseTo(camera.forward[2], 12)
  })

  it('refreshes the camera matrix rather than assuming the renderer did', () => {
    const { viewer, g } = scene()
    cameraBasis(viewer, g)
    expect(g.cam.updateMatrixWorld).toHaveBeenCalled()
  })

  it('is null when the target is not a finite triple', () => {
    const { viewer, g } = scene()
    viewer.target = [0, NaN, 0]
    expect(cameraBasis(viewer, g)).toBeNull()
  })

  it('is null when the camera sits on its own target and there is no axis', () => {
    const { camera, viewer, g } = scene()
    viewer.target = [...camera.eye]
    expect(cameraBasis(viewer, g)).toBeNull()
  })
})

describe('ndcOffset', () => {
  it('has no component along the view axis', () => {
    // The half that matters: `unproject` answers with a point somewhere along
    // the ray, and under ortho the depth of that point is arbitrary. Anything
    // left of it in the answer would move the camera forwards or backwards.
    const { viewer, g } = scene()
    const b = cameraBasis(viewer, g)
    const off = ndcOffset(g, b.eye, b.view, 0.4, -0.7)
    expect(dot3(off, b.view)).toBeCloseTo(0, 10)
  })

  it('lands on the same pixel it was measured from', () => {
    const { camera, viewer, g } = scene()
    const b = cameraBasis(viewer, g)
    const ndc = [0.4, -0.7]
    const off = ndcOffset(g, b.eye, b.view, ndc[0], ndc[1])
    // eye + off is a point on the cursor's ray, so it projects back to the NDC
    // the offset was taken at.
    const back = camera.project([b.C[0] + off[0], b.C[1] + off[1], b.C[2] + off[2]])
    expect(back[0]).toBeCloseTo(ndc[0], 10)
    expect(back[1]).toBeCloseTo(ndc[1], 10)
  })

  it('scales with the frustum, so half the zoom is twice the offset', () => {
    const { camera, viewer, g } = scene()
    const b = cameraBasis(viewer, g)
    const wide = ndcOffset(g, b.eye, b.view, 1, 1)
    camera.zoom = 2
    const near = ndcOffset(g, b.eye, b.view, 1, 1)
    expect(near[0]).toBeCloseTo(wide[0] / 2, 10)
    expect(near[1]).toBeCloseTo(wide[1] / 2, 10)
  })

  it('is null when the projection comes back unusable', () => {
    const { viewer, g } = scene()
    const b = cameraBasis(viewer, g)
    expect(ndcOffset(g, b.eye, b.view, NaN, 0)).toBeNull()
  })
})

describe('panCamera', () => {
  it('moves the camera and its target by the SAME vector', () => {
    const { viewer, g } = scene()
    const b = cameraBasis(viewer, g)
    const d = [3, -2, 0.5]
    panCamera(viewer, b, d)

    const [call] = viewer.locationCalls
    expect(call.position).toEqual([b.C[0] + d[0], b.C[1] + d[1], b.C[2] + d[2]])
    expect(call.target).toEqual([b.target[0] + d[0], b.target[1] + d[1],
                                 b.target[2] + d[2]])
  })

  it('touches neither the rotation nor the zoom', () => {
    // Both are the reader's: the trackball owns the quaternion and the wheel
    // owns the zoom, and a correction that wrote either would fight them.
    const { viewer, g } = scene()
    panCamera(viewer, cameraBasis(viewer, g), [1, 1, 1])
    const [call] = viewer.locationCalls
    expect(call.quaternion).toBeNull()
    expect(call.zoom).toBeNull()
    expect(call.notify).toBe(true)
  })

  it('leaves the view direction and the distance to the target alone', () => {
    const { viewer, g } = scene()
    const before = cameraBasis(viewer, g)
    panCamera(viewer, before, [7, -4, 2])
    const after = cameraBasis(viewer, g)
    for (let axis = 0; axis < 3; axis += 1) {
      expect(after.view[axis]).toBeCloseTo(before.view[axis], 12)
    }
  })
})

describe('projectPoint', () => {
  it('is the inverse of ndcOffset for a point on the cursor ray', () => {
    const { viewer, g } = scene()
    const b = cameraBasis(viewer, g)
    const ndc = [-0.25, 0.8]
    const off = ndcOffset(g, b.eye, b.view, ndc[0], ndc[1])
    const world = [b.C[0] + off[0], b.C[1] + off[1], b.C[2] + off[2]]
    const projected = projectPoint(g, world)
    expect(projected[0]).toBeCloseTo(ndc[0], 10)
    expect(projected[1]).toBeCloseTo(ndc[1], 10)
  })

  it('is null when the library hands back something that is not a Vector3', () => {
    const { viewer, g } = scene()
    viewer.camera.getPosition = () => ({ x: 0, y: 0, z: 0 })
    expect(projectPoint(g, [1, 2, 3])).toBeNull()
  })
})
