# KiCad designs and Gerbers

A schematic, a board, the 3D model of a board and the Gerber set are published
as documents of the project and viewed in the browser; the `documents` list
itself, and every other kind of file published beside the model, is in
`references/documents.md`.

## Gerbers

Gerbers are ONE `.zip` listed like any document: the set that goes to the fab,
`kicad-cli pcb export gerbers --board-plot-params` and `kicad-cli pcb export drill
--excellon-separate-th`, zipped (the KiCad project's own fab zip will do). The page unzips
it in the browser, tells each layer by the `%TF.FileFunction` inside the file and draws
copper, mask, silkscreen, paste, outline and drills with a toggle per layer, the board seen
from the top or from the bottom, with Download and Copy link for the zip at the bottom
left of the page; a model's build page
also lists it under GERBERS in Downloads, beside the STL. It sits beside the board's view
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
unless it writes that key. The `.glb` is made on your machine, not on the hub:
`kicad-cli pcb export glb --subst-models --include-tracks --include-pads --include-zones
--include-silkscreen --include-soldermask -o hw/main.glb hw/main.kicad_pcb` (about 41 MB
for a 235-part board; without the tracks, pads and zones it is 10 MB, and the 3D view has
no routing).
Entries with the same path minus the extension are ONE design: `hw/main.kicad_sch`,
`hw/main.kicad_pcb` and `hw/main.glb` above. Picking a part in one of them (a click)
picks the same part, by its reference, in the others (a click on nothing or Escape
clears it everywhere), and a right click on a part, or on a net on the board (a
track, a pad), opens a menu with an item for every other listed entry of the
design, the part's (`Show C507 in <caption>`) apart from the net's
(`Show net +12V in <caption>`), and for a net on schematic sheets one per sheet it
is on (`… · <sheet>`); choosing one opens it with the part or net selected there.
On the schematic a click on a net, left or right (a label, a power symbol, a sheet
pin, a wire), lists every place of that net on every sheet (global labels and power
symbols of one name, hierarchical labels of one name with their sheet pins), with
arrows to step through them and `Show net +12V in <caption>` of the board as the
last row. An entry without siblings is a design of one. To hang a datasheet on a part, put the PDF in the project, list it
`"hidden": true`, and set the part's `Datasheet` field to its path relative to the
`.kicad_pro` (`${KIPRJMOD}/ds/tpa3250.pdf`): the part's right-click menu then has
`Open datasheet · <caption>`, which opens the PDF in a window over the view (× or Escape
brings the design back as it was), and the design's BOM view links it in its Datasheet
column. A web address in the field gets no menu item and no window; only the BOM's
Datasheet column shows it, as a link that opens in a new tab. A missing sheet, a sheet outside the project or under a name the
alphabet refuses, more than 64 schematics or more than 8 levels of sheets refuse
the push, naming the file. The files open to the link without a key: whoever has it can
download the whole editable design.
