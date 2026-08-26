// Entry point of the hub's browser UI.
//
// Mounting is conditional on purpose. Only templates/build.html carries the
// mount point, but a bundle is a bundle: the day another page loads it -- the
// project list, the pointer page -- a hard `createRoot(null)` would turn into a
// console error on a page that has nothing wrong with it. Absence of #hmr_root
// means "not this page", not "something broke".
import { createRoot } from 'react-dom/client'

import HammerolaViewer from './HammerolaViewer.jsx'

// The registration of `<hmr-viewport>`, said out loud. `customElements.define`
// runs at module scope in viewport/index.js, so importing the module IS the
// registration — nothing here references what it exports, which is what makes
// the line look removable to a linter and to a reader.
//
// It is also the ONLY path to that module, and it is kept that way on purpose:
// the tag and the event names live in `viewport/events.js`, which runs nothing
// on import, so no component reaches the registering module by wanting a name.
// The registration therefore does not hang on a re-export somebody could
// reasonably rearrange — a failure with no symptom to search for, since an
// unknown tag is an ordinary inline box and `customElements.whenDefined` for a
// name nothing defines is a promise that never settles.
//
// Order is not load-bearing either way: an element defined after a tag of that
// name is already in the DOM is upgraded on the spot.
import './viewport/index.js'

// The only condition left is the one the header explains: is this a page that
// asked for the interface at all. There used to be a second one, an opt-in flag,
// which existed while this bundle was mounted BESIDE the viewer that served the
// build page; the template no longer carries that viewer, so there is nothing
// left to opt into.
const mount = document.getElementById('hmr_root')
if (mount) {
  createRoot(mount).render(<HammerolaViewer />)
}
