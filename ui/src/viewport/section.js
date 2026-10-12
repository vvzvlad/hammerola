// The section plane: click a face, the cutting plane takes that face's
// orientation and lands flush on it, then slides along its own normal to open
// the part up (Fusion's move).
//
// The library provides the plane (`setClipNormal` takes an arbitrary normal;
// the axes in `resetClip` are only defaults) and the movement
// (`setClipSlider`). The face normal comes from `picking.js`; the slider's frame
// of reference is described at `sectionValueFor`.

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
 * A render nudge, not a depth: it keeps the stencil cap quad from z-fighting
 * the face (options.js, `SECTION_BIAS`). Only `applySection` adds it, and every
 * reader of the plane's position subtracts it (`sectionOffset`, stored in
 * `state.cutOffset`; `captureSection`, restored after a live reload), or each
 * round trip would sink the plane another sliver.
 *
 * `|| 1` covers a scene with no grid yet, written once so reads and writes
 * agree.
 */
function sectionBias(viewer) {
  return (sectionLimit(viewer) || 1) * SECTION_BIAS;
}

/** Ceiling on one pointermove's worth of travel.
 *
 * The angle guard keeps the px -> world factor finite, not small: 9 degrees off
 * the view axis a plane still moves ~6 world units per pixel. A tenth of the
 * full travel per event is more than a hand produces.
 */
const stepCap = (viewer) => (sectionLimit(viewer) || 1) / 10;

/** Unit direction from the camera towards `point`, or null.
 *
 * Null is the only way this declines, and both callers rely on it: `unit3`
 * answers a vector with an infinity with an array of NaNs, which is truthy.
 * Unchecked, `placeSectionPlane` would write an unmeasurable seed, and
 * `sectionAxis` would compare a NaN sine against `MIN_SINE`, which is false,
 * the accepting branch of the edge-on guard. This covers a bad `point` and a
 * bad eye alike.
 */
function viewDir(g, point) {
  const eye = g.camera.getPosition();
  // `point` is checked here because this function dereferences it:
  // `vec3(null)` throws, and `placeSectionPlane` runs outside any `try`. Other
  // bad points (infinity, NaN, short array) are caught by `finite3(dir)` below.
  if (!eye || !finite3(point)) return null;
  const dir = unit3(sub3(vec3(point), eye));
  return finite3(dir) ? dir : null;
}

/**
 * How much of a unit world vector survives the projection, between 0 and 1:
 * 1 square across the view, 0 pointing down the camera's axis (for the grip's
 * arrow, the whole of it versus its end).
 *
 * Measured against the camera's own axis, not the ray to a point: under the
 * orthographic camera every point projects along one direction, so
 * foreshortening does not depend on screen position. The ray from the eye
 * (`viewDir`) swings across the frame: on a 45-degree plane it gave 0.55 on one
 * side of a part and 0.83 on the other.
 *
 * The drag guard in `sectionAxis` stays on `viewDir`: it asks whether px ->
 * world runs away under the pointer, which does move along the ray.
 *
 * Null when the camera cannot be read; the caller then draws the arrow at full
 * length, visible and grabbable.
 */
function foreshorten(viewer, g, n) {
  const basis = cameraBasis(viewer, g);
  if (!basis) return null;
  // Both are unit vectors, so the dot is the cosine; `sineFromCos` clamps it.
  return sineFromCos(dot3(n, basis.view));
}

/**
 * The slider value that stands a plane with `normal` through `point`, or null.
 * Pure: it writes nothing (see `standSection`).
 *
 * The slider's frame of reference, from the library:
 *
 *   `setClipSlider(i, value)` -> `Clipping.setConstant(i, value)` ->
 *   `CenteredPlane.setConstant(value)`, which computes
 *       constant = distanceToPoint(0) - distanceToPoint(centre) + value
 *                = value - normal . centre
 *   so with three.js's `distanceToPoint(p) = normal . p + constant` the plane
 *   sits where `normal . (p - centre) = -value`. The slider's zero is the
 *   centre of the clipping region (the grid centre), not the model origin;
 *   `resetClip` parks it at `gridSize / 2`, the far edge, where it cuts nothing.
 *
 * Inverted: `value = -normal . (point - centre)`, which needs nothing from the
 * current plane, so the normal and the slider can go into the library in one
 * call (`applySection`'s atomicity).
 *
 * `centre` (`CenteredPlane.center`) is one level deeper than what `internals()`
 * guards, so it is checked here.
 *
 * `normal` must be a unit vector: the dot product is a distance only then, and
 * `applySection` walks the same normal to build `point`, so a normal of length
 * 2 is wrong twice (a cut aimed at the face stands 4.98 world units off it on
 * the suite's scene). Nothing here normalises: it is enforced at the seed, the
 * only way a normal enters this module. `placeSectionPlane` and
 * `restoreSection`, the two writers of `vp.sectionSeed`, both run `unit3`; any
 * other writer must too. Normalising here would fix the value but leave `at`
 * wrong.
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
 * (-1 means "no value"), so a placement of exactly -1 would set the normal and
 * leave the slider parked at the far edge, cutting the whole model away. A
 * billionth off is the same plane visually.
 *
 * Every computed slider write goes through here (`standSection`,
 * `dragSection`). `suspendSectionCut` writes `sectionLimit`, which is only ever
 * positive.
 */
const sliderSafe = (v) => (v === -1 ? -1 + 1e-9 : v);

/**
 * Stand the plane at `normal` through `point`. Returns the value it set, or
 * null when the numbers came back unusable, in which case nothing was written.
 *
 * One library call: `setClipNormal` takes the value too, so the normal and the
 * slider are written together. Writing them separately could leave the plane
 * turned over and parked at the far edge, cutting the entire model away; only
 * arithmetic that writes nothing precedes the call.
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
  // The seed is checked whole before anything is written: a non-null
  // `vp.sectionSeed` tells `keepSectionCut`, `sectionOffset` and
  // `captureSection` that a cut exists, so a seed of unmeasurable numbers is
  // worse than none. Every exit here leaves nothing written.
  //
  // The point is covered by this line: `viewDir` measures from the eye to the
  // point and is total, so a point that is not a place yields no direction.
  const view = viewDir(g, point);
  if (!view) return false;
  // Normalised here, at one of the two doors a normal enters the module by
  // (see `sectionValueFor`). `faceNormalAt` returns a unit vector, but nothing
  // pins its length, and a non-unit normal puts the plane far from the face
  // silently.
  //
  // `finite3` rather than a null check: `unit3` returns `[NaN, …]` for an
  // infinite component. Over- and underflow are answered by `unit3` itself,
  // which scales by the largest component (see math.js).
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
  // A flip turns the plane over and moves nothing: it changes which half-space
  // is kept, like Fusion's `Flip`. So the offset counts along the seed normal
  // (the face's own direction), never the flipped one; walking it along the
  // flipped normal would move the plane outside the part as the kept side turns
  // over, leaving an empty canvas.
  //
  // At offset zero the plane lies on the clicked face, so flipping keeps the
  // empty side and there is honestly nothing to draw.
  const depth = offset + sectionBias(viewer);
  // The bias is added here, along the seed normal, and nowhere else (see
  // `sectionBias`): it sinks the plane a sliver into the part, off the face.
  const at = [seed.point[0] + seed.normal[0] * depth,
              seed.point[1] + seed.normal[1] * depth,
              seed.point[2] + seed.normal[2] * depth];
  try {
    const value = standSection(vp, g, n, at);
    if (value === null) return false;
    seed.value = value;
    // A plane placed while another tab is open would be invisible. The tab
    // goes first because switching into it turns local clipping and the
    // stencil caps on through the library's own path; `keepSectionCut` then
    // makes the result independent of whether that path ran.
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
 * the normal survives the projection, between 0 and 1 (`foreshorten`). The drag
 * reads the first three and the grip's ink is drawn at `sine`.
 *
 * null when the normal is too close to the view axis: its projection collapses
 * and px -> world runs away, so a two-pixel twitch would fling the plane.
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
  // A short step: a local linearisation on a perspective camera, exact at any
  // length on the ortho camera used here.
  const L = (sectionLimit(viewer) || 1) / 100;
  // Through `projectPoint`, which also refuses a camera that cannot be read.
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

/** The screen axis the grip is drawn along and dragged on: `sectionAxis` where
 *  that answers, and a vertical axis where it declines. Null only for a scene
 *  that cannot answer at all.
 *
 * `sine` comes from `foreshorten` on both branches, against the camera's
 * projection axis. The branch is chosen by the guard's sine (against the ray
 * to the anchor), so `sine` does not jump at the switch, and the fallback's is
 * not bounded by `MIN_SINE`.
 *
 * Two functions rather than a looser guard: `sectionAxis` refuses when the
 * plane's normal points nearly at or away from the camera, which is right for
 * the canvas drag (the projected normal collapses to a stub whose angle swings
 * and px -> world runs away; tools.js keeps refusing there). For the handle it
 * is wrong: the arrow would vanish exactly when the cut face is squarely in
 * view.
 *
 * So the fallback uses a vertical axis at the camera's screen scale:
 * `dragSection` turns `{sx: 0, sy: px}` into `1 / px` world units along the
 * normal per pixel. The direction is a convention, since nothing is left to
 * project: dragging down moves the plane along its normal in the positive
 * direction (section.test.js pins it).
 */
export function sectionGripAxis(viewer, g, point) {
  const axis = sectionAxis(viewer, g, point);
  if (axis) return axis;
  // Asked again only for whether there is a plane: `sectionAxis` does not say
  // why it declined, and an unreadable normal means the scene cannot answer.
  // No warning: `sectionAxis` already logged the same failure.
  let n = null;
  try {
    n = viewer.getClipNormal(SECTION_INDEX);
  } catch (error) {
    return null;
  }
  // `finite3(unit3(n))`, not a bare `unit3`: an infinite component yields
  // `[NaN, …]`, a truthy array (see math.js). `sectionAxis` would catch it
  // later via `!(s2 > 1e-12)`, but this branch measures across the view, which
  // stays finite, so without this the grip would be drawn on a non-plane.
  const unit = Array.isArray(n) ? unit3(n) : null;
  if (!finite3(unit)) return null;
  // The rest of `sectionAxis`'s guards, minus the angle.
  const view = viewDir(g, point);
  if (!view) return null;
  // The same measurement `sectionAxis` returns, so the grip's ink comes from
  // one number on both branches. This branch does not imply a foreshortening
  // below `MIN_SINE`: the branch is chosen by the guard's sine against the ray
  // to the anchor, which can differ by as much as the frame is wide.
  const sine = foreshorten(viewer, g, unit);
  const rect = g.canvas.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  // A world direction across the view, the only thing the screen scale can be
  // measured along here (the clip normal projects to a stub). Crossing the view
  // with the world axis it leans on least (component at most 1/sqrt(3)) gives a
  // product at least 0.816 long before normalising.
  const a0 = Math.abs(view[0]);
  const a1 = Math.abs(view[1]);
  const a2 = Math.abs(view[2]);
  const world = a0 <= a1 && a0 <= a2 ? [1, 0, 0]
    : (a1 <= a2 ? [0, 1, 0] : [0, 0, 1]);
  const across = unit3(cross3(view, world));
  if (!across) return null;
  // Measured exactly like `sectionAxis`'s step (same length, same
  // `projectPoint`), so both agree on pixels per world unit; the suite pins
  // that.
  const L = (sectionLimit(viewer) || 1) / 100;
  const a = projectPoint(g, point);
  const b = projectPoint(g, [point[0] + across[0] * L, point[1] + across[1] * L,
                             point[2] + across[2] * L]);
  if (!a || !b) return null;
  // A length, not a direction, so the sign of NDC y does not enter it.
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
 * normal: only the component along that direction moves the plane.
 *
 * The distance is signed along the normal in force (the library slider's
 * frame), not `sectionOffset`'s frame; on a flipped cut the signs differ. The
 * drag callers (`onMove` in `tools.js` and `handle.js`) discard it, and the
 * interface reads `sectionOffset` at `onUp`. `section.test.js` asserts the
 * value.
 */
export function dragSection(vp, g, axis, dx, dy) {
  const viewer = vp.viewer;
  const cap = stepCap(viewer);
  const step = clamp((dx * axis.sx + dy * axis.sy) / axis.s2, -cap, cap);
  const v = viewer.getClipSlider(SECTION_INDEX);
  if (!Number.isFinite(v)) return 0;
  // `value = -normal . (point - centre)` (see `sectionValueFor`) has slope -1
  // along the normal, so sliding `step` along it is the slider minus `step`; a
  // relative move needs neither centre nor grid size.
  //
  // Through `sliderSafe`, like a placement: `sectionValue` clamps to
  // +-`sectionLimit`, so on a scene with grid 2 the lower stop is exactly -1,
  // which the library ignores as "no value". A 2 mm part is ordinary here.
  const next = sliderSafe(sectionValue(viewer, v - step));
  // As in `standSection`: the contour exists before the write that renders.
  // A drag moves the plane along its own normal, so that normal is in force.
  sectionOutline(vp, g, g.plane.normal, next);
  viewer.setClipSlider(SECTION_INDEX, next, true);
  return v - next;
}

/** Put the cut back after the library switched tabs away from Clip.
 *
 * The library keeps clipping alive only on its Clip tab: the `activeTab`
 * subscription runs `Display.switchToTab`, which calls `clipping.setVisible`
 * (the stencil caps) and `setLocalClipping` (the renderer flag) with
 * `tab === "clip"`. A reader opening the tree to see which part they are
 * looking into would lose the cut.
 *
 * Both flags go straight back on, through public `Viewer` methods. This runs
 * from the same notification as `switchToTab`, after the library's own
 * subscriber, so no deferral is needed.
 *
 * Only while a cut exists: `sectionSeed` distinguishes a placed plane from the
 * defaults parked at the far edge.
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
    // The contour goes with the cut, before the slider write that renders (as
    // at the two build sites), and the memo with it, so the next placement or
    // drag rebuilds.
    clearSectionOutlines(vp, g);
    const lim = sectionLimit(viewer);
    // The far edge is where `resetClip` parks the slider ("cuts nothing").
    // Not `resetClip` itself, which would discard the normal the reader chose.
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
 * Kept although `tools: false` hides the tabs: the restore mechanism hangs off
 * the tab-change notification, the tabs are hidden by CSS only, and whether a
 * bare `setLocalClipping` gives correct end caps is not traced
 * (docs/viewer-api.md §6).
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

/** Where the plane the reader aimed at stands, in world coordinates, or null
 *  for no cut. The render sliver is excluded.
 *
 * A live reload must not carry the slider value: its zero is the grid centre,
 * and the grid is sized from the model's bounding box, so a slightly wider
 * republished model would move the cut. A normal and a point are the plane
 * itself in model space.
 *
 * Measured over CDP against a real hub, a CadQuery build republished under an
 * open page, `BOX_HEIGHT` 30 -> 50:
 *
 *     grid              90       ->  120
 *     grid centre z     18       ->  28
 *     plane world z     11.9650  ->  11.9650    (carried)
 *     clip slider       -6.0350  ->  -16.0350   (recomputed)
 *
 * Carrying the slider value would have put the plane at z = 21.9650.
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
  // `finite3` rather than truthiness: an infinite clip normal gives `[NaN, …]`
  // (truthy), and this return is what a live reload hands to `restoreSection`.
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
  // The captured normal is the one in force, flip included, so the seed is
  // recorded unflipped; otherwise a restore would flip twice.
  const flip = !!vp.state.cutFlip;
  const base = flip ? [-normal[0], -normal[1], -normal[2]] : normal;
  // `distanceToPoint` is signed along the unit normal in force, so stepping the
  // point back by it lands on the plane, with every drag since the seed folded
  // in.
  //
  // Then the render sliver comes out: the restore goes through `applySection`,
  // which adds one (sized from the new scene's grid), so keeping it would sink
  // the plane deeper on every reload. Along `base`, the seed normal
  // `applySection` sinks it along, which a flip does not change.
  const bias = sectionBias(viewer);
  const point = [src[0] - normal[0] * d - base[0] * bias,
                 src[1] - normal[1] * d - base[1] * bias,
                 src[2] - normal[2] * d - base[2] * bias];
  // Whether the plane was turned off its face cannot be derived from the
  // normal, so it is carried; otherwise the next `reportCut` would announce
  // `turned: false` and label the cut with the face it was turned away from.
  return { normal: base, point, placed: !!seed, turned: !!(seed && seed.turned) };
}

/** Put the captured plane back on the scene that has just been rendered.
 *
 * The normal's direction goes back verbatim, not re-oriented against the
 * camera: it is already oriented, and re-deciding the kept half-space would
 * invert the cut for a reader who has turned the model since. Its length is
 * normalised before the seed is written, as in `placeSectionPlane`.
 *
 * If the geometry changed so the plane misses the part, it cuts nothing
 * visible: the cut is plainly elsewhere and one drag brings it back.
 *
 * No failure escapes: this runs inside a swap, and a throwing swap takes the
 * live update down. Every failure ends in a scene with no cut.
 */
export function restoreSection(vp, keep) {
  if (!keep || !vp.viewer) return false;
  const g = internals(vp.viewer);
  if (!g) return false;
  try {
    // The reader's offset is folded into the captured point, while a seed is
    // the point an offset counts from, so it is taken back out here and
    // `state.cutOffset` stays as it was. Seeding with the captured point at
    // offset zero would make `applySection` non-idempotent with the next state:
    // `reconcile` calls it on every `hmr:state` that starts no load (a tree
    // click, a pin, an offset step; a view tab goes to `load()` first, see
    // element.js), and the first such event would walk the plane the offset a
    // second time. Along the captured normal, the seed's own direction, which
    // `applySection` walks the offset along whether flipped or not.
    const offset = Number.isFinite(vp.state.cutOffset) ? vp.state.cutOffset : 0;
    // The other door for a seed, checked whole before storing (see
    // `placeSectionPlane`). `keep` from `captureSection` is already finite and
    // unit, but it is a plain object that crossed a swap.
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
 * What the interface's offset control shows after a drag: the drag moves the
 * slider, which counts from the grid centre rather than from the clicked face.
 *
 * Without the render sliver: this is written into `state.cutOffset` (tools.js,
 * `onUp`), to which `applySection` adds a sliver, so including it would sink
 * the plane deeper on every reconcile. A freshly placed plane reads 0.
 *
 * Along the seed normal, the frame of `state.cutOffset`. `distanceToPoint` is
 * signed along the normal in force, which a flip turns over without moving the
 * plane, so the sign is corrected here; otherwise a reconcile after a drag on a
 * flipped cut would put the plane on the wrong side of the face.
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
