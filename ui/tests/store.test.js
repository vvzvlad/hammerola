// ui/src/store.js — everything these pages remember in the browser: the token,
// the notes, which pointer the reader was last on, how the front page's list of
// projects is arranged, and the strip of projects this browser has been in.
//
// THE STORAGE IS A DOUBLE, AND THE DOUBLE IS THE WHOLE TEST. There is no
// `localStorage` in this runner at all: Node's own global of that name is
// undefined unless the process was started with `--localstorage-file`, and it
// wins over the one jsdom would otherwise put on the window — so `typeof
// localStorage` is `undefined` here, both as a global and as `window.localStorage`.
// Every access in store.js sits inside a try/catch that reads an absent storage
// as "nothing was remembered", so against the bare runner these tests pass with
// the module gutted: `writeToken` would store nothing, `readToken` would return
// null, and a test that only checks "no throw" would be perfectly happy.
//
// Hence the two rules this file is built on:
//
//   * the double is installed for the WHOLE FILE, not for one `describe`. A
//     `beforeEach` inside one block is an invitation for the next block to be
//     written beside it without one — and that block would go green against a
//     module that stored nothing;
//   * its absence is an ERROR RATHER THAN SILENCE. `expectTheDouble()` below
//     runs before every test and says out loud what broke, because the failure
//     it guards against does not look like a failure: it looks like a passing
//     suite.
//
// That matters most for the TOKEN. It is the one secret these pages hold, and
// "the token was silently not saved" is indistinguishable from "the token was
// saved" to any test that does not look at the storage it was saved into.
//
// The keys are written out below rather than imported, and that is the one place
// here where a literal is the right answer: they are the OBSERVABLE — the
// pointer key is read by a module outside this bundle entirely
// (`static/_v/pointer_pref.js`, compared as text by `tests/test_pointer_memory.py`),
// and the others are what a reader's browser carries between visits. Reusing
// the module's own expression would give a test that agrees with itself whatever
// it is changed to.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearToken, forgetTab, readNotes, readProjectSort, readProjectView, readTabs,
  readToken, rememberPointer, rememberTab, TAB_CAP, writeNotes,
  writeProjectSort, writeProjectView, writeToken,
} from '../src/store.js'

const POINTER_KEY = 'hammerola.pointer.proj1'
const TOKEN_KEY = 'hammerola.token'
const NOTES_KEY = 'hammerola.notes.proj1'
const VIEW_KEY = 'hammerola.projects_view'
const SORT_KEY = 'hammerola.projects_sort'
const TABS_KEY = 'hammerola.tabs'

/** The smallest thing store.js can tell from the real one, plus a way to fail. */
function fakeStorage({ failing = false } = {}) {
  const cells = new Map()
  return {
    cells,
    getItem: (k) => (cells.has(k) ? cells.get(k) : null),
    setItem: (k, v) => {
      if (failing) throw new Error('storage is off')
      cells.set(k, String(v))
    },
    removeItem: (k) => { cells.delete(k) },
  }
}

let storage

function install(replacement) {
  storage = replacement
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage, configurable: true, writable: true,
  })
}

/**
 * The guard: this test is about to assert something about stored values, and
 * there has to be somewhere for them to be stored.
 *
 * A thrown Error rather than an `expect`, because what it reports is not a
 * failed assertion about the code under test — it is this file having stopped
 * testing anything, and the message has to say so in those words.
 */
function expectTheDouble() {
  if (typeof localStorage === 'undefined' || localStorage !== storage) {
    throw new Error(
      'ui/tests/store.test.js: the storage double is not installed at the start '
      + 'of this test. Nothing below is testing anything: this runner has no '
      + '`localStorage` of its own, and every access in ui/src/store.js catches '
      + 'the absence and reports it as "nothing was remembered" — so a gutted '
      + 'store.js passes every assertion in this file. Put `install(fakeStorage())` '
      + 'back in the file-level beforeEach.')
  }
}

beforeEach(() => {
  install(fakeStorage())
  expectTheDouble()
})

afterEach(() => {
  vi.restoreAllMocks()
  delete globalThis.localStorage
})

// -- the token ---------------------------------------------------------------
// What separates the customer from the viewer: having it opens notes, moving a
// part and writing a comment. ONE KEY FOR THE WHOLE SITE, because the hub has
// one secret (EDIT_TOKEN) and the front page — which names no project — is a
// place to enter it. It is a key that can be revoked rather than an account, so
// it lives in this browser, removable in one click.

describe('the token', () => {
  it('is stored under one site-wide key, and read back', () => {
    writeToken('sekrit')
    expect(storage.getItem(TOKEN_KEY)).toBe('sekrit')
    expect(readToken()).toBe('sekrit')
  })

  it('is not keyed by anything, so signing in once covers every project', () => {
    // The property this replaced was the opposite one, and it was right while
    // the shape of the human token was still undecided. It is checked in this
    // direction now because the regression available is a per-project key coming
    // back: the front page would then write a cell no project page ever reads,
    // and signing in there would look like it worked and do nothing.
    writeToken('sekrit')
    expect([...storage.cells.keys()]).toEqual([TOKEN_KEY])
  })

  it('trims what was pasted', () => {
    // A token arrives by copy and paste, and a selection that took a trailing
    // newline with it would otherwise be sent to the hub as a different string.
    writeToken('  sekrit\n')
    expect(storage.getItem(TOKEN_KEY)).toBe('sekrit')
  })

  it('takes the key away for a blank value rather than storing an empty one', () => {
    // `readToken` reads '' as null anyway, so an empty cell would be a key that
    // says nothing and still shows up in a browser's storage inspector.
    writeToken('sekrit')
    writeToken('   ')
    expect(storage.cells.has(TOKEN_KEY)).toBe(false)
    expect(readToken()).toBeNull()
  })

  it('is removed by clearToken, which is the "back to viewing" button', () => {
    writeToken('sekrit')
    clearToken()
    expect(storage.cells.has(TOKEN_KEY)).toBe(false)
    expect(readToken()).toBeNull()
  })

  it('reads null where nothing was stored', () => {
    expect(readToken()).toBeNull()
  })

  it('survives a browser that refuses storage', () => {
    // A private window throws on the ACCESS, not on the return value, and this
    // runs from a React render — an uncaught throw there takes the interface
    // down over a preference. The token is simply not remembered.
    install(fakeStorage({ failing: true }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => writeToken('sekrit')).not.toThrow()
    expect(readToken()).toBeNull()
  })
})

// -- the notes ---------------------------------------------------------------
// A note is a property of a PART and belongs to the project rather than to a
// build: "3.2 mm wall, printer minimum, leave it" is true before a rebuild and
// after one. There is no endpoint for them, so they live here, keyed by the
// part's CATALOGUE KEY since issue #75 — the identity the model declares, which
// survives a rebuild and does not change between the print view and the
// assembled one the way a row's name does. Nothing in THIS module knows that:
// it stores whatever map it is handed under the project's key, which is why the
// change cost it no code and no test.

describe('the notes', () => {
  const notes = { 'bracket-left': '3.2 mm wall, leave it', clamp: 'reprint in PETG' }

  it('round-trip under the project\'s own key', () => {
    writeNotes('proj1', notes)
    expect(storage.getItem(NOTES_KEY)).toBe(JSON.stringify(notes))
    expect(readNotes('proj1')).toEqual(notes)
  })

  it('key by project, so two models never share one part\'s note', () => {
    writeNotes('proj1', { clamp: 'here' })
    writeNotes('proj2', { clamp: 'there' })
    expect(readNotes('proj1')).toEqual({ clamp: 'here' })
    expect(readNotes('proj2')).toEqual({ clamp: 'there' })
  })

  it('read as an empty map when nothing was written, or there is no project', () => {
    expect(readNotes('proj1')).toEqual({})
    expect(readNotes('')).toEqual({})
  })

  it('read as an empty map rather than throwing on text that is not JSON', () => {
    // Written by an older version of this page, or edited by hand. Starting
    // empty loses notes; throwing loses the interface.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    storage.setItem(NOTES_KEY, 'not json at all')
    expect(readNotes('proj1')).toEqual({})
  })

  it('read as an empty map when the stored JSON is not a map of names', () => {
    // An array parses perfectly well and would then be indexed by part name,
    // which is a lookup that always answers `undefined`.
    storage.setItem(NOTES_KEY, JSON.stringify(['a', 'b']))
    expect(readNotes('proj1')).toEqual({})
    storage.setItem(NOTES_KEY, JSON.stringify(null))
    expect(readNotes('proj1')).toEqual({})
  })

  it('write an empty map for a missing one, rather than the word "null"', () => {
    writeNotes('proj1', null)
    expect(storage.getItem(NOTES_KEY)).toBe('{}')
    expect(readNotes('proj1')).toEqual({})
  })

  it('write nothing at all without a project to key them by', () => {
    writeNotes('', notes)
    expect(storage.cells.size).toBe(0)
  })

  it('survive a browser that refuses storage', () => {
    install(fakeStorage({ failing: true }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => writeNotes('proj1', notes)).not.toThrow()
    expect(readNotes('proj1')).toEqual({})
  })
})

// -- the pointer memory ------------------------------------------------------
// The one thing this bundle stores that somebody else reads: the resolver page
// at /project/<pid>/ has a module of its own (`static/_v/pointer_pref.js`)
// because it must not pull this bundle to answer one question and leave. Nothing
// in JavaScript can check that the two spellings of the key agree — the resolver
// is not in this bundle and is not going to be — so `tests/test_pointer_memory.py`
// compares them as text. What is left for this file is the behaviour behind the
// key: which names get recorded, which get refused, and that a browser refusing
// storage does not take the page down with it.

describe('rememberPointer', () => {
  it('records either of the two moving names under the project key', () => {
    rememberPointer('proj1', 'dev')
    expect(storage.getItem(POINTER_KEY)).toBe('dev')
    rememberPointer('proj1', 'latest')
    expect(storage.getItem(POINTER_KEY)).toBe('latest')
  })

  it('keys by project, so two models never share one answer', () => {
    rememberPointer('proj1', 'dev')
    rememberPointer('proj2', 'latest')
    expect(storage.getItem('hammerola.pointer.proj1')).toBe('dev')
    expect(storage.getItem('hammerola.pointer.proj2')).toBe('latest')
  })

  // A commit id here is the failure that looks like nothing at all: the resolver
  // compares what it reads against the two moving names, so an unknown value is
  // read as "nothing remembered" and every later visit lands on `latest`.
  // Opening one pinned build would silently cost a reader their `dev`.
  it('refuses a commit id and leaves what was remembered standing', () => {
    rememberPointer('proj1', 'dev')
    rememberPointer('proj1', 'abc1234')
    expect(storage.getItem(POINTER_KEY)).toBe('dev')
  })

  it('refuses an empty name and an empty project', () => {
    rememberPointer('proj1', '')
    rememberPointer('', 'dev')
    expect(storage.cells.size).toBe(0)
  })

  // A private window throws on the ACCESS, not on the return value, and this
  // runs during componentDidMount — an uncaught throw there takes the whole
  // interface down over a remembered preference.
  it('survives a browser that refuses storage', () => {
    install(fakeStorage({ failing: true }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => rememberPointer('proj1', 'dev')).not.toThrow()
  })

  it('survives a browser with no storage object at all', () => {
    delete globalThis.localStorage
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => rememberPointer('proj1', 'dev')).not.toThrow()
  })
})

// -- how the project list is arranged ----------------------------------------
// Tiles or rows, and in what order. One key each for the whole site, because a
// hub has one list of projects and the page holding it names no project.
//
// EVERY TEST BELOW IS ABOUT THE VALUE COMING BACK, not about the value going in.
// What is in a cell is a string this browser has been carrying since whichever
// version of the page wrote it, and the failure being guarded against is not a
// wrong arrangement — it is a sort id with no comparator behind it (a list in no
// order at all) or a view id no branch draws (a blank page under a live header),
// both reached without anybody doing anything wrong.

describe('the arrangement of the project list', () => {
  it('round-trips both answers, each under its own site-wide key', () => {
    writeProjectView('list')
    writeProjectSort('name')
    expect(storage.getItem(VIEW_KEY)).toBe('list')
    expect(storage.getItem(SORT_KEY)).toBe('name')
    expect(readProjectView()).toBe('list')
    expect(readProjectSort()).toBe('name')
  })

  it('is keyed by nothing, so it is the same answer on every visit', () => {
    // The point of the feature: the page at `/` has no project to key by, and
    // the reader who chose rows meant rows next time too.
    writeProjectView('list')
    writeProjectSort('first')
    expect([...storage.cells.keys()].sort()).toEqual([SORT_KEY, VIEW_KEY])
  })

  it('reads null where nothing was stored, which is "use the default"', () => {
    // The default itself is NOT here. It is the page's own statement
    // (HammerolaProjects.defaultProps), and a copy of it in this module would
    // make "which default won" a question with two answers.
    expect(readProjectView()).toBeNull()
    expect(readProjectSort()).toBeNull()
  })

  it('reads null for a value it has no way to draw', () => {
    // Left by an older version of this page, by something else on this origin,
    // or typed into a storage inspector. `sort` is the one that bites hardest:
    // an unknown id reaches `sorted()` as a missing comparator.
    storage.setItem(VIEW_KEY, 'kanban')
    storage.setItem(SORT_KEY, 'size')
    expect(readProjectView()).toBeNull()
    expect(readProjectSort()).toBeNull()
  })

  it('reads null for the shapes a value is not, rather than throwing', () => {
    storage.setItem(VIEW_KEY, '')
    storage.setItem(SORT_KEY, '{"sort":"name"}')
    expect(readProjectView()).toBeNull()
    expect(readProjectSort()).toBeNull()
  })

  it('one unreadable answer does not take the other with it', () => {
    // The whole reason these are two keys and not one JSON object: a cell that
    // cannot be read costs only itself.
    writeProjectSort('name')
    storage.setItem(VIEW_KEY, 'kanban')
    expect(readProjectView()).toBeNull()
    expect(readProjectSort()).toBe('name')
  })

  it('refuses to store a name it does not know, leaving what stands', () => {
    // Refused rather than corrected to a default, exactly as `rememberPointer`
    // treats a commit id: what was remembered is a real answer somebody gave,
    // and a caller's typo must not be able to lose it.
    writeProjectView('list')
    writeProjectView('kanban')
    writeProjectView(undefined)
    expect(readProjectView()).toBe('list')
    writeProjectSort('name')
    writeProjectSort('size')
    expect(readProjectSort()).toBe('name')
  })

  it('survives a browser that refuses storage', () => {
    install(fakeStorage({ failing: true }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => writeProjectView('list')).not.toThrow()
    expect(readProjectView()).toBeNull()
  })

  it('survives a browser with no storage object at all', () => {
    delete globalThis.localStorage
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => writeProjectSort('name')).not.toThrow()
    expect(readProjectSort()).toBeNull()
  })
})

// -- the strip of projects this browser has been in --------------------------
// Navigation memory beside the address: a list of links at `/project/<pid>/`,
// nothing more. Nothing here stores WHICH tab is active — that is the pid in the
// URL — so there is no such assertion below and there must not be one.
//
// THE FIRST LIST THIS MODULE STORES, and the shape of these tests follows from
// that. A scalar is either readable or it is not; a list can be nine good
// entries and one somebody typed into a browser's storage inspector, and the
// decision (store.js says why at length) is that the bad one costs only itself.
// That property is the one no smaller test here implies.
//
// THE CLOCK IS DRIVEN RATHER THAN WAITED ON. Eviction is by LAST VISIT, so a
// suite that let `Date.now()` run would be asserting something about ten
// arrivals within one millisecond — a fact about `Array.prototype.sort`, not
// about this module. Every test that cares says what time it is.

describe('the tab strip', () => {
  /** Put the browser's clock where this test needs it. */
  const at = (ms) => vi.spyOn(Date, 'now').mockReturnValue(ms)

  /** The pids on the strip, in the order it would draw them. */
  const strip = () => readTabs().map((t) => t.pid)

  it('round-trips a project under one site-wide key', () => {
    // Site-wide, like the arrangement above: the strip spans projects, so no
    // one of them could have keyed it.
    at(1000)
    rememberTab('proj1', 'Bracket')
    expect([...storage.cells.keys()]).toEqual([TABS_KEY])
    expect(readTabs()).toEqual([{ pid: 'proj1', title: 'Bracket', seen: 1000 }])
  })

  it('appends an arrival at the end, where it then stays', () => {
    // POSITION IS THE ORDER OF OPENING. A strip that re-sorted itself by
    // recency would move a link out from under a reader already aiming at it.
    at(1000); rememberTab('a', 'A')
    at(2000); rememberTab('b', 'B')
    at(3000); rememberTab('c', 'C')
    expect(strip()).toEqual(['a', 'b', 'c'])
  })

  it('refreshes a repeat visit without moving it', () => {
    // The other half of the same sentence: opening a project already on the
    // strip moves nothing at all, it only stamps it.
    at(1000); rememberTab('a', 'A')
    at(2000); rememberTab('b', 'B')
    at(3000); rememberTab('a', 'A')
    expect(strip()).toEqual(['a', 'b'])
    expect(readTabs()[0].seen).toBe(3000)
  })

  it('takes the newer title on a repeat visit', () => {
    // A model renamed in `model.py` says its new name here on the next visit,
    // rather than the one this browser saw first and kept forever.
    at(1000); rememberTab('a', 'Bracket')
    at(2000); rememberTab('a', 'Bracket mk2')
    expect(readTabs()).toEqual([{ pid: 'a', title: 'Bracket mk2', seen: 2000 }])
  })

  it('holds ten and no more', () => {
    for (let n = 0; n < 12; n += 1) { at(1000 + n); rememberTab(`p${n}`, `P${n}`) }
    expect(TAB_CAP).toBe(10)
    expect(readTabs()).toHaveLength(TAB_CAP)
  })

  it('evicts the LEAST RECENTLY USED, and never the leftmost', () => {
    // The property the two separate orders exist for. `p0` is the project
    // somebody opened first and goes back to every day; dropping the leftmost
    // is exactly what would take it. `p1` was opened once and never again.
    for (let n = 0; n < 10; n += 1) { at(1000 + n); rememberTab(`p${n}`, `P${n}`) }
    at(5000); rememberTab('p0', 'P0')        // the daily visit
    at(6000); rememberTab('fresh', 'Fresh')  // the eleventh project

    const left = strip()
    expect(left).toHaveLength(TAB_CAP)
    expect(left).toContain('p0')
    expect(left).not.toContain('p1')
    // And surviving did not cost it its place: still the first pill drawn.
    expect(left[0]).toBe('p0')
    expect(left[left.length - 1]).toBe('fresh')
  })

  it('forgets one project and leaves the rest standing', () => {
    at(1000); rememberTab('a', 'A')
    at(2000); rememberTab('b', 'B')
    at(3000); rememberTab('c', 'C')
    forgetTab('b')
    expect(strip()).toEqual(['a', 'c'])
    // A pid that is not on the strip is not an error — the reader closed it in
    // another window, or it was evicted while this page stood open.
    forgetTab('nobody')
    expect(strip()).toEqual(['a', 'c'])
  })

  it('drops one unusable entry and keeps the good ones', () => {
    // THE DECISION THE SCALARS ABOVE NEVER HAD TO MAKE. `recall` reads a value
    // it cannot use as "nothing was remembered"; per element that reads as
    // "this entry was not remembered", and one hand-edited row must not cost a
    // reader the nine good tabs standing beside it.
    storage.setItem(TABS_KEY, JSON.stringify([
      { pid: 'a', title: 'A', seen: 1 },
      { pid: '', title: 'no id to link at', seen: 2 },
      null,
      'not an entry at all',
      { pid: 'c', seen: 3 },                       // nothing to draw
      { pid: 'd', title: 'D' },                    // nothing to evict by
      { pid: 'e', title: 'E', seen: Number.NaN },  // a stamp that sorts nowhere
      { pid: 'f', title: 'F', seen: 6 },
    ]))
    expect(strip()).toEqual(['a', 'f'])
  })

  it('keeps one entry per project, and it is the first of them', () => {
    // Nothing here writes a duplicate — `rememberTab` finds the pid before it
    // appends — but a hand-edited cell can hold one, and two entries for one
    // project are two pills going to the same place under one React key, of
    // which only the first would ever be refreshed again.
    //
    // THE FIRST IS THE ONE KEPT because position is the order of OPENING: the
    // earlier entry is the one that recorded this project's arrival, and
    // dropping it in favour of the later would move the pill rightwards under
    // a reader for a reason no rule anywhere states.
    storage.setItem(TABS_KEY, JSON.stringify([
      { pid: 'a', title: 'A', seen: 1 },
      { pid: 'b', title: 'B first', seen: 2 },
      { pid: 'c', title: 'C', seen: 3 },
      { pid: 'b', title: 'B again', seen: 4 },
    ]))
    expect(strip()).toEqual(['a', 'b', 'c'])
    expect(readTabs()[1].title).toBe('B first')
  })

  it('carries no field an entry is not made of', () => {
    // Three fields and no fourth. Whatever else a hand-edit or an older page
    // left in there is dropped on the way in rather than written back out.
    storage.setItem(TABS_KEY, JSON.stringify(
      [{ pid: 'a', title: 'A', seen: 1, slot: 'dev', note: 'hand-written' }]))
    expect(readTabs()).toEqual([{ pid: 'a', title: 'A', seen: 1 }])
  })

  it('reads an empty strip where nothing was stored', () => {
    expect(readTabs()).toEqual([])
  })

  it('reads an empty strip rather than throwing on text that is not JSON', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    storage.setItem(TABS_KEY, 'not json at all')
    expect(readTabs()).toEqual([])
  })

  it('reads an empty strip when the stored JSON is not a list', () => {
    // An object parses perfectly well and has no `.filter` — the interface,
    // gone during render, over a strip of links.
    storage.setItem(TABS_KEY, JSON.stringify({ a: 'A' }))
    expect(readTabs()).toEqual([])
    storage.setItem(TABS_KEY, JSON.stringify(null))
    expect(readTabs()).toEqual([])
    storage.setItem(TABS_KEY, JSON.stringify('a,b,c'))
    expect(readTabs()).toEqual([])
  })

  it('caps what it READS, not only what it writes', () => {
    // A cell grown by hand, or by a version of this page with a bigger cap.
    // What the page draws is what comes back from here, so the answer has to be
    // a strip and not a list of twenty — and the ten it keeps are the ten the
    // eviction would have left standing.
    const many = []
    for (let n = 0; n < 20; n += 1) many.push({ pid: `p${n}`, title: `P${n}`, seen: n })
    storage.setItem(TABS_KEY, JSON.stringify(many))
    expect(strip()).toEqual(
      ['p10', 'p11', 'p12', 'p13', 'p14', 'p15', 'p16', 'p17', 'p18', 'p19'])
  })

  it('refuses a project with no id, the way rememberPointer does', () => {
    rememberTab('', 'A')
    rememberTab(null, 'A')
    forgetTab('')
    expect(storage.cells.size).toBe(0)
  })

  it('falls back to the id where there is no title to draw', () => {
    // The same fallback a card makes on the front page (`projectCard`). A blank
    // pill is worse than an ugly one, and the link under it still works.
    at(1000)
    rememberTab('proj1', '')
    expect(readTabs()).toEqual([{ pid: 'proj1', title: 'proj1', seen: 1000 }])
  })

  it('survives a browser that refuses storage', () => {
    install(fakeStorage({ failing: true }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    at(1000)
    expect(() => rememberTab('a', 'A')).not.toThrow()
    expect(() => forgetTab('a')).not.toThrow()
    expect(readTabs()).toEqual([])
  })

  it('survives a browser with no storage object at all', () => {
    delete globalThis.localStorage
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => rememberTab('a', 'A')).not.toThrow()
    expect(readTabs()).toEqual([])
  })
})
