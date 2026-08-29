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
// BOTH ENDS, and the second one is the whole reason this is not just a
// `beforeEach`. A test that leaves `PAGE` pointing at another revision goes green
// either way; what breaks is whichever test happens to run NEXT, which is where
// somebody then starts debugging. Checked after, the test that moved it is the
// test that fails.
//
// WHAT IS ASSERTED is the record as a whole and not three fields, so a key
// written onto `PAGE` by anything at all is caught: `Object.assign` adds keys and
// never removes them, so a stray one survives every reset there is and would sit
// on the record for the rest of the run.
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
 * happens before AND after each test and is asserted both times; the argument is
 * passed to `rereadPage` explicitly rather than left to `location`, so the check
 * still holds in a test that stood `window.location` in for something else.
 */
export function guardPage(pathname) {
  window.history.replaceState(null, '', pathname)
  const clean = { ...rereadPage(pathname) }

  const restore = (when) => () => {
    window.history.replaceState(null, '', pathname)
    const found = { ...rereadPage(pathname) }
    // The reset is `Object.assign`, which adds keys and never removes one, so a
    // stray field has to be taken off by hand. Otherwise the FIRST leak fails
    // every test after it as well — the very cascade this fixture is here to
    // stop, spelled with the fixture instead of with the code.
    Object.keys(PAGE).forEach((key) => {
      if (!(key in clean)) delete PAGE[key]
    })
    expect(found, `PAGE was not the record this file starts from, ${when}`)
      .toEqual(clean)
  }

  beforeEach(restore('before the test'))
  afterEach(restore('after the test'))
}
