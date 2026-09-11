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
 * FOUR ROLES OF THE PALETTE, as the references a rule writes.
 *
 * THE COLOURS THEMSELVES ARE NOT HERE ANY MORE AND ARE NOT JAVASCRIPT AT ALL.
 * They live in `static/_v/tokens.css`, once per theme, and every one of them is
 * reached as `var(--name)` — so what these constants hold is a NAME rather than
 * a value, and the value is whatever `data-theme` on `<html>` says it is when
 * the browser resolves the rule.
 *
 * That indirection is forced by `css()` above rather than chosen: it turns every
 * rule in this bundle into an INLINE style object, and an inline style beats a
 * class rule on specificity, so no `[data-theme]` stylesheet could ever repaint
 * these elements. A `var()` inside an inline style is the other way round — it
 * resolves against the ancestor, which is how one attribute repaints the whole
 * interface with no re-render and no new field in any component's state.
 *
 * WHAT THIS PARAGRAPH USED TO SAY, and why it is worth writing down that it no
 * longer does: these four were the only colours held to the three documents this
 * bundle does not draw (`templates/build.html`, `templates/index.html`,
 * `static/_v/site.css`), each of which had to state the page's colours itself.
 * Two more were copied into `site.css` and checked by NOTHING — `#787f87` on the
 * meta line, and `#1f6fd0`, which was the resolver's idea of the accent while
 * the bundle used `#1f7ae0`: a drift that had already happened and that nobody
 * could see, because seeing it meant opening two files. Every one of those
 * copies is now a reference to one definition, so there is no longer a set of
 * "checked" colours and a set of uncounted ones — there is one file, and
 * `ui/tests/chrome.test.js` holds it to the documents that link it.
 *
 * THESE FOUR NAMES REMAIN BECAUSE TWO COMPONENTS IMPORT THEM. A rule written
 * from here on says `var(--card-bg)` in its own text; there is no constant to
 * add, and adding one would be a second vocabulary for the same palette.
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
 * ONE READER TODAY, `HammerolaViewer`, and that is not an oversight: the front
 * page's own narrow answers — a header that wraps, a card grid whose floor can
 * fall below 320px — are plain CSS that is right at every width, and a page
 * that asked this question without branching on it would be carrying a listener
 * for nothing.
 *
 * IT IS READ THROUGH `matchMedia` AND NEVER WRITTEN INTO A `@media` BLOCK, and
 * that is a decision rather than a shortcut. Three reasons, each of them fatal
 * on its own:
 *
 *   * `css()` above turns every rule in this bundle into an INLINE style
 *     object, and an inline style beats a class rule on specificity — so every
 *     declaration in a `@media` block would need `!important` to reach these
 *     elements at all;
 *   * half of what the narrow branch changes is STRUCTURAL: which toolbar
 *     buttons exist, whether the tree is drawn. No stylesheet can do that;
 *   * jsdom evaluates no media query, so a `@media` layout would be the one
 *     part of this heavily-tested interface that no test in ui/tests could
 *     reach. A boolean in React state is a value a test can simply set.
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
 * ink change with the old hole colour is an unreadable mark — and since issue
 * #35 they move together BY THEMSELVES: the defaults are the two tokens, so the
 * mark follows `data-theme` on every page that draws it, and the dark pair the
 * designer sent as `brand/mark-on-dark.svg` is what those tokens resolve to.
 * The file had been sitting unrendered since 2026-08-28 for want of exactly
 * this. The props remain because a call site may still want to ink the mark
 * against something that is not the page — a swatch, a dark banner — and that
 * has to be a call site rather than a redraw.
 *
 * `ui/tests/chrome.test.js` still compares this drawing against the designer's
 * file attribute for attribute; it resolves a `var(--…)` through the LIGHT
 * token before comparing, so the triangle is component -> token -> file rather
 * than one link shorter.
 *
 * THE STROKE WIDTH IS NOT A PROP ANY MORE. It used to be, and a caller thinned
 * it at large sizes, which is a sensible thing to do to an outlined hexagon and
 * a meaningless one here: 6.5 is the WIDTH OF THE RIBBON where it turns, so
 * changing it does not adjust the mark's weight, it draws a different mark.
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
