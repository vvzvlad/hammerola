// ui/src/proposal.js — the proposal document, and the text an agent reads off
// it.
//
// A person opens a published model and assembles a rough body — or several — out
// of primitives: the motor the bracket has to clear, the wall it bolts to, the
// bought part it holds, or an example of how they want things laid out. What is
// drawn is a STATEMENT and not an edit — the same rule ui-brief block 6 states
// for a part somebody moved or turned, one step further on. Nothing here is
// pushed, nothing is rebuilt from it, and the model on screen is untouched by
// it. What travels to the agent is the projection `proposalText` renders: a few
// aligned lines saying how big the thing is and where its features sit, which is
// a constraint the agent can design against instead of a sentence like "it is
// about four centimetres".
//
// PURE, AND WITH NO GEOMETRY IN IT. Every helper returns a new document and the
// kernel lives next door in proposalgeom.js, so the document can be built,
// edited, projected and compared with no meshes computed and no browser
// anywhere near it.
//
// THE ONE IMPORT is the pair that reads three angles as a rotation and back
// (`quaternionOf`/`anglesOf` in viewport/math.js — `math.js` and NOT the
// `parts.js` that re-exports them, which is the whole of keeping the promise
// above: `math.js` imports nothing at all, while `parts.js` reaches the viewer
// through `internals.js`, so taking them from there would put the entire
// viewport behind this module), and it is here because
// `turnNodes` COMPOSES a turn onto a body's `rot` rather than adding to it —
// see `turnedFrom` for why it cannot be an addition. That is arithmetic on the
// document's own three numbers and not geometry: nothing it reaches builds a
// mesh, touches the page or runs at import time, so the sentence above still
// holds. What it buys is that the viewport's preview and this document compute
// the SAME orientation out of the same line, instead of two spellings of one
// intent drifting apart.
//
// A DIMENSION IS A NUMBER, and that is the whole of the language. There is no
// expression syntax, no name to stand in for a number, and there is deliberately
// not going to be either: a parser is the boundary where this stops being a
// panel of numbers and starts being a second way to author models, which is the
// thing the hub already does properly from Python.

// TWO KINDS OF NODE, TOLD APART BY `role`, and the second one is why this is
// said here rather than left to the shape of the objects. A BODY is something
// the reader drew — `solid` or `hole`, an op and its dimensions, placed by `at`
// and `rot` — and it is geometry: proposalgeom.js builds a part out of it. A
// MOVE is a part of the BUILD, displaced and turned:
// `{role: 'move', paths, name, delta, turn}`, with no op and no size, because
// the part already exists in the model and nothing here draws it.
//
// `turn` IS A BODY'S `rot` UNDER ANOTHER NAME AND IN THE SAME UNITS — three
// angles in DEGREES about the three axes, applied the way jscad applies a
// body's (`placed` in proposalgeom.js, `quaternionOf` in viewport/parts.js). The
// name differs because the two are measured from different places: a body's
// `rot` is an orientation the reader GAVE it, while a `turn` is an offset from
// the orientation the build already put the part in, exactly as `delta` is an
// offset from where the build put it. Both are undone the same way — the node is
// deleted — and neither changes any geometry.
//
// WHY A MOVE IS A NODE OF THIS DOCUMENT AT ALL. A drag of a published part is
// the same kind of statement a body is — "this is what I mean, and it is not an
// edit of the model" — so it belongs in the same document and travels to the
// agent in the same projection. It also gives putting the part back an obvious
// spelling: the entry is deleted, and the viewport, which draws what this
// document says, sends it home.
//
// WHAT EACH FIELD IS FOR, since the three answer to three different readers.
// `paths` is the scene's own — every path the gesture actually moved, which for
// a row that collapsed five copies of one part is five of them — and it is what
// the VIEWPORT needs to put the part where this says it stands. `name` is the
// row's as it read at the moment of the drag, and it is what the PROJECTION
// prints: resolved from the tree at RECORD time and never looked up again at
// print time, because a name is a fact about the tree that was on screen then
// and a collapsed run may have no row under it later. `delta` is the offset from
// where the build puts the part, in the document's own units, and `turn` is the
// same kind of answer about its ORIENTATION — three degrees about the part's own
// centre, measured from the way the build leaves it standing.
//
// THE ONE THING THAT RE-RESOLVES IT IS THE PATHS CHANGING UNDER IT. A name
// carries the count — `pin ×5` — so a node whose paths are subtracted when a
// later gesture takes some of them (the `hmr:moved` handler in
// HammerolaViewer.jsx) is left saying five about four parts. What happens there
// is not a second lookup of the same fact: it is the same resolution made again
// for a set of paths that is now a different set.
//
// `skip` MEANS THE SAME THING ON BOTH KINDS OF NODE, which is rarer here than
// it sounds — a body and a move share `id`, `role` and `name` and then part
// company entirely, one carrying an op and a size and the other a list of paths
// and a delta. This one is about the PROJECTION
// rather than about the node: a node ticked off is left out of `proposalText`
// and travels to nobody, while everything else goes on exactly as before — the
// body is still staged over the model, the move still displaces its part, both
// still have a row with their numbers in it. So it is a way of holding a
// sentence back from the agent without deleting the thing it is about, which is
// what "exclude from the code being sent" asks for.
//
// IT IS A FIELD OF THE DOCUMENT AND NOT OF THE INTERFACE, which is the half
// worth saying, and the reason is what the document survives: a reader who
// ticked eight of ten nodes off has done work that a re-render must not throw
// away, and the tick has to ride through `dropMoves`, through every functional
// updater that rebuilds the node list, and through the revision swap, which
// re-projects the attachment from the document it carried across. AND THROUGH A
// RELOAD, which this paragraph used to say was the one thing it did not do: the
// hub keeps one of these per project now, read and written under the same
// EDIT_TOKEN as everything else (`loadProposal` and `saveProposal` in
// HammerolaViewer.jsx), and what travels there is the DOCUMENT — so the tick
// went where the rest of it went, which is what being a field of the document
// promised it would. A document written before this field existed simply has
// no such field on its nodes, and reads as not skipped — every test here is a
// falsy read, so there is nothing to migrate.

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
 * THE PREDICATE THE DOORS OUT ASK, and it is beside `isEmpty` rather than
 * instead of it because the two are asked by different readers about different
 * things. `isEmpty` is about the DOCUMENT — is there anything in it at all —
 * and that is the question the branch of the tree is drawn on, though the
 * interface asks it in its own words (`doc.nodes.length` in `proposalTreeStyle`)
 * rather than through this module: a reader who ticked every node off must
 * still see the rows, or there is nothing left to untick. This one is about the
 * PROJECTION, and it is
 * what the two places that build the text gate on — `proposalAddStyle` offering
 * the link, and the revision swap re-rendering an attachment it already has.
 * Without it, both would attach a `proposal` block that says nothing but
 * `units:` and `result =`, which is the agent handed a heading and asked to
 * design against it.
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
 * WHAT ASKS FOR IT. Everything that wants a shape or a field — the table this
 * module's own projection draws, and the rows the panel builds out of each op's
 * dimensions — because a move has neither. And everything that works by NAME,
 * which is the half that would fail quietly rather than throw: a body's name is
 * its part's name in the payload and has to be unique among bodies (`firstFree`),
 * while a move's is a row of the BUILD's, which the reader never chose and is
 * free to be the same word. Run together, a part dragged in the scene renames
 * the reader's own body out from under them, and a drag of that body finds the
 * move under the same name and asks it for an `at` it does not have.
 */
export function bodies(doc) {
  return doc.nodes.filter((node) => node.role !== MOVE)
}

/**
 * The same document with every move dropped and every body kept.
 *
 * WHAT A BUILD LANDING COSTS THE DOCUMENT. A delta is measured against where one
 * particular build put one particular part, so a rebuild — or another revision,
 * or another view — leaves it describing nothing: the viewport puts every part
 * back where the model says it goes and clears its own map with it. The bodies
 * are not touched, because a motor the model has to clear is as true of the
 * build arriving as of the one that left.
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
 * BINARY FLOATING POINT IS THE WHOLE OF IT, and the places it reaches are not
 * places this panel has: `42.4 + 0.1` is `42.400000000000006` and six tenths
 * multiplied out of a snap step is `0.6000000000000001`. Every number this
 * document holds is drawn in the panel and printed in the projection an agent
 * reads, so a rounding that keeps the digits that are real and drops only those
 * is a property of the DOCUMENT rather than of one writer.
 *
 * IT IS APPLIED WHERE THE ARITHMETIC IS, and that is the rule for who calls it.
 * There are three such places: `moveNodes` below, which ADDS a delta to a
 * body's `at`; `turnedFrom` beside it, which COMPOSES a turn onto a body's
 * `rot` and gets a dozen digits of `atan2` back for it; and `snap` in
 * viewport/tools.js, which multiplies a step back out — that last one is on the
 * far side of the event wire, and is why this is exported at all.
 * Nothing rounds a number a second time on its way past: the
 * `hmr:moved` handler writes the delta it was handed exactly as `snap` made it,
 * because a rounding there would be two places having to agree about a value
 * neither of them computed.
 */
export function tidy(value) {
  return Math.round(value * 1e6) / 1e6
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
 * IDS AND NOT A NAME, so this module still knows nothing about the geometry:
 * which body a grab means — the one it was drawn under, since the payload gives
 * every body a part of its own (proposalgeom.js) — is a fact about the PAYLOAD,
 * and answering it here would make this module import the kernel it is kept
 * apart from.
 *
 * ROUNDED (`tidy`), and to a place no dimension in this panel reaches. `at` is
 * drawn in a field and printed in the projection, so `42.3 + 0.1` has to read as
 * `42.4` and not as `42.400000000000006` — a number nobody typed, in a field the
 * reader is looking at, on the first drag of a body they had placed by hand.
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
 * WHAT "TURNED BY" MEANS, IN ONE PLACE, and it is one place because two sides
 * have to agree: `turnNodes` below writes it into a body's `rot`, and the
 * viewport's rings compute the pose they put under the reader's hand out of
 * this very function (`onMove` in viewport/rings.js). Two hand-written copies
 * would not fail — they would drift, and the drift is a body that turns one way
 * while the hand is down and lands facing another when it comes off.
 *
 * ADDING THE ANGLE TO ONE OF THE THREE IS NOT IT. `rot` is read as `Rz·Ry·Rx`
 * (`quaternionOf` in viewport/math.js), so adding to the x field is a turn
 * about world x only while y and z are both zero. A body standing at
 * `(0, 0, 90)` and given 30 on x by addition turns about world Y — and it is
 * the second gesture on any body that finds it, which is exactly the way a bug
 * goes unnoticed. Composed as a rotation and brought back through `anglesOf`,
 * the answer is the turn the reader asked for, whatever the body was standing
 * at.
 *
 * THE THREE FIELDS WILL NOT READ AS WHOLE DEGREES AFTERWARDS, and that is the
 * honest half of the trade rather than a rounding that got away: the gesture is
 * a whole number of degrees about the axis the hand grabbed, and the three
 * numbers that PRODUCE that orientation are whatever they are — 30 about x on
 * top of `(0, 0, 90)` is `(0, -30, 90)`. Every CAD tool answers the same way,
 * and the alternative — three fields that stay round — cannot describe the
 * turn at all.
 *
 * ROUNDED (`tidy`) BECAUSE THE ARITHMETIC IS HERE, which is the rule
 * `moveNodes` keeps one field over: `atan2` comes back with a dozen digits no
 * hand put there, and every number this document holds is drawn in a field and
 * printed in the projection an agent reads.
 */
export function turnedFrom(standing, applied) {
  return anglesOf(after(quaternionOf(applied), quaternionOf(standing))).map(tidy)
}

/**
 * Those nodes turned by `turn`, three degrees about the three WORLD axes.
 *
 * `moveNodes` ONE FIELD OVER, and it is a separate door for the reason the two
 * events behind them are separate names: the viewport tells a drag of a body
 * from a turn of one at the press and says which it was, so neither door has to
 * ask. `rot` is where a body's own pose lives (the head of this file says why
 * it is spelled differently from a move's `turn`).
 *
 * COMPOSED AND NOT SET, which is what makes the gesture repeatable: the
 * viewport has never read this document, so what it can honestly report about a
 * body is how far this one gesture took it, and the pose it took it FROM is
 * here. A part of the BUILD is the other way round — the viewport knows the
 * pose the build gave it, so it reports the whole turn and the node is
 * replaced.
 *
 * AND COMPOSED RATHER THAN ADDED, which is a different word for a different
 * sum: `turnedFrom` above is the whole of it.
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
 * WHAT THE BODIES MINT THEIR NAMES BY — `freeName` in HammerolaViewer.jsx,
 * which builds the set of names the document has already taken. It lives here
 * rather than beside that caller because a name is a fact about the DOCUMENT:
 * two bodies under one name are one part in the payload and one row in the tree,
 * whichever field the name was typed into.
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
 *
 * THE MOVES ARE A BLOCK OF THEIR OWN and are aligned among THEMSELVES, which is
 * the whole reason they are not a seventh column or a seventh kind of row. What
 * a move shares with a body is a NAME and a turn — `turn` and `rot` are the same
 * three degrees about the same three axes, and both are dropped from the line
 * when they are all zero. What it does not share is the half that makes the
 * body's table wide: no op and no size, because the part is already in the
 * model, and its place is a `by (…)` measured from wherever the build puts it
 * rather than an `at (…)` in the document's own space. Folded into that table, a
 * move would pad every body's columns out to make room for two cells that mean
 * something else. They come after the bodies and before the `result` line
 * because the parts they name are the ones the build already has: the bodies say
 * what is being asked for, the moves say where the existing thing should go, and
 * the last line is what the two together come to.
 *
 * A NODE TICKED OFF IS NOT HERE AT ALL (`unskipped`), in either table and in
 * neither's widths: it is left out the way a node that was deleted would be, so
 * the columns close up behind it and the agent is never shown a line the reader
 * decided not to send. Held back rather than deleted, because the thing itself
 * stays — see `skip` at the head of this file.
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

  // ONE SPACE AND NOT TWO between the columns, so that a proposal with a single
  // move in it reads exactly as the sentence it is — `move "bracket" by
  // (3, 0, 0)` — and the padding only ever appears when there is a longer entry
  // beside it to line up with.
  //
  // THE TURN IS LEFT OFF WHOLE WHERE IT IS NOTHING, exactly as the body table
  // drops `rot (…)`: a part somebody only slid across the scene should not read
  // as one they decided not to turn. The padding is trimmed with it, so a block
  // nobody turned anything in ends every line at `by (…)` as it always did.
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
