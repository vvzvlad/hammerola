// ui/src/viewport/wheel.js — the two-finger swipe, which pans.
//
// What is asserted is what the pan exists for: the model at the target's depth
// follows the fingers pixel for pixel, under either camera. Under perspective
// a nearer point moves further and a farther one less, as anything does when
// the eye slides sideways; under ortho every depth moves alike.

import { afterEach, describe, expect, it, vi } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'

import { installWheel } from '../src/viewport/wheel.js'
import { RECT } from './component.js'
import { fakeViewer, fakeViewport, orthoCamera, perspectiveCamera } from './fakes.js'

const removals = []
afterEach(() => {
  while (removals.length) removals.pop()()
})

/** A trackpad viewport, and the swipe: the capture listener the container got. */
function swiping(camera) {
  const viewer = fakeViewer({ camera, rect: RECT })
  const box = {
    on: null,
    addEventListener(type, fn, options) { if (options && options.capture) box.on = fn },
    removeEventListener() {},
  }
  const vp = { ...fakeViewport(viewer), box, trackpad: true, zoomPoint: null }
  removals.push(installWheel(vp))
  return (deltaX, deltaY, { ctrlKey = false, clientX = 400, clientY = 300 } = {}) => box.on({
    target: viewer.canvas, deltaX, deltaY, deltaMode: 0, ctrlKey, clientX, clientY,
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
  })
}

/** Where a world point is on the canvas, in pixels. */
const pixel = (camera, p) => {
  const [x, y] = camera.project(p)
  return [(x + 1) * 400, (1 - y) * 300]
}

describe('the swipe', () => {
  it('moves the model at the target with the fingers under the perspective camera', () => {
    // The eye at z = 50 and the target 60 down -Z: the target's depth is 60.
    const camera = perspectiveCamera(THREE, { eye: [4, 3, 50] })
    const swipe = swiping(camera)
    const atTarget = [9, 1, -10]
    const nearer = [9, 1, 20]
    const [x0, y0] = pixel(camera, atTarget)
    const near0 = pixel(camera, nearer)
    // A wheel delta is the negative of the fingers' travel.
    swipe(30, -20)
    const [x1, y1] = pixel(camera, atTarget)
    expect(x1 - x0).toBeCloseTo(-30, 9)
    expect(y1 - y0).toBeCloseTo(20, 9)
    // Half the depth, twice the travel.
    const near1 = pixel(camera, nearer)
    expect(near1[0] - near0[0]).toBeCloseTo(-60, 9)
  })

  it('pinches about the point under the fingers after a swipe, under the perspective camera', () => {
    // The swipe moves the controls' target and not the one the library's
    // `setCameraZoom` walks the eye to; the pinch must still walk the eye along
    // the view, so the point at the target's depth under the fingers stays.
    const camera = perspectiveCamera(THREE, { eye: [4, 3, 50] })
    const swipe = swiping(camera)
    swipe(150, 90)
    const at = [600, 150]
    const nx = (at[0] / RECT.width) * 2 - 1
    const ny = 1 - (at[1] / RECT.height) * 2
    const far = camera.unproject([nx, ny, 0.5])
    const dir = far.map((v, i) => v - camera.eye[i])
    const P = camera.eye.map((v, i) => v + dir[i] * (60 / -dir[2]))
    const before = pixel(camera, P)
    swipe(0, -40, { ctrlKey: true, clientX: at[0], clientY: at[1] })
    const after = pixel(camera, P)
    expect(after[0]).toBeCloseTo(before[0], 9)
    expect(after[1]).toBeCloseTo(before[1], 9)
    expect(camera.eye[2]).toBeLessThan(50)
  })

  it('moves every depth with the fingers alike under the orthographic camera', () => {
    const camera = orthoCamera({ eye: [4, 3, 50] })
    const swipe = swiping(camera)
    const before = [[9, 1, -10], [9, 1, 20]].map((p) => pixel(camera, p))
    swipe(30, -20)
    const after = [[9, 1, -10], [9, 1, 20]].map((p) => pixel(camera, p))
    for (let i = 0; i < 2; i += 1) {
      expect(after[i][0] - before[i][0]).toBeCloseTo(-30, 9)
      expect(after[i][1] - before[i][1]).toBeCloseTo(20, 9)
    }
  })
})
