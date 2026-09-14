// ui/src/viewport/handle.js — the grip on the section plane.
//
// There is no GPU here and nothing below looks at a pixel, which is the same
// discipline the rest of this suite keeps. What IS assertable is everything that
// decides whether the reader can see and use the handle at all: WHERE it is put
// (a projection, in px, of a world point the module works out from the seed),
// WHICH WAY it points (the screen axis of the clip normal, and vertical in the
// degenerate zone the paragraph below is about),
// WHEN it refuses to be drawn — three cases, three different reasons — and what
// one whole drag does to the plane and says at the end of it.
//
// The zone where the plane's normal points nearly AT or AWAY FROM the camera —
// the reader turned to look straight at the cut face — is NOT one of those
// cases any more: the grip stands there as a vertical arrow, on
// `sectionGripAxis`'s fallback, and has its own group below.
//
// The angles are checked against arithmetic that does not come from the module:
// this fake camera puts 20 px on a world unit along both screen axes (400 px per
// 20 halfW across, 300 px per 15 halfH up), so a normal along the camera's own
// `right` reads 0 degrees, one along its `up` reads -90 (screen y grows
// downwards and so does a CSS rotation), and an oblique basis reads the angle it
// was tilted by.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `dragSection` is the one call this module makes into the section that a test
// can only see the ARGUMENTS of — the deltas are the whole claim, and the world
// distance they produce is section.js's own suite's business. It is spied on
// while still doing its real work, so the plane really moves and the readback at
// the release is a real one; everything else in the module stays untouched.
vi.mock('../src/viewport/section.js', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, dragSection: vi.fn((...args) => real.dragSection(...args)) }
})

import { EVENT_FACE } from '../src/viewport/events.js'
import { createHandle } from '../src/viewport/handle.js'
import { internals } from '../src/viewport/internals.js'
import {
  applySection, dragSection, placeSectionPlane, sectionAxis, sectionGripAxis,
  sectionOffset,
} from '../src/viewport/section.js'
import { fakeViewer, fakeViewport, orthoCamera } from './fakes.js'

const RECT = { left: 0, top: 0, width: 800, height: 600 }

// -- the rAF loop, driven by hand ---------------------------------------------
// Same shape as pinch.test.js: the module's loop re-arms itself from inside the
// frame it is running, so a snapshot is taken before the callbacks run and what
// they queue lands in the next one.
let frames = new Map()
let nextFrame = 0
const runFrames = () => {
  const due = [...frames.values()]
  frames.clear()
  for (const callback of due) callback(0)
}

const handles = []

beforeEach(() => {
  vi.clearAllMocks()
  frames = new Map()
  nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback) => {
    nextFrame += 1
    frames.set(nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id) => frames.delete(id))
})

afterEach(() => {
  // Before the next test dispatches on the window: a handle left standing would
  // leave a dead viewport's capture-phase listeners there to answer for it.
  while (handles.length) handles.pop().destroy()
  vi.unstubAllGlobals()
})

/**
 * A viewport with a cut on it, and the handle installed over it.
 *
 * `box` is the container the placement is measured against — jsdom computes no
 * layout, so it is the same rect as the canvas and the two cancel, which is
 * exactly what they do on the page.
 */
function scene({ normal = [1, 0, 0], point = [0, 0, 45], camera } = {}) {
  const viewer = fakeViewer({ camera: camera || orthoCamera(), rect: RECT })
  const vp = fakeViewport(viewer, { cut: true })
  vp.box = { getBoundingClientRect: () => ({ ...RECT }) }
  vp.dispatchEvent = vi.fn()
  const g = internals(viewer)
  expect(placeSectionPlane(vp, g, normal, point)).toBe(true)
  vp.sectionSeed.id = '/Group/wall'
  vp.sectionSeed.name = 'wall'
  const handle = createHandle(vp)
  handles.push(handle)
  handle.refresh()
  return { viewer, vp, g, handle, arrow: handle.root.firstElementChild }
}

/** Wake the loop and let one frame of it run. */
const drawn = (handle) => {
  handle.refresh()
  runFrames()
}

const shown = (arrow) => arrow.style.display !== 'none'

/** The rotation the module wrote, in degrees. */
const angleOf = (arrow) => {
  const match = /rotate\((-?[\d.e-]+)deg\)/.exec(arrow.style.transform)
  expect(match, `no rotation in ${arrow.style.transform}`).toBeTruthy()
  return Number(match[1])
}

/** A press on the arrow itself, with both refusals watched. */
function grab(arrow, [clientX, clientY]) {
  const event = new MouseEvent('pointerdown', {
    clientX, clientY, bubbles: true, cancelable: true,
  })
  vi.spyOn(event, 'stopPropagation')
  vi.spyOn(event, 'preventDefault')
  arrow.dispatchEvent(event)
  return event
}

/** The rest of the gesture. It goes to the WINDOW, which is where the press put
 *  the listeners — a drag that starts on the arrow can end anywhere. */
const pointerMove = ([clientX, clientY]) =>
  window.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY }))
const pointerUp = ([clientX, clientY]) =>
  window.dispatchEvent(new MouseEvent('pointerup', { clientX, clientY }))
const pointerCancel = () =>
  window.dispatchEvent(new MouseEvent('pointercancel', {}))

/** What was carried by every event of one name, in the order they went out. */
const details = (vp, type) => vp.dispatchEvent.mock.calls
  .map(([event]) => event)
  .filter((event) => event.type === type)
  .map((event) => event.detail)

describe('when there is nothing to grab', () => {
  it('draws nothing while the cut is switched off', () => {
    // The cut is a THING THAT IS ON, and turning it off parks the plane where it
    // cuts nothing while keeping the seed. A grip on a plane that is not cutting
    // would offer a gesture with no visible effect.
    const { vp, handle, arrow } = scene()
    drawn(handle)
    expect(shown(arrow), 'the premise: it is on screen with a cut standing').toBe(true)

    vp.state = { ...vp.state, cut: false }
    drawn(handle)
    expect(shown(arrow)).toBe(false)
  })

  it('draws nothing when no plane was ever placed', () => {
    const { vp, handle, arrow } = scene()
    drawn(handle)
    expect(shown(arrow)).toBe(true)

    vp.sectionSeed = null
    drawn(handle)
    expect(shown(arrow)).toBe(false)
  })

  it('draws nothing when the anchor is behind the reader', () => {
    // Under an ortho projection the frustum has a back and the model turns
    // through it, which is the same case the overlay's pins answer with `ndc[2]
    // > 1`. The camera sits at z = 60 and its far plane a depth of 30 beyond the
    // anchor, so a seed at z = 20 is behind it.
    const { vp, g, handle, arrow } = scene({ point: [0, 0, 20] })
    expect(sectionGripAxis(vp.viewer, g, [0, 0, 20]),
           'the premise: the axis is fine, so only the depth can be hiding it')
      .not.toBeNull()

    drawn(handle)
    expect(shown(arrow)).toBe(false)
  })

  it('draws nothing when the scene cannot be measured at all', () => {
    // The case behind `if (!axis)` that this suite can stage, now that the
    // degenerate view is served rather than refused. `place` names three of
    // them — no clip plane, no eye, a canvas of no size — and this is the one
    // a fake viewer can produce: a clip plane the library cannot hand back is
    // not a plane this can be drawn on at any angle. Both halves of the module
    // have to agree about it — `place` takes the arrow off, and `onDown` takes
    // no gesture — or a press would land on an arrow the next frame removes.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { vp, g, handle, arrow } = scene()
    drawn(handle)
    expect(shown(arrow), 'the premise: it is on screen first').toBe(true)

    vp.viewer.getClipNormal = () => { throw new Error('plane gone') }
    expect(sectionGripAxis(vp.viewer, g, [0, 0, 45]),
           'the premise: this is a scene the axis cannot answer for').toBeNull()

    // A press before the next frame: the arrow is still on screen, and the
    // gesture still has to refuse.
    grab(arrow, [100, 100])
    pointerMove([140, 100])
    expect(dragSection).not.toHaveBeenCalled()

    drawn(handle)
    expect(shown(arrow)).toBe(false)
  })
})

describe('when the reader looks straight at the cut face', () => {
  // The degenerate zone: the plane's normal points nearly AT the camera, its
  // projection on the screen is a stub, and `sectionAxis` declines. The handle
  // used to go with it — the arrow vanished exactly where the cut is squarely in
  // view, and just outside the zone it swung to an unpredictable angle. It now
  // stands on the vertical fallback instead.
  //
  // The seed's own normal is +Z and the camera looks down -Z from z = 60, so
  // `placeSectionPlane` turns it towards the reader and the plane ends up facing
  // the camera head-on.
  const facing = () => scene({ normal: [0, 0, 1] })

  it('keeps the arrow on screen where `sectionAxis` declines', () => {
    const { vp, g, handle, arrow } = facing()
    expect(sectionAxis(vp.viewer, g, [0, 0, 45]),
           'the premise: this is the zone sectionAxis declines').toBeNull()

    drawn(handle)
    expect(shown(arrow)).toBe(true)
    // Still over the point the plane meets the face, which is the middle of the
    // canvas for a seed on the view axis.
    expect(arrow.style.left).toBe('400px')
    expect(arrow.style.top).toBe('300px')
  })

  it('draws it vertical, which is the one angle that does not swing', () => {
    // `{sx: 0, sy: +px}` is 90 degrees, and CSS turns the way screen y runs — so
    // the arrow points DOWN the screen, which is the direction that pushes the
    // plane along its own normal.
    const { handle, arrow } = facing()
    drawn(handle)
    expect(angleOf(arrow)).toBeCloseTo(90, 9)
  })

  it('drags on the arrow it drew: down moves the plane, across does not', () => {
    // `onDown` has to measure with the same function `place` draws from,
    // otherwise the press lands on a visible grip and does nothing at all. The
    // fake camera puts 20 px on a world unit (tests/fakes.js, and the header
    // above), so 40 px down is 2 world units along the normal.
    const { vp, handle, arrow } = facing()
    drawn(handle)

    grab(arrow, [100, 100])
    pointerMove([100, 140])
    expect(dragSection).toHaveBeenCalledTimes(1)
    const axis = dragSection.mock.calls[0][2]
    expect(axis.sx).toBe(0)
    expect(axis.sy).toBeCloseTo(20, 9)
    expect(axis.s2).toBeCloseTo(400, 9)
    // POSITIVE, i.e. down the screen pushes the plane along its own normal —
    // the convention `sectionGripAxis` fixes, since there is no projection left
    // to take it from.
    expect(sectionOffset(vp)).toBeCloseTo(2, 9)

    // Across the arrow is across the gesture: the least-squares projection of a
    // purely horizontal delta onto a vertical axis is zero.
    pointerMove([300, 140])
    expect(sectionOffset(vp)).toBeCloseTo(2, 9)

    pointerUp([300, 140])
    expect(details(vp, EVENT_FACE)).toHaveLength(1)
    expect(vp.state.cutOffset).toBeCloseTo(sectionOffset(vp), 9)
  })
})

describe('where it is drawn', () => {
  it('sits over the point the plane meets the face, in canvas pixels', () => {
    // The seed is on the view axis, so it projects to the middle of an 800x600
    // canvas.
    const { handle, arrow } = scene()
    drawn(handle)

    expect(shown(arrow)).toBe(true)
    expect(arrow.style.left).toBe('400px')
    expect(arrow.style.top).toBe('300px')
    // Centred on the anchor, because the plane moves BOTH ways from there.
    expect(arrow.style.transform.startsWith('translate(-50%,-50%)')).toBe(true)
  })

  it('walks with the offset, along the SEED normal', () => {
    // `state.cutOffset` is where the plane stands, counted from the face — so
    // the grip is on the plane rather than on the face it was placed from. Four
    // world units along +X, at 20 px each, is 80 px right of the centre.
    const { vp, g, handle, arrow } = scene()
    vp.state.cutOffset = 4
    applySection(vp, g)                       // what `reconcile` does first
    drawn(handle)

    expect(arrow.style.left).toBe('480px')
    expect(arrow.style.top).toBe('300px')
  })
})

describe('which way it points', () => {
  it('lies along the screen axis of the clip normal', () => {
    // The camera looks down -Z with +X to the right, so a plane whose normal is
    // +X slides straight across the screen.
    const { handle, arrow } = scene()
    drawn(handle)
    expect(angleOf(arrow)).toBe(0)
  })

  it('turns with it — up the screen is -90, because CSS turns the other way', () => {
    const { handle, arrow } = scene({ normal: [0, 1, 0] })
    drawn(handle)
    expect(angleOf(arrow)).toBeCloseTo(-90, 9)
  })

  it('takes the angle from `sectionAxis` and not from the normal itself', () => {
    // A camera basis rolled by 30 degrees. The world +X the plane's normal
    // points along is unchanged; what moves is the screen it is seen on, and
    // only `sectionAxis` knows about that. Both yardsticks are here: the angle
    // the camera was rolled by, worked out from its basis (the two screen axes
    // are both 20 px per world unit here, so the tilt is not distorted), and the
    // module's one call into the section.
    const roll = Math.PI / 6
    const camera = orthoCamera({
      right: [Math.cos(roll), Math.sin(roll), 0],
      up: [-Math.sin(roll), Math.cos(roll), 0],
      forward: [0, 0, -1],
    })
    const { vp, g, handle, arrow } = scene({ camera })
    drawn(handle)

    expect(angleOf(arrow)).toBeCloseTo(30, 6)
    const axis = sectionAxis(vp.viewer, g, [0, 0, 45])
    expect(angleOf(arrow))
      .toBeCloseTo((Math.atan2(axis.sy, axis.sx) * 180) / Math.PI, 9)
  })
})

describe('one whole drag', () => {
  it('moves the plane by the delta since the PREVIOUS event, and says so once', () => {
    const { vp, handle, arrow } = scene()
    drawn(handle)

    const press = grab(arrow, [100, 100])
    // The press is kept off the canvas — belt and braces beside tools.js's own
    // `event.target !== g.canvas` — and the compatibility mouse events with it.
    expect(press.stopPropagation).toHaveBeenCalled()
    expect(press.preventDefault).toHaveBeenCalled()

    pointerMove([140, 100])
    pointerMove([150, 130])

    expect(dragSection).toHaveBeenCalledTimes(2)
    expect(dragSection.mock.calls[0].slice(3)).toEqual([40, 0])
    expect(dragSection.mock.calls[1].slice(3)).toEqual([10, 30])
    // ONE axis for the whole gesture: the camera cannot move under a press this
    // one owns, and re-measuring per frame would let the plane drift.
    expect(dragSection.mock.calls[0][2]).toBe(dragSection.mock.calls[1][2])
    // Nothing is announced while the drag runs — the interface would re-render
    // on every frame of it.
    expect(details(vp, EVENT_FACE)).toEqual([])
    expect(vp.state.cutOffset).toBe(0)

    pointerUp([150, 130])

    // Once, at the end, through the same `reportCut` the canvas drag ends in —
    // so `state.cutOffset` and the number the interface prints have one writer.
    const faces = details(vp, EVENT_FACE)
    expect(faces).toHaveLength(1)
    expect(faces[0].id).toBe('/Group/wall')
    expect(faces[0].offset).toBe(vp.state.cutOffset)
    expect(vp.state.cutOffset).toBeCloseTo(sectionOffset(vp), 9)
    expect(Math.abs(vp.state.cutOffset)).toBeGreaterThan(0.5)

    // And the gesture really ended: the window listeners went with it, so a
    // pointer that moves on past the release moves no plane.
    pointerMove([300, 130])
    expect(dragSection).toHaveBeenCalledTimes(2)
  })

  it('ignores every button but the primary one', () => {
    // The right button is a gesture of its own here — it opens the part menu,
    // and the library pans on it. A grab on the arrow would take both, and the
    // native context menu would come up over a plane that had just moved: the
    // `contextmenu` handler that suppresses it sits on `vp.box`, and this layer
    // is a sibling of that element, not a child.
    const { vp, handle, arrow } = scene()
    drawn(handle)

    const press = new MouseEvent('pointerdown', {
      button: 2, clientX: 100, clientY: 100, bubbles: true, cancelable: true,
    })
    vi.spyOn(press, 'preventDefault')
    arrow.dispatchEvent(press)
    // Not even the refusals: a press this one does not want is a press it has
    // no business taking away from anybody else.
    expect(press.preventDefault).not.toHaveBeenCalled()

    pointerMove([140, 100])
    expect(dragSection).not.toHaveBeenCalled()
    expect(details(vp, EVENT_FACE)).toEqual([])
  })

  it('says nothing when the press never moved', () => {
    // `reportCut` emits `hmr:face`, and the interface answers that by disarming
    // whatever tool is up — so a bare click on the arrow would silently put down
    // the measure or comment tool the reader was holding. The canvas drag has
    // always guarded this with `p.moved`; this is the same rule.
    const { vp, handle, arrow } = scene()
    drawn(handle)

    grab(arrow, [100, 100])
    pointerUp([100, 100])

    expect(details(vp, EVENT_FACE)).toEqual([])
    expect(dragSection).not.toHaveBeenCalled()
  })

  it('concludes a drag the scene is being pulled out from under', () => {
    // The twin of `vp.endGesture`, and the reason it is a second call rather
    // than the same one: the press landed on a sibling of `vp.box`, so neither
    // that gesture nor the idle clock that defers the swap ever saw it. Ending
    // it CONCLUDES rather than abandons — `restoreSection` subtracts
    // `state.cutOffset` from the captured point, so a stale one would put the
    // seed off the face that was clicked.
    const { vp, handle, arrow } = scene()
    drawn(handle)

    grab(arrow, [100, 100])
    pointerMove([140, 100])
    expect(vp.state.cutOffset).toBe(0)

    handle.endDrag()

    const faces = details(vp, EVENT_FACE)
    expect(faces).toHaveLength(1)
    expect(vp.state.cutOffset).toBeCloseTo(sectionOffset(vp), 9)
    expect(Math.abs(vp.state.cutOffset)).toBeGreaterThan(0)

    // And it really ended, so the release that never came cannot report twice.
    pointerMove([200, 100])
    pointerUp([200, 100])
    expect(details(vp, EVENT_FACE)).toHaveLength(1)
  })

  it('lets go on a cancelled pointer, and says nothing about it', () => {
    // A capture-phase listener left on the window is the silent failure here:
    // the gesture would go on moving the plane from a pointer the browser has
    // already taken away — a touch turned into a scroll, a window that lost
    // focus mid-drag. Nothing is announced, because a cancelled gesture is not
    // a placement the reader made.
    const { vp, handle, arrow } = scene()
    drawn(handle)

    grab(arrow, [100, 100])
    pointerMove([140, 100])
    expect(dragSection).toHaveBeenCalledTimes(1)

    pointerCancel()
    expect(details(vp, EVENT_FACE)).toEqual([])

    pointerMove([200, 100])
    expect(dragSection).toHaveBeenCalledTimes(1)
  })

  it('stays under the hand while the drag runs, before anything is reported', () => {
    // The whole of what makes this a grip rather than a picture. The anchor
    // reads the PLANE every frame, so the arrow travels with it; an anchor
    // taken from `state.cutOffset` would stand still for the whole gesture and
    // jump at the release, because `reportCut` is the only writer of that field
    // and it runs on the way up.
    const { vp, handle, arrow } = scene()
    drawn(handle)
    expect(arrow.style.left).toBe('400px')

    grab(arrow, [100, 100])
    pointerMove([140, 100])
    drawn(handle)

    // The field a naive anchor would read is still exactly zero at this point,
    // which is what makes the assertion below say something.
    expect(vp.state.cutOffset).toBe(0)
    const moved = sectionOffset(vp)
    // POSITIVE, i.e. the plane followed the hand: the normal is +X and the drag
    // went +40 px, which is to the right on this camera. Without the sign this
    // would still pass with a plane running away from the cursor.
    expect(moved).toBeGreaterThan(0)
    // 20 px per world unit along the camera's `right`, as the header says, and
    // the seed projects to the middle of the canvas.
    expect(parseFloat(arrow.style.left)).toBeCloseTo(400 + moved * 20, 6)
  })
})
