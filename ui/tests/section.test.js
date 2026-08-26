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

/** How far a capture/restore may leave the plane from where it was aimed: ONE
 *  placement bias, the sliver the scene it lands in sinks it by, plus a hair for
 *  the arithmetic. One and not two, however different the grids are: the capture
 *  takes its own scene's sliver back out (section.js, `sectionBias`), which is
 *  what stops this budget growing by another on every live reload. */
const budgetIn = (viewer) => bias(viewer) + 1e-9

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
    // Freshly placed, the reader has asked for no depth at all, and that is what
    // this reads: the placement bias is a sliver the renderer needs and not a
    // depth anybody chose, so it is not in here (section.js, `sectionBias`).
    // The library's own slider, meanwhile, is nowhere near zero — which is what
    // the interface would be showing if it read that number instead.
    const { viewer, vp, g } = scene()
    placeSectionPlane(vp, g, [0, 0, -1], [0, 0, 20])
    expect(sectionOffset(vp)).toBeCloseTo(0, 9)
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

  it('reads back a number `applySection` can re-apply without moving the plane', () => {
    // What the end of a drag does (tools.js, `onUp`): the depth is read off the
    // scene and written into `state.cutOffset`, which is the field the next
    // `reconcile` feeds straight back into `applySection`. So the two have to
    // count in the SAME frame — a readout carrying the placement bias would sink
    // the plane one more sliver on every drag-then-reconcile, without limit.
    const { viewer, vp, g } = scene()
    const face = [0, 0, 0]
    placeSectionPlane(vp, g, [1, 0, 0], face)
    const axis = sectionAxis(viewer, g, face)
    dragSection(vp, g, axis, 30, 0)
    const dragged = distance(g, face)

    vp.state.cutOffset = sectionOffset(vp)
    applySection(vp, g)
    expect(distance(g, face)).toBeCloseTo(dragged, 9)
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
    // To the arithmetic and no further: each capture takes its OWN scene's
    // sliver back out, so what is left is the plane itself and the two grids
    // have nothing left to disagree about.
    for (let axis = 0; axis < 3; axis += 1) {
      expect(a.point[axis]).toBeCloseTo(b.point[axis], 9)
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

    expect(Math.abs(distance(after.g, face)))
      .toBeLessThanOrEqual(budgetIn(after.viewer))
    expect(after.vp.sectionSeed.normal).toEqual(keep.normal)
  })

  it('applies neither the reader\'s offset nor the placement bias a second time', () => {
    // THE SEQUENCE PRODUCTION RUNS, and the whole reason this test goes past the
    // restore: what follows a swap on the real page is `reconcile()`, which every
    // `hmr:state` reaches — a click in the tree, a view tab, a pin — and which
    // calls `applySection` with `state.cutOffset` still standing. A seed carrying
    // the offset already would walk the plane those five millimetres a second
    // time on the first of them, and the placement bias rides along on the
    // restore itself, once per live reload.
    //
    // BOTH SCENES ARE THE SAME SIZE on purpose. The bias is a fraction of the
    // grid, so equal grids make every bias in here equal, and then ANY movement
    // at all is drift rather than the sliver a differently-sized scene is
    // allowed to sink its plane by. That is what lets the tolerance be a
    // billionth instead of the budget the two tests above spend: one bias is
    // 0.005 world units on this grid, a million times what is allowed below, so
    // neither defect can hide inside it.
    const before = scene()
    placeSectionPlane(before.vp, before.g, [1, 0, 0], [0, 0, 0])
    before.vp.state.cutOffset = 5
    applySection(before.vp, before.g)
    const keep = captureSection(before.vp)
    const stood = distance(before.g, keep.point)

    const after = scene()
    after.vp.state.cutOffset = 5
    restoreSection(after.vp, keep)
    expect(distance(after.g, keep.point)).toBeCloseTo(stood, 9)
    applySection(after.vp, after.g)          // what `reconcile()` does next
    expect(distance(after.g, keep.point)).toBeCloseTo(stood, 9)
    applySection(after.vp, after.g)          // ...and every reconcile after it
    expect(distance(after.g, keep.point)).toBeCloseTo(stood, 9)

    // ...while the number the interface shows is left exactly as it was.
    expect(after.vp.state.cutOffset).toBe(5)
  })

  it('takes the offset back off along the FLIPPED normal, not the recorded one', () => {
    // The seed is recorded UNFLIPPED (`captureSection`), while the offset was
    // walked along the normal in force — the flipped one. So the subtraction
    // that turns the captured plane back into a seed has to use the flipped one
    // too, and getting the sign wrong is worth exactly twice the offset: the
    // seed lands that far the wrong side of the face, and `applySection` then
    // walks the plane the same distance again from there.
    //
    // BOTH SCENES ARE THE SAME SIZE, for the reason the test above spells out:
    // equal grids make every placement bias equal, so the tolerance can be a
    // billionth — a millionth of the bias itself — and nothing can hide in it.
    const before = scene()
    const face = [0, 0, 0]
    placeSectionPlane(before.vp, before.g, [1, 0, 0], face)
    before.vp.state.cutFlip = true
    before.vp.state.cutOffset = 3
    applySection(before.vp, before.g)
    const keep = captureSection(before.vp)
    const stood = distance(before.g, keep.point)

    const after = scene()
    after.vp.state.cutFlip = true
    after.vp.state.cutOffset = 3
    expect(restoreSection(after.vp, keep)).toBe(true)

    // The seed is the face again, which is what an offset counts FROM...
    for (let axis = 0; axis < 3; axis += 1) {
      expect(after.vp.sectionSeed.point[axis]).toBeCloseTo(face[axis], 9)
    }
    // ...and the plane itself is back where the reader left it.
    expect(distance(after.g, keep.point)).toBeCloseTo(stood, 9)
    // ...and stays there through the reconcile that follows every `hmr:state`.
    applySection(after.vp, after.g)
    expect(distance(after.g, keep.point)).toBeCloseTo(stood, 9)
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
