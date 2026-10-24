// The datasheet of each part of a KiCad design, and the document of the build
// it names. KicadView.jsx shows a link to it for the part selected.
//
// THE LINK IS KICAD'S OWN `Datasheet` FIELD: a placed symbol carries one in the
// schematic, a footprint one on the board. Both are read from the texts
// KicadView already fetches for its viewers, with kicadpins.js's reader. Where
// both name one the schematic's wins: it is where a part's fields are edited,
// and the board holds what the last update from it carried over. A field left
// empty names none — `""`, or `~`, which KiCad writes for an empty one — and
// neither does a web address, which is no file of the tree: so a board's value
// still counts under a schematic's empty one, and under the link to a
// manufacturer's site that a library symbol brings with it.
//
// A value names a document by its path in the tree: `file://` and
// `${KIPRJMOD}/` (the project's directory, as KiCad expands it) dropped, `\`
// read as `/`, the rest resolved against the directory of the design's project
// (`.kicad_pro`), else of the design itself. It links only when a listed
// document has exactly that `file`, hidden or not: a datasheet kept in the tree
// is listed `hidden` so that the page's list does not fill up with them
// (viewlist.jsx). A web address, an absolute path and a path out of the tree
// name no document.
//
// Text in, a map out: a file that does not parse gives no entries and throws
// nothing.

import { children, head, parseSexpr, valueOf } from './kicadpins.js';

const EMPTY = new Set(['', '~']);

/** The value of `node`'s `(property "<name>" "<value>" …)`, trimmed. */
function property(node, name) {
  const found = children(node, 'property').find((one) => valueOf(one) === name);
  return found && found.list[2] && typeof found.list[2].atom === 'string' ? found.list[2].atom.trim() : '';
}

/** The designators of a placed symbol: its `Reference`, and the one of each
 *  placement of its sheet (`(instances (project (path (reference …))))`), as
 *  a sheet used twice gives one symbol two. */
function symbolReferences(symbol) {
  const references = [property(symbol, 'Reference')];
  for (const instances of children(symbol, 'instances')) {
    for (const project of children(instances, 'project')) {
      for (const path of children(project, 'path')) {
        for (const reference of children(path, 'reference')) references.push(valueOf(reference));
      }
    }
  }
  return references.filter(Boolean);
}

/** The parts `root` names a datasheet for, as `[designator, value]`: the
 *  placed symbols of a schematic (not its `lib_symbols`), the footprints of a
 *  board. */
function partsOf(root) {
  const parts = [];
  const take = (node, references) => {
    const value = property(node, 'Datasheet');
    if (!EMPTY.has(value) && !isWeb(value)) for (const reference of references) parts.push([reference, value]);
  };
  if (head(root) === 'kicad_sch') {
    for (const symbol of children(root, 'symbol')) {
      if (children(symbol, 'lib_id').length) take(symbol, symbolReferences(symbol));
    }
  } else if (head(root) === 'kicad_pcb') {
    for (const footprint of children(root, 'footprint')) take(footprint, [property(footprint, 'Reference')].filter(Boolean));
  }
  return parts;
}

function parsed(text) {
  try {
    return parseSexpr(text);
  } catch {
    return null;
  }
}

/**
 * Designator → `Datasheet` value, from a design's files' texts by path (the
 * `.kicad_sch` and `.kicad_pcb` among them; the rest is skipped). The first
 * value found for a designator stands, so a part drawn as several units gives
 * that of the first unit naming one; a schematic's stands over a board's.
 */
export function partDatasheets(texts) {
  const sheets = new Map();
  const board = new Map();
  for (const [path, text] of Object.entries(texts)) {
    const kind = path.slice(path.lastIndexOf('.') + 1);
    const into = kind === 'kicad_sch' ? sheets : kind === 'kicad_pcb' ? board : null;
    const root = into && typeof text === 'string' && parsed(text);
    if (!root || head(root) !== kind) continue;
    for (const [reference, value] of partsOf(root)) if (!into.has(reference)) into.set(reference, value);
  }
  for (const [reference, value] of board) if (!sheets.has(reference)) sheets.set(reference, value);
  return sheets;
}

const directory = (path) => path.slice(0, Math.max(path.lastIndexOf('/'), 0));

/** The directory a design's datasheets resolve against, from its members: its
 *  project's, else its schematic's, else its board's. */
export function datasheetBase(docs) {
  const project = docs.map((doc) => doc.kicad && doc.kicad.project).find(Boolean);
  if (project) return directory(project);
  const own = docs.find((doc) => doc.type === 'schematic') || docs.find((doc) => doc.type === 'board') || docs[0];
  return own ? directory(own.file) : '';
}

const WEB = /^[a-z][a-z0-9+.-]*:\/\//i;
const FILE = 'file://';
const PROJECT = '${KIPRJMOD}/';

/** `value` with `\` read as `/` and the spellings of the project's directory
 *  (`file://`, `${KIPRJMOD}/`) dropped. */
function unwrapped(value) {
  let path = value.replace(/\\/g, '/');
  if (path.startsWith(FILE)) path = path.slice(FILE.length);
  if (path.startsWith(PROJECT)) path = path.slice(PROJECT.length);
  return path;
}

/** Is `value` a web address, which names no file of the tree? */
const isWeb = (value) => WEB.test(unwrapped(value));

/** The path in the tree `value` names, resolved against the directory `base`,
 *  or null for a web address, an absolute path or one out of the tree. */
export function datasheetPath(value, base) {
  const path = unwrapped(value);
  if (WEB.test(path) || path.startsWith('/')) return null;
  const parts = [];
  for (const part of `${base}/${path}`.split('/')) {
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else if (part && part !== '.') {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/** The listed document `value` names, hidden or not, or null. */
export function datasheetDocument(value, base, documents) {
  const path = value ? datasheetPath(value, base) : null;
  return (path && (documents || []).find((doc) => doc.file === path)) || null;
}
