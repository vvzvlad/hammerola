// viewer/src/camera/camera.ts — the fork's perspective framing and planes.
//
// Reached through the shipped bundle, as peeling.test.js reaches the peel: the
// JS suite gets `static/_v/`, never `viewer/`, and the bundle names three by a
// URL node cannot import. So `Camera`, with the two tables it reads, is cut out
// of the bundle's text and run against three's own module.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'

const SOURCE = readFileSync(resolve(process.cwd(), '../static/_v/three-cad-viewer.esm.js'), 'utf8')

/** From the direction table to the last static of `class Camera`. */
function cameraClass() {
  const start = SOURCE.indexOf('const defaultDirections = {')
  const last = SOURCE.indexOf('Camera.NEAR_FACTOR = ', start)
  if (start < 0 || last < 0) throw new Error('the bundle no longer declares Camera')
  const end = SOURCE.indexOf('\n', last) + 1
  return new Function('THREE', 'logger', `${SOURCE.slice(start, end)}
return Camera;`)(THREE, console)
}

const Camera = cameraClass()

// A model of radius 7 about (1, 2, 3).
const R = 7
const TARGET = [1, 2, 3]

describe('the perspective field of view', () => {
  it('frames at camera_distance what ortho frames at zoom 1, on a wide canvas and a tall one', () => {
    for (const [w, h] of [[800, 500], [400, 800]]) {
      const camera = new Camera(w, h, R, TARGET, true, 'Z')
      const half = () => camera.camera_distance
        * Math.tan(THREE.MathUtils.degToRad(camera.pCamera.fov) / 2)
      expect(half()).toBeCloseTo(camera.oCamera.top, 9)
      // And after a resize to the other shape.
      camera.changeDimensions(R, h, w)
      expect(half()).toBeCloseTo(camera.oCamera.top, 9)
    }
  })
})

describe('fitPlanes', () => {
  const gap = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

  it('puts the perspective planes around the model as seen from where the eye stands', () => {
    const camera = new Camera(800, 500, R, TARGET, false, 'Z')
    const eye = [4, -30, 9]
    camera.pCamera.position.set(...eye)
    const at = [2, -1, 3]
    camera.fitPlanes(at, TARGET, R)
    expect(camera.pCamera.near).toBeCloseTo(gap(eye, at) / 20, 12)
    expect(camera.pCamera.far).toBeCloseTo(gap(eye, TARGET) + 100 * R, 12)
    // The projection is the one those planes make.
    const drawn = [...camera.pCamera.projectionMatrix.elements]
    camera.pCamera.updateProjectionMatrix()
    expect(drawn).toEqual([...camera.pCamera.projectionMatrix.elements])
  })

  it('changes nothing under ortho', () => {
    const camera = new Camera(800, 500, R, TARGET, true, 'Z')
    const planes = () => [camera.pCamera.near, camera.pCamera.far, camera.oCamera.near,
                          camera.oCamera.far, ...camera.oCamera.projectionMatrix.elements]
    const before = planes()
    camera.oCamera.position.set(4, -30, 9)
    camera.fitPlanes([2, -1, 3], TARGET, R)
    expect(planes()).toEqual(before)
  })

  it('is fitted by every frame before the hover pick reads the pick buffer', () => {
    const fit = SOURCE.indexOf('this.rendered.camera.fitPlanes(')
    const hover = SOURCE.indexOf('this.pickingController.handleHover();')
    expect(fit).toBeGreaterThan(0)
    expect(hover).toBeGreaterThan(fit)
    expect(SOURCE.indexOf('this.pickingController.handleHover();', hover + 1)).toBe(-1)
  })
})
