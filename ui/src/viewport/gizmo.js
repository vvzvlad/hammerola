// The move tool's manipulator, less its rotation handles: an ORIGIN DOT at the
// selected part's centre, THREE AXIS ARROWS out of it along world +X, +Y and
// +Z, and THREE PLANE QUADS, one lying in each world plane. The dot is dragged
// for a free move, an arrow slides the part along THAT AXIS ONLY, and a quad
// slides it in THAT PLANE — two axes at once with the third held.
//
// ONE WIDGET, TWO LAYERS, ONE TOOL. The rotation handles are the fourth piece of
// the same manipulator and they live in rings.js, which answers to this same
// `move` tool: Fusion's triad is one command (`TriadCommandInput`) carrying an
// origin, three arrows, three quads and three rotation handles at once, and a
// reader who has to put a part down before they may turn it is reading half a
// widget. The two files stay two because they take their presses differently —
// these are BOXES and take theirs on their own elements, a ring is a curve and
// takes its own off the canvas in a window listener that declines any target
// but the canvas — so neither can steal the other's press.
//
// WHY IT EXISTS. The Move tool has always dragged a part freely in the plane of
// the screen (`dragPart` in tools.js), which is the right gesture for "put it
// about there" and the wrong one for every sentence that names a direction —
// "three millimetres further out", "up off the plate". Under an ortho camera a
// free drag can produce a delta on all three axes at once, and nothing in the
// hand can say which of them the reader meant. Blender's answer is this widget,
// and it is the one readers arrive already knowing. The dot gives the free drag
// back as a fourth target, because with a tool armed the hand is on the widget
// rather than on the part.
//
// A FOURTH DOM OVERLAY LAYER, built exactly like handle.js and for the reasons
// written out at length there: `viewer.clear()` deep-disposes everything in the
// scene, so a gizmo living in it would have to be rebuilt on a render path that
// has enough to get right already; and the browser hit-tests these seven boxes
// and picks a cursor for nothing, where the picker would have to be taught to.
//
// DRAWN OUT OF DIVS rather than out of an SVG, which handle.js also explains and
// is worth repeating because it looks like taste and is not: `tests/test_ui_source
// .py` waves the SVG namespace through as an identifier that merely looks like a
// URL and then pins that exemption to the single `const SVG_NS` in viewcube.js. A
// shaft and a CSS border triangle need no namespace.
//
// EVERY NUMBER A DRAG PRODUCES COMES FROM tools.js. Each constrained delta is
// the free drag's own world displacement put back on the piece's own geometry —
// an arrow takes the NEAREST POINT of its line, a quad takes the point where
// the ray through the cursor MEETS its plane, and the difference is not
// arbitrary: a plane and a ray meet and a line and a ray do not, so only one of
// the two can promise the reader that the part follows the pointer exactly.
// From there both are the same `niceStep`, the same `snap`, the same
// `movePart`/`nudgePart`, the same `stood`/`last` distinction and the same
// `reportMove` — so a part dragged by an arrow, by a quad, by the dot and by
// hand reach the proposal document as the same kind of sentence. A second copy
// of any of that would not fail; it would drift, which is worse. The dot does
// not even project: it calls `dragPart` itself.

import { internals } from "./internals.js";
import { cameraBasis, ndcAt, ndcOffset, projectPoint } from "./camera.js";
import { clamp, dot3 } from "./math.js";
import { movableGroup, movePart, nudgePart, partCentre } from "./parts.js";
import { dragPart, moveRecord, niceStep, reportMove, snap } from "./tools.js";
import {
  CLICK_PX,
  GIZMO_CASE_PX, GIZMO_DOT_PX, GIZMO_HEAD_PX, GIZMO_HIT_PX, GIZMO_MIN_SCALE,
  GIZMO_PLANE_GAP_PX, GIZMO_PLANE_PX, GIZMO_PX, GIZMO_RIM_PX, GIZMO_SHAFT_PX,
} from "./options.js";

/** The three axes, in the order they are drawn and in the colours everything
 *  that draws an axis triad uses.
 *
 * RED, GREEN, BLUE FOR X, Y, Z is not a palette choice — it is the convention
 * every CAD and DCC tool the reader has already used spells its axes in, so it
 * is the one thing about this widget nobody has to be told.
 *
 * THE INK BRINGS ITS OWN CONTRAST, exactly as `INK`/`HALO` do in handle.js and
 * for the same reason: the canvas under the arrows is white or near-black
 * depending on the reader's answer (`readTheme` in ui/src/store.js), so a single
 * colour has to read on both. These three are dark enough to hold against the
 * light canvas and are carried on the dark one by the same white halo the grip
 * uses — one filter over the whole arrow, so it follows the head as well as the
 * shaft.
 */
const AXES = [
  { world: [1, 0, 0], ink: "#c93a31" },
  { world: [0, 1, 0], ink: "#2e8b40" },
  { world: [0, 0, 1], ink: "#2d66c7" },
];

const HALO = "drop-shadow(0 0 1px #fff) drop-shadow(0 1px 2px rgba(20,24,28,.45))";

/** The two inks the QUADS and the DOT are constructed out of, which are not a
 *  palette and are not the arrows' answer either.
 *
 * `rings.js` spells the same pair for the same job and `RING_CASE_PX` carries
 * the argument: a light casing inside a dark rim is the only legibility that
 * survives a red mark on a red part over two canvases, and it is CONSTRUCTION
 * rather than colour. The white is the one `HALO` above glows with and the dark
 * is the one it shadows with — `rgba(20,24,28,…)`, the same three bytes.
 *
 * AND WHY THESE TWO PIECES DO NOT SIMPLY WEAR `HALO`, which is the arrows'
 * answer and is right there. Two reasons, one apiece. The quad is drawn under
 * the projection's own 2x2 matrix, and a `filter` is computed in the element's
 * OWN space before that matrix touches it — `rings.js` makes the same argument
 * at its `circle`, where a ring's matrix used to blow a 1 px glow up to a
 * hundred and, since its unit changed, squashes one exactly as this does;
 * either way the matrix spends the
 * halo instead of smearing it, and the glow thins away exactly on the quad
 * turning edge-on, which is where it would be wanted. The dot has no matrix at
 * all and a halo would work on it — but a halo is an EDGE treatment sized for a
 * 2 px shaft, where the ink is nearly all edge; the dot and the quad are FILLED
 * shapes ten pixels across, where 1 px of soft glow is a hairline round a block
 * of one colour. So both take the construction, and the widget gains one
 * mechanism for its two new pieces rather than two.
 */
const CASING = "#fff";
const RIM = "#14181c";

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

/**
 * Where a unit world axis points ON THE SCREEN at `at`, and how much of it the
 * projection leaves: `{sx, sy, sine, face}` with `sy` counted DOWNWARDS. Null
 * for a scene that cannot be measured at all.
 *
 * `sine` AND `face` ARE THE TWO READINGS OF ONE ANGLE, and the second is here
 * because the quad normal to this axis needs it and the cosine is already in
 * hand. `sine` is how much of the AXIS survives the projection, which is what
 * the arrow is drawn at; `face` is `|cos|`, which is how much of a unit square
 * lying SQUARE ON TO that axis survives it — the projected area of the world
 * plane the quad stands for. They are complementary: an arrow is longest
 * exactly where its own plane is edge-on, and vanishes exactly where that plane
 * is square to the reader, so an axis and its quad are never both gone and
 * never both at full.
 *
 * TAKEN OFF `cos` AND NOT OUT OF `sine`, which is a numerical point rather than
 * a tidiness one. `sqrt(1 - sine^2)` is `|cos|` on paper and can land a hair
 * BELOW zero in floating point where `cos` is near zero — the root goes NaN,
 * and a NaN compares false against the floor, so the quad the floor exists to
 * take off the screen would be drawn. `Math.abs` of a number already clamped to
 * [-1, 1] cannot.
 *
 * `sectionGripAxis` + `foreshorten` in section.js, asked about an axis of the
 * world instead of about a clip normal, and the two halves are measured the same
 * way they are there.
 *
 * THE DIRECTION COMES FROM A PROJECTED STEP and the LENGTH does not, which is
 * the one thing worth being exact about. `sine` is the angle between the axis
 * and the camera's own projection axis — `sqrt(1 - cos^2)` off `cameraBasis().
 * view` — and that is a property of the pose alone: under an ortho camera every
 * point projects along one fixed direction, so an axis is foreshortened by the
 * same amount wherever on screen the part happens to sit. Measured off the
 * projected step instead, the arrow's length would be telling the reader about
 * the zoom.
 *
 * A STEP OF ONE WORLD UNIT, and no shorter, because there is nothing here to
 * linearise: this viewport's camera is orthographic by construction (options.js)
 * so the projection is affine and the DIRECTION of a projected step is exact at
 * any length. `sectionAxis` takes a short step because it reads the step's
 * MAGNITUDE as a px-per-world-unit scale, which this does not.
 *
 * THE BASIS AND THE RECT ARE HANDED IN, and that is not tidiness either. This is
 * asked three times per frame, sixty frames a second, for as long as the Move
 * tool is armed; measured inside, each call would re-walk the camera
 * (`cameraBasis` updates matrices) and read `getBoundingClientRect` — a layout
 * read interleaved with the style writes `place` makes for the previous arrow,
 * which is the shape that forces a synchronous reflow three times a frame. Both
 * are properties of the camera and the canvas rather than of the axis, so the
 * caller reads them once.
 */
function axisOnScreen(g, basis, rect, at, n) {
  // Both are unit vectors, so the dot IS the cosine. `clamp` because it can land
  // a hair outside [-1, 1] in floating point, where the root would go NaN.
  const cos = clamp(dot3(n, basis.view), -1, 1);
  // `basis.eye` AND NOT A SECOND `getPosition()`, which is the same argument as
  // the basis itself: it is that call's own answer, already checked, and asking
  // the camera again three times a frame buys nothing. It is only ever used as a
  // vector to clone, so nothing here can reach the camera through it.
  const a = basis.eye.clone().set(at[0], at[1], at[2]).project(g.cam);
  const b = basis.eye.clone().set(at[0] + n[0], at[1] + n[1], at[2] + n[2])
    .project(g.cam);
  // BOTH COORDINATES OF BOTH ENDS, which `projectPoint` in camera.js also
  // insists on: a non-finite `y` alone leaves `sy` NaN, `rotate(NaNdeg)` is not
  // CSS the browser will take, and the arrow is then drawn UNROTATED — pointing
  // along screen x while claiming to be an axis of the world.
  if (!a || !b
      || !Number.isFinite(a.x) || !Number.isFinite(b.x)
      || !Number.isFinite(a.y) || !Number.isFinite(b.y)) return null;
  return {
    sx: ((b.x - a.x) * rect.width) / 2,
    sy: (-(b.y - a.y) * rect.height) / 2,  // NDC y is up, pixels are down
    sine: Math.sqrt(1 - cos * cos),
    face: Math.abs(cos),
  };
}

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
 * nearest point of the plane to where a free drag would have put the part, and
 * it is the right answer only when the plane faces the reader; anywhere else
 * the part lags the hand by the component it threw away. Under this viewport's
 * ortho camera every pixel looks along one fixed direction `view`, so two world
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
 * the `face` that decides whether the quad is drawn at all — so a quad the
 * browser can hit-test a press onto was drawn with `|face| >= GIZMO_MIN_SCALE`,
 * a fifth, and the factor `1 / (view . n)` is at most FIVE. An edge-on plane
 * has no in-plane answer to give at all — every point of it projects onto one
 * line, so "put the grabbed point back under the pointer" stops naming a point
 * — and the widget's response is to take the target away rather than to invent
 * an answer. `gizmo.test.js` pins the two as one number.
 *
 * TO THE FRAME, WHICH IS THE HONEST STATEMENT OF IT. The bound is written by
 * the last `place` before the press and the divisor is read by `onDown` at the
 * press, so what the fifth really bounds is the camera one rAF ago; a camera
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

/**
 * One world axis as the SCREEN VECTOR one arrow's worth of it spans, divided by
 * `GIZMO_PX` — the unit the quads' two edges and their near corner are written
 * in.
 *
 * `GIZMO_PX * reach(axis)` IS EXACTLY THE ARROW, tail to tip: the direction the
 * projection gives and the length `GIZMO_PX * sine` the arrow is drawn at. So a
 * quad built out of these lies in its plane the way the two arrows spanning
 * that plane lie along their axes, foreshortens with them, and measures its
 * corner and its side in fractions of the reach the reader can see beside it.
 *
 * NO GUARD ON THE DIVISION, and the reason is a fact about the caller rather
 * than optimism. `place` asks this only of the two axes SPANNING a quad it has
 * already decided to draw, i.e. one whose `face` is at least
 * `GIZMO_MIN_SCALE`; and for an orthonormal triple the three squared cosines
 * sum to one, so `(u . view)^2 <= 1 - face^2` and each spanning axis has
 * `sine >= face >= GIZMO_MIN_SCALE`. The hypotenuse is that sine times the
 * px-per-world-unit scale, and neither is zero.
 */
function reach(axis) {
  const h = Math.hypot(axis.sx, axis.sy);
  return [(axis.sx / h) * axis.sine, (axis.sy / h) * axis.sine];
}

export function createGizmo(vp) {
  const root = document.createElement("div");
  // `pointer-events: none` on the layer and back on for each PIECE, exactly as
  // the overlay, the view cube and the section grip do it: the layer covers the
  // whole canvas, so without this it would swallow every press meant for the
  // model — rotation included. It is also what leaves the rings beside it their
  // own presses: theirs are read off the canvas, and a press this layer took
  // would never get there.
  //
  // NO CLASS NAME, for the view cube's reason: a class is a promise the
  // interface's stylesheet keeps a rule for it (tests/test_ui_source.py checks
  // exactly that), and everything about how this looks is a legibility
  // requirement over two canvases rather than a palette the designer owns.
  root.style.cssText =
    "position:absolute;inset:0;overflow:hidden;pointer-events:none";

  /** One arrow: the box that takes the press, and the ink inside it.
   *
   * THE THREE BUILDERS RETURN ONE SHAPE — `{kind, world, el}` — because the
   * press, the cursor and the hiding are the same lines for all seven pieces.
   * `world` is the axis an arrow is constrained to and the NORMAL a quad holds
   * still; the dot has none, which is what having no constraint means.
   *
   * `kind` IS READ IN TWO PLACES AND BOTH MATTER. `onMove` picks the
   * arithmetic — `dragPart`, `alongAxis` or `acrossPlane`. `onDown` decides
   * what is MEASURED at the press and reads it twice over: `!== "free"` takes
   * the camera basis — which the QUAD divides by directly, as `view . n`, and
   * which the arrow's own `sine` is measured against rather than divided by —
   * and `=== "axis"` takes that `sine` on top of it. That second branch is
   * where a quad's divisor is deliberately NOT measured, because `place` has
   * already fenced it — so a reader who believes the distinction lives in
   * `onMove` alone will not find the half of it the fence rests on.
   */
  const build = ({ world, ink: colour }) => {
    // THE BOX IS THE TARGET AND WHAT IS DRAWN IN IT IS THINNER, the same split
    // handle.js makes in the one dimension it still holds for: the arrow takes
    // presses over all `GIZMO_HIT_PX` of its height while the shaft is
    // `GIZMO_SHAFT_PX`. ALONG its length the two agree, and `place` says why —
    // three arrows meeting at a point cannot afford targets longer than their
    // ink. So the box's WIDTH is the drawing, set per frame from how much of the
    // axis the projection leaves.
    //
    // `transform-origin` AT THE LEFT EDGE, which is the one real difference from
    // the grip's geometry. The grip is CENTRED on its anchor because a plane
    // slides both ways from there; an axis arrow STANDS ON the part and points
    // away along its axis, so the tail is the fixed point the rotation turns
    // about — and since a narrowing box keeps its left edge, foreshortening
    // pulls the tip back towards the part instead of sliding the arrow off it.
    const arrow = document.createElement("div");
    arrow.style.cssText = "position:absolute;left:0;top:0;display:none;"
      + `width:${GIZMO_PX}px;height:${GIZMO_HIT_PX}px;transform-origin:0 50%;`
      + `pointer-events:auto;cursor:grab;filter:${HALO}`;
    root.appendChild(arrow);

    const piece = (css) => {
      const el = document.createElement("div");
      el.style.cssText = `position:absolute;${css}`;
      arrow.appendChild(el);
    };

    // The shaft, from the tail up to the head.
    piece(`left:0;right:${GIZMO_HEAD_PX}px;top:50%;`
      + `height:${GIZMO_SHAFT_PX}px;margin-top:${-GIZMO_SHAFT_PX / 2}px;`
      + `background:${colour}`);
    // The head, as a CSS border triangle: a box of zero size whose one remaining
    // border is a wedge. THE BORDER AND THE EDGE ARE OPPOSITE SIDES — the border
    // left standing is the one AWAY from the point — so a wedge made of
    // `border-left` points RIGHT and belongs at the right edge, which is where
    // the arrow's tip is.
    piece(`right:0;top:50%;margin-top:${-GIZMO_HEAD_PX / 2}px;width:0;height:0;`
      + `border-top:${GIZMO_HEAD_PX / 2}px solid transparent;`
      + `border-bottom:${GIZMO_HEAD_PX / 2}px solid transparent;`
      + `border-left:${GIZMO_HEAD_PX}px solid ${colour}`);

    const arm = { kind: "axis", world, el: arrow };
    arrow.addEventListener("pointerdown", (event) => onDown(event, arm));
    return arm;
  };

  /** A filled shape carried on a light casing inside a dark rim: the outermost
   *  box IS the rim, with the casing inside it and the ink inside that.
   *
   * THE PARENT IS THE RIM for `rings.js`'s reason — a parent paints under its
   * children whatever anybody's `z-index` says (CSS 2.1 §E.2), so the bottom of
   * the stack has to be the outermost element — and the three are filled boxes
   * at plain offsets rather than borders, so that one transform on the parent
   * carries all three.
   *
   * `round` MAKES IT A CIRCLE instead of a square, which is the only difference
   * between the dot and a quad's construction.
   */
  const cased = (side, ink, round) => {
    const shell = document.createElement("div");
    const at = (inset, size, colour) => {
      const el = document.createElement("div");
      el.style.cssText = "position:absolute;"
        + `left:${inset}px;top:${inset}px;width:${size}px;height:${size}px;`
        + (round ? "border-radius:50%;" : "") + `background:${colour}`;
      return el;
    };
    const casing = at(GIZMO_RIM_PX, side - 2 * GIZMO_RIM_PX, CASING);
    casing.appendChild(at(GIZMO_CASE_PX,
                          side - 2 * (GIZMO_RIM_PX + GIZMO_CASE_PX), ink));
    shell.appendChild(casing);
    return shell;
  };

  /** One plane quad: a filled parallelogram lying in the world plane normal to
   *  `AXES[k]`, drawn between the two arrows that span it.
   *
   * A BOX OF `GIZMO_PLANE_PX` UNDER THE PROJECTION'S OWN 2x2 MATRIX, which is
   * `rings.js`'s trick asked about a flat shape instead of a curve: the quad is
   * a square in its plane, and a square under a linear map is exactly what a CSS
   * `matrix()` draws. `place` writes the two columns, which are the plane's two
   * world axes as the screen sees them, so the quad foreshortens as its plane
   * does and lies ON the model instead of floating square over it.
   *
   * SIZED AT `GIZMO_PLANE_PX` AND NOT AT ONE LOCAL PIXEL, which is the one place
   * this parts company with the rings. There the box is two pixels across and
   * the matrix multiplies by the radius; here the box is the quad's own nominal
   * side and the matrix's columns are at most one, so every length written
   * below — the rim, the casing — comes out at most the width it says and
   * thins as the quad turns away. That is what the edge of a real plate looks
   * like seen at an angle, and it is the same behaviour a ring's own band has.
   *
   * IT IS A FILLED BOX AND THEREFORE TAKES ITS OWN PRESS, which is the whole
   * reason this layer can keep `pointer-events: auto` where `rings.js` cannot:
   * a quad's target IS its drawing, corners included, so there is nothing for
   * the browser's hit test to steal from anybody.
   */
  const buildQuad = (k) => {
    const quad = cased(GIZMO_PLANE_PX, AXES[k].ink, false);
    quad.style.cssText = "position:absolute;left:0;top:0;display:none;"
      + `width:${GIZMO_PLANE_PX}px;height:${GIZMO_PLANE_PX}px;`
      + `transform-origin:0 0;pointer-events:auto;cursor:grab;background:${RIM}`;
    root.appendChild(quad);
    const plane = { kind: "plane", world: AXES[k].world, el: quad };
    quad.addEventListener("pointerdown", (event) => onDown(event, plane));
    return plane;
  };

  /** The origin dot: the widget's centre, dragged for a FREE move.
   *
   * A SECOND DOOR TO `dragPart` AND NOT A SECOND GESTURE. The free drag is what
   * a press on the part itself has always done (tools.js), and it stays the
   * whole of what this does — `onMove` hands the event straight to that
   * function. What the dot buys is that with the tool armed the reader's hand
   * is already on the widget, so the one move that needs no constraint need not
   * send them back to hunt for the part.
   *
   * A SCREEN-SPACE CIRCLE, with no axis in it and therefore nothing to
   * foreshorten: `place` writes its position and never its shape. The
   * `translate(-50%,-50%)` is set once here for that reason — it is the whole
   * transform this piece will ever carry.
   */
  const buildDot = () => {
    const dot = cased(GIZMO_DOT_PX, RIM, true);
    dot.style.cssText = "position:absolute;left:0;top:0;display:none;"
      + `width:${GIZMO_DOT_PX}px;height:${GIZMO_DOT_PX}px;border-radius:50%;`
      + "transform:translate(-50%,-50%);pointer-events:auto;cursor:grab;"
      + `background:${RIM}`;
    root.appendChild(dot);
    const free = { kind: "free", world: null, el: dot };
    dot.addEventListener("pointerdown", (event) => onDown(event, free));
    return free;
  };

  const arms = AXES.map(build);
  // THE QUADS AFTER THE ARROWS AND THE DOT AFTER BOTH, which is the only thing
  // that decides an overlap: these are siblings with no `z-index`, so the last
  // built wins a press the two share. It is the right way round. An arrow's box
  // is mostly empty — a 14 px target round a 2 px shaft — and a quad and the
  // dot are solid all the way to their edges, so where one crosses the other
  // the reader is aiming at the thing they can see filled in.
  const quads = AXES.map((_, k) => buildQuad(k));
  const dot = buildDot();
  const pieces = [...arms, ...quads, dot];

  let frame = 0;
  // The gesture in progress: which piece it is on, how much of that piece's own
  // axis the camera leaves (`sine`, measured once at the press and meaningless
  // for the other two kinds), where the press landed, the move record it is
  // applying, and whether the pointer has travelled far enough to be a drag at
  // all. Null between gestures.
  let drag = null;

  /**
   * The selection this widget stands for, or null when there is nothing to put
   * it on.
   *
   * THE SAME QUESTION `onDown` IN tools.js ASKS OF A GRAB, and the same one
   * `held` in rings.js asks: a piece offering a move that the press would then
   * refuse is a promise the widget cannot keep, and two halves of ONE widget
   * that came up on different conditions would be a widget with a piece
   * missing. So the Move tool has to be in force, something has to be
   * selected, and every selected path has to be one the scene can actually move
   * — with the extra clause a drag of the reader's own drawing carries, that a
   * proposal body is grabbable only when the panel can name it (`overlayBody`).
   *
   * `activeTool` AND NOT `state.tool`, for the reason tools.js gives: the hold
   * key puts the cut up without writing to `state`, and a widget left standing
   * under a cut gesture would be offering a move the press is no longer for.
   *
   * READ EVERY FRAME rather than remembered, which is what lets the loop below
   * stop by itself when the reader disarms the tool or clears the selection.
   */
  const held = () => {
    if (vp.activeTool !== "move") return null;
    const paths = Array.isArray(vp.state.selected) ? vp.state.selected : [];
    if (!paths.length) return null;
    const proposal = paths.some((path) => vp.isOverlay(path));
    const grabbable = (path) => !!movableGroup(vp.viewer, path)
      && (!proposal || !!vp.overlayBody(path));
    return paths.every(grabbable) ? { paths, proposal } : null;
  };

  const wanted = () => !!held();

  const hide = () => {
    for (const piece of pieces) piece.el.style.display = "none";
  };

  /** Put the widget on the part, or take it off the screen. */
  const place = () => {
    const sel = held();
    if (!sel) {
      hide();
      return;
    }
    const g = internals(vp.viewer);
    if (!g) {
      hide();
      return;
    }
    // READ OFF THE SCENE EVERY FRAME AND NOT OUT OF THE MOVE RECORD, which is
    // the whole of whether this is a widget the reader is holding or a picture
    // beside one. The record's `base` is where the drag STARTED; the part is
    // somewhere else for the length of the gesture, and arrows anchored on the
    // record would stand still while the part slid out from under them and then
    // jump to catch up at the release. `handle.js`'s `anchor()` argues exactly
    // this about the plane.
    //
    // THE FIRST SELECTED PATH, which is the same anchor the press takes below:
    // a row standing for five copies of a part moves as one thing, and the
    // arrows have to stand on one of them rather than between them.
    const at = partCentre(vp.viewer, sel.paths[0]);
    if (!at) {
      hide();
      return;
    }
    // ONCE FOR THE THREE, this and the camera basis below — see `axisOnScreen`,
    // which used to take each for itself and so read the layout between the
    // style writes of one arrow and the next.
    const rect = g.canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) {
      hide();
      return;
    }
    // BEFORE THE PROJECTION, which is the order handle.js takes and the
    // reason is inside `cameraBasis`: it calls `updateMatrixWorld`. Projected
    // first, the anchor would be placed off whatever the matrices held from the
    // last render while the three directions were measured off the refreshed
    // ones — one frame drawn from two states of the same camera.
    const basis = cameraBasis(vp.viewer, g);
    if (!basis) {
      hide();
      return;
    }
    const ndc = projectPoint(g, at);
    // z > 1 is behind the camera's far plane, i.e. behind the reader — under an
    // ortho projection a real case rather than a curiosity, exactly as the
    // overlay's `place` says.
    if (!ndc || ndc[2] > 1) {
      hide();
      return;
    }
    const box = vp.box.getBoundingClientRect();
    const left = (ndc[0] * 0.5 + 0.5) * rect.width + (rect.left - box.left);
    const top = (-ndc[1] * 0.5 + 0.5) * rect.height + (rect.top - box.top);
    // MEASURED ONCE FOR THE SIX, which is what makes the quads nearly free.
    // There are only three axes to measure and every piece is asking about
    // some of them: an arrow reads its OWN axis, and a quad reads all THREE —
    // the two it is spanned by, for the parallelogram, and the one it is normal
    // to, whose `face` decides whether it is drawn at all and is the divisor
    // its drag is fenced against. So the six pieces make twelve readings
    // between them, of three distinct ones; taken per piece, nine of the twelve
    // would be repeats.
    const axes = AXES.map(({ world }) => axisOnScreen(g, basis, rect, at, world));
    arms.forEach((arm, k) => {
      const axis = axes[k];
      // NEARLY END-ON IS GONE, not shortened — `GIZMO_MIN_SCALE` carries the
      // argument. A null is the scene refusing to be measured at all, and it
      // takes the arrow off for the same reason.
      if (!axis || axis.sine < GIZMO_MIN_SCALE) {
        arm.el.style.display = "none";
        return;
      }
      arm.el.style.display = "";
      arm.el.style.left = `${left}px`;
      arm.el.style.top = `${top}px`;
      // THE BOX FORESHORTENS WITH THE INK, which is where this parts company
      // with handle.js and has to. There the box is held at full length so the
      // grip stays easy to hit exactly where it collapses — and nothing is
      // behind it to take the press from. Here there are THREE, they meet at the
      // part, and a box longer than what is drawn is an invisible tail lying
      // across its neighbours: with the camera near an axis, the stub of Z keeps
      // a 64 px target over the full-length X beside it, and since the three are
      // siblings with no `z-index` the last one built wins. The reader presses
      // the red arrow they can see and drags the blue one they cannot.
      //
      // WHICH IS WHY THE HEAD NO LONGER SQUEEZES. Scaling the ink shrank the
      // whole group, head included; a narrower box shortens the SHAFT and leaves
      // the head its own size at the tip. That is also the widget every reader
      // has used — a gizmo's cap is a screen-space target and keeps its size —
      // and at the floor `GIZMO_MIN_SCALE` puts under this, about 13 px, a head
      // squeezed in proportion would be a smear with nothing to aim at.
      arm.el.style.width = `${GIZMO_PX * axis.sine}px`;
      // `sy` is counted DOWNWARDS, which is the direction CSS rotates in as
      // well, so the angle of that vector is the angle of the arrow with nothing
      // to flip. `translate(0,-50%)` lifts the box by half its height so the
      // tail — the middle of the left edge, which is the transform's origin —
      // sits exactly on the part's centre.
      arm.el.style.transform = "translate(0,-50%) "
        + `rotate(${(Math.atan2(axis.sy, axis.sx) * 180) / Math.PI}deg)`;
    });
    quads.forEach((quad, k) => {
      const [i, j] = spanOf(k);
      const normal = axes[k];
      const u = axes[i];
      const v = axes[j];
      // NEARLY EDGE-ON IS GONE, not flattened, and the floor is the arrows' own
      // — `face` is the fraction of this plane the projection leaves exactly as
      // `sine` is the fraction of an axis, so `GIZMO_MIN_SCALE` says the same
      // thing about both: a fifth, which is 11.5 degrees of tilt either way.
      //
      // AND THIS LINE IS THE WHOLE FENCE ROUND `acrossPlane`'s DIVISION, which
      // is the half worth being exact about. That drag divides by `view . n`,
      // and `face` IS `|view . n|` — so hiding the quad here is what keeps the
      // divisor at or above a fifth and the factor at or below five, for every
      // quad the browser can hit-test a press onto. Below the floor there is no
      // answer to fence: an edge-on plane projects onto a single line, so the
      // ray through the cursor meets it nowhere in particular and "put the
      // grabbed point back under the pointer" stops naming a point at all.
      //
      // THE LEGIBILITY REASON IS THE SAME ANSWER AGAIN. A square seen edge-on
      // is a line, and at the floor it is already a 3 px sliver lying across
      // the two arrows that span it, ready to take the presses meant for them.
      // `GIZMO_MIN_SCALE` and `RING_MIN_PX` agree here — a control the reader
      // can see and cannot aim at is worse than no control, and the remedy is
      // the same one: turn the model a little and it comes back.
      if (!normal || !u || !v || normal.face < GIZMO_MIN_SCALE) {
        quad.el.style.display = "none";
        return;
      }
      const a = reach(u);
      const b = reach(v);
      quad.el.style.display = "";
      quad.el.style.left = `${left}px`;
      quad.el.style.top = `${top}px`;
      // THE TWO COLUMNS ARE THE PLANE'S TWO AXES AS THE SCREEN SEES THEM, and
      // the translation is the near corner. `matrix(a, b, c, d, e, f)` sends
      // the local `(x, y)` to `(a x + c y + e, b x + d y + f)`, so a box of
      // `GIZMO_PLANE_PX` maps its far edges onto `GIZMO_PLANE_PX * reach(u)`
      // and `* reach(v)` — the quad's side, in the plane, foreshortened with
      // the arrows beside it. The corner stands `GIZMO_PLANE_GAP_PX` out along
      // BOTH, which is what keeps it off the blot where the three shafts cross.
      const gap = GIZMO_PLANE_GAP_PX;
      quad.el.style.transform = `matrix(${a[0]},${a[1]},${b[0]},${b[1]},`
        + `${gap * (a[0] + b[0])},${gap * (a[1] + b[1])})`;
    });
    // THE DOT NEEDS NO MEASUREMENT AT ALL, which is the whole of what "free"
    // means: it stands for a gesture with no axis and no plane in it, so there
    // is nothing about the camera for it to answer to beyond where the part is.
    dot.el.style.display = "";
    dot.el.style.left = `${left}px`;
    dot.el.style.top = `${top}px`;
  };

  const draw = () => {
    frame = 0;
    place();
    schedule();
  };

  /**
   * One rAF loop, and only while there is a selection to put arrows on.
   *
   * The library owns the render loop and offers no post-render hook, so the
   * alternative would be re-projecting from the trackball's `change` event —
   * which fires on camera moves and NOT on the frames a live swap, a visibility
   * change or a drag of this very widget redraws. A loop that stops on its own
   * costs nothing on the ordinary page, which has no Move tool armed.
   *
   * THE INVARIANT THAT MAKES `refresh` ENOUGH is handle.js's: while an arrow is
   * on screen a frame is always pending, because the only thing that shows one is
   * `place`, which runs from `draw`, which re-arms. So a selection going away
   * needs no synchronous hide here — the queued frame runs `place`, `held` is
   * null by then, and the same call takes the arrows off and lets the loop stop.
   */
  const schedule = () => {
    if (frame) return;
    if (!wanted()) return;
    frame = requestAnimationFrame(draw);
  };

  /** Let go of the gesture, wherever it ended.
   *
   * The listeners are on the WINDOW and in the capture phase for the reason
   * tools.js's `watch` gives: a drag that starts on an arrow can perfectly well
   * end anywhere, and a release missed here strands the gesture forever.
   */
  const finish = () => {
    if (drag) drag.piece.el.style.cursor = "grab";
    drag = null;
    removeEventListener("pointermove", onMove, true);
    removeEventListener("pointerup", onUp, true);
    removeEventListener("pointercancel", onCancel, true);
  };

  /** End the gesture and say where the part ended up.
   *
   * ONE FUNCTION FOR EVERY ENDING THERE IS HERE — the release, a pointer the
   * platform took away, a second press arriving with one live, and the scene
   * being swapped out from under a hand that has not come off. tools.js splits
   * those (`conclude` vs `concludeMove`) only because a section drag ends
   * differently from a move; there is no cut in this widget, so they collapse
   * into one, and `concludeMove`'s docblock is the argument for why a move is
   * reported from all four: the part is already standing where the reader
   * dragged it, and only the document can be wrong about that.
   *
   * ONLY IF THE GESTURE REALLY WAS A DRAG, which is the canvas gesture's rule
   * (`if (p.moved)`) with the canvas gesture's meaning of `moved`: `CLICK_PX` of
   * travel, not one pixel of it (`onMove` above). A bare press on an arrow is
   * not a placement, and `reportMove` would answer it by writing a node.
   */
  const stop = () => {
    const live = drag;
    finish();
    if (live && live.moved) reportMove(vp, live.move);
  };

  function onMove(event) {
    if (!drag) return;
    // A CLICK IS NOT A ONE-PIXEL DRAG, and the canvas gesture spells the same
    // rule out (`onMove` in tools.js): until the pointer has travelled
    // `CLICK_PX` this press is still a click, and a hand that shifts two pixels
    // between the press and the release has said nothing. It matters more here
    // than there, because there IS no click on an arrow — nothing selects, and
    // the only thing a twitch can do is snap the part one step and file a move
    // node the reader never asked for, which opens the panel on top of it.
    if (!drag.moved
        && Math.abs(event.clientX - drag.startX) < CLICK_PX
        && Math.abs(event.clientY - drag.startY) < CLICK_PX) return;
    drag.moved = true;
    // THE DOT IS THE FREE DRAG ITSELF, and it goes through tools.js's own
    // function rather than round it: `dragPart` is what a press on the part
    // does, snapping, proposal branch, `stood`/`last` and all, so there is
    // nothing left for this file to say about a move with no constraint in it.
    // Everything below would have to be undone to arrive back at that.
    if (drag.piece.kind === "free") {
      dragPart(vp, drag.move, event);
      return;
    }
    const viewer = vp.viewer;
    const g = internals(viewer);
    if (!g) return;
    const ndc = ndcAt(g.canvas, event);
    if (!ndc) return;
    const b = cameraBasis(viewer, g);
    if (!b) return;
    const d = drag.move;
    // THE FREE DRAG'S OWN DISPLACEMENT, PUT BACK ON THE PIECE'S GEOMETRY —
    // which is what "along one axis" and "in one plane" mean here, and it is
    // computed out of the same two `ndcOffset` readings `dragPart` takes: the
    // world vector a screen displacement spans is the difference of the two
    // ends' offsets, and under ortho that is depth-free. Starting from it keeps
    // everything the unconstrained gesture already gets right — the
    // px-per-world-unit scale, the zoom, the pan.
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
    // THE SAME STEP AND THE SAME SNAP the free drag rounds to, so a move made
    // with an arrow or a quad reads like a move made by hand and lands on the
    // same numbers in `vp.moved`, on the event and in the proposal document.
    const step = niceStep(viewer);
    const delta = drag.piece.kind === "axis"
      ? alongAxis(d.base, world, drag.piece.world, drag.sine, step)
      : acrossPlane(d.base, world, drag.piece.world, drag.view, step);
    if (delta[0] === d.last[0] && delta[1] === d.last[1]
        && delta[2] === d.last[2]) return;
    d.last = delta;
    // THE TWO MEANINGS, AND THE SAME TWO CALLS `dragPart` MAKES. A body of the
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

  function onDown(event, piece) {
    // THE PRIMARY BUTTON AND NOTHING ELSE, and handle.js says what that buys:
    // a press on a piece of this widget never reaches `vp.box` or the canvas in
    // the first place — this layer is a SIBLING of the box — so neither the part
    // menu nor the library's pan is reachable over these boxes whatever this
    // line does. What the filter buys is that a right-drag the reader meant as a
    // pan, and a middle click, no longer move the part.
    //
    // AND IT IS THE RINGS' PRESS THAT DOES NOT COME HERE, which is what makes
    // one tool out of two layers. Theirs is read off the CANVAS in a window
    // listener, and every element of this layer fails that listener's own
    // `event.target !== g.canvas` test — so a press on an arrow, a quad or the
    // dot is declined there and arrives here, and a press on a disc is stopped
    // there and never reaches a box of ours.
    if (event.button !== 0) return;
    // A previous gesture is concluded before a new one begins, exactly as
    // `onDown` in tools.js does it and for the same two reasons: a second
    // pointer landing on a piece would otherwise overwrite the press point with
    // its own, and the part it interrupted is standing somewhere no node claims.
    stop();
    // AND THE ROTATION HANDLES' GESTURE WITH IT, which is new with the merge
    // and is the same sentence about the other layer. The line above treats a
    // second pointer as real input — that is this file's standing decision —
    // and until the tools were merged the CROSS case could not arise: this
    // layer wanted `move` and rings.js wanted `turn`, so only one of the two
    // was ever alive to be interrupted. They answer to one tool now, so a
    // finger on a disc followed by a finger on an arrow leaves TWO live drags.
    //
    // AND TWO ARE WORSE THAN A STALE ONE. Both layers' `onMove` is on the
    // window and neither filters by pointer id, so both run on every move; each
    // then calls `movePart`, which writes position AND orientation together
    // from ITS OWN snapshot of the other's half — `moveRecord.turn` is the turn
    // as it stood at this press, `turnRecord.delta` the offset as it stood at
    // that one — so the two overwrite each other frame by frame, and both
    // report at the release as though each had been the only gesture.
    //
    // `endDrag` IS THE DOOR THE SYSTEM ALREADY HAS: every layer publishes one,
    // `element.js` calls all three when the scene is pulled out from under a
    // hand, and it CONCLUDES rather than abandons — `concludeMove`'s argument,
    // which is the whole reason the line above is `stop()` and not `finish()`.
    //
    // NO CHECK THAT THE NEIGHBOUR IS THERE, and that is a fact about
    // `element.js` rather than optimism. It builds this layer and then the
    // rings inside ONE synchronous `connectedCallback`, so no press can be
    // dispatched between the two lines; and its `destroy()` leaves both fields
    // standing while taking both layers' listeners away, so a press cannot
    // reach this function at a moment when `vp.rings` is not set.
    vp.rings.endDrag();
    // AND THE CANVAS GESTURE, WHICH IS THE THIRD THING THAT CAN BE LIVE. Here
    // is the complete list, because the two lines above read as if they were
    // the whole of it and they are not:
    //
    //   1. this layer's own drag                     — `stop()` above
    //   2. the rotation handles' drag (rings.js)     — `vp.rings.endDrag()`
    //   3. the canvas gesture (tools.js `press`)     — this line
    //   4. the section grip's drag (handle.js)       — deliberately left alone
    //
    // THREE IS THE ONE A PRESS HERE CANNOT OTHERWISE END. tools.js concludes
    // its own previous press at the head of its `onDown` — but that listener is
    // on `vp.box`, and this layer is a SIBLING of that element, so a press on an
    // arrow is not on its path and never runs it. A finger on the part followed
    // by a finger on a piece therefore leaves the free drag live: both `onMove`s
    // then run on every move, `dragPart` measuring from the FIRST finger's ndc
    // to wherever the second one now is, so the part jumps the distance between
    // the two hands and both halves report at the release.
    //
    // FOUR IS A DIFFERENT KIND AND IS WHY THE LIST IS WORTH WRITING OUT. The
    // grip drags the clipping PLANE, and a cut can stand while Move is armed
    // (element.js says so where it stacks the layers), so it really can be live
    // at the same time — but it writes the library's clip slider and this
    // writes the part, and nothing either touches is anything the other reads.
    // Two of them running is two different things moving, not one thing written
    // twice from two stale snapshots, which is the failure the other three
    // share.
    //
    // `vp.endGesture` IS ALWAYS A FUNCTION HERE, checked the way the neighbour
    // above was. `installTools` assigns it in the same synchronous
    // `connectedCallback`, later than this layer is built but long before any
    // press; and although its teardown NULLS it — which `vp.rings` is not —
    // that teardown runs inside `destroy()`, earlier in the same synchronous
    // block that takes this layer's listeners away. There is no moment at which
    // a press reaches this function and the field is null.
    //
    // WHAT IT COSTS, SAID OUT LOUD: `endGesture` CONCLUDES, and for a cut
    // gesture concluding means `reportCut`, which the interface answers by
    // disarming the armed tool. tools.js's own `onDown` calls `concludeMove`
    // rather than `conclude` to avoid exactly that, and it has no published
    // door that stops short. The sequence it takes is narrow — a hold-key cut
    // press still down, the key released mid-drag so this widget reappears, and
    // then a second finger on a piece — and the alternative is leaving the
    // canvas drag live, which is the reachable corruption above.
    vp.endGesture();
    // `stopPropagation` is belt and braces and nothing more, because this layer
    // is a sibling of `vp.box`: no listener on that element is on this event's
    // path at all. It stays for the day the layer moves inside the box.
    // `preventDefault` is the half that matters on its own: it suppresses the
    // compatibility mouse events, so this press cannot turn into a double-click
    // somewhere else.
    event.stopPropagation();
    event.preventDefault();
    const sel = held();
    if (!sel) return;
    const g = internals(vp.viewer);
    if (!g) return;
    const ndc = ndcAt(g.canvas, event);
    if (!ndc) return;
    // THE ANCHOR IS THE FIRST SELECTED PATH, the same one `place` stands the
    // widget on. The canvas drag chooses the copy under the cursor instead,
    // because there IS one there and a part the reader is holding must not leap
    // out from under them; here the cursor is on a widget rather than on a part,
    // and the row converges onto whichever copy is named (`movePart`), so the
    // one the widget is drawn from is the only answer that does not move the
    // thing the reader is aiming at.
    //
    // WHAT EACH KIND MEASURES AT THE PRESS, and the three differ exactly as
    // much as their arithmetic does. Both constrained kinds want the camera,
    // and both want it ONCE — MEASURED HERE AND HELD FOR THE WHOLE GESTURE,
    // exactly as `onDown` in handle.js takes the plane's screen axis, because
    // the camera cannot move under a press this widget owns and re-measuring
    // per event would let the part drift away from the hand. The dot is the
    // free drag and has no camera reading to go stale.
    let sine = 0;
    let view = null;
    if (piece.kind !== "free") {
      // THE CAMERA'S OWN PROJECTION DIRECTION, which is the direction every
      // pixel of an ortho canvas looks along — `acrossPlane` meets the ray
      // through the cursor with the plane along it, and `axisOnScreen` measures
      // both of its angles against it. `cameraBasis` builds a fresh array every
      // call, so holding this one cannot be holding something the library will
      // move underneath.
      const basis = cameraBasis(vp.viewer, g);
      // The scene refusing to be measured at all, which is the same null
      // `axisOnScreen` answers with and takes the gesture away for.
      if (!basis) return;
      view = basis.view;
      if (piece.kind === "axis") {
        // THROUGH THE SAME FUNCTION `place` DRAWS FROM, so the arrow on screen
        // is the arrow that drags.
        const at = partCentre(vp.viewer, sel.paths[0]);
        if (!at) return;
        const axis = axisOnScreen(g, basis, g.canvas.getBoundingClientRect(),
                                  at, piece.world);
        // Zero is an axis pointing straight at the reader, which `place` never
        // draws and the division in `alongAxis` could not survive.
        if (!axis || !(axis.sine > 0)) return;
        sine = axis.sine;
      }
      // AND NOTHING OF THE KIND FOR A QUAD, which is deliberate rather than
      // missing. Its own divisor is `view . n`, and `place` has already fenced
      // it: a quad that could be pressed was drawn with `|view . n|` at or
      // above `GIZMO_MIN_SCALE`. A second test here would be a guard against a
      // state the widget does not put on screen.
    }
    drag = {
      piece,
      // HOW FAR ALONG THE AXIS ONE UNIT OF PROJECTED DISPLACEMENT GOES, and the
      // square is the whole of it (`alongAxis` carries the derivation). Zero on
      // the two kinds that never read it.
      sine,
      view,
      startX: event.clientX,
      startY: event.clientY,
      move: moveRecord(vp, sel.paths, ndc, sel.paths[0], sel.proposal),
      moved: false,
    };
    piece.el.style.cursor = "grabbing";
    addEventListener("pointermove", onMove, true);
    addEventListener("pointerup", onUp, true);
    addEventListener("pointercancel", onCancel, true);
  }

  /** End a drag the reader has not let go of, because the scene is going away.
   *
   * THE TWIN OF `vp.endGesture` and of the section grip's `endDrag`, and it
   * exists for the same failure both were written for: the press landed on a
   * layer that is a SIBLING of `vp.box`, so neither that gesture nor the idle
   * clock that defers the swap ever saw it, and the release that would have
   * concluded it never comes. Concluding rather than abandoning is
   * `concludeMove`'s argument: the part stands displaced in `vp.moved` with
   * nothing in the document claiming it, and the next push sends it home under
   * the reader's hand.
   */
  const endDrag = () => {
    stop();
  };

  return {
    root,
    refresh: schedule,
    endDrag,
    destroy() {
      // `if (frame)` is safe because a browser rAF handle is non-zero by spec
      // (HTML §8.10), the same reading the view cube's teardown leans on.
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      // A viewport unmounted mid-drag would otherwise leave three capture-phase
      // listeners on the window holding a scene that is gone. `finish` and not
      // `stop`: this is the element going away, and `vp.moved` goes with it, so
      // the displacement there would be to report is one nothing is left
      // standing at — the same fifth ending tools.js's teardown takes.
      finish();
      root.remove();
    },
  };
}
