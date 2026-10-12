// ui/src/proposal.js — the proposal document, and the text an agent reads off
// it.
//
// A person assembles rough bodies out of primitives over a published model: the
// motor the bracket has to clear, the wall it bolts to, the bought part it
// holds. What is drawn is a STATEMENT, not an edit (ui-brief block 6): nothing
// is pushed or rebuilt from it. What travels to the agent is `proposalText`: a
// few aligned lines with sizes and positions, a constraint the agent can design
// against.
//
// PURE, AND WITH NO GEOMETRY IN IT. Every helper returns a new document; the
// kernel lives in proposalgeom.js, so the document can be built, edited and
// projected with no meshes and no browser.
//
// The one import is `quaternionOf`/`anglesOf`/`after` from viewport/math.js —
// not from `parts.js`, which re-exports them but reaches the whole viewport
// through `internals.js`; `math.js` imports nothing. `turnNodes` composes a
// turn onto a body's `rot` (see `turnedFrom`), so the viewport's preview and
// this document compute the same orientation from the same line.
//
// A DIMENSION IS A NUMBER: no expression syntax and no named values. A parser
// would make this a second way to author models, which the hub already does
// from Python.

// TWO KINDS OF NODE, TOLD APART BY `role`. A BODY is something the reader drew
// — `solid` or `hole`, an op and its dimensions, placed by `at` and `rot` —
// and proposalgeom.js builds a part out of it. A MOVE is a part of the BUILD,
// displaced and turned: `{role: 'move', paths, name, delta, turn}`, with no op
// and no size.
//
// `turn` has the units of a body's `rot` — three angles in DEGREES about the
// three axes, applied as jscad applies a body's (`placed` in proposalgeom.js,
// `quaternionOf` in viewport/parts.js) — but is an offset from the orientation
// the build gave the part, as `delta` is an offset from its position. Deleting
// the node undoes either.
//
// A move is a node of this document because a drag of a published part is the
// same kind of statement as a body, and deleting the entry sends the part home.
//
// Fields: `paths` is every scene path the gesture moved (five for a row that
// collapsed five copies), what the viewport needs to place the part. `name` is
// the row's label at the moment of the drag, resolved at record time and never
// looked up again, because a collapsed run may have no row later; it is
// re-resolved only when a later gesture takes some of its paths away (the
// `hmr:moved` handler in HammerolaViewer.jsx), since the name carries the
// count. `delta` and `turn` are offsets from the build's pose.
//
// `skip` means the same on both kinds: the node is left out of `proposalText`
// and reaches nobody, but stays staged over the model with its row. It is a
// field of the document, not the interface, so it survives `dropMoves`, every
// updater that rebuilds the node list, the revision swap, and the hub's copy
// (`loadProposal`/`saveProposal` in HammerolaViewer.jsx). A node without the
// field reads as not skipped.

import { after, anglesOf, quaternionOf } from './viewport/math.js'

const MOVE = 'move'

/** A document with nothing in it — the state a freshly opened panel is in. */
export function emptyProposal() {
  return { version: 1, units: 'mm', nodes: [] }
}

/** Nothing has been put in it: not one body, not one move. */
export function isEmpty(doc) {
  return doc.nodes.length === 0
}

/** The document as it TRAVELS: every node the reader ticked off, dropped. */
function unskipped(doc) {
  return { ...doc, nodes: doc.nodes.filter((node) => !node.skip) }
}

/**
 * Nothing in it would reach the agent — empty, or ticked off to the last node.
 *
 * The predicate the outgoing paths ask. `isEmpty` is about the DOCUMENT and the
 * tree branch is drawn on it (a reader who ticked every node off must still see
 * the rows to untick them); this one is about the PROJECTION, and
 * `proposalPayload` gates on it — otherwise the agent would get a block with
 * only `units:` and `result =`.
 */
export function sendsNothing(doc) {
  return isEmpty(unskipped(doc))
}

/** Those nodes that displace a part of the build rather than drawing a body. */
export function moves(doc) {
  return doc.nodes.filter((node) => node.role === MOVE)
}

/**
 * The other half: the nodes that are a drawing rather than a displacement.
 *
 * Everything that wants a shape or a size asks for it, since a move has
 * neither. So does everything that works by NAME: a body's name must be unique
 * among bodies (`firstFree`), while a move's is a build row's and may repeat
 * it; mixed, a drag of a part would rename the reader's body, and a drag of the
 * body would find the move and ask it for an `at` it lacks.
 */
export function bodies(doc) {
  return doc.nodes.filter((node) => node.role !== MOVE)
}

/**
 * The same document with every move dropped and every body kept.
 *
 * Called when a build lands: a delta is measured against where one build put
 * one part, so a rebuild, another revision or another view leaves it
 * describing nothing (the viewport clears its own map too). Bodies stay.
 */
export function dropMoves(doc) {
  return { ...doc, nodes: bodies(doc) }
}

export function addNode(doc, node) {
  return { ...doc, nodes: [...doc.nodes, node] }
}

export function removeNode(doc, id) {
  return { ...doc, nodes: doc.nodes.filter((node) => node.id !== id) }
}

export function updateNode(doc, id, patch) {
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)),
  }
}

/**
 * A number a drag produced, at a place somebody could have typed.
 *
 * Binary floating point: `42.4 + 0.1` is `42.400000000000006`. Every number
 * this document holds is drawn in the panel and printed in the projection, so
 * it is rounded to keep only real digits.
 *
 * Applied where the arithmetic is: `moveNodes` (adds a delta to `at`),
 * `turnedFrom` (composes a turn, `atan2` digits), and `snap` in
 * viewport/tools.js (multiplies a step back out — hence the export). Nothing
 * rounds a second time: the `hmr:moved` handler writes the delta exactly as
 * `snap` made it.
 */
export function tidy(value) {
  return Math.round(value * 1e6) / 1e6
}

/**
 * Those nodes moved by `delta`, in whatever units the document is in.
 *
 * The viewport turns a hand across the screen into three numbers and names the
 * body it grabbed (`hmr:proposalmove`); here it is an ordinary edit, the same
 * as typing into the `at` fields.
 *
 * Ids, not a name: which body a grab means is a fact about the payload
 * (proposalgeom.js), and resolving it here would import the kernel.
 *
 * Rounded (`tidy`) so `42.3 + 0.1` reads `42.4` in the field.
 */
export function moveNodes(doc, ids, delta) {
  return patched(doc, ids, (node) => ({
    at: node.at.map((value, axis) => tidy(value + delta[axis])),
  }))
}

/**
 * Where three angles stand once `applied` has been turned about the WORLD axes
 * on top of them.
 *
 * One place because two sides must agree: `turnNodes` writes it into `rot`,
 * and the viewport's rings preview the pose with it (`onMove` in
 * viewport/rings.js). Two copies would drift, and a body would land facing a
 * different way from the preview.
 *
 * Adding the angle to one field is wrong: `rot` is read as `Rz·Ry·Rx`
 * (`quaternionOf` in viewport/math.js), so adding to x is a turn about world x
 * only while y and z are zero; a body at `(0, 0, 90)` given 30 on x by addition
 * turns about world Y. Composed and brought back through `anglesOf`, it is the
 * turn the reader asked for.
 *
 * The three fields will not stay whole degrees: 30 about x on top of
 * `(0, 0, 90)` is `(0, -30, 90)`, as in any CAD tool.
 *
 * Rounded (`tidy`) because `atan2` returns digits no hand put there.
 */
export function turnedFrom(standing, applied) {
  return anglesOf(after(quaternionOf(applied), quaternionOf(standing))).map(tidy)
}

/**
 * Those nodes turned by `turn`, three degrees about the three WORLD axes.
 *
 * A separate entry point from `moveNodes` because the viewport tells a drag
 * from a turn at the press and sends different events. `rot` is the body's own
 * pose (see the head of this file).
 *
 * Composed, not set: the viewport never reads this document, so it reports how
 * far this one gesture turned the body, and the pose it started from is here.
 * A part of the BUILD is the other way round — the viewport knows the build's
 * pose, reports the whole turn, and the node is replaced.
 */
export function turnNodes(doc, ids, turn) {
  return patched(doc, ids, (node) => ({ rot: turnedFrom(node.rot, turn) }))
}

/** Those nodes with `edit`'s answer merged into them, and every other one left
 *  alone — the one copy of the walk the two doors above share. */
function patched(doc, ids, edit) {
  const wanted = new Set(ids)
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (wanted.has(node.id)
      ? { ...node, ...edit(node) }
      : node)),
  }
}

/**
 * The first of `wanted`, `wanted2`, `wanted3`, … that nothing has taken.
 *
 * Used by `freeName` in HammerolaViewer.jsx. It lives here because a name is a
 * fact about the document: two bodies under one name are one part in the
 * payload and one row in the tree.
 */
export function firstFree(wanted, taken) {
  if (!taken.has(wanted)) return wanted
  let n = 2
  while (taken.has(`${wanted}${n}`)) n += 1
  return `${wanted}${n}`
}

// How each op spells its own size. Keyed like proposalgeom.js's geometry table;
// an op in neither table throws where it is looked up.
const DIMS = {
  box: (node) => `${node.size[0]} x ${node.size[1]} x ${node.size[2]}`,
  cylinder: (node) => `d${node.d} h${node.h}`,
  sphere: (node) => `d${node.d}`,
}

// The ops this table answers for. Three tables carry these keys — this one,
// `SHAPES` in proposalgeom.js and `SIZES` in the panel — and
// `ui/tests/proposalpanel.test.js` holds the three sets equal; an op missing
// here would only fail when the projection is built.
export const DIM_OPS = Object.freeze(Object.keys(DIMS))

/**
 * The projection the agent reads.
 *
 * Columns are aligned to the widest entry with two spaces between them; the
 * rotation column is last so an unrotated proposal ends every line at `at (…)`,
 * padding trimmed.
 *
 * Moves are a block of their own, aligned among themselves: they share a name
 * and a turn with bodies (dropped when all zero) but have no op or size, and
 * their place is a `by (…)` offset from the build's pose. Folded into the body
 * table they would pad its columns with cells that mean something else. They
 * come after the bodies and before the `result` line.
 *
 * A node ticked off is not here at all (`unskipped`), in either table or its
 * widths, so the columns close up behind it.
 */
export function proposalText(doc) {
  const sent = unskipped(doc)
  const rows = bodies(sent).map((node) => [
    node.role,
    node.op,
    `"${node.name}"`,
    DIMS[node.op](node),
    `at (${node.at.join(', ')})`,
    node.rot.some((angle) => angle !== 0) ? `rot (${node.rot.join(', ')})` : '',
  ])
  const width = (column) => Math.max(...rows.map((row) => row[column].length))
  const table = rows.map((row) => row
    .map((cell, column) => cell.padEnd(width(column)))
    .join('  ')
    .trimEnd())

  // One space between columns, so a single move reads as a sentence —
  // `move "bracket" by (3, 0, 0)`. The turn is left off where it is all zero,
  // like `rot (…)` in the body table.
  const shifts = moves(sent).map((node) => [
    `move "${node.name}"`,
    `by (${node.delta.join(', ')})`,
    node.turn.some((angle) => angle !== 0)
      ? `turned (${node.turn.join(', ')})` : '',
  ])
  const shifted = (column) => Math.max(...shifts.map((row) => row[column].length))
  const moveTable = shifts.map((row) => row
    .map((cell, column) => cell.padEnd(shifted(column)))
    .join(' ')
    .trimEnd())

  const blocks = [`units: ${doc.units}`]
  if (table.length) blocks.push(table.join('\n'))
  if (moveTable.length) blocks.push(moveTable.join('\n'))
  blocks.push('result = union(solid) - union(hole)')
  return blocks.join('\n\n')
}
