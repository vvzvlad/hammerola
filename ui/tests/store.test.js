// ui/src/store.js — everything this page remembers in the browser: the token,
// the notes, and which pointer the reader was last on.
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
// That matters most for the TOKEN. It is the one secret this page holds, and
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
  clearToken, readNotes, readToken, rememberPointer, writeNotes, writeToken,
} from '../src/store.js'

const POINTER_KEY = 'hammerola.pointer.proj1'
const TOKEN_KEY = 'hammerola.token.proj1'
const NOTES_KEY = 'hammerola.notes.proj1'

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
// part and comments. It is a key that can be revoked rather than an account, so
// it lives in this browser, for this project, removable in one click.

describe('the token', () => {
  it('is stored under the project\'s own key, and read back', () => {
    writeToken('proj1', 'sekrit')
    expect(storage.getItem(TOKEN_KEY)).toBe('sekrit')
    expect(readToken('proj1')).toBe('sekrit')
  })

  it('keys by project, so a token for one model never opens another', () => {
    writeToken('proj1', 'one')
    writeToken('proj2', 'two')
    expect(storage.getItem('hammerola.token.proj1')).toBe('one')
    expect(storage.getItem('hammerola.token.proj2')).toBe('two')
    expect(readToken('proj2')).toBe('two')
  })

  it('trims what was pasted', () => {
    // A token arrives by copy and paste, and a selection that took a trailing
    // newline with it would otherwise be sent to the hub as a different string.
    writeToken('proj1', '  sekrit\n')
    expect(storage.getItem(TOKEN_KEY)).toBe('sekrit')
  })

  it('takes the key away for a blank value rather than storing an empty one', () => {
    // `readToken` reads '' as null anyway, so an empty cell would be a key that
    // says nothing and still shows up in a browser's storage inspector.
    writeToken('proj1', 'sekrit')
    writeToken('proj1', '   ')
    expect(storage.cells.has(TOKEN_KEY)).toBe(false)
    expect(readToken('proj1')).toBeNull()
  })

  it('is removed by clearToken, which is the "back to viewing" button', () => {
    writeToken('proj1', 'sekrit')
    clearToken('proj1')
    expect(storage.cells.has(TOKEN_KEY)).toBe(false)
    expect(readToken('proj1')).toBeNull()
  })

  it('reads null where nothing was stored, and where there is no project', () => {
    expect(readToken('proj1')).toBeNull()
    expect(readToken('')).toBeNull()
    expect(readToken(null)).toBeNull()
  })

  it('writes nothing at all without a project to key it by', () => {
    writeToken('', 'sekrit')
    writeToken(null, 'sekrit')
    expect(storage.cells.size).toBe(0)
  })

  it('survives a browser that refuses storage', () => {
    // A private window throws on the ACCESS, not on the return value, and this
    // runs from a React render — an uncaught throw there takes the interface
    // down over a preference. The token is simply not remembered.
    install(fakeStorage({ failing: true }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => writeToken('proj1', 'sekrit')).not.toThrow()
    expect(readToken('proj1')).toBeNull()
  })
})

// -- the notes ---------------------------------------------------------------
// A note is a property of a PART and belongs to the project rather than to a
// build: "3.2 mm wall, printer minimum, leave it" is true before a rebuild and
// after one. There is no endpoint for them, so they live here, keyed by part
// name — a name survives a rebuild and an id does not.

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
