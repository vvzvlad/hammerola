// Getting hold of three-cad-viewer without putting it in this bundle.
//
// The library is our own build: its source is the fork in viewer/, and
// `make viewer` writes static/_v/three-cad-viewer.esm.js and copies three's two
// files beside it, all committed (static/_v/PROVENANCE.md). three is external
// to that build, so the bundle imports it by URL
// (`import * as THREE from '/_v/three.module.js'`, with three.core.js behind it)
// rather than as a bare `three` resolved by an import map: the map would be an
// inline script, which the hub's CSP (`default-src 'self'`, no
// `'unsafe-inline'`) drops silently. The hub serves all of it at those URLs, so
// bundling a copy would fetch the bytes twice.
//
// Hence a runtime import of a URL. Three things make it survive the build:
//   * the specifier is a `const`, not a literal: vite resolves a literal
//     `import("/_v/...")` against the project root at build time;
//   * `/* @vite-ignore */` marks the unanalysable dynamic import as deliberate;
//   * the URL is absolute with exactly one path component under `/_v/`:
//     `_serve_asset()` in src/app.py serves `/_v/<one component>` and
//     `_safe_name()` rejects a slash, so a deeper path 404s.
//
// No tool can check this dependency, so `tests/test_viewport_adapter.py` checks
// that the URL names a file in static/_v/ and that nothing imports the library
// statically.

/** Where the hub serves the vendored library. Also read by the Python tests. */
export const VIEWER_MODULE_URL = "/_v/three-cad-viewer.esm.js";

let pending = null;

/**
 * The library's module namespace, fetched once per page however many viewports
 * ask: `Viewer`, `Display`, and `THREE` (three's namespace re-exported by the
 * fork), which the scene widgets are built from (`scene3d.js`).
 *
 * The memo is dropped on failure: a rejected module promise is permanent in the
 * browser's module map, but the failure is as likely a hub restart mid-deploy as
 * a missing file, so the page retries when the reader switches views.
 */
export function loadViewerLibrary() {
  if (!pending) {
    pending = import(/* @vite-ignore */ VIEWER_MODULE_URL).catch((error) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}
