// viewport/sizing.js — `throttled`, which holds the canvas resizes a
// ResizeObserver drives to one per RESIZE_MS.
//
// The clock is faked, and only the calls the throttle makes:
// `performance.now()`, `setTimeout` and `clearTimeout`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RESIZE_MS, throttled } from '../src/viewport/sizing.js'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('throttled', () => {
  it('runs the first call at once, and the calls inside the window once, at its end', () => {
    const fn = vi.fn()
    const call = throttled(fn)
    call()
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(30)
    call()
    call()
    vi.advanceTimersByTime(RESIZE_MS - 31)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(RESIZE_MS * 5)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('runs at once a call that comes after a quiet window', () => {
    const fn = vi.fn()
    const call = throttled(fn)
    call()
    vi.advanceTimersByTime(RESIZE_MS)
    call()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('drops the pending run on cancel', () => {
    const fn = vi.fn()
    const call = throttled(fn)
    call()
    call()
    call.cancel()
    vi.advanceTimersByTime(RESIZE_MS * 5)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
