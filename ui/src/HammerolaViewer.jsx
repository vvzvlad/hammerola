/**
 * ============================================================================
 *  HammerolaViewer — the build page: tree, section, measure, move, comments
 * ============================================================================
 *
 * The designer's mock-up, ported onto the hub's real data and the real viewport.
 * What changed from the mock, and why, in one place so nobody has to diff it:
 *
 *   PARTS / NODES  -> the part tree the viewport hands over on `hmr:model`,
 *                     walked recursively (hub.indexTree). There is no flat node
 *                     list and there is not going to be one: the nesting IS the
 *                     assembly structure. This side does NOT fetch the view file
 *                     — the viewport fetches it to render it, and the tree is
 *                     inside that same two-megabyte document.
 *   REVS           -> /project/<pid>/builds.json, which carries the pointers
 *                     (`has_dev`, `latest`) beside the history of commits.
 *   DIFF           -> nothing. The hub has no endpoint that compares two
 *                     builds (plan step 8), so the panel is drawn and says so.
 *   notes          -> TWO different things that share one word, and the box on
 *                     the canvas labels them rather than stacking them. The
 *                     READER's is localStorage, keyed by part NAME, per
 *                     project, and never leaves this browser — there is still
 *                     no route that writes it anywhere. The AUTHOR's is
 *                     published content: written in `model.py`, validated at
 *                     build and again at publish, and carried in the build's
 *                     own `meta.notes` — a flat map from part NAME to text. It
 *                     is shown to EVERYONE, exactly like the part's name, and
 *                     `meta.notes` is absent on a build that carries none (and
 *                     on every build published before the key existed), which
 *                     is the ordinary case rather than an error.
 *   comments       -> the write endpoint is real, used, and since step 0 it
 *                     REQUIRES the token. The FEED is still not fetched, but the
 *                     reason has changed and the difference matters to whoever
 *                     picks this up: reading the queue used to be behind an
 *                     agent-only secret that could never travel to a browser,
 *                     and it now takes the same EDIT_TOKEN this page already
 *                     holds. What is left is a design question, not a
 *                     permission — the rail says which one.
 *   buildStatus    -> polling meta.json on the two pointer URLs, which answers
 *                     exactly one of the brief's three questions: "has a new
 *                     build arrived while I was looking at this one".
 *   viewerMode     -> derived, not a prop: it is `no token`.
 *
 * THE TOKEN (brief, "Что разделяет заказчика и зрителя"). Whoever has it can
 * edit and comment; whoever does not gets the interface to look with. It is
 * typed in by the person, kept in localStorage per project, and removable.
 * Closed without it: the reader's OWN note on a part, moving a part, and
 * comments entirely. Open always: orbiting, the tree, the section, measuring,
 * the downloads, the frame grab — and the author's note, which is part of what
 * was published rather than something this browser is allowed to change.
 *
 * CONTRACT WITH THE VIEWPORT — see events.js for the names. Down, one event
 * carrying the whole of what should be on screen; up, nine. `sync()` below is
 * the only place this file writes to that event, exactly as in the mock.
 *
 * THREE PLACES THE MOCK'S CONTRACT WAS NOT TAKEN LITERALLY, all three because
 * the real viewport is a real one:
 *
 *   * `camera` does not travel in `hmr:state` from this side at all. The mock
 *     sent `{theta, phi, r}` about its own scene; the viewport wants the
 *     library's `{position, quaternion, target, zoom}`, and the only sensible
 *     source of those is the viewport itself. So Fit is `el.setCamera(home)`
 *     through the element's own imperative half, where `home` is the frame the
 *     library fitted when it first rendered this view. Going through the state
 *     event would also mean a camera that is applied once and then compares
 *     equal forever — Fit would work exactly one time.
 *   * the SNAPSHOT a comment carries is `el.snapshot()`, the library's own
 *     `getImage`, not a `canvas.toDataURL()` from outside. A WebGL canvas
 *     without `preserveDrawingBuffer` reads back blank unless the grab lands in
 *     the same frame as a draw.
 *   * the hold key is C and it belongs to the viewport, which knows which
 *     letters the library already eats. This file only listens for `hmr:tool`
 *     and shows what it is told.
 *
 * STYLING is inline, carried over from the mock so the layout stays 1:1 —
 * `css()` parses a CSS string into a React style object. Two exceptions, both
 * forced: the comment pins are DOM the viewport creates, so they are styled by
 * class from the one `<style>` block below; and the fonts are a system stack
 * rather than the mock's Google Fonts link, because this page's CSP is
 * `default-src 'self'`.
 */

import React from 'react';

import {
  STATE, PICK, MENU, FACE, MEASURE, MOVED, PLACE, PIN, MODEL, ERROR, TOOL,
  VIEWPORT_TAG,
} from './events.js';
import {
  PAGE, ASSEMBLED_VIEW_ID, isPointerPage, buildKey, indexTree,
  loadMeta, loadBuilds, rereadPage, shortId, stamp, mb,
} from './hub.js';
import {
  readToken, writeToken, clearToken, readNotes, writeNotes, rememberPointer,
} from './store.js';
import {
  css, FONTS, SANS, MONO, Mark, PAGE_BG, PAGE_FG, HEADER_BG, HEADER_LINE,
} from './style.jsx';
// The canvas theme lives with the rest of the viewport's options, and so does the
// storage for it: `tests/test_ui_source.py` allows this side exactly one module
// that touches localStorage (store.js), and the viewport keeps its own answers
// under its own guard. Only the two functions come across -- importing the option
// objects themselves would be this file deciding how the library is started.
import { readTheme, writeTheme } from './viewport/options.js';

// `css()`, the font stacks and the mark now live in style.jsx: this page stopped
// being the only one drawn with them when the front page landed, and a second
// copy of the font stacks is two typefaces on one site. That module says why the
// stacks are what they are.

/**
 * The only rules that cannot be inline styles.
 *
 * A comment pin is an element the VIEWPORT creates and positions — it has to be,
 * because its place on screen is a world point projected through a camera that
 * moves sixty times a second, and routing that through React would re-render the
 * interface on every mouse move. What crosses the boundary is the data and the
 * click; how a pin LOOKS stays here, which is why the viewport sets only class
 * names on it.
 *
 * Four class names, and the division between them and the viewport is the same
 * one every time: the viewport POSITIONS (inline, per frame, in code), this
 * stylesheet DECIDES HOW IT LOOKS. `.hmr_canvas` and `.hmr_overlay` are the two
 * layers the element builds — the library's container and the layer of pins over
 * it. Neither needs layout from here; what they need is the page's own colour
 * under the model instead of the browser's white, which is what shows while the
 * viewer module is still loading, and a font for anything the overlay grows
 * later. `.hmr_pin` and `.hmr_measure_label` are the two things drawn IN that
 * overlay, and their whole appearance is here.
 *
 * Injected as a `<style>` element rather than an imported stylesheet: an
 * `import './x.css'` would make this build emit a second output file, and that
 * name would then have to be added to the Makefile, the Dockerfile, ci/smoke.py
 * and the page template — see ui/vite.config.mjs, which says so at length.
 */
const PIN_CSS = `
.hmr_canvas {
  background: #e4e7ea;
}
.hmr_overlay {
  color: #1c1f23;
  font-family: ${FONTS['--hmr-sans']};
}
.hmr_pin {
  display: flex; align-items: center; justify-content: center;
  min-width: 20px; height: 20px; padding: 0 5px;
  transform: translate(-50%, -100%);
  border: none; border-radius: 10px 10px 10px 3px;
  background: #1f7ae0; color: #fff; cursor: pointer;
  font: 600 10.5px ${FONTS['--hmr-mono']};
  box-shadow: 0 2px 6px rgba(20, 24, 28, .35);
}
.hmr_pin.is_active { background: #14538f; box-shadow: 0 0 0 3px rgba(31, 122, 224, .35); }
.hmr_pin.is_resolved { background: #c3c8cf; color: #4a5057; }
.hmr_measure_label {
  padding: 3px 7px; border-radius: 4px;
  background: rgba(28, 31, 35, .88); color: #f2f3f5;
  font: 600 11px ${FONTS['--hmr-mono']};
}
`;

// The same number as the hub's ceiling on comment text — `comment_max_text_chars`
// in src/settings.py — spelled a second time here, because there is no way for
// the page to be told the hub's: `templates/build.html` is written into the build
// directory at PUBLISH time (src/render.py) and carries no per-hub values, and
// meta.json is written then too, while the setting is read per request and can
// change under a page that is already open.
//
// So this is a copy that can go stale, and it is worth being precise about which
// direction hurts. Raised on the hub, the form is merely stricter than it needs
// to be. LOWERED on the hub — the only reason anyone would touch it — and the
// textarea keeps accepting text the hub will refuse, which arrives back as a 422
// and the toast about photo formats. What this ceiling does buy, at every
// setting, is that the browser stops a runaway paste before it becomes a
// multipart upload.
const MAX_COMMENT_CHARS = 4000;

// How often a pointer page asks whether a newer build has landed. Below a
// second the poll costs more than what it watches for; above five the "did that
// take?" pause gets long enough that people reload by hand. Three is what this
// site has polled at since live reload existed; nothing depends on the exact
// value, only on it staying inside that window.
const POLL_MS = 3000;
const POLL_MAX_MS = 60000;

// How long a swap waits for the reader's hand, and how often it looks again.
//
// The viewport answers `isBusy()` for a drag in progress and for a moment after
// one (viewport/live.js), and a swap re-renders the scene and re-seats the
// camera — doing that between a press and its release pulls the model out from
// under the pointer. So the swap waits, and `pending` stays exactly where it is
// while it does, which is what keeps the offer from being lost.
//
// AND IT HAS A DEADLINE, because "busy" hangs on a `pointerup` this page is not
// guaranteed to see: a release over another window, or a tab that lost focus
// mid-drag, leaves the flag set with nobody left to clear it. The reader pressed
// Switch; a button that quietly does nothing for ever is worse than a model that
// jumps under a hand that is no longer there.
const BUSY_RETRY_MS = 250;
const BUSY_WAIT_MS = 5000;

/** The letter the viewport holds the cut tool up on. Shown, never bound here. */
const HOLD_KEY_LABEL = 'C';

/**
 * `meta.downloads` regrouped as part name -> the files published for that part.
 *
 * The hub publishes `{label: filename}` and nothing that says which part a file
 * belongs to — the answer is in the FILENAME, which is always `<part>.<ext>` for
 * ext in step/stl/3mf (`download_labels` in src/cadbuild/printables.py). Nothing
 * about the wire format changes for this; the grouping is done here, in the one
 * place that needs it.
 *
 * READ THE VALUE, NEVER THE KEY, and that is the whole trap: with a single
 * printable the LABEL degenerates to a bare `step` / `stl` / `3mf` with the part
 * name gone from it, while the filename does not degenerate at all. A menu built
 * by matching labels against a part name would therefore work on every assembly
 * except the one-part one, which is the smallest and most common case there is.
 *
 * SPLIT AT THE LAST DOT: a printable's name may itself contain dots (MEMBER_RE
 * allows them), so `v1.2.plate.stl` is the part `v1.2.plate`, not `v1`.
 *
 * A Map rather than an object, because the keys are model-supplied strings and
 * `__proto__` is a legal printable name — assigning it on an object literal
 * silently stores nothing.
 */
export function filesByPart(downloads) {
  const out = new Map();
  Object.values((downloads && typeof downloads === 'object') ? downloads : {})
    .forEach((value) => {
      const file = String(value);
      const cut = file.lastIndexOf('.');
      // No extension, or nothing before the dot: not a `<part>.<ext>` name, and
      // guessing at one would put a row in the menu that downloads nothing.
      if (cut <= 0 || cut === file.length - 1) return;
      const name = file.slice(0, cut);
      if (!out.has(name)) out.set(name, []);
      // In the order the hub wrote them — step, stl, 3mf — rather than sorted,
      // so the menu lists what was published in the order it was published.
      out.get(name).push({ ext: file.slice(cut + 1), file });
    });
  return out;
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

/** The row's own name inside its group: the label with its format taken off.
 *
 * The label the hub publishes is `<part>.<ext>` — except with a SINGLE printable,
 * where it degenerates to a bare `step` / `stl` / `3mf` and the part name is gone
 * from it (`download_labels` in src/cadbuild/printables.py). Stripping the format
 * off THAT leaves nothing at all, so the filename's stem answers instead: the
 * filename never degenerates, which is the same fact `filesByPart` above is built
 * on.
 */
function rowName(label, file, cut) {
  const ext = file.slice(cut + 1);
  let name = label;
  // Case-insensitively, because the strip has to hold for whatever case the
  // label arrived in while the group is keyed by the uppercased one.
  if (name.toLowerCase().endsWith(ext.toLowerCase())) {
    name = name.slice(0, name.length - ext.length);
  }
  if (name.endsWith('.')) name = name.slice(0, -1);
  return name || file.slice(0, cut);
}

/**
 * `meta.downloads` as ordered groups of one FORMAT each, rows ordered by part.
 *
 * Flat, this menu is one row per file — thirty of them on a ten-part build, in
 * the order the hub happened to write them, so picking out every STL means
 * aiming at every third row. Grouped, the same thirty rows are three groups a
 * reader can take whole.
 *
 * THE GROUP KEY IS THE EXTENSION OFF THE FILENAME, never the label, and it is
 * the same trap `filesByPart` documents at length one screen up: the label is
 * the thing that degenerates on a one-part build, and the filename is the thing
 * that does not.
 *
 * A Map for the same reason as `filesByPart`: the keys come off model-supplied
 * filenames, so `__proto__` is reachable and an object literal would silently
 * store nothing under it.
 */
export function groupDownloads(downloads) {
  const groups = new Map();
  Object.entries((downloads && typeof downloads === 'object') ? downloads : {})
    .forEach(([label, value]) => {
      const file = String(value);
      const cut = file.lastIndexOf('.');
      // No extension, or nothing before the dot: the same rule as `filesByPart`,
      // and the same reason — a row built out of one downloads nothing.
      if (cut <= 0 || cut === file.length - 1) return;
      const ext = file.slice(cut + 1).toUpperCase();
      if (!groups.has(ext)) groups.set(ext, []);
      groups.get(ext).push({ label: rowName(String(label), file, cut), file });
    });
  const text = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const rank = (ext) => {
    const at = PRINT_FIRST.indexOf(ext);
    return at < 0 ? PRINT_FIRST.length : at;
  };
  return Array.from(groups.keys())
    .sort((a, b) => (rank(a) - rank(b)) || text(a, b))
    .map((ext) => ({
      ext,
      files: groups.get(ext).slice().sort((a, b) => text(a.label, b.label)),
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
 * THE FIRST ONE FIRES SYNCHRONOUSLY, and that is the load-bearing part: a
 * download is allowed because it is inside the gesture that asked for it, and a
 * first click deferred to a timer has left that gesture behind. The rest follow
 * on the clock; a browser that asks about the second file asks once, for the
 * site, and remembers the answer.
 *
 * `click` and `schedule` are arguments so this can be driven with fake timers
 * and a fake clicker — the ORDER and the SPACING are the whole of what it
 * promises, and neither can be observed through a real anchor in a test.
 *
 * AND IT CAN BE CALLED OFF, through `signal`. A chain outlives the gesture that
 * started it by `gap` × (N − 1) — two seconds on ten parts, six on thirty — and
 * every href in it was captured off `PAGE.base` when the button was pressed. A
 * reader who switches revision or leaves the page in that window would otherwise
 * go on being handed files of the build they left, one every fifth of a second,
 * with nothing on the screen saying where they came from. The abort is checked
 * at the top of every step, so an already-aborted signal hands over nothing at
 * all, and it also clears the pending timer — which is a real `clearTimeout` on
 * the default path and a no-op under an injected `schedule`, where the flag is
 * what does the work.
 *
 * AND THE LISTENER COMES OFF WHEN THE CHAIN ENDS NORMALLY, which is not
 * housekeeping: the SIGNAL outlives the chain. One controller serves the whole
 * page (`downloadAll`), so a listener left behind by a chain that finished sits
 * on it holding this call's `list` and `timer` until the first cancel — one more
 * for every press of a group link, on a page a reader can keep open all day.
 * `{once: true}` covers only the other end, an abort that actually fires.
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

/**
 * Where the part menu may open so that it stays on the screen.
 *
 * ONE HELPER FOR BOTH DOORS INTO THAT MENU — a right-click on a tree row and a
 * right-click on the part itself in the scene. They are the same menu with the
 * same items, and two copies of this arithmetic is how they would come to open
 * in two different places on the same screen for no reason a reader could see.
 *
 * BOTH NUMBERS ARE ASSUMPTIONS AND NEITHER IS MEASURED. 246 is the menu's own
 * 230 px width (`menuStyle`) plus a little slack; 300 is a guess at its height,
 * which genuinely varies — a part with three files has four rows more than a
 * group does. Measuring would mean rendering the menu, reading it back and
 * moving it, i.e. one frame of the menu in the wrong place. The failure these
 * numbers actually prevent is the menu opening mostly off the right or bottom
 * edge, and for that a guess is enough.
 */
export function menuAt(x, y) {
  return {
    x: Math.min(x, Math.max(0, window.innerWidth - 246)),
    y: Math.min(y, Math.max(0, window.innerHeight - 300)),
  };
}

/**
 * One entry of a note map — the only way a map keyed by PART NAMES may be read.
 *
 * There are two such maps on this page and neither is an object this code built:
 * the AUTHOR's comes out of a fetched meta.json, the READER's out of `JSON.parse`
 * on localStorage, and both inherit from `Object.prototype`. A part is allowed to
 * be called `constructor` or `toString` — the hub's own path alphabet says so —
 * and a bare `map[name]` on one of those answers with a FUNCTION off the
 * prototype. React refuses to render a function as a child and takes the page
 * down over a part name; the row menu's hint gets there sooner, slicing what it
 * thinks is a string. `hasOwnProperty.call` is what asks about the map itself
 * rather than about everything it inherits.
 *
 * ONE HELPER FOR ALL THREE READS, and that is the point of it being a function at
 * all. The guard used to be spelled out at the newest read and nowhere else,
 * which is a rule that holds exactly as long as whoever adds the fourth happens
 * to have seen the third.
 *
 * The type check is the same argument for a value the hub would never write but a
 * fetched document is free to carry: a note that is not a string is no note.
 */
export function noteFor(map, name) {
  if (!name || !map || typeof map !== 'object') return '';
  if (!Object.prototype.hasOwnProperty.call(map, name)) return '';
  return typeof map[name] === 'string' ? map[name] : '';
}

/**
 * The same map with one entry written, or — for an empty text — taken out.
 *
 * THE PAIR TO `noteFor`, and it exists because the READ was guarded and the
 * WRITE was not. `notes[name] = text` on a plain object is an ASSIGNMENT, and
 * `__proto__` names an accessor on `Object.prototype` rather than a slot: for a
 * string value that setter does nothing at all and reports no failure. A part
 * may be called `__proto__` — the hub's path alphabet allows it and
 * `render._check_part_name` does not object — so a reader who wrote a note on
 * one watched the dialog close exactly as it does on success, saw `{}` go to
 * localStorage, and got an empty box back from `noteFor`, which was answering
 * honestly. `Object.defineProperty` writes the slot the accessor stands in
 * front of, and an OWN property then shadows it on the way back out.
 *
 * A NEW OBJECT rather than a mutation, because that is what the caller needs:
 * `saveNotes` puts the result in state, and state is not edited in place.
 * Copying with the spread is safe where assigning is not — it defines rather
 * than sets, so a `__proto__` entry already in the map survives the copy.
 *
 * `Object.create(null)` was the other way out and is not enough on its own: the
 * map is not always built here. The reader's comes back through `JSON.parse` on
 * localStorage and the author's out of a fetched meta.json, and both of those
 * inherit from `Object.prototype` whatever this function does — which is why
 * `noteFor` guards the read regardless, and why the fix belongs at the one write
 * rather than in the shape of the object.
 */
export function notesWith(map, name, text) {
  const next = { ...(map && typeof map === 'object' ? map : null) };
  if (!name) return next;
  if (text) {
    Object.defineProperty(next, name,
                          { value: text, writable: true, enumerable: true, configurable: true });
  } else {
    delete next[name];
  }
  return next;
}

export default class HammerolaViewer extends React.Component {
  /**
   * The comment rail starts CLOSED, and the 300 px it used to take is the whole
   * argument: this page exists to show a model, the rail is a panel about
   * something else, and a reader who opened a build to look at it was paying for
   * a queue nobody asked to see. It is one click away in the header, it says how
   * many open items it holds without being opened, and it opens BY ITSELF for
   * the one arrival that is about a comment — clicking a pin on the model (the
   * PIN handler below, and posting a comment) sets `rail: true`.
   *
   * NOT REMEMBERED, unlike the list arrangement on the front page (store.js),
   * and for a reason that survives the obvious objection. "Remembering would
   * stop it being closed by default" is not the argument — a write from
   * `railToggle` alone would remember only what a person asked for and would
   * keep the default for everyone else. The argument is that THIS state is not
   * that: `s.rail` is one field and three writers set it, and two of them are
   * not a preference. The PIN handler opens the rail because a pin was clicked
   * on the model, and posting a comment opens it to show where the comment
   * went. Remembering the field therefore records "it was open", which mixes "I
   * asked for this panel" with "it was opened for me" — and one click on one pin
   * would quietly become "always show me the queue". Making it a preference
   * means giving it a writer that only a person can reach, which is a decision
   * to take deliberately rather than a side effect of storing a boolean.
   */
  static defaultProps = { commentsOpen: false };

  constructor(props) {
    super(props);
    this.host = React.createRef();
    // The frame the library fitted when it first rendered this view, which is
    // the only definition of "fit" available to a side that does not know the
    // model's bounding box.
    this.home = null;
    // The hidden and translucent parts another build opening is carrying across,
    // by NAME, waiting for the tree of the build it opened (`rejoin`). Written
    // by `leaveBuild` — which is to say by BOTH doors, the picker and the
    // banner's Switch — and read by exactly one model event. Not state: nothing
    // renders it, it lives for one model event, and a re-render in the middle of
    // a swap has no business seeing a half-applied one.
    this.carry = null;
    this.state = {
      // -- what the hub said
      meta: null, builds: null, tree: null, error: null, viewError: null,
      pending: null,          // a newer build, seen by the poll, not applied
      // A revision picked from the picker is on the wire. It exists to take the
      // banner's Switch out of service for exactly that window — see
      // `takePending`, which refuses on it, and `bannerSwitchStyle`, which is
      // what stops the button looking like it still works.
      swapping: false,
      // -- what the reader is doing
      view: null, tool: null, held: false, sel: null, selName: '',
      hidden: [], ghost: [], expanded: {},
      secOn: false, secOff: 0, secRange: null, secFlip: false, hatch: true,
      secFace: null, secPop: false,
      revOpen: false, dlOpen: false, cmp: [], compare: false, diffShow: 'both',
      bannerGone: false, rail: null, menu: null,
      notePop: null, noteDraft: '', notes: {},
      comments: [], activePin: null, composer: null,
      measure: null, moved: null, toast: null,
      // -- who the reader is
      // No project id: the secret is one string for the whole hub since step 0,
      // so keying it per project stored N copies of it (see store.js).
      token: readToken(), tokenPop: false, tokenDraft: '',
      // -- and what they want to look at the model against. Read here so the
      // first paint is already the reader's answer: the same read seeds the
      // options the viewport starts the library with (viewport/options.js), so
      // the button below never has to correct a canvas that came up wrong.
      theme: readTheme(),
    };
  }

  /** No token, no edits. The whole of the customer/viewer split (brief). */
  viewer() { return !this.state.token; }

  // -- loading --------------------------------------------------------------
  componentDidMount() {
    this.setState({ notes: readNotes(PAGE.pid) });

    // This page IS the arrival, so this is where the reader's pointer is
    // recorded (SPEC 9, and store.js for why it is written here and read
    // somewhere else). Before the load rather than after it: what is being
    // remembered is the URL that was opened, and it is already known — a build
    // whose meta.json never arrives was still the build this reader asked for.
    //
    // Only on a pointer page. On `/project/<pid>/<commit>/` there is no choice
    // between the two moving names to record, and the URL that names a pointer
    // has to keep winning over the remembered one.
    if (isPointerPage()) rememberPointer(PAGE.pid, PAGE.slot);
    this.load().catch((error) => {
      console.error('hammerola', error);
      this.setState({ error: String(error && error.message ? error.message : error) });
    });

    this._h = {
      [PICK]: (e) => {
        const id = (e.detail && e.detail.id) || null;
        this.set({ sel: id, selName: (e.detail && e.detail.name) || '', menu: null });
      },
      [MENU]: (e) => this.sceneMenu(e.detail),
      // The plane moved: either it was just laid on a face, or a drag of it
      // ended. Both carry the depth measured FROM THAT FACE and the range the
      // slider has to span, so neither number is invented on this side.
      [FACE]: (e) => {
        const d = e.detail || {};
        this.set({
          secOn: true,
          secFace: d.name || 'face',
          secOff: Number.isFinite(d.offset) ? d.offset : this.state.secOff,
          secRange: Array.isArray(d.range) ? d.range : this.state.secRange,
          tool: null,
        });
      },
      [MEASURE]: (e) => {
        const answer = e.detail;
        if (!answer || !Number.isFinite(answer.value)) return;
        const measure = this.measureLabel(answer);
        this.setState((s) => ({
          measure,
          composer: s.composer ? { ...s.composer, meas: measure.full } : s.composer,
        }));
      },
      [MOVED]: (e) => {
        const d = (e.detail && e.detail.delta) || [];
        if (d.length !== 3 || !d.every(Number.isFinite)) return;
        const mag = Math.round(Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) * 10) / 10;
        this.setState({ moved: { id: e.detail.id, name: e.detail.name, mag } });
      },
      [PLACE]: (e) => {
        // A comment is a task for the agent, and only the customer files one.
        if (this.viewer()) return;
        const d = e.detail || {};
        this.set({
          composer: {
            part: d.name || 'model', partId: d.id || null, p: d.p || null,
            text: '', photo: null,
            meas: this.state.measure ? this.state.measure.full : null,
          },
          tool: null,
        });
      },
      [PIN]: (e) => this.set({ activePin: e.detail && e.detail.id, rail: true }),

      // A view finished rendering, and brought the tree with it.
      [MODEL]: (e) => this.onModel(e.detail),
      // A view would not render. A method rather than a closure, for the reason
      // `onModel` is one: this map is built in `componentDidMount`, so anything
      // decided inside it can only be reached by mounting the whole page.
      [ERROR]: (e) => this.onViewError(e.detail),
      // The hold key, which the viewport owns. Display only — writing `cut` into
      // the tool this interface owns would make the release ambiguous, since the
      // viewport reports back the tool IT believes we set when the key comes up.
      [TOOL]: (e) => {
        const d = e.detail || {};
        this.setState({ held: !!d.held });
        if (d.escape) this.set({ tool: null });
      },
    };
    Object.keys(this._h).forEach((k) => window.addEventListener(k, this._h[k]));

    // Escape closes what is OPEN — a menu, a popover, an armed tool. It
    // deliberately does not close the composer: a half-written comment is the
    // most expensive thing on this page to lose, and Escape gets pressed by
    // reflex.
    this._kd = (e) => {
      if (e.key !== 'Escape') return;
      this.set({ menu: null, secPop: false, revOpen: false, dlOpen: false,
                 notePop: null, tokenPop: false, tool: null });
    };
    window.addEventListener('keydown', this._kd);

    // Back and forward through the revisions this page pushed. A switch is a
    // `pushState` (see `switchBuild`), so the browser's own history now holds
    // entries this document has to answer for itself — without this listener
    // Back changes the address bar and leaves the previous revision on screen,
    // which is a worse lie than the reload it replaced.
    //
    // The SLOT IS READ OFF `location`, never off `event.state`: the entry the
    // reader lands on may be the one the server rendered, which carries no state
    // of ours at all, and the URL is the only thing every entry has.
    this._pop = () => {
      const slot = String(location.pathname).split('/')[3] || '';
      // Nothing to do for the entry this page is already showing. No two
      // CONSECUTIVE entries can name the same slot — `switchBuild` refuses the
      // build already on screen, so nothing pushes one — which is why this is a
      // guard rather than a case that has to be answered.
      if (!slot || slot === PAGE.slot) return;
      this.switchBuild(PAGE.pid, slot, { push: false })
        .catch((error) => console.error('switch', error));
    };
    window.addEventListener('popstate', this._pop);

    // The viewport listens for `hmr:state` from its `connectedCallback`, so a
    // state sent before the element upgrades is simply lost. This is the resend
    // for the case where the adapter's module lands after the first paint — the
    // mock did the same thing with three timers, which is the version of this
    // that fails on a slow connection.
    if (window.customElements) {
      window.customElements.whenDefined(VIEWPORT_TAG)
        .then(() => this.sync())
        .catch((error) => console.warn('viewport', error));
    }
  }

  componentWillUnmount() {
    Object.keys(this._h || {}).forEach((k) => window.removeEventListener(k, this._h[k]));
    window.removeEventListener('keydown', this._kd);
    window.removeEventListener('popstate', this._pop);
    clearTimeout(this._tt);
    clearTimeout(this._poll);
    // The deferred swap goes with them: it holds `this` and would come back on a
    // component that is gone, to `setState` on it.
    clearTimeout(this._swap);
    // And so does a download chain still stepping. It touches no state, so it
    // survives an unmount perfectly happily — and goes on handing the browser
    // files of a build nobody is looking at any more.
    this.cancelDownloads();
    this._gone = true;
  }

  async load() {
    const meta = await loadMeta();
    const builds = await loadBuilds().catch((error) => {
      // A project with no builds.json is a project whose picker is empty, not a
      // page that failed: the model in front of the reader is unaffected.
      console.warn('builds', error);
      return null;
    });
    const wanted = new URLSearchParams(location.search).get('v');
    const variant = meta.variants.find((v) => v.id === wanted) || meta.variants[0];
    // `view` is what makes the viewport fetch and render: it starts null on both
    // sides, so this first sync is also the load.
    this.setState({ meta, builds, view: variant.id },
                  () => { this.sync(); this.schedulePoll(POLL_MS); });
  }

  // -- switching revisions in place -----------------------------------------
  //
  // Issue #62. Two revisions of one part are looked at from ONE angle:
  // somebody aims the camera at the corner they are unsure about, hides the
  // shell, lays a section on it, and then wants to see the same thing on the
  // build before this one. A full page load throws away every one of those at
  // exactly the moment they are worth the most — and the page it rebuilds is the
  // same shell, the same bundle and the same viewer, differing only in one
  // meta.json and one view payload.
  //
  // WHAT ACTUALLY MOVES is therefore small: the address, `PAGE`, `meta`, and the
  // two numbers the viewport reads to know the geometry changed (`base` and
  // `buildKey`). Everything else on this page is the same KIND of thing rebuilt
  // from different data.

  /**
   * Show another build of THIS project without throwing the page away.
   *
   * NOTHING IS TOUCHED UNTIL THE TARGET HAS ANSWERED. The meta.json is fetched
   * against a base of its own (`loadMeta`'s second argument) precisely so that a
   * revision that 404s leaves the page whole — the URL, `PAGE` and the model on
   * screen all as they were — instead of half moved with a frame around a hole.
   *
   * `push` is false for the one caller that must NOT push: `popstate`, where the
   * browser has already moved the address and pushing again would bury the entry
   * the reader just came back to.
   */
  async switchBuild(pid, slot, options) {
    const push = !options || options.push !== false;
    if (this._gone || !slot) return;
    // A DIFFERENT PROJECT IS STILL A REAL NAVIGATION, and it should be: the
    // title, the picker, the notes, the comment queue and every download would
    // all be replaced at once, which is a new page by any honest reading. This
    // page's own picker only ever lists one project, so this branch is a guard
    // on the day something else calls this rather than a path anybody takes.
    if (pid !== PAGE.pid) { location.href = `/project/${pid}/`; return; }
    // Already here. Closing the picker is the whole of the answer.
    if (slot === PAGE.slot) { this.setState({ revOpen: false }); return; }

    // CLOSED BEFORE THE FETCH, not after it: it is the only sign the click
    // landed on a gesture that now waits on the network, and a menu left open
    // over a page that has not moved yet reads as a click that missed.
    //
    // IT IS NOT A LOCK, and this comment used to say it was — that closing the
    // picker "keeps a second row from being picked while the first is still in
    // flight". False in two directions. `revToggle` puts the menu back with one
    // click and `onPick` asks nothing before calling this again; and `popstate`
    // never goes through the picker at all — its "already here" guard reads
    // `PAGE.slot`, which this method moves only AFTER the await, so Back during
    // a slow fetch sails through it and starts a second swap. Two in flight then
    // settled in whatever order the NETWORK answered: pick B, reopen, pick C,
    // and a reader whose last word was C ends on B, with `push B, push C, push
    // B` in the history behind them.
    //
    // SO THE NEWEST GESTURE WINS, BY NUMBER RATHER THAN BY REFUSAL. Turning a
    // row click away while a fetch is out would be a new rule of this interface
    // — nothing else here works that way, and a picker that ignores a row reads
    // as a page that has stopped responding — whereas "a newer gesture overrules
    // an older one" is already this file's rule, written out two paragraphs down
    // about the deferred take. `popstate` is not an intruder to be turned away
    // either: Back is a gesture like any other, and it is supposed to win.
    this.setState({ revOpen: false, swapping: true });
    // THE NUMBER, taken after the guards above rather than at the top of the
    // method: those return without touching anything, and a bump there would
    // cancel a live swap on behalf of a gesture that did nothing.
    //
    // Held locally, compared after every await. A swap that finds the field
    // moved is not the one the reader is waiting for and leaves WITHOUT A TRACE:
    // no `setState`, no `pushState`, no `rereadPage`. The push is why the check
    // has to come before it rather than after — a history entry cannot be taken
    // back, so the superseded swap has to give it up rather than correct it.
    //
    // `swapping` BELONGS TO WHICHEVER SWAP IS CURRENT, and only that one lowers
    // it. A stale swap answering 404 used to run `swapFailed` and hand the
    // banner's Switch back while a live swap was still on the wire — which is
    // precisely the window the flag exists to close, reopened by the one thing
    // that was supposed to be an error path.
    const gen = (this._swapGen = (this._swapGen || 0) + 1);

    // AND THE BANNER'S SWITCH GOES OUT OF SERVICE FOR THIS WINDOW, which the
    // picker's own closing was never going to do for it: the banner is not in
    // the picker, and — see above — the picker does not close for that purpose
    // anyway. A click on it during this await used to run `takePending` all the
    // way through — `meta` replaced by the banner's build, its geometry fetched,
    // "Now viewing …" toasted — and then this method landed the revision that
    // was actually asked for on top of it. That is exactly the symptom the
    // paragraph below calls unacceptable, reached by the shorter road: the
    // DEFERRED take needs a busy viewport to exist at all, while a direct click
    // needs nothing. `swapping` is refused by `takePending` and drawn by
    // `bannerSwitchStyle`, because a button that ignores clicks while still
    // looking like a button is a worse answer than one that looks spent.
    //
    // A REVISION ROW IS NOT REFUSED THE SAME WAY, and the asymmetry is the
    // decision: the banner offers ONE build and the reader has already been told
    // about it, so a press that lands mid-swap is answered by the swap they
    // asked for last; the picker offers every build there is, and refusing rows
    // out of it would be refusing the gesture rather than ordering two of them.

    // AND A DEFERRED TAKE OF THE BANNER'S BUILD GOES, BEFORE THE FETCH FOR THE
    // SAME REASON. Switch on the banner waits while the reader's hand is on the
    // model and retries every BUSY_RETRY_MS for up to BUSY_WAIT_MS
    // (`takePending`) — a quarter of a second against a network round trip, so a
    // reader who pressed Switch, saw nothing happen and picked a revision from
    // the picker instead has the deferred timer land INSIDE this await. It
    // replaces `meta` with the banner's build, tells the viewport to load its
    // geometry and toasts "Now viewing …", and then this method finishes and
    // puts the revision that was actually asked for on the screen: one wasted
    // load of a model nobody chose, and a toast naming a build that is not there.
    // Cancelling after the await would not reach it — that is the window it
    // fires in — so it is cancelled here, where the reader's newer gesture is
    // known and the older one has not yet had a chance to run.
    //
    // The OFFER itself is untouched: `pending` still holds it and the banner is
    // still up, so a swap that then 404s leaves the BUTTON exactly where it was
    // — `swapFailed` puts `swapping` down and Switch is live again. What is lost
    // is the PRESS, not the button: the `clearTimeout` on the line below throws
    // away a Switch that was waiting on a busy viewport, and nothing re-arms it
    // when the swap fails, so the reader has to press it again. That is the
    // intended trade — a newer gesture overrules an older one — but it is a
    // gesture that goes, and "leaves Switch exactly where it was" would read as
    // "nothing was lost" without this sentence.
    clearTimeout(this._swap);

    const path = `/project/${PAGE.pid}/${encodeURIComponent(slot)}/`;
    let meta = null;
    try {
      // `fresh`, because a POINTER is exactly the name whose content can have
      // been rewritten since the browser last saw it.
      meta = await loadMeta(true, path);
    } catch (error) {
      // SUPERSEDED SWAPS FAIL SILENTLY. `swapFailed` writes a `viewError`
      // naming a build the reader has stopped waiting for, and — worse — puts
      // `swapping` down under the swap that replaced this one. A revision that
      // 404s while a newer pick is already on the wire is not news: the newer
      // one will say whatever there is to say.
      if (gen !== this._swapGen) return;
      this.swapFailed(slot, error);
      return;
    }
    // NOTHING BELOW THIS LINE MAY RUN FOR A SWAP THAT WAS OVERTAKEN — it pushes
    // an entry, moves `PAGE` and rebuilds the state, and the entry in particular
    // is not something a later correction can take back.
    if (this._gone || gen !== this._swapGen) return;
    const variants = Array.isArray(meta && meta.variants) ? meta.variants : [];
    if (!variants.length) {
      this.swapFailed(slot, new Error('this build lists no views'));
      return;
    }

    // WHICH VIEW IS WANTED DEPENDS ON WHO MOVED. A row click carries the
    // reader's own tab across; a `popstate` is the browser putting an entry back
    // on the screen, and that entry's `?v=` IS the state being restored —
    // reading the current tab there would leave the address bar saying one view
    // while the page showed another, which is the whole failure this entry is
    // about, spelled with the Back button.
    const wanted = push
      ? this.state.view
      : (new URLSearchParams(location.search).get('v') || this.state.view);
    // It survives when the target declares one with the same id, and otherwise
    // falls back to the first — exactly what a fresh load of that URL does with
    // a `?v=` naming a view the build does not have.
    const view = variants.some((v) => v.id === wanted) ? wanted : variants[0].id;
    // AND THE ADDRESS SAYS SO. `?v=` is what `load()` reads on a fresh open, so
    // the URL this pushes has to carry it wherever the view on screen is not the
    // one that URL would open on by itself — otherwise the link in the address
    // bar, copied and sent, shows a different view than the sender was looking
    // at. Dropped where the view IS the target's first, since the query would
    // then repeat what the path already answers.
    const query = view === variants[0].id ? '' : `?v=${encodeURIComponent(view)}`;

    // EVERYTHING THAT DESCRIBED THE BUILD BEING LEFT GOES HERE, and this is the
    // one list of it — `takePending` opens a build too and calls the same
    // method. The plane inside it is asked about the view actually landing on
    // screen, not about whether the target HAS the old one: a `popstate` can
    // restore a different view of the same parts, and a depth measured on the
    // other arrangement is as much about a model that moved as one measured on
    // another build.
    //
    // WHAT ACTUALLY PINS THE POSITION is one statement, not two: the answer is
    // spread into the `setState` below, so the call has to come before that.
    // `_refit`, set inside, has to be standing before `onModel` lands, and that
    // is a fetch away.
    //
    // AN EARLIER VERSION OF THIS PARAGRAPH SAID IT HAD TO PRECEDE `rereadPage`
    // AND THE NEW `meta`, "because the carry is read off the tree that is still
    // on screen". That is false and is named here so it is not written back:
    // `rereadPage` writes `PAGE` and nothing else, `setState({ meta })` does not
    // touch `tree`, and the tree has exactly one writer — `onModel`.
    const gone = this.leaveBuild(view === this.state.view);

    if (push) history.pushState({ hmr: slot }, '', path + query);
    // IN PLACE, so every module that imported `PAGE` sees the new revision —
    // `loadMeta`, `loadBuilds`, `isPointerPage`, `sync`'s `base`, the comment
    // route, the download hrefs and the header's own slot. Nothing re-derives it
    // on its own, which is why a swap that forgot this line would go on fetching
    // the revision that had just left the screen, silently and forever.
    rereadPage(path);

    // AND TWO THINGS ALREADY IN FLIGHT ARE NOW ABOUT A BUILD THIS PAGE HAS LEFT.
    // Both were started against the `PAGE.base` of the line above, both outlive
    // the gesture that started them, and neither has any way of noticing that
    // the page moved underneath it — so the swap has to reach them here, at the
    // one moment it is certain the move is really happening.
    //
    // The POLL is cut off by generation rather than by a timer, because what has
    // to be dropped is an answer that is already on the wire (`poll`).
    this._pollGen = (this._pollGen || 0) + 1;
    // The DOWNLOAD chain is cut off outright. The hrefs were built out of the
    // previous revision's base (`fileHref` reads `PAGE.base`), so every file
    // still to come is one the reader has walked away from — handed over one
    // every fifth of a second, with nothing on the screen saying which build it
    // came from.
    //
    // BOTH OF THESE ARE OUTSIDE `leaveBuild` AND BOTH FOR ONE REASON, which is
    // the line to hold on to: everything on that list goes with the BUILD, and
    // these two go with the ADDRESS — the line above is where this page's
    // address moves. `takePending` opens another build without moving the
    // address, so it wants the list and neither of these. (The earlier wording
    // called the download chain "the one thing a swap does that `leaveBuild`
    // does not", with `_pollGen` sitting two lines above it doing exactly the
    // same job.)
    this.cancelDownloads();

    this.setState({
      meta,
      view,
      ...gone.state,
      // The poll's offer was about the slot we are leaving. A pinned revision
      // has nothing to offer at all, and the banner would sit there for a build
      // that is no longer on this page's road. `bannerGone` is lifted rather
      // than set, unlike in `takePending`: nothing has been offered on the new
      // road yet, so the next build to arrive there gets its banner.
      bannerGone: false,
      // The fetch is answered and landed, so the banner's Switch is a live
      // button again — for whatever the poll offers on THIS road next.
      swapping: false,
    }, () => {
      this.sync(gone.extra);
      // Recorded here for the same reason `componentDidMount` records it: this
      // is an arrival at a pointer URL, and SPEC 9 is about which of the two
      // moving names this reader was last on.
      if (isPointerPage()) rememberPointer(PAGE.pid, PAGE.slot);
      // Cleared BEFORE the re-arm, because `schedulePoll` returns without
      // touching the timer when the new slot is a pinned revision — so a poll
      // armed while the page was on `latest` would otherwise still fire once
      // against a build that can never change.
      clearTimeout(this._poll);
      this.schedulePoll(POLL_MS);
      // AND THE PICKER'S OWN LIST CATCHES UP, which the reload used to do for
      // free: builds.json is read once on mount, so a session spent switching
      // between revisions would go on showing the history as it stood when the
      // page opened, and a revision published meanwhile could not be reached
      // from the menu at all.
      //
      // AFTER the swap and not before it, deliberately: this is a list on a menu
      // nobody has open, and making the model wait on it would spend a round
      // trip of the reader's time on something they are not looking at. Best
      // effort for the same reason the first load treats it that way — a project
      // whose builds.json is missing has an empty picker, not a failed page.
      loadBuilds()
        .then((builds) => { if (!this._gone) this.setState({ builds }); })
        .catch((error) => console.warn('builds', error));
    });
  }

  /**
   * The target would not open. Say so where a view that would not render is
   * said, and change nothing else.
   *
   * `viewError` is the panel this page already has for "what you asked to look
   * at is not what is on screen", and nothing was moved before the fetch
   * answered, so the previous revision is still standing under the reader's
   * camera. Its Retry button re-asks the viewport for the view that IS on screen
   * — a re-render of what is already there, which costs a fetch and nothing
   * else; the way back to the build that failed is the picker, which never left.
   *
   * AND THE BANNER GOES BACK INTO SERVICE. `swapping` was raised for the length
   * of the fetch; a fetch that answered with a 404 is a fetch that is over, and
   * the offer standing on `pending` is untouched — so the one thing that must
   * not happen here is the reader being left looking at a spent Switch over a
   * build that is still perfectly takeable.
   */
  swapFailed(slot, error) {
    console.warn('switch', error);
    this.setState({
      revOpen: false, swapping: false,
      viewError: `${shortId(slot)} did not load — still showing ${shortId(PAGE.slot)}`,
    });
  }

  /**
   * WHAT GOES WHEN ANOTHER BUILD OPENS ON THIS PAGE — one list, for the two
   * doors into one.
   *
   * THERE ARE TWO AND THE SECOND ONE IS EASY TO MISS. `switchBuild` is the
   * reader picking a revision; `takePending` is the reader accepting the
   * banner's offer, which is just as much another build — a different commit,
   * built from different sources, with a box of its own. This list used to be
   * written out inside `switchBuild` and nowhere else, and everything on it was
   * therefore simply kept across the banner: the pins of the build that left
   * were drawn on geometry that never carried them, the draft went on posting a
   * solid path and a 3D point of one build against the commit of another, and
   * the section plane was never asked whether it still meant anything. TWO
   * COPIES OF THIS LIST IS THE DEFECT, not the symptom of it — a third would
   * drift exactly the same way — so it lives here and both callers spread it.
   *
   * `keepView` is whether the view id actually landing on screen is the one that
   * was on it, which is the strongest question the plane can be asked from this
   * side (`sectionAcross`).
   *
   * RETURNED IN TWO HALVES because the section is two things: fields on this
   * side AND an instruction to the viewport, which holds a cut of its own. A
   * caller that spread `state` and dropped `extra` would leave the plane
   * standing in the scene with the slider back at zero.
   *
   * THE SIDE EFFECTS BELONG HERE TOO, and they are the same argument: each one
   * is about the build being left rather than about how the reader left it.
   *
   * WHICH IS ALSO WHY TWO THINGS ARE NOT ON IT, and the boundary is worth
   * naming so neither is "fixed" back in: cutting off the DOWNLOAD CHAIN and
   * bumping `_pollGen` both live in `switchBuild`, because this list is what
   * goes with the BUILD and those two go with the ADDRESS. `switchBuild` moves
   * the address; `takePending` does not. A chain running across the banner is
   * handing over files that resolve against the pointer exactly as the reader
   * asked, so cutting it there would truncate a group download — three STLs of
   * ten, silently — on the strength of a gesture that changed no href.
   */
  leaveBuild(keepView) {
    const sec = this.sectionAcross(keepView);
    // The frame Fit goes back to belongs to the build it was measured on, and
    // this is another build. Spent by the model event that lands the swap; see
    // `onModel`, which is where the argument for it is written out.
    this._refit = true;
    // The toast goes: it sits for 2.6 s and says what the page was doing for the
    // build that has left, so it would otherwise stand over the new one saying
    // something that has stopped being true.
    clearTimeout(this._tt);
    // Hidden and translucent parts are held as leaf ids, and an id is a solid
    // path that a rebuild is free to renumber; a NAME is what the person
    // recognises and what they meant. Read HERE — where the tree on screen is
    // still the one those ids belong to — and rejoined against the new tree when
    // it arrives (`rejoin`).
    //
    // IT IS ON THIS LIST AND NOT IN `switchBuild` BECAUSE IT WAS MISSED ON THE
    // OTHER DOOR: `takePending` set no carry, so `rejoin` answered null and the
    // ids of the build that left were sent straight on to the build that
    // replaced it. A reader who hid a part and pressed Switch watched it come
    // back — or worse, watched a DIFFERENT part disappear, because the path it
    // had been renumbered onto belongs to somebody else now — while the toast
    // said "your frame and tree are kept".
    //
    // AND IT IS WRITTEN ONLY WHERE THERE IS A TREE TO READ IT OFF, which is not
    // a null check but the whole meaning of the field: `carry` describes the
    // build being LEFT, not what is on the screen now. No tree means the names
    // cannot be looked up here — it does not mean nothing was hidden — so
    // writing the empty answer would be recording a fact nobody established.
    //
    // The sequence that costs is `onViewError`: a swap whose view never rendered
    // clears the tree and leaves an UNSPENT carry standing, because `rejoin` is
    // consumed by a model event that never arrived. A reader who then opens
    // another build instead of pressing Retry comes through here with
    // `state.tree` null, and the overwrite threw away names that were still
    // exactly right — every hidden part back on screen, over a failure two
    // gestures ago. Kept, they are spent by the next model event to land, which
    // is what the carry is for.
    //
    // A BUILD WITH NO SOLIDS IS THE OTHER CASE AND IS NOT THIS ONE. `indexTree`
    // always answers with an object, so `state.tree` is falsy only where no
    // model event ever landed (the initial state, and `onViewError`); a real
    // build with an empty tree is truthy and clears the carry here, correctly —
    // nothing in it can be hidden.
    if (this.state.tree) {
      this.carry = { hidden: this.namesOf(this.state.hidden),
                     ghost: this.namesOf(this.state.ghost) };
    }
    return {
      state: {
        // Cleared so the panel does not describe the build that has left. The
        // model event that lands this swap clears it again (`onModel`); this is
        // for the window before it arrives.
        viewError: null,
        // MOMENTARY THINGS GO. A selection pointing at a part that may not exist
        // in this build is worse than no selection, and a menu or a popover that
        // outlived the model it was opened over is a menu about nothing.
        //
        // ONE THING THAT DESCRIBES THE OLD BUILD IS DELIBERATELY NOT HERE, and
        // it is named so the list does not read as exhaustive: the TREE. It is
        // REPLACED rather than dropped — `onModel` puts the new build's in when
        // the view lands — so clearing it here would blink the panel empty on
        // every switch that works, for the sake of the rare one that does not.
        // The swap whose view never lands is handled where the failure is known
        // instead; see `onViewError`.
        sel: null, selName: '', menu: null,
        revOpen: false, dlOpen: false, secPop: false,
        tokenPop: false, tokenDraft: '', notePop: null, noteDraft: '',
        // Both describe geometry that has just left the screen; the viewport
        // clears its own tape and offsets on every load.
        measure: null, moved: null,
        // Whichever build was on offer, it has been answered — taken by
        // `takePending` or made irrelevant by `switchBuild` moving the road. The
        // BANNER is the callers' own business, because "taken" and "no longer
        // on this road" are different answers.
        pending: null,
        // THE COMMENTS FILED IN THIS SESSION GO WITH THEM, and the pins are why.
        // This list only ever holds what the reader posted while this page was
        // open — each one against the commit it was posted on — and every pin in
        // it is a POINT IN THE MODEL SPACE of that build, which `sync` reads
        // straight out of here and hands to the viewport on the next frame. Kept,
        // they would be drawn on geometry that never carried them, at coordinates
        // the new build need not contain at all. Nothing is lost: the comments are
        // on the hub, filed against the revision they were written about.
        comments: [], activePin: null,
        // THE TEXT SURVIVES THE SWAP AND NOTHING POSITIONAL DOES, and the line
        // between them is what the reader WROTE against what this page MEASURED.
        //
        // The sentence is the reader's own and half-written text is the most
        // expensive thing on this page to lose (the same reason Escape spares it);
        // it is also still true of the revision now on screen often enough to be
        // worth keeping, and the reader can read it and decide. Everything else in
        // the draft is a coordinate this page took off geometry that has left:
        // which solid was picked, where in space, a measurement between two faces,
        // a part dragged out of the assembly. `sendComment` posts to `meta.commit`
        // — which is the NEW build's the moment this lands — so a draft carried
        // whole files every one of those as a fact about a build they were never
        // observed on, and the numbers among them go to an agent as a task.
        //
        // THE PART'S NAME GOES WITH THEM even though a name outlives a rebuild,
        // and that is the correction on the obvious answer. `composerPart` renders
        // it, `sendComment` sends `partId`, so a kept name shows the reader an
        // attachment the posted comment will not have — worse than showing none,
        // because the mismatch is invisible. Re-attaching it to the same-named
        // part of the new build was the other way out and is worse still: it aims
        // "this chamfer is too sharp" at a chamfer nobody looked at. Unattached
        // and honest, then; one click puts it back where the reader means it.
        composer: this.state.composer
          ? { ...this.state.composer, part: '', partId: null, p: null, meas: null, move: null }
          : null,
        // The toast that `clearTimeout(this._tt)` above disarmed.
        toast: null,
        ...(sec || null),
      },
      extra: sec ? { __resetCut: true } : null,
    };
  }

  /**
   * What the section plane does across a swap: `null` to keep it, or the patch
   * that puts it away.
   *
   * A PLANE IS A NUMBER IN MODEL SPACE and the model may have moved under it. It
   * survives only where it still means something — the same view id, so the
   * parts are laid out the same way, and an offset that is still inside the
   * extent the slider was given. Anywhere else the number is about a build that
   * is gone, and a cut left standing at it slices through empty air or through
   * the middle of a part nobody asked to see inside of.
   *
   * The range is the one measured on the build being LEFT, because it is the
   * only one that exists until a face is picked on the new one — the hub
   * publishes no extent. So this asks the strongest question available on this
   * side, and errs toward putting the plane away.
   */
  sectionAcross(keepView) {
    const s = this.state;
    const range = s.secRange;
    const admits = Array.isArray(range) && range.length === 2
      && Number.isFinite(range[0]) && Number.isFinite(range[1])
      && s.secOff >= range[0] && s.secOff <= range[1];
    if (keepView && admits) return null;
    return { secOn: false, secOff: 0, secFlip: false, secFace: null, secRange: null };
  }

  /** The NAMES behind a list of leaf ids, in the tree on screen right now. */
  namesOf(ids) {
    const tree = this.state.tree;
    if (!tree || !Array.isArray(ids)) return [];
    const names = [];
    ids.forEach((id) => {
      const node = tree.nodes.get(id);
      if (node && !names.includes(node.name)) names.push(node.name);
    });
    return names;
  }

  /**
   * Those names again, as ids of the tree that has just arrived — or `null`
   * when no swap is landing.
   *
   * A NAME THAT IS NOT IN THE NEW TREE IS SIMPLY DROPPED: a part that is gone
   * cannot stay hidden, and carrying the name forward would leave the reader a
   * list of instructions about parts nobody can see or unhide.
   *
   * Consumed rather than read, so exactly one model event acts on a switch. The
   * one that follows a failed switch never arrives, and the carry is then spent
   * on the next render instead — which is the same operation on the same names
   * and is right there too.
   */
  rejoin(tree) {
    const carry = this.carry;
    this.carry = null;
    if (!carry || !tree) return null;
    const byName = new Map();
    tree.leaves.forEach((id) => {
      const node = tree.nodes.get(id);
      if (!node) return;
      if (!byName.has(node.name)) byName.set(node.name, []);
      byName.get(node.name).push(id);
    });
    const resolve = (names) => names.reduce(
      (out, name) => out.concat(byName.get(name) || []), []);
    return { hidden: resolve(carry.hidden), ghost: resolve(carry.ghost) };
  }

  /**
   * A view finished rendering, and brought the tree with it.
   *
   * A method rather than a closure inside the handler map — the same move
   * `sceneMenu` makes and for the same reason: the map is built in
   * `componentDidMount`, which loads a build and starts a poll, so a decision
   * written inside it can only be reached by mounting the whole page.
   */
  onModel(detail) {
    const d = detail || {};
    const tree = indexTree(d.tree);
    // Non-null only while a revision switch is landing. Every other model event
    // — a first load, a live reload, a view tab — leaves the two lists alone.
    const rejoined = this.rejoin(tree);
    this.setState((s) => ({
      tree,
      view: d.view || s.view,
      viewError: null,
      // Both belonged to the scene that has just been torn down: the
      // viewport clears its own tape and its own offsets on every load, and
      // a chip left standing here would describe a model that is gone.
      measure: null,
      moved: null,
      // The reader's own collapses survive: part paths are the same across a
      // rebuild, and this is the tree they were reading a moment ago.
      expanded: { ...this.defaultExpanded(tree), ...s.expanded },
      ...(rejoined || null),
    }), () => {
      // NOT ON A LIVE ONE, which is what keeps the camera across a rebuild
      // arriving under the pointer: `home` is the frame the library FITTED, and
      // such a reload comes with the reader's own frame already restored, so
      // re-reading it here would record that instead and leave Fit doing nothing.
      //
      // OPENING ANOTHER BUILD IS THE EXCEPTION, and `_refit` is the two places
      // that do it saying so: `switchBuild`, where the reader picks a revision,
      // and `takePending`, where they accept the banner's newer one. Both travel
      // the same live path — the frame is carried over deliberately — but what
      // the camera is now pointed at is a DIFFERENT BUILD, and Fit promises
      // "back to the frame this view opened in" (the button's own tooltip). A
      // `home` left alone would go on meaning the build this PAGE opened first,
      // three revisions ago, with nothing about the button saying so.
      //
      // Clearing `home` was the alternative and is worse — Fit would then say
      // there is nothing to fit to, on a page with a model on it.
      //
      // SPENT HERE rather than at either setter, exactly like `carry`: one model
      // event acts on a swap, and the event after a swap whose view never
      // rendered simply does not arrive — so the next live build takes the flag
      // instead, which is another build opening and the same operation.
      if (!d.live || this._refit) this.captureHome();
      this._refit = false;
      // The rejoined ids have to reach the viewport, and a state event is the
      // only way there. Only when something was rejoined: every other model
      // event would otherwise dispatch one for no change at all.
      if (rejoined) this.sync();
    });
  }

  /**
   * A view would not render. Block 11: a page that shows nothing has to say why,
   * because a silent viewport leaves this interface drawing a frame around a
   * hole.
   *
   * `setState` AND NOT `set()`, and that is load-bearing rather than a
   * shorthand: `set()` ends in `sync()`, which dispatches `hmr:state`, which is
   * what the viewport decides a load on. Reporting a failed load through it
   * would answer the report with another attempt at the same fetch — forever, at
   * whatever rate the errors come back. The viewport keeps its own half of this
   * (`loadFailed` in viewport/element.js); this is the other half, and neither
   * one alone is enough.
   *
   * AND THE TREE GOES WHEN THE FAILURE IS A SWAP'S, which is the answer to a
   * question `leaveBuild` deliberately does not settle. Everything on that list
   * is dropped at the swap; the tree is not, because it is REPLACED rather than
   * dropped — `onModel` puts the new one in when the view lands. That holds for
   * every swap that works, and it is why clearing the tree in `leaveBuild` would
   * be the wrong price: the panel would blink empty on every successful
   * switch, for the sake of the rare one that fails.
   *
   * When the view does NOT land, though, no `onModel` ever arrives, and the page
   * is left half moved: `meta`, the title, the picker and `PAGE.base` are the
   * new build's while the panel on the left lists the parts of the old one.
   * Nothing about it looks wrong — the rows are real part names — but
   * `authorNote` then looks those names up in the NEW build's `meta.notes`, and
   * every row's menu builds its download links on the NEW base. So the tree is
   * cleared here, on the error path, where the failure is known.
   *
   * `_refit` IS THE QUESTION "did a swap's model never arrive". It is set by
   * `leaveBuild` and spent by `onModel`, so it is true exactly between another
   * build opening and its geometry landing — an error inside that window is an
   * error about a build the tree does not describe. It is NOT spent here: a
   * Retry that works is still the first model event of that swap, and Fit still
   * has to be re-homed on it.
   */
  onViewError(detail) {
    this.setState({
      viewError: (detail && detail.message) || 'the viewport could not render this view',
      ...(this._refit ? { tree: null } : null),
    });
  }

  /**
   * Which nodes start open.
   *
   * Everything, on the assemblies people actually look at. The ceiling is there
   * because the brief asks for the hundred-part case too, and a hundred rows
   * opened over the model is the tree covering the thing it describes.
   */
  defaultExpanded(tree) {
    const open = {};
    const all = tree.nodes.size <= 200;
    tree.nodes.forEach((node) => {
      if (node.isNode && (all || node.depth === 0)) open[node.id] = true;
    });
    return open;
  }

  node(id) {
    const tree = this.state.tree;
    return id && tree ? tree.nodes.get(id) || null : null;
  }

  // -- the one place the interface writes to the viewport -------------------
  sync(extra) {
    const s = this.state;
    const meta = s.meta;
    const pins = s.comments
      .filter((c) => c.pin)
      .map((c) => ({ id: c.id, label: c.label, p: c.pin, resolved: c.resolved,
                     active: s.activePin === c.id }));
    if (s.composer && s.composer.p) {
      pins.push({ id: 'draft', label: '+', p: s.composer.p, active: true });
    }
    window.dispatchEvent(new CustomEvent(STATE, {
      detail: {
        // Where the geometry is and which of it to show. `views` is meta.json's
        // own list, passed through rather than reshaped: the viewport reads `id`
        // and `file` off it, which is exactly what src/render.py writes.
        base: PAGE.base,
        views: (meta && meta.variants) || [],
        view: s.view,
        // What makes one build different from the last. The viewport uses it to
        // tell a LIVE RELOAD (same view, new geometry — keep the frame) from a
        // first load, and this side computes it because this side reads
        // meta.json.
        buildKey: buildKey(meta),

        hidden: s.hidden, ghost: s.ghost, selected: s.sel,
        cut: s.secOn, cutOffset: s.secOff, cutFlip: s.secFlip, tool: s.tool,
        // `single` is the only mode this can be in today: `diff` asks the
        // viewport to ghost both revisions and light up the difference, and
        // there is no difference to light up until the hub can compute one.
        mode: 'single', diffShow: s.diffShow, pins,
        ...(extra || {}),
      },
    }));
  }

  set(patch, extra) { this.setState(patch, () => this.sync(extra)); }

  /**
   * The READER changing which parts they can see — the one door for it, and the
   * only thing that writes `hidden` or `ghost` outside a build arriving.
   *
   * IT EXISTS TO CANCEL THE CARRY, and a plain `set` is exactly what it replaces
   * at six call sites: the eye, the ghost square, Isolate, Hide, Translucent and
   * "show all parts". `this.carry` is a SNAPSHOT of those two lists, taken when
   * another build opens (`leaveBuild`) and spent by the model event that lands
   * it (`rejoin`) — and between those two moments the reader can still change
   * them. Every edit made in that window is an edit the snapshot does not know
   * about, so the snapshot has to go.
   *
   * THE WINDOW IS NOT THEORETICAL AND IT IS WHERE THE SNAPSHOT IS ALL THERE IS.
   * `leaveBuild` keeps the carry rather than recomputing it when there is no
   * tree, which is what makes a swap whose view never rendered survivable — and
   * the three buttons above the tree, "show all parts" among them, are rendered
   * OUTSIDE the `hasTree` branch, so they are live in exactly that state. Hide a
   * part, swap, watch the view fail, press "show all parts", open another build:
   * without this the part came back HIDDEN, resurrected by a snapshot taken
   * before the reader unhid it — the mirror of the defect the keeping was added
   * to fix, and just as invisible.
   *
   * `null` RATHER THAN A RECOMPUTE, because there may be no tree to recompute
   * from; and it costs nothing where there is one, since the next `leaveBuild`
   * writes a fresh snapshot on its way out.
   *
   * Hiding those buttons when the tree is gone would be reasonable on its own
   * and is not a substitute: a button nobody can press does not make a stale
   * snapshot fresh, and the tree comes back — on a Retry that works — with the
   * snapshot still standing.
   */
  setVisibility(patch, extra) {
    this.carry = null;
    this.set(patch, extra);
  }

  toast(msg) {
    clearTimeout(this._tt);
    this.setState({ toast: msg });
    this._tt = setTimeout(() => this.setState({ toast: null }), 2600);
  }

  // -- the viewport's imperative half ---------------------------------------
  // Questions and one-shot commands rather than state, so they are method calls
  // rather than events: a comment needs the frame and a PNG of it AT THE MOMENT
  // SEND IS PRESSED, and Fit has to work the second time it is pressed as well
  // as the first, which a field compared against its last applied value does
  // not.
  el() { return this.host.current; }

  captureHome() {
    const el = this.el();
    if (!el || typeof el.getCamera !== 'function') return;
    try {
      this.home = el.getCamera();
    } catch (error) {
      console.warn('camera', error);
    }
  }

  fitView() {
    const el = this.el();
    if (!el || !this.home || typeof el.setCamera !== 'function') {
      this.toast('Nothing to fit to yet');
      return;
    }
    el.setCamera(this.home);
  }

  frameBlob() {
    const el = this.el();
    if (!el || typeof el.snapshot !== 'function') return Promise.resolve(null);
    return Promise.resolve(el.snapshot('hammerola')).catch((error) => {
      console.warn('snapshot', error);
      return null;
    });
  }

  frameCamera() {
    const el = this.el();
    if (!el || typeof el.getCamera !== 'function') return null;
    try {
      return el.getCamera();
    } catch (error) {
      console.warn('camera', error);
      return null;
    }
  }

  async saveFrame() {
    const blob = await this.frameBlob();
    if (!blob) { this.toast('The viewport has no frame to save yet'); return; }
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${this.state.meta.project}-${shortId(this.state.meta.commit)}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) {
      console.warn('frame', error);
      this.toast('Could not save the frame');
    }
  }

  /**
   * Light or dark under the model — remembered, and applied to the live scene.
   *
   * THE CHROME DOES NOT MOVE. Everything this interface draws stays light in
   * both modes; what changes is the canvas, which is the library's and which is
   * the whole of what looked out of place. `theme` is the library's own word for
   * it and carries more than the background — the grid and the orientation
   * marker are tinted with it — but both of those are off in this viewport
   * (viewport/options.js), so on this page it IS the background.
   *
   * WHY IT GOES THROUGH `viewer` AND NOT THROUGH THE ELEMENT. This is the one
   * place this file reaches past the element's imperative half, and it is worth
   * saying why rather than tidying later. The library resolves the theme once,
   * at construction, into its own state, and re-asserts THAT value at the end of
   * every render — so setting the attribute from outside, or changing the option
   * object, holds only until the next view switch. `setTheme` is the library's
   * public answer to exactly this and keeps its state in step; the element has no
   * method to forward it, and adding one is not this change's file to edit.
   *
   * Guarded end to end, because every step of it is allowed to be missing: no
   * adapter on the page, a viewport that has not rendered yet, an older library.
   * The setting is still stored, and the next page load comes up in it.
   */
  applyTheme(value) {
    const theme = writeTheme(value);
    this.setState({ theme });
    try {
      const el = this.el();
      const viewer = el && el.viewer;
      if (viewer && typeof viewer.setTheme === 'function') viewer.setTheme(theme);
    } catch (error) {
      console.warn('theme', error);
    }
  }

  // -- has a newer build landed while we were looking at this one? ----------
  // The only one of the brief's three build questions (block 11) with a source
  // today: `building` and `failed` need the job status endpoint that comes with
  // plan step 5. And it never swaps the model by itself — somebody in the middle
  // of a section with half the tree hidden reads a model that changed under them
  // as a breakage.
  schedulePoll(delay) {
    if (!isPointerPage() || this._gone) return;
    clearTimeout(this._poll);
    this._poll = setTimeout(() => this.poll(), delay);
  }

  async poll() {
    if (this._gone) return;
    // WHICH POLL THIS IS, and the reason it has to be asked. `loadMeta` builds
    // its URL out of `PAGE.base` at the moment of the call and this then waits on
    // the network; a revision switch inside that window moves `PAGE`, the build
    // on screen and the road this page is on, and the answer that lands is about
    // none of them. Compared against the NEW build's key it differs, so it is
    // offered as a newer build — on a pinned revision, which has nothing to offer
    // at all — and taking that offer puts one build's `views` in state beside
    // another build's `base`, i.e. the viewport fetching geometry at an address
    // that belongs to neither. `switchBuild` moves this number; a poll that wakes
    // up on the wrong side of that is thrown away whole, re-arming included,
    // because the swap armed the next one for the slot it moved to.
    const gen = this._pollGen = (this._pollGen || 0) + 1;
    let delay = POLL_MS;
    try {
      if (document.visibilityState !== 'hidden') {
        // Named rather than left to the default, so the request and the
        // comparison below are visibly about the same build.
        const base = PAGE.base;
        const next = await loadMeta(true, base);
        if (this._gone || gen !== this._pollGen) return;
        const key = buildKey(next);
        if (key && key !== buildKey(this.state.meta)
            && Array.isArray(next.variants) && next.variants.length) {
          // `bannerGone` is lifted only for a build this page has not offered
          // yet. The same build is seen again on every poll for as long as
          // nobody takes it, so clearing the flag unconditionally would put the
          // banner back three seconds after Later took it down and leave that
          // button meaning nothing at all.
          const offered = key === buildKey(this.state.pending);
          this.setState({ pending: next, ...(offered ? null : { bannerGone: false }) });
        }
      }
    } catch (error) {
      // A hub that is down — a deploy, most likely — must not be hammered at
      // full rate by every tab anyone left open.
      delay = Math.min(POLL_MAX_MS, (this._pollDelay || POLL_MS) * 2);
      console.warn('poll', error);
    }
    this._pollDelay = delay;
    this.schedulePoll(delay);
  }

  /** Take the build the banner is offering, keeping the frame and the tree.
   *
   * NOT WHILE THE VIEWPORT IS IN THE READER'S HANDS. `isBusy()` is the one
   * question the viewport can answer and this side cannot — a drag in progress,
   * and the moment just after one — and the swap it guards is the whole scene
   * being rebuilt under the pointer. The wait is bounded (BUSY_WAIT_MS above);
   * `since` is how a retry tells this call when the reader pressed the button,
   * and nothing else passes it.
   *
   * AND NOT WHILE A REVISION PICKED FROM THE PICKER IS ON THE WIRE. `swapping`
   * is that window, and the refusal is HERE rather than in the click handler
   * because more than one thing reaches this method: the banner's click, the
   * deferred retry it arms itself, and whatever is added next. `switchBuild`
   * disarms the deferred one by hand and used to stop there — but a direct press
   * needs no busy viewport and no timer at all, so it lands in the middle of the
   * await and runs the whole swap: `meta` replaced, geometry fetched, "Now
   * viewing …" toasted, and then the revision that was actually asked for
   * arriving on top of it. Guarding the one handler would leave the method as
   * the thing anybody can still call wrongly.
   *
   * NOTHING IS PUT AWAY BY THE REFUSAL — not `pending`, not `bannerGone` —
   * because the offer has not been answered, only postponed by a few hundred
   * milliseconds of network. A swap that then 404s leaves the banner exactly as
   * it stands and `swapFailed` lowers the flag; the reader presses Switch again
   * and it works.
   */
  takePending(since) {
    const next = this.state.pending;
    if (this._gone || this.state.swapping) return;
    if (!next || !Array.isArray(next.variants) || !next.variants.length) return;
    // At most one wait at a time: a second press must not leave two timers
    // racing to swap the same build.
    clearTimeout(this._swap);
    const asked = since || Date.now();
    let busy = false;
    try {
      const el = this.el();
      busy = !!(el && typeof el.isBusy === 'function' && el.isBusy());
    } catch (error) {
      // A viewport that cannot answer is not a reason to refuse the build.
      console.warn('viewport busy', error);
    }
    if (busy && Date.now() - asked < BUSY_WAIT_MS) {
      // `pending` is left standing, so the banner stays up and Switch keeps its
      // meaning while the wait runs. The TIMER, meanwhile, is owned by exactly
      // three other places, and all of them cancel it rather than letting it
      // arrive: `componentWillUnmount` (it would come back on a component that
      // is gone), `dismissPending` (Later is an answer, and a swap that
      // happened a quarter of a second after it would be this page overruling
      // the reader) and `switchBuild` (the reader picked a revision instead, and
      // this wait is shorter than the fetch that swap makes).
      this._swap = setTimeout(() => this.takePending(asked), BUSY_RETRY_MS);
      return;
    }
    const keep = next.variants.some((v) => v.id === this.state.view);
    // THE SAME LIST AS A REVISION SWITCH, through the same method, because this
    // IS a revision switch: another commit, built from other sources, with a
    // bounding box of its own. `leaveBuild` carries the whole of it — the pins
    // and the draft's anchor, the selection, the section plane, the names behind
    // the hidden parts, and the re-fit Fit needs because the frame it goes back
    // to was measured on the build that just left.
    //
    // CALLED HERE rather than at the top of the method, for the reason `_refit`
    // used to be set here on its own: the busy branch above returns having
    // swapped nothing, and everything `leaveBuild` does would then be spent on a
    // build nobody opened — the reader's draft emptied and their section put
    // away over a swap that did not happen.
    //
    // Below that branch and above the `setState` its answer is spread into: that
    // is the whole of what fixes the position, here as in `switchBuild`, where
    // the same sentence used to claim a dependency on `meta` that does not
    // exist.
    const gone = this.leaveBuild(keep);
    this.setState({
      meta: next,
      view: keep ? this.state.view : next.variants[0].id,
      ...gone.state,
      // TAKEN, which is why this is the caller's line and not `leaveBuild`'s:
      // the offer was answered by accepting it, so the banner goes for good
      // rather than being left ready for the next build to arrive.
      bannerGone: true,
    }, () => {
      // A changed `buildKey` under the same `view` is what the viewport reads as
      // a live reload: it captures the camera, the visibility and the section,
      // renders the new geometry and puts them all back. Nothing here has to
      // arrange that beyond sending the new numbers.
      this.sync(gone.extra);
      this.toast(`Now viewing ${shortId(next.commit)} — your frame and tree are kept`);
    });
  }

  /** Later: this build is not wanted now.
   *
   * IT HAS TO CANCEL THE WAIT, and that is the whole of why this is a method
   * rather than a `setState` at the call site. Switch defers while the reader's
   * hand is on the model (`takePending` above), and hiding the banner does not
   * reach the timer that deferral left running — so a reader who pressed Switch,
   * saw nothing happen and pressed Later got the swap anyway, a quarter of a
   * second after refusing it. On a real prototype, with fake timers: `after
   * Later: meta = abc, pending = null`.
   *
   * THE OFFER ITSELF IS KEPT on `pending` and only the banner goes, so nothing
   * is lost and `poll` has something to compare against: it lifts `bannerGone`
   * for a build this page has not offered yet and leaves it standing for the one
   * that was just refused. Dismissing a build therefore lasts until a NEWER one
   * lands, rather than until the next poll three seconds later — which would
   * make this button a no-op that looks like a broken one.
   */
  dismissPending() {
    clearTimeout(this._swap);
    this.setState({ bannerGone: true });
  }

  // -- measurements ---------------------------------------------------------
  /**
   * One measurement, with the qualifier the brief (block 7) insists on.
   *
   * The viewport reports two facts about every answer: whether it spans two
   * different parts, and whether anything has been dragged. Inside one part — a
   * wall thickness, a hole, an edge — no arrangement of the assembly can make
   * the number wrong. BETWEEN parts it is a distance between where they are
   * standing right now, which on a print bed, or after a drag, is not where they
   * are in the assembly. These numbers travel to an agent as a task, so that
   * cannot be handed over silently.
   */
  measureLabel(a) {
    const unit = a.kind === 'area' ? 'mm²' : a.kind === 'volume' ? 'mm³' : 'mm';
    const value = `${a.approximate ? '≈' : ''}${Number(a.value).toFixed(2)} ${unit}`;
    const text = a.kind === 'distance' ? value : `${a.kind} ${value}`;
    const laidOut = a.moved || this.state.view !== ASSEMBLED_VIEW_ID;
    const note = a.crossPart && laidOut ? 'as the parts stand in this view' : '';
    return { text, note, full: note ? `${text} · ${note}` : text };
  }

  // -- comments -------------------------------------------------------------
  async sendComment() {
    const c = this.state.composer;
    const meta = this.state.meta;
    if (!c || !meta) return;
    // Refused here rather than only by the hub, since step 0 put the write
    // behind the token. Not a security check — the hub's is — but the difference
    // between "you are not signed in" and a 401 arriving after the photo has
    // been uploaded and the frame grabbed. The composer cannot normally be open
    // without a token, because clearing one closes it; what this covers is the
    // token going away between opening the composer and pressing Send.
    if (this.viewer()) { this.toast('Add the token to comment'); return; }
    const text = (c.text || '').trim();
    if (!text) { this.toast('Write something first'); return; }

    // The hub's comment schema is closed — src/comments.py keeps `text`, `view`,
    // `part`, `point` and `camera` and DROPS everything else without saying so —
    // so the measurement and the drag ride in the text, where the agent will
    // actually read them, rather than in fields discarded on the way in.
    const extra = [];
    if (c.meas) extra.push(`measured: ${c.meas}`);
    if (c.move) extra.push(`moved: ${c.move} (temporary, not in the model)`);

    const form = new FormData();
    form.append('comment', JSON.stringify({
      text: extra.length ? `${text}\n\n${extra.join('\n')}` : text,
      view: this.state.view,
      part: c.partId || null,
      point: c.p || null,
      camera: this.frameCamera(),
    }));
    if (c.photo) form.append('photo', c.photo, 'photo');
    const shot = await this.frameBlob();
    if (shot) form.append('shot', shot, 'shot.png');

    // Required by the hub since step 0, and checked there before the body is
    // parsed at all — so this header is what makes the request a comment rather
    // than a 401.
    const headers = { Authorization: `Bearer ${this.state.token}` };

    let response = null;
    try {
      response = await fetch(`/api/v1/comments/${PAGE.pid}/${meta.commit}`,
                             { method: 'POST', body: form, headers });
    } catch (error) {
      console.error('comment', error);
      this.toast('Could not reach the hub');
      return;
    }
    if (response.status !== 201) {
      // Fixed sentences rather than the hub's own message: nothing on this page
      // should be in the habit of putting a response body on the screen.
      const said = {
        401: 'The hub refused the token',
        404: 'This build is no longer available',
        413: 'Too large — try a smaller photo',
        422: 'The hub refused this comment. Is the photo a JPEG, PNG or WebP?',
        429: 'Too many comments from here. Try again in a few minutes.',
      }[response.status];
      this.toast(said || 'Could not send the comment');
      return;
    }

    let id = `local-${Date.now()}`;
    try {
      const body = await response.json();
      if (body && typeof body.id === 'string') id = body.id;
    } catch (error) {
      console.warn('comment id', error);
    }
    this.set({
      comments: this.state.comments.concat({
        id, label: String(this.state.comments.length + 1),
        part: c.part, partId: c.partId, pin: c.p, text,
        time: 'just now', resolved: false, meas: c.meas || null,
      }),
      composer: null,
      moved: c.move ? null : this.state.moved,
      rail: true,
    }, c.move ? { __resetMove: true } : null);
    this.toast('Sent to the agent — a rebuild will follow');
  }

  /**
   * Close an item in the queue.
   *
   * A real request since step 0: `POST /api/v1/comments/<id>/resolve` takes the
   * same EDIT_TOKEN this page is already holding, so what used to be a toast
   * saying it could not be a button here IS one. Body-less on purpose — the
   * route reads an optional `note` out of one, and a note is the agent's word
   * about what it did, not the reader's.
   *
   * `local-` is the id `sendComment` falls back to when the hub's 201 could not
   * be parsed. The comment is really in the queue at that point and this page
   * simply does not know its name, so the row is marked resolved LOCALLY and
   * says as much: pretending it reached the hub would be worse than admitting
   * this one has to be closed from the agent's side.
   */
  async resolveComment(id) {
    if (!id || this.viewer()) return;
    const mark = () => this.setState({
      comments: this.state.comments.map(
        (c) => (c.id === id ? { ...c, resolved: true } : c)),
    });
    if (String(id).startsWith('local-')) {
      mark();
      this.toast('Marked here only — this one has no id the hub answers to');
      return;
    }
    let response = null;
    try {
      response = await fetch(`/api/v1/comments/${encodeURIComponent(id)}/resolve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.state.token}` },
      });
    } catch (error) {
      console.error('resolve', error);
      this.toast('Could not reach the hub');
      return;
    }
    if (response.status !== 200) {
      this.toast(response.status === 401
        ? 'The hub refused the token'
        : 'Could not mark it processed');
      return;
    }
    mark();
    this.toast('Marked processed');
  }

  // -- helpers --------------------------------------------------------------
  toggle(list, ids) {
    const set = new Set(list);
    const anyOn = ids.some((id) => set.has(id));
    ids.forEach((id) => { if (anyOn) set.delete(id); else set.add(id); });
    return Array.from(set);
  }

  saveNotes(notes) {
    writeNotes(PAGE.pid, notes);
    this.setState({ notes });
  }

  /** Every file of one format, handed over one at a time.
   *
   * A method rather than a call written straight into the handler, so a test can
   * take it over and read WHICH hrefs the button would fire, in what order,
   * without a jsdom anchor navigating anywhere. The mechanism itself is
   * `sequentialDownload`, which is tested on its own with a fake clock; `options`
   * is the seam that lets the same fake clock reach it THROUGH this method, which
   * is what a claim about cancelling a chain the page started has to go through.
   *
   * ONE SIGNAL FOR THE WHOLE PAGE, not one per press. Two group links pressed in
   * a row leave two chains stepping at once — thirty files is six seconds, so
   * that is an ordinary sequence rather than a race — and both of them are about
   * the build the reader was on, so both have to end together. A controller per
   * chain would need a list to hold them and nothing to prune it, since a chain
   * that finished says nothing; one controller is bounded, and the next press
   * after a cancel gets a fresh one from `cancelDownloads`.
   */
  downloadAll(hrefs, options) {
    if (!this._dl) this._dl = new AbortController();
    return sequentialDownload(hrefs, { ...(options || null), signal: this._dl.signal });
  }

  /** Stop handing over files: the addresses in the chain stopped describing
   * what is on the screen.
   *
   * Called by `switchBuild` and by `componentWillUnmount`, which are the two
   * moments this page's ADDRESS goes away — the hrefs are `PAGE.base` plus a
   * file name (`fileHref`), so those are the two moments they stop resolving to
   * what the reader asked for.
   *
   * `takePending` IS NOT ONE OF THEM, deliberately, and it once was: the banner
   * moves `meta` and leaves `PAGE.base` where it is, so a chain running across
   * it goes on fetching from the pointer — which is the same address the reader
   * pressed the button on. Cutting it there truncated group downloads (three
   * STLs of ten, no message) over a gesture that changed no href, and left the
   * asymmetry that gives the game away: Later does not cancel anything, and it
   * is the same page, the same chain and the same pointer.
   */
  cancelDownloads() {
    if (this._dl) this._dl.abort();
    this._dl = null;
  }

  subtitle() {
    const meta = this.state.meta;
    const current = meta.variants.find((v) => v.id === this.state.view) || meta.variants[0];
    const total = meta.variants.reduce((sum, v) => sum + Number(v.gzip || 0), 0);
    const views = meta.variants.length === 1 ? '1 view' : `${meta.variants.length} views`;
    return `${current.parts} parts · ${views} · ${mb(total)}`;
  }

  /**
   * A right-click in the SCENE, opening the same menu a tree row's does.
   *
   * `setState` and not `set`: the menu is a thing on the page, not a thing about
   * the model, so the viewport is told nothing.
   *
   * IT DOES NOT TOUCH `sel` / `selName`, which is the decision worth defending
   * here: a tree row's menu leaves the selection alone, and a menu that meant
   * "look at this" from one door and "select this and look at it" from the other
   * is worse than either. So the part under the cursor gets a menu and the
   * reader's selection stays where they put it.
   *
   * NO ID IS EMPTY SPACE, and it CLOSES the menu rather than opening one about
   * the view: there are no view-level items to put in it today, and a menu with
   * one greyed-out sentence in it is not better than no menu.
   *
   * A method rather than a closure inside the handler map so it can be called
   * without mounting the component — the map is built in `componentDidMount`,
   * which loads a build and starts a poll.
   */
  sceneMenu(detail) {
    const d = detail || {};
    const id = d.id || null;
    this.setState({ menu: id ? { id, ...menuAt(d.x, d.y) } : null });
  }

  /** A note hangs on a part NAME, so a group row has none of its own. */
  selectedName() {
    const node = this.node(this.state.sel);
    if (node) return node.isNode ? '' : node.name;
    return this.state.selName || '';
  }

  /** The READER's note: this browser's, for this project, never sent anywhere.
   *
   * Through `noteFor` like both other reads of a note map: this one is parsed out
   * of localStorage, which is no more this code's own object than a fetched
   * document is.
   */
  selectedNote() {
    return noteFor(this.state.notes, this.selectedName());
  }

  /**
   * The AUTHOR's note on the selected part — `model.py`, published in this
   * build's meta.json under the same part NAME the reader's notes use.
   *
   * ABSENT IS NORMAL. A build with nothing to say carries no `notes` key at all,
   * and neither does any build published before the key existed; the two are one
   * document here, and asking about one of them must not be an error — which is
   * also `noteFor`'s answer to a map that is missing altogether.
   *
   * Through `noteFor` because a part name is not a safe key: see its own note for
   * what a part called `constructor` does to a bare lookup.
   */
  authorNote() {
    return noteFor(this.state.meta && this.state.meta.notes, this.selectedName());
  }

  /**
   * Switch views.
   *
   * One field, and the viewport does the rest: a changed `view` is a different
   * arrangement of the same parts, with its own extent and orientation, so it is
   * fetched and shown whole rather than under the old camera (brief, block 2).
   */
  showView(id) {
    if (id === this.state.view) return;
    this.set({ view: id });
  }

  /**
   * Ask the viewport for this view again — the button in block 11's panel.
   *
   * THE ONLY WAY BACK from a view that did not render, and it had to be added
   * rather than found: the viewport remembers a failed load so that the state
   * event this interface sends on every click does not re-fetch a missing file
   * forever (viewport/element.js, `loadFailed`), and nothing on this page could
   * clear that memory. Choosing a revision is a whole navigation, `showView`
   * returns immediately when the id is the one already chosen, and the panel
   * itself was text with nothing to press — so on a build with a single view a
   * blip in the network was a dead end until somebody thought to reload the page.
   *
   * `__retry` and not a method call on the element, because it IS a one-shot
   * command and the element already takes three of those the same way
   * (`__resetMove`, `__resetCut`, `__clearMeasure`): it rides the one state
   * event, is acted on, and is deleted rather than left standing in a field.
   *
   * `viewError` is cleared here so the panel goes while the fetch runs. Nothing
   * else has to put it back — a second failure emits `hmr:error` again, and a
   * success clears it through the model handler.
   */
  retryView() {
    this.set({ viewError: null }, { __retry: true });
  }

  /** All derived values and handlers. render() below only lays them out. */
  computed() {
    const s = this.state;
    const tree = s.tree;
    const meta = s.meta;
    const viewer = this.viewer();
    const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };
    const hiddenSet = new Set(s.hidden);
    const ghostSet = new Set(s.ghost);

    // -- the tree: a flat list of rows, indented by depth
    const rows = [];
    const eyeOuter = (st) => 'width:15px;height:10px;border:1.5px solid ' + (st === 'off' ? '#c3c8cf' : '#4a5057') + ';border-radius:50%;display:flex;align-items:center;justify-content:center';
    const eyeDot = (st) => 'width:5px;height:5px;border-radius:3px;' + (st === 'on' ? 'background:#4a5057' : st === 'part' ? 'background:linear-gradient(90deg,#4a5057 50%,#c3c8cf 50%)' : 'background:transparent');
    const ghostIcon = (on) => 'width:11px;height:11px;border-radius:3px;' + (on ? 'background:linear-gradient(135deg,#4a5057 50%,rgba(74,80,87,.2) 50%);border:1px solid #4a5057' : 'border:1px solid #b6bcc4;background:linear-gradient(135deg,rgba(182,188,196,.5) 50%,transparent 50%)');

    const emit = (node) => {
      const expanded = !!s.expanded[node.id];
      const visible = node.leaves.filter((id) => !hiddenSet.has(id)).length;
      const eye = visible === 0 ? 'off' : visible === node.leaves.length ? 'on' : 'part';
      const ghosted = node.leaves.length > 0 && node.leaves.every((id) => ghostSet.has(id));
      const selected = s.sel === node.id;
      const meta_ = node.isNode
        ? (eye === 'part' ? `${visible}/${node.leaves.length}` : String(node.leaves.length))
        : (node.known ? '' : '?');
      rows.push({
        key: node.id,
        rowStyle: 'display:inline-flex;align-items:center;gap:2px;height:24px;padding:0 6px 0 3px;margin:0 0 1px ' + (node.depth * 16) + 'px;border-radius:4px;background:' + (selected ? '#cfe6fb' : 'rgba(255,255,255,.78)') + ';cursor:default',
        caret: node.isNode ? (expanded ? '▾' : '▸') : '',
        caretStyle: 'width:14px;flex:none;text-align:center;font-size:9px;color:#8a9099;cursor:pointer;' + (node.isNode ? '' : 'visibility:hidden'),
        onExpand: stop(() => node.isNode
          && this.setState({ expanded: { ...s.expanded, [node.id]: !expanded } })),
        eyeOuter: eyeOuter(eye), eyeDot: eyeDot(eye), ghostIcon: ghostIcon(ghosted),
        dotStyle: 'width:9px;height:9px;border-radius:3px;flex:none;margin:0 4px 0 2px;background:' + (node.color || 'transparent') + (node.isNode ? ';border:1px solid #c3c8cf;background:transparent' : ''),
        name: node.name,
        nameStyle: 'white-space:nowrap;cursor:pointer;padding-right:4px;font:' + (node.isNode ? '600 12px ' : '400 12px ') + MONO + ';color:' + (eye === 'off' ? '#9aa1a9' : '#2a2e33'),
        meta: meta_,
        // Said out loud rather than dropped: a leaf the viewport could not match
        // to the library's own state map is a row nothing can be done to, and a
        // tree missing a row reads as a build with fewer parts.
        metaTitle: node.isNode || node.known ? '' : 'the viewport does not know this part',
        metaStyle: `flex:none;font:400 10px ${MONO};color:#b0b6bd;padding:0 2px`,
        // A group toggles as a whole: anything still visible means hide it all,
        // nothing visible means show it all. Expressed in LEAF ids — see
        // hub.indexTree for why.
        // `setVisibility` and not `set`, here and at every other writer of these
        // two lists: it is what tells a swap's pending carry that the reader has
        // moved on. See the method.
        onVis: stop(() => this.setVisibility({ hidden: this.toggle(s.hidden, node.leaves) })),
        onGhost: stop(() => this.setVisibility({ ghost: this.toggle(s.ghost, node.leaves) })),
        onSelect: stop(() => this.set({ sel: node.id, selName: node.name })),
        // The other door into this menu is a right-click on the part in the
        // SCENE (`sceneMenu`), and the two share `menuAt` so they cannot open in
        // different places.
        onMenu: stop((e) => {
          e.preventDefault();
          this.setState({ menu: { id: node.id, ...menuAt(e.clientX, e.clientY) } });
        }),
      });
      if (node.isNode && expanded) node.children.forEach((id) => emit(tree.nodes.get(id)));
    };
    if (tree) tree.roots.forEach((id) => emit(tree.nodes.get(id)));

    const secSub = s.secOn
      ? `${s.secFace || 'plane'} · ${s.secOff >= 0 ? '+' : ''}${s.secOff.toFixed(1)} mm`
      : 'off';
    const secRange = Array.isArray(s.secRange) ? s.secRange : [-30, 30];

    // -- the revision picker, from builds.json
    const info = s.builds || { has_dev: false, latest: null, builds: [] };
    const history = Array.isArray(info.builds) ? info.builds : [];
    const revs = [];
    if (info.has_dev) {
      revs.push({ id: 'dev', head: 'POINTERS', badge: '→ local build',
                  date: '', pointer: true });
    }
    if (info.latest) {
      revs.push({ id: 'latest', head: info.has_dev ? '' : 'POINTERS',
                  badge: `→ ${shortId(info.latest)}`, date: '', pointer: true });
    }
    history.forEach((b, at) => revs.push({
      id: b.commit, head: at === 0 ? 'BUILDS' : '', badge: '',
      // THE TIME BELONGS HERE, and this is the list that changed its mind about
      // it. `day()` was written for a picker whose rows were CI commits — one or
      // two a day, so the clock was noise beside the date. Publishing is now
      // `hammerola build` from a laptop (issue #26), which an author runs
      // as often as they save; a column of identical `2026-08-27`s then tells a
      // reader nothing about the one thing this menu is for, which is choosing
      // between two of them. So the picker shows the same `stamp` the header
      // does — and shows it in the same shape, which is the second half of the
      // fix: the two were formatted differently while naming the same instant.
      date: stamp(b.built), pointer: false,
    }));

    const revRows = revs.map((r) => {
      const current = r.id === PAGE.slot;
      const inCmp = s.cmp.includes(r.id);
      return {
        key: r.id,
        head: r.head || '',
        headStyle: r.head ? `padding:7px 14px 3px;font:600 9.5px ${MONO};color:#9aa1a9;letter-spacing:.09em` : 'display:none',
        id: r.pointer ? r.id : shortId(r.id),
        date: r.date,
        idStyle: `font:600 12px ${MONO};color:` + (current ? '#1f6fd0' : r.pointer ? '#7c3aad' : '#2a2e33'),
        badge: current && !r.badge ? 'viewing' : r.badge,
        badgeStyle: `font:500 10.5px ${MONO};` + (r.pointer ? 'color:#8a9099' : (current || r.badge) ? 'padding:2px 6px;border-radius:4px;background:#e3effc;color:#1f6fd0' : 'display:none'),
        style: 'display:flex;align-items:center;gap:4px;padding:7px 14px 7px 10px;' + (current ? 'background:#f0f6fd;' : '') + 'cursor:default',
        cmpMark: inCmp ? '✓' : '',
        cmpStyle: `width:16px;height:16px;border-radius:4px;flex:none;margin-right:6px;display:flex;align-items:center;justify-content:center;font:600 10px ${MONO};cursor:pointer;` + (inCmp ? 'background:#1f7ae0;color:#fff;border:1px solid #1c67c2' : 'border:1px solid #c3c8cf;background:#fff;color:transparent'),
        onCmp: stop(() => {
          let picked = s.cmp.includes(r.id) ? s.cmp.filter((x) => x !== r.id) : s.cmp.concat(r.id);
          if (picked.length > 2) picked = picked.slice(-2);
          this.setState({ cmp: picked });
        }),
        // A build is an ADDRESS, so switching to one is a navigation and not a
        // state change: the URL is the thing that has to keep saying which
        // geometry this is, a year from now, to whoever the link was sent to.
        //
        // THAT IS A SENTENCE ABOUT THE ADDRESS BAR, NOT ABOUT THE DOCUMENT, and
        // reading it as a refusal is what kept this a full page load. There is
        // no wall here: `history.pushState` satisfies every word of it — the URL
        // changes, the link copies and opens exactly as it did, and the page the
        // hub renders at that address on its own is untouched — while the reader
        // keeps the camera, the hidden parts and the section they set up in
        // order to compare two builds (issue #62). Which is the whole
        // point: those get thrown away at precisely the moment they are worth
        // the most. `switchBuild` is where it happens, and a different PROJECT
        // is still a real navigation, because there everything changes at once.
        onPick: stop(() => {
          this.switchBuild(PAGE.pid, r.id)
            .catch((error) => console.error('switch', error));
        }),
      };
    });
    const cmpReady = s.cmp.length === 2;

    // -- the downloads, from meta.downloads: label -> file name
    const fileHref = (file) => PAGE.base + encodeURIComponent(String(file));
    const dlRowStyle = `display:flex;align-items:center;gap:10px;padding:6px 14px 6px 22px;text-decoration:none;color:#2a2e33;font:400 12px ${SANS}`;
    const downloadGroups = groupDownloads(meta && meta.downloads).map((g) => ({
      key: g.ext,
      ext: g.ext,
      files: g.files.map((f) => ({
        key: f.file, label: f.label, file: f.file, href: fileHref(f.file),
        style: dlRowStyle,
      })),
      headStyle: `display:flex;align-items:center;gap:8px;padding:8px 14px 3px;font:600 10px ${MONO};color:#8a9099;letter-spacing:.08em`,
      allStyle: `cursor:pointer;font:500 10.5px ${MONO};color:#1f6fd0;text-decoration:underline`,
      // ONE CLICK, N DOWNLOADS, DONE IN THE BROWSER — the owner's decision, and
      // the cost is worth stating rather than discovering. A browser does not
      // block the second file and the ones after it; it ASKS, once, with a
      // per-site permission it then remembers (the note further down, on the
      // tree row's group, is where that correction is written out). So for a
      // PERSON this is one prompt and then nothing. For an agent driving the
      // page there is nobody to answer that prompt, which is why an agent takes
      // `hammerola artifacts` instead and why this is not the hub's job: no
      // route, no archive, no client change.
      //
      // No `stop()`: the click bubbles to `rootClick` and closes the menu, which
      // is exactly what a file row beside it already does by being a plain link.
      onAll: () => this.downloadAll(g.files.map((f) => fileHref(f.file))),
    }));
    const anyDownloads = downloadGroups.length > 0;
    // The same files, cut up by part, for the row menu below.
    const partFiles = filesByPart(meta && meta.downloads);

    const threads = s.comments.map((c) => ({
      key: c.id, label: c.label, part: c.part, time: c.time, text: c.text, meas: c.meas,
      style: 'padding:10px 12px;background:#fff;border:1px solid ' + (s.activePin === c.id ? '#9cc4f0' : '#e3e6ea') + ';border-radius:8px;cursor:pointer;' + (c.resolved ? 'opacity:.62' : ''),
      pinStyle: `width:20px;height:20px;border-radius:10px 10px 10px 3px;flex:none;display:flex;align-items:center;justify-content:center;font:600 10.5px ${MONO};` + (c.resolved ? 'background:#e3e6ea;color:#8a9099' : 'background:#1f7ae0;color:#fff'),
      measStyle: c.meas ? `margin-top:6px;display:inline-flex;padding:3px 7px;background:#fdf0d8;border-radius:4px;font:500 10.5px ${MONO};color:#8a6a1f` : 'display:none',
      onOpen: stop(() => this.set({ activePin: c.id })),
      resolved: !!c.resolved,
      // A real request since step 0 — see resolveComment. Closing an item is
      // still mostly the agent's move; what changed is that the person who
      // raised it can now take it back without one.
      onResolve: stop(() => { if (!c.resolved) this.resolveComment(c.id); }),
    }));
    const openCount = s.comments.filter((c) => !c.resolved).length;

    // -- context menu on a tree row
    const mNode = this.node(s.menu && s.menu.id);
    const mName = mNode ? mNode.name : '';
    // Through `noteFor` like every other read of a note map. This one throws
    // EARLIEST of the three when it is not: the item below slices the note to 22
    // characters for its hint, and a part called `constructor` hands a bare
    // lookup a function, which has no `slice` — so the whole menu, and with it
    // `computed()` and the page, ends on a right-click.
    const note = noteFor(s.notes, mName);
    // `href` turns the row into a real `<a download>` — see the files block
    // below — and `tone` is 'top' for a rule above the row, 'said' for a row that
    // states something rather than doing it.
    //
    // A 'said' ROW GETS NO HANDLER AT ALL, which is what makes its `cursor:
    // default` and its grey true rather than a costume. It used to be styled
    // unclickable and then handed an `onClick` anyway — one that stopped the
    // event and closed the menu, i.e. a row that acted while saying it would
    // not. Without one the row is inert, which is exactly what it claims to be:
    // the click stops at the menu's own wrapper (which stops propagation so that
    // a press on the menu's padding does not close it through `rootClick`), and
    // the menu closes on the next click anywhere outside, as it always has.
    const mi = (label, hint, fn, tone, href) => ({
      key: label, label, hint: hint || '', href: href || '',
      style: `display:flex;align-items:center;gap:10px;padding:7px 14px;text-decoration:none;font:400 12px ${SANS};`
        + (tone === 'said' ? 'cursor:default;color:#8a9099' : 'cursor:pointer;color:#2a2e33')
        + (tone === 'top' || tone === 'said' ? ';border-top:1px solid #e3e6ea' : ''),
      onClick: tone === 'said'
        ? undefined
        : stop(() => { fn(); this.setState({ menu: null }); }),
    });

    /**
     * This part's files — the row-menu half of the header's Downloads menu.
     *
     * Three rows and not a submenu: one click cannot sensibly deliver three
     * files, this menu has no submenu machinery anywhere in it, and a row per
     * file is exactly what the header's menu already looks like — extension on
     * the left, filename on the right. Each one is a plain `<a href download>`
     * against the same base URL the header builds, so middle-click and "save
     * link as" work on it like any other link on the page.
     *
     * BOTH EMPTY CASES SAY SO OUT LOUD. A reference part — a tree node that is
     * not in `printables()` — has no files and never will, and a menu that
     * silently dropped the item would read as a menu that forgot. Same for a
     * build that ships nothing: the header's menu has a sentence for that case
     * and this one must not be worse.
     */
    const fileRows = (name) => {
      if (!anyDownloads) return [mi('No files in this build', '', () => {}, 'said')];
      const files = partFiles.get(name) || [];
      if (!files.length) return [mi('No files for this part', 'not a printable', () => {}, 'said')];
      return files.map((f, at) => mi(f.ext.toUpperCase(), f.file, () => {},
                                     at === 0 ? 'top' : '', fileHref(f.file)));
    };

    const menuItems = !mNode ? [] : [
      mi('Isolate', 'show only this', () => {
        const keep = new Set(mNode.leaves);
        this.setVisibility({ hidden: tree.leaves.filter((id) => !keep.has(id)),
                             sel: mNode.id, selName: mNode.name });
      }),
      mi('Hide', '', () => this.setVisibility({ hidden: this.toggle(s.hidden, mNode.leaves) })),
      mi('Translucent', 'see through it', () => this.setVisibility({ ghost: this.toggle(s.ghost, mNode.leaves) })),
      ...(viewer || mNode.isNode ? [] : [mi('Note', note ? (note.length > 22 ? `${note.slice(0, 22)}…` : note) : '',
        () => this.setState({ notePop: mNode.name, noteDraft: note || '' }))]),
      // Files hang on a PART, so a group row has none of its own — the same rule
      // and the same reason as the note above it. A group is not a printable and
      // never has files under its own name, so the union of its leaves' files is
      // a set this menu would be INVENTING; and bulk by the axis a reader
      // actually asks along — one format, all parts — is in the header's menu,
      // where each group has a "download all" of its own.
      //
      // THIS USED TO SAY BROWSERS BLOCK EVERY DOWNLOAD AFTER THE FIRST. They do
      // not — they ASK, once, with a per-site permission a person grants and the
      // browser then remembers. Corrected here rather than deleted because the
      // false version reads like a hard wall and was quoted onward as one: it
      // makes "hand out N files on one click" look impossible, when for a person
      // it costs one prompt. What it does still cost is anything driving the
      // page that cannot answer a prompt — an agent — and a file whose name the
      // page never chose. Those are the reasons to prefer one archive over N
      // links; "the browser refuses" is not one, because it does not.
      ...(mNode.isNode ? [] : fileRows(mNode.name)),
      mi('Copy name', '', () => {
        try {
          navigator.clipboard.writeText(mNode.name);
          this.toast(`copied: ${mNode.name}`);
        } catch (error) {
          console.warn('clipboard', error);
          this.toast('Could not copy the name');
        }
      }, 'top'),
    ];

    const btn = (active, hide) => `display:flex;align-items:center;gap:6px;padding:6px 11px;border-radius:6px;font:500 12px ${SANS};cursor:pointer;border:1px solid ` + (active ? '#9cc4f0;background:#dcebfc;color:#155bb5' : 'transparent;color:#3c4147') + (hide ? ';display:none' : '');
    const tab = (active) => `padding:5px 13px;border-radius:5px;font:500 12px ${SANS};cursor:pointer;` + (active ? 'background:#fff;color:#1c1f23;box-shadow:0 1px 2px rgba(0,0,0,.1)' : 'color:#5b6470');
    const chip = (show, bg, border, color) => 'pointer-events:auto;display:' + (show ? 'flex' : 'none') + `;align-items:center;gap:8px;padding:7px 12px;background:${bg};border:1px solid ${border};border-radius:7px;font:500 11.5px ${SANS};color:${color};box-shadow:0 2px 8px rgba(20,24,28,.08)`;

    const setTool = (t) => () => {
      this.set({ tool: s.tool === t ? null : t, revOpen: false, dlOpen: false, menu: null });
      if (t === 'comment' && s.tool !== 'comment') this.toast('Click a spot on the model to pin the task');
      if (t === 'measure' && s.tool !== 'measure') this.toast('Click a part for its size, or two for the gap between them');
      if (t === 'move' && s.tool !== 'move') this.toast('Drag a part — it snaps back on the next rebuild');
    };

    // Two of these are reachable today. `building` and `failed` need the job
    // status endpoint that arrives with plan step 5; the brief (block 11) asks
    // for all of them, and that step is what fills them in.
    const status = s.pending
      ? { text: 'new build ready', style: 'color:#1f6fd0;background:#e3effc;border:1px solid #bcd8f5', dot: '#1f7ae0' }
      : { text: isPointerPage() ? 'up to date' : 'pinned build', style: 'color:#5b6470;background:transparent;border:1px solid transparent', dot: '#2e9e44' };

    const railOpen = s.rail === null ? this.props.commentsOpen : s.rail;
    const cutOn = s.secOn || s.held;

    // Both notes on the part in front of the reader, read once: the box below
    // asks three questions of each of them (is it there, does the box open, does
    // a rule go between them) and a method call per question would let the two
    // halves of one box answer from two different reads.
    const authorNote = this.authorNote();
    const readerNote = this.selectedNote();

    return {
      rootClick: () => this.setState({ menu: null, revOpen: false, dlOpen: false, tokenPop: false }),

      title: (meta && (meta.title || meta.project)) || '',
      subtitle: meta ? this.subtitle() : '',
      // SHORTENED HERE TOO, and this was the one place it was not. `PAGE.slot`
      // is a path segment straight out of the URL, so on a pinned revision it is
      // the full digest of the sources — 64 characters, in a fixed-width header
      // row, next to a title and a status chip that then have nowhere to go. The
      // picker below this button has always drawn the same value at seven
      // (`shortId`), so the header was contradicting the menu it opens. A
      // pointer name passes through unchanged: `dev` is special-cased and
      // `latest` is shorter than the cut.
      slot: shortId(PAGE.slot),
      // The whole of it, for the reader who needs to copy one. A revision is
      // addressed by its full digest everywhere off this page — `hammerola
      // source <rev>`, a permanent URL — and the seven characters above cannot
      // be pasted anywhere. Empty when nothing was cut: a tooltip that repeats
      // the word under the cursor is noise, and `dev` and `latest` are shown
      // whole already.
      slotTitle: shortId(PAGE.slot) === PAGE.slot ? '' : PAGE.slot,
      // `latest` FOLLOWS COMMITS, and it used to say it followed CI. That was
      // true before the migration, when a Gitea workflow built every model; the
      // hub builds them now and `hammerola commit` is what moves this pointer,
      // so the old label named a machine that no longer touches this project.
      // `tests/test_ui_source.py` pins the retired string out of the tree —
      // it survived a cleanup that swept the page and the docs precisely
      // because it is computed inside a component, where nothing could point
      // at it.
      slotBadge: PAGE.slot === 'dev' ? 'auto-updates' : PAGE.slot === 'latest' ? 'follows commits' : 'pinned',
      slotDate: meta ? stamp(meta.built) : '',
      revToggle: stop(() => this.setState({ revOpen: !s.revOpen, dlOpen: false, tokenPop: false })),
      revBtnStyle: 'display:flex;align-items:center;gap:8px;padding:6px 11px;border:1px solid #d3d8de;background:#fff;border-radius:6px;cursor:pointer',
      revMenuStyle: 'position:absolute;left:0;top:40px;width:430px;background:#fff;border:1px solid #d3d8de;border-radius:9px;box-shadow:0 10px 34px rgba(20,24,28,.16);z-index:40;display:' + (s.revOpen ? 'block' : 'none'),
      revRows,
      revEmpty: revRows.length === 0,
      cmpLabel: cmpReady ? `${s.cmp[0]} → ${s.cmp[1]}` : '',
      compareBtnStyle: `padding:7px 14px;border-radius:6px;font:600 12px ${SANS};cursor:pointer;` + (cmpReady ? 'background:#1f7ae0;color:#fff' : 'background:#eceef1;color:#b0b6bd;pointer-events:none'),
      startCompare: stop(() => this.setState({ compare: true, revOpen: false })),

      statusChipStyle: `display:flex;align-items:center;gap:7px;padding:6px 11px;border-radius:6px;font:500 11.5px ${SANS};` + status.style,
      statusText: status.text,
      statusDotStyle: `width:8px;height:8px;border-radius:4px;background:${status.dot};flex:none`,

      downloadGroups,
      dlToggle: stop(() => this.setState({ dlOpen: !s.dlOpen, revOpen: false, tokenPop: false })),
      dlBtnStyle: btn(s.dlOpen) + ';border:1px solid #d3d8de;background:#fff',
      dlMenuStyle: 'position:absolute;right:0;top:40px;width:250px;background:#fff;border:1px solid #d3d8de;border-radius:9px;box-shadow:0 10px 34px rgba(20,24,28,.16);padding:6px 0;z-index:40;display:' + (s.dlOpen ? 'block' : 'none'),

      // -- the token: the whole customer/viewer split, in one control
      viewer,
      tokenToggle: stop(() => this.setState({
        tokenPop: !s.tokenPop, tokenDraft: '', revOpen: false, dlOpen: false })),
      tokenBtnStyle: btn(false) + ';border:1px solid ' + (viewer ? '#d3d8de;background:#fff' : '#9cc4f0;background:#dcebfc;color:#155bb5'),
      tokenLabel: viewer ? 'View only' : 'Editing on',
      tokenPopStyle: 'position:absolute;right:0;top:40px;width:320px;background:#fff;border:1px solid #d3d8de;border-radius:10px;padding:13px 14px;box-shadow:0 10px 34px rgba(20,24,28,.16);z-index:40;display:' + (s.tokenPop ? 'block' : 'none'),
      tokenDraft: s.tokenDraft,
      tokenType: (e) => this.setState({ tokenDraft: e.target.value }),
      tokenSave: stop(() => {
        const value = s.tokenDraft.trim();
        if (!value) { this.toast('Paste the token first'); return; }
        writeToken(value);
        this.setState({ token: value, tokenPop: false, tokenDraft: '' });
        this.toast('Editing is on in this browser');
      }),
      tokenClear: stop(() => {
        clearToken();
        this.setState({ token: null, tokenPop: false, tokenDraft: '',
                        composer: null, notePop: null });
        this.set({ tool: null });
        this.toast('Token removed — back to viewing');
      }),

      railToggle: stop(() => this.setState({ rail: !railOpen })),
      railBtnStyle: btn(false) + ';border:1px solid #d3d8de;background:#fff' + (viewer ? ';display:none' : ''),
      railCountStyle: 'min-width:17px;height:17px;padding:0 5px;border-radius:9px;background:' + (openCount ? '#1f7ae0' : '#c3c8cf') + `;color:#fff;display:flex;align-items:center;justify-content:center;font:600 10px ${MONO}`,
      openCount,
      railStyle: 'width:300px;flex:none;background:#f7f8fa;border-left:1px solid #d8dce1;display:' + (railOpen && !viewer ? 'flex' : 'none') + ';flex-direction:column;min-height:0',
      threads,

      // Views come from the model's code: as many tabs as it declares.
      viewTabs: ((meta && meta.variants) || []).map((v) => ({
        key: v.id,
        label: v.name,
        hint: `${v.parts} parts · ${mb(v.gzip)}`,
        style: tab(s.view === v.id),
        onClick: () => this.showView(v.id),
      })),
      tMeasure: setTool('measure'), measureBtnStyle: btn(s.tool === 'measure'),
      tMove: setTool('move'), moveBtnStyle: btn(s.tool === 'move', viewer),
      tComment: setTool('comment'), commentBtnStyle: btn(s.tool === 'comment', viewer),
      fitView: () => this.fitView(),
      grabFrame: () => this.saveFrame(),

      // The canvas theme, in the strip that belongs to the viewport rather than
      // in a menu about something else — it changes what is behind the model, so
      // it sits with the other things that do. The button names the mode the
      // reader is IN, the way the access button beside the token does; what it
      // switches to is in the tooltip.
      themeDark: s.theme === 'dark',
      themeLabel: s.theme === 'dark' ? 'Dark' : 'Light',
      themeTitle: s.theme === 'dark'
        ? 'the model sits on a dark canvas — click for light'
        : 'the model sits on a light canvas — click for dark',
      toggleTheme: () => this.applyTheme(s.theme === 'dark' ? 'light' : 'dark'),
      hintText: s.tool === 'comment' ? 'click the model to pin a task'
        : s.tool === 'measure' ? 'click a part, or two, to measure'
        : s.tool === 'move' ? 'drag a part · esc to stop'
        : s.tool === 'cut' ? 'click a face to place the section plane'
        : `drag — orbit · wheel — zoom · hold ${HOLD_KEY_LABEL} — section`,

      viewError: s.viewError || '',
      viewErrorStyle: 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:420px;padding:14px 16px;background:#fff;border:1px solid #e0bcbc;border-radius:9px;box-shadow:0 8px 28px rgba(20,24,28,.14);z-index:14;text-align:center;display:' + (s.viewError ? 'block' : 'none'),
      retryView: () => this.retryView(),

      notCompare: !s.compare, compare: s.compare,
      hasTree: !!tree,
      expandAll: () => this.setState({
        expanded: Object.fromEntries(Array.from(tree ? tree.nodes.values() : [])
          .filter((n) => n.isNode).map((n) => [n.id, true])) }),
      collapseAll: () => this.setState({ expanded: {} }),
      // RENDERED ABOVE THE ROWS AND OUTSIDE THE `hasTree` BRANCH, so this one is
      // pressable on a page whose tree never arrived — which is exactly the
      // state where a swap's carry is the only record of what was hidden. Hence
      // `setVisibility`; see the method.
      showAll: () => this.setVisibility({ hidden: [], ghost: [] }),
      rows,

      // The section is a ROW in the tree with its own eye, not a mode with a
      // panel: a panel in the page's column takes height from the canvas, so
      // every press and release of the hold key would resize the model.
      secRowStyle: 'flex:none;display:inline-flex;align-items:center;gap:7px;margin:0 0 3px;padding:4px 8px;border-radius:5px;border:1px solid ' + (cutOn ? '#9cc4f0;background:rgba(234,243,253,.92)' : 'transparent;background:rgba(255,255,255,.78)'),
      secEyeClick: stop(() => this.set({ secOn: !s.secOn })),
      secEyeOuter: eyeOuter(cutOn ? 'on' : 'off'), secEyeDot: eyeDot(cutOn ? 'on' : 'off'),
      secSub: s.held ? `held · ${HOLD_KEY_LABEL}` : secSub,
      openSecPop: stop(() => this.setState({ secPop: true })),
      closeSecPop: stop(() => this.setState({ secPop: false })),
      secPopStyle: 'position:absolute;left:278px;top:52px;width:270px;background:#fff;border:1px solid #d3d8de;border-radius:10px;padding:13px 14px;box-shadow:0 10px 34px rgba(20,24,28,.16);z-index:15;display:' + (s.secPop ? 'block' : 'none'),
      pickFace: stop(() => { this.set({ tool: 'cut', secPop: false }); this.toast('Click a face — the plane will sit on it'); }),
      pickFaceStyle: `padding:7px;text-align:center;border-radius:6px;font:600 11.5px ${MONO};cursor:pointer;` + (s.tool === 'cut' ? 'background:#dcebfc;color:#155bb5;border:1px solid #9cc4f0' : 'background:#1f7ae0;color:#fff;border:1px solid #1c67c2'),
      pickFaceText: s.tool === 'cut' ? 'now click a face on the model…' : (s.secFace ? 'pick another face' : 'pick a face to place the plane'),
      secOff: s.secOff, secMin: secRange[0], secMax: secRange[1],
      secStep: Math.max(0.1, Math.round((secRange[1] - secRange[0]) / 40) / 10),
      secOffLabel: `${s.secOff >= 0 ? '+' : ''}${s.secOff.toFixed(1)} mm`,
      setSecOff: (e) => this.set({ secOff: parseFloat(e.target.value), secOn: true }),
      flipSec: stop(() => this.set({ secFlip: !s.secFlip })),
      resetSec: stop(() => this.set({ secOn: false, secFace: null, secOff: 0, secFlip: false },
                                     { __resetCut: true })),
      // Local, and it stays local until the viewport takes a field for it: the
      // contract carries no `hatch`, and inventing one here would be a field
      // only one side has ever heard of.
      toggleHatch: stop(() => this.setState({ hatch: !s.hatch })),
      hatchBox: 'width:15px;height:15px;border-radius:4px;flex:none;display:flex;align-items:center;justify-content:center;font:600 10px monospace;' + (s.hatch ? 'background:#1f7ae0;color:#fff' : 'border:1px solid #c3c8cf;background:#fff;color:transparent'),
      hatchMark: s.hatch ? '✓' : '',

      // -- the two notes on the selected part ---------------------------------
      //
      // ONE BOX, TWO LABELLED HALVES, and the labelling is the feature rather
      // than decoration: these are notes from two different places with two
      // different rights, and a reader who cannot tell them apart will read
      // their own reminder as the author's specification. The author's comes
      // FIRST because it is the one that describes the part; the reader's is
      // what they added on top of it.
      //
      // WHO SEES WHICH. The author's note is published content — the same
      // standing as the part's name and the downloads — so it is drawn with or
      // without a token. The reader's keeps the gate it has always had: the
      // whole customer/viewer split is "no token, no edits", and a note that
      // showed with no way to change it would be a box the reader cannot get
      // out of. Which is also why the box opens for either one alone: an author
      // note on a build a viewer is looking at is the ordinary case.
      noteBoxStyle: 'position:absolute;right:14px;top:14px;width:250px;padding:9px 11px;background:#fdf6e3;border:1px solid #eadfc0;border-radius:7px;box-shadow:0 4px 16px rgba(20,24,28,.1);z-index:11;display:'
        + (!s.compare && (authorNote || (!viewer && readerNote)) ? 'block' : 'none'),
      noteName: this.selectedName(),
      authorNoteStyle: 'display:' + (authorNote ? 'block' : 'none') + ';margin-top:5px',
      authorNote,
      // The rule above it only when there IS something above it — otherwise the
      // one note in the box gets a line separating it from nothing.
      readerNoteStyle: 'display:' + (!viewer && readerNote ? 'block' : 'none')
        + (authorNote
          ? ';margin-top:7px;padding-top:7px;border-top:1px solid #eadfc0'
          : ';margin-top:5px'),
      noteText: readerNote,
      // The link edits the READER's note and nothing else, so it says so and it
      // goes away entirely without a token. It also says which of "add" and
      // "edit" it is about to do, because with an author note on screen the box
      // now stands for parts this browser has written nothing about — and that
      // is the one place a reader can start one from besides the row menu.
      editNoteStyle: 'cursor:pointer;color:#8a9099;font-weight:400;text-transform:lowercase'
        + (viewer ? ';display:none' : ''),
      editNoteLabel: readerNote ? 'edit yours' : 'add yours',
      editNote: stop(() => this.setState({ notePop: this.selectedName(), noteDraft: this.selectedNote() })),

      cmpA: s.cmp[0] || '', cmpB: s.cmp[1] || '',
      exitCompare: stop(() => this.setState({ compare: false })),
      dsBothStyle: tab(s.diffShow === 'both') + ';flex:1;text-align:center;opacity:.5',
      dsAStyle: tab(false) + ';flex:1;text-align:center;opacity:.5',
      dsBStyle: tab(false) + ';flex:1;text-align:center;opacity:.5',

      // The new build is offered, never substituted: somebody may be halfway
      // through a section with half the tree hidden, and a model that changes by
      // itself reads as a breakage.
      bannerStyle: chip(!!s.pending && !s.bannerGone, '#fff', '#d3d8de', '#1c1f23') + ';padding:8px 8px 8px 14px',
      bannerId: s.pending ? shortId(s.pending.commit) : '',
      bannerSwitch: () => this.takePending(),
      // A REVISION PICKED FROM THE PICKER TAKES THIS BUTTON OUT OF SERVICE, and
      // it has to SHOW that, which is the whole reason this style is computed
      // rather than written into the element. `takePending` refuses on
      // `swapping` either way, so without the washed-out blue and the plain
      // cursor the reader would be pressing a button that looks exactly as
      // clickable as it did a second ago and does nothing at all — which is the
      // failure the refusal was added to prevent, wearing the refusal's clothes.
      // It lasts one fetch: `swapFailed` and the swap's own landing both lower
      // the flag.
      bannerSwitchStyle: `padding:5px 12px;background:${s.swapping ? '#9cbde3' : '#1f7ae0'};`
        + `color:#fff;border-radius:5px;font:600 12px ${SANS};`
        + `cursor:${s.swapping ? 'default' : 'pointer'}`,
      bannerLater: () => this.dismissPending(),

      movedChipStyle: chip(!!s.moved, '#fdf0d8', '#f0dcae', '#6b5210'),
      movedText: s.moved ? `${s.moved.name} moved ${s.moved.mag} mm` : '',
      movedReset: () => this.set({ moved: null }, { __resetMove: true }),
      movedAttach: () => this.set({
        composer: {
          part: s.moved.name, partId: s.moved.id, p: null, text: '', photo: null,
          meas: s.measure ? s.measure.full : null,
          move: `${s.moved.name} by ${s.moved.mag} mm`,
        },
        tool: null,
      }),
      measChipStyle: chip(!!s.measure && !s.composer, '#fff', '#d3d8de', '#1c1f23'),
      measText: s.measure ? s.measure.text : '',
      measNote: s.measure ? s.measure.note : '',
      // Measuring is open to everyone, so the CHIP stays; filing a comment is
      // not, so the link goes — the same gate the move tool, the comment tool,
      // the note box and the composer carry. Without it the link opens a
      // composer that `composerStyle` keeps at `display:none`: nothing appears,
      // the chip goes grey because it hides itself while a composer stands, and
      // there is no close button on screen to take it back. The composer then
      // opens with that stale measurement in it the moment a token is entered.
      measAddStyle: 'cursor:pointer;text-decoration:underline'
        + (viewer ? ';display:none' : ''),
      measAdd: () => {
        const node = this.node(s.sel);
        this.set({
          composer: {
            part: node ? node.name : (s.selName || 'model'),
            partId: s.sel || null,
            p: null, text: '', photo: null, meas: s.measure.full,
          },
          tool: null,
        });
      },
      measClear: () => this.set({ measure: null }, { __clearMeasure: true }),

      composerStyle: 'position:absolute;right:16px;bottom:16px;width:400px;background:#fff;border:1px solid #d3d8de;border-radius:10px;box-shadow:0 12px 40px rgba(20,24,28,.2);z-index:16;display:' + (s.composer && !viewer ? 'block' : 'none'),
      nextLabel: String(s.comments.length + 1),
      composerPart: s.composer ? s.composer.part : '',
      composerText: s.composer ? s.composer.text : '',
      compType: (e) => this.setState({ composer: { ...s.composer, text: e.target.value } }),
      compMeasChipStyle: 'display:' + (s.composer && s.composer.meas ? 'flex' : 'none') + `;align-items:center;gap:5px;padding:4px 8px;background:#fdf0d8;border-radius:5px;font:500 10.5px ${MONO};color:#8a6a1f`,
      compMeasText: (s.composer && s.composer.meas) || '',
      compMeasRemove: stop(() => this.setState({ composer: { ...s.composer, meas: null } })),
      compMoveChipStyle: 'display:' + (s.composer && s.composer.move ? 'flex' : 'none') + `;align-items:center;gap:5px;padding:4px 8px;background:#fdf0d8;border-radius:5px;font:500 10.5px ${MONO};color:#8a6a1f`,
      compMoveText: (s.composer && s.composer.move) || '',
      compPhotoName: s.composer && s.composer.photo ? s.composer.photo.name : '',
      compPhoto: (e) => {
        const file = e.target.files && e.target.files[0];
        this.setState({ composer: { ...s.composer, photo: file || null } });
      },
      compCancel: stop(() => this.set({ composer: null })),
      compSend: () => this.sendComment().catch((error) => {
        console.error('comment', error);
        this.toast('Could not send the comment');
      }),

      menuStyle: 'position:fixed;width:230px;background:#fff;border:1px solid #d3d8de;border-radius:9px;box-shadow:0 12px 40px rgba(20,24,28,.2);padding:2px 0 6px;z-index:60;display:' + (s.menu ? 'block' : 'none') + ';left:' + (s.menu ? s.menu.x : 0) + 'px;top:' + (s.menu ? s.menu.y : 0) + 'px',
      menuName: mName, menuItems,

      notePopStyle: 'position:absolute;left:310px;top:120px;width:300px;background:#fff;border:1px solid #d3d8de;border-radius:10px;padding:13px 14px;box-shadow:0 12px 40px rgba(20,24,28,.2);z-index:60;display:' + (s.notePop ? 'block' : 'none'),
      notePopName: s.notePop || '',
      noteDraft: s.noteDraft,
      noteType: (e) => this.setState({ noteDraft: e.target.value }),
      noteCancel: stop(() => this.setState({ notePop: null })),
      noteSave: stop(() => {
        // Through `notesWith` rather than `notes[name] = …`: the key is a PART
        // NAME, and a part called `__proto__` turns that assignment into a
        // silent no-op — see the function's own note.
        this.saveNotes(notesWith(s.notes, s.notePop, s.noteDraft.trim()));
        this.setState({ notePop: null });
      }),

      toastStyle: `position:absolute;left:50%;bottom:18px;transform:translateX(-50%);padding:9px 16px;background:#1c1f23;color:#f2f3f5;border-radius:7px;font:500 12px ${SANS};box-shadow:0 6px 20px rgba(20,24,28,.3);z-index:70;display:` + (s.toast ? 'block' : 'none'),
      toastText: s.toast || '',
    };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ ...css(`position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:${PAGE_BG};color:${PAGE_FG};font:400 13px ${SANS};z-index:5`), ...FONTS }}>
          <div style={css('max-width:420px;padding:18px 20px;background:#fff;border:1px solid #d3d8de;border-radius:9px')}>
            <div style={css(`font:600 13px ${SANS};margin-bottom:6px`)}>This build did not load</div>
            <div style={css(`font:400 12px/1.6 ${MONO};color:#5b6470`)}>{this.state.error}</div>
          </div>
        </div>
      );
    }
    if (!this.state.meta) return null;

    const v = this.computed();

    return (
      // position:fixed, because this interface is the WHOLE page: build.html
      // carries nothing but the div this mounts into, so there is no page
      // layout to fit into and nothing underneath to leave visible.
      <div onClick={v.rootClick} style={{ ...css(`position:fixed;inset:0;display:flex;flex-direction:column;background:${PAGE_BG};color:${PAGE_FG};font-family:${SANS};font-size:13px;overflow:hidden;z-index:5`), ...FONTS }}>
        <style>{PIN_CSS}</style>

        {/* ── header: model, revision, status, downloads, access, comments ── */}
        <div style={css('height:50px;flex:none;display:flex;align-items:center;gap:12px;padding:0 16px;'
          + `background:${HEADER_BG};border-bottom:1px solid ${HEADER_LINE};position:relative;z-index:30`)}
        >
          <a href="/" title="all projects" style={css('display:flex;align-items:center;gap:8px;text-decoration:none;color:inherit')}>
            {/* `<Mark />`, not the same SVG written out again. It WAS written out
                again — byte for byte, defaults and all — which is the third copy
                of a logo that only style.jsx is supposed to own, and the two
                pages carrying two of the copies link to each other. A mark that
                changes when you navigate is one of the three reasons that module
                exists. */}
            <Mark />
            <span style={css(`font:700 14px ${SANS};letter-spacing:-.2px`)}>hammerola</span>
          </a>
          <div style={css(`width:1px;height:22px;background:${HEADER_LINE}`)} />
          <div style={css('display:flex;flex-direction:column;gap:1px;flex:none;min-width:0')}>
            <div style={css(`font:600 13.5px ${SANS};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`)}>{v.title}</div>
            <div style={css(`font:400 10.5px ${MONO};color:#787f87;white-space:nowrap`)}>{v.subtitle}</div>
          </div>

          <div style={css('position:relative;margin-left:8px;flex:none')}>
            <div onClick={v.revToggle} title={v.slotTitle} style={css(v.revBtnStyle)}>
              <span style={css(v.statusDotStyle)} />
              <span style={css(`font:600 12px ${MONO}`)}>{v.slot}</span>
              <span style={css(`font:500 10.5px ${MONO};color:#fff;background:#5b6470;padding:2px 6px;border-radius:4px`)}>{v.slotBadge}</span>
              <span style={css(`font:400 11px ${MONO};color:#787f87`)}>{v.slotDate}</span>
              <span style={css('font-size:9px;color:#9aa1a9')}>&#9662;</span>
            </div>

            {/* pointers on top, the history below; the ticks pick two to compare */}
            <div style={css(v.revMenuStyle)}>
              <div style={css('max-height:308px;overflow:auto')}>
                {v.revRows.map((r) => (
                  <React.Fragment key={r.key}>
                    <div style={css(r.headStyle)}>{r.head}</div>
                    <div style={css(r.style)}>
                      <span onClick={r.onCmp} style={css(r.cmpStyle)}>{r.cmpMark}</span>
                      <span onClick={r.onPick} style={css('display:flex;align-items:center;gap:10px;flex:1;cursor:pointer;min-width:0')}>
                        <span style={css(r.idStyle)}>{r.id}</span>
                        <span style={css(r.badgeStyle)}>{r.badge}</span>
                        <span style={css('flex:1')} />
                        <span style={css(`font:400 11px ${MONO};color:#8a9099`)}>{r.date}</span>
                      </span>
                    </div>
                  </React.Fragment>
                ))}
                {v.revEmpty && (
                  <div style={css(`padding:12px 14px;font:400 11.5px ${SANS};color:#8a9099`)}>
                    This project has no other builds yet.
                  </div>
                )}
              </div>
              <div style={css('display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid #e3e6ea')}>
                <div onClick={v.startCompare} style={css(v.compareBtnStyle)}>Compare {v.cmpLabel}</div>
              </div>
            </div>
          </div>

          <div style={css(v.statusChipStyle)}>{v.statusText}</div>
          <div style={css('flex:1')} />

          {/* downloads: whole-build files, exactly the ones meta.json names */}
          <div style={css('position:relative')}>
            <div onClick={v.dlToggle} style={css(v.dlBtnStyle)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 1.5v9M4.5 7L8 10.5 11.5 7M2 13.5h12" /></svg>
              Downloads
            </div>
            {/* One block per FORMAT, each with a link that takes the whole
                group: on a ten-part build the flat list was thirty rows in no
                useful order, and "every STL" meant aiming at every third one. */}
            <div style={css(v.dlMenuStyle)}>
              {v.downloadGroups.map((g) => (
                <React.Fragment key={g.key}>
                  <div style={css(g.headStyle)}>
                    <span style={css('flex:1')}>{g.ext}</span>
                    <span onClick={g.onAll} style={css(g.allStyle)}>download all</span>
                  </div>
                  {g.files.map((f) => (
                    <a key={f.key} href={f.href} download style={css(f.style)}>
                      <span style={css('flex:1')}>{f.label}</span>
                      <span style={css(`font:400 10.5px ${MONO};color:#b0b6bd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px`)}>{f.file}</span>
                    </a>
                  ))}
                </React.Fragment>
              ))}
              {v.downloadGroups.length === 0 && (
                <div style={css(`padding:10px 14px;font:400 11.5px ${SANS};color:#8a9099`)}>
                  This build ships no files to download.
                </div>
              )}
            </div>
          </div>

          {/* access: the token is what turns a viewer into the customer */}
          <div style={css('position:relative')}>
            <div onClick={v.tokenToggle} style={css(v.tokenBtnStyle)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2.5" y="7" width="11" height="7" rx="1.5" /><path d="M5 7V4.8a3 3 0 0 1 6 0V7" /></svg>
              {v.tokenLabel}
            </div>
            <div onClick={(e) => e.stopPropagation()} style={css(v.tokenPopStyle)}>
              <div style={css(`font:600 12.5px ${SANS};margin-bottom:4px`)}>
                {v.viewer ? 'Enter your token' : 'Editing is on'}
              </div>
              <div style={css(`font:400 11.5px/1.6 ${SANS};color:#5b6470;margin-bottom:9px`)}>
                {v.viewer
                  ? 'EDIT_TOKEN — the same string `hammerola login` asks for. It opens notes, moving a part, and writing a comment. Without one everything else still works: orbiting, the tree, the section, measuring and the downloads. It is kept in this browser, for the whole site.'
                  : 'The token is stored in this browser, for the whole site. Remove it to go back to viewing.'}
              </div>
              {v.viewer ? (
                <>
                  <input type="password" value={v.tokenDraft} onChange={v.tokenType}
                         placeholder="paste the token"
                         style={css(`width:100%;box-sizing:border-box;border:1px solid #d3d8de;border-radius:6px;outline:none;padding:8px 10px;font:400 12px ${MONO};background:#fff`)} />
                  <div style={css('display:flex;justify-content:flex-end;margin-top:9px')}>
                    <span onClick={v.tokenSave} style={css(`padding:6px 14px;background:#1f7ae0;color:#fff;border-radius:6px;font:600 11.5px ${SANS};cursor:pointer`)}>Save</span>
                  </div>
                </>
              ) : (
                <div style={css('display:flex;justify-content:flex-end')}>
                  <span onClick={v.tokenClear} style={css(`padding:6px 14px;border:1px solid #d3d8de;border-radius:6px;font:600 11.5px ${SANS};cursor:pointer;color:#b03a2e;background:#fff`)}>Remove token</span>
                </div>
              )}
            </div>
          </div>

          <div onClick={v.railToggle} style={css(v.railBtnStyle)}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 2.5h12v8.5H8.5L5.5 14v-3H2z" /></svg>
            Comments
            <span style={css(v.railCountStyle)}>{v.openCount}</span>
          </div>
        </div>

        <div style={css('flex:1;display:flex;min-height:0;position:relative')}>

          {/* ── the tree, floating over the model ── */}
          <div style={css('position:absolute;left:12px;top:10px;max-height:calc(100% - 20px);display:flex;flex-direction:column;align-items:flex-start;overflow:auto;z-index:10')}>
            {v.notCompare && (
              <div style={css('display:flex;flex-direction:column;min-height:0')}>
                <div style={css('flex:none;display:flex;align-items:center;gap:2px;padding:0 0 3px')}>
                  <span onClick={v.expandAll} title="expand all" style={css('width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:4px;color:#5b6470;cursor:pointer;background:rgba(255,255,255,.78)')}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 5.5L8 1.5l4 4M4 10.5l4 4 4-4" /></svg>
                  </span>
                  <span onClick={v.collapseAll} title="collapse all" style={css('width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:4px;color:#5b6470;cursor:pointer;background:rgba(255,255,255,.78)')}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 1.5l4 4 4-4M4 14.5l4-4 4 4" /></svg>
                  </span>
                  <span onClick={v.showAll} title="show all parts" style={css('width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:4px;color:#5b6470;cursor:pointer;background:rgba(255,255,255,.78)')}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><ellipse cx="8" cy="8" rx="6.5" ry="4.5" /><circle cx="8" cy="8" r="1.8" /></svg>
                  </span>
                </div>

                <div style={css(v.secRowStyle)}>
                  <div onClick={v.secEyeClick} style={css('width:24px;display:flex;justify-content:center;cursor:pointer;padding:2px 0')}>
                    <span style={css(v.secEyeOuter)}><span style={css(v.secEyeDot)} /></span>
                  </div>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#5b6470" strokeWidth="1.4" style={{ flex: 'none' }}><rect x="2" y="2" width="12" height="12" rx="1" /><path d="M2 14L14 2" /></svg>
                  <span onClick={v.openSecPop} style={css(`font:600 12px ${MONO};color:#2a2e33;cursor:pointer;white-space:nowrap`)}>section</span>
                  <span onClick={v.openSecPop} style={css(`font:400 10.5px ${MONO};color:#8a9099;cursor:pointer;white-space:nowrap;padding-right:2px`)}>{v.secSub}</span>
                </div>

                <div style={css('padding:1px 0 6px;display:flex;flex-direction:column;align-items:flex-start')}>
                  {v.rows.map((row) => (
                    <div key={row.key} onContextMenu={row.onMenu} style={css(row.rowStyle)}>
                      <span onClick={row.onExpand} style={css(row.caretStyle)}>{row.caret}</span>
                      <span onClick={row.onVis} title="show / hide" style={css('width:24px;display:flex;justify-content:center;cursor:pointer;flex:none')}>
                        <span style={css(row.eyeOuter)}><span style={css(row.eyeDot)} /></span>
                      </span>
                      <span onClick={row.onGhost} title="translucent" style={css('width:22px;display:flex;justify-content:center;cursor:pointer;flex:none')}>
                        <span style={css(row.ghostIcon)} />
                      </span>
                      <span style={css(row.dotStyle)} />
                      <span onClick={row.onSelect} style={css(row.nameStyle)}>{row.name}</span>
                      <span title={row.metaTitle} style={css(row.metaStyle)}>{row.meta}</span>
                    </div>
                  ))}
                  {/* Not an empty tree — a tree that has not arrived. It comes up
                      on `hmr:model`, i.e. once the viewport has fetched and drawn
                      a view, so this is also what a page with no adapter shows. */}
                  {!v.hasTree && (
                    <div style={css(`padding:6px 8px;border-radius:4px;background:rgba(255,255,255,.78);font:400 11.5px ${SANS};color:#8a9099`)}>
                      waiting for the model&hellip;
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── comparing two revisions ── */}
            {v.compare && (
              <div style={css('display:flex;flex-direction:column;min-height:0;width:288px;background:rgba(249,250,252,.95);border:1px solid #d3d8de;border-radius:10px;box-shadow:0 6px 24px rgba(20,24,28,.12);overflow:hidden')}>
                <div style={css('flex:none;padding:12px 14px;border-bottom:1px solid #e3e6ea')}>
                  <div style={css('display:flex;align-items:center;gap:8px')}>
                    <span style={css(`font:600 12.5px ${SANS}`)}>Comparing</span>
                    <span style={css(`font:600 12px ${MONO};background:#e3e6ea;padding:2px 7px;border-radius:4px`)}>{v.cmpA}</span>
                    <span style={css('color:#8a9099')}>&#8594;</span>
                    <span style={css(`font:600 12px ${MONO};background:#e3e6ea;padding:2px 7px;border-radius:4px`)}>{v.cmpB}</span>
                    <span style={css('flex:1')} />
                    <span onClick={v.exitCompare} style={css(`font:500 11px ${MONO};color:#1f6fd0;cursor:pointer`)}>exit &#10005;</span>
                  </div>
                  <div style={css('display:flex;gap:2px;padding:3px;background:#e3e6ea;border-radius:7px;margin-top:10px')}>
                    <div style={css(v.dsBothStyle)}>Overlay</div>
                    <div style={css(v.dsAStyle)}>{v.cmpA} only</div>
                    <div style={css(v.dsBStyle)}>{v.cmpB} only</div>
                  </div>
                </div>
                {/* No source, and saying so beats an empty list that reads as
                    "nothing changed" — which is itself one of the answers this
                    block has to be able to give. */}
                <div style={css('flex:1;overflow:auto;padding:12px 14px')}>
                  <div style={css(`font:600 11.5px ${SANS};margin-bottom:6px`)}>Not available yet</div>
                  <div style={css(`font:400 11.5px/1.6 ${SANS};color:#5b6470`)}>
                    The hub cannot compare two builds yet — there is no endpoint that
                    returns the difference, so nothing can be listed here and nothing
                    can be lit up on the model. This panel is the shape it will take.
                  </div>
                </div>
                <div style={css('flex:none;margin:0 14px 14px;padding:10px 12px;background:#fff;border:1px solid #e3e6ea;border-radius:7px')}>
                  <div style={css(`font:600 10px ${MONO};color:#8a9099;letter-spacing:.08em;margin-bottom:7px`)}>LEGEND &mdash; WHAT THE COLOURS WILL MEAN</div>
                  <div style={css('display:flex;align-items:center;gap:8px;margin-bottom:5px')}><span style={css('width:12px;height:12px;border-radius:3px;background:#1f7ae0;flex:none')} /><span style={css(`font:400 11.5px ${SANS}`)}>added &mdash; material only in {v.cmpB}</span></div>
                  <div style={css('display:flex;align-items:center;gap:8px;margin-bottom:5px')}><span style={css('width:12px;height:12px;border-radius:3px;background:#e08a1f;flex:none')} /><span style={css(`font:400 11.5px ${SANS}`)}>removed &mdash; material only in {v.cmpA}</span></div>
                  <div style={css('display:flex;align-items:center;gap:8px')}><span style={css('width:12px;height:12px;border-radius:3px;background:#b8bec6;flex:none')} /><span style={css(`font:400 11.5px ${SANS}`)}>unchanged (ghosted)</span></div>
                </div>
              </div>
            )}
          </div>

          {/* ── the model, and everything laid over it ── */}
          <div style={css('flex:1;position:relative;min-width:0;background:linear-gradient(165deg,#f2f4f6 0%,#e2e5e9 60%,#d4d8dd 100%)')}>
            {/* The custom element the adapter registers. RENDERED BY NAME rather
                than by a reference to the class, and that is the point: what
                defines the tag is `import './viewport/index.js'` in main.jsx,
                where evaluating the module IS the registration. Naming the class
                here would pull `customElements.define` into the import graph of
                a component that only wanted to draw a box. */}
            {React.createElement(VIEWPORT_TAG, {
              ref: this.host,
              style: { position: 'absolute', inset: 0, width: '100%', height: '100%' },
            })}

            {/* views and tools */}
            <div style={css('position:absolute;left:0;right:0;bottom:12px;display:flex;justify-content:center;pointer-events:none;z-index:12')}>
              <div style={css('pointer-events:auto;display:flex;align-items:center;gap:8px;padding:4px;background:rgba(249,250,252,.92);backdrop-filter:blur(10px);border:1px solid #d3d8de;border-radius:9px;box-shadow:0 4px 16px rgba(20,24,28,.1)')}>
                <div style={css('display:flex;gap:2px;padding:2px;background:#e3e6ea;border-radius:6px')}>
                  {v.viewTabs.map((t) => (
                    <div key={t.key} onClick={t.onClick} title={t.hint} style={css(t.style)}>{t.label}</div>
                  ))}
                </div>
                <div style={css('width:1px;height:18px;background:#d8dce1')} />
                <div onClick={v.tMeasure} style={css(v.measureBtnStyle)}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 14L14 2M2 14l2.2-.55M14 2l-.55 2.2M6.2 9.8l1.4 1.4M9 7l1.4 1.4" /></svg>
                  Measure
                </div>
                <div onClick={v.tMove} style={css(v.moveBtnStyle)}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M8 1.5v13M1.5 8h13M8 1.5L6.2 3.3M8 1.5l1.8 1.8M8 14.5l-1.8-1.8M8 14.5l1.8-1.8M1.5 8l1.8-1.8M1.5 8l1.8 1.8M14.5 8l-1.8-1.8M14.5 8l-1.8 1.8" /></svg>
                  Move part
                </div>
                <div onClick={v.tComment} style={css(v.commentBtnStyle)}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 2.5h12v8.5H8.5L5.5 14v-3H2z" /><path d="M5 5.5h6M5 8h4" /></svg>
                  Comment
                </div>
                <div style={css('width:1px;height:18px;background:#d8dce1')} />
                <div onClick={v.fitView} title="back to the frame this view opened in" style={css(`display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:6px;font:500 12px ${SANS};color:#3c4147;cursor:pointer;border:1px solid transparent`)}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5" /></svg>
                  Fit
                </div>
                <div onClick={v.grabFrame} title="save the current frame as a PNG" style={css(`display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:6px;font:500 12px ${SANS};color:#3c4147;cursor:pointer;border:1px solid transparent`)}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1.5" y="4" width="13" height="9.5" rx="1.5" /><circle cx="8" cy="8.7" r="2.6" /></svg>
                  Frame
                </div>
                <div style={css('width:1px;height:18px;background:#d8dce1')} />
                {/* what the model stands on — the canvas only, never the chrome */}
                <div onClick={v.toggleTheme} title={v.themeTitle} style={css(`display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:6px;font:500 12px ${SANS};color:#3c4147;cursor:pointer;border:1px solid transparent`)}>
                  {v.themeDark ? (
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M13.4 9.9A5.9 5.9 0 0 1 6.1 2.6 5.9 5.9 0 1 0 13.4 9.9z" /></svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="3.1" /><path d="M8 1.2v1.7M8 13.1v1.7M1.2 8h1.7M13.1 8h1.7M3.2 3.2l1.2 1.2M11.6 11.6l1.2 1.2M12.8 3.2l-1.2 1.2M4.4 11.6l-1.2 1.2" /></svg>
                  )}
                  {v.themeLabel}
                </div>
              </div>
            </div>

            {/* a newer build landed — offered, not substituted */}
            <div style={css('position:absolute;left:0;right:0;top:14px;display:flex;justify-content:center;pointer-events:none;z-index:13')}>
              <div style={css(v.bannerStyle)}>
                <span style={css('width:8px;height:8px;border-radius:4px;background:#2e9e44;flex:none')} />
                <span style={css(`font:500 12.5px ${SANS}`)}>
                  Build <b style={{ fontFamily: MONO }}>{v.bannerId}</b> is ready &mdash; you are viewing {v.slot}
                </span>
                <span onClick={v.bannerSwitch} style={css(v.bannerSwitchStyle)}>Switch</span>
                <span onClick={v.bannerLater} style={css(`padding:5px 10px;color:#5b6470;border-radius:5px;font:500 12px ${SANS};cursor:pointer`)}>Later</span>
              </div>
            </div>

            {/* state chips: a moved part, a live measurement */}
            <div style={css('position:absolute;left:278px;top:14px;display:flex;flex-direction:column;gap:8px;align-items:flex-start;pointer-events:none;z-index:13')}>
              <div style={css(v.movedChipStyle)}>
                <span style={css('width:7px;height:7px;border-radius:4px;background:#b8710d;flex:none')} />
                {v.movedText} &mdash; temporary, not saved to the model
                <span onClick={v.movedAttach} style={css('cursor:pointer;text-decoration:underline;margin-left:2px')}>attach to comment</span>
                <span onClick={v.movedReset} style={css('cursor:pointer;text-decoration:underline')}>reset</span>
              </div>
              <div style={css(v.measChipStyle)}>
                <span style={css(`font:600 12px ${MONO}`)}>{v.measText}</span>
                {/* The qualifier the brief insists on: a distance taken between
                    parts that have been laid apart is not the assembled one. */}
                {v.measNote && <span style={css(`font:500 10.5px ${MONO};color:#8a6a1f;background:#fdf0d8;padding:3px 7px;border-radius:4px`)}>{v.measNote}</span>}
                <span onClick={v.measAdd} style={css(v.measAddStyle)}>add to comment</span>
                <span onClick={v.measClear} style={css('cursor:pointer;opacity:.6')}>&#10005;</span>
              </div>
            </div>

            {/* The selected part's notes: the model's own first, then this
                browser's. Two sources, one word, so each half is labelled —
                without that, a reader's reminder to themselves reads as the
                author's specification of the part.

                BOTH TEXTS ARE PLAIN CHILDREN, and that is the whole of what
                keeps a pushed string from becoming markup on a permanent,
                immutable, shared-origin page: React renders a child as text.
                Nothing here parses one, linkifies a URL in one or hands one to a
                renderer. The hub refuses `<`, `>` and control characters on the
                way in, and this side does not depend on that being the only line
                — a clickable link is separate work, and it starts with an
                allow-list of schemes, because `javascript:` in an href is script
                execution on the origin every project on this hub shares. */}
            <div style={css(v.noteBoxStyle)}>
              <div style={css(`display:flex;align-items:center;gap:6px;font:600 10px ${MONO};color:#8a6a1f;letter-spacing:.06em`)}>
                NOTE &middot; {v.noteName}
                <span style={css('flex:1')} />
                <span onClick={v.editNote} style={css(v.editNoteStyle)}>{v.editNoteLabel}</span>
              </div>
              <div style={css(v.authorNoteStyle)}>
                <div style={css(`font:600 9px ${MONO};color:#a2894e;letter-spacing:.07em`)}>FROM THE MODEL</div>
                <div style={css(`font:400 11.5px/1.5 ${SANS};color:#4a4436;margin-top:3px`)}>{v.authorNote}</div>
              </div>
              <div style={css(v.readerNoteStyle)}>
                <div style={css(`font:600 9px ${MONO};color:#a2894e;letter-spacing:.07em`)}>ONLY IN THIS BROWSER</div>
                <div style={css(`font:400 11.5px/1.5 ${SANS};color:#4a4436;margin-top:3px`)}>{v.noteText}</div>
              </div>
            </div>

            {/* the viewport could not draw this view — block 11. The button is
                the only way back: the viewport remembers a failed load so an
                ordinary click cannot re-fetch it, and nothing else on this page
                clears that memory. */}
            <div style={css(v.viewErrorStyle)}>
              <div style={css(`font:600 12.5px ${SANS};margin-bottom:5px`)}>This view did not render</div>
              <div style={css(`font:400 11.5px/1.6 ${MONO};color:#5b6470`)}>{v.viewError}</div>
              <div onClick={v.retryView} style={css(`display:inline-block;margin-top:11px;padding:6px 14px;background:#1f7ae0;color:#fff;border-radius:6px;font:600 11.5px ${SANS};cursor:pointer`)}>Try again</div>
            </div>

            {/* The bottom-left corner is the VIEWPORT'S: it draws the view cube
                there (ui/src/viewport/viewcube.js). A static axis triad used to
                be drawn here instead, and it never turned with the camera — see
                issues #23 and #24. */}

            <div style={css(`position:absolute;right:14px;bottom:12px;font:400 10.5px ${MONO};color:#9aa1a9;pointer-events:none`)}>{v.hintText}</div>

            {/* the composer: the frame rides along by itself, the photo does not */}
            <div onClick={(e) => e.stopPropagation()} style={css(v.composerStyle)}>
              <div style={css('display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #e3e6ea')}>
                <span style={css(`width:20px;height:20px;border-radius:10px 10px 10px 3px;background:#1f7ae0;color:#fff;display:flex;align-items:center;justify-content:center;font:600 10.5px ${MONO}`)}>{v.nextLabel}</span>
                <span style={css(`font:600 12px ${SANS}`)}>Task for the agent</span>
                {/* Only when there IS a part: the separator belongs to the name,
                    and a draft that lost its attachment to a revision swap would
                    otherwise keep a lone middle dot standing where it used to
                    be — a leftover pointing at the build the page has left. */}
                {v.composerPart
                  ? <span style={css(`font:400 11px ${MONO};color:#8a9099`)}>&middot; {v.composerPart}</span>
                  : null}
                <span style={css('flex:1')} />
                <span onClick={v.compCancel} style={css('color:#9aa1a9;cursor:pointer')}>&#10005;</span>
              </div>
              <textarea
                value={v.composerText}
                onChange={v.compType}
                maxLength={MAX_COMMENT_CHARS}
                placeholder="e.g. gap here is 2.4 — make it 3"
                style={css(`width:100%;box-sizing:border-box;border:none;outline:none;resize:none;padding:10px 12px;font:400 12.5px/1.5 ${SANS};color:#1c1f23;height:64px;background:transparent`)}
              />
              <div style={css('display:flex;align-items:center;gap:6px;padding:0 12px 10px;flex-wrap:wrap')}>
                <span style={css(`display:flex;align-items:center;gap:5px;padding:4px 8px;background:#eef1f4;border-radius:5px;font:400 10.5px ${MONO};color:#5b6470`)}>
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1.5" y="4" width="13" height="9.5" rx="1.5" /><circle cx="8" cy="8.7" r="2.6" /></svg>
                  camera frame &mdash; attached automatically
                </span>
                <span style={css(v.compMeasChipStyle)}>&#8596; {v.compMeasText} <span onClick={v.compMeasRemove} style={css('cursor:pointer;opacity:.6')}>&#10005;</span></span>
                <span style={css(v.compMoveChipStyle)}>&#10021; {v.compMoveText}</span>
                <label style={css(`padding:4px 8px;border:1px dashed #c3c8cf;border-radius:5px;font:400 10.5px ${MONO};color:#8a9099;cursor:pointer`)}>
                  {v.compPhotoName ? `photo: ${v.compPhotoName}` : '+ photo of the print'}
                  <input type="file" accept="image/jpeg,image/png,image/webp"
                         onChange={v.compPhoto} style={{ display: 'none' }} />
                </label>
                <span style={css('flex:1')} />
                <span onClick={v.compSend} style={css(`padding:6px 14px;background:#1f7ae0;color:#fff;border-radius:6px;font:600 12px ${SANS};cursor:pointer`)}>Send</span>
              </div>
            </div>

            {/* the section plane */}
            <div onClick={(e) => e.stopPropagation()} style={css(v.secPopStyle)}>
              <div style={css('display:flex;align-items:center;gap:8px;margin-bottom:10px')}>
                <span style={css(`font:600 12.5px ${SANS}`)}>Section plane</span>
                <span style={css('flex:1')} />
                <span onClick={v.closeSecPop} style={css('color:#9aa1a9;cursor:pointer')}>&#10005;</span>
              </div>
              <div onClick={v.pickFace} style={css(v.pickFaceStyle)}>{v.pickFaceText}</div>
              <div style={css(`display:flex;justify-content:space-between;font:500 11px ${MONO};color:#5b6470;margin:12px 0 5px`)}>
                <span>offset</span><span style={css('color:#1c1f23')}>{v.secOffLabel}</span>
              </div>
              {/* The range is the viewport's: it comes back on `hmr:face` from the
                  model's own extent, so a 400 mm part and a 4 mm one both get a
                  slider that spans them. */}
              <input type="range" min={v.secMin} max={v.secMax} step={v.secStep}
                     value={v.secOff} onChange={v.setSecOff} style={{ width: '100%' }} />
              <div style={css('display:flex;gap:6px;margin-top:10px')}>
                <div onClick={v.flipSec} style={css(`flex:1;padding:6px;text-align:center;border:1px solid #d3d8de;border-radius:5px;font:500 11px ${MONO};color:#3c4147;cursor:pointer;background:#fff`)}>flip side</div>
                <div onClick={v.resetSec} style={css(`flex:1;padding:6px;text-align:center;border:1px solid #d3d8de;border-radius:5px;font:500 11px ${MONO};color:#3c4147;cursor:pointer;background:#fff`)}>reset</div>
              </div>
              <div onClick={v.toggleHatch} style={css('display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:11px')}>
                <span style={css(v.hatchBox)}>{v.hatchMark}</span>
                <span style={css(`font:400 11.5px ${SANS};color:#3c4147`)}>hatch the cut face</span>
              </div>
            </div>

            <div style={css(v.toastStyle)}>{v.toastText}</div>
          </div>

          {/* ── the comment rail ── */}
          <div style={css(v.railStyle)}>
            <div style={css('flex:none;display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #e3e6ea')}>
              <span style={css(`font:600 12.5px ${SANS}`)}>Comments</span>
              <span style={css(`font:500 10.5px ${MONO};background:#e3e6ea;color:#5b6470;padding:2px 7px;border-radius:8px`)}>{v.openCount} sent here</span>
              <span style={css('flex:1')} />
              <span onClick={v.railToggle} style={css('color:#9aa1a9;cursor:pointer;font-size:14px')}>&#10005;</span>
            </div>
            {/* The feed still has no source ON THIS PAGE, and an empty list
                would read as "no comments on this build" — a different
                statement. The PERMISSION barrier is gone: step 0 put the queue
                behind the same EDIT_TOKEN this page holds, so
                `GET /api/v1/comments?project=<pid>` would answer right now. What
                is left is a question nobody has decided: the queue is per
                PROJECT and a comment carries the point it was left at, so a
                comment raised on an older revision has coordinates that may name
                nothing on the geometry now on screen. Fetching the list is a few
                lines; deciding what a pin from another revision does is the
                feature. Until that is answered the rail states what it holds
                rather than implying the queue is empty. */}
            <div style={css(`flex:none;margin:10px;padding:10px 12px;background:#fdf6e3;border:1px solid #eadfc0;border-radius:7px;font:400 11.5px/1.6 ${SANS};color:#4a4436`)}>
              This lists what was sent from this session. The full queue for the
              project is not shown here yet — a comment is pinned to a point on
              the revision it was left on, and what such a pin means on a
              different revision has not been settled.
            </div>
            <div style={css('flex:1;overflow:auto;padding:0 10px 10px;display:flex;flex-direction:column;gap:10px')}>
              {v.threads.map((c) => (
                <div key={c.key} onClick={c.onOpen} style={css(c.style)}>
                  <div style={css('display:flex;align-items:center;gap:8px')}>
                    <span style={css(c.pinStyle)}>{c.label}</span>
                    <span style={css(`font:500 11.5px ${MONO};color:#2a2e33`)}>{c.part}</span>
                    <span style={css('flex:1')} />
                    <span style={css(`font:400 10.5px ${MONO};color:#9aa1a9`)}>{c.time}</span>
                  </div>
                  <div style={css(`font:400 12px/1.5 ${SANS};color:#2a2e33;margin:7px 0 8px`)}>{c.text}</div>
                  <div style={css(c.measStyle)}>&#8596; {c.meas}</div>
                  <div style={css('display:flex;align-items:center;gap:10px;margin-top:8px')}>
                    <span onClick={c.onResolve} style={css(`font:500 10.5px ${MONO};color:#8a9099;` + (c.resolved ? 'cursor:default' : 'cursor:pointer'))}>
                      {c.resolved ? 'processed' : 'mark processed'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── the tree row's context menu ── */}
          <div onClick={(e) => e.stopPropagation()} style={css(v.menuStyle)}>
            <div style={css(`padding:7px 14px 6px;font:600 10.5px ${MONO};color:#8a9099;border-bottom:1px solid #e3e6ea`)}>{v.menuName}</div>
            {/* A row that carries a file is an ANCHOR and not a div: the download
                is the browser's to do, exactly as in the header's menu, so the
                link is a real one and can be middle-clicked or saved as. */}
            {v.menuItems.map((m) => {
              const inner = (
                <>
                  <span style={css('flex:1')}>{m.label}</span>
                  <span style={css(`font:400 10.5px ${MONO};color:#b0b6bd`)}>{m.hint}</span>
                </>
              );
              return m.href
                ? <a key={m.key} href={m.href} download onClick={m.onClick} style={css(m.style)}>{inner}</a>
                : <div key={m.key} onClick={m.onClick} style={css(m.style)}>{inner}</div>;
            })}
          </div>

          {/* ── the note editor: bound to a part NAME, for the whole project ── */}
          <div onClick={(e) => e.stopPropagation()} style={css(v.notePopStyle)}>
            <div style={css(`font:600 12px ${SANS};margin-bottom:2px`)}>
              Note &middot; <span style={css(`font:500 11.5px ${MONO};color:#5b6470`)}>{v.notePopName}</span>
            </div>
            <textarea
              value={v.noteDraft}
              onChange={v.noteType}
              placeholder="e.g. thin wall here — do not touch"
              style={css(`width:100%;box-sizing:border-box;border:1px solid #d3d8de;border-radius:6px;outline:none;resize:none;padding:8px 10px;font:400 12px/1.5 ${SANS};height:64px;background:#fff`)}
            />
            {/* Half of this used to be false: it said the hub has no endpoint
                for notes, and the hub now publishes the AUTHOR's. What is still
                true is the half about THIS note — it stays here, and no route
                writes it back — so the sentence says that, and then says where
                a note that has to travel is written instead. Somebody who wants
                the next reader to see what they just typed needs that address
                more than they need to know what this box does not do. */}
            <div style={css(`font:400 10.5px/1.5 ${MONO};color:#9aa1a9;margin-top:6px`)}>
              stays in this browser &mdash; nothing sends it to the hub. A note that
              travels with the build, for everyone who opens it, is written in model.py
            </div>
            <div style={css('display:flex;gap:8px;justify-content:flex-end;margin-top:8px')}>
              <span onClick={v.noteCancel} style={css(`padding:6px 12px;border-radius:6px;font:500 11.5px ${SANS};color:#5b6470;cursor:pointer`)}>Cancel</span>
              <span onClick={v.noteSave} style={css(`padding:6px 14px;background:#1f7ae0;color:#fff;border-radius:6px;font:600 11.5px ${SANS};cursor:pointer`)}>Save</span>
            </div>
          </div>

        </div>
      </div>
    );
  }
}
