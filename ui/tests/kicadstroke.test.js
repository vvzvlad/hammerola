// How the KiCad viewer cuts a dashed or dotted line into marks
// (ecad-viewer/packages/ecad-viewer-app/src/kicad/stroke-params.ts), as KiCad's
// STROKE_PARAMS::Stroke does (common/stroke_params.cpp): the mark and gap lengths
// of RENDER_SETTINGS (common/render_settings.cpp), a dash of (ratio - 1) widths and
// a gap of (ratio + 1), the pattern carried along a chain and restarted on each
// arc. How the marks look is checked by eye.

import { describe, expect, it } from 'vitest'

import { Vec2 } from '../../ecad-viewer/packages/ecad-viewer-app/src/base/math/vec2.ts'
import { dash_arc, dash_pattern, dash_polyline } from '../../ecad-viewer/packages/ecad-viewer-app/src/kicad/stroke-params.ts'

/** Marks as arrays of [x, y]. */
const points = (marks) => marks.map((mark) => mark.map((p) => [p.x, p.y]))

describe('the marks of a dashed line', () => {
  it('are KiCad\'s lengths: a dash of 11 widths, a dot of 0.2, a gap of 4 at the default ratios of 12 and 3', () => {
    expect(dash_pattern('dash', 1)).toEqual([11, 4])
    expect(dash_pattern('dot', 1)).toEqual([0.2, 4])
    expect(dash_pattern('dash_dot', 1)).toEqual([11, 4, 0.2, 4])
    expect(dash_pattern('dash_dot_dot', 1)).toEqual([11, 4, 0.2, 4, 0.2, 4])
    expect(dash_pattern('dash', 0.5)).toEqual([5.5, 2])
  })

  it('follow the schematic\'s own ratios, a dash and a gap never shorter than one width, and a solid line has none', () => {
    expect(dash_pattern('dash', 1, 6, 2)).toEqual([5, 3])
    expect(dash_pattern('dash', 1, 1.5, -3)).toEqual([1, 1])
    expect(dash_pattern('solid', 1)).toBeNull()
    expect(dash_pattern('default', 1)).toBeNull()
  })

  it('run along a segment from its start, the last one cut at its end', () => {
    expect(points(dash_polyline([new Vec2(0, 0), new Vec2(30, 0)], [11, 4])))
      .toEqual([[[0, 0], [11, 0]], [[15, 0], [26, 0]]])
    expect(points(dash_polyline([new Vec2(0, 0), new Vec2(20, 0)], [11, 4])))
      .toEqual([[[0, 0], [11, 0]], [[15, 0], [20, 0]]])
  })

  it('carry the pattern round a corner, a dash bending with it', () => {
    expect(points(dash_polyline([new Vec2(0, 0), new Vec2(10, 0), new Vec2(10, 10)], [11, 4])))
      .toEqual([[[0, 0], [10, 0], [10, 1]], [[10, 5], [10, 10]]])
  })

  it('are none for a pattern of no length', () => {
    expect(dash_polyline([new Vec2(0, 0), new Vec2(10, 0)], [0, 0])).toEqual([])
  })

  it('go round an arc by angle, either way, the last one cut at its end', () => {
    // A radius of 2: a length of 1 is half a radian.
    expect(dash_arc(2, 0, Math.PI, [1, 1])).toEqual([[0, 0.5], [1, 1.5], [2, 2.5], [3, Math.PI]])
    expect(dash_arc(2, Math.PI, 0, [1, 1])).toEqual([[Math.PI, Math.PI - 0.5], [Math.PI - 1, Math.PI - 1.5],
      [Math.PI - 2, Math.PI - 2.5], [Math.PI - 3, 0]])
  })
})
