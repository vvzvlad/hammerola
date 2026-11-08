// The parts tree opens folded (the owner: «давай свернем дерево по умолчанию»),
// and a part picked on the model opens the groups above its row, because the
// brief asks that a click on the model says which row it was. A part inside a
// `whole` group says the group's row: the owner hides one sticker with one click.
import { describe, expect, it, vi } from 'vitest'

import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { indexTree } from '../src/hub.js'
import { makeComponent, replaceState } from './component.js'

/** A root, a loose part and a sub-assembly with one part inside. */
const TREE = {
  id: '/model', name: 'model',
  children: [
    { id: '/model/cab', name: 'cab', key: 'cab' },
    { id: '/model/amp', name: 'amp',
      children: [{ id: '/model/amp/pcb', name: 'pcb', key: 'pcb' }] },
    { id: '/model/wiring', name: 'wiring',
      children: [{ id: '/model/wiring/gnd', name: 'gnd', key: 'gnd' }] },
  ],
}

function component(state = {}) {
  const c = makeComponent(HammerolaViewer, {
    setState: replaceState, sync: vi.fn(), schedulePoll: vi.fn(), toast: vi.fn(),
    state: { tree: indexTree(TREE), ...state },
  })
  c.captureHome = vi.fn()
  return c
}

describe('the parts tree', () => {
  it('opens folded, and a rebuild keeps what the reader opened', () => {
    const c = component({ tree: null })
    c.onModel({ tree: TREE, view: 'assembled', live: false })
    expect(c.state.expanded).toEqual({})

    c.state.expanded = { '/model': true }
    c.onModel({ tree: TREE, view: 'assembled', live: true })
    expect(c.state.expanded).toEqual({ '/model': true })
  })

  it('opens every group above a part picked on the model, and no other', () => {
    const c = component()
    c.onPick({ id: '/model/amp/pcb', name: 'pcb' })
    expect(c.state.sel).toBe('/model/amp/pcb')
    expect(c.state.expanded).toEqual({ '/model': true, '/model/amp': true })
  })

  it('stays folded when the pick is a proposal body, whose row is elsewhere', () => {
    const c = component()
    // The viewport's answer for the proposal group staged at `/model/amp`.
    c.el = () => ({ isOverlay: (id) => id === '/model/amp' || id.startsWith('/model/amp/') })
    c.onPick({ id: '/model/amp/pcb', name: 'pcb' })
    expect(c.state.sel).toBe('/model/amp/pcb')
    expect(c.state.expanded).toEqual({})
  })
})

/** Stickers on a case, each one object of several inks (`whole`): `sticker` on
 *  its own, and `logo` inside `decals`, which is one object too. `amp` is a
 *  plain group, and its leaf's `whole` is not a group's. */
const STICKERS = {
  id: '/model', name: 'model',
  children: [
    { id: '/model/sticker', name: 'sticker', whole: true,
      children: [{ id: '/model/sticker/white', name: 'white', key: 'white' },
                 { id: '/model/sticker/text', name: 'text', key: 'text' }] },
    { id: '/model/decals', name: 'decals', whole: true,
      children: [{ id: '/model/decals/logo', name: 'logo', whole: true,
                   children: [{ id: '/model/decals/logo/ink', name: 'ink', key: 'ink' }] }] },
    { id: '/model/amp', name: 'amp',
      children: [{ id: '/model/amp/pcb', name: 'pcb', key: 'pcb', whole: true }] },
  ],
}

describe('a group the scene picks as one object', () => {
  const stickers = () => component({ tree: indexTree(STICKERS) })

  it('is marked on its row, and a plain group or a leaf is not', () => {
    const { nodes } = indexTree(STICKERS)
    expect(nodes.get('/model/sticker').whole).toBe(true)
    expect(nodes.get('/model/amp').whole).toBe(false)
    expect(nodes.get('/model/amp/pcb').whole).toBe(false)
  })

  it('is what a pick on any of its parts selects, and its parts are lit', () => {
    const c = stickers()
    c.onPick({ id: '/model/sticker/text', name: 'text' })
    expect(c.state.sel).toBe('/model/sticker')
    expect(c.state.selName).toBe('sticker')
    expect(c.state.expanded).toEqual({ '/model': true })
    expect(c.selectedPaths()).toEqual(['/model/sticker/white', '/model/sticker/text'])
    // A plain group stays its own path, which lights nothing.
    c.state.sel = '/model/amp'
    expect(c.selectedPaths()).toEqual(['/model/amp'])
  })

  it('is not lifted to with the Move tool in hand, so the manipulator moves one leaf', () => {
    const c = stickers()
    c.state.tool = 'move'
    c.onPick({ id: '/model/sticker/text', name: 'text' })
    expect(c.state.sel).toBe('/model/sticker/text')
    expect(c.selectedPaths()).toEqual(['/model/sticker/text'])
    // Selected before Move was taken up, the group gives the manipulator nothing.
    c.state.sel = '/model/sticker'
    expect(c.selectedPaths()).toEqual(['/model/sticker'])
  })

  it('inside another such group, gives way to the outermost', () => {
    const c = stickers()
    c.onPick({ id: '/model/decals/logo/ink', name: 'ink' })
    expect(c.state.sel).toBe('/model/decals')
  })

  it('takes the right-click menu too, so Hide takes the one sticker', () => {
    const c = stickers()
    c.sceneMenu({ id: '/model/sticker/white', name: 'white', x: 10, y: 10 })
    expect(c.state.menu.id).toBe('/model/sticker')
    c.computed().menuItems.find((m) => m.label === 'Hide')
      .onClick({ stopPropagation() {}, preventDefault() {}, nativeEvent: {} })
    expect(c.state.hidden).toEqual(['/model/sticker/white', '/model/sticker/text'])
  })
})
