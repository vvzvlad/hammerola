// The section plane: click a face, the cutting plane takes that face's
// orientation and lands flush on it, then it slides along its own normal to open
// the part up. The Fusion move, and ui-brief block 4.
//
// The library gives us the plane (`setClipNormal` takes an ARBITRARY normal; the
// axes in `resetClip` are only its defaults) and the movement (`setClipSlider`).
// What it does not give is the normal of a face — that is `picking.js` — and the
// frame of reference the slider counts in, which is the whole of the note below.

import { internals } from "./internals.js";
import { clamp, dot3, sub3, unit3, vec3 } from "./math.js";
import { MIN_SINE, SECTION_BIAS, SECTION_INDEX } from "./options.js";

/** Half the grid: the range the library's own clip sliders span. */
export function sectionLimit(viewer) {
  const g = viewer && viewer.gridSize;
  return Number.isFinite(g) && g > 0 ? g / 2 : null;
}

function sectionValue(viewer, v) {
  const lim = sectionLimit(viewer);
  return lim === null ? v : clamp(v, -lim, lim);
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

/** Unit direction from the camera towards `point`, or null. */
function viewDir(g, point) {
  const eye = g.camera.getPosition();
  if (!eye || !Number.isFinite(eye.x)) return null;
  return unit3(sub3(vec3(point), eye));
}

/**
 * Slide the plane along its own normal until it passes through `point`.
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
 * The consequence this code actually uses: `distanceToPoint` is affine in
 * `value` with slope exactly 1, so from ANY current value `v` the value that
 * puts the plane through P is `v - plane.distanceToPoint(P)`. That needs neither
 * the centre nor the grid size, and it stays right if the library moves its
 * origin again.
 *
 * ONE FUNCTION, spent by three callers — laying a plane on a face, moving it to
 * an offset, and putting it back after a live reload — so they cannot drift into
 * three subtly different subtractions. `back` pushes the answer further along
 * the normal (the placement bias) and is 0 when the plane has to land exactly on
 * the point. Returns the value it set, or null when the numbers came back
 * unusable, in which case nothing was written.
 */
export function slideSectionTo(viewer, g, point, back) {
  const v0 = viewer.getClipSlider(SECTION_INDEX);
  if (!Number.isFinite(v0)) return null;
  const value = sectionValue(viewer, v0 - g.plane.distanceToPoint(vec3(point)) - back);
  if (!Number.isFinite(value)) return null;
  viewer.setClipSlider(SECTION_INDEX, value, true);
  return value;
}

/**
 * Lay the plane on a face: `normal` orients it, `point` locates it. Records the
 * seed and returns true when it took.
 */
export function placeSectionPlane(vp, g, normal, point) {
  const viewer = vp.viewer;
  const view = viewDir(g, point);
  if (!view) return false;
  // three.js keeps the half-space the normal points INTO. A normal pointing away
  // from the camera therefore throws away the near side — everything between the
  // reader and the face — which is the direction a section cut opens. Taken from
  // the camera rather than from the face winding, so a model whose triangles are
  // wound inwards still cuts the way it looks like it should.
  const n = dot3(normal, view) < 0
    ? [-normal[0], -normal[1], -normal[2]] : normal;
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
  try {
    // null, not the current value: `setClipNormal` then puts the slider at its
    // documented default and the line below corrects it from a KNOWN state.
    viewer.setClipNormal(SECTION_INDEX, n, null, true);
    // The offset walks the plane along the normal it is being flipped with, so
    // "deeper" stays deeper after a flip rather than reversing under the reader.
    const at = [seed.point[0] + n[0] * offset,
                seed.point[1] + n[1] * offset,
                seed.point[2] + n[2] * offset];
    // The bias: a larger `value` holds the plane further back, so taking it away
    // slides the plane the sliver INTO the part that keeps the library's stencil
    // cap quad off the face it would otherwise z-fight with.
    const value = slideSectionTo(viewer, g, at,
                                 (sectionLimit(viewer) || 1) * SECTION_BIAS);
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
  const cos = clamp(dot3(n, view), -1, 1);
  if (Math.sqrt(1 - cos * cos) < MIN_SINE) return null;
  const rect = g.canvas.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  // A short step rather than a whole world unit: on a perspective camera this is
  // a local linearisation, and on the ortho camera this viewport uses it is
  // exact at any length.
  const L = (sectionLimit(viewer) || 1) / 100;
  const eye = g.camera.getPosition();
  if (!eye || typeof eye.clone !== "function") return null;
  const a = eye.clone().set(point[0], point[1], point[2]).project(g.cam);
  const b = eye.clone().set(point[0] + n[0] * L, point[1] + n[1] * L,
                            point[2] + n[2] * L).project(g.cam);
  const sx = ((b.x - a.x) * rect.width / 2) / L;
  const sy = (-(b.y - a.y) * rect.height / 2) / L;  // NDC y is up, pixels are down
  const s2 = sx * sx + sy * sy;
  if (!(s2 > 1e-12)) return null;
  return { sx, sy, s2 };
}

/**
 * One pointermove of drag: move the plane and return the world distance it
 * travelled, or 0.
 *
 * Least-squares projection of the pixel delta onto the screen direction of the
 * normal: only the component along that direction moves the plane, and a drag
 * across it moves nothing.
 */
export function dragSection(vp, g, axis, dx, dy) {
  const viewer = vp.viewer;
  const cap = stepCap(viewer);
  const step = clamp((dx * axis.sx + dy * axis.sy) / axis.s2, -cap, cap);
  const v = viewer.getClipSlider(SECTION_INDEX);
  if (!Number.isFinite(v)) return 0;
  // Slope of 1, from the note on `slideSectionTo`: sliding the plane `step`
  // along its own normal is the slider MINUS `step`.
  const next = sectionValue(viewer, v - step);
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
    const lim = sectionLimit(viewer);
    // The far edge of the grid is where `resetClip` parks the slider and is the
    // library's own spelling of "cuts nothing". Chosen over `resetClip` because
    // it leaves the NORMAL alone, so turning the cut back on does not have to
    // re-derive an orientation the reader already chose.
    if (lim !== null) viewer.setClipSlider(SECTION_INDEX, lim, true);
    viewer.setLocalClipping(false);
    const g = internals(viewer);
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
export function showTab(vp, name) {
  try {
    if (vp.viewer && typeof vp.viewer.setActiveTab === "function") {
      vp.viewer.setActiveTab(name);
    }
  } catch (error) {
    console.warn("section tab", error);
  }
}

/** Where the cutting plane stands, in WORLD coordinates, or null for no cut.
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
  normal = Array.isArray(normal) ? unit3(normal) : null;
  if (!normal) return null;
  const v = viewer.getClipSlider(SECTION_INDEX);
  if (!Number.isFinite(v)) return null;
  const lim = sectionLimit(viewer);
  if (lim !== null && v >= lim) return null;   // parked at the far edge: cuts nothing
  const seed = vp.sectionSeed;
  const src = seed ? seed.point : [0, 0, 0];
  const d = g.plane.distanceToPoint(vec3(src));
  if (!Number.isFinite(d)) return null;
  // `distanceToPoint` is signed along the unit normal, so stepping the point
  // back by it lands it on the plane, with every drag since the seed folded in.
  const point = [src[0] - normal[0] * d, src[1] - normal[1] * d,
                 src[2] - normal[2] * d];
  // The captured normal is the one currently in force, flip included, so the
  // seed it restores into is recorded UNFLIPPED — otherwise a restore would
  // apply the flip a second time.
  const flip = !!vp.state.cutFlip;
  const base = flip ? [-normal[0], -normal[1], -normal[2]] : normal;
  return { normal: base, point, placed: !!seed };
}

/** Put the captured plane back on the scene that has just been rendered.
 *
 * The normal goes back verbatim — no re-orienting against the camera. The one in
 * `keep` is already the oriented one, and re-deciding which half-space to keep
 * would invert the cut for a reader who had turned the model more than a quarter
 * turn since they made it.
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
    // The offset is already folded into the captured point — it is where the
    // plane REALLY was — so the seed goes back with an offset of zero relative
    // to it. Anything else would apply the reader's slider twice.
    vp.sectionSeed = { normal: keep.normal, point: keep.point, value: null };
    const offset = vp.state.cutOffset;
    vp.state.cutOffset = 0;
    const ok = applySection(vp, g);
    vp.state.cutOffset = offset;
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
 */
export function sectionOffset(vp) {
  const viewer = vp.viewer;
  const seed = vp.sectionSeed;
  if (!viewer || !seed) return 0;
  const g = internals(viewer);
  if (!g) return 0;
  const d = g.plane.distanceToPoint(vec3(seed.point));
  return Number.isFinite(d) ? -d : 0;
}

/** How far the offset can usefully run, for the interface's slider. */
export function sectionRange(viewer) {
  const lim = sectionLimit(viewer);
  return lim === null ? null : [-lim, lim];
}
