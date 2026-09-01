// ui/src/store.js — everything these pages remember in the browser: the token,
// the notes, which pointer the reader was last on, and how the front page's
// list of projects is arranged.
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
// and the other two are what a reader's browser carries between visits. Reusing
// the module's own expression would give a test that agrees with itself whatever
// it is changed to.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearToken, readNotes, readProjectSort, readProjectView, readToken,
  rememberPointer, writeNotes, writeProjectSort, writeProjectView, writeToken,
} from '../src/store.js'

const POINTER_KEY = 'hammerola.pointer.proj1'
const TOKEN_KEY = 'hammerola.token'
const NOTES_KEY = 'hammerola.notes.proj1'
const VIEW_KEY = 'hammerola.projects_view'
const SORT_KEY = 'hammerola.projects_sort'

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
