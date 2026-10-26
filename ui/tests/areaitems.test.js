// What a comment's area on a KiCad document holds, as its words (`area_items` in
// ecad-viewer/packages/ecad-viewer-app/src/ecad-viewer/area-items.ts, which the
// viewer's `itemsInArea` hands what its layers painted). The board and the sheet
// are synthetic s-expressions shaped as KiCad 10 writes them, read by the
// viewer's own parser into its own documents, with `kicad-parser` aliased as its
// build aliases it (vitest.config.mjs). The box each item was painted in is given
// here, as the painter would record it once per layer the item is drawn on.

import { BoardParser, SchematicParser } from 'kicad-parser'
import { describe, expect, it } from 'vitest'

import { BBox } from '../../ecad-viewer/packages/ecad-viewer-app/src/base/math/index.ts'
import { area_items } from '../../ecad-viewer/packages/ecad-viewer-app/src/ecad-viewer/area-items.ts'
import { KicadPCB, KicadSch } from '../../ecad-viewer/packages/ecad-viewer-app/src/kicad/index.ts'
import { SchematicInstanceContext } from '../../ecad-viewer/packages/ecad-viewer-app/src/kicad/schematic.ts'

const font = '(effects (font (size 1 1)))'
const pad = (number, x, net) => `\t\t(pad "${number}" smd roundrect\n\t\t\t(at ${x} 0 90)\n\t\t\t(size 0.8 0.95)\n`
  + `\t\t\t(layers "F.Cu" "F.Mask" "F.Paste")\n\t\t\t(roundrect_rratio 0.25)\n\t\t\t(net "${net}")\n\t\t)\n`
/** An 0603 resistor at (`x`, `y`) turned 90°, as dionis has them, its pads' nets `nets`. */
const resistor = (reference, x, y, nets) => `\t(footprint "Resistor_SMD:R_0603_1608Metric"\n\t\t(layer "F.Cu")\n`
  + `\t\t(at ${x} ${y} 90)\n\t\t(property "Reference" "${reference}" (at 0 -1.43 90) (layer "F.SilkS") ${font})\n`
  + '\t\t(fp_rect (start -1.48 -0.73) (end 1.48 0.73) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))\n'
  + `${pad('1', -0.825, nets[0])}${pad('2', 0.825, nets[1])}\t)\n`
const BOARD = new KicadPCB('test.kicad_pcb', new BoardParser().parse('(kicad_pcb\n\t(version 20260206)\n\t(generator "pcbnew")\n'
  + '\t(general (thickness 1.6))\n\t(paper "A4")\n\t(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (31 "F.CrtYd" user))\n'
  + `${resistor('R1', 100, 50, ['VBUS', 'GND'])}${resistor('R2', 110, 50, ['Net-(R2-Pad1)', 'unconnected-(R2-Pad2)'])})\n`))

/** A placed symbol whose instance on sheet `/root` is `reference`. */
const symbol = (libId, reference, value, x, y) => `\t(symbol\n\t\t(lib_id "${libId}")\n\t\t(at ${x} ${y} 0)\n`
  + `\t\t(uuid "${reference}")\n\t\t(property "Reference" "${reference.replace(/\d+$/, '?')}" (at ${x} ${y} 0) ${font})\n`
  + `\t\t(property "Value" "${value}" (at ${x} ${y} 0) ${font})\n`
  + `\t\t(instances\n\t\t\t(project "p" (path "/root" (reference "${reference}") (unit 1)))\n\t\t)\n\t)\n`
const SHEET = new KicadSch('test.kicad_sch', new SchematicParser().parse('(kicad_sch\n\t(version 20250610)\n'
  + '\t(generator "konnect")\n\t(lib_symbols)\n'
  + `${symbol('Device:R', 'R1', '10k', 100, 100)}${symbol('power:+3V3', '#PWR01', '+3V3', 100, 90)}`
  + `${symbol('power:PWR_FLAG', '#FLG01', 'PWR_FLAG', 110, 90)}\t(label "SDA" (at 120 100 0) ${font})\n)\n`))

/** Each footprint as two layers paint it: its copper and its courtyard. */
const boardPainted = () => BOARD.footprints.flatMap((footprint) => [[footprint, footprint.bbox], [footprint, footprint.bbox]])
/** Each symbol and label of the sheet in a 2 mm box round where it stands. */
const sheetPainted = () => [...SHEET.symbols.values(), ...SHEET.net_labels]
  .map((item) => [item, new BBox(item.at.position.x - 1, item.at.position.y - 1, 2, 2)])

describe('what a comment\'s area on a KiCad document holds', () => {
  it('on a board, names the footprints it meets and the nets of the pads inside it', () => {
    const board = { context: 'PCB', board: BOARD }
    // R1's pad 1 lands below its centre, (100, 50.825), and pad 2 above it, as KiCad turns them.
    expect(area_items(board, [99.9, 50.6, 0.2, 0.2], boardPainted())).toEqual(['R1', 'VBUS'])
    expect(area_items(board, [99.9, 49.2, 0.2, 0.2], boardPainted())).toEqual(['GND', 'R1'])
    // the names KiCad makes up for R2's unnamed nets are left out
    expect(area_items(board, [99, 48, 13, 4], boardPainted())).toEqual(['GND', 'R1', 'R2', 'VBUS'])
    expect(area_items(board, [120, 48, 2, 4], boardPainted())).toEqual([])
  })

  it('on a sheet, names the parts and the labels, a power symbol by its net, and a flag not at all', () => {
    const sheet = { context: 'SCH', instance: new SchematicInstanceContext(SHEET, '/root') }
    expect(area_items(sheet, [95, 85, 30, 20], sheetPainted())).toEqual(['+3V3', 'R1', 'SDA'])
    expect(area_items(sheet, [108, 88, 4, 4], sheetPainted())).toEqual([])
  })
})
