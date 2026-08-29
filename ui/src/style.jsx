// What every page of this interface is drawn with: the CSS-string helper, the
// two font stacks, and the mark. Nothing here renders a page; both entries
// import it.
//
// A module of its own since the bundle grew a SECOND entry — the front page
// (HammerolaEntry.jsx) beside the build page (HammerolaViewer.jsx). All three of
// these lived in the viewer while it was the only one, and a second copy in the
// second file is what this prevents. The three differ in how badly they take
// one, which is the reason they moved together:
//
//   * a second `css()` is merely a second cache. Wasteful, nothing more.
//   * a second FONT STACK is two typefaces on one site, drifting apart with
//     nothing anywhere reporting it. It is also the likeliest of the three to
//     happen, because the stacks below are a SUBSTITUTION rather than a
//     transcription: both mock-ups ask for a webfont, and this page is served
//     under `default-src 'self'` (src/app.py, CSP_HTML), so one from another
//     origin is blocked outright and a self-hosted one is a binary in
//     static/_v/ plus a line in every file that copies assets by name. A face is
//     worth that when the typography carries meaning; here it does not. Porting
//     a third mock-up by hand is exactly when somebody would reinstate the
//     original — tests/test_ui_source.py is what stops that, and this is what
//     keeps the answer in one place.
//   * a second mark is a logo that changes when you navigate. That one had
//     happened: the build page's header wrote the same SVG out again, byte for
//     byte, and the two pages holding the two copies link to each other. The
//     copy is gone and `ui/tests/chrome.test.js` now checks both halves — that
//     no component draws the mark itself, and that the resolver page's
//     unavoidable copy still matches this component element for element.

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
 * FOUR OF THE SIX colours that exist outside this bundle as well as inside it.
 *
 * Everything else in the interface is a hex written where it is used, and that
 * is fine: one file draws it and one file changes it. These four are different
 * because three documents this bundle does not draw have to state them too —
 * `templates/build.html` and `templates/index.html` paint the page before there
 * is a page, and `static/_v/site.css` reproduces this header on the resolver at
 * /project/<pid>/ so that opening a project does not flash another design.
 *
 * Named here so that there is ONE source rather than a component's literal and
 * a template's copy of it — the shape that lets a colour change in one place and
 * quietly stop matching in three. `ui/tests/chrome.test.js` reads those three
 * documents and compares them against these values, which it can only do
 * because they are values it can import and not text it has to parse.
 *
 * THE OTHER TWO ARE NOT HERE AND ARE NOT CHECKED, and naming them is the whole
 * point of this paragraph: an unmentioned copy reads exactly like an absent one,
 * and both of these are one `grep` away.
 *
 *   * `#787f87` — the mono meta line beside the title. Not a different kind of
 *     thing from the four above: the same detail of the same header, copied
 *     into `site.css` the same way;
 *   * `#1f6fd0` — the site's accent blue, and the resolver's link takes exactly
 *     it. Five more copies live in `HammerolaEntry.jsx` and
 *     `HammerolaViewer.jsx`, so moving the accent in the bundle leaves the
 *     resolver on the old one without a word.
 *
 * Both are deliberate copies rather than oversights, and both can drift in
 * silence. Promoting one is two lines — export it here, add it to the list
 * chrome.test.js holds `site.css` to — and until somebody does, this is a known
 * gap and not a covered one.
 */
export const PAGE_BG = '#eceef1';
export const PAGE_FG = '#1c1f23';
export const HEADER_BG = '#f7f8fa';
export const HEADER_LINE = '#d8dce1';

/**
 * The mark, at whatever size the page needs it.
 *
 * Inline SVG and not a file, for the reason the stylesheet is inline too: an
 * imported asset would make this build emit a second output file, and that name
 * would then have to be added to the Makefile, the Dockerfile, ci/smoke.py and
 * every page template (ui/vite.config.mjs says so at length).
 *
 * THE DRAWING IS NOT OURS AND IS NOT AUTHORED HERE. It is the designer's, and
 * it is kept as a file — `brand/mark-on-light.svg` — with this component and
 * the copy in `templates/pointer.html` both transcribed from it.
 * `ui/tests/chrome.test.js` compares all three, element for element and
 * attribute for attribute, so the file is the source and these are provably
 * derived rather than merely similar. Redraw the file first, then these.
 *
 * THE COORDINATE SYSTEM IS THE DESIGNER'S 48-unit box, not the 18 the previous
 * mark used and not the pixel size anything renders at. Rescaling the numbers
 * by hand is exactly the transcription error the check above exists to catch,
 * and it would have to be made twice; `size` is the only thing that varies.
 *
 * TWO COLOURS, BECAUSE THE HOLES ARE PUNCHED rather than transparent: `ink` is
 * the ribbon, `hole` is the page showing through it. They move together — an
 * ink change with the old hole colour is an unreadable mark — which is why
 * there is a second file, `brand/mark-on-dark.svg`, holding the other pair
 * ready for the day the theme covers the interface (issue #35). Nothing
 * passes these props today; they exist so that day is a call site and not a
 * redraw.
 *
 * THE STROKE WIDTH IS NOT A PROP ANY MORE. It used to be, and a caller thinned
 * it at large sizes, which is a sensible thing to do to an outlined hexagon and
 * a meaningless one here: 6.5 is the WIDTH OF THE RIBBON where it turns, so
 * changing it does not adjust the mark's weight, it draws a different mark.
 */
export const Mark = ({ size = 18, ink = '#1c1f23', hole = '#fff' }) => (
  <svg width={size} height={size} viewBox="0 0 48 48">
    <rect x="11" y="5" width="9" height="38" fill={ink} />
    <path d="M20 23.5h8a8.5 8.5 0 018.5 8.5v11" fill="none" stroke={ink} strokeWidth="6.5" />
    <circle cx="15.5" cy="12" r="1.9" fill={hole} />
    <circle cx="15.5" cy="20" r="1.9" fill={hole} />
    <circle cx="15.5" cy="28" r="1.9" fill={hole} />
    <circle cx="15.5" cy="36" r="1.9" fill={hole} />
  </svg>
);
