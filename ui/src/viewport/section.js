// The section plane: click a face, the cutting plane takes that face's
// orientation and lands flush on it, then it slides along its own normal to open
// the part up. The Fusion move, and ui-brief block 4.
//
// The library gives us the plane (`setClipNormal` takes an ARBITRARY normal; the
// axes in `resetClip` are only its defaults) and the movement (`setClipSlider`).
// What it does not give is the normal of a face — that is `picking.js` — and the
// frame of reference the slider counts in, which is the whole of the note below.

import { cameraBasis, projectPoint } from "./camera.js";
import { internals } from "./internals.js";
import {
  clamp, cross3, dot3, finite3, sineFromCos, sub3, unit3, vec3,
} from "./math.js";
import { MIN_SINE, SECTION_BIAS, SECTION_INDEX } from "./options.js";
import { clearSectionOutlines, sectionOutline } from "./outline.js";

/** Half the grid: the range the library's own clip sliders span. */
export function sectionLimit(viewer) {
  const g = viewer && viewer.gridSize;
  return Number.isFinite(g) && g > 0 ? g / 2 : null;
}

function sectionValue(viewer, v) {
  const lim = sectionLimit(viewer);
  return lim === null ? v : clamp(v, -lim, lim);
}

/** The sliver the plane is sunk into the part by, in world units.
 *
 * A RENDER NUDGE, NOT A DEPTH: it exists so the library's stencil cap quad does
 * not z-fight the face it would otherwise be coplanar with (options.js,
 * `SECTION_BIAS`), and nobody asked for it. So exactly one function adds it —
 * `applySection`, on the way to the slider — and every function that READS where
 * the plane stands takes it back out again: `sectionOffset`, whose answer the
 * interface stores in `state.cutOffset`, and `captureSection`, whose answer a
 * live reload restores from. A reading that kept it would be handed straight
 * back to `applySection` by its caller and sunk one sliver deeper, every time,
 * without limit.
 *
 * `|| 1` covers a scene with no grid yet, and is written once here so a reading
 * cannot fall out of step with the write.
 */
function sectionBias(viewer) {
  return (sectionLimit(viewer) || 1) * SECTION_BIAS;
}

/** Ceiling on one pointermove's worth of travel.
 *
 * The angle guard already keeps the px -> world factor finite, but "finite" is
 * not "small": a plane 9 degrees off the view axis still moves ~6 world units
 * per pixel, and one flick would send it clean through the model. A tenth of the
 * full travel per event is more than a hand can produce and less than a jump
 * anyone would notice.
 */
const stepCap = (viewer) => (sectionLimit(viewer) || 1) / 10;

/** Unit direction from the camera towards `point`, or null.
 *
 * NULL IS THE ONLY WAY THIS DECLINES, and both callers lean on that. `unit3`
 * answers a vector carrying an infinity with a vector of NaNs — an array, and
 * therefore truthy — so returning its result unchecked would hand `!view` and
 * `!n` a value they cannot refuse. What each of them does with NaNs afterwards
 * is worse than useless: `placeSectionPlane` writes a seed nothing can measure,
 * and `sectionAxis` takes `sineFromCos` of a NaN and compares the NaN that comes
 * back against `MIN_SINE`, a comparison that is false, which is the ACCEPTING
 * branch of the guard against a plane seen edge-on.
 *
 * That covers a bad `point` and a bad eye alike — an infinite `eye.y` reached
 * here for as long as this checked `eye.x` alone.
 */
function viewDir(g, point) {
  const eye = g.camera.getPosition();
  // `point` is checked HERE and not by the callers, because this is the function
  // that dereferences it: `vec3(null)` reads `null[0]` and THROWS, which is the
  // one way this could decline that is neither null nor a NaN — and
  // `placeSectionPlane` runs outside any `try`. Everything else a bad point can
  // be (an infinity, a NaN, a short array) comes back through `finite3(dir)`
  // below; this line is only about the ones that would not come back at all.
  if (!eye || !finite3(point)) return null;
  const dir = unit3(sub3(vec3(point), eye));
  return finite3(dir) ? dir : null;
}

/**
 * How much of a unit world vector survives the projection, between 0 and 1.
 *
 * 1 when it lies square across the view and 0 when it points straight down the
 * camera's axis — which for the grip's arrow is the difference between seeing
 * the whole of it and seeing its end.
 *
 * AGAINST THE CAMERA'S OWN AXIS AND NOT THE RAY TO A POINT, which is the whole
 * reason this is a function rather than the sine `sectionAxis` computes in its
 * own guard. This viewport's camera is ORTHOGRAPHIC: every point projects along
 * one fixed direction, so the foreshortening of a vector is its angle to THAT
 * direction and has nothing to do with where on the screen it happens to sit.
 * The guard's `viewDir` is the ray from the eye to the anchor, which swings
 * across the frame — measured on a 45-degree plane, it reported 0.55 with the
 * cut on one side of a part and 0.83 on the other, both for a plane standing at
 * exactly the same angle. Drawn from that, the arrow's length would encode
 * where the cut is on screen as much as how the plane stands, which is the
 * opposite of what it is for.
 *
 * THE GUARD IS LEFT ON `viewDir` DELIBERATELY. It answers a different question
 * — whether px -> world is about to run away under the DRAG — and that one is
 * asked about the pointer, which does move along the ray. Its tests pin it and
 * the drag is not part of this.
 *
 * Null when the camera cannot be read at all. The caller draws the arrow at
 * full length then, which is what it did before any of this and leaves the
 * widget visible and grabbable rather than collapsed on a scene nobody can
 * measure.
 */
function foreshorten(viewer, g, n) {
  const basis = cameraBasis(viewer, g);
  if (!basis) return null;
  // Both are unit vectors, so the dot IS the cosine and no division enters it.
  // `sineFromCos` carries the clamp that dot still needs.
  return sineFromCos(dot3(n, basis.view));
}

/**
 * The slider value that stands a plane with `normal` through `point`, or null.
 *
 * PURE — it writes nothing, and that is the whole reason it is a function of its
 * own. See `standSection`.
 *
 * The slider's frame of reference, read off the library rather than guessed at:
 *
 *   `setClipSlider(i, value)` -> `Clipping.setConstant(i, value)` ->
 *   `CenteredPlane.setConstant(value)`, which computes
 *       constant = distanceToPoint(0) - distanceToPoint(centre) + value
 *                = value - normal . centre
 *   so with three.js's `distanceToPoint(p) = normal . p + constant` the plane
 *   sits where `normal . (p - centre) = -value`. THE ZERO OF THE SLIDER IS THE
 *   CENTRE OF THE CLIPPING REGION — the grid centre — and NOT the model origin.
 *   That is why `resetClip` parks it at `gridSize / 2`: the far edge of the
 *   grid, where the plane cuts nothing.
 *
 * Inverting that one line gives `value = -normal . (point - centre)`, which
 * needs nothing from the plane that is currently standing — in particular it
 * does not need the plane to already carry `normal`. THAT is what lets the
 * normal and the slider go into the library together, which is the whole of
 * `applySection`'s atomicity.
 *
 * `centre` is `CenteredPlane.center`, one property deeper than the `plane` that
 * `internals()` guards, so it is checked here: a library that stopped carrying
 * it costs the section tool its placement and nothing else.
 *
 * `normal` MUST BE A UNIT VECTOR, and that is a real precondition rather than a
 * style note: the dot product above measures a distance only when it is, and the
 * same normal is walked by `applySection` to build the point it is asked about,
 * so a normal of length 2 is wrong TWICE and in different proportions — the
 * plane lands somewhere nobody chose. Measured on the scene the suite uses: with
 * a normal of length 2 a cut aimed at the face stands 4.98 world units off it.
 *
 * NOTHING HERE NORMALISES, and that is not the invariant going unenforced — it
 * is enforced one level up, at THE SEED, which is the only door a normal enters
 * this module by. `placeSectionPlane` and `restoreSection` are the two functions
 * that write `vp.sectionSeed`, and both run `unit3` before they do; everything
 * downstream — this, `applySection`'s `at`, `sectionOffset` — then reads one
 * already-unit normal. Doing it here instead would fix only the value and leave
 * `at` wrong, which is worse than not doing it: a half-correct placement looks
 * robust. Any third writer of the seed has to normalise the same way.
 */
export function sectionValueFor(viewer, g, normal, point) {
  const centre = g.plane && g.plane.center;
  if (!finite3(centre) || !finite3(normal) || !finite3(point)) return null;
  const value = sectionValue(viewer, -dot3(normal, [point[0] - centre[0],
                                                    point[1] - centre[1],
                                                    point[2] - centre[2]]));
  return Number.isFinite(value) ? value : null;
}

/** A slider value the library will actually take.
 *
 * `Viewer.setClipSlider` opens with `if (value === -1 || value == null) return`
 * — -1 is its spelling of "no value given". So a placement that works out to
 * exactly -1 sets the NORMAL and leaves the slider parked at the far edge of the
 * grid, which cuts the whole model away: the same half-applied state
 * `standSection` exists to make impossible, arrived at from the other side. A
 * billionth off it is the same plane to look at and is a number the library
 * takes.
 *
 * EVERY WRITE OF THE SLIDER GOES THROUGH HERE — `standSection` and
 * `dragSection`, the two that compute a value — because the failure is the
 * library's and not the caller's, so a path that skipped it would be silently
 * stuck at one number. The third writer, `suspendSectionCut`, does not compute
 * anything: it writes `sectionLimit`, which `sectionLimit` itself returns only
 * for a positive grid and which therefore cannot be -1.
 */
const sliderSafe = (v) => (v === -1 ? -1 + 1e-9 : v);

/**
 * Stand the plane at `normal` through `point`. Returns the value it set, or
 * null when the numbers came back unusable — in which case NOTHING was written.
 *
 * ONE library call, not two, and that is the point rather than a tidy-up. The
 * previous arrangement set the normal first and unconditionally (with a null
 * value, so the library parked the slider at its documented default) and then
 * corrected the slider "from a KNOWN state". Every failure between those two
 * writes returned false with the plane left somewhere it was never meant to
 * stand — turned over AND parked at the far edge, which is the one combination
 * that cuts the entire model away. `setClipNormal` takes the value itself, so
 * the pair is one call once the value is known in advance, and the only thing
 * left in front of it is arithmetic that writes nothing.
 */
function standSection(vp, g, normal, point) {
  const viewer = vp.viewer;
  const value = sectionValueFor(viewer, g, normal, point);
  if (value === null) return null;
  const safe = sliderSafe(value);
  // The contour exists before the write, whose call ends in a render.
  sectionOutline(vp, g, normal, safe);
  viewer.setClipNormal(SECTION_INDEX, normal, safe, true);
  return safe;
}

/**
 * Lay the plane on a face: `normal` orients it, `point` locates it. Records the
 * seed and returns true when it took.
 */
export function placeSectionPlane(vp, g, normal, point) {
  const viewer = vp.viewer;
  // THE SEED IS CHECKED WHOLE, BEFORE ANYTHING IS WRITTEN — both halves of it,
  // because a seed is a normal AND a point and the rest of the module reads it
  // as one thing. `vp.sectionSeed` being non-null is what tells
  // `keepSectionCut`, `sectionOffset` and `captureSection` that a cut exists, so
  // a seed written out of numbers nothing can measure is worse than no seed:
  // `applySection` still refuses to place a plane and returns false, and leaves
  // that record behind for every one of them to believe. Every exit here is the
  // one a pick that found no face gets: no cut, and NOTHING WRITTEN.
  //
  // THE POINT IS COVERED BY THIS LINE, which is why there is no separate check
  // for it: `viewDir` measures from the eye TO the point and is total (see
  // there), so a point that is not a place cannot produce a direction. Said
  // plainly because the check does not look like it is about the point at all.
  const view = viewDir(g, point);
  if (!view) return false;
  // NORMALISED HERE, because this is one of the two doors a normal enters the
  // module by and everything downstream assumes a unit one (`sectionValueFor`
  // says what breaks otherwise). `faceNormalAt` does hand back a unit vector
  // today, and picking.js has a suite of its own now — but the length of what
  // that particular function returns is not among the things it pins, and the
  // cost of it changing is a plane standing metres from the face with nothing
  // reporting anything.
  //
  // `finite3` AND NOT the null `unit3` returns, because null is only one of the
  // two ways it declines: a component that is already Infinity has no direction
  // to find and comes back as `[NaN, …]`, an array. `unit3` itself is what makes
  // this the ONLY remaining case — it scales by the largest component, so a
  // vector too large or too small to square is answered rather than refused
  // (math.js says why that used to be a finite vector of length zero, which is
  // exactly what a check for finiteness cannot see).
  const unit = unit3(normal);
  if (!finite3(unit)) return false;
  // three.js keeps the half-space the normal points INTO. A normal pointing away
  // from the camera therefore throws away the near side — everything between the
  // reader and the face — which is the direction a section cut opens. Taken from
  // the camera rather than from the face winding, so a model whose triangles are
  // wound inwards still cuts the way it looks like it should.
  const n = dot3(unit, view) < 0
    ? [-unit[0], -unit[1], -unit[2]] : unit;
  vp.sectionSeed = { normal: n, point, value: null };
  return applySection(vp, g);
}

/**
 * Put the plane where the seed and the interface's state say it should be.
 *
 * Everything that moves this plane other than a drag goes through here — the
 * initial placement, the offset slider, the flip, and the restore after a live
 * reload — so the three fields of `state` that describe a cut have exactly one
 * reading.
 */
export function applySection(vp, given) {
  const viewer = vp.viewer;
  const seed = vp.sectionSeed;
  if (!viewer || !seed) return false;
  const g = given || internals(viewer);
  if (!g) return false;
  const flip = !!vp.state.cutFlip;
  const offset = Number.isFinite(vp.state.cutOffset) ? vp.state.cutOffset : 0;
  const n = flip ? [-seed.normal[0], -seed.normal[1], -seed.normal[2]]
                 : seed.normal;
  // A FLIP TURNS THE PLANE OVER AND MOVES NOTHING. It changes which half-space
  // is kept, which is what Fusion's `Flip` does and what the word means.
  //
  // This line used to read `seed.point + n * offset` — the offset walked along
  // the FLIPPED normal — with the reason written beside it: "so 'deeper' stays
  // deeper after a flip rather than reversing under the reader". The intent was
  // sound and the implementation is not, because the only way to hold "deeper"
  // fixed while the kept side turns over is to MOVE THE PLANE, and the two
  // changes then compound instead of cancelling: the kept side becomes the
  // outside of the part AND the plane walks that far further outside it. A cut
  // six millimetres into a plate came back as an empty canvas — measured in a
  // browser — where turning the plane over should have shown the six
  // millimetres. The offset therefore counts along the SEED normal, which is
  // the face's own direction and does not move.
  //
  // What that leaves is the offset of ZERO, and it is a different question with
  // a different answer: there the plane lies exactly on the face that was
  // clicked, the part is entirely on one side of it, and keeping the other side
  // honestly leaves nothing to draw. No arithmetic here can help with that.
  const depth = offset + sectionBias(viewer);
  // The bias goes on here, along the same seed normal, and is THE ONLY PLACE IT
  // IS ADDED — see `sectionBias` for why every reader subtracts it again. It
  // sinks the plane that sliver into the part, which is what keeps the library's
  // stencil cap quad off the face it would otherwise z-fight with.
  const at = [seed.point[0] + seed.normal[0] * depth,
              seed.point[1] + seed.normal[1] * depth,
              seed.point[2] + seed.normal[2] * depth];
  try {
    const value = standSection(vp, g, n, at);
    if (value === null) return false;
    seed.value = value;
    // A plane placed while some other tab is open would be a cut nobody can see.
    // The tab goes first because switching INTO it is what turns local clipping
    // and the stencil caps on through the library's own path; `keepSectionCut`
    // then makes the result independent of whether that path ran.
    showTab(vp, "clip");
    keepSectionCut(vp, g);
    return true;
  } catch (error) {
    console.warn("section apply", error);
    return false;
  }
}

/** Canvas px of screen travel per one world unit along the clip normal.
 *
 * `{sx, sy}` is that travel and `s2` its squared length; `sine` is how much of
 * the normal SURVIVES the projection, between 0 and 1 — see where it is computed
 * below. The drag reads the first three and the grip's ink is drawn at `sine`.
 *
 * null when the normal is too close to the view axis: its screen projection
 * collapses there and `px -> world` runs away to infinity, so a two-pixel twitch
 * would fling the plane across the model.
 */
export function sectionAxis(viewer, g, point) {
  let n = null;
  try {
    n = viewer.getClipNormal(SECTION_INDEX);
  } catch (error) {
    console.warn("section normal", error);
    return null;
  }
  n = Array.isArray(n) ? unit3(n) : null;
  if (!n) return null;
  const view = viewDir(g, point);
  if (!view) return null;
  if (sineFromCos(dot3(n, view)) < MIN_SINE) return null;
  const sine = foreshorten(viewer, g, n);
  const rect = g.canvas.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  // A short step rather than a whole world unit: on a perspective camera this is
  // a local linearisation, and on the ortho camera this viewport uses it is
  // exact at any length.
  const L = (sectionLimit(viewer) || 1) / 100;
  // THROUGH `projectPoint` AND NOT A HAND-ROLLED CLONE, which is where the
  // refusal of a camera that cannot be read comes from as well — it is one
  // function, and everything that projects a world point goes through it.
  const a = projectPoint(g, point);
  const b = projectPoint(g, [point[0] + n[0] * L, point[1] + n[1] * L,
                             point[2] + n[2] * L]);
  if (!a || !b) return null;
  const sx = ((b[0] - a[0]) * rect.width / 2) / L;
  const sy = (-(b[1] - a[1]) * rect.height / 2) / L;  // NDC y up, pixels down
  const s2 = sx * sx + sy * sy;
  if (!(s2 > 1e-12)) return null;
  return { sx, sy, s2, sine };
}

/** The screen axis THE GRIP is drawn along and dragged on: `sectionAxis` where
 *  that one answers, and a VERTICAL axis where it declines. Null only for a
 *  scene that cannot answer at all.
 *
 * `sine` comes back from BOTH branches and is the same measurement in both: the
 * foreshortening the grip draws its ink at, taken by `foreshorten` against the
 * camera's own projection axis. It is NOT the number this function's two
 * branches are chosen by — that one is the guard's, measured against the ray to
 * the anchor — so it does not jump where the branch changes, and the fallback's
 * is not bounded by `MIN_SINE` the way the guard's is.
 *
 * WHY THERE ARE TWO FUNCTIONS RATHER THAN A LOOSER GUARD IN ONE. `sectionAxis`
 * refuses in the degenerate zone — the plane's normal pointing nearly AT or AWAY
 * FROM the camera, which is the reader turning the model to look straight at the
 * cut face — and that refusal is right for the CANVAS drag: there the direction
 * the pointer has to be projected onto IS the projected normal, which has
 * collapsed to a stub whose angle swings with the smallest camera move, and px
 * -> world along it runs away. tools.js keeps refusing there, unchanged.
 *
 * It is the wrong answer for the HANDLE, which is a thing the reader has to be
 * able to see and take hold of: an arrow that disappears exactly when the cut
 * face is squarely in view is a control missing at the moment it is most wanted,
 * and just outside the zone it was the swinging angle itself that the reader saw.
 *
 * SO THE FALLBACK BRINGS ITS OWN DIRECTION. Vertical, at the camera's own screen
 * scale, so the grip becomes an arrow dragged up and down at a rate the reader
 * can predict — `dragSection` turns `{sx: 0, sy: px}` into `1 / px` world units
 * along the plane's normal per pixel, wherever the model is turned. Which way
 * that goes is a CONVENTION and not a projection, because there is no projection
 * left to take: DRAGGING DOWN MOVES THE PLANE ALONG ITS OWN NORMAL IN THE
 * POSITIVE DIRECTION, and section.test.js pins it.
 */
export function sectionGripAxis(viewer, g, point) {
  const axis = sectionAxis(viewer, g, point);
  if (axis) return axis;
  // Asked again, and only for WHETHER THERE IS A PLANE: `sectionAxis` declines
  // for several reasons and does not say which, and a plane whose normal the
  // library cannot hand back is a scene that cannot answer rather than a
  // degenerate view. No warning here — the read that just failed inside
  // `sectionAxis` logged this same error one call ago.
  let n = null;
  try {
    n = viewer.getClipNormal(SECTION_INDEX);
  } catch (error) {
    return null;
  }
  // `finite3(unit3(n))` and NOT a bare `unit3`, which is the same shape
  // `captureSection` and `placeSectionPlane` write and for the same reason:
  // `unit3` answers a component that is already Infinity with `[NaN, …]` — an
  // array, and therefore truthy — where a zero vector, a NaN one and a short
  // array all come back null (see its docblock in math.js). `sectionAxis` used
  // to catch that case downstream, where the projected step came back NaN and
  // `!(s2 > 1e-12)` refused it; this function never reaches that arithmetic,
  // because its own step is measured ACROSS the view and is perfectly finite. So
  // without this the grip would be drawn, and dragged, on a scene whose clip
  // plane is not a plane.
  const unit = Array.isArray(n) ? unit3(n) : null;
  if (!finite3(unit)) return null;
  // The rest of `sectionAxis`'s own guards, minus the angle: what is left is a
  // scene that cannot be measured at all.
  const view = viewDir(g, point);
  if (!view) return null;
  // THE SAME MEASUREMENT `sectionAxis` RETURNS, off the same axis, so the grip's
  // ink is drawn from one number across both branches. A constant here would be
  // wrong twice over: the length would jump where this branch is entered, and
  // it would be a lie about the plane, since which branch runs is decided by the
  // GUARD's sine — measured against the ray to the anchor — while what is drawn
  // is the projection's, measured against the camera axis. The two disagree by
  // as much as the frame is wide, so this branch does NOT imply a foreshortening
  // below `MIN_SINE`.
  const sine = foreshorten(viewer, g, unit);
  const rect = g.canvas.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  // A world direction ACROSS the view, which is the only thing this camera's
  // screen scale can honestly be measured along: the clip normal is useless here
  // — the whole reason this branch runs is that it points along the view axis
  // and projects to a stub. Crossed with the world axis the view leans on LEAST,
  // whose own component is at most 1/sqrt(3), so the product is at least 0.816
  // long before it is normalised and nothing is measured off a stub either.
  const a0 = Math.abs(view[0]);
  const a1 = Math.abs(view[1]);
  const a2 = Math.abs(view[2]);
  const world = a0 <= a1 && a0 <= a2 ? [1, 0, 0]
    : (a1 <= a2 ? [0, 1, 0] : [0, 0, 1]);
  const across = unit3(cross3(view, world));
  if (!across) return null;
  // Measured exactly as `sectionAxis` measures its own step — the same short
  // length, the same `projectPoint` — so the two cannot fall out of step about
  // what a world unit is worth in pixels. The suite pins that: the fallback's
  // scale equals the one `sectionAxis` reports for a normal across the view on
  // the same camera.
  const L = (sectionLimit(viewer) || 1) / 100;
  const a = projectPoint(g, point);
  const b = projectPoint(g, [point[0] + across[0] * L, point[1] + across[1] * L,
                             point[2] + across[2] * L]);
  if (!a || !b) return null;
  // A LENGTH and not a direction, so which way NDC y runs does not enter it.
  const px = Math.hypot((b[0] - a[0]) * rect.width / 2,
                        (b[1] - a[1]) * rect.height / 2) / L;
  if (!Number.isFinite(px) || !(px * px > 1e-12)) return null;
  return { sx: 0, sy: px, s2: px * px, sine };
}

/**
 * One pointermove of drag: move the plane and return the world distance it
 * travelled, or 0.
 *
 * Least-squares projection of the pixel delta onto the screen direction of the
 * normal: only the component along that direction moves the plane, and a drag
 * across it moves nothing.
 *
 * THE DISTANCE IS SIGNED ALONG THE NORMAL IN FORCE, which is the frame the
 * library's own slider counts in — and NOT the frame `sectionOffset` answers in.
 * A flip turns the normal in force over without moving the plane, so on a
 * flipped cut the two disagree in sign for the same physical movement. Both
 * callers on the drag path (`tools.js` and `handle.js`, in `onMove`) discard the
 * number, and what the interface is shown after a drag comes from
 * `sectionOffset` at `onUp`. A caller that starts USING it has to decide which
 * of the two frames it means; `section.test.js` asserts the value itself.
 */
export function dragSection(vp, g, axis, dx, dy) {
  const viewer = vp.viewer;
  const cap = stepCap(viewer);
  const step = clamp((dx * axis.sx + dy * axis.sy) / axis.s2, -cap, cap);
  const v = viewer.getClipSlider(SECTION_INDEX);
  if (!Number.isFinite(v)) return 0;
  // `value = -normal . (point - centre)` (see `sectionValueFor`) is affine in
  // the point with slope exactly -1 along the normal, so sliding the plane
  // `step` along its own normal is the slider MINUS `step`. A relative move
  // needs neither the centre nor the grid size, which is why a drag reads the
  // slider rather than recomputing a placement.
  //
  // Through `sliderSafe` exactly like a placement, and a drag reaches that
  // number more easily than a placement does rather than less: `sectionValue`
  // clamps to +-`sectionLimit`, so on a scene whose grid is 2 the LOWER STOP OF
  // THE TRAVEL IS EXACTLY -1 — the value the library reads as "no value given"
  // and silently ignores. Without this the plane would stop at one end of its
  // range while this function went on reporting the distance it had covered,
  // and a part 2 mm across is an ordinary thing to publish here.
  const next = sliderSafe(sectionValue(viewer, v - step));
  // As in `standSection`: the contour exists before the write that renders.
  // A drag moves the plane ALONG its normal, so the normal in force is the
  // plane's own.
  sectionOutline(vp, g, g.plane.normal, next);
  viewer.setClipSlider(SECTION_INDEX, next, true);
  return v - next;
}

/** Put the cut back after the library switched tabs away from Clip.
 *
 * The library keeps clipping alive only on its own Clip tab: the `activeTab`
 * subscription runs `Display.switchToTab`, which calls `clipping.setVisible`
 * (the stencil caps that close the cut off) and `setLocalClipping` (the renderer
 * flag that makes the planes cut at all) with `tab === "clip"`. That is
 * deliberate on their side — "only allow clipping when Clipping tab is selected"
 * is written in their init — but it means a reader who opens the tree to see
 * WHICH part they are looking into loses the cut on the way, which is the one
 * moment the cut is most wanted.
 *
 * Both flags therefore go straight back on. Both are public methods on `Viewer`,
 * and this runs from the same notification that drove `switchToTab` — the
 * library's own subscriber is called first, so this lands after it rather than
 * fighting it, and no deferral is needed.
 *
 * Only while a cut exists: `sectionSeed` is what tells a plane the reader placed
 * from the untouched defaults that sit at the far edge of the grid cutting
 * nothing.
 */
export function keepSectionCut(vp, given) {
  if (!vp.sectionSeed || !vp.viewer) return;
  const g = given || internals(vp.viewer);
  if (!g) return;
  try {
    if (g.clipping && typeof g.clipping.setVisible === "function") {
      g.clipping.setVisible(true);
    }
    vp.viewer.setLocalClipping(true);
  } catch (error) {
    console.warn("section keep", error);
  }
}

/** Take the cut away without forgetting where it was. */
export function suspendSectionCut(vp) {
  const viewer = vp.viewer;
  if (!viewer) return;
  try {
    const g = internals(viewer);
    // The contour goes with the cut — BEFORE the slider write, which renders,
    // exactly as the two build sites put the contour BEFORE theirs — and the
    // memo with the contour, so the next placement or drag rebuilds instead
    // of being suppressed by a key whose outlines no longer exist.
    clearSectionOutlines(vp, g);
    const lim = sectionLimit(viewer);
    // The far edge of the grid is where `resetClip` parks the slider and is the
    // library's own spelling of "cuts nothing". Chosen over `resetClip` because
    // it leaves the NORMAL alone, so turning the cut back on does not have to
    // re-derive an orientation the reader already chose.
    if (lim !== null) viewer.setClipSlider(SECTION_INDEX, lim, true);
    viewer.setLocalClipping(false);
    if (g && g.clipping && typeof g.clipping.setVisible === "function") {
      g.clipping.setVisible(false);
    }
  } catch (error) {
    console.warn("section suspend", error);
  }
}

/** Put the library's sidebar on one of its tabs, keeping any cut that stands.
 *
 * KEPT, despite `tools: false` hiding the tabs. The temptation is to shorten
 * this to `setLocalClipping(true)` and never touch a tab that nobody can see —
 * but the whole restore mechanism hangs off the tab-change notification, the
 * tabs are hidden by CSS only (so this still works), and whether a bare
 * `setLocalClipping` is enough for correct END CAPS is written down as NOT
 * TRACED in docs/viewer-api.md §6. Keeping a mechanism that works costs zero.
 */
function showTab(vp, name) {
  try {
    if (vp.viewer && typeof vp.viewer.setActiveTab === "function") {
      vp.viewer.setActiveTab(name);
    }
  } catch (error) {
    console.warn("section tab", error);
  }
}

/** Where the cutting plane the reader AIMED AT stands, in WORLD coordinates, or
 *  null for no cut. The render sliver is not in it — see below.
 *
 * What a live reload must NOT carry across is the SLIDER VALUE: its zero is the
 * centre of the clipping region, which is the centre of the grid, and the grid
 * is sized from the model's bounding box. Republish a model half a millimetre
 * wider and the same number names a different physical plane — the cut would
 * appear to have jumped for no reason anybody could see.
 *
 * A normal and a point do not have that problem: they are the plane itself, in
 * the model's own space, and the value that reproduces them in the new scene is
 * one subtraction away.
 *
 * MEASURED over CDP against a real hub, with a real CadQuery build republished
 * under an open page. One model, two runs, `BOX_HEIGHT` 30 -> 50:
 *
 *     grid              90       ->  120
 *     grid centre z     18       ->  28
 *     plane world z     11.9650  ->  11.9650    (carried)
 *     clip slider       -6.0350  ->  -16.0350   (recomputed)
 *
 * Carrying the NUMBER instead would have put the plane at z = 21.9650 — 10 mm of
 * silent drift, on a change that moved nothing near the cut.
 */
export function captureSection(vp) {
  const viewer = vp.viewer;
  if (!viewer) return null;
  const g = internals(viewer);
  if (!g) return null;
  let normal = null;
  try {
    normal = viewer.getClipNormal(SECTION_INDEX);
  } catch (error) {
    console.warn("section capture", error);
    return null;
  }
  // `finite3` rather than a truthiness check, and this is the FAR END of the
  // same thread `restoreSection` guards at the near end: what this returns is
  // what a live reload hands straight back in. A library holding an infinite
  // clip normal produces `[NaN, …]` here — an array, and truthy — so a bare
  // check would mint the very `keep` the other side has to defend against, and
  // the swap between them is where the evidence of where it came from is lost.
  normal = Array.isArray(normal) ? unit3(normal) : null;
  if (!finite3(normal)) return null;
  const v = viewer.getClipSlider(SECTION_INDEX);
  if (!Number.isFinite(v)) return null;
  const lim = sectionLimit(viewer);
  if (lim !== null && v >= lim) return null;   // parked at the far edge: cuts nothing
  const seed = vp.sectionSeed;
  const src = seed ? seed.point : [0, 0, 0];
  const d = g.plane.distanceToPoint(vec3(src));
  if (!Number.isFinite(d)) return null;
  // The captured normal is the one currently in force, flip included, so the
  // seed it restores into is recorded UNFLIPPED — otherwise a restore would
  // apply the flip a second time.
  const flip = !!vp.state.cutFlip;
  const base = flip ? [-normal[0], -normal[1], -normal[2]] : normal;
  // `distanceToPoint` is signed along the unit normal IN FORCE, so stepping the
  // point back by it lands it on the plane, with every drag since the seed
  // folded in.
  //
  // AND THEN THE RENDER SLIVER COMES BACK OUT, which is the difference between
  // where the plane IS and the plane the reader aimed at. It has to: the restore
  // goes through `applySection`, which puts a sliver back, so carrying this one
  // across would land the plane two slivers deep — and deeper again on the next
  // reload, since nothing ever takes them off. It is a fraction of the GRID as
  // well, so the one that belongs here is the new scene's, not this scene's.
  //
  // Along `base` and not along `normal`, because that is the direction
  // `applySection` sinks it in — the SEED normal, which a flip leaves alone. The
  // two agree until the reader flips, and then they are a sliver apart in
  // opposite directions, i.e. two slivers out on every live reload.
  const bias = sectionBias(viewer);
  const point = [src[0] - normal[0] * d - base[0] * bias,
                 src[1] - normal[1] * d - base[1] * bias,
                 src[2] - normal[2] * d - base[2] * bias];
  // AND WHETHER THE PLANE HAS BEEN TURNED OFF ITS FACE, which is not derivable
  // from anything else in here: the normal comes back verbatim, so a turned plane
  // and a plane placed on a face pointing that way are the same three numbers.
  // Lost across the swap, the next slide through `reportCut` would announce the
  // cut as `turned: false` and the interface would start labelling it with the
  // name of the face the reader has just turned it away from.
  return { normal: base, point, placed: !!seed, turned: !!(seed && seed.turned) };
}

/** Put the captured plane back on the scene that has just been rendered.
 *
 * The normal goes back with its DIRECTION verbatim — no re-orienting against the
 * camera. The one in `keep` is already the oriented one, and re-deciding which
 * half-space to keep would invert the cut for a reader who had turned the model
 * more than a quarter turn since they made it. Its LENGTH is not carried: like
 * `placeSectionPlane`, this normalises before it writes the seed.
 *
 * If the geometry changed enough that the plane now misses the part, it lands
 * outside it and cuts nothing visible. That is the honest answer: the cut is
 * plainly somewhere else and one drag brings it back, where a plane quietly
 * re-seated on a number would be wrong with nothing to show for it.
 *
 * Every failure ends in a scene with no cut on it, and none of them is allowed
 * out: this runs inside a swap, and a swap that throws takes the live update
 * down with it. A lost plane is a drag to put back; a lost live page is a reload
 * nobody knows they need.
 */
export function restoreSection(vp, keep) {
  if (!keep || !vp.viewer) return false;
  const g = internals(vp.viewer);
  if (!g) return false;
  try {
    // The reader's offset is already folded into the captured point — it is
    // where the plane was — while a SEED is the point an offset counts FROM. So
    // it comes back out here, and what follows is an ordinary apply, with
    // `state.cutOffset` standing exactly as it was.
    //
    // THE OTHER ARRANGEMENT IS THE BUG: seeding with the captured point and
    // applying at a temporary offset of zero restores the plane perfectly and
    // leaves `applySection` NOT IDEMPOTENT with the state it will next be called
    // with. `reconcile` calls it on every `hmr:state` THAT STARTS NO LOAD — a
    // click in the tree, a pin, a step of the offset slider. A view tab is not
    // one of those: it goes to `load()` and returns before `reconcile` runs at
    // all (element.js), which is why the quantifier matters here. The first
    // event that DOES reach reconcile after a restore would walk the plane the
    // reader's millimetres a second time, silently, on a scene nobody touched.
    //
    // Along the captured normal, which is the seed's own direction and is the
    // one `applySection` walks the offset with whether the cut is flipped or
    // not. It used to come off along the FLIPPED normal, to match an
    // `applySection` that walked it that way; both changed together, because a
    // flip moves no plane any more.
    const offset = Number.isFinite(vp.state.cutOffset) ? vp.state.cutOffset : 0;
    // The OTHER door, and the seed is checked whole here too — normal and point
    // both, before either is stored, for the reason `placeSectionPlane` spells
    // out. `keep` comes back from `captureSection` on the ordinary live-reload
    // path and is already finite and unit; it is nonetheless a plain object that
    // has crossed a swap, and this is the cheapest place in the module to stop
    // being sure about that.
    if (!finite3(keep.point)) return false;
    const normal = unit3(keep.normal);
    if (!finite3(normal)) return false;   // `unit3` of an infinity is NaNs
    vp.sectionSeed = {
      normal,
      point: [keep.point[0] - normal[0] * offset,
              keep.point[1] - normal[1] * offset,
              keep.point[2] - normal[2] * offset],
      value: null,
      turned: !!keep.turned,
    };
    const ok = applySection(vp, g);
    if (!keep.placed) vp.sectionSeed = null;
    return ok;
  } catch (error) {
    console.warn("section restore", error);
    return false;
  }
}

/** Distance from the seed to where the plane now is, in world units.
 *
 * The number the interface's own offset control has to show after a drag: the
 * drag moves the library's slider, and the slider counts from the grid centre
 * rather than from the face the reader clicked.
 *
 * WITHOUT THE RENDER SLIVER, and that is not cosmetic. This answer is written
 * straight into `state.cutOffset` (tools.js, `onUp`), which is the field
 * `applySection` adds a sliver to — so a readout carrying one would sink the
 * plane a sliver deeper on the reconcile that follows, and another on the next
 * drag, for as long as the reader keeps dragging. A freshly placed plane also
 * reads 0 here rather than a sliver, which is what the reader asked for.
 *
 * ALONG THE SEED NORMAL, which is the frame `state.cutOffset` counts in and the
 * one `applySection` walks the plane with. `distanceToPoint` is signed along the
 * normal IN FORCE, and a flip turns that one over without moving the plane, so
 * the sign has to come back off here — otherwise the first reconcile after a
 * drag on a flipped cut would hand `applySection` the offset's negative and the
 * plane would jump to the wrong side of the face.
 */
export function sectionOffset(vp) {
  const viewer = vp.viewer;
  const seed = vp.sectionSeed;
  if (!viewer || !seed) return 0;
  const g = internals(viewer);
  if (!g) return 0;
  const d = g.plane.distanceToPoint(vec3(seed.point));
  if (!Number.isFinite(d)) return 0;
  return (vp.state.cutFlip ? d : -d) - sectionBias(viewer);
}

/** How far the offset can usefully run, for the interface's slider. */
export function sectionRange(viewer) {
  const lim = sectionLimit(viewer);
  return lim === null ? null : [-lim, lim];
}
