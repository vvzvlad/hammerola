// The contract between <hmr-viewport> and the React interface around it.
//
// The names come from the designer's mock-up, which is what the React side was
// written against: one event DOWN (`hmr:state`, the whole of what the interface
// tells the viewport) and a handful UP, one per thing a person can do to the
// model. THIS IS THE ONLY FILE IN THE BUNDLE THAT SPELLS ONE OF THESE STRINGS:
// the React side imports these same constants under shorter aliases
// (`ui/src/events.js`, `EVENT_PICK as PICK`) rather than keeping a copy, so the
// two ends cannot disagree. `tests/test_ui_source.py` and
// `tests/test_viewport_adapter.py` keep it that way from either side — no
// `hmr:` literal anywhere under `ui/src` but here.
//
// EVERY UP-EVENT IS DISPATCHED ON THE ELEMENT, WITH `bubbles`. The mock-up
// dispatched on `window`, and React code written against it listens there — a
// bubbling event reaches `window` through the ordinary propagation path, so that
// keeps working, while a listener attached to the element itself (a React ref,
// the natural thing to write) also sees it. The difference matters the day two
// viewports are on one page, which the diff view (ui-brief block 9) is heading
// towards: `event.target` is then the only thing that says which one spoke, and
// a `window.dispatchEvent` carries no such answer.

/**
 * The element's tag — the other half of the contract, and the half the interface
 * has to spell in order to render the thing at all.
 *
 * HERE AND NOT IN `index.js`, where it used to live, because that module DEFINES
 * the element: evaluating it calls `customElements.define`. Taking the name from
 * there meant every component that only wanted the string dragged the
 * registration in behind it, which quietly turned the deliberate side-effect
 * `import './viewport/index.js'` in main.jsx into one of two paths to it instead
 * of the only one — and the day the other path was rearranged away, the tag would
 * stay unknown, `whenDefined` would never settle, and nothing would say so. This
 * module runs nothing on import, so the name can be shared with anybody.
 */
export const TAG = "hmr-viewport";

/** Down: the interface hands the viewport its whole state, merged over the old. */
export const EVENT_STATE = "hmr:state";

/** Up: a part was clicked (or the background was, with `id: null`). */
export const EVENT_PICK = "hmr:pick";

/** Up: a part was right-clicked; the interface's part menu belongs at x/y.
 *
 * NOT IN THE MOCK-UP either, and it is here for the same kind of reason as the
 * two further down: the mock's part menu hangs off a tree row, and the tree is
 * a list of names beside a model somebody is already pointing at. Asking for
 * the thing under the cursor is the shorter route to it, and the scene is the
 * only place that can answer which part that is.
 *
 * `id` is null when the background was right-clicked — the same convention
 * `EVENT_PICK` uses, and the interface reads it as "close the menu", there being
 * no items about the view as a whole.
 *
 * IT CARRIES SCREEN COORDINATES, unlike every other event here, and that is
 * deliberate rather than a leak of presentation into the contract: a context
 * menu is defined as opening AT THE CURSOR, and by the time the interface hears
 * about this there is no event left for it to read a cursor off.
 */
export const EVENT_MENU = "hmr:menu";

/** Up: a face was clicked with the cut tool armed; the plane now lies on it. */
export const EVENT_FACE = "hmr:face";

/** Up: a measurement resolved to a number. */
export const EVENT_MEASURE = "hmr:measure";

/** Up: a part was dragged; `delta` is the offset from where the build put it. */
export const EVENT_MOVED = "hmr:moved";

/** Up: a point on the model was picked as a comment anchor. */
export const EVENT_PLACE = "hmr:place";

/** Up: one of the pins drawn over the canvas was clicked. */
export const EVENT_PIN = "hmr:pin";

// The two below are NOT in the mock-up, and they are additions rather than
// liberties taken:
//
//   * the mock-up carries its parts as a hard-coded array, so the tree it draws
//     needs no announcing. A real build's tree is inside the view file the
//     viewport fetches, and ui-brief block 3 puts the tree in the interface —
//     so something has to hand it over, and this is it;
//   * the mock-up cannot fail. A real one can: a view file that 404s, a WebGL
//     context that will not start. Block 11 is explicit that a page which shows
//     nothing has to say so, and a silent viewport leaves the interface drawing
//     a frame around a hole.

/** Up: a view finished rendering. Carries the part tree the interface draws. */
export const EVENT_MODEL = "hmr:model";

/** Up: something the viewport was asked to do did not happen. */
export const EVENT_ERROR = "hmr:error";

/** Up: the tool changed for a reason the interface did not ask for.
 *
 * There is exactly one such reason and it is ui-brief block 4: the hold key.
 * Holding it puts the cut tool up for as long as it is down, and the brief
 * requires the reader to be able to SEE that a cut is on — which the interface
 * can only do if it is told. The viewport owns the key rather than React because
 * which key is safe, and every way its release can go missing, is knowledge that
 * came out of the library's own shortcut table (see holdkey.js).
 */
export const EVENT_TOOL = "hmr:tool";

/** Every name this module owns, for the tests and for a quick audit. */
export const EVENTS_UP = [
  EVENT_PICK, EVENT_MENU, EVENT_FACE, EVENT_MEASURE, EVENT_MOVED,
  EVENT_PLACE, EVENT_PIN, EVENT_MODEL, EVENT_ERROR, EVENT_TOOL,
];

/**
 * Send one up-event from `host`.
 *
 * `composed` alongside `bubbles` so the event still crosses a shadow boundary if
 * the interface ever wraps the viewport in one — the cost is nothing today and
 * the failure it prevents (an event that stops dead at a boundary nobody
 * remembers adding) is silent.
 */
export function emit(host, name, detail) {
  host.dispatchEvent(new CustomEvent(name, {
    detail, bubbles: true, composed: true,
  }));
}
