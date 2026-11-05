// What a wheel event asks of the KiCad viewer's schematic, board and insets
// (`wheel_gesture` in
// ecad-viewer/packages/ecad-viewer-app/src/base/dom/wheel-gesture.ts): a
// touchpad's swipe pans and its pinch zooms, by the numbers of the Gerber
// view's `wheelMove` (ui/src/gerber.js).

import { describe, expect, it } from 'vitest'

import { WHEEL_ZOOM_RATE, wheel_gesture } from '../../ecad-viewer/packages/ecad-viewer-app/src/base/dom/wheel-gesture.ts'
import { wheelMove } from '../src/gerber.js'

const wheel = (init) => new WheelEvent('wheel', init)

describe('wheel_gesture', () => {
  it('pans by a two-finger swipe, a line counted as 16 px and a page as 24', () => {
    expect(wheel_gesture(wheel({ deltaX: 3, deltaY: -7 }))).toEqual({ kind: 'pan', dx: 3, dy: -7 })
    expect(wheel_gesture(wheel({ deltaY: 2, deltaMode: WheelEvent.DOM_DELTA_LINE }))).toEqual({ kind: 'pan', dx: 0, dy: 32 })
    expect(wheel_gesture(wheel({ deltaX: 1, deltaMode: WheelEvent.DOM_DELTA_PAGE }))).toEqual({ kind: 'pan', dx: 24, dy: 0 })
  })

  it('zooms by a pinch, which comes with Control held, as the Gerbers zoom', () => {
    for (const init of [{ deltaY: 12 }, { deltaY: -300 }, { deltaY: 5, deltaMode: WheelEvent.DOM_DELTA_LINE }]) {
      const gesture = wheel_gesture(wheel({ ...init, ctrlKey: true }))
      expect(gesture.kind).toBe('zoom')
      expect(Math.exp(-gesture.by * WHEEL_ZOOM_RATE)).toBeCloseTo(wheelMove({ ...init, ctrlKey: true }).factor, 12)
    }
  })
})
