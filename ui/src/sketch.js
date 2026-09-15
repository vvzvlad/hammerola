// ui/src/sketch.js — the sketch document, and the text an agent reads off it.
//
// A person opens a published model and assembles a rough parametric body out of
// primitives: a mock of the motor the bracket has to clear, the wall it bolts
// to, the bought part it holds. That body is a STATEMENT and not an edit — the
// same rule ui-brief block 6 states for a moved part, one step further on.
// Nothing here is pushed, nothing is rebuilt from it, and the model on screen is
// untouched by it. What travels to the agent is the projection `sketchText`
// renders: a few aligned lines saying how big the thing is and where its
// features sit, which is a constraint the agent can design against instead of a
// sentence like "it is about four centimetres".
//
// PURE, AND WITH NO GEOMETRY IN IT. Every helper returns a new document and this
// module imports nothing at all; the kernel lives next door in sketchgeom.js. So
// the document can be built, edited, projected and compared with no meshes
// computed and no browser anywhere near it.
//
// A DIMENSION IS A NUMBER OR THE NAME OF A PARAM, and that is the whole of the
// language. There is no expression syntax and there is deliberately not going to
// be one: a parser is the boundary where this stops being a sketch and starts
// being a second way to author models, which is the thing the hub already does
// properly from Python. `resolveValue` therefore refuses an unknown name rather
// than evaluating anything, and says what it wanted.

/** A document with nothing in it — the state a freshly opened panel is in. */
export function emptySketch() {
  return { version: 1, units: 'mm', params: [], nodes: [] }
}

/** Nothing has been put in it: no bodies and no params. */
export function isEmpty(doc) {
  return doc.nodes.length === 0 && doc.params.length === 0
}

/** The number behind a dimension: itself, or the initial value of a named param. */
export function resolveValue(doc, value) {
  if (typeof value === 'number') return value
  const param = doc.params.find((entry) => entry.name === value)
  if (!param) {
    throw new Error(
      `this sketch has no param named ${JSON.stringify(value)}. A dimension is ` +
      'a number or the name of a param; expressions are not supported',
    )
  }
  return param.initial
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

export function addParam(doc, param) {
  return { ...doc, params: [...doc.params, param] }
}

export function removeParam(doc, name) {
  return { ...doc, params: doc.params.filter((param) => param.name !== name) }
}

export function updateParam(doc, name, patch) {
  return {
    ...doc,
    params: doc.params.map((param) => (param.name === name ? { ...param, ...patch } : param)),
  }
}

// WHAT A NODE CARRIES THAT IS NOT A DIMENSION. Everything else on it — a size, a
// diameter, a height — is a number or the name of a param, so a dimension is the
// only STRING a node holds outside this list. That is what lets `renameParam`
// below be a walk instead of a fourth table keyed by op beside `DIMS` here and
// `SHAPES` in sketchgeom.js: a per-op list of where the dimensions sit would be
// one more thing to keep in step with those two, while these four fields are the
// same four whatever the op is.
const STRUCTURE = new Set(['id', 'name', 'op', 'role'])

/** One field's value with every mention of a param name rewritten. */
const respelled = (value, from, to) => {
  if (value === from) return to
  if (Array.isArray(value)) return value.map((item) => respelled(item, from, to))
  return value
}

/**
 * Does this value, or anything nested in it, name that param?
 *
 * AS DEEP AS `respelled` REACHES, and the two are a pair rather than two
 * helpers that happen to sit together: one rewrites the mentions and the other
 * finds them, so a mention only one of them can see is a document nobody asked
 * for. A single level deep — which this was — left a name inside a profile's
 * point rewritten by `renameParam` and invisible to `usedBy`, so `dropParam`
 * offered to remove a param a body was still spending.
 */
const mentions = (value, name) => (Array.isArray(value)
  ? value.some((item) => mentions(item, name))
  : value === name)

/** Does this node's geometry name that param? */
const names = (node, name) => Object.entries(node).some(([field, value]) => (
  !STRUCTURE.has(field) && mentions(value, name)))

/**
 * The first of `wanted`, `wanted2`, `wanted3`, … that nothing has taken.
 *
 * ONE LOOP FOR BOTH HALVES OF THE PANEL: the bodies mint their names by it
 * (`freeName` in HammerolaViewer.jsx, which builds the set and adds the result
 * part's name to it) and `renameParam` below lands a param on it. A second copy
 * of the loop is a second answer to "what is this name when it is taken", and
 * the two halves are read side by side in one panel.
 */
export function firstFree(wanted, taken) {
  if (!taken.has(wanted)) return wanted
  let n = 2
  while (taken.has(`${wanted}${n}`)) n += 1
  return `${wanted}${n}`
}

/**
 * A param renamed, and every dimension that named it renamed with it.
 *
 * A RENAME IS NOT AN EDIT OF ONE RECORD, and writing it as one is how `wall`
 * stops building on the way to `wall_t`: the param is gone under the old name
 * while three sizes still ask for it, `resolveValue` refuses the document, and
 * the panel cannot be typed back out of it — the name that would repair it is
 * the one that was just taken away.
 *
 * A NO-OP ON A NAME NO PARAM CARRIES, and on a rename to the name it already
 * has: both are what a field committed without having been changed hands over.
 *
 * AND IT LANDS ON THE FIRST FREE NAME, which is the rule the bodies already
 * carry (`freeName` in HammerolaViewer.jsx) and which params need for the same
 * reason one step further in: a name is what every dimension spends a param BY,
 * so `p1` renamed onto an existing `p2` left two records answering to one name —
 * `resolveValue` reading the first, `updateParam` and `removeParam` writing
 * both, this function renaming both — and no way back, because the panel draws
 * the two rows identically. THE PARAM BEING RENAMED IS NOT IN ITS OWN WAY: the
 * bodies exclude themselves by `id` and a param has none, so it is excluded by
 * the name it is leaving.
 */
export function renameParam(doc, from, to) {
  if (from === to || !doc.params.some((param) => param.name === from)) return doc
  const name = firstFree(to, new Set(doc.params
    .filter((param) => param.name !== from)
    .map((param) => param.name)))
  return {
    ...doc,
    params: doc.params.map(
      (param) => (param.name === from ? { ...param, name } : param)),
    nodes: doc.nodes.map((node) => Object.fromEntries(
      Object.entries(node).map(([field, value]) => [
        field, STRUCTURE.has(field) ? value : respelled(value, from, name),
      ]))),
  }
}

/**
 * The names of the bodies whose dimensions name this param.
 *
 * What a refusal is written out of: a param a body still spends cannot simply be
 * removed — the document that would leave refuses to build, and the panel has no
 * way back to it — so the panel asks this first and says which bodies to see to.
 */
export function usedBy(doc, name) {
  return doc.nodes.filter((node) => names(node, name)).map((node) => node.name)
}

// HOW EACH OP SPELLS ITS OWN SIZE. One entry per op, keyed the same way
// sketchgeom.js keys the geometry it builds for them, so an op that grows a
// dimension is changed in two tables and nowhere else. An op that is in neither
// table throws where it is looked up, which is the honest end of a document
// naming something this module has never heard of.
const DIMS = {
  box: (dim, node) => `${dim(node.size[0])} x ${dim(node.size[1])} x ${dim(node.size[2])}`,
  cylinder: (dim, node) => `d${dim(node.d)} h${dim(node.h)}`,
  sphere: (dim, node) => `d${dim(node.d)}`,
  // THE POINTS AND NOT A COUNT OF THEM. `profile 4pt` said an extrusion was
  // some quadrilateral, which is the one body in this table whose shape is not
  // in its numbers — a count leaves the agent designing against a hole in the
  // sentence. Spelled the way the panel's own profile field spells it, so the
  // line reads back as the thing the reader typed.
  extrude: (dim, node) => `h${dim(node.h)} profile ${
    node.profile.map((point) => point.join(',')).join('; ')}`,
}

// THE OPS THIS TABLE ANSWERS FOR, so the agreement above can be CHECKED instead
// of asserted in prose. Three tables carry these keys — this one, `SHAPES` next
// door and `SIZES` in the panel — and an op added to two of them builds, draws
// and passes every test until somebody presses `add to comment`, where the
// projection looks up an op it has never heard of. `ui/tests/sketchpanel.test.js`
// holds the three sets equal; derived from the table rather than written out, so
// it cannot be the thing that is stale.
export const DIM_OPS = Object.freeze(Object.keys(DIMS))

/**
 * `wall = 2.4 (1..5 step 0.2) slider "wall thickness"` — every piece the param
 * carries, and nothing at all for the pieces it does not.
 *
 * WHAT THE OTHER THREE FIELDS ARE FOR. The panel has a caption field, a step
 * field and a type toggle whose tooltip says the type is how the agent should
 * OFFER the param — and this line is the agent's only sight of any of them:
 * nothing on this page renders a slider, so until they were printed here the
 * three were typed into nothing.
 *
 * `number` IS THE DEFAULT AND IS NOT PRINTED. It is what the + button mints a
 * param with, so spelling it out would put a word on nearly every param line
 * that says only that nobody pressed the toggle.
 */
function paramText(param) {
  // The two that live inside the brackets, each on its own terms: a bound the
  // param may simply not have (both ends or neither, or `(40..0)` reads as a
  // real limit somebody set) and a step it may not have either.
  const inside = []
  if (param.min !== undefined && param.max !== undefined) {
    inside.push(`${param.min}..${param.max}`)
  }
  if (param.step !== undefined) inside.push(`step ${param.step}`)

  const pieces = [`${param.name} = ${param.initial}`]
  if (inside.length) pieces.push(`(${inside.join(' ')})`)
  if (param.type && param.type !== 'number') pieces.push(param.type)
  if (param.caption) pieces.push(`"${param.caption}"`)
  return pieces.join(' ')
}

/**
 * The projection the agent reads.
 *
 * COLUMNS ARE ALIGNED TO THE WIDEST ENTRY, with two spaces between them, and the
 * rotation column is last so that a sketch nobody rotated anything in ends every
 * line at `at (…)` — the padding is trimmed rather than left hanging.
 *
 * A PARAM-DRIVEN DIMENSION PRINTS BOTH HALVES, `42.3 (body)`: the number is what
 * the agent has to design against and the name is what makes it one decision
 * rather than three coincidences.
 */
export function sketchText(doc) {
  const dim = (value) => (typeof value === 'string'
    ? `${resolveValue(doc, value)} (${value})`
    : String(value))

  const rows = doc.nodes.map((node) => [
    node.role,
    node.op,
    `"${node.name}"`,
    DIMS[node.op](dim, node),
    `at (${node.at.join(', ')})`,
    node.rot.some((angle) => angle !== 0) ? `rot (${node.rot.join(', ')})` : '',
  ])
  const width = (column) => Math.max(...rows.map((row) => row[column].length))
  const table = rows.map((row) => row
    .map((cell, column) => cell.padEnd(width(column)))
    .join('  ')
    .trimEnd())

  const head = [`units: ${doc.units}`]
  if (doc.params.length) head.push(`params: ${doc.params.map(paramText).join(', ')}`)

  const blocks = [head.join('\n')]
  if (table.length) blocks.push(table.join('\n'))
  blocks.push('result = union(solid) - union(hole)')
  return blocks.join('\n\n')
}
