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
export const unit3 = (a) => {
  const l = len3(a);
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
