// ui/src/longpress.js — a finger held still turns into the `contextmenu` a
// right click would send, because iOS never sends one for a long press.
//
// The browser's own long press (Android) is not covered: it arrives as a
// trusted event, and a test can only dispatch untrusted ones.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HOLD_MS, HOLD_PX, installLongPress, markMenu } from '../src/longpress.js'

let el = null
let teardown = null
let menus = []

beforeEach(() => {
  vi.useFakeTimers()
  el = document.createElement('div')
  document.body.appendChild(el)
  menus = []
  el.addEventListener('contextmenu', (e) => menus.push([e.clientX, e.clientY]))
  teardown = installLongPress(window)
})

afterEach(() => {
  teardown()
  el.remove()
  vi.useRealTimers()
})

/** A pointer event on the row, bubbling to the window as the browser's do. */
function pointer(type, { x = 50, y = 60, kind = 'touch', id = 1, primary = true } = {}) {
  el.dispatchEvent(new PointerEvent(type, {
    pointerId: id, pointerType: kind, isPrimary: primary, clientX: x, clientY: y, bubbles: true,
  }))
}

/** The release's `touchend`; whether it came back cancelled. */
function touchEnd() {
  const event = new Event('touchend', { bubbles: true, cancelable: true })
  el.dispatchEvent(event)
  return event.defaultPrevented
}

describe('a finger held still', () => {
  it('asks for the menu at the point it pressed, once the time is up', () => {
    pointer('pointerdown')
    vi.advanceTimersByTime(HOLD_MS - 1)
    expect(menus).toEqual([])
    vi.advanceTimersByTime(1)
    expect(menus).toEqual([[50, 60]])
  })

  it('still counts as held inside HOLD_PX, and as a drag past it', () => {
    pointer('pointerdown')
    pointer('pointermove', { x: 50 + HOLD_PX })
    vi.advanceTimersByTime(HOLD_MS)
    expect(menus).toHaveLength(1)

    pointer('pointerdown')
    pointer('pointermove', { x: 50 + HOLD_PX + 1 })
    vi.advanceTimersByTime(HOLD_MS)
    expect(menus).toHaveLength(1)
  })

  it('asks for nothing on a tap, a mouse, or a second finger', () => {
    pointer('pointerdown')
    pointer('pointerup')
    pointer('pointerdown', { kind: 'mouse' })
    vi.advanceTimersByTime(HOLD_MS)
    // A pinch: the second finger ends the first one's timing.
    pointer('pointerdown')
    pointer('pointerdown', { id: 2, primary: false })
    vi.advanceTimersByTime(HOLD_MS)
    expect(menus).toEqual([])
  })
})

describe('the click of the release', () => {
  it('is eaten when a menu opened, and the next tap\'s is not', () => {
    // The page's root closes every menu on a click, and iOS sends one when
    // the long-pressing finger lifts.
    el.addEventListener('contextmenu', (e) => markMenu(e))
    pointer('pointerdown')
    vi.advanceTimersByTime(HOLD_MS)
    pointer('pointerup')
    expect(touchEnd()).toBe(true)

    pointer('pointerdown')
    pointer('pointerup')
    expect(touchEnd()).toBe(false)
  })

  it('is left alone where no menu opened, even if the event was cancelled', () => {
    // The KiCad viewer cancels every `contextmenu` and selects on the click.
    el.addEventListener('contextmenu', (e) => e.preventDefault())
    pointer('pointerdown')
    vi.advanceTimersByTime(HOLD_MS)
    pointer('pointerup')
    expect(touchEnd()).toBe(false)
  })
})
