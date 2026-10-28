// The names on the wire between this interface and the 3D viewport.
//
// A name that disagrees has no symptom: a listener for a name nobody dispatches
// is silence, not an error. So this file spells nothing: every name is written
// once, in `viewport/events.js`, and re-exported here under a shorter alias
// (`PICK` rather than `EVENT_PICK`). `tests/test_ui_source.py` checks that no
// `hmr:` literal appears under `ui/src` outside that module.
//
// The viewport dispatches every up-event on the element with `bubbles: true`, so
// the listeners here sit on `window`. With two viewports on one page,
// `event.target` would be the only thing that says which one spoke.
//
// Imported and then exported (not `export ... from`) because `UP_EVENTS` below
// needs the names as local bindings.

import {
  EVENT_STATE as STATE,
  EVENT_PICK as PICK,
  EVENT_MENU as MENU,
  EVENT_FACE as FACE,
  EVENT_MEASURE as MEASURE,
  EVENT_MOVED as MOVED,
  EVENT_PROPOSALMOVE as PROPOSALMOVE,
  EVENT_TURNED as TURNED,
  EVENT_PROPOSALTURN as PROPOSALTURN,
  EVENT_PLACE as PLACE,
  EVENT_PIN as PIN,
  EVENT_MODEL as MODEL,
  EVENT_ERROR as ERROR,
  EVENT_TOOL as TOOL,
  EVENT_PROGRESS as PROGRESS,
} from './viewport/events.js';

/*
 * WHAT EACH ONE CARRIES, in the shape this side reads it.
 *
 *   STATE    down: the whole of what this interface asks the viewport to show
 *   PICK     {id, name, point}   -- `id` is null when the background was clicked
 *   MENU     {id, name, x, y}    -- a part was right-clicked; x/y are the cursor
 *   FACE     {id, name, point, normal, offset, range}  -- the section plane moved
 *   MEASURE  a resolved measurement; see `measureLabel` for the fields that matter
 *   MOVED    {id, name, paths, count, delta: [x, y, z]}  -- a part was dragged;
 *            sent once, on the RELEASE, `paths` is every path that moved,
 *            `id`/`name` the first of them and `count` how many there were
 *   PROPOSALMOVE {name, delta: [x, y, z]}  -- a body of the PROPOSAL was dragged;
 *            sent once, on the release, like the one above; `name` is the body
 *            it was drawn under, and it names the one node of the document that
 *            moves
 *   TURNED   {id, name, paths, count, build, turn: [x, y, z]}  -- a part was
 *            turned with the rings; the same shape as MOVED and the same four
 *            endings, with three DEGREES about the three axes in place of the
 *            offset. Cumulative from the pose the build gives the part
 *   PROPOSALTURN {name, turn: [x, y, z]}  -- a body of the PROPOSAL was turned;
 *            `turn` is how far this gesture took it, to be added to the body's
 *            own `rot`, because the document is where a body's pose lives and
 *            the viewport has never read it
 *   PLACE    {id, name, p: [x, y, z], n: [x, y, z] | null}
 *                                           -- a point was picked for a comment;
 *            `n` is the face normal there, turned toward the camera
 *   PIN      {id}                           -- a comment arrow was pressed
 *   MODEL    {view, buildKey, tree, live}   -- a view finished rendering
 *   ERROR    {stage, message}  -- something asked for did not happen
 *   TOOL     {tool, held, escape}
 *   PROGRESS {view, received, total, done}  -- the view file coming in: decoded
 *            bytes so far, the view's `bytes` from meta.json (absent for a
 *            comparison's scene), and `done` once the last byte is in
 *
 * MODEL is where the part tree comes from: the viewport already fetches the
 * view file (about two megabytes) to render it, and the tree is inside it, so
 * this interface does not fetch its own copy.
 *
 * TOOL is the tool changing without this interface asking -- the hold key, which
 * the viewport owns. The reader must see that a cut is on, so this side has to
 * be told.
 */
export {
  STATE, PICK, MENU, FACE, MEASURE, MOVED, PROPOSALMOVE, TURNED, PROPOSALTURN,
  PLACE, PIN, MODEL, ERROR, TOOL, PROGRESS,
};

/** Every event the viewport sends us, in one list — see componentDidMount. */
export const UP_EVENTS = [PICK, MENU, FACE, MEASURE, MOVED, PROPOSALMOVE,
                          TURNED, PROPOSALTURN, PLACE, PIN, MODEL, ERROR, TOOL,
                          PROGRESS];

/** The custom element the adapter registers.
 *
 * Taken from the contract module, not from `viewport/index.js`: importing that
 * one runs `customElements.define`, which only main.jsx should trigger.
 */
export { TAG as VIEWPORT_TAG } from './viewport/events.js';
