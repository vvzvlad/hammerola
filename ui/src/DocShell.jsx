// The page of a build with no model: a header, a tab per document, and the
// document. `ui/src/main.jsx` mounts it instead of HammerolaViewer when the
// build's meta.json says `"kind": "documents"` (src/render.py); a model's build
// shows its documents in its own list of views instead (chromeview.js).
//
// The document under a tab is drawn by DocumentView.jsx, which the model's page
// uses too.
//
// The document on screen is `?d=<id>` in the address, as a model's view is
// `?v=<id>`; the first document needs none, so a plain link opens on it. Its id
// is its path with `/` spelled `__` (`render.document_id`). Switching tabs
// REPLACES the address rather than pushing one: a tab is not a place the reader
// went, and a copied link still lands on what was showing.
//
// `DocPage` is the drawing and takes everything as props, so a test reads the
// tree it returns without mounting anything (ui/tests/docshell.test.js).

import React from 'react';

import DocumentView, { DOC_QUERY } from './DocumentView.jsx';
import { PAGE, shortId } from './hub.js';
import { HEADER_BAR, HEADER_RULE, HEAD_MONO, TITLE, WORDMARK } from './panelstyle.js';
import { css, FONTS, Mark, PAGE_BG, PAGE_FG, SANS } from './style.jsx';

/** What a build with no model says it is, in meta.json's `kind`. The hub
 *  spells it `render.DOCUMENTS_KIND` (tests/test_documents.py compares). */
export const DOCUMENTS_KIND = 'documents';

/** The document `wanted` names, or the first one. */
export function pickDocument(documents, wanted) {
  return documents.find((doc) => doc.id === wanted) || documents[0];
}

/** The query an address needs so that opening it lands on document `id`.
 *  Other parameters are kept; `?d=` is dropped for the first document. */
export function docQuery(search, id, documents) {
  const params = new URLSearchParams(search);
  if (documents[0] && documents[0].id === id) params.delete(DOC_QUERY);
  else params.set(DOC_QUERY, id);
  const query = params.toString();
  return query ? `?${query}` : '';
}

const SHELL = `position:fixed;inset:0;display:flex;flex-direction:column;background:${PAGE_BG};color:${PAGE_FG};font-family:${SANS};font-size:13px`;
const HEADER = `min-height:50px;flex:none;display:flex;align-items:center;gap:6px 12px;padding:0 16px;${HEADER_BAR}`;
const TABS = 'flex:none;display:flex;gap:2px;padding:0 12px;overflow-x:auto;background:var(--header-bg);border-bottom:1px solid var(--line)';
// The underline's colour is its own longhand in BOTH styles, so a tab that
// stops being the open one changes one value. Left to the shorthand in TAB,
// React would drop TAB_ON's longhand on the switch without re-setting the
// unchanged shorthand, and the underline would turn `currentcolor`.
const TAB = `flex:none;border:0;border-bottom:2px solid;border-bottom-color:transparent;background:none;padding:9px 10px 7px;font:500 12.5px ${SANS};color:var(--text-soft);cursor:pointer;white-space:nowrap`;
const TAB_ON = `${TAB};border-bottom-color:var(--accent);color:var(--text)`;

/** The whole page, from what the shell holds. Pure. */
export function DocPage({ meta, active, base, onPick }) {
  const doc = pickDocument(meta.documents, active);
  return (
    <div style={{ ...css(SHELL), ...FONTS }}>
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
      <div role="tablist" style={css(TABS)}>
        {meta.documents.map((one) => (
          <button key={one.id} type="button" role="tab" aria-selected={one.id === doc.id}
                  onClick={() => onPick(one.id)}
                  style={css(one.id === doc.id ? TAB_ON : TAB)}>
            {one.name}
          </button>
        ))}
      </div>
      <div style={css('flex:1;min-height:0;overflow:auto')}>
        <DocumentView key={doc.id} doc={doc} base={base} />
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
    this.state = { active: pickDocument(props.meta.documents, wanted).id };
  }

  pick(id) {
    if (id === this.state.active) return;
    window.history.replaceState(window.history.state, '',
      window.location.pathname + docQuery(window.location.search, id, this.props.meta.documents));
    this.setState({ active: id });
  }

  render() {
    return <DocPage meta={this.props.meta} active={this.state.active}
                    base={PAGE.base} onPick={(id) => this.pick(id)} />;
  }
}
