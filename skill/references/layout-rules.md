# Layout rules

The owner's rules for placement, routing, pours, silkscreen and layout acceptance. They extend
the vendor `kicad-pcb` skill and win where the two disagree.

## Layout definition of done

KiCad DRC with 0 errors / 0 dangling / 0 unconnected is necessary, not sufficient. It does not see
mating boards or the enclosure, stitching, distances the spec gives in words, silk
content, or copper on other layers (clearance is checked per layer). Call a board
"placed" or "routed" only when the hand-off reports, for each line below, a count or
measurement taken on the saved board. An item not done is listed as not done.

Placed:
- Mechanics (see Mechanical interfaces): mating-board contact band, enclosure features
  and plug envelopes are keep-outs with no part inside; every mating pad faces a pad of
  the same net; every pin-1/polarity mark sits at pad 1.
- Decoupling, every "next to / close / tight" in the spec and every pair / satellite / chain
  rule of the brief (Placement): distance in mm against its limit, met or not.
- Safety distances measured >= the spec value (plus any margin the brief states); a pair
  below it by any amount fails. Where the spec requires a distance across layers, check
  it in plan view by script.
- Silkscreen: every designator visible next to its part or in a group label (mounting
  holes, fiducials, test pads, logos excepted); connector titles and pin labels; every
  marking the spec requires; board name and revision.

Routed, in addition:
- Track geometry — acceptance gate: passed.
- Stitching and plane integrity: reported per pour; every outer-layer pour piece is tied
  by >= 2 vias/PTH pads of its net.
- DRC errors fixed, none waived as "expected" (copper-to-edge included); no designator
  or label text in any silk_overlap / silk_over_copper / silk_edge_clearance finding.
- A resolvable 3D model on every assembled part (schematic-library.md → Models on placed
  boards); if the board mates with another board or an enclosure, a 3D check of the
  assembly reports no intersections.

Every placement/routing brief points to this section. "Do not add anything this brief
does not name" narrows scope; it never removes an item from this list.

## Looking at the board

- Numbers first: positions, distances, free spots and fits come from `scripts/bq.py`,
  findings from `drc.sh` and `geocheck.py`. A question about the board or a report (the pads
  of a part and what reaches each, a net's copper, the fill piece at a point, the findings of
  one part or type) is a `bq.py` or `scripts/findings.py` query, not a one-off script.
- For what only the eye judges (crowding, alignment, silk legibility, the surroundings of a
  finding) render one region with `scripts/view.py` (`ref REF` or `X1 Y1 X2 Y2`; `--drc
  drc.json` or `--marks` with a `bq.py --json` result numbers the findings on the picture)
  and read the listing it prints beside the PNG.
- Render the whole board (`view.py <board> full`) once, at the end of the job.
- view.py, bq.py and `silk.py plan` read the saved file: save before you run them.

## Mechanical interfaces (before placement)

A mechanical conflict found after routing costs a re-layout. Model the mechanics
before placing parts and check them in 3D like DRC.

- Before placement, draw each mechanical neighbour as a rule area that keeps out
  footprints (KiCad DRC then flags any courtyard inside it):
  - a mating or perpendicular board: the whole worst-case strip its edge can rest
    on, not just its slot. Length = edge length + end play + outline tolerance;
    width = slot width + outline tolerance (JLCPCB regular routing ±0.2 mm, board
    thickness ±10%, as of 2026-10-11). Beside it, record the height limit under
    that board's own parts that overhang this one;
  - enclosure ribs, dividers, bosses, latches and cover ribs, with heights; tag
    each dimension measured / scaled from a drawing / estimated;
  - the module antenna keep-out from its datasheet; keep metal-shell parts and
    connectors out of the antenna clearance as well.
- For every user-facing connector, model the largest mating plug as a box on the
  insertion axis (USB-C overmold max 12.85 x 7.0 mm, USB Type-C spec R2.4
  Fig. 3-3). Require at least 0.5 mm, and more than the enclosure dimension
  uncertainty, to every enclosure feature in the state in which the user plugs in
  (e.g. cover removed). Check button actuators and LED light paths the same way.
- Where the user can see or reach the board through enclosure openings: no test
  pads or their labels, and no exposed hazardous-voltage copper other than the
  terminals themselves.
- After placement (before routing), and again for kicad-manufacture's
  3D/enclosure record: export STEP of every board (`kicad-cli pcb export step
  --include-tracks --include-pads --include-zones`; every part needs a 3D model or a
  datasheet-sized box), assemble with the enclosure, and report body intersections,
  plug-envelope clearances, height-limit violations and copper-to-copper distance
  between boards against the required mains spacing. Run it unasked, as a gate
  like DRC.
- If a part forces a notch, cut-out or board offset, first look for a smaller part
  in stock (e.g. an HC-49S crystal replaced by a 3225 active oscillator, a schematic
  change). Remove a notch or offset once its reason is gone.
- For a third-party board or module that this board mates with, take dimensions
  from its published STEP/STL/drawings or photos; ask the user only for what
  cannot be derived.
- Tab-in-slot joint (one board standing in a routed slot of another): size it for the
  fab's worst case, not nominal. T = routed-edge / NPTH-slot tolerance (JLCPCB regular:
  ±0.2 mm); t_max, t_min = board thickness limits (JLCPCB: ±10 % for t >= 1.0 mm,
  ±0.1 mm below). Tight case: slot (L-T) x (w-T), tab (W+T) x t_max. Require
  w-T > t_max, and check the tab's cross-section corners against the round slot ends,
  not only the straight walls: with r = (w-T)/2 and end-arc centres c = (L-w)/2 from the
  slot centre, if (W+T)/2 > c then sqrt(((W+T)/2 - c)^2 + (t_max/2)^2) < r. If it fails,
  lengthen the slot or narrow the tab; chamfering the tab corners in Edge.Cuts does not
  help (the binding corners are where the tab's routed sides meet its faces).
- Soldered joint: end play along the slot is c + sqrt(r^2 - (t/2)^2) - W/2. In the loose
  case (r = (w+T)/2, tab W-T, t_min) it must stay below the gap between adjacent joint
  pads. Recompute fit and play after any change to slot, tab or pads, and update every
  place that states them.
- Mating footprints on two boards: check by script in the assembled frame that every pad
  faces a pad of the same net on the other board (pad numbers may differ). After any
  mirror, renumber or flip of either footprint, re-run it and check that every
  pin-1/polarity mark (silk, fab) is nearer pad 1 than any other pad.

## Placement

- Decoupling caps (ceramic, one per supply pin), same layer as the pin: the copper between
  the pin and the plane adds at most three times the cap's own ESL, so the mounted
  resonance stays >= 0.5 x SRF — f_m = 1/(2π√((ESL + L_mount)·C)) (Xilinx UG483 v1.14
  p. 33–34); the value cancels, only the case counts. Budget: L'·l + L_via <= 3·ESL(case),
  where l is the routed copper from the pin pad edge to the cap pad edge plus from the
  cap's GND pad edge to its via, L_via is that GND via down to the nearest GND plane, and
  the supply side has no via. ESL (TDK Ceramic Capacitor Product Guide A14, p. 17):
  0402 0.30, 0603 0.40, 0805 0.50, 1206 0.60 nH. L' of a 0.3 mm track: 0.357 nH/mm over
  0.21 mm prepreg (JLC04161H-7628), 0.23 over 0.10 mm (3313), 0.74 on a 2-layer 1.6 mm
  board (Z0/c from the microstrip formula; Bogatin and Johnson quote 0.33–0.39 nH/mm for
  typical traces). L_via: 0.02 nH from the top to L2 of the 4-layer stack, 0.74 nH through
  1.6 mm (Grover, Xilinx XAPP623 App. B eq. 5; Johnson & Graham's formula gives 1.30 and
  leaves 0402/0603 no room on 2 layers). l_max for a 0.3 mm track, Grover's via: 4-layer
  7628 — 0402 2.5, 0603 3.3, 0805 4.1, 1206 5.0 mm; 2-layer with a through via — 0402 0.2,
  0603 0.6, 0805 1.0, 1206 1.4 mm. Measure l as `bq.py path U1.<pin> C1.<pad>` plus
  `bq.py path C1.<gnd pad> via` (routed length and via count along the net's copper, the
  second from the cap's GND pad to its nearest via) after every re-placement or re-route of
  the group;
  before routing, the straight pad-edge gap is the lower bound of l. Smallest value nearest
  the pin; the supply track reaches the cap pad before the pin; the cap's GND pad has its
  own via at the pad. Bulk caps are exempt.
- Where the datasheet says "without vias" (e.g. an isolator's VCC2/GND2 bypass) or gives a
  layout figure (a switcher's input cap across VIN/GND), keep both sides on the component
  layer with no via and follow the figure.
- Turn every "next to / close / flush" in the spec into a mm limit in the brief (e.g. a
  cold-junction sensor: its distance to the terminal bodies, on the same pour) and measure
  it after placement.
- Write the rest of the placement intent as rules in the brief before the first move, one
  line each, pads named, in one of three forms: **pair** — `A.pad B.pad <= d mm` (a switch
  node and its inductor, a TVS and its connector pin); **satellite** — `C1 C2 C3 within r mm
  of U1.pad` (a regulator's caps as one island at its input); **chain** — `J1.pin > D1 > R1 >
  U1.pin, each link <= d mm, in that order` (a protected signal from the connector to the
  MCU). After every placement batch measure each rule pad to pad (`bq.py path A.PAD B.PAD`
  — the straight pad-edge gap for any two pads, same net or not, and the routed length once
  the net has tracks; `bq.py clearance` skips pads of one net, and the named pairs almost
  always share one; one query per line through `bq.py <board> -`; a chain is its links in
  order, each part farther from the connector than the last) and report it met, not met with
  the number, or not measured with the reason. Violated: move the named part towards its
  anchor, never the anchor. (HeyPCB's `check_placement` measures its author's rules in these
  three forms, read 2026-11-12.)
- A crystal or resonator sits at its IC's clock pins with nothing between them but its load
  capacitors: crystal pad edge to clock pin pad edge <= 5 mm (`bq.py path Y1.<pad> U1.<pad>`),
  and no other part's courtyard nearer to those pins than the crystal (`bq.py near` at the
  pin). TI SWRA495 §4 (rev. 2025-04): "as close as possible to the device", no number; 5 mm
  is the agent's default, the brief may tighten it. Violated: move the crystal and its caps,
  not the IC. Clock tracks, vias and foreign copper under the crystal are DC-3 in
  `lens-checklist.md`, checked after routing.
- Every connector a cable or another board plugs into sits at the board edge, opening
  outwards. `bq.py edge J1` gives the courtyard against the outline (inside / crossing /
  outside), the distance to the nearest edge and the direction to it; the distance is <=
  the figure the brief sets (0 for a footprint made to overhang, e.g. USB-C), and that
  direction is the connector's insertion axis — read the axis off `view.py ref J1` and the
  3D model, the query does not know it. Violated: move it to the edge and rotate it; a
  connector that has to stay inside gets its reason in the hand-off.
- No courtyard outside the outline or across it, except a connector made to overhang
  (`bq.py edge REF` for every reference `inv.py` lists; Copperpour's `score_placement`
  proves containment only for a rectangular outline), and no two courtyards overlapping
  (`courtyards_overlap` in `drc.sh`). Violated: move the part; never shrink a courtyard.
- Like parts in a row — the caps along an IC's side, a resistor array, a connector bank —
  share one line and one pitch: their centres (`inv.py`) agree in one coordinate and step
  by one value in the other. Violated: `align_components`, then re-measure.
- A finding is fixed by moving the part it names; re-placing a cell that already passes
  its rules is not a fix. Lock a cell that passes (the footprint's Locked flag in KiCad)
  and name it in the held set of every later brief, so no batch moves it again.
- Placement is not done until every dense IC (pitch <= 0.65 mm or >= 12 signal pins) has a
  proven escape. "Courtyards clear + DRC clean" is not routability. Per side: copper gap to
  the next part >= n x (track + clearance) + clearance for the n pins leaving on that layer,
  plus a legal via site for every other signal pin; or route its fan-out on a copy at the
  board's rules. A pin with no exit means re-place now, not after routing.
- Turn each passive tied to an IC pin so its IC-net pad faces that pin, centred on the
  pin's exit axis (same grid as the IC pad), so the link can be one straight segment.
- Count signal-net airwire crossings in each functional cell (plane nets excluded; `bq.py
  score X1 Y1 X2 Y2` lists them for the cell's box, and `score` compares candidate placements) and remove every one that a rotation, a mirror or a free pin re-assignment can remove.
- A header or pad row whose signals all go to one IC sits next to it: its airwires must
  not cross another cell. Re-order free-to-assign connector pins (headers, board-to-board)
  to the IC's escape order and write the new pinout back to the schematic and docs.
- Repeated channels: place and route one complete cell first (every part the spec puts in
  it, its labels, room for one track to the neighbouring cell), then copy it at the channel
  pitch with identical relative positions. Before copying, check that every copy fits
  unchanged, mounting-hole and edge keep-outs included; if one does not, move the obstacle
  or report the conflict with numbers.
- Take every distance, free spot, via site and fit from `scripts/bq.py`, not from
  reasoning, and push each group to the live board as soon as it passes its checks.
- When placement blocks routing, move the blocking parts (anything outside the held set)
  instead of delivering unconnected nets. A routing brief must not cap part moves
  (e.g. "<= 1 mm").
- Do not go from placement straight into routing. Finish placement in critic → fix rounds:
  a fresh critic reviews the placement and estimates where the tracks will go, a fixer moves
  the parts, and routing starts only when the critic has no MAJOR left on placement. The
  owner: «ну и хз, наверное можно не сразу бросаться в разводку, а сначала циклом с критиком
  порасставлять элементы, поприкидывать как дорожки пойдут». The estimate can be airwire
  crossings (`bq.py score`) and a fastroute draft on a copy (`scripts/autoroute.sh
  --diagnose`), which shows where tracks jam and which connections it could not route
  (agent's suggestion).

## Silkscreen (part of placement, not a post-pass)

- Place designators with `scripts/silk.py plan`, then `apply`; it follows the rules below.
  Make group labels or callouts only for the references it reports unplaced.
- Plan labels together with the parts: after each placement batch, before routing, give
  every part a visible label spot. A re-layout brief carries the label plan, and the
  re-layout keeps existing group and function labels. Copperpour (v0.15) has no tool that
  moves footprint fields: set reference position, angle, size, stroke and visibility with
  kipy over IPC (or pcbnew on a closed board).
- Label spot: outside every courtyard and 3D body, the part's own included (silk under a
  fitted part is invisible); >= 0.15 mm from pads and mask openings (JLCPCB pad-to-silk);
  off vias; inside the board edge. Size it on ink: at 1.0 mm text / 0.15 mm stroke about
  0.9 mm per character x 1.15 mm. kipy `get_text_as_shapes` returns the ink;
  `get_text_extents` and pcbnew `GetBoundingBox` are padded (~1.6-1.7 mm tall). Keep vias
  out of reserved spots while routing.
- Text: 1.0 mm high, stroke set explicitly to 0.15 mm (stroke 0 renders size/8 = 0.125 mm,
  below JLCPCB's 0.15 mm minimum line width). Angle 0 or 90 degrees absolute (KiCad stores
  and reports footprint text angles as absolute, not relative to the footprint). Front
  text unmirrored, back text mirrored.
- Two texts on one line: >= 0.8 mm apart along the reading direction, or they read as one
  string (glyph gap inside a word is ~0.2 mm, a space ~1.0 mm).
- No room beside a part: one group label next to the row (R411-R414). Never hide a
  designator just to clear DRC; list every designator left hidden (count + references)
  in the report.
- A designator goes on the silk layer of its own part's side. A label on the opposite
  side, behind the part, counts as hidden: nobody assembling or probing the board sees
  it there. Where no spot exists, make one: a group label, or move vias and parts.
- A dense cluster with no room for a group label: a callout box. A silk frame around the
  cluster, a second frame in the nearest free area listing its designators one per line
  in the order the parts sit, and one straight silk leader joining the two frames. One box
  per cluster; leaders do not cross each other or run over pads.
- No designator on mechanical items: mounting holes, fiducials, logos.
- Every external connector: a title visible with the part fitted, a short function name per
  contact (what gets wired there, not a description), channel numbers on repeated
  channels, a distinct mark on a channel that differs, pin-1/polarity. Every board: name
  and revision, plus every marking the spec requires.
- A required label that does not fit: shorten or merge ("+ OUT3 -"); if still impossible,
  report it. Never drop it silently.
- Gate: kicad-cli pcb drc has no silk_overlap / silk_over_copper / silk_edge_clearance item
  that involves a text (graphic-only ones, e.g. outlines of abutting terminal blocks, are
  listed with their cause), and `kicad-cli pcb render` with 3D models (top view plus
  close-ups of dense areas) shows every label.

## Route order and pairs

- Route order: fan-out first (every dense-IC pin and every plane pad gets its stub and
  via), then constrained nets (isolation, differential and sensor pairs, sensitive analog),
  then power, then the rest.
- Route each pair (USB D+/D-, CAN H/L, a sensor's +/- leads) together: constant spacing
  through every bend, and its series/filter parts mirrored about the pair axis.

## Track geometry — acceptance gate

Run after routing and after every later edit that moves copper, on the saved board.
Report the count per check in the hand-off. Pass = 0 findings, or each remaining
finding listed with its location and the constraint that blocks the fix (e.g. the
straight path would break a clearance). "Same count as before" is not a pass, and
checking only that track ends sit on pad centres is not this gate.

KiCad DRC part. Copy the .kicad_pcb and .kicad_pro to scratch, add to the copy's
.kicad_dru (the project's rules, or `(version 1)` if there are none):

    (rule "geo_bend"   (constraint track_angle (min 134)))
    (rule "geo_seglen" (constraint track_segment_length (min 0.1mm)))

and run `kicad-cli pcb drc --format json --severity-all` on the copy.
- `track_angle` is the angle between two connected segments: 135 for a 45° bend,
  90 for a right-angle corner, 0 for same-net segments lying on each other. Joints
  on a pad are skipped; joints at vias and T-junctions are checked. Each joint is
  reported twice. Use 134, not 135: some exact 45° bends compute as 134.99.
- Give the angle as a bare number. With `(min 134deg)` kicad-cli 10.0.6 silently
  ignores the whole rules file; prove the file loaded once with a rule that must
  fire, e.g. `(rule "probe" (constraint track_width (min 50mm)))`.
- Replace each right-angle corner with a 45° chamfer wherever one fits clearance.
  `route_pad_to_pad` emits raw L-bends, so its output always needs this pass.

Script part (read the saved file with pcbnew; DRC has no check for these):
1. Segment direction not a multiple of 45° (tolerance 0.5°).
2. Track end not on a pad centre, a via centre or a same-net track (0.005 mm).
3. Pad exit: from a rectangular, rounded-rectangle or oval pad the first segment
   runs along a pad axis (0°/90° to the pad), never diagonally out through the
   pad corner; round pads and vias may exit at any multiple of 45°. The first
   bend lies at least half the track width outside the pad copper.
4. Jog: two equal opposite bends joined by a segment shorter than 1.5 mm.
5. Same-net tracks crossing or overlapping; a loop in a net's track graph; a pad
   wired to a via although another same-net via is at least 1 mm closer in a
   straight line than the wired path.

Fix by moving vias and parts first; add bends only where nothing can move.

## Autorouting

- Never write a general-purpose router (grid/maze/A*). Bulk routing is `scripts/autoroute.sh
  <saved board>`; nets whose look matters are scripted as explicit waypoints.
- autoroute.sh routes a copy in docker and never touches the project: it locks every existing
  track/via, exports the DSN with fastroute's own KiCad exporter (netclass widths, the board's
  minimum width and the `.kicad_dru` rules it can translate; each rule it cannot is a `WARN …
  NOT applied` line), draws a fastroute draft (`--draft-time`, 300 s), optionally finishes with
  Freerouting 2.5.0 (`--finish freerouting`), refills zones, runs DRC and `geocheck.py`, and
  lists the unrouted connections. `--diagnose` adds fastroute's congestion/blocked class per
  unrouted connection and costs minutes on a dense board. Put the routed copy (the path after
  `routed copy:`; the locks set for the run are gone from it) in place of the open board with
  `put.py`, then route the rest by hand with `bq.py`.
- A run lasts longer than a shell call's default timeout (Dionis: 5.5 min with no finish; a
  finish adds up to `--finish-time`): run it in the background, or with a timeout of at least
  `--draft-time` + `--finish-time` + 2 minutes.
- A copper layer typed Power plane with a zone on it stays a plane for the router, a split
  power layer included: no new track of another net goes on it, and the summary names these
  layers. Type every plane layer so before the run; with the default export a Power-plane
  layer without a zone is routed as signal. fastroute may join a via just outside a plane to
  it with a short stub of the plane's net.
- To compare placements, route each at the default `--draft-time` without `--diagnose`, and run
  `--diagnose` once, on the placement you keep. On the probe-bench head board (five placements,
  plane layers kept) 300 s and 450 s ranked them as 600 s did except two placements 5 parts
  apart, and 120 s put the best one third. One placement gave 122 and 121 unrouted on two runs:
  a difference of a few connections is a tie.
- The defaults come from the owner's boards with all routing removed: the plugin export left 0
  connections unrouted on Ukuetis base against 36 with KiCad's plain DSN export (it hands zones
  over as solid planes); the minimum-width flags cut added DRC errors from 225 to 33; no finish,
  because neither Freerouting nor a fastroute pass improved both boards (Dionis: Freerouting
  2.5.0 took 183 to 140 unrouted and added 49 errors, mostly copper to board edge).
- Check every rule named as NOT applied in the DRC result: the router did not see it.
- Freerouting by hand, when autoroute.sh cannot run (2.4.x needs Java 25+; macOS
  `/usr/bin/java` may be a Java 8 stub):
  - Copperpour `export_specctra_dsn` refuses boards outside its profile (v0.15: 2 copper
    layers, front-side parts, circle/rect/unchamfered roundrect pads, a straight-line outline,
    no tracks/vias/zones, no .kicad_dru rules).
    Otherwise use KiCad's bundled Python on a copy of the saved board with its .kicad_pro
    beside it (without it the DSN has only the default netclass): lock every existing
    track/via → `pcbnew.ExportSpecctraDSN` → `java -jar freerouting.jar
    --gui.enabled=false -da --router.fanout.enabled=false -de in.dsn -do out.ses -mp N` →
    `pcbnew.ImportSpecctraSES` (it deletes and recreates every unlocked track/via) → unlock
    what was locked for the run and delete the keep-outs added for the export → `put.py` the
    copy.
  - The DSN carries netclass widths/clearances, zones and rule areas, not .kicad_dru rules.
    On the copy, add a rule-area keep-out for every .kicad_dru constraint (hole keep-outs,
    slot/edge clearances, isolation bands) before export.
  - A layer that must stay a plane: set its type to Power plane (Board Setup, or
    `BOARD.SetLayerType(layer, pcbnew.LT_POWER)` on the copy); Freerouting routes nothing on
    it. Per-layer costs (a "mostly plane" layer) had no effect in 2.4.1 headless (DSN
    autoroute_settings, `-dr .rules`): route such a board by script.
- If the per-pass unrouted count in the log sets no new low for 2 passes while above 0,
  stop and fix placement; more passes or reruns on the same placement do not converge.
- Imported routing is a draft: it must pass the track-geometry gate and DRC like any other.
- Routing a net by hand, rerouting one, or making room for one: the MCP server `pns`
  (`scripts/pns_mcp.py`), KiCad 10.0.7's interactive router on a copy of the saved board in
  docker. It is registered once per machine with
  `claude mcp add --scope user pns -- python3 ~/.claude/skills/hammerola/scripts/pns_mcp.py`;
  the first `open_board` builds its image on the docker host (about half an hour), and a
  changed `pns_bridge.py` rebuilds in under a minute.
  - Order: save the board in KiCad → `open_board` on the saved `.kicad_pcb` → `delete_net_routing`
    / `delete`, `start_route` on a pad, track end or via of the net → `line_to` (waypoints, as
    clicks) or `finish` → `drc` → `save` → `scripts/drc.sh` on the saved `.kicad_pcb` →
    `put.py` it. `checkpoint` and `restore` work between routes only.
  - A last waypoint on a pad, track or via of the net on the route's layer commits the route. `via_at_end` puts a
    via at the last waypoint: on the net's copper on any layer it ends the route, elsewhere the
    route goes on from it on the other outer layer (F.Cu↔B.Cu). The router does not see zones:
    a via into a plane ends the route with `via_at_end` and `end` in the same call (KiCad's End
    key: commit at the last waypoint whatever is under it).
  - `push` shoves other nets' tracks and vias and reports what it moved; `walk` goes around
    them; `drag` always pushes.
  - Track width, via size and clearance come from the net classes and the board's `.kicad_dru`,
    as in KiCad: routing, `push` and `drag` keep the custom rules' clearances. Zones are neither
    refilled nor obstacles: after copper moves, `drc` reports clearance errors to the old fill,
    and `drc.sh` (which refills) is the check. The engine's `drc` has no library, silkscreen or
    courtyard checks.
  - A differential pair: `start_route` with `pair` on a pad, via or free track end of either
    net; KiCad finds the partner by the N/P or +/- name suffix and takes width and gap from the
    net class diff pair settings or a `diff_pair_gap` rule. Waypoints are the pair's centre line;
    a step bends the pair once, by 45°, and a waypoint as far to the side as ahead is not
    reached: turn a corner in two steps. A last waypoint on a pad of either net fits the pair
    onto that pad and its partner and ends the route. KiCad writes each fixed step of a pair to the board at once: `undo_segment` is
    refused, and `cancel_route` keeps the fixed steps (remove them with `delete`).
  - `tune` meanders a routed track to a length (`single`), its pair to a length (`pair`) or its
    pair to a skew (`skew`: this line minus its partner), with the board's meander settings,
    anywhere on the line between its pads, vias or junctions (clear of the pads and vias, and for
    a pair where both lines run). The result is committed whatever the status; `too short` means
    the meanders that fit there fall short of the target.
  - Segments follow KiCad's 45° posture: a waypoint off a 0/45/90° line from the previous one
    becomes a straight piece plus a 45° piece, and a near-miss leaves a stub of a few
    micrometres that the track-geometry gate flags. Compute waypoints on those lines.
  - `finish` does not change layer: when the nearest unconnected anchor is on another layer it
    stops there and says so; place the via with `line_to` and `via_at_end`.

## Stitching and plane integrity

A board with pours is not routed until these checks are measured on the saved board.

- Tie every pour on an outer or signal layer to its reference plane with vias of its own
  net: <= 4 mm apart along the board edge, <= 10 mm along the rest of the drawn zone
  outline, and inside so that no fill point is farther than 7 mm from such a via (a 10 mm
  grid), plus one at every extremity or neck of an irregular pour (ADI AN-0971: fill ties
  every 10 mm, vias at the extreme edges, a 4 mm via fence along the board edge). No vias
  in isolation or creepage gaps, antenna keep-outs or a deliberate star-ground area.
- Module GND pads beside a PCB antenna get vias along the pad row (Espressif asks for
  "dense ground vias" there without a number; e.g. one behind every second pad). EPAD vias
  follow the module's land pattern.
- Draw plane layers and spec-required pours (isothermal area, heatsink copper, plane
  capacitor) before routing, and route the nets that would cut them on another layer. On a
  2-layer board one layer is the GND plane: buses run on the other layer, and the plane
  layer carries only short crossings. A rail along the plane layer, or a bus stacked on
  both layers, leaves no continuous fill.
- After every refill, count fill pieces per zone and layer (bundled pcbnew on the saved
  file: `zone.GetFilledPolysList(layer).OutlineCount()`). It is a defect when a plane or
  spec-required pour is in more than one piece, a piece is tied by fewer than 2 vias/PTH
  pads of its net (TI SZZA009: a fill tied at one point is only a shield), or a required
  copper area is below its target. Fix it by moving the cutting track, adding vias or
  removing the sliver.
- Report per pour: vias added, largest gap along the outline, largest via-free circle
  inside, piece count and ties per piece.
- Fast nets (USB D+/D-, clocks) stay on one layer over unbroken GND. If a pair must change
  layer, both lines change together, with a pair of GND return vias at the transition
  (Espressif HDG; TI SPRAAR7: within 200 mil / 5 mm, closer is better).

## DRC errors: fix or prove, never "expected"

- Never call a DRC error "expected" or "by design", in a report or in a brief to another
  agent. Fix it, or close it with evidence:
  - Error inside a footprint: cite the manufacturer's land-pattern drawing (URL, page,
    date) that produces the geometry, and the fab minimum it still meets. JLCPCB
    capabilities page, 2026-10: NPTH to track 0.2 mm; PTH annular ring 0.18 mm on
    2-layer 1 oz, 0.15 mm on multilayer 1 oz; mask web 0.10 mm at 1 oz (0.13 mm on
    black/white mask). Only then add a `.kicad_dru` exception scoped with
    `memberOfFootprint(...)`, never below the fab minimum.
  - If the drawing itself breaks the fab minimum, replace the part with a stocked one
    whose drawing passes. If none passes, report the shortfall with its numbers as an
    open item.
- Count the findings after every batch of edits (DRC errors, dangling, unconnected, and the
  geometry-gate findings): `drc.sh`, `geocheck.py` with its JSON, then `scripts/delta.py`, which
  prints what changed since the last batch and the count. If the count sets no new low for 3 batches, stop editing and hand
  back the open list with what blocks each item, usually placement: on the same placement
  more edit–check cycles do not converge (OmniRouting, arXiv 2608.04434: GPT-5-mini went
  from 18.4 to 23.7 steps and from 9.9 % to 6.8 % of nets routed).
- A batch worked out on a copy goes through `scripts/edit.py apply <saved board> <copy> ops.json`,
  which writes the ops to the copy for the checks above. A copy that passes them goes in place
  of the open board with `scripts/put.py <copy>`: it overwrites the board's file and KiCad
  reads it again. Edits made in the open KiCad and not saved are lost, so `save_project` before
  taking the copy when the open board was edited. `put.py` refuses a copy with an `fp` trial
  footprint: footprints come from the schematic.
  - `apply` refuses a `pad` op on a pad with copper attached, and a track or via that KiCad
    would move to another net. Copper drawn between pads of two nets is a short that only
    `drc.sh` on the copy finds. A pad net set by a `pad` op reaches the board with the copy
    and goes back at the next update from the schematic: change a pad's net in the schematic.
- A `.kicad_dru` rule overrides the Board Setup minimum, whatever the manual says
  (KiCad 10.0.6: clearance, edge_clearance and hole_clearance rules set below 0.5 mm
  board minimums raised no error). DRC does not catch an exception written below the
  fab minimum.
- Keep copper >= 0.3 mm from routed board edges, internal slots and board-to-board tab
  tips (JLCPCB minimum 0.2 mm; 0.4 mm on V-cut edges), unless castellated holes, edge
  plating or gold fingers are ordered.

## Safety distances across layers

- DRC `clearance` compares copper on the same layer only (KiCad 10.0.6: L on F.Cu
  directly over N on B.Cu under an 8 mm rule raised no error). When the spec applies a
  distance across layers, measure plan-view distances between isolation groups over
  all copper layers (pads, tracks, vias, plated barrels, zone fills) after each routing
  pass and before reporting done: `scripts/creep.py` on a `dump.py` JSON gives, per layer
  and in plan view, the air gap and the surface path around the board's cut-outs between
  two net classes or nets, and exits non-zero on a pair below the limit. Whether two groups may overlap through the board core
  is the spec's decision; ask the owner if the spec is silent.
- Place parts with >= 0.5 mm spare over each required distance so routing has room.
  Build keep-out and zone outlines at required + 0.05 mm: polygon approximation and
  clean-up operations under-shoot by a few hundredths of a millimetre.
- A measured pair below the requirement by any amount blocks completion; it is not a
  deviation to report.

## Rules

These replace kicad-pcb rules 1, 5 and 10 and add rules 11 and 12.

1. **Never edit .kicad_pcb directly** — all changes go through MCP tools (Channel 4 in
   `references/kicad.md`, `scripts/put.py` included, is not a direct edit)
5. **Check DRC before finishing** — run `run_drc()` and resolve all errors; DRC is
   necessary, not sufficient: finish against "Layout definition of done"
10. **Signal-layer pours last** — plane layers and spec-required pours are declared before
    routing; signal-layer fills and their stitching come after routing
11. **Compute geometry in scripts.** Coordinates, rotations, pad maps and clearances
    come from `scripts/bq.py` or a script that prints numbers, not from long reasoning.
12. **Gate edits on the check's exit status.** A check script exits non-zero on any
    finding and is chained as `check && apply` with no pipe in between (or runs under
    `set -o pipefail`).

## Other changes to kicad-pcb text

Prerequisites, "If connection fails" — the first bullet reads:

- Open KiCad yourself: `check_kicad_ui`, then open the board in a standalone PCB editor
  (macOS command in copperpour-gaps.md). Confirm that `open_project` lists it. Ask the user
  only if this fails.

Layout Order, steps 4, 6 and 7 and the note under the list:

4. **Place components** — after drawing the mechanical interfaces (see Mechanical interfaces)
5. **Route traces** — connect all nets
6. **Copper pour** — signal-layer fills and their stitching after routing; plane layers
   and spec-required pours before routing (see Stitching and plane integrity)
7. **DRC**, then the Layout definition of done

Do NOT add signal-layer fills before routing is complete.

Routing Tools: `route_pad_to_pad` — direct connection, auto L-bend routing (raw 90° corner — chamfer
it, see Track geometry — acceptance gate).

Placement, Strategy: "Decoupling caps: within 2mm of their IC power pins, on same layer" reads:
decoupling caps within the mounting-inductance budget of Placement above (3 x the cap's ESL),
on the same layer.

konnect, Design Rules Quick Reference: IC decoupling cap — within the mounting-inductance budget
of Placement above (3 x the cap's ESL), same layer.
