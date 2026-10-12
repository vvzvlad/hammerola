// ui/src/viewport/outline.js — the dark contour of each part's cut face.
//
// The library clips fragments on the GPU, so nothing marks where a solid was
// cut open. The hatch (hatch.js) fills the face; this draws its edge. For every
// solid the section plane is intersected with its triangles and the segments
// are drawn as a dark line on the library's fat-line stack (`LineSegments2`,
// `LineSegmentsGeometry`, `LineMaterial`). Those are `three/examples/jsm`
// addons that neither the bundle nor the fork's re-exported three namespace
// provide, so they are harvested off a live solid's edge overlay.
//
// One outline per solid, a child of its ObjectGroup, so ghosting and rebuilds
// carry it along. The intersection runs in the solid's local frame (only the
// plane is transformed). The plane stands in the world, so moving a part
// changes its cut: the move path (`movePart`/`reconcileMoves`) calls
// `refreshSectionOutline`. The memo (on the viewport object, never at module
// scope) skips the rebuild while the plane has not moved.

import { cross3, unit3 } from "./math.js";
import { SECTION_INDEX } from "./options.js";

// The name the outline child carries inside its ObjectGroup, by convention
// only: `renderShape` names the library's children from the payload's shape
// names, so a part may be called this too, and `outlineChild` therefore looks
// for the userData mark instead. The library reserves the "clipping" prefix
// (`_forEachMaterial` skips it); this name stays outside it so ghosting reaches
// the outline.
export const OUTLINE_NAME = "sectionOutline";

/** Where an outline keeps the WORLD normal of the plane it was cut by. */
const CUT_PLANE_KEY = "sectionOutlineNormal";

// The same width the library gives a model's own edge: the cut opens up an
// edge (the cut face has no boundary line of its own), so it should look like
// one.
//
// In CSS pixels, the only measure that is the same on every face. A width
// derived from the model gives a fat rim around wide faces and no line around
// narrow ones. Pulled far enough back, a thin wall's two contours still merge;
// zooming in is the answer.
const OUTLINE_WIDTH = 1;
const OUTLINE_COLOR = 0x303030;

/**
 * What the fat-line shader does not do, and this puts back.
 *
 * A fat line is a quad widened in screen space: the shader shifts `clip.xy` by
 * the half-width and leaves `clip.z` at the endpoint's value, so the band's
 * depth is constant across its width while the cut plane recedes across it.
 * Half of every band sits behind the plane and loses the depth test to the cap
 * or the solid's faces, so the contour comes out fat on one edge, hairline on
 * the next and absent on a third.
 *
 * The correction puts the shifted corner back on the plane. The shift is known
 * in view units and the plane's normal in view space, and a plane is flat, so
 * one step is exact:
 *
 *     n . (d + dz) = 0   ->   dz = -(n.x * d.x + n.y * d.y) / n.z
 *
 * Orthographic only (`options.js`, `ortho: true`). Under perspective a corner's
 * `clip.w` moves with its depth, so the branch checks the projection and does
 * nothing there.
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
 * The contour child of a part's group, if it has one, found by a mark we put
 * on it, never by its name or class.
 *
 * A part may legitimately be named `sectionOutline` (`renderShape` names
 * children from the payload): its `front` would match a name scan with a
 * geometry `setPositions` throws on, and its edges, a `LineSegments2` of that
 * name, would match name and class and receive the contour. A key on our own
 * object cannot collide. The name stays for whoever reads the scene graph.
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
 * Cloned, so it keeps the polygon offset toward the camera, no tone mapping and
 * shader clipping. It must not be clipped by the plane it lies in, so like the
 * cap materials it carries only the other two planes, in the library's order.
 *
 * `resolution` is needed: `linewidth` counts CSS pixels, and the pixel branch
 * of the fat-line shader divides the offset by the canvas size. The library's
 * `onBeforeRender` rewrites it before every draw.
 */
function outlineMaterial(classes, g) {
  const material = classes.edges.material.clone();
  material.linewidth = OUTLINE_WIDTH;
  material.color.setHex(OUTLINE_COLOR);
  material.clippingPlanes = g.clipping.clipPlanes.filter(
    (_, index) => index !== SECTION_INDEX);
  material.resolution.set(g.nestedGroup.width, g.nestedGroup.height);
  // The cut plane's normal in view space, rewritten before every draw by the
  // hook `sectionOutline` installs and read by the correction above. `w` stays
  // 0 until that hook has run, keeping the branch off. A plain array: three's
  // uniform setter takes one for a `vec4`.
  const cutNormal = { value: [0, 0, 1, 0] };
  material.userData = { ...(material.userData || {}), cutNormal };
  // No `customProgramCacheKey` of our own (see `hatch.js`): three's default is
  // `onBeforeCompile.toString()`, so every contour shares one compiled program
  // and the library's own edge material cannot land on it.
  material.onBeforeCompile = (shader) => {
    shader.uniforms.hmrCutNormal = cutNormal;
    const patched = shader.vertexShader.replace(
      CUT_DEPTH_ANCHOR, CUT_DEPTH_ANCHOR + "\n" + CUT_DEPTH_GLSL);
    if (patched === shader.vertexShader) {
      // The vendored shader moved. Say so, rather than drawing a contour that
      // silently loses most of its width.
      console.warn("section outline: the fat-line shader no longer carries the"
        + " line the depth correction hangs off");
      return;
    }
    shader.vertexShader = "uniform vec4 hmrCutNormal;\n" + patched;
  };
  return material;
}

/**
 * Put the cut plane's normal into the material's uniform, in view space.
 *
 * Per frame: the plane stands still in the world while the reader orbits. The
 * three columns of `matrixWorld` dotted with the world normal apply the inverse
 * rotation (a camera matrix carries no scale). The normal's sign cancels in the
 * shader's ratio.
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
 * A fresh geometry every time. `setPositions` replaces the instanced buffer,
 * but three caches the drawable instance count on the geometry in
 * `_maxInstanceCount`: `WebGLBindingStates.setupVertexAttributes`
 * (static/_v/three.module.js:1908) writes it only while it is `undefined`, and
 * `renderBufferDirect` (static/_v/three.module.js:17116) draws
 * `min(instanceCount, _maxInstanceCount)`. Only the dispose event clears it
 * (static/_v/three.module.js:4254), so a refilled outline would keep drawing
 * only as many segments as it had at birth, silently. A new geometry has no
 * cache; the old one is disposed to free its GPU buffer and VAO.
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
 * `setPositions` takes. A triangle is crossed where an edge's endpoints land on
 * opposite sides; its two crossings are one segment.
 *
 * The sign test counts zero as the negative side, so a triangle with one vertex
 * on the plane and the other two positive yields a zero-length segment. It is
 * harmless: the fat-line shader expands along the segment's direction, and with
 * none the quad degenerates and nothing rasterises. A non-finite distance (a
 * degenerate solid) skips the triangle, so no NaN reaches the buffer.
 *
 * Each chord is directed from the crossing where the walk leaves the positive
 * side to the one where it returns, not in edge-walk order (which depends on
 * which corner the triangle is listed from: `d = (-, +, -)` meets the entry
 * first, `d = (+, -, +)` the exit). An edge running `+` to `-` carries the
 * chord's start, `-` to `+` its end. The direction is pinned only by this
 * routine's tests (`signedArea` in outline.test.js); the fat line and
 * `insideSection` do not care.
 *
 * It is independent of listing order but not of winding: reversing a triangle
 * reverses its chord, so a consistently wound mesh is required, and
 * outline.test.js pins the fixture's winding.
 *
 * With exactly two crossings there is one of each: signs alternate around a
 * closed walk.
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
      // No zero-divide is possible: one of the two is strictly positive, the
      // other is not, and both are finite, so `da - db` is strictly positive.
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
 * `n . p + c` reads `(R^T n) . p_local + (n . t + c)`: only the plane is
 * transformed and the triangles are read as stored. The local normal is not
 * unit (the matrix may scale), but every comparison downstream is a sign or a
 * ratio.
 *
 * Shared by the contour and by the containment test for a right-click on a cut
 * face (picking.js).
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
 * has no tessellation.
 *
 * Used for "is the cursor's point inside this shape", asked in the world.
 * Carrying the few dozen boundary points to world coordinates avoids inverting
 * `matrixWorld` per solid per click.
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
 * Does `point` lie inside the cross-section `segments` bounds? A crossing-parity
 * test in the plane, and pure.
 *
 * A cross-section is a set of closed loops, so a ray from the point crosses the
 * boundary an odd number of times exactly when it is inside; a hole is another
 * loop, so a point in it reads as outside.
 *
 * The segments need not be ordered or oriented, so `planeThroughTriangles`'
 * output is used as is. Its zero-length segments are skipped by the first test
 * below, both endpoints being on the same side of the ray.
 *
 * `u` is the world axis least aligned with the normal, flattened by a cross
 * product so it is never degenerate, and `v` completes an orthonormal in-plane
 * basis, which keeps the numbers on the model's scale.
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
    // one way round or the other, so a ray through a shared endpoint counts it
    // once. A NaN coordinate fails both comparisons and is skipped. A surviving
    // segment has `bv !== av`, so the division cannot divide by zero.
    if ((av > pv) === (bv > pv)) continue;
    if (pu < au + ((pv - av) / (bv - av)) * (bu - au)) inside = !inside;
  }
  return inside;
}

/**
 * Rebuild every solid's outline for the plane standing at `normal` through
 * slider value `value`. The two plane-write sites in section.js call this
 * before the library's own write, because that write ends in a render the
 * outline has to exist by.
 *
 * Memoised on the plane's normal and value on the viewport: a drag fires this
 * several times a second. The memo does not cover a moved part, so the move
 * path calls `refreshSectionOutline`. `show()` clears the memo when it swaps the
 * scene, since the old outlines died with their groups.
 *
 * `normal` must be unit (as `sectionValueFor` in section.js requires): the
 * world constant is `value - normal . centre`, which matches
 * `CenteredPlane.setConstant` only for a unit normal; otherwise the contour is
 * drawn on a different plane from the clipping one, silently. Every caller
 * satisfies it: the seed is normalised in `placeSectionPlane`, and the others
 * read the library's plane, which `setClipNormal` normalised.
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
      // The box test only saves the triangle walk; the plane must still be
      // written, so a solid the plane just left loses its old contour. A miss
      // with nothing to overwrite creates nothing.
      if (outline) writeSegments(outline, NO_SEGMENTS);
      continue;
    }
    const segments = planeThroughTriangles(
      position.array, geometry.index.array, n, c);
    if (outline) {
      // An update: the object keeps its place in the group and its material
      // (the width does not vary). Its geometry is replaced, see
      // `writeSegments`.
      writeSegments(outline, segments);
    } else {
      // The same construction order `_renderEdges` uses: fill the geometry,
      // then hand it to the line object.
      const lineGeometry = new classes.LineSegmentsGeometry();
      lineGeometry.setPositions(segments);
      outline = new classes.LineSegments2(
        lineGeometry, outlineMaterial(classes, g));
      outline.name = OUTLINE_NAME;
      // Last in the frame, above every face and edge the library draws.
      //
      // Every material the library gives a shape is `transparent: true`, so the
      // model is sorted in the transparent pass by `renderOrder` first. (The cap
      // is opaque and drawn earlier, so the contour reads over it regardless.)
      // The library puts its edges at 999, and translucent parts' faces at 999
      // too; a contour at 0 would draw before them, and those faces, writing no
      // depth, blend over it until it vanishes under translucent parts.
      //
      // 1000, not 999: within one bucket the order follows each object's
      // bounding-sphere depth, which changes as the model turns. The library's
      // highlight points also use 1000 ("after faces/edges"). Depth testing
      // still lets an opaque part in front hide the contour.
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
      // Born matching its part. parts.js carries hiding and ghosting onto
      // existing outlines, but an outline can be created later: a live reload
      // applies the hidden list inside `show()` before restoring the cut. So the
      // state is copied off the part's front material, which `setStates` writes.
      // Not off `group.opacity`, which `applyGhost` writes and never resets:
      // the face's own opacity is maintained by `setTransparent` both ways and
      // includes the model's alpha, so the cut face inherits the body's
      // transparency.
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
