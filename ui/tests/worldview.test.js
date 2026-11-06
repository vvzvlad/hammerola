// The KiCad viewer's world view (ecad-viewer/packages/ecad-viewer-app/src/
// ecad-viewer/net-tracking/): every sheet a label's net reaches on one canvas,
// opened and taken apart by double-clicks on labels. The sheets are synthetic
// s-expressions read by the viewer's own parser; the view runs in jsdom on a host
// that hands out empty scenes, so what is drawn, and that a double-click on a
// label reaches `toggle`, is checked in a browser, not here.

import { SchematicParser } from 'kicad-parser'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { KicadSch } from '../../ecad-viewer/packages/ecad-viewer-app/src/kicad/index.ts'
import { BBox, Vec2 } from '../../ecad-viewer/packages/ecad-viewer-app/src/base/math/index.ts'
import { spanning_pairs } from '../../ecad-viewer/packages/ecad-viewer-app/src/ecad-viewer/net-tracking/geometry.ts'
import { net_closure, net_instance_at } from '../../ecad-viewer/packages/ecad-viewer-app/src/ecad-viewer/net-tracking/net-graph.ts'
import { NetTracker } from '../../ecad-viewer/packages/ecad-viewer-app/src/ecad-viewer/net-tracking/tracker.ts'
import { WorldView, shown_links } from '../../ecad-viewer/packages/ecad-viewer-app/src/ecad-viewer/net-tracking/world-view.ts'

// The world view's scenes import the whole viewer, down to the project's parser
// workers (`comlink`, which ui/ does not install); the tracker's keys use none.
vi.mock('../../ecad-viewer/packages/ecad-viewer-app/src/ecad-viewer/insets/schematic-provider.ts', () => ({ SchematicInsetProvider: class {} }))

const label = (name, uuid, x) => `\t(global_label "${name}" (shape input) (at ${x} 10 0) (effects (font (size 1.27 1.27))) (uuid "${uuid}"))\n`
const local = (name, uuid, x) => `\t(label "${name}" (at ${x} 10 0) (effects (font (size 1.27 1.27))) (uuid "${uuid}"))\n`
const wire = (x1, x2, uuid) => `\t(wire (pts (xy ${x1} 10) (xy ${x2} 10)) (stroke (width 0) (type default)) (uuid "${uuid}"))\n`
const sheet = (file, labels) => new KicadSch(file, new SchematicParser().parse(`(kicad_sch\n\t(version 20250610)\n\t(generator "eeschema")\n${labels.join('')})\n`))

// Sheet a carries ADE_CS twice, unwired, CAN_TXD, and SPI_CLK twice, a net on
// it alone; sheet b one ADE_CS, one CAN_TXD and a local label VM; sheet c a lone
// global label LONE wired to a local label, so its net has two places and no
// namesake; sheet d the local label VM three times, unwired.
const PAGES = [
  { key: 'a', name: 'a', document: sheet('a.kicad_sch', [label('ADE_CS', 'a1', 10), label('ADE_CS', 'a2', 50), label('CAN_TXD', 'a3', 90), label('SPI_CLK', 'a4', 130), label('SPI_CLK', 'a5', 170)]) },
  { key: 'b', name: 'b', document: sheet('b.kicad_sch', [label('ADE_CS', 'b1', 10), label('CAN_TXD', 'b2', 50), local('VM', 'b3', 90)]) },
  { key: 'c', name: 'c', document: sheet('c.kicad_sch', [label('LONE', 'c1', 10), local('lone_local', 'c2', 50), wire(10, 50, 'cw')]) },
  { key: 'd', name: 'd', document: sheet('d.kicad_sch', [local('VM', 'd1', 10), local('VM', 'd2', 50), local('VM', 'd3', 90)]) },
]
const at = (page, uuid) => net_instance_at(PAGES, page, uuid)

/** A host showing PAGES, every sheet a scene whose items are `item_at`'s. */
const host = (item_at = () => ({ item: null, bbox: null })) => ({
  container: () => document.body,
  pages: () => PAGES,
  page_view: async (key) => ({
    key, name: key, page: null, bounds: new BBox(0, 0, 100, 80),
    item_at, item_bbox: () => new BBox(0, 0, 1, 1),
    show_local_trace() {}, local_trace: () => null, render() {}, render_into() {}, release() {},
  }),
  subscribe: () => () => {},
  open_page() {},
  select() {},
  trace: () => false,
  background: () => '#000',
  navigation: () => undefined,
  insets: () => null,
  main_view: () => null,
})

/**
 * A world view on `host` open on the net of SPI_CLK, sheet a alone, or of the
 * label `from` of sheet a, on an 800×600 canvas: framed in its middle, unless
 * the host's main view shows the sheet. With that canvas and what its
 * ResizeObserver calls.
 */
async function open_on_sheet_a(host, from = at('a', 'a4')) {
  let resize
  vi.stubGlobal('ResizeObserver', class { constructor(callback) { resize = callback } observe() {} disconnect() {} })
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600)
  const view = new WorldView(host)
  expect(await view.toggle(from)).toBe(true)
  // A view closed by an earlier test fades out before it leaves the page.
  const canvas = [...document.querySelectorAll('.world-view')].at(-1).querySelector('canvas')
  return { view, canvas, resize }
}

const dblclick = (canvas, x, y) => canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: x, clientY: y, bubbles: true }))
/** A pinch of `by` px about the middle of the 800×600 canvas, out when positive. */
const pinch = (canvas, by) => canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: by, ctrlKey: true, clientX: 400, clientY: 300, cancelable: true }))
/** A drag of the canvas `dx` px to the left. */
const drag_left = (canvas, dx) => {
  canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 400 + dx, clientY: 300, buttons: 1 }))
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, clientY: 300, buttons: 1 }))
  window.dispatchEvent(new MouseEvent('mouseup'))
}
/** The pages and boxes, to a thousandth, the main view was handed. */
const handed = (open_page) => open_page.mock.calls.map(([page, box]) => [page, [box.x, box.y, box.w, box.h].map((n) => Math.round(n * 1000) / 1000)])

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the world view of a schematic', () => {
  it('links a global label to its namesake on its own sheet as to one on another, while both are shown', () => {
    const { links } = net_closure(PAGES, at('a', 'a1'))
    const named = (shown) => shown_links(links, shown).map(([from, to]) => `${from.uuid}>${to.uuid}`)
    expect(named(() => true)).toEqual(['a1>a2', 'a1>b1'])
    expect(named((page) => page === 'a')).toEqual(['a1>a2'])
  })

  it('links a local label to its namesakes on its own sheet and to none on another', () => {
    const { links } = net_closure(PAGES, at('d', 'd1'))
    expect(links.map(([from, to]) => `${from.uuid}>${to.uuid}`)).toEqual(['d1>d2', 'd1>d3'])
  })

  it('opens on a local label, showing its sheet alone, and closes on a double-click on a namesake', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const view = new WorldView(host())
    expect(await view.toggle(at('d', 'd1'))).toBe(true)
    expect([view.open, view.traced(at('d', 'd3')), !!view.view('d'), !!view.view('b')]).toEqual([true, true, true, false])
    await view.toggle(at('d', 'd2'))
    expect(view.open).toBe(false)
  })

  it('closes on a double-click on an empty place, between the sheets or on blank paper, handing the main view the sheet', async () => {
    for (const [x, y] of [[5, 5], [400, 300]]) {
      const h = { ...host(), open_page: vi.fn() }
      const { view, canvas } = await open_on_sheet_a(h)
      dblclick(canvas, x, y)
      expect([view.open, h.open_page.mock.calls.map(([page]) => page)]).toEqual([false, ['a']])
    }
  })

  it('on closing, hands the main view the sheet in the middle of the canvas, or the one nearest it, where and as large as it shows it', async () => {
    // Open on ADE_CS: sheet a, then sheet b 150 to its right (100 wide, a gap of
    // 50), framed as the main view frames a, 80×60 about (50, 50) at 10 px a
    // unit. Zoomed out, dragged left, zoomed back in: 80×60 again, about where
    // the drag left the middle of the canvas, on b or between a and b.
    // Sheet b fades in, frame by frame, past the fade-out that lets go of the
    // view: on this test's own clock, run out before the next test fakes frames.
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout'] })
    const out = 10 * Math.exp(-0.4)
    for (const drag of [1000, 600]) {
      const h = { ...host(), open_page: vi.fn(), main_view: () => ({ page: 'a', box: new BBox(10, 20, 80, 60) }) }
      const { view, canvas } = await open_on_sheet_a(h, at('a', 'a1'))
      pinch(canvas, 40)
      drag_left(canvas, drag)
      pinch(canvas, -40)
      dblclick(canvas, 400, 300)
      const middle = 50 + drag / out
      expect([view.open, handed(h.open_page)])
        .toEqual([false, [['b', [Math.round((middle - 150 - 40) * 1000) / 1000, 20, 80, 60]]]])
      vi.runAllTimers()
    }
  })

  it('selects for the page\'s right click what it shows at the point, and the tracker asks it only while open', async () => {
    const part = {}
    const h = { ...host(() => ({ item: part, bbox: new BBox(40, 30, 20, 20) })), select: vi.fn() }
    expect(new NetTracker({ pages: () => PAGES, viewer: () => null }).select_at(400, 300)).toBe(false)
    const { view } = await open_on_sheet_a(h)
    view.select_at(400, 300)
    expect(h.select.mock.calls.map(([sheet, item]) => [sheet.key, item === part])).toEqual([['a', true]])
    view.close()
  })

  it('on a double-click on a part, hands the main view the part\'s sheet, not the one in the middle, and closes', async () => {
    // 400×300 about (200, 150): the middle is nearest sheet b; the part at (50, 40) of a.
    // Sheet b fades in: on this test's own clock, as in the test above.
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout'] })
    const h = {
      ...host(() => ({ item: {}, bbox: new BBox(40, 30, 20, 20) })),
      open_page: vi.fn(),
      main_view: () => ({ page: 'a', box: new BBox(0, 0, 400, 300) }),
    }
    const { view, canvas } = await open_on_sheet_a(h, at('a', 'a1'))
    dblclick(canvas, 100, 80)
    expect([handed(h.open_page), view.open]).toEqual([[['a', [0, 0, 400, 300]]], false])
    vi.runAllTimers()
  })

  it('opens where the main view looks and stays there as time passes, a chain is added and the view resizes', async () => {
    // One clock for frames and `performance.now()`, as in a browser: jsdom
    // stamps frames from an origin of its own.
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    // Where on sheet a a double-click in the middle of the canvas lands: the
    // middle of what the camera shows. Taken as a trace, so the view stays.
    const landed = []
    const h = {
      ...host((point) => { landed.push([Math.round(point.x), Math.round(point.y)]); return { item: {}, bbox: null } }),
      trace: () => true,
      main_view: () => ({ page: 'a', box: new BBox(10, 20, 80, 60) }),
    }
    const { view, canvas, resize } = await open_on_sheet_a(h)
    await vi.advanceTimersByTimeAsync(1000)
    dblclick(canvas, 400, 300)
    await view.toggle(at('a', 'a1'))
    await vi.advanceTimersByTimeAsync(1000)
    dblclick(canvas, 400, 300)
    resize()
    await vi.advanceTimersByTimeAsync(1000)
    dblclick(canvas, 400, 300)
    expect([view.view('b') !== null, landed]).toEqual([true, [[50, 50], [50, 50], [50, 50]]])
    view.close()
  })

  it('opens on a double-click, adds a net on the next, takes away the chain of a label it reaches, and closes with the last', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const view = new WorldView(host())
    expect(await view.toggle(at('a', 'a1'))).toBe(true)
    expect(view.open).toBe(true)
    await view.toggle(at('a', 'a3'))
    expect([view.traced(at('b', 'b1')), view.traced(at('b', 'b2'))]).toEqual([true, true])
    await view.toggle(at('a', 'a2'))
    expect([view.traced(at('a', 'a1')), view.traced(at('b', 'b1')), view.traced(at('b', 'b2')), view.open]).toEqual([false, false, true, true])
    await view.toggle(at('b', 'b2'))
    expect(view.open).toBe(false)
  })

  it('opens on a net that stays on one sheet, showing that sheet alone', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const view = new WorldView(host())
    expect(await view.toggle(at('a', 'a4'))).toBe(true)
    expect([view.open, view.traced(at('a', 'a5')), !!view.view('a'), !!view.view('b')]).toEqual([true, true, true, false])
    view.close()
  })

  it('does not open on a net with no namesake to link to, though a wire joins it to another label', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    expect(net_closure(PAGES, at('c', 'c1')).instances.map((it) => it.uuid)).toEqual(['c1', 'c2'])
    const view = new WorldView(host())
    expect([await view.toggle(at('c', 'c1')), view.open]).toEqual([false, false])
  })

  it('takes no key on the schematic but Escape, so `~` traces nothing', () => {
    // A host whose schematic is in front: a `~` the tracker took would be taken here.
    const tracker = new NetTracker({ showing: () => true, pages: () => PAGES, viewer: () => null })
    for (const key of [{ key: '`', code: 'Backquote' }, { key: '~', code: 'Backquote', shiftKey: true }])
      expect(tracker.key_down(new KeyboardEvent('keydown', key))).toBe(false)
  })

  it('joins the places of a net each to a near one, not all to the first', () => {
    // A row of four, the first at the right end: a fan from it would be 3-0, 3-1, 3-2.
    const row = [30, 0, 10, 20].map((x) => new Vec2(x, 0))
    expect(spanning_pairs(row).map((pair) => pair.sort().join('-')).sort()).toEqual(['0-3', '1-2', '2-3'])
  })
})
