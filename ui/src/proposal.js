// ui/src/proposal.js — the proposal document, and the text an agent reads off
// it.
//
// A person opens a published model and assembles a rough body — or several — out
// of primitives: the motor the bracket has to clear, the wall it bolts to, the
// bought part it holds, or an example of how they want things laid out. What is
// drawn is a STATEMENT and not an edit — the same rule ui-brief block 6 states
// for a moved part, one step further on. Nothing here is pushed, nothing is
// rebuilt from it, and the model on screen is untouched by it. What travels to
// the agent is the projection `proposalText` renders: a few aligned lines
// saying how big the thing is and where its features sit, which is a constraint
// the agent can design against instead of a sentence like "it is about four
// centimetres".
//
// PURE, AND WITH NO GEOMETRY IN IT. Every helper returns a new document and this
// module imports nothing at all; the kernel lives next door in proposalgeom.js.
// So the document can be built, edited, projected and compared with no meshes
// computed and no browser anywhere near it.
//
// A DIMENSION IS A NUMBER, and that is the whole of the language. There is no
// expression syntax, no name to stand in for a number, and there is deliberately
// not going to be either: a parser is the boundary where this stops being a
// panel of numbers and starts being a second way to author models, which is the
// thing the hub already does properly from Python.

/** A document with nothing in it — the state a freshly opened panel is in. */
export function emptyProposal() {
  return { version: 1, units: 'mm', nodes: [] }
}

/** Nothing has been put in it: not one body. */
export function isEmpty(doc) {
  return doc.nodes.length === 0
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
 * Those nodes moved by `delta`, in whatever units the document is in.
 *
 * WHAT A DRAG OF A BODY COMES TO. The viewport turns a hand across the screen
 * into three numbers and names the body it grabbed (`hmr:proposalmove`); by the
 * time it reaches here it is an ordinary edit of the document, indistinguishable
 * from the same numbers typed into the `at` fields — which is exactly what it
 * has to be, since the panel shows those fields and the projection the agent
 * reads is rendered off them.
 *
 * A LIST OF IDS AND NOT A NAME, so this module still knows nothing about the
 * geometry: which bodies a grab means — every one of them for the fused result,
 * one for a hole — is a fact about the PAYLOAD (`RESULT_NAME` in
 * proposalgeom.js), and answering it here would make this module import the
 * kernel it is kept apart from.
 *
 * ROUNDED, and to a place no dimension in this panel reaches. `at` is drawn in a
 * field and printed in the projection, so `42.3 + 0.1` has to read as `42.4` and
 * not as `42.400000000000006` — a number nobody typed, in a field the reader is
 * looking at, on the first drag of a body they had placed by hand.
 */
export function moveNodes(doc, ids, delta) {
  const wanted = new Set(ids)
  const tidy = (value) => Math.round(value * 1e6) / 1e6
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (wanted.has(node.id)
      ? { ...node, at: node.at.map((value, axis) => tidy(value + delta[axis])) }
      : node)),
  }
}

/**
 * The first of `wanted`, `wanted2`, `wanted3`, … that nothing has taken.
 *
 * WHAT THE BODIES MINT THEIR NAMES BY — `freeName` in HammerolaViewer.jsx,
 * which builds the set of taken names and adds the result part's name to it. It
 * lives here rather than beside that caller because a name is a fact about the
 * DOCUMENT: two bodies under one name are one part in the payload and one row in
 * the tree, whichever field the name was typed into.
 */
export function firstFree(wanted, taken) {
  if (!taken.has(wanted)) return wanted
  let n = 2
  while (taken.has(`${wanted}${n}`)) n += 1
  return `${wanted}${n}`
}

// HOW EACH OP SPELLS ITS OWN SIZE. One entry per op, keyed the same way
// proposalgeom.js keys the geometry it builds for them, so an op that grows a
// dimension is changed in two tables and nowhere else. An op that is in neither
// table throws where it is looked up, which is the honest end of a document
// naming something this module has never heard of.
const DIMS = {
  box: (node) => `${node.size[0]} x ${node.size[1]} x ${node.size[2]}`,
  cylinder: (node) => `d${node.d} h${node.h}`,
  sphere: (node) => `d${node.d}`,
  // THE POINTS AND NOT A COUNT OF THEM. `profile 4pt` said an extrusion was
  // some quadrilateral, which is the one body in this table whose shape is not
  // in its numbers — a count leaves the agent designing against a hole in the
  // sentence. Spelled the way the panel's own profile field spells it, so the
  // line reads back as the thing the reader typed.
  extrude: (node) => `h${node.h} profile ${
    node.profile.map((point) => point.join(',')).join('; ')}`,
}

// THE OPS THIS TABLE ANSWERS FOR, so the agreement above can be CHECKED instead
// of asserted in prose. Three tables carry these keys — this one, `SHAPES` next
// door and `SIZES` in the panel — and an op added to two of them builds, draws
// and passes every test until somebody presses `add to comment`, where the
// projection looks up an op it has never heard of. The three sets are held
// equal in `ui/tests/proposalpanel.test.js`; derived from the table rather than
// written out, so it cannot be the thing that is stale.
export const DIM_OPS = Object.freeze(Object.keys(DIMS))

/**
 * The projection the agent reads.
 *
 * COLUMNS ARE ALIGNED TO THE WIDEST ENTRY, with two spaces between them, and
 * the rotation column is last so that a proposal nobody rotated anything in ends
 * every line at `at (…)` — the padding is trimmed rather than left hanging.
 */
export function proposalText(doc) {
  const rows = doc.nodes.map((node) => [
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

  const blocks = [`units: ${doc.units}`]
  if (table.length) blocks.push(table.join('\n'))
  blocks.push('result = union(solid) - union(hole)')
  return blocks.join('\n\n')
}
