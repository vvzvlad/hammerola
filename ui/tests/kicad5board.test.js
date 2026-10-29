// A board as KiCad 5 writes it, read by the viewer's own parser into its own board
// (ecad-viewer/packages/kicad-parser/src/board_parser.ts, .../ecad-viewer-app/src/kicad/board.ts).
// KiCad 5 calls a footprint `module`; gives an arc by its centre (`start`), its start
// (`end`) and the angle it sweeps, with no `mid`; and writes a zone's fill without a
// layer, a zone then having only one. The sweeps are the ones kicad-cli drew for arcs
// of radius 3 round (10, 10); the boxes below are those, moved to each arc's centre and
// radius. The board's frame is kicad-cli's for this board.

import { BoardParser } from 'kicad-parser'
import { describe, expect, it } from 'vitest'

import { KicadPCB } from '../../ecad-viewer/packages/ecad-viewer-app/src/kicad/index.ts'

const BOARD = new KicadPCB('k5.kicad_pcb', new BoardParser().parse('(kicad_pcb (version 20171130) (host pcbnew 5.1.9)\n'
  + '  (layers (0 F.Cu signal) (31 B.Cu signal) (44 Edge.Cuts user))\n'
  // 240° from 150° on a circle of radius 3 round (10, 10)
  + '  (gr_arc (start 10 10) (end 7.401924 11.5) (angle 240) (layer Edge.Cuts) (width 0.01))\n'
  + '  (module Shape (layer F.Cu) (at 40 0)\n'
  // -90° from 0° on a circle of radius 3 round the module's origin
  + '    (fp_arc (start 0 0) (end 3 0) (angle -90) (layer Edge.Cuts) (width 0.01))\n'
  // 90° from 0° on a circle of radius 1, inside a custom pad
  + '    (pad 1 smd custom (at 0 0) (size 1 1) (layers F.Cu)\n'
  + '      (primitives (gr_arc (start 0 0) (end 1 0) (angle 90) (width 0.1))))\n  )\n'
  + '  (zone (net 1) (net_name GND) (layer F.Cu) (tstamp 0) (hatch edge 0.508)\n'
  + '    (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)))\n'
  + '    (filled_polygon (pts (xy 0.5 0.5) (xy 9.5 0.5) (xy 9.5 9.5) (xy 0.5 9.5))))\n)\n'))

/** `box` as [x, y, x2, y2] is close to `want`. */
const expectBox = (box, want) => [box.x, box.y, box.x2, box.y2].forEach((got, i) => expect(got).toBeCloseTo(want[i], 5))

describe('a board KiCad 5 wrote', () => {
  it('opens, with its modules as footprints', () => {
    expect(BOARD.footprints.map((footprint) => footprint.library_link)).toEqual(['Shape'])
  })

  it('draws each arc as the arc KiCad draws, the way it sweeps', () => {
    const [arc] = BOARD.drawings
    const [fpArc] = BOARD.footprints[0].drawings
    const [padArc] = BOARD.footprints[0].pads[0].primitives
    expect([arc, fpArc, padArc].map((item) => item.constructor.name)).toEqual(['GrArc', 'FpArc', 'GrArc'])
    expectBox(arc.bbox, [7, 7, 13, 11.5])
    // in the module's own coordinates, as each item inside it is kept
    expectBox(fpArc.bbox, [0, -3, 3, 0])
    expectBox(padArc.bbox, [0, 0, 1, 1])
    expectBox(BOARD.bbox, [7, -3, 43, 11.5])
  })

  it('fills each zone on the zone\'s own layer', () => {
    expect(BOARD.zones[0].filled_polygons.map((fill) => fill.layer)).toEqual(['F.Cu'])
  })
})

describe('a board KiCad 6 or later wrote', () => {
  it('keeps the layer each fill names, on a zone over several layers', () => {
    const board = new KicadPCB('k6.kicad_pcb', new BoardParser().parse('(kicad_pcb (version 20221018)\n'
      + '  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))\n'
      + '  (zone (net 1) (net_name "GND") (layers "F.Cu" "B.Cu")\n'
      + '    (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1)))\n'
      + '    (filled_polygon (layer "F.Cu") (pts (xy 0 0) (xy 1 0) (xy 1 1)))\n'
      + '    (filled_polygon (layer "B.Cu") (pts (xy 0 0) (xy 1 0) (xy 1 1)))))\n'))
    expect(board.zones[0].filled_polygons.map((fill) => fill.layer)).toEqual(['F.Cu', 'B.Cu'])
  })
})
