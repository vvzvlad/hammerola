// The BOM of a KiCad design on screen: a table of the parts the schematic's
// element counts (kicadbom.js), and what the reader narrows and orders it
// with. KicadView.jsx draws it as the design's BOM member and hands it the
// rows (`items`), the parts' datasheets and prices and what a click on a
// designator or a datasheet does; the search, the filters, the grouping and
// the order are this component's, and KicadView keeps it mounted while the BOM
// is off screen, so they are as the reader left them when it is back.
//
// OVER THE TABLE: a search field and a switch that groups identical parts into
// a row. Nothing of it is in the page's bar, which keeps its size on every
// view (AGENTS.md).
//
// EACH COLUMN'S HEAD: a click on its name sorts by it, a second the other way
// (it opens sorted by designator, as KiCad lists them); its funnel opens the
// column's filter under it, drawn after Grist's: a field that searches the
// entries, `All · None` (the one that is the state already out of service), an
// order of the entries by value or by count, then an entry per value of the
// column with its count (`bomFilters` in kicadbom.js), all checked at first,
// which is no filter; an unchecked one hides its parts, at once. `Close`, and a
// click outside, keep what is checked; `Cancel`, and Escape, put back what was
// checked when it opened, and that Escape is taken, so the design under it
// does nothing with it. A column filtered has its funnel in the accent.
// Values within a
// column are any of those checked, the columns and the search all at once.
//
// THE TABLE has kicad-cli's default columns, the datasheet, the price and the
// sum. A designator selects its part across the design and opens the board
// where the design lists one (`onPart`), else it is plain text. A datasheet
// that names a document of the build (kicadsheets.js) opens it in KicadView's
// window over the BOM (`onDatasheet`), as the part's menu does; a web address
// opens in a new tab, shown by its host. Price is the part's `Price` field as
// written (`prices`), a group's that of its first part naming one; Sum is what
// the row's parts' prices add up to (`priceOf` in kicadbom.js). Under the rows,
// where any part of the BOM has a price, a total: the Sum of the rows shown,
// DNP ones left out, and how many of their parts have no price (`bomTotal`).
//
// THE LAYOUT: the controls and the table one block in the middle of the page,
// as wide as the wider of them and never wider than the page; the controls are
// centred and wrap on a narrow screen, and a table wider than the page scrolls
// sideways inside the block, never the page itself. A filter is drawn in the
// block, not in the table's scrolling box, which would cut it off: under its
// column's head and moved left as far as it takes to stay inside the block
// (`place`).
//
// THE ASSEMBLY VIEW, iBOM's assembly helper in the page's own look, is the
// `Assembly` button over the table of a design that has a board, off at first;
// off, the BOM is the table above and nothing else. On, it adds:
//   * a band between the controls and the table with the board's Top and
//     Bottom side by side, held at the top of the BOM's scrolling box while the
//     rows scroll under it. Each picture has the board's proportions
//     (`getBoardPictureSize` of the board's element, `board`), half the band
//     wide, or narrower where the band would pass 40% of that box's height.
//     It is the element's own drawing of that side alone, fitted to the
//     outline (`renderBoardPicture`): its pads, silkscreen and fab, the bottom
//     mirrored. Over it a canvas of ours lights parts in their boxes
//     (`getFootprintBoxes`): those of the row selected in the accent, the rest
//     of the board faded, of the row under the pointer fainter, the placed
//     ones filled green (`partLooks` in kicadbom.js). The pictures are sized
//     again when the band or that box changes size, and drawn again once they
//     are and when the theme changes;
//   * a row under the pointer lights its parts; a click on a row, not on a
//     designator, a datasheet or a checkbox, selects it, a second click puts it
//     out. A click on a part in a picture selects the row that holds it as the
//     table is searched, filtered and grouped now, the smallest box first where
//     boxes overlap, and scrolls it into view; a
//     click on no part of a row shown puts the selection out;
//   * the Sourced and Placed columns first, a checkbox each, their heads plain.
//     A row's box is checked when all its parts are, half-checked when some
//     are, and a click ticks all of them or none. The ticks are this browser's,
//     per project and design, kept across revisions (`readAssembly` in
//     store.js, `pid` and `design` handed by KicadView).

import React from 'react';

import {
  amountText, BOM_COLUMNS, BOM_SORT, bomFilters, boardPoint, bomParts, bomTable, bomTotal, entryOrder, insideOutline,
  NO_FILTER, nextSort, partLooks, pictureSize, sumText,
} from './kicadbom.js';
import { datasheetDocument } from './kicadsheets.js';
import { btn, CHECK, OFF, ON_ACCENT_EDGE, SEGMENTED, SUNKEN } from './panelstyle.js';
import { readAssembly, writeAssembly } from './store.js';
import { css, MONO, SANS } from './style.jsx';

const HOST = /^https?:\/\/([^/?#]*)/i;

/** The datasheet of part `ref`, from `props`: the document of the build its
 *  `Datasheet` value names (`datasheets`, resolved against `base` among
 *  `documents`), else its web address (`webDatasheets`), as `{ value, text }`
 *  with the `doc` or the `url`; null for none. The search reads both, the
 *  cell shows `text`. */
function datasheetOf(ref, { datasheets, webDatasheets, base, documents }) {
  const value = datasheets.get(ref);
  const doc = datasheetDocument(value, base, documents);
  if (doc) return { value, text: doc.name, doc };
  const url = webDatasheets.get(ref);
  return url ? { value: url, text: HOST.exec(url)[1], url } : null;
}

/** How an entry of a filter reads: its value, an empty one `(empty)`. */
const entryLabel = (key) => (key === '' ? '(empty)' : String(key));

// The block, the width of the wider of the controls and the table, centred,
// with the BOM page's top padding (`BOM_PAGE` in KicadView.jsx).
const BLOCK = 'position:relative;margin:0 auto;padding-top:24px;width:fit-content;max-width:100%';
const CONTROLS = 'display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px 12px;margin-bottom:16px';
const FIELD = `box-sizing:border-box;height:30px;padding:0 10px;border-radius:6px;appearance:none;`
  + `font:400 12.5px ${SANS};color:var(--text);${SUNKEN}`;
const SEARCH = `width:220px;max-width:100%;${FIELD}`;
const GROUP = `display:flex;align-items:center;gap:6px;font:500 12px ${SANS};color:var(--text-soft);cursor:pointer;user-select:none`;
const COUNT = `margin-left:auto;padding-left:10px;font:400 11px ${MONO};color:var(--text-faint)`;
// The table as a markdown document's is drawn (docmd.js), in a box that
// scrolls it sideways, centred in the block where the controls are wider.
const SCROLL = 'overflow-x:auto';
const TABLE = `margin:0 auto;border-collapse:collapse;font:400 12.5px ${SANS};color:var(--text)`;
const HEAD = `border:1px solid var(--line);padding:4px 6px 4px 10px;text-align:left;font:600 12px ${SANS};`
  + 'background:var(--sunken-bg);white-space:nowrap';
const HEAD_NAME = 'cursor:pointer;user-select:none';
const ARROW = 'margin-left:4px;color:var(--text-muted)';
const funnel = (on) => 'display:inline-flex;vertical-align:middle;margin-left:6px;padding:3px;border-radius:4px;cursor:pointer;'
  + (on ? 'color:var(--accent)' : 'color:var(--text-soft)');
const FUNNEL_ICON = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
    <path d="M2 2.5h12l-4.5 5.5v5l-3 1.5V8L2 2.5z" />
  </svg>
);
const CELL = 'border:1px solid var(--line);padding:4px 10px;vertical-align:top';
const TOTAL = `${CELL};font-weight:600`;
const LINK = 'color:var(--accent-text);cursor:pointer';
// A column's filter, a card in the page's colours.
const POPUP = 'position:absolute;top:0;left:0;z-index:1;width:250px;max-width:100%;box-sizing:border-box;'
  + 'display:flex;flex-direction:column;gap:8px;padding:10px;background:var(--card-bg);border:1px solid var(--line);'
  + `border-radius:8px;box-shadow:0 8px 24px var(--shadow);font:400 12px ${SANS};color:var(--text)`;
const POPUP_SEARCH = `width:100%;${FIELD}`;
const POPUP_BAR = 'display:flex;align-items:center;gap:6px';
const bulk = (off) => `font:500 12px ${SANS};color:var(--accent-text);cursor:pointer;user-select:none` + (off ? `;${OFF}` : '');
const DOT = 'color:var(--text-faint)';
const ORDER_SWITCH = `margin-left:auto;${SEGMENTED}`;
const orderTab = (on) => `padding:2px 8px;border-radius:4px;font:500 11px ${SANS};cursor:pointer;user-select:none;`
  + (on ? 'background:var(--card-bg);color:var(--text);box-shadow:0 1px 2px var(--shadow-soft)' : 'color:var(--text-soft)');
const ENTRIES = 'max-height:260px;overflow-y:auto;margin:0 -10px;padding:0 10px';
const ENTRY = 'display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer;user-select:none';
const ENTRY_NAME = 'min-width:0;overflow-wrap:anywhere';
const POPUP_BUTTONS = 'display:flex;gap:8px;padding-top:8px;border-top:1px solid var(--line-soft)';
const BUTTON = `padding:5px 14px;border-radius:6px;font:600 11.5px ${SANS};cursor:pointer;user-select:none`;
const CLOSE = `${BUTTON};${ON_ACCENT_EDGE}`;
const CANCEL = `${BUTTON};border:1px solid var(--line);background:var(--card-bg);color:var(--text)`;
// The assembly view's band: held at the top of the BOM's scrolling box, opaque
// over the rows passing under it, and as wide as the block without widening
// it (`width:0` and the block's full width at least). Each side is half of it,
// its picture in the board's proportions, as wide as the half or narrower
// where the band would pass its share of that box's height (`fit`); a
// narrower pair stands together in the middle, top against bottom.
const BAND_GAP = 12;
const BAND_SHARE = 0.4;
const BAND = `position:sticky;top:0;z-index:1;display:flex;gap:${BAND_GAP}px;width:0;min-width:100%;padding:8px 0 12px;`
  + 'box-sizing:border-box;background:var(--page-bg)';
const side = (bottom) => `flex:1 1 0;min-width:0;display:flex;justify-content:${bottom ? 'flex-start' : 'flex-end'}`;
const SIDE_BOX = 'display:flex;flex-direction:column;gap:4px';
const SIDE_NAME = `font:600 11px/14px ${SANS};color:var(--text-soft)`;
// A side's picture and the overlay over it, both filling the frame; placed
// absolutely, so a canvas's own size never widens the block.
const FRAME = 'position:relative';
const PICTURE = 'position:absolute;top:0;left:0;width:100%;height:100%;display:block';
const OVERLAY = `${PICTURE};cursor:pointer`;
const MARK_CELL = `${CELL};text-align:center`;
const rowLook = (look) => 'cursor:pointer'
  + (look === 'selected' ? ';background:var(--accent-bg)' : look === 'hovered' ? ';background:var(--accent-bg-soft)' : '');
/** The two sides of the board, by name, and whether each is the bottom. */
const SIDES = [['Top', false], ['Bottom', true]];
/** The two checkbox columns: the key in the store and the head. */
const MARKS = [['sourced', 'Sourced'], ['placed', 'Placed']];
/** How the overlay lights a part, by its look (`partLooks`), drawn in this
 *  order: the token of its colour, the opacity of its fill and the width of
 *  its outline in CSS pixels, none for a fill alone. */
const LOOKS = [
  ['placed', { ink: '--ok', fill: 0.6, line: 0 }],
  ['hovered', { ink: '--accent', fill: 0.2, line: 1 }],
  ['selected', { ink: '--accent', fill: 0.4, line: 2 }],
];
/** How far the board fades outside the selected row's parts (`paint`). */
const VEIL = 0.6;

/** The BOM's controls and table. */
export default class BomView extends React.Component {
  constructor(props) {
    super(props);
    // `query`: the search; `excluded`: by column, the values of its filter
    // unchecked; `grouped`: identical parts in one row; `sort`: the column
    // and its direction. `popup`: the filter open, `{ column, before, search }`
    // with what its column had unchecked when it opened and the text its
    // entries are searched for, or null; `byCount`: its entries by count.
    // `assembly`: the assembly view on; `frame`: the size of each of its
    // pictures (`fit`), or null; `selected` and `hovered`: the first
    // designator of the row selected and of the row under the pointer, or
    // null; `marks`: the designators ticked Sourced and Placed.
    this.state = {
      query: '', excluded: NO_FILTER, grouped: true, sort: BOM_SORT, popup: null, byCount: false,
      assembly: false, frame: null, selected: null, hovered: null, marks: readAssembly(props.pid, props.design),
    };
    // The assembly view's band, each side's picture and overlay by name, the
    // map from the board to each picture its last drawing gave (the board
    // element's `renderBoardPicture`), the parts' boxes it was drawn with, and
    // what watches the band's and the scrolling box's sizes and the theme
    // while the band is on screen.
    this.band = null;
    this.pictures = {};
    this.overlays = {};
    this.affines = {};
    this.boxes = [];
    this.watch = [];
    this.setBand = (node) => {
      this.watch.forEach((one) => one.disconnect());
      this.watch = [];
      this.band = node;
      if (!node) return;
      const sized = new ResizeObserver(() => this.fit());
      sized.observe(node);
      sized.observe(this.block.parentElement);
      const themed = new MutationObserver(() => this.drawPictures());
      themed.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      this.watch = [sized, themed];
    };
    this.setPicture = Object.fromEntries(SIDES.map(([name]) => [name, (node) => {
      this.pictures[name] = node;
    }]));
    this.setOverlay = Object.fromEntries(SIDES.map(([name]) => [name, (node) => {
      this.overlays[name] = node;
    }]));
    // The open filter's card and its column's funnel, which a press outside of
    // closes it.
    this.block = null;
    this.card = null;
    this.funnel = null;
    this.setBlock = (node) => {
      this.block = node;
    };
    this.setCard = (node) => {
      this.card = node;
    };
    this.setFunnel = (node) => {
      this.funnel = node;
    };
    this.onKey = (event) => {
      if (event.key !== 'Escape') return;
      // The BOM left the screen without a press (Back from the keyboard, a
      // swipe): the filter closes as kept and the Escape is the view's.
      if (getComputedStyle(this.card).visibility === 'hidden') {
        this.close();
        return;
      }
      event.preventDefault();
      this.cancel();
    };
    this.onPress = (event) => {
      if (!event.composedPath().some((node) => node === this.card || node === this.funnel)) this.close();
    };
    // The card stays where it opened, so a new layout closes it.
    this.onResize = () => this.close();
  }

  componentDidUpdate(_, was) {
    if (this.state.popup) this.place();
    if (!this.band) return;
    if (was.frame !== this.state.frame) this.drawPictures();
    else SIDES.forEach(([name]) => this.paint(name));
  }

  componentWillUnmount() {
    this.listen(false);
    this.setBand(null);
  }

  /** The parts of the BOM, one per designator (`bomParts`). */
  parts() {
    return bomParts(this.props.items, (ref) => datasheetOf(ref, this.props), (ref) => this.props.prices.get(ref));
  }

  /** How each part is lit on the pictures now (`partLooks`). */
  looks() {
    const { selected, hovered, marks } = this.state;
    return partLooks(bomTable(this.parts(), this.state), selected, hovered, marks.placed);
  }

  /** Each picture sized to the board's proportions (`pictureSize`, the size
   *  of what the board element fits into one): half the band, or less where
   *  the band would be taller than its share of the BOM's scrolling box, the
   *  block's parent. The pictures are drawn once that size is on screen
   *  (`componentDidUpdate`). */
  fit() {
    const board = this.props.board.getBoardPictureSize();
    const frame = this.pictures.Top.parentElement;
    const chrome = this.band.offsetHeight - frame.offsetHeight;
    const next = board && pictureSize(board, (this.band.clientWidth - BAND_GAP) / 2,
      BAND_SHARE * this.block.parentElement.clientHeight - chrome);
    const now = this.state.frame;
    if (next && !(now && now.width === next.width && now.height === next.height)) this.setState({ frame: next });
  }

  /** Both sides of the board drawn by its element into their pictures, with
   *  the parts' boxes as it has them now, and their parts lit over them. */
  drawPictures() {
    const { board } = this.props;
    this.boxes = board.getFootprintBoxes();
    for (const [name, bottom] of SIDES) {
      const picture = this.pictures[name];
      this.affines[name] = picture ? board.renderBoardPicture(picture, { bottom }) : null;
      this.paint(name);
    }
  }

  /** The overlay of side `name`: each of its parts that is lit (`looks`), in
   *  its box, through the map its picture was drawn with, in the theme's
   *  colours, read off the overlay itself, since a canvas takes no `var()`. */
  paint(name) {
    const overlay = this.overlays[name];
    const affine = this.affines[name];
    if (!overlay) return;
    const ratio = window.devicePixelRatio || 1;
    overlay.width = Math.round(overlay.clientWidth * ratio);
    overlay.height = Math.round(overlay.clientHeight * ratio);
    const ctx = overlay.getContext('2d');
    if (!ctx || !affine) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const style = getComputedStyle(overlay);
    const looks = this.looks();
    const bottom = name === 'Bottom';
    const [a, b, c, d, e, f] = affine;
    const trace = (box) => {
      ctx.beginPath();
      box.outline.forEach(([x, y]) => ctx.lineTo(a * x + c * y + e, b * x + d * y + f));
      ctx.closePath();
    };
    const sided = this.boxes.filter((box) => box.bottom === bottom);
    // With a row shown selected the rest of the board fades under the page's
    // background, so its parts stand out even where the pads around them are
    // the accent's blue (the bottom's copper), and a side without them is all
    // faded.
    if ([...looks.values()].includes('selected')) {
      ctx.globalAlpha = VEIL;
      ctx.fillStyle = style.getPropertyValue('--page-bg').trim();
      ctx.fillRect(0, 0, overlay.clientWidth, overlay.clientHeight);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'destination-out';
      for (const box of sided) {
        if (looks.get(box.reference) !== 'selected') continue;
        trace(box);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    for (const [look, { ink, fill, line }] of LOOKS) {
      const colour = style.getPropertyValue(ink).trim();
      for (const box of sided) {
        if (looks.get(box.reference) !== look) continue;
        trace(box);
        ctx.globalAlpha = fill;
        ctx.fillStyle = colour;
        ctx.fill();
        if (!line) continue;
        ctx.globalAlpha = 1;
        ctx.strokeStyle = colour;
        ctx.lineWidth = line;
        ctx.stroke();
      }
    }
  }

  /** A row `key` of the table in the assembly view: lit when it is selected
   *  or under the pointer, which it follows, and selected by a click. */
  rowProps(key) {
    const { selected, hovered } = this.state;
    return {
      style: css(rowLook(key === selected ? 'selected' : key === hovered ? 'hovered' : '')),
      onMouseEnter: () => this.setState({ hovered: key }),
      onMouseLeave: () => this.setState({ hovered: null }),
      onClick: (event) => this.pickRow(key, event),
    };
  }

  /** A click at a row `key`, outside its designators, its datasheet and its
   *  checkboxes: the row selected, or put out where it was. */
  pickRow(key, event) {
    if (event.target.closest('[data-ref], [data-doc], a, input')) return;
    this.setState({ selected: this.state.selected === key ? null : key });
  }

  /** A click on the picture of side `name`: the row holding the smallest box
   *  under it that a row shown holds selected and scrolled into view, or
   *  none. Smallest first, as a box is square to the axes and a turned part's
   *  covers its neighbours. */
  pickPart(name, event) {
    const affine = this.affines[name];
    if (!affine) return;
    const frame = event.currentTarget.getBoundingClientRect();
    const point = boardPoint(affine, event.clientX - frame.left, event.clientY - frame.top);
    const bottom = name === 'Bottom';
    const area = ({ outline: [[x0, y0], , [x1, y1]] }) => Math.abs((x1 - x0) * (y1 - y0));
    const hits = this.boxes.filter((box) => box.bottom === bottom && insideOutline(box.outline, point))
      .sort((one, other) => area(one) - area(other));
    const rows = bomTable(this.parts(), this.state);
    const row = hits.map((box) => rows.find((one) => one.references.includes(box.reference))).find(Boolean);
    const key = row ? row.references[0] : null;
    this.setState({ selected: key }, () => {
      const drawn = key && [...this.block.querySelectorAll('tr[data-row]')].find((one) => one.dataset.row === key);
      if (drawn) drawn.scrollIntoView({ block: 'center' });
    });
  }

  /** `refs` ticked in the column `mark` (`MARKS`), or unticked where `on` is
   *  false, and the ticks remembered. */
  mark(mark, refs, on) {
    const { marks } = this.state;
    const kept = marks[mark].filter((ref) => !refs.includes(ref));
    const next = { ...marks, [mark]: on ? [...kept, ...refs] : kept };
    writeAssembly(this.props.pid, this.props.design, next);
    this.setState({ marks: next });
  }

  /** A row's checkbox in the column `mark`: checked when all its parts
   *  `refs` are ticked, half-checked when some are. */
  markCell(mark, refs) {
    const ticked = refs.filter((ref) => this.state.marks[mark].includes(ref)).length;
    return (
      <td key={mark} style={css(MARK_CELL)}>
        <input type="checkbox" data-mark={mark} checked={ticked === refs.length} style={css(CHECK)}
               ref={(node) => {
                 if (node) node.indeterminate = ticked > 0 && ticked < refs.length;
               }}
               onChange={() => this.mark(mark, refs, ticked < refs.length)} />
      </td>
    );
  }

  /** The band of the board's two sides, each a picture and its overlay. */
  sides() {
    const { frame } = this.state;
    const size = `;width:${frame ? frame.width : 0}px;height:${frame ? frame.height : 0}px`;
    return (
      <div ref={this.setBand} data-assembly="" style={css(BAND)}>
        {SIDES.map(([name, bottom]) => (
          <div key={name} style={css(side(bottom))}>
            <div style={css(SIDE_BOX)}>
              <div style={css(SIDE_NAME)}>{name}</div>
              <div style={css(FRAME + size)}>
                <canvas ref={this.setPicture[name]} style={css(PICTURE)} />
                <canvas ref={this.setOverlay[name]} data-side={name} style={css(OVERLAY)}
                        onClick={(event) => this.pickPart(name, event)} />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  /** While a filter is open: Escape, before the design under the table
   *  (KicadView, ecad-viewer) sees it, a press anywhere and a resize. */
  listen(on) {
    const method = on ? 'addEventListener' : 'removeEventListener';
    window[method]('keydown', this.onKey, true);
    document[method]('pointerdown', this.onPress, true);
    window[method]('resize', this.onResize);
  }

  /** The filter of `column` opened, or closed where it is the one open. */
  toggle(column) {
    if (this.state.popup && this.state.popup.column === column) {
      this.close();
      return;
    }
    this.setState({ popup: { column, before: this.state.excluded[column], search: '' } });
    this.listen(true);
  }

  /** The filter closed, keeping what is checked. */
  close() {
    this.setState({ popup: null });
    this.listen(false);
  }

  /** The filter closed, its column as it was when it opened. */
  cancel() {
    const { popup, excluded } = this.state;
    this.setState({ excluded: { ...excluded, [popup.column]: popup.before } });
    this.close();
  }

  /** The values of `column` unchecked now. */
  exclude(column, keys) {
    this.setState({ excluded: { ...this.state.excluded, [column]: keys } });
  }

  /** The open filter's card under its column's head, as far left as it takes
   *  to stay inside the block. */
  place() {
    const block = this.block.getBoundingClientRect();
    const head = this.funnel.closest('th').getBoundingClientRect();
    const left = Math.max(0, Math.min(head.left - block.left, block.width - this.card.offsetWidth));
    this.card.style.left = `${left}px`;
    this.card.style.top = `${head.bottom - block.top + 2}px`;
  }

  /** The open filter: its search, `All · None` and the order, the entries
   *  the search finds, and Close and Cancel. */
  popup(filters) {
    const { popup, excluded, byCount } = this.state;
    const { column, search } = popup;
    const off = excluded[column];
    const text = search.trim().toLowerCase();
    const shown = entryOrder(filters[column], byCount).filter((entry) => entryLabel(entry.key).toLowerCase().includes(text));
    const keys = shown.map((entry) => entry.key);
    return (
      <div ref={this.setCard} data-filter={column} style={css(POPUP)}>
        <input type="search" placeholder="Search values" value={search} autoComplete="off" spellCheck="false"
               style={css(POPUP_SEARCH)}
               onChange={(event) => this.setState({ popup: { ...popup, search: event.target.value } })} />
        <div style={css(POPUP_BAR)}>
          <span data-bulk="all" style={css(bulk(keys.every((key) => !off.includes(key))))}
                onClick={() => this.exclude(column, off.filter((key) => !keys.includes(key)))}>All</span>
          <span style={css(DOT)}>·</span>
          <span data-bulk="none" style={css(bulk(keys.every((key) => off.includes(key))))}
                onClick={() => this.exclude(column, [...off, ...keys.filter((key) => !off.includes(key))])}>None</span>
          <div style={css(ORDER_SWITCH)}>
            {[['Value', false], ['Count', true]].map(([label, count]) => (
              <div key={label} data-order={label} style={css(orderTab(byCount === count))}
                   onClick={() => this.setState({ byCount: count })}>{label}</div>
            ))}
          </div>
        </div>
        <div style={css(ENTRIES)}>
          {shown.map(({ key, count }) => (
            <label key={key} data-entry={entryLabel(key)} style={css(ENTRY)}>
              <input type="checkbox" checked={!off.includes(key)} style={css(CHECK)}
                     onChange={() => this.exclude(column, off.includes(key) ? off.filter((one) => one !== key) : [...off, key])} />
              <span style={css(ENTRY_NAME)}>{entryLabel(key)}</span>
              <span style={css(COUNT)}>{count}</span>
            </label>
          ))}
        </div>
        <div style={css(POPUP_BUTTONS)}>
          <div data-button="close" style={css(CLOSE)} onClick={() => this.close()}>Close</div>
          <div data-button="cancel" style={css(CANCEL)} onClick={() => this.cancel()}>Cancel</div>
        </div>
      </div>
    );
  }

  /** The datasheet's cell: a link to the document, a web address, or nothing. */
  datasheetCell(sheet) {
    if (!sheet) return '';
    if (sheet.doc) {
      return <span data-doc={sheet.doc.id} style={css(LINK)} onClick={() => this.props.onDatasheet(sheet.doc)}>{sheet.text}</span>;
    }
    return <a href={sheet.url} target="_blank" rel="noopener noreferrer" style={css(LINK)}>{sheet.text}</a>;
  }

  render() {
    const { hasBoard, onPart } = this.props;
    const { query, excluded, grouped, sort, popup, assembly } = this.state;
    const parts = this.parts();
    const rows = bomTable(parts, this.state);
    const filters = bomFilters(parts, grouped);
    const { priced, total, unpriced } = bomTotal(parts, rows);
    return (
      <div ref={this.setBlock} style={css(BLOCK)}>
        <div style={css(CONTROLS)}>
          <input type="search" placeholder="Search" value={query} autoComplete="off" spellCheck="false"
                 style={css(SEARCH)} onChange={(event) => this.setState({ query: event.target.value })} />
          <label style={css(GROUP)}>
            <input type="checkbox" checked={grouped} style={css(CHECK)}
                   onChange={() => this.setState({ grouped: !grouped })} />
            Group identical parts
          </label>
          {hasBoard && (
            <div data-button="assembly" style={css(btn(assembly))}
                 onClick={() => this.setState({ assembly: !assembly, frame: null })}>Assembly</div>
          )}
        </div>
        {assembly && this.sides()}
        <div style={css(SCROLL)}>
          <table style={css(TABLE)}>
            <thead>
              <tr>
                {assembly && MARKS.map(([mark, name]) => <th key={mark} style={css(HEAD)}>{name}</th>)}
                {BOM_COLUMNS.map((name) => (
                  <th key={name} data-column={name} style={css(HEAD)}>
                    <span data-sort={name} style={css(HEAD_NAME)}
                          onClick={() => this.setState({ sort: nextSort(sort, name) })}>
                      {name}
                      {sort.column === name && <span style={css(ARROW)}>{sort.descending ? '▼' : '▲'}</span>}
                    </span>
                    <span data-funnel={name} title="Filter"
                          ref={popup && popup.column === name ? this.setFunnel : undefined}
                          style={css(funnel(filters[name].some((entry) => excluded[name].includes(entry.key))))}
                          onClick={() => this.toggle(name)}>{FUNNEL_ICON}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.references[0]} data-row={row.references[0]}
                    {...(assembly ? this.rowProps(row.references[0]) : {})}>
                  {assembly && MARKS.map(([mark]) => this.markCell(mark, row.references))}
                  <td style={css(CELL)}>
                    {row.references.map((ref, i) => (
                      <React.Fragment key={ref}>
                        {i > 0 && ', '}
                        {hasBoard ? <span data-ref={ref} style={css(LINK)} onClick={() => onPart(ref)}>{ref}</span> : ref}
                      </React.Fragment>
                    ))}
                  </td>
                  {[row.value, row.footprint, row.qty, row.dnp ? 'DNP' : ''].map((cell, i) => (
                    <td key={i} style={css(CELL)}>{cell}</td>
                  ))}
                  <td style={css(CELL)}>{this.datasheetCell(row.datasheet)}</td>
                  <td style={css(CELL)}>{row.price}</td>
                  <td style={css(CELL)}>{sumText(row)}</td>
                </tr>
              ))}
            </tbody>
            {priced && (
              <tfoot>
                <tr>
                  <td colSpan={BOM_COLUMNS.indexOf('Sum') + (assembly ? MARKS.length : 0)} style={css(TOTAL)}>
                    {`Total${unpriced ? ` · ${unpriced} ${unpriced === 1 ? 'part' : 'parts'} without a price` : ''}`}
                  </td>
                  <td style={css(TOTAL)}>{amountText(total)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {popup && this.popup(filters)}
      </div>
    );
  }
}
