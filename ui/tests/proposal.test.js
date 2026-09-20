// ui/src/proposal.js and ui/src/proposalgeom.js — the panel's pure core.
//
// Everything the panel is made of that a browser is not needed for: the
// document, the text an agent reads off it, and the payload the viewport gets.
// The two halves are tested together because they only mean anything together —
// a document that holds the numbers somebody typed is worth nothing if the body
// they describe comes out the wrong size, and the volume checks below are what
// says it does not.
//
// THE PAYLOAD IS MEASURED RATHER THAN INSPECTED wherever a number is the point.
// `volumeOf` rebuilds a geometry out of the flat arrays a part actually carries
// and hands it back to the same kernel, so a hole that fails to cut, a
// triangulation that winds a face backwards or a fan that skips a corner all
// come out as a volume that is wrong — none of which reading the arrays would
// notice.

import { describe, expect, it } from 'vitest'
import { geometries, measurements, transforms } from '@jscad/modeling'

import {
  addNode, bodies, dropMoves, emptyProposal, isEmpty, moveNodes, moves,
  removeNode, proposalText, sendsNothing, tidy, turnNodes, updateNode,
} from '../src/proposal.js'
import { buildProposal } from '../src/proposalgeom.js'

const KORPUS = {
  id: 'n1', name: 'korpus', op: 'box', role: 'solid',
  at: [0, 0, 0], rot: [0, 0, 0], size: [42.3, 42.3, 40],
}
const VAL = {
  id: 'n2', name: 'val', op: 'cylinder', role: 'solid',
  at: [0, 0, 42], rot: [0, 0, 0], d: 5, h: 24,
}
const KREPEZH = {
  id: 'n3', name: 'krepezh1', op: 'cylinder', role: 'hole',
  at: [15.5, 15.5, 36], rot: [0, 45, 0], d: 3, h: 10,
}
// A PART OF THE BUILD, DRAGGED — the other kind of node. No op and no size: the
// part is already in the model and nothing here draws it. `paths` is the scene's
// own, `name` is the row as it read at the moment of the drag, and the second
// one carries a counted name because that is what a row of copies reads as.
//
// `turn` IS ON BOTH OF THEM AT NOTHING, because that is the state a dragged part
// is recorded in: the hand says where, and the turn is typed afterwards. The one
// that was turned is `TURNED_MOVE` below.
const MOVE = {
  id: 'm4', role: 'move', paths: ['/model/plate'], name: 'plate',
  delta: [3.2, 0, -1], turn: [0, 0, 0],
}
const OTHER_MOVE = {
  id: 'm5', role: 'move', name: 'pin ×3', delta: [0, 0, 5], turn: [0, 0, 0],
  paths: ['/model/pin', '/model/pin(2)', '/model/pin(3)'],
}
const TURNED_MOVE = {
  id: 'm6', role: 'move', paths: ['/model/bracket'], name: 'bracket',
  delta: [0, 0, 12], turn: [0, 0, 90],
}

/** The document the text projection is pinned against: three bodies, a hole, a rotation. */
function motor() {
  return addNode(addNode(addNode(emptyProposal(), KORPUS), VAL), KREPEZH)
}

/** A document with one node in it, whatever that node is. */
const just = (node) => addNode(emptyProposal(), node)

/** The volume of a part, measured off the flat arrays the payload actually carries. */
function volumeOf(part) {
  const { vertices, triangles } = part.shape
  const point = (index) => [
    vertices[index * 3], vertices[index * 3 + 1], vertices[index * 3 + 2],
  ]
  const polygons = []
  for (let corner = 0; corner < triangles.length; corner += 3) {
    polygons.push(geometries.poly3.create([
      point(triangles[corner]), point(triangles[corner + 1]), point(triangles[corner + 2]),
    ]))
  }
  return measurements.measureVolume(geometries.geom3.create(polygons))
}

/**
 * A bounding box against six numbers.
 *
 * NOT `toEqual`, because `measureBoundingBox` returns a signed zero wherever an
 * extent lands exactly on an axis and `Object.is(-0, 0)` is false — a difference
 * that survives no serialisation and means nothing to the viewer, but fails a
 * deep-equality assertion with a diff nobody can see.
 */
function expectBox(bb, expected) {
  for (const [face, value] of Object.entries(expected)) {
    expect(bb[face], face).toBeCloseTo(value, 9)
  }
}

/** Everything about a payload that is true whatever is in the document. */
function expectWellFormed(payload) {
  expect(payload.version).toBe(3)
  expect(payload.normal_len).toBe(0)
  expect(payload.id).toBe(`/${payload.name}`)
  expect(payload.loc).toEqual([[0, 0, 0], [0, 0, 0, 1]])
  expect(Object.keys(payload.bb).sort())
    .toEqual(['xmax', 'xmin', 'ymax', 'ymin', 'zmax', 'zmin'])
  for (const value of Object.values(payload.bb)) expect(Number.isFinite(value)).toBe(true)

  for (const part of payload.parts) {
    expect(part.type).toBe('shapes')
    expect(part.subtype).toBe('solid')
    expect(part.state).toEqual([1, 1])
    // NO CATALOGUE KEY, and its absence is the assertion. `key` is the entry in
    // `meta.parts` a row looks its files, its note and its kind up by; a proposal
    // body is in no catalogue at all, so a `key` here made the row offer a
    // reader's note and store it under whatever real key the name collided with.
    expect('key' in part).toBe(false)
    expect(part.id).toBe(`/${payload.name}/${part.name}`)
    expect(part.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(part.loc).toEqual([[0, 0, 0], [0, 0, 0, 1]])

    const shape = part.shape
    expect(Object.keys(shape).sort())
      .toEqual(['edges', 'normals', 'obj_vertices', 'triangles', 'vertices'])
    // A normal per vertex, and both in whole triples.
    expect(shape.normals.length).toBe(shape.vertices.length)
    expect(shape.vertices.length % 3).toBe(0)
    expect(shape.triangles.length % 3).toBe(0)
    expect(shape.obj_vertices.length % 3).toBe(0)
    // Every index points at a vertex that exists — the one way a payload can be
    // built out of plausible-looking arrays and still be unrenderable.
    const points = shape.vertices.length / 3
    for (const index of shape.triangles) {
      expect(Number.isInteger(index)).toBe(true)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(points)
    }
    // Edges are points in pairs, each point a triple.
    expect(shape.edges.length % 2).toBe(0)
    for (const edgePoint of shape.edges) expect(edgePoint).toHaveLength(3)
  }
}

describe('the document', () => {
  it('starts empty and says so', () => {
    expect(emptyProposal()).toEqual({ version: 1, units: 'mm', nodes: [] })
    expect(isEmpty(emptyProposal())).toBe(true)
  })

  it('is no longer empty once a body has been put in it', () => {
    expect(isEmpty(just(VAL))).toBe(false)
  })
})

describe('the immutable helpers', () => {
  // Each helper against the same question: the document handed in is the
  // document still there afterwards. The panel keeps the previous state to undo
  // to, so a helper that edited in place would make undo a no-op — which is
  // invisible until somebody tries it.
  const doc = motor()
  const cases = [
    ['addNode', 'nodes', (d) => addNode(d, { ...VAL, id: 'n9', name: 'extra' })],
    ['removeNode', 'nodes', (d) => removeNode(d, 'n2')],
    ['updateNode', 'nodes', (d) => updateNode(d, 'n2', { at: [1, 2, 3] })],
    ['moveNodes', 'nodes', (d) => moveNodes(d, ['n2'], [1, 2, 3])],
  ]

  for (const [name, touched, apply] of cases) {
    it(`${name} leaves its input untouched`, () => {
      const before = JSON.stringify(doc)
      const after = apply(doc)
      expect(JSON.stringify(doc)).toBe(before)
      expect(after).not.toBe(doc)
      // The collection it edits is a NEW array, not the same one written into —
      // which is what `JSON.stringify` above cannot tell apart from a helper
      // that copied the document and then mutated the copy's array in place.
      expect(after[touched]).not.toBe(doc[touched])
    })
  }

  it('each one actually did the thing it was asked to do', () => {
    expect(addNode(doc, { ...VAL, id: 'n9' }).nodes).toHaveLength(4)
    expect(removeNode(doc, 'n2').nodes.map((node) => node.id)).toEqual(['n1', 'n3'])
    expect(updateNode(doc, 'n2', { at: [1, 2, 3] }).nodes[1].at).toEqual([1, 2, 3])
    expect(updateNode(doc, 'n2', { at: [1, 2, 3] }).nodes[1].name).toBe('val')
    // A MOVE IS RELATIVE where the write above is absolute — `val` sits at
    // `[0, 0, 42]`, so it lands three millimetres further up and the bodies
    // nobody grabbed stay where they are. The `at` it writes is a new array
    // too: the same in-place edit `updateNode` is checked against, one level
    // down, where `JSON.stringify` would not see it either.
    expect(moveNodes(doc, ['n2'], [1, 2, 3]).nodes[1].at).toEqual([1, 2, 45])
    expect(moveNodes(doc, ['n2'], [1, 2, 3]).nodes[0].at).toEqual(doc.nodes[0].at)
    expect(moveNodes(doc, ['n2'], [1, 2, 3]).nodes[1].at).not.toBe(doc.nodes[1].at)
    // EVERY NAMED NODE AND ONLY THOSE, which is the rule a grab lands on: the
    // panel names the one body that was dragged, and nothing else may shift.
    expect(moveNodes(doc, ['n1', 'n2', 'n3'], [1, 0, 0]).nodes.map((n) => n.at[0]))
      .toEqual([1, 1, 16.5])
  })
})

describe('turnNodes', () => {
  // A TURN IS COMPOSED ONTO `rot` AND NOT ADDED TO IT, which is the one thing
  // this door does that `moveNodes` beside it does not have to think about: an
  // offset is three independent numbers and an orientation is not. `placed`
  // reads `rot` as `Rz·Ry·Rx`, so adding to the x field is a turn about world x
  // only while y and z are both zero — and the gesture that produces these
  // numbers is a ring the reader grabbed, which promises a turn about THAT
  // world axis whatever the body was already standing at.

  /** Where the document's own kernel sends a point for a body at `rot` —
   *  `transforms.rotate` is what `placed` in proposalgeom.js turns one with, so
   *  this is the rotation the reader will actually be shown. */
  const spun = (rot, point) => [...geometries.geom3.toPolygons(transforms.rotate(
    rot.map((angle) => (angle * Math.PI) / 180),
    geometries.geom3.create([geometries.poly3.create([point, [0, 0, 0], [0, 0, 1]])]),
  ))[0].vertices[0]]

  const turned1 = (rot, turn) =>
    turnNodes(just({ ...KORPUS, rot }), ['n1'], turn).nodes[0].rot

  it('composes the turn onto the pose the body was standing at', () => {
    // THE CASE THE ADDITION GETS WRONG, and it is the reader's SECOND gesture
    // on any body rather than an exotic one: a body standing at a quarter turn
    // about z, grabbed by the x ring and swept thirty degrees. Added, the three
    // fields read `(30, 0, 90)` and the body turns about world Y.
    expect(turned1([0, 0, 90], [30, 0, 0])).toEqual([0, -30, 90])

    // AND THE ANSWER IS CHECKED AS A ROTATION rather than as three numbers,
    // through the kernel that will really build the body: the point the body
    // stood at, turned thirty about world x, is where the new `rot` puts it.
    const point = [7, -3, 11]
    const wanted = spun([30, 0, 0], spun([0, 0, 90], point))
    spun(turned1([0, 0, 90], [30, 0, 0]), point)
      .forEach((value, axis) => expect(value).toBeCloseTo(wanted[axis], 9))
  })

  it('is an addition where the addition happens to be right', () => {
    // ABOUT ONE AXIS FROM SQUARE, and about the OUTERMOST axis from anywhere:
    // those are the cases where the two agree, and the panel's own tests lean
    // on them. Said here so that "composed" is not read as "different answer".
    expect(turned1([0, 0, 0], [0, 0, 30])).toEqual([0, 0, 30])
    expect(turned1([0, 0, 30], [0, 0, 15])).toEqual([0, 0, 45])
    expect(turned1([42.3, 0, 0], [0, 0, 90])).toEqual([42.3, 0, 90])
  })

  it('rounds to a place somebody could have typed, and names only its own', () => {
    // `atan2` comes back with a dozen digits no hand put there, and every
    // number here is drawn in a field and printed in the projection an agent
    // reads. `tidy` is applied where the arithmetic is, which is this sum.
    expect(turned1([42.3, 0, 0], [1, 0, 0])).toEqual([43.3, 0, 0])
    // EVERY NAMED NODE AND ONLY THOSE, the rule `moveNodes` keeps: the panel
    // names the one body the ring was on.
    const doc = turnNodes(motor(), ['n2'], [0, 0, 90])
    expect(doc.nodes.map((node) => node.rot))
      .toEqual([[0, 0, 0], [0, 0, 90], [0, 45, 0]])
  })
})

describe('proposalText', () => {
  it('renders the projection byte for byte', () => {
    expect(proposalText(motor())).toBe([
      'units: mm',
      '',
      'solid  box       "korpus"    42.3 x 42.3 x 40  at (0, 0, 0)',
      'solid  cylinder  "val"       d5 h24            at (0, 0, 42)',
      'hole   cylinder  "krepezh1"  d3 h10            at (15.5, 15.5, 36)  rot (0, 45, 0)',
      '',
      'result = union(solid) - union(hole)',
    ].join('\n'))
  })

  it('is one body and the units where that is all there is', () => {
    expect(proposalText(just(VAL))).toBe([
      'units: mm',
      '',
      'solid  cylinder  "val"  d5 h24  at (0, 0, 42)',
      '',
      'result = union(solid) - union(hole)',
    ].join('\n'))
  })

  it('prints a rotation only where there is one', () => {
    const lines = proposalText(motor()).split('\n')
    expect(lines.filter((line) => line.includes('rot (')))
      .toEqual([lines.find((line) => line.startsWith('hole'))])
    // ...and the line that has none ends at its placement rather than trailing
    // the width of a column that was padded for somebody else.
    expect(lines.find((line) => line.includes('"val"'))).toMatch(/at \(0, 0, 42\)$/)
  })

  it('spells the sphere and the cylinder the way the box is spelled', () => {
    expect(proposalText(addNode(just({
      id: 'a', name: 'ball', op: 'sphere', role: 'solid',
      at: [0, 0, 0], rot: [0, 0, 0], d: 10,
    }), {
      id: 'b', name: 'post', op: 'cylinder', role: 'solid',
      at: [0, 0, -10], rot: [0, 0, 0], d: 6, h: 3,
    }))).toBe([
      'units: mm',
      '',
      // EVERY BODY'S SHAPE IS IN ITS NUMBERS, which is what lets one column
      // width serve all three: the ops left are the primitives, and a primitive
      // is said in full by the two or three measurements beside its name.
      'solid  sphere    "ball"  d10    at (0, 0, 0)',
      'solid  cylinder  "post"  d6 h3  at (0, 0, -10)',
      '',
      'result = union(solid) - union(hole)',
    ].join('\n'))
  })

  it('says what an empty document is, rather than nothing at all', () => {
    expect(proposalText(emptyProposal())).toBe([
      'units: mm',
      '',
      'result = union(solid) - union(hole)',
    ].join('\n'))
  })

  it('prints the moves in a block of their own, after the bodies', () => {
    // A MOVE IS THE OTHER STATEMENT THIS DOCUMENT HOLDS: the bodies say what the
    // model has to fit, and a move says where a part the build already has
    // should be instead. Its own block because it shares no column with a body —
    // folded into that table, every body's columns would be padded out to make
    // room for a sentence that is not in them.
    expect(proposalText(addNode(addNode(just(VAL), MOVE), OTHER_MOVE))).toBe([
      'units: mm',
      '',
      'solid  cylinder  "val"  d5 h24  at (0, 0, 42)',
      '',
      // ALIGNED AMONG THEMSELVES, on the name, so the offsets read down the
      // page — and with one space between the halves, so a single move reads
      // exactly as the sentence it is.
      'move "plate"  by (3.2, 0, -1)',
      'move "pin ×3" by (0, 0, 5)',
      '',
      'result = union(solid) - union(hole)',
    ].join('\n'))
  })

  it('is the units, one move and the result where that is all there is', () => {
    expect(proposalText(just(MOVE))).toBe([
      'units: mm',
      '',
      'move "plate" by (3.2, 0, -1)',
      '',
      'result = union(solid) - union(hole)',
    ].join('\n'))
  })

  it('prints the turn beside the offset, on the moves that have one', () => {
    // THE SAME THREE DEGREES A BODY'S `rot (…)` PRINTS, in the sentence about a
    // part the build already has — and the padding is measured among the moves
    // alone, so the turned one does not push the others' `by (…)` about.
    expect(proposalText(addNode(just(MOVE), TURNED_MOVE))).toBe([
      'units: mm',
      '',
      'move "plate"   by (3.2, 0, -1)',
      'move "bracket" by (0, 0, 12)   turned (0, 0, 90)',
      '',
      'result = union(solid) - union(hole)',
    ].join('\n'))
  })

  it('leaves the cell off entirely where nothing was turned', () => {
    // EXACTLY AS THE BODY TABLE DROPS `rot (…)`: a part somebody only slid
    // across the scene should not read as one they decided not to turn, and the
    // padding that would have lined the cell up goes with it.
    const text = proposalText(addNode(just(VAL), MOVE))
    expect(text).toContain('move "plate" by (3.2, 0, -1)')
    expect(text).not.toContain('turned')
  })

  it('leaves the bodies\' own columns exactly as they were', () => {
    // The two blocks are measured apart, so the longest move in the document
    // cannot push a body's `at (…)` sideways.
    expect(proposalText(motor()).split('\n\n')[1])
      .toBe(proposalText(addNode(motor(), MOVE)).split('\n\n')[1])
  })
})

describe('a node ticked off', () => {
  // WHAT `skip` IS: a sentence the reader wrote and decided not to send. The
  // node stays in the document, the body stays over the model, the move stays
  // applied — and the projection does not mention it. Everything here is about
  // the projection, because that is the only thing the flag changes.

  /** The same node, held back. */
  const held = (node) => ({ ...node, skip: true })

  it('is left out of the body table, and the columns close up behind it', () => {
    // NOT BLANKED AND NOT GREYED — left out the way a deleted node would be, so
    // the widths are measured over what is actually sent. `krepezh1` is the
    // longest name in `motor()`, so a table that kept padding for it would be
    // this assertion off by two spaces.
    const doc = { ...motor(), nodes: motor().nodes.map(
      (node) => (node.id === 'n3' ? held(node) : node)) }

    expect(proposalText(doc)).toBe([
      'units: mm',
      '',
      'solid  box       "korpus"  42.3 x 42.3 x 40  at (0, 0, 0)',
      'solid  cylinder  "val"     d5 h24            at (0, 0, 42)',
      '',
      'result = union(solid) - union(hole)',
    ].join('\n'))
  })

  it('is left out of the move block too, on the same terms', () => {
    // A MOVE IS AS HOLDABLE-BACK AS A BODY. It is a statement about the model
    // exactly as a body is, so there is no reason for the tick to mean anything
    // different on one — and the block's own widths are measured over the moves
    // that survive, which `pin ×3` being the longer name is what shows.
    const doc = addNode(addNode(just(VAL), MOVE), held(OTHER_MOVE))

    expect(proposalText(doc)).toBe([
      'units: mm',
      '',
      'solid  cylinder  "val"  d5 h24  at (0, 0, 42)',
      '',
      'move "plate" by (3.2, 0, -1)',
      '',
      'result = union(solid) - union(hole)',
    ].join('\n'))
  })

  it('leaves the document itself untouched, which is what makes it undoable', () => {
    // The flag is a FIELD OF THE NODE and nothing else is derived from it: the
    // node is still a body, still counted, still there to be unticked.
    const doc = addNode(just(held(VAL)), MOVE)

    expect(doc.nodes).toHaveLength(2)
    expect(bodies(doc).map((node) => node.id)).toEqual(['n2'])
    expect(moves(doc)).toEqual([MOVE])
    expect(isEmpty(doc)).toBe(false)
  })
})

describe('sendsNothing', () => {
  it('is false while one node survives, of either kind', () => {
    expect(sendsNothing(just(VAL))).toBe(false)
    expect(sendsNothing(just(MOVE))).toBe(false)
    expect(sendsNothing(addNode(just({ ...VAL, skip: true }), MOVE))).toBe(false)
  })

  it('is true on an empty document, and on one ticked off to the last node', () => {
    expect(sendsNothing(emptyProposal())).toBe(true)
    expect(sendsNothing(addNode(
      just({ ...VAL, skip: true }), { ...MOVE, skip: true }))).toBe(true)
  })

  it('does not make `isEmpty` answer the same way, which is the whole point', () => {
    // THE TWO PREDICATES ARE ASKED BY DIFFERENT READERS. `isEmpty` is about the
    // DOCUMENT and is what the branch of the tree is drawn on — a reader who
    // ticked every node off must still see the rows, or there is nothing left
    // to untick. `sendsNothing` is about the PROJECTION, and is what the doors
    // out gate on. Fold them together and the branch disappears at the moment
    // the reader most needs it.
    const doc = just({ ...VAL, skip: true })

    expect(sendsNothing(doc)).toBe(true)
    expect(isEmpty(doc)).toBe(false)
    expect(doc.nodes).toHaveLength(1)
  })

  it('says nothing about a document that projects to bodies alone', () => {
    // The swap asks this of `dropMoves(doc)`, so the case that matters is a
    // document whose moves have gone and whose bodies are all ticked off.
    expect(sendsNothing(dropMoves(addNode(just({ ...VAL, skip: true }), MOVE))))
      .toBe(true)
    expect(sendsNothing(dropMoves(addNode(just(VAL), MOVE)))).toBe(false)
  })
})

describe('the moves a document holds', () => {
  const doc = addNode(addNode(just(VAL), MOVE), KREPEZH)

  it('are told from the bodies by their role, both ways round', () => {
    expect(moves(doc)).toEqual([MOVE])
    expect(bodies(doc).map((node) => node.id)).toEqual(['n2', 'n3'])
  })

  it('go away on their own, and leave every body where it was', () => {
    // WHAT A BUILD LANDING COSTS THE DOCUMENT: a delta is measured against where
    // one build put one part, and the bodies are about no build at all.
    expect(dropMoves(doc).nodes).toEqual([VAL, KREPEZH])
    expect(dropMoves(doc)).not.toBe(doc)
    expect(doc.nodes).toHaveLength(3)
  })

  it('are rounded by the same rule a dragged body is', () => {
    // ONE RULE FOR BOTH WRITERS, which is why `tidy` is the document's and not
    // a line inside either of them: a drag arrives snapped to a step (`snap` in
    // viewport/tools.js) and binary floating point puts the result at places no
    // field in this panel has. Both numbers below are what that arithmetic
    // really produces.
    expect(tidy(Math.round(0.6 / 0.1) * 0.1)).toBe(0.6)
    expect(tidy(42.3 + 0.1)).toBe(42.4)
    // ...and a digit somebody could have typed is not touched.
    expect(tidy(-12.5)).toBe(-12.5)
    expect(tidy(0.000002)).toBe(0.000002)
  })

  it('are removed one at a time by the helper every node is', () => {
    // `removeNode` keys on `id`, so deleting a move — which is how a part is put
    // back — needs nothing of its own.
    expect(moves(removeNode(doc, MOVE.id))).toEqual([])
    expect(removeNode(doc, MOVE.id).nodes).toHaveLength(2)
  })
})

describe('buildProposal', () => {
  it('builds a payload for a box, and the box is the size it was asked for', () => {
    const payload = buildProposal(just({
      id: 'b', name: 'block', op: 'box', role: 'solid',
      at: [1, 2, 3], rot: [0, 0, 0], size: [10, 4, 2],
    }))
    expectWellFormed(payload)
    expect(payload.parts).toHaveLength(1)
    expect(volumeOf(payload.parts[0])).toBeCloseTo(80, 6)
    // `at` is the centre of a box, so the bounding box straddles it.
    expectBox(payload.bb, { xmin: -4, xmax: 6, ymin: 0, ymax: 4, zmin: 2, zmax: 4 })
  })

  it('builds a payload for a cylinder', () => {
    const payload = buildProposal(just(VAL))
    expectWellFormed(payload)
    // Tessellated, so short of the ideal by the chord error and never over it.
    const ideal = Math.PI * 2.5 * 2.5 * 24
    expect(volumeOf(payload.parts[0])).toBeLessThan(ideal)
    expect(volumeOf(payload.parts[0])).toBeGreaterThan(ideal * 0.97)
    expect(payload.bb.zmin).toBeCloseTo(30, 9)
    expect(payload.bb.zmax).toBeCloseTo(54, 9)
  })

  it('builds a payload for a sphere', () => {
    const payload = buildProposal(just({
      id: 's', name: 'ball', op: 'sphere', role: 'solid',
      at: [0, 0, 0], rot: [0, 0, 0], d: 10,
    }))
    expectWellFormed(payload)
    const ideal = (4 / 3) * Math.PI * 125
    expect(volumeOf(payload.parts[0])).toBeLessThan(ideal)
    expect(volumeOf(payload.parts[0])).toBeGreaterThan(ideal * 0.97)
  })

  it('turns a node by the rotation the document gives it, in degrees', () => {
    const payload = buildProposal(just({
      id: 'b', name: 'block', op: 'box', role: 'solid',
      at: [0, 0, 0], rot: [0, 0, 45], size: [10, 10, 2],
    }))
    // A square on its corner is as wide as its diagonal. Radians would have
    // turned it 45 of them — two and a half turns — and landed somewhere that
    // still looks like a box.
    expect(payload.bb.xmax).toBeCloseTo(Math.sqrt(200) / 2, 9)
    expect(payload.bb.zmax).toBeCloseTo(1, 9)
  })

  it('cuts a hole out of the body, and the volume says so', () => {
    const plate = {
      id: 'p', name: 'plate', op: 'box', role: 'solid',
      at: [0, 0, 0], rot: [0, 0, 0], size: [20, 20, 10],
    }
    const bore = {
      id: 'h', name: 'bore', op: 'cylinder', role: 'hole',
      at: [0, 0, 0], rot: [0, 0, 0], d: 6, h: 20,
    }
    const whole = volumeOf(buildProposal(just(plate)).parts[0])
    const drilled = volumeOf(buildProposal(addNode(just(plate), bore)).parts[0])
    expect(whole).toBeCloseTo(4000, 6)
    // The bore goes right through, so what left is its full length inside the
    // plate — a tessellated cylinder, so just under the ideal.
    const removed = whole - drilled
    const ideal = Math.PI * 9 * 10
    expect(removed).toBeLessThan(ideal)
    expect(removed).toBeGreaterThan(ideal * 0.97)
  })

  it('gives every solid a part of its own, each one already cut by the holes', () => {
    // WHAT THE HAND NEEDS. A part is what the Move tool grabs, so two solids
    // fused into one part could only ever move together — which is the thing
    // this payload used to do and the reason it no longer does. Each body is
    // cut by every hole all the same: a hole belongs to the proposal, not to
    // whichever body it happens to sit inside.
    const plate = (id, name, x) => ({
      id, name, op: 'box', role: 'solid',
      at: [x, 0, 0], rot: [0, 0, 0], size: [10, 10, 10],
    })
    const payload = buildProposal(addNode(addNode(
      just(plate('a', 'left', -10)), plate('b', 'right', 10),
    ), {
      // One bore, lying along x and long enough to reach both plates.
      id: 'h', name: 'bore', op: 'cylinder', role: 'hole',
      at: [0, 0, 0], rot: [0, 90, 0], d: 4, h: 60,
    }))
    expectWellFormed(payload)
    expect(payload.parts.map((part) => part.name)).toEqual(['left', 'right', 'bore'])

    for (const name of ['left', 'right']) {
      const [body] = payload.parts.filter((part) => part.name === name)
      // A 10 mm cube is 1000, and the bore crosses the whole of it: what is
      // gone is the cylinder's own volume, tessellated and so just under ideal.
      const removed = 1000 - volumeOf(body)
      const ideal = Math.PI * 4 * 10
      expect(removed, name).toBeLessThan(ideal)
      expect(removed, name).toBeGreaterThan(ideal * 0.97)
    }
  })

  it('shows every hole as a part of its own, translucent, beside the bodies', () => {
    const payload = buildProposal(motor())
    expectWellFormed(payload)
    expect(payload.parts.map((part) => part.name)).toEqual(['korpus', 'val', 'krepezh1'])
    expect(payload.parts[0].alpha).toBe(1)

    const [hole] = payload.parts.filter((part) => part.name === 'krepezh1')
    // The whole reason the tool is in the payload at all: a hole inside the body
    // is invisible unless it is drawn over it, and drawn over it opaque it hides
    // the body instead.
    expect(hole.alpha).toBeGreaterThan(0)
    expect(hole.alpha).toBeLessThan(1)
    expect(hole.color).not.toBe(payload.parts[0].color)
    expect(hole.shape.vertices.length).toBeGreaterThan(0)
  })

  it('carries every body`s own origin, which the mesh cannot say', () => {
    // THE ONE FIELD ON A PART THAT THE VIEWER NEVER READS. `placed` rotates a
    // body in its OWN coordinates and only then carries it to `at`, so `at` is
    // the single world point a change of `rot` leaves where it is — and the
    // mesh handed over has all of that baked into its vertices under an
    // identity `loc`, which leaves the scene no way to answer for it. The
    // viewport turns a body under the reader's hand about this point, because
    // it is the point the DOCUMENT will turn it about; about the centre of the
    // body's box instead, a quarter turn of a 100 mm extrusion previews 70 mm
    // from where it lands.
    const payload = buildProposal(motor())
    const origins = Object.fromEntries(
      payload.parts.map((part) => [part.name, part.origin]))
    expect(origins).toEqual({
      korpus: [0, 0, 0], val: [0, 0, 42], krepezh1: [15.5, 15.5, 36],
    })
    // A COPY AND NOT THE NODE'S OWN ARRAY, the rule every helper in this module
    // keeps: the payload is handed to the viewport and outlives the edit that
    // built it.
    expect(payload.parts[1].origin).not.toBe(motor().nodes[1].at)
  })

  it('answers for a document with nothing in it', () => {
    // No bodies, so no parts — and no envelope either, since there is nothing to
    // measure. The frame falls back to the origin rather than being asked of the
    // kernel, which is where the first body will arrive anyway.
    const payload = buildProposal(emptyProposal())
    expectWellFormed(payload)
    expect(payload.parts).toEqual([])
    expectBox(payload.bb, { xmin: 0, xmax: 0, ymin: 0, ymax: 0, zmin: 0, zmax: 0 })
  })

  it('answers for a document that is nothing but holes', () => {
    // Nothing to cut them out of, so the tools are all that is left to look at —
    // which is what somebody halfway through building a proposal has.
    const payload = buildProposal(just(KREPEZH))
    expectWellFormed(payload)
    expect(payload.parts.map((part) => part.name)).toEqual(['krepezh1'])
    expectBox(payload.bb, { xmin: 0, xmax: 0, ymin: 0, ymax: 0, zmin: 0, zmax: 0 })
  })

  it('draws nothing at all for a move, and is not thrown by a document of them', () => {
    // A MOVE IS NOT GEOMETRY. The part it names is already in the model and the
    // viewport shifts the one that is there, so a second copy drawn over it
    // would be the proposal claiming a body the reader never asked for. A
    // document with nothing but moves therefore builds no parts — the same
    // answer as an empty one, which is what the panel does with it.
    const payload = buildProposal(addNode(just(MOVE), OTHER_MOVE))
    expectWellFormed(payload)
    expect(payload.parts).toEqual([])
    expectBox(payload.bb, { xmin: 0, xmax: 0, ymin: 0, ymax: 0, zmin: 0, zmax: 0 })

    // And beside a body it changes neither the parts nor the frame around them.
    const alone = buildProposal(just(VAL))
    const beside = buildProposal(addNode(just(VAL), MOVE))
    expect(beside.parts.map((part) => part.name))
      .toEqual(alone.parts.map((part) => part.name))
    expect(beside.bb).toEqual(alone.bb)
  })

  it('names the optional tessellation fields nowhere, and the viewer guards them', () => {
    // face_types / edge_types / triangles_per_face / segments_per_edge are
    // OCCT's enumerations; a mesh kernel has nothing to say about them. The
    // library's readers are guarded, so leaving them out is a supported shape
    // rather than a gap — this pins that we leave them out DELIBERATELY, since
    // half-filling them would be worse than not filling them.
    const shape = buildProposal(just(VAL)).parts[0].shape
    for (const field of
      ['face_types', 'edge_types', 'triangles_per_face', 'segments_per_edge']) {
      expect(shape[field]).toBeUndefined()
    }
  })

  it('draws no wireframe, on a shape whose edges are obvious', () => {
    // A CUBE IS THE CASE THAT MAKES THIS LOOK WRONG, which is why it is the one
    // pinned: everybody knows a cube has twelve edges, so the temptation to emit
    // them is strongest here. A mesh does not know that. It has facet
    // boundaries, and nothing in it says which were a corner and which were a
    // circle chopped into segments — so on a cylinder or a sphere the same code
    // that draws a cube correctly draws its tessellation, and on anything a
    // boolean touched it draws seams across faces that are flat. Inventing a
    // line is worse here than drawing none: the person is looking at this to
    // judge a shape. See the comment on `mesh` for the three rules measured
    // before this one was chosen.
    const shape = buildProposal(just({
      id: 'c', name: 'cube', op: 'box', role: 'solid',
      at: [0, 0, 0], rot: [0, 0, 0], size: [2, 2, 2],
    })).parts[0].shape
    expect(shape.edges).toEqual([])
    expect(shape.obj_vertices).toEqual([])
    // The form still reads, and this is what carries it: one normal per face,
    // repeated across that face's own copies of its corners, so the faces shade
    // flat instead of rounding into each other.
    expect(shape.normals).toHaveLength(shape.vertices.length)
    expect(new Set(shape.normals.join(',').split(',')).size).toBeGreaterThan(1)
  })

  it('shades a curved body without inventing a single line on it', () => {
    // The other end of the same decision, and the one that cost the most to
    // learn: measured before this rule, a d16 sphere came back with 992 edges
    // and a d12 cylinder with 160 — the tessellation drawn as if it were the
    // design.
    for (const node of [
      { id: 's', name: 'ball', op: 'sphere', role: 'solid', d: 16 },
      { id: 'c', name: 'barrel', op: 'cylinder', role: 'solid', d: 12, h: 20 },
    ]) {
      const shape = buildProposal(just({
        at: [0, 0, 0], rot: [0, 0, 0], ...node,
      })).parts[0].shape
      expect(shape.edges).toEqual([])
      expect(shape.triangles.length).toBeGreaterThan(0)
    }
  })
})
