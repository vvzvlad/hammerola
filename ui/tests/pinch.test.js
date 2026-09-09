// ui/src/viewport/pinch.js — what two fingers are allowed to do to the model,
// and how many frames one gesture is allowed to cost.
//
// THE TRACKBALL IS FAKED AND THE FAKE IS TRANSCRIBED, not invented: the fields
// this guard touches are `CADTrackballControls`' own
// (static/_v/three-cad-viewer.esm.js :95037-95039) and `_holroydStart.copy` is
// the same call the library's `_rotateCamera` ends with (:95356) — which is the
// whole reason the guard has to make it by hand. `update(updateMarker, notify =
// true)` is `Viewer.update` (:108919), and that DEFAULT is a fact the coalescing
// rule leans on: an omitted `notify` is the strong value, not a missing one.
//
// The canvas is a REAL element and the container a real div, because the half
// under test here is a capture listener on an ancestor and a `target` check
// against the canvas — neither survives being modelled as a plain object.
//
// rAF IS A QUEUE THIS FILE DRIVES. jsdom has a real one, and a real one turns
// "was the second update coalesced into the first" into a question about
// timers. Stubbed, the frame runs exactly when a test says so, which is also
// what makes the flush-on-release assertion meaningful: the original has to
// have been called BEFORE any frame ran.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installPinchGuard } from '../src/viewport/pinch.js'
import { createOverlay } from '../src/viewport/overlay.js'
import { fakeViewer } from './fakes.js'

/** A `THREE.Vector2` as the trackball holds its holroyd state in one. */
function vector2(x = 0, y = 0) {
  return {
    x, y,
    set(nx, ny) { this.x = nx; this.y = ny; return this },
    copy(v) { this.x = v.x; this.y = v.y; return this },
  }
}

/** The `CADTrackballControls` fields the guard reads and writes, and no more:
 *  anything else a test does not look at is left out, so a guard that starts
 *  reaching for something new fails loudly instead of reading `undefined`. */
function fakeTrackball() {
  return {
    noRotate: false,
    _holroydStart: vector2(),
    _holroydEnd: vector2(),
    _holroydActive: false,
  }
}

/** A viewport with a real container, a real canvas and a library behind them. */
function scene() {
  const box = document.createElement('div')
  document.body.appendChild(box)
  const canvas = document.createElement('canvas')
  box.appendChild(canvas)
  const viewer = fakeViewer()
  // `internals()` reads the canvas off the renderer. The fake's own stand-in is
  // a plain object with a `getBoundingClientRect`, which cannot be an event
  // target — and the target is exactly what the counter filters on.
  viewer.renderer = { domElement: canvas }
  const tb = fakeTrackball()
  // `viewer.controls` is the library's wrapper; the trackball is inside it.
  viewer.controls = { controls: tb }
  return { vp: { viewer, box }, viewer, box, canvas, tb }
}

/** A press. On the canvas unless a test aims it somewhere else, and BUBBLING,
 *  so it reaches the capture listener on the container the way a real one does. */
const press = (el, id = 1) =>
  el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: id, bubbles: true }))

/** A release, wherever it happens: the listener for it is on the WINDOW,
 *  because the trackball captures the pointer and a finger that came down on
 *  the canvas can lift anywhere. */
const release = (id = 1, type = 'pointerup') =>
  window.dispatchEvent(new PointerEvent(type, { pointerId: id }))

let frames = new Map()
let nextFrame = 0
/** Run every frame that has been asked for, once. */
const runFrames = () => {
  const due = [...frames.values()]
  frames.clear()
  for (const callback of due) callback(0)
}

let off = null

beforeEach(() => {
  frames = new Map()
  nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback) => {
    nextFrame += 1
    frames.set(nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id) => { frames.delete(id) })
})

afterEach(() => {
  // The guard's release listeners are on the WINDOW, so a viewport left
  // installed would go on answering for the next test's events.
  if (off) off()
  off = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('two fingers do not rotate', () => {
  it('turns rotation off when the second finger lands', () => {
    const { vp, canvas, tb } = scene()
    off = installPinchGuard(vp)

    press(canvas, 1)
    expect(tb.noRotate).toBe(false)
    press(canvas, 2)
    expect(tb.noRotate).toBe(true)
  })

  it('gives it back when the count falls below two', () => {
    // Below two and not at zero: one finger left on the glass is a rotation
    // again, and the reader who lifted the other one expects to go on turning.
    const { vp, canvas, tb } = scene()
    off = installPinchGuard(vp)

    press(canvas, 1)
    press(canvas, 2)
    release(2)
    expect(tb.noRotate).toBe(false)
    release(1)
    expect(tb.noRotate).toBe(false)
  })

  it('holds it through a third finger and the loss of it', () => {
    const { vp, canvas, tb } = scene()
    off = installPinchGuard(vp)

    press(canvas, 1)
    press(canvas, 2)
    press(canvas, 3)
    expect(tb.noRotate).toBe(true)
    release(3)
    expect(tb.noRotate).toBe(true)
    release(2)
    expect(tb.noRotate).toBe(false)
  })

  it('squares the holroyd start up with its end BEFORE rotation comes back', () => {
    // THE ORDER IS THE FIX. `_holroydStart` is only ever advanced inside
    // `_rotateCamera`, which does not run while `noRotate` is set, so it freezes
    // where the second finger landed while `_holroydEnd` keeps following the
    // finger. Clearing `noRotate` first would let the next frame apply the whole
    // accumulated delta in one jump.
    const { vp, canvas, tb } = scene()
    off = installPinchGuard(vp)

    press(canvas, 1)
    press(canvas, 2)
    // What the library's own pointermove handler does, with rotation off.
    tb._holroydEnd.set(140, 55)

    const rotationWhenCopied = []
    const real = tb._holroydStart.copy
    tb._holroydStart.copy = vi.fn(function copy(v) {
      rotationWhenCopied.push(tb.noRotate)
      return real.call(this, v)
    })

    release(2)
    // Called exactly once, and while the flag was still ours: the copy after
    // the restore would be a frame too late.
    expect(rotationWhenCopied).toEqual([true])
    expect(tb.noRotate).toBe(false)
    expect(tb._holroydStart.x).toBe(140)
    expect(tb._holroydStart.y).toBe(55)
  })

  it('leaves a noRotate somebody else set alone', () => {
    // The library sets this flag itself. A guard that cleared it on the way out
    // of a pinch would switch rotation back on behind somebody's back — and
    // squaring the holroyd state up would be meddling with a gesture that is
    // not ours either.
    const { vp, canvas, tb } = scene()
    tb.noRotate = true
    tb._holroydStart.copy = vi.fn(tb._holroydStart.copy)
    off = installPinchGuard(vp)

    press(canvas, 1)
    press(canvas, 2)
    release(2)
    release(1)

    expect(tb.noRotate).toBe(true)
    expect(tb._holroydStart.copy).not.toHaveBeenCalled()
  })

  it('guards the trackball a scene reload left behind, not the one it replaced', () => {
    // `render()` builds a NEW controls object, and this viewport calls it on
    // every view switch and every live reload. A trackball resolved once at
    // install time would be a guard on an object nobody is turning.
    const { vp, canvas, tb } = scene()
    off = installPinchGuard(vp)

    press(canvas, 1)
    const rebuilt = fakeTrackball()
    vp.viewer.controls = { controls: rebuilt }
    press(canvas, 2)

    expect(rebuilt.noRotate).toBe(true)
    expect(tb.noRotate).toBe(false)

    // And the flag goes back on the object it was set on.
    release(2)
    expect(rebuilt.noRotate).toBe(false)
  })

  it('stays quiet when the controls are not where they were', () => {
    const { vp, canvas, viewer } = scene()
    viewer.controls = {}
    off = installPinchGuard(vp)

    expect(() => { press(canvas, 1); press(canvas, 2); release(2) }).not.toThrow()
  })

  it('counts presses on the canvas and not on the container around it', () => {
    // The library's own DOM lives in the same container, and a press on it is
    // not somebody holding the model.
    const { vp, box, tb } = scene()
    off = installPinchGuard(vp)

    press(box, 1)
    press(box, 2)
    expect(tb.noRotate).toBe(false)
  })

  it('is not let go of by a finger that never pressed the canvas', () => {
    const { vp, canvas, tb } = scene()
    off = installPinchGuard(vp)

    press(canvas, 1)
    press(canvas, 2)
    release(9)
    expect(tb.noRotate).toBe(true)
  })

  it('takes a pointercancel for the release it is', () => {
    const { vp, canvas, tb } = scene()
    off = installPinchGuard(vp)

    press(canvas, 1)
    press(canvas, 2)
    release(2, 'pointercancel')
    expect(tb.noRotate).toBe(false)
  })

  it('gives rotation back when the viewport goes away mid-pinch', () => {
    const { vp, canvas, tb } = scene()
    off = installPinchGuard(vp)

    press(canvas, 1)
    press(canvas, 2)
    off()
    off = null
    expect(tb.noRotate).toBe(false)
  })
})

describe('one frame per gesture, and none outside one', () => {
  it('passes an update straight through when no pointer is down', () => {
    // Outside a gesture NOTHING CHANGES: `update` marks the id-picker dirty and
    // `pickAt` re-renders its buffer only when it is, so a deferred update is a
    // window in which a pick reads the previous camera.
    const { vp, canvas, viewer } = scene()
    const original = viewer.update
    off = installPinchGuard(vp)

    press(canvas, 1)
    release(1)
    // The wrapper really is in place — otherwise this test would be asserting
    // that an unwrapped function calls itself.
    expect(viewer.update).not.toBe(original)

    viewer.update(true, true)
    expect(original).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(0)
  })

  it('coalesces a run of updates into one frame while a pointer is down', () => {
    const { vp, canvas, viewer } = scene()
    const original = viewer.update
    off = installPinchGuard(vp)

    press(canvas, 1)
    viewer.update(true, true)
    viewer.update(true, true)
    viewer.update(true, true)
    expect(original).not.toHaveBeenCalled()
    expect(frames.size).toBe(1)

    runFrames()
    expect(original).toHaveBeenCalledTimes(1)
    expect(original.mock.calls[0]).toEqual([true, true])
  })

  it('keeps the strongest arguments the batch was asked with', () => {
    const { vp, canvas, viewer } = scene()
    const original = viewer.update
    off = installPinchGuard(vp)

    press(canvas, 1)
    viewer.update(false, false)
    viewer.update(true, false)
    runFrames()
    expect(original.mock.calls[0]).toEqual([true, false])
  })

  it('reads an omitted notify as the true the library defaults it to', () => {
    // `update(updateMarker, notify = true)`. An omitted `notify` is the STRONG
    // value, so a later explicit `false` must not win over it — which is what a
    // rule written against the raw `undefined` would have let happen.
    const { vp, canvas, viewer } = scene()
    const original = viewer.update
    off = installPinchGuard(vp)

    press(canvas, 1)
    viewer.update(true)
    viewer.update(false, false)
    runFrames()
    expect(original.mock.calls[0]).toEqual([true, true])
  })

  it('flushes what is pending when the last pointer lifts', () => {
    // The flush is what closes the picking window: a pick happens on the
    // release, and it must not read a buffer marked against the previous camera.
    const { vp, canvas, viewer } = scene()
    const original = viewer.update
    off = installPinchGuard(vp)

    press(canvas, 1)
    viewer.update(true, true)
    expect(original).not.toHaveBeenCalled()

    release(1)
    // Synchronously, BEFORE any frame ran.
    expect(original).toHaveBeenCalledTimes(1)

    // And the frame that was already asked for does not repeat it.
    runFrames()
    expect(original).toHaveBeenCalledTimes(1)
  })

  it('holds the flush until the LAST finger lifts', () => {
    const { vp, canvas, viewer } = scene()
    const original = viewer.update
    off = installPinchGuard(vp)

    press(canvas, 1)
    press(canvas, 2)
    viewer.update(true, true)
    release(2)
    expect(original).not.toHaveBeenCalled()
    release(1)
    expect(original).toHaveBeenCalledTimes(1)
  })

  it('defers nothing for a press that missed the canvas', () => {
    const { vp, box, viewer } = scene()
    const original = viewer.update
    off = installPinchGuard(vp)

    press(box, 1)
    expect(viewer.update).toBe(original)
    viewer.update(true, true)
    expect(original).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(0)
  })

  it('puts the original update back on teardown, and drops what it was holding', () => {
    // Dropped rather than flushed: the element disposes the viewer immediately
    // after the teardown runs, so the deferred frame would repaint a scene on
    // its way out.
    const { vp, canvas, viewer } = scene()
    const original = viewer.update
    off = installPinchGuard(vp)

    press(canvas, 1)
    viewer.update(true, true)
    off()
    off = null

    expect(viewer.update).toBe(original)
    expect(original).not.toHaveBeenCalled()
    runFrames()
    expect(original).not.toHaveBeenCalled()
  })
})

describe('the overlay measures once per frame', () => {
  it('reads each rect once however many pins there are', () => {
    // `place()` used to read the canvas and the container itself, and `draw()`
    // calls it in a loop that WRITES styles — so every iteration invalidated the
    // layout and the next one forced the browser to flush it. One synchronous
    // reflow per pin, inside a rAF loop that runs right through a pinch.
    const { viewer } = scene()
    const canvasRect = vi.spyOn(viewer.canvas, 'getBoundingClientRect')
    const box = { getBoundingClientRect: vi.fn(() => ({ left: 0, top: 0, width: 800, height: 600 })) }
    // The canvas `internals()` hands the overlay is the one the fake measures;
    // this half of the module needs a rect, not an event target.
    viewer.renderer = { domElement: viewer.canvas }
    const vp = { viewer, box, measureLabel: null }

    const overlay = createOverlay(vp)
    // Three pins in front of the camera — behind it they would be hidden, and a
    // hidden pin never reaches the arithmetic that reads a rect.
    overlay.setPins([
      { id: 'a', p: [1, 2, 45] },
      { id: 'b', p: [3, 4, 45] },
      { id: 'c', p: [5, 6, 45] },
    ])
    runFrames()

    expect(canvasRect).toHaveBeenCalledTimes(1)
    expect(box.getBoundingClientRect).toHaveBeenCalledTimes(1)
    // The pins really were placed — otherwise "read once" would be the reading
    // of a loop that did nothing.
    for (const pin of overlay.root.querySelectorAll('.hmr_pin')) {
      expect(pin.style.display).toBe('')
      expect(pin.style.left).not.toBe('')
    }

    overlay.destroy()
  })

  it('measures nothing at all when the library is not there', () => {
    const { viewer } = scene()
    const canvasRect = vi.spyOn(viewer.canvas, 'getBoundingClientRect')
    const box = { getBoundingClientRect: vi.fn() }
    viewer.renderer = { domElement: viewer.canvas }
    const vp = { viewer, box, measureLabel: null }

    const overlay = createOverlay(vp)
    overlay.setPins([{ id: 'a', p: [1, 2, 45] }])
    viewer.ready = false
    runFrames()

    expect(canvasRect).not.toHaveBeenCalled()
    expect(box.getBoundingClientRect).not.toHaveBeenCalled()
    overlay.destroy()
  })
})
