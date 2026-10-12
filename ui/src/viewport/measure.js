// Measurements, taken from the library's own mesh backend.
//
// The library's `MeshMeasureBackend` computes from the tessellation, with no
// Python `ocp_vscode`. It is built unconditionally in the `Viewer` constructor
// and does not depend on `tools` (docs/viewer-api.md §2), so it works at
// `tools: false` with its panel hidden.
//
// It is called directly rather than through the library's measurement tools:
// no state, no panel, a synchronous return. Arming a tool and reading the result
// does not work from outside, because only `selectedShapeIDs` reaches
// `notifyCallback`; the numbers stay in the panel.

import { nameOf, solidOf } from "./picking.js";

/** The backend, or null if the library has moved it. */
function backend(viewer) {
  const mb = viewer && viewer.meshBackend;
  if (!mb || typeof mb.distance !== "function") return null;
  return mb;
}

/**
 * The shortest distance between two picked entities, or null.
 *
 * `center: false` gives the minimum distance (exact branch-and-bound over the
 * BVH), which is what "the gap is 2.4" means; `true` would measure between
 * centroids.
 *
 * `crossPart` and `moved` are reported because the numbers are in the
 * coordinates the tessellation arrived in: a distance between two parts is
 * between where they stand now, which in a print-layout view or after a drag is
 * not where they are in the assembly. Within one part (wall thickness, hole
 * diameter, edge length) it is correct in every view. The interface decides
 * whether to refuse or label such a measurement; a bare number must not reach
 * the agent as a task.
 */
export function measureDistance(vp, a, b) {
  const mb = backend(vp.viewer);
  if (!mb || !a || !b) return null;
  let answer = null;
  try {
    answer = mb.distance(a.path, b.path, false);
  } catch (error) {
    console.warn("measure", error);
    return null;
  }
  if (!answer || !Array.isArray(answer.result)) return null;
  const first = answer.result.find((row) => Number.isFinite(row.distance));
  if (!first) return null;
  const solidA = solidOf({ path: a.path, solidPath: a.id });
  const solidB = solidOf({ path: b.path, solidPath: b.id });
  return {
    kind: "distance",
    value: first.distance,
    delta: first["⇒ X | Y | Z"] || null,
    from: { id: solidA, name: nameOf(solidA), path: a.path, point: a.point },
    to: { id: solidB, name: nameOf(solidB), path: b.path, point: b.point },
    points: [a.point, b.point],
    crossPart: solidA !== solidB,
    moved: vp.moved.size > 0,
  };
}

/**
 * What the library knows about one picked entity: a hole's diameter, an edge's
 * length, a face's area, a solid's volume. Each is a property of one part, so
 * no arrangement of the assembly can make it wrong.
 */
export function measureEntity(vp, entity) {
  const mb = backend(vp.viewer);
  if (!mb || typeof mb.properties !== "function" || !entity) return null;
  let answer = null;
  try {
    answer = mb.properties(entity.path);
  } catch (error) {
    console.warn("measure", error);
    return null;
  }
  if (!answer || !Array.isArray(answer.result)) return null;
  const flat = Object.assign({}, ...answer.result.filter(
    (row) => row && typeof row === "object"));
  // Diameter first: a reader clicking inside a hole wants its size, which the
  // library reports only for a circular edge. It is approximate (the radius is
  // fitted to the polyline, mesh not B-rep), within the tessellation's
  // deflection on a curve.
  const value = [flat.diameter, flat.length, flat.area, flat.volume]
    .find(Number.isFinite);
  if (!Number.isFinite(value)) return null;
  const kind = Number.isFinite(flat.diameter) ? "diameter"
    : Number.isFinite(flat.length) ? "length"
    : Number.isFinite(flat.area) ? "area" : "volume";
  return {
    kind,
    value,
    approximate: kind === "diameter",
    shape: answer.shape_type || null,
    geom: answer.geom_type || null,
    of: { id: entity.id, name: entity.name, path: entity.path },
    points: entity.point ? [entity.point] : [],
    crossPart: false,
    moved: false,
  };
}
