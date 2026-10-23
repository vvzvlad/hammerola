// The comments on the model: one red arrow per entry of `state.pins`, standing
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
// Many arrows in the ONE group `scene3d.js` places. That module scales the group
// by world units per pixel, so the geometry is measured in pixels; each arrow
// stands at a world point of its own, so `place` divides the scale out of its
// position.

import { EVENT_PIN, emit } from "./events.js";
import { finite3, unit3 } from "./math.js";
import { PIN_HEAD_PX, PIN_PX, PIN_SHAFT_PX } from "./options.js";
import { PINS_ORDER, createScene3D, widgetMaterial } from "./scene3d.js";

/** The arrows' red, as a hex the material takes. One colour for both themes, as
 *  the grip's ink is (`INK` in handle.js): the canvas is white or near-black
 *  (`readTheme` in ui/src/store.js), and a strong red reads on either. */
const INK = 0xe02424;

/** The open comment's arrow, and the draft's: the same red, darker, so the arrow
 *  the rail is talking about is the one that stands out. */
const INK_ACTIVE = 0x8c0c0c;

/** How round the shaft and the head are: the grip's number (handle.js). */
const SIDES = 12;

/** Which way an arrow stands when its comment carries no normal: from above,
 *  along the viewer's up axis (`up: "Z"` in options.js). */
const UP = [0, 0, 1];

/**
 * The direction an arrow's body stands out along, from its tip: the comment's
 * normal as a unit vector, or straight down onto the point from above where
 * there is none (a comment left before normals were stored, or one hanging at
 * a part's centre on another build).
 *
 * `unit3` answers a zero vector with null and an infinite component with NaNs,
 * so its answer is checked again.
 */
export function pinDirection(n) {
  const unit = finite3(n) ? unit3(n) : null;
  return finite3(unit) ? unit : UP;
}

export function createPins(vp) {
  // The group, the place in the library's render pass, the pixel scale, the
  // press and the teardown are `scene3d.js`'s. `wanted`, `build`, `place`,
  // `rank` and `onDown` are the declarations below.
  const widget = createScene3D(vp, {
    wanted, build, place, press: onDown, rank, cursor: "pointer",
    order: PINS_ORDER,
  });

  // What the interface sent last, kept so a list that arrives before the first
  // `attach` is drawn once the group is built.
  let list = [];
  // One arrow per comment id: `{id, point, active, drawn, node, meshes}`.
  const arrows = new Map();
  // The arrow each node stands for. A ray hits a mesh, and every mesh of an
  // arrow is a child of its node.
  const owners = new Map();

  // Built with the group, on the first `attach` that brings the namespace.
  let three = null;
  let group = null;
  let shaft = null;
  let head = null;
  let ink = null;
  let inkActive = null;
  let up = null;
  let aim = null;

  /** Whether there is an arrow to draw at all. */
  function wanted() {
    return arrows.size > 0;
  }

  /**
   * The shapes and inks every arrow shares, in CSS pixels along +Y (the axis
   * three gives a cylinder and a cone) with the TIP at the origin: a node put
   * at the point and turned from +Y onto the direction points into the face,
   * its body standing out of it.
   */
  function build(namespace, grp) {
    three = namespace;
    group = grp;
    up = new three.Vector3(0, 1, 0);
    aim = new three.Vector3();
    head = new three.ConeGeometry(PIN_HEAD_PX / 2, PIN_HEAD_PX, SIDES);
    // A cone is centred on the origin and points +Y: turned over to point at
    // the tip, and lifted so its point is the origin.
    head.rotateZ(Math.PI);
    head.translate(0, PIN_HEAD_PX / 2, 0);
    const length = PIN_PX - PIN_HEAD_PX;
    shaft = new three.CylinderGeometry(PIN_SHAFT_PX / 2, PIN_SHAFT_PX / 2,
                                       length, SIDES);
    shaft.translate(0, PIN_HEAD_PX + length / 2, 0);
    ink = widgetMaterial(three, INK);
    inkActive = widgetMaterial(three, INK_ACTIVE);
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
        // A plain `Object3D`, never a `Group`: three re-reads `renderOrder` as
        // the group order at every `Group`, which would drop the arrow out of
        // this widget's band (handle.js nests its rings the same way).
        const node = new three.Object3D();
        const meshes = [new three.Mesh(shaft, ink), new three.Mesh(head, ink)];
        node.add(...meshes);
        group.add(node);
        arrow = { id: pin.id, node, meshes };
        arrows.set(key, arrow);
        owners.set(node, arrow);
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
      // The open arrow is drawn after the others, and with no depth test the
      // last drawn is on top. Two comments on one part resolve to one anchor,
      // so this is how the rail brings either one's arrow to the top.
      for (const mesh of arrow.meshes) {
        mesh.material = arrow.active ? inkActive : ink;
        mesh.renderOrder = arrow.active ? 1 : 0;
      }
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
   * Stand every arrow on its point. The group stays at the origin, unturned,
   * and `scene3d.js` scales it by `k` after this, so a node at `point / k` is
   * at `point` in the world while its geometry stays in pixels.
   */
  function place(root, g, k) {
    for (const arrow of arrows.values()) {
      const p = arrow.point;
      arrow.node.position.set(p[0] / k, p[1] / k, p[2] / k);
    }
    return true;
  }

  /** Which arrow a contested press goes to: the open one, which is drawn on
   *  top, rather than the nearest along the ray (`rank` in scene3d.js). */
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
   */
  function onDown(event, g, at) {
    if (event.button !== 0) return false;
    const arrow = owners.get(at.object.parent);
    if (!arrow) return false;
    emit(vp, EVENT_PIN, { id: arrow.id });
    return true;
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
      for (const owned of [shaft, head, ink, inkActive]) {
        if (owned) owned.dispose();
      }
      arrows.clear();
      owners.clear();
    },
  };
}
