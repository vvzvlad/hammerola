// Small vector helpers, on plain arrays.
//
// Ported verbatim from the page viewer this interface replaced, and plain
// arrays for the reason that viewer had: the vendored bundle exports `Viewer`
// and `Display` and nothing else — no `Vector3`, no `Matrix4` — and shipping a
// second copy of three.js to subtract two points is not a trade worth making.

export const sub3 = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len3 = (a) => Math.sqrt(dot3(a, a));
export const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1],
                                 a[2] * b[0] - a[0] * b[2],
                                 a[0] * b[1] - a[1] * b[0]];

/**
 * The direction of `a`, or null when it has none.
 *
 * `Math.hypot` AND NOT `len3`, and the two are deliberately different functions
 * rather than one — this is the only place in this file where the difference
 * shows, and it is a correctness difference, not a taste one. `len3` squares
 * every component first, so it overflows to Infinity at a component around
 * 1.34e154 and underflows to 0 below about 1.5e-162, and dividing by either
 * ANSWER IS WORSE THAN NO ANSWER:
 *
 *   [1e200, 0, 0]   len3 Infinity -> [0, 0, 0]   a FINITE vector of zero length
 *   [1e-200, 0, 0]  len3 0        -> null        a direction, refused
 *
 * The first is the dangerous one and it is why this changed, but NOT for the
 * reason it looks like: `finite3` waves it through — every component is a
 * number — and it reaches the library as a normal of length zero, where nothing
 * blows up at all. Read off the vendored bundle rather than assumed:
 * `Vector3.normalize()` is `divideScalar( this.length() || 1 )`, so zero stays
 * zero (and `length()` squares too, so it would have reached zero from 1e200 on
 * its own). The clip plane is then `(0, 0, 0, w)`, and the fragment test
 * `if ( dot( vClipPosition, plane.xyz ) > plane.w ) discard;` becomes `0 > w`.
 * `w` is itself zero here — it is `value - normal . centre`, and with a zero
 * normal both terms vanish — so the test is `0 > 0`, which is FALSE. Nothing is
 * discarded, the model stays whole on screen, and the cut the reader asked for
 * simply does not happen. No error, no NaN, nothing to see. That silence is the
 * reason this is fixed here rather than guarded against downstream.
 *
 * `Math.hypot` scales by the largest component instead, so both rows above come
 * back as `[1, 0, 0]`: not merely refused, but ANSWERED, which is what a caller
 * asked for.
 *
 * ONE LIMIT, stated because the callers' preconditions lean on this: hypot is
 * exact enough to call the result a unit vector for every input whose components
 * are NORMAL numbers, which is every input this code can receive — a coordinate
 * below 2.2e-308 is not something a picker, a camera or a bounding box produces.
 * On SUBNORMALS it loses the precision to be one: `[5e-324, 5e-324, 0]` comes
 * back as `[1, 1, 0]`, which `finite3` accepts and whose length is √2. Left
 * alone deliberately — a guard against an unreachable input is a guard nothing
 * can test honestly — but it is why `math.test.js` pins the behaviour.
 *
 * What it still cannot answer is a component that is already Infinity or NaN —
 * there is no direction there to find — and those come back as `[NaN, …]` and
 * null respectively. A caller storing the result must therefore still check
 * `finite3`; section.js does, at both of the places it writes a seed.
 *
 * `len3` is left exactly as it was ON PURPOSE. Its one other caller is
 * picking.js, where it appears only inside `len3(n) / (len3(a) * len3(b))` — a
 * RATIO, scale-free by construction, whose whole job is to reject a nearly
 * collinear pair of samples. Overflow there produces `Infinity / Infinity`, i.e.
 * NaN, i.e. a comparison that fails and a sample that is skipped, which is the
 * right outcome; swapping in a slower, more careful magnitude would buy nothing
 * and would change a hot double loop.
 */
export const unit3 = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const finite3 = (a) => Array.isArray(a) && a.length === 3
  && a.every(Number.isFinite);

/**
 * A world point as a `{x, y, z}` object.
 *
 * Good enough for every library call this code makes with one, and that is not
 * an assumption but a reading: `Plane.distanceToPoint(p)` is
 * `this.normal.dot(p) + this.constant`, and `Vector3.dot` touches nothing but
 * `.x`, `.y` and `.z`. The one place a REAL `Vector3` is needed is `unproject`,
 * which is a method rather than a reader — there the code borrows an instance
 * the library already handed it (see `camera.js`).
 */
export const vec3 = (a) => ({ x: a[0], y: a[1], z: a[2] });
