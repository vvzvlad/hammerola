// What the KiCad viewer's element hands the BOM's assembly view of a board
// (ecad-viewer/packages/ecad-viewer-app/src/ecad-viewer/board-picture.ts,
// behind its `renderBoardPicture`, `getBoardPictureSize` and
// `getFootprintBoxes`): the box a picture is fitted to, the layers a side's
// picture draws and each part's box. The board is synthetic, read by the
// viewer's own parser; the drawing itself is checked in a browser, not here.

import { BoardParser } from 'kicad-parser'
import { describe, expect, it } from 'vitest'

// The board's model before board-picture.ts: that file reaches it only through
// the board's layers, which the model imports in turn, and loaded from that end
// the cycle leaves the model's layer names undefined.
import { KicadPCB } from '../../ecad-viewer/packages/ecad-viewer-app/src/kicad/index.ts'
import { footprint_boxes, picture_box, picture_layers } from '../../ecad-viewer/packages/ecad-viewer-app/src/ecad-viewer/board-picture.ts'
import themes from '../../ecad-viewer/packages/ecad-viewer-app/src/kicanvas/themes/index.ts'
import { LayerSet } from '../../ecad-viewer/packages/ecad-viewer-app/src/viewers/board/layers.ts'

const LAYERS = '(0 "F.Cu" signal) (4 "In1.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user) (3 "B.Mask" user)'
  + ' (5 "F.SilkS" user) (7 "B.SilkS" user) (17 "Dwgs.User" user) (19 "Cmts.User" user) (25 "Edge.Cuts" user)'
  + ' (27 "Margin" user) (33 "B.Fab" user) (35 "F.Fab" user)'

let uuid = 0
const id = () => `(uuid "00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}")`

/** A board of every layer above holding `items`. */
const board = (items) => new KicadPCB('test.kicad_pcb', new BoardParser().parse('(kicad_pcb\n'
  + '\t(version 20260206)\n\t(generator "pcbnew")\n\t(general (thickness 1.6))\n\t(paper "A4")\n'
  + `\t(layers ${LAYERS})\n\t(setup (pad_to_mask_clearance 0))\n${items.join('\n')}\n)\n`))

const line = (layer, x0, y0, x1, y1) => `\t(gr_line (start ${x0} ${y0}) (end ${x1} ${y1})`
  + ` (stroke (width 0.1) (type default)) (layer "${layer}") ${id()})`
/** A footprint `ref` at `x`, `y` on `layer` holding `items`. */
const footprint = (ref, layer, x, y, items) => `\t(footprint "T" (layer "${layer}") ${id()} (at ${x} ${y})\n`
  + `\t\t(property "Reference" "${ref}" (at 0 0 0) (layer "F.SilkS") (effects (font (size 1 1))))\n${items.join('\n')}\n\t)`
const smd = (x, y, w, h, layer = 'F.Cu') => `\t\t(pad "1" smd rect (at ${x} ${y}) (size ${w} ${h}) (layers "${layer}") ${id()})`
const outline = [line('Edge.Cuts', 0, 0, 100, 0), line('Edge.Cuts', 100, 0, 100, 50),
  line('Edge.Cuts', 100, 50, 0, 50), line('Edge.Cuts', 0, 50, 0, 0)]

/** The corners of a part's box, rounded to a micrometre. */
const corners = (box) => box.outline.map(([x, y]) => [+x.toFixed(3), +y.toFixed(3)])

describe('a picture of one side of the board', () => {
  it('is fitted to the outline grown by 2% of its longer side, whatever else lies off the board', () => {
    const pcb = board([...outline, line('Dwgs.User', -200, -150, 300, 250), line('Cmts.User', 0, 0, 400, 0)])
    const { x, y, w, h } = picture_box(pcb)
    // Within half a millimetre: the outline's stroke widens it a little.
    for (const [got, want] of [[x, -2], [y, -2], [w, 104], [h, 54]]) expect(got).toBeCloseTo(want, 0)
  })

  it('draws that side\'s pads, silkscreen, fab, the holes and the outline, and no other layer', () => {
    const names = [...new LayerSet(board(outline), themes.default.board).in_display_order()].map((layer) => layer.name)
    const drawn = (bottom) => names.filter((name) => picture_layers(bottom).has(name)).sort()
    const side = (s) => [`:${s}.Cu:Pads`, `${s}.SilkS`, `:${s}.SilkS:fp_ref`, `:${s}.SilkS:fp_value`,
      `${s}.Fab`, `:${s}.Fab:fp_ref`, `:${s}.Fab:fp_value`]
    const both = [':Pad:Holes', ':Pad:HoleWalls', ':NonPlatedHoles', 'Edge.Cuts']
    expect(drawn(false)).toEqual([...side('F'), ...both].sort())
    expect(drawn(true)).toEqual([...side('B'), ...both].sort())
  })
})

describe('a part\'s box', () => {
  const pcb = board([...outline,
    footprint('R1', 'F.Cu', 20, 10, [smd(-1, 0, 1, 0.5), smd(1, 0, 1, 0.5)]),
    footprint('U1', 'F.Cu', 50, 25, [smd(0, 0, 1, 1),
      '\t\t(fp_rect (start -3 -2) (end 3 2) (stroke (width 0) (type default)) (fill none) (layer "F.Fab") '
      + `${id()})`]),
    footprint('J1', 'B.Cu', 80, 40, [smd(0, 0, 4, 2, 'B.Cu')]),
  ])
  const boxes = new Map(footprint_boxes(pcb).map((box) => [box.reference, box]))

  it('spans the pads of a part with no graphics, not a dot at its origin', () => {
    expect(corners(boxes.get('R1'))).toEqual([[18.5, 9.75], [21.5, 9.75], [21.5, 10.25], [18.5, 10.25]])
  })

  it('takes in the graphics where they reach past the pads', () => {
    expect(corners(boxes.get('U1'))).toEqual([[47, 23], [53, 23], [53, 27], [47, 27]])
  })

  it('knows the side it is on', () => {
    expect([...boxes.values()].map((box) => [box.reference, box.bottom])).toEqual([['R1', false], ['U1', false], ['J1', true]])
  })
})
