// ui/src/viewport/coplanar.js — which part wins where two share a plane.
//
// On the real payload (`tests/fixtures/assembled.json`, see parts.test.js for
// where it comes from). Its parts touch face to face — the post stands on the
// plate, the cap sits on the post — and faces that touch look at each other, so
// none of them fight. A fight is made by adding a copy of the cap's own shape
// flush in the plate, the way a driver's flange sits in its panel.

import { afterEach, describe, expect, it, vi } from 'vitest'

import assembled from './fixtures/assembled.json'
import { settleCoplanar } from '../src/viewport/coplanar.js'

function find(node, id) {
  if (node.id === id) return node
  for (const child of node.parts || []) {
    const hit = find(child, id)
    if (hit) return hit
  }
  return null
}

/** The doc with extra leaves appended to the group that holds the plate. */
function withLeaves(...extra) {
  const doc = structuredClone(assembled)
  const group = find(doc, '/Group')
  group.parts.push(...extra)
  return doc
}

/** A copy of a fixture leaf's shape under a new id, moved by `at`. */
function copyOf(id, newId, at) {
  return {
    ...find(assembled, id), id: newId, name: newId.split('/').pop(),
    loc: [at, [0, 0, 0, 1]],
  }
}

/** What `nestedGroup.groups` holds for the leaves: a front mesh with its world
 *  matrix (column-major, like three's) and a material at the library's +1/+1.
 *  The fixture turns nothing, so a world matrix is the sum of the locations. */
function nested(doc) {
  const groups = {}
  const walk = (node, offset) => {
    const [at, turn] = node.loc || [[0, 0, 0], [0, 0, 0, 1]]
    expect(turn).toEqual([0, 0, 0, 1])
    const here = offset.map((c, k) => c + at[k])
    if (node.shape) {
      groups[node.id] = {
        front: {
          updateWorldMatrix() {},
          matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...here, 1] },
          material: { polygonOffsetFactor: 1, polygonOffsetUnits: 1 },
        },
      }
    }
    for (const child of node.parts || []) walk(child, here)
  }
  walk(doc, [0, 0, 0])
  return { groups }
}

const offsets = (g) => Object.fromEntries(Object.entries(g.groups).map(([id, { front }]) =>
  [id, [+front.material.polygonOffsetFactor.toFixed(3), front.material.polygonOffsetUnits]]))

describe('settleCoplanar', () => {
  afterEach(() => vi.restoreAllMocks())

  it('leaves parts that only touch face to face alone', () => {
    const g = nested(assembled)
    expect(settleCoplanar(g, assembled).size).toBe(0)
    for (const [, offset] of Object.entries(offsets(g))) expect(offset).toEqual([1, 1])
  })

  it('puts the larger of two flush parts behind the smaller one', () => {
    // The cap is 3 thick and centred on its location, so at z = 0 its top and
    // bottom lie in the plate's top and bottom planes, inside the plate's outline.
    const doc = withLeaves(copyOf('/Group/cap', '/Group/flange', [0, 0, 0]))
    const g = nested(doc)
    const levels = settleCoplanar(g, doc)
    expect(Object.fromEntries(levels)).toEqual({ '/Group/flange': 0, '/Group/plate': 1 })
    const after = offsets(g)
    expect(after['/Group/plate']).toEqual([1.1, 33])
    expect(after['/Group/flange']).toEqual([1, 1])
    expect(after['/Group/post']).toEqual([1, 1])
  })

  it('does not pair parts that only meet along an edge', () => {
    // Two plates butted side by side: the same top plane, outlines that touch
    // along x = 12 and cover nothing of each other.
    const doc = withLeaves(copyOf('/Group/plate', '/Group/plate2', [24, 0, 0]))
    const g = nested(doc)
    expect(settleCoplanar(g, doc).size).toBe(0)
    expect(offsets(g)['/Group/plate']).toEqual([1, 1])
  })

  it('pairs faces through a turned part, and not faces that look apart', () => {
    // A speaker modelled along one axis and stood facing another: the plane of
    // its face is found through the turn in `matrixWorld`, not through the
    // offset alone. A is a 4-wide face in local y = -1 looking down -y; turned
    // a quarter about +Z and moved by 5 it looks along +x, in x = 6, where B,
    // 10 wide, looks the same way. Off its own origin, so the vertices' turn is
    // checked as well as the normal's. Turned the other way it looks along -x
    // and fights nothing.
    const square = (h, axis, normal) => ({
      vertices: axis === 'y'
        ? [-h, -1, -h, h, -1, -h, h, -1, h, -h, -1, h]
        : [0, -h, -h, 0, h, -h, 0, h, h, 0, -h, h],
      normals: Array(4).fill(normal).flat(),
      triangles: [0, 1, 2, 0, 2, 3], face_types: [0], triangles_per_face: [2],
    })
    const doc = { id: '/r', parts: [
      { id: '/r/A', shape: square(2, 'y', [0, -1, 0]) },
      { id: '/r/B', shape: square(5, 'x', [1, 0, 0]) },
    ] }
    const group = (elements) => ({ front: {
      updateWorldMatrix() {}, matrixWorld: { elements },
      material: { polygonOffsetFactor: 1, polygonOffsetUnits: 1 },
    } })
    // Column-major: a quarter turn about +Z takes x to y and y to -x.
    const quarter = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]
    const back = [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]
    const moved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 6, 0, 0, 1]

    const turned = { groups: { '/r/A': group(quarter), '/r/B': group(moved) } }
    expect(Object.fromEntries(settleCoplanar(turned, doc))).toEqual({ '/r/A': 0, '/r/B': 1 })
    const apart = { groups: { '/r/A': group(back), '/r/B': group(moved) } }
    expect(settleCoplanar(apart, doc).size).toBe(0)
  })

  it('never throws, and touches nothing when the payload is not what it reads', () => {
    // `show()` would replace the model with the error panel on a throw.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const doc = withLeaves(copyOf('/Group/cap', '/Group/flange', [0, 0, 0]))
    const g = nested(doc)
    find(doc, '/Group/flange').shape = { ...find(doc, '/Group/flange').shape, vertices: null }
    expect(() => settleCoplanar(g, doc)).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(offsets(g)['/Group/plate']).toEqual([1, 1])
  })
})
