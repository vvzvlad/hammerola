// The schematic plane's frame counter as numbers (ecad-viewer/packages/
// ecad-viewer-app/src/viewers/schematic/frame-meter.ts): frames in the last
// second, and the fewest in a whole second of the latest run of frames, which
// is what the 30 frames per second threshold is read from. How the readout
// looks is checked in a browser, not here.

import { describe, expect, it } from 'vitest'

import { count_frame } from '../../ecad-viewer/packages/ecad-viewer-app/src/viewers/schematic/frame-meter.ts'

/** The meter after frames started at `times` (ms), each taking `took(t)` ms. */
const metered = (times, took = () => 2, meter = null) =>
  times.reduce((m, t) => count_frame(m, t, took(t)), meter)

/** `n` frames evenly over [from, to). */
const frames = (from, to, n) => Array.from({ length: n }, (_, i) => from + ((to - from) * i) / n)

describe('the frame counter', () => {
  // A pan from 0.5 s to 4.5 s: 60 frames a second, 40 in its third second
  // (2-3 s), and 10 in each of its partial first and last seconds.
  const pan = [
    ...frames(500, 1000, 10), ...frames(1000, 2000, 60), ...frames(2000, 3000, 40),
    ...frames(3000, 4000, 60), ...frames(4000, 4500, 10),
  ]

  it('reads the fewest frames in a whole second of the run, its partial first and last seconds left out', () => {
    const meter = metered(pan, (t) => (t >= 2000 && t < 3000 ? 9 : 3))
    expect(meter.pan).toEqual({ min: 40, longest: 9 })
    // the second up to the last frame, at 4.45 s: 32 of the 60 a second and the last 10
    expect(meter.recent).toHaveLength(42)
    expect(meter.took).toBe(3)
  })

  it('has no reading before a run covers a whole second', () => {
    expect(metered(frames(500, 1900, 50)).pan).toBeNull()
  })

  it('keeps the reading of the latest pan when a short run of frames follows it, and a new pan replaces it', () => {
    const after = metered([4800, 4850, 6000], () => 50, metered(pan))
    expect(after.pan).toEqual({ min: 40, longest: 2 })
    expect(after.recent).toEqual([6000])
    // 50 frames a second with a 320 ms gap at 9.5 s: the gap ends a run, as
    // one run over it would read 35 in its second 9-10 s
    const next = metered([...frames(7000, 9500, 125), ...frames(9800, 12000, 110)], () => 2, after)
    expect(next.pan).toEqual({ min: 50, longest: 2 })
  })
})
