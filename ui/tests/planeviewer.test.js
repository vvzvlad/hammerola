// The schematic plane of the KiCad viewer as the reader drives it
// (ecad-viewer/packages/ecad-viewer-app/src/viewers/schematic/plane-viewer.ts):
// where the camera goes on a cross-probe to a sheet whose scene is still being
// built, and on a double-click. The plane runs in jsdom on an 800×600 canvas
// whose 2D context draws nothing; each sheet's scene is a stub the test builds
// when it chooses. The sheets are synthetic s-expressions read by the viewer's
// own parser. What the plane draws is checked in a browser, not here.

import { SchematicParser } from 'kicad-parser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BBox } from '../../ecad-viewer/packages/ecad-viewer-app/src/base/math/index.ts'
import { Chains } from '../../ecad-viewer/packages/ecad-viewer-app/src/ecad-viewer/net-tracking/chains.ts'
import { KicadSch } from '../../ecad-viewer/packages/ecad-viewer-app/src/kicad/index.ts'
import themes from '../../ecad-viewer/packages/ecad-viewer-app/src/kicanvas/themes/index.ts'
import { PlaneViewer } from '../../ecad-viewer/packages/ecad-viewer-app/src/viewers/schematic/plane-viewer.ts'

// The real scenes import the whole viewer, down to the project's parser workers
// (`comlink`, which ui/ does not install). Here a sheet's scene is ready when
// the test hands it over (`build`).
const requested = vi.hoisted(() => new Map())
vi.mock('../../ecad-viewer/packages/ecad-viewer-app/src/ecad-viewer/insets/schematic-provider.ts', () => ({
  SchematicInsetProvider: class {
    set_highlighted_nets() {}
    subscribe() { return () => {} }
    dispose() {}
    page_view(key) { return new Promise((resolve) => requested.set(key, resolve)) }
  },
}))

const effects = '(effects (font (size 1.27 1.27)))'
const field = (name, value) => `(property "${name}" "${value}" (at 0 0 0) ${effects})`
const part = (reference, uuid) => `\t(symbol (lib_id "Device:R") (at 0 0 0) (uuid "${uuid}") ${field('Reference', reference)})\n`
const label = (name, uuid) => `\t(global_label "${name}" (shape input) (at 20 20 0) ${effects} (uuid "${uuid}"))\n`
const wire = (uuid) => `\t(wire (pts (xy 10 100) (xy 60 100)) (stroke (width 0) (type default)) (uuid "${uuid}"))\n`
const sheetSymbol = (uuid, name, file) => `\t(sheet (at 150 100) (size 40 30) (uuid "${uuid}") ${field('Sheetname', name)} ${field('Sheetfile', file)})\n`
const read = (file, ...items) => new KicadSch(file, new SchematicParser().parse(
  `(kicad_sch\n\t(version 20250610)\n\t(generator "eeschema")\n\t(lib_symbols (symbol "Device:R" (symbol "R_0_1")))\n${items.join('')})\n`))

// The root, A4, carries a part R1, a wire, the global label ADE_CS and the
// sheet symbol of `guard`; `guard`, A4 too and page 2, a part R2 and ADE_CS.
const TOP = read('top.kicad_sch', part('R1', 'r1'), wire('w1'), label('ADE_CS', 'a1'), sheetSymbol('s1', 'guard', 'guard.kicad_sch'))
const GUARD = read('guard.kicad_sch', part('R2', 'r2'), label('ADE_CS', 'b1'))
const PAGES = [
  { key: 'top', name: 'top', document: TOP },
  { key: 'guard', name: 'guard', document: GUARD, parent_key: 'top', sheet_uuid: 's1', number: '2' },
]
const symbol = (doc) => [...doc.symbols.values()][0]
// What each sheet's scene finds where, in the sheet's own millimetres.
const ITEMS = {
  top: [[new BBox(40, 60, 10, 4), symbol(TOP)], [new BBox(10, 98, 50, 4), TOP.wires[0]], [new BBox(150, 100, 40, 30), TOP.sheets[0]]],
  guard: [[new BBox(100, 80, 10, 4), symbol(GUARD)]],
}

/** A built scene of the sheet `key`. */
const scene = (key) => ({
  key,
  name: key,
  page: null,
  bounds: new BBox(0, 0, 297, 210),
  item_at: (point) => {
    const [bbox, item] = ITEMS[key].find(([box]) => box.contains_point(point)) ?? [null, null]
    return { item, bbox }
  },
  item_bbox: (uuid) => ITEMS[key].find(([, item]) => item.uuid === uuid)?.[0],
  item_box: () => undefined,
  render_into() {},
  release() {},
})

/** Hand the plane the scene of `key` once it asks for it, and let it take it in. */
async function build(key) {
  await vi.waitUntil(() => requested.has(key))
  requested.get(key)(scene(key))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

let plane
/** The plane on PAGES, its layout and camera set, no scene built yet. */
async function open() {
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  plane = new PlaneViewer(canvas, true, themes.default.schematic)
  await plane.setup()
  await plane.load({ pages: PAGES, host: {} })
}

function close() {
  plane?.canvas.remove()
  plane?.dispose()
  plane = null
  requested.clear()
}

const camera = () => {
  const { center, zoom } = plane.viewport.camera
  return [center.x, center.y, zoom].map((n) => Math.round(n * 1000) / 1000)
}
/** The plane point `x`, `y` of the sheet `key` on the canvas. */
const screen = (key, x, y) => {
  const { offset } = plane.sheet(key)
  return plane.worldToScreen(x + offset.x, y + offset.y)
}
const mouse = (type, at) => plane.canvas.dispatchEvent(new MouseEvent(type, { clientX: at.x, clientY: at.y, bubbles: true }))

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600)
  // A 2D context that takes every call and draws nothing.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    new Proxy({}, { get: (ctx, key) => (key in ctx ? ctx[key] : () => ({ width: 0 })) }))
})

afterEach(() => {
  close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the schematic plane\'s camera', () => {
  it('on a cross-probe to a sheet still being built, waits for its scene and then goes to the item', async () => {
    await open()
    const fit = camera()
    expect(plane.show_item('guard', ['r2'])).toBe(true)
    await build('top')
    expect(camera()).toEqual(fit)
    await build('guard')
    // R2's box on guard, grown by 20 mm, in the middle: 600 px over its 44 mm
    const { x, y } = plane.sheet('guard').offset
    expect(camera()).toEqual([x + 105, y + 82, Math.round(600 / 44 * 1000) / 1000])
  })

  const DROPS = {
    'a gesture moved the camera': () => plane.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, cancelable: true })),
    'a click on the plane': () => mouse('click', screen('top', 250, 180)),
    'a right click on the plane, which selects': () => { const at = screen('top', 250, 180); plane.select_at(at.x, at.y) },
    'the selection was cleared': () => plane.clear_selection(),
  }
  it.each(Object.keys(DROPS))('does not go to it once %s', async (name) => {
    await open()
    plane.show_item('guard', ['r2'])
    DROPS[name]()
    const before = camera()
    await build('top')
    await build('guard')
    expect(camera()).toEqual(before)
  })
})

describe('a double-click on the schematic plane', () => {
  it('on a sheet symbol shows the sheet it places whole, and on a part puts the camera on the part', async () => {
    await open()
    await build('top')
    await build('guard')
    mouse('dblclick', screen('top', 170, 115))
    const { x, y } = plane.sheet('guard').offset
    const view = plane.viewport.camera.bbox
    expect([view.x, view.w].map((n) => Math.round(n * 1000) / 1000)).toEqual([x, 297])
    expect(view.y <= y && view.y2 >= y + 210).toBe(true)
    mouse('dblclick', screen('guard', 105, 82))
    expect(camera()).toEqual([x + 105, y + 82, Math.round(600 / 44 * 1000) / 1000])
  })

  it('on a wire, on blank paper or between the sheets takes every chain away and leaves the camera', async () => {
    await open()
    await build('top')
    await build('guard')
    const toggle = vi.spyOn(Chains.prototype, 'toggle')
    const gap = (297 + plane.sheet('guard').offset.x) / 2
    for (const [name, at] of [['wire', screen('top', 30, 100)], ['paper', screen('top', 250, 180)], ['gap', plane.worldToScreen(gap, 100)]]) {
      expect(plane.toggle_chain('top', 'a1')).toBe(true)
      const chains = toggle.mock.contexts[0]
      expect(chains.list.length).toBe(1)
      const before = camera()
      mouse('dblclick', at)
      expect([chains.list.length, camera()], name).toEqual([0, before])
    }
  })
})
