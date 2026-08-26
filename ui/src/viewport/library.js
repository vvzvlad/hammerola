// Getting hold of three-cad-viewer WITHOUT putting it in this bundle.
//
// The library is vendored, not installed: it lives at
// static/_v/three-cad-viewer.esm.js, it is 3.5 MB, it is committed, and
// static/_v/PROVENANCE.md says where that copy came from. The hub already serves
// it at that URL, and templates/build.html links its stylesheet from the same
// place — so bundling a second copy into hammerola.js would triple the size of
// this file to fetch bytes the browser already has.
//
// Hence a RUNTIME import of a URL rather than a build-time one of a module.
// Three things have to line up for that to survive the build, and all three are
// on this line:
//
//   * the specifier is a `const`, not a literal in the `import()`. A literal
//     `import("/_v/...")` is a URL vite resolves against the project root at
//     BUILD time, finds nothing there, and either fails or inlines whatever it
//     did find;
//   * `/* @vite-ignore */` says so out loud, which is what turns a warning about
//     an unanalysable dynamic import into a deliberate one, and what keeps a
//     future vite from getting clever about the constant;
//   * the URL is absolute from the site root and has exactly ONE path component
//     under `/_v/`. That is not style: `_serve_asset()` in src/app.py serves
//     `/_v/<one component>` and `_safe_name()` rejects anything with a slash in
//     it, so a deeper path 404s.
//
// What this costs: the bundle no longer declares its dependency in a way any
// tool can check, so `tests/test_viewport_adapter.py` checks it instead — that
// the URL names a file which is really in static/_v/, and that nothing here
// imports the library statically after all.

/** Where the hub serves the vendored library. Also read by the Python tests. */
export const VIEWER_MODULE_URL = "/_v/three-cad-viewer.esm.js";

let pending = null;

/**
 * `{ Viewer, Display }`, fetched once per page however many viewports ask.
 *
 * The memo is dropped on failure rather than kept. A rejected module promise is
 * permanent inside the browser's own module map — a second `import()` of the
 * same URL returns the same rejection without retrying — but the failure that
 * gets here is as likely to be the hub restarting mid-deploy as it is to be a
 * missing file, and a page that gives up for good on a three-second outage is
 * worse than one that tries again when the reader switches views.
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
