// Entry point of the hub's browser UI, for BOTH pages that have one.
//
// One bundle, two mount points, and which one the document carries is what says
// which page this is. Mounting stays conditional on each of them for the reason
// it always was: a bundle is a bundle, and the pointer page loads none of this
// but could tomorrow, so a hard `createRoot(null)` would be a console error on a
// page with nothing wrong with it. An absent id means "not this page", never
// "something broke".
//
// The ids are the only coupling between this file and the templates, and nothing
// in either would report a mismatch — a page whose id was renamed simply renders
// nothing, silently. `tests/test_ui_bundle.py` is what checks the two agree.
import { createRoot } from 'react-dom/client'

import HammerolaEntry from './HammerolaEntry.jsx'
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

// The only condition left is the one the header explains: which page asked for
// an interface. There used to be a second one, an opt-in flag, which existed
// while this bundle was mounted BESIDE the viewer that served the build page;
// the template no longer carries that viewer, so there is nothing left to opt
// into.
const build = document.getElementById('hmr_root')
if (build) {
  createRoot(build).render(<HammerolaViewer />)
}

const index = document.getElementById('hmr_index')
if (index) {
  createRoot(index).render(<HammerolaEntry />)
}
