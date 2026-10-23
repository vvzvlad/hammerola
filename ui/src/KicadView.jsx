// One KiCad design, as a document of a build: its schematic and its board,
// each in an `<ecad-viewer>` of its own. DocumentView.jsx draws a document of
// type `kicad` with this.
//
// WHICH SIDE IS ON SCREEN IS THE PAGE'S, not this component's: the schematic
// and the board are two rows of the page's list of views (viewlist.jsx), and
// the side chosen there arrives here as `side`.
//
// The viewer is the vendored `ecad-viewer.js` (static/_v/PROVENANCE.md),
// fetched by URL only when a design is opened: nothing of it is in this bundle.
// In `source-mode="host"` it reads nothing by itself; this component fetches the
// design's files from the build (meta.json names them, `kicad`) and hands them
// over as `{filename, content}`, under their paths in the tree, so a sheet's
// `Sheetfile` resolves against them as KiCad resolves it. A schematic is handed
// over with the pin entries the viewer needs to draw pins (kicadpins.js).
//
// BOTH ELEMENTS STAY MOUNTED. The one not on screen is hidden with `visibility`,
// not `display`, so it keeps its size, its camera and its selection, and is
// told it is inactive (`setActive`), which stops its drawing until it is back.
//
// `hide-chrome` leaves each element its canvas alone. It drops the viewer's own
// panels (layers, objects, nets, properties), which `show-header="false"`
// already keeps off screen, and its corner mark: Prism's logo, a single node the
// viewer shares between all its elements on a page, so one element showed it
// and the other an empty circle.
//
// THE TWO ARE LINKED HERE, not in the viewer: a double click in one reports
// `ecad-viewer:crossprobe`, and this component asks the page for the other side
// (`onSide`, which moves the lit row of its list too) and, once the page has
// handed that side down, asks the other element to select the same thing — a
// part by its designator, or a net by its name (`crossProbeRequest`).

import React from 'react';

import { addPinEntries } from './kicadpins.js';
import { css, MONO } from './style.jsx';

/** Where the hub serves the viewer; `parser.worker.js` is fetched beside it. */
export const ECAD_VIEWER_URL = '/_v/ecad-viewer.js';

/** The event an element reports a double click with. */
export const CROSSPROBE_EVENT = 'ecad-viewer:crossprobe';

/** The two views, by the names the viewer gives them (`targetContext`). */
export const SCH = 'SCH';
export const PCB = 'PCB';
/** What the page's list calls each side. */
export const SIDE_NAMES = { [SCH]: 'Schematic', [PCB]: 'PCB' };

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

/** The sides a design has: the schematic, and the board when it has one. */
export const kicadSides = (doc) => (doc.kicad.pcb ? [SCH, PCB] : [SCH]);

/** The side of `doc` that `side` names, or its schematic: the side a page
 *  holds may be one this design does not have, or none yet. */
export const sideOf = (doc, side) => (kicadSides(doc).includes(side) ? side : SCH);

/** Every file of the design, the project first. */
export const designFiles = (doc) => [doc.file, ...doc.kicad.schematics,
  ...(doc.kicad.pcb ? [doc.kicad.pcb] : [])];

/** What each element is handed, from the files' texts by path: a schematic
 *  with the pin entries the viewer draws pins from (kicadpins.js). */
export function designSources(doc, texts) {
  const source = (filename) => ({
    filename,
    content: filename.endsWith('.kicad_sch') ? addPinEntries(texts[filename]) : texts[filename],
  });
  return {
    [SCH]: [doc.file, ...doc.kicad.schematics].map(source),
    [PCB]: doc.kicad.pcb ? [doc.file, doc.kicad.pcb].map(source) : [],
  };
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

/** One design: both viewers, the side on screen, and the link between them. */
export default class KicadView extends React.Component {
  constructor(props) {
    super(props);
    this.state = { ready: false, error: '' };
    // A selection waiting for the page to hand down the side it is on:
    // `{ to, request }`, or null.
    this.probe = null;
    this.elements = {};
    // One ref callback per view, made once, so React does not detach and
    // reattach the listener on every render.
    this.refCallbacks = { [SCH]: this.attach(SCH), [PCB]: this.attach(PCB) };
  }

  /** The ref callback of one view's element: holds it and listens to it. */
  attach(context) {
    const listener = (event) => this.relay(context, event.detail);
    return (element) => {
      const old = this.elements[context];
      if (old) old.removeEventListener(CROSSPROBE_EVENT, listener);
      this.elements[context] = element || undefined;
      if (element) element.addEventListener(CROSSPROBE_EVENT, listener);
    };
  }

  /** The side on screen: the one the page hands down, where the design has it. */
  side() {
    return sideOf(this.props.doc, this.props.side);
  }

  /** A double click in `from`: the page is asked for the other side, and the
   *  same thing is selected there once it is on screen (`componentDidUpdate`). */
  relay(from, detail) {
    const to = from === SCH ? PCB : SCH;
    const request = crossProbeRequest(detail, to);
    if (!this.elements[to] || !request) return;
    this.probe = { to, request };
    if (this.props.onSide) this.props.onSide(to);
  }

  componentDidMount() {
    const { doc, base } = this.props;
    const files = designFiles(doc);
    const fetched = files.map((file) => fetch(`${base}${file.split('/').map(encodeURIComponent).join('/')}`)
      .then((response) => {
        if (!response.ok) throw new Error(`${file} did not load: HTTP ${response.status}`);
        return response.text();
      }));
    Promise.all([loadEcadViewer(), ...fetched])
      .then(([, ...texts]) => {
        if (this._gone) return undefined;
        const sources = designSources(doc, Object.fromEntries(files.map((file, i) => [file, texts[i]])));
        const revisionKey = `${base}${doc.file}`;
        return Promise.all(kicadSides(doc).map((context) => this.elements[context]
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
      if (target) target.requestCrossProbe(probe.request);
    }
  }

  componentWillUnmount() {
    this._gone = true;
  }

  /** Tell each element whether it is the one on screen. */
  activate() {
    for (const context of kicadSides(this.props.doc)) {
      const element = this.elements[context];
      if (element && typeof element.setActive === 'function') element.setActive(context === this.side());
    }
  }

  render() {
    const side = this.side();
    const { ready, error } = this.state;
    return (
      <div style={css(SHELL)}>
        {kicadSides(this.props.doc).map((context) => (
          <ecad-viewer key={context} ref={this.refCallbacks[context]} source-mode="host"
                       show-header="false" hide-chrome="true" data-view={context}
                       style={css(`${VIEWER};visibility:${context === side ? 'visible' : 'hidden'}`)} />
        ))}
        {(error || !ready) && <div style={css(NOTE)}>{error || 'Loading…'}</div>}
      </div>
    );
  }
}
