// The sheets of a KiCad schematic, as the list of views offers them: a row each
// under the schematic's row (`SheetRows` in viewlist.jsx), the root sheet — the
// design's table of contents — first. Read from the schematic's own files, the
// ones its element is handed (`kicad.schematics` in meta.json, the root first),
// so the list does not wait for the design to be open.
//
// A SHEET is one placement, in the shape the viewer's `getSchematicPages()`
// lists it in: `{ projectPath, name, parentProjectPath }`, so a file two sheet
// symbols point at is two sheets. The root is `Root`, as the viewer names it,
// at the path `/<the root file's uuid>`; any other sheet at its parent's path
// and the uuid of the sheet symbol placing it. Its `projectPath` is its file
// and its path (`hw/amp.kicad_sch:/<root>/<symbol>`), its name the symbol's
// `Sheetname` (KiCad 6: `Sheet name`), its file the symbol's `Sheetfile`
// (`Sheet file`) resolved against the directory of the file that names it
// (`resolved` in kicadnets.js). A file that is not among the texts, and one
// naming a file it is itself placed under, place no sheet.
//
// THE ORDER is the root, then KiCad's page numbers, which a sheet symbol holds
// for its placement under its parent (`(instances (project … (path "<parent
// path>" (page "5"))))`, KiCad 7 on); sheets without one follow, in the order
// they are reached.
//
// Texts in, a list out: a root file that does not parse gives no sheets.

import { resolved } from './kicadnets.js';
import { children, head, parseSexpr, valueOf } from './kicadpins.js';
import { property } from './kicadsheets.js';

/** The page number the sheet symbol `symbol` holds for its placement under
 *  the sheet at `path`, or NaN. */
function pageNumber(symbol, path) {
  for (const instances of children(symbol, 'instances')) {
    for (const project of children(instances, 'project')) {
      for (const placement of children(project, 'path')) {
        if (valueOf(placement) === path) return Number.parseInt(valueOf(children(placement, 'page')[0]), 10);
      }
    }
  }
  return NaN;
}

/**
 * The sheets of a schematic, in the order the list offers them, from its
 * files' texts by path (`texts`) and the path of its root file (`root`).
 */
export function schematicSheets(texts, root) {
  const files = new Map();
  for (const [path, text] of Object.entries(texts)) {
    let parsed;
    try {
      parsed = parseSexpr(text);
    } catch {
      continue;
    }
    if (head(parsed) === 'kicad_sch') files.set(path, parsed);
  }
  if (!files.has(root)) return [];
  const rootPath = `/${valueOf(children(files.get(root), 'uuid')[0])}`;
  const top = { projectPath: `${root}:${rootPath}`, name: 'Root', parentProjectPath: undefined };
  const placed = [];
  // `above`: the files the sheet at `path` is placed under, its own included.
  const visit = (file, path, parent, above) => {
    for (const symbol of children(files.get(file), 'sheet')) {
      const target = resolved(file, property(symbol, 'Sheetfile') || property(symbol, 'Sheet file'));
      if (!files.has(target) || above.includes(target)) continue;
      const own = `${path}/${valueOf(children(symbol, 'uuid')[0])}`;
      const sheet = { projectPath: `${target}:${own}`, name: property(symbol, 'Sheetname') || property(symbol, 'Sheet name'),
        parentProjectPath: parent.projectPath };
      placed.push({ sheet, page: pageNumber(symbol, path) });
      visit(target, own, sheet, [...above, target]);
    }
  };
  visit(root, rootPath, top, [root]);
  const numbered = placed.filter((one) => !Number.isNaN(one.page)).sort((a, b) => a.page - b.page);
  const rest = placed.filter((one) => Number.isNaN(one.page));
  return [top, ...[...numbered, ...rest].map((one) => one.sheet)];
}
