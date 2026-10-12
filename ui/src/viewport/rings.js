// The move tool's rotation handles: three of them round the selected part, one
// per world axis, each dragged to turn the part about that axis only.
//
// Part of the same `move` tool as the axis arrows, like Fusion's single
// manipulator (`TriadCommandInput`: an origin, three arrows, three plane quads
// and three rotation handles). Both halves stand on the part at once, so a
// press must end the other gestures that could be live, including a canvas
// gesture holding a cut: see `handOver` and `onDown`.
//
// One knob per axis is what the reader sees and presses. Full circles of one
// radius drown in the geometry and cross six times, knotting at the centre. So
// each knob sits on its own circle at the bisector of the two world axes
// spanning the ring's plane (three different corners of the widget); at rest a
// short arc fades out either side of it, and the whole circle appears under the
// cursor, showing which axis a press will turn. Radius, knob, arc span and
// construction are measured off Fusion's sprites (options.js); the inks are
// ours.
//
// A turn is a move node's three degrees (ui/src/proposal.js); this widget lets
// the reader drag it instead of typing numbers.
//
// The rings are objects in the scene, not divs over it (`scene3d.js` holds the
// part shared with the section grip): a torus in the world plane its axis spans
// is projected by the camera like everything else, and the angle under the
// hand is where the pointer's ray meets that plane. The knob does not move by
// itself while the part turns; `place` turns it by the angle swept so far.

import { cameraBasis, ndcAt, ndcRay } from "./camera.js";
import { travelled, watchDrag } from "./drag.js";
import { EVENT_PROPOSALTURN, EVENT_TURNED } from "./events.js";
import { gestureRecord, reportGesture } from "./gesture.js";
import { internals } from "./internals.js";
import { finite3 } from "./math.js";
import {
  grabbable, groupFacing, groupHome, movePart, nudgeTurn, partCentre,
} from "./parts.js";
import { RINGS_ORDER, createScene3D, widgetMaterial } from "./scene3d.js";
import {
  RING_ARC_DEG, RING_CASE_PX, RING_DISC_PX, RING_MIN_PX, RING_PX,
  RING_RIM_PX, RING_SHAFT_PX,
} from "./options.js";
import { turnedFrom } from "../proposal.js";

/** The three world axes, in the order they are drawn and in the triad colours.
 *
 * Red, green, blue for X, Y, Z, as in every CAD tool (see gizmo.js). The inks
 * match the arrows' (as hex for a material rather than CSS strings), and
 * `rings.test.js` pins that.
 *
 * The pair spanning each ring's plane is the other two axes in cyclic order,
 * `u = AXES[(k + 1) % 3]` and `v = AXES[(k + 2) % 3]`, which is the pair with
 * `u x v = +k` (Y x Z = X, Z x X = Y, X x Y = Z). So walking from `u` towards
 * `v` is the right-handed turn about the axis, i.e. a positive angle; the other
 * order would turn every part backwards silently. It is written once, as the
 * basis each ring's node is turned to (`oriented`), and both drawing and angle
 * read that frame.
 *
 * `lit` is the same ink lightened, shown on the knob under the cursor: it marks
 * the handle about to be taken without changing the axis colour.
 */
const AXES = [
  { world: [1, 0, 0], ink: 0xc93a31, lit: 0xdc7f79 },
  { world: [0, 1, 0], ink: 0x2e8b40, lit: 0x77b483 },
  { world: [0, 0, 1], ink: 0x2d66c7, lit: 0x769cdb },
];

/** The two inks of the construction: the white the grip stands its ink on
 *  (`CASING` in handle.js) and the dark every piece of the manipulator is
 *  rimmed with (`RIM` in gizmo.js). Geometry rather than a filter (see
 *  `RING_CASE_PX`), since the widget stands on a part of any colour on either
 *  canvas.
 */
const CASING = 0xffffff;
const RIM = 0x14181c;

/** Where on its own circle each ring carries its knob, as an angle in the
 *  ring's own plane.
 *
 * The bisector of the ring's two world axes, 45 degrees from `u` towards `v`
 * (for the X ring, the direction of `+Y +Z`). The three are 60 degrees apart in
 * the world and land in three different corners of the widget under any camera
 * that shows all three. At a world axis, two knobs would coincide at each of
 * the six points where the rings cross.
 */
const DISC_AT = Math.PI / 4;

/** Half the arc drawn at rest, and the half-angle the knob covers of the same
 *  circle, in radians.
 *
 * The fade must be finished within `DISC_HALF`, since the arc runs under the
 * knob and fading ink would show through the knob's casing.
 */
const ARC = (RING_ARC_DEG * Math.PI) / 180;
const DISC_HALF = Math.asin(RING_DISC_PX / 2 / RING_PX);

/** The three bands every piece of this widget is drawn in, outermost first, in
 *  paint order: the dark rim under the white casing under the ink (as `grow` in
 *  handle.js).
 *
 * The curve and the knob grow opposite ways. The curve's bands are three tubes
 * about one circle, each `grow` further out and in than the ink; the knob's are
 * filled discs sharing an outer edge at `RING_DISC_PX / 2`, each `sink` inside
 * the one before. A light fill inside a white casing inside a dark rim reads on
 * a body of its own colour (Fusion's construction).
 *
 * `colour: null` is the axis's own ink.
 */
const BANDS = [
  { colour: RIM, grow: RING_CASE_PX + RING_RIM_PX, sink: 0 },
  { colour: CASING, grow: RING_CASE_PX, sink: RING_RIM_PX },
  { colour: null, grow: 0, sink: RING_RIM_PX + RING_CASE_PX },
];

/** How round the tube of a ring is. Twelve sides is where a 2 px cylinder stops
 *  reading as a polygon at any angle (as in handle.js). */
const SIDES = 12;

/** How round a knob is: at twenty-four sides a 20 px disc departs from its
 *  circle by a twelfth of a pixel at worst, `10 * (1 - cos(pi / 24))`. */
const KNOB_SIDES = 24;

/** How many steps the whole circle is drawn in. At sixty-four a circle of
 *  `RING_PX` stands an eighth of a pixel inside the true curve at the middle of
 *  each step, which is under the line the browser draws it with. */
const STEPS = 64;

/** Half a turn, in radians — the wrap `onMove` unwinds a step across. */
const HALF_TURN = Math.PI;

const DEGREES_PER_RADIAN = 180 / Math.PI;

/** The raycast of a piece that is only looked at: nothing.
 *
 * Only the knob takes a press. three tests an object's layers, never its
 * visibility, so the hidden full circle would be a 210 px target in front of
 * the knobs, and `intersectObject` answers with the nearest hit. An empty
 * `raycast` on the instance (three's `Object3D.prototype.raycast` is empty;
 * `Mesh` overrides it) keeps a mesh drawn but never hit.
 */
const NO_HIT = () => {};

/**
 * How solid the resting arc is `t` radians round from its own start: per-vertex
 * alpha, fully solid across the knob's width, a straight ramp out to
 * `RING_ARC_DEG` either side, nothing beyond.
 */
const solidity = (t) => {
  const away = Math.abs(t - ARC);
  if (away <= DISC_HALF) return 1;
  if (away >= ARC) return 0;
  return (ARC - away) / (ARC - DISC_HALF);
};

/**
 * Give a torus the alpha that fades its two ends out, and hand it back.
 *
 * Read off each vertex's position, not generation order: a torus vertex is at
 * `((R + r cos v) cos u, (R + r cos v) sin u, r sin v)` and `R > r`, so
 * `atan2(y, x)` is exactly the sweep parameter `u`.
 */
function feather(three, geometry) {
  const position = geometry.getAttribute("position");
  const tint = new Float32Array(position.count * 4);
  for (let at = 0; at < position.count; at += 1) {
    const t = Math.atan2(position.getY(at), position.getX(at));
    tint[at * 4] = 1;
    tint[at * 4 + 1] = 1;
    tint[at * 4 + 2] = 1;
    tint[at * 4 + 3] = solidity(t);
  }
  geometry.setAttribute("color", new three.Float32BufferAttribute(tint, 4));
  return geometry;
}

/**
 * One material of this widget: `widgetMaterial` plus two flags the grip does
 * not need.
 *
 * `fading` turns on per-vertex alpha; `both` disables culling for the knob, a
 * flat disc seen from either side. A closed tube keeps the default, since two
 * blended sides would double the fade's alpha.
 */
function ringMaterial(three, colour, { fading = false, both = false } = {}) {
  const material = widgetMaterial(three, colour);
  if (fading) material.vertexColors = true;
  if (both) material.side = three.DoubleSide;
  return material;
}

/**
 * Where the pointer is on one ring's own circle, as an angle about that ring's
 * world axis, or null for a ray that cannot answer.
 *
 * The ring lies in the world plane `axis` is normal to and does not move with
 * the part, so that plane is `x[axis] = centre[axis]`: meet it with the ray
 * under the cursor and take `atan2` in the cyclic pair. The sign needs no
 * correction because `u x v` is `+axis`.
 */
function ringAngle(vp, g, axis, centre, event) {
  const basis = cameraBasis(vp.viewer, g);
  if (!basis) return null;
  const ndc = ndcAt(g.canvas, event);
  if (!ndc) return null;
  const ray = ndcRay(g, basis.eye, basis.view, ndc[0], ndc[1]);
  if (!ray) return null;
  // A ray lying in the ring's plane meets it nowhere (a NaN in the camera ends
  // here too); `RING_MIN_PX` has already removed a ring that flat.
  const along = ray.dir[axis];
  if (!along) return null;
  const t = (centre[axis] - ray.origin[axis]) / along;
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  const theta = Math.atan2(ray.origin[v] + t * ray.dir[v] - centre[v],
                           ray.origin[u] + t * ray.dir[u] - centre[u]);
  return Number.isFinite(theta) ? theta : null;
}

/**
 * Where one body of the proposal has its own origin, in world units, or null.
 *
 * The point the document turns it about: `placed` in ui/src/proposalgeom.js
 * rotates a body in its own coordinates and then carries it to `at`, so `at` is
 * the point a change of `rot` keeps fixed. A preview about any other point would
 * jump to the document's answer on release.
 *
 * Read off the payload, not the scene: a proposal body has an identity `loc`
 * and its placement baked into the vertices, so neither its group origin nor
 * its box centre is `at`. The panel puts `at` on the part it hands over
 * (`part()` in proposalgeom.js).
 */
function bodyOrigin(vp, path) {
  const name = vp.overlayBody(path);
  if (!name) return null;
  const parts = Array.isArray(vp.overlayParts) ? vp.overlayParts : [];
  const part = parts.find((entry) => entry && entry.name === name);
  return part && finite3(part.origin) ? part.origin : null;
}

/** How a finished turn is announced: the event for a part of the build, the
 *  event for a body of the proposal, and the field of `vp.moved` it writes.
 *
 * Two events because they are opposite claims: a build part's turn is a
 * statement to the agent about an unchanged model, a body's turn is an edit of
 * the document. `MOVE_REPORT` in gizmo.js is the same for a place.
 */
const TURN_REPORT = {
  modelEvent: EVENT_TURNED, proposalEvent: EVENT_PROPOSALTURN, key: "turn",
};

/**
 * What a turn records beyond `gestureRecord` in gesture.js (the standing pose,
 * the carried offset, the build stamp): `seats`.
 *
 * `seats` replaces `vp.moved` for a proposal body: where each group stands,
 * which way it faces and where the body's origin is, taken at the press and
 * dropped with the gesture (`nudgeTurn` says why none may be remembered).
 *
 * A slide records only the home plus the press's pointer position
 * (`moveRecord` in gizmo.js).
 */
function turnRecord(vp, paths, anchor, proposal) {
  return {
    ...gestureRecord(vp, paths, anchor, proposal, TURN_REPORT.key),
    seats: proposal ? paths.map((path) => ({
      home: groupHome(vp.viewer, path),
      pose: groupFacing(vp.viewer, path),
      centre: bodyOrigin(vp, path),
    })) : null,
  };
}

export function createRings(vp) {
  addEventListener("pointermove", onMove, true);

  // The group, the place in the render pass, the pixel scale, the press and
  // the teardown are `scene3d.js`'s. Nothing is called until the first `attach`
  // and the first frame drawn after it.
  //
  // `handOver` is a separate callback, not the head of `onDown`: `scene3d.js`
  // calls `onDown` only for a press that hit the widget, but a missed press
  // strands gestures too. It is called first, so it never stops the drag
  // `onDown` builds.
  const widget = createScene3D(vp, {
    wanted, build, place, press: onDown, handOver, cursor: "grab",
    order: RINGS_ORDER,
  });

  // Built with the group, because the THREE namespace arrives with it.
  //
  // A raycaster of our own beside `scene3d.js`'s: that one asks whether any of
  // the widget is under the pointer (for the cursor), this one which of the
  // three. `axisOf` answers it once, so the knob lit on hover and the knob a
  // press turns always agree.
  let group = null;
  let raycaster = null;
  let pointer = null;

  /** One per axis: the node its circle lies in, the two forms of that circle,
   *  the node the knob is carried on, and the knob's own ink. */
  let rings = [];

  /** Which axis each knob's hit target belongs to. */
  const knobs = new Map();

  // The gesture in progress: the ring, the part centre and the angle at the
  // press, the sweep since, the record being applied, and whether the pointer
  // has travelled far enough to be a drag. Null between gestures.
  let drag = null;

  // Which axis the cursor is on, or -1. Written by `onMove` and read once a
  // frame by `place`.
  let lit = -1;

  /**
   * The selection these rings stand for, or null when there is nothing to put
   * them round.
   *
   * Identical to `held` in gizmo.js: both halves of one widget must appear
   * under the same conditions, so the question is `grabbable` in parts.js and
   * only the tool check lives here.
   *
   * `activeTool`, not `state.tool` (see tools.js): the hold key puts the cut up
   * without writing to `state`.
   *
   * Read every frame, so the widget disappears by itself when the tool is
   * disarmed or the selection cleared.
   */
  const held = () => (vp.activeTool === "move"
    ? grabbable(vp, vp.state.selected)
    : null);

  function wanted() {
    return !!held();
  }

  /** One ring's own frame: its circle in local XY, its axis along local +Z.
   *
   * Where the sign is settled once for drawing and gesture: three builds a
   * torus and a circle in XY sweeping from +X towards +Y, so mapping +X onto `u`
   * and +Y onto `v` runs the curve right-handed about `+k`, and `ringAngle`
   * uses the same pair.
   */
  function oriented(three, k) {
    const node = new three.Object3D();
    node.quaternion.setFromRotationMatrix(new three.Matrix4().makeBasis(
      new three.Vector3(...AXES[(k + 1) % 3].world),
      new three.Vector3(...AXES[(k + 2) % 3].world),
      new three.Vector3(...AXES[k].world)));
    return node;
  }

  /** One drawn mesh: its place in the paint order, and no answer to a ray. */
  function piece(three, geometry, material, order) {
    const mesh = new three.Mesh(geometry, material);
    mesh.renderOrder = order;
    mesh.raycast = NO_HIT;
    return mesh;
  }

  /**
   * The three rings, in CSS pixels (`scene3d.js` scales the group so one unit
   * is one canvas pixel).
   *
   * Geometries are shared, materials are not: the rings differ only by ink, and
   * the knob's material is per axis because it lightens under the cursor.
   *
   * Nested `Object3D`, never a `Group`: three treats `renderOrder` as the group
   * order at every `Group`, which would drop the widget out of the bucket
   * `scene3d.js` put it in and behind the model.
   */
  function build(three, grp) {
    group = grp;
    raycaster = new three.Raycaster();
    pointer = new three.Vector2();
    // The curve's three bands are three tubes about ONE circle: the ink's outer
    // edge is `RING_PX`, so its centre line is half a shaft inside that, and
    // each band grows by `grow` on both sides of the same line. `pieces()` drew
    // the flat widget as three circles sharing that outer edge, which is the
    // same three bands said in the unit a border-box could carry.
    const middle = RING_PX - RING_SHAFT_PX / 2;
    const span = 2 * ARC;
    const curve = BANDS.map(({ grow }) => {
      const tube = RING_SHAFT_PX / 2 + grow;
      return {
        // The same angular resolution as the whole circle, so the arc and the
        // circle replacing it on hover are the same curve.
        arc: feather(three, new three.TorusGeometry(
          middle, tube, SIDES, Math.ceil((STEPS * span) / (2 * Math.PI)), span)),
        whole: new three.TorusGeometry(middle, tube, SIDES, STEPS),
      };
    });
    const faces = BANDS.map(({ sink }) => new three.CircleGeometry(
      RING_DISC_PX / 2 - sink, KNOB_SIDES));
    // The hit target is exactly the knob's drawn size: no tolerance needed.
    const target = new three.CircleGeometry(RING_DISC_PX / 2, KNOB_SIDES);
    rings = AXES.map((axis, k) => {
      const node = oriented(three, k);
      const arc = new three.Object3D();
      // The arc is drawn from its own zero, so it is turned to sit centred on
      // the knob's resting angle. The knob's own node is turned every frame.
      arc.rotation.z = DISC_AT - ARC;
      const whole = new three.Object3D();
      const knob = new three.Object3D();
      let face = null;
      BANDS.forEach(({ colour }, at) => {
        const ink = colour === null ? axis.ink : colour;
        arc.add(piece(three, curve[at].arc,
                      ringMaterial(three, ink, { fading: true }), at - 2));
        whole.add(piece(three, curve[at].whole, ringMaterial(three, ink),
                        at - 2));
        const material = ringMaterial(three, ink, { both: true });
        const disc = piece(three, faces[at], material, at + 1);
        disc.position.x = RING_PX;
        knob.add(disc);
        // The LAST of the three bands is the ink, which is the one that
        // lightens under the cursor and the one the target below borrows.
        face = material;
      });
      // `visible = false` rather than a transparent material: three's raycaster
      // tests layers, never visibility, so this mesh is hit but never drawn (no
      // extra draw call). It is the one mesh without `NO_HIT`.
      //
      // The ring's own visibility is checked here on the mesh, because `place`
      // removes an edge-on ring by clearing `node.visible`, which no raycaster
      // consults. Two raycasters hit this group, `aimed` and `scene3d.js`'s (for
      // the cursor), and only the mesh is seen by both; otherwise the canvas
      // would show `grab` over an undrawn ring.
      const hit = new three.Mesh(target, face);
      hit.position.x = RING_PX;
      hit.visible = false;
      hit.raycast = function answer(caster, found) {
        if (node.visible) three.Mesh.prototype.raycast.call(this, caster, found);
      };
      knob.add(hit);
      knobs.set(hit, k);
      node.add(arc, whole, knob);
      group.add(node);
      return { node, arc, whole, knob, face };
    });
  }

  /** Which axis a ray landed on, or -1 for anything that is not a knob. Rings
   *  removed by the last frame never get here (see the hit mesh's `raycast`).
   */
  const axisOf = (object) => {
    const k = knobs.get(object);
    return k === undefined ? -1 : k;
  };

  /** Which axis's knob the pointer is standing on, or -1. */
  function aimed(g, event) {
    if (!group || !group.visible || !raycaster) return -1;
    const ndc = ndcAt(g.canvas, event);
    if (!ndc) return -1;
    pointer.set(ndc[0], ndc[1]);
    raycaster.setFromCamera(pointer, g.cam);
    // A press does not know which frame it is on (see `scene3d.js`).
    group.updateMatrixWorld(true);
    const hits = raycaster.intersectObject(group, true);
    return hits.length ? axisOf(hits[0].object) : -1;
  }

  /**
   * Put the three rings round the part, or say there is nothing to put them
   * round.
   *
   * On the world axes, not the part's: the rings show which way the part will
   * go. So this writes only where the group stands, and per ring whether it is
   * drawn, how much of it, and where the hand has carried its knob.
   */
  function place(root, g) {
    const sel = held();
    if (!sel) return false;
    // The first selected path, the same anchor the press takes: a row of
    // copies turns as one, and the rings stand round one of them. Read off the
    // scene, like the arrows' anchor, since the part may have been dragged
    // between presses.
    const centre = partCentre(vp.viewer, sel.paths[0]);
    if (!centre) return false;
    const basis = cameraBasis(vp.viewer, g);
    if (!basis) return false;
    root.position.set(centre[0], centre[1], centre[2]);
    // A drag keeps its ring lit wherever the pointer is: turning the part
    // carries the hand off the knob at once.
    const on = drag ? drag.axis : lit;
    rings.forEach((ring, k) => {
      // A ring seen edge-on is removed, not flattened (see `RING_MIN_PX`): its
      // knob flattens with it and cannot be aimed at. The minor semi-axis of a
      // circle of `RING_PX` seen along `view` is `RING_PX * |n . view|`, and the
      // ring's normal is world axis `k`, so the dot is one component.
      ring.node.visible = Math.abs(basis.view[k]) * RING_PX >= RING_MIN_PX;
      // The whole circle is the hover feedback: it shows the plane the part is
      // about to turn in before the reader commits.
      const glow = ring.node.visible && k === on;
      ring.whole.visible = glow;
      ring.arc.visible = !glow;
      ring.face.color.setHex(glow ? AXES[k].lit : AXES[k].ink);
      // The knob stays under the hand: `swept` is the angle travelled, so the
      // knob sits at its resting place plus that.
      ring.knob.rotation.z = DISC_AT
        + (drag && drag.axis === k ? drag.swept : 0);
    });
    return true;
  }

  /** The window listeners for a gesture: release and cancel, not move.
   *
   * `pointermove` stays on the window for the widget's whole life, because one
   * handler answers both where a live drag has got to and which knob the cursor
   * is on with no drag. `watchDrag` arms only the handlers it is given.
   */
  const watch = watchDrag({ onUp, onCancel });

  /** Let go of the gesture, wherever it ended. */
  const finish = () => {
    drag = null;
    watch.disarm();
    // The cursor goes back to answering the ray; every ending comes through
    // here.
    widget.grabbed(false);
  };

  /** End the gesture and report which way the part ended up facing.
   *
   * Every ending reports: the release, a pointer the platform took away, a
   * second press during a live one, and the scene swapped under a held hand.
   * The part already stands turned where the reader left it, and only the
   * document can be wrong about that. (A cut is different: `conclude` in
   * tools.js reports from two endings only, since announcing a cut disarms the
   * tool.)
   *
   * Only if it really was a drag (`CLICK_PX` of travel, as on the canvas): a
   * bare press on a ring would otherwise write a node.
   */
  const stop = () => {
    const live = drag;
    finish();
    if (!live) return;
    // The hover ends with the gesture: `lit` still names the knob the gesture
    // started on, and on touch no further move would correct it, leaving a full
    // lit circle. Cleared here, not in `finish`, because only this path ends in
    // a frame; a hand still on the knob relights it on its next move.
    lit = -1;
    // The ring returns to a faded arc and the knob to its resting angle; only a
    // frame shows it, and nothing else here asks for one.
    widget.refresh();
    if (live.moved) reportGesture(vp, live.turn, TURN_REPORT);
  };

  function onMove(event) {
    const g = internals(vp.viewer);
    if (!drag) {
      // Which knob the cursor is on, if a press could land there: `onDown`
      // takes presses only off the canvas, so a knob under the toolbar, a pin
      // or the view cube is not lit.
      const k = g && event.target === g.canvas ? aimed(g, event) : -1;
      if (k === lit) return;
      lit = k;
      // The library draws on demand, so the light asks for a frame, only on a
      // change, so crossing the canvas does not render the scene per event.
      widget.refresh();
      return;
    }
    if (!g) return;
    // A click is not a one-pixel drag (`travelled` in drag.js). There is no
    // click on a ring, so a twitch would turn the part a degree and file a
    // node, opening the panel.
    if (!travelled(event, drag)) return;
    drag.moved = true;
    const theta = ringAngle(vp, g, drag.axis, drag.centre, event);
    if (theta === null) return;
    // Unwrapped, because `atan2` returns `(-pi, pi]`: each step is taken modulo
    // a full turn into `[-pi, pi)` and summed, so `swept` is the angle the hand
    // really travelled (twice round is 720) and crossing the seam is nothing
    // special.
    //
    // It does not change the stored answer: the angles below are read out of a
    // rotation, so 720 and 0 give the same triple and 270 gives -90. It does
    // change where the knob is drawn.
    const step = ((theta - drag.theta + HALF_TURN) % (2 * HALF_TURN)
      + 2 * HALF_TURN) % (2 * HALF_TURN) - HALF_TURN;
    drag.theta = theta;
    drag.swept += step;
    // Whole degrees: the number reaches an agent in a sentence, and 31.7413
    // degrees claims a precision no hand has. The row's field steps by fifteen
    // (`STEP_DEG` in HammerolaViewer.jsx) for setting corner angles; the two
    // tools are not on one grid.
    const degrees = Math.round(drag.swept * DEGREES_PER_RADIAN);
    // A world turn about the grabbed axis, composed onto the part's current
    // pose. Adding to one of the three angles does not give that:
    // `quaternionOf` reads them as `Rz·Ry·Rx`, so from `(0, 0, 90)` thirty added
    // on x turns the part about world Y, while the rings are drawn on world
    // axes.
    //
    // So the swept angle is whole degrees but the stored three generally are
    // not: thirty about x on top of `(0, 0, 90)` reads back as `(0, -30, 90)`,
    // as in any CAD tool. `turnedFrom` is the document's function for this sum
    // (with `tidy`), and the panel uses the same one (`turnNodes`), so preview
    // and document agree.
    const d = drag.turn;
    const gesture = [0, 0, 0];
    gesture[drag.axis] = degrees;
    const turn = turnedFrom(d.base, gesture);
    if (turn[0] === d.last[0] && turn[1] === d.last[1]
        && turn[2] === d.last[2]) {
      // The knob moved though the part did not (most events of a slow drag:
      // `swept` is continuous, the part turns in whole degrees). The calls
      // below render by themselves; this branch must ask for the frame.
      widget.refresh();
      return;
    }
    d.last = turn;
    // Two meanings, as in `onMove` in gizmo.js. A proposal body is turned for
    // the eye only and nothing is recorded: an angle in `vp.moved` would be
    // re-applied on top of the document's `rot` after the re-stage. A build
    // part leaves `vp.moved` behind, the pose the scene really holds; `stood`
    // is the last turn that landed, separate from `last` because `movePart` can
    // refuse and `last` must advance regardless or a failed step is retried on
    // every event.
    if (d.body) {
      nudgeTurn(vp, d.paths, d.seats, turn);
      return;
    }
    // The offset is passed back unchanged: `movePart` writes position and
    // orientation together, so omitting it would send a dragged part home.
    if (movePart(vp, d.paths, d.delta, turn)) d.stood = turn;
  }

  function onUp() {
    stop();
  }

  function onCancel() {
    stop();
  }

  /**
   * A press on the canvas, whether or not it hit this widget: end the other
   * gestures it strands.
   *
   * What can be live: this widget's drag (`stop()`), the arrows'
   * (`vp.gizmo.endDrag()`), the canvas gesture in tools.js (ended in `onDown`,
   * since only a press this widget keeps hides it from that listener; under
   * `move` it is a hold-key cut or an ordinary press that missed the widget,
   * whose release would otherwise change the selection under a live turn), and
   * the section grip's, left alone since it drives only the clipping plane.
   *
   * The arrows' too: both answer to `move`, so a finger on an arrow followed by
   * one on a knob would leave two live drags, both `onMove`s on the window and
   * neither filtering by pointer id, overwriting each other's half of the node
   * and both reporting at release (see gizmo.js's `onDown`).
   *
   * Also on a press that misses every knob, which is why `scene3d.js` calls
   * this before its ray: a second finger on the model strands an arrow drag
   * just the same.
   *
   * Before any record is built: concluding the arrow drag leaves its offset in
   * `vp.moved`, which `turnRecord` reads as the `delta` to carry, so the turn
   * starts where the slide ended.
   *
   * No check that `vp.gizmo` exists: `element.js` builds both widgets in one
   * synchronous `connectedCallback`, and `destroy()` keeps both fields while
   * removing both widgets' listeners.
   */
  function handOver(event) {
    if (event.button !== 0) return;
    const g = internals(vp.viewer);
    if (!g || event.target !== g.canvas) return;
    stop();
    vp.gizmo.endDrag();
  }

  /**
   * A press the ray found on a knob. True when this widget has taken it, which
   * is what `scene3d.js` suppresses the event on.
   *
   * Primary button only. The press is taken off the canvas, so anything refused
   * goes on to what is behind it: a right-drag pans, a right-click opens the
   * part menu, a middle click goes to the trackball.
   *
   * The axis and the part's centre are measured once and held for the gesture
   * (as gizmo.js's `onDown` holds its axis): together they are the ring's plane,
   * and a turn about the centre leaves the centre in place.
   */
  function onDown(event, g, at) {
    if (event.button !== 0) return false;
    const axis = axisOf(at.object);
    if (axis < 0) return false;
    const sel = held();
    if (!sel) return false;
    const centre = partCentre(vp.viewer, sel.paths[0]);
    if (!centre) return false;
    const theta = ringAngle(vp, g, axis, centre, event);
    if (theta === null) return false;
    // End the canvas gesture too, here rather than in `handOver`: tools.js
    // finishes its own previous press at the head of its `onDown`, which sees
    // every canvas press except one `scene3d.js` takes away on our answer.
    //
    // Not earlier: `endGesture` concludes, and concluding a cut means
    // `reportCut`, which disarms the armed tool; called for every press it
    // would disarm the tool on any canvas press during a cut drag.
    //
    // `vp.endGesture` is always a function here: `installTools` assigns it in
    // the same synchronous `connectedCallback` that builds this widget, and its
    // teardown (which nulls it) runs inside `destroy()` together with removing
    // this widget's listeners.
    vp.endGesture();
    drag = {
      axis,
      centre,
      theta,
      swept: 0,
      startX: event.clientX,
      startY: event.clientY,
      turn: turnRecord(vp, sel.paths, sel.paths[0], sel.proposal),
      moved: false,
    };
    watch.arm();
    // The ring lights because it is being turned, the only feedback for a
    // press with no hover before it (touch).
    widget.refresh();
    // The canvas shows `grabbing` until `finish`, whatever the ray says, since
    // the hand leaves the 20 px knob within a few degrees.
    widget.grabbed(true);
    return true;
  }

  /** End a drag the reader has not let go of, because the scene is going away.
   *
   * The counterpart of `vp.endGesture` and the grip's and arrows' `endDrag`:
   * the press was taken in a shared window listener, so neither the canvas
   * gesture nor the idle clock that defers the swap saw it, and no release will
   * come. It concludes rather than abandons: abandoning would leave the part
   * turned in `vp.moved` with nothing in the document claiming it, and the next
   * push would straighten it under the reader's hand.
   */
  const endDrag = () => {
    stop();
  };

  return {
    refresh: widget.refresh,
    // The two halves of the lifecycle, passed straight through to the one
    // caller that knows when a scene is replaced: `show()` in element.js.
    attach: widget.attach,
    detach: widget.detach,
    endDrag,
    destroy() {
      // `finish`, not `stop`: `vp.moved` goes away with the widget, so there is
      // nothing standing to report (as in tools.js's teardown).
      finish();
      // And the lifelong hover listener, which outlives any gesture and would
      // otherwise hold a scene that is gone.
      removeEventListener("pointermove", onMove, true);
      widget.destroy();
      group = null;
      raycaster = null;
      pointer = null;
      rings = [];
      knobs.clear();
    },
  };
}
