// The viewport's front door: define <hmr-viewport>.
//
// Importing this module registers the element; there is no init call, and no
// order dependency with React, because an element defined after a tag of that
// name is in the DOM is upgraded on the spot.
//
// Evaluating it is a side effect, so this module exports nothing: anything
// exported here would pull `customElements.define` into its importers' graph.
// The tag and event names live in `./events.js`, which runs nothing on import;
// main.jsx imports this file for the side effect only.

import { HmrViewport } from "./element.js";
import { TAG } from "./events.js";

// Guarded, because `customElements.define` throws on a duplicate name, and
// vite's dev server re-executes the module on every hot update.
if (typeof customElements !== "undefined" && !customElements.get(TAG)) {
  customElements.define(TAG, HmrViewport);
}

// Exports nothing, deliberately (see the header). `HmrViewport`, the hold key
// and the library URL are importable from `./element.js`, `./holdkey.js` and
// `./library.js`.
