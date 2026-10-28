// The parts tree opens folded (the owner: «давай свернем дерево по умолчанию»),
// and a part picked on the model opens the groups above its row, because the
// brief asks that a click on the model says which row it was.
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
