// The guard on `PAGE`, held to the one thing a guard has to be able to do: go
// red.
//
// IT COULD NOT, AND THAT IS WHY THIS FILE EXISTS. `pageCheck` took its snapshot
// AFTER putting the record back — off `rereadPage(pathname)`, whose answer is the
// very record the expectation compared it against — so the comparison held
// whatever the test had done with `PAGE`. What looked like an autouse assertion
// was an autouse reset with an assertion drawn over it, which is precisely the
// shape this project's convention forbids: the state gets corrected in silence
// and whichever test runs next pays for it.
//
// A FIXTURE WITH NO PROOF THAT IT CAN FAIL IS WORTH WHAT THAT ONE WAS, so the
// body of the hook is exported and driven here directly. Vitest gives a file no
// way to assert on its own `beforeEach`/`afterEach` — a hook that throws fails
// the test rather than handing the failure back — so the hook is built exactly as
// `guardPage` builds it and called as a function.
//
// NOTHING HERE CALLS `guardPage`: this file drives the check by hand, and hooks
// installed on top of it would be a second guard fighting the first over the same
// record.

import { afterEach, describe, expect, it } from 'vitest'

import { PAGE, rereadPage } from '../src/hub.js'
import { pageCheck } from './pageguard.js'

/** Where the imaginary file this stands in for is pinned, and one other build. */
const HOME = '/project/proj1/latest/'
const AWAY = '/project/proj1/dev/'

/** The hook, built the way `guardPage` builds it. */
function guard() {
  window.history.replaceState(null, '', HOME)
  const clean = { ...rereadPage(HOME) }
  return { clean, check: pageCheck(HOME, clean, 'after the test') }
}

// The check puts `PAGE` back on every path, throwing included — but a test that
// fails before reaching it would leave the record moved for the next one, which
// is the failure this whole file is about.
afterEach(() => {
  window.history.replaceState(null, '', HOME)
  rereadPage(HOME)
  Object.keys(PAGE).forEach((key) => {
    if (!['pid', 'slot', 'base'].includes(key)) delete PAGE[key]
  })
})

describe('the PAGE guard', () => {
  it('says nothing about a test that left the record where it found it', () => {
    const { clean, check } = guard()
    expect(() => check()).not.toThrow()
    expect({ ...PAGE }).toEqual(clean)
  })

  it('lets a test that moved the address AND the record through', () => {
    // THE CASE THAT MUST NOT FAIL, and the reason this guard does not simply
    // demand the record be back where it started: the file it protects is the
    // file about switching revisions in place, and most of its tests end on
    // another build on purpose. A hook that called that dirty would be the
    // fixture asking twenty-eight honest tests to put the record back for it.
    const { check } = guard()

    window.history.replaceState(null, '', AWAY)
    rereadPage(AWAY)

    expect(() => check()).not.toThrow()
    // And it is still put back, so the next test starts where this one did.
    expect(PAGE.base).toBe(HOME)
  })

  it('goes red when the record moved and the address did not', () => {
    // Half of the production defect the guard is aimed at, and the half a page
    // cannot show: `PAGE` is what every module fetches through, so a record
    // pointing at a build the URL does not name means meta.json, the view file,
    // the downloads and the comment route all going somewhere the address bar
    // denies — silently, for as long as the page stays open.
    const { check } = guard()

    rereadPage(AWAY)

    expect(() => check()).toThrow(/stopped describing the address/)
    // Put back even though it threw: a check that failed and left the record
    // lying would fail every test behind it too, which is the same cascade from
    // the other side.
    expect(PAGE.base).toBe(HOME)
    expect(location.pathname).toBe(HOME)
  })

  it('goes red when the address moved and the record did not', () => {
    // The other half, and the one the swap actually risks: `switchBuild` pushes
    // the URL and then re-derives `PAGE` from the same path, and a swap that
    // forgot the second line would go on serving the revision that had just left
    // the screen while the address bar said otherwise.
    const { check } = guard()

    window.history.replaceState(null, '', AWAY)

    expect(() => check()).toThrow(/stopped describing the address/)
    expect(PAGE.base).toBe(HOME)
  })

  it('goes red on a key that is not part of the record, and takes it off', () => {
    // The one kind of dirt no reset can undo: `rereadPage` is an `Object.assign`,
    // which adds keys and never removes one, so a stray field would sit on the
    // record for the rest of the run and fail every test after the first.
    const { check } = guard()

    PAGE.cachedTitle = 'a field somebody parked here'

    expect(() => check()).toThrow(/not part of PAGE/)
    expect('cachedTitle' in PAGE, 'the stray key survived the guard').toBe(false)
  })

  it('reports the stray key BEFORE the address, so the cause is named first', () => {
    // A stray key moves nothing, but it is on both snapshots and so cannot show
    // up in the address comparison at all. Named first, the message is about the
    // thing that happened rather than about a mismatch it does not cause.
    const { check } = guard()

    PAGE.cachedTitle = 'x'
    rereadPage(AWAY)

    expect(() => check()).toThrow(/not part of PAGE/)
  })
})
