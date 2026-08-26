// The viewport's front door: define <hmr-viewport>.
//
// Importing this module is what registers the element — there is no init call to
// forget, and no order dependency with React, because an element defined AFTER a
// tag of that name is already in the DOM is upgraded by the browser on the spot.
//
// EVALUATING IT IS A SIDE EFFECT, so anything importable from here is a name that
// drags the registration in behind it. The tag and the event names therefore live
// in `./events.js`, which runs nothing on import, and the interface takes them
// from there — which is why the event re-exports that used to sit below are gone.
// Adding a name below is a decision, not a convenience: it puts
// `customElements.define` into the import graph of whoever asks for it, and the
// deliberate side-effect import in main.jsx stops being the only path to it.

import { HmrViewport } from "./element.js";
import { TAG } from "./events.js";

// Guarded, because `customElements.define` THROWS on a duplicate name and a
// second definition is not a hypothetical: vite's dev server re-executes a module
// on every hot update, and an unguarded define would take the whole page down
// with a NotSupportedError the first time somebody saved a file.
if (typeof customElements !== "undefined" && !customElements.get(TAG)) {
  customElements.define(TAG, HmrViewport);
}

export { HmrViewport };

// AND NOTHING ELSE. There used to be four more names here — the hold key's
// three, and the library's URL — each with a plausible caller in mind and none
// with a real one, which is exactly the shape the rule above warns about: a name
// nobody asked for still puts `customElements.define` into the import graph of
// whoever eventually does, and by then it looks like the ordinary way to reach
// it. Their modules are `./holdkey.js` and `./library.js`, importable directly
// by anything that turns out to need them.
