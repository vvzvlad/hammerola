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
// A WIRE is an entry of `byUuid` and not of `occurrences`, so a sheet's item
// still aims at something named: `{ sheet, name, uuid, kind: 'wire', board,
// boards }`, the name and the board of the occurrence on its run KiCad names the
// net after: the strongest kind (`NAMING`), the first name among equals
// (`candidate_cmp` in eeschema/connection_graph.cpp). A run is the wires KiCad
// joins: two where an end of one
// lies on the other, at its end or along it; two crossing mid-span only where a
// junction stands. An occurrence is on a run when its `(at …)` lies on one of
// the run's wires, anywhere along it. A RUN JOINS THE NETS of what stands on
// it, as KiCad does: its wires and every occurrence on it carry `boards`, the
// distinct `board` of each occurrence on it in the file's order (of each run,
// for one on several); one on no run has none. A run with no occurrence gives
// its wires no entry; a bus is no wire.
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
//     pins together (by name here, not by the wires), and KiCad names it
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

/** The kinds of occurrence a net is named after, strongest first: KiCad's
 *  `CONNECTION_SUBGRAPH::PRIORITY` (eeschema/connection_graph.h). */
const NAMING = ['global', 'power', 'local', 'hierarchical', 'sheet-pin'];

/** How far apart two points of a sheet may be and still be one: the file
 *  writes millimetres to four decimals. */
const NEAR = 1e-3;

/** The point `(at x y …)` or `(xy x y)` names, as [x, y]; NaN where it names
 *  none, which lies on no wire. */
const coordinates = (node) => [1, 2].map((i) => Number(node && node.list[i] && node.list[i].atom));

/** The point of `node`'s `(at …)`. */
const pointOf = (node) => coordinates(children(node, 'at')[0]);

/** The occurrence `node`, a list directly inside a sheet, is, without its
 *  sheet, with its `point`, or null. */
function occurrenceOf(node) {
  const uuid = valueOf(children(node, 'uuid')[0]);
  if (!uuid) return null;
  const kind = LABELS[head(node)];
  if (kind) return { name: valueOf(node), uuid, kind, point: pointOf(node) };
  if (head(node) === 'symbol' && property(node, 'Reference').startsWith(POWER)) {
    // A power symbol of KiCad's has its single pin at the symbol's origin,
    // so the symbol's own `(at …)` is where a wire meets it.
    return { name: property(node, 'Value'), uuid, kind: 'power', point: pointOf(node) };
  }
  return null;
}

/** The occurrence a sheet symbol's `(pin "NAME" <shape> (at …) (uuid …))`
 *  is, without its sheet, with its `point`, or null. */
function sheetPinOf(pin) {
  const uuid = valueOf(children(pin, 'uuid')[0]);
  return uuid ? { name: valueOf(pin), uuid, kind: 'sheet-pin', point: pointOf(pin) } : null;
}

/** A wire `(wire (pts (xy …) (xy …)) … (uuid …))` as its ends `a` and `b`
 *  and its uuid, or null. */
function wireOf(node) {
  const uuid = valueOf(children(node, 'uuid')[0]);
  const [pts] = children(node, 'pts');
  const [a, b] = pts ? children(pts, 'xy').map(coordinates) : [];
  return uuid && b ? { uuid, a, b } : null;
}

/** Whether `point` lies on `wire`, at an end or anywhere along it. */
function onWire([x, y], { a: [ax, ay], b: [bx, by] }) {
  if (x < Math.min(ax, bx) - NEAR || x > Math.max(ax, bx) + NEAR) return false;
  if (y < Math.min(ay, by) - NEAR || y > Math.max(ay, by) + NEAR) return false;
  return Math.abs((bx - ax) * (y - ay) - (by - ay) * (x - ax)) <= NEAR * Math.hypot(bx - ax, by - ay);
}

/** The wires of one sheet in runs, as KiCad joins them: two where an end of
 *  one lies on the other, at its end or along it; two crossing mid-span only
 *  where one of the points `junctions` stands. */
function runs(wires, junctions) {
  const parent = wires.map((_, i) => i);
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const join = (i, j) => {
    parent[root(i)] = root(j);
  };
  wires.forEach((one, i) => wires.forEach((other, j) => {
    if (onWire(one.a, other) || onWire(one.b, other)) join(i, j);
  }));
  for (const point of junctions) {
    const through = wires.flatMap((one, i) => (onWire(point, one) ? [i] : []));
    for (const i of through) join(i, through[0]);
  }
  const grouped = new Map();
  wires.forEach((one, i) => {
    if (!grouped.has(root(i))) grouped.set(root(i), []);
    grouped.get(root(i)).push(one);
  });
  return [...grouped.values()];
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
 * sheet by sheet in the order of `texts`, and `byUuid`, uuid → occurrence or
 * wire.
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
  const occurrences = found.map(({ point, ...one }) => ({ ...one, board: boardOf(one) }));
  const wires = [];
  for (const [sheet, parsed] of sheets) {
    const placed = found.map((one, i) => [one.point, occurrences[i]]).filter(([, one]) => one.sheet === sheet);
    const lines = children(parsed, 'wire').map(wireOf).filter(Boolean);
    for (const run of runs(lines, children(parsed, 'junction').map(pointOf))) {
      const on = placed.filter(([point]) => run.some((wire) => onWire(point, wire))).map(([, one]) => one);
      if (!on.length) continue;
      const boards = [...new Set(on.map((one) => one.board))];
      for (const one of on) one.boards = [...new Set([...(one.boards || []), ...boards])];
      // Named as KiCad names the net: after the strongest kind on the run
      // (`NAMING`), the first name among equals.
      const rank = (one) => NAMING.indexOf(one.kind);
      const { name, board } = on.reduce((best, one) => (rank(one) < rank(best)
        || (rank(one) === rank(best) && one.name < best.name) ? one : best));
      for (const { uuid } of run) wires.push({ sheet, name, uuid, kind: 'wire', board, boards });
    }
  }
  return { occurrences, byUuid: new Map([...occurrences, ...wires].map((one) => [one.uuid, one])) };
}
