// Scaffolding for widgets drawn as objects in the scene: a group that outlives
// the scene it stands in, placement inside the library's render pass (so the
// object is right in the frame that draws it), a scale making one geometry unit
// one CSS pixel, presses taken off the canvas by raycast, and teardown.
//
// The counterpart of layer.js (divs over the canvas). An object in the world
// foreshortens with the model and keeps the plane's direction by itself; a flat
// widget has to re-derive all of that in screen space, with degenerate zones.
//
// This relies on the fork: three is external to the library's build and
// `viewer/src/index.ts` re-exports its namespace, so page and library share one
// three and our objects pass the renderer's `instanceof` checks.
//
// Placed by the render, not a loop. The viewer draws on demand
// (`Viewer.update()`, from state setters and the controls' change listener;
// `animate()` is off), so a widget moved from its own rAF loop would not appear
// until something else repainted. `onBeforeRender` is hammerola's addition to
// the fork (viewer/src/core/viewer.ts, static/_v/PROVENANCE.md), called at the
// top of `update()`, so a widget is placed for the frame about to be drawn and
// `refresh` only asks for a frame.
//
// Lifecycle without patching `clear()`: `Viewer.clear()` runs `deepDispose`
// over the scene (viewer/src/core/viewer.ts:1219), which would take our
// geometries too. `show()` in element.js, the only call site, detaches the group
// before `clear()` and re-attaches it after `render()`; the same group, built
// on the first attach that brings the namespace, serves every scene.
//
// Not cut and not pickable, by construction. The library clips per material
// (`ObjectGroup.setClipPlanes`, viewer/src/scene/objectgroup.ts:675), never via
// `renderer.clippingPlanes`, so a material with no planes is never cut. The
// id-picker renders by camera layer (`layers.enable`,
// viewer/src/rendering/id-picking.ts:94, 1220), so objects on layer 0 never
// reach the pick buffer and the model stays pickable through a handle.
//
// The gesture is not here (as in layer.js): each widget keeps its own presses,
// drag state and ending; `drag.js` is the shared half.

import { ndcAt } from "./camera.js";
import { internals } from "./internals.js";

/** Where each widget is drawn relative to the model and to each other: after
 *  all of the model, bottom to top rings, grip, manipulator.
 *
 * Above the library's own: its edges and translucent faces are at 999
 * (viewer/src/scene/nestedgroup.ts:523), its highlight points and the section
 * contour (outline.js) at 1000. A handle must never be hidden by any of them,
 * and with no depth test it is drawn over the part it stands on.
 *
 * Three bands because the band is also the press order: `joinPresses` gives a
 * contested press to the highest band that takes it, so the widget on top is
 * the one that answers.
 *
 * Each widget's own ladder still works inside its band: three carries a group's
 * `renderOrder` down as `groupOrder` and sorts on it before each mesh's own, so
 * the bands need only be distinct; the tens are for readability.
 */
export const RINGS_ORDER = 1001;
export const HANDLE_ORDER = 1011;
export const GIZMO_ORDER = 1021;

/**
 * The material every 3D handle is drawn with: flat ink, never hidden, never
 * cut, never graded and always blended.
 *
 * `transparent: true` on every piece, opaque ones included: three sorts objects
 * into opaque or transparent lists by this flag alone and draws opaque first
 * (`static/_v/three.module.js`); `groupOrder` and `renderOrder` order only
 * within a list. One blended piece (the rings' feathered arc) would otherwise
 * lift its whole widget over every opaque one regardless of band. Alpha is 1
 * everywhere but that arc.
 *
 * `depthTest: false`: the grip sits on a cut face, exactly where the depth
 * buffer says the model is, and would otherwise be half swallowed.
 *
 * `clippingPlanes: []` keeps the section from cutting the widget that moves the
 * section; an empty array, matching the library's own materials.
 *
 * `depthWrite: false`, as in the library's always-visible materials
 * (`viewer/src/scene/clipping.ts:96`, `viewer/src/scene/nestedgroup.ts:970`):
 * a surface that ignores depth must not stamp its distance over nearer
 * geometry.
 *
 * `toneMapped: false`, as on the library's edge material: this is chosen ink,
 * not a lit surface.
 */
export function widgetMaterial(three, color) {
  return new three.MeshBasicMaterial({
    color, transparent: true, depthTest: false, depthWrite: false,
    clippingPlanes: [], toneMapped: false,
  });
}

/** The one hook of ours on a viewer, tagged so a second widget finds it. On the
 *  function, not in a module registry, so it dies with its viewer.
 */
const FANOUT = Symbol("hammerola.scene3d");

/**
 * The fan-out this viewer's widgets are placed from, installed if it is not
 * there yet.
 *
 * `viewer.onBeforeRender` holds one function, so it gets a single hook that
 * calls each registered widget's `paint`. This module is the only owner of
 * that field.
 *
 * Whatever was there is kept and restored when the last widget leaves (as
 * `installPinchGuard` does around `viewer.update`); nothing assigns to it
 * today.
 */
function fanoutOn(viewer) {
  const held = viewer.onBeforeRender;
  if (held && held[FANOUT]) return held[FANOUT];
  const widgets = new Set();
  const hook = () => {
    for (const paint of widgets) paint();
  };
  hook[FANOUT] = { widgets, previous: held || null };
  viewer.onBeforeRender = hook;
  return hook[FANOUT];
}

/** The viewport's one press listener, tagged on it so a second widget finds it. */
const PRESSES = Symbol("hammerola.presses");

/**
 * Put `take(event)` among the viewport's presses at paint band `order`, and
 * return the call that takes it back out.
 *
 * One window listener for every widget, because between listeners on one node
 * only registration order decides, which no widget controls. Here the highest
 * band is asked first, ties in join order, and the first `take` returning true
 * keeps the press, so what answers is what is drawn on top.
 *
 * On `vp` and lazy (like `fanoutOn`): the list dies with the viewport, and the
 * listener is on the window only while it has members.
 */
export function joinPresses(vp, order, take) {
  if (!vp[PRESSES]) {
    const members = new Set();
    const onDown = (event) => {
      // `sort` is stable, which is the whole of the tie-break.
      const ranked = [...members].sort((a, b) => b.order - a.order);
      for (const member of ranked) {
        if (!member.take(event)) continue;
        // One call: `stopImmediatePropagation` also sets the propagation flag,
        // so `stopPropagation` would change nothing. Tests check whether the
        // neighbour ran.
        event.stopImmediatePropagation();
        event.preventDefault();
        return;
      }
    };
    vp[PRESSES] = { members, onDown };
    addEventListener("pointerdown", onDown, true);
  }
  const { members, onDown } = vp[PRESSES];
  const member = { order, take };
  members.add(member);
  return () => {
    if (!members.delete(member) || members.size) return;
    removeEventListener("pointerdown", onDown, true);
    delete vp[PRESSES];
  };
}

/**
 * One widget living in the library's scene: `{refresh, attach, detach, destroy}`.
 *
 * The callbacks, in the order they are first called:
 *
 *   `build(three, group)` fills the group once, on the first `attach` that has
 *     the namespace. Everything in it is measured in CSS pixels (see the scale).
 *   `wanted()` is whether there is anything to draw, asked on every frame, so
 *     a widget with nothing to stand on disappears by itself.
 *   `place(group, g)` positions and orients the group and returns false when it
 *     cannot. The scale is this module's and is overwritten every frame.
 *   `press(event, g, hit)` handles a press the raycast found on ours and
 *     returns whether the widget took it; `hit` is the intersection.
 *
 * `rank(object)` (optional) picks which intersection `hit` is when the ray
 * crosses several targets: lowest rank wins, ties to the nearest; without it,
 * the nearest. Nothing here has a depth test, so what is on top is decided by
 * `renderOrder`, which the ray knows nothing about (see `RANK` in gizmo.js).
 *
 * `handOver(event)` (optional) is called on every press the higher bands left,
 * before `wanted` and the ray, for a widget with gestures to end even on a miss
 * (`rings.js`).
 *
 * `order` is the caller's band from those above, and its place in
 * `joinPresses`.
 *
 * `place` answers rather than hiding (unlike `createLayer`, where each layer
 * owns its pieces' `display`): one flag on the shared group decides whether the
 * widget is in the frame, and two owners of it would flicker.
 */
export function createScene3D(vp,
                              { wanted, build, place, press, handOver, rank,
                                cursor, order }) {
  // Null until the first `attach` brings the namespace; the group and the
  // module arrive together, so code checks the group.
  let three = null;
  let group = null;
  let raycaster = null;
  let pointer = null;
  // The canvas whose cursor we wrote, so it is handed back exactly once. A
  // widget in the scene is not an element, so hover is raycast and the cursor
  // written by hand.
  let painted = null;
  // Which cursor is on it, so `grab` -> `grabbing` on the same canvas counts
  // as a change.
  let worn = null;
  // Whether a gesture of this widget's is running. Set by `grabbed`, which the
  // widget calls because only the widget knows when its own drag has ended.
  let held = false;
  // The viewer whose fan-out holds our `paint`, so the one it is taken off is
  // the one it went into. Null while this widget is placed by nobody.
  let joined = null;

  /** Be placed by every frame this viewer draws from here on. */
  function join(viewer) {
    if (joined === viewer) return;
    leave();
    if (!viewer) return;
    fanoutOn(viewer).widgets.add(paint);
    joined = viewer;
  }

  /** Stop being placed, and hand the field back when the last widget goes. */
  function leave() {
    const viewer = joined;
    joined = null;
    const hook = viewer && viewer.onBeforeRender;
    // A hook that is not ours is somebody who assigned over us: the field is
    // theirs now, and taking it back would break them rather than tidy up.
    const fanout = hook && hook[FANOUT];
    if (!fanout) return;
    fanout.widgets.delete(paint);
    if (fanout.widgets.size === 0) viewer.onBeforeRender = fanout.previous;
  }

  /** World units per CSS pixel, or null for a camera this cannot answer for.
   *
   * The camera is orthographic (`displayOptions` in options.js;
   * `gestureInternals` refuses anything else), so one number covers the frame:
   * frustum height over zoom over canvas height in pixels. A perspective camera
   * would need the widget's depth too, so it gets null and no widget.
   */
  function pixelScale(g) {
    if (!g.cam.isOrthographicCamera) return null;
    const rect = g.canvas.getBoundingClientRect();
    if (!(rect.height > 0)) return null;
    const k = (g.cam.top - g.cam.bottom) / g.cam.zoom / rect.height;
    return Number.isFinite(k) && k > 0 ? k : null;
  }

  function paint() {
    if (!group) return;
    const g = wanted() ? internals(vp.viewer) : null;
    const k = g ? pixelScale(g) : null;
    if (k === null || !place(group, g)) {
      group.visible = false;
      return;
    }
    // Uniform, written after `place`: position and orientation compose with a
    // uniform scale in any order.
    group.scale.setScalar(k);
    group.visible = true;
  }

  /** The topmost thing of ours under the pointer, or null.
   *
   * `group.visible` is checked because three's raycaster tests layers only, so
   * a widget the last frame removed would keep answering presses.
   *
   * `updateMatrixWorld` because a press does not know which frame it is on: a
   * group just added to a scene nothing has drawn yet has no world matrix, and
   * one compose per press is cheaper than tracking which case it is.
   */
  function hit(g, event) {
    if (!group || !group.visible || !raycaster) return null;
    const ndc = ndcAt(g.canvas, event);
    if (!ndc) return null;
    pointer.set(ndc[0], ndc[1]);
    raycaster.setFromCamera(pointer, g.cam);
    group.updateMatrixWorld(true);
    const hits = raycaster.intersectObject(group, true);
    if (!hits.length) return null;
    if (!rank) return hits[0];
    // Lowest rank, ties by distance: three returns hits in distance order, so
    // keeping the first minimum is the tie-break.
    let best = hits[0];
    let mark = rank(best.object);
    for (const found of hits) {
      const value = rank(found.object);
      if (value < mark) {
        best = found;
        mark = value;
      }
    }
    return best;
  }

  /** Wear a cursor on `canvas`, or take ours off wherever it was.
   *
   * While a drag runs (`held`) the canvas shows `grabbing` and the ray is not
   * asked, because the hand carries the pointer off the widget almost at once
   * (a section drag moves along the axis, and the sideways part of the travel
   * leaves the target cylinder).
   */
  function wear(canvas, look = cursor) {
    if (painted === canvas && worn === look) return;
    if (painted && painted !== canvas) painted.style.cursor = "";
    painted = canvas;
    worn = canvas ? look : null;
    if (canvas) canvas.style.cursor = look;
  }

  /**
   * A press on the canvas, taken only if the ray landed on the widget.
   *
   * On the window in the capture phase, since there is no element to listen on.
   * A press that misses is left alone and goes on to the tools' listener and the
   * trackball, so orbiting, picking and the part menu work with a cut standing.
   *
   * The canvas only (as tools.js's `onDown`): a press on the tree, a button or a
   * layer over the canvas is not a press on the model.
   *
   * Returning true is the whole answer; `joinPresses` makes the refusals, and
   * only when the widget took the press (which buttons it answers is its own
   * business). The press goes to the highest band that answers true, so it
   * cannot both move the grip and start a rotation.
   */
  function onDown(event) {
    if (handOver) handOver(event);
    const g = wanted() ? internals(vp.viewer) : null;
    if (!g || event.target !== g.canvas) return false;
    const at = hit(g, event);
    if (!at) return false;
    return press(event, g, at);
  }

  /** Where the cursor is standing, for the cursor alone. */
  function onMove(event) {
    if (held) return;
    const g = wanted() ? internals(vp.viewer) : null;
    const at = g && event.target === g.canvas ? hit(g, event) : null;
    wear(at ? g.canvas : null);
  }

  /**
   * Ask the library to draw, the only way anything of ours reaches the screen.
   *
   * `viewer.update(true, false)`, as in `parts.js`: the orientation marker keeps
   * up and nothing is notified, since no interface state changed.
   *
   * Only for a change the library did not make itself (in practice, the cut
   * appearing or going). Camera moves, plane drags and part moves already end in
   * a library render, and the hook places the widget in that frame.
   */
  function refresh() {
    // Enforced here, not by callers: `reconcile` in element.js runs on every
    // `hmr:state` (every tree click) and cannot know whether this widget cares.
    // A render costs the whole scene, so a frame is asked only when there is
    // something to draw or something drawn to take off.
    if (!wanted() && !(group && group.visible)) return;
    const viewer = vp.viewer;
    if (viewer) viewer.update(true, false);
  }

  const leavePresses = joinPresses(vp, order, onDown);
  addEventListener("pointermove", onMove, true);

  return {
    refresh,

    /**
     * Say a gesture of this widget's has started or ended. Only the cursor
     * depends on it (`onMove` would revert it mid-drag), and only the widget
     * knows what ends its gesture: release, cancel, a second press, or a scene
     * swap under a held hand.
     */
    grabbed(flag) {
      held = !!flag;
      if (!held) return;
      const g = internals(vp.viewer);
      if (g && g.canvas) wear(g.canvas, "grabbing");
    },

    /**
     * Put the group into the scene that is on screen now, building it first.
     *
     * `three` is the namespace `show()` took off the loaded library; a loader
     * that answered without one gives a page with no widgets, not an error.
     */
    attach(namespace) {
      if (!three) three = namespace;
      if (!three) return;
      if (!group) {
        group = new three.Group();
        group.renderOrder = order;
        // Hidden until the first frame places it, so it never shows at the
        // origin.
        group.visible = false;
        raycaster = new three.Raycaster();
        pointer = new three.Vector2();
        build(three, group);
      }
      const g = internals(vp.viewer);
      const scene = g && g.scene;
      if (!scene || typeof scene.add !== "function") return;
      if (group.parent !== scene) scene.add(group);
      // From here on the library places it, once per frame.
      join(vp.viewer);
      // The frame that built this scene is already drawn without our group, so
      // ask for one more. In practice it removes a group left visible by the
      // previous scene (`show()` clears the seed before the swap, and whatever
      // restores the widget renders by itself, e.g. `standSection` in
      // section.js). The guard in `refresh` decides; with no cut, no frame.
      refresh();
    },

    /** Take the group out of the scene before something disposes it.
     *
     * The fan-out is not left here: the caller is mid-swap (`clear()`,
     * `render()`, `attach` in one synchronous block), and a `place` in between
     * only writes a transform onto an undrawn group. Leaving is `destroy`'s job.
     */
    detach() {
      if (group && group.parent) group.parent.remove(group);
    },

    destroy() {
      leave();
      leavePresses();
      removeEventListener("pointermove", onMove, true);
      wear(null);
      if (group && group.parent) group.parent.remove(group);
      // Ours to dispose: the scene's geometry goes with `clear()`, but this
      // group survives those, so nothing else frees it.
      if (group) {
        group.traverse((object) => {
          if (object.geometry) object.geometry.dispose();
          if (object.material) object.material.dispose();
        });
      }
      group = null;
      raycaster = null;
      pointer = null;
    },
  };
}
