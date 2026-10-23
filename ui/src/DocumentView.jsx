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
//   kicad      a KiCad design, its schematic and board linked (KicadView.jsx):
//              the side on screen is the page's (`side`, `onSide`)
//
// A document keeps its path in the tree (`docs/cut-list.md`), and the hub
// serves it under the same path below the build's directory.
//
// The parent keys this by the document's id, so another document is another
// instance and a fetch still running for the last one lands nowhere.
// `documentBody` is the drawing and takes everything as arguments, so a test
// reads the tree it returns without mounting anything (ui/tests/docshell.test.js).

import React from 'react';

import { markdownElements, NOWRAP_CLASS } from './docmd.js';
import { mb } from './hub.js';
import KicadView from './KicadView.jsx';
import { css, MONO } from './style.jsx';

/** The query key that names a document in a build's address, on both pages:
 *  the document on screen of a build with no model, the document over a model. */
export const DOC_QUERY = 'd';

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

/** Where a file of this build is served from. */
export const docUrl = (base, doc) => `${base}${encodePath(doc.file)}`;

/** The directory a document sits in, as an address its links resolve against. */
export function docBase(base, doc) {
  const cut = doc.file.lastIndexOf('/');
  return cut < 0 ? base : `${base}${encodePath(doc.file.slice(0, cut))}/`;
}

/** What a document is labelled with beside its name: its type and size. */
export const docHint = (doc) => [doc.type,
  doc.bytes >= 1e6 ? mb(doc.bytes) : `${(doc.bytes / 1e3).toFixed(1)} kB`].join(' · ');

const FRAME = 'display:block;border:0;width:100%;height:100%;background:var(--paper-bg)';
const ARTICLE = 'max-width:860px;margin:0 auto;padding:24px 28px 48px;font-size:15px;line-height:1.55';
const PICTURE = 'display:block;max-width:100%;margin:24px auto;background:var(--paper-bg)';
const NOTE = `padding:24px 28px;font:400 12.5px ${MONO};color:var(--text-muted)`;

// A table cell short enough to read as one value (`495.0 × 428.5`) keeps it on
// one line (`docmd.js` marks it). A class and not an inline style, so that the
// rule is one line in one place rather than a property on every short cell.
const DOC_CSS = `.${NOWRAP_CLASS}{white-space:nowrap}`;

/** One document as elements, from what its holder knows: `side` and `onSide`
 *  are the page's, for a KiCad design. Pure. */
export function documentBody(doc, base, text, error, side, onSide) {
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
  if (doc.type === 'kicad') return <KicadView doc={doc} base={base} side={side} onSide={onSide} />;
  return <iframe src={docUrl(base, doc)} title={doc.name} style={css(FRAME)} />;
}

/** One document, holding the text of a markdown one while it is fetched. */
export default class DocumentView extends React.Component {
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
  }

  render() {
    const { doc, base, side, onSide } = this.props;
    return documentBody(doc, base, this.state.text, this.state.error, side, onSide);
  }
}
