// The printer's beds under the `print` view: a flat plate per bed of the view,
// as wide and deep as the bed the model names (`"bed": (x, y)` on the view, the
// `bed` of its meta.json entry), centred under the parts on that bed and lying
// at their lowest point, where the build measured them
// (`assembly.export_plate_3mfs`) — where Bambu Studio will centre them.
//
// Scenery, not a part. Objects in the library's scene beside the comment
// arrows (`scene3d.js` carries the shared half), so not in the tree, the pick
// buffer, a measurement, the cut or a comment, and the parts' eye and ghost
// square leave them be. The one thing a bed answers is the click that opens a
// part's menu, where no part is under the cursor (`bedAt`, asked by `openMenu`
// in tools.js): the page offers that bed's 3MF.
//
// Depth-tested and translucent: a part in front hides the bed, the bed is drawn
// under the parts standing on it, and it takes its shade from the canvas behind.

import { ndcAt } from "./camera.js";
import { internals } from "./internals.js";
import { finite3 } from "./math.js";
import { BEDS_ORDER, createScene3D } from "./scene3d.js";

/** The bed's face: a mid grey laid over the canvas at FACE_OPACITY, so it reads
 *  as a light bed on the light theme and a dark one on the dark theme without
 *  the viewport knowing which is on. */
const FACE = 0x8b929c;
const FACE_OPACITY = 0.3;

/** Its outline: the face's grey at full strength, so the edge of the bed reads
 *  on the face and on the canvas of either theme. */
const EDGE = 0x8b929c;

/** What a piece answers the widget's own ray with: nothing (`NO_HIT` in
 *  gizmo.js). The bed takes no press and wears no cursor; `bedAt` asks the
 *  face itself. */
const NO_HIT = () => {};

/**
 * The beds a view's meta.json entry declares, in bed order:
 * `[{plate, size: [x, y], centre: [x, y, z]}]`, none for a view without `bed`.
 *
 * Read a field at a time, as a fetched document is; a bed whose centre is not
 * three numbers is not drawn.
 */
export function bedsOf(entry) {
  const bed = entry && entry.bed;
  const size = bed && Array.isArray(bed.size_mm) ? bed.size_mm : null;
  const centres = bed && bed.centres && typeof bed.centres === "object"
    ? bed.centres : null;
  if (!size || !centres) return [];
  return Object.keys(centres)
    .map((number) => ({ plate: Number(number), size, centre: centres[number] }))
    .filter((one) => Number.isInteger(one.plate) && finite3(one.centre))
    .sort((a, b) => a.plate - b.plate);
}

/**
 * The scene document with its root `bb` widened to take in the beds `entry`
 * declares, or the document itself for a view that declares none.
 *
 * The library frames the camera, sets its near and far planes and answers the
 * Fit button off that box alone, read once per render (`renderTessellatedShapes`
 * and `Camera` in the vendored library), and the build measures it over the
 * parts. A bed is far wider than a small layout: framed on the parts, it fills
 * the canvas and its near corner falls behind the near plane. The same box
 * sizes the library's grid, so on a view with beds the Move tool snaps and the
 * section travels on the bed's scale (`niceStep` in tools.js, `sectionLimit` in
 * section.js).
 *
 * A copy: the document as fetched keeps the parts' box, which the comment
 * arrows take their length from (`pins.js`). Spelled as the build's
 * `views._widen_bb` widens the same box.
 */
export function framedWithBeds(scene, entry) {
  const beds = bedsOf(entry);
  if (!beds.length) return scene;
  const lows = beds.map(({ size, centre }) =>
    [centre[0] - size[0] / 2, centre[1] - size[1] / 2, centre[2]]);
  const highs = beds.map(({ size, centre }) =>
    [centre[0] + size[0] / 2, centre[1] + size[1] / 2, centre[2]]);
  const box = scene.bb;
  if (box && typeof box === "object") {
    lows.push([box.xmin, box.ymin, box.zmin]);
    highs.push([box.xmax, box.ymax, box.zmax]);
  }
  const bb = {};
  ["x", "y", "z"].forEach((axis, index) => {
    bb[`${axis}min`] = Math.min(...lows.map((low) => low[index]));
    bb[`${axis}max`] = Math.max(...highs.map((high) => high[index]));
  });
  return { ...scene, bb };
}

export function createBeds(vp) {
  // The group, the place in the library's render pass and the teardown are
  // `scene3d.js`'s; the size is ours (`pixels: false`): every bed is built at
  // its world point and size.
  const widget = createScene3D(vp, {
    wanted, build, place, press: () => false, order: BEDS_ORDER, pixels: false,
  });

  // What the view on screen declares, kept so beds set before the first
  // `attach` are built once the group is.
  let list = [];
  // What the drawn beds were built from, by value, so the same list handed
  // over again rebuilds nothing.
  let built = null;
  // One `{plate, face, edge}` per drawn bed.
  let drawn = [];

  let three = null;
  let group = null;
  let face = null;
  let edge = null;
  let raycaster = null;
  let pointer = null;

  function wanted() {
    return drawn.length > 0;
  }

  function build(namespace, grp) {
    three = namespace;
    group = grp;
    // Pushed back behind whatever lies in its plane, so the bottom face of a
    // part standing on the bed is drawn over it rather than fighting it.
    // Double-sided: the reader orbits under the bed. `clippingPlanes: []`
    // keeps the section from cutting it, as on the arrows.
    // Translucent and writing no depth, so a part seen through the bed from
    // below is not cut off by it.
    face = new three.MeshBasicMaterial({
      color: FACE, transparent: true, opacity: FACE_OPACITY, depthWrite: false,
      side: three.DoubleSide, polygonOffset: true,
      polygonOffsetFactor: 1, polygonOffsetUnits: 1, clippingPlanes: [],
      toneMapped: false,
    });
    edge = new three.LineBasicMaterial({
      color: EDGE, clippingPlanes: [], toneMapped: false,
    });
    raycaster = new three.Raycaster();
    pointer = new three.Vector2();
    sync();
  }

  /** Bring the beds in line with `list`. Returns whether anything changed;
   *  nothing can before the group exists. */
  function sync() {
    if (!group) return false;
    const from = JSON.stringify(list);
    if (from === built) return false;
    built = from;
    for (const bed of drawn) {
      group.remove(bed.face, bed.edge);
      bed.face.geometry.dispose();
      bed.edge.geometry.dispose();
    }
    drawn = list.map(({ plate, size, centre }) => {
      const plane = new three.PlaneGeometry(size[0], size[1]);
      const one = {
        plate,
        face: new three.Mesh(plane, face),
        edge: new three.LineSegments(new three.EdgesGeometry(plane), edge),
      };
      for (const piece of [one.face, one.edge]) {
        piece.position.set(centre[0], centre[1], centre[2]);
        piece.raycast = NO_HIT;
        group.add(piece);
      }
      return one;
    });
    return true;
  }

  /** Every bed already stands at its world point. */
  function place() {
    return true;
  }

  /**
   * The bed under the pointer of `event`, or null: the nearest face the ray
   * through it crosses, from above or below.
   */
  function bedAt(event) {
    const g = wanted() && group.visible ? internals(vp.viewer) : null;
    const ndc = g ? ndcAt(g.canvas, event) : null;
    if (!ndc) return null;
    pointer.set(ndc[0], ndc[1]);
    raycaster.setFromCamera(pointer, g.cam);
    group.updateMatrixWorld(true);
    const hits = [];
    for (const bed of drawn) {
      three.Mesh.prototype.raycast.call(bed.face, raycaster, hits);
    }
    if (!hits.length) return null;
    hits.sort((a, b) => a.distance - b.distance);
    return drawn.find((bed) => bed.face === hits[0].object).plate;
  }

  return {
    /** The beds of the view on screen, out of its meta.json entry, and the
     *  frame that draws them when they changed. */
    setBeds(entry) {
      list = bedsOf(entry);
      if (sync()) widget.refresh();
    },
    bedAt,
    // The two halves of the lifecycle, passed straight through to `show()` in
    // element.js, which knows when a scene is replaced.
    attach: widget.attach,
    detach: widget.detach,
    destroy() {
      widget.destroy();
      // The two inks: `widget.destroy` reaches them only through the beds
      // standing at the time, and there may be none.
      if (face) face.dispose();
      if (edge) edge.dispose();
      drawn = [];
    },
  };
}
