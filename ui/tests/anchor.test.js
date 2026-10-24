// Where a comment hangs on a build that is not the one it was written on.
//
// A comment is bound to the printed entity, i.e. its catalogue key. These tests
// check that binding survives (or visibly fails to survive) a rebuild: the
// tessellator renumbers paths, the geometry moves, and the key is the only
// field that means the same on the next commit.
//
// The trees are written out node by node (as in repeats.test.js): the code
// under test reads `id`, `name`, `key` and `children` as given, and the
// fixture's model references no part twice, so it has no repeats to test the
// "first instance only" rule on.
//
// Names and keys are always spelled differently, so no assertion can pass by
// accident on an anchor written on the display name or the path.

import { describe, expect, it } from 'vitest'

import { anchorFor, indexTree, placementIn, rowsByKey } from '../src/hub.js'

/** A leaf of the tree the viewport emits: a path, a name and a catalogue key. */
const leaf = (name, key) => ({ id: `/model/${name}`, name, key });

/** The viewport's `hmr:model` tree, with these children under one root. */
const model = (children) => ({ id: '/model', name: 'model', children });

/** What `meta.published` is: the millisecond the hub took the push. */
const STAMP = '2026-08-27T18:00:00.123Z';

/** A stored comment, in the shape `CommentStore.add` writes it (SPEC 7A.1). */
const record = (over = {}) => ({
  id: 'c1', commit: 'abc123', published: STAMP, view: 'assembled',
  part: '/model/pin', key: 'pin', point: null, ...over,
});

/** The build on screen: this commit, this view, this tree, this catalogue. */
const on = (tree, over = {}) => ({
  commit: 'abc123', published: STAMP, view: 'assembled',
  keyRows: rowsByKey(tree), nodes: tree.nodes, parts: { pin: {}, bracket: {} },
  ...over,
});

const TREE = indexTree(model([leaf('pin', 'pin'), leaf('pin(2)', 'pin'),
                             leaf('washer', 'bracket')]));

describe('rowsByKey', () => {
  it('maps a catalogue key to the row that draws it', () => {
    const rows = rowsByKey(TREE);
    expect(rows.get('pin').id).toBe('/model/pin');
    expect(rows.get('bracket').id).toBe('/model/washer');
  });

  it('answers with the FIRST row in tree order when a view draws two', () => {
    // Two groups, the same part in each: `runsOf` collapses adjacent siblings
    // only, so this is two rows and one key. One comment gets one pin.
    const split = indexTree(model([
      { id: '/model/a',
        name: 'a',
        children: [{ id: '/model/a/pin', name: 'pin', key: 'pin' }] },
      { id: '/model/b',
        name: 'b',
        children: [{ id: '/model/b/pin(2)', name: 'pin(2)', key: 'pin' }] },
    ]));
    expect(rowsByKey(split).get('pin').id).toBe('/model/a/pin');
  });

  it('keeps the rows that carry no key out of the map', () => {
    const rows = rowsByKey(indexTree(model([leaf('plate', null)])));
    // The root is a group and a group never carries one either.
    expect(rows.size).toBe(0);
  });

  it('answers with an empty map when there is no tree yet', () => {
    expect(rowsByKey(null).size).toBe(0);
  });
});

describe('anchorFor trusts the coordinate on its own build only', () => {
  it('takes the stored point when the build stamp AND the view both match', () => {
    const at = anchorFor(record({ point: [1, 2, 3.5] }), on(TREE));
    expect(at).toEqual({ state: 'point', path: null, point: [1, 2, 3.5] });
  });

  it('falls back to the part on another build, however alive the point is', () => {
    // The same numbers on the next build point at whatever the rebuild moved
    // there, which is why they are only read on the build they were taken on.
    const at = anchorFor(record({ point: [1, 2, 3.5] }),
                         on(TREE, { commit: 'def456',
                                    published: '2026-08-28T09:00:00.000Z' }));
    expect(at).toEqual({ state: 'part', path: '/model/pin', point: null });
  });

  it('takes the point across the slot and the revision minted from it', () => {
    // THE OWNER'S CASE. A revision minted from `dev` keeps the slot's stamp, so
    // one build is on screen as `dev` and as its hash: a comment left on either
    // page is a place on the geometry the other one shows.
    const hash = '9ca7b5e1d2c3b4a59687706f5e4d3c2b1a09f8e7';
    const fromSlot = anchorFor(record({ commit: 'dev', point: [1, 2, 3.5] }),
                               on(TREE, { commit: hash }));
    const fromRevision = anchorFor(record({ commit: hash, point: [1, 2, 3.5] }),
                                   on(TREE, { commit: 'dev' }));
    expect(fromSlot).toEqual({ state: 'point', path: null, point: [1, 2, 3.5] });
    expect(fromRevision).toEqual({ state: 'point', path: null, point: [1, 2, 3.5] });
  });

  it('carries the point into another view of the same build', () => {
    // The view moves the part and keeps its vertices, so the coordinate is still
    // a place on it once the two placements are undone and redone (`sync`).
    const at = anchorFor(record({ point: [1, 2, 3.5], view: 'exploded' }),
                         on(TREE, { commit: 'dev' }));
    expect(at).toEqual({ state: 'carried', path: '/model/pin', point: [1, 2, 3.5] });
  });

  it('carries it onto the instance it was left on when this view draws it', () => {
    const at = anchorFor(
      record({ point: [1, 2, 3.5], view: 'exploded', part: '/model/pin(2)' }),
      on(TREE));
    expect(at).toEqual({ state: 'carried', path: '/model/pin(2)', point: [1, 2, 3.5] });
  });

  it('carries it onto the instance it was left on in a group of its own', () => {
    // Two groups make two rows under one key, and `rowsByKey` keeps the first:
    // the clicked instance is not among that row's leaves, yet it is drawn here.
    const split = indexTree(model([
      { id: '/model/a', name: 'a',
        children: [{ id: '/model/a/pin', name: 'pin', key: 'pin' }] },
      { id: '/model/b', name: 'b',
        children: [{ id: '/model/b/pin(2)', name: 'pin(2)', key: 'pin' }] },
    ]));
    const at = anchorFor(
      record({ point: [1, 2, 3.5], view: 'exploded', part: '/model/b/pin(2)' }),
      on(split));
    expect(at).toEqual({ state: 'carried', path: '/model/b/pin(2)', point: [1, 2, 3.5] });
  });

  it('carries it onto the first instance when the stored path names another part here', () => {
    const at = anchorFor(
      record({ point: [1, 2, 3.5], view: 'exploded', part: '/model/washer' }),
      on(TREE));
    expect(at).toEqual({ state: 'carried', path: '/model/pin', point: [1, 2, 3.5] });
  });

  it('carries it onto the first instance when this view draws the part elsewhere', () => {
    const at = anchorFor(
      record({ point: [1, 2, 3.5], view: 'exploded', part: '/other/pin' }),
      on(TREE));
    expect(at).toEqual({ state: 'carried', path: '/model/pin', point: [1, 2, 3.5] });
  });

  it('carries nothing into a view that does not draw the part', () => {
    const other = indexTree(model([leaf('washer', 'bracket')]));
    const at = anchorFor(record({ point: [1, 2, 3.5], view: 'exploded' }), on(other));
    expect(at).toEqual({ state: 'elsewhere', path: null, point: null });
  });

  it('carries no point into another view of another build', () => {
    const at = anchorFor(record({ point: [1, 2, 3.5], view: 'exploded' }),
                         on(TREE, { published: '2026-08-28T09:00:00.000Z' }));
    expect(at).toEqual({ state: 'part', path: '/model/pin', point: null });
  });

  it('ignores a point that is not three finite numbers', () => {
    for (const point of [[1, 2], [1, 2, 'x'], [1, 2, NaN], [1, 2, Infinity]]) {
      expect(anchorFor(record({ point }), on(TREE)).state).toBe('part');
      expect(anchorFor(record({ point, view: 'exploded' }), on(TREE)).state)
        .toBe('part');
    }
  });

  it('falls back to the part on the NEXT build of the local slot', () => {
    // The slot's commit is the constant `dev` for every build it will ever hold
    // (SPEC 7.6), so `commit` matches every previous incarnation of it and the
    // stale coordinate would be painted onto geometry that has been rebuilt
    // since. `published` is what tells the two apart.
    const dev = { commit: 'dev', published: '2026-08-27T18:00:01.500Z' };
    const at = anchorFor(record({ ...dev, point: [1, 2, 3.5] }),
                         on(TREE, { ...dev, published: STAMP }));
    expect(at).toEqual({ state: 'part', path: '/model/pin', point: null });
  });

  it('takes the point on the SAME build of the slot, `dev` and all', () => {
    const dev = { commit: 'dev', published: STAMP };
    const at = anchorFor(record({ ...dev, point: [1, 2, 3.5] }),
                         on(TREE, dev));
    expect(at).toEqual({ state: 'point', path: null, point: [1, 2, 3.5] });
  });

  it('never takes the point when either side carries no stamp', () => {
    // `undefined === undefined` and `null === null` are both true, so without
    // the guard a record with no stamp would match a build whose meta.json
    // declares none.
    for (const stamp of [undefined, null, '']) {
      expect(anchorFor(record({ published: stamp, point: [1, 2, 3.5] }),
                       on(TREE, { published: stamp })).state).toBe('part');
      expect(anchorFor(record({ published: stamp, point: [1, 2, 3.5] }),
                       on(TREE)).state).toBe('part');
      expect(anchorFor(record({ point: [1, 2, 3.5] }),
                       on(TREE, { published: stamp })).state).toBe('part');
      expect(anchorFor(record({ published: stamp, point: [1, 2, 3.5],
                                view: 'exploded' }),
                       on(TREE, { published: stamp })).state).toBe('part');
    }
  });
});

describe('placementIn', () => {
  const S = Math.SQRT1_2;
  /** A view document's node: an id, a placement and, for a group, its parts. */
  const node = (id, loc, parts) => ({ id, ...(loc ? { loc } : {}),
                                      ...(parts ? { parts } : {}) });

  it('reads a leaf of an unmoved group as its own loc', () => {
    // The glass view of the owner's build: `back_right` laid flat, under a
    // root and a group that stand where the model put them.
    const doc = node('/Group', [[0, 0, 0], [0, 0, 0, 1]], [
      node('/Group/glass', [[0, 0, 0], [0, 0, 0, 1]], [
        node('/Group/glass/back_right', [[-672.5, -603.5, 495], [-S, 0, 0, S]]),
      ]),
    ]);
    expect(placementIn(doc, '/Group/glass/back_right')).toEqual({
      position: [-672.5, -603.5, 495], quaternion: [-S, 0, 0, S],
    });
  });

  it('composes the locs from the root down, parent first', () => {
    // A quarter turn about z at the root, a shift in the group, a quarter turn
    // about x at the leaf. Taken the other way round, the leaf's turn would be
    // applied first and the quaternion would come out [0.5, -0.5, 0.5, 0.5].
    const doc = node('/Group', [[10, 0, 0], [0, 0, S, S]], [
      node('/Group/a', [[1, 0, 0], [0, 0, 0, 1]], [
        node('/Group/a/pin', [[0, 2, 0], [S, 0, 0, S]]),
      ]),
    ]);
    const at = placementIn(doc, '/Group/a/pin');
    // [10, 0, 0] + (quarter turn about z of [1, 2, 0]).
    [8, 1, 0].forEach((v, i) => expect(at.position[i]).toBeCloseTo(v, 12));
    [0.5, 0.5, 0.5, 0.5].forEach((v, i) => expect(at.quaternion[i]).toBeCloseTo(v, 12));
  });

  it('takes a node without a loc as standing where its parent does', () => {
    // The library renders a missing loc as the identity (`renderLoop`).
    const doc = node('/Group', [[5, 6, 7], [0, 0, 0, 1]], [node('/Group/pin')]);
    expect(placementIn(doc, '/Group/pin')).toEqual({
      position: [5, 6, 7], quaternion: [0, 0, 0, 1],
    });
  });

  it('answers null for a path the document does not draw', () => {
    const doc = node('/Group', null, [node('/Group/pin')]);
    expect(placementIn(doc, '/Group/washer')).toBeNull();
    expect(placementIn(null, '/Group/pin')).toBeNull();
  });
});

describe('anchorFor follows the key through a rebuild', () => {
  it('hangs the pin on the row the key names', () => {
    const at = anchorFor(record({ key: 'bracket' }), on(TREE));
    expect(at).toEqual({ state: 'part', path: '/model/washer', point: null });
  });

  it('ignores the stored path, which the next build renumbers', () => {
    // `part` says `/model/pin(2)` and the key says `pin`: the pin goes on the
    // row, which is the first instance.
    const at = anchorFor(record({ part: '/model/pin(2)' }), on(TREE));
    expect(at.path).toBe('/model/pin');
  });

  it('pins the FIRST instance of a part the view draws five times', () => {
    const five = indexTree(model(['pin', 'pin(2)', 'pin(3)', 'pin(4)', 'pin(5)']
      .map((name) => leaf(name, 'pin'))));
    const at = anchorFor(record(), on(five));
    expect(at).toEqual({ state: 'part', path: '/model/pin', point: null });
  });

  it('says `elsewhere` for a part the catalogue has and this view does not', () => {
    const other = indexTree(model([leaf('washer', 'bracket')]));
    const at = anchorFor(record(), on(other));
    expect(at).toEqual({ state: 'elsewhere', path: null, point: null });
  });

  it('says `orphan` when the key is in no catalogue entry any more', () => {
    const at = anchorFor(record({ key: 'standoff' }), on(TREE));
    expect(at).toEqual({ state: 'orphan', path: null, point: null });
  });

  it('says `none` for a record written before the field existed', () => {
    for (const key of [undefined, null, '', 42]) {
      expect(anchorFor(record({ key }), on(TREE, { commit: 'def456' })))
        .toEqual({ state: 'none', path: null, point: null });
    }
  });

  it('reads the catalogue by hasOwnProperty, so `__proto__` is a key like any', () => {
    // A key is a string the author chose, and every object has a `__proto__`
    // and a `constructor` whether or not the catalogue declares one.
    const parts = { pin: {} };
    for (const key of ['__proto__', 'constructor', 'toString']) {
      expect(anchorFor(record({ key }), on(TREE, { parts })).state).toBe('orphan');
    }
    const declared = indexTree(model([leaf('shim', '__proto__')]));
    // Parsed rather than written as a literal: `{__proto__: {}}` in source sets
    // the prototype and declares no such entry, which is the whole hazard.
    const polluted = JSON.parse('{"__proto__": {"kind": "part"}}');
    expect(anchorFor(record({ key: '__proto__' }),
                     on(declared, { parts: polluted })))
      .toEqual({ state: 'part', path: '/model/shim', point: null });
  });

  it('answers `none` for nothing at all', () => {
    expect(anchorFor(null, on(TREE)).state).toBe('none');
  });
});
