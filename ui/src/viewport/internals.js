// ONE guarded door into the library's internals.
//
// Everything reached through `viewer.clipping`, `viewer.idPicker`,
// `viewer.controls` and `camera.getCamera()` is the library's own plumbing
// rather than its public API. It is all funnelled through this one function for
// a single reason: THIS IS THE FIRST PLACE A three-cad-viewer UPGRADE WILL
// BREAK. When a piece goes missing the tools go quiet — a button stops doing
// anything, the wheel goes back to the library's own zoom — instead of throwing
// into a page that has already painted.
//
// The door is deliberately WIDER than any single caller needs: the cursor zoom
// does not use the clip plane, but it asks the same question anyway. One guarded
// door is worth more than a second, differently-wrong copy of it.

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
    // `distanceToPoint` is the one thing the clip-value maths leans on, so a
    // plane that no longer has it counts as a missing plane.
    if (!plane || typeof plane.distanceToPoint !== "function") return null;
    if (typeof camera.getPosition !== "function") return null;
    return {
      camera, cam, plane, canvas, picker, clipping,
      controls: viewer.controls,
      display: viewer.display,
      nestedGroup: viewer.nestedGroup,
      // Where the widgets in scene3d.js stand. Read THROUGH THIS DOOR and not off
      // the viewer, because the getter THROWS before a render and after a
      // `clear()` — `viewer.scene` is `this.rendered.scene`, and `rendered`
      // refuses when there is none. The `viewer.ready` check above is what makes
      // this line safe, and the `try` around it is what makes it safe anyway.
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
 * same three — is the library still where we left it, did this land on the
 * CANVAS (the interface's own chrome bubbles through the same container and the
 * controls ignore those), and is the camera orthographic.
 *
 * Perspective would need the depth of the point under the cursor, i.e. the
 * picker, and a whole second code path for a cursor over the background. The
 * viewport is ortho by construction (options.js), so that path would be dead
 * code; a viewer that is somehow not ortho keeps the library's own centre zoom
 * and gets no swipe pan and no cursor pivot.
 */
export function gestureInternals(viewer, event) {
  const g = internals(viewer);
  if (!g) return null;
  if (event.target !== g.canvas) return null;
  if (!g.cam.isOrthographicCamera) return null;
  if (typeof viewer.getCameraZoom !== "function") return null;
  if (typeof viewer.getCameraTarget !== "function") return null;
  if (typeof viewer.setCameraLocationSettings !== "function") return null;
  return g;
}
