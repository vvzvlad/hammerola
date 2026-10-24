// The page of a build with no model: a header, the document, and the list of
// views floating at the bottom — the model's page's list, drawn by the same
// code (viewlist.jsx), here with the build's documents only. `ui/src/main.jsx`
// mounts it instead of HammerolaViewer when the build's meta.json says
// `"kind": "documents"` (src/render.py).
//
// The document is drawn by DocumentView.jsx, which the model's page uses too.
// The page holds only which document is open: a double click across a KiCad
// design's link opens the other member through the same door a row does
// (`onPick`).
//
// The document on screen is `?d=<id>` in the address, as a model's view is
// `?v=<id>`; the default document — the first one not listed `hidden` — needs
// none, so a plain link opens on it. A hidden document has no row and opens
// by its `?d=`. Its id is its path with `/` spelled `__`
// (`render.document_id`). Choosing a document REPLACES the address rather than
// pushing one: it is not a place the reader went, and a copied link still
// lands on what was showing.
//
// `DocPage` is the drawing and takes everything as props, so a test reads the
// tree it returns without mounting anything (ui/tests/docshell.test.js).

import React from 'react';

import DocumentView, { DOC_QUERY, docViewKey } from './DocumentView.jsx';
import { PAGE, shortId } from './hub.js';
import { HEADER_BAR, HEADER_RULE, HEAD_MONO, TITLE, WORDMARK } from './panelstyle.js';
import { css, FONTS, Mark, PAGE_BG, PAGE_FG, SANS } from './style.jsx';
import { BAR_LAYER, DOC_LAYER, documentRows, FLOAT_BAR, viewList } from './viewlist.jsx';

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

/** The query an address needs so that opening it lands on document `id`.
 *  Other parameters are kept; `?d=` is dropped for the default document. */
export function docQuery(search, id, documents) {
  const params = new URLSearchParams(search);
  const fallback = defaultDocument(documents);
  if (fallback && fallback.id === id) params.delete(DOC_QUERY);
  else params.set(DOC_QUERY, id);
  const query = params.toString();
  return query ? `?${query}` : '';
}

const SHELL = `position:fixed;inset:0;display:flex;flex-direction:column;background:${PAGE_BG};color:${PAGE_FG};font-family:${SANS};font-size:13px`;
const HEADER = `min-height:50px;flex:none;display:flex;align-items:center;gap:6px 12px;padding:0 16px;${HEADER_BAR}`;
const STAGE = 'position:relative;flex:1;min-height:0';
// The bar's layer over the document's (`DOC_LAYER`, 16), as on the model's page.
const BAR = `${BAR_LAYER}18`;

/**
 * The whole page, from what the shell holds. Pure. `onPick(id)` opens a
 * document: what a row of the list does, and a double click across a KiCad
 * design's link; `viewsOpen` says the list is open, `onToggle` opens or shuts
 * it and `onClose` shuts it, from a click anywhere else on the page.
 */
export function DocPage({ meta, active, base, onPick, viewsOpen, onToggle, onClose }) {
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
          <DocumentView key={docViewKey(doc)} doc={doc} documents={meta.documents} base={base} onOpen={onPick} />
        </div>
        <div style={css(BAR)}>
          <div style={css(FLOAT_BAR)}>
            {viewList({ label: doc.name, open: !!viewsOpen, onToggle, alone: true,
              documents: documentRows(meta.documents, doc.id, onPick) })}
          </div>
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
    const wanted = new URLSearchParams(window.location.search).get(DOC_QUERY);
    this.state = { active: pickDocument(props.meta.documents, wanted).id, viewsOpen: false };
  }

  /** Document `id` on screen; the list shuts. */
  pick(id) {
    if (id !== this.state.active) {
      window.history.replaceState(window.history.state, '',
        window.location.pathname + docQuery(window.location.search, id, this.props.meta.documents));
    }
    this.setState({ active: id, viewsOpen: false });
  }

  render() {
    return <DocPage meta={this.props.meta} active={this.state.active}
                    base={PAGE.base} onPick={(id) => this.pick(id)}
                    viewsOpen={this.state.viewsOpen}
                    onToggle={(e) => {
                      e.stopPropagation();
                      this.setState({ viewsOpen: !this.state.viewsOpen });
                    }}
                    onClose={() => { if (this.state.viewsOpen) this.setState({ viewsOpen: false }); }} />;
  }
}
