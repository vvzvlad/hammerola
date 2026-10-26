// The nets the sheets of a KiCad design's schematic name, where they name them,
// and the name the board gives each. KicadView.jsx reads from this which sheets
// a net is on, for the items of its right-click menu that show the net on
// another sheet, and the board's name of it, for the item that shows it on the
// board.
//
// AN OCCURRENCE is something placed on a sheet that names a net: its sheet (the
// file's path, as the viewer is handed it), the name, its uuid, its kind — a
// global label (`global`), a local one (`local`), a hierarchical one
// (`hierarchical`), a power symbol (`power`): a placed symbol whose
// `Reference` starts with `#PWR`, naming the net of its `Value`, or a sheet pin
// (`sheet-pin`): a `(pin "NAME" …)` of a sheet symbol, on the sheet that draws
// the symbol, naming the net NAME — and the board's name of the net (`board`).
// A power flag (`#FLG`) names none, and neither does a symbol of
// `lib_symbols`, which is placed nowhere. A sheet's occurrences are in the
// order its file holds them; one with no uuid cannot be aimed at and is left
// out.
//
// OCCURRENCES OF ONE NET share their `board`, which is how a reader tells them
// apart from those of another:
//   * a global label's or a power symbol's net is the name itself (`+12V`):
//     KiCad joins those across the whole design;
//   * a local label's is the name with its sheet's path in front, as KiCad
//     names a net of one sheet: `/X` on the root schematic, `/amp/OUT_C` on the
//     sheet the root's sheet symbol `amp` points at, `/amp/sub/OUT_C` one level
//     deeper. On a sheet not reached from the root it is the label's own name;
//   * hierarchical labels of one name are one net, the root wiring their sheet
//     pins together (by name here: the wires are not read), and KiCad names it
//     after ONE of their sheets: of `<that sheet's path><name>` for each
//     reached sheet that carries one, in the order of `texts`, the first the
//     board has a net of, else the first; every occurrence of the name has it.
//     The board's nets are read from the `.kicad_pcb` among `texts`, when
//     there is one;
//   * a sheet pin's is that name of the hierarchical labels of its name, and
//     where no hierarchical label has its name, its name with the path of the
//     sheet that draws it in front, as a local label's.
// A sheet's path is built from the sheets' NAMES (`Sheetname`, KiCad 6's
// `Sheet name`), the file each points at (`Sheetfile`, `Sheet file`) resolved
// against the directory of the schematic that names it. A file reached twice (a
// sheet used twice, or one that names its own ancestor) keeps the path it was
// reached by first and is not followed again.
//
// Texts in, an index out, read with sexpr.js's reader: a schematic that
// does not parse gives no occurrences and throws nothing.

import { children, head, parseSexpr, valueOf } from './sexpr.js';
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

/** The occurrence a sheet symbol's `(pin "NAME" <shape> (at …) (uuid …))`
 *  is, without its sheet, or null. */
function sheetPinOf(pin) {
  const uuid = valueOf(children(pin, 'uuid')[0]);
  return uuid ? { name: valueOf(pin), uuid, kind: 'sheet-pin' } : null;
}

/** A net as a board names it: `(net "/amp/OUT_C")` from KiCad 10 on,
 *  `(net 5 "/amp/OUT_C")` before; a string escapes `"` and `\` with a
 *  backslash. */
const BOARD_NET = /\(net(?:\s+\d+)?\s+"((?:[^"\\]|\\.)*)"/g;

/** The names of the nets of the boards among `texts`, read with a pattern
 *  rather than parsed: a board's file runs to megabytes. */
function boardNets(texts) {
  const names = new Set();
  for (const [file, text] of Object.entries(texts)) {
    if (!file.endsWith('.kicad_pcb')) continue;
    for (const [, name] of text.matchAll(BOARD_NET)) names.add(name.replace(/\\(.)/g, '$1'));
  }
  return names;
}

/** The board's name of each hierarchical label's net, by the label's name,
 *  from the occurrences `found`: of `<path><name>` for each sheet of `paths`
 *  that carries one, in the order of `found`, the first `onBoard` holds, else
 *  the first. */
function hierarchicalNets(found, paths, onBoard) {
  const candidates = new Map();
  for (const one of found) {
    if (one.kind !== 'hierarchical' || !paths.has(one.sheet)) continue;
    if (!candidates.has(one.name)) candidates.set(one.name, []);
    candidates.get(one.name).push(`${paths.get(one.sheet)}${one.name}`);
  }
  return new Map([...candidates].map(([name, names]) => [name, names.find((one) => onBoard.has(one)) || names[0]]));
}

/** The path of the file a sheet of the schematic `from` names as `file`,
 *  resolved against that schematic's directory. */
export function resolved(from, file) {
  const parts = from.split('/').slice(0, -1);
  for (const part of file.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

/** The board's path of each sheet reached from the schematic `root` through
 *  the sheet symbols of `sheets` (path → parsed file), as path → `/amp/`. */
function sheetPaths(sheets, root) {
  const paths = new Map();
  const visit = (file, path) => {
    if (paths.has(file) || !sheets.has(file)) return;
    paths.set(file, path);
    for (const symbol of children(sheets.get(file), 'sheet')) {
      const name = property(symbol, 'Sheetname') || property(symbol, 'Sheet name');
      const named = property(symbol, 'Sheetfile') || property(symbol, 'Sheet file');
      if (named) visit(resolved(file, named), `${path}${name}/`);
    }
  };
  visit(root, '/');
  return paths;
}

/**
 * The net occurrences of a design's sheets, from its files' texts by path (the
 * `.kicad_sch` among them, and the `.kicad_pcb` for the board's net names; the
 * rest is skipped) and the path of its root schematic, `root`: `occurrences`,
 * sheet by sheet in the order of `texts`, and `byUuid`, uuid → occurrence.
 */
export function netIndex(texts, root) {
  const sheets = new Map();
  for (const [sheet, text] of Object.entries(texts)) {
    if (!sheet.endsWith('.kicad_sch')) continue;
    let parsed;
    try {
      parsed = parseSexpr(text);
    } catch {
      continue;
    }
    if (head(parsed) === 'kicad_sch') sheets.set(sheet, parsed);
  }
  const paths = sheetPaths(sheets, root);
  const found = [];
  for (const [sheet, parsed] of sheets) {
    for (const node of parsed.list.slice(1)) {
      if (!node.list) continue;
      for (const one of head(node) === 'sheet' ? children(node, 'pin').map(sheetPinOf) : [occurrenceOf(node)]) {
        if (one) found.push({ sheet, ...one });
      }
    }
  }
  const hierarchical = hierarchicalNets(found, paths, boardNets(texts));
  const boardOf = (one) => {
    const path = paths.get(one.sheet);
    const own = path ? `${path}${one.name}` : one.name;
    if (one.kind === 'hierarchical') return hierarchical.get(one.name) || one.name;
    if (one.kind === 'sheet-pin') return hierarchical.get(one.name) || own;
    return one.kind === 'local' ? own : one.name;
  };
  const occurrences = found.map((one) => ({ ...one, board: boardOf(one) }));
  return { occurrences, byUuid: new Map(occurrences.map((one) => [one.uuid, one])) };
}
