// The 3D view of a board (ui/src/BoardView3D.jsx): when it fetches the model,
// what it does with a model that arrives too late, when it draws, what counts
// as a click and a right click, and what the page's bar does with it.
//
// No GPU here. `loadThree` hands over three itself with the two parts that need
// one replaced — a renderer whose canvas is a plain one, and a trackball that
// only holds a target and what it was set to, and, as the model's own does in
// its non-tumbling mode, leaves the camera's turn alone on `update` — and a
// loader whose model is a small scene built in the test: a board layer and one
// part, `C1`. What the view does to a model
// (board3d.js) runs for real and is tested in board3d.test.js. `fetch` and the
// animation frames are driven by hand.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'
import { mergeGeometries } from '../../static/_v/BufferGeometryUtils.js'

vi.mock('../src/board3d.js', async (importOriginal) => ({ ...(await importOriginal()), loadThree: vi.fn() }))

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import BoardView3D, { CLICK_SLOP, TRACKBALL_SPEEDS } from '../src/BoardView3D.jsx'
import { loadThree, TRACKBALL_URL } from '../src/board3d.js'
import { VIEWER_MODULE_URL } from '../src/viewport/library.js'
import { drained, runFrames, stubFrames } from './component.js'
import { texts } from './eltree.js'

/** Every renderer the view made. */
let renderers = []

class Renderer {
  constructor() {
    this.domElement = document.createElement('canvas')
    for (const name of ['setPixelRatio', 'setSize', 'render', 'dispose', 'forceContextLoss']) this[name] = vi.fn()
    renderers.push(this)
  }
}

/** Every trackball the view made. */
let trackballs = []

class Trackball {
  constructor(camera, element) {
    this.camera = camera
    this.element = element
    this.target = new THREE.Vector3()
    this.enabled = true
    this.handleResize = vi.fn()
    trackballs.push(this)
  }

  addEventListener() {}

  update() {
    this.camera.updateMatrixWorld()
  }

  dispose() {}
}

/** The model the loader hands over: a board layer and the part `C1` under an
 *  unnamed top node, as KiCad exports one. */
let model = null

function boardScene() {
  const scene = new THREE.Group()
  const top = new THREE.Group()
  const layer = new THREE.Mesh(new THREE.BoxGeometry(50, 1.6, 40), new THREE.MeshStandardMaterial())
  layer.userData.name = '=>[0:1:1:98]'
  const part = new THREE.Group()
  part.userData.name = 'C1'
  part.add(new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.8, 0.8), new THREE.MeshStandardMaterial()))
  top.add(layer, part)
  scene.add(top)
  return scene
}

class Loader {
  parseAsync() {
    return Promise.resolve({ scene: model, parser: { json: {}, associations: new Map() } })
  }
}

/** A fetch answered when the test says so: `answer(ok)`. */
function fetching() {
  const calls = []
  const fetch = vi.fn(() => new Promise((resolve) => {
    calls.push((ok = true) => resolve(new Response(ok ? new ArrayBuffer(8) : null, { status: ok ? 200 : 404 })))
  }))
  vi.stubGlobal('fetch', fetch)
  return { fetch, answer: (ok) => calls.shift()(ok) }
}

/** An answer read, the frame that paints its full bar run, and the model
 *  read after it. */
async function arrived() {
  await drained()
  runFrames()
  await drained()
}

/** The view, mounted with its holder, and a way to hand it new props. */
function mounted(props) {
  const view = new BoardView3D({ url: '/b/board.glb', bytes: 8_000_000, active: false, selected: null,
    onSelect: vi.fn(), onMenu: vi.fn(), onTools: vi.fn(), onFetched: vi.fn(), ...props })
  view.setState = (patch) => Object.assign(view.state, patch)
  const host = document.createElement('div')
  host.style.color = 'rgb(0, 102, 204)'
  view.setHost(host)
  view.componentDidMount()
  const update = (patch) => {
    const prev = view.props
    view.props = { ...prev, ...patch }
    view.componentDidUpdate(prev)
  }
  return { view, update }
}

/** The view with its model loaded and on screen. */
async function loaded() {
  const net = fetching()
  const { view, update } = mounted({ active: true })
  net.answer()
  await arrived()
  const canvas = renderers[0].domElement
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 })
  return { view, update, canvas }
}

/** The vertical field of view the view builds its camera with. */
const FOV_3D = 35

const pointer = (canvas, type, clientX, clientY, button = 0) => canvas.dispatchEvent(
  new MouseEvent(type, { clientX, clientY, button, bubbles: true }))

beforeEach(() => {
  renderers = []
  trackballs = []
  model = boardScene()
  stubFrames()
  loadThree.mockResolvedValue({ THREE: { ...THREE, WebGLRenderer: Renderer }, TrackballControls: Trackball, GLTFLoader: Loader,
    mergeGeometries })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the 3D view of a board', () => {
  it('fetches the model when first shown, and once however often it is shown while it loads', async () => {
    const net = fetching()
    const { update } = mounted()
    expect(net.fetch).not.toHaveBeenCalled()
    update({ active: true })
    update({ active: false })
    update({ active: true })
    expect(net.fetch).toHaveBeenCalledTimes(1)
    expect(net.fetch).toHaveBeenCalledWith('/b/board.glb')
    net.answer()
    await arrived()
    expect(renderers).toHaveLength(1)
  })

  it('after a failure, fetches again only when it is shown again', async () => {
    const net = fetching()
    const { view, update } = mounted({ active: true })
    net.answer(false)
    await drained()
    expect(view.state.error).toBe('The 3D model did not load: HTTP 404')
    // the design waiting on the model hears of the failure; the bar has nothing to drive
    expect(view.props.onFetched).toHaveBeenCalledTimes(1)
    expect(view.props.onTools).not.toHaveBeenCalled()
    update({ selected: 'C1' })
    expect(net.fetch).toHaveBeenCalledTimes(1)
    update({ active: false })
    update({ active: true })
    expect(net.fetch).toHaveBeenCalledTimes(2)
    expect(view.state.error).toBe('')
  })

  it('fills a bar to the model\'s size, paints it full before reading the model, and tells the design it is in', async () => {
    const net = fetching()
    const { view } = mounted({ active: true })
    expect(texts(view.render())).toEqual(['Loading… 0.0 / 8.0 MB'])
    net.answer()
    await drained()
    expect(texts(view.render())).toEqual(['Preparing…'])
    expect(view.props.onFetched).toHaveBeenCalledTimes(1)
    // the model is read only after a frame has shown that
    await drained()
    expect(renderers).toEqual([])
    runFrames()
    await drained()
    expect(renderers).toHaveLength(1)
    expect(texts(view.render())).toEqual([])
  })

  it('frees a model that arrives after it is gone, and makes nothing of it', async () => {
    const net = fetching()
    const { view } = mounted({ active: true })
    const freed = vi.fn()
    model.traverse((object) => object.geometry && object.geometry.addEventListener('dispose', freed))
    view.componentWillUnmount()
    view.setHost(null)
    net.answer()
    await arrived()
    expect(freed).toHaveBeenCalledTimes(2)
    expect(renderers).toEqual([])
    expect(view.stage).toBeNull()
  })

  it('draws while on screen and cancels the frame it asked for when hidden', async () => {
    const { update } = await loaded()
    runFrames()
    expect(renderers[0].render).toHaveBeenCalledTimes(1)
    update({ selected: 'C1' })
    update({ active: false })
    runFrames()
    expect(renderers[0].render).toHaveBeenCalledTimes(1)
  })

  it('takes a press and release within CLICK_SLOP for a click, and a longer drag for none', async () => {
    const { view, canvas } = await loaded()
    pointer(canvas, 'pointerdown', 100, 100)
    pointer(canvas, 'pointerup', 100 + CLICK_SLOP + 1, 100)
    expect(view.props.onSelect).not.toHaveBeenCalled()
    pointer(canvas, 'pointerdown', 100, 100)
    pointer(canvas, 'pointerup', 100 + CLICK_SLOP, 100)
    expect(view.props.onSelect).toHaveBeenCalledTimes(1)
  })

  it('takes a right click on a part for a click that also asks for the menu there', async () => {
    // the part lifted off the board, where a pointer on its centre picks it
    model.children[0].children[1].position.y = 3
    const { view, canvas } = await loaded()
    const at = view.stage.parts.get('C1')[0].getWorldPosition(new THREE.Vector3()).project(view.stage.camera)
    const [x, y] = [(at.x + 1) * 100, (1 - at.y) * 100]
    const click = (button, ux = x, uy = y, downButton = button) => {
      pointer(canvas, 'pointerdown', ux, uy, downButton)
      pointer(canvas, 'pointerup', ux, uy, button)
    }
    // a right drag pans; a press of one button released with the other is no click
    pointer(canvas, 'pointerdown', x, y, 2)
    pointer(canvas, 'pointerup', x + CLICK_SLOP + 1, y, 2)
    click(2, x, y, 0)
    expect(view.props.onSelect).not.toHaveBeenCalled()
    click(2)
    expect(view.props.onSelect.mock.calls).toEqual([['C1']])
    expect(view.props.onMenu.mock.calls).toEqual([['C1', x, y]])
    expect(view.stage.selected).toBe('C1')
    // the left button only selects; a right click off the part puts it out and asks for nothing
    click(0)
    click(2, 1, 1)
    expect(view.props.onSelect.mock.calls).toEqual([['C1'], ['C1'], [null]])
    expect(view.props.onMenu).toHaveBeenCalledTimes(1)
  })

  it('turns under the model\'s trackball, at the model\'s speeds, measured against its canvas', async () => {
    const { view, canvas } = await loaded()
    const [trackball] = trackballs
    expect(trackball.element).toBe(canvas)
    expect(trackball).toMatchObject(TRACKBALL_SPEEDS)
    // It measures a drag against the canvas's box, which it caches: a resize
    // of the holder hands it the new one.
    Object.defineProperty(view.stage.host, 'clientWidth', { value: 400 })
    Object.defineProperty(view.stage.host, 'clientHeight', { value: 300 })
    view.stage.resize()
    expect(trackball.handleResize).toHaveBeenCalled()
    // the class is the library's, from the URL the model's page loads it by
    expect(TRACKBALL_URL).toBe(VIEWER_MODULE_URL)
    // the speeds are the library's defaults, 1.0 each, times its trackball's factors
    const bundle = readFileSync(resolve(process.cwd(), '../static/_v/three-cad-viewer.esm.js'), 'utf8')
    // The class is read off the bundle by NAME (loadThree), so a lost export
    // survives every gate and kills the view only in a browser — the same
    // failure ui/tests/picking.test.js guards its `export { THREE }` against.
    expect(bundle).toContain('CADTrackballControls,')
    const factors = bundle.match(/trackball: \{\s*pan: ([\d.]+),\s*rotate: ([\d.]+),\s*zoom: ([\d.]+),/)
    const defaults = ['panSpeed', 'rotateSpeed', 'zoomSpeed'].map((key) => bundle.match(new RegExp(`\\b${key}: ([\\d.]+),`))[1])
    expect(defaults).toEqual(['1.0', '1.0', '1.0'])
    expect(TRACKBALL_SPEEDS).toEqual({ panSpeed: Number(factors[1]), rotateSpeed: Number(factors[2]), zoomSpeed: Number(factors[3]) })
    expect(view.props.onTools).toHaveBeenCalledTimes(1)
  })

  it('tells the bar it can fit and frame once the model is drawn, and nothing before', async () => {
    const net = fetching()
    const { view } = mounted({ active: true })
    expect(view.props.onTools).not.toHaveBeenCalled()
    net.answer()
    await arrived()
    const [[tools]] = view.props.onTools.mock.calls
    const { camera, controls } = view.stage
    const first = [camera.position.clone(), controls.target.clone(), camera.quaternion.clone()]

    // turned, rolled and moved away; Fit puts back the frame it opened in
    camera.up.set(1, 0, 0)
    camera.position.set(40, -30, 90)
    controls.target.set(5, 5, 5)
    camera.lookAt(controls.target)
    tools.fit()
    expect(camera.position.distanceTo(first[0])).toBeCloseTo(0, 6)
    expect(controls.target.distanceTo(first[1])).toBeCloseTo(0, 6)
    expect(Math.abs(camera.quaternion.dot(first[2]))).toBeCloseTo(1, 6)

    // Frame draws now and reads the canvas in the same task
    const blob = new Blob(['png'], { type: 'image/png' })
    const canvas = renderers[0].domElement
    canvas.toBlob = vi.fn((done, type) => {
      expect(type).toBe('image/png')
      expect(renderers[0].render).toHaveBeenCalled()
      done(blob)
    })
    renderers[0].render.mockClear()
    await expect(tools.frame()).resolves.toBe(blob)
    expect(canvas.toBlob).toHaveBeenCalledTimes(1)
  })

  it('moves the board under a two-finger swipe and zooms about the pointer on a pinch, the trackball never seeing it', async () => {
    const { view, canvas } = await loaded()
    const { camera, controls } = view.stage
    // The trackball listens on the canvas itself; this stands in for its handler.
    const trackball = vi.fn()
    canvas.addEventListener('wheel', trackball)
    const wheel = (init) => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
      canvas.dispatchEvent(event)
      return event
    }
    const axes = () => [
      new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0),
      new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)]
    /** How much world a CSS pixel is worth where the camera is looking. */
    const perPixel = () => (2 * camera.position.distanceTo(controls.target)
      * Math.tan((FOV_3D / 2) * (Math.PI / 180))) / 200

    const [right, up] = axes()
    const pixel = perPixel()
    const was = { position: camera.position.clone(), target: controls.target.clone(), eye: camera.position.clone().sub(controls.target) }
    const swiped = wheel({ deltaX: -15, deltaY: 25, clientX: 100, clientY: 100 })
    expect([swiped.defaultPrevented, trackball.mock.calls.length]).toEqual([true, 0])
    // The board follows the fingers — 15 px right and 25 px up — so the camera
    // and what it looks at go the other way, together: a swipe pans, it does
    // not turn.
    const moved = right.clone().multiplyScalar(-15 * pixel).add(up.clone().multiplyScalar(-25 * pixel))
    expect(camera.position.clone().sub(was.position).distanceTo(moved)).toBeCloseTo(0, 6)
    expect(controls.target.clone().sub(was.target).distanceTo(moved)).toBeCloseTo(0, 6)
    expect(camera.position.clone().sub(controls.target).distanceTo(was.eye)).toBeCloseTo(0, 6)

    // A pinch arrives as a wheel event with Control held: the board point under
    // the pointer stays under it, in the plane the camera is looking at.
    const at = { clientX: 160, clientY: 40 }
    const under = () => {
      const [r, u] = axes()
      const half = camera.position.distanceTo(controls.target) * Math.tan((FOV_3D / 2) * (Math.PI / 180))
      const across = (at.clientX / 200) * 2 - 1
      const down = (at.clientY / 200) * 2 - 1
      return controls.target.clone().add(r.multiplyScalar(across * half * camera.aspect))
        .add(u.multiplyScalar(-down * half))
    }
    const point = under()
    const distance = camera.position.distanceTo(controls.target)
    const pinched = wheel({ ctrlKey: true, deltaY: -20, ...at })
    expect(pinched.defaultPrevented).toBe(true)
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(distance / Math.exp(0.2), 6)
    expect(under().distanceTo(point)).toBeCloseTo(0, 6)
    expect(trackball).not.toHaveBeenCalled()
  })
})
