# Parts search: alternatives for a part, a whole category at a price cap

Finding candidate parts for a role — alternatives to a reference part, or everything in a
category under a price — from szlcsc.com (LCSC's domestic catalogue, the stock JLCPCB
assembles from), verified against datasheets, compared pin by pin, delivered as a CSV.
The helper is `scripts/parts.py` (`tree`, `search`, `overseas`, `params`, `harvest`,
`detail`, `datasheet`, `rate`, `report`); it passes the site's anti-bot itself. Adapted
from Wiren Board's `wb-component-search` (MIT, read 2026-11-12). The owner chose this
source over the JLCPCB keyword API, knowing a category harvest is thousands of anonymous
requests.

## Hard rules

- **The datasheet is the only source of a report column.** Catalogue specs and
  descriptions are often wrong, empty or inflated; they may only pre-rank candidates
  (step 5), with generous margins disclosed in the report.
- **Price basis:** the szlcsc CNY ladder price at 1000 pcs, converted to USD at a stated
  live rate (`rate`; the report note names the rate and the date). For an `overseas`
  offer, the step for 1000 pcs or for the whole lot when the lot is smaller. A part the
  site does not stock or price gets a blank price, never a guess; international LCSC USD
  prices (with markup) are not substituted.
- **Questions once, early, batched** (step 1), through `AskUserQuestion`; the question
  ends the turn (`SKILL.md`). No multi-hour harvest on guessed requirements. In a
  non-interactive run: engineering defaults, every assumption listed in the report note.
- **Deliverable: a CSV** (`parts.py report --csv`), English values, Russian notes;
  Chinese descriptions and spec values translated to English. HTML only when the owner
  asks (`~/.claude/CLAUDE.md`).
- **With a reference part,** the CSV carries a differences column and a pinout-match
  column (FULL / A / B / C / NONE + note); pinout verdicts come from the datasheets'
  pinout figures, never from package names.
- **Disclose the funnel:** candidate counts at every stage (harvested → coarse filter →
  datasheet-verified → report) and every filter applied, in the report note.
- **Work files live in the project's folder** (a `work/<slug>/` under it, with `work/` in
  the project's `.gitignore` — a commit publishes the project, and the dump and the PDFs are
  not part of it), not in `/tmp`.

## 1. Intake

Parse the request into: device class, must-have characteristics, reference part, price
cap and its basis, package constraints. A quick recon only — `search <MPN>` of the
reference (its category, own price), maybe one `detail` — then one batched round of
questions, only what changes the outcome and cannot be derived: the cap's basis
(× the reference price, or absolute $/1k; on the 1000-pc price, or another quantity);
package scope (same package, any with ≥ N pins, same family; drop-in required or
nice-to-have); which characteristics are gates (must equal or exceed the reference) and
which are report columns; brand policy (clones, established vendors only, minimum
stock); temperature grade where the class makes it matter. Skip the round when the
request pins all of it — say so.

## 2. Reference part first

`search <MPN>` → its C-code, catalogue id, domestic 1k CNY price; `detail <CODE> --json`
→ description, spec hints, its datasheet; `datasheet <CODE>` → the PDF. Read the reference
datasheet now: its feature set defines the comparison columns (4), its pinout page is the
baseline for step 8. Cap = reference 1k USD price × the multiplier (or the absolute cap).
Not stocked there → datasheet from the vendor, price basis from the owner. Own stock 0 is
not «no offers»: run `overseas <MPN>` before calling a part unavailable — the site resells
Future, DigiKey, Mouser, Arrow with their own stock, MOQ and a 10–20 working-day lead.

## 3. Category and harvest

`tree --grep <word>` finds the category leaves; take the neighbours too (`QFN MCU` beside
`LQFP MCU`). `harvest <ids…> --out work/<slug>/dump --max-usd-1k <cap × 1.3>` (`--out` is a
prefix: `dump.jsonl`, `dump.csv`, `dump.state.json`) dumps the leaves with a margin above
the cap (the server cuts by the unit price × 2.2); a
query is capped at 1500 rows and `totalCount` reads 10000 for anything above it, so a
big leaf is sliced and the run resumes from its `.state.json`. One process, polite delay,
no parallel harvests.

## 4. Comparison columns

Merge what the owner named, what the reference datasheet's feature table emphasises and
the standard set an engineer asks before dropping the part in — MCU: core, MHz, flash,
SRAM, VDD range, packages, key peripherals, temperature range; buck: V_in range, V_out /
V_ref, I_out, f_sw, sync / non-sync, I_Q, enable / soft-start, feedback topology,
package and thermal pad; light sensor: spectral range, lux range, interface, address
options, supply range, dark current. 6–12 columns, each extractable from a datasheet;
the list is the extraction schema (7) and the CSV columns (9).

## 5. Coarse funnel

From the dump to a shortlist you can afford to verify: price ≤ cap with margin, stock ≥
the owner's floor (enforce it here — the server-side filter lets `stock: 0` rows
through), package scope, and hint-level catalogue specs with generous margins («claims ≥
half the flash floor»; catalogue flash is often wrong, RAM is ~99 % empty; never cut on
a spec the catalogue omits). Target 30–120 parts into the datasheet stage; far more →
tighten with the owner; almost none → widen and say so. Record every count.

## 6. Datasheets

`datasheet --codes-file work/<slug>/codes.json -d work/<slug>/pdfs` downloads
`<CODE>.pdf` through the detail API, `%PDF`-checked, resumable. The failed tail goes
through `references/datasheets.md` per part. A part with no findable datasheet drops
out, or ships marked unverified (catalogue data only) — never silently.

## 7. Extraction at scale

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
waves into `work/<slug>/extracted.json`, keyed by C-code.

## 8. Verify, then compare pinouts

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

## 9. The CSV

`work/<slug>/report.json` for `parts.py report --csv <slug>.csv`: columns = identity
(`mpn`, brand, package, stock) + `price_usd_1k` + the step-4 columns + with a reference
`diff` (differences in short English phrases) and `pinout_match` with its note +
`confidence`; `reference` = the reference's own row. The note — funnel, filters, rate,
date, assumptions, the QA line — is not a CSV column: it goes into the hand-over reply
beside the CSV's path. Brand names in the vendor's Latin trade name (兆易创新 →
GigaDevice); no established name → romanized, Chinese in parentheses. Identifiers
verbatim everywhere.

## 10. Adversarial QA before hand-over

- **Cell spot-audit:** 5–10 rows — every row a purchase decision leans on (the cheapest
  finalists, every FULL / A verdict) plus 2–3 random — 2–3 cells each, re-derived from
  the datasheet from scratch by a fresh agent, not from the extraction notes. One
  mismatch → fix the row and widen the sample; the same column or vendor wrong twice →
  re-extract that whole column or vendor.
- **Consistency, scripted:** no column entirely empty (drop it or explain); no CJK left
  (`grep -P '[\x{4e00}-\x{9fff}]'` over the CSV); `diff` and `pinout_match` do not
  contradict the spec columns of their row; the funnel numbers in the note match the
  counts.
- **Price sanity:** re-fetch 3–5 finalists live (`search` / `detail`) against
  `price_usd_1k`, the reference's price too — stale harvests, ladder-parse slips, rate
  typos.
- **Links:** every row has a product URL; probe a sample (status < 400; item pages answer
  200 behind the anti-bot challenge).

The note records what QA sampled, caught and fixed («QA: проверено N ячеек, исправлено
M; ссылки и цены выборочно сверены»); an audit nobody can see did not happen.

## Pitfalls

- Package strings are loose: a bare `QFP-48` may be LQFP-48 — unify by the datasheet's
  package table.
- Same-looking names from different vendors are different parts (CS32F103 Chipsea ≠
  CKS32F103 中科芯, different pinouts): key by C-code + brand, never merge by name.
- Clone vendors inflate specs and omit blocks; «pin-compatible with X» still needs its
  own datasheet check.
- Categories contain leak-ins (pneumatic switches under «current monitors»).
- A cached PDF can be stale or mismatched: PDFs are named by C-code; check the title
  before trusting a cached file.
- The anti-bot cookies (the RC4 one, and Aliyun WAF's `acw_sc__v2` on www.szlcsc.com) live
  minutes; the script re-solves them, a hand-rolled curl does not. A captcha is not
  solved: list.szlcsc.com (the host of `params`, `harvest` and the datasheet links) answers
  some requests with a Tencent captcha page (`TencentCaptcha`, `/WafCaptcha`) instead of the
  content; the script exits on it at once, and the owner's rule holds — stop at the first
  captcha and tell him, no retry from another address or session.
