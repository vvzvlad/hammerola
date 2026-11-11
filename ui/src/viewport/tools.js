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
// Except a plain left press on a part a joint moves (no tool, or Move): it
// drags that joint (`jointGrip`), and the values go up as `hmr:joints`. With
// Alt nothing of ours takes the left press, whatever is armed: Alt is the
// reader's way to orbit from anywhere (scene3d.js refuses it too).
//
// `wheel` is left alone in every mode, so zoom works while a tool is up.
//
// The right button is a second gesture on the same listener and takes nothing
// from the library, which pans on it (wheel.js). Travel decides at release:
// under CLICK_PX it was a click and the part menu opens; otherwise the reader
// was panning.
//
// A finger has no right button. Its long press arrives as a `contextmenu`
// while the press is still down (longpress.js, or Android's own), opens the
// same menu, and leaves its release nothing to do.

import {
  EVENT_FACE, EVENT_JOINTS, EVENT_MEASURE, EVENT_MENU, EVENT_PICK, EVENT_PLACE, emit,
} from "./events.js";
import {
  cameraBasis, canvasXY, ndcAt, ndcRay, rayLineParam, sightAt,
} from "./camera.js";
import { travelled, watchDrag } from "./drag.js";
import { internals } from "./internals.js";
import {
  jointAbove, jointInWorld, rayAngle, unwrapped, withinLimits,
} from "./joints.js";
import { dot3, finite3, sineFromCos, vec3 } from "./math.js";
import { measureDistance, measureEntity } from "./measure.js";
import { GIZMO_MIN_SCALE } from "./options.js";
import { movableGroup } from "./parts.js";
import { capOwnerAt, faceNormalAt, pickEntity } from "./picking.js";
import {
  dragSection, keepSectionCut, placeSectionPlane, sectionAxis,
  sectionOffset, sectionRange,
} from "./section.js";
import { tidy } from "../proposal.js";
import { markMenu } from "../longpress.js";

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

/**
 * The normal, in the mesh's own frame, of the mesh's triangle nearest a point
 * in the world; null for a mesh with no triangles. The walk honours the index,
 * which the library's meshes carry, and the point is taken into the mesh's
 * frame rather than every triangle out of it.
 */
function nearestTriangleNormal(three, mesh, point) {
  const position = mesh.geometry.getAttribute("position");
  if (!position) return null;
  const index = mesh.geometry.index;
  const count = index ? index.count : position.count;
  const local = mesh.worldToLocal(point.clone());
  const triangle = new three.Triangle();
  const closest = new three.Vector3();
  let best = null;
  let nearest = Infinity;
  for (let i = 0; i + 2 < count; i += 3) {
    if (index) {
      triangle.setFromAttributeAndIndices(
        position, index.getX(i), index.getX(i + 1), index.getX(i + 2));
    } else {
      triangle.setFromAttributeAndIndices(position, i, i + 1, i + 2);
    }
    const d = triangle.closestPointToPoint(local, closest).distanceToSquared(local);
    if (d < nearest) {
      nearest = d;
      best = triangle.getNormal(new three.Vector3());
    }
  }
  return best;
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
    if (p && p.moved && p.tool === "cut" && !p.alt) reportCut(vp);
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
   * The exact normal of the face a comment was left on, in the world, taken
   * from the picked solid's own mesh (`front`, as `partCentre` in parts.js
   * reads it). Null without the three namespace (`vp.three`, kept by `show()`),
   * the mesh, the click, the picked point or a triangle.
   *
   * Exact where `faceNormalAt` is not: that samples rings of pixels round the
   * click and needs two of them on the same solid, so a part a few pixels
   * across on screen gives it nothing.
   *
   * Three tries, each for a click the one before cannot place:
   *   * a ray from the camera through the click;
   *   * a ray along the view through the picked point. The picker takes a part
   *     from a few pixels round the click (`pickEntity`, over the library's
   *     half-resolution id buffer), so a click just outside a small part's
   *     outline picks it with the point on its edge, and the first ray misses;
   *   * the triangle nearest the picked point, for an edge point the second
   *     ray only grazes.
   *
   * Of a ray's crossings, the one nearest the picked point wins, not the one
   * nearest the camera: the ray does not honour the section's clip planes, so
   * the first crossing can be geometry the cut has removed.
   */
  const meshNormalAt = (g, entity, event) => {
    const three = vp.three;
    const groups = g.nestedGroup && g.nestedGroup.groups;
    const group = groups ? groups[entity.id] : null;
    const mesh = group && group.front;
    const ndc = ndcAt(g.canvas, event);
    if (!three || !mesh || !ndc || !finite3(entity.point)) return null;
    // As `partCentre` does: a moved part's matrix is composed by the next
    // render, and the group is where the move is written.
    group.updateMatrixWorld();
    const picked = new three.Vector3(...entity.point);
    const caster = new three.Raycaster();
    /** The mesh-frame normal of the crossing nearest `picked` of the ray
     *  through NDC (x, y), or null. */
    const crossed = (x, y) => {
      caster.setFromCamera(new three.Vector2(x, y), g.cam);
      let best = null;
      for (const hit of caster.intersectObject(mesh, false)) {
        if (!hit.face) continue;
        if (!best || hit.point.distanceTo(picked) < best.point.distanceTo(picked)) {
          best = hit;
        }
      }
      return best ? best.face.normal.clone() : null;
    };
    let local = crossed(ndc[0], ndc[1]);
    if (!local) {
      const seen = picked.clone().project(g.cam);
      local = crossed(seen.x, seen.y);
    }
    if (!local) local = nearestTriangleNormal(three, mesh, picked);
    if (!local) return null;
    const n = local.transformDirection(mesh.matrixWorld);
    return [n.x, n.y, n.z];
  };

  /**
   * The normal of the face under a comment's click, turned to the side the
   * reader is looking from, or null where the face gives none: the mesh's own
   * (`meshNormalAt`), else the probe rings' (`faceNormalAt`).
   *
   * Either sign can point into the part: `faceNormalAt` takes it from a cross
   * product, whose sign is whichever way the samples happened to wind, and a
   * mesh may be wound inwards. An arrow stood along it would come out of the
   * back of the face. So the camera decides, as it does for the cut in
   * `placeSectionPlane` (which wants the opposite side), against the line it
   * sees the clicked point along (`sightAt`).
   *
   * Guarded like `seedCut`: a picker or a ray that throws costs the arrow its
   * direction, not the comment its point.
   */
  const facingNormalAt = (g, entity, event, x, y) => {
    let n = null;
    try {
      n = meshNormalAt(g, entity, event);
      if (!n) {
        const found = faceNormalAt(g.picker, x, y);
        n = found ? found.normal : null;
      }
    } catch (error) {
      console.warn("comment normal", error);
    }
    return towardsReader(g, n, entity.point);
  };

  /** `n` at `point` turned to face the camera, or null without a normal or a
   *  camera. */
  const towardsReader = (g, n, point) => {
    const basis = n ? cameraBasis(vp.viewer, g) : null;
    const sight = basis && sightAt(g, basis, point);
    if (!sight) return null;
    return dot3(n, sight) > 0 ? [-n[0], -n[1], -n[2]] : n;
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

  /**
   * The joint a plain left press on the canvas drags, as the gesture's record,
   * or null when the press is not one (no joint above the part under it, a
   * modifier, a line the view cannot drag along), and the trackball keeps it.
   *
   * The joint's line is carried into the world once, through the world matrix
   * of the node's parent group (the frame `jointNodes` declares it in): the drag
   * moves the node, never its parent. A revolute plane seen nearly edge-on, or a
   * slider axis pointing nearly at the reader, is refused at the floor the Move
   * tool hides its quads and arrows at (`GIZMO_MIN_SCALE`), measured against the
   * sight line to the point the hand took: the same hand would swing the value
   * wildly there.
   *
   * A finger never drags a joint: a pinch begun on such a part needs its first
   * finger in the trackball, which a drag would have taken. On a touch screen
   * the slider moves the part.
   */
  const jointGrip = (g, event) => {
    if (!vp.jointNodes.size || event.pointerType === "touch"
        || event.ctrlKey || event.metaKey || event.shiftKey) {
      return null;
    }
    const at = canvasXY(g.canvas, event);
    const entity = at ? entityAt(g, event, at[0], at[1]) : null;
    const held = entity ? jointAbove(vp.jointNodes, entity.id) : null;
    const group = held ? movableGroup(vp.viewer, held.path) : null;
    const parent = group && group.parent;
    if (!parent || !finite3(entity.point)) return null;
    // As `partCentre` reads it: a joint or a move above may have written a
    // group since the last frame composed the matrix.
    parent.updateWorldMatrix(true, false);
    const { joint } = held.node;
    const { origin, axis } = jointInWorld(joint, parent.matrixWorld.elements);
    const basis = axis ? cameraBasis(vp.viewer, g) : null;
    const p = entity.point;
    const sight = basis && sightAt(g, basis, p);
    const ndc = sight ? ndcAt(g.canvas, event) : null;
    const ray = ndc && ndcRay(g, basis.eye, basis.view, ndc[0], ndc[1]);
    if (!ray) return null;
    const facing = dot3(sight, axis);
    const value = vp.jointValues[joint.id] || 0;
    const grip = { joint, axis, start: value, value };
    if (joint.type === "revolute") {
      if (Math.abs(facing) < GIZMO_MIN_SCALE) return null;
      // The point the hand took turns in the plane through it square to the
      // axis, about the axis's foot in that plane. The joint's own origin is
      // any point of the axis, often far along it (a door's hinge at the end
      // of the box): seen at a slant, a plane through it would put the cursor
      // somewhere else and the part would lag or turn against the hand.
      const h = dot3([p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]], axis);
      const centre = [origin[0] + h * axis[0], origin[1] + h * axis[1], origin[2] + h * axis[2]];
      const angle = rayAngle(ray, centre, axis);
      if (angle === null) return null;
      // `swept` is the unclamped sum of the steps: a hand that runs past a
      // limit leaves the part waiting there until it comes back to it.
      return { ...grip, centre, angle, swept: 0 };
    }
    if (sineFromCos(facing) < GIZMO_MIN_SCALE) return null;
    // The slider's line through the point the hand took, and where the ray
    // under the hand comes closest to it: the arrow's arithmetic in gizmo.js.
    const from = rayLineParam(ray, p, axis);
    return from === null ? null : { ...grip, line: p, from };
  };

  /** One step of a joint drag: the value under the hand, clamped to the
   *  joint's limits, sent up with every other joint where it stands. */
  const dragJoint = (grip, event) => {
    const g = internals(vp.viewer);
    const ndc = g ? ndcAt(g.canvas, event) : null;
    const basis = ndc ? cameraBasis(vp.viewer, g) : null;
    const ray = basis && ndcRay(g, basis.eye, basis.view, ndc[0], ndc[1]);
    if (!ray) return;
    let raw;
    if (grip.joint.type === "revolute") {
      const angle = rayAngle(ray, grip.centre, grip.axis);
      if (angle === null) return;
      grip.swept += unwrapped(angle - grip.angle);
      grip.angle = angle;
      raw = grip.start + grip.swept;
    } else {
      const now = rayLineParam(ray, grip.line, grip.axis);
      if (now === null) return;
      raw = grip.start + now - grip.from;
    }
    const value = withinLimits(grip.joint, raw);
    if (value === grip.value) return;
    grip.value = value;
    emit(vp, EVENT_JOINTS, { values: { ...vp.jointValues, [grip.joint.id]: value } });
  };

  function onMove(event) {
    if (!press) return;
    if (!travelled(event, press)) return;
    press.moved = true;
    if (press.joint) {
      dragJoint(press.joint, event);
      return;
    }
    // An Alt press is the trackball's: the plane stays where it is.
    if (press.tool === "cut" && !press.alt) {
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
      dragSection(vp, g, press.axis, dx, dy, [event.clientX, event.clientY]);
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
   * Measure and move need a point on a real surface, which a synthetic cap
   * quad is not, so they ask the picker directly; the comment tool asks the cap
   * itself, for its point on the plane (`onUp`). A selection is only an
   * identity (`onPick` reads `id` and `name`) and a menu is about a part, so
   * the cap answers both fully.
   */
  function entityAt(g, event, x, y) {
    const ndc = ndcAt(g.canvas, event);
    return (ndc && capOwnerAt(vp, g, ndc)) || pickEntity(g, x, y);
  }

  /** The part menu for the part under `event`.
   *
   * `entityAt`, the same resolver as the plain pick, so the menu and the
   * selection name one part on a cut face.
   *
   * It does not emit a pick: the menu is about the part under the cursor, the
   * selection about the part the reader chose, and a tree row's menu also
   * leaves the selection alone.
   *
   * Where no part is under the cursor, a printer's bed of the `print` view may
   * be (beds.js), and its number goes up as `plate`: the page offers that
   * bed's 3MF. A part standing on a bed keeps its own menu.
   */
  function openMenu(g, event) {
    const at = canvasXY(g.canvas, event);
    if (!at) return;
    const entity = entityAt(g, event, at[0], at[1]);
    const plate = entity ? null : vp.beds.bedAt(event);
    emit(vp, EVENT_MENU, {
      id: entity ? entity.id : null,
      name: entity ? entity.name : null,
      ...(plate === null ? null : { plate }),
      // The cursor, where a context menu opens, in client coordinates: the
      // menu is `position: fixed` on the page.
      x: event.clientX,
      y: event.clientY,
    });
  }

  function onUp(event) {
    const p = press;
    finish();
    if (!p) return;
    const g = internals(vp.viewer);
    if (!g) return;
    // A long press already opened the menu: a pick here would close it again
    // (the interface shuts the menu on a pick), and a tool would take the
    // release for its click. A cut dragged before the menu came still reports
    // where the plane ended.
    if (p.moved || p.held) {
      conclude(p);
      return;
    }
    // A press that never moved is a click, and it costs the trackball nothing:
    // a rotation of zero pixels is no rotation at all.
    const at = canvasXY(g.canvas, event);
    if (!at) return;
    const [x, y] = at;
    if (p.menu) {
      openMenu(g, event);
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
      // A click on a cut face comments on the cut face: on the part it
      // belongs to, at its point on the plane, with the arrow standing out
      // along the plane's normal. The picker would answer the surface behind
      // the cap, where the arrow, depth-tested, stays hidden by the cap the
      // reader clicked.
      const ndc = ndcAt(g.canvas, event);
      const cap = ndc ? capOwnerAt(vp, g, ndc) : null;
      if (cap) {
        // The normal through `distanceToPoint`, the method `internals()`
        // guarantees, whatever form `plane.normal` takes (`planePointAt`).
        const d = (q) => g.plane.distanceToPoint(vec3(q));
        const d0 = d([0, 0, 0]);
        emit(vp, EVENT_PLACE, {
          id: cap.id, name: cap.name, p: cap.point,
          n: towardsReader(g, [d([1, 0, 0]) - d0, d([0, 1, 0]) - d0, d([0, 0, 1]) - d0],
                           cap.point),
        });
        return;
      }
      const entity = pickEntity(g, x, y);
      if (!entity) return;
      emit(vp, EVENT_PLACE, {
        id: entity.id, name: entity.name, p: entity.point,
        n: facingNormalAt(g, entity, event, x, y),
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
      // A finger, whose long press opens the menu (`onContextMenu`).
      touch: event.pointerType === "touch",
      // Alt: the trackball orbits on it, and a tool keeps only its click.
      alt: event.altKey === true,
      x: event.clientX, y: event.clientY,
      startX: event.clientX, startY: event.clientY,
      moved: false, axis: undefined,
    };
    watch.arm();
    if (press.alt) return;
    if (!tool || tool === "move") {
      // The move tool takes no press of its own here: its manipulator (gizmo.js,
      // rings.js) takes its presses in a capture-phase window listener that
      // runs first, so a press reaching this line under `move` missed it and
      // means what it means with no tool: on a part a joint moves it drags the
      // joint; elsewhere a click selects and a drag orbits. The tool stays on
      // `press` rather than null: a click falls through `onUp` to the plain
      // pick, like an unknown tool.
      press.joint = jointGrip(g, event);
      if (!press.joint) return;
    }
    // Take the press from the trackball: a capture-phase listener on the
    // container runs before the canvas's pointerdown handler, so the controls
    // never begin a rotation. preventDefault also suppresses compatibility
    // mouse events, avoiding a stray double-click.
    event.preventDefault();
    event.stopPropagation();
  };

  /** The browser's own menu, kept off the canvas; and a finger's long press,
   * which opens ours.
   *
   * The right button opens this page's menu, and the native one would appear on
   * top of it (outside Windows `contextmenu` fires on the press). Preventing it
   * also keeps the release arriving where the native menu would take the
   * pointer.
   *
   * During a touch press this event IS the long press: longpress.js only sends
   * it once the finger has held still, and Android's own comes under the same
   * rule. Once per press, since Android's can follow ours. A mouse press never
   * opens the menu here: a right press's release does, after the pan check.
   *
   * In the capture phase: the library stops `contextmenu` on its canvas
   * (viewer/src/core/viewer.ts), so a listener waiting for it to bubble up to
   * the box never hears the long press.
   */
  const onContextMenu = (event) => {
    event.preventDefault();
    const p = press;
    if (!p || !p.touch || p.held) return;
    const g = internals(vp.viewer);
    if (!g) return;
    p.held = true;
    markMenu(event);
    openMenu(g, event);
  };

  vp.box.addEventListener("pointerdown", onDown, true);
  vp.box.addEventListener("contextmenu", onContextMenu, true);

  // The teardown also removes the window listeners: a viewport unmounted
  // mid-drag would otherwise leave capture-phase listeners holding a dead scene.
  return () => {
    vp.box.removeEventListener("pointerdown", onDown, true);
    vp.box.removeEventListener("contextmenu", onContextMenu, true);
    // `finish`, not `endGesture`: the viewport is going away, and there is no
    // scene left to read the plane off.
    finish();
    if (vp.endGesture === endGesture) vp.endGesture = null;
  };
}
