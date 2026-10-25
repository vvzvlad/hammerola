// Everything the interface does to a part rather than to the camera: hide it,
// ghost it, select it, drag it, and hand the interface the tree it draws.

import { internals } from "./internals.js";
import { after, anglesOf, finite3, quaternionOf, turned } from "./math.js";
import { GHOST_OPACITY } from "./options.js";
import { outlineChild, refreshSectionOutline } from "./outline.js";

// Pure arithmetic living in `math.js` (so `ui/src/proposal.js` can use it
// without the viewer), re-exported because turns are this file's subject and
// the tests import them from here. Modules in `ui/src` import from `math.js`.
export { after, anglesOf, quaternionOf, turned };

/**
 * The part tree, built from the view file rather than from the library.
 *
 * `viewer.getStates()` is a flat map of leaf paths with no nesting or colour;
 * the pushed view file is `{name, color, parts: [...]}` all the way down
 * (src/render.py validates that shape). Paths are built as the library builds
 * them (parent path plus `/name`), and leaves are checked against `getStates()`
 * so a disagreement shows as a flagged node rather than a dead row.
 *
 * `color` is text from a pushed build, and every project on this host shares
 * one origin, so it must never be interpolated into markup: the hub validates
 * it (`_check_color`) and React escapes it, which holds only while nobody builds
 * a style string from it by hand.
 *
 * A row has two names. `id` is the path, the key the library answers to; `key`
 * is the catalogue key in `meta.parts`. They differ when a view shows one part
 * twice: the tessellator names the repeats `pin`, `pin(2)` to keep paths
 * unique, while both carry key `pin` and share files, note and kind. Operations
 * use the path; lookups use the key.
 *
 * Only a leaf gets a key: a group is not a part. `check_view_file` in
 * src/render.py refuses a push whose leaf lacks one.
 *
 * Leaf-or-group: the hub and the library (`isShapeTree`) ask whether the
 * `parts` field exists; this walk asks `Array.isArray(node.parts)`. They differ
 * on `{"key": "lid", "parts": null}`, which stays harmless only because the hub
 * rejects it (`isinstance(parts, list)`). Loosening that check in
 * `check_view_file` would make the library crash on nodes this walk reads keys
 * from.
 *
 * A leaf without a key keeps `null` and is never guessed from its name (names
 * may contain dots, and a fallback would hide the missing key). No key means no
 * link to the catalogue: no files, no note.
 */
export function treeFromShapes(shapes, states) {
  const known = states && typeof states === "object" ? states : null;
  const walk = (node, parent) => {
    const name = typeof node.name === "string" ? node.name : "";
    const path = `${parent}/${name}`;
    const kids = Array.isArray(node.parts) ? node.parts : null;
    const row = {
      id: path,
      name,
      color: typeof node.color === "string" ? node.color : null,
    };
    if (kids) {
      row.children = kids.map((kid) => walk(kid, path));
      return row;
    }
    row.key = typeof node.key === "string" && node.key ? node.key : null;
    // A leaf the library does not know is marked rather than dropped: a missing
    // row reads as a build with fewer parts.
    row.known = known === null || Object.hasOwn(known, path);
    return row;
  };
  return walk(shapes, "");
}

/** Every leaf path the library knows, or an empty object. */
export function statesOf(viewer) {
  try {
    if (viewer && typeof viewer.getStates === "function") return viewer.getStates();
  } catch (error) {
    console.warn("states", error);
  }
  return {};
}

/** Does `path` name this leaf, or an ancestor node of it? */
const covers = (entry, path) => path === entry || path.startsWith(`${entry}/`);

/**
 * Apply the interface's `hidden` list.
 *
 * `getStates`/`setStates` are only visibility (docs/viewer-api.md §4):
 * `[shapeState, edgesState]`, 1 shown and 0 hidden; the `mixed` value 2 is
 * computed for nodes by the library, and written on a leaf it means hidden
 * because `setState` compares strictly against `selected`. Transparency is
 * `applyGhost` below.
 *
 * The list may name a leaf or a whole node; both match by prefix, so the tree's
 * shape is not duplicated in the interface.
 */
export function applyHidden(viewer, hidden) {
  const states = statesOf(viewer);
  const g = internals(viewer);
  const groups = g && g.nestedGroup && g.nestedGroup.groups;
  const list = Array.isArray(hidden) ? hidden : [];
  const next = {};
  let changed = false;
  for (const path of Object.keys(states)) {
    const off = list.some((entry) => covers(entry, path));
    const want = off ? [0, 0] : [1, 1];
    const now = states[path];
    if (!Array.isArray(now) || now[0] !== want[0] || now[1] !== want[1]) {
      changed = true;
    }
    // `setStates` never reaches the outline child, so its visibility is set
    // here, before the early return below: an outline built while its part was
    // hidden would otherwise stay visible.
    const outline = groups ? outlineChild(groups[path]) : null;
    if (outline) outline.visible = !off;
    next[path] = want;
  }
  if (!changed) return;
  try {
    viewer.setStates(next);
  } catch (error) {
    console.warn("hidden", error);
  }
}

/**
 * Apply the interface's `ghost` list — per-part transparency.
 *
 * There is no public API: `viewer.setTransparent` and `setOpacity` are global
 * (docs/viewer-api.md §3). The per-part path is the group itself, safe because
 * `MaterialFactory` gives every face material `transparent: true` from the
 * start, so no shader is rebuilt.
 *
 * The global toggles would overwrite this, so this viewport never calls them.
 * Studio mode shares materials between parts and would leak opacity, which is
 * one reason `studioTool` is off in options.js.
 */
export function applyGhost(viewer, ghost) {
  const g = internals(viewer);
  if (!g || !g.nestedGroup || !g.nestedGroup.groups) return;
  const list = Array.isArray(ghost) ? ghost : [];
  let touched = false;
  for (const [path, group] of Object.entries(g.nestedGroup.groups)) {
    if (!group || typeof group.setTransparent !== "function") continue;
    const on = list.some((entry) => covers(entry, path));
    try {
      // Divided, because the library shows the face at
      // `group.opacity * group.alpha`, and `GHOST_OPACITY` is what that product
      // must be. `Math.min` makes it a ceiling (`min(alpha, GHOST_OPACITY)`), so
      // an already translucent part is not dimmed again (see options.js).
      // `|| 1` avoids dividing by an alpha of 0.
      if (on) group.opacity = Math.min(1, GHOST_OPACITY / (group.alpha || 1));
      group.setTransparent(on);
      // `setTransparent` reaches only the library's face materials; the outline
      // takes the face's opacity, read after the toggle, because the cut face
      // inherits the body's transparency (including the author's alpha).
      const outline = outlineChild(group);
      if (outline) outline.material.opacity = group.front.material.opacity;
      touched = true;
    } catch (error) {
      console.warn("ghost", error);
      return;
    }
  }
  if (touched) viewer.update(true, false);
}

/**
 * Paint the cut faces of the selected parts, and put every other one back.
 *
 * A cap is not in the shader's state texture (it is a quad the library builds
 * per (plane, solid) with no `componentId`), so `selectSolid` does not reach
 * it. Units are matched by group identity (see `capOwnerAt` in picking.js). The
 * tint is read off the library's uniform so it matches the body's; the cap
 * shows it flat, since hatch.js replaces `gl_FragColor` on every cap. Guarded
 * on its own like `safeHatch`: it reaches into private library fields, and a
 * moved one must cost only this tint.
 */
function paintCutFaces(g, list) {
  try {
    const units = g.clipping && g.clipping._capUnits;
    const groups = g.nestedGroup && g.nestedGroup.groups;
    const hl = g.nestedGroup && g.nestedGroup.highlight;
    const uniform = hl && hl.uniforms && hl.uniforms.uHighlightSelectedColor;
    const tint = uniform && uniform.value;
    if (!Array.isArray(units) || !groups || !tint) return;
    const chosen = new Set();
    for (const path of list) if (path && groups[path]) chosen.add(groups[path]);
    for (const unit of units) {
      const caps = unit && unit.capMeshes;
      if (!Array.isArray(caps)) continue;
      const on = chosen.has(unit.solid);
      for (const cap of caps) {
        const material = cap && cap.material;
        if (!material || !material.color) continue;
        // Memoised, not recomputed from the solid's colour, which is the cap's
        // colour only while `clipObjectColors` is on (options.js). It lives on
        // the material, so a scene rebuilt by `show()` starts clean.
        if (!material.userData.capColor) {
          material.userData.capColor = material.color.clone();
        }
        material.color.copy(on ? tint : material.userData.capColor);
      }
    }
  } catch (error) {
    console.warn("cut face tint", error);
  }
}

/**
 * Apply the interface's `selected`.
 *
 * The shader highlight rather than a material change: `HighlightController`
 * owns a texture of per-object states, so nothing per-part needs undoing. It
 * paints faces only (edges keep their colour); the cut face carries no
 * component id and is painted by `paintCutFaces`.
 *
 * `selectSolid` takes the same path key as `getStates`, and only a solid has
 * one. The library's own picking writes the same bit set, which conflicts only
 * while a select tool is armed, and none is at `tools: false`.
 *
 * A list, because one row may stand for several solids (`pin ×5` in the tree,
 * hub.indexTree), and selecting it lights all of them.
 *
 * A bare string is not a selection and selects nothing, so a sender using a
 * wrong shape on `hmr:state` fails visibly.
 */
export function applySelected(viewer, selected) {
  const g = internals(viewer);
  const hl = g && g.nestedGroup && g.nestedGroup.highlight;
  if (!hl) return;
  const list = Array.isArray(selected) ? selected : [];
  try {
    hl.clear();
    for (const path of list) if (path) hl.selectSolid(path, true);
    // BEFORE the re-render, so one frame shows both halves of the selection.
    paintCutFaces(g, list);
    viewer.update(true, false);
  } catch (error) {
    console.warn("select", error);
  }
}

/**
 * Where a part's group sits before anything moved it, remembered on first
 * touch, so a move can be undone without reloading (the library keeps no copy:
 * its group positions are the assembly's own transforms).
 */
function home(vp, path, group) {
  if (!vp.partHome.has(path)) {
    vp.partHome.set(path, [group.position.x, group.position.y, group.position.z]);
  }
  return vp.partHome.get(path);
}

/**
 * Which way a part's group faced before anything turned it, remembered on
 * first touch beside `partHome`.
 *
 * `loc` is a placement, not an offset: a leaf's vertices are the part's own
 * coordinates and `loc` is where the view puts it (see
 * `src/cadbuild/preview_png.py`), an offset in `loc[0]` and a rotation in
 * `loc[1]`. `renderLoop` writes both onto this group
 * (`mesh.position.set(...shape.loc[0])`, `mesh.quaternion.set(...shape.loc[1])`).
 * A part seated by its view (`LID_SEATED` in `model_template/model.py` turns the
 * lid half a turn about x) arrives with a non-identity quaternion, and this is
 * its only copy.
 *
 * So the reader's turn is composed onto it, never written over it, and "put it
 * back" restores it; otherwise a seated part would flip on a plain drag.
 */
function facing(vp, path, group) {
  if (!vp.partFacing.has(path)) {
    vp.partFacing.set(path, [group.quaternion.x, group.quaternion.y,
                             group.quaternion.z, group.quaternion.w]);
  }
  return vp.partFacing.get(path);
}

/** A turn of nothing — what a move with no `turn` on it is read as. */
const NO_TURN = [0, 0, 0];

/**
 * Where a part's group was turned about before anything turned it: the world
 * centre of its box, remembered on first touch beside `partHome`.
 *
 * Memoised because `partCentre` reads `front.matrixWorld`, the current pose: a
 * live read after a turn would answer for the turned part, so two 90° steps
 * would not equal one 180° step and a part turned back and forth would drift.
 *
 * Null is a real answer: a tree node (`CompoundGroup`, put into
 * `nestedGroup.groups` by `renderLoop`) has no tessellation and no centre;
 * `movePart` refuses to turn it and only displaces it.
 */
function pivot(vp, path) {
  if (!vp.partPivot.has(path)) vp.partPivot.set(path, partCentre(vp.viewer, path));
  return vp.partPivot.get(path);
}

/**
 * Where a group has to stand and which way it has to face for its part to be
 * turned by `q` about `centre` and then offset by `delta`, given `base` (the
 * position before anything touched it) and `pose` (the build's orientation).
 *
 * The one copy of this arithmetic: `movePart` and `nudgeTurn` (from a base and
 * pose the caller holds) must agree, or bodies would swing about slightly
 * different points.
 */
function seated(q, base, pose, centre, delta) {
  const back = turned(q, [
    centre[0] - base[0], centre[1] - base[1], centre[2] - base[2],
  ]);
  return {
    position: [centre[0] - back[0] + delta[0],
               centre[1] - back[1] + delta[1],
               centre[2] - back[2] + delta[2]],
    quaternion: after(q, pose),
  };
}

/** The group of one part, if it can be moved at all. */
export function movableGroup(viewer, path) {
  const g = internals(viewer);
  const group = g && g.nestedGroup && g.nestedGroup.groups
    ? g.nestedGroup.groups[path] : null;
  if (!group || !group.position || typeof group.position.set !== "function") {
    return null;
  }
  return group;
}

/**
 * The paths a gesture may take hold of, as `{paths, proposal}`, or null when
 * one of them is not grabbable and the whole grab is refused.
 *
 * Asked every frame by both halves of the manipulator, the arrows and quads
 * (gizmo.js) and the rotation handles (rings.js), so neither offers a move the
 * press would refuse, and both appear under the same conditions.
 *
 * Mixed selections are refused whole: one overlay path makes this a proposal
 * gesture, and then a model part has no body name. The group node the bodies
 * hang under is refused too (`overlayBody` answers null for it).
 *
 * Which tool is in force is the caller's question: both ask it under `move`
 * only (`held` in either file).
 */
export function grabbable(vp, paths) {
  const list = Array.isArray(paths) ? paths : [];
  if (!list.length) return null;
  const proposal = list.some((path) => vp.isOverlay(path));
  const held = (path) => !!movableGroup(vp.viewer, path)
    && (!proposal || !!vp.overlayBody(path));
  return list.every(held) ? { paths: list, proposal } : null;
}

/** Where one part's group stands right now, as `[x, y, z]`, or null.
 *
 * Unlike `home()`, nothing is remembered. Used for a proposal body, whose new
 * position is written into the proposal document and re-staged from it
 * (`nudgePart`); a memo would make the second drag measure from before the
 * first and the body would jump back.
 */
export function groupHome(viewer, path) {
  const group = movableGroup(viewer, path);
  return group ? [group.position.x, group.position.y, group.position.z] : null;
}

/** Which way one part's group faces right now, as `[x, y, z, w]`, or null.
 *
 * The orientation counterpart of `groupHome`: a proposal body's pose comes from
 * the document and is re-staged from it, so it is not memoised like `facing()`.
 */
export function groupFacing(viewer, path) {
  const group = movableGroup(viewer, path);
  return group
    ? [group.quaternion.x, group.quaternion.y, group.quaternion.z,
       group.quaternion.w]
    : null;
}

/**
 * The world-space centre of one part's bounding box, as `[x, y, z]`, or `null`.
 *
 * Where a pin goes when the comment is anchored on the part rather than a
 * coordinate (hub.anchorFor): on a later build the part's box is the only thing
 * that still means "on this part".
 *
 * three.js is not a dependency of this bundle, so the transform is done by hand
 * off `matrixWorld.elements` (column-major, as in `sectionSegments`). The box is
 * the geometry's own, in the solid's local frame; the library computes it at
 * build time, and the call below covers one it has not computed yet.
 */
export function partCentre(viewer, path) {
  const g = internals(viewer);
  const group = g && g.nestedGroup && g.nestedGroup.groups
    ? g.nestedGroup.groups[path] : null;
  const front = group && group.front;
  const geometry = front && front.geometry;
  if (!geometry || !front.matrixWorld || !front.matrixWorld.elements) return null;
  // The matrix is refreshed before it is read (as `cameraBasis` does):
  // `matrixWorld` is composed by a render, and `movePart` writes
  // `group.position`, so until the next frame the matrix is stale. The axis
  // arrows run their own rAF loop and would trail the part by a frame.
  //
  // Asked of the group, not of `front`: `updateMatrixWorld` composes from the
  // parent downwards and never walks up, and `movePart` writes the group's
  // position.
  if (typeof group.updateMatrixWorld === "function") group.updateMatrixWorld();
  try {
    if (!geometry.boundingBox
        && typeof geometry.computeBoundingBox === "function") {
      geometry.computeBoundingBox();
    }
  } catch (error) {
    console.warn("part centre", error);
    return null;
  }
  const box = geometry.boundingBox;
  if (!box || !box.min || !box.max) return null;
  const px = (box.min.x + box.max.x) / 2;
  const py = (box.min.y + box.max.y) / 2;
  const pz = (box.min.z + box.max.z) / 2;
  const e = front.matrixWorld.elements;
  const world = [
    e[0] * px + e[4] * py + e[8] * pz + e[12],
    e[1] * px + e[5] * py + e[9] * pz + e[13],
    e[2] * px + e[6] * py + e[10] * pz + e[14],
  ];
  return finite3(world) ? world : null;
}

/**
 * The top of one part's world-space box, as `[x, y, z]`, or `null`: the box's
 * centre in x and y, and its highest z.
 *
 * Where a comment's arrow goes when the comment is anchored on the part rather
 * than on a point (`partPoint` in element.js). Such an arrow has no normal and
 * stands from above, along the viewer's up axis (`UP` in pins.js, `up: "Z"` in
 * options.js), so from here it stands on or above the part, never inside its
 * box: on a part tilted off the axes the box is taller than the part, and the
 * tip hangs a little over it. From the centre it would be inside any part more
 * than twice its length tall, and the depth test would hide it there.
 *
 * The world box is the box of the eight corners of the geometry's local box,
 * each carried through `matrixWorld`: on a turned part the local box's top face
 * need not be the top in the world. Read as `partCentre` reads it: the group's
 * matrix recomposed first, and a box asked of the geometry if it has none yet.
 */
export function partTop(viewer, path) {
  const g = internals(viewer);
  const group = g && g.nestedGroup && g.nestedGroup.groups
    ? g.nestedGroup.groups[path] : null;
  const front = group && group.front;
  const geometry = front && front.geometry;
  if (!geometry || !front.matrixWorld || !front.matrixWorld.elements) return null;
  if (typeof group.updateMatrixWorld === "function") group.updateMatrixWorld();
  try {
    if (!geometry.boundingBox
        && typeof geometry.computeBoundingBox === "function") {
      geometry.computeBoundingBox();
    }
  } catch (error) {
    console.warn("part top", error);
    return null;
  }
  const box = geometry.boundingBox;
  if (!box || !box.min || !box.max) return null;
  const e = front.matrixWorld.elements;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        const corner = [
          e[0] * x + e[4] * y + e[8] * z + e[12],
          e[1] * x + e[5] * y + e[9] * z + e[13],
          e[2] * x + e[6] * y + e[10] * z + e[14],
        ];
        for (let i = 0; i < 3; i += 1) {
          lo[i] = Math.min(lo[i], corner[i]);
          hi[i] = Math.max(hi[i], corner[i]);
        }
      }
    }
  }
  const top = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[2]];
  return finite3(top) ? top : null;
}

/**
 * The cut contour, rebuilt for solids that have just moved under a standing
 * plane. Every move in this file ends with it (`movePart`, `nudgePart`,
 * `reconcileMoves`).
 *
 * No plane write follows a move, so this drops the memo and redraws. Called
 * outside the caller's `try` and catching its own failures, so it cannot turn a
 * completed move into a refused one.
 *
 * After the caller's render and followed by another: the rebuild reads
 * `matrixWorld`, which only a render refreshes, and the library draws on demand
 * only, so the new contour needs its own frame.
 *
 * Gated on the same pair `reconcile` uses, not on the seed alone:
 * `suspendSectionCut` empties the contours but keeps the seed (so re-enabling
 * needs no second click), so a seed alone does not mean a cut is on screen.
 */
function redrawCut(vp) {
  if (!vp.viewer || !vp.sectionSeed || !vp.state || !vp.state.cut) return;
  try {
    refreshSectionOutline(vp, internals(vp.viewer));
    vp.viewer.update(true, false);
  } catch (error) {
    console.warn("outline", error);
  }
}

/**
 * Offset a part from where the build put it and turn it where it stands.
 * `delta` is world units, `turn` is three degrees (`quaternionOf`).
 *
 * Not a change to the model, and the interface says so: nothing is written,
 * the next rebuild puts the part back, and the offset reaches the agent as part
 * of a sentence.
 *
 * The part turns about its own centre, which needs both placement fields. A
 * leaf's vertices are the part's own coordinates and the group carries the
 * placement: an offset in `position` (`home`) and the build's pose in
 * `quaternion` (`facing`). The group's origin is not the part's centre, so the
 * quaternion alone would swing the part across the scene.
 *
 * With `home` the group's position, `R` the build's pose, `C` the part's world
 * centre and `q` the turn: a vertex `v` lands at `position + Q·v`, and unturned
 * at `home + R·v`. Turning about `C` sends it to
 * `C + q·(home + R·v - C)` = `(C - q·(C - home)) + (q⊗R)·v`, so
 *
 *     position = C - q·(C - home) + delta
 *     quaternion = q ⊗ R
 *
 * `C` is read off `matrixWorld`, so the pose is already in it: `C - home` is
 * `R·c_local`, and the position line needs no second mention of `R`.
 *
 * At a zero turn both collapse to `home + delta` and `R`, so a plain drag never
 * straightens a lid its view seated upside down; `parts.test.js` pins both.
 *
 * A part with no centre (see `pivot`) cannot be turned, and the whole gesture
 * is refused; displacing it still works, since the centre cancels at a zero
 * turn.
 *
 * Several paths take one delta and one turn: a row collapsing five copies
 * (hub.indexTree) moves as one, each instance from its own home and about its
 * own centre, which is why the memos are per path.
 *
 * All or nothing up to the pre-check: one immovable path refuses the gesture
 * before anything moves. Past it the loop is not atomic: a throwing
 * `position.set` on the third path leaves the first two moved and recorded in
 * `vp.moved`, returns `false` and unwinds nothing. `reconcileMoves` recovers by
 * putting back every path in `vp.moved` the document does not claim.
 */
export function movePart(vp, paths, delta, turn) {
  const list = Array.isArray(paths) ? paths : [];
  const spin = Array.isArray(turn) ? turn : NO_TURN;
  if (!list.length || !finite3(delta) || !finite3(spin)) return false;
  const groups = list.map((path) => movableGroup(vp.viewer, path));
  if (groups.some((group) => !group)) return false;
  // Before anything moves (see `pivot`): the centre is read off the current
  // matrix, and by the second path of a row the first is already written.
  const centres = list.map((path) => pivot(vp, path));
  const q = quaternionOf(spin);
  if (spin.some((angle) => angle !== 0) && centres.some((centre) => !centre)) {
    return false;
  }
  try {
    list.forEach((path, at) => {
      const base = home(vp, path, groups[at]);
      const pose = facing(vp, path, groups[at]);
      // `base` where no centre exists, which the check above allows only for
      // a zero turn, where the pivot cancels out.
      const centre = centres[at] || base;
      const seat = seated(q, base, pose, centre, delta);
      groups[at].position.set(...seat.position);
      groups[at].quaternion.set(...seat.quaternion);
      vp.moved.set(path, { delta, turn: spin });
    });
    vp.viewer.update(true, false);
  } catch (error) {
    console.warn("move", error);
    return false;
  }
  // The contour the part carried off the plane. Outside the `try` and after
  // the render, see `redrawCut`.
  redrawCut(vp);
  return true;
}

/**
 * Offset a group from a home the caller holds, remembering nothing.
 *
 * `movePart` for a body that is in no build, one the proposal panel staged over
 * the model (`staged()` in element.js).
 *
 * Nothing is written into `vp.moved`: it is re-applied after every re-stage
 * (`restageMoves`), and the panel re-stages on the next keystroke, so a recorded
 * delta would be added on top of the document's new position. The drag is live
 * feedback only: the release reports it, the panel moves the node's `at`, and
 * the next stage puts the body there.
 *
 * Nothing is written into `vp.partHome` either: the document says where the
 * body goes. The caller reads the home at the press (`groupHome`) and holds it
 * for the gesture.
 *
 * A staged body is an ordinary solid the plane clips, so this also ends in
 * `redrawCut`.
 *
 * All or nothing up to the pre-check, not atomic past it (see `movePart`).
 */
export function nudgePart(vp, paths, homes, delta) {
  const list = Array.isArray(paths) ? paths : [];
  if (!list.length || !finite3(delta)) return false;
  const groups = list.map((path) => movableGroup(vp.viewer, path));
  if (groups.some((group) => !group)) return false;
  try {
    groups.forEach((group, at) => {
      const base = homes[at];
      group.position.set(
        base[0] + delta[0], base[1] + delta[1], base[2] + delta[2]);
    });
    vp.viewer.update(true, false);
  } catch (error) {
    console.warn("nudge", error);
    return false;
  }
  redrawCut(vp);
  return true;
}

/**
 * Turn a group about a centre the caller holds, remembering nothing.
 *
 * The rotation counterpart of `nudgePart`, for a body the proposal staged: no
 * writes to `vp.moved`, `vp.partHome`, `vp.partPivot` or `vp.partFacing`. The
 * re-stage after release really turns it; this is live feedback.
 *
 * `seats` is one `{home, pose, centre}` record per path, all taken at the press,
 * so a caller cannot misalign poses and homes across a row of copies.
 *
 * No `delta`: this gesture only turns, and the home is read fresh at every
 * press, so there is no standing displacement to preserve.
 *
 * `centre` is the body's own origin, not its box centre, because the preview
 * must show the document's rotation: `placed` in ui/src/proposalgeom.js rotates
 * a body in its own coordinates and then carries it to `at`, so `at` is the
 * point a change of `rot` keeps fixed. The box centre differs for any op not
 * centred on its origin (an extrusion's box centre sits at `h/2`, so a quarter
 * turn about it would move the body by `sqrt(2)·h/2`). The origin comes from the
 * panel's payload (`bodyOrigin` in viewport/rings.js).
 */
export function nudgeTurn(vp, paths, seats, turn) {
  const list = Array.isArray(paths) ? paths : [];
  const spin = Array.isArray(turn) ? turn : NO_TURN;
  if (!list.length || !finite3(spin)) return false;
  const groups = list.map((path) => movableGroup(vp.viewer, path));
  if (groups.some((group) => !group)) return false;
  // All three or the gesture is refused, as in `movePart`: a body turned about
  // the wrong point is worse than one that did not turn.
  const held = Array.isArray(seats) ? seats : [];
  if (held.length !== list.length
      || held.some((seat) => !seat || !finite3(seat.home) || !finite3(seat.centre)
                   || !Array.isArray(seat.pose) || seat.pose.length !== 4)) {
    return false;
  }
  const q = quaternionOf(spin);
  try {
    groups.forEach((group, at) => {
      // Zero offset: this gesture turns and does not slide.
      const seat = seated(q, held[at].home, held[at].pose, held[at].centre,
                          [0, 0, 0]);
      group.position.set(...seat.position);
      group.quaternion.set(...seat.quaternion);
    });
    vp.viewer.update(true, false);
  } catch (error) {
    console.warn("nudge turn", error);
    return false;
  }
  // The contour the body carried round under the plane (see `nudgePart`).
  redrawCut(vp);
  return true;
}

/**
 * Put every moved part back where the reader left it, on groups just rebuilt.
 *
 * The map of offsets survives a re-stage (viewport/element.js), but the
 * ObjectGroups do not: `clear()` disposed them and `render()` rebuilt them at
 * the model's positions. Without this, a displaced part would silently stand
 * where the build puts it.
 *
 * The homes are forgotten and read again from the new groups, which stays true
 * even if the re-rendered positions ever differ.
 *
 * A path the scene no longer has is dropped: `movePart` refuses it and it is not
 * written back into `vp.moved`.
 */
export function restageMoves(vp) {
  if (!vp.moved.size) return;
  const offsets = [...vp.moved.entries()];
  vp.moved.clear();
  vp.partHome.clear();
  // Centres and poses go with the homes: they were read off the old groups as
  // they stood (displaced and turned), and reusing them would compound the turn.
  vp.partPivot.clear();
  vp.partFacing.clear();
  // One call per path: each copy of a part in a row has its own entry.
  for (const [path, stood] of offsets) {
    movePart(vp, [path], stood.delta, stood.turn);
  }
}

/**
 * Make the scene's offsets match the document: `wanted` is all of it, as
 * `{paths, delta, turn}` entries.
 *
 * The document is the source of truth. A drag is recorded as a node of the
 * proposal (ui/src/proposal.js), the interface hands back the whole set, and a
 * part goes home because its entry was deleted. Only the whole list answers
 * "which parts are displaced", hence the set rather than one move.
 *
 * `keep` holds every path the list still claims, so the put-back loop skips an
 * entry whose delta merely changed; the two loops are independent.
 *
 * A delta already standing is skipped, so the interface may push the document
 * on every change: the drag's own echo (`reportModelMove` in tools.js, then the
 * document coming straight back) costs no extra write, render or contour
 * rebuild. That is safe because `vp.moved` records what was written, never what
 * was asked: `movePart` records a path only after setting its group, and
 * `restageMoves` re-applies the map onto rebuilt groups.
 */
export function reconcileMoves(vp, wanted) {
  const list = Array.isArray(wanted) ? wanted : [];
  const keep = new Set();
  for (const move of list) for (const path of move.paths) keep.add(path);
  const spin = (move) => (Array.isArray(move.turn) ? move.turn : NO_TURN);
  // Both halves or it is not standing: a part at this offset but turned
  // differently does not match the list yet.
  const standing = (path, delta, turn) => {
    const now = vp.moved.get(path);
    return !!now && delta.every((value, axis) => value === now.delta[axis])
      && turn.every((angle, axis) => angle === now.turn[axis]);
  };

  let home = false;
  for (const path of [...vp.moved.keys()]) {
    if (keep.has(path)) continue;
    const group = movableGroup(vp.viewer, path);
    const base = vp.partHome.get(path);
    // Written as a pair by `movePart` and cleared as a pair by `restageMoves`,
    // so they are read as a pair.
    const pose = vp.partFacing.get(path);
    // Off the map before the attempt, so a missing path or a throwing
    // `position.set` does not leave a recorded offset nothing stands at
    // (`measure.js` would keep calling the view laid out, and every reconcile
    // would retry the failing write).
    vp.moved.delete(path);
    if (!group || !base || !pose) continue;
    try {
      group.position.set(base[0], base[1], base[2]);
      // The turn comes off with the offset: the deleted node said both. Back to
      // the build's pose, not the identity, since the group's quaternion holds
      // the view's `loc[1]` (a seated lid stands at a half turn).
      group.quaternion.set(pose[0], pose[1], pose[2], pose[3]);
      home = true;
    } catch (error) {
      console.warn("move reset", error);
    }
  }
  if (home && vp.viewer) vp.viewer.update(true, false);

  // One call per entry: a row standing for several copies moves all of them by
  // one offset, each from its own home.
  for (const move of list) {
    const turn = spin(move);
    if (move.paths.every((path) => standing(path, move.delta, turn))) continue;
    movePart(vp, move.paths, move.delta, turn);
  }

  // Contours for parts that went home (`movePart` handles the loop above).
  // After the render, and gated inside on a cut actually on screen.
  if (home) redrawCut(vp);
}
