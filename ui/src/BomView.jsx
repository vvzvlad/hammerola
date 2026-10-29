// The BOM of a KiCad design on screen: a table of the parts the schematic's
// element counts (kicadbom.js), and over it what the reader narrows and orders
// it with. KicadView.jsx draws it as the design's BOM member and hands it the
// rows (`items`), the parts' datasheets and what a click on a designator or a
// datasheet does; the search, the filters, the grouping and the order are this
// component's, and KicadView keeps it mounted while the BOM is off screen, so
// they are as the reader left them when it is back.
//
// THE CONTROLS: a search field, a switch for the parts not fitted (DNP: all,
// without, only) and one that groups identical parts into a row, then a chip
// per type of part with its count over the whole BOM, and a chip per package.
// Chips of one filter widen it, filters narrow each other (`filterParts` in
// kicadbom.js). Nothing of it is in the page's bar, which keeps its size on
// every view (AGENTS.md).
//
// THE TABLE has kicad-cli's default columns and the datasheet. A click on a
// column's head sorts by it, a second the other way; it opens sorted by
// designator, as KiCad lists them. A designator selects its part across the
// design and opens the board where the design lists one (`onPart`), else it
// is plain text. A datasheet that names a document of the build
// (kicadsheets.js) opens it in KicadView's window over the BOM
// (`onDatasheet`), as the part's menu does; a web address opens in a new tab,
// shown by its host.
//
// THE LAYOUT: the controls and the table one block in the middle of the page,
// as wide as the wider of them and never wider than the page; each line of
// controls is centred and wraps on a narrow screen, and a table wider than the
// page scrolls sideways inside the block, never the page itself.

import React from 'react';

import {
  BOM_COLUMNS, BOM_SORT, bomParts, bomTable, DNP_WAYS, nextSort, packageChips, typeChips,
} from './kicadbom.js';
import { datasheetDocument } from './kicadsheets.js';
import { PILL, SEGMENTED, SUNKEN, tab } from './panelstyle.js';
import { css, MONO, SANS } from './style.jsx';

/** The DNP switch's words. */
const DNP_LABELS = { all: 'All', without: 'Without DNP', only: 'Only DNP' };

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

/** `list` with `name` added, or taken out where it is in. */
const toggled = (list, name) => (list.includes(name) ? list.filter((one) => one !== name) : [...list, name]);

// The block, the width of the wider of the controls and the table, centred.
const BLOCK = 'margin:0 auto;width:fit-content;max-width:100%';
const CONTROLS = 'display:flex;flex-direction:column;gap:10px;margin-bottom:16px';
const LINE = 'display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px 8px';
const LABEL = `font:500 11px ${SANS};color:var(--text-muted)`;
const SEARCH = `width:220px;max-width:100%;box-sizing:border-box;height:30px;padding:0 10px;border-radius:6px;appearance:none;`
  + `font:400 12.5px ${SANS};color:var(--text);${SUNKEN}`;
const GROUP = `display:flex;align-items:center;gap:6px;font:500 12px ${SANS};color:var(--text-soft);cursor:pointer;user-select:none`;
const CHECK = 'margin:0;accent-color:var(--accent)';
const chip = (on) => `${PILL}display:flex;align-items:baseline;gap:5px;font:500 11.5px ${SANS};border:1px solid `
  + (on ? 'var(--accent-line);background:var(--accent-bg);color:var(--accent-text)' : 'var(--line);color:var(--text-soft)');
const COUNT = `font:400 10.5px ${MONO};color:var(--text-faint)`;
// The table as a markdown document's is drawn (docmd.js), in a box that
// scrolls it sideways, centred in the block where the controls are wider.
const SCROLL = 'overflow-x:auto';
const TABLE = `margin:0 auto;border-collapse:collapse;font:400 12.5px ${SANS};color:var(--text)`;
const HEAD = `border:1px solid var(--line);padding:4px 10px;text-align:left;font:600 12px ${SANS};`
  + 'background:var(--sunken-bg);cursor:pointer;user-select:none;white-space:nowrap';
const ARROW = 'margin-left:4px;color:var(--text-muted)';
const CELL = 'border:1px solid var(--line);padding:4px 10px;vertical-align:top';
const LINK = 'color:var(--accent-text);cursor:pointer';

/** The BOM's controls and table. */
export default class BomView extends React.Component {
  constructor(props) {
    super(props);
    // `query`: the search; `types` and `packages`: the chips on; `dnp`: the
    // switch's way (`DNP_WAYS`); `grouped`: identical parts in one row;
    // `sort`: the column and its direction.
    this.state = { query: '', types: [], packages: [], dnp: 'all', grouped: true, sort: BOM_SORT };
  }

  /** A line of chips, `key` the state they turn on and off. */
  chips(label, list, key) {
    const on = this.state[key];
    return (
      <div style={css(LINE)}>
        <span style={css(LABEL)}>{label}</span>
        {list.map(({ name, count }) => (
          <div key={name} data-chip={`${key}:${name}`} style={css(chip(on.includes(name)))}
               onClick={() => this.setState({ [key]: toggled(on, name) })}>
            {name}
            {key === 'types' && <span style={css(COUNT)}>{count}</span>}
          </div>
        ))}
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
    const { query, dnp, grouped, sort } = this.state;
    const parts = bomParts(items, (ref) => datasheetOf(ref, this.props));
    const rows = bomTable(parts, this.state);
    return (
      <div style={css(BLOCK)}>
        <div style={css(CONTROLS)}>
          <div style={css(LINE)}>
            <input type="search" placeholder="Search" value={query} autoComplete="off" spellCheck="false"
                   style={css(SEARCH)} onChange={(event) => this.setState({ query: event.target.value })} />
            <div style={css(SEGMENTED)}>
              {DNP_WAYS.map((way) => (
                <div key={way} data-dnp={way} style={css(tab(way === dnp))}
                     onClick={() => this.setState({ dnp: way })}>{DNP_LABELS[way]}</div>
              ))}
            </div>
            <label style={css(GROUP)}>
              <input type="checkbox" checked={grouped} style={css(CHECK)}
                     onChange={() => this.setState({ grouped: !grouped })} />
              Group identical parts
            </label>
          </div>
          {this.chips('Type', typeChips(parts), 'types')}
          {this.chips('Package', packageChips(parts), 'packages')}
        </div>
        <div style={css(SCROLL)}>
          <table style={css(TABLE)}>
            <thead>
              <tr>
                {BOM_COLUMNS.map((name) => (
                  <th key={name} data-column={name} style={css(HEAD)}
                      onClick={() => this.setState({ sort: nextSort(sort, name) })}>
                    {name}
                    {sort.column === name && <span style={css(ARROW)}>{sort.descending ? '▼' : '▲'}</span>}
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
      </div>
    );
  }
}
