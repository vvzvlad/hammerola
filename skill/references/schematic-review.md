# Schematic review

The electrical review of a revision: does every stage work at its operating point, at the
edges of the envelope the spec declares, in every state of every pin, with the firmware
that drives it — and what changed since the previous revision. It is the half of a review
that `lens-checklist.md` does not cover (those lenses are layout). Run it on «проверь
схему», before the block review with the owner closes (`kicad.md`), and on every revision
of a board that has one. The helper is `scripts/sch.py` (`parts`, `nets`, `net`, `around`,
`texts`, `rails`, `diff`); it reads the whole sheet hierarchy and the kicadxml netlist,
never the board.

Adapted from Wiren Board's `wb-eda-review` (github.com/wirenboard/wb-agent-tools, MIT,
read 2026-11-12); their house numbers, wiki and library are left out.

## Hard rules

- **Notes on the sheet are the author's intent.** `(text)` and `(text_box)` items record
  deliberate choices. A finding a note explains is downgraded or retracted, never shipped
  at full severity; every finding says which note touched it and how that changed the
  rating. A note that contradicts the netlist and cannot be reconciled is a question to
  the owner, not a pick.
- **The spec is the declared envelope.** The project's spec or brief (`docs/SPEC.md`, the
  issue) gives the input range, per-channel and total currents, temperature range,
  protections, interface limits. Check the operating point and the corners at its edges
  (an input of 12–48 V is checked at 48 V, and at 12 V under full load). A contradiction
  between the silicon and the spec is a finding to reconcile — doc bug or design bug —
  never silently resolved one way. Without a spec, say so and review against the parts'
  own limits.
- **Diff real revisions only.** The previous revision is the previous pushed commit of
  the project (`hammerola status`, `git log` of the project directory), or the pair the
  owner names. Never `*-backups/`, `.history/`, `*.kicad_sch-bak`, autosave `~…` files,
  never a fabricated baseline. An autosave newer than the file under review goes into the
  open questions. A first revision has no diff half; say so.
- **Every finding carries its provenance:** introduced in this revision, or pre-existing.
  A pre-existing defect is still a finding; it is never presented as a regression.
- **Every requirement names what it rests on:** the spec clause (quoted), a datasheet
  (link + locator), an owner decision (`docs/SPEC.md` «Решения»), or the reviewer's own
  judgement. A recommendation no document backs is written as a recommendation, not as a
  violation — the owner is entitled to ask «это откуда требование?» and read the answer
  in the finding.
- **Datasheet numbers are cited inline, at the claim:** document name and revision, direct
  URL, table / section / figure / page («RZQ = 240 Ω ±1 % — Micron MT41K256M16 rev. P,
  Table 12, p. 48»). A number that cannot be pinned to a located source is an assumption,
  marked as such; the procedure is `references/datasheets.md`.
- **No located datasheet → severity capped at «проверить».** MAJOR on a guessed limit is
  forbidden. (A +9.6 V boost rail was in spec for the RS841X family, «supply +3…+36 V»; a
  guessed «abs-max ≤ 6 В» would have shipped a false critical.)
- **Severity:** the critic scale of `review-critics.md` — MAJOR (the board does not work,
  or a part is outside its rating inside the declared envelope), MINOR (works, with a
  cost), note (information), plus «проверить» for anything resting on an unverified
  limit. Severity follows reachability: a condition inside the envelope outranks one only
  reachable outside it.
- **Physics apart from model assumptions:** a simulated result says which parts rest on
  topology and datasheet numbers and which on a behavioural model.
- **The report is the chat reply** (`~/.claude/CLAUDE.md`): no HTML, no file, unless the
  owner asks. Sections, in order: verdict (correct / marginal / broken, one line why) ·
  what changed (the diff, or «первая ревизия — сравнивать не с чем») · topology · analysis
  (operating point, the power budget of `references/power-budget.md`, corners) · findings
  (severity, provenance, the note that touched it, the located citation for every number)
  · fixes · method and sources · not verified · open questions. Russian prose; refdes,
  part numbers, net names and units verbatim.

## Order

### 1. Target, previous revision, inventory

Name the revision under review and the previous one (git; `hammerola status` lists the
pushed ones). Inventory the project directory as a whole, not only the schematic: board,
BOM/CPL and their variants, documents `project.json` names, a panel — production consumes
all of them, and a file that lagged the schematic is a finding of this step.

### 2. Notes

`sch.py texts <root>` lists every note on every sheet. Read them before anything else:
they settle step 7. `around` shows only the notes within 40 mm of a part; on a sheet
where the notes stand in a column apart from the parts, `texts` is the list to read.

### 3. What changed

`sch.py diff <old-root> <new-root>` (or the two project directories): parts tolerant to
renumbering (a part with the same value + footprint signature is the same part under a
new reference), nets by membership. Then the BOMs of both revisions
(`kicad-cli sch export bom`, same variant) and the boards (`inv.py` on both: footprints,
sides, positions). Say back the headline («+49 / −5 / ~70») and check it against what the
owner said changed. Renumbering is not a change; a flood of `~changed` is often a library
nickname's case (`t507:` → `T507:`). A rename pass can hide a real disconnect: check the
GND and power pins of every connector against both netlists, do not trust a «топология не
менялась» note. Where a note claims a class was changed («все pls»), count the class
from the diff — three packages turned out to be «all».

### 4. Scope and topology

Every notable sub-circuit, plus everything the diff touched. Notable: every regulator and
switcher, every driver and FET stage, isolation boundaries, protection, anything near
mains, anything a note flags. From the diff: every new or changed active part with its
passive cluster, every net whose membership changed. Changed areas get the deepest
treatment; unchanged notable circuits are still vetted. Decoupling caps are not audited
one by one.

`sch.py around U12 D15 …` dumps each part's pins → nets, the full membership of every net
it touches and the notes near it. From that, name the circuit type (buck / boost / LDO,
current source, level shifter, filter, protection, gate driver, isolation) and the role of
each passive (feedback divider, sense resistor, gate resistor, snubber). Trace inputs back
to their source and outputs to their load with `net`. The bugs live where a changed stage
meets an existing one.

- A part placed as a generic library symbol with another part's value (`AP3015K` on a
  `MIC2288` symbol): check the symbol's pin map against the real part's pinout.
- A connector that mates with a cable or another board: reverse insertion (a
  180°-symmetric pin pattern swaps power silently), one-pin offset, and the powered
  consequences on both sides against abs-max; say whether keying, the case or nothing
  prevents it. (The mechanical half — every mating pad faces its net — is in
  `layout-rules.md`, Mechanical interfaces.)

### 5. Datasheets and the DC operating point

Datasheet for every notable or new active part, by `references/datasheets.md`. Pull what
this circuit needs: regulator — V_ref, V_in range, current limit, control scheme; MOSFET —
V_GS(th) min/typ/max, R_DS(on) vs V_GS, Ciss/Qg, plateau, the I_D–V_GS curve; op-amp —
supply range, RRIO, slew, GBW, I_cm, output drive; diode — V_F, I, V_R.

Compute the operating point — divider outputs, bias currents, drops, headroom — for
normal operation and for the specific condition the revision targets («230 V present» vs
«running off the new backup boost»); the bugs hide in the difference. Look for: a node
outside an IC's abs-max or common-mode range; a divider that halves something important;
a rail too low for a gate drive or a comparator threshold; reverse feed with no blocking
diode; back-powering a dead stage; soft-start and inrush; capacitor voltage ratings;
inductor saturation; thermal and creepage of a switcher near mains.

A module with no datasheet: module maker → the ODM behind it → the die inside (the radio
SoC's own numbers) → distributor parametrics, before recording an assumption. «Not found»
after one search is how a 200 mA TX peak gets compared against nothing.

### 5b. Every MCU and logic pin, in every state

For every microcontroller and logic IC, and the signal pins of op-amps, transceivers,
ADCs and isolators: enumerate each connected pin and confirm the voltage it can see stays
inside the part's limits in all states — normal, idle / Hi-Z, power sequencing (a rail
not yet up, or already down), the targeted condition, fault.

- **Abs-max** (typically GND − 0.3 V … VDD + 0.3 V) and the pin's tolerance: 5 V-tolerant
  is a property of the pin, read from the pin table, not of the part. A 3.3 V pin that
  sees 5 V — directly, through a pull-up to 5 V, or through a divider or clamp landing
  above VDD + 0.3 V — is a defect.
- **VIH / VIL** for correct detection: a 3.3 V GPIO driving a 5 V-powered load whose
  VIH = 0.7·VDD = 3.5 V (WS2812-class); an input that never crosses its threshold.
- **Analog, ADC and comparator inputs** inside VREF / VDD and the common-mode range; a
  divider that overshoots; a sense node above the part's abs-max (an INA-class bus pin).
- **Pulled, clamped, level-shifted and back-fed nets:** idle-high lines through a pull-up
  to a higher rail; a TVS standoff above the pin rating; an RS-485 / CAN / level-shifter
  swing against the pin it drives; back-feeding a pin through its protection diode when
  its own rail is off.

For every pin that can exceed its rating or miss a threshold: the worst-case voltage and
the condition, severity by how reachable the condition is. Trace every analog input back
to its full source network, compute its range and check the constants against firmware
(5c). The coverage map (Orchestration) leaves no MCU pin unassigned — sense dividers die
in the seam between a «power» brief and an «MCU» brief.

### 5c. Firmware cross-check

On a board with an MCU half of the operating point is firmware: PWM frequencies and duty
laws, ADC scale constants mirroring dividers and shunts, pick-up and hold profiles,
compensation tables, brown-out thresholds, pin init states. Read the project's firmware
repository (the owner's; ask which branch the board runs when branches diverge) instead
of guessing. Check at minimum:

| Reviewed in hardware | Firmware counterpart |
|---|---|
| measurement dividers, shunts | scale constants — the actual resistors of this revision, not the donor's |
| firmware-driven power stage (chopper, boost, heater) | control law and the PWM frequency constant; a stale code comment that contradicts the constant: trust the constant, flag the comment |
| relay coils | switch / hold voltage targets and the boost window |
| gate-drive and driver timing | compensation constants: measured on which donor hardware, scaled for which PWM frequency, capped at what, still valid after this revision's parts |
| 5b pre-boot pin states | init order — what the pins do between power-up and driver init |
| supply range | fixed-point ranges (fix16 saturates near 32.768 in volt-scaled code), brown-out and analog-watchdog thresholds and their action |

- For every firmware-driven actuator, find what bounds the worst case: an IR / PWM replay
  buffer with no duty limit turns a «brief pulses only» rating argument into a 3×
  overload firmware can hold for minutes. Nothing bounds it → that is the finding.
- Every EN GPIO: the window between power-on and its init; many datasheets forbid a
  floating EN, and the bootloader runs before `*_init()`.
- Power-down paths: when firmware switches a module's rail off, does it deinit the buses,
  or do idle-high UART / I2C lines back-feed the module through its ESD diodes?
- Cite firmware like a datasheet: repository, branch + commit, `file:line`, at the claim.
  A hardware change without its firmware counterpart, or one living only in an unmerged
  branch, is a finding. No access → «not verified», with the reason.

### 5d. Power budget per rail

Mandatory in every review; the recipe is `references/power-budget.md`. The skeleton comes
from `sch.py rails`, the numbers from located datasheets, never from memory.

### 6. Corners; simulate when dynamic or marginal

When the answer depends on a transient, a feedback loop or a corner that is «close»,
simulate: `ngspice` first, else `ahkab`, else a small `scipy.integrate.solve_ivp` model
(`BDF` / `LSODA` for stiff nodes). Behavioural models: op-amp — single pole + slew + RRIO
clamp; MOSFET — square law with datasheet V_GS(th) / R_DS(on); diode — V_F + small
dynamic R. Sweep: component spread (V_GS(th) min/typ/max, R_DS(on) typ/max, divider
tolerance), temperature over the spec's range, the external thing it meets (a foreign
PSU's current limit anywhere in its allowed range), the rail voltage. Report a pass /
fail table over that space, not one point. Dissipation of each part: `analysis.md`.

**Temperature extremes** — the range the spec declares (−40 … +85 °C only when it says
so). For every notable part take the numbers at both ends, not at 25 °C:

- active parts: MOSFET V_GS(th) rises cold and falls hot, R_DS(on) climbs with
  temperature; BJT hFE and V_BE shift; diode and LED V_F ≈ −2 mV/°C (colder → higher);
  op-amp V_os, I_bias and drive degrade; regulator and V_ref tempco; crystal pulling and
  start-up margin cold;
- passives: X5R / X7R lose capacitance cold and under bias; electrolytic ESR rises
  sharply at −40 °C (ripple, soft-start, hold-up); resistor tempco; inductor L and Isat;
  NTC / PTC; the polyfuse's hold current falls hot;
- isolated DC-DC and digital isolators derate output current hot;
- thresholds and timing that bite at a corner: gate drive, comparator threshold, divider
  and ADC reading, RC delay, LDO dropout, soft-start — fine at 25 °C, out at an extreme.

Report pass / fail across {cold, 25 °C, hot} × component spread. A part with no rating at
an extreme of the declared range is not qualified for it — a finding.

### 6b. Protection and isolation

- **Input protection,** where the spec or the owner asks for it: the polyfuse holds at
  the hot edge of the range with the margin the spec sets, its working voltage covers the
  input; the TVS clamp sits below the downstream part's abs-max (cite both numbers).
- **Isolation:** every domain is a net class in the schematic (`copperpour-gaps.md`,
  the `.kicad_dru` conditions), and the sheet states the isolation voltage and the
  required distance between domains; a missing class label or an unstated rating is a
  finding. Record the gate explicitly even when it does not apply — «pure SELV, no
  barrier» is the record, not an excuse to skip it. Where a barrier exists, the distances
  are measured on the board by `layout-rules.md`, Safety distances, and the lenses
  MI-1…MI-8; a number estimated from pad coordinates is not a measurement.

### 6d. Changelog

The revision's commit body and subject are its changelog (`SKILL.md`: the subject is what
a person picks a revision by). Cross-check both ways against the step-3 diff: every real
change — a part added, removed, re-valued, a net, a footprint, a placement — has its
line and its *why* («R103 15k → 27k чтобы поднять порог»; «поменял R103» is not); no stale
line names a part or value that is not there. A silent change is a finding.

### 6e. Version marking

The silkscreen's name and revision (`layout-rules.md`, Silkscreen) match the project's
version (`version.py`, `SKILL.md`), were incremented from the previous revision, and name
this product, not the board it was copied from. Read them from the board file
(`inv.py` lists silk texts).

### 6f. Production artifacts

- Every BOM reconciles with its schematic variant (`kicad-cli sch export bom --variant`):
  every fitted part has a line, every line exists. Judge the consequence of each excluded
  part by its nets: an omission that severs a mandatory function (the only RX path, a
  non-synchronous buck's catch diode) is MAJOR even when it predates the revision.
- DNP and exclusion flags mirror the current variant (`manufacture-assembly.md`); a
  variant switch is a change the parts diff cannot see — changelog-worthy.
- An SMT panel carries fiducials (`references/panel.md`); its geometry is this
  revision's.
- Text on a layer that is not plotted never reaches the silk: connector pinouts and SWD
  markings sit on the silk layers, or are flagged as won't-print.
- One assembly view per side, without copper, read by eye; both coppers and both value
  layers on one picture are a render artefact, not a defect.

### 7. Cross-check against the notes; re-rate

Before writing a finding, hold it against the step-2 notes and the spec. A note that
explains it → downgrade or retract; a spec condition that makes it reachable, or rules it
out → re-rate. Cases: two FETs on the same XY read as an assembly defect, but the note
«запасное посадочное место» means populate one — retracted, noted for the BOM; grounded
input pins read as a wiring bug, but «заглушки для входов, прошивка стандартная» —
retracted as documented intent; two FET part numbers read as a BOM ambiguity, but «по
ёмкости затвора как IRLML9301 можно DMP6185SEQ» gives the selection rule — downgraded to
«confirm both meet the Qg / V_GS(th) budget»; a P-FET feeding the relay rail
(«передаём Vin на реле») confirms the topology — used to validate, not to alarm.

### 8. Verdict and fixes

Correct, marginal or broken, and in which conditions, quantified («на резервной шине Q13
получает V_GS ≈ 4.6 В, внутри полосы порога 2–4 В → не прокачает ток шины → TX
срывается»). Concrete minimal fixes («заменить R103 15k → 27k») with the reasoning and
the ratings to re-check. What could not be verified from the files, with the reason.

## Orchestration

Inline is the default: steps 4–8 run in this agent unless the fan-out pays for itself.
Coverage comes from scripts and brief design, not from headcount — a missed finding is a
coverage seam, and two reviews of the same board with 23 and 6 agents missed different
things for that reason.

- **≤ 4 notable sub-circuits → no orchestration.** Judge by the sub-circuit count, not
  the delta: a small diff does not shrink the full vet, it only lowers the depth on the
  unchanged circuits.
- Larger → clusters along natural seams (a power tree from input protection to the LDOs,
  an isolation domain, the MCU with its IO, an analog front-end), one critic per cluster,
  2–4 circuits per brief, 3–6 cluster critics for a large board. Clustering by function
  beats splitting by refdes: the bugs are at the boundaries inside a cluster.
- Brief each critic fully: its `around` / `texts` output, its slice of the diff, the file
  paths and the helper calls, the notes that touch its circuits. A critic that re-runs
  steps 1–3 doubles the cost.
- **Write the coverage map before spawning:** every notable part and every MCU pin in
  exactly one brief; what stays unassigned the lead vets inline.
- The power budget is assembled by the lead: `rails` before the fan-out, each cluster
  prices its rows with citations, the lead sums per rail and walks the tree top-down.
- On an MCU board with repository access, firmware is its own cluster (5c); as a
  sub-bullet of another brief exactly those checks get skipped.
- **Verification is one batched pass, in both directions.** First the note cross-check
  (7) inline over the whole set; then one verifier over the surviving MAJORs, briefed to
  refute (wrong datasheet number? operating point off? corner not swept? note ignored?)
  and to aggravate (severity understated? the worst credible scenario, including what
  firmware legally allows?). A verifier that only refutes converges on under-rated
  findings. MINORs and notes get no verifier.
- **Synthesize with a ledger:** every finding any critic returned gets a disposition —
  kept / merged into X / downgraded by note Y / refuted — and the counts go into «method
  and sources». A finding never vanishes because synthesis lost it.
- Budget: 3–6 cluster critics + 1 verifier, rarely more than 8 agents; more means
  re-cluster. Critics return text, not a strict schema: parse what they return.

## KiCad pitfalls

- In the kicadxml netlist `<node pin>` is the pad number and `pinfunction` the human
  name; review by net + pad number, because imports often scramble pin-function names.
- Altium-import artefacts — a board-wide `VALUESCH` property, footprint-case drift, pin
  names — are noted once, not reported as defects.
- `kicad-cli sch erc` is noisy: `unconnected_wire_endpoint`, `pin_not_connected`,
  `lib_symbol_issues`, `footprint_link_issues`, `power_pin_not_driven` for a rail fed
  through an L or an R, `multiple_net_names` for intentional dual labels (which hand you
  the rail map), `pin_to_pin` on an EPAD. Triage by category and quote the real-vs-noise
  split; never dump it. The annotation gate itself is `schematic-library.md`.
- A rename pass can hide a disconnect (step 3).

## When to ask the owner

- The previous revision is ambiguous — parallel variants, two files with no clear order.
- A note contradicts the netlist and the current one cannot be told.
- The spec contradicts the schematic and neither is obviously authoritative.
- Which firmware branch the board runs, when branches diverge.
- A fix has more than one reasonable option and the call is his (a value change vs a
  topology rework).
- The isolation check yields no numbers — no hazardous nets found, copper not bound to
  nets — after one retry with explicit net classes.
