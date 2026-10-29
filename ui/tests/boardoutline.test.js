// The box a board view fits on load and on Fit: the board's outline,
// `KicadPCB.bbox` in ecad-viewer/packages/ecad-viewer-app/src/kicad/board.ts. A
// board converted from Eagle draws its outline inside "board shape" footprints, as
// WB-MGU v1.2 does in ADD1 and EXC2, and keeps a few millimetres of cut of its own
// on the board; KiCad cuts along both. The board below is synthetic, shaped as
// KiCad 10 writes one, read by the viewer's own parser.

import { BoardParser } from 'kicad-parser'
import { describe, expect, it } from 'vitest'

import { KicadPCB } from '../../ecad-viewer/packages/ecad-viewer-app/src/kicad/index.ts'

const edge = (kind, x1, y1, x2, y2) => `(${kind}_line (start ${x1} ${y1}) (end ${x2} ${y2})`
  + ' (stroke (width 0.254) (type solid)) (layer "Edge.Cuts"))'
const BOARD = new KicadPCB('test.kicad_pcb', new BoardParser().parse('(kicad_pcb\n\t(version 20260206)\n'
  + '\t(generator "pcbnew")\n\t(general (thickness 1.6))\n\t(paper "A4")\n'
  + '\t(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))\n'
  + `\t${edge('gr', 14, -26, 21, -19)}\n`
  + '\t(footprint "MGE_VERT"\n\t\t(layer "F.Cu")\n\t\t(at 60 -90)\n'
  + `\t\t${edge('fp', -57, -50, 0, -50)}\n\t\t${edge('fp', -57, -50, -57, 85)}\n\t)\n`
  // a cut inside a part turned 90°, which KiCad turns from (30, 0) up to (0, -30)
  + '\t(footprint "R"\n\t\t(layer "F.Cu")\n\t\t(at 100 0 90)\n'
  + `\t\t${edge('fp', 0, 0, 30, 0)}\n\t)\n)\n`))

describe('the outline a board view fits', () => {
  it('takes in the Edge.Cuts drawn inside footprints, where each footprint puts them on the board', () => {
    const { x, y, x2, y2 } = BOARD.bbox
    // close, not equal: cos 90° is 6e-17 in floating point
    for (const [got, want] of [[x, 3], [y, -140], [x2, 100], [y2, 0]]) expect(got).toBeCloseTo(want, 9)
  })

  it('counts an arc where it runs, as KiCad does', () => {
    // A 20 x 10 frame with two arcs of radius 1 inside it: one turning 90° to 180°, as the
    // rounded corner in WB-MGU's ADD1 does, one turning 180° to 270°. kicad-cli fitted to
    // this board grows it by one stroke width, so neither arc reaches past the frame.
    const arc = (start, mid, end) => `(gr_arc (start ${start}) (mid ${mid}) (end ${end})`
      + ' (stroke (width 0.254) (type solid)) (layer "Edge.Cuts"))'
    const board = new KicadPCB('arcs.kicad_pcb', new BoardParser().parse('(kicad_pcb\n\t(version 20260206)\n'
      + '\t(generator "pcbnew")\n\t(layers (0 "F.Cu" signal) (25 "Edge.Cuts" user))\n'
      + `\t${edge('gr', 0, 0, 20, 0)}\n\t${edge('gr', 20, 0, 20, 10)}\n`
      + `\t${edge('gr', 20, 10, 0, 10)}\n\t${edge('gr', 0, 10, 0, 0)}\n`
      + `\t${arc('5 1.5', '4.2928932 1.2071068', '4 0.5')}\n`
      + `\t${arc('14 9.5', '14.2928932 8.7928932', '15 8.5')}\n)\n`))
    const { x, y, x2, y2 } = board.bbox
    for (const [got, want] of [[x, 0], [y, 0], [x2, 20], [y2, 10]]) expect(got).toBeCloseTo(want, 6)
  })

  it('reaches as far as an arc bulges, whichever way it runs', () => {
    // A 20 x 10 frame whose short sides are half circles bulging 5 out: the right one turning
    // from 90° back through 0° to -90°, the left one from -90° through -180° to -270°. Only
    // where each crosses its axis reaches the frame's edge; kicad-cli fits this board to 30 x 10.
    const arc = (start, mid, end) => `(gr_arc (start ${start}) (mid ${mid}) (end ${end})`
      + ' (stroke (width 0.254) (type solid)) (layer "Edge.Cuts"))'
    const board = new KicadPCB('bulge.kicad_pcb', new BoardParser().parse('(kicad_pcb\n\t(version 20260206)\n'
      + '\t(generator "pcbnew")\n\t(layers (0 "F.Cu" signal) (25 "Edge.Cuts" user))\n'
      + `\t${edge('gr', 0, 0, 20, 0)}\n\t${arc('20 10', '25 5', '20 0')}\n`
      + `\t${edge('gr', 20, 10, 0, 10)}\n\t${arc('0 0', '-5 5', '0 10')}\n)\n`))
    const { x, y, x2, y2 } = board.bbox
    for (const [got, want] of [[x, -5], [y, 0], [x2, 25], [y2, 10]]) expect(got).toBeCloseTo(want, 6)
  })
})
