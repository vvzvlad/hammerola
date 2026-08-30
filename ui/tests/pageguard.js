// The autouse cleanliness check for `PAGE`, which is module-level MUTABLE state.
//
// `PAGE` used to be derived once at import and never written again. Switching
// revisions in place (SPEC §8, entry 62) made it a record the page EDITS: the URL
// moves by `history.pushState`, and `rereadPage` writes the new pid/slot/base
// onto the same object, because every module here imported the object itself and
// reads its fields at the moment of use. The mechanism is sound — nothing
// destructures it at module scope — but it is exactly the shape this project
// insists is guarded: a module-level singleton gets a fixture asserting it is
// clean BOTH before and after every test (AGENTS.md; the Python side does the
// same for the `lru_cache`s in src/onboarding.py through tests/conftest.py).
//
// WHAT IS ASSERTED IS NOT "THE ADDRESS IS WHERE IT STARTED", and the correction
// is the point of this paragraph, because the obvious reading of "clean" says it
// is. The file this guards is the file about SWITCHING REVISIONS: most of its
// tests end with `PAGE` on another build, deliberately, because moving it is the
// thing under test. A hook demanding it be back would fail twenty-eight honest
// tests, and the only way to satisfy it would be for each of them to put the
// record back by hand — which is the fixture asking the tests to do its job.
//
// What is asserted instead is the INVARIANT that holds however far the page has
// moved: `PAGE` describes the address the browser is on. That is the production
// rule the whole entry turns on — a swap pushes the URL and re-derives the record
// from the same path, and every module here reads the record rather than the URL
// — so a swap that moves one and not the other is exactly the defect this catches,
// with the test that caused it as the test that fails. It is also self-healing
// about its own reset: a `rereadPage` that stopped restoring leaves `PAGE` behind
// an address that WAS put back, which is the same mismatch one hook later.
//
// AND A STRAY KEY, separately, because that one no reset can undo: `Object.assign`
// adds keys and never removes them, so a field written onto `PAGE` by anything at
// all would sit on the record for the rest of the run. It is taken off by hand and
// reported against the test that added it.
//
// There is no shared setup file for this directory to put this in — `vitest.config.mjs`
// names no `setupFiles`, and that file is the runner's contract rather than a
// test — so this is a module a test file opts into in one line. Any file that
// moves the address is expected to call it.

import { afterEach, beforeEach, expect } from 'vitest'

import { PAGE, rereadPage } from '../src/hub.js'

/**
 * Pin `PAGE` to `pathname` around every test in the calling file.
 *
 * Call it at module scope, after the imports and before the tests. The reset
 * happens before AND after each test and is judged both times; the argument is
 * passed to `rereadPage` explicitly rather than left to `location`, so the RESET
 * still lands in a test that stood `window.location` in for something else.
 */
export function guardPage(pathname) {
  window.history.replaceState(null, '', pathname)
  const clean = { ...rereadPage(pathname) }

  beforeEach(pageCheck(pathname, clean, 'before the test'))
  afterEach(pageCheck(pathname, clean, 'after the test'))
}

/**
 * One hook: read `PAGE` as the test left it, put it back, then judge it.
 *
 * IN THAT ORDER, and the order is what the check used to be missing. The
 * snapshot was taken AFTER the reset, off `rereadPage(pathname)` — whose answer
 * is the record `clean` itself was built from — so it equalled `clean` whatever
 * the test had done, and the hook was a silent reset with an assertion drawn
 * over it. Read first, and there is something to judge.
 *
 * The reset still happens BEFORE the assertions rather than after them, because
 * `expect` throws: a check that failed and left `PAGE` where it lay would fail
 * every test behind it as well, which is the cascade this fixture exists to
 * stop, spelled with the fixture instead of with the code.
 *
 * EXPORTED so the guard can be caught going red (`pageguard.test.js`). Vitest
 * gives a file no way to assert on its own hooks, and a fixture with no proof
 * that it can fail is worth exactly what the silent one was.
 */
export function pageCheck(pathname, clean, when) {
  return () => {
    // Read BEFORE anything is put back: the address the browser is on, and the
    // record the page believes describes it.
    const address = location.pathname
    const found = { ...PAGE }
    // What that address MEANS, computed by the page's own arithmetic rather than
    // by a second copy of it here — `pageFrom` is deliberately the only place
    // the slicing of a pathname is written (src/hub.js).
    const says = { ...rereadPage(address) }

    window.history.replaceState(null, '', pathname)
    rereadPage(pathname)
    // `Object.assign` adds keys and never removes one, so a stray field survives
    // every reset there is and has to be taken off by hand.
    const stray = Object.keys(found).filter((key) => !(key in clean))
    stray.forEach((key) => { delete PAGE[key] })

    expect(stray, `a key that is not part of PAGE was left on it, ${when}`).toEqual([])
    expect(found, `PAGE stopped describing the address the browser is on, ${when}`)
      .toEqual(says)
  }
}
