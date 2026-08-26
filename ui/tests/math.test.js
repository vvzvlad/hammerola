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
