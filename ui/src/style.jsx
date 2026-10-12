// What every page of this interface is drawn with: the CSS-string helper, the
// two font stacks, and the mark. Nothing here renders a page; both entries
// import it.
//
// Both entries (HammerolaEntry.jsx, HammerolaViewer.jsx) import this so there
// is one copy of each:
//
//   * `css()` — a second copy would only be a second cache;
//   * the FONT STACKS — system stacks, not the mock-ups' webfonts: the page is
//     served under `default-src 'self'` (src/app.py, CSP_HTML), so a foreign
//     webfont is blocked and a self-hosted one is another asset to copy by
//     name. tests/test_ui_source.py stops a webfont from being reinstated;
//   * the MARK — `ui/tests/chrome.test.js` checks that no component draws it
//     itself and that the resolver page's copy matches this component.

import React from 'react';

/* CSS string -> React style object. Only here to keep the mock-ups' markup 1:1. */
const cssCache = new Map();
export function css(str) {
  if (!str) return undefined;
  if (cssCache.has(str)) return cssCache.get(str);
  const out = {};
  str.split(';').forEach((decl) => {
    const i = decl.indexOf(':');
    if (i < 0) return;
    const prop = decl.slice(0, i).trim();
    const val = decl.slice(i + 1).trim();
    if (!prop || !val) return;
    const key = prop.startsWith('--') ? prop : prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = val;
  });
  cssCache.set(str, out);
  return out;
}

// The two families every rule in this bundle names, as custom properties. A page
// spreads them onto the element it mounts into; everything below that inherits.
export const FONTS = {
  '--hmr-sans': 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
  '--hmr-mono': 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace',
};
export const SANS = 'var(--hmr-sans)';
export const MONO = 'var(--hmr-mono)';

/**
 * FOUR ROLES OF THE PALETTE, as the references a rule writes.
 *
 * The colours live in `static/_v/tokens.css`, once per theme, and are reached as
 * `var(--name)`: these constants hold a NAME, and the value is whatever
 * `data-theme` on `<html>` resolves it to.
 *
 * That indirection is forced by `css()`: every rule is an INLINE style, which
 * beats a class rule on specificity, so no `[data-theme]` stylesheet could
 * repaint these elements. A `var()` inside an inline style resolves against the
 * ancestor, so one attribute repaints the interface with no re-render.
 * `ui/tests/chrome.test.js` holds tokens.css to the documents that link it.
 *
 * These four names exist because two components import them. A new rule says
 * `var(--card-bg)` in its own text; do not add constants.
 */
export const PAGE_BG = 'var(--page-bg)';
export const PAGE_FG = 'var(--text)';
export const HEADER_BG = 'var(--header-bg)';
export const HEADER_LINE = 'var(--line)';

/**
 * WHERE THE WIDE LAYOUT STOPS FITTING, as the query the page asks the window.
 *
 * Not a device and not a phone: it is the width below which the build page's
 * header — a wordmark, a title, a revision picker, a status chip, downloads,
 * access and the comment button — has no room left to lay itself out on one
 * line, and below which a 300px comment rail is most of the screen rather than
 * a column beside the model.
 *
 * One reader, `HammerolaViewer`: the front page's narrow answers are plain CSS
 * that is right at every width.
 *
 * Read through `matchMedia`, never written into a `@media` block:
 *
 *   * `css()` makes every rule an INLINE style, which a `@media` rule could only
 *     beat with `!important`;
 *   * half of what the narrow branch changes is STRUCTURAL (which toolbar
 *     buttons exist, whether the tree is drawn);
 *   * jsdom evaluates no media query; a boolean in React state is a value a
 *     test can set.
 */
export const NARROW = '(max-width: 720px)';

/**
 * The mark, at whatever size the page needs it.
 *
 * Inline SVG and not a file, for the reason the stylesheet is inline too: an
 * imported asset would make this build emit a second output file, and that name
 * would then have to be added to the Makefile, the Dockerfile, ci/smoke.py and
 * every page template (ui/vite.config.mjs says so at length).
 *
 * The drawing is the designer's: `brand/mark-on-light.svg` is the source, and
 * this component and the copy in `templates/pointer.html` are transcribed from
 * it. `ui/tests/chrome.test.js` compares all three element for element
 * (resolving a `var(--…)` through the LIGHT token first). Redraw the file first,
 * then these.
 *
 * Coordinates are the designer's 48-unit box; `size` is the only thing that
 * varies — do not rescale the numbers by hand.
 *
 * Two colours because the holes are punched: `ink` is the ribbon, `hole` is the
 * page showing through. The defaults are tokens, so the mark follows
 * `data-theme` (the dark pair is `brand/mark-on-dark.svg`); the props let a call
 * site ink it against something other than the page.
 *
 * The stroke width is not a prop: 6.5 is the width of the ribbon where it
 * turns, so changing it draws a different mark.
 */
export const Mark = ({ size = 18, ink = 'var(--mark-ink)', hole = 'var(--mark-hole)' }) => (
  <svg width={size} height={size} viewBox="0 0 48 48">
    <rect x="11" y="5" width="9" height="38" fill={ink} />
    <path d="M20 23.5h8a8.5 8.5 0 018.5 8.5v11" fill="none" stroke={ink} strokeWidth="6.5" />
    <circle cx="15.5" cy="12" r="1.9" fill={hole} />
    <circle cx="15.5" cy="20" r="1.9" fill={hole} />
    <circle cx="15.5" cy="28" r="1.9" fill={hole} />
    <circle cx="15.5" cy="36" r="1.9" fill={hole} />
  </svg>
);
