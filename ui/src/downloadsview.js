/**
 * The downloads menu, built out of the part catalogue: key -> {extension -> file},
 * and of the build's documents, of which the board's Gerbers are offered.
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
 * The catalogue and the documents are the whole input (no `s`): the menu shows
 * what the build ships, not anything the reader did. `groupDownloads` stays beside the
 * component, where the tests reach for it. `key` is `filesKeyFor`'s answer for
 * the build on screen; without one the hub refuses every part's file, so the
 * menu is not drawn at all (`dlShown`). The Gerbers' zip opens without a key
 * (a document, `app.OPEN_SUFFIXES`), and a reader who has none downloads it,
 * as every open document with a file of its own, from the strip at the bottom
 * (`DocFile`, viewlist.jsx).
 */
import { BAMBU_FORMAT } from './bambu.jsx';
import { PAGE } from './hub.js';
import { MONO, SANS } from './style.jsx';

/**
 * One file of the build on screen, with the key that opens it.
 *
 * The key travels in the query because the link is a plain `<a download>`,
 * which cannot carry the token in a header (src/app.py, `files_key`). A
 * document keeps its directory in the build (`fab/board.zip`), and each
 * segment is encoded apart, so the browser saves it under its own name.
 */
export const fileHref = (file, key) => PAGE.base + String(file).split('/').map(encodeURIComponent).join('/')
  + (key ? `?files=${encodeURIComponent(key)}` : '');

/**
 * The key to the files of the build at `slot`, or '' when this page has none.
 *
 * The owner's first: `files_keys` rides on builds.json, which only the token
 * reads, and covers every address the picker can move this page to. Then the
 * key the ADDRESS carried when the page loaded, and only for the slot it was
 * carried for — a reader without the token never moves the address, but a
 * key is good for one address alone and must not be offered on another.
 *
 * Own properties only: a slot may be any build id, and `constructor` read off
 * a plain object is a function.
 */
export function filesKeyFor(builds, slot, fromAddress) {
  const keys = builds && builds.files_keys;
  const owned = keys && Object.prototype.hasOwnProperty.call(keys, slot) ? keys[slot] : '';
  if (typeof owned === 'string' && owned) return owned;
  return fromAddress && fromAddress.slot === slot && fromAddress.key ? fromAddress.key : '';
}

export function downloadsView(catalogue, deps) {
  const { groupDownloads, downloadAll, key, documents } = deps;

  // A row is controls side by side: the link, filling it, then, for a 3MF,
  // Open in Bambu Studio (bambu.jsx), and its Copy link at the end
  // (copylink.jsx), neither of which may sit inside the `<a>`.
  const dlRowStyle = 'display:flex;align-items:center';
  const dlLinkStyle = `display:flex;flex:1;min-width:0;align-items:center;gap:10px;padding:6px 4px 6px 22px;text-decoration:none;color:var(--text);font:400 12px ${SANS}`;
  const downloadGroups = groupDownloads(catalogue, documents).map((g) => ({
    key: g.ext,
    ext: g.ext,
    files: g.files.map((f) => ({
      key: f.file, label: f.label, file: f.file, href: fileHref(f.file, key),
      bambu: g.ext === BAMBU_FORMAT, bambuStyle: 'padding:6px 4px',
      rowStyle: dlRowStyle, style: dlLinkStyle, copyStyle: 'padding:6px 14px 6px 4px',
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
    onAll: () => downloadAll(g.files.map((f) => fileHref(f.file, key))),
  }));
  const anyDownloads = downloadGroups.length > 0;

  return { downloadGroups, anyDownloads, dlShown: !!key };
}
