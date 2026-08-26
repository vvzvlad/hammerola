// ui/src/viewport/parts.js — the part tree the interface draws, and everything
// the interface does to one part rather than to the camera.
//
// ON A REAL PAYLOAD, and that is the point of the fixture: the tree is built
// from the VIEW FILE rather than from the library, so a test written against a
// hand-made `{name, color, parts}` would be checking this code against
// somebody's idea of the exporter. `tests/fixtures/assembled.json` came out of
// `src/cadbuild/views.py` — the same two functions a real build calls — and
// `tests/fixtures/make_fixture.py` regenerates it. Nothing below hard-codes a
// part name or a colour: every expected value is read out of the file.
//
// THE FIXTURE'S TREE IS TWO LEVELS DEEP, because that is what the pipeline can
// produce: one view part is exactly one leaf (`prepare_views` refuses a
// `cq.Assembly`). The FORMAT nests — src/render.py validates to a depth of 64 —
// so the recursion is covered separately, against a tree built by nesting the
// fixture's own real nodes. That test is honest about being synthetic; it has
// to be, because no model can emit one today.

import { describe, expect, it, vi } from 'vitest'

import { internals } from '../src/viewport/internals.js'
import {
  applyGhost, applyHidden, applySelected, movePart, movableGroup, resetMoves,
  statesOf, treeFromShapes,
} from '../src/viewport/parts.js'
import { fakeGroup, fakeViewer, fakeViewport } from './fakes.js'
import assembled from './fixtures/assembled.json'

/** Every leaf of a view file, with the path the LIBRARY would give it.
 *
 *  Parent path plus `/name`, which is how three-cad-viewer builds the keys of
 *  `getStates()` (docs/viewer-api.md §4) and therefore the only thing that makes
 *  a row in the tree clickable. Derived here rather than written out, so this
 *  file has no copy of a name the fixture owns.
 */
function leavesOf(node, parent = '') {
  const path = `${parent}/${node.name}`
  if (!Array.isArray(node.parts)) return [{ path, node }]
  return node.parts.flatMap((kid) => leavesOf(kid, path))
}

const LEAVES = leavesOf(assembled)
const PATHS = LEAVES.map((leaf) => leaf.path)

/** `getStates()` as the library would answer it for this payload. */
const statesFor = (paths) =>
  Object.fromEntries(paths.map((path) => [path, [1, 1]]))

describe('the fixture itself', () => {
  it('is a payload with several parts, not one node', () => {
    // If this ever fails the fixture was regenerated from a different model and
    // every expectation below is about something else.
    expect(assembled.parts.length).toBeGreaterThan(1)
    expect(LEAVES.length).toBe(assembled.parts.length)
  })

  it('carries a colour per part, and more than one of them', () => {
    const colours = new Set(LEAVES.map((leaf) => leaf.node.color))
    expect(colours.size).toBeGreaterThan(1)
    for (const colour of colours) expect(typeof colour).toBe('string')
  })
})

describe('treeFromShapes', () => {
  it('builds the ids the library answers to: parent path plus /name', () => {
    const tree = treeFromShapes(assembled, statesFor(PATHS))
    expect(tree.id).toBe(`/${assembled.name}`)
    expect(tree.children.map((row) => row.id)).toEqual(PATHS)
  })

  it('carries the name and the colour through as they came', () => {
    const tree = treeFromShapes(assembled, statesFor(PATHS))
    for (const [index, row] of tree.children.entries()) {
      expect(row.name).toBe(LEAVES[index].node.name)
      expect(row.color).toBe(LEAVES[index].node.color)
    }
  })

  it('marks a leaf the library does not know rather than dropping it', () => {
    // A missing row reads as a build with fewer parts; a flagged one reads as
    // what it is. Every path but the first is known here.
    const [missing, ...rest] = PATHS
    const tree = treeFromShapes(assembled, statesFor(rest))
    const rows = tree.children
    expect(rows.map((row) => row.id)).toEqual(PATHS)
    expect(rows.find((row) => row.id === missing).known).toBe(false)
    for (const row of rows.slice(1)) expect(row.known).toBe(true)
  })

  it('treats "no states at all" as "cannot say", not as "nothing is known"', () => {
    const tree = treeFromShapes(assembled, null)
    for (const row of tree.children) expect(row.known).toBe(true)
  })

  it('nests: a child node carries children and no `known` flag of its own', () => {
    // SYNTHETIC, deliberately and unavoidably: `prepare_views` refuses an
    // assembly, so no build emits a nested view file today. The NODES are real
    // — they are the fixture's own leaves — and only the nesting is arranged
    // here, which is exactly the part src/render.py already validates for.
    const [first, second, ...others] = assembled.parts
    const nested = {
      ...assembled,
      parts: [{ name: 'subassembly', color: null, parts: [first, second] },
              ...others],
    }
    const paths = leavesOf(nested).map((leaf) => leaf.path)
    const tree = treeFromShapes(nested, statesFor(paths))

    const branch = tree.children[0]
    expect(branch.id).toBe(`/${assembled.name}/subassembly`)
    expect(branch.children.map((row) => row.id))
      .toEqual([`${branch.id}/${first.name}`, `${branch.id}/${second.name}`])
    expect(branch.known).toBeUndefined()
  })
})

describe('statesOf', () => {
  it('is the library\'s answer when there is one', () => {
    const viewer = fakeViewer({ states: statesFor(PATHS) })
    expect(Object.keys(statesOf(viewer))).toEqual(PATHS)
  })

  it('is an empty map, not a throw, when there is no viewer yet', () => {
    expect(statesOf(null)).toEqual({})
  })

  it('is an empty map when the library throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const viewer = fakeViewer()
    viewer.getStates = () => { throw new Error('gone') }
    expect(statesOf(viewer)).toEqual({})
    vi.restoreAllMocks()
  })
})

describe('applyHidden', () => {
  it('hides exactly the leaf it names', () => {
    const viewer = fakeViewer({ states: statesFor(PATHS) })
    const [target] = PATHS
    applyHidden(viewer, [target])

    const [written] = viewer.setStates.mock.calls[0]
    expect(written[target]).toEqual([0, 0])
    for (const path of PATHS.slice(1)) expect(written[path]).toEqual([1, 1])
  })

  it('hides a whole node by prefix, which is how an aggregate is hidden', () => {
    const viewer = fakeViewer({ states: statesFor(PATHS) })
    applyHidden(viewer, [`/${assembled.name}`])

    const [written] = viewer.setStates.mock.calls[0]
    for (const path of PATHS) expect(written[path]).toEqual([0, 0])
  })

  it('does not hide a leaf that merely starts with the same letters', () => {
    // `covers()` matches on a path COMPONENT: "/Group/lid" must not take
    // "/Group/lid_holder" with it.
    const paths = ['/Group/lid', '/Group/lid_holder']
    const viewer = fakeViewer({ states: statesFor(paths) })
    applyHidden(viewer, ['/Group/lid'])

    const [written] = viewer.setStates.mock.calls[0]
    expect(written['/Group/lid']).toEqual([0, 0])
    expect(written['/Group/lid_holder']).toEqual([1, 1])
  })

  it('writes nothing when the scene already looks like that', () => {
    // Cheap and safe to run often is the contract; a write per reconcile would
    // be a re-render per keystroke somewhere in the interface.
    const viewer = fakeViewer({ states: statesFor(PATHS) })
    applyHidden(viewer, [])
    expect(viewer.setStates).not.toHaveBeenCalled()
  })

  it('shows everything again when the list empties', () => {
    const hidden = Object.fromEntries(PATHS.map((path) => [path, [0, 0]]))
    const viewer = fakeViewer({ states: hidden })
    applyHidden(viewer, [])

    const [written] = viewer.setStates.mock.calls[0]
    for (const path of PATHS) expect(written[path]).toEqual([1, 1])
  })
})

describe('applyGhost', () => {
  function scene() {
    const groups = Object.fromEntries(PATHS.map((path) => [path, fakeGroup()]))
    return { groups, viewer: fakeViewer({ states: statesFor(PATHS), groups }) }
  }

  it('makes the named part transparent and leaves the others alone', () => {
    const { groups, viewer } = scene()
    const [target] = PATHS
    applyGhost(viewer, [target])

    expect(groups[target].transparent).toBe(true)
    expect(groups[target].opacity).toBeLessThan(1)
    for (const path of PATHS.slice(1)) expect(groups[path].transparent).toBe(false)
  })

  it('takes the whole node by prefix, exactly like hiding does', () => {
    const { groups, viewer } = scene()
    applyGhost(viewer, [`/${assembled.name}`])
    for (const path of PATHS) expect(groups[path].transparent).toBe(true)
  })

  it('turns it off again, and asks for one re-render rather than one per part', () => {
    const { groups, viewer } = scene()
    applyGhost(viewer, [PATHS[0]])
    viewer.update.mockClear()
    applyGhost(viewer, [])

    for (const path of PATHS) expect(groups[path].transparent).toBe(false)
    expect(viewer.update).toHaveBeenCalledTimes(1)
  })
})

describe('applySelected', () => {
  it('clears the previous highlight before painting the new one', () => {
    const viewer = fakeViewer({ states: statesFor(PATHS) })
    const highlight = internals(viewer).nestedGroup.highlight
    applySelected(viewer, PATHS[1])

    expect(highlight.clear).toHaveBeenCalled()
    expect(highlight.selectSolid).toHaveBeenCalledWith(PATHS[1], true)
  })

  it('clears and paints nothing when the selection goes away', () => {
    const viewer = fakeViewer({ states: statesFor(PATHS) })
    const highlight = internals(viewer).nestedGroup.highlight
    applySelected(viewer, null)

    expect(highlight.clear).toHaveBeenCalled()
    expect(highlight.selectSolid).not.toHaveBeenCalled()
  })
})

describe('movePart and resetMoves', () => {
  function scene() {
    const home = [1, 2, 3]
    const groups = { [PATHS[0]]: fakeGroup(home) }
    const viewer = fakeViewer({ states: statesFor(PATHS), groups })
    return { home, groups, viewer, vp: fakeViewport(viewer) }
  }

  it('offsets a part from where the BUILD put it, not from the origin', () => {
    const { home, groups, vp } = scene()
    expect(movePart(vp, PATHS[0], [10, 0, 0])).toBe(true)
    expect([groups[PATHS[0]].position.x, groups[PATHS[0]].position.y,
            groups[PATHS[0]].position.z]).toEqual([home[0] + 10, home[1], home[2]])
  })

  it('remembers home on the FIRST touch, so a second move is not cumulative', () => {
    const { home, groups, vp } = scene()
    movePart(vp, PATHS[0], [10, 0, 0])
    movePart(vp, PATHS[0], [4, 0, 0])
    expect(groups[PATHS[0]].position.x).toBe(home[0] + 4)
  })

  it('puts everything back exactly where the build had it', () => {
    const { home, groups, vp } = scene()
    movePart(vp, PATHS[0], [10, -5, 2])
    resetMoves(vp)

    const at = groups[PATHS[0]].position
    expect([at.x, at.y, at.z]).toEqual(home)
    expect(vp.moved.size).toBe(0)
  })

  it('refuses a delta that is not three finite numbers', () => {
    const { vp } = scene()
    expect(movePart(vp, PATHS[0], [1, NaN, 3])).toBe(false)
    expect(vp.moved.size).toBe(0)
  })

  it('says so when the part cannot be moved at all', () => {
    const { vp } = scene()
    expect(movableGroup(vp.viewer, '/Group/not a part')).toBeNull()
    expect(movePart(vp, '/Group/not a part', [1, 1, 1])).toBe(false)
  })
})
