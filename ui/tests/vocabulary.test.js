// One arrangement of the project list, four places it has to reach, checked by
// importing the values rather than reading the source.
//
// A sort is a stored value, a tab label and a comparator; a view is a stored
// value, a tab icon and a body that draws the rows. `store.js` holds the two
// vocabularies, `HammerolaEntry.jsx` holds the four tables, and every mismatch
// fails silently and differently:
//
//   * a sort store.js knows with no entry in `SORT_CMP` hands
//     `Array.prototype.sort` an `undefined` comparator: compared as strings,
//     every row equal, arrival order kept, the tab lit and the choice
//     remembered;
//   * a view with no entry in `VIEW_BODIES` draws nothing under a live header;
//   * a table entry store.js does not know is a tab that works until the next
//     page load and then is forgotten.
//
// Object keys are computed exactly by the runtime, so the invariant is checked
// on imported values; parsing the source text is unreliable (trailing
// comments, commas inside labels). What remains in Python
// (`tests/test_ui_source.py`) is the one property about the text itself: that
// the render does not compare `this.view` against a literal.

import { describe, expect, it } from 'vitest'

import {
  HammerolaProjects, SORT_CMP, SORT_LABELS, VIEW_BODIES, VIEW_ICONS,
} from '../src/HammerolaEntry.jsx'
import { PROJECT_SORTS, PROJECT_VIEWS } from '../src/store.js'
import { links } from './eltree.js'

const sorted = (names) => [...names].sort()

/**
 * Two projects carrying every field either half of this file reads.
 *
 * One fixture for both, holding every field a comparator sorts on; the
 * fixture check below makes a sort on a missing field fail with a sentence
 * about the fixture rather than "the comparator calls two rows equal".
 */
const ROWS = [
  { pid: 'a', title: 'Adapter', slug: 'adapter', meta: '3 parts', rev: 'e05f73b', dev: false,
    built: '2026-08-03T00:00:00Z', first: '2025-01-01T00:00:00Z' },
  { pid: 'b', title: 'Bracket', slug: 'bracket', meta: '1 part', rev: 'aa11bb2', dev: true,
    built: '2026-08-01T00:00:00Z', first: '2026-07-01T00:00:00Z' },
]

/**
 * What a body reads off the page: a frame, a pair of hover handlers, and the
 * delete control — which answers nothing here, the way it does for a reader
 * holding no token (`remover` in HammerolaEntry.jsx). What is under test in
 * this file is the tables, not what is drawn on a card.
 */
const page = { hover: () => ({}), cardStyle: () => '', remover: () => null }

describe('every sort the hub will remember', () => {
  it('has a tab and a comparator, and nothing else does', () => {
    expect(PROJECT_SORTS.length).toBeGreaterThan(0)
    expect(sorted(Object.keys(SORT_LABELS))).toEqual(sorted(PROJECT_SORTS))
    expect(sorted(Object.keys(SORT_CMP))).toEqual(sorted(PROJECT_SORTS))
  })

  it('has a comparator that actually orders two rows', () => {
    // `SORT_CMP.name` being a string would satisfy the key check above and then
    // throw inside `Array.prototype.sort`.
    //
    // Run, not measured: declared arity is unreliable (`(a, b = a) => …` reports
    // 1, `(...rows) => …` reports 0), and running catches a comparator that
    // ignores a row. The two rows differ in every field any comparator reads, so
    // one that calls them equal calls everything equal.
    const [a, b] = ROWS

    // The fixture is checked before the comparators, so a sort on a field missing
    // from `ROWS` fails here rather than below with "calls two rows equal",
    // which would point at the wrong file. `arrangement.test.js` has the same
    // barrier.
    //
    // Spelled out rather than derived, because a sort id is not its field:
    // `modified` orders on `built`.
    const SORT_FIELD = { name: 'title', modified: 'built', first: 'first' }
    for (const id of PROJECT_SORTS) {
      const field = SORT_FIELD[id]
      expect(field, `the sort '${id}' has no entry in this file's SORT_FIELD — say which `
        + 'row field it orders on, and give `ROWS` two different values for it').toBeTruthy()
      expect(a[field], `both rows of this file's fixture have the same ${field}, so the `
        + `'${id}' comparator below cannot tell them apart whatever it does`)
        .not.toBe(b[field])
    }

    // COMPARED AGAINST ZERO, not passed to `toBe(0)` or to `Math.sign`, and
    // both of those were tried first. `toBe` is `Object.is`, under which `-0` is
    // NOT `0`, and `Math.sign(-0)` is `-0` again — so a comparator mutated to
    // `0 * (…)`, which returns `-0` for one order and `0` for the other, passed
    // both spellings while ordering nothing at all. `<` and `>` are the
    // comparisons `Array.prototype.sort` itself makes of the answer, and they
    // put `0`, `-0` and `NaN` in one place, which is where they belong.
    const direction = (n) => {
      if (n < 0) return -1
      if (n > 0) return 1
      return 0
    }

    for (const id of PROJECT_SORTS) {
      expect(typeof SORT_CMP[id]).toBe('function')
      const forward = SORT_CMP[id](a, b)
      const backward = SORT_CMP[id](b, a)
      expect(Number.isFinite(forward) && Number.isFinite(backward),
        `SORT_CMP.${id} answered with ${forward} / ${backward}`).toBe(true)
      expect(direction(forward), `SORT_CMP.${id} calls two rows that differ in `
        + 'every field equal, which is exactly what an absent comparator does: '
        + 'the list comes back in arrival order under a lit tab').not.toBe(0)
      // And the other way round, because something that answers with the same
      // sign in both directions is not an ordering at all — `sort` would then
      // give an order that depends on which pairs it happened to compare.
      expect(direction(backward),
        `SORT_CMP.${id} is not antisymmetric`).toBe(-direction(forward))
    }
  })

  it('has a label somebody can read', () => {
    for (const id of PROJECT_SORTS) {
      expect(typeof SORT_LABELS[id]).toBe('string')
      expect(SORT_LABELS[id].trim()).not.toBe('')
    }
  })
})

describe('every view the hub will remember', () => {
  it('has a tab icon and a body, and nothing else does', () => {
    expect(PROJECT_VIEWS.length).toBeGreaterThan(0)
    expect(sorted(Object.keys(VIEW_ICONS))).toEqual(sorted(PROJECT_VIEWS))
    expect(sorted(Object.keys(VIEW_BODIES))).toEqual(sorted(PROJECT_VIEWS))
  })

  it('has a body that draws one link per row', () => {
    // Run, not measured, as for the comparators: `(page, rows = []) =>` reports
    // arity 1 and `(...[page, rows]) =>` reports 0, while a body that ignores its
    // rows can still report 2, and that is the failure this table must catch.
    //
    // The links, not the container: every body emits its wrapper even when
    // empty. `key` is the row's `pid`, so the sequence says how many rows were
    // drawn and in what order.
    for (const id of PROJECT_VIEWS) {
      expect(typeof VIEW_BODIES[id]).toBe('function')
      const drawn = links(VIEW_BODIES[id](page, ROWS))
      expect(drawn.map((el) => el.key), `the ${id} body drew ${drawn.length} links for `
        + `${ROWS.length} rows`).toEqual(ROWS.map((row) => row.pid))
    }
  })

  it('has an icon path to draw on its tab', () => {
    for (const id of PROJECT_VIEWS) {
      expect(typeof VIEW_ICONS[id]).toBe('string')
      expect(VIEW_ICONS[id]).toMatch(/^M/)
    }
  })
})

describe('the vocabulary itself', () => {
  it('cannot be added to by anything that imports it', () => {
    // Everything above is checked once, at import time, so an importer adding an
    // entry later would go unchecked; `Object.freeze` closes that.
    //
    // The two lists matter most: an extra key in a table is never asked for, but
    // an extra id in `PROJECT_VIEWS` is a drawn tab, a value `choose` accepts and
    // storage keeps, and then a lookup into a table that lacks it.
    for (const [name, table] of Object.entries({
      PROJECT_VIEWS, PROJECT_SORTS, SORT_LABELS, SORT_CMP, VIEW_ICONS, VIEW_BODIES,
    })) {
      expect(Object.isFrozen(table), `${name} can be written to after import`).toBe(true)
    }
  })
})

describe('the arrangement the page opens on', () => {
  it('is one the tables can answer for', () => {
    // What replaced two `||` fallbacks that could not fire. `state` holds only
    // what store.js was willing to hand back, so the ONLY way the page can be in
    // an arrangement its tables do not have is a default naming one — and there
    // is no runtime cover for that any more, deliberately, because the cover
    // that was there re-read the key that had just missed. This is what makes
    // the lookups total instead.
    const { defaultView, defaultSort } = HammerolaProjects.defaultProps
    expect(PROJECT_VIEWS).toContain(defaultView)
    expect(PROJECT_SORTS).toContain(defaultSort)
    expect(VIEW_BODIES[defaultView]).toBeTypeOf('function')
    expect(SORT_CMP[defaultSort]).toBeTypeOf('function')
  })
})
