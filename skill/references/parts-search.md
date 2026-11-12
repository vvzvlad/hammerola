# Parts search: alternatives for a part from JLCPCB's stock

Finding candidate parts for a role — alternatives to a reference part, or parts of a
class under a price — from the stock JLCPCB assembles from, verified against datasheets,
compared pin by pin, delivered as a CSV. The source is Copperpour's local copy of the
JLCPCB parts database (`download_jlcpcb_database`, `get_jlcpcb_database_stats`,
`search_jlcpcb_parts`, `get_jlcpcb_part`, `suggest_jlcpcb_alternatives`) and, for live
stock and price without a login, JLCPCB's parts API described in the `jlcpcb-quote`
skill («Детали без входа: API библиотеки»). The method is adapted from Wiren Board's
`wb-component-search` (MIT, read 2026-11-12); their szlcsc.com category harvest is not
used — its catalogue host answers every session from here with a captcha (the decision
log in `docs/SPEC.md`).

## Hard rules

- **The datasheet is the only source of a report column.** Catalogue descriptions are
  often wrong, empty or inflated; they may only pre-rank candidates (step 4), with
  generous margins disclosed in the report.
- **Price basis:** the JLCPCB unit price as the database or the API gives it, in USD,
  with the date of the database copy (`get_jlcpcb_database_stats`) or of the API call;
  the report note names which. A part with no known price gets a blank, never a guess.
  Extended parts add a setup fee per unique part — a column, not a price adjustment.
- **Questions once, early, batched** (step 1), through `AskUserQuestion`; the question
  ends the turn (`SKILL.md`). In a non-interactive run: engineering defaults, every
  assumption listed in the report note.
- **Deliverable: a CSV**, English values, Russian notes; Chinese descriptions translated
  to English. HTML only when the owner asks (`~/.claude/CLAUDE.md`).
- **With a reference part,** the CSV carries a differences column and a pinout-match
  column (FULL / A / B / C / NONE + note); pinout verdicts come from the datasheets'
  pinout figures, never from package names.
- **Disclose the funnel:** candidate counts at every stage (found → coarse filter →
  datasheet-verified → report) and every filter applied, in the report note.
- **Work files live in the project's folder** (a `work/<slug>/` under it, with `work/` in
  the project's `.gitignore` — a commit publishes the project, and the PDFs are not part
  of it), not in `/tmp`.

## 1. Intake

Parse the request into: device class, must-have characteristics, reference part, price
cap and its basis, package constraints, build quantity (the stock floor). A quick recon
only — `search_jlcpcb_parts <MPN>` of the reference, maybe one `get_jlcpcb_part` — then
one batched round of questions, only what changes the outcome and cannot be derived:
the cap's basis (× the reference price, or absolute); package scope (same package, any
with ≥ N pins, same family; drop-in required or nice-to-have); which characteristics
are gates (must equal or exceed the reference) and which are report columns; Basic
parts only, or Extended allowed; brand policy (clones, established vendors only).
Skip the round when the request pins all of it — say so.

## 2. Reference part first

`search_jlcpcb_parts <MPN>` → its LCSC code, package, price, stock, library type;
`get_jlcpcb_part <code>` → the full record with its datasheet link. Read the reference
datasheet now: its feature set defines the comparison columns (3), its pinout page is
the baseline for step 7. Cap = reference price × the multiplier (or the absolute cap).
Not stocked by JLCPCB → datasheet from the vendor, price basis from the owner.

## 3. Candidates

Refresh the database first when its copy is older than the order horizon
(`get_jlcpcb_database_stats`, then `download_jlcpcb_database`): the copy's age is the
data's age. Then:

- `search_jlcpcb_parts` with the class words and the package (every word must match, in
  any order; a value word matches as a whole — `20pF` does not find `220pF`, and
  spellings are not converted — search `100nF` and `0.1uF` both); `category` narrows,
  `basic_only` keeps Basic parts, `in_stock` is on by default, raise `limit` well above
  the shortlist you want.
- `suggest_jlcpcb_alternatives <value> <footprint>` for the same value in the package the
  KiCad footprint uses, with `max_price_usd` as the cap and `min_stock_count` as the
  build quantity; it ranks Basic, then Preferred, then Extended, and states what it
  excluded.
- Live stock and price for the finalists through the parts API named above, when the
  database copy is older than a few days.

Coarse funnel from there: price ≤ cap with margin, stock ≥ the build quantity, package
scope, and hint-level description specs with generous margins (never cut on a spec the
description omits). Target 30–120 parts into the datasheet stage; far more → tighten
with the owner; almost none → widen and say so. Record every count.

## 4. Comparison columns

Merge what the owner named, what the reference datasheet's feature table emphasises and
the standard set an engineer asks before dropping the part in — MCU: core, MHz, flash,
SRAM, VDD range, packages, key peripherals, temperature range; buck: V_in range, V_out /
V_ref, I_out, f_sw, sync / non-sync, I_Q, enable / soft-start, feedback topology,
package and thermal pad; light sensor: spectral range, lux range, interface, address
options, supply range, dark current. 6–12 columns, each extractable from a datasheet;
the list is the extraction schema (6) and the CSV columns (8).

## 5. Datasheets

The database record's datasheet link first, then `references/datasheets.md` per part;
PDFs to `work/<slug>/pdfs/<code>.pdf`. A part with no findable datasheet drops out, or
ships marked unverified (catalogue data only) — never silently.

## 6. Extraction at scale

Fan the datasheet reading out across subagents, 8–15 parts each, PDFs read from disk
(paths in the brief, never PDF content), at the model the session runs its agents on.
Each returns strict JSON, one record per MPN: the step-4 keys with units (numeric fields
split into min / max, no ranges), `desc_en` (one line, translated, no marketing),
`confidence` high / med / low, `notes` (mismatches against the catalogue claim, family
caveats, the page or table a contested value came from). Rules in the brief: first
confirm the PDF documents this MPN (title page or ordering table names the part or its
family — catalogues serve sibling documents, an «LM2576HV» listing shipping the non-HV
LM2576; a mismatch is `ds_mismatch` in notes, not extracted from); read the feature
summary and the family / ordering table; match the exact suffix; a value the datasheet
does not state is `null`, never guessed, never copied from the catalogue; a scanned PDF
is said so with confidence low. Reading order: text layer (`pdftotext -layout`,
pymupdf) → OCR (`tesseract eng+chi_sim`) → render the page (`get_pixmap(dpi=200)`) and
read with vision — figures, pinouts and merged-cell tables scramble in text extraction.
A suffix missing from the family table: fetch the latest revision, or decode the
ordering code from its «Ordering Information» section and note the decode. Merge the
waves into `work/<slug>/extracted.json`, keyed by LCSC code.

## 7. Verify, then compare pinouts

- **Verification, briefed to refute:** for every part that will ship, an independent
  agent re-opens the PDF and looks for where the datasheet contradicts the extracted
  gates and price-making specs; confirm / correct (log old → new) / reject (log why).
  Expect rejections: flash or SRAM half the claimed value, «flash» that is a stacked SiP
  die, peripherals the catalogue promised, a wrong pin count, a 16-bit core sold as
  24-bit. `confidence` reflects this pass.
- **Pinout comparison** (reference runs): same-package candidates pin by pin against
  the reference's pinout figure, both pages rendered to PNG and read with vision (a
  package missing from an old PDF may exist in the latest revision). FULL — every pin
  matches, VDD / VSS / NRST / BOOT / OSC included; A — drop-in but for trivial naming or
  secondary-function differences; B — signals match but power or ground pins moved, or
  several signals moved → board rework («looks compatible» with VDD / VSS elsewhere is
  B, never FULL); C — partial with a debug-pin (SWCLK / SWDIO) caveat; NONE —
  incompatible; `n/a` — another package, named. The exact differing pins go into the
  note. Two independent reads before FULL: a FULL verdict is a soldering decision.

## 8. The CSV

Columns = identity (`lcsc`, `mpn`, brand, package, stock, library type Basic /
Preferred / Extended) + `price_usd` + the step-4 columns + with a reference `diff`
(differences in short English phrases) and `pinout_match` with its note +
`confidence`; `reference` = the reference's own row. The note — funnel, filters, price
basis and date, assumptions, the QA line — is not a CSV column: it goes into the
hand-over reply beside the CSV's path. Brand names in the vendor's Latin trade name
(兆易创新 → GigaDevice); no established name → romanized, Chinese in parentheses.
Identifiers verbatim everywhere.

## 9. Adversarial QA before hand-over

- **Cell spot-audit:** 5–10 rows — every row a purchase decision leans on (the cheapest
  finalists, every FULL / A verdict) plus 2–3 random — 2–3 cells each, re-derived from
  the datasheet from scratch by a fresh agent, not from the extraction notes. One
  mismatch → fix the row and widen the sample; the same column or vendor wrong twice →
  re-extract that whole column or vendor.
- **Consistency, scripted:** no column entirely empty (drop it or explain); no CJK left
  (`grep -P '[\x{4e00}-\x{9fff}]'` over the CSV); `diff` and `pinout_match` do not
  contradict the spec columns of their row; the funnel numbers in the note match the
  counts.
- **Price and stock sanity:** re-check 3–5 finalists live (`get_jlcpcb_part` after a
  database refresh, or the parts API) against the CSV, the reference too — a stale
  copy, a ladder slip.

The note records what QA sampled, caught and fixed («QA: проверено N ячеек,
исправлено M; цены и наличие выборочно сверены»); an audit nobody can see did not
happen.

## Pitfalls

- Package strings are loose: a bare `QFP-48` may be LQFP-48 — unify by the datasheet's
  package table; `suggest_jlcpcb_alternatives` refuses a library footprint with no
  known LCSC package — give it LCSC's package name instead.
- Same-looking names from different vendors are different parts (CS32F103 Chipsea ≠
  CKS32F103 中科芯, different pinouts): key by LCSC code + brand, never merge by name.
- Clone vendors inflate specs and omit blocks; «pin-compatible with X» still needs its
  own datasheet check.
- A cached PDF can be stale or mismatched: PDFs are named by LCSC code; check the title
  before trusting a cached file.
