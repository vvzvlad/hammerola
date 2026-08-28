// The front page's memory, END TO END: a real `store.js` over a real storage,
// read by the real component. The one question the other two files cannot
// answer between them.
//
// `entry.test.js` stubs store.js, so what it proves is that the component obeys
// whatever the module says. `store.test.js` has no component, so what it proves
// is what the module says. Neither notices the failure that actually reaches a
// reader — a cell holding a value this build has no answer for — because each
// half is perfectly happy on its own: the stub can be told to return an id the
// real module would have refused, and the module can refuse an id no component
// ever asks it about.
//
// A FILE OF ITS OWN, and that IS the mechanism rather than tidiness. Undoing a
// `vi.mock` inside a file that declares one is a two-part restore — the module
// registry and the mock registration — and the second part is easy to leave
// out, at which point the next `await import()` added below it silently gets a
// module nobody meant it to have. Vitest isolates files, so a file that never
// mocks anything needs no restore at all.
//
// The storage double and the reason it is installed for the whole file are
// `store.test.js`'s, and the reasoning there applies here unchanged: this runner
// has no `localStorage`, every access in store.js reads its absence as "nothing
// was remembered", and a gutted module would pass anything that only checks for
// the absence of a throw.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import HammerolaEntry, { HammerolaProjects } from '../src/HammerolaEntry.jsx'
import { PROJECT_SORTS, PROJECT_VIEWS } from '../src/store.js'
import { links, styles } from './eltree.js'

const VIEW_KEY = 'hammerola.projects_view'
const SORT_KEY = 'hammerola.projects_sort'

/** Whatever the runner had under that name, so it can be given back exactly. */
let saved
const cells = new Map()

beforeEach(() => {
  saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  cells.clear()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k) => (cells.has(k) ? cells.get(k) : null),
      setItem: (k, v) => { cells.set(k, String(v)) },
      removeItem: (k) => { cells.delete(k) },
    },
    configurable: true,
    writable: true,
  })
  if (typeof localStorage === 'undefined') {
    throw new Error(
      'ui/tests/arrangement.test.js: the storage double is not installed. '
      + 'Nothing below is testing anything — store.js reads an absent storage '
      + 'as "nothing was remembered", so every assertion here would pass '
      + 'against a module that stored nothing at all.')
  }
})

afterEach(() => {
  // PUT BACK, not deleted. `delete` would not restore jsdom's own accessor —
  // it would remove it — and this file is one of several sharing a worker.
  if (saved) Object.defineProperty(globalThis, 'localStorage', saved)
  else delete globalThis.localStorage
  vi.restoreAllMocks()
})

/** The component as React builds it: defaultProps applied, constructor run. */
const built = () => new HammerolaProjects({ ...HammerolaProjects.defaultProps })

/**
 * WHICH view was drawn, and WHETHER IT DREW ANYTHING — two questions, and the
 * second one is not optional.
 *
 * `styles` is what makes the two bodies tellable apart, which
 * `expect(render()).toBeTruthy()` never was: `render()` returns an element
 * whichever body ran, so a page that drew tiles while the tab said rows passed.
 * Found by mutating the lookup to `VIEW_BODIES.grid`.
 *
 * But a marker alone answers only the first question, and it answered it
 * ASYMMETRICALLY: `ROWS` is the style of a row, so it exists only if something
 * was drawn, while `TILES` is the style of the grid CONTAINER, which every
 * tile body emits whether or not it has a card to put in it. So a grid that
 * drew nothing passed the whole suite while the same defect in the list was
 * caught twice — and an empty grid under a live header is precisely the screen
 * this file was written about. Every assertion about a view therefore counts
 * `links` as well: one `<a>` per project, in project order.
 */

/** What only the tiles draw, and what only the dense rows draw. */
const TILES = (style) => 'gridTemplateColumns' in style
const ROWS = (style) => style.width === '150px'

/** The cards themselves: `key` is the `pid`, so this is the list as drawn. */
const cards = (tree) => links(tree).map((el) => el.key)

const PROJECTS = [
  { pid: 'b', title: 'Bracket', built: '2026-08-01T00:00:00Z', first: '2026-07-01T00:00:00Z' },
  { pid: 'a', title: 'Adapter', built: '2026-08-03T00:00:00Z', first: '2025-01-01T00:00:00Z' },
  { pid: 'c', title: 'Clamp', built: '2026-08-02T00:00:00Z', first: '2026-02-01T00:00:00Z' },
]

describe('what one visit leaves for the next', () => {
  it('is what the next one opens on', () => {
    const first = built()
    first.setState = (patch) => { Object.assign(first.state, patch) }
    first.choose({ sort: 'name' })
    first.choose({ view: 'list' })

    // A second page load, sharing nothing with the first but the storage.
    const next = built()
    expect(next.view).toBe('list')
    expect(next.sort).toBe('name')
  })

  it('is the two cells and nothing else', () => {
    const c = built()
    c.setState = (patch) => { Object.assign(c.state, patch) }
    c.choose({ sort: 'first' })
    c.choose({ view: 'list' })
    expect([...cells.keys()].sort()).toEqual([SORT_KEY, VIEW_KEY])
  })
})

describe('a browser carrying a value this build has no answer for', () => {
  // Left by an older version of the page, by something else on this origin, or
  // typed into a storage inspector. It reaches a reader without anybody doing
  // anything wrong, and it is the case the two halves apart cannot see.
  it('opens on the defaults instead', () => {
    localStorage.setItem(VIEW_KEY, 'kanban')
    localStorage.setItem(SORT_KEY, 'size')
    const c = built()
    expect(c.view).toBe('grid')
    expect(c.sort).toBe('modified')
  })

  it('still comes out in an order', () => {
    // The failure this replaces is quiet: a comparator that is `undefined` is
    // not "unsorted", it is "compared as strings", so every row is equal and
    // the arrival order stands while the tab claims something else.
    localStorage.setItem(SORT_KEY, 'size')
    const c = built()
    c.props = { ...c.props, projects: PROJECTS }
    expect(c.sorted().map((p) => p.pid)).toEqual(['a', 'c', 'b'])
  })

  it('still draws the default view, and draws it as the default view', () => {
    // And the other half of the same failure: the view used to be a `grid ?
    // … : …` branch, which drew the dense list for every id that was not
    // `grid`, so an unknown one LOOKED like a working answer. Asserted by what
    // is on the screen rather than by "something was returned" — the default is
    // `grid`, so the tiles have to be what came back.
    localStorage.setItem(VIEW_KEY, 'kanban')
    const c = built()
    c.props = { ...c.props, projects: PROJECTS }
    const tree = c.render()
    const drawn = styles(tree)
    expect(drawn.some(TILES)).toBe(true)
    expect(drawn.some(ROWS)).toBe(false)
    // And it drew the projects, not just the grid they go in.
    expect(cards(tree)).toHaveLength(PROJECTS.length)
  })

  it('does not carry it forward as if it had been understood', () => {
    // The value stays in the cell — nothing here rewrites storage on a read —
    // but it must not come back as an answer on any later visit either.
    localStorage.setItem(SORT_KEY, 'size')
    built()
    expect(built().sort).toBe('modified')
  })
})

describe('what the page can be asked for', () => {
  it('is every arrangement store.js is willing to remember, and no other', () => {
    // Each id, through the real store and back out of a fresh component. A name
    // in the vocabulary that the component cannot come up on is a tab that
    // works until the page is reloaded.
    for (const sort of PROJECT_SORTS) {
      const c = built()
      c.setState = (patch) => { Object.assign(c.state, patch) }
      c.choose({ sort })
      expect(built().sort).toBe(sort)
      expect(() => built().sorted()).not.toThrow()
    }
    // AND THE VIEW THAT IS CHOSEN IS THE ONE THAT DRAWS. Nothing above would
    // notice a render that looked up the wrong body: the tables would still be
    // complete, the tabs still right, the id still remembered, and the page
    // would still return an element — while showing tiles to somebody who asked
    // for rows. So each view is identified by what only it puts on the screen.
    const looksLike = { grid: TILES, list: ROWS }
    for (const view of PROJECT_VIEWS) {
      const c = built()
      c.setState = (patch) => { Object.assign(c.state, patch) }
      c.choose({ view })
      const next = built()
      expect(next.view).toBe(view)
      next.props = { ...next.props, projects: PROJECTS }
      const tree = next.render()
      const drawn = styles(tree)
      expect(Object.keys(looksLike), 'a view was added with no way to recognise '
        + 'what it draws — give it one here').toContain(view)
      expect(drawn.some(looksLike[view]), `the ${view} view did not draw ${view}`)
        .toBe(true)
      for (const [other, marker] of Object.entries(looksLike)) {
        if (other !== view) {
          expect(drawn.some(marker), `the ${view} view drew ${other} instead`).toBe(false)
        }
      }
      // AND IT DREW THE PROJECTS. The marker above says which body ran; it does
      // not say the body put anything in what it emitted, and for the tiles it
      // structurally cannot — the grid container is there either way.
      expect(cards(tree), `the ${view} view drew its frame and no projects`)
        .toEqual(next.sorted().map((p) => p.pid))
    }
  })

  it('is refused an arrangement it does not have, and keeps the one it is on', () => {
    // The other end of the same filter. `recall()` covers what a BROWSER can
    // contribute; this covers what a CALLER can, and `choose` is public on an
    // exported class. The writes inside it always refused an unknown id — the
    // state did not, so the page ended up in an arrangement nothing had stored
    // and, with no `||` behind the table lookups, drew nothing at all.
    const c = built()
    c.setState = (patch) => { Object.assign(c.state, patch) }
    c.choose({ view: 'list', sort: 'name' })
    c.choose({ view: 'kanban', sort: 'size' })

    expect(c.view).toBe('list')
    expect(c.sort).toBe('name')
    expect(cells.get(VIEW_KEY)).toBe('list')
    expect(cells.get(SORT_KEY)).toBe('name')

    // And it is still the rows on the screen, not an empty page under a header.
    c.props = { ...c.props, projects: PROJECTS }
    const tree = c.render()
    const drawn = styles(tree)
    expect(drawn.some(ROWS)).toBe(true)
    expect(drawn.some(TILES)).toBe(false)
    expect(cards(tree)).toHaveLength(PROJECTS.length)
  })
})

describe('the token, over the same real storage', () => {
  it('is what a reload of the front page signs in with', () => {
    // The front page reads it in its constructor, and this is the only file
    // that can watch that happen through the real module rather than a stub.
    localStorage.setItem('hammerola.token', 'sekrit')
    expect(new HammerolaEntry({}).state.token).toBe('sekrit')
  })
})
