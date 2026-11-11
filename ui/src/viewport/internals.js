// One guarded door into the library's internals.
//
// Everything reached through `viewer.clipping`, `viewer.idPicker`,
// `viewer.controls` and `camera.getCamera()` is the library's plumbing rather
// than its public API, and the first thing a three-cad-viewer upgrade will
// break. When a piece goes missing the tools go quiet (a button stops working,
// the wheel falls back to the library's zoom) instead of throwing into a page
// that has already painted.
//
// The door is wider than any single caller needs (the cursor zoom does not use
// the clip plane but asks anyway), so there is only one copy of the check.

import { SECTION_INDEX } from "./options.js";

/**
 * The library internals every tool here needs, or null if any of them moved.
 *
 * `clipping`, `controls`, `display`, `nestedGroup` and `scene` ride along
 * UNGUARDED, on purpose: a missing `setVisible` should cost the cut its stencil
 * caps on other tabs, not stop a face from being pickable, and a controls object
 * that has moved should cost the page its pivot and nothing else. Each of those
 * call sites checks what it uses itself.
 */
export function internals(viewer) {
  try {
    if (!viewer || !viewer.ready) return null;
    const camera = viewer.camera;
    const cam = camera && camera.getCamera();
    const clipping = viewer.clipping;
    const plane = clipping && clipping.clipPlanes
      && clipping.clipPlanes[SECTION_INDEX];
    const canvas = viewer.renderer && viewer.renderer.domElement;
    const picker = viewer.idPicker;
    if (!cam || !canvas || !picker) return null;
    // `distanceToPoint` is what the clip-value maths relies on, so a plane
    // without it counts as missing.
    if (!plane || typeof plane.distanceToPoint !== "function") return null;
    if (typeof camera.getPosition !== "function") return null;
    return {
      camera, cam, plane, canvas, picker, clipping,
      controls: viewer.controls,
      display: viewer.display,
      nestedGroup: viewer.nestedGroup,
      // Where the widgets in scene3d.js stand. Read here, not off the viewer:
      // `viewer.scene` is `this.rendered.scene` and throws before a render and
      // after `clear()`. The `viewer.ready` check and the `try` keep it safe.
      scene: viewer.scene,
    };
  } catch (error) {
    console.warn("viewport internals", error);
    return null;
  }
}

/**
 * The preconditions every gesture that moves the camera BY HAND shares, or null.
 *
 * Both wheel gestures ask it and so does the press that anchors the cursor
 * pivot: the event is a `wheel` or a `pointerdown` and the questions are the
 * same two — is the library still where we left it, and did this land on the
 * CANVAS (the interface's own chrome bubbles through the same container and the
 * controls ignore those). Either camera is served: the maths in camera.js
 * answers for both.
 */
export function gestureInternals(viewer, event) {
  const g = internals(viewer);
  if (!g) return null;
  if (event.target !== g.canvas) return null;
  if (typeof viewer.getCameraZoom !== "function") return null;
  if (typeof viewer.getCameraTarget !== "function") return null;
  if (typeof viewer.setCameraLocationSettings !== "function") return null;
  return g;
}
