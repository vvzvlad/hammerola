# Power budget per rail

Every schematic review (`schematic-review.md`, step 5d) carries one section that answers,
per rail: who draws from it, how much (typical and maximum), what feeds it, how much the
source can give at the hot edge of the declared range, the voltage the rail actually sits
at, and where the margin is thin. The skeleton comes from `scripts/sch.py rails`; the
numbers come from located datasheets — never from the helper, never from memory. A rail
or a consumer the helper listed that the table omits, or a current with no located source
not marked «допущение», is a defect of the review.

Adapted from Wiren Board's `wb-eda-review` (MIT, read 2026-11-12); their margins are kept
as defaults and marked as such.

## 1. Skeleton — `rails`

```sh
$PY sch.py rails <root>.kicad_sch            # rails, sources, sinks, branches, feed edges, switch nodes
$PY sch.py rails <root>.kicad_sch --md       # the three report tables, every current cell blank
$PY sch.py rails <root>.kicad_sch --rail /pwr/VDD_X   # force in a rail the heuristics missed
```

How the helper decides a net is a rail (the `[how]` tag):

| tag | rule |
|---|---|
| `power-symbol` | a `power:` library symbol sits on the net |
| `name` | the name looks like a rail after the sheet path is stripped: `+5V` / `+3V3_ISO` / `-12V` / `VCC1` / `VDD_MCU` / `AVDD` / `PVDD` / `GVDD_AB`, and exactly `VBUS` / `VIN` / `VBAT` / `VSYS`; not a name ending in a signal word (`3V3_EN` / `5V_PG` / `PWRGD` / `PWR_LED`) |
| `implicit` | a net the name rule does not take (`Net-(…)`, or a name of its own) lands on a VDD / VCC / VIN-class pin of an active part, or on a VO / VOUT / VISO pin that also carries a capacitor (a `VOx` pin with no cap is a signal output — isolator channel, op-amp — not a rail) |
| `via <ref>` | reached from a rail through a series element — polyfuse `F`, inductor `L` or ferrite `FB`, jumper `JP` or solder jumper `SJ`, diode `D` (`VIN → D1 → F1 → L1 → +12V`) |
| `user` | `--rail NET` |

Feed edges, the power tree: `regulator` (a sink pin on rail A, a source pin on rail B),
`switcher` (VIN on A, a `SW` / `LX` node, an inductor to B), `diode` (anode → cathode),
`feed` (a series element oriented from the fed side), `series` (direction unsettled —
decide by hand). `SW` / `LX` / `BOOT` nodes are listed as switch nodes, never as rails.

Per rail: sources (VO / VOUT pins), sinks (VDD / VCC / VIN pins — the consumer rows), LEDs
on the rail, resistive branches (an `R` / `RN` whose far end is neither ground nor a rail:
LED series resistors, pull-ups, sense dividers — loads to price), control pins (EN / FB /
SEL — not loads), connectors (input or load — decide from the spec's pinout), passives,
and the active pins it could not classify.

Limits: the heuristics see pin names (symbols without pin names fall back to pad numbers);
a regulator with odd pin names (`IN1` / `VBAT_IN` / `PVCC`) lands in «other active pins» —
classify it by hand from the pinout, never drop it; a resistor array is listed once per
far net; a mains-side chain (rectifier diodes, measurement dividers) shows up as rails —
keep it, the mains-side wattage belongs in the budget; the helper never invents a
current.

## 2. Pricing the rows

Define the two columns once, in one sentence each, and keep them across rails:

- **Типично** — the normal state per the spec: MCU at its real clock, transceiver
  receiving, status LED on, one channel LED on, the front-end in its normal mode;
  datasheet typical at 25 °C.
- **Максимум** — the worst credible simultaneous load inside the declared envelope:
  every LED on, transceiver transmitting into 54 Ω (or shorted — say which), all channels
  active, datasheet max, the hot edge where a part derates; what firmware can legally
  hold counts (`schematic-review.md` 5c).

Per consumer, the source in the row (document + revision + table / § / page, link):
supply-current tables for ICs; an LED branch `(V_rail − V_OH_drop − V_F) / R`; a pull-up
at the bus duty assumed; a divider `V / (R1 + R2)`; a regulator's quiescent current on
its *input* rail; an isolated DC-DC's input current from the efficiency curve at the real
load (rarely tabulated — say it is derived); an RS-485 driver `|V_OD| / R_L + I_CC` when
transmitting; a switcher's input `P_out / (η · V_in)` with η read for *this* V_in (a curve
for another V_out → η is an assumption). A number with no located source is an
assumption, marked in the row and listed under «not verified».

## 3. Per-rail summary, top of the tree down

- **Source, voltage** — the part on the feed edge and the voltage it really delivers at
  this load and input: set-point ± tolerance, minus every series drop (Schottky OR-ing
  diode, polyfuse resistance, ferrite); a module whose tolerance holds only above a
  minimum load (LS05-class «10–100 % load») — say so below it; both modes when a rail has
  two sources.
- **Load typ. / max.** — the rail's own rows plus the downstream rails it feeds (an LDO's
  input rail carries the LDO's output load + I_Q).
- **Source capability** — rated output derated to the hot edge of the declared range
  (`I_ISO` vs `T_A`, module derating curve, LDO dropout at the rail's minimum input,
  polyfuse hold when hot), with locator.
- **Margin** — the ratio source / max load, and the voltage window: the rail's minimum
  against the minimum supply of every consumer on it (a 4.5 V-min FRAM on a rail that
  dips to 4.2 V is a finding at 5× current margin). Bring in the cold / hot behaviour.

Then the input: total draw at the minimum, nominal and maximum declared input voltage;
the polyfuse hold margin at each; for a mains-fed board the wattage at nominal mains and
at the maximum the spec allows, against the declared consumption — a factor-2
disagreement is a finding (doc or design).

## 4. Dissipation and heating at the hot edge

One row per part that drops voltage at current: linear regulators `(V_in − V_out) · I`,
isolated DC-DC `P_in − P_out`, the switcher from its efficiency, OR-ing and input diodes
`V_F · I`, the polyfuse `I² · R` (self-heating lowers its hold current), mains-side
divider resistors at maximum mains, LED resistors. The junction temperature by
`analysis.md`, «A board: how hot the parts and the copper get»: a datasheet θ_JA was
measured on a JEDEC board and does not carry over — use the θ_JB / θ_JC ladder there, and
name the figure an estimate when the package-class number is all there is. Against
T_J(max) and any thermal shutdown threshold.

## 5. What becomes a finding

- A consumption table on the sheet that does not close against this independent sum
  (severity by the gap); none where a block's draw is not obvious (PWM relay coils,
  radios, isolated DC-DC) — note.
- Current margin below 1.5× at max load and the hot edge, or a source outside its
  guaranteed range (below minimum load, above derated current, an LDO in dropout at the
  minimum input) — MAJOR or MINOR by reachability inside the envelope. 1.5× is the WB
  default; the spec's own margin wins where it states one.
- The rail's minimum below a consumer's minimum supply in any declared mode — a finding
  tied to the consumer and the mode.
- Polyfuse hold margin below 2× at the minimum declared input and the hot edge (WB
  default; the spec's margin wins).
- The declared consumption and the budget disagree — reconcile, flag, never pick a side.
- Every assumption (η, V_F of an un-datasheeted LED, a module's input current) listed
  under «not verified», with the results that depend on it.

## 6. Report form

Three tables and a closing paragraph in the chat reply, columns kept as named:

**Потребители** — Потребитель · Рейка · Типично · Максимум · Источник данных
(«МК U7 GD32E230C8T6 · +3V3 · ≈6 мА (48 МГц, оценка) · 8,5 мА · GD32E230xx DS Rev 3.1,
Table 4-7, с. 51»).

**Сводка по рейкам** — Рейка · Источник, напряжение · Нагрузка тип. / макс. ·
Возможности источника · Запас, комментарий («+5V, режим B · VISO 4,75–5,25 В минус
V_F(D2) 0,4–0,55 В → ≈4,2–4,85 В · 39 / 87 мА · 130 мА при T_A ≤ 85 °C (Table 10-4,
с. 28) · 3,3× тип. / 1,5× макс.; ниже минимума FRAM 4,5 В → З-3»).

**Рассеяние и нагрев** at the hot edge, maximum load — Элемент · P, Вт · θ · T_J ·
Вердикт.

The closing paragraph names the tightest current margin, every voltage-window violation
(cross-referenced to its finding), the verdict on the sheet's own table (present / absent
/ does not close), and the assumptions the conclusion rests on.
