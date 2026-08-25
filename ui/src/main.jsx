// Entry point of the hub's browser UI.
//
// Mounting is conditional on purpose. Only templates/build.html carries the
// mount point, but a bundle is a bundle: the day another page loads it -- the
// project list, the pointer page -- a hard `createRoot(null)` would turn into a
// console error on a page that has nothing wrong with it. Absence of #hmr_root
// means "not this page", not "something broke".
import { createRoot } from 'react-dom/client'

import HammerolaViewer from './HammerolaViewer.jsx'

const mount = document.getElementById('hmr_root')
if (mount) {
  createRoot(mount).render(<HammerolaViewer />)
}
