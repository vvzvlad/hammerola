// viewer/src/rendering/depth-peeling.ts — which pass of a peeled frame draws what.
//
// A frame with a translucent part is split by three.js layers: pass A draws
// what was always drawn, the peel passes draw only the faces of translucent
// parts, and the overlay pass draws their edges and everything that sits on top
// of the model (renderOrder 1000 and up) over the peeled layers. The layers are
// assigned at the start of the frame and put back at its end. No GPU here, so
// the passes themselves are not looked at; what is asserted is the split, by
// three's own `Layers.test` — the check its renderer makes — and that the frame
// leaves every mask, the camera's included, as it found it. A mask left behind
// is silent: the picker and the raycaster test the same layers.
//
// The library's code is reached the way the rest of this directory reaches it,
// through the shipped bundle: the JS suite gets `ui/` and named files under
// `static/_v/`, never `viewer/`. The bundle names three by the URL the hub
// serves, which node cannot import, so the declarations of the split are cut
// out of its text and run against three's own module. They name nothing outside
// themselves, which is what makes the slice runnable as it is.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'

const BUNDLE = '../static/_v/three-cad-viewer.esm.js'

const SOURCE = readFileSync(resolve(process.cwd(), BUNDLE), 'utf8')

/** From the first layer constant to the end of `restorePassLayers`. */
function library() {
  const source = SOURCE
  const start = source.indexOf('const PEEL_LAYER = ')
  const last = source.indexOf('function restorePassLayers(', start)
  if (start < 0 || last < 0) {
    throw new Error('the bundle no longer declares the depth-peeling layer split')
  }
  const end = source.indexOf('\n}\n', last) + 3
  return new Function(`${source.slice(start, end)}
return { PEEL_LAYER, OVERLAY_LAYER, translucentGroups, assignPassLayers, restorePassLayers };`)()
}

const lib = library()

/** The passes whose camera mask an object passes, as three's renderer tests it. */
function passes(object) {
  const camera = new THREE.Layers()
  return [['A', 0], ['PEEL', lib.PEEL_LAYER], ['OVERLAY', lib.OVERLAY_LAYER]]
    .filter(([, layer]) => {
      camera.set(layer)
      return object.layers.test(camera)
    })
    .map(([name]) => name)
}

/** An ObjectGroup on the layers viewer/src/scene/nestedgroup.ts gives it: the
 *  front face also on the face pick layer, the edges (999) on the edge pick
 *  layer, the corner cloud on the vertex pick layer ONLY, the selection marker
 *  at 1000, and a clipping stencil under a group of its own. */
function part(opacity) {
  const geometry = new THREE.BufferGeometry()
  const group = new THREE.Group()
  group.isObjectGroup = true
  group.front = new THREE.Mesh(geometry,
    new THREE.MeshStandardMaterial({ transparent: true, opacity }))
  group.front.layers.enable(1)
  group.back = new THREE.Mesh(geometry,
    new THREE.MeshBasicMaterial({ transparent: true, opacity, side: THREE.BackSide }))
  group.edges = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial())
  group.edges.renderOrder = 999
  group.edges.layers.enable(2)
  group.vertices = null
  group.corners = new THREE.Points(geometry, new THREE.PointsMaterial())
  group.corners.layers.set(3)
  group.marker = new THREE.Points(geometry, new THREE.PointsMaterial())
  group.marker.renderOrder = 1000
  group.stencil = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  const clipping = new THREE.Group()
  clipping.add(group.stencil)
  group.add(group.back, group.front, group.edges, group.corners, group.marker, clipping)
  return group
}

/** A translucent case, an opaque board, a translucent part that is hidden, and
 *  a widget whose own mesh is ordered below its group's band. */
function stage() {
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera()
  const light = new THREE.DirectionalLight()
  const root = new THREE.Group()
  const glass = part(0.5)
  const board = part(1)
  const hidden = part(0.5)
  hidden.front.material.visible = false
  const widget = new THREE.Group()
  widget.renderOrder = 1021
  const handle = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  handle.renderOrder = -1
  widget.add(handle)
  root.add(glass, board, hidden)
  scene.add(light, root, widget)
  const groups = { '/a': root, '/a/glass': glass, '/a/board': board, '/a/hidden': hidden }
  return { scene, camera, light, root, glass, board, hidden, widget, handle, groups }
}

/** `stage()` with this frame's layers assigned. */
function split() {
  const s = stage()
  s.snapshot = { objects: [], masks: [] }
  lib.assignPassLayers(s.scene, s.camera, lib.translucentGroups(s.groups), s.snapshot)
  return s
}

describe('which parts are translucent', () => {
  it('takes a part whose front face is shown below full opacity, and nothing else', () => {
    const s = stage()
    expect(lib.translucentGroups(s.groups)).toEqual([s.glass])
    s.glass.front.visible = false
    expect(lib.translucentGroups(s.groups)).toEqual([])
  })
})

describe('which pass draws what', () => {
  it('peels the faces of a translucent part and nothing else', () => {
    const s = split()
    expect(passes(s.glass.front)).toEqual(['PEEL'])
    expect(passes(s.glass.back)).toEqual(['PEEL'])
    expect(passes(s.board.front)).toEqual(['A'])
    expect(passes(s.board.back)).toEqual(['A'])
    expect(passes(s.hidden.front)).toEqual(['A'])
  })

  it('draws a translucent part`s edges and everything from 1000 up over the peeled layers', () => {
    const s = split()
    expect(passes(s.glass.edges)).toEqual(['OVERLAY'])
    expect(passes(s.glass.marker)).toEqual(['OVERLAY'])
    expect(passes(s.board.marker)).toEqual(['OVERLAY'])
    expect(passes(s.handle), 'by its group`s renderOrder').toEqual(['OVERLAY'])
    expect(passes(s.board.edges)).toEqual(['A'])
  })

  it('leaves the clipping stencils in pass A and every pick layer where it was', () => {
    const s = split()
    expect(passes(s.glass.stencil)).toEqual(['A'])
    expect(s.glass.front.layers.isEnabled(1)).toBe(true)
    expect(s.glass.edges.layers.isEnabled(2)).toBe(true)
    expect(s.glass.corners.layers.mask, 'the pick-only cloud is not touched').toBe(1 << 3)
  })

  it('lets lights and groups through every pass, so they still light and order it', () => {
    const s = split()
    for (const object of [s.scene, s.light, s.root, s.glass, s.widget]) {
      expect(passes(object)).toEqual(['A', 'PEEL', 'OVERLAY'])
    }
  })
})

describe('the end of the frame', () => {
  it('puts back every mask and the camera`s, and lets go of the objects', () => {
    const s = stage()
    const before = new Map()
    s.scene.traverse((object) => before.set(object, object.layers.mask))
    const cameraMask = s.camera.layers.mask
    const snapshot = { objects: [], masks: [] }

    lib.assignPassLayers(s.scene, s.camera, lib.translucentGroups(s.groups), snapshot)
    s.camera.layers.set(lib.PEEL_LAYER)
    s.camera.layers.set(lib.OVERLAY_LAYER)
    lib.restorePassLayers(snapshot)

    for (const [object, mask] of before) expect(object.layers.mask).toBe(mask)
    expect(s.camera.layers.mask).toBe(cameraMask)
    expect(snapshot).toEqual({ objects: [], masks: [] })
  })
})

describe('the file the hub serves still peels', () => {
  // A rebase of the fork onto a new tag can keep depth-peeling.ts and lose the
  // two places that use it; every test above would stay green and boards would
  // again be drawn over ghosted cases. static/_v/PROVENANCE.md lists the patch;
  // this is the assertion behind that entry.
  it('patches both face materials of a shape', () => {
    expect(SOURCE).toContain('patchPeelMaterial(frontMaterial, this.peelUniforms)')
    expect(SOURCE).toContain('patchPeelMaterial(backMaterial, this.peelUniforms)')
  })

  it('renders the frame and the screenshot through it', () => {
    expect(SOURCE.split('this._depthPeeling.render(').length - 1).toBe(2)
  })

  it('keeps its pass layers clear of the pick layers', () => {
    const block = SOURCE.match(/const PICK_LAYER = (\{[^}]*\});/)
    expect(block, 'the bundle still declares PICK_LAYER').not.toBeNull()
    const pick = Object.values(new Function(`return ${block[1]}`)())
    expect(pick).not.toContain(lib.PEEL_LAYER)
    expect(pick).not.toContain(lib.OVERLAY_LAYER)
    expect(pick).not.toContain(0)
  })
})

/** The whole depth-peeling module out of the bundle, run against three's own
 *  module: from the first layer constant to the end of `class DepthPeeling`. */
function peelingModule() {
  const start = SOURCE.indexOf('const PEEL_LAYER = ')
  const classStart = SOURCE.indexOf('class DepthPeeling {', start)
  if (start < 0 || classStart < 0) {
    throw new Error('the bundle no longer declares the depth-peeling module')
  }
  const end = SOURCE.indexOf('\n}\n', classStart) + 3
  return new Function('THREE', `${SOURCE.slice(start, end)}
return { peelRect, DepthPeeling, createPeelUniforms };`)(THREE)
}

const peeling = peelingModule()

/** A translucent part: a 2 mm cube at `at`, as an ObjectGroup carries it. */
function cube(at = [0, 0, 0]) {
  const group = new THREE.Group()
  group.isObjectGroup = true
  group.front = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5 }))
  group.back = null
  group.edges = null
  group.vertices = null
  group.add(group.front)
  group.position.set(...at)
  return group
}

function topCamera() {
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100)
  camera.position.set(0, 0, 50)
  return camera
}

describe('the rectangle the peel passes are cut to', () => {
  const size = new THREE.Vector2(1000, 800)

  it('holds the projected part and a 2 px margin, not the whole buffer', () => {
    const rect = new THREE.Vector4()
    expect(peeling.peelRect([cube()], topCamera(), size, rect)).toBe(true)
    // The cube spans NDC -0.1..0.1: pixels 450..550 across, 360..440 up.
    expect(rect.x).toBeGreaterThanOrEqual(447)
    expect(rect.x).toBeLessThanOrEqual(448)
    expect(rect.x + rect.z).toBeGreaterThanOrEqual(552)
    expect(rect.x + rect.z).toBeLessThanOrEqual(553)
    expect(rect.y).toBeLessThanOrEqual(358)
    expect(rect.y + rect.w).toBeGreaterThanOrEqual(442)
  })

  it('follows a part the interface moved without updating its matrix', () => {
    const rect = new THREE.Vector4()
    expect(peeling.peelRect([cube([100, 0, 0])], topCamera(), size, rect)).toBe(false)
  })

  it('takes the whole buffer when a corner is behind a perspective camera', () => {
    const camera = new THREE.PerspectiveCamera(50, 1.25, 0.1, 100)
    camera.position.set(0, 0, 0.5)
    const rect = new THREE.Vector4()
    expect(peeling.peelRect([cube()], camera, size, rect)).toBe(true)
    expect(rect.toArray()).toEqual([0, 0, 1000, 800])
  })
})

describe('peeling waits for the camera to settle', () => {
  afterEach(() => vi.useRealTimers())

  /** A renderer that draws nothing and records which path a frame took. */
  function stage() {
    const renderer = {
      render: vi.fn(),
      getDrawingBufferSize: (v) => v.set(1000, 800),
      getRenderTarget: () => null,
      setRenderTarget: vi.fn(),
      getClearAlpha: () => 0,
      getClearColor: (c) => c,
      setClearColor: vi.fn(),
      clear: vi.fn(),
      getScissor: (v) => v,
      getScissorTest: () => false,
      setScissor: vi.fn(),
      setScissorTest: vi.fn(),
      getPixelRatio: () => 1,
    }
    const requestRender = vi.fn()
    const part = cube()
    const scene = new THREE.Scene()
    scene.add(part)
    const nestedGroup = { groups: { '/a': part }, peelUniforms: peeling.createPeelUniforms() }
    const camera = topCamera()
    const peel = new peeling.DepthPeeling(renderer, requestRender)
    const frame = (exact = false) => {
      renderer.render.mockClear()
      renderer.setRenderTarget.mockClear()
      peel.render(scene, camera, nestedGroup, exact)
      return renderer.setRenderTarget.mock.calls.length > 0 ? 'peeled' : 'unpeeled'
    }
    return { renderer, requestRender, camera, peel, frame }
  }

  it('draws a moving camera unpeeled in three passes, then asks for one peeled frame', () => {
    vi.useFakeTimers()
    const s = stage()
    expect(s.frame()).toBe('unpeeled')
    expect(s.renderer.render).toHaveBeenCalledTimes(3)
    expect(s.frame(), 'a second frame of the same step is still the move').toBe('unpeeled')
    expect(s.requestRender).not.toHaveBeenCalled()

    vi.advanceTimersByTime(150)
    expect(s.requestRender).toHaveBeenCalledTimes(1)
    expect(s.frame()).toBe('peeled')
    vi.advanceTimersByTime(1000)
    expect(s.requestRender, 'a still camera asks for nothing more').toHaveBeenCalledTimes(1)
  })

  it('peels a screenshot even mid-move', () => {
    vi.useFakeTimers()
    const s = stage()
    expect(s.frame(true)).toBe('peeled')
  })

  it('stops waiting once disposed', () => {
    vi.useFakeTimers()
    const s = stage()
    s.frame()
    s.peel.dispose()
    vi.advanceTimersByTime(1000)
    expect(s.requestRender).not.toHaveBeenCalled()
  })
})

describe('the shader text the peel patch is spliced into', () => {
  // The discard goes after clipping and the sRGB encoding right after the
  // output encoding, so fog and premultiplication still follow it as they do
  // on the canvas.
  for (const name of ['meshphysical_frag', 'meshbasic_frag']) {
    it(`finds each anchor once in ${name}, the encoding before fog and premultiplication`, () => {
      const shader = THREE.ShaderChunk[name]
      for (const anchor of ['#include <clipping_planes_fragment>', '#include <colorspace_fragment>']) {
        expect(shader.split(anchor).length - 1).toBe(1)
      }
      const at = (chunk) => shader.indexOf(`#include <${chunk}>`)
      expect(at('colorspace_fragment')).toBeLessThan(at('fog_fragment'))
      expect(at('colorspace_fragment')).toBeLessThan(at('premultiplied_alpha_fragment'))
    })
  }

  it('is reached by the screenshot with `exact`', () => {
    expect(SOURCE).toMatch(/_depthPeeling\.render\([^;]*nestedGroup, true\)/)
  })
})
