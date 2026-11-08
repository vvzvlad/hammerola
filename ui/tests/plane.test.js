// The schematic plane of the KiCad viewer as numbers (ecad-viewer/packages/
// ecad-viewer-app/src/viewers/schematic/plane.ts): where each sheet instance
// stands, which one a point or a comment's area is on, the sheet a `#N` link
// names, how far the gestures zoom out, and where a comment's mark stands; and
// the path each sheet's title block prints (kicanvas/sheet-path.ts). How the
// plane looks is checked in a browser, not here.

import { describe, expect, it } from 'vitest'

import { BBox, Vec2 } from '../../ecad-viewer/packages/ecad-viewer-app/src/base/math/index.ts'
import { readable_sheet_path } from '../../ecad-viewer/packages/ecad-viewer-app/src/kicanvas/sheet-path.ts'
import {
  area_on_sheet, fit_box, fit_zoom, plane_comments, plane_slots, slot_at, slot_by_link, zoom_floor,
} from '../../ecad-viewer/packages/ecad-viewer-app/src/viewers/schematic/plane.ts'

const page = (key, filename, extra = {}, paper = undefined) => ({ key, document: { filename, paper }, ...extra })
const A3 = { width: 420, height: 297 }
// The root and a sheet without a page number, both A4 (297×210), and one A3
// file placed twice, as pages 3 and 2.
const SLOTS = plane_slots([
  page('/r', 'top.kicad_sch'),
  page('/r/x', 'notes.kicad_sch', { parent_key: '/r' }),
  page('/r/amp-l', 'amp.kicad_sch', { parent_key: '/r', number: '3' }, A3),
  page('/r/amp-r', 'amp.kicad_sch', { parent_key: '/r', number: '2' }, A3),
])
const key = (slot) => slot && slot.page.key

describe('the schematic plane', () => {
  it('stands the root first, then KiCad\'s page numbers, then the rest as they came, in rows by their paper', () => {
    // two to a row, 50 apart: the first row as tall as its A3
    expect(SLOTS.map((slot) => [key(slot), slot.offset.x, slot.offset.y]))
      .toEqual([['/r', 0, 0], ['/r/amp-r', 347, 0], ['/r/amp-l', 0, 347], ['/r/x', 470, 347]])
  })

  it('finds the sheet under a point, and an area\'s on the one under its centre or nearest it, in that sheet\'s millimetres', () => {
    expect([key(slot_at(SLOTS, new Vec2(400, 100))), key(slot_at(SLOTS, new Vec2(320, 100)))]).toEqual(['/r/amp-r', undefined])
    const on = (bounds) => {
      const { slot, bounds: local } = area_on_sheet(SLOTS, bounds)
      return [key(slot), local]
    }
    expect(on([400, 400, 20, 10])).toEqual(['/r/amp-l', [400, 53, 20, 10]])
    // its centre between the root and the A3 to its right, nearer the A3: not cut at its edge
    expect(on([330, 90, 10, 20])).toEqual(['/r/amp-r', [-17, 90, 10, 20]])
    expect(area_on_sheet([], [0, 0, 1, 1])).toBeNull()
  })

  it('names by `#N` the sheet of KiCad\'s page N, and none for another link', () => {
    expect(['#3', '#2', '#9', '#', 'amp.kicad_sch'].map((link) => key(slot_by_link(SLOTS, link))))
      .toEqual(['/r/amp-l', '/r/amp-r', undefined, undefined, undefined])
  })

  it('fits with room for the names above, and zooms out no further than the viewers\' floor, Fit or the camera', () => {
    const box = new BBox(0, 0, 100, 50)
    const zoom = fit_zoom(box, new Vec2(400, 224), 24)
    const fitted = fit_box(box, zoom, 24)
    expect([zoom, [fitted.x, fitted.y, fitted.w, fitted.h]]).toEqual([4, [0, -6, 100, 56]])
    // a phone's Fit under the floor, the floor itself, a camera further out, and no Fit yet
    expect([zoom_floor(0.5, 0.2, 1), zoom_floor(0.5, 2, 3), zoom_floor(0.5, 2, 0.3), zoom_floor(0.5, Infinity, NaN)])
      .toEqual([0.2, 0.5, 0.3, 0.5])
  })

  it('stands a comment on every instance of its sheet\'s file, one naming none on the root, its area moved with it', () => {
    const comments = [
      { id: 'c1', anchor: { kind: 'world', x: 5, y: 6, page: 'amp.kicad_sch' }, areaBounds: [4, 5, 2, 2] },
      { id: 'c2', anchor: { kind: 'world', x: 1, y: 2 } },
      { id: 'c3', anchor: { kind: 'source-item', uuid: 'u' } },
    ]
    expect(plane_comments(comments, SLOTS)).toEqual([
      { id: 'c1', anchor: { kind: 'world', x: 352, y: 6, page: 'amp.kicad_sch' }, areaBounds: [351, 5, 2, 2] },
      { id: 'c1', anchor: { kind: 'world', x: 5, y: 353, page: 'amp.kicad_sch' }, areaBounds: [4, 352, 2, 2] },
      comments[1],
      comments[2],
    ])
  })
})

describe('a sheet\'s title block', () => {
  it('prints as its path the names of the sheets from the root down, "/" on the root', () => {
    const pages = new Map([
      ['top.kicad_sch', { name: 'top' }],
      ['guard.kicad_sch:/g', { name: 'guard', parent_project_path: 'top.kicad_sch' }],
      ['a.kicad_sch:/a', { name: 'a', parent_project_path: 'top.kicad_sch' }],
      ['b.kicad_sch:/a/b', { name: 'b', parent_project_path: 'a.kicad_sch:/a' }],
    ])
    const path = (key) => readable_sheet_path(pages.get(key), (at) => pages.get(at))
    expect(['top.kicad_sch', 'guard.kicad_sch:/g', 'b.kicad_sch:/a/b'].map(path)).toEqual(['/', '/guard/', '/a/b/'])
  })
})
