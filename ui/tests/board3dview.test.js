// The 3D view of a board (ui/src/BoardView3D.jsx): when it fetches the model,
// what it does with a model that arrives too late, when it draws, and what
// counts as a click.
//
// No GPU here. `loadThree` hands over three itself with the two parts that need
// one replaced — a renderer whose canvas is a plain one, and orbit controls that
// only hold a target — and a loader whose model is a small scene built in the
// test: a board layer and one part, `C1`. What the view does to a model
// (board3d.js) runs for real and is tested in board3d.test.js. `fetch` and the
// animation frames are driven by hand.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'
import { mergeGeometries } from '../../static/_v/BufferGeometryUtils.js'

vi.mock('../src/board3d.js', async (importOriginal) => ({ ...(await importOriginal()), loadThree: vi.fn() }))

import BoardView3D, { CLICK_SLOP } from '../src/BoardView3D.jsx'
import { loadThree } from '../src/board3d.js'
import { drained, runFrames, stubFrames } from './component.js'

/** Every renderer the view made. */
let renderers = []

class Renderer {
  constructor() {
    this.domElement = document.createElement('canvas')
    for (const name of ['setPixelRatio', 'setSize', 'render', 'dispose', 'forceContextLoss']) this[name] = vi.fn()
    renderers.push(this)
  }
}

class Controls {
  constructor() {
    this.target = new THREE.Vector3()
    this.enabled = true
  }

  addEventListener() {}

  update() {}

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
    calls.push((ok = true) => resolve({ ok, status: ok ? 200 : 404, arrayBuffer: async () => new ArrayBuffer(8) }))
  }))
  vi.stubGlobal('fetch', fetch)
  return { fetch, answer: (ok) => calls.shift()(ok) }
}

/** The view, mounted with its holder, and a way to hand it new props. */
function mounted(props) {
  const view = new BoardView3D({ url: '/b/board.glb', active: false, selected: null, onSelect: vi.fn(), onJump: vi.fn(), ...props })
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
  await drained()
  const canvas = renderers[0].domElement
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 })
  return { view, update, canvas }
}

const pointer = (canvas, type, clientX, clientY) => canvas.dispatchEvent(
  new MouseEvent(type, { clientX, clientY, button: 0, bubbles: true }))

beforeEach(() => {
  renderers = []
  model = boardScene()
  stubFrames()
  loadThree.mockResolvedValue({ THREE: { ...THREE, WebGLRenderer: Renderer }, OrbitControls: Controls, GLTFLoader: Loader,
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
    await drained()
    expect(renderers).toHaveLength(1)
  })

  it('after a failure, fetches again only when it is shown again', async () => {
    const net = fetching()
    const { view, update } = mounted({ active: true })
    net.answer(false)
    await drained()
    expect(view.state.error).toBe('The 3D model did not load: HTTP 404')
    update({ selected: 'C1' })
    expect(net.fetch).toHaveBeenCalledTimes(1)
    update({ active: false })
    update({ active: true })
    expect(net.fetch).toHaveBeenCalledTimes(2)
    expect(view.state.error).toBe('')
  })

  it('frees a model that arrives after it is gone, and makes nothing of it', async () => {
    const net = fetching()
    const { view } = mounted({ active: true })
    const freed = vi.fn()
    model.traverse((object) => object.geometry && object.geometry.addEventListener('dispose', freed))
    view.componentWillUnmount()
    view.setHost(null)
    net.answer()
    await drained()
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
})
