// The scaffolding every widget drawn AS AN OBJECT IN THE SCENE is built out of:
// the group that outlives the scene it stands in, the placement that runs INSIDE
// the library's render pass so the object is where it belongs in the very frame
// that draws it, the scale that makes one unit of its geometry one CSS pixel,
// the press taken off the canvas by raycast, and the teardown that stops all of
// it.
//
// THE TWIN OF layer.js, which does the same job for the widgets drawn OVER the
// canvas out of divs — and it exists because a div is flat. A grip that lies on
// the cut plane is a thing in the world: it foreshortens as the model turns and
// it keeps the plane's own direction without being told what that direction
// looks like on screen. In the DOM the same widget had to re-derive in screen
// space what the projection already knew, and every one of those derivations —
// the projected axis, the foreshortening, the floor under it — was a function
// with a degenerate zone and a fallback for it.
//
// WHY THIS COULD NOT BE WRITTEN BEFORE THE FORK. three is EXTERNAL to the
// library's build now (issue #14) and `viewer/src/index.ts` re-exports its
// namespace, so the page and the library share ONE three and our objects are
// built out of the very classes the scene is made of. Upstream bundles a three
// instance nothing outside it can name, where `new Mesh(...)` would produce an
// object that fails every `instanceof` the renderer makes.
//
// PLACED BY THE RENDER AND NOT BY A LOOP, which is the second thing the fork
// bought and was measured in a browser before it was written. This viewer draws
// ON DEMAND — `Viewer.update()`, called by its state setters and by the
// controls' change listener, with the continuous `animate()` loop off — so a
// widget moved from a `requestAnimationFrame` loop of its own is moved sixty
// times a second beside a renderer that is not drawing: the group stands in the
// scene, correctly positioned and correctly scaled, and NOTHING IS ON SCREEN
// until something else happens to repaint. `onBeforeRender` is hammerola's
// addition to the fork (viewer/src/core/viewer.ts, static/_v/PROVENANCE.md),
// called at the top of `update()`, so a widget is placed for the frame that is
// about to draw it and `refresh` means one thing only: ask for a frame.
//
// LIFECYCLE WITHOUT PATCHING `clear()`. `Viewer.clear()` runs `deepDispose` over
// the whole scene (viewer/src/core/viewer.ts:1219), which would take our
// geometries and materials with the model's. We own the only call site — `show()`
// in element.js — so the group is DETACHED before that `clear()` and re-ATTACHED
// after the `render()` that follows, and it is the same group across every scene
// the reader loads: it is built once, on the first attach it is given a
// namespace with.
//
// NOT CUT AND NOT PICKABLE, both by construction rather than by opting out. The
// library clips PER MATERIAL (`ObjectGroup.setClipPlanes`,
// viewer/src/scene/objectgroup.ts:675) and never through
// `renderer.clippingPlanes`, so a material carrying no planes is never cut by
// the section. The id-picker renders BY CAMERA LAYER and marks what is pickable
// with `layers.enable` (viewer/src/rendering/id-picking.ts:94, 1220), so an
// object left on layer 0 never reaches the pick buffer — the model stays
// pickable straight through a handle standing in front of it.
//
// WHAT IS NOT HERE IS THE GESTURE, exactly as in layer.js: each widget keeps its
// own presses, its own drag state and its own ending, because what a press MEANS
// is the whole of what makes them separate modules. `drag.js` is the other half
// they share, and they share it with the DOM layers too.

import { ndcAt } from "./camera.js";
import { internals } from "./internals.js";

/** Where a handle is drawn relative to the model: after all of it.
 *
 * The library puts its own edges and translucent faces at 999
 * (viewer/src/scene/nestedgroup.ts:523) and its highlight points at 1000; the
 * section contour takes that same 1000 (outline.js, which carries the argument
 * for why a bucket beats the per-object depth sort inside one). A handle is the
 * one thing that must never be hidden by any of them, so it sits one bucket
 * above the highest — and, having no depth test either, it is drawn over the
 * part it is standing on rather than inside it.
 */
export const WIDGET_ORDER = 1001;

/**
 * The material every 3D handle is drawn with: flat ink, never hidden, never cut
 * and never graded.
 *
 * `depthTest: false` is the whole of "a handle is never lost inside the part it
 * belongs to" — the grip sits ON a cut face, i.e. exactly where the depth buffer
 * says the model is, and half of it would otherwise be swallowed by whatever the
 * plane has just opened up.
 *
 * `clippingPlanes: []` is what keeps the section from cutting the widget that
 * MOVES the section. It is an empty list rather than a missing field because the
 * library hands its own materials a real array and a reader comparing the two
 * should see the answer, not its absence.
 *
 * `depthWrite: false` travels with it, which is what both of the library's own
 * always-visible materials do (`viewer/src/scene/clipping.ts:96`,
 * `viewer/src/scene/nestedgroup.ts:970`). A surface that does not consult the
 * depth buffer has no business writing to it: what it would leave there is the
 * handle's own distance stamped over nearer geometry, for whatever is drawn
 * after it to be tested against.
 *
 * `toneMapped: false` for the reason the library's own edge material carries it:
 * this is ink at a colour that was chosen, not a surface being lit, and the
 * renderer's tone mapping would grade it towards something else.
 */
export function widgetMaterial(three, color) {
  return new three.MeshBasicMaterial({
    color, depthTest: false, depthWrite: false, clippingPlanes: [],
    toneMapped: false,
  });
}

/** The one hook of ours on a viewer, tagged so a second widget finds it.
 *
 * ON THE FUNCTION AND NOT IN A REGISTRY HERE: the list of widgets a viewer
 * places belongs to that viewer and dies with it, so there is no module-level
 * map to key, to prune, or to keep clean between two of them.
 */
const FANOUT = Symbol("hammerola.scene3d");

/**
 * The fan-out this viewer's widgets are placed from, installed if it is not
 * there yet.
 *
 * ONE FUNCTION IN A FIELD THAT HOLDS ONE, and several widgets are coming — the
 * move arrows and the rotation rings are objects in this scene next — so what
 * goes into `viewer.onBeforeRender` is a single function that calls each
 * registered widget's `paint`. `scene3d.js` is the only owner of that field
 * anywhere.
 *
 * WHATEVER WAS THERE IS KEPT and put back when the last widget leaves — the
 * literal value rather than a hard null, which is `installPinchGuard`'s
 * arrangement around `viewer.update` and is kept for its reason: nothing in this
 * codebase assigns to this field today, and the restore should still be right on
 * the day something does.
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

/**
 * One widget living in the library's scene: `{refresh, attach, detach, destroy}`.
 *
 * The four callbacks, in the order they are first called:
 *
 *   `build(three, group)` fills the group, ONCE, the first time `attach` is
 *     given the namespace. Everything it puts there is measured in CSS PIXELS,
 *     because of the scale below.
 *   `wanted()` is whether there is anything to draw at all — asked again on
 *     every frame the library draws rather than remembered, so a widget that has
 *     nothing to stand on needs nobody to take it off the screen.
 *   `place(group, g)` puts the group where the widget belongs and returns false
 *     when it cannot. Position and orientation are the widget's; the SCALE is
 *     this module's and is overwritten every frame.
 *   `press(event, g, hit)` is the press the raycast landed on ours, and returns
 *     whether the widget took it. `hit` is the intersection itself, for a widget
 *     whose group holds more than one pressable piece.
 *
 * `place` ANSWERS RATHER THAN HIDING, which is the one place this departs from
 * `createLayer`'s contract: there each layer owns the `display` of its own
 * pieces, here one flag on the shared group decides whether the widget is in the
 * frame at all, and two owners of one flag is a widget that flickers on whichever
 * of them ran last.
 */
export function createScene3D(vp, { wanted, build, place, press, cursor }) {
  // Null until the first `attach` brings the namespace; everything below that
  // needs three checks for the group rather than for the module, because the two
  // arrive together and the group is the one the work is done on.
  let three = null;
  let group = null;
  let raycaster = null;
  let pointer = null;
  // The canvas whose cursor we wrote, so it is handed back exactly once. The DOM
  // layers got this from the browser for nothing: a div with `cursor: grab` on
  // it, hit-tested by the engine. A widget in the scene is not an element, so
  // the hover has to be raycast and the canvas written to by hand.
  let painted = null;
  // Which cursor is on it, so a change of LOOK on the same node is not read as
  // "nothing changed" -- `grab` and `grabbing` are two answers about one canvas.
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
   * The camera is ORTHOGRAPHIC by construction (`displayOptions` in options.js,
   * and `gestureInternals` refuses anything else), so one number covers the whole
   * frame: the frustum's height in world units, divided by the zoom the reader
   * has dialled in, over the canvas's height in pixels. A perspective camera
   * would need the depth of the widget as well, and there is no perspective
   * camera here to measure one against — hence null and an undrawn widget rather
   * than a guess that would be wrong by however far the handle is from the eye.
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
    // UNIFORM, and written after `place` rather than instead of anything it
    // does: position and orientation compose with a uniform scale in any order,
    // so the widget's two fields and this one never have to know about each
    // other.
    group.scale.setScalar(k);
    group.visible = true;
  }

  /** The topmost thing of ours under the pointer, or null.
   *
   * `group.visible` IS PART OF THE QUESTION. three's raycaster does not consult
   * it — `intersect()` tests the object's LAYERS and nothing else — so without
   * this line a widget the last frame took off the screen would go on answering
   * presses at wherever it was last placed.
   *
   * `updateMatrixWorld` because a press does not know which frame it is standing
   * on. The renderer composes this group on its way out of every frame that
   * placed it, so after a render the matrix is already right — but a group that
   * has just joined a scene nothing has drawn yet has no world matrix at all,
   * and the ray would be cast against the origin. One matrix compose per press
   * is cheaper than having to know which of the two it is.
   */
  function hit(g, event) {
    if (!group || !group.visible || !raycaster) return null;
    const ndc = ndcAt(g.canvas, event);
    if (!ndc) return null;
    pointer.set(ndc[0], ndc[1]);
    raycaster.setFromCamera(pointer, g.cam);
    group.updateMatrixWorld(true);
    const hits = raycaster.intersectObject(group, true);
    return hits.length ? hits[0] : null;
  }

  /** Wear a cursor on `canvas`, or take ours off wherever it was.
   *
   * `held` is the drag's own: while one runs the canvas wears `grabbing` and
   * stops asking the ray anything, because the hand carries the pointer OFF the
   * widget almost immediately -- a section drag moves along the axis and the
   * across-axis part of the hand's travel takes the cursor clean off the target
   * cylinder. Recomputed per move, the cursor would go back to the default in
   * the middle of a gesture that is still running, which is the one thing a
   * cursor is there to deny.
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
   * ON THE WINDOW AND IN THE CAPTURE PHASE, which is `rings.js`'s arrangement and
   * is now forced rather than chosen: there is no element to hang a listener on
   * at all. What it buys is that a press that MISSES is left completely alone —
   * it goes on to the tools' own listener and to the trackball behind it, so the
   * reader can still orbit, pick and open the part menu with a cut standing.
   *
   * THE CANVAS AND NOTHING ELSE, the same guard tools.js's `onDown` opens with:
   * on a window listener it is what keeps a press on the tree, on a button or on
   * one of the layers stacked over the canvas from being read as a press on the
   * model.
   *
   * The refusals go out only when the WIDGET has taken the press, not merely
   * when the ray hit it: which buttons a widget answers to is its own business,
   * and a press it does not want is a press it has no business taking away from
   * anybody else.
   *
   * IMMEDIATE, AND THAT WORD IS WHAT KEEPS TWO WIDGETS IN ONE SCENE APART.
   * Every widget built here puts its `onDown` on this same node in this same
   * phase, and `rings.js` puts a `handOver` of its own beside them;
   * `stopPropagation` does not reach a second listener on the SAME node — it
   * only stops the event travelling onward — so without the immediate form one
   * press would be taken by the grip AND start a rotation, which is not a
   * gesture anybody asked for. Which of the two keeps it is decided by ORDER,
   * since "immediate" silences only what was registered LATER: the guarantee is
   * really "the grip is built before the rings" in `element.js`. That is a fact
   * about that file and not about either widget, which is why it is pinned on
   * the source rather than here — see `tests/test_ui_source.py`. A listener
   * carries nothing that says whose it is.
   */
  function onDown(event) {
    const g = wanted() ? internals(vp.viewer) : null;
    if (!g || event.target !== g.canvas) return;
    const at = hit(g, event);
    if (!at) return;
    if (!press(event, g, at)) return;
    // ONE CALL AND NOT TWO: `stopImmediatePropagation` sets the propagation flag
    // as well (DOM, "stop immediate propagation flag"), so a `stopPropagation`
    // beside it is a line that cannot change anything. The tests below therefore
    // ask whether the neighbour RAN, not which method was called.
    event.stopImmediatePropagation();
    event.preventDefault();
  }

  /** Where the cursor is standing, for the cursor alone. */
  function onMove(event) {
    if (held) return;
    const g = wanted() ? internals(vp.viewer) : null;
    const at = g && event.target === g.canvas ? hit(g, event) : null;
    wear(at ? g.canvas : null);
  }

  /**
   * Ask the library to draw, which is the only way anything of ours reaches the
   * screen.
   *
   * `viewer.update(true, false)` is the call the rest of this codebase makes
   * (`parts.js`): the orientation marker keeps up, and nothing is notified,
   * because no state the interface holds has changed.
   *
   * ONLY FOR A CHANGE THE LIBRARY DID NOT MAKE ITSELF, which in practice is the
   * cut appearing or going away. A camera move, the plane sliding under a drag,
   * a part moving — each of those already ends in a render of the library's own,
   * and the hook places the widget in that same frame.
   */
  function refresh() {
    // THE CONTRACT ABOVE, ENFORCED HERE AND NOT IN THE CALLER. `reconcile` in
    // element.js runs on every `hmr:state`, which arrives on every click in the
    // tree, and it cannot know whether this widget cares. A render costs the
    // whole scene plus the orientation marker and the grid, so the question is
    // asked here: a frame is worth it only when there is something to draw, or
    // something still drawn that has to come off.
    if (!wanted() && !(group && group.visible)) return;
    const viewer = vp.viewer;
    if (viewer) viewer.update(true, false);
  }

  addEventListener("pointerdown", onDown, true);
  addEventListener("pointermove", onMove, true);

  return {
    refresh,

    /**
     * Say a gesture of this widget's has started or ended.
     *
     * THE CURSOR IS THE WHOLE OF IT: `onMove` recomputes from the ray, and the
     * hand leaves the widget almost at once, so without this the cursor reverts
     * mid-drag. The widget owns the call because only it knows what ends its
     * gesture -- a release, a cancel, a second press, or the scene being swapped
     * out from under a hand that never came off.
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
     * `three` is the namespace `show()` took off the library it had just loaded
     * — and `undefined` from a loader that answered without one, which is a
     * page with no widgets rather than an error: the reader is looking at a
     * viewer that came from somewhere this code does not recognise, and it
     * still renders their model.
     */
    attach(namespace) {
      if (!three) three = namespace;
      if (!three) return;
      if (!group) {
        group = new three.Group();
        group.renderOrder = WIDGET_ORDER;
        // Until the first frame has placed it. A group built at the origin and
        // visible would be one frame of a handle standing in the middle of the
        // model.
        group.visible = false;
        raycaster = new three.Raycaster();
        pointer = new three.Vector2();
        build(three, group);
      }
      const g = internals(vp.viewer);
      const scene = g && g.scene;
      if (!scene || typeof scene.add !== "function") return;
      if (group.parent !== scene) scene.add(group);
      // FROM HERE ON THE LIBRARY PLACES IT, once per frame it draws.
      join(vp.viewer);
      // And the frame that built this scene has already been drawn, so the one
      // on screen has no group of ours in it. What this asks for is the frame
      // that reconciles that — in practice, TAKING OFF a group that was left
      // visible by the scene before, since `show()` clears the seed before the
      // swap and whatever puts the widget back afterwards ends in a render of
      // its own (`standSection` in section.js). The guard in `refresh` decides
      // which of the two it is, and on a viewport that never had a cut it is
      // neither and no frame is asked for.
      refresh();
    },

    /** Take the group out of the scene before something disposes it.
     *
     * THE FAN-OUT IS NOT LEFT HERE, because being placed is the widget's
     * lifetime and not the scene's: the caller is mid-swap — `clear()`,
     * `render()` and `attach` again, in one synchronous block — and the most a
     * `place` landing in between can do is write a transform onto a group
     * nothing is drawing. Leaving is the teardown's job, where the widget really
     * is going away.
     */
    detach() {
      if (group && group.parent) group.parent.remove(group);
    },

    destroy() {
      leave();
      removeEventListener("pointerdown", onDown, true);
      removeEventListener("pointermove", onMove, true);
      wear(null);
      if (group && group.parent) group.parent.remove(group);
      // OURS TO DISPOSE, and the only geometry in this tree that is. The scene's
      // own is the library's and goes on `clear()`; this group is the one thing
      // that survives those, so nothing else will ever free it.
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
