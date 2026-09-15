// ui/src/sketch.js and ui/src/sketchgeom.js — the sketch panel's pure core.
//
// Everything the panel is made of that a browser is not needed for: the
// document, the text an agent reads off it, and the payload the viewport gets.
// The two halves are tested together because they only mean anything together —
// a document whose dimensions resolve is worth nothing if the body they describe
// comes out the wrong size, and the volume checks below are what says it does
// not.
//
// THE PAYLOAD IS MEASURED RATHER THAN INSPECTED wherever a number is the point.
// `volumeOf` rebuilds a geometry out of the flat arrays a part actually carries
// and hands it back to the same kernel, so a hole that fails to cut, a
// triangulation that winds a face backwards or a fan that skips a corner all
// come out as a volume that is wrong — none of which reading the arrays would
// notice.

import { describe, expect, it } from 'vitest'
import { geometries, measurements } from '@jscad/modeling'

import {
  addNode, addParam, emptySketch, isEmpty, moveNodes, removeNode, removeParam,
  renameParam, resolveValue, sketchText, updateNode, updateParam, usedBy,
} from '../src/sketch.js'
import { buildSketch } from '../src/sketchgeom.js'

const BODY = {
  name: 'body', type: 'slider', caption: 'Body', initial: 42.3, min: 40, max: 45, step: 0.1,
}
const LENGTH = {
  name: 'length', type: 'number', caption: 'Length', initial: 40, min: 20, max: 60, step: 1,
}

const KORPUS = {
  id: 'n1', name: 'korpus', op: 'box', role: 'solid',
  at: [0, 0, 0], rot: [0, 0, 0], size: ['body', 'body', 'length'],
}
const VAL = {
  id: 'n2', name: 'val', op: 'cylinder', role: 'solid',
  at: [0, 0, 42], rot: [0, 0, 0], d: 5, h: 24,
}
const KREPEZH = {
  id: 'n3', name: 'krepezh1', op: 'cylinder', role: 'hole',
  at: [15.5, 15.5, 36], rot: [0, 45, 0], d: 3, h: 10,
}

/** The document the text projection is pinned against: params, a hole, a rotation. */
function motorMock() {
  return addNode(addNode(addNode(
    addParam(addParam(emptySketch(), BODY), LENGTH), KORPUS), VAL), KREPEZH)
}

/** A document with one node in it, whatever that node is. */
const just = (node) => addNode(emptySketch(), node)

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
    // `meta.parts` a row looks its files, its note and its kind up by; a sketch
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
    expect(emptySketch()).toEqual({ version: 1, units: 'mm', params: [], nodes: [] })
    expect(isEmpty(emptySketch())).toBe(true)
  })

  it('is no longer empty once anything has been put in it', () => {
    expect(isEmpty(just(VAL))).toBe(false)
    expect(isEmpty(addParam(emptySketch(), BODY))).toBe(false)
  })
})

describe('resolveValue', () => {
  it('hands a number straight back', () => {
    expect(resolveValue(emptySketch(), 12.5)).toBe(12.5)
  })

  it('resolves the name of a param into that param\'s value', () => {
    expect(resolveValue(addParam(emptySketch(), BODY), 'body')).toBe(42.3)
  })

  it('refuses a name no param carries, and says what it wanted', () => {
    const doc = addParam(emptySketch(), BODY)
    expect(() => resolveValue(doc, 'width')).toThrow(/no param named "width"/)
    // The refusal is the whole of the language: there is no expression syntax
    // for it to have tried instead, and the message has to say so or the next
    // person writes `body * 2` and reads the error as a typo.
    expect(() => resolveValue(doc, 'body * 2')).toThrow(/expressions are not supported/)
  })

  it('reaches a dimension: a named param drives the geometry it is spent on', () => {
    // 20 x 20 x 20 through the param, against the same box written out.
    const side = { name: 'side', type: 'number', caption: 'Side', initial: 20 }
    const named = addNode(addParam(emptySketch(), side), {
      id: 'b', name: 'cube', op: 'box', role: 'solid',
      at: [0, 0, 0], rot: [0, 0, 0], size: ['side', 'side', 'side'],
    })
    const spelled = just({
      id: 'b', name: 'cube', op: 'box', role: 'solid',
      at: [0, 0, 0], rot: [0, 0, 0], size: [20, 20, 20],
    })
    expect(volumeOf(buildSketch(named).parts[0]))
      .toBeCloseTo(volumeOf(buildSketch(spelled).parts[0]), 9)
    expect(volumeOf(buildSketch(named).parts[0])).toBeCloseTo(8000, 6)
  })
})

describe('the immutable helpers', () => {
  // Each helper against the same question: the document handed in is the
  // document still there afterwards. The panel keeps the previous state to undo
  // to, so a helper that edited in place would make undo a no-op — which is
  // invisible until somebody tries it.
  const doc = motorMock()
  const cases = [
    ['addNode', 'nodes', (d) => addNode(d, { ...VAL, id: 'n9', name: 'extra' })],
    ['removeNode', 'nodes', (d) => removeNode(d, 'n2')],
    ['updateNode', 'nodes', (d) => updateNode(d, 'n2', { at: [1, 2, 3] })],
    ['moveNodes', 'nodes', (d) => moveNodes(d, ['n2'], [1, 2, 3])],
    ['addParam', 'params',
      (d) => addParam(d, { name: 'gap', type: 'number', caption: 'Gap', initial: 2 })],
    ['removeParam', 'params', (d) => removeParam(d, 'body')],
    ['updateParam', 'params', (d) => updateParam(d, 'body', { initial: 44 })],
    ['renameParam', 'params', (d) => renameParam(d, 'body', 'body_w')],
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
    // EVERY NAMED NODE AND ONLY THOSE, which is what the panel spends it on:
    // the fused result is every body at once, a hole is one.
    expect(moveNodes(doc, ['n1', 'n2', 'n3'], [1, 0, 0]).nodes.map((n) => n.at[0]))
      .toEqual([1, 1, 16.5])
    expect(addParam(doc, LENGTH).params).toHaveLength(3)
    expect(removeParam(doc, 'body').params.map((p) => p.name)).toEqual(['length'])
    expect(updateParam(doc, 'body', { initial: 44 }).params[0].initial).toBe(44)
    expect(updateParam(doc, 'body', { initial: 44 }).params[0].max).toBe(45)
  })
})

describe('renaming a param', () => {
  it('carries every dimension that named it, so the document still builds', () => {
    // THE ASSERTION THIS HELPER EXISTS FOR. `wall` -> `wall_t` is typed one
    // character at a time, and a rename that rewrote the record alone left
    // `korpus` asking for a param nobody has — a document `resolveValue`
    // refuses, on the FIRST character, with no way back from the panel: the name
    // that would repair it is the one that was just taken away.
    const doc = renameParam(motorMock(), 'body', 'body_w')

    expect(doc.params.map((param) => param.name)).toEqual(['body_w', 'length'])
    expect(doc.nodes[0].size).toEqual(['body_w', 'body_w', 'length'])
    expect(() => buildSketch(doc)).not.toThrow()
    expect(sketchText(doc)).toContain('42.3 (body_w)')
  })

  it('touches nothing that merely reads like the name', () => {
    // A BODY MAY BE CALLED AFTER THE PARAM THAT SIZES IT — `body` is the
    // likeliest name for both — so the walk has to know a node's structure from
    // its geometry. `name`, `id`, `op` and `role` are the four it leaves alone.
    const doc = renameParam(addNode(addParam(emptySketch(), BODY), {
      id: 'body', name: 'body', op: 'box', role: 'solid',
      at: [0, 0, 0], rot: [0, 0, 0], size: ['body', 10, 10],
    }), 'body', 'width')

    expect(doc.nodes[0]).toMatchObject({ id: 'body', name: 'body', op: 'box' })
    expect(doc.nodes[0].size).toEqual(['width', 10, 10])
  })

  it('is a no-op on a name no param carries, and on a rename to itself', () => {
    const doc = motorMock()
    expect(renameParam(doc, 'nope', 'other')).toBe(doc)
    expect(renameParam(doc, 'body', 'body')).toBe(doc)
  })
})

describe('usedBy', () => {
  it('names the bodies whose dimensions spend a param, and only those', () => {
    // What a refusal is written out of: removing `body` while `korpus` is sized
    // from it leaves a document that will not build, and the panel has to say
    // which body to see to rather than which error to read.
    expect(usedBy(motorMock(), 'body')).toEqual(['korpus'])
    expect(usedBy(motorMock(), 'length')).toEqual(['korpus'])
    expect(usedBy(motorMock(), 'body_w')).toEqual([])
    // `val` is sized in numbers, so nothing it carries is a claim on any param.
    expect(usedBy(motorMock(), 'val')).toEqual([])
  })

  it('reaches as deep into a node as a rename does, because the two are a pair', () => {
    // `renameParam` walks all the way into an extrusion's profile and rewrites
    // the mention it finds there. A `usedBy` that looked one level deep answered
    // "nobody" about that same param — so `dropParam`, which asks this before it
    // refuses, offered to remove a param the body was still spending, and the
    // document stopped building the moment it went.
    const doc = addNode(addParam(emptySketch(), BODY), {
      id: 'n4', name: 'plate', op: 'extrude', role: 'solid',
      at: [0, 0, 0], rot: [0, 0, 0], h: 3,
      profile: [[0, 0], ['body', 0], ['body', 10]],
    })

    expect(usedBy(doc, 'body')).toEqual(['plate'])
    expect(renameParam(doc, 'body', 'width').nodes[0].profile)
      .toEqual([[0, 0], ['width', 0], ['width', 10]])
  })
})

describe('sketchText', () => {
  it('renders the projection byte for byte', () => {
    expect(sketchText(motorMock())).toBe([
      'units: mm',
      'params: body = 42.3 (40..45 step 0.1) slider "Body", '
        + 'length = 40 (20..60 step 1) "Length"',
      '',
      'solid  box       "korpus"    42.3 (body) x 42.3 (body) x 40 (length)  at (0, 0, 0)',
      'solid  cylinder  "val"       d5 h24                                   at (0, 0, 42)',
      'hole   cylinder  "krepezh1"  d3 h10                                   at (15.5, 15.5, 36)  rot (0, 45, 0)',
      '',
      'result = union(solid) - union(hole)',
    ].join('\n'))
  })

  it('omits the params line when the sketch has none', () => {
    expect(sketchText(just(VAL))).toBe([
      'units: mm',
      '',
      'solid  cylinder  "val"  d5 h24  at (0, 0, 42)',
      '',
      'result = union(solid) - union(hole)',
    ].join('\n'))
  })

  it('prints a rotation only where there is one', () => {
    const lines = sketchText(motorMock()).split('\n')
    expect(lines.filter((line) => line.includes('rot (')))
      .toEqual([lines.find((line) => line.startsWith('hole'))])
    // ...and the line that has none ends at its placement rather than trailing
    // the width of a column that was padded for somebody else.
    expect(lines.find((line) => line.includes('"val"'))).toMatch(/at \(0, 0, 42\)$/)
  })

  it('spells the sphere and the extrusion the way the other two are spelled', () => {
    expect(sketchText(addNode(just({
      id: 'a', name: 'ball', op: 'sphere', role: 'solid',
      at: [0, 0, 0], rot: [0, 0, 0], d: 10,
    }), {
      id: 'b', name: 'plate', op: 'extrude', role: 'solid',
      at: [0, 0, -10], rot: [0, 0, 0], h: 3,
      profile: [[0, 0], [20, 0], [20, 10], [0, 10]],
    }))).toBe([
      'units: mm',
      '',
      // THE PROFILE'S OWN POINTS, in the spelling the panel's field uses. `4pt`
      // said "some quadrilateral": an extrusion is the one body here whose shape
      // is not in its numbers, so the count left the agent designing against a
      // hole in the sentence it was sent.
      'solid  sphere   "ball"   d10                                at (0, 0, 0)',
      'solid  extrude  "plate"  h3 profile 0,0; 20,0; 20,10; 0,10  at (0, 0, -10)',
      '',
      'result = union(solid) - union(hole)',
    ].join('\n'))
  })

  it('spells a param with everything the panel lets one be typed with', () => {
    // THE THREE FIELDS THAT HAD NO READER. The panel has a caption field, a step
    // field and a type toggle whose tooltip says the type is how the agent
    // should OFFER the param — and nothing on this page renders a slider, so
    // this line is the only place any of the three can mean anything. Every
    // piece is omitted where the param does not carry it, and `number` is the
    // default: printed, it would say only that nobody pressed the toggle.
    const params = (param) => sketchText(addParam(emptySketch(), param)).split('\n')[1]

    expect(params({
      name: 'wall', type: 'slider', caption: 'wall thickness',
      initial: 2.4, min: 1, max: 5, step: 0.2,
    })).toBe('params: wall = 2.4 (1..5 step 0.2) slider "wall thickness"')

    expect(params({ name: 'gap', type: 'number', caption: '', initial: 2 }))
      .toBe('params: gap = 2')
    expect(params({ name: 'gap', type: 'number', caption: 'Gap', initial: 2, step: 0.5 }))
      .toBe('params: gap = 2 (step 0.5) "Gap"')
    expect(params({ name: 'gap', type: 'slider', caption: '', initial: 2, min: 1, max: 4 }))
      .toBe('params: gap = 2 (1..4) slider')
  })

  it('says what an empty document is, rather than nothing at all', () => {
    expect(sketchText(emptySketch())).toBe([
      'units: mm',
      '',
      'result = union(solid) - union(hole)',
    ].join('\n'))
  })
})

describe('buildSketch', () => {
  it('builds a payload for a box, and the box is the size it was asked for', () => {
    const payload = buildSketch(just({
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
    const payload = buildSketch(just(VAL))
    expectWellFormed(payload)
    // Tessellated, so short of the ideal by the chord error and never over it.
    const ideal = Math.PI * 2.5 * 2.5 * 24
    expect(volumeOf(payload.parts[0])).toBeLessThan(ideal)
    expect(volumeOf(payload.parts[0])).toBeGreaterThan(ideal * 0.97)
    expect(payload.bb.zmin).toBeCloseTo(30, 9)
    expect(payload.bb.zmax).toBeCloseTo(54, 9)
  })

  it('builds a payload for a sphere', () => {
    const payload = buildSketch(just({
      id: 's', name: 'ball', op: 'sphere', role: 'solid',
      at: [0, 0, 0], rot: [0, 0, 0], d: 10,
    }))
    expectWellFormed(payload)
    const ideal = (4 / 3) * Math.PI * 125
    expect(volumeOf(payload.parts[0])).toBeLessThan(ideal)
    expect(volumeOf(payload.parts[0])).toBeGreaterThan(ideal * 0.97)
  })

  it('builds a payload for an extrusion, whose profile places itself', () => {
    const payload = buildSketch(just({
      id: 'e', name: 'plate', op: 'extrude', role: 'solid',
      at: [0, 0, -10], rot: [0, 0, 0], h: 3,
      profile: [[0, 0], [20, 0], [20, 10], [0, 10]],
    }))
    expectWellFormed(payload)
    expect(volumeOf(payload.parts[0])).toBeCloseTo(600, 6)
    // An extrusion runs UP from `at`, because its profile already says where it
    // sits in the plane — unlike the three primitives, which `at` centres.
    expectBox(payload.bb, { xmin: 0, xmax: 20, ymin: 0, ymax: 10, zmin: -10, zmax: -7 })
  })

  it('turns a node by the rotation the document gives it, in degrees', () => {
    const payload = buildSketch(just({
      id: 'b', name: 'block', op: 'box', role: 'solid',
      at: [0, 0, 0], rot: [0, 0, 45], size: [10, 10, 2],
    }))
    // A square on its corner is as wide as its diagonal. Radians would have
    // turned it 45 of them — two and a half turns — and landed somewhere that
    // still looks like a box.
    expect(payload.bb.xmax).toBeCloseTo(Math.sqrt(200) / 2, 9)
    expect(payload.bb.zmax).toBeCloseTo(1, 9)
  })

  it('cuts a hole out of the result, and the volume says so', () => {
    const plate = {
      id: 'p', name: 'plate', op: 'box', role: 'solid',
      at: [0, 0, 0], rot: [0, 0, 0], size: [20, 20, 10],
    }
    const bore = {
      id: 'h', name: 'bore', op: 'cylinder', role: 'hole',
      at: [0, 0, 0], rot: [0, 0, 0], d: 6, h: 20,
    }
    const whole = volumeOf(buildSketch(just(plate)).parts[0])
    const drilled = volumeOf(buildSketch(addNode(just(plate), bore)).parts[0])
    expect(whole).toBeCloseTo(4000, 6)
    // The bore goes right through, so what left is its full length inside the
    // plate — a tessellated cylinder, so just under the ideal.
    const removed = whole - drilled
    const ideal = Math.PI * 9 * 10
    expect(removed).toBeLessThan(ideal)
    expect(removed).toBeGreaterThan(ideal * 0.97)
  })

  it('shows every hole as a part of its own, translucent, beside the result', () => {
    const payload = buildSketch(motorMock())
    expectWellFormed(payload)
    expect(payload.parts.map((part) => part.name)).toEqual(['result', 'krepezh1'])
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

  it('answers for a document with nothing in it', () => {
    const payload = buildSketch(emptySketch())
    expectWellFormed(payload)
    expect(payload.parts.map((part) => part.name)).toEqual(['result'])
    expect(payload.parts[0].shape.vertices).toEqual([])
    expectBox(payload.bb, { xmin: 0, xmax: 0, ymin: 0, ymax: 0, zmin: 0, zmax: 0 })
  })

  it('answers for a document that is nothing but holes', () => {
    // Nothing to cut them out of, so the result is empty and the tools are all
    // that is left to look at — which is what somebody halfway through building
    // a sketch has.
    const payload = buildSketch(just(KREPEZH))
    expectWellFormed(payload)
    expect(payload.parts.map((part) => part.name)).toEqual(['result', 'krepezh1'])
    expect(payload.parts[0].shape.triangles).toEqual([])
  })

  it('names the optional tessellation fields nowhere, and the viewer guards them', () => {
    // face_types / edge_types / triangles_per_face / segments_per_edge are
    // OCCT's enumerations; a mesh kernel has nothing to say about them. The
    // library's readers are guarded, so leaving them out is a supported shape
    // rather than a gap — this pins that we leave them out DELIBERATELY, since
    // half-filling them would be worse than not filling them.
    const shape = buildSketch(just(VAL)).parts[0].shape
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
    const shape = buildSketch(just({
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
      const shape = buildSketch(just({
        at: [0, 0, 0], rot: [0, 0, 0], ...node,
      })).parts[0].shape
      expect(shape.edges).toEqual([])
      expect(shape.triangles.length).toBeGreaterThan(0)
    }
  })
})
