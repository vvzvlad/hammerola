// The board's copper the KiCad viewer hands the 3D view (`board_copper` in
// ecad-viewer/packages/ecad-viewer-app/src/ecad-viewer/board-copper.ts, behind
// the element's `getBoardCopper`): every copper layer's triangles with a net on
// each vertex, the plated barrels, and the heights KiCad's 3D export gives each
// layer. The board is synthetic, shaped as KiCad 10 writes one, read by the
// viewer's own parser; that the result lies on a real `.glb`'s copper is
// checked in a browser, not here.

import { BoardParser } from 'kicad-parser'
import { describe, expect, it } from 'vitest'

import { board_copper, board_stack, copper_z } from '../../ecad-viewer/packages/ecad-viewer-app/src/ecad-viewer/board-copper.ts'
import { KicadPCB } from '../../ecad-viewer/packages/ecad-viewer-app/src/kicad/index.ts'
import themes from '../../ecad-viewer/packages/ecad-viewer-app/src/kicanvas/themes/index.ts'
import { LayerSet } from '../../ecad-viewer/packages/ecad-viewer-app/src/viewers/board/layers.ts'

const square = (x0, y0, x1, y1) => `(pts (xy ${x0} ${y0}) (xy ${x1} ${y0}) (xy ${x1} ${y1}) (xy ${x0} ${y1}))`

/** A board of `layers` (`(n "name" signal)` lines) holding `items`, with `setup`. */
const board = (layers, items, setup = '') => new KicadPCB('test.kicad_pcb', new BoardParser().parse('(kicad_pcb\n'
  + '\t(version 20260206)\n\t(generator "pcbnew")\n\t(general (thickness 1.6))\n\t(paper "A4")\n'
  + `\t(layers ${layers} (1 "F.Mask" user) (3 "B.Mask" user) (25 "Edge.Cuts" user))\n`
  + `\t(setup ${setup} (pad_to_mask_clearance 0))\n${items.join('\n')}\n)\n`))

const TWO = '(0 "F.Cu" signal) (2 "B.Cu" signal)'
const FOUR = '(0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal)'

// A track of net A on the front, a via of B, a plated through pad of A and an SMD pad of B
// in one footprint, and a zone of A filled on the back.
const ITEMS = [
  '\t(segment (start 0 0) (end 10 0) (width 1) (layer "F.Cu") (net "A") (uuid "00000000-0000-4000-8000-000000000001"))',
  '\t(via (at 20 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "B") (uuid "00000000-0000-4000-8000-000000000002"))',
  '\t(footprint "T" (layer "F.Cu") (uuid "00000000-0000-4000-8000-000000000003") (at 30 0)\n'
    + '\t\t(property "Reference" "J1" (at 0 0 0) (layer "F.SilkS") (effects (font (size 1 1))))\n'
    + '\t\t(pad "1" thru_hole circle (at 0 0) (size 2 2) (drill 1) (layers "*.Cu" "*.Mask") (net "A")'
    + ' (uuid "00000000-0000-4000-8000-000000000004"))\n'
    + '\t\t(pad "2" smd rect (at 5 0) (size 1 2) (layers "F.Cu" "F.Mask") (net "B")'
    + ' (uuid "00000000-0000-4000-8000-000000000005"))\n\t)',
  '\t(zone (net "A") (layer "B.Cu") (uuid "00000000-0000-4000-8000-000000000006") (hatch edge 0.5)'
    + ' (connect_pads yes (clearance 0.2)) (min_thickness 0.2) (fill yes (thermal_gap 0.3) (thermal_bridge_width 0.4))'
    + ` (polygon ${square(40, -5, 50, 5)}) (filled_polygon (layer "B.Cu") ${square(40, -5, 50, 5)}))`,
]

const copperOf = (pcb) => board_copper(pcb, new LayerSet(pcb, themes.default.board))

/** The net names of the triangles of `layer` that hold the point `x`, `y`. */
function netsAt(copper, layer, x, y) {
  const { triangles, nets } = copper.layers.find((l) => l.name === layer)
  const found = new Set()
  const side = (ax, ay, bx, by) => (bx - ax) * (y - ay) - (by - ay) * (x - ax)
  for (let i = 0; i < nets.length; i += 3) {
    const [ax, ay, bx, by, cx, cy] = triangles.subarray(i * 2, i * 2 + 6)
    const [d1, d2, d3] = [side(ax, ay, bx, by), side(bx, by, cx, cy), side(cx, cy, ax, ay)]
    if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) found.add(copper.nets[nets[i]])
  }
  return [...found]
}

describe('the board copper the 3D view draws', () => {
  const copper = copperOf(board(TWO, ITEMS))

  it('has every item on its own layers, with its net, and nothing beyond it', () => {
    expect(copper.layers.map((l) => l.name)).toEqual(['F.Cu', 'B.Cu'])
    for (const [layer, x, y, nets] of [
      ['F.Cu', 5, 0, ['A']], ['F.Cu', 5, 0.45, ['A']], ['F.Cu', 5, 0.55, []], ['F.Cu', 10.45, 0, ['A']],
      ['B.Cu', 5, 0, []],
      ['F.Cu', 20.25, 0, ['B']], ['B.Cu', 20, 0.25, ['B']], ['F.Cu', 20.35, 0, []],
      ['F.Cu', 30.75, 0, ['A']], ['B.Cu', 30, -0.75, ['A']], ['F.Cu', 31.05, 0, []],
      ['F.Cu', 35, 0.9, ['B']], ['B.Cu', 35, 0.9, []],
      ['B.Cu', 45, 0, ['A']], ['F.Cu', 45, 0, []],
    ]) expect([layer, x, y, netsAt(copper, layer, x, y)]).toEqual([layer, x, y, nets])
  })

  it('leaves the drills of a via and of a plated pad open', () => {
    expect(netsAt(copper, 'F.Cu', 20, 0)).toEqual([])
    expect(netsAt(copper, 'B.Cu', 30.4, 0)).toEqual([])
  })

  it('has a barrel for each, between the layers it joins', () => {
    const named = copper.barrels.map((b) => ({ ...b, net: copper.nets[b.net] }))
    expect(named).toEqual(expect.arrayContaining([
      { x: 20, y: 0, radius: 0.15, from: 0, to: 1, net: 'B' },
      { x: 30, y: 0, radius: 0.5, from: 0, to: 1, net: 'A' },
    ]))
    expect(named).toHaveLength(2)
  })
})

describe('the heights of the copper layers', () => {
  it('are those of KiCad\'s default stack for a board without one', () => {
    // BuildDefaultStackupList: 1.6 mm less 35 um of copper per layer and 10 um per mask,
    // shared by the dielectrics, core and prepreg by turns. The `.glb` of a 4-layer board
    // has its front copper at 1.51-1.545 and its back at -0.035-0.
    const pcb = board(FOUR, [])
    const stack = board_stack(pcb)
    expect(stack.map((item) => item.copper ?? item.dielectric)).toEqual(['F.Cu', 'core', 'In1.Cu', 'prepreg', 'In2.Cu', 'core', 'B.Cu'])
    for (const item of stack) expect(item.thickness).toBeCloseTo(item.copper ? 0.035 : 0.48, 9)
    for (const [layer, want] of [['F.Cu', [1.51, 1.545]], ['In1.Cu', [0.995, 1.03]], ['In2.Cu', [0.48, 0.515]], ['B.Cu', [-0.035, 0]]]) {
      const got = copper_z(stack, layer)
      expect(got[0]).toBeCloseTo(want[0], 9)
      expect(got[1]).toBeCloseTo(want[1], 9)
    }
    expect(copperOf(pcb).layers.map((l) => l.name)).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'])
  })

  it('follow the board\'s own stackup where it has one', () => {
    const setup = '(stackup (layer "F.Mask" (type "Top Solder Mask") (thickness 0.01))'
      + ' (layer "F.Cu" (type "copper") (thickness 0.07)) (layer "dielectric 1" (type "core") (thickness 0.8))'
      + ' (layer "B.Cu" (type "copper") (thickness 0.07)) (layer "B.Mask" (type "Bottom Solder Mask") (thickness 0.01)))'
    const layers = copperOf(board(TWO, [], setup)).layers
    expect(layers.map((l) => [l.name, +l.bottom.toFixed(6), +l.top.toFixed(6)])).toEqual([['F.Cu', 0.8, 0.87], ['B.Cu', -0.07, 0]])
  })
})
