// ui/src/viewport/math.js — the arithmetic three gestures are built out of.
//
// Small enough to look correct, which is exactly why it is worth pinning: every
// function here takes or returns a SHAPE (an `{x, y, z}` in, a plain array out)
// and the two are mixed on purpose — `sub3` reads the object form because that
// is what the library hands back, `vec3` builds it because that is what the
// library takes. A silent swap of the two produces `NaN`s a long way from here.

import { describe, expect, it } from 'vitest'

import {
  clamp, cross3, dot3, finite3, len3, sub3, unit3, vec3,
} from '../src/viewport/math.js'

describe('sub3', () => {
  it('takes two {x, y, z} objects and returns a plain array', () => {
    expect(sub3({ x: 4, y: 6, z: 9 }, { x: 1, y: 2, z: 3 })).toEqual([3, 4, 6])
  })
})

describe('vec3', () => {
  it('is the other direction: an array becomes the object a library call takes', () => {
    expect(vec3([1, 2, 3])).toEqual({ x: 1, y: 2, z: 3 })
  })

  it('round-trips through sub3 against the origin', () => {
    const point = [1.5, -2.25, 7]
    expect(sub3(vec3(point), vec3([0, 0, 0]))).toEqual(point)
  })
})

describe('dot3 and len3', () => {
  it('agree with each other: len3(a)^2 is a . a', () => {
    const a = [3, -4, 12]
    expect(len3(a) ** 2).toBeCloseTo(dot3(a, a), 12)
  })

  it('len3 of a unit vector is 1', () => {
    expect(len3(unit3([7, -1, 4]))).toBeCloseTo(1, 12)
  })
})

describe('cross3', () => {
  it('is right-handed: x cross y is z', () => {
    expect(cross3([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1])
  })

  it('is perpendicular to both arguments', () => {
    const a = [1, 2, 3]
    const b = [-4, 5, 6]
    const c = cross3(a, b)
    expect(dot3(c, a)).toBeCloseTo(0, 12)
    expect(dot3(c, b)).toBeCloseTo(0, 12)
  })

  it('is zero for parallel vectors, which is what the picking guard leans on', () => {
    expect(cross3([2, 4, 6], [1, 2, 3])).toEqual([0, 0, 0])
  })
})

describe('unit3', () => {
  it('returns null rather than NaNs for a zero-length vector', () => {
    // The whole point of the guard: a division by zero here would put NaN into
    // a camera position, where nothing throws and the scene simply vanishes.
    expect(unit3([0, 0, 0])).toBeNull()
  })

  it('keeps the direction and scales the length to 1', () => {
    const a = [0, 3, 4]
    const u = unit3(a)
    expect(len3(u)).toBeCloseTo(1, 12)
    // Parallel to the original: the cross product of the two is zero.
    expect(len3(cross3(u, a))).toBeCloseTo(0, 12)
  })

  it('answers for a vector too large or too small for `len3` to square', () => {
    // WHY THIS DOES NOT GO THROUGH `len3`, and the reason it is a separate
    // function: `len3` squares first, so it overflows to Infinity around 1.34e154
    // and underflows to 0 around 1.5e-162. Dividing by either produced an answer
    // that was WRONG RATHER THAN ABSENT — `[1e200,0,0]` came back as `[0,0,0]`, a
    // finite vector of zero length that every finiteness check waves through.
    // What that does downstream is NOT a crash and not a NaN: three.js's own
    // `normalize` is `divideScalar( length() || 1 )`, so zero stays zero, the
    // clip plane becomes `(0,0,0,w)` and the fragment test `dot(vClipPosition,
    // plane.xyz) > plane.w` reads `0 > w` — false, nothing discarded, the model
    // whole on screen and the cut silently not happening. `Math.hypot` scales by
    // the largest component instead.
    expect(unit3([1e200, 0, 0])).toEqual([1, 0, 0])
    expect(unit3([0, -1e-200, 0])).toEqual([0, -1, 0])
    // ...and it is the direction that is preserved, not just the length: a
    // mixed-magnitude vector still comes back parallel to itself and unit.
    const mixed = unit3([3e200, -4e200, 0])
    expect(mixed[0]).toBeCloseTo(0.6, 12)
    expect(mixed[1]).toBeCloseTo(-0.8, 12)
    expect(len3(mixed)).toBeCloseTo(1, 12)
  })

  it('is NOT unit on subnormals, which is the one limit of the formula', () => {
    // PINNED RATHER THAN FIXED, and the distinction is the point. `Math.hypot`
    // divides by the largest component before squaring, and at the bottom of the
    // subnormal range there is no precision left to divide with: the answer comes
    // back finite — so `finite3` accepts it — and is not a unit vector.
    //
    // Unreachable from this application's geometry: every component here comes
    // from a picker, a camera or a bounding box, and none produces a coordinate
    // below 2.2e-308. So nothing guards it, because a guard against an input
    // nothing can supply is one nothing can test honestly. What is worth having
    // is this: the callers' precondition says "unit", and this is the input for
    // which that word is qualified rather than absolute.
    //
    // QUALITATIVE ON PURPOSE. `Math.hypot` is "implementation-approximated" in
    // the standard, so its digits are the engine's business and not a fact about
    // this repository. Pinning them would make the suite red when the engine
    // changed — including when it IMPROVED, since an exact hypot would return
    // exactly 1 here. The two things asserted are the two the callers care
    // about: the guards let it through, and it is not the unit vector they
    // assume. A loose bound rather than a close one, for the same reason.
    const u = unit3([5e-324, 5e-324, 0])
    expect(finite3(u)).toBe(true)
    expect(Math.abs(len3(u) - 1)).toBeGreaterThan(0.01)
  })

  it('declines a vector that has no direction to find', () => {
    // The two that remain, and they are different answers on purpose. A caller
    // that STORES the result has to check `finite3` rather than truthiness,
    // because the infinite case is an array — section.js does, at both of the
    // places it writes a seed.
    expect(unit3([NaN, 0, 0])).toBeNull()
    expect(unit3([Infinity, 0, 0]).every(Number.isFinite)).toBe(false)
  })
})

describe('clamp', () => {
  it('takes (value, lo, hi) in that order and holds both ends', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })
})

describe('finite3', () => {
  it('accepts exactly a three-element array of finite numbers', () => {
    expect(finite3([1, 2, 3])).toBe(true)
  })

  it('refuses every way a gesture can produce rubbish', () => {
    expect(finite3([1, 2])).toBe(false)
    expect(finite3([1, 2, 3, 4])).toBe(false)
    expect(finite3([1, NaN, 3])).toBe(false)
    expect(finite3([1, Infinity, 3])).toBe(false)
    expect(finite3(null)).toBe(false)
    expect(finite3({ x: 1, y: 2, z: 3 })).toBe(false)
  })
})
