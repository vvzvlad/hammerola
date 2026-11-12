# Assembly data (before any BOM/CPL, quotes and demos included)

- Part codes live on the symbols from the moment a part is chosen: every fitted symbol
  carries the assembler's code (`LCSC` for JLCPCB) and `MPN`. No side maps in scripts.
- An empty code on a fitted line blocks the package: the assembler will not place that
  part. If no acceptable part exists, ask the owner with 2-3 in-stock candidates (code,
  key specs, stock, price) instead of shipping an empty cell with a README note.
- Stock means the stock of the assembler the owner named; do not assume a contractor
  buys by MPN elsewhere. A part whose stock barely covers the build is not a pick.
  Re-query live stock for every line right before hand-off: it can fall from thousands
  to single digits within hours.
- Exclusions use native flags, never a custom field or a reference prefix.
  Non-components (test pads, joint pads, mounting holes): "Exclude from BOM" on the
  symbol, `exclude_from_bom` + `exclude_from_pos_files` on the footprint (KiCad's stock
  TestPoint symbol ships with `in_bom yes` — clear it). Real parts left unfitted: DNP.
  `kicad-cli pcb drc --schematic-parity` must show 0 `footprint_symbol_mismatch`.
- Every fitted footprint is typed SMD or through-hole. Footprints added by a tool-driven
  sync can arrive untyped, and an `--smd-only` placement export then drops them silently.
- One designator = one placed item: a footprint that needs two purchased pieces (two
  fuse clips) becomes two designators or uses a part number for the whole set.
- Export with the native tools (kicad-manufacture section 3, or `kicad-cli sch export bom --exclude-dnp` /
  `kicad-cli pcb export pos --exclude-dnp`) and commit any post-processing script beside
  the outputs. BOM designators = CPL designators = fitted footprints on the board.
- A BOM is reconciled with its schematic variant (`kicad-cli sch export bom --variant`):
  every fitted part has a line, every line exists; DNP flags mirror the current variant,
  and a variant switch is a change the parts diff cannot see — it goes into the revision's
  changelog. Every excluded or missing active part is judged by its nets: an omission that
  severs a mandatory function (the only RX path, a non-synchronous buck's catch diode) is
  MAJOR even when the board has always been built so (`schematic-review.md`, 6f).
- A panel for assembly: `panel.md`.
