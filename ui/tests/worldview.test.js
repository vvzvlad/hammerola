// The KiCad viewer's world view (ecad-viewer/packages/ecad-viewer-app/src/
// ecad-viewer/net-tracking/): every sheet a label's net reaches on one canvas,
// opened and taken apart by double-clicks on labels. The sheets are synthetic
// s-expressions read by the viewer's own parser; the view runs in jsdom on a host
// that hands out empty scenes, so what is drawn, and that a double-click reaches
// `toggle`, is checked in a browser, not here.

import { SchematicParser } from 'kicad-parser'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { KicadSch } from '../../ecad-viewer/packages/ecad-viewer-app/src/kicad/index.ts'
import { BBox } from '../../ecad-viewer/packages/ecad-viewer-app/src/base/math/index.ts'
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
// it alone; sheet b one ADE_CS and one CAN_TXD; sheet c a lone global label
// LONE wired to a local label, so its net has two places and no namesake.
const PAGES = [
  { key: 'a', name: 'a', document: sheet('a.kicad_sch', [label('ADE_CS', 'a1', 10), label('ADE_CS', 'a2', 50), label('CAN_TXD', 'a3', 90), label('SPI_CLK', 'a4', 130), label('SPI_CLK', 'a5', 170)]) },
  { key: 'b', name: 'b', document: sheet('b.kicad_sch', [label('ADE_CS', 'b1', 10), label('CAN_TXD', 'b2', 50)]) },
  { key: 'c', name: 'c', document: sheet('c.kicad_sch', [label('LONE', 'c1', 10), local('lone_local', 'c2', 50), wire(10, 50, 'cw')]) },
]
const at = (page, uuid) => net_instance_at(PAGES, page, uuid)

/** A host showing PAGES, every sheet an empty scene. */
const host = () => ({
  container: () => document.body,
  pages: () => PAGES,
  page_view: async (key) => ({
    key, name: key, page: null, bounds: new BBox(0, 0, 100, 80),
    item_at: () => ({ item: null, bbox: null }), item_bbox: () => new BBox(0, 0, 1, 1),
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

afterEach(() => vi.unstubAllGlobals())

describe('the world view of a schematic', () => {
  it('links a global label to its namesake on its own sheet as to one on another, while both are shown', () => {
    const { links } = net_closure(PAGES, at('a', 'a1'))
    const named = (shown) => shown_links(links, shown).map(([from, to]) => `${from.uuid}>${to.uuid}`)
    expect(named(() => true)).toEqual(['a1>a2', 'a1>b1'])
    expect(named((page) => page === 'a')).toEqual(['a1>a2'])
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
})
