// ui/src/viewport/parts.js — the part tree the interface draws, and everything
// the interface does to one part rather than to the camera.
//
// ON A REAL PAYLOAD, and that is the point of the fixture: the tree is built
// from the VIEW FILE rather than from the library, so a test written against a
// hand-made `{name, color, parts}` would be checking this code against
// somebody's idea of the exporter. `tests/fixtures/assembled.json` came out of
// the hub's own build half — the catalogue reader, the view preparation, the
// three gates and the two exporters, in the order `src/cadbuild/build.py` calls
// them — and `tests/fixtures/make_fixture.py` regenerates it. Nothing below
// hard-codes a part name or a colour: every expected value is read out of the
// file.
//
// THE FIXTURE'S TREE IS TWO LEVELS DEEP because its model asks for no more:
// one reference is exactly one leaf (`read_catalogue` refuses a `cq.Assembly`),
// and a view nests only where it declares a group — `{"group": "housing",
// "parts": [...]}`, which `export_views` does write into the file, and which
// src/render.py validates to a depth of 64. So the recursion is covered
// separately here, against a tree built by nesting the fixture's own real
// nodes.

import { describe, expect, it, vi } from 'vitest'

import { internals } from '../src/viewport/internals.js'
import { GHOST_OPACITY, renderOptions } from '../src/viewport/options.js'
import {
  applyGhost, applyHidden, applySelected, movePart, movableGroup, partCentre,
  resetMoves, restageMoves, statesOf, treeFromShapes,
} from '../src/viewport/parts.js'
import {
  fakeGroup, fakeMatrix, fakeShapeSolid, fakeViewer, fakeViewport,
} from './fakes.js'
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

  // -- the catalogue key (issue #75) ------------------------------------------
  //
  // THE FIXTURE CARRIES ITS OWN KEYS: `export_views` stamps the catalogue key
  // on every leaf it writes, and the committed `assembled.json` was regenerated
  // behind that — one key per leaf, each equal to that leaf's name, which holds
  // here only because this model references no part twice.
  //
  // WHAT THE TESTS BELOW DO TO THOSE KEYS IS NOT ONE THING, and the differences
  // are worth having straight before reading them:
  //
  //   * most REPLACE the values, because the case under test is one the
  //     fixture's own model has no reason to hold — one key on two leaves
  //     (written out by hand), a key that is not a string (through `keyed()`);
  //   * the FIRST one replaces them for a different reason, since a key
  //     travelling through is the ordinary case rather than an odd one:
  //     re-keying is what makes the assertion about the `key` FIELD instead of
  //     leaning on `key === name`, which is a coincidence of this model;
  //   * one SUBTRACTS the field, because the exporter writes a key on every
  //     leaf, so a leaf without one has to be made;
  //   * one ADDS the field where the build writes none — on a GROUP — which is
  //     a document the hub accepts and this side is the only side that refuses.
  //
  // So nothing here reads a COMMITTED key value, and that is covered rather
  // than missing: `outline()` in tests/test_view_fixture.py holds every leaf's
  // key string against what the real exporter produces (on a workstation — that
  // comparison needs the CAD kernel and skips in CI).

  /** The fixture's leaves, re-keyed — by default each one gets a key of its own. */
  const keyed = (key = (leaf, at) => `part${at}`) => ({
    ...assembled,
    parts: assembled.parts.map((node, at) => ({ ...node, key: key(node, at) })),
  })

  it('carries the leaf\'s catalogue key through as it came', () => {
    const source = keyed()
    const tree = treeFromShapes(source, statesFor(PATHS))
    expect(tree.children.map((row) => row.key))
      .toEqual(source.parts.map((node) => node.key))
  })

  it('keeps the key and the path APART, so one part may appear twice', () => {
    // The whole reason a row has two names. A view holding two copies of one
    // part gets two leaves with the same key and different names — `pin` and
    // `pin(2)`, which is how the tessellator keeps the paths unique — and the
    // interface then operates on the path while looking everything up by the
    // key.
    const [first, second] = assembled.parts
    const source = {
      ...assembled,
      parts: [{ ...first, name: 'pin', key: 'pin' },
              { ...second, name: 'pin(2)', key: 'pin' }],
    }
    const paths = leavesOf(source).map((leaf) => leaf.path)
    const rows = treeFromShapes(source, statesFor(paths)).children

    expect(rows.map((row) => row.id)).toEqual(paths)
    expect(rows[0].id).not.toBe(rows[1].id)
    expect(rows.map((row) => row.key)).toEqual(['pin', 'pin'])
  })

  it('leaves a leaf that names no key at `null` rather than guessing at its name', () => {
    // ARRANGED BY TAKING THE KEY AWAY, which is the one test in this block that
    // subtracts rather than adds: every leaf the exporter writes names a key,
    // so an unkeyed one has to be made. THE READER OF THIS IS A HAND-MADE PUSH
    // and not an old build — a document from before the catalogue never gets
    // this far, since the page reads its `meta.views` unguarded before it
    // fetches a view file at all and such a document named the list `variants`.
    // A fallback to `name` would put back exactly the identity-by-string the
    // catalogue replaced, and would be worse than the original: the key now
    // EXISTS, so the fallback would hide its absence rather than stand in for a
    // field nobody has.
    const unkeyed = {
      ...assembled,
      parts: assembled.parts.map((node) => {
        const copy = { ...node }
        delete copy.key
        return copy
      }),
    }
    const tree = treeFromShapes(unkeyed, statesFor(PATHS))
    for (const [at, row] of tree.children.entries()) {
      expect(row.key, `row ${at} invented a key`).toBeNull()
      expect(row.name).toBe(LEAVES[at].node.name)
    }
  })

  it('refuses a key that is not a non-empty string', () => {
    // A view file is a pushed document, so this side reads what it was handed
    // rather than a promise about it: a key of `12` would be looked up in
    // `meta.parts` and answer for whatever sits under `"12"`.
    //
    // THE EMPTY STRING IS NOT LIKE THE OTHERS, and the difference is why the
    // second half of `typeof node.key === "string" && node.key` must stay.
    // `render._check_part_name` refuses every non-string here, but it has no
    // lower bound at all, so `""` passes it, `_catalogue` takes a `parts` map
    // keyed by it, and `check_view_file` hands it back as a declared key. This
    // line is the only thing anywhere that rejects it.
    for (const bad of [12, '', null, {}, ['pin']]) {
      const source = keyed(() => bad)
      const rows = treeFromShapes(source, statesFor(PATHS)).children
      expect(rows.every((row) => row.key === null), `${JSON.stringify(bad)} got through`)
        .toBe(true)
    }
  })

  it('gives a GROUP no key at all, not even one written into the file', () => {
    // A group is not a part: it has no record, so no files, no note and no
    // kind. The build does not write one, and THIS SIDE IS THE ONLY SIDE THAT
    // SAYS SO: `check_view_file` takes such a file — "EVERY `key` IN THE FILE
    // GOES INTO THE SET, wherever it sits", in its own words, because a key is
    // a claim about what the view shows and that walk is not the place to
    // decide which nodes carry one. So a hand-made file with a key on a group
    // is a document the hub ACCEPTS, and what refuses to let it make an
    // assembly answer for a catalogue record is `treeFromShapes` here — the
    // group branch returns before the line that reads `key`, so a group leaves
    // this walk carrying no such field at all. THE SUBJECT IS THIS FUNCTION AND
    // NOT `indexTree`, which is the distinction hub.js's own note on `key`
    // exists to draw: that walk copies `key` across on whatever node it is
    // handed, group or leaf, and enforces nothing — "THIS FIELD ENFORCES
    // NOTHING AND COPIES WHAT IT IS GIVEN", in its words. What makes copying it
    // safe is that on a tree which came through HERE a group has none to copy;
    // the only way to hand that walk a keyed group is to build the tree BY
    // HAND, which `ui/tests/repeats.test.js` does, and that walk reports the
    // key it was given.
    const [first, second, ...others] = keyed().parts
    const nested = {
      ...assembled,
      parts: [{ name: 'subassembly', color: null, key: 'lid', parts: [first, second] },
              ...others],
    }
    const paths = leavesOf(nested).map((leaf) => leaf.path)
    const branch = treeFromShapes(nested, statesFor(paths)).children[0]

    expect(branch.key).toBeUndefined()
    expect(branch.children.map((row) => row.key)).toEqual([first.key, second.key])
  })

  it('nests: a child node carries children and no `known` flag of its own', () => {
    // SYNTHETIC, and by choice rather than by necessity: `export_views` writes
    // group nodes for a view that declares them, and this fixture's model
    // declares none. The NODES are real — they are the fixture's own leaves —
    // and only the nesting is arranged here, which is exactly the part
    // src/render.py already validates for.
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

  it('hides SEVERAL named leaves, which is how one row hides five copies', () => {
    // The row `pin ×5` is one eye over five solids, and the interface hands
    // over all five paths (hub.indexTree). Nothing here had to change for that
    // — the list was always a list — and this is what says so.
    const viewer = fakeViewer({ states: statesFor(PATHS) })
    const wanted = PATHS.slice(0, 2)
    applyHidden(viewer, wanted)

    const [written] = viewer.setStates.mock.calls[0]
    for (const path of wanted) expect(written[path]).toEqual([0, 0])
    for (const path of PATHS.slice(2)) expect(written[path]).toEqual([1, 1])
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

  it('ghosts SEVERAL named leaves, the same way hiding takes several', () => {
    const { groups, viewer } = scene()
    const wanted = PATHS.slice(0, 2)
    applyGhost(viewer, wanted)

    for (const path of wanted) expect(groups[path].transparent).toBe(true)
    for (const path of PATHS.slice(2)) expect(groups[path].transparent).toBe(false)
  })

  it('shows the part at GHOST_OPACITY, which is not what it writes', () => {
    // The field is a MULTIPLIER — the library shows a face at
    // `opacity * alpha` — so the number that has to come out is the product,
    // and reading `group.opacity` alone would be checking the wrong end of the
    // arithmetic.
    const { groups, viewer } = scene()
    const [target] = PATHS
    applyGhost(viewer, [target])

    expect(groups[target].front.material.opacity).toBe(GHOST_OPACITY)
  })

  it('takes a part the AUTHOR made translucent to the same place, not half of it',
    () => {
      // The defect a bare literal had: a part published at `alpha = 0.5` was
      // multiplied by the ghost value instead of being taken to it, so it
      // ghosted to 0.125 while its neighbours went to 0.25 and the reader was
      // shown two different meanings of "translucent" in one gesture.
      const { groups, viewer } = scene()
      const [target] = PATHS
      groups[target].alpha = 0.5
      applyGhost(viewer, [target])

      expect(groups[target].front.material.opacity).toBe(0.5)
    })

  it('is the same number the library is handed for a transparent scene', () => {
    // `GHOST_OPACITY`'s own docstring says it IS `renderOptions.defaultOpacity`
    // "said again for a second mechanism" — the two are one answer to "how
    // see-through is translucent", reached by different code. That sentence is
    // a specification, so it is held here rather than in the comment: the two
    // are declared twenty lines apart in one file with nothing joining them,
    // and a theme retuned through `defaultOpacity` would leave the ghost behind
    // at the old value with every other test in this file still green.
    expect(GHOST_OPACITY).toBe(renderOptions.defaultOpacity)
  })

  it('never RAISES a part\'s opacity, because the number is a ceiling', () => {
    // A part the author published fainter than a ghost is already past ghost
    // level, and "let me see past this" has nothing left to ask for. Dividing
    // unconditionally would make ghosting it MORE visible than not ghosting it.
    const { groups, viewer } = scene()
    const [target] = PATHS
    groups[target].alpha = 0.2
    applyGhost(viewer, [target])

    expect(groups[target].opacity).toBe(1)
    expect(groups[target].front.material.opacity).toBe(0.2)
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
    applySelected(viewer, [PATHS[1]])

    expect(highlight.clear).toHaveBeenCalled()
    expect(highlight.selectSolid).toHaveBeenCalledWith(PATHS[1], true)
  })

  it('clears and paints nothing when the selection goes away', () => {
    const viewer = fakeViewer({ states: statesFor(PATHS) })
    const highlight = internals(viewer).nestedGroup.highlight
    applySelected(viewer, [])

    expect(highlight.clear).toHaveBeenCalled()
    expect(highlight.selectSolid).not.toHaveBeenCalled()
  })

  it('paints EVERY path it is given, which is how one row lights up five copies',
    () => {
      // The row `pin ×5` is one selection over five solids (hub.indexTree), so
      // the highlight has to be painted five times into the texture `clear()`
      // just reset.
      const viewer = fakeViewer({ states: statesFor(PATHS) })
      const highlight = internals(viewer).nestedGroup.highlight
      applySelected(viewer, PATHS)

      expect(highlight.clear).toHaveBeenCalledTimes(1)
      expect(highlight.selectSolid.mock.calls.map(([path]) => path)).toEqual(PATHS)
      // One re-render for the lot, not one per copy.
      expect(viewer.update).toHaveBeenCalledTimes(1)
    })

  it('takes a bare path as NO selection rather than as a list of one', () => {
    // A sender still on the old shape has to fail visibly: read as a list of
    // one it would light up the first copy of a five-copy row and leave the
    // other four dark, with nothing anywhere saying why.
    const viewer = fakeViewer({ states: statesFor(PATHS) })
    const highlight = internals(viewer).nestedGroup.highlight
    applySelected(viewer, PATHS[1])

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

  /** The same, with every path movable and each one parked somewhere else.
   *
   *  HOMES DELIBERATELY APART: five copies of a part are five solids standing in
   *  five places, so a move that read one home and wrote it to all of them would
   *  stack them — and would pass against a scene where every home is `[0,0,0]`.
   */
  function crowd() {
    const homes = PATHS.map((path, at) => [at, at * 2, at * 3])
    const groups = Object.fromEntries(
      PATHS.map((path, at) => [path, fakeGroup(homes[at])]))
    const viewer = fakeViewer({ states: statesFor(PATHS), groups })
    return { homes, groups, viewer, vp: fakeViewport(viewer) }
  }

  it('offsets a part from where the BUILD put it, not from the origin', () => {
    const { home, groups, vp } = scene()
    expect(movePart(vp, [PATHS[0]], [10, 0, 0])).toBe(true)
    expect([groups[PATHS[0]].position.x, groups[PATHS[0]].position.y,
            groups[PATHS[0]].position.z]).toEqual([home[0] + 10, home[1], home[2]])
  })

  it('remembers home on the FIRST touch, so a second move is not cumulative', () => {
    const { home, groups, vp } = scene()
    movePart(vp, [PATHS[0]], [10, 0, 0])
    movePart(vp, [PATHS[0]], [4, 0, 0])
    expect(groups[PATHS[0]].position.x).toBe(home[0] + 4)
  })

  it('puts everything back exactly where the build had it', () => {
    const { home, groups, vp } = scene()
    movePart(vp, [PATHS[0]], [10, -5, 2])
    resetMoves(vp)

    const at = groups[PATHS[0]].position
    expect([at.x, at.y, at.z]).toEqual(home)
    expect(vp.moved.size).toBe(0)
  })

  it('refuses a delta that is not three finite numbers', () => {
    const { vp } = scene()
    expect(movePart(vp, [PATHS[0]], [1, NaN, 3])).toBe(false)
    expect(vp.moved.size).toBe(0)
  })

  it('says so when the part cannot be moved at all', () => {
    const { vp } = scene()
    expect(movableGroup(vp.viewer, '/Group/not a part')).toBeNull()
    expect(movePart(vp, ['/Group/not a part'], [1, 1, 1])).toBe(false)
  })

  // -- a row that stands for several copies (issue #75) ------------------------

  it('moves EVERY path by the one delta, each from its own home', () => {
    const { homes, groups, vp } = crowd()
    expect(movePart(vp, PATHS, [10, -5, 2])).toBe(true)

    PATHS.forEach((path, at) => {
      const now = groups[path].position
      expect([now.x, now.y, now.z], `copy ${at} did not travel from its own home`)
        .toEqual([homes[at][0] + 10, homes[at][1] - 5, homes[at][2] + 2])
    })
    // One re-render for the row, not one per copy.
    expect(vp.viewer.update).toHaveBeenCalledTimes(1)
  })

  it('puts every copy back, because reset walks what was moved', () => {
    const { homes, groups, vp } = crowd()
    movePart(vp, PATHS, [10, -5, 2])
    expect(vp.moved.size).toBe(PATHS.length)
    resetMoves(vp)

    PATHS.forEach((path, at) => {
      const now = groups[path].position
      expect([now.x, now.y, now.z], `copy ${at} was left where it was dragged`)
        .toEqual(homes[at])
    })
    expect(vp.moved.size).toBe(0)
  })

  it('moves NOTHING when one path of the row cannot be moved', () => {
    // Half a row moved is two copies of one part standing in different places
    // while the chip calls it a move of the row.
    const { homes, groups, vp } = crowd()
    const stranger = '/Group/not a part'
    expect(movePart(vp, [PATHS[0], stranger, PATHS[1]], [10, 0, 0])).toBe(false)

    PATHS.forEach((path, at) => {
      const now = groups[path].position
      expect([now.x, now.y, now.z], `copy ${at} moved anyway`).toEqual(homes[at])
    })
    expect(vp.moved.size).toBe(0)
  })

  it('refuses an empty list and a bare path alike', () => {
    // The bare path is the old signature: taken as a list it would iterate the
    // STRING and ask for a group called `/`.
    const { vp } = crowd()
    expect(movePart(vp, [], [10, 0, 0])).toBe(false)
    expect(movePart(vp, PATHS[0], [10, 0, 0])).toBe(false)
    expect(vp.moved.size).toBe(0)
  })

  // -- and the same drag, after the scene under it was built again -------------

  it('re-applies every offset onto the groups a re-stage just built', () => {
    // WHAT A RE-STAGE IS: the sketch panel lays a body over the model, and the
    // viewport renders the document it already had with that body composed in.
    // The model is the same, so the drag is still a true statement about it
    // (ui-brief block 6) and `show` keeps the map — but `clear()` disposed the
    // ObjectGroups it was written on and `render()` built new ones at the
    // positions the model gives them. Without this the interface's chip would
    // say a part is displaced while it stands exactly at home.
    const { homes, vp } = crowd()
    movePart(vp, PATHS, [10, -5, 2])

    // The scene rebuilt: fresh groups, back at their own homes, exactly as a
    // second `render()` of one document leaves them.
    const groups = Object.fromEntries(
      PATHS.map((path, at) => [path, fakeGroup(homes[at])]))
    vp.viewer = fakeViewer({ states: statesFor(PATHS), groups })

    restageMoves(vp)

    PATHS.forEach((path, at) => {
      const now = groups[path].position
      expect([now.x, now.y, now.z], `copy ${at} snapped home`)
        .toEqual([homes[at][0] + 10, homes[at][1] - 5, homes[at][2] + 2])
    })
    expect([...vp.moved.values()]).toEqual(PATHS.map(() => [10, -5, 2]))
    // THE HOMES ARE THE NEW SCENE'S, taken again rather than carried over — so
    // "put it back" puts it back to a position read off the groups that are
    // actually on screen.
    expect([...vp.partHome.values()]).toEqual(homes)
  })

  it('drops a path the rebuilt scene no longer has', () => {
    const { homes, vp } = crowd()
    movePart(vp, PATHS, [10, 0, 0])

    const kept = PATHS.slice(1)
    const groups = Object.fromEntries(
      kept.map((path, at) => [path, fakeGroup(homes[at + 1])]))
    vp.viewer = fakeViewer({ states: statesFor(kept), groups })

    restageMoves(vp)

    expect([...vp.moved.keys()]).toEqual(kept)
  })

  it('does nothing at all when nothing was moved', () => {
    const { vp } = crowd()
    restageMoves(vp)
    expect(vp.moved.size).toBe(0)
    expect(vp.viewer.update).not.toHaveBeenCalled()
  })
})

// -- where a part IS, for a pin that has to follow it through a rebuild --------

// A box that is neither a cube nor centred on the origin, so a centre cannot be
// mistaken for `min`, for `max` or for the part's local origin.
const BOX_POSITIONS = new Float32Array([
  0, 0, -1, 2, 0, -1, 2, 6, -1, 0, 6, -1, // z = -1
  0, 0, 1, 2, 0, 1, 2, 6, 1, 0, 6, 1, // z = 1
])
const BOX_INDEX = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
const BOX_CENTRE = [1, 3, 0]
const PIN = '/model/pin'

describe('partCentre', () => {
  /** One tessellated solid in the scene, at the matrix the build gave it. */
  const scene = (matrix) => {
    const solid = fakeShapeSolid(
      PIN, { positions: BOX_POSITIONS, index: BOX_INDEX, matrix })
    const viewer = fakeViewer({ states: statesFor([PIN]), groups: { [PIN]: solid } })
    return { solid, viewer }
  }

  it('answers the centre of the part box, not a corner of it', () => {
    expect(partCentre(scene().viewer, PIN)).toEqual(BOX_CENTRE)
  })

  it('carries the centre into the world through the part matrix', () => {
    // Where the pin has to land: the box is the geometry's own, in the solid's
    // local frame, and the scene graph is what puts the solid in the assembly.
    const { viewer } = scene(fakeMatrix({ scale: [2, 3, 4], position: [5, 0, -3] }))
    expect(partCentre(viewer, PIN)).toEqual([2 * 1 + 5, 3 * 3, 4 * 0 - 3])
  })

  it('asks the geometry for a box when it carries none yet', () => {
    const { solid, viewer } = scene()
    const { geometry } = solid.front
    geometry.boundingBox = null
    geometry.computeBoundingBox = vi.fn(() => {
      geometry.boundingBox = { min: { x: 0, y: 0, z: -1 }, max: { x: 2, y: 6, z: 1 } }
    })
    expect(partCentre(viewer, PIN)).toEqual(BOX_CENTRE)
    expect(geometry.computeBoundingBox).toHaveBeenCalledTimes(1)
  })

  it('answers null for a path the scene draws no solid for', () => {
    expect(partCentre(scene().viewer, '/model/not a part')).toBeNull()
  })

  it('answers null for a group with no tessellation, and for no viewer', () => {
    const viewer = fakeViewer({
      states: statesFor([PIN]), groups: { [PIN]: fakeGroup() } })
    expect(partCentre(viewer, PIN)).toBeNull()
    expect(partCentre(null, PIN)).toBeNull()
  })
})
