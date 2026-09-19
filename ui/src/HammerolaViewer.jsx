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
 *   DIFF           -> two documents of the comparison's own, computed on
 *                     request: `scene.json`, which is an ORDINARY view payload
 *                     and goes to the viewport that is already on the page, and
 *                     `report.json`, which is the list of parts the panel draws.
 *                     Both are behind EDIT_TOKEN and neither exists until
 *                     somebody asks — see hub.js and `runCompare` below.
 *   notes          -> TWO different things that share one word, and the box on
 *                     the canvas labels them rather than stacking them. Both
 *                     hang on the CATALOGUE KEY (issue #75), which is the
 *                     part's identity rather than the label a view happens to
 *                     put on a row. The READER's is localStorage, per project,
 *                     and never leaves this browser — there is still no route
 *                     that writes it anywhere. The AUTHOR's is published
 *                     content: written in `model.py`, validated at build and
 *                     again at publish, and carried as `note` INSIDE the
 *                     build's own `meta.parts[key]`. It is shown to EVERYONE,
 *                     exactly like the part's name, and a part with nothing to
 *                     say carries no `note` key at all, which is the ordinary
 *                     case rather than an error.
 *   comments       -> the PROJECT's queue, read and written under the same
 *                     EDIT_TOKEN this page holds. `loadFeed` fetches it, the
 *                     rail draws all of it oldest first, and a build swap
 *                     neither refetches nor clears it: the queue belongs to the
 *                     project rather than to one revision (SPEC 7A.3). A comment
 *                     is bound to the PRINTED ENTITY, whose identity is its
 *                     catalogue key (issue #75) — so its pin travels between
 *                     revisions while the part is alive, and when the part
 *                     leaves the catalogue the row says the comment is orphaned
 *                     instead of quietly losing its pin. `hub.anchorFor` makes
 *                     that decision and `sync` draws its answer.
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
 * carrying the whole of what should be on screen; up, one per name in
 * `EVENTS_UP` — spelled there and not counted here, because a count written
 * here has already gone stale once. `sync()` below is the only place this file
 * writes to that event, exactly as in the mock.
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
  STATE, PICK, MENU, FACE, MEASURE, MOVED, PROPOSALMOVE, TURNED, PROPOSALTURN,
  PLACE, PIN, MODEL, ERROR, TOOL, VIEWPORT_TAG,
} from './events.js';
import {
  PAGE, ASSEMBLED_VIEW_ID, COMPARE_GROUPS, DIFF_COLOURS, JOB_DONE,
  JOB_FAILED, anchorFor, compareBase, isPointerPage, buildKey, countedName,
  compareView, indexTree, loadCompareReport, loadJob, loadMeta, loadBuilds,
  pageFrom, projectUrl, rereadPage, rowsByKey, shortId, stamp, startCompare, mb,
} from './hub.js';
// `readTheme`/`writeTheme` COME FROM HERE AND NOT FROM THE VIEWPORT, which is
// the last step of the move issue #35 made: the theme stopped being the colour
// of the canvas and became the whole interface's palette, so it is per-reader
// state like the token, the notes and the tabs rather than a viewport setting.
// `viewport/options.js` re-exported the pair for as long as this file asked it
// for them; it does not any more, and there is again exactly one module that
// reaches the cookie.
import {
  readToken, writeToken, clearToken, readNotes, writeNotes, rememberPointer,
  readTabs, rememberTab, forgetTab, readTheme, writeTheme,
} from './store.js';
// The two attachments a comment carries, made small enough to send. Imported
// only for `sendComment`: the frame grab itself (`frameBlob`) stays lossless,
// because `saveFrame` writes its answer to the reader's disk.
import {
  shrink, SHOT_MAX_SIDE, SHOT_QUALITY, PHOTO_MAX_SIDE, PHOTO_QUALITY,
} from './shrink.js';
// The proposal: a rough body the reader assembles out of numbers so the agent
// has something to design AGAINST or to copy — the motor the bracket has to
// clear, the wall it bolts to, or an example of the layout they want. Two
// modules, and the split is the same one the viewport draws: the document and
// its projection are pure text (`proposal.js`), the kernel that turns one into
// parts is next door (`proposalgeom.js`), and the COLOURS of those parts live
// over there with it. That is not an exemption from this file's no-literal rule
// — a part's colour is model content, like the colours the hub pushes in a view
// file, and this file paints no part.
import {
  addNode, bodies, dropMoves, emptyProposal, firstFree, isEmpty, moveNodes,
  moves, removeNode, proposalText, sendsNothing, turnNodes, updateNode,
} from './proposal.js';
import { buildProposal } from './proposalgeom.js';
import {
  css, FONTS, SANS, MONO, Mark, NARROW, PAGE_BG, PAGE_FG, HEADER_BG, HEADER_LINE,
} from './style.jsx';
// The one question this file's keydown handler cannot answer for itself: is the
// reader in a field. Imported rather than repeated because the rule is subtle —
// the library's tab strip and the Clip panel's checkboxes are `<input>` too, so
// "any input" is the wrong test — and a second copy would be free to drift.
import { typingTarget } from './viewport/holdkey.js';

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
  background: var(--page-bg);
}
.hmr_overlay {
  color: var(--text);
  font-family: ${FONTS['--hmr-sans']};
}
.hmr_pin {
  display: flex; align-items: center; justify-content: center;
  min-width: 20px; height: 20px; padding: 0 5px;
  transform: translate(-50%, -100%);
  border: none; border-radius: 10px 10px 10px 3px;
  background: var(--accent); color: var(--text-on-accent); cursor: pointer;
  font: 600 10.5px ${FONTS['--hmr-mono']};
  box-shadow: 0 2px 6px var(--shadow);
}
/* THE Z-INDEX IS WHAT MAKES A STACK OF PINS REACHABLE, and it is not decoration.
   Two comments left on the SAME part now resolve to the same anchor — one
   catalogue key, one bounding-box centre — so setPins places them at the same
   screen point, exactly overlapping, and only the last one appended can be
   clicked. Raising the active pin turns the rail into the way out: clicking
   either row lifts its own pin to the top, and the one underneath is a click
   away rather than lost. A screen-space fan-out was the other answer and buys
   nothing the rail does not already give.
   (No backticks in here either: this block is still the template literal.) */
.hmr_pin.is_active { background: var(--accent-strong); box-shadow: 0 0 0 3px var(--accent-ring); z-index: 1; }
/* THE LINE ROLE AND NOT THE CHIP FILL, which is a line painting a surface on
   purpose: this pin lies on the 3D MODEL rather than on any of our own
   surfaces, so its ground is a WHITE canvas in one theme and a mid-grey one in
   the other. Those two pull in opposite directions and no neutral fill is the
   better one on both. Against white this is dE 20.01 and the chip fill 9.12;
   against the dark canvas it is 6.06 and the chip fill 12.03. So the line role
   takes the decisive margin on the ground where a pale badge washes out, and
   the smaller of the two where both are far above the dE 2.5 a shape needs to
   read as a shape at all.
   An earlier version of this note said the chip fill "has no silhouette
   against either", which was the light measurement written as if it held in
   both: in dark it is the chip fill that has the wider margin. The rail draws
   the same badge ON the chip fill, because there it lies on a card and none of
   this arises.
   (No backticks in here: this block is a template literal.) */
.hmr_pin.is_resolved { background: var(--line-strong); color: var(--text-soft); }
.hmr_measure_label {
  padding: 3px 7px; border-radius: 4px;
  background: var(--tooltip-bg); color: var(--tooltip-text);
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

// How often the page asks whether the comparison it queued has finished, and how
// long it goes on asking.
//
// A comparison is two STEP reads and one boolean per part — about a second and a
// half on a real assembly (issue #10) — plus however long the build queue in
// front of it is. So the answer usually arrives on the second or third poll, and
// polling faster than that would only ask a hub that is busy computing. The
// ceiling is what stops a job the hub lost from leaving the panel saying
// "measuring" for the rest of the afternoon: three minutes is far longer than
// any pair takes and short enough that somebody is still at the screen to read
// what it says instead.
const COMPARE_POLL_MS = 1500;
const COMPARE_WAIT_MS = 180000;

/**
 * Which of the comparison scene's groups a tab takes off the screen.
 *
 * Overlay hides nothing — both revisions, ghosted, with the difference between
 * them bright on top.
 *
 * A SINGLE-REVISION TAB SHOWS ONE REVISION AND ITS OWN DIFFERENCE, which is what
 * makes it that revision at all: `A only` is revision A and the material that
 * was REMOVED from it, `B only` is revision B and the material that was ADDED to
 * it. The other revision's shell goes, and so does the difference that belongs
 * to the other revision — because the bright geometry is not a neutral overlay
 * sitting between the two. `added` is drawn where B stands and `removed` where A
 * stands (`cadbuild/comparescene`), and a part that exists in only ONE revision
 * is drawn WHOLE and opaque there. Keeping both groups in both tabs therefore
 * put a part that is not in A at all, at full size and in full colour, on the
 * tab claiming to be A — in front of A's own geometry, hiding it.
 *
 * IT WAS NEARLY INVISIBLE WHILE A DIFFERENCE WAS A SLIVER, which is why it stood
 * for a round: a fused shaving that is 0.4 mm thick reads as an annotation
 * wherever it sits. A whole part does not.
 *
 * A FUNCTION AND NOT A MAP, so `diffShow` — one field, three values, written in
 * three places — cannot reach a lookup that would answer `constructor` with
 * something off `Object.prototype`.
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
// Every edit made in the panel comes through `setProposal`, and a drag of a body
// is a run of them — so a save per edit would be a request per frame of a
// gesture. Long enough that a sentence being typed into a field is one write at
// the end of it, short enough that a reader who says something and closes the
// tab has already been saved. `saveProposal` says what the guards around it are
// for, and who calls it.
const PROPOSAL_SAVE_MS = 800;

// -- whether this hub serves the proposal panel at all ------------------------
//
// THE HUB'S ANSWER, STAMPED ON `<html>` BEFORE THE PAGE IS SENT, the way the
// theme is (`src/render.py`). The panel is part of the toolbar this file draws,
// so the answer has to be here before a button is drawn — and it is the hub's
// own configuration, which nothing in a browser can see. `PROPOSAL_PANEL` in the
// hub's environment is where it comes from; `off` is what a hub that never set
// it says, so a deployment that did not ask for the feature never carries it.
//
// SPELLED HERE AS WELL AS IN src/render.py because the two sides cannot share a
// module; `tests/test_ui_source.py` holds the name and the values equal across
// them, the way it already does for the theme cookie.
const PROPOSAL_ATTRIBUTE = 'data-proposal-panel';
const PROPOSAL_ON = 'on';

/**
 * Read where the button is drawn, and watched by nothing.
 *
 * NO OBSERVER, and that is the whole difference from the theme: this cannot
 * change while the page is open — it is one setting of the hub, fixed before the
 * document was sent — so there is nothing to notice. What that leaves is a
 * single attribute lookup on the root element, which is cheap enough to do where
 * the answer is spent rather than cached into state somebody could then write.
 *
 * ANYTHING BUT `on` IS OFF, a missing attribute included. A page carrying an
 * answer nobody recognises is a page whose hub did not ask for this, which is
 * the one reading that keeps the default safe.
 */
const proposalPanelOn = () => (
  document.documentElement.getAttribute(PROPOSAL_ATTRIBUTE) === PROPOSAL_ON
);

// WHAT THE PROPOSAL'S BRANCH IS EXPANDED AND COLLAPSED UNDER, in the same
// `expanded` map the parts tree keys by node id. It cannot collide with one of
// those: every id `indexTree` mints is a PATH and begins with `/`, while this is
// a bare word. Read as OPEN unless the map says `false`, because the branch is
// drawn only when the reader has put something in the document — a row that
// arrives already folded away is a row they have to go and find.
export const PROPOSAL_BRANCH = 'proposal';

// WHAT THE SECTION'S ROW PUTS IN `s.menu.id` when it is right-clicked, so that
// the row reaches the SAME menu the parts tree's rows reach instead of growing
// one of its own. It cannot collide with a row of that tree for the reason the
// constant above cannot either: every id `indexTree` mints is a PATH and begins
// with `/`, while this is a bare word — so `this.node()` answers `null` for it,
// and both branches that build the menu ask `secMenu` before they read `mNode`.
// (The lookup itself runs first and is simply asked a question it cannot answer;
// what keeps the two apart is the order of the BRANCHES, not of the reads.) The
// word is the row's own label, which is what the menu is then headed with.
export const SECTION_ROW = 'section';

/**
 * The selection, moved from a body's DOCUMENT ID onto the path the scene has
 * just given it — or nothing to move.
 *
 * `selectionAfter` THE OTHER WAY ROUND, and the same defect seen from the other
 * side. A body's row in the proposal's branch is selected by its path in the
 * SCENE where it has one and by its own node id where it has not, because a row
 * that cannot be opened is a dead end: the fields are how a document the kernel
 * refused gets repaired. So the row's identity CHANGES the moment the body is
 * staged, and without this the change lands under the reader — `s.sel` matches
 * neither spelling, the row deselects itself and the block being typed in shuts.
 *
 * IT IS REACHABLE TWICE OVER. The ordinary way is the staging window: the branch
 * draws from `state.proposal` at once while `show()` waits on the library, so
 * every body row is sceneless for a moment after `+ box` and after each opening
 * of the panel. The deterministic way is a document the kernel refused — a new
 * body that never reached the overlay, its row selected and being typed in, and
 * then the document repaired by something that does not touch `sel`, such as the
 * `×` on the body that broke it. The staging that follows would close the block
 * the reader is working in.
 *
 * MOVED RATHER THAN MERELY ACCEPTED ALONGSIDE, which was the other way to answer
 * this. `sel` is the page's ONE selection and half a dozen things read it as a
 * path: `selectedPaths()` hands it to the viewport, `selectedKey()` looks up a
 * catalogue record, `measAdd` posts it as the `partId` of a comment. A node id
 * left standing there once the body HAS a path would be a foreign value in a
 * field all of them read as a path — the scene would highlight nothing, and `add
 * to comment` would file a task against `n5`. Carrying it over keeps `sel`
 * meaning one thing the moment there is one thing for it to mean.
 *
 * THE TREE IS CHECKED AND NOT ASSUMED. A refused document leaves the LAST GOOD
 * overlay standing, so the group is there while this particular body is not;
 * moving the selection onto a path the tree does not hold would break the row
 * all over again, from the other end.
 *
 * AND NOT WHILE A COMPARISON IS UP, whatever the tree holds. `staged()` lays the
 * overlay into whatever payload is current (viewport/element.js), so under a
 * comparison the group really is there — at a path of the comparison's — and
 * `overlayRoot` finds it exactly as it finds the build's. Carried onto, `sel`
 * would hold a path naming a part no revision has, and it would go on holding it
 * after the comparison closed, since `leaveCompare` does not clear `sel` the way
 * `leaveBuild` does. `measAdd` then posts it: `proposalBody` cannot recognise it
 * once the build's scene is back, and the shape test lets it by because it does
 * begin with `/`. Two ordinary roads reach this — editing any field with a
 * comparison up re-stages, and the model event that comes back carries the
 * comparison's tree; and so does switching view tabs while comparing.
 *
 * THE QUESTION IS `compared` AND NOT THE SHAPE OF THE TREE, and it is the same
 * decision `proposalRows` makes on `path`, for the same reason: what settles it
 * is whether the scene on screen is this build's, not whether a path happens to
 * be spelled one way. The branch is drawn over a comparison deliberately, so
 * both ends of it have to ask.
 *
 * A MODULE FUNCTION AND NOT A METHOD, so that the state updater it is spread
 * into stays a pure function of what it is handed — `overlay` and `compared` are
 * resolved outside it, where the element and the methods may be read.
 */
function stagedSelection(overlay, tree, s, compared) {
  if (compared || !overlay || !s.sel || !s.proposal) return null;
  const node = bodies(s.proposal).find((body) => body.id === s.sel);
  if (!node) return null;
  const path = `${overlay}/${node.name}`;
  return tree.nodes.has(path) ? { sel: path, selName: node.name } : null;
}

// HOW MANY VIEWS STILL FIT AS A STRIP OF PILLS before the switcher becomes a
// menu. The strip is a centred flex row that does NOT wrap, inside a root that
// is `overflow:hidden` — so a row too wide for the window is neither scrollable
// nor shrunk to fit: it PUSHES THE FLOATING TOOLBAR PAST BOTH EDGES, where the
// root clips its ends away, taking Fit and the tools with it, and the names
// inside the pills break onto three lines each. A model declaring nine views with sentences for names is
// what this was measured against; four pills plus the tools is about what a
// laptop still holds on one line.
export const VIEW_TABS_MAX = 4;

// How many steps Ctrl+Z can walk back through, of either kind. A cap rather
// than no cap because this page is opened and left open — a reader working a
// tree all afternoon would otherwise grow `this.history` for the whole session
// with nothing ever taking anything off it. The OLDEST goes when it overflows:
// fifty steps back is already further than anybody reconstructs by pressing a
// key, and losing the newest instead would break the one step the reader is
// actually about to take back.
//
// AN ENTRY IS CHEAP WHICHEVER KIND IT IS. A visibility step is two id lists; a
// document step is a REFERENCE to a document that already existed, because every
// helper in proposal.js returns a new document and mutates nothing — so what the
// cap rations is the walk back rather than the bytes.
export const UNDO_DEPTH = 50;

// WHAT A STEP IS ABOUT, which is the field `undoStep` dispatches on.
//
// TWO KINDS ON ONE STACK and not a stack each, because the chord means "the last
// thing I did" and the reader does not sort their own gestures into categories:
// hide a part, drag another, press Ctrl+Z and what must come back is the drag.
// Stacks per kind would answer that with the hide — taking back a gesture the
// reader can no longer see, while the one they are looking at stays put.
const UNDO_VISIBILITY = 'visibility';
const UNDO_DOCUMENT = 'document';

// WHAT A WRITE OF THE DOCUMENT DOES TO THE DOCUMENT STEPS BEHIND IT — the
// argument `setProposal` takes, so that the caller SAYS which of the two it
// means rather than a flag somewhere else deciding for it.
//
// A DOCUMENT STEP HOLDS THE WHOLE DOCUMENT, and that is what parts it from a
// visibility one. `setVisibility` is the ONE door to the two lists it snapshots,
// so a step of that kind describes state nothing else can have moved. The
// document's door is `setProposal` and only TWO of the things that come through
// it record a step — the two gestures. A body drawn, a digit committed, a node
// deleted, a role flipped, a nudge, a tick, an adoption, a delete: every one of
// those is a write nothing on the stack knows about. Left standing behind one,
// a step goes on claiming to be "the last thing you did" while describing a
// document from before an edit it has never heard of — and pressing the chord
// then takes that edit away too, and posts the older document over the newer one
// at the next save. There is no redo to get it back.
//
// SO AN UNRECORDED WRITE INVALIDATES THEM, which is what `DROP_STEPS` means and
// why it is the default: the chord can then never reach past an edit it does not
// know about. `KEEP_STEPS` is for the two callers that have already accounted
// for the stack — `undoStep`, which is spending a step it has just popped, and
// `editBody`, which has just pushed its own. There is no third thing to mean,
// and anything that is not `KEEP_STEPS` is read as a drop, which is the safe
// direction for a mistake to fall in.
//
// THE VISIBILITY STEPS ARE LEFT WHOLE either way. They are about other state
// entirely, and a document written under them makes nothing they claim untrue.
//
// AND A WRITE THAT HANDS THE SAME DOCUMENT BACK IS NOT AN EDIT, so it
// invalidates nothing. `toggleProposal` is the caller that does it: opening the
// sheet re-stages by pushing `state.proposal` through the door untouched. Drop
// the steps for that too and a reader who drags a part and then merely OPENS the
// panel has lost the chord over the drag, with nothing on screen saying why.
// Identity is the whole of the test and not a cheap stand-in for one: every edit
// on this page BUILDS its document — `addNode`, `removeNode`, `updateNode`,
// `commit`, `emptyProposal`, a spread — so the object can be the one already on
// screen only when nobody edited anything. It is also the direction that is safe
// to be wrong in: a `this.state` read behind a batched update answers with an
// OLDER object, which a freshly built document is never identical to, so this
// can report "unchanged" only when the document really is.
const DROP_STEPS = 'drop';
const KEEP_STEPS = 'keep';

/**
 * One entry of `meta.parts`, or `null` — the ONLY way this page reads the
 * catalogue.
 *
 * THE KEY IS THE IDENTITY (issue #75) and it comes out of a pushed document, so
 * it is a string somebody else chose: a part may be called `constructor` or
 * `__proto__`, which `render._check_part_name` does not object to. A bare
 * `parts[key]` on a map that came back from `JSON.parse` answers those with a
 * FUNCTION off `Object.prototype`, and the reads below then slice it, spread it
 * or hand it to React — the same trap `noteFor` documents further down, on the
 * reader's note map, which is keyed by this same catalogue key (issue #75).
 *
 * A NON-OBJECT RECORD IS NO RECORD. The hub refuses one, but this side reads a
 * fetched document rather than a promise about it, and a `"lid": 3` would
 * otherwise reach `record.files` and read `undefined` off a number.
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
 * `files` IS THE WHOLE ANSWER AND NOTHING IS DERIVED FROM A NAME. The hub
 * publishes `{extension: filename}` per part (`_catalogue` in src/render.py),
 * which is what this page used to reconstruct by cutting a filename at its last
 * dot and treating the stem as the part — a reconstruction that was wrong for
 * any part with a dot in its name and that the catalogue exists to make
 * unnecessary.
 *
 * ONLY `files`, AND `preview` IS NEXT DOOR ON PURPOSE. A record may carry the
 * part's own render; a picture is looked at rather than saved, and it is
 * declared so `hammerola artifacts` can fetch it. Reading one field and not its
 * neighbour is what keeps that true now that the two sit in the same object.
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

/**
 * `meta.parts` as ordered groups of one FORMAT each, rows ordered by part.
 *
 * Flat, this menu is one row per file — thirty of them on a ten-part build, in
 * the order the hub happened to write them, so picking out every STL means
 * aiming at every third row. Grouped, the same thirty rows are three groups a
 * reader can take whole.
 *
 * THE ROW'S NAME IS THE CATALOGUE KEY, full stop. It used to be the hub's
 * download LABEL with the format stripped off the end of it, and that strip
 * existed only because the label degenerated to a bare `stl` on a one-part
 * build; there is no label any more and nothing to guess at — the key IS the
 * part's name, on a build with one printable exactly as on a build with thirty.
 *
 * THE CATALOGUE AND NOTHING ELSE, which is what keeps the whole-build meshes
 * out of this menu now that they have moved next to the views. `overview` and
 * `preview` on a VIEW — `assembled.stl`, `print.stl` and their pictures — are
 * declared for a client to FETCH, and a button is a different offer.
 * `print.stl` is the one where drawing it would be actively wrong: the plate is
 * whatever the `print` view holds, nothing requires that to be printable parts
 * only, and a button on a public page invites somebody to slice a plate with a
 * mock of a purchased bearing on it. `assembled.stl` has been served for this
 * hub's whole life with no button and nobody has asked for one — the assembly
 * is on screen in 3D, which is the better answer to the question a button would
 * be for.
 *
 * A Map because the group key is an extension out of a pushed document, so
 * `__proto__` is reachable and an object literal would silently store nothing
 * under it.
 */
export function groupDownloads(parts) {
  const groups = new Map();
  Object.entries((parts && typeof parts === 'object') ? parts : {})
    .forEach(([key, record]) => {
      fileList(record).forEach(({ ext, file }) => {
        const group = ext.toUpperCase();
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push({ label: key, file });
      });
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
 * `views[].parts` IS A LIST OF CATALOGUE KEYS. It used to be a count, and the
 * change is the whole of issue #75 in one field: a view now NAMES what it
 * shows, so the tab strip and the subtitle can say what is in a tab without
 * fetching the two megabytes of geometry to find out, and the hub holds that
 * list against the view file itself (`_match_selection` in src/render.py). A
 * non-list is nothing rather than `NaN`: this is a fetched document, and
 * `undefined.length` would take the header down.
 *
 * IT COUNTS DISTINCT PARTS. Five copies of one pin name `pin` once, so a plate
 * of a lid and five pins reads "2 parts" — which is what a catalogue key means.
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
 * One entry of the READER's note map — the only way a map keyed by a part's
 * identity may be read.
 *
 * The map is not an object this code built: it comes back out of `JSON.parse`
 * on localStorage and inherits from `Object.prototype`. A part is allowed to be
 * called `constructor` or `toString` — the hub's own path alphabet says so, and
 * `render._check_part_name` lets a CATALOGUE KEY be either — and a bare
 * `map[key]` on such an object answers with a FUNCTION off the prototype. React
 * refuses to render a function as a child and takes the page down over a part
 * name; the row menu's hint gets there sooner, slicing what it thinks is a
 * string. `hasOwnProperty.call` is what asks about the map itself rather than
 * about everything it inherits.
 *
 * ONE HELPER FOR BOTH READS, and that is the point of it being a function at
 * all. The guard used to be spelled out at the newest read and nowhere else,
 * which is a rule that holds exactly as long as whoever adds the next one
 * happens to have seen the last. The AUTHOR's note used to be a third read of
 * an identically-shaped map; it now lives inside the catalogue record and is
 * reached through `partRecord`, which makes the same argument for the same
 * reason.
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
 * THE PAIR TO `noteFor`, and it exists because the READ was guarded and the
 * WRITE was not. `notes[key] = text` on a plain object is an ASSIGNMENT, and
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
 * map is not built here at all — it comes back through `JSON.parse` on
 * localStorage and inherits from `Object.prototype` whatever this function does
 * — which is why `noteFor` guards the read regardless, and why the fix belongs
 * at the one write rather than in the shape of the object.
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
 * A VERDICT AND NOT AN ABSENCE OF ONE, which is the whole reason it is written
 * down here rather than folded into the two words either side of it.
 * `shapediff.check` refuses a measurement exactly where the kernel may have
 * lied, so this is the acceptance gate having done its job — and the reader is
 * the only place left to put the answer, because nothing bright is drawn for
 * such a part and the scene therefore looks like a part nobody touched.
 *
 * ONE SPELLING, IN ONE PLACE. The reader meets the two halves side by side — the
 * job log and this panel, over the same pair of revisions — so the word here is
 * the printed report's word, and a constant is what keeps the three readers of
 * it below from drifting apart.
 */
const NOT_MEASURED = 'not measured';

/**
 * The verdict for a part no pair of STEP files came from, spelled as the hub
 * spells it (`cadbuild/comparescene.STATUSES`).
 *
 * THE ROUTINE SILENCE, AND IT IS NOTHING LIKE THE ONE ABOVE. What is true of
 * the whole category is that the two builds did not both export the part, so
 * nothing was ever fused and nothing was established about it. Hardware and
 * mocks are the everyday case — nobody compares bought screws, and a part with
 * no geometry of ours has no STEP in either revision — but they are the example
 * and not the definition: a part that was `printable` in one revision and
 * hardware, or a mock, in the other lands here too, and there one build DID
 * export a STEP. It wore the warning colour and the top of the list while both
 * silences shared one word, and since most models carry several bought parts,
 * that stack of rows stood between the reader and the parts that actually
 * changed.
 *
 * QUIET IS NOT `unchanged`, and the one thing this word keeps from the other is
 * the one thing that matters: it is never counted as a part that came out the
 * same. A comparison where nothing was compared is not a comparison that found
 * nothing — so an "identical" is said about the parts that WERE compared and
 * says how many of these it left out (`compareSummary`).
 */
const NOT_COMPARED = 'not compared';

/**
 * What that word means, said once for the whole category (the legend line).
 *
 * THE DEFINITION IS THE FIRST HALF AND THE EXAMPLE IS THE SECOND, in that order
 * and not the other way round, because only the first half is true of every row
 * that wears the word. It read "hardware and mocks — no geometry of ours to
 * compare" for a round: true of nearly all of them and false of the one that
 * matters, a part that was `printable` in one revision and hardware or a mock in
 * the other, where one build DID export a STEP and the fuse still had nothing to
 * work with.
 *
 * A CONSTANT, so this and the hub's own sentence for the same row
 * (`cadbuild/comparescene._uncovered_line`) can be held to saying the same thing
 * by a test rather than by whoever edits one of them next.
 */
const NOT_COMPARED_WHY = 'the two builds did not both export it as STEP,'
  + ' so nothing was fused — hardware and mocks most often';

/**
 * Whether a row is one the reader may safely meet last.
 *
 * TWO WORDS AND NOT A CATEGORY. `unchanged` is the comparison saying it looked
 * and found nothing; `not compared` is it saying it never had two STEP files to
 * look at. Neither is news, so neither belongs in front of the row somebody
 * opened the comparison for — while `not measured`, which reads like these two
 * on screen and is the opposite claim, stays at the top with what changed.
 */
function isQuiet(status) {
  return status === 'unchanged' || status === NOT_COMPARED;
}

/**
 * The chip a status wears in the parts list.
 *
 * ONE FUNCTION BECAUSE TWO PLACES DRAW IT: the row, and the legend line that
 * says what `not compared` means. A legend showing a chip the rows do not wear
 * explains nothing, so the two are one expression rather than two that have to
 * be kept in step — and a test asserts they come out equal.
 *
 * THE REFUSAL IS ITS OWN THING AND NOT A QUIETER `unchanged`: the muted grey is
 * for a part the comparison has nothing to say about, and a refusal is a part it
 * could not say anything about, which is the opposite claim. The warning surface
 * is the one this interface already spends on "read this before you trust what
 * you are looking at" (the measurement's own note about a laid-out view, the
 * note box).
 *
 * AND `not compared` WEARS THE MUTED ONE, which is the other half of that
 * argument rather than an exception to it. A part the two builds did not both
 * export is not a warning about anything — with the bought screws in it, that is
 * the state several rows of an ordinary model are always in — and spending the
 * warning surface on it is what teaches a reader to ignore the surface.
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
 * A REASON THAT IS TRUE OF A CATEGORY IS NOT A ROW'S TO CARRY. `not compared`
 * means one thing and always the same thing — no pair of STEP files came from
 * the two builds, so nothing was fused — so the hub's sentence for it is
 * identical on every such row, and a model with eight bought screws printed that
 * one explanation eight times in a panel whose job is to show what CHANGED. It
 * is in the legend now, once, where an explanation of a word belongs; the rows
 * keep the word alone.
 *
 * `not measured` KEEPS ITS OWN. That sentence is about this part and about what
 * went wrong with it — which identity failed, and by how much — and this row is
 * the only place a reader can learn it, because nothing bright is drawn for such
 * a part and the scene shows it exactly as it shows a part nobody touched.
 *
 * NAMED RATHER THAN NEGATED, so a word this side does not know keeps whatever
 * the hub wrote under it: the panel drops a sentence only for the one status it
 * has moved into the legend itself.
 */
function rowReason(row) {
  return row.status === NOT_COMPARED ? '' : row.reason;
}

/**
 * `report.json`'s parts, as the records the hub writes them as.
 *
 * A LIST, EACH ROW CARRYING ITS OWN `key` — `cadbuild/comparescene.report`
 * writes `{parts: [{key, status, added_mm3, removed_mm3}, ...]}` and says the
 * same thing from the other side, where a test of its own pins it. A part
 * nobody measured carries a `reason` beside those — the two words for that,
 * `not measured` and `not compared` — and nothing else does.
 *
 * ANYTHING ELSE IS NO ROWS, and that is the honest answer rather than a
 * guess: this is a document produced by another process, and a shape this side
 * does not know is a hub that has moved, which the panel cannot report on.
 */
function reportParts(report) {
  const parts = report && typeof report === 'object' ? report.parts : null;
  return Array.isArray(parts) ? parts : [];
}

/**
 * `report.json`'s parts, in the order the compare panel lists them.
 *
 * WHAT CHANGED COMES FIRST, and that is the one thing this function decides. The
 * hardest case in the brief is "one part of forty changed" (ui-brief block 9),
 * and the report's own order is the catalogue's — so the single row somebody
 * opened the comparison to see can sit thirty rows down a scrolling list. Inside
 * each half the hub's order is KEPT: it is the assembly's own, and re-sorting by
 * volume would answer a question nobody asked.
 *
 * A STATUS THIS SIDE DOES NOT KNOW IS SHOWN RATHER THAN SWALLOWED. Six words
 * are the contract (`cadbuild/comparescene.STATUSES`: unchanged, changed, new,
 * removed, not measured, not compared); a seventh means the hub has moved, and
 * sorting it down would say nothing happened to a part the hub had something to
 * say about. So only the two QUIET words sort down (`isQuiet`), and whatever
 * else arrives is drawn as it came — `not measured` with them, at the top,
 * because a part the gate refused to answer for is exactly what somebody
 * opening a comparison has to see. `not compared` sorts with the quiet rows
 * instead: a part the two builds did not both export as STEP is not news — most
 * of them are bought screws, and there are usually several.
 *
 * THE REASON COMES WITH IT, and it is carried rather than reduced to a flag: a
 * refusal without its sentence is the panel saying the kernel would not answer
 * and refusing to say why, when the hub has already written down which of its
 * identities failed. It is a string another process composed, so anything that
 * is not one is no reason at all.
 *
 * A ROW WITH NO KEY IS DROPPED, because the key is the whole of what a row can
 * do: it is the part's identity (issue #75), it is what the click resolves
 * against the scene, and a row that cannot be pointed at anything is a line of
 * text pretending to be a control.
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
 * IDENTICAL IS AN ANSWER AND HAS TO BE SAID (ui-brief block 9), which is why it
 * is a sentence of its own rather than three zeroes in a row of counts. A reader
 * looking at a list where every row says `unchanged` cannot tell it from a list
 * that failed to load one.
 *
 * AND IT IS MEASURED AGAINST THE ROWS THE COMPARISON ESTABLISHED SOMETHING
 * ABOUT, which is the half that was wrong and made the answer unreachable. The
 * list is the VIEW's parts, `hardware` and `mock` among them, and those read
 * `not compared` — so on any ordinary model, which carries several bought
 * parts, "every row is `unchanged`" is never true and two identical revisions
 * came out as `40 parts · 0 changed · 0 new · 0 removed`. The brief names
 * identical as a state that must be shown EXPLICITLY, so it is said about the
 * parts that were compared, with the remainder out loud in the same line: the
 * claim is scoped rather than swallowed, and a reader can see exactly how much
 * of the model it covers.
 *
 * A SINGLE `not measured` STILL DENIES IT ENTIRELY, and that asymmetry is the
 * point of the two words. `not compared` is the routine silence — nothing of
 * ours was ever going to be measured for that part — while `not measured` is
 * the gate refusing a measurement where the kernel may have lied: something may
 * be wrong here, and "identical" is the most confident possible answer to give
 * over it. A word this side does not know denies it too, by the same rule: it
 * is not `unchanged`, so it is a part that did not come out the same.
 *
 * ONLY THE ALARMING ONE IS COUNTED IN THE ROW OF COUNTS, on the end and only
 * when there is one: a `· 0 not measured` on every ordinary comparison would
 * teach the reader to stop reading the tail of that line. `not compared` gets
 * its count only in the identical sentence, where it is the qualifier ON the
 * claim rather than one more number beside three others.
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
    // What the reader can take back: one entry per gesture, oldest first, each
    // holding the page as it stood BEFORE that gesture and saying by its `kind`
    // which sort of thing it describes. Spent by `undoStep`, which is where the
    // two are told apart.
    //
    // A VISIBILITY STEP holds `hidden` and `ghost`, and is written by
    // `setVisibility` — the ONE door for those two lists, which is what makes a
    // pair of them a whole step. A DOCUMENT STEP holds the whole proposal, and
    // is written by the two gestures that edit it: a part of the build dragged
    // or turned (`recordGesture`), and a body of the proposal dragged or turned
    // (`editBody`).
    //
    // Not state, for the reason `this.carry` is not: nothing on the page is
    // drawn from it, since there is no undo button and no count of the steps
    // behind one, so a write to it must not cost a render.
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
    // How many nodes the proposal has ever been given, which is where a new
    // one's id — and, for a body, its first name — comes from. A COUNTER AND NOT
    // THE LENGTH of the list: deleting the second of two and adding another
    // would mint `n2` twice, and two nodes under one id make `updateNode` edit
    // both. ONE COUNTER FOR BOTH KINDS, bodies and moves, because what it has to
    // keep apart is IDS: a move minted off a count of its own would sooner or
    // later take the number a body was already under. The prefix is what says
    // which kind a node is (`n1`, `m2`) and the id itself says nothing else.
    // Not state, for the reason `this.carry` is not — nothing on the page is
    // drawn from it, so a bump must not cost a render.
    this._proposalSeq = 0;
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
      revOpen: false, dlOpen: false, viewsOpen: false,
      cmp: [], compare: false, diffShow: 'both',
      // -- the comparison, and it is FIVE fields rather than one because they
      // answer five different questions (issue #10).
      //
      // `cmp` above is what the picker's ticks hold and it goes on moving while
      // a comparison is on screen — the reader can tick a third row without
      // meaning anything by it. `cmpPair` is the pair the panel and the scene
      // are ABOUT, snapshotted when Compare was pressed, so the two cannot come
      // to disagree about which comparison this is while one is on the wire.
      //
      // `cmpView` is snapshotted beside it and for the same reason. A
      // comparison is OF ONE VIEW — the hub builds the scene out of the two
      // revisions' view documents and caches it per view (hub.js) — so the pair
      // alone does not name one, and the tab the reader is on can move under a
      // job that is already running.
      //
      // `cmpStage` is the only thing that says whether there is a scene to show:
      // null before anything is asked, then `starting`/`running` while the hub
      // computes, then `ready`, `failed`, or `locked` for a reader with no
      // token. `sync` points the viewport at the comparison on `ready` alone —
      // a `scene.json` that does not exist yet would take the build off the
      // screen and put block 11's panel over the one already explaining itself.
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
      // -- the rough body the reader is asking the model to fit around, which
      // is ui-brief block 6 one step further on: a statement and not an edit.
      // Nothing here is pushed, nothing is rebuilt from it, and the model on
      // screen is untouched by it.
      //
      // A DOCUMENT AND A FLAG rather than one nullable field: the panel is a
      // sheet of controls that opens and shuts, and shutting it must not throw
      // the proposal away — a reader who shut it to look at something
      // underneath comes back to what they had. The document is drawn in the
      // tree's own column either way (`proposalTreeStyle`), so `proposalOpen`
      // is about the SHEET and about nothing else.
      //
      // `proposalError` is the KERNEL saying no: its own sentence about the
      // document as it stands, drawn in the panel where the reader is already
      // looking. The overlay is deliberately NOT cleared while it is set; see
      // `setProposal`. `proposalDraft` is the one field the reader is typing
      // in; see `computed`, where it is spent, and `commitProposal`, where it is
      // turned into a document.
      //
      // `proposalOff` IS THE BRANCH'S OWN EYE, and it is one boolean of
      // INTERFACE state rather than anything the document holds: it takes the
      // whole proposal off the model — the bodies stop being staged and every
      // displaced part goes back where the build puts it — while leaving the
      // document exactly as it was, so the moment the eye opens again
      // everything comes back, on the next stage that BUILDS (see
      // `toggleProposalEye`). It is read at the two doors to the viewport
      // (`proposalOverlay`, `proposalMoves`) and nowhere else. FALSE BY
      // DEFAULT, because a proposal that arrived invisible is one the reader
      // has to go and find.
      proposal: emptyProposal(), proposalOpen: false, proposalError: null,
      proposalDraft: null, proposalOff: false,
      // WHAT THE HUB HOLDS, in two fields with one reader each — because the two
      // questions asked of it are different questions, and one field answering
      // both was wrong for both. `proposalHeld` is about the RECORD and is read
      // by `saveProposal` alone; `proposalStands` is about what is IN it and is
      // read by `sendComment` alone.
      //
      // `proposalHeld` — is there a record for this project, and do we know yet:
      //
      //   * `null` — `loadProposal` has not answered. Nothing is written in this
      //     state, which is the guard that keeps a page that has not read the
      //     stored document from overwriting it with the empty one it mounted
      //     with. A LOAD THAT FAILED LEAVES IT NULL, deliberately: nothing was
      //     learned, so nothing may be written over. AND SO DOES A RECORD THIS
      //     PAGE DECLINED TO ADOPT (`adoptProposal`, where the reader had
      //     already drawn something): the page read a document it never showed,
      //     and "do not write" is exactly what it has to go on meaning;
      //   * `false` — asked, and there is nothing stored (a 404, or the record
      //     deleted from the branch's own `×`). A document with nothing in it is
      //     not written in this state either: an empty page would otherwise
      //     CREATE a record the moment the panel was opened;
      //   * `true` — a record is on the hub, because one was read or one was
      //     written.
      //
      // `proposalStands` — and it says something: the record's `text` is not
      // null, which is the hub's own word for a document that is neither empty
      // nor ticked off to the last node. `sendComment` tells the agent there is
      // one to read, where the reader did not attach it themselves — so it has
      // to be CURRENT rather than as of the load, and every write moves it: a
      // save raises or lowers it, the delete lowers it.
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
      // NOT STORED, and deliberately not: store.js is the one module on this
      // side allowed to touch localStorage, and what belongs there is a
      // PREFERENCE the reader expressed. This is which of two overlapping
      // things is in front right now, which the next page has no business
      // inheriting.
      treeOpen: false,
    };
  }

  /** No token, no edits. The whole of the customer/viewer split (brief). */
  viewer() { return !this.state.token; }

  /**
   * Are the three canvas tools — Measure, Comment, Move — out of service?
   *
   * THEY ARE, FOR AS LONG AS THE SCENE ON SCREEN IS A COMPARISON'S, and the
   * reason is the same one that took the file rows and Isolate out of the scene
   * menu (`menuItems`) and stopped `onPick` writing `sel`: everything those
   * three produce is addressed in the BUILD's terms, and a comparison's scene is
   * not the build. What each of them did instead is worth naming, because none
   * of the three failed loudly:
   *
   *   * COMMENT filed a task against build `<a>` naming `plate #1` at
   *     `/cmp/added/plate #1` — a part that exists in no build, in no catalogue
   *     and in no `model.py`, with a point in the comparison scene's frame. A
   *     comment is how an agent is told to change the model, so that one is not
   *     a wrong label but a wrong instruction;
   *   * MEASURE hands the chip an `add to comment` whose `partId` is `sel`,
   *     which `onPick` deliberately stops writing while a comparison is up and
   *     nobody clears — so a measurement taken off the comparison went to the
   *     hub attached to whatever part happened to be selected before the panel
   *     opened;
   *   * MOVE wrote a move node naming `/cmp/…` paths into the proposal — a
   *     displacement of a part no revision has, in a document the agent reads
   *     as a statement about this build.
   *
   * THE QUESTION IS `comparePair()` AND NOT `s.compare`, which is the same
   * reading `sync` points the viewport with and `onPick` resolves a pick by, so
   * the four cannot answer it differently. While the panel is up but the pair is
   * still being measured the BUILD is what is on screen and under the cursor, so
   * a comment, a measurement and a drag there are about the build and are
   * honest — it is the scene that decides, not the panel.
   *
   * BOTH ENDS ARE CLOSED with it: the two buttons draw themselves spent and
   * Move's row is not offered at all (`computed`), and the three handlers return
   * early — a tool armed before the comparison was opened is still armed, and
   * the viewport would go on reporting gestures for it otherwise.
   */
  toolsOff() { return !!this.comparePair(); }

  /**
   * Was this path a body of the proposal, rather than a part of the build?
   *
   * THE SAME CLASS `toolsOff` IS FOR, one source of parts further over. The
   * proposal panel stages its bodies into the scene (`staged()` in
   * viewport/element.js), which makes each of them an ordinary pick target — so
   * the Comment tool opens a composer headed
   * `motor` and posts `partId: "/<root>/proposal/motor"`, and `add to comment` on
   * the measurement chip attaches that same path to the number. Both are tasks
   * written in the BUILD's terms about a body that is in no build, no catalogue
   * and no revision, and the agent has nothing to look the path up in.
   *
   * THE MOVE GESTURE IS NOT REFUSED BY THIS. A drag of a proposal body is a
   * DIFFERENT GESTURE, told apart a step earlier by the viewport (`onDown` in
   * viewport/tools.js, which asks the same `isOverlay`) and ending in
   * `hmr:proposalmove` — an edit of the panel's own document rather than a task
   * about a part. So nothing about such a body ever reaches the `hmr:moved`
   * handler, and this question is never asked there. The row menu offers Move on
   * a body exactly as it does on a part, since a body needs the same armed tool;
   * what this answer decides there is only WHICH SENTENCE the row raises, the
   * two moves meaning different things.
   *
   * THE MEASUREMENT ITSELF IS NOT ONE OF THESE and is deliberately left alone:
   * a distance between two faces of a proposal body is the sort of thing the
   * panel exists to establish, and the chip it raises is the reader's own. Only
   * the PART the chip would file that number against is refused.
   *
   * THE VIEWPORT IS ASKED, because the group's name is minted there against the
   * model's own parts — `proposal`, or `proposal2` where the model publishes a
   * group of that name — and a path is all the event and the selection carry. A
   * ref call like `proposalOverlay`, and false wherever there is no element yet:
   * with nothing staged there is no proposal body to have picked.
   */
  proposalBody(id) {
    const el = this.el();
    return !!(el && typeof el.isOverlay === 'function' && el.isOverlay(id));
  }

  /**
   * Where the overlay's bodies hang in a tree, or null while nothing is staged.
   *
   * THE VIEWPORT IS ASKED AND NOT A NAME MATCHED, for the reason `overlayAt` in
   * viewport/element.js gives: the group's name is minted over there against the
   * model's own parts — `proposal`, or `proposal2` where the model publishes a
   * group of that name — so only over there can the overlay be told apart from a
   * model that honestly publishes a part called `proposal`. `proposalBody` above
   * is the ref call that asks.
   *
   * THE ROOT'S OWN CHILDREN AND NO DEEPER, because that is where `staged()`
   * hangs it, so the question costs one call per top-level row rather than one
   * per node of the tree.
   *
   * A METHOD BECAUSE TWO CALLERS NEED THE SAME ANSWER about two different trees:
   * `computed()` asks it of the tree on screen, to draw the proposal's branch
   * and to keep the overlay's rows out of the parts tree; `onModel` asks it of
   * the tree that has just LANDED, to move a selection made before the body was
   * staged onto the path the body now has.
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
        // THE ROW'S NAME, found by looking the seeded PATH up — the fourth
        // FIELD filled with a solid's name out of a viewport event's detail,
        // after `selName` (`hmr:pick`), a move node's own `name` (`hmr:moved`)
        // and `composer.part` (`hmr:place`). COUNTED AS FIELDS AND NOT AS
        // THINGS ON SCREEN, because `selName` is not one: it has a single reader,
        // `measAdd`, which copies it into `composer.part` — the third entry — so
        // counting what a person sees would count that one twice.
        //
        // THE PLACES THAT DRAW A NAME OFF THE ROW ITSELF SIT OUTSIDE THIS
        // COUNT, and are named so the inventory does not read short: the tree
        // row, the context menu's header and the toast `Copy name` raises, all
        // three in `computed`. Each takes `node.name` off the row it is
        // drawing, so none of them ever had anything to repair.
        //
        // EACH OF THREE ROUNDS OF REVIEW TOOK ITS OWN FINDING FOR THE LAST OF
        // THE FOUR FIELDS COUNTED ABOVE, which is why that count names the set
        // rather than declaring it closed. WHAT PUT SO MUCH ON IT is that issue
        // #75 changed two things and not one. It changed BEHAVIOUR — a run of
        // copies collapses into one row (`indexTree`), a selection became a
        // list of paths (`selectedPaths`, and `selected` in element.js),
        // `hmr:moved` grew a `count` (events.js), `movePart` takes paths — and
        // it changed what a NAME MEANS: a name that stood for ONE SOLID now
        // stands for a row of several, or for no row at all once the copies it
        // numbers have collapsed into one. THAT LAST CLAUSE IS THE COLLAPSED
        // CASE ONLY, and stating it flat would contradict `repeats` in hub.js:
        // a run broken by, say, another part standing between the copies or by
        // a `known` that disagrees, still draws a row called `pin(2)`, and
        // `tests/repeats.test.js` builds such trees under `indexTree keeps
        // apart what is not one row`. A NAME IS NO LONGER SOMETHING TO IDENTIFY
        // A SOLID BY, which is the whole of the second change.
        //
        // Only the first reads off a diff; this one reaches every surface that
        // DRAWS a name, whose own code did not have to move to start lying, so
        // the sweep had to be an inventory of surfaces — and it is written down
        // in `tests/repeats.test.js` rather than left to memory.
        //
        // `hmr:face` names the SOLID the plane was laid on (`seedCut` takes the
        // name off the owner path, `reportCut` reads it back off the seed), so
        // a cut placed on the second copy arrives as `pin(2)`, and no row is
        // drawn under that name once the run has collapsed into one: the panel
        // would head the cut with a part the reader cannot find in the tree.
        // Where the run did NOT collapse, the same lookup answers with that
        // copy's own row, so this is one path and not two. A lookup BY PATH and
        // never the identity-by-name #75 forbids; `d.name` is kept only for a
        // path no row claims, which is a face clicked before the tree landed, and
        // `'face'` for a hit that named no owner at all.
        //
        // BARE, on the same ground as `hmr:place`: the plane lies on ONE face
        // of ONE solid, so a count here would tally parts the cut was never
        // aimed at.
        const row = this.node(d.id);
        this.set({
          secOn: true,
          secFace: (row && row.name) || d.name || 'face',
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
        // The proposal's own door is `add to comment` in the panel, which posts
        // the projection as text and names no part at all.
        if (this.proposalBody(e.detail && e.detail.id)) return;
        const d = e.detail || {};
        // THE ROW'S NAME, found by looking the picked PATH up — the door onto
        // `composer.part` that a POINT PLACED IN THE SCENE opens (the inventory
        // of the two is on `measAdd`), and the same repair the other one
        // carries. `hmr:place` names the SOLID under the cursor — `pickEntity`
        // takes the name off the picked path — so a point on the second copy
        // arrives as `pin(2)`, and no row is drawn under that name once the run
        // has collapsed into one: the composer would head itself with a part the
        // reader cannot find in the tree. Where the run did not collapse, the
        // lookup lands on that copy's own row. A lookup BY PATH and never the
        // identity-by-name #75 forbids; `d.name` is kept only for a path no row
        // claims, which is a point placed before the tree landed.
        //
        // BARE, like `measAdd`: a point sits on one solid, so a count here would
        // tally parts the reader never touched.
        //
        // TWO POINTS ON TWO COPIES COLLAPSED INTO ONE ROW THEREFORE BOTH READ
        // `pin`, and that is an accepted consequence of #75 rather than an
        // oversight — the row is what the reader can find in the tree. They are
        // still told apart, by the pin drawn on the model and by the `partId`
        // posted with each, which stays the copy's own path. Nor is titling a
        // comment off whatever row `node()` answers with new here: `measAdd` has
        // always been written that way, and what #75 changed is which row that
        // is — on that door the two copies collapse in the id as well, since
        // `sel` is the row's.
        const row = this.node(d.id);
        this.set({
          composer: {
            part: (row && row.name) || d.name || 'model',
            partId: d.id || null, key: (row && row.key) || null, p: d.p || null,
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
    //
    // Ctrl+Z and Cmd+Z take back THE LAST THING DONE, whichever kind of thing it
    // was: hiding, ghosting or isolating in the tree, or a part of the build — or
    // a body of the proposal — dragged or turned in the scene. `undoStep` is
    // where the two are told apart. Both chords, because this page is read on
    // both platforms and neither is spoken for here; `preventDefault()` so the
    // browser cannot answer the same keystroke a second time over whatever it
    // decides is in scope.
    //
    // SHIFT AND ALT ARE NOT LOOKED AT. There is no redo for Shift+Z to mean, so
    // reading the modifier would only turn the reflex into nothing happening.
    //
    // NOT WHILE SOMEBODY IS TYPING, which is what `typingTarget()` answers. The
    // comment composer is a textarea and Ctrl+Z inside it is the browser's own
    // undo over the sentence being written — the same sentence the paragraph
    // above calls the most expensive thing on this page to lose.
    //
    // THE LIBRARY CANNOT SWALLOW THIS CHORD, which is why the listener stays in
    // the bubble phase with Escape's rather than moving to capture the way
    // `holdkey.js` had to: `_handleKeyboardShortcut` is bound on the container
    // and returns before its keymap is consulted whenever ctrl, alt or meta is
    // down (read off the bundle at :113836, not assumed).
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
      this.set({ menu: null, secPop: false, revOpen: false, dlOpen: false,
                 viewsOpen: false, notePop: null, tokenPop: false, tool: null });
    };
    window.addEventListener('keydown', this._kd);

    // Back and forward through the revisions this page pushed. A switch is a
    // `pushState` (see `switchBuild`), so the browser's own history now holds
    // entries this document has to answer for itself — without this listener
    // Back changes the address bar and leaves the previous revision on screen,
    // which is a worse lie than the reload it replaced.
    //
    // The ENTRY IS READ OFF `location`, never off `event.state`: the entry the
    // reader lands on may be the one the server rendered, which carries no state
    // of ours at all, and the URL is the only thing every entry has.
    //
    // AND IT IS READ BY `pageFrom`, the page's own arithmetic, rather than by a
    // second copy of the slicing here. This line used to be
    // `location.pathname.split('/')[3]`, which answers the slot and nothing
    // else — and since a comparison has an address of its own (issue #10) an
    // entry can also name a PAIR, which that reading had no way to see.
    this._pop = () => {
      const at = pageFrom(location.pathname);
      // "IS THIS THE BUILD WE ARE ALREADY ON" IS NOT ASKED HERE, and it used to
      // be — against `PAGE.slot`, which during a swap still names the build
      // being left. Forward onto an entry naming it was thrown away as a no-op
      // while a swap to somewhere else was in flight, and the swap then landed
      // under an address bar saying otherwise. `switchBuild` answers it now,
      // because the thing it has to be asked against — where the page is going
      // — lives there.
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

    // The window can cross the breakpoint while the page is open, and on the
    // devices this branch is for that is the ORDINARY case rather than an edge
    // one: turning a phone sideways is a resize. The constructor's read is only
    // the first answer; this keeps it current.
    //
    // `addEventListener` on the MediaQueryList, not the deprecated
    // `addListener`, and it goes with the window listeners above so that
    // `componentWillUnmount` takes it down the same way — a live query holding
    // this component would `setState` on one that is gone.
    //
    // AND AN ARMED TOOL DOES NOT SURVIVE THE CROSSING. `tool` is armed from the
    // toolbar, or for Move from an object's row menu; it is put away from the
    // toolbar buttons or from Escape — the menu row only ever arms — and the
    // narrow branch drops the buttons, while a phone has no Escape key. So
    // Measure armed in landscape would turn every touch on the model into a
    // measurement point after a rotation, and Move, for somebody with a token,
    // would drag a part where an orbit was meant. Through `this.set`
    // rather than `setState`, because the VIEWPORT is holding that tool too and
    // has to be told it is over; the wide direction is a plain `setState`, since
    // nothing there is being taken away.
    this._mq = window.matchMedia ? window.matchMedia(NARROW) : null;
    if (this._mq) {
      this._narrow = (e) => (e.matches
        ? this.set({ narrow: true, tool: null })
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

  async load() {
    const meta = await loadMeta();
    const builds = await loadBuilds().catch((error) => {
      // A project with no builds.json is a project whose picker is empty, not a
      // page that failed: the model in front of the reader is unaffected.
      console.warn('builds', error);
      return null;
    });
    const wanted = new URLSearchParams(location.search).get('v');
    const opening = meta.views.find((v) => v.id === wanted) || meta.views[0];
    // THE ARRIVAL ON THE TAB STRIP (issue #45), the same fact `rememberPointer`
    // records in `componentDidMount` and recorded HERE instead, one fetch later,
    // for one reason: this is the first moment a human-readable name for the
    // project exists. Before `meta` lands there is only `PAGE.pid`, and a strip
    // of ids is a strip nobody can read.
    //
    // ON ARRIVAL ONLY. The in-place revision switch and the poll's refresh both
    // replace `meta` without this line, deliberately: they are the same project,
    // already on the strip, so re-recording there would move nothing and refresh
    // a stamp for a reader who never left the page.
    rememberTab(PAGE.pid, meta.title || meta.project);
    // `view` is what makes the viewport fetch and render: it starts null on both
    // sides, so this first sync is also the load.
    this.setState({ meta, builds, view: opening.id, tabs: readTabs() },
                  () => {
                    this.sync();
                    this.schedulePoll(POLL_MS);
                    // AND A COMPARISON LINK OPENS COMPARING (issue #10). The
                    // address is the only thing that says a link was one, and
                    // everything above has just opened `<a>`'s page out of it —
                    // so this is the tick in the picker that the person who sent
                    // the link had already made, performed for the reader who
                    // opened it. In the callback because `compareRevisions`
                    // snapshots the view off `this.state.view`, which the line
                    // above is what sets.
                    //
                    // ON THE VIEW THIS ADDRESS NAMES, exactly as a build page
                    // opens on the view its own address names: `opening` is read
                    // from `?v=` above, and a comparison address carries that
                    // query like any other — `moveAddress` writes it with
                    // `viewQuery`, the one helper every address on this page is
                    // spelled by. So a comparison started on a non-default tab
                    // is sent as `…/compare/<b>/?v=<tab>` and reopens on that
                    // tab, and one started on the first view is sent bare
                    // because `viewQuery` drops the query there.
                    //
                    // A TAB PRESSED LATER DOES NOT MOVE THE ADDRESS, which is
                    // also a build page's behaviour and not a gap in this one:
                    // the query is written where the page NAVIGATES, and
                    // `showView` is not a navigation on either kind of page.
                    //
                    // THROUGH `commitOf` FOR THE TICKS TOO, because the ticks
                    // are what the Compare button then asks with: an address
                    // whose `<a>` is `latest` has to leave the picker showing
                    // the commit it resolves to, which is the row that would be
                    // ticked had the reader made this comparison here.
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
   * INCLUDING WHEN IT IS THE TAB THE READER IS STANDING ON. A tab is a link, so
   * closing one is forgetting a link and not leaving a page: the model stays on
   * screen, the address still names this project, and since the address is the
   * only thing that ever said which tab was active there is no active-tab state
   * left pointing at something that is gone.
   */
  closeTab(pid) {
    forgetTab(pid);
    this.setState({ tabs: readTabs() });
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
    // THE ADDRESS THIS BUILD HAS, computed once and read by both writers below —
    // the push that lands a swap, and the replace that calls one off. It sits
    // above the guards rather than beside the push because the cancelling branch
    // needs it to ANSWER a guard: whether the bar still names the build on
    // screen. One expression, so the two can never disagree about what the
    // address of a slot is.
    const path = `/project/${PAGE.pid}/${encodeURIComponent(slot)}/`;
    // ALREADY GOING THERE, which is not the same question as "already here" and
    // is the one BOTH DOORS ask. `PAGE` is where the page HAS GOT TO, and a swap
    // moves it only once its fetch answers, so during one `PAGE.slot` still
    // names the build being left. `_want` is the destination: the slot of the
    // last gesture this method accepted, and `PAGE.slot` whenever nothing is in
    // flight.
    //
    // ASKING `PAGE.slot` FROM THE PICKER BURIED A HISTORY ENTRY. Forward onto B
    // starts a swap; the reader, seeing nothing yet, opens the picker and clicks
    // row B — `PAGE.slot` was still A, so the click passed for a real gesture
    // and `pushState` laid a second entry for B on top of the one they were
    // standing on. Back then looks like nothing happened, and the forward
    // history is gone.
    //
    // The generation below is taken AFTER this line, and this is the case that
    // needs it there: the gesture asks for what is already on its way, so a bump
    // here would kill the swap fetching it and leave nothing to land.
    const here = this._want || PAGE.slot;
    if (slot === here) { this.setState({ revOpen: false }); return; }

    // ON SCREEN, BUT BEING LEFT — so this gesture asks to STAY, and staying is
    // not a trip. Reader on B, Back starts a slow swap to A, Forward comes back
    // to B: the page is showing B and the address says B. There is nothing to
    // fetch, nothing to push and nothing to leave behind; all that is asked is
    // that the swap be called off.
    //
    // RUNNING THE WHOLE SWAP INSTEAD IS WHAT THIS REPLACES, and it cost more
    // than the doing-nothing it looked like. `leaveBuild` ran over a build
    // nobody was leaving, so the selection went, the session's pins went, the
    // composer lost its part and the measurement went — a reader who pressed
    // Forward to get back where they already were lost their own work. Then the
    // viewport was handed a payload IDENTICAL to the one it had: same `base`,
    // same `buildKey`, same `view`, which `element.js` reads as neither a
    // reload, a swap nor a retry, so it never called `load()`. No `hmr:model`
    // came back, `onModel` never ran, and the two things it spends were left
    // armed — `_refit`, which then made an ordinary live reload re-capture the
    // frame Fit promises to keep, and `carry`, which rejoined hidden parts BY
    // NAME onto a tree nobody had switched to and hid a part the reader never
    // touched. Both fired later, on an unrelated event, which is where the
    // debugging would have started.
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
        // THE SWAP BEING CANCELLED MAY HAVE MOVED THE ADDRESS ALREADY. A picked
        // swap pushes nothing until its fetch answers, but a `popstate` swap
        // exists BECAUSE the browser moved first — so Forward onto B, then a
        // click on the row for A still on screen, leaves the bar saying B with
        // nothing else on the page to bring the two back together. F5 opens a
        // build the reader declined, the copied link points at it, and the next
        // Back reads as "nothing happened". `pageguard` refuses that state in
        // its own words — "PAGE stopped describing the address the browser is
        // on".
        //
        // REPLACE, NEVER PUSH. The reader did not navigate, they CANCELLED a
        // navigation, so the entry the browser has already moved to is the one
        // that has to be corrected. A push would lay a third entry whose Back
        // goes straight back to the build just declined — the cancelled gesture
        // returning through the history.
        //
        // AND IT IS MEASURED, not inferred from who called. A flag saying "this
        // swap came from popstate" would be a second copy of a fact the address
        // already carries, kept in step by hand, in the one method whose last
        // rounds were all about state falling out of step. The divergence itself
        // is what has to be repaired, and it is right there to be read.
        //
        // THE ADDRESS BEING REPAIRED TO IS NOT ALWAYS `path`, and that is the
        // half a comparison added (issue #10). Nothing here changes what is on
        // the SCREEN, so if a comparison of this build is up then the address
        // describing this page is that comparison's, not the build's — writing
        // `path` would take the panel's own URL away under a panel that is still
        // open. `addressOf` is the one place that question is answered.
        const staying = this.addressOf(
          this.state.compare ? this.state.cmpPair : null);
        if (location.pathname !== staying) {
          history.replaceState({ hmr: slot }, '',
                               staying + this.viewQuery(this.state.view, views));
          // The repaired address may be a comparison's, so `PAGE.cmp` has to
          // follow it; on a plain build URL this re-derives what was there.
          rereadPage(staying);
        }
      } else {
        // THE ONE THING THAT CAN STILL BE OUT OF STEP IS THE VIEW: an entry
        // carries its own `?v=`, and Back onto a different tab of the build on
        // screen is a real change.
        //
        // AND IT IS WRITTEN HERE RATHER THAN THROUGH `showView`, which is where
        // this line used to go — the view tab's own path, on the reasoning that
        // a view is not a build and this method has nothing to add to one. A
        // comparison gave it something to add (issue #10): `showView` restarts
        // the comparison on the new view while one is up, `compareRevisions`
        // MOVES THE ADDRESS, and `moveAddress` pushes. That is a `popstate` that
        // ends in a `pushState` — the entry the reader came back to buried, the
        // Forward they had lost, and two identical entries in its place. Both
        // this branch and `moveAddress` state in prose that a `popstate` never
        // pushes; this is the door that let one through.
        //
        // THE PANEL IS NOT THIS BRANCH'S TO PUT BACK, and that is why setting
        // the field bare is not a half-fix: `_pop` calls `syncCompare` one line
        // later, on the entry itself, and that is the one door that opens the
        // comparison an entry names or closes the one it does not. Restarting a
        // comparison HERE would answer that question a second time, off a field
        // rather than off the address the reader just moved to.
        const wanted = this.entryView();
        if (wanted !== this.state.view && views.some((v) => v.id === wanted)) {
          this.set({ view: wanted });
        }
      }
      return;
    }

    // CLOSED BEFORE THE FETCH, not after it: it is the only sign the click
    // landed on a gesture that now waits on the network, and a menu left open
    // over a page that has not moved yet reads as a click that missed.
    //
    // IT IS NOT A LOCK, and this comment used to say it was — that closing the
    // picker "keeps a second row from being picked while the first is still in
    // flight". False in two directions. `revToggle` puts the menu back with one
    // click and `onPick` asks nothing before calling this again; and `popstate`
    // never goes through the picker at all — it is a gesture on the browser's
    // own chrome, and Back during a slow fetch simply starts a second swap.
    // Two in flight then settled in whatever order the NETWORK answered: pick
    // B, reopen, pick C, and a reader whose last word was C ends on B — with
    // `push C, push B` behind them, an address bar walked BACKWARDS through two
    // entries neither of which the reader asked for last.
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
    // AND WHERE THIS PAGE IS NOW HEADED, for the guard above. Written together
    // with the generation because they answer the same question from two sides:
    // the number says which swap is current, this says which BUILD it is for.
    this._want = slot;

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
    // `rereadPage` writes `PAGE` and nothing else, and `setState({ meta })` does
    // not touch `tree`. Neither of the two lines below can move a tree — which
    // is a smaller claim than "the tree has one writer", the version this
    // paragraph carried for a round. It has three: `onModel` replaces it,
    // `onViewError` clears it, and the constructor starts it null. The middle
    // one matters here more than anywhere, because it is the tree going away
    // WITHOUT a model event — the very case the carry exists for.
    const gone = this.leaveBuild(view === this.state.view);

    if (push) history.pushState({ hmr: slot }, '', path + query);
    // IN PLACE, so every module that imported `PAGE` sees the new revision —
    // `loadMeta`, `loadBuilds`, `isPointerPage`, `sync`'s `base`, the comment
    // route, the download hrefs and the header's own slot. Nothing re-derives it
    // on its own, which is why a swap that forgot this line would go on fetching
    // the revision that had just left the screen, silently and forever.
    //
    // FROM THE BAR ON A `popstate` AND FROM `path` ON A PUSH, because those are
    // two different sources for one fact: on a push the line above IS the
    // address, while a `popstate` was the browser moving first — onto an entry
    // this page wrote, which may be a COMPARISON of the build being opened
    // (issue #10). Re-deriving from `path` there would leave `PAGE.cmp` empty
    // under an address that names a pair, and `syncCompare` reads the entry
    // rather than the record, so nothing downstream would have noticed.
    rereadPage(push ? path : undefined);

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
    // AND THE UNDO STACK GOES, on the argument the paragraph above makes about
    // ids — and it holds for BOTH KINDS of step. A visibility entry is two lists
    // of leaf ids of the build being left, and a rebuild is free to renumber
    // those paths onto other parts: restoring one after the swap would not put a
    // step back, it would hide somebody else's part. A document entry carries
    // move nodes, which are paths of that same tree plus a delta measured
    // against where that build put the part — the very thing the `dropMoves`
    // just below takes out of the document, so a step restored after the swap
    // would put back by a keystroke exactly what the swap had established was no
    // longer about anything. Nothing carries a step across either — a
    // carry is one snapshot resolved by name, and the history is a sequence,
    // which is a different thing to rejoin and not one the reader asked for.
    this.history = [];
    // WHAT OF THE PROPOSAL SURVIVES THE SWAP: the bodies, never the moves. It is
    // bound here, one line from the state object below, because the draft's
    // attachment asks two questions of the same document — whether anything is
    // left to attach, and what it says — and a state object literal has nowhere
    // to put a local. `dropMoves` is pure, so this is about writing the
    // expression once and not about the two calls answering differently. The
    // composer block at the foot of that object carries the rest of the
    // argument.
    const left = dropMoves(this.state.proposal || emptyProposal());
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
        // AND THE COMPARISON, which is on this list rather than in the callers
        // for the same reason everything else here is: it is about the build
        // being left. The panel stands where the tree stands and the scene on
        // screen is the comparison's rather than this build's, so a swap that
        // kept it would move the address, refetch a meta.json nothing was
        // drawing from, and change nothing the reader can see. The ticks in the
        // picker (`cmp`) are deliberately NOT cleared: they are a choice about
        // which two revisions to look at, and the reader made it.
        compare: false, cmpPair: null, cmpView: null, cmpStage: null,
        cmpError: null, cmpReport: null, cmpSel: null,
        revOpen: false, dlOpen: false, viewsOpen: false, secPop: false,
        tokenPop: false, tokenDraft: '', notePop: null, noteDraft: '',
        // It describes geometry that has just left the screen; the viewport
        // clears its own tape on every load. The offsets are the same kind of
        // thing and are not here: they live in the proposal document now, and
        // `onModel` drops them when the build that lands is a different one.
        measure: null,
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
        // THE TEXT SURVIVES THE SWAP AND NOTHING POSITIONAL DOES, and the line
        // between them is what the reader WROTE against what this page MEASURED.
        //
        // The sentence is the reader's own and half-written text is the most
        // expensive thing on this page to lose (the same reason Escape spares it);
        // it is also still true of the revision now on screen often enough to be
        // worth keeping, and the reader can read it and decide. Everything else in
        // the draft is a coordinate this page took off geometry that has left:
        // which solid was picked, where in space, a measurement between two faces,
        // and — inside the attached projection rather than as a field of its own
        // — a part dragged out of the assembly. `sendComment` posts to `meta.commit`
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
        //
        // AND THE CATALOGUE KEY GOES WITH THE NAME, which is the same decision
        // read the other way round. The key is the one field here that DOES
        // survive a rebuild — it is what the whole anchor is built on — so the
        // reflex is to keep it. But the composer shows `part` and nothing else:
        // a draft with the name cleared and the key kept looks unattached on
        // screen and posts anchored, which is the invisible mismatch above with
        // the two halves swapped. Both go, or neither.
        composer: this.state.composer
          ? {
            ...this.state.composer,
            part: '', partId: null, key: null, p: null, meas: null,
            // THE ATTACHMENT FOLLOWS THE DOCUMENT, which is what makes the
            // paragraph above true of it as well. The projection was captured
            // as TEXT when `add to comment` was pressed, and a proposal is
            // mostly bodies — the reader's own claim about a motor or a wall,
            // as true of the revision arriving as of the one leaving. But it
            // may also carry `move` lines, and those are deltas measured
            // against where THIS build put a part: `dropMoves` takes them out
            // of the document when the new build lands (`onModel`), and an
            // attachment left as captured would hand the agent exactly the
            // sentences the document has just stopped making.
            //
            // RE-RENDERED FROM THE DOCUMENT AS IT STANDS NOW, which is not the
            // one the attachment was taken from and cannot be: the panel stays
            // open and editable across a swap, so a body may have been added or
            // deleted since `add to comment` was pressed, and those edits come
            // across with this re-render. That divergence is the accepted price
            // of stripping the move lines — the alternative is parsing them back
            // out of a string the agent is meant to read, and the document is
            // the only thing here that knows which lines are moves.
            //
            // A DOCUMENT WITH NOTHING LEFT TO SAY DROPS THE ATTACHMENT
            // INSTEAD, because a move-only proposal has nothing left once the
            // moves go, and what would be attached is a `proposal` block with
            // no statement in it. `sendsNothing` is the same predicate
            // `proposalAddStyle` refuses that state at the front door with, so
            // the swap cannot post what the link would not offer — and it is
            // that one rather than `isEmpty` because a node the reader ticked
            // off travels no further than a node that is not there.
            //
            // ONLY WHERE THERE WAS ONE: writing this field unconditionally
            // would attach a projection to a draft the reader never attached
            // one to.
            ...(this.state.composer.proposal
              ? { proposal: sendsNothing(left) ? null : proposalText(left) }
              : null),
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
   * One gesture of the scene written into the proposal, whichever field of the
   * node it was about: `said` is `delta` for a drag (`hmr:moved`) and `turn`
   * for a ring (`hmr:turned`), and everything else here is the same sentence.
   *
   * ONE FUNCTION FOR THE TWO, and it is the only shape that keeps them
   * agreeing. A move node holds a displacement and a rotation, both measured
   * from where the build puts the part; the two gestures each say ONE of them
   * and must not say a word about the other — so the rules below are about
   * which nodes a set of paths touches, what happens to the ones it covers, and
   * what the field the hand did not touch is carried across as. Written twice,
   * with `delta` and `turn` swapped, they would not fail: they would drift, and
   * the drift is a document that answers differently depending on whether the
   * reader slid the part or turned it.
   *
   * A METHOD RATHER THAN A CLOSURE INSIDE THE HANDLER MAP — the same move
   * `onModel` makes and for the same reason: the map is built in
   * `componentDidMount`, which loads a build and starts a poll, so a decision
   * written inside it can only be reached by mounting the whole page.
   */
  recordGesture(detail, said) {
    // Not while the scene is a comparison's (`toolsOff`): what this records
    // is a node of the proposal naming a part in the BUILD's terms, and the
    // paths of a comparison's scene are `/cmp/…` — a displacement of a part
    // no revision has, in a document the agent reads as a statement about
    // this one.
    if (this.toolsOff()) return;
    // A BODY OF THE PROPOSAL DOES NOT REACH HERE, and no check on this side
    // says so: the viewport tells the two gestures apart at the PRESS and
    // sends a drag or a turn of a proposal body on `hmr:proposalmove` and
    // `hmr:proposalturn` instead, which is `editBody` below. The two write the
    // same document and mean opposite things — a body's own `at` and `rot` are
    // edited, because the reader placed it; a part of the build gets a move
    // node beside the bodies, because the model is untouched and what the hand
    // did to it is the statement.
    const values = (detail && detail[said]) || [];
    if (values.length !== 3 || !values.every(Number.isFinite)) return;
    // THE NAME IS THE ROW's, found by looking the dragged PATH up — the
    // same `node()` the pick handler above and the menu header in
    // `computed` go through. The viewport names the SOLID it grabbed, so a
    // drag of the second copy arrives as `pin(2)`, and no row is drawn under
    // that name once the run has collapsed into one: the projection would
    // carry a part the reader cannot find anywhere in the tree. Where the
    // run did not collapse, that copy is a row itself and the lookup simply
    // finds it. This is a lookup BY PATH and not the identity-by-name that
    // #75 forbids — `e.detail.name` is kept only for a path no row claims,
    // which is a drag that landed before the tree did.
    //
    // RESOLVED ONCE, HERE, AND KEPT ON THE NODE. The document outlives this
    // moment and the tree it was read off does not: a run that collapses on
    // a later stage has no row under `pin(2)` at all, and a projection that
    // looked the name up at print time would go blank or wrong on a line the
    // reader had already sent nothing of the sort.
    //
    // THE COUNT STAYS THE VIEWPORT's, because the two differ: a drag begun
    // with NOTHING SELECTED moves the one copy it grabbed, out of a row that
    // holds five. Reading the row's count here would write "×5" into a
    // sentence about one part.
    const paths = Array.isArray(detail.paths) ? detail.paths : [];
    if (!paths.length) return;
    // THE REPORT CAN OUTLIVE THE BUILD IT WAS MEASURED ON, which is what the
    // stamp is for. The viewport defers this event by a microtask so it
    // cannot be raised from inside a render (`reportModelMove` in
    // viewport/tools.js says why), and `show()` ends the live gesture and
    // then dispatches `hmr:model` with no `await` between the two — so a
    // rebuild landing mid-drag reaches `onModel` FIRST, which drops the
    // moves, and this report arrives afterwards carrying paths and an offset
    // belonging to an assembly that is no longer on screen. Written down, it
    // would displace a part of the NEW build by a number nobody measured
    // against it, and `proposalMoves` would push that straight at the scene.
    //
    // COMPARED AGAINST THE KEY THIS PAGE IS SHOWING, which is the same string
    // the viewport was handed in `hmr:state` (`buildKey(meta)`), so the two
    // sides are comparing one value and not two spellings of it.
    if (detail.build !== buildKey(this.state.meta)) return;
    // AND THE STEP IS RECORDED HERE: after the last guard, so a gesture that was
    // refused leaves nothing on the stack, and before the write, so the entry
    // describes a document the reader was really looking at. What it holds is
    // the WHOLE document, which costs a reference and not a copy — every helper
    // in proposal.js returns a new document and mutates nothing, so the one this
    // edit is about to replace goes on standing exactly as it is.
    //
    // READ OUT HERE AND NOT INSIDE THE UPDATER, for the reason the id below is
    // minted outside it: React is free to call an updater more than once, and a
    // push from in there would put a step on the stack per call — a side effect
    // in a function this file keeps pure on purpose.
    this.recordStep({ kind: UNDO_DOCUMENT,
                      doc: this.state.proposal || emptyProposal() });
    // THE NAME IS THE ROW's, resolved before the write for the reasons above
    // — and read here rather than inside the updater because the TREE is not
    // what the updater is guarding: a build landing between these two lines
    // is what the stamp already turned away.
    const row = this.node(detail.id);
    const name = countedName((row && row.name) || detail.name,
                             detail.count);
    // NOTHING IS ROUNDED HERE, and that is a decision rather than an omission.
    // Every number this document holds is drawn in the panel and printed in the
    // projection, so it has to be one somebody could have typed — but the
    // rounding belongs where the ARITHMETIC is, and there is none on this
    // line. `snap` in viewport/tools.js multiplies a step out and rounds its
    // own result by `tidy`; the rings round to whole degrees and `tidy` the one
    // sum they make; `moveNodes` adds a delta to an `at` and rounds that. This
    // handler carries a number across, so a second rounding would be two places
    // that have to agree about a value neither of them made.
    //
    // THE OTHER FIELD OF THE NODE, which this gesture did not touch and must
    // not invent one for: a drag says where the part should be and says nothing
    // whatever about which way it should face, and a turn says the opposite.
    // `kept` is the name of that field and it is carried across below.
    const kept = said === 'delta' ? 'turn' : 'delta';
    // A GESTURE THAT PUTS ITS OWN ANSWER BACK TO NOTHING IS A RETRACTION, not a
    // move of zero and not a turn of zero. The viewport reports nothing at all
    // unless something WAS standing (`reportModelMove` and `reportModelTurn`
    // stay silent otherwise), so this is the reader taking the displacement — or
    // the rotation — back by hand, and the document says that by losing the
    // node rather than by carrying a `move "plate" by (0, 0, 0)` line into the
    // projection for an agent to puzzle over and a row into the panel to be
    // closed by a second gesture.
    //
    // OF THIS GESTURE'S OWN FIELD AND OF NOTHING ELSE, which is why this is
    // only half the question and the other half is asked inside the updater. A
    // TRANSLATION GESTURE EDITS THE TRANSLATION: the hand was on the part's
    // position, so "put it back where it was" is an answer about where, and a
    // node that also says which way the part faces is not a node this gesture
    // has retracted. Dropped anyway, it would take a rotation the reader set in
    // the panel and never mentioned — an answer to a question they did not ask,
    // and one nothing on screen would explain. Read the two words the other way
    // round for a ring, which is the whole of what one function buys.
    const flat = values.every((value) => value === 0);
    // ONE NODE PER PART, REPLACED AND NEVER ADDED UP. What the viewport
    // reports is CUMULATIVE from where the build puts the part — each press
    // starts from the offset and the angles already standing (`vp.moved.get`
    // in viewport/tools.js and in viewport/rings.js) and every write is
    // `home + delta` about the part's own centre — so a second gesture on the
    // same parts describes the whole of it again, and adding that to what is
    // recorded would send the part twice as far, or turn it twice as much.
    //
    // MATCHED BY INTERSECTION AND NOT BY THE FIRST PATH, because the paths
    // of a gesture are the SELECTION's and the selection moves under the
    // reader: a drag out of a collapsed row that nothing was selected in
    // takes the one copy it hit and re-selects the whole row, so the next
    // drag of the same part arrives under a different first path. Matched on
    // that, the two gestures wrote two nodes claiming the same copy — two
    // contradictory `move` lines about one part in the projection, and two
    // rows in the panel of which only one `×` appeared to do anything.
    //
    // AND WHERE SEVERAL ARE COVERED WHOLE, ALL OF THEM GO. The reader
    // dragged two copies apart and has now dragged the row that holds both:
    // whatever those nodes said about them has been superseded by one
    // gesture, and keeping either would leave the document claiming an
    // offset the scene no longer has.
    //
    // A NODE ONLY PARTLY COVERED IS SUBTRACTED FROM AND NOT DROPPED, which
    // is the difference between a truthful document and a destructive one.
    // Five copies moved to +3 and then one of them nudged to +8 leaves four
    // at +3 and one at +8 — drop the old node outright and the other four go
    // home on the very next push, four displacements the reader made undone
    // by a nudge of a fifth, with nothing on screen saying why four parts
    // jumped. Subtracting leaves one statement per part either way: no path
    // is claimed twice, and none is quietly let go.
    //
    // COMPUTED INSIDE THE UPDATER, which is the second half of the same
    // hazard the stamp above answers and not a style choice. This is a
    // read-modify-write of the document, and `onModel` patches it
    // FUNCTIONALLY — so a swap landing between a read of `this.state` and
    // the object patch that followed it would be overwritten wholesale, and
    // every move node `dropMoves` had just taken out would come back. An
    // updater is handed the state as it stands at the moment the write is
    // applied, which is the only state this edit is meaningful against.
    //
    // THE ID IS MINTED BEFORE THE UPDATER RUNS, so the updater is a pure
    // function of the state it is handed. React is free to call one more
    // than once, and a counter bumped inside would climb by however many
    // times it did — harmless here, since the field promises uniqueness and
    // nothing else, but a side effect in an updater is a thing to keep out
    // rather than one to reason about every time it is read.
    this._proposalSeq += 1;
    const id = `m${this._proposalSeq}`;
    let opened = false;
    this.setState((s) => {
      const doc = s.proposal || emptyProposal();
      const touching = moves(doc).filter(
        (node) => node.paths.some((path) => paths.includes(path)));
      const covered = touching.filter(
        (node) => node.paths.every((path) => paths.includes(path)));
      // THE SHRUNK NODE IS RENAMED, because the name was resolved once at
      // the record above and CARRIES THE COUNT (`countedName`): `pin ×5`
      // left on a node that now holds four paths is a false line in the
      // projection the agent reads and a false row in the tree. Re-resolved
      // the way the record resolves it — the row under the first path that
      // remains, counted by how many remain — and where no row claims that
      // path any more, the name the node already had is kept rather than one
      // invented out of a path string.
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
      // THE ONE COVERED NODE IS EDITED IN PLACE RATHER THAN REPLACED,
      // because a second gesture over the same set of paths is the SAME
      // statement said again and not a new one: what the viewport reports is
      // cumulative from where the build puts the part, so what changed is a
      // number on one sentence. Minting a fresh id for it would remount the
      // row in the proposal's branch (`proposalRows` keys on the id) and walk
      // the line to the bottom of the projection, both of which describe a
      // sentence being replaced rather than corrected.
      //
      // AND THE FIELD THAT NODE ALREADY CARRIES SURVIVES THE EDIT, because
      // this patch does not name it: a drag says where the part should be and
      // says nothing whatever about which way it should face, and a turn of
      // the rings says the one and not the other.
      //
      // A MINTED NODE TAKES WHAT THE NODES IT TOUCHED AGREE ON. Read the
      // paragraph below with `delta` and `turn` either way round — it is the
      // same argument twice, which is why `kept` is a name and not a literal.
      // No gesture may undo the half it did not touch, and there are two ways
      // it would. Minting at zero after SUPERSEDING several nodes straightens
      // (or homes) every copy at once, and the commonest way to have several
      // nodes is to have turned those copies together. Minting at zero for a
      // copy taken OUT of a turned row straightens that one: nothing is
      // superseded there, the old node still stands and still claims the
      // copies left behind, so reading only the covered ones would find
      // nothing to carry and flatten the very part the reader is holding.
      //
      // `touching` AND NOT `covered` is what closes the second: it is every
      // node this gesture's paths meet, whole or in part. Where they
      // genuinely disagree there is no single answer and zero is the honest
      // one; where there were no nodes at all it is the only one, since
      // nobody has said anything about this part yet.
      //
      // A PARTLY COVERED NODE KEEPS ITS OWN as well, and needs nothing here
      // to say so: `trimmed` patches its paths and its name, and this
      // gesture said nothing about the copies it did not take. So a copy
      // taken out of a turned row and the copies left behind come out of it
      // facing the same way, which is the whole point.
      //
      // AND THE OTHER FACE OF IT, ACCEPTED RATHER THAN FIXED: a merge can
      // TURN a copy nobody turned. Drag a turned part and an untouched one
      // as one row and both come out at the turn, because ONE NODE KEEPS
      // ONE TURN FOR ALL ITS PATHS and has nowhere to keep the difference —
      // the same property that makes `pin ×5` one row and one sentence.
      // Splitting the node per path is the model this document does not
      // have, and the alternative inside this one is zero, which straightens
      // the part the reader turned. Between spreading a turn onto a copy
      // that had none and undoing one the reader set by hand, the rule that
      // decides is the one every gesture here has to obey: it cannot undo
      // what it did not touch.
      const carried = touching.map((node) => node[kept]);
      const agreed = carried.length > 0 && carried.every(
        (one) => one.every((value, axis) => value === carried[0][axis]));
      const shared = agreed ? carried[0] : [0, 0, 0];
      // A RETRACTION IS A GESTURE HOME OF SOMETHING THAT SAYS NOTHING ELSE.
      // Drag a part back with a turn standing and the node is kept, its delta
      // simply becoming zero: the part is where the build puts it, still
      // turned, the row still says so, and the `×` is still how the whole
      // statement is undone. Turn a displaced part back square and the same
      // thing happens the other way round. That is the single-covered branch
      // below doing what it always did — one number on the sentence changed,
      // to nothing.
      //
      // ASKED OF `shared` AND NOT OF THE FIELDS THEMSELVES, because `shared`
      // is what the node would actually come out carrying. Ask the fields and
      // a row whose copies were turned to DIFFERENT angles, dragged home,
      // answers "something is turned here" and keeps a node — but the turns
      // disagree, so that node is minted at zero and says nothing at all:
      // `move "pin ×3" by (0, 0, 0)` in the projection, the very line the
      // paragraph above refuses to write, and no panel opening to show the
      // row it left behind (`opened` is off for a flat gesture). The parts
      // going home and straightening is the price of the disagreement and
      // is already decided; a sentence about them is not.
      const retract = flat && shared.every((value) => value === 0);
      // WHAT THIS GESTURE SAYS, ASSEMBLED BY ASSIGNMENT rather than written as
      // a literal with a computed key — and that is not taste.
      // `tests/test_ui_source.py` reads every `[NAME]:` in this file as a key
      // of the handler map and insists it be an event constant imported from
      // events.js, so a computed key here would read as a listener for an
      // event nobody declares.
      const patch = { paths, name };
      patch[said] = values;
      let next = null;
      if (retract) next = without();
      else if (covered.length === 1) {
        next = updateNode(trimmed, covered[0].id, patch);
      } else {
        const minted = { id, role: 'move', ...patch };
        minted[kept] = shared;
        next = addNode(without(), minted);
      }
      // THE PANEL COMES UP WITH THE MOVE, and what that is worth changed
      // under this line rather than going away. It used to be the ONLY thing
      // that said a part was now standing where the build does not put it:
      // the row with the `×` was inside the sheet, so a reader who had it
      // shut was shown the displacement once, here, and closing the sheet
      // took the explanation away again. The branch of the parts tree now
      // holds that row, outlives the sheet, and says it for as long as it is
      // true. What is left is the SHEET's own half — what a proposal is, the
      // buttons that add a body, the kernel's verdict and the door out to a
      // comment — brought up at the moment a reader who never opened it has
      // just made their first statement, both tools being armed from a part's
      // own menu. Kept deliberately, and it is now a convenience rather than
      // the thing that keeps the page honest.
      //
      // NOT FOR A GESTURE HOME, because there is nothing to show: it takes a
      // displacement — or a rotation — AWAY, and a panel that jumps open to
      // announce that would be answering "never mind" with a demand to look.
      // `flat` and not `retract`, so that holds for a part that is still
      // turned, or still displaced — the row it keeps is one the reader
      // already had open, and the gesture left the part LESS out of place
      // than it found it.
      opened = !s.proposalOpen && !flat;
      return opened ? { proposal: next, proposalOpen: true }
                    : { proposal: next };
    }, () => {
      // THE BODIES ARE STAGED ONLY WHERE THE SHEET OPENED, and what that
      // costs has to be stated correctly because the obvious reading is
      // wrong. Staging runs `buildProposal` over every body before it
      // reaches any door — the CSG, 23 ms at four bodies and 81 at twelve,
      // the measurement written out at `field` in `computed` — and
      // `sameParts` in element.js does NOT save it: that guard spares the
      // SCENE being disposed and rebuilt, one layer past the point where the
      // geometry has already been computed. A move node changes no body, so
      // on the `else` side that whole rebuild would buy nothing, which is
      // why there is a branch here at all.
      //
      // THE REASON THE OPENING SIDE STAGES IS NO LONGER THE ORIGINAL ONE.
      // It was that closing the sheet took the bodies OFF the model, so
      // reopening had to put them back; closing stopped doing that when the
      // branch of the tree took over saying what is on the model. What is
      // left is belt and braces — in ordinary use the bodies are already
      // staged, because every edit that put them in the document staged them
      // and nothing has un-staged them since. Kept rather than removed: what
      // an opening pushes at the viewport is a contract several tests are
      // written against, and unpicking it is a change to this page nobody
      // asked for.
      //
      // READ BACK OUT OF STATE AND NOT CARRIED FROM THE UPDATER, because the
      // updater's own result is what this edit WOULD have committed and not
      // necessarily what did: another functional patch can be batched behind
      // it, and the one that matters is `onModel`'s `dropMoves`. Pushing the
      // updater's document at `setMoves` after that would displace a part of
      // the new build by a node the committed document no longer holds —
      // with no row and no `×`, and nothing staging after it to correct the
      // scene. By the time a completion callback runs, `this.state` is the
      // commit.
      //
      // `stageProposal` AND NOT `setProposal` for the same reason the updater
      // exists: the second writes `proposal` as an object patch, and an
      // object patch landing after a swap puts back every node the swap took
      // out. The document is already committed; only the scene is owed
      // anything.
      const done = this.state.proposal || emptyProposal();
      if (opened) this.stageProposal(done);
      else this.proposalMoves(done);
      // AND IT IS SAVED FROM HERE, because this gesture does not go through
      // `setProposal` and that is the only other door the save hangs off.
      // Dragging or turning a part of the build is the reader's own edit — it
      // puts a node in the document and a line in the projection the agent reads —
      // so a page that stored everything BUT this would lose the one kind of
      // node the `published`/`view` stamps exist to bring back, and would
      // lose it silently: the row is on screen, the record does not have it.
      //
      // THE COMMITTED DOCUMENT AND NOT THE UPDATER'S, for the reason the two
      // pushes above take it from here as well — another patch can be batched
      // behind this one, and the one that matters is `onModel`'s `dropMoves`.
      // Saving what this edit WOULD have committed could write a move the
      // committed document no longer holds.
      this.saveProposal(done);
    });
  }

  /**
   * A gesture on a BODY of the proposal: `name` is the body the viewport says
   * the hand was on, `values` the three numbers it produced, and `apply` the
   * document's own door for them — `moveNodes` onto the body's `at` for a drag,
   * `turnNodes` onto its `rot` for a ring.
   *
   * ONE FUNCTION FOR THE TWO, as `recordGesture` above is one for its own pair,
   * and here the shared half is nearly the whole of it: which node the gesture
   * was about, the draft that has to go first, and the one door out. Only the
   * field parts them, and that is the argument the viewport already settled by
   * sending two events.
   */
  editBody(name, values, apply) {
    // THE SAME GESTURE AS THE ONE ABOVE AND THE OPPOSITE MEANING. A part of
    // the build moved or turned is a statement TO the agent and changes
    // nothing; a body of the proposal is the reader's own drawing, so a hand on
    // one is an ordinary edit of the document — the same edit as typing the
    // number into the `at` or `rot` fields, which is why it goes through
    // `setProposal` like every other one and writes no move node. The BRANCH is
    // what says the body is not part of the model — it lists it, with a `×`
    // that deletes it — and it says so whether or not the sheet is open; there
    // is nothing here to put back, because nothing of the build was touched.
    //
    // NOT GUARDED BY `toolsOff` unlike the method above, for the reason the
    // panel itself is not: a proposal names no part of anything, so there is
    // no `/cmp/…` path for it to file, and what it claims is as true over a
    // comparison as over a build.
    if (!Array.isArray(values) || values.length !== 3
        || !values.every(Number.isFinite)) return;
    const doc = this.state.proposal || emptyProposal();
    // ONE BODY ANSWERS, AND IT IS THE ONE UNDER THE CURSOR. The payload the
    // panel builds offers the hand a part per body — every solid its own,
    // every hole its own (proposalgeom.js) — so a gesture is about the single
    // node that part was built from, and the bodies beside it stay where the
    // document put them. That is the point of the hand at all: a proposal is
    // assembled by shifting and turning its pieces against each other.
    //
    // BY NAME, because a name is what the two halves share: the body's name
    // in the document is the part's `name` in the payload, and `freeName`
    // keeps them unique. A name no node answers to changes nothing rather than
    // guessing, which is a gesture that landed while the document was being
    // edited from somewhere else.
    //
    // AMONG THE BODIES ALONE (`bodies`), because a move node carries a name
    // too — a row of the BUILD's, which nobody chose and which is free to be
    // the same word as a body's. Taken in, it would be asked for the `at` or
    // the `rot` it has none of.
    const ids = bodies(doc)
      .filter((node) => node.name === name)
      .map((node) => node.id);
    if (!ids.length) return;
    // AND THE STEP IS RECORDED HERE, on the same rule `recordGesture` states:
    // after every guard, so a gesture that was refused — three numbers that are
    // not numbers, a name no body answers to — leaves nothing on the stack, and
    // before the write, so the entry describes a document the reader was really
    // looking at. `doc` is the one this edit is about to replace and it is not
    // copied: `apply` returns a new document and leaves this one standing.
    //
    // THE DRAFT IS NOT PART OF THE STEP, and that is the same decision the
    // gesture makes about everything else on the page: what Ctrl+Z takes back is
    // the DOCUMENT, and a half-typed field the reader abandoned by grabbing the
    // body is not a state anybody asked to be returned to.
    this.recordStep({ kind: UNDO_DOCUMENT, doc });
    // THE DRAFT GOES FIRST, exactly as `commitProposal` drops it and for the
    // same reason one step further: a field renders from `proposalDraft` while
    // one stands on its key, and this is the first door into `setProposal`
    // that a draft can survive. Every other one is a button, and a real
    // click blurs the field and commits it on the way. A gesture does not: the
    // press is taken in the capture phase (`onDown` calls `preventDefault`),
    // so the focus never leaves. Left standing, the panel would show typed
    // text over a body that has already moved — and the blur that came later
    // would commit that text back over the axis the hand had just written.
    this.setState({ proposalDraft: null });
    // AND `KEEP_STEPS`, because the step this edit is taken back by is the one
    // four lines up. That door drops the document steps behind a write that
    // recorded none, which every ordinary edit of the panel is; this one has
    // just pushed its own, and dropping the rest would cut the stack down to
    // that one step: a second gesture on a body could never be walked back past
    // the first, and the press after would reach whatever visibility step lay
    // under them both — a part un-hiding itself in answer to "take back the
    // other drag".
    this.setProposal(apply(doc, ids, values), KEEP_STEPS);
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
    // THE STEPS BEHIND THE READER GET THE SAME RULE THE LIVE DOCUMENT GETS a few
    // lines below, and OUT HERE rather than in the updater for the reason the
    // paragraph above gives: `this.history` is not state, and an updater React
    // may call twice must stay a pure function of what it is handed.
    //
    // A stored step of the document kind IS a document, so what a build landing
    // does to the one on screen it has to do to every one behind it: the moves
    // in them were measured against the build that has just gone, and a path
    // like `/model/pin(2)` is a number the tessellator hands out afresh — so
    // Ctrl+Z after a rebuild would put back a displacement of whatever answers
    // to that name now. `leaveBuild`'s clear does not cover this: a live rebuild
    // is not a swap, the page stays on the same revision, and the history is
    // deliberately kept across one.
    //
    // THE VISIBILITY STEPS ARE LEFT WHOLE, for the reason the `expanded` line
    // below keeps the reader's collapses: part paths survive a rebuild, so a
    // list of hidden names is as true after one as before.
    //
    // AND A STEP THE PRUNE HAS MADE INTO A NO-OP GOES WITH ITS MOVES. A step
    // that differed from the document only by the moves in it describes, once
    // both sides have lost them, the document already on screen: the chord
    // changes nothing a reader can see and still pays a whole `buildProposal`
    // and a re-staged scene. Left on the stack, those are presses that do
    // nothing — and this is the product's ordinary cycle, the author editing
    // `model.py` while the page rebuilds itself, so a reader who hid two parts
    // and then moved three gets three dead presses and then an un-hide from five
    // minutes ago. There is no button and no counter anywhere to show them why.
    //
    // SERIALISED AND COMPARED AS STRINGS, which is how `saveProposal` already
    // asks whether a document is the one that has already gone (`body ===
    // this._proposalSent`). One notion of equality for this page, rather than a
    // second one invented here for the same question.
    //
    // A STEP THAT STILL DIFFERS STAYS, whatever it differs by — a body the
    // document has since gained, a size since typed, a body the reader has
    // dragged somewhere else. It is a step back to somewhere, which is the only
    // thing being asked.
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
      // viewport clears its own tape and its own offsets on every load, and
      // a measurement left standing here would describe a model that is
      // gone. The MOVES are the same statement in the document's own terms
      // — a delta measured against where one build put one part — so they
      // go with it, and `dropMoves` leaves the bodies exactly as they were:
      // the motor the model has to clear is as true of the build arriving
      // as of the one that left.
      //
      // A RE-STAGE IS THE EXCEPTION, and it is the only one. The viewport
      // composes the proposal panel's body over the SAME document it already
      // had (viewport/element.js, `restage`), so no part moved, no face went
      // anywhere, and the viewport keeps its own halves of these two for
      // exactly that reason. Dropping them here would take the measurement
      // and the drag away on the keystroke that changed a number in an
      // unrelated panel — blocks 6 and 7 cancelled by block 6's own
      // successor.
      ...(d.restage ? null : {
        measure: null, proposal: dropMoves(s.proposal || emptyProposal()),
      }),
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
      // AND THE STORED DOCUMENT IS ADOPTED HERE, in the callback and not in the
      // updater above, because this is the first instant at which both of the
      // things the adoption needs are true: a view has rendered, so `meta` is
      // in, and the `dropMoves` a few lines up has already run. Adopted any
      // earlier, the moves the reader stored against THIS build would be wiped
      // by that very line a moment later — which is what a cold reload used to
      // do to every one of them. `adoptProposal` asks for both rather than
      // trusting that order, since it is also called from the other side.
      //
      // THE FETCH IS NOT MOVED HERE, only the adoption: `loadProposal` still
      // asks the hub where the token arrives, and `adoptProposal` is whichever
      // of the two lands last performing it. ONE SHOT — it spends the record —
      // and the re-stage it causes comes straight back through here.
      this._modelSeen = true;
      this.adoptProposal();
      // The rejoined ids have to reach the viewport, and a state event is the
      // only way there — but every model event needs this one now, rejoin or
      // not: the tree that has just landed is what the comment pins hang on, so
      // a rebuild that renumbered or moved a part moved every pin with it.
      this.sync();
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
   * `authorNote` then looks their catalogue keys up in the NEW build's
   * `meta.parts`, and every row's menu builds its download links on the NEW
   * base. So the tree is cleared here, on the error path, where the failure is
   * known.
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

  /** The ROW a path belongs to — its own, or the one that collapsed it. */
  node(id) {
    const tree = this.state.tree;
    return id && tree ? tree.nodes.get(id) || null : null;
  }

  /**
   * The solids the selection covers, as the viewport wants them.
   *
   * A LIST since issue #75, because a row may stand for five copies of one part
   * and selecting it lights up all five. An ordinary leaf answers with the one
   * path it always did.
   *
   * A GROUP KEEPS ITS OWN ID and is deliberately NOT expanded to its leaves:
   * `selectSolid` has never had anything to say about a node path, so selecting
   * an assembly highlights nothing today, and lighting up every part under it
   * would be a different feature arriving inside this one. `[sel]` where there
   * is no tree yet, which is the same path this sent before.
   *
   * A COPY OF `leaves` AND NOT THE ARRAY ITSELF, because this is the boundary:
   * the list leaves on `hmr:state` and the viewport keeps what it was given
   * (`applied.selected` in element.js). Handing over the node's own array would
   * put the tree's list in another module's hands, and it is the list the eye,
   * the ghost square and Isolate are all expressed in — a sort or a splice over
   * there would silently be an edit to the tree.
   */
  selectedPaths() {
    const node = this.node(this.state.sel);
    if (node && !node.isNode) return node.leaves.slice();
    return this.state.sel ? [this.state.sel] : [];
  }

  // -- comparing two revisions ----------------------------------------------
  //
  // ui-brief block 9, issue #10. The reader ticks two revisions in the picker
  // and presses Compare; the hub measures the geometry and publishes two
  // documents; this page shows the scene in the viewport it already has and the
  // report in the panel where the tree usually is.
  //
  // ONE SCENE AND ONE VIEWPORT, deliberately. A second `<hmr-viewport>` would
  // give the two revisions a window each — which is not what was asked for and
  // would break besides: `hmr:state` goes out on `window` with nothing on it
  // saying which element it is for, so both would answer every patch.

  /**
   * The COMMIT a revision name stands for, or '' where there is none.
   *
   * A COMPARISON IS ALWAYS BETWEEN TWO COMMITS, and this is where the picker's
   * moving names are turned into them. The hub refuses a pointer as an end of a
   * pair (src/app.py, and SPEC 3 says why): an entry in the comparison cache is
   * filed under the names it was asked with, so one filed under `latest` would
   * go on answering for a pair that has moved on. So the ASKING side resolves,
   * and it can: `builds.json` carries `latest` as the commit id it points at.
   *
   * `dev` RESOLVES TO NOTHING, deliberately. The slot has no commit id —
   * `has_dev` is a flag, because the slot has no permanent address — so there
   * is no name to ask with and no answer that would stay true. Every caller
   * reads the '' as "this is not a revision that can be compared".
   */
  commitOf(name) {
    const info = this.state.builds;
    if (name === 'latest') return (info && info.latest) || '';
    if (name === 'dev') return '';
    return name || '';
  }

  /**
   * The pair whose SCENE is on screen, or null — which is the one question
   * `sync` asks to decide which document the viewport is pointed at.
   *
   * IT ANSWERS NULL WHILE THE JOB RUNS. The scene does not exist until the hub
   * has computed it, so pointing the element at it any earlier would take the
   * build off the screen and draw block 11's error panel over a panel that is
   * already saying, in words, what is happening.
   */
  comparePair() {
    const s = this.state;
    return s.compare && s.cmpStage === 'ready' && s.cmpView
      && Array.isArray(s.cmpPair) && s.cmpPair.length === 2 ? s.cmpPair : null;
  }

  /**
   * Every solid the selected report row stands for, in the comparison's tree.
   *
   * BY CATALOGUE KEY AND NOT BY PATH, because the comparison draws one part up
   * to four times — in each revision and in each difference group — and the
   * report has one row for it. Lighting up all four is the answer: the reader
   * asked where this part is, and it is in four places.
   *
   * The key is what makes that lookup possible at all, and it is there because
   * `scene.json` is an ORDINARY view document: the hub refuses a pushed view
   * whose leaf declares no key (`check_view_file`), and `treeFromShapes` carries
   * it onto every leaf row. Nothing is guessed from a name — the tessellator
   * numbers repeats apart, so a name is not an identity (issue #75).
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
   * The one door into the panel: the Compare button, the Try again beside a
   * failure, a view tab pressed while a comparison is up, a link opened cold
   * (`load`) and a `popstate` onto one (`syncCompare`) all come here.
   *
   * The pair AND THE VIEW are snapshotted before anything is fetched, and every
   * step of the fetch checks both are still the ones on screen (`onCompare`).
   * The ticks in the picker and the view tabs go on being the reader's to change
   * while a comparison runs, and an answer that landed against the pair or the
   * view they moved on from would put one comparison's report beside another
   * comparison's scene.
   *
   * BOTH ENDS ARE RESOLVED TO COMMITS HERE, once, because this is the one door:
   * the reader standing on `/project/<pid>/latest/` who compares from there and
   * the address someone typed with a pointer in it both arrive through it, and
   * the hub answers neither `latest` nor `dev` as an end of a pair
   * (`commitOf`). A name that resolves to nothing is not a pair this page can
   * ask about, and the panel is not opened for it — the picker offers no tick
   * on such a row, so the only way here is an address, and the hub 404s that
   * address too.
   */
  compareRevisions(pair) {
    const two = (Array.isArray(pair) ? pair.slice(0, 2) : [])
      .map((name) => this.commitOf(name));
    const view = this.state.view;
    if (two.length !== 2 || !two.every(Boolean) || !view) return;
    // WHERE THE READER IS STANDING, read before the line below moves them off
    // it. A comparison opened on `/project/<pid>/latest/` is addressed as the
    // COMMIT the pointer resolves to (`addressOf`), and standing on a commit is
    // more than an address: `isPointerPage()` goes false with it, so the watch
    // for new builds stops re-arming and the chip stops saying `up to date`.
    // That is the right answer while the comparison is up — the link has to
    // mean this pair tomorrow — and the wrong one after it, so the way out
    // needs to know which page this was entered from (`leaveCompare`).
    //
    // ONLY ON THE WAY IN. Try again, a view tab pressed mid-comparison and a
    // second pair ticked in the picker all arrive here with the panel already
    // open, and re-reading `PAGE` for them would remember the commit this page
    // has already been moved onto — which is the very thing being undone.
    if (!this.state.compare) this._cmpFrom = isPointerPage() ? PAGE.slot : null;
    // AND THE ADDRESS SAYS SO, which is the whole reason the route exists: a
    // comparison is a thing one person sends another, and until this the only
    // way to that URL was to type it. Measured rather than pushed blindly, so
    // that the doors above which arrive with the address already right move
    // nothing — `moveAddress` holds the inventory of them.
    this.moveAddress(two);
    // AND THE OFFER OF A NEWER BUILD IS WITHDRAWN, because it was made about a
    // road this page has just left. `takePending` is the one door that opens
    // another build WITHOUT moving the address — it was written for a pointer
    // page, where `PAGE.base` already means "the newest" — so pressing Switch
    // inside a comparison put the new build's `views` and `buildKey` in state
    // beside the OLD commit's `base`: the view file fetches fine, since the
    // names match, and the old geometry stays on screen under the new build's
    // name with the download links pointing into the old directory. `poll`'s
    // own note describes that failure from the other side.
    //
    // WITHDRAWN AND NOT REFUSED. Nothing here says no to the reader: the offer
    // stopped being true when the page moved onto a commit, and the way out
    // puts them back on the pointer (`leaveCompare`), where the next poll makes
    // it again if it still stands. `bannerGone` is lifted rather than set, for
    // the reason `switchBuild` lifts it: nothing has been offered on this road,
    // so the next build to arrive gets its banner.
    //
    // NO `clearTimeout` HERE, unlike `dismissPending`, and that is a reading of
    // this state rather than an omission. Later leaves the offer standing, so a
    // deferred Switch still has a build to take and must be called off by hand;
    // withdrawing takes the build itself away, and `takePending` returns on an
    // empty `pending` before it touches anything. The one timer that could be in
    // flight therefore fires once into nothing, and a `clearTimeout` beside this
    // would be a line no test could ever see the absence of.
    //
    // AN ANSWER ALREADY ON THE WIRE IS CUT OFF, though, because that one CAN put
    // the offer back: the request went out on the pointer and lands on a page
    // that has moved. `poll` compares the generation after its await — the
    // mechanism `switchBuild` relies on for the same reason — so moving the
    // number here is the whole of it.
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
   * Through `set` and not `setState`, because closing the panel is what tells
   * the viewport to go and fetch the build's own geometry again — the event
   * `set` sends is the whole of that.
   *
   * AND THE ADDRESS COMES BACK TO WHERE THE READER CAME IN.
   * `/project/<pid>/<a>/compare/<b>/` is the page of `<a>` (hub.js,
   * `pageFrom`), so the build now on screen is the one the reader is already
   * standing on and nothing is fetched — but the bar would go on naming a
   * comparison that has been closed, which is a link that reopens a panel the
   * reader shut and, worse, `PAGE` no longer describing the address.
   *
   * WHICH PAGE THAT IS IS NOT ALWAYS `<a>`'s. A comparison opened on a POINTER
   * page is addressed as the commit that pointer resolves to, deliberately
   * (`addressOf`) — and that move takes the reader off the pointer for good:
   * `isPointerPage()` goes false, so `schedulePoll` stops re-arming and the
   * watch for new builds dies, and the chip reads `pinned build`. Answering the
   * way out with `<a>` therefore left somebody who merely opened a comparison
   * and shut it again pinned to a commit, with nothing on the screen saying so.
   * So the way out is the way IN, remembered by `compareRevisions`.
   *
   * THE ADDRESS MOVES BEFORE THE STATE, which the two lines used to do the
   * other way round. `set` is what tells the viewport where to fetch from and
   * what makes the header draw itself again, and both read `PAGE` — so a move
   * afterwards would send one payload and draw one header describing the page
   * being left. Where nothing moves, which is every comparison entered on a
   * build page, the order changes nothing at all.
   */
  leaveCompare() {
    // Spent, and cleared whichever door is taken: `compareRevisions` writes it
    // afresh on every entry, so this is belt and braces rather than the thing
    // that keeps it honest.
    const back = this._cmpFrom;
    this._cmpFrom = null;
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
   * NOT A NAVIGATION AND NOT A SWAP. The build on screen is the one this
   * pointer resolves to — it is the build the reader has been looking at all
   * along — so nothing is fetched and no history entry is laid down: this
   * REPLACES, for the reason `moveAddress` replaces on its way out of a
   * comparison, since closing a panel is not somewhere the reader went.
   *
   * WHAT IT PUTS BACK IS EVERYTHING THAT HANGS OFF `PAGE.slot`, and the poll is
   * the one piece of it that needs saying out loud: `schedulePoll` returns
   * without arming anything on a pinned revision, so the timer that was in
   * flight when the comparison opened fired once and never re-armed. Cleared
   * before the re-arm exactly as `switchBuild` clears it, so a timer that is
   * still pending does not leave two.
   */
  standOnPointer(slot) {
    const to = `/project/${PAGE.pid}/${encodeURIComponent(slot)}/`;
    const views = (this.state.meta && this.state.meta.views) || [];
    history.replaceState({ hmr: slot }, '',
                         to + this.viewQuery(this.state.view, views));
    // IN PLACE, so `PAGE.slot` says what the bar says — which is what the watch
    // below, the chip and every relative fetch on this page are read off.
    rereadPage(to);
    clearTimeout(this._poll);
    this.schedulePoll(POLL_MS);
  }

  /**
   * The address that describes this page: the build, or one comparison of it.
   *
   * A COMPARISON HAS AN ADDRESS ONLY WHERE ITS FIRST END IS THE BUILD ON
   * SCREEN, and the picker hands over pairs where it is not: the ticks are any
   * two rows, so a reader standing on `<a>` can compare `<b>` against `<c>`.
   * `/project/<pid>/<b>/compare/<c>/` is the page of `<b>` — whose meta.json,
   * downloads, picker and comment queue this page is not showing — so writing
   * it here would move the address onto a build the page never opened, and the
   * next `PAGE.base` fetch would go there. That comparison simply has no link,
   * and the answer for it is the build's own address.
   *
   * "THE BUILD ON SCREEN" IS ASKED AS A COMMIT, which is what keeps the link
   * working on the page most readers are standing on. `/project/<pid>/latest/`
   * shows one particular commit, and a pair is two commits, so the pointer's
   * own name never appears in a pair and a literal comparison of slots would
   * find no match. Resolved, it matches — and the address written is the
   * COMMIT's: `/project/<pid>/<commit of latest>/compare/<b>/`. The page then
   * stands on that commit, which is the build it was already showing under its
   * permanent name, so meta.json, the downloads, the picker's current row and
   * the comment rail all go on describing the same thing. It is also the only
   * link that can be SENT: `/latest/compare/<b>/` is refused by the hub, and it
   * would name a different pair the day the pointer moves.
   *
   * TWO MORE THINGS FOLLOW THE ADDRESS ONTO THE COMMIT, and they are the two
   * that do NOT go on describing the same thing — the list above read as
   * exhaustive and was short by them. `isPointerPage()` is false on a commit,
   * so `schedulePoll` arms nothing and the WATCH FOR NEW BUILDS is over, and
   * the header CHIP flips from `up to date` to `pinned build`. Both are honest
   * about where the page now stands and neither is wanted a moment longer than
   * the comparison: the way out puts the reader back on the pointer they came
   * in on (`leaveCompare`), which is what makes this move borrowed rather than
   * permanent.
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
   * PUSH INTO A COMPARISON AND REPLACE OUT OF ONE, and the asymmetry is the
   * reader's own gesture. Opening one IS somewhere they navigated to — Back
   * should take them out of it, and `popstate` is what then does (`syncCompare`)
   * — while closing one leaves nowhere: the build was already on screen, so what
   * has to move is the entry they are standing on. A push there would leave a
   * Back that goes to a comparison the reader had just shut.
   *
   * MEASURED AGAINST THE BAR AND NOT AGAINST WHO CALLED, the reading
   * `switchBuild` writes out where it repairs a cancelled swap. Four callers
   * reach this with the address already correct — a link opened cold, Try again,
   * a view tab pressed mid-comparison, and `popstate` itself — and an entry
   * pushed for any of them would be a Back that goes nowhere the reader has
   * been. A flag saying "this one is a real gesture" would be a second copy of
   * something the address already answers.
   *
   * THE VIEW QUERY IS THE PAGE'S OWN, `viewQuery`: the same '' for the build's
   * first view that every other address this page writes carries, so the
   * comparison of a default view is a link with nothing after the path.
   *
   * THE ENTRY IS READ OFF THE ADDRESS BEING WRITTEN and not off `PAGE`, because
   * on a pointer page the two differ: the bar is about to say the commit while
   * `PAGE` still says `latest`. Nothing reads this field today, and that is
   * exactly why it must not be left saying something false.
   */
  moveAddress(pair) {
    const to = this.addressOf(pair);
    if (location.pathname === to) return;
    const views = (this.state.meta && this.state.meta.views) || [];
    const address = to + this.viewQuery(this.state.view, views);
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
   * THE OTHER HALF OF PUSHING ONE. Entries a reader can walk back through exist
   * only because `compareRevisions` writes them, so this page has to answer for
   * them: Back out of a comparison closes it, Back into one opens it. Nothing
   * else would — a `popstate` is not a load, and `load()` is where a comparison
   * address is read on arrival.
   *
   * ONLY WHERE THE PAGE IS REALLY ON THAT BUILD. A swap that failed leaves the
   * reader on the build they were on (`swapFailed`) under an address naming the
   * one that would not open, and a comparison entered against a build nobody is
   * looking at would be a panel about neither.
   *
   * IDEMPOTENT, which is what lets `_pop` call it after every entry rather than
   * only after the ones that changed the mode: both doors measure the bar before
   * they write it, so a Back that moved only the BUILD asks them for nothing.
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
    // AND OF ONE VIEW, which is the other half of what an entry names: a
    // comparison is computed and cached per view (hub.js), so the same pair on
    // another view is a DIFFERENT comparison and not the same one seen
    // differently. `s.view` is what the entry asked for by the time this runs —
    // both roads through `switchBuild` put the entry's `?v=` there, the one that
    // opens another build and the one that only calls a swap off — so an
    // agreement measured against it is an agreement with the address.
    //
    // WITHOUT THIS THE CANCELLING BRANCH COULD LEAVE THE TWO APART: it writes
    // the view bare, deliberately, because going through `showView` while a
    // comparison is up restarts one and writes an address, which a `popstate`
    // may not do. That leaves the tab strip lit for one view and the scene built
    // for another until somebody presses something, and the pair alone cannot
    // see it. Restarting here costs no entry: the address is already the one
    // being agreed with, and `moveAddress` measures the bar.
    if (pair && pair[0] === two[0] && pair[1] === two[1]
        && s.cmpView === s.view) return;
    this.compareRevisions(two);
  }

  /**
   * Get one comparison in front of the reader: ask, queue, wait, show.
   *
   * THE REPORT IS ASKED FOR FIRST and the job is what a 404 means. A pair
   * somebody has already looked at is two fetches and no queue; a pair nobody
   * has is a POST and a wait. Asking the other way round — queue first, always —
   * would spend a CAD process on an answer that is already on the volume.
   *
   * NO TOKEN IS NOT A FAILURE. Both documents are behind EDIT_TOKEN, so a reader
   * who has none cannot be shown a comparison at all — and the panel says which
   * of the two it is rather than throwing them the 401 the hub would send.
   */
  async runCompare(pair, view) {
    const [a, b] = pair;
    const token = this.state.token;
    if (!token) { this.setState({ cmpStage: 'locked' }); return; }
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
      });
    }
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
   * THE DEADLINE IS THE POINT OF THE LOOP, not the polling. A job the hub lost —
   * a worker killed, a restart that failed it after this page had stopped
   * counting — leaves a state that never becomes terminal, and a wait with no
   * end is a panel that says `measuring` until somebody reloads.
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
   * A TIMER PER WAIT, and that is the whole of this. One field held one timer,
   * so a second `awaitJob` — a view tab pressed while the first comparison was
   * still queued, a Try again — cancelled the first one's timeout and left that
   * chain awaiting a promise nothing would ever settle: it hung, holding its
   * fetch loop open, until the page went. Each wait now owns its timer and
   * forgets it on the way out, and the set is what `componentWillUnmount`
   * empties — a wait that outlived the page would wake up and ask the hub about
   * a job nobody is waiting for.
   *
   * The displaced chain is NOT abandoned: it wakes at its own deadline and
   * stops one line later, at the `onCompare` check that says the reader has
   * moved on.
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
    // WHERE THE QUEUE HANGS ON THE BUILD ON SCREEN. `anchorFor` reads the stored
    // coordinate only on the build it was taken on; on any other one it follows
    // the catalogue key to the row that draws the part, and `partPoint` asks the
    // viewport where that row ended up after the rebuild moved it. The other
    // three answers — the part is in this catalogue but not in this view, the
    // key names nothing any more, the record predates the field — draw no pin at
    // all: the rail says those in words, and a pin put somewhere plausible would
    // be this page guessing.
    const el = this.el();
    const at = {
      commit: (meta && meta.commit) || null,
      published: (meta && meta.published) || null,
      view: s.view,
      keyRows: rowsByKey(s.tree),
      parts: (meta && meta.parts) || {},
    };
    const pins = [];
    s.feed.forEach((record, i) => {
      const anchor = anchorFor(record, at);
      let p = null;
      if (anchor.state === 'point') p = anchor.point;
      if (anchor.state === 'part' && el && typeof el.partPoint === 'function') {
        p = el.partPoint(anchor.path);
      }
      // The label is the row's place in the queue, so the number over the model
      // and the number in the rail are the same number.
      if (p) {
        pins.push({ id: record.id, label: String(i + 1), p,
                    resolved: record.status === 'resolved',
                    active: s.activePin === record.id });
      }
    });
    if (s.composer && s.composer.p) {
      pins.push({ id: 'draft', label: '+', p: s.composer.p, active: true });
    }
    // WHICH DOCUMENT THE VIEWPORT IS POINTED AT, and it is the whole of what
    // comparing changes down here. A comparison is an ordinary view document at
    // an address of its own (hub.js), so the element's load path does not learn
    // a thing: it is handed another base, a `views` list of one, and the token
    // that address wants. Everything below this block is the same either way.
    //
    // THE THREE TABS ARE `hidden` AND NOT A MODE. Overlay, A-only and B-only are
    // a list of group ids each (`diffHidden`), matched by prefix exactly as a
    // hidden part is — so the
    // reader's own hidden list is what they replace rather than something they
    // are merged with: those ids name solids of the BUILD's tree, which is not
    // the tree on screen, and carrying them into a comparison would be a list of
    // instructions about parts nobody can see. They come back the moment the
    // panel is closed, because nothing here writes to `s.hidden`.
    const pair = this.comparePair();
    // ONE ENTRY, AND `view` IS ITS OWN ID rather than a second spelling of it:
    // the element picks the entry it fetches by matching the two, and a view tab
    // has to move BOTH — the id is what makes the load a reload with a fresh fit
    // rather than a live swap under the old camera (hub.js, `compareView`).
    const only = pair ? compareView(s.cmpView) : null;
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
      view: s.view,
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
    window.dispatchEvent(new CustomEvent(STATE, {
      detail: {
        ...scene,
        cut: s.secOn, cutOffset: s.secOff, cutFlip: s.secFlip, cutHatch: s.hatch,
        tool: s.tool,
        diffShow: s.diffShow, pins,
        ...(extra || {}),
      },
    }));
  }

  set(patch, extra) { this.setState(patch, () => this.sync(extra)); }

  /**
   * The READER changing which parts they can see — the one door for it, and the
   * only thing that writes `hidden` or `ghost` outside a build arriving.
   *
   * IT EXISTS TO KEEP THE CARRY HONEST, and a plain `set` is exactly what it
   * replaces at six call sites: the eye, the ghost square, Isolate, Hide,
   * Translucent and "show all parts". `this.carry` is a SNAPSHOT of those two
   * lists as NAMES, taken when another build opens (`leaveBuild`) and spent by
   * the model event that lands it (`rejoin`). Between those two moments the
   * reader can still change them, and a snapshot that does not know about the
   * change is about to be applied to the build that arrives.
   *
   * THE WINDOW IS LONG AND THE TREE IN IT IS THE OLD ONE. `leaveBuild` runs
   * AFTER meta.json has answered, so the window is not the fetch — it is the
   * geometry download and the render, the slowest part of a swap. All of it is
   * spent with the LEAVING build's tree still on screen (deliberately: clearing
   * it would blink the panel empty), and its rows are live. So a click in that
   * window writes an id of the OLD tree into `hidden`, and it is the snapshot,
   * taken in names, that is the only thing able to carry it across.
   *
   * WHICH IS WHY THE SNAPSHOT IS RECOMPUTED AND NOT DROPPED. Dropping it —
   * which this method did for one round — leaves `rejoin` with nothing, so the
   * old id survives as an id and lands on the NEW tree, where the same path can
   * belong to a different part: measured on a build where `/model/plate` came
   * back as `post`, the reader hid one part and a different one disappeared.
   * That is strictly worse than the defect it was meant to fix, and it is the
   * one this file's own note about `takePending` calls unacceptable.
   *
   * AND IT IS RECOMPUTED ONLY IF ONE WAS STANDING. A snapshot written here on
   * an ordinary page would be a carry with no swap behind it, and the next
   * model event of any kind — a live reload, a view tab — would spend it,
   * re-seating names nobody asked to have moved.
   *
   * `null` where there is NO TREE, because there is then nothing to read the
   * names off: that is the `onViewError` state, where the reader's gesture is
   * all there is and the stale snapshot must not outlive it.
   *
   * Hiding those buttons when the tree is gone would be reasonable on its own
   * and is not a substitute: a button nobody can press does not make a stale
   * snapshot fresh, and the tree comes back — on a Retry that works — with the
   * snapshot still standing.
   *
   * IT IS ALSO WHERE THE STEP IS RECORDED, and being the one door is exactly
   * what makes that possible: a patch through here carries `hidden` and `ghost`
   * and nothing else — issue #83 took the last field that was not one of the two
   * off Isolate — so the pair read before the write is a COMPLETE description of
   * where the reader stood, and going back to it needs nothing else remembered.
   * `record` is false for the one caller that is going back; see `undoStep`.
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
   * ONE PUSHER FOR THREE CALLERS — the visibility door and the two gestures that
   * edit the document — because the cap is a rule about the STACK rather than
   * about any one of the things that grow it, and three copies of `push` next to
   * `shift` are three places for the pair to drift apart. `UNDO_DEPTH` carries
   * which end goes and why.
   */
  recordStep(entry) {
    this.history.push(entry);
    if (this.history.length > UNDO_DEPTH) this.history.shift();
  }

  /**
   * Take back the last thing the reader did, whichever kind of thing it was.
   *
   * ONE STACK, ONE ORDER, TWO KINDS. A visibility step is the eye, the ghost
   * square, Isolate, Hide, Translucent or "show all parts"; a document step is a
   * part of the build dragged or turned, or a body of the proposal dragged or
   * turned. They interleave in the order they were made, because that is what a
   * reader means by the chord — the last thing they did, whatever it was.
   *
   * A VISIBILITY STEP GOES BACK THROUGH `setVisibility` AND NOT THROUGH
   * `setState`, because everything that door does besides writing the two lists
   * has to happen for a step BACK as well: an undo pressed while another build is
   * on the wire must re-seat the swap's snapshot exactly as the click it undoes
   * would have, or `rejoin` lands the state the reader has just left on the
   * arriving build.
   *
   * AND WITHOUT RECORDING ONE, which is the whole of that third argument. An undo
   * that pushed its own before-state would push the state it is leaving, so the
   * next press would come straight back to it: two entries trading places for
   * ever, and a stack that never empties.
   *
   * A DOCUMENT STEP GOES BACK THROUGH `setProposal`, THE DOOR THE EDIT ITSELF
   * CAME THROUGH, because an undo IS an edit and not a private rewind. That door
   * puts the bodies back over the model, pushes the moves at the viewport — which
   * is how the dragged part actually returns to where the document now says it
   * is — and writes the result to the hub. A page that took the drag back on
   * screen and left the hub holding it would hand the agent a statement the
   * reader had withdrawn, and would hand it back to this very page on the next
   * reload.
   *
   * IT RECORDS NOTHING EITHER, and needs no flag to say so: the two writers that
   * record are the gestures, and `setProposal` is not one of them. So walking the
   * stack out empties it, exactly as the other kind does.
   *
   * AND IT SAYS `KEEP_STEPS`, which is the one thing it does have to state. That
   * door drops the document steps behind a write that recorded none, because
   * most of what comes through it is exactly such a write; an undo is the
   * opposite — it is SPENDING a step it has already popped, and what is left
   * under that step describes edits it has not reached yet. Dropped, one press
   * would empty the stack of its own kind and every press after it would find
   * nothing.
   *
   * AN EMPTY STACK DOES NOTHING, and that is the entire feedback story here.
   * There is no redo, no toast and no button: the scene and the tree panel
   * changing IS how a reader sees that a step was taken, and a page with nothing
   * left to take back has nothing to say about it.
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
   * The document the panel now holds, and the body that follows from it.
   *
   * THE ONE DOOR. Every edit in the panel — a digit, a role flipped, a body
   * deleted, a body renamed — comes through here, so there is no arrangement in
   * which the numbers in the panel and the shape over the model describe
   * different things.
   *
   * ONE CALLER IS NOT AN EDIT MADE IN THE PANEL AND COMES THROUGH HERE ANYWAY:
   * `undoStep`, taking back a gesture made in the SCENE — a part of the build
   * dragged or turned, a body of the proposal dragged or turned. It uses the
   * door because an undo needs BOTH halves of it. The scene: the bodies go back
   * over the model and the moves are pushed at the viewport, which is how the
   * part actually walks back to where the document now says it is. And the hub:
   * a page that took the drag off the screen and left the record holding it
   * would hand the agent a statement the reader had withdrawn, and hand it back
   * to this very page on the next reload.
   *
   * TWO OTHER THINGS WRITE `state.proposal`, AND NEITHER IS AN EDIT OF THE
   * PANEL — the inventory is worth having complete, because each of them skips
   * a different half of this method and says why.
   *
   * The `hmr:moved` handler records a part of the BUILD dragged. It writes the
   * field through a functional updater and never through here, because
   * `onModel` patches the same field functionally and one object patch landing
   * after a swap would put back every node the swap took out. What it does reach
   * for is the half below: `stageProposal` where the drag OPENED the panel, so
   * the bodies go back over the model, and `proposalMoves` alone where the panel
   * already stood open, because a move changes no body's geometry.
   *
   * `onModel` drops the moves (`dropMoves`) when a build lands that is not the
   * one they were measured against. It writes the field directly and stages
   * nothing, because the viewport has just cleared its own offsets and rebuilt
   * the scene — there is no disagreement left for a push to settle.
   *
   * A DOCUMENT THAT WILL NOT BUILD LEAVES THE LAST GOOD BODY WHERE IT IS, and
   * that is the whole reason this is not two lines. The commonest way to reach
   * one is halfway through saying something — an extrusion committed with two
   * points of its profile typed, which the kernel refuses as no polygon at all —
   * and blanking the model at that moment would make the body flash away and
   * back on the way to a shape that is perfectly fine. The kernel's own sentence
   * goes in the panel instead, where the reader is already looking, and the
   * shape on screen stays the last one that meant something.
   *
   * NOTHING TO DRAW IS NOT AN ERROR: a document with no bodies in it — a panel
   * just opened, the last body deleted — builds a payload with no parts in it,
   * and an empty overlay in the tree is worse than no overlay at all.
   *
   * AND IT IS WHERE THE DOCUMENT IS WRITTEN TO THE HUB, which is nearly the
   * whole story and not quite all of it. Debounced and guarded — `saveProposal`
   * carries the argument — and every edit made in the PANEL comes through here,
   * so none of them can slip past.
   *
   * THE ONE EDIT THAT DOES NOT IS THE `hmr:moved` GESTURE, and it calls
   * `saveProposal` itself from its own completion callback. It has to write
   * `state.proposal` with a functional updater rather than through this door —
   * the reason is at the handler, and it is about a patch landing after a swap —
   * but it IS an edit the reader made: dragging a part of the build puts a node
   * in the document and a line in the projection an agent reads. `onModel`'s
   * `dropMoves` is the other writer and is not an edit at all; it takes nodes
   * away because the build they described has gone, and saves nothing.
   *
   * AND IT IS WHERE THE DOCUMENT STEPS ARE INVALIDATED, which follows from the
   * first paragraph rather than being a second feature: every edit that records
   * no step comes through here, and a document step holds the WHOLE document, so
   * a step left behind one of them takes back an edit it never described.
   * `DROP_STEPS` and `KEEP_STEPS` are the argument, and the constants carry the
   * whole of the reasoning — including why dropping is what a caller that says
   * nothing gets.
   */
  setProposal(doc, steps = DROP_STEPS) {
    // FIRST, so that nothing the write below reaches — `stageProposal` pushes at
    // the viewport, `saveProposal` arms a post — can observe a stack still
    // standing behind a document that has gone. Nothing reads it today; the
    // order is what keeps that from being a thing to re-check.
    if (steps !== KEEP_STEPS && doc !== this.state.proposal) {
      this.history = this.history.filter((step) => step.kind !== UNDO_DOCUMENT);
    }
    this.setState({ proposal: doc, ...this.selectionAfter(doc) });
    this.stageProposal(doc);
    this.saveProposal(doc);
  }

  /**
   * A tick toggled — the one edit to the document that is ABOUT SENDING, and
   * therefore the one that reaches into a draft already carrying the projection.
   *
   * THE ATTACHMENT IS A SNAPSHOT, AND STAYS ONE FOR EVERYTHING ELSE. `proposalAdd`
   * takes the text at the moment the link is pressed, deliberately: a size the
   * reader goes on adjusting afterwards is simply a later number, and a draft
   * that rewrote itself under the cursor would be a worse answer than a stale
   * one. A TICK IS NOT A LATER NUMBER. It says "this must not be sent", and a
   * draft that carries the node anyway is the control doing the opposite of what
   * it is labelled — reachable in two clicks, since the branch and the composer
   * are on screen together.
   *
   * AND THE WHOLE ATTACHMENT GOES WHERE NOTHING SURVIVES, rather than a block
   * with a heading and no statements under it. That is the same answer the
   * revision swap already gives through the same predicate, so the two paths that
   * can rewrite an attachment agree about the empty case.
   *
   * READ BEFORE `setProposal`'s UPDATE LANDS, which is safe because it is the
   * composer that is read and `setProposal` does not touch it — the document is
   * taken from the argument, not from the state.
   *
   * `attached` AND NOT `proposal`, which is what makes the tick a ROUND TRIP rather
   * than a one-way door — the master's own note promises that pressing it twice
   * gets you back where you were, and on a one-node document the first press
   * takes the whole attachment off. Asked of `proposal`, this saw a draft with
   * nothing attached and returned: the second press put the node back in the
   * document and never in the draft, and the only way to re-attach was
   * `proposalAdd`, which builds a WHOLE NEW composer and takes the reader's
   * typed comment, photo and measurement chip with it.
   *
   * So the two questions are separated: `attached` is "this draft is one a
   * proposal was attached to", written once by `proposalAdd` and cleared only by the
   * reader taking the chip off by hand, while `proposal` is "and here is the
   * text, as of now" — which the ticks are free to empty and fill again.
   */
  skipProposal(doc) {
    const draft = this.state.composer;
    this.setProposal(doc);
    if (!draft || !draft.attached) return;
    this.setState({
      composer: {
        ...draft,
        proposal: sendsNothing(doc) ? null : proposalText(doc),
      },
    });
  }

  /**
   * The selection, moved onto a body's NEW SPELLING — or nothing to move.
   *
   * WHY IT HAS TO MOVE AT ALL. A body's row in the proposal's branch is selected
   * by its path in the SCENE, `<overlay group>/<name>`, because that is what
   * makes clicking the row and clicking the body on the model the same act. The
   * name is IN that path — so committing a new one leaves `sel` pointing at a
   * spelling nothing answers to, the row stops reading as selected, and the
   * field block the reader is typing in shuts under them. Every other field on
   * that row commits and stays; this one has to as well.
   *
   * HERE AND NOT INSIDE THE NAME FIELD'S `commit`, which is where it first looks
   * like it belongs. `field` in `computed()` states a contract — `commit` turns
   * the raw text into the whole NEXT DOCUMENT, and there is no partial write
   * anywhere in the panel — and roughly twenty fields are built from it. A
   * `setState` inside one of them makes that promise false for all of them, and
   * a reader checking whether a commit is pure would have to open every call
   * site. This method is the one place the next document meets the one it
   * replaces, which is exactly the comparison the question needs.
   *
   * BY NODE ID AND NOT BY NAME, because the name is the thing that changed: the
   * node that used to answer to `overlayBody(sel)` is found in the document
   * being REPLACED, looked up again by id in the one replacing it, and only then
   * compared. So a rename moves the selection whichever door it came through —
   * including `freeName` numbering a typed name that was already taken
   * (`korpus` -> `korpus2`), which is the case a reader is least expecting.
   *
   * THE PATH IS PATCHED AND NOT REBUILT, since only its last segment is a name.
   * The group's own spelling is the viewport's to mint (`overlayAt` in
   * viewport/element.js) and is already standing in `sel`; asking for it again
   * would be this side deriving a string it is holding.
   *
   * A MOVE NODE IS NOT ONE OF THESE and needs no clause saying so: its row is
   * selected by the path of the BUILD part it displaces, which no rename of the
   * node's own label touches. `overlayBody` answers null for such a path anyway,
   * since it is not an overlay path at all.
   *
   * AND THE SCENE FOLLOWS WITHOUT A `sync` FROM HERE, which is why `setProposal`
   * goes on writing with `setState`. The commit re-stages, the re-stage clears
   * `applied.selected` and emits a model event, and `onModel` ends in `sync()` —
   * by which time the tree holds the new path, so `selectedPaths()` resolves it
   * and the highlight lands on the body under its new name. Pushing from here
   * instead would send a path the scene has not been built with yet.
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
   * The half of the door above that touches the SCENE, given a document that is
   * already the page's.
   *
   * SPLIT OUT FOR ONE CALLER, and it is worth saying which and why rather than
   * leaving it looking like tidiness. The `hmr:moved` handler writes its
   * document inside a functional updater — it has to, because `onModel` patches
   * the same field functionally and an object patch would overwrite a swap it
   * never saw — and then has to stage the bodies, which only the panel OPENING
   * needs. Reaching `setProposal` for that would write `proposal` a second time
   * as an object patch, which is the very thing the updater exists to avoid: a
   * `dropMoves` batched in between commits, and the second write puts the
   * dropped nodes straight back. So the staging is available on its own, and the
   * document it is handed is the COMMITTED one read back out of state.
   *
   * `proposalError` IS STILL WRITTEN HERE, and that is not the same hazard: it
   * is derived from the document rather than being one, nothing merges into it,
   * and the last writer is right by construction.
   */
  stageProposal(doc) {
    let parts = null;
    let error = null;
    try {
      parts = buildProposal(doc).parts;
    } catch (failure) {
      error = String((failure && failure.message) || failure);
    }
    // AND THE SHEET COMES UP TO SAY SO, because it is the only thing on the page
    // that says anything. `proposalSays` is drawn inside the panel, while the
    // FIELDS moved out into the branch of the tree and the branch now outlives
    // the panel being shut — which is the state the whole move was made for. So
    // a reader typing a profile with the sheet closed got a refusal that changed
    // nothing on the model and printed nothing anywhere: the same muteness this
    // file calls a defect a few hundred lines down ("nothing opened, nothing was
    // said"). Opening on a refusal and not on every stage, so the sheet a reader
    // deliberately shut stays shut while they are simply working.
    //
    // AND NOT AT ALL FOR A READER WITH NO TOKEN, which is a gate standing right
    // beside this one that the first version of this line walked straight past.
    // Giving up the token shuts the sheet and takes the button that reopens it
    // away, and `tokenClear` calls a sheet left standing there a defect in so
    // many words — while the branch now outlives that door too, and every
    // control in it comes back through here. So a reader who had a refused
    // document when they handed the token in, and then pressed anything at all,
    // was given a sheet of editing buttons with no way to put it away. The
    // verdict is for whoever can act on it.
    this.setState({
      proposalError: error,
      ...(error && !this.state.proposalOpen && !this.viewer()
        ? { proposalOpen: true } : null),
    });
    // THE OFFSETS ARE SETTLED BEFORE ANY RE-STAGE READS THEM, and that holds
    // whichever order these two lines are written in rather than because of it:
    // this push is synchronous, while `setOverlay` re-stages behind an `await`
    // (`show` in viewport/element.js waits on the library before it touches the
    // scene), so the map is already the one this document describes by the time
    // `restageMoves` re-applies it onto the groups the re-stage built.
    this.proposalMoves(doc);
    // ON THE PARTS AND NOT ON THE NODES, which is what a document holding
    // nothing but moves made into a distinction: it has nodes and builds no
    // geometry at all, and an empty overlay in the tree is worse than no overlay
    // — the same answer this line always gave for a document with nothing in it.
    //
    // A DOCUMENT THE KERNEL REFUSED LEAVES THE LAST GOOD BODY STANDING, which is
    // what `parts` being null means here and is deliberate: a reader half way
    // through typing a profile should not have the model blink out from under
    // them at every intermediate value.
    //
    // UNLESS THE EYE IS SHUT, and that clause is the whole of what this line got
    // wrong. `toggleProposalEye` has no other road to the scene, so on a refused
    // document the eye went closed, the displaced parts went home — that push is
    // unconditional — and the bodies stayed over the model: a control drawn off
    // while the thing it names is still there. "Leave what is good" and "take it
    // all away" are answers to different questions, and the second one wins,
    // because it was asked out loud.
    if (parts || this.state.proposalOff) {
      this.proposalOverlay(parts && parts.length ? parts : null);
    }
  }

  /**
   * The parts of the BUILD the document says are displaced, handed to the
   * viewport. A REF CALL for the reason `proposalOverlay` below is one.
   *
   * THE WHOLE SET EVERY TIME, because that is what the door on the other side
   * takes (`setMoves` in viewport/element.js): a part goes home by having its
   * node DELETED, so a push has to be able to say what is no longer moved as
   * well as what is.
   *
   * ONLY THE THREE FIELDS THE SCENE CAN ACT ON. The rest of a move node — its
   * id, its role, the row name the projection prints — is the document's own
   * business, and the viewport has no tree to check a name against anyway.
   *
   * AND NOTHING AT ALL WHILE THE BRANCH'S EYE IS SHUT (`proposalOff`), which is
   * `dropMoves` spent on the push rather than on the document: the whole set is
   * what this door takes, so a set with no moves in it is exactly the sentence
   * "nothing is displaced" and `reconcileMoves` sends every part home. THE
   * DOCUMENT IS NOT TOUCHED — the nodes are still there, still drawn, still in
   * the projection — so opening the eye pushes them again and the parts go
   * straight back out. Read here and in `proposalOverlay` because those are the
   * two doors to the viewport; every caller of either is covered by that,
   * including the `hmr:moved` handler, which reaches this one on its own.
   */
  proposalMoves(doc) {
    const el = this.el();
    if (!el || typeof el.setMoves !== 'function') return;
    const shown = this.state.proposalOff ? dropMoves(doc) : doc;
    try {
      el.setMoves(moves(shown).map((node) => ({
        paths: node.paths, delta: node.delta, turn: node.turn,
      })));
    } catch (error) {
      console.error('proposal moves', error);
    }
  }

  /**
   * The viewport's second source of parts: a list to lay over the model, or
   * `null` to take it off.
   *
   * A REF CALL and not an event, like `snapshot()` and `getCamera()` beside it:
   * this answers to a person typing in a field, which is a gesture rather than a
   * state this side holds a second copy of. The element remembers what it was
   * given, so a rebuild landing under an open panel puts the body back by
   * itself — see `setOverlay` in viewport/element.js.
   *
   * THE BRANCH'S EYE IS READ HERE AND NOT AT THE CALLER (`proposalOff`), which
   * is the other half of the rule `proposalMoves` states: these two are the
   * doors to the viewport, so a flag read at both of them covers every way the
   * proposal can reach the scene. Shut, the parts offered are dropped and the
   * overlay comes off; the document and the branch are untouched, and the next
   * push with the eye open lays the same bodies back down.
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
   * Open the sheet of controls, or shut it. THE MODEL IS NOT TOUCHED EITHER WAY.
   *
   * CLOSING USED TO CLEAR THE OVERLAY, and the argument for it was that the
   * panel was the only thing on screen saying the body is not part of the model
   * — no chip for it, because the panel it came out of was standing right there
   * — so a closed panel with a body still over the model would be this page
   * showing a shape nothing accounts for. THAT PREMISE IS GONE: the document is
   * drawn as a branch of the tree now, a row per node with an eye, a colour and
   * a `×` on it, and the branch stays on screen with the sheet shut
   * (`proposalTreeStyle`). The bodies ARE accounted for, by the branch.
   *
   * IT WAS ALSO HALF A RULE, which is what made it a defect rather than a
   * preference. Closing took the BODIES off and left every displaced part of the
   * build exactly where the reader had dragged it — while hiding the branch that
   * held those parts' rows. A part standing somewhere the model does not put it,
   * with nothing on screen saying why and no `×` to put it back.
   *
   * WHAT DECIDES WHETHER THE PROPOSAL IS ON THE MODEL IS THE BRANCH'S EYE now
   * (`toggleProposalEye`), and it decides it for both halves at once. One
   * control, one meaning; this one is a sheet of controls opening and shutting.
   *
   * OPENING STILL RE-STAGES, and what that costs is worth stating correctly
   * rather than waving at `sameParts`. The stage runs `buildProposal` over every
   * body before it reaches any door — the CSG, 23 ms at four bodies and 81 at
   * twelve — and `sameParts` in element.js does NOT save that: it spares the
   * scene being disposed and rebuilt, one layer past the point where the
   * geometry has already been computed. So opening the sheet over a document
   * with bodies in it pays for a rebuild of geometry that is already on screen.
   *
   * IT IS KEPT ANYWAY, and deliberately, because taking it out is a change to
   * this page's behaviour that nobody asked for and the suite has five separate
   * assertions resting on: what an opening pushes at the viewport is a contract
   * other things are written against. The honest note is that the cost is real
   * and the call is now a belt-and-braces one; the drag path next door, which
   * paid the same price on every gesture, is where it was actually worth
   * removing (see the `hmr:moved` handler).
   *
   * AND IT HANDS THE DOCUMENT BACK BY IDENTITY, which is now load-bearing rather
   * than incidental. The door drops the document steps for every write that
   * records none, and this one writes nothing new — it re-stages. Rebuild the
   * argument here (a spread, a clone, anything) and opening the sheet silently
   * takes the chord away from the drag the reader made just before it.
   */
  toggleProposal() {
    const open = !this.state.proposalOpen;
    this.setState({
      proposalOpen: open, proposalDraft: null, menu: null, revOpen: false,
      dlOpen: false,
    });
    if (open) this.setProposal(this.state.proposal);
  }

  /**
   * The branch's own eye: the whole proposal off the model, or back on it.
   *
   * ONE BOOLEAN AND NOT A NODE'S BUSINESS. What it answers is "is any of this on
   * the model right now" — every body unstaged AND every displaced part of the
   * build back where the build puts it — which is a question about the proposal
   * as a whole and has no per-node spelling: a move is not in `s.hidden` and
   * could not be, since the part it displaces has a row and an eye of its own in
   * the parts tree. The per-body eyes go on working exactly as they do, because
   * they are the scene's and this is not.
   *
   * NOTHING IS WRITTEN TO THE DOCUMENT. It is display state — the branch stays
   * drawn, every row keeps its numbers, the projection still says what it said —
   * so the moment the eye opens again everything comes back with no edit to
   * undo. That is also why the branch cannot be taken off screen with it: the
   * eye is what reopens it.
   *
   * "COMES BACK" IS ON THE NEXT STAGE THAT BUILDS, and on a document the kernel
   * has refused there is nothing to bring: `stageProposal` has no parts to hand
   * over, so opening the eye over one leaves the model empty until the numbers
   * are good again. The same asymmetry that file's own note argues — shutting
   * the eye takes everything off whatever the document says, because that was
   * asked for out loud, while opening it can only offer what the kernel builds.
   *
   * THROUGH THE CALLBACK, because the two doors read the flag off `this.state`
   * and `setState` has not landed by the time this method returns. `stageProposal`
   * and not `setProposal`: the document is not changing, so there is no selection
   * to move and no second write of `proposal` to make.
   */
  toggleProposalEye() {
    this.setState({ proposalOff: !this.state.proposalOff },
                  () => this.stageProposal(this.state.proposal || emptyProposal()));
  }

  /**
   * One field of the panel, being typed in. THE DRAFT AND NOTHING ELSE.
   *
   * THE TEXT IS KEPT BESIDE THE DOCUMENT, and that is what `proposalDraft` is
   * for. These fields show the document, and the document holds numbers: a field
   * emptied on the way to another number — which is also what a half-typed `42.`
   * reads as, since a number field reports nothing for a value that is not one
   * yet — would be drawn back from the document between one keystroke and the
   * next, putting the old number under the cursor. ONE ENTRY AND NOT A MAP,
   * because one field has the focus at a time, and the commit that ends the
   * typing is what drops it.
   *
   * NO DOCUMENT IS BUILT HERE, which is the difference between this panel and a
   * page that stutters. A keystroke that reached `setProposal` rebuilt the bodies,
   * handed them to the viewport, and had the whole scene disposed and rendered
   * again under a tree going back up to React — per character. `commitProposal`
   * is where a value is settled, and the browser already says when that is.
   */
  typeProposal(key, text) {
    // AND A KEYSTROKE TAKES A NUDGE THAT HAS NOT LANDED WITH IT. The arrows
    // commit on the trailing edge of a run (`nudgeProposal`), holding the text
    // they were handed rather than reading the field later — so a reader who
    // clicks the spinner and then types, which is two gestures in the same field
    // with the focus already there, would have the waiting number written over
    // what they are typing. THE RUN OF A HELD ARROW IS UNHARMED: every tick is an
    // `input` and then a `change`, so each one clears the last timer here and
    // sets its own immediately after.
    clearTimeout(this._nudge);
    this.setState({ proposalDraft: { key, text } });
  }

  /**
   * That field, finished with: the text turned into the next document.
   *
   * `change` AND NOT `input` — a blur, an Enter, or a nudge of a number field's
   * arrows — which is the event the platform defines as "this value is settled"
   * and the one JSCAD's own parameter panel commits on. The draft carried what
   * was on screen until now, so nothing the reader typed is lost by waiting for
   * it. The three doors in are `onBlur`, `onKeyDown` and the node's own `change`
   * handler through `nudgeProposal`; `field` in `computed()` says why the last of
   * those cannot be React's `onChange`, and `nudgeProposal` why it waits.
   *
   * A FIELD NOBODY TYPED IN COMMITS NOTHING. A blur reaches every field the
   * focus leaves, the ones only tabbed through included, and re-committing the
   * text a field was already showing would be a whole scene staged for nothing —
   * `setOverlay` would catch it as equivalent, but the document would still be
   * rebuilt and every part of the panel drawn again. The draft is the record of
   * having typed, so it is also the condition.
   *
   * AND TEXT THAT IS NOT A NUMBER LEAVES THE DOCUMENT AS IT WAS. `unread` is the
   * number field's own `badInput` — a lone `-` or `.` and, measured, nothing
   * else — which is the one case where an empty-looking field is not an empty
   * one; `num` in `computed()` says why the two cannot be answered the same way
   * and carries the measurement. The draft still goes, so the field drops the
   * half-typed text and shows the number that is in the document, which is the
   * number this kept.
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
   * The arrows: ONE DOCUMENT FOR A RUN OF THEM, written when the run stops.
   *
   * A HELD ARROW IS NOT ONE EDIT. Chromium repeats a held key and a held spinner
   * button at about 30 ms a tick, firing `input` and `change` on every one, and
   * each `change` straight into `commitProposal` was a whole document, a whole
   * overlay and a whole scene staged again — the CSG alone is 23 ms at four
   * bodies and 81 ms at twelve (`field` in `computed()` carries the
   * measurements), so a second of holding the up arrow asked for more work than
   * a second has. The draft/commit split exists to keep a keystroke off that
   * road, and this is the same road by another door.
   *
   * THE TRAILING EDGE AND NOT THE LEADING ONE, because the number the reader
   * stops on is the one they mean; the ones on the way past are not worth a
   * scene. The field itself is not waiting for anything — every tick lands in
   * the draft through React's `onChange`, so the number under the cursor moves
   * with the arrow and only the model comes in behind it. A SINGLE CLICK IS A
   * RUN OF ONE and commits `NUDGE_QUIET_MS` later, which is why that number is
   * small enough to read as "at once".
   *
   * `text` is taken here rather than read off the node when the timer fires: the
   * last nudge of a run is the one that survives, and what it committed should
   * be what the field said at that moment and not whatever it holds later.
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
   * Light or dark for the WHOLE page — remembered, and applied to the live scene.
   *
   * THIS USED TO MOVE ONLY THE CANVAS, and the note that stood here said so:
   * "everything this interface draws stays light in both modes". That is what
   * issue #35 changed. Every colour in the interface is a `var(--…)` now
   * (static/_v/tokens.css) and resolves against `data-theme` on `<html>`, so
   * the whole of the chrome turns with the canvas.
   *
   * WHICH MAKES THIS METHOD THREE WRITES AND NOT ONE, in three different
   * places, none of which can do the others' work:
   *
   *   * `writeTheme` puts the answer in the cookie AND stamps the attribute —
   *     the attribute is what repaints the interface, with no re-render, and
   *     the cookie is what the SERVER reads so the next page arrives already
   *     painted (ui/src/store.js);
   *   * `setState` is not for the colours at all. Nothing in the palette needs
   *     React. It is for the BUTTON, which names the mode the reader is in and
   *     would otherwise go on naming the old one;
   *   * `viewer.setTheme` is the canvas, and it is the one that cannot be done
   *     by attribute.
   *
   * WHY THE CANVAS GOES THROUGH `viewer` AND NOT THROUGH THE ELEMENT. This is
   * the one place this file reaches past the element's imperative half, and it
   * is worth saying why rather than tidying later. The library resolves the
   * theme once, at construction, into its own state, and re-asserts THAT value
   * at the end of every render — so setting the attribute from outside, or
   * changing the option object, holds only until the next view switch.
   * `setTheme` is the library's public answer to exactly this and keeps its
   * state in step; the element has no method to forward it, and adding one is
   * not this change's file to edit. `theme` is the library's own word and
   * carries more than the background — the grid and the orientation marker are
   * tinted with it — but both of those are off in this viewport
   * (viewport/options.js), so for the library it IS the background.
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
  // today: `building` and `failed` need a JOB to ask about. The endpoint exists
  // — `GET /api/v1/jobs/<id>`, step 5, closed — but it is behind EDIT_TOKEN and
  // nothing hands this page the id of the job that produced the build it is
  // showing. And it never swaps the model by itself — somebody in the middle
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
    // `compareRevisions` moves it too, for the same reason read the other way
    // round: entering a comparison takes the page off the pointer and withdraws
    // the offer, and an answer landing a moment later would put back the very
    // banner whose Switch is the failure above.
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
    const keep = next.views.some((v) => v.id === this.state.view);
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
  /**
   * The project's comment queue, fetched.
   *
   * PER PROJECT AND NOT PER BUILD (SPEC 7A.3): the route takes a pid and answers
   * with the whole queue, oldest first, so this is not called on a build swap —
   * the same list describes every revision of the project, and each row finds
   * its own place in the build on screen through `anchorFor`.
   *
   * NEVER THROWN OUT OF. The queue is one panel of a page whose model is already
   * on screen: a failure leaves the rail holding what it had and says so, like
   * every other fetch here.
   *
   * `quiet` IS FOR THE REFETCH THAT FOLLOWS A WRITE, and it exists because two
   * toasts cannot stand at once — `toast()` replaces the one on screen. The
   * write says "Sent to the agent"; a refetch that then fails would paint
   * "Could not load the comments" over it, and the reader, whose comment landed
   * in the queue a second ago and is not in the rail, sends it again. A
   * duplicated item in a queue an AGENT works from costs more than a rail that
   * is one entry stale until the next load. So the write's own verdict is the
   * one that stays, and the refetch behind it is silent.
   */
  async loadFeed(quiet = false) {
    let response = null;
    try {
      response = await fetch(
        `/api/v1/comments?project=${encodeURIComponent(PAGE.pid)}`,
        { headers: { Authorization: `Bearer ${this.state.token}` } });
    } catch (error) {
      console.error('feed', error);
      if (!quiet) this.toast('Could not reach the hub');
      return;
    }
    if (response.status !== 200) {
      if (!quiet) {
        this.toast(response.status === 401
          ? 'The hub refused the token'
          : 'Could not load the comments');
      }
      return;
    }
    let body = null;
    try {
      body = await response.json();
    } catch (error) {
      console.error('feed', error);
      if (!quiet) this.toast('Could not load the comments');
      return;
    }
    this.set({ feed: (body && body.comments) || [] });
  }

  /**
   * The project's stored proposal, fetched — one document per project, behind
   * the same EDIT_TOKEN everything else on this page is behind.
   *
   * CALLED FROM EXACTLY TWO PLACES, and the one it is deliberately NOT called
   * from is the point. `loadFeed` is refetched quietly after every comment is
   * sent, and a refetch that re-adopted the stored document would stamp on
   * whatever the reader has edited since — so this is asked where the TOKEN
   * arrives (`componentDidMount` and `tokenSave`) and nowhere else. Its
   * neighbour's shape otherwise: never thrown out of, a fixed sentence rather
   * than the hub's own, and the document the page already has left standing on
   * every failure.
   *
   * WHAT IT DOES WITH THE ANSWER IS NOT HERE. The record is put down on
   * `_proposalRecord` and `adoptProposal` is asked to take it, which it does at
   * the first moment the page is in a state to — see there for why that moment
   * is not this one.
   */
  async loadProposal() {
    let response = null;
    try {
      response = await fetch(
        `/api/v1/proposals/${encodeURIComponent(PAGE.pid)}`,
        { headers: { Authorization: `Bearer ${this.state.token}` } });
    } catch (error) {
      console.error('proposal', error);
      this.toast('Could not reach the hub');
      return;
    }
    // A PROJECT WITH NOTHING STORED IS NOT A FAILURE, and it is the answer that
    // opens the door to saving: there is nothing left to overwrite. Nothing to
    // adopt either, so this one needs no scene and no build and is answered on
    // the spot.
    if (response.status === 404) {
      this.setState({ proposalHeld: false, proposalStands: false });
      return;
    }
    if (response.status !== 200) {
      this.toast(response.status === 401
        ? 'The hub refused the token'
        : 'Could not load the proposal');
      return;
    }
    let body = null;
    try {
      body = await response.json();
    } catch (error) {
      console.error('proposal', error);
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
   * TWO THINGS HAVE TO BE TRUE, and the fetch is racing both of them.
   *
   * `meta` HAS TO BE IN, because whether the stored moves may be kept is
   * decided by comparing the record's build stamp and view against this page's,
   * and a `meta` that has not landed reads as "some other build" — which
   * silently dropped the moves of every cold reload, the one case the stamp was
   * put there for. It lands with builds.json, one fetch behind this one, and
   * `state.view` is set in the same patch, so one wait covers both.
   *
   * AND THE FIRST MODEL EVENT HAS TO HAVE PASSED. `onModel` drops the moves of
   * every build that lands (`dropMoves`, and the note there says why), so a
   * document adopted before the build reaches the screen has its moves taken
   * out from under it a moment later. The same event is where this interface
   * learns a scene is up, which the two doors to the viewport need
   * (`proposalMoves`, `proposalOverlay` are a bare early return without one).
   *
   * SO WHICHEVER LANDS LAST PERFORMS IT: this is called from `onModel`'s
   * callback and from `loadProposal`, and the one that finds the other's half
   * already in place is the one that adopts. No flag of its own and no timer —
   * the record on `_proposalRecord` IS the "not yet taken" state, and it is
   * spent here. `tokenSave`'s door needs no wait at all: a reader typing a token
   * into a page has meta and a scene already, so the call from `loadProposal`
   * adopts on the spot.
   *
   * ADOPTED ONLY INTO AN EMPTY DOCUMENT (`isEmpty`). The wait above is one more
   * reason the reader may have drawn something by now, and their own work
   * outranks a document they have not seen. The record is spent either way: the
   * hub is not asked twice.
   *
   * AND A PAGE THAT DECLINED IT MAY NOT WRITE. `proposalHeld` is left at `null`,
   * which already means "do not write", because this page has read a record it
   * never showed, and raising the flag would let the reader's very next edit
   * post their own document straight over it. That is the whole of the guard: a
   * page that would not take the record has not earned the right to destroy it.
   * `proposalStands` is raised all the same, because it is about what the HUB
   * holds and what the hub holds is unchanged.
   *
   * ONE TOAST GOES WITH THE REFUSAL, because the alternative is a reader drawing
   * into a page that is quietly saving nothing.
   *
   * ONLY ON A PAGE THAT HAS NEVER ADOPTED (`proposalHeld !== true`), and that
   * clause is not belt and braces. `loadProposal` runs again on EVERY
   * `tokenSave`, not only the first — a reader who re-pastes a token they
   * already had brings back a fresh record — and by then the document on screen
   * is one this page adopted and has been saving all along. Without the clause
   * that second pass takes the refusal branch and says "your drawing is not
   * being saved" to a reader whose drawing is being saved perfectly well; the
   * natural answer to that alarm is the branch's `×`, which would lose it for
   * real. Such a pass re-reads what the hub holds and does nothing else.
   *
   * AND THE MOVES ARE DROPPED WHERE THE STORED BUILD AND VIEW ARE NOT THIS
   * PAGE'S — BOTH, not the build alone. A move's `paths` are paths in ONE
   * revision's tree as ONE view groups it — `/model/pin(2)`, a number the
   * tessellator hands out — so a rebuild renumbers them and another view is a
   * separate tree of references altogether (`src/cadbuild/views.py`); either
   * way a stored move re-applied here can displace a DIFFERENT part. `published`
   * is IDENTICAL across the views of one build, so the build alone would let a
   * reader who switched view, dragged parts and reloaded come back on the
   * default view with those moves on the wrong tree — while within one session
   * `onModel` drops them on every switch. `dropMoves` is that rule already
   * written down, in those three words (ui/src/proposal.js); the BODIES are
   * kept, because a motor the model has to clear is as true of one build and
   * one view as of another.
   *
   * THROUGH `setProposal`, so the bodies reach the model the way every other
   * edit does — and BEFORE `proposalHeld` is raised, so the save hanging off
   * that door reads the load as unanswered and writes nothing. An adoption is
   * not an edit, and the record must not be re-stamped by the page that has
   * just read it; the order below is the whole of how that is arranged.
   */
  adoptProposal() {
    const record = this._proposalRecord;
    if (!record || !this.state.meta || !this._modelSeen) return;
    this._proposalRecord = null;
    const doc = record.doc || null;
    // `!!` AND NOT `!= null` on `text`, wherever it is read below: what the
    // announcement claims is that there is something to read, and the hub writes
    // `text` as null for a document that projects to nothing. An empty string is
    // the same fact spelled differently.
    // A RECORD WITH NOTHING IN IT IS NOT SOMETHING TO PROTECT, and that is why
    // the refusal below asks about the STORED document and not only about the
    // page's. The hub legitimately holds `{nodes: []}` — `saveProposal` writes it
    // when a reader deletes their last body — and treating that as work worth
    // declining for would leave the reader drawing into a page that has decided
    // never to save, over a record that says nothing at all. Nothing is lost by
    // writing over it, so the ordinary path takes it.
    const worth = !!doc && !isEmpty(doc);
    const bare = isEmpty(this.state.proposal || emptyProposal());
    if (worth && !bare && this.state.proposalHeld !== true) {
      this.setState({ proposalStands: !!record.text });
      this.toast('This project has a stored proposal — your drawing is not '
                 + 'being saved');
      return;
    }
    // AND THE PAGE'S OWN DOCUMENT IS STILL NEVER OVERWRITTEN. The refusal above
    // no longer covers this on its own: a record with nothing in it falls past
    // it, and taking one over a reader who has drawn something would clear the
    // screen with an empty document to no purpose at all.
    if (doc && bare) {
      const here = !!(record.published
                      && record.published === this.state.meta.published
                      && record.view
                      && record.view === this.state.view);
      const taken = here ? doc : dropMoves(doc);
      this.setProposal(taken);
      // WHAT WAS TAKEN COUNTS AS ALREADY SENT, and this line is the whole of
      // what keeps a reader's stored moves from being destroyed by a page that
      // merely opened the sheet. `setProposal` is the save's door, so the very
      // next call through it — `toggleProposal` pushes the same document — would
      // otherwise find an empty memo and post. On THIS build and view that is
      // one request saying nothing; on any other it is the record rewritten with
      // this page's stamps and without the moves `dropMoves` has just taken out
      // for display, and those moves are then gone from the hub for good.
      //
      // Nothing is sent, and nothing is claimed about the hub beyond what it
      // just told us: the memo only answers "has this exact document gone", and
      // this exact document is where it came from. A real edit differs from it
      // and posts as usual — including, on another build, the document without
      // the moves, which is `dropMoves`'s own rule and not a loss this invents.
      this._proposalSent = JSON.stringify(this.proposalPayload(taken));
    }
    this.setState({ proposalHeld: true, proposalStands: !!record.text });
  }

  /**
   * The document written back to the hub, once the edits have stopped.
   *
   * HUNG OFF `setProposal`, the door every edit made IN THE PANEL comes through
   * — and off ONE other place, the completion callback of the `hmr:moved`
   * handler, which writes the document with a functional updater and therefore
   * cannot use that door (`setProposal` says why it cannot). Those two are the
   * whole inventory, and the second is named here rather than left to be
   * rediscovered: the bug it fixes was born of the belief that the door was one,
   * and a reader who still believes that will delete the call as a duplicate.
   * `onModel`'s `dropMoves` is the third writer of the document and is not an
   * edit at all — it takes nodes away because the build they described has gone,
   * and saves nothing.
   *
   * FOUR GUARDS, AND EVERY ONE IS LOAD-BEARING.
   *
   * NOTHING IS SAVED UNTIL THE LOAD HAS RESOLVED (`proposalHeld` is still
   * null). Without it the page mounts with an empty document, the reader opens
   * the panel — which calls this door with that same empty document — the
   * debounce fires, and the proposal they stored last week is destroyed by a
   * page that had not read it yet. A PAGE THAT DECLINED THE RECORD IS THE SAME
   * STATE AND IS HELD THERE ON PURPOSE (`adoptProposal`): it read a document it
   * never showed, so it may not write over it either.
   *
   * NO TOKEN, NO SAVE. The panel is hidden without one, but the branch of the
   * tree outlives the token and `tokenClear` works right beside this door; a
   * page that has stopped being allowed to edit must not go on writing.
   *
   * AND AN EMPTY DOCUMENT DOES NOT CREATE A RECORD. Opening the panel on a
   * project with nothing stored calls this door with the document the page
   * mounted with, and a record whose document has no nodes in it is a file on
   * the volume for a reader who has said nothing — one per project anybody ever
   * opens the panel on. `isEmpty` AND NOT `sendsNothing`: a document ticked off
   * to the last node is work somebody did, and it is stored like any other.
   * ONCE THE HUB HOLDS ONE, emptying the page goes on saving — the record
   * mirrors what is on screen, and a reader who deletes their last body means
   * it.
   *
   * AND A PAYLOAD IDENTICAL TO THE LAST ONE SENT IS NOT AN EDIT. Opening the
   * sheet calls `setProposal` with the document it already had (`toggleProposal`
   * says why), and a reader who nudges a size and puts it back has made no
   * change either — a request per panel opening is a request that says nothing.
   * THE ADOPTION IS NOT WHAT THIS GUARD CATCHES, though it comes through the
   * same door: it is refused a line above, by a `proposalHeld` that
   * `adoptProposal` deliberately raises only afterwards.
   *
   * THE PENDING SAVE IS CANCELLED FIRST, whichever way this call then goes. A
   * skip has to reach the armed timer too: a reader who edits and then undoes
   * back to the stored document would otherwise have the intermediate document
   * posted by a timer nothing disarmed.
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
   * ONE BUILDER AND TWO CALLERS, and the second caller is why it is a method
   * rather than four lines inside `saveProposal`. That one SENDS it;
   * `adoptProposal` records it as already sent without sending anything, so that
   * taking a document off the hub is not immediately followed by writing it back.
   * Spelled out in both places the two would agree until somebody adds a field to
   * one of them, and the cost of disagreeing is silent on both sides: a post that
   * says nothing new, or a stored proposal overwritten by a page that only opened
   * a panel. `ui/tests/proposalpanel.test.js` holds them equal.
   *
   * AN OBJECT AND NOT THE STRING, because `saveProposal` needs `text` again after
   * building it — the announcement flag rides to `postProposal` beside the body,
   * and re-reading it out of the serialised form would be parsing what this just
   * wrote.
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
   * That write, made. SILENT ON BOTH SIDES: a save nobody asked for should not
   * put a toast over the one the reader's own action raised, and there is no
   * indicator for it anywhere — this page's copy is the one being edited, so
   * what the hub holds is behind it by at most one debounce.
   *
   * THE PAYLOAD IS RECORDED AS SENT BEFORE THE REQUEST rather than after it:
   * what the memo above answers is "has this exact document already gone", and
   * two identical posts racing is the thing it is there to prevent.
   *
   * AND FORGOTTEN AGAIN IF IT DID NOT LAND. A 401, a 413, a hub that went away
   * mid-request — the memo would go on claiming the hub holds this document,
   * and the edit would be lost until the reader happened to make another one
   * that differed from it. Clearing it is the whole of the retry: the next edit
   * posts, whatever it is, so a moment's failure heals itself and a permanent
   * one costs one request per edit rather than a timer nobody can see. SILENT
   * STILL — nothing here was asked for by the reader, and this page's copy is
   * the one being worked on.
   *
   * THE TWO FLAGS MOVE ON SUCCESS ONLY, for the same reason: what they describe
   * is the hub's side, and a request that did not arrive changed nothing there.
   */
  async postProposal(body, says) {
    this._proposalSent = body;
    let response = null;
    try {
      response = await fetch(`/api/v1/proposals/${encodeURIComponent(PAGE.pid)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.state.token}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (error) {
      console.error('proposal', error);
    }
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
   * IT ASKS FIRST, with the browser's own `confirm()`, which is a thing this
   * page does nowhere else and is deliberate: every other `×` here takes back
   * one node of a document that is being edited on screen, while this one is the
   * whole of work that has survived reloads. A misclick on the row beside it
   * costs one body; a misclick on this one used to cost everything there was.
   *
   * THE PAGE IS CLEARED THROUGH `setProposal`, so the bodies come off the model
   * and the branch empties the way they do for every other edit. NO SAVE
   * FOLLOWS IT, AND WHAT MAKES THAT TRUE IS THE CANCEL — not the order of the
   * lines. The tempting deduction is that the flags are lowered first and
   * `saveProposal` then refuses an empty document with no record behind it; in
   * this browser it is false, because React batches `setState` inside a promise
   * continuation, so that door still reads `proposalHeld` as `true` and arms a
   * timer. The `clearTimeout` below is what disarms it, and it is stated as its
   * own promise: NOTHING THIS PAGE HAD ARMED SURVIVES THE DELETE, an edit made a
   * second before the `×` included. (The test fixture's `setState` is
   * synchronous, so the suite cannot tell the two readings apart — which is
   * exactly why the right one is written down.) What the lowered flags DO buy is
   * the next edit: with the record gone they stop it recreating one by accident.
   * The memo goes with them, so a reader who rebuilds the same document by hand
   * is not skipped for matching a payload the hub no longer holds.
   *
   * AND THE DOCUMENT STEPS GO THROUGH THAT SAME DOOR, which is the other half of
   * the promise above and the reason it is not merely tidy. `setProposal` drops
   * them for any write that records none (`DROP_STEPS`), so Ctrl+Z after this
   * cannot bring the drawing back — and a drawing brought back is saved like any
   * other edit, which would put on the hub, a debounce later, the very record the
   * reader has just been asked about and confirmed deleting.
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
    let response = null;
    try {
      response = await fetch(
        `/api/v1/proposals/${encodeURIComponent(PAGE.pid)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${this.state.token}` },
        });
    } catch (error) {
      console.error('proposal', error);
      this.toast('Could not reach the hub');
      return;
    }
    if (response.status !== 200) {
      this.toast(response.status === 401
        ? 'The hub refused the token'
        : 'Could not delete the proposal');
      return;
    }
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
    // ONE COMMENT AT A TIME, and this is the one refusal in the composer.
    //
    // The window between the press and the queue coming back is the whole of
    // this method — the frame grab, the upload of it, the POST, the refetch —
    // and nothing on the screen moved while it was open: the composer stayed
    // put with its text in it, because the write is what clears it. So a reader
    // who saw nothing happen pressed Send again, and every press started an
    // INDEPENDENT post of the same draft. The hub has nothing to tell them
    // apart by — no idempotency key, and comments are not deduplicated
    // (src/comments.py) — so five presses are five rows in a queue an agent
    // works from, which is the cost this file's own note about `loadFeed`'s
    // quiet refetch already calls more than a stale rail.
    //
    // A REFUSAL RATHER THAN A QUEUE: the second press is the same draft, not a
    // second one, so there is nothing to send later. It is lowered in the
    // `finally` below — on the error paths too, since a comment the hub refused
    // is one the reader must be able to press Send on again.
    if (this.state.sending) return;
    // Refused here rather than only by the hub, since step 0 put the write
    // behind the token. Not a security check — the hub's is — but the difference
    // between "you are not signed in" and a 401 arriving after the photo has
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
      // `part`, `key`, `published`, `point` and `camera` and DROPS everything else
      // without saying so — so the measurement and the proposal ride in the text,
      // where the agent will actually read them, rather than in fields discarded
      // on the way in. A DRAGGED PART IS NOT A THIRD ATTACHMENT any more: it is a
      // line of the proposal's own projection, which is the block below.
      //
      // THE PROPOSAL IS THE ONE THAT SPANS LINES, and it goes last for that reason:
      // it is a small table (`proposalText`), and a block in the middle would split
      // the one-line facts above it away from the sentence they belong to.
      const extra = [];
      if (c.meas) extra.push(`measured: ${c.meas}`);
      if (c.proposal) {
        extra.push('proposal — a rough body to design against or to follow, '
                   + `not in the model:\n${c.proposal}`);
      }
      // AND WHERE THE DOCUMENT IS STORED BUT NOT ATTACHED, a pointer to it. The
      // two are exclusive by construction — with the block right there, a line
      // saying where to find the same thing is noise — so this being third
      // never puts a one-line fact below the block that spans lines.
      //
      // OFF WHAT THE PAGE ALREADY KNOWS and not off a second request:
      // `proposalStands` is the load's answer kept current by this page's own
      // writes, so a reader who draws a proposal and then writes a comment in
      // the same session is announced as well as one who stored it last week —
      // and one who has just deleted theirs is not.
      if (this.state.proposalStands && !c.proposal) {
        extra.push('a proposal stands on this project and is not attached here '
                   + '— `hammerola proposal` reads it');
      }

      const form = new FormData();
      form.append('comment', JSON.stringify({
        text: extra.length ? `${text}\n\n${extra.join('\n')}` : text,
        view: this.state.view,
        part: c.partId || null,
        // THE ANCHOR THAT OUTLIVES THIS BUILD. `part` is a path in the tree of the
        // revision being looked at and the next rebuild is free to renumber it;
        // the catalogue key is the part's identity (issue #75), and it is what the
        // page follows to put this pin back on a later build.
        key: c.key || null,
        // WHICH BUILD THE COORDINATE WAS TAKEN ON — not necessarily the build the
        // slot holds when this request lands, since `dev` can rebuild while the
        // reader is still typing, and only this page knows which one it is showing.
        published: meta.published || null,
        point: c.p || null,
        camera: this.frameCamera(),
      }));
      // THE TWO ATTACHMENTS, AND THE ONLY PLACE EITHER IS SHRUNK (shrink.js).
      // Both used to leave untouched — the frame as a lossless PNG in device
      // pixels, the photo as whatever the phone wrote — and the fifteen seconds
      // a reader waited on Send were the request body going up, not the
      // encoding (7–90 ms) and not the hub (5–45 ms).
      //
      // THE NAME IS BUILT FROM THE BLOB'S OWN TYPE. The hub identifies an
      // upload by its magic bytes and never reads this name (`sniff_image`,
      // src/comments.py), so it is cosmetic — but `shot.png` on a re-encoded
      // WebP is a request that lies about itself to whoever debugs one next. A
      // blob the browser gave no type gets the bare stem rather than a guess.
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

      // THE QUEUE IS REFETCHED RATHER THAN GUESSED AT. This page used to append a
      // row of its own making — its own id, its own label, `just now` — because it
      // had no other copy of the queue; it has one now, so the row the rail draws
      // is the record the hub actually stored, with the id, the stamp and the
      // status the agent will see.
      this.set({ composer: null, rail: true });
      this.toast('Sent to the agent — a rebuild will follow');
      await this.loadFeed(true);
    } finally {
      // EVERY EXIT, including the throw `compSend` catches: a flag left up by a
      // failure is a composer whose Send never works again, with the draft still
      // in it and no way to get it out but reloading the page.
      //
      // WHICH PUTS IT AFTER THE SILENT REFETCH, so on the way out the flag
      // outlives the composer it guards by one GET: a reader who places a new
      // point in that window sees the new composer's Send already spent, for a
      // comment that is not the one it is holding. Left alone deliberately —
      // that GET is the cheap end of this method and the window is a fraction
      // of the upload's, while lowering the flag earlier would put a second
      // lowering point on the one path that has to have exactly one.
      this.setState({ sending: false });
    }
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
   * THE QUEUE IS REFETCHED RATHER THAN PATCHED HERE: the hub stamps `resolved`
   * and may have a note on it, and a row edited in place would be this page's
   * idea of the record instead of the record.
   */
  async resolveComment(id) {
    if (!id || this.viewer()) return;
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

  /** The line under the title: this view's part count, the build's total size.
   *
   * `views[].parts` IS A LIST OF CATALOGUE KEYS AND NOT A NUMBER (issue #75) —
   * exactly the parts this view shows, named so that a reader learns what is in
   * a tab without fetching two megabytes to find out. So the count is the
   * list's length, and it counts DISTINCT parts: a plate holding five copies of
   * one pin names `pin` once, and says two parts rather than six.
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
   * A METHOD AND NOT A CLOSURE IN THE HANDLER MAP, the same move `sceneMenu`
   * and `onModel` make and for the same reason: the map is built in
   * `componentDidMount`, which loads a build and starts a poll, so a decision
   * written inside it can only be reached by mounting the whole page. There
   * are two decisions in here — which of the two selections this writes, and
   * what it resolves the pick to — and neither was reachable through the map.
   */
  onPick(detail) {
    // THE ROW, not the solid. A pick names the copy the reader hit —
    // `/model/pin(2)` — and `sel` has always been a row id, which is what
    // every reader that resolves it through `node()` takes it for: `selRow`
    // in `computed`, `selectedPaths`, `selectedKey` and `measAdd`. A row
    // standing for five copies is reached by any of its paths
    // (hub.indexTree), so this is a lookup rather than a special case; an id
    // arriving before the tree does keeps the path it came with.
    //
    // `selName` GOES THROUGH THE SAME ROW, because the pair is ONE answer
    // about ONE thing: `sel` is what a comment is filed against and
    // `selName` is what the reader is shown it was filed against. Left the
    // solid's, they part company on a collapsed run — pick the third copy
    // and `sel` is `/model/pin` while `selName` is `pin(3)`, an id naming
    // the FIRST copy under a name no row is drawn under at all, since issue
    // #75 collapses that run into `pin ×3`.
    //
    // THE TREE STANDS WHENEVER THE PICK RESOLVES — it is what resolves it —
    // so wherever there is a row at all, the row's name is available at the
    // moment the field is WRITTEN, and every reader of it comes later.
    // Keeping the solid's name for the sake of those readers stores a second
    // answer rather than a truer one. EVERY OTHER WRITER THAT PUTS A NAME
    // HERE ALREADY DOES EXACTLY THIS, and a grep for the field is what says
    // so rather than a count to be taken on trust: five assignments, this one
    // included. Of the other four, two carry a name — the tree row's `onSelect`
    // and the row menu's `Move`, each off the row's own `name` — and two carry
    // `''`, the initial state and `leaveBuild`. The menu's Isolate was a namer
    // too until issue #83 took the pair off it entirely: it hides everything
    // else and writes no selection at all, because the selection shader replaces
    // a part's colour and colour is an assertion on this page.
    //
    // WHAT THE DIVERGENCE COST IS NOT HYPOTHETICAL, and it is reached
    // without ever leaving the build. `measAdd` fills a comment out of the
    // pair — `partId` off `sel`, `part` off the row or, where the tree
    // cannot answer, off `selName` — and the tree stops answering in a view
    // that does not SHOW this part. Not on any view tab: a path is the
    // assembly structure spelled out (`treeFromShapes` builds it as parent
    // plus `/name`), so a view laying the same parts out under the same
    // names holds the same paths and `node(s.sel)` answers there too.
    // What carries the pair across is that `showView` touches neither half,
    // and that `onModel` writes both halves together or neither — so a pick in
    // one view and a measurement in another that dropped the part lands on that
    // fallback with both halves still set. Diverged, it posts the first copy's
    // path to the hub under the third copy's name.
    //
    // `onModel` DOES NOT "REPLACE ONLY THE TREE", and the precision matters
    // to anyone walking this route: it writes `tree`, `view`, `viewError`,
    // `expanded` and whatever `rejoin` returned, and on a build that is not a
    // re-stage it CLEARS `measure` and takes the moves out of the proposal
    // document. It does write this pair, since the proposal got a branch of its
    // own: `stagedSelection` carries a selected staged body from the document
    // node's id onto the path the scene has just given it. Both halves in one
    // spread or neither, which is the whole of the argument — what this fallback
    // needs is that they never diverge, not that nobody writes them. A
    // measurement taken BEFORE the tab was changed does not survive to
    // `measAdd` — the order that reaches it is pick, tab, measurement.
    //
    // THE SOLID'S NAME IS STILL THE FALLBACK, for a path no row claims — a
    // pick that arrived before the tree did, which is the same case `sel`
    // answers by keeping the path it came with.
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
   * A right-click in the SCENE, opening the same menu a tree row's does.
   *
   * `setState` and not `set`: the menu is a thing on the page, not a thing about
   * the model, so the viewport is told nothing.
   *
   * IT DOES NOT TOUCH `sel` / `selName`, which is the decision worth defending
   * here: a tree row's menu leaves the selection alone, and a menu that meant
   * "look at this" from one door and "select this and look at it" from the other
   * is worse than either. So the part under the cursor gets a menu and the
   * reader's selection stays where they put it. OPENING the menu, that is — one
   * row inside it, `Move`, writes the selection deliberately, and says on itself
   * why the tool it arms would otherwise take hold of the wrong thing.
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

  /**
   * The CATALOGUE KEY of the selected row: what a note, a file and a kind hang
   * on.
   *
   * A GROUP HAS NONE, which is the rule it always had said in the new
   * vocabulary: an assembly is not a part, so it has no record, no note and no
   * files — and `treeFromShapes` is what puts a key on leaves only, one storey
   * above the tree this reads: `indexTree` copies through whatever it is
   * handed.
   *
   * NEITHER DOES A LEAF THAT NAMES NO KEY, and it is answered with '' rather
   * than with the row's name. That fallback is the identity-by-string this
   * whole change deletes (issue #75): the name on a row is the tessellator's,
   * chosen to keep two copies of one part apart (`pin`, `pin(2)`), and looking
   * a note up under it would find the wrong record or none while looking
   * exactly like it worked. A build the hub accepted always carries the key —
   * `check_view_file` refuses a leaf without one — so the empty answer is for a
   * document this page did not get from a push it can trust.
   */
  selectedKey() {
    const node = this.node(this.state.sel);
    return (node && node.key) || '';
  }

  /** The READER's note: this browser's, for this project, never sent anywhere.
   *
   * KEYED BY THE CATALOGUE KEY since issue #75, and the notes a browser wrote
   * before that stop being found. That is accepted rather than migrated: a note
   * belongs to the PART, and the old key was a display name that a rebuild is
   * free to change — reading the old entries would mean matching on exactly the
   * string this change stopped trusting.
   *
   * Through `noteFor` like the other read of this map: it is parsed out of
   * localStorage, which is no more this code's own object than a fetched
   * document is.
   */
  selectedNote() {
    return noteFor(this.state.notes, this.selectedKey());
  }

  /**
   * The AUTHOR's note on the selected part — written in `model.py` and
   * published inside this build's catalogue record for it.
   *
   * ABSENT IS NORMAL, and it now has two spellings that mean the same thing: a
   * part with nothing to say carries no `note` key inside its record, and a
   * part that is not in the catalogue at all has no record. Neither is an
   * error, and `partRecord` answers both with `null`.
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
   * ONE READING FOR THE TWO PLACES THAT NEED IT — `switchBuild`, both where it
   * opens another build and where it only calls a swap off. The fallback is the
   * current view because `?v=` is DROPPED where the view is the build's first
   * (see the push in `switchBuild`), so an entry without one carries no opinion
   * that could be read off it.
   */
  entryView() {
    return new URLSearchParams(location.search).get('v') || this.state.view;
  }

  /**
   * The query an address needs so that opening it lands on `view`.
   *
   * `?v=` is what `load()` reads on a fresh open, so an address written by this
   * page has to carry it wherever the view showing is not the one that address
   * would open on by itself — otherwise the link in the bar, copied and sent,
   * shows a different view than the sender was looking at. Dropped where the
   * view IS the build's first, since the query would then repeat what the path
   * already answers.
   *
   * ONE READING FOR THE TWO PLACES THAT WRITE AN ADDRESS — the push that lands a
   * swap and the replace that calls one off. It was written out at the first and
   * missing from the second, which is how the fix for a divergence over the
   * BUILD arrived carrying a divergence over the VIEW.
   */
  viewQuery(view, views) {
    const first = views[0] && views[0].id;
    return view === first ? '' : `?v=${encodeURIComponent(view)}`;
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
   * command and the element already takes two of those the same way
   * (`__resetCut`, `__clearMeasure`): it rides the one state event, is acted on,
   * and is deleted rather than left standing in a field.
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
    // THE SELECTED ROW, RESOLVED — not `sel` compared against each row's id.
    // Since issue #75 a row may stand for several copies of its part, and `sel`
    // may hold the path of a copy that is not the first: the pick handler
    // resolves it through `node()`, but only if the tree had already landed,
    // and nothing resolves it afterwards: the one thing that writes `sel` later
    // is `stagedSelection` in `onModel`, and it answers a different class —
    // a staged body's document id becoming its scene path — never re-resolving
    // a build path that arrived unresolved.
    // Compared raw, such a selection lights up all five copies in the SCENE —
    // `selectedPaths()` resolves the same value — and no row at all in the
    // panel. Every path of a row is a key of `nodes` (`indexTree`), so this is
    // the same Map lookup that side already makes; hoisted out of the row loop
    // because `sel` cannot change while `computed()` runs.
    const selRow = this.node(s.sel);

    const overlayPath = this.overlayRoot(tree);

    // -- the tree: a flat list of rows, indented by depth
    const rows = [];
    const eyeOuter = (st) => 'width:15px;height:10px;border:1.5px solid ' + (st === 'off' ? 'var(--line-strong)' : 'var(--text-soft)') + ';border-radius:50%;display:flex;align-items:center;justify-content:center';
    const eyeDot = (st) => 'width:5px;height:5px;border-radius:3px;' + (st === 'on' ? 'background:var(--text-soft)' : st === 'part' ? 'background:linear-gradient(90deg,var(--text-soft) 50%,var(--line-strong) 50%)' : 'background:transparent');
    const ghostIcon = (on) => 'width:11px;height:11px;border-radius:3px;' + (on ? 'background:linear-gradient(135deg,var(--text-soft) 50%,var(--hover-bg) 50%);border:1px solid var(--text-soft)' : 'border:1px solid var(--line-strong);background:linear-gradient(135deg,var(--hover-bg) 50%,transparent 50%)');
    // THE PROPOSAL'S TICK, drawn as the square beside it so the two read as one
    // row of controls rather than a checkbox bolted onto a tree. FILLED MEANS
    // HELD BACK, which is the way round the reader asked for it — a tick is
    // "leave this out of what you send" — and empty means the node travels, so
    // a branch nobody has touched is a row of empty squares and says so.
    const skipIcon = (on) => 'width:11px;height:11px;border-radius:3px;border:1px solid '
      + (on ? 'var(--text-soft);background:var(--text-soft)' : 'var(--line-strong);background:transparent');

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
      // NOR IS IT PART OF WHAT A ROW ABOVE IT COUNTS, which is the same removal
      // one storey up and not a second decision. `indexTree` builds a group's
      // `leaves` out of every leaf underneath it, and the overlay is staged as a
      // child of the MODEL'S ROOT — so the root row went on reporting `4` over
      // three rows, and its eye went on hiding a body the branch below has its
      // own eye for. A number that counts rows nobody can see is the overlay
      // appearing under the root after all, as a digit instead of a line.
      //
      // ONLY THE ROOT CAN DIFFER, since that is the one node the overlay hangs
      // under; every other row is handed its own list back unchanged, which is
      // what the `some` guard buys before the copy.
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
        // A STROKED PATH AND NOT A GLYPH, which is the whole of why this looks
        // different now. The mark was `▾` at 9 px in a 14 px box, then `▾` at
        // 11 px in a 20 px one — the TARGET grew and the ink did not, because
        // U+25BE is a SMALL triangle whose ink is a fraction of the font size
        // that the font, not this file, decides. A path in a 16-unit viewBox is
        // the only form whose size this file actually sets.
        //
        // That it is drawn at the WEIGHT of the expand-all and collapse-all
        // buttons above the tree — this being a per-row version of them — is
        // pinned by ui/tests/repeats.test.js rather than claimed here.
        caretPath: node.isNode ? (expanded ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4') : '',
        caretStyle: 'width:20px;height:20px;flex:none;display:flex;align-items:center;justify-content:center;color:var(--text-soft);cursor:pointer;' + (node.isNode ? '' : 'visibility:hidden'),
        onExpand: stop(() => node.isNode
          && this.setState({ expanded: { ...s.expanded, [node.id]: !expanded } })),
        eyeOuter: eyeOuter(eye), eyeDot: eyeDot(eye), ghostIcon: ghostIcon(ghosted),
        dotStyle: 'width:9px;height:9px;border-radius:3px;flex:none;margin:0 4px 0 2px;background:' + (node.color || 'transparent') + (node.isNode ? ';border:1px solid var(--line-strong);background:transparent' : ''),
        // `pin ×5` where the row collapsed five copies of one part (issue #75).
        // A GROUP NEVER GETS ONE, and the reason is that it would not be the
        // same quantity: a group's `leaves` is every leaf path UNDERNEATH it
        // (`indexTree`), so `housing ×3` reads as three housings when the three
        // are the parts inside one. That the number is already in `meta_` on the
        // right — as `visible/total` while SOME BUT NOT ALL of them are hidden,
        // bare with none hidden and bare again with every one of them hidden,
        // since that is `eye === 'off'` and not `'part'` — is a second and
        // smaller remark: it says why the count is still visible on the row, not
        // why it is kept out of the name.
        name: node.isNode ? node.name : countedName(node.name, node.leaves.length),
        nameStyle: 'white-space:nowrap;cursor:pointer;padding-right:4px;font:' + (node.isNode ? '600 12px ' : '400 12px ') + MONO + ';color:' + (eye === 'off' ? 'var(--text-faint)' : 'var(--text)'),
        meta: meta_,
        // Said out loud rather than dropped: a leaf the viewport could not match
        // to the library's own state map is a row nothing can be done to, and a
        // tree missing a row reads as a build with fewer parts.
        metaTitle: node.isNode || node.known ? '' : 'the viewport does not know this part',
        metaStyle: `flex:none;font:400 10px ${MONO};color:var(--text-faint);padding:0 2px`,
        // A group toggles as a whole: anything still visible means hide it all,
        // nothing visible means show it all. Expressed in LEAF ids — see
        // hub.indexTree for why.
        // `setVisibility` and not `set`, here and at every other writer of these
        // two lists: a swap in flight is carrying them across BY NAME, and a row
        // clicked in that window is a row of the leaving build's tree — the only
        // moment those ids can still be read. See the method.
        // `leaves` AND NOT `node.leaves`, so the model root's eye stops reaching
        // into the proposal: those bodies have an eye of their own in the branch
        // below, and one control taking another's subject is two answers to one
        // question. Every other row's two lists are the same object.
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
    const info = s.builds || { has_dev: false, latest: null, builds: [] };
    const history = Array.isArray(info.builds) ? info.builds : [];
    const revs = [];
    if (info.has_dev) {
      revs.push({ id: 'dev', head: 'POINTERS', badge: '→ dev slot',
                  date: '', message: '', pointer: true });
    }
    if (info.latest) {
      revs.push({ id: 'latest', head: info.has_dev ? '' : 'POINTERS',
                  badge: `→ ${shortId(info.latest)}`, date: '', message: '',
                  pointer: true });
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
      // WHAT THE AUTHOR SAID THIS REVISION IS (issue #67), and the reason this
      // menu can now be read at all: every other thing on the row — twelve hex
      // characters and a timestamp — tells two revisions apart without saying
      // what either one is. Absent on the ones pushed before the field existed
      // and on any push made without `-m`, so it is read as "" and the row is
      // then exactly the row it always was.
      message: typeof b.message === 'string' ? b.message : '',
    }));

    const revRows = revs.map((r) => {
      const current = r.id === PAGE.slot;
      // THE TICK HOLDS THE COMMIT AND NOT THE ROW'S NAME. The hub refuses a
      // pointer as an end of a pair, so `latest` has to be the commit it
      // resolves to before anything is asked — and `dev` resolves to nothing,
      // which is what takes the tick off that row below.
      const commit = this.commitOf(r.id);
      const inCmp = !!commit && s.cmp.includes(commit);
      return {
        key: r.id,
        head: r.head || '',
        headStyle: r.head ? `padding:7px 14px 3px;font:600 9.5px ${MONO};color:var(--text-muted);letter-spacing:.09em` : 'display:none',
        id: r.pointer ? r.id : shortId(r.id),
        date: r.date,
        // IN THE PLACE THE SPACER USED TO HOLD, which is what keeps the row one
        // line: it takes the free width between the id and the date, and gives
        // it back by ellipsis when there is more text than room. `title` is the
        // rest of a long one, and a row with no message is the flexible gap the
        // spacer always was.
        message: r.message,
        messageStyle: `flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:400 11.5px ${SANS};color:var(--text-muted)`,
        idStyle: `font:600 12px ${MONO};color:` + (current ? 'var(--accent-text)' : r.pointer ? 'var(--note)' : 'var(--text)'),
        badge: current && !r.badge ? 'viewing' : r.badge,
        badgeStyle: `font:500 10.5px ${MONO};` + (r.pointer ? 'color:var(--text-muted)' : (current || r.badge) ? 'padding:2px 6px;border-radius:4px;background:var(--accent-bg);color:var(--accent-text)' : 'display:none'),
        // THE SOFT TINT AND NOT THE FULL ONE, because this row says "you are
        // here" and the tree's selected row a few pixels away says "you picked
        // this" — two markers the reader tells apart by weight rather than by
        // hue. One tint for both makes the picker shout and takes the
        // difference away; `--accent-bg-soft` is what the row was drawn in
        // before the palette existed, said as a role.
        style: 'display:flex;align-items:center;gap:4px;padding:7px 14px 7px 10px;' + (current ? 'background:var(--accent-bg-soft);' : '') + 'cursor:default',
        // NO TICK ON A ROW THAT NAMES NO COMMIT, which is the `dev` slot and
        // only it. A comparison is cached under the names it was asked with, so
        // both ends have to be permanent addresses, and the slot has none by
        // decision — `has_dev` is a flag, not an id. Offering the tick and
        // failing at the POST would be the same answer given later and as an
        // error; this is it given honestly, on the row. The box keeps its space
        // so that the rows below still line up under one another.
        cmpMark: inCmp ? '✓' : '',
        cmpStyle: `width:16px;height:16px;border-radius:4px;flex:none;margin-right:6px;display:flex;align-items:center;justify-content:center;font:600 10px ${MONO};cursor:pointer;` + (inCmp ? 'background:var(--accent);color:var(--text-on-accent);border:1px solid var(--accent-strong)' : 'border:1px solid var(--line-strong);background:var(--card-bg);color:transparent') + (commit ? '' : ';visibility:hidden;cursor:default'),
        onCmp: !commit ? undefined : stop(() => {
          let picked = s.cmp.includes(commit) ? s.cmp.filter((x) => x !== commit) : s.cmp.concat(commit);
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

    // -- the comparison panel, which stands where the tree stands
    //
    // FOUR THINGS CAN BE ON THE SCREEN HERE and only one of them is a list:
    // waiting for the hub, a refusal because this browser has no token, a
    // failure with the hub's own words in it, and the report. The first three
    // are one paragraph with a heading — a panel that draws an EMPTY LIST for
    // any of them would be saying "nothing changed", which is one of the
    // answers this block has to be able to give truthfully.
    const cmpPair = Array.isArray(s.cmpPair) ? s.cmpPair : [];
    const cmpRows = compareRows(s.cmpReport);
    const cmpDone = s.cmpStage === 'ready';
    const cmpNote = cmpDone ? null
      : s.cmpStage === 'locked'
        ? { head: 'This needs the editing token',
            body: 'A comparison is computed on request, and both of its documents'
              + ' are read under the same token that publishes. Add the token in'
              + ' the header, then press Compare again.' }
        : s.cmpStage === 'failed'
          ? { head: 'The comparison did not finish',
              body: s.cmpError || 'the hub did not say why' }
          : { head: 'Measuring the difference…',
              body: 'The hub is intersecting the two revisions part by part. It'
                + ' takes a second or two once the build queue reaches it.' };

    // -- the downloads, out of the part catalogue: key -> {extension -> file}
    const catalogue = (meta && meta.parts) || null;
    const fileHref = (file) => PAGE.base + encodeURIComponent(String(file));
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

    // -- the project's comment queue, as `loadFeed` fetched it
    //
    // THE WHOLE QUEUE AND NOT THIS SESSION'S NOTES. The rail used to list what
    // this page had posted since it opened, because that was the only copy of a
    // comment it had; the hub answers with the project's queue now, oldest first
    // (SPEC 7A.2), and the row number is the position in it — the same number
    // `sync` writes on the pin, so the badge on the model and the badge in the
    // rail name the same item.
    //
    // EVERY ROW SAYS WHERE IT HANGS, in words, because most of them cannot be
    // pointed at: a comment left on another revision follows its catalogue key
    // to whatever draws that part today, a comment on a part this view does not
    // draw has no pin at all, and a comment whose part has left the catalogue is
    // ORPHANED — a fact about the model, and the one the reader must not have to
    // infer from a missing pin.
    const anchoredAt = {
      commit: (meta && meta.commit) || null,
      published: (meta && meta.published) || null,
      view: s.view,
      keyRows: rowsByKey(s.tree),
      parts: catalogue || {},
    };
    const threads = s.feed.map((record, i) => {
      const anchor = anchorFor(record, anchoredAt);
      const resolved = record.status === 'resolved';
      // THE HEADING IS A ROW OF THE TREE ON SCREEN or it is the catalogue key,
      // and never the stored path used as a stand-in: on another build that
      // path is a number the tessellator was free to hand to something else.
      const node = anchor.state === 'point'
        ? this.node(record.part)
        : (anchor.state === 'part' ? this.node(anchor.path) : null);
      // TWO OF THE FIVE SENTENCES SAY LESS THAN THE OBVIOUS WORDING WOULD, and
      // both are shorter for the same reason: they were guessing at a cause the
      // record does not carry. `none` used to read "left before comments named
      // a part", which is one of its causes and not the common one — `measAdd`
      // and the place handler both send a null key TODAY, whenever nothing is
      // selected or the selected row is a GROUP, and a group has no catalogue
      // key at all. And `elsewhere` names the view the comment was left on,
      // which the hub is free to store as null (`validate_payload`), so the
      // interpolation printed the word "null" at the reader.
      const says = {
        point: 'left here, on this build',
        part: 'follows the part through the rebuild',
        elsewhere: record.view
          ? `the part is not in this view — left on ${record.view}`
          : 'the part is not in this view',
        orphan: 'the part this was left on is no longer in the catalogue',
        none: 'not tied to a part',
      }[anchor.state];
      return {
        key: record.id,
        label: String(i + 1),
        part: (node && node.name) || record.key || '',
        time: stamp(record.created),
        text: record.text,
        says,
        style: 'padding:10px 12px;background:var(--card-bg);border:1px solid ' + (s.activePin === record.id ? 'var(--accent-line)' : 'var(--line)') + ';border-radius:8px;cursor:pointer;' + (resolved ? 'opacity:.62' : ''),
        // RESOLVED IS A LIGHTER GREY HERE THAN ON THE CANVAS, and that is the
        // ground rather than an inconsistency: this badge sits on a card in the
        // rail, where the ordinary chip fill is already a visible pill, while
        // `.hmr_pin.is_resolved` sits on the 3D MODEL, where nothing lighter than
        // `--line-strong` keeps a silhouette against a white canvas. Same badge,
        // two backdrops, two weights — which is why they were two literals before
        // they were two roles.
        pinStyle: `width:20px;height:20px;border-radius:10px 10px 10px 3px;flex:none;display:flex;align-items:center;justify-content:center;font:600 10.5px ${MONO};` + (resolved ? 'background:var(--chip-bg);color:var(--text-muted)' : 'background:var(--accent);color:var(--text-on-accent)'),
        // An orphan is the one anchor state that is news about the model rather
        // than about where the pin went, so it is the one that is coloured.
        saysStyle: `margin-top:6px;font:400 10.5px/1.5 ${MONO};color:`
          + (anchor.state === 'orphan' ? 'var(--warn)' : 'var(--text-muted)'),
        onOpen: stop(() => this.set({ activePin: record.id })),
        resolved,
        // A real request since step 0 — see resolveComment. Closing an item is
        // still mostly the agent's move; what changed is that the person who
        // raised it can now take it back without one.
        onResolve: stop(() => { if (!resolved) this.resolveComment(record.id); }),
      };
    });
    const openCount = s.feed.filter((c) => c.status !== 'resolved').length;

    // -- context menu on a tree row
    const mNode = this.node(s.menu && s.menu.id);
    // THE SECTION'S ROW IS THE ONE SUBJECT OF THIS MENU THAT IS NOT A NODE, and
    // it is asked for by name rather than faked into one. A stand-in node would
    // have to carry `leaves`, a `key` and a `name` it does not have, and every
    // item below reads at least one of the three — so the fake would reach
    // Isolate, the files and Copy name, all of them about a part that is not
    // there. `mNode` stays `null` for it (`SECTION_ROW` is no tree path), which
    // is what keeps those items off; the two branches below add the ones that
    // ARE about the cut.
    const secMenu = !!(s.menu && s.menu.id === SECTION_ROW);
    // ONE RESET BEHIND TWO DOORS — the section popover's `reset` button and the
    // row menu's Delete. They are one closure and not two copies of the same
    // four fields, because the fields are not the whole of it: the `__resetCut`
    // beside them is what tells the viewport to drop the plane as well
    // (`element.js`), and a copy that lost it would leave the cut on screen
    // while every field on this side read as cleared.
    const clearSection = () => this.set(
      { secOn: false, secFace: null, secOff: 0, secFlip: false },
      { __resetCut: true });
    // WHETHER THERE IS A SECTION FOR Delete TO CLEAR, which is the four fields
    // above standing anywhere but where that call would put them. NOT `s.secOn`:
    // the eye on the row takes the cut off the screen and deliberately KEEPS the
    // plane and the offset, so a Delete that read an unlit row as "no section"
    // would decline on exactly the state it exists to clean up.
    const secSet = s.secOn || !!s.secFace || s.secOff !== 0 || s.secFlip;
    // TWO NAMES, AND THE MENU USES BOTH FOR DIFFERENT THINGS. `mName` is the
    // row's own label and is what the menu is headed with — it addresses the
    // ROW, which is one solid in one view UNLESS the row collapsed repeats of
    // one part, and then it is all of them. `mKey` is
    // the catalogue key and is what everything about the PART is looked up
    // under: its note, its files. A group has no key and neither has a leaf
    // that names none, and in both cases the answer is that this row has
    // nothing in the catalogue — never the name used as a stand-in (issue #75).
    //
    // THE COUNT IS ON THE HEADER because the items below it act on the whole
    // row: Hide takes `mNode.leaves`, so a menu headed plain `pin` over a row
    // of five would hide five parts having named one. Copy name is the other
    // half of the same decision and deliberately copies `mNode.name` bare —
    // what goes on the clipboard is a part's name, not a tally of it.
    //
    // A GROUP IS EXCLUDED, on the same ground the tree row gives next door: it
    // would not be the same quantity. A group's `leaves` is every leaf path
    // UNDERNEATH it (`indexTree`), so `housing ×7` reads as seven housings when
    // the seven are the parts inside one. Hide does act on all seven — the
    // argument above holds for a group word for word — but a header naming the
    // wrong quantity is worse than one naming none. What does NOT carry over is
    // the tree row's second remark, that the number is drawn on the right
    // anyway: this menu has no meta column, so nothing here shows it at all.
    //
    // THE SECTION HEADS ITS MENU WITH THE WORD ON ITS ROW, which is the constant
    // the id is: a menu headed anything else would read as being about a part.
    const mName = secMenu ? SECTION_ROW : (mNode && !mNode.isNode
      ? countedName(mNode.name, mNode.leaves.length)
      : (mNode ? mNode.name : ''));
    const mKey = (mNode && mNode.key) || '';
    // Through `noteFor` like the other read of the reader's map. This one throws
    // EARLIEST of the two when it is not: the item below slices the note to 22
    // characters for its hint, and a part called `constructor` hands a bare
    // lookup a function, which has no `slice` — so the whole menu, and with it
    // `computed()` and the page, ends on a right-click.
    const note = noteFor(s.notes, mKey);
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
        + (tone === 'said' ? 'cursor:default;color:var(--text-faint)' : 'cursor:pointer;color:var(--text)')
        + (tone === 'top' || tone === 'said' ? ';border-top:1px solid var(--line-soft)' : ''),
      onClick: tone === 'said'
        ? undefined
        : stop(() => { fn(); this.setState({ menu: null }); }),
    });

    /**
     * What arming the manipulator on `id` says, which is ONE sentence because
     * there is one widget.
     *
     * Two rows arm it — Move and Turn — and they used to raise two sentences
     * because they armed two tools. Now there is a single manipulator round the
     * part (`viewport/gizmo.js` and `viewport/rings.js`): an origin dot and
     * three arrows and three plane quads that slide it, and three coloured
     * discs that turn it, all at once. A sentence naming only one half would
     * leave the reader who came in through that row never looking for the
     * other, which is the whole of what merging the tools was for.
     *
     * THE TAIL IS STILL TWO SENTENCES, and it has to be: a part of the BUILD
     * moves as a statement to the agent and the model is untouched, so the next
     * rebuild puts it back; a body of the PROPOSAL moves as an edit of the
     * document the reader is authoring, so it stays. One tail would be false on
     * one of them.
     */
    const armedSaid = (id) => (this.proposalBody(id)
      ? 'Drag it to slide, a coloured disc to turn — the proposal keeps the body where you put it'
      : 'Drag it to slide, a coloured disc to turn — it snaps back on the next rebuild');

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
     * BOTH EMPTY CASES SAY SO OUT LOUD. A part that is not printed — a bought
     * screw, a mock of something bought — has no files and never will, and a
     * menu that silently dropped the item would read as a menu that forgot.
     * Same for a build that ships nothing: the header's menu has a sentence for
     * that case and this one must not be worse.
     *
     * A ROW WITH NO KEY LANDS ON THE SAME SENTENCE, through `partRecord`
     * answering `null` for an empty key. It is the honest answer: the row names
     * no catalogue entry, so there is nothing here that is this row's.
     *
     * TAKEN OFF `files` AND NEVER OFF `kind`, though the two say the same thing
     * on any document the hub accepted (`_catalogue` refuses a printable with
     * no files and a non-printable with some). `files` is what actually names
     * the files, so reading it is one question with one answer; reading `kind`
     * and then trusting `files` to match would be two, free to disagree on the
     * one document nobody validated. `preview` sits in the same record and is
     * deliberately not read: see `fileList`.
     */
    const fileRows = (key) => {
      if (!anyDownloads) return [mi('No files in this build', '', () => {}, 'said')];
      const files = fileList(partRecord(catalogue, key));
      if (!files.length) return [mi('No files for this part', 'not a printable', () => {}, 'said')];
      return files.map((f, at) => mi(f.ext.toUpperCase(), f.file, () => {},
                                     at === 0 ? 'top' : '', fileHref(f.file)));
    };

    // THE ONLY QUESTION THE NARROW LAYOUT IS ASKED, and every answer that
    // depends on it is baked into a style string below rather than branched on
    // in `render()` — except where the change is which ELEMENTS exist, which no
    // string can express. `!!` because a state written by hand — which is how
    // every test in ui/tests builds one — need not carry the field at all, and
    // "not there" is the wide layout.
    //
    // ASKED THIS EARLY BECAUSE THE ROW MENU ASKS IT TOO, and it is the one asker
    // that sits above `computed`'s style strings rather than below them.
    const narrow = !!s.narrow;

    // WHILE A COMPARISON IS UP, VISIBILITY IS THE THREE TABS AND NOTHING ELSE.
    // `sync` sends the tabs' own hidden list and ignores `s.hidden`/`s.ghost`
    // while the scene is a comparison's, so the three visibility items below
    // would do NOTHING VISIBLE and write to the reader's build lists behind
    // their back — Isolate worst of all, which replaces `s.hidden` wholesale
    // with `/cmp/…` paths that match nothing in the build's tree, so the parts
    // they had hidden before comparing came back on screen when they closed the
    // panel. The same question `sync` asks, so the two cannot answer it
    // differently.
    //
    // MOVE RIDES IN THE SAME EXCLUSION ON ITS OWN GROUND, which is `toolsOff`'s:
    // a drag inside a comparison files a `/cmp/…` path as the part a comment is
    // about. Its row says so where it stands; it is in this block because the
    // block is where a row that must not be offered over a comparison goes.
    //
    // AND THE FILES GO WITH THEM, on a stronger ground than "they would do
    // nothing": they would do the WRONG THING quietly. The catalogue on this
    // page is `<a>`'s (`PAGE.base`, `meta.parts`), so a right-click on a part
    // inside `/cmp/rev b` — the geometry of the NEW revision, on screen, under
    // the cursor — offered `<b>`'s part under `<a>`'s file, with the same file
    // name on the row and nothing anywhere saying which revision came down.
    // Serving `<b>`'s would take `<b>`'s meta.json, which this page never
    // fetches; so the honest answer is to offer nothing, and the header's
    // Downloads menu goes on being `<a>`'s where it says so.
    const compared = !!this.comparePair();
    /**
     * The section's two items — the whole of what that row's right-click offers.
     *
     * EDIT IS THE POPOVER AND NOT A SECOND DIALOG. Clicking the row's name or
     * its subtitle already opens it; this is the same door reached by the
     * gesture every other row in the panel answers to, so what it writes is the
     * one flag that panel is drawn by. `openSecPop` itself is not called here:
     * it is built further down `computed()` and is `stop()`-wrapped for a DOM
     * event this closure does not have — `mi` has already stopped the click and
     * will close the menu behind us.
     *
     * AND DELETE SAYS SO RATHER THAN ACTING WHEN THERE IS NOTHING TO DELETE,
     * which is `fileRows`' rule for an item that does not apply: a grey row
     * stating the case, with no handler at all, instead of a live row that
     * quietly writes the values already in place.
     */
    const sectionItems = [
      mi('Edit', '', () => this.setState({ secPop: true })),
      ...(secSet
        ? [mi('Delete', 'clear the plane', clearSection, 'top')]
        : [mi('No section to delete', '', () => {}, 'said')]),
    ];
    const partItems = !mNode ? [] : [
      // HIDING EVERYTHING ELSE IS THE WHOLE OF IT, and the selection it used to
      // write alongside is gone (issue #83). `sel` reaches `selectSolid`, whose
      // shader REPLACES the part's colour with the selection blue — and colour
      // is an assertion in this interface, grey for a mock and the author's own
      // hue for everything else — so isolating a part destroyed the one thing
      // the reader isolated it to look at.
      ...(compared ? [] : [
        mi('Isolate', 'show only this', () => {
          const keep = new Set(mNode.leaves);
          this.setVisibility({ hidden: tree.leaves.filter((id) => !keep.has(id)) });
        }),
        mi('Hide', '', () => this.setVisibility({ hidden: this.toggle(s.hidden, mNode.leaves) })),
        mi('Translucent', 'see through it', () => this.setVisibility({ ghost: this.toggle(s.ghost, mNode.leaves) })),
        // THE MOVE TOOL, ARMED ON THIS OBJECT. It used to be a button in the
        // toolbar, which armed a gesture and left the reader to find the part
        // afterwards; here the object is already named, so the row can do both.
        //
        // AND IT SELECTS BEFORE IT ARMS, in one write, which is the half that
        // makes the row mean what it says. The armed tool drags what is
        // SELECTED and only falls back to the part under the cursor when
        // nothing is (`onDown` in viewport/tools.js) — and neither door into
        // this menu writes `sel`: a right-click on a tree row does not select,
        // and neither does one on the part in the scene. So Move chosen here
        // while another object stood selected would have dragged that other
        // one, or refused the press.
        //
        // ARMED AND NOT TOGGLED, unlike the toolbar buttons `setTool` draws: a
        // row of a menu that closes behind it is not something a reader presses
        // a second time to undo. Escape still disarms, as it always did.
        //
        // AND THE SELECTION IS WHY THE ROW IS OFFERED ON A PROPOSAL BODY TOO,
        // rather than being the one kind of object this is kept off. Such a body
        // needs the same armed tool as any part (`onDown` returns on no tool at
        // all), and an armed tool drags what is SELECTED: a press outside a
        // standing selection is refused whole. So a row offered on the parts and
        // withheld from the bodies would arm the tool holding a PART every time,
        // and the first grab on a body would be refused.
        //
        // NOT UNREACHABLE — ONE GESTURE MORE, AND AN OBSCURE ONE. The refused
        // press degrades to a plain one, so a CLICK on the body selects it and
        // the drag after that takes it. A drag is not a click, though: a press
        // that travels goes to `conclude` instead (`onUp` in viewport/tools.js)
        // and rotates the view, selecting nothing. So a reader who simply tries
        // to drag the body gets an orbit, and the step that would have worked is
        // one they had no reason to try.
        //
        // THE SENTENCE IS NOT THE SAME FOR THE TWO, because the surprising half
        // differs. A part of the MODEL moves as a statement to the agent and the
        // model is untouched, so it goes back where the build put it. A body of
        // the PROPOSAL moves as an edit of the panel's own document, which is
        // the thing the reader is authoring — it stays where it is put, and the
        // numbers in the panel follow it.
        //
        // AND A GROUP IS REFUSED BY THE SAME ARITHMETIC THE BODIES ALMOST WERE.
        // `selectedPaths` spreads a LEAF into the copies of its part, but a group
        // it leaves as the node's own path — so arming from a group row puts one
        // path in the selection that no press will ever hit, and every grab on a
        // part inside that group is then outside the selection and refused. The
        // only press that moves anything is one that MISSES the model, which
        // takes the whole sub-assembly. A row promising to move this object,
        // which then turns every grab on it into an orbit, is worse than no row:
        // `Note` and the file rows already stand off a group for reasons of
        // their own, and this is a third.
        //
        // THREE MORE THINGS TAKE IT AWAY, each answering a different question.
        // `viewer` is about who the reader IS: both kinds of drag end in the
        // proposal document, which travels to the agent as a comment and is
        // behind the token either way, so a reader without one has nothing to
        // move a thing FOR — and the panel that holds it is gone too. `narrow`
        // is about the WINDOW: the toolbar drops every tool at that width and
        // the crossing disarms the one in hand (`componentDidMount`), because
        // there is no room to aim on a phone, and a row that armed one anyway
        // would hand back exactly what narrow takes away.
        //
        // AND THE THIRD IS WHETHER THIS HUB HAS A PANEL AT ALL. `proposal_panel`
        // is off by default (src/settings.py), and where it is off the panel is
        // left out of the tree entirely (`v.proposalOn` in `render`) — so a
        // displacement would have nowhere to be. It IS a node of the proposal
        // now: no panel means no row saying a part is out of place, no `×` to
        // put it back, and no projection to send it to the agent in, which is
        // ui-brief block 6 unanswered in all three of its parts. The part would
        // simply stand displaced until the next rebuild. Offering the tool and
        // then dropping what it produces is worse than not offering it.
        //
        // `proposalPanelOn()` DIRECTLY and not `v.proposalOn`, because this menu
        // is built above where that key is computed; the call is one attribute
        // lookup and the function's own note says it is meant to be spent where
        // the answer is wanted.
        //
        // The comparison is the fourth, and it is the block above rather than a
        // condition here: a drag inside one puts a `/cmp/…` path in `partId`,
        // which is what `toolsOff` refuses everywhere else.
        ...(viewer || narrow || mNode.isNode || !proposalPanelOn() ? [] : [
          mi('Move', '', () => {
            this.set({ sel: mNode.id, selName: mNode.name, tool: 'move' });
            this.toast(armedSaid(mNode.id));
          }),
          // TURN ARMS THE SAME TOOL THE ROW ABOVE DOES, and there is nothing
          // left in `tool` to tell the two apart with. It used to arm nothing,
          // because a displacement had a gesture — the hand says "about here"
          // better than a field does — and a turn had none: it was three
          // numbers, typed into the row in the proposal's branch. Then it armed
          // a `turn` tool of its own, and the reader had to put a part down
          // before they could turn it. The widget is one manipulator now —
          // arrows, quads and an origin in viewport/gizmo.js, rotation handles
          // in viewport/rings.js, all of it answering to `move` — so this row
          // arms that, in the same two writes as the one above and for the same
          // reason: the armed tool works on what is SELECTED, and neither door
          // into this menu writes `sel`.
          //
          // WHICH LEAVES IT A ROW WORTH KEEPING, and that is not obvious from
          // the line itself. Everything ELSE it does is still its own — the
          // node it mints, the panel it opens — and those are what a reader who
          // means "exactly 90 degrees" came to this row for. What it no longer
          // does is promise a different gesture from Move, because there is no
          // longer a different gesture to promise.
          //
          // GATED EXACTLY AS MOVE IS, and the extra gate this row used to carry
          // is gone with the reason for it. It excluded a BODY OF THE PROPOSAL,
          // because what the row produced was a MOVE NODE and a move node
          // naming an overlay path is a second way to turn a body that already
          // has a `rot°` of its own — `move "motor" turned (…)` printed for an
          // agent beside that body's own `rot (…)`. The GESTURE has no such
          // problem: the viewport tells the two apart at the press exactly as
          // it does for a drag, and a body's turn goes out on
          // `hmr:proposalturn` and edits that very `rot`. So the tool is armed
          // on either kind of object, and only the node-minting below is still
          // the build's alone.
          //
          // AND IT GOES ON MAKING THE ROW, which is the half that is easy to
          // read as leftover and is not. A gesture says "about this much" and a
          // field says "exactly 90", and a reader who wants the second has
          // nowhere to type it until some node claims the part. So the row
          // still mints one for a part nothing has claimed yet and still opens
          // the panel, and the gesture then edits the node that is already
          // there rather than minting a second.
          //
          // A PART THAT ALREADY HAS A ROW GETS NO SECOND ONE. Two nodes
          // claiming one path are two contradictory statements about it in the
          // projection and two rows of which only one `×` appears to do
          // anything — the very thing `recordGesture` matches by intersection
          // to avoid. The row is already there; the panel is all this has left
          // to open.
          //
          // AND IT IS NOT A RETRACTION. The rule that drops a node reported at
          // zero is about a GESTURE — the reader taking a displacement or a
          // rotation back by hand — and says nothing about a node minted here,
          // which is a row asked for rather than a statement withdrawn. Nothing
          // else drops one: the push that follows claims these paths, and
          // `reconcileMoves` leaves a part standing exactly where it is.
          mi('Turn', '', () => {
            const body = this.proposalBody(mNode.id);
            this.set({ sel: mNode.id, selName: mNode.name, tool: 'move' });
            // THE SAME SENTENCE THE ROW ABOVE RAISES, because it is the same
            // widget and one of them would otherwise be describing half of it:
            // a reader who came in through Turn and was told only about the
            // discs would never find the arrows, and one who came in through
            // Move and was told only "drag it" would never find the discs.
            this.toast(armedSaid(mNode.id));
            // NO NODE FOR A BODY, which is the one thing left of the gate this
            // row used to sit inside: a body's pose is its own `rot` and a move
            // node about it would be the contradiction described above. The
            // fields it wants are already on its row.
            if (body) return;
            // `current` AND NOT `doc`, which `computed()` binds further down for
            // the panel's own rows: this closure runs long after that line, so
            // the name would resolve to a document read at a different moment
            // and it would take a reader two scrolls to find out which.
            const current = s.proposal || emptyProposal();
            const paths = mNode.leaves;
            const claimed = moves(current).some(
              (node) => node.paths.some((path) => paths.includes(path)));
            let next = current;
            if (!claimed) {
              this._proposalSeq += 1;
              next = addNode(current, {
                id: `m${this._proposalSeq}`,
                role: 'move',
                paths,
                // THE COUNTED NAME, exactly as a gesture records it: a row
                // standing for five copies of a part turns all five, and
                // `pin ×5` is what that reads as in the panel and in the
                // projection.
                name: mName,
                delta: [0, 0, 0],
                turn: [0, 0, 0],
              });
            }
            this.setState({ proposalOpen: true });
            this.setProposal(next);
          }),
        ]),
      ]),
      // A NOTE IS FILED UNDER THE CATALOGUE KEY, so a row that has none is not
      // offered one — and the reason is the WRITE, not the catalogue. A note
      // lives in localStorage and is never looked up in `meta.parts`: a leaf
      // whose key the catalogue does not declare gets this item and should,
      // because the reader's sentence is theirs rather than the build's. What
      // an empty key breaks is `notesWith`, which hands the map back UNTOUCHED
      // (`if (!key) return next`) — so the item on such a row would take the
      // text, close the dialog exactly as a successful save closes it, and
      // store nothing, with nothing anywhere saying so.
      //
      // DO NOT "FIX" THIS INTO `partRecord(...)`: that would take the note away
      // from a keyed leaf the catalogue happens not to declare, which is a row
      // this page is built to survive.
      //
      // `mKey` is empty on a group and on a leaf that names no key, which is
      // why the condition asks about it rather than about `isNode`.
      ...(viewer || !mKey ? [] : [mi('Note', note ? (note.length > 22 ? `${note.slice(0, 22)}…` : note) : '',
        () => this.setState({ notePop: mKey, noteDraft: note || '' }))]),
      // Files hang on a PART, so a group row has none of its own — the same rule
      // and the same reason as the note above it. A group is not a printable and
      // has no catalogue record of its own, so the union of its leaves' files is
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
      ...(compared || mNode.isNode ? [] : fileRows(mKey)),
      // WHAT IS COPIED IS THE PART, and inside a comparison the row's own label
      // is not it. The scene numbers the pieces of one difference apart —
      // `plate #1`, and a vent slot widened by 0.4 mm came out as twelve of them
      // (`cadbuild/comparescene`) — so `mNode.name` on a difference leaf is an
      // internal piece label that names nothing a reader can look up, in the
      // catalogue, in the report beside it, or in `model.py`. The catalogue key
      // is what all three speak, and it is what the panel's own rows print.
      //
      // THE ROW'S NAME REMAINS THE ANSWER EVERYWHERE ELSE, unchanged: on a build
      // page a leaf's name IS the part as the reader is shown it, and a
      // collapsed run copies the name bare rather than the tally (the header
      // above). A group inside a comparison has no key, and falls back to its
      // own name, which for `/cmp/rev a` is exactly what it says.
      mi('Copy name', '', () => {
        const name = (compared && mKey) || mNode.name;
        try {
          navigator.clipboard.writeText(name);
          this.toast(`copied: ${name}`);
        } catch (error) {
          console.warn('clipboard', error);
          this.toast('Could not copy the name');
        }
      }, 'top'),
    ];
    const menuItems = secMenu ? sectionItems : partItems;

    // `off` is a THIRD state, beside resting and active, and it is not `hide`:
    // the button stays where the reader left it and stops working, which is what
    // a control that is out of service FOR NOW has to look like — the argument
    // `bannerSwitchStyle` makes at length, and the two properties
    // `compareBtnStyle` already spells an unpressable button with. Last in the
    // string, so its `color` and `cursor` beat the resting pair above (`css`
    // keeps the last spelling of a property), and `pointer-events:none` is the
    // half that actually refuses the click.
    const btn = (active, hide, off) => `display:flex;align-items:center;gap:6px;padding:6px 11px;border-radius:6px;font:500 12px ${SANS};cursor:pointer;border:1px solid ` + (active ? 'var(--accent-line);background:var(--accent-bg);color:var(--accent-text)' : 'transparent;color:var(--text-soft)') + (hide ? ';display:none' : '') + (off ? ';color:var(--text-faint);cursor:default;pointer-events:none' : '');
    const tab = (active) => `padding:5px 13px;border-radius:5px;font:500 12px ${SANS};cursor:pointer;` + (active ? 'background:var(--card-bg);color:var(--text);box-shadow:0 1px 2px var(--shadow-soft)' : 'color:var(--text-soft)');
    const chip = (show, bg, border, color) => 'pointer-events:auto;display:' + (show ? 'flex' : 'none') + `;align-items:center;gap:8px;padding:7px 12px;background:${bg};border:1px solid ${border};border-radius:7px;font:500 11.5px ${SANS};color:${color};box-shadow:0 2px 8px var(--shadow-soft)`;

    // WHICH TOOL IS REALLY IN FORCE DOWN HERE, which is not always `s.tool`:
    // opening a comparison does not disarm one (the three handlers guard
    // themselves instead — `toolsOff`), so the field can name a tool that cannot
    // fire. Only the hint below reads this; the BUTTONS are drawn from
    // `s.tool === t` on purpose, so the one that is armed still shows as armed
    // while it is out of service and comes back armed when the panel closes.
    // `cut` is not one of the three and is left alone: the hold key sections a
    // comparison's scene like any other.
    const armed = this.toolsOff() && s.tool !== 'cut' ? null : s.tool;

    const setTool = (t) => () => {
      this.set({ tool: s.tool === t ? null : t, revOpen: false, dlOpen: false, viewsOpen: false, menu: null });
      if (t === 'comment' && s.tool !== 'comment') this.toast('Click a spot on the model to pin the task');
      if (t === 'measure' && s.tool !== 'measure') this.toast('Click a part for its size, or two for the gap between them');
    };

    // Two of these are reachable today. `building` and `failed` need a job id
    // this page does not have: `GET /api/v1/jobs/<id>` exists and is behind
    // EDIT_TOKEN, but nothing tells a build page which job produced it. The
    // brief (block 11) asks for all of them; what is missing is that link, not
    // the endpoint. (The front page does show the two words — issue #32 — off
    // the draft pointer, which a build page has no equivalent of.)
    const status = s.pending
      ? { text: 'new build ready', style: 'color:var(--accent-text);background:var(--accent-bg);border:1px solid var(--accent-line)', dot: 'var(--accent)' }
      : { text: isPointerPage() ? 'up to date' : 'pinned build', style: 'color:var(--text-soft);background:transparent;border:1px solid transparent', dot: 'var(--ok)' };

    const railOpen = s.rail === null ? this.props.commentsOpen : s.rail;
    const cutOn = s.secOn || s.held;

    // A POPOVER AS ONE SHEET ALONG THE BOTTOM EDGE. Panels on this page are
    // placed from the CONTROL that opens them, which at phone width puts them
    // off the side of the screen — and the root above is `overflow:hidden`, so
    // what hangs off it is CUT OFF rather than scrollable. Which panels take
    // this is asserted in `narrow.test.js`, not listed here.
    //
    // `fixed` RATHER THAN `absolute`, and that is the half that does the work:
    // `left`/`right` resolve against the containing block, which for a panel
    // placed this way is its own control's wrapper — a couple of hundred
    // pixels, and after the header wraps not at the window's edge any more — so
    // an absolute clamp would make the sheet NARROWER than the popover it
    // replaces and leave it off the side as well. Fixed resolves against the
    // viewport.
    //
    // ANCHORED TO THE BOTTOM, and that is not a taste: the header above is
    // wrappable BY CONSTRUCTION, so its height is 50px, or two rows, or three,
    // and with a tab strip under it more again. Every constant measured from the
    // top of the window therefore has a header height at which it opens ON TOP
    // OF the button that opened it — and the token sheet stops clicks, so that
    // covered button could not then be pressed at all. The bottom edge of the
    // window is the one anchor nothing above it can move. What the sheet covers
    // instead is the toolbar, which on narrow is the view tabs and Fit:
    // somebody picking a revision is not switching views at the same moment.
    //
    // `top:auto` because `css()` splits on `;` and the LAST spelling of a
    // property wins: it is what keeps a `top` out of the branch whatever the
    // wide string beside it says.
    const popSheet = 'position:fixed;left:8px;right:8px;bottom:8px;top:auto;width:auto;';

    // `|| []` because `computed()` runs over a state built by hand as often as
    // over the constructor's: every test file in ui/tests spells the fields out,
    // and a field added here would otherwise take down the ones written before
    // it existed, at `.length`.
    const openTabs = s.tabs || [];

    // The views this build declares, and the one on screen, read once: the
    // switcher below asks three separate questions of them — how many there
    // are, which is active, what it is called — and three reads of `meta.views`
    // are three chances for the button to name a view the rows disagree with.
    const views = (meta && meta.views) || [];
    const shownView = views.find((v) => v.id === s.view);

    // Both notes on the part in front of the reader, read once: the box below
    // asks three questions of each of them (is it there, does the box open, does
    // a rule go between them) and a method call per question would let the two
    // halves of one box answer from two different reads.
    const authorNote = this.authorNote();
    const readerNote = this.selectedNote();

    // -- the proposal: a rough body in numbers, laid over the model -----------
    //
    // WHETHER THIS HUB HAS THE PANEL AT ALL, asked once for the two styles that
    // gate it below. It is not state and nothing on this page can change it —
    // see `proposalPanelOn`, which says where the answer comes from.
    const proposalOn = proposalPanelOn();

    // `|| emptyProposal()` for the reason `openTabs` above carries its `|| []`:
    // every test file in ui/tests spells the state out by hand, and a field
    // added here would otherwise take down the ones written before it existed,
    // at `.nodes.length`.
    const doc = s.proposal || emptyProposal();

    // EVERY DIMENSION AND EVERY PLACEMENT IS A NUMBER and nothing else — the
    // whole of the language `proposal.js` defines, with no expression syntax and
    // deliberately none coming. So this is the entire parser, and it is the same
    // one for a size, a place and an angle: they all reach the kernel raw
    // (proposalgeom.js, `placed`), where anything that is not a number arrives in
    // an arithmetic and comes out as NaN — geometry that renders as nothing,
    // with nothing said about it.
    //
    // AN EMPTY FIELD IS A ZERO, and what that decides is what the reader is
    // shown while they are mid-edit: a zero builds, so the body goes flat until
    // the next digit lands, which is visibly about the field they are typing in.
    const num = (raw) => {
      const value = Number(String(raw).trim());
      return Number.isFinite(value) ? value : 0;
    };
    // AND A FIELD THE BROWSER COULD NOT READ IS NOT AN EMPTY ONE. A number input
    // reports `""` for text it cannot parse, and `num` answers 0 for that, so a
    // field in that state committed a zero and flattened the body.
    //
    // WHICH TEXT actually reaches it was measured rather than reasoned about —
    // Chrome 153, a real `<input type="number">`, one keystroke at a time,
    // reading `value` on every `input` event. A lone `-` and a lone `.` do:
    // `""` with `badInput` set. NOTHING ELSE DOES — `.5` reads back as `.5`, and
    // a trailing dot is dropped rather than emptying the field, so `12.` reads
    // back as `12`. So the case this is here for is a sign or a point typed as
    // the first character of a number and then abandoned, the focus leaving on a
    // click elsewhere: without this, a dimension the reader never finished
    // typing goes to zero and the body goes flat.
    //
    // `badInput` is the platform's own answer to "there is text in here and I
    // could not read it", and it is the only thing that tells that apart from
    // the genuinely empty field the rule above is about. It is `false` on a text
    // input, so the name and the profile pass through it unchanged.
    const unread = (target) => !!(target && target.validity && target.validity.badInput);
    // `x,y; x,y; …`. A PAIR THAT DOES NOT READ AS TWO NUMBERS IS DROPPED rather
    // than guessed at, and `num` is the wrong parser for it: it answers 0 for
    // anything that is not a number, so `a,b` came through as a corner at the
    // origin and `20,` as one on the axis — a point nobody typed, in a profile
    // they are looking at. An empty field is not a number either, which is what
    // makes the trailing `;` somebody types before the next point cost nothing
    // while they think about it.
    const coord = (text) => (text.trim() ? Number(text.trim()) : NaN);
    const points = (raw) => String(raw).split(';')
      .map((pair) => pair.split(',').map(coord))
      .filter((pair) => pair.length === 2 && pair.every(Number.isFinite));
    const pointsText = (list) => list.map((pair) => pair.join(',')).join('; ');
    const swap = (list, index, value) => list.map((v, i) => (i === index ? value : v));

    // HOW FAR ONE NUDGE OF A NUMBER GOES. Every number of a body is an
    // `<input type="number">` with a step, so the arrows, the up/down keys and
    // the press-and-hold repeat are all the browser's own and none of them is
    // drawn here. TWO ANSWERS BECAUSE THERE ARE TWO KINDS OF NUMBER: a size and
    // a place are read in millimetres, where one is the unit somebody means by
    // "a bit bigger", while a turn is read in degrees, where the angles a body
    // is actually set to are the corners — a quarter turn, 45 at a diagonal —
    // and a degree a click would be two dozen clicks to reach any of them.
    const STEP_MM = 1;
    const STEP_DEG = 15;

    // One field of the panel: what it shows, and what typing in it does.
    // `commit` turns the raw text into the whole NEXT DOCUMENT, because that is
    // what `setProposal` takes — there is no partial write anywhere in here.
    // A `step` makes it one of the NUMBER fields; the name and the profile are
    // text and pass none.
    //
    // TYPING TOUCHES THE DRAFT AND NOTHING ELSE; the document is written on
    // `change` — a blur, an Enter, or a nudge of the arrows — which is the
    // browser's own event for "this field's value is settled" and what JSCAD's
    // parameter panel commits on. Per KEYSTROKE, which is what this used to be,
    // every character cost a whole scene: `setProposal` builds the bodies, hands
    // them to the viewport, and `restage` tears the model down and renders it
    // again with the tree going back up to React behind it. The CSG ALONE,
    // measured on this repository's own kernel (@jscad/modeling 2.13.0, vitest,
    // Apple M-series, mixed ops with every fifth body a hole): 0.3 ms at one
    // body, 23 ms at four, 81 ms at twelve — before any of the rest of it.
    // `-12.5` is five of those on the way to one number.
    const field = (key, value, commit, width, step) => ({
      key,
      // `number` IS WHAT BRINGS THE ARROWS, and it is the only thing that does:
      // the spinner, the up/down keys and the repeat on a held key are the
      // platform's, sized by `step`.
      type: step ? 'number' : 'text',
      step,
      // The draft while this is the field being typed in, the document
      // everywhere else. `typeProposal` says why both are needed.
      value: s.proposalDraft && s.proposalDraft.key === key
        ? s.proposalDraft.text
        : String(value === undefined || value === null ? '' : value),
      style: `width:${width};box-sizing:border-box;border:1px solid var(--line);border-radius:5px;outline:none;padding:3px 5px;font:400 11px ${MONO};color:var(--text);background:var(--card-bg)`,
      onChange: (e) => this.typeProposal(key, e.target.value),
      onBlur: (e) => this.commitProposal(key, e.target.value, commit, unread(e.target)),
      // ENTER IS THE OTHER HALF OF `change`, and it is here rather than left to
      // the blur because a reader who types a number and presses Enter has
      // finished with that field whether or not they move off it — a panel that
      // answered nothing until the focus left would read as one that had
      // stopped listening.
      onKeyDown: (e) => {
        if (e.key === 'Enter') this.commitProposal(key, e.target.value, commit, unread(e.target));
      },
      // THE WHEEL SCROLLS THE SHEET AND DOES NOT EDIT THE BODY. Over a FOCUSED
      // number input the wheel is a step of the value in both Chrome and
      // Firefox — `input`, `change` and all — and this panel is a tall sheet
      // somebody scrolls through: the ordinary way to reach the body below the
      // one just typed in is a wheel click with the cursor still standing on its
      // size field. That was ±1 mm per click of the wheel, ±15° in a `rot` row,
      // on a body nobody meant to touch; a text field had no such road.
      //
      // DROPPING THE FOCUS IS THE ONLY MECHANISM THERE IS, and it is enough: the
      // platform steps only a field that HAS the focus, and taking it away
      // leaves the scrolling untouched. Not `preventDefault` — React registers
      // the root's `wheel` listener as PASSIVE (react-dom 18.3.1), so a
      // `preventDefault` from here is ignored outright and would stop neither
      // the step nor the scroll. ON THE FIELD and not on the sheet, because a
      // wheel over anything else in here was never an edit. The blur it causes
      // is the ordinary one: a number typed and not yet committed commits,
      // exactly as it would have when the focus left any other way.
      onWheel: step ? (e) => e.target.blur() : undefined,
      // A NUDGE TAKES THE SAME ROAD AS A TYPED NUMBER — `commitProposal` — AND IT
      // NEEDS A REAL `change` LISTENER TO GET THERE. React's `onChange` is the
      // DOM's `input` event, which is the keystroke and lands in the draft; the
      // `change` the platform fires after a step of the spinner arrives at the
      // same handler and is then DROPPED by React's own value tracker, which
      // sees a value it has already reported. Measured against react-dom 18.3.1
      // rather than assumed. Wired to `onChange` alone, a nudge would move the
      // number in the field and leave the body on the model where it was.
      //
      // THE NODE'S OWN `onchange` PROPERTY and not `addEventListener`: a
      // property is replaced by the next render rather than stacked on top of
      // the last one, so there is nothing to remove and no way to end up
      // committing twice. A blur after typing fires `change` too, and what that
      // schedules wakes up behind the blur above, which has already committed the
      // same text: it finds no draft and does nothing.
      //
      // THROUGH `nudgeProposal` and not straight into `commitProposal`, because
      // an arrow held down is a run of `change` events and not one; that method
      // says what happens to the run.
      ref: step ? (el) => {
        if (el) {
          el.onchange = (e) => this.nudgeProposal(
            key, e.target.value, commit, unread(e.target),
          );
        }
      } : undefined,
    });

    // HOW EACH OP SPELLS ITS OWN SIZE, keyed the way `DIMS` in proposal.js and
    // `SHAPES` in proposalgeom.js are keyed — so an op that grows a dimension is
    // changed in three tables and nowhere else, and an op in only two of them
    // throws where it is looked up instead of drawing half a body.
    const SIZES = {
      box: (node) => ({
        label: 'size',
        fields: [0, 1, 2].map((axis) => field(
          `${node.id}.size.${axis}`, node.size[axis],
          (raw) => updateNode(doc, node.id, { size: swap(node.size, axis, num(raw)) }),
          '31%', STEP_MM)),
      }),
      // SPELLED OUT AND NOT MAPPED OVER `['d', 'h']`, which is the shorter way
      // and reaches for a computed key. `test_every_handled_event_is_imported_
      // from_events_js` reads `[x]:` out of this file as a handler key, and the
      // saving is two lines.
      cylinder: (node) => ({
        label: 'd · h',
        fields: [
          field(`${node.id}.d`, node.d,
                (raw) => updateNode(doc, node.id, { d: num(raw) }), '47%', STEP_MM),
          field(`${node.id}.h`, node.h,
                (raw) => updateNode(doc, node.id, { h: num(raw) }), '47%', STEP_MM),
        ],
      }),
      sphere: (node) => ({
        label: 'd',
        fields: [field(`${node.id}.d`, node.d,
                       (raw) => updateNode(doc, node.id, { d: num(raw) }),
                       '47%', STEP_MM)],
      }),
      extrude: (node) => ({
        label: 'h · profile',
        fields: [
          field(`${node.id}.h`, node.h,
                (raw) => updateNode(doc, node.id, { h: num(raw) }), '24%', STEP_MM),
          field(`${node.id}.profile`, pointsText(node.profile),
                (raw) => updateNode(doc, node.id, { profile: points(raw) }), '72%'),
        ],
      }),
    };

    // WHAT EACH OP IS THE MOMENT IT IS ADDED: a body big enough to see, at the
    // origin. Sizes rather than zeroes, because a zero builds perfectly well and
    // draws nothing — so a button that added one would read as a button that did
    // nothing at all.
    const NEW_BODY = {
      box: { size: [20, 20, 20] },
      cylinder: { d: 10, h: 20 },
      sphere: { d: 20 },
      extrude: { h: 5, profile: [[0, 0], [20, 0], [20, 10], [0, 10]] },
    };

    // THE FIRST FREE NAME, and for a harder reason than tidiness. A body's name
    // is its part's `name` in the payload and every body is drawn as a part of
    // its own — so two bodies under one name are one entry in the library's
    // groups map and one row in the tree, the second quietly standing in for the
    // first. This has to hold for a name the reader TYPES and not only for one
    // the + button mints: naming a body after the thing it stands for —
    // `motor`, `wall` — is most of what the panel is for.
    //
    // THE LOOP ITSELF IS `firstFree` IN proposal.js, beside the document it is a
    // fact about rather than here: what a name is when something already answers
    // to it is settled once, for a name the + button mints and for one the
    // reader types.
    //
    // AMONG THE BODIES AND NOT AMONG THE NODES (`bodies`), because a move node
    // carries a name too and it is a ROW OF THE BUILD's — `plate`, which the
    // reader never chose and cannot edit. Counted as taken, a part dragged in
    // the scene would rename the reader's own `plate` to `plate2` under their
    // hands, and the two names collide over nothing: one is a part in the
    // payload this panel builds, the other names a part in the model.
    const freeName = (wanted, exceptId) => {
      const taken = new Set(bodies(doc)
        .filter((node) => node.id !== exceptId)
        .map((node) => node.name));
      return firstFree(wanted, taken);
    };

    const addBody = (op) => () => {
      this._proposalSeq += 1;
      this.setProposal(addNode(doc, {
        id: `n${this._proposalSeq}`,
        name: freeName(`${op}${this._proposalSeq}`),
        op,
        role: 'solid',
        at: [0, 0, 0],
        rot: [0, 0, 0],
        ...NEW_BODY[op],
      }));
    };

    // -- the proposal, as a small tree of its own below the parts --------------
    //
    // THE WHOLE DOCUMENT IS ROWS AND THERE IS NO SECOND LIST. Every node gets
    // one — bodies and moves together, in the order the document holds them —
    // because they are the same kind of statement and the reader should have one
    // place to look at what they have said. The panel keeps what is ABOUT the
    // proposal rather than IN it: what it is for, the buttons that add a body,
    // what the kernel thinks of it, and the door out to a comment.
    //
    // A BRANCH OF THE INTERFACE AND NOT OF THE SCENE, which is what makes it
    // possible at all. `render()` in the library takes ONE root shape object and
    // `treeFromShapes` derives every id from where a part SITS, so a second root
    // would repath every part of the model from `/<root>/…` — and paths are
    // identities here: comments anchor to them, move nodes name them, a swap
    // carries hidden state keyed by them. A MOVE could not be a scene row in any
    // case: it is a sentence about a part of the build and exists in no scene.
    // So this is assembled from `this.state.proposal` and owes the tree nothing
    // but the rows it resolves bodies through.

    const proposalRows = doc.nodes.map((node) => {
      const isMove = node.role === 'move';
      // WHERE THIS BODY STANDS IN THE SCENE, BY NAME, whether or not the tree
      // has caught up. `staged()` in viewport/element.js re-roots every part of
      // the overlay under the group as `<group>/<part name>`, and a part's name
      // is the body's own (`part()` in proposalgeom.js) — so this is that same
      // spelling worked out from this side, off the group path the VIEWPORT
      // minted rather than off a second guess at what the group is called.
      //
      // COMPUTED RATHER THAN LOOKED UP, which is the difference that matters
      // below: the tree lags every edit by a whole re-stage, so a row that took
      // its identity from what the tree HOLDS would lose it for the length of
      // one — most visibly on a rename, where `selectionAfter` has already moved
      // the selection onto a path the tree does not have yet.
      const wanted = isMove || !overlayPath ? null : `${overlayPath}/${node.name}`;
      // THE ROW IN THE SCENE THIS ONE ANSWERS FOR. A body's is the part the
      // overlay staged for it; a move's is the row of the BUILD it displaces,
      // which is where its first path points — `paths` is the row's `leaves` at
      // the moment of the gesture, so the first of them is that row's own id.
      // Null for either wherever the tree cannot answer: nothing staged yet, a
      // document the kernel refused, a build whose part has gone.
      const scene = isMove ? this.node(node.paths[0])
        : (wanted && tree.nodes.get(wanted)) || null;
      // WHAT THE ROW SELECTS. The scene's path where there is a LIVE one, so
      // that clicking a body's row lights the body up exactly as clicking the
      // body does, and clicking a move's row lights up the part the sentence is
      // about — the only way to see what it displaced. The DOCUMENT's own node
      // id otherwise, which buys a row that still OPENS: the fields are how a
      // document the kernel refused gets repaired, and a row that could not be
      // opened would be a dead end with the error box standing over it.
      //
      // AND THE ID WHILE A COMPARISON IS UP, whatever the scene holds. The
      // paths of a comparison's scene are `/cmp/<a>:<b>/…`, which name a part no
      // revision has — and `sel` outlives the comparison, because
      // `leaveCompare` does not clear it the way `leaveBuild` does. Written
      // there and left standing, such a path is what `measAdd` would post as the
      // `partId` of a comment once the reader closed the panel and measured
      // something: a task filed against a string that resolves in no build, and
      // the exact class `toolsOff` refuses everywhere else. It is also the one
      // door of its kind now — `onPick` writes `cmpSel` under a comparison, the
      // parts tree is not drawn, and Move is not offered. A node id instead is
      // recognisably NOT A PATH, which is what `measAdd` asks.
      //
      // `sel` IS THEREFORE EITHER A LIVE PATH OR RECOGNISABLY NOT ONE, and that
      // is the property everything downstream leans on rather than a tidiness.
      const path = compared || !scene ? node.id : scene.id;
      // THE PAGE'S ONE SELECTION AND NOT A SECOND OF THE PANEL'S, asked three
      // ways because `sel` can honestly be any of three things and the row is
      // the same row under all of them:
      //
      //   * the DOCUMENT's id — selected while nothing was staged, or while a
      //     comparison was up, or on a document the kernel refused;
      //   * the path this body WANTS, which is what `selectionAfter` writes the
      //     moment a name is committed and what the tree will hold one re-stage
      //     later. Asked of `wanted` and not of `scene`, so the block does not
      //     shut for the length of that window — and on a refused document,
      //     where the re-stage never comes, does not shut for good;
      //   * the ROW the selection resolves to, which is how a COPY picked in the
      //     scene selects the row that collapsed it. That is a move's case: a
      //     body is one part and has no copies.
      const selected = s.sel === node.id
        || (!!wanted && s.sel === wanted)
        || (!!scene && selRow === scene);
      // THE EYE, THE GHOST SQUARE AND THE COLOUR ARE THE SCENE'S, so they are a
      // BODY's alone — `marks` is the row they come off, and it is null for
      // every move. A move draws NOTHING: it displaces a part the build already
      // draws, and that part keeps its own row, its own eye and its own colour
      // in the tree below, so a second set here would be two answers to one
      // question about one part. Held apart from `scene`, which a move does
      // have and needs — it is the row the sentence is ABOUT, and selecting the
      // move is how the reader finds out which part that is.
      //
      // AND NULL FOR EVERY ROW WHILE A COMPARISON IS UP, which is the one place
      // this branch inherited a control the parts tree never had: that tree is
      // not drawn during a comparison at all, and this one is — deliberately,
      // because a proposal is as true over a comparison as over a build. But
      // `sync` sends `hidden: diffHidden(s.diffShow), ghost: []` while the scene
      // is a comparison's and never looks at `s.hidden`/`s.ghost`, which is why
      // `menuItems` throws Isolate, Hide and Translucent away under the same
      // `compared`. Left standing, the eye went pale over a body still on
      // screen — a control saying it did something it did not — and wrote
      // rubbish besides: the overlay's path inside a comparison is
      // `/cmp/…/proposal`, so a path that exists in no build went into
      // `s.hidden` and rode on through `setVisibility` into the history and the
      // swap's carry. Silence is the honest answer, and it is the menu's.
      const marks = isMove || compared ? null : scene;
      const leaves = marks ? marks.leaves : [];
      const visible = leaves.filter((id) => !hiddenSet.has(id)).length;
      const eye = visible === 0 ? 'off' : visible === leaves.length ? 'on' : 'part';
      const ghosted = leaves.length > 0 && leaves.every((id) => ghostSet.has(id));
      return {
        key: node.id,
        move: isMove,
        name: node.name,
        // ONE STEP IN FROM THE `proposal` HEAD, which is the indent the parts
        // tree spends on a depth of one (`node.depth * 16` in `emit`), because
        // this branch is read as a tree beside that one.
        rowStyle: 'display:inline-flex;align-items:center;gap:2px;height:24px;padding:0 6px 0 3px;margin:0 0 1px 16px;border-radius:4px;background:'
          + (selected ? 'var(--accent-bg)' : 'var(--float-bg-soft)') + ';cursor:default',
        // DRAWN AS ABSENT RATHER THAN LEFT OUT on a row with nothing in the
        // scene: `visibility:hidden` keeps the boxes' width, so the names of the
        // two kinds of row stand in one column, and the browser gives a hidden
        // box no pointer events — there is nothing to press rather than a
        // control that answers nothing.
        marksStyle: 'display:flex;align-items:center;flex:none'
          + (leaves.length ? '' : ';visibility:hidden'),
        eyeOuter: eyeOuter(eye), eyeDot: eyeDot(eye), ghostIcon: ghostIcon(ghosted),
        dotStyle: 'width:9px;height:9px;border-radius:3px;flex:none;margin:0 4px 0 2px;background:'
          + ((marks && marks.color) || 'transparent'),
        // WHAT KIND OF STATEMENT THIS ROW IS, said in the word rather than left
        // to be inferred. A move's row used to be an indented name with three
        // invisible boxes in front of it — nothing on it said this was a part
        // of the build displaced rather than a body the reader had drawn, and
        // the two are the opposite claim about the same model. `move` and not a
        // badge or an icon, in the order and the spelling `proposalText` prints
        // (`move "bracket" by (…)`), so the row and the projection it travels
        // as read alike. NULL AND NOT `''` on a body: an empty string is a
        // child React renders as nothing and every reading of the tree still
        // reports, which is a blank where a reader of a test expects silence.
        kind: isMove ? 'move' : null,
        kindStyle: `flex:none;font:400 10px ${MONO};color:var(--text-faint);padding:0 2px`,
        // EXCLUDED FROM WHAT IS SENT, and from nothing else: the node stays in
        // the document, the body stays over the model, the part stays where the
        // move puts it. `!node.skip` is the whole of the read, which is what
        // makes a document written before this field existed a document with
        // nothing ticked off rather than one to migrate.
        skipIcon: skipIcon(!!node.skip),
        skipTitle: node.skip ? 'held back from the text sent to the agent'
                             : 'leave this out of the text sent to the agent',
        onSkip: stop(() => this.skipProposal(
          updateNode(doc, node.id, { skip: !node.skip }))),
        nameStyle: 'white-space:nowrap;cursor:pointer;padding-right:4px;font:400 12px ' + MONO
          + ';color:' + (leaves.length && eye === 'off' ? 'var(--text-faint)' : 'var(--text)'),
        // The same two writers every row of the parts tree uses, and for the
        // same reason: a swap in flight is carrying these lists across BY NAME.
        onVis: stop(() => this.setVisibility({ hidden: this.toggle(s.hidden, leaves) })),
        onGhost: stop(() => this.setVisibility({ ghost: this.toggle(s.ghost, leaves) })),
        // THE ROW'S PLAIN NAME WHERE THE SCENE CAN ANSWER, and the node's own
        // only where it cannot. `measAdd` heads a composer with `selName` when
        // the tree cannot place the selection and states that both doors put a
        // BARE name there — and a move node's name carries the count, `pin ×3`,
        // which is a tally of parts and not the name of one. The fallback is
        // only ever spent on a selection `measAdd` refuses to attach at all,
        // since a row the scene cannot place selects by its node id.
        onSelect: stop(() => this.set({
          sel: path, selName: scene ? scene.name : node.name,
        })),
        // THE CONTROL THE WHOLE FEATURE TURNS ON, on both kinds of row. A body
        // is deleted; a part goes home by having its entry deleted — offset and
        // turn together, because the node is the one statement that carried both
        // — and what happens next is the viewport's half: the push that follows
        // stops claiming the path, and `reconcileMoves` puts it back.
        onRemove: stop(() => this.setProposal(removeNode(doc, node.id))),
        removeTitle: isMove ? 'put it back where the build has it' : '',
        // THE SAME MENU THE ROW HAD IN THE PARTS TREE, given back. Isolate, Hide
        // others and Move were all reachable by right-clicking a staged body's
        // row there, and taking that row out of the parts tree took them with
        // it: the scene still has them on a right-click of the body itself, but
        // a reader who used the tree lost them with nothing saying where they
        // went. It resolves `marks` — the same node the old row was — so this
        // opens the menu `menuItems` already builds rather than a second one.
        //
        // A MOVE ROW HAS NONE, and null rather than a handler that declines is
        // how that is said. Nothing in that menu applies to it: Isolate and Hide
        // others are about geometry the node does not own, the Files are the
        // catalogue's, and Move and Turn would mint a second node over paths
        // this one already claims — which `menuItems` refuses anyway. What is
        // left is a menu ABOUT THE BUILD PART, opened from a row that only names
        // it, which is the confusion the whole branch exists to avoid.
        //
        // AND NOTHING ON A BODY THE SCENE CANNOT PLACE, for a plainer reason:
        // `menuItems` is `[]` for a path no row answers to, and `menuStyle`
        // opens on `s.menu` alone — so the gesture would put an empty box on the
        // screen.
        //
        // ASKED OF `scene` AND NOT OF `marks`, which are the same object outside
        // a comparison and deliberately not inside one. This gate is only about
        // whether there is a scene object to open a menu ABOUT; what belongs in
        // that menu over a comparison is `menuItems`' own question, and it
        // already answers it — everything that writes visibility or names a file
        // is gone under `compared`, and `Copy name` is what remains.
        onMenu: isMove || !scene ? null : stop((e) => {
          e.preventDefault();
          this.setState({ menu: { id: scene.id, ...menuAt(e.clientX, e.clientY) } });
        }),
        // THE FIELDS ARE THE ROW'S, SHOWN WHEN IT IS SELECTED. A tree row is one
        // 24px line, and a panel of numbers under every row at once is the tree
        // covering the model it describes — so the block opens under the row the
        // reader is looking at and the rest stay one line each. BUILT EITHER
        // WAY and hidden by the style, because a field carries a `ref` that
        // wires the browser's own `change` (`field` above): building them only
        // for the open row would make what the panel can commit depend on what
        // is on screen.
        fieldsStyle: 'display:' + (selected ? 'block' : 'none')
          + ';width:250px;box-sizing:border-box;margin:1px 0 5px 32px;padding:7px 8px;border:1px solid var(--line);border-radius:6px;background:var(--float-bg)',
        // A MOVE HAS NO NAME FIELD, NO OP AND NO ROLE. Its name is a row of the
        // BUILD's, resolved when the gesture landed and never chosen by the
        // reader; it draws no geometry, so there is no op to show and nothing
        // for `solid`/`hole` to be about.
        nameField: isMove ? null : field(`${node.id}.name`, node.name, (raw) => {
          const wanted = raw.trim();
          return updateNode(doc, node.id,
                            { name: wanted ? freeName(wanted, node.id) : node.name });
        }, '38%'),
        op: isMove ? '' : node.op,
        role: isMove ? '' : node.role,
        roleStyle: `padding:2px 7px;border-radius:4px;cursor:pointer;font:600 9.5px ${MONO};letter-spacing:.05em;border:1px solid `
          + (node.role === 'hole'
            ? 'var(--danger-line);background:var(--danger-bg);color:var(--danger)'
            : 'var(--line);background:var(--chip-bg);color:var(--text-soft)'),
        onRole: stop(() => this.setProposal(updateNode(doc, node.id, {
          role: node.role === 'hole' ? 'solid' : 'hole',
        }))),
        // THE SAME THREE-BY-THREE A BODY AND A MOVE HAVE ALWAYS BEEN DRAWN IN,
        // and the same `field`, because they are the same kind of number: a
        // move's `by` is an offset from wherever the build puts the part rather
        // than a place in the document's own space, and `turn°` is the same
        // three degrees about the same three axes a body's `rot°` is.
        groups: isMove ? [
          {
            key: 'delta',
            label: 'by',
            fields: [0, 1, 2].map((axis) => field(
              `${node.id}.delta.${axis}`, node.delta[axis],
              (raw) => updateNode(doc, node.id,
                                  { delta: swap(node.delta, axis, num(raw)) }),
              '31%', STEP_MM)),
          },
          {
            key: 'turn',
            label: 'turn°',
            fields: [0, 1, 2].map((axis) => field(
              `${node.id}.turn.${axis}`, node.turn[axis],
              (raw) => updateNode(doc, node.id,
                                  { turn: swap(node.turn, axis, num(raw)) }),
              '31%', STEP_DEG)),
          },
        ] : [
          { key: 'dims', ...SIZES[node.op](node) },
          {
            key: 'at',
            label: 'at',
            fields: [0, 1, 2].map((axis) => field(
              `${node.id}.at.${axis}`, node.at[axis],
              (raw) => updateNode(doc, node.id, { at: swap(node.at, axis, num(raw)) }),
              '31%', STEP_MM)),
          },
          {
            key: 'rot',
            // DEGREES, said on the row rather than assumed: the kernel takes
            // radians and `placed` converts, so a reader who read this as
            // radians would turn a body two and a half times and get something
            // that still looks like a box. It is also what the arrows step by —
            // `STEP_DEG` and not `STEP_MM`, because this is the one row of the
            // three whose numbers are not millimetres.
            label: 'rot°',
            fields: [0, 1, 2].map((axis) => field(
              `${node.id}.rot.${axis}`, node.rot[axis],
              (raw) => updateNode(doc, node.id, { rot: swap(node.rot, axis, num(raw)) }),
              '31%', STEP_DEG)),
          },
        ],
      };
    });

    // OPEN UNLESS THE READER FOLDED IT, which is what `!== false` says and a
    // truthy read could not: the branch is only ever drawn over a document that
    // has something in it, and a row that arrives already folded away is a row
    // they have to go and find. The expand-all and collapse-all buttons above
    // the tree are expressed over `tree.nodes` and say nothing about this one.
    const branchOpen = s.expanded[PROPOSAL_BRANCH] !== false;

    // IS THERE ANYTHING LEFT TO SEND — the master tick's own state, and what
    // pressing it does read backwards. `sendsNothing` is the same question asked
    // of the projection and answers true for an EMPTY document too, which is the
    // one reading that would be wrong here: a master drawn filled over a branch
    // that has no rows would say the reader had held something back. The branch
    // is not drawn at all in that state, so this is about the head of a branch
    // that has rows under it.
    const allSkipped = doc.nodes.length > 0 && doc.nodes.every((node) => node.skip);

    return {
      rootClick: () => this.setState({ menu: null, revOpen: false, dlOpen: false, viewsOpen: false, tokenPop: false }),

      // -- the header row ------------------------------------------------------
      //
      // `min-height` RATHER THAN `height`, AND IT WRAPS. Nothing that could be
      // dropped from this row makes it fit below the breakpoint: what is left —
      // the mark, the title, the revision picker and four controls — is still
      // wider than a phone, and the theme button #35 moved in here is a fifth.
      // A row that cannot break its line can only overflow,
      // and the root this sits in is `overflow:hidden`, so overflowing means
      // silently CUT OFF rather than scrolled: the comment button would simply
      // not be there. It grows a second line instead. Same fix, same reason, as
      // `static/_v/site.css` already makes on the resolver's copy of this header
      // — read the rule there, the argument is written out in full.
      headerStyle: 'min-height:50px;flex:none;display:flex;flex-wrap:wrap;align-items:center;'
        + 'gap:6px 12px;padding:0 16px;'
        + `background:${HEADER_BG};border-bottom:1px solid ${HEADER_LINE};position:relative;z-index:30`,

      // WHAT THE HEADER LETS GO OF FIRST, and each of these is chosen because
      // the page still says it somewhere else. The wordmark sits beside a mark
      // that stays and goes on linking home; the subtitle is a description of
      // the build (parts, views, size) and not a control, with the same counts
      // on the view tabs; and the status chip's dot is already on the revision
      // button next to it, while the one status worth interrupting somebody for
      // — a newer build — announces itself with the banner over the model.
      showWordmark: !narrow,
      showSubtitle: !narrow,
      showStatus: !narrow,

      title: (meta && (meta.title || meta.project)) || '',
      // THE COLUMN HOLDING THE TITLE HAS TO BE ABLE TO SHRINK, and it could
      // not: `flex:none` stood here, so the item kept its content width whatever
      // the window did, and the `text-overflow:ellipsis` on the title inside it
      // could never fire. A model named after its whole assembly pushed the row
      // past the edge of the window rather than being cut — the failure the
      // ellipsis was written to prevent, with the ellipsis in place.
      // `0 1 auto`: shrink allowed, grow still refused, because a title that
      // claimed the leftover room would push the picker beside it away from it.
      titleColStyle: 'display:flex;flex-direction:column;gap:1px;flex:0 1 auto;min-width:0',
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
      slotDate: meta ? stamp(meta.built) : '',
      revToggle: stop(() => this.setState({ revOpen: !s.revOpen, dlOpen: false, viewsOpen: false, tokenPop: false })),
      revBtnStyle: 'display:flex;align-items:center;gap:8px;padding:6px 11px;border:1px solid var(--line);background:var(--card-bg);border-radius:6px;cursor:pointer',
      revMenuStyle: (narrow ? popSheet : 'position:absolute;left:0;top:40px;width:430px;') + 'background:var(--card-bg);border:1px solid var(--line);border-radius:9px;box-shadow:0 10px 34px var(--shadow);z-index:40;display:' + (s.revOpen ? 'block' : 'none'),
      revRows,
      revEmpty: revRows.length === 0,
      // SHORTENED, like every other place this site prints a revision. A commit
      // is the digest of its sources (SPEC 7.7), so `s.cmp` holds 64 characters
      // per side and this label is a button in a 430px menu.
      cmpLabel: cmpReady ? `${shortId(s.cmp[0])} → ${shortId(s.cmp[1])}` : '',
      compareBtnStyle: `padding:7px 14px;border-radius:6px;font:600 12px ${SANS};cursor:pointer;` + (cmpReady ? 'background:var(--accent);color:var(--text-on-accent)' : 'background:var(--sunken-bg);color:var(--text-faint);pointer-events:none'),
      startCompare: stop(() => this.compareRevisions(s.cmp)),

      statusChipStyle: `display:flex;align-items:center;gap:7px;padding:6px 11px;border-radius:6px;font:500 11.5px ${SANS};` + status.style,
      statusText: status.text,
      statusDotStyle: `width:8px;height:8px;border-radius:4px;background:${status.dot};flex:none`,

      downloadGroups,
      dlToggle: stop(() => this.setState({ dlOpen: !s.dlOpen, revOpen: false, viewsOpen: false, tokenPop: false })),
      dlBtnStyle: btn(s.dlOpen) + ';border:1px solid var(--line);background:var(--card-bg)',
      // CLAMPED LIKE THE OTHER TWO. This one is a HEADER button and survives
      // everything the narrow branch drops, so its menu is reachable on a phone
      // — and `right:0` is measured from a button that, once the row has
      // wrapped, is no longer at the window's right edge: a 250px menu then
      // starts off the left of a 390px screen and is cut off by the root's
      // `overflow:hidden` with nothing to scroll.
      dlMenuStyle: (narrow ? popSheet : 'position:absolute;right:0;top:40px;width:250px;') + 'background:var(--card-bg);border:1px solid var(--line);border-radius:9px;box-shadow:0 10px 34px var(--shadow);padding:6px 0;z-index:40;display:' + (s.dlOpen ? 'block' : 'none'),

      // -- the token: the whole customer/viewer split, in one control
      viewer,
      tokenToggle: stop(() => this.setState({
        tokenPop: !s.tokenPop, tokenDraft: '', revOpen: false, dlOpen: false, viewsOpen: false })),
      tokenBtnStyle: btn(false) + ';border:1px solid ' + (viewer ? 'var(--line);background:var(--card-bg)' : 'var(--accent-line);background:var(--accent-bg);color:var(--accent-text)'),
      tokenLabel: viewer ? 'View only' : 'Editing on',
      tokenPopStyle: (narrow ? popSheet : 'position:absolute;right:0;top:40px;width:320px;') + 'background:var(--card-bg);border:1px solid var(--line);border-radius:10px;padding:13px 14px;box-shadow:0 10px 34px var(--shadow);z-index:40;display:' + (s.tokenPop ? 'block' : 'none'),
      tokenDraft: s.tokenDraft,
      tokenType: (e) => this.setState({ tokenDraft: e.target.value }),
      tokenSave: stop(() => {
        const value = s.tokenDraft.trim();
        if (!value) { this.toast('Paste the token first'); return; }
        writeToken(value);
        // The queue is behind the same token, so entering one is the moment it
        // can be asked for — from the callback, because `this.state.token` is
        // still the old one until the update lands.
        //
        // AND THE PROPOSAL COMES BACK ON THE MODEL, which is the other half of
        // what `tokenClear` did and has to be undone in the same breath. That
        // door shuts the eye as a DEFAULT for a reader who has stopped being an
        // editor; left standing across a round trip it stops being a default and
        // becomes a trap, because nothing connects it to the gesture that caused
        // it. The reader hands the token back, presses `add a box`, and the model
        // does not change — `stageProposal` would reach `proposalOverlay` and be
        // turned away by a flag set before they left.
        //
        // STAGED FROM THE CALLBACK for the same reason the feed is: the flag is
        // read inside those doors, so a push made before this update landed would
        // be refused by exactly the value being cleared.
        this.setState({ token: value, tokenPop: false, tokenDraft: '',
                        proposalOff: false },
                      () => {
                        this.loadFeed();
                        // AND THE STORED PROPOSAL, which is behind the same
                        // token: this is the second of the two doors the token
                        // arrives through, and `loadProposal` says why there is
                        // no third. From the callback for the reason the feed
                        // is: the request reads `this.state.token`.
                        this.loadProposal();
                        this.stageProposal(this.state.proposal || emptyProposal());
                      });
        this.toast('Editing is on in this browser');
      }),
      tokenClear: stop(() => {
        clearToken();
        // The feed goes with it: it was fetched under a token this browser no
        // longer has, and a reader without one may not read the queue at all.
        //
        // AND THE PROPOSAL PANEL, which is HIDDEN WITHOUT A TOKEN like Move
        // — everything it produces leaves this page as a comment. Left open it
        // is a panel the button no longer offers to reopen, with `add to
        // comment` gone from under it.
        //
        // AND THE PROPOSAL COMES OFF THE MODEL, THROUGH THE EYE — which is a
        // different thing from the bare `proposalOverlay(null)` that stood here,
        // and the difference is a state machine that cannot disagree with
        // itself. `proposalOff` is now the one answer to "is the proposal on the
        // model", and both doors to the viewport read it. Cleared by hand
        // instead, the overlay went off while that flag still said it was on —
        // and since the branch now survives this (it is drawn on the document
        // alone), the first edit through any of its rows called `setProposal`
        // and staged the bodies straight back onto a model this had just
        // cleared.
        //
        // WHY OFF AT ALL, given the panel is what carries the token: the reader
        // is giving up the right to edit, and a body standing over the model is
        // a statement they can no longer send. THE BRANCH STAYS, so the document
        // is still there to be read and the eye is still there to put it back —
        // this is a default and not a lock, which is the honest shape for it:
        // nothing here is a permission gate, and pretending otherwise would be
        // the invented adversary AGENTS.md warns about.
        //
        // BOTH PUSHES CARRY THEIR OWN ANSWER rather than leaning on the flag
        // they just set: `setState` has not landed when these run, so the doors
        // would still read the old `proposalOff` and push the proposal back
        // down. `null` and a document with no moves in it mean the same thing on
        // either side of that update, which is what makes the order not matter.
        // The moves need the second call at all because nothing else pushes
        // here, and without it the displaced parts would stand where they are
        // until some later edit happened to send a document.
        this.setState({ token: null, tokenPop: false, tokenDraft: '',
                        composer: null, notePop: null, feed: [],
                        proposalOpen: false, proposalOff: true });
        this.proposalOverlay(null);
        this.proposalMoves(dropMoves(this.state.proposal));
        this.set({ tool: null });
        this.toast('Token removed — back to viewing');
      }),

      // -- the tree, which on narrow is something you open ---------------------
      //
      // Wide, it floats over a corner of the model and there is room for both.
      // Narrow, it covers the thing it describes — so it starts closed and this
      // button in the header is what opens it. Its openness is state and only
      // state; the constructor says why it is not remembered.
      // AND NOT WHILE TWO REVISIONS ARE BEING COMPARED, which is the other way
      // the tree can be absent: the compare panel stands in its place, so the
      // button would be offering to open something the page is not drawing
      // either way.
      treeShown: !narrow || s.treeOpen,
      treeToggle: stop(() => this.setState({ treeOpen: !s.treeOpen })),
      treeBtnStyle: btn(false, !narrow || s.compare) + ';border:1px solid '
        + (s.treeOpen ? 'var(--accent-line);background:var(--accent-bg);color:var(--accent-text)' : 'var(--line);background:var(--card-bg)'),

      railToggle: stop(() => this.setState({ rail: !railOpen })),
      railBtnStyle: btn(false) + ';border:1px solid var(--line);background:var(--card-bg)' + (viewer ? ';display:none' : ''),
      // WHAT SEPARATES THE TWO STATES IS TONE, NOT INK CONTRAST, and saying so
      // plainly is the only honest version. White on `--accent` is 4.27:1 in
      // both themes and cannot be raised without moving the accent itself, so
      // the live pill is not the high-contrast one; and the resting pill
      // cannot be "the faint version" of it either, because a grey that looks
      // faint on a light page is a grey that stands out on a dark one. What
      // does carry across both themes and reads at 17px is the disc turning
      // BLUE — so that is the signal, and each state simply gets an ink its
      // own fill can be read with.
      //
      // WHICH MEANS THE RESTING PILL IS AN ORDINARY CHIP: the neutral chip
      // fill with the secondary ink on it, `--text-soft` on `--chip-bg` —
      // 6.51:1 in light, 8.36:1 in dark. It reads as a count at rest in both.
      //
      // IT WAS `--line-strong` UNDER WHITE, a line role spent as a fill on the
      // strength of a number measured in the light theme alone: white on light
      // `--line-strong` is 1.68:1, which is not "faint" but illegible, and on
      // the dark value it is 9.89:1 — so the resting pill came out CLEARER
      // than the live one, exactly backwards, in half the interface.
      railCountStyle: 'min-width:17px;height:17px;padding:0 5px;border-radius:9px;'
        + (openCount ? 'background:var(--accent);color:var(--text-on-accent)'
                     : 'background:var(--chip-bg);color:var(--text-soft)')
        + `;display:flex;align-items:center;justify-content:center;font:600 10px ${MONO}`,
      openCount,
      // A COLUMN BESIDE THE MODEL, OR A SHEET OVER IT. 300px taken out of the
      // width is a third of a phone's screen, and what is left is the thing the
      // page exists to show — so on narrow the rail stops being a column and
      // covers the body instead, the way the tree already does. It is the same
      // panel either way: it opens and closes by the same button and holds the
      // same threads.
      railStyle: (narrow ? 'position:absolute;inset:0;z-index:20' : 'width:300px;flex:none')
        + ';background:var(--header-bg);border-left:1px solid var(--line);display:'
        + (railOpen && !viewer ? 'flex' : 'none') + ';flex-direction:column;min-height:0',
      threads,

      // -- the theme, standing next to the comments ----------------------------
      //
      // WHERE THE ISSUE PUTS IT, in as many words: «кнопка — жить у
      // комментариев» (#35). It used to sit in the floating strip under the
      // model, with Measure and Fit, and that was right while it changed the
      // CANVAS and nothing else. It changes the whole page now, so the strip
      // that belongs to the viewport is the wrong drawer for it — and it is the
      // one part of this page a phone does not draw at all (`showTools`), which
      // is how a page-wide preference came to be unreachable at the width where
      // a reader is most likely to want the dark one.
      //
      // BESIDE THE COMMENTS BUTTON AND NOT INSIDE THE RAIL, which is the half
      // of that instruction worth writing down rather than deciding twice. The
      // rail is `display:none` two ways over — while it is closed, and for a
      // reader with no token at all — so a control living IN it would be a
      // preference you reach by opening a panel you may not even have. The
      // header row holds the comments control itself, wraps instead of being
      // clipped, and is drawn at every width and for every reader: the button
      // stands next to the comments and stays reachable.
      //
      // NO `stop()`, unlike the two buttons before it — this one is last in the
      // row and nothing follows it. Parts and Comments each open
      // something and must not have the same click close it again; this one
      // opens nothing, so letting the click reach `rootClick` is what makes a
      // press over here dismiss a menu left open over there.
      //
      // THE LABEL NAMES THE MODE THE READER IS IN, the way the access button
      // beside the token does; what it switches to is in the tooltip.
      themeDark: s.theme === 'dark',
      themeLabel: s.theme === 'dark' ? 'Dark' : 'Light',
      themeTitle: s.theme === 'dark'
        ? 'the whole interface is dark — click for light'
        : 'the whole interface is light — click for dark',
      themeBtnStyle: btn(false) + ';border:1px solid var(--line);background:var(--card-bg)',
      toggleTheme: () => this.applyTheme(s.theme === 'dark' ? 'light' : 'dark'),

      // -- the strip under the header: the projects this browser has been in
      //
      // A ROW OF ITS OWN and not part of the 50px header above, which is already
      // carrying a title, a picker, a status chip and four controls.
      //
      // BELOW TWO IT IS NOT DRAWN AT ALL — not drawn `display:none`, but absent:
      // a strip whose only link is the project already on screen is noise with a
      // border round it, and the row it would occupy is 30px off the model.
      //
      // WHICH ONE IS ACTIVE IS ASKED OF THE ADDRESS, `PAGE.pid`, and of nothing
      // else. Nothing stores it and no state here holds it, so the highlighted
      // pill cannot disagree with the page it is drawn on (store.js says why).
      // IT WRAPS, and that is not a detail. Ten pills at the 190px cap below,
      // with their gaps and this padding, is close to 2000px — wider than the
      // window this interface is drawn for, and the root above is
      // `overflow:hidden`. A row that cannot break its line can only overflow,
      // and overflowing under `overflow:hidden` means silently CUT OFF rather
      // than scrolled: the eleventh project this browser opened would evict the
      // coldest tab, and the reader would watch a strip that never changed. It
      // is the same failure `static/_v/site.css` fixed on the resolver's own
      // header, and it is fixed here the same way — wrap, so a full strip grows
      // a second row instead of losing its tail.
      tabsShown: openTabs.length > 1,
      tabsStyle: 'flex:none;display:flex;align-items:center;flex-wrap:wrap;gap:4px;padding:5px 12px;'
        + `background:${HEADER_BG};border-bottom:1px solid ${HEADER_LINE}`,
      tabs: openTabs.map((t) => ({
        key: t.pid,
        // The pointer-less URL, exactly what a card on the front page links at:
        // a tab is a PROJECT, and which revision of it opens is the reader's own
        // remembered answer rather than this strip's to decide (hub.projectUrl).
        href: projectUrl(t.pid),
        label: t.title,
        // The pill the view switcher is drawn with, so "the one you are on"
        // reads the same way here as it does there rather than in a second
        // visual language invented for one row.
        style: tab(t.pid === PAGE.pid)
          + ';display:flex;align-items:center;gap:7px;max-width:190px;text-decoration:none;color:inherit',
        // Capped and ellipsised like the header's title: a model named after its
        // whole assembly must not be able to push the page wider than the
        // window, and ten of them must not push the strip off the side.
        labelStyle: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
        // BOTH CALLS, and `preventDefault` is the one that does the work here:
        // the ✕ sits INSIDE the anchor, so stopping React's synthetic bubbling
        // leaves the browser's own navigation entirely untouched and closing a
        // tab would open it. `stopPropagation` is for the root's click handler,
        // which would take the open menus down under a gesture about neither.
        onClose: (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.closeTab(t.pid);
        },
      })),

      // Views come from the model's code: as many tabs as it declares.
      //
      // ONE LIST, DRAWN TWO WAYS. Each entry carries both dresses — `style` is
      // the pill the strip draws it as, `rowStyle` the line the menu draws it
      // as — because which of the two is on screen is a question about how MANY
      // views there are and about nothing else. Building the rows only in the
      // branch that shows them would put the view switcher's identity in two
      // places, free to disagree about which view is the one you are on.
      viewTabs: views.map((v) => ({
        key: v.id,
        label: v.name,
        hint: `${viewPartCount(v)} parts · ${mb(v.gzip)}`,
        style: tab(s.view === v.id),
        // The menu's own row, shaped like the tree menu's items (`mi`) rather
        // than like a pill: in a column it is the highlight that says which one
        // is on, and a pill's raised card in a list reads as a stray button.
        rowStyle: `display:flex;align-items:center;gap:10px;padding:7px 14px;font:400 12px ${SANS};cursor:pointer;`
          + (s.view === v.id ? 'color:var(--accent-text);background:var(--accent-bg)' : 'color:var(--text)'),
        // CLOSES THE MENU WHATEVER `showView` DOES WITH THE CLICK — it returns
        // without touching a thing when the view asked for is the one already
        // on screen, and a menu left standing open on the row you just pressed
        // is a control that ignored you.
        onClick: () => { this.showView(v.id); this.setState({ viewsOpen: false }); },
      })),
      // PAST THE THRESHOLD THE STRIP BECOMES ONE BUTTON — see `VIEW_TABS_MAX`
      // for what the strip does to the toolbar when it is too long for it.
      viewMenu: views.length > VIEW_TABS_MAX,
      // What that button says: the view on screen. Empty where none matches —
      // `s.view` is null until the first view lands, and a switcher captioned
      // `undefined` is worse than a bare one.
      viewLabel: shownView ? shownView.name : '',
      // A view's name is the model's own sentence and can be any length; the
      // button is in a toolbar that must not grow past the window (`viewBtnStyle`
      // caps it), so the name is cut rather than allowed to push.
      viewLabelStyle: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
      viewsToggle: stop(() => this.setState({
        viewsOpen: !s.viewsOpen, revOpen: false, dlOpen: false, tokenPop: false, menu: null })),
      viewBtnStyle: `display:flex;align-items:center;gap:7px;padding:5px 11px;border-radius:5px;font:500 12px ${SANS};cursor:pointer;max-width:220px;`
        + (s.viewsOpen ? 'background:var(--card-bg);color:var(--text);box-shadow:0 1px 2px var(--shadow-soft)' : 'color:var(--text-soft)'),
      // OPENS UPWARDS, unlike every other popover on this page: the toolbar it
      // hangs off floats at the BOTTOM of the model, so a menu measured from
      // the top of its button would be drawn off the bottom edge of the window.
      //
      // WHICH MAKES `bottom:38px` A MEASUREMENT AND NOT A TASTE, since the
      // offset is counted up from the button rather than down from anything:
      // the button is about 25px tall (a 12px line box and 5px of padding
      // either side), the toolbar adds its 4px of padding and 1px border, and
      // the rest is the air between the two cards. It moves with
      // `viewBtnStyle` — grow the button and this has to grow with it, or the
      // menu comes down on top of the control that opened it.
      //
      // AND IT IS THE ONE POPOVER THAT TAKES NO SHEET ON A NARROW WINDOW. The
      // toolbar carries `backdrop-filter:blur(10px)`, and a `backdrop-filter`
      // makes the element a containing block for descendants positioned `fixed`
      // AS WELL AS `absolute` (CSS Filter Effects 2, §2.1) — so `popSheet` would
      // resolve its `left`/`right`/`bottom` against the TOOLBAR's box rather
      // than the window, and the "sheet" would come up over the button that
      // opened it. Nor does it need the clamp the header's panels need: this
      // toolbar is always centred on the bottom edge, and on a narrow window it
      // is this button and Fit and nothing else, so 260px measured from the
      // button's left edge is inside a 320px window.
      //
      // NO `z-index`, deliberately: the toolbar is its own stacking context for
      // the same reason, so any value here only sorts this menu against the
      // toolbar's other children. What has to move is the CONTAINER —
      // `toolbarStyle` below.
      //
      // HEIGHT CAPPED like the revision menu's list, because the count here is
      // the model's to choose: a model may declare twenty views, and the root
      // this page lives in is `overflow:hidden` — a menu taller than the window
      // is not scrolled, it is cut off, with the rows past the cut unreachable.
      viewMenuStyle: 'position:absolute;left:0;bottom:38px;width:260px;max-height:308px;overflow:auto;'
        + 'background:var(--card-bg);border:1px solid var(--line);border-radius:9px;box-shadow:0 10px 34px var(--shadow);padding:6px 0;display:'
        + (s.viewsOpen ? 'block' : 'none'),
      // THE LAYER THE WHOLE TOOLBAR SITS ON, raised for as long as the menu is
      // open. While it is, the toolbar has to cover the overlays that share the
      // model's area with it — the "This view did not render" card (14), the
      // section panel (15) and the composer (16) — or a click on a row one of
      // them covers lands in the overlay instead. It stays UNDER the tree rail
      // on a narrow window (20) and under the header (30), which are the two
      // things that are allowed to cover the toolbar. Closed, it is 12 again,
      // so nothing else on the page ever sees a different order.
      toolbarStyle: 'position:absolute;left:0;right:0;bottom:12px;display:flex;justify-content:center;pointer-events:none;z-index:'
        + (s.viewsOpen ? '17' : '12'),
      // WHAT THE TOOLBAR KEEPS WHEN IT IS THE WIDTH OF A PHONE: the view tabs
      // and Fit, which are the two controls about LOOKING at the model. The
      // rest goes — Measure and Comment are gestures that want a pointer and a
      // canvas with room to aim in, Frame saves a PNG a phone has nowhere to
      // put, and the theme toggle is a preference rather than a step. The
      // dividers go with them: three rules with nothing left between them.
      //
      // MOVE IS NOT ON THIS STRIP and goes narrow all the same, out of its own
      // row in `menuItems`: it is the same gesture wanting the same room, and
      // the flag it reads is this one.
      //
      // IT TAKES AWAY NO POPOVER, and this once said the opposite — it read as
      // the reason some of this page's popovers needed clamping and others did
      // not. None of the buttons above opens one, so dropping them narrows
      // nothing but the toolbar itself.
      //
      // WHICH POPOVERS ARE CLAMPED IS NOT WRITTEN DOWN HERE, and that is on
      // purpose: this comment has carried a count of them twice and been wrong
      // both times, because a sentence cannot be re-checked when a panel is
      // added. `narrow.test.js` names the clamped ones and asserts it — the
      // list lives there, where it can fail.
      showTools: !narrow,
      // AND BOTH ARE OUT OF SERVICE WHILE THE SCENE IS A COMPARISON'S, which is
      // a different question from the `viewer` beside it: that one is about who
      // the reader IS, this one about what is under the cursor. What each tool
      // filed against a comparison, and why the answer is `toolsOff()` rather
      // than `s.compare`, is written out on the method. The buttons are the half
      // a person sees; the handlers are the half that stops a tool armed before
      // the panel opened.
      //
      // MOVE IS NOT A BUTTON HERE ANY MORE: it is armed from the object's own
      // row menu (`menuItems`), which is where the reader has already said WHICH
      // object the drag is about. Its share of `toolsOff` is the `compared`
      // exclusion that row sits inside.
      tMeasure: setTool('measure'),
      measureBtnStyle: btn(s.tool === 'measure', false, this.toolsOff()),
      tComment: setTool('comment'),
      commentBtnStyle: btn(s.tool === 'comment', viewer, this.toolsOff()),
      // NOT ONE OF `s.tool`, and that is the whole difference between this
      // button and the two above it. Those two ARM A GESTURE on the canvas
      // and the viewport is told which one; this one opens a panel of number
      // fields and arms nothing of its own. The bodies it stages CAN be dragged
      // — under the MOVE tool, armed from any part's row menu, because a staged
      // body is a body in the scene like any other and one tool for moving
      // things is better than two. What that drag means is the panel's business:
      // it ends in `hmr:proposalmove` and writes the body's `at`, raising no
      // chip. So this button is drawn like its neighbours and lit from its own
      // flag.
      //
      // HIDDEN WITHOUT A TOKEN, like Move and unlike Measure: everything the
      // proposal produces leaves this page as a comment, which is behind the
      // token, so a reader who cannot comment has nowhere to send it.
      //
      // AND ABSENT — not hidden — ON A HUB THAT DID NOT ASK FOR THE PANEL. That
      // is a DIFFERENT KIND of gate from the token above, and the difference is
      // who is being answered: the token is about this READER, who cannot use a
      // feature the hub does serve, and `display:none` is the right answer to
      // it. The flag is about this HUB, which never asked for the feature at
      // all (`proposalPanelOn`, decided before the page was sent) — and the right
      // answer to that is no markup, so the button and the panel are wrapped in
      // `v.proposalOn` in `render` and the styles below say nothing about it.
      //
      // AND NOT TAKEN OUT OF SERVICE BY A COMPARISON, unlike all three. What
      // `toolsOff` guards is a task filed in the BUILD's terms against a scene
      // that is not the build — a `/cmp/…` path in `partId`. This panel's own
      // door posts no path at all (`proposalAdd` sends `partId: null`), and the
      // body it describes is the reader's own claim about a motor or a wall,
      // which is as true over a comparison as over a build.
      //
      // THE ROWS DO WRITE `sel`, THOUGH, and that is where the same hazard
      // would have got in by another road: a row of the proposal's branch
      // selects the path its body is staged under, and under a comparison that
      // path is the comparison's. So those rows select by the DOCUMENT's own
      // node id while one is up — the reasoning is on `path` in `proposalRows`,
      // and `measAdd` refuses such a value by its shape.
      tProposal: () => this.toggleProposal(),
      // THE FLAG ITSELF, because `render` is where it is spent: it decides
      // whether these two nodes exist, not how they look.
      proposalOn,
      proposalBtnStyle: btn(s.proposalOpen, viewer, false),
      fitView: () => this.fitView(),
      grabFrame: () => this.saveFrame(),
      // OFF `armed` AND NOT OFF `s.tool`, so the strip stops instructing the
      // reader to click a model that will not answer: a tool armed before a
      // comparison opened stays armed and stops firing, and this line is the
      // only place on the page that would still have described it as live.
      hintText: armed === 'comment' ? 'click the model to pin a task'
        : armed === 'measure' ? 'click a part, or two, to measure'
        // `it` and not `a part`: this tool is armed on a body of the proposal
        // just as readily as on a part of the build, and the row that arms it
        // already says which of the two the reader is in.
        //
        // AND BOTH HALVES OF THE WIDGET IN ONE LINE, because there is one tool
        // now and this is the only place on the page that describes it while it
        // is in force. `drag it` alone was true and incomplete — it slides and
        // says nothing about turning — and the `turn` line that used to stand
        // under this one described the other half of the same widget as though
        // it were a second tool. A reader told half of it never goes looking
        // for the rest.
        //
        // THE DISC AND NOT THE RING, which is the one piece of aim this has
        // room for: the press is taken by the coloured handle, and the arc
        // drawn through it is a picture the trackball still owns (`rings.js`),
        // so naming the ring would send the reader to grab the one part of the
        // widget that does nothing.
        : armed === 'move' ? 'drag it to slide, a coloured disc to turn · esc to stop'
        : armed === 'cut' ? 'click a face to place the section plane'
        : `drag — orbit · wheel — zoom · hold ${HOLD_KEY_LABEL} — section`,

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
      // CLAMPED TO THE SCREEN, and on narrow that is not cosmetic. At
      // `left:278px` and 270px wide this panel's right-hand end — where its
      // close cross is — sits past 540px, off a phone screen entirely. Nothing
      // else takes it back: `rootClick` clears the other popovers and not this
      // one, the panel stops the click that would reach it anyway, and a phone
      // has no Escape key. Opened there it could only be closed by reloading
      // the page. It is reached through the tree, which on narrow the "Parts"
      // button above is what opens.
      secPopStyle: (narrow ? popSheet : 'position:absolute;left:278px;top:52px;width:270px;') + 'background:var(--card-bg);border:1px solid var(--line);border-radius:10px;padding:13px 14px;box-shadow:0 10px 34px var(--shadow);z-index:15;display:' + (s.secPop ? 'block' : 'none'),
      pickFace: stop(() => { this.set({ tool: 'cut', secPop: false }); this.toast('Click a face — the plane will sit on it'); }),
      pickFaceStyle: `padding:7px;text-align:center;border-radius:6px;font:600 11.5px ${MONO};cursor:pointer;` + (s.tool === 'cut' ? 'background:var(--accent-bg);color:var(--accent-text);border:1px solid var(--accent-line)' : 'background:var(--accent);color:var(--text-on-accent);border:1px solid var(--accent-strong)'),
      pickFaceText: s.tool === 'cut' ? 'now click a face on the model…' : (s.secFace ? 'pick another face' : 'pick a face to place the plane'),
      secOff: s.secOff, secMin: secRange[0], secMax: secRange[1],
      secStep: Math.max(0.1, Math.round((secRange[1] - secRange[0]) / 40) / 10),
      secOffLabel: `${s.secOff >= 0 ? '+' : ''}${s.secOff.toFixed(1)} mm`,
      setSecOff: (e) => this.set({ secOff: parseFloat(e.target.value), secOn: true }),
      flipSec: stop(() => this.set({ secFlip: !s.secFlip })),
      resetSec: stop(clearSection),
      toggleHatch: stop(() => this.set({ hatch: !s.hatch })),
      hatchBox: 'width:15px;height:15px;border-radius:4px;flex:none;display:flex;align-items:center;justify-content:center;font:600 10px monospace;' + (s.hatch ? 'background:var(--accent);color:var(--text-on-accent)' : 'border:1px solid var(--line-strong);background:var(--card-bg);color:transparent'),
      hatchMark: s.hatch ? '✓' : '',

      // -- the proposal panel ---------------------------------------------------
      //
      // CLAMPED ON NARROW like the section panel and the note editor, for the
      // same reason and one more of its own: it is anchored to the right-hand
      // edge of the model area, its own close cross is at the top of it, and it
      // is the tallest panel on this page. The button that opens it is gone at
      // phone width (`showTools`) — but the flag is not, so a window dragged
      // narrower with the panel open would otherwise leave a sheet nothing could
      // take back. `narrow.test.js` holds the list.
      //
      // AND IT SAYS NOTHING ABOUT `proposalOn`, which is the division these two
      // gates keep: a style answers about THIS READER — open or closed, wide or
      // narrow, token or none — while the hub's flag is answered one level up,
      // by leaving the markup out of the tree entirely (`v.proposalOn` in
      // `render`). Spelling the flag here as well would be a second gate that
      // can never fire, sitting on a node that is not there to style.
      proposalPanelStyle: (narrow ? popSheet : 'position:absolute;right:16px;top:52px;width:330px;')
        + 'max-height:calc(100% - 110px);overflow:auto;background:var(--card-bg);border:1px solid var(--line);border-radius:10px;padding:13px 14px;box-shadow:0 12px 40px var(--shadow);z-index:15;display:' + (s.proposalOpen ? 'block' : 'none'),
      proposalClose: stop(() => this.toggleProposal()),

      // EVERY OP `SIZES` CAN DRAW, read off that table rather than listed again
      // beside it: a button for an op with no size row is a button that adds a
      // body the panel cannot show, and a missing button is an op nothing can
      // reach. The ORDER is the table's, which is the order proposal.js tables
      // them in.
      proposalOps: Object.keys(SIZES).map((op) => ({
        key: op,
        // The op's own name unless it reads badly on a button — `+ profile` is
        // what the reader is about to type into `extrude`. Not a table anything
        // has to be kept in step with: an op missing from it gets its own name.
        label: `+ ${{ extrude: 'profile' }[op] || op}`,
        onClick: addBody(op),
      })),

      // -- the proposal's branch of the tree ----------------------------------
      //
      // DRAWN OVER A DOCUMENT WITH SOMETHING IN IT, AND ON NOTHING ELSE. What
      // keeps the column quiet is the only condition left — a heading over
      // nothing says less than the panel's own sentence about what a body is,
      // which is where that explanation stayed.
      //
      // IT USED TO ASK `s.proposalOpen` AS WELL, and that was the overlay's
      // condition borrowed: closing the panel took the bodies off the model, so
      // a branch left standing would have listed rows with an eye and a colour
      // over geometry that had gone. It borrowed only half of it. The moves
      // stayed applied — a part of the build standing where the reader dragged
      // it — while the row that said so, and the `×` that puts it back, went off
      // screen with the panel. The panel no longer touches the model at all
      // (`toggleProposal`); what takes the proposal off it is this branch's own
      // eye, which has to stay on screen to be pressed again.
      proposalTreeStyle: 'padding:1px 0 6px;flex-direction:column;align-items:flex-start;display:'
        + (doc.nodes.length ? 'flex' : 'none'),
      // THE HEAD OF THE BRANCH, drawn as a group of the parts tree is drawn at
      // depth 0 — the same height, the same caret, the same count on the right —
      // because it is read beside that tree and a second shape for it would read
      // as a second kind of thing.
      proposalHeadStyle: 'display:inline-flex;align-items:center;gap:2px;height:24px;padding:0 6px 0 3px;margin:0 0 1px;border-radius:4px;background:var(--float-bg-soft);cursor:default',
      proposalCaretPath: branchOpen ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4',
      proposalCaretStyle: 'width:20px;height:20px;flex:none;display:flex;align-items:center;justify-content:center;color:var(--text-soft);cursor:pointer',
      // WRITTEN INTO A COPY RATHER THAN SPELLED AS A COMPUTED KEY, which is the
      // same rule `SIZES` above keeps: `test_every_handled_event_is_imported_
      // from_events_js` reads `[x]:` out of this file as a handler key, and a
      // `{ [PROPOSAL_BRANCH]: … }` here would arrive there as an event constant
      // that events.js has never heard of.
      proposalToggle: stop(() => {
        const expanded = { ...s.expanded };
        expanded[PROPOSAL_BRANCH] = !branchOpen;
        this.setState({ expanded });
      }),
      // THE BRANCH'S OWN EYE, drawn with the rows' own `eyeOuter`/`eyeDot` so it
      // reads as the same control one level up — which is what it is: the whole
      // proposal off the model, bodies unstaged and every displaced part back
      // where the build puts it. `toggleProposalEye` has the rest of the
      // argument, including why it is one boolean of interface state and not a
      // per-node thing.
      //
      // TWO STATES AND NOT THREE. A group of the parts tree can be half-hidden
      // (`part`) because its eye is a tally of its leaves; this one is a switch,
      // and the per-body eyes underneath it go on saying what each body is
      // doing. So a proposal whose bodies are individually hidden still reads as
      // ON here — that is the truthful answer, because the moves are still
      // applied and the eyes below say the rest.
      proposalEyeOuter: eyeOuter(s.proposalOff ? 'off' : 'on'),
      proposalEyeDot: eyeDot(s.proposalOff ? 'off' : 'on'),
      proposalEyeClick: stop(() => this.toggleProposalEye()),
      // THE MASTER TICK: every node held back, or every node let through. It
      // shows filled only when there is nothing left to send, which is the state
      // it would put the document in — so pressing it twice is a round trip, and
      // a branch with one node ticked off shows an empty master with a filled
      // row under it.
      proposalSkipAll: stop(() => this.skipProposal({
        ...doc,
        nodes: doc.nodes.map((node) => ({ ...node, skip: !allSkipped })),
      })),
      proposalSkipIcon: skipIcon(allSkipped),
      proposalSkipTitle: allSkipped ? 'send all of it again'
                                    : 'hold all of it back from the agent',
      proposalHeadName: PROPOSAL_BRANCH,
      proposalHeadNameStyle: `white-space:nowrap;padding-right:4px;font:600 12px ${MONO};color:var(--text)`,
      // THE WHOLE THING, DELETED — the record on the hub and the document on the
      // page together, which is the one control here that reaches past this
      // browser. It asks before it does it; `removeProposal` says why this `×`
      // and no other one on the page is allowed to interrupt.
      proposalRemove: stop(() => this.removeProposal().catch((error) => {
        console.error('proposal', error);
      })),
      proposalRemoveTitle: 'delete the whole proposal, here and on the hub',
      // HOW MANY STATEMENTS ARE IN IT, bodies and moves together, in the place a
      // group of the parts tree carries how many parts are under it.
      proposalCount: String(doc.nodes.length),
      proposalCountStyle: `flex:none;font:400 10px ${MONO};color:var(--text-faint);padding:0 2px`,
      // EMPTIED BY THE CARET rather than hidden by a style, which is how the
      // parts tree collapses a group too: a collapsed branch emits no rows.
      proposalRows: branchOpen ? proposalRows : [],

      // The sentence that says what a proposal can be built out of, drawn in the
      // panel above the buttons that add one and only while there is nothing in
      // the document. It stands in for the branch rather than beside it: the
      // branch is over in the tree column and is not drawn at all on an empty
      // document, so this is the only thing on the page saying what would appear
      // there — and a heading over empty space says less than one sentence does.
      //
      // ON THE WHOLE DOCUMENT and not on the bodies alone, so a proposal that
      // holds nothing but a dragged part is not offered an explanation of what
      // it is missing — it has something to say to the agent already.
      proposalEmptyStyle: `font:400 10.5px/1.5 ${MONO};color:var(--text-muted);margin-bottom:9px;display:`
        + (doc.nodes.length ? 'none' : 'block'),

      // THE KERNEL'S OWN SENTENCE ABOUT THE DOCUMENT AS IT STANDS, in a box in
      // the panel, where the reader is already looking. Drawn from `proposalError`
      // through a key of its own rather than from the field directly, so the
      // markup asks the panel what it has to say instead of naming the one
      // source it comes from today.
      proposalSays: s.proposalError || '',
      proposalSaysStyle: `margin-top:9px;padding:7px 9px;border:1px solid var(--danger-line);background:var(--danger-bg);border-radius:6px;font:400 10.5px/1.5 ${MONO};color:var(--danger);display:`
        + (s.proposalError ? 'block' : 'none'),

      // THE SAME DOOR THE MEASUREMENT AND THE DRAG USE, and the same gate: the
      // panel is already closed to a reader with no token, and this carries the
      // gate anyway so the link cannot open a composer `composerStyle` keeps at
      // `display:none`. Hidden on an empty proposal too — there is nothing to say.
      //
      // AND ON A DOCUMENT THE PANEL HAS ALREADY FLAGGED, which is the third
      // condition and the one that was a defect rather than a decision. A
      // document `setProposal` could not build is one the projection cannot be
      // rendered off either, so the link stood over something that would throw
      // inside a React handler: nothing opened, nothing was said, and the
      // feature's only exit did nothing at all. The message for it is already on
      // screen in the panel's error box; what is missing is the offer.
      // `sendsNothing` AND NOT `isEmpty`, which is the same offer read one step
      // further on: a document whose every node is ticked off projects to a
      // heading and a `result =` line, and a link that attached THAT would send
      // the agent a proposal the reader had just finished withholding.
      proposalAddStyle: 'cursor:pointer;text-decoration:underline'
        + (viewer || sendsNothing(doc) || s.proposalError ? ';display:none' : ''),
      // THE TEXT AND NOT THE DOCUMENT, taken at the moment the link is pressed.
      // `proposalText` is the projection the agent reads — a few aligned lines
      // saying how big the thing is and where its features sit, and a block
      // below them naming every part of the build the reader dragged — and it
      // rides in the comment's TEXT like the measurement, because the hub's
      // schema is closed and silently drops what it does not know
      // (`sendComment`, and tests/test_ui_source.py holds it). A drag is no
      // longer a passenger of its own beside the projection: it is a line
      // inside it.
      //
      // `part` IS EMPTY, deliberately, where the other two doors fill it: a
      // proposal is about a body that is in no build and no catalogue, so there is
      // no row to name and no key to anchor to. The reader can still click a
      // part afterwards and attach it.
      //
      // THE FLAG IS READ HERE TOO and not only in the style above, because the
      // two answer different questions: one is whether to OFFER the link, the
      // other is what happens when it is pressed anyway. A document the kernel
      // would not build is not one to send an agent to design against — and
      // where what it refused was an op no table knows, `proposalText` looks the
      // same op up and throws, which in here is a React handler's throw: no
      // composer, no message, nothing in the console the reader will ever see.
      proposalAdd: () => {
        if (s.proposalError) return;
        this.set({
          composer: {
            part: '', partId: null, key: null,
            p: null, text: '', photo: null,
            // `attached` IS THE DRAFT'S ANSWER TO "was a proposal put on this
            // one", and `proposal` is the text as it stands. Not `held`: this
            // feature already spends "held back" on the OPPOSITE meaning — a node
            // the reader is keeping out of the text — and the page has an `s.held`
            // of its own for the section hold key. They part company
            // the moment every node is ticked off: the text goes and the answer
            // does not, which is what lets a tick be undone (`skipProposal`).
            proposal: proposalText(doc), attached: true,
          },
          tool: null,
        });
      },

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

      // -- comparing two revisions (issue #10) --------------------------------
      cmpA: shortId(cmpPair[0] || ''), cmpB: shortId(cmpPair[1] || ''),
      // A method rather than a closure, because closing the panel has an
      // ADDRESS to put back when this page was opened as a comparison, and that
      // is a paragraph of reasoning rather than a state patch (`leaveCompare`).
      exitCompare: stop(() => this.leaveCompare()),
      // The three ways of looking at one comparison. Each is one group hidden in
      // the scene (`diffHidden`), so they are `set` like any other viewport
      // state and cost no fetch.
      // A FLEX BOX AND `min-width:0`, not `text-align:center`. Two of the three
      // labels carry a revision identifier, which is a commit of seven
      // characters or a pointer name of up to sixty-four — and a flex item does
      // not shrink below its own content unless it is told it may, so a long
      // one used to push the whole segmented control wider than the panel. The
      // name inside then ellipses and the word beside it does not; `padding:0`
      // because the box now centres its own children.
      dsBothStyle: tab(s.diffShow === 'both') + ';flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:4px;padding-left:0;padding-right:0',
      dsAStyle: tab(s.diffShow === 'a') + ';flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:4px;padding-left:0;padding-right:0',
      dsBStyle: tab(s.diffShow === 'b') + ';flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:4px;padding-left:0;padding-right:0',
      // The half of a mode label that may be too long, and the half that must
      // never be dropped: without "only" the three tabs stop naming choices.
      dsNameStyle: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
      dsWordStyle: 'flex:none',
      showBoth: stop(() => this.set({ diffShow: 'both' })),
      showA: stop(() => this.set({ diffShow: 'a' })),
      showB: stop(() => this.set({ diffShow: 'b' })),

      cmpNoteStyle: 'display:' + (cmpNote ? 'block' : 'none'),
      cmpNoteHead: cmpNote ? cmpNote.head : '',
      cmpNote: cmpNote ? cmpNote.body : '',
      cmpRetryStyle: `margin-top:9px;padding:5px 11px;border-radius:6px;font:600 11.5px ${SANS};cursor:pointer;background:var(--accent);color:var(--text-on-accent);display:`
        + (s.cmpStage === 'failed' || s.cmpStage === 'locked' ? 'inline-block' : 'none'),
      retryCompare: stop(() => this.compareRevisions(s.cmpPair)),

      cmpSummary: cmpDone ? compareSummary(cmpRows) : '',
      cmpSummaryStyle: `font:600 11.5px ${SANS};padding:0 2px 8px;display:`
        + (cmpDone ? 'block' : 'none'),
      cmpRows: cmpRows.map((row) => ({
        key: row.key,
        // THE CATALOGUE KEY IS WHAT IS DRAWN, and not a name looked up in the
        // build's own catalogue: the pair being compared need not include the
        // build this page is standing on, and a part that is `new` has no entry
        // in the older revision's catalogue at all. The key is the identity
        // (issue #75), it is what the author wrote, and it is what the agent
        // will be told about.
        name: row.key,
        status: row.status,
        volume: [row.added > 0 ? `+${mm3(row.added)}` : '',
                 row.removed > 0 ? `−${mm3(row.removed)}` : '']
          .filter(Boolean).join(' / ') + (row.added > 0 || row.removed > 0 ? ' mm³' : ''),
        // A COLUMN, because a refused part has a second line under it. Every
        // other row is one line and looks exactly as it did: the line itself is
        // the flex box that used to be this element, and the sentence below it
        // is `display:none` where there is nothing to say.
        rowStyle: 'padding:4px 6px;border-radius:5px;cursor:pointer;background:'
          + (s.cmpSel === row.key ? 'var(--accent-bg)' : 'transparent'),
        nameStyle: `flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:400 11.5px ${MONO};color:var(--text)`,
        // The chip, and the legend's line about `not compared` wears the same
        // one — see `statusChip`, where the argument for each colour is.
        statusStyle: statusChip(row.status),
        volumeStyle: `flex:none;font:400 10px ${MONO};color:var(--text-muted)`,
        // WHY THE KERNEL WOULD NOT ANSWER FOR THIS PART, in the hub's own words
        // and only where the words are about THIS part (`rowReason`). It wraps
        // rather than being cut to a hint: it names which identity failed and by
        // how much, and half of that is no use.
        reason: rowReason(row),
        reasonStyle: `padding:1px 1px 0;font:400 10.5px/1.45 ${SANS};color:var(--text-muted);display:`
          + (rowReason(row) ? 'block' : 'none'),
        // The other half of "по строке списка можно попасть к детали на модели,
        // и наоборот": this direction writes the key and `comparePaths` turns it
        // into every solid the scene draws it as. The `hmr:pick` handler is the
        // other one.
        onSelect: stop(() => this.set({ cmpSel: row.key })),
      })),
      // The legend's swatches are the payload's OWN colours (hub.DIFF_COLOURS)
      // and deliberately not palette roles: they are samples of what is on the
      // model, and a sample that followed the theme would stop being one.
      legendAddedStyle: `width:12px;height:12px;border-radius:3px;flex:none;background:${DIFF_COLOURS.added}`,
      legendRemovedStyle: `width:12px;height:12px;border-radius:3px;flex:none;background:${DIFF_COLOURS.removed}`,
      legendNeutralStyle: `width:12px;height:12px;border-radius:3px;flex:none;background:${DIFF_COLOURS.neutral}`,
      // THE WORD IS THE HUB'S AND NOT A LABEL WRITTEN AGAIN HERE: the legend
      // explains the chip the rows wear, so it draws the same chip with the same
      // word in it, and a spelling that drifted from the hub's would be a legend
      // about a status nothing in the list has.
      legendNotCompared: NOT_COMPARED,
      legendNotComparedStyle: statusChip(NOT_COMPARED),
      // THE SENTENCE UNDER THE WORD, out here rather than written into the
      // markup for the reason the word is: it has to agree with what the hub
      // writes on the row (`NOT_COMPARED_WHY`), and an assertion about that is
      // a test rather than a note in two files.
      legendNotComparedWhy: NOT_COMPARED_WHY,

      // The new build is offered, never substituted: somebody may be halfway
      // through a section with half the tree hidden, and a model that changes by
      // itself reads as a breakage.
      bannerStyle: chip(!!s.pending && !s.bannerGone, 'var(--card-bg)', 'var(--line)', 'var(--text)') + ';padding:8px 8px 8px 14px',
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
      //
      // `--accent-muted` is the washed accent SURFACE, and this call site is
      // half of why that role exists: it was `--accent-line` for a while, which
      // is a border colour asked to fill a button, and the front page's Sign-in
      // button was doing the same thing for the same want. A name that has
      // stopped describing what it paints is how the next reader learns that
      // the names here are approximate.
      bannerSwitchStyle: `padding:5px 12px;background:${s.swapping ? 'var(--accent-muted)' : 'var(--accent)'};`
        + `color:var(--text-on-accent);border-radius:5px;font:600 12px ${SANS};`
        + `cursor:${s.swapping ? 'default' : 'pointer'}`,
      bannerLater: () => this.dismissPending(),

      // THE CHIPS STAND CLEAR OF THE TREE, which is the whole of what the offset
      // means: 278px is the clearance the open tree needs beside the model — a
      // hand-tuned constant, and not a width the tree declares, since its rows
      // are `inline-flex` and it is as wide as the names in it. On
      // narrow the tree starts closed and covers the model when it opens, so
      // that offset would put these chips off the side of a phone entirely —
      // they take the tree's left margin instead, which is where the tree is
      // not.
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
      measAddStyle: 'cursor:pointer;text-decoration:underline'
        + (viewer ? ';display:none' : ''),
      // `part` IS A DISPLAYED STRING AND NOTHING MORE, and it is displayed
      // TWICE rather than once: `composerPart` heads the composer with it, and
      // `sendComment` copies it into this session's record of the comment, out
      // of which `computed` builds the thread in the rail — which is where it
      // stays on screen long after the composer has closed. What is POSTED is
      // `partId`; this string is never a field of the request.
      //
      // TWO DOORS FILL IT WITH A NAME, and this note is the inventory of how
      // they differ, so it has to name both: the `hmr:place` handler (a point
      // picked in the scene) and this one (a measurement). A THIRD WRITER IS NOT
      // A DOOR, and is named so the inventory reads as complete rather than as
      // one entry short: `leaveBuild` writes `part: ''`, emptying the field
      // instead of filling it, because the build the attachment was made against
      // has left. Both doors name the ROW and not the solid the viewport
      // reported, because where a run has collapsed the solid's own name —
      // `pin(2)` — is drawn on no row at all. WHERE IT HAS NOT — a part standing
      // between the copies, or a `known` that splits the run — that solid is a
      // row of its own and the lookup lands on it, so the collapsed case is the
      // one this is FOR rather than the only one it is right in.
      //
      // THEY DIFFER IN THE GRANULARITY OF THE `partId` BESIDE IT, which is the
      // field that actually reaches the hub. `hmr:place` posts the exact solid
      // the point sits on (`/model/pin(2)`); this one posts `sel`, which the
      // pick handler resolved to the ROW, i.e. the first path of the run — or
      // nothing at all, where that selection is a body of the proposal panel and
      // the number goes to the agent unattached (the note below). That spread is
      // not a drift to be levelled: a point is anchored to the solid it was
      // placed on, a measurement is about the row, and each door posts the
      // narrowest thing its own gesture was about.
      //
      // NEITHER CARRIES A COUNT, and the door that did is worth naming because
      // it is where the rule came from: a DRAG acted on parts — every selected
      // path at once — so `pin ×3` was what the reader was reporting. That is no
      // longer an attachment at all; it is a node of the proposal document and
      // the count rides in the name the projection prints. What is left here
      // moves nothing: a measurement is anchored to whatever happens to be
      // selected, so `pin ×5` would claim five copies were measured when the
      // faces were two, and a placed point sits on one solid. The measurement's
      // qualifier about spanning parts rides in the measurement text instead
      // (`measureLabel`), where it is a fact about the number.
      measAdd: () => {
        // The ROW's plain name where the tree can answer, and `selName` where
        // it cannot — which is the row's name too, since the pick handler
        // resolves it while the tree is still standing; the picked solid's name
        // survives in it only for a path no row ever claimed. Bare either way,
        // for the reason the inventory above gives.
        const node = this.node(s.sel);
        // A BODY OF THE PROPOSAL IS ATTACHED TO NOTHING. `sel` is written by
        // `onPick` for any path picked, a proposal body included — and in Move
        // mode `onDown` emits that pick itself — so the reader who clicks the
        // motor to look at it, measures a distance on it and presses `add to
        // comment` would otherwise hand the hub a composer headed `motor` and a
        // `partId` that resolves in no build. THE NUMBER IS WHY THE PANEL
        // EXISTS and stays exactly as it is; it is the attribution beside it
        // that goes.
        // `key` needs no answer of its own here: a proposal body carries no
        // catalogue key at all (`part()` in proposalgeom.js says why), so the
        // row's is already null. Nothing else in this payload names the
        // selection — the measurement text is a value and a note about the view.
        // AND A SELECTION THAT IS NOT A PATH IS NOT ONE EITHER, which is the
        // second half and the one asked about the SHAPE rather than about
        // membership. A row of the proposal's branch selects by the DOCUMENT's
        // own node id wherever the scene cannot place it — nothing staged yet, a
        // document the kernel refused, a comparison up — and `isOverlay` cannot
        // recognise that value, because it is not a path for it to measure.
        //
        // THE SHAPE AND NOT `doc.nodes.some(...)`, which was the first answer
        // and the wrong question: it asks whether the node is still THERE, and
        // the case that matters is the one where it is not. A refused document
        // repaired by the `×` on the body that broke it leaves `sel` standing at
        // `n5` over a document that no longer holds it, and membership then says
        // "not a proposal thing" about the one value that could only have come
        // from one.
        //
        // IT RESTS ON EVERY TREE ID BEING A PATH, and that invariant is held by
        // a test rather than by this sentence — `treeFromShapes` spells every id
        // as `${parent}/${name}`, which ui/tests/proposalpanel.test.js drives.
        const proposed = this.proposalBody(s.sel)
          || (!!s.sel && !s.sel.startsWith('/'));
        this.set({
          composer: {
            part: proposed ? '' : (node ? node.name : (s.selName || 'model')),
            partId: proposed ? null : (s.sel || null),
            key: node ? node.key : null,
            p: null, text: '', photo: null, meas: s.measure.full,
          },
          tool: null,
        });
      },
      measClear: () => this.set({ measure: null }, { __clearMeasure: true }),

      composerStyle: 'position:absolute;right:16px;bottom:16px;width:400px;background:var(--card-bg);border:1px solid var(--line);border-radius:10px;box-shadow:0 12px 40px var(--shadow);z-index:16;display:' + (s.composer && !viewer ? 'block' : 'none'),
      nextLabel: String(s.feed.length + 1),
      composerPart: s.composer ? s.composer.part : '',
      composerText: s.composer ? s.composer.text : '',
      compType: (e) => this.setState({ composer: { ...s.composer, text: e.target.value } }),
      compMeasChipStyle: 'display:' + (s.composer && s.composer.meas ? 'flex' : 'none') + `;align-items:center;gap:5px;padding:4px 8px;background:var(--warn-bg);border-radius:5px;font:500 10.5px ${MONO};color:var(--warn)`,
      compMeasText: (s.composer && s.composer.meas) || '',
      compMeasRemove: stop(() => this.setState({ composer: { ...s.composer, meas: null } })),
      // A CHIP AND NOT THE TEXTAREA. The measurement is one line and could have
      // gone either way; the proposal is a small table, and dropped into the box
      // it would bury the sentence the reader came here to write. It says it is
      // attached, it can be taken off, and `sendComment` is what puts it in the
      // comment.
      compProposalChipStyle: 'display:' + (s.composer && s.composer.proposal ? 'flex' : 'none') + `;align-items:center;gap:5px;padding:4px 8px;background:var(--warn-bg);border-radius:5px;font:500 10.5px ${MONO};color:var(--warn)`,
      // BOTH HALVES, because this is the reader saying they do not want one on
      // this draft at all — unlike a tick, which empties the text and can fill
      // it again. Left holding `attached`, a draft the chip was taken off would grow
      // its attachment back the next time anything in the branch was ticked.
      compProposalRemove: stop(() => this.setState({
        composer: { ...s.composer, proposal: null, attached: false },
      })),
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
      // THE PRESS HAS TO BE VISIBLE, and that is the other half of the refusal
      // in `sendComment` — the same pairing `bannerSwitchStyle` describes at
      // length. The window is a frame grab, an upload and two requests, and
      // until this button changed nothing on the screen said the press had
      // landed: the composer sits there with the draft still in it, because
      // only the write clears it. A reader pressing again was reading a live
      // button correctly. So the word says what is happening and the washed-out
      // accent says the button is spent.
      compSendLabel: s.sending ? 'Sending…' : 'Send',
      compSendStyle: `padding:6px 14px;background:${s.sending ? 'var(--accent-muted)' : 'var(--accent)'};`
        + `color:var(--text-on-accent);border-radius:6px;font:600 12px ${SANS};`
        + `cursor:${s.sending ? 'default' : 'pointer'}`,

      menuStyle: 'position:fixed;width:230px;background:var(--card-bg);border:1px solid var(--line);border-radius:9px;box-shadow:0 12px 40px var(--shadow);padding:2px 0 6px;z-index:60;display:' + (s.menu ? 'block' : 'none') + ';left:' + (s.menu ? s.menu.x : 0) + 'px;top:' + (s.menu ? s.menu.y : 0) + 'px',
      menuName: mName, menuItems,

      // CLAMPED FOR THE REASON `secPopStyle` IS, and it is the worse of the two:
      // at `left:310px` and 300px wide, a phone shows the empty left margin of
      // this panel and nothing else — its Cancel and Save sit past 480px, off
      // the screen, and the row is `justify-content:flex-end` so they stay
      // there. `rootClick` does not clear `notePop`, the panel stops the click
      // that would reach it, and there is no Escape key on a phone: opened, it
      // could only be dismissed by reloading. Reachable there through the note
      // box and through the tree row's context menu.
      notePopStyle: (narrow ? popSheet : 'position:absolute;left:310px;top:120px;width:300px;') + 'background:var(--card-bg);border:1px solid var(--line);border-radius:10px;padding:13px 14px;box-shadow:0 12px 40px var(--shadow);z-index:60;display:' + (s.notePop ? 'block' : 'none'),
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
        <style>{PIN_CSS}</style>

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
            {v.showWordmark && <span style={css(`font:700 14px ${SANS};letter-spacing:-.2px`)}>hammerola</span>}
          </a>
          <div style={css(`width:1px;height:22px;background:${HEADER_LINE}`)} />
          <div style={css(v.titleColStyle)}>
            <div style={css(`font:600 13.5px ${SANS};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`)}>{v.title}</div>
            {v.showSubtitle && <div style={css(`font:400 10.5px ${MONO};color:var(--text-muted);white-space:nowrap`)}>{v.subtitle}</div>}
          </div>

          <div style={css('position:relative;margin-left:8px;flex:none')}>
            <div onClick={v.revToggle} title={v.slotTitle} style={css(v.revBtnStyle)}>
              <span style={css(v.statusDotStyle)} />
              <span style={css(`font:600 12px ${MONO}`)}>{v.slot}</span>
              <span style={css(`font:400 11px ${MONO};color:var(--text-muted)`)}>{v.slotDate}</span>
              <span style={css('font-size:9px;color:var(--text-faint)')}>&#9662;</span>
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
                        <span title={r.message} style={css(r.messageStyle)}>{r.message}</span>
                        <span style={css(`font:400 11px ${MONO};color:var(--text-muted)`)}>{r.date}</span>
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
          </div>

          {v.showStatus && <div style={css(v.statusChipStyle)}>{v.statusText}</div>}
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
                      <span style={css(`font:400 10.5px ${MONO};color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px`)}>{f.file}</span>
                    </a>
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
              <div style={css(`font:400 11.5px/1.6 ${SANS};color:var(--text-soft);margin-bottom:9px`)}>
                {v.viewer
                  ? 'EDIT_TOKEN — the same string `hammerola login` asks for. It opens notes, moving a part, and writing a comment. Without one everything else still works: orbiting, the tree, the section, measuring and the downloads. It is kept in this browser, for the whole site.'
                  : 'The token is stored in this browser, for the whole site. Remove it to go back to viewing.'}
              </div>
              {v.viewer ? (
                <>
                  <input type="password" value={v.tokenDraft} onChange={v.tokenType}
                         placeholder="paste the token"
                         style={css(`width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:6px;outline:none;padding:8px 10px;font:400 12px ${MONO};background:var(--card-bg)`)} />
                  <div style={css('display:flex;justify-content:flex-end;margin-top:9px')}>
                    <span onClick={v.tokenSave} style={css(`padding:6px 14px;background:var(--accent);color:var(--text-on-accent);border-radius:6px;font:600 11.5px ${SANS};cursor:pointer`)}>Save</span>
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

          {/* ── the tree, floating over the model ── */}
          <div style={css('position:absolute;left:12px;top:10px;max-height:calc(100% - 20px);display:flex;flex-direction:column;align-items:flex-start;overflow:auto;z-index:10')}>

            {v.notCompare && v.treeShown && (
              <div style={css('display:flex;flex-direction:column;min-height:0')}>
                <div style={css('flex:none;display:flex;align-items:center;gap:2px;padding:0 0 3px')}>
                  <span onClick={v.expandAll} title="expand all" style={css('width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:4px;color:var(--text-soft);cursor:pointer;background:var(--float-bg-soft)')}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 5.5L8 1.5l4 4M4 10.5l4 4 4-4" /></svg>
                  </span>
                  <span onClick={v.collapseAll} title="collapse all" style={css('width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:4px;color:var(--text-soft);cursor:pointer;background:var(--float-bg-soft)')}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 1.5l4 4 4-4M4 14.5l4-4 4 4" /></svg>
                  </span>
                  <span onClick={v.showAll} title="show all parts" style={css('width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:4px;color:var(--text-soft);cursor:pointer;background:var(--float-bg-soft)')}>
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
                panel over on the right keeps what is ABOUT the proposal rather
                than IN it: what it is for, the buttons that add a body, the
                kernel's verdict, and the door out to a comment.

                BELOW THE PARTS AND NOT ABOVE THEM, which is about those opening
                numbers and not about which list matters more. Selecting a row
                grows this branch by the height of a block of fields, and in a
                column everything after it moves down by that much: standing
                above the parts, one click on a proposal row jerked the whole
                parts tree down the screen while the reader was looking at it.
                Nothing is under this branch now, so there is nothing for it to
                shove. The other way out was to float the fields over the column
                instead, which is a popover with its own placement and its own
                dismissal, for a block that belongs to the row it opens under.

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
                panel is not taken out of service by one either — and it is the
                only place the rows exist now that the panel has no list. */}
            {v.proposalOn && (
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
                  <span onClick={v.proposalEyeClick} title="show / hide the whole proposal" style={css('width:24px;display:flex;justify-content:center;cursor:pointer;flex:none')}>
                    <span style={css(v.proposalEyeOuter)}><span style={css(v.proposalEyeDot)} /></span>
                  </span>
                  {/* THE GHOST COLUMN, STOOD OVER AND NOT USED. A row spends
                      24px on its eye, 22 on its ghost square and 22 on its tick,
                      in that order; the header has an eye and a tick and no
                      ghost — there is nothing to make the whole proposal
                      translucent — so without this spacer the master tick lands
                      over the column of ghost squares, 31px to the left of the
                      ticks it sets and clears. The eye above is off by 6px and
                      still reads as the same control one level up; a tick over
                      the wrong column does not. */}
                  <span style={css('width:22px;flex:none')} />
                  <span onClick={v.proposalSkipAll} title={v.proposalSkipTitle} style={css('width:22px;display:flex;justify-content:center;cursor:pointer;flex:none')}>
                    <span style={css(v.proposalSkipIcon)} />
                  </span>
                  <span onClick={v.proposalToggle} style={css(v.proposalHeadNameStyle)}>{v.proposalHeadName}</span>
                  <span style={css(v.proposalCountStyle)}>{v.proposalCount}</span>
                  {/* THE HEADER'S OWN `×`, drawn exactly as a row's is: same
                      glyph, same faint ink, one level up. A row's takes one node
                      back out of a document being edited; this one takes the
                      whole document, and the hub's copy of it, which is why it
                      is the only control on this page that asks first. */}
                  <span onClick={v.proposalRemove} title={v.proposalRemoveTitle} style={css('color:var(--text-faint);cursor:pointer')}>&#10005;</span>
                </div>
                {v.proposalRows.map((row) => (
                  <div key={row.key} style={css('display:flex;flex-direction:column;align-items:flex-start')}>
                    {/* `onContextMenu` is null on a move and on a body the scene
                        cannot place, which leaves the browser's own menu where
                        this page has nothing to put — see the row. */}
                    <div onContextMenu={row.onMenu} style={css(row.rowStyle)}>
                      {/* The eye, the ghost square and the colour, in one box so
                          that a MOVE — which draws nothing and has none of them
                          — can drop all three at once and still line its name up
                          with the bodies above it. */}
                      <span style={css(row.marksStyle)}>
                        <span onClick={row.onVis} title="show / hide" style={css('width:24px;display:flex;justify-content:center;cursor:pointer;flex:none')}>
                          <span style={css(row.eyeOuter)}><span style={css(row.eyeDot)} /></span>
                        </span>
                        <span onClick={row.onGhost} title="translucent" style={css('width:22px;display:flex;justify-content:center;cursor:pointer;flex:none')}>
                          <span style={css(row.ghostIcon)} />
                        </span>
                        <span style={css(row.dotStyle)} />
                      </span>
                      {/* OUTSIDE THAT BOX, which is the whole reason it is not
                          in it: the box goes `visibility:hidden` on a row with
                          nothing in the scene, and every move is such a row —
                          while a move is a statement that can be held back
                          exactly as a body can. */}
                      <span onClick={row.onSkip} title={row.skipTitle} style={css('width:22px;display:flex;justify-content:center;cursor:pointer;flex:none')}>
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
                      <span onClick={row.onRemove} title={row.removeTitle} style={css('color:var(--text-faint);cursor:pointer')}>&#10005;</span>
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
                          <span style={css(`flex:1;font:400 10px ${MONO};color:var(--text-muted)`)}>{row.op}</span>
                          <span onClick={row.onRole} title="solid adds material, hole takes it away" style={css(row.roleStyle)}>{row.role}</span>
                        </div>
                      )}
                      {row.groups.map((g) => (
                        <div key={g.key} style={css('display:flex;align-items:center;gap:5px;margin-top:5px')}>
                          <span style={css(`width:50px;flex:none;font:400 9.5px ${MONO};color:var(--text-muted)`)}>{g.label}</span>
                          {/* `type` AND `step` COME OFF THE FIELD, so a number
                              gets the browser's own arrows and an extrusion's
                              profile — `x,y; x,y; …`, which is no kind of number
                              — does not. `ref` is how a nudge of those arrows
                              reaches the document; `field` in `computed()` says
                              why React leaves it no other way, and what
                              `onWheel` is for. */}
                          {g.fields.map((f) => (
                            <input key={f.key} type={f.type} step={f.step} ref={f.ref}
                                   value={f.value} onChange={f.onChange} onBlur={f.onBlur}
                                   onKeyDown={f.onKeyDown} onWheel={f.onWheel} style={css(f.style)} />
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

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
                  <div style={css('display:flex;align-items:center;gap:8px')}>
                    <span style={css(`font:600 12.5px ${SANS};flex:none`)}>Comparing</span>
                    <span title={v.cmpA} style={css(`font:600 12px ${MONO};background:var(--chip-bg);padding:2px 7px;border-radius:4px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`)}>{v.cmpA}</span>
                    <span style={css('color:var(--text-muted);flex:none')}>&#8594;</span>
                    <span title={v.cmpB} style={css(`font:600 12px ${MONO};background:var(--chip-bg);padding:2px 7px;border-radius:4px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`)}>{v.cmpB}</span>
                    <span style={css('flex:1')} />
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
                  <div style={css('display:flex;align-items:center;gap:8px;margin-bottom:5px')}><span style={css(v.legendAddedStyle)} /><span style={css(`font:400 11.5px ${SANS}`)}>added &mdash; material only in {v.cmpB}</span></div>
                  <div style={css('display:flex;align-items:center;gap:8px;margin-bottom:5px')}><span style={css(v.legendRemovedStyle)} /><span style={css(`font:400 11.5px ${SANS}`)}>removed &mdash; material only in {v.cmpA}</span></div>
                  {/* THE COLOUR'S MEANING AND NOT A CLAIM ABOUT THE TAB. It
                      read "both revisions, ghosted", which is true of Overlay
                      and false of the two tabs beside it: A-only and B-only
                      show exactly one revision, ghosted in this same colour. */}
                  <div style={css('display:flex;align-items:center;gap:8px')}><span style={css(v.legendNeutralStyle)} /><span style={css(`font:400 11.5px ${SANS}`)}>unchanged &mdash; ghosted</span></div>
                  {/* THE ONE EXPLANATION THAT IS TRUE OF A CATEGORY AND NOT OF A
                      PART, so it is said once here instead of once per row. Every
                      `not compared` row means the same thing — no pair of STEP
                      files came from the two builds, so nothing was fused — and a
                      model with eight bought screws printed the hub's sentence
                      eight times, in a panel whose job is to show what CHANGED.
                      The hub still writes the sentence on each row; the panel
                      spends the height once.
                      AND IT SAYS WHAT THE HUB'S SENTENCE SAYS, in the same order:
                      the definition first, hardware and mocks as the example they
                      are (`cadbuild/comparescene._uncovered_line`). This line
                      named them as the definition for a round, which is false of
                      a part that was `printable` in one revision and hardware in
                      the other — there one build did export a STEP.
                      ALWAYS DRAWN, not only when such a row is on screen: the
                      legend is part of the panel rather than of the list, so
                      there is no arrangement in which a row can appear without
                      it. `not measured` is deliberately NOT here — that sentence
                      is about one part and what went wrong with it, and it stays
                      on that part's row. */}
                  <div style={css('display:flex;align-items:center;gap:8px;margin-top:7px;padding-top:7px;border-top:1px solid var(--line-soft)')}><span style={css(v.legendNotComparedStyle)}>{v.legendNotCompared}</span><span style={css(`font:400 11.5px ${SANS}`)}>{v.legendNotComparedWhy}</span></div>
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

            {/* views and tools. THE LAYER IS A VALUE rather than a constant
                here — see `toolbarStyle`: the view menu opens INSIDE this
                toolbar, so it is the toolbar that has to rise above the
                overlays sharing the model with it. */}
            <div style={css(v.toolbarStyle)}>
              <div style={css('pointer-events:auto;display:flex;align-items:center;gap:8px;padding:4px;background:var(--float-bg);backdrop-filter:blur(10px);border:1px solid var(--line);border-radius:9px;box-shadow:0 4px 16px var(--shadow-soft)')}>
                {/* A STRIP WHILE THE VIEWS FIT, A MENU WHEN THEY DO NOT — see
                    `VIEW_TABS_MAX`. The wrapper is `position:relative` so that
                    the menu is anchored to the BUTTON: the toolbar carries a
                    `backdrop-filter` and is therefore already a containing
                    block for it (CSS Filter Effects 2, §2.1), so without the
                    wrapper the menu would be measured from the toolbar's whole
                    box and start at its left end rather than at the button. */}
                {v.viewMenu ? (
                  <div style={css('position:relative')}>
                    <div onClick={v.viewsToggle} title={v.viewLabel} style={css(v.viewBtnStyle)}>
                      <span style={css(v.viewLabelStyle)}>{v.viewLabel}</span>
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 6l4 4 4-4" /></svg>
                    </div>
                    <div onClick={(e) => e.stopPropagation()} style={css(v.viewMenuStyle)}>
                      {v.viewTabs.map((t) => (
                        <div key={t.key} onClick={t.onClick} style={css(t.rowStyle)}>
                          <span style={css('flex:1')}>{t.label}</span>
                          <span style={css(`font:400 10.5px ${MONO};color:var(--text-faint)`)}>{t.hint}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div style={css('display:flex;gap:2px;padding:2px;background:var(--chip-bg);border-radius:6px')}>
                    {v.viewTabs.map((t) => (
                      <div key={t.key} onClick={t.onClick} title={t.hint} style={css(t.style)}>{t.label}</div>
                    ))}
                  </div>
                )}
                {/* Everything between the tabs and Fit belongs to a pointer and
                    a canvas with room to aim in — see `showTools`. */}
                {v.showTools && (
                  <>
                    <div style={css('width:1px;height:18px;background:var(--line)')} />
                    <div onClick={v.tMeasure} style={css(v.measureBtnStyle)}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 14L14 2M2 14l2.2-.55M14 2l-.55 2.2M6.2 9.8l1.4 1.4M9 7l1.4 1.4" /></svg>
                      Measure
                    </div>
                    <div onClick={v.tComment} style={css(v.commentBtnStyle)}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 2.5h12v8.5H8.5L5.5 14v-3H2z" /><path d="M5 5.5h6M5 8h4" /></svg>
                      Comment
                    </div>
                    {/* A box drawn in the air beside the model — which is what
                        this opens: a rough body in numbers, over the geometry
                        rather than in it. Absent, not hidden, on a hub that did
                        not ask for it: see `proposalOn` in `computed()`. */}
                    {v.proposalOn && (
                      <div onClick={v.tProposal} style={css(v.proposalBtnStyle)}>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 4.6L8 1.8l6 2.8v6.8L8 14.2 2 11.4z" /><path d="M2 4.6L8 7.4l6-2.8M8 7.4v6.8" /></svg>
                        Proposal
                      </div>
                    )}
                    <div style={css('width:1px;height:18px;background:var(--line)')} />
                  </>
                )}
                <div onClick={v.fitView} title="back to the frame this view opened in" style={css(`display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:6px;font:500 12px ${SANS};color:var(--text-soft);cursor:pointer;border:1px solid transparent`)}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5" /></svg>
                  Fit
                </div>
                {v.showTools && (
                  <div onClick={v.grabFrame} title="save the current frame as a PNG" style={css(`display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:6px;font:500 12px ${SANS};color:var(--text-soft);cursor:pointer;border:1px solid transparent`)}>
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1.5" y="4" width="13" height="9.5" rx="1.5" /><circle cx="8" cy="8.7" r="2.6" /></svg>
                    Frame
                  </div>
                )}
              </div>
            </div>

            {/* a newer build landed — offered, not substituted */}
            <div style={css('position:absolute;left:0;right:0;top:14px;display:flex;justify-content:center;pointer-events:none;z-index:13')}>
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
                <span style={css(`font:600 12px ${MONO}`)}>{v.measText}</span>
                {/* The qualifier the brief insists on: a distance taken between
                    parts that have been laid apart is not the assembled one. */}
                {v.measNote && <span style={css(`font:500 10.5px ${MONO};color:var(--warn);background:var(--warn-bg);padding:3px 7px;border-radius:4px`)}>{v.measNote}</span>}
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
              <div style={css(`display:flex;align-items:center;gap:6px;font:600 10px ${MONO};color:var(--warn);letter-spacing:.06em`)}>
                NOTE &middot; {v.noteName}
                <span style={css('flex:1')} />
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
                <div style={css(`font:600 9px ${MONO};color:var(--warn-soft);letter-spacing:.07em`)}>FROM THE MODEL</div>
                <div style={css(`font:400 11.5px/1.5 ${SANS};color:var(--text-soft);margin-top:3px`)}>{v.authorNote}</div>
              </div>
              <div style={css(v.readerNoteStyle)}>
                <div style={css(`font:600 9px ${MONO};color:var(--warn-soft);letter-spacing:.07em`)}>ONLY IN THIS BROWSER</div>
                <div style={css(`font:400 11.5px/1.5 ${SANS};color:var(--text-soft);margin-top:3px`)}>{v.noteText}</div>
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

            {/* The bottom-left corner is the VIEWPORT'S: it draws the view cube
                there (ui/src/viewport/viewcube.js). A static axis triad used to
                be drawn here instead, and it never turned with the camera — see
                issues #23 and #24. */}

            <div style={css(`position:absolute;right:14px;bottom:12px;font:400 10.5px ${MONO};color:var(--text-muted);pointer-events:none`)}>{v.hintText}</div>

            {/* the composer: the frame rides along by itself, the photo does not */}
            <div onClick={(e) => e.stopPropagation()} style={css(v.composerStyle)}>
              <div style={css('display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line-soft)')}>
                <span style={css(`width:20px;height:20px;border-radius:10px 10px 10px 3px;background:var(--accent);color:var(--text-on-accent);display:flex;align-items:center;justify-content:center;font:600 10.5px ${MONO}`)}>{v.nextLabel}</span>
                <span style={css(`font:600 12px ${SANS}`)}>Task for the agent</span>
                {/* Only when there IS a part: the separator belongs to the name,
                    and a draft that lost its attachment to a revision swap would
                    otherwise keep a lone middle dot standing where it used to
                    be — a leftover pointing at the build the page has left. */}
                {v.composerPart
                  ? <span style={css(`font:400 11px ${MONO};color:var(--text-muted)`)}>&middot; {v.composerPart}</span>
                  : null}
                <span style={css('flex:1')} />
                <span onClick={v.compCancel} style={css('color:var(--text-faint);cursor:pointer')}>&#10005;</span>
              </div>
              <textarea
                value={v.composerText}
                onChange={v.compType}
                maxLength={MAX_COMMENT_CHARS}
                placeholder="e.g. gap here is 2.4 — make it 3"
                style={css(`width:100%;box-sizing:border-box;border:none;outline:none;resize:none;padding:10px 12px;font:400 12.5px/1.5 ${SANS};color:var(--text);height:64px;background:transparent`)}
              />
              <div style={css('display:flex;align-items:center;gap:6px;padding:0 12px 10px;flex-wrap:wrap')}>
                <span style={css(`display:flex;align-items:center;gap:5px;padding:4px 8px;background:var(--sunken-bg);border-radius:5px;font:400 10.5px ${MONO};color:var(--text-soft)`)}>
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1.5" y="4" width="13" height="9.5" rx="1.5" /><circle cx="8" cy="8.7" r="2.6" /></svg>
                  camera frame &mdash; attached automatically
                </span>
                <span style={css(v.compMeasChipStyle)}>&#8596; {v.compMeasText} <span onClick={v.compMeasRemove} style={css('cursor:pointer;opacity:.6')}>&#10005;</span></span>
                <span style={css(v.compProposalChipStyle)}>&#9634; proposal attached <span onClick={v.compProposalRemove} style={css('cursor:pointer;opacity:.6')}>&#10005;</span></span>
                <label style={css(`padding:4px 8px;border:1px dashed var(--line-strong);border-radius:5px;font:400 10.5px ${MONO};color:var(--text-muted);cursor:pointer`)}>
                  {v.compPhotoName ? `photo: ${v.compPhotoName}` : '+ photo of the print'}
                  <input type="file" accept="image/jpeg,image/png,image/webp"
                         onChange={v.compPhoto} style={{ display: 'none' }} />
                </label>
                <span style={css('flex:1')} />
                <span onClick={v.compSend} style={css(v.compSendStyle)}>{v.compSendLabel}</span>
              </div>
            </div>

            {/* the section plane */}
            <div onClick={(e) => e.stopPropagation()} style={css(v.secPopStyle)}>
              <div style={css('display:flex;align-items:center;gap:8px;margin-bottom:10px')}>
                <span style={css(`font:600 12.5px ${SANS}`)}>Section plane</span>
                <span style={css('flex:1')} />
                <span onClick={v.closeSecPop} style={css('color:var(--text-faint);cursor:pointer')}>&#10005;</span>
              </div>
              <div onClick={v.pickFace} style={css(v.pickFaceStyle)}>{v.pickFaceText}</div>
              <div style={css(`display:flex;justify-content:space-between;font:500 11px ${MONO};color:var(--text-soft);margin:12px 0 5px`)}>
                <span>offset</span><span style={css('color:var(--text)')}>{v.secOffLabel}</span>
              </div>
              {/* The range is the viewport's: it comes back on `hmr:face` from the
                  model's own extent, so a 400 mm part and a 4 mm one both get a
                  slider that spans them. */}
              <input type="range" min={v.secMin} max={v.secMax} step={v.secStep}
                     value={v.secOff} onChange={v.setSecOff} style={{ width: '100%' }} />
              <div style={css('display:flex;gap:6px;margin-top:10px')}>
                <div onClick={v.flipSec} style={css(`flex:1;padding:6px;text-align:center;border:1px solid var(--line);border-radius:5px;font:500 11px ${MONO};color:var(--text-soft);cursor:pointer;background:var(--card-bg)`)}>flip side</div>
                <div onClick={v.resetSec} style={css(`flex:1;padding:6px;text-align:center;border:1px solid var(--line);border-radius:5px;font:500 11px ${MONO};color:var(--text-soft);cursor:pointer;background:var(--card-bg)`)}>reset</div>
              </div>
              <div onClick={v.toggleHatch} style={css('display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:11px')}>
                <span style={css(v.hatchBox)}>{v.hatchMark}</span>
                <span style={css(`font:400 11.5px ${SANS};color:var(--text-soft)`)}>hatch the cut face</span>
              </div>
            </div>

            {/* ── the proposal: a rough body the model has to fit, in numbers ──

                THE DOCUMENT ITSELF IS NOT HERE ANY MORE. Every node of it is a
                row in the proposal's own branch of the tree, over on the left,
                where a selected row opens the very fields this panel used to
                carry. What is left is everything ABOUT a proposal rather than IN
                one: what it is for, the buttons that add a body, the sentence
                that explains a document with nothing in it, what the kernel
                makes of the one there is, and the door out to a comment.

                NUMBERS AND ONE HAND. The fields are where a body is SIZED, and
                they are the only way to say `20 x 20 x 20`; where it SITS can
                also be dragged, with the Move tool over the body itself — the
                gesture ends in `hmr:proposalmove` and writes the `at` fields the
                reader is looking at, so the two ways of saying it are one thing
                (`proposalgeom.js` for what is grabbable: every body on its own,
                solids and holes alike, so a drag moves the one under the
                cursor).

                WHAT IS STILL NOT HERE is a gizmo, a handle of our own and
                click-to-place. The library's id-picker answers about parts that
                are IN THE SCENE (issue #90) — which a staged body is, and which
                is why the drag needed no hit-testing of ours — while an empty
                spot in space is not, so putting a new body where the cursor is
                remains a separate piece of work. */}
            {v.proposalOn && (
              <div onClick={(e) => e.stopPropagation()} style={css(v.proposalPanelStyle)}>
                <div style={css('display:flex;align-items:center;gap:8px;margin-bottom:3px')}>
                  <span style={css(`font:600 12.5px ${SANS}`)}>Proposal</span>
                  <span style={css('flex:1')} />
                  <span onClick={v.proposalClose} style={css('color:var(--text-faint);cursor:pointer')}>&#10005;</span>
                </div>
                {/* Block 6's tone, one step on: a way to SHOW the agent what you
                    want instead of describing it, and explicitly not an edit. */}
                <div style={css(`font:400 10.5px/1.5 ${MONO};color:var(--text-muted);margin-bottom:11px`)}>
                  a rough body for the agent to design against, or to follow &mdash; a
                  motor to clear, a wall to bolt to, a bought part, an example of the
                  layout you want. Nothing here changes the model and nothing is saved:
                  the next rebuild forgets it.
                </div>

                <div style={css(v.proposalEmptyStyle)}>
                  add a box, a cylinder, a sphere or an extruded profile, then say how
                  big it is and where it sits. Every measurement is a plain number
                  &mdash; there is no arithmetic.
                </div>
                <div style={css('display:flex;flex-wrap:wrap;gap:5px')}>
                  {v.proposalOps.map((op) => (
                    <div key={op.key} onClick={op.onClick} style={css(`padding:4px 9px;border:1px dashed var(--line-strong);border-radius:5px;font:500 10.5px ${MONO};color:var(--text-soft);cursor:pointer`)}>{op.label}</div>
                  ))}
                </div>

                {/* WHAT THE PANEL HAS TO SAY (`proposalSays` in `computed`): the
                    kernel's own sentence about the document as it stands. While
                    it is there the body over the model is the last one that
                    BUILT rather than nothing at all — see `setProposal`. */}
                <div style={css(v.proposalSaysStyle)}>{v.proposalSays}</div>

                <div style={css('display:flex;align-items:center;gap:10px;margin-top:11px;padding-top:9px;border-top:1px solid var(--line-soft)')}>
                  <span style={css(`flex:1;font:400 10px ${MONO};color:var(--text-muted)`)}>result = union(solid) &minus; union(hole)</span>
                  <span onClick={v.proposalAdd} style={css(v.proposalAddStyle)}>add to comment</span>
                </div>
              </div>
            )}

            <div style={css(v.toastStyle)}>{v.toastText}</div>
          </div>

          {/* ── the comment rail ── */}
          <div style={css(v.railStyle)}>
            <div style={css('flex:none;display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line-soft)')}>
              <span style={css(`font:600 12.5px ${SANS}`)}>Comments</span>
              <span style={css('flex:1')} />
              <span onClick={v.railToggle} style={css('color:var(--text-faint);cursor:pointer;font-size:14px')}>&#10005;</span>
            </div>
            {/* The whole project queue since issue #33, so nothing here has to
                explain what it is not showing. Each row says where it hangs on
                the build in view instead — see `threads` in `computed`. */}
            <div style={css('flex:1;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:10px')}>
              {v.threads.map((c) => (
                <div key={c.key} onClick={c.onOpen} style={css(c.style)}>
                  <div style={css('display:flex;align-items:center;gap:8px')}>
                    <span style={css(c.pinStyle)}>{c.label}</span>
                    <span style={css(`font:500 11.5px ${MONO};color:var(--text)`)}>{c.part}</span>
                    <span style={css('flex:1')} />
                    <span style={css(`font:400 10.5px ${MONO};color:var(--text-muted)`)}>{c.time}</span>
                  </div>
                  <div style={css(`font:400 12px/1.5 ${SANS};color:var(--text);margin:7px 0 8px`)}>{c.text}</div>
                  <div style={css(c.saysStyle)}>{c.says}</div>
                  <div style={css('display:flex;align-items:center;gap:10px;margin-top:8px')}>
                    <span onClick={c.onResolve} style={css(`font:500 10.5px ${MONO};color:var(--text-muted);` + (c.resolved ? 'cursor:default' : 'cursor:pointer'))}>
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
            {/* A row that carries a file is an ANCHOR and not a div: the download
                is the browser's to do, exactly as in the header's menu, so the
                link is a real one and can be middle-clicked or saved as. */}
            {v.menuItems.map((m) => {
              const inner = (
                <>
                  <span style={css('flex:1')}>{m.label}</span>
                  <span style={css(`font:400 10.5px ${MONO};color:var(--text-faint)`)}>{m.hint}</span>
                </>
              );
              return m.href
                ? <a key={m.key} href={m.href} download onClick={m.onClick} style={css(m.style)}>{inner}</a>
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
            {/* Half of this used to be false: it said the hub has no endpoint
                for notes, and the hub now publishes the AUTHOR's. What is still
                true is the half about THIS note — it stays here, and no route
                writes it back — so the sentence says that, and then says where
                a note that has to travel is written instead. Somebody who wants
                the next reader to see what they just typed needs that address
                more than they need to know what this box does not do. */}
            <div style={css(`font:400 10.5px/1.5 ${MONO};color:var(--text-muted);margin-top:6px`)}>
              stays in this browser &mdash; nothing sends it to the hub. A note that
              travels with the build, for everyone who opens it, is written in model.py
            </div>
            <div style={css('display:flex;gap:8px;justify-content:flex-end;margin-top:8px')}>
              <span onClick={v.noteCancel} style={css(`padding:6px 12px;border-radius:6px;font:500 11.5px ${SANS};color:var(--text-soft);cursor:pointer`)}>Cancel</span>
              <span onClick={v.noteSave} style={css(`padding:6px 14px;background:var(--accent);color:var(--text-on-accent);border-radius:6px;font:600 11.5px ${SANS};cursor:pointer`)}>Save</span>
            </div>
          </div>

        </div>
      </div>
    );
  }
}
