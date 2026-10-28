// View in AR's WebXR session (`showXr` in ui/src/ar.js): what it does with its
// renderer from the session's start to its end.
//
// No GPU and no WebXR here. three is handed over with its renderer replaced, as
// board3dview.test.js does, by one that logs what is done to it and whose
// `xr.setSession` is the test's; the session is an EventTarget whose `end()`
// fires `end`, as the browser's does. Under jsdom, the directory's default,
// unlike ar.test.js: the renderer's canvas goes into the page and out of it.

import { describe, expect, it, vi } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'
import { showXr } from '../src/ar.js'

/** A model of one part, its faces one triangle, as the viewer's groups hold it
 *  (`nestedGroup.groups`: a group whose `front` is the mesh of its faces). */
function model() {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3))
  geometry.setIndex([0, 1, 2])
  const group = new THREE.Group()
  group.front = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial())
  group.add(group.front)
  return { '/m': group }
}

/**
 * three with its renderer replaced, the renderers it made, and the log of what
 * was done to them: `loop` and `no loop` for `setAnimationLoop`, `session` for
 * `xr.setSession`, which runs `setSession` (by default it sets the session at
 * once), `dispose` and `context lost`.
 */
function fakes(setSession = async () => {}) {
  const log = []
  const made = []
  class WebGLRenderer {
    constructor(options) {
      this.options = options
      this.domElement = document.createElement('canvas')
      this.render = vi.fn()
      this.setAnimationLoop = vi.fn((loop) => log.push(loop ? 'loop' : 'no loop'))
      this.dispose = vi.fn(() => log.push('dispose'))
      this.forceContextLoss = vi.fn(() => log.push('context lost'))
      this.xr = {
        enabled: false,
        setReferenceSpaceType: vi.fn(),
        setSession: vi.fn((session) => {
          log.push('session')
          return setSession(session)
        }),
      }
      made.push(this)
    }
  }
  return { three: { ...THREE, WebGLRenderer }, made, log }
}

function session() {
  const one = new EventTarget()
  one.end = () => one.dispatchEvent(new Event('end'))
  return one
}

/** All a renderer leaves behind it: no loop, no GPU resources, no context. */
const GONE = ['no loop', 'dispose', 'context lost']

describe('the WebXR session of View in AR', () => {
  it('sets its loop before the session, and the loop draws the model', async () => {
    // After the session, the loop would start the window's frames again beside
    // the session's (`setAnimationLoop` in three.module.js), drawing outside
    // the session's frames.
    const { three, made, log } = fakes()
    await showXr(three, model(), session())
    const [renderer] = made
    expect(log).toEqual(['loop', 'session'])
    expect(renderer.options).toEqual({ alpha: true, antialias: true })
    expect([renderer.xr.enabled, renderer.xr.setReferenceSpaceType.mock.calls]).toEqual([true, [['local']]])
    expect(renderer.domElement.isConnected).toBe(true)
    renderer.setAnimationLoop.mock.calls[0][0]()
    const [scene] = renderer.render.mock.calls[0]
    const meshes = []
    scene.traverse((object) => object.isMesh && meshes.push(object))
    expect(meshes).toHaveLength(1)
  })

  it('lets the renderer, its context and its canvas go when the session ends', async () => {
    const { three, made, log } = fakes()
    const one = session()
    await showXr(three, model(), one)
    one.end()
    expect(log).toEqual(['loop', 'session', ...GONE])
    expect(made[0].domElement.isConnected).toBe(false)
  })

  it('lets them go, and fails, where the session cannot be set', async () => {
    const { three, made, log } = fakes(async () => { throw new Error('no reference space') })
    await expect(showXr(three, model(), session())).rejects.toThrow('no reference space')
    expect(log).toEqual(['loop', 'session', ...GONE])
    expect(made[0].domElement.isConnected).toBe(false)
  })

  it('lets them go, and fails, where the session ends while it is set', async () => {
    // three's own listener has put the renderer back by then, and setting the
    // session may still resolve: nothing after it would hear an end that has
    // already come.
    const { three, made, log } = fakes(async (one) => { one.end() })
    await expect(showXr(three, model(), session())).rejects.toThrow()
    expect(log).toEqual(['loop', 'session', ...GONE])
    expect(made[0].domElement.isConnected).toBe(false)
  })
})
