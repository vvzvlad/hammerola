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
// designator (`bomParts`): the search and the filters of the columns keep some
// of them (`filterParts`), the parts kept are put back into a row per
// footprint, value and DNP where the reader groups them (`groupParts`), the
// Qty and Sum filters keep some of those rows, and the rows are sorted by a
// column (`sortRows`), all in `bomTable`. So a group a filter cuts lists the
// designators kept, its Qty counts them and its Sum adds up their prices.
//
// A COLUMN'S FILTER is the values its entries name (`bomFilters`) that the
// reader unchecked (`excluded`): every entry checked is no filter. Refs
// filters by the part's type, the letters its designator starts with
// (`partType`); Footprint by its package, what its footprint's name says of it
// (`partPackage`); Value, DNP, Datasheet and Price by what the cell shows, an
// empty cell an entry of its own (''); Qty and Sum by the row's, after the
// grouping. A value sorts by its magnitude where it has one (`valueMagnitude`).
//
// THE PRICE is the part's `Price` field as written (kicadsheets.js), per
// piece; what it adds up to is the first number in it (`priceOf`), in no
// currency. A row's Sum is the sum of its parts' prices, so a group whose parts
// differ in price still sums right; Price and Sum sort by the number, and the
// total under the table is the Sum of the fitted rows shown (`bomTotal`).

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

/** Two numbers, a null after any number; 0 for two level. */
function compareNumbers(one, two) {
  if (one !== null && two !== null && one !== two) return one < two ? -1 : 1;
  if ((one === null) !== (two === null)) return one === null ? 1 : -1;
  return 0;
}

/** Two values by magnitude, those with none after, in natural order. */
export const compareValues = (a, b) => compareNumbers(valueMagnitude(a), valueMagnitude(b)) || compareNatural(a, b);

/** A price's number: digits, the spaces between them dropped (`1 200`; `\s`
 *  takes the no-break and thin ones too), and a fraction after a point or a
 *  comma. */
const PRICE = /\d+(?:\s+\d+)*(?:[.,]\d+)?/;

/** The number a `Price` field's text says, the first in it (`1 200,50 ₽`:
 *  1200.5, `$0.20`: 0.2), a comma read as the decimal point; null where it
 *  has none. The currency is not read. */
export function priceOf(text) {
  const found = PRICE.exec(text);
  return found ? Number(found[0].replace(/\s/g, '').replace(',', '.')) : null;
}

/** Two prices' texts by their number, those with none after, in natural
 *  order. */
const comparePrices = (a, b) => compareNumbers(priceOf(a), priceOf(b)) || compareNatural(a, b);

/** An amount as the table writes it: rounded to four decimals, no trailing
 *  zeros (0.012, 120, 12.3457). */
export const amountText = (amount) => String(Number(amount.toFixed(4)));

/** The parts of the rows `items`: one per designator, as a row of one, with
 *  its row's value, footprint and DNP, the datasheet `datasheet(ref)` gives it
 *  (`{ value, text, … }` or null), and the `Price` value `price(ref)` gives it
 *  (a text or nothing) as `price`, its number as `sum` (or null), and
 *  `unpriced`, 1 where it has no number. */
export const bomParts = (items, datasheet, price) => items.flatMap((item) => item.references.map((ref) => {
  const text = price(ref) || '';
  const sum = priceOf(text);
  return {
    references: [ref], value: item.value, footprint: item.footprint, dnp: item.dnp, qty: 1, datasheet: datasheet(ref),
    price: text, sum, unpriced: sum === null ? 1 : 0,
  };
}));

const dnpText = (row) => (row.dnp ? 'DNP' : '');
const sheetText = (row) => (row.datasheet ? row.datasheet.text : '');

/** The Sum cell of `row`: its sum as the table writes it, empty for none. */
export const sumText = (row) => (row.sum === null ? '' : amountText(row.sum));

/** What each column's filter reads of a part: its type, its value, its
 *  package, its DNP, its datasheet and its price as the cells show them. Qty
 *  and Sum are a row's. */
const PART_KEYS = {
  Refs: (part) => partType(part.references[0]),
  Value: (part) => part.value,
  Footprint: (part) => partPackage(part.footprint),
  DNP: dnpText,
  Datasheet: sheetText,
  Price: (part) => part.price,
};

/** The parts the reader's search and the columns' filters keep: the search, a
 *  text found in the designator, value, footprint, or datasheet value or the
 *  text its cell shows (a document's name), ignoring case; each column's
 *  filter, a value it has not unchecked (`excluded`). All of them at once. */
export function filterParts(parts, { query, excluded }) {
  const text = query.trim().toLowerCase();
  return parts.filter((part) => Object.entries(PART_KEYS).every(([column, keyOf]) => !excluded[column].includes(keyOf(part)))
    && (!text || [part.references[0], part.value, part.footprint,
      part.datasheet ? `${part.datasheet.value} ${part.datasheet.text}` : '']
      .some((one) => one.toLowerCase().includes(text))));
}

/** `parts` put into a row per footprint, value and DNP, as the viewer groups
 *  them: the designators in KiCad's order, counted as its Qty, the datasheet
 *  of the first, the `Price` text of the first that has one, the sum of the
 *  prices of those that have one (null where none has) and the count of those
 *  that have none. */
export function groupParts(parts) {
  const groups = new Map();
  for (const part of parts) {
    const key = JSON.stringify([part.footprint, part.value, part.dnp]);
    groups.set(key, [...(groups.get(key) || []), part]);
  }
  return [...groups.values()].map((group) => {
    const sorted = [...group].sort((a, b) => compareRefs(a.references[0], b.references[0]));
    const priced = sorted.filter((part) => part.sum !== null);
    return {
      ...sorted[0], references: sorted.map((part) => part.references[0]), qty: sorted.length,
      price: (sorted.find((part) => part.price) || sorted[0]).price,
      sum: priced.length ? priced.reduce((sum, part) => sum + part.sum, 0) : null,
      unpriced: sorted.length - priced.length,
    };
  });
}

/** The table's columns, kicad-cli's default (`sch export bom`), the datasheet,
 *  the price and the sum, each with the order a click on its head sorts the
 *  rows in. */
const ORDERS = {
  Refs: (a, b) => compareRefs(a.references[0], b.references[0]),
  Value: (a, b) => compareValues(a.value, b.value),
  Footprint: (a, b) => compareNatural(a.footprint, b.footprint),
  Qty: (a, b) => a.qty - b.qty,
  DNP: (a, b) => compareNatural(dnpText(a), dnpText(b)),
  Datasheet: (a, b) => compareNatural(sheetText(a), sheetText(b)),
  Price: (a, b) => comparePrices(a.price, b.price),
  Sum: (a, b) => compareNumbers(a.sum, b.sum),
};
export const BOM_COLUMNS = Object.keys(ORDERS);

/** No column filtered: no value of any unchecked. */
export const NO_FILTER = Object.fromEntries(BOM_COLUMNS.map((column) => [column, []]));

/** Each value `keyOf` gives one of `list`, with how many of them have it, in
 *  the order `order` puts the values in. */
function entries(list, keyOf, order) {
  const counts = new Map();
  for (const one of list) counts.set(keyOf(one), (counts.get(keyOf(one)) || 0) + 1);
  return [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => order(a.key, b.key));
}

/** The entries of each column's filter over the whole BOM, `{ key, count }`
 *  in the column's own order: the values its filter reads of the parts, each
 *  with its parts' count, and for Qty and Sum the rows' Qty and Sum cell,
 *  grouped as the reader has them, each with its rows' count. */
export function bomFilters(parts, grouped) {
  const rows = grouped ? groupParts(parts) : parts;
  return {
    Refs: entries(parts, PART_KEYS.Refs, compareNatural),
    Value: entries(parts, PART_KEYS.Value, compareValues),
    Footprint: entries(parts, PART_KEYS.Footprint, compareNatural),
    Qty: entries(rows, (row) => row.qty, (a, b) => a - b),
    DNP: entries(parts, PART_KEYS.DNP, compareNatural),
    Datasheet: entries(parts, PART_KEYS.Datasheet, compareNatural),
    Price: entries(parts, PART_KEYS.Price, comparePrices),
    Sum: entries(rows, sumText, comparePrices),
  };
}

/** `list` of entries by their value, as given, or by their count, the
 *  greatest first. */
export const entryOrder = (list, byCount) => (byCount ? [...list].sort((a, b) => b.count - a.count) : list);

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
 *  them, those whose Qty and Sum are not unchecked. */
export function bomTable(parts, view) {
  const kept = filterParts(parts, view);
  const rows = (view.grouped ? groupParts(kept) : kept)
    .filter((row) => !view.excluded.Qty.includes(row.qty) && !view.excluded.Sum.includes(sumText(row)));
  return sortRows(rows, view.sort);
}

/** The total under the table: `total`, the Sum of the `rows` shown that are
 *  fitted (a DNP part is not mounted, so not bought), and `unpriced`, how many
 *  of their parts have no price; `priced`, whether any of `parts`, the whole
 *  BOM, has one, as the total is drawn only then. */
export function bomTotal(parts, rows) {
  const fitted = rows.filter((row) => !row.dnp);
  return {
    priced: parts.some((part) => part.sum !== null),
    total: fitted.reduce((total, row) => total + (row.sum || 0), 0),
    unpriced: fitted.reduce((count, row) => count + row.unpriced, 0),
  };
}
