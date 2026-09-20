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
 * blows up at all. Read off static/_v/three.core.js rather than assumed:
 * `Vector3.normalize()` is `divideScalar( this.length() || 1 )`, so zero stays
 * zero (and `length()` squares too, so it would have reached zero from 1e200 on
 * its own). The clip plane is then `(0, 0, 0, w)`, and the fragment test
 * `if ( dot( vClipPosition, plane.xyz ) > plane.w ) discard;` — that one is in
 * static/_v/three.module.js, where the shader chunks live — becomes `0 > w`.
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

// -- turns, as quaternions ---------------------------------------------------
//
// THE PURE HALF OF THE TURN, AND IT LIVES HERE BECAUSE OF WHO NEEDS IT. These
// four are arithmetic and nothing else, and `ui/src/proposal.js` composes a
// gesture onto a standing pose with them — a module whose whole point is that a
// proposal can be built, edited and projected with no meshes and no browser
// anywhere near it. They used to sit in `parts.js`, which reaches the viewer
// through `internals.js` and `outline.js`, so importing them from there dragged
// the entire viewport behind a document module. `parts.js` re-exports them, so
// every caller that had them from there still does.

const DEGREES = Math.PI / 180;

/**
 * Three Euler angles in DEGREES as one quaternion, `[x, y, z, w]`.
 *
 * THE ORDER IS THE ONE A BODY'S `rot` MEANS, because the two halves of the
 * document have to mean the same thing by the same three numbers. A body is
 * turned by jscad (`placed` in proposalgeom.js → `transforms.rotate` →
 * `mat4.fromTaitBryanRotation`), which builds `Rz · Ry · Rx` — the three angles
 * applied about the FIXED axes in the order x, then y, then z, which is the same
 * rotation as the intrinsic z-y-x an aircraft's yaw-pitch-roll is named for. So
 * the quaternion is `qz ⊗ qy ⊗ qx`, in that order.
 *
 * BY HAND, because three.js is not a dependency of this bundle — the same reason
 * `partCentre` multiplies out `matrixWorld.elements` for itself.
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
 *  `1 - 1e-9` is a middle angle within about 0.0026° of square, which is far
 *  enough from `y = ±90` that `cy` still carries a dozen honest digits and
 *  close enough that nothing a hand or a document produces lands in the gap by
 *  accident. */
const LOCKED = 1 - 1e-9;

/**
 * The three Euler angles in DEGREES a quaternion stands for — `quaternionOf`
 * read backwards, and the two are a PAIR: whichever order one composes in, the
 * other has to take apart in, so they live side by side and move together.
 *
 * WHY THE INVERSE IS NEEDED AT ALL. The document stores an orientation as three
 * angles and a gesture produces a ROTATION — a ring turned by hand says "this
 * much about world x", which has to be composed onto the pose the thing is
 * already standing at. Adding the swept angle to one of the three is NOT that:
 * `quaternionOf` reads them as `Rz·Ry·Rx`, so adding to x is a turn about world
 * x only while y and z are both zero. Measured, a part standing at
 * `(0, 0, 90)` and given 30 on x by addition turns about world Y. So the
 * gesture is composed as a quaternion and the answer comes back through here.
 *
 * THE MATRIX, AND THE FIVE ENTRIES THE ANGLES ARE READ OFF. Multiplying out
 * `Rz·Ry·Rx` gives
 *
 *     [ cy·cz,  cz·sy·sx - cx·sz,  cz·sy·cx + sz·sx ]
 *     [ cy·sz,  sz·sy·sx + cz·cx,  sz·sy·cx - cz·sx ]
 *     [ -sy,    cy·sx,             cy·cx            ]
 *
 * so `sy` is `-R20` outright, and the other two are a ratio each: `x` out of
 * `(R21, R22) = cy·(sx, cx)` and `z` out of `(R10, R00) = cy·(sz, cz)`. The
 * common `cy` cancels out of both ratios, `atan2` is what makes each of them a
 * whole turn rather than half of one — and the cancelling is exactly what
 * fails when `cy` is zero.
 *
 * GIMBAL LOCK IS A CONVENTION AND NOT AN ERROR. At `y = ±90` the outer turn and
 * the inner one are about the same world axis, so only their sum (at `y = -90`)
 * or their difference (at `y = +90`) is a fact about the rotation and neither
 * angle alone is: the four entries above all go to zero and `R01`/`R02` carry
 * the pair together. THE CONVENTION TAKEN HERE IS `z = 0`, the whole of it read
 * back as `x`. It is one spelling out of infinitely many of a single
 * orientation, and it is the one that keeps a part standing square from coming
 * back as two large angles that cancel; `parts.test.js` pins it by name.
 *
 * `-0` IS SENT BACK AS `0`. `asin(-0)` and `atan2(-0, 1)` both hand one over,
 * and it survives into a document that is compared with another — `Object.is`
 * and every deep-equality check tell the two zeros apart, where `===`,
 * `String()` and `JSON.stringify` do not. So it is a difference that shows up
 * in exactly one place and means nothing anywhere else, which is the worst kind
 * to leave lying about.
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
  // CLAMPED, because a quaternion a hair off unit length — which every one that
  // has been through a few compositions is — can put the sine a hair past 1,
  // where `asin` is NaN and the whole triple goes with it.
  const sine = Math.min(1, Math.max(-1, -r20));
  return [
    plain(Math.atan2(r21, r22) * PER_RADIAN),
    plain(Math.asin(sine) * PER_RADIAN),
    plain(Math.atan2(r10, r00) * PER_RADIAN),
  ];
}

/** `a` applied AFTER `b`: the Hamilton product `a ⊗ b`, in `[x, y, z, w]`.
 *
 *  EXPORTED ALONGSIDE THE PAIR ABOVE, and for the reason they are: composing a
 *  gesture onto a standing pose is `after(quaternionOf(gesture),
 *  quaternionOf(standing))`, and the document's own door for that
 *  (`turnedFrom` in ui/src/proposal.js) is the one place that sum is written. */
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
 *  EXPORTED FOR THE SAME REASON `quaternionOf` IS: it is the pair of primitives
 *  the turn is built out of, and the composed quaternion this file writes onto a
 *  group can only be checked by asking where it sends a point. */
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
