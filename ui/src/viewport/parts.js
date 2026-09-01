// Everything the interface does to a PART rather than to the camera: hide it,
// ghost it, select it, drag it, and — before any of that — hand the interface
// the tree it draws (ui-brief block 3).

import { internals } from "./internals.js";
import { finite3 } from "./math.js";

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
      if (on) group.opacity = 0.25;
      group.setTransparent(on);
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
 */
export function applySelected(viewer, selected) {
  const g = internals(viewer);
  const hl = g && g.nestedGroup && g.nestedGroup.highlight;
  if (!hl) return;
  try {
    hl.clear();
    if (selected) hl.selectSolid(selected, true);
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

/**
 * Offset one part from where the build put it. `delta` is world units.
 *
 * NOT a change to the model, and the interface has to say so (ui-brief block 6):
 * nothing is written anywhere, the next rebuild puts the part back, and the
 * offset travels to the agent as part of a sentence rather than as a result.
 */
export function movePart(vp, path, delta) {
  const group = movableGroup(vp.viewer, path);
  if (!group || !finite3(delta)) return false;
  const base = home(vp, path, group);
  try {
    group.position.set(base[0] + delta[0], base[1] + delta[1], base[2] + delta[2]);
    vp.moved.set(path, delta);
    vp.viewer.update(true, false);
    return true;
  } catch (error) {
    console.warn("move", error);
    return false;
  }
}

/** Put every moved part back where the build had it. */
export function resetMoves(vp) {
  if (!vp.moved.size) return;
  for (const path of [...vp.moved.keys()]) {
    const group = movableGroup(vp.viewer, path);
    const base = vp.partHome.get(path);
    if (group && base) {
      try {
        group.position.set(base[0], base[1], base[2]);
      } catch (error) {
        console.warn("move reset", error);
      }
    }
  }
  vp.moved.clear();
  if (vp.viewer) vp.viewer.update(true, false);
}
