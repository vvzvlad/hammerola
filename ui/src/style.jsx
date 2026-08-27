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
//   * a second mark is a logo that changes when you navigate.

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
 * The mark, at whatever size the page needs it.
 *
 * Inline SVG and not a file, for the reason the stylesheet is inline too: an
 * imported asset would make this build emit a second output file, and that name
 * would then have to be added to the Makefile, the Dockerfile, ci/smoke.py and
 * every page template (ui/vite.config.mjs says so at length).
 */
export const Mark = ({ size = 18, stroke = '#1c1f23', width = 1.6 }) => (
  <svg width={size} height={size} viewBox="0 0 18 18">
    <path d="M9 1.5l6.5 3.75v7.5L9 16.5l-6.5-3.75v-7.5z" fill="none" stroke={stroke} strokeWidth={width} />
    <path d="M9 1.5v7.5M9 9l6.5 3.75M9 9L2.5 12.75" fill="none" stroke={stroke} strokeWidth={width * 0.75} opacity=".55" />
  </svg>
);
