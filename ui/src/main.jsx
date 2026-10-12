// Entry point of the hub's browser UI, for BOTH pages that have one.
//
// One bundle, two mount points; which one the document carries says which page
// this is. Mounting is conditional on each: an absent id means "not this page",
// never "something broke", and `createRoot(null)` would throw.
//
// The ids are the only coupling between this file and the templates, and nothing
// in either would report a mismatch — a page whose id was renamed simply renders
// nothing, silently. `tests/test_ui_bundle.py` is what checks the two agree.
import { createRoot } from 'react-dom/client'

import HammerolaEntry from './HammerolaEntry.jsx'
import HammerolaViewer from './HammerolaViewer.jsx'

// Registers `<hmr-viewport>`: `customElements.define` runs at module scope in
// viewport/index.js, so this side-effect import is the registration — do not
// remove it. It is the only path to that module; the tag and event names live
// in `viewport/events.js`, which runs nothing on import. A missing registration
// has no symptom: an unknown tag is an inline box and `whenDefined` never
// settles. Order does not matter: an element defined later is upgraded in place.
import './viewport/index.js'

const build = document.getElementById('hmr_root')
if (build) {
  createRoot(build).render(<HammerolaViewer />)
}

const index = document.getElementById('hmr_index')
if (index) {
  createRoot(index).render(<HammerolaEntry />)
}
