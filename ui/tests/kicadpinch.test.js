// A two-finger pinch on the KiCad viewer's schematic and board (`MoveAndZoom`
// in ecad-viewer/packages/ecad-viewer-app/src/base/dom/move-and-zoom.ts): the
// view scales by as much as the fingers' distance changed, however fast they
// moved, and the point between the fingers stays under them.

import { describe, expect, it } from 'vitest'

import { MoveAndZoom } from '../../ecad-viewer/packages/ecad-viewer-app/src/base/dom/move-and-zoom.ts'
import { Camera2, Vec2 } from '../../ecad-viewer/packages/ecad-viewer-app/src/base/math/index.ts'

/** A touch event whose fingers stand at `points`, in client pixels. */
const touch = (type, points) => Object.assign(new Event(type, { cancelable: true }), {
  touches: points.map(([clientX, clientY]) => ({ clientX, clientY })),
})

describe('a pinch', () => {
  it('scales the view by the fingers\' distance in one fast move, about the point between them', () => {
    const target = document.createElement('div')
    target.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 300 })
    const camera = new Camera2(new Vec2(400, 300), new Vec2(0, 0), 1)
    const pinch = new MoveAndZoom(target, camera, () => {}, 0.1, 100)
    const between = new Vec2(110, 120)
    const under = camera.screen_to_world(between)

    // 100 px apart, then 300 px apart in one move: a fast spread
    target.dispatchEvent(touch('touchstart', [[70, 140], [170, 140]]))
    target.dispatchEvent(touch('touchmove', [[-30, 140], [270, 140]]))

    expect(camera.zoom).toBeCloseTo(3, 9)
    const now = camera.screen_to_world(between)
    expect([now.x, now.y]).toEqual([expect.closeTo(under.x, 3), expect.closeTo(under.y, 3)])

    // and back to 150 px: half as near
    target.dispatchEvent(touch('touchmove', [[45, 140], [195, 140]]))
    expect(camera.zoom).toBeCloseTo(1.5, 9)

    // fingers held still: the phone keeps sending moves, the view stays
    for (let i = 0; i < 20; i += 1) target.dispatchEvent(touch('touchmove', [[45, 140], [195, 140]]))
    expect(camera.zoom).toBeCloseTo(1.5, 9)
    pinch.dispose()
  })
})
