// Small vector helpers, on plain arrays: three.js is not a dependency of this
// bundle (it is loaded at runtime, see library.js), and a second copy is not
// worth shipping to subtract two points.

export const sub3 = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len3 = (a) => Math.sqrt(dot3(a, a));
export const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1],
                                 a[2] * b[0] - a[0] * b[2],
                                 a[0] * b[1] - a[1] * b[0]];

/**
 * The direction of `a`, or null when it has none.
 *
 * `Math.hypot`, not `len3`: `len3` squares each component, so it overflows to
 * Infinity around 1.34e154 and underflows to 0 below about 1.5e-162:
 *
 *   [1e200, 0, 0]   len3 Infinity -> [0, 0, 0]   a finite vector of zero length
 *   [1e-200, 0, 0]  len3 0        -> null        a direction, refused
 *
 * The first is dangerous because it is silent: `finite3` accepts it, three's
 * `Vector3.normalize()` (`divideScalar(this.length() || 1)`) keeps it zero, the
 * clip plane becomes `(0, 0, 0, 0)`, and the shader test
 * `dot(vClipPosition, plane.xyz) > plane.w` is `0 > 0`, false: nothing is
 * discarded and the requested cut silently does not happen. `Math.hypot`
 * scales by the largest component, so both rows return `[1, 0, 0]`.
 *
 * Limit: the result is a unit vector for normal-number components, which is all
 * a picker, camera or bounding box produces. On subnormals it is not
 * (`[5e-324, 5e-324, 0]` gives `[1, 1, 0]`); `math.test.js` pins that.
 *
 * An Infinity or NaN component gives `[NaN, …]` or null, so a caller storing
 * the result must still check `finite3` (section.js does, where it writes a
 * seed).
 *
 * `len3`'s other caller, picking.js, uses it only in a scale-free ratio
 * `len3(n) / (len3(a) * len3(b))` where overflow yields NaN and the sample is
 * skipped, which is correct; it stays cheap in that hot loop.
 */
export const unit3 = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const finite3 = (a) => Array.isArray(a) && a.length === 3
  && a.every(Number.isFinite);

/**
 * The sine of the angle whose cosine is `cos`, between 0 and 1: how much of a
 * unit vector survives a projection along the direction `cos` was measured
 * against.
 *
 * Shared by the section grip's arrow (`foreshorten` in section.js), the guard on
 * the plane's drag (`sectionAxis`), and the axis arrows' slant in gizmo.js
 * (`place` and `onDown`), so the clamp is written once.
 *
 * The clamp is needed because the input is a dot of nearly-unit vectors and can
 * land a hair outside [-1, 1], making the root NaN; a NaN fails every
 * comparison, which in `sectionAxis` would accept an edge-on plane.
 *
 * A NaN input stays NaN (`min`/`max` propagate it); callers that refuse an
 * unreadable camera check that themselves (`viewDir` in section.js).
 */
export const sineFromCos = (cos) => {
  const c = clamp(cos, -1, 1);
  return Math.sqrt(1 - c * c);
};

/**
 * A world point as a `{x, y, z}` object.
 *
 * Enough for every library call made with one: `Plane.distanceToPoint(p)` is
 * `this.normal.dot(p) + this.constant`, and `Vector3.dot` reads only `.x`, `.y`,
 * `.z`. `unproject` needs a real `Vector3`, so there the code borrows an
 * instance from the library (see `camera.js`).
 */
export const vec3 = (a) => ({ x: a[0], y: a[1], z: a[2] });

// -- turns, as quaternions ---------------------------------------------------
//
// Pure arithmetic. `ui/src/proposal.js` composes gestures with these and must
// work with no meshes and no browser, so they live here rather than in
// `parts.js` (which reaches the viewer through `internals.js` and `outline.js`).
// `parts.js` re-exports them.

const DEGREES = Math.PI / 180;

/**
 * Three Euler angles in DEGREES as one quaternion, `[x, y, z, w]`.
 *
 * The order is what a body's `rot` means to jscad (`placed` in proposalgeom.js
 * → `transforms.rotate` → `mat4.fromTaitBryanRotation`), which builds
 * `Rz · Ry · Rx`: rotations about the fixed axes x, then y, then z. So the
 * quaternion is `qz ⊗ qy ⊗ qx`.
 *
 * By hand, because three.js is not a dependency of this bundle (same reason
 * `partCentre` multiplies out `matrixWorld.elements` itself).
 */
export function quaternionOf(turn) {
  const half = turn.map((angle) => (angle * DEGREES) / 2);
  const [cx, cy, cz] = half.map(Math.cos);
  const [sx, sy, sz] = half.map(Math.sin);
  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
}

/** How many degrees one radian is — `DEGREES` read the other way, for the
 *  decomposition below. */
const PER_RADIAN = 180 / Math.PI;

/** Where `cy` is too small for the two ratios in `anglesOf` to mean anything.
 *
 *  `1 - 1e-9` is within about 0.0026° of `y = ±90`: `cy` still has a dozen good
 *  digits, and nothing a hand or a document produces lands in the gap. */
const LOCKED = 1 - 1e-9;

/**
 * The three Euler angles in DEGREES a quaternion stands for — `quaternionOf`
 * inverted; the two must use the same order.
 *
 * Needed because the document stores three angles while a gesture produces a
 * rotation about a world axis, which must be composed onto the current pose.
 * Adding the swept angle to one of the three is not that: with `Rz·Ry·Rx`,
 * adding to x turns about world x only while y and z are zero (a part at
 * `(0, 0, 90)` given 30 on x by addition turns about world Y).
 *
 * `Rz·Ry·Rx` multiplied out:
 *
 *     [ cy·cz,  cz·sy·sx - cx·sz,  cz·sy·cx + sz·sx ]
 *     [ cy·sz,  sz·sy·sx + cz·cx,  sz·sy·cx - cz·sx ]
 *     [ -sy,    cy·sx,             cy·cx            ]
 *
 * so `sy` is `-R20`, `x` comes from `(R21, R22) = cy·(sx, cx)` and `z` from
 * `(R10, R00) = cy·(sz, cz)`. `cy` cancels in each `atan2`, which fails when
 * `cy` is zero.
 *
 * Gimbal lock at `y = ±90`: the outer and inner turns share a world axis, so
 * only their sum (y = -90) or difference (y = +90) is defined, carried by
 * `R01`/`R02`. The convention here is `z = 0` with all of it read back as `x`,
 * so a part standing square does not come back as two large cancelling angles;
 * `parts.test.js` pins it.
 *
 * `-0` is returned as `0`: `asin(-0)` and `atan2(-0, 1)` produce it, and
 * `Object.is` and deep-equality checks on documents tell the two zeros apart.
 */
export function anglesOf(q) {
  const [x, y, z, w] = q;
  const r00 = 1 - 2 * (y * y + z * z);
  const r01 = 2 * (x * y - z * w);
  const r02 = 2 * (x * z + y * w);
  const r10 = 2 * (x * y + z * w);
  const r20 = 2 * (x * z - y * w);
  const r21 = 2 * (y * z + x * w);
  const r22 = 1 - 2 * (x * x + y * y);
  const plain = (angle) => (angle === 0 ? 0 : angle);
  if (Math.abs(r20) >= LOCKED) {
    // `R01` and `R02` are `(sin, cos)` of `x - z` at `y = +90` and of
    // `-(x + z)` at `y = -90`; with `z` taken as nothing, that is `x`.
    const locked = r20 < 0 ? Math.atan2(r01, r02) : Math.atan2(-r01, -r02);
    return [plain(locked * PER_RADIAN), r20 < 0 ? 90 : -90, 0];
  }
  // Clamped: a quaternion slightly off unit length (after a few compositions)
  // can put the sine slightly past 1, where `asin` is NaN.
  const sine = Math.min(1, Math.max(-1, -r20));
  return [
    plain(Math.atan2(r21, r22) * PER_RADIAN),
    plain(Math.asin(sine) * PER_RADIAN),
    plain(Math.atan2(r10, r00) * PER_RADIAN),
  ];
}

/** `a` applied AFTER `b`: the Hamilton product `a ⊗ b`, in `[x, y, z, w]`.
 *
 *  Composing a gesture onto a standing pose is
 *  `after(quaternionOf(gesture), quaternionOf(standing))`, written in one place:
 *  `turnedFrom` in ui/src/proposal.js. */
export function after(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** The vector `v` turned by `q` — `v + 2q_w(q_v × v) + 2q_v × (q_v × v)`.
 *
 *  Exported so a composed quaternion can be checked by where it sends a point. */
export function turned(q, v) {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + qy * tz - qz * ty,
    v[1] + qw * ty + qz * tx - qx * tz,
    v[2] + qw * tz + qx * ty - qy * tx,
  ];
}
