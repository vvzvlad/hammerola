// TEMPORARY placeholder. The port of the designer's mock-up replaces this file
// wholesale; nothing here is meant to survive that.
//
// It exists so the pipeline it travels through is observable end to end. Find
// the element in DevTools — `document.querySelector('.hmr_stub')` in the
// console — and its presence proves the bundle compiled, that it reached
// static/_v/ (or the image, when the page is served from a container), that the
// browser fetched and parsed it, that React loaded and that a component
// mounted. Rendering React.version rather than a bare string is what makes the
// last two of those separable from "some JavaScript ran".
//
// `hidden` rather than visible, because the two clocks here do not line up. The
// placeholder lives until the mock-up is ported, which is a piece of work; a
// merge to main publishes `:latest` within one CI run, and the
// io.portainer.update.enable label rolls that out with nobody deciding to. A
// visible debug line would therefore appear under the viewer on every build
// page in production as a side effect of merging, and the check above costs
// nothing by being hidden — DevTools shows the element either way.
import React from 'react'

export default function HammerolaViewer() {
  return <div className="hmr_stub" hidden>hammerola ui &mdash; React {React.version}</div>
}
