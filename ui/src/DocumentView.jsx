// One document of a build, drawn — the one drawing both pages use: what
// DocShell.jsx shows for a build with no model, and what the model's page lays
// over the model, each the document chosen in the page's list of views
// (viewlist.jsx; HammerolaViewer.jsx, `docOpen` in chromeview.js).
//
// What a document becomes, by its `type`:
//
//   markdown   fetched and drawn here (`docmd.js`), its relative links
//              resolved from its own directory in the build; a link to
//              another document of the build opens it on the page, and one
//              to an address of the page shows what it names (`docLinks`)
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
//              layer by layer (GerberView.jsx)
//   file       anything else a build lists — a DXF for the glass shop, a CSV
//              of measurements, a firmware image: its name and what it is,
//              since the page draws nothing of it; a DXF has the picture the
//              hub drew of it (`preview`) above them
//
// A document keeps its path in the tree (`docs/cut-list.md`), and the hub
// serves it under the same path below the build's directory. None of these
// draws a link that downloads its file: the strip at the bottom of the page
// does, for whichever is open (`DocFile`, viewlist.jsx).
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
// WHEN IT HAS ITS FILE (`onReady`), the page is told: a markdown text in,
// a picture or a frame loaded, a KiCad design's files for the view on screen
// in (KicadView.jsx), a zip of Gerbers in; a failure tells it too, and a file
// the page does not draw tells it at once. A model's page opened on this
// document (`?d=`) holds the model back until then, so the two do not share
// the line (HammerolaViewer.jsx, `sync`). While a file comes in, its view
// draws the bar of loadbar.jsx.
//
// The parent keys this by `docViewKey`, so another document is another
// instance and a fetch still running for the last one lands nowhere — except
// another member of the same KiCad design, which keeps the instance and its
// viewers. `documentBody` is the drawing and takes everything as arguments, so
// a test reads the tree it returns without mounting anything
// (ui/tests/docshell.test.js).

import React from 'react';

import { follow, format, parse, respell } from './address.js';
import {
  findQuote, markdownElements, NOWRAP_CLASS, offsetOf, quoteOf, rangeOf, textIndex,
} from './docmd.js';
import { GERBERS_TYPE } from './gerber.js';
import GerberView from './GerberView.jsx';
import { mb } from './hub.js';
import KicadView, { designKey, DRAFT_MARK, viewOf } from './KicadView.jsx';
import { fetchBody, loadBar, meter } from './loadbar.jsx';
import { css, MONO, SANS } from './style.jsx';

/** A document the page does not draw, whatever its extension (`FILE_TYPE` in
 *  src/render.py, held to this spelling by tests/test_documents.py). */
export const FILE_TYPE = 'file';

/** The types of document both pages leave a comment on, each with what
 *  arming the Comment tool over it says to do: the tool is in service over
 *  one of them (chromeview.js, `docBar` in DocShell.jsx) and takes its place
 *  there — an area of a schematic's sheet or a board (KicadView.jsx) or of
 *  the Gerbers (GerberView.jsx), a part of the board's 3D model
 *  (BoardView3D.jsx), a passage of markdown (`quoting` below). */
export const COMMENTABLE = new Map([
  ['schematic', 'Drag an area on the drawing to pin the task'],
  ['board', 'Drag an area on the drawing to pin the task'],
  ['board3d', 'Click a part to pin the task'],
  ['markdown', 'Select a passage to pin the task'],
  ['gerbers', 'Drag an area, or click a spot, to pin the task'],
]);

/** The two highlights a markdown document's quotes are drawn in (the CSS
 *  Custom Highlight API: the text the page drew is left as React drew it):
 *  the open comments', and the one the rail has open and the draft's. */
const QUOTE_HIGHLIGHT = 'hmr-quote';
const OPEN_HIGHLIGHT = 'hmr-quote-open';

/** The page's highlights, or null in a browser without them. */
const highlights = () => (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function'
  ? CSS.highlights : null);

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
  // empty caption on the file's card and an empty heading in the menus are
  // worse than the type.
  return ext || doc.type;
}

/** What a document is labelled with beside its name: a KiCad schematic its
 *  sheet count, a board and its 3D model what they are, any other its type and
 *  size. A plain file says its extension in place of the word `file`, which
 *  would be the same word on every such file. The caption on the card of a
 *  file the page does not draw; in the list of views only a KiCad member's row
 *  carries it, the others standing under their type (`docGroup` in
 *  viewlist.jsx). */
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
// `user-select:text` because the page links three-cad-viewer.css, whose
// `body { user-select: none }` every element inherits: without it the text of
// a markdown document cannot be selected or copied.
const ARTICLE = 'max-width:860px;margin:0 auto;padding:24px 28px 48px;font-size:15px;line-height:1.55;user-select:text';
const PICTURE = 'display:block;max-width:100%;margin:24px auto;background:var(--paper-bg)';
const NOTE = `padding:24px 28px;font:400 12.5px ${MONO};color:var(--text-muted)`;

// A file the page does not draw, in the middle of the sheet the drawn ones use:
// its name and what it is. It may be the only document of a build and so the
// one the page opens with, which is why it fills the area rather than sitting
// at the top of it.
const FILE_SHEET = 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;'
  + 'box-sizing:border-box;padding:24px 28px;background:var(--paper-bg)';
const FILE_CARD = 'display:flex;flex-direction:column;align-items:center;gap:8px;max-width:100%;text-align:center';
const FILE_NAME = `font:500 14px ${SANS};color:var(--text);word-break:break-all`;
const FILE_WHAT = `font:400 11.5px ${MONO};color:var(--text-muted)`;
// A file with a picture of it (`preview`, a DXF) stacks the picture over the
// same card: a column whose picture takes the height the card leaves —
// `min-height:0` lets it shrink below the drawing's own size, so a tall one
// cannot push the card off the sheet — and is drawn whole inside it.
const PREVIEW_SHEET = 'display:flex;flex-direction:column;align-items:center;gap:16px;width:100%;height:100%;'
  + 'box-sizing:border-box;padding:24px 28px;background:var(--paper-bg)';
const PREVIEW = 'flex:1;min-height:0;width:100%;object-fit:contain';

// A table cell short enough to read as one value (`495.0 × 428.5`) keeps it on
// one line (`docmd.js` marks it). A class and not an inline style, so that the
// rule is one line in one place rather than a property on every short cell.
// The comments' quotes are underlined over a wash of the accent, the open one
// in a stronger one.
const DOC_CSS = `.${NOWRAP_CLASS}{white-space:nowrap}`
  + `::highlight(${QUOTE_HIGHLIGHT}){background-color:var(--accent-bg);text-decoration:underline var(--accent)}`
  + `::highlight(${OPEN_HIGHLIGHT}){background-color:var(--accent-muted);text-decoration:underline var(--accent)}`;

/** A modified or middle click, which is the browser's: a new tab or window. */
const browsersClick = (event) => event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey
  || event.altKey;

/** The fields of an address a link to the page's own address names: the whole
 *  screen, so a field it leaves out is none. */
const SCREEN = ['view', 'doc', 'sheet'];

/**
 * What a markdown link becomes where it opens something on the page (`links`
 * in docmd.js), else null. Its address is the page's own with what the link
 * names, so a new tab or a copied link lands on that too; a place in the
 * document on screen (the hash) it does not keep.
 *
 *   * A link to the page's own address — a bare query (`?v=open`,
 *     `?d=<id>&s=<sheet>`) or this page's full address copied from the
 *     browser, the same origin and path, but not a bare `#…`: it names a whole
 *     screen, so its `v=`, `d=` and `s=` replace the page's, a field it leaves
 *     out going, while `files=` and the parameters it does not name, `c=`
 *     among them, stay as the address has them. A plain click makes it a step
 *     of history the page follows as it follows Back (`follow` in address.js),
 *     none where the address already names that screen; one naming a view and
 *     no document opens nothing on the page of a build with no model, which has
 *     no `views`.
 *   * A link to another document of this build, by its path: that document's
 *     `?d=`, and a plain click opens it through `onOpen`, as its row in the
 *     list does. Without a door to open one it stays a link to the file.
 */
export function docLinks(base, documents, onOpen, views) {
  const urlOf = (href) => {
    // `resolveHref` passes an address with a scheme through as written, and a
    // half-typed one (`https://`, `http://host:PORT/`) does not parse.
    try {
      return new URL(href, window.location.href);
    } catch {
      return null;
    }
  };
  return (href) => {
    const url = urlOf(href);
    if (!url || url.origin !== window.location.origin) return null;
    if (url.pathname === window.location.pathname && !href.startsWith('#')) {
      const named = parse(url, null);
      const fields = Object.fromEntries(SCREEN.map((field) => [field, named[field]]));
      const screen = (at) => ({ ...respell(at, fields), hash: '' });
      return {
        href: format(screen(parse())),
        onClick: (event) => {
          if (browsersClick(event)) return;
          event.preventDefault();
          if (fields.view && !fields.doc && !(views && views.length)) return;
          const at = parse();
          if (SCREEN.every((field) => at[field] === fields[field])) return;
          follow(screen(at));
        },
      };
    }
    if (!onOpen || !Array.isArray(documents)) return null;
    const hit = documents.find((d) => urlOf(docUrl(base, d)).pathname === url.pathname);
    if (!hit) return null;
    return {
      href: format({ ...respell(parse(), { doc: hit.id }), hash: '' }),
      onClick: (event) => {
        if (browsersClick(event)) return;
        event.preventDefault();
        onOpen(hit.id);
      },
    };
  };
}

/** One document as elements, from what its holder knows: `documents` (the
 *  build's) and `onOpen` (the page's door for opening one by id) are for a
 *  member of a KiCad design and for a markdown link to another document,
 *  `onTools` for a view the bar can drive, `onReady` for the page waiting on
 *  the file, `received` the bytes of a markdown text in so far, `addressDoc`
 *  the page's reading of which document an address names, for a schematic's
 *  sheet in it (KicadView.jsx), `onSheet` the page's door for writing
 *  that sheet, `comment` what a KiCad design and the Gerbers need for the
 *  page's comments (KicadView.jsx, GerberView.jsx), and `quoting` what a
 *  markdown article does for them (`DocumentView`): its ref, its pointer's
 *  handlers, and whether the pointer is over a quote; `views` the build's,
 *  none on the page of a build with no model, for a markdown link naming one.
 *  Pure but for a link's address, which is the page's current one
 *  (`docLinks`). */
export function documentBody(doc, base, text, error, documents, onOpen, onTools, onReady, received, addressDoc,
  onSheet, comment, quoting, views) {
  if (doc.type === 'markdown') {
    if (error) return <div style={css(NOTE)}>{error}</div>;
    if (text === null) return <div style={css(NOTE)}>{loadBar(received, doc.bytes, false)}</div>;
    const { pointing, ...hooks } = quoting || {};
    return (
      <article style={css(ARTICLE + (pointing ? ';cursor:pointer' : ''))} {...hooks}>
        <style>{DOC_CSS}</style>
        {markdownElements(text, docBase(base, doc), docLinks(base, documents, onOpen, views))}
      </article>
    );
  }
  if (doc.type === 'image') {
    return <img src={docUrl(base, doc)} alt={doc.name} style={css(PICTURE)} onLoad={onReady} onError={onReady} />;
  }
  if (viewOf(doc)) {
    return <KicadView doc={doc} documents={documents} base={base} onOpen={onOpen} onTools={onTools} onReady={onReady}
                      addressDoc={addressDoc} onSheet={onSheet} comment={comment} />;
  }
  if (doc.type === GERBERS_TYPE) {
    return <GerberView url={docUrl(base, doc)} bytes={doc.bytes} onTools={onTools} onReady={onReady}
                       doc={doc} comment={comment} />;
  }
  // Before the frame: a browser handed a type it does not render downloads the
  // file from inside the frame, which leaves an empty page behind and no way
  // to ask for it again.
  if (doc.type === FILE_TYPE) {
    const card = (
      <div style={css(FILE_CARD)}>
        <div style={css(FILE_NAME)}>{doc.name}</div>
        <div style={css(FILE_WHAT)}>{docHint(doc)}</div>
      </div>
    );
    if (!doc.preview) return <div style={css(FILE_SHEET)}>{card}</div>;
    return (
      <div style={css(PREVIEW_SHEET)}>
        <img src={`${base}${encodePath(doc.preview)}`} alt={doc.name} style={css(PREVIEW)} />
        {card}
      </div>
    );
  }
  return <iframe src={docUrl(base, doc)} title={doc.name} style={css(FRAME)} onLoad={onReady} />;
}

/**
 * One document, holding the text of a markdown one while it is fetched.
 *
 * A markdown one takes the page's comments (`comment`, comments.jsx) itself.
 * With the Comment tool armed (`on`) a selection made in the article is the
 * place of a comment, handed to the page (`onArea`) as its quote (`quoteOf`,
 * docmd.js).
 * The quotes of the open comments and the draft on it (`marks`) are found in
 * the text (`findQuote`) and highlighted; a click on one names its comment to
 * the page (`onMarker`), and the ids of those not found go back to it
 * (`onLost`) as that changes. A quote the page asks to be shown (`focus`) is
 * scrolled to, and the page told (`onFocused`).
 */
export default class DocumentView extends React.Component {
  static defaultProps = { onTools: () => {}, onReady: () => {} };

  constructor(props) {
    super(props);
    // `pointing`: the pointer is over a quote it can open.
    this.state = { text: null, error: '', received: 0, pointing: false };
    // The article, the quotes found in it `{ id, active, range }`, what they
    // were found for (the marks and the text), the ids last told lost, and
    // the focus last shown.
    this.article = null;
    this.quotes = [];
    this.quoted = null;
    this.lost = undefined;
    this.focused = null;
    this.quoting = {
      ref: (node) => {
        this.article = node;
      },
      onPointerUp: (event) => this.textUp(event),
      onPointerMove: (event) => {
        const pointing = this.quoteAt(event.clientX, event.clientY) !== null;
        if (pointing !== this.state.pointing) this.setState({ pointing });
      },
    };
  }

  /** The comment whose quote is under the client point (`x`, `y`), the
   *  draft's being none, or null. */
  quoteAt(x, y) {
    for (const { id, range } of this.quotes) {
      if (id === DRAFT_MARK) continue;
      for (const at of range.getClientRects()) {
        if (x >= at.left && x <= at.right && y >= at.top && y <= at.bottom) return id;
      }
    }
    return null;
  }

  /** A release over the article: a selection in it with the tool armed is a
   *  comment's place; a click on a quote names its comment. */
  textUp(event) {
    const { comment, doc } = this.props;
    if (!comment || event.button !== 0 || !this.article) return;
    const selection = window.getSelection();
    if (selection && selection.rangeCount && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      if (!comment.on || !this.article.contains(range.startContainer) || !this.article.contains(range.endContainer)) {
        return;
      }
      const index = textIndex(this.article);
      const quote = quoteOf(index.text, offsetOf(index, range.startContainer, range.startOffset),
        offsetOf(index, range.endContainer, range.endOffset));
      if (quote) comment.onArea(doc, { frame: 'text', quote });
      return;
    }
    const id = this.quoteAt(event.clientX, event.clientY);
    if (id !== null) comment.onMarker(id);
  }

  /** The article in line with `comment` (see the class): its quotes found
   *  and highlighted again when the marks or the text changed, and a focus on
   *  it scrolled to. */
  markText() {
    const { comment, doc } = this.props;
    const { text } = this.state;
    if (!comment || !this.article || text === null) return;
    const marks = (comment.marks || []).filter((one) => one.doc === doc.file && one.quote);
    const key = JSON.stringify(marks);
    if (!this.quoted || this.quoted.key !== key || this.quoted.text !== text) {
      this.quoted = { key, text };
      const index = textIndex(this.article);
      const lost = [];
      this.quotes = [];
      for (const mark of marks) {
        const found = findQuote(index.text, mark.quote);
        if (found) this.quotes.push({ id: mark.id, active: mark.active, range: rangeOf(index, ...found) });
        else if (mark.id !== DRAFT_MARK) lost.push(mark.id);
      }
      const registry = highlights();
      if (registry) {
        for (const [name, active] of [[QUOTE_HIGHLIGHT, false], [OPEN_HIGHLIGHT, true]]) {
          registry.set(name, new Highlight(...this.quotes.filter((one) => Boolean(one.active) === active)
            .map((one) => one.range)));
        }
      }
      const told = JSON.stringify(lost);
      if (told !== this.lost) {
        this.lost = told;
        comment.onLost(doc.file, lost);
      }
    }
    const focus = comment.focus;
    if (focus && focus !== this.focused && focus.doc === doc.file && focus.quote) {
      this.focused = focus;
      const index = textIndex(this.article);
      const found = findQuote(index.text, focus.quote);
      const block = found && rangeOf(index, ...found).startContainer.parentElement;
      if (block && typeof block.scrollIntoView === 'function') block.scrollIntoView({ block: 'center' });
      comment.onFocused();
    }
  }

  componentDidUpdate() {
    this.markText();
  }

  componentDidMount() {
    const { doc, base } = this.props;
    if (doc.type === FILE_TYPE) this.props.onReady();
    if (doc.type !== 'markdown') return;
    const count = meter((received) => {
      if (!this._gone) this.setState({ received });
    });
    fetchBody(docUrl(base, doc), count, true)
      .then((text) => {
        if (this._gone) return;
        this.setState({ text });
        this.props.onReady();
      }, (error) => {
        if (this._gone) return;
        this.setState({ error: `${doc.file} did not load: ${error.message}` });
        this.props.onReady();
      });
  }

  componentWillUnmount() {
    this._gone = true;
    this.props.onTools(null);
    const registry = this.quoted && highlights();
    if (registry) {
      registry.delete(QUOTE_HIGHLIGHT);
      registry.delete(OPEN_HIGHLIGHT);
    }
  }

  render() {
    const { doc, base, documents, onOpen, onTools, onReady, addressDoc, onSheet, comment, views } = this.props;
    const { text, error, received, pointing } = this.state;
    return documentBody(doc, base, text, error, documents, onOpen, onTools, onReady, received, addressDoc, onSheet,
      comment, comment ? { ...this.quoting, pointing } : null, views);
  }
}
