// viewport/live.js — the one question about a swap that only the viewport can
// answer: is the reader's hand on the model right now.
//
// THE ELEMENT IS REALLY UPGRADED HERE, and this is the only file that does it.
// Everywhere else the prototype is used bare, because `connectedCallback` builds
// a three-cad-viewer against a canvas and there is no GPU in a test runner — but
// nothing on the path under test reaches the library: the idle clock is four
// listeners and two fields, and both of those fields are SET IN
// `connectedCallback`, which is exactly where the second half of the defect this
// file covers used to live. A hand-built stand-in would have carried the
// element's initial values as a copy, and a copy agrees with itself.
//
// `ResizeObserver` is the one thing jsdom does not have and the element does
// use. It is stubbed rather than worked around, because what it observes here is
// a box that never resizes.
//
// THE CLOCK IS FAKED, and not for speed. `isBusy` compares against
// `performance.now()`, whose zero is the start of the navigation; under the real
// clock a test asking "is a viewport nobody has touched busy?" would answer
// differently depending on whether the run reached it inside the first IDLE_MS
// of the worker's life. Faked, that reading starts at 0 — which is precisely the
// value the element used to initialise `lastTouch` to, so the question has one
// answer and it is the interesting one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '../src/viewport/index.js'
import { TAG } from '../src/viewport/events.js'
import { IDLE_MS } from '../src/viewport/options.js'

/** A viewport in the document, with the clock at zero. */
function mount() {
  const el = document.createElement(TAG)
  document.body.appendChild(el)
  return el
}

/** A press on the canvas — the box the library's scene lives in. */
const pressCanvas = (el) => el.box.dispatchEvent(new Event('pointerdown'))

/** A release, wherever it happens: the listener for it is on the WINDOW, so
 *  this is the same event whether the reader let go over the model, over the
 *  interface's own chrome, or outside the page entirely. */
const release = (type = 'pointerup') => window.dispatchEvent(new Event(type))

beforeEach(() => {
  // The element reads a remembered pointing device on boot; there is no
  // localStorage in this environment and the read is guarded, so all that
  // reaches the test is the warning it prints.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  vi.useFakeTimers()
})

afterEach(async () => {
  // Every install in `connectedCallback` puts listeners on the WINDOW, so a
  // viewport left in the document would go on answering for the next test's
  // events. `disconnectedCallback` defers its teardown by a microtask — it has
  // to, since a React move is a removal followed by an insertion — so the flush
  // is part of the cleanup rather than an optimisation.
  document.body.innerHTML = ''
  await Promise.resolve()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('isBusy', () => {
  it('is false on a viewport nobody has touched', () => {
    // `lastTouch` starts at -Infinity and not at 0, because it holds a
    // `performance.now()` reading and that clock is zeroed at the START OF THE
    // NAVIGATION: 0 does not mean "long ago", it means "the moment this page
    // opened". At 0 this answer is true for the first IDLE_MS of the page's
    // life, and a build that landed in that window would be held back over a
    // gesture nobody made.
    const el = mount()
    expect(el.isBusy()).toBe(false)
  })

  it('is true while a press that began on the canvas is still down', () => {
    const el = mount()
    vi.advanceTimersByTime(10000)
    pressCanvas(el)
    expect(el.isBusy()).toBe(true)
    // The FLAG, not the clock: a drag can take as long as it likes.
    vi.advanceTimersByTime(IDLE_MS * 10)
    expect(el.isBusy()).toBe(true)
  })

  it('stays true for IDLE_MS after that press is released, and no longer', () => {
    // The moment just after a gesture counts too: a swap re-seats the camera,
    // and doing that on the heels of a release is still the model moving under
    // a hand that has not finished.
    const el = mount()
    vi.advanceTimersByTime(10000)
    pressCanvas(el)
    release()
    expect(el.isBusy()).toBe(true)
    vi.advanceTimersByTime(IDLE_MS - 1)
    expect(el.isBusy()).toBe(true)
    vi.advanceTimersByTime(2)
    expect(el.isBusy()).toBe(false)
  })

  it('is false after a release of a press that began somewhere else', () => {
    // THE DEFECT THIS FILE EXISTS FOR. The release listener is on the window, so
    // it hears every click on the page — and a stamp for one of those made this
    // answer "somebody clicked something recently" rather than "the model is
    // being held". The reader's press on the banner's own Switch button is such
    // a click, and it reaches the window BEFORE React dispatches the click that
    // acts on it, so the swap it asks for found the viewport busy every single
    // time and deferred for the whole of IDLE_MS on a page where nothing had
    // touched the model at all.
    const el = mount()
    vi.advanceTimersByTime(10000)
    release()
    expect(el.isBusy()).toBe(false)
  })

  it('counts a wheel over the canvas, which is a gesture with no press in it', () => {
    const el = mount()
    vi.advanceTimersByTime(10000)
    el.box.dispatchEvent(new Event('wheel'))
    expect(el.isBusy()).toBe(true)
    vi.advanceTimersByTime(IDLE_MS + 1)
    expect(el.isBusy()).toBe(false)
  })

  it('lets any release clear a press whose own release never arrived', () => {
    // A drag let go of over another window, or a tab that lost focus mid-press:
    // the flag is left standing with nobody to clear it, and the interface's
    // deadline (BUSY_WAIT_MS) is what keeps that from stranding a swap for good.
    // The cheaper recovery is the reader's next click ANYWHERE, and the guard
    // added to this listener must not cost it — which is why the guard only
    // skips the case where there is nothing to clear.
    const el = mount()
    pressCanvas(el)
    vi.advanceTimersByTime(IDLE_MS * 10)
    expect(el.isBusy()).toBe(true)

    release()
    vi.advanceTimersByTime(IDLE_MS + 1)
    expect(el.isBusy()).toBe(false)
  })

  it('takes a pointercancel for the release it is', () => {
    const el = mount()
    vi.advanceTimersByTime(10000)
    pressCanvas(el)
    release('pointercancel')
    vi.advanceTimersByTime(IDLE_MS + 1)
    expect(el.isBusy()).toBe(false)
  })
})
