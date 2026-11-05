# PCB layout review checklist — lenses for critic agents

Every rule carries its source; where no source gives a number the item says so and the threshold is a
reviewer/owner parameter, not a fact.

## How to read this list

- **Script:**
  - `AUTO` — KiCad 10 DRC with board-setup constraints or a custom `.kicad_dru` rule (constraint names
    below are from the KiCad 10 PCB Editor manual, [S22]). Run read-only:
    `kicad-cli pcb drc --refill-zones --format json -o out.json <COPY>.kicad_pcb` (`--save-board` only on a
    copy).
  - `GEOM` — custom script over the `.kicad_pcb` s-expression (KiCad 10 file `version 20260206`; nets
    are stored by name, e.g. `(via (at x y) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "/can/CAN_L"))`;
    tracks are `segment`/`arc` with `start`/`end`/`width`/`layer`/`net`; zone fill is in
    `filled_polygon` only if zones were filled when saved — refill a copy first; footprint text is
    `(property "Reference" "R313" (at dx dy rot) (layer "F.SilkS") (effects (font (size h w) (thickness t))))`).
    Shapely-style polygon operations are assumed.
  - `MANUAL` — needs judgement or data outside the file (BOM, enclosure, owner decision).
- **[DISPUTED]** — sources disagree; both sides are quoted. Do not file as a hard violation without
  the owner's choice.
- Datasheets and standards are cited by name. Web sources are `[Sn]`, listed with URL and read date at
  the end.
- KiCad `clearance` is a same-layer check; a 2023 KiCad issue reports custom
  creepage/clearance not being observed across layers through NPTH/slots/edges (gitlab issue 16001,
  KiCad 7, search snippet only — may be outdated). Cross-layer distances therefore need `GEOM`.

---

## 1. Track geometry (TG)

**TG-1. Right-angle corners where a 45° chamfer fits.** **[DISPUTED]**
- Rule: replace 90° bends with two 45° bends or an arc. TI: "Avoid right-angle bends in a trace and
  try to route them at least with two 45° corners" [S4 §2.5]; "Use 45° bends (chamfered corners),
  instead of right-angle (90°) bends" [S6 §4.6 item 2]; high-speed differential pairs: "maintain a bend
  angle greater than 135°" [S5 §3.11]; Espressif RF trace: "routed at a 135° angle, or with circular
  arcs" (Espressif ESP32-C3 HDG).
- Disagreement: Johnson — "Right-angle bends in PC-board traces perform perfectly well in digital
  designs in speeds as fast as 2 Gbps"; reflection from one corner of an 8-mil trace at 100 ps edges is
  ≈0.003 of the step [S16]. Bogatin — corner excess capacitance ≈1.7 fF per mil of trace width for a
  50 Ω line; a 5-mil trace corner has no visible effect "at bandwidths even as high as 70 GHz" [S17].
  For SPI, I²C, CAN, USB full-speed and LED data the corner is electrically irrelevant by
  [S16]/[S17]; the rule is a workmanship convention the owner asked for, and a hard rule only on
  high-speed pairs such as USB D+/D− [S5].
- Script: `GEOM`. Per net and layer, build a graph of track endpoints (snap 1 µm). At every node with
  exactly two segments compute the deflection between direction vectors; flag |deflection − 90°| < 1°.
  "45° fits": replace the corner by a chamfer with legs of length c (parameter — no source gives c),
  buffer the new 45° segment by width/2 + net clearance, and accept the flag only if both legs are
  ≥ c and the buffered chamfer does not intersect other-net copper, pads or keep-outs. `AUTO` partial:
  KiCad 10 `track_angle` (min/max) "Checks the angle between two connected track segments" [S22] —
  check its angle convention on a two-segment test board before relying on it.

**TG-2. Acute angles (acid traps, slivers).** **[DISPUTED]**
- Rule: no same-net copper wedge with an interior angle < 90° (track–track, track entering a pad edge
  obliquely, T-junction on a segment interior).
- Sources: JLCPCB's layout-service page describes "acute angles between traces that can 'trap'
  etching chemicals during fabrication" [S24, search snippet only]. Measurable proxy from JLCPCB
  capabilities: "Same-net track spacing 0.25mm" [S18].
- Disagreement: Johnson reports the only manufacturing complaint about right angles as wave-solder
  traps, and "With reflow soldering and good solder masking, neither is a problem" [S16]; a secondary
  blog calls the acid-trap concern obsolete with modern etchants [S25]. No IPC text was read.
  Treat as low-severity DFM.
- Script: `GEOM` — at every node and at T-junctions (track endpoint on another segment's interior)
  compute interior angles between incident copper edges; flag < 90°. Sliver proxy: union same-net
  copper per layer, find same-net edge pairs closer than 0.25 mm that are not the same feature.

**TG-3. Sideways jog at a pad exit (owner's catch).**
- Rule: the track leaves the pad straight, along a pad axis, and the first bend is not at or inside the
  pad edge. **No source gives a minimum straight length** — L_min is the owner's parameter. Related
  sourced rules: for chip passives "Match the trace entry, using the same trace width on both ends"
  [S21]; for high-speed pairs, Fig. 3-10 of [S5] shows straight segments > 1.5 × trace width between
  bends and bends > 135°.
- Script: `GEOM` — for each pad, take the segment whose endpoint lies inside the pad polygon; rotate
  its direction into the pad frame (pad angle + footprint angle); flag if not within ±1° of 0/90/180/270.
  Measure distance from the pad edge to the first vertex with non-zero deflection; flag if < L_min.
  Flag "dog-legs": two consecutive deflections of +θ and −θ within L_min of the pad (a sideways shift).

**TG-4. Symmetric connection of two-terminal SMD parts (tombstoning).** **[DISPUTED]**
- Rule (JLCPCB, the assembler): "Match the copper connection, giving a plane-side pad thermal relief
  spokes, not a solid pour"; "Keep both pads on the same copper layer with identical trace widths";
  "Keep vias out of chip pads, since via-in-pad showed far higher tombstone rates in 01005 testing" [S21].
- Disagreement: Espressif — "The ground pads of the chip and surrounding circuit components should make
  full contact with the ground copper pour rather than being connected via traces" (Espressif ESP32-C3 HDG);
  TI step-down layout — "completely pour a copper plane between the PGND pins and the exposed thermal
  pad" [S7]. Solid connection is preferred electrically, spokes for assembly yield; owner's choice per
  component class (e.g. solid for EPAD/power, spokes for 0402 decoupling).
- Script: `GEOM`/`AUTO` — for every 2-pad footprint (R, C, L, D, FB): widths of tracks entering pad 1
  vs pad 2; zone connection mode of each pad (pad, footprint and zone settings: solid vs thermal);
  any via centre inside a pad polygon. KiCad `zone_connection`, `min_resolved_spokes`,
  `thermal_spoke_width` constraints [S22].

**TG-5. Necking and width discipline on power nets.**
- Rule: a net keeps its width up to the pad; narrowing only where the pad is narrower than the track.
  Espressif 3.3 V path to the ESP: main power ≥25 mil (0.635 mm), VDD3P3 ≥20 mil (0.508 mm), other
  power 10 mil (0.254 mm), power surrounded by ground copper (Espressif ESP32-C3 HDG); when main power
  changes layer, ≥2 vias, and via drill ≥ trace width (Espressif ESP32-C3 HDG). TI: "one via per amp of
  current flowing. However, more is better" [S7]. JLCPCB track width tolerance ±20% [S18].
- Current-to-width numbers (IPC-2152): not read, **no number given here**.
- Script: `GEOM` — per net, modal track width; flag segments narrower than the modal width outside a
  pad-escape radius (parameter); flag power-net segments below the Espressif minima on the 3V3 path;
  at each layer change of a power net count parallel vias and compare drill with track width.

**TG-6. Teardrops at via/PTH junctions.**
- Sources: no primary IPC text read. Secondary blogs state IPC-6012 Class 2 tolerates 90° annular-ring
  breakout only with a fillet/teardrop at the junction [S25, unverified].
- Inference (labelled as such) from JLCPCB numbers: via diameter must be "0.1mm(0.15mm preferred)
  larger than Via hole size", i.e. a 0.05–0.075 mm ring, while "Hole Position Tolerance ±0.075 mm"
  [S18] — the drill can reach the ring edge where a narrow track joins; a teardrop keeps the joint.
- Script: `GEOM` — KiCad stores teardrops as zones with a teardrop attribute; list via/PTH–track
  junctions whose track width < ring diameter and that have no teardrop zone at the junction. No DRC
  constraint for missing teardrops was found in [S22].

**TG-7. Width steps on impedance-relevant lines are tapered.**
- Rule: "Use tapered line between transmission lines with different width" [S13]. Script: `GEOM` — width
  change at a node on D+/D− without an intermediate segment.

**TG-8. Stubs, dangling copper.**
- Rule: no dangling tracks/vias; on USB "Number of stubs allowed on any USB differential pair trace
  (total) 0" [S5 Table A-1]. Script: `AUTO` — `track_dangling`, `via_dangling` [S22]; `GEOM` — nodes of
  degree 3+ on D+/D−.

---

## 2. Ground and return paths (GR)

**GR-1. One reference plane, partitioned, not split.** **[DISPUTED]**
- Ott: two EMC principles — return current locally, and "a system should have only one reference
  plane"; checklist line "Do not split the ground plane"; if a split is unavoidable, "connect the planes
  together at one location, thus forming a bridge" and route every crossing trace over it [S3]. TI:
  "If possible, use a continuous ground plane; do not split them" [S4 §2.3]; "It is always preferable to
  use only one ground plane, partitioning the PCB into analog and digital sections" [S8].
- Disagreement: ADI — "When in doubt, it is always better to start out with a split analog and digital
  ground plane and later connect them with jumpers" [S1 p.14].
- Script: `GEOM` — number of separate GND plane fill polygons per isolation domain (expected 1 each).

**GR-2. Plane integrity: area kept, no islands, no skinny necks.**
- ADI: on a 2-layer board "as much area as possible should be preserved, and at least 75% should
  remain"; check for "isolated ground 'islands'" and for "'skinny' connections between adjacent large
  areas" [S1 p.3]. ADI isoPower note: floating fill "can act as a patch antenna"; "Thin fingers of fill
  should be removed" [S11].
- Script: `GEOM` — area(GND fill)/area(outline) ≥ 0.75 on a 2-layer board; fill polygons with no via/pad of the
  net (islands); morphological opening of each fill with radius r (parameter): if the polygon splits,
  a neck narrower than 2r exists — report location. `AUTO`: KiCad isolated-copper/island removal
  settings and `connection_width` [S22].

**GR-3. No signal crosses a gap or a net boundary in its reference layer.**
- Ott: "Traces routed across a slot or split in a ground or power plane are one of the most common
  problems that I encounter as an EMC consultant" [S3]. TI: "Do not route signals over a gap" [S4];
  high-speed signals "at least 1.5 W ... away from voids in the reference plane" and "≥ 90 mils from the
  edge of the reference plane"; if crossing a split is unavoidable, stitching capacitors "1 μF or lower
  and placed as close as possible to the plane crossing" [S5 §2.4, §3.2].
- A layer that references a power plane: TI: "TI does not recommend high-speed signal references to
  power planes" [S5 §2.4]; the ISO1042 stack puts "slower speed control signals on the bottom layer"
  because they "tolerate discontinuities such as vias" (TI ISO1042 datasheet). Clocks, SPI SCLK,
  crystal and analog nets belong over the GND plane.
- Script: `GEOM` — sample every track centreline at 0.1 mm; at each sample read the adjacent (reference)
  layer; flag samples with no copper below and every change of the reference net along the track; for
  USB also flag samples closer than 1.5 × width to the reference polygon boundary. List nets over a
  power reference that are clocks (SCLK, CLKIN/CLKOUT), SPI, LED data.

**GR-4. Via antipads and pin rows must not slot the plane.**
- TI: "Breaking up the plane with a row of holes is much better than having a long slot"; for 100-mil
  pin rows "place a small trace between each pin" [S9 §2.1.7]; "Do not create slots, for example in the
  ground plane, by using closely placed vias" [S4 §2.5]; via clearance sections must not interrupt the
  return path [S6 §4.6 item 4].
- Script: `GEOM` — after fill, take the holes (interiors) of the GND plane fill polygons; merge
  holes closer than ε; report holes with length/width or length above parameters; check headers,
  board-to-board pads and USB-C for plane webs between adjacent pins.

**GR-5. Layer change of a signal has a return via nearby.**
- TI: "via-stitch both GND planes together ... Place these stitching vias symmetrically within 200 mils
  (center-to-center, closer is better) of the signal transition vias" (200 mil = 5.08 mm) [S5 §2.4];
  "accompany each signal trace via with a return-trace via" [S6 §4.6 item 6]; Espressif USB: "If vias
  are necessary, add a pair of ground return vias at each transition point" (Espressif ESP32-C3 HDG).
  Where the reference changes between a GND and a power plane, the return crosses via a capacitor
  [S5 §2.4 stitching capacitors].
- Script: `GEOM` — for each signal via: distance to nearest GND via (flag > 5.08 mm for clocks, SPI,
  USB, CAN TXD/RXD, LED data); if the via changes reference GND↔power, nearest capacitor between those
  two nets within the same distance.

**GR-6. Pours on different layers are stitched (owner's catch).** **[DISPUTED: pitch]**
- ADI: fills "should be tied to their appropriate reference plane along the edges with vias every
  10 mm"; "If the fill has an irregular shape, put vias at the extreme edges of the shape"; edge guard
  via fence: "Analog Devices test boards used 4 mm via spacing" [S11]. TI 2-layer gridding: "Use as many
  through holes as can physically fit"; a fill "connected at only one point is just a ground shield, but
  if connected at two or more points, it becomes a conductor" [S9 §2.2.3]. Silicon Labs (2.4 GHz):
  stitching vias along PCB edges and GND pour edges with spacing "less than lambda/10 of the 10th
  harmonic (the typical distance between vias on reference radio boards is 40–50 mil)" [S13 §3.1].
  Espressif: "sufficient ground copper and dense ground vias" near the antenna (Espressif ESP32-C3 HDG), no
  number.
- Disagreement: no universal pitch — 1.0–1.3 mm (Silicon Labs, RF boards) vs 4 mm (ADI edge fence)
  vs 10 mm (ADI fill ties). Away from antennas the ADI figures are the published ones that fit; near an
  antenna the Silicon Labs figure is the only number found.
- Script: `GEOM` — for every F.Cu/B.Cu GND fill polygon: count GND vias/PTH inside (≥2); walk the
  boundary, project vias lying within d_edge (parameter) of it, report the largest gap along the
  boundary vs 10 mm / 4 mm (board edge) / 1.27 mm (near an antenna); sample the fill on a
  0.25 mm grid and report the largest distance to a GND via; flag fingers (see GR-2).

**GR-7. Interboard joint carries enough ground.**
- ADI: a board-to-board connector "should have at least 30-40% of its pins devoted to ground", and
  signal pins in a connector should be separated "with ground pins (creating a faraday shield)" [S1];
  same 30–40% in [S8].
- Script: `GEOM` — count tab pads by net on both boards; for each fast pad report whether a GND pad is
  adjacent.

**GR-8. Ground loops.**
- Sources: TI — "Connect split ground planes only at one point. More common ground connections can
  create ground loops" [S4 §2.3]; ADI — ferrite beads between planes "introduce dc ground loops which
  can be troublesome in precision systems" [S1]; TI — with several joins "the analog and digital ground
  planes are connected at several points, creating the possibility of ground loops" [S8].
- What to check here:
  1. Every galvanic connection between board GND and the outside world: connector grounds and
     shields (USB-C GND/shield), sensor minus inputs, output connectors, mounting holes,
     isolated-supply secondaries. Two external connections that can meet outside the board (a
     grounded sensor + another earth path; USB host earth + another ground link) form a loop.
  2. Copper loops of GND tracks on a 2-layer board that enclose an area without plane
     underneath (loop antenna).
  3. Net-ties: more than one tie between the same two ground nets is a loop.
  4. Signal–return loop area (GR-3).
- Script: (1) `GEOM` partial — list GND-net pads that belong to connector, shield, mounting or tab
  footprints, then `MANUAL` against the spec. (2) `GEOM` — graph of
  GND tracks only (no zones), cycle basis, enclosed area per cycle, flag cycles not covered by GND on
  the other layer. (3) `GEOM` — count net-tie footprints per net pair.

**GR-9. Quiet ground of the buck converter.** **[DISPUTED]**
- TI step-down: small-signal grounds "are best routed directly back to the AGND pin, where they make a
  single point connection to the exposed thermal pad"; "Placing vias into the system ground plane on the
  quiet grounded components is not generally recommended" [S7]. Opposite general advice: "Connect the
  pad of the capacitor directly with a via to the ground plane" [S4 §2.4]; MT-031 Fig. 2 [S1].
- Script: `GEOM` + `MANUAL` — locate the FB divider's ground end; path to the IC GND pin; whether it
  shares copper with the input-capacitor return before the pin.

**GR-10. Overlap of planes from different domains.** **[DISPUTED: EMI vs safety]**
- TI: "ensure that planes that do not reference each other are not overlapped because this produces
  unwanted capacitance" [S5 §2.4]; "Power planes should only reference their own ground plane" [S4].
- Opposite on purpose: ADI forms a stitching capacitor across an isolation gap by "Extending the ground
  and power planes on an interior layer into the isolation gap" or with a floating inner plane [S11];
  the ISO1042 layout example shows an "Isolation Capacitor" across the barrier (TI ISO1042 datasheet).
- Safety side: "Reinforced insulation requires a minimum distance of 0.4 mm (about 16 mil) of
  insulation along a bonded surface ... or directly through the insulation from layer to layer in most
  cases" [S11].
- Script: `GEOM` — intersect copper of each domain (e.g. primary, secondary, isolated bus) on
  every layer with copper of the other domains on every other layer; report overlap area and the
  dielectric thickness between the two layers from `(setup (stackup ...))`.

**GR-11. No fast signals along board edges.**
- TI: "Never run noisy traces on the outside edge of the board" [S9]; ADI: "Do not route high speed
  lines close to the edges of the PCB" [S11]; TI: high-speed pairs ≥ 90 mil (2.29 mm) from the edge of
  the reference plane [S5].
- Script: `GEOM` — distance from clock/SPI/USB/CAN/LED-data segments to the outline and to the
  reference-fill boundary.

---

## 3. Decoupling and crystal placement (DC)

**DC-1. Smallest capacitor nearest the pin, short ground via at the capacitor.**
- ADI: small capacitor "as physically close to the power pins of the chip as is possible"; bulk
  electrolytic "no more than 2 in. away from the chip"; all decoupling capacitors connect to the plane
  "through a via or short trace to minimize inductance" [S2 Fig. 2]. ADI Fig. 2: a trace in the ground
  path of the decoupling capacitor is the "INCORRECT" case [S1]. TI: "Place the lowest valued capacitor
  as close as possible to the device"; "Connect the pad of the capacitor directly with a via to the
  ground plane. Use two or three vias"; "Make sure that the signal must flow along the capacitor"
  [S4 §2.4]. TI isolators: power side directly to the pin, two vias to each plane [S6 §4.6 item 10].
  Espressif: "Ground vias should be added close to the capacitor's ground pad" (Espressif ESP32-C3 HDG).
- Script: `GEOM` — for each IC supply pin: capacitors with one pad on the pin's net and one on GND;
  edge-to-edge distance pin↔capacitor pad and routed length; order by capacitance (value field) — the
  smallest value must be nearest; distance from the capacitor GND pad to the nearest GND via and the
  via count; topology check that the supply route passes the capacitor pad before reaching the pin.

**DC-2. Device-specific decoupling.**
- Each IC's datasheet decides values, placement and via use; e.g. ISO1042: "place the V CC2 bypass
  capacitors on the top layer, as close to the device pins as possible, and complete the connection
  to the VCC2 and GND2 pins without using vias" (TI ISO1042 datasheet).
- Script: `GEOM` as DC-1 with per-device pin lists; where the datasheet forbids vias, assert that the
  copper path between each capacitor pad and its pins contains no via.

**DC-3. Crystal layout.** **[DISPUTED: crystal ground]**
- ADE9153A note: keep the CLKIN load capacitor as close to the pin as possible, avoid long
  connections that create loops, "do not route signal traces near the crystal layout" [S12]. Espressif
  (chip-level): no vias on clock traces, no signal traces under the crystal, crystal ≥2.0 mm from the clock
  pin, no large inductors nearby (Espressif ESP32-C3 HDG). ST: short tracks, "A guard ring around these
  connections, connected to the ground, is essential"; high-frequency paths routed away [S14 §7.1].
- Disagreement on the crystal's ground: ST — "The oscillator PCB must be underlined with a dedicated
  underneath ground plane, distinct from the application PCB ground plane ... connected to the nearest
  MCU/MPU ground", and a metal crystal can should not be connected to the oscillator ground [S14 §7.1];
  Silicon Labs — "Connect the crystal case to the ground using many vias" [S13 §3.1]; Espressif —
  continuous ground plane under/around the crystal (Espressif ESP32-C3 HDG).
- Script: `GEOM` — CLKIN/CLKOUT track length and via count (expect 0 vias); other-net copper inside the
  crystal courtyard on any layer (expect none) and within a parameter distance; load-capacitor GND pad
  distance to crystal/IC; reference-plane coverage of the crystal courtyard; inductors within a
  parameter distance.

---

## 4. Mains and isolation practice beyond the creepage numbers (MI)

**MI-1. Slots and grooves count only if wide enough.**
- IEC 60664-1 §4.2: dimension X minimum — pollution degree 1: 0.25 mm, 2: 1.0 mm, 3: 1.5 mm; a groove
  narrower than X is bridged ("measured directly across the groove"); "If the associated clearance is
  less than 3 mm, the minimum dimension X may be reduced to one third of this clearance"
  (IEC 60664-1 and examples 1–3 after it). TI isolator guide: for a groove ">1 mm wide" creepage =
  existing creepage + groove width + 2 × depth [S6 §4.3] (that is the PD2 X). TI seminar Table 7 lists
  the same X values (TI SLUP419).
- JLCPCB: non-plated slot minimum 1.0 mm; copper clearance from routed slots ≥0.2 mm; "Rectangular
  holes and slots without rounded corners are not supported" [S18].
- Script: `GEOM` — internal Edge.Cuts contours used as creepage slots: minimum width (inscribed circle)
  ≥ X; copper-to-slot ≥ 0.2 mm. `AUTO` partial: KiCad 10 `creepage` constraint ("Creepage paths are
  highlighted ... configured using a creepage constraint in custom rules", [S22]); whether KiCad applies
  the X rule to narrow slots was not found — verify with a test case.

**MI-2. Inner layers in the isolation gaps.** **[DISPUTED]**
- TI seminar: IPC-2221B inner layers need much less spacing, e.g. 0.25 mm at 400 V peak, vs 2–2.6 mm
  on uncoated external layers (TI SLUP419). ADI: interior layers are "solid insulation
  or permanently cemented joints"; reinforced insulation needs 0.4 mm along a bonded surface or through
  insulation [S11].
- Script: `GEOM` — for each pair of domains: same inner layer → in-plane distance vs the spec table;
  adjacent layers → any overlap area and the dielectric thickness from the stackup. KiCad `clearance`
  is same-layer only (see header note).

**MI-3. Nothing under the isolator; board distances computed for the board, not the package.**
- TI: "on all layers keep the space under the isolator free from traces, vias, and pads" [S6 §4.3].
  ISO1042: board mounting pads must not reduce creepage/clearance; grooves or ribs may be used
  (TI ISO1042 datasheet). The package figures (CLR/CPG > 8.5 mm for DWV-8, material group I, pollution
  degree 2, TI ISO1042 datasheet) are package properties; FR-4 is material group IIIa and needs
  more — TI's example: 4 mm for group I vs 8 mm for group IIIa (TI SLUP419).
- Script: `GEOM` — region between the two pad rows (courtyard minus pads): any copper, via or mask
  opening on any layer → flag; minimum copper-to-copper across the barrier per layer.

**MI-4. Stitching capacitance across the barrier.** **[DISPUTED: EMI vs safety]**
- ADI: three ways to stitch across an isolation gap — "A safety rated capacitor applied across the
  barrier", a floating inner plane, or overlapping inner planes; Y2 is "the recommended safety capacitor
  type for a stitching capacitor in a safety rated application" [S11]. Whether to stitch is the owner's
  decision; the reviewer only reports what exists.
- Script: `GEOM` — copper overlapping/bridging the barrier; capacitors with one pad on each side →
  `MANUAL` check that the BOM part is Y-rated.

**MI-5. No grooves joining conductive parts; creepage ≥ clearance.**
- IEC 60664-1: "Joints or grooves joining conductive parts should be avoided since they can collect
  pollution or retain water"; "A creepage distance cannot be less than the associated clearance"
  (IEC 60664-1).
- Script: `GEOM` — slots whose ends come within 0.2 mm of copper of two different domains.

**MI-6. Surge parts near the terminal.**
- ADI: "Connect a metal oxide varistor (MOV) across and near the live in terminal and the neutral
  terminal" [S12].
- Script: `GEOM` — MOV pad distance to the mains terminal pads; length of unfused copper from the
  terminal to the fuse. `MANUAL` order.

**MI-7. Primary trace widths for fault current.**
- No IPC-2152 source read — **no number here**. Script: `GEOM` — report min width per primary net.

**MI-8. Safety and connector markings present.**
- Script: `GEOM` — search text on F/B.SilkS for each string the spec requires.

---

## 5. Silkscreen conventions (SK)

**SK-1. Size of legend text and lines.** **[DISPUTED]**
- JLCPCB capabilities: line width "≥0.15mm" ("Characters width less than 0.15mm will be
  unidentifiable"); minimum text height "40 mil (1.0mm)"; character width-to-height ratio 1:6;
  "The Minimum Distance Between Pad and Silkscreen is 0.15mm" [S18].
- Disagreements: JLCPCB's own blog — "minimum 0.8 mm text height and 0.15 mm line width" [S20];
  KiCad Library Convention F5.1 — reference designator 1.00 mm high, 0.15 mm thick; silkscreen line width
  nominally 0.12 mm (0.10–0.15 allowed) [S23] — library footprint outlines at 0.12 mm are below the JLCPCB
  0.15 mm line minimum. If "1:6" means stroke:height, 1.0 mm text needs ≥0.167 mm stroke — this reading of
  the JLCPCB row is not confirmed.
- Script: `AUTO` — `text_height (min 1.0mm)`, `text_thickness (min 0.15mm)`, `silk_clearance` [S22];
  `GEOM` — `fp_line`/`gr_line` widths on F/B.SilkS < 0.15 mm.

**SK-2. Reference designators next to their own part, readable after assembly.**
- JLCPCB blog: designator "Near the part they are associated with, but only one label next to each
  footprint"; keep labels off pads, vias and other designators; "Do not have text over dense via fields";
  do not run designators across board edges or slots; text on solder mask; for dense boards use an
  assembly drawing instead of crowded silkscreen [S20]. KLC: silkscreen "must not be placed over pads or
  areas of exposed copper" [S23].
- Script: `GEOM` — for every Reference text: bounding box (font size × string length, rotation) → (a)
  distance to own courtyard vs nearest foreign courtyard (flag if closer to a foreign one or farther than
  a parameter); (b) overlap with any courtyard (text under a body); (c) overlap with mask openings, vias,
  other text, outline/slots.

**SK-3. Orientation.**
- JLCPCB blog: "All text displays should be in one of two directions: Left to right or bottom to top";
  "Not upside down or mirrored with respect to its two possible orientations" [S20].
- Script: `GEOM` — absolute text angle (footprint rotation + property angle); allow {0°, 90°} on F.SilkS;
  on B.SilkS require mirrored text and {0°, 90°} as read from the bottom; flag 180°/270° and other angles.

**SK-4. Pin-1 and polarity marks visible after assembly.**
- KiCad library convention: "Pin-1 designator must always be visible after board assembly" [S23, GitHub
  wiki snippet]. Script: `GEOM` partial — for polarised footprints (D, LED, U, polarised C, connectors)
  silkscreen exists outside the body outline near pad 1.

**SK-5. Fab-layer designators for dense areas.**
- KLC: reference designator also on F.Fab, inside the outline [S23]. Script: `GEOM` — `%R` text present on
  F.Fab of each footprint where the silkscreen designator is hidden.

---

## 6. DFM — JLCPCB, read 2026-10-11 [S18], [S19]

| Item | JLCPCB value | Check |
|---|---|---|
| Track/space, 1 oz | 2-layer 0.10/0.10 mm; multilayer 0.09/0.09 mm | `AUTO` `track_width`, `clearance` |
| Track/space, 2 oz | 2-layer 0.16/0.16; multilayer 0.15/0.15 mm | `AUTO` |
| Track width tolerance | ±20% | design margin, TG-5 |
| Via hole / diameter | min 0.15/0.25 mm; diameter 0.1 mm (0.15 preferred) larger than hole; preferred min hole 0.2 mm; holes 0.2/0.25 mm with diameter < 0.45 mm "will cost more" | `AUTO` `hole_size`, `via_diameter`, `annular_width` |
| PTH annular ring | multilayer 1 oz: 0.20 recommended, 0.15 absolute; 2-layer 1 oz: 0.25 recommended, 0.18 absolute; 2 oz: 0.254 | `AUTO` `annular_width` |
| Hole position tolerance | ±0.075 mm | TG-6 |
| Hole size tolerance | +0.13/−0.08 mm (PTH) | footprint review |
| Hole-to-hole | via 0.2 mm; pad holes 0.45 mm | `AUTO` `hole_to_hole` |
| Via hole to track | 0.2 mm | `AUTO` `hole_clearance` |
| PTH to track | 0.28 min, 0.35 recommended | `AUTO` `hole_clearance` |
| NPTH to track | 0.2 mm | `AUTO` |
| Pad to track | 0.1 mm | `AUTO` `clearance` |
| SMD pad to pad (different nets) | 0.15 mm; minimum SMD pad 0.25 × 0.25 mm | `AUTO` |
| Inner layer: via hole to copper / PTH hole to copper | 0.2 mm / 0.3 mm | `AUTO` per-layer `hole_clearance` |
| Same-net track spacing | 0.25 mm | `GEOM` (TG-2) |
| Hatched grid width/spacing | 0.25 mm | zone settings |
| Solder mask expansion | 1:1 opening allowed; ≥0.09 mm between mask openings and neighbouring traces | `GEOM` |
| Solder mask bridge | 1 oz: 0.10 mm (green, red, yellow, blue, purple), 0.13 mm (black, white); 2 oz: 0.20 mm | `AUTO` `bridged_mask`, board setup min web |
| Plugged (mask-filled) vias | no mask opening on either side; ≥0.35 mm from other mask openings; ≤0.5 mm diameter | `GEOM` |
| Via-in-pad | epoxy or copper-paste filled and capped, via 0.15–0.55 mm; default only for 6+ layers | order option; otherwise no open vias in SMD pads (TG-4, [S10] plug/tent EPAD vias) |
| Copper to routed edge / slot / V-cut | ≥0.2 / ≥0.2 / ≥0.4 mm | `AUTO` `edge_clearance` |
| NPTH min / NPTH slot min / plated slot min | 0.50 mm / 1.0 mm / 0.35 mm multilayer, 0.5 mm 2-layer, length ≥ 2 × width | `GEOM` |
| Slot corners | rectangular slots without rounded corners not supported | `GEOM` Edge.Cuts |
| Silkscreen | see SK-1 | `AUTO` |
| Controlled impedance | 4+ layers only; ±10% | `MANUAL` |
| Copper weight | outer 1 or 2 oz on multilayer; inner 0.5 oz finished by default | `MANUAL` |
| PCBA size | Standard: single PCB 70 × 70 mm to 460 × 500 mm, edge rails and fiducials "Necessary", min package 0201, min pitch 0.35 mm; Economic: 10 × 10 mm upward, rails/fiducials "Not necessary", single-sided, min package 0402, min pitch 0.40 mm [S19] | a board below the Standard minimum → Economic or a panel; `MANUAL` |
| QFN/LFCSP land | TI: NSMD pads recommended; central pad to lead pad clearance "should not be reduced to smaller than 0.2 mm"; at 0.5 mm pitch pad width 0.28 mm or less; thermal vias plugged or tented [S10] | `GEOM` on footprints |

---

## Sources

Datasheets and standards cited by name: Espressif ESP32-C3 Hardware Design Guidelines (online: S15),
TI ISO1042 datasheet, TI SLUP419 (clearance and creepage seminar, 2024), IEC 60664-1:2002
(= IS 15382 Part 1:2003).

Web (all read 2026-10-11):

| ID | Source | URL |
|---|---|---|
| S1 | ADI MT-031 Rev A, Grounding Data Converters and Solving the Mystery of "AGND" and "DGND" | https://www.analog.com/media/en/training-seminars/tutorials/MT-031.pdf |
| S2 | ADI MT-101 Rev 0, Decoupling Techniques | https://www.analog.com/media/en/training-seminars/tutorials/MT-101.pdf |
| S3 | H. W. Ott, Partitioning and Layout of a Mixed-Signal PCB, Printed Circuit Design, June 2001 (full text via EE Times page, quotes extracted by a summarising fetch; page 1 also as PDF) | https://www.eetimes.com/partitioning-and-layout-of-a-mixed-signal-pcb/ ; https://hott.shielddigitaldesign.com/pdf_files/june2001pcd_mixedsignal.pdf |
| S4 | TI SCAA082A, High-Speed Layout Guidelines (rev. Aug 2017) | https://www.ti.com/lit/an/scaa082a/scaa082a.pdf |
| S5 | TI SPRAAR7J, High-Speed Interface Layout Guidelines (rev. Feb 2023) | https://www.ti.com/lit/pdf/spraar7 |
| S6 | TI SLLA284G, Digital Isolator Design Guide (rev. Sep 2023; served at the slla284d URL) | https://www.ti.com/lit/an/slla284d/slla284d.pdf |
| S7 | TI SLYT614, Five steps to a great PCB layout for a step-down converter (AAJ 1Q 2015) | https://www.ti.com/lit/an/slyt614/slyt614.pdf |
| S8 | TI SLYT512, Grounding in mixed-signal systems demystified, Part 2 (AAJ 2Q 2013) | https://www.ti.com/lit/pdf/slyt512 |
| S9 | TI SZZA009, PCB Design Guidelines for Reduced EMI (1999) | https://www.ti.com/lit/an/szza009/szza009.pdf |
| S10 | TI SLUA271 Rev C, QFN and SON PCB Attachment | https://www.ti.com/lit/an/slua271b/slua271b.pdf |
| S11 | ADI AN-0971 Rev C, Recommendations for Control of Radiated Emissions with isoPower Devices | https://www.analog.com/media/en/technical-documentation/app-notes/an-0971.pdf |
| S12 | ADI AN-1562 Rev 0, Layout Considerations when Adding Energy Monitoring to a System Using the ADE9153A | https://www.analog.com/media/en/technical-documentation/app-notes/an-1562.pdf |
| S13 | Silicon Labs AN928.2 Rev 1.7, EFR32 Series 2 Layout Design Guide | https://www.silabs.com/documents/public/application-notes/an928.2-efr32-series2-layout-design-guide.pdf |
| S14 | ST AN2867 Rev 24 (Feb 2026), Guidelines for oscillator design on STM8AF/AL/S and STM32 MCUs/MPUs | https://www.st.com/resource/en/application_note/an2867-guidelines-for-oscillator-design-on-stm8afals-and-stm32-mcusmpus-stmicroelectronics.pdf |
| S15 | Espressif ESP32-C3 HDG online, PCB Layout Design (latest) and keep-out figure | https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32c3/pcb-layout-design.html ; https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32c3/_images/esp32c3-module-clearance.png |
| S16 | H. Johnson, Who's Afraid of the Big Bad Bend? (EDN column) | https://www.sigcon.com/Pubs/edn/bigbadbend.htm |
| S17 | E. Bogatin, Should you worry about 90 degree bends in circuit board traces?, Signal Integrity Journal, 2021-04-13 | https://www.signalintegrityjournal.com/articles/2104-should-you-worry-about-90-degree-bends-in-circuit-board-traces |
| S18 | JLCPCB Rigid PCB Capabilities | https://jlcpcb.com/capabilities/pcb-capabilities |
| S19 | JLCPCB PCB Assembly Capabilities | https://jlcpcb.com/capabilities/pcb-assembly-capabilities |
| S20 | JLCPCB blog, Creating Clear and Professional Reference Designators | https://jlcpcb.com/blog/pcb-reference-designators |
| S21 | JLCPCB blog, PCB Tombstoning (published 2026-04-07, updated 2026-09-09; quotes via summarising fetch) | https://jlcpcb.com/blog/pcb-tombstone |
| S22 | KiCad 10 PCB Editor manual (DRC violations and custom-rule constraints) | https://docs.kicad.org/10.0/en/pcbnew/pcbnew.html |
| S23 | KiCad Library Convention F5.1 (page returned HTTP 403; text from search-result snippet) and the KiCad library wiki (snippet) | https://klc.kicad.org/footprint/f5/f5.1/ ; https://github.com/KiCad/kicad-library/wiki/Kicad-Library-Convention |
| S24 | JLCPCB layout service page (acid-trap sentence, search snippet only) | https://jlcpcb.com/features/layout |
| S25 | NWES blog (secondary): right-angle traces; teardrops and IPC Class 3 (search snippets only) | https://www.nwengineeringllc.com/article/right-angle-pcb-traces-its-time-to-kill-the-myths.php ; https://www.nwengineeringllc.com/article/are-teardrops-required-on-ipc-class-3-pcb-designs.php |
