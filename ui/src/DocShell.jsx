// The page of a build with no model: the document, and the bar floating at the
// bottom — the model's page's bar, drawn by the same code (`toolBar` in
// viewlist.jsx), its list of views here with the build's documents only.
// BuildPage.jsx mounts it under the header (Header.jsx) instead of
// HammerolaViewer when the build's meta.json says `"kind": "documents"`
// (src/render.py).
//
// The document is drawn by DocumentView.jsx, which the model's page uses too,
// through its `DocumentLayers`: a KiCad design opened on the page stays
// mounted, hidden, while another document is on screen, and comes back without
// fetching its files again. The page holds which document is open — a row of
// a KiCad design's menu (KicadView.jsx) opens the other member through the
// same door a row does (`onPick`) — what the bar's Fit and Frame can do with it
// (`tools`), and whether the window is narrow, which takes the bar down to the
// list and Fit as on the model's page.
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
// (`pick`), and a mark on the drawing opens its row. The reader is the token
// BuildPage holds (`props.token`), which the header's Save and Remove change.
//
// The header reads this page through `headerParts()`: the comments' button,
// the toast, and the revision picker's rows as links (`revisions.href`) to
// their revision's address on the document and the sheet on screen (`d=`,
// `s=`), so a switch is a page load, which mounts the page the revision needs.
// No row carries a tick or a Share icon: a comparison is of the model's STEP,
// and this page has no Share window.
//
// `DocPage` is the drawing and takes everything as props, so a test reads the
// tree it returns without mounting anything (ui/tests/docshell.test.js).

import React from 'react';

import { format, fresh, navigate, parse, respell, subscribe, unsubscribe } from './address.js';
import {
  closeComment, commentRail, composerCard, composerView, docComment, docDraft,
  docFrame, railView, readFeed, sendDraft,
} from './comments.jsx';
import { COMMENTABLE, DocumentLayers, docUrl } from './DocumentView.jsx';
import { dropStaleFocus, feedView } from './feedview.js';
import { buildKey, buildPath, PAGE, pageVariant } from './hub.js';
import { MEASURE_HINT } from './KicadView.jsx';
import { BOM_TYPE } from './kicadbom.js';
import { btn, TOAST_MS, toastStyle } from './panelstyle.js';
import { readRetina } from './store.js';
import { css, FONTS, NARROW, PAGE_BG, PAGE_FG, SANS } from './style.jsx';
import {
  BAR_LAYER, DOC_LAYER, documentRows, quietBtn, savePng, settingsCard, settingsView, toolBar,
} from './viewlist.jsx';

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

// The box under the header (BuildPage.jsx), filled whole.
const SHELL = `position:absolute;inset:0;display:flex;flex-direction:column;background:${PAGE_BG};color:${PAGE_FG};font-family:${SANS};font-size:13px`;
// The document's stage and the comment rail beside it, which covers the stage
// on a narrow window (`railView` in comments.jsx).
const BODY = 'flex:1;display:flex;min-height:0;position:relative';
const STAGE = 'position:relative;flex:1;min-width:0';
// The bar's layer over the document's (`DOC_LAYER`, 16), as on the model's page.
const BAR = `${BAR_LAYER}18`;

/**
 * What this page's bar draws (`toolBar` in viewlist.jsx): the model's page's
 * bar, the same controls in the same places. Download and Copy link for the
 * open document's file (`docHref`, served under `base`) stand outside the bar
 * at the left of the strip (`DocFile` in viewlist.jsx), as they do over a
 * document there; a BOM, which has no file of its own (kicadbom.js), has
 * neither. Add primitive, about a model, is out of service, as it is over a
 * document there; so is Measure, but over a KiCad board, whose view hands
 * `tools.measure` (KicadView.jsx): there it flips the board's measure mode
 * (`onMeasure`) and is lit while the mode is on. Settings is in service: `settings` holds its
 * flag and toggle (`open`, `onToggle`) and its rows' answers (`settingsView` in
 * viewlist.jsx); with no model here its Retina row is out of service, as it is
 * over a document there. Comment is in service over a
 * document that takes a comment (`COMMENTABLE`), lit while armed (`tool`) and
 * armed or put down by `onComment`; Comment and Add primitive are hidden from
 * a reader without a token (`viewer`), as they are there; Fit and Frame act on
 * the document when its view can do them (`tools`, `onTools` in
 * DocumentView.jsx) and are out of service when it cannot; so is Insets, in
 * service over a KiCad schematic or board whose view hands `tools.insets`
 * (KicadView.jsx) and lit while its mode is on. A narrow window
 * keeps the list and Fit. AR, which only the model's page has, is not drawn
 * here. `onRename(doc)`, with the token, puts a pencil
 * before each row's name (`documentRows`). Pure.
 */
export function docBar({
  meta, doc, base, onPick, viewsOpen, onToggle, narrow, viewer, tools, tool, onComment, onMeasure, onRename,
  settings = {},
}) {
  const measure = (tools && tools.measure) || null;
  return {
    viewMenu: true, viewLabel: doc.name, viewsOpen: !!viewsOpen, viewsToggle: onToggle,
    viewTabs: [], docRows: documentRows(meta.documents, doc.id, onPick, base, buildKey(meta), onRename),
    docHref: doc.type === BOM_TYPE ? null : docUrl(base, doc),
    showTools: !narrow,
    tMeasure: measure ? onMeasure : undefined,
    measureBtnStyle: btn(Boolean(measure && measure.on), false, !measure),
    tInsets: tools && tools.insets ? tools.insets.toggle : undefined,
    insetsBtnStyle: btn(Boolean(tools && tools.insets && tools.insets.on), false, !(tools && tools.insets)),
    tComment: onComment,
    commentBtnStyle: btn(tool === 'comment', viewer, !COMMENTABLE.has(doc.type)),
    proposalBtnStyle: btn(false, viewer, true),
    tSettings: settings.onToggle,
    settingsBtnStyle: btn(!!settings.open, false, false),
    ...settingsView({
      open: settings.open, retina: settings.retina, tabStrip: settings.tabStrip, onTabStrip: settings.onTabStrip,
    }),
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
 * document: what a row of the list does, and a row of a KiCad design's menu
 * (KicadView.jsx); `onPick(id, sheet)` a schematic on a sheet, what a row of
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
 * `onRename(subject)`, with the token, is what the pencil on a document's row
 * asks to rename (`{kind, id, name}`, rename.jsx). `settings` is `docBar`'s.
 */
export function DocPage({
  meta, active, base, onPick, viewsOpen, onToggle, onClose, narrow, viewer, tools, onTools, addressDoc, onSheet,
  tool, onComment, onMeasure, comments, toast, onRename, settings,
}) {
  const doc = pickDocument(meta.documents, active);
  const renameDoc = onRename && ((one) => onRename({ kind: 'document', id: one.id, name: one.name }));
  const bar = docBar({ meta, doc, base, onPick, viewsOpen, onToggle, narrow, viewer, tools, tool, onComment, onMeasure,
    onRename: renameDoc, settings });
  return (
    <div onClick={onClose} style={{ ...css(SHELL), ...FONTS }}>
      <div style={css(BODY)}>
        <div style={css(STAGE)}>
          <DocumentLayers build={buildKey(meta)} doc={doc} layer={DOC_LAYER} documents={meta.documents} base={base}
                          onOpen={onPick} onTools={onTools} addressDoc={addressDoc} onSheet={onSheet}
                          comment={comments ? comments.docComment : undefined} />
          {/* Over the document, under the bar, as on the model's page. */}
          {comments && composerCard(comments, comments.box)}
          <div style={css(BAR)}>
            {toolBar(bar, { settings: settingsCard(bar) })}
          </div>
          <div style={css(toastStyle(!!toast))}>{toast}</div>
        </div>
        {comments && commentRail(comments)}
      </div>
    </div>
  );
}

/** The page, holding which document is open, and the comments. `meta` is
 *  required: BuildPage.jsx has read it to choose this page. BuildPage's doors
 *  (`onHeader`, `shutHeader`, `onRename`) are HammerolaViewer's too. */
export default class DocShell extends React.Component {
  constructor(props) {
    super(props);
    // The document address `at` (`parse` in address.js) names, its `?d=` or
    // the default one where it has none: what is open, and what a schematic's
    // sheet in the address is read against (`addressDoc` in KicadView.jsx),
    // which a bare `d=` would miss for a default schematic.
    this.addressDoc = (at) => pickDocument(this.props.meta.documents, at.doc).id;
    this.state = {
      // The Retina answer is read once: its row is out of service here, so
      // nothing on this page changes it.
      active: this.addressDoc(parse()), viewsOpen: false, settingsOpen: false, retina: readRetina(), tools: null,
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
    // The composer's textarea, focused when the composer opens.
    this.compBox = React.createRef();
    this.tt = undefined;
    this.onTools = (tools) => this.setState({ tools });
    this.mq = null;
    // Narrowing puts an armed tool down, as on the model's page: its button
    // leaves the bar, and a phone has no Escape to put it down with.
    // The Settings card goes with its button, or the next widening brings it
    // back open.
    this.onNarrow = (event) => this.setState(event.matches
      ? { narrow: true, tool: null, settingsOpen: false } : { narrow: false });
    // Back and Forward through the documents picked (`pick`): the entry's
    // document, read as the constructor reads it.
    this.onPop = (at) => this.set({ active: this.addressDoc(at) });
    this.onSheet = (sheet, push) => this.writeSheet(sheet, push);
    this.onKey = (event) => this.key(event);
    this.onComment = () => this.toggleComment();
    this.onMeasure = () => this.toggleMeasure();
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
    if (this.props.token) this.loadFeed();
  }

  /** The token the header saved or removed, followed: the queue asked for
   *  under a new one; with none, what only a reader holding it has goes — the
   *  queue, the draft and the armed tool. And the header told the page
   *  changed, which it reads (`headerParts`). */
  componentDidUpdate(prev) {
    if (prev.token !== this.props.token) {
      if (this.props.token) this.loadFeed();
      else this.setState({ feed: [], composer: null, tool: null });
    }
    this.props.onHeader();
  }

  componentWillUnmount() {
    if (this.mq) this.mq.removeEventListener('change', this.onNarrow);
    unsubscribe(this.onPop);
    window.removeEventListener('keydown', this.onKey, true);
    clearTimeout(this.tt);
  }

  /** No token, no edits: no composer, no Comment, no pencils. */
  viewer() {
    return !this.props.token;
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
    return readFeed(this, this.props.token, quiet);
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
    if (this.viewer()) return;
    this.openComposer(docDraft(doc, place, this.state.composer));
  }

  /** The composer's draft, sent (`sendDraft` in comments.jsx) with the frame
   *  of the document on screen, which the draft is on. */
  sendComment() {
    return sendDraft(this, {
      build: this.props.meta,
      token: this.props.token,
      frame: () => docFrame(this.state.tools),
      camera: () => null,
    });
  }

  /** Close an item in the queue (`closeComment` in comments.jsx). */
  resolveComment(id) {
    return closeComment(this, this.props.token, id);
  }

  /** The bar's Comment: the tool armed, saying how to take a place on the
   *  document on screen (`COMMENTABLE`), or put down; the list shuts, and the
   *  header's menus with the click reaching the page (`onClose`). */
  toggleComment() {
    const arming = this.state.tool !== 'comment';
    this.setState({ tool: arming ? 'comment' : null, viewsOpen: false });
    if (arming) this.toast(COMMENTABLE.get(this.docOnScreen().type));
  }

  /** The bar's Measure over a KiCad board: its measure mode flipped
   *  (`tools.measure`, KicadView.jsx). Coming on, it puts the Comment tool
   *  down — one click mode on the board at a time — shuts the list and says
   *  how to measure. */
  toggleMeasure() {
    const measure = this.state.tools && this.state.tools.measure;
    if (!measure) return;
    if (!measure.on) {
      this.setState({ tool: null, viewsOpen: false });
      this.toast(MEASURE_HINT);
    }
    measure.toggle();
  }

  /** Escape puts the Comment tool down. It is taken where the tool was armed
   *  on the document on screen, as the model's page takes an Escape that
   *  closed something, so the design under it keeps its selection. */
  key(event) {
    if (event.key !== 'Escape' || this.state.tool === null) return;
    if (COMMENTABLE.has(this.docOnScreen().type)) event.preventDefault();
    this.setState({ tool: null });
  }

  /** The values of the comments (`DocPage`'s `comments`, the header's
   *  button reads its own from them, `headerParts`), built by the code
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
        on: s.tool === 'comment' && !this.viewer(),
        docArea: (doc, place) => this.docArea(doc, place),
        set, setState,
      }),
      ...composerView(s, {
        viewer: this.viewer(), docOpen: this.docOnScreen(), tools: s.tools, stop, set, setState,
        toast: (said) => this.toast(said),
        sendComment: () => this.sendComment(),
      }),
      ...railView({ open: s.rail, viewer: this.viewer(), narrow: s.narrow, threads, openCount, stop, setState }),
      box: this.compBox,
    };
  }

  /** The page's menus a toggle of the header shuts (Header.jsx): the list of
   *  documents and the Settings card. */
  closeMenus() {
    if (this.state.viewsOpen || this.state.settingsOpen) this.setState({ viewsOpen: false, settingsOpen: false });
  }

  /** What the header says of this page and does through it (Header.jsx): the
   *  revision picker's rows as links, each but the build on screen's to the
   *  address of its revision of the variant on screen, on the document and the
   *  sheet the address names (`d=`, `s=`); the comments' button; what the
   *  token opens here; the toast. */
  headerParts() {
    const variant = pageVariant(PAGE, this.props.meta);
    return {
      revisions: {
        href: (id) => {
          const at = parse();
          return format(fresh(buildPath(PAGE.pid, id, variant), { doc: at.doc, sheet: at.sheet }));
        },
      },
      comments: this.comments(),
      // The documents are open to every reader (`OPEN_SUFFIXES` and
      // `_listed_document` in src/app.py); the token opens the comments.
      tokenHint: 'EDIT_TOKEN — the same string `hammerola login` asks for. It opens writing a comment and Files, the revision\'s files in git. Without one you can still read and download every document; the other files download with the token, or from a link they were included in. It is kept in this browser, for the whole site.',
      toast: (said) => this.toast(said),
    };
  }

  render() {
    const viewer = this.viewer();
    return <DocPage meta={this.props.meta} active={this.state.active}
                    base={PAGE.base} onPick={(id, sheet) => this.pick(id, sheet)}
                    narrow={this.state.narrow} viewer={viewer}
                    tools={this.state.tools} onTools={this.onTools} addressDoc={this.addressDoc}
                    onSheet={this.onSheet} viewsOpen={this.state.viewsOpen}
                    onToggle={(e) => {
                      e.stopPropagation();
                      this.setState({ viewsOpen: !this.state.viewsOpen, settingsOpen: false });
                      this.props.shutHeader();
                    }}
                    onClose={() => {
                      this.closeMenus();
                      this.props.shutHeader();
                    }}
                    settings={{
                      open: this.state.settingsOpen,
                      // The list and Settings open upwards from buttons on
                      // one bar: two at once would overlap.
                      onToggle: (e) => {
                        e.stopPropagation();
                        this.setState({ settingsOpen: !this.state.settingsOpen, viewsOpen: false });
                        this.props.shutHeader();
                      },
                      retina: this.state.retina,
                      tabStrip: this.props.tabStrip,
                      onTabStrip: this.props.onTabStrip,
                    }}
                    tool={this.state.tool} onComment={this.onComment} onMeasure={this.onMeasure}
                    comments={this.comments()} toast={this.state.toast}
                    onRename={viewer ? undefined : (subject) => {
                      this.setState({ viewsOpen: false });
                      this.props.shutHeader();
                      this.props.onRename(subject);
                    }} />;
  }
}
