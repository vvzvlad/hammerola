// One KiCad design, as the documents of a build it is made of: its schematic
// and its board, each in an `<ecad-viewer>` of its own, the board's 3D model
// in BoardView3D.jsx, and the schematic's BOM, a table of ours. DocumentView.jsx
// draws a document of type `schematic`, `bom`, `board` or `board3d` with this.
//
// A DESIGN is the listed schematic, board and 3D model with one path minus the
// extension (`designKey`): `hw/board.kicad_sch`, `hw/board.kicad_pcb` and
// `hw/board.glb` are one, and so is the BOM the page lists after the
// schematic, under the schematic's file (kicadbom.js). Each is its own
// document and its own row of the page's list of views (viewlist.jsx); WHICH
// ONE IS ON SCREEN IS THE PAGE'S, the document it hands down as `doc`. The
// page keys this component by the design (`docViewKey` in DocumentView.jsx),
// so moving between two members of one design keeps this instance and all its
// views. A member with no listed
// sibling is a design of one.
//
// THE PAGE KEEPS THE DESIGN while another document or the model is on screen
// (`DocumentLayers` in DocumentView.jsx), handing it `shown` false. Hidden, it
// draws nothing, its elements inactive, its menu and datasheet's window shut,
// its page-wide listeners deaf, and it calls none of the page's doors —
// `onTools`, `onReady`, `onSheet`, `onOpen`, the comments' — a fetch landing
// meanwhile included. Shown again, it tells the bar what it can do, tells
// `onReady` where that is owed, and puts the schematic on
// the sheet the address names, as a fresh mount does (`followPage`).
//
// The viewer is the vendored `ecad-viewer.js` (static/_v/PROVENANCE.md),
// fetched by URL only when a design is opened: nothing of it is in this bundle.
// In `source-mode="host"` it reads nothing by itself; this component fetches the
// members' files from the build (meta.json names them, `kicad`) and hands them
// over as `{filename, content}`, under their paths in the tree, so a sheet's
// `Sheetfile` resolves against them as KiCad resolves it.
//
// WHAT IS ON SCREEN DOWNLOADS FIRST. Opened on the 3D view, the design fetches
// the schematic's and the board's files only once the board's `.glb` has come
// in or failed to (`onFetched3D`), or the reader has moved to one of them, so
// the two do not share the line; the page is told the view on screen has its
// file(s) through `onReady` (DocumentView.jsx). While those files come in, the
// 2D views show the bar of loadbar.jsx, filled to the schematic's and the
// board's `bytes`, and a part selected in the 3D view, or asked for by `Show
// in …`, is selected in them once they are drawn.
//
// EVERY MEMBER'S VIEW STAYS MOUNTED. The ones not on screen — all of them
// while the design is hidden — are hidden with `visibility`, not `display`, so
// each keeps its size, its camera and its selection, and is told it is inactive
// (`setActive`, `active`), which stops its drawing until it is back. So is a 2D
// view on screen until its files are drawn: before that the viewer shows only
// its own spinner, where the load bar stands, and it is fitted to the size it
// keeps hidden.
//
// A CHANGE OF THE SCHEMATIC'S PAGE IS A STEP OF THE BROWSER'S HISTORY, whatever
// makes it: a double click on a sheet symbol, a place chosen in the viewer's
// list of a net, the viewer's own `[`, `]` and Alt+Backspace. The element
// reports each one (`PAGE_EVENT`), and this component reports the sheet to
// the page as `s=` says it (`onSheet`, `sheetQueryValue`), which writes it
// into the address beside the `d=` of the schematic, as a view is `v=`, and
// nothing here writes the address itself. Back and Forward (`subscribe` in
// address.js), a reload, a link and a sheet chosen in the list of views
// (`SheetRows` in viewlist.jsx) put the sheet the address names on screen
// (`followPage`), opened whole as the viewer opens a sheet itself, not at the
// camera it was left at. The root sheet has no `s=`, so a design opened from
// the list of views after another document starts on it (`pushChoice`, and
// `pick` in DocShell.jsx, drop `s=`). Moving between the board and the
// schematic of one design keeps the schematic's sheet — one element, kept, and
// a part clicked on the board may have moved it there on purpose — and the
// address takes it up when a choice of the reader's brings the schematic on
// screen; Back or Forward bringing it puts the entry's sheet back instead
// (`followPage`). A sheet this component moves the schematic to on screen —
// a part selected in another view, `Show … · <sheet>` handed over from the
// board — rewrites the address rather than adding to its history; a move of
// the schematic while it is hidden leaves the address alone (`paged`).
//
// `hide-chrome` leaves each element its canvas alone. It drops the viewer's own
// panels (layers, objects, nets, properties), which `show-header="false"`
// already keeps off screen, and its corner mark: Prism's logo, a single node the
// viewer shares between all its elements on a page, so one element showed it
// and the other an empty circle. The board gets a panel of ours instead
// (PcbPanel.jsx), drawn over it once its files are loaded.
//
// THE VIEWS ARE LINKED HERE, not in the viewer, three ways:
//   * a click that selects a part in one view selects it in the others too,
//     hidden as they are, and changes nothing on screen: an element reports it
//     as `ecad-viewer:selection`, the 3D view through `onSelect`; a click on
//     anything that is not a part (a wire, a track) puts the part out in the
//     others. A click on nothing at all, and Escape, put out what is lit in
//     EVERY view, the clicked one included: the viewer itself leaves a part lit
//     through a click on the bare board. Nets are not carried across this way;
//   * a click of EITHER BUTTON on what has a net in the schematic (a label, a
//     power symbol, a sheet pin, a wire joined to one of them) opens the
//     viewer's own list of the net's places, a row `<sheet>:<name>` each and
//     ‹ › to step through them, at the pointer, on the place clicked where it
//     is one (`openList`, and the element's `showNetList`, an edit of ours:
//     static/_v/PROVENANCE.md, "Our edits"). A place chosen there the viewer
//     frames itself, on its sheet. The places are this component's (`netList`):
//     every occurrence of the net on every sheet. Its last row, `Show net
//     <name> in <name>`, shows the net on the board where the design lists
//     one. It opens only where it has somewhere to go: two places, or the
//     board row. A power symbol (`#PWR`) is no part, being on the schematic
//     only, but the net its `Value` names; a power flag (`#FLG`) is neither.
//     The element's own list on a click on a label or a sheet pin, which goes
//     by the label's name alone, is off (`show-selection-panel="false"`);
//   * the RIGHT BUTTON on a part, or on the board on what has a net (a track,
//     a via, a zone), opens a menu at the pointer (`menuFor`), headed with the
//     part, the net, or both: a pad of the board is both. The part has an item
//     `Show <ref> in <name>` for every other listed member; the net `Show net
//     <name> in <name>` for the schematic — the 3D model has no nets — or,
//     where the sheets name it, one item per sheet it is on, `… · <sheet>`,
//     aimed at its first occurrence there; a net no sheet names keeps the one
//     item, and the viewer looks it up.
//
// WHAT IS ONE NET is read from the sheets' texts and the board's (kicadnets.js):
// the occurrences of one name on the board, `board` — global labels and power
// symbols of one name, which KiCad joins across the whole design, and
// hierarchical labels of one name with the sheet pins of that name, through
// which the sheet that draws a sheet symbol wires them together, so that net's
// places include that sheet. A local label's net is on its own sheet alone. A
// wire run joins the nets of what stands on it, so the list for a wire, and for
// each thing on the run, has the places of all of them (`boards`).
//
// AN ITEM OF ANOTHER MEMBER, the menu's and the list's board row, asks the page
// to open it (`onOpen` with its id, which moves the lit row of its list too)
// and, once the page has handed it down, asks its element to select the same
// thing — a part by its designator, a net by its name, and for a sheet's item
// on that sheet at that occurrence (`requestCrossProbe`); the 3D view is handed
// the part as `selected`. The board is asked for a net a sheet names by the
// board's name of it (`/amp/OUT_C` for a local label `OUT_C` on the sheet
// `amp`); the lines show the name clicked, a label's own or the one the board
// reported.
//
// WHAT IS UNDER THE POINTER at a right click is the element's own hit test,
// `selectAt`: it selects there what a left click there selects, and the
// selection it reports is what the menu or the list is for. The thing is
// selected too, as a right click in KiCad selects it. A right press the viewer
// panned with (it pans from `PAN_SLOP` on) is no click. The 3D view picks with
// its own raycast.
//
// THE MENU is one at a time, inside the view area, drawn as the viewer's own
// list is, in its colours (`--menu-*` in static/_v/tokens.css) and its font; it
// goes on Escape, a press anywhere else, the wheel, a resize, and when its view
// leaves the screen. The viewer's list goes on a press anywhere but on it, so
// the two are never open together.
//
// THE WHEEL ON THE SCHEMATIC AND THE BOARD, and HOW A SELECTION LOOKS there,
// are the viewer's own doing: both are edits of ours to its source in
// ecad-viewer/ (static/_v/PROVENANCE.md, "Our edits"), so nothing on this side
// takes the event or paints anything. A two-finger swipe of a touchpad moves the
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
// (BoardView3D.jsx).
//
// THE BOM is the schematic's bill of materials as the viewer computes it from
// the files the schematic's element is handed (`getBomItems`, an edit of ours:
// static/_v/PROVENANCE.md, "Our edits"), read once the viewers have them and
// drawn as a table in the page's colours: kicad-cli's default columns, a row
// per footprint, value and DNP, the designators in KiCad's order (`bomRows` in
// kicadbom.js). Until then it shows the load bar, as the 2D views do. Once
// read it stays mounted, hidden off screen as every member's view is, so Back
// from the board finds the table where it was scrolled to; it has nothing for
// Fit and Frame, nor takes a comment (`COMMENTABLE` in DocumentView.jsx). A
// designator selects its part in every view, as a click on the part in one
// does, and then does what the part's `Show <ref> in <board>` item does
// (`showPart`): the page opens the board with the part selected there. A
// design that lists no board has its designators as plain text.
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
//
// COMMENTS (`comment`, handed by both pages: comments.jsx). With the page's
// Comment tool armed (`on`) the drawn view on screen is in the viewer's
// comment mode, where a drag draws a rubber band; the area drawn goes
// to the page (`onArea`) as the place of a comment — its sheet's file on the
// schematic, `[x, y, w, h]` in the document's millimetres, and what is inside
// it as the element reads it (`itemsInArea`). The open comments of each drawn
// member and the draft (`marks`) stand on it as the viewer's markers, each with
// its area dashed, on the schematic those of the sheet on screen only
// (`commentMarks`); a click on one names its comment to the page
// (`onMarker`). A place the page asks to be shown (`focus`, a comment's row in
// its rail) is put on screen once the member it is on is: the schematic goes
// to its sheet — as the reader's own step of history where the page took none
// for it (`step`), else rewriting the entry the page wrote — and the view is
// moved to the area's centre (`zoomToLocation`), after the sheet has loaded;
// the page is then told (`onFocused`). The 3D model takes the same, its own
// way (`comment3D`, BoardView3D.jsx): a click on a part is the place, the
// marks are arrows on parts, the focus frames a part, and the ids of comments
// on parts the model does not have go back to the page (`onLost`).

import React from 'react';

import { parse, subscribe, unsubscribe } from './address.js';
import BoardView3D from './BoardView3D.jsx';
import DocumentView from './DocumentView.jsx';
import { BOM_TYPE, bomRows } from './kicadbom.js';
import { netIndex } from './kicadnets.js';
import { sheetName } from './kicadpages.js';
import { datasheetBase, datasheetDocument, partDatasheets } from './kicadsheets.js';
import { fetchBody, loadBar, meter, painted } from './loadbar.jsx';
import { ELLIPSIS, POP_SHADOW_HIGH } from './panelstyle.js';
import PcbPanel from './PcbPanel.jsx';
import { css, MONO, SANS } from './style.jsx';
import { typingTarget } from './viewport/holdkey.js';

/** Where the hub serves the viewer; `parser.worker.js` is fetched beside it. */
export const ECAD_VIEWER_URL = '/_v/ecad-viewer.js';

/** How far a press may move before the viewer pans with it (`drag_threshold`
 *  in ecad-viewer/packages/ecad-viewer-app/src/base/dom/move-and-zoom.ts): a
 *  right press released nearer than this is a click. */
export const PAN_SLOP = 3;

/** The event an element reports a click's selection with
 *  (`EcadSemanticSelectionEvent`): a symbol, a pin, a footprint or a pad carries
 *  its part's `reference`, anything else none, an empty click `itemType: ''`. */
export const SELECTION_EVENT = 'ecad-viewer:selection';

/** The event an element reports a change of its view with: once, at once,
 *  inside `switchPage` and every other change of the schematic's page, and
 *  for other changes of its project too, so the page itself is compared. */
export const PAGE_EVENT = 'ecad-viewer:view-state-change';

/** The events of the viewer's comment mode and markers: an area drawn
 *  (`{ context, bounds, page }`), a marker clicked (`{ commentId }`), and a
 *  sheet of the schematic loaded and drawn. */
export const AREA_EVENT = 'ecad-viewer:comment-area';
export const MARKER_EVENT = 'ecad-viewer:comment-overlay-click';
export const SHEET_LOADED_EVENT = 'kicanvas:sheet:loaded';

/** The id the draft's marker stands under among `marks`. */
export const DRAFT_MARK = 'draft';

/**
 * The markers of `marks` (`{ id, doc, sheet, area }`) on the document `file`,
 * as the element's `setCommentOverlays` takes them: one at the centre of each
 * area, the area dashed around it. `sheet`, where given, keeps those on that
 * sheet's file alone: the viewer draws every marker it holds on whichever
 * sheet is on screen.
 */
export function commentMarks(marks, file, sheet) {
  return (marks || []).filter((one) => one.doc === file && Array.isArray(one.area)
    && (sheet === undefined || one.sheet === sheet))
    .map(({ id, sheet: page, area: [x, y, w, h] }) => ({
      id,
      anchor: { kind: 'world', x: x + w / 2, y: y + h / 2, ...(page ? { page } : {}) },
      areaBounds: [x, y, w, h],
    }));
}

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

/** The address on screen as far as what it names goes: its path and query. */
function addressNow() {
  const at = parse();
  return `${at.path}?${at.params.join('&')}`;
}

/** The views of a design: the two by the names the viewer gives them
 *  (`targetContext`), the 3D model of the board, and the schematic's BOM. */
export const SCH = 'SCH';
export const PCB = 'PCB';
export const BOARD3D = '3D';
export const BOM = 'BOM';

/** The view each document type of a design is, by meta.json's `type`
 *  (`render.DOCUMENT_TYPES` on the hub), and the BOM's, which the page adds
 *  itself (kicadbom.js). */
export const DESIGN_VIEWS = { schematic: SCH, board: PCB, board3d: BOARD3D, [BOM_TYPE]: BOM };

/** The views the viewer draws, each in an element of its own. */
const DRAWN = [SCH, PCB];

/** The view `doc` is of its design, or undefined for any other document. */
export const viewOf = (doc) => (Object.prototype.hasOwnProperty.call(DESIGN_VIEWS, doc.type)
  ? DESIGN_VIEWS[doc.type] : undefined);

/** The design `doc` is a member of: its path without the extension, or null
 *  for a document that is not a schematic, its BOM, a board or a board's 3D
 *  model. */
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
export const fileUrl = (base, file) => `${base}${file.split('/').map(encodeURIComponent).join('/')}`;

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

/** What each element is handed, from the files' texts by path. */
export function designSources(members, texts) {
  const source = (filename) => ({ filename, content: texts[filename] });
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
 * (kicadnets.js) holds for its uuid, and so is a wire; a power flag names none.
 */
export function crossProbeRequest(detail, targetContext, nets = NO_NETS) {
  const { reference, net, uuid } = detail || {};
  const own = nets.byUuid.get(uuid);
  const name = net || (own && (own.kind === 'power' || own.kind === 'wire') ? own.name : '');
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
 * (kicadnets.js), in the order of `nets`.
 */
function netSheets(nets, board) {
  const first = new Map();
  for (const one of nets.occurrences) {
    if (one.board === board && !first.has(one.sheet)) first.set(one.sheet, one);
  }
  return [...first.values()];
}

/**
 * The viewer's own list for a net the schematic reported selected (`detail`),
 * with the sheets' nets `nets`: `items`, every occurrence of the net on every
 * sheet, in the order of `nets`, as `{ sheet, name, uuid }` — for what stands
 * on a wire run, of every net of the run (`boards`) — and `board`, the row that
 * shows the net on the board where the design lists one (an item as a menu's
 * is, `show`), or null. The board is asked for the net by the board's name of
 * it, the occurrence's `board` where the index holds one; the line shows the
 * name reported (`crossProbeRequest`). Null for what is no net, and where
 * there is nowhere to go: fewer than two places and no board.
 */
export function netList(detail, members, nets = NO_NETS) {
  const { net } = crossProbeRequest(detail, null, nets);
  if (!net) return null;
  const own = nets.byUuid.get(detail.uuid);
  const boards = (own && own.boards) || [own ? own.board : net.value];
  const items = nets.occurrences.filter((one) => boards.includes(one.board))
    .map(({ sheet, name, uuid }) => ({ sheet, name, uuid }));
  const board = members[PCB] ? { view: PCB, id: members[PCB].id, label: `Show net ${net.value} in ${members[PCB].name}`,
    request: { targetContext: PCB, kind: 'net', value: own ? own.board : net.value } } : null;
  return items.length >= 2 || board ? { items, board } : null;
}

/**
 * The right-click menu for what view `from` reported selected (`detail`; the
 * 3D view's part as `{ reference }`), with the sheets' nets `nets`: the part
 * and the net it shows (`crossProbeRequest`), either null, and the items, each
 * carrying the request its view is asked (`request`). The part's first, an
 * item for every other listed member that can show it; then the net's, the
 * same but for the schematic where the sheets name the net (`netSheets`),
 * which has an item per sheet it is on instead, the request carrying the
 * sheet's path and the occurrence's uuid. A net the schematic reports has the
 * viewer's own list instead (`netList`), so a net here is the board's, by the
 * board's name of it. Last, for a part, the document its datasheet names
 * (`sheet`, or null), which its item carries as `doc`. Null when there is no
 * item.
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
    const sheets = netSheets(nets, net.value);
    for (const view of SHOWS.net.filter((one) => members[one])) {
      const label = `Show net ${net.value} in ${members[view].name}`;
      if (view === SCH && sheets.length) {
        for (const one of sheets) {
          offer(view, `${label} · ${sheetName(one.sheet)}`, { ...net, net: net.value, sheet: one.sheet, uuid: one.uuid });
        }
      } else if (view !== from) {
        offer(view, label, net);
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

/** The menu's box, known before it is drawn, so that where it fits is too. It
 *  is drawn as the viewer's own list of a net's places is
 *  (`kc-schematic/selection-pop-menu.ts` in ecad-viewer/), in its font and
 *  its spacing: `BOX_PAD` around everything, the head line parted from the
 *  items by a rule with `GAP` on either side, each item `ITEM_PAD` inside and
 *  `GAP` from the next. Every line is `LINE` high where the viewer's are of
 *  the font's `normal` height, so that the height is known before the menu is
 *  drawn. At least `MENU_WIDTH` wide, wider where a line needs it, and
 *  `MENU_PAD` of it the box's and the items' padding on either side. An
 *  item's font is what `labelsWidth` measures its line in. */
const LIST_FONT = '"Segoe UI",Helvetica,Arial,sans-serif';
const ITEM_FONT = '400 12px';
const LINE = 15;
const BOX_PAD = [8, 10];
const ITEM_PAD = [2, 4];
const GAP = 6;
const MENU_WIDTH = 160;
const MENU_PAD = 2 * BOX_PAD[1] + 2 * ITEM_PAD[1];
const MENU_HEAD = LINE + GAP + 1 + GAP;
const MENU_ROW = LINE + 2 * ITEM_PAD[0];
/** How far the menu keeps from the view area's edges. */
const MENU_MARGIN = 8;
export const menuHeight = (rows) => 2 * BOX_PAD[0] + MENU_HEAD + rows * MENU_ROW + (rows - 1) * GAP;

/** How wide the widest of `labels` is drawn in the font of the menu's items:
 *  measured in a hidden line laid out in the page, so 0 where nothing is laid
 *  out. The family is spelled out: the page's font properties are set on the
 *  element it mounts into, not on `body`. A sheet's item ends with the sheet's
 *  name, which a cut would hide. */
function labelsWidth(labels) {
  const line = document.createElement('span');
  line.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${ITEM_FONT} ${LIST_FONT}`;
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
// The menu as the viewer's own list of a net's places is drawn (`menuHeight`),
// in a box of a known size (`menuPlace`): an item under the pointer takes the
// list's hover ink.
const RULE = 'color-mix(in srgb, var(--menu-fg) 20%, transparent)';
const menuBox = ({ left, top, width }) => `position:absolute;left:${left}px;top:${top}px;width:${width}px;`
  + `z-index:1;box-sizing:border-box;padding:${BOX_PAD[0]}px ${BOX_PAD[1]}px;`
  + 'background:var(--menu-bg);color:var(--menu-fg);border-radius:5px;box-shadow:0 0 10px var(--menu-shadow)';
const MENU_NAME = `font:600 12px/${LINE}px ${LIST_FONT};padding-bottom:${GAP}px;margin-bottom:${GAP}px;`
  + `border-bottom:1px solid ${RULE};${ELLIPSIS}`;
const menuItem = (hover, first) => `font:${ITEM_FONT}/${LINE}px ${LIST_FONT};`
  + `padding:${ITEM_PAD[0]}px ${ITEM_PAD[1]}px;border-radius:3px;`
  + (first ? '' : `margin-top:${GAP}px;`) + `${ELLIPSIS};cursor:pointer;user-select:none;transition:color .3s;`
  + `color:${hover ? 'var(--menu-fg-hover)' : 'var(--menu-fg)'}`;
// The datasheet's window, in the page's colours: a veil over the whole view
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
// The BOM: a table as a markdown document's is drawn (docmd.js), over the whole
// view area and scrolling inside it. The view area already stops above the
// page's bar (`DOC_LAYER` in viewlist.jsx), so the bar covers no row of it.
const BOM_PAGE = 'position:absolute;inset:0;overflow:auto;padding:24px 28px;box-sizing:border-box';
const BOM_TABLE = `border-collapse:collapse;font:400 12.5px ${SANS};color:var(--text)`;
const BOM_HEAD = `border:1px solid var(--line);padding:4px 10px;text-align:left;font:600 12px ${SANS};`
  + 'background:var(--sunken-bg)';
const BOM_CELL = 'border:1px solid var(--line);padding:4px 10px;vertical-align:top';
const BOM_REF = 'color:var(--accent-text);cursor:pointer';
/** The BOM's columns: kicad-cli's default (`sch export bom`). */
const BOM_COLUMNS = ['Refs', 'Value', 'Footprint', 'Qty', 'DNP'];

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
    // `bom`: the schematic's BOM in its order (`bomRows`), once it has its files.
    this.state = {
      ready: false, error: '', selected: null, datasheets: new Map(), nets: NO_NETS, menu: null, hover: -1, sheet: null,
      tools3d: null, received: 0, got: false, bom: [],
    };
    // What the bar can do with a drawn view on screen, one object for both, and
    // the last thing the page was told (`report`).
    this.drawnTools = { fit: () => this.fitDrawn(), frame: () => this.frameDrawn() };
    this.reported = undefined;
    this.onTools3D = (tools) => this.setState({ tools3d: tools });
    // A selection waiting for the page to hand down the member it is on:
    // `{ to, request }`, or null.
    this.probe = null;
    // A right press on a drawn view until it is released, `{ context, x, y }`;
    // while the viewer is asked what is under it, the point its menu opens
    // at, `{ from, x, y }`; and the last press of any button on a drawn view,
    // `{ x, y }`, where the viewer's list of a net opens (`openList`).
    this.pressed = null;
    this.pointing = null;
    this.down = null;
    // The schematic's page on screen (its `projectPath`), and the one the
    // address asked for while the element switches to it (`followPage`).
    this.page = null;
    this.pageFromHistory = null;
    // The address this component last saw: its last update's, its own
    // (`tellSheet`), Back's and Forward's (`componentDidUpdate`).
    this.seen = addressNow();
    this.onPop = () => {
      if (!this.onScreen()) return;
      this.seen = addressNow();
      this.followPage();
    };
    // Set while the page itself probes an element (`pageProbe`).
    this.probing = false;
    // Comments: what each element was last told — its comment mode and its
    // markers, by view — the page's `focus` last put on screen, and the
    // centre to move to once the sheet a focus switched to has loaded.
    this.commenting = {};
    this.overlaid = {};
    this.focused = null;
    this.zoomTo = null;
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
    // Set where the page was not told `onReady` because the design was hidden.
    this.owed = false;
    this.onFetched3D = () => {
      if (!this.after3D) return;
      this.after3D = false;
      this.tellReady();
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
   *  schematic's to its page changes and loads too (`paged`, `sheetLoaded`). */
  attach(context) {
    const listeners = {
      [SELECTION_EVENT]: (event) => this.picked(context, event.detail),
      pointerdown: (event) => {
        this.pressed = event.button === 2 ? { context, x: event.clientX, y: event.clientY } : null;
        this.down = { x: event.clientX, y: event.clientY };
      },
      pointerup: (event) => this.release(context, event),
      [AREA_EVENT]: (event) => this.area(context, event.detail),
      [MARKER_EVENT]: (event) => this.marker(event.detail),
      ...(context === SCH ? { [PAGE_EVENT]: () => this.paged(), [SHEET_LOADED_EVENT]: () => this.sheetLoaded() } : {}),
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

  /** What the bar can do with the view on screen: a drawn one once its files
   *  are in, the 3D model once it is loaded, the BOM nothing. */
  toolsOnScreen() {
    const side = this.side();
    if (side === BOARD3D) return this.state.tools3d;
    return DRAWN.includes(side) && this.state.ready && !this.state.error ? this.drawnTools : null;
  }

  /** The page told what the bar can do (`onTools`), when that has changed;
   *  nothing while the design is hidden. */
  report() {
    if (!this.onScreen()) return;
    const tools = this.toolsOnScreen();
    if (tools === this.reported) return;
    this.reported = tools;
    this.props.onTools(tools);
  }

  /** Is the design on screen? Unless the page says it keeps it hidden. */
  onScreen() {
    return this.props.shown !== false;
  }

  /** The page told the view on screen has its file(s) (`onReady`), or, while
   *  the design is hidden, owed that until it is shown. */
  tellReady() {
    if (this.onScreen()) this.props.onReady();
    else this.owed = true;
  }

  /** The page-wide listeners, on or off: Escape, what closes the menu from
   *  outside the view area, and Back and Forward (`followPage`). */
  listen(on) {
    const method = on ? 'addEventListener' : 'removeEventListener';
    window[method]('keydown', this.onKey);
    window[method]('resize', this.closeMenu);
    (on ? subscribe : unsubscribe)(this.onPop);
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

  /** The schematic's BOM, as its element computes it, or none. */
  bomItems() {
    const element = this.elements[SCH];
    return (element && typeof element.getBomItems === 'function' && element.getBomItems()) || [];
  }

  /** Does the address name this design's schematic as its document? Which
   *  document an address names is the page's that owns it: `addressDoc`,
   *  handed the address now on screen (on Back and Forward the props are
   *  still those of the entry left), else its `d=`, as on the model's page,
   *  where no `d=` is the model. */
  addressed() {
    const schematic = this.members()[SCH];
    const at = parse();
    const named = this.props.addressDoc ? this.props.addressDoc(at) : at.doc;
    return Boolean(schematic) && named === schematic.id;
  }

  /** The sheet on screen told to the page as `s=` says it ('' for the root
   *  sheet, which has none), which writes it into the address (`onSheet`):
   *  as a step of history for a step of the reader's (`push`), else in place
   *  of the entry on screen. The page need not draw anything for it (it does
   *  only while the list of views is open), so the address it writes is noted
   *  as seen here (`componentDidUpdate`). */
  tellSheet(push) {
    this.props.onSheet(sheetQueryValue(this.pages(), this.page), push);
    this.seen = addressNow();
  }

  /** The schematic's element reported a change of its view. A change of page
   *  under an address naming the schematic, the member on screen, goes into
   *  the address (`tellSheet`): the reader's own is a step of the browser's
   *  history (a push), one made by a probe of the page's own (`pageProbe`) — a
   *  part selected in another view, `Show … · <sheet>` handed over from the
   *  board — rewrites the entry the browser is on. A change under an address
   *  naming another member, the schematic hidden, leaves the address alone:
   *  it takes the sheet up when a choice brings the schematic on screen
   *  (`componentDidUpdate`), and Back or Forward put the entry's own back.
   *  Not for the page the address asked for (`followPage`), which it already
   *  names, nor for the first page the element shows, which is only
   *  remembered.
   *
   *  A change that is not a probe of the page's own — the reader's, and the
   *  one the address asks for (`followPage`) — puts out the selection kept
   *  from the page left: the viewer keeps the box of its last selection
   *  across a change of page and paints it again whenever the element is
   *  made active (`activate`), so the sheet symbol whose double click enters
   *  a sheet would stand selected over the sheet it opens. A probe keeps the
   *  selection it made: the viewer focuses its target once the sheet is
   *  open, and a selection put out meanwhile cancels that. The highlighted
   *  nets stay.
   *
   *  Every change of page hands the element the new sheet's comment markers
   *  at once (`overlay`): the element may still be loading that sheet, and
   *  draws them with it once it is drawn. */
  paged() {
    const now = this.activePage();
    if (!now || now === this.page) return;
    const before = this.page;
    this.page = now;
    const element = this.elements[SCH];
    if (!this.probing && typeof element.clearSelection === 'function') {
      element.clearSelection({ keepHighlights: true });
    }
    this.overlay();
    if (now === this.pageFromHistory) {
      this.pageFromHistory = null;
      return;
    }
    if (!before || !this.addressed()) return;
    this.tellSheet(!this.probing);
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
   *  sheet as `tellSheet` says it, so one naming no sheet here is another
   *  revision's, reached while this view is still mounted and the page swaps
   *  that revision in, and its sheet stays for it. An address naming another
   *  document leaves the sheet as it is. Not before the viewers are ready: the
   *  element keeps a page asked for before it has its files and shows it
   *  later, which would read as the reader's own step. */
  followPage(normalize = false) {
    const element = this.elements[SCH];
    if (!this.state.ready || !this.addressed() || !element || typeof element.switchPage !== 'function') return;
    const named = parse().sheet || '';
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
    if (normalize && sheetQueryValue(pages, page) !== named) this.tellSheet(false);
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
   *  in every view (`clear`), else the other views follow (`select`). A net
   *  of the schematic, by either button, opens the viewer's own list of its
   *  places (`openList`), and our menu is shut; anything else a right click
   *  being answered (`release`) is on opens our menu on it. */
  picked(from, detail) {
    if (detail && detail.itemType === '') this.clear();
    else this.select(from, (detail && detail.reference) || null);
    const at = this.pointing;
    if (at && at.from === from) this.pointing = null;
    if (from === SCH && crossProbeRequest(detail, SCH, this.state.nets).net) {
      this.closeMenu();
      this.openList(detail);
    } else if (at && at.from === from) {
      this.openMenu(from, detail, at.x, at.y);
    }
  }

  /** The schematic's own list of the places of the net `detail` is on, at
   *  the last press on a drawn view, its board row last (`netList`): a place
   *  chosen in it the viewer frames itself, the board row is an item as a
   *  menu's is (`show`). Nothing where there is nowhere to go. */
  openList(detail) {
    const list = netList(detail, this.members(), this.state.nets);
    if (!list) return;
    const actions = list.board ? [{ label: list.board.label, run: () => this.show(list.board) }] : [];
    this.elements[SCH].showNetList({ items: list.items, activeUuid: detail.uuid, actions, at: this.down });
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
   *  typing: the page may have a field open over the design, nor while the
   *  design is hidden. */
  key(event) {
    if (!this.onScreen() || event.key !== 'Escape' || event.defaultPrevented || typingTarget()) return;
    if (this.state.sheet) {
      event.preventDefault();
      this.closeSheet();
    } else if (this.state.menu) {
      this.closeMenu();
    } else {
      this.clear();
    }
  }

  /** A right press released on a drawn view's canvas. Released where it was
   *  pressed it is a click on what is under the pointer, which the element is
   *  asked for (`selectAt`), and the selection it reports opens the menu or
   *  the viewer's list (`picked`). Released anywhere else, the viewer panned
   *  with it. */
  release(context, event) {
    const { pressed } = this;
    this.pressed = null;
    if (event.button !== 2 || !pressed || pressed.context !== context
      || Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) >= PAN_SLOP) return;
    const [canvas] = event.composedPath();
    if (!canvas || canvas.localName !== 'canvas') return;
    this.pointing = { from: context, x: event.clientX, y: event.clientY };
    try {
      this.elements[context].selectAt(event.clientX, event.clientY);
    } finally {
      this.pointing = null;
    }
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
   *  area, the page asked for nothing; any other item shows its member
   *  (`show`). */
  choose(item) {
    const { menu } = this.state;
    this.closeMenu();
    if (!menu) return;
    if (item.doc) {
      this.setState({ sheet: { doc: item.doc, from: menu.from } });
      return;
    }
    this.show(item);
  }

  /** An item `{ view, id, request }` of another member chosen: a menu's, a
   *  designator of the BOM (`showPart`), or the board row of the viewer's
   *  list of a net (`openList`). The page is asked to open the member, and it
   *  selects the same thing once the page has handed it down
   *  (`componentDidUpdate`); the 3D view is handed the part. */
  show(item) {
    if (item.view === BOARD3D) {
      if (item.request.value !== this.state.selected) this.setState({ selected: item.request.value });
    } else {
      if (!this.elements[item.view]) return;
      this.probe = { to: item.view, request: item.request };
    }
    if (this.props.onOpen) this.props.onOpen(item.id);
  }

  /** A designator of the BOM clicked: the part selected in every view, as a
   *  click on it in one is (`select`), and then what its `Show <ref> in
   *  <board>` item does (`menuFor`), the board opened with the part selected. */
  showPart(designator) {
    const board = this.members()[PCB];
    this.select(BOM, designator);
    this.show({ view: PCB, id: board.id, request: { targetContext: PCB, kind: 'designator', value: designator } });
  }

  /** The viewer's comment mode on the drawn view on screen while the page's
   *  tool is armed, off on the others and on all of a hidden design, each told
   *  only of a change. */
  armComment() {
    const on = this.onScreen() && Boolean(this.props.comment && this.props.comment.on) && this.state.ready
      && !this.state.error;
    for (const context of drawnViews(this.members())) {
      const element = this.elements[context];
      const want = on && context === this.side();
      if (!element || typeof element.setCommentMode !== 'function' || this.commenting[context] === want) continue;
      this.commenting[context] = want;
      element.setCommentMode(want);
    }
  }

  /** Each drawn member's markers (`commentMarks`), the schematic's for the
   *  sheet on screen, each element told only of a change. Not before the
   *  viewers have drawn: a viewer without its layers drops the markers it is
   *  handed. */
  overlay() {
    if (!this.state.ready || this.state.error) return;
    const marks = (this.props.comment && this.props.comment.marks) || [];
    const members = this.members();
    for (const context of drawnViews(members)) {
      const element = this.elements[context];
      if (!element || typeof element.setCommentOverlays !== 'function') continue;
      const page = context === SCH && element.getActiveSchematicPage();
      const comments = commentMarks(marks, members[context].file,
        context === SCH ? (page && page.filename) || '' : undefined);
      const key = JSON.stringify(comments);
      if (this.overlaid[context] === key) continue;
      this.overlaid[context] = key;
      element.setCommentOverlays({ context, comments });
    }
  }

  /** An area drawn on view `context` in comment mode, handed to the page with
   *  what is inside it. */
  area(context, detail) {
    const { comment } = this.props;
    const doc = this.members()[context];
    if (!comment || !this.onScreen() || !doc || !detail || !Array.isArray(detail.bounds)) return;
    const element = this.elements[context];
    comment.onArea(doc, {
      frame: context === SCH ? 'sheet' : 'board',
      sheet: context === SCH ? detail.page || null : null,
      area: detail.bounds,
      items: typeof element.itemsInArea === 'function' ? element.itemsInArea(context, detail.bounds) : [],
    });
  }

  /** A marker clicked: its comment named to the page; the draft's is no
   *  comment yet. */
  marker(detail) {
    const { comment } = this.props;
    if (comment && this.onScreen() && detail && detail.commentId && detail.commentId !== DRAFT_MARK) {
      comment.onMarker(detail.commentId);
    }
  }

  /** What the 3D model needs for comments (BoardView3D.jsx): the tool armed
   *  while it is on screen, the marks and the focus on its file, and the
   *  doors back, the draft's arrow naming nothing (`marker`) and never lost.
   *  None while the design is hidden. */
  comment3D() {
    const { comment } = this.props;
    const model = this.members()[BOARD3D];
    if (!comment || !model || !this.onScreen()) return null;
    return {
      on: Boolean(comment.on) && this.side() === BOARD3D,
      marks: (comment.marks || []).filter((one) => one.doc === model.file && one.part),
      focus: comment.focus && comment.focus.doc === model.file ? comment.focus : null,
      onPoint: (place) => comment.onArea(model, { frame: 'part', ...place }),
      onMarker: (id) => this.marker({ commentId: id }),
      onFocused: comment.onFocused,
      onLost: (ids) => comment.onLost(model.file, ids.filter((id) => id !== DRAFT_MARK)),
    };
  }

  /** The area the page asks to be shown (`focus`), once the drawn member it
   *  is on is on screen and drawn, the schematic on the sheet it opened on. */
  followFocus() {
    const { comment } = this.props;
    const focus = comment && comment.focus;
    const side = this.side();
    const member = this.members()[side];
    if (!focus || focus === this.focused || !this.onScreen() || !this.state.ready || !member
      || member.file !== focus.doc || !Array.isArray(focus.area) || (side === SCH && !this.page)) return;
    this.focused = focus;
    const [x, y, w, h] = focus.area;
    this.zoomTo = { x: x + w / 2, y: y + h / 2 };
    const element = this.elements[side];
    const target = side === SCH && this.pages().find((one) => one.filename === focus.sheet);
    const run = () => element.switchPage(target.projectPath);
    if (!target || target.projectPath === this.page || !(focus.step ? run() : this.pageProbe(run))) this.sheetLoaded();
    comment.onFocused();
  }

  /** A sheet of the schematic is loaded and drawn: the view goes to the
   *  centre a focus is waiting to show. Also the end of a focus that switched
   *  no sheet. It waits a task: the viewer fits the sheet to the screen once
   *  its load returns, after this event. */
  sheetLoaded() {
    const at = this.zoomTo;
    this.zoomTo = null;
    if (!at) return;
    setTimeout(() => {
      const element = this.elements[this.side()];
      if (!this._gone && element && typeof element.zoomToLocation === 'function') element.zoomToLocation(at.x, at.y);
    }, 0);
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
   *  is on screen — or owed that while the design is hidden (`tellReady`). */
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
      if (tell) this.tellReady();
    }, () => {
      if (!this._gone && tell) this.tellReady();
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
        // opened on. A part selected in the 3D view while the files
        // came in is selected in the viewers now: they had nothing to select
        // it in then. A place the page asked to show comes after both. The
        // BOM is the schematic's element's, computed as it loaded its files.
        if (!this._gone) {
          this.setState({ ready: true, bom: bomRows(this.bomItems()) }, () => {
            this.page = this.activePage();
            this.followPage(true);
            this.select(BOARD3D, this.state.selected);
            this.followFocus();
          });
        }
      }, (error) => {
        if (!this._gone) this.setState({ error: error.message || String(error) });
      });
  }

  componentDidUpdate(before) {
    const visible = this.onScreen();
    // Shown again after the page kept it hidden: the bar told afresh, and the
    // page `onReady` where that is owed.
    const back = visible && Boolean(before) && before.shown === false;
    if (back) this.reported = undefined;
    this.activate();
    this.report();
    this.armComment();
    this.overlay();
    if (back && this.owed) {
      this.owed = false;
      this.props.onReady();
    }
    // Shown again, the schematic goes to the sheet the address names, as on a
    // fresh mount (`followPage`); hidden, it follows nothing. Otherwise: the
    // schematic on screen under an address naming it, the address changed
    // since the one this component last saw: its last update's, its own
    // (`tellSheet`), and Back's and Forward's, which `onPop` follows —
    // address.js hands it the entry before React runs the page's update for
    // it. An update the page makes later — a click, a revision it swaps in —
    // so leaves alone an entry Back put back, another revision's `s=`
    // included: what is followed here is an address the page has just written
    // for a choice. Just come on screen by a choice that wrote its `d=` with
    // no `s=` — its row in the list of views, `Show in …` from the board — the
    // address takes up the sheet it is on, which may be another than the root
    // (`paged`), in the entry the choice wrote. Otherwise it goes to the sheet
    // the address names (`followPage`, which does nothing where that sheet is
    // on screen): a sheet chosen in the list of views, over the schematic or
    // over another member. Such an address is this build's own and is spelled
    // as `tellSheet` says it once the sheet is put (`followPage`'s
    // `normalize`): the root's row names the root by its path (`SheetRows` in
    // viewlist.jsx).
    const address = addressNow();
    const moved = address !== this.seen;
    this.seen = address;
    if (back) {
      this.followPage(true);
    } else if (visible && moved && this.page && this.side() === SCH && this.addressed()) {
      if (viewOf(before.doc) !== SCH && !parse().sheet) this.tellSheet(false);
      else this.followPage(true);
    }
    // The menu and the datasheet's window go with their view off the screen,
    // and with the design.
    if (this.state.menu && (!visible || this.state.menu.from !== this.side())) this.closeMenu();
    if (this.state.sheet && (!visible || this.state.sheet.from !== this.side())) this.closeSheet();
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
    // After the address has taken up the sheet on screen, above: a focus's
    // own switch of sheet rewrites what it wrote.
    this.followFocus();
  }

  componentWillUnmount() {
    this._gone = true;
    this.listen(false);
  }

  /** Tell each element whether it is the one on screen: none of a hidden
   *  design is. */
  activate() {
    const visible = this.onScreen();
    for (const context of drawnViews(this.members())) {
      const element = this.elements[context];
      if (element && typeof element.setActive === 'function') element.setActive(visible && context === this.side());
    }
  }

  render() {
    const side = this.side();
    const members = this.members();
    const { ready, error, selected, menu, hover, sheet, received, got, bom } = this.state;
    // The 2D views' loading and failure, over them and over the BOM, which is
    // read out of the schematic's: the 3D view says its own.
    const total = drawnViews(members).reduce((sum, view) => sum + members[view].bytes, 0);
    const note = side !== BOARD3D
      && (error ? <div style={css(NOTE)}>{error}</div> : !ready && loadBar(received, total, got));
    // The view drawn: none while the design is hidden, whose layer is hidden
    // too, which a child marked `visible` would show through. A 2D viewer is
    // shown only once its files are drawn: before that it draws nothing but its
    // own spinner, in the middle, where the load bar stands.
    const showing = this.onScreen() ? side : null;
    const visible = (context) => context === showing && (ready || context === BOARD3D);
    const shown = (context) => `${VIEWER};visibility:${visible(context) ? 'visible' : 'hidden'}`;
    const model = members[BOARD3D] && fileUrl(this.props.base, members[BOARD3D].file);
    return (
      <div ref={this.setShell} style={css(SHELL)} onWheelCapture={this.closeMenu}>
        {drawnViews(members).map((context) => (
          <ecad-viewer key={context} ref={this.refCallbacks[context]} source-mode="host"
                       show-header="false" hide-chrome="true" show-selection-panel="false" data-view={context}
                       style={css(shown(context))} />
        ))}
        {ready && !error && members[PCB] && <PcbPanel element={this.elements[PCB]} active={showing === PCB} />}
        {model && (
          <div key={BOARD3D} data-view={BOARD3D} style={css(shown(BOARD3D))}>
            <BoardView3D key={model} url={model} bytes={members[BOARD3D].bytes} active={showing === BOARD3D}
                         selected={selected} onSelect={this.onSelect3D} onMenu={this.onMenu3D}
                         onTools={this.onTools3D} onFetched={this.onFetched3D} comment={this.comment3D()} />
          </div>
        )}
        {/* The BOM, once the schematic's element has its files. A designator is
            a link to the part on the board where the design lists one. Kept
            mounted off screen, as every member's view is, so that Back from the
            board finds the table where it was scrolled to. */}
        {members[BOM] && ready && !error && (
          <div data-view={BOM} style={css(`${BOM_PAGE};visibility:${showing === BOM ? 'visible' : 'hidden'}`)}>
            <table style={css(BOM_TABLE)}>
              <thead>
                <tr>{BOM_COLUMNS.map((name) => <th key={name} style={css(BOM_HEAD)}>{name}</th>)}</tr>
              </thead>
              <tbody>
                {bom.map((row) => (
                  <tr key={row.references[0]}>
                    <td style={css(BOM_CELL)}>
                      {row.references.map((ref, i) => (
                        <React.Fragment key={ref}>
                          {i > 0 && ', '}
                          {members[PCB] ? (
                            <span data-ref={ref} style={css(BOM_REF)} onClick={() => this.showPart(ref)}>{ref}</span>
                          ) : ref}
                        </React.Fragment>
                      ))}
                    </td>
                    {[row.value, row.footprint, row.qty, row.dnp ? 'DNP' : ''].map((cell, i) => (
                      <td key={i} style={css(BOM_CELL)}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {note}
        {menu && menu.from === side && (
          <div data-menu={menu.from} ref={this.setMenu} style={css(menuBox(menu))}
               onContextMenu={(event) => event.preventDefault()}>
            <div style={css(MENU_NAME)}>{menuHead(menu)}</div>
            {menu.items.map((item, index) => (
              <div key={index} data-show={item.view || 'datasheet'} title={item.label}
                   style={css(menuItem(index === hover, index === 0))}
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
