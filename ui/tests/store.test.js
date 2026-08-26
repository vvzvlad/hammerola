// ui/src/store.js — the pointer memory, the one thing this bundle stores that
// somebody else reads.
//
// The other two values in that module (the token, the notes) are read back by
// the interface itself. This one is not: it is read by the RESOLVER page, which
// has a module of its own (`static/_v/pointer_pref.js`) because it must not pull
// this bundle to answer one question and leave. Nothing in JavaScript can check
// that the two spellings of the key agree — the resolver is not in this bundle
// and is not going to be — so `tests/test_pointer_memory.py` compares them as
// text. What is left for this file is the behaviour behind the key: which names
// get recorded, which get refused, and that a browser refusing storage does not
// take the page down with it.
//
// The key is written out below rather than imported, and that is the one place
// here where a literal is the right answer: it is the OBSERVABLE the other half
// depends on. Reusing the module's own expression would give a test that agrees
// with itself whatever it is changed to.
//
// THE STORAGE IS A DOUBLE, and not for isolation: THERE IS NO `localStorage` IN
// THIS RUNNER AT ALL. Node's own global of that name is undefined unless the
// process was started with `--localstorage-file`, and it wins over the one jsdom
// would otherwise put on the window — so `typeof localStorage` is `undefined`
// here, both as a global and as `window.localStorage`. Against the real thing
// these tests would still pass with the whole module gutted, because every
// access in store.js is inside a try/catch that treats an absent storage as
// "nothing was remembered". Installing a double is what makes the assertions
// mean something.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { rememberPointer } from '../src/store.js'

const KEY = 'hammerola.pointer.proj1'

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

describe('rememberPointer', () => {
  beforeEach(() => install(fakeStorage()))

  afterEach(() => {
    vi.restoreAllMocks()
    delete globalThis.localStorage
  })

  it('records either of the two moving names under the project key', () => {
    rememberPointer('proj1', 'dev')
    expect(storage.getItem(KEY)).toBe('dev')
    rememberPointer('proj1', 'latest')
    expect(storage.getItem(KEY)).toBe('latest')
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
    expect(storage.getItem(KEY)).toBe('dev')
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
