// The grip on the section plane: a double-headed arrow standing on the cut, at
// the point where the plane meets the face that was clicked, and dragged to
// slide the plane along its own normal.
//
// WHY IT EXISTS. The drag has worked from the start — tools.js, the `cut` branch
// of `onMove` — and nothing on screen ever said so, so the only readers who
// found it were the ones who had been told. A gesture with no handle is a
// gesture that is not there for most people.
//
// AN OBJECT IN THE SCENE AND NOT A DIV OVER IT, which is what makes the arrow
// point along the plane's normal rather than along a picture of it. Drawn flat,
// every question the widget asked was a question about the SCREEN — which way
// the normal projects, how much of it survives the projection, what to do in the
// zone where the answer collapses — and each of those had to be computed,
// guarded and floored. A mesh lying on the plane is simply turned to the normal
// once and projected by the camera like everything else, so all of that is gone
// from this file. `scene3d.js` carries the half that is shared.
//
// A MODULE OF ITS OWN AND NOT PART OF overlay.js, though the four callbacks are
// the same shape. Two things differ and both are load-bearing: what this draws
// comes from the SECTION rather than from `state.pins`, and it carries a live
// drag, which the overlay's pins — a press, a click, nothing in between — do
// not.
//
// AND IT TURNS THE PLANE AS WELL AS SLIDING IT, out of two rings standing round
// the same arrow (issue #90). They are CHILDREN OF THE ARROW'S OWN GROUP rather
// than a fourth widget: they share its anchor, its `wanted`, its lifecycle, its
// paint band and its one press listener, and Fusion's section manipulator is
// likewise one thing carrying an arrow and two rotation handles. What a fourth
// widget would have cost is in `scene3d.js` — another band, another rung of the
// press-order ladder, and three more pins in tests/test_ui_source.py.

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

/** The arrow's ink: the grip's own dark, the same number the DOM layer drew it
 *  in, as a hex the material takes rather than a CSS string. One colour for both
 *  themes, which is what every widget over this canvas does — the canvas is
 *  white or near-black depending on the reader's answer (`readTheme` in
 *  ui/src/store.js), so a widget picks a colour that stands on either. */
const INK = 0x2f353d;

/** The casing under it: white, the same ink the rotation handles stand their
 *  discs on (`CASING` in rings.js). It is what makes ONE dark colour honest on
 *  a canvas that is white on one theme and near-black on the other. */
const CASING = 0xffffff;

/** The dark rim outside that casing, on the rings alone — `RIM` in gizmo.js and
 *  in rings.js, the same three bytes for the same job.
 *
 * WHY THE RINGS CARRY ONE AND THE ARROW DOES NOT. The casing is what holds ink
 * against dark geometry and the rim is what holds the CASING against the light
 * canvas, so what wants a rim is a wide band of white — a 2 px shaft with 2 px
 * of casing is nearly all edge already, and a ring is that same band bent into
 * a curve that crosses itself and the arrow. It is the construction every other
 * piece of this scene is drawn with (`BANDS` in rings.js, `GIZMO_RIM_PX`).
 */
const RIM = 0x14181c;

/** How round the shaft and the heads are.
 *
 * Twelve is where a cylinder two pixels across stops reading as a polygon at
 * any angle, and it is the tube of a ring as well: the same 2 px, the same
 * argument, rings.js's own number for it.
 */
const SIDES = 12;

/** How many steps a ring's circle is drawn in. rings.js's number, where it is
 *  worked out for a radius two and a half times this one: at sixty-four a
 *  circle of `HANDLE_RING_PX` stands a twentieth of a pixel inside the true
 *  curve at the middle of each step. */
const STEPS = 64;

/** Half a turn, in radians — the wrap `turnPlane` unwinds a step across. */
const HALF_TURN = Math.PI;

const DEGREES_PER_RADIAN = 180 / Math.PI;

/** How far apart two directions may stand, component by component, and still be
 *  the same direction — the tolerance a pose is kept across a frame on.
 *
 * The two sides of that comparison are one direction computed along two routes:
 * a quaternion turning the old normal about the ring's axis, and `turnPlane`
 * rebuilding it out of a cosine and a sine. They agree to the last bits of a
 * double, so anything above rounding is a DIFFERENT normal — another cut, on
 * another face — rather than the same one measured twice.
 */
const SAME_DIR = 1e-6;

/** What a piece that is only ever LOOKED at answers a ray with: nothing.
 *
 * rings.js's own, and it is what tells the two gestures apart here. three tests
 * an object's LAYERS and never its visibility, so every drawn band of a ring is
 * a target in its own right — and a press the ray landed on one of those is a
 * press `onDown` would read as a press on the ARROW, since what it classifies
 * by is the mesh it was handed. One hit mesh per ring, and the arrow's own
 * cylinder, are the whole of what answers a ray in this group.
 */
const NO_HIT = () => {};

/** The two rings, in the group's OWN frame — which is the whole of why there is
 *  no basis to derive anywhere in this file.
 *
 * Every pose `place` writes stands the group so that local +Y IS the plane's
 * normal. A ring that tilts that normal about local +X therefore
 * lies in local YZ, and one that tilts it about local +Z lies in local XY:
 * written as plain children, both follow the plane for free.
 *
 * `u x v = axis` IN BOTH, which is where the SIGN of this gesture is settled,
 * once, for the drawing and the arithmetic alike. three sweeps a torus from +X
 * towards +Y about +Z, so a node turned by `makeBasis(u, v, axis)` draws its
 * circle the right-handed way about `axis` — and `turnAngle` reads its `atan2`
 * in that very pair. Taken the other way round every ring would tip the plane
 * backwards, and nothing on screen would say so.
 *
 * AND THE NORMAL IS ONE OF THE TWO in each: local +Y is `u` of the first and
 * `v` of the second. That is what lets a turned normal be `u cos a + v sin a`
 * — a unit vector by construction, which is the one thing section.js requires
 * of anything that writes the seed.
 */
const TURNS = [
  { u: [0, 1, 0], v: [0, 0, 1], axis: [1, 0, 0] },
  { u: [1, 0, 0], v: [0, 1, 0], axis: [0, 0, 1] },
];

/** The three bands a ring is drawn in, OUTERMOST FIRST and in the order they
 *  are painted — the dark rim under the white casing under the ink, which is
 *  `grow`'s construction on the arrow and `BANDS`' in rings.js.
 *
 * ALL THREE UNDER THE ARROW, which is what the orders say and is not tidiness:
 * a ring seen at an angle projects an ellipse whose narrow direction can be
 * shorter than the arrow's own reach, so the two really do cross on screen.
 * With no depth test the paint order IS the stacking, and the arrow is the
 * control the rings are drawn around.
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
 * `ringAngle` in rings.js with the one difference that makes it a function of
 * its own: there a ring's axis is a WORLD axis and its plane is
 * `x[k] = centre[k]`, here it is whatever the cut normal leaves it, so the
 * plane has to be met the general way and the pair the angle is read in comes
 * out of `frame` rather than out of a cyclic index. Everything else is that
 * function's, refusal by refusal — a ray lying IN the plane meets it nowhere,
 * and a NaN anywhere in the camera lands here as one too.
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

  // The three vectors the orientation is computed with, kept rather than minted
  // per frame: this runs once per frame the library draws, which during an orbit
  // is every frame there is. Built with the group, because the namespace they
  // come from arrives with it.
  let up = null;
  let aim = null;
  let scratch = null;
  // And the two the turn is drawn with: `spin` is the rotation a live turn has
  // applied so far, and `posed` the composition of it with the pose the group
  // held at the press (`place`) — the last one written, which OUTLIVES the
  // gesture. Without it the frame after the release would derive the pose from
  // the normal alone, and `setFromUnitVectors` is free to pick any twist about
  // that normal: the pair of rings would snap round the arrow by up to 45
  // degrees at the exact moment the hand came off, and the ring the reader had
  // hold of can fall under `RING_MIN_PX` and go off the screen with it.
  let spin = null;
  let posed = null;

  // The group itself, which the rings need and the arrow does not: their frames
  // are LOCAL and every question about one is asked in the world, so the
  // orientation `place` writes is what carries them across.
  let group = null;

  /** One per ring: the node its circle lies in, and that ring's own frame. */
  let turns = [];

  /** Which ring each hit mesh belongs to — the one thing that tells a press
   *  meant for the rings from a press meant for the arrow. */
  const grabs = new Map();

  /**
   * Which of the two gestures a press belongs to when the ray finds both,
   * LOWEST FIRST — the arrow over the rings.
   *
   * NOT THE NEAREST HIT, which is what `scene3d.js` answers with when no widget
   * ranks: `BANDS` paints every band of a ring UNDER the arrow, and a ring seen
   * near edge-on projects an ellipse whose hit tube reaches in over the arrow's
   * own body — so on the near side of that crossing the ray meets the ring
   * first while what is DRAWN there is the arrow. With no depth test the paint
   * order is the stacking, so what the reader can see has to be what takes the
   * press. `gizmo.js` states the rule where it keeps its own `RANK`.
   *
   * ASKED OF THE RINGS AND NOT OF THE ARROW, which is the one arrangement that
   * cannot go stale. The arrow answers a ray from four meshes — the fat hit
   * cylinder and the three drawn ones the ray is not stopped from meeting —
   * and naming the cylinder alone would leave the ink ranked level with a ring,
   * correct today only because the ink lies wholly inside that cylinder. Asked
   * the other way there is nothing to keep true: `grabs` holds every ring hit
   * mesh there is, and everything else in this group belongs to the arrow.
   *
   * A DECLARATION AND NOT A `const`, because `createScene3D` is handed it at
   * the head of this function, where an arrow assigned below would still be in
   * its dead zone — the same reason `wanted`, `build` and `place` are
   * declarations.
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
   * THREE MATERIALS AND NOT FIFTEEN, because the widget is three pieces of
   * colour rather than fifteen shapes: every mesh of the ink shares one, every
   * mesh of the casing shares the other, and the rings' rim the third, so the
   * renderer sorts three programs and there are three things to keep in step.
   * Nothing here ever tints one head and not the other — and the rings wear the
   * grip's own ink LITERALLY, the same material object, which is what keeps
   * them from ever becoming a second palette standing on one cut.
   *
   * THE HEADS ARE AS LONG AS THEY ARE WIDE, which is `HANDLE_HEAD_PX`'s whole
   * argument, and they sit at the ENDS: half the arrow's length minus half a
   * head, so the outermost point of each is exactly `HANDLE_PX / 2` from the
   * anchor. That is a promise about the INK: the casing stands `HANDLE_CASE_PX`
   * outside it on every side, tips included, exactly as the rotation handles'
   * rim stands outside `RING_PX`.
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
    // THE ARROW IS DRAWN TWICE, and the order is the whole of the contrast.
    // `grow` is 0 for the ink and `HANDLE_CASE_PX` for the copy under it, whose
    // `renderOrder` of -1 puts it first WITHIN this group -- three carries a
    // group's own `renderOrder` down as the group order and sorts the subtree
    // inside it, so the two numbers do not fight. With no depth test, first
    // drawn is underneath, and a white body two pixels proud of a dark one is a
    // rim. `options.js` says why a rim rather than a shadow.
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
    // THE TARGET IS FAT AND THE INK IS THIN, which is the same requirement the
    // DOM box carried and the reason `HANDLE_HIT_PX` survives the move: a hand
    // cannot reliably hit a 2 px shaft. A cylinder of that diameter around the
    // whole arrow is what the ray really meets.
    //
    // `visible = false` AND NOT a transparent material: three's raycaster tests
    // an object's LAYERS and never its visibility (`intersect()` in three.core),
    // so this is a mesh that is hit and never drawn — no second draw call, no
    // blend, nothing for the renderer to sort. `scene3d.js` leans on the same
    // reading one storey up, where it has to check `group.visible` by hand.
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
   * THE GEOMETRIES ARE SHARED AND SO ARE THE MATERIALS, which is rings.js's
   * arrangement with the one thing that made it keep a material per ring taken
   * away: nothing here lightens under a cursor. What tells the two apart is the
   * frame of the node they hang under, and nothing else.
   *
   * A NESTED `Object3D` AND NEVER A `Group`: three re-reads `renderOrder` as
   * the group order at every `Group` it walks into, so a group here would drop
   * the rings out of the band `scene3d.js` put this whole widget in and back
   * behind the model.
   *
   * THE BANDS ARE THREE TUBES ABOUT ONE CIRCLE — the ink's outer edge is
   * `HANDLE_RING_PX`, so its centre line is half a shaft inside that and each
   * band grows by `grow` on both sides of that same line. The hit tube is a
   * fourth about it, `HANDLE_HIT_PX` across for the arrow's own reason: a hand
   * cannot reliably aim at a 2 px curve.
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
      // `visible = false` AND NOT a transparent material, exactly as the
      // arrow's own target: a mesh that is hit and never drawn costs the
      // renderer nothing at all.
      //
      // AND THE RING'S OWN FLAG IS ASKED ON THE MESH, one level up, because no
      // raycaster consults it either: `place` takes a ring seen edge-on off the
      // screen by clearing `node.visible`, and `scene3d.js` casts a ray of its
      // own for the CURSOR that knows nothing of this widget's structure. A
      // floor applied anywhere but here would leave the canvas wearing `grab`
      // over a ring that is not drawn, promising a grab the press then refuses.
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
   * INTO `posed` AND THEN READ BACK, so the one composition this file makes is
   * also the one the frames AFTER the gesture are drawn from — `place` for as
   * long as the hand is down, and `finish` once at the end of it, because the
   * last event of a turn need not be followed by a frame that draws it.
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
   * WITHOUT THE RENDER SLIVER — see `sectionBias` in section.js, which is the
   * one function that adds it and says why every reader takes it back out. This
   * is a reading of where the plane stands, so it is in the same frame as
   * `state.cutOffset` and `captureSection`, not in the library's.
   *
   * READ OFF THE PLANE EVERY FRAME, NOT OUT OF `state.cutOffset`, and the
   * difference is the whole of whether this is a handle at all. The two agree
   * everywhere except during a drag of this very arrow: `state.cutOffset` is
   * written once, by `reportCut` at the RELEASE, so an anchor taken from it
   * would sit still while the plane slid out from under the hand and then jump
   * to catch up when the hand came off. `sectionOffset` measures the plane
   * itself, so the arrow stays under the cursor — which is the one thing direct
   * manipulation has to get right.
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
   * THE OTHER WAYS THE GRIP LEAVES THE SCREEN ARE NOT IN HERE, on purpose: a
   * camera that cannot be measured and a seed that cannot be read are answers
   * about THIS FRAME, and a scene caught mid-swap has both again one render
   * later. This question is the one `scene3d.js` asks before it reaches into the
   * library at all, so it is about the cut and nothing else.
   */
  function wanted() {
    return !!(vp.sectionSeed && vp.state.cut);
  }

  /**
   * Stand the arrow on the plane, or say there is nothing to stand.
   *
   * ALONG THE SEED'S NORMAL AND NOT THE PLANE'S. The two are the same direction
   * up to a SIGN — `placeSectionPlane` turns the seed towards the camera and a
   * flip turns the plane in force over without moving it — and the arrow is
   * symmetric about its own middle, so the sign is invisible on screen. What
   * that buys is a reading the module already takes for the anchor, instead of a
   * second call into the library that can fail on its own.
   *
   * WHAT `finite3` IS AND IS NOT CHECKING, because the difference matters here.
   * It catches NaN and Infinity, which is what a plane read mid-swap or a camera
   * that cannot be measured produce, and `set` on a NaN leaves a group at no
   * position at all. It does NOT catch a zero vector — `math.js` says so in as
   * many words — and nothing here needs it to: `setFromUnitVectors` is the one
   * call that would care, and the normal it is handed was made a unit vector at
   * the seed: `placeSectionPlane` and `restoreSection` are the two functions
   * that write `vp.sectionSeed`, and both run `unit3` before they do — which
   * section.js states, together with the requirement on any third writer.
   */
  function place(root, g) {
    const seed = vp.sectionSeed;
    if (!seed || !finite3(seed.normal)) return false;
    const at = anchor();
    if (!finite3(at)) return false;
    root.position.set(at[0], at[1], at[2]);
    // AND THE RING THE HAND IS ON STAYS UNDER THE HAND, which is the whole of
    // why the pose is COMPOSED rather than derived from the normal it stands on.
    //
    // `setFromUnitVectors` picks the SHORTEST rotation onto the normal, and
    // nothing in it holds the twist about that normal: two normals a degree
    // apart can come back with frames that differ by far more than a degree
    // about their common axis. Re-derived per frame under a drag, the ring the
    // reader is holding therefore swings away from their finger by up to the
    // whole angle they have swept — measured on a normal along world +X, a 90
    // degree drag carries that ring edge-on and off the screen while the hand is
    // still on it. The PLANE is right throughout, because `takeTurn` reads the
    // axis once and holds it; it is the drawing that runs away.
    //
    // So a turn composes: the pose the group stood at when the press landed,
    // turned by exactly the rotation that has been applied to the plane since.
    // Local +Y lands on the new normal either way — the two are the same
    // rotation about the same axis — and the twist is pinned to what the reader
    // saw when they grabbed it. THE SNAPPED ANGLE and not `swept`, so the rings
    // and the plane move as one thing: half a degree of lag is a third of a
    // pixel at this radius, where a ring drawn ahead of the plane it turns is a
    // widget disagreeing with itself.
    const turning = drag && drag.turn;
    if (turning) {
      root.quaternion.copy(compose(turning));
    } else {
      aim.set(seed.normal[0], seed.normal[1], seed.normal[2]);
      // THE POSE THE LAST TURN LEFT, for as long as it still stands local +Y on
      // the normal the seed now carries. That test is what makes it
      // self-clearing rather than something to invalidate: a slide does not
      // touch the normal, so the pose survives one, and a cut placed on another
      // face fails it and is derived afresh with nothing anywhere having to
      // notice that the cut changed.
      scratch.copy(up).applyQuaternion(posed);
      if (Math.abs(scratch.x - aim.x) < SAME_DIR
          && Math.abs(scratch.y - aim.y) < SAME_DIR
          && Math.abs(scratch.z - aim.z) < SAME_DIR) {
        root.quaternion.copy(posed);
      } else {
        root.quaternion.setFromUnitVectors(up, aim);
      }
    }
    // A RING SEEN EDGE-ON IS GONE rather than flattened, which is `RING_MIN_PX`
    // saying about this widget what it says about the other: a control the
    // reader can see and cannot aim at is worse than no control, and turning
    // the model a little brings it back. The minor semi-axis of a circle of
    // `HANDLE_RING_PX` seen along `view` is that radius times `|axis . view|`,
    // and the floor is comfortably above the 9 px half-width of the hit tube —
    // under it the ring stops being a hoop and becomes a filled sliver taking
    // presses meant for the arrow inside it.
    //
    // A CAMERA THAT CANNOT BE MEASURED TAKES THE RINGS AND LEAVES THE ARROW,
    // which is the one thing this shares with nothing in rings.js: the arrow
    // needs no basis and has been drawn without one since before there were
    // rings, and a frame that hid the whole grip because `getCameraTarget` came
    // back unreadable would be taking away the gesture that still works.
    const basis = cameraBasis(vp.viewer, g);
    for (const turn of turns) {
      turn.node.visible = !!basis
        && Math.abs(dot3(worldOf(turn.axis), basis.view)) * HANDLE_RING_PX
          >= RING_MIN_PX;
    }
    return true;
  }

  /** The window listeners this gesture is followed with, which `drag.js` says
   *  why are on the window and in the capture phase. */
  const watch = watchDrag({ onMove, onUp, onCancel });

  /** Let go of the gesture, wherever it ended. */
  const finish = () => {
    // THE POSE THE HAND LET GO AT, kept for the frames that come after — every
    // ending there is comes through here, and the rings stay where the reader
    // left them whichever one it was.
    if (drag && drag.turn) compose(drag.turn);
    drag = null;
    watch.disarm();
    // The cursor goes back to answering the ray. Unconditional, because every
    // ending there is comes through here.
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
    // Since the PREVIOUS event, exactly as `onMove` in tools.js counts it: the
    // plane moves by what the hand did between two frames, not by where the
    // gesture started.
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
   * COMPUTED WHOLE AND THEN WRITTEN ONCE, which is issue #90's binding
   * constraint and is what the seed plus `applySection` already give: the
   * normal and the point go into the seed, and one `setClipNormal` carries both
   * the orientation and the slider that belongs with it. Nothing reaches the
   * library until the arithmetic is known good.
   *
   * AND THE PLANE PIVOTS ABOUT THE ANCHOR AND NOT ABOUT `seed.point`. With the
   * plane slid out along its normal the two are not the same place, and a pivot
   * about the seed would swing the plane away from the hand AND change the
   * depth the interface prints — for a gesture that never touched it. So the
   * point is MOVED to keep the anchor where it stands, which is exactly
   * `anchor()` read backwards.
   */
  function turnPlane(g, event) {
    const held = drag.turn;
    const theta = turnAngle(vp, g, held.frame, held.at, event);
    if (theta === null) return;
    // UNWRAPPED, because `atan2` comes back in `(-pi, pi]`: the step between two
    // events is taken modulo a full turn into `[-pi, pi)` and added up, so
    // `swept` is the angle the HAND really travelled and a hand carried across
    // the seam says nothing special. rings.js carries the same two lines.
    const step = ((theta - held.theta + HALF_TURN) % (2 * HALF_TURN)
      + 2 * HALF_TURN) % (2 * HALF_TURN) - HALF_TURN;
    held.theta = theta;
    held.swept += step;
    // WHOLE DEGREES, for the reason rings.js gives at its own snap: the number
    // travels to an agent in a sentence, and 31.7413 degrees claims a precision
    // no hand has. Nothing drawn moves between two whole degrees either — the
    // rings are fixed in the widget's own frame and the arrow follows the
    // normal — so a step that lands on the same degree has nothing to do at all.
    const degrees = Math.round(held.swept * DEGREES_PER_RADIAN);
    if (degrees === held.degrees) return;
    held.degrees = degrees;
    // IN THE RING'S OWN PAIR, where the normal at the press already stood at
    // `from`: a turn is one angle further round that circle, and `u` and `v`
    // are orthonormal, so what comes out is a unit vector without being made
    // one. `unit3` is nonetheless what the seed is written through, because
    // that is what section.js requires of everything that writes it and the
    // cost of being wrong there is a plane standing metres off the face.
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
    // AND THE PLANE IS NO LONGER ON THE FACE IT WAS PLACED FROM, which the
    // interface has to be told because it heads the cut with that face's name.
    // Written on the SEED rather than carried out on the report: a later SLIDE
    // reports through the same door and would otherwise start naming the face
    // again, and the fact is about the plane rather than about one gesture.
    seed.turned = true;
    applySection(vp, g);
  }

  function onUp() {
    const held = drag;
    finish();
    // ONLY IF IT ACTUALLY MOVED, which is the same rule the canvas drag applies
    // (`tools.js`, `if (p.moved)`) and it is not tidiness. `reportCut` emits
    // `hmr:face`, and the interface answers that by disarming whatever tool is
    // up (`tool: null`, HammerolaViewer.jsx) — so a bare click on the arrow
    // would silently put down the measure or comment tool the reader was
    // holding.
    //
    // Once, at the end: the drag moves the library's slider sixty times a second
    // and the interface would re-render with it. Through the same function the
    // canvas drag ends in, so `state.cutOffset` and the number the interface
    // prints keep their one writer.
    if (held && held.moved) reportCut(vp);
  }

  function onCancel() {
    finish();
  }

  /**
   * A press the ray found on one of the RINGS: the axis, the anchor and the
   * angle the hand started at, measured once and held for the whole gesture.
   *
   * IN THE WORLD AND NOT IN THE GROUP'S FRAME, which is the one thing about
   * this that had to be deliberate. The frame those three are read out of swings
   * as the normal moves — `setFromUnitVectors` picks the shortest rotation onto
   * the normal and nothing holds its twist about that normal fixed — so an axis
   * re-read on every event would be a different axis by the end of the drag, and
   * the plane would drift out from under the hand.
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
        // THE POSE THE RINGS WERE DRAWN IN WHEN THE HAND LANDED, which `place`
        // turns rather than recomputing for as long as this gesture runs — and
        // which is therefore the same reading `frame` above was taken out of.
        pose: group.quaternion.clone(),
        // WHERE THE NORMAL ALREADY STANDS on this ring's own circle, which is 0
        // or a quarter turn by construction (`TURNS`) and is read rather than
        // written down so the two rings are one piece of arithmetic.
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
   * WHICH OF THE TWO GESTURES IT IS, DECIDED BY THE MESH THE RAY LANDED ON, and
   * that is why every drawn piece of a ring answers `NO_HIT`: what this reads is
   * the hit it was handed, so a band of ink taking a ray would be a press on a
   * ring read as a press on the arrow.
   *
   * THE PRIMARY BUTTON AND NOTHING ELSE. The press is taken off the CANVAS now,
   * so what this refuses really does go on to everything behind it: a right-drag
   * the reader meant as a pan is a pan, a right-click is the part menu over the
   * face the arrow is standing on, and a middle click is whatever the trackball
   * makes of it. Answering `false` rather than swallowing the event is the whole
   * of that — see `onDown` in scene3d.js.
   */
  function onDown(event, g, at) {
    if (event.button !== 0) return false;
    // A previous gesture is concluded before a new one begins, as `onDown` in
    // tools.js does it: a second pointer landing on the same arrow would
    // otherwise overwrite the anchor with its own position, and the first
    // finger's next move would read as a jump the width of the gap between them.
    finish();
    const turn = grabs.get(at.object);
    if (turn) return takeTurn(event, g, turn);
    // MEASURED ONCE AND HELD FOR THE WHOLE GESTURE, exactly as tools.js does it:
    // the camera cannot move under a press this one owns, and re-measuring per
    // frame would let the plane drift away from the hand.
    //
    // THE SCREEN AXIS SURVIVES THE MOVE INTO THE SCENE, and it is the one thing
    // that had to: the drag is a PIXEL delta and the plane moves in world units,
    // so something has to say what a pixel is worth along the normal.
    // `sectionGripAxis` is that, degenerate-zone fallback and all — a reader
    // looking straight down the normal still drags the plane vertically, which
    // is the gesture that was there before this widget was an object.
    const axis = sectionGripAxis(vp.viewer, g, anchor());
    if (!axis) return false;
    drag = { axis, x: event.clientX, y: event.clientY, moved: false };
    watch.arm();
    // From here the canvas wears `grabbing` until `finish`, whatever the ray
    // says: the hand carries the pointer off a 18 px cylinder within a few
    // pixels of travel, and a cursor that went back to the default there would
    // be saying the drag had ended.
    widget.grabbed(true);
    return true;
  }

  /** End a drag the reader has not let go of, because the scene is going away.
   *
   * THE TWIN OF `vp.endGesture`, and it exists for the same failure that one was
   * written for: everything a live press holds — the plane's screen axis, or a
   * ring's own axis in the world — was measured against a scene that is being
   * replaced, and the release that would have concluded the gesture never comes.
   *
   * IT CONCLUDES RATHER THAN ABANDONS. A swap can arrive mid-drag: the interface
   * waits for the hand to come off the model but gives up after a deadline, and
   * that wait does not see this press at all — the idle clock listens on
   * `vp.box`, and this press is taken in a window listener of the widget's own.
   * So without this, `restoreSection` would subtract a `state.cutOffset` from
   * before the drag out of a point the drag had already moved, and the seed
   * would come back off the face that was clicked, with the interface printing a
   * depth the plane has not been at since.
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
