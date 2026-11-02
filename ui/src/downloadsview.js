/**
 * The downloads menu, built out of the part catalogue: key -> {extension -> file},
 * of the build's documents, of which the board's Gerbers are offered, and of
 * the views, of which the `print` view's beds are offered (`plates`).
 *
 * Returns `downloadGroups`, which the header's menu draws (Header.jsx), and
 * `anyDownloads`, which the model page's row menu's file rows need to tell
 * "this build ships nothing" from "this part is not a printable".
 *
 * `fileHref` is exported because the row menu builds the same link for one
 * part; one spelling of the address keeps files from downloading under the
 * wrong name.
 *
 * The catalogue, the documents and the views are the whole input (no `s`): the menu shows
 * what the build ships, not anything the reader did. `groupDownloads` orders it
 * by format, and `sequentialDownload` hands a group's files to the browser for
 * the header's Download all (Header.jsx). `key` is `filesKeyFor`'s answer for
 * the build on screen; without one the hub refuses every part's file, so the
 * menu is not drawn at all (`dlShown`). The Gerbers' zip opens without a key
 * (a document, `app.OPEN_SUFFIXES`), and a reader who has none downloads it,
 * as every open document with a file of its own, from the strip at the bottom
 * (`DocFile`, viewlist.jsx).
 */
import { BAMBU_FORMAT } from './bambu.jsx';
// A document the page cannot draw, and a text file, are offered under the
// extension they are named by; the board's Gerbers under a group of their own.
import { docExt, namedByExt } from './DocumentView.jsx';
import { GERBERS_TYPE } from './gerber.js';
import { PAGE, plateLabel } from './hub.js';
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

/**
 * The beds of view `viewId` as meta.json declares them, `{"1": "print.3mf",
 * ...}`, or `{}` for a view with none: the 3MF a bed's row in the tree and its
 * menu in the scene offer, the file its row in this menu offers.
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
 * The formats that go to a printer, first, in the order a part reaches one.
 *
 * STL is what a slicer is opened with, 3MF is the same mesh with the print
 * settings on it, and STEP is the solid — the thing you take when you are going
 * to EDIT the part rather than make it. The header's menu is opened far more
 * often for the first than for the last, and an alphabetical list puts 3MF at
 * the top and STL at the bottom, which is the exact reverse. Anything the hub
 * grows later lands after these three, alphabetically, so a new format is
 * ordered rather than wherever the object happened to be iterated.
 */
const PRINT_FIRST = ['STL', '3MF', 'STEP'];

/** The heading the board's Gerbers are offered under, among the formats. */
const GERBERS_GROUP = 'GERBERS';

/**
 * `meta.parts` as ordered groups of one FORMAT each, rows ordered by part.
 *
 * Flat, this menu is one row per file — thirty of them on a ten-part build, in
 * the order the hub happened to write them, so picking out every STL means
 * aiming at every third row. Grouped, the same thirty rows are three groups a
 * reader can take whole.
 *
 * The row's name is the catalogue key, the part's name.
 *
 * Of what a view declares, only `plates` is offered: the `print` view's beds,
 * a 3MF each (`{"1": "print.3mf", "2": "print-2.3mf"}`), each part an object of
 * its own where the view laid it out, so a whole bed opens in a slicer in one
 * go. Their rows come first in the 3MF group, ahead of the parts and in bed
 * order, and like every 3MF row each gets Open in Bambu Studio. `overview` and
 * `preview` (`assembled.stl`, `print.stl` and their pictures) are declared for
 * a client to fetch, not as buttons: `assembled.stl` is on screen in 3D
 * already, and `print.stl`, the beds glued into one mesh, is there for the
 * picture the build draws of them — a bed is offered as its 3MF.
 *
 * A Map because the group key is an extension out of a pushed document, so
 * `__proto__` is reachable and an object literal would silently store nothing
 * under it.
 *
 * Two kinds of document reach this menu, both out of `meta.documents`. Every
 * zip of Gerbers (`GERBERS_TYPE`) is a row of one GERBERS group, named by its
 * title. Every plain file (`FILE_TYPE`) and every text file
 * (`TEXT_TYPE`) is a row under its own extension in capitals — DXF, CSV — so a
 * cut list for the glass shop is taken the way an STL is, and lands beside a
 * part's exports when it shares their extension. Both are ordered like any
 * other format.
 */
export function groupDownloads(parts, documents, views) {
  const groups = new Map();
  Object.entries((parts && typeof parts === 'object') ? parts : {})
    .forEach(([key, record]) => {
      fileList(record).forEach(({ ext, file }) => {
        const group = ext.toUpperCase();
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push({ label: key, file });
      });
    });
  const listed = (Array.isArray(documents) ? documents : [])
    .filter((doc) => doc && typeof doc.file === 'string' && doc.file);
  const gerbers = listed
    .filter((doc) => doc.type === GERBERS_TYPE)
    .map((doc) => ({ label: String(doc.name || doc.file), file: doc.file }));
  if (gerbers.length) groups.set(GERBERS_GROUP, [...(groups.get(GERBERS_GROUP) || []), ...gerbers]);
  listed.filter(namedByExt).forEach((doc) => {
    const group = docExt(doc).toUpperCase();
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ label: String(doc.name || doc.file), file: doc.file });
  });
  const beds = (Array.isArray(views) ? views : [])
    .filter((view) => view && view.plates && typeof view.plates === 'object')
    .flatMap((view) => Object.entries(view.plates))
    .filter(([number, file]) => /^[1-9][0-9]*$/.test(number) && typeof file === 'string' && file)
    .sort(([a], [b]) => Number(a) - Number(b));
  const plates = beds.map(([number, file]) => ({
    label: plateLabel(number, beds.length), file,
  }));
  if (plates.length && !groups.has(BAMBU_FORMAT)) groups.set(BAMBU_FORMAT, []);
  const text = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const rank = (ext) => {
    const at = PRINT_FIRST.indexOf(ext);
    return at < 0 ? PRINT_FIRST.length : at;
  };
  return Array.from(groups.keys())
    .sort((a, b) => (rank(a) - rank(b)) || text(a, b))
    .map((ext) => ({
      ext,
      files: [...(ext === BAMBU_FORMAT ? plates : []),
              ...groups.get(ext).slice().sort((a, b) => text(a.label, b.label))],
    }));
}

/**
 * The gap between two downloads handed to the browser in one gesture.
 *
 * Not a workaround for a block — see the note beside the group menu's button for
 * what a browser actually does — but for the fact that each of these is a
 * separate navigation the browser has to notice: fired in one synchronous burst,
 * anchors pointing at different files can be coalesced into one download, and
 * which ones survive depends on the engine. A fifth of a second is under the
 * threshold at which a person reads the sequence as slow and well over the
 * threshold at which the browser reads it as one event.
 */
export const DOWNLOAD_GAP_MS = 200;

/** One `<a download>`, clicked and thrown away. The default `click` below. */
function clickHref(href) {
  const a = document.createElement('a');
  a.href = href;
  // Empty rather than a name: the href is a file under the build's own
  // directory, so the browser takes the name off the URL — which is the name the
  // build published, and the page has no better one to offer.
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Hand the browser every href in turn, spaced by `delay`.
 *
 * The first one fires synchronously: a download is allowed because it is
 * inside the gesture that asked for it, and a timer would leave that gesture
 * behind. The rest follow on the clock; a browser that asks about the second
 * file asks once for the site and remembers.
 *
 * `click` and `schedule` are arguments so tests can drive it with fake timers
 * and a fake clicker — order and spacing are all it promises.
 *
 * `signal` cancels it. A chain outlives its gesture by `gap` × (N − 1), and
 * every href was captured off `PAGE.base` at the press, so a reader who
 * switches revision or leaves would keep receiving the old build's files. The
 * abort is checked at the top of every step (an already-aborted signal hands
 * over nothing) and clears the pending timer — a real `clearTimeout` by
 * default, a no-op under an injected `schedule`, where the flag does the work.
 *
 * The listener is removed when the chain ends normally because the signal
 * outlives it: one controller serves the whole header (`downloadAll` in
 * Header.jsx), and each finished chain would otherwise leave a listener holding
 * its `list` and `timer`. `{once: true}` covers only an abort that fires.
 */
export function sequentialDownload(hrefs, options) {
  const o = options || {};
  const click = o.click || clickHref;
  const schedule = o.schedule || ((fn, ms) => setTimeout(fn, ms));
  const gap = Number.isFinite(o.delay) ? o.delay : DOWNLOAD_GAP_MS;
  const list = (Array.isArray(hrefs) ? hrefs : []).filter(Boolean);
  const signal = o.signal || null;
  let at = 0;
  let timer = null;
  // Set while this chain is listening; called at every way out of `step`, which
  // is what makes an empty list and an already-aborted signal leave nothing on
  // the signal either.
  let unlisten = null;
  const done = () => { if (unlisten) { unlisten(); unlisten = null; } };
  const step = () => {
    if (at >= list.length || (signal && signal.aborted)) { done(); return; }
    click(list[at]);
    at += 1;
    if (at < list.length) timer = schedule(step, gap);
    else done();
  };
  if (signal) {
    const cancel = () => { clearTimeout(timer); unlisten = null; };
    signal.addEventListener('abort', cancel, { once: true });
    unlisten = () => signal.removeEventListener('abort', cancel);
  }
  step();
  return list.length;
}

export function downloadsView(catalogue, deps) {
  const { downloadAll, key, documents, views } = deps;

  // A row is controls side by side: the link, filling it, then, for a 3MF,
  // Open in Bambu Studio (bambu.jsx), and its Copy link at the end
  // (copylink.jsx), neither of which may sit inside the `<a>`.
  const dlRowStyle = 'display:flex;align-items:center';
  const dlLinkStyle = `display:flex;flex:1;min-width:0;align-items:center;gap:10px;padding:6px 4px 6px 22px;text-decoration:none;color:var(--text);font:400 12px ${SANS}`;
  const downloadGroups = groupDownloads(catalogue, documents, views).map((g) => ({
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
    // No `stop()`: the click bubbles to the header's own (`onClick` in
    // Header.jsx) and closes the menu, which
    // is exactly what a file row beside it already does by being a plain link.
    onAll: () => downloadAll(g.files.map((f) => fileHref(f.file, key))),
  }));
  const anyDownloads = downloadGroups.length > 0;

  return { downloadGroups, anyDownloads, dlShown: !!key };
}
