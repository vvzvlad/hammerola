// The bill of materials of a KiCad design: a member of the design the page adds
// itself, beside the schematic, board and 3D model the hub publishes. Every
// schematic a build lists is followed in its `documents` by its BOM, put there
// as meta.json comes in (`loadMeta` in hub.js), so both pages, the list of views
// and the address know it as a document like any other. It is under the
// schematic's own file, so it is one design with it (`designKey` in
// KicadView.jsx) and drawn by the same KicadView, whose schematic's element
// computes the rows (`getBomItems`, static/_v/PROVENANCE.md, "Our edits"): a
// row per footprint, value and DNP, put in KiCad's order here (`bomRows`).
// The hub knows nothing of it: it has no rename, no comments and no file of
// its own.
//
// THE TABLE (BomView.jsx) is drawn from the PARTS, those rows split one per
// designator (`bomParts`): the search and the filters keep some of them
// (`filterParts`), the parts kept are put back into a row per footprint, value
// and DNP where the reader groups them (`groupParts`), and the rows are sorted
// by a column (`sortRows`), all in `bomTable`. So a group a filter cuts lists
// the designators kept, and its Qty counts them. A part's type is the letters
// its designator starts with (`partType`), its package what its footprint's
// name says of it (`partPackage`), and a value sorts by its magnitude where it
// has one (`valueMagnitude`).

/** The type of a BOM's document. */
export const BOM_TYPE = 'bom';

/** The BOM of the schematic `doc`: its id with `~bom` after it, its name with
 *  ` · BOM`, its file, size and `kicad`, and hidden with it. */
const bomOf = (doc) => ({
  id: `${doc.id}~bom`, type: BOM_TYPE, name: `${doc.name} · BOM`, file: doc.file, bytes: doc.bytes,
  kicad: doc.kicad, ...(doc.hidden ? { hidden: true } : {}),
});

/** `documents` as meta.json lists them, each schematic followed by its BOM. */
export const withBoms = (documents) => documents.flatMap((doc) => (doc.type === 'schematic'
  ? [doc, bomOf(doc)] : [doc]));

/** A designator's three parts, as KiCad splits one to sort it: the text before
 *  its last number, the number, and what follows (`U1A`: `U`, 1, `A`); one with
 *  no number is all prefix (`TP`). */
function refParts(ref) {
  const [, prefix, number, rest] = /^(.*?)(\d+)(\D*)$/.exec(ref) || [null, ref, '', ''];
  return [prefix.toLowerCase(), Number(number), rest.toLowerCase()];
}

/** Two designators in KiCad's order: the prefix alphabetically, ignoring case,
 *  then the number by its value (R2 before R10), then what follows it. */
export function compareRefs(a, b) {
  const [one, two] = [refParts(a), refParts(b)];
  for (let i = 0; i < 3; i += 1) {
    if (one[i] < two[i]) return -1;
    if (one[i] > two[i]) return 1;
  }
  return 0;
}

/** The rows of `getBomItems` as the table lists them: each row's designators
 *  in KiCad's order, and the rows in the order of their first designator. */
export const bomRows = (items) => items.map((item) => ({ ...item, references: [...item.references].sort(compareRefs) }))
  .sort((a, b) => compareRefs(a.references[0], b.references[0]));

const NATURAL = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Two texts in natural order: a run of digits by its value (`SOT-23` before
 *  `SOT-223`), case ignored. */
export const compareNatural = (a, b) => NATURAL.compare(a, b);

/** A part's type: the letters its designator starts with (`J_CAN1`: `J`,
 *  `LED1`: `LED`). */
export const partType = (ref) => (/^[A-Za-z]+/.exec(ref) || [''])[0];

/** The families of package a footprint's name starts with, after a category
 *  of one or two letters where it has one (`D_SMA`). */
const FAMILIES = ['SOT', 'SOD', 'SOIC', 'SO', 'SOP', 'TSOP', 'TSSOP', 'HTSSOP', 'SSOP', 'MSOP', 'VSSOP', 'QFN', 'DFN',
  'VQFN', 'WQFN', 'UQFN', 'HVQFN', 'LQFP', 'TQFP', 'QFP', 'BGA', 'WSON', 'SON', 'TSOT', 'SC', 'DIP', 'TO', 'SMA',
  'SMB', 'SMC', 'EIA', 'DPAK', 'D2PAK', 'MELF', 'LGA'];
/** KiCad's chip footprints, `C_0603_1608Metric`: the imperial size. */
const CHIP = /^[A-Za-z]+_(\d{4,5})_\d{4,5}Metric(?:_|$)/;
/** A family not followed by another letter (`SOIC-8` is no `SO`), up to the
 *  next `_`. */
const FAMILY = new RegExp(`^(?:[A-Za-z]{1,2}_)?((?:${FAMILIES.join('|')})(?![A-Za-z])[^_]*)`);

/** A part's package, from its footprint without the library (`lib:`): a chip's
 *  size (`0603`), else the family and what follows it up to the next `_`
 *  (`SOT-223-3`, `TSSOP-24`, `SMA`), else the whole name. */
export function partPackage(footprint) {
  const name = footprint.slice(footprint.indexOf(':') + 1);
  const found = CHIP.exec(name) || FAMILY.exec(name);
  return found ? found[1] : name;
}

/** The prefixes a value is scaled by; `R` is the ohm's place in `2R2`. `µ`
 *  is spelled two ways, the micro sign and the Greek letter, and `K` is
 *  written for `k` as often. */
const SCALE = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, R: 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };
/** The value's leading token: a number with a prefix where the decimal point
 *  stands (`4k7`, `2R2`), or a number and a prefix (`100n`, `100R`), then the
 *  unit's letters (`uF`), ending where the token does. */
const VALUE = /^(?:(\d+)([pnuµμmRkKMG])(\d+)|(\d+(?:\.\d+)?)([pnuµμmRkKMG]?))[A-Za-zΩ]*(?![\dA-Za-z.])/;

/** The magnitude of a part's value (`4k7`: 4700, `100nF 25V X7R`: 1e-7), or
 *  null where its leading token is no number (`NE555`, `1N4148`). */
export function valueMagnitude(value) {
  const found = VALUE.exec(value);
  if (!found) return null;
  const [, whole, point, fraction, number, prefix] = found;
  return whole ? Number(`${whole}.${fraction}`) * SCALE[point] : Number(number) * (prefix ? SCALE[prefix] : 1);
}

/** Two values by magnitude, those with none after, in natural order. */
export function compareValues(a, b) {
  const [one, two] = [valueMagnitude(a), valueMagnitude(b)];
  if (one !== null && two !== null && one !== two) return one < two ? -1 : 1;
  if ((one === null) !== (two === null)) return one === null ? 1 : -1;
  return compareNatural(a, b);
}

/** The parts of the rows `items`: one per designator, as a row of one, with
 *  its row's value, footprint and DNP and the datasheet `datasheet(ref)` gives
 *  it (`{ value, text, … }` or null). */
export const bomParts = (items, datasheet) => items.flatMap((item) => item.references.map((ref) => ({
  references: [ref], value: item.value, footprint: item.footprint, dnp: item.dnp, qty: 1, datasheet: datasheet(ref),
})));

const typeOf = (part) => partType(part.references[0]);
const packageOf = (part) => partPackage(part.footprint);

/** The chips of a filter over every part: each name `nameOf` gives a part,
 *  with how many parts have it, in natural order. */
function chips(parts, nameOf) {
  const counts = new Map();
  for (const part of parts) counts.set(nameOf(part), (counts.get(nameOf(part)) || 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => compareNatural(a.name, b.name));
}

/** The type filter's chips (`partType`) and the package filter's
 *  (`partPackage`), with their parts' counts. */
export const typeChips = (parts) => chips(parts, typeOf);
export const packageChips = (parts) => chips(parts, packageOf);

/** The DNP switch's three ways: every part, those fitted, those not. */
export const DNP_WAYS = ['all', 'without', 'only'];

/** The parts the reader's search and filters keep: the search, a text found
 *  in the designator, value, footprint, or datasheet value or the text its
 *  cell shows (a document's name), ignoring case;
 *  each filter's chips, any of them; the DNP switch. All of them at once. */
export function filterParts(parts, { query, types, packages, dnp }) {
  const text = query.trim().toLowerCase();
  return parts.filter((part) => (!types.length || types.includes(typeOf(part)))
    && (!packages.length || packages.includes(packageOf(part)))
    && (dnp === 'all' || part.dnp === (dnp === 'only'))
    && (!text || [part.references[0], part.value, part.footprint,
      part.datasheet ? `${part.datasheet.value} ${part.datasheet.text}` : '']
      .some((one) => one.toLowerCase().includes(text))));
}

/** `parts` put into a row per footprint, value and DNP, as the viewer groups
 *  them: the designators in KiCad's order, counted as its Qty, and the
 *  datasheet of the first. */
export function groupParts(parts) {
  const groups = new Map();
  for (const part of parts) {
    const key = JSON.stringify([part.footprint, part.value, part.dnp]);
    groups.set(key, [...(groups.get(key) || []), part]);
  }
  return [...groups.values()].map((group) => {
    const sorted = [...group].sort((a, b) => compareRefs(a.references[0], b.references[0]));
    return { ...sorted[0], references: sorted.map((part) => part.references[0]), qty: sorted.length };
  });
}

const dnpText = (row) => (row.dnp ? 'DNP' : '');
const sheetText = (row) => (row.datasheet ? row.datasheet.text : '');

/** The table's columns, kicad-cli's default (`sch export bom`) and the
 *  datasheet, each with the order a click on its head sorts the rows in. */
const ORDERS = {
  Refs: (a, b) => compareRefs(a.references[0], b.references[0]),
  Value: (a, b) => compareValues(a.value, b.value),
  Footprint: (a, b) => compareNatural(a.footprint, b.footprint),
  Qty: (a, b) => a.qty - b.qty,
  DNP: (a, b) => compareNatural(dnpText(a), dnpText(b)),
  Datasheet: (a, b) => compareNatural(sheetText(a), sheetText(b)),
};
export const BOM_COLUMNS = Object.keys(ORDERS);

/** The order the table opens in: by designator, as KiCad lists them. */
export const BOM_SORT = { column: 'Refs', descending: false };

/** The order after a click on the head of `column`: that column ascending,
 *  and a second click on it descending. */
export const nextSort = (sort, column) => ({ column, descending: sort.column === column && !sort.descending });

/** `rows` sorted by `sort`'s column, rows it puts level in KiCad's order. */
export function sortRows(rows, { column, descending }) {
  const order = ORDERS[column];
  return [...rows].sort((a, b) => (descending ? order(b, a) : order(a, b)) || ORDERS.Refs(a, b));
}

/** The rows the table draws for `parts` as the reader set it (`view`: the
 *  search, the filters, `grouped`, `sort`): a row per part, or per group of
 *  them. */
export function bomTable(parts, view) {
  const kept = filterParts(parts, view);
  return sortRows(view.grouped ? groupParts(kept) : kept, view.sort);
}
