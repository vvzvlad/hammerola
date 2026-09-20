// ui/src/viewport/outline.js — the dark contour of each part's cut face.
//
// The library clips fragments on the GPU, so a cut face ends at the plane as a
// bare coloured silhouette: nothing marks WHERE the solid was cut open. The
// hatch (hatch.js) fills the face; this draws its edge. For every solid the
// section plane is intersected with the solid's own triangles and the
// resulting segments are laid down as a dark line in the plane, on the
// library's fat-line stack — `LineSegments2` over a `LineSegmentsGeometry`
// under a `LineMaterial`, harvested off a live solid's edge overlay because
// the bundle exports none of the three. The fork (`viewer/`) did not change
// that: what `viewer/src/index.ts` re-exports is three's own namespace, and
// all three of these are `three/examples/jsm` addons, which are not in it.
//
// ONE outline object per solid, a child of that solid's ObjectGroup: a
// ghosted or rebuilt part carries its outline along for free. The
// intersection runs in the solid's LOCAL frame — the triangle positions are
// read exactly as stored and only the PLANE is transformed — which saves
// transforming every triangle into world coordinates. It does NOT save a
// rebuild when the part moves: the plane stands in the WORLD, so a moved part
// cuts differently through it, and the move path (`movePart`/`reconcileMoves`)
// drops the memo and calls `refreshSectionOutline` since no plane write is
// coming to rebuild for it. The memo below (on the viewport object, never at
// module scope) holds the rebuild off whenever the PLANE did not move.

import { cross3, unit3 } from "./math.js";
import { SECTION_INDEX } from "./options.js";

// The name the outline child carries inside its ObjectGroup — ours by
// CONVENTION only: `renderShape` names the library's own children from the
// payload's shape name, so nothing in the hub's alphabet keeps a part from
// being called exactly this, and `outlineChild` therefore requires the
// fat-line marker beside the name. What the library DOES reserve is the
// "clipping" prefix — `_forEachMaterial` skips children named that, and the
// name deliberately stays outside it, which is what lets ghosting reach the
// outline with everything else.
export const OUTLINE_NAME = "sectionOutline";

/** Where an outline keeps the WORLD normal of the plane it was cut by. */
const CUT_PLANE_KEY = "sectionOutlineNormal";

// THE SAME WIDTH THE LIBRARY GIVES A MODEL'S OWN EDGE, and that is the owner's
// decision of 2026-09-18: the cut has no edge of its own — measured, by hiding
// every contour in the browser, which leaves the boundary of a cut face with no
// line on it at all — so what this draws is the edge that a section opens up,
// and an edge is what it should look like. It was 2 before, which read as a
// heavier line than anything else in the picture.
//
// IN CSS PIXELS, because that is the only measure that is the same on every
// face. A width taken off the MODEL was tried twice — a tenth of the solid's
// smallest bounding-box dimension, then `2 * Area / Perimeter` of the cut face
// — and both gave the same picture: a fat black rim around a wide face and no
// line at all around a narrow one, where the width fell under a pixel.
//
// What a constant pixel width does NOT promise: pulled far enough back, a wall
// only a few pixels wide still has the contours on its two sides meet, and the
// face between them disappears. Zooming in is the answer there — which is the
// whole difference from a width on the model, where the ratio holds however
// close the reader leans in.
const OUTLINE_WIDTH = 1;
const OUTLINE_COLOR = 0x303030;

/**
 * What the fat-line shader does NOT do, and this puts back.
 *
 * A fat line is a quad widened in SCREEN space: the shader shifts `clip.xy` by
 * the half-width and leaves `clip.z` at the value the segment's endpoint had.
 * The band's depth is therefore CONSTANT ACROSS ITS WIDTH, while the cut plane
 * the band lies in recedes across it. Half of every band sits behind the plane,
 * and the depth test hands those pixels to whatever is drawn there — the cut's
 * own opaque cap on one side, the solid's faces on the other, each a hair in
 * front. What survives is the sliver that happens to land in front, which is
 * how one contour came out fat along one edge, hairline along the next and
 * absent along a third. Measured on the owner's model: widening the contour to
 * 8 px turned every gap into a continuous line of varying thickness, which is
 * the same defect with more ink.
 *
 * The correction puts the shifted corner back ON the plane. The shift is known
 * in view units, the plane's normal is known in view space, and a plane is
 * flat, so one step is exact rather than an approximation:
 *
 *     n . (d + dz) = 0   ->   dz = -(n.x * d.x + n.y * d.y) / n.z
 *
 * ORTHOGRAPHIC ONLY, which is the camera this app builds (`options.js`,
 * `ortho: true`). Under a perspective projection a corner's `clip.w` moves with
 * its depth and the correction would have to move both; rather than pretend,
 * the branch reads the projection and does nothing there.
 */
const CUT_DEPTH_GLSL = `
  if ( hmrCutNormal.w > 0.5 && projectionMatrix[2][3] == 0.0
       && abs( hmrCutNormal.z ) > 1e-3 ) {
    vec2 dView = vec2( offset.x / ( clip.w * projectionMatrix[0][0] ),
                       offset.y / ( clip.w * projectionMatrix[1][1] ) );
    float dz = -( hmrCutNormal.x * dView.x + hmrCutNormal.y * dView.y )
               / hmrCutNormal.z;
    clip.z += projectionMatrix[2][2] * dz * clip.w;
  }
`;

/** The line of the vendored fat-line shader the correction hangs off. */
const CUT_DEPTH_ANCHOR = "clip.xy += offset;";

// What a plane that misses writes: nothing, over whatever was there.
const NO_SEGMENTS = new Float32Array(0);

/** Components of a vector given as a plain array or a THREE Vector3. */
const read3 = (v) => (Array.isArray(v) ? [v[0], v[1], v[2]] : [v.x, v.y, v.z]);

/**
 * The contour child of a part's group, if it has one — found by a MARK WE PUT
 * ON IT, never by its name and never by its class.
 *
 * Neither of those two identifies it. `renderShape` names the library's own
 * children from the payload's shape name, so a part may legitimately be called
 * `sectionOutline`, and then its `front` answers a name scan with a geometry
 * `setPositions` throws on — while its EDGES answer name AND class both, being
 * a `LineSegments2` of that same name, and would quietly receive the contour
 * in place of the part's own edges. A key we write on our own object is the
 * only answer that cannot collide: nothing else in the group has it, whatever
 * the model is called. The name stays for whoever reads the scene graph.
 */
export function outlineChild(group) {
  if (!group || !Array.isArray(group.children)) return null;
  return group.children.find(
    (child) => child && child.userData && child.userData[OUTLINE_NAME] === true,
  ) || null;
}

/**
 * The fat-line constructors, taken off the first solid that carries edges.
 *
 * `group.edges` is null for every shape whose edge list came back empty, so
 * the donor is the first group that HAS one — scanned, never assumed. Null
 * when the scene offers none, in which case no outline is drawn at all.
 */
function lineClasses(g) {
  const groups = g.nestedGroup && g.nestedGroup.groups;
  if (!groups) return null;
  for (const group of Object.values(groups)) {
    const edges = group && group.edges;
    if (edges && edges.isLineSegments2 && edges.geometry
        && typeof edges.geometry.setPositions === "function" && edges.material) {
      return {
        LineSegments2: edges.constructor,
        LineSegmentsGeometry: edges.geometry.constructor,
        LineMaterial: edges.material.constructor,
        edges,
      };
    }
  }
  return null;
}

/**
 * The outline material for one solid: the library's own edge material, dark and
 * `OUTLINE_WIDTH` across.
 *
 * Cloned rather than built, so it keeps what the factory already got right —
 * the polygon offset toward the camera, no tone mapping, shader clipping on.
 * It must NOT be clipped by the plane it lies IN, so it carries what the cap
 * materials carry: only the OTHER two planes, in the library's own order.
 *
 * `resolution` matters again, now that the PIXEL branch of the fat-line shader
 * is the one in use: `linewidth` counts CSS pixels unless the material is told
 * otherwise, and that branch is where the quad's offset is divided by the
 * canvas size. Nothing here tells it otherwise. The write below is also what
 * the library's own edge materials carry and what `onBeforeRender` rewrites
 * from the viewport before every draw, so a clone that quietly dropped it would
 * be the odd one out for no gain.
 */
function outlineMaterial(classes, g) {
  const material = classes.edges.material.clone();
  material.linewidth = OUTLINE_WIDTH;
  material.color.setHex(OUTLINE_COLOR);
  material.clippingPlanes = g.clipping.clipPlanes.filter(
    (_, index) => index !== SECTION_INDEX);
  material.resolution.set(g.nestedGroup.width, g.nestedGroup.height);
  // The cut plane's normal IN VIEW SPACE, rewritten before every draw by the
  // hook `sectionOutline` installs and read by the correction above. `w` stays
  // 0 until that hook has run once, which keeps the branch off before anything
  // has been measured. A plain array rather than a `Vector4`, which the fork
  // now does put within reach (`viewer/src/index.ts` re-exports three): three's
  // uniform setter takes an array for a `vec4` exactly as it takes a vector, so
  // constructing one would buy nothing here.
  const cutNormal = { value: [0, 0, 1, 0] };
  material.userData = { ...(material.userData || {}), cutNormal };
  // NO `customProgramCacheKey` OF OUR OWN, for the reason `hatch.js` already
  // writes out for the cap patch: three's default returns
  // `onBeforeCompile.toString()`, so every contour — whose patch is spelled the
  // same — lands on ONE compiled program, and the library's own edge material,
  // whose hook is a different function, cannot land on it.
  material.onBeforeCompile = (shader) => {
    shader.uniforms.hmrCutNormal = cutNormal;
    const patched = shader.vertexShader.replace(
      CUT_DEPTH_ANCHOR, CUT_DEPTH_ANCHOR + "\n" + CUT_DEPTH_GLSL);
    if (patched === shader.vertexShader) {
      // The vendored shader moved. Say so, rather than drawing a contour that
      // is silently back to losing most of its width.
      console.warn("section outline: the fat-line shader no longer carries the"
        + " line the depth correction hangs off");
      return;
    }
    shader.vertexShader = "uniform vec4 hmrCutNormal;\n" + patched;
  };
  return material;
}

/**
 * Put the cut plane's normal into the material's uniform, in VIEW space.
 *
 * Per frame rather than per placement: the plane stands still in the world
 * while the reader orbits, and what the shader needs is the normal as the
 * CAMERA sees it. The three columns of `matrixWorld` dotted with the world
 * normal are exactly the inverse rotation applied to it, a camera's matrix
 * carrying no scale. Which way the normal points does not matter: it cancels in
 * the ratio the shader takes.
 */
function writeCutNormal(outline, camera) {
  const uniform = outline.material && outline.material.userData
    && outline.material.userData.cutNormal;
  const n = outline.userData && outline.userData[CUT_PLANE_KEY];
  if (!uniform || !n || !camera || !camera.matrixWorld) return;
  const e = camera.matrixWorld.elements;
  uniform.value[0] = e[0] * n[0] + e[1] * n[1] + e[2] * n[2];
  uniform.value[1] = e[4] * n[0] + e[5] * n[1] + e[6] * n[2];
  uniform.value[2] = e[8] * n[0] + e[9] * n[1] + e[10] * n[2];
  uniform.value[3] = 1;
}

/**
 * Put a new set of segments into an outline that already exists.
 *
 * A FRESH GEOMETRY EVERY TIME, and that is the whole of this function rather
 * than a tidiness. `setPositions` does replace the instanced buffer on the
 * geometry it is called on — and three caches HOW MANY INSTANCES IT MAY DRAW on
 * that same geometry, in `_maxInstanceCount`: `WebGLBindingStates
 * .setupVertexAttributes` (static/_v/three.module.js:1908) writes the field only
 * while it `=== undefined`, and `renderBufferDirect`
 * (static/_v/three.module.js:17116) then draws
 * `min(instanceCount, _maxInstanceCount)`. Nothing recomputes it while the
 * geometry lives — the one thing that clears it is the geometry's dispose event
 * (`delete geometry._maxInstanceCount`, static/_v/three.module.js:4254) — so an
 * outline built at one plane position and refilled at another goes on drawing
 * the number of segments it had AT BIRTH, silently, with the rest of the buffer
 * correct and never rasterised.
 *
 * Measured in the browser on the owner's own model (xmas-ball), a cut laid on
 * the outer face and then dragged in through the spherical cavity: the carrier's
 * contour held 185 segments with 48 drawn, the insert's 86 with 17 — a few
 * straight edges inked and the whole curve of the cavity missing, which is what
 * "the contour disappears in places" was. Nothing else draws there: hiding every
 * contour leaves the boundary of a cut face with no line on it at all.
 *
 * A geometry object that the renderer has never seen carries no such cache, so
 * it is drawn whole. The old one owns a GPU buffer and a vertex-array object and
 * nothing else refers to it, so it is disposed here.
 */
function writeSegments(outline, segments) {
  const previous = outline.geometry;
  const geometry = new previous.constructor();
  geometry.setPositions(segments);
  outline.geometry = geometry;
  previous.dispose();
}

/**
 * Does the local plane reach the solid's local bounding box at all? A plane
 * that misses the box misses every triangle in it, and this costs six
 * multiplies against walking the tessellation.
 */
function planeMayCut(box, n, c) {
  const mins = read3(box.min);
  const maxs = read3(box.max);
  // The signed distance at the box corner most against the plane, and at the
  // one most with it: both on the same side means the whole box is.
  let low = 0;
  let high = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    const withAxis = n[axis] >= 0;
    low += n[axis] * (withAxis ? mins[axis] : maxs[axis]);
    high += n[axis] * (withAxis ? maxs[axis] : mins[axis]);
  }
  return low + c <= 0 && high + c >= 0;
}

/**
 * Where the local plane cuts one solid's triangles, as the flat xyz xyz list
 * `setPositions` takes. A triangle is crossed where an edge's endpoints land
 * on opposite sides; its two crossings are one segment. THE SIGN TEST COUNTS
 * ZERO AS THE NEGATIVE SIDE, so a triangle with one vertex exactly ON the
 * plane and the other two on the POSITIVE side reports both edges at that
 * vertex as crossings — two of them at the same point, i.e. a ZERO-LENGTH
 * segment, not nothing (with the other two negative, no edge crosses and
 * nothing is emitted). The segment is harmless: the fat-line vertex shader
 * expands its screen-space quad along the segment's own direction, and with
 * both endpoints identical there is no direction to expand along, so the quad
 * degenerates and nothing rasterises — which is why it is left in the buffer
 * rather than special-cased out. A distance that is not finite (a degenerate
 * solid) skips the triangle, so nothing reaches the buffer as NaN.
 *
 * EACH CHORD IS DIRECTED, from the crossing where the walk LEAVES the positive
 * side to the one where it comes back — never in the order the edge walk met
 * them. That direction is a property of THIS ROUTINE, pinned by its own tests
 * and by nothing downstream: the fat line and the parity test in
 * `insideSection` do not care either way, and the one reader that did care — a
 * contour width summed off the chords as a signed area — has been withdrawn.
 *
 * WALK ORDER IS NOT THAT ORDER, and taking it for one silently halves or zeroes
 * the signed area the chords enclose — which is the quantity that reads the
 * direction back off the buffer, and it lives in the tests (`signedArea` in
 * outline.test.js) rather than in this module. The two crossings are met at
 * edges `(0,1) (1,2) (2,0)` in that sequence, and which of them comes first
 * depends on where corner 0 happens to sit relative to the plane: with
 * `d = (-, +, -)` the walk meets the entry before the exit, with `d = (+, -, +)`
 * the other way round. Both are the same mesh with the same winding, and a
 * tessellator has no reason to list a triangle from one corner rather than
 * another — measured on the payload fixture, a cylinder's lateral chords came
 * out reversed against its end caps' and the two cancelled to an area of
 * exactly zero. The SIGN the edge leaves on is what identifies an end: an edge
 * running `+` to `-` carries the chord's start, one running `-` to `+` its end.
 *
 * WHAT THAT IS FREE OF IS THE LISTING ORDER — which of its three corners a
 * triangle happens to be written from — and not the winding, which it still
 * depends on entirely: reverse a triangle to `(v0, v2, v1)` and its edges are
 * walked the other way, so the `+`-to-`-` edge becomes the `-`-to-`+` one and
 * the chord turns round. A consistently wound MESH is the one thing the
 * direction asks of the tessellation, and it is a real requirement rather than a
 * formality — the suite's own cube did not satisfy it until this was written,
 * which is why outline.test.js pins the fixture's winding beside the chords.
 *
 * With exactly two crossings there is one of each, always: signs alternate
 * around a closed walk, so an odd count of one kind is impossible.
 */
function planeThroughTriangles(positions, index, n, c) {
  const flat = [];
  const d = [0, 0, 0];
  for (let triangle = 0; triangle < index.length; triangle += 3) {
    for (let corner = 0; corner < 3; corner += 1) {
      const at = index[triangle + corner] * 3;
      d[corner] = n[0] * positions[at] + n[1] * positions[at + 1]
        + n[2] * positions[at + 2] + c;
    }
    let crossings = 0;
    let from = null;
    let to = null;
    for (let corner = 0; corner < 3; corner += 1) {
      const next = (corner + 1) % 3;
      const da = d[corner];
      const db = d[next];
      if (!Number.isFinite(da) || !Number.isFinite(db) || (da > 0) === (db > 0)) {
        continue;
      }
      // No zero-divide guard, and none is possible: the test above passed, so
      // one of the two is strictly positive and the other is not, and both are
      // finite — `da - db` is therefore strictly positive.
      const t = da / (da - db);
      const a = index[triangle + corner] * 3;
      const b = index[triangle + next] * 3;
      const point = [
        positions[a] + t * (positions[b] - positions[a]),
        positions[a + 1] + t * (positions[b + 1] - positions[a + 1]),
        positions[a + 2] + t * (positions[b + 2] - positions[a + 2]),
      ];
      crossings += 1;
      if (da > 0) from = point; else to = point;
    }
    if (crossings !== 2) continue;
    flat.push(from[0], from[1], from[2], to[0], to[1], to[2]);
  }
  return new Float32Array(flat);
}

/**
 * The world plane `normal . p + constant = 0` written in a solid's LOCAL frame,
 * as `{ n, c }`.
 *
 * With a column-major `matrixWorld` (e), p_world = R p_local + t, so
 * `n . p + c` reads `(R^T n) . p_local + (n . t + c)`: ONLY THE PLANE CROSSES
 * OVER and the triangles are read exactly as stored, which is what saves
 * transforming a whole tessellation. The local normal is not unit — the matrix
 * may scale — but every comparison downstream is a sign or a ratio, which a
 * common factor survives.
 *
 * Shared by the contour and by the containment test that answers a right-click
 * on a cut face (picking.js), because two copies of this transposition would be
 * two chances to read the matrix down a row instead of across.
 */
function localPlane(matrixWorld, nx, ny, nz, constant) {
  const e = matrixWorld.elements;
  return {
    n: [
      e[0] * nx + e[1] * ny + e[2] * nz,
      e[4] * nx + e[5] * ny + e[6] * nz,
      e[8] * nx + e[9] * ny + e[10] * nz,
    ],
    c: nx * e[12] + ny * e[13] + nz * e[14] + constant,
  };
}

/**
 * One solid's cross-section by the WORLD plane `normal . p + constant = 0`, as
 * the flat `xyz xyz` segment list `planeThroughTriangles` produces, carried into
 * WORLD coordinates. Empty when the plane misses the solid; null when the solid
 * has no tessellation to intersect at all.
 *
 * The contour draws its segments as a child of the solid's own group, so it
 * keeps them local and lets the scene graph place them. This answers a question
 * asked in the world — "is the point the cursor lands on inside this shape" —
 * and the ONLY other way to compare the two is to carry the point the other way,
 * which needs the INVERSE of `matrixWorld`. So the segments come out instead:
 * they are the boundary of one cut face, a few dozen points, against a matrix
 * inversion done per solid per click and a scale the library is free to put in
 * that matrix.
 */
export function sectionSegments(front, normal, constant) {
  const geometry = front && front.geometry;
  const position = geometry && geometry.attributes && geometry.attributes.position;
  if (!position || !geometry.index || !geometry.boundingBox
      || !front.matrixWorld || !Number.isFinite(constant)) {
    return null;
  }
  const [nx, ny, nz] = read3(normal);
  const { n, c } = localPlane(front.matrixWorld, nx, ny, nz, constant);
  // The same box pre-test the contour makes, and it saves the same walk.
  if (!planeMayCut(geometry.boundingBox, n, c)) return NO_SEGMENTS;
  const local = planeThroughTriangles(
    position.array, geometry.index.array, n, c);
  const e = front.matrixWorld.elements;
  const world = new Float32Array(local.length);
  for (let at = 0; at < local.length; at += 3) {
    const px = local[at];
    const py = local[at + 1];
    const pz = local[at + 2];
    world[at] = e[0] * px + e[4] * py + e[8] * pz + e[12];
    world[at + 1] = e[1] * px + e[5] * py + e[9] * pz + e[13];
    world[at + 2] = e[2] * px + e[6] * py + e[10] * pz + e[14];
  }
  return world;
}

/**
 * Does `point` lie inside the cross-section `segments` bounds? A CROSSING-PARITY
 * TEST, in the plane, and pure.
 *
 * The cross-section of a solid is a set of CLOSED LOOPS — the plane enters the
 * body and leaves it — so a ray cast from the point in any direction crosses the
 * boundary an odd number of times exactly when the point is inside. A hole comes
 * out right for free: its boundary is another loop, so a point in the hole
 * crosses twice and reads as outside, which is what the reader sees there.
 *
 * THE SEGMENTS DO NOT HAVE TO BE ORDERED, which is why this can eat
 * `planeThroughTriangles`' output as it stands: parity counts crossings, and a
 * crossing does not care which loop it belongs to or which way round the loop
 * runs. The zero-length segments that function can emit (a triangle with one
 * vertex exactly on the plane) are skipped by the first test below rather than
 * special-cased, both endpoints being on the same side of the ray.
 *
 * The two axes are an orthonormal in-plane basis: `u` is the world axis LEAST
 * aligned with the normal, rotated flat by a cross product so it is never
 * degenerate whatever the plane's orientation, and `v` completes it. Parity
 * would survive any invertible projection, but an orthonormal one keeps the
 * numbers the same size as the model, which is what keeps a 2 mm part and a 2 m
 * one on the same footing.
 */
export function insideSection(segments, point, normal) {
  // Two segments is the smallest closed loop, i.e. twelve numbers; anything
  // shorter bounds nothing and nothing is inside it.
  if (!segments || segments.length < 12) return false;
  const n = unit3(read3(normal));
  if (!n || !n.every(Number.isFinite)) return false;
  const dx = Math.abs(n[0]);
  const dy = Math.abs(n[1]);
  const dz = Math.abs(n[2]);
  const axis = dx <= dy && dx <= dz ? [1, 0, 0]
    : (dy <= dz ? [0, 1, 0] : [0, 0, 1]);
  const u = unit3(cross3(n, axis));
  if (!u) return false;
  const v = cross3(n, u);
  const pu = u[0] * point[0] + u[1] * point[1] + u[2] * point[2];
  const pv = v[0] * point[0] + v[1] * point[1] + v[2] * point[2];
  if (!Number.isFinite(pu) || !Number.isFinite(pv)) return false;
  let inside = false;
  for (let at = 0; at + 5 < segments.length; at += 6) {
    const au = u[0] * segments[at] + u[1] * segments[at + 1]
      + u[2] * segments[at + 2];
    const av = v[0] * segments[at] + v[1] * segments[at + 1]
      + v[2] * segments[at + 2];
    const bu = u[0] * segments[at + 3] + u[1] * segments[at + 4]
      + u[2] * segments[at + 5];
    const bv = v[0] * segments[at + 3] + v[1] * segments[at + 4]
      + v[2] * segments[at + 5];
    // The half-open rule: a segment counts when the ray's v lies in [av, bv)
    // one way round or the other. It is what keeps a ray passing exactly
    // through a shared endpoint from counting that endpoint twice — and it
    // answers a NaN coordinate by skipping the segment, since neither
    // comparison can be true. A segment that survives it has `bv !== av`, so
    // the division below cannot divide by zero.
    if ((av > pv) === (bv > pv)) continue;
    if (pu < au + ((pv - av) / (bv - av)) * (bu - au)) inside = !inside;
  }
  return inside;
}

/**
 * Rebuild every solid's outline for the plane standing at `normal` through
 * slider value `value`. The two plane-write sites in section.js call this
 * BEFORE the library's own write, because those calls end in a render the
 * outline has to exist by.
 *
 * Memoised on the plane's normal and value ON THE VIEWPORT: a drag fires this
 * several times a second, and when the plane did not move there is nothing to
 * rebuild. The memo does not cover a MOVED PART — the plane stands in the
 * world, so moving a part through it changes the cut — which is why the move
 * path calls `refreshSectionOutline` instead of trusting the key. `show()`
 * clears the memo when it swaps the scene, because the old outline objects
 * died with the groups they hung on.
 *
 * `normal` MUST BE UNIT, the same precondition `sectionValueFor` states in
 * section.js and for the same reason: the world constant below is
 * `value - normal . centre`, which is `CenteredPlane.setConstant` only when the
 * normal has length one. Give it a longer one and this draws a contour on a
 * different plane from the one the library is clipping with — silently, since
 * both are perfectly good planes. Every caller satisfies it: the seed is
 * normalised in `placeSectionPlane`, and the other two read the library's own
 * plane, which `setClipNormal` normalised.
 */
export function sectionOutline(vp, g, normal, value) {
  const [nx, ny, nz] = read3(normal);
  const key = `${nx},${ny},${nz},${value}`;
  if (vp.sectionOutlineKey === key) return;
  const classes = lineClasses(g);
  if (!classes) {
    // "No solid has edges" is about a scene that HAS solids: a scene with
    // none says nothing and stays silent.
    const groups = g.nestedGroup && g.nestedGroup.groups;
    if (groups && Object.keys(groups).length > 0) {
      console.warn("section outline: no solid carries edges to take the line classes from");
    }
    return;
  }
  // The plane in the world. The slider counts from the clipping region's
  // centre (CenteredPlane.setConstant), whose zero is not the world origin.
  const centre = read3(g.plane.center);
  const constant = value - (nx * centre[0] + ny * centre[1] + nz * centre[2]);
  for (const group of Object.values(g.nestedGroup.groups)) {
    const front = group && group.front;
    const geometry = front && front.geometry;
    const position = geometry && geometry.attributes
      && geometry.attributes.position;
    // A group with no tessellated front — or no box, which the library
    // computes at build time — has no triangles to intersect.
    if (!position || !geometry.index || !geometry.boundingBox
        || !front.matrixWorld) {
      continue;
    }
    // The plane in the solid's LOCAL frame — see `localPlane` for why it is the
    // plane that crosses over and not the triangles.
    const { n, c } = localPlane(front.matrixWorld, nx, ny, nz, constant);
    let outline = outlineChild(group);
    if (!planeMayCut(geometry.boundingBox, n, c)) {
      // The box test only saves the triangle walk — the plane still has to be
      // WRITTEN, because a solid it just left must not keep the contour cut
      // where the plane used to be. A miss with nothing to overwrite creates
      // nothing.
      if (outline) writeSegments(outline, NO_SEGMENTS);
      continue;
    }
    const segments = planeThroughTriangles(
      position.array, geometry.index.array, n, c);
    if (outline) {
      // An update, not a rebuild: the object keeps its place in the group, and
      // it keeps the material it was built with — the width does not vary with
      // the face, so a rebuild has nothing to say about it. Its GEOMETRY is
      // replaced rather than refilled, for the reason `writeSegments` gives.
      writeSegments(outline, segments);
    } else {
      // The same construction order `_renderEdges` uses: fill the geometry,
      // then hand it to the line object.
      const lineGeometry = new classes.LineSegmentsGeometry();
      lineGeometry.setPositions(segments);
      outline = new classes.LineSegments2(
        lineGeometry, outlineMaterial(classes, g));
      outline.name = OUTLINE_NAME;
      // LAST IN THE FRAME, above every face and every edge the library draws.
      //
      // Every material the library gives a SHAPE — front, back and edges — is
      // `transparent: true`, so the model itself is sorted in the transparent
      // pass by `renderOrder` first. (The cut's own cap is not: it is opaque,
      // and an opaque pass is drawn before the whole transparent one, which is
      // why the contour reads over the cap no matter what this number says.)
      // The library puts its own edges at 999 unconditionally, and a part's
      // FACES at 999 too — but only when the part is translucent. A contour
      // left at the default 0 therefore draws before every translucent face in
      // the scene, and those faces, writing no depth of their own, blend
      // straight over it: a dark line under a half-transparent lid came out
      // pale blue and under two layers of one came out as nothing at all. That
      // is what "the contour is on some faces and missing on others" was — not
      // a contour that failed to build. Measured on the owner's model: the
      // lines this recovers are exactly the ones that ran under translucent
      // parts, and the opaque latch beside them never lost its own.
      //
      // 1000 and not 999: inside one `renderOrder` bucket the order comes from
      // the depth of each object's bounding-sphere centre, which is decided per
      // solid and changes as the model turns — the same lottery in a narrower
      // room. Above the bucket there is no lottery. It is also the library's own
      // spelling of this: its highlight points carry 1000 and the comment beside
      // them reads "after faces/edges". Depth testing still holds, so an opaque
      // part in front hides the contour as it always did.
      outline.renderOrder = 1000;
      // The mark `outlineChild` finds it by. Written here and nowhere else.
      outline.userData = { ...(outline.userData || {}), [OUTLINE_NAME]: true };
      // Chained, never replaced: the library's own `onBeforeRender` is what
      // keeps `resolution` in step with the canvas, and a fat line whose
      // resolution stops moving stops being OUTLINE_WIDTH pixels wide.
      const inherited = outline.onBeforeRender;
      outline.onBeforeRender = function beforeRender(renderer, scene, camera) {
        if (typeof inherited === "function") inherited.apply(this, arguments);
        writeCutNormal(this, camera);
      };
      // BORN MATCHING ITS PART, read off the part rather than off a list. The
      // two places that carry hiding and ghosting onto an outline (parts.js)
      // reach one that already exists, and an outline can be created after
      // them: a live reload applies the hidden list inside `show()` and only
      // then restores the cut, so a hidden part would get a fresh contour
      // floating over nothing until the reader touched the list again. The
      // part's own front material is what the library's `setStates` writes, so
      // it is the state to copy — no second trigger, and no hidden list in
      // here.
      // Both answers come off that ONE material and never off `group.opacity`,
      // which `applyGhost` writes when it ghosts and never writes back — so a
      // part ghosted and un-ghosted again still reads the ghost's own
      // multiplier there rather than the part's own opacity. The face's
      // own opacity is what `setTransparent` maintains in both directions, and
      // it carries the model's own alpha too, which is the owner's decision of
      // 2026-08-31: the cut face inherits the body's transparency.
      const face = front.material;
      if (face) {
        outline.visible = face.visible !== false;
        if (typeof face.opacity === "number") outline.material.opacity = face.opacity;
      }
      group.add(outline);
    }
    // On both paths: a drag rebuilds the segments of an outline that already
    // exists, and the plane they were cut by has moved with them.
    outline.userData[CUT_PLANE_KEY] = [nx, ny, nz];
  }
  vp.sectionOutlineKey = key;
}

/**
 * Take every outline off the screen — the same empty write a plane that has
 * just left a solid makes — and drop the memo. The drop is the point: a key
 * left standing would suppress the next placement or drag at exactly the
 * moment nothing is drawn, so whatever the reader asks for next is rebuilt
 * from scratch. Called when the cut is suspended; `g` may be null (the
 * internals go with the scene), which still drops the memo.
 */
export function clearSectionOutlines(vp, g) {
  const groups = g && g.nestedGroup && g.nestedGroup.groups;
  if (groups) {
    for (const group of Object.values(groups)) {
      const outline = outlineChild(group);
      if (outline) writeSegments(outline, NO_SEGMENTS);
    }
  }
  vp.sectionOutlineKey = null;
}

/**
 * Rebuild from the plane in force, dropping the memo first. The move path:
 * moving a part carries it through the standing plane, and no plane write
 * follows that would rebuild on its own. The plane's own normal and the
 * library's slider are where `standSection` and `dragSection` left them.
 */
export function refreshSectionOutline(vp, g) {
  const viewer = vp.viewer;
  const plane = g && g.plane;
  if (!viewer || !plane || !plane.normal) return;
  const value = viewer.getClipSlider(SECTION_INDEX);
  if (!Number.isFinite(value)) return;
  vp.sectionOutlineKey = null;
  sectionOutline(vp, g, plane.normal, value);
}
