// ui/src/viewport/zoom.js — zoom to the cursor, on a trackball that zooms to
// the centre.
//
// The law under test is `k = 1 - z0/z1`, and it is deliberately NOT restated
// here. What is asserted instead is the thing the law exists to produce: THE
// POINT UNDER THE CURSOR DOES NOT MOVE. That reading is what makes the fake
// camera worth having — it models three.js's ortho projection, so "did not
// move" can be measured by projecting a world point twice.
//
// The one behaviour that has no visible symptom until it is wrong is the early
// exit at `k === 0`, and it gets tests of its own: a horizontal scroll and a
// zoom the controls clamped at their stop both leave `z1 === z0`, and moving the
// camera by an offset scaled by zero is not a no-op — it is a `panCamera` call
// with a zero vector that the library still routes through
// `setCameraLocationSettings`, and any drift in that path shows up as the model
// sliding sideways every time the reader hits the end of the zoom travel.
//
// Not tested here, and not testable without a GPU: whether the pixel the reader
// is looking at is the pixel the browser reports. That is the Playwright half.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { zoomWheelAfter, zoomWheelBefore } from '../src/viewport/zoom.js'
import { RECT } from './component.js'
import { eventAt, fakeViewer, orthoCamera } from './fakes.js'

// A cursor well away from the centre: at the centre every zoom law agrees,
// including a broken one.
const CURSOR = [600, 150]

function scene() {
  const camera = orthoCamera({
    eye: [4, 3, 50], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1],
    zoom: 1,
  })
  const viewer = fakeViewer({ camera, rect: RECT })
  const vp = { viewer, zoomAnchor: null }
  return { camera, viewer, vp }
}

/** Where a world point lands on the canvas right now, in NDC. */
const seen = (camera, point) => camera.project(point).slice(0, 2)

/** The world point the cursor is over, taken from the camera itself. */
function under(camera, viewer, at) {
  const rect = viewer.canvas.getBoundingClientRect()
  const nx = ((at[0] - rect.left) / rect.width) * 2 - 1
  const ny = -(((at[1] - rect.top) / rect.height) * 2 - 1)
  return camera.unproject([nx, ny, 0])
}

describe('zoom to the cursor', () => {
  let ctx
  beforeEach(() => { ctx = scene() })

  it('keeps the point under the cursor under the cursor', () => {
    const { camera, viewer, vp } = ctx
    const anchor = under(camera, viewer, CURSOR)
    const before = seen(camera, anchor)

    zoomWheelBefore(vp, eventAt(viewer, ...CURSOR))
    camera.zoom = 2.5                       // what the controls do in between
    zoomWheelAfter(vp)

    const after = seen(camera, anchor)
    expect(after[0]).toBeCloseTo(before[0], 9)
    expect(after[1]).toBeCloseTo(before[1], 9)
  })

  it('holds it for a zoom OUT as well, by the same law', () => {
    const { camera, viewer, vp } = ctx
    const anchor = under(camera, viewer, CURSOR)
    const before = seen(camera, anchor)

    zoomWheelBefore(vp, eventAt(viewer, ...CURSOR))
    camera.zoom = 0.4
    zoomWheelAfter(vp)

    const after = seen(camera, anchor)
    expect(after[0]).toBeCloseTo(before[0], 9)
    expect(after[1]).toBeCloseTo(before[1], 9)
  })

  it('a scroll down undoes a scroll up, back to the same camera', () => {
    const { camera, viewer, vp } = ctx
    const start = [...camera.eye]

    zoomWheelBefore(vp, eventAt(viewer, ...CURSOR))
    camera.zoom = 1.6
    zoomWheelAfter(vp)

    zoomWheelBefore(vp, eventAt(viewer, ...CURSOR))
    camera.zoom = 1
    zoomWheelAfter(vp)

    for (let axis = 0; axis < 3; axis += 1) {
      expect(camera.eye[axis]).toBeCloseTo(start[axis], 9)
    }
  })

  it('leaves the zoom itself to the controls', () => {
    const { camera, viewer, vp } = ctx
    zoomWheelBefore(vp, eventAt(viewer, ...CURSOR))
    camera.zoom = 3
    zoomWheelAfter(vp)
    expect(camera.zoom).toBe(3)
    for (const call of viewer.locationCalls) expect(call.zoom).toBeNull()
  })
})

describe('the k === 0 early exit', () => {
  let ctx
  beforeEach(() => { ctx = scene() })

  it('moves nothing when the wheel changed no zoom at all', () => {
    // A horizontal scroll: the event reaches both listeners, the controls do
    // nothing in between, and the camera must come out exactly where it was.
    const { camera, viewer, vp } = ctx
    const start = [...camera.eye]

    zoomWheelBefore(vp, eventAt(viewer, ...CURSOR))
    zoomWheelAfter(vp)

    expect(camera.eye).toEqual(start)
    expect(viewer.setCameraLocationSettings).not.toHaveBeenCalled()
  })

  it('moves nothing when the controls clamped the zoom at its stop', () => {
    // minZoom/maxZoom: the reader keeps scrolling and the zoom stops changing.
    // Without the early exit each further notch pans by `off * 0` — a call the
    // library still executes, and the end of the travel is exactly where a
    // reader notices the model creeping sideways.
    const { camera, viewer, vp } = ctx
    camera.zoom = 2

    for (let notch = 0; notch < 5; notch += 1) {
      zoomWheelBefore(vp, eventAt(viewer, ...CURSOR))
      zoomWheelAfter(vp)                      // the controls refused to zoom
    }

    expect(camera.eye).toEqual([4, 3, 50])
    expect(viewer.setCameraLocationSettings).not.toHaveBeenCalled()
  })
})

describe('the anchor', () => {
  let ctx
  beforeEach(() => { ctx = scene() })

  it('is dropped when the wheel did not land on the canvas', () => {
    // The interface's own chrome bubbles through the same container, and the
    // controls ignore it — so this has to as well.
    const { viewer, vp } = ctx
    zoomWheelBefore(vp, { target: { notTheCanvas: true }, clientX: 1, clientY: 1 })
    expect(vp.zoomAnchor).toBeNull()
    expect(viewer.setCameraLocationSettings).not.toHaveBeenCalled()
  })

  it('is dropped under a perspective camera, leaving the library its own zoom', () => {
    const { camera, viewer, vp } = ctx
    camera.cam.isOrthographicCamera = false
    zoomWheelBefore(vp, eventAt(viewer, ...CURSOR))
    expect(vp.zoomAnchor).toBeNull()
  })

  it('is consumed once: a second bubble with no press in between does nothing', () => {
    const { camera, viewer, vp } = ctx
    zoomWheelBefore(vp, eventAt(viewer, ...CURSOR))
    camera.zoom = 2
    zoomWheelAfter(vp)
    const moved = [...camera.eye]

    camera.zoom = 4
    zoomWheelAfter(vp)                        // no anchor: nothing to correct
    expect(camera.eye).toEqual(moved)
  })

  it('survives a viewer that throws, without taking the page down', () => {
    const { viewer, vp } = ctx
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    viewer.getCameraZoom = () => { throw new Error('gone') }
    expect(() => zoomWheelBefore(vp, eventAt(viewer, ...CURSOR))).not.toThrow()
    expect(vp.zoomAnchor).toBeNull()
    vi.restoreAllMocks()
  })
})
