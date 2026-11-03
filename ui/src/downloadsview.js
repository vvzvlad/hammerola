/**
 * The files a build ships, out of the part catalogue: key -> {extension -> file},
 * of the build's documents, of which the board's Gerbers count, and of
 * the views, of which the `print` view's beds count (`plates`).
 *
 * `downloadsView` answers `anyDownloads`, which the model page's row menu's
 * file rows need to tell "this build ships nothing" from "this part is not a
 * printable" (rowmenu.js).
 *
 * `fileHref` is exported because the row menu and the bed rows build their
 * links with it; one spelling of the address keeps files from downloading
 * under the wrong name.
 *
 * The catalogue, the documents and the views are the whole input (no `s`):
 * what the build ships, not anything the reader did. A reader without a key
 * (`filesKeyFor`) is refused every part's file; the Gerbers' zip opens without
 * one (a document, `app.OPEN_SUFFIXES`),
 * and is downloaded, as every open document with a file of its own, from the
 * strip at the bottom (`DocFile`, viewlist.jsx).
 */
// A document the page cannot draw, a text file and the board's Gerbers count
// as files the build ships.
import { namedByExt } from './DocumentView.jsx';
import { GERBERS_TYPE } from './gerber.js';
import { PAGE } from './hub.js';

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

/**
 * The beds of view `viewId` as meta.json declares them, `{"1": "print.3mf",
 * ...}`, or `{}` for a view with none: the 3MF a bed's row in the tree and its
 * menu in the scene offer.
 */
export function plateFiles(meta, viewId) {
  const views = meta && Array.isArray(meta.views) ? meta.views : [];
  const view = views.find((entry) => entry && entry.id === viewId);
  return view && view.plates && typeof view.plates === 'object' ? view.plates : {};
}

/**
 * The files of one catalogue record, as `[{ext, file}]`.
 *
 * `files` is the whole answer; nothing is derived from a filename. The hub
 * publishes `{extension: filename}` per part (`_catalogue` in src/render.py);
 * cutting a filename at its last dot breaks on parts with a dot in the name.
 *
 * Only `files`: `preview`, the part's own render, sits in the same record and
 * is declared for `hammerola artifacts` to fetch, not offered as a download.
 *
 * The pair is checked rather than trusted: a filename that is not a non-empty
 * string makes a row that downloads nothing, which is worse than not being
 * offered at all.
 */
export function fileList(record) {
  const files = record && typeof record.files === 'object' && record.files
    ? record.files : null;
  if (!files) return [];
  return Object.entries(files)
    .filter(([ext, file]) => ext && typeof file === 'string' && file)
    .map(([ext, file]) => ({ ext, file }));
}

/**
 * `{anyDownloads}`: whether the build ships any file at all — a part's export
 * (`fileList`), a zip of Gerbers (`GERBERS_TYPE`), a plain or a text file out
 * of `meta.documents` (`namedByExt`), or a bed of the `print` view, a 3MF each
 * (`plates`). A view's `overview` and `preview` (`assembled.stl`, `print.stl`
 * and their pictures) are declared for a client to fetch and do not count.
 */
export function downloadsView(catalogue, deps) {
  const { documents, views } = deps;
  const records = Object.values((catalogue && typeof catalogue === 'object') ? catalogue : {});
  const listed = (Array.isArray(documents) ? documents : [])
    .filter((doc) => doc && typeof doc.file === 'string' && doc.file);
  const beds = (Array.isArray(views) ? views : [])
    .filter((view) => view && view.plates && typeof view.plates === 'object')
    .flatMap((view) => Object.entries(view.plates))
    .filter(([number, file]) => /^[1-9][0-9]*$/.test(number) && typeof file === 'string' && file);
  return {
    anyDownloads: records.some((record) => fileList(record).length > 0)
      || listed.some((doc) => doc.type === GERBERS_TYPE || namedByExt(doc))
      || beds.length > 0,
  };
}
