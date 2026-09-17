// Everything the interface does to a PART rather than to the camera: hide it,
// ghost it, select it, drag it, and — before any of that — hand the interface
// the tree it draws (ui-brief block 3).

import { internals } from "./internals.js";
import { finite3 } from "./math.js";
import { GHOST_OPACITY } from "./options.js";
import { outlineChild, refreshSectionOutline } from "./outline.js";

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
 * Apply the interface's `selected`.
 *
 * The shader highlight rather than a material change: `HighlightController` owns
 * a texture of per-object states, so nothing per-part is touched and nothing has
 * to be undone. It paints FACES only — deliberate on the library's side, edges
 * keep their own colour.
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
 * Offset a part from where the build put it. `delta` is world units.
 *
 * NOT a change to the model, and the interface has to say so (ui-brief block 6):
 * nothing is written anywhere, the next rebuild puts the part back, and the
 * offset travels to the agent as part of a sentence rather than as a result.
 *
 * SEVERAL PATHS, ONE DELTA: a row that collapsed five copies of one part
 * (hub.indexTree) moves as one thing, so every instance takes the same offset
 * from its OWN home — which is why `home` is remembered per path and not per
 * row.
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
export function movePart(vp, paths, delta) {
  const list = Array.isArray(paths) ? paths : [];
  if (!list.length || !finite3(delta)) return false;
  const groups = list.map((path) => movableGroup(vp.viewer, path));
  if (groups.some((group) => !group)) return false;
  try {
    list.forEach((path, at) => {
      const base = home(vp, path, groups[at]);
      groups[at].position.set(
        base[0] + delta[0], base[1] + delta[1], base[2] + delta[2]);
      vp.moved.set(path, delta);
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
  // ONE CALL PER PATH, because one delta belongs to one path: a row standing for
  // five copies of a part moved all five by the same offset, and every one of
  // them is its own entry in this map.
  for (const [path, delta] of offsets) movePart(vp, [path], delta);
}

/**
 * Make the scene's offsets say what the DOCUMENT says: `wanted` is the whole of
 * it, as `{paths, delta}` entries.
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
  const standing = (path, delta) => {
    const now = vp.moved.get(path);
    return !!now && delta.every((value, axis) => value === now[axis]);
  };

  let home = false;
  for (const path of [...vp.moved.keys()]) {
    if (keep.has(path)) continue;
    const group = movableGroup(vp.viewer, path);
    const base = vp.partHome.get(path);
    // OFF THE MAP BEFORE THE ATTEMPT, so it goes whether or not the attempt
    // gets anywhere — a path the scene no longer has, and a `position.set` that
    // throws, leave it recorded just the same. What that would cost is a map
    // describing offsets nothing is standing at: `measure.js` goes on calling
    // the view laid out, and every later reconcile tries the same failing write
    // again.
    vp.moved.delete(path);
    if (!group || !base) continue;
    try {
      group.position.set(base[0], base[1], base[2]);
      home = true;
    } catch (error) {
      console.warn("move reset", error);
    }
  }
  if (home && vp.viewer) vp.viewer.update(true, false);

  // ONE CALL PER ENTRY, because one delta belongs to one gesture: a row standing
  // for five copies of a part moved all five by the same offset, and `movePart`
  // takes exactly that shape — every path from its own home.
  for (const move of list) {
    if (move.paths.every((path) => standing(path, move.delta))) continue;
    movePart(vp, move.paths, move.delta);
  }

  // The contours the parts that went home carried off the plane with them.
  // `movePart` ends in this itself, so the loop above is covered; what is not is
  // a reconcile that only put things back. After the render, like every other
  // caller, and gated inside on a cut that is actually on screen.
  if (home) redrawCut(vp);
}
