// One KiCad design, as the documents of a build it is made of: its schematic
// and its board, each in an `<ecad-viewer>` of its own, and the board's 3D
// model in BoardView3D.jsx. DocumentView.jsx draws a document of type
// `schematic`, `board` or `board3d` with this.
//
// A DESIGN is the listed schematic, board and 3D model with one path minus the
// extension (`designKey`): `hw/board.kicad_sch`, `hw/board.kicad_pcb` and
// `hw/board.glb` are one. Each is its own document and its own row of the
// page's list of views (viewlist.jsx); WHICH ONE IS ON SCREEN IS THE PAGE'S,
// the document it hands down as `doc`. The page keys this component by the
// design (`docViewKey` in DocumentView.jsx), so moving between two members of
// one design keeps this instance and all its views. A member with no listed
// sibling is a design of one.
//
// The viewer is the vendored `ecad-viewer.js` (static/_v/PROVENANCE.md),
// fetched by URL only when a design is opened: nothing of it is in this bundle.
// In `source-mode="host"` it reads nothing by itself; this component fetches the
// members' files from the build (meta.json names them, `kicad`) and hands them
// over as `{filename, content}`, under their paths in the tree, so a sheet's
// `Sheetfile` resolves against them as KiCad resolves it. A schematic is handed
// over with the pin entries the viewer needs to draw pins (kicadpins.js).
//
// WHAT IS ON SCREEN DOWNLOADS FIRST. Opened on the 3D view, the design fetches
// the schematic's and the board's files only once the board's `.glb` has come
// in or failed to (`onFetched3D`), or the reader has moved to one of them, so
// the two do not share the line; the page is told the view on screen has its
// file(s) through `onReady` (DocumentView.jsx). While those files come in, the
// 2D views' note is the bar of loadbar.jsx, filled to the schematic's and the
// board's `bytes`, and a part selected in the 3D view, or asked for by `Show
// in …`, is selected in them once they are drawn.
//
// EVERY MEMBER'S VIEW STAYS MOUNTED. The ones not on screen are hidden with
// `visibility`, not `display`, so each keeps its size, its camera and its
// selection, and is told it is inactive (`setActive`, `active`), which stops its
// drawing until it is back.
//
// A CHANGE OF THE SCHEMATIC'S PAGE IS A STEP OF THE BROWSER'S HISTORY, whatever
// makes it: a double click on a sheet symbol, an item `… · <sheet>`, the
// viewer's own `[`, `]` and Alt+Backspace. The element reports each one
// (`PAGE_EVENT`), and the sheet is named in the address as `s=`, beside the
// `d=` of the schematic, as a view is `v=` (`SHEET_QUERY`): Back and Forward,
// a reload and a link put the sheet the address names on screen
// (`followPage`), opened whole as the viewer opens a sheet itself, not at the
// camera it was left at. The root sheet has no `s=`, so a design opened from
// the list of views after another document starts on it (`pushChoice`, and
// `pick` in DocShell.jsx, drop `s=`). Moving between the board and the
// schematic of one design keeps the schematic's sheet — one element, kept, and
// a part clicked on the board may have moved it there on purpose — and the
// address takes it up when a choice of the reader's brings the schematic on
// screen; Back or Forward bringing it puts the entry's sheet back instead
// (`followPage`). A sheet this
// component moves the schematic to on screen — a part selected in another
// view, `Show … · <sheet>` handed over from the board — rewrites the address
// rather than adding to its history; a move of the schematic while it is
// hidden leaves the address alone (`paged`).
//
// `hide-chrome` leaves each element its canvas alone. It drops the viewer's own
// panels (layers, objects, nets, properties), which `show-header="false"`
// already keeps off screen, and its corner mark: Prism's logo, a single node the
// viewer shares between all its elements on a page, so one element showed it
// and the other an empty circle. The board gets a panel of ours instead
// (PcbPanel.jsx), drawn over it once its files are loaded.
//
// THE VIEWS ARE LINKED HERE, not in the viewer, two ways:
//   * a click that selects a part in one view selects it in the others too,
//     hidden as they are, and changes nothing on screen: an element reports it
//     as `ecad-viewer:selection`, the 3D view through `onSelect`; a click on
//     anything that is not a part (a wire, a track) puts the part out in the
//     others. A click on nothing at all, and Escape, put out what is lit in
//     EVERY view, the clicked one included: the viewer itself leaves a part lit
//     through a click on the bare board. Nets are not carried across this way;
//   * the RIGHT BUTTON on a part, or in the schematic and the board on what has
//     a net (a track, a via, a zone, a label, a power symbol, a sheet pin),
//     opens a menu at the pointer (`menuFor`), headed with the part, the net,
//     or both: a pad of the board is both, a pin of the schematic its part
//     alone. The part has
//     an item `Show <ref> in <name>` for every other listed member, the net
//     `Show net <name> in <name>` for every other drawn one, never the 3D
//     model. A power symbol (`#PWR`) is no part, being on the schematic only,
//     but the net its `Value` names; a power flag (`#FLG`) is neither. A net
//     the sheets name has in place of the schematic's item one per sheet it is
//     on, `… · <sheet>`, aimed at its first occurrence there: every sheet from
//     the board, the other sheets from the schematic. What is one net is read
//     from the sheets' texts and the board's (kicadnets.js): the occurrences of
//     one name on the board, `board` — global labels and power symbols of one
//     name, which KiCad joins across the whole design, and hierarchical labels
//     of one name with the sheet pins of that name, through which the sheet
//     that draws a sheet symbol wires them together, so that net's items
//     include that sheet. A local label's net is on its own sheet alone, so
//     from the schematic it has no sheet item; a net no sheet names keeps the
//     one item, and the viewer looks it up.
//     An item of another member asks the page to open it (`onOpen` with its
//     id, which moves the lit row of its list too) and, once the page has
//     handed it down, asks its element to select the same thing — a part by
//     its designator, a net by its name, and for a sheet's item on that sheet
//     at that occurrence (`requestCrossProbe`); the 3D view is handed the part
//     as `selected`. The board is asked for a net a sheet names by the board's
//     name of it (`/amp/OUT_C` for a local label `OUT_C` on the sheet `amp`);
//     the lines show the name clicked, a label's own or the one the board
//     reported. An item of another sheet of the schematic on screen asks its
//     element straight away: the page shows what it showed.
//
// WHAT IS UNDER THE POINTER at a right click is the viewer's own answer to a
// left click there. It selects on the left button only and has no hit test an
// element offers, so the right click's position is handed to the canvas it
// landed on as the pointer move and the click the viewer picks with — neither
// bubbles, so nothing else on the page sees them — and the selection that
// click reports is what the menu is for. The thing is selected too, as a right
// click in KiCad selects it. A right press the viewer panned with (it pans from
// `PAN_SLOP` on) is no click. The 3D view picks with its own raycast.
//
// THE MENU is one at a time, inside the view area, in the page's colours; it
// goes on Escape, a press anywhere else, the wheel, a resize, and when its view
// leaves the screen.
//
// THE WHEEL ON THE SCHEMATIC AND THE BOARD, and HOW A SELECTION LOOKS there,
// are the viewer's own doing: both are edits of ours to the vendored file
// (static/_v/PROVENANCE.md, "Our edits"), so nothing on this side takes the
// event or paints anything. A two-finger swipe of a touchpad moves the
// drawing, a pinch — a wheel event with Control held — and Control and the
// wheel zoom about the pointer, by the Gerbers' arithmetic (`wheelMove` in
// gerber.js); a selected footprint is outlined, not filled over, and the
// board's copper pours stay on screen while it is selected; a highlighted
// net dims the board and not the page around it.
//
// FIT AND FRAME of the page's bar (`onTools` in DocumentView.jsx) act on the
// view on screen. The element has no fit of its own, and its `exportImage`
// walks every sheet of a schematic, reloading each; so a drawn view is driven
// through the viewer's own drawing inside the element's open shadow tree
// (`drawingOf`): Fit is the viewer's own reset (`zoom_fit_top_item`, what its
// toolbar's reset button calls and what it opens a sheet with), Frame draws a
// frame and reads the canvas in the same task. The 3D view says its own
// (BoardView3D.jsx). The schematic on a sheet below its root adds Contents,
// which puts its root sheet back (`toContents`).
//
// A PART'S DATASHEET is the last item of its menu, `Open datasheet · <name>`,
// when the part's KiCad `Datasheet` field names a document of the build, listed
// or hidden (kicadsheets.js); a part with a datasheet and no other member to be
// shown in gets a menu of that item alone. It opens the document in a window
// over the view area, drawn as the page draws a document (DocumentView.jsx),
// and asks the page for nothing: the design under it keeps its view, its
// selection and its camera, and closing the window is the way back. One window
// at a time; it goes on its `×`, a click beside it and Escape — which then
// closes the window only — and when its view leaves the screen.

import React from 'react';

import BoardView3D from './BoardView3D.jsx';
import DocumentView, { DOC_QUERY } from './DocumentView.jsx';
import { netIndex } from './kicadnets.js';
import { addPinEntries } from './kicadpins.js';
import { datasheetBase, datasheetDocument, partDatasheets } from './kicadsheets.js';
import { fetchBody, loadBar, meter, painted } from './loadbar.jsx';
import { ELLIPSIS, POP_SHADOW_HIGH } from './panelstyle.js';
import PcbPanel from './PcbPanel.jsx';
import { css, FONTS, MONO, SANS } from './style.jsx';
import { typingTarget } from './viewport/holdkey.js';

/** Where the hub serves the viewer; `parser.worker.js` is fetched beside it. */
export const ECAD_VIEWER_URL = '/_v/ecad-viewer.js';

/** How far a press may move before the viewer pans with it (`ag` in
 *  ecad-viewer.js): a right press released nearer than this is a click. */
export const PAN_SLOP = 3;

/** The event an element reports a click's selection with
 *  (`EcadSemanticSelectionEvent`): a symbol, a pin, a footprint or a pad carries
 *  its part's `reference`, anything else none, an empty click `itemType: ''`. */
export const SELECTION_EVENT = 'ecad-viewer:selection';

/** The event an element reports a change of its view with: once, at once,
 *  inside `switchPage` and every other change of the schematic's page, and
 *  for other changes of its project too, so the page itself is compared. */
export const PAGE_EVENT = 'ecad-viewer:view-state-change';

/** The address's parameter naming the schematic's sheet on screen, as `v=`
 *  names a view: there only while `d=` names the schematic, and never for its
 *  root sheet (`sheetQueryValue`). */
export const SHEET_QUERY = 's';

/** What `s=` says for the sheet `projectPath` among the schematic's `pages`
 *  (`getSchematicPages`): the sheet's `name` where no other sheet has it,
 *  else its `projectPath`; '' for the root sheet, the one with no parent. */
export function sheetQueryValue(pages, projectPath) {
  const page = pages.find((one) => one.projectPath === projectPath);
  if (!page || !page.parentProjectPath) return '';
  return pages.filter((one) => one.name === page.name).length === 1 ? page.name : page.projectPath;
}

/** The `projectPath` of the sheet an `s=` value names among `pages`: a sheet's
 *  name where it is the only one with it, else a `projectPath`. No value, or
 *  one naming no sheet of the schematic, is the root sheet, as an unknown
 *  `v=` is the first view. */
export function sheetFromQuery(pages, value) {
  const root = pages.find((one) => !one.parentProjectPath) || pages[0];
  const named = value ? pages.filter((one) => one.name === value) : [];
  const page = (named.length === 1 && named[0])
    || (value && pages.find((one) => one.projectPath === value)) || root;
  return page ? page.projectPath : null;
}

/** The views of a design: the two by the names the viewer gives them
 *  (`targetContext`), and the 3D model of the board. */
export const SCH = 'SCH';
export const PCB = 'PCB';
export const BOARD3D = '3D';

/** The view each document type of a design is, by meta.json's `type`
 *  (`render.DOCUMENT_TYPES` on the hub). */
export const DESIGN_VIEWS = { schematic: SCH, board: PCB, board3d: BOARD3D };

/** The views the viewer draws, each in an element of its own. */
const DRAWN = [SCH, PCB];

/** The view `doc` is of its design, or undefined for any other document. */
export const viewOf = (doc) => (Object.prototype.hasOwnProperty.call(DESIGN_VIEWS, doc.type)
  ? DESIGN_VIEWS[doc.type] : undefined);

/** The design `doc` is a member of: its path without the extension, or null
 *  for a document that is not a schematic, a board or a board's 3D model. */
export function designKey(doc) {
  if (!viewOf(doc)) return null;
  const cut = doc.file.lastIndexOf('.');
  return cut < 0 ? doc.file : doc.file.slice(0, cut);
}

/** The members of `doc`'s design among `documents`, by view: one each, the
 *  first listed, and `doc` itself always. */
export function designMembers(documents, doc) {
  const key = designKey(doc);
  const members = { [viewOf(doc)]: doc };
  for (const one of documents || []) {
    const view = viewOf(one);
    if (view && !members[view] && designKey(one) === key) members[view] = one;
  }
  return members;
}

let pending = null;

/**
 * The viewer's module, fetched once per page. A rejected import is dropped so
 * that opening the design again tries again (see `loadViewerLibrary`).
 */
export function loadEcadViewer() {
  if (!pending) {
    pending = import(/* @vite-ignore */ ECAD_VIEWER_URL).catch((error) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}

/** The views of a design the viewer draws, in the order they are mounted. */
export const drawnViews = (members) => DRAWN.filter((view) => members[view]);

/** Where a file of the build is served from. */
const fileUrl = (base, file) => `${base}${file.split('/').map(encodeURIComponent).join('/')}`;

const project = (doc) => (doc.kicad.project ? [doc.kicad.project] : []);

/** What each drawn view is handed, as paths: the project first when there is one. */
function viewFiles(members) {
  const files = {};
  if (members[SCH]) files[SCH] = [...project(members[SCH]), ...members[SCH].kicad.schematics];
  if (members[PCB]) files[PCB] = [...project(members[PCB]), members[PCB].file];
  return files;
}

/** Every file the design's drawn views read, each once. */
export const designFiles = (members) => [...new Set(Object.values(viewFiles(members)).flat())];

/** What each element is handed, from the files' texts by path: a schematic
 *  with the pin entries the viewer draws pins from (kicadpins.js). */
export function designSources(members, texts) {
  const source = (filename) => ({
    filename,
    content: filename.endsWith('.kicad_sch') ? addPinEntries(texts[filename]) : texts[filename],
  });
  return Object.fromEntries(Object.entries(viewFiles(members)).map(([view, files]) => [view, files.map(source)]));
}

/** A design whose sheets name no net (kicadnets.js): one whose files are not in yet. */
const NO_NETS = netIndex({});

/**
 * What another view is asked to select for what a view reported selected, as
 * `{ part, net }`, each a request or null: a part by its designator (a symbol,
 * a pin, a footprint, a pad), a net by its name (a label, a track, a via, a
 * zone, and a pad, which has both). A designator KiCad starts with `#` is no
 * part: a power symbol or a power flag is drawn on the schematic only, never
 * placed on the board. A power symbol is a net instead, the one `nets`
 * (kicadnets.js) holds for its uuid; a power flag names none.
 */
export function crossProbeRequest(detail, targetContext, nets = NO_NETS) {
  const { reference, net, uuid } = detail || {};
  const own = nets.byUuid.get(uuid);
  const name = net || (own && own.kind === 'power' ? own.name : '');
  return {
    part: reference && !reference.startsWith('#') ? { targetContext, kind: 'designator', value: reference } : null,
    net: name ? { targetContext, kind: 'net', value: name } : null,
  };
}

/** The views that can show a part and a net, in the order a menu lists them:
 *  the 3D model has parts and no nets. */
const SHOWS = { designator: [SCH, PCB, BOARD3D], net: [SCH, PCB] };

/**
 * The first occurrence on each sheet of the net the board names `board`
 * (kicadnets.js), in the order of `nets`: the sheet of `own`, the occurrence
 * the menu is for, if any, left out.
 */
function netSheets(nets, board, own) {
  const first = new Map();
  for (const one of nets.occurrences) {
    if (one.board === board && !(own && one.sheet === own.sheet) && !first.has(one.sheet)) first.set(one.sheet, one);
  }
  return [...first.values()];
}

/** A sheet as a menu names it: its file's name, without the directory and `.kicad_sch`. */
const sheetName = (path) => path.slice(path.lastIndexOf('/') + 1).replace(/\.kicad_sch$/, '');

/**
 * The right-click menu for what view `from` reported selected (`detail`; the
 * 3D view's part as `{ reference }`), with the sheets' nets `nets`: the part
 * and the net it shows (`crossProbeRequest`), either null, and the items, each
 * carrying the request its view is asked (`request`). The part's first, an
 * item for every other listed member that can show it; then the net's, the
 * same but for the schematic where the sheets name the net (`netSheets`),
 * which has an item per sheet it is on instead, the request carrying the
 * sheet's path and the occurrence's uuid, and for the board, which is asked for
 * the net by the board's name of it: the occurrence's `board` when the menu is
 * for one, else the name reported, which a click on the board reports as the
 * board names it. Every line shows the name reported. Last, for a part, the
 * document its datasheet names (`sheet`, or null), which its item carries as
 * `doc`. Null when there is no item.
 */
export function menuFor(from, detail, members, sheet = null, nets = NO_NETS) {
  const { part, net } = crossProbeRequest(detail, null, nets);
  const items = [];
  const offer = (view, label, request) => items.push({ view, id: members[view].id, label,
    request: { ...request, targetContext: view } });
  if (part) {
    for (const view of SHOWS.designator.filter((one) => one !== from && members[one])) {
      offer(view, `Show ${part.value} in ${members[view].name}`, part);
    }
  }
  if (net) {
    const own = nets.byUuid.get(detail.uuid);
    const board = own ? own.board : net.value;
    const sheets = netSheets(nets, board, own);
    for (const view of SHOWS.net.filter((one) => members[one])) {
      const label = `Show net ${net.value} in ${members[view].name}`;
      if (view === SCH && sheets.length) {
        for (const one of sheets) {
          offer(view, `${label} · ${sheetName(one.sheet)}`, { ...net, net: net.value, sheet: one.sheet, uuid: one.uuid });
        }
      } else if (view !== from) {
        offer(view, label, view === PCB ? { ...net, value: board } : net);
      }
    }
  }
  if (sheet && part) {
    items.push({ id: sheet.id, label: `Open datasheet · ${sheet.name}`, doc: sheet });
  }
  return items.length ? { part: part && part.value, net: net && net.value, items } : null;
}

/** The head line of `menu`: its part, its net, or both. */
const menuHead = (menu) => [menu.part, menu.net && `net ${menu.net}`].filter(Boolean).join(' · ');

/** The viewer's own list of a label's namesakes (`kc-sch-selection-menu`),
 *  beside `canvas` in the shadow tree of its schematic app, or null. */
function labelList(canvas) {
  for (let root = canvas.getRootNode(); root && root.querySelector; root = root.host ? root.host.getRootNode() : null) {
    const list = root.querySelector('kc-sch-selection-menu');
    if (list) return list;
  }
  return null;
}

/** The menu's box, known before it is drawn, so that where it fits is too: a
 *  head line, a row per item, 2px and 6px of padding and a 1px border; at
 *  least `MENU_WIDTH` wide, wider where a line needs it, and `MENU_PAD` of it
 *  the items' padding on either side and the border. An item's font is what
 *  `labelsWidth` measures its line in; its side padding is in `MENU_PAD`. */
const ITEM_FONT = '400 12px';
const ITEM_PAD = 14;
const MENU_WIDTH = 220;
const MENU_PAD = 2 * ITEM_PAD + 2;
const MENU_HEAD = 27;
const MENU_ROW = 30;
/** How far the menu keeps from the view area's edges. */
const MENU_MARGIN = 8;
export const menuHeight = (rows) => MENU_HEAD + rows * MENU_ROW + 10;

/** How wide the widest of `labels` is drawn in the font of the menu's items:
 *  measured in a hidden line laid out in the page, so 0 where nothing is laid
 *  out. The family is spelled out: the page's font properties are set on the
 *  element it mounts into, not on `body`. A sheet's item ends with the sheet's
 *  name, which a cut would hide. */
function labelsWidth(labels) {
  const line = document.createElement('span');
  line.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${ITEM_FONT} ${FONTS['--hmr-sans']}`;
  document.body.appendChild(line);
  let widest = 0;
  for (const label of labels) {
    line.textContent = label;
    widest = Math.max(widest, line.getBoundingClientRect().width);
  }
  line.remove();
  return widest;
}

/**
 * Where a menu opened at `x`,`y` of an area `area` wide and high goes: right of
 * and below the pointer where that fits, else left of or above it, and never
 * past the area's edges; as wide as its widest line (`text`, in px) needs and
 * narrower where the area is.
 */
export function menuPlace(x, y, rows, area, text = 0) {
  const width = Math.max(0, Math.min(Math.max(MENU_WIDTH, Math.ceil(text) + MENU_PAD), area.width - 2 * MENU_MARGIN));
  const height = menuHeight(rows);
  const fit = (at, size, room) => Math.max(MENU_MARGIN,
    Math.min(at + size + MENU_MARGIN <= room ? at : at - size, room - size - MENU_MARGIN));
  return { left: fit(x, width, area.width), top: fit(y, height, area.height), width };
}

/** The viewer's own drawings, by tag: each holds its viewer (`viewer`) and its
 *  canvas (`canvas`). */
const DRAWINGS = new Set(['kc-schematic-viewer', 'kc-board-viewer']);

/** The drawing inside `element`'s shadow trees, all of them open, or null. */
export function drawingOf(element) {
  const roots = element && element.shadowRoot ? [element.shadowRoot] : [];
  while (roots.length) {
    for (const node of roots.shift().querySelectorAll('*')) {
      if (DRAWINGS.has(node.localName)) return node;
      if (node.shadowRoot) roots.push(node.shadowRoot);
    }
  }
  return null;
}

/** The document the datasheet of part `designator` names (kicadsheets.js), or
 *  null. `datasheets` is designator → `Datasheet` value. */
export function selectedDatasheet(designator, datasheets, members, documents) {
  const value = designator && datasheets.get(designator);
  return value ? datasheetDocument(value, datasheetBase(Object.values(members)), documents) : null;
}

const SHELL = 'position:relative;height:100%;min-height:320px';
const VIEWER = 'position:absolute;top:0;left:0;width:100%;height:100%;display:block';
const NOTE = `position:absolute;top:0;left:0;padding:24px 28px;font:400 12.5px ${MONO};color:var(--text-muted)`;
// The menu as the build page's right-click menu is drawn (rowmenu.js), in a box
// of a known size (`menuPlace`).
const menuBox = ({ left, top, width }) => `position:absolute;left:${left}px;top:${top}px;width:${width}px;`
  + 'z-index:1;box-sizing:border-box;padding:2px 0 6px;background:var(--card-bg);border:1px solid var(--line);'
  + `border-radius:9px;box-shadow:${POP_SHADOW_HIGH}`;
const MENU_NAME = `height:${MENU_HEAD}px;box-sizing:border-box;padding:7px 14px 0;${ELLIPSIS};`
  + `font:600 10.5px ${MONO};color:var(--text-muted);border-bottom:1px solid var(--line-soft)`;
const menuItem = (hover) => `height:${MENU_ROW}px;box-sizing:border-box;padding:8px ${ITEM_PAD}px 0;${ELLIPSIS};`
  + `font:${ITEM_FONT} ${SANS};color:var(--text);cursor:pointer;user-select:none`
  + (hover ? ';background:var(--hover-bg)' : '');
// The datasheet's window, in the menu's colours: a veil over the whole view
// area, which a click on closes, and the window 12px in from its edges, no
// wider than a page of a datasheet needs.
const SHEET_VEIL = 'position:absolute;inset:0;z-index:2;display:flex;justify-content:center;'
  + 'padding:12px;box-sizing:border-box;background:var(--shadow)';
const SHEET_WINDOW = 'display:flex;flex-direction:column;width:100%;max-width:1000px;height:100%;'
  + 'box-sizing:border-box;overflow:hidden;background:var(--card-bg);border:1px solid var(--line);'
  + `border-radius:9px;box-shadow:${POP_SHADOW_HIGH}`;
const SHEET_HEAD = 'display:flex;align-items:center;gap:8px;height:38px;flex:none;box-sizing:border-box;'
  + 'padding:0 5px 0 14px;border-bottom:1px solid var(--line-soft)';
const SHEET_NAME = `flex:1;min-width:0;${ELLIPSIS};font:600 12px ${SANS};color:var(--text)`;
const SHEET_CLOSE = 'width:28px;height:28px;flex:none;display:flex;align-items:center;justify-content:center;'
  + `border-radius:6px;font:400 19px/1 ${SANS};color:var(--text-muted);cursor:pointer;user-select:none`;
const SHEET_BODY = 'position:relative;flex:1;min-height:0;overflow:auto';

/** One design: a view per member, the one on screen, and the links between
 *  them. */
export default class KicadView extends React.Component {
  constructor(props) {
    super(props);
    // `selected`: the designator of the part selected in the design, which the
    // 3D view is handed; the elements are told directly. `datasheets`: each
    // part's `Datasheet` value, and `nets` the nets the schematic's sheets name
    // (kicadnets.js), once the files are in. `menu`: the right-click
    // menu open (`menuFor`, with the view it is of and its box), `hover` the
    // index of the item under the pointer. `sheet`: the datasheet's window open,
    // `{ doc, from }` with the view it was opened over. `tools3d`: what the 3D
    // view told the bar it can do, or null. `received`: the bytes of the 2D
    // views' files in so far; `got`: all of them, the viewers being handed them.
    this.state = {
      ready: false, error: '', selected: null, datasheets: new Map(), nets: NO_NETS, menu: null, hover: -1, sheet: null,
      tools3d: null, received: 0, got: false,
    };
    // What the bar can do with a drawn view on screen, one object for both; the
    // same with Contents for the schematic on a sheet below its root, one object
    // too, as `report` tells the page of a change by identity; and the last
    // thing the page was told.
    this.drawnTools = { fit: () => this.fitDrawn(), frame: () => this.frameDrawn() };
    this.sheetTools = { ...this.drawnTools, contents: () => this.toContents() };
    this.reported = undefined;
    this.onTools3D = (tools) => this.setState({ tools3d: tools });
    // A selection waiting for the page to hand down the member it is on:
    // `{ to, request }`, or null.
    this.probe = null;
    // A right press on a drawn view until it is released, `{ context, x, y }`;
    // and while the viewer is asked what is under it, the point its menu opens
    // at, `{ from, x, y }`.
    this.pressed = null;
    this.pointing = null;
    // The schematic's page on screen (its `projectPath`), and the one the
    // address asked for while the element switches to it (`followPage`).
    this.page = null;
    this.pageFromHistory = null;
    this.onPop = () => this.followPage();
    // Set while the page itself probes an element (`pageProbe`).
    this.probing = false;
    this.elements = {};
    this.shell = null;
    this.menuNode = null;
    // One ref callback per view, made once, so React does not detach and
    // reattach the listeners on every render.
    this.refCallbacks = { [SCH]: this.attach(SCH), [PCB]: this.attach(PCB) };
    this.setShell = (node) => {
      this.shell = node;
    };
    this.setMenu = (node) => {
      this.menuNode = node;
    };
    // Set while the design's files wait for the board's model: opened on the
    // 3D view, the `.glb` in or failed tells the page and lets them go, unless
    // the reader moved to the schematic or the board first (`componentDidUpdate`).
    this.after3D = false;
    this.onFetched3D = () => {
      if (!this.after3D) return;
      this.after3D = false;
      this.props.onReady();
      this.fetchDesign(false);
    };
    this.onSelect3D = (designator) => this.select(BOARD3D, designator);
    this.onMenu3D = (designator, x, y) => this.openMenu(BOARD3D, { reference: designator }, x, y);
    this.closeMenu = () => {
      if (this.state.menu) this.setState({ menu: null, hover: -1 });
    };
    this.closeSheet = () => {
      if (this.state.sheet) this.setState({ sheet: null });
    };
    // A click on the veil itself, not one that bubbled up from the window.
    this.onVeil = (event) => {
      if (event.target === event.currentTarget) this.closeSheet();
    };
    // A press anywhere but on the menu closes it: a press on a view too, which
    // a right press must, so that a menu is open one at a time.
    this.onPress = (event) => {
      if (this.state.menu && !(this.menuNode && event.composedPath().includes(this.menuNode))) this.closeMenu();
    };
    this.onKey = (event) => this.key(event);
  }

  /** The ref callback of one view's element: holds it and listens to it, the
   *  schematic's to its page changes too (`paged`). */
  attach(context) {
    const listeners = {
      [SELECTION_EVENT]: (event) => this.picked(context, event.detail),
      pointerdown: (event) => {
        this.pressed = event.button === 2 ? { context, x: event.clientX, y: event.clientY } : null;
      },
      pointerup: (event) => this.release(context, event),
      ...(context === SCH ? { [PAGE_EVENT]: () => this.paged() } : {}),
    };
    return (element) => {
      const old = this.elements[context];
      for (const [type, listener] of Object.entries(listeners)) {
        if (old) old.removeEventListener(type, listener);
        if (element) element.addEventListener(type, listener);
      }
      this.elements[context] = element || undefined;
    };
  }

  /** The bar's Fit on the drawn view on screen: the viewer's own reset. */
  fitDrawn() {
    drawingOf(this.elements[this.side()]).viewer.zoom_fit_top_item();
  }

  /** The bar's Frame on the drawn view on screen: a frame drawn now and the
   *  canvas read in the same task, before the board's WebGL context, which
   *  keeps no drawing buffer, has handed it to the screen. */
  frameDrawn() {
    const drawing = drawingOf(this.elements[this.side()]);
    drawing.viewer.draw_now();
    return new Promise((resolve) => drawing.canvas.toBlob(resolve, 'image/png'));
  }

  /** The bar's Contents: the schematic put on its root sheet, the one with the
   *  sheet symbols (`sheetFromQuery` with no `s=`). A step of the reader's, so
   *  `paged` pushes it into the address, and Back returns to the sheet left. */
  toContents() {
    const element = this.elements[SCH];
    if (element && typeof element.switchPage === 'function') element.switchPage(sheetFromQuery(this.pages(), ''));
  }

  /** What the bar can do with the view on screen: a drawn one once its files
   *  are in, with Contents for the schematic on a sheet below its root; the 3D
   *  model once it is loaded. */
  toolsOnScreen() {
    if (this.side() === BOARD3D) return this.state.tools3d;
    if (!this.state.ready || this.state.error) return null;
    const page = this.side() === SCH && this.pages().find((one) => one.projectPath === this.page);
    return page && page.parentProjectPath ? this.sheetTools : this.drawnTools;
  }

  /** The page told what the bar can do (`onTools`), when that has changed. */
  report() {
    const tools = this.toolsOnScreen();
    if (tools === this.reported) return;
    this.reported = tools;
    this.props.onTools(tools);
  }

  /** The page-wide listeners, on or off: Escape, what closes the menu from
   *  outside the view area, and Back and Forward (`followPage`). */
  listen(on) {
    const method = on ? 'addEventListener' : 'removeEventListener';
    window[method]('keydown', this.onKey);
    window[method]('resize', this.closeMenu);
    window[method]('popstate', this.onPop);
    document[method]('pointerdown', this.onPress, true);
  }

  /** The `projectPath` of the schematic's page on screen, or null where the
   *  element cannot say (its module did not load, it has no files yet). */
  activePage() {
    const element = this.elements[SCH];
    const page = element && typeof element.getActiveSchematicPage === 'function'
      && element.getActiveSchematicPage();
    return (page && page.projectPath) || null;
  }

  /** The schematic's sheets, as its element lists them, or none. */
  pages() {
    const element = this.elements[SCH];
    return (element && typeof element.getSchematicPages === 'function' && element.getSchematicPages()) || [];
  }

  /** Does the address name this design's schematic as its document? Which
   *  document an address names is the page's that owns it: `addressDoc`,
   *  handed the query of the address now on screen (on Back and Forward the
   *  props are still those of the entry left), else its `d=`, as on the
   *  model's page, where no `d=` is the model. */
  addressed() {
    const schematic = this.members()[SCH];
    const { search } = window.location;
    const named = this.props.addressDoc ? this.props.addressDoc(search) : new URLSearchParams(search).get(DOC_QUERY);
    return Boolean(schematic) && named === schematic.id;
  }

  /** The address with `s=` naming the sheet on screen: the path and every
   *  other parameter kept, `s=` written anew (none for the root sheet), the
   *  hash kept; pushed for a step of the reader's, else replaced. */
  writeSheet(push) {
    const value = sheetQueryValue(this.pages(), this.page);
    const kept = window.location.search.slice(1).split('&')
      .filter((pair) => pair && pair.split('=')[0] !== SHEET_QUERY);
    if (value) kept.push(`${SHEET_QUERY}=${encodeURIComponent(value)}`);
    const address = window.location.pathname + (kept.length ? `?${kept.join('&')}` : '') + window.location.hash;
    window.history[push ? 'pushState' : 'replaceState'](window.history.state, '', address);
  }

  /** The schematic's element reported a change of its view. A change of page
   *  under an address naming the schematic, the member on screen, goes into
   *  the address (`writeSheet`): the reader's own is a step of the browser's
   *  history (a push), one made by a probe of the page's own (`pageProbe`) — a
   *  part selected in another view, `Show … · <sheet>` handed over from the
   *  board — rewrites the entry the browser is on. A change under an address
   *  naming another member, the schematic hidden, leaves the address alone:
   *  it takes the sheet up when a choice brings the schematic on screen
   *  (`componentDidUpdate`), and Back or Forward put the entry's own back.
   *  Not for the page the address asked for (`followPage`), which it already
   *  names, nor for the first page the element shows, which is only
   *  remembered. Every change of page is told to the bar, whose Contents
   *  depends on it (`toolsOnScreen`). */
  paged() {
    const now = this.activePage();
    if (!now || now === this.page) return;
    const before = this.page;
    this.page = now;
    this.report();
    if (now === this.pageFromHistory) {
      this.pageFromHistory = null;
      return;
    }
    if (!before || !this.addressed()) return;
    this.writeSheet(!this.probing);
  }

  /** `run` as a probe of the page's own, not the reader's: a page of the
   *  schematic it moves to rewrites the address, not added to its history
   *  (`paged`). The element reports the change inside the call, so the flag
   *  spans it alone. */
  pageProbe(run) {
    this.probing = true;
    try {
      return run();
    } finally {
      this.probing = false;
    }
  }

  /** The schematic put on the sheet the address names (`s=`, none for the
   *  root sheet) where the address names the schematic (`addressed`) and the
   *  sheet differs from the one on screen: on Back and Forward, and once the
   *  viewers are ready, for the address the design is opened under — a
   *  reload, a link, a Back onto a design no longer on the page. An `s=`
   *  naming no sheet of this schematic, or a name two of its sheets share,
   *  opens on its root. Only the address the design is opened under
   *  (`normalize`) is then rewritten in place to say the sheet on screen; Back
   *  and Forward leave the entry as it is: every entry of one build names its
   *  sheet as `writeSheet` spells it, so one naming no sheet here is another
   *  revision's, reached while this view is still mounted and the page swaps
   *  that revision in, and its sheet stays for it. An address naming another
   *  document leaves the sheet as it is. Not before the viewers are ready: the
   *  element keeps a page asked for before it has its files and shows it
   *  later, which would read as the reader's own step. */
  followPage(normalize = false) {
    const element = this.elements[SCH];
    if (!this.state.ready || !this.addressed() || !element || typeof element.switchPage !== 'function') return;
    const named = new URLSearchParams(window.location.search).get(SHEET_QUERY) || '';
    const pages = this.pages();
    const page = sheetFromQuery(pages, named);
    if (!page) return;
    if (page !== this.page) {
      this.pageFromHistory = page;
      if (!element.switchPage(page)) {
        this.pageFromHistory = null;
        return;
      }
    }
    if (normalize && sheetQueryValue(pages, page) !== named) this.writeSheet(false);
  }

  /** The design's listed members, by view. */
  members() {
    return designMembers(this.props.documents, this.props.doc);
  }

  /** The view on screen: the one of the document the page hands down. */
  side() {
    return viewOf(this.props.doc);
  }

  /** What a click in the drawn view `from` selected, as its element reports
   *  it. A click on nothing at all (an empty `itemType`) puts out what is lit
   *  in every view (`clear`), else the other views follow (`select`). A right
   *  click being answered (`release`) opens its menu on it. */
  picked(from, detail) {
    if (detail && detail.itemType === '') this.clear();
    else this.select(from, (detail && detail.reference) || null);
    const at = this.pointing;
    if (at && at.from === from) {
      this.pointing = null;
      this.openMenu(from, detail, at.x, at.y);
    }
  }

  /** A click in `from` selected the part `designator`, or something that is
   *  no part (null): the other views follow, none of them brought on screen.
   *  A view without that part (a power symbol has no footprint, a fiducial no
   *  symbol) answers false and drops what it had selected, as for no part.
   *  The methods are checked because an element is a plain one when the
   *  viewer's module failed to load. */
  select(from, designator) {
    for (const context of drawnViews(this.members())) {
      const element = this.elements[context];
      if (context === from || !element) continue;
      const found = Boolean(designator) && typeof element.requestCrossProbe === 'function'
        && this.pageProbe(() => element.requestCrossProbe(
          { targetContext: context, kind: 'designator', value: designator })) !== false;
      if (!found && typeof element.clearSelection === 'function') element.clearSelection();
    }
    if (designator !== this.state.selected) this.setState({ selected: designator });
  }

  /** Nothing selected anywhere: every view puts out what it has lit, the one
   *  on screen included — the viewer keeps a part it was asked to light from
   *  another view lit through a click on the bare board. */
  clear() {
    for (const context of drawnViews(this.members())) {
      const element = this.elements[context];
      if (element && typeof element.clearSelection === 'function') element.clearSelection();
    }
    if (this.state.selected !== null) this.setState({ selected: null });
  }

  /** Escape closes the datasheet's window, or the menu, or else puts out what
   *  is lit everywhere: one thing per Escape, and one that closed the window is
   *  taken, as the page takes one that closed something of its own. Not while
   *  typing: the page may have a field open over the design. */
  key(event) {
    if (event.key !== 'Escape' || event.defaultPrevented || typingTarget()) return;
    if (this.state.sheet) {
      event.preventDefault();
      this.closeSheet();
    } else if (this.state.menu) {
      this.closeMenu();
    } else {
      this.clear();
    }
  }

  /** A right press released on a drawn view. Released where it was pressed it
   *  is a click on what is under the pointer, which the viewer is asked for as
   *  for a left click: the point goes to the canvas the press landed on as the
   *  move and the click the viewer picks with, and the selection that click
   *  reports opens the menu (`picked`). Released anywhere else, the viewer
   *  panned with it.
   *
   *  The same click on a label or a sheet pin opens the schematic's own list
   *  of the label's namesakes (`kc-sch-selection-menu`), which stays open
   *  after our menu; a list that click opened is closed again, as the viewer
   *  itself closes it (`hidden`). One the reader opened with the left button
   *  is left as it is. */
  release(context, event) {
    const { pressed } = this;
    this.pressed = null;
    if (event.button !== 2 || !pressed || pressed.context !== context
      || Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) >= PAN_SLOP) return;
    const [canvas] = event.composedPath();
    if (!canvas || canvas.localName !== 'canvas') return;
    const at = { clientX: event.clientX, clientY: event.clientY };
    const list = labelList(canvas);
    const listShut = Boolean(list && list.hidden);
    this.pointing = { from: context, x: event.clientX, y: event.clientY };
    canvas.dispatchEvent(new MouseEvent('mousemove', at));
    canvas.dispatchEvent(new MouseEvent('click', { ...at, button: 0, detail: 1 }));
    this.pointing = null;
    if (listShut && !list.hidden) list.hidden = true;
  }

  /** The menu for what `from` selected, at the page point `x`,`y`, in place of
   *  any other: none when there is nothing to offer. */
  openMenu(from, detail, x, y) {
    const members = this.members();
    const sheet = selectedDatasheet(detail && detail.reference, this.state.datasheets, members, this.props.documents);
    const menu = menuFor(from, detail, members, sheet, this.state.nets);
    if (!menu) {
      this.closeMenu();
      return;
    }
    const area = this.shell ? this.shell.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    const text = labelsWidth(menu.items.map((item) => item.label));
    const box = menuPlace(x - area.left, y - area.top, menu.items.length, area, text);
    this.setState({ menu: { ...menu, from, ...box }, hover: -1 });
  }

  /** An item of the menu. A datasheet opens in the window over the view
   *  area, the page asked for nothing. Another sheet of the schematic on
   *  screen: its element is asked now, the page asked for nothing, as it
   *  shows what it showed. Another member of the design: the page is asked to
   *  open it, and it selects the same thing once the page has handed it down
   *  (`componentDidUpdate`); the 3D view is handed the part. */
  choose(item) {
    const { menu } = this.state;
    this.closeMenu();
    if (!menu) return;
    if (item.doc) {
      this.setState({ sheet: { doc: item.doc, from: menu.from } });
      return;
    }
    if (item.view === BOARD3D) {
      if (item.request.value !== this.state.selected) this.setState({ selected: item.request.value });
    } else {
      const element = this.elements[item.view];
      if (!element) return;
      if (item.view === menu.from) {
        element.requestCrossProbe(item.request);
        return;
      }
      this.probe = { to: item.view, request: item.request };
    }
    if (this.props.onOpen) this.props.onOpen(item.id);
  }

  componentDidMount() {
    this.listen(true);
    this.report();
    if (!drawnViews(this.members()).length) this.setState({ ready: true });
    if (this.side() === BOARD3D) this.after3D = true;
    else this.fetchDesign(true);
  }

  /** The 2D views' files fetched and handed to their elements; the page told
   *  once they are in or one failed when `tell` is set — when they are what
   *  is on screen. */
  fetchDesign(tell) {
    const { base } = this.props;
    const members = this.members();
    const views = drawnViews(members);
    if (!views.length) return;
    const files = designFiles(members);
    const count = meter((received) => {
      if (!this._gone) this.setState({ received });
    });
    const arrived = Promise.all(files.map((file) => fetchBody(fileUrl(base, file), count, true)
      .catch((error) => {
        throw new Error(`${file} did not load: ${error.message}`);
      })));
    arrived.then(() => {
      if (this._gone) return;
      this.setState({ got: true });
      if (tell) this.props.onReady();
    }, () => {
      if (!this._gone && tell) this.props.onReady();
    });
    // The full bar is painted before the files are read and handed over.
    Promise.all([loadEcadViewer(), arrived])
      .then(([, texts]) => painted().then(() => texts))
      .then((texts) => {
        if (this._gone) return undefined;
        const byPath = Object.fromEntries(files.map((file, i) => [file, texts[i]]));
        const sources = designSources(members, byPath);
        const revisionKey = `${base}${designKey(this.props.doc)}`;
        const loaded = Promise.all(views.map((context) => this.elements[context]
          && this.elements[context].replaceSources({ revisionKey, sources: sources[context] })));
        // Read once the viewers have their files, so that they need not wait for
        // it. The root schematic is the schematic member's own file, the first
        // of its `schematics`.
        const root = members[SCH] && members[SCH].kicad.schematics[0];
        this.setState({ datasheets: partDatasheets(byPath), nets: netIndex(byPath, root) });
        return loaded;
      })
      .then(() => {
        // The schematic goes to the sheet the address names, from the page it
        // opened on, which the bar is told of. A part selected in the 3D view
        // while the files came in is selected in the viewers now: they had
        // nothing to select it in then.
        if (!this._gone) {
          this.setState({ ready: true }, () => {
            this.page = this.activePage();
            this.report();
            this.followPage(true);
            this.select(BOARD3D, this.state.selected);
          });
        }
      }, (error) => {
        if (!this._gone) this.setState({ error: error.message || String(error) });
      });
  }

  componentDidUpdate(before) {
    this.activate();
    this.report();
    // The schematic come on screen. Put there by Back or Forward, it goes to
    // the sheet the entry names (`followPage`). No `popstate` listener uses
    // capture, so they run in registration order: where the page's comes
    // first (the model's page registers it before the design mounts), React
    // runs this update before `onPop`, so the sheet is put here; where ours
    // ran first, the sheet is already put and this call does nothing. Put
    // there by a choice, which wrote its `d=` with no `s=`, the address takes
    // up the sheet it is on, which may be another than the root (`paged`), in
    // the entry the choice wrote.
    if (this.page && this.side() === SCH && viewOf(before.doc) !== SCH && this.addressed()) {
      if (window.event && window.event.type === 'popstate') this.followPage();
      else this.writeSheet(false);
    }
    // The menu and the datasheet's window go with their view off the screen.
    if (this.state.menu && this.state.menu.from !== this.side()) this.closeMenu();
    if (this.state.sheet && this.state.sheet.from !== this.side()) this.closeSheet();
    // Opened on the 3D view and moved off it before the `.glb` came in: the
    // files of the view now on screen wait for nothing.
    if (this.after3D && this.side() !== BOARD3D) {
      this.after3D = false;
      this.fetchDesign(true);
    }
    // Handed over once the viewer has its files: an empty one finds nothing
    // and the probe would be spent on it.
    const { probe } = this;
    if (probe && probe.to === this.side() && this.state.ready) {
      this.probe = null;
      const target = this.elements[probe.to];
      if (target && typeof target.requestCrossProbe === 'function') {
        this.pageProbe(() => target.requestCrossProbe(probe.request));
      }
    }
  }

  componentWillUnmount() {
    this._gone = true;
    this.listen(false);
  }

  /** Tell each element whether it is the one on screen. */
  activate() {
    for (const context of drawnViews(this.members())) {
      const element = this.elements[context];
      if (element && typeof element.setActive === 'function') element.setActive(context === this.side());
    }
  }

  render() {
    const side = this.side();
    const members = this.members();
    const { ready, error, selected, menu, hover, sheet, received, got } = this.state;
    // The 2D views' loading and failure, over them only: the 3D view says its own.
    const total = drawnViews(members).reduce((sum, view) => sum + members[view].bytes, 0);
    const note = side !== BOARD3D && (error || (!ready && loadBar(received, total, got)));
    const shown = (context) => `${VIEWER};visibility:${context === side ? 'visible' : 'hidden'}`;
    const model = members[BOARD3D] && fileUrl(this.props.base, members[BOARD3D].file);
    return (
      <div ref={this.setShell} style={css(SHELL)} onWheelCapture={this.closeMenu}>
        {drawnViews(members).map((context) => (
          <ecad-viewer key={context} ref={this.refCallbacks[context]} source-mode="host"
                       show-header="false" hide-chrome="true" data-view={context}
                       style={css(shown(context))} />
        ))}
        {ready && !error && members[PCB] && <PcbPanel element={this.elements[PCB]} active={side === PCB} />}
        {model && (
          <div key={BOARD3D} data-view={BOARD3D} style={css(shown(BOARD3D))}>
            <BoardView3D key={model} url={model} bytes={members[BOARD3D].bytes} active={side === BOARD3D}
                         selected={selected} onSelect={this.onSelect3D} onMenu={this.onMenu3D}
                         onTools={this.onTools3D} onFetched={this.onFetched3D} />
          </div>
        )}
        {note && <div style={css(NOTE)}>{note}</div>}
        {menu && menu.from === side && (
          <div data-menu={menu.from} ref={this.setMenu} style={css(menuBox(menu))}
               onContextMenu={(event) => event.preventDefault()}>
            <div style={css(MENU_NAME)}>{menuHead(menu)}</div>
            {menu.items.map((item, index) => (
              <div key={index} data-show={item.view || 'datasheet'} title={item.label}
                   style={css(menuItem(index === hover))}
                   onMouseEnter={() => this.setState({ hover: index })}
                   onMouseLeave={() => this.setState({ hover: -1 })}
                   onClick={() => this.choose(item)}>{item.label}</div>
            ))}
          </div>
        )}
        {/* An open `[role="dialog"][data-state="open"]` on the page also keeps
            the viewer's own keys (`[`, `]`: the schematic's sheets) off the
            design under it. */}
        {sheet && sheet.from === side && (
          <div data-sheet={sheet.doc.id} style={css(SHEET_VEIL)} onClick={this.onVeil}>
            <div role="dialog" aria-label={sheet.doc.name} data-state="open" style={css(SHEET_WINDOW)}>
              <div style={css(SHEET_HEAD)}>
                <div title={sheet.doc.name} style={css(SHEET_NAME)}>{sheet.doc.name}</div>
                <div title="Close" style={css(SHEET_CLOSE)} onClick={this.closeSheet}>×</div>
              </div>
              <div style={css(SHEET_BODY)}>
                <DocumentView key={sheet.doc.id} doc={sheet.doc} base={this.props.base}
                              documents={this.props.documents} />
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
}
