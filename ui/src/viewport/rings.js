// The turn tool's rings: three of them round the selected part, one per world
// axis, each dragged to turn the part about THAT AXIS ONLY.
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
// `const SVG_NS` in viewcube.js. An ellipse costs one div here, so the price of
// keeping that pin is three elements.
//
// THREE DIVS AND NOT THREE POLYLINES, which is the whole trick of this file. A
// world circle seen under an orthographic camera projects to an ELLIPSE, and an
// ellipse is what a CSS `matrix()` does to a circle — so each ring is one
// 2x2-pixel round div under the projection's own 2x2 matrix, and the browser
// draws the curve. Chopping the circle into a run of segments would be sixty
// elements per ring, re-laid-out sixty times a second, to approximate something
// the compositor renders exactly.
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
  CLICK_PX, RING_HIT_PX, RING_MIN_PX, RING_PX, RING_SHAFT_PX,
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
 */
const AXES = [
  { world: [1, 0, 0], ink: "#c93a31" },
  { world: [0, 1, 0], ink: "#2e8b40" },
  { world: [0, 0, 1], ink: "#2d66c7" },
];

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
    // cannot use is worse than no control. Here it is also the two divisions
    // below going singular.
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

/**
 * Did this press land ON one ring's curve, and where — `{theta, away}` in
 * radians and pixels, or null.
 *
 * THE HIT TEST IS OURS AND IS ANALYTIC, because the library's picker answers
 * about parts and has never heard of this layer, and because the browser's own
 * hit testing cannot answer it either: a div is a filled box however round its
 * corners are made, so an element that could take the press would take every
 * press INSIDE the ring with it — over the part, which is where the reader
 * grabs to orbit. Hence `pointer-events: none` on the whole layer, unlike the
 * three widgets beside it, and hence this.
 *
 * THE ELLIPSE'S OWN POINT AT THAT ANGLE, and the distance to THAT. The obvious
 * test — is the pointer's radius in circle space near 1 — measures in circle
 * units, which are pixels stretched by however much the projection squashed the
 * ring: on a ring seen nearly edge-on it would accept a press a hand's breadth
 * away along the flat direction. Measured back on the screen, the tolerance is
 * `RING_HIT_PX` of real PIXELS.
 *
 * OF THE PIXELS TO ONE PARTICULAR POINT, AND NOT TO THE NEAREST ONE, which is
 * the limit of that and is worth stating rather than implying. The point
 * compared against is the ellipse's at the SAME circle-space angle the press
 * came back as, which is the nearest point only on a ring seen square on. On an
 * oblique one it lies off to the side, so the measured distance is longer than
 * the real gap to the curve and the ring is harder to grab than `RING_HIT_PX`
 * promises: on `a = (64, 0)`, `b = (0, 12)` a press 5.5 px from the drawn curve
 * measures past 8 and is refused. THE ERROR IS ALL ONE WAY — this test never
 * accepts a press the true distance would refuse — so what it costs is a
 * flattened ring that wants aiming at, and not a press stolen from the orbit
 * underneath. The true distance is the root of a quartic; this is one `atan2`.
 */
function onCurve(ring, C, point) {
  const p = circleSpace(ring, C, point);
  if (!p) return null;
  const theta = Math.atan2(p[1], p[0]);
  const ex = C[0] + Math.cos(theta) * ring.a[0] + Math.sin(theta) * ring.b[0];
  const ey = C[1] + Math.cos(theta) * ring.a[1] + Math.sin(theta) * ring.b[1];
  const away = Math.hypot(point[0] - ex, point[1] - ey);
  return away <= RING_HIT_PX ? { theta, away } : null;
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
 * canvas drag and the axis arrows — and a second hand-written copy is how they
 * would start disagreeing about what a drag means. There is one gesture that
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
  // because all four are pressed on a BOX. A ring is a curve with a hole in it:
  // a div is a filled box however round its corners are, so a target here would
  // swallow every press over the part it is drawn round — the orbit, the pick
  // and the part menu with it. So nothing on this layer takes a press, and the
  // press is read off the CANVAS in the capture phase instead (`onDown`).
  //
  // NO CLASS NAME, for the view cube's and the gizmo's reason: a class is a
  // promise the interface's stylesheet keeps a rule for it
  // (tests/test_ui_source.py checks exactly that), and everything about how this
  // looks is a legibility requirement over two canvases rather than a palette
  // the designer owns.
  root.style.cssText =
    "position:absolute;inset:0;overflow:hidden;pointer-events:none";

  /** One ring: a two-pixel circle for the projection's matrix to work on. */
  const build = ({ ink }) => {
    const div = document.createElement("div");
    // A UNIT CIRCLE, and every number in this rule is in service of that. The
    // box is 2 px square with `border-radius: 50%`, so its edge is a circle of
    // radius ONE about its own centre — and `matrix(a.x, a.y, b.x, b.y, 0, 0)`
    // is precisely the map sending `(cos t, sin t)` to `cos t * a + sin t * b`,
    // which is the projected ring. `translate(-50%,-50%)` comes first in the
    // list and therefore applies LAST, shifting the whole transformed circle by
    // half the untransformed box so that its centre lands on `C` rather than
    // its corner.
    //
    // THE LINE IS A FRACTION OF A PIXEL because the matrix is about to multiply
    // it by `RING_PX`: `RING_SHAFT_PX / RING_PX` of the local unit comes out as
    // `RING_SHAFT_PX` on the screen at the ring's widest point.
    //
    // AND THINNER EVERYWHERE ELSE, WHICH IS CORRECT. The same matrix that turns
    // the circle into an ellipse squashes the border with it, so the ring is
    // drawn finest where it is turning away from the reader. That is what a
    // real ring looks like seen at an angle; an outline of uniform weight would
    // be a lie about the shape, and the reader would lose the one cue that says
    // which way the ring is facing — which is the cue that says which way the
    // part will turn.
    //
    // `box-sizing: border-box` so the border grows INWARDS and the outer edge
    // stays exactly the unit circle: with the default the ring would be drawn a
    // few per cent larger than `RING_PX`, which is a widget whose size depends
    // on how thick its line is.
    //
    // NO HALO, unlike the grip and the arrows, and for a reason of the geometry
    // rather than of the palette: `filter` and `box-shadow` are computed in the
    // element's OWN space, so a one-pixel glow on a two-pixel box would be
    // multiplied by the same `RING_PX` the border is and come back as sixty
    // pixels of smudge. What stands in for it is the shape: a closed curve the
    // width of the widget reads on either canvas where a two-pixel shaft would
    // not.
    div.style.cssText = "position:absolute;left:0;top:0;display:none;"
      + "box-sizing:border-box;width:2px;height:2px;border-radius:50%;"
      + `border:${RING_SHAFT_PX / RING_PX}px solid ${ink};`
      + "transform-origin:50% 50%";
    root.appendChild(div);
    return div;
  };

  const rings = AXES.map((axis) => ({ axis, div: build(axis) }));

  let frame = 0;
  // The gesture in progress: which ring it is on, the frame it was measured
  // against at the press, where in circle space the hand started and how far it
  // has gone since, the record it is applying, and whether the pointer has
  // travelled far enough to be a drag at all. Null between gestures.
  let drag = null;

  /**
   * The selection these rings stand for, or null when there is nothing to put
   * them round.
   *
   * `held` IN gizmo.js, ASKED ABOUT THE OTHER TOOL, and it has to be the same
   * question: rings offering a turn that the press would then refuse are a
   * promise the widget cannot keep. So the Turn tool has to be in force,
   * something has to be selected, and every selected path has to be one the
   * scene can move — with the extra clause a gesture on the reader's own
   * drawing carries, that a proposal body is grabbable only when the panel can
   * name it (`overlayBody`).
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
    if (vp.activeTool !== "turn") return null;
    const paths = Array.isArray(vp.state.selected) ? vp.state.selected : [];
    if (!paths.length) return null;
    const proposal = paths.some((path) => vp.isOverlay(path));
    const grabbable = (path) => !!movableGroup(vp.viewer, path)
      && (!proposal || !!vp.overlayBody(path));
    return paths.every(grabbable) ? { paths, proposal } : null;
  };

  const wanted = () => !!held();

  const hide = () => {
    for (const ring of rings) ring.div.style.display = "none";
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

  /** Put the three rings round the part, or take them off the screen. */
  const place = () => {
    const sel = held();
    const frameOf = sel ? measure(sel) : null;
    if (!frameOf) {
      hide();
      return;
    }
    rings.forEach((ring, k) => {
      const ellipse = frameOf.rings[k];
      if (!ellipse) {
        ring.div.style.display = "none";
        return;
      }
      const { a, b } = ellipse;
      ring.div.style.display = "";
      ring.div.style.left = `${frameOf.C[0]}px`;
      ring.div.style.top = `${frameOf.C[1]}px`;
      ring.div.style.transform = "translate(-50%,-50%) "
        + `matrix(${a[0]},${a[1]},${b[0]},${b[1]},0,0)`;
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
   * ordinary page, which has no Turn tool armed.
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
   */
  const finish = () => {
    drag = null;
    removeEventListener("pointermove", onMove, true);
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
   * A press on the canvas, taken only if it landed on a ring.
   *
   * ON THE WINDOW AND IN THE CAPTURE PHASE, which is the price of a layer that
   * takes no presses of its own — and it buys the one thing a target would not:
   * a press that MISSES every ring is left completely alone, so it goes on to
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
    // THE NEARER OF TWO RINGS THAT ARE BOTH HIT, by the same distance the hit
    // was decided on. Three rings cross at six points and near a crossing both
    // answers are honest, so the tie is broken by the only thing that says
    // which one the hand was aiming at.
    let aim = null;
    frameOf.rings.forEach((ring, k) => {
      if (!ring) return;
      const hit = onCurve(ring, frameOf.C, point);
      if (hit && (!aim || hit.away < aim.away)) {
        aim = { axis: k, ring, theta: hit.theta, away: hit.away };
      }
    });
    if (!aim) return;
    // Only now is the press ours. `preventDefault` suppresses the compatibility
    // mouse events, so this press cannot turn into a double-click somewhere
    // else; `stopPropagation` is what keeps it from also starting a rotation
    // and a tools.js gesture underneath.
    event.stopPropagation();
    event.preventDefault();
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
    addEventListener("pointermove", onMove, true);
    addEventListener("pointerup", onUp, true);
    addEventListener("pointercancel", onCancel, true);
  }

  addEventListener("pointerdown", onDown, true);

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
      // AND THE PRESS LISTENER WITH IT, which the three above are not: this one
      // is on the window for the whole life of the layer rather than for the
      // length of a gesture, so a viewport unmounted with no drag in progress
      // would still leave it there holding a scene that is gone.
      removeEventListener("pointerdown", onDown, true);
      root.remove();
    },
  };
}
