// A board's Gerbers: the zip the fab gets, unpacked in the page; what each file
// in it is; how the layers stack from either side; where the board lands on the
// canvas; and the panel over it.
//
// The renderer needs a GPU and is checked in a browser. Everything it is handed
// is decided in gerber.js, which runs here; the panel is the real class with
// `setState` merging in place, its state written as the mount leaves it, its
// tree read off `render()`. On the page, the view is mounted on a holder of a
// set size with a stand-in renderer (`loadGerberRenderer`) that records what it
// is asked to draw; `fetch` and the animation frames are driven by hand.

import { deflateRawSync } from 'node:zlib'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/gerber.js', async (importOriginal) => ({ ...(await importOriginal()), loadGerberRenderer: vi.fn() }))

import CopyLink from '../src/copylink.jsx'
import { documentBody } from '../src/DocumentView.jsx'
import {
  boardArea, boardAt, canvasAt, canvasBox, centredOn, fitView, LAYER_NOTE_CHARS, layerNote, layerOf, layersOf,
  loadGerberRenderer, panBy, readZip, shownOn, stacked, toProcessor, turned, zoomAt,
} from '../src/gerber.js'
import GerberView from '../src/GerberView.jsx'
import { drained, runFrames, stubFrames } from './component.js'
import { collect, links, texts } from './eltree.js'

/** A zip of `entries` (`{ name, data, method, described }`, deflated unless
 *  `method` says 0), as a writer lays one out: each file behind its local
 *  header, then the central directory, its end record and a comment. An entry
 *  `described` is written as a stream is: its local header says nothing of the
 *  sizes (flag bit 3), a data descriptor after the data does. No CRC: nothing
 *  reads it. */
function zipOf(entries, comment = '') {
  const encode = (text) => new TextEncoder().encode(text)
  const files = []
  const directory = []
  let offset = 0
  for (const { name, data, method = 8, described = false } of entries) {
    const body = method === 8 ? new Uint8Array(deflateRawSync(data)) : data
    const path = encode(name)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(6, described ? 8 : 0, true)
    local.setUint16(8, method, true)
    local.setUint32(18, described ? 0 : body.length, true)
    local.setUint32(22, described ? 0 : data.length, true)
    local.setUint16(26, path.length, true)
    files.push(new Uint8Array(local.buffer), path, body)
    if (described) {
      const descriptor = new DataView(new ArrayBuffer(16))
      descriptor.setUint32(0, 0x08074b50, true)
      descriptor.setUint32(8, body.length, true)
      descriptor.setUint32(12, data.length, true)
      files.push(new Uint8Array(descriptor.buffer))
    }
    const entry = new DataView(new ArrayBuffer(46))
    entry.setUint32(0, 0x02014b50, true)
    entry.setUint16(8, described ? 8 : 0, true)
    entry.setUint16(10, method, true)
    entry.setUint32(20, body.length, true)
    entry.setUint32(24, data.length, true)
    entry.setUint16(28, path.length, true)
    entry.setUint32(42, offset, true)
    directory.push(new Uint8Array(entry.buffer), path)
    offset += 30 + path.length + body.length + (described ? 16 : 0)
  }
  const remark = encode(comment)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, directory.reduce((sum, part) => sum + part.length, 0), true)
  end.setUint32(16, offset, true)
  end.setUint16(20, remark.length, true)
  const parts = [...files, ...directory, new Uint8Array(end.buffer), remark]
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  parts.reduce((at, part) => { out.set(part, at); return at + part.length }, 0)
  return out
}

const bytesOf = (text) => new TextEncoder().encode(text)

/** A Gerber file and an Excellon program as KiCad 10 writes their heads, the
 *  attribute that says what each is among them. */
const gerber = (what) => `%TF.GenerationSoftware,KiCad,Pcbnew,10.0.6*%\n%TF.FileFunction,${what}*%\n`
  + '%TF.FilePolarity,Positive*%\n%FSLAX45Y45*%\nG04 Gerber Fmt 4.5*\n%MOMM*%\nM02*\n'
const drill = (what) => `M48\n; DRILL file KiCad 10.0.6\n; #@! TF.FileFunction,${what}\nFMAT,2\nMETRIC\n%\nM30\n`

/** The fab zip of a four-layer board, `dionis_speaker_gerber.zip`, file by
 *  file: its names as `unzip -l` lists them and each file's attribute, copied
 *  out of the files. */
const FAB = [
  ['B_Cu.gbl', gerber('Copper,L4,Bot')], ['B_Mask.gbs', gerber('Soldermask,Bot')],
  ['B_Paste.gbp', gerber('Paste,Bot')], ['B_Silkscreen.gbo', gerber('Legend,Bot')],
  ['Edge_Cuts.gm1', gerber('Profile,NP')], ['F_Cu.gtl', gerber('Copper,L1,Top')],
  ['F_Mask.gts', gerber('Soldermask,Top')], ['F_Paste.gtp', gerber('Paste,Top')],
  ['F_Silkscreen.gto', gerber('Legend,Top')], ['In1_Cu.g1', gerber('Copper,L2,Inr')],
  ['In2_Cu.g2', gerber('Copper,L3,Inr')], ['NPTH-drl_map.gbr', gerber('Drillmap')],
  ['NPTH.drl', drill('NonPlated,1,4,NPTH')], ['PTH-drl_map.gbr', gerber('Drillmap')],
  ['PTH.drl', drill('Plated,1,4,PTH')],
].map(([name, text]) => [`dionis_speaker-${name}`, text])

const LAYERS = layersOf(FAB.map(([name, text]) => ({ name, data: bytesOf(text) })))
const labels = (layers) => layers.map((layer) => layer.label)

describe('the zip', () => {
  it('gives back every file, stored, deflated or streamed, and leaves out the directories', async () => {
    const copper = gerber('Copper,L1,Top').repeat(200)
    const mask = gerber('Soldermask,Top').repeat(50)
    const zip = zipOf([
      { name: 'gerbers/', data: new Uint8Array(0), method: 0 },
      { name: 'gerbers/board-F_Cu.gtl', data: bytesOf(copper) },
      { name: 'gerbers/board-F_Mask.gts', data: bytesOf(mask), described: true },
      { name: 'gerbers/board-PTH.drl', data: bytesOf(drill('Plated,1,4,PTH')), method: 0 },
    ], 'made by the test')
    const files = await readZip(zip.buffer)
    expect(files.map((file) => file.name))
      .toEqual(['gerbers/board-F_Cu.gtl', 'gerbers/board-F_Mask.gts', 'gerbers/board-PTH.drl'])
    expect(files.map((file) => new TextDecoder().decode(file.data)))
      .toEqual([copper, mask, drill('Plated,1,4,PTH')])
  })

  it('refuses what it cannot read, saying what', async () => {
    await expect(readZip(bytesOf(gerber('Copper,L1,Top')))).rejects.toThrow('this is not a zip')
    const bzip2 = zipOf([{ name: 'board.gtl', data: bytesOf('x'), method: 12 }])
    await expect(readZip(bzip2)).rejects.toThrow('board.gtl is compressed by method 12')
  })
})

describe('what each file is', () => {
  it('names the layers of a KiCad fab zip as KiCad does, drill maps by their files', () => {
    expect(LAYERS.map(({ label, kind, side }) => [label, kind, side])).toEqual([
      ['B.Cu', 'copper', 'bottom'], ['B.Mask', 'mask', 'bottom'], ['B.Paste', 'paste', 'bottom'],
      ['B.Silkscreen', 'legend', 'bottom'], ['Edge.Cuts', 'profile', null], ['F.Cu', 'copper', 'top'],
      ['F.Mask', 'mask', 'top'], ['F.Paste', 'paste', 'top'], ['F.Silkscreen', 'legend', 'top'],
      ['In1.Cu', 'copper', null], ['In2.Cu', 'copper', null],
      ['dionis_speaker-NPTH-drl_map.gbr', 'other', null], ['NPTH', 'drill', null],
      ['dionis_speaker-PTH-drl_map.gbr', 'other', null], ['PTH', 'drill', null],
    ])
    expect(LAYERS.filter((layer) => layer.excellon).map((layer) => [layer.label, layer.plated]))
      .toEqual([['NPTH', false], ['PTH', true]])
  })

  it('reads the attribute and never the name, and skips what is not a layer', () => {
    // The same file under a name that says nothing is the same layer.
    expect(layerOf('job/7.gbr', gerber('Copper,L3,Inr')).label).toBe('In2.Cu')
    // Written with X2 off, the attribute rides in a comment.
    expect(layerOf('job/8.gbr', 'G04 #@! TF.FileFunction,Copper,L1,Top*\n%FSLAX46Y46*%\nM02*\n').label).toBe('F.Cu')
    expect(layerOf('board-F_Cu.gtl', '%FSLAX45Y45*%\n%MOMM*%\nM02*\n'))
      .toMatchObject({ kind: 'unknown', label: 'board-F_Cu.gtl' })
    expect(layerOf('board-job.gbrjob', '{ "Header": { "GenerationSoftware": {} } }')).toBeNull()
    expect(layerOf('readme.txt', 'Order: 4 layers, ENIG')).toBeNull()
  })
})

describe('the stack', () => {
  it('lays the board from the side it is seen from, the outline and the holes over it', () => {
    const over = ['dionis_speaker-NPTH-drl_map.gbr', 'dionis_speaker-PTH-drl_map.gbr', 'NPTH', 'PTH', 'Edge.Cuts']
    expect(labels(stacked(LAYERS, 'top'))).toEqual([
      'B.Silkscreen', 'B.Paste', 'B.Mask', 'B.Cu', 'In2.Cu', 'In1.Cu',
      'F.Cu', 'F.Mask', 'F.Paste', 'F.Silkscreen', ...over])
    expect(labels(stacked(LAYERS, 'bottom'))).toEqual([
      'F.Silkscreen', 'F.Paste', 'F.Mask', 'F.Cu', 'In1.Cu', 'In2.Cu',
      'B.Cu', 'B.Mask', 'B.Paste', 'B.Silkscreen', ...over])
  })

  it('shows a side\'s copper, mask and silkscreen, the outline and the holes', () => {
    const shown = (side) => labels(LAYERS.filter((layer) => shownOn(layer, side)))
    expect(shown('top')).toEqual(['Edge.Cuts', 'F.Cu', 'F.Mask', 'F.Silkscreen', 'NPTH', 'PTH'])
    expect(shown('bottom')).toEqual(['B.Cu', 'B.Mask', 'B.Silkscreen', 'Edge.Cuts', 'NPTH', 'PTH'])
  })
})

describe('the view', () => {
  // Where the documented view puts a board point, and where the renderer's
  // zoom and offset put it: one unit is half the canvas's shorter side.
  const W = 800
  const H = 500
  const onCanvas = (view, flip, [u, v]) => [W / 2 + flip * u * view.scale + view.x, H / 2 - v * view.scale + view.y]
  const rendered = (view, flip, [u, v]) => {
    const p = toProcessor(view, W, H, flip)
    return [W / 2 + (p.zoomX * u + p.offsetX) * (H / 2), H / 2 - (p.zoomY * v + p.offsetY) * (H / 2)]
  }
  const close = (a, b) => a.forEach((value, i) => expect(value).toBeCloseTo(b[i], 6))
  const BOARD = { minX: 90, maxX: 204, minY: -125, maxY: -30 }

  it('fits the board, keeps the point under the pointer as it zooms, and turns it over', () => {
    for (const flip of [1, -1]) {
      const fitted = fitView(BOARD, W, H, flip)
      close(onCanvas(fitted, flip, [147, -77.5]), [W / 2, H / 2])
      // The board is as tall as the canvas allows, less the margin.
      expect(onCanvas(fitted, flip, [147, -30])[1]).toBeCloseTo(16, 6)
      const view = panBy(fitted, 30, -12)
      const under = (([px, py]) => [(flip * (px - W / 2 - view.x)) / view.scale, (H / 2 - py + view.y) / view.scale])([610, 95])
      close(onCanvas(zoomAt(view, 610, 95, W, H, 3.5), flip, under), [610, 95])
      close(rendered(view, flip, [120, -40]), onCanvas(view, flip, [120, -40]))
      // Turned over, a point lands mirrored about the canvas's centre line.
      const [x, y] = onCanvas(view, flip, [120, -40])
      close(onCanvas(turned(view), -flip, [120, -40]), [W - x, y])
    }
  })

  it('takes a comment\'s area between two canvas points in board units, lands it back where it was drawn, and centres it', () => {
    for (const flip of [1, -1]) {
      const view = panBy(fitView(BOARD, W, H, flip), 30, -12)
      close(canvasAt(view, 120, -40, W, H, flip), onCanvas(view, flip, [120, -40]))
      close(boardAt(view, ...onCanvas(view, flip, [120, -40]), W, H, flip), [120, -40])
      const area = boardArea(view, [600, 100], [200, 300], W, H, flip)
      expect(boardArea(view, [200, 300], [600, 100], W, H, flip)).toEqual(area)
      const { left, top, width, height } = canvasBox(view, area, W, H, flip)
      close([left, top, width, height], [200, 100, 400, 200])
      close(onCanvas(centredOn(view, 120, -40, flip), flip, [120, -40]), [W / 2, H / 2])
    }
  })

  it('names the side and the layers on screen for a comment, cut to the hub\'s one-line ceiling', () => {
    const layers = ['F.Cu', 'F.Mask', 'B.Cu', 'Edge.Cuts'].map((label, i) => ({ file: `f${i}`, label }))
    expect(layerNote(layers, { f0: true, f1: true, f3: true }, { f1: 'unreadable' }, 'top')).toBe('top: F.Cu, Edge.Cuts')
    const many = Array.from({ length: 40 }, (_, i) => ({ file: `f${i}`, label: `User.${i}` }))
    const note = layerNote(many, Object.fromEntries(many.map(({ file }) => [file, true])), {}, 'bottom')
    expect([note.length, note.startsWith('bottom: User.0, '), note.endsWith('…')]).toEqual([LAYER_NOTE_CHARS, true, true])
  })
})

describe('the drawing of a document', () => {
  it('draws a zip of Gerbers with the view, handing it the file and its size', () => {
    const doc = { id: 'fab__board.zip', name: 'Gerbers', type: 'gerbers', file: 'fab/board.zip', bytes: 776_479 }
    const [view] = collect(documentBody(doc, '/project/p1/abc/', null, ''), (el) => (el.type === GerberView ? el : undefined))
    expect(view.props).toEqual({ url: '/project/p1/abc/fab/board.zip', bytes: 776_479, doc })
  })
})

describe('the panel', () => {
  /** The view as its mount leaves it: the layers listed top down, the top shown. */
  function mounted() {
    const view = new GerberView({ url: '/project/p1/abc/fab/dionis_speaker_gerber.zip' })
    view.setState = (patch) => Object.assign(view.state, typeof patch === 'function' ? patch(view.state) : patch)
    Object.assign(view.state, {
      layers: stacked(LAYERS, 'top').reverse(),
      shown: Object.fromEntries(LAYERS.map((layer) => [layer.file, shownOn(layer, 'top')])),
    })
    return view
  }
  const control = (view, attribute, value) => collect(view.render(), (el) => (el.props[attribute] === value ? el : undefined))[0]
  const on = (view) => labels(view.state.layers.filter((layer) => view.state.shown[layer.file]))

  it('stands where the model\'s parts tree stands, its rows read as the tree\'s: the eye first', () => {
    const view = mounted()
    const [panel] = collect(view.render(), (el) => (el.props['data-panel'] ? el : undefined))
    expect(panel.props.style).toMatchObject({ position: 'absolute', top: '10px', left: '12px', maxWidth: 'calc(100% - 24px)' })
    const [row] = collect(view.render(), (el) => (el.props['data-layer'] ? el : undefined))
    const [eye] = row.props.children
    expect(eye.props['data-eye']).toBe(row.props['data-layer'])
  })

  it('turns the board over and toggles a layer, and leaves the zip\'s download to the bar', () => {
    const view = mounted()
    expect(collect(view.render(), (el) => el.props['data-layer'])).toHaveLength(15)
    expect(control(view, 'data-side', 'top').props.style.background).toBe('var(--card-bg)')

    control(view, 'data-side', 'bottom').props.onClick()
    expect(view.state.side).toBe('bottom')
    expect(on(view)).toEqual(['Edge.Cuts', 'PTH', 'NPTH', 'B.Cu', 'B.Mask', 'B.Silkscreen'])

    // Two rows clicked off one drawing, before it is drawn again: both land.
    const rows = collect(view.render(), (el) => (el.props['data-layer'] ? el : undefined))
    for (const file of ['dionis_speaker-In1_Cu.g1', 'dionis_speaker-Edge_Cuts.gm1']) {
      rows.find((row) => row.props['data-layer'] === file).props.onClick()
    }
    expect(on(view)).toEqual(['PTH', 'NPTH', 'In1.Cu', 'B.Cu', 'B.Mask', 'B.Silkscreen'])

    expect([links(view.render()), collect(view.render(), (el) => (el.type === CopyLink ? el : undefined))])
      .toEqual([[], []])
  })
})

describe('the view on the page', () => {
  const ZIP_URL = '/project/p1/abc/fab/dionis_speaker_gerber.zip'
  const WIDE = 800
  const TALL = 500
  /** The renderer's unit: half the canvas's shorter side. */
  const UNIT = Math.min(WIDE, TALL) / 2
  const BOARD_ZIP = zipOf(FAB
    .filter(([name]) => ['dionis_speaker-F_Cu.gtl', 'dionis_speaker-Edge_Cuts.gm1', 'dionis_speaker-PTH.drl'].includes(name))
    .map(([name, text]) => ({ name, data: bytesOf(text), method: 0 })))

  /** Every processor the view made, each with the frames it was asked to draw. */
  let processors = []
  const loseContext = vi.fn()

  class Processor {
    constructor() {
      this.renders = []
      this.free = vi.fn()
      this.next = 0
      processors.push(this)
    }

    init() {}

    set_anti_aliasing() {}

    resize() {}

    add_layer() {
      this.next += 1
      return this.next
    }

    add_drill_layer() {
      this.next += 2
      return { outlineLayerId: this.next - 1, fillLayerId: this.next }
    }

    set_layer_inner_outline() {}

    get_layer_boundary() {
      return { min_x: 90, max_x: 204, min_y: -125, max_y: -30, free() {} }
    }

    render_with_clear_and_blend_modes(ids, colours, modes, zoomX, zoomY, offsetX, offsetY) {
      this.renders.push({ zoomX, zoomY, offsetX, offsetY })
    }
  }

  /** A fetch answered when the test says so: with a zip, or with a 404. */
  function fetching() {
    const calls = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
      calls.push((zip) => resolve(zip ? new Response(zip) : new Response(null, { status: 404 })))
    })))
    return (zip) => calls.shift()(zip)
  }

  /** The view mounted on a holder WIDE x TALL, with props `extra` besides. */
  function opened(extra = {}) {
    const view = new GerberView({ url: ZIP_URL, bytes: 776_500, onTools: vi.fn(), onReady: vi.fn(), ...extra })
    view.setState = (patch) => Object.assign(view.state, typeof patch === 'function' ? patch(view.state) : patch)
    const host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { value: WIDE })
    Object.defineProperty(host, 'clientHeight', { value: TALL })
    view.setHost(host)
    view.componentDidMount()
    return { view, host }
  }

  /** The view as React takes it off the page. */
  function closed(view) {
    view.componentWillUnmount()
    view.setHost(null)
  }

  /** The fetch, the two frames that paint its full bar, the zip and the
   *  renderer all through. */
  const settle = async () => {
    for (let turn = 0; turn < 4; turn += 1) {
      await drained()
      runFrames()
    }
  }

  /** The view with the board's zip drawn once. */
  async function loaded(extra) {
    const answer = fetching()
    const { view, host } = opened(extra)
    answer(BOARD_ZIP)
    await settle()
    runFrames()
    const canvas = host.querySelector('canvas')
    canvas.setPointerCapture = () => {}
    return { view, host, canvas, processor: processors[0] }
  }

  const last = (processor) => processor.renders.at(-1)
  /** Where a frame put a board point on the canvas, and which point it put at a pixel. */
  const pixelOf = (frame, [u, v]) => [WIDE / 2 + (frame.zoomX * u + frame.offsetX) * UNIT, TALL / 2 - (frame.zoomY * v + frame.offsetY) * UNIT]
  const pointAt = (frame, [x, y]) => [((x - WIDE / 2) / UNIT - frame.offsetX) / frame.zoomX, ((TALL / 2 - y) / UNIT - frame.offsetY) / frame.zoomY]
  const close = (a, b) => a.forEach((value, i) => expect(value).toBeCloseTo(b[i], 6))

  const pointer = (canvas, type, { id = 1, kind = 'mouse', button = 0, buttons = 1, x, y }) => canvas.dispatchEvent(
    new PointerEvent(type, { pointerId: id, pointerType: kind, button, buttons, clientX: x, clientY: y, bubbles: true }))

  beforeEach(() => {
    processors = []
    loseContext.mockClear()
    stubFrames()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ getExtension: () => ({ loseContext }) })
    loadGerberRenderer.mockResolvedValue({ GerberProcessor: Processor })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('draws nothing of a zip, or of a renderer, that arrives after it is gone', async () => {
    const answer = fetching()
    const zipLate = opened()
    await settle()
    closed(zipLate.view)
    answer(BOARD_ZIP)

    let release
    loadGerberRenderer.mockReturnValueOnce(new Promise((done) => { release = done }))
    const rendererLate = opened()
    answer(BOARD_ZIP)
    await settle()
    closed(rendererLate.view)
    release({ GerberProcessor: Processor })
    await settle()

    expect(processors).toEqual([])
    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled()
    for (const { view, host } of [zipLate, rendererLate]) {
      expect([view.state.error, view.stage, host.querySelector('canvas')]).toEqual(['', null, null])
    }
  })

  it('says why a zip did not load, or holds nothing to draw', async () => {
    const answer = fetching()
    const missing = opened()
    answer(null)
    await settle()
    expect(missing.view.state.error).toBe('The Gerbers did not load: HTTP 404')

    const empty = opened()
    answer(zipOf([{ name: 'readme.txt', data: bytesOf('Order: 4 layers, ENIG'), method: 0 }]))
    await settle()
    expect(empty.view.state.error).toBe('The Gerbers did not load: the zip holds no Gerber or drill file')

    for (const { view } of [missing, empty]) {
      expect(texts(view.render())).toContain(view.state.error)
      // a page holding its model back for the zip hears of it, in or not
      expect(view.props.onReady).toHaveBeenCalledTimes(1)
    }
    expect(processors).toEqual([])
  })

  it('frees the renderer and hands the WebGL context back when it goes', async () => {
    const { view, host, processor } = await loaded()
    expect(processor.renders).toHaveLength(1)
    closed(view)
    expect(processor.free).toHaveBeenCalledTimes(1)
    expect(loseContext).toHaveBeenCalledTimes(1)
    expect(host.querySelector('canvas')).toBeNull()
  })

  it('pans with a drag or a swipe, zooms about the pointer with a pinch, and scales with two fingers', async () => {
    const { canvas, processor } = await loaded()
    const spot = pointAt(last(processor), [610, 95])
    pointer(canvas, 'pointerdown', { x: 100, y: 100 })
    pointer(canvas, 'pointermove', { x: 130, y: 80 })
    pointer(canvas, 'pointerup', { x: 130, y: 80, buttons: 0 })
    runFrames()
    close(pixelOf(last(processor), spot), [640, 75])

    // A two-finger swipe is a wheel event without Control: the board follows it.
    const swiped = new WheelEvent('wheel', { deltaX: -15, deltaY: 25, clientX: 300, clientY: 300, bubbles: true, cancelable: true })
    canvas.dispatchEvent(swiped)
    runFrames()
    expect(swiped.defaultPrevented).toBe(true)
    close(pixelOf(last(processor), spot), [655, 50])

    // A pinch arrives as a wheel event with Control held, and zooms about the pointer.
    const before = last(processor)
    const wheel = new WheelEvent('wheel', { ctrlKey: true, deltaY: -120, clientX: 655, clientY: 50, bubbles: true, cancelable: true })
    canvas.dispatchEvent(wheel)
    runFrames()
    expect(wheel.defaultPrevented).toBe(true)
    expect(Math.abs(last(processor).zoomY)).toBeGreaterThan(Math.abs(before.zoomY))
    close(pixelOf(last(processor), spot), [655, 50])

    // Two fingers 200 px apart moved to 400, their midpoint from 400 to 500.
    const pinched = last(processor)
    const middle = pointAt(pinched, [400, 250])
    pointer(canvas, 'pointerdown', { id: 2, kind: 'touch', x: 300, y: 250 })
    pointer(canvas, 'pointerdown', { id: 3, kind: 'touch', x: 500, y: 250 })
    pointer(canvas, 'pointermove', { id: 3, kind: 'touch', x: 700, y: 250 })
    runFrames()
    expect(last(processor).zoomY / pinched.zoomY).toBeCloseTo(2, 6)
    close(pixelOf(last(processor), middle), [500, 250])
  })

  it('drags with the left button only, and lets go of a press whose release went elsewhere', async () => {
    const { canvas, processor } = await loaded()
    const fitted = last(processor)
    // A right click: the browser's menu takes the release, and the pointer
    // moves on with no button held.
    pointer(canvas, 'pointerdown', { button: 2, buttons: 2, x: 100, y: 100 })
    pointer(canvas, 'pointermove', { buttons: 0, x: 200, y: 150 })
    // A left press let go over another window.
    pointer(canvas, 'pointerdown', { x: 300, y: 300 })
    pointer(canvas, 'pointermove', { buttons: 0, x: 400, y: 350 })
    pointer(canvas, 'pointermove', { buttons: 0, x: 450, y: 380 })
    runFrames()
    expect(last(processor)).toEqual(fitted)

    // The next drag pans by itself alone.
    const spot = pointAt(fitted, [200, 200])
    pointer(canvas, 'pointerdown', { x: 200, y: 200 })
    pointer(canvas, 'pointermove', { x: 210, y: 195 })
    runFrames()
    close(pixelOf(last(processor), spot), [210, 195])
  })

  it('with Comment armed, draws an area where a drag would pan and a spot on a click, and centres an area asked for', async () => {
    const doc = { file: 'fab/dionis_speaker_gerber.zip' }
    const comment = { on: true, marks: [], focus: null, onArea: vi.fn(), onMarker: vi.fn(), onFocused: vi.fn() }
    const { view, canvas, processor } = await loaded({ doc, comment })
    const fitted = last(processor)
    pointer(canvas, 'pointerdown', { x: 100, y: 300 })
    pointer(canvas, 'pointermove', { x: 300, y: 200 })
    expect(view.state.band).toEqual({ id: 1, from: [100, 300], to: [300, 200] })
    pointer(canvas, 'pointerup', { x: 300, y: 200, buttons: 0 })
    pointer(canvas, 'pointerdown', { x: 400, y: 250 })
    pointer(canvas, 'pointerup', { x: 402, y: 251, buttons: 0 })
    runFrames()
    expect([last(processor), view.state.band]).toEqual([fitted, null])
    const [low, high, spot] = [[100, 300], [300, 200], [400, 250]].map((at) => pointAt(fitted, at))
    const [[onDoc, drawn], [, clicked]] = comment.onArea.mock.calls
    expect([onDoc, drawn.frame, drawn.layer.startsWith('top: ')]).toEqual([doc, 'board', true])
    close(drawn.area, [low[0], low[1], high[0] - low[0], high[1] - low[1]])
    close(clicked.area, [...spot, 0, 0])

    // the area asked for goes to the centre, once
    view.props = { ...view.props, comment: { ...comment, focus: { doc: doc.file, area: drawn.area } } }
    view.componentDidUpdate(view.props, view.state)
    view.componentDidUpdate(view.props, view.state)
    runFrames()
    close(pixelOf(last(processor), [(low[0] + high[0]) / 2, (low[1] + high[1]) / 2]), [WIDE / 2, TALL / 2])
    expect(comment.onFocused).toHaveBeenCalledTimes(1)
  })

  it('tells the bar it can fit and frame once the board is drawn, and does both on the canvas', async () => {
    const answer = fetching()
    const { view, host } = opened()
    expect(view.props.onTools).not.toHaveBeenCalled()
    answer(BOARD_ZIP)
    await settle()
    runFrames()
    const [[tools]] = view.props.onTools.mock.calls
    const processor = processors[0]
    const fitted = last(processor)
    const canvas = host.querySelector('canvas')
    canvas.setPointerCapture = () => {}
    pointer(canvas, 'pointerdown', { x: 100, y: 100 })
    pointer(canvas, 'pointermove', { x: 160, y: 140 })
    runFrames()
    expect(last(processor)).not.toEqual(fitted)
    tools.fit()
    runFrames()
    expect(last(processor)).toEqual(fitted)
    // the context keeps its drawing buffer: the canvas is read as it stands
    const blob = new Blob(['png'], { type: 'image/png' })
    canvas.toBlob = vi.fn((done, type) => done(type === 'image/png' ? blob : null))
    await expect(tools.frame()).resolves.toBe(blob)
  })

  it('frames the canvas with a comment\'s area drawn on it where it stands, in the canvas\'s own pixels', async () => {
    // Two canvas pixels to a CSS pixel, which is what the marks are placed in.
    vi.stubGlobal('devicePixelRatio', 2)
    const doc = { file: 'fab/dionis_speaker_gerber.zip' }
    const comment = { on: false, marks: [], focus: null, onArea: vi.fn(), onMarker: vi.fn(), onFocused: vi.fn() }
    const { view, canvas, processor } = await loaded({ doc, comment })
    const [[tools]] = view.props.onTools.mock.calls
    // jsdom draws nothing: the 2D context records what it is told, and each
    // canvas's PNG says which canvas it is.
    const pen = {
      drawImage: vi.fn(), strokeRect: vi.fn(), setLineDash() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
    }
    HTMLCanvasElement.prototype.getContext.mockImplementation((kind) => (kind === '2d' ? pen : { getExtension: () => ({ loseContext }) }))
    const [bare, framed] = [new Blob(['the board']), new Blob(['the board and its marks'])]
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (done, type) {
      done(type === 'image/png' ? (this === canvas ? bare : framed) : null)
    })

    // with no mark on the zip, the canvas as it stands
    await expect(tools.frame()).resolves.toBe(bare)
    expect(pen.drawImage).not.toHaveBeenCalled()

    // an area that stands between the CSS points (100, 200) and (300, 300)
    const [low, high] = [[100, 300], [300, 200]].map((at) => pointAt(last(processor), at))
    const area = [low[0], low[1], high[0] - low[0], high[1] - low[1]]
    view.props = { ...view.props, comment: { ...comment, marks: [{ id: 'c1', doc: doc.file, area, active: true }] } }
    await expect(tools.frame()).resolves.toBe(framed)
    expect(pen.drawImage.mock.calls).toEqual([[canvas, 0, 0]])
    expect(pen.strokeRect).toHaveBeenCalledTimes(1)
    close(pen.strokeRect.mock.calls[0], [200, 400, 400, 200])
  })
})
