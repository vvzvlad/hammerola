// Where a comment hangs on a build that is not the one it was written on.
//
// A comment is bound to the PRINTED ENTITY, and the entity is its catalogue key
// (issue #75). Everything below is a claim about that binding surviving — or
// visibly not surviving — a rebuild: the tessellator renumbers paths, the
// geometry moves, and the key is the only field that means the same thing on the
// next commit.
//
// THE TREES ARE WRITTEN OUT HERE, node by node, like repeats.test.js's and for
// the same reason: what is under test reads `id`, `name`, `key` and `children`
// exactly as given, so a hand-written child exercises it as faithfully as a
// pushed one — and the fixture's model references no part twice, so it holds no
// run of repeats to hang the "first instance only" rule on.
//
// NAMES AND KEYS ARE ALWAYS SPELLED APART, so no assertion here can pass by
// accident under an anchor written on the display name or on the path.

import { describe, expect, it } from 'vitest'

import { anchorFor, indexTree, rowsByKey } from '../src/hub.js'

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
  keyRows: rowsByKey(tree), parts: { pin: {}, bracket: {} }, ...over,
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
  it('takes the stored point when the commit AND the view both match', () => {
    const at = anchorFor(record({ point: [1, 2, 3.5] }), on(TREE));
    expect(at).toEqual({ state: 'point', path: null, point: [1, 2, 3.5] });
  });

  it('falls back to the part on another commit, however alive the point is', () => {
    // The same numbers on the next build point at whatever the rebuild moved
    // there, which is why they are only read on the build they were taken on.
    const at = anchorFor(record({ point: [1, 2, 3.5] }),
                         on(TREE, { commit: 'def456' }));
    expect(at).toEqual({ state: 'part', path: '/model/pin', point: null });
  });

  it('falls back to the part in another view of the same build', () => {
    const at = anchorFor(record({ point: [1, 2, 3.5], view: 'exploded' }),
                         on(TREE));
    expect(at.state).toBe('part');
  });

  it('ignores a point that is not three finite numbers', () => {
    for (const point of [[1, 2], [1, 2, 'x'], [1, 2, NaN], [1, 2, Infinity]]) {
      expect(anchorFor(record({ point }), on(TREE)).state).toBe('part');
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
    // the guard a record written before the field existed would match a build
    // whose meta.json declares none — a false positive on exactly the pair the
    // field was added for.
    for (const stamp of [undefined, null, '']) {
      expect(anchorFor(record({ published: stamp, point: [1, 2, 3.5] }),
                       on(TREE, { published: stamp })).state).toBe('part');
      expect(anchorFor(record({ published: stamp, point: [1, 2, 3.5] }),
                       on(TREE)).state).toBe('part');
      expect(anchorFor(record({ point: [1, 2, 3.5] }),
                       on(TREE, { published: stamp })).state).toBe('part');
    }
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
