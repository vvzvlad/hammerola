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
//     anything that is not a part (a wire, a track, the bare board) puts the
//     part out in the others. Nets are not carried across this way;
//   * a double click JUMPS: an element reports `ecad-viewer:crossprobe`, the 3D
//     view `onJump`, and this component asks the page to open another member
//     (`jumpTarget`; `onOpen` with its id, which moves the lit row of its list
//     too) and, once the page has handed that member down, asks its element to
//     select the same thing — a part by its designator, or a net by its name
//     (`crossProbeRequest`). Nothing jumps TO the 3D view: one opens it from the
//     list, where the part is already lit.

import React from 'react';

import BoardView3D from './BoardView3D.jsx';
import { addPinEntries } from './kicadpins.js';
import PcbPanel from './PcbPanel.jsx';
import { css, MONO } from './style.jsx';

/** Where the hub serves the viewer; `parser.worker.js` is fetched beside it. */
export const ECAD_VIEWER_URL = '/_v/ecad-viewer.js';

/** The event an element reports a double click with. */
export const CROSSPROBE_EVENT = 'ecad-viewer:crossprobe';

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

/** Where a double click in `from` jumps, the first of these that is listed:
 *  the schematic and the board to each other, the 3D model to the board, else
 *  the schematic. Null when none is. */
const JUMPS = { [SCH]: [PCB], [PCB]: [SCH], [BOARD3D]: [PCB, SCH] };
export const jumpTarget = (from, members) => (JUMPS[from] || []).find((view) => members[view]) || null;

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
 * What the other view is asked to select for a double click one reported, or
 * null: a part by its designator (a symbol, a pin, a footprint), else a net by
 * its name (a label, a pad, a track).
 */
export function crossProbeRequest(detail, targetContext) {
  if (detail && detail.reference) return { targetContext, kind: 'designator', value: detail.reference };
  if (detail && detail.net) return { targetContext, kind: 'net', value: detail.net };
  return null;
}

const SHELL = 'position:relative;height:100%;min-height:320px';
const VIEWER = 'position:absolute;top:0;left:0;width:100%;height:100%;display:block';
const NOTE = `position:absolute;top:0;left:0;padding:24px 28px;font:400 12.5px ${MONO};color:var(--text-muted)`;

/** One design: a view per member, the one on screen, and the links between
 *  them. */
export default class KicadView extends React.Component {
  constructor(props) {
    super(props);
    // `selected`: the designator of the part selected in the design, which the
    // 3D view is handed; the elements are told directly.
    this.state = { ready: false, error: '', selected: null };
    // A selection waiting for the page to hand down the member it is on:
    // `{ to, request }`, or null.
    this.probe = null;
    this.elements = {};
    // One ref callback per view, made once, so React does not detach and
    // reattach the listeners on every render.
    this.refCallbacks = { [SCH]: this.attach(SCH), [PCB]: this.attach(PCB) };
    this.onSelect3D = (designator) => this.select(BOARD3D, designator);
    this.onJump3D = (designator) => this.relay(BOARD3D, { reference: designator });
  }

  /** The ref callback of one view's element: holds it and listens to it. */
  attach(context) {
    const listeners = {
      [CROSSPROBE_EVENT]: (event) => this.relay(context, event.detail),
      [SELECTION_EVENT]: (event) => this.select(context, (event.detail && event.detail.reference) || null),
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

  /** The design's listed members, by view. */
  members() {
    return designMembers(this.props.documents, this.props.doc);
  }

  /** The view on screen: the one of the document the page hands down. */
  side() {
    return viewOf(this.props.doc);
  }

  /** A double click in `from`: the page is asked to open the member it jumps
   *  to, and the same thing is selected there once it is on screen
   *  (`componentDidUpdate`). */
  relay(from, detail) {
    const members = this.members();
    const to = jumpTarget(from, members);
    const request = to && crossProbeRequest(detail, to);
    if (!request || !this.elements[to]) return;
    this.probe = { to, request };
    if (this.props.onOpen) this.props.onOpen(members[to].id);
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

  componentDidMount() {
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
        const sources = designSources(members, Object.fromEntries(files.map((file, i) => [file, texts[i]])));
        const revisionKey = `${base}${designKey(this.props.doc)}`;
        return Promise.all(views.map((context) => this.elements[context]
          && this.elements[context].replaceSources({ revisionKey, sources: sources[context] })));
      })
      .then(() => {
        if (!this._gone) this.setState({ ready: true });
      }, (error) => {
        if (!this._gone) this.setState({ error: error.message || String(error) });
      });
  }

  componentDidUpdate() {
    this.activate();
    const { probe } = this;
    if (probe && probe.to === this.side()) {
      this.probe = null;
      const target = this.elements[probe.to];
      if (target && typeof target.requestCrossProbe === 'function') target.requestCrossProbe(probe.request);
    }
  }

  componentWillUnmount() {
    this._gone = true;
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
    const { ready, error, selected } = this.state;
    // The 2D views' loading and failure, over them only: the 3D view says its own.
    const note = side !== BOARD3D && (error || (!ready && 'Loading…'));
    const shown = (context) => `${VIEWER};visibility:${context === side ? 'visible' : 'hidden'}`;
    const model = members[BOARD3D] && fileUrl(this.props.base, members[BOARD3D].file);
    return (
      <div style={css(SHELL)}>
        {drawnViews(members).map((context) => (
          <ecad-viewer key={context} ref={this.refCallbacks[context]} source-mode="host"
                       show-header="false" hide-chrome="true" data-view={context}
                       style={css(shown(context))} />
        ))}
        {ready && !error && members[PCB] && <PcbPanel element={this.elements[PCB]} active={side === PCB} />}
        {model && (
          <div key={BOARD3D} data-view={BOARD3D} style={css(shown(BOARD3D))}>
            <BoardView3D key={model} url={model} active={side === BOARD3D} selected={selected}
                         onSelect={this.onSelect3D} onJump={this.onJump3D} />
          </div>
        )}
        {note && <div style={css(NOTE)}>{note}</div>}
      </div>
    );
  }
}
