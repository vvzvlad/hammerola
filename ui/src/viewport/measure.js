// Measurements, taken from the library's own mesh backend.
//
// THIS IS NOT WRITTEN HERE, and the note this project carried for years — that
// measurements "need a backend we do not run" — is out of date: version 5.0.1
// carries `MeshMeasureBackend`, which computes from the tessellation with no
// Python `ocp_vscode` anywhere. It is built unconditionally in the `Viewer`
// constructor and does not depend on `tools` (docs/viewer-api.md §2), so at
// `tools: false` it is sitting there fully working with its panel hidden.
//
// It is called DIRECTLY rather than through the library's measurement tools: no
// state, no armed tool, no panel, and a synchronous return. Going the other way
// — arming a tool and reading the result — does not work at all from outside,
// because the numbers never reach `notifyCallback`; only `selectedShapeIDs`
// does, and the answer is computed internally and left in the panel.

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
 * `center: false` gives the MINIMUM distance — an exact branch-and-bound over
 * the BVH — which is what "the gap is 2.4" means to a person. `true` would give
 * the distance between centroids, which is a different question nobody asked.
 *
 * `crossPart` and `moved` ride along because of the limit ui-brief block 7 puts
 * on this feature and requires to be VISIBLE: the numbers are in the coordinates
 * the tessellation arrived in, so a distance BETWEEN two parts is a distance
 * between where they are standing right now — which in a print-layout view, or
 * after somebody dragged one, is not where they are in the assembly. Inside one
 * part (wall thickness, hole diameter, edge length) it is honest in every view.
 * The viewport reports the two facts; what the interface does with them — refuse
 * the measurement, or label it — is its call, and either satisfies the brief.
 * Handing over a bare number would not, because these numbers travel to an agent
 * as a task.
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
 * What the library knows about ONE picked entity: a hole's diameter, an edge's
 * length, a face's area, a solid's volume.
 *
 * The single-click half of the tool, and the half that is always trustworthy —
 * every one of these is a property of one part, so no arrangement of the
 * assembly can make it wrong.
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
  // Diameter first, and that ordering is the whole usefulness of this branch: a
  // reader clicking the inside of a hole wants the hole's size, which is the one
  // number the library only reports for a circular edge. It comes back with a
  // `≈` in the library's own panel because the radius is fitted to the polyline
  // (mesh, not B-rep), so it is exact for a straight edge or a flat face and
  // within the tessellation's deflection on a curve.
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
