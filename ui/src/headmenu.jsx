// The header's menu on a narrow window, on both pages: the model's page
// (HammerolaViewer.jsx) and the page of a build with no model (DocShell.jsx).
// At phone width the header is one row — the mark, the title, the variants and
// this menu's button at its right end — and the controls the wide header lays
// out beside the title are rows of the card under that button.
//
// `headMenu` is a plain function, like `commentsButton` in comments.jsx, so
// what it returns is read as part of the page's own tree. The rows are the
// page's: each calls what its wide button calls.

import React from 'react';

import { INK, popover } from './panelstyle.js';
import { css, SANS } from './style.jsx';

/** A row of the menu; `on` lights it, as the wide button it stands for is lit. */
export const headRow = (on) => 'display:flex;align-items:center;gap:10px;padding:10px 14px;'
  + `font:500 13px ${SANS};cursor:pointer;`
  + (on ? 'color:var(--accent-text);background:var(--accent-bg)' : INK);

/* The button, square, lit while its card is open. */
const menuBtn = (open) => 'display:flex;align-items:center;justify-content:center;width:32px;height:32px;'
  + 'box-sizing:border-box;border-radius:6px;cursor:pointer;border:1px solid '
  + (open ? 'var(--accent-line);background:var(--accent-bg);color:var(--accent-text)'
    : 'var(--line);background:var(--card-bg);color:var(--text-soft)');

/** The menu: its button, which `onToggle` opens and shuts, and under it the
 *  card holding `rows`, shown while `open`. The card does not stop a click:
 *  a row that opens something stops its own, and one that does not lets the
 *  click reach the page's handler, which shuts the menu. */
export function headMenu(open, onToggle, rows) {
  return (
    <div style={css('position:relative;flex:none')}>
      <div onClick={onToggle} title="Menu" style={css(menuBtn(open))}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 4h12M2 8h12M2 12h12" /></svg>
      </div>
      {/* A card under its own button, not the bottom sheet the other popovers
          become on a narrow window (`popover` in panelstyle.js): the sheet is
          for a card whose button a wrapped header can move, and this button
          stands at the right end of a header that is one row, so the card
          hung under it cannot cover it. */}
      <div style={css(popover({
        narrow: false, anchor: 'right:0;top:40px', width: '240px', radius: '9px',
        tail: 'padding:6px 0;', z: 40, open }))}>
        {rows}
      </div>
    </div>
  );
}
