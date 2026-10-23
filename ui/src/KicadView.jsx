// One KiCad design, as a document of a build: its schematic and its board,
// each in an `<ecad-viewer>` of its own, under two tabs. DocumentView.jsx draws
// a document of type `kicad` with this.
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
// `ecad-viewer:crossprobe`, and this component switches to the other tab and
// asks the other element to select the same thing — a part by its designator,
// or a net by its name (`crossProbeRequest`).

import React from 'react';

import { addPinEntries } from './kicadpins.js';
import { tab } from './panelstyle.js';
import { css, MONO } from './style.jsx';

/** Where the hub serves the viewer; `parser.worker.js` is fetched beside it. */
export const ECAD_VIEWER_URL = '/_v/ecad-viewer.js';

/** The event an element reports a double click with. */
export const CROSSPROBE_EVENT = 'ecad-viewer:crossprobe';

/** The two views, by the names the viewer gives them (`targetContext`). */
export const SCH = 'SCH';
export const PCB = 'PCB';
const TAB_NAMES = { [SCH]: 'Schematic', [PCB]: 'PCB' };

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

/** The tabs a design has: the schematic, and the board when it has one. */
export const kicadTabs = (doc) => (doc.kicad.pcb ? [SCH, PCB] : [SCH]);

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

const SHELL = 'position:relative;height:100%;min-height:320px;display:flex;flex-direction:column';
const TABS = 'flex:none;display:flex;gap:4px;padding:6px 10px;background:var(--sunken-bg);border-bottom:1px solid var(--line)';
const STAGE = 'position:relative;flex:1;min-height:0';
const VIEWER = 'position:absolute;top:0;left:0;width:100%;height:100%;display:block';
const NOTE = `position:absolute;top:0;left:0;padding:24px 28px;font:400 12.5px ${MONO};color:var(--text-muted)`;

/** One design: its tabs, both viewers, and the link between them. */
export default class KicadView extends React.Component {
  constructor(props) {
    super(props);
    this.state = { tab: SCH, ready: false, error: '' };
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

  /** A double click in `from`: the other tab, and the same thing selected there. */
  relay(from, detail) {
    const to = from === SCH ? PCB : SCH;
    const target = this.elements[to];
    const request = crossProbeRequest(detail, to);
    if (!target || !request) return;
    this.setState({ tab: to }, () => target.requestCrossProbe(request));
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
        return Promise.all(kicadTabs(doc).map((context) => this.elements[context]
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
  }

  componentWillUnmount() {
    this._gone = true;
  }

  /** Tell each element whether it is the one on screen. */
  activate() {
    for (const context of kicadTabs(this.props.doc)) {
      const element = this.elements[context];
      if (element && typeof element.setActive === 'function') element.setActive(context === this.state.tab);
    }
  }

  render() {
    const tabs = kicadTabs(this.props.doc);
    const { ready, error } = this.state;
    return (
      <div style={css(SHELL)}>
        <div role="tablist" style={css(TABS)}>
          {tabs.map((context) => (
            <button key={context} type="button" role="tab" aria-selected={context === this.state.tab}
                    onClick={() => this.setState({ tab: context })}
                    style={css(`border:0;background:none;${tab(context === this.state.tab)}`)}>
              {TAB_NAMES[context]}
            </button>
          ))}
        </div>
        <div style={css(STAGE)}>
          {tabs.map((context) => (
            <ecad-viewer key={context} ref={this.refCallbacks[context]} source-mode="host"
                         show-header="false" hide-chrome="true" data-view={context}
                         style={css(`${VIEWER};visibility:${context === this.state.tab ? 'visible' : 'hidden'}`)} />
          ))}
          {(error || !ready) && <div style={css(NOTE)}>{error || 'Loading…'}</div>}
        </div>
      </div>
    );
  }
}
