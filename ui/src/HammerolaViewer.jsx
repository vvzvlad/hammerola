/**
 * ============================================================================
 *  HammerolaViewer — the build page: tree, section, measure, move, comments
 * ============================================================================
 *
 * Where each piece of data comes from:
 *
 *   PARTS / NODES  -> the part tree the viewport hands over on `hmr:model`,
 *                     walked recursively (hub.indexTree). The nesting is the
 *                     assembly structure, so there is no flat node list. This
 *                     side does not fetch the view file: the viewport fetches
 *                     it to render, and the tree is inside that document.
 *   REVS           -> /project/<pid>/builds.json, which carries the pointers
 *                     (`has_dev`, `latest`) beside the history of commits.
 *   DIFF           -> two documents computed on request: `scene.json`, an
 *                     ordinary view payload for the viewport already on the
 *                     page, and `report.json`, the list of parts the panel
 *                     draws. Both are behind EDIT_TOKEN and exist only once
 *                     asked for — see hub.js and `runCompare` below.
 *   notes          -> two things sharing one word; the box on the canvas labels
 *                     them. Both hang on the catalogue key, the part's
 *                     identity. The reader's note is localStorage, per project,
 *                     and never leaves this browser. The author's note is
 *                     published content: written in `model.py`, validated at
 *                     build and publish, carried as `note` inside the build's
 *                     `meta.parts[key]` and shown to everyone. A part with
 *                     nothing to say has no `note` key.
 *   comments       -> the project's queue, read and written under the same
 *                     EDIT_TOKEN. `loadFeed` fetches it, the rail draws all of
 *                     it oldest first, and a build swap neither refetches nor
 *                     clears it: the queue belongs to the project, not one
 *                     revision (SPEC 7A.3). A comment is bound to the catalogue
 *                     key, so its pin follows the part across revisions, and
 *                     when the part leaves the catalogue the row says the
 *                     comment is orphaned. `hub.anchorFor` decides, `sync` draws.
 *   buildStatus    -> polling meta.json on the two pointer URLs, which answers
 *                     "has a new build arrived while I was looking at this one".
 *   viewerMode     -> derived, not a prop: it is `no token`.
 *
 * THE TOKEN. Whoever has it can edit and comment; whoever does not gets the
 * interface to look with. It is typed in by the person, kept in localStorage
 * per project, and removable. Closed without it: the reader's own note on a
 * part, moving a part, and comments entirely. Open always: orbiting, the tree,
 * the section, measuring, the downloads, the frame grab — and the author's
 * note, which is published content.
 *
 * CONTRACT WITH THE VIEWPORT — see events.js for the names. Down, one event
 * carrying the whole of what should be on screen; up, one per name in
 * `EVENTS_UP`. `sync()` below is the only place this file writes the down
 * event.
 *
 *   * `camera` does not travel in `hmr:state`. The viewport wants the library's
 *     `{position, quaternion, target, zoom}`, which only the viewport knows, so
 *     Fit is `el.setCamera(home)` through the element's imperative half, where
 *     `home` is the frame the library fitted on first render. Through the state
 *     event a camera would compare equal after the first apply and Fit would
 *     work once.
 *   * the snapshot a comment carries is `el.snapshot()`, the library's own
 *     `getImage`, not `canvas.toDataURL()` from outside: a WebGL canvas without
 *     `preserveDrawingBuffer` reads back blank unless the grab lands in the
 *     same frame as a draw.
 *   * the hold key is C and it belongs to the viewport, which knows which
 *     letters the library already eats. This file only listens for `hmr:tool`
 *     and shows what it is told.
 *
 * STYLING is inline — `css()` parses a CSS string into a React style object.
 * Two exceptions: the measurement label is DOM the viewport creates, so it is
 * styled by class from the one `<style>` block below; and the fonts are a
 * system stack, because this page's CSP is `default-src 'self'`.
 */

import React from 'react';

import {
  STATE, PICK, MENU, FACE, MEASURE, MOVED, PROPOSALMOVE, TURNED, PROPOSALTURN,
  PLACE, PIN, MODEL, ERROR, TOOL, CAMERA, VIEWPORT_TAG,
} from './events.js';
import {
  PAGE, ASSEMBLED_VIEW_ID, CAMERA_QUERY, COMPARE_GROUPS, HUB_UNREACHABLE,
  JOB_DONE, JOB_FAILED, anchorFor, askHub, compareBase, decodeCamera,
  encodeCamera, isPointerPage, buildKey,
  countedName, compareView, hubBody, hubTrouble, indexTree, loadCompareReport,
  loadJob, loadMeta, loadBuilds, pageFrom, placementIn, rereadPage, rowsByKey,
  shortId, startCompare, mb,
} from './hub.js';
// `readTheme`/`writeTheme` come from here, not the viewport: the theme is the
// whole interface's palette, per-reader state like the token, the notes and the
// tabs, and this is the one module that reaches the cookie.
import {
  readToken, readNotes, writeNotes, rememberPointer,
  readTabs, rememberTab, forgetTab, readTheme, writeTheme, readRetina,
} from './store.js';
// The two attachments a comment carries, made small enough to send. Imported
// only for `sendComment`: the frame grab itself (`frameBlob`) stays lossless,
// because `saveFrame` writes its answer to the reader's disk.
import {
  shrink, SHOT_MAX_SIDE, SHOT_QUALITY, PHOTO_MAX_SIDE, PHOTO_QUALITY,
} from './shrink.js';
// The proposal: a rough body the reader assembles out of numbers so the agent
// has something to design against or to copy — the motor the bracket has to
// clear, the wall it bolts to, or an example of the layout they want. The
// document and its projection are pure text (`proposal.js`); the kernel that
// turns one into parts, and those parts' colours, are in `proposalgeom.js`.
// That module is the one named exemption from the no-literal rule in
// `tests/test_ui_source.py`: a part's colour is model content, and this file
// paints no part.
import {
  addNode, bodies, dropMoves, emptyProposal, isEmpty, moveNodes,
  moves, removeNode, proposalText, sendsNothing, turnNodes, updateNode,
} from './proposal.js';
import { buildProposal } from './proposalgeom.js';
// The panel's own half of `computed()`: a view model that takes the state and
// a bag of this page's actions and returns the `proposal*` keys `render()`
// draws from.
import { proposalView } from './proposalview.js';
// And the menu a right-click opens, on a row of the tree or on the part in the
// scene — one section of `computed()` and one shape, whichever door opened it.
import { rowMenu } from './rowmenu.js';
// And the chrome round the model: the header, the token control, the tab strip,
// the view switcher and the floating toolbar.
import { chromeView } from './chromeview.js';
// And one of the build's documents, laid over the model when it is chosen in
// the view list; drawn as the documents page draws it.
// `FILE_TYPE` and `docExt` come with it for the downloads menu, which offers a
// document the page cannot draw under the extension it is named by.
import DocumentView, { DOC_QUERY, docExt, FILE_TYPE } from './DocumentView.jsx';
// The type the downloads menu knows the board's Gerbers by.
import { GERBERS_TYPE } from './gerber.js';
import { savePng, toolBar } from './viewlist.jsx';
// And the four panels that answer to little more than the state: the revision
// picker, the downloads menu, the comment rail and the comparison. `fileHref`
// comes with the downloads because the row menu builds the same link for one
// part that the header's menu builds for all of them, and `filesKeyFor`
// because both menus put the same key into it.
import { revisionView } from './revisionview.js';
import { downloadsView, fileHref, filesKeyFor } from './downloadsview.js';
// The Copy link at the end of each file row of both menus.
import CopyLink from './copylink.jsx';
import { feedView } from './feedview.js';
import { comparePanel } from './compareview.js';
// The rules this page and the front page both write: the popover recipe its
// panels share, the three controls, the tree's icons, and the declarations that
// were spelled out once per call site.
import {
  ACCENT_BTN, BLANK_BOX, CARD, DIALOG_BTN, DIM_CLICK, FAINT_CLICK, FAINT_MONO, FILL, HALF_BTN,
  HEADER_RULE, HEAD_MONO, HEAD_SANS, IDLE, INDEX_MONO, INK, KEY_MONO, LABEL_SANS, LINK,
  META_MONO, ON_ACCENT, ON_ACCENT_EDGE, POP_SHADOW_HIGH, RELATIVE, ROW,
  ROW_LABELLED, SLOT_22, SLOT_24, SPAN_MONO, SUNKEN, SWATCH, TITLE, TOOL_SQUARE,
  WARN_BODY, WARN_CAPS, WORDMARK, chip, eyeDot, eyeOuter, ghostIcon, popover,
} from './panelstyle.js';
import {
  css, FONTS, SANS, MONO, Mark, NARROW, PAGE_BG, PAGE_FG,
} from './style.jsx';
// The one question this file's keydown handler cannot answer for itself: is the
// reader in a field. Imported rather than repeated because the rule is subtle —
// the library's tab strip and the Clip panel's checkboxes are `<input>` too, so
// "any input" is the wrong test — and a second copy would be free to drift.
import { typingTarget } from './viewport/holdkey.js';
// And the viewport's test of a stored vector, which `sync` applies to a
// comment's normal before handing it to the arrows: `math.js` imports nothing.
import { finite3 } from './viewport/math.js';

// `css()`, the font stacks and the mark now live in style.jsx: this page stopped
// being the only one drawn with them when the front page landed, and a second
// copy of the font stacks is two typefaces on one site. That module says why the
// stacks are what they are.

/**
 * The only rules that cannot be inline styles.
 *
 * The measurement label is an element the VIEWPORT creates and positions — it
 * has to be, because its place on screen is a world point projected through a
 * camera that moves sixty times a second, and routing that through React would
 * re-render the interface on every mouse move. How it LOOKS stays here, which is
 * why the viewport sets only class names on it. (The comment arrows are objects
 * in the scene, drawn by the viewport, ui/src/viewport/pins.js.)
 *
 * Three class names, and the division between them and the viewport is the
 * same one every time: the viewport POSITIONS (inline, per frame, in code), this
 * stylesheet DECIDES HOW IT LOOKS. `.hmr_canvas` and `.hmr_overlay` are the two
 * layers the element builds — the library's container and the layer over it.
 * Neither needs layout from here; what they need is the page's own colour under
 * the model instead of the browser's white, which is what shows while the viewer
 * module is still loading, and a font for anything the overlay grows later.
 * `.hmr_measure_label` is the thing drawn IN that overlay, and its whole
 * appearance is here.
 *
 * Injected as a `<style>` element rather than an imported stylesheet: an
 * `import './x.css'` would make this build emit a second output file, and that
 * name would then have to be added to the Makefile, the Dockerfile, ci/smoke.py
 * and the page template — see ui/vite.config.mjs, which says so at length.
 */
const VIEWPORT_CSS = `
.hmr_canvas {
  background: var(--page-bg);
}
.hmr_overlay {
  color: var(--text);
  font-family: ${FONTS['--hmr-sans']};
}
.hmr_measure_label {
  padding: 3px 7px; border-radius: 4px;
  background: var(--tooltip-bg); color: var(--tooltip-text);
  font: 600 11px ${FONTS['--hmr-mono']};
}
`;

// The same number as the hub's ceiling on comment text —
// `comment_max_text_chars` in src/settings.py — repeated here because the page
// cannot be told the hub's value: `templates/build.html` and meta.json are
// written at publish time (src/render.py) with no per-hub values, while the
// setting is read per request.
//
// If the hub's value is raised, the form is merely stricter; if lowered, the
// textarea accepts text the hub refuses with a 422 and the photo-format toast.
// At any setting it stops a runaway paste before it becomes a multipart upload.
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
// The viewport answers `isBusy()` during a drag and for a moment after one
// (viewport/live.js), and a swap re-renders the scene and re-seats the camera,
// which would pull the model out from under the pointer. So the swap waits and
// `pending` stays set meanwhile, so the offer is not lost.
//
// The deadline exists because "busy" hangs on a `pointerup` this page may never
// see (a release over another window, a tab that lost focus mid-drag). A Switch
// button that does nothing forever is worse than a model that jumps.
const BUSY_RETRY_MS = 250;
const BUSY_WAIT_MS = 5000;

// How often the page asks whether the comparison it queued has finished, and how
// long it goes on asking.
//
// A comparison is two STEP reads and one boolean per part — about a second and a
// half on a real assembly — plus the build queue ahead of it, so the answer
// usually arrives on the second or third poll. The three-minute ceiling stops a
// job the hub lost from leaving the panel on "measuring" indefinitely.
const COMPARE_POLL_MS = 1500;
const COMPARE_WAIT_MS = 180000;

/**
 * Which of the comparison scene's groups a tab takes off the screen.
 *
 * Overlay hides nothing — both revisions, ghosted, with the difference between
 * them bright on top.
 *
 * A single-revision tab shows one revision and its own difference: `A only` is
 * revision A and the material removed from it, `B only` is revision B and the
 * material added to it. The other revision's difference must go too: `added`
 * is drawn where B stands and `removed` where A stands
 * (`cadbuild/comparescene`), and a part that exists in only one revision is
 * drawn whole and opaque, so it would cover A's own geometry on the A tab.
 *
 * A function, not a map, so `diffShow` cannot reach a lookup that answers
 * `constructor` with something off `Object.prototype`.
 */
const diffHidden = (show) => {
  if (show === 'a') return [COMPARE_GROUPS.b, COMPARE_GROUPS.added];
  if (show === 'b') return [COMPARE_GROUPS.a, COMPARE_GROUPS.removed];
  return [];
};

/** A volume as the panel prints it: whole mm³, or two places while it is small. */
const mm3 = (value) => (value >= 10
  ? String(Math.round(value))
  : String(Number(value.toFixed(2))));

/** The letter the viewport holds the cut tool up on. Shown, never bound here. */
const HOLD_KEY_LABEL = 'C';

// HOW LONG A RUN OF NUDGES HAS TO STOP FOR before the proposal is written.
// Longer than the ~30 ms a browser repeats a held arrow or a held spinner button
// at, so a hold of any length is one document at the end of it; short enough
// that a single click of an arrow reads as an immediate answer. `nudgeProposal`
// says what this buys and what it costs.
const NUDGE_QUIET_MS = 100;

// HOW LONG THE PROPOSAL HAS TO STAND STILL before it is written to the hub.
// Every edit of the document comes through `setProposal`, and a drag of a body
// is a run of them — so a save per edit would be a request per frame of a
// gesture. Long enough that a sentence being typed into a field is one write at
// the end of it, short enough that a reader who says something and closes the
// tab has already been saved. `saveProposal` says what the guards around it are
// for, and who calls it.
const PROPOSAL_SAVE_MS = 800;

// HOW LONG THE CAMERA HAS TO STAND STILL before the address is rewritten with
// it (`writeCamera`). An orbit reports every frame, so the address is written
// once the hand stops, not per frame.
export const CAMERA_WRITE_MS = 400;

// WHAT THE PROPOSAL'S BRANCH IS EXPANDED AND COLLAPSED UNDER, in the same
// `expanded` map the parts tree keys by node id. It cannot collide with one of
// those: every id `indexTree` mints is a PATH and begins with `/`, while this is
// a bare word. Read as OPEN unless the map says `false`, because the branch is
// drawn only when the reader has put something in the document — a row that
// arrives already folded away is a row they have to go and find.
export const PROPOSAL_BRANCH = 'proposal';

// What the section's row puts in `s.menu.id` when right-clicked, so it reaches
// the same menu as the parts tree's rows. It cannot collide with a tree row:
// every id `indexTree` mints is a path beginning with `/`, so `this.node()`
// answers `null` for this bare word, and both branches that build the menu ask
// `secMenu` before they read `mNode`. The word is the row's label, which heads
// the menu.
export const SECTION_ROW = 'section';

/**
 * The selection, moved from a body's document id onto the path the scene has
 * just given it — or nothing to move.
 *
 * The counterpart of `selectionAfter`. A body's row in the proposal's branch is
 * selected by its scene path when it has one and by its node id when not (a
 * row that cannot be opened is a dead end: its fields are how a refused
 * document gets repaired). So the row's identity changes when the body is
 * staged; without this `s.sel` matches neither spelling, the row deselects and
 * the block being typed in shuts. It happens during the staging window (the
 * branch draws from `state.proposal` while `show()` waits on the library) and
 * when a refused document is repaired by something that does not touch `sel`.
 *
 * Moved rather than accepting both spellings: `sel` is the page's one
 * selection and several readers treat it as a path — `selectedPaths()` hands it
 * to the viewport, `selectedKey()` looks up a catalogue record, `measAdd` posts
 * it as a comment's `partId`. A node id left there would highlight nothing and
 * file a task against `n5`.
 *
 * The tree is checked: a refused document leaves the last good overlay
 * standing, so the group may exist while this body does not.
 *
 * Not while a comparison is up: `staged()` lays the overlay into whatever
 * payload is current (viewport/element.js), so the group exists at a
 * comparison path. `sel` would then name a part no revision has and survive
 * `leaveCompare` (which, unlike `leaveBuild`, does not clear it), and `measAdd`
 * would post it, since it begins with `/`. The test is `compared`, not the
 * tree's shape — the same decision `proposalRows` makes on `path`.
 *
 * A module function so the state updater it is spread into stays pure;
 * `overlay` and `compared` are resolved outside it.
 */
function stagedSelection(overlay, tree, s, compared) {
  if (compared || !overlay || !s.sel || !s.proposal) return null;
  const node = bodies(s.proposal).find((body) => body.id === s.sel);
  if (!node) return null;
  const path = `${overlay}/${node.name}`;
  return tree.nodes.has(path) ? { sel: path, selName: node.name } : null;
}

/**
 * The shut eyes a document still has nodes for — the rule `movesOff` obeys
 * (the constructor says what the list is). An entry is a move node's id, and
 * ids come from a counter that restarts at zero each session
 * (`recordGesture`), so an entry outliving its node would come round shut over
 * a part nobody switched off.
 *
 * Called in the same write as the document so the pair cannot come apart:
 * `setProposal` and `onModel` (where a rebuild drops the moves) use it.
 * `recordGesture` keeps the rule with its own line because a gesture also
 * opens the eye of the node it wrote. `leaveBuild` applies it to the document
 * it hands on.
 *
 * A module function so the state updaters stay pure.
 */
function eyesKept(off, doc) {
  if (!off || !off.length) return [];
  const held = new Set(moves(doc).map((node) => node.id));
  return off.filter((shut) => held.has(shut));
}

/**
 * The snap steps a document still has nodes for — same rule as `eyesKept`.
 * Over all nodes, not only moves: a proposal body is dragged by the same
 * manipulator, so it can carry a step of its own.
 */
function snapsKept(steps, doc) {
  const held = new Set(doc.nodes.map((node) => node.id));
  const kept = {};
  for (const [id, step] of Object.entries(steps || {})) {
    if (held.has(id)) kept[id] = step;
  }
  return kept;
}

// How many views fit as a strip of pills before the switcher becomes a menu.
// The strip is what gives up its width when the toolbar is short of room
// (`TAB_STRIP` in viewlist.jsx), so a too-wide row squeezes its pills until the
// names are cut to an ellipsis. Four pills plus the tools is about what a laptop
// holds on one line with the names whole.
export const VIEW_TABS_MAX = 4;

// How many steps Ctrl+Z can walk back through, of either kind. Capped because
// the page is left open for hours; the oldest step goes on overflow, since the
// newest is the one about to be taken back.
//
// Entries are cheap: a visibility step is two id lists, a document step a
// reference to an existing document (proposal.js helpers never mutate), so the
// cap rations the walk back rather than the bytes.
export const UNDO_DEPTH = 50;

// What a step is about; `undoStep` dispatches on it.
//
// Two kinds on one stack because the chord means "the last thing I did": hide
// a part, drag another, press Ctrl+Z and the drag must come back, not the hide.
const UNDO_VISIBILITY = 'visibility';
const UNDO_DOCUMENT = 'document';

// What a write of the document does to the document steps behind it — the
// argument `setProposal` takes, so the caller states which it means.
//
// A document step holds the whole document. `setVisibility` is the only writer
// of the lists a visibility step snapshots, but only two writes through
// `setProposal` record a step (the two gestures). Every other write (a body
// drawn, a digit committed, a delete, an adoption...) is unknown to the stack;
// a step left behind one would undo that edit too and post the older document
// at the next save, with no redo.
//
// So an unrecorded write drops them (`DROP_STEPS`, the default). `KEEP_STEPS`
// is for callers that already accounted for the stack: `undoStep`, spending a
// step it just popped, and `editBody`, which just pushed its own. Anything
// other than `KEEP_STEPS` is a drop, the safe direction.
//
// Visibility steps are left whole either way; a document write makes nothing
// they claim untrue.
//
// A write that hands back the same document is not an edit and drops nothing.
// No caller does this at present; the branch is the contract, and
// `revswitch.test.js` calls the method directly to hold it. Identity is the
// right test: every edit builds a new document (`addNode`, `removeNode`,
// `updateNode`, `commit`, `emptyProposal`, a spread), and a stale `this.state`
// read yields an older object, never identical to a fresh one.
const DROP_STEPS = 'drop';
const KEEP_STEPS = 'keep';

/**
 * One entry of `meta.parts`, or `null` — the only way this page reads the
 * catalogue.
 *
 * The key is the identity and comes from a pushed document, so a part may be
 * called `constructor` or `__proto__` (`render._check_part_name` allows it). A
 * bare `parts[key]` on a `JSON.parse` result would answer those with a
 * function off `Object.prototype` — the same trap `noteFor` documents for the
 * reader's note map, keyed by the same catalogue key.
 *
 * A non-object record is no record: the hub refuses one, but this reads a
 * fetched document, and `"lid": 3` would reach `record.files`.
 */
export function partRecord(parts, key) {
  if (!key || !parts || typeof parts !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(parts, key)) return null;
  const record = parts[key];
  return record && typeof record === 'object' ? record : null;
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
function fileList(record) {
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
 * The catalogue only, which keeps whole-build meshes out of this menu.
 * `overview` and `preview` on a view (`assembled.stl`, `print.stl` and their
 * pictures) are declared for a client to fetch, not as buttons. `print.stl` as
 * a button would be wrong: the `print` view may hold mocks of purchased parts,
 * and a public button invites slicing them. `assembled.stl` is on screen in 3D
 * already.
 *
 * A Map because the group key is an extension out of a pushed document, so
 * `__proto__` is reachable and an object literal would silently store nothing
 * under it.
 *
 * Two kinds of document reach this menu, both out of `meta.documents`. Every
 * zip of Gerbers (`GERBERS_TYPE`) is a row of one GERBERS group, named by its
 * title. Every document the page cannot draw (`FILE_TYPE`) is a row under its
 * own extension in capitals — DXF, CSV — so a cut list for the glass shop is
 * taken the way an STL is, and lands beside a part's exports when it shares
 * their extension. Both are ordered like any other format.
 */
export function groupDownloads(parts, documents) {
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
  listed.filter((doc) => doc.type === FILE_TYPE).forEach((doc) => {
    const group = docExt(doc).toUpperCase();
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ label: String(doc.name || doc.file), file: doc.file });
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
 * How many parts one view shows, out of the summary the hub publishes for it.
 *
 * `views[].parts` is a list of catalogue keys, so the tab strip and subtitle
 * can say what a tab holds without fetching the geometry; the hub checks it
 * against the view file (`_match_selection` in src/render.py). A non-list is
 * 0 rather than `NaN`: `undefined.length` would take the header down.
 *
 * It counts distinct parts: five copies of one pin name `pin` once, so a plate
 * of a lid and five pins reads "2 parts".
 */
function viewPartCount(view) {
  return Array.isArray(view && view.parts) ? view.parts.length : 0;
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
 * outlives it: one controller serves the whole page (`downloadAll`), and each
 * finished chain would otherwise leave a listener holding its `list` and
 * `timer`. `{once: true}` covers only an abort that fires.
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
 * Shared by both ways into that menu (right-click on a tree row, right-click on
 * the part in the scene) so they open in the same place.
 *
 * Both numbers are estimates: 246 is the menu's 230 px width (`menuStyle`)
 * plus slack; 300 guesses its height, which varies with the number of file
 * rows. Measuring would cost a frame of the menu in the wrong place, and an
 * estimate is enough to keep it from opening mostly off the right or bottom.
 */
export function menuAt(x, y) {
  return {
    x: Math.min(x, Math.max(0, window.innerWidth - 246)),
    y: Math.min(y, Math.max(0, window.innerHeight - 300)),
  };
}

/**
 * One entry of the reader's note map — the only way a map keyed by a part's
 * identity may be read.
 *
 * The map comes from `JSON.parse` on localStorage and inherits from
 * `Object.prototype`. A catalogue key may be `constructor` or `toString`
 * (`render._check_part_name` allows it), and a bare `map[key]` would answer
 * with a function off the prototype, which React refuses to render and the row
 * menu's hint tries to slice. `hasOwnProperty.call` asks about the map itself.
 *
 * One helper so every read gets the guard. The author's note lives in the
 * catalogue record and is guarded by `partRecord` for the same reason.
 *
 * The type check is the same argument for a value the hub would never write but a
 * fetched document is free to carry: a note that is not a string is no note.
 */
export function noteFor(map, key) {
  if (!key || !map || typeof map !== 'object') return '';
  if (!Object.prototype.hasOwnProperty.call(map, key)) return '';
  return typeof map[key] === 'string' ? map[key] : '';
}

/**
 * The same map with one entry written, or — for an empty text — taken out.
 *
 * The write-side pair to `noteFor`. `notes[key] = text` is an assignment, and
 * `__proto__` names an accessor on `Object.prototype` whose setter silently
 * ignores a string, so a note on a part called `__proto__` (allowed by
 * `render._check_part_name`) would vanish. `Object.defineProperty` writes an
 * own slot, which then shadows the accessor on read.
 *
 * A new object rather than a mutation, because `saveNotes` puts it in state.
 * The spread defines rather than sets, so an existing `__proto__` entry
 * survives the copy.
 *
 * `Object.create(null)` would not help: the map comes back through
 * `JSON.parse` and inherits from `Object.prototype` regardless, so the fix
 * belongs at the one write.
 */
export function notesWith(map, key, text) {
  const next = { ...(map && typeof map === 'object' ? map : null) };
  if (!key) return next;
  if (text) {
    Object.defineProperty(next, key,
                          { value: text, writable: true, enumerable: true, configurable: true });
  } else {
    delete next[key];
  }
  return next;
}

/**
 * The verdict for a part the kernel would not measure, spelled as the hub
 * spells it (`cadbuild/comparescene.STATUSES`).
 *
 * A verdict, not an absence of one: `shapediff.check` refuses a measurement
 * exactly where the kernel may have lied. Nothing bright is drawn for such a
 * part, so the scene looks untouched and the panel is the only place to say so.
 *
 * One spelling, matching the printed job log the reader sees beside this
 * panel; the constant keeps its three readers below in step.
 */
const NOT_MEASURED = 'not measured';

/**
 * The verdict for a part no pair of STEP files came from, spelled as the hub
 * spells it (`cadbuild/comparescene.STATUSES`).
 *
 * The routine silence, unlike the one above: the two builds did not both
 * export the part, so nothing was fused or established. Hardware and mocks are
 * the everyday case, but a part `printable` in one revision and hardware or a
 * mock in the other lands here too, where one build did export a STEP. It is
 * quiet because most models carry several bought parts.
 *
 * Quiet is not `unchanged`: it is never counted as a part that came out the
 * same, so "identical" is said about the compared parts and states how many of
 * these it left out (`compareSummary`).
 */
const NOT_COMPARED = 'not compared';

/**
 * What that word means, said once for the whole category (the legend line).
 *
 * The definition comes first and the example second, because only the
 * definition is true of every row: a part `printable` in one revision and
 * hardware or a mock in the other is not "no geometry of ours".
 *
 * A constant, so a test can hold it to the hub's own sentence for the same row
 * (`cadbuild/comparescene._uncovered_line`).
 */
const NOT_COMPARED_WHY = 'the two builds did not both export it as STEP,'
  + ' so nothing was fused — hardware and mocks most often';

/**
 * Whether a row is one the reader may safely meet last.
 *
 * Two words, not a category. `unchanged` means the comparison looked and found
 * nothing; `not compared` means it never had two STEP files to look at.
 * Neither is news. `not measured` reads similarly but is the opposite claim,
 * so it stays at the top with what changed.
 */
function isQuiet(status) {
  return status === 'unchanged' || status === NOT_COMPARED;
}

/**
 * The chip a status wears in the parts list.
 *
 * One function because the row and the legend line both draw it; a test
 * asserts they come out equal.
 *
 * A refusal gets the warning surface, the one this interface uses for "read
 * this before you trust what you see" (the laid-out-view note, the note box):
 * it is a part the comparison could not speak about, not one it had nothing
 * to say about.
 *
 * `not compared` wears the muted grey: several rows of an ordinary model
 * (bought screws) are always in that state, and spending the warning surface
 * on them teaches readers to ignore it.
 */
function statusChip(status) {
  return `flex:none;padding:1px 5px;border-radius:4px;font:600 9.5px ${MONO};letter-spacing:.05em;`
    + (status === NOT_MEASURED
      ? 'background:var(--warn-bg);color:var(--warn)'
      : 'background:var(--chip-bg);color:'
        + (isQuiet(status) ? 'var(--text-faint)' : 'var(--text-soft)'));
}

/**
 * The sentence a row carries under it, where it has one worth the height.
 *
 * `not compared` always means the same thing, so its sentence lives once in
 * the legend instead of repeating on every bought screw; those rows keep the
 * word alone.
 *
 * `not measured` keeps its own: it says which identity failed and by how much,
 * and the scene shows such a part as untouched, so the row is the only place
 * to learn it.
 *
 * Named rather than negated, so a status this side does not know keeps
 * whatever the hub wrote under it.
 */
function rowReason(row) {
  return row.status === NOT_COMPARED ? '' : row.reason;
}

/**
 * `report.json`'s parts, as the records the hub writes them as.
 *
 * A list, each row carrying its own `key` — `cadbuild/comparescene.report`
 * writes `{parts: [{key, status, added_mm3, removed_mm3}, ...]}`, pinned by a
 * test on that side. Only `not measured` and `not compared` rows carry a
 * `reason`.
 *
 * Any other shape is no rows: it comes from another process, and an unknown
 * shape means the hub has changed, which the panel cannot report on.
 */
function reportParts(report) {
  const parts = report && typeof report === 'object' ? report.parts : null;
  return Array.isArray(parts) ? parts : [];
}

/**
 * `report.json`'s parts, in the order the compare panel lists them.
 *
 * What changed comes first. The report's order is the catalogue's, so in "one
 * part of forty changed" the row the reader came for could sit thirty rows
 * down. Within each half the hub's (assembly) order is kept.
 *
 * Unknown statuses are shown, not swallowed. Six words are the contract
 * (`cadbuild/comparescene.STATUSES`: unchanged, changed, new, removed, not
 * measured, not compared); a seventh means the hub has moved. Only the two
 * quiet words sort down (`isQuiet`); everything else, including
 * `not measured`, stays at the top.
 *
 * The reason is carried as text, not reduced to a flag: the hub already wrote
 * which identity failed. It is another process's string, so a non-string is
 * no reason.
 *
 * A row with no key is dropped: the key is the part's identity and what a
 * click resolves against the scene.
 */
export function compareRows(report) {
  const number = (value) => (typeof value === 'number' && Number.isFinite(value)
    ? value : 0);
  return reportParts(report)
    .filter((line) => line && typeof line === 'object'
      && typeof line.key === 'string' && line.key)
    .map((line) => ({
      key: line.key,
      status: typeof line.status === 'string' ? line.status : '',
      added: number(line.added_mm3),
      removed: number(line.removed_mm3),
      reason: typeof line.reason === 'string' ? line.reason : '',
    }))
    // Stable, which is what keeps "the hub's order inside each half" true.
    .sort((one, other) => (isQuiet(one.status) ? 1 : 0)
      - (isQuiet(other.status) ? 1 : 0));
}

/**
 * The one line above the list: how much of the model this comparison touched.
 *
 * "Identical" is an answer and must be said as a sentence; a list of
 * `unchanged` rows cannot be told from one that failed to load.
 *
 * It is measured against the rows the comparison established something about.
 * The list is the view's parts, including `hardware` and `mock`, which read
 * `not compared`, so "every row unchanged" never holds on an ordinary model.
 * Identical is therefore said about the compared parts, with the remainder
 * stated in the same line.
 *
 * A single `not measured` denies it entirely: that is the gate refusing a
 * measurement where the kernel may have lied. An unknown status denies it too,
 * since it is not `unchanged`.
 *
 * Only `not measured` is counted in the row of counts, at the end and only
 * when present, so readers keep reading the tail. `not compared` is counted
 * only in the identical sentence, as the qualifier on the claim.
 */
export function compareSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const count = (status) => list.filter((row) => row.status === status).length;
  const parts = (n) => `${n} part${n === 1 ? '' : 's'}`;
  const refused = count(NOT_MEASURED);
  const quiet = count(NOT_COMPARED);
  // What the comparison actually looked at: neither silence is in it, so an
  // `identical` said over these is a claim only about parts something was
  // established about.
  const established = list.length - refused - quiet;
  if (!list.length) return 'this report lists no parts';
  if (!refused && established && count('unchanged') === established) {
    return quiet
      ? `identical — all ${established} compared ${established === 1 ? 'part' : 'parts'}`
        + ` unchanged · ${quiet} not compared`
      : `identical — all ${parts(list.length)} unchanged`;
  }
  return `${parts(list.length)} · ${count('changed')} changed · ${count('new')} new`
    + ` · ${count('removed')} removed`
    + (refused ? ` · ${refused} not measured` : '');
}

export default class HammerolaViewer extends React.Component {
  /**
   * The comment rail starts closed: the page exists to show a model, and the
   * rail would take 300 px for a queue nobody asked to see. It is one click away
   * in the header, shows its open count while closed, and opens by itself when a
   * pin on the model is clicked or a comment is posted (`rail: true`).
   *
   * Not remembered, unlike the front page's list arrangement (store.js):
   * `s.rail` has three writers and two of them (the pin handler, posting) are
   * not a preference, so storing the field would turn one pin click into
   * "always show the queue". A remembered preference needs a writer only a
   * person can reach.
   */
  static defaultProps = { commentsOpen: false };

  constructor(props) {
    super(props);
    this.host = React.createRef();
    // The composer's textarea, focused when the composer opens.
    this.compBox = React.createRef();
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
    // What the reader can take back: one entry per gesture, oldest first, each
    // holding the page as it stood before that gesture and saying by its `kind`
    // which sort of thing it describes. Spent by `undoStep`.
    //
    // A visibility step holds `hidden` and `ghost`, written by `setVisibility`,
    // the only writer of those lists. A document step holds the whole proposal,
    // written by the two gestures that edit it: a build part dragged or turned
    // (`recordGesture`) and a proposal body dragged or turned (`editBody`).
    //
    // Not state, like `this.carry`: nothing is drawn from it (no undo button,
    // no count), so a write must not cost a render.
    this.history = [];
    // Where the last accepted gesture is taking this page, which is NOT where
    // the page has got to (`PAGE.slot`) while a swap is on the wire. `popstate`
    // is compared against this one; see `switchBuild`.
    this._want = null;
    // The slot the comparison on screen was ENTERED from, where that was one of
    // the two moving names, and null everywhere else — a comparison arrived at
    // by its own URL was never on a pointer. Written by `compareRevisions` on
    // the way in and spent by `leaveCompare` on the way out; see there for what
    // standing on a pointer is worth beyond the address. Not state, for the
    // reason `this.carry` is not: nothing on the page is drawn from it, and it
    // lives for exactly one comparison.
    this._cmpFrom = null;
    // How many nodes the proposal has ever been given; a new node's id (and a
    // body's first name) comes from it. A counter, not the list length:
    // deleting the second of two and adding another would mint `n2` twice, and
    // `updateNode` would edit both. One counter for bodies and moves so ids
    // never collide; the prefix (`n1`, `m2`) says which kind a node is.
    // Not state, like `this.carry`: nothing is drawn from it.
    this._proposalSeq = 0;
    // The key to the files that the ADDRESS carried when the page loaded
    // (`?files=`), with the slot it was carried for: a key opens one address
    // only (`filesKeyFor`). Read once and never written — the address of a
    // reader without the token does not move, and the owner's keys come with
    // builds.json instead.
    this._linkKey = {
      slot: PAGE.slot,
      key: new URLSearchParams(location.search).get('files') || '',
    };
    // The camera frame the ADDRESS carried when the page loaded (`?c=`), or
    // null. Read here, before anything rewrites the address, and spent by the
    // first model event (`onModel`); on a comparison link by the comparison
    // scene's, or put on the own view when the comparison ends without one
    // (`sceneNeverCame`).
    this._linkCamera = decodeCamera(new URLSearchParams(location.search).get(CAMERA_QUERY));
    // The rest of this page's instance fields, declared in one place because
    // `componentWillUnmount` must know every one: it removes the listeners and
    // clears the timers, and a field it misses is a leaked listener or a timer
    // waking on an unmounted component.
    //
    // All start `undefined` on purpose: every reader is written for it —
    // `clearTimeout(undefined)` is a no-op, `this._h || {}` sweeps nothing,
    // `(this._swapGen || 0) + 1` starts at one.
    //
    // -- the listeners `componentDidMount` puts on the window
    this._h = undefined;            // the viewport's events, name -> handler
    this._kd = undefined;           // keydown: Escape, the undo chord, the hold key
    this._pop = undefined;          // popstate, for a build swapped in place
    this._mq = undefined;           // the breakpoint's media query list, or null
    this._narrow = undefined;       // and the listener on it
    // -- true once this component has gone, for anything that may wake up after
    this._gone = undefined;
    // -- generations: a late answer whose number has moved on is dropped whole
    this._swapGen = undefined;      // build swaps started
    this._pollGen = undefined;      // polls started
    // -- timers, every one of them cleared on unmount
    this._poll = undefined;         // the next poll of the pointer's meta.json
    this._pollDelay = undefined;    // and the delay it is armed at, which backs off
    this._swap = undefined;         // a swap deferred while the viewport is busy
    this._nudge = undefined;        // the run of spinner nudges, committed once it stops
    this._tt = undefined;           // the toast's own life
    this._proposalSave = undefined; // the debounce on writing the document to the hub
    this._cmpWaits = undefined;     // every gap between two polls of a comparison job
    this._camWrite = undefined;     // the debounce on writing the camera into the address
    // -- what the model event and the stored proposal leave for each other
    this._refit = undefined;        // the next model event refits the camera
    this._modelSeen = undefined;    // a model event has landed at all
    this._proposalRecord = undefined; // what `loadProposal` read, for `adoptProposal`
    this._proposalSent = undefined; // the payload last written, so a save can be skipped
    // -- the download chain in flight, which `cancelDownloads` aborts
    this._dl = undefined;
    // -- other views of the build on screen, read for the comments left there
    this._viewDocs = undefined;
    // -- true once `sync` no longer holds the model back for a document, and
    // whether the last `sync` did
    this._modelFree = undefined;
    this._heldBack = undefined;
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
      // `doc`: the document laid over the model, or null (`docOpen`).
      // `docTools`: what the bar's Fit and Frame do with it, `{ fit, frame }`
      // once its view says it can (`onTools` in DocumentView.jsx), else null.
      view: null, doc: null, docTools: null, tool: null, held: false, sel: null, selName: '',
      hidden: [], ghost: [], expanded: {},
      secOn: false, secOff: 0, secRange: null, secFlip: false, hatch: true,
      secFace: null, secPop: false,
      // The Settings card's one answer, remembered per browser (store.js).
      retina: readRetina(),
      // `opsOpen` is the `Add primitive` menu in the floating toolbar, and it is
      // one of these rather than one of the proposal's own fields below for the
      // reason it is written beside `viewsOpen`: it is a menu of the chrome's,
      // dismissed by `rootClick` and by Escape like the other menus of the
      // chrome. NO COUNT OF THEM HERE — `chromeview.js` says why: a number in
      // a sentence has been wrong twice already, because nothing fails when a
      // menu is added beside it.
      revOpen: false, dlOpen: false, viewsOpen: false, opsOpen: false,
      settingsOpen: false,
      // The Share window: `{id, files}` while it is open, where `id` is
      // `latest` or the full commit of the row it was opened from and `files`
      // is its one checkbox; null while it is closed.
      share: null,
      cmp: [], compare: false, diffShow: 'both',
      // -- the comparison: five fields answering five questions.
      //
      // `cmp` above is what the picker's ticks hold and it keeps moving while a
      // comparison is on screen. `cmpPair` is the pair the panel and scene are
      // about, snapshotted when Compare was pressed, so they cannot disagree
      // while a job is on the wire.
      //
      // `cmpView` is snapshotted beside it: a comparison is of one view (the hub
      // builds and caches the scene per view, hub.js), and the reader's tab can
      // move under a running job.
      //
      // `cmpStage` alone says whether there is a scene to show: null before
      // anything is asked, `starting`/`running` while the hub computes, then
      // `ready`, `failed`, or `locked` for a reader with no token. `sync` points
      // the viewport at the comparison only on `ready`, since a missing
      // `scene.json` would replace the build with the failed-view panel.
      cmpPair: null, cmpView: null, cmpStage: null, cmpError: null,
      cmpReport: null,
      // Which row of the report is picked out on the model, as a CATALOGUE KEY
      // rather than a path: the comparison draws one part up to four times —
      // once in each revision and once in each difference group — and selecting
      // it means all of them.
      cmpSel: null,
      bannerGone: false, rail: null, menu: null,
      notePop: null, noteDraft: '', notes: {},
      // The project's whole comment queue, as the hub answers it (`loadFeed`),
      // in the records' own shape — oldest first, as SPEC 7A.2 sorts them.
      feed: [], activePin: null, composer: null,
      // A comment is on the wire. The same idea as `swapping` above and for the
      // same two reasons: `sendComment` refuses on it, and `compSendStyle`
      // draws it, so the button that has stopped taking clicks stops looking
      // like it takes them.
      sending: false,
      measure: null, toast: null,
      // -- the rough body the reader is asking the model to fit around: a
      // statement, not an edit. Nothing here is pushed or rebuilt from, and the
      // model on screen is untouched by it.
      //
      // `proposalError` is the kernel refusing the document as it stands, drawn
      // under the head of the branch (`proposalSays`, which also says what the
      // kernel refuses). The overlay is not cleared while it is set; see
      // `setProposal`. `proposalDraft` is the field the reader is typing in;
      // see `computed`, where it is spent, and `commitProposal`, where it
      // becomes a document.
      //
      // `proposalOff` is the branch's own eye, interface state not held in the
      // document: it takes the whole proposal off the model (bodies unstaged,
      // displaced parts back in place) while leaving the document intact, so
      // opening it restores everything on the next stage that builds (see
      // `toggleProposalEye`). Read only at `proposalOverlay` and
      // `proposalMoves`. False by default, so a proposal never arrives hidden.
      //
      // `movesOff` is the same per move node: the ids whose eye is shut. The
      // node stays in the document, the branch and the agent's text; nothing is
      // stored and reopening needs no undo. Read only at `proposalMoves`. Empty
      // by default.
      //
      // It may name only move nodes the document still has. Every writer of
      // the document keeps that in the same write: two via `eyesKept`, and
      // `recordGesture` via its own line, because a gesture also opens the eye
      // of the node it wrote (dragging a part says it stands here).
      //
      // `snapSteps` is the other per-node switch, also interface state: node id
      // -> drag step in millimetres. The document says where a part stands, not
      // how the hand rounded, so this travels and is stored nowhere. Read only
      // at `proposalSnaps`; empty means the automatic step (`niceStep` in
      // viewport/tools.js). It is kept over all nodes (`snapsKept`), since a
      // body is dragged by the same manipulator as a build part.
      proposal: emptyProposal(), proposalError: null,
      proposalDraft: null, proposalOff: false, movesOff: [], snapSteps: {},
      // What the hub holds, in two fields with one reader each.
      // `proposalHeld` is about the record (read by `saveProposal`);
      // `proposalStands` is about its content (read by `sendComment`).
      //
      // `proposalHeld` — is there a record for this project, and do we know yet:
      //
      //   * `null` — `loadProposal` has not answered. Nothing is written, so a
      //     page that has not read the stored document cannot overwrite it with
      //     its empty one. A failed load leaves it null (nothing was learned),
      //     and so does a record the page declined to adopt (`adoptProposal`,
      //     when the reader had already drawn something);
      //   * `false` — asked, and nothing is stored (a 404, or the record deleted
      //     from the branch's `×`). An empty document is not written either, so
      //     an empty page never creates a record;
      //   * `true` — a record is on the hub, because one was read or one was
      //     written.
      //
      // `proposalStands` — the record's `text` is not null, the hub's word for a
      // document neither empty nor ticked off to the last node. `sendComment`
      // tells the agent there is one to read, so it must be current: every save
      // raises or lowers it, the delete lowers it.
      proposalHeld: null, proposalStands: false,
      // -- who the reader is
      // No project id: the secret is one string for the whole hub since step 0,
      // so keying it per project stored N copies of it (see store.js).
      token: readToken(), tokenPop: false, tokenDraft: '',
      // -- and what they want to look at the model against. Read here so the
      // first paint is already the reader's answer: the same read seeds the
      // options the viewport starts the library with (viewport/options.js), so
      // the button below never has to correct a canvas that came up wrong.
      theme: readTheme(),
      // -- where this browser has been lately: the strip under the header.
      // Empty here and seeded in `load()`, unlike `theme` above, because an
      // arrival cannot be recorded until `meta` says what this project is
      // CALLED — see there. Nothing is lost by the wait: below two entries the
      // strip is not drawn at all.
      tabs: [],
      // -- and how much room there is to draw all of that in. Read here so the
      // first paint is already the narrow one on a phone, the way `theme` above
      // is already the reader's: a header that lays itself out wide and then
      // reflows is a page that looks broken for one frame. `computed()` is the
      // only reader; see `style.jsx` (NARROW) for why this is a boolean in
      // state rather than a `@media` block.
      narrow: !!(window.matchMedia && window.matchMedia(NARROW).matches),
      // Does the reader want the tree on screen? Asked only in the narrow
      // branch, where the tree covers the model it describes rather than
      // sitting in a corner of it — wide, the tree is simply drawn.
      //
      // Not stored: store.js (the only module touching localStorage) holds
      // preferences, and this is just which of two overlapping things is in
      // front right now.
      treeOpen: false,
    };
  }

  /** No token, no edits. The whole of the customer/viewer split (brief). */
  viewer() { return !this.state.token; }

  /**
   * Are the three canvas tools — Measure, Comment, Move — out of service?
   *
   * Yes while the scene on screen is a comparison's, for the same reason the
   * file rows and Isolate leave the scene menu (`menuItems`) and `onPick` stops
   * writing `sel`: everything they produce is addressed in the build's terms,
   * and none would fail loudly:
   *
   *   * Comment would file a task naming `/cmp/added/plate #1`, a part in no
   *     build, catalogue or `model.py` — a wrong instruction to the agent;
   *   * Measure's `add to comment` would attach the number to `sel`, which
   *     `onPick` stops writing during a comparison, i.e. to whatever was
   *     selected before the panel opened;
   *   * Move would write a move node naming `/cmp/…` paths into the proposal.
   *
   * The test is `comparePair()`, not `s.compare` — the same reading `sync` and
   * `onPick` use. While the pair is still being measured the build is on
   * screen, and the tools are honest there.
   *
   * Both ends are closed: the buttons draw as spent and Move's row is not
   * offered (`computed`), and the three handlers return early, since a tool
   * armed before the comparison opened is still armed in the viewport.
   */
  toolsOff() { return !!this.comparePair(); }

  /**
   * Was this path a body of the proposal, rather than a part of the build?
   *
   * The same class of problem as `toolsOff`. Staged bodies (`staged()` in
   * viewport/element.js) are ordinary pick targets, so the Comment tool would
   * post `partId: "/<root>/proposal/motor"` and the measurement chip's
   * `add to comment` would attach that path — tasks in the build's terms about
   * a body in no build, catalogue or revision.
   *
   * Move is not refused by this: dragging a proposal body is a different
   * gesture, told apart by the viewport (`grabbable` in viewport/parts.js,
   * which asks `isOverlay`) and ending in `hmr:proposalmove`, so it never
   * reaches the `hmr:moved` handler. The row menu offers Move on a body as on a
   * part; this answer only picks which sentence the row raises.
   *
   * The measurement itself is allowed: a distance on a proposal body is what
   * the panel exists for. Only the part the chip would file it against is
   * refused.
   *
   * The viewport is asked because it mints the group's name against the
   * model's parts (`proposal`, or `proposal2` if the model has a `proposal`).
   * False where there is no element yet: nothing staged, nothing picked.
   */
  proposalBody(id) {
    const el = this.el();
    return !!(el && typeof el.isOverlay === 'function' && el.isOverlay(id));
  }

  /**
   * Where the overlay's bodies hang in a tree, or null while nothing is staged.
   *
   * The viewport is asked rather than a name matched (see `overlayAt` in
   * viewport/element.js): it mints the group's name against the model's parts,
   * so only it can tell the overlay from a model part called `proposal`.
   *
   * Only the root's own children, where `staged()` hangs it: one call per
   * top-level row.
   *
   * A method because two callers ask it of different trees: `computed()` of
   * the tree on screen (to draw the proposal's branch and keep its rows out of
   * the parts tree), `onModel` of the tree that just landed (to move a
   * selection onto the body's new path).
   */
  overlayRoot(tree) {
    if (!tree) return null;
    return tree.roots
      .flatMap((id) => tree.nodes.get(id).children)
      .find((id) => this.proposalBody(id)) || null;
  }

  // -- loading --------------------------------------------------------------
  componentDidMount() {
    this.setState({ notes: readNotes(PAGE.pid) });

    // This page is the arrival, so the reader's pointer is recorded here
    // (SPEC 9; store.js says why it is written here and read elsewhere). Before
    // the load: the URL opened is already known, and a build whose meta.json
    // never arrives was still the one asked for.
    //
    // Only on a pointer page. On `/project/<pid>/<commit>/` there is no choice
    // between the two moving names to record, and the URL that names a pointer
    // has to keep winning over the remembered one.
    if (isPointerPage()) rememberPointer(PAGE.pid, PAGE.slot);
    this.load().catch((error) => {
      console.error('hammerola', error);
      this.setState({ error: String(error && error.message ? error.message : error) });
    });
    // The queue takes the token, so a reader without one asks for nothing. The
    // other door is `tokenSave`, where a reader who has just entered one is in
    // exactly this position.
    //
    // AND THE STORED PROPOSAL WITH IT, behind the same token and through the
    // same two doors: `loadProposal` says why those two and no others.
    if (this.state.token) { this.loadFeed(); this.loadProposal(); }

    this._h = {
      [PICK]: (e) => this.onPick(e.detail),
      [MENU]: (e) => this.sceneMenu(e.detail),
      // The plane moved: either it was just laid on a face, or a drag of it
      // ended. Both carry the depth measured FROM THAT FACE and the range the
      // slider has to span, so neither number is invented on this side.
      [FACE]: (e) => {
        const d = e.detail || {};
        // The row's name, found by looking the seeded path up. `hmr:face` names
        // the solid the plane was laid on (`seedCut` takes the name off the
        // owner path, `reportCut` reads it back), so a cut on the second copy
        // arrives as `pin(2)`, and once a run of copies collapses into one row
        // (`indexTree`) no row has that name. Where the run did not collapse
        // (see `repeats` in hub.js and `tests/repeats.test.js`), the lookup
        // finds that copy's own row. A name never identifies a solid; the
        // lookup is by path. `d.name` is kept only for a path no row claims (a
        // face clicked before the tree landed), and `'face'` for a hit with no
        // owner. `tests/repeats.test.js` lists every surface that draws a name.
        //
        // Bare, like `hmr:place`: the plane lies on one face of one solid, so a
        // count would tally parts the cut was never aimed at.
        //
        // A plane the grip's rings have turned names no face: `secFace: null`,
        // which reads as `plane · +N mm`, the subtitle for a cut with no face
        // behind it.
        const row = this.node(d.id);
        this.set({
          secOn: true,
          secFace: d.turned ? null : ((row && row.name) || d.name || 'face'),
          secOff: Number.isFinite(d.offset) ? d.offset : this.state.secOff,
          secRange: Array.isArray(d.range) ? d.range : this.state.secRange,
          tool: null,
        });
      },
      [MEASURE]: (e) => {
        // Not while the scene is a comparison's (`toolsOff`): the chip this
        // would raise carries an `add to comment` that posts `sel`, and `sel` is
        // whatever was picked on the BUILD before the panel opened.
        if (this.toolsOff()) return;
        const answer = e.detail;
        if (!answer || !Number.isFinite(answer.value)) return;
        const measure = this.measureLabel(answer);
        this.setState((s) => ({
          measure,
          composer: s.composer ? { ...s.composer, meas: measure.full } : s.composer,
        }));
      },
      [MOVED]: (e) => this.recordGesture(e.detail, 'delta'),
      [TURNED]: (e) => this.recordGesture(e.detail, 'turn'),
      [PROPOSALMOVE]: (e) => {
        const d = e.detail || {};
        this.editBody(d.name, d.delta, moveNodes);
      },
      [PROPOSALTURN]: (e) => {
        const d = e.detail || {};
        this.editBody(d.name, d.turn, turnNodes);
      },
      [PLACE]: (e) => {
        // A comment is a task for the agent, and only the customer files one.
        if (this.viewer()) return;
        // And it is a task about the MODEL, so not while the scene is a
        // comparison's (`toolsOff`): the composer this opens would be headed
        // `plate #1` and post `/cmp/added/plate #1` as the part to change.
        if (this.toolsOff()) return;
        // Nor about a body of the proposal (`proposalBody`), for the same reason
        // read off the other source of parts: the composer would be headed
        // `motor` and post `/<root>/proposal/motor` as the part to change, and the
        // motor is the thing the model has to fit rather than anything in it.
        // The proposal travels by its own road — the record on the hub, which
        // the agent reads with `hammerola proposal` — and names no part at all.
        if (this.proposalBody(e.detail && e.detail.id)) return;
        const d = e.detail || {};
        // The row's name, found by looking the picked path up — the way onto
        // `composer.part` for a point placed in the scene (both ways are listed
        // on `measAdd`). `hmr:place` names the solid under the cursor
        // (`pickEntity`), so a point on the second copy arrives as `pin(2)`,
        // which no row carries once the run has collapsed; where it did not
        // collapse, the lookup finds that copy's row. `d.name` is kept only for
        // a path no row claims (a point placed before the tree landed).
        //
        // Bare, like `measAdd`: a point sits on one solid, so a count here would
        // tally parts the reader never touched.
        //
        // Two points on two collapsed copies therefore both read `pin`: the row
        // is what the reader can find in the tree. They stay distinct by the
        // pin on the model and by the posted `partId`, the copy's own path.
        const row = this.node(d.id);
        this.openComposer({
          part: (row && row.name) || d.name || 'model',
          partId: d.id || null, key: (row && row.key) || null, p: d.p || null,
          // The face normal at that point, turned towards the reader: the
          // direction the comment's arrow stands out along.
          n: d.n || null,
          text: '', photo: null,
          meas: this.state.measure ? this.state.measure.full : null,
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
      // The camera moved. A method, for the reason `onModel` is one.
      [CAMERA]: () => this.onCamera(),
    };
    Object.keys(this._h).forEach((k) => window.addEventListener(k, this._h[k]));

    // Escape closes what is open — a menu, a popover, an armed tool. It does
    // not close the composer: a half-written comment is the most expensive
    // thing on this page to lose, and Escape gets pressed by reflex. An Escape
    // that closed something is taken (`preventDefault()`): a KiCad design laid
    // over the model puts its selection out on an Escape nobody took
    // (KicadView.jsx), and listens after this page.
    //
    // Ctrl+Z and Cmd+Z take back the last thing done, of either kind: hiding,
    // ghosting or isolating in the tree, or a build part or proposal body
    // dragged or turned. `undoStep` tells them apart. Both chords for both
    // platforms; `preventDefault()` so the browser does not also act on it.
    //
    // Shift and Alt are ignored: there is no redo for Shift+Z to mean.
    //
    // Not while typing (`typingTarget()`): Ctrl+Z in the composer textarea is
    // the browser's own undo over the comment being written.
    //
    // The library cannot swallow this chord, so the listener stays in the
    // bubble phase with Escape's instead of capture like `holdkey.js`:
    // `_handleKeyboardShortcut` is bound on the container and returns before
    // its keymap whenever ctrl, alt or meta is down
    // (viewer/src/ui/display.ts:3203).
    this._kd = (e) => {
      // MATCHED ON `code` AND NOT ON `key`, for the reason `holdkey.js` gives at
      // length about the hold key: `code` is the physical key, so this fires on
      // a Cyrillic layout too, where the same key produces "я" and a `key` test
      // answers nothing at all — silently, with the reader's step un-taken and
      // the page giving no sign why. `key` is the fallback for the rare input
      // path that reports no code.
      const undo = e.code ? e.code === 'KeyZ'
                          : String(e.key || '').toLowerCase() === 'z';
      if ((e.ctrlKey || e.metaKey) && undo) {
        if (typingTarget()) return;
        e.preventDefault();
        this.undoStep();
        return;
      }
      if (e.key !== 'Escape') return;
      const shut = { menu: null, secPop: false, revOpen: false, dlOpen: false,
                     viewsOpen: false, opsOpen: false, settingsOpen: false,
                     notePop: null, tokenPop: false, tool: null, share: null };
      // An armed tool is not on screen under an open document — the document
      // covers the model and the tool's button is out of service — so it does
      // not count as something this Escape closed.
      const seen = (key) => this.state[key] && !(key === 'tool' && this.state.doc);
      if (Object.keys(shut).some(seen)) e.preventDefault();
      this.set(shut);
    };
    window.addEventListener('keydown', this._kd);

    // Back and forward through the revisions this page pushed. A switch is a
    // `pushState` (see `switchBuild`), so without this listener Back would
    // change the address bar and leave the previous revision on screen.
    //
    // The entry is read off `location`, never `event.state`: the entry may be
    // the server-rendered one, which carries no state of ours.
    //
    // Parsed by `pageFrom`, the page's own address arithmetic, because an entry
    // can name a comparison pair as well as a slot.
    this._pop = () => {
      const at = pageFrom(location.pathname);
      // "Is this the build we are already on" is not asked here: `PAGE.slot`
      // still names the build being left during a swap. `switchBuild` answers
      // it, against where the page is going.
      if (!at.slot) return;
      // THE BUILD FIRST AND THE PANEL AFTER IT, in that order because opening a
      // build is a fetch and the panel hangs off whichever one lands: a Back
      // that crosses both — from a comparison of `<a>` to another build — has
      // to leave the comparison of a build nobody is looking at any more.
      this.switchBuild(PAGE.pid, at.slot, { push: false })
        .then(() => this.syncCompare(at))
        .catch((error) => console.error('switch', error));
    };
    window.addEventListener('popstate', this._pop);

    // The window can cross the breakpoint while the page is open; turning a
    // phone sideways is a resize. The constructor's read is only the first
    // answer; this keeps it current.
    //
    // `addEventListener` on the MediaQueryList, not the deprecated
    // `addListener`, and kept with the window listeners so
    // `componentWillUnmount` removes it — a live query would `setState` on an
    // unmounted component.
    //
    // An armed tool does not survive the crossing into narrow: the narrow
    // branch drops the toolbar buttons that disarm it, and a phone has no
    // Escape key, so Measure would turn every touch into a measurement point
    // and Move would drag where an orbit was meant. Through `this.set`, since
    // the viewport holds the tool too and must be told; the wide direction is a
    // plain `setState`, since nothing is taken away.
    this._mq = window.matchMedia ? window.matchMedia(NARROW) : null;
    if (this._mq) {
      this._narrow = (e) => (e.matches
        // `opsOpen` AND `settingsOpen` GO WITH THE TOOL, and for the tool's
        // own reason. Their cards are inside `showTools` and unmount on their
        // own, but `toolbarStyle` reads the flags to raise the bar to z-17 over
        // the composer: left standing, a narrow window wears a toolbar lifted
        // for a menu that is not on screen, and the first click anywhere is
        // spent putting it down again.
        ? this.set({ narrow: true, tool: null, opsOpen: false, settingsOpen: false })
        : this.setState({ narrow: false }));
      this._mq.addEventListener('change', this._narrow);
    }

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
    if (this._mq) this._mq.removeEventListener('change', this._narrow);
    clearTimeout(this._tt);
    clearTimeout(this._poll);
    // And the nudge still waiting for the arrows to stop, which would otherwise
    // wake up and commit a number into a panel that is gone.
    clearTimeout(this._nudge);
    // And the proposal's save, for the same reason one step further out: it
    // would wake up and POST on behalf of a page nobody is looking at.
    clearTimeout(this._proposalSave);
    // And the camera's write into the address of a page that is gone.
    clearTimeout(this._camWrite);
    // The deferred swap goes with them: it holds `this` and would come back on a
    // component that is gone, to `setState` on it.
    clearTimeout(this._swap);
    // And every gap between two polls of a comparison job, which would
    // otherwise wake up and ask the hub about a job nobody is waiting for any
    // more. ALL of them: two comparisons can be in flight at once — a view tab
    // pressed while the first is queued starts a second — and `pause` keeps a
    // timer per wait for exactly that reason.
    (this._cmpWaits || new Set()).forEach(clearTimeout);
    // And so does a download chain still stepping. It touches no state, so it
    // survives an unmount perfectly happily — and goes on handing the browser
    // files of a build nobody is looking at any more.
    this.cancelDownloads();
    this._gone = true;
  }

  /**
   * A fresh draft in the composer, which takes the keyboard so the reader types
   * without clicking into it first. The two doors are the measurement's
   * `add to comment` and a point placed on the model — the second also over a
   * draft already standing, which it replaces. Only here: a draft carried
   * across a revision swap must not pull focus from wherever the reader moved
   * it.
   */
  openComposer(composer) {
    this.setState({ composer, tool: null }, () => {
      this.sync();
      if (this.compBox.current) this.compBox.current.focus();
    });
  }

  async load() {
    const meta = await loadMeta();
    // Asked for only with a token: the list is behind it, so a reader holding a
    // shared link sees that build and no picker (`builds` stays null).
    const builds = !this.state.token ? null : await loadBuilds(this.state.token).catch((error) => {
      // A project with no builds.json is a project whose picker is empty, not a
      // page that failed: the model in front of the reader is unaffected.
      console.warn('builds', error);
      return null;
    });
    const query = new URLSearchParams(location.search);
    const wanted = query.get('v');
    const opening = meta.views.find((v) => v.id === wanted) || meta.views[0];
    // `?d=` opens one of the build's documents over the model, as `?v=` opens a
    // view; the model loads underneath either way. An id the build does not
    // list is ignored (`docOpen` in chromeview.js looks it up).
    const doc = query.get(DOC_QUERY);
    // The arrival on the tab strip, recorded here rather than in
    // `componentDidMount` because this is the first moment a human-readable
    // project name exists; before `meta` lands there is only `PAGE.pid`.
    //
    // On arrival only. The in-place revision switch and the poll's refresh
    // replace `meta` without this line: same project, already on the strip.
    rememberTab(PAGE.pid, meta.title || meta.project);
    // `view` is what makes the viewport fetch and render: it starts null on both
    // sides, so this first sync is also the load.
    this.setState({ meta, builds, view: opening.id, doc, tabs: readTabs() },
                  () => {
                    this.sync();
                    this.schedulePoll(POLL_MS);
                    // A comparison link opens comparing. The address is the only thing that
                    // says a link was one, and the code above has opened `<a>`'s page from it,
                    // so this performs the picker tick the sender made. In the callback
                    // because `compareRevisions` snapshots the view off `this.state.view`,
                    // which the line above sets.
                    //
                    // On the view the address names: `opening` comes from `?v=`, which
                    // `moveAddress` writes via `viewQuery` (the one helper every address on
                    // this page uses). A comparison started on a non-default tab is sent as
                    // `…/compare/<b>/?v=<tab>`; on the first view `viewQuery` drops the query.
                    //
                    // A tab pressed later does not move the address, as on a build page: the
                    // query is written where the page navigates, and `showView` is not a
                    // navigation.
                    //
                    // Through `commitOf` for the ticks too: the Compare button asks with them,
                    // so an address whose `<a>` is `latest` must tick the commit it resolves to.
                    if (PAGE.cmp) {
                      const two = [PAGE.slot, PAGE.cmp]
                        .map((name) => this.commitOf(name));
                      if (two.every(Boolean)) this.setState({ cmp: two });
                      this.compareRevisions(two);
                    }
                  });
  }

  /**
   * Forget one project, and go nowhere.
   *
   * Including the tab the reader is on: a tab is a link, so closing it forgets
   * a link without leaving the page. The model stays, the address still names
   * this project, and since the address alone says which tab is active nothing
   * is left pointing at the forgotten one.
   */
  closeTab(pid) {
    forgetTab(pid);
    this.setState({ tabs: readTabs() });
  }

  // -- switching revisions in place -----------------------------------------
  //
  // Two revisions of one part are looked at from one angle: the reader aims
  // the camera, hides the shell, lays a section, and then wants the same view
  // of the previous build. A full page load would throw all that away, and
  // rebuild the same shell, bundle and viewer, differing only in one meta.json
  // and one view payload.
  //
  // What moves is therefore small: the address, `PAGE`, `meta`, and the two
  // numbers the viewport reads to know the geometry changed (`base` and
  // `buildKey`). Everything else is rebuilt from different data.

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
    // THE ADDRESS THIS BUILD HAS, computed once and read by both writers below —
    // the push that lands a swap, and the replace that calls one off. It sits
    // above the guards rather than beside the push because the cancelling branch
    // needs it to ANSWER a guard: whether the bar still names the build on
    // screen. One expression, so the two can never disagree about what the
    // address of a slot is.
    const path = `/project/${PAGE.pid}/${encodeURIComponent(slot)}/`;
    // "Already going there", which differs from "already here" and is what both
    // callers ask. `PAGE` moves only once a swap's fetch answers, so during one
    // `PAGE.slot` still names the build being left. `_want` is the destination:
    // the slot of the last accepted gesture, or `PAGE.slot` when nothing is in
    // flight. Asking `PAGE.slot` would let a picker click on the target of an
    // in-flight Forward push a duplicate history entry and lose the forward
    // history.
    //
    // The generation below is taken after this line: the gesture asks for what
    // is already on its way, so a bump here would kill the swap fetching it.
    const here = this._want || PAGE.slot;
    if (slot === here) { this.setState({ revOpen: false }); return; }

    // On screen but being left: this gesture asks to stay (reader on B, Back
    // starts a slow swap to A, Forward returns to B). Nothing to fetch, push or
    // leave; the in-flight swap is just called off.
    //
    // Running the whole swap instead would run `leaveBuild` over a build nobody
    // is leaving (losing selection, pins, the composer's part, the measurement)
    // and hand the viewport an identical payload (same `base`, `buildKey`,
    // `view`), which `element.js` treats as no change, so no `hmr:model` comes
    // back and `onModel` never spends `_refit` and `carry`. Those would then
    // fire on a later unrelated event: a live reload re-capturing the Fit frame,
    // and hidden parts rejoined by name onto the wrong tree.
    if (slot === PAGE.slot) {
      this._swapGen = (this._swapGen || 0) + 1;
      this._want = slot;
      // The swap that just died raised `swapping` on its way out and is not
      // coming back to put it down; nobody else would, and the banner's Switch
      // would sit spent for the rest of the page's life.
      this.setState({ revOpen: false, swapping: false });
      const views = (this.state.meta && this.state.meta.views) || [];
      // WHAT IS LEFT OUT OF STEP DEPENDS ON WHICH GESTURE CANCELLED, and the two
      // are exclusive: a `popstate` arrives with the address already correct and
      // possibly the wrong VIEW on screen, a picker click arrives with the view
      // untouched and possibly the wrong ADDRESS in the bar.
      if (push) {
        // The swap being cancelled may already have moved the address: a
        // `popstate` swap exists because the browser moved first. Forward onto
        // B, then a click on A's row still on screen, would leave the bar on B
        // with the page on A (`pageguard` reports "PAGE stopped describing the
        // address the browser is on").
        //
        // Replace, never push: the reader cancelled a navigation, so the entry
        // the browser moved to is corrected. A push would add an entry whose
        // Back returns to the declined build.
        //
        // Measured from the address, not inferred from a "came from popstate"
        // flag, which would duplicate a fact the address already carries.
        //
        // The target is not always `path`: if a comparison of this build is up,
        // the address describing the page is the comparison's. `addressOf`
        // answers that.
        const staying = this.addressOf(
          this.state.compare ? this.state.cmpPair : null);
        if (location.pathname !== staying) {
          history.replaceState({ hmr: slot }, '',
                               staying + this.cameraQuery(this.viewQuery(this.state.view, views)));
          // The repaired address may be a comparison's, so `PAGE.cmp` has to
          // follow it; on a plain build URL this re-derives what was there.
          rereadPage(staying);
        }
      } else {
        // The view may still be out of step: an entry carries its own `?v=`,
        // and Back onto a different tab of the build on screen is a real change.
        //
        // Written here, not through `showView`: during a comparison `showView`
        // restarts it, `compareRevisions` moves the address and `moveAddress`
        // pushes, so a `popstate` would end in a `pushState`, burying the entry
        // and losing Forward. A `popstate` never pushes.
        //
        // The panel is not this branch's to restore: `_pop` calls `syncCompare`
        // right after on the entry itself, which opens or closes the comparison
        // the entry names.
        const wanted = this.entryView();
        if (wanted !== this.state.view && views.some((v) => v.id === wanted)) {
          this.set({ view: wanted });
        }
      }
      return;
    }

    // Closed before the fetch: it is the only sign the click landed while the
    // page waits on the network.
    //
    // It is not a lock. `revToggle` reopens the menu and `onPick` calls this
    // again, and `popstate` never goes through the picker, so two swaps can be
    // in flight. Without ordering they would settle in network order (pick B,
    // pick C, end on B with the history walked backwards).
    //
    // So the newest gesture wins by number rather than by refusal: a picker
    // that ignores rows looks frozen, and "a newer gesture overrules an older
    // one" is already this file's rule (see the deferred take below). Back is a
    // gesture like any other and is meant to win.
    this.setState({ revOpen: false, swapping: true });
    // The number, taken after the guards above: they return without touching
    // anything, and a bump there would cancel a live swap for a gesture that did
    // nothing.
    //
    // Held locally, compared after every await. A superseded swap leaves without
    // a trace: no `setState`, no `pushState`, no `rereadPage`. The check comes
    // before the push because a history entry cannot be taken back.
    //
    // `swapping` belongs to the current swap and only it lowers the flag; a
    // stale swap answering 404 must not run `swapFailed` and re-enable the
    // banner's Switch while a live swap is on the wire.
    const gen = (this._swapGen = (this._swapGen || 0) + 1);
    // AND WHERE THIS PAGE IS NOW HEADED, for the guard above. Written together
    // with the generation because they answer the same question from two sides:
    // the number says which swap is current, this says which BUILD it is for.
    this._want = slot;

    // The banner's Switch is disabled for this window: the banner is not in the
    // picker. A click during this await would run `takePending` fully (meta
    // replaced, geometry fetched, "Now viewing …" toasted) and then this method
    // would land the requested revision on top. `swapping` is refused by
    // `takePending` and drawn by `bannerSwitchStyle`, so the button looks spent.
    //
    // Revision rows are not refused the same way: the banner offers one build
    // the reader already knows about, while refusing picker rows would refuse
    // the gesture instead of ordering two of them.

    // A deferred take of the banner's build is cancelled before the fetch too.
    // Switch waits while the reader's hand is on the model, retrying every
    // BUSY_RETRY_MS for up to BUSY_WAIT_MS (`takePending`), so its timer can
    // fire inside this await: one wasted load and a toast naming a build that
    // is not shown. It must be cancelled here, before the window it fires in.
    //
    // The offer survives: `pending` holds it and the banner stays, so if this
    // swap 404s `swapFailed` re-enables Switch. The waiting press is lost,
    // though, and the reader must press again — a newer gesture overrules an
    // older one.
    clearTimeout(this._swap);

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
    const views = Array.isArray(meta && meta.views) ? meta.views : [];
    if (!views.length) {
      this.swapFailed(slot, new Error('this build lists no views'));
      return;
    }

    // WHICH VIEW IS WANTED DEPENDS ON WHO MOVED. A row click carries the
    // reader's own tab across; a `popstate` is the browser putting an entry back
    // on the screen, and that entry's `?v=` IS the state being restored —
    // reading the current tab there would leave the address bar saying one view
    // while the page showed another, which is the whole failure this entry is
    // about, spelled with the Back button.
    const wanted = push ? this.state.view : this.entryView();
    // It survives when the target declares one with the same id, and otherwise
    // falls back to the first — exactly what a fresh load of that URL does with
    // a `?v=` naming a view the build does not have.
    const view = views.some((v) => v.id === wanted) ? wanted : views[0].id;
    // AND THE ADDRESS SAYS SO, by the same reading the cancelling branch above
    // writes its address with.
    const query = this.viewQuery(view, views);

    // Everything that described the build being left goes here; `takePending`
    // calls the same method. The plane is asked about the view actually landing
    // on screen: a `popstate` can restore a different view of the same parts,
    // and a depth measured on another arrangement is stale.
    //
    // The call must precede the `setState` below, which spreads its answer, and
    // `_refit` (set inside) must be standing before `onModel` lands. Neither
    // `rereadPage` (writes only `PAGE`) nor `setState({ meta })` touches `tree`;
    // the tree's writers are `onModel` (replace), `onViewError` (clear) and the
    // constructor (null).
    const gone = this.leaveBuild(view === this.state.view, meta);

    if (push) history.pushState({ hmr: slot }, '', path + this.cameraQuery(query));
    // In place, so every module that imported `PAGE` sees the new revision —
    // `loadMeta`, `loadBuilds`, `isPointerPage`, `sync`'s `base`, the comment
    // route, the download hrefs and the header's slot. Nothing re-derives it, so
    // skipping this would keep fetching the old revision.
    //
    // From the bar on a `popstate`, from `path` on a push: a `popstate` lands on
    // an entry this page wrote, which may be a comparison of the build being
    // opened, and re-deriving from `path` would leave `PAGE.cmp` empty under an
    // address naming a pair.
    rereadPage(push ? path : undefined);

    // Two things in flight were started against the old `PAGE.base` and cannot
    // notice the move, so the swap stops them here, once the move is certain.
    //
    // The poll is cut off by generation rather than by a timer, because what has
    // to be dropped is an answer that is already on the wire (`poll`).
    this._pollGen = (this._pollGen || 0) + 1;
    // The download chain is cut off outright: its hrefs were built from the
    // previous revision's base (`fileHref` reads `PAGE.base`).
    //
    // Both live outside `leaveBuild` because they go with the address, not the
    // build: `takePending` opens another build without moving the address, so
    // it wants that list and neither of these.
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
      // The picker's list catches up: builds.json is read once on mount, so
      // without this a session of switching would show stale history and could
      // not reach a newly published revision.
      //
      // After the swap, so the model does not wait on a list in a closed menu.
      // Best effort, as on first load: a missing builds.json is an empty picker,
      // not a failed page.
      this.refreshBuilds();
    });
  }

  /** Re-read builds.json into the picker — only with a token, which it is behind. */
  refreshBuilds() {
    if (!this.state.token) return;
    loadBuilds(this.state.token)
      .then((builds) => { if (!this._gone) this.setState({ builds }); })
      .catch((error) => console.warn('builds', error));
  }

  /**
   * The target would not open. Say so where a view that would not render is
   * said, and change nothing else.
   *
   * `viewError` is the panel for "what you asked to look at is not what is on
   * screen", and nothing moved before the fetch answered, so the previous
   * revision is still under the reader's camera. Its Retry re-renders the view
   * on screen; the way back to the failed build is the picker.
   *
   * The banner's Switch is re-enabled: the fetch is over and the offer on
   * `pending` is untouched, so it must not stay spent.
   */
  swapFailed(slot, error) {
    console.warn('switch', error);
    // THE PAGE IS NOT GOING THERE ANY MORE. `_want` is what the "already here"
    // guard reads for `popstate`, so a failed target left standing in it would
    // make Back onto the build actually on screen look like a real move — one
    // pointless fetch of the revision already there. Only the current swap
    // reaches this method (the generation is checked before the call), so this
    // cannot put back a destination a newer gesture has since chosen.
    this._want = PAGE.slot;
    this.setState({
      revOpen: false, swapping: false,
      viewError: `${shortId(slot)} did not load — still showing ${shortId(PAGE.slot)}`,
    });
  }

  /**
   * What goes when another build opens on this page — one list for both ways
   * in: `switchBuild` (the reader picks a revision) and `takePending` (the
   * reader accepts the banner's offer, equally a different commit). Both
   * spread it, so the list cannot drift between them: old pins on new geometry,
   * a draft posting one build's path and point against another's commit, a
   * stale section plane.
   *
   * `keepView` is whether the view id landing on screen is the one that was on
   * it, the strongest question the plane can be asked here (`sectionAcross`).
   * `next` is the meta.json of the build landing, asked whether it lists the
   * document open over the model.
   *
   * Returned in two halves because the section is two things: fields on this
   * side and an instruction to the viewport, which holds its own cut. A caller
   * that dropped `extra` would leave the plane in the scene with the slider at
   * zero.
   *
   * The side effects belong here too: each is about the build being left.
   *
   * Cutting off the download chain and bumping `_pollGen` are not here: they
   * go with the address, which `switchBuild` moves and `takePending` does not.
   * A chain running across the banner resolves against the pointer as asked,
   * and cutting it would silently truncate a group download.
   */
  leaveBuild(keepView, next) {
    const sec = this.sectionAcross(keepView);
    // The frame Fit goes back to belongs to the build it was measured on, and
    // this is another build. Spent by the model event that lands the swap; see
    // `onModel`, which is where the argument for it is written out.
    this._refit = true;
    // The comparison goes below, and with it a link's frame still waiting for
    // that comparison's scene, as in `leaveCompare`.
    this._linkCamera = null;
    // The toast goes: it sits for 2.6 s and says what the page was doing for the
    // build that has left, so it would otherwise stand over the new one saying
    // something that has stopped being true.
    clearTimeout(this._tt);
    // Hidden and translucent parts are held as leaf ids, and an id is a solid
    // path that a rebuild is free to renumber; a name is what the person
    // recognises and meant. Read here, while the tree on screen is still the one
    // those ids belong to, and rejoined against the new tree (`rejoin`). Both
    // ways in need it: without a carry the old ids would hide a different part
    // of the new build.
    //
    // Written only where there is a tree to read: `carry` describes the build
    // being left, and no tree means the names cannot be looked up, not that
    // nothing was hidden. After `onViewError` (tree cleared, carry unspent
    // because no model event arrived), opening another build must keep the
    // carry, to be spent by the next model event.
    //
    // A build with no solids is different: `indexTree` always returns an
    // object, so `state.tree` is falsy only where no model event ever landed
    // (initial state, `onViewError`); an empty real tree is truthy and clears
    // the carry, correctly.
    if (this.state.tree) {
      this.carry = { hidden: this.namesOf(this.state.hidden),
                     ghost: this.namesOf(this.state.ghost) };
    }
    // The undo stack goes, for both kinds of step: a visibility entry is leaf
    // ids of the build being left, which a rebuild may renumber onto other
    // parts; a document entry carries move nodes, which the `dropMoves` below
    // removes from the document. Steps are not carried across: a carry is one
    // snapshot resolved by name, the history a sequence.
    this.history = [];
    // WHAT OF THE PROPOSAL SURVIVES THE SWAP: the bodies, never the moves. It is
    // the document THE SWAP ESTABLISHES — `onModel` writes it for real when the
    // new build lands — and the shut eyes are pruned against it below, by the
    // one rule `movesOff` obeys everywhere.
    const left = dropMoves(this.state.proposal || emptyProposal());

    return {
      state: {
        // Cleared so the panel does not describe the build that has left. The
        // model event that lands this swap clears it again (`onModel`); this is
        // for the window before it arrives.
        viewError: null,
        // Momentary things go. A selection pointing at a part that may not exist
        // in this build is worse than no selection, and a menu or a popover that
        // outlived the model it was opened over is a menu about nothing.
        //
        // The tree is not cleared: `onModel` replaces it when the view lands, and
        // clearing it would blink the panel empty on every successful switch.
        // A view that never lands is handled in `onViewError`.
        sel: null, selName: '', menu: null,
        // The document over the model stays where the build landing lists it
        // too, and otherwise goes for good: left standing, it would lay itself
        // over the model again the moment the reader came back to a revision
        // that lists it.
        doc: next && Array.isArray(next.documents)
          && next.documents.some((d) => d.id === this.state.doc) ? this.state.doc : null,
        // The comparison goes too: the panel stands where the tree stands and
        // the scene is the comparison's, so keeping it would change nothing the
        // reader sees. The picker's ticks (`cmp`) stay: they are the reader's
        // choice of revisions.
        compare: false, cmpPair: null, cmpView: null, cmpStage: null,
        cmpError: null, cmpReport: null, cmpSel: null,
        revOpen: false, dlOpen: false, viewsOpen: false, secPop: false,
        tokenPop: false, tokenDraft: '', notePop: null, noteDraft: '',
        // It describes geometry that has just left the screen; the viewport
        // clears its own tape on every load. The offsets are the same kind of
        // thing and are not here: they live in the proposal document now, and
        // `onModel` drops them when the build that lands is a different one.
        measure: null,
        // AND THE EYES THE READER SHUT ON THOSE OFFSETS GO WITH THEM, by the
        // one rule `movesOff` obeys everywhere: it may name only move nodes
        // the document still has (`eyesKept`, and the constructor carries the
        // argument). Asked of `left`, which is the document THE SWAP
        // ESTABLISHES — the same anticipation the composer block below makes,
        // and `onModel` writes it for real when the new build lands. It holds
        // no move node, so the rule answers with an empty list.
        movesOff: eyesKept(this.state.movesOff, left),
        // AND THE SNAP STEPS BY THE RULE OF THEIR OWN (`snapsKept`), asked of
        // the same anticipated document. It holds no move node, so a step set
        // on one goes; a body's survives, since a body is the reader's own and
        // crosses the swap with the rest of the document.
        snapSteps: snapsKept(this.state.snapSteps, left),
        // Whichever build was on offer, it has been answered — taken by
        // `takePending` or made irrelevant by `switchBuild` moving the road. The
        // BANNER is the callers' own business, because "taken" and "no longer
        // on this road" are different answers.
        pending: null,
        // THE QUEUE ITSELF STAYS, because it is the PROJECT's and not this
        // build's: the same items are open on the revision being opened, and
        // `loadFeed` is not asked again for a swap. What goes is the pin the
        // reader had opened — it named a comment drawn over geometry that has
        // left. Where each item hangs on the new build is not carried across
        // either, because it is not stored: `sync` asks `anchorFor` for it on
        // every frame, and the tree that answers arrives with `onModel`.
        activePin: null,
        // The text survives the swap and nothing positional does: what the
        // reader wrote versus what this page measured.
        //
        // The sentence is the reader's own and the most expensive thing to lose
        // (the reason Escape spares it), and it is often still true. Everything
        // else in the draft is a coordinate taken off geometry that has left
        // (which solid, where, a measurement), and `sendComment` posts to
        // `meta.commit`, which is the new build's once this lands.
        //
        // The part's name goes too, though a name outlives a rebuild:
        // `composerPart` renders it and `sendComment` sends `partId`, so a kept
        // name would show an attachment the post lacks. Re-attaching to the
        // same-named part would aim the comment at geometry nobody looked at.
        //
        // The catalogue key goes with the name: the composer shows only `part`,
        // so a kept key would look unattached and post anchored. Both go, or
        // neither.
        composer: this.state.composer
          ? {
            ...this.state.composer,
            part: '', partId: null, key: null, p: null, n: null, meas: null,
          }
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
   * A plane is a number in model space, and the model may have moved under it.
   * It survives only with the same view id (same layout) and an offset still
   * inside the slider's extent; elsewhere the cut would slice empty air or the
   * middle of an unrelated part.
   *
   * The range is the one measured on the build being left: the hub publishes
   * no extent, and the new build has none until a face is picked. So this errs
   * toward putting the plane away.
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
   * A name not in the new tree is dropped: a part that is gone cannot stay
   * hidden.
   *
   * Consumed rather than read, so exactly one model event acts on a switch.
   * After a failed switch that event never arrives, and the carry is spent on
   * the next render instead, which is equally correct.
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
   * One gesture of the scene written into the proposal, whichever field of the
   * node it was about: `said` is `delta` for a drag (`hmr:moved`) and `turn`
   * for a ring (`hmr:turned`), and everything else here is the same sentence.
   *
   * One function for both so they cannot drift. A move node holds a
   * displacement and a rotation, both from where the build puts the part; each
   * gesture sets one and must leave the other alone, so the rules below cover
   * which nodes a set of paths touches, what happens to them, and how the
   * untouched field is carried.
   *
   * A method rather than a closure in the handler map (as with `onModel`):
   * the map is built in `componentDidMount`, so a closure could only be tested
   * by mounting the whole page.
   */
  recordGesture(detail, said) {
    // Not while the scene is a comparison's (`toolsOff`): what this records
    // is a node of the proposal naming a part in the BUILD's terms, and the
    // paths of a comparison's scene are `/cmp/…` — a displacement of a part
    // no revision has, in a document the agent reads as a statement about
    // this one.
    if (this.toolsOff()) return;
    // A proposal body never reaches here: the viewport tells the gestures apart
    // at the press and sends a body's drag or turn on `hmr:proposalmove` /
    // `hmr:proposalturn` (`editBody` below). A body's own `at`/`rot` are
    // edited, because the reader placed it; a build part gets a move node,
    // because the model is untouched and the gesture is the statement.
    const values = (detail && detail[said]) || [];
    if (values.length !== 3 || !values.every(Number.isFinite)) return;
    // The name is the row's, found by looking the dragged path up via the same
    // `node()` the pick handler and the menu header use. The viewport names the
    // solid it grabbed (`pin(2)`), which no row carries once the run has
    // collapsed; where it did not collapse, that copy is its own row. A lookup
    // by path; `e.detail.name` is kept only for a path no row claims (a drag
    // before the tree landed).
    //
    // Resolved once and kept on the node: the document outlives the tree it
    // was read from, and a later collapse would leave no row under `pin(2)`.
    //
    // The count stays the viewport's: a drag begun with nothing selected moves
    // the one copy it grabbed out of a row of five, so the row's count would
    // write "×5" into a sentence about one part.
    const paths = Array.isArray(detail.paths) ? detail.paths : [];
    if (!paths.length) return;
    // The report can outlive the build it was measured on. The viewport defers
    // this event by a microtask (`reportModelMove` in viewport/tools.js), and
    // `show()` ends the gesture and dispatches `hmr:model` with no await
    // between, so a rebuild landing mid-drag reaches `onModel` first (dropping
    // the moves) and this report arrives with paths and an offset of the old
    // assembly. Written down, it would displace a part of the new build.
    //
    // Compared against `buildKey(meta)`, the same string the viewport was
    // handed in `hmr:state`.
    if (detail.build !== buildKey(this.state.meta)) return;
    // The step is recorded after the last guard (a refused gesture leaves
    // nothing on the stack) and before the write (the entry describes the
    // document the reader saw). It holds the whole document by reference:
    // proposal.js helpers return new documents and mutate nothing.
    //
    // Outside the updater, like the id below: React may call an updater more
    // than once, and a push inside would add a step per call.
    this.recordStep({ kind: UNDO_DOCUMENT,
                      doc: this.state.proposal || emptyProposal() });
    // THE NAME IS THE ROW's, resolved before the write for the reasons above
    // — and read here rather than inside the updater because the TREE is not
    // what the updater is guarding: a build landing between these two lines
    // is what the stamp already turned away.
    const row = this.node(detail.id);
    const name = countedName((row && row.name) || detail.name,
                             detail.count);
    // Nothing is rounded here: rounding belongs where the arithmetic is. `snap`
    // in viewport/tools.js rounds its own result by `tidy`, the rings round to
    // whole degrees and `tidy` their sum, `moveNodes` rounds `at + delta`. This
    // handler only carries a number across.
    //
    // `kept` names the node's other field, which this gesture did not touch and
    // must not invent: a drag says where, a turn says which way it faces.
    const kept = said === 'delta' ? 'turn' : 'delta';
    // A gesture that returns its own field to nothing is a retraction, not a
    // move or turn of zero. The viewport reports nothing unless something was
    // standing (`reportModelMove`, `reportModelTurn`), so this is the reader
    // taking it back by hand, and the node is removed rather than leaving
    // `move "plate" by (0, 0, 0)` in the projection.
    //
    // Only this gesture's own field counts; the other half is asked inside the
    // updater. A translation back home does not retract a rotation the reader
    // set in a row, and vice versa for a ring.
    const flat = values.every((value) => value === 0);
    // One node per part, replaced and never added up. The viewport reports
    // cumulatively from where the build puts the part (each press starts from
    // the standing offset and angles: `vp.moved.get` in viewport/tools.js and
    // viewport/rings.js), so adding a second gesture would double it.
    //
    // Matched by intersection, not by first path: a gesture's paths are the
    // selection's, which moves (a drag out of a collapsed row with nothing
    // selected takes one copy and re-selects the row), so first-path matching
    // would write two contradictory nodes for one copy.
    //
    // Where several nodes are covered whole, all go: one gesture superseded
    // them.
    //
    // A partly covered node is subtracted from, not dropped: five copies at +3,
    // then one nudged to +8, leaves four at +3 and one at +8. Dropping the old
    // node would send the other four home on the next push. Either way no path
    // is claimed twice.
    //
    // Computed inside the updater: this is a read-modify-write, and `onModel`
    // patches the document functionally, so a swap landing between a read of
    // `this.state` and an object patch would be overwritten and the moves
    // `dropMoves` removed would return.
    //
    // The id is minted before the updater so the updater stays pure (React may
    // call it more than once).
    this._proposalSeq += 1;
    const id = `m${this._proposalSeq}`;
    this.setState((s) => {
      const doc = s.proposal || emptyProposal();
      const touching = moves(doc).filter(
        (node) => node.paths.some((path) => paths.includes(path)));
      const covered = touching.filter(
        (node) => node.paths.every((path) => paths.includes(path)));
      // The shrunk node is renamed: the name was resolved once and carries the
      // count (`countedName`), so `pin ×5` on a node now holding four paths
      // would be false in the projection and the tree. Re-resolved like the
      // record does (the row under the first remaining path, counted by what
      // remains); where no row claims that path, the existing name is kept.
      const trimmed = touching.reduce((doc_, node) => {
        if (covered.includes(node)) return doc_;
        const rest = node.paths.filter((path) => !paths.includes(path));
        const rowLeft = this.node(rest[0]);
        return updateNode(doc_, node.id, {
          paths: rest,
          name: rowLeft ? countedName(rowLeft.name, rest.length) : node.name,
        });
      }, doc);
      const without = () =>
        covered.reduce((doc_, node) => removeNode(doc_, node.id), trimmed);
      // The one covered node is edited in place, not replaced: a second gesture
      // over the same paths restates the same sentence with a new number (the
      // report is cumulative). A fresh id would remount its row in the branch
      // (`proposalRows` keys on the id) and move its line to the bottom of the
      // projection.
      //
      // The field that node already carries survives, because this patch does
      // not name it.
      //
      // A minted node takes what the nodes it touches agree on (read with
      // `delta`/`turn` either way round; hence `kept`). No gesture may undo the
      // half it did not touch: minting at zero after superseding several nodes
      // would straighten copies turned together, and minting at zero for a copy
      // taken out of a turned row would straighten that one, since the old
      // node still claims the rest and nothing is covered.
      //
      // `touching`, not `covered`, handles the second case: it is every node the
      // gesture's paths meet, whole or in part. Where they disagree, zero is the
      // honest answer; with no nodes it is the only one.
      //
      // A partly covered node keeps its own field too (`trimmed` patches only
      // its paths and name), so a copy taken out of a turned row and the copies
      // left behind face the same way.
      //
      // Accepted limitation: a merge can turn a copy nobody turned. Dragging a
      // turned part and an untouched one as one row gives both the turn,
      // because one node keeps one turn for all its paths (the property that
      // makes `pin ×5` one row). The alternative, zero, would undo a turn the
      // reader set, and a gesture must not undo what it did not touch.
      const carried = touching.map((node) => node[kept]);
      const agreed = carried.length > 0 && carried.every(
        (one) => one.every((value, axis) => value === carried[0][axis]));
      const shared = agreed ? carried[0] : [0, 0, 0];
      // A retraction is a gesture home of something that says nothing else.
      // Dragging a part back while a turn stands keeps the node with a zero
      // delta (still turned, the row says so, `×` undoes it); likewise turning a
      // displaced part back square. That is the single-covered branch below.
      //
      // Asked of `shared`, what the node would actually carry, not of the
      // fields: a row of copies turned to different angles dragged home has
      // disagreeing turns, so the node would be minted at zero and print
      // `move "pin ×3" by (0, 0, 0)`.
      const retract = flat && shared.every((value) => value === 0);
      // WHAT THIS GESTURE SAYS, ASSEMBLED BY ASSIGNMENT rather than written as
      // a literal with a computed key — and that is not taste.
      // `tests/test_ui_source.py` reads every `[NAME]:` in this file as a key
      // of the handler map and insists it be an event constant imported from
      // events.js, so a computed key here would read as a listener for an
      // event nobody declares.
      const patch = { paths, name };
      patch[said] = values;
      // A gesture that writes into a move node opens that node's eye: dragging
      // a part says "it stands here", which is meaningless while the part shows
      // where the build puts it. Answered here because the viewport knows
      // nothing of the flag (`proposalMoves` is its one door) and the single
      // covered node keeps its id; left shut, the next push would undo the
      // offset just made, and send home any other part sharing the node.
      //
      // `covered` is also every node the other two branches drop, so this line
      // carries the `eyesKept` rule too. A minted id is fresh and cannot be on
      // the list.
      const wrote = new Set(covered.map((node) => node.id));
      const eyes = (s.movesOff || []).filter((shut) => !wrote.has(shut));
      let next = null;
      if (retract) next = without();
      else if (covered.length === 1) {
        next = updateNode(trimmed, covered[0].id, patch);
      } else {
        const minted = { id, role: 'move', ...patch };
        minted[kept] = shared;
        next = addNode(without(), minted);
      }
      // A displacement is on screen as soon as it is made; nothing is raised
      // for it: the row saying the part is displaced, and the `×` sending it
      // home, are in the tree's branch, drawn from the document alone.
      // The steps are pruned against the result, not `covered`: a gesture opens
      // the eye of every node it writes, but a snap step is the reader's choice
      // and survives another drag. Only an id whose node is gone goes, and only
      // the resulting document knows which; `snapsKept` asks it.
      return { proposal: next, movesOff: eyes, snapSteps: snapsKept(s.snapSteps, next) };
    }, () => {
      // The offsets, not the bodies: staging would run `buildProposal` (the CSG,
      // 23 ms at four bodies and 81 at twelve, measured at `field` in
      // `computed`) over every body, and `sameParts` in element.js only spares
      // the scene rebuild after that. A move node changes no body.
      //
      // Read back from state, not carried from the updater: another functional
      // patch may be batched behind it, notably `onModel`'s `dropMoves`, and
      // pushing the updater's document would displace a part of the new build by
      // a node the committed document no longer holds. In a completion
      // callback, `this.state` is the commit.
      //
      // `proposalMoves`, not `setProposal`: the latter writes `proposal` as an
      // object patch, which after a swap would restore every node it removed.
      // The document is committed; only the scene needs updating.
      const done = this.state.proposal || emptyProposal();
      this.proposalMoves(done);
      // AND THE STEPS WITH THEM, because this gesture DELETES move nodes — a
      // retraction takes one out, a merge takes several — and the set the
      // viewport holds is keyed by path. Pushed only from `stageProposal`, the
      // entry of a node this gesture has just removed would go on rounding the
      // next drag of that same part while the row that set it, and the field
      // that could clear it, are both gone. `proposalSnaps` walks the live
      // nodes, so the removed ones fall out of the set by themselves.
      this.proposalSnaps(done);
      // Saved from here, because this gesture bypasses `setProposal`, the only
      // other place the save hangs off. Dragging or turning a build part adds a
      // node and a projection line the agent reads; skipping the save would
      // silently lose exactly the nodes the `published`/`view` stamps exist to
      // restore.
      //
      // The committed document, not the updater's, for the same reason as the
      // pushes above.
      this.saveProposal(done);
    });
  }

  /**
   * A gesture on a body of the proposal: `name` is the body the viewport says
   * the hand was on, `values` the three numbers it produced, and `apply` the
   * document's own function for them — `moveNodes` onto the body's `at` for a
   * drag, `turnNodes` onto its `rot` for a ring.
   *
   * One function for both, as `recordGesture` is for its pair; only the field
   * differs, and the viewport already split that into two events.
   */
  editBody(name, values, apply) {
    // The same gesture as above with the opposite meaning. A build part moved
    // or turned is a statement to the agent and changes nothing; a proposal body
    // is the reader's own drawing, so this is an ordinary edit, the same as
    // typing into the `at` or `rot` fields: it goes through `setProposal` and
    // writes no move node. The branch lists the body with a `×` that deletes
    // it, whether or not the sheet is open.
    //
    // Not guarded by `toolsOff`: a proposal names no part, so it has no
    // `/cmp/…` path to file, and is as true over a comparison as over a build.
    if (!Array.isArray(values) || values.length !== 3
        || !values.every(Number.isFinite)) return;
    const doc = this.state.proposal || emptyProposal();
    // One body answers, the one under the cursor. The proposal's payload gives
    // each solid and each hole its own part (proposalgeom.js), so a gesture is
    // about the single node that part came from and its neighbours stay put:
    // a proposal is assembled by shifting and turning pieces against each other.
    //
    // By name, which both halves share: the body's name in the document is the
    // part's `name` in the payload, and `freeName` keeps them unique. A name no
    // node answers to changes nothing (the document was edited elsewhere
    // meanwhile).
    //
    // Among the bodies alone (`bodies`): a move node carries a build row's name,
    // which may coincide with a body's, and has no `at` or `rot`.
    const ids = bodies(doc)
      .filter((node) => node.name === name)
      .map((node) => node.id);
    if (!ids.length) return;
    // The step is recorded on the `recordGesture` rule: after every guard, so a
    // refused gesture leaves nothing on the stack, and before the write, so the
    // entry is the document the reader saw. `doc` is not copied: `apply`
    // returns a new document.
    //
    // The draft is not part of the step: Ctrl+Z restores the document, not a
    // half-typed field the reader abandoned by grabbing the body.
    this.recordStep({ kind: UNDO_DOCUMENT, doc });
    // The draft goes first, as in `commitProposal`: a field renders from
    // `proposalDraft` while one stands on its key, and unlike a button click a
    // gesture does not blur the field (`onDown` calls `preventDefault` in the
    // capture phase). Left standing, the row would show stale typed text, and
    // the later blur would commit it over the axis the hand just wrote.
    this.setState({ proposalDraft: null });
    // `KEEP_STEPS`, because this edit's step was just pushed above. Dropping
    // the rest would cut the stack to that one step, so a second body gesture
    // could not be walked back past the first, and the next press would reach
    // an older visibility step instead.
    this.setProposal(apply(doc, ids, values), KEEP_STEPS);
  }

  /**
   * A view finished rendering, and brought the tree with it.
   *
   * A method rather than a closure in the handler map (as with `sceneMenu`):
   * the map is built in `componentDidMount`, so a closure could only be tested
   * by mounting the whole page.
   */
  onModel(detail) {
    const d = detail || {};
    const tree = indexTree(d.tree);
    // Non-null only while a revision switch is landing. Every other model event
    // — a first load, a live reload, a view tab — leaves the two lists alone.
    const rejoined = this.rejoin(tree);
    // A COMPARISON'S SCENE IS NOT ONE OF THIS BUILD'S VIEWS, and the id it
    // arrives under is the comparison's own (`hub.compareView`). Written into
    // `view` it would leave the page believing the build is showing a view that
    // is not in its `meta.views` — no tab lit, and on the way back out `sync`
    // would ask the viewport for a view the build does not have, which the
    // element answers by rendering the first one instead. So the field the build
    // page keeps is left exactly where the reader left it.
    const compared = !!this.comparePair();
    // RESOLVED OUT HERE, where reading the element is allowed, so the updater
    // below stays a pure function of the state it is handed. `stagedSelection`
    // says what it is for: a body selected before it was staged has its row's
    // identity change underneath it the moment the scene answers, and this is
    // the moment. It is handed `compared` for the reason written on it — a
    // re-stage under a comparison brings a tree whose overlay is the
    // comparison's, and that path must not become the page's selection.
    const overlay = this.overlayRoot(tree);
    // The stored steps get the same rule the live document gets below, out here
    // because `this.history` is not state and the updater must stay pure.
    //
    // A document step is a document: its moves were measured against the build
    // that just went, and a path like `/model/pin(2)` is handed out afresh by
    // the tessellator, so Ctrl+Z after a rebuild would displace whatever has
    // that name now. `leaveBuild`'s clear does not apply: a live rebuild is not
    // a swap, and the history is kept across one.
    //
    // Visibility steps are left whole, like the `expanded` line below: part
    // paths survive a rebuild, so hidden names stay true.
    //
    // A step the prune made into a no-op goes: once both sides lose their moves
    // it equals the document on screen, so the chord would change nothing
    // visible yet pay a `buildProposal` and a restage. In the ordinary cycle
    // (the author editing `model.py` while the page rebuilds) these would pile
    // up as dead presses before a stale un-hide.
    //
    // Compared as serialised strings, as `saveProposal` does (`body ===
    // this._proposalSent`): one notion of equality on this page.
    //
    // A step that still differs in any way stays: it is a step back to
    // somewhere.
    if (!d.restage) {
      const live = JSON.stringify(dropMoves(this.state.proposal
                                            || emptyProposal()));
      this.history = this.history
        .map((step) => (step.kind === UNDO_DOCUMENT
          ? { ...step, doc: dropMoves(step.doc) } : step))
        .filter((step) => step.kind !== UNDO_DOCUMENT
                          || JSON.stringify(step.doc) !== live);
    }
    this.setState((s) => ({
      tree,
      ...stagedSelection(overlay, tree, s, compared),
      view: compared ? s.view : (d.view || s.view),
      viewError: null,
      // Both belonged to the scene that has just been torn down: the
      // viewport clears its own tape and offsets on every load, and a
      // measurement left here would describe a model that is gone. The moves
      // are the same statement in the document's terms (a delta against where
      // one build put one part), so they go too; `dropMoves` leaves the bodies
      // as they were, since the motor the model must clear is as true of the
      // arriving build.
      //
      // A re-stage is the only exception: the viewport composes the proposal
      // over the same document (`restage` in viewport/element.js), nothing
      // moved, and the viewport keeps its own halves of these two. Dropping
      // them would erase the measurement and the drag whenever a number changed
      // in an unrelated panel.
      //
      // The per-move eyes go with the nodes by the `eyesKept` rule (see the
      // constructor). Written as the rule rather than as `[]`, so this site
      // cannot drift from it; `dropMoves` is pure, so calling it twice is
      // safe.
      ...(d.restage ? null : {
        measure: null, proposal: dropMoves(s.proposal || emptyProposal()),
        movesOff: eyesKept(s.movesOff,
                           dropMoves(s.proposal || emptyProposal())),
        // AND THE STEPS OF THOSE MOVES, by `snapsKept` — the same sentence one
        // rule over. The viewport's own half of this is cleared where the other
        // per-path maps are (`show()` in viewport/element.js), because a path
        // is only as stable as the build that minted it.
        snapSteps: snapsKept(s.snapSteps,
                             dropMoves(s.proposal || emptyProposal())),
      }),
      // The reader's own collapses survive: part paths are the same across a
      // rebuild, and this is the tree they were reading a moment ago.
      expanded: { ...this.defaultExpanded(tree), ...s.expanded },
      ...(rejoined || null),
    }), () => {
      // Not on a live one: `home` is the frame the library fitted, and a live
      // reload restores the reader's own frame, so re-reading it would make Fit
      // do nothing.
      //
      // Opening another build is the exception, signalled by `_refit` from
      // `switchBuild` and `takePending`. Both travel the live path (the frame is
      // carried over on purpose), but the camera now shows a different build,
      // and Fit promises "back to the frame this view opened in". Clearing
      // `home` instead would make Fit report nothing to fit to.
      //
      // Spent here, not at either setter, like `carry`: one model event acts on
      // a swap, and if a swap's view never renders the next live build takes
      // the flag, which is the same operation.
      if (!d.live || this._refit) this.captureHome();
      // The frame the address was opened with (`c=`), put on screen by the
      // page's first model event and by no later one. After `captureHome`, so
      // `home` stays the library's own fit and Fit still goes back to it.
      //
      // On a page opened as a comparison the frame is the comparison scene's,
      // and the build's own view renders first (`load` syncs it before
      // `compareRevisions` has a scene to show), so only the scene spends it —
      // unless the comparison has already ended without one (`sceneNeverCame`):
      // without a token it is `locked` before any view has rendered.
      const forScene = !PAGE.cmp || compared
        || this.state.cmpStage === 'locked' || this.state.cmpStage === 'failed';
      const opened = forScene ? this._linkCamera : null;
      if (forScene) this._linkCamera = null;
      const el = this.el();
      if (opened && !d.live && el && typeof el.setCamera === 'function') el.setCamera(opened);
      // A scene drawn afresh fitted the camera afresh, so the address is
      // rewritten from the camera rather than left naming the frame of the
      // scene that went — and with the view on screen, since a view tab moves
      // no address (`showView`) and a frame under another view's `v=` would
      // aim at the wrong layout. Here and not in the debounce: a timer firing
      // during a `popstate` switch would rewrite `v=` before `switchBuild`
      // reads the entry's own (`entryView`). A comparison's view is `cmpView`.
      //
      // A live one kept the reader's frame. On Back and Forward the restored
      // entry carries its own older `c=`; the library's end-of-render camera
      // report (`onCamera`) rewrites it to the frame that was kept.
      if (!d.live) this.writeCamera(compared ? this.state.cmpView : this.state.view);
      this._refit = false;
      // The stored document is adopted here, in the callback, because only now
      // are both preconditions true: a view has rendered (`meta` is in) and the
      // `dropMoves` above has run. Adopted earlier, the stored moves for this
      // build would be wiped by that line. `adoptProposal` checks both rather
      // than trusting the order, since it is also called from the other side.
      //
      // Only the adoption is here: `loadProposal` still fetches when the token
      // arrives, and whichever of the two lands last adopts. One shot (it
      // spends the record), and the re-stage it causes comes back through here.
      this._modelSeen = true;
      this.adoptProposal();
      // The snap steps are handed over again: the element cleared its half with
      // the offsets when this scene loaded (`show()` in viewport/element.js),
      // since a step is keyed by a path that is only as stable as its build.
      // The page's half is pruned above, not cleared: moves went with
      // `dropMoves`, but a body crosses the rebuild with the document, and so
      // does its step. Nothing else pushes after a model event (`stageProposal`
      // is not on this path).
      //
      // From the tree that just landed, hence here and not in the updater: a
      // body's path is spelled against the overlay's group, which
      // `proposalSnaps` reads from `state.tree`.
      this.proposalSnaps(this.state.proposal || emptyProposal());
      // The rejoined ids have to reach the viewport, and a state event is the
      // only way there — but every model event needs this one now, rejoin or
      // not: the tree that has just landed is what the comment pins hang on, so
      // a rebuild that renumbered or moved a part moved every pin with it.
      this.sync();
    });
  }

  /**
   * A view would not render. A page that shows nothing has to say why, or the
   * interface draws a frame around a hole.
   *
   * `setState`, not `set()`: `set()` ends in `sync()`, which dispatches
   * `hmr:state`, on which the viewport decides to load — reporting a failure
   * through it would retry the same fetch forever. The viewport keeps its own
   * half (`loadFailed` in viewport/element.js); both are needed.
   *
   * The tree goes when the failure is a swap's. `leaveBuild` leaves the tree
   * for `onModel` to replace, so successful switches do not blink the panel
   * empty. When the view does not land, no `onModel` arrives, and the page is
   * half moved: `meta`, the title, the picker and `PAGE.base` are the new
   * build's while the panel lists the old parts, so `authorNote` would look
   * their keys up in the new `meta.parts` and row menus would link into the
   * new base. So the tree is cleared here, where the failure is known.
   *
   * `_refit` answers "did a swap's model never arrive": set by `leaveBuild`,
   * spent by `onModel`, so true exactly between another build opening and its
   * geometry landing. Not spent here: a successful Retry is still that swap's
   * first model event, and Fit must be re-homed on it.
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

  /** The ROW a path belongs to — its own, or the one that collapsed it. */
  node(id) {
    const tree = this.state.tree;
    return id && tree ? tree.nodes.get(id) || null : null;
  }

  /**
   * The solids the selection covers, as the viewport wants them.
   *
   * A list, because a row may stand for five copies of one part and selecting
   * it lights up all five. An ordinary leaf answers with its one path.
   *
   * A group keeps its own id and is not expanded to its leaves: `selectSolid`
   * does nothing with a node path, so selecting an assembly highlights nothing,
   * and lighting everything under it would be a separate feature. `[sel]` when
   * there is no tree yet.
   *
   * A copy of `leaves`, because the viewport keeps what it is given
   * (`applied.selected` in element.js), and the tree's list is what the eye,
   * the ghost square and Isolate are expressed in: a sort or splice there would
   * silently edit the tree.
   */
  selectedPaths() {
    const node = this.node(this.state.sel);
    if (node && !node.isNode) return node.leaves.slice();
    return this.state.sel ? [this.state.sel] : [];
  }

  // -- comparing two revisions ----------------------------------------------
  //
  // The reader ticks two revisions in the picker and presses Compare; the hub
  // measures the geometry and publishes two documents; this page shows the
  // scene in its existing viewport and the report where the tree usually is.
  //
  // One scene and one viewport: `hmr:state` goes out on `window` with nothing
  // saying which element it is for, so a second `<hmr-viewport>` would answer
  // every patch too.

  /**
   * The commit a revision name stands for, or '' where there is none.
   *
   * A comparison is always between two commits. The hub refuses a pointer as
   * an end of a pair (src/app.py; SPEC 3 says why): the comparison cache files
   * entries under the names asked with, so one under `latest` would go stale.
   * So the asking side resolves, via the commit id `builds.json` carries for
   * `latest`.
   *
   * `dev` resolves to nothing: `has_dev` is a flag and the slot has no
   * permanent address. Every caller reads '' as "this revision cannot be
   * compared".
   */
  commitOf(name) {
    const info = this.state.builds;
    if (name === 'latest') return (info && info.latest) || '';
    if (name === 'dev') return '';
    return name || '';
  }

  /**
   * The pair whose scene is on screen, or null — the question `sync` asks to
   * decide which document the viewport is pointed at.
   *
   * Null while the job runs: the scene does not exist until the hub computes
   * it, and pointing the element at it early would replace the build with the
   * failed-view panel while the compare panel already explains the wait.
   */
  comparePair() {
    const s = this.state;
    return s.compare && s.cmpStage === 'ready' && s.cmpView
      && Array.isArray(s.cmpPair) && s.cmpPair.length === 2 ? s.cmpPair : null;
  }

  /**
   * Every solid the selected report row stands for, in the comparison's tree.
   *
   * By catalogue key, not path: the comparison draws one part up to four times
   * (each revision, each difference group) and the report has one row for it,
   * so all four light up.
   *
   * The key is available because `scene.json` is an ordinary view document:
   * the hub refuses a view leaf without a key (`check_view_file`), and
   * `treeFromShapes` carries it onto every leaf row. Names are not identities
   * (the tessellator numbers repeats apart).
   */
  comparePaths() {
    const { cmpSel, tree } = this.state;
    if (!cmpSel || !tree) return [];
    return tree.leaves.filter((path) => {
      const node = tree.nodes.get(path);
      return !!node && node.key === cmpSel;
    });
  }

  /**
   * The one way into the panel: the Compare button, Try again beside a
   * failure, a view tab pressed while a comparison is up, a link opened cold
   * (`load`) and a `popstate` onto one (`syncCompare`) all come here.
   *
   * The pair and the view are snapshotted before anything is fetched, and every
   * step checks both are still current (`onCompare`): the reader may change
   * ticks and tabs while it runs, and a late answer would pair one
   * comparison's report with another's scene.
   *
   * Both ends are resolved to commits here, once: the hub accepts neither
   * `latest` nor `dev` as an end (`commitOf`). A name resolving to nothing does
   * not open the panel; the picker offers no tick on such a row, so only a
   * typed address gets here, and the hub 404s that address too.
   */
  compareRevisions(pair) {
    const two = (Array.isArray(pair) ? pair.slice(0, 2) : [])
      .map((name) => this.commitOf(name));
    const view = this.state.view;
    if (two.length !== 2 || !two.every(Boolean) || !view) return;
    // Where the reader is standing, read before the line below moves them. A
    // comparison opened on `/project/<pid>/latest/` is addressed as the commit
    // the pointer resolves to (`addressOf`), which makes `isPointerPage()`
    // false: the new-build watch stops re-arming and the chip stops saying
    // `up to date`. Right while comparing (the link must mean this pair
    // tomorrow), wrong after, so `leaveCompare` needs the entry page.
    //
    // Only on the way in: Try again, a view tab and a second pair all arrive
    // with the panel open, and re-reading `PAGE` then would remember the commit
    // the page was already moved onto.
    if (!this.state.compare) this._cmpFrom = isPointerPage() ? PAGE.slot : null;
    // AND THE ADDRESS SAYS SO, which is the whole reason the route exists: a
    // comparison is a thing one person sends another, and until this the only
    // way to that URL was to type it. Measured rather than pushed blindly, so
    // that the doors above which arrive with the address already right move
    // nothing — `moveAddress` holds the inventory of them.
    this.moveAddress(two);
    // The offer of a newer build is withdrawn: it was about the pointer this
    // page just left. `takePending` opens a build without moving the address
    // (it assumes a pointer page, where `PAGE.base` means "the newest"), so
    // Switch inside a comparison would mix the new build's `views` and
    // `buildKey` with the old commit's `base`: old geometry under the new name,
    // downloads into the old directory. `poll`'s note describes the same
    // failure from the other side.
    //
    // Withdrawn, not refused: `leaveCompare` returns the reader to the pointer,
    // where the next poll offers it again if still true. `bannerGone` is lifted
    // rather than set, as in `switchBuild`.
    //
    // No `clearTimeout`, unlike `dismissPending`: a deferred Switch fires into
    // an empty `pending`, and `takePending` returns before touching anything.
    //
    // An answer already on the wire could restore the offer, so it is cut off:
    // `poll` compares the generation after its await, as in `switchBuild`.
    this._pollGen = (this._pollGen || 0) + 1;
    this.setState({
      compare: true, revOpen: false, cmpPair: two, cmpView: view,
      cmpStage: null, cmpError: null, cmpReport: null, cmpSel: null,
      pending: null, bannerGone: false,
    }, () => this.runCompare(two, view).catch(
      (error) => console.error('compare', error)));
  }

  /**
   * The one way out of the panel: close it and put the build back on screen.
   *
   * Through `set`, not `setState`: closing the panel tells the viewport to
   * fetch the build's own geometry again, which is what `set`'s event does.
   *
   * The address returns to where the reader came in. `/project/<pid>/<a>/
   * compare/<b>/` is the page of `<a>` (hub.js, `pageFrom`), so nothing is
   * fetched, but the bar must stop naming a closed comparison, or the link
   * would reopen it and `PAGE` would no longer describe the address.
   *
   * That page is not always `<a>`'s: a comparison opened on a pointer page is
   * addressed as the resolved commit (`addressOf`), which stops the new-build
   * watch (`schedulePoll` only arms on pointer pages) and makes the chip read
   * `pinned build`. Returning to `<a>` would leave the reader pinned, so the
   * way out is the way in, remembered by `compareRevisions`.
   *
   * The address moves before the state: `set` tells the viewport where to
   * fetch and redraws the header, and both read `PAGE`. Where nothing moves
   * (every comparison entered on a build page) the order is irrelevant.
   */
  leaveCompare() {
    // Spent, and cleared whichever door is taken: `compareRevisions` writes it
    // afresh on every entry, so this is belt and braces rather than the thing
    // that keeps it honest.
    const back = this._cmpFrom;
    this._cmpFrom = null;
    // A link's frame still waiting for the comparison scene is the closed
    // panel's: the next view drawn afresh fits as usual.
    this._linkCamera = null;
    if (back && back !== PAGE.slot) this.standOnPointer(back);
    else this.moveAddress(null);
    this.set({
      compare: false, cmpPair: null, cmpView: null, cmpStage: null,
      cmpError: null, cmpReport: null, cmpSel: null,
    });
  }

  /**
   * Put the page back on one of the two moving names, whole.
   *
   * Not a navigation and not a swap: the build on screen is the one this
   * pointer resolves to, so nothing is fetched and the entry is replaced (as
   * `moveAddress` does leaving a comparison), since closing a panel is not
   * somewhere the reader went.
   *
   * It restores everything hanging off `PAGE.slot`, notably the poll:
   * `schedulePoll` arms nothing on a pinned revision, so the timer in flight
   * when the comparison opened fired once and stopped. Cleared before re-arming
   * as in `switchBuild`, so a pending timer does not leave two.
   */
  standOnPointer(slot) {
    const to = `/project/${PAGE.pid}/${encodeURIComponent(slot)}/`;
    const views = (this.state.meta && this.state.meta.views) || [];
    history.replaceState({ hmr: slot }, '',
                         to + this.cameraQuery(this.viewQuery(this.state.view, views)));
    // IN PLACE, so `PAGE.slot` says what the bar says — which is what the watch
    // below, the chip and every relative fetch on this page are read off.
    rereadPage(to);
    clearTimeout(this._poll);
    this.schedulePoll(POLL_MS);
  }

  /**
   * The address that describes this page: the build, or one comparison of it.
   *
   * A comparison has an address only when its first end is the build on
   * screen. The ticks are any two rows, so a reader on `<a>` can compare `<b>`
   * against `<c>`; `/project/<pid>/<b>/compare/<c>/` is `<b>`'s page, which
   * this page is not showing, and the next `PAGE.base` fetch would go there. Such
   * a comparison has no link; the answer is the build's own address.
   *
   * "The build on screen" is compared as a commit: `/project/<pid>/latest/`
   * shows one commit, and a pair is two commits, so slot names would never
   * match. Resolved, it matches, and the address written is the commit's
   * (`/project/<pid>/<commit of latest>/compare/<b>/`): the same build under
   * its permanent name, so meta.json, downloads, the picker's row and the rail
   * are unchanged. It is also the only sendable link: the hub refuses
   * `/latest/compare/<b>/`, and it would change meaning when the pointer moves.
   *
   * Two things do change on the commit: `isPointerPage()` is false, so
   * `schedulePoll` stops the new-build watch, and the chip reads
   * `pinned build`. `leaveCompare` returns the reader to the pointer, so this
   * is temporary.
   */
  addressOf(pair) {
    const here = this.commitOf(PAGE.slot);
    return here && Array.isArray(pair) && pair.length === 2 && pair[0] === here
      ? `/project/${PAGE.pid}/${encodeURIComponent(here)}`
        + `/compare/${encodeURIComponent(pair[1])}/`
      : `/project/${PAGE.pid}/${encodeURIComponent(PAGE.slot)}/`;
  }

  /**
   * Move the address onto the comparison now up, or off the one that is not.
   *
   * Push into a comparison, replace out of one. Opening one is a navigation,
   * so Back should leave it (`popstate` then goes through `syncCompare`);
   * closing one goes nowhere, so the current entry is corrected. A push there
   * would make Back reopen what the reader just shut.
   *
   * Measured against the bar, not the caller (as `switchBuild` does repairing a
   * cancelled swap): a cold link, Try again, a view tab mid-comparison and
   * `popstate` all arrive with the address already right, and a push for them
   * would be a Back to nowhere.
   *
   * The view query is `viewQuery`, so a comparison of the default view has
   * nothing after the path.
   *
   * The entry is read off the address being written, not `PAGE`: on a pointer
   * page the bar is about to say the commit while `PAGE` still says `latest`.
   * Nothing reads this field yet, which is why it must not be false.
   */
  moveAddress(pair) {
    const to = this.addressOf(pair);
    if (location.pathname === to) return;
    const views = (this.state.meta && this.state.meta.views) || [];
    const address = to + this.cameraQuery(this.viewQuery(this.state.view, views));
    const entry = { hmr: pageFrom(to).slot };
    if (to === this.addressOf(null)) history.replaceState(entry, '', address);
    else history.pushState(entry, '', address);
    // IN PLACE, so `PAGE.cmp` says exactly what the bar says — the same reason
    // every other address move on this page ends with this line.
    rereadPage(to);
  }

  /**
   * Make the panel agree with an address the browser has moved to.
   *
   * The counterpart of pushing one: `compareRevisions` writes entries, so this
   * page must answer for them — Back out of a comparison closes it, Back into
   * one opens it. A `popstate` is not a load, and `load()` is where a
   * comparison address is read on arrival.
   *
   * Only where the page is really on that build: a failed swap leaves the
   * reader on the old build (`swapFailed`) under an address naming the new one.
   *
   * Idempotent, so `_pop` can call it after every entry: both writers measure
   * the bar before writing, so a Back that moved only the build asks nothing.
   */
  syncCompare(at) {
    if (this._gone || at.slot !== PAGE.slot) return;
    // AND THE RECORD FOLLOWS THE BAR HERE, because on the shortest of these
    // trips nothing else does: Back between a build and a comparison OF THAT
    // BUILD moves neither the build nor the address, so `switchBuild` returns
    // having done nothing and both doors below find the address already
    // correct. `PAGE.cmp` is what says this page is a comparison, and it would
    // be the one field left describing the entry before this one.
    rereadPage(location.pathname);
    const s = this.state;
    const pair = s.compare && Array.isArray(s.cmpPair) ? s.cmpPair : null;
    if (!at.cmp) {
      if (pair) this.leaveCompare();
      return;
    }
    // MEASURED AS COMMITS, because the pair on screen is a pair of commits
    // (`compareRevisions`). An entry whose `<a>` is `latest` names the same
    // comparison as the commit it resolves to, and reading the two as different
    // strings would tear the panel down and rebuild it on every trip through
    // such an entry.
    const two = [at.slot, at.cmp].map((name) => this.commitOf(name));
    // And of one view: a comparison is computed and cached per view (hub.js),
    // so the same pair on another view is a different comparison. By now
    // `s.view` holds the entry's `?v=` (both paths through `switchBuild` put it
    // there), so agreeing with it is agreeing with the address.
    //
    // Needed because the cancelling branch writes the view bare (going through
    // `showView` would restart the comparison and write an address, which a
    // `popstate` may not), leaving tab strip and scene on different views.
    // Restarting here adds no entry: `moveAddress` measures the bar.
    if (pair && pair[0] === two[0] && pair[1] === two[1]
        && s.cmpView === s.view) return;
    this.compareRevisions(two);
  }

  /**
   * Get one comparison in front of the reader: ask, queue, wait, show.
   *
   * The report is asked for first, and a 404 means queue a job: a pair already
   * computed is two fetches, a new one is a POST and a wait. Queueing first
   * would spend a CAD process on an answer already on the volume.
   *
   * No token is not a failure: both documents are behind EDIT_TOKEN, so the
   * panel says the reader needs one instead of showing the hub's 403.
   */
  async runCompare(pair, view) {
    const [a, b] = pair;
    const token = this.state.token;
    if (!token) { this.setState({ cmpStage: 'locked' }, () => this.sceneNeverCame()); return; }
    this.setState({ cmpStage: 'starting' });
    try {
      let report = await loadCompareReport(PAGE.pid, a, b, view, token);
      if (!this.onCompare(pair, view)) return;
      if (!report) {
        const job = await startCompare(PAGE.pid, a, b, view, token);
        if (!this.onCompare(pair, view)) return;
        this.setState({ cmpStage: 'running' });
        await this.awaitJob(job, pair, view, token);
        if (!this.onCompare(pair, view)) return;
        report = await loadCompareReport(PAGE.pid, a, b, view, token);
        if (!this.onCompare(pair, view)) return;
        // The job said it was done and the document is not there. Said out
        // loud: silence here would leave the panel on `running` for ever.
        if (!report) throw new Error('the hub finished the comparison and published no report');
      }
      // Through `set` and not `setState`, because THIS is the moment the scene
      // exists: `comparePair` starts answering, and the event `set` sends is
      // what points the viewport at it.
      this.set({ cmpStage: 'ready', cmpReport: report });
    } catch (error) {
      if (!this.onCompare(pair, view)) return;
      this.setState({
        cmpStage: 'failed',
        cmpError: String((error && error.message) || error),
      }, () => this.sceneNeverCame());
    }
  }

  /**
   * The comparison a cold link opened has ended without its scene — no token
   * (`locked`) or a job that failed — so the link's frame, still waiting for
   * that scene (`onModel`), goes on the build's own view instead: the same
   * world coordinates, so a reader without the token still sees the angle that
   * was shared. Before any model event has landed there is no view to put it
   * on, and the first one takes it (`onModel` reads the stage).
   */
  sceneNeverCame() {
    const opened = this._linkCamera;
    if (!opened || !this._modelSeen) return;
    this._linkCamera = null;
    const el = this.el();
    if (el && typeof el.setCamera === 'function') el.setCamera(opened);
    this.writeCamera();
  }

  /** Is this still the comparison the reader is looking at? */
  onCompare(pair, view) {
    const s = this.state;
    const at = s.cmpPair;
    return !this._gone && s.cmpView === view && Array.isArray(at)
      && at[0] === pair[0] && at[1] === pair[1];
  }

  /**
   * Wait for one job to finish. Returns on `done`, throws on `failed`.
   *
   * The deadline is the point of the loop: a job the hub lost (a killed worker,
   * a restart) never becomes terminal, and without an end the panel would say
   * `measuring` until reload.
   */
  async awaitJob(id, pair, view, token) {
    const until = Date.now() + COMPARE_WAIT_MS;
    for (;;) {
      const job = await loadJob(id, token);
      const state = job && job.state;
      if (state === JOB_DONE) return;
      if (state === JOB_FAILED) {
        throw new Error((job && job.error) || 'the comparison failed');
      }
      if (!this.onCompare(pair, view)) return;
      if (Date.now() >= until) {
        throw new Error('the hub is still working on this comparison — give it a moment and try again');
      }
      await this.pause(COMPARE_POLL_MS);
      if (!this.onCompare(pair, view)) return;
    }
  }

  /**
   * The gap between two polls, as a promise the page can take down with it.
   *
   * A timer per wait: with a single field, a second `awaitJob` (a view tab
   * during a queued comparison, Try again) would cancel the first one's timeout
   * and leave that chain awaiting a promise that never settles. Each wait owns
   * its timer and forgets it on the way out, and `componentWillUnmount` empties
   * the set so no wait wakes up after the page is gone.
   *
   * A displaced chain wakes at its own deadline and stops at the `onCompare`
   * check that says the reader has moved on.
   */
  pause(ms) {
    return new Promise((done) => {
      const waits = this._cmpWaits || (this._cmpWaits = new Set());
      const timer = setTimeout(() => { waits.delete(timer); done(); }, ms);
      waits.add(timer);
    });
  }

  // -- the one place the interface writes to the viewport -------------------
  sync(extra) {
    const s = this.state;
    const meta = s.meta;
    // Where the queue hangs on the build on screen. `anchorFor` uses the stored
    // coordinate only on the build it was taken on — as it stands in this view,
    // or carried here from the view it was left in; on others it follows the
    // catalogue key to the row drawing the part, and `partPoint` asks the
    // viewport where that row is now. The other three answers (in the catalogue
    // but not this view, key names nothing, record predates the field) draw no
    // pin: the rail says those in words rather than guessing a position.
    const el = this.el();
    const at = {
      published: (meta && meta.published) || null,
      view: s.view,
      keyRows: rowsByKey(s.tree),
      nodes: s.tree ? s.tree.nodes : null,
      parts: (meta && meta.parts) || {},
    };
    const pair = this.comparePair();
    // Another build's view documents go with it (`viewPlacement`).
    if (this._viewDocs && this._viewDocs.published !== at.published) {
      this._viewDocs = undefined;
    }
    const pins = [];
    s.feed.forEach((record) => {
      // A processed comment stays in the rail and draws no pin: the model shows
      // only what is still waiting.
      if (record.status === 'resolved') return;
      const anchor = anchorFor(record, at);
      let p = null;
      // The stored normal belongs to the stored point, so it is used only where
      // the point is: on the build it was taken on, the arrow stands out of the
      // face that was clicked. Everywhere else `n` is null and the viewport
      // stands the arrow from above.
      let n = null;
      if (anchor.state === 'point') {
        p = anchor.point;
        if (finite3(record.normal)) n = record.normal;
      }
      // Carried through where the record's view placed the part, once that
      // view's document is here (`viewPlacement`); until then, and wherever it
      // cannot be, the top of the part. Not in a comparison, whose scene is
      // neither view.
      if (anchor.state === 'carried' && !pair && el
          && typeof el.carryPoint === 'function') {
        const from = this.viewPlacement(record.view, record.part);
        const carried = from && el.carryPoint(anchor.path, from, anchor.point,
                                              finite3(record.normal) ? record.normal : null);
        if (carried) ({ p, n } = carried);
      }
      if ((anchor.state === 'part' || (anchor.state === 'carried' && !p))
          && el && typeof el.partPoint === 'function') {
        p = el.partPoint(anchor.path);
      }
      if (p) pins.push({ id: record.id, p, n, active: s.activePin === record.id });
    });
    if (s.composer && s.composer.p) {
      pins.push({ id: 'draft', p: s.composer.p, n: s.composer.n || null,
                  active: true });
    }
    // Which document the viewport is pointed at — all that comparing changes
    // here. A comparison is an ordinary view document at its own address
    // (hub.js), so the element's load path just gets another base, a `views`
    // list of one, and the token that address needs.
    //
    // The three tabs are `hidden`, not a mode: each is a list of group ids
    // (`diffHidden`) matched by prefix like a hidden part. They replace the
    // reader's hidden list rather than merging with it, since those ids name
    // solids of the build's tree, not this one; the reader's list returns when
    // the panel closes, because nothing here writes `s.hidden`.
    //
    // ONE ENTRY, AND `view` IS ITS OWN ID rather than a second spelling of it:
    // the element picks the entry it fetches by matching the two, and a view tab
    // has to move BOTH — the id is what makes the load a reload with a fresh fit
    // rather than a live swap under the old camera (hub.js, `compareView`).
    const only = pair ? compareView(s.cmpView) : null;
    // HELD BACK while a document laid over the model is fetching its file, so
    // the one on screen does not share the line with the model under it: the
    // viewport fetches nothing for `view: null`. Released when the document
    // says it has its file (`docReady`) or is closed — and only before the
    // viewport's first view, since a view taken back to null and given again is
    // a reload there (`setState` in viewport/element.js). `base` and `buildKey`
    // stay out as well: the element takes a change of either for a new build
    // and loads its first view, hold or not; absent, they arrive with the view
    // on release, one load of the view the page is on.
    const documents = (meta && Array.isArray(meta.documents)) ? meta.documents : [];
    const held = !pair && !this._modelFree && documents.some((d) => d.id === s.doc);
    this._heldBack = held;
    const scene = pair ? {
      base: compareBase(PAGE.pid, pair[0], pair[1]),
      views: [only],
      view: only.id,
      // Not a build's key and it does not have to be: what the viewport does
      // with this field is notice that the geometry changed, and what makes one
      // comparison different from another is the pair AND the view. The id above
      // moves with the view, so this one is what a comparison of ANOTHER PAIR of
      // the same view moves — and either alone is enough to fetch again.
      buildKey: `${pair[0]}:${pair[1]}:${s.cmpView}`,
      mode: 'compare',
      hidden: diffHidden(s.diffShow), ghost: [],
      selected: this.comparePaths(),
      token: s.token,
    } : {
      // Where the geometry is and which of it to show. `views` is meta.json's
      // own list, passed through rather than reshaped: the viewport reads `id`
      // and `file` off it, which is exactly what src/render.py writes.
      base: PAGE.base,
      views: (meta && meta.views) || [],
      view: held ? null : s.view,
      // What makes one build different from the last. The viewport uses it to
      // tell a LIVE RELOAD (same view, new geometry — keep the frame) from a
      // first load, and this side computes it because this side reads meta.json.
      buildKey: buildKey(meta),
      mode: 'single',
      hidden: s.hidden, ghost: s.ghost, selected: this.selectedPaths(),
      // NULL ON A BUILD PAGE, and that is a decision rather than an omission: a
      // build's view files are public, and handing the element the secret that
      // publishes for a fetch that does not need one would make every view
      // switch carry it for nothing.
      token: null,
    };
    if (held) {
      delete scene.base;
      delete scene.buildKey;
    }
    if (scene.view) this._modelFree = true;
    window.dispatchEvent(new CustomEvent(STATE, {
      detail: {
        ...scene,
        cut: s.secOn, cutOffset: s.secOff, cutFlip: s.secFlip, cutHatch: s.hatch,
        retina: s.retina,
        tool: s.tool,
        diffShow: s.diffShow, pins,
        ...(extra || {}),
      },
    }));
  }

  /**
   * Where `path` stands in another view of the build on screen
   * (`hub.placementIn`), or null: while that view's document is on the wire,
   * when it could not be read, or when it does not draw the path.
   *
   * Kept per view for the build on screen only, by `published`, which names the
   * geometry: the same view is fetched once whichever address serves the build
   * (`dev` or its hash), and `sync` drops the documents of any other. The first
   * ask starts the one fetch and its landing draws the page again, unless the
   * build has changed meanwhile. A failure stays remembered as nothing, so the
   * pin keeps the top of the part's box and the next frame does not ask again.
   *
   * No token header: a build's view files are public, and the viewport fetches
   * this build's own views without one (`token: null` in `sync`, which `load`
   * in viewport/element.js turns into no header).
   */
  viewPlacement(view, path) {
    const meta = this.state.meta;
    const published = (meta && meta.published) || null;
    const entry = ((meta && meta.views) || []).find((v) => v && v.id === view);
    if (!published || !entry || !entry.file) return null;
    const cache = this._viewDocs
      || (this._viewDocs = { published, docs: new Map() });
    if (!cache.docs.has(view)) {
      cache.docs.set(view, null);
      fetch(PAGE.base + entry.file)
        .then((response) => {
          if (!response.ok) throw new Error(`${entry.file} -> HTTP ${response.status}`);
          return response.json();
        })
        .then((doc) => {
          if (this._gone || this._viewDocs !== cache) return;
          cache.docs.set(view, doc);
          this.sync();
        })
        .catch((error) => console.warn('view document', error));
    }
    const doc = cache.docs.get(view);
    return doc ? placementIn(doc, path) : null;
  }

  set(patch, extra) { this.setState(patch, () => this.sync(extra)); }

  /** The document laid over the model has its file (`onReady` in
   *  DocumentView.jsx): the model `sync` held back goes to the viewport. Sent
   *  only when the last `sync` did hold it: a document that has its file at
   *  mount (a file the page does not draw) tells it before the page's own
   *  first `sync`, which then hands the view over itself, and a second
   *  `hmr:state` before the model is drawn starts its load again. */
  docReady() {
    if (this._modelFree) return;
    this._modelFree = true;
    if (this._heldBack) this.sync();
  }

  /**
   * The reader changing which parts they can see — the only writer of `hidden`
   * or `ghost` outside a build arriving. Used by the eye, the ghost square,
   * Isolate, Hide, Translucent and "show all parts".
   *
   * It keeps the carry honest. `this.carry` is a snapshot of those two lists as
   * names, taken when another build opens (`leaveBuild`) and spent by the model
   * event that lands it (`rejoin`). Between those moments — the geometry
   * download and render, the slowest part of a swap — the old tree is still on
   * screen with live rows, so a click writes an old-tree id into `hidden`, and
   * only the name snapshot can carry it across.
   *
   * So the snapshot is recomputed, not dropped: without it the old id would
   * land on the new tree, where the same path can be a different part (hide
   * one part, another disappears).
   *
   * Recomputed only if one was standing: on an ordinary page a snapshot would
   * be a carry with no swap behind it, spent by the next live reload or view
   * tab. `null` where there is no tree (the `onViewError` state), since there
   * is nothing to read names off.
   *
   * Hiding the buttons when the tree is gone would not replace this: the tree
   * returns on a successful Retry with the snapshot still standing.
   *
   * It is also where the step is recorded: a patch here carries only `hidden`
   * and `ghost`, so the pair read before the write fully describes where the
   * reader stood. `record` is false for the one caller going back; see
   * `undoStep`.
   */
  setVisibility(patch, extra, record = true) {
    // BEFORE the write, so the entry says where the reader was standing rather
    // than where this gesture has just taken them.
    if (record) {
      this.recordStep({ kind: UNDO_VISIBILITY,
                        hidden: this.state.hidden, ghost: this.state.ghost });
    }
    this.setState(patch, () => {
      // AFTER the patch, so the names are the ones the reader has just chosen.
      // Read off `this.carry` a second time rather than off a flag taken before
      // the write: a model event landing in between spends the snapshot, and
      // recomputing from a flag would put a spent one back.
      if (this.carry) {
        this.carry = this.state.tree
          ? { hidden: this.namesOf(this.state.hidden),
              ghost: this.namesOf(this.state.ghost) }
          : null;
      }
      this.sync(extra);
    });
  }

  /**
   * One step onto the stack, and the oldest off the bottom of it where that
   * overflows the cap.
   *
   * One pusher for the three callers (the visibility writer and the two
   * document gestures), because the cap is a rule about the stack.
   * `UNDO_DEPTH` says which end goes and why.
   */
  recordStep(entry) {
    this.history.push(entry);
    if (this.history.length > UNDO_DEPTH) this.history.shift();
  }

  /**
   * Take back the last thing the reader did, whichever kind of thing it was.
   *
   * One stack, two kinds, in the order made. A visibility step is the eye, the
   * ghost square, Isolate, Hide, Translucent or "show all parts"; a document
   * step is a build part or proposal body dragged or turned.
   *
   * A visibility step goes back through `setVisibility`, not `setState`: an
   * undo during a swap must re-seat the swap's snapshot like the click it
   * undoes, or `rejoin` lands the abandoned state on the arriving build. It
   * records no step (the third argument), or the next press would come straight
   * back and the stack would never empty.
   *
   * A document step goes back through `setProposal`, the way the edit came:
   * an undo is an edit. That puts the bodies back, pushes the moves (so the
   * dragged part returns) and writes the hub, which would otherwise keep a
   * statement the reader withdrew and hand it back on reload. It records
   * nothing either, since only the gestures record.
   *
   * It passes `KEEP_STEPS`: `setProposal` drops document steps behind an
   * unrecorded write, but an undo is spending a step it popped, and what lies
   * beneath is still valid.
   *
   * An empty stack does nothing: no redo, toast or button; the scene and tree
   * changing are the feedback.
   */
  undoStep() {
    const step = this.history.pop();
    if (!step) return;
    if (step.kind === UNDO_DOCUMENT) {
      this.setProposal(step.doc, KEEP_STEPS);
      return;
    }
    this.setVisibility({ hidden: step.hidden, ghost: step.ghost }, null, false);
  }

  // -- the proposal -----------------------------------------------------------

  /**
   * The document the proposal's branch now holds, and the body that follows
   * from it.
   *
   * Every edit made in a row (a digit, a role, a delete, a rename) comes
   * through here, so the numbers in the rows and the shape over the model
   * cannot disagree.
   *
   * `undoStep` also comes through here for scene gestures, because an undo
   * needs both halves: the scene (bodies back, moves pushed, so the part walks
   * back) and the hub (or the withdrawn statement reaches the agent and comes
   * back on reload).
   *
   * Two other writers of `state.proposal` bypass it:
   *
   * The `hmr:moved` handler records a dragged build part through a functional
   * updater, because `onModel` patches the same field functionally and an
   * object patch after a swap would restore removed nodes. It calls only
   * `proposalMoves` (a move changes no body, so no re-stage) and saves via
   * `saveProposal` from its own completion callback.
   *
   * `onModel` drops the moves (`dropMoves`) when a different build lands. It
   * writes directly, stages and saves nothing: the viewport has just cleared
   * its offsets and rebuilt the scene.
   *
   * A document that will not build leaves the last good body in place. The
   * commonest case is mid-typing (a minus typed before its digits), and
   * blanking the model would make the body flash. The kernel's sentence goes
   * under the branch head instead.
   *
   * Nothing to draw is not an error: a document with no bodies builds a payload
   * with no parts, and an empty overlay in the tree is worse than none.
   *
   * It writes the document to the hub, debounced and guarded (`saveProposal`).
   *
   * It invalidates the document steps: a step holds the whole document, so one
   * left behind an unrecorded edit would undo that edit too. See `DROP_STEPS`
   * and `KEEP_STEPS`.
   *
   * It prunes the shut eyes (`eyesKept`) and the snap steps (`snapsKept`) in the
   * same patch as `proposal`, so `movesOff` only ever names ids the document
   * has. A retraction and a merge do not come through here: they are branches
   * of `recordGesture`, which keeps the same rule with its own line that also
   * opens the eye of the node it wrote. That line is not a duplicate.
   */
  setProposal(doc, steps = DROP_STEPS) {
    // FIRST, so that nothing the write below reaches — `stageProposal` pushes at
    // the viewport, `saveProposal` arms a post — can observe a stack still
    // standing behind a document that has gone. Nothing reads it today; the
    // order is what keeps that from being a thing to re-check.
    if (steps !== KEEP_STEPS && doc !== this.state.proposal) {
      this.history = this.history.filter((step) => step.kind !== UNDO_DOCUMENT);
    }
    this.setState({ proposal: doc, movesOff: eyesKept(this.state.movesOff, doc),
                    snapSteps: snapsKept(this.state.snapSteps, doc),
                    ...this.selectionAfter(doc) });
    this.stageProposal(doc);
    this.saveProposal(doc);
  }

  /**
   * The selection, moved onto a body's new spelling — or nothing to move.
   *
   * A body's row is selected by its scene path, `<overlay group>/<name>`, so
   * clicking the row and clicking the body are the same act. The name is in
   * that path, so a rename would leave `sel` pointing at nothing, deselect the
   * row and shut the field block being typed in.
   *
   * Here, not in the name field's `commit`: `field` in `computed()` promises
   * `commit` turns raw text into the whole next document with no partial
   * writes, and about twenty fields rely on that. This method is where the
   * next document meets the one it replaces.
   *
   * By node id, not name (the name is what changed): the node answering
   * `overlayBody(sel)` is found in the old document and looked up by id in the
   * new one. So any rename moves the selection, including `freeName`
   * renumbering a taken name (`korpus` -> `korpus2`).
   *
   * Only the path's last segment is patched; the group's spelling is the
   * viewport's (`overlayAt` in viewport/element.js) and already in `sel`.
   *
   * A move node is unaffected: its row is selected by the build part's path,
   * and `overlayBody` answers null for it.
   *
   * No `sync` from here, so `setProposal` keeps using `setState`: the commit
   * re-stages, the re-stage clears `applied.selected` and emits a model event,
   * and `onModel` ends in `sync()` once the tree holds the new path. Pushing
   * from here would send a path the scene does not have yet.
   */
  selectionAfter(next) {
    const el = this.el();
    const sel = this.state.sel;
    if (!sel || !el || typeof el.overlayBody !== 'function') return null;
    let was = null;
    try {
      was = el.overlayBody(sel);
    } catch (error) {
      console.warn('proposal selection', error);
      return null;
    }
    if (!was) return null;
    const before = bodies(this.state.proposal || emptyProposal())
      .find((node) => node.name === was);
    const after = before && next.nodes.find((node) => node.id === before.id);
    if (!after || after.name === was) return null;
    return {
      sel: `${sel.slice(0, sel.lastIndexOf('/') + 1)}${after.name}`,
      selName: after.name,
    };
  }

  /**
   * The half of `setProposal` that touches the scene, given a document that is
   * already the page's.
   *
   * Callers: `setProposal`, `toggleProposalEye` and `tokenSet` in
   * chromeview.js. The last two change no document (an eye and a token are
   * page state), and both read a flag `setState` has not landed yet, so each
   * calls this from its own callback with the document read back from state.
   *
   * Constraint: a caller that writes `state.proposal` through a functional
   * updater (`hmr:moved`, because `onModel` patches the field functionally)
   * must not then reach `setProposal`, whose object patch would restore nodes a
   * batched `dropMoves` removed. `hmr:moved` calls only `proposalMoves`.
   *
   * `proposalError` is written here safely: it is derived from the document,
   * nothing merges into it, and the last writer is right.
   */
  stageProposal(doc) {
    let parts = null;
    let error = null;
    try {
      parts = buildProposal(doc).parts;
    } catch (failure) {
      error = String((failure && failure.message) || failure);
    }
    // AND THE BRANCH SAYS SO, WITH NOTHING TO OPEN FIRST. `proposalSays` hangs
    // under the head of the branch, which is drawn on the document alone and
    // survives the caret being folded — so the verdict is on screen the moment
    // it is reached, for as long as it is true. It has to be: a refusal leaves
    // the model exactly as it was, by design, so nothing else about the page
    // changes when one happens.
    this.setState({ proposalError: error });
    // THE OFFSETS ARE SETTLED BEFORE ANY RE-STAGE READS THEM, and that holds
    // whichever order these two lines are written in rather than because of it:
    // this push is synchronous, while `setOverlay` re-stages behind an `await`
    // (`show` in viewport/element.js waits on the library before it touches the
    // scene), so the map is already the one this document describes by the time
    // `restageMoves` re-applies it onto the groups the re-stage built.
    this.proposalMoves(doc);
    // Beside the offsets, for the same reason: a removed node takes its step
    // with it, and a new node (a body just drawn, a part just dragged) is a
    // path the map should name.
    //
    // Not the only place it is pushed from: the gesture (which commits in a
    // functional updater and pushes both sets itself) and `onModel`'s
    // `dropMoves` (whose viewport half is the map cleared in `show()`) never
    // come through here; see `setProposal`'s docblock.
    this.proposalSnaps(doc);
    // On the parts, not the nodes: a document holding only moves has nodes but
    // builds no geometry, and an empty overlay in the tree is worse than none.
    //
    // A refused document leaves the last good body standing (`parts` is null):
    // a reader mid-number should not see the model blink at each intermediate
    // value.
    //
    // Unless the eye is shut: `toggleProposalEye` has no other way to the
    // scene, and shutting the eye must take the bodies off even when the
    // document is refused (the moves push is unconditional).
    if (parts || this.state.proposalOff) {
      this.proposalOverlay(parts && parts.length ? parts : null);
    }
  }

  /**
   * The parts of the build the document says are displaced, handed to the
   * viewport. A ref call, like `proposalOverlay` below.
   *
   * The whole set every time, as `setMoves` in viewport/element.js expects: a
   * part goes home by its node being deleted, so a push must say what is no
   * longer moved too.
   *
   * Only the three fields the scene can act on; the node's id, role and row
   * name are the document's business.
   *
   * Nothing at all while the branch's eye is shut (`proposalOff`): an empty set
   * means "nothing is displaced", so `reconcileMoves` sends every part home.
   * The document is untouched, so opening the eye pushes the nodes again. The
   * flag is read here and in `proposalOverlay`, the two ways to the viewport,
   * which covers every caller, including the `hmr:moved` handler.
   *
   * The third way, `proposalSnaps`, does not read it: it carries a rounding
   * step, not geometry, so there is nothing to take off the model.
   *
   * A node whose own eye is shut (`movesOff`) is left out the same way; that
   * is all switching it off means. `toggleMoveEye` covers the rest.
   */
  proposalMoves(doc) {
    const el = this.el();
    if (!el || typeof el.setMoves !== 'function') return;
    const shown = this.state.proposalOff ? dropMoves(doc) : doc;
    const off = new Set(this.state.movesOff || []);
    try {
      el.setMoves(moves(shown).filter((node) => !off.has(node.id)).map((node) => ({
        paths: node.paths, delta: node.delta, turn: node.turn,
      })));
    } catch (error) {
      console.error('proposal moves', error);
    }
  }

  /**
   * How coarsely a drag of each row rounds, handed to the viewport. A ref call
   * like `proposalMoves`, and the whole set every time, as `setSnapSteps` in
   * viewport/element.js expects: a step is removed by being left out.
   *
   * Translates node ids into scene paths: the map is keyed by node (what the
   * row shows), but the viewport has no document and holds only a path at a
   * drag. A move contributes every path it displaces; a body the one path the
   * overlay staged it under, as `proposalRows` resolves it.
   *
   * A body is left out while nothing is staged (no group, no path). The push
   * that names it is `onModel`'s: a stage returns as a model event, and
   * `stageProposal` pushes before `proposalOverlay`.
   */
  proposalSnaps(doc) {
    const el = this.el();
    if (!el || typeof el.setSnapSteps !== 'function') return;
    const steps = this.state.snapSteps || {};
    const overlay = this.overlayRoot(this.state.tree);
    const list = [];
    for (const node of moves(doc)) {
      if (steps[node.id] > 0) {
        for (const path of node.paths) list.push({ path, step: steps[node.id] });
      }
    }
    for (const node of bodies(doc)) {
      if (overlay && steps[node.id] > 0) {
        list.push({ path: `${overlay}/${node.name}`, step: steps[node.id] });
      }
    }
    try {
      el.setSnapSteps(list);
    } catch (error) {
      console.error('proposal steps', error);
    }
  }

  /**
   * The viewport's second source of parts: a list to lay over the model, or
   * `null` to take it off.
   *
   * A ref call, not an event, like `snapshot()` and `getCamera()`: it answers a
   * person typing, not state this side mirrors. The element remembers what it
   * was given, so a rebuild under a staged proposal puts the body back by
   * itself (`setOverlay` in viewport/element.js).
   *
   * The branch's eye (`proposalOff`) is read here, not at the caller: this and
   * `proposalMoves` are the two ways to the viewport, so reading it at both
   * covers every route. Shut, the overlay comes off; the document and branch
   * are untouched, and the next push with the eye open restores the bodies.
   */
  proposalOverlay(parts) {
    const el = this.el();
    if (!el || typeof el.setOverlay !== 'function') return;
    try {
      if (parts && !this.state.proposalOff) el.setOverlay(parts);
      else el.clearOverlay();
    } catch (error) {
      console.error('proposal overlay', error);
    }
  }

  /**
   * The branch's own eye: the whole proposal off the model, or back on it.
   *
   * One boolean for the proposal as a whole: every body unstaged and every
   * displaced build part back home. It has no per-node form in `s.hidden`,
   * since a displaced part has its own row and eye in the parts tree. The
   * per-body eyes keep working; they are the scene's.
   *
   * Nothing is written to the document: the branch stays drawn, rows keep
   * their numbers, the projection is unchanged, so opening the eye restores
   * everything with no edit to undo. Hence the branch itself stays on screen:
   * its eye is what reopens it.
   *
   * Restoring happens on the next stage that builds; over a refused document
   * there is nothing to restore until the numbers are valid again. Shutting
   * takes everything off regardless, because it was asked for explicitly.
   *
   * Through the callback, because both viewport methods read the flag off
   * `this.state`. `stageProposal`, not `setProposal`: the document is
   * unchanged, so there is no selection to move or second write to make.
   */
  toggleProposalEye() {
    this.setState({ proposalOff: !this.state.proposalOff },
                  () => this.stageProposal(this.state.proposal || emptyProposal()));
  }

  /**
   * One move's own eye: that part back where the build puts it, or displaced
   * again. Interface state like `proposalOff`: the node stays in the document,
   * the row in the branch, the projection unchanged, and `×` remains the only
   * delete.
   *
   * Nothing to undo or re-measure: the viewport sends a part home when its path
   * leaves the pushed list (`reconcileMoves`) but keeps its home, pose and
   * pivot, so reopening re-applies the same delta.
   *
   * `proposalMoves` alone, not `stageProposal`: a move composes no body.
   * Through the callback, because that method reads the list off `this.state`.
   *
   * A functional updater, like the `hmr:moved` handler's: `onModel` patches
   * this field functionally, and an object patch after a build landed would
   * restore an id it removed.
   */
  toggleMoveEye(id) {
    this.setState((s) => ({ movesOff: this.toggle(s.movesOff || [], [id]) }),
                  () => this.proposalMoves(this.state.proposal || emptyProposal()));
  }

  /**
   * One field of a proposal row, being typed in. The draft and nothing else.
   *
   * The text is kept beside the document (`proposalDraft`): the document holds
   * numbers, and a field emptied on the way to another number (or a half-typed
   * `42.`, which a number field reports as empty) would otherwise be redrawn
   * from the document between keystrokes. One entry, not a map: one field has
   * focus, and the commit that ends typing drops it.
   *
   * No document is built here: going through `setProposal` per keystroke would
   * rebuild the bodies and re-render the scene per character. `commitProposal`
   * settles the value when the browser says it is settled.
   */
  typeProposal(key, text) {
    // A keystroke also cancels a pending nudge. The arrows commit on the
    // trailing edge of a run (`nudgeProposal`) with the text they were handed,
    // so clicking the spinner and then typing would have the waiting number
    // overwrite the typing. A held arrow is unaffected: each tick is an `input`
    // then a `change`, so it clears this timer and sets its own right after.
    clearTimeout(this._nudge);
    this.setState({ proposalDraft: { key, text } });
  }

  /**
   * That field, finished with: the text turned into the next document.
   *
   * On `change`, not `input` — a blur, an Enter, or a number field's arrows —
   * the platform's "this value is settled" and what JSCAD's own parameter panel
   * commits on. The draft showed the text meanwhile, so nothing is lost. The
   * callers are `onBlur`, `onKeyDown` and the node's own `change` handler
   * through `nudgeProposal`; `field` in `computed()` says why the last cannot
   * be React's `onChange`, and `nudgeProposal` why it waits.
   *
   * A field nobody typed in commits nothing: blur reaches every field tabbed
   * through, and re-committing would rebuild the document and redraw every
   * row. The draft is the record of having typed, so it is the condition.
   *
   * Text that is not a number leaves the document as it was. `unread` is the
   * number field's `badInput` (a lone `-` or `.`, measured to be nothing
   * else), the one case where an empty-looking field is not empty; `num` in
   * `computed()` explains. The draft still goes, so the field shows the
   * document's number again.
   */
  commitProposal(key, text, commit, unread) {
    const draft = this.state.proposalDraft;
    if (!draft || draft.key !== key) return;
    // THE DRAFT GOES, so the field is drawn from the document again rather than
    // from the reader's spelling: the commit is what normalises `5.0` to `5`,
    // and a draft left standing would hold that spelling over a number which has
    // moved on. `hands the field back to the document when the typing ends` is
    // where that is pinned.
    this.setState({ proposalDraft: null });
    if (unread) return;
    this.setProposal(commit(text));
  }

  /**
   * The step field of one row, finished with: how far one step of a drag of
   * that node goes, or nothing and back to the automatic step.
   *
   * Separate from `commitProposal` because no document is written here
   * (`snapGroup` in proposalview.js explains).
   *
   * An empty field, unreadable text and a step of zero all remove the entry, so
   * the drag rounds as everywhere else (`niceStep` in viewport/tools.js): empty
   * is the row's default state, so it cannot mean zero, and zero is no step.
   *
   * A functional updater, then the callback: the gesture and `onModel` also
   * prune the map in their own updaters, and a copy taken off `this.state`
   * could restore pruned entries; `proposalSnaps` reads the map once it lands.
   */
  commitSnapStep(key, text, id, unread) {
    const draft = this.state.proposalDraft;
    if (!draft || draft.key !== key) return;
    const step = unread ? 0 : Number(String(text).trim());
    this.setState((s) => {
      const next = { ...s.snapSteps };
      if (Number.isFinite(step) && step > 0) next[id] = step;
      else delete next[id];
      return { proposalDraft: null, snapSteps: next };
    }, () => this.proposalSnaps(this.state.proposal || emptyProposal()));
  }

  /**
   * The arrows: one document for a run of them, written when the run stops.
   *
   * Chromium repeats a held key or spinner button about every 30 ms, firing
   * `input` and `change` each time, and committing each would re-stage the
   * whole scene — the CSG alone is 23 ms at four bodies and 81 ms at twelve
   * (`field` in `computed()` has the measurements).
   *
   * The trailing edge, because the number the reader stops on is the one they
   * mean. The field itself follows every tick via React's `onChange`; only the
   * model lags. A single click is a run of one and commits `NUDGE_QUIET_MS`
   * later, small enough to feel immediate.
   *
   * `text` is captured here rather than read when the timer fires, so the
   * commit is what the field said at the last nudge.
   */
  nudgeProposal(key, text, commit, unread) {
    clearTimeout(this._nudge);
    this._nudge = setTimeout(
      () => this.commitProposal(key, text, commit, unread),
      NUDGE_QUIET_MS,
    );
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
    // `setCamera` raises no camera event, so the address is told here.
    this.writeCamera();
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

  /** Frame: the model's frame, or `frame`, a promise of the open document's
   *  (`docTools`), saved as a PNG named after the build (`savePng`). */
  async saveFrame(frame = this.frameBlob()) {
    try {
      const blob = await frame;
      if (!blob) { this.toast('The viewport has no frame to save yet'); return; }
      savePng(blob, this.state.meta);
    } catch (error) {
      console.warn('frame', error);
      this.toast('Could not save the frame');
    }
  }

  /**
   * Light or dark for the whole page — remembered, and applied to the live scene.
   *
   * Every colour in the interface is a `var(--…)` (static/_v/tokens.css)
   * resolving against `data-theme` on `<html>`, so this is three writes in
   * three places:
   *
   *   * `writeTheme` sets the cookie and stamps the attribute — the attribute
   *     repaints the interface without a re-render, and the server reads the
   *     cookie so the next page arrives painted (ui/src/store.js);
   *   * `setState` is for the button, which names the current mode; the
   *     palette needs no React;
   *   * `viewer.setTheme` is the canvas, which an attribute cannot reach.
   *
   * The canvas goes through `viewer`, not the element (the one place this file
   * reaches past the element's imperative half): the library resolves the
   * theme once at construction and re-asserts it after every render, so an
   * outside attribute or option change lasts only until the next view switch.
   * `setTheme` is the library's public API for this; the element has no method
   * to forward it. `theme` also tints the grid and orientation marker, both off
   * in this viewport (viewport/options.js), so here it is just the background.
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
  // The only build question with a source: `building` and `failed` need a job
  // id, and although `GET /api/v1/jobs/<id>` exists behind EDIT_TOKEN, nothing
  // tells this page which job produced its build. It never swaps the model by
  // itself: someone mid-section with half the tree hidden would read a model
  // changing under them as a breakage.
  schedulePoll(delay) {
    if (!isPointerPage() || this._gone) return;
    clearTimeout(this._poll);
    this._poll = setTimeout(() => this.poll(), delay);
  }

  async poll() {
    if (this._gone) return;
    // Which poll this is. `loadMeta` builds its URL from `PAGE.base` at call
    // time and then waits; a revision switch meanwhile moves `PAGE` and the
    // answer is about none of it. Compared against the new build's key it would
    // differ and be offered as newer (even on a pinned revision), and taking it
    // would pair one build's `views` with another's `base`. `switchBuild` moves
    // this number, and a poll waking on the wrong side is discarded whole,
    // re-arming included, since the swap armed the next one. `compareRevisions`
    // moves it too: entering a comparison withdraws the offer, and a late
    // answer would restore it.
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
            && Array.isArray(next.views) && next.views.length) {
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
   * Not while the viewport is in the reader's hands: `isBusy()` (a drag in
   * progress, or just after) is something only the viewport knows, and the
   * swap rebuilds the scene under the pointer. The wait is bounded
   * (BUSY_WAIT_MS); `since` is how a retry passes the time of the press.
   *
   * Not while a picker revision is on the wire (`swapping`). Refused here, not
   * in the click handler, because the banner click, the deferred retry and any
   * future caller all reach this method; a direct press needs no timer and
   * would otherwise run a whole swap under the requested one.
   *
   * The refusal puts nothing away (`pending`, `bannerGone`): the offer is only
   * postponed. If the swap 404s, `swapFailed` lowers the flag and Switch works
   * again.
   */
  takePending(since) {
    const next = this.state.pending;
    if (this._gone || this.state.swapping) return;
    if (!next || !Array.isArray(next.views) || !next.views.length) return;
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
      // meaning while the wait runs. Three places cancel the timer:
      // `componentWillUnmount` (it would fire on an unmounted component),
      // `dismissPending` (Later is an answer) and `switchBuild` (the reader
      // picked a revision instead).
      this._swap = setTimeout(() => this.takePending(asked), BUSY_RETRY_MS);
      return;
    }
    const keep = next.views.some((v) => v.id === this.state.view);
    // The same list as a revision switch, through the same method, because this
    // is a revision switch: another commit with its own bounding box.
    // `leaveBuild` covers the pins and the draft's anchor, the selection, the
    // section plane, the names behind hidden parts, and the re-fit Fit needs.
    //
    // Called here, not at the top: the busy branch above returns having swapped
    // nothing, and `leaveBuild` would empty the draft and put the section away
    // for a swap that did not happen. It must also precede the `setState` its
    // answer is spread into.
    const gone = this.leaveBuild(keep, next);
    this.setState({
      meta: next,
      view: keep ? this.state.view : next.views[0].id,
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
   * A method because it must cancel the wait: Switch defers while the reader's
   * hand is on the model (`takePending`), and hiding the banner does not reach
   * that timer, so pressing Switch then Later would still swap a quarter
   * second later.
   *
   * The offer stays on `pending` and only the banner goes, so `poll` can
   * compare: it lifts `bannerGone` for a build not yet offered and leaves it for
   * the refused one. A dismissal therefore lasts until a newer build lands,
   * not until the next poll.
   */
  dismissPending() {
    clearTimeout(this._swap);
    this.setState({ bannerGone: true });
  }

  // -- measurements ---------------------------------------------------------
  /**
   * One measurement, with its qualifier.
   *
   * The viewport reports whether an answer spans two different parts and
   * whether anything has been dragged. Inside one part (a wall, a hole, an
   * edge) no arrangement can make the number wrong. Between parts it is the
   * distance as they stand now, which on a print bed or after a drag is not
   * their assembly position. These numbers reach an agent as a task, so that
   * must be said.
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
  /**
   * The project's comment queue, fetched.
   *
   * Per project, not per build (SPEC 7A.3): the route takes a pid and returns
   * the whole queue oldest first, so it is not refetched on a build swap; each
   * row finds its place in the build on screen through `anchorFor`.
   *
   * Never throws: a failure leaves the rail holding what it had and says so,
   * like every other fetch here.
   *
   * `quiet` is for the refetch after a write: `toast()` replaces the toast on
   * screen, so a failing refetch would paint "Could not load the comments" over
   * "Sent to the agent", and the reader might send again. A duplicate in the
   * agent's queue costs more than a rail one entry stale.
   */
  async loadFeed(quiet = false) {
    const { response, error } = await askHub(
      `/api/v1/comments?project=${encodeURIComponent(PAGE.pid)}`,
      this.state.token);
    if (error) {
      console.error('feed', error);
      if (!quiet) this.toast(HUB_UNREACHABLE);
      return;
    }
    const said = hubTrouble(response, 200, 'Could not load the comments');
    if (said) { if (!quiet) this.toast(said); return; }
    const { body, error: unread } = await hubBody(response);
    if (unread) {
      console.error('feed', unread);
      if (!quiet) this.toast('Could not load the comments');
      return;
    }
    this.set({ feed: (body && body.comments) || [] });
  }

  /**
   * The project's stored proposal, fetched — one document per project, behind
   * the same EDIT_TOKEN everything else on this page is behind.
   *
   * Called only where the token arrives (`componentDidMount` and `tokenSave`),
   * not with `loadFeed`'s post-comment refetch, which would re-adopt the stored
   * document over the reader's edits. Like its neighbour: never throws, shows a
   * fixed sentence, and leaves the current document on failure.
   *
   * The record is put on `_proposalRecord` and `adoptProposal` takes it when
   * the page is ready — see there for why that is not now.
   */
  async loadProposal() {
    const { response, error } = await askHub(
      `/api/v1/proposals/${encodeURIComponent(PAGE.pid)}`, this.state.token);
    if (error) {
      console.error('proposal', error);
      this.toast(HUB_UNREACHABLE);
      return;
    }
    // A PROJECT WITH NOTHING STORED IS NOT A FAILURE, and it is the answer that
    // opens the door to saving: there is nothing left to overwrite. Nothing to
    // adopt either, so this one needs no scene and no build and is answered on
    // the spot. Read BEFORE the sentence below, which would call it one.
    if (response.status === 404) {
      this.setState({ proposalHeld: false, proposalStands: false });
      return;
    }
    const said = hubTrouble(response, 200, 'Could not load the proposal');
    if (said) { this.toast(said); return; }
    const { body, error: unread } = await hubBody(response);
    if (unread) {
      console.error('proposal', unread);
      this.toast('Could not load the proposal');
      return;
    }
    this._proposalRecord = body || {};
    this.adoptProposal();
  }

  /**
   * The record the hub answered with, put on the page — at the first moment the
   * page can take it, which is not the moment it arrived.
   *
   * Two things must be true, and the fetch races both:
   *
   * `meta` must be in: whether stored moves are kept is decided by comparing
   * the record's build stamp and view against this page's, and a missing
   * `meta` reads as "another build", which would drop the moves on every cold
   * reload. It lands with builds.json, and `state.view` in the same patch.
   *
   * The first model event must have passed: `onModel` drops the moves of every
   * build that lands (`dropMoves`), so an earlier adoption would lose them. The
   * same event tells this side a scene exists, which `proposalMoves` and
   * `proposalOverlay` require.
   *
   * So whichever lands last adopts: this is called from `onModel`'s callback
   * and from `loadProposal`. The record on `_proposalRecord` is the "not yet
   * taken" state and is spent here. Via `tokenSave` the page already has meta
   * and a scene, so it adopts at once.
   *
   * Adopted only into an empty document (`isEmpty`): the reader's own work
   * outranks a document they have not seen. The record is spent either way.
   *
   * A page that declined it may not write: `proposalHeld` stays `null` ("do
   * not write"), since the page read a record it never showed and the next edit
   * would overwrite it. `proposalStands` is still raised: it describes the hub,
   * which is unchanged. One toast accompanies the refusal, so the reader knows
   * nothing is being saved.
   *
   * Only on a page that has never adopted (`proposalHeld !== true`):
   * `loadProposal` runs on every `tokenSave`, and a re-pasted token would
   * otherwise warn "your drawing is not being saved" about a document this page
   * adopted and is saving, inviting a `×` that would really lose it. Such a
   * pass only re-reads what the hub holds.
   *
   * Moves are dropped where the stored build or view differs from this page's.
   * A move's `paths` belong to one revision's tree as one view groups it
   * (`/model/pin(2)` is handed out by the tessellator); a rebuild renumbers
   * them and another view is a different tree (`src/cadbuild/views.py`), so a
   * re-applied move could displace a different part. `published` is identical
   * across a build's views, so the build alone is not enough. `dropMoves`
   * (ui/src/proposal.js) keeps the bodies, which are true of any build.
   *
   * Through `setProposal`, so the bodies reach the model like any edit, and
   * before `proposalHeld` is raised, so the save hanging off it writes nothing:
   * an adoption must not re-stamp the record just read.
   */
  adoptProposal() {
    const record = this._proposalRecord;
    if (!record || !this.state.meta || !this._modelSeen) return;
    this._proposalRecord = null;
    const doc = record.doc || null;
    // `!!`, not `!= null`, on `text` below: the announcement claims there is
    // something to read, and the hub writes `text` as null for a document that
    // projects to nothing; an empty string is the same fact.
    // A record with nothing in it is not worth protecting, so the refusal below
    // asks about the stored document too. The hub legitimately holds
    // `{nodes: []}` (`saveProposal` writes it when the last body is deleted),
    // and declining for it would leave the page never saving.
    const worth = !!doc && !isEmpty(doc);
    const bare = isEmpty(this.state.proposal || emptyProposal());
    if (worth && !bare && this.state.proposalHeld !== true) {
      this.setState({ proposalStands: !!record.text });
      this.toast('This project has a stored proposal — your drawing is not '
                 + 'being saved');
      return;
    }
    // The page's own document is never overwritten: an empty record falls past
    // the refusal, and taking it over a drawing would clear the screen.
    if (doc && bare) {
      const here = !!(record.published
                      && record.published === this.state.meta.published
                      && record.view
                      && record.view === this.state.view);
      const taken = here ? doc : dropMoves(doc);
      this.setProposal(taken);
      // What was taken counts as already sent, which keeps the next write from
      // destroying the stored moves: `setProposal` saves, and with an empty memo
      // its next call would post. On this build and view that is a redundant
      // request; on another it rewrites the record with this page's stamps and
      // without the moves `dropMoves` just removed for display.
      //
      // The memo only answers "has this exact document gone", and this document
      // came from there. A real edit differs and posts as usual.
      this._proposalSent = JSON.stringify(this.proposalPayload(taken));
    }
    this.setState({ proposalHeld: true, proposalStands: !!record.text });
  }

  /**
   * The document written back to the hub, once the edits have stopped.
   *
   * Called from `setProposal`, through which every document edit goes, and
   * from one other place: the completion callback of the `hmr:moved` handler,
   * which writes the document with a functional updater and cannot use
   * `setProposal` (it says why). That second call is not a duplicate.
   * `onModel`'s `dropMoves` also writes the document but is not an edit and
   * saves nothing.
   *
   * Four guards, each necessary:
   *
   * Nothing is saved until the load resolves (`proposalHeld` null); otherwise
   * the page's initial empty document would overwrite the stored one. A page
   * that declined the record stays in that state on purpose (`adoptProposal`).
   *
   * No token, no save: the branch outlives the token (`tokenClear` sits right
   * beside this), and a page no longer allowed to edit must not write.
   *
   * An empty document does not create a record (`isEmpty`, not `sendsNothing`:
   * a document ticked off to the last node is work and is stored). Once the
   * hub holds one, emptying the page saves: the record mirrors the screen.
   *
   * A payload identical to the last one sent is skipped. The adoption is not
   * caught by this guard; it is refused one line earlier by `proposalHeld`,
   * which `adoptProposal` raises only afterwards.
   *
   * The pending save is cancelled first, whichever way this goes, so editing
   * and then undoing back to the stored document does not post the
   * intermediate one.
   */
  saveProposal(doc) {
    clearTimeout(this._proposalSave);
    // UNDEFINED IS READ AS NULL HERE, for the reason `openTabs` in `computed()`
    // carries its `|| []`: every test file in ui/tests spells the state out by
    // hand, and a fixture written before this field existed has to be a page
    // that does not write rather than one that does.
    const held = this.state.proposalHeld;
    if (held === null || held === undefined || !this.state.token) return;
    if (!held && isEmpty(doc)) return;
    const payload = this.proposalPayload(doc);
    const body = JSON.stringify(payload);
    if (body === this._proposalSent) return;
    // WHAT THE RECORD WILL SAY, carried to the post rather than re-derived
    // there: the payload is a string by then, and the announcement `sendComment`
    // makes is about this exact fact.
    this._proposalSave = setTimeout(() => this.postProposal(body, !!payload.text),
                                    PROPOSAL_SAVE_MS);
  }

  /**
   * The body a save of this document would send, as an object.
   *
   * Shared by `saveProposal` (which sends it) and `adoptProposal` (which records
   * it as already sent), so the two cannot diverge;
   * `ui/tests/proposalpanel.test.js` holds them equal.
   *
   * An object, not the string, because `saveProposal` needs `text` again for
   * the announcement flag passed to `postProposal`.
   */
  proposalPayload(doc) {
    return {
      doc,
      text: sendsNothing(doc) ? null : proposalText(doc),
      // BOTH HALVES OF WHERE THE MOVES WERE MEASURED, and neither identifies it
      // alone: `published` is one number for the whole build and is IDENTICAL
      // across its views, while a view is a separate tree of references with its
      // own grouping (`src/cadbuild/views.py`), so `/model/pin(2)` in another
      // view is a different part or the same part in a different layout.
      // `adoptProposal` requires both to match before it puts the moves back —
      // the rule `dropMoves` already states for a build landing on this page.
      published: (this.state.meta && this.state.meta.published) || null,
      view: this.state.view || null,
    };
  }

  /**
   * That write, made. Silent on both sides: a background save must not cover
   * the toast of the reader's own action, and the hub is at most one debounce
   * behind this page's copy.
   *
   * The payload is recorded as sent before the request, since the memo exists
   * to prevent identical posts racing.
   *
   * It is forgotten again if the request fails (a 403, a 413, a hub gone
   * mid-request), so the next edit posts whatever it is: a transient failure
   * heals itself and a permanent one costs one request per edit. Still silent.
   *
   * The two flags move only on success: they describe the hub's side.
   */
  async postProposal(body, says) {
    this._proposalSent = body;
    // NO `hubTrouble` HERE, and that is the silence above rather than an
    // oversight: this one has no sentence to choose between, so a 403 and a
    // hub that went away take the same path out.
    const { response, error } = await askHub(
      `/api/v1/proposals/${encodeURIComponent(PAGE.pid)}`, this.state.token,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (error) console.error('proposal', error);
    if (!response || response.status !== 200) {
      this._proposalSent = null;
      return;
    }
    this.setState({ proposalHeld: true, proposalStands: says });
  }

  /**
   * The stored proposal, deleted — the record on the hub and the document on the
   * page, together.
   *
   * It asks first with `confirm()`, used nowhere else on this page: every other
   * `×` removes one node, while this removes work that has survived reloads.
   *
   * The page is cleared through `setProposal`, so the bodies come off the model
   * like any other edit. No save follows because of the `clearTimeout` below,
   * not the line order: React batches `setState` inside a promise continuation,
   * so `saveProposal` still reads `proposalHeld` as `true` and arms a timer.
   * Nothing the page had armed survives the delete, including an edit made a
   * second before. (The test fixture's `setState` is synchronous and cannot
   * show this.) The lowered flags keep the next edit from recreating a record,
   * and the memo is cleared so an identical redraw is not skipped.
   *
   * The document steps are dropped by that same call (`DROP_STEPS`), so Ctrl+Z
   * cannot bring the drawing back — and save the confirmed-deleted record
   * again.
   */
  async removeProposal() {
    // BOTH HALVES ARE NAMED IN THE QUESTION, because the `×` takes both and the
    // reader who most needs to know is the one for whom they differ: a page that
    // declined the stored record is drawing something the hub has never seen, and
    // this control looks from there like a way to clear the way for it.
    if (!window.confirm(
      'Delete the proposal — the stored one and the drawing on this page?')) {
      return;
    }
    const { response, error } = await askHub(
      `/api/v1/proposals/${encodeURIComponent(PAGE.pid)}`, this.state.token,
      { method: 'DELETE' });
    if (error) {
      console.error('proposal', error);
      this.toast(HUB_UNREACHABLE);
      return;
    }
    const said = hubTrouble(response, 200, 'Could not delete the proposal');
    if (said) { this.toast(said); return; }
    this.setState({ proposalHeld: false, proposalStands: false });
    this.setProposal(emptyProposal());
    clearTimeout(this._proposalSave);
    this._proposalSent = null;
    this.toast('The proposal is deleted');
  }

  async sendComment() {
    const c = this.state.composer;
    const meta = this.state.meta;
    if (!c || !meta) return;
    // One comment at a time — the composer's one refusal.
    //
    // This method spans the frame grab, its upload, the POST and the refetch,
    // and the composer keeps its text until the write clears it, so a reader
    // may press Send again. The hub cannot tell posts apart (no idempotency key,
    // no deduplication in src/comments.py), so each press would add a row to the
    // agent's queue.
    //
    // A refusal, not a queue: a second press is the same draft. Lowered in the
    // `finally` below, on error paths too, so a refused comment can be resent.
    if (this.state.sending) return;
    // Refused here rather than only by the hub, since step 0 put the write
    // behind the token. Not a security check — the hub's is — but the difference
    // between "you are not signed in" and a 403 arriving after the photo has
    // been uploaded and the frame grabbed. The composer cannot normally be open
    // without a token, because clearing one closes it; what this covers is the
    // token going away between opening the composer and pressing Send.
    if (this.viewer()) { this.toast('Add the token to comment'); return; }
    const text = (c.text || '').trim();
    if (!text) { this.toast('Write something first'); return; }

    // RAISED BEFORE THE FIRST AWAIT and after the refusals above, which return
    // without sending anything: a flag raised on a press that did nothing would
    // take the button out of service for a request that was never made.
    this.setState({ sending: true });
    try {
      // The hub's comment schema is closed — src/comments.py keeps `text`, `view`,
      // `part`, `key`, `published`, `point`, `normal` and `camera` and DROPS
      // everything else without saying so — so the measurement rides in the text,
      // where the agent will actually read it, rather than in a field discarded on
      // the way in.
      const extra = [];
      if (c.meas) extra.push(`measured: ${c.meas}`);
      // Where the hub holds a proposal, a pointer to it. The document is not
      // copied into the comment: the hub keeps one proposal per project and the
      // client prints it to the agent (`hammerola proposal`), so a copy would
      // be redundant and go stale.
      //
      // From what the page knows, not a second request: `proposalStands` is the
      // load's answer kept current by this page's writes.
      if (this.state.proposalStands) {
        extra.push('a proposal stands on this project '
                   + '— `hammerola proposal` reads it');
      }

      const form = new FormData();
      form.append('comment', JSON.stringify({
        text: extra.length ? `${text}\n\n${extra.join('\n')}` : text,
        view: this.state.view,
        part: c.partId || null,
        // The anchor that outlives this build: `part` is a path in this
        // revision's tree, which a rebuild may renumber; the catalogue key is
        // the part's identity, used to put the pin back on a later build.
        key: c.key || null,
        // WHICH BUILD THE COORDINATE WAS TAKEN ON — not necessarily the build the
        // slot holds when this request lands, since `dev` can rebuild while the
        // reader is still typing, and only this page knows which one it is showing.
        published: meta.published || null,
        point: c.p || null,
        // Which way the comment's arrow stands out of the face at that point.
        normal: c.n || null,
        camera: this.frameCamera(),
      }));
      // The two attachments, and the only place either is shrunk (shrink.js):
      // upload size, not encoding (7–90 ms) or the hub (5–45 ms), dominates the
      // wait on Send.
      //
      // The name is built from the blob's own type. The hub identifies uploads
      // by magic bytes and ignores the name (`sniff_image`, src/comments.py),
      // but `shot.png` on a re-encoded WebP would mislead whoever debugs it. A
      // blob with no type gets the bare stem.
      const named = (stem, blob) => {
        const kind = /^image\/([a-z0-9+.-]+)$/i.exec(blob.type || '');
        return kind ? `${stem}.${kind[1].toLowerCase()}` : stem;
      };
      if (c.photo) {
        const photo = await shrink(c.photo,
                                   { maxSide: PHOTO_MAX_SIDE, quality: PHOTO_QUALITY });
        form.append('photo', photo, named('photo', photo));
      }
      const frame = await this.frameBlob();
      if (frame) {
        const shot = await shrink(frame,
                                  { maxSide: SHOT_MAX_SIDE, quality: SHOT_QUALITY });
        form.append('shot', shot, named('shot', shot));
      }

      // The token `askHub` sends has been required by the hub since step 0, and
      // is checked there before the body is parsed at all — so it is what makes
      // this a comment rather than a 403, with the whole upload already spent.
      const { response, error } = await askHub(
        `/api/v1/comments/${PAGE.pid}/${meta.commit}`, this.state.token,
        { method: 'POST', body: form });
      if (error) {
        console.error('comment', error);
        this.toast(HUB_UNREACHABLE);
        return;
      }
      // FIXED SENTENCES RATHER THAN THE HUB'S OWN MESSAGE: nothing on this page
      // should be in the habit of putting a response body on the screen. The
      // longest list on this page, because this is the request that can be
      // refused for reasons the reader can act on; 403 is not among them here,
      // since `hubTrouble` answers it with the same sentence it always does.
      const said = hubTrouble(response, 201, {
        404: 'This build is no longer available',
        413: 'Too large — try a smaller photo',
        422: 'The hub refused this comment. Is the photo a JPEG, PNG or WebP?',
        429: 'Too many comments from here. Try again in a few minutes.',
      }[response.status] || 'Could not send the comment');
      if (said) { this.toast(said); return; }

      // The queue is refetched rather than guessed at, so the rail shows the
      // record the hub stored, with the id, stamp and status the agent sees.
      this.set({ composer: null, rail: true });
      this.toast('Sent to the agent — a rebuild will follow');
      await this.loadFeed(true);
    } finally {
      // Every exit, including the throw `compSend` catches: a flag left up would
      // disable Send for good.
      //
      // This puts it after the silent refetch, so the flag outlives the composer
      // by one GET; a new composer opened in that window starts with Send spent.
      // Accepted: the window is short, and one lowering point is required.
      this.setState({ sending: false });
    }
  }

  /**
   * Close an item in the queue.
   *
   * `POST /api/v1/comments/<id>/resolve` takes the same EDIT_TOKEN this page
   * holds. Body-less on purpose: the route reads an optional `note`, which is
   * the agent's word about what it did, not the reader's.
   *
   * The queue is refetched, not patched: the hub stamps `resolved` and may add
   * a note.
   */
  async resolveComment(id) {
    if (!id || this.viewer()) return;
    const { response, error } = await askHub(
      `/api/v1/comments/${encodeURIComponent(id)}/resolve`, this.state.token,
      { method: 'POST' });
    if (error) {
      console.error('resolve', error);
      this.toast(HUB_UNREACHABLE);
      return;
    }
    const said = hubTrouble(response, 200, 'Could not mark it processed');
    if (said) { this.toast(said); return; }
    this.toast('Marked processed');
    await this.loadFeed(true);
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
   * A method so a test can take it over and read which hrefs the button would
   * fire, in what order. The mechanism is `sequentialDownload`, tested on its
   * own with a fake clock; `options` lets the same fake clock reach it through
   * this method, which is how cancelling a page-started chain is tested.
   *
   * One signal for the whole page: two group links pressed in a row leave two
   * chains running (thirty files take six seconds), both about the same build,
   * so both must end together. A controller per chain would need a list nobody
   * prunes; after a cancel the next press gets a fresh one from
   * `cancelDownloads`.
   */
  downloadAll(hrefs, options) {
    if (!this._dl) this._dl = new AbortController();
    return sequentialDownload(hrefs, { ...(options || null), signal: this._dl.signal });
  }

  /** Stop handing over files: the addresses in the chain stopped describing
   * what is on the screen.
   *
   * Called by `switchBuild` and `componentWillUnmount`, the two moments this
   * page's address goes away: the hrefs are `PAGE.base` plus a file name
   * (`fileHref`).
   *
   * Not by `takePending`: the banner moves `meta` but leaves `PAGE.base`, so a
   * chain running across it still fetches from the pointer the reader pressed
   * the button on, and cutting it would silently truncate a group download.
   */
  cancelDownloads() {
    if (this._dl) this._dl.abort();
    this._dl = null;
  }

  /** The line under the title: this view's part count, the build's total size.
   *
   * `views[].parts` is a list of catalogue keys, so the count is its length and
   * counts distinct parts: a plate with five copies of one pin says two parts,
   * not six.
   */
  subtitle() {
    const meta = this.state.meta;
    const current = meta.views.find((v) => v.id === this.state.view) || meta.views[0];
    const total = meta.views.reduce((sum, v) => sum + Number(v.gzip || 0), 0);
    const tabs = meta.views.length === 1 ? '1 view' : `${meta.views.length} views`;
    return `${viewPartCount(current)} parts · ${tabs} · ${mb(total)}`;
  }

  /**
   * A part in the scene was clicked, or the background was.
   *
   * A method rather than a closure in the handler map (as with `sceneMenu` and
   * `onModel`): the map is built in `componentDidMount`, so its decisions —
   * which selection this writes, and what it resolves the pick to — could only
   * be tested by mounting the whole page.
   */
  onPick(detail) {
    // The row, not the solid. A pick names the copy hit (`/model/pin(2)`), but
    // `sel` is a row id, which every reader resolving it through `node()`
    // expects: `selRow` in `computed`, `selectedPaths`, `selectedKey` and
    // `measAdd`. A row for five copies is reached by any of its paths
    // (hub.indexTree), so this is a lookup; an id arriving before the tree
    // keeps its path.
    //
    // `selName` goes through the same row, because the pair is one answer:
    // `sel` is what a comment is filed against and `selName` what the reader is
    // shown. Left as the solid's, picking the third copy of a collapsed run
    // would give `sel` = `/model/pin` and `selName` = `pin(3)`, a name no row
    // carries. The other writers agree: the tree row's `onSelect` and the row
    // menu's `Move` write the row's name, the initial state and `leaveBuild`
    // write `''`. Isolate writes no selection, because the selection shader
    // replaces a part's colour and colour is an assertion on this page.
    //
    // A divergence would surface in `measAdd`, which fills a comment from the
    // pair: `partId` from `sel`, `part` from the row or, where the tree cannot
    // answer (a view that does not show this part), from `selName`. Paths are
    // the assembly structure (`treeFromShapes`: parent plus `/name`), so views
    // with the same parts share them. `showView` touches neither half, and
    // `onModel` writes both or neither (`stagedSelection`), so pick, tab,
    // measure reaches that fallback with both halves set.
    //
    // The solid's name stays the fallback for a path no row claims (a pick
    // before the tree landed), as `sel` keeps its path.
    const id = (detail && detail.id) || null;
    const picked = (detail && detail.name) || '';
    const node = this.node(id);
    // A PICK IN A COMPARISON IS THE OTHER HALF OF THE PARTS LIST, and the
    // brief asks for both directions ("по строке списка можно попасть к
    // детали на модели, и наоборот"). The row and the solid are addressed
    // differently there — the list is keyed by the catalogue key, because
    // one part is drawn up to four times — so the pick is resolved to the
    // key of the row it hit, and the pair of fields the build page keeps is
    // left alone: none of their readers is drawn while the panel is up.
    if (this.comparePair()) {
      this.set({ cmpSel: (node && node.key) || null, menu: null });
      return;
    }
    this.set({ sel: node ? node.id : id,
               selName: (node && node.name) || picked, menu: null });
  }

  /**
   * A right-click in the scene, opening the same menu a tree row's does.
   *
   * `setState`, not `set`: the menu is page chrome, so the viewport is told
   * nothing.
   *
   * Opening it does not touch `sel` / `selName`, as a tree row's menu does not:
   * the same menu should not mean "look at this" from one place and "select
   * and look" from another. The `Move` row inside does write the selection, and
   * says why.
   *
   * No id is empty space, and closes the menu: there are no view-level items,
   * and a menu with one greyed-out sentence is no better than none.
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

  /**
   * The catalogue key of the selected row: what a note, a file and a kind hang
   * on.
   *
   * A group has none: an assembly is not a part, so it has no record, note or
   * files. `treeFromShapes` puts keys on leaves only; `indexTree` copies
   * through what it is handed.
   *
   * Nor does a leaf that names no key, answered with '' rather than the row's
   * name: the name is the tessellator's (`pin`, `pin(2)`), and looking a note up
   * under it would find the wrong record while appearing to work. The hub
   * refuses a leaf without a key (`check_view_file`), so '' is only for a
   * document not obtained from a trusted push.
   */
  selectedKey() {
    const node = this.node(this.state.sel);
    return (node && node.key) || '';
  }

  /** The reader's note: this browser's, for this project, never sent anywhere.
   *
   * Keyed by the catalogue key. Notes stored under the old display-name keys
   * are not found and not migrated: matching them would rely on exactly the
   * name strings a rebuild may change.
   *
   * Through `noteFor`: the map is parsed from localStorage, no more trustworthy
   * than a fetched document.
   */
  selectedNote() {
    return noteFor(this.state.notes, this.selectedKey());
  }

  /**
   * The author's note on the selected part — written in `model.py` and
   * published inside this build's catalogue record for it.
   *
   * Absent is normal: a part with nothing to say has no `note` key, and a part
   * not in the catalogue has no record. `partRecord` answers both with `null`.
   *
   * Through `partRecord` because the key comes out of a pushed document: see
   * its own note for what a part called `constructor` does to a bare lookup.
   */
  authorNote() {
    const record = partRecord(
      this.state.meta && this.state.meta.parts, this.selectedKey());
    return record && typeof record.note === 'string' ? record.note : '';
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
    // A COMPARISON IS OF ONE VIEW, so a tab pressed while one is up asks for a
    // different comparison rather than for a different view of this one: the
    // hub caches a scene and a report per view (hub.js), and the pair on screen
    // has as many of them as the two revisions have views in common. Written
    // first, because `compareRevisions` snapshots the view it is about off
    // exactly this field — and it takes the panel back to "measuring" while the
    // hub answers, which is the honest thing to show.
    if (this.state.compare) {
      this.setState({ view: id }, () => this.compareRevisions(this.state.cmpPair));
      return;
    }
    this.set({ view: id });
  }

  /**
   * The view a history entry is asking for: its own `?v=`, or the one showing.
   *
   * Shared by both paths through `switchBuild` (opening another build, and
   * calling a swap off). The fallback is the current view because `?v=` is
   * dropped for the build's first view, so an entry without one says nothing.
   */
  entryView() {
    return new URLSearchParams(location.search).get('v') || this.state.view;
  }

  /**
   * The query an address needs so that opening it lands on `view`.
   *
   * `load()` reads `?v=` on a fresh open, so an address this page writes must
   * carry it wherever the view differs from the one the address would open
   * on, or a copied link would show a different view. Dropped for the build's
   * first view, which the path already implies.
   *
   * Shared by both places that write an address: the push that lands a swap
   * and the replace that calls one off.
   */
  viewQuery(view, views) {
    const first = views[0] && views[0].id;
    return view === first ? '' : `?v=${encodeURIComponent(view)}`;
  }

  /**
   * `query` with the frame on screen added as `c=`, so the address opens on
   * the angle the reader is looking from. Unchanged while there is no frame to
   * read. Wrapped round `viewQuery` by every address this page writes, and by
   * the Share window's link.
   */
  cameraQuery(query) {
    const frame = encodeCamera(this.frameCamera());
    return frame ? `${query}${query ? '&' : '?'}${CAMERA_QUERY}=${frame}` : query;
  }

  /**
   * The camera moved: the address follows once it has stood still for
   * `CAMERA_WRITE_MS`. Only a timer per event, since one comes every frame of
   * an orbit.
   */
  onCamera() {
    clearTimeout(this._camWrite);
    this._camWrite = setTimeout(() => this.writeCamera(), CAMERA_WRITE_MS);
  }

  /**
   * Rewrite `c=` in the address bar with the frame on screen, keeping the path
   * and every other parameter as written. Given a `view`, `v=` is rewritten
   * too, as `viewQuery` spells it (none for the first view); without one it
   * stays as it stands.
   *
   * A replace, never a push: moving the camera is not somewhere the reader
   * went, and Back must not walk through every angle. The commas stay
   * unescaped, which `URLSearchParams` would not leave them.
   */
  writeCamera(view) {
    const frame = encodeCamera(this.frameCamera());
    if (!frame) return;
    const key = (pair) => pair.split('=')[0];
    let kept = location.search.slice(1).split('&')
      .filter((pair) => pair && key(pair) !== CAMERA_QUERY);
    if (view !== undefined) {
      const views = (this.state.meta && this.state.meta.views) || [];
      const named = this.viewQuery(view, views).slice(1);
      kept = [...(named ? [named] : []), ...kept.filter((pair) => key(pair) !== 'v')];
    }
    history.replaceState(history.state, '', `${location.pathname}?`
      + `${[...kept, `${CAMERA_QUERY}=${frame}`].join('&')}${location.hash}`);
  }

  /**
   * Ask the viewport for this view again — the button on the failed-view panel.
   *
   * The only way back from a view that did not render: the viewport remembers
   * a failed load so the state event sent on every click does not re-fetch a
   * missing file forever (`loadFailed` in viewport/element.js), and nothing
   * else clears that memory — choosing a revision is a navigation, and
   * `showView` returns early for the current id.
   *
   * `__retry`, not a method on the element, because it is a one-shot command
   * like `__resetCut` and `__clearMeasure`: it rides the state event, is acted
   * on, and is deleted.
   *
   * `viewError` is cleared here so the panel goes while the fetch runs. Nothing
   * else has to put it back — a second failure emits `hmr:error` again, and a
   * success clears it through the model handler.
   */
  retryView() {
    this.set({ viewError: null }, { __retry: true });
  }

  /**
   * All derived values and handlers. render() below only lays them out.
   *
   * Seven panels are built in their own modules — `proposalView`, `rowMenu`,
   * `chromeView`, `revisionView`, `downloadsView`, `feedView`, `comparePanel` —
   * each a plain function of the state and a bag of this page's actions, whose
   * result is spread into or read out of the object below.
   *
   * What stays here is what more than one of them needs: the tree's rows, the
   * two flags every panel asks (`narrow`, `compared`), and the section's row,
   * whose `clearSection` is one closure used in two places. What panels draw
   * with (popover recipe, controls, tree icons) is ui/src/panelstyle.js, which
   * each imports.
   *
   * The object is the contract: fifteen files in ui/tests build this component
   * by hand and assert on its keys by name, so a key must keep its meaning and
   * renaming one is not a refactor.
   */
  computed() {
    const s = this.state;
    const tree = s.tree;
    const meta = s.meta;
    const viewer = this.viewer();
    const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };
    const hiddenSet = new Set(s.hidden);
    const ghostSet = new Set(s.ghost);
    // The selected row, resolved — not `sel` compared against each row's id. A
    // row may stand for several copies, and `sel` may hold a non-first copy's
    // path: the pick handler resolves it through `node()` only if the tree had
    // landed, and nothing re-resolves it later (`stagedSelection` in `onModel`
    // handles only a staged body's id becoming its scene path). Compared raw,
    // such a selection would light all five copies in the scene and no row in
    // the panel. Every path of a row is a key of `nodes` (`indexTree`), so this
    // is the same Map lookup; hoisted because `sel` cannot change here.
    const selRow = this.node(s.sel);

    const overlayPath = this.overlayRoot(tree);

    // -- the tree: a flat list of rows, indented by depth
    const rows = [];

    const emit = (node) => {
      // THE OVERLAY IS NOT A ROW OF THIS TREE. Its bodies are drawn in the
      // proposal's own branch below (`proposalRows`), where the moves are too,
      // and a body drawn in both places is one statement the reader can act on
      // twice: two eyes, two `×`es, one of them putting back what the other took
      // away. THE SCENE IS UNTOUCHED — the group is still staged under the
      // model's root and every path is the one the picker, the moves and a
      // swap's carried hidden state are already spelled in.
      if (node.id === overlayPath) return;
      const expanded = !!s.expanded[node.id];
      // Nor is it counted by the row above it: `indexTree` builds a group's
      // `leaves` from every leaf underneath, and the overlay is staged under the
      // model's root, so the root row would count the bodies and its eye would
      // hide what the branch below has its own eye for.
      //
      // Only the root can differ, since the overlay hangs under it; every other
      // row gets its own list back unchanged, which the `some` guard ensures
      // before copying.
      const leaves = overlayPath
        && node.leaves.some((id) => id.startsWith(`${overlayPath}/`))
        ? node.leaves.filter((id) => !id.startsWith(`${overlayPath}/`))
        : node.leaves;
      const visible = leaves.filter((id) => !hiddenSet.has(id)).length;
      const eye = visible === 0 ? 'off' : visible === leaves.length ? 'on' : 'part';
      const ghosted = leaves.length > 0 && leaves.every((id) => ghostSet.has(id));
      // `null` for an empty or stale `sel`, and a row is always an object, so
      // no row is drawn selected — which is what the raw comparison did too.
      const selected = selRow === node;
      const meta_ = node.isNode
        ? (eye === 'part' ? `${visible}/${leaves.length}` : String(leaves.length))
        : (node.known ? '' : '?');
      rows.push({
        key: node.id,
        rowStyle: 'display:inline-flex;align-items:center;gap:2px;height:24px;padding:0 6px 0 3px;margin:0 0 1px ' + (node.depth * 16) + 'px;border-radius:4px;background:' + (selected ? 'var(--accent-bg)' : 'var(--float-bg-soft)') + ';cursor:default',
        // A stroked path, not a glyph: `▾` (U+25BE) is a small triangle whose ink
        // size the font decides; a path in a 16-unit viewBox is the only form
        // whose size this file controls.
        //
        // That it is drawn at the weight of the expand-all and collapse-all
        // buttons above the tree is pinned by ui/tests/repeats.test.js.
        caretPath: node.isNode ? (expanded ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4') : '',
        caretStyle: 'width:20px;height:20px;flex:none;display:flex;align-items:center;justify-content:center;color:var(--text-soft);cursor:pointer;' + (node.isNode ? '' : 'visibility:hidden'),
        onExpand: stop(() => node.isNode
          && this.setState({ expanded: { ...s.expanded, [node.id]: !expanded } })),
        eyeOuter: eyeOuter(eye), eyeDot: eyeDot(eye), ghostIcon: ghostIcon(ghosted),
        dotStyle: SWATCH + (node.color || 'transparent') + (node.isNode ? ';border:1px solid var(--line-strong);background:transparent' : ''),
        // `pin ×5` where the row collapsed five copies of one part.
        // A group never gets one: its `leaves` is every leaf underneath it
        // (`indexTree`), so `housing ×3` would read as three housings rather
        // than three parts inside one. The count is still visible in `meta_` on
        // the right (`visible/total` while some but not all are hidden, bare
        // otherwise).
        name: node.isNode ? node.name : countedName(node.name, node.leaves.length),
        nameStyle: 'white-space:nowrap;cursor:pointer;padding-right:4px;font:' + (node.isNode ? '600 12px ' : '400 12px ') + MONO + ';color:' + (eye === 'off' ? 'var(--text-faint)' : 'var(--text)'),
        meta: meta_,
        // Said out loud rather than dropped: a leaf the viewport could not match
        // to the library's own state map is a row nothing can be done to, and a
        // tree missing a row reads as a build with fewer parts.
        metaTitle: node.isNode || node.known ? '' : 'the viewport does not know this part',
        metaStyle: INDEX_MONO,
        // A group toggles as a whole: anything still visible means hide it all,
        // nothing visible means show it all. Expressed in leaf ids — see
        // hub.indexTree for why.
        // `setVisibility`, not `set`, here and at every other writer of these
        // lists: a swap in flight carries them across by name, and a row clicked
        // in that window belongs to the leaving tree. See the method.
        // `leaves`, not `node.leaves`, so the model root's eye does not reach
        // into the proposal, whose bodies have their own eye in the branch below.
        // For every other row the two lists are the same object.
        onVis: stop(() => this.setVisibility({ hidden: this.toggle(s.hidden, leaves) })),
        onGhost: stop(() => this.setVisibility({ ghost: this.toggle(s.ghost, leaves) })),
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
    //
    // The fallback stays here while the rows moved out: the object below names
    // exactly what builds.json carries, and `tests/test_ui_source.py` reads it
    // from this file as text to check it against what `src/render.py` writes.
    // So the picker is handed its fallback.
    const info = s.builds || { has_dev: false, latest: null, builds: [] };
    const { revRows, revEmpty } = revisionView(s, info, {
      stop,
      commitOf: this.commitOf.bind(this),
      setState: this.setState.bind(this),
      switchBuild: this.switchBuild.bind(this),
    });

    // -- the downloads, out of the part catalogue: key -> {extension -> file},
    //    and the board's Gerbers among the build's documents
    //
    // With the key to the build on screen, asked of `PAGE.slot` here rather
    // than kept: the address moves under a revision switch, and builds.json
    // carries a key for every address it can move to.
    const catalogue = (meta && meta.parts) || null;
    const filesKey = filesKeyFor(s.builds, PAGE.slot, this._linkKey);
    const { downloadGroups, anyDownloads, dlShown } = downloadsView(catalogue, {
      groupDownloads, downloadAll: this.downloadAll.bind(this), key: filesKey,
      documents: meta && meta.documents,
    });

    // -- the project's comment queue, as `loadFeed` fetched it
    const { threads, openCount } = feedView(s, {
      meta, catalogue, stop,
      node: this.node.bind(this),
      set: this.set.bind(this),
      resolveComment: this.resolveComment.bind(this),
    });

    // ONE RESET BEHIND TWO DOORS — the section popover's `reset` button and the
    // row menu's Delete. They are one closure and not two copies of the same
    // four fields, because the fields are not the whole of it: the `__resetCut`
    // beside them is what tells the viewport to drop the plane as well
    // (`element.js`), and a copy that lost it would leave the cut on screen
    // while every field on this side read as cleared.
    const clearSection = () => this.set(
      { secOn: false, secFace: null, secOff: 0, secFlip: false },
      { __resetCut: true });

    // The only question the narrow layout asks; every answer depending on it is
    // baked into a style string below rather than branched on in `render()`,
    // except where it changes which elements exist. `!!` because a hand-written
    // state (every test in ui/tests) may omit the field, and absent means wide.
    //
    // Computed this early because the row menu needs it too and is handed this
    // value, so the two cannot disagree.
    const narrow = !!s.narrow;

    // IS THE SCENE ON SCREEN A COMPARISON'S — asked once, for the two sections
    // that gate controls on it: the row menu drops every item that would write
    // the build's visibility or name one of its files, and the proposal's
    // branch drops the eye and the ghost square for the same reason. Both
    // arguments are written out where the items are. `toolsOff()` is the same
    // question of the same method, asked for the three canvas tools.
    const compared = !!this.comparePair();

    // THE ROW MENU, BUILT NEXT DOOR — ui/src/rowmenu.js. Both doors into it,
    // the tree row and the part in the scene, write `s.menu`, so the module is
    // handed the whole state and reads the subject out of that one field.
    const menu = rowMenu(s, {
      tree, viewer, narrow, compared, catalogue, anyDownloads, fileHref, filesKey,
      clearSection, stop, SECTION_ROW,
      noteFor, partRecord, fileList,
      node: this.node.bind(this),
      proposalBody: this.proposalBody.bind(this),
      set: this.set.bind(this),
      setState: this.setState.bind(this),
      setVisibility: this.setVisibility.bind(this),
      toast: this.toast.bind(this),
      toggle: this.toggle.bind(this),
    });

    const cutOn = s.secOn || s.held;

    // Both notes on the part in front of the reader, read once: the box below
    // asks three questions of each of them (is it there, does the box open, does
    // a rule go between them) and a method call per question would let the two
    // halves of one box answer from two different reads.
    const authorNote = this.authorNote();
    const readerNote = this.selectedNote();

    // -- the proposal: a rough body in numbers, laid over the model -----------
    //
    // OPEN UNLESS THE READER FOLDED IT, which is what `!== false` says and a
    // truthy read could not: the branch is only ever drawn over a document that
    // has something in it, and a row that arrives already folded away is a row
    // they have to go and find. The expand-all and collapse-all buttons above
    // the tree are expressed over `tree.nodes` and say nothing about this one.
    const branchOpen = s.expanded[PROPOSAL_BRANCH] !== false;

    // THE BRANCH AND THE MENU'S ROWS, BUILT NEXT DOOR — ui/src/proposalview.js,
    // which says what this bag is. The doors are handed over rather than reached
    // for: a module that held `this` would be a second copy of the component,
    // and every one of these is a method whose whole job is to write the page's
    // state or push the viewport.
    const proposal = proposalView(s, {
      tree, overlayPath, hiddenSet, ghostSet, selRow, compared,
      branchOpen, PROPOSAL_BRANCH, stop, menuAt,
      node: this.node.bind(this),
      // ONE COUNTER FOR THE WHOLE PAGE, which is what keeps two nodes from
      // being minted under one id — see `_proposalSeq` in the constructor. It
      // is bumped here and read back, so a caller cannot forget the bump.
      nextSeq: () => { this._proposalSeq += 1; return this._proposalSeq; },
      set: this.set.bind(this),
      setState: this.setState.bind(this),
      setVisibility: this.setVisibility.bind(this),
      toggle: this.toggle.bind(this),
      typeProposal: this.typeProposal.bind(this),
      commitProposal: this.commitProposal.bind(this),
      commitSnapStep: this.commitSnapStep.bind(this),
      nudgeProposal: this.nudgeProposal.bind(this),
      setProposal: this.setProposal.bind(this),
      toggleProposalEye: this.toggleProposalEye.bind(this),
      toggleMoveEye: this.toggleMoveEye.bind(this),
      removeProposal: this.removeProposal.bind(this),
    });

    // -- the comparison panel, which stands where the tree stands
    const compare = comparePanel(s, {
      stop,
      compareRows, compareSummary, statusChip, rowReason, mm3,
      NOT_COMPARED, NOT_COMPARED_WHY,
      set: this.set.bind(this),
      leaveCompare: this.leaveCompare.bind(this),
      compareRevisions: this.compareRevisions.bind(this),
    });

    // THE CHROME, BUILT NEXT DOOR — ui/src/chromeview.js. It is handed the four
    // panels' own answers above rather than building them: the rail's count is
    // drawn on a header button, the picker's rows inside a header menu, and a
    // second count worked out up there could disagree with the rail it is about.
    const chrome = chromeView(s, this.props, {
      meta, viewer, narrow, stop,
      revRows, downloadGroups, dlShown, threads, openCount,
      viewPartCount, HOLD_KEY_LABEL, VIEW_TABS_MAX,
      set: this.set.bind(this),
      setState: this.setState.bind(this),
      // THE STATE AS IT STANDS WHEN THE HANDLER RUNS, and not as it stood when
      // this object was built: both readers of it are inside a `setState`
      // callback, where the point is that the update has landed. See the token
      // control, which is the only place it is spent.
      stateNow: () => this.state,
      toast: this.toast.bind(this),
      toolsOff: this.toolsOff.bind(this),
      subtitle: this.subtitle.bind(this),
      applyTheme: this.applyTheme.bind(this),
      closeTab: this.closeTab.bind(this),
      compareRevisions: this.compareRevisions.bind(this),
      fitView: this.fitView.bind(this),
      saveFrame: this.saveFrame.bind(this),
      showView: this.showView.bind(this),
      loadFeed: this.loadFeed.bind(this),
      loadProposal: this.loadProposal.bind(this),
      refreshBuilds: this.refreshBuilds.bind(this),
      viewQuery: this.viewQuery.bind(this),
      cameraQuery: this.cameraQuery.bind(this),
      proposalMoves: this.proposalMoves.bind(this),
      proposalOverlay: this.proposalOverlay.bind(this),
      stageProposal: this.stageProposal.bind(this),
    });

    // The composer's Send, reached by the button and by Enter in the textarea.
    const send = () => this.sendComment().catch((error) => {
      console.error('comment', error);
      this.toast('Could not send the comment');
    });

    return {
      rootClick: () => this.setState({ menu: null, revOpen: false, dlOpen: false, viewsOpen: false, opsOpen: false, settingsOpen: false, tokenPop: false }),

      // -- the page's chrome ---------------------------------------------------
      //
      // The header, the token control, the tab strip, the view switcher and the
      // floating toolbar are `chromeView` in ui/src/chromeview.js: everything
      // round the model that is not a panel about the model.
      ...chrome,

      viewError: s.viewError || '',
      viewErrorStyle: 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:420px;padding:14px 16px;background:var(--card-bg);border:1px solid var(--danger-line);border-radius:9px;box-shadow:0 8px 28px var(--shadow);z-index:14;text-align:center;display:' + (s.viewError ? 'block' : 'none'),
      retryView: () => this.retryView(),

      notCompare: !s.compare, compare: s.compare,
      hasTree: !!tree,
      // THE PROPOSAL'S BRANCH IS CARRIED THROUGH BOTH OF THESE rather than
      // dropped. They are the PARTS tree's buttons — they sit in its own header
      // and are expressed over `tree.nodes`, which the branch is not in — but
      // they both REBUILD the map rather than patching it, so a branch the
      // reader had folded would silently spring open when either was pressed.
      // Written into a copy for the reason `proposalToggle` gives.
      expandAll: () => {
        const expanded = Object.fromEntries(Array.from(tree ? tree.nodes.values() : [])
          .filter((n) => n.isNode).map((n) => [n.id, true]));
        expanded[PROPOSAL_BRANCH] = branchOpen;
        this.setState({ expanded });
      },
      collapseAll: () => {
        const expanded = {};
        expanded[PROPOSAL_BRANCH] = branchOpen;
        this.setState({ expanded });
      },
      // RENDERED ABOVE THE ROWS AND OUTSIDE THE `hasTree` BRANCH, so this one is
      // pressable on a page whose tree never arrived — which is exactly the
      // state where a swap's carry is the only record of what was hidden. Hence
      // `setVisibility`; see the method.
      showAll: () => this.setVisibility({ hidden: [], ghost: [] }),
      rows,

      // The section is a ROW in the tree with its own eye, not a mode with a
      // panel: a panel in the page's column takes height from the canvas, so
      // every press and release of the hold key would resize the model.
      secRowStyle: 'flex:none;display:inline-flex;align-items:center;gap:7px;margin:0 0 3px;padding:4px 8px;border-radius:5px;border:1px solid ' + (cutOn ? 'var(--accent-line);background:var(--accent-bg-soft)' : 'transparent;background:var(--float-bg-soft)'),
      secEyeClick: stop(() => this.set({ secOn: !s.secOn })),
      // THE SAME GESTURE THE PARTS BELOW ANSWER TO, on the row above them: a
      // right-click here opens the one shared menu under `SECTION_ROW`, where
      // `menuItems` has the cut's own two items waiting. `menuAt` and not a
      // second clamp, for the reason the helper itself gives — the third door
      // into this menu must not put it somewhere the other two would not.
      secRowMenu: stop((e) => {
        e.preventDefault();
        this.setState({ menu: { id: SECTION_ROW, ...menuAt(e.clientX, e.clientY) } });
      }),
      secEyeOuter: eyeOuter(cutOn ? 'on' : 'off'), secEyeDot: eyeDot(cutOn ? 'on' : 'off'),
      secSub: s.held ? `held · ${HOLD_KEY_LABEL}` : secSub,
      openSecPop: stop(() => this.setState({ secPop: true })),
      closeSecPop: stop(() => this.setState({ secPop: false })),
      // Clamped to the screen: at `left:278px` and 270px wide, the close cross
      // sits past 540px, off a phone screen. `rootClick` does not clear this
      // popover, the panel stops the click anyway, and a phone has no Escape
      // key, so unclamped it could only be closed by reloading. On narrow it is
      // reached through the tree, opened by the "Parts" button.
      secPopStyle: popover({
        narrow, anchor: 'left:278px;top:52px', width: '270px', radius: '10px',
        pad: '13px 14px', z: 15, open: s.secPop }),
      pickFace: stop(() => { this.set({ tool: 'cut', secPop: false }); this.toast('Click a face — the plane will sit on it'); }),
      pickFaceStyle: `padding:7px;text-align:center;border-radius:6px;font:600 11.5px ${MONO};cursor:pointer;` + (s.tool === 'cut' ? 'background:var(--accent-bg);color:var(--accent-text);border:1px solid var(--accent-line)' : ON_ACCENT_EDGE),
      pickFaceText: s.tool === 'cut' ? 'now click a face on the model…' : (s.secFace ? 'pick another face' : 'pick a face to place the plane'),
      secOff: s.secOff, secMin: secRange[0], secMax: secRange[1],
      secStep: Math.max(0.1, Math.round((secRange[1] - secRange[0]) / 40) / 10),
      secOffLabel: `${s.secOff >= 0 ? '+' : ''}${s.secOff.toFixed(1)} mm`,
      setSecOff: (e) => this.set({ secOff: parseFloat(e.target.value), secOn: true }),
      flipSec: stop(() => this.set({ secFlip: !s.secFlip })),
      resetSec: stop(clearSection),
      toggleHatch: stop(() => this.set({ hatch: !s.hatch })),
      hatchBox: 'width:15px;height:15px;border-radius:4px;flex:none;display:flex;align-items:center;justify-content:center;font:600 10px monospace;' + (s.hatch ? ON_ACCENT : BLANK_BOX),
      hatchMark: s.hatch ? '✓' : '',

      // -- the proposal's branch of the tree, and the menu's rows ------------
      //
      // Both of them, and the fields the rows are made of, are `proposalView` in
      // ui/src/proposalview.js: twenty-one keys that answer to nothing on
      // this page but the document, the flags above and the doors handed to it.
      ...proposal,

      // -- the two notes on the selected part ---------------------------------
      //
      // One box, two labelled halves: notes from two sources with different
      // rights, and a reader who cannot tell them apart will read their own
      // reminder as the author's specification. The author's comes first,
      // since it describes the part.
      //
      // The author's note is published content, drawn with or without a token.
      // The reader's keeps the token gate ("no token, no edits"); a note shown
      // with no way to change it would be a box the reader cannot get out of.
      // The box opens for either alone: an author note seen by a viewer is the
      // ordinary case.
      noteBoxStyle: 'position:absolute;right:14px;top:14px;width:250px;padding:9px 11px;background:var(--warn-bg);border:1px solid var(--warn-line);border-radius:7px;box-shadow:0 4px 16px var(--shadow-soft);z-index:11;display:'
        + (!s.compare && (authorNote || (!viewer && readerNote)) ? 'block' : 'none'),
      // THE HEADING IS THE CATALOGUE KEY AND NOT THE ROW'S LABEL, because that
      // is what the two notes below it are actually about. The row is one solid
      // in one view UNLESS the row collapsed repeats of one part, and then it is
      // all of them — so a heading taken from the row would claim an identity
      // the note does not have.
      noteName: this.selectedKey(),
      authorNoteStyle: 'display:' + (authorNote ? 'block' : 'none') + ';margin-top:5px',
      authorNote,
      // The rule above it only when there IS something above it — otherwise the
      // one note in the box gets a line separating it from nothing.
      readerNoteStyle: 'display:' + (!viewer && readerNote ? 'block' : 'none')
        + (authorNote
          ? ';margin-top:7px;padding-top:7px;border-top:1px solid var(--warn-line)'
          : ';margin-top:5px'),
      noteText: readerNote,
      // The link edits the READER's note and nothing else, so it says so and it
      // goes away entirely without a token. It also says which of "add" and
      // "edit" it is about to do, because with an author note on screen the box
      // now stands for parts this browser has written nothing about — and that
      // is the one place a reader can start one from besides the row menu.
      editNoteStyle: 'cursor:pointer;color:var(--text-muted);font-weight:400;text-transform:lowercase'
        + (viewer ? ';display:none' : ''),
      editNoteLabel: readerNote ? 'edit yours' : 'add yours',
      editNote: stop(() => this.setState({ notePop: this.selectedKey(), noteDraft: this.selectedNote() })),

      // -- comparing two revisions ---------------------------------------------
      //
      // The panel that stands where the tree stands is `compareView` in
      // ui/src/compareview.js.
      ...compare,

      // The new build is offered, never substituted: somebody may be halfway
      // through a section with half the tree hidden, and a model that changes by
      // itself reads as a breakage.
      bannerStyle: chip(!!s.pending && !s.bannerGone, 'var(--card-bg)', 'var(--line)', 'var(--text)') + ';padding:8px 8px 8px 14px',
      bannerId: s.pending ? shortId(s.pending.commit) : '',
      bannerSwitch: () => this.takePending(),
      // A revision picked from the picker disables this button, and it must look
      // disabled: `takePending` refuses on `swapping` either way, and a button
      // that looks clickable but does nothing is the failure the refusal exists
      // to prevent. It lasts one fetch: `swapFailed` and the swap's landing both
      // lower the flag.
      //
      // `--accent-muted` is the washed accent surface role, not `--accent-line`,
      // which is a border colour.
      bannerSwitchStyle: `padding:5px 12px;background:${s.swapping ? 'var(--accent-muted)' : 'var(--accent)'};`
        + `color:var(--text-on-accent);border-radius:5px;font:600 12px ${SANS};`
        + `cursor:${s.swapping ? 'default' : 'pointer'}`,
      bannerLater: () => this.dismissPending(),

      // The chips stand clear of the tree: 278px is a hand-tuned clearance for
      // the open tree (its rows are `inline-flex`, so it has no declared width).
      // On narrow the tree starts closed and covers the model when open, so the
      // chips take the tree's left margin instead.
      chipsStyle: 'position:absolute;left:' + (narrow ? '12px' : '278px')
        + ';top:14px;display:flex;flex-direction:column;gap:8px;align-items:flex-start;'
        + 'pointer-events:none;z-index:13',
      measChipStyle: chip(!!s.measure && !s.composer, 'var(--card-bg)', 'var(--line)', 'var(--text)'),
      measText: s.measure ? s.measure.text : '',
      measNote: s.measure ? s.measure.note : '',
      // Measuring is open to everyone, so the CHIP stays; filing a comment is
      // not, so the link goes — the same gate the move tool, the comment tool,
      // the note box and the composer carry. Without it the link opens a
      // composer that `composerStyle` keeps at `display:none`: nothing appears,
      // the chip goes grey because it hides itself while a composer stands, and
      // there is no close button on screen to take it back. The composer then
      // opens with that stale measurement in it the moment a token is entered.
      measAddStyle: LINK
        + (viewer ? ';display:none' : ''),
      // `part` is a displayed string only: `composerPart` heads the composer with
      // it, and `sendComment` copies it into the session's record, from which
      // `computed` builds the rail's thread. What is posted is `partId`.
      //
      // Two places fill it with a name: the `hmr:place` handler (a point picked
      // in the scene) and this one (a measurement). `leaveBuild` empties it
      // (`part: ''`) because the build it was attached to has left. Both name the
      // row, not the solid the viewport reported, because a collapsed run's
      // solid name (`pin(2)`) is on no row; where the run did not collapse, that
      // solid is its own row and the lookup finds it.
      //
      // They differ in the `partId` beside it, which reaches the hub:
      // `hmr:place` posts the exact solid (`/model/pin(2)`), this one posts
      // `sel`, resolved to the row (the run's first path) — or nothing, when the
      // selection is a proposal body (see below). Each posts the narrowest thing
      // its gesture was about.
      //
      // Neither carries a count: a measurement is anchored to whatever is
      // selected, so `pin ×5` would claim five copies were measured, and a
      // placed point sits on one solid. The spanning-parts qualifier rides in
      // the measurement text (`measureLabel`).
      measAdd: () => {
        // The ROW's plain name where the tree can answer, and `selName` where
        // it cannot — which is the row's name too, since the pick handler
        // resolves it while the tree is still standing; the picked solid's name
        // survives in it only for a path no row ever claimed. Bare either way,
        // for the reason the inventory above gives.
        const node = this.node(s.sel);
        // A proposal body is attached to nothing. `onPick` writes `sel` for any
        // picked path, bodies included (Move mode's `onDown` emits that pick
        // too), so measuring on the motor and pressing `add to comment` would
        // post a `partId` no build resolves. The number stays; only the
        // attribution goes. `key` needs nothing extra: a body has no catalogue
        // key (`part()` in proposalgeom.js), so the row's is null.
        //
        // A selection that is not a path is one too: a branch row selects by the
        // document's node id wherever the scene cannot place it (nothing staged,
        // a refused document, a comparison up), and `isOverlay` cannot recognise
        // that.
        //
        // Tested by shape, not `doc.nodes.some(...)`: a refused document repaired
        // by `×` on the broken body leaves `sel` at `n5` over a document without
        // it, and membership would miss it.
        //
        // This relies on every tree id being a path: `treeFromShapes` spells ids
        // as `${parent}/${name}`, driven by ui/tests/proposalpanel.test.js.
        const proposed = this.proposalBody(s.sel)
          || (!!s.sel && !s.sel.startsWith('/'));
        this.openComposer({
          part: proposed ? '' : (node ? node.name : (s.selName || 'model')),
          partId: proposed ? null : (s.sel || null),
          key: node ? node.key : null,
          p: null, text: '', photo: null, meas: s.measure.full,
        });
      },
      measClear: () => this.set({ measure: null }, { __clearMeasure: true }),

      // Hidden, not unmounted, while a document covers the model: the draft is
      // about the model and comes back with it, sentence and all.
      composerStyle: 'position:absolute;right:16px;bottom:16px;width:400px;background:var(--card-bg);border:1px solid var(--line);border-radius:10px;box-shadow:0 12px 40px var(--shadow);z-index:16;display:' + (s.composer && !viewer && !chrome.docOpen ? 'block' : 'none'),
      nextLabel: String(s.feed.length + 1),
      composerPart: s.composer ? s.composer.part : '',
      composerText: s.composer ? s.composer.text : '',
      compType: (e) => this.setState({ composer: { ...s.composer, text: e.target.value } }),
      compMeasChipStyle: 'display:' + (s.composer && s.composer.meas ? 'flex' : 'none') + `;align-items:center;gap:5px;padding:4px 8px;background:var(--warn-bg);border-radius:5px;font:500 10.5px ${MONO};color:var(--warn)`,
      compMeasText: (s.composer && s.composer.meas) || '',
      compMeasRemove: stop(() => this.setState({ composer: { ...s.composer, meas: null } })),
      compPhotoName: s.composer && s.composer.photo ? s.composer.photo.name : '',
      compPhoto: (e) => {
        const file = e.target.files && e.target.files[0];
        this.setState({ composer: { ...s.composer, photo: file || null } });
      },
      compCancel: stop(() => this.set({ composer: null })),
      compSend: send,
      // Enter sends, Shift+Enter falls through to the textarea's own newline.
      compKey: (e) => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        e.preventDefault();
        send();
      },
      // The press must be visible — the other half of the refusal in
      // `sendComment`, as with `bannerSwitchStyle`. The send spans a frame grab,
      // an upload and two requests, and the composer keeps its draft until the
      // write clears it, so the label says what is happening and the washed
      // accent says the button is spent.
      compSendLabel: s.sending ? 'Sending…' : 'Send',
      compSendStyle: `padding:6px 14px;background:${s.sending ? 'var(--accent-muted)' : 'var(--accent)'};`
        + `color:var(--text-on-accent);border-radius:6px;font:600 12px ${SANS};`
        + `cursor:${s.sending ? 'default' : 'pointer'}`,

      // -- the menu a right-click opens, on a row of the tree or on the part
      // in the scene: `rowMenu` in ui/src/rowmenu.js.
      ...menu,

      // Clamped like `secPopStyle`, and worse unclamped: at `left:310px` and
      // 300px wide, Cancel and Save sit past 480px, off a phone screen (the row
      // is `justify-content:flex-end`). `rootClick` does not clear `notePop`,
      // the panel stops the click, and a phone has no Escape key. Reached there
      // through the note box and the tree row's context menu.
      notePopStyle: popover({
        narrow, anchor: 'left:310px;top:120px', width: '300px', radius: '10px',
        pad: '13px 14px', shadow: POP_SHADOW_HIGH, z: 60, open: s.notePop }),
      notePopName: s.notePop || '',
      noteDraft: s.noteDraft,
      noteType: (e) => this.setState({ noteDraft: e.target.value }),
      noteCancel: stop(() => this.setState({ notePop: null })),
      noteSave: stop(() => {
        // Through `notesWith` rather than `notes[key] = …`: the key is a
        // CATALOGUE KEY out of a pushed document, and a part called `__proto__`
        // turns that assignment into a silent no-op — see the function's own
        // note.
        this.saveNotes(notesWith(s.notes, s.notePop, s.noteDraft.trim()));
        this.setState({ notePop: null });
      }),

      toastStyle: `position:absolute;left:50%;bottom:18px;transform:translateX(-50%);padding:9px 16px;background:var(--tooltip-bg);color:var(--tooltip-text);border-radius:7px;font:500 12px ${SANS};box-shadow:0 6px 20px var(--shadow);z-index:70;display:` + (s.toast ? 'block' : 'none'),
      toastText: s.toast || '',
    };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ ...css(`position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:${PAGE_BG};color:${PAGE_FG};font:400 13px ${SANS};z-index:5`), ...FONTS }}>
          <div style={css('max-width:420px;padding:18px 20px;background:var(--card-bg);border:1px solid var(--line);border-radius:9px')}>
            <div style={css(`font:600 13px ${SANS};margin-bottom:6px`)}>This build did not load</div>
            <div style={css(`font:400 12px/1.6 ${MONO};color:var(--text-soft)`)}>{this.state.error}</div>
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
        <style>{VIEWPORT_CSS}</style>

        {/* ── header: model, revision, status, downloads, access, comments ── */}
        <div style={css(v.headerStyle)}>
          <a href="/" title="all projects" style={css('display:flex;align-items:center;gap:8px;text-decoration:none;color:inherit')}>
            {/* `<Mark />`, not the same SVG written out again. It WAS written out
                again — byte for byte, defaults and all — which is the third copy
                of a logo that only style.jsx is supposed to own, and the two
                pages carrying two of the copies link to each other. A mark that
                changes when you navigate is one of the three reasons that module
                exists. */}
            <Mark />
            {v.showWordmark && <span style={css(WORDMARK)}>hammerola</span>}
          </a>
          <div style={css(HEADER_RULE)} />
          <div style={css(v.titleColStyle)}>
            <div style={css(TITLE)}>{v.title}</div>
            {v.showSubtitle && <div style={css(`font:400 10.5px ${MONO};color:var(--text-muted);white-space:nowrap`)}>{v.subtitle}</div>}
          </div>

          <div style={css('position:relative;margin-left:8px;flex:none')}>
            <div onClick={v.revToggle} title={v.slotTitle} style={css(v.revBtnStyle)}>
              <span style={css(v.statusDotStyle)} />
              <span style={css(HEAD_MONO)}>{v.slot}</span>
              <span style={css(META_MONO)}>{v.slotDate}</span>
              {v.revPicker && <span style={css('font-size:9px;color:var(--text-faint)')}>&#9662;</span>}
            </div>

            {/* pointers on top, the history below; the ticks pick two to compare */}
            {v.revPicker && (
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
                          <span title={r.message} style={css(r.messageStyle)}>{r.message}</span>
                          <span style={css(META_MONO)}>{r.date}</span>
                        </span>
                        <span onClick={r.onShare} title="Share" style={css(r.shareIconStyle)}>
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 10V1.8M5 4.8l3-3 3 3M3.5 7.5v6.5h9V7.5" /></svg>
                        </span>
                      </div>
                    </React.Fragment>
                  ))}
                  {v.revEmpty && (
                    <div style={css(`padding:12px 14px;font:400 11.5px ${SANS};color:var(--text-muted)`)}>
                      This project has no other builds yet.
                    </div>
                  )}
                </div>
                <div style={css('display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid var(--line-soft)')}>
                  <div onClick={v.startCompare} style={css(v.compareBtnStyle)}>Compare {v.cmpLabel}</div>
                </div>
              </div>
            )}
          </div>

          {v.showStatus && <div style={css(v.statusChipStyle)}>{v.statusText}</div>}
          <div style={css(FILL)} />

          {/* downloads: whole-build files, exactly the ones meta.json names,
              for a reader holding the key that opens them */}
          {v.dlShown && (
            <div style={css(RELATIVE)}>
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
                      <span style={css(FILL)}>{g.ext}</span>
                      <span onClick={g.onAll} style={css(g.allStyle)}>download all</span>
                    </div>
                    {g.files.map((f) => (
                      <div key={f.key} style={css(f.rowStyle)}>
                        <a href={f.href} download style={css(f.style)}>
                          <span style={css(FILL)}>{f.label}</span>
                          <span style={css(`font:400 10.5px ${MONO};color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px`)}>{f.file}</span>
                        </a>
                        <CopyLink href={f.href} style={f.copyStyle} />
                      </div>
                    ))}
                  </React.Fragment>
                ))}
                {v.downloadGroups.length === 0 && (
                  <div style={css(`padding:10px 14px;font:400 11.5px ${SANS};color:var(--text-muted)`)}>
                    This build ships no files to download.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* access: the token is what turns a viewer into the customer */}
          <div style={css(RELATIVE)}>
            <div onClick={v.tokenToggle} style={css(v.tokenBtnStyle)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2.5" y="7" width="11" height="7" rx="1.5" /><path d="M5 7V4.8a3 3 0 0 1 6 0V7" /></svg>
              {v.tokenLabel}
            </div>
            <div onClick={(e) => e.stopPropagation()} style={css(v.tokenPopStyle)}>
              <div style={css(`font:600 12.5px ${SANS};margin-bottom:4px`)}>
                {v.viewer ? 'Enter your token' : 'Editing is on'}
              </div>
              <div style={css(`font:400 11.5px/1.6 ${SANS};color:var(--text-soft);margin-bottom:9px`)}>
                {v.viewer
                  ? 'EDIT_TOKEN — the same string `hammerola login` asks for. It opens notes, moving a part, and writing a comment. Without one you can still orbit, read the tree, cut a section and measure; the files download with the token, or from a link they were included in. It is kept in this browser, for the whole site.'
                  : 'The token is stored in this browser, for the whole site. Remove it to go back to viewing.'}
              </div>
              {v.viewer ? (
                <>
                  <input type="password" value={v.tokenDraft} onChange={v.tokenType}
                         placeholder="paste the token"
                         style={css(`width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:6px;outline:none;padding:8px 10px;font:400 12px ${MONO};background:var(--card-bg)`)} />
                  <div style={css('display:flex;justify-content:flex-end;margin-top:9px')}>
                    <span onClick={v.tokenSave} style={css(ACCENT_BTN)}>Save</span>
                  </div>
                </>
              ) : (
                <div style={css('display:flex;justify-content:flex-end')}>
                  <span onClick={v.tokenClear} style={css(`padding:6px 14px;border:1px solid var(--line);border-radius:6px;font:600 11.5px ${SANS};cursor:pointer;color:var(--danger);background:var(--card-bg)`)}>Remove token</span>
                </div>
              )}
            </div>
          </div>

          {/* The tree's own switch, drawn only where the tree is not simply
              there: narrow, it lies over the model rather than beside it, so it
              starts closed and something has to open it. Wide, this button is
              `display:none` — the tree is on screen already and a control that
              says "Parts" beside a visible list of them is noise. */}
          <div onClick={v.treeToggle} style={css(v.treeBtnStyle)}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 3h12M4.5 8H14M4.5 13H14" /></svg>
            Parts
          </div>

          <div onClick={v.railToggle} style={css(v.railBtnStyle)}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 2.5h12v8.5H8.5L5.5 14v-3H2z" /></svg>
            Comments
            <span style={css(v.railCountStyle)}>{v.openCount}</span>
          </div>

          {/* Light or dark for the whole page — here because #35 says here, and
              drawn immediately after the comments so it stands against them.
              Unconditional, deliberately: the two buttons above it are taken
              away by a wide window and by a missing token, and this is the one
              control in the row that belongs to the person rather than to what
              they are allowed to do. `computed()` has the whole argument. */}
          <div onClick={v.toggleTheme} title={v.themeTitle} style={css(v.themeBtnStyle)}>
            {v.themeDark ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M13.4 9.9A5.9 5.9 0 0 1 6.1 2.6 5.9 5.9 0 1 0 13.4 9.9z" /></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="3.1" /><path d="M8 1.2v1.7M8 13.1v1.7M1.2 8h1.7M13.1 8h1.7M3.2 3.2l1.2 1.2M11.6 11.6l1.2 1.2M12.8 3.2l-1.2 1.2M4.4 11.6l-1.2 1.2" /></svg>
            )}
            {v.themeLabel}
          </div>
        </div>

        {/* ── the tab strip: the projects this browser has been in lately ──
            Navigation memory next to the address and nothing more — plain
            links, in the order they were opened, the one matching this page's
            pid drawn as the active pill. */}
        {v.tabsShown && (
          <div style={css(v.tabsStyle)}>
            {v.tabs.map((t) => (
              <a key={t.key} href={t.href} title={t.label} style={css(t.style)}>
                <span style={css(t.labelStyle)}>{t.label}</span>
                {/* A bare span, the way every other close control on this page
                    is written — a `<button>` inside an `<a>` is not markup a
                    browser is required to make sense of. */}
                <span onClick={t.onClose} title="forget this project"
                      style={css('color:var(--text-faint);cursor:pointer;flex:none')}
                >&#10005;</span>
              </a>
            ))}
          </div>
        )}

        <div style={css('flex:1;display:flex;min-height:0;position:relative')}>

          {/* ── the tree, floating over the model; gone while a document
                covers the model (`docOpen`) ── */}
          <div style={css('position:absolute;left:12px;top:10px;max-height:calc(100% - 20px);display:flex;flex-direction:column;align-items:flex-start;overflow:auto;z-index:10' + (v.docOpen ? ';display:none' : ''))}>

            {v.notCompare && v.treeShown && (
              <div style={css('display:flex;flex-direction:column;min-height:0')}>
                <div style={css('flex:none;display:flex;align-items:center;gap:2px;padding:0 0 3px')}>
                  <span onClick={v.expandAll} title="expand all" style={css(TOOL_SQUARE)}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 5.5L8 1.5l4 4M4 10.5l4 4 4-4" /></svg>
                  </span>
                  <span onClick={v.collapseAll} title="collapse all" style={css(TOOL_SQUARE)}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 1.5l4 4 4-4M4 14.5l4-4 4 4" /></svg>
                  </span>
                  <span onClick={v.showAll} title="show all parts" style={css(TOOL_SQUARE)}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><ellipse cx="8" cy="8" rx="6.5" ry="4.5" /><circle cx="8" cy="8" r="1.8" /></svg>
                  </span>
                </div>

                <div onContextMenu={v.secRowMenu} style={css(v.secRowStyle)}>
                  <div onClick={v.secEyeClick} style={css('width:24px;display:flex;justify-content:center;cursor:pointer;padding:2px 0')}>
                    <span style={css(v.secEyeOuter)}><span style={css(v.secEyeDot)} /></span>
                  </div>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="var(--text-soft)" strokeWidth="1.4" style={{ flex: 'none' }}><rect x="2" y="2" width="12" height="12" rx="1" /><path d="M2 14L14 2" /></svg>
                  <span onClick={v.openSecPop} style={css(`font:600 12px ${MONO};color:var(--text);cursor:pointer;white-space:nowrap`)}>section</span>
                  <span onClick={v.openSecPop} style={css(`font:400 10.5px ${MONO};color:var(--text-muted);cursor:pointer;white-space:nowrap;padding-right:2px`)}>{v.secSub}</span>
                </div>

                <div style={css('padding:1px 0 6px;display:flex;flex-direction:column;align-items:flex-start')}>
                  {v.rows.map((row) => (
                    <div key={row.key} onContextMenu={row.onMenu} style={css(row.rowStyle)}>
                      <span onClick={row.onExpand} style={css(row.caretStyle)}>
                        {row.caretPath && (
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d={row.caretPath} /></svg>
                        )}
                      </span>
                      <span onClick={row.onVis} title="show / hide" style={css(SLOT_24)}>
                        <span style={css(row.eyeOuter)}><span style={css(row.eyeDot)} /></span>
                      </span>
                      <span onClick={row.onGhost} title="translucent" style={css(SLOT_22)}>
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
                    <div style={css(`padding:6px 8px;border-radius:4px;background:var(--float-bg-soft);font:400 11.5px ${SANS};color:var(--text-muted)`)}>
                      waiting for the model&hellip;
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── the proposal: a second, small tree below the parts ──

                WHAT THE READER HAS SAID, ALL OF IT, IN ONE PLACE. Every node of
                the document is a row here — the bodies they drew and the parts
                of the build they displaced, in the order the document holds them
                — and a selected row opens the numbers underneath itself. The
                kernel's verdict stands under the head of the branch; what ADDS a
                node is the `Add primitive` menu down in the toolbar.

                Below the parts, not above: selecting a row grows this branch by
                a block of fields, and above the parts that would push the whole
                parts tree down the screen. Nothing is under this branch, so
                nothing shifts.

                A BRANCH OF THE INTERFACE. It is built from `this.state.proposal`
                and is not part of `tree` at all — `computed()` says why a second
                scene root was not on the table, and why a MOVE could not be a
                scene row in any case. The bodies ARE in the scene, staged under
                the model's root exactly as before, and each row resolves through
                its staged path for the eye, the ghost square, the colour and the
                selection.

                NOT INSIDE `treeShown` OR `notCompare`, unlike the parts tree
                above it. The proposal is the reader's own claim about a motor or
                a wall, which is as true over a comparison as over a build — the
                `Add primitive` menu stays live under one for the same reason —
                and this branch is the only place the rows exist at all. */}
            <div style={css(v.proposalTreeStyle)}>
              <div style={css(v.proposalHeadStyle)}>
                <span onClick={v.proposalToggle} style={css(v.proposalCaretStyle)}>
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d={v.proposalCaretPath} /></svg>
                </span>
                {/* THE BRANCH'S OWN EYE AND ITS OWN TICK, in the order every
                    row below carries them: what is on the model, then what
                    travels to the agent. The eye takes the whole proposal off
                    the model and the tick holds all of it back from the text;
                    neither edits a body, and the rows keep answering for
                    themselves underneath both. */}
                {/* THE SAME BOX A ROW CARRIES ITS THREE MARKS IN, with the
                    last two stood over and not used: the head has an eye, no
                    ghost square and no colour of its own. Spending them here
                    is what puts the master tick under the tick of every row,
                    and the branch's name under the name of every BODY row — a
                    move puts its `move` badge in that column first.
                    `proposalMarksStyle` in proposalview.js has the rest. */}
                <span style={css(v.proposalMarksStyle)}>
                  <span onClick={v.proposalEyeClick} title="show / hide the whole proposal" style={css(SLOT_24)}>
                    <span style={css(v.proposalEyeOuter)}><span style={css(v.proposalEyeDot)} /></span>
                  </span>
                  <span style={css(v.proposalGhostStyle)} />
                  <span style={css(v.proposalDotStyle)} />
                </span>
                <span onClick={v.proposalSkipAll} title={v.proposalSkipTitle} style={css(SLOT_22)}>
                  <span style={css(v.proposalSkipIcon)} />
                </span>
                <span onClick={v.proposalToggle} style={css(v.proposalHeadNameStyle)}>{v.proposalHeadName}</span>
                <span style={css(v.proposalCountStyle)}>{v.proposalCount}</span>
                {/* THE HEADER'S OWN `×`, drawn exactly as a row's is: same
                    glyph, same faint ink, one level up. A row's takes one node
                    back out of a document being edited; this one takes the
                    whole document, and the hub's copy of it, which is why it
                    is the only control on this page that asks first. */}
                <span onClick={v.proposalRemove} title={v.proposalRemoveTitle} style={css(FAINT_CLICK)}>&#10005;</span>
              </div>
              {/* WHAT THE KERNEL MAKES OF THE DOCUMENT AS IT STANDS
                  (`proposalSays` in `computed`). Under the head and outside
                  the rows, so it is there whether or not the caret has folded
                  the branch away: while it is there the body over the model is
                  the last one that BUILT rather than nothing at all — see
                  `setProposal` — so this line is the only thing on the page
                  that says why a body has stopped following the numbers. */}
              <div style={css(v.proposalSaysStyle)}>{v.proposalSays}</div>
              {v.proposalRows.map((row) => (
                <div key={row.key} style={css('display:flex;flex-direction:column;align-items:flex-start')}>
                  {/* `onContextMenu` is null on a move and on a body the scene
                      cannot place, which leaves the browser's own menu where
                      this page has nothing to put — see the row. */}
                  <div onContextMenu={row.onMenu} style={css(row.rowStyle)}>
                    {/* The eye, the ghost square and the colour, in one box
                        that keeps the three columns' width whether or not
                        anything is drawn in them — so the names of the two
                        kinds of row stand in one line.
                        A MOVE KEEPS ITS EYE AND NOT THE OTHER TWO, which is
                        why the box is not hidden as one unit: the eye on
                        such a row is a switch of this page's own (`onVis`
                        reaches `toggleMoveEye`), while the square and the
                        colour are the SCENE's and belong to the part's own
                        row in the tree below. `ghostStyle` takes the square
                        off; the colour comes off by itself, since a move has
                        no row in the scene to take one from. */}
                    <span style={css(row.marksStyle)}>
                      <span onClick={row.onVis} title="show / hide" style={css(SLOT_24)}>
                        <span style={css(row.eyeOuter)}><span style={css(row.eyeDot)} /></span>
                      </span>
                      <span onClick={row.onGhost} title="translucent" style={css(row.ghostStyle)}>
                        <span style={css(row.ghostIcon)} />
                      </span>
                      <span style={css(row.dotStyle)} />
                    </span>
                    {/* OUTSIDE THAT BOX, which is the whole reason it is not
                        in it: the box goes `visibility:hidden` on a row with
                        nothing in the scene — a body the tree cannot place,
                        and every row at all while a comparison is up — while
                        being held back from the agent is a statement such a
                        row can still make. A MOVE row's box stays visible to
                        carry the eye; the ghost square inside it is what
                        goes. */}
                    <span onClick={row.onSkip} title={row.skipTitle} style={css(SLOT_22)}>
                      <span style={css(row.skipIcon)} />
                    </span>
                    {/* `move`, on the rows that are one, before the name and
                        in the same muted mono the count is drawn in. Nothing
                        else on the row says a displacement of a part the build
                        already has apart from a body somebody drew. */}
                    {row.kind && (
                      <span style={css(row.kindStyle)}>{row.kind}</span>
                    )}
                    <span onClick={row.onSelect} style={css(row.nameStyle)}>{row.name}</span>
                    <span onClick={row.onRemove} title={row.removeTitle} style={css(FAINT_CLICK)}>&#10005;</span>
                  </div>
                  <div style={css(row.fieldsStyle)}>
                    {/* A BODY'S HEAD LINE, absent on a move: the name it is
                        drawn under, the op it was built from, and the switch
                        between the two roles — `result = union(solid) −
                        union(hole)`, with a hole drawn as its own translucent
                        part so the reader can see what they asked to remove. */}
                    {row.nameField && (
                      <div style={css('display:flex;align-items:center;gap:6px')}>
                        {/* `onKeyDown` on every field of this block: the value
                            is committed on `change` — a blur, an Enter, or a
                            nudge of the arrows — and not on the keystroke, so
                            a field with only the blur wired would ignore the
                            reader who types a number and presses return. */}
                        <input type={row.nameField.type} value={row.nameField.value}
                               onChange={row.nameField.onChange} onBlur={row.nameField.onBlur}
                               onKeyDown={row.nameField.onKeyDown} style={css(row.nameField.style)} />
                        <span style={css(SPAN_MONO)}>{row.op}</span>
                        <span onClick={row.onRole} title="solid adds material, hole takes it away" style={css(row.roleStyle)}>{row.role}</span>
                      </div>
                    )}
                    {row.groups.map((g) => (
                      <div key={g.key} style={css('display:flex;align-items:center;gap:5px;margin-top:5px')}>
                        <span style={css(`width:50px;flex:none;font:400 9.5px ${MONO};color:var(--text-muted)`)}>{g.label}</span>
                        {/* `type` AND `step` COME OFF THE FIELD, so a number
                            gets the browser's own arrows and a name — which is
                            no kind of number — does not. `ref` is how a nudge
                            of those arrows reaches the document; `field` in
                            `computed()` says why React leaves it no other way,
                            and what `onWheel` is for.
                            `placeholder` AND `min` ARE THE SNAP STEP'S ALONE
                            and are undefined on every other field, which React
                            draws as the attribute being absent: an empty step
                            field is the automatic one and has to say so, and no
                            number of millimetres below zero means anything. */}
                        {g.fields.map((f) => (
                          <input key={f.key} type={f.type} step={f.step} ref={f.ref}
                                 min={f.min} placeholder={f.placeholder}
                                 value={f.value} onChange={f.onChange} onBlur={f.onBlur}
                                 onKeyDown={f.onKeyDown} onWheel={f.onWheel} style={css(f.style)} />
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* ── comparing two revisions ── */}
            {v.compare && (
              <div style={css('display:flex;flex-direction:column;min-height:0;width:288px;background:var(--float-bg);border:1px solid var(--line);border-radius:10px;box-shadow:0 6px 24px var(--shadow-soft);overflow:hidden')}>
                <div style={css('flex:none;padding:12px 14px;border-bottom:1px solid var(--line-soft)')}>
                  {/* THE TWO CHIPS ARE THE ONLY THINGS HERE THAT MAY SHRINK, and
                      they have to be told so twice — `min-width:0` to let a flex
                      item go under its own content, and the ellipsis to say what
                      happens then. They hold a revision identifier: seven
                      characters for a commit, up to sixty-four for a pointer or
                      a build name. Without this a name of ordinary length pushed
                      `exit` past the panel's edge, where `overflow:hidden` cut it
                      off, and broke the cross onto a line of its own. The full
                      name stays reachable in the tooltip. */}
                  <div style={css(ROW)}>
                    <span style={css(`font:600 12.5px ${SANS};flex:none`)}>Comparing</span>
                    <span title={v.cmpA} style={css(KEY_MONO)}>{v.cmpA}</span>
                    <span style={css('color:var(--text-muted);flex:none')}>&#8594;</span>
                    <span title={v.cmpB} style={css(KEY_MONO)}>{v.cmpB}</span>
                    <span style={css(FILL)} />
                    <span onClick={v.exitCompare} style={css(`font:500 11px ${MONO};color:var(--accent-text);cursor:pointer;flex:none;white-space:nowrap`)}>exit &#10005;</span>
                  </div>
                  {/* Three ways of looking at the SAME scene: each one hides a
                      group of it, so none of the three costs a fetch. */}
                  <div style={css('display:flex;gap:2px;padding:3px;background:var(--chip-bg);border-radius:7px;margin-top:10px')}>
                    <div onClick={v.showBoth} style={css(v.dsBothStyle)}>
                      <span style={css(v.dsNameStyle)}>Overlay</span>
                    </div>
                    <div onClick={v.showA} title={v.cmpA} style={css(v.dsAStyle)}>
                      <span style={css(v.dsNameStyle)}>{v.cmpA}</span>
                      <span style={css(v.dsWordStyle)}>only</span>
                    </div>
                    <div onClick={v.showB} title={v.cmpB} style={css(v.dsBStyle)}>
                      <span style={css(v.dsNameStyle)}>{v.cmpB}</span>
                      <span style={css(v.dsWordStyle)}>only</span>
                    </div>
                  </div>
                </div>
                <div style={css('flex:1;overflow:auto;padding:12px 14px')}>
                  {/* Waiting, refused or failed — a sentence and not an empty
                      list, which would read as "nothing changed" and is itself
                      one of the answers this block has to be able to give. */}
                  <div style={css(v.cmpNoteStyle)}>
                    <div style={css(`font:600 11.5px ${SANS};margin-bottom:6px`)}>{v.cmpNoteHead}</div>
                    <div style={css(`font:400 11.5px/1.6 ${SANS};color:var(--text-soft)`)}>{v.cmpNote}</div>
                    <div onClick={v.retryCompare} style={css(v.cmpRetryStyle)}>Try again</div>
                  </div>
                  <div style={css(v.cmpSummaryStyle)}>{v.cmpSummary}</div>
                  {/* One row per part the report names, what happened to it, and
                      how much material moved. Clicking one lights that part up
                      in every group of the scene that draws it. */}
                  {v.cmpRows.map((row) => (
                    <div key={row.key} onClick={row.onSelect} style={css(row.rowStyle)}>
                      <div style={css('display:flex;align-items:center;gap:7px')}>
                        <span style={css(row.nameStyle)}>{row.name}</span>
                        <span style={css(row.statusStyle)}>{row.status}</span>
                        <span style={css(row.volumeStyle)}>{row.volume}</span>
                      </div>
                      {/* Only a part the kernel REFUSED carries one, and for
                          that part this sentence is the whole answer — see
                          `rowReason` in `computed`. The other silence is
                          explained once, in the legend below. */}
                      <div style={css(row.reasonStyle)}>{row.reason}</div>
                    </div>
                  ))}
                </div>
                <div style={css('flex:none;margin:0 14px 14px;padding:10px 12px;background:var(--card-bg);border:1px solid var(--line-soft);border-radius:7px')}>
                  <div style={css(`font:600 10px ${MONO};color:var(--text-muted);letter-spacing:.08em;margin-bottom:7px`)}>LEGEND &mdash; WHAT THE COLOURS AND WORDS MEAN</div>
                  {/* THE SWATCHES ARE THE PAYLOAD'S OWN COLOURS and not palette
                      roles — see `legendAddedStyle` in `computed`. A legend is
                      mandatory here rather than decorative: there is no industry
                      convention for added and removed (green is added in GitHub
                      and NX, red is added in CATIA, and in metrology red means
                      extra material), so the colours have to be labelled, and
                      the pair has to stay legible to a colourblind reader —
                      which is what the words beside them are for. */}
                  <div style={css(ROW_LABELLED)}><span style={css(v.legendAddedStyle)} /><span style={css(LABEL_SANS)}>added &mdash; material only in {v.cmpB}</span></div>
                  <div style={css(ROW_LABELLED)}><span style={css(v.legendRemovedStyle)} /><span style={css(LABEL_SANS)}>removed &mdash; material only in {v.cmpA}</span></div>
                  {/* The colour's meaning, not a claim about the tab: A-only
                      and B-only show one revision, ghosted in this same
                      colour. */}
                  <div style={css(ROW)}><span style={css(v.legendNeutralStyle)} /><span style={css(LABEL_SANS)}>unchanged &mdash; ghosted</span></div>
                  {/* An explanation true of a category, not a part, so it is
                      said once here instead of on every `not compared` row (the
                      hub still writes it on each row; the panel spends the
                      height once). It matches the hub's sentence and order —
                      definition first, hardware and mocks as the example
                      (`cadbuild/comparescene._uncovered_line`).
                      ALWAYS DRAWN, not only when such a row is on screen: the
                      legend is part of the panel rather than of the list, so
                      there is no arrangement in which a row can appear without
                      it. `not measured` is deliberately NOT here — that sentence
                      is about one part and what went wrong with it, and it stays
                      on that part's row. */}
                  <div style={css('display:flex;align-items:center;gap:8px;margin-top:7px;padding-top:7px;border-top:1px solid var(--line-soft)')}><span style={css(v.legendNotComparedStyle)}>{v.legendNotCompared}</span><span style={css(LABEL_SANS)}>{v.legendNotComparedWhy}</span></div>
                </div>
              </div>
            )}
          </div>

          {/* ── the model, and everything laid over it ── */}
          <div style={css('flex:1;position:relative;min-width:0;background:linear-gradient(165deg,var(--header-bg) 0%,var(--sunken-bg) 60%,var(--page-bg) 100%)')}>
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

            {/* A document chosen in the view list, laid OVER the model rather
                in place of it: the viewport stays mounted underneath, camera,
                cut and hidden parts and all. Drawn by the component the
                documents page uses (DocumentView.jsx). */}
            {v.docOpen && (
              <div style={css(v.docLayerStyle)}>
                <DocumentView key={v.docKey} doc={v.docOpen} documents={this.state.meta.documents}
                              base={PAGE.base} onOpen={v.onDocOpen}
                              onTools={(tools) => this.setState({ docTools: tools })}
                              onReady={() => this.docReady()} />
              </div>
            )}

            {/* views and tools. THE LAYER IS A VALUE rather than a constant
                here — see `toolbarStyle`: the view menu opens INSIDE this
                toolbar, so it is the toolbar that has to rise above the
                overlays sharing the model with it. */}
            <div style={css(v.toolbarStyle)}>
              {/* the bar, the one both pages draw (`toolBar` in viewlist.jsx),
                  with the two cards only this page's buttons open */}
              {toolBar(v, {
                // THE OPS THE DOCUMENT KNOWS, one row each, read off the same
                // table that gives each of them its size fields (`proposalOps`
                // in ui/src/proposalview.js). The click is stopped on the card
                // so that pressing inside it does not reach `rootClick` and
                // shut it under the press.
                proposal: (
                  <div onClick={(e) => e.stopPropagation()} style={css(v.proposalMenuStyle)}>
                    {v.proposalOps.map((op) => (
                      <div key={op.key} onClick={op.onClick} style={css(v.proposalOpStyle)}>{op.label}</div>
                    ))}
                  </div>
                ),
                // The `Add primitive` card's pattern, stopped click included —
                // see `settingsMenuStyle` for why this one hangs off the right
                // edge instead.
                settings: (
                  <div onClick={(e) => e.stopPropagation()} style={css(v.settingsMenuStyle)}>
                    <div onClick={v.toggleRetina} style={css(v.settingsRowStyle)}>
                      <span style={css(v.retinaBox)}>{v.retinaMark}</span>
                      <span>Retina resolution</span>
                    </div>
                  </div>
                ),
              })}
            </div>

            {/* a newer build landed — offered, not substituted */}
            <div style={css(v.bannerLayerStyle)}>
              <div style={css(v.bannerStyle)}>
                <span style={css('width:8px;height:8px;border-radius:4px;background:var(--ok);flex:none')} />
                <span style={css(`font:500 12.5px ${SANS}`)}>
                  Build <b style={{ fontFamily: MONO }}>{v.bannerId}</b> is ready &mdash; you are viewing {v.slot}
                </span>
                <span onClick={v.bannerSwitch} style={css(v.bannerSwitchStyle)}>Switch</span>
                <span onClick={v.bannerLater} style={css(`padding:5px 10px;color:var(--text-soft);border-radius:5px;font:500 12px ${SANS};cursor:pointer`)}>Later</span>
              </div>
            </div>

            {/* state chips: a live measurement */}
            <div style={css(v.chipsStyle)}>
              <div style={css(v.measChipStyle)}>
                <span style={css(HEAD_MONO)}>{v.measText}</span>
                {/* The qualifier the brief insists on: a distance taken between
                    parts that have been laid apart is not the assembled one. */}
                {v.measNote && <span style={css(`font:500 10.5px ${MONO};color:var(--warn);background:var(--warn-bg);padding:3px 7px;border-radius:4px`)}>{v.measNote}</span>}
                <span onClick={v.measAdd} style={css(v.measAddStyle)}>add to comment</span>
                <span onClick={v.measClear} style={css(DIM_CLICK)}>&#10005;</span>
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
              <div style={css(`display:flex;align-items:center;gap:6px;font:600 10px ${MONO};color:var(--warn);letter-spacing:.06em`)}>
                NOTE &middot; {v.noteName}
                <span style={css(FILL)} />
                <span onClick={v.editNote} style={css(v.editNoteStyle)}>{v.editNoteLabel}</span>
              </div>
              {/* `--warn-soft` AND NOT `--warn`, on both of these: the box has
                  a heading above them (`NOTE · <key>`) and these two label the
                  halves under it. Drawn in the same amber as the heading they
                  stop being labels and become three headings, which is the one
                  thing this box is FOR — a reader who cannot tell the author's
                  specification from their own reminder is the failure it was
                  built to prevent. */}
              <div style={css(v.authorNoteStyle)}>
                <div style={css(WARN_CAPS)}>FROM THE MODEL</div>
                <div style={css(WARN_BODY)}>{v.authorNote}</div>
              </div>
              <div style={css(v.readerNoteStyle)}>
                <div style={css(WARN_CAPS)}>ONLY IN THIS BROWSER</div>
                <div style={css(WARN_BODY)}>{v.noteText}</div>
              </div>
            </div>

            {/* the viewport could not draw this view — block 11. The button is
                the only way back: the viewport remembers a failed load so an
                ordinary click cannot re-fetch it, and nothing else on this page
                clears that memory. */}
            <div style={css(v.viewErrorStyle)}>
              <div style={css(`font:600 12.5px ${SANS};margin-bottom:5px`)}>This view did not render</div>
              <div style={css(`font:400 11.5px/1.6 ${MONO};color:var(--text-soft)`)}>{v.viewError}</div>
              <div onClick={v.retryView} style={css(`display:inline-block;margin-top:11px;padding:6px 14px;background:var(--accent);color:var(--text-on-accent);border-radius:6px;font:600 11.5px ${SANS};cursor:pointer`)}>Try again</div>
            </div>

            {/* The bottom-left corner is the viewport's: it draws the view cube
                there (ui/src/viewport/viewcube.js). */}

            <div style={css(`position:absolute;right:14px;bottom:12px;font:400 10.5px ${MONO};color:var(--text-muted);pointer-events:none`)}>{v.hintText}</div>

            {/* the composer: the frame rides along by itself, the photo does not */}
            <div onClick={(e) => e.stopPropagation()} style={css(v.composerStyle)}>
              <div style={css('display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line-soft)')}>
                <span style={css(`width:20px;height:20px;border-radius:10px 10px 10px 3px;background:var(--accent);color:var(--text-on-accent);display:flex;align-items:center;justify-content:center;font:600 10.5px ${MONO}`)}>{v.nextLabel}</span>
                <span style={css(`font:600 12px ${SANS}`)}>Task for the agent</span>
                {/* Only when there IS a part: the separator belongs to the name,
                    and a draft that lost its attachment to a revision swap would
                    otherwise show a lone middle dot. */}
                {v.composerPart
                  ? <span style={css(META_MONO)}>&middot; {v.composerPart}</span>
                  : null}
                <span style={css(FILL)} />
                <span onClick={v.compCancel} style={css(FAINT_CLICK)}>&#10005;</span>
              </div>
              <textarea
                ref={this.compBox}
                value={v.composerText}
                onChange={v.compType}
                onKeyDown={v.compKey}
                maxLength={MAX_COMMENT_CHARS}
                placeholder="e.g. gap here is 2.4 — make it 3"
                style={css(`width:100%;box-sizing:border-box;border:none;outline:none;resize:none;padding:10px 12px;font:400 12.5px/1.5 ${SANS};color:var(--text);height:64px;background:transparent`)}
              />
              <div style={css('display:flex;align-items:center;gap:6px;padding:0 12px 10px;flex-wrap:wrap')}>
                <span style={css(`display:flex;align-items:center;gap:5px;padding:4px 8px;background:var(--sunken-bg);border-radius:5px;font:400 10.5px ${MONO};color:var(--text-soft)`)}>
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1.5" y="4" width="13" height="9.5" rx="1.5" /><circle cx="8" cy="8.7" r="2.6" /></svg>
                  camera frame &mdash; attached automatically
                </span>
                <span style={css(v.compMeasChipStyle)}>&#8596; {v.compMeasText} <span onClick={v.compMeasRemove} style={css(DIM_CLICK)}>&#10005;</span></span>
                <label style={css(`padding:4px 8px;border:1px dashed var(--line-strong);border-radius:5px;font:400 10.5px ${MONO};color:var(--text-muted);cursor:pointer`)}>
                  {v.compPhotoName ? `photo: ${v.compPhotoName}` : '+ photo of the print'}
                  <input type="file" accept="image/jpeg,image/png,image/webp"
                         onChange={v.compPhoto} style={{ display: 'none' }} />
                </label>
                <span style={css(FILL)} />
                <span onClick={v.compSend} style={css(v.compSendStyle)}>{v.compSendLabel}</span>
              </div>
            </div>

            {/* the section plane */}
            <div onClick={(e) => e.stopPropagation()} style={css(v.secPopStyle)}>
              <div style={css('display:flex;align-items:center;gap:8px;margin-bottom:10px')}>
                <span style={css(HEAD_SANS)}>Section plane</span>
                <span style={css(FILL)} />
                <span onClick={v.closeSecPop} style={css(FAINT_CLICK)}>&#10005;</span>
              </div>
              <div onClick={v.pickFace} style={css(v.pickFaceStyle)}>{v.pickFaceText}</div>
              <div style={css(`display:flex;justify-content:space-between;font:500 11px ${MONO};color:var(--text-soft);margin:12px 0 5px`)}>
                <span>offset</span><span style={css(INK)}>{v.secOffLabel}</span>
              </div>
              {/* The range is the viewport's: it comes back on `hmr:face` from the
                  model's own extent, so a 400 mm part and a 4 mm one both get a
                  slider that spans them. */}
              <input type="range" min={v.secMin} max={v.secMax} step={v.secStep}
                     value={v.secOff} onChange={v.setSecOff} style={{ width: '100%' }} />
              <div style={css('display:flex;gap:6px;margin-top:10px')}>
                <div onClick={v.flipSec} style={css(HALF_BTN)}>flip side</div>
                <div onClick={v.resetSec} style={css(HALF_BTN)}>reset</div>
              </div>
              <div onClick={v.toggleHatch} style={css('display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:11px')}>
                <span style={css(v.hatchBox)}>{v.hatchMark}</span>
                <span style={css(`font:400 11.5px ${SANS};color:var(--text-soft)`)}>hatch the cut face</span>
              </div>
            </div>

            <div style={css(v.toastStyle)}>{v.toastText}</div>
          </div>

          {/* ── the comment rail ── */}
          <div style={css(v.railStyle)}>
            <div style={css('flex:none;display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line-soft)')}>
              <span style={css(HEAD_SANS)}>Comments</span>
              <span style={css(FILL)} />
              <span onClick={v.railToggle} style={css('color:var(--text-faint);cursor:pointer;font-size:14px')}>&#10005;</span>
            </div>
            {/* The whole project queue, so nothing here has to
                explain what it is not showing. Each row says where it hangs on
                the build in view instead — see `threads` in `computed`. */}
            <div style={css('flex:1;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:10px')}>
              {v.threads.map((c) => (
                <div key={c.key} onClick={c.onOpen} style={css(c.style)}>
                  <div style={css(ROW)}>
                    <span style={css(c.pinStyle)}>{c.label}</span>
                    <span style={css(`font:500 11.5px ${MONO};color:var(--text)`)}>{c.part}</span>
                    <span style={css(FILL)} />
                    <span style={css(`font:400 10.5px ${MONO};color:var(--text-muted)`)}>{c.time}</span>
                  </div>
                  <div style={css(`font:400 12px/1.5 ${SANS};color:var(--text);margin:7px 0 8px`)}>{c.text}</div>
                  <div style={css(c.saysStyle)}>{c.says}</div>
                  <div style={css('display:flex;align-items:center;gap:10px;margin-top:8px')}>
                    <span onClick={c.onResolve} style={css(`font:500 10.5px ${MONO};color:var(--text-muted);` + (c.resolved ? IDLE : 'cursor:pointer'))}>
                      {c.resolved ? 'processed' : 'mark processed'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── the tree row's context menu ── */}
          <div onClick={(e) => e.stopPropagation()} style={css(v.menuStyle)}>
            <div style={css(`padding:7px 14px 6px;font:600 10.5px ${MONO};color:var(--text-muted);border-bottom:1px solid var(--line-soft)`)}>{v.menuName}</div>
            {/* A row that carries a file holds a real ANCHOR, not a div with a
                handler: the download is the browser's to do, exactly as in the
                header's menu, so the link can be middle-clicked or saved as. Its
                file name shrinks to an ellipsis rather than run under Copy link,
                and the row is keyed by its address, so a Copy link that says
                "copied" never moves to the same format of another part. */}
            {v.menuItems.map((m) => {
              const inner = (
                <>
                  <span style={css(FILL)}>{m.label}</span>
                  <span style={css(m.href ? `${FAINT_MONO};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap` : FAINT_MONO)}>{m.hint}</span>
                </>
              );
              return m.href
                ? (
                  <div key={m.href} style={css(m.rowStyle)}>
                    <a href={m.href} download onClick={m.onClick} style={css(m.style)}>{inner}</a>
                    <CopyLink href={m.href} style={m.copyStyle} />
                  </div>
                )
                : <div key={m.key} onClick={m.onClick} style={css(m.style)}>{inner}</div>;
            })}
          </div>

          {/* ── the note editor: bound to a CATALOGUE KEY, for the project ── */}
          <div onClick={(e) => e.stopPropagation()} style={css(v.notePopStyle)}>
            <div style={css(`font:600 12px ${SANS};margin-bottom:2px`)}>
              Note &middot; <span style={css(`font:500 11.5px ${MONO};color:var(--text-soft)`)}>{v.notePopName}</span>
            </div>
            <textarea
              value={v.noteDraft}
              onChange={v.noteType}
              placeholder="e.g. thin wall here — do not touch"
              style={css(`width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:6px;outline:none;resize:none;padding:8px 10px;font:400 12px/1.5 ${SANS};height:64px;background:var(--card-bg)`)}
            />
            {/* This note stays in the browser and no route writes it back; the
                sentence also says where a note that must travel is written
                (the author's note, in model.py). */}
            <div style={css(`font:400 10.5px/1.5 ${MONO};color:var(--text-muted);margin-top:6px`)}>
              stays in this browser &mdash; nothing sends it to the hub. A note that
              travels with the build, for everyone who opens it, is written in model.py
            </div>
            <div style={css('display:flex;gap:8px;justify-content:flex-end;margin-top:8px')}>
              <span onClick={v.noteCancel} style={css(`padding:6px 12px;border-radius:6px;font:500 11.5px ${SANS};color:var(--text-soft);cursor:pointer`)}>Cancel</span>
              <span onClick={v.noteSave} style={css(ACCENT_BTN)}>Save</span>
            </div>
          </div>

        </div>

        {/* ── the Share window, over the whole page like the front page's
            delete confirmation. The overlay closes it; a click on the card
            stops at the card, so its own controls do not close it. ── */}
        {v.shareOpen && (
          <div onClick={v.closeShare}
               style={css('position:fixed;inset:0;z-index:40;padding:20px;box-sizing:border-box;'
                 + 'display:flex;align-items:center;justify-content:center;background:var(--shadow)')}>
            <div onClick={(e) => e.stopPropagation()}
                 style={css('width:380px;max-width:100%;box-sizing:border-box;'
                   + CARD
                   + 'box-shadow:0 14px 44px var(--shadow);padding:22px 22px 18px;'
                   + 'display:flex;flex-direction:column;gap:10px')}>
              <div style={css(`font:700 15px ${SANS}`)}>{v.shareHead}</div>
              <div onClick={v.toggleShareFiles} style={css(v.shareFilesRowStyle)}>
                <span style={css(v.shareFilesBox)}>{v.shareFilesMark}</span>
                Include files (STEP, STL, 3MF)
              </div>
              {v.shareFilesHint && (
                <div style={css(`font:400 11px/1.5 ${SANS};color:var(--text-muted)`)}>{v.shareFilesHint}</div>
              )}
              <div style={css(`padding:8px 10px;border-radius:6px;${SUNKEN};font:400 11.5px/1.5 ${MONO};color:var(--text);overflow-wrap:anywhere;user-select:all`)}>
                {v.shareLink}
              </div>
              <div style={css('display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:2px')}>
                <div onClick={v.closeShare}
                     style={css(DIALOG_BTN
                       + `cursor:pointer;user-select:none;font:600 12px ${SANS};`
                       + 'border:1px solid var(--line);background:var(--card-bg);color:var(--text)')}>
                  Close
                </div>
                <div onClick={v.copyShare}
                     style={css(DIALOG_BTN
                       + `cursor:pointer;user-select:none;font:600 12px ${SANS};`
                       + ON_ACCENT)}>
                  Copy
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
}
