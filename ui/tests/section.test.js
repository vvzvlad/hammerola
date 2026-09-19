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
  restoreSection, sectionAxis, sectionGripAxis, sectionLimit, sectionOffset,
  sectionRange, sectionValueFor, suspendSectionCut,
} from '../src/viewport/section.js'
import { RECT } from './component.js'
import { fakeViewer, fakeViewport, orthoCamera } from './fakes.js'

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

describe('sectionValueFor', () => {
  let ctx
  beforeEach(() => { ctx = scene() })

  it('names the value that stands a plane with that normal through that point', () => {
    // The claim in the module: `value = -normal . (point - centre)`, and it
    // needs nothing from the plane that is standing — not its normal, not its
    // constant, not the slider. Checked by asking the plane afterwards, from
    // three different starting values and with a normal the plane does not
    // currently carry.
    const { viewer, g } = ctx
    const point = [7, -3, 2]
    const normal = [0, 1, 0]
    for (const start of [sectionLimit(viewer), 0, -12.5]) {
      viewer.setClipSlider(SECTION_INDEX, start, true)
      const value = sectionValueFor(viewer, g, normal, point)
      viewer.setClipNormal(SECTION_INDEX, normal, value, true)
      expect(distance(g, point)).toBeCloseTo(0, 9)
    }
  })

  it('writes NOTHING, whatever it is asked', () => {
    // The whole reason it is a function of its own: `applySection` has to know
    // the answer before it touches the viewer, so nothing here may touch it.
    const { viewer, g } = ctx
    sectionValueFor(viewer, g, [0, 1, 0], [7, -3, 2])
    expect(viewer.setClipSlider).not.toHaveBeenCalled()
    expect(viewer.setClipNormal).not.toHaveBeenCalled()
  })

  it('clamps to the travel the grid allows', () => {
    const { viewer, g } = ctx
    expect(sectionValueFor(viewer, g, [0, 0, 1], [0, 0, 1e6]))
      .toBe(-sectionLimit(viewer))
  })

  it('is null when the centre the slider counts from is not there', () => {
    // `CenteredPlane.center` is one property deeper than the plane `internals()`
    // guards, so a library that moved it has to cost the placement and nothing
    // else — never a wrong answer.
    const { viewer, g } = ctx
    g.plane.center = undefined
    expect(sectionValueFor(viewer, g, [0, 0, 1], [0, 0, 0])).toBeNull()
  })

  it('is null for a normal or a point that is not a measurement', () => {
    // The other two of its three predicates, and NEITHER IS REDUNDANT with the
    // `Number.isFinite` at the end — that is the whole reason this test exists.
    // An infinite operand makes the dot product infinite, and `sectionValue`
    // CLAMPS: infinity becomes a tidy `±sectionLimit`, a number that is finite,
    // plausible and about nothing. The plane would stand at the edge of the grid
    // as though somebody had asked for it.
    const { viewer, g } = ctx
    for (const bad of [[Infinity, 0, 0], [NaN, 0, 0], null, [0, 1]]) {
      expect(sectionValueFor(viewer, g, bad, [1, 2, 3])).toBeNull()
      expect(sectionValueFor(viewer, g, [0, 0, 1], bad)).toBeNull()
    }
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

  it('turns the plane over on a flip and does not move it', () => {
    // THIS TEST REPLACES ONE CALLED "keeps 'deeper' meaning deeper after a
    // flip", and the old one is named here so nobody restores it as a
    // regression. It asserted that a flip left the plane the same DISTANCE from
    // the seed face with the opposite normal — i.e. that the offset walked along
    // the flipped normal, so that pushing the slider always went on cutting
    // deeper. The intent reads well and the geometry does not survive it: the
    // only way to hold "deeper" fixed while the kept side turns over is to move
    // the plane, and both changes then point the same way. The plane walks out
    // through the face it was laid on while the kept half becomes the outside of
    // the part, so a flip drew an empty canvas at EVERY offset — verified in a
    // browser, and the whole of the flip button's bug.
    //
    // What a flip means instead is Fusion's: the plane stands exactly where it
    // stood and the other side is kept. The reader's slider then still moves the
    // plane in one fixed world direction, which is the half of "deeper stays
    // deeper" that was worth keeping.
    const { viewer, vp, g } = ctx
    const face = [0, 0, 0]
    placeSectionPlane(vp, g, [0, 0, -1], face)
    vp.state.cutOffset = 4
    applySection(vp, g)
    // A world point ON the plane before the flip, so "the same plane" can be
    // asserted without depending on which way the normal points.
    const on = [0, 0, -(4 + bias(viewer))]
    expect(distance(g, on)).toBeCloseTo(0, 9)

    vp.state.cutFlip = true
    applySection(vp, g)
    expectDirection(g.plane.normal, [0, 0, 1])
    expect(distance(g, on)).toBeCloseTo(0, 9)
  })

  it('leaves the plane exactly as it was when the placement cannot be worked out', () => {
    // A HALF-APPLIED PASS IS THE FAILURE THIS SHAPE EXISTS TO PREVENT. The
    // normal used to go in first and unconditionally — with a null value, so the
    // library parked the slider at the far edge — and the correction below it
    // could return false, leaving the plane turned over AND cutting nothing,
    // which is a state nobody ever asked for and which erases the model.
    // Nothing is written now until every number is known.
    const { viewer, vp, g } = ctx
    placeSectionPlane(vp, g, [1, 0, 0], [0, 0, 0])
    const normal = viewer.getClipNormal(SECTION_INDEX)
    const slider = viewer.getClipSlider(SECTION_INDEX)

    g.plane.center = undefined          // the one reading the value depends on
    vp.state.cutFlip = true
    expect(applySection(vp, g)).toBe(false)

    expect(viewer.getClipNormal(SECTION_INDEX)).toEqual(normal)
    expect(viewer.getClipSlider(SECTION_INDEX)).toBe(slider)
  })

  it('does not hand the library the one value it silently refuses', () => {
    // `Viewer.setClipSlider` returns early on exactly -1, so a placement that
    // works out to that number would set the normal and leave the slider parked
    // — the same erased model, reached from the other side. The seed is placed
    // by hand because the number has to be hit exactly.
    const { viewer, vp, g } = scene({ gridSize: 100, clipCenter: [0, 0, 0] })
    const at = [1, 0, 0]
    vp.sectionSeed = { normal: [1, 0, 0], point: [1 - bias(viewer), 0, 0], value: null }
    expect(applySection(vp, g)).toBe(true)
    expect(viewer.getClipSlider(SECTION_INDEX)).not.toBe(-1)
    expect(distance(g, at)).toBeCloseTo(0, 6)
  })

  it('does nothing without a seed: an untouched plane cuts nothing', () => {
    const { vp, g } = ctx
    expect(applySection(vp, g)).toBe(false)
  })
})

describe('the seed is where the unit normal is guaranteed', () => {
  // EVERYTHING DOWNSTREAM ASSUMES A UNIT NORMAL — `sectionValueFor` measures a
  // distance with a dot product, and `applySection` walks the same vector to
  // build the point it measures to — so a normal of length 2 is wrong twice, in
  // different proportions, and the plane lands somewhere nobody chose. It is
  // guaranteed at the two functions that WRITE `vp.sectionSeed`, which is the
  // only door a normal enters the module by.
  //
  // Written as tests rather than as a sentence in a docstring because the
  // producer on the placing side is `faceNormalAt` in picking.js, and that file
  // has no tests at all: "it already returns a unit vector" was a fact about
  // code nothing checks, and the cost of it ceasing to be true is a cut standing
  // metres from the face with nothing anywhere reporting it.

  it('normalises what `placeSectionPlane` is handed', () => {
    const { viewer, vp, g } = scene()
    const face = [0, 0, 20]
    // The same face and the same direction, at twice the length.
    expect(placeSectionPlane(vp, g, [0, 0, -2], face)).toBe(true)
    expect(vp.sectionSeed.normal).toEqual([0, 0, -1])
    // The plane stands one render sliver into the part and nowhere else. With
    // the length carried through it stands 4.98 world units off this face —
    // measured, and a thousand times the tolerance below.
    expect(distance(g, face)).toBeCloseTo(-bias(viewer), 9)
    expect(sectionOffset(vp)).toBeCloseTo(0, 9)
  })

  it('the library leaves a zero normal AT ZERO, which is why the failure is silent', () => {
    // THE PREMISE THE NEXT TEST REASONS FROM, and the one thing `fakes.js` has
    // to get right for it to mean anything: three.js's `normalize()` is
    // `divideScalar( this.length() || 1 )`, so a zero-length normal is LEFT
    // ALONE rather than turned into NaNs. The difference decides which symptom
    // the suite is entitled to assert — NaN would be loud, while zero is a plane
    // that separates nothing and quietly never cuts.
    //
    // Held here because nothing else holds it: with `unit3` correct, no zero
    // normal reaches the library any more, so the fake's fidelity on this point
    // has no other witness and "simplifying" the `|| 1` away would pass unnoticed
    // a second time.
    const { viewer, g } = scene()
    viewer.setClipNormal(SECTION_INDEX, [0, 0, 0], 0.5, true)
    expect(viewer.getClipNormal(SECTION_INDEX)).toEqual([0, 0, 0])
    // ...and a plane with no direction is the same distance from everywhere,
    // which is the arithmetic behind "nothing is discarded".
    expect(distance(g, [0, 0, 0])).toBe(0.5)
    expect(distance(g, [0, 0, 40])).toBe(0.5)
  })

  it('normalises one too large to square, rather than refusing it', () => {
    // `len3` squares first, so it overflows at a component around 1.34e154 and
    // `unit3` used to divide by that Infinity — returning [0,0,0], a FINITE
    // vector of zero length that `finite3` waves through.
    //
    // WHAT THAT DOES IS SILENT, which is what makes it worth a test. The library
    // does not blow up on a zero normal: `Vector3.normalize` is
    // `divideScalar( length() || 1 )`, so zero stays zero, and the clip plane
    // becomes `(0, 0, 0, w)`. Every point is then the SAME distance from it —
    // the plane separates nothing — and the fragment test `dot(vClipPosition,
    // plane.xyz) > plane.w` reads `0 > w`, false, so nothing is discarded: the
    // model stands there whole and the cut just never happens.
    //
    // So the assertion below is that the plane SEPARATES the two sides of the
    // face, which is the property a cut is. Asserting the normal is finite would
    // not do it — a zero normal is perfectly finite — and asserting it is not
    // NaN would be asserting something the library cannot produce at all.
    //
    // The mirror case underflowed to zero and was refused outright; it is here
    // for the same reason.
    for (const huge of [[0, 0, -1e200], [0, 0, -1e-200]]) {
      const { viewer, vp, g } = scene()
      const face = [0, 0, 20]
      expect(placeSectionPlane(vp, g, huge, face)).toBe(true)
      expect(vp.sectionSeed.normal).toEqual([0, 0, -1])
      expect(distance(g, face)).toBeCloseTo(-bias(viewer), 9)
      // In front of the face and behind it, on opposite sides of the plane.
      expect(distance(g, [0, 0, 0])).toBeGreaterThan(0)
      expect(distance(g, [0, 0, 40])).toBeLessThan(0)
    }
  })

  it('refuses a normal that is no direction at all', () => {
    // Zero length and non-finite are the same answer as a pick that found no
    // face: no cut, and NOTHING WRITTEN — the plane stands where it stood.
    const { viewer, vp, g } = scene()
    const before = viewer.getClipSlider(SECTION_INDEX)
    for (const bad of [[0, 0, 0], [NaN, 0, 1], [Infinity, 0, 0]]) {
      expect(placeSectionPlane(vp, g, bad, [0, 0, 20])).toBe(false)
      expect(vp.sectionSeed).toBeNull()
      expect(viewer.getClipSlider(SECTION_INDEX)).toBe(before)
    }
  })

  it('refuses a POINT that is no place at all, and writes nothing either', () => {
    // The other half of a seed, and it used to be unguarded while the normal was
    // not: `viewDir` normalises the eye-to-point difference, and `unit3` of a
    // difference carrying an infinity is a vector of NaNs — an array, so it
    // sailed past `if (!view)`. The seed was then written with an infinite
    // point, `applySection` refused to place anything and returned false, and
    // the record stayed behind saying a cut existed.
    const { viewer, vp, g } = scene()
    const before = viewer.getClipSlider(SECTION_INDEX)
    // `null` and the short array are a DIFFERENT failure from the other two and
    // that is why they are here: an infinity comes back through `viewDir` as a
    // direction of NaNs, while `vec3(null)` reads `null[0]` and throws — and
    // `placeSectionPlane` has no `try` to catch it with, so the exception would
    // leave the tool rather than the plane.
    for (const bad of [[Infinity, 0, 0], [0, NaN, 0], null, undefined, [1, 2]]) {
      expect(placeSectionPlane(vp, g, [0, 0, -1], bad)).toBe(false)
      expect(vp.sectionSeed).toBeNull()
      expect(viewer.getClipSlider(SECTION_INDEX)).toBe(before)
    }
  })

  it('refuses a captured plane that is no plane, and leaves no seed', () => {
    // The twin of the two above, on the restore side, and it had no test at all
    // while its `placeSectionPlane` counterpart did. `[Infinity, 0, 0]` is the
    // case that discriminates: `unit3` returns `[NaN, 0, 0]` for it — truthy —
    // so a plain `if (!normal)` accepts it and stores exactly the rubbish seed
    // this module warns about. `captureSection` is the far end of the same
    // thread and now refuses to mint one; this is the near end.
    for (const keep of [{ normal: [Infinity, 0, 0], point: [1, 0, 0], placed: true },
                        { normal: [NaN, 0, 0], point: [1, 0, 0], placed: true },
                        { normal: [0, 0, 0], point: [1, 0, 0], placed: true },
                        { normal: [1, 0, 0], point: [Infinity, 0, 0], placed: true }]) {
      const { viewer, vp } = scene()
      const before = viewer.getClipSlider(SECTION_INDEX)
      expect(restoreSection(vp, keep)).toBe(false)
      expect(vp.sectionSeed).toBeNull()
      expect(viewer.getClipSlider(SECTION_INDEX)).toBe(before)
    }
  })

  it('normalises what `restoreSection` is handed', () => {
    // A live reload feeds this from `captureSection`, which is unit — but `keep`
    // is a plain object that has crossed a swap, so the guarantee is made here
    // rather than assumed of the sender. The offset is what makes the length
    // bite: the seed is the captured point walked BACK along the normal by it.
    const before = scene()
    const face = [4, 0, 0]
    placeSectionPlane(before.vp, before.g, [1, 0, 0], face)
    before.vp.state.cutOffset = 5
    applySection(before.vp, before.g)
    const keep = captureSection(before.vp)

    const plain = scene()
    plain.vp.state.cutOffset = 5
    expect(restoreSection(plain.vp, keep)).toBe(true)

    const doubled = scene()
    doubled.vp.state.cutOffset = 5
    expect(restoreSection(doubled.vp, { ...keep, normal: keep.normal.map((c) => c * 2) }))
      .toBe(true)

    expect(doubled.vp.sectionSeed.normal).toEqual(plain.vp.sectionSeed.normal)
    expect(distance(doubled.g, face)).toBeCloseTo(distance(plain.g, face), 9)
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
    // And how much of the normal the projection leaves. This one is square
    // ACROSS the view, so all of it: the plane is seen edge-on.
    expect(axis.sine).toBeCloseTo(1, 9)
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

  it('is null when the camera is nowhere, on any axis', () => {
    // The edge-on guard is `Math.sqrt(1 - cos*cos) < MIN_SINE`, and with a NaN
    // cosine that comparison is FALSE — which is the branch that lets the drag
    // through. So a camera position this cannot subtract has to be refused
    // earlier, in `viewDir`, and it is. `y` and not `x` on purpose: `viewDir`
    // checked `eye.x` alone for as long as it checked components at all.
    const { viewer, g } = ctx
    viewer.setClipNormal(SECTION_INDEX, [1, 0, 0], null, true)
    expect(sectionAxis(viewer, g, [0, 0, 0])).not.toBeNull()   // premise
    // THE SHAPE COMES FROM THE LIBRARY, not from a literal here, and that is
    // what makes this test about `viewDir` at all. `sectionAxis` later does
    // `eye.clone().set(...)` and bails on anything without a `clone` — so a bare
    // `{x, y, z}` would be refused at THAT line instead, and this test would
    // pass against the old `viewDir` while proving nothing about it.
    const real = g.camera.getPosition()
    expect(typeof real.clone).toBe('function')
    g.camera.getPosition = () => { const v = real.clone(); v.y = Infinity; return v }
    expect(sectionAxis(viewer, g, [0, 0, 0])).toBeNull()
  })
})

describe('sectionGripAxis', () => {
  // What the HANDLE is drawn along and dragged on. The camera looks down -Z from
  // z = 80 and puts 20 px on a world unit along both screen axes (400 px per 20
  // halfW across, 300 px per 15 halfH up), so every number below is the camera's
  // own arithmetic and not the module's.
  let ctx
  const face = [0, 0, 0]
  /** A normal inside the zone `sectionAxis` refuses: nearly along the view. */
  const facing = (viewer) => {
    const shallow = Math.asin(MIN_SINE * 0.9)
    viewer.setClipNormal(SECTION_INDEX,
                         [Math.sin(shallow), 0, Math.cos(shallow)], null, true)
  }

  beforeEach(() => { ctx = scene() })

  it('hands back the answer `sectionAxis` has, wherever it has one', () => {
    // Outside the degenerate zone NOTHING changes, which is what lets the handle
    // switch to this function without moving anything the reader can see.
    const { viewer, g } = ctx
    for (const normal of [[1, 0, 0], [0, 1, 0], [1, 1, 0.2]]) {
      viewer.setClipNormal(SECTION_INDEX, normal, null, true)
      const axis = sectionAxis(viewer, g, face)
      expect(axis, 'the premise: this normal projects to something').not.toBeNull()
      expect(sectionGripAxis(viewer, g, face)).toEqual(axis)
    }
  })

  it('answers a VERTICAL axis where `sectionAxis` declines', () => {
    const { viewer, g } = ctx
    facing(viewer)
    expect(sectionAxis(viewer, g, face),
           'the premise: this is the zone that used to hide the handle').toBeNull()

    const axis = sectionGripAxis(viewer, g, face)
    expect(axis.sx).toBe(0)
    expect(Number.isFinite(axis.sy)).toBe(true)
    expect(axis.sy).toBeGreaterThan(0)
    expect(axis.s2).toBeCloseTo(axis.sy * axis.sy, 9)
  })

  it('measures the camera in the same pixels `sectionAxis` does', () => {
    // The two measurements have to agree about what a world unit is worth on
    // screen, or the grip would drag at one rate and the canvas at another. The
    // yardstick is `sectionAxis` itself, asked about a normal ACROSS the view at
    // the same point — the length of its answer is this camera's scale.
    const { camera, viewer, g } = ctx
    viewer.setClipNormal(SECTION_INDEX, [1, 0, 0], null, true)
    const across = sectionAxis(viewer, g, face)
    const scale = Math.sqrt(across.s2)
    expect(scale).toBeCloseTo((camera.zoom * RECT.width) / (2 * camera.halfW), 9)

    facing(viewer)
    expect(sectionGripAxis(viewer, g, face).sy).toBeCloseTo(scale, 9)
  })

  it('measures the sine against the camera axis, not the ray it branched on', () => {
    // The two numbers are different questions and this function holds both. The
    // GUARD that sent it down this branch is the normal against the ray from the
    // eye to the anchor; `sine` is the normal against the camera's projection
    // axis, which is what the grip draws its arrow's length from.
    //
    // On the axis they agree, so the second anchor is moved OFF it — far enough
    // that a normal `MIN_SINE * 0.9` off the view axis is nearly 45 degrees off
    // the RAY to it. A `sine` taken from the ray would answer about 0.70 there.
    //
    // And the two anchors reach it down DIFFERENT branches, which is the point
    // of taking both: on the axis the guard refuses and the fallback answers,
    // while off it the ray-based guard is satisfied and `sectionAxis` does. The
    // measurement has to be the same either way, because it is a fact about the
    // plane and the camera and not about which branch ran.
    const { viewer, g } = ctx
    facing(viewer)
    expect(sectionGripAxis(viewer, g, face).sine).toBeCloseTo(MIN_SINE * 0.9, 9)
    expect(sectionAxis(viewer, g, face), 'the premise: face takes the fallback')
      .toBeNull()

    const aside = [60, 0, 0]
    expect(sectionAxis(viewer, g, aside), 'and aside does not').not.toBeNull()
    expect(sectionGripAxis(viewer, g, aside).sine).toBeCloseTo(MIN_SINE * 0.9, 9)

    // THE CASE WHERE THE TWO ACTUALLY DISAGREE, and the only one that catches a
    // fallback measuring off the ray. Above, `face` reaches the fallback but
    // sits ON the camera axis, where ray and axis coincide; `aside` is off the
    // axis but the guard lets it through. So: the anchor off the axis AND the
    // normal laid along the RAY to it, which sends it down the fallback with a
    // foreshortening that is nothing like the guard's number.
    //
    // The ray to `aside` is unit([60, 0, -80]) = [0.6, 0, -0.8]. A normal in the
    // xz plane written [sin t, 0, cos t] is `MIN_SINE * 0.9` off that ray at
    // t = atan2(0.6, -0.8) + asin(MIN_SINE * 0.9). Its sine against the camera
    // axis — which is [0, 0, -1] here — is then just the size of its x, since
    // the sine to the z axis of a unit vector IS its component across z. That
    // is about 0.49, three and a half times the ray's 0.135.
    const t = Math.atan2(0.6, -0.8) + Math.asin(MIN_SINE * 0.9)
    const along = [Math.sin(t), 0, Math.cos(t)]
    viewer.setClipNormal(SECTION_INDEX, along, null, true)
    expect(sectionAxis(viewer, g, aside), 'the premise: the guard refuses')
      .toBeNull()
    expect(sectionGripAxis(viewer, g, aside).sine)
      .toBeCloseTo(Math.abs(along[0]), 9)
    expect(sectionGripAxis(viewer, g, aside).sine).toBeGreaterThan(MIN_SINE * 3)
  })

  it('makes a drag DOWNWARDS move the plane along the POSITIVE normal', () => {
    // The convention, and there is nothing to derive it from: in this zone the
    // projected normal is a stub, so which way the arrow means is fixed here
    // rather than measured. 40 px at 20 px per world unit is 2 world units.
    const { viewer, vp, g } = ctx
    placeSectionPlane(vp, g, [0, 0, 1], face)
    expect(sectionAxis(viewer, g, face),
           'the premise: a plane laid on a face square to the camera').toBeNull()
    const axis = sectionGripAxis(viewer, g, face)
    const before = distance(g, face)

    const travelled = dragSection(vp, g, axis, 0, 40)

    expect(travelled).toBeCloseTo(2, 9)
    // Signed along the normal in force, exactly as `dragSection`'s own suite
    // measures it: the plane moved 2 units the way the normal points.
    expect(before - distance(g, face)).toBeCloseTo(travelled, 9)
    // And a drag ACROSS the arrow still means nothing.
    expect(dragSection(vp, g, axis, 120, 0)).toBe(0)
  })

  it('declines when the scene cannot answer at all', () => {
    // The things `sectionAxis` refuses for once the angle is out of it: a clip
    // normal the library cannot hand back — it throws, or it is not a direction
    // — a camera that is nowhere, and a canvas of no size. A vertical arrow is a
    // fallback for a DEGENERATE VIEW, not for a scene nothing can be measured
    // against.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const gone = scene()
    facing(gone.viewer)
    expect(sectionGripAxis(gone.viewer, gone.g, face),
           'the premise: this scene answers').not.toBeNull()
    gone.viewer.getClipNormal = () => { throw new Error('normal gone') }
    expect(sectionGripAxis(gone.viewer, gone.g, face)).toBeNull()

    // AND A NORMAL THAT IS AN ARRAY BUT NOT A DIRECTION, which is the case a
    // bare `unit3` waves through: it answers an infinite component with
    // `[NaN, …]`, an array, and therefore truthy. `sectionAxis` refuses this one
    // downstream — its step comes back NaN and `!(s2 > 1e-12)` catches it — but
    // this function measures ACROSS the view, where the step is perfectly finite
    // and nothing further on would notice.
    const unreal = scene()
    facing(unreal.viewer)
    unreal.viewer.getClipNormal = () => [Infinity, 0, 0]
    expect(sectionAxis(unreal.viewer, unreal.g, face),
           'the premise: the old guard hid the handle here').toBeNull()
    expect(sectionGripAxis(unreal.viewer, unreal.g, face)).toBeNull()

    const nowhere = scene()
    facing(nowhere.viewer)
    const real = nowhere.g.camera.getPosition()
    nowhere.g.camera.getPosition = () => {
      const v = real.clone()
      v.y = Infinity
      return v
    }
    expect(sectionGripAxis(nowhere.viewer, nowhere.g, face)).toBeNull()

    const unsized = scene()
    facing(unsized.viewer)
    unsized.g.canvas.getBoundingClientRect = () => ({ ...RECT, width: 0, height: 0 })
    expect(sectionGripAxis(unsized.viewer, unsized.g, face)).toBeNull()
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

  it('moves nothing when the slider does not read as a number', () => {
    // A drag is the one placement that starts from the library's OWN number
    // rather than recomputing one, so an unreadable slider is arithmetic on NaN:
    // the guard is what keeps a plane from being written to a constant nothing
    // can measure, which looks on screen like the model disappearing.
    const { vp, g, viewer } = ctx
    const before = distance(g, face)
    viewer.getClipSlider = () => NaN
    expect(dragSection(vp, g, axis, 40, 0)).toBe(0)
    expect(distance(g, face)).toBe(before)
  })

  it('does not stall on the one slider value the library silently refuses', () => {
    // The other half of the guard `standSection` carries, and a drag reaches
    // that number more easily than a placement does: `sectionValue` clamps to
    // +-`sectionLimit`, so on a grid of 2 the lower stop of the travel IS
    // exactly -1 — which `Viewer.setClipSlider` reads as "no value given" and
    // ignores. Untreated, the plane stops dead at one end of its range while
    // this function goes on reporting the distance it covered, and parts 2 mm
    // across are ordinary here.
    const { viewer, vp, g } = scene({ gridSize: 2 })
    viewer.setClipNormal(SECTION_INDEX, [1, 0, 0], null, true)
    viewer.setClipSlider(SECTION_INDEX, -0.95, true)
    const stop = sectionAxis(viewer, g, face)
    const before = distance(g, face)
    const travelled = dragSection(vp, g, stop, 1e6, 0)
    expect(viewer.getClipSlider(SECTION_INDEX)).not.toBe(-1)
    // The distance it REPORTS is the distance it MOVED — the pair is the whole
    // failure, since either alone still reads as a plane at the end of its
    // travel.
    expect(travelled).toBeGreaterThan(0)
    expect(before - distance(g, face)).toBeCloseTo(travelled, 9)
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

  it('reads back a re-appliable number on a FLIPPED cut too', () => {
    // The same round trip with the normal turned over, and the reason it needs
    // its own test: `state.cutOffset` counts along the SEED normal while
    // `distanceToPoint` is signed along the normal in force, so on a flipped cut
    // the two disagree by a sign. Dropping that sign does not read as a small
    // error — the first reconcile after the drag hands `applySection` the
    // offset's negative and the plane jumps to the far side of the face.
    const { viewer, vp, g } = scene()
    const face = [0, 0, 0]
    placeSectionPlane(vp, g, [1, 0, 0], face)
    vp.state.cutFlip = true
    applySection(vp, g)
    const axis = sectionAxis(viewer, g, face)
    dragSection(vp, g, axis, 30, 0)
    const dragged = distance(g, face)

    vp.state.cutOffset = sectionOffset(vp)
    applySection(vp, g)
    expect(distance(g, face)).toBeCloseTo(dragged, 9)
    applySection(vp, g)                      // ...and every reconcile after it
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

  it('refuses to mint a plane out of a normal that is not one', () => {
    // THE FAR END OF THE THREAD `restoreSection` GUARDS AT THE NEAR END: what
    // comes out of here is what a live reload hands straight back in, and the
    // swap in between is where the evidence of where it came from is lost. A
    // library holding an infinite clip normal gives `unit3` a vector of NaNs —
    // an array, and truthy — so the bare check this used to make would have
    // minted exactly the `keep` the restore side has to defend against.
    const { viewer, vp, g } = scene()
    placeSectionPlane(vp, g, [1, 0, 0], [2, 0, 0])
    expect(captureSection(vp)).not.toBeNull()          // premise
    for (const bad of [[Infinity, 0, 0], [NaN, 0, 0], [0, 0, 0]]) {
      viewer.getClipNormal = () => [...bad]
      expect(captureSection(vp)).toBeNull()
    }
  })

  it('is null when the slider does not read as a number', () => {
    // The parked-at-the-far-edge test above cannot cover this one: `NaN >= lim`
    // is false, so an unreadable slider walks straight past that comparison and
    // a capture would come back describing a plane, which a live reload would
    // then faithfully restore.
    const { viewer, vp, g } = scene()
    placeSectionPlane(vp, g, [1, 0, 0], [2, 0, 0])
    expect(captureSection(vp)).not.toBeNull()
    viewer.getClipSlider = () => NaN
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
    // restore: what follows a swap on the real page is `reconcile()`, which
    // every `hmr:state` THAT STARTS NO LOAD reaches — a click in the tree, a
    // pin, a step of the offset slider — and which calls `applySection` with
    // `state.cutOffset` still standing. (A view tab starts a load and returns
    // before reconcile, so it is not one of them.) A seed carrying the offset
    // already would walk the plane those five millimetres a second time on the
    // first of them, and the placement bias rides along on the restore itself,
    // once per live reload.
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

  it('carries a FLIPPED cut across, offset and sliver and all', () => {
    // The three sign conventions that meet on a flipped cut, and the reason this
    // test is separate from the one above: the offset is walked along the SEED
    // normal (`applySection`), `distanceToPoint` is signed along the normal IN
    // FORCE (`captureSection`, `sectionOffset`), and the seed is recorded
    // unflipped. Getting the first one wrong is worth exactly twice the offset —
    // the seed lands that far the wrong side of the face and the plane is walked
    // the same distance again from there — and getting the sliver's direction
    // wrong is worth two of them on every live reload.
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
    // ...and stays there through the reconcile that follows any `hmr:state`
    // which starts no load.
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
