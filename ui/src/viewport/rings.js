// The move tool's rotation handles: three of them round the selected part, one
// per world axis, each dragged to turn the part about THAT AXIS ONLY.
//
// THE SAME TOOL THE AXIS ARROWS ANSWER TO, which is the one thing about this
// file that is not its own. Fusion's manipulator is ONE widget under one command
// (`TriadCommandInput`): an origin, three arrows, three plane quads and three
// rotation handles, all at once. There was a second tool here, `turn`, and it
// meant the reader had to put a part down before they could turn it. The two
// layers still cannot steal each other's presses — the arrows take theirs on
// their own elements, this one declines anything whose target is not the canvas.
//
// WHAT THE MERGE DID COST IS IN `onDown`, and it is not the name in `held`. Both
// halves stand on the part at once now, so three gestures can be live where one
// could be before: this layer's, the arrows', and the canvas drag underneath
// them. Each press therefore ends the other two. Read `onDown` before believing
// anything about this file is simple.
//
// ONE DISC PER AXIS IS WHAT THE READER ACTUALLY SEES AND PRESSES, and that is
// the answer to the two things three full circles got wrong. They DROWNED in
// the geometry — three closed curves of one radius, in three colours a part may
// perfectly well be painted — and they could not be AIMED AT, because circles
// of one radius about one centre cross six times and knot where they meet. So:
// each axis carries a compact disc sitting on its own circle, at the parameter
// that bisects the two world axes spanning the ring's plane, which puts the
// three of them in three different corners of the widget; at rest a short arc
// fades out either side of the disc and no full circle is drawn at all; and the
// whole circle appears under the cursor, which is how the reader learns which
// axis they are about to turn BEFORE they press. Fusion's manipulator, measured
// off its own sprites — the radius, the disc, the span of the arc and the
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
// A FIFTH DOM OVERLAY LAYER, built exactly like gizmo.js and handle.js and for
// the reasons written out at length in both: `viewer.clear()` deep-disposes
// everything in the scene, so a ring living in it would have to be rebuilt on a
// render path that has enough to get right already.
//
// DRAWN OUT OF DIVS rather than out of an SVG — where an SVG would have been
// genuinely easier, this being a curve, and it is still not worth it:
// `tests/test_ui_source.py` waves the SVG namespace through as an identifier
// that merely looks like a URL and then pins that exemption to the single
// `const SVG_NS` in viewcube.js. THE PRICE OF KEEPING THAT PIN IS NOW EIGHTEEN
// ELEMENTS — six per axis, an ellipse each — where the widget that drew three
// bare circles paid three, and that is worth saying out loud because it is the
// weight on this side of the trade. What holds it up is that the eighteen are
// built ONCE and the frame moves THREE of them (`build`): the casing, the rim
// and the disc are static boxes inside the axis's own element, so the running
// cost is three transforms a frame — one per axis — which is what an SVG would
// have to write as well.
//
// ROUND DIVS AND NOT POLYLINES, which is the whole trick of this file. A world
// circle seen under an orthographic camera projects to an ELLIPSE, and an
// ellipse is what a CSS `matrix()` does to a circle — so every piece of this
// widget is a round div under the projection's own 2x2 matrix, and the browser
// draws the curve. Chopping the circle into a run of segments would be sixty
// elements per ring, re-laid-out sixty times a second, to approximate something
// the compositor renders exactly.
//
// THE SIX ARE SIX SIZES AND NOT SIX COPIES OF ONE BOX, which is worth being
// exact about because the arithmetic below reads as if they were: the ink of
// the curve is a box of 210 px, its casing 214 and its rim 216, and the disc's
// three are 20, 18 and 14 — every one of them `2 * r` SCREEN PIXELS, which is
// the one rule (`circle`).
//
// ONE LOCAL PIXEL IS ONE SCREEN PIXEL, AND IT HAS TO BE, which is why those are
// the sizes rather than the fractions they read as. The tempting way round is
// the other one: give the ink a 2 px box, let the matrix carry the radius, and
// write every length as `something / RING_PX`. That is correct arithmetic and a
// BLACK BLOB in a browser. A border-width is resolved to DEVICE pixels BEFORE
// the transform and the device minimum is one of them, so the rim's 8 px asked
// for as 0.076 is rounded UP to half a CSS pixel at 2x — and the matrix then
// magnifies THAT by 105. Eight pixels asked for, about fifty drawn; and the
// rim, being the outermost and widest of the three bands, fills most of its own
// disc. So the element's box is its REAL size and the matrix carries only the
// SHAPE: its columns are `a / RING_PX` and `b / RING_PX`, whose widest
// direction is exactly 1, so the widest point of the ring is still `RING_PX`
// and nothing about WHERE anything is drawn changes. Borders are then plain
// pixel widths with nothing for the browser to round, and they still foreshorten
// with the ellipse in its narrow direction, which `circle` argues is correct.
//
// AND THE DISC IS DRAWN THE SAME WAY, off the same matrix, because it is a
// circle in the RING'S OWN PLANE rather than a dot on the screen. It is
// therefore squashed exactly as its ring is: the handle lies on the curve
// instead of floating over it, and a ring turned away says so by flattening its
// handle with itself.
//
// EVERY ANGLE THE DRAG PRODUCES IS MEASURED IN CIRCLE SPACE, which is the other
// half of the trick and the half that decides whether this widget turns the
// part the way the hand went. See `circleSpace` below.

import { internals } from "./internals.js";
import { cameraBasis, projectPoint } from "./camera.js";
import { EVENT_PROPOSALTURN, EVENT_TURNED, emit } from "./events.js";
import { finite3 } from "./math.js";
import {
  groupFacing, groupHome, movableGroup, movePart, nudgeTurn, partCentre,
} from "./parts.js";
import {
  CLICK_PX, RING_ARC_DEG, RING_CASE_PX, RING_DISC_PX, RING_MIN_PX, RING_PX,
  RING_RIM_PX, RING_SHAFT_PX,
} from "./options.js";
import { turnedFrom } from "../proposal.js";

/** The three world axes, in the order they are drawn and in the colours
 *  everything that draws an axis triad is spelled in.
 *
 * RED, GREEN, BLUE FOR X, Y, Z is the same convention gizmo.js states at
 * length: every CAD and DCC tool the reader has already used spells its axes
 * this way, so it is the one thing about either widget nobody has to be told.
 * The three inks are the arrows' own, and `rings.test.js` pins that they still
 * are — two widgets standing on one part in two palettes would be two triads.
 *
 * THE PAIR THAT SPANS EACH RING'S PLANE IS THE OTHER TWO AXES IN CYCLIC ORDER,
 * `u = AXES[(k + 1) % 3]` and `v = AXES[(k + 2) % 3]`, and the whole sign of
 * this gesture rests on that one line. Cyclic order is exactly the pair with
 * `u x v = +k` — Y x Z = X, Z x X = Y, X x Y = Z — so a point walked
 * anticlockwise from `u` towards `v` is a point walked the RIGHT-HANDED way
 * about the axis, which is the direction a positive angle means everywhere else
 * in this document. Taken the other way round every ring would turn its part
 * backwards, and nothing on screen would say so; `rings.test.js` pins the pair
 * with `cross3` and then pins where the part actually ends up.
 *
 * `lit` IS THE SAME INK LIGHTENED, and it is the whole of what a disc does
 * under the cursor. Fusion lightens the handle the pointer is on, which says
 * "this is the one you are about to take" in the one channel a reader does not
 * have to look away to read — and it says it without changing the axis's
 * COLOUR, which is the thing the reader is meant to be reading off it.
 */
const AXES = [
  { world: [1, 0, 0], ink: "#c93a31", lit: "#dc7f79" },
  { world: [0, 1, 0], ink: "#2e8b40", lit: "#77b483" },
  { world: [0, 0, 1], ink: "#2d66c7", lit: "#769cdb" },
];

/** The two inks the CONSTRUCTION is made of, which are not a palette either.
 *
 * The white is the one the grip and the arrows halo themselves with and the
 * dark is the one they shadow themselves with (`HALO` in gizmo.js, which spells
 * it `rgba(20,24,28,…)` — the same three bytes). Both are here as geometry
 * rather than as a filter, for the reason `casing` below gives, but they are
 * the same two answers to the same question: this widget stands ON the model,
 * over whatever colour the part happens to be and on either canvas.
 */
const CASING = "#fff";
const RIM = "#14181c";

/** Where on its own circle each ring carries its disc, as a circle-space angle.
 *
 * THE BISECTOR OF THE RING'S TWO WORLD AXES — 45 degrees from `u` towards `v`,
 * which for the X ring (whose circle lies in YZ) is the direction of `+Y +Z`.
 * The three come out 60 degrees apart in the world, and under any camera that
 * shows all three rings they land in three different corners of the widget:
 * that separation is the whole of "you can hit the axis you mean". Put at a
 * world axis instead, two discs would sit on top of each other at every one of
 * the six points where the rings themselves cross.
 *
 * A POINT OF THE UNIT CIRCLE AND NOT A LENGTH, which is a distinction this file
 * did not have to make while one local pixel WAS `RING_PX` screen pixels and the
 * two readings came to the same number. The pair is read twice: `aimAt` and
 * `discAt` want it in CIRCLE SPACE, where the ring is the unit circle, and
 * `build` wants it as an offset inside an element whose box is now its real size
 * in screen pixels — so that one, and only that one, multiplies by `RING_PX`.
 */
const DISC_AT = Math.PI / 4;
const DISC_U = Math.cos(DISC_AT);
const DISC_V = Math.sin(DISC_AT);

/** The disc's radius in the RING'S OWN units, where the ring itself is 1.
 *
 * Which is what makes the hit test one subtraction: circle space is the ring's
 * plane with its radius divided out, so a disc that is a circle in that plane
 * is a circle HERE, however the camera has squashed both on the way to the
 * screen. `RING_DISC_PX` is a width at the ring's widest point and `RING_PX` is
 * the radius at that same point, so the ratio carries no camera in it.
 *
 * AND IT IS NOT A LENGTH `circle` COULD USE, which is `DISC_AT`'s trap said
 * again because it is the one thing about the change of unit that could go
 * wrong silently: circle space and the element's own pixels were ONE unit until
 * the boxes became their real size, and this side did not move with them. The
 * press is measured against the ring and never against a box, so nothing here
 * changed — and `rings.test.js` pins that the drawn disc and the hit test still
 * name the same circle.
 */
const DISC_R = RING_DISC_PX / 2 / RING_PX;

/** The angular half-width of the disc, seen from the ring's own centre. */
const DISC_DEG = Math.asin(DISC_R) * (180 / Math.PI);

/** The at-rest fade, as one conic gradient in the ring's own space.
 *
 * A MASK AND NOT A SECOND SET OF ELEMENTS, and it is the one thing the matrix
 * does not spoil. Every length written on these divs is squashed by the matrix
 * in the ring's narrow direction, but a conic gradient is measured in ANGLES
 * about the element's own centre, and the element's own space is the circle the
 * matrix maps to the ellipse. So the fade runs over the ring's own
 * parametrisation: `RING_ARC_DEG` either side of the disc OF THE CIRCLE, not of
 * the picture, and a ring seen at an angle fades over the same stretch of
 * itself as one seen square on.
 *
 * AND NOTHING IN IT IS A LENGTH, which is what let the unit under the rest of
 * this file change without a character of this one moving. The four stops and
 * the `from` are angles; the one thing that could have been a length is the
 * gradient's own CENTRE, and that is the centre of the mask painting area —
 * `mask-origin` and `mask-clip` are both the BORDER BOX by default, which is
 * also what `transform-origin: 50% 50%` names, so it is the centre the ellipse
 * is drawn about whatever size the box is.
 *
 * `from` PUTS ZERO AT THE HANDLE'S OWN ANGLE, less the half-span. CSS measures
 * a conic gradient from twelve o'clock and runs it clockwise, which in the
 * element's own axes — y downwards — is 90 degrees ahead of the circle-space
 * angle `cos t, sin t` names. Hence the `+ 90`.
 *
 * FULL ACROSS THE HANDLE'S OWN WIDTH AND NOT ONLY AT ITS CENTRE, which is the
 * one stop that is not Fusion's. A mask applies to an element's whole SUBTREE,
 * and the disc is drawn inside the circle it sits on (`build`), so a fade that
 * started falling at the handle's midpoint would take about a tenth of the
 * handle's own edges with it — a translucent rim on the very thing the rim
 * exists to make solid. `DISC_DEG` is exactly how wide the disc is in this
 * gradient's own units, so the ramp starts where the handle ends.
 */
const FADE = "conic-gradient(from "
  + `${DISC_AT * (180 / Math.PI) + 90 - RING_ARC_DEG}deg,`
  + `rgba(0,0,0,0) 0deg,`
  + `#000 ${RING_ARC_DEG - DISC_DEG}deg,#000 ${RING_ARC_DEG + DISC_DEG}deg,`
  + `rgba(0,0,0,0) ${2 * RING_ARC_DEG}deg)`;

/**
 * The six circles one axis is drawn out of, OUTERMOST FIRST — `{r, band, ink,
 * disc}` with `r` the radius in pixels at the ring's widest point, `band` the
 * width of the stroke for the three that are curves, and `disc` marking the
 * three that stand on the handle instead of on the centre.
 *
 * WHICH IS ALSO THE ORDER THEY ARE PAINTED IN, and the two have to agree: the
 * first of them is the element the other five live inside (`build`), and a
 * parent paints under its children whatever anybody's `z-index` says. So the
 * dark rim is first because it is the bottom of the stack — rim, casing, ink,
 * and then the disc's own three over all of them.
 *
 * THE CURVE'S THREE SHARE AN OUTER EDGE SCHEME rather than a centre line: the
 * ink's outer edge is `RING_PX` exactly — which is what lets the rest of this
 * file go on saying the ring's widest point IS `RING_PX` — and the casing and
 * the rim stand that much outside and inside it, so each is a wider band about
 * the same circle.
 *
 * THE DISC'S THREE ARE FILLED and not stroked, which is the difference between
 * a handle and a hoop: a light fill inside a white casing inside a dark rim is
 * the thing that reads on a body of its own colour, and it is Fusion's own
 * construction (options.js, `RING_CASE_PX`).
 */
const pieces = ({ ink }) => {
  const half = RING_DISC_PX / 2;
  return [
    { r: RING_PX + RING_CASE_PX + RING_RIM_PX, ink: RIM,
      band: RING_SHAFT_PX + 2 * (RING_CASE_PX + RING_RIM_PX) },
    { r: RING_PX + RING_CASE_PX, ink: CASING,
      band: RING_SHAFT_PX + 2 * RING_CASE_PX },
    { r: RING_PX, ink, band: RING_SHAFT_PX },
    { r: half, ink: RIM, disc: true },
    { r: half - RING_RIM_PX, ink: CASING, disc: true },
    { r: half - RING_RIM_PX - RING_CASE_PX, ink, disc: true },
  ];
};

/** Half a turn, in radians — the wrap `onMove` unwinds a step across. */
const HALF_TURN = Math.PI;

const DEGREES_PER_RADIAN = 180 / Math.PI;

/**
 * Where a world point lands on this layer, in CSS pixels, with the NDC depth
 * alongside — or null for a point the projection cannot place.
 *
 * `gizmo.js`'s own two-rect arithmetic, lifted into a function because this
 * layer projects four points per frame instead of one: the canvas's rect gives
 * the pixel size of the NDC cube and the element's own rect is what the
 * absolutely-positioned children are placed against, so the difference of the
 * two corners is the offset between them. The overlay's `place` and the
 * gizmo's spell the same sum.
 */
function spot(g, rect, box, point) {
  const ndc = projectPoint(g, point);
  if (!ndc) return null;
  return [
    (ndc[0] * 0.5 + 0.5) * rect.width + (rect.left - box.left),
    (-ndc[1] * 0.5 + 0.5) * rect.height + (rect.top - box.top),
    ndc[2],
  ];
}

/**
 * The minor semi-axis of the ellipse `{cos t * a + sin t * b}`, in pixels.
 *
 * The extremes of `|cos t * a + sin t * b|^2` are the eigenvalues of the 2x2
 * matrix `[a b]^T [a b]`, which for a symmetric matrix are
 * `(A + B)/2 +- hypot((A - B)/2, C)` with `A = a.a`, `B = b.b` and `C = a.b`.
 * The smaller root is this one; the larger is the ring's widest point, which is
 * `RING_PX` by construction (`frameAt` picks the world radius to make it so)
 * and therefore needs no computing.
 *
 * `Math.max(0, ...)` because the difference of two nearly equal floats can land
 * a hair below zero on a ring seen exactly edge-on, where the root would go NaN
 * and a NaN compares false against the floor — drawing the very ring the floor
 * exists to take off the screen.
 */
function minorOf(a, b) {
  const A = a[0] * a[0] + a[1] * a[1];
  const B = b[0] * b[0] + b[1] * b[1];
  const C = a[0] * b[0] + a[1] * b[1];
  const half = (A + B) / 2;
  return Math.sqrt(Math.max(0, half - Math.hypot((A - B) / 2, C)));
}

/**
 * The three rings as they stand on the screen right now: `{C, rings}` with `C`
 * the part's centre in layer pixels and one `{a, b}` per axis — the two screen
 * vectors that span its ellipse — or `null` for a ring seen too nearly edge-on.
 * Null for a scene that cannot be measured at all.
 *
 * MEASURED ONCE AND USED TWICE, which is why it is a function rather than the
 * body of `place`: the frame drawn from and the frame the press is aimed at
 * have to be the same one, and the press then HOLDS ITS COPY for the whole
 * gesture — the camera must not be able to change the frame under a hand that
 * is already turning something (`onDown`, and `handle.js` and `gizmo.js` both
 * take their own measurement once for the same reason).
 *
 * THE RADIUS IS CHOSEN SO THE RING READS AT A FIXED PIXEL SIZE, and that is
 * what `scale` is for. `gizmo.js` needs no such number — its arrow is a DOM box
 * a fixed number of pixels long — but a ring is world geometry: at a world
 * radius the widget would be a thread round a 200 mm part and a hoop round a
 * 2 mm one, and it would grow and shrink with the zoom. So the px-per-world-
 * unit of this camera is measured the way that file measures an axis, off
 * projected unit steps, and the radius is `RING_PX` divided by it.
 *
 * `sqrt((|P(X)|^2 + |P(Y)|^2 + |P(Z)|^2) / 2)` IS THAT SCALE EXACTLY, under the
 * orthographic camera this viewport is built on (options.js). Such a projection
 * sends a world vector `w` to `s * (R.w, -U.w)` for the camera's own right and
 * up axes, so summing the squares over the three world axes gives
 * `s^2 * (|R|^2 + |U|^2)` — two, both being unit vectors — whatever direction
 * the camera is looking from. Measured off one axis instead, the answer would
 * collapse to zero for the axis pointing at the reader.
 *
 * WHICH ALSO MAKES THE WIDEST POINT OF ALL THREE RINGS THE SAME, and it is
 * worth saying why that is a property rather than a coincidence: the plane of
 * any ring and the plane of the screen both pass through the centre, so in
 * three dimensions they always meet in a line. Every ring therefore contains a
 * direction lying square on to the reader, which projects at the full `scale` —
 * so every ring's major semi-axis is `RING_PX` and three circles of one
 * apparent size stand round the part.
 *
 * THE RIM POINTS ARE THE UNIT STEPS SCALED, and that is the same projection
 * rather than a shortcut past it. `c + R*u` projects to `C + R*P(u)` because an
 * ortho projection is affine, and the `u` and `v` of the three rings are the
 * three world axes between them — so the six rim points the geometry names are
 * these three measurements, taken once each instead of twice.
 */
function frameAt(g, rect, box, at) {
  const C = spot(g, rect, box, at);
  // z > 1 is behind the camera's far plane, i.e. behind the reader — under an
  // ortho projection a real case rather than a curiosity, exactly as the
  // overlay's `place` and the gizmo's say.
  if (!C || C[2] > 1) return null;
  const steps = AXES.map(({ world }) => {
    const end = spot(g, rect, box, [at[0] + world[0], at[1] + world[1],
                                    at[2] + world[2]]);
    return end ? [end[0] - C[0], end[1] - C[1]] : null;
  });
  if (steps.some((step) => !step)) return null;
  const scale = Math.sqrt(
    steps.reduce((sum, s) => sum + s[0] * s[0] + s[1] * s[1], 0) / 2);
  if (!(scale > 0)) return null;
  const radius = RING_PX / scale;
  const rings = AXES.map((axis, k) => {
    const u = steps[(k + 1) % 3];
    const v = steps[(k + 2) % 3];
    const a = [u[0] * radius, u[1] * radius];
    const b = [v[0] * radius, v[1] * radius];
    // A RING SEEN EDGE-ON IS GONE, not flattened — `RING_MIN_PX` carries the
    // argument, and it is `GIZMO_MIN_SCALE`'s: a control the reader can see and
    // cannot use is worse than no control. What is unusable now is the DISC,
    // which flattens with its ring; the old reason (a sliver of curve lying
    // across the other two and swallowing their presses) went with the curve
    // hit test. Here it is also the two divisions below going singular.
    return minorOf(a, b) < RING_MIN_PX ? null : { a, b };
  });
  return { C: [C[0], C[1]], rings };
}

/**
 * A point of this layer in one ring's OWN coordinates: `[x, y]` such that the
 * point is `C + x*a + y*b`, or null for a basis that cannot be inverted.
 *
 * THE ONE IDEA IN THIS FILE. The projection restricted to a ring's plane is the
 * 2x2 matrix `[a b]`, and inverting it undoes the camera: the pointer comes
 * back as a position in the `(u, v)` plane, where the ring really is a circle
 * and `atan2(y, x)` really is the angle about the world axis. Everything hard
 * about this widget — which ring was aimed at, how far the hand has turned, and
 * above all WHICH WAY — is then plane trigonometry.
 *
 * AND IT IS WHAT SETTLES THE SIGN. The screen's y axis points DOWN, so the sign
 * of an angle measured in screen pixels is not the sign of a right-handed
 * rotation — and the projection can flip it again all by itself, since a ring
 * seen from the far side runs the other way round the screen. Neither of those
 * reaches here: both are properties of `a` and `b`, the inverse takes them
 * back out, and what is left is the angle in the plane `u x v = +k` spans. So
 * the answer is a right-handed rotation about `+k` with nothing to correct, and
 * a hand-picked sign — which is how this is usually got wrong, plausibly and
 * silently — would be a second opinion about a question already answered.
 */
function circleSpace(ring, C, point) {
  const [a, b] = [ring.a, ring.b];
  const det = a[0] * b[1] - a[1] * b[0];
  if (!Number.isFinite(det) || det === 0) return null;
  const dx = point[0] - C[0];
  const dy = point[1] - C[1];
  const x = (b[1] * dx - b[0] * dy) / det;
  const y = (a[0] * dy - a[1] * dx) / det;
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/** Where one ring's disc stands on this layer, in pixels. */
function discAt(ring, C) {
  return [C[0] + DISC_U * ring.a[0] + DISC_V * ring.b[0],
          C[1] + DISC_U * ring.a[1] + DISC_V * ring.b[1]];
}

/**
 * Which ring's DISC this point is on, and where on that ring's circle it landed
 * — `{axis, ring, theta}` — or null for a point on no disc at all.
 *
 * THE HIT TEST IS OURS, because the library's picker answers about parts and
 * has never heard of this layer, and because the browser's own hit testing
 * cannot answer it either: a div is a filled box however round its corners are
 * made, so an element that could take the press would take the whole square
 * about the disc with it — and the corners of that square are presses the
 * reader aimed PAST the handle, at the very reach where they grab to orbit.
 * Hence
 * `pointer-events: none` on the whole layer, unlike the three widgets beside
 * it, and hence this.
 *
 * AND IT IS ONE SUBTRACTION, which is the dividend of putting the target on the
 * curve rather than making it BE the curve. In circle space the ring is the
 * unit circle and the disc is a circle of `DISC_R` about `(DISC_U, DISC_V)`, so
 * "is the pointer on the disc" is a distance between two points — exact, with
 * no tolerance to invent and none of the old curve test's one-sided error. The
 * camera is already divided out, so a ring the projection has squashed is
 * grabbed exactly where it is drawn.
 *
 * THE NEARER OF TWO DISCS THAT BOTH ANSWER, and it is a real case rather than a
 * formality: two rings seen from a camera that puts their handles' world
 * directions on one line of sight draw their discs in the same place. Measured
 * in PIXELS from each disc's own centre, because circle-space distances on two
 * different rings are two different units and cannot be compared.
 *
 * AND IT IS ONLY EVER TWO, which is worth writing down because it bounds the
 * damage. The difference of two handles' world directions is perpendicular to
 * the THIRD axis — `h_Y - h_Z` is `(Z - Y)/sqrt2`, square on to X — so a camera
 * looking down that difference, which is what it takes to make two discs
 * coincide, is a camera in the third ring's own plane: that ring is edge-on and
 * `RING_MIN_PX` has already taken it off the screen. With all three rings up
 * the discs are at least `RING_PX * GIZMO_MIN_SCALE` apart, which is wider than
 * a disc, so the tie-break decides between two overlapping handles and never
 * among three.
 */
function aimAt(frameOf, point) {
  let best = null;
  frameOf.rings.forEach((ring, k) => {
    if (!ring) return;
    const p = circleSpace(ring, frameOf.C, point);
    if (!p) return;
    if (Math.hypot(p[0] - DISC_U, p[1] - DISC_V) > DISC_R) return;
    const [dx, dy] = discAt(ring, frameOf.C);
    const away = Math.hypot(point[0] - dx, point[1] - dy);
    if (!best || away < best.away) {
      best = { axis: k, ring, away, theta: Math.atan2(p[1], p[0]) };
    }
  });
  return best;
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
 * `moveRecord` was lifted into tools.js because TWO gestures make one — the
 * canvas drag and the manipulator's own press, whichever of its seven pieces it
 * landed on — and a second hand-written copy is how they would start
 * disagreeing about what a drag means. There is one gesture that
 * turns, so its record belongs where it is used; the day a second one appears,
 * this moves.
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
  const root = document.createElement("div");
  // `pointer-events: none` ON THE LAYER AND NOWHERE BACK ON, which is where
  // this widget parts company with the overlay, the view cube, the section grip
  // and the axis arrows. All four put `auto` on the thing they want pressed,
  // because all four are pressed on a BOX. Nothing here is a box: the curves
  // are curves, and a disc is a round hole in a square element whose corners
  // would take presses the reader aimed past it — three squares of them, at the
  // very reach where the reader grabs to orbit. So nothing on this layer takes
  // a press, and the press is read off the CANVAS in the capture phase instead
  // (`onDown`), where it can be measured against the disc itself.
  //
  // NO CLASS NAME, for the view cube's and the gizmo's reason: a class is a
  // promise the interface's stylesheet keeps a rule for it
  // (tests/test_ui_source.py checks exactly that), and everything about how this
  // looks is a legibility requirement over two canvases rather than a palette
  // the designer owns.
  root.style.cssText =
    "position:absolute;inset:0;overflow:hidden;pointer-events:none";

  /** One of the six circles: a round box of its own REAL SIZE, for the ring's
   *  own matrix to work on.
   *
   * A BOX OF `2 * r` AND NOT A UNIT ONE, which is the whole of how six circles
   * of six sizes share one matrix. That matrix carries the SHAPE and no
   * magnitude — its widest direction is exactly 1 (`place`) — and
   * `border-radius: 50%` makes a box's edge the circle inscribed in it, so a
   * box this wide comes out as a circle of `r` screen pixels at the ring's
   * widest point and a border of `band` comes out `band` wide there.
   *
   * AND THE PIXEL IT IS WRITTEN IN IS A REAL ONE, which is why the matrix is
   * that way round rather than carrying the radius with unit boxes inside it.
   * The head of this file has the measurement: a border-width is resolved to
   * DEVICE pixels BEFORE the transform, so a stroke asked for in fractions of
   * `RING_PX` is rounded up to the device minimum and then magnified by the
   * radius — two pixels asked for and about fifty drawn.
   *
   * AND THINNER EVERYWHERE ELSE, WHICH IS CORRECT. The same matrix that turns
   * the circle into an ellipse squashes the border with it, so the ring is
   * drawn finest where it is turning away from the reader. That is what a real
   * ring looks like seen at an angle; an outline of uniform weight would be a
   * lie about the shape, and the reader would lose the one cue that says which
   * way the ring is facing — which is the cue that says which way the part will
   * turn.
   *
   * `box-sizing: border-box` so the border grows INWARDS and the outer edge
   * stays exactly the circle `r` names: with the default every one of these
   * would be drawn a few per cent larger than its `r`, which is a widget whose
   * size depends on how thick its line is — and the bands would no longer be
   * concentric.
   *
   * NO HALO AND NO SHADOW, unlike the grip and the arrows, and the reason has
   * CHANGED with the unit rather than survived it — which is worth writing down,
   * because a true conclusion left standing on a dead reason is how the next
   * reader inherits the dead one. It used
   * to be arithmetic: `filter` and `box-shadow` are computed in the element's
   * OWN space, so at one local pixel to `RING_PX` a one-pixel glow came back as
   * a hundred pixels of smudge. That is gone; the element's space is screen
   * pixels now. What is left is that the casing and the rim ARE geometry and
   * have to stay it — `pieces` makes them concentric circles with `box-sizing`
   * holding each outer edge exactly on the circle its own `r` names, which is
   * what keeps the six in step — and a glow would be a second, softer edge
   * beside an exact one.
   */
  const circle = ({ r, band, ink }) => {
    const div = document.createElement("div");
    const size = 2 * r;
    div.style.cssText = "position:absolute;box-sizing:border-box;"
      + `width:${size}px;height:${size}px;border-radius:50%;`
      + (band ? `border:${band}px solid ${ink}`
              : `background:${ink}`);
    return div;
  };

  /** One axis: the outermost of its six circles, with the other five inside it.
   *
   * ONE MATRIX FOR THE WHOLE WIDGET, which is what the nesting buys and it is
   * worth the indirection. Every circle of an axis lives in the same plane, so
   * the parent's matrix is the only projection any of them needs: a child is a
   * plain box at a plain offset in the parent's own pixels, and the browser
   * composes. `place` then moves ONE element per axis per frame instead of six,
   * and everything below is written once, here.
   *
   * THE DARK RIM IS THE PARENT, because a parent paints under its children
   * whatever anybody's `z-index` says (CSS 2.1 §E.2: a negative `z-index` child
   * still comes after the parent's own background) and the rim is the bottom of
   * the stack. `pieces` is in that order for this reason.
   *
   * THE OFFSETS ARE IN THE PARENT'S PADDING BOX, which is its border box less
   * the rim's own band — so the centre of the parent, which is where the curves
   * belong, is `middle` from the corner rather than half the box.
   * `translate(-50%,-50%)` then pulls each child back by half of ITSELF, and
   * the disc's three are carried out to the handle by the one offset the ring's
   * own coordinates name — `(DISC_U, DISC_V)`, which is a point of the UNIT
   * circle and is therefore multiplied by `RING_PX` to become a length in this
   * element's own pixels. That multiplication is the ONE place the change of
   * unit reaches something that is not a box or a band.
   */
  const build = (axis) => {
    const [rim, ...rest] = pieces(axis);
    const group = circle(rim);
    // THE FADE IS THE RESTING STATE and the mask is how it is taken off again:
    // a ring under the cursor is drawn whole by setting this to `none`
    // (`light`), which is one write and no elements built or thrown away.
    group.style.cssText += ";left:0;top:0;display:none;"
      + `transform-origin:50% 50%;mask-image:${FADE}`;
    const middle = rim.r - rim.band;
    for (const part of rest) {
      const div = circle(part);
      div.style.left = `${middle + (part.disc ? DISC_U * RING_PX : 0)}px`;
      div.style.top = `${middle + (part.disc ? DISC_V * RING_PX : 0)}px`;
      div.style.transform = "translate(-50%,-50%)";
      group.appendChild(div);
    }
    root.appendChild(group);
    // The one that lightens: the disc's ink, which `pieces` puts last.
    return { axis, group, face: group.lastElementChild };
  };

  const rings = AXES.map(build);

  let frame = 0;
  // The gesture in progress: which ring it is on, the frame it was measured
  // against at the press, where in circle space the hand started and how far it
  // has gone since, the record it is applying, and whether the pointer has
  // travelled far enough to be a drag at all. Null between gestures.
  let drag = null;
  // Where the cursor was last seen, in client pixels, and whether it was over
  // the CANVAS when it was — the two things `place` needs to decide whether the
  // reader is hovering a disc.
  //
  // MUTATED IN PLACE rather than replaced, because `onMove` now runs on every
  // pointer move over the page for the whole life of this layer. The honest
  // accounting is that this saves the smaller half: the same handler asks
  // `internals()` for the canvas, which builds an object of nine keys, so a
  // reader doing nothing but moving the mouse already pays more garbage than
  // the pair would cost. It is kept because a pair that is read once a frame
  // and written many times a second is the one thing here with no reason to be
  // allocated at all, not because it is what makes this handler cheap.
  const pointer = [0, 0];
  let over = false;
  // Which axis is currently drawn lit — its circle whole and its disc pale — or
  // -1 for none. Held so that `light` can be a no-op on the frames where
  // nothing changed, which is nearly all of them.
  let lit = -1;

  /**
   * The selection these rings stand for, or null when there is nothing to put
   * them round.
   *
   * `held` IN gizmo.js, ASKED ABOUT THE SAME TOOL, and it has to be the same
   * question twice over: rings offering a turn that the press would then refuse
   * are a promise the widget cannot keep, and two halves of ONE widget that
   * appeared on different conditions would be a widget with a piece missing. So
   * the Move tool has to be in force, something has to be selected, and every
   * selected path has to be one the scene can move — with the extra clause a
   * gesture on the reader's own drawing carries, that a proposal body is
   * grabbable only when the panel can name it (`overlayBody`).
   *
   * MIXED SELECTIONS ARE REFUSED WHOLE by the `some` and then `every` below,
   * which is tools.js's line: one overlay path makes this a proposal gesture,
   * and then a part of the model has no body name and is not grabbable into it.
   * There is no such thing as half of either statement.
   *
   * `activeTool` AND NOT `state.tool`, for the reason tools.js gives: the hold
   * key puts the cut up without writing to `state`, and rings left standing
   * under a cut gesture would be offering a turn the press is no longer for.
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
    for (const ring of rings) ring.group.style.display = "none";
  };

  /** Draw axis `k` as the one the reader is about to turn, and the other two at
   *  rest. -1 lights none of them.
   *
   * THE WHOLE CIRCLE IS THE HOVER FEEDBACK, which is the second half of the
   * answer to "you cannot hit the axis you mean": the disc says where to press
   * and the circle that appears under the cursor says what pressing there will
   * DO — the plane the part is about to turn in, drawn before the reader has
   * committed to anything. Taking the mask off is all it costs, because the
   * circle is already there, faded away to nothing everywhere but the arc.
   *
   * ONLY WHEN IT CHANGES, and that is the point of `lit`. This is called once
   * per frame and would otherwise write six styles sixty times a second to say
   * what the DOM already holds — a widget nobody is hovering must cost nothing
   * beyond the hit test that establishes nobody is hovering it.
   */
  const light = (k) => {
    if (k === lit) return;
    lit = k;
    rings.forEach((ring, at) => {
      const on = at === k;
      ring.group.style.maskImage = on ? "none" : FADE;
      ring.face.style.background = on ? ring.axis.lit : ring.axis.ink;
    });
  };

  /** Measure the three ellipses against the scene as it stands, or null.
   *
   * THE CAMERA IS REFRESHED BEFORE ANYTHING IS PROJECTED, which is the order
   * handle.js and gizmo.js take and the reason is inside `cameraBasis`: it
   * calls `updateMatrixWorld`. Projected first, the centre would be placed off
   * whatever the matrices held from the last render while the rings round it
   * were measured off the refreshed ones — one frame drawn from two states of
   * one camera. `partCentre` does the same for the group's own matrix, which is
   * the other half: this loop is not the library's, so its frame can perfectly
   * well beat the render that would have composed it.
   */
  const measure = (sel) => {
    const g = internals(vp.viewer);
    if (!g) return null;
    // THE FIRST SELECTED PATH, which is the same anchor the press takes: a row
    // standing for five copies of a part turns as one thing, and the rings have
    // to stand round one of them rather than between them.
    //
    // READ OFF THE SCENE AND NOT OUT OF THE RECORD, exactly as the arrows'
    // anchor is: `partCentre` recomposes the group's matrix before reading it,
    // so this is where the part is standing NOW. A turn about the part's own
    // centre leaves that centre where it was (`movePart` derives it), so the
    // rings do not wander during a gesture — but a part that was DRAGGED
    // between two presses has moved, and rings anchored on anything else would
    // be drawn beside it.
    const at = partCentre(vp.viewer, sel.paths[0]);
    if (!at) return null;
    const rect = g.canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    if (!cameraBasis(vp.viewer, g)) return null;
    const box = vp.box.getBoundingClientRect();
    const frameOf = frameAt(g, rect, box, at);
    return frameOf ? { ...frameOf, box } : null;
  };

  /** Which axis the cursor is on right now, or -1.
   *
   * THE FRAME THE WIDGET WAS JUST DRAWN FROM, which is why this is asked here
   * and not in `onMove`: the answer needs the three ellipses, and measuring
   * them costs a `getBoundingClientRect` and a walk of the camera. Asked off
   * the frame that is being drawn anyway, a hover is three inversions of a 2x2
   * matrix — and asked in the move handler it would be that whole measurement,
   * on every pointer event, for a cursor that is usually nowhere near a disc.
   */
  const hovered = (frameOf) => {
    if (!over) return -1;
    const aim = aimAt(frameOf, [pointer[0] - frameOf.box.left,
                                pointer[1] - frameOf.box.top]);
    return aim ? aim.axis : -1;
  };

  /** Put the three rings round the part, or take them off the screen. */
  const place = () => {
    const sel = held();
    const frameOf = sel ? measure(sel) : null;
    if (!frameOf) {
      hide();
      light(-1);
      return;
    }
    // A DRAG OWNS THE LIGHT FOR AS LONG AS IT RUNS, whatever the pointer is
    // over — and the pointer leaves the disc immediately, because turning the
    // part is exactly the act of carrying the hand away from where it pressed.
    // A ring that went back to a faded arc under the hand holding it would be
    // saying the gesture had ended.
    light(drag ? drag.axis : hovered(frameOf));
    rings.forEach((ring, k) => {
      const ellipse = frameOf.rings[k];
      if (!ellipse) {
        ring.group.style.display = "none";
        return;
      }
      // ONE ELEMENT, AND THE OTHER FIVE COME WITH IT. `translate(-50%,-50%)`
      // is first in the list and therefore applies LAST, shifting the whole
      // transformed axis by half the untransformed box so that the ring's
      // centre lands on `C` rather than its corner. With `transform-origin`
      // at the middle the two cancel exactly, whatever the box measures: a
      // point of it lands at `C + M * (point - centre)`, which is why the
      // change of unit moved nothing on the screen.
      //
      // THE COLUMNS ARE DIVIDED BY `RING_PX`, and that division is the whole
      // of the unit. `a` and `b` are the screen vectors the ring's two world
      // axes span, whose widest combination IS `RING_PX` by construction
      // (`frameAt` picks the world radius to make it so) — so divided, the
      // matrix's widest direction is exactly 1, it carries shape and no size,
      // and every box and band inside it is the number of screen pixels it
      // says. The head of this file says what the other way round cost.
      const { a, b } = ellipse;
      ring.group.style.display = "";
      ring.group.style.left = `${frameOf.C[0]}px`;
      ring.group.style.top = `${frameOf.C[1]}px`;
      ring.group.style.transform = "translate(-50%,-50%) "
        + `matrix(${a[0] / RING_PX},${a[1] / RING_PX},`
        + `${b[0] / RING_PX},${b[1] / RING_PX},0,0)`;
    });
  };

  const draw = () => {
    frame = 0;
    place();
    schedule();
  };

  /**
   * One rAF loop, and only while there is a selection to put rings round.
   *
   * gizmo.js's loop, word for word in its reasoning: the library owns the
   * render loop and offers no post-render hook, and the trackball's `change`
   * event misses every frame a live swap, a visibility change or a gesture of
   * this very widget redraws. A loop that stops on its own costs nothing on the
   * ordinary page, which has no Move tool armed.
   *
   * THE INVARIANT THAT MAKES `refresh` ENOUGH: while a ring is on screen a
   * frame is always pending, because the only thing that shows one is `place`,
   * which runs from `draw`, which re-arms.
   */
  const schedule = () => {
    if (frame) return;
    if (!wanted()) return;
    frame = requestAnimationFrame(draw);
  };

  /** Let go of the gesture, wherever it ended.
   *
   * The listeners are on the WINDOW and in the capture phase for the reason
   * tools.js's `watch` gives: a drag that starts on a ring can perfectly well
   * end anywhere, and a release missed here strands the gesture forever.
   *
   * `pointermove` IS NOT ONE OF THEM ANY MORE. It is on the window for the
   * whole life of the layer, beside `pointerdown`, because it now answers two
   * questions rather than one: where the hand has carried a live drag, and
   * where the cursor is standing when there is no drag at all — which is what
   * says whether a disc is being hovered. One listener and one handler rather
   * than a second of each, so there is one place where this layer learns where
   * the pointer is.
   */
  const finish = () => {
    drag = null;
    removeEventListener("pointerup", onUp, true);
    removeEventListener("pointercancel", onCancel, true);
  };

  /** End the gesture and say which way the part ended up facing.
   *
   * ONE FUNCTION FOR EVERY ENDING THERE IS HERE — the release, a pointer the
   * platform took away, a second press arriving with one live, and the scene
   * being swapped out from under a hand that has not come off. `concludeMove`
   * in tools.js is the argument for reporting from all four: the part is
   * already standing turned where the reader left it, and only the document can
   * be wrong about that.
   *
   * ONLY IF THE GESTURE REALLY WAS A DRAG, which is the canvas gesture's rule
   * with the canvas gesture's meaning of `moved`: `CLICK_PX` of travel. A bare
   * press on a ring is not a statement, and the report would answer it by
   * writing a node.
   */
  const stop = () => {
    const live = drag;
    finish();
    if (live && live.moved) reportTurn(vp, live.turn);
  };

  function onMove(event) {
    // WHERE THE CURSOR IS, ON EVERY MOVE AND NOT ONLY DURING A GESTURE. The
    // hover this feeds is read once a frame by `place`, off the frame it has
    // just measured, so all this handler owes it is the position — and it must
    // be taken before the early return below, because the frames where nothing
    // is being dragged are exactly the frames a hover is for.
    //
    // AND WHETHER THE PRESS IT PROMISES COULD LAND, which is `onDown`'s own
    // guard asked one event earlier and is the whole reason this line is here.
    // A hover is a promise that pressing HERE turns THIS axis; `onDown` takes a
    // press only off the canvas, because the toolbar, a comment pin and the
    // view cube are boxes that take their own. A disc lying under one of those
    // is geometrically under the cursor and is not pressable, so lighting it
    // would be the widget offering a gesture that then goes somewhere else and
    // turns nothing — and at `RING_PX` the reach of this widget covers more of
    // that chrome than it used to. The target is the same test, so the two
    // cannot disagree.
    pointer[0] = event.clientX;
    pointer[1] = event.clientY;
    const g = internals(vp.viewer);
    over = !!g && event.target === g.canvas;
    if (!drag) return;
    // A CLICK IS NOT A ONE-PIXEL DRAG, and the canvas gesture spells the same
    // rule out: until the pointer has travelled `CLICK_PX` this press is still
    // a click. It matters more here than there, because there IS no click on a
    // ring — nothing selects, and the only thing a twitch can do is turn the
    // part a degree and file a node the reader never asked for, which opens the
    // panel on top of it.
    if (!drag.moved
        && Math.abs(event.clientX - drag.startX) < CLICK_PX
        && Math.abs(event.clientY - drag.startY) < CLICK_PX) return;
    drag.moved = true;
    const point = [event.clientX - drag.box.left, event.clientY - drag.box.top];
    const p = circleSpace(drag.ring, drag.C, point);
    if (!p) return;
    const theta = Math.atan2(p[1], p[0]);
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
    // `swept` is kept honest for the reader of this function rather than for
    // the document.
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
        && turn[2] === d.last[2]) return;
    d.last = turn;
    // THE TWO MEANINGS, AND THE TWO CALLS `dragPart` MAKES FOR THE OTHER HALF
    // OF A PLACEMENT. A body of the proposal is turned for the eye alone and
    // NOTHING IS RECORDED for it — an angle in `vp.moved` would be re-applied
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
   * A press on the canvas, taken only if it landed on a ring's DISC.
   *
   * ON THE WINDOW AND IN THE CAPTURE PHASE, which is the price of a layer that
   * takes no presses of its own — and it buys the one thing a target would not:
   * a press that MISSES every disc is left completely alone, so it goes on to
   * the tools' own listener and to the trackball behind it, and the reader can
   * still orbit, pick and open the part menu with the tool armed. Capture on
   * the window runs before the capture-phase listener tools.js puts on the
   * container, so `stopPropagation` here is enough to take a press this widget
   * does want away from both.
   *
   * THE CANVAS AND NOTHING ELSE. `event.target !== g.canvas` is the same guard
   * tools.js's `onDown` opens with, and on a window listener it is what keeps
   * this from reading a press on the tree, on a button or on one of the four
   * layers stacked over the canvas as a press on the model.
   *
   * THE PRIMARY BUTTON AND NOTHING ELSE, so a right-drag the reader meant as a
   * pan, and a middle click, no longer turn the part.
   */
  function onDown(event) {
    if (event.button !== 0) return;
    const g = internals(vp.viewer);
    if (!g || event.target !== g.canvas) return;
    // A previous gesture is concluded before a new one begins, exactly as
    // `onDown` in tools.js does it: a second pointer landing would otherwise
    // overwrite the press point with its own, and the part it interrupted is
    // standing at an angle no node claims. BEFORE the hit test, because that is
    // true of a press that misses the rings as well.
    stop();
    // AND THE ARROWS' GESTURE WITH IT, which is new with the merge and is the
    // same sentence about the other layer. Until the tools were merged the
    // CROSS case could not arise: this layer wanted `turn` and gizmo.js wanted
    // `move`, so only one of the two was ever alive to be interrupted. They
    // answer to one tool now, so a finger on an arrow followed by a finger on a
    // disc leaves TWO live drags — both `onMove`s on the window, neither
    // filtering by pointer id, each calling `movePart` with its own snapshot of
    // the other's half of the node (`turnRecord.delta` here, `moveRecord.turn`
    // there). They overwrite each other frame by frame and both report at the
    // release. `gizmo.js`'s own `onDown` carries the argument at length.
    //
    // ALSO ON A PRESS THAT MISSES EVERY DISC, for the reason the line above is
    // here rather than below the hit test: this is the reader putting a second
    // finger on the MODEL while an arrow is still held, which strands that drag
    // exactly as a press on a disc would.
    //
    // BEFORE `turnRecord` IS BUILT, which is what makes the hand-over clean:
    // concluding the arrow's drag leaves its offset standing in `vp.moved`, and
    // `turnRecord` reads that field for the `delta` it carries through — so the
    // turn about to start begins from where the slide actually ended.
    //
    // NO CHECK THAT THE NEIGHBOUR IS THERE: `element.js` builds the arrows and
    // then this layer inside ONE synchronous `connectedCallback`, so no press
    // can be dispatched between the two lines, and its `destroy()` leaves both
    // fields standing while taking both layers' listeners away.
    vp.gizmo.endDrag();
    const sel = held();
    if (!sel) return;
    // MEASURED ONCE AND HELD FOR THE WHOLE GESTURE, exactly as `onDown` in
    // gizmo.js holds its axis and handle.js its screen axis: the camera cannot
    // move under a press this widget owns, and re-measuring per event would let
    // the part drift away from the hand. THROUGH THE SAME FUNCTION `place`
    // DRAWS FROM, so the ring on screen is the ring that turns.
    const frameOf = measure(sel);
    if (!frameOf) return;
    const point = [event.clientX - frameOf.box.left,
                   event.clientY - frameOf.box.top];
    // THE DISC AND NOT THE CURVE, which is the same question `hovered` asks and
    // has to be: the reader presses the thing that lit up under the cursor, so
    // one function answers both or the widget promises one axis and turns
    // another.
    const aim = aimAt(frameOf, point);
    if (!aim) return;
    // Only now is the press ours. `preventDefault` suppresses the compatibility
    // mouse events, so this press cannot turn into a double-click somewhere
    // else; `stopPropagation` is what keeps it from also starting a rotation
    // and a tools.js gesture underneath.
    event.stopPropagation();
    event.preventDefault();
    // AND THE CANVAS GESTURE, WHICH IS THE THIRD THING THAT CAN BE LIVE. The
    // complete list, since the `endDrag` above reads as if it were the whole of
    // it: this layer's own drag (`stop()`), the arrows' (`vp.gizmo.endDrag()`),
    // the canvas gesture in tools.js (this line), and the section grip's, which
    // is deliberately left alone because it drives the clipping PLANE and
    // nothing it writes is anything this reads. `gizmo.js`'s `onDown` carries
    // the argument at length.
    //
    // HERE AND NOT BESIDE THE `endDrag` ABOVE, which is the one place the two
    // layers' answers differ and the difference is exactly the line above this
    // one. tools.js concludes its own previous press at the head of its
    // `onDown`, and that listener DOES see every press aimed at the canvas — so
    // a press that misses every disc needs nothing from this line: it goes
    // straight on and tools.js ends the live gesture itself. It is
    // `stopPropagation` that opens the hole, by taking the press away before
    // that listener runs, and the hole is therefore exactly as wide as the
    // presses this layer keeps.
    //
    // AND MOVING IT UP WOULD BE WORSE THAN REDUNDANT. `endGesture` CONCLUDES,
    // and concluding a cut means `reportCut`, which the interface answers by
    // disarming the armed tool — which is why tools.js's own `onDown` calls
    // `concludeMove` and not `conclude`. Called before the hit test, this would
    // do that on EVERY canvas press with a cut drag still live, including the
    // ordinary ones this layer declines.
    //
    // BEFORE `turnRecord` IS BUILT, for the same reason the `endDrag` above is:
    // concluding the canvas drag leaves its offset standing in `vp.moved`, and
    // `turnRecord` reads that field for the `delta` it carries through.
    //
    // `vp.endGesture` IS ALWAYS A FUNCTION HERE. `installTools` assigns it in
    // the same synchronous `connectedCallback` that builds this layer, and
    // although its teardown nulls it — which `vp.gizmo` is not — that teardown
    // runs inside `destroy()`, in the same synchronous block that takes this
    // layer's window listeners away.
    vp.endGesture();
    drag = {
      axis: aim.axis,
      ring: aim.ring,
      C: frameOf.C,
      box: frameOf.box,
      theta: aim.theta,
      swept: 0,
      startX: event.clientX,
      startY: event.clientY,
      turn: turnRecord(vp, sel.paths, sel.paths[0], sel.proposal),
      moved: false,
    };
    addEventListener("pointerup", onUp, true);
    addEventListener("pointercancel", onCancel, true);
  }

  addEventListener("pointerdown", onDown, true);
  addEventListener("pointermove", onMove, true);

  /** End a drag the reader has not let go of, because the scene is going away.
   *
   * THE TWIN OF `vp.endGesture`, of the grip's `endDrag` and of the arrows',
   * and it exists for the failure all three were written for: the press was
   * taken in a window listener this layer owns, so neither that gesture nor the
   * idle clock that defers the swap ever saw it, and the release that would
   * have concluded it never comes. Concluding rather than abandoning is
   * `concludeMove`'s argument: the part stands turned in `vp.moved` with
   * nothing in the document claiming it, and the next push straightens it under
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
      // `finish` and not `stop`: this is the element going away, and `vp.moved`
      // goes with it, so the pose there would be to report is one nothing is
      // left standing at — the same fifth ending tools.js's teardown takes.
      finish();
      // AND THE TWO LIFELONG LISTENERS WITH IT, which the two above are not:
      // these are on the window for the whole life of the layer rather than for
      // the length of a gesture, so a viewport unmounted with no drag in
      // progress would still leave them there holding a scene that is gone —
      // and the move one would go on recording a cursor for nobody.
      removeEventListener("pointerdown", onDown, true);
      removeEventListener("pointermove", onMove, true);
      root.remove();
    },
  };
}
