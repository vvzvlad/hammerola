// ui/src/viewport/section.js — the cutting plane, and the frame of reference
// its slider counts in.
//
// The one fact everything here rests on, read off the library rather than
// guessed at: `distanceToPoint` is affine in the slider value with slope exactly
// 1, and the ZERO of that slider is the centre of the clipping region — the
// grid — not the model origin. So the same number names a different physical
// plane on a model that was republished a fraction wider, and that is the whole
// reason `captureSection` stores a normal and a point instead.
//
// The fake plane models `CenteredPlane.setConstant` (see tests/fakes.js), so
// every assertion below is about where the plane ENDS UP in the world, not about
// which arithmetic produced the number.
//
// Not tested here: whether the face the reader clicked is the face the plane
// lands on (that is the picker and a GPU), and whether the cap quad z-fights
// (that is a renderer). The depth bias that exists to stop the second one is
// checked as a distance, since that much is arithmetic.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { internals } from '../src/viewport/internals.js'
import { vec3 } from '../src/viewport/math.js'
import { MIN_SINE, SECTION_BIAS, SECTION_INDEX } from '../src/viewport/options.js'
import {
  applySection, captureSection, dragSection, keepSectionCut, placeSectionPlane,
  restoreSection, sectionAxis, sectionLimit, sectionOffset, sectionRange,
  slideSectionTo, suspendSectionCut,
} from '../src/viewport/section.js'
import { fakeViewer, fakeViewport, orthoCamera } from './fakes.js'

const RECT = { left: 0, top: 0, width: 800, height: 600 }

function scene({ gridSize = 100, clipCenter = [0, 0, 0] } = {}) {
  const camera = orthoCamera({
    eye: [0, 0, 80], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1],
  })
  const viewer = fakeViewer({ camera, gridSize, clipCenter, rect: RECT })
  const vp = fakeViewport(viewer)
  return { camera, viewer, vp, g: internals(viewer) }
}

/** How far the plane in force is from a world point, signed along its normal. */
const distance = (g, point) => g.plane.distanceToPoint(vec3(point))

/** The sliver the placement deliberately sinks the plane by, in world units. */
const bias = (viewer) => sectionLimit(viewer) * SECTION_BIAS

/** How far apart two scenes' answers may be: one placement bias each, and a
 *  hair for the arithmetic. The bias is a fraction of the GRID, so two scenes
 *  with different grids sink their planes by different amounts — that is the
 *  only difference a capture/restore is allowed to introduce. */
const budgetBetween = (a, b) => bias(a) + bias(b) + 1e-9

/** A direction, compared component by component.
 *
 *  Not `toEqual`: a normal that came back through an arithmetic negation carries
 *  `-0` where the literal has `0`, and those two are the same direction by every
 *  measure except the strict equality a deep compare uses.
 */
const expectDirection = (actual, expected) => {
  for (let axis = 0; axis < 3; axis += 1) {
    expect(actual[axis]).toBeCloseTo(expected[axis], 12)
  }
}

describe('sectionLimit and sectionRange', () => {
  it('are half the grid, which is the travel the library gives its sliders', () => {
    const { viewer } = scene({ gridSize: 90 })
    expect(sectionLimit(viewer)).toBe(45)
    expect(sectionRange(viewer)).toEqual([-45, 45])
  })

  it('are null when the scene has no grid to count against yet', () => {
    const { viewer } = scene()
    viewer.gridSize = 0
    expect(sectionLimit(viewer)).toBeNull()
    expect(sectionRange(viewer)).toBeNull()
  })
})

describe('slideSectionTo', () => {
  let ctx
  beforeEach(() => { ctx = scene() })

  it('puts the plane THROUGH the point, from wherever the slider happens to be', () => {
    // The claim in the module: from ANY current value `v`, the value that puts
    // the plane through P is `v - distanceToPoint(P)`. Checked by asking the
    // plane afterwards, from three different starting values.
    const { viewer, g } = ctx
    const point = [7, -3, 2]
    for (const start of [sectionLimit(viewer), 0, -12.5]) {
      viewer.setClipSlider(SECTION_INDEX, start, true)
      slideSectionTo(viewer, g, point, 0)
      expect(distance(g, point)).toBeCloseTo(0, 9)
    }
  })

  it('holds the plane `back` further along its own normal', () => {
    const { viewer, g } = ctx
    const point = [0, 0, 5]
    slideSectionTo(viewer, g, point, 3)
    // A larger slider value holds the plane further back, so subtracting the
    // bias sinks the plane INTO the part by exactly that much.
    expect(distance(g, point)).toBeCloseTo(-3, 9)
  })

  it('clamps to the travel the grid allows', () => {
    const { viewer, g } = ctx
    const value = slideSectionTo(viewer, g, [0, 0, 1e6], 0)
    expect(value).toBe(-sectionLimit(viewer))
    expect(viewer.getClipSlider(SECTION_INDEX)).toBe(-sectionLimit(viewer))
  })

  it('writes nothing when the slider is unreadable', () => {
    const { viewer, g } = ctx
    viewer.getClipSlider = () => NaN
    expect(slideSectionTo(viewer, g, [0, 0, 0], 0)).toBeNull()
    expect(viewer.setClipSlider).not.toHaveBeenCalled()
  })
})

describe('placeSectionPlane', () => {
  let ctx
  beforeEach(() => { ctx = scene() })

  it('turns the normal AWAY from the camera, so the cut opens the near side', () => {
    // The camera sits at +Z looking down -Z. A face normal pointing back at it
    // would keep the near half and hide what the reader is trying to see.
    const { vp, g } = ctx
    expect(placeSectionPlane(vp, g, [0, 0, 1], [0, 0, 0])).toBe(true)
    expectDirection(vp.sectionSeed.normal, [0, 0, -1])
  })

  it('leaves a normal that already points away alone', () => {
    const { vp, g } = ctx
    placeSectionPlane(vp, g, [0, 0, -1], [0, 0, 0])
    expectDirection(vp.sectionSeed.normal, [0, 0, -1])
  })

  it('lands the plane on the face, sunk by the depth bias and no further', () => {
    const { viewer, vp, g } = ctx
    const face = [1, 2, 3]
    placeSectionPlane(vp, g, [0, 0, 1], face)
    expect(distance(g, face)).toBeCloseTo(-bias(viewer), 9)
  })

  it('opens the library tab the cut lives on and turns clipping on', () => {
    const { viewer, vp, g } = ctx
    placeSectionPlane(vp, g, [0, 0, 1], [0, 0, 0])
    expect(viewer.setActiveTab).toHaveBeenCalledWith('clip')
    expect(viewer.setLocalClipping).toHaveBeenCalledWith(true)
    expect(viewer.clipping.setVisible).toHaveBeenCalledWith(true)
  })

  it('refuses a point the camera has no direction to', () => {
    const { camera, vp, g } = ctx
    expect(placeSectionPlane(vp, g, [0, 0, 1], [...camera.eye])).toBe(false)
    expect(vp.sectionSeed).toBeNull()
  })
})

describe('applySection', () => {
  let ctx
  beforeEach(() => { ctx = scene() })

  it('walks the plane along the normal by the interface offset', () => {
    const { viewer, vp, g } = ctx
    const face = [0, 0, 0]
    placeSectionPlane(vp, g, [0, 0, -1], face)
    vp.state.cutOffset = 4
    applySection(vp, g)
    // The plane has moved 4 further along its own normal, so the face it was
    // laid on is now that far behind it — plus the bias, as always.
    expect(distance(g, face)).toBeCloseTo(-(4 + bias(viewer)), 9)
  })

  it('keeps "deeper" meaning deeper after a flip', () => {
    // The offset walks the plane along the normal it is being flipped WITH, so
    // the same slider still opens the part up rather than reversing under the
    // reader. Same distance, opposite normal.
    const { viewer, vp, g } = ctx
    const face = [0, 0, 0]
    placeSectionPlane(vp, g, [0, 0, -1], face)
    vp.state.cutOffset = 4
    vp.state.cutFlip = true
    applySection(vp, g)
    expectDirection(g.plane.normal, [0, 0, 1])
    expect(distance(g, face)).toBeCloseTo(-(4 + bias(viewer)), 9)
  })

  it('does nothing without a seed: an untouched plane cuts nothing', () => {
    const { vp, g } = ctx
    expect(applySection(vp, g)).toBe(false)
  })
})

describe('sectionAxis', () => {
  let ctx
  beforeEach(() => { ctx = scene() })

  it('measures screen pixels per world unit along the clip normal', () => {
    const { camera, viewer, g } = ctx
    viewer.setClipNormal(SECTION_INDEX, [1, 0, 0], null, true)
    const axis = sectionAxis(viewer, g, [0, 0, 0])
    // The camera's own numbers: half the frustum spans half the canvas.
    const expected = (camera.zoom * RECT.width) / (2 * camera.halfW)
    expect(axis.sx).toBeCloseTo(expected, 9)
    expect(axis.sy).toBeCloseTo(0, 9)
  })

  it('is null when the normal points nearly straight at the camera', () => {
    // Its screen projection collapses there and px -> world runs away, so a
    // two-pixel twitch would fling the plane through the model.
    const { viewer, g } = ctx
    const shallow = Math.asin(MIN_SINE * 0.9)
    viewer.setClipNormal(SECTION_INDEX,
                         [Math.sin(shallow), 0, Math.cos(shallow)], null, true)
    expect(sectionAxis(viewer, g, [0, 0, 0])).toBeNull()
  })

  it('answers just past that guard', () => {
    const { viewer, g } = ctx
    const open = Math.asin(MIN_SINE * 1.1)
    viewer.setClipNormal(SECTION_INDEX,
                         [Math.sin(open), 0, Math.cos(open)], null, true)
    expect(sectionAxis(viewer, g, [0, 0, 0])).not.toBeNull()
  })
})

describe('dragSection', () => {
  let ctx
  let axis
  const face = [0, 0, 0]

  beforeEach(() => {
    ctx = scene()
    ctx.viewer.setClipNormal(SECTION_INDEX, [1, 0, 0], null, true)
    axis = sectionAxis(ctx.viewer, ctx.g, face)
  })

  it('moves the plane along its normal by the distance it reports', () => {
    const { vp, g } = ctx
    const before = distance(g, face)
    const travelled = dragSection(vp, g, axis, 40, 0)
    expect(travelled).toBeGreaterThan(0)
    expect(before - distance(g, face)).toBeCloseTo(travelled, 9)
  })

  it('ignores a drag ACROSS the normal, which is a drag that means nothing', () => {
    const { vp, g } = ctx
    const before = distance(g, face)
    expect(dragSection(vp, g, axis, 0, 120)).toBe(0)
    expect(distance(g, face)).toBe(before)
  })

  it('saturates, so one flick cannot send the plane through the model', () => {
    const { vp, g } = ctx
    const far = dragSection(vp, g, axis, 1e6, 0)
    const further = dragSection(vp, g, axis, 1e9, 0)
    expect(far).toBe(further)
    expect(Math.abs(far)).toBeLessThan(sectionLimit(ctx.viewer))
  })
})

describe('sectionOffset', () => {
  it('reports the distance from the FACE, not the slider from the grid centre', () => {
    // Freshly placed, the plane is the bias away from the face and nowhere near
    // zero on the library's own slider — which is what the interface would show
    // if it read that number instead.
    const { viewer, vp, g } = scene()
    placeSectionPlane(vp, g, [0, 0, -1], [0, 0, 20])
    expect(sectionOffset(vp)).toBeCloseTo(bias(viewer), 9)
    // The slider is a wholly different number: it counts from the centre of the
    // grid, and the face is 20 away from it.
    expect(Math.abs(viewer.getClipSlider(SECTION_INDEX))).toBeGreaterThan(1)
  })

  it('follows a drag, one world unit per world unit', () => {
    const { viewer, vp, g } = scene()
    placeSectionPlane(vp, g, [1, 0, 0], [0, 0, 0])
    const axis = sectionAxis(viewer, g, [0, 0, 0])
    const before = sectionOffset(vp)
    const travelled = dragSection(vp, g, axis, 30, 0)
    expect(sectionOffset(vp) - before).toBeCloseTo(travelled, 9)
  })
})

describe('suspendSectionCut and keepSectionCut', () => {
  it('parks the slider where the library parks it, and leaves the normal', () => {
    const { viewer, vp, g } = scene()
    placeSectionPlane(vp, g, [1, 0, 0], [0, 0, 0])
    const normal = viewer.getClipNormal(SECTION_INDEX)

    suspendSectionCut(vp)

    expect(viewer.getClipSlider(SECTION_INDEX)).toBe(sectionLimit(viewer))
    expect(viewer.getClipNormal(SECTION_INDEX)).toEqual(normal)
    expect(viewer.setLocalClipping).toHaveBeenLastCalledWith(false)
    expect(viewer.clipping.setVisible).toHaveBeenLastCalledWith(false)
  })

  it('puts the cut back only while one exists', () => {
    const { viewer, vp } = scene()
    keepSectionCut(vp)
    expect(viewer.setLocalClipping).not.toHaveBeenCalled()

    vp.sectionSeed = { normal: [1, 0, 0], point: [0, 0, 0], value: null }
    keepSectionCut(vp)
    expect(viewer.setLocalClipping).toHaveBeenCalledWith(true)
  })
})

describe('captureSection', () => {
  it('stores the plane itself — a normal and a point — and no slider value', () => {
    const { viewer, vp, g } = scene()
    placeSectionPlane(vp, g, [1, 0, 0], [2, 0, 0])
    const keep = captureSection(vp)

    expect(Object.keys(keep).sort()).toEqual(['normal', 'placed', 'point'])
    // Nothing in it is the number the library is holding: that number means
    // "so far from the centre of THIS grid" and does not survive a republish.
    const slider = viewer.getClipSlider(SECTION_INDEX)
    expect(keep.point).not.toContain(slider)
    expect(keep.normal).not.toContain(slider)
  })

  it('records the seed UNFLIPPED, so a restore does not flip it a second time', () => {
    const { vp, g } = scene()
    placeSectionPlane(vp, g, [1, 0, 0], [0, 0, 0])
    vp.state.cutFlip = true
    applySection(vp, g)

    const keep = captureSection(vp)
    expect(keep.normal).toEqual(vp.sectionSeed.normal)
  })

  it('is null when the plane is parked at the far edge and cuts nothing', () => {
    const { vp } = scene()
    expect(captureSection(vp)).toBeNull()
  })

  it('names the SAME world plane from two scenes whose grids differ', () => {
    // The heart of it. Two builds of one model, republished half a millimetre
    // wider: the grid grows, its centre moves, and the slider value that names
    // this plane changes with it. What comes out of `captureSection` must not.
    const face = [4, -1, 0]
    const small = scene({ gridSize: 100, clipCenter: [0, 0, 0] })
    const large = scene({ gridSize: 130, clipCenter: [3, -2, 1] })

    placeSectionPlane(small.vp, small.g, [1, 0, 0], face)
    placeSectionPlane(large.vp, large.g, [1, 0, 0], face)

    const a = captureSection(small.vp)
    const b = captureSection(large.vp)

    expect(a.normal).toEqual(b.normal)
    const budget = budgetBetween(small.viewer, large.viewer)
    for (let axis = 0; axis < 3; axis += 1) {
      expect(Math.abs(a.point[axis] - b.point[axis])).toBeLessThanOrEqual(budget)
    }
    // ...while the library's own number for it is a different number entirely.
    expect(small.viewer.getClipSlider(SECTION_INDEX))
      .not.toBe(large.viewer.getClipSlider(SECTION_INDEX))
  })
})

describe('captureSection -> restoreSection', () => {
  it('puts the plane back on the same world plane after a live reload', () => {
    const before = scene({ gridSize: 100, clipCenter: [0, 0, 0] })
    const face = [6, 2, -1]
    placeSectionPlane(before.vp, before.g, [1, 0, 0], face)
    const keep = captureSection(before.vp)

    // The scene the swap builds: same model, republished a little larger, so
    // the grid and its centre are both different numbers.
    const after = scene({ gridSize: 130, clipCenter: [3, -2, 1] })
    expect(restoreSection(after.vp, keep)).toBe(true)

    const budget = budgetBetween(before.viewer, after.viewer)
    expect(Math.abs(distance(after.g, face))).toBeLessThanOrEqual(budget)
    expect(after.vp.sectionSeed.normal).toEqual(keep.normal)
  })

  it('does not apply the reader\'s offset a second time', () => {
    // The captured point is where the plane REALLY was, offset included, so the
    // seed goes back with an offset of zero relative to it — and the state's
    // own `cutOffset` is left exactly as it was for the interface to keep
    // showing.
    const before = scene()
    placeSectionPlane(before.vp, before.g, [1, 0, 0], [0, 0, 0])
    before.vp.state.cutOffset = 5
    applySection(before.vp, before.g)
    const keep = captureSection(before.vp)
    const where = keep.point

    const after = scene()
    after.vp.state.cutOffset = 5
    restoreSection(after.vp, keep)

    expect(after.vp.state.cutOffset).toBe(5)
    expect(Math.abs(distance(after.g, where)))
      .toBeLessThanOrEqual(budgetBetween(before.viewer, after.viewer))
  })

  it('forgets the seed again when the cut was not one the reader placed', () => {
    const before = scene()
    before.vp.viewer.setClipSlider(SECTION_INDEX, 3, true)
    const keep = captureSection(before.vp)
    expect(keep.placed).toBe(false)

    const after = scene()
    restoreSection(after.vp, keep)
    expect(after.vp.sectionSeed).toBeNull()
  })

  it('never throws out of a swap, whatever the library does', () => {
    // A swap that throws takes the live update down with it: a lost plane is a
    // drag to put back, a lost live page is a reload nobody knows they need.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { vp } = scene()
    vp.viewer.setClipNormal = () => { throw new Error('gone') }
    expect(() => restoreSection(vp, { normal: [1, 0, 0], point: [0, 0, 0], placed: true }))
      .not.toThrow()
    expect(restoreSection(vp, null)).toBe(false)
    vi.restoreAllMocks()
  })
})
