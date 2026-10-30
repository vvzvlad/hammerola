// The beds of the `print` view on the build page: a row per bed in the parts
// tree, with the parts on it underneath and its 3MF on the row, and the menu a
// click on a drawn bed opens in the scene.
//
// The build writes the bed on every leaf of the `print` view (`"plate": N`);
// the rows are the page's own, so the leaves keep the paths comments,
// measurements and comparisons find them by.

import { describe, expect, it, vi } from 'vitest'

import HammerolaViewer from '../src/HammerolaViewer.jsx'
import BambuLink from '../src/bambu.jsx'
import CopyLink from '../src/copylink.jsx'
import { PAGE, indexTree } from '../src/hub.js'
import { treeFromShapes } from '../src/viewport/parts.js'
import { FILES_KEY, makeComponent } from './component.js'
import { collect } from './eltree.js'

/** A leaf of the `print` view as `treeFromShapes` hands it over. */
const leaf = (path, key, plate) => ({
  id: `/Group/${path}`, name: path.split('/').pop(), key,
  ...(plate === undefined ? {} : { plate }),
})

/** Two beds: the housing's lid and a pin on bed 1, its base and two pins on
 *  bed 2, in the author's order, which interleaves them. */
const tree = (plate = (n) => n) => ({
  id: '/Group', name: 'Group',
  children: [
    { id: '/Group/housing', name: 'housing', children: [
      leaf('housing/lid', 'lid', plate(1)), leaf('housing/base', 'base', plate(2))] },
    leaf('pin', 'pin', plate(2)), leaf('pin(2)', 'pin', plate(2)), leaf('pin(3)', 'pin', plate(1)),
  ],
})

const BED_1 = '/Group/print plate 1'
const BED_2 = '/Group/print plate 2'

const node = (index, id) => index.nodes.get(id)
const kids = (index, id) => node(index, id).children.map((kid) => node(index, kid))

describe('the tree of the print view', () => {
  it('is a row per bed under the root, in bed order, with that bed\'s parts under it', () => {
    const index = indexTree(tree())
    expect(kids(index, '/Group').map((row) => [row.name, row.plate]))
      .toEqual([['print plate 1', 1], ['print plate 2', 2]])
    expect(node(index, BED_1).leaves).toEqual(['/Group/housing/lid', '/Group/pin(3)'])
    expect(node(index, BED_2).leaves).toEqual(
      ['/Group/housing/base', '/Group/pin', '/Group/pin(2)'])
    // A group spanning beds is under each with its share; repeats still
    // collapse, `pin ×2`, as one row.
    expect(kids(index, BED_1).map((row) => row.name)).toEqual(['housing', 'pin(3)'])
    expect(kids(index, BED_2).map((row) => [row.name, row.leaves.length]))
      .toEqual([['housing', 1], ['pin', 2]])
    // Every leaf keeps its path, and each is found by it.
    expect([...index.leaves].sort()).toEqual(['/Group/housing/base', '/Group/housing/lid',
      '/Group/pin', '/Group/pin(2)', '/Group/pin(3)'])
    expect(node(index, '/Group/pin(2)').leaves).toEqual(['/Group/pin', '/Group/pin(2)'])
  })

  it('names a group\'s copy on a further bed by that bed, whatever stands before it', () => {
    const housings = (raw) => {
      const index = indexTree(raw)
      return [BED_1, BED_2].map((bed) => kids(index, bed).find((row) => row.name === 'housing').id)
    }
    expect(housings(tree())).toEqual(['/Group/housing', '/Group/housing~2'])
    // One more part on the first bed, ahead of the housing in the author's order.
    const more = tree()
    more.children.unshift(leaf('clip', 'clip', 1))
    expect(housings(more)).toEqual(['/Group/housing', '/Group/housing~2'])
  })

  it('calls the one bed of a single-bed view `print plate`', () => {
    expect(kids(indexTree(tree(() => 1)), '/Group').map((row) => row.name))
      .toEqual(['print plate'])
  })

  it('is the author\'s tree, with no bed rows, when the leaves name no bed', () => {
    // A build made before beds were written on leaves, and every other view.
    const index = indexTree(tree(() => undefined))
    expect(kids(index, '/Group').map((row) => [row.name, row.leaves.length]))
      .toEqual([['housing', 2], ['pin', 3]])
    expect([...index.nodes.values()].every((row) => row.plate === null)).toBe(true)
  })

  it('leaves what is on no bed, the proposal\'s bodies, under the root after the beds', () => {
    const raw = tree()
    raw.children.push({ id: '/Group/proposal', name: 'proposal',
                        children: [{ id: '/Group/proposal/motor', name: 'motor', key: null }] })
    expect(kids(indexTree(raw), '/Group').map((row) => row.name))
      .toEqual(['print plate 1', 'print plate 2', 'proposal'])
  })

  it('has the bed carried onto each leaf out of the view file', () => {
    const rows = treeFromShapes({ name: 'Group', parts: [
      { name: 'pin', key: 'pin', plate: 2 }, { name: 'lid', key: 'lid' }] }, null)
    expect(rows.children.map((row) => row.plate)).toEqual([2, undefined])
  })
})

/** The build page on the `print` view of a two-bed build, its root open. */
function page({ key = true, menu = null } = {}) {
  return makeComponent(HammerolaViewer, {
    sync: vi.fn(),
    state: {
      meta: {
        project: 'fixture', commit: 'abc1234', built: '',
        parts: { pin: { kind: 'printable', files: { stl: 'pin.stl' } } },
        views: [{ id: 'print', name: 'print', file: 'print.json', parts: ['pin'],
                  gzip: 1000, plates: { 1: 'print.3mf', 2: 'print-2.3mf' } }],
      },
      view: 'print',
      tree: indexTree(tree()),
      expanded: { '/Group': true },
      menu,
      ...(key ? {} : { builds: null, token: null }),
    },
  })
}

const PLATE_2 = `${PAGE.base}print-2.3mf?files=${FILES_KEY}`

describe('a bed\'s row', () => {
  it('carries its 3MF for a reader holding the key, and nothing without it', () => {
    const rowOf = (c, id) => c.computed().rows.find((row) => row.key === id)
    expect(rowOf(page(), BED_2).plateHref).toBe(PLATE_2)
    expect(rowOf(page(), '/Group').plateHref).toBe('')
    expect(rowOf(page({ key: false }), BED_2).plateHref).toBe('')

    // Drawn on the row as the Downloads menu draws the bed: the link, Open in
    // Bambu Studio and Copy link.
    const drawn = (c) => collect(c.render(), (el) => (el.key === BED_2 ? el : undefined))[0]
    const controls = (row) => collect(row, (el) => (
      (el.type === 'a' && el.props.download) || el.type === BambuLink || el.type === CopyLink
        ? el.props.href : undefined))
    expect(controls(drawn(page()))).toEqual([PLATE_2, PLATE_2, PLATE_2])
    expect(controls(drawn(page({ key: false })))).toEqual([])
  })

  it('is no part: it selects nothing and opens no menu, and its eye is its parts\'', () => {
    const c = page()
    const row = c.computed().rows.find((one) => one.key === BED_2)
    expect(row.onSelect).toBeUndefined()
    expect(row.onMenu).toBeUndefined()
    row.onVis({ stopPropagation: vi.fn() })
    expect(c.state.hidden).toEqual(['/Group/housing/base', '/Group/pin', '/Group/pin(2)'])
  })
})

describe('a click on a drawn bed', () => {
  it('opens a menu of that bed\'s 3MF, as its row of the Downloads menu', () => {
    const c = page()
    c.sceneMenu({ id: null, name: null, plate: 2, x: 5, y: 6 })
    expect(c.state.menu).toEqual({ plate: 2, x: 5, y: 6 })
    const v = c.computed()
    expect(v.menuName).toBe('3MF')
    expect(v.menuItems.map((m) => [m.label, m.hint, m.href, m.bambu]))
      .toEqual([['print plate 2', 'print-2.3mf', PLATE_2, true]])
  })

  it('opens nothing for a reader without the key', () => {
    const c = page({ key: false, menu: { id: '/Group/pin', x: 0, y: 0 } })
    c.sceneMenu({ id: null, name: null, plate: 2, x: 5, y: 6 })
    expect(c.state.menu).toBeNull()
  })
})
