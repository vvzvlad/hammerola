// The comments on the model: one arrow per entry of `state.pins`, standing
// in the library's scene with its tip on the comment's point and its body out
// along the face normal taken when the comment was placed. A press on one says
// which comment it is (`hmr:pin`) and the interface opens that row in the rail;
// an arrow carries no number (docs/SPEC.md §4).
//
// Objects in the scene rather than elements over it, so an arrow turns with the
// model and the camera projects it like everything else; `scene3d.js` carries
// the shared half. What crosses the boundary is the DATA (`state.pins`) and the
// PRESS (`hmr:pin`).
//
// Many arrows in the ONE group `scene3d.js` places, asked for with
// `pixels: false`: the group is left unscaled, so `place` stands each arrow at
// its world point and scales it to a length taken from the model's own size.
// Measured in the model rather than on the screen, and depth-tested, so an
// arrow grows as the reader zooms in and is hidden by the geometry in front of
// it, like the part it points into.

import { cameraBasis, canvasXY, ndcAt } from "./camera.js";
import { EVENT_PIN, emit } from "./events.js";
import { dot3, finite3, sub3, unit3, vec3 } from "./math.js";
import {
  PIN_CASE_PX, PIN_HEAD_PX, PIN_HEAD_WIDTH_PX, PIN_LENGTH_FRACTION, PIN_PX,
  PIN_SHAFT_PX,
} from "./options.js";
import { capOwnerAt, pickEntity } from "./picking.js";
import { PINS_ORDER, createScene3D } from "./scene3d.js";

/** The arrows' tomato red, as a hex the material takes. One colour for both
 *  themes, as the grip's ink is (`INK` in handle.js): the white casing under it
 *  is what holds it on a canvas or a part of any colour. */
const INK = 0xf0613f;

/** The open comment's arrow, and the draft's: the same hue, darker, so the arrow
 *  the rail is talking about is the one that stands out. */
const INK_ACTIVE = 0xc2410c;

/** The casing under the ink, as under the section grip (`CASING` in handle.js). */
const CASING = 0xffffff;

/** How round the shaft and the head are. Twice the grip's: these are lit, and
 *  a lit cone shows its facets where a flat one does not. */
const SIDES = 24;

/** Which way an arrow stands when its comment carries no normal: from above,
 *  along the viewer's up axis (`up: "Z"` in options.js). */
const UP = [0, 0, 1];

/**
 * The direction an arrow's body stands out along, from its tip: the comment's
 * normal as a unit vector, or straight down onto the point from above where
 * there is none (a comment left before normals were stored, or one standing on
 * the top of a part's box on another build). `up` is that above: the model's
 * +Z here, a board's 3D model's glTF +Y (BoardView3D.jsx).
 *
 * `unit3` answers a zero vector with null and an infinite component with NaNs,
 * so its answer is checked again.
 */
export function pinDirection(n, up = UP) {
  const unit = finite3(n) ? unit3(n) : null;
  return finite3(unit) ? unit : up;
}

/**
 * The shapes and inks every arrow shares, built once in the three namespace
 * `three`, and the arrows made of them: the model's (`createPins` below) and
 * those on a board's 3D model (BoardView3D.jsx), one look for both.
 *
 * An arrow is `PIN_PX` long along +Y (the axis three gives a cylinder and a
 * cone) with the TIP at the origin: a node put at the point, turned from +Y
 * onto the direction and scaled to its world length points into the face, its
 * body standing out of it.
 *
 * The casing is the same shaft and head grown by `PIN_CASE_PX` all round, the
 * tip included, so it ENCLOSES the ink. Only its far side is drawn
 * (`side: BackSide`, the inverted-hull outline): its front faces are nearer
 * than the ink and, with the depth test on, would simply cover it and leave a
 * white arrow, while its back faces show exactly as a rim around the
 * silhouette.
 *
 * The ink is lit (Phong) and the casing flat, and both are opaque and
 * depth-tested: an arrow is an object in the scene, so an opaque part in
 * front of it hides it and a translucent one is laid over it (`PINS_ORDER`
 * in scene3d.js). `clippingPlanes: []` keeps the section from cutting it, as
 * on the widgets' own materials.
 *
 * The casing's material is built here rather than taken from
 * `widgetMaterial`, which is the never-hidden, always-blended ink the other
 * widgets share.
 */
export function arrowKit(three) {
  const shapes = (grow) => {
    const headLength = PIN_HEAD_PX + 2 * grow;
    const cone = new three.ConeGeometry(PIN_HEAD_WIDTH_PX / 2 + grow,
                                        headLength, SIDES);
    // A cone is centred on the origin and points +Y: turned over to point at
    // the tip, and lifted so its point is `grow` beyond the origin.
    cone.rotateZ(Math.PI);
    cone.translate(0, headLength / 2 - grow, 0);
    // The rod runs from `grow` short of the ink head's base (`PIN_HEAD_PX`)
    // to `grow` past the tail (`PIN_PX`). The casing's rod has to start
    // inside the ink's head: its end
    // cap faces the tip, so seen from the tail it is a back face the
    // casing draws, and level with the ink's base it would fight it for
    // every pixel round the shaft.
    const length = PIN_PX - PIN_HEAD_PX + 2 * grow;
    const rod = new three.CylinderGeometry(PIN_SHAFT_PX / 2 + grow,
                                           PIN_SHAFT_PX / 2 + grow, length, SIDES);
    rod.translate(0, (PIN_HEAD_PX + PIN_PX) / 2, 0);
    return [rod, cone];
  };
  const [shaft, head] = shapes(0);
  const [caseShaft, caseHead] = shapes(PIN_CASE_PX);
  const lit = (color) => new three.MeshPhongMaterial({
    color, shininess: 60, transparent: false, depthTest: true,
    depthWrite: true, clippingPlanes: [],
  });
  const ink = lit(INK);
  const inkActive = lit(INK_ACTIVE);
  const casing = new three.MeshBasicMaterial({
    color: CASING, transparent: false, depthTest: true, depthWrite: true,
    clippingPlanes: [], toneMapped: false, side: three.BackSide,
  });
  return {
    /** A new arrow, `{ node, meshes, casings }`: the ink and the casing as
     *  children of one plain `Object3D`, never a `Group` — three re-reads
     *  `renderOrder` as the group order at every `Group`, which would drop
     *  the arrow out of its band (handle.js nests its rings the same way). */
    arrow() {
      const node = new three.Object3D();
      const meshes = [new three.Mesh(shaft, ink), new three.Mesh(head, ink)];
      const casings = [new three.Mesh(caseShaft, casing),
                       new three.Mesh(caseHead, casing)];
      node.add(...meshes, ...casings);
      return { node, meshes, casings };
    },
    /**
     * Paint `arrow` as the open comment's or not. The open comment's arrow
     * is the darker ink, and it is drawn after the others. Where the arrows
     * stand apart the depth test decides what is seen and this order changes
     * nothing. It decides only where two comments on one part resolve to ONE
     * anchor: their arrows are the same shape at the same depth, the depth
     * test passes on equal depth (three's default `LessEqualDepth`) and the
     * last drawn wins, so the open arrow, casing and ink, comes out over the
     * others — which is how the rail brings either one's arrow out of the
     * other.
     */
    paint(arrow, active) {
      for (const mesh of arrow.meshes) {
        mesh.material = active ? inkActive : ink;
        mesh.renderOrder = active ? 2 : 0;
      }
      for (const mesh of arrow.casings) mesh.renderOrder = active ? 1 : -1;
    },
    /** Free the shared shapes and inks: nothing frees them through the
     *  arrows standing, and there may be none. */
    dispose() {
      for (const owned of [shaft, head, caseShaft, caseHead, ink, inkActive, casing]) owned.dispose();
    },
  };
}

export function createPins(vp) {
  // The group, the place in the library's render pass, the press and the
  // teardown are `scene3d.js`'s; the size is ours (`pixels: false`). `wanted`,
  // `build`, `place`, `rank` and `onDown` are the declarations below.
  const widget = createScene3D(vp, {
    wanted, build, place, press: onDown, rank, cursor: "pointer",
    order: PINS_ORDER, pixels: false,
  });

  // What the interface sent last, kept so a list that arrives before the first
  // `attach` is drawn once the group is built.
  let list = [];
  // One arrow per comment id: `{id, point, active, drawn, node, meshes,
  // casings}`.
  const arrows = new Map();
  // The arrow each node stands for. A ray hits a mesh, and every mesh of an
  // arrow is a child of its node.
  const owners = new Map();

  // Built with the group, on the first `attach` that brings the namespace.
  let three = null;
  let group = null;
  let kit = null;
  let up = null;
  let aim = null;

  /** Whether there is an arrow to draw at all. */
  function wanted() {
    return arrows.size > 0;
  }

  /** The shapes and inks every arrow shares (`arrowKit`), scaled by `place`
   *  to their world length. */
  function build(namespace, grp) {
    three = namespace;
    group = grp;
    up = new three.Vector3(0, 1, 0);
    aim = new three.Vector3();
    kit = arrowKit(three);
    sync();
  }

  /** Bring the arrows in line with `list`: add the new ones, drop the gone,
   *  and turn and colour those whose point, direction or state moved. Returns
   *  whether anything changed; nothing can before the group exists. */
  function sync() {
    if (!group) return false;
    let changed = false;
    const seen = new Set();
    for (const pin of list) {
      if (!pin || pin.id === undefined || !finite3(pin.p)) continue;
      const key = String(pin.id);
      seen.add(key);
      let arrow = arrows.get(key);
      if (!arrow) {
        arrow = { id: pin.id, ...kit.arrow() };
        group.add(arrow.node);
        arrows.set(key, arrow);
        owners.set(arrow.node, arrow);
      }
      const along = pinDirection(pin.n);
      const active = !!pin.active;
      // What the arrow was last drawn from, by value: the page mints new arrays
      // on every push, so identity would call every push a change.
      const drawn = JSON.stringify([pin.p, along, active]);
      if (arrow.drawn === drawn) continue;
      arrow.drawn = drawn;
      changed = true;
      arrow.point = pin.p;
      arrow.active = active;
      arrow.node.quaternion.setFromUnitVectors(up, aim.set(...along));
      kit.paint(arrow, arrow.active);
    }
    for (const [key, arrow] of [...arrows]) {
      if (seen.has(key)) continue;
      group.remove(arrow.node);
      owners.delete(arrow.node);
      arrows.delete(key);
      changed = true;
    }
    return changed;
  }

  /**
   * Stand every arrow on its point, at the length the model gives.
   *
   * The group stays at the origin, unturned and unscaled (`pixels: false`), so
   * a node goes straight to its world point and carries the size itself: the
   * shape is `PIN_PX` long, so the scale is the world length over `PIN_PX`.
   *
   * That length is `PIN_LENGTH_FRACTION` of the model's half-diagonal, taken
   * from the bounding box the hub published with the view (`payload.bb`), which
   * is a fetched document and so is read a field at a time. A view that carries
   * no usable box leaves the arrow at `PIN_PX * k`, the size it had on the
   * screen when it was a screen widget, rather than at nothing.
   *
   * One length for every arrow, worked out once a frame.
   */
  function place(root, g, k) {
    const bb = vp.payload && vp.payload.bb;
    const span = bb
      ? [bb.xmax - bb.xmin, bb.ymax - bb.ymin, bb.zmax - bb.zmin] : null;
    const half = finite3(span) ? Math.hypot(span[0], span[1], span[2]) / 2 : 0;
    const length = half > 0 ? PIN_LENGTH_FRACTION * half : PIN_PX * k;
    const scale = length / PIN_PX;
    for (const arrow of arrows.values()) {
      const p = arrow.point;
      arrow.node.position.set(p[0], p[1], p[2]);
      arrow.node.scale.setScalar(scale);
    }
    return true;
  }

  /** Which of the arrows the ray meets at one same distance a press goes to:
   *  the open one. The press goes to the nearest arrow, the one on top under
   *  the depth test, and this is asked only between coincident ones — two
   *  comments on one part resolved to one anchor — where the open one is drawn
   *  over the others (`sync`; `rank` in scene3d.js). */
  function rank(object) {
    const arrow = owners.get(object.parent);
    return arrow && arrow.active ? 0 : 1;
  }

  /**
   * A press the ray found on an arrow: say which comment it is.
   *
   * Primary button only: a refused press goes on to what is behind (see
   * `onDown` in scene3d.js), so a right-click on an arrow still opens the part
   * menu and a right-drag still pans.
   *
   * Refused too where the arrow is hidden at that pixel (`hidden`): the ray
   * meets only arrows, so a click on a wall would otherwise open the comment
   * standing behind it, and the orbit, the pick or the Comment tool under it
   * would never get the press.
   */
  function onDown(event, g, at) {
    if (event.button !== 0) return false;
    const arrow = owners.get(at.object.parent);
    if (!arrow || hidden(g, event, at, arrow)) return false;
    emit(vp, EVENT_PIN, { id: arrow.id });
    return true;
  }

  /**
   * Whether an opaque part of the model stands in front of the arrow at the
   * pressed pixel, as the library's GPU picker sees it.
   *
   * The picker answers the nearest model surface drawn at that pixel and never
   * an arrow (they stay on layer 0, `scene3d.js`), at the same canvas pixel the
   * tools pick at (`canvasXY`, as in tools.js). Its point blocks the press when
   * it is nearer the camera than where the ray met the arrow, measured along
   * the view axis, and only on an opaque part: a translucent one (glass) is laid
   * over the arrow, which shows through it, so the press goes to the arrow the
   * reader is looking at.
   *
   * A cut face is asked about first, as `entityAt` in tools.js does: the picker
   * reads through its stencil cap (`capOwnerAt` in picking.js says why), while
   * the cap itself is opaque and hides an arrow behind it. Its point lies on
   * the cut plane, the depth the reader sees there.
   *
   * Nearer by more than the casing's thickness in the world: the casing pokes
   * that far past the tip into the face the arrow stands on, and the picker
   * reads a half-resolution buffer, so a press by the tip can find that face a
   * hair in front of the arrow seen there.
   *
   * Asked on the press only. The hover cursor raycasts on every move, and a GPU
   * pick there (a readback each time, and a render of the pick buffer whenever
   * the view has changed) costs too much, so the pointer can show over an arrow
   * that is hidden.
   */
  function hidden(g, event, at, arrow) {
    const xy = canvasXY(g.canvas, event);
    const basis = xy ? cameraBasis(vp.viewer, g) : null;
    const ndc = basis ? ndcAt(g.canvas, event) : null;
    const found = basis
      ? (ndc && capOwnerAt(vp, g, ndc)) || pickEntity(g, xy[0], xy[1])
      : null;
    if (!found || !finite3(found.point)) return false;
    const groups = g.nestedGroup && g.nestedGroup.groups;
    const solid = groups ? groups[found.id] : null;
    const material = solid && solid.front && solid.front.material;
    if (!material || !(material.opacity >= 1)) return false;
    const depth = (p) => dot3(sub3(p, basis.eye), basis.view);
    const margin = PIN_CASE_PX * arrow.node.scale.x;
    return depth(vec3(found.point)) < depth(at.point) - margin;
  }

  return {
    /** The interface's list (`state.pins`), `{id, p, n, active}` per arrow,
     *  and the frame that draws it when an arrow changed.
     *
     * Only then: `reconcile` in element.js hands the list over on every push
     * (every tree click, every section-slider step), and a frame is a render of
     * the whole scene. */
    setPins(next) {
      list = Array.isArray(next) ? next : [];
      if (sync()) widget.refresh();
    },
    // The two halves of the lifecycle, passed straight through to the one caller
    // that knows when a scene is replaced: `show()` in element.js.
    attach: widget.attach,
    detach: widget.detach,
    destroy() {
      widget.destroy();
      // The shared shapes and inks: `widget.destroy` reaches them only through
      // the arrows standing at the time, and there may be none.
      if (kit) kit.dispose();
      arrows.clear();
      owners.clear();
    },
  };
}
