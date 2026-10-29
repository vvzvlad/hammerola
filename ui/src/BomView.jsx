// The BOM of a KiCad design on screen: a table of the parts the schematic's
// element counts (kicadbom.js), and what the reader narrows and orders it
// with. KicadView.jsx draws it as the design's BOM member and hands it the
// rows (`items`), the parts' datasheets and what a click on a designator or a
// datasheet does; the search, the filters, the grouping and the order are this
// component's, and KicadView keeps it mounted while the BOM is off screen, so
// they are as the reader left them when it is back.
//
// OVER THE TABLE: a search field and a switch that groups identical parts into
// a row. Nothing of it is in the page's bar, which keeps its size on every
// view (AGENTS.md).
//
// EACH COLUMN'S HEAD: a click on its name sorts by it, a second the other way
// (it opens sorted by designator, as KiCad lists them); its ▾ opens the
// column's filter under it, drawn after Grist's: a field that searches the
// entries, `All · None` (the one that is the state already out of service), an
// order of the entries by value or by count, then an entry per value of the
// column with its count (`bomFilters` in kicadbom.js), all checked at first,
// which is no filter; an unchecked one hides its parts, at once. `Close`, and a
// click outside, keep what is checked; `Cancel`, and Escape, put back what was
// checked when it opened, and that Escape is taken, so the design under it
// does nothing with it. A column filtered shows it on its ▾. Values within a
// column are any of those checked, the columns and the search all at once.
//
// THE TABLE has kicad-cli's default columns and the datasheet. A designator
// selects its part across the design and opens the board where the design
// lists one (`onPart`), else it is plain text. A datasheet that names a
// document of the build (kicadsheets.js) opens it in KicadView's window over
// the BOM (`onDatasheet`), as the part's menu does; a web address opens in a
// new tab, shown by its host.
//
// THE LAYOUT: the controls and the table one block in the middle of the page,
// as wide as the wider of them and never wider than the page; the controls are
// centred and wrap on a narrow screen, and a table wider than the page scrolls
// sideways inside the block, never the page itself. A filter is drawn in the
// block, not in the table's scrolling box, which would cut it off: under its
// column's head and moved left as far as it takes to stay inside the block
// (`place`).

import React from 'react';

import {
  BOM_COLUMNS, BOM_SORT, bomFilters, bomParts, bomTable, entryOrder, NO_FILTER, nextSort,
} from './kicadbom.js';
import { datasheetDocument } from './kicadsheets.js';
import { OFF, ON_ACCENT_EDGE, SEGMENTED, SUNKEN } from './panelstyle.js';
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

// The block, the width of the wider of the controls and the table, centred.
const BLOCK = 'position:relative;margin:0 auto;width:fit-content;max-width:100%';
const CONTROLS = 'display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px 12px;margin-bottom:16px';
const FIELD = `box-sizing:border-box;height:30px;padding:0 10px;border-radius:6px;appearance:none;`
  + `font:400 12.5px ${SANS};color:var(--text);${SUNKEN}`;
const SEARCH = `width:220px;max-width:100%;${FIELD}`;
const GROUP = `display:flex;align-items:center;gap:6px;font:500 12px ${SANS};color:var(--text-soft);cursor:pointer;user-select:none`;
const CHECK = 'margin:0;flex:none;accent-color:var(--accent)';
const COUNT = `margin-left:auto;padding-left:10px;font:400 11px ${MONO};color:var(--text-faint)`;
// The table as a markdown document's is drawn (docmd.js), in a box that
// scrolls it sideways, centred in the block where the controls are wider.
const SCROLL = 'overflow-x:auto';
const TABLE = `margin:0 auto;border-collapse:collapse;font:400 12.5px ${SANS};color:var(--text)`;
const HEAD = `border:1px solid var(--line);padding:4px 6px 4px 10px;text-align:left;font:600 12px ${SANS};`
  + 'background:var(--sunken-bg);white-space:nowrap';
const HEAD_NAME = 'cursor:pointer;user-select:none';
const ARROW = 'margin-left:4px;color:var(--text-muted)';
const funnel = (on) => `margin-left:4px;padding:0 4px;border-radius:4px;font:400 11px/16px ${SANS};cursor:pointer;user-select:none;`
  + (on ? 'background:var(--accent-bg);color:var(--accent-text)' : 'color:var(--text-faint)');
const CELL = 'border:1px solid var(--line);padding:4px 10px;vertical-align:top';
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

/** The BOM's controls and table. */
export default class BomView extends React.Component {
  constructor(props) {
    super(props);
    // `query`: the search; `excluded`: by column, the values of its filter
    // unchecked; `grouped`: identical parts in one row; `sort`: the column
    // and its direction. `popup`: the filter open, `{ column, before, search }`
    // with what its column had unchecked when it opened and the text its
    // entries are searched for, or null; `byCount`: its entries by count.
    this.state = { query: '', excluded: NO_FILTER, grouped: true, sort: BOM_SORT, popup: null, byCount: false };
    // The open filter's card and its column's ▾, which a press outside of
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

  componentDidUpdate() {
    if (this.state.popup) this.place();
  }

  componentWillUnmount() {
    this.listen(false);
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
    const { items, hasBoard, onPart } = this.props;
    const { query, excluded, grouped, sort, popup } = this.state;
    const parts = bomParts(items, (ref) => datasheetOf(ref, this.props));
    const rows = bomTable(parts, this.state);
    const filters = bomFilters(parts, grouped);
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
        </div>
        <div style={css(SCROLL)}>
          <table style={css(TABLE)}>
            <thead>
              <tr>
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
                          onClick={() => this.toggle(name)}>▾</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.references[0]}>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {popup && this.popup(filters)}
      </div>
    );
  }
}
