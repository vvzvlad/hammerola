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
// too, which KicadView.jsx reports here (`writeSheet`). A markdown link naming
// an address of this page is a step too, followed as Back is (`onPop`); one
// naming a view and no document opens nothing, this page having no views
// (`docLinks` in DocumentView.jsx).
//
// COMMENTS, as over a document on the model's page and by the same code
// (comments.jsx, feedview.js): a reader with the token arms Comment over a
// document that takes one (`COMMENTABLE` in DocumentView.jsx), takes a place
// on it into the composer and sends the draft; the header's Comments opens
// the rail of the project's queue, whose row opens its document at its place
// (`pick`), and a mark on the drawing opens its row. The reader does not
// change on this page: the token is read once, and nothing here sets it.
//
// `DocPage` is the drawing and takes everything as props, so a test reads the
// tree it returns without mounting anything (ui/tests/docshell.test.js).

import React from 'react';

import { navigate, parse, respell, subscribe, unsubscribe } from './address.js';
import {
  closeComment, commentRail, commentsButton, composerCard, composerView, docComment, docDraft, docFrame,
  railView, readFeed, sendDraft,
} from './comments.jsx';
import DocumentView, { COMMENTABLE, docUrl, docViewKey } from './DocumentView.jsx';
import { dropStaleFocus, feedView } from './feedview.js';
import { buildKey, PAGE, shortId } from './hub.js';
import { btn, HEADER_BAR, HEADER_RULE, HEAD_MONO, TITLE, TOAST_MS, toastStyle, WORDMARK } from './panelstyle.js';
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
// Wraps, as the model page's header does: a row that cannot wrap cuts the
// comments button off a phone's width.
const HEADER = `min-height:50px;flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:0 16px;${HEADER_BAR}`;
// Under the header the document's stage and the comment rail beside it, which
// covers the stage on a narrow window (`railView` in comments.jsx).
const BODY = 'flex:1;display:flex;min-height:0;position:relative';
const STAGE = 'position:relative;flex:1;min-width:0';
// The bar's layer over the document's (`DOC_LAYER`, 16), as on the model's page.
const BAR = `${BAR_LAYER}18`;

/**
 * What this page's bar draws (`toolBar` in viewlist.jsx): the model's page's
 * bar, the same controls in the same places. Download and Copy link for the
 * open document's file (`docHref`, served under `base`) stand outside the bar
 * at the left of the strip (`DocFile` in viewlist.jsx), as they do over a
 * document there. Measure, Add primitive and Settings, about a model, are out
 * of service, as they are over a document there; Comment is in service over a
 * document that takes a comment (`COMMENTABLE`), lit while armed (`tool`) and
 * armed or put down by `onComment`; Comment and Add primitive are hidden from
 * a reader without a token (`viewer`), as they are there; Fit and Frame act on
 * the document when its view can do them (`tools`, `onTools` in
 * DocumentView.jsx) and are out of service when it cannot. A narrow window
 * keeps the list and Fit. Pure.
 */
export function docBar({ meta, doc, base, onPick, viewsOpen, onToggle, narrow, viewer, tools, tool, onComment }) {
  return {
    viewMenu: true, viewLabel: doc.name, viewsOpen: !!viewsOpen, viewsToggle: onToggle,
    viewTabs: [], docRows: documentRows(meta.documents, doc.id, onPick, base, buildKey(meta)),
    docHref: docUrl(base, doc),
    showTools: !narrow,
    measureBtnStyle: btn(false, false, true),
    tComment: onComment,
    commentBtnStyle: btn(tool === 'comment', viewer, !COMMENTABLE.has(doc.type)),
    proposalBtnStyle: btn(false, viewer, true),
    settingsBtnStyle: btn(false, false, true),
    fitView: tools ? () => tools.fit() : undefined,
    fitBtnStyle: quietBtn(!tools),
    // No toast for it: a frame that is not there saves nothing.
    grabFrame: tools ? () => tools.frame().then((blob) => blob && savePng(blob, meta))
      .catch((error) => console.warn('frame', error)) : undefined,
    frameBtnStyle: quietBtn(!tools),
  };
}

/**
 * The whole page, from what the shell holds. Pure. `onPick(id)` opens a
 * document: what a row of the list does, and `Show in …` of a KiCad design's
 * right-click menu; `onPick(id, sheet)` a schematic on a sheet, what a row of
 * its sheets does (`SheetRows` in viewlist.jsx); `viewsOpen` says the list is
 * open, `onToggle` opens or shuts it and `onClose` shuts it, from a click
 * anywhere else on the page. `tools` is what the open document's view told
 * the bar it can do through `onTools`; `narrow`, `viewer`, `tool` and
 * `onComment` are `docBar`'s. `addressDoc` reads which document an address
 * names, for a schematic's sheet in it (KicadView.jsx), and `onSheet` writes
 * the sheet a schematic reports into the address. `comments` are the values
 * of the comments (`DocShell.comments`): what the open document is handed for
 * them (`docComment`), the composer's, the rail's and its button's, and the
 * ref the composer's textarea is focused through (`box`); with none the page
 * draws no comments. `toast` is what the toast says, or null.
 */
export function DocPage({
  meta, active, base, onPick, viewsOpen, onToggle, onClose, narrow, viewer, tools, onTools, addressDoc, onSheet,
  tool, onComment, comments, toast,
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
        {comments && commentsButton(comments)}
      </div>
      <div style={css(BODY)}>
        <div style={css(STAGE)}>
          <div style={css(DOC_LAYER)}>
            <DocumentView key={docViewKey(doc)} doc={doc} documents={meta.documents} base={base} onOpen={onPick}
                          onTools={onTools} addressDoc={addressDoc} onSheet={onSheet}
                          comment={comments ? comments.docComment : undefined} />
          </div>
          {/* Over the document, under the bar, as on the model's page. */}
          {comments && composerCard(comments, comments.box)}
          <div style={css(BAR)}>
            {toolBar(docBar({ meta, doc, base, onPick, viewsOpen, onToggle, narrow, viewer, tools, tool, onComment }))}
          </div>
          <div style={css(toastStyle(!!toast))}>{toast}</div>
        </div>
        {comments && commentRail(comments)}
      </div>
    </div>
  );
}

/** The page, holding which document is open, and the comments. `meta` is
 *  required: main.jsx has read it to choose this shell. */
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
      // The comments, in the model page's fields (comments.jsx): the
      // project's queue (`feed`), the comment the rail has lit, the draft, a
      // Send on the wire, the rail open, the Comment tool armed, the place a
      // row asked of a document and by a document's file the comments it
      // found no place for (`docFocus`, `docLost`, feedview.js); and what the
      // toast says.
      feed: [], activePin: null, composer: null, sending: false, rail: false, tool: null,
      docFocus: null, docLost: {}, toast: null,
    };
    // Who the reader is does not change on this page, which has no token
    // control: the token is read once.
    this.token = readToken();
    this.viewer = !this.token;
    // The composer's textarea, focused when the composer opens.
    this.compBox = React.createRef();
    this.tt = undefined;
    this.onTools = (tools) => this.setState({ tools });
    this.mq = null;
    // Narrowing puts an armed tool down, as on the model's page: its button
    // leaves the bar, and a phone has no Escape to put it down with.
    this.onNarrow = (event) => this.setState(event.matches ? { narrow: true, tool: null } : { narrow: false });
    // Back and Forward through the documents picked (`pick`): the entry's
    // document, read as the constructor reads it.
    this.onPop = (at) => this.set({ active: this.addressDoc(at) });
    this.onSheet = (sheet, push) => this.writeSheet(sheet, push);
    this.onKey = (event) => this.key(event);
    this.onComment = () => this.toggleComment();
  }

  componentDidMount() {
    this.mq = window.matchMedia ? window.matchMedia(NARROW) : null;
    if (this.mq) this.mq.addEventListener('change', this.onNarrow);
    subscribe(this.onPop);
    // In the capture phase: a KiCad design, mounted before this shell, listens
    // on the window too and puts its selection out on an Escape nobody took
    // (KicadView.jsx).
    window.addEventListener('keydown', this.onKey, true);
    // The queue takes the token, so a reader without one asks for nothing.
    if (this.token) this.loadFeed();
  }

  componentWillUnmount() {
    if (this.mq) this.mq.removeEventListener('change', this.onNarrow);
    unsubscribe(this.onPop);
    window.removeEventListener('keydown', this.onKey, true);
    clearTimeout(this.tt);
  }

  /** The document on screen. */
  docOnScreen() {
    return pickDocument(this.props.meta.documents, this.state.active);
  }

  /** The page's write: a patch that moves the open document (`active`) drops
   *  a place asked of a document before (`dropStaleFocus` in feedview.js). */
  set(patch) {
    this.setState(dropStaleFocus(patch, 'active'));
  }

  /** `said` on the toast, for as long as the model's page shows one. */
  toast(said) {
    clearTimeout(this.tt);
    this.setState({ toast: said });
    this.tt = setTimeout(() => this.setState({ toast: null }), TOAST_MS);
  }

  /** Document `id` on screen, a schematic on its `sheet` where one is given
   *  (its `s=` value, '' for the root), a step of history; the list shuts. A
   *  sheet given that differs from the address's is a step on the document on
   *  screen too. The address names no `?d=` for the default document, and no
   *  place in the document left: the hash goes. The schematic's sheet (`s=`)
   *  is the one given, which the schematic follows (`followPage` in
   *  KicadView.jsx), else it goes too: a design picked after another document
   *  opens on its root sheet, while its schematic picked after its own board,
   *  the element kept, writes back the sheet it is on (`writeSheet`). */
  pick(id, sheet) {
    const at = parse();
    if (id !== this.state.active || (sheet !== undefined && sheet !== (at.sheet || ''))) {
      const fallback = defaultDocument(this.props.meta.documents);
      const next = respell(at, { doc: fallback && fallback.id === id ? null : id, sheet: sheet || null });
      navigate({ ...next, hash: '' }, { push: true });
    }
    this.set({ active: id, viewsOpen: false });
  }

  /** The schematic's sheet on screen as KicadView reports it (`onSheet`):
   *  `sheet` the value of `s=`, '' for the root sheet. A step of history for
   *  the reader's own change (`push`), else the entry on screen rewritten.
   *  With the list of views open the page is drawn again, as the model's page
   *  is (`writeSheet` in HammerolaViewer.jsx). */
  writeSheet(sheet, push) {
    navigate(respell(parse(), { sheet }), { push });
    if (this.state.viewsOpen) this.forceUpdate();
  }

  /** The project's comment queue, fetched (`readFeed` in comments.jsx). */
  loadFeed(quiet = false) {
    return readFeed(this, this.token, quiet);
  }

  /** A fresh draft in the composer, which takes the keyboard; the tool goes
   *  down, as on the model's page. */
  openComposer(composer) {
    this.setState({ composer, tool: null }, () => {
      if (this.compBox.current) this.compBox.current.focus();
    });
  }

  /** A place taken on document `doc` with the Comment tool: the composer's
   *  draft hangs there (`docDraft` in comments.jsx). */
  docArea(doc, place) {
    if (this.viewer) return;
    this.openComposer(docDraft(doc, place, this.state.composer));
  }

  /** The composer's draft, sent (`sendDraft` in comments.jsx) with the frame
   *  of the document on screen, which the draft is on. */
  sendComment() {
    return sendDraft(this, {
      build: this.props.meta,
      token: this.token,
      frame: () => docFrame(this.state.tools),
      camera: () => null,
    });
  }

  /** Close an item in the queue (`closeComment` in comments.jsx). */
  resolveComment(id) {
    return closeComment(this, this.token, id);
  }

  /** The bar's Comment: the tool armed, saying how to take a place on the
   *  document on screen (`COMMENTABLE`), or put down; the list shuts. */
  toggleComment() {
    const arming = this.state.tool !== 'comment';
    this.setState({ tool: arming ? 'comment' : null, viewsOpen: false });
    if (arming) this.toast(COMMENTABLE.get(this.docOnScreen().type));
  }

  /** Escape puts the Comment tool down. It is taken where the tool was armed
   *  on the document on screen, as the model's page takes an Escape that
   *  closed something, so the design under it keeps its selection. */
  key(event) {
    if (event.key !== 'Escape' || this.state.tool === null) return;
    if (COMMENTABLE.has(this.docOnScreen().type)) event.preventDefault();
    this.setState({ tool: null });
  }

  /** The values of the comments (`DocPage`'s `comments`), built by the code
   *  the model's page builds its own with (comments.jsx, feedview.js). A
   *  row opens its document as a row of the list does (`pick`); this page has
   *  no model, so a row of a comment on one opens nothing. */
  comments() {
    const s = this.state;
    const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };
    const set = (patch) => this.set(patch);
    const setState = (patch) => this.setState(patch);
    const { threads, openCount } = feedView(s, {
      meta: this.props.meta, catalogue: null, stop, node: () => null, set,
      resolveComment: (id) => this.resolveComment(id),
      docOn: s.active,
      openDoc: (id, patch) => {
        this.pick(id);
        this.set(patch);
      },
    });
    return {
      docComment: docComment(s, {
        on: s.tool === 'comment' && !this.viewer,
        docArea: (doc, place) => this.docArea(doc, place),
        set, setState,
      }),
      ...composerView(s, {
        viewer: this.viewer, docOpen: this.docOnScreen(), tools: s.tools, stop, set, setState,
        toast: (said) => this.toast(said),
        sendComment: () => this.sendComment(),
      }),
      ...railView({ open: s.rail, viewer: this.viewer, narrow: s.narrow, threads, openCount, stop, setState }),
      box: this.compBox,
    };
  }

  render() {
    return <DocPage meta={this.props.meta} active={this.state.active}
                    base={PAGE.base} onPick={(id, sheet) => this.pick(id, sheet)}
                    narrow={this.state.narrow} viewer={this.viewer}
                    tools={this.state.tools} onTools={this.onTools} addressDoc={this.addressDoc}
                    onSheet={this.onSheet} viewsOpen={this.state.viewsOpen}
                    onToggle={(e) => {
                      e.stopPropagation();
                      this.setState({ viewsOpen: !this.state.viewsOpen });
                    }}
                    onClose={() => { if (this.state.viewsOpen) this.setState({ viewsOpen: false }); }}
                    tool={this.state.tool} onComment={this.onComment}
                    comments={this.comments()} toast={this.state.toast} />;
  }
}
