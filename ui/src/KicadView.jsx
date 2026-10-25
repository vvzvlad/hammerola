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
// EVERY MEMBER'S VIEW STAYS MOUNTED. The ones not on screen are hidden with
// `visibility`, not `display`, so each keeps its size, its camera and its
// selection, and is told it is inactive (`setActive`, `active`), which stops its
// drawing until it is back.
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
//     a net (a track, a via, a zone, a label), opens a menu at the pointer:
//     `Show in <name>` for every other listed member that can show it, a net
//     not the 3D model (`menuFor`). An item asks the page to open that member
//     (`onOpen` with its id, which moves the lit row of its list too) and, once
//     the page has handed it down, asks its element to select the same thing —
//     a part by its designator, a net by its name (`crossProbeRequest`); the 3D
//     view is handed the part as `selected`. A power symbol (`#PWR`, `#FLG`)
//     has no menu: it is on the schematic only.
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
// board's copper pours stay on screen while it is selected.
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
import DocumentView from './DocumentView.jsx';
import { addPinEntries } from './kicadpins.js';
import { datasheetBase, datasheetDocument, partDatasheets } from './kicadsheets.js';
import { ELLIPSIS, POP_SHADOW_HIGH } from './panelstyle.js';
import PcbPanel from './PcbPanel.jsx';
import { css, MONO, SANS } from './style.jsx';
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

/**
 * What another view is asked to select for what a view reported selected, or
 * null: a part by its designator (a symbol, a pin, a footprint, a pad), else a
 * net by its name (a label, a track, a via, a zone).
 */
export function crossProbeRequest(detail, targetContext) {
  if (detail && detail.reference) return { targetContext, kind: 'designator', value: detail.reference };
  if (detail && detail.net) return { targetContext, kind: 'net', value: detail.net };
  return null;
}

/** The views that can show a part and a net, in the order a menu lists them:
 *  the 3D model has parts and no nets. */
const SHOWS = { designator: [SCH, PCB, BOARD3D], net: [SCH, PCB] };

/**
 * The right-click menu for what view `from` reported selected (`detail`; the
 * 3D view's part as `{ reference }`): what it shows, and an item for every
 * other listed member that can show it, named after that document, then for a
 * part the document its datasheet names (`sheet`, or null), which its item
 * carries as `doc`. Null when there is no item, and for a designator KiCad
 * starts with `#`: a power symbol or a power flag is drawn on the schematic
 * only, never placed on the board.
 */
export function menuFor(from, detail, members, sheet = null) {
  const subject = crossProbeRequest(detail, null);
  if (!subject || (subject.kind === 'designator' && subject.value.startsWith('#'))) return null;
  const items = SHOWS[subject.kind].filter((view) => view !== from && members[view])
    .map((view) => ({ view, id: members[view].id, label: `Show in ${members[view].name}` }));
  if (sheet && subject.kind === 'designator') {
    items.push({ id: sheet.id, label: `Open datasheet · ${sheet.name}`, doc: sheet });
  }
  return items.length ? { kind: subject.kind, value: subject.value, items } : null;
}

/** The viewer's own list of a label's namesakes (`kc-sch-selection-menu`),
 *  beside `canvas` in the shadow tree of its schematic app, or null. */
function labelList(canvas) {
  for (let root = canvas.getRootNode(); root && root.querySelector; root = root.host ? root.host.getRootNode() : null) {
    const list = root.querySelector('kc-sch-selection-menu');
    if (list) return list;
  }
  return null;
}

/** The menu's box, fixed, so that where it fits is known before it is drawn:
 *  a head line, a row per item, 2px and 6px of padding and a 1px border. */
const MENU_WIDTH = 220;
const MENU_HEAD = 27;
const MENU_ROW = 30;
/** How far the menu keeps from the view area's edges. */
const MENU_MARGIN = 8;
export const menuHeight = (rows) => MENU_HEAD + rows * MENU_ROW + 10;

/**
 * Where a menu opened at `x`,`y` of an area `area` wide and high goes: right of
 * and below the pointer where that fits, else left of or above it, and never
 * past the area's edges; narrower than its width where the area is.
 */
export function menuPlace(x, y, rows, area) {
  const width = Math.max(0, Math.min(MENU_WIDTH, area.width - 2 * MENU_MARGIN));
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
const menuItem = (hover) => `height:${MENU_ROW}px;box-sizing:border-box;padding:8px 14px 0;${ELLIPSIS};`
  + `font:400 12px ${SANS};color:var(--text);cursor:pointer;user-select:none`
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
    // part's `Datasheet` value, once the files are in. `menu`: the right-click
    // menu open (`menuFor`, with the view it is of and its box), `hover` the
    // index of the item under the pointer. `sheet`: the datasheet's window open,
    // `{ doc, from }` with the view it was opened over. `tools3d`: what the 3D
    // view told the bar it can do, or null.
    this.state = {
      ready: false, error: '', selected: null, datasheets: new Map(), menu: null, hover: -1, sheet: null, tools3d: null,
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
    // and while the viewer is asked what is under it, the point its menu opens
    // at, `{ from, x, y }`.
    this.pressed = null;
    this.pointing = null;
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

  /** The ref callback of one view's element: holds it and listens to it. */
  attach(context) {
    const listeners = {
      [SELECTION_EVENT]: (event) => this.picked(context, event.detail),
      pointerdown: (event) => {
        this.pressed = event.button === 2 ? { context, x: event.clientX, y: event.clientY } : null;
      },
      pointerup: (event) => this.release(context, event),
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
   *  are in, the 3D model once it is loaded. */
  toolsOnScreen() {
    if (this.side() === BOARD3D) return this.state.tools3d;
    return this.state.ready && !this.state.error ? this.drawnTools : null;
  }

  /** The page told what the bar can do (`onTools`), when that has changed. */
  report() {
    const tools = this.toolsOnScreen();
    if (tools === this.reported) return;
    this.reported = tools;
    this.props.onTools(tools);
  }

  /** The page-wide listeners, on or off: Escape, and what closes the menu
   *  from outside the view area. */
  listen(on) {
    const method = on ? 'addEventListener' : 'removeEventListener';
    window[method]('keydown', this.onKey);
    window[method]('resize', this.closeMenu);
    document[method]('pointerdown', this.onPress, true);
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
        && element.requestCrossProbe({ targetContext: context, kind: 'designator', value: designator }) !== false;
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
    const menu = menuFor(from, detail, members, sheet);
    if (!menu) {
      this.closeMenu();
      return;
    }
    const area = this.shell ? this.shell.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    const box = menuPlace(x - area.left, y - area.top, menu.items.length, area);
    this.setState({ menu: { ...menu, from, ...box }, hover: -1 });
  }

  /** An item of the menu. A datasheet opens in the window over the view
   *  area, the page asked for nothing. A member of the design: the page is
   *  asked to open it, and it selects the same thing once the page has handed
   *  it down (`componentDidUpdate`); the 3D view is handed the part. */
  choose(item) {
    const { menu } = this.state;
    this.closeMenu();
    if (!menu) return;
    if (item.doc) {
      this.setState({ sheet: { doc: item.doc, from: menu.from } });
      return;
    }
    if (item.view === BOARD3D) {
      if (menu.value !== this.state.selected) this.setState({ selected: menu.value });
    } else {
      if (!this.elements[item.view]) return;
      this.probe = { to: item.view, request: { targetContext: item.view, kind: menu.kind, value: menu.value } };
    }
    if (this.props.onOpen) this.props.onOpen(item.id);
  }

  componentDidMount() {
    this.listen(true);
    this.report();
    const { base } = this.props;
    const members = this.members();
    const views = drawnViews(members);
    if (!views.length) {
      this.setState({ ready: true });
      return;
    }
    const files = designFiles(members);
    const fetched = files.map((file) => fetch(fileUrl(base, file))
      .then((response) => {
        if (!response.ok) throw new Error(`${file} did not load: HTTP ${response.status}`);
        return response.text();
      }));
    Promise.all([loadEcadViewer(), ...fetched])
      .then(([, ...texts]) => {
        if (this._gone) return undefined;
        const byPath = Object.fromEntries(files.map((file, i) => [file, texts[i]]));
        const sources = designSources(members, byPath);
        const revisionKey = `${base}${designKey(this.props.doc)}`;
        const loaded = Promise.all(views.map((context) => this.elements[context]
          && this.elements[context].replaceSources({ revisionKey, sources: sources[context] })));
        // Read once the viewers have their files, so that they need not wait for it.
        this.setState({ datasheets: partDatasheets(byPath) });
        return loaded;
      })
      .then(() => {
        if (!this._gone) this.setState({ ready: true });
      }, (error) => {
        if (!this._gone) this.setState({ error: error.message || String(error) });
      });
  }

  componentDidUpdate() {
    this.activate();
    this.report();
    // The menu and the datasheet's window go with their view off the screen.
    if (this.state.menu && this.state.menu.from !== this.side()) this.closeMenu();
    if (this.state.sheet && this.state.sheet.from !== this.side()) this.closeSheet();
    const { probe } = this;
    if (probe && probe.to === this.side()) {
      this.probe = null;
      const target = this.elements[probe.to];
      if (target && typeof target.requestCrossProbe === 'function') target.requestCrossProbe(probe.request);
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
    const { ready, error, selected, menu, hover, sheet } = this.state;
    // The 2D views' loading and failure, over them only: the 3D view says its own.
    const note = side !== BOARD3D && (error || (!ready && 'Loading…'));
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
            <BoardView3D key={model} url={model} active={side === BOARD3D} selected={selected}
                         onSelect={this.onSelect3D} onMenu={this.onMenu3D} onTools={this.onTools3D} />
          </div>
        )}
        {note && <div style={css(NOTE)}>{note}</div>}
        {menu && menu.from === side && (
          <div data-menu={menu.from} ref={this.setMenu} style={css(menuBox(menu))}
               onContextMenu={(event) => event.preventDefault()}>
            <div style={css(MENU_NAME)}>{menu.kind === 'net' ? `net ${menu.value}` : menu.value}</div>
            {menu.items.map((item, index) => (
              <div key={item.id} data-show={item.view || 'datasheet'} title={item.label}
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
