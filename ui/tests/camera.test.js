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

import * as THREE from '../../static/_v/three.module.js'

import {
  cameraBasis, canvasXY, ndcAt, ndcOffset, ndcRay, panCamera, pointAtDepth, projectPoint,
  rayLineParam, rayPlanePoint, sightAt, standFrame, syncCameraTarget,
} from '../src/viewport/camera.js'
import { dot3 } from '../src/viewport/math.js'
import { eventAt, fakeViewer, orthoCamera, perspectiveCamera } from './fakes.js'

const RECT = { left: 40, top: 20, width: 800, height: 600 }

function scene(options = {}) {
  const camera = orthoCamera({
    eye: [10, -5, 60], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1],
    ...options,
  })
  const viewer = fakeViewer({ camera, rect: RECT })
  return { camera, viewer, g: internalsOf(viewer) }
}

/** The same, under a real perspective camera looking down a slant. */
function perspectiveScene() {
  const camera = perspectiveCamera(THREE, {
    eye: [10, -5, 60], right: [1, 0, 0], up: [0, 0.8, 0.6], forward: [0, 0.6, -0.8],
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

describe('ndcRay', () => {
  // Same discipline as `ndcOffset` above: the ray is not compared against a
  // second copy of the formula, it is asked the one thing a ray is for — does
  // every point of it come back to the pixel it was built from.
  const along = (ray, t) => [ray.origin[0] + t * ray.dir[0],
                             ray.origin[1] + t * ray.dir[1],
                             ray.origin[2] + t * ray.dir[2]]

  it('is a ray whose every point projects back to its own pixel, under ortho', () => {
    const { camera, viewer, g } = scene()
    const b = cameraBasis(viewer, g)
    const ndc = [0.4, -0.7]
    const ray = ndcRay(g, b.eye, b.view, ndc[0], ndc[1])
    for (const t of [-25, 0, 12, 90]) {
      const back = camera.project(along(ray, t))
      expect(back[0]).toBeCloseTo(ndc[0], 10)
      expect(back[1]).toBeCloseTo(ndc[1], 10)
    }
  })

  it('runs along the view axis under ortho, whatever pixel it was asked about', () => {
    // The half a section cut leans on: with the camera parallel-projecting, two
    // pixels see the same direction and differ only in where their ray starts.
    const { viewer, g } = scene()
    const b = cameraBasis(viewer, g)
    const left = ndcRay(g, b.eye, b.view, -0.9, 0.2)
    const right = ndcRay(g, b.eye, b.view, 0.9, -0.2)
    expect(left.dir).toEqual(b.view)
    expect(right.dir).toEqual(b.view)
    expect(left.origin).not.toEqual(right.origin)
  })

  it('does NOT start every ortho ray at the eye', () => {
    // Why the ortho branch exists: an eye-origin ray answers the middle of the
    // screen for every pixel, so a cut face would resolve to whichever part
    // sits in the centre of the view.
    const { viewer, g } = scene()
    const b = cameraBasis(viewer, g)
    const ray = ndcRay(g, b.eye, b.view, 0.6, 0.6)
    expect(ray.origin).not.toEqual(b.C)
  })

  it('leaves the eye it borrowed where it was', () => {
    // `unproject` transforms IN PLACE, so the vector the library handed back is
    // cloned before it is overwritten — the same borrowed-Vector3 trick
    // `ndcOffset` uses, and the same thing to get wrong.
    const { viewer, g } = scene()
    const b = cameraBasis(viewer, g)
    const before = [b.eye.x, b.eye.y, b.eye.z]
    ndcRay(g, b.eye, b.view, 0.3, 0.3)
    expect([b.eye.x, b.eye.y, b.eye.z]).toEqual(before)
  })

  it('starts every perspective ray at the eye, and every point of it is on its pixel', () => {
    const { camera, viewer, g } = perspectiveScene()
    const b = cameraBasis(viewer, g)
    const ndc = [0.4, -0.7]
    const ray = ndcRay(g, b.eye, b.view, ndc[0], ndc[1])
    expect(ray.origin).toEqual(b.C)
    expect(ray.fromEye).toBe(true)
    expect(Math.hypot(...ray.dir)).toBeCloseTo(1, 12)
    for (const t of [5, 60, 400]) {
      const back = camera.project(along(ray, t))
      expect(back[0]).toBeCloseTo(ndc[0], 10)
      expect(back[1]).toBeCloseTo(ndc[1], 10)
    }
  })

  it('is null when the projection comes back unusable', () => {
    const { viewer, g } = scene()
    const b = cameraBasis(viewer, g)
    expect(ndcRay(g, b.eye, b.view, NaN, 0)).toBeNull()
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

describe('pointAtDepth', () => {
  // Asked what it is for: the point is on the pixel's ray, at the depth asked
  // for along the view axis, under either camera.
  for (const [name, make] of [['ortho', scene], ['perspective', perspectiveScene]]) {
    it(`stands on its pixel at the depth it was asked for, under ${name}`, () => {
      const { camera, viewer, g } = make()
      const b = cameraBasis(viewer, g)
      for (const depth of [20, 60, 150]) {
        const p = pointAtDepth(g, b, 0.3, -0.55, depth)
        const back = camera.project(p)
        expect(back[0]).toBeCloseTo(0.3, 9)
        expect(back[1]).toBeCloseTo(-0.55, 9)
        expect(dot3([p[0] - b.C[0], p[1] - b.C[1], p[2] - b.C[2]], b.view)).toBeCloseTo(depth, 9)
      }
    })
  }

  it('is under ortho the offset of `ndcOffset` walked out along the view, as the pivot always was', () => {
    const { viewer, g } = scene()
    const b = cameraBasis(viewer, g)
    const off = ndcOffset(g, b.eye, b.view, 0.3, -0.55)
    const p = pointAtDepth(g, b, 0.3, -0.55, 42)
    for (let i = 0; i < 3; i += 1) expect(p[i]).toBeCloseTo(b.C[i] + off[i] + 42 * b.view[i], 12)
  })
})

describe('sightAt', () => {
  it('is the view axis under ortho and the ray from the eye under perspective', () => {
    const ortho = scene()
    const ob = cameraBasis(ortho.viewer, ortho.g)
    expect(sightAt(ortho.g, ob, [30, 30, 0])).toBe(ob.view)
    const persp = perspectiveScene()
    const pb = cameraBasis(persp.viewer, persp.g)
    const sight = sightAt(persp.g, pb, [30, 30, 0])
    const to = [30 - pb.C[0], 30 - pb.C[1], 0 - pb.C[2]]
    const length = Math.hypot(...to)
    for (let i = 0; i < 3; i += 1) expect(sight[i]).toBeCloseTo(to[i] / length, 12)
    expect(sightAt(persp.g, pb, pb.C)).toBeNull()
  })
})

describe('rayLineParam and rayPlanePoint', () => {
  const AXIS = [0, 0.6, 0.8]
  const AT = [12, 30, -4]

  it('moves under ortho by the hand along the axis over sine squared', () => {
    // What a slider joint and an arrow always were under ortho: the hand's
    // screen-plane world vector along the axis, over the square of the part of
    // the axis the view leaves.
    const { viewer, g } = scene()
    const b = cameraBasis(viewer, g)
    const from = ndcRay(g, b.eye, b.view, 0.1, 0.2)
    const to = ndcRay(g, b.eye, b.view, -0.3, 0.5)
    const hand = ndcOffset(g, b.eye, b.view, -0.3, 0.5)
      .map((v, i) => v - ndcOffset(g, b.eye, b.view, 0.1, 0.2)[i])
    const cos = dot3(AXIS, b.view)
    expect(rayLineParam(to, AT, AXIS) - rayLineParam(from, AT, AXIS))
      .toBeCloseTo(dot3(hand, AXIS) / (1 - cos * cos), 9)
  })

  it('answers the point of the line nearest the ray under perspective', () => {
    const { viewer, g } = perspectiveScene()
    const b = cameraBasis(viewer, g)
    const ray = ndcRay(g, b.eye, b.view, -0.2, 0.35)
    const t = rayLineParam(ray, AT, AXIS)
    const onLine = AT.map((v, i) => v + t * AXIS[i])
    const w = onLine.map((v, i) => v - ray.origin[i])
    const onRay = ray.origin.map((v, i) => v + dot3(w, ray.dir) * ray.dir[i])
    const gap = onLine.map((v, i) => v - onRay[i])
    // The shortest segment between the two is square to both.
    expect(dot3(gap, AXIS)).toBeCloseTo(0, 9)
    expect(dot3(gap, ray.dir)).toBeCloseTo(0, 9)
  })

  it('meets a plane behind an ortho ray origin, and refuses one behind the eye', () => {
    const ortho = scene()
    const ob = cameraBasis(ortho.viewer, ortho.g)
    // The plane z = 80 is behind the camera at z = 60 that looks down -z.
    expect(rayPlanePoint(ndcRay(ortho.g, ob.eye, ob.view, 0, 0), [0, 0, 80], [0, 0, 1])).not.toBeNull()
    const persp = perspectiveScene()
    const pb = cameraBasis(persp.viewer, persp.g)
    const ray = ndcRay(persp.g, pb.eye, pb.view, 0, 0)
    expect(rayPlanePoint(ray, [0, 0, 80], [0, 0, 1])).toBeNull()
    const hit = rayPlanePoint(ray, [0, 0, 0], [0, 0, 1])
    expect(hit[2]).toBeCloseTo(0, 9)
  })
})

describe('syncCameraTarget and standFrame', () => {
  const gap = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  const kept = (viewer) => {
    const t = viewer.camera.target
    return [t.x, t.y, t.z]
  }

  it('reads the zoom of the view again after a pan, under perspective', () => {
    // A pan moves the controls' target alone; the library's zoom measured
    // against the target it was built with then reads a view nobody sees.
    const { viewer, g } = perspectiveScene()
    const z0 = viewer.getCameraZoom()
    panCamera(viewer, cameraBasis(viewer, g), [30, 0, 0])
    expect(viewer.getCameraZoom()).toBeLessThan(z0)
    syncCameraTarget(viewer)
    expect(kept(viewer)).toEqual(viewer.getCameraTarget())
    expect(viewer.getCameraZoom()).toBeCloseTo(z0, 12)
  })

  it('stands the eye camera_distance / zoom back along the frame, under perspective', () => {
    const { camera, viewer } = perspectiveScene()
    const target = [1, 2, 3]
    const frame = { position: [1, 2, 23], quaternion: null, target, zoom: 2 }
    standFrame(viewer, frame, false)
    expect(gap(camera.eye, target)).toBeCloseTo(camera.distance / 2, 9)
    expect(camera.eye[2] - target[2]).toBeCloseTo(camera.distance / 2, 9)
    // Written as a position: `setZoom` would walk the eye again.
    expect(viewer.locationCalls.at(-1).zoom).toBeNull()
    expect(kept(viewer)).toEqual(target)
    expect(viewer.getCameraZoom()).toBeCloseTo(2, 12)
  })

  it('stands the eye camera_distance back and writes the zoom, under ortho', () => {
    const { camera, viewer } = scene()
    viewer.camera.camera_distance = 100
    const target = [1, 2, 3]
    standFrame(viewer, { position: [1, 2, 23], quaternion: null, target, zoom: 2 }, true)
    expect(camera.eye).toEqual([1, 2, 103])
    const call = viewer.locationCalls.at(-1)
    expect(call.zoom).toBe(2)
    expect(call.notify).toBe(true)
  })

  it('keeps the frame eye where it is when the frame carries no zoom, under perspective', () => {
    const { camera, viewer } = perspectiveScene()
    standFrame(viewer, { position: [1, 2, 23], quaternion: null, target: [1, 2, 3], zoom: null }, false)
    expect(camera.eye).toEqual([1, 2, 23])
  })
})
