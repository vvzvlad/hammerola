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

// The hold key is exported because its `typingTarget` rule and its three
// stuck-key nets are worth exactly as much to a React-side shortcut as they are
// here, and a second, simpler implementation beside it would be the one that
// leaves a mode stuck on.
export { installHoldKey, isHoldKey, typingTarget } from "./holdkey.js";

// Where the library is loaded from, for a preload hint or a health check.
export { VIEWER_MODULE_URL } from "./library.js";
