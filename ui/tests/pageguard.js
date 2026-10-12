// The autouse cleanliness check for `PAGE`, which is module-level MUTABLE state.
//
// Switching revisions in place makes `PAGE` a record the page EDITS: the URL
// moves by `history.pushState`, and `rereadPage` writes the new pid/slot/base
// onto the same object, because every module here imports the object itself and
// reads its fields at the moment of use (nothing destructures it at module
// scope). A module-level singleton gets a fixture asserting it is clean BOTH
// before and after every test (AGENTS.md; the Python side does the same for the
// `lru_cache`s in src/onboarding.py through tests/conftest.py).
//
// WHAT IS ASSERTED IS NOT "THE ADDRESS IS WHERE IT STARTED". The file this
// guards is about SWITCHING REVISIONS: most of its tests end with `PAGE` on
// another build, deliberately, and a hook demanding it be back would make each
// of them put the record back by hand.
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
 * The browser's own `location`, captured before any test can stand something in
 * for it.
 *
 * THE CHECK READS AN ADDRESS, and reading it off `window.location` would read it
 * out of whatever the test under judgement had put there. That is not a
 * hypothetical: `watchNavigation` in revswitch.test.js replaces the whole object
 * to catch a write to `href`, which jsdom refuses to perform and refuses to
 * report. It happens to be safe, because that stand-in delegates `pathname` to
 * the real one — but the safety is the stand-in's courtesy rather than this
 * fixture's, and the next one written to catch something else need not extend
 * it. A stub with no `pathname` getter would make this hook read `undefined`,
 * fail every test in the file behind the one that installed it, and say `PAGE
 * stopped describing the address the browser is on` — pointing at the wrong
 * thing, which is the cascade this file exists to stop.
 *
 * So the descriptor is taken at import, which is module scope of a module every
 * such file imports at the top, and read through for the rest of the run. The
 * fallback covers a DOM where `location` is not an own accessor at all; there
 * the promise is only as good as it was.
 */
const BROWSER = Object.getOwnPropertyDescriptor(window, 'location');
const browserPath = () => (BROWSER && BROWSER.get
  ? BROWSER.get.call(window).pathname
  : window.location.pathname)

/**
 * Pin `PAGE` to `pathname` around every test in the calling file.
 *
 * Call it at module scope, after the imports and before the tests. The reset
 * happens before AND after each test and is judged both times; the argument is
 * passed to `rereadPage` explicitly rather than left to `location`, so the RESET
 * still lands in a test that stood `window.location` in for something else. The
 * READ is held to the same standard by `browserPath` above.
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
 * IN THAT ORDER: a snapshot taken after the reset, off `rereadPage(pathname)`,
 * would equal `clean` whatever the test had done. Read first, and there is
 * something to judge.
 *
 * The reset still happens BEFORE the assertions rather than after them, because
 * `expect` throws: a check that failed and left `PAGE` where it lay would fail
 * every test behind it as well, which is the cascade this fixture exists to
 * stop, spelled with the fixture instead of with the code.
 *
 * EXPORTED so the guard can be caught going red (`pageguard.test.js`): Vitest
 * gives a file no way to assert on its own hooks.
 */
export function pageCheck(pathname, clean, when) {
  return () => {
    // Read BEFORE anything is put back: the address the browser is on, and the
    // record the page believes describes it. Through the real accessor rather
    // than through `location`, which the test being judged may have replaced.
    const address = browserPath()
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
