// One document of a build, drawn — the one drawing both pages use: what
// DocShell.jsx shows for a build with no model, and what the model's page lays
// over the model, each the document chosen in the page's list of views
// (viewlist.jsx; HammerolaViewer.jsx, `docOpen` in chromeview.js).
//
// What a document becomes, by its `type`:
//
//   markdown   fetched and drawn here (`docmd.js`), its relative links
//              resolved from its own directory in the build
//   pdf, html,
//   svg        the file itself in an <iframe>: the hub serves it as its own
//              type, and an HTML page runs as its author wrote it
//   image      an <img>
//   schematic,
//   board,
//   board3d    a member of a KiCad design, drawn with the design's other
//              listed members linked to it (KicadView.jsx); the build's
//              `documents` say which those are, and its right-click menu
//              asks the page to open one (`onOpen`, with its id)
//   gerbers    a zip of a board's Gerber and drill files, unpacked and drawn
//              layer by layer (GerberView.jsx), with a link that downloads it
//   file       anything else a build lists — a DXF for the glass shop, a CSV
//              of measurements, a firmware image: its name, what it is and a
//              link that downloads it, since the page draws nothing of it
//
// A document keeps its path in the tree (`docs/cut-list.md`), and the hub
// serves it under the same path below the build's directory.
//
// WHAT THE PAGE'S BAR CAN DO WITH IT (`onTools`). The bar at the bottom of both
// pages (`toolBar` in viewlist.jsx) has Fit and Frame; a view that can bring
// itself back to the frame it opened in and save what it draws as a PNG says so
// by handing the page `{ fit, frame }` once it can — `fit()` moves the view,
// `frame()` answers a promise of a PNG blob — and the page greys both while it
// holds none. The Gerbers, the board and the schematic, and the board's 3D
// model can; a markdown page, an image and a file in a frame cannot. The view
// on screen of a KiCad design says it again for each member (KicadView.jsx);
// this component says null as it goes, so the next document starts grey. A
// document drawn where no bar is — the datasheet's window in KicadView.jsx —
// tells nobody.
//
// The parent keys this by `docViewKey`, so another document is another
// instance and a fetch still running for the last one lands nowhere — except
// another member of the same KiCad design, which keeps the instance and its
// viewers. `documentBody` is the drawing and takes everything as arguments, so
// a test reads the tree it returns without mounting anything
// (ui/tests/docshell.test.js).

import React from 'react';

import { markdownElements, NOWRAP_CLASS } from './docmd.js';
import { GERBERS_TYPE } from './gerber.js';
import GerberView from './GerberView.jsx';
import { mb } from './hub.js';
import KicadView, { designKey, viewOf } from './KicadView.jsx';
import { css, MONO, SANS } from './style.jsx';

/** The query key that names a document in a build's address, on both pages:
 *  the document on screen of a build with no model, the document over a model. */
export const DOC_QUERY = 'd';

/** A document the page does not draw, whatever its extension (`FILE_TYPE` in
 *  src/render.py, held to this spelling by tests/test_documents.py). */
export const FILE_TYPE = 'file';

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

/** Where a file of this build is served from. */
export const docUrl = (base, doc) => `${base}${encodePath(doc.file)}`;

/** The directory a document sits in, as an address its links resolve against. */
export function docBase(base, doc) {
  const cut = doc.file.lastIndexOf('/');
  return cut < 0 ? base : `${base}${encodePath(doc.file.slice(0, cut))}/`;
}

/** A file's size as a reader reads it: megabytes from one, else kilobytes. */
export const docSize = (bytes) => (bytes >= 1e6 ? mb(bytes) : `${(bytes / 1e3).toFixed(1)} kB`);

/** What a file the page does not draw is called by: its extension, lower case
 *  and without the dot (`dxf`), else its type, for a name that carries none.
 *  Asked of a `FILE_TYPE` document only — the rest are named by what the page
 *  makes of them, which is what their type says. */
export function docExt(doc) {
  const dot = doc.file.lastIndexOf('.');
  const ext = dot > doc.file.lastIndexOf('/') + 1 ? doc.file.slice(dot + 1).toLowerCase() : '';
  // A name may end in the dot (`data.`), which the hub's name rule allows: an
  // empty hint and an empty heading in the menu are worse than the type.
  return ext || doc.type;
}

/** What a document is labelled with beside its name: a KiCad schematic its
 *  sheet count, a board and its 3D model what they are, any other its type and
 *  size. A plain file says its extension in place of the word `file`, which
 *  would be the same word on every such row. */
export function docHint(doc) {
  if (doc.type === 'schematic') {
    const sheets = doc.kicad.schematics.length;
    return `${sheets} sheet${sheets === 1 ? '' : 's'}`;
  }
  if (doc.type === 'board') return 'board';
  if (doc.type === 'board3d') return '3D';
  return [doc.type === FILE_TYPE ? docExt(doc) : doc.type, docSize(doc.bytes)].join(' · ');
}

/** What a page keys the drawing of `doc` by: a member of a KiCad design by the
 *  design, so that moving between its schematic and its board keeps one
 *  KicadView and both its viewers; any other document by its id. A design's
 *  key holds a `/`, which no id does (`render.document_id`), so the two never
 *  meet. */
export function docViewKey(doc) {
  const design = designKey(doc);
  return design === null ? doc.id : `design/${design}`;
}

const FRAME = 'display:block;border:0;width:100%;height:100%;background:var(--paper-bg)';
const ARTICLE = 'max-width:860px;margin:0 auto;padding:24px 28px 48px;font-size:15px;line-height:1.55';
const PICTURE = 'display:block;max-width:100%;margin:24px auto;background:var(--paper-bg)';
const NOTE = `padding:24px 28px;font:400 12.5px ${MONO};color:var(--text-muted)`;

// A file the page does not draw, in the middle of the sheet the drawn ones use:
// its name, what it is and the link that takes it. It may be the only document
// of a build and so the one the page opens with, which is why it fills the area
// rather than sitting at the top of it.
const FILE_SHEET = 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;'
  + 'box-sizing:border-box;padding:24px 28px;background:var(--paper-bg)';
const FILE_CARD = 'display:flex;flex-direction:column;align-items:center;gap:8px;max-width:100%;text-align:center';
const FILE_NAME = `font:500 14px ${SANS};color:var(--text);word-break:break-all`;
const FILE_WHAT = `font:400 11.5px ${MONO};color:var(--text-muted)`;
const FILE_LINK = 'margin-top:8px;padding:7px 14px;border:1px solid var(--line);border-radius:6px;'
  + `text-decoration:none;font:500 11.5px ${SANS};color:var(--accent-text)`;

// A table cell short enough to read as one value (`495.0 × 428.5`) keeps it on
// one line (`docmd.js` marks it). A class and not an inline style, so that the
// rule is one line in one place rather than a property on every short cell.
const DOC_CSS = `.${NOWRAP_CLASS}{white-space:nowrap}`;

/** One document as elements, from what its holder knows: `documents` (the
 *  build's) and `onOpen` (the page's door for opening one by id) are for a
 *  member of a KiCad design, `onTools` for a view the bar can drive. Pure. */
export function documentBody(doc, base, text, error, documents, onOpen, onTools) {
  if (doc.type === 'markdown') {
    if (error) return <div style={css(NOTE)}>{error}</div>;
    if (text === null) return <div style={css(NOTE)}>Loading…</div>;
    return (
      <article style={css(ARTICLE)}>
        <style>{DOC_CSS}</style>
        {markdownElements(text, docBase(base, doc))}
      </article>
    );
  }
  if (doc.type === 'image') {
    return <img src={docUrl(base, doc)} alt={doc.name} style={css(PICTURE)} />;
  }
  if (viewOf(doc)) return <KicadView doc={doc} documents={documents} base={base} onOpen={onOpen} onTools={onTools} />;
  if (doc.type === GERBERS_TYPE) return <GerberView url={docUrl(base, doc)} size={docSize(doc.bytes)} onTools={onTools} />;
  // Before the frame: a browser handed a type it does not render downloads the
  // file from inside the frame, which leaves an empty page behind and no way
  // to ask for it again.
  if (doc.type === FILE_TYPE) {
    return (
      <div style={css(FILE_SHEET)}>
        <div style={css(FILE_CARD)}>
          <div style={css(FILE_NAME)}>{doc.name}</div>
          <div style={css(FILE_WHAT)}>{docHint(doc)}</div>
          <a href={docUrl(base, doc)} download style={css(FILE_LINK)}>Download</a>
        </div>
      </div>
    );
  }
  return <iframe src={docUrl(base, doc)} title={doc.name} style={css(FRAME)} />;
}

/** One document, holding the text of a markdown one while it is fetched. */
export default class DocumentView extends React.Component {
  static defaultProps = { onTools: () => {} };

  constructor(props) {
    super(props);
    this.state = { text: null, error: '' };
  }

  componentDidMount() {
    const { doc, base } = this.props;
    if (doc.type !== 'markdown') return;
    fetch(docUrl(base, doc))
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((text) => {
        if (!this._gone) this.setState({ text });
      }, (error) => {
        if (!this._gone) this.setState({ error: `${doc.file} did not load: ${error.message}` });
      });
  }

  componentWillUnmount() {
    this._gone = true;
    this.props.onTools(null);
  }

  render() {
    const { doc, base, documents, onOpen, onTools } = this.props;
    return documentBody(doc, base, this.state.text, this.state.error, documents, onOpen, onTools);
  }
}
