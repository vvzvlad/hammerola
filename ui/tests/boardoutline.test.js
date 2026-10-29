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
})
