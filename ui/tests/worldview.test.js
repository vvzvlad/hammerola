// A net's chain on the KiCad viewer's schematic plane (ecad-viewer/packages/
// ecad-viewer-app/src/ecad-viewer/net-tracking/): the places of a label's net
// across the sheets, added and taken away by double-clicks on labels, and the
// lines that join them on the plane. The sheets are synthetic s-expressions
// read by the viewer's own parser; what a chain looks like is checked in a
// browser, not here.

import { SchematicParser } from 'kicad-parser'
import { describe, expect, it } from 'vitest'

import { KicadSch } from '../../ecad-viewer/packages/ecad-viewer-app/src/kicad/index.ts'
import { Vec2 } from '../../ecad-viewer/packages/ecad-viewer-app/src/base/math/index.ts'
import { Chains } from '../../ecad-viewer/packages/ecad-viewer-app/src/ecad-viewer/net-tracking/chains.ts'
import { spanning_pairs } from '../../ecad-viewer/packages/ecad-viewer-app/src/ecad-viewer/net-tracking/geometry.ts'
import { net_closure, net_instance_at } from '../../ecad-viewer/packages/ecad-viewer-app/src/ecad-viewer/net-tracking/net-graph.ts'

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
/** The chains' places, by uuid. */
const places = (chains) => chains.list.map((chain) => chain.places.map((it) => it.uuid))

describe('a net on the schematic plane', () => {
  it('links a global label to its namesakes on its own sheet and on another', () => {
    const { links } = net_closure(PAGES, at('a', 'a1'))
    expect(links.map(([from, to]) => `${from.uuid}>${to.uuid}`)).toEqual(['a1>a2', 'a1>b1'])
  })

  it('links a local label to its namesakes on its own sheet and to none on another', () => {
    const { links } = net_closure(PAGES, at('d', 'd1'))
    expect(links.map(([from, to]) => `${from.uuid}>${to.uuid}`)).toEqual(['d1>d2', 'd1>d3'])
  })

  it('joins the places of a net each to a near one, not all to the first', () => {
    // A row of four, the first at the right end: a fan from it would be 3-0, 3-1, 3-2.
    const row = [30, 0, 10, 20].map((x) => new Vec2(x, 0))
    expect(spanning_pairs(row).map((pair) => pair.sort().join('-')).sort()).toEqual(['0-3', '1-2', '2-3'])
  })
})

describe('the chains of the schematic plane', () => {
  it('adds a net\'s chain on a double-click and the next net\'s in the next colour, and takes away the chain a place is in', () => {
    const chains = new Chains()
    expect([chains.toggle(PAGES, at('a', 'a1')), chains.toggle(PAGES, at('a', 'a3'))]).toEqual([true, true])
    expect(places(chains)).toEqual([['a1', 'a2', 'b1'], ['a3', 'b2']])
    expect(chains.list[0].color).not.toBe(chains.list[1].color)
    // a place of the first chain on another sheet, not the one it started from
    expect(chains.toggle(PAGES, at('b', 'b1'))).toBe(true)
    expect(places(chains)).toEqual([['a3', 'b2']])
  })

  it('draws none for a net with no place to join, though a wire joins it to another label', () => {
    expect(net_closure(PAGES, at('c', 'c1')).instances.map((it) => it.uuid)).toEqual(['c1', 'c2'])
    const chains = new Chains()
    expect([chains.toggle(PAGES, at('c', 'c1')), chains.list.length]).toEqual([false, 0])
  })

  it('are taken away all at once, the colours starting again', () => {
    const chains = new Chains()
    chains.toggle(PAGES, at('a', 'a1'))
    const first = chains.list[0].color
    chains.toggle(PAGES, at('a', 'a3'))
    expect([chains.clear(), chains.list.length, chains.clear()]).toEqual([true, 0, false])
    chains.toggle(PAGES, at('a', 'a3'))
    expect(chains.list[0].color).toBe(first)
  })

  it('are laid out at their places on the plane, a place on a sheet not drawn left out', () => {
    // sheet a at the plane's corner, sheet b 400 to its right; a place at its
    // label's x on its sheet
    const X = { a1: 10, a2: 50, b1: 10 }
    const OFFSET = { a: 0, b: 400 }
    const chains = new Chains()
    chains.toggle(PAGES, at('a', 'a1'))
    const drawn = (pages) => chains.layout((it) => (pages.includes(it.page) ? new Vec2(OFFSET[it.page] + X[it.uuid], 10) : null))
    const plain = ([layout]) => ({
      marks: layout.marks.map((mark) => [mark.at.x, mark.start]),
      segments: layout.segments.map((pair) => pair.map((point) => [point.x, point.y])),
    })
    expect(plain(drawn(['a', 'b']))).toEqual({
      marks: [[10, true], [50, false], [410, false]],
      segments: [[[10, 10], [50, 10]], [[50, 10], [410, 10]]],
    })
    expect(plain(drawn(['a']))).toEqual({ marks: [[10, true], [50, false]], segments: [[[10, 10], [50, 10]]] })
  })
})
