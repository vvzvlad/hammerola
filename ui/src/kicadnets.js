// The nets the sheets of a KiCad design's schematic name, where they name them.
// KicadView.jsx reads which sheets a net is on from this, for the items of its
// right-click menu that show the net on another sheet.
//
// AN OCCURRENCE is something placed on a sheet that names a net: its sheet (the
// file's path, as the viewer is handed it), the name, its uuid, and its kind —
// a global label (`global`), a local one (`local`), a hierarchical one
// (`hierarchical`), or a power symbol (`power`): a placed symbol whose
// `Reference` starts with `#PWR`, naming the net of its `Value`. A power flag
// (`#FLG`) names none, and neither does a symbol of `lib_symbols`, which is
// placed nowhere. A sheet's occurrences are in the order its file holds them;
// one with no uuid cannot be aimed at and is left out.
//
// Global labels and power symbols of one name are one net across the whole
// design, as KiCad joins them; a local or a hierarchical label is a net of its
// own sheet. Sheet pins are not followed.
//
// Texts in, an index out, read with kicadpins.js's reader: a file that does not
// parse gives no occurrences and throws nothing.

import { children, head, parseSexpr, valueOf } from './kicadpins.js';
import { property } from './kicadsheets.js';

/** The kind of occurrence a label is, by the name of its list. */
const LABELS = { global_label: 'global', label: 'local', hierarchical_label: 'hierarchical' };

/** The start of a power symbol's `Reference`. */
const POWER = '#PWR';

/** The occurrence `node`, a list directly inside a sheet, is, without its
 *  sheet, or null. */
function occurrenceOf(node) {
  const uuid = valueOf(children(node, 'uuid')[0]);
  if (!uuid) return null;
  const kind = LABELS[head(node)];
  if (kind) return { name: valueOf(node), uuid, kind };
  if (head(node) === 'symbol' && property(node, 'Reference').startsWith(POWER)) {
    return { name: property(node, 'Value'), uuid, kind: 'power' };
  }
  return null;
}

/**
 * The net occurrences of a design's sheets, from its files' texts by path (the
 * `.kicad_sch` among them; the rest is skipped): `occurrences`, sheet by sheet
 * in the order of `texts`, and `byUuid`, uuid → occurrence.
 */
export function netIndex(texts) {
  const occurrences = [];
  for (const [sheet, text] of Object.entries(texts)) {
    if (!sheet.endsWith('.kicad_sch')) continue;
    let root;
    try {
      root = parseSexpr(text);
    } catch {
      continue;
    }
    if (head(root) !== 'kicad_sch') continue;
    for (const node of root.list.slice(1)) {
      const found = node.list && occurrenceOf(node);
      if (found) occurrences.push({ sheet, ...found });
    }
  }
  return { occurrences, byUuid: new Map(occurrences.map((one) => [one.uuid, one])) };
}
