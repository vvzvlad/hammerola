// The page of a build with no model: a header, the document, and the bar
// floating at the bottom — the model's page's bar, drawn by the same code
// (`toolBar` in viewlist.jsx), its list of views here with the build's
// documents only. `ui/src/main.jsx` mounts it instead of HammerolaViewer when
// the build's meta.json says `"kind": "documents"` (src/render.py).
//
// The document is drawn by DocumentView.jsx, which the model's page uses too.
// The page holds which document is open — `Show in …` of a KiCad design's
// right-click menu opens the other member through the same door a row does
// (`onPick`) — what the bar's Fit and Frame can do with it (`tools`), and
// whether the window is narrow, which takes the bar down to the list and Fit
// as on the model's page.
//
// The document on screen is `?d=<id>` in the address, as a model's view is
// `?v=<id>`; the default document — the first one not listed `hidden` — needs
// none, so a plain link opens on it. A hidden document has no row and opens
// by its `?d=`. Its id is its path with `/` spelled `__`
// (`render.document_id`). Choosing a document is a step of the browser's
// history, as a choice in the model page's menu of views is: Back returns to
// the document chosen before, and a copied link lands on what was showing. The
// address is read and written through address.js, the schematic's sheet (`s=`)
// too, which KicadView.jsx reports here (`writeSheet`).
//
// `DocPage` is the drawing and takes everything as props, so a test reads the
// tree it returns without mounting anything (ui/tests/docshell.test.js).

import React from 'react';

import { navigate, parse, respell, subscribe, unsubscribe } from './address.js';
import DocumentView, { docUrl, docViewKey } from './DocumentView.jsx';
import { PAGE, shortId } from './hub.js';
import { btn, HEADER_BAR, HEADER_RULE, HEAD_MONO, TITLE, WORDMARK } from './panelstyle.js';
import { readToken } from './store.js';
import { css, FONTS, Mark, NARROW, PAGE_BG, PAGE_FG, SANS } from './style.jsx';
import { BAR_LAYER, DOC_LAYER, documentRows, quietBtn, savePng, toolBar } from './viewlist.jsx';

/** What a build with no model says it is, in meta.json's `kind`. The hub
 *  spells it `render.DOCUMENTS_KIND` (tests/test_documents.py compares). */
export const DOCUMENTS_KIND = 'documents';

/** The document a plain link opens: the first one with a row in the list,
 *  else the first one, where every document is hidden. */
export const defaultDocument = (documents) => documents.find((doc) => !doc.hidden) || documents[0];

/** The document `wanted` names, hidden or not, or the default one. */
export function pickDocument(documents, wanted) {
  return documents.find((doc) => doc.id === wanted) || defaultDocument(documents);
}

const SHELL = `position:fixed;inset:0;display:flex;flex-direction:column;background:${PAGE_BG};color:${PAGE_FG};font-family:${SANS};font-size:13px`;
const HEADER = `min-height:50px;flex:none;display:flex;align-items:center;gap:6px 12px;padding:0 16px;${HEADER_BAR}`;
const STAGE = 'position:relative;flex:1;min-height:0';
// The bar's layer over the document's (`DOC_LAYER`, 16), as on the model's page.
const BAR = `${BAR_LAYER}18`;

/**
 * What this page's bar draws (`toolBar` in viewlist.jsx): the model's page's
 * bar, the same controls in the same places. Download and Copy link for the
 * open document's file (`docHref`, served under `base`) stand outside the bar
 * at the left of the strip (`DocFile` in viewlist.jsx), as they do over a
 * document there. The four about a model are out of
 * service, as they are over a document there, and Comment and Add primitive
 * are hidden from a reader without a token (`viewer`), as they are there; Fit
 * and Frame act on the document when its view can do them (`tools`, `onTools`
 * in DocumentView.jsx) and are out of service when it cannot. A narrow window
 * keeps the list and Fit. Pure.
 */
export function docBar({ meta, doc, base, onPick, viewsOpen, onToggle, narrow, viewer, tools }) {
  return {
    viewMenu: true, viewLabel: doc.name, viewsOpen: !!viewsOpen, viewsToggle: onToggle,
    viewTabs: [], docRows: documentRows(meta.documents, doc.id, onPick),
    docHref: docUrl(base, doc),
    showTools: !narrow,
    measureBtnStyle: btn(false, false, true),
    commentBtnStyle: btn(false, viewer, true),
    proposalBtnStyle: btn(false, viewer, true),
    settingsBtnStyle: btn(false, false, true),
    fitView: tools ? () => tools.fit() : undefined,
    fitBtnStyle: quietBtn(!tools),
    // No toast on this page: a frame that is not there saves nothing.
    grabFrame: tools ? () => tools.frame().then((blob) => blob && savePng(blob, meta))
      .catch((error) => console.warn('frame', error)) : undefined,
    frameBtnStyle: quietBtn(!tools),
  };
}

/**
 * The whole page, from what the shell holds. Pure. `onPick(id)` opens a
 * document: what a row of the list does, and `Show in …` of a KiCad design's
 * right-click menu; `viewsOpen` says the list is open, `onToggle` opens or shuts
 * it and `onClose` shuts it, from a click anywhere else on the page. `tools`
 * is what the open document's view told the bar it can do through `onTools`;
 * `narrow` and `viewer` are `docBar`'s. `addressDoc` reads which document an
 * address names, for a schematic's sheet in it (KicadView.jsx), and
 * `onSheet` writes the sheet a schematic reports into the address.
 */
export function DocPage({
  meta, active, base, onPick, viewsOpen, onToggle, onClose, narrow, viewer, tools, onTools, addressDoc, onSheet,
}) {
  const doc = pickDocument(meta.documents, active);
  return (
    <div onClick={onClose} style={{ ...css(SHELL), ...FONTS }}>
      <div style={css(HEADER)}>
        <a href="/" title="all projects" style={css('display:flex;align-items:center;gap:8px;text-decoration:none;color:inherit')}>
          <Mark />
          <span style={css(WORDMARK)}>hammerola</span>
        </a>
        <div style={css(HEADER_RULE)} />
        <div style={css(`${TITLE};flex:1;min-width:0`)}>{meta.title || meta.project}</div>
        <span title={meta.commit} style={css(`${HEAD_MONO};color:var(--text-soft)`)}>
          {meta.dev ? 'dev' : shortId(meta.commit)}
        </span>
      </div>
      <div style={css(STAGE)}>
        <div style={css(DOC_LAYER)}>
          <DocumentView key={docViewKey(doc)} doc={doc} documents={meta.documents} base={base} onOpen={onPick}
                        onTools={onTools} addressDoc={addressDoc} onSheet={onSheet} />
        </div>
        <div style={css(BAR)}>
          {toolBar(docBar({ meta, doc, base, onPick, viewsOpen, onToggle, narrow, viewer, tools }))}
        </div>
      </div>
    </div>
  );
}

/** The page, holding which document is open. `meta` is required: main.jsx has
 *  read it to choose this shell. */
export default class DocShell extends React.Component {
  constructor(props) {
    super(props);
    // The document address `at` (`parse` in address.js) names, its `?d=` or
    // the default one where it has none: what is open, and what a schematic's
    // sheet in the address is read against (`addressDoc` in KicadView.jsx),
    // which a bare `d=` would miss for a default schematic.
    this.addressDoc = (at) => pickDocument(this.props.meta.documents, at.doc).id;
    this.state = {
      active: this.addressDoc(parse()), viewsOpen: false, tools: null,
      // Read at once and kept current (`componentDidMount`), as the model's
      // page keeps its own.
      narrow: !!(window.matchMedia && window.matchMedia(NARROW).matches),
    };
    // Who the reader is does not change on this page, which has no token
    // control.
    this.viewer = !readToken();
    this.onTools = (tools) => this.setState({ tools });
    this.mq = null;
    this.onNarrow = (event) => this.setState({ narrow: event.matches });
    // Back and Forward through the documents picked (`pick`): the entry's
    // document, read as the constructor reads it.
    this.onPop = (at) => this.setState({ active: this.addressDoc(at) });
    this.onSheet = (sheet, push) => this.writeSheet(sheet, push);
  }

  componentDidMount() {
    this.mq = window.matchMedia ? window.matchMedia(NARROW) : null;
    if (this.mq) this.mq.addEventListener('change', this.onNarrow);
    subscribe(this.onPop);
  }

  componentWillUnmount() {
    if (this.mq) this.mq.removeEventListener('change', this.onNarrow);
    unsubscribe(this.onPop);
  }

  /** Document `id` on screen, a step of history; the list shuts. The address
   *  names no `?d=` for the default document, and no place in the document
   *  left: the hash goes. The schematic's sheet (`s=`) goes too: a design
   *  picked after another document opens on its root sheet, while its
   *  schematic picked after its own board, the element kept, writes back the
   *  sheet it is on (`writeSheet`). */
  pick(id) {
    if (id !== this.state.active) {
      const fallback = defaultDocument(this.props.meta.documents);
      const next = respell(parse(), { doc: fallback && fallback.id === id ? null : id, sheet: null });
      navigate({ ...next, hash: '' }, { push: true });
    }
    this.setState({ active: id, viewsOpen: false });
  }

  /** The schematic's sheet on screen as KicadView reports it (`onSheet`):
   *  `sheet` the value of `s=`, '' for the root sheet. A step of history for
   *  the reader's own change (`push`), else the entry on screen rewritten. */
  writeSheet(sheet, push) {
    navigate(respell(parse(), { sheet }), { push });
  }

  render() {
    return <DocPage meta={this.props.meta} active={this.state.active}
                    base={PAGE.base} onPick={(id) => this.pick(id)}
                    narrow={this.state.narrow} viewer={this.viewer}
                    tools={this.state.tools} onTools={this.onTools} addressDoc={this.addressDoc}
                    onSheet={this.onSheet} viewsOpen={this.state.viewsOpen}
                    onToggle={(e) => {
                      e.stopPropagation();
                      this.setState({ viewsOpen: !this.state.viewsOpen });
                    }}
                    onClose={() => { if (this.state.viewsOpen) this.setState({ viewsOpen: false }); }} />;
  }
}
