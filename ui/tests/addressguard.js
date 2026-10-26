// The autouse cleanliness check for the subscribers of address.js, which are
// module-level MUTABLE state: a component that follows Back and Forward
// subscribes on mount and unsubscribes on unmount, and one a test leaves
// subscribed would be handed every later test's `popstate`. A module-level
// registry gets a check BOTH before and after every test (AGENTS.md), as
// `PAGE` gets one in pageguard.js; a file that mounts such a component opts in
// with one call at module scope.
//
// AFTER MEANS AFTER THE TEST'S OWN `onTestFinished`: the files that mount one
// unmount it there, and Vitest runs those after `afterEach`. So the after-check
// is an `onTestFinished` itself, registered from `beforeEach` ahead of any the
// test registers; Vitest runs them last-registered first, so it runs last.

import { beforeEach, expect } from 'vitest'

import { subscribers, unsubscribe } from '../src/address.js'

/** Hold the calling file's tests to leaving no subscriber behind, judged
 *  before each test and after everything the test registered to run after it. */
export function guardSubscribers() {
  beforeEach(({ onTestFinished }) => {
    subscriberCheck('before the test')()
    onTestFinished(subscriberCheck('after the test'))
  })
}

/** One check: the subscribers left are read, taken off, then judged — taken off
 *  first, so that one test's leak fails that test and not every test behind it. */
function subscriberCheck(when) {
  return () => {
    const left = subscribers()
    left.forEach(unsubscribe)
    expect(left, `a subscriber of address.js was left subscribed, ${when}`).toEqual([])
  }
}
