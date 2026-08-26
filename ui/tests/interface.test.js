// HammerolaViewer — the one decision in it that is a state machine rather than a
// layout: WHEN a new build is allowed to replace the one on screen.
//
// NOTHING IS RENDERED HERE, and nothing needs to be. The instance below is the
// real prototype with the handful of fields `takePending` touches, the same
// arrangement element.test.js uses on the custom element and for the same
// reason: what is under test is a sequence of decisions over time, and putting a
// React tree and a WebGL viewport underneath it would test neither better. The
// rest of this component is layout, and layout is checked from Python against
// its source (tests/test_ui_source.py) — this file is not a foothold for
// creeping into it.
//
// The clock is faked because the behaviour IS about the clock: a swap defers
// while the reader's hand is on the model, and gives up deferring after a
// deadline. Both halves are unobservable at real speed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import HammerolaViewer from '../src/HammerolaViewer.jsx'

/** A build the banner is offering — meta.json as the poll would have read it. */
const NEXT = {
  commit: 'abc1234def',
  variants: [{ id: 'assembled', file: 'assembled.json', parts: 3, gzip: 1000 }],
}

/**
 * The component as `takePending` sees it.
 *
 * `setState` is the real one's contract and not React's: merge, then run the
 * callback — which is where the swap actually tells the viewport, through
 * `sync()`.
 */
function component({ busy = false, answer = null } = {}) {
  const c = Object.create(HammerolaViewer.prototype)
  c.busy = busy
  c.host = {
    current: {
      isBusy: vi.fn(() => {
        if (answer) return answer()
        return c.busy
      }),
    },
  }
  c.state = {
    meta: { commit: 'oldbuild', variants: NEXT.variants },
    pending: null, view: 'assembled', bannerGone: false,
  }
  c.setState = vi.fn((patch, done) => {
    const next = typeof patch === 'function' ? patch(c.state) : patch
    c.state = { ...c.state, ...next }
    if (done) done()
  })
  c.sync = vi.fn()
  c.toast = vi.fn()
  return c
}

const offering = (extra) => {
  const c = component(extra)
  c.state = { ...c.state, pending: NEXT }
  return c
}

/** Did the build on screen actually change? */
const swapped = (c) => c.state.meta === NEXT && c.state.pending === null

describe('takePending', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('swaps at once when the viewport is not in the reader\'s hands', () => {
    const c = offering()
    c.takePending()
    expect(swapped(c)).toBe(true)
    // The swap is nothing but the new numbers going down the one event: a
    // changed `buildKey` under the same `view` is what the viewport reads as a
    // live reload.
    expect(c.sync).toHaveBeenCalledTimes(1)
  })

  it('waits while a gesture is in progress, and leaves the offer standing', () => {
    // A swap re-renders the scene and re-seats the camera. Between a press and
    // its release that is the model being pulled out from under the pointer,
    // which is the one thing `isBusy()` exists to tell this side about.
    const c = offering({ busy: true })
    c.takePending()
    expect(c.state.meta.commit).toBe('oldbuild')
    // Still on offer, so the banner keeps standing and nothing is lost if this
    // page is closed or the reader presses Later instead.
    expect(c.state.pending).toBe(NEXT)
    expect(c.sync).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    expect(swapped(c)).toBe(false)

    c.busy = false
    vi.advanceTimersByTime(1000)
    expect(swapped(c)).toBe(true)
  })

  it('goes ahead after its deadline, so a lost pointerup cannot strand it', () => {
    // `pointerHeld` is cleared by a `pointerup` on the window, and there is no
    // guarantee this page ever sees one: a release over another window, a tab
    // that lost focus mid-drag. The reader pressed Switch, and a button that
    // quietly does nothing for ever is the worse of the two failures.
    const c = offering({ busy: true })
    c.takePending()
    vi.advanceTimersByTime(60000)
    expect(swapped(c)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps one wait at a time, however often Switch is pressed', () => {
    // Two timers racing would swap once, then call `setState` again on a
    // `pending` that is already gone.
    const c = offering({ busy: true })
    c.takePending()
    c.takePending()
    c.takePending()
    expect(vi.getTimerCount()).toBe(1)

    c.busy = false
    vi.advanceTimersByTime(1000)
    expect(c.setState).toHaveBeenCalledTimes(1)
  })

  it('does not defer to a viewport that cannot answer', () => {
    // No adapter on the page, or an element that threw: neither is a reason to
    // refuse the reader the build they asked for.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = offering({ answer: () => { throw new Error('gone') } })
    c.takePending()
    expect(swapped(c)).toBe(true)

    const bare = offering()
    bare.host = { current: null }
    bare.takePending()
    expect(swapped(bare)).toBe(true)
  })

  it('does nothing at all once the page is gone', () => {
    // The wait outlives a single call, so the timer can come back on a component
    // that has been unmounted — `componentWillUnmount` clears it, and this is
    // the second net under that one.
    const c = offering({ busy: true })
    c.takePending()
    c._gone = true
    c.busy = false
    vi.advanceTimersByTime(60000)
    expect(c.setState).not.toHaveBeenCalled()
  })

  it('keeps the reader\'s view when the new build still has it', () => {
    const c = offering()
    c.takePending()
    expect(c.state.view).toBe('assembled')
  })

  it('falls back to the first view when it does not', () => {
    const c = offering()
    c.state = { ...c.state, view: 'printables' }
    c.takePending()
    expect(c.state.view).toBe('assembled')
  })
})
