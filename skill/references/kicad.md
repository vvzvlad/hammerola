# KiCad: the owner's rules, gates and scripts

The vendor skills `konnect`, `kicad-pcb`, `kicad-schematic`, `kicad-library`, `kicad-review` and
`kicad-manufacture` stay exactly as Copperpour ships them, because `copperpour init` rewrites them.
Everything the owner added lives in this skill: this file, the references it names and
`scripts/`. Load the vendor skill for the task and read this file; where their texts disagree,
this skill wins. Paths below are relative to the skill's directory, `~/.claude/skills/hammerola/`.

The owner's board style rules are in `~/.claude/CLAUDE.md`, block «# Платы (KiCad)». Read that
block before placing, routing, editing silkscreen or reviewing a board; it is not repeated here.

## Routing

| Request | Vendor skills | This skill |
|---|---|---|
| Any KiCad file, Copperpour tool, kipy or pcbnew script | `konnect` | Channel 4 below, `references/copperpour-gaps.md` |
| Placement, routing, zones, stitching, silkscreen, mechanics, design rules | `konnect`, `kicad-pcb` | `references/layout-rules.md` |
| Schematic build or edit, power symbols, annotation, test points | `konnect`, `kicad-schematic` | `references/schematic-library.md` (Schematic) |
| Symbols, footprints, libraries, 3D models | `konnect`, `kicad-library` | `references/schematic-library.md` (Library) |
| A board an agent will bring up and test with no person at the bench (any board with a controller); test groups, fiducials and the bring-up document for the owner's robotic probe bench | `konnect`, `kicad-schematic`, `kicad-pcb` | the `probe-bench` skill: `~/.claude/skills/probe-bench/SKILL.md` |
| Review, DRC/ERC, «плата готова?», critics | `konnect`, `kicad-review` | `scripts/ready.sh`, `references/review-critics.md`, `references/lens-checklist.md`, Layout definition of done in `references/layout-rules.md` |
| Gerbers, BOM/CPL, pick-and-place, fab order, quotes | `konnect`, `kicad-manufacture` | `references/manufacture-assembly.md` |
| Publishing a schematic, a board, its 3D model or Gerbers on the hub | — | `references/boards.md` |
| A brief for a subagent | — | `references/review-critics.md` (Briefs and fixers), Agents below |

## Channel 4

**Channel 4** — only for an operation no Copperpour tool covers: kipy over the live IPC
socket, or KiCad's own pcbnew Python (LoadBoard/SaveBoard, FootprintLoad/FootprintSave)
on a file no KiCad window has open. Neither is a text edit. The one write to the file of an
open board is `scripts/put.py`: a checked copy goes in place of that file, and KiCad reads
it again over IPC. `.kicad_dru` is a plain-text rules file and may be edited as text. Name
every Channel-4 use in the hand-off.

konnect's Channel 1 therefore reads: if MCP tools are not available, **STOP** and tell the
user — never fall back to text editing. kicad-pcb rule 1 ("Never edit .kicad_pcb directly")
does not cover Channel 4. The gaps that need it, and the pcbnew/kipy pitfalls, are in
`references/copperpour-gaps.md`.

Interpreters on macOS:

- KiCad's Python with pcbnew:
  `/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3`
- kicad-cli: `/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli`

## Board readiness («плата готова?»)

Run `scripts/ready.sh <board>.kicad_pcb`. It copies the board with its `.kicad_pro` and
`.kicad_dru` to a temporary directory and runs on the copy:

1. `drc.sh` — kicad-cli DRC with zone refill; fails on any error, dangling track or via, or
   unconnected item;
2. `geocheck.py` — the script part of the track-geometry gate; fails on any finding;
3. `inv.py` — footprint inventory; fails if a fitted footprint is neither SMD nor THT;
4. `probe.py check` — the probe contract of the `probe-bench` skill
   (`~/.claude/skills/probe-bench/scripts/probe.py`), when the board carries a
   `TP_Probe_Group_3x3_P2.0mm` or `FID_Probe_D1.0mm` footprint; a board without them passes this
   step untouched.

It exits 0 only when all four pass, and never touches the project. A pass is necessary, not
sufficient: a board is "placed" or "routed" only against the Layout definition of done in
`references/layout-rules.md`, with a count or measurement for every line. The DRC part of the
track-geometry gate runs as `scripts/drc.sh <board> <rules.dru>` with the two `geo_*` rules from
that gate in `<rules.dru>`. For the detailed per-segment report run `dump.py`, then `check.py`.

## Assembly data

Before any BOM or CPL leaves the project, quotes and demos included, apply
`references/manufacture-assembly.md`. `inv.py` shows each footprint's mounting type and
exclusion flags.

## Scripts

Each script starts with a three-line header: what it does, usage, interpreter. Run them with
the interpreter they name: the hub's installer does not keep the executable bit.

| Script | Interpreter | What it does |
|---|---|---|
| `ready.sh` | bash | Readiness gate: drc.sh, geocheck.py, inv.py and probe-bench's `probe.py check` on a copy |
| `drc.sh` | bash, kicad-cli, python3 | DRC on a copy with a private KiCad config; optional extra rules file; exit 1 on errors, dangling tracks or vias, or unconnected items |
| `geocheck.py` | KiCad Python | Track-geometry gate, checks 1–5; optional JSON of findings; exit 1 on any finding |
| `inv.py` | KiCad Python | Per footprint: side, position, SMD/THT/unspec, DNP and exclusion flags, model count, reference field; silk texts |
| `dump.py` | KiCad Python | Board to JSON (pads with copper polygons, tracks, vias, zones, edges, F/B silk) for check.py |
| `check.py` | python3 with shapely | Routing report: pad exits, track ends, angles and lengths, jogs, vias under silk or in courtyards, crossings, loops, detours; exit 1 on findings |
| `stepA.py` | KiCad Python | Sets SMD/THT from pad types, saves to a new file |
| `step.sh` | bash | One via-stitching iteration (add vias, DRC, dump, measure); needs helper scripts named in its header |
| `kc.py` | python3 | MCP stdio client for copperpour: a fresh server per run |
| `bq.py` | KiCad Python | Board queries on the saved file: what is near a point, clearance between two items, legal via sites, a track corridor, legal designator spots, a footprint's pads and what is attached to each (`pads REF`), a net's pads, tracks, vias and fill pieces (`net NAME`), zones with their fill pieces, areas and tying vias, or only the piece at a point (`zones --at X Y`), a placement `score` (HPWL and airwire crossings over signal nets, crossings optionally within a box; on a routed board also the bare pads, netted pads with nothing attached, per footprint); applies the `.kicad_dru` beside the board as KiCad's DRC does; `-` reads one query per line from stdin |
| `autoroute.sh` | bash, docker | Routes a copy of the saved board in docker: existing tracks/vias locked for the run, fastroute draft, optional Freerouting finish, DRC with refill, `geocheck.py`, unrouted list; prints the routed copy's path. Uses `autoroute.Dockerfile`, `autoroute_run.sh` and `autoroute_board.py` beside it |
| `findings.py` | python3 | A `drc.json` and `geocheck.py` findings filtered by type, net, ref, box or point, or counted by type, ref or net (`--by ref` on an autoroute run's `run/drc.json`: unrouted connections per footprint) |
| `edit.py` | KiCad Python | `apply`: edits on a copy of the saved board for the checks (delete tracks/vias by uuid, add a track polyline or a through via, flip, rotate or move a footprint, set a pad's net, copy a footprint under a new reference for a trial placement); refills zones and puts the project files beside the copy |
| `put.py` | python3 with kicad-python 0.8.0 | Puts a checked copy (an `edit.py` or `autoroute.sh` output) in place of the board KiCad has open, and KiCad reads it again from disk; refuses a copy with a footprint the open board lacks |
| `delta.py` | python3 | After a batch of edits: this run's `drc.json` and `geocheck.py` findings against the previous run in a state file — what appeared, what went away (type, items, nets and refs, coordinates), the stop-rule count and the stop line |
| `boardgeo.py` | KiCad Python | Geometry core of `bq.py` and `silk.py` (imported, not run) |
| `view.py` | KiCad Python, rsvg-convert | A region of the saved board (`X1 Y1 X2 Y2`, `ref REF` or `full`) as KiCad's own plot, PNG at most `--px` (1000) on the long side, with an mm grid in board coordinates, reference designators (hidden ones too), net names and numbered markers from a `drc.json` or `bq.py --json`; prints what is in the region |
| `silk.py` | KiCad Python | Designator placement: `plan` finds a legal spot for every reference and lists the unplaced ones with the reason; `apply` writes the plan to a closed board, or `--live` to the open one over kipy |

## Agents

Use these instead of the vendor agents; their `skills:` field preloads this skill:

- `kicad-pcb-layout` — placement, routing, silkscreen, zones (`konnect`, `kicad-pcb`). It runs at
  effort `medium`; spawn it with `effort: "xhigh"` for a brief that is a design decision
  (a floorplan, a choice between placements), not for an edit–check loop.
- `kicad-pcb-critic` — design and layout review, fork of `kicad-design-review-agent`.
- `kicad-schematic-build` — schematic builds, fork of `kicad-schematic-build-agent`.

`kicad-pcb-layout` and `kicad-pcb-critic` have Bash and run the scripts themselves;
`kicad-schematic-build` has Copperpour tools and Read only.

A layout agent also needs the Monitor tool: an `autoroute.sh` run outlasts a shell call, so it
runs in the background, and without Monitor the agent can only poll for its end. Whoever
defines the agent on an installation lists Monitor beside Bash.

## References

- `references/layout-rules.md` — definition of done, mechanics, placement, silkscreen, routing,
  track-geometry gate, autorouting, stitching, DRC errors, safety distances, rules 11–12.
- `references/copperpour-gaps.md` — Copperpour v0.15 / KiCad 10.0.6 gaps and their workarounds.
- `references/schematic-library.md` — power symbols, test points, annotation gate, production
  footprints, symbol fields, courtyards, 3D models on placed boards.
- `references/review-critics.md` — severity changes, layout critics, briefs and fixers.
- `references/manufacture-assembly.md` — part codes, stock, exclusions, BOM/CPL parity.
- `references/lens-checklist.md` — review lenses (TG, GR, DC, MI, SK, DFM) with sources.
- `references/boards.md` — publishing a KiCad design and Gerbers on the hub.
