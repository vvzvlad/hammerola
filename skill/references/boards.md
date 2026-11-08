# KiCad designs and Gerbers

A schematic, a board, the 3D model of a board and the Gerber set are published
as documents of the project and viewed in the browser; the `documents` list
itself, and every other kind of file published beside the model, is in
`references/documents.md`.

## Designing in KiCad

The schematic and the board are yours to draw, place and route, in KiCad 10
through the Copperpour MCP server: its `mcp__copperpour__*` tools, every
toolset loaded at start (`references/copperpour-gaps.md`). Load Copperpour's rules (the
skill `konnect`) and read the owner's rules, `references/kicad.md`, together with the
skill for the step:
`kicad-schematic`, `kicad-pcb`, `kicad-library`, `kicad-review` or
`kicad-manufacture`. The owner's agents take the long parts:
`kicad-schematic-build` draws a schematic, `kicad-pcb-layout` places and routes
a board, `kicad-pcb-critic` reviews it before the fab. The KiCad project lives
in the model's repository and is published with it, as the documents below.

## Gerbers

Gerbers are ONE `.zip` listed like any document: the set that goes to the fab,
`kicad-cli pcb export gerbers --board-plot-params` and `kicad-cli pcb export drill
--excellon-separate-th`, zipped (the KiCad project's own fab zip will do). The page unzips
it in the browser, tells each layer by the `%TF.FileFunction` inside the file and draws
copper, mask, silkscreen, paste, outline and drills with a toggle per layer, the board seen
from the top or from the bottom, with Download and Copy link for the zip at the bottom
left of the page. It sits beside the board's view
and does not replace it. A listed `.zip` is read as a set of Gerbers unless its entry
says `"download": true`, and the zip opens
to the link without a key like the other documents, so whoever has the link has the
whole fabrication set.

A KiCad schematic, a board and the 3D model of a board are documents like any
other, one entry and one row each, with any caption, as many as the project has:

```json
"documents": [{"file": "hw/main.kicad_sch", "title": "Main schematic"},
              {"file": "hw/main.kicad_pcb", "title": "Main board"},
              {"file": "hw/main.glb", "title": "Main board, 3D"},
              {"file": "ds/tpa3250.pdf", "title": "TPA3250", "hidden": true}]
```

A schematic is listed by its root sheet; the hub publishes with it every sheet
the schematics name, wherever in the project they sit, and the `.kicad_pro` with
the same path minus the extension if it is there (a `.kicad_pro` listed as a
document refuses the push). Sheet numbers beside global labels (KiCad's
inter-sheet references, `[2,5]`) are drawn, in KiCad and on the hub page, only when
that `.kicad_pro` turns them on: `"schematic": {"drawing": {"intersheets_ref_show":
true}}`. KiCad leaves them off, so a `.kicad_pro` written by a script has them off
unless it writes that key. The `.glb` is made by the hub, from the board of the same
name, on every push: list it, do not commit it — a listed `.glb` that the tree also
holds beside a board of its name refuses the push. The export is `kicad-cli pcb export glb --subst-models
--include-silkscreen --include-soldermask --no-dnp` (about 10 MB for a 235-part board);
a `.glb` with no board of its name beside it is published as committed. It carries no
tracks, pads or zones: the hub draws the copper in 3D itself, from the `.kicad_pcb` with
the same path minus the extension, with its nets and layers. A part gets a body only
from a 3D model the hub can reach: KiCad's standard library, or a file inside the
project (`${KIPRJMOD}/…`); a model outside the project leaves the part bare.
Entries with the same path minus the extension are ONE design: `hw/main.kicad_sch`,
`hw/main.kicad_pcb` and `hw/main.glb` above. Picking a part in one of them (a click)
picks the same part, by its reference, in the others (a click on nothing or Escape
clears it everywhere). A right click on a part, a pad or a net in any entry, and on
the schematic a left click on a net too (a label, a power symbol, a sheet pin, a
wire), opens one menu with a row for every place it can be shown: under `PART C507`
the part in each listed entry (`<caption>`) and its datasheet, under `NET +12V` every
place of the net on every sheet (`<sheet>`, or `<sheet>:<name>` for another net
of the same run of wires; global labels and power symbols of one
name, hierarchical labels of one name with their sheet pins) and the net on the board
(`<caption>`). It opens on the row of what was clicked; the arrows ‹ › go from
place to place, past the datasheet, and a click on a row goes there, switching the
entry or the sheet with the part or net selected, and the menu stays open. An entry without siblings is a design of one. To
hang a datasheet on a part, put the PDF in the project, list it
`"hidden": true`, and set the part's `Datasheet` field to its path relative to the
`.kicad_pro` (`${KIPRJMOD}/ds/tpa3250.pdf`): the part's menu then has
`Datasheet · <caption>`, which opens the PDF in a window over the view (× or Escape
brings the design back as it was), and the design's BOM view links it in its Datasheet
column. A web address in the field gets no menu item and no window; only the BOM's
Datasheet column shows it, as a link that opens in a new tab. To price a part, add a
`Price` field to its symbol (a field of your own, as `LCSC` is: the price of one piece,
`0.12` or `12 ₽`): the BOM view shows it in its Price column, multiplies it by the
quantity in its Sum column and adds the rows up under the table, DNP parts left out.
KiCad has no price field of its own. A missing sheet, a sheet
outside the project or under a name the
alphabet refuses, more than 64 schematics or more than 8 levels of sheets refuse
the push, naming the file. The files open to the link without a key: whoever has it can
download the whole editable design.

## The board in the model

A board of the project goes into the model — an enclosure round it, a stack of boards —
through `import kicadboard`. The hub exports the board from the `.kicad_pcb` on every
build, so a commit that changes the board rebuilds the model with the new board in it;
nothing is exported by hand and nothing exported is committed.

```python
import cadquery as cq
import kicadboard

AMP = kicadboard.load("kicad/amp.kicad_pcb")  # once, at module level

def parts():
    at = cq.Location((0, 0, STANDOFF_H))      # the board's bottom face on the standoffs
    return {**AMP.records("amp", at=at), "case": {"shape": case(), "kind": "printable"}}
```

- **The board's frame** is KiCad's STEP frame, in millimetres: x is KiCad's x, y is
  minus KiCad's y (KiCad's y grows down the screen), z = 0 is the laminate's bottom
  face and `AMP.thickness` its top face.
- **`records(prefix, at=...)`** returns `<prefix>_pcb`, the laminate as a solid, kind
  `hardware` — the overlap gate sees it: a standoff the board merely rests on passes,
  a screw or a pin through its hole is a declared overlap. Its open holes are the ones
  something may pass through: NPTH holes, Edge.Cuts cut-outs, and the plated holes of
  footprints with no fitted part (mounting holes, DNP parts); the holes of fitted
  through-hole parts are filled, their leads are in them — `<prefix>_mask`, `<prefix>_copper` and `<prefix>_silk`, the board's surface
  as KiCad renders it, and `<prefix>_parts_<rrggbb>`, the fitted parts as meshes merged
  by colour rounded to 16 levels a channel (the key names the rounded colour); these are
  kind `mock`, which no gate sees. Everything is already moved by `at`, and a view
  cannot move it again (a mesh refuses `at`): to show the board elsewhere, move the
  other parts. DNP parts are left out.
- **`AMP.footprints["H1"]`** is every footprint, those without a 3D model too: `x`, `y`,
  `angle`, `side` (`"F"` or `"B"`), `location` (a `cq.Location` from the footprint's own
  frame, Z out of the side it sits on, into the board's frame), `pads` (number → `x`,
  `y`, `net`) and `bounds` (the box of its 3D model, None without one). Take the
  enclosure's numbers from them — a boss under each mounting hole, a window over each
  connector, a wire to a terminal's pad, the lid above the tallest part — and the case
  follows the board when the board changes. Two boards on one header: board B's `at` is
  board A's `at` times `A.footprints["J1"].location` times
  `cq.Location((0, 0, MATED_H), (0, 1, 0), 180)` times
  `B.footprints["P1"].location.inverse`. The turn is about the axis the row of pins runs
  along — the footprint's Y for KiCad's `PinHeader_*` and `PinSocket_*`; about the other
  axis board B lands turned 180° with only pin 1 in place. Check it in `checks()`, not on
  the picture: for every pad number of J1, its pad and P1's, both moved into the model's
  frame, share x and y.
- **A part without a body** is named in the build log (`Could not add 3D model for
  U301`): its model is neither in KiCad's standard library nor inside the project
  under `${KIPRJMOD}`. The hub's KiCad service gets the board, its `.kicad_pro` and
  those project models, nothing else of the project.
- **A load costs the build about a minute on a dense board** (dionis, 309 footprints
  with tracks and pours: 48 s of export); the check workers reuse the build's exports.
