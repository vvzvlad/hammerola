// The move tool's rotation handles: three of them round the selected part, one
// per world axis, each dragged to turn the part about THAT AXIS ONLY.
//
// THE SAME TOOL THE AXIS ARROWS ANSWER TO, which is the one thing about this
// file that is not its own. Fusion's manipulator is ONE widget under one command
// (`TriadCommandInput`): an origin, three arrows, three plane quads and three
// rotation handles, all at once. There was a second tool here, `turn`, and it
// meant the reader had to put a part down before they could turn it.
//
// WHAT THE MERGE DID COST IS IN `handOver`, and it is not the name in `held`.
// Both halves stand on the part at once now, so two gestures that move the same
// part can be live where one could be before — this widget's and the arrows' —
// with the canvas gesture underneath them holding a cut. Each press therefore
// ends the others. Read `handOver` and `onDown` before believing anything about
// this file is simple.
//
// ONE KNOB PER AXIS IS WHAT THE READER ACTUALLY SEES AND PRESSES, and that is
// the answer to the two things three full circles got wrong. They DROWNED in
// the geometry — three closed curves of one radius, in three colours a part may
// perfectly well be painted — and they could not be AIMED AT, because circles
// of one radius about one centre cross six times and knot where they meet. So:
// each axis carries a compact knob sitting on its own circle, at the parameter
// that bisects the two world axes spanning the ring's plane, which puts the
// three of them in three different corners of the widget; at rest a short arc
// fades out either side of the knob and no full circle is drawn at all; and the
// whole circle appears under the cursor, which is how the reader learns which
// axis they are about to turn BEFORE they press. Fusion's manipulator, measured
// off its own sprites — the radius, the knob, the span of the arc and the
// construction are its numbers (options.js), the three inks are ours.
//
// WHY IT EXISTS. A part could always be turned — a move node of the proposal
// carries three degrees beside its offset (ui/src/proposal.js) — and the only
// way to say so was to type them into the row's fields. Nothing on the screen
// said a turn was possible at all, and nothing about three numbers in a panel
// says which way the part will go: the reader types 90, looks up, and finds out.
// Blender's answer is this widget, the drag's own twin of the axis arrows, and
// it is the one readers arrive already knowing.
//
// AN OBJECT IN THE SCENE AND NOT A LAYER OF DIVS OVER IT, which is what makes a
// ring a circle rather than a picture of one. `scene3d.js` carries the half that
// is shared with the section grip, and everything it says about why a widget
// lives in the scene applies here twice over: drawn flat, every question this
// file asked was a question about the SCREEN — where each ring's ellipse lands,
// how to invert it to get an angle back, how flat is too flat to aim at — and
// each of those had to be computed, guarded and floored. A torus lying in the
// world plane its axis spans is projected by the camera like everything else,
// and the angle under the hand is where the pointer's RAY meets that plane.
//
// TWO BUGS WENT WITH THE FLAT WIDGET, AND ONLY ONE OF THEM WENT BY ITSELF. The
// knob's outer rim reaches `RING_PX + RING_DISC_PX / 2`, seven pixels outside
// the ring's own dark rim, and the flat version clipped exactly those seven
// away: the fade was a `mask-image` on a box of the rim's size, and `mask-clip`
// is the border box by default. There is no mask here and no box to clip to, so
// that one is gone with the representation. The other is not: the knob was a
// static child offset and stood still while the part turned under the hand, and
// what puts it right is `place` turning it by the angle swept so far — the one
// thing about this move that had to be done deliberately rather than hoped for.

import { cameraBasis, ndcAt, ndcRay } from "./camera.js";
import { travelled, watchDrag } from "./drag.js";
import { EVENT_PROPOSALTURN, EVENT_TURNED, emit } from "./events.js";
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

/** The three world axes, in the order they are drawn and in the colours
 *  everything that draws an axis triad is spelled in.
 *
 * RED, GREEN, BLUE FOR X, Y, Z is the same convention gizmo.js states at
 * length: every CAD and DCC tool the reader has already used spells its axes
 * this way, so it is the one thing about either widget nobody has to be told.
 * The three inks are the arrows' own — as hexes a material takes rather than as
 * the CSS strings that layer writes — and `rings.test.js` pins that they still
 * are: two widgets standing on one part in two palettes would be two triads.
 *
 * THE PAIR THAT SPANS EACH RING'S PLANE IS THE OTHER TWO AXES IN CYCLIC ORDER,
 * `u = AXES[(k + 1) % 3]` and `v = AXES[(k + 2) % 3]`, and the whole sign of
 * this gesture rests on that one line. Cyclic order is exactly the pair with
 * `u x v = +k` — Y x Z = X, Z x X = Y, X x Y = Z — so a point walked
 * anticlockwise from `u` towards `v` is a point walked the RIGHT-HANDED way
 * about the axis, which is the direction a positive angle means everywhere else
 * in this document. Taken the other way round every ring would turn its part
 * backwards, and nothing on screen would say so. It is written down ONCE, as
 * the basis each ring's own node is turned to (`oriented`), and both the
 * drawing and the angle read it off that node's frame.
 *
 * `lit` IS THE SAME INK LIGHTENED, and it is the whole of what a knob does
 * under the cursor. Fusion lightens the handle the pointer is on, which says
 * "this is the one you are about to take" in the one channel a reader does not
 * have to look away to read — and it says it without changing the axis's
 * COLOUR, which is the thing the reader is meant to be reading off it.
 */
const AXES = [
  { world: [1, 0, 0], ink: 0xc93a31, lit: 0xdc7f79 },
  { world: [0, 1, 0], ink: 0x2e8b40, lit: 0x77b483 },
  { world: [0, 0, 1], ink: 0x2d66c7, lit: 0x769cdb },
];

/** The two inks the CONSTRUCTION is made of, which are not a palette either.
 *
 * The white is the one the grip stands its own ink on (`CASING` in handle.js)
 * and the dark is the one every piece of the manipulator is rimmed with (`RIM`
 * in gizmo.js, the same three bytes). Both are here as geometry rather than as
 * a filter, which is what `RING_CASE_PX` argues and what `HANDLE_CASE_PX`
 * already does in the scene: this widget stands ON the model, over whatever
 * colour the part happens to be and on either canvas.
 */
const CASING = 0xffffff;
const RIM = 0x14181c;

/** Where on its own circle each ring carries its knob, as an angle in the
 *  ring's own plane.
 *
 * THE BISECTOR OF THE RING'S TWO WORLD AXES — 45 degrees from `u` towards `v`,
 * which for the X ring (whose circle lies in YZ) is the direction of `+Y +Z`.
 * The three come out 60 degrees apart in the world, and under any camera that
 * shows all three rings they land in three different corners of the widget:
 * that separation is the whole of "you can hit the axis you mean". Put at a
 * world axis instead, two knobs would sit on top of each other at every one of
 * the six points where the rings themselves cross.
 */
const DISC_AT = Math.PI / 4;

/** Half the arc drawn at rest, and the half-angle the knob itself covers of the
 *  same circle — the two the fade is shaped by, in radians.
 *
 * `DISC_HALF` is what the knob subtends at the ring's centre, which is where
 * the ramp has to have finished: the arc runs UNDER the knob, and ink that was
 * still fading in there would show through the casing the knob is carried on.
 */
const ARC = (RING_ARC_DEG * Math.PI) / 180;
const DISC_HALF = Math.asin(RING_DISC_PX / 2 / RING_PX);

/** The three bands every piece of this widget is drawn in, OUTERMOST FIRST, and
 *  the order they are painted in — the dark rim under the white casing under
 *  the ink, which is `pieces()`'s construction in the flat widget and `grow`'s
 *  in handle.js.
 *
 * TWO SEQUENCES AND NOT ONE, because the curve and the knob grow opposite ways.
 * The curve's three bands are three tubes about ONE circle, each standing
 * `grow` further out and further in than the ink; the knob's three are filled
 * discs sharing an OUTER edge at `RING_DISC_PX / 2`, each `sink` inside the one
 * before it. A light fill inside a white casing inside a dark rim is the thing
 * that reads on a body of its own colour, and it is Fusion's own construction.
 *
 * `colour: null` IS THE AXIS'S OWN INK, which is the one of the three that is
 * not the same on all of them.
 */
const BANDS = [
  { colour: RIM, grow: RING_CASE_PX + RING_RIM_PX, sink: 0 },
  { colour: CASING, grow: RING_CASE_PX, sink: RING_RIM_PX },
  { colour: null, grow: 0, sink: RING_RIM_PX + RING_CASE_PX },
];

/** How round the tube of a ring is. Twelve is handle.js's number for the same
 *  2 px width, and the argument is that file's: it is where a cylinder two
 *  pixels across stops reading as a polygon at any angle. */
const SIDES = 12;

/** ...and how round a knob is, which is ten times as wide and therefore needs
 *  more of them: at twenty-four, a 20 px disc departs from its own circle by a
 *  twelfth of a pixel at the worst point — `10 * (1 - cos(pi / 24))`, the sum
 *  `STEPS` below spells for the curve. */
const KNOB_SIDES = 24;

/** How many steps the whole circle is drawn in. At sixty-four a circle of
 *  `RING_PX` stands an eighth of a pixel inside the true curve at the middle of
 *  each step, which is under the line the browser draws it with. */
const STEPS = 64;

/** Half a turn, in radians — the wrap `onMove` unwinds a step across. */
const HALF_TURN = Math.PI;

const DEGREES_PER_RADIAN = 180 / Math.PI;

/** What a piece that is only ever LOOKED at answers a ray with: nothing.
 *
 * THE KNOB IS THE ONLY THING THAT TAKES A PRESS, and in this representation
 * that has to be said to the raycaster rather than assumed. three tests an
 * object's LAYERS and never its visibility, so the whole circle standing by
 * behind the resting arc is a 210 px target in front of the knobs, and a 2 px
 * curve crossing a knob would take the press meant for it — `intersectObject`
 * answers with the NEAREST hit, not the one the hand was aiming at.
 * `Object3D.prototype.raycast` is three's own empty base, which `Mesh`
 * overrides; putting it back on an instance is how a mesh is drawn and never
 * hit.
 */
const NO_HIT = () => {};

/**
 * How solid the resting arc is `t` radians round from its own start.
 *
 * THE AT-REST FADE, which was a conic-gradient mask over the flat widget and is
 * per-vertex alpha here: a mask is a picture over a box and there is no box any
 * more, but the stops were always ANGLES of the ring's own circle, so they
 * carry over unchanged. Full across the knob's own width, a straight ramp out
 * to `RING_ARC_DEG` either side, nothing beyond.
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
 * READ OFF THE VERTEX'S OWN POSITION rather than out of the order the geometry
 * was generated in, which is what makes this independent of three's loop. A
 * torus puts a vertex at `((R + r cos v) cos u, (R + r cos v) sin u, r sin v)`,
 * and `R > r` makes that factor positive — so `atan2(y, x)` IS the sweep
 * parameter `u`, exactly, whatever the tube has done to the point.
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
 * One material of this widget: `widgetMaterial` with the two flags this one
 * needs that the grip does not.
 *
 * `fading` carries the per-vertex alpha and nothing else; `both` turns culling
 * off for the knob, which is a flat disc and is seen from either side of its
 * own ring. A closed tube keeps the default, because two blended sides of one
 * tube would double the very alpha the fade is made of.
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
 * THE ANGLE COMES FROM THE RAY AND THE RING'S PLANE, which is the whole of what
 * the move into the scene replaced. Flat, this was the pointer pushed back
 * through the inverse of the ellipse's own 2x2 — a basis that had to be
 * measured, could go singular, and carried the screen's downward y and the
 * projection's own flip for a ring seen from behind, both of which had to come
 * back out again. Here the ring lies in the world plane `axis` is normal to,
 * the rings do not move with the part, and so that plane is simply
 * `x[axis] = centre[axis]`: meet it with the ray under the cursor and take
 * `atan2` in the cyclic pair. The sign needs no correcting because `u x v` is
 * `+axis` and nothing in between has an opinion.
 */
function ringAngle(vp, g, axis, centre, event) {
  const basis = cameraBasis(vp.viewer, g);
  if (!basis) return null;
  const ndc = ndcAt(g.canvas, event);
  if (!ndc) return null;
  const ray = ndcRay(g, basis.eye, basis.view, ndc[0], ndc[1]);
  if (!ray) return null;
  // A ray lying IN the ring's plane meets it nowhere, and a NaN anywhere in the
  // camera lands here as one too. `RING_MIN_PX` has already taken a ring this
  // flat off the screen, so there is nothing left to aim at either.
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
 * Where one body of the PROPOSAL has its own origin, in world units, or null.
 *
 * THE POINT THE DOCUMENT TURNS IT ABOUT, which is the only reason this side
 * needs the number at all: `placed` in ui/src/proposalgeom.js builds a body in
 * its own coordinates, rotates it there and only then carries it to `at`, so
 * `at` is the one world point a change of `rot` leaves exactly where it is. A
 * preview taken about any other point is a preview of a different rotation, and
 * the body jumps to the document's answer the moment the hand comes off.
 *
 * READ OFF THE PAYLOAD AND NOT OFF THE SCENE, because the scene cannot answer
 * it: a proposal body arrives with an identity `loc` and the whole placement
 * baked into its vertices, so its group's origin is the world's and its box
 * centre is wherever the geometry happens to sit. The panel puts the body's
 * `at` on the part it hands over (`part()` in proposalgeom.js) for exactly this
 * question.
 */
function bodyOrigin(vp, path) {
  const name = vp.overlayBody(path);
  if (!name) return null;
  const parts = Array.isArray(vp.overlayParts) ? vp.overlayParts : [];
  const part = parts.find((entry) => entry && entry.name === name);
  return part && finite3(part.origin) ? part.origin : null;
}

/**
 * Everything a turn gesture has to remember about the scene it started on,
 * assembled once at the press. `moveRecord` in tools.js, asked about an
 * orientation instead of a place, and every field is that field's answer.
 *
 * IN THIS FILE AND NOT BESIDE IT, which is the one deliberate difference.
 * `moveRecord` stayed in tools.js because the record and the `reportMove` that
 * reads it are one sentence, and a second hand-written copy is how the pieces
 * that make one would start disagreeing about what a drag means. There is one
 * gesture that turns, so its record belongs where it is used; the day a second
 * one appears, this moves.
 *
 * `base` IS THE TURN ALREADY STANDING and `delta` the offset already standing,
 * and the second is carried without ever being changed: this gesture says which
 * way the part faces and says nothing whatever about where it is. `movePart`
 * writes both on every call, so a gesture that left the offset out would send a
 * part the reader had dragged straight back home the moment they turned it.
 *
 * `bases` IS THE SAME QUESTION ASKED OF EVERY PATH, for `reportModelTurn`'s
 * sake and for the reason tools.js gives: one gesture writes one turn onto
 * every path it holds, so the copies of a row converge, and where each of them
 * WAS is the only record of what this gesture actually changed.
 *
 * `seats` IS WHAT A BODY OF THE PROPOSAL CARRIES INSTEAD OF `vp.moved` — where
 * each group stands, which way it faces and where the body's own origin is,
 * all taken at the press and dying with the gesture. `nudgeTurn` says why none
 * of the three may be remembered: the document is what places a body, and a
 * home kept across the re-stage the last gesture caused is a home that has
 * moved.
 */
function turnRecord(vp, paths, anchor, proposal) {
  const already = vp.moved.get(anchor);
  const base = already ? already.turn : [0, 0, 0];
  return {
    paths,
    delta: already ? already.delta : [0, 0, 0],
    base,
    last: base,
    stood: base,
    bases: paths.map((path) => {
      const held = vp.moved.get(path);
      return held ? held.turn : [0, 0, 0];
    }),
    build: vp.drawnKey,
    body: proposal ? vp.overlayBody(anchor) : null,
    seats: proposal ? paths.map((path) => ({
      home: groupHome(vp.viewer, path),
      pose: groupFacing(vp.viewer, path),
      centre: bodyOrigin(vp, path),
    })) : null,
  };
}

/** Which way a part of the BUILD ended up facing, announced once.
 *
 * `reportModelMove` in tools.js with the other field of the node, and every
 * decision on it is that one's: THE RELEASE IS THE ONLY REPORT, because the
 * interface answers a recorded statement by opening the panel and an opened
 * panel re-stages, which ends the gesture the reader has not let go of; the
 * report is DEFERRED BY A MICROTASK so it cannot be raised from inside a
 * render; and `build` is stamped at the press because that microtask can
 * outlive the build the angles were measured on.
 *
 * A GESTURE THAT CHANGED NOTHING SAYS NOTHING, measured against the angles that
 * were STANDING rather than against zero — a part may well have been turned
 * before this press — and against EVERY PATH'S OWN, because one gesture carries
 * the copies of a row onto a single turn and can come back to exactly where the
 * anchor started while its siblings are left somewhere no node claims.
 */
function reportModelTurn(vp, turn) {
  const t = turn.stood;
  if (turn.bases.every((base) => t.every((v, axis) => v === base[axis]))) return;
  queueMicrotask(() => emit(vp, EVENT_TURNED, {
    id: turn.paths[0],
    name: turn.paths[0].split("/").filter(Boolean).pop(),
    paths: [...turn.paths],
    count: turn.paths.length,
    build: turn.build,
    turn: t,
  }));
}

/** How far a body of the PROPOSAL was turned, announced once.
 *
 * `reportProposalMove` in tools.js, and the same microtask for the same reason:
 * this report comes back as a STAGE, and a stage sent synchronously from inside
 * a render would repaint the build that is being replaced.
 *
 * A GESTURE THAT WENT NOWHERE SAYS NOTHING. `last` starts at nothing for a body
 * — the document holds its pose and this side has never read it — so a drag
 * that never left the first whole degree, or came back to it, turned the body
 * by nothing, and reporting it would be a re-stage of a document nothing
 * changed in.
 */
function reportProposalTurn(vp, turn) {
  const t = turn.last;
  if (!t[0] && !t[1] && !t[2]) return;
  queueMicrotask(() => emit(vp, EVENT_PROPOSALTURN, {
    name: turn.body, turn: t,
  }));
}

/** What one finished turn SAYS, whichever of the two things it was turning.
 *
 * `reportMove`'s dispatch, on the same field and for the same reason: a body of
 * the proposal carries the name the panel drew it under and a part of the build
 * carries none. The two are opposite claims about the model — a part of the
 * build is a STATEMENT to the agent about a model nothing has changed, a body
 * is an ordinary EDIT of the document the reader is drawing — so they part here
 * rather than behind a flag on one event.
 */
function reportTurn(vp, turn) {
  if (turn.body) reportProposalTurn(vp, turn);
  else reportModelTurn(vp, turn);
}

export function createRings(vp) {
  // THE HAND-OVER IS REGISTERED BEFORE `createScene3D`, AND THAT IS
  // LOAD-BEARING. `handOver` ends the two gestures a new press strands, and
  // `onDown` below builds the new one; both are capture-phase listeners on the
  // window, and listeners on one node in one phase run in the order they were
  // added. The other way round, `onDown` would build a drag and `handOver`
  // would immediately stop it. It is two listeners rather than one because
  // `scene3d.js` calls `onDown` only for a press its ray LANDED on, and the
  // gestures a press strands are stranded by a press that misses too.
  addEventListener("pointerdown", handOver, true);
  addEventListener("pointermove", onMove, true);

  // The group, the place in the library's render pass, the pixel scale, the
  // press and the teardown are `scene3d.js`'s. `wanted`, `build`, `place` and
  // `onDown` are the declarations below; nothing is called until the first
  // `attach` and the first frame the library draws after it.
  const widget = createScene3D(vp, {
    wanted, build, place, press: onDown, cursor: "grab", order: RINGS_ORDER,
  });

  // Built with the group, because the namespace they come from arrives with it.
  //
  // A RAYCASTER OF OUR OWN, beside the one `scene3d.js` keeps, and the two ask
  // different questions of the same ray: that one asks whether ANY of this
  // widget is under the pointer, which is all a cursor needs, and this one asks
  // WHICH OF THE THREE — the question only a widget made of three separable
  // things has. `axisOf` is the single answer to it, so the knob that lights up
  // under the cursor and the knob a press turns cannot disagree.
  let group = null;
  let raycaster = null;
  let pointer = null;

  /** One per axis: the node its circle lies in, the two forms of that circle,
   *  the node the knob is carried on, and the knob's own ink. */
  let rings = [];

  /** Which axis each knob's hit target belongs to. */
  const knobs = new Map();

  // The gesture in progress: which ring it is on, the part centre and the angle
  // it was measured against at the press, how far the hand has swept since, the
  // record it is applying, and whether the pointer has travelled far enough to
  // be a drag at all. Null between gestures.
  let drag = null;

  // Which axis the cursor is on, or -1 for none. Written by `onMove` off the
  // ray and read once a frame by `place`, so a hover costs one cast of a ray
  // that was going to be cast anyway and nothing at all on the frames between.
  let lit = -1;

  /**
   * The selection these rings stand for, or null when there is nothing to put
   * them round.
   *
   * `held` IN gizmo.js, CHARACTER FOR CHARACTER, and it has to be: rings
   * offering a turn that the press would then refuse are a promise the widget
   * cannot keep, and two halves of ONE widget that appeared on different
   * conditions would be a widget with a piece missing. That is why the question
   * itself is `grabbable` in parts.js — one function, which the arrows and the
   * quads ask too — and why what is left here is the tool it is asked under.
   *
   * `activeTool` AND NOT `state.tool`, for the reason tools.js gives: the hold
   * key puts the cut up without writing to `state`, and rings left standing
   * under a cut gesture would be offering a turn the press is no longer for.
   *
   * READ EVERY FRAME rather than remembered, which is what lets the widget come
   * off by itself when the reader disarms the tool or clears the selection.
   */
  const held = () => (vp.activeTool === "move"
    ? grabbable(vp, vp.state.selected)
    : null);

  function wanted() {
    return !!held();
  }

  /** One ring's own frame: its circle in local XY, its axis along local +Z.
   *
   * WHICH IS WHERE THE SIGN IS SETTLED, once, for the drawing and the gesture
   * alike. three builds a torus in XY sweeping from +X towards +Y and a circle
   * the same way, so turning this node's +X onto `u` and its +Y onto `v` makes
   * the drawn curve run the right-handed way about `+k` — and `ringAngle` reads
   * its `atan2` in the very same pair.
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
   * The three rings, in CSS pixels — `scene3d.js` scales the group so that one
   * unit of this geometry is one pixel on the canvas, which is what keeps the
   * widget the same size on a 2 mm part and a 200 mm one.
   *
   * THE GEOMETRIES ARE SHARED AND THE MATERIALS ARE NOT, which is the axes'
   * only difference: every ring is the same circle in its own frame, and what
   * tells them apart is the ink. The knob's ink is a material per axis because
   * it is the one thing that LIGHTENS under the cursor.
   *
   * A NESTED `Object3D` AND NEVER A `Group`: three re-reads `renderOrder` as
   * the group order at every `Group` it walks into, so a group here would drop
   * this whole widget out of the bucket `scene3d.js` put it in and back behind
   * the model.
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
        // THE SAME ANGULAR RESOLUTION AS THE WHOLE CIRCLE, so the arc and the
        // circle that replaces it under the cursor are the same curve.
        arc: feather(three, new three.TorusGeometry(
          middle, tube, SIDES, Math.ceil((STEPS * span) / (2 * Math.PI)), span)),
        whole: new three.TorusGeometry(middle, tube, SIDES, STEPS),
      };
    });
    const faces = BANDS.map(({ sink }) => new three.CircleGeometry(
      RING_DISC_PX / 2 - sink, KNOB_SIDES));
    // THE TARGET IS THE KNOB'S OWN SIZE, which is the dividend of putting the
    // press on a compact handle rather than on the curve: there is no tolerance
    // left to invent, because what the ray meets is exactly what is drawn.
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
      // `visible = false` AND NOT a transparent material: three's raycaster
      // tests an object's LAYERS and never its visibility, so this is a mesh
      // that is hit and never drawn — no second draw call and nothing for the
      // renderer to sort. It is the one mesh in this widget `NO_HIT` is kept
      // off.
      //
      // AND THE RING'S OWN FLAG IS ASKED ON THE MESH, one level up, because the
      // same blindness applies to it: `place` takes a ring seen edge-on off the
      // screen by clearing `node.visible`, and no raycaster consults that
      // either. TWO of them cast at this group — `aimed` below, for which axis
      // the hand is on, and `scene3d.js`'s, for the cursor — and the second
      // knows nothing of this widget's structure, so a floor applied anywhere
      // but here would leave the canvas wearing `grab` over the sliver of a
      // ring that is not drawn, promising a grab the press then refuses.
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

  /** Which axis a ray landed on, or -1 for anything that is not a knob.
   *
   * A RING THE LAST FRAME TOOK OFF THE SCREEN NEVER GETS HERE, and that is said
   * on the hit mesh itself rather than in this line: the floor has to hold for
   * `scene3d.js`'s ray as well as for ours, and only the mesh is in both.
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
    // A press does not know which frame it is standing on — `scene3d.js` says
    // why this one matrix compose is cheaper than having to.
    group.updateMatrixWorld(true);
    const hits = raycaster.intersectObject(group, true);
    return hits.length ? axisOf(hits[0].object) : -1;
  }

  /**
   * Put the three rings round the part, or say there is nothing to put them
   * round.
   *
   * ON THE WORLD AXES AND NOT THE PART'S, which is what this gesture has always
   * meant: the rings say which way the part will go, and a widget that adopted
   * the part's own orientation would be answering a different question. So the
   * only thing this writes on the group is WHERE it stands, and the only thing
   * it writes on a ring is whether it is drawn, how much of it is, and where
   * its knob has been carried by the hand.
   */
  function place(root, g) {
    const sel = held();
    if (!sel) return false;
    // THE FIRST SELECTED PATH, which is the same anchor the press takes: a row
    // standing for five copies of a part turns as one thing, and the rings have
    // to stand round one of them rather than between them. Read off the SCENE
    // and not out of the record, exactly as the arrows' anchor is — a turn
    // about the part's own centre leaves that centre where it was, but a part
    // that was DRAGGED between two presses has moved.
    const centre = partCentre(vp.viewer, sel.paths[0]);
    if (!centre) return false;
    const basis = cameraBasis(vp.viewer, g);
    if (!basis) return false;
    root.position.set(centre[0], centre[1], centre[2]);
    // A DRAG OWNS THE LIGHT FOR AS LONG AS IT RUNS, whatever the pointer is
    // over — and the pointer leaves the knob immediately, because turning the
    // part is exactly the act of carrying the hand away from where it pressed.
    // A ring that went back to a faded arc under the hand holding it would be
    // saying the gesture had ended.
    const on = drag ? drag.axis : lit;
    rings.forEach((ring, k) => {
      // A RING SEEN EDGE-ON IS GONE, not flattened — `RING_MIN_PX` carries the
      // argument and it is `GIZMO_MIN_SCALE`'s: a control the reader can see
      // and cannot use is worse than no control, and turning the model a little
      // brings it back. What is unusable is the KNOB, which is a disc in the
      // ring's own plane and flattens with it. The minor semi-axis of a circle
      // of `RING_PX` seen along `view` is `RING_PX * |n . view|`, and the ring's
      // own normal is world axis `k` — so the dot product is one component.
      ring.node.visible = Math.abs(basis.view[k]) * RING_PX >= RING_MIN_PX;
      // THE WHOLE CIRCLE IS THE HOVER FEEDBACK, which is the second half of the
      // answer to "you cannot hit the axis you mean": the knob says where to
      // press and the circle that appears under the cursor says what pressing
      // there will DO — the plane the part is about to turn in, drawn before
      // the reader has committed to anything.
      const glow = ring.node.visible && k === on;
      ring.whole.visible = glow;
      ring.arc.visible = !glow;
      ring.face.color.setHex(glow ? AXES[k].lit : AXES[k].ink);
      // AND THE KNOB STAYS UNDER THE HAND, which is the whole of what a handle
      // is for and what the flat widget never did: its angle was written once
      // into a static child offset, so it stood still while the part turned
      // beneath it. `swept` is the angle the hand has really travelled, so the
      // knob sits at its resting place plus that.
      ring.knob.rotation.z = DISC_AT
        + (drag && drag.axis === k ? drag.swept : 0);
    });
    return true;
  }

  /** The window listeners this gesture is followed with — the release and the
   *  cancel, and NOT the move.
   *
   * `pointermove` is on the window for the whole life of this widget, beside
   * `pointerdown`, because it answers two questions rather than one: where the
   * hand has carried a live drag, and which knob the cursor is standing on when
   * there is no drag at all. One listener and one handler rather than a second
   * of each, so there is one place where this widget learns where the pointer
   * is. `watchDrag` takes the handlers it is given, which is what lets this
   * gesture arm two of the three.
   */
  const watch = watchDrag({ onUp, onCancel });

  /** Let go of the gesture, wherever it ended. */
  const finish = () => {
    drag = null;
    watch.disarm();
    // The cursor goes back to answering the ray. Unconditional, because every
    // ending there is comes through here.
    widget.grabbed(false);
  };

  /** End the gesture and say which way the part ended up facing.
   *
   * ONE FUNCTION FOR EVERY ENDING THERE IS HERE — the release, a pointer the
   * platform took away, a second press arriving with one live, and the scene
   * being swapped out from under a hand that has not come off. The argument for
   * reporting from all four is one sentence: the part is already standing
   * turned where the reader left it, and only the document can be wrong about
   * that. A CUT is the other way round — `conclude` in tools.js reports from
   * two endings and stays silent on the rest, because announcing one disarms
   * the tool that placed it.
   *
   * ONLY IF THE GESTURE REALLY WAS A DRAG, which is the canvas gesture's rule
   * with the canvas gesture's meaning of `moved`: `CLICK_PX` of travel. A bare
   * press on a ring is not a statement, and the report would answer it by
   * writing a node.
   */
  const stop = () => {
    const live = drag;
    finish();
    if (!live) return;
    // AND THE HOVER DIES WITH THE GESTURE. `lit` is written only by a pointer
    // move with no drag running, so it still names the knob this gesture was
    // TAKEN on — and turning the part carries the hand off that knob within a
    // few degrees. Left standing, the frame below would draw the ring the
    // reader has just let go of as a full lit circle: on a mouse the next move
    // corrects that, on a touch there is no next move and it stays. Cleared
    // HERE and not in `finish`, because the two have to agree with the screen
    // and only this path ends in a frame — a hand that really is still on the
    // knob lights it again on its first move.
    lit = -1;
    // The ring goes back to a faded arc and the knob back to its resting angle,
    // and only a frame can say so: nothing else on this path asks the library
    // to draw.
    widget.refresh();
    if (live.moved) reportTurn(vp, live.turn);
  };

  function onMove(event) {
    const g = internals(vp.viewer);
    if (!drag) {
      // WHICH KNOB THE CURSOR IS ON, and whether the press it promises could
      // land. A hover is a promise that pressing HERE turns THIS axis; `onDown`
      // takes a press only off the canvas, because the toolbar, a comment pin
      // and the view cube are boxes that take their own. A knob lying under one
      // of those is geometrically under the cursor and is not pressable, so
      // lighting it would be the widget offering a gesture that then goes
      // somewhere else and turns nothing.
      const k = g && event.target === g.canvas ? aimed(g, event) : -1;
      if (k === lit) return;
      lit = k;
      // The library draws on demand, so the light has to ask for the frame that
      // shows it. Only on a CHANGE, which is what `lit` is held for: a pointer
      // crossing the canvas must not cost a render of the whole scene per event.
      widget.refresh();
      return;
    }
    if (!g) return;
    // A CLICK IS NOT A ONE-PIXEL DRAG, and `travelled` in drag.js is the rule
    // the canvas gesture applies as well. It matters more here than there,
    // because there IS no click on a ring — nothing selects, and the only thing
    // a twitch can do is turn the part a degree and file a node the reader
    // never asked for, which opens the panel on top of it.
    if (!travelled(event, drag)) return;
    drag.moved = true;
    const theta = ringAngle(vp, g, drag.axis, drag.centre, event);
    if (theta === null) return;
    // UNWRAPPED, because `atan2` comes back in `(-pi, pi]`: the step between
    // two events is taken modulo a full turn into `[-pi, pi)` and added up, so
    // `swept` is the angle the HAND really travelled — a gesture that goes
    // round twice says 720 — and a hand carried across the seam says nothing
    // special. That is also why the total is accumulated rather than measured
    // from the press each time.
    //
    // WHAT IT NO LONGER CHANGES IS THE ANSWER, and that is worth saying so
    // nobody looks for the difference in a test: the three angles below are
    // read back out of a ROTATION, which does not remember how many times round
    // anything went, so 720 and 0 land on the same triple and 270 lands on -90.
    // It IS what the knob is drawn at, though, and there the difference shows.
    const step = ((theta - drag.theta + HALF_TURN) % (2 * HALF_TURN)
      + 2 * HALF_TURN) % (2 * HALF_TURN) - HALF_TURN;
    drag.theta = theta;
    drag.swept += step;
    // WHOLE DEGREES, which is this gesture's `snap` and is here for the reason
    // that one is there: the number travels to an agent in a sentence, and
    // 31.7413 degrees claims a precision no hand has. A degree is the finest
    // unit anybody names an angle in, and it is the whole of the claim — the
    // row's own field steps by fifteen (`STEP_DEG` in HammerolaViewer.jsx),
    // because the angles a part is actually SET to are the corners and a degree
    // a click would be two dozen clicks to reach one. The two are different
    // tools for different jobs and do not land on one grid.
    const degrees = Math.round(drag.swept * DEGREES_PER_RADIAN);
    // A WORLD TURN ABOUT THE AXIS THE HAND IS ON, COMPOSED ONTO THE POSE THE
    // PART IS ALREADY STANDING AT — which is what the rings promise at the head
    // of this file and what adding the angle to one of the three cannot give.
    // `quaternionOf` reads the triple as `Rz·Ry·Rx`, so adding to the x field
    // is a turn about world x only while y and z are both zero: from
    // `(0, 0, 90)`, thirty added on x turns the part about world Y. The rings
    // are drawn on the WORLD axes and do not move with the part, so that is the
    // reader holding the red ring and watching the part spin around the green
    // one — on their second gesture, every time.
    //
    // THE SWEPT ANGLE IS A WHOLE NUMBER OF DEGREES AND THE THREE STORED ONES
    // WILL NOT BE, and that is the honest trade rather than a rounding that got
    // away. What the reader did is a whole number of degrees about the axis
    // they grabbed; what the fields then show is the orientation that produces
    // — thirty about x on top of `(0, 0, 90)` reads back as `(0, -30, 90)`.
    // That is what every CAD tool answers, and three fields that stayed round
    // could not describe the turn at all. `turnedFrom` is the document's own
    // door for this sum, `tidy` included, and the panel goes through the very
    // same one (`turnNodes`) so the preview and the document cannot drift.
    const d = drag.turn;
    const gesture = [0, 0, 0];
    gesture[drag.axis] = degrees;
    const turn = turnedFrom(d.base, gesture);
    if (turn[0] === d.last[0] && turn[1] === d.last[1]
        && turn[2] === d.last[2]) {
      // THE KNOB HAS MOVED EVEN THOUGH THE PART HAS NOT, which is most events
      // of a slow drag: `swept` is continuous and the part is turned in whole
      // degrees. The two calls below each end in a render of the library's own,
      // so this is the only branch with nothing else to ask for the frame.
      widget.refresh();
      return;
    }
    d.last = turn;
    // THE TWO MEANINGS, AND THE TWO CALLS THE OTHER HALF OF A PLACEMENT MAKES
    // (`onMove` in gizmo.js). A body of the proposal is turned for the eye
    // alone and NOTHING IS RECORDED for it — an angle in `vp.moved` would be
    // re-applied
    // on top of the `rot` the document will carry after the re-stage, and the
    // body would turn twice as far. A part of the build leaves `vp.moved`
    // behind, which is the pose the scene is really holding; `stood` is the
    // last turn that LANDED, a second field because `movePart` can refuse and
    // `last` has to advance whatever happens or a failed step is retried on
    // every event.
    if (d.body) {
      nudgeTurn(vp, d.paths, d.seats, turn);
      return;
    }
    // THE OFFSET IS PASSED BACK EXACTLY AS IT STOOD. `movePart` writes position
    // and orientation together on every call, so a turn that left the delta out
    // would send a part the reader had dragged home the instant they turned it.
    if (movePart(vp, d.paths, d.delta, turn)) d.stood = turn;
  }

  function onUp() {
    stop();
  }

  function onCancel() {
    stop();
  }

  /**
   * A press on the canvas, whether or not it landed on this widget: the two
   * OTHER gestures it strands, ended.
   *
   * THE COMPLETE LIST OF WHAT CAN BE LIVE, since one call reads as if it were
   * the whole of it: this widget's own drag (`stop()`), the arrows'
   * (`vp.gizmo.endDrag()`), the canvas gesture in tools.js — which is `onDown`'s
   * because only a press this widget KEEPS takes it away from that listener,
   * and which under `move` is EITHER a cut the hold key put up OR the ordinary
   * press that missed every piece of the widget: tools.js arms its watch on
   * that one too, and its release would otherwise land as a pick that changes
   * the selection out from under a live turn — and the section grip's,
   * deliberately left alone because it drives the clipping PLANE and nothing it
   * writes is anything this reads.
   *
   * WHY THE ARROWS' AND NOT ONLY OURS. Until the tools were merged the CROSS
   * case could not arise: this widget wanted `turn` and gizmo.js wanted `move`,
   * so only one of the two was ever alive to be interrupted. They answer to one
   * tool now, so a finger on an arrow followed by a finger on a knob leaves TWO
   * live drags — both `onMove`s on the window, neither filtering by pointer id,
   * each calling `movePart` with its own snapshot of the other's half of the
   * node. They overwrite each other frame by frame and both report at the
   * release. `gizmo.js`'s own `onDown` carries the argument at length.
   *
   * ON A PRESS THAT MISSES EVERY KNOB TOO, which is why this is a listener of
   * its own rather than the head of `onDown`: this is the reader putting a
   * second finger on the MODEL while an arrow is still held, which strands that
   * drag exactly as a press on a knob would.
   *
   * BEFORE ANY RECORD IS BUILT, which is what makes the hand-over clean:
   * concluding the arrow's drag leaves its offset standing in `vp.moved`, and
   * `turnRecord` reads that field for the `delta` it carries through — so the
   * turn about to start begins from where the slide actually ended.
   *
   * NO CHECK THAT THE NEIGHBOUR IS THERE: `element.js` builds the arrows and
   * then this widget inside ONE synchronous `connectedCallback`, so no press can
   * be dispatched between the two lines, and its `destroy()` leaves both fields
   * standing while taking both widgets' listeners away.
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
   * THE PRIMARY BUTTON AND NOTHING ELSE. The press is taken off the CANVAS, so
   * what this refuses really does go on to everything behind it: a right-drag
   * the reader meant as a pan is a pan, a right-click is the part menu over the
   * part the rings are standing round, and a middle click is whatever the
   * trackball makes of it.
   *
   * MEASURED ONCE AND HELD FOR THE WHOLE GESTURE, exactly as `onDown` in
   * gizmo.js holds its axis: the PLANE the angle is read in is the ring's, and
   * the ring the reader pressed is the ring the rest of the drag turns. What is
   * held is the axis and the part's centre — which is the whole of that plane,
   * because a turn about the part's own centre leaves the centre where it was.
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
    // AND THE CANVAS GESTURE, WHICH IS THE THIRD THING THAT CAN BE LIVE — here
    // and not in `handOver`, and the difference is exactly the press this
    // function keeps. tools.js finishes its own previous press at the head of
    // its `onDown`, and that listener DOES see every press aimed at the canvas,
    // so a press that misses every knob needs nothing from this line. It is the
    // refusal `scene3d.js` makes on our answer that opens the hole, by taking
    // the press away before that listener runs.
    //
    // AND MOVING IT UP WOULD BE WORSE THAN REDUNDANT. `endGesture` CONCLUDES,
    // and concluding a cut means `reportCut`, which the interface answers by
    // disarming the armed tool — which is why tools.js's own `onDown` stops
    // short of it. Called for every press, this would disarm the tool on every
    // ordinary canvas press with a cut drag still live.
    //
    // `vp.endGesture` IS ALWAYS A FUNCTION HERE. `installTools` assigns it in
    // the same synchronous `connectedCallback` that builds this widget, and
    // although its teardown nulls it — which `vp.gizmo` is not — that teardown
    // runs inside `destroy()`, in the same synchronous block that takes this
    // widget's window listeners away.
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
    // The ring lights up because it is being TURNED and not because the pointer
    // is over it, which is the only feedback a press with no hover behind it
    // gets — a touch, where there is no cursor to have crossed the knob first.
    widget.refresh();
    // From here the canvas wears `grabbing` until `finish`, whatever the ray
    // says: turning the part carries the hand off a 20 px knob within a few
    // degrees, and a cursor that went back to the default there would be saying
    // the drag had ended.
    widget.grabbed(true);
    return true;
  }

  /** End a drag the reader has not let go of, because the scene is going away.
   *
   * THE TWIN OF `vp.endGesture`, of the grip's `endDrag` and of the arrows',
   * and it exists for the failure all three were written for: the press was
   * taken in a window listener this widget owns, so neither that gesture nor
   * the idle clock that defers the swap ever saw it, and the release that would
   * have concluded it never comes. Concluding rather than abandoning, and the
   * reason is what ABANDONING costs: the part stands turned in `vp.moved` with
   * nothing in the document claiming it, and the next push straightens it under
   * the reader's hand.
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
      // `finish` and not `stop`: this is the widget going away, and `vp.moved`
      // goes with it, so the pose there would be to report is one nothing is
      // left standing at — the same ending tools.js's own teardown takes.
      finish();
      // AND THE TWO LIFELONG LISTENERS WITH IT, which the gesture's own are
      // not: these are on the window for the whole life of the widget rather
      // than for the length of a gesture, so a viewport unmounted with no drag
      // in progress would still leave them there holding a scene that is gone.
      removeEventListener("pointerdown", handOver, true);
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
