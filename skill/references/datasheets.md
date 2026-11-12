# Datasheets: finding the document and citing a number from it

Every rating a finding or a budget rests on — abs-max, supply range, pin level, clamp,
coil or contact rating — comes from a located datasheet, cited at the claim. This is how
to locate it, read it and return the numbers. Adapted from Wiren Board's
`wb-datasheet-finder` (MIT, read 2026-11-12); their corporate Drive step is left out.

## Hard rules

- **A number ships only with a located source, or not at all.** Inline, every extracted
  value carries the document (name + revision or date), a direct URL and the exact place
  (table / section / figure / page). No datasheet located → say so, «даташит на <part> не
  найден», and return the limit as unknown. Never infer an abs-max or a supply range «by
  analogy with similar parts» and present it as fact: a plausible but wrong abs-max turns
  a healthy rail into a false critical. Reasoning by analogy is labelled an assumption,
  and any severity downstream is capped at «проверить» (`schematic-review.md`).
- **Manufacturer's site first, latest revision.** Distributor mirrors (lcsc, alldatasheet)
  and the PDFs already published with the project (`boards.md`, the `Datasheet` field)
  are caches: good for locating a PDF fast, but the manufacturer's newest revision is the
  citation of record, and the revision actually used is always recorded.
- **No browser.** Search and fetch through the research tools and `curl`; a site behind a
  login or a captcha is the owner's browser (curator) only when he says so.

## Inputs

A full part number (`RS8411XF`, `G5LE-1A`, `S14K275`, `0ZCJ0050`); a manufacturer and
family («Runic RS841X op-amp»); a cryptic SMD top-marking (`A1SHB`, `1AM`, `J3Y`) that is
not the orderable part number — decode first (step 3); a refdes + value from the
schematic («U7 = RS8411, powered from +9.6 V») — resolve the value to a part number, then
verify the rail against the located limits.

## 1. Locate

Start with one search, `<part> datasheet`; the manufacturer's PDF is usually the first
hit. When the results are noisy, refine the query — the names below are search filters,
not sites to browse:

1. Scope to the manufacturer: `<part> datasheet site:<vendor>.com`. The manufacturer's
   own site wins over any distributor copy, even one that ranks higher.
2. Distributor fallback, for obscure or Chinese parts the manufacturer query misses:
   `site:lcsc.com`, `site:alldatasheet.com`, szlcsc, chipdip, datasheetspdf, octopart.
   «Fallback» orders the preference, not the search: before reporting «not found», the
   distributor tier has been tried.
3. Family rollup: when the exact part number has no document, search the family stem
   (`RS8411XF` → `RS841X`); the variant is in the family document's ordering table. This
   fixes most «obscure part» misses.

Pick the latest revision: compare the revision / date stamps on the cover or in the
footer («Rev. C, 2023») and take the newest — normally the manufacturer's. A distributor
copy is cross-checked against the manufacturer's product page when reachable, and the
revision used goes into the citation. Still nothing → «not found»; a house or custom part
may have no public datasheet — say so.

## 2. Read the PDF and pull the envelope

Fetching the PDF: `curl -fsSL -A "Mozilla/5.0" "<url>" -o <scratchpad>/ds-<part>.pdf` (some
vendor sites refuse a bare curl); `head -c4` must print `%PDF` — an HTML viewer page means
find the direct link. Then `pdftotext -layout <pdf> - | grep -niA3 'absolute max\|supply
voltage\|operating\|recommended\|rating\|junction\|coil voltage\|clamping\|breakdown'`
(`-layout` keeps the rating columns aligned). Empty or garbled output means a scanned
document (older Chinese parts): read the PDF with the Read tool by page range, abs-max
and electrical characteristics first. Never `pip install` into the system Python.

What to pull, by class:

| Class | Numbers |
|---|---|
| op-amp, linear IC | supply range min/max, abs-max supply, input common-mode range, output current, GBW, temperature range |
| MCU, logic IC | VDD range, abs-max VDD, pin abs-max (VIH / VIL, injection), I/O current, temperature range |
| regulator, driver | V_in range, abs-max V_in, I_out, switch voltage / current, θ (`analysis.md`), T_J |
| MOSFET, BJT | V_DS / V_CE abs-max, V_GS, I_D / I_C, R_DS(on), P_tot, SOA |
| diode, TVS, Zener | V_RRM / V_BR / V_clamp, I_F / I_PPM, V_F |
| varistor | V_rms / V_dc, clamping voltage, energy, peak current |
| fuse, polyfuse | I_hold / I_trip, V_max, time–current curve |
| relay | coil voltage and resistance, contact rating (V / A, AC / DC), switching limits |
| optocoupler | CTR, V_F, isolation voltage, BV_CEO |
| connector | current and voltage rating, contact count, mating cycles |

For each value capture the table or section name and the page, so the citation is exact.

## 3. Decode an SMD marking

Only when the input is a top-mark, not a part number: search `<mark> SMD marking code`
and `<mark> transistor|diode|mosfet marking`; marking databases s-manuals.com,
smps.us/smd-codes, datasheetspdf, lcsc (the product page often lists the top-mark).
Cross-check against the package: a SOT-23 `1AM` is an MMBT3904, the same mark on another
package is another part. Several candidates → list them with packages and say which fits
the context; never pick silently. Decoded → step 1.

## 4. Return

Per part, labels and values verbatim, surrounding prose in the review's language:

```
<PART> (<manufacturer>)
  datasheet: <doc name>, rev <X>, <URL>
  package:   <pkg>
  <limit>:   <value>   — <table/section>, p.<N>
  notes:     <variant / family caveats; assumptions marked>
```

Not found:

```
<PART>: даташит не найден (искал: <manufacturer site>, lcsc, alldatasheet, <…>).
  Лимиты — НЕИЗВЕСТНЫ. Серьёзность по этой детали не выше «проверить».
```

## When to ask the owner

- The datasheet is behind a registration wall (some relay and connector vendors): ask
  whether he has the PDF, instead of scraping around the wall.
- A marking decodes to several plausible parts and the schematic does not settle it.
- The part looks like a house or custom part with no public document.
- Two revisions disagree on the limit the finding rests on: show both, ask which the
  board was designed against.
