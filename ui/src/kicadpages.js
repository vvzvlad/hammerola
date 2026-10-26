// The sheets of a KiCad schematic, as the list of views offers them: a row each
// in the submenu of the schematic's row (`SheetRows` in viewlist.jsx), the
// root sheet — the design's table of contents — first. Read from the
// schematic's own files, the ones its element is handed (`kicad.schematics` in
// meta.json, the root first), so the list does not wait for the design to be
// open.
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
// A sheet symbol places a sheet as the viewer takes it (`Project` in the
// fork's kicanvas/project.ts): by its placement under its parent's path
// (`(instances (project … (path "<parent path>" (page "5"))))`, KiCad 7 on),
// else by its only placement wherever that is; with neither — a KiCad 6 file,
// which keeps no placements in its sheet symbols, or several placements none
// of them under this parent — it places none, as the viewer lists none.
//
// THE ORDER is the root, then KiCad's page numbers, which that placement
// holds; sheets without one follow, in the order they are reached.
//
// Texts in, a list out: a root file that does not parse gives no sheets.

import { resolved } from './kicadnets.js';
import { property } from './kicadsheets.js';
import { children, head, parseSexpr, valueOf } from './sexpr.js';

/** A sheet as a menu and the comment rail name it: its file's name, without
 *  the directory and `.kicad_sch`. */
export const sheetName = (path) => path.slice(path.lastIndexOf('/') + 1).replace(/\.kicad_sch$/, '');

/** The placement of the sheet symbol `symbol` the viewer takes under the
 *  sheet at `path`: the one at that path, else its only one, else null. By
 *  path, as the viewer keys them, the last of one path standing. */
function placement(symbol, path) {
  const byPath = new Map(children(symbol, 'instances')
    .flatMap((instances) => children(instances, 'project'))
    .flatMap((project) => children(project, 'path'))
    .map((one) => [valueOf(one), one]));
  return byPath.get(path) || (byPath.size === 1 ? [...byPath.values()][0] : null);
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
      const at = placement(symbol, path);
      if (!at || !files.has(target) || above.includes(target)) continue;
      const own = `${path}/${valueOf(children(symbol, 'uuid')[0])}`;
      const sheet = { projectPath: `${target}:${own}`, name: property(symbol, 'Sheetname') || property(symbol, 'Sheet name'),
        parentProjectPath: parent.projectPath };
      placed.push({ sheet, page: Number.parseInt(valueOf(children(at, 'page')[0]), 10) });
      visit(target, own, sheet, [...above, target]);
    }
  };
  visit(root, rootPath, top, [root]);
  const numbered = placed.filter((one) => !Number.isNaN(one.page)).sort((a, b) => a.page - b.page);
  const rest = placed.filter((one) => Number.isNaN(one.page));
  return [top, ...[...numbered, ...rest].map((one) => one.sheet)];
}
