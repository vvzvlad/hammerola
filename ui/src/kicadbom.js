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
