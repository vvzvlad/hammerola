# Schematic and library rules

## Schematic (kicad-schematic)

### Connections between sheets

The parent sheet is the block diagram of the design: a box per child sheet and wires between
them that are the real nets. So a signal that crosses sheets goes through a hierarchical label
on every sheet that uses it, a sheet pin of the same name on that sheet's box, and a wire
between the pins on the parent sheet; ERC then checks that every pin is wired. Global labels
never carry a signal between sheets, whatever kicad-schematic's label table says; only power
symbols are global. A root sheet of empty boxes is a defect.

### Connections on one sheet

On one sheet a connection is a wire, between groups and over any distance, wherever the wire
crosses nothing and does not get in the way of reading. This overrides kicad-schematic's
decision table, which sends every connection over 30 mm or with a signal name to
`connect_to_net`. A pair of local labels standing in for such a wire is a defect. The owner,
on the four filtered inputs of an ADE7913 split into label pairs: «ему лень было протянуть 4
линии, которые ничего не портят и не мешают читать?» A net whose name something reads (a
netclass pattern in the `.kicad_pro`, a document) keeps one label on its wire as the name.

### What the sheet says about itself

A reader of the sheet — a reviewer, the firmware author, the next revision's designer —
gets from the sheet itself, not from a chat:

- every MCU signal documented at its pin or net: what the level means, inversion, what it
  enables; a change to the MCU pinout is told to the firmware author;
- the formula behind every analog network (a divider's ratio and its range, a sense
  resistor's full-scale) and the voltage and frequency ranges of an input, as a note;
- an alternative part that needs other parts changed with it, as a note at the part;
- every isolation domain as a net class, and the isolation voltage and the required
  distance between domains stated on the sheet (`schematic-review.md`, 6b).

Two footprints for one package in the project's library is a defect: one footprint per
package. A connection reads as a wire, not as two pin ends set against each other.
Wires, references and values cross neither symbols nor each other — judged on the
render, not on `check_schematic_overlaps`. Net names in English, never transliterated.

### Power symbols

- A rail with no stock power symbol (GNDISO, +12V_BUS): `add_schematic_component` with
  lib_id `power:VCC` and value `<RAIL>`; the net takes the Value. The reference comes back
  `#PWR?`: pass one or run `annotate_schematic`.
- `add_power_symbol` numbers #PWR per sheet from `#PWR01` (after `#PWR09` comes `#PWR010`),
  so a multi-sheet project gets duplicate #PWR references that fail the netlist gate.
  Renumber each sheet into its own range with `edit_schematic_component` `new_reference`,
  building the calls from the references `list_schematic_components` returns, never from a
  guessed `#PWR%d`.

### Test points

A test pad on a net that already reaches an external terminal block, header or pad row
is redundant: skip such nets. Contacts a probe cannot reach (fine-pitch connector pins,
a soldered board-to-board joint) do not count as access. If the request literally says
"all nets", ask one question before adding any pads (skip nets with external access?)
instead of taking the literal reading and only mentioning it in the report. On a board
under the probe contract (the `probe-bench` skill) the skip does not apply: the
bench's head lands only on its probe groups and never reaches a connector's pins.

### Annotation and the netlist gate

`annotate_schematic` does not detect duplicates already spread across sheets, so annotate each sheet
and then run the netlist gate below (not only `run_erc`).

- Every reference must end in a digit (J_LINK_A → J_LINK_A1). KiCad treats one that does
  not as unannotated and `annotate_schematic` renumbers it; never skip annotation to keep a name.
- `run_erc` (kicad-cli sch erc) reports neither a missing digit nor a duplicate reference,
  even across sheets. Gate after any reference change: `kicad-cli sch export netlist -o
  <scratch>.net <root>.kicad_sch` must not print "schematic has annotation errors".
- ERC is triaged by category, never dumped: `unconnected_wire_endpoint`,
  `pin_not_connected` on intentional NC, `lib_symbol_issues`, `footprint_link_issues`,
  `power_pin_not_driven` for a rail fed through an L or an R, `multiple_net_names` for
  intentional dual labels (they hand you the rail map), `pin_to_pin` on an EPAD are the
  usual noise; the report quotes the real-vs-noise split. In the kicadxml netlist
  `<node pin>` is the pad number and `pinfunction` the name — review by net and pad
  number (`schematic-review.md`, KiCad pitfalls).

### Moving parts and overlap checks

- `move_schematic_component` and the bulk moves leave wires where they were: delete the
  wires, move, re-add them. `check_schematic_overlaps` skips free text and compares labels
  only at the same spot, so "0 overlaps" is not visual acceptance.

## Library (kicad-library)

### When to create a custom part

In addition to kicad-library's list:

- No library footprint matches the manufacturer's drawing (see Production footprints)

### Required symbol fields

Required on every fitted part of an assembled board:
- `LCSC` — LCSC/JLCPCB part number for assembly
- `MPN` — Manufacturer part number

Optional:
- `Description` — Short text description

### Symbol body size

- `create_symbol` sizes the body to the pin span, not to the names. A 1.27 mm pin name
  takes about 1.2 mm per character: body width >= 1.2 mm x (longest left + longest right
  name, in characters) + 4 mm. Top/bottom pin names run vertically into the body; keep
  them clear of the side names. Render one placed instance (acceptance step 3) and check
  names and Reference/Value before wiring it: a pin move after wiring means rewiring.

### Production footprints

- A stand-in footprint (a sibling module, a "close" stock part, a wrong-pitch generic)
  is an open item listed by refdes. Replace it with the exact MPN's land pattern before
  the schematic review and before `update_pcb_from_schematic`. "Search first" only finds
  candidates: a stock footprint is accepted when its pads, holes and slots match the
  manufacturer's drawing.
- Geometry source: the manufacturer's recommended land pattern. If the PDF drawing has
  no text layer, render the page (`pdftoppm -r 400..600`), scale from a dimensioned
  feature, and save the transcription with URL and fetch date. EasyEDA / easyeda2kicad /
  LCSC footprints are a cross-check, not the source: list every pad, hole and slot
  dimension that differs. No usable drawing, or the drawing breaks the fab minimums:
  choose another part that has one.
- Isolation-barrier parts (digital isolators, isolated transceivers and ADCs,
  optocouplers): compute the gap between the inner pad edges of the two sides (pad rows
  at ±x: 2*|x_pad| - pad length in x) and check it against the creepage requirement.
  A stock footprint for the package is not proof: KiCad 10
  `SOIC-8_7.5x5.85mm_P1.27mm` gives 8.85 mm where TI's DWV0008A land pattern gives
  9.1 mm, and `SOIC-20W_7.5x15.4mm_P1.27mm` (ADI RI-20-1) gives 7.25 mm.
- Connector series (2P/3P/4P of one family): at 0 deg every variant has pin 1 on the
  same side and the wire-entry face on the same side. Take the entry side from the
  manufacturer's drawing (EasyEDA silk and its 3D model can disagree) and fix a variant
  drawn the other way in the library, not by rotating it on the board.
- `create_footprint` without `body_width`/`body_height` draws the silk/fab outline from
  the pad envelope; pass the real body dimensions.

### Courtyard margin

- **Courtyard margin per KLC F5.3** — 0.25 mm default, 0.15 mm for parts under 1.5 mm,
  0.5 mm for connectors, crystals and canned caps, 1.0 mm for BGA

### Models on placed boards

Nothing in KiCad flags a missing model, so check:

- Footprints placed by `update_pcb_from_schematic` can arrive with no `(model)` at all,
  stock ones included. DRC and library parity ignore models, and `kicad-cli pcb render`
  draws bare pads without a warning. After every sync or placement, list footprints that
  are not DNP, exclude_from_bom or board-only and have `len(fp.Models()) == 0` (pcbnew).
  Every part on that list that has a physical body gets a model. A pads-only 3D render is
  a failed check, not cosmetics.
- Dead paths: `kicad-cli pcb export step` without `-D` overrides prints
  "Could not add 3D model for <ref>. File not found: <path>" for each dead path and still
  exits 0, so grep its output. It is silent about footprints with no model. Stock paths
  can be dead too: in KiCad 10.0.6, `Package_SO:TI_SO-PowerPAD-8_ThermalVias` points to a
  .step that is not installed.
- Own models in a library used by more than one project: give the path relative to the
  .pretty folder (`../3dmodels/X.step`). It resolves from every project that uses the
  library. `${KIPRJMOD}` is the folder of the project that opens the board, so
  `${KIPRJMOD}/3dmodels/...` breaks in a project at another depth. Fix the library
  footprint first, then refresh the placed copies. A fix made only on the board is
  invisible to parity, and the next library update can undo it.
- easyeda2kicad offsets and rotations can be wrong. Fit the model by its pads (or pegs
  and shield legs), then check the pin-1 and wire-entry side in a render.
- Parts that are not fitted: set DNP and export 3D with `--no-dnp` (or hide the model).
  Otherwise fit checks count bodies that will not be there.
