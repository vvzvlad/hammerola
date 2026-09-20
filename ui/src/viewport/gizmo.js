// The move tool's manipulator, less its rotation handles: an ORIGIN DOT at the
// selected part's centre, THREE AXIS ARROWS out of it along world +X, +Y and
// +Z, and THREE PLANE QUADS, one lying in each world plane. An arrow slides the
// part along THAT AXIS ONLY and a quad slides it in THAT PLANE — two axes at
// once with the third held. The dot is DRAWN AND NOT PRESSED: it marks the
// origin the six of them are measured from and answers no ray at all.
//
// ONE WIDGET, TWO FILES, ONE TOOL. The rotation handles are the fourth piece of
// the same manipulator and they live in rings.js, which answers to this same
// `move` tool: Fusion's triad is one command (`TriadCommandInput`) carrying an
// origin, three arrows, three quads and three rotation handles at once, and a
// reader who has to put a part down before they may turn it is reading half a
// widget. The two files stay two because what a press MEANS is the whole of
// what separates them — an angle about an axis is not a distance along one —
// and because they end their gestures differently.
//
// WHICH IS NOT THE SAME AS "THEY CANNOT COLLIDE", and that changed when both
// halves became objects in the scene. Every widget here reads its press off the
// CANVAS in a capture-phase listener on the window, so all of them see every
// press; what settles a contested one is the ORDER they were constructed in,
// since `stopImmediatePropagation` silences only what was registered later.
// `element.js` builds THESE FIRST, then the grip, then the rings, so a press
// two of them could take is this widget's; `tests/test_ui_source.py` holds all
// three pairwise orders, because a listener carries nothing that says whose it
// is. The paint says the same thing the other way up — `GIZMO_ORDER` is the
// topmost band in scene3d.js — so what the reader sees on top is what answers.
//
// WHY IT EXISTS. The Move tool used to drag a part freely in the plane of the
// screen, off a press on the part itself, which is the right gesture for "put
// it about there" and the wrong one for every sentence that names a direction —
// "three millimetres further out", "up off the plate". Under an ortho camera a
// free drag can produce a delta on all three axes at once, and nothing in the
// hand can say which of them the reader meant. Blender's answer is this widget,
// and it is the one readers arrive already knowing. IT IS THE WHOLE GESTURE
// NOW: the free drag is gone (tools.js), so an armed tool no longer costs the
// reader the orbit, and a press anywhere but on a piece of this widget means
// what it means with no tool up.
//
// OBJECTS IN THE SCENE AND NOT A LAYER OF DIVS OVER IT, which is what makes an
// arrow point along its axis rather than along a picture of it. `scene3d.js`
// carries the half that is shared with the grip and the rings, and everything
// it says about why a widget lives in the scene applies here seven times over:
// drawn flat, every question this file asked was a question about the SCREEN —
// where each axis projects, how much of it survives, what 2x2 matrix draws a
// square lying in a world plane — and each of those had to be computed, guarded
// and floored. A cylinder standing on the part along a world axis is projected
// by the camera like everything else, so `axisOnScreen` and `reach` are gone
// with the representation and what is left of them is two components of
// `cameraBasis().view`.
//
// EVERY NUMBER A DRAG PRODUCES COMES FROM tools.js, and none of that moved.
// Each constrained delta is the unconstrained world displacement the hand spans
// put back on the piece's own geometry — an arrow takes the NEAREST POINT of
// its line, a quad takes the point where the ray through the cursor MEETS its
// plane, and the difference is not arbitrary: a plane and a ray meet and a line
// and a ray do not, so only one of the two can promise the reader that the part
// follows the pointer exactly. From there both are the same `niceStep`, the
// same `snap`, the same `movePart`/`nudgePart`, the same `stood`/`last`
// distinction and the same `reportMove` — so a part dragged by an arrow and one
// dragged by a quad reach the proposal document as the same kind of sentence. A
// second copy of any of that would not fail; it would drift, which is worse.

import { cameraBasis, ndcAt, ndcOffset } from "./camera.js";
import { travelled, watchDrag } from "./drag.js";
import { internals } from "./internals.js";
import { dot3 } from "./math.js";
import { grabbable, movePart, nudgePart, partCentre } from "./parts.js";
import { GIZMO_ORDER, createScene3D, widgetMaterial } from "./scene3d.js";
import { moveRecord, niceStep, reportMove, snap } from "./tools.js";
import {
  GIZMO_CASE_PX, GIZMO_DOT_PX, GIZMO_HEAD_PX, GIZMO_HIT_PX, GIZMO_MIN_SCALE,
  GIZMO_PLANE_GAP_PX, GIZMO_PLANE_PX, GIZMO_PX, GIZMO_RIM_PX, GIZMO_SHAFT_PX,
} from "./options.js";

/** The three axes, in the order they are drawn and in the colours everything
 *  that draws an axis triad uses.
 *
 * RED, GREEN, BLUE FOR X, Y, Z is not a palette choice — it is the convention
 * every CAD and DCC tool the reader has already used spells its axes in, so it
 * is the one thing about this widget nobody has to be told. `rings.js` carries
 * the same three, as the same hexes, and `rings.test.js` pins that they still
 * agree: two halves of one widget in two palettes would be two triads.
 */
const AXES = [
  { world: [1, 0, 0], ink: 0xc93a31 },
  { world: [0, 1, 0], ink: 0x2e8b40 },
  { world: [0, 0, 1], ink: 0x2d66c7 },
];

/** The two inks the CONSTRUCTION is made of, which are not a palette.
 *
 * `rings.js` spells the same pair for the same job and `RING_CASE_PX` carries
 * the argument: a light casing inside a dark rim is the only legibility that
 * survives a red mark on a red part over two canvases, and it is CONSTRUCTION
 * rather than colour. It is what every piece of this widget now wears — the
 * arrows included, which used to bring their own contrast as a CSS `filter`.
 * A filter is a picture over a box and there is no box any more, so the one
 * mechanism does for all seven.
 */
const CASING = 0xffffff;
const RIM = 0x14181c;

/** The three world planes, as the index of the axis each is NORMAL TO.
 *
 * WHICH IS ALSO THE COLOUR IT IS DRAWN IN — the XY quad is blue because Z is
 * the axis it holds still, which is the convention every tool that draws plane
 * handles uses and the one thing about them nobody has to be told.
 *
 * AND THE TWO AXES IT LIES IN ARE THE OTHER TWO, `u = (k + 1) % 3` and
 * `v = (k + 2) % 3`, exactly as `rings.js` takes the pair that spans a ring's
 * plane. Nothing here depends on the ORDER of the two — a quad is a shape and
 * not a signed rotation — but taking them cyclically keeps one rule in the two
 * files that need one.
 */
const spanOf = (k) => [(k + 1) % 3, (k + 2) % 3];

/** The three bands every piece of this widget is drawn in, OUTERMOST FIRST, and
 *  the order they are painted in — the dark rim under the white casing under
 *  the ink, which is `BANDS` in rings.js and `grow` in handle.js.
 *
 * TWO SEQUENCES AND NOT ONE, because a body and a flat shape grow opposite
 * ways. An arrow's three bands are three arrows about ONE axis, each standing
 * `grow` further out than the ink; a quad's and the dot's are filled shapes
 * sharing an OUTER edge, each `sink` inside the one before it.
 *
 * `colour: null` IS THE PIECE'S OWN INK, which is the one of the three that is
 * not the same on all of them.
 */
const BANDS = [
  { colour: RIM, grow: GIZMO_CASE_PX + GIZMO_RIM_PX, sink: 0 },
  { colour: CASING, grow: GIZMO_CASE_PX, sink: GIZMO_RIM_PX },
  { colour: null, grow: 0, sink: GIZMO_RIM_PX + GIZMO_CASE_PX },
];

/** How round a shaft and a head are. Twelve is handle.js's number for the same
 *  2 px width, and the argument is that file's: it is where a cylinder two
 *  pixels across stops reading as a polygon at any angle. */
const SIDES = 12;

/** ...and how round the origin dot is, which is six times as wide: at
 *  twenty-four a 12 px disc departs from its own circle by a twentieth of a
 *  pixel at the worst point, which is `rings.js`'s sum for its knob. */
const DOT_SIDES = 24;

/** What a piece that is only ever LOOKED at answers a ray with: nothing.
 *
 * ONE MESH PER PIECE TAKES THE PRESS, and in this representation that has to be
 * said to the raycaster rather than assumed — three tests an object's LAYERS
 * and never its visibility, so every band of every arrow would otherwise be a
 * target standing in front of its neighbours. `Object3D.prototype.raycast` is
 * three's own empty base, which `Mesh` overrides; putting it back on an
 * instance is how a mesh is drawn and never hit.
 */
const NO_HIT = () => {};

/** Which piece a press belongs to when a ray finds more than one, LOWEST FIRST.
 *
 * NOT THE NEAREST HIT, which is what `intersectObject` would answer and is a
 * coin toss where the pieces cross — on a camera that has turned a quad nearly
 * end-on it lies within a few pixels of the two arrows that span it. The flat
 * widget decided this by build order: a quad was solid all the way to its edges
 * and an arrow's box was mostly empty, so the reader got the thing they could
 * see filled in. That is the rule kept here, said as a rank instead of as a
 * stacking order.
 *
 * THE DOT IS IN NEITHER, because it answers no ray: it is drawn and never
 * pressed, so it has no rank to hold.
 */
const RANK = { plane: 0, axis: 1 };

/**
 * Where an ARROW drag lands: the offset already standing, with the component
 * along `axis` of the hand's own world displacement added to it and snapped.
 *
 * THE NEAREST POINT OF THE LINE, which is the honest description of this and
 * the one thing it does NOT share with `acrossPlane`. A plane meets the ray
 * through the cursor in a point, so a quad can put the grabbed point back under
 * the pointer exactly; a line and a ray in three dimensions miss each other, so
 * an arrow has no such point and answers with the place on its own line that
 * comes closest to where the hand went. The two are different constructions
 * rather than two halves of one.
 *
 * ONLY ON THE AXIS THE HAND IS ON. The other two components are handed through
 * untouched rather than passed through `snap` with nothing added to them,
 * because an offset already standing need not be on this grid at all: it
 * arrives from the proposal document, whose `delta.<axis>` fields are typed by
 * hand. Rounded here, a drag along X would quietly move the part along Y as
 * well — a number the reader wrote as 12.3 coming back as 12.5, reported as
 * part of a gesture that never touched it.
 *
 * `sine^2` DIVIDES, and that is the whole of direct manipulation here. The
 * world vector a screen displacement spans lies IN the plane of the screen, so
 * of the axis it only ever sees the part that lies there too — length `sine`.
 * Walk the part by `t` and its projection moves by `t * sine`; dot that with
 * the axis and another factor of `sine` comes off, so a bare dot answers
 * `t * sine^2`. Taken as `t`, the part crawls behind the cursor by exactly that
 * factor — two thirds of the travel lost on an ordinary three-quarter view.
 */
function alongAxis(base, world, axis, sine, step) {
  const along = dot3(world, axis) / (sine * sine);
  return base.map((v, i) => (axis[i] ? snap(v + axis[i] * along, step) : v));
}

/**
 * Where a QUAD drag lands: the same offset with the hand's world displacement
 * added to it on the plane's two axes, and the third left exactly as it was.
 *
 * THE PART FOLLOWS THE POINTER, which is the whole of what this gesture owes
 * and is NOT what the orthogonal projection gives. `w - n (w . n)` is the
 * nearest point of the plane to where the bare displacement would put the part,
 * and it is the right answer only when the plane faces the reader; anywhere
 * else the part lags the hand by the component it threw away. Under this
 * viewport's ortho camera every pixel looks along one fixed direction `view`,
 * so two world
 * points project to the same pixel exactly when they differ by a multiple of
 * it. The displacement that lands the grabbed point back under the cursor while
 * staying in the plane is therefore the one point of the ray through the moved
 * cursor that lies in the plane through where the drag started:
 *
 *     p = w - view * (w . n) / (view . n)
 *
 * — which satisfies `p . n = 0`, so it stays in the plane, and `p - w` is
 * parallel to `view`, so it projects to exactly where `w` did. `alongAxis`
 * cannot be written this way and should not be: a line and a ray in three
 * dimensions do not meet, so an arrow has no point to take and takes the
 * NEAREST point of its line instead. That is the honest difference between the
 * two, and they are not two halves of one decomposition.
 *
 * THE DIVISION CANNOT BLOW UP, and the fence is the one `place` already puts
 * up rather than a guard of this function's own. `view . n` is the cosine
 * between the plane's normal and the camera's projection axis, which is exactly
 * the `face` that decides whether the quad is drawn at all — so a quad a ray
 * can land a press on was drawn with `|face| >= GIZMO_MIN_SCALE`, a fifth, and
 * the factor `1 / (view . n)` is at most FIVE. An edge-on plane has no in-plane
 * answer to give at all — every point of it projects onto one line, so "put the
 * grabbed point back under the pointer" stops naming a point — and the widget's
 * response is to take the target away rather than to invent an answer.
 * `gizmo.test.js` pins the two as one number.
 *
 * TO THE FRAME, WHICH IS THE HONEST STATEMENT OF IT. The bound is written by
 * the last `place` before the press and the divisor is read by `onDown` at the
 * press, so what the fifth really bounds is the camera one frame ago; a camera
 * that moved in between moved by at most a frame of it. Reaching zero from the
 * floor would take 11.5 degrees inside 16 ms, which is not a gesture. This is
 * the same standing assumption the arrow beside it makes — `place` draws at
 * `sine >= GIZMO_MIN_SCALE` and `onDown` re-measures and asks only `> 0`.
 *
 * THE SIGN OF `view` DOES NOT MATTER: it appears once above and once below the
 * line, so reversing it leaves `p` unchanged.
 *
 * EVERYTHING AFTER IT IS THE ARROW'S: the same `niceStep`, the same `snap` (two
 * numbers now instead of one), and the same rule about the axis that is HELD —
 * handed through untouched rather than passed through `snap` with nothing added
 * to it, because an offset already standing arrives from the proposal document
 * and need not be on this grid at all.
 */
function acrossPlane(base, world, normal, view, step) {
  const out = dot3(world, normal);
  const into = dot3(view, normal);
  // `inPlane` AND NOT `held`, which is taken: `held()` in this file is the
  // selection the widget stands on, and two different things under one name is
  // how the wrong one gets read — the same objection `moveRecord` in tools.js
  // makes to calling its `already` field `stood`.
  const inPlane = world.map((v, i) => v - view[i] * (out / into));
  return base.map((v, i) => (normal[i] ? v : snap(v + inPlane[i], step)));
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
  // A RAYCASTER OF OUR OWN, beside the one `scene3d.js` keeps, and the two ask
  // different questions of the same ray: that one asks whether ANY of this
  // widget is under the pointer, which is all a cursor needs, and this one asks
  // WHICH OF THE SIX — the question only a widget made of separable pieces
  // has, and the one `RANK` above answers. Six and not seven: the dot is drawn
  // and never pressed, so it is in neither this map nor that ladder.
  let group = null;
  let raycaster = null;
  let pointer = null;

  /** The three arrows and the three quads: `{kind, axis, world, node}`.
   *
   * `kind` IS READ IN TWO PLACES AND BOTH MATTER. `onMove` picks the
   * arithmetic — `alongAxis` or `acrossPlane`. `onDown` decides what is
   * MEASURED at the press: both kinds take the camera basis — which the QUAD
   * divides by directly, as `view . n`, and which the arrow's own `sine` is
   * measured against rather than divided by — and `=== "axis"` takes that
   * `sine` on top of it. A quad's divisor is deliberately NOT measured there,
   * because `place` has already fenced it.
   *
   * `world` is the axis an arrow is constrained to and the NORMAL a quad holds
   * still.
   *
   * `dot` IS THE BARE NODE and not a piece, because it takes no press: what is
   * done to it is drawing it and turning it to face the reader.
   */
  let arms = [];
  let quads = [];
  let dot = null;

  /** Which piece each pressable mesh belongs to. */
  const targets = new Map();

  // The gesture in progress: which piece it is on, how much of that piece's own
  // axis the camera leaves (`sine`, measured once at the press and meaningless
  // on a quad, the only other kind), the camera's projection axis, where the
  // press landed, the move record it is applying, and whether the pointer has
  // travelled far enough to be a drag at all. Null between gestures.
  let drag = null;

  /**
   * The selection this widget stands for, or null when there is nothing to put
   * it on.
   *
   * `grabbable` IN parts.js IS THE WHOLE OF IT — the same question `held` in
   * rings.js asks, which is why it is one function and why parts.js calls it
   * the one question BOTH HALVES of the manipulator ask: a piece offering a
   * move that the press would then refuse is a promise the widget cannot keep,
   * and two halves of ONE widget
   * that came up on different conditions would be a widget with a piece
   * missing.
   *
   * `activeTool` AND NOT `state.tool`, for the reason tools.js gives: the hold
   * key puts the cut up without writing to `state`, and a widget left standing
   * under a cut gesture would be offering a move the press is no longer for.
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
   * `visible = false` AND NOT a transparent material, which is handle.js's
   * reading one storey down: three's raycaster tests an object's LAYERS and
   * never its visibility, so this costs no draw call, no blend and nothing for
   * the renderer to sort.
   *
   * AND THE PIECE'S OWN FLAG IS ASKED HERE, because the same blindness applies
   * to it: `place` takes an arrow seen end-on and a quad seen edge-on off the
   * screen by clearing `node.visible`, and no raycaster consults that either.
   * TWO of them cast at this group — `aimed` below, for which piece the hand is
   * on, and `scene3d.js`'s, for the cursor — and the second knows nothing of
   * this widget's structure, so a floor applied anywhere but here would leave
   * the canvas wearing `grab` over a target nobody can see, promising a grab
   * the press then refuses.
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
   * The seven pieces, in CSS pixels — `scene3d.js` scales the group so that one
   * unit of this geometry is one pixel on the canvas, which is what keeps the
   * widget the same size on a 2 mm part and a 200 mm one.
   *
   * A NESTED `Object3D` AND NEVER A `Group`: three re-reads `renderOrder` as
   * the group order at every `Group` it walks into, so a group here would drop
   * this whole widget out of the bucket `scene3d.js` put it in and back behind
   * the model.
   *
   * THE LADDER RUNS ACROSS THE PIECES AND NOT ONLY INSIDE ONE, which is what
   * decides every overlap the widget has with itself: the arrows at the bottom,
   * the quads over them, the dot over both. It is the flat widget's build order
   * said in the only terms this representation has — an arrow's shaft is 2 px
   * of ink and a quad and the dot are filled to their edges, so where one
   * crosses the other the reader sees the thing they can aim at.
   */
  function build(three, grp) {
    group = grp;
    raycaster = new three.Raycaster();
    pointer = new three.Vector2();
    // +Y IS THE AXIS THREE GIVES A CYLINDER AND A CONE, so one rotation from it
    // onto the world axis orients the whole arrow — handle.js's construction,
    // with one head instead of two because an axis arrow points AWAY from the
    // part along the direction its axis is named for.
    const up = new three.Vector3(0, 1, 0);
    arms = AXES.map(({ world, ink }, k) => {
      const node = new three.Object3D();
      node.quaternion.setFromUnitVectors(up, new three.Vector3(...world));
      const piece = { kind: "axis", axis: k, world, node };
      let paint = null;
      BANDS.forEach(({ colour, grow }, at) => {
        const material = widgetMaterial(three, colour === null ? ink : colour);
        // THE HEADS ARE AS LONG AS THEY ARE WIDE and sit at the TIP, so the
        // outermost point of the ink is exactly `GIZMO_PX` from the part's
        // centre and the casing stands `grow` proud of it on every side.
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
      // THE TARGET IS FAT AND THE INK IS THIN, which is the requirement the DOM
      // box carried and the reason `GIZMO_HIT_PX` survives the move: a hand
      // cannot reliably hit a 2 px shaft.
      //
      // AND IT STARTS AT THE DOT'S RIM rather than at the part's centre, which
      // leaves the central 12 px answering no ray whatever: the dot is drawn
      // there and takes no press, and three cylinders crossing under it would
      // make the one place the reader cannot tell the axes apart the easiest
      // place to grab one of them by accident.
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
      // LOCAL X ONTO `u`, LOCAL Y ONTO `v` AND LOCAL Z ONTO THE NORMAL, which
      // is `oriented` in rings.js asked about a flat shape: three builds a
      // plane in its own XY, so this is what makes the square lie IN the world
      // plane its axis is normal to and foreshorten with it.
      node.quaternion.setFromRotationMatrix(new three.Matrix4().makeBasis(
        new three.Vector3(...AXES[i].world),
        new three.Vector3(...AXES[j].world),
        new three.Vector3(...AXES[k].world)));
      // THE NEAR CORNER STANDS `GIZMO_PLANE_GAP_PX` OUT ALONG BOTH SPANNING
      // AXES, which is what keeps the quad off the blot where the three shafts
      // cross; the node itself sits at the square's middle, half a side further
      // on.
      const middle = GIZMO_PLANE_GAP_PX + GIZMO_PLANE_PX / 2;
      const at = [0, 0, 0];
      at[i] = middle;
      at[j] = middle;
      node.position.set(at[0], at[1], at[2]);
      const piece = { kind: "plane", axis: k, world: AXES[k].world, node };
      let paint = null;
      BANDS.forEach(({ colour, sink }, band) => {
        const material = widgetMaterial(three, colour === null ? ink : colour);
        // SEEN FROM EITHER SIDE, because a world plane is: the reader orbits
        // past it and a single-sided square would simply vanish halfway round.
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
    // THE DOT IS THE ONE PIECE WITH NO AXIS IN IT, and it is the origin the
    // other six are measured from rather than a gesture: it is BILLBOARDED —
    // `place` copies the camera's own orientation onto it — and shows the
    // reader a circle rather than a foreshortened anything.
    //
    // AND IT IS GIVEN NO `target`, which is the whole of it taking no press. It
    // used to be the free drag's own handle; nothing that only looks at the
    // reader may wear a cursor or swallow a press for a gesture it will not
    // perform, so the ray passes through it — to an arrow if one is under it,
    // and otherwise to the canvas, where a drag orbits as it always did.
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
   * BY RANK AND NOT BY DISTANCE — `RANK` above says why, and this is the single
   * answer to it, so the cursor `scene3d.js` offers and the piece a press takes
   * cannot disagree about what is under the hand.
   */
  function aimed(g, event) {
    if (!group || !group.visible || !raycaster) return null;
    const ndc = ndcAt(g.canvas, event);
    if (!ndc) return null;
    pointer.set(ndc[0], ndc[1]);
    raycaster.setFromCamera(pointer, g.cam);
    // A press does not know which frame it is standing on — `scene3d.js` says
    // why this one matrix compose is cheaper than having to.
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
   * ON THE WORLD AXES AND NOT THE PART'S, which is what this gesture has always
   * meant: the arrows say which way the part will go, and a widget that adopted
   * the part's own orientation would be answering a different question. So the
   * only thing this writes on the group is WHERE it stands, and the only thing
   * it writes on a piece is whether it is drawn — except the dot, which is
   * turned to face the reader.
   *
   * READ OFF THE SCENE EVERY FRAME AND NOT OUT OF THE MOVE RECORD, which is the
   * whole of whether this is a widget the reader is holding or a picture beside
   * one. The record's `base` is where the drag STARTED; the part is somewhere
   * else for the length of the gesture, and arrows anchored on the record would
   * stand still while the part slid out from under them and then jump to catch
   * up at the release. `handle.js`'s `anchor()` argues exactly this about the
   * plane, and `rings.js`'s `place` about the centre it turns about.
   *
   * THE FIRST SELECTED PATH, which is the same anchor the press takes: a row
   * standing for five copies of a part moves as one thing, and the widget has
   * to stand on one of them rather than between them.
   */
  function place(root, g) {
    const sel = held();
    if (!sel) return false;
    const at = partCentre(vp.viewer, sel.paths[0]);
    if (!at) return false;
    const basis = cameraBasis(vp.viewer, g);
    if (!basis) return false;
    root.position.set(at[0], at[1], at[2]);
    // ONE COMPONENT OF `view` FOR EACH OF THE SIX, which is the whole of what
    // the projection used to be asked for. An axis and the plane square on to
    // it are the two readings of ONE angle: `|view[k]|` is the fraction of the
    // plane that survives the projection and `sqrt(1 - view[k]^2)` the fraction
    // of the axis, so they are never both gone and never both at full.
    arms.forEach((arm, k) => {
      // NEARLY END-ON IS GONE, not shortened — `GIZMO_MIN_SCALE` carries the
      // argument: the drag divides by `sine^2`, so past the floor a steady hand
      // is a jump of several snap steps rather than a stuck arrow.
      const cos = Math.abs(basis.view[k]);
      arm.node.visible = Math.sqrt(1 - cos * cos) >= GIZMO_MIN_SCALE;
    });
    quads.forEach((quad, k) => {
      // NEARLY EDGE-ON IS GONE, not flattened, and this line IS THE WHOLE FENCE
      // ROUND `acrossPlane`'s DIVISION: that drag divides by `view . n`, which
      // for a world plane is exactly the component read here — so hiding the
      // quad is what keeps the divisor at or above a fifth and the factor at or
      // below five, for every quad a ray can land a press on. Below the floor
      // there is no answer to fence: an edge-on plane projects onto a single
      // line, so "put the grabbed point back under the pointer" stops naming a
      // point at all. The legibility reason is the same answer again — a square
      // seen edge-on is a sliver lying across the two arrows that span it.
      quad.node.visible = Math.abs(basis.view[k]) >= GIZMO_MIN_SCALE;
    });
    // TURNED TO FACE THE READER, once per frame, because a flat disc standing
    // in the world would foreshorten to a line on some camera and this is the
    // one piece that stands for no direction at all. The group carries position
    // and a uniform scale only, so the camera's own orientation IS the
    // orientation that squares this circle to the screen.
    dot.quaternion.copy(g.cam.quaternion);
    return true;
  }

  /** The window listeners this gesture is followed with, which `drag.js` says
   *  why are on the window and in the capture phase. */
  const watch = watchDrag({ onMove, onUp, onCancel });

  /** Let go of the gesture, wherever it ended. */
  const finish = () => {
    drag = null;
    watch.disarm();
    // The cursor goes back to answering the ray. Unconditional, because every
    // ending there is comes through here.
    widget.grabbed(false);
  };

  /** End the gesture and say where the part ended up.
   *
   * ONE FUNCTION FOR EVERY ENDING THERE IS HERE — the release, a pointer the
   * platform took away, a second press arriving with one live, and the scene
   * being swapped out from under a hand that never came off. ALL FOUR REPORT,
   * which is the opposite of what the section drag does with three of its own
   * (`conclude` in tools.js), and the asymmetry is deliberate: the part is
   * already standing where the reader dragged it, so an ending that said
   * nothing would leave it displaced with no node in the document claiming it,
   * and the next push would send it home under the reader's hand.
   *
   * ONLY IF THE GESTURE REALLY WAS A DRAG, which is the canvas gesture's rule
   * (`if (p.moved)`) with the canvas gesture's meaning of `moved`: `CLICK_PX` of
   * travel, not one pixel of it (`onMove` below). A bare press on an arrow is
   * not a placement, and `reportMove` would answer it by writing a node.
   */
  const stop = () => {
    const live = drag;
    finish();
    if (live && live.moved) reportMove(vp, live.move);
  };

  function onMove(event) {
    if (!drag) return;
    // A CLICK IS NOT A ONE-PIXEL DRAG, and `travelled` in drag.js is the rule
    // the canvas gesture applies as well. It matters more here than there,
    // because there IS no click on an arrow — nothing selects, and the only
    // thing a twitch can do is snap the part one step and file a move node the
    // reader never asked for, which opens the panel on top of it.
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
    // THE UNCONSTRAINED DISPLACEMENT, PUT BACK ON THE PIECE'S GEOMETRY — which
    // is what "along one axis" and "in one plane" mean here. The world vector a
    // screen displacement spans is the difference of the two ends' `ndcOffset`
    // readings, exactly as the swipe pan computes it, and under ortho that is
    // depth-free. Starting from it is what gets the px-per-world-unit scale,
    // the zoom and the pan right without asking about any of them.
    //
    // THE TWO CONSTRUCTIONS ARE NOT ONE, and the docblocks say why at length:
    // an arrow takes the nearest point of its LINE, because a line and the ray
    // through the cursor do not meet, while a quad takes the point where that
    // ray CUTS its plane, because a plane and a ray do.
    //
    // WHICH IS ALSO WHY AN AXIS SEEN END-ON IS NOT DRAWN. `alongAxis` divides
    // by `sine^2`, so the nearer the axis comes to pointing at the reader the
    // more world the same pixel of hand buys — at the floor `GIZMO_MIN_SCALE`
    // puts under it, twenty-five times — and past that a steady hand is a jump
    // of several snap steps (`GIZMO_MIN_SCALE` in options.js carries this). A
    // quad divides too, by `view . n`, and the SAME floor bounds that one at a
    // fifth (`place`).
    const from = ndcOffset(g, b.eye, b.view, d.ndc[0], d.ndc[1]);
    const to = ndcOffset(g, b.eye, b.view, ndc[0], ndc[1]);
    if (!from || !to) return;
    const world = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    // THE STEP AND THE SNAP ARE tools.js's, so a move made with an arrow and
    // one made with a quad land on the same numbers in `vp.moved`, on the event
    // and in the proposal document — and so does a turn made with a disc.
    //
    // UNLESS THE INTERFACE HAS SET ONE FOR THIS PATH (`setSnapSteps` in
    // element.js), which is the reader saying that what the grid gives is too
    // coarse for the part in their hand. Asked of the ANCHOR, the path the
    // widget is drawn on: one gesture carries the whole row by one delta, so a
    // step per copy would be several answers to one question.
    const asked = vp.snapSteps.get(d.paths[0]);
    const step = asked > 0 ? asked : niceStep(viewer);
    const delta = drag.piece.kind === "axis"
      ? alongAxis(d.base, world, drag.piece.world, drag.sine, step)
      : acrossPlane(d.base, world, drag.piece.world, drag.view, step);
    if (delta[0] === d.last[0] && delta[1] === d.last[1]
        && delta[2] === d.last[2]) return;
    d.last = delta;
    // THE TWO MEANINGS, AND THE TWO CALLS THEY PART INTO. A body of the
    // proposal is moved for the eye alone and NOTHING IS RECORDED for it — a
    // delta in `vp.moved` would be re-applied on top of the position the
    // document will carry after the re-stage, and the body would walk away by
    // twice the distance. A part of the build leaves `vp.moved` behind, which is
    // the offset the scene is really holding; `stood` is the last delta that
    // LANDED, a second field because `movePart` can refuse and `last` has to
    // advance whatever happens or a failed step is retried on every event.
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
   * THE PRIMARY BUTTON AND NOTHING ELSE. The press is taken off the CANVAS, so
   * what this refuses really does go on to everything behind it: a right-drag
   * the reader meant as a pan is a pan, a right-click is the part menu over the
   * part the arrows are standing on, and a middle click is whatever the
   * trackball makes of it.
   *
   * WHAT KEEPS THE RINGS' PRESS APART FROM THIS ONE IS NOT THE TARGET ANY MORE.
   * While these were boxes over the canvas, a press on one failed rings.js's
   * own `event.target !== g.canvas` and was declined there by construction.
   * Both widgets read the same node now, so the separation is: each answers
   * only for a ray that landed on its OWN meshes, and where two really do
   * overlap the ORDER `element.js` builds them in decides — these are built
   * first, so `stopImmediatePropagation` here silences the rings and not the
   * other way about. `tests/test_ui_source.py` holds that order.
   *
   * MEASURED ONCE AND HELD FOR THE WHOLE GESTURE, exactly as `onDown` in
   * handle.js takes the plane's screen axis and `onDown` in rings.js its ring:
   * the camera cannot move under a press this widget owns, and re-measuring per
   * event would let the part drift away from the hand.
   */
  function onDown(event, g) {
    if (event.button !== 0) return false;
    const piece = aimed(g, event);
    if (!piece) return false;
    // A previous gesture is concluded before a new one begins, which tools.js
    // does too at the head of its own `onDown` — though only as a bare
    // `finish()`, since no gesture it still carries moves a part. Here there
    // are two reasons rather than one: a second pointer landing on a piece
    // would otherwise overwrite the press point with its own, and the part it
    // interrupted is standing somewhere no node claims.
    stop();
    // AND THE ROTATION HANDLES' GESTURE WITH IT, which is the same sentence
    // about the other half of this widget. The line above treats a second
    // pointer as real input — that is this file's standing decision — and both
    // halves answer to ONE tool, so a finger on a knob followed by a finger on
    // an arrow leaves TWO live drags.
    //
    // AND TWO ARE WORSE THAN A STALE ONE. Both widgets' `onMove` is on the
    // window and neither filters by pointer id, so both run on every move; each
    // then calls `movePart`, which writes position AND orientation together
    // from ITS OWN snapshot of the other's half — `moveRecord.turn` is the turn
    // as it stood at this press, `turnRecord.delta` the offset as it stood at
    // that one — so the two overwrite each other frame by frame, and both
    // report at the release.
    //
    // `endDrag` IS THE DOOR THE SYSTEM ALREADY HAS: every widget publishes one,
    // `element.js` calls all three when the scene is pulled out from under a
    // hand, and it CONCLUDES rather than abandons — which is the whole reason
    // the line above is `stop()` and not `finish()`, and what `endDrag` below
    // spells the cost of.
    //
    // AND IT IS THIS FILE'S JOB rather than `handOver`'s in rings.js, because a
    // press this widget keeps never reaches that listener at all: it was
    // registered LATER, and `scene3d.js` refuses the event with
    // `stopImmediatePropagation`.
    //
    // NO CHECK THAT THE NEIGHBOUR IS THERE, and that is a fact about
    // `element.js` rather than optimism. It builds this widget and then the
    // rings inside ONE synchronous `connectedCallback`, so no press can be
    // dispatched between the two lines; and its `destroy()` leaves both fields
    // standing while taking both widgets' listeners away, so a press cannot
    // reach this function at a moment when `vp.rings` is not set.
    vp.rings.endDrag();
    // AND THE CANVAS GESTURE, WHICH IS THE THIRD THING THAT CAN BE LIVE. Here
    // is the complete list, because the two lines above read as if they were
    // the whole of it and they are not:
    //
    //   1. this widget's own drag                    — `stop()` above
    //   2. the rotation handles' drag (rings.js)     — `vp.rings.endDrag()`
    //   3. the canvas gesture (tools.js `press`)     — this line
    //   4. the section grip's drag (handle.js)       — deliberately left alone
    //
    // THREE IS THE ONE A PRESS HERE CANNOT OTHERWISE END. tools.js finishes its
    // own previous press at the head of its `onDown` — and that listener DOES
    // see every press aimed at the canvas, so a press this widget declines
    // needs nothing from this line. What opens the hole is the refusal
    // `scene3d.js` makes on our answer: a press this widget KEEPS never reaches
    // that listener, so a cut a first finger started under the hold key stays
    // live, dragging the clipping plane on every move the second finger makes.
    //
    // FOUR IS A DIFFERENT KIND AND IS WHY THE LIST IS WORTH WRITING OUT. The
    // grip drags the clipping PLANE, and a cut can stand while Move is armed
    // (element.js says so where it builds the three), so it really can be live
    // at the same time — but it writes the library's clip slider and this
    // writes the part, and nothing either touches is anything the other reads.
    // Two of them running is two different things moving, not one thing written
    // twice from two stale snapshots, which is the failure the other three
    // share.
    //
    // `vp.endGesture` IS ALWAYS A FUNCTION HERE, checked the way the neighbour
    // above was. `installTools` assigns it in the same synchronous
    // `connectedCallback`, later than this widget is built but long before any
    // press; and although its teardown NULLS it — which `vp.rings` is not —
    // that teardown runs inside `destroy()`, earlier in the same synchronous
    // block that takes this widget's listeners away.
    //
    // WHAT IT COSTS, SAID OUT LOUD: `endGesture` CONCLUDES, and for a cut
    // gesture concluding means `reportCut`, which the interface answers by
    // disarming the armed tool. tools.js's own `onDown` stops short of that on
    // purpose (`conclude`), and it has no published door that does. The
    // sequence it takes is narrow — a hold-key cut press still down, the key
    // released mid-drag so this widget reappears, and then a second finger on a
    // piece — and the alternative is leaving that drag live, which is the
    // reachable corruption above.
    vp.endGesture();
    const sel = held();
    if (!sel) return false;
    const ndc = ndcAt(g.canvas, event);
    if (!ndc) return false;
    // THE ANCHOR IS THE FIRST SELECTED PATH, the same one `place` stands the
    // widget on: the cursor is on a widget rather than on a part, and the row
    // converges onto whichever copy is named (`movePart`), so the one the
    // widget is drawn from is the only answer that does not move the thing the
    // reader is aiming at.
    //
    // WHAT EACH KIND MEASURES AT THE PRESS, and the two differ exactly as much
    // as their arithmetic does. Both want the camera's own projection direction
    // — `acrossPlane` meets the ray through the cursor with the plane along it,
    // and an arrow's foreshortening is the angle against it. `cameraBasis`
    // builds a fresh array every call, so holding this one cannot be holding
    // something the library will move underneath.
    const basis = cameraBasis(vp.viewer, g);
    // The scene refusing to be measured at all, which takes the gesture away.
    if (!basis) return false;
    const view = basis.view;
    let sine = 0;
    if (piece.kind === "axis") {
      // THE SAME COMPONENT `place` DRAWS FROM, so the arrow on screen is the
      // arrow that drags. Zero is an axis pointing straight at the reader,
      // which `place` never draws and the division in `alongAxis` could not
      // survive; a NaN out of a basis a hair off unit fails the same test.
      const cos = Math.abs(view[piece.axis]);
      sine = Math.sqrt(1 - cos * cos);
      if (!(sine > 0)) return false;
    }
    // AND NOTHING OF THE KIND FOR A QUAD, which is deliberate rather than
    // missing. Its own divisor is `view . n`, and `place` has already fenced
    // it: a quad that could be pressed was drawn with `|view . n|` at or above
    // `GIZMO_MIN_SCALE`. A second test here would be a guard against a state
    // the widget does not put on screen.
    drag = {
      piece,
      // HOW FAR ALONG THE AXIS ONE UNIT OF PROJECTED DISPLACEMENT GOES, and the
      // square is the whole of it (`alongAxis` carries the derivation). Zero on
      // a quad, which never reads it.
      sine,
      view,
      startX: event.clientX,
      startY: event.clientY,
      move: moveRecord(vp, sel.paths, ndc, sel.paths[0], sel.proposal),
      moved: false,
    };
    watch.arm();
    // From here the canvas wears `grabbing` until `finish`, whatever the ray
    // says: a constrained drag carries the hand off its own piece within a few
    // pixels of travel — the across-axis part of the travel takes the cursor
    // clean off a 14 px cylinder — and a cursor that went back to the default
    // there would be saying the drag had ended.
    widget.grabbed(true);
    return true;
  }

  /** End a drag the reader has not let go of, because the scene is going away.
   *
   * THE TWIN OF `vp.endGesture`, of the section grip's `endDrag` and of the
   * rings', and it exists for the same failure all three were written for: the
   * press was taken in a window listener this widget owns, so neither that
   * gesture nor the idle clock that defers the swap ever saw it, and the
   * release that would have concluded it never comes. Concluding rather than
   * abandoning, and the reason is what ABANDONING costs: the part stands
   * displaced in `vp.moved` with nothing in the document claiming it, and the
   * next push sends it home under the reader's hand.
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
      // listeners on the window holding a scene that is gone. `finish` and not
      // `stop`: this is the widget going away, and `vp.moved` goes with it, so
      // the displacement there would be to report is one nothing is left
      // standing at — the same ending tools.js's own teardown takes.
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
