// The names on the wire between this interface and the 3D viewport.
//
// A NAME THAT DISAGREES HAS NO SYMPTOM, which is the whole reason they are
// managed at all. An addEventListener for a name nobody dispatches is not an
// error, it is silence: the button is on the screen, the click reaches the
// handler, the event goes out and lands nowhere. Nothing logs, nothing throws,
// nothing turns red.
//
// SO THIS FILE SPELLS NOTHING. Every name is written once, in the viewport's own
// contract module (`viewport/events.js`), and arrives here renamed to the
// shorter form React code reads better with -- `PICK` rather than `EVENT_PICK`.
// The two halves DO share a module graph -- main.jsx imports
// `./viewport/index.js`, and the component calls the element's methods directly
// (`el.getCamera`, `el.setCamera`) -- so this seam was never a pure event
// boundary, and a second copy of the names here bought no independence from the
// other half. It bought a second place for one of them to be wrong, checked by a
// test that could only report the drift after it happened. A shared import makes
// the drift impossible instead, and `tests/test_ui_source.py` now checks the
// property that replaces it: no `hmr:` literal anywhere under `ui/src` except
// that one module.
//
// WHERE THEY ARE LISTENED FOR. The viewport dispatches every up-event on the
// ELEMENT, with `bubbles: true`, so `window` sees them through ordinary
// propagation and this file's listeners are on `window`. That will stop being
// good enough the day two viewports share a page -- the diff view is heading
// there -- because then `event.target` is the only thing that says which one
// spoke.
//
// IMPORTED AND THEN EXPORTED rather than re-exported in one `export ... from`:
// `UP_EVENTS` below is this side's own list and needs the names as local
// bindings, which a bare re-export does not create.

import {
  EVENT_STATE as STATE,
  EVENT_PICK as PICK,
  EVENT_MENU as MENU,
  EVENT_FACE as FACE,
  EVENT_MEASURE as MEASURE,
  EVENT_MOVED as MOVED,
  EVENT_PROPOSALMOVE as PROPOSALMOVE,
  EVENT_PLACE as PLACE,
  EVENT_PIN as PIN,
  EVENT_MODEL as MODEL,
  EVENT_ERROR as ERROR,
  EVENT_TOOL as TOOL,
} from './viewport/events.js';

/*
 * WHAT EACH ONE CARRIES, in the shape this side reads it.
 *
 *   STATE    down: the whole of what this interface asks the viewport to show
 *   PICK     {id, name, point}   -- `id` is null when the background was clicked
 *   MENU     {id, name, x, y}    -- a part was right-clicked; x/y are the cursor
 *   FACE     {id, name, point, normal, offset, range}  -- the section plane moved
 *   MEASURE  a resolved measurement; see `measureLabel` for the fields that matter
 *   MOVED    {id, name, count, delta: [x, y, z]}  -- a part was dragged; `count`
 *            is how many copies of it went along, `id`/`name` the first of them
 *   PROPOSALMOVE {name, delta: [x, y, z]}  -- a body of the PROPOSAL was dragged;
 *            `name` is the body it was drawn under, `result` meaning the fused
 *            body and therefore every node of the document at once
 *   PLACE    {id, name, p: [x, y, z]}       -- a point was picked for a comment
 *   PIN      {id}                           -- a comment pin was clicked
 *   MODEL    {view, buildKey, tree, live}   -- a view finished rendering
 *   ERROR    {stage, message}  -- something asked for did not happen
 *   TOOL     {tool, held, escape}
 *
 * Two of them are worth more than a line:
 *
 * MODEL is where the part tree comes from, and it is the reason this interface
 * does not fetch a view file of its own. The viewport has to fetch it to render
 * it -- two megabytes of it -- and the tree is inside that same document, so
 * asking for it separately would double the transfer to re-derive something the
 * other half already has in hand.
 *
 * TOOL is the tool changing without this interface asking. There is one such
 * reason, and it is the hold key: the viewport owns it (which key is safe took
 * reading the library's own shortcut table to answer), and the brief requires the
 * reader to SEE that a cut is on -- which this side can only do if it is told.
 */
export {
  STATE, PICK, MENU, FACE, MEASURE, MOVED, PROPOSALMOVE, PLACE, PIN, MODEL, ERROR,
  TOOL,
};

/** Every event the viewport sends us, in one list — see componentDidMount. */
export const UP_EVENTS = [PICK, MENU, FACE, MEASURE, MOVED, PROPOSALMOVE, PLACE,
                          PIN, MODEL, ERROR, TOOL];

/** The custom element the adapter registers, under the adapter's own name for it.
 *
 * Taken from the contract module and deliberately NOT from `viewport/index.js`,
 * which is where the element is actually defined: importing THAT one here would
 * run `customElements.define` as a side effect of any component that only wanted
 * the string, and the registration would then hang on this re-export rather than
 * on the explicit import main.jsx makes for exactly that purpose.
 */
export { TAG as VIEWPORT_TAG } from './viewport/events.js';
