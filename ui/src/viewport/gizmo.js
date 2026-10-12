// The move tool's manipulator, less its rotation handles: an ORIGIN DOT at the
// selected part's centre, THREE AXIS ARROWS out of it along world +X, +Y and
// +Z, and THREE PLANE QUADS, one lying in each world plane. An arrow slides the
// part along THAT AXIS ONLY and a quad slides it in THAT PLANE — two axes at
// once with the third held. The dot is DRAWN AND NOT PRESSED: it marks the
// origin the six of them are measured from and answers no ray at all.
//
// ONE WIDGET, TWO FILES, ONE TOOL. The rotation handles are the fourth piece of
// the same manipulator and live in rings.js, under the same `move` tool (like
// Fusion's triad, `TriadCommandInput`: origin, arrows, quads and rotation
// handles at once). The files stay separate because a press means something
// different (an angle about an axis, not a distance along one) and the
// gestures end differently.
//
// Every widget reads its press off the CANVAS, so several could answer one
// press; the paint band settles it, since `joinPresses` in scene3d.js asks the
// topmost band first. `GIZMO_ORDER` puts this widget on top.
//
// Constrained handles exist because a free drag under an ortho camera can
// change all three axes at once, and sentences like "three millimetres further
// out" name a direction (Blender's widget, which readers already know). There
// is no free drag (tools.js): a press anywhere but on a piece means what it
// means with no tool up, so an armed tool does not cost the orbit.
//
// Objects in the scene, not divs over it: a cylinder along a world axis is
// projected by the camera like everything else, so what remains of the
// screen-space maths is two components of `cameraBasis().view` (`scene3d.js`
// carries the shared half).
//
// Each constrained delta is the hand's unconstrained world displacement put
// back on the piece's geometry: an arrow takes the NEAREST POINT of its line, a
// quad the point where the ray through the cursor MEETS its plane (a plane and
// a ray meet; a line and a ray do not, so only the quad can keep the part
// exactly under the pointer). Both then use `niceStep` and `snap` (tools.js),
// `movePart`/`nudgePart`, and the record and report in gesture.js, so arrow,
// quad and disc moves reach the proposal document as the same kind of sentence.

import { cameraBasis, ndcAt, ndcOffset } from "./camera.js";
import { travelled, watchDrag } from "./drag.js";
import { EVENT_MOVED, EVENT_PROPOSALMOVE } from "./events.js";
import { gestureRecord, reportGesture } from "./gesture.js";
import { internals } from "./internals.js";
import { dot3, sineFromCos } from "./math.js";
import {
  grabbable, groupHome, movePart, nudgePart, partCentre,
} from "./parts.js";
import { GIZMO_ORDER, createScene3D, widgetMaterial } from "./scene3d.js";
import { niceStep, snap } from "./tools.js";
import {
  GIZMO_CASE_PX, GIZMO_DOT_PX, GIZMO_HEAD_PX, GIZMO_HIT_PX, GIZMO_MIN_SCALE,
  GIZMO_PLANE_GAP_PX, GIZMO_PLANE_PX, GIZMO_PX, GIZMO_RIM_PX, GIZMO_SHAFT_PX,
} from "./options.js";

/** The three axes, in the order they are drawn and in the colours everything
 *  that draws an axis triad uses.
 *
 * Red, green, blue for X, Y, Z is the convention every CAD tool uses.
 * `rings.js` carries the same hexes and `rings.test.js` pins that they agree.
 */
const AXES = [
  { world: [1, 0, 0], ink: 0xc93a31 },
  { world: [0, 1, 0], ink: 0x2e8b40 },
  { world: [0, 0, 1], ink: 0x2d66c7 },
];

/** The two inks the CONSTRUCTION is made of, which are not a palette.
 *
 * The same pair as `rings.js` (see `RING_CASE_PX`): a light casing inside a
 * dark rim keeps a red mark legible on a red part over either canvas. Every
 * piece of this widget wears it.
 */
const CASING = 0xffffff;
const RIM = 0x14181c;

/** The three world planes, as the index of the axis each is NORMAL TO.
 *
 * That is also its colour: the XY quad is blue because Z is the axis it holds
 * still, as in every tool that draws plane handles.
 *
 * The two axes it lies in are the other two, taken cyclically as `rings.js`
 * takes a ring's pair; the order does not matter for a quad.
 */
const spanOf = (k) => [(k + 1) % 3, (k + 2) % 3];

/** The three bands every piece of this widget is drawn in, OUTERMOST FIRST, and
 *  the order they are painted in — the dark rim under the white casing under
 *  the ink, which is `BANDS` in rings.js and `grow` in handle.js.
 *
 * Two sequences because a body and a flat shape grow opposite ways: an arrow's
 * bands are three arrows about one axis, each `grow` further out; a quad's and
 * the dot's are filled shapes sharing an outer edge, each `sink` inside the
 * one before.
 *
 * `colour: null` is the piece's own ink.
 */
const BANDS = [
  { colour: RIM, grow: GIZMO_CASE_PX + GIZMO_RIM_PX, sink: 0 },
  { colour: CASING, grow: GIZMO_CASE_PX, sink: GIZMO_RIM_PX },
  { colour: null, grow: 0, sink: GIZMO_RIM_PX + GIZMO_CASE_PX },
];

/** How round a shaft and a head are — handle.js's number for the same 2 px
 *  width. */
const SIDES = 12;

/** ...and how round the origin dot is: at 24 a 12 px disc departs from its
 *  circle by a twentieth of a pixel (rings.js's sum for its knob). */
const DOT_SIDES = 24;

/** What a piece that is only ever LOOKED at answers a ray with: nothing.
 *
 * One mesh per piece takes the press. three's raycaster tests layers, never
 * visibility, so every band would otherwise be a target.
 * `Object3D.prototype.raycast` is three's empty base, which `Mesh` overrides;
 * putting it back on an instance makes a mesh drawn but never hit.
 */
const NO_HIT = () => {};

/** Which piece a press belongs to when a ray finds more than one, LOWEST FIRST.
 *
 * Not the nearest hit, which is a coin toss where pieces cross (a quad turned
 * nearly end-on lies within pixels of its two arrows). A quad is filled to its
 * edges and an arrow's shaft is thin, so the quad wins — the thing the reader
 * sees filled in.
 *
 * The dot answers no ray, so it has no rank.
 */
const RANK = { plane: 0, axis: 1 };

/** How a finished slide is announced: the name a part of the BUILD goes out
 *  under, the name a body of the PROPOSAL goes out under, and the field of
 *  `vp.moved` this gesture writes.
 *
 * The rotation handles hand `reportGesture` (gesture.js) the same three, for
 * an orientation.
 */
const MOVE_REPORT = {
  modelEvent: EVENT_MOVED, proposalEvent: EVENT_PROPOSALMOVE, key: "delta",
};

/**
 * Where an ARROW drag lands: the offset already standing, with the component
 * along `axis` of the hand's own world displacement added to it and snapped.
 *
 * The nearest point of the line: a line and the ray through the cursor miss
 * each other in 3D, so an arrow answers with the place on its line closest to
 * where the hand went (unlike `acrossPlane`).
 *
 * Only the axis the hand is on is snapped; the other two pass through
 * untouched, since a standing offset may come from hand-typed `delta.<axis>`
 * fields and need not be on this grid.
 *
 * `sine^2` divides: the screen-plane world vector sees only the axis's
 * projected part (length `sine`); moving the part by `t` moves its projection
 * by `t * sine`, and the dot with the axis takes another `sine` off. Without
 * the division the part lags the cursor by that factor.
 */
function alongAxis(base, world, axis, sine, step) {
  const along = dot3(world, axis) / (sine * sine);
  return base.map((v, i) => (axis[i] ? snap(v + axis[i] * along, step) : v));
}

/**
 * Where a QUAD drag lands: the same offset with the hand's world displacement
 * added to it on the plane's two axes, and the third left exactly as it was.
 *
 * The part follows the pointer. The orthogonal projection `w - n (w . n)` does
 * that only when the plane faces the reader. Under the ortho camera every pixel
 * looks along one fixed `view`, so two points share a pixel exactly when they
 * differ by a multiple of it; the displacement that stays in the plane and
 * lands the grabbed point back under the cursor is
 *
 *     p = w - view * (w . n) / (view . n)
 *
 * which satisfies `p . n = 0` and has `p - w` parallel to `view`.
 *
 * The division cannot blow up: `view . n` is exactly the `face` `place` hides
 * the quad by, so a pressable quad has `|face| >= GIZMO_MIN_SCALE` (a fifth)
 * and the factor is at most five. An edge-on plane has no in-plane answer, and
 * the widget removes the target instead. `gizmo.test.js` pins the two as one
 * number. The bound is from the last `place` before the press (one frame old),
 * the same assumption the arrow makes.
 *
 * The sign of `view` does not matter: it appears above and below the line.
 *
 * The rest is the arrow's: `niceStep`, `snap` on the two plane axes, and the
 * held axis passed through untouched.
 */
function acrossPlane(base, world, normal, view, step) {
  const out = dot3(world, normal);
  const into = dot3(view, normal);
  // Not `held`, which in this file is the selection the widget stands on.
  const inPlane = world.map((v, i) => v - view[i] * (out / into));
  return base.map((v, i) => (normal[i] ? v : snap(v + inPlane[i], step)));
}

/**
 * What a SLIDE remembers on top of `gestureRecord` (gesture.js).
 *
 * `ndc` is where the pointer was at the press: `onMove` constrains the world
 * span between it and the current reading (a turn reads an angle per event
 * instead, `turnRecord` in rings.js).
 *
 * `homes` is where the groups stand at the press, read off the scene rather
 * than `vp.partHome`: a proposal body's home is whatever the document last said,
 * which the previous drag's re-stage changed.
 */
function moveRecord(vp, paths, ndc, anchor, proposal) {
  return {
    ...gestureRecord(vp, paths, anchor, proposal, MOVE_REPORT.key),
    ndc,
    homes: proposal ? paths.map((path) => groupHome(vp.viewer, path)) : null,
  };
}

export function createGizmo(vp) {
  // The group, the place in the library's render pass, the pixel scale, the
  // cursor and the teardown are `scene3d.js`'s. `wanted`, `build`, `place` and
  // `onDown` are the declarations below; nothing is called until the first
  // `attach` and the first frame the library draws after it.
  const widget = createScene3D(vp, {
    wanted, build, place, press: onDown, cursor: "grab", order: GIZMO_ORDER,
  });

  // Built with the group, because the namespace they come from arrives with it.
  //
  // A raycaster of our own beside `scene3d.js`'s: that one asks whether any of
  // the widget is under the pointer (for the cursor), this one which of the six
  // (`RANK`). The dot is never pressed, so it is in neither.
  let group = null;
  let raycaster = null;
  let pointer = null;

  /** The three arrows and the three quads: `{kind, axis, world, node}`.
   *
   * `kind` picks the arithmetic in `onMove` (`alongAxis` or `acrossPlane`) and
   * what `onDown` measures: both take the camera basis, and `"axis"` also takes
   * `sine`. A quad's divisor is not measured there, because `place` fenced it.
   *
   * `world` is the axis an arrow is constrained to and the NORMAL a quad holds
   * still.
   *
   * `dot` is a bare node: it takes no press; it is drawn and turned to face the
   * reader.
   */
  let arms = [];
  let quads = [];
  let dot = null;

  /** Which piece each pressable mesh belongs to. */
  const targets = new Map();

  // The gesture in progress: the piece, how much of its axis the camera leaves
  // (`sine`, measured at the press; unused on a quad), the camera's projection
  // axis, where the press landed, the move record, and whether the pointer has
  // travelled far enough to be a drag. Null between gestures.
  let drag = null;

  /**
   * The selection this widget stands for, or null when there is nothing to put
   * it on.
   *
   * `grabbable` in parts.js, the same question `held` in rings.js asks, so both
   * halves of the manipulator come up on one condition and no piece offers a
   * move the press would refuse.
   *
   * `activeTool`, not `state.tool`: the hold key puts the cut up without
   * writing `state` (tools.js).
   *
   * Read every frame, so the widget goes away when the tool is disarmed or the
   * selection cleared.
   */
  const held = () => (vp.activeTool === "move"
    ? grabbable(vp, vp.state.selected)
    : null);

  function wanted() {
    return !!held();
  }

  /** One drawn mesh: its place in the paint order, and no answer to a ray. */
  function drawn(three, geometry, material, order) {
    const mesh = new three.Mesh(geometry, material);
    mesh.renderOrder = order;
    mesh.raycast = NO_HIT;
    return mesh;
  }

  /**
   * The one mesh of a piece that answers a ray: hit and never drawn.
   *
   * `visible = false`, not a transparent material (as in handle.js): three's
   * raycaster ignores visibility, so this costs no draw call.
   *
   * The piece's own visibility is checked here, since no raycaster consults it
   * either: `place` hides an end-on arrow or edge-on quad via `node.visible`,
   * and both `aimed` and `scene3d.js`'s cursor ray cast at this group. Without
   * this the canvas would show `grab` over a hidden target.
   */
  function target(three, piece, geometry, material) {
    const hit = new three.Mesh(geometry, material);
    hit.visible = false;
    hit.raycast = function answer(caster, found) {
      if (piece.node.visible) {
        three.Mesh.prototype.raycast.call(this, caster, found);
      }
    };
    piece.node.add(hit);
    targets.set(hit, piece);
    return hit;
  }

  /**
   * The seven pieces, in CSS pixels — `scene3d.js` scales the group so one unit
   * is one canvas pixel, keeping the widget one size on any part.
   *
   * A nested `Object3D`, never a `Group`: three re-reads `renderOrder` as the
   * group order at every `Group`, which would drop the widget behind the model.
   *
   * The paint ladder runs across pieces: arrows at the bottom, quads over them,
   * the dot over both — where a thin shaft crosses a filled shape, the reader
   * sees the thing they can aim at.
   */
  function build(three, grp) {
    group = grp;
    raycaster = new three.Raycaster();
    pointer = new three.Vector2();
    // +Y is the axis three gives a cylinder and a cone, so one rotation orients
    // the arrow (handle.js's construction, with one head pointing away from the
    // part).
    const up = new three.Vector3(0, 1, 0);
    arms = AXES.map(({ world, ink }, k) => {
      const node = new three.Object3D();
      node.quaternion.setFromUnitVectors(up, new three.Vector3(...world));
      const piece = { kind: "axis", axis: k, world, node };
      let paint = null;
      BANDS.forEach(({ colour, grow }, at) => {
        const material = widgetMaterial(three, colour === null ? ink : colour);
        // The head is as long as it is wide and sits at the tip, so the ink
        // reaches exactly `GIZMO_PX` from the part's centre.
        const shaft = drawn(three, new three.CylinderGeometry(
          GIZMO_SHAFT_PX / 2 + grow, GIZMO_SHAFT_PX / 2 + grow,
          GIZMO_PX - GIZMO_HEAD_PX, SIDES), material, at - 2);
        shaft.position.y = (GIZMO_PX - GIZMO_HEAD_PX) / 2;
        const head = drawn(three,
                           new three.ConeGeometry(GIZMO_HEAD_PX / 2 + grow,
                                                  GIZMO_HEAD_PX + 2 * grow,
                                                  SIDES),
                           material, at - 2);
        head.position.y = GIZMO_PX - GIZMO_HEAD_PX / 2;
        node.add(shaft, head);
        paint = material;
      });
      // The target is fat and the ink thin: a hand cannot reliably hit a 2 px
      // shaft (`GIZMO_HIT_PX`). It starts at the dot's rim, so the central 12 px
      // — where the axes are indistinguishable — answers no ray.
      const reach = GIZMO_PX - GIZMO_DOT_PX / 2;
      const hit = target(three, piece, new three.CylinderGeometry(
        GIZMO_HIT_PX / 2, GIZMO_HIT_PX / 2, reach, SIDES), paint);
      hit.position.y = GIZMO_DOT_PX / 2 + reach / 2;
      group.add(node);
      return piece;
    });
    quads = AXES.map(({ ink }, k) => {
      const [i, j] = spanOf(k);
      const node = new three.Object3D();
      // Local X onto `u`, Y onto `v`, Z onto the normal (`oriented` in
      // rings.js): three builds a plane in its own XY, so the square lies in its
      // world plane and foreshortens with it.
      node.quaternion.setFromRotationMatrix(new three.Matrix4().makeBasis(
        new three.Vector3(...AXES[i].world),
        new three.Vector3(...AXES[j].world),
        new three.Vector3(...AXES[k].world)));
      // The near corner stands `GIZMO_PLANE_GAP_PX` out along both spanning
      // axes, clear of where the shafts cross; the node sits at the square's
      // middle.
      const middle = GIZMO_PLANE_GAP_PX + GIZMO_PLANE_PX / 2;
      const at = [0, 0, 0];
      at[i] = middle;
      at[j] = middle;
      node.position.set(at[0], at[1], at[2]);
      const piece = { kind: "plane", axis: k, world: AXES[k].world, node };
      let paint = null;
      BANDS.forEach(({ colour, sink }, band) => {
        const material = widgetMaterial(three, colour === null ? ink : colour);
        // Double-sided: the reader orbits past a world plane.
        material.side = three.DoubleSide;
        const side = GIZMO_PLANE_PX - 2 * sink;
        node.add(drawn(three, new three.PlaneGeometry(side, side), material,
                       band + 1));
        paint = material;
      });
      target(three, piece,
             new three.PlaneGeometry(GIZMO_PLANE_PX, GIZMO_PLANE_PX), paint);
      group.add(node);
      return piece;
    });
    // The dot is the origin the others are measured from. It is billboarded
    // (`place` copies the camera's orientation onto it), and has no `target`,
    // so it takes no press and wears no cursor: the ray passes through to an
    // arrow under it or to the canvas, where a drag orbits.
    dot = new three.Object3D();
    BANDS.forEach(({ colour, sink }, band) => {
      const material = widgetMaterial(three, colour === null ? RIM : colour);
      dot.add(drawn(three, new three.CircleGeometry(
        GIZMO_DOT_PX / 2 - sink, DOT_SIDES), material, band + 4));
    });
    group.add(dot);
  }

  /** Which piece a ray landed on, or null.
   *
   * By rank, not distance (see `RANK`), and the single answer for both the
   * cursor `scene3d.js` offers and the piece a press takes.
   */
  function aimed(g, event) {
    if (!group || !group.visible || !raycaster) return null;
    const ndc = ndcAt(g.canvas, event);
    if (!ndc) return null;
    pointer.set(ndc[0], ndc[1]);
    raycaster.setFromCamera(pointer, g.cam);
    // A press does not know which frame it is on — see `scene3d.js`.
    group.updateMatrixWorld(true);
    let best = null;
    for (const found of raycaster.intersectObject(group, true)) {
      const piece = targets.get(found.object);
      if (piece && (!best || RANK[piece.kind] < RANK[best.kind])) best = piece;
    }
    return best;
  }

  /**
   * Stand the widget on the part, or say there is nothing to stand it on.
   *
   * On the world axes, not the part's: the arrows say which way the part will
   * go. So this writes only the group's position and each piece's visibility,
   * and turns the dot to face the reader.
   *
   * Read off the scene every frame, not from the move record: the record's
   * `base` is where the drag started, so arrows anchored on it would lag the
   * part and jump at release (as `anchor()` in handle.js and `place` in
   * rings.js).
   *
   * The first selected path, the same anchor the press takes: a row of five
   * copies moves as one thing.
   */
  function place(root, g) {
    const sel = held();
    if (!sel) return false;
    const at = partCentre(vp.viewer, sel.paths[0]);
    if (!at) return false;
    const basis = cameraBasis(vp.viewer, g);
    if (!basis) return false;
    root.position.set(at[0], at[1], at[2]);
    // One component of `view` serves all six: `|view[k]|` is the fraction of
    // the plane that survives projection and `sineFromCos(view[k])` that of the
    // axis, so they are never both gone.
    arms.forEach((arm, k) => {
      // Nearly end-on is hidden, not shortened (`GIZMO_MIN_SCALE`): the drag
      // divides by `sine^2`, so past the floor a steady hand jumps several steps.
      arm.node.visible = sineFromCos(basis.view[k]) >= GIZMO_MIN_SCALE;
    });
    quads.forEach((quad, k) => {
      // Nearly edge-on is hidden, and this is the whole fence round
      // `acrossPlane`'s division by `view . n` (this same component): every
      // pressable quad has a divisor of at least a fifth. An edge-on square is
      // also a sliver across its two arrows.
      quad.node.visible = Math.abs(basis.view[k]) >= GIZMO_MIN_SCALE;
    });
    // Faced to the reader every frame; the group carries only position and a
    // uniform scale, so the camera's orientation squares the circle to the
    // screen.
    dot.quaternion.copy(g.cam.quaternion);
    return true;
  }

  /** The window listeners this gesture is followed with (see `drag.js`). */
  const watch = watchDrag({ onMove, onUp, onCancel });

  /** Let go of the gesture, wherever it ended. */
  const finish = () => {
    drag = null;
    watch.disarm();
    // The cursor goes back to answering the ray.
    widget.grabbed(false);
  };

  /** End the gesture and say where the part ended up.
   *
   * Every ending comes here — release, a pointer the platform took away, a
   * second press, the scene swapped mid-drag — and all of them report, unlike
   * the section drag (`conclude` in tools.js): the part already stands where it
   * was dragged, so a silent ending leaves it displaced with no node claiming it
   * and the next push sends it home.
   *
   * Only if it really was a drag (`CLICK_PX` of travel, `onMove`): a bare press
   * on an arrow is not a placement.
   */
  const stop = () => {
    const live = drag;
    finish();
    if (live && live.moved) reportGesture(vp, live.move, MOVE_REPORT);
  };

  function onMove(event) {
    if (!drag) return;
    // A click is not a one-pixel drag (`travelled` in drag.js): there is no
    // click on an arrow, so a twitch would only snap the part a step and file a
    // node nobody asked for.
    if (!travelled(event, drag)) return;
    drag.moved = true;
    const viewer = vp.viewer;
    const g = internals(viewer);
    if (!g) return;
    const ndc = ndcAt(g.canvas, event);
    if (!ndc) return;
    const b = cameraBasis(viewer, g);
    if (!b) return;
    const d = drag.move;
    // The unconstrained displacement — the difference of the two ends'
    // `ndcOffset` readings, as the swipe pan computes it, depth-free under ortho
    // — put back on the piece's geometry. Starting from it gets the scale, zoom
    // and pan right without asking about them. The arrow divides by `sine^2`
    // (25x at the `GIZMO_MIN_SCALE` floor) and the quad by `view . n` (at most
    // 5x), both bounded by `place` hiding the piece.
    const from = ndcOffset(g, b.eye, b.view, d.ndc[0], d.ndc[1]);
    const to = ndcOffset(g, b.eye, b.view, ndc[0], ndc[1]);
    if (!from || !to) return;
    const world = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    // The step and snap are tools.js's, so arrow, quad and disc land on the
    // same numbers in `vp.moved`, the event and the document — unless the
    // interface set a step for this path (`setSnapSteps` in element.js). Asked
    // of the anchor: one gesture moves the whole row by one delta.
    const asked = vp.snapSteps.get(d.paths[0]);
    const step = asked > 0 ? asked : niceStep(viewer);
    const delta = drag.piece.kind === "axis"
      ? alongAxis(d.base, world, drag.piece.world, drag.sine, step)
      : acrossPlane(d.base, world, drag.piece.world, drag.view, step);
    if (delta[0] === d.last[0] && delta[1] === d.last[1]
        && delta[2] === d.last[2]) return;
    d.last = delta;
    // A proposal body is moved for the eye only and nothing is recorded: a
    // delta in `vp.moved` would be re-applied on top of the document's new
    // position after the re-stage. A build part leaves the offset in
    // `vp.moved`; `stood` is the last delta that landed, separate from `last`
    // because `movePart` can refuse and `last` must advance regardless.
    if (d.body) {
      nudgePart(vp, d.paths, d.homes, delta);
      return;
    }
    if (movePart(vp, d.paths, delta, d.turn)) d.stood = delta;
  }

  function onUp() {
    stop();
  }

  function onCancel() {
    stop();
  }

  /**
   * A press the ray found on one of the six that take one. True when this
   * widget has taken it, which is what `scene3d.js` suppresses the event on.
   *
   * Primary button only: refused presses go on to what is behind (right-drag
   * pans, right-click opens the part menu, middle goes to the trackball).
   *
   * Both this and the rings read presses off the same canvas: each answers only
   * for a ray on its own meshes, and where they overlap `GIZMO_ORDER` is above
   * `RINGS_ORDER`, so `joinPresses` asks this widget first.
   *
   * Measured once and held for the gesture, as `onDown` in handle.js and
   * rings.js: the camera cannot move under a press this widget owns.
   */
  function onDown(event, g) {
    if (event.button !== 0) return false;
    const piece = aimed(g, event);
    if (!piece) return false;
    // Conclude a previous gesture first (tools.js does a bare `finish()`; here
    // it reports): a second pointer would otherwise overwrite the press point,
    // and the interrupted part would stand unclaimed.
    stop();
    // And the rotation handles' gesture: both halves answer to one tool, so a
    // finger on a ring then a finger on an arrow would leave two live drags.
    // Both `onMove`s are on the window and neither filters by pointer id, and
    // each `movePart` writes position and orientation from its own stale
    // snapshot of the other half, so they would overwrite each other and both
    // report. `endDrag` concludes rather than abandons. It is done here, not in
    // rings.js's `handOver`, because a press this widget keeps never reaches the
    // lower band. `vp.rings` is always set: element.js builds both widgets in one
    // synchronous `connectedCallback`, and `destroy()` removes the listeners
    // without clearing the field.
    vp.rings.endDrag();
    // And the canvas gesture. Everything that can be live:
    //
    //   1. this widget's own drag                    — `stop()` above
    //   2. the rotation handles' drag (rings.js)     — `vp.rings.endDrag()`
    //   3. the canvas gesture (tools.js `press`)     — this line
    //   4. the section grip's drag (handle.js)       — deliberately left alone
    //
    // Three: tools.js ends its previous press in its own `onDown`, but a press
    // this widget keeps never reaches that listener (`scene3d.js` suppresses
    // it), so a hold-key cut started by a first finger would keep dragging the
    // plane. Four writes the clip slider and this writes the part; they read
    // nothing of each other's, so both may run.
    //
    // `vp.endGesture` is always a function here: `installTools` assigns it in
    // the same synchronous `connectedCallback`, and its teardown runs inside
    // `destroy()` with this widget's listener removal.
    //
    // Cost: concluding a cut means `reportCut`, which disarms the armed tool.
    // The sequence that reaches it is narrow (a hold-key cut still down, the key
    // released mid-drag, then a second finger on a piece), and leaving the drag
    // live would corrupt the plane.
    vp.endGesture();
    const sel = held();
    if (!sel) return false;
    const ndc = ndcAt(g.canvas, event);
    if (!ndc) return false;
    // The anchor is the first selected path, where `place` stands the widget:
    // the row converges onto that copy (`movePart`), so it is the only answer
    // that does not move what the reader is aiming at.
    //
    // Both kinds need the camera's projection direction (`acrossPlane` meets
    // the ray with the plane along it; an arrow's foreshortening is measured
    // against it). `cameraBasis` builds a fresh array each call, so holding it
    // is safe.
    const basis = cameraBasis(vp.viewer, g);
    // The scene refusing to be measured at all, which takes the gesture away.
    if (!basis) return false;
    const view = basis.view;
    let sine = 0;
    if (piece.kind === "axis") {
      // The same component and function `place` draws from, so the arrow on
      // screen is the arrow that drags. Zero (pointing at the reader) is never
      // drawn and would break `alongAxis`'s division.
      sine = sineFromCos(view[piece.axis]);
      if (!(sine > 0)) return false;
    }
    // Nothing for a quad: `place` already fenced its divisor `view . n`.
    drag = {
      piece,
      // `alongAxis` divides by its square; zero on a quad, which never reads it.
      sine,
      view,
      startX: event.clientX,
      startY: event.clientY,
      move: moveRecord(vp, sel.paths, ndc, sel.paths[0], sel.proposal),
      moved: false,
    };
    watch.arm();
    // The canvas wears `grabbing` until `finish`: a constrained drag carries
    // the hand off its 14 px cylinder within a few pixels.
    widget.grabbed(true);
    return true;
  }

  /** End a drag the reader has not let go of, because the scene is going away.
   *
   * The twin of `vp.endGesture` and of the grip's and rings' `endDrag`: the
   * press was taken in a window listener the idle clock never saw, so the
   * release never comes. It concludes rather than abandons, because an
   * abandoned part stands displaced in `vp.moved` with no node claiming it.
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
      // A viewport unmounted mid-drag would otherwise leave three capture-phase
      // listeners on the window. `finish`, not `stop`: `vp.moved` goes with the
      // widget, so there is nothing left to report (as in tools.js's teardown).
      finish();
      widget.destroy();
      group = null;
      raycaster = null;
      pointer = null;
      arms = [];
      quads = [];
      dot = null;
      targets.clear();
    },
  };
}
