// ui/src/viewport/outline.js — the dark contour of each part's cut face.
//
// The library clips fragments on the GPU, so a cut face ends at the plane as a
// bare coloured silhouette: nothing marks WHERE the solid was cut open. The
// hatch (hatch.js) fills the face; this draws its edge. For every solid the
// section plane is intersected with the solid's own triangles and the
// resulting segments are laid down as a thick dark line in the plane, on the
// library's fat-line stack — `LineSegments2` over a `LineSegmentsGeometry`
// under a `LineMaterial`, harvested off a live solid's edge overlay because
// the vendored bundle exports none of the three.
//
// ONE outline object per solid, a child of that solid's ObjectGroup: a
// ghosted or rebuilt part carries its outline along for free. The
// intersection runs in the solid's LOCAL frame — the triangle positions are
// read exactly as stored and only the PLANE is transformed — which saves
// transforming every triangle into world coordinates. It does NOT save a
// rebuild when the part moves: the plane stands in the WORLD, so a moved part
// cuts differently through it, and the move path (`movePart`/`resetMoves`)
// drops the memo and calls `refreshSectionOutline` since no plane write is
// coming to rebuild for it. The memo below (on the viewport object, never at
// module scope) holds the rebuild off whenever the PLANE did not move.

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

// The library draws its own edges one device pixel wide; a contour has to read
// over the hatch and both cut faces, so a few pixels and dark.
const OUTLINE_WIDTH = 3;
const OUTLINE_COLOR = 0x303030;

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
 * The outline material: the library's own edge material, thick and dark.
 *
 * Cloned rather than built, so it keeps what the factory already got right —
 * the polygon offset toward the camera, no tone mapping, shader clipping on.
 * It must NOT be clipped by the plane it lies IN, so it carries what the cap
 * materials carry: only the OTHER two planes, in the library's own order.
 */
function outlineMaterial(classes, g) {
  const material = classes.edges.material.clone();
  material.linewidth = OUTLINE_WIDTH;
  material.color.setHex(OUTLINE_COLOR);
  material.clippingPlanes = g.clipping.clipPlanes.filter(
    (_, index) => index !== SECTION_INDEX);
  material.resolution.set(g.nestedGroup.width, g.nestedGroup.height);
  return material;
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
    const crossings = [];
    for (let corner = 0; corner < 3; corner += 1) {
      const next = (corner + 1) % 3;
      const da = d[corner];
      const db = d[next];
      if (!Number.isFinite(da) || !Number.isFinite(db) || (da > 0) === (db > 0)) {
        continue;
      }
      const span = da - db;
      if (span === 0) continue;
      const t = da / span;
      const a = index[triangle + corner] * 3;
      const b = index[triangle + next] * 3;
      crossings.push([
        positions[a] + t * (positions[b] - positions[a]),
        positions[a + 1] + t * (positions[b + 1] - positions[a + 1]),
        positions[a + 2] + t * (positions[b + 2] - positions[a + 2]),
      ]);
    }
    if (crossings.length !== 2) continue;
    flat.push(crossings[0][0], crossings[0][1], crossings[0][2],
              crossings[1][0], crossings[1][1], crossings[1][2]);
  }
  return new Float32Array(flat);
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
    // The plane in the solid's LOCAL frame. With a column-major matrixWorld
    // (e), p_world = R p_local + t, so n.p + c reads (R^T n).p_local +
    // (n.t + c): only the plane crosses over, the triangles are read as
    // stored. The local normal is not unit — the matrix may scale — but every
    // comparison below is a sign or a ratio, which a common factor survives.
    const e = front.matrixWorld.elements;
    const n = [
      e[0] * nx + e[1] * ny + e[2] * nz,
      e[4] * nx + e[5] * ny + e[6] * nz,
      e[8] * nx + e[9] * ny + e[10] * nz,
    ];
    const c = nx * e[12] + ny * e[13] + nz * e[14] + constant;
    let outline = outlineChild(group);
    if (!planeMayCut(geometry.boundingBox, n, c)) {
      // The box test only saves the triangle walk — the plane still has to be
      // WRITTEN, because a solid it just left must not keep the contour cut
      // where the plane used to be. A miss with nothing to overwrite creates
      // nothing.
      if (outline) outline.geometry.setPositions(NO_SEGMENTS);
      continue;
    }
    const segments = planeThroughTriangles(
      position.array, geometry.index.array, n, c);
    if (outline) {
      // An update, not a rebuild: the object keeps its place in the group.
      outline.geometry.setPositions(segments);
    } else {
      // The same construction order `_renderEdges` uses: fill the geometry,
      // then hand it to the line object.
      const lineGeometry = new classes.LineSegmentsGeometry();
      lineGeometry.setPositions(segments);
      outline = new classes.LineSegments2(lineGeometry, outlineMaterial(classes, g));
      outline.name = OUTLINE_NAME;
      // The mark `outlineChild` finds it by. Written here and nowhere else.
      outline.userData = { ...(outline.userData || {}), [OUTLINE_NAME]: true };
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
      // part ghosted and un-ghosted again still reads 0.25 there. The face's
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
      if (outline) outline.geometry.setPositions(NO_SEGMENTS);
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
