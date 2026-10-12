// The grip on the section plane: a double-headed arrow standing on the cut, at
// the point where the plane meets the face that was clicked, and dragged to
// slide the plane along its own normal.
// The handle makes the cut's drag (the `cut` branch of `onMove` in tools.js)
// visible; without one, few readers find the gesture.
//
// An object in the scene, not a div over it: a mesh on the plane is turned to
// the normal once and projected by the camera like everything else, so there
// is no screen-space projection maths here. `scene3d.js` carries the shared
// half.
//
// A module of its own, not part of overlay.js: what it draws comes from the
// SECTION rather than `state.pins`, and it carries a live drag.
//
// It also TURNS the plane, with two rings round the same arrow. They are
// children of the arrow's group rather than a separate widget: they share its
// anchor, `wanted`, lifecycle, paint band and press listener (like Fusion's
// section manipulator). A separate widget would need another band in
// `scene3d.js`.

import { cameraBasis, ndcAt, ndcRay } from "./camera.js";
import { internals } from "./internals.js";
import { watchDrag } from "./drag.js";
import { dot3, finite3, unit3 } from "./math.js";
import { HANDLE_ORDER, createScene3D, widgetMaterial } from "./scene3d.js";
import {
  applySection, dragSection, sectionGripAxis, sectionOffset,
} from "./section.js";
import { reportCut } from "./tools.js";
import {
  HANDLE_CASE_PX, HANDLE_HEAD_PX, HANDLE_HIT_PX, HANDLE_PX, HANDLE_RING_PX,
  HANDLE_SHAFT_PX, RING_MIN_PX, RING_RIM_PX, RING_SHAFT_PX,
} from "./options.js";

/** The arrow's ink, as a hex the material takes. One colour for both themes:
 *  the canvas is white or near-black (`readTheme` in ui/src/store.js), so every
 *  widget picks a colour that stands on either. */
const INK = 0x2f353d;

/** The casing under it: white, like the rotation handles' discs (`CASING` in
 *  rings.js), so one dark ink reads on both canvases. */
const CASING = 0xffffff;

/** The dark rim outside that casing, on the rings only — `RIM` in gizmo.js and
 *  rings.js.
 *
 * The casing holds ink against dark geometry and the rim holds the casing
 * against the light canvas, so a rim is needed on a wide band of white. A 2 px
 * shaft with 2 px of casing is nearly all edge already; a ring crosses itself
 * and the arrow (`BANDS` in rings.js, `GIZMO_RIM_PX`).
 */
const RIM = 0x14181c;

/** How round the shaft and the heads are.
 *
 * Twelve is where a 2 px cylinder stops reading as a polygon at any angle; the
 * same for a ring's tube (rings.js uses the same number).
 */
const SIDES = 12;

/** How many steps a ring's circle is drawn in (rings.js's number). At 64 a
 *  circle of `HANDLE_RING_PX` stays within a twentieth of a pixel of the curve. */
const STEPS = 64;

/** Half a turn, in radians — the wrap `turnPlane` unwinds a step across. */
const HALF_TURN = Math.PI;

const DEGREES_PER_RADIAN = 180 / Math.PI;

/** How far apart two directions may stand, component by component, and still be
 *  the same direction — the tolerance a pose is kept across a frame on.
 *
 * The two sides are one direction computed two ways (a quaternion turn of the
 * old normal, and `turnPlane`'s cosine and sine); they agree to rounding, so
 * anything larger is a different normal — another cut.
 */
const SAME_DIR = 1e-6;

/** What a piece that is only ever LOOKED at answers a ray with: nothing.
 *
 * three's raycaster tests an object's layers, never its visibility, so every
 * drawn band of a ring would be a target, and `onDown` classifies a press by
 * the mesh hit — a band would read as the arrow. One hit mesh per ring and the
 * arrow's cylinder are the only things in this group that answer a ray.
 */
const NO_HIT = () => {};

/** The two rings, in the group's OWN frame.
 *
 * Every pose `place` writes stands the group so local +Y is the plane's normal.
 * A ring tilting it about local +X lies in local YZ, one about local +Z in local
 * XY, so as plain children both follow the plane.
 *
 * `u x v = axis` in both, which settles the sign once for drawing and maths:
 * three sweeps a torus from +X towards +Y about +Z, so a node turned by
 * `makeBasis(u, v, axis)` draws right-handed about `axis`, and `turnAngle`
 * reads its `atan2` in the same pair. Reversed, a ring would tip the plane
 * backwards.
 *
 * Local +Y is `u` of the first and `v` of the second, so a turned normal is
 * `u cos a + v sin a` — a unit vector by construction, as section.js requires
 * of anything writing the seed.
 */
const TURNS = [
  { u: [0, 1, 0], v: [0, 0, 1], axis: [1, 0, 0] },
  { u: [1, 0, 0], v: [0, 1, 0], axis: [0, 0, 1] },
];

/** The three bands a ring is drawn in, outermost first and in paint order —
 *  dark rim, white casing, ink (as the arrow's `grow` and `BANDS` in rings.js).
 *
 * All three under the arrow: a ring seen at an angle can cross the arrow on
 * screen, and with no depth test paint order is the stacking.
 */
const BANDS = [
  { grow: HANDLE_CASE_PX + RING_RIM_PX, order: -4 },
  { grow: HANDLE_CASE_PX, order: -3 },
  { grow: 0, order: -2 },
];

/**
 * Where the pointer is on one ring's own circle, as an angle about that ring's
 * world axis, or null for a ray that cannot answer.
 *
 * Like `ringAngle` in rings.js, except the ring's axis is whatever the cut
 * normal leaves it rather than a world axis, so the plane is met the general
 * way and the angle pair comes from `frame`. A ray lying in the plane, or a NaN
 * in the camera, answers null.
 */
function turnAngle(vp, g, frame, at, event) {
  const basis = cameraBasis(vp.viewer, g);
  if (!basis) return null;
  const ndc = ndcAt(g.canvas, event);
  if (!ndc) return null;
  const ray = ndcRay(g, basis.eye, basis.view, ndc[0], ndc[1]);
  if (!ray) return null;
  const along = dot3(ray.dir, frame.axis);
  if (!along) return null;
  const t = (dot3(frame.axis, at) - dot3(frame.axis, ray.origin)) / along;
  const on = [ray.origin[0] + t * ray.dir[0] - at[0],
              ray.origin[1] + t * ray.dir[1] - at[1],
              ray.origin[2] + t * ray.dir[2] - at[2]];
  const theta = Math.atan2(dot3(on, frame.v), dot3(on, frame.u));
  return Number.isFinite(theta) ? theta : null;
}

export function createHandle(vp) {
  // The group, the place in the library's render pass, the pixel scale, the
  // press and the teardown are `scene3d.js`'s. `wanted`, `build`, `place` and
  // `onDown` are the declarations below; nothing is called until the first
  // `attach` and the first frame the library draws after it.
  const widget = createScene3D(vp, {
    wanted, build, place, press: onDown, rank, cursor: "grab",
    order: HANDLE_ORDER,
  });

  // The vectors the orientation is computed with, kept rather than allocated per
  // frame (this runs every frame during an orbit); built with the group.
  let up = null;
  let aim = null;
  let scratch = null;
  // `spin` is the rotation a live turn has applied so far, and `posed` its
  // composition with the pose at the press — the last one written, which
  // outlives the gesture. Without it the frame after release would re-derive the
  // pose from the normal, and `setFromUnitVectors` may pick any twist about it:
  // the rings would snap round by up to 45 degrees as the hand came off.
  let spin = null;
  let posed = null;

  // The group itself: the rings' frames are local, every question about them is
  // asked in the world, and the orientation `place` writes carries them across.
  let group = null;

  /** One per ring: the node its circle lies in, and that ring's own frame. */
  let turns = [];

  /** Which ring each hit mesh belongs to — the one thing that tells a press
   *  meant for the rings from a press meant for the arrow. */
  const grabs = new Map();

  /**
   * Which gesture a press belongs to when the ray finds both, lowest first —
   * the arrow over the rings.
   *
   * Not the nearest hit (`scene3d.js`'s default): every ring band is painted
   * under the arrow, and a ring seen near edge-on has a hit tube reaching over
   * the arrow, so the ray can meet the ring first where the arrow is drawn. What
   * the reader sees takes the press (`gizmo.js` keeps the same rule in `RANK`).
   *
   * Asked of the rings, not the arrow: `grabs` holds every ring hit mesh, and
   * everything else in the group is the arrow's.
   *
   * A function declaration because `createScene3D` receives it at the top of
   * this function, like `wanted`, `build` and `place`.
   */
  function rank(object) {
    return grabs.has(object) ? 1 : 0;
  }

  // The gesture in progress: for a slide, the screen axis measured at its start
  // and where the pointer was at the previous event; for a turn, `turn` and
  // everything `takeTurn` measured once. Null between gestures.
  let drag = null;

  /**
   * The arrow, in CSS pixels along +Y — the axis three gives a cylinder and a
   * cone, so the orientation below is one rotation from +Y onto the plane's
   * normal rather than two.
   *
   * Three materials — ink, casing, and the rings' rim — shared by every mesh,
   * so the renderer sorts three programs. The rings use the grip's ink material
   * itself, so they cannot become a second palette.
   *
   * The heads are as long as they are wide (`HANDLE_HEAD_PX`) and sit at the
   * ends, so each tip is exactly `HANDLE_PX / 2` from the anchor. That is the
   * INK; the casing stands `HANDLE_CASE_PX` outside it everywhere, tips included.
   */
  function build(three, grp) {
    group = grp;
    up = new three.Vector3(0, 1, 0);
    aim = new three.Vector3();
    scratch = new three.Vector3();
    spin = new three.Quaternion();
    posed = new three.Quaternion();
    const ink = widgetMaterial(three, INK);
    const casing = widgetMaterial(three, CASING);
    // Drawn twice: the casing copy (`grow` = `HANDLE_CASE_PX`, `renderOrder`
    // -1) goes first within this group — three uses the group's `renderOrder`
    // as the group order and sorts the subtree inside it. With no depth test,
    // first drawn is underneath, so it shows as a white rim (`options.js`
    // explains rim vs shadow).
    for (const [grow, material, order] of
      [[HANDLE_CASE_PX, casing, -1], [0, ink, 0]]) {
      const shaft = new three.Mesh(
        new three.CylinderGeometry(HANDLE_SHAFT_PX / 2 + grow,
                                   HANDLE_SHAFT_PX / 2 + grow,
                                   HANDLE_PX - 2 * HANDLE_HEAD_PX, SIDES),
        material);
      shaft.renderOrder = order;
      group.add(shaft);
      for (const end of [1, -1]) {
        const head = new three.Mesh(
          new three.ConeGeometry(HANDLE_HEAD_PX / 2 + grow,
                                 HANDLE_HEAD_PX + 2 * grow, SIDES), material);
        head.position.y = (end * (HANDLE_PX - HANDLE_HEAD_PX)) / 2;
        // A cone points +Y, so the lower one is turned over. About Z because any
        // axis across Y does it and Z is the one the shaft is not on.
        if (end < 0) head.rotation.z = Math.PI;
        head.renderOrder = order;
        group.add(head);
      }
    }
    // The target is fat and the ink thin: a hand cannot reliably hit a 2 px
    // shaft, so the ray meets an `HANDLE_HIT_PX` cylinder round the arrow.
    //
    // `visible = false`, not a transparent material: three's raycaster tests
    // layers, never visibility (`intersect()` in three.core), so this is hit and
    // never drawn. `scene3d.js` checks `group.visible` by hand for the same
    // reason.
    const target = new three.Mesh(
      new three.CylinderGeometry(HANDLE_HIT_PX / 2, HANDLE_HIT_PX / 2,
                                 HANDLE_PX, SIDES),
      ink);
    target.visible = false;
    group.add(target);
    buildRings(three, [widgetMaterial(three, RIM), casing, ink]);
  }

  /**
   * The two rings, in the same CSS pixels the arrow is drawn in.
   *
   * Geometries and materials are shared; nothing here highlights under a
   * cursor, so the two rings differ only by the frame of their node.
   *
   * A nested `Object3D`, never a `Group`: three re-reads `renderOrder` as the
   * group order at every `Group`, which would drop the rings out of this
   * widget's band and behind the model.
   *
   * The bands are three tubes about one circle: the ink's outer edge is
   * `HANDLE_RING_PX`, its centre line half a shaft inside, and each band grows
   * by `grow` on both sides. The hit tube is a fourth, `HANDLE_HIT_PX` across.
   */
  function buildRings(three, materials) {
    const middle = HANDLE_RING_PX - RING_SHAFT_PX / 2;
    const bands = BANDS.map(({ grow }) => new three.TorusGeometry(
      middle, RING_SHAFT_PX / 2 + grow, SIDES, STEPS));
    const target = new three.TorusGeometry(middle, HANDLE_HIT_PX / 2, SIDES,
                                           STEPS);
    turns = TURNS.map((turn) => {
      const node = new three.Object3D();
      node.quaternion.setFromRotationMatrix(new three.Matrix4().makeBasis(
        new three.Vector3(...turn.u), new three.Vector3(...turn.v),
        new three.Vector3(...turn.axis)));
      BANDS.forEach(({ order }, at) => {
        const mesh = new three.Mesh(bands[at], materials[at]);
        mesh.renderOrder = order;
        mesh.raycast = NO_HIT;
        node.add(mesh);
      });
      // `visible = false`, like the arrow's target: hit and never drawn.
      //
      // The ring's own visibility is checked here because no raycaster consults
      // it: `place` hides a ring seen edge-on via `node.visible`, and
      // `scene3d.js` casts its own ray for the CURSOR. Without this the canvas
      // would show `grab` over a hidden ring.
      const hit = new three.Mesh(target, materials[2]);
      hit.visible = false;
      hit.raycast = function answer(caster, found) {
        if (node.visible) three.Mesh.prototype.raycast.call(this, caster, found);
      };
      node.add(hit);
      group.add(node);
      const held = { ...turn, node };
      grabs.set(hit, held);
      return held;
    });
  }

  /**
   * The pose a live turn is drawn in: the pose the group stood at when the
   * press landed, turned by the rotation the plane has taken since.
   *
   * Written into `posed` and read back, so the frames after the gesture draw
   * the same composition — `place` while the hand is down, `finish` at the end
   * (the last event of a turn need not be followed by a frame).
   */
  function compose(turning) {
    const ax = turning.frame.axis;
    spin.setFromAxisAngle(scratch.set(ax[0], ax[1], ax[2]),
                          turning.degrees / DEGREES_PER_RADIAN);
    return posed.multiplyQuaternions(spin, turning.pose);
  }

  /** One vector of a ring's own frame, taken into the world by the orientation
   *  `place` has just written on the group — which is the only thing either
   *  ring is oriented by. */
  const worldOf = (v) => scratch.set(v[0], v[1], v[2])
    .applyQuaternion(group.quaternion).toArray();

  /**
   * Where the plane meets the face the reader clicked, in world coordinates.
   *
   * Without the render sliver — see `sectionBias` in section.js. This is in the
   * same frame as `state.cutOffset` and `captureSection`.
   *
   * Read off the plane every frame, not from `state.cutOffset`: that is written
   * only by `reportCut` at the release, so an anchor taken from it would lag
   * the plane during a drag of this arrow and then jump. `sectionOffset`
   * measures the plane itself, so the arrow stays under the cursor.
   */
  const anchor = () => {
    const seed = vp.sectionSeed;
    const offset = sectionOffset(vp);
    return [seed.point[0] + seed.normal[0] * offset,
            seed.point[1] + seed.normal[1] * offset,
            seed.point[2] + seed.normal[2] * offset];
  };

  /** Whether there is a cut to put a handle on at all.
   *
 * Only about the cut: an unmeasurable camera or an unreadable seed are answers
 * about one frame (a scene mid-swap), handled in `place`. `scene3d.js` asks
 * this before it reaches into the library at all.
   */
  function wanted() {
    return !!(vp.sectionSeed && vp.state.cut);
  }

  /**
   * Stand the arrow on the plane, or say there is nothing to stand.
   *
   * Along the seed's normal, not the plane's: they differ only in sign
   * (`placeSectionPlane` turns the seed towards the camera; a flip turns the
   * plane over), and the arrow is symmetric, so this avoids a second library
   * call that can fail.
   *
   * `finite3` catches NaN and Infinity (a plane read mid-swap, an unmeasurable
   * camera) but not a zero vector. `setFromUnitVectors` needs a unit vector, and
   * the seed's normal is one: `placeSectionPlane` and `restoreSection`, its
   * only writers, run `unit3` first (section.js states the requirement).
   */
  function place(root, g) {
    const seed = vp.sectionSeed;
    if (!seed || !finite3(seed.normal)) return false;
    const at = anchor();
    if (!finite3(at)) return false;
    root.position.set(at[0], at[1], at[2]);
    // The ring the hand is on stays under the hand, which is why a turn's pose
    // is COMPOSED rather than derived from the normal. `setFromUnitVectors`
    // picks the shortest rotation and holds no twist about the normal, so a
    // per-frame re-derivation swings the held ring away — on a normal along
    // world +X, a 90 degree drag carries it edge-on and off screen.
    //
    // So a turn composes the pose at the press with exactly the rotation applied
    // to the plane since. Local +Y lands on the new normal either way, and the
    // twist stays what the reader grabbed. It uses the snapped angle, not
    // `swept`, so rings and plane move as one.
    const turning = drag && drag.turn;
    if (turning) {
      root.quaternion.copy(compose(turning));
    } else {
      aim.set(seed.normal[0], seed.normal[1], seed.normal[2]);
      // The pose the last turn left, while it still stands local +Y on the
      // seed's normal. Self-clearing: a slide keeps the normal, so the pose
      // survives; a cut on another face fails the test and is derived afresh.
      scratch.copy(up).applyQuaternion(posed);
      if (Math.abs(scratch.x - aim.x) < SAME_DIR
          && Math.abs(scratch.y - aim.y) < SAME_DIR
          && Math.abs(scratch.z - aim.z) < SAME_DIR) {
        root.quaternion.copy(posed);
      } else {
        root.quaternion.setFromUnitVectors(up, aim);
      }
    }
    // A ring seen edge-on is hidden rather than flattened (`RING_MIN_PX`): a
    // control the reader sees but cannot aim at is worse than none. The minor
    // semi-axis of the ring is `HANDLE_RING_PX * |axis . view|`, and the floor
    // is above the 9 px half-width of the hit tube, under which the ring
    // becomes a sliver taking presses meant for the arrow.
    //
    // An unmeasurable camera hides the rings and keeps the arrow, which needs
    // no basis.
    const basis = cameraBasis(vp.viewer, g);
    for (const turn of turns) {
      turn.node.visible = !!basis
        && Math.abs(dot3(worldOf(turn.axis), basis.view)) * HANDLE_RING_PX
          >= RING_MIN_PX;
    }
    return true;
  }

/** The window listeners this gesture is followed with (see `drag.js`). */
  const watch = watchDrag({ onMove, onUp, onCancel });

  /** Let go of the gesture, wherever it ended. */
  const finish = () => {
    // Keep the pose the hand let go at for the following frames; every ending
    // comes through here.
    if (drag && drag.turn) compose(drag.turn);
    drag = null;
    watch.disarm();
    // The cursor goes back to answering the ray.
    widget.grabbed(false);
  };

  function onMove(event) {
    if (!drag) return;
    const g = internals(vp.viewer);
    if (!g) return;
    if (drag.turn) {
      drag.moved = true;
      turnPlane(g, event);
      return;
    }
    // Since the previous event, as `onMove` in tools.js counts it.
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.moved = true;
    dragSection(vp, g, drag.axis, dx, dy);
  }

  /**
   * One pointermove of a TURN: tip the plane to where the hand has carried the
   * ring, about the axis the press measured.
   *
   * Computed whole and then written once: the normal and point go into the
   * seed, and one `setClipNormal` (via `applySection`) carries both. Nothing
   * reaches the library until the arithmetic is known good.
   *
   * The plane pivots about the anchor, not `seed.point`: with the plane slid
   * along its normal they differ, and pivoting about the seed would swing the
   * plane away from the hand and change the printed depth. So the point is moved
   * to keep the anchor fixed — `anchor()` read backwards.
   */
  function turnPlane(g, event) {
    const held = drag.turn;
    const theta = turnAngle(vp, g, held.frame, held.at, event);
    if (theta === null) return;
    // Unwrapped: `atan2` returns `(-pi, pi]`, so the step between events is
    // taken modulo a full turn into `[-pi, pi)` and accumulated; `swept` is the
    // angle the hand really travelled (rings.js does the same).
    const step = ((theta - held.theta + HALF_TURN) % (2 * HALF_TURN)
      + 2 * HALF_TURN) % (2 * HALF_TURN) - HALF_TURN;
    held.theta = theta;
    held.swept += step;
    // Whole degrees, as in rings.js: the number goes to an agent in a sentence.
    // Nothing drawn changes within one degree, so a repeat does nothing.
    const degrees = Math.round(held.swept * DEGREES_PER_RADIAN);
    if (degrees === held.degrees) return;
    held.degrees = degrees;
    // In the ring's own pair, where the normal at the press stood at `from`;
    // `u` and `v` are orthonormal, so the result is already unit. It still
    // goes through `unit3`, as section.js requires of every seed writer.
    const a = held.from + degrees / DEGREES_PER_RADIAN;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const normal = unit3([held.frame.u[0] * cos + held.frame.v[0] * sin,
                          held.frame.u[1] * cos + held.frame.v[1] * sin,
                          held.frame.u[2] * cos + held.frame.v[2] * sin]);
    if (!finite3(normal)) return;
    const seed = vp.sectionSeed;
    if (!seed) return;
    const offset = sectionOffset(vp);
    seed.normal = normal;
    seed.point = [held.at[0] - normal[0] * offset,
                  held.at[1] - normal[1] * offset,
                  held.at[2] - normal[2] * offset];
    // The plane is no longer on the face it was placed from, and the interface
    // heads the cut with that face's name. Written on the seed, not the report,
    // so a later slide does not start naming the face again.
    seed.turned = true;
    applySection(vp, g);
  }

  function onUp() {
    const held = drag;
    finish();
    // Only if it actually moved, like the canvas drag (`tools.js`,
    // `if (p.moved)`): `reportCut` emits `hmr:face`, which makes the interface
    // disarm the current tool (`tool: null`, HammerolaViewer.jsx), so a bare
    // click would drop the measure or comment tool.
    //
    // Once, at the end, through the same function as the canvas drag, so
    // `state.cutOffset` and the printed number keep one writer.
    if (held && held.moved) reportCut(vp);
  }

  function onCancel() {
    finish();
  }

  /**
   * A press the ray found on one of the RINGS: the axis, the anchor and the
   * angle the hand started at, measured once and held for the whole gesture.
   *
   * Measured in the world, not the group's frame: that frame swings as the
   * normal moves (`setFromUnitVectors` holds no twist), so an axis re-read per
   * event would drift.
   */
  function takeTurn(event, g, turn) {
    const at = anchor();
    if (!finite3(at)) return false;
    const frame = { axis: worldOf(turn.axis), u: worldOf(turn.u),
                    v: worldOf(turn.v) };
    const theta = turnAngle(vp, g, frame, at, event);
    if (theta === null) return false;
    const n = vp.sectionSeed.normal;
    drag = {
      turn: {
        at,
        frame,
        theta,
        swept: 0,
        degrees: 0,
        // The pose the rings were drawn in at the press; `place` turns it for
        // the length of the gesture. `frame` above was read out of it.
        pose: group.quaternion.clone(),
        // Where the normal already stands on this ring's circle (0 or a quarter
        // turn by construction, `TURNS`), read so both rings share the maths.
        from: Math.atan2(dot3(n, frame.v), dot3(n, frame.u)),
      },
      moved: false,
    };
    watch.arm();
    widget.grabbed(true);
    return true;
  }

  /**
   * A press the ray found on the grip. True when the grip has taken it, which
   * is what `scene3d.js` suppresses the event on.
   *
   * Which gesture it is depends on the mesh the ray landed on, which is why
   * every drawn ring band answers `NO_HIT`.
   *
   * Primary button only: the press is taken off the canvas, so anything refused
   * goes on to what is behind — a right-drag pans, a right-click opens the part
   * menu, a middle click goes to the trackball. Answering `false` rather than
   * swallowing is what allows that (see `onDown` in scene3d.js).
   */
  function onDown(event, g, at) {
    if (event.button !== 0) return false;
    // Conclude a previous gesture first, as `onDown` in tools.js does: a second
    // pointer would otherwise overwrite the anchor and the first finger's next
    // move would jump.
    finish();
    const turn = grabs.get(at.object);
    if (turn) return takeTurn(event, g, turn);
    // Measured once and held for the gesture, as in tools.js: the camera cannot
    // move under a press this widget owns.
    //
    // The drag is a pixel delta and the plane moves in world units;
    // `sectionGripAxis` says what a pixel is worth along the normal, including
    // the fallback for looking straight down it (the plane drags vertically).
    const axis = sectionGripAxis(vp.viewer, g, anchor());
    if (!axis) return false;
    drag = { axis, x: event.clientX, y: event.clientY, moved: false };
    watch.arm();
    // The canvas wears `grabbing` until `finish`: the hand leaves the 18 px
    // cylinder within a few pixels.
    widget.grabbed(true);
    return true;
  }

  /** End a drag the reader has not let go of, because the scene is going away.
   *
   * The twin of `vp.endGesture`: what a live press holds (the plane's screen
   * axis, or a ring's world axis) was measured against a scene being replaced,
   * and the release never comes.
   *
   * It concludes rather than abandons. The interface's wait for the hand to
   * leave the model has a deadline and listens on `vp.box`, which does not see
   * this window-level press, so a swap can arrive mid-drag. Without reporting,
   * `restoreSection` would subtract a stale `state.cutOffset` from a point the
   * drag already moved.
   */
  const endDrag = () => {
    const held = drag;
    finish();
    if (held && held.moved) reportCut(vp);
  };

  return {
    refresh: widget.refresh,
    // The two halves of the lifecycle, passed straight through to the one caller
    // that knows when a scene is replaced: `show()` in element.js.
    attach: widget.attach,
    detach: widget.detach,
    endDrag,
    destroy() {
      // A viewport unmounted mid-drag would otherwise leave three capture-phase
      // listeners on the window holding a scene that is gone.
      finish();
      widget.destroy();
    },
  };
}
