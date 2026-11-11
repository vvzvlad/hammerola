// ui/src/viewport/orbit.js — orbit about the point under the cursor.
//
// What is asserted is what the correction exists for: once the trackball has
// turned the camera about its target, the point grabbed at the press is back on
// the pixel it was grabbed at, under either camera. The trackball is a fake
// that keeps the two facts the module reads off the library's: `state` says
// whether the press rotates, and a "change" event follows every move of the
// camera. The turn itself is done here, about the target, as `update()` does.

import { afterEach, describe, expect, it, vi } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'

import { installOrbit } from '../src/viewport/orbit.js'
import { RECT } from './component.js'
import { fakeViewer, orthoCamera, perspectiveCamera } from './fakes.js'

const AT = [600, 150]
const NDC = [(AT[0] / RECT.width) * 2 - 1, 1 - (AT[1] / RECT.height) * 2]

const removals = []
afterEach(() => {
  while (removals.length) removals.pop()()
})

function orbiting(camera) {
  const viewer = fakeViewer({ camera, rect: RECT })
  const listeners = new Set()
  const tb = {
    state: 0,
    keyState: -1,
    addEventListener: (type, fn) => listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
    update: vi.fn(),
  }
  viewer.controls = { controls: tb }
  const box = { addEventListener: (type, fn) => { box.down = fn }, removeEventListener() {} }
  const vp = { viewer, box, orbitAnchor: null }
  removals.push(installOrbit(vp))
  return { viewer, vp, changed: () => [...listeners].forEach((fn) => fn()) }
}

/** The point the cursor shows `depth` along the view, from the camera itself. */
function underCursor(camera, depth) {
  if (camera.cam.isOrthographicCamera) {
    const p = camera.unproject([...NDC, 0])
    return p.map((v, i) => v + camera.forward[i] * (depth - camera.depth))
  }
  const far = camera.unproject([...NDC, 0.5])
  const dir = far.map((v, i) => v - camera.eye[i])
  const k = depth / dir.reduce((sum, v, i) => sum + v * camera.forward[i], 0)
  return camera.eye.map((v, i) => v + dir[i] * k)
}

/** The trackball's turn: the camera carried round the target by `q`. */
function turn(camera, viewer, q) {
  const T = viewer.target
  const rel = new THREE.Vector3(...camera.eye.map((v, i) => v - T[i])).applyQuaternion(q)
  if (camera.cam.isPerspectiveCamera) camera.cam.quaternion.premultiply(q)
  for (const key of ['right', 'up', 'forward']) {
    camera[key] = new THREE.Vector3(...camera[key]).applyQuaternion(q).toArray()
  }
  camera.eye = T.map((v, i) => v + rel.getComponent(i))
}

describe('orbit about the point under the cursor', () => {
  for (const [name, make] of [
    ['orthographic', () => orthoCamera({ eye: [4, 3, 50] })],
    ['perspective', () => perspectiveCamera(THREE, { eye: [4, 3, 50] })],
  ]) {
    it(`puts the grabbed point back on its pixel under the ${name} camera`, () => {
      const camera = make()
      const { viewer, vp, changed } = orbiting(camera)
      const P = underCursor(camera, 25)
      viewer.idPicker.pickAt = vi.fn(() => ({ point: new THREE.Vector3(...P) }))
      vp.box.down({ target: viewer.canvas, clientX: AT[0], clientY: AT[1] })
      expect(vp.orbitAnchor).not.toBeNull()

      turn(camera, viewer, new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0.3, 1, 0.2).normalize(), 0.35))
      const off = camera.project(P)
      expect(Math.hypot(off[0] - NDC[0], off[1] - NDC[1]), 'the premise: the turn moved it')
        .toBeGreaterThan(0.01)
      changed()
      const back = camera.project(P)
      expect(back[0]).toBeCloseTo(NDC[0], 9)
      expect(back[1]).toBeCloseTo(NDC[1], 9)
    })
  }
})
