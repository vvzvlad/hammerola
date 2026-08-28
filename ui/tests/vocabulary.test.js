// One arrangement of the project list, four places it has to reach — checked by
// ASKING THE LANGUAGE, not by reading the source.
//
// A sort is a stored value, a tab label and a comparator; a view is a stored
// value, a tab icon and a body that draws the rows. `store.js` holds the two
// vocabularies, `HammerolaEntry.jsx` holds the four tables, and every pairing
// fails silently and differently:
//
//   * a sort store.js knows with no entry in `SORT_CMP` hands
//     `Array.prototype.sort` an `undefined` comparator. That is not "unsorted",
//     it is "compared as strings" — every row equal, arrival order kept, the new
//     tab lit, and the choice remembered for ever;
//   * a view with no entry in `VIEW_BODIES` draws nothing under a live header;
//   * a table entry store.js does NOT know is a tab that works until the next
//     page load and then quietly forgets, which is the bug the memory exists to
//     fix, reintroduced for one option.
//
// THIS FILE EXISTS BECAUSE THE PREVIOUS VERSION OF THE CHECK WAS A PARSER, and
// it passed on exactly the defect it was written for. It lived in
// `tests/test_ui_source.py`, matched braces and collected the words after
// commas, and `strip_comments()` there removes only whole-line comments by
// design — so a trailing `// oldest project, parts come from metrics` on the
// last row of a table put a comma at depth zero and handed the parser the next
// word as a key. Sort added to store.js and to the labels, comparator left out,
// suite green. The same parser also broke the other way: a trailing comment with
// no comma swallowed the following real key, and a comma inside a label string
// (`'Last built, newest'` — an ordinary bit of UI wording) failed on nothing at
// all.
//
// The keys of an object are something the runtime computes exactly. There is no
// version of "derive it from the text" that is better than importing it, so the
// invariant moved to where the values can be imported. What is left in Python is
// the one property that is genuinely about the TEXT rather than about a value:
// that the render does not go back to comparing `this.view` against a literal.

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
 * ONE FIXTURE FOR BOTH, and it has to hold every field a comparator sorts on —
 * so `test('has a comparator that actually orders two rows')` below asserts
 * exactly that, and a sort added on a field nobody put here fails with a
 * sentence about the fixture instead of with "the comparator calls two rows
 * equal", which would be true and would send the reader to the wrong file.
 */
const ROWS = [
  { pid: 'a', title: 'Adapter', slug: 'adapter', meta: '3 parts', rev: 'e05f73b', dev: false,
    built: '2026-08-03T00:00:00Z', first: '2025-01-01T00:00:00Z' },
  { pid: 'b', title: 'Bracket', slug: 'bracket', meta: '1 part', rev: 'aa11bb2', dev: true,
    built: '2026-08-01T00:00:00Z', first: '2026-07-01T00:00:00Z' },
]

/** What a body reads off the page: a frame and a pair of hover handlers. */
const page = { hover: () => ({}), cardStyle: () => '' }

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
    // RUN, NOT MEASURED. `SORT_CMP[id].length === 2` stood here, and declared
    // arity is not the property wanted: `(a, b = a) => …` reports 1 and
    // `(...rows) => …` reports 0, so an ordinary rewrite of a comparator fails
    // a check about something else entirely — while the only defect the number
    // catches beyond `typeof` is a comparator that ignores a row, which running
    // it catches properly. Two rows differing in every field any comparator
    // here reads, so one that calls them equal calls everything equal — the
    // silent failure this file's header is about, and the one shape a table of
    // the right keys can still have.
    const [a, b] = ROWS

    // THE FIXTURE IS CHECKED BEFORE THE COMPARATORS ARE, because otherwise a
    // sort added on a field nobody put in `ROWS` fails below with "calls two
    // rows equal" — a true sentence pointing at the wrong file, which reads as a
    // bug in the comparator somebody has just written correctly.
    // `arrangement.test.js` carries the same barrier for the same reason ("a
    // view was added with no way to recognise what it draws").
    //
    // Spelled out rather than derived, because a sort id is not its field:
    // `modified` orders on `built`. The map's whole job is to notice a sort with
    // nothing behind it here; a comparator that changes which field it reads
    // makes an entry stale without making anything wrong.
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
    // RUN, NOT MEASURED, and the objection is the comparator's above, word for
    // word. `VIEW_BODIES[id].length === 2` stood here: `(page, rows = []) =>`
    // reports 1 and `(...[page, rows]) =>` reports 0, so two ordinary rewrites
    // fail a check about something else — while a body that IGNORES its rows,
    // `(page, rows) => (rows = [], …)`, satisfies it exactly. That last one is
    // the whole failure this table exists to prevent: an empty list under a live
    // header, the tab lit, the choice remembered.
    //
    // The links and not the container: every body emits its wrapper whether or
    // not it has anything to put inside, so counting wrappers cannot tell a list
    // from an empty one. `key` is the row's `pid`, so the sequence says how many
    // rows were drawn AND in what order.
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
    // Everything above holds at IMPORT TIME, once — so an importer that writes a
    // sixth entry afterwards puts the page in an arrangement no check here ever
    // saw, and nothing anywhere would report it. `Object.freeze` costs nothing
    // and closes the question, and it was unchecked until this test: taking it
    // off all six left the suite green.
    //
    // The two LISTS are the ones that matter. An extra key in a table is an
    // answer nobody asks for; an extra id in `PROJECT_VIEWS` is a tab that gets
    // drawn, a value `choose` accepts, a value storage keeps — and then a lookup
    // into a table that has never had it.
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
