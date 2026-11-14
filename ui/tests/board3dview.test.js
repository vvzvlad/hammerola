// The 3D view of a board (ui/src/BoardView3D.jsx): when it fetches the model,
// what it does with a model that arrives too late, when it draws, what counts
// as a click and a right click, what the page's bar does with it, the page's
// comments on it, the board's copper in it, and its drawing of the insets.
//
// No GPU here. `loadThree` hands over three itself with the two parts that need
// one replaced — a renderer whose canvas is a plain one and which, as three's
// does before it draws, brings the scene's world matrices up to date, so a
// click is aimed at an arrow where the frame drew it; and a trackball that
// only holds a target and what it was set to, and, as the model's own does in
// its non-tumbling mode, leaves the camera's turn alone on `update` — and a
// loader whose model is a small scene built in the test: a board layer and one
// part, `C1`, or for the copper a board's body, copper and solder mask, named
// in the loader's record as KiCad names them. What the view does to a model
// (board3d.js) runs for real and is tested in board3d.test.js. `fetch` and the
// animation frames are driven by hand.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'
import { mergeGeometries } from '../../static/_v/BufferGeometryUtils.js'

vi.mock('../src/board3d.js', async (importOriginal) => ({ ...(await importOriginal()), loadThree: vi.fn() }))

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import BoardView3D, { CLICK_SLOP, TRACKBALL_SPEEDS } from '../src/BoardView3D.jsx'
import { loadThree, TRACKBALL_URL } from '../src/board3d.js'
import { MEASURE_HINT as BOARD_MEASURE_HINT } from '../src/KicadView.jsx'
import { VIEWER_MODULE_URL } from '../src/viewport/library.js'
import { PIN_PX } from '../src/viewport/options.js'
import { RESIZE_MS } from '../src/viewport/sizing.js'
import { drained, runFrames, stubFrames } from './component.js'
import { collect, texts } from './eltree.js'

/** Every renderer the view made. */
let renderers = []

class Renderer {
  constructor() {
    this.domElement = document.createElement('canvas')
    for (const name of ['setPixelRatio', 'setSize', 'dispose', 'forceContextLoss']) this[name] = vi.fn()
    this.render = vi.fn((scene) => scene.updateMatrixWorld())
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

/** The loader's record of the model's meshes, by which the board's layers are
 *  told apart (`glbLayers`): none unless a test names them. */
let parser = null

/** Stand-ins for the library's screen-wide lines (`lines` of `loadThree`),
 *  which live in its bundle: a geometry that keeps its segments, a material
 *  that keeps what it was made with, and lines that can be dashed. */
class LineSegmentsGeometry extends THREE.BufferGeometry {
  setPositions(segments) {
    this.segments = segments
    return this
  }
}
class LineMaterial extends THREE.Material {
  constructor(parameters) {
    super()
    Object.assign(this, parameters)
  }
}
class LineSegments2 extends THREE.Mesh {
  computeLineDistances() {
    return this
  }
}

class Loader {
  parseAsync() {
    return Promise.resolve({ scene: model, parser })
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

/** An answer read, the two frames that paint its full bar run, and the model
 *  read after them. */
async function arrived() {
  await drained()
  runFrames()
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
  // the shell the view renders the holder into, whose colour the copper a lit
  // net leaves out fades into
  const shell = document.createElement('div')
  shell.style.background = 'rgb(255, 255, 255)'
  shell.append(host)
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
async function loaded(props) {
  const net = fetching()
  const { view, update } = mounted({ active: true, ...props })
  net.answer()
  await arrived()
  const canvas = renderers[0].domElement
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 })
  return { view, update, canvas }
}

/** The vertical field of view the view builds its camera with. */
const FOV_3D = 35

const pointer = (canvas, type, clientX, clientY, button = 0, shiftKey = false) => canvas.dispatchEvent(
  new MouseEvent(type, { clientX, clientY, button, shiftKey, bubbles: true }))
/** Where a world point is drawn on the 200 px canvas `loaded` gives. */
const onCanvas = (view, point) => {
  const at = point.clone().project(view.stage.camera)
  return [(at.x + 1) * 100, (1 - at.y) * 100]
}
const clickAt = (canvas, [x, y], shiftKey = false) => {
  pointer(canvas, 'pointerdown', x, y, 0, shiftKey)
  pointer(canvas, 'pointerup', x, y, 0, shiftKey)
}

beforeEach(() => {
  renderers = []
  trackballs = []
  model = boardScene()
  parser = { json: {}, associations: new Map() }
  stubFrames()
  loadThree.mockResolvedValue({ THREE: { ...THREE, WebGLRenderer: Renderer }, TrackballControls: Trackball, GLTFLoader: Loader,
    mergeGeometries, lines: { LineSegments2, LineSegmentsGeometry, LineMaterial } })
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
    // the model is read only after the second frame, the first that is sure
    // to show that (loadbar.jsx, `painted`)
    await drained()
    expect(renderers).toEqual([])
    runFrames()
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
    for (const name of ['LineSegments2', 'LineSegmentsGeometry', 'LineMaterial']) {
      expect(bundle).toMatch(new RegExp(`^export \\{[^}]*\\b${name}\\b`, 'm'))
    }
    const factors = bundle.match(/trackball: \{\s*pan: ([\d.]+),\s*rotate: ([\d.]+),\s*zoom: ([\d.]+),/)
    const defaults = ['panSpeed', 'rotateSpeed', 'zoomSpeed'].map((key) => bundle.match(new RegExp(`\\b${key}: ([\\d.]+),`))[1])
    expect(defaults).toEqual(['1.0', '1.0', '1.0'])
    expect(TRACKBALL_SPEEDS).toEqual({ panSpeed: Number(factors[1]), rotateSpeed: Number(factors[2]), zoomSpeed: Number(factors[3]) })
    expect(view.props.onTools).toHaveBeenCalledTimes(1)
  })

  it('resizes its canvas on a resize of its holder at once and once more at the end of the window, its camera on every tick', async () => {
    // Each resize reallocates the canvas's multisampled buffer (RESIZE_MS in viewport/sizing.js);
    // the camera follows the holder meanwhile, as CSS stretches the old buffer over it.
    let tick = null
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { tick = callback }
      observe() {}
      disconnect() {}
    })
    const { view } = await loaded()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    onTestFinished(() => vi.useRealTimers())
    let width = 400
    Object.defineProperties(view.stage.host, { clientWidth: { get: () => width }, clientHeight: { value: 300 } })
    const { setSize } = renderers[0]
    setSize.mockClear()
    const aspects = []
    for (const w of [400, 500, 600]) {
      width = w
      tick()
      aspects.push(view.stage.camera.aspect)
    }
    expect(aspects).toEqual([400 / 300, 500 / 300, 600 / 300])
    expect(setSize.mock.calls.map(([w]) => w)).toEqual([400])
    vi.advanceTimersByTime(RESIZE_MS)
    expect(setSize.mock.calls.map(([w]) => w)).toEqual([400, 600])
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

describe('comments on the 3D view of a board', () => {
  /** The part's place: lifted off the board, where a pointer on its centre picks it. */
  const LIFTED = new THREE.Vector3(0, 3, 0)
  beforeEach(() => {
    model.children[0].children[1].position.copy(LIFTED)
  })

  /** What the model's page hands the view for its comments (`comment`). */
  const commenting = (extra) => ({ on: false, marks: [], focus: null, onPoint: vi.fn(), onMarker: vi.fn(),
    onLost: vi.fn(), onFocused: vi.fn(), ...extra })
  /** A comment on `part`, on the top face of `C1`'s box in that part's frame. */
  const markOn = (id, part) => ({ id, part, point: [0, 400, 0], normal: [0, 1, 0], active: false })

  it('takes a click on a part with the tool armed for a comment\'s place, in the part\'s own millimetres, selecting nothing', async () => {
    const comment = commenting({ on: true })
    const { view, update, canvas } = await loaded({ comment })
    clickAt(canvas, onCanvas(view, LIFTED))
    expect(comment.onPoint).toHaveBeenCalledTimes(1)
    const [[{ part, point, normal }]] = comment.onPoint.mock.calls
    // The top face of the part's box, 0.4 m over the part's origin and 3.4 m
    // over the world's, facing up; to the float32 the geometry is held in.
    expect(part).toBe('C1')
    expect([point[0], point[1]]).toEqual([expect.closeTo(0, 3), expect.closeTo(400, 3)])
    expect(point[2]).toBeGreaterThan(0)
    expect(point[2]).toBeLessThan(400)
    expect(new THREE.Vector3(...normal).distanceTo(new THREE.Vector3(0, 1, 0))).toBeCloseTo(0, 6)
    expect(view.stage.selected).toBeNull()
    // off the part, on the board: no place, and still no selection
    clickAt(canvas, [100, 100])
    // the tool put away, the same click on the part selects it
    update({ comment: { ...comment, on: false } })
    clickAt(canvas, onCanvas(view, LIFTED))
    expect(comment.onPoint).toHaveBeenCalledTimes(1)
    expect(view.props.onSelect.mock.calls).toEqual([['C1']])
  })

  it('opens the comment whose arrow is clicked, the tool armed or not, selecting and placing nothing', async () => {
    const comment = commenting({ marks: [markOn('c1', 'C1')] })
    const { view, update, canvas } = await loaded({ comment })
    runFrames()
    // the arrow's tip on the mark's point, put in the world through the part
    const [arrow] = view.stage.pins.children
    expect(arrow.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(0, 3.4, 0))).toBeCloseTo(0, 6)
    // on its shaft, which stands up off the part's top face
    const shaft = onCanvas(view, arrow.localToWorld(new THREE.Vector3(0, PIN_PX * 0.75, 0)))
    clickAt(canvas, shaft)
    update({ comment: { ...comment, on: true } })
    clickAt(canvas, shaft)
    expect(comment.onMarker.mock.calls).toEqual([['c1'], ['c1']])
    expect([view.props.onSelect.mock.calls, comment.onPoint.mock.calls]).toEqual([[], []])
  })

  it('tells the page which comments stand on a part the model lacks, only as that set changes', async () => {
    const comment = commenting({ marks: [markOn('c1', 'C1'), markOn('c2', 'R9')] })
    const { update } = await loaded({ comment })
    expect(comment.onLost.mock.calls).toEqual([[['c2']]])
    // drawn again, and with a comment the model has: the same set, nothing told
    update({ selected: 'C1' })
    update({ comment: { ...comment, marks: [...comment.marks, markOn('c3', 'C1')] } })
    expect(comment.onLost).toHaveBeenCalledTimes(1)
    // the lost one gone from the page: an empty set
    update({ comment: { ...comment, marks: [markOn('c1', 'C1')] } })
    expect(comment.onLost.mock.calls).toEqual([[['c2']], [[]]])
  })

  it('frames a part the page asks to be shown, once for each ask, and says it is done', async () => {
    const comment = commenting({ focus: { part: 'C1' } })
    const { view, update } = await loaded({ comment })
    const { controls } = view.stage
    expect(controls.target.distanceTo(LIFTED)).toBeCloseTo(0, 6)
    expect(comment.onFocused).toHaveBeenCalledTimes(1)
    // the reader looks elsewhere; drawn again with the same ask, the camera stays
    controls.target.set(9, 9, 9)
    update({ comment: { ...comment } })
    expect(controls.target.toArray()).toEqual([9, 9, 9])
    expect(comment.onFocused).toHaveBeenCalledTimes(1)
    // the row clicked again: a new ask
    update({ comment: { ...comment, focus: { part: 'C1' } } })
    expect(controls.target.distanceTo(LIFTED)).toBeCloseTo(0, 6)
    expect(comment.onFocused).toHaveBeenCalledTimes(2)
  })
})

describe('measuring on the 3D view of a board', () => {
  /** The part's place, ten times its size: a box from (−8, 1, −4) to
   *  (8, 9, 4) over the board, its corners drawn more than SNAP_PX apart. */
  const PART = new THREE.Vector3(0, 5, 0)
  beforeEach(() => {
    model.children[0].children[1].position.copy(PART)
    model.children[0].children[1].scale.setScalar(10)
  })

  /** What the bar was last told it can do. */
  const tools = (view) => view.props.onTools.mock.calls.at(-1)[0]
  /** What the reader sees of the measurement: whether the dots of A and B
   *  show, and the label, null while hidden. */
  const shown = (view) => {
    runFrames()
    const { dots, label } = view.stage
    return [...dots.map((dot) => dot.style.display !== 'none'), label.style.display === 'none' ? null : label.textContent]
  }
  /** A pointer 4 px from where `corner` is drawn, toward where `middle` is:
   *  on a face beside the corner. */
  const beside = (view, corner, middle) => {
    const at = new THREE.Vector2(...onCanvas(view, corner))
    return at.add(new THREE.Vector2(...onCanvas(view, middle)).sub(at).normalize().multiplyScalar(4)).toArray()
  }

  it('measures from a point to a second one, each snapped to the corner beside it, and starts over at a third', async () => {
    // The owner: "я не могу напримре измерить дырку в плате"; he chose points
    // that snap to the nearest corner or edge, the 2D board's way.
    const { view, canvas } = await loaded({ onNet: vi.fn() })
    const off = tools(view)
    expect(off.measure).toEqual({ on: false, toggle: expect.any(Function), hint: BOARD_MEASURE_HINT })
    off.measure.toggle()
    expect([tools(view).measure.on, canvas.style.cursor]).toEqual([true, 'crosshair'])
    // A by the board's top front right corner, B by the part's
    const a = beside(view, new THREE.Vector3(25, 0.8, 20), new THREE.Vector3(0, 0.8, 0))
    const b = beside(view, new THREE.Vector3(8, 9, 4), PART)
    clickAt(canvas, a)
    expect(shown(view)).toEqual([true, false, null])
    clickAt(canvas, b)
    // 17 along the board's X, 16 along its Y (the world's z), 8.2 up; glTF metres in mm
    expect(shown(view)).toEqual([true, true, '24743.484 mm\nX 17000.000  Y 16000.000  Z 8200.000'])
    // a third is a new A, B gone
    clickAt(canvas, a)
    expect(shown(view)).toEqual([true, false, null])
    // nothing under the pointer clears the points
    clickAt(canvas, [1, 1])
    expect(shown(view)).toEqual([false, false, null])
    expect([view.props.onSelect.mock.calls, view.props.onNet.mock.calls, view.stage.selected]).toEqual([[], [], null])
    // the right button selects and opens the menu as ever
    const part = onCanvas(view, PART)
    pointer(canvas, 'pointerdown', ...part, 2)
    pointer(canvas, 'pointerup', ...part, 2)
    expect([view.props.onSelect.mock.calls, view.props.onMenu.mock.calls]).toEqual([[['C1']], [['C1', ...part]]])
  })

  it('places a point where the click hits with Shift held, and never snaps to a corner the part hides', async () => {
    const { view, canvas } = await loaded()
    tools(view).measure.toggle()
    const corner = new THREE.Vector3(25, 0.8, 20)
    clickAt(canvas, beside(view, corner, new THREE.Vector3(0, 0.8, 0)), true)
    const [free] = view.stage.points
    expect([free.y, free.distanceTo(corner) > 0.1]).toEqual([expect.closeTo(0.8, 6), true])
    // the part's bottom back corner is drawn under its top face, where the
    // click lands: the point stays on the top face
    const hidden = new THREE.Vector3(8, 1, -4)
    clickAt(canvas, onCanvas(view, hidden))
    expect(view.stage.points[1].y).toBeCloseTo(9, 6)
  })

  it('takes Escape for the points, then for measuring, then not at all, the bar told the same object per state', async () => {
    const { view, canvas } = await loaded()
    const off = tools(view)
    expect(view.escapeMeasure()).toBe(false)
    off.measure.toggle()
    const on = tools(view)
    clickAt(canvas, onCanvas(view, PART))
    expect(shown(view)).toEqual([true, false, null])
    expect(view.escapeMeasure()).toBe(true)
    expect([shown(view), tools(view)]).toEqual([[false, false, null], on])
    expect(view.escapeMeasure()).toBe(true)
    expect(canvas.style.cursor).toBe('')
    expect(view.escapeMeasure()).toBe(false)
    // the page compares what it is told by identity
    expect(view.props.onTools.mock.calls.map(([told]) => [told === off, told === on])).toEqual([
      [true, false], [false, true], [true, false]])
    // a click selects again
    clickAt(canvas, onCanvas(view, PART))
    expect(view.props.onSelect.mock.calls).toEqual([['C1']])
  })

  it('stops measuring, its points cleared, when the Comment tool is armed here', async () => {
    const comment = { on: false, marks: [], focus: null, onPoint: vi.fn(), onMarker: vi.fn(), onLost: vi.fn(),
      onFocused: vi.fn() }
    const { view, update, canvas } = await loaded({ comment })
    tools(view).measure.toggle()
    clickAt(canvas, onCanvas(view, PART))
    update({ comment: { ...comment, on: true } })
    expect([tools(view).measure.on, shown(view), canvas.style.cursor]).toEqual([false, [false, false, null], 'crosshair'])
    // the click is the comment's again
    clickAt(canvas, onCanvas(view, PART))
    expect(comment.onPoint).toHaveBeenCalledTimes(1)
  })
})

describe('the board\'s copper in the 3D view', () => {
  /** The board's layers as KiCad exports them, in metres: the body, its
   *  copper and the solder mask over it, told apart by their meshes' names. */
  let layers = null
  beforeEach(() => {
    const slab = (bottom, top) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.05, (top - bottom) / 1000, 0.04), new THREE.MeshStandardMaterial())
      mesh.position.set(0.025, (bottom + top) / 2000, 0.02)
      return mesh
    }
    layers = { body: slab(0, 1.51), copper: slab(1.51, 1.545), mask: slab(1.545, 1.56) }
    model = new THREE.Group().add(new THREE.Group().add(layers.body, layers.copper, layers.mask))
    parser = { json: { meshes: [{ name: 'b_PCB' }, { name: 'b_copper' }, { name: 'b_soldermask' }] },
      associations: new Map([layers.body, layers.copper, layers.mask].map((node, meshes) => [node, { meshes }])) }
  })

  /** Our copper as the board's element hands it (`readCopper`): on F.Cu, a
   *  square of the net A from 10 to 30 mm each way. */
  const COPPER = {
    nets: ['', 'A'],
    layers: [{ name: 'F.Cu', bottom: 1.51, top: 1.545, triangles: new Float32Array([10, 10, 30, 10, 30, 30, 10, 10, 30, 30, 10, 30]),
      nets: new Uint32Array(6).fill(1) }],
    barrels: [],
    colours: { 'F.Cu': 'rgb(200, 60, 40)' },
  }

  it('takes a click on copper, through the solder mask over it, for its net, selecting no part', async () => {
    const { view, canvas } = await loaded({ copper: () => COPPER, onNet: vi.fn() })
    clickAt(canvas, onCanvas(view, new THREE.Vector3(0.02, 0.001545, 0.02)))
    // what the pointer meets first is the mask
    expect(view.stage.raycaster.intersectObjects([view.stage.root], true)[0].object).toBe(layers.mask)
    expect(view.props.onNet.mock.calls).toEqual([['A']])
    expect(view.props.onSelect.mock.calls).toEqual([[null]])
    // off our copper, on the bare board: no net
    clickAt(canvas, onCanvas(view, new THREE.Vector3(0.04, 0.00156, 0.035)))
    expect(view.props.onNet).toHaveBeenCalledTimes(1)
    expect(view.props.onSelect.mock.calls).toEqual([[null], [null]])
  })

  it('takes no click on copper past the board\'s edge, which it does not draw', async () => {
    // F.Cu from 40 to 55 mm across a body that ends at 50
    const past = { ...COPPER, layers: [{ ...COPPER.layers[0], triangles: new Float32Array([40, 10, 55, 10, 55, 30, 40, 10, 55, 30, 40, 30]) }] }
    const { view, canvas } = await loaded({ copper: () => past, onNet: vi.fn() })
    clickAt(canvas, onCanvas(view, new THREE.Vector3(0.045, 0.001545, 0.02)))
    expect(view.props.onNet.mock.calls).toEqual([['A']])
    clickAt(canvas, onCanvas(view, new THREE.Vector3(0.0525, 0.001545, 0.02)))
    expect(view.props.onNet).toHaveBeenCalledTimes(1)
  })

  it('hides the .glb\'s copper once the board hands over ours, which it builds once', async () => {
    let handed = null
    const copper = vi.fn(() => handed)
    const { view, update } = await loaded({ copper })
    expect([layers.copper.visible, view.stage.copper]).toEqual([true, null])
    handed = COPPER
    update({})
    expect(layers.copper.visible).toBe(false)
    expect(view.stage.copper.group.parent).toBe(view.stage.root)
    update({ selected: null })
    expect(copper).toHaveBeenCalledTimes(2)
  })

  it('puts Isolate out with the net it isolates, so the next net lit is drawn with the rest', async () => {
    const { view, update } = await loaded({ copper: () => COPPER, net: 'A' })
    view.onIsolate()
    update({})
    expect(view.stage.copper.shared.isolate.value).toBe(true)
    update({ net: null })
    expect(view.state.isolate).toBe(false)
    update({ net: 'A' })
    expect(view.stage.copper.shared.isolate.value).toBe(false)
  })

  it('separates the layers only while Stackup separation is ticked, its slider shown only then', async () => {
    // two layers, F.Cu over B.Cu, so the separation has something to part
    const two = { ...COPPER, layers: [...COPPER.layers, { ...COPPER.layers[0], name: 'B.Cu', bottom: -0.035, top: 0 }],
      colours: { ...COPPER.colours, 'B.Cu': 'rgb(40, 60, 200)' } }
    const { view, update } = await loaded({ copper: () => two })
    const drawn = (take) => collect(view.render(), (el) => (take(el.props) ? el : undefined))
    const tick = () => {
      drawn((props) => props['data-stacked'])[0].props.onChange()
      update({})
    }
    const slider = () => drawn((props) => props.type === 'range').map((el) => el.props.value)
    const raised = () => view.stage.copper.layers[0].mesh.position.y
    // unticked: no slider, the board drawn whole
    expect([drawn((props) => props['data-stacked'])[0].props.checked, slider(), raised()]).toEqual([false, [], 0])
    // the first tick parts the stack from the slider's middle
    tick()
    expect(drawn((props) => props['data-stacked'])[0].props.checked).toBe(true)
    expect(slider()).toEqual([0.5])
    const half = raised()
    expect(half).toBeGreaterThan(0)
    // moved, unticked: the board whole again, and the slider's place kept for the next tick
    drawn((props) => props.type === 'range')[0].props.onChange({ target: { value: '1' } })
    update({})
    expect(raised()).toBeGreaterThan(half)
    tick()
    expect([slider(), raised()]).toEqual([[], 0])
    tick()
    expect(slider()).toEqual([1])
  })
})

describe('the 3D view of the board\'s insets', () => {
  it('loads the model off screen when an inset asks, once, and tells the inset it is ready', async () => {
    const net = fetching()
    const { view } = mounted()
    const heard = []
    view.scene3d.subscribe(() => heard.push(view.scene3d.state()))
    view.scene3d.load()
    view.scene3d.load()
    expect([net.fetch.mock.calls.length, view.scene3d.state()]).toEqual([1, 'loading'])
    net.answer()
    await arrived()
    view.scene3d.load()
    expect([net.fetch.mock.calls.length, heard]).toEqual([1, ['ready']])
  })

  it('draws its own frame again after an inset\'s, whose resizing cleared the canvas on screen', async () => {
    const { view } = await loaded()
    runFrames()
    document.createElement('div').append(view.host)
    Object.defineProperties(view.host, { clientWidth: { value: 200 }, clientHeight: { value: 150 } })
    const inset = document.createElement('canvas')
    Object.defineProperties(inset, { clientWidth: { value: 120 }, clientHeight: { value: 80 } })
    inset.getContext = () => ({ fillRect: vi.fn(), drawImage: vi.fn() })
    const camera = { center: { x: 0, y: 0 }, zoom: 4, rotation: 0, mirror: false, view3d: true, tilt: 0 }
    // What the renderer did, in order: `size` where three resizes, and so
    // clears, the canvas (its `setPixelRatio` resizes too), and each frame by
    // the camera it was drawn through.
    const renderer = renderers[0]
    const journal = []
    renderer.setSize.mockImplementation(() => journal.push('size'))
    renderer.setPixelRatio.mockImplementation(() => journal.push('size'))
    renderer.render.mockImplementation((scene, used) => {
      scene.updateMatrixWorld()
      journal.push(used === view.stage.camera ? 'view' : used.isOrthographicCamera ? 'inset' : used)
    })
    expect(view.scene3d.render(camera, inset, false)).toBe(true)
    expect(journal.filter((entry) => entry !== 'size')).toEqual(['inset', 'view'])
    expect(journal.slice(-2)).toEqual(['size', 'view'])
    // and nothing left to draw the same picture once more
    runFrames()
    expect(journal.at(-1)).toBe('view')
    expect(journal.filter((entry) => entry === 'view')).toHaveLength(1)
  })
})
