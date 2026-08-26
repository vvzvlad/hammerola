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

/** A press on the canvas — the box the library's scene lives in. The id is what
 *  the clock keys on, so it is a real `PointerEvent` and not a bare `Event`:
 *  the latter carries no `pointerId` at all, and two of them would look to the
 *  clock like one finger pressed twice. */
const pressCanvas = (el, id = 1) =>
  el.box.dispatchEvent(new PointerEvent('pointerdown', { pointerId: id }))

/** A release, wherever it happens: the listener for it is on the WINDOW, so
 *  this is the same event whether the reader let go over the model, over the
 *  interface's own chrome, or outside the page entirely. The id says WHICH
 *  press it ends — an id nothing pressed the canvas with ends none of them. */
const release = (type = 'pointerup', id = 1) =>
  window.dispatchEvent(new PointerEvent(type, { pointerId: id }))

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
    // The SET, not the clock: a drag can take as long as it likes.
    vi.advanceTimersByTime(IDLE_MS * 10)
    expect(el.isBusy()).toBe(true)
  })

  it('stays held when the first of two fingers lifts', () => {
    // THE DEFECT THE SET EXISTS FOR. A flag has one bit for a hand that has as
    // many fingers as it likes: the first `pointerup` cleared it while the
    // second finger was still on the glass, and the answer fell back on the
    // IDLE_MS window — which `pointermove` does not refresh. A pinch that ran on
    // past that window therefore said "not busy", and the swap it let through
    // re-seated the camera under the fingers still doing it.
    const el = mount()
    vi.advanceTimersByTime(10000)
    pressCanvas(el, 1)
    pressCanvas(el, 2)
    release('pointerup', 1)
    expect(el.isBusy()).toBe(true)
    // Past the idle window, so nothing but the surviving id can be answering.
    vi.advanceTimersByTime(IDLE_MS * 10)
    expect(el.isBusy()).toBe(true)
  })

  it('lets go for IDLE_MS after the LAST of two fingers lifts, and no longer', () => {
    const el = mount()
    vi.advanceTimersByTime(10000)
    pressCanvas(el, 1)
    pressCanvas(el, 2)
    release('pointerup', 1)
    vi.advanceTimersByTime(IDLE_MS * 10)
    release('pointerup', 2)
    expect(el.isBusy()).toBe(true)
    vi.advanceTimersByTime(IDLE_MS - 1)
    expect(el.isBusy()).toBe(true)
    vi.advanceTimersByTime(2)
    expect(el.isBusy()).toBe(false)
  })

  it('is not let go of by a finger that never pressed the canvas', () => {
    // The multitouch half of the guard below: a second finger that came down on
    // the interface rather than the model lifts while ours is still down. Its id
    // was never recorded, so its release ends none of our presses — under the
    // flag it ended all of them.
    const el = mount()
    vi.advanceTimersByTime(10000)
    pressCanvas(el, 1)
    release('pointerup', 2)
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

  it('lets a window blur clear a press whose own release never arrived', () => {
    // A drag let go of over another window, or a tab that lost focus mid-press:
    // the press is left standing with nobody to clear it, and the interface's
    // deadline (BUSY_WAIT_MS) is what keeps that from stranding a swap for good.
    // THE CHEAP RECOVERY USED TO BE ANY RELEASE, because the flag was global,
    // and ids take that away for the case that needed it: a finger gets a fresh
    // id per touch, so nothing on the page ever names the stranded one again.
    // `blur` is the replacement, and it is the only candidate that fires for
    // both cases above — another window taking the focus leaves this page
    // perfectly visible, so `visibilitychange` would say nothing about it.
    const el = mount()
    pressCanvas(el, 3)
    vi.advanceTimersByTime(IDLE_MS * 10)
    expect(el.isBusy()).toBe(true)

    // The route that is gone, asserted as gone rather than left to be assumed.
    release('pointerup', 9)
    expect(el.isBusy()).toBe(true)

    // No idle tail after it: this is the clock admitting it lost a press, not a
    // gesture ending, and the real release may have happened long before.
    window.dispatchEvent(new Event('blur'))
    expect(el.isBusy()).toBe(false)
  })

  it('gives the idle tail back to the gesture a blur cut short', () => {
    // THE OTHER BLUR, and not the one the listener was added for. Above, the
    // press is already over and its release went missing; here the focus leaves
    // while the gesture is STILL RUNNING — alt-tab with a button held, an OS
    // notification, devtools opening. The clear empties the set under a hand
    // that has not let go, `pointermove` refreshes nothing, and the release that
    // finally ends it matches no recorded id — so under the id guard alone it
    // made no stamp either, and a swap arriving on its heels re-seated the
    // camera under fingers still dragging: the very failure the set removed,
    // reached through a focus change instead of a second finger.
    const el = mount()
    vi.advanceTimersByTime(10000)
    pressCanvas(el, 4)
    expect(el.isBusy()).toBe(true)

    window.dispatchEvent(new Event('blur'))
    // The middle of the gesture is still invisible, and that part is not fixed
    // here: the clock cannot tell a drag it has forgotten from no drag at all.
    // The interface's BUSY_WAIT_MS deadline is what covers this window.
    vi.advanceTimersByTime(IDLE_MS * 10)
    expect(el.isBusy()).toBe(false)

    // The release the blur made unpairable — and the tail is back.
    release('pointerup', 4)
    expect(el.isBusy()).toBe(true)
    vi.advanceTimersByTime(IDLE_MS - 1)
    expect(el.isBusy()).toBe(true)
    vi.advanceTimersByTime(2)
    expect(el.isBusy()).toBe(false)
  })

  it('spends that exemption once and then goes back to the id guard', () => {
    // Otherwise the blur would hand back exactly what the ids took away: every
    // click in the interface reads as the model being held, "Switch" included.
    const el = mount()
    vi.advanceTimersByTime(10000)
    pressCanvas(el, 5)
    window.dispatchEvent(new Event('blur'))
    release('pointerup', 5)
    vi.advanceTimersByTime(IDLE_MS * 10)

    release('pointerup', 6)
    expect(el.isBusy()).toBe(false)
  })

  it('is not armed by a blur on a page nobody was touching', () => {
    // A tab sent to the background with no gesture in it arms nothing, so the
    // next click in the interface is still just a click.
    const el = mount()
    vi.advanceTimersByTime(10000)
    window.dispatchEvent(new Event('blur'))
    release()
    expect(el.isBusy()).toBe(false)
  })

  it('is not cleared by a blur INSIDE the page, which only capture hears', () => {
    // Why that listener is the one thing here registered without `capture`.
    // `blur` does not bubble, but it does propagate downwards, so a capturing
    // listener on the window would also hear the element-level blur an ordinary
    // press causes when focus leaves whatever had it — and would clear the press
    // at the start of the very gesture the clock is there to protect.
    const el = mount()
    pressCanvas(el)
    vi.advanceTimersByTime(IDLE_MS * 10)
    el.box.dispatchEvent(new Event('blur'))
    expect(el.isBusy()).toBe(true)
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
