# Panel: several boards on one blank for assembly

A board ordered assembled in quantity, or smaller than the assembler's minimum, goes to
the fab as a panel: copies of the board on one blank with rails, tabs and fiducials. The
panel is built from the board by KiKit, checked against the board by its own DRC and by a
diff of the Gerbers, and never edited by hand. Adapted from Wiren Board's `wb-panelize`
(MIT, read 2026-11-12); their EAGLE half and their fab's numbers are left out. Numbers
below are JLCPCB's (jlcpcb.com/blog/v-cut-panelization-standards, read 2026-11-12); the
mouse-bite page and the assembly page are read at the order, with the date.

## Rules

- **A sample first.** The previous revision's panel — its KiKit config `<board>.json` and
  the tab annotations in the board — gives the layout, rails, tabs and fiducials. Without a
  sample, do not invent a layout: ask the owner the count, mirroring, where the rails and
  tabs go, whether fiducials are wanted.
- **The board is not edited for the panel.** Outline, cut-outs, copper, silk stay; the
  panel is a new file. `panel_rules.py` writes the panel's `.kicad_pro` / `.kicad_dru`
  (the old ones to `*.bak`); `gerbers.sh` refuses a non-empty output folder without
  `--force`.
- **No refill on the panel.** With `post.refillzones: false` KiKit copies the board's
  fills; a refill — `post.refillzones: true`, saving the panel in pcbnew, plotting with
  `--check-zones` — recomputes them, pushes copper 0.2 mm past the board edge at a V-cut
  with that offset (inner-layer copper on the cut edge after separation) and leaves zone
  islands («Missing connection» in DRC). A fresh KiKit panel matches the board on every
  layer by the Gerber diff; the same panel re-saved in pcbnew does not.
- **Cut-outs come from the whole Edge.Cuts**, footprints included; the Gerber diff is the
  check that none was lost.
- **Designators stay; nets are renamed** `Board_<n>-<name>`, rule areas `<name>_1`. KiKit
  1.8.1 copies the board's net classes and `.kicad_dru` rules into the panel once per copy
  under `Board_<n>-` names (`panelize.py`, `_inheritNetClasses` and
  `_inheriCustomDrcRules`: `NetClass`, `NetName`, `hasNetclass` conditions renamed), but
  leaves `intersectsArea('<name>')` as written while the panel's rule areas are `<name>_1`
  — a rule tied to a rule area matches nothing on the panel. `panel_rules.py <board> <panel>`
  replaces that with one set in the board's own names: the panel's `.kicad_pro` with the
  board's net classes, its netclass patterns and the classes the schematic assigns as
  `Board_?-` patterns; the panel's `.kicad_dru` from the board's, with `Board_?-` net names,
  `<name>*` rule areas and `NetClass` conditions as written (`?` is one character: up to ten
  copies). Run it after every rebuild (KiKit overwrites the `.kicad_pro`); the panel's DRC
  then reports in the board's class and rule names, and the N× count below is rule for
  rule.
- **File name:** `Panel <board>.kicad_pcb` beside `<board>.json` in a `panel/` folder; no
  suffix like `(kikit-cli)` — the name goes into the Gerber headers (`TF.ProjectId`), the
  job file and the `.kicad_pro`. The panel is reproduced from the config; a change is a
  change to the config, not to the panel file.
- **Layout:** think how the boards break off; tabs away from ceramic capacitors (the
  break stresses them); a mirrored half gives one stencil and simpler assembly, unless
  heavy parts on small pads would fall off during the second side; the lower-left copy
  sits at the single board's coordinates (the position file depends on it).
- **Fiducials and tooling holes are the customer's:** JLCPCB adds nothing that is not in
  the Gerbers. Three fiducials on the panel's rails, ≥ 3.85 mm from centre to the board
  edge so the SMT rails do not cover them; placed asymmetrically, so a panel turned 180°
  does not fit. A sample panel without them: add none without the owner's word.

## KiKit

```sh
kikit panelize -p panel/<board>.json <board>.kicad_pcb "panel/Panel <board>.kicad_pcb"
python3 <skill>/scripts/panel_rules.py <board>.kicad_pcb "panel/Panel <board>.kicad_pcb"
```

Config sections (`kikit panelize --help`, presets in
`kikit/resources/panelizePresets/default.json`):

| Section | Meaning |
|---|---|
| `layout` | the grid: `rows` / `cols`, `hspace` / `vspace` (0 for V-cut copies that touch; 1.6–2 mm for mouse bites — JLCPCB); `baketext: False` keeps text variables |
| `tabs: {"type": "annotation"}` | tabs where the board carries KiKit annotations — `kikit:Tab` footprints with `KIKIT: width: 3mm` on `Dwgs.User`, width and place set by the designer. `type: spacing` puts tabs wherever the pitch lands; worse |
| `cuts` | `vcuts` with `offset` (the cut line on `Cmts.User`, offset from the edge) for rectangular boards; `mousebites` (`drill`, `spacing`, `offset`, `prolong`) for any outline — the holes land in the panel's NPTH drill |
| `framing` | `railslr` / `railstb` (rails on two sides, `width`), `frame` (all around); `fillet` / `chamfer` on the rail corners |
| `post.millradius` | the router's radius: every inner corner of the panel outline is rounded to it |
| `fiducials`, `tooling` | `{"type": "3fid", "hoffset", "voffset", "coppersize": "1mm", "opening": "2mm"}` — only when the sample has them or the owner asks |
| `post.refillzones` | stays `false` (Rules) |

Checked by WB with KiKit 1.8.1 and KiCad 10.0.7: a 1×4 panel of an 8-layer board builds in
~20 s; `assert "m_choices.GetCount() > 0"` lines from KiCad 10 on stderr are noise.

JLCPCB V-cut: angle 25°, double-sided, straight lines end to end only, both panel
dimensions ≥ 70 mm (475 × 475 max with cuts both ways), not for 0.4 mm boards; copper
≥ 0.4 mm from the cut centreline (1.0 recommended, 2.0 for tall or stress-sensitive
parts); connecting edge ≥ 3 mm (5 mm at ≤ 0.8 mm thickness); where a V-cut meets a
routed slot add a 3–5 mm process edge or the router leaves a horn; mark «V-CUT» and
«CNC» areas on the outline layer. Mouse bites: 1.6–2 mm between boards, holes ~0.6 mm,
5–8 per set; economic SMT needs them. After separation a V-cut board is ±0.4 mm.

## Gerbers and drills, board and panel alike

```sh
bash <skill>/scripts/gerbers.sh <board>.kicad_pcb gerbers-single/
bash <skill>/scripts/gerbers.sh "panel/Panel <board>.kicad_pcb" gerbers-panel/ --panel [--vcuts] [--force]
```

`kicad-cli pcb export gerbers --board-plot-params` (layers and options from the board's
plot settings, with the job file) and `kicad-cli pcb export drill --excellon-separate-th`
(Excellon mm, decimal, PTH / NPTH apart). `--panel` requires holes in the NPTH drill
(kicad-cli writes the file even without one; the mouse bites must be in it); a V-cut panel
has none — `--vcuts` makes that a note. A failed export is exit 1 even over an old set with
`--force`. The panel inherits the board's plot settings, so the two sets match in
composition.

## Checks

- **DRC of the panel**, after `panel_rules.py`: `kicad-cli pcb drc --severity-all --format
  json -o drc.json "<panel>.kicad_pcb"` (~2 min for an 8-layer 1×4). Against the board's
  DRC: the same types exactly N× as many, `unconnected_items` N× as many too (0 on a routed
  board); a new type or more unconnected items than that (zone islands after a refill) is a
  panel finding.
- **Gerber diff:** `gerber_diff.py` on the two Gerber sets renders every Gerber with gerbv
  (1000 dpi = 0.0254 mm/px) in one window, replicates the board's Gerbers by copy (shift
  and 180° by gerbv's own export, mirror by flipping the image with the paired layer —
  Top↔Bottom, L_i↔L_(n+1−i),
  silk, mask), XORs with the panel: light grey agrees, red is in the replicated board and
  not in the panel, blue the reverse. Copies are found by matching the PTH drill; layers
  and copper pairs from the `*.gbrjob`; drills are compared as sets of holes; 1-px strips
  are raster noise and listed apart. Expected red / blue on a correct panel: the fill
  pull-back around tab holes, mask openings around them, fiducials, the panel's label, the
  outline. What it catches: lost cut-outs or footprints, a wrong mirror or layer pair,
  stale layers, refilled zones, fill into the tabs. The output: one `SAME` / `DIFF` line
  per layer with the red and blue areas, the drills as hole sets, and a final `RESULT`
  line; exit 1 on any `DIFF` outside the outline layer except extra NPTH holes (mouse
  bites, tooling holes), and on a script error (no gerbv, no copy transform found) — so a
  panel with fiducials or a label always exits 1, and the
  verdict is not the exit code but the reading: every red or blue spot found in the
  expected list above, nothing else. gerbv is not on the laptop: the command below builds
  `gerbdiff.Dockerfile` (gerbv, numpy, pillow) on the docker host and runs the diff there,
  the folders going in and out by `docker cp`; `rc` keeps the script's exit code. ~4 min
  for a 4-layer 204 × 125 mm board against itself, ~10 min for an 8-layer 1×4.

  ```sh
  S=<skill>/scripts
  IMG="$(COPYFILE_DISABLE=1 tar -C "$S" -cf - gerbdiff.Dockerfile gerber_diff.py | docker build -q -t gerbdiff -f gerbdiff.Dockerfile -)"
  C="$(docker create "$IMG" python3 /opt/gerber_diff.py --single single --panel panel --auto-copies -o out)"
  docker cp -q gerbers-single "$C:/work/single"; docker cp -q gerbers-panel "$C:/work/panel"
  docker start -a "$C"; rc=$?; docker cp -q "$C:/work/out" gerber-diff; docker rm -f "$C"
  ```
- Both Gerber sets come from the same kicad-cli and the same `gerbers.sh`.

## Hand-over

The panel file, its config, the Gerber sets, the DRC comparison (counts per type, board
vs panel) and the diff pictures per layer with what is red / blue and why. A red or blue
spot not in the expected list on any layer, a `DIFF` in the PTH drill, a missing NPTH
hole, a DRC type the board does not have or a count off the N× is a reason to fix the
build, never to switch a check off. The panel is «checked» after the owner has looked at
the diff pictures, not before.

## When to ask the owner

- No previous panel and no sample: the whole layout.
- The new revision's outline differs from the sample's (size, cut-outs): tabs may land
  on new parts — show the difference, ask whether to carry the frame over.
- The count per panel (price, minimum order), whether the panel gets a label.
- A mirrored part whose footprint geometry is not slot-like (a non-standard package).
