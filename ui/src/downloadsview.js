/**
 * The downloads menu, built out of the part catalogue: key -> {extension -> file}.
 *
 * Returns `downloadGroups`, which `chromeView` puts back in the object because
 * the menu hangs off a header button, and `anyDownloads`, which the row
 * menu's file rows need to tell "this build ships nothing" from "this part is
 * not a printable".
 *
 * `fileHref` is exported because the row menu builds the same link for one
 * part; one spelling of the address keeps files from downloading under the
 * wrong name.
 *
 * The catalogue is the whole input (no `s`): the menu shows what the build
 * ships, not anything the reader did. `groupDownloads` stays beside the
 * component, where the tests reach for it.
 */
import { PAGE } from './hub.js';
import { MONO, SANS } from './style.jsx';

export const fileHref = (file) => PAGE.base + encodeURIComponent(String(file));

export function downloadsView(catalogue, deps) {
  const { groupDownloads, downloadAll } = deps;

  const dlRowStyle = `display:flex;align-items:center;gap:10px;padding:6px 14px 6px 22px;text-decoration:none;color:var(--text);font:400 12px ${SANS}`;
  const downloadGroups = groupDownloads(catalogue).map((g) => ({
    key: g.ext,
    ext: g.ext,
    files: g.files.map((f) => ({
      key: f.file, label: f.label, file: f.file, href: fileHref(f.file),
      style: dlRowStyle,
    })),
    headStyle: `display:flex;align-items:center;gap:8px;padding:8px 14px 3px;font:600 10px ${MONO};color:var(--text-muted);letter-spacing:.08em`,
    allStyle: `cursor:pointer;font:500 10.5px ${MONO};color:var(--accent-text);text-decoration:underline`,
    // One click, N downloads, done in the browser. The browser asks once for a
    // per-site permission to download several files and remembers it, so a
    // person sees one prompt. An agent driving the page cannot answer it, so
    // agents use `hammerola artifacts`; the hub needs no route or archive.
    //
    // No `stop()`: the click bubbles to `rootClick` and closes the menu, which
    // is exactly what a file row beside it already does by being a plain link.
    onAll: () => downloadAll(g.files.map((f) => fileHref(f.file))),
  }));
  const anyDownloads = downloadGroups.length > 0;

  return { downloadGroups, anyDownloads };
}
