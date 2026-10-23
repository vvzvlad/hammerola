// The list of views at the bottom of a page: the button that names what is on
// screen, and the card of rows it opens upwards — the views a model declares, a
// rule, and the build's documents. Both pages draw it with this, so it is one
// list and one look: the model's page (HammerolaViewer.jsx, its values from
// chromeview.js) and the page of a build with no model (DocShell.jsx), which
// has documents only.
//
// A KiCad design is TWO rows, its schematic and its board (`documentRows`):
// which one is on screen is the page's to hold, and KicadView.jsx draws the
// side it is handed. A design without a board has the schematic's row alone.
//
// `viewList` is the drawing and takes everything as arguments, so a test reads
// the tree it returns without mounting anything (ui/tests/viewmenu.test.js,
// viewdocs.test.js, docshell.test.js).

import React from 'react';

import { docHint } from './DocumentView.jsx';
import { kicadSides, PCB, SCH, SIDE_NAMES, sideOf } from './KicadView.jsx';
import { ELLIPSIS, FAINT_MONO, FILL, INK, RELATIVE, TAB_OFF, TAB_ON } from './panelstyle.js';
import { css, SANS } from './style.jsx';

/** One row of the list, a view's or a document's: the same shape for both, so
 *  the two halves read as one list. */
export const menuRow = (on) => `display:flex;align-items:center;gap:10px;padding:7px 14px;font:400 12px ${SANS};cursor:pointer;`
  + (on ? 'color:var(--accent-text);background:var(--accent-bg)' : INK);

/**
 * The build's documents as rows: the name (its `title`, else its path in the
 * tree) and its type and size. A KiCad design is a row per side it has, named
 * `<name> · Schematic` and `<name> · PCB`, hinted with its sheet count and
 * `board`. `open` is the id of the document on screen, or null, and `side` the
 * KiCad side the page holds; `choose(id, side)`
 * is what a row does, `side` null for any other document.
 */
export function documentRows(documents, open, side, choose) {
  return documents.flatMap((doc) => {
    if (doc.type !== 'kicad') {
      return [{ key: doc.id, label: doc.name, hint: docHint(doc), rowStyle: menuRow(open === doc.id),
        onClick: () => choose(doc.id, null) }];
    }
    const shown = sideOf(doc, side);
    // A side's own words, short because the name beside them is not: the
    // design's size belongs to neither side, so it is left out.
    const sheets = doc.kicad.schematics.length;
    const hints = { [SCH]: `${sheets} sheet${sheets === 1 ? '' : 's'}`, [PCB]: 'board' };
    return kicadSides(doc).map((one) => ({
      key: `${doc.id}:${one}`, label: `${doc.name} · ${SIDE_NAMES[one]}`, hint: hints[one],
      rowStyle: menuRow(open === doc.id && shown === one),
      onClick: () => choose(doc.id, one),
    }));
  });
}

/** What the button says while document `doc` is on screen: its row's words. */
export const openLabel = (doc, side) => (doc.type === 'kicad'
  ? `${doc.name} · ${SIDE_NAMES[sideOf(doc, side)]}` : doc.name);

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
 * either: the bar is centred on the bottom edge, so a button that is its only
 * control (`alone`: the page of a build with no model, a model's page with a
 * document open) has the card centred on it, and 260px fits any window of
 * 262px; where the button shares the bar with Fit the card starts at the
 * button's left edge, which fits a 320px window.
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
export const viewMenuStyle = (open, alone = false) => 'position:absolute;'
  + (alone ? 'left:50%;transform:translateX(-50%);' : 'left:0;')
  + 'bottom:38px;width:260px;max-height:308px;flex-direction:column;'
  + 'background:var(--card-bg);border:1px solid var(--line);border-radius:9px;box-shadow:0 10px 34px var(--shadow);padding:6px 0;display:'
  + (open ? 'flex' : 'none');

export const VIEW_LIST = 'flex:1 1 auto;min-height:0;overflow:auto';
// The rule and the documents sit UNDER the scroll of the views, so a model with
// twelve views does not push them out of sight. Four rows and the top of a
// fifth: a longer list shows that it goes on, and scrolls on its own.
export const DOC_RULE = 'flex:none;height:1px;margin:6px 0;background:var(--line-soft)';
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
 * (`{ key, label, hint, rowStyle, onClick }`); the rule between them is drawn
 * only where there are both. `alone` says the button is the bar's only
 * control. `onToggle` must stop the click: the pages shut their menus on a
 * click that reaches the root. Pure.
 *
 * The wrapper is `position:relative` so that the card is anchored to the
 * BUTTON: the bar carries `contain:layout` and is therefore already a
 * containing block for it, so without the wrapper the card would be measured
 * from the bar's whole box and start at its left end rather than at the button.
 */
export function viewList({ label, open, onToggle, views = [], documents = [], alone = false }) {
  return (
    <div style={css(RELATIVE)}>
      <div onClick={onToggle} title={label} style={css(viewButtonStyle(open))}>
        <span style={css(ELLIPSIS)}>{label}</span>
        {CHEVRON}
      </div>
      <div onClick={(e) => e.stopPropagation()} style={css(viewMenuStyle(open, alone))}>
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
        {views.length > 0 && documents.length > 0 && <div style={css(DOC_RULE)} />}
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
