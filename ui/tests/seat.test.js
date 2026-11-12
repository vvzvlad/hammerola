// ui/src/viewport/seat.js — where the target stands under the perspective
// camera.
//
// The scene is one box, picked the way the id picker's depth-tested passes
// answer (`boxScene`): three's own ray from the camera, its entry into the box.
// What is asserted is where the eye ends up against that box, not the
// arithmetic that put it there.

import { describe, expect, it } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'

import { internals } from '../src/viewport/internals.js'
import {
  installZoomSeat, keepEye, orthoFrame, seatFrame,
} from '../src/viewport/seat.js'
import { RECT } from './component.js'
import { boxScene, fakeViewer, fakeViewport, perspectiveCamera } from './fakes.js'

// The library's `camera_distance`, and the model: a 20 mm cube on the origin.
const CD = 60
const MIN = [-10, -10, -10]
const MAX = [10, 10, 10]

function scene({ eye = [0, 0, 60], target = null } = {}) {
  const camera = perspectiveCamera(THREE, { eye, distance: CD })
  const viewer = fakeViewer({ camera, rect: RECT, target })
  const box = boxScene(THREE, viewer, { min: MIN, max: MAX })
  const vp = fakeViewport(viewer)
  return { camera, viewer, box, vp, g: internals(viewer) }
}

const sub = (a, b) => a.map((v, i) => v - b[i])
const gap = (a, b) => Math.hypot(...sub(a, b))
const unit = (a) => a.map((v) => v / Math.hypot(...a))
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const corners = () => [MIN[0], MAX[0]].flatMap((x) => [MIN[1], MAX[1]]
  .flatMap((y) => [MIN[2], MAX[2]].map((z) => [x, y, z])))

/** A frame as an ortho camera leaves one: looking down `view` through `on`,
 *  the target `beyond` past it along the axis, the eye `CD` before the target
 *  (ortho gestures never move it along the axis), the turn three's `lookAt`. */
function orthoFrameThrough(on, view, beyond, zoom) {
  const target = on.map((v, i) => v + view[i] * beyond)
  const position = target.map((v, i) => v - view[i] * CD)
  const turn = new THREE.PerspectiveCamera()
  turn.up.set(0, 0, 1)
  turn.position.set(...position)
  turn.lookAt(...target)
  return { position, quaternion: turn.quaternion.toArray(), target, zoom }
}

describe('a frame taken under ortho, opened under perspective', () => {
  // Down the iso diagonal, as after a turn; the axis through a point of the
  // cube off its centre, as after a pan.
  const VIEW = unit([-1, 1, -1])

  it('stands the eye camera_distance / zoom before the surface the axis meets', () => {
    // The target inside the cube, where a turn about a picked point leaves it:
    // as it is, the eye 7.5 before it would be inside the cube too.
    const { camera, viewer, box, vp } = scene()
    const frame = orthoFrameThrough([1, 2, 0], VIEW, 12, 8)
    seatFrame(vp, frame, false)
    const eye = camera.eye
    const T = viewer.getCameraTarget()
    expect(gap(eye, T)).toBeCloseTo(CD / 8, 9)
    // The turn and the axis are kept.
    expect(dot(unit(sub(T, eye)), VIEW)).toBeCloseTo(1, 12)
    expect(dot(unit(sub(T, frame.target)), VIEW) ** 2).toBeCloseTo(1, 12)
    // The first surface on the way from the eye is the target.
    const ray = new THREE.Ray(new THREE.Vector3(...eye), new THREE.Vector3(...VIEW))
    const met = ray.intersectBox(box, new THREE.Vector3())
    expect(gap(met.toArray(), T)).toBeCloseTo(0, 9)
    expect(viewer.locationCalls).toHaveLength(1)
  })

  it('puts the whole model before the eye when the centre shows nothing', () => {
    // The axis passes the cube by; as it is, the eye would stand among the
    // depths of its corners.
    const { camera, vp } = scene()
    seatFrame(vp, orthoFrameThrough([25, 0, 0], VIEW, 10, 8), false)
    const depths = corners().map((p) => dot(sub(p, camera.eye), VIEW))
    expect(Math.min(...depths)).toBeCloseTo(CD / 8, 9)
  })

  it('stands a frame taken under perspective as it is', () => {
    const { camera, viewer, vp } = scene()
    seatFrame(vp, { position: [0, 0, 25], quaternion: null, target: [0, 0, 10],
                    zoom: CD / 15 }, false)
    expect(camera.eye).toEqual([0, 0, 25])
    expect(viewer.idPicker.pickAt).not.toHaveBeenCalled()
  })
})

describe('which camera took a frame', () => {
  const frame = (gapToTarget, zoom) => ({ position: [0, 0, gapToTarget], target: [0, 0, 0], zoom })

  it('tells the two apart at zoom 4, from this revision and from one whose model was 1.3 times the size', () => {
    for (const rho of [1, 1.3, 1 / 1.3]) {
      expect(orthoFrame(frame(CD * rho, 4), CD)).toBe(true)
      expect(orthoFrame(frame((CD * rho) / 4, 4), CD)).toBe(false)
    }
  })
})

describe('keeping the eye', () => {
  it('slides the target onto the surface the centre shows, and leaves it over the background', () => {
    // Looking down -Z at the cube's top face, z = 10, the target at its middle.
    const { camera, viewer, vp, g } = scene()
    expect(keepEye(vp, g)).toBe(true)
    expect(gap(viewer.getCameraTarget(), [0, 0, 10])).toBeCloseTo(0, 9)
    const kept = viewer.camera.target
    expect(gap([kept.x, kept.y, kept.z], [0, 0, 10])).toBeCloseTo(0, 9)
    expect(camera.eye).toEqual([0, 0, 60])
    expect(viewer.update).not.toHaveBeenCalled()

    const aside = scene({ eye: [50, 0, 60] })
    expect(keepEye(aside.vp, aside.g)).toBe(false)
    expect(aside.viewer.getCameraTarget()).toEqual([50, 0, 0])
  })

  it('on every step of the library\'s own zoom, between the press and the release', () => {
    const { viewer, vp } = scene()
    // The trackball: three's dispatcher, and its state (`_STATE`).
    const tb = Object.assign(new THREE.EventDispatcher(), { state: 0 })
    viewer.controls.controls = tb
    vp.box = { addEventListener: (type, fn) => { vp.box.press = fn }, removeEventListener() {} }
    const uninstall = installZoomSeat(vp)
    vp.box.press({ target: viewer.canvas })
    tb.dispatchEvent({ type: 'change' })                  // a turn
    expect(viewer.getCameraTarget()).toEqual([0, 0, 0])
    tb.state = 1                                          // the middle button
    tb.dispatchEvent({ type: 'change' })
    expect(gap(viewer.getCameraTarget(), [0, 0, 10])).toBeCloseTo(0, 9)
    dispatchEvent(new Event('pointerup'))
    viewer.target = [0, 0, 0]
    tb.dispatchEvent({ type: 'change' })
    expect(viewer.getCameraTarget()).toEqual([0, 0, 0])
    uninstall()
  })
})
