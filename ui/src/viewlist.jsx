// The bar at the bottom of a page, and the list of views in it: the button that
// names what is on screen, and the card of rows it opens upwards — the views a
// model declares, then the build's documents. Both pages draw it with this, so
// it is one bar and one look: the model's page (HammerolaViewer.jsx, its values
// from chromeview.js) and the page of a build with no model (DocShell.jsx),
// which has documents only.
//
// THE BAR IS THE SAME EVERYWHERE (`toolBar`): the views, Measure, Comment, Add
// primitive, Fit, Frame and Settings, in that order, over the model, over a
// document and on the page of documents alike. A tool that does not apply to
// what is on screen keeps its place, out of service (`OFF` in panelstyle.js).
// While a document is on screen, of whatever type, Download and Copy link for
// its file stand at the left end of the bottom strip, outside the bar (`DocFile`):
// the one place either page offers them, since most documents are drawn by a
// view that has no such control of ours (a PDF's frame, a picture, a page of
// text).
//
// Every listed document is one row, a KiCad schematic, board and 3D model as
// much as a PDF, except one listed `hidden`: it has no row and is still opened
// by its address (`?d=`) or by a link from another document. A schematic of
// more than one file has its sheets in a submenu beside its row (`SheetRows`).
//
// THE ROWS STAND IN GROUPS, each under a heading, as the Downloads menu's do:
// the views first, then the documents a group per kind (`docGroup`), so the
// five markdown notes of a project read as one block wherever the project
// lists them. Headings only, no rule between the groups: the owner had the
// rule between the views and the documents taken out (SPEC 4).
//
// `viewList` and `toolBar` are the drawing and take everything as arguments,
// so a test reads the tree they return without mounting anything
// (ui/tests/viewmenu.test.js, viewdocs.test.js, docshell.test.js); the sheets'
// rows are a component of their own (`SheetRows`).

import React from 'react';

import { parse } from './address.js';
import CopyLink, { WORDS_CLASS } from './copylink.jsx';
import { docExt, docHint, docSize, FILE_TYPE } from './DocumentView.jsx';
import { shortId } from './hub.js';
import { schematicSheets } from './kicadpages.js';
import { fileUrl, sheetFromQuery, sheetQueryValue, viewOf } from './KicadView.jsx';
import {
  DIALOG_BTN, ELLIPSIS, FAINT_MONO, INK, OFF, ON_ACCENT_EDGE, QUIET_BTN, RELATIVE, RULE, TAB_OFF, TAB_ON,
} from './panelstyle.js';
import { Pencil, RENAME_HOST } from './rename.jsx';
import { css, MONO, SANS } from './style.jsx';

/** One row of the list, a view's or a document's: the same shape for both, so
 *  the two halves read as one list. Set in from its group's heading
 *  (`GROUP_HEAD`), as a file row of the Downloads menu is; a schematic's
 *  sheet has the same row (`SheetRows`). */
export const menuRow = (on) => `display:flex;align-items:center;gap:10px;padding:7px 14px 7px 22px;font:400 12px ${SANS};cursor:pointer;`
  + (on ? 'color:var(--accent-text);background:var(--accent-bg)' : INK);

/** A group's heading: the Downloads menu's (`headStyle` in downloadsview.js). */
export const GROUP_HEAD = `padding:8px 14px 3px;font:600 10px ${MONO};color:var(--text-muted);letter-spacing:.08em`;

/** The heading the model's views stand under. */
export const VIEWS_GROUP = '3D VIEWS';

/** The heading `View in AR` stands under, the last of the card (`arGroup`). */
export const AR_GROUP = 'AR';

/** The heading a document's row stands under: a member of a KiCad design under
 *  KICAD — its schematic, board and the board's 3D model are one design the
 *  page moves between (`Show in …`), not three kinds of file — a file the page
 *  does not draw under its extension, as the Downloads menu groups it, any
 *  other document under its type. */
export function docGroup(doc) {
  if (viewOf(doc)) return 'KICAD';
  return (doc.type === FILE_TYPE ? docExt(doc) : doc.type).toUpperCase();
}

/** What a row says beside its name once the heading has said the type: a
 *  KiCad member which one it is (`docHint`), any other document its size. */
const rowHint = (doc) => (viewOf(doc) ? docHint(doc) : docSize(doc.bytes));

/**
 * The build's documents as rows, one per document not listed `hidden`, in the
 * order the project lists them: the name (its `title`, else its path in the
 * tree), its heading (`docGroup`) and its hint. `open` is the id of the
 * document on screen, or null; `choose(id)` is what a row does. A KiCad
 * schematic of more than one file carries what its sheets need (`SheetRows`):
 * itself as `doc`, `base`, the address the build's files are served under,
 * `build`, the build's key (`buildKey` in hub.js), whether it is `on` screen,
 * and `chooseSheet(value)`, which is `choose(id, value)` with a sheet's `s=`
 * value. With `rename(doc)`, a row carries `onRename`, its pencil's
 * (rename.jsx).
 */
export function documentRows(documents, open, choose, base, build, rename) {
  return documents.filter((doc) => !doc.hidden).map((doc) => ({
    key: doc.id, label: doc.name, group: docGroup(doc), hint: rowHint(doc), rowStyle: menuRow(open === doc.id),
    onClick: () => choose(doc.id),
    onRename: rename ? () => rename(doc) : undefined,
    ...(doc.type === 'schematic' && doc.kicad.schematics.length > 1
      ? { doc, base, build, on: open === doc.id, chooseSheet: (value) => choose(doc.id, value) } : {}),
  }));
}

/**
 * The menu's rows under their headings, as `[heading, rows]`: the views first,
 * then a group per heading the documents carry, the groups in the order their
 * first row is listed and the rows of each in theirs.
 */
export function menuGroups(views, documents) {
  const groups = new Map(views.length ? [[VIEWS_GROUP, views]] : []);
  for (const row of documents) {
    if (!groups.has(row.group)) groups.set(row.group, []);
    groups.get(row.group).push(row);
  }
  return [...groups];
}

/** The button. As wide as the name it shows, the chevron right after it, so
 *  that no empty space is left after a short name; the bar grows or shrinks
 *  about its centre with the name from view to view (AGENTS.md). A view's name
 *  is the model's own sentence and can be any length; the button sits in a
 *  bar that must not grow past the window, so it is capped and the name is cut
 *  rather than allowed to push. */
export const viewButtonStyle = (open) => `display:flex;align-items:center;gap:7px;padding:5px 11px;border-radius:5px;font:500 12px ${SANS};cursor:pointer;max-width:220px;`
  + (open ? TAB_ON : TAB_OFF);

// How the card looks, and the submenu of a schematic's sheets beside it
// (`SheetRows`).
const CARD_LOOK = 'background:var(--card-bg);border:1px solid var(--line);border-radius:9px;box-shadow:0 10px 34px var(--shadow);padding:6px 0;';

/**
 * The card. Opens upwards, unlike every other popover on these pages: the bar
 * floats at the bottom, so a menu measured from the top of its button would be
 * drawn off the bottom of the window.
 *
 * `bottom:38px` is a measurement: the button is about 25px tall (a 12px line
 * box and 5px padding either side), the bar adds 4px padding and a 1px border,
 * the rest is the gap between the cards. It moves with `viewButtonStyle`, or
 * the menu covers the control that opened it.
 *
 * No sheet on a narrow window: the bar has `contain:layout`, which makes it the
 * containing block for `fixed` as well as `absolute` descendants (CSS
 * Containment 1, §3.2), so `popSheet` would resolve against the bar. No clamp
 * either: the bar is centred on the bottom edge and the button never stands in
 * it alone — on a narrow window Fit is beside it (`toolBar`) — so the card
 * starts at the button's left edge. How far right that edge is depends on the
 * bar's width: a bar that holds the tools (`wide`) starts far enough left for
 * 360px on a 721px window, the narrowest that has them; the button and Fit
 * alone keep the card to 260px, which fits a 320px window.
 *
 * No `z-index`: the bar is its own stacking context, so a value here only sorts
 * this menu against its siblings; the page raises the bar's layer instead
 * (`toolbarStyle` in chromeview.js).
 *
 * Capped, and scrolling past the cap: the page's header lies over the bar's
 * layer, so a card reaching under it would hide its first rows where no scroll
 * brings them back. Beside the tools the cap is the window less 240px: the
 * card's bottom edge stands 57px above the window's, and the header with its
 * strip of tabs ends at 85px (98px at 721px, where the header wraps; measured),
 * which leaves room for two more rows of tabs. `dvh`, not `vh`: on a tablet
 * `vh` counts the browser's toolbar as hidden, and this page never scrolls it
 * away. On a narrow window the header wraps again and every open project can
 * add a row of tabs, so no length off the window holds; the card keeps
 * 308px there. The card itself scrolls, views and documents together: it is
 * one list with one scroll, not a list of views and a list of documents
 * scrolling apart.
 */
export const viewMenuStyle = (open, wide = true) => 'position:absolute;left:0;bottom:38px;'
  + (wide ? 'width:360px;max-height:calc(100dvh - 240px);' : 'width:260px;max-height:308px;') + 'overflow:auto;'
  + `${CARD_LOOK}display:` + (open ? 'block' : 'none');

// A row's name and its hint share a row of a narrow menu: the hint (`4.7 MB`,
// `37 parts · 4.8 MB`) stays on one line and the name wraps.
export const DOC_LABEL = 'flex:1;min-width:0;overflow-wrap:anywhere';
export const DOC_HINT = `flex:none;white-space:nowrap;${FAINT_MONO}`;
// A name kept to one line and cut by an ellipsis where it runs out of room: the
// view button's and a sheet's in its submenu (`SheetRows`).
const CUT_NAME = `${ELLIPSIS};min-width:0`;

// The bar the button sits in, floating at the bottom of the page.
// `contain:layout` and NOT a `backdrop-filter`: both make the bar the
// containing block and stacking context its menus are built around, but a
// backdrop filter over the WebGL canvas cost a third of the frame rate while
// orbiting on a retina Mac (measured).
// Never wider than its layer, and narrower still beside `DocFile` where the
// strip is short of room (`min-width:0` lets the layer shrink it): where the
// controls do not fit, the view button (`viewList`) or the strip of views
// (`TAB_STRIP`) gives up its width first, the names in it cut by an ellipsis.
export const FLOAT_BAR = 'pointer-events:auto;display:flex;align-items:center;gap:8px;padding:4px;min-width:0;max-width:calc(100% - 24px);background:var(--float-bg);contain:layout;border:1px solid var(--line);border-radius:9px;box-shadow:0 4px 16px var(--shadow-soft)';
// Its layer, centred on the bottom edge, the z-index appended by the page.
export const BAR_LAYER = 'position:absolute;left:0;right:0;bottom:12px;display:flex;justify-content:center;pointer-events:none;z-index:';
// A document, over the whole of the page's area down to its bottom edge, under
// the bar. The bottom padding is the bar's strip: the last lines of a page and
// the end of a PDF's frame stop above the button rather than under it.
export const DOC_LAYER = 'position:absolute;top:0;left:0;right:0;bottom:0;overflow:auto;padding-bottom:72px;box-sizing:border-box;background:var(--page-bg);z-index:16';

const CHEVRON = <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 6l4 4 4-4" /></svg>;

// The chevron at the right end of a schematic's row, turned to point right:
// the mark of a row with a submenu.
const SUBMENU_MARK = 'flex:none;display:flex;color:var(--text-muted);transform:rotate(-90deg)';
// The submenu of a schematic's sheets: the card's look, as wide as its longest
// name within bounds, no taller than the card's cap and scrolling past that
// (`SheetRows`); `height` is the cap, null until it is measured.
const sheetsFlyout = (height) => 'position:fixed;box-sizing:border-box;min-width:160px;max-width:260px;'
  + `overflow:auto;${CARD_LOOK}` + (height ? `max-height:${height}px` : '');
// The one quiet row while the sheets' files come in, set in as a sheet's row.
const SHEETS_LOADING = `padding:7px 14px 7px 22px;${FAINT_MONO}`;
// How long the submenu outlives the pointer leaving the row or the submenu: the
// way from one to the other may cross a gap or a corner of the next row.
const SHEETS_LINGER_MS = 200;
// How far the submenu stands from the card, and at least from the window's edges.
const FLYOUT_GAP = 4;
const FLYOUT_MARGIN = 8;

/**
 * A KiCad schematic's row and the submenu of its sheets (`schematicSheets` in
 * kicadpages.js), for a row that carries `chooseSheet` (`documentRows`); `open`
 * is whether the card is. The row opens the schematic as any row does; the
 * chevron at its right end points right, the mark of a submenu. The submenu
 * stands beside the card, its top at the row's, raised where its bottom would
 * pass the card's: below the card is the bar, whose controls it would cover.
 * It reaches no higher than the card may — the card's cap (`viewMenuStyle`)
 * keeps clear of the page's header — and is no taller than that, so that a
 * short card does not squeeze it. The mouse shows it on entering the row, and
 * it goes a moment (`SHEETS_LINGER_MS`) after the pointer has left the row and
 * the submenu both, so that the way from one to the other keeps it; a click on
 * the chevron shows it too. A touch screen has no hover: there a tap on the
 * chevron shows or hides it, a tap that is not the row's. Hidden until shown,
 * the schematic on screen or not; drawn only in an open card, and hidden again
 * when the card closes, so that the next opening starts without it. Not drawn
 * where the sheets' files failed: there are no sheets to show.
 *
 * `position:fixed`, so that the card's `overflow:auto` does not cut it off at
 * the card's edge. The bar's `contain:layout` makes the bar, not the window,
 * what a `fixed` box is measured from (`viewMenuStyle`), so the submenu is
 * placed by measuring (`place`): the bar's corner in the window is where the
 * submenu stands less the offsets it was given. Kept inside the window: on a
 * narrow one, with no room beside the card, it lies over the card at the
 * window's right edge.
 *
 * The sheets are read from the schematic's files the first time the submenu
 * is shown in an open card, not at every opening: they are the files its viewer
 * reads, about a megabyte for a real design. Read once for each build: a
 * document keeps its id from revision to revision, so the list keys this
 * component by the build too (`viewList`), and a revision switched to in place
 * reads its own sheets. While they come in, one quiet row
 * says so; where they fail there are no sheets. A sheet's row is the page's
 * choice of it (`chooseSheet` with its `s=` value, `sheetQueryValue` in
 * KicadView.jsx); with the schematic on screen the sheet the address names is
 * lit (`sheetFromQuery`), no `s=` naming the root, as the open document's row is.
 * The root's row, unless it is the one lit, names the root by its path rather
 * than by no `s=`: an address with none is also what the schematic's own row
 * writes, which takes up the sheet the hidden schematic is on (KicadView.jsx
 * `componentDidUpdate`); the schematic then drops the path from the address.
 */
export class SheetRows extends React.Component {
  constructor(props) {
    super(props);
    // `shown`: whether the submenu is. `pages`: the sheets once read, null
    // before. `left` and `top`: the submenu's offsets from the bar, and
    // `height` the card's cap, as `place` measures them.
    this.state = { shown: false, pages: null, left: 0, top: 0, height: null };
    this.asked = false;
    this.rowBox = React.createRef();
    this.flyoutBox = React.createRef();
    // The mouse's pointer alone: a touch's enters and leaves too, on its way
    // to a click.
    this.enter = (event) => {
      if (event.pointerType !== 'mouse') return;
      this.keep();
      this.setState({ shown: true });
    };
    this.leave = (event) => {
      if (event.pointerType !== 'mouse') return;
      this.keep();
      this.timer = setTimeout(() => this.setState({ shown: false }), SHEETS_LINGER_MS);
    };
    this.keep = () => clearTimeout(this.timer);
    // The chevron's pointer, told on its press. A mouse's click only shows the
    // submenu, which entering the row has shown already; a touch's shows or
    // hides it. Not the row's click, which opens the schematic.
    this.pressed = (event) => {
      this.pointer = event.pointerType;
    };
    this.toggle = (event) => {
      event.stopPropagation();
      this.keep();
      this.setState({ shown: this.pointer === 'mouse' || !this.state.shown });
    };
  }

  componentDidUpdate() {
    if (!this.props.open && this.state.shown) {
      this.setState({ shown: false });
      return;
    }
    this.read();
    this.place();
  }

  componentWillUnmount() {
    this.gone = true;
    this.keep();
  }

  /** The submenu beside the card (the row's parent), inside the window and
   *  within the card's reach, moved only where it is off by more than a
   *  rounding, so that the move does not call for another. */
  place() {
    const flyout = this.flyoutBox.current;
    if (!flyout) return;
    const row = this.rowBox.current.getBoundingClientRect();
    const cardBox = this.rowBox.current.parentElement;
    const card = cardBox.getBoundingClientRect();
    const cap = parseFloat(getComputedStyle(cardBox).maxHeight);
    const box = flyout.getBoundingClientRect();
    const { left, top, height } = this.state;
    const x = Math.max(FLYOUT_MARGIN, Math.min(card.right + FLYOUT_GAP, window.innerWidth - box.width - FLYOUT_MARGIN))
      - (box.left - left);
    const y = Math.max(card.bottom - cap, Math.min(row.top, card.bottom - box.height)) - (box.top - top);
    const off = (a, b) => b === null || Math.abs(a - b) > 0.5;
    if (off(x, left) || off(y, top) || off(cap, height)) this.setState({ left: x, top: y, height: cap });
  }

  /** The sheets read once, when the submenu is first shown in an open card. */
  read() {
    if (this.asked || !this.props.open || !this.state.shown) return;
    this.asked = true;
    const { doc, base } = this.props.row;
    const files = doc.kicad.schematics;
    Promise.all(files.map((file) => fetch(fileUrl(base, file)).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    })))
      .then((texts) => schematicSheets(Object.fromEntries(files.map((file, i) => [file, texts[i]])), files[0]), () => [])
      .then((pages) => {
        if (!this.gone) this.setState({ pages });
      });
  }

  render() {
    const { row, open } = this.props;
    const { pages, shown, left, top, height } = this.state;
    const named = row.on && pages && sheetFromQuery(pages, parse().sheet);
    return (
      <>
        <div ref={this.rowBox} onClick={row.onClick} onPointerEnter={this.enter} onPointerLeave={this.leave}
             className={row.onRename ? RENAME_HOST : undefined} style={css(row.rowStyle)}>
          <span style={css(DOC_LABEL)}>
            {row.label}
            {row.onRename && <Pencil title="Rename document" onClick={row.onRename} />}
          </span>
          <span style={css(DOC_HINT)}>{row.hint}</span>
          <span onPointerDown={this.pressed} onClick={this.toggle} style={css(SUBMENU_MARK)}>{CHEVRON}</span>
        </div>
        {open && shown && !(pages && !pages.length) && (
          <div ref={this.flyoutBox} onPointerEnter={this.keep} onPointerLeave={this.leave}
               style={{ ...css(sheetsFlyout(height)), left, top }}>
            {pages ? pages.map((page) => (
              <div key={page.projectPath} onClick={() => row.chooseSheet(page.parentProjectPath || page.projectPath === named
                ? sheetQueryValue(pages, page.projectPath) : page.projectPath)}
                   style={css(menuRow(page.projectPath === named))}>
                <span style={css(CUT_NAME)}>{page.name}</span>
              </div>
            )) : <div style={css(SHEETS_LOADING)}>loading…</div>}
          </div>
        )}
      </>
    );
  }
}

// The row `View in AR` (`viewList`) out of service while its file is made.
const AR_OFF = `${menuRow(false)};${OFF}`;

/**
 * The heading and the row of `View in AR` (`arRow` in chromeview.js), where
 * the browser has AR Quick Look and a model view is on screen: a row like the
 * card's others, whose `onClick` makes the file and opens Quick Look
 * (`openAr` in HammerolaViewer.jsx). Without `onClick` it is out of service;
 * `hint` says why, or that the last try failed.
 */
const arGroup = (ar) => [
  <div key="group:ar" style={css(GROUP_HEAD)}>{AR_GROUP}</div>,
  <div key="ar" onClick={ar.onClick || undefined} style={css(ar.onClick ? menuRow(false) : AR_OFF)}>
    <span style={css(DOC_LABEL)}>View in AR</span>
    <span style={css(DOC_HINT)}>{ar.hint}</span>
  </div>,
];

/**
 * The button and its card, as elements. `views` and `documents` are rows
 * (`{ key, label, hint, rowStyle, onClick }`, a document's with its `group`,
 * a schematic's of several files with what its sheets need, any of them with
 * `onRename`, which puts a pencil right after its name), drawn in their
 * groups (`menuGroups`), the documents under the views; `wide` is whether the
 * bar holds the tools (`viewMenuStyle`). `onToggle` must stop the click: the
 * pages shut their menus on a click that reaches the root. Pure, but for the
 * sheets' rows (`SheetRows`).
 *
 * The wrapper is `position:relative` so that the card is anchored to the
 * BUTTON: the bar carries `contain:layout` and is therefore already a
 * containing block for it, so without the wrapper the card would be measured
 * from the bar's whole box and start at its left end rather than at the button.
 * It is also what shrinks when the bar is short of room (`FLOAT_BAR`): a shrink
 * far above the other controls' and no minimum width, so the name is cut before
 * any other label wraps.
 *
 * `ar` is the card's last group, `View in AR` (`arGroup`), or null.
 */
export function viewList({ label, open, onToggle, views = [], documents = [], wide = true, ar = null }) {
  return (
    <div style={css(`${RELATIVE};min-width:0;flex-shrink:100`)}>
      <div onClick={onToggle} title={label} style={css(viewButtonStyle(open))}>
        <span style={css(CUT_NAME)}>{label}</span>
        {CHEVRON}
      </div>
      <div onClick={(e) => e.stopPropagation()} style={css(viewMenuStyle(open, wide))}>
        {/* One array per group, so that a view and a document sharing a key
            are siblings of different arrays rather than of one. */}
        {[...menuGroups(views, documents).map(([head, rows]) => [
          <div key={`group:${head}`} style={css(GROUP_HEAD)}>{head}</div>,
          ...rows.map((t) => (t.chooseSheet ? <SheetRows key={`${t.build}:${t.key}`} row={t} open={open} /> : (
            <div key={t.key} onClick={t.onClick} className={t.onRename ? RENAME_HOST : undefined}
                 style={css(t.rowStyle)}>
              <span style={css(DOC_LABEL)}>
                {t.label}
                {t.onRename && (
                  <Pencil title={head === VIEWS_GROUP ? 'Rename view' : 'Rename document'} onClick={t.onRename} />
                )}
              </span>
              <span style={css(DOC_HINT)}>{t.hint}</span>
            </div>
          ))),
        ]), ...(ar ? [arGroup(ar)] : [])]}
      </div>
    </div>
  );
}

/** Fit's and Frame's look: quiet, and out of service (`OFF`) where what is on
 *  screen cannot do them. */
export const quietBtn = (off) => QUIET_BTN + (off ? `;${OFF}` : '');

/** The views as a strip of tabs, while they fit (`VIEW_TABS_MAX`). Where the
 *  bar is short of room it is the strip that shrinks, as the view button does
 *  (`viewList`), its pills' names cut by their ellipsis. */
const TAB_STRIP = 'display:flex;gap:2px;padding:2px;min-width:0;flex-shrink:100;background:var(--chip-bg);border-radius:6px';

// The open document's file, on the strip to the left of the bar.
//
// The strip's two sides share what the bar leaves, so the bar stays centred:
// `FILE_SIDE` holds the buttons at the left edge and cannot get narrower than
// they are, `FILE_SPACER` balances it on the right. Where the buttons do not
// fit beside the centred bar, the side keeps its width and the bar moves right
// and shrinks, so the two never overlap.
// Its padding: from the strip's left edge, and from the bar.
const FILE_SIDE_PAD = [12, 8];
const FILE_SIDE = `flex:1 1 0;display:flex;flex-direction:column;justify-content:center;padding:0 ${FILE_SIDE_PAD[1]}px 0 ${FILE_SIDE_PAD[0]}px`;
// The same padding, mirrored: a side's share of the strip starts from its
// padding, so unequal padding would set the bar off centre by half the difference.
export const FILE_SPACER = `flex:1 1 0;padding:0 ${FILE_SIDE_PAD[0]}px 0 ${FILE_SIDE_PAD[1]}px`;
// One line, so that a row's width is the whole width of its words.
const FILE_ROW = 'display:flex;align-items:center;gap:8px;white-space:nowrap';
// Words or icons is decided by CSS alone (`DocFile`), from two copies of the
// row nobody sees: no clicks, no focus, nothing read out.
//   `FILE_FLOOR`, the row in icons and no height, stacked over the rest: what
//   the side cannot get narrower than, since a flex item's least width is its
//   content's.
//   `FILE_FIT`, the side's width in two columns: the words' width while there
//   is room for it (`FILE_RULER`, the row in words), and the room left beside
//   them (`FILE_ROOM`). The room's column gives up its width first; once it
//   is at nothing, the ruler's column shrinks, and it counts for nothing in
//   the side's least width (`minmax(0, max-content)`).
// The buttons themselves stand in the room and run over the ruler's column.
// The room is a container: wider than nothing, the words fit and the buttons
// spell them (`FILE_CSS`); at nothing they are icons, which the floor keeps room for.
const UNSEEN = 'visibility:hidden;overflow:hidden';
const FILE_FLOOR = `height:0;${UNSEEN}`;
const FILE_FIT = 'display:grid;grid-template-columns:minmax(0,1fr) minmax(0,max-content);align-items:center';
const FILE_ROOM = 'grid-area:1/1;min-width:0;container:hmr-file/inline-size';
const FILE_RULER = `grid-area:1/2;${UNSEEN}`;
const SPELT_CLASS = 'hmr-spelt';
const FILE_CSS = `.${WORDS_CLASS}{display:none}.${SPELT_CLASS} .${WORDS_CLASS}{display:inline}`
  + `@container hmr-file (width > 0px){.${WORDS_CLASS}{display:inline}}`;
// Buttons as the Share dialog's are (HammerolaViewer.jsx): Download filled with
// the accent like its Copy, Copy link edged on the card like its Close. The
// strip under them takes no clicks (`BAR_LAYER`), so each takes its own.
const FILE_BTN = `${DIALOG_BTN}gap:6px;user-select:none;font:600 12px ${SANS};text-decoration:none;pointer-events:auto;`;
export const FILE_DOWNLOAD = `${FILE_BTN}${ON_ACCENT_EDGE}`;
export const FILE_COPY = `${FILE_BTN}border:1px solid var(--line);background:var(--card-bg);color:var(--text)`;
const DOWNLOAD_ICON = <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 1.5v9M4.5 7L8 10.5 11.5 7M2 13.5h12" /></svg>;

/** The row: Download and Copy link for `href`, their words in `WORDS_CLASS`.
 *  Copy link is a sibling of the link, never inside it (copylink.jsx). */
const fileRow = (href) => (
  <div style={css(FILE_ROW)}>
    <a href={href} download title="Download" style={css(FILE_DOWNLOAD)}>
      {DOWNLOAD_ICON}
      <span className={WORDS_CLASS}>Download</span>
    </a>
    <CopyLink href={href} bar style={FILE_COPY} />
  </div>
);

/**
 * Download and Copy link for `href`, the open document's file, in words while
 * the words fit between the strip's left edge and the centred bar, as icons
 * with the words in their titles when they do not (`FILE_FIT`). Mounted as the
 * bar's previous sibling in its layer (`toolBar`). Pure.
 */
export function DocFile({ href }) {
  return (
    <div style={css(FILE_SIDE)}>
      <style>{FILE_CSS}</style>
      <div style={css(FILE_FLOOR)}>{fileRow(href)}</div>
      <div style={css(FILE_FIT)}>
        <div style={css(FILE_ROOM)}>{fileRow(href)}</div>
        <div className={SPELT_CLASS} style={css(FILE_RULER)}>{fileRow(href)}</div>
      </div>
    </div>
  );
}

/**
 * The bar, as elements: the same controls in the same places on both pages
 * and over every view. `b` holds the values — the model's page computes them
 * (chromeview.js), the page of documents builds them (`docBar` in
 * DocShell.jsx):
 *   the views    `viewMenu` (a menu rather than a strip), `viewLabel`,
 *                `viewsOpen`, `viewsToggle`, `viewTabs`, `docRows`, and
 *                `arRow`, the menu's `View in AR` (`viewList`), which only
 *                the model's page has;
 *   the document `docHref`, the address the open document's file downloads
 *                from (`docUrl` in DocumentView.jsx), or null with none open:
 *                Download (a link that takes the file) and Copy link for it,
 *                drawn outside the bar at the left end of the strip
 *                (`DocFile`), and with none open not at all;
 *   the tools    `showTools` (false on a narrow window, which keeps the views
 *                and Fit), and each tool's style and handler: `measureBtnStyle`
 *                and `tMeasure`, `commentBtnStyle` and `tComment`,
 *                `proposalBtnStyle` and `tProposal`, `fitBtnStyle` and
 *                `fitView`, `frameBtnStyle` and `grabFrame`, `settingsBtnStyle`
 *                and `tSettings`. A tool out of service is drawn `OFF` and
 *                takes no click, so its handler may be absent.
 * `menus` are the cards `Add primitive` and Settings open (`proposal`,
 * `settings`), which only the model's page has. Pure. What it returns goes
 * straight into the layer (`BAR_LAYER`): the bar alone, or with a document
 * open `DocFile`, the bar and `FILE_SPACER`, in that order.
 */
export function toolBar(b, menus = {}) {
  const bar = floatBar(b, menus);
  if (!b.docHref) return bar;
  return (
    <>
      <DocFile href={b.docHref} />
      {bar}
      <div style={css(FILE_SPACER)} />
    </>
  );
}

function floatBar(b, menus) {
  return (
    <div style={css(FLOAT_BAR)}>
      {/* A STRIP WHILE THE VIEWS FIT AND NOTHING ELSE NEEDS A ROW, ELSE A
          MENU (`viewMenu` in chromeview.js): the views past `VIEW_TABS_MAX`,
          the build's documents under them, `View in AR` last. A pill's
          tooltip starts with the view's whole name: a short bar cuts its
          caption, and the strip has no menu to read it in. */}
      {b.viewMenu ? (
        viewList({ label: b.viewLabel, open: b.viewsOpen, onToggle: b.viewsToggle,
          views: b.viewTabs, documents: b.docRows, wide: b.showTools, ar: b.arRow })
      ) : (
        <div className={b.renameView ? RENAME_HOST : undefined} style={css(TAB_STRIP)}>
          {b.viewTabs.map((t) => (
            <div key={t.key} onClick={t.onClick} title={`${t.label} · ${t.hint}`} style={css(t.style)}>{t.label}</div>
          ))}
          {b.renameView && (
            <div style={css('display:flex;align-items:center')}>
              <Pencil title="Rename view" onClick={b.renameView} />
            </div>
          )}
        </div>
      )}
      {/* Everything between the views and Fit belongs to a pointer and a
          canvas with room to aim in — see `showTools`. */}
      {b.showTools && (
        <>
          <div style={css(RULE)} />
          <div onClick={b.tMeasure} style={css(b.measureBtnStyle)}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 14L14 2M2 14l2.2-.55M14 2l-.55 2.2M6.2 9.8l1.4 1.4M9 7l1.4 1.4" /></svg>
            Measure
          </div>
          <div onClick={b.tComment} style={css(b.commentBtnStyle)}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 2.5h12v8.5H8.5L5.5 14v-3H2z" /><path d="M5 5.5h6M5 8h4" /></svg>
            Comment
          </div>
          {/* A box drawn in the air beside the model — which is what this
              adds: a rough body in numbers, over the geometry rather than in
              it.

              THE WRAPPER IS `position:relative` FOR THE REASON THE VIEW
              SWITCHER'S IS: the bar carries `contain:layout` and is therefore
              already a containing block for the menu (CSS Containment 1,
              §3.2), so without it the card would be measured from the bar's
              whole box and start at its left end rather than at the button. */}
          <div style={css(RELATIVE)}>
            {/* The one label of two words: kept on one line, so that the
                bar short of room cuts the view's name (`viewList`) instead. */}
            <div onClick={b.tProposal} style={css(`${b.proposalBtnStyle};white-space:nowrap`)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 4.6L8 1.8l6 2.8v6.8L8 14.2 2 11.4z" /><path d="M2 4.6L8 7.4l6-2.8M8 7.4v6.8" /></svg>
              Add primitive
            </div>
            {menus.proposal}
          </div>
          <div style={css(RULE)} />
        </>
      )}
      <div onClick={b.fitView} title="back to the frame this view opened in" style={css(b.fitBtnStyle)}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5" /></svg>
        Fit
      </div>
      {b.showTools && (
        <>
          <div onClick={b.grabFrame} title="save the current frame as a PNG" style={css(b.frameBtnStyle)}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1.5" y="4" width="13" height="9.5" rx="1.5" /><circle cx="8" cy="8.7" r="2.6" /></svg>
            Frame
          </div>
          {/* The `Add primitive` card's wrapper, for its reason. */}
          <div style={css(RELATIVE)}>
            <div onClick={b.tSettings} style={css(b.settingsBtnStyle)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="4.2" /><circle cx="8" cy="8" r="1.8" /><path d="M8 1.6v2.2M8 12.2v2.2M1.6 8h2.2M12.2 8h2.2M3.5 3.5l1.5 1.5M11 11l1.5 1.5M3.5 12.5L5 11M11 5l1.5-1.5" /></svg>
              Settings
            </div>
            {menus.settings}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Frame on both pages: `blob`, a PNG of what is on screen, handed to the
 * reader as a file named after the build, `<project>-<commit>.png`.
 */
export function savePng(blob, meta) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${meta.project}-${shortId(meta.commit)}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
