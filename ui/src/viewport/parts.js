// Everything the interface does to a PART rather than to the camera: hide it,
// ghost it, select it, drag it, and — before any of that — hand the interface
// the tree it draws (ui-brief block 3).

import { internals } from "./internals.js";
import { after, anglesOf, finite3, quaternionOf, turned } from "./math.js";
import { GHOST_OPACITY } from "./options.js";
import { outlineChild, refreshSectionOutline } from "./outline.js";

// RE-EXPORTED RATHER THAN MOVED OUT OF SIGHT. The four are pure arithmetic and
// now live in `math.js`, because `ui/src/proposal.js` needs them and must not
// reach the viewer: this file imports `internals.js` and `outline.js`, so an
// import from here would drag the whole viewport behind a module whose promise
// is that a document can be built and projected with no browser near it. The
// re-export is kept because a turn is still this file's subject, and the tests
// take them from here for that reason (`parts.test.js` all four, `rings.test.js`
// three); the modules of `ui/src` import them from `math.js` directly.
export { after, anglesOf, quaternionOf, turned };

/**
 * The part tree, built from the VIEW FILE rather than from the library.
 *
 * Two sources were available and they answer different questions.
 * `viewer.getStates()` is a flat map of leaf paths, which is the right key for
 * everything else here but carries neither nesting nor colour; the pushed view
 * file is `{name, color, parts: [...]}` all the way down (src/render.py validates
 * exactly that shape), so it carries both. The paths are built the same way the
 * library builds them — parent path plus `/name` — and the leaves are checked
 * against `getStates()` afterwards, so a disagreement shows up as a flagged node
 * instead of a row that silently does nothing when clicked.
 *
 * `color` travels as TEXT and is handed to the interface as text. It came out of
 * a pushed build, and every project on this host shares one origin, so it must
 * never be interpolated into markup — the hub validates it (`_check_color`) and
 * React escapes it, and both of those hold only as long as nobody builds a style
 * string out of it by hand.
 *
 * A ROW CARRIES TWO NAMES AND THEY ARE NOT THE SAME THING (issue #75). `id` is
 * the PATH — parent path plus `/name`, the key the vendored library answers to
 * — and `key` is the CATALOGUE key, the identity of the part in
 * `meta.parts`. They differ wherever a view shows one part twice: the
 * tessellator tells the repeats apart by name (`pin`, `pin(2)`) so that the
 * paths stay unique, while both leaves carry the key `pin` and therefore the
 * same files, the same note and the same kind. Every operation here is on the
 * path; everything the interface looks UP is by the key.
 *
 * ONLY A LEAF GETS ONE, and that is a rule rather than an accident of the
 * fixture: a leaf is one part and a group is not a part at all, so a group with
 * a `key` on it would be a hand-made push making an assembly answer for a
 * catalogue record. Every leaf on a document that came through the front door
 * carries one, because `check_view_file` in src/render.py refuses a push whose
 * leaf does not.
 *
 * THREE SIDES DECIDE LEAF-OR-GROUP AND THIS ONE ASKS A DIFFERENT QUESTION. The
 * hub asks whether the FIELD IS THERE (`"parts" in node`, check_view_file); the
 * vendored library asks the same (`isShapeTree`: `return "parts" in shape`);
 * this walk asks the TYPE OF THE VALUE, `Array.isArray(node.parts)`. On one
 * node they part company — `{"key": "lid", "parts": null}` is a group to the
 * other two and a leaf here, so this walk would take a key off a node they
 * would descend into, and the library would run `for (const shape of
 * shapes.parts)` over a null.
 *
 * WHAT KEEPS THAT HARMLESS IS THE REFUSAL ON THE RECEIVING SIDE, not any
 * agreement between the rules: the hub reads that node as a group and then
 * throws it out on `isinstance(parts, list)`, so no build carrying one is ever
 * served. Whoever loosens that refusal — asking `is None` in place of `in`,
 * which is exactly the edit `check_view_file` argues against by name — brings
 * the divergence back to life, and this walk starts reading keys off nodes the
 * viewer is meanwhile crashing on.
 *
 * A LEAF WITHOUT ONE KEEPS `null` AND IS NEVER GUESSED AT. The old viewer
 * reconstructed a part's identity by comparing strings — the stem of a filename
 * against the name on the row — and got it wrong on any part with a dot in its
 * name; falling back to `name` here would put that back, and worse, because the
 * key now exists and the fallback would hide its absence. No key means the row
 * has no link to the catalogue: no files, no note, nothing.
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
    // A leaf the library does not know is a leaf nothing can be done to. Said
    // out loud rather than dropped: a tree missing a row reads as a build with
    // fewer parts, while a row marked unknown reads as what it is.
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
 * `getStates`/`setStates` are ONLY visibility (docs/viewer-api.md §4):
 * `[shapeState, edgesState]`, 1 shown and 0 hidden, and the `mixed` value 2 is
 * computed for nodes by the library itself — writing it on a leaf means hidden,
 * because `setState` compares strictly against `selected`. Transparency is not
 * in here at all; that is `applyGhost` below, on a different mechanism.
 *
 * The list may name a leaf or a whole node, and both work by prefix: hiding an
 * aggregate is what ui-brief block 3 is about, and the alternative — expanding
 * a node to its leaves in the interface — would put the tree's shape in two
 * places.
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
    // `setStates` reaches the library's own materials, never the outline
    // child, so its visibility is carried here in the same pass — and BEFORE
    // the early return below: an outline built while its part was hidden
    // would otherwise stay visible until the states themselves moved again.
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
 * There is no public API for this: `viewer.setTransparent` and `setOpacity` are
 * GLOBAL, they traverse every group (docs/viewer-api.md §3). The per-part path
 * is the group itself, and it is safe because `MaterialFactory` gives every face
 * material `transparent: true` from the start, so no shader is rebuilt.
 *
 * Two limits come with it, both from that same section. The global toggles would
 * overwrite this, so this viewport never calls them. And Studio mode SHARES
 * materials between parts, which would leak one part's opacity onto every part
 * with the same material — which is the second reason `studioTool` is off in
 * options.js, beyond the size of its postprocessing composer.
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
      // DIVIDED, because this field is a MULTIPLIER: the library shows the face
      // at `group.opacity * group.alpha`, so the product is what a reader sees
      // and `GHOST_OPACITY` is the value that product has to come out as.
      // `Math.min` makes it a CEILING — `opacity * alpha` lands on
      // `Math.min(alpha, GHOST_OPACITY)` — so a part the author already
      // published translucent is left where it is instead of being halved a
      // second time. Both decisions are argued in options.js. `|| 1` is for an
      // alpha of 0, which is not a number this can be divided by.
      if (on) group.opacity = Math.min(1, GHOST_OPACITY / (group.alpha || 1));
      group.setTransparent(on);
      // `setTransparent` reaches only the library's own face materials; the
      // outline rides along at the FACE'S opacity — read after the toggle, by
      // then the library has ghosted or restored it — because the cut face
      // inherits the body's transparency and the contour is that face's edge.
      // Reading a constant here instead would ghost a part with `alpha < 1` to
      // the ghost value flat, ignoring the alpha the author published it at,
      // and restore it to fully opaque over its translucent body.
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
 * Paint the CUT FACES of the selected parts, and put every other one back.
 *
 * A CAP IS NOT IN THE SHADER'S STATE TEXTURE — it is a quad the library
 * synthesises per (plane, solid) and carries no `componentId` — so `selectSolid`
 * leaves it exactly as it was, and the selection used to stop at the cut. Units
 * are matched BY GROUP IDENTITY for the reason `capOwnerAt` gives in picking.js.
 * The tint is read off the library's own uniform so it cannot drift from the
 * body's; the two are NOT shaded alike, because hatch.js replaces `gl_FragColor`
 * on every cap and the cut face therefore carries this colour flat while the
 * body's is lit. Its own guard, like `safeHatch`'s: every line here reaches into
 * a private field of the library, and one that has moved must cost this tint and
 * nothing else — the highlight on the body, and the re-render that shows it,
 * belong to the caller.
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
        // MEMOISED, not recomputed from the solid's colour: that is only the
        // cap's answer while `clipObjectColors` is on (options.js). It rides the
        // material, so a scene rebuilt by `show()` starts clean and is repainted
        // there — `applied.selected` is reset in the same pass.
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
 * The shader highlight rather than a material change: `HighlightController` owns
 * a texture of per-object states, so nothing per-part is touched and nothing has
 * to be undone. It paints FACES only — deliberate on the library's side, edges
 * keep their own colour. The one surface it cannot reach is the CUT FACE, which
 * carries no component id and is painted by hand beside it; see `paintCutFaces`.
 *
 * `selectSolid` takes the same path key as `getStates`, and only a solid has
 * one; anything else needs the id-level API, which is not what a part selection
 * is. The library's own picking writes into the same bit set, which is a
 * conflict only while a select tool is armed — and none is, at `tools: false`.
 *
 * A LIST, because a row may stand for several solids: five copies of one part
 * collapse into `pin ×5` in the tree (hub.indexTree), and selecting that row
 * lights up all five. One highlight per path, into the one texture `clear()`
 * just reset.
 *
 * A BARE STRING IS NOT A SELECTION and selects nothing — deliberately, rather
 * than being taken as a list of one. This reads what arrives on `hmr:state`, so
 * a sender still on the old shape has to fail visibly here; accepting it would
 * leave four of the five pins dark with nothing anywhere saying why.
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
 * Where a part's group sits before anything moved it, remembered on first touch.
 *
 * Needed because "put it back" (ui-brief block 6: there must be a way to undo a
 * move without reloading) has to know where back IS, and the library does not
 * keep a copy — its group positions are the assembly's own transforms.
 */
function home(vp, path, group) {
  if (!vp.partHome.has(path)) {
    vp.partHome.set(path, [group.position.x, group.position.y, group.position.z]);
  }
  return vp.partHome.get(path);
}

/**
 * Which way a part's group FACED before anything turned it, remembered on first
 * touch beside `partHome`.
 *
 * BECAUSE `loc` IS A PLACEMENT AND NOT AN OFFSET. A leaf's vertices are the
 * part's OWN coordinates and its `loc` is where the view puts it
 * (`src/cadbuild/preview_png.py` says so in as many words) — an offset in
 * `loc[0]` and a ROTATION in `loc[1]` — and the library writes both onto this
 * very group: `renderLoop` does `mesh.position.set(...shape.loc[0])` and
 * `mesh.quaternion.set(...shape.loc[1])` on the ObjectGroup it then files under
 * `groups[entry.id]`. A part seated by its view — `LID_SEATED` in
 * `model_template/model.py` turns the lid a half turn about x before dropping it
 * on the rim — therefore arrives here standing at a quaternion that is not the
 * identity, and that quaternion is the only copy of it there is.
 *
 * SO THE READER'S TURN IS COMPOSED ONTO THIS AND NEVER WRITTEN OVER IT, and
 * "put it back" restores it. Overwritten, a part with a seated pose would flip
 * out of it on a drag that asked for no rotation at all.
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
 * Where a part's group was TURNED ABOUT before anything turned it: the world
 * centre of its box, remembered on first touch beside `partHome`.
 *
 * MEMOISED FOR THE REASON THE HOME IS, and it is the one thing in here that
 * cannot be read live. `partCentre` computes the centre off `front.matrixWorld`,
 * which is the matrix the part is standing at right now — so read again after a
 * turn it answers about the TURNED part, and the next turn would be taken about
 * that new point. Two 90° steps would then not be one 180° step, and a part
 * turned back and forth would walk away across the scene.
 *
 * NULL IS A REAL ANSWER and it is left as one. A node of the tree is in
 * `nestedGroup.groups` too (`renderLoop` puts a `CompoundGroup` there) and it
 * carries no tessellation, so it has no box and no centre; `movePart` refuses to
 * TURN such a thing and goes on displacing it exactly as it always has.
 */
function pivot(vp, path) {
  if (!vp.partPivot.has(path)) vp.partPivot.set(path, partCentre(vp.viewer, path));
  return vp.partPivot.get(path);
}

/**
 * Where a group has to STAND and which way it has to FACE for its part to be
 * turned by `q` about `centre` and then offset by `delta` — given `base`, the
 * position the group had before anything touched it, and `pose`, the
 * orientation the build gave it.
 *
 * THE ONE COPY OF THE ARITHMETIC, and that is the whole reason it is a function
 * of five arguments rather than six lines inside the loop that needed it first.
 * `movePart` below derives it in full; `nudgeTurn` beside it has to reach the
 * same answer for a body the document places, from a base and a pose the CALLER
 * is holding instead of from the memos. Two hand-written copies of a line like
 * `centre - q·(centre - base)` would not fail — they would drift, and the
 * symptom is a body that swings about a point half a millimetre from the one
 * the part beside it turns about.
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
 * The paths a gesture may take hold of, as `{paths, proposal}` — or null when
 * one of them is not grabbable and the whole grab is therefore refused.
 *
 * THE ONE QUESTION BOTH HALVES OF THE MANIPULATOR ASK — the arrows and quads
 * (gizmo.js) and the rotation handles (rings.js) — every frame, of what is
 * selected, because a widget offering a move that the press would then refuse
 * is a promise it cannot keep. Two halves of ONE widget that came up on
 * different conditions would be a widget with a piece missing.
 *
 * MIXED SELECTIONS ARE REFUSED WHOLE by the `some` and then `every` below,
 * rather than quietly moving the half that may: one overlay path makes this a
 * proposal gesture, and then a part of the model has no body name and is not
 * grabbable into it. There is no such thing as half of either statement. The
 * group node the bodies hang under is refused by the same line — `overlayBody`
 * answers null for it — so a body the panel cannot NAME is a body no report
 * could be about.
 *
 * WHAT IS NOT ASKED HERE IS WHICH TOOL IS IN FORCE, which is the caller's own
 * half of the question: both halves of the manipulator ask it under `move` and
 * nowhere else (`held` in either file).
 */
export function grabbable(vp, paths) {
  const list = Array.isArray(paths) ? paths : [];
  if (!list.length) return null;
  const proposal = list.some((path) => vp.isOverlay(path));
  const held = (path) => !!movableGroup(vp.viewer, path)
    && (!proposal || !!vp.overlayBody(path));
  return list.every(held) ? { paths: list, proposal } : null;
}

/** Where one part's group stands RIGHT NOW, as `[x, y, z]`, or null.
 *
 * `home()` above with nothing remembered, and the difference is the whole of why
 * it exists. That one memoises into `vp.partHome`, because "put it back"
 * (ui-brief block 6) has to know where back is; this one is read by the gesture
 * that has nothing to put back — a proposal body, whose new position is written
 * into the PROPOSAL DOCUMENT and staged again out of it (`nudgePart`).
 * Remembered, the second drag of a body would measure from where it stood before
 * the first, and the body would jump back the whole of that delta the moment the
 * pointer moved.
 */
export function groupHome(viewer, path) {
  const group = movableGroup(viewer, path);
  return group ? [group.position.x, group.position.y, group.position.z] : null;
}

/** Which way one part's group FACES right now, as `[x, y, z, w]`, or null.
 *
 * `groupHome` above for the other half of a placement, and it exists for that
 * function's reason read one field over: `facing()` memoises into
 * `vp.partFacing` because "put it back" has to know which way back WAS, and the
 * gesture that turns a body of the proposal has nothing to put back — the
 * document says which way the body faces, and it is re-staged out of it. A pose
 * remembered across a re-stage is a pose that has moved.
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
 * Where a pin goes when the comment is anchored on the PART and not on a
 * coordinate (hub.anchorFor): the point a comment stored is a place in the
 * tessellation it was taken on, and on a later build the part's own box is the
 * only thing that still means "on this part".
 *
 * THREE.JS IS NOT A DEPENDENCY OF THIS BUNDLE, so the transform is done by hand
 * off `matrixWorld.elements` — the same column-major arithmetic `sectionSegments`
 * does on a segment list, applied to one point. The box is the geometry's own,
 * in the solid's local frame; the library computes it at build time, and the
 * call below covers a geometry it has not needed one for yet.
 */
export function partCentre(viewer, path) {
  const g = internals(viewer);
  const group = g && g.nestedGroup && g.nestedGroup.groups
    ? g.nestedGroup.groups[path] : null;
  const front = group && group.front;
  const geometry = front && front.geometry;
  if (!geometry || !front.matrixWorld || !front.matrixWorld.elements) return null;
  // THE MATRIX IS REFRESHED BEFORE IT IS READ, exactly as `cameraBasis` refreshes
  // the camera's and for the same one-line reason: `matrixWorld` is composed by a
  // RENDER, and `movePart` moves a part by writing `group.position` — so between
  // that write and the next frame the matrix still describes where the part was.
  // The axis arrows stand on this point and run a rAF loop of their OWN, which is
  // not the library's: without this they read the stale matrix whenever their
  // frame beats the render, and trail the part across the screen by one frame.
  //
  // ASKED OF THE GROUP AND NOT OF `front`, which is the whole of getting it
  // right. `updateMatrixWorld` composes an object's world matrix out of its
  // PARENT's and then walks down; it never walks up. `movePart` writes the
  // GROUP's position, so asking the child would multiply the child's own
  // unchanged matrix by a parent matrix nobody had recomposed — the stale answer
  // again, one level up. From the group it cascades into `front` on the way down.
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
 * The cut contour, rebuilt for solids that have just moved under a standing
 * plane. THE TAIL EVERY MOVE IN THIS FILE ENDS IN.
 *
 * A moved solid cuts differently through the plane, and no plane write follows
 * to rebuild for it: drop the memo and redraw here. Called OUTSIDE the caller's
 * `try` and catching its own failures, so a decoration can neither report a move
 * that happened as refused nor throw one away.
 *
 * AFTER THE CALLER'S RENDER AND FOLLOWED BY ANOTHER ONE, which is the whole
 * shape of this. The rebuild reads `matrixWorld`, and only a render refreshes
 * it, so it cannot come first; and the library draws on demand only, so a
 * rebuild after the last draw would sit in memory while the screen kept the
 * contour the solid carried off the plane with it.
 *
 * GATED ON THE PAIR `reconcile` ITSELF USES, and on the pair rather than on the
 * seed alone: `suspendSectionCut` parks the plane and empties the contours but
 * deliberately KEEPS the seed, so that turning the cut back on needs no second
 * click — which means a seed says "a cut was placed once", not "a cut is on
 * screen". Reading a part around with the cut switched off is an ordinary thing
 * to do, and on the seed alone every snap step of it paid for a walk over every
 * solid and a second identical frame, to write emptiness into geometries that
 * were already empty.
 *
 * ONE COPY FOR THREE CALLERS — `movePart`, `nudgePart` and `reconcileMoves` —
 * and that is what it is for. A proposal body is a solid like any other and cuts
 * like one; three hand-written copies of this tail is how one of them ends up
 * without it, which is a contour left hanging beside the body it belongs to.
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
 * NOT a change to the model, and the interface has to say so (ui-brief block 6):
 * nothing is written anywhere, the next rebuild puts the part back, and the
 * offset travels to the agent as part of a sentence rather than as a result.
 *
 * THE PART TURNS ABOUT ITS OWN CENTRE, and that is what takes BOTH of the
 * group's placement fields rather than the quaternion alone. A leaf's vertices
 * are the part's OWN coordinates and its `loc` is where the view puts it, so the
 * group carries the whole placement: an offset in `position` (`home`) and the
 * build's own pose in `quaternion` (`facing`, which says where both come from).
 * The group's origin is therefore not the part's centre — `quaternion` on its
 * own would swing it about a point somewhere else entirely and throw it across
 * the scene.
 *
 * With `home` the group's position, `R` the pose the build gave it, `C` the
 * part's world centre and `q` the turn asked for: a vertex `v` in the part's own
 * coordinates lands at `position + Q·v` for whatever `Q` the group faces at, and
 * unturned it lands at `home + R·v`. Turning the part about `C` has to send that
 * world point to `C + q·(home + R·v - C)` = `(C - q·(C - home)) + (q⊗R)·v`.
 * Matching the two:
 *
 *     position = C - q·(C - home) + delta
 *     quaternion = q ⊗ R
 *
 * ONLY THE ORIENTATION IS COMPOSED; THE POSITION LINE IS THE SAME LINE. `C` is
 * the world centre — read off `matrixWorld`, so the build's pose is already in
 * it — and `C - home` is the vector from the group's origin to it in WORLD
 * terms, which is `R·c_local`. So `C - q·(C - home)` is identically
 * `C - (q⊗R)·c_local`: the pose enters the position through `C` and needs no
 * second mention.
 *
 * AT A TURN OF NOTHING BOTH COLLAPSE — `q` is the identity, `q·(C - home)` is
 * `C - home`, the position falls back to `home + delta`, and `q ⊗ R` is `R`, the
 * pose the build gave the part. That is exactly what this function did before it
 * could turn anything, which is the point: a drag that asks for no rotation must
 * not straighten a lid its view seated upside down. One path and not two, so the
 * displacement everything else depends on cannot drift away from the turn's
 * arithmetic; `parts.test.js` pins both halves of the collapse.
 *
 * A PART WHOSE CENTRE THE SCENE CANNOT GIVE IS NOT TURNED AT ALL, and the whole
 * gesture is refused rather than taken about some other point — see `pivot`,
 * whose null is a tree node with no tessellation under it. Displacing one goes
 * on working, because at a turn of nothing the centre never enters the line.
 *
 * SEVERAL PATHS, ONE DELTA AND ONE TURN: a row that collapsed five copies of one
 * part (hub.indexTree) moves as one thing, so every instance takes the same
 * offset from its OWN home and the same turn about its OWN centre — which is why
 * both memos are per path and not per row.
 *
 * ALL OR NOTHING, AS FAR AS THE PRE-CHECK REACHES. One path that cannot be
 * moved refuses the whole gesture before anything has moved, because half a row
 * moved is two copies of one part standing in different places under a single
 * node that calls it a move of `pin ×5`. On a single path that is exactly what
 * this always did.
 *
 * PAST THAT CHECK IT IS NOT ATOMIC, and the limit is worth naming rather than
 * implying: the loop below writes one group at a time, so a `position.set` that
 * throws on the third path leaves the first two displaced and recorded in
 * `vp.moved`. The answer is `false` and no unwinding. What that leaves is a
 * scene out of step with the row, not a scene nothing can fix —
 * `reconcileMoves` walks exactly the paths `vp.moved` holds and puts back every
 * one the document does not claim, from `partHome`, and that recovery is what
 * this leans on instead.
 */
export function movePart(vp, paths, delta, turn) {
  const list = Array.isArray(paths) ? paths : [];
  const spin = Array.isArray(turn) ? turn : NO_TURN;
  if (!list.length || !finite3(delta) || !finite3(spin)) return false;
  const groups = list.map((path) => movableGroup(vp.viewer, path));
  if (groups.some((group) => !group)) return false;
  // BEFORE ANYTHING MOVES, for the reason `pivot` memoises at all: the centre is
  // read off the matrix the part is standing at, and by the second path of a row
  // the first one has already been written.
  const centres = list.map((path) => pivot(vp, path));
  const q = quaternionOf(spin);
  if (spin.some((angle) => angle !== 0) && centres.some((centre) => !centre)) {
    return false;
  }
  try {
    list.forEach((path, at) => {
      const base = home(vp, path, groups[at]);
      const pose = facing(vp, path, groups[at]);
      // `base` where the scene can name no centre, which the refusal above has
      // already narrowed to a turn of nothing — and at a turn of nothing the
      // pivot cancels out of the line below whatever it is.
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
  // The contour the part carried off the plane with it. Outside the `try` and
  // after the render above, both of which `redrawCut` argues.
  redrawCut(vp);
  return true;
}

/**
 * Offset a group from a home THE CALLER HOLDS, remembering nothing at all.
 *
 * `movePart` for a body that is in no build — one the proposal panel staged over
 * the model (`staged()` in element.js) — and every difference between the two is
 * a thing this one must NOT do.
 *
 * NOTHING IS WRITTEN INTO `vp.moved`, and that map is the reason this function
 * exists rather than a flag on the one above. It is re-applied after every
 * re-stage (`restageMoves`), and the panel re-stages on the very next keystroke:
 * a delta recorded there would be added on top of the position the proposal
 * document now carries, and the body would walk away by twice the distance. The
 * drag is LIVE FEEDBACK only — the release reports it to the panel, the panel
 * moves the node's `at`, and the stage that follows is what really puts the body
 * there.
 *
 * NOTHING IS WRITTEN INTO `vp.partHome` EITHER, for the same reason read from
 * the other end: there is nothing to put back, because the document is what says
 * where the body goes, and a home remembered across a re-stage is a home that has
 * moved. The caller reads the home at the press (`groupHome`) and holds it for
 * the length of the gesture, which is exactly as long as it means anything.
 *
 * THE CUT CONTOUR IS NOT ONE OF THE DIFFERENCES, and it is the one that looks
 * like it might be: a staged body is an ordinary solid, the plane clips it like
 * any other, and a contour is drawn on it. So this ends in the same `redrawCut`
 * the two moves either side of it end in — a body dragged out from under the
 * plane with its curve left hanging behind would be exactly the failure
 * `outline.test.js` pins for a part of the model.
 *
 * ALL OR NOTHING, as far as the pre-check reaches, and not atomic past it —
 * `movePart` says why both halves of that are what they are.
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
 * Turn a group about a centre THE CALLER HOLDS, remembering nothing at all.
 *
 * `nudgePart` above for the other half of a placement, and every word of that
 * function's argument applies here unchanged: this is for a body the PROPOSAL
 * staged over the model, so nothing may be written into `vp.moved`, into
 * `vp.partHome`, into `vp.partPivot` or into `vp.partFacing`. The document says
 * which way the body faces and the re-stage that follows the release is what
 * really turns it; this is live feedback and nothing else.
 *
 * `seats` IS ONE RECORD PER PATH — `{home, pose, centre}`, all three taken at
 * the press and held for the length of the gesture. Three parallel arrays would
 * have been `nudgePart`'s spelling, and one array of three-field records is
 * what keeps a caller from lining up the wrong pose against the wrong home on a
 * row of five copies.
 *
 * NO `delta`, AND THAT IS NOT A SIMPLIFICATION. This gesture turns and does not
 * slide, so the offset it passes on to `seated` is zero — and a body's home is
 * read fresh at every press, so there is no standing displacement to preserve
 * either. A body that was dragged a moment ago is already at its new `at` in
 * the document, and `home` is where that put it.
 *
 * `centre` IS THE BODY'S OWN ORIGIN AND NOT THE CENTRE OF ITS BOX, because the
 * preview's job is to show what will happen and what will happen is the
 * document's rotation. `placed` in ui/src/proposalgeom.js rotates a body in its
 * OWN coordinates and only then carries it to `at`, so `at` is the single world
 * point a change of `rot` leaves where it is; turned about anything else, the
 * body swings under the hand and then jumps to the document's answer on
 * release. The box's centre is the wrong point for every op that is not centred
 * on its own origin — an extrusion runs its profile UP from `z = 0`, so its box
 * centre sits at `h/2` whatever the profile is, and a quarter turn taken about
 * that instead moves the body by `sqrt(2)·h/2`: 14 mm on a 20 mm extrusion and
 * 70 mm on a 100 mm one. The number itself comes off the payload the panel
 * built (`bodyOrigin` in viewport/rings.js), which is the only place it exists
 * on this side.
 */
export function nudgeTurn(vp, paths, seats, turn) {
  const list = Array.isArray(paths) ? paths : [];
  const spin = Array.isArray(turn) ? turn : NO_TURN;
  if (!list.length || !finite3(spin)) return false;
  const groups = list.map((path) => movableGroup(vp.viewer, path));
  if (groups.some((group) => !group)) return false;
  // ALL THREE OR THE WHOLE GESTURE IS REFUSED, which is `movePart`'s rule about
  // a part whose centre the scene cannot give: a body turned about some other
  // point is worse than a body that did not turn.
  const held = Array.isArray(seats) ? seats : [];
  if (held.length !== list.length
      || held.some((seat) => !seat || !finite3(seat.home) || !finite3(seat.centre)
                   || !Array.isArray(seat.pose) || seat.pose.length !== 4)) {
    return false;
  }
  const q = quaternionOf(spin);
  try {
    groups.forEach((group, at) => {
      // `[0, 0, 0]` FOR THE OFFSET, which is the paragraph above said in the
      // one argument that could have carried it: this gesture turns, and does
      // not slide.
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
  // The contour the body carried round under the plane with it — `nudgePart`
  // ends in the same call and says why a staged body is an ordinary solid.
  redrawCut(vp);
  return true;
}

/**
 * Put every moved part back where the READER left it, on groups just rebuilt.
 *
 * The other half of keeping a drag across a re-stage (viewport/element.js): the
 * map of offsets survives one, but the ObjectGroups they were written on do not
 * — those were disposed in `clear()` and built again by `render()`, at the
 * positions the model gives them. Without this the move the proposal document
 * holds would describe a part standing exactly where the build puts it, which is
 * ui-brief block 6 broken in the quietest possible way: the page says something
 * is displaced and nothing is.
 *
 * THE HOMES ARE FORGOTTEN AND TAKEN AGAIN rather than reused. They are positions
 * read off groups that no longer exist; the new ones are at the same coordinates
 * because it is the same document rendered again, and reading them off the scene
 * in front of us is the spelling that stays true if that ever stops holding.
 *
 * A PATH THE SCENE NO LONGER HAS IS DROPPED, which is `movePart`'s own answer to
 * one: it refuses a path it cannot move, and the entry is then simply not
 * written back into `vp.moved`.
 */
export function restageMoves(vp) {
  if (!vp.moved.size) return;
  const offsets = [...vp.moved.entries()];
  vp.moved.clear();
  vp.partHome.clear();
  // THE CENTRES AND THE POSES GO WITH THE HOMES, and for the same reason: all
  // three were read off groups that no longer exist, and they were read on those
  // groups AS THEY STOOD — displaced and turned. Kept, the first re-applied turn
  // would be taken about the centre of a part that was already turned, and
  // composed onto a pose that already had the reader's turn in it.
  vp.partPivot.clear();
  vp.partFacing.clear();
  // ONE CALL PER PATH, because one offset belongs to one path: a row standing for
  // five copies of a part moved all five by the same offset, and every one of
  // them is its own entry in this map.
  for (const [path, stood] of offsets) {
    movePart(vp, [path], stood.delta, stood.turn);
  }
}

/**
 * Make the scene's offsets say what the DOCUMENT says: `wanted` is the whole of
 * it, as `{paths, delta, turn}` entries.
 *
 * THE DOCUMENT IS THE SOURCE OF TRUTH and this is the one function that acts on
 * that. A drag is recorded as a node of the proposal (ui/src/proposal.js), the
 * interface hands the whole set back here, and a part goes home because its
 * entry was DELETED — there is nothing else to press. That is why this takes the
 * set rather than one move: "which parts are displaced" is a question only the
 * whole list answers, and a per-entry door would leave this side deciding, out of
 * two calls, which of them meant "and nothing else".
 *
 * `keep` IS WHAT PROTECTS A DELTA THAT CHANGED, and it is worth being exact
 * about which mechanism does that: an entry whose delta moved is a path in
 * `vp.moved` AND in `wanted`, so the put-back loop would send it home on its way
 * past — `keep` is the set of everything the list still claims, and it skips
 * exactly those. The two loops are then independent, and the order they are
 * written in is only the order that reads well.
 *
 * A DELTA THAT IS ALREADY STANDING IS SKIPPED ENTIRELY, and that is what makes
 * the interface safe to push the document on every change of it. The drag's own
 * echo is the case this is for: the release reports the move (`reportModelMove`
 * in tools.js), the interface records it and hands the whole document straight
 * back to the viewport the part was dragged in — where every path it names is
 * already exactly where it asks for. A second `position.set`, a second render
 * and a second rebuild of the cut contour would all be spent on a scene that is
 * already right.
 *
 * WHICH IS SAFE BECAUSE `vp.moved` IS WHAT WAS WRITTEN, never what was asked
 * for: `movePart` records a path only after setting its group, and a re-stage
 * re-applies the map onto the groups it just built (`restageMoves`). So an entry
 * equal to the delta wanted means the group is already there.
 */
export function reconcileMoves(vp, wanted) {
  const list = Array.isArray(wanted) ? wanted : [];
  const keep = new Set();
  for (const move of list) for (const path of move.paths) keep.add(path);
  const spin = (move) => (Array.isArray(move.turn) ? move.turn : NO_TURN);
  // BOTH HALVES OR IT IS NOT STANDING. A part already at this offset but turned
  // some other way is a part this list does not describe yet, and skipping it on
  // the delta alone would leave the scene disagreeing with the document with
  // nothing left to notice it.
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
    // READ AS A PAIR because they are WRITTEN as a pair: one line of `movePart`
    // remembers where the group stood and which way it faced, and one line of
    // `restageMoves` forgets both. A path with one and not the other is not a
    // state this file can reach.
    const pose = vp.partFacing.get(path);
    // OFF THE MAP BEFORE THE ATTEMPT, so it goes whether or not the attempt
    // gets anywhere — a path the scene no longer has, and a `position.set` that
    // throws, leave it recorded just the same. What that would cost is a map
    // describing offsets nothing is standing at: `measure.js` goes on calling
    // the view laid out, and every later reconcile tries the same failing write
    // again.
    vp.moved.delete(path);
    if (!group || !base || !pose) continue;
    try {
      group.position.set(base[0], base[1], base[2]);
      // AND THE TURN COMES OFF WITH THE OFFSET, because "put it back" is one
      // thing and not two: the node that said both was deleted, and it said
      // both.
      //
      // BACK TO THE POSE THE BUILD GAVE IT AND NOT TO THE IDENTITY. The group's
      // quaternion is where a view's `loc[1]` lives — a lid its view seats
      // upside down stands at a half turn before anybody touches it — so the
      // identity here would leave that part flipped out of its seated pose, with
      // the document claiming nothing at all and only a rebuild to fix it.
      group.quaternion.set(pose[0], pose[1], pose[2], pose[3]);
      home = true;
    } catch (error) {
      console.warn("move reset", error);
    }
  }
  if (home && vp.viewer) vp.viewer.update(true, false);

  // ONE CALL PER ENTRY, because one offset belongs to one gesture: a row standing
  // for five copies of a part moved all five by the same offset, and `movePart`
  // takes exactly that shape — every path from its own home.
  for (const move of list) {
    const turn = spin(move);
    if (move.paths.every((path) => standing(path, move.delta, turn))) continue;
    movePart(vp, move.paths, move.delta, turn);
  }

  // The contours the parts that went home carried off the plane with them.
  // `movePart` ends in this itself, so the loop above is covered; what is not is
  // a reconcile that only put things back. After the render, like every other
  // caller, and gated inside on a cut that is actually on screen.
  if (home) redrawCut(vp);
}
