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
//
// Every listed document is one row, a KiCad schematic, board and 3D model as
// much as a PDF, except one listed `hidden`: it has no row and is still opened
// by its address (`?d=`) or by a link from another document.
//
// `viewList` and `toolBar` are the drawing and take everything as arguments,
// so a test reads the tree they return without mounting anything
// (ui/tests/viewmenu.test.js, viewdocs.test.js, docshell.test.js).

import React from 'react';

import { docHint } from './DocumentView.jsx';
import { shortId } from './hub.js';
import {
  ELLIPSIS, FAINT_MONO, FILL, INK, OFF, QUIET_BTN, RELATIVE, RULE, TAB_OFF, TAB_ON,
} from './panelstyle.js';
import { css, SANS } from './style.jsx';

/** One row of the list, a view's or a document's: the same shape for both, so
 *  the two halves read as one list. */
export const menuRow = (on) => `display:flex;align-items:center;gap:10px;padding:7px 14px;font:400 12px ${SANS};cursor:pointer;`
  + (on ? 'color:var(--accent-text);background:var(--accent-bg)' : INK);

/**
 * The build's documents as rows, one per document not listed `hidden`: the
 * name (its `title`, else its path in the tree) and its hint (`docHint`).
 * `open` is the id of the document on screen, or null; `choose(id)` is what a
 * row does.
 */
export function documentRows(documents, open, choose) {
  return documents.filter((doc) => !doc.hidden).map((doc) => ({
    key: doc.id, label: doc.name, hint: docHint(doc), rowStyle: menuRow(open === doc.id),
    onClick: () => choose(doc.id),
  }));
}

/** The button. A view's name is the model's own sentence and can be any
 *  length; the button sits in a bar that must not grow past the window, so it
 *  is capped and the name is cut rather than allowed to push. */
export const viewButtonStyle = (open) => `display:flex;align-items:center;gap:7px;padding:5px 11px;border-radius:5px;font:500 12px ${SANS};cursor:pointer;max-width:220px;`
  + (open ? TAB_ON : TAB_OFF);

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
 * starts at the button's left edge, which fits a 320px window.
 *
 * No `z-index`: the bar is its own stacking context, so a value here only sorts
 * this menu against its siblings; the page raises the bar's layer instead
 * (`toolbarStyle` in chromeview.js).
 *
 * Height capped like the revision menu's list: a model may declare twenty
 * views, and under the root's `overflow:hidden` a taller menu is cut off. A
 * column: the views scroll inside it (`VIEW_LIST`), and the documents stay
 * under them, outside that scroll (`DOC_LIST`).
 */
export const viewMenuStyle = (open) => 'position:absolute;left:0;'
  + 'bottom:38px;width:260px;max-height:308px;flex-direction:column;'
  + 'background:var(--card-bg);border:1px solid var(--line);border-radius:9px;box-shadow:0 10px 34px var(--shadow);padding:6px 0;display:'
  + (open ? 'flex' : 'none');

export const VIEW_LIST = 'flex:1 1 auto;min-height:0;overflow:auto';
// The documents sit UNDER the scroll of the views, so a model with twelve views
// does not push them out of sight. Four rows and the top of a fifth: a longer
// list shows that it goes on, and scrolls on its own.
export const DOC_LIST = 'flex:none;max-height:132px;overflow:auto';
// A document's name and its hint share a row of a narrow menu: the hint
// (`pdf · 4.7 MB`) stays on one line and the name wraps.
export const DOC_LABEL = 'flex:1;min-width:0;overflow-wrap:anywhere';
export const DOC_HINT = `flex:none;white-space:nowrap;${FAINT_MONO}`;

// The bar the button sits in, floating at the bottom of the page.
// `contain:layout` and NOT a `backdrop-filter`: both make the bar the
// containing block and stacking context its menus are built around, but a
// backdrop filter over the WebGL canvas cost a third of the frame rate while
// orbiting on a retina Mac (measured).
export const FLOAT_BAR = 'pointer-events:auto;display:flex;align-items:center;gap:8px;padding:4px;background:var(--float-bg);contain:layout;border:1px solid var(--line);border-radius:9px;box-shadow:0 4px 16px var(--shadow-soft)';
// Its layer, centred on the bottom edge, the z-index appended by the page.
export const BAR_LAYER = 'position:absolute;left:0;right:0;bottom:12px;display:flex;justify-content:center;pointer-events:none;z-index:';
// A document, over the whole of the page's area down to its bottom edge, under
// the bar. The bottom padding is the bar's strip: the last lines of a page and
// the end of a PDF's frame stop above the button rather than under it.
export const DOC_LAYER = 'position:absolute;top:0;left:0;right:0;bottom:0;overflow:auto;padding-bottom:72px;box-sizing:border-box;background:var(--page-bg);z-index:16';

const CHEVRON = <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 6l4 4 4-4" /></svg>;

/**
 * The button and its card, as elements. `views` and `documents` are rows
 * (`{ key, label, hint, rowStyle, onClick }`), the documents under the views.
 * `onToggle` must stop the click: the pages shut their menus on a click that
 * reaches the root. Pure.
 *
 * The wrapper is `position:relative` so that the card is anchored to the
 * BUTTON: the bar carries `contain:layout` and is therefore already a
 * containing block for it, so without the wrapper the card would be measured
 * from the bar's whole box and start at its left end rather than at the button.
 */
export function viewList({ label, open, onToggle, views = [], documents = [] }) {
  return (
    <div style={css(RELATIVE)}>
      <div onClick={onToggle} title={label} style={css(viewButtonStyle(open))}>
        <span style={css(ELLIPSIS)}>{label}</span>
        {CHEVRON}
      </div>
      <div onClick={(e) => e.stopPropagation()} style={css(viewMenuStyle(open))}>
        {views.length > 0 && (
          <div style={css(VIEW_LIST)}>
            {views.map((t) => (
              <div key={t.key} onClick={t.onClick} style={css(t.rowStyle)}>
                <span style={css(FILL)}>{t.label}</span>
                <span style={css(FAINT_MONO)}>{t.hint}</span>
              </div>
            ))}
          </div>
        )}
        {documents.length > 0 && (
          <div style={css(DOC_LIST)}>
            {documents.map((t) => (
              <div key={t.key} onClick={t.onClick} style={css(t.rowStyle)}>
                <span style={css(DOC_LABEL)}>{t.label}</span>
                <span style={css(DOC_HINT)}>{t.hint}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Fit's and Frame's look: quiet, and out of service (`OFF`) where what is on
 *  screen cannot do them. */
export const quietBtn = (off) => QUIET_BTN + (off ? `;${OFF}` : '');

/** The views as a strip of tabs, while they fit (`VIEW_TABS_MAX`). */
const TAB_STRIP = 'display:flex;gap:2px;padding:2px;background:var(--chip-bg);border-radius:6px';

/**
 * The bar, as elements: the same controls in the same places on both pages
 * and over every view. `b` holds the values — the model's page computes them
 * (chromeview.js), the page of documents builds them (`docBar` in
 * DocShell.jsx):
 *   the views    `viewMenu` (a menu rather than a strip), `viewLabel`,
 *                `viewsOpen`, `viewsToggle`, `viewTabs`, `docRows`;
 *   the tools    `showTools` (false on a narrow window, which keeps the views
 *                and Fit), and each tool's style and handler: `measureBtnStyle`
 *                and `tMeasure`, `commentBtnStyle` and `tComment`,
 *                `proposalBtnStyle` and `tProposal`, `fitBtnStyle` and
 *                `fitView`, `frameBtnStyle` and `grabFrame`, `settingsBtnStyle`
 *                and `tSettings`. A tool out of service is drawn `OFF` and
 *                takes no click, so its handler may be absent.
 * `menus` are the cards `Add primitive` and Settings open (`proposal`,
 * `settings`), which only the model's page has. Pure.
 */
export function toolBar(b, menus = {}) {
  return (
    <div style={css(FLOAT_BAR)}>
      {/* A STRIP WHILE THE VIEWS FIT, A MENU WHEN THEY DO NOT — see
          `VIEW_TABS_MAX`. The menu holds the build's documents under the
          views. */}
      {b.viewMenu ? (
        viewList({ label: b.viewLabel, open: b.viewsOpen, onToggle: b.viewsToggle,
          views: b.viewTabs, documents: b.docRows })
      ) : (
        <div style={css(TAB_STRIP)}>
          {b.viewTabs.map((t) => (
            <div key={t.key} onClick={t.onClick} title={t.hint} style={css(t.style)}>{t.label}</div>
          ))}
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
            <div onClick={b.tProposal} style={css(b.proposalBtnStyle)}>
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
