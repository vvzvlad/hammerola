// What a press on the canvas means, which depends on the tool in force:
// `vp.activeTool`, the tool the interface armed, or the cut while the hold key
// is down.
//
// One capture-phase listener decides. A tool that owns the press takes it from
// the trackball in the capture phase, before the canvas's handler runs, or the
// model would rotate under the gesture. With no tool armed nothing is taken:
// the press is watched so a release without movement can be reported as a pick,
// and rotation stays the library's.
//
// `wheel` is left alone in every mode, so zoom works while a tool is up.
//
// The right button is a second gesture on the same listener and takes nothing
// from the library, which pans on it (wheel.js). Travel decides at release:
// under CLICK_PX it was a click and the part menu opens; otherwise the reader
// was panning.

import {
  EVENT_FACE, EVENT_MEASURE, EVENT_MENU, EVENT_PICK, EVENT_PLACE, emit,
} from "./events.js";
import { cameraBasis, canvasXY, ndcAt } from "./camera.js";
import { travelled, watchDrag } from "./drag.js";
import { internals } from "./internals.js";
import { dot3 } from "./math.js";
import { measureDistance, measureEntity } from "./measure.js";
import { capOwnerAt, faceNormalAt, pickEntity } from "./picking.js";
import {
  dragSection, keepSectionCut, placeSectionPlane, sectionAxis,
  sectionOffset, sectionRange,
} from "./section.js";
import { tidy } from "../proposal.js";

/**
 * A rounding step for a dragged part: a 1-2-5 decade near a two-hundredth of the
 * grid, so a 90 mm assembly snaps to half a millimetre and a 2 mm one does not
 * become undraggable.
 *
 * A move reaches the agent as a sentence ("about three millimetres that way"),
 * and 2.8371 mm claims a precision the gesture does not have.
 *
 * Exported for gizmo.js (axis arrows and plane quads), so every gesture on a
 * part rounds the same way.
 */
export function niceStep(viewer) {
  const grid = viewer && viewer.gridSize;
  const raw = Number.isFinite(grid) && grid > 0 ? grid / 200 : 0.5;
  const decade = 10 ** Math.floor(Math.log10(raw));
  const mult = raw / decade;
  return (mult >= 5 ? 5 : mult >= 2 ? 2 : 1) * decade;
}

/** The snapped value, and the same number the document will carry.
 *
 * In binary arithmetic six steps of 0.1 are `0.6000000000000001`, and the value
 * goes into `vp.moved`, onto the event and into the proposal document.
 * `reconcileMoves` compares the document's offset with the map's element by
 * element, so rounding anywhere else would make every push re-apply a move
 * that is already standing. Rounding at the source keeps all three one number.
 *
 * `tidy` is the document's own rule, imported rather than copied. `proposal.js`
 * imports only `viewport/math.js`, a leaf, so nothing of the viewer comes with
 * it (importing from `parts.js` instead made `proposal.js` throw
 * `location is not defined` outside a browser); `tests/test_ui_source.py` pins
 * the leaf.
 *
 * Exported for the same reason as `niceStep`.
 */
export const snap = (v, step) => tidy(Math.round(v / step) * step);

/** Where the section plane ended up, announced once.
 *
 * The drag moved the library's slider, whose zero is the grid centre; the
 * interface shows the depth from the face, so it is read back and announced at
 * the end of the gesture. This is the only writer of `state.cutOffset`, so the
 * number on screen and the one the next `applySection` uses cannot diverge.
 *
 * Read against the scene still on screen, which makes it safe from
 * `endGesture`: `show()` ends the gesture before it captures or clears
 * anything.
 *
 * Module-level and exported because two gestures end a section drag: the press
 * on the canvas below and the press on the handle (handle.js).
 */
export function reportCut(vp) {
  if (!vp.sectionSeed) return;
  vp.state.cutOffset = sectionOffset(vp);
  emit(vp, EVENT_FACE, {
    id: vp.sectionSeed.id || null,
    name: vp.sectionSeed.name || null,
    // Whether the plane still lies on the face it was placed from: the id and
    // name keep naming that face after the grip's rings tip the plane off it
    // (handle.js), and the panel heads the cut with that name.
    turned: !!vp.sectionSeed.turned,
    point: vp.sectionSeed.point,
    normal: vp.sectionSeed.normal,
    offset: vp.state.cutOffset,
    range: sectionRange(vp.viewer),
  });
}

export function installTools(vp) {
  let press = null;

  /** Follow this press to wherever it is released — `watch.arm()` at the press
   *  and `watch.disarm()` in `finish`, on the window and in the capture phase
   *  for the reason `drag.js` writes out. */
  const watch = watchDrag({ onMove, onUp, onCancel });

  const finish = () => {
    press = null;
    watch.disarm();
  };

  /** The end of the one gesture this file can be holding, a section plane drag,
   * for the two endings that say where it ended: the release (`onUp`) and the
   * scene swapped under a held hand (`endGesture`).
   *
   * The other endings say nothing: the platform taking the pointer
   * (`onCancel`), a second press during a live one (`onDown`) and the teardown
   * call a bare `finish()`. `reportCut` is not a bare readback: the interface
   * answers `hmr:face` by disarming the armed tool, so reporting an interrupted
   * drag would turn the cut tool off. The cost is that the interface may show a
   * stale depth beside a correctly standing plane.
   *
   * Called after `finish()`: `reportCut` can reach back into the element, and a
   * report that re-stages runs `endGesture` again, which finds `press` cleared.
   */
  const conclude = (p) => {
    if (p && p.moved && p.tool === "cut") reportCut(vp);
  };

  // Published so the element can end a gesture the reader has not let go of
  // when the scene is replaced: the press holds the plane's screen axis,
  // measured against the outgoing scene.
  //
  // It concludes rather than abandons. A swap can arrive mid-drag: the
  // interface waits for the hand to come off the model but gives up after
  // BUSY_WAIT_MS, so a `pointerup` this page never sees cannot block the
  // reader's Switch. Without a report, `state.cutOffset` keeps the pre-drag
  // depth: the plane still lands correctly (`restoreSection` subtracts the same
  // stale offset and the seed absorbs the difference), but the seed leaves the
  // clicked face and the interface shows a wrong depth.
  const endGesture = () => {
    const p = press;
    finish();
    conclude(p);
  };
  vp.endGesture = endGesture;

  /** Turn a click on a face into an oriented, located cutting plane.
   *
   * Every failure leaves the plane where it was, silently: a click that misses
   * the model or lands on an edge cuts nothing, and the next click recovers.
   */
  const seedCut = (g, x, y) => {
    let found = null;
    try {
      found = faceNormalAt(g.picker, x, y);
    } catch (error) {
      console.warn("section pick", error);
    }
    if (!found) return;
    const point = [found.point.x, found.point.y, found.point.z];
    // The offset starts over: it is measured from the face just clicked, and
    // carrying the previous plane's depth would put this one somewhere nobody
    // pointed at.
    vp.state.cutOffset = 0;
    if (!placeSectionPlane(vp, g, found.normal, point)) return;
    keepSectionCut(vp, g);
    const owner = found.info ? (found.info.solidPath
      || String(found.info.path).replace(/\/(faces|edges|vertices)\/[^/]+$/, "")) : null;
    // Which part the plane was laid on, kept ON THE SEED so the end of a later
    // drag can name the same part without picking again — by then the cursor is
    // wherever the drag ended, which is usually not on that face any more.
    vp.sectionSeed.id = owner;
    vp.sectionSeed.name = owner ? owner.split("/").filter(Boolean).pop() : null;
    emit(vp, EVENT_FACE, {
      id: owner,
      name: vp.sectionSeed.name,
      point,
      normal: found.normal,
      offset: 0,
      range: sectionRange(vp.viewer),
    });
  };

  /**
   * The normal of the face under a comment's click, turned to the side the
   * reader is looking from, or null where the face gives none.
   *
   * `faceNormalAt` takes it from a cross product, so its sign is whichever way
   * the samples happened to wind; an arrow stood along the other sign would come
   * out of the back of the face, inside the part. So the camera decides, as it
   * does for the cut in `placeSectionPlane` (which wants the opposite side).
   * Under the orthographic camera every pixel looks along the one view axis.
   *
   * Guarded like `seedCut`: a picker that throws costs the arrow its direction,
   * not the comment its point.
   */
  const facingNormalAt = (g, x, y) => {
    let found = null;
    try {
      found = faceNormalAt(g.picker, x, y);
    } catch (error) {
      console.warn("comment normal", error);
    }
    const basis = found ? cameraBasis(vp.viewer, g) : null;
    if (!basis) return null;
    const n = found.normal;
    return dot3(n, basis.view) > 0 ? [-n[0], -n[1], -n[2]] : n;
  };

  /** One click of the measure tool. */
  const measureAt = (g, x, y) => {
    const entity = pickEntity(g, x, y);
    if (!entity) {
      // A click on the background clears the tape rather than leaving half a
      // measurement standing: two clicks that are not both on the model are not
      // a measurement of anything.
      vp.measurePicks = [];
      vp.measureLabel = null;
      vp.overlay.refresh();
      return;
    }
    vp.measurePicks.push(entity);
    if (vp.measurePicks.length > 2) vp.measurePicks = [entity];
    const answer = vp.measurePicks.length === 2
      ? measureDistance(vp, vp.measurePicks[0], vp.measurePicks[1])
      : measureEntity(vp, entity);
    if (!answer) return;
    // Mid-point of the two ends, or the point itself, so the label sits on what
    // it is describing rather than in a corner.
    const pts = answer.points.filter(Boolean);
    vp.measureLabel = pts.length
      ? {
          text: `${answer.value.toFixed(2)}`,
          point: pts.length === 2
            ? [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2,
               (pts[0][2] + pts[1][2]) / 2]
            : pts[0],
        }
      : null;
    vp.overlay.refresh();
    emit(vp, EVENT_MEASURE, answer);
  };

  function onMove(event) {
    if (!press) return;
    if (!travelled(event, press)) return;
    press.moved = true;
    if (press.tool === "cut") {
      const g = internals(vp.viewer);
      if (!g || !vp.sectionSeed) return;
      // Once per gesture: the controls are held off for its whole duration, so
      // the camera cannot move underneath and the projection stays valid.
      if (press.axis === undefined) {
        press.axis = sectionAxis(vp.viewer, g, vp.sectionSeed.point);
      }
      // Edge-on to the view: the plane's screen projection has collapsed and a
      // drag here would fling it across the model. It stands still until the
      // model is turned.
      if (!press.axis) return;
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      press.x = event.clientX;
      press.y = event.clientY;
      dragSection(vp, g, press.axis, dx, dy);
    }
  }

  /**
   * What is under the cursor, with the cut face asked about first.
   *
   * The stencil cap carries no component id, so the picker reads through it to
   * the part flush underneath, which the reader cannot see at that pixel
   * (`picking.js` explains why the picker cannot be fixed). Only while a cut
   * stands; otherwise `capOwnerAt` returns at once.
   *
   * Shared by the menu and the plain selection so a right click and a left
   * click on one pixel name the same part.
   *
   * The other `pickEntity` callers (measure, comment, move) need a point on a
   * real surface, which a synthetic cap quad is not, so they ask the picker
   * directly. A selection is only an identity (`onPick` reads `id` and `name`)
   * and a menu is about a part, so the cap answers both fully.
   */
  function entityAt(g, event, x, y) {
    const ndc = ndcAt(g.canvas, event);
    return (ndc && capOwnerAt(vp, g, ndc)) || pickEntity(g, x, y);
  }

  function onUp(event) {
    const p = press;
    finish();
    if (!p) return;
    const g = internals(vp.viewer);
    if (!g) return;
    if (p.moved) {
      conclude(p);
      return;
    }
    // A press that never moved is a click, and it costs the trackball nothing:
    // a rotation of zero pixels is no rotation at all.
    const at = canvasXY(g.canvas, event);
    if (!at) return;
    const [x, y] = at;
    if (p.menu) {
      // `entityAt`, the same resolver as the plain pick below, so the menu and
      // the selection name one part on a cut face.
      //
      // It does not emit a pick: the menu is about the part under the cursor,
      // the selection about the part the reader chose, and a tree row's menu
      // also leaves the selection alone.
      const entity = entityAt(g, event, x, y);
      emit(vp, EVENT_MENU, {
        id: entity ? entity.id : null,
        name: entity ? entity.name : null,
        // The cursor, where a context menu opens, in client coordinates: the
        // menu is `position: fixed` on the page.
        x: event.clientX,
        y: event.clientY,
      });
      return;
    }
    if (p.tool === "cut") {
      seedCut(g, x, y);
      return;
    }
    if (p.tool === "measure") {
      measureAt(g, x, y);
      return;
    }
    if (p.tool === "comment") {
      const entity = pickEntity(g, x, y);
      if (!entity) return;
      emit(vp, EVENT_PLACE, {
        id: entity.id, name: entity.name, p: entity.point,
        n: facingNormalAt(g, x, y),
      });
      return;
    }
    // No tool: a plain selection; the background deselects.
    //
    // `entityAt`, the same resolver the menu uses, so a click on a cut face
    // selects the cut part rather than the hidden part under it.
    const entity = entityAt(g, event, x, y);
    emit(vp, EVENT_PICK, entity
      ? { id: entity.id, name: entity.name, point: entity.point }
      : { id: null, name: null, point: null });
  }

  /** The pointer was taken away (platform scrolling, a browser gesture); no
   *  `pointerup` follows. Nothing is reported: an interrupted cut is dropped
   *  (see `conclude`).
   */
  function onCancel() {
    finish();
  }

  const onDown = (event) => {
    // A press with one still live (a release this page never saw, or a second
    // button or finger mid-drag): the old one ends here silently, the cut's
    // rule for every ending but the release (`conclude`).
    finish();
    // Two buttons mean something here and the rest mean nothing: the left is
    // every tool and the plain pick, the right is the part menu.
    if (event.button !== 0 && event.button !== 2) return;
    const viewer = vp.viewer;
    if (!viewer) return;
    const g = internals(viewer);
    if (!g || event.target !== g.canvas) return;
    if (event.button === 2) {
      // Only watched, never taken: the library pans on the right button
      // (wheel.js), so the press goes on to the controls and travel decides at
      // release (under CLICK_PX the menu opens), the same threshold `onMove`
      // uses for left clicks.
      //
      // `tool` is null: no tool branch should fire, and a sentinel would add a
      // second vocabulary to a field holding the interface's tools.
      press = {
        tool: null, menu: true,
        x: event.clientX, y: event.clientY,
        startX: event.clientX, startY: event.clientY,
        moved: false, axis: undefined,
      };
      watch.arm();
      return;
    }
    // `activeTool`, not `state.tool`: the hold key puts the cut up without
    // writing to `state` (the interface owns it).
    //
    // Read once and kept on `press`: releasing the key mid-drag must not turn a
    // cut in progress into something else.
    const tool = vp.activeTool;
    press = {
      tool,
      x: event.clientX, y: event.clientY,
      startX: event.clientX, startY: event.clientY,
      moved: false, axis: undefined,
    };
    watch.arm();
    if (!tool) return;
    // The move tool takes no press here, so the trackball still shares the
    // canvas with it. A part is moved only by its manipulator: an axis arrow or
    // plane quad (gizmo.js) or a rotation disc (rings.js), each taking its press
    // in a capture-phase window listener that runs first. A press reaching this
    // line under `move` missed the widget and means what it means with no tool:
    // a click selects, a drag orbits.
    //
    // The tool stays on `press` rather than null: the press falls through
    // `onUp` to the plain pick, like an unknown tool.
    if (tool === "move") return;
    // Take the press from the trackball: a capture-phase listener on the
    // container runs before the canvas's pointerdown handler, so the controls
    // never begin a rotation. preventDefault also suppresses compatibility
    // mouse events, avoiding a stray double-click.
    event.preventDefault();
    event.stopPropagation();
  };

  /** The browser's own menu, kept off the canvas.
   *
   * The right button opens this page's menu, and the native one would appear on
   * top of it (outside Windows `contextmenu` fires on the press). Preventing it
   * also keeps the release arriving where the native menu would take the
   * pointer.
   */
  const onContextMenu = (event) => event.preventDefault();

  vp.box.addEventListener("pointerdown", onDown, true);
  vp.box.addEventListener("contextmenu", onContextMenu);

  // The teardown also removes the window listeners: a viewport unmounted
  // mid-drag would otherwise leave capture-phase listeners holding a dead scene.
  return () => {
    vp.box.removeEventListener("pointerdown", onDown, true);
    vp.box.removeEventListener("contextmenu", onContextMenu);
    // `finish`, not `endGesture`: the viewport is going away, and there is no
    // scene left to read the plane off.
    finish();
    if (vp.endGesture === endGesture) vp.endGesture = null;
  };
}
