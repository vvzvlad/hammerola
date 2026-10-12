// The contract between <hmr-viewport> and the React interface around it.
//
// One event DOWN (`hmr:state`, the whole of what the interface tells the
// viewport) and a handful UP, one per thing a person can do to the model; the
// names come from the designer's mock-up. THIS IS THE ONLY FILE IN THE BUNDLE
// THAT SPELLS ONE OF THESE STRINGS: the React side imports these constants
// under shorter aliases (`ui/src/events.js`). `tests/test_ui_source.py` and
// `tests/test_viewport_adapter.py` check that no `hmr:` literal appears under
// `ui/src` elsewhere.
//
// Every up-event is dispatched on the element with `bubbles`, so a listener on
// `window` (as the React side uses) and one on the element both see it. With
// two viewports on one page, `event.target` says which one spoke.

/**
 * The element's tag — the other half of the contract, and the half the interface
 * has to spell in order to render the thing at all.
 *
 * Here and not in `index.js`, which defines the element (`customElements.define`
 * runs on import): a component that only wants the string must not pull in the
 * registration, which only main.jsx's side-effect import should trigger. This
 * module runs nothing on import.
 */
export const TAG = "hmr-viewport";

/** Down: the interface hands the viewport its whole state, merged over the old. */
export const EVENT_STATE = "hmr:state";

/** Up: a part was clicked (or the background was, with `id: null`). */
export const EVENT_PICK = "hmr:pick";

/** Up: a part was right-clicked; the interface's part menu belongs at x/y.
 *
 * Not in the mock-up: the scene is the only place that can say which part is
 * under the cursor.
 *
 * `id` is null when the background was right-clicked (as in `EVENT_PICK`); the
 * interface reads that as "close the menu".
 *
 * It carries screen coordinates, unlike every other event: a context menu opens
 * at the cursor, and the interface has no event left to read one off.
 */
export const EVENT_MENU = "hmr:menu";

/** Up: a face was clicked with the cut tool armed; the plane now lies on it. */
export const EVENT_FACE = "hmr:face";

/** Up: a measurement resolved to a number. */
export const EVENT_MEASURE = "hmr:measure";

/** Up: a part was dragged; `delta` is the offset from where the build put it. */
export const EVENT_MOVED = "hmr:moved";

/** Up: a body of the PROPOSAL was dragged; `delta` is how far it went.
 *
 * One gesture, two meanings. Dragging a MODEL part is a statement to the agent:
 * the interface writes a move node and the model is unchanged (`EVENT_MOVED`).
 * A proposal body is the reader's own drawing, so dragging it is an ordinary
 * edit: the panel adds `delta` to the body's `at` and re-stages. Separate names
 * because the two answer to different halves of the document.
 *
 * It names the body and carries no path: the proposal document has no paths,
 * so the panel finds the node by the part `name` it built
 * (ui/src/proposalgeom.js), where every body is a part of its own.
 */
export const EVENT_PROPOSALMOVE = "hmr:proposalmove";

/** Up: a part was TURNED with the rings; `turn` is three degrees about the
 *  three axes, measured from the way the build leaves the part standing.
 *
 * Separate from the drag rather than a flag on it: a drag says where the part
 * should be, this says which way it should face, and the other field of the
 * node is carried across untouched.
 *
 * Cumulative, like `hmr:moved`'s `delta`: it describes the whole turn from the
 * build's pose, and the node is replaced, never added to.
 */
export const EVENT_TURNED = "hmr:turned";

/** Up: a body of the PROPOSAL was turned with the rings; `turn` is how far it
 *  went, in three degrees.
 *
 * The proposal counterpart of `hmr:turned`, as `hmr:proposalmove` is of a drag.
 * The viewport knows a build part's pose and reports the whole turn; a body is
 * placed by the document, which the viewport never sees, so it reports how
 * much further the hand took it and the panel adds that to the body's `rot`.
 */
export const EVENT_PROPOSALTURN = "hmr:proposalturn";

/** Up: a point on the model was picked as a comment anchor. */
export const EVENT_PLACE = "hmr:place";

/** Up: one of the pins drawn over the canvas was clicked. */
export const EVENT_PIN = "hmr:pin";

// The two below are not in the mock-up:
//
//   * a real build's tree is inside the view file the viewport fetches, and
//     ui-brief block 3 puts the tree in the interface — so it is handed over;
//   * a real viewport can fail (a 404, a WebGL context that will not start),
//     and block 11 requires a page that shows nothing to say so.

/** Up: a view finished rendering. Carries the part tree the interface draws. */
export const EVENT_MODEL = "hmr:model";

/** Up: something the viewport was asked to do did not happen. */
export const EVENT_ERROR = "hmr:error";

/** Up: the tool changed for a reason the interface did not ask for.
 *
 * The one such reason is the hold key (ui-brief block 4): holding it puts the
 * cut tool up, and the reader must be able to see that a cut is on. The
 * viewport owns the key because which key is safe, and how its release can go
 * missing, comes from the library's shortcut table (see holdkey.js).
 */
export const EVENT_TOOL = "hmr:tool";

/** Every name this module owns, for the tests and for a quick audit. */
export const EVENTS_UP = [
  EVENT_PICK, EVENT_MENU, EVENT_FACE, EVENT_MEASURE, EVENT_MOVED,
  EVENT_PROPOSALMOVE, EVENT_TURNED, EVENT_PROPOSALTURN, EVENT_PLACE, EVENT_PIN,
  EVENT_MODEL, EVENT_ERROR, EVENT_TOOL,
];

/**
 * Send one up-event from `host`.
 *
 * `composed` alongside `bubbles` so the event still crosses a shadow boundary
 * if the viewport is ever wrapped in one.
 */
export function emit(host, name, detail) {
  host.dispatchEvent(new CustomEvent(name, {
    detail, bubbles: true, composed: true,
  }));
}
