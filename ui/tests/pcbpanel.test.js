// The board view's own panel (ui/src/PcbPanel.jsx): the layers, the zone fills
// and the net of the last click, over the PCB `<ecad-viewer>`.
//
// The viewer needs a GPU and is checked in a browser. Here the element is a
// plain DOM element carrying the methods the panel calls, and it behaves as the
// viewer does where the panel depends on it: each setter reports
// `ecad-viewer:view-state-change` at once, `clearSelection` reports
// `ecad-viewer:highlight-change` only when it put a net out, and a part selected
// from another view (`requestCrossProbe`) puts the nets out without a word. The
// panel is the real class with `setState` merging in place, its tree read off
// `render()`.

import { describe, expect, it, vi } from 'vitest'

import { SELECTION_EVENT } from '../src/KicadView.jsx'
import PcbPanel, { HIGHLIGHT_EVENT, PRESETS, VIEW_STATE_EVENT, ZONE_OPACITY } from '../src/PcbPanel.jsx'
import { collect, texts } from './eltree.js'

const LAYERS = ['F.Cu', 'In1.Cu', 'B.Cu', 'F.SilkS']

/** The PCB element, its board in `element.board`. */
function boardElement() {
  const element = document.createElement('ecad-viewer')
  const board = {
    layers: LAYERS.map((name) => ({ name, color: `var(--swatch-${name})`, visible: true, highlighted: false })),
    zones: 0.6,
    nets: [],
  }
  const changed = () => element.dispatchEvent(new CustomEvent(VIEW_STATE_EVENT))
  const layer = (name) => board.layers.find((one) => one.name === name)
  Object.assign(element, {
    board,
    getPcbViewState: vi.fn(() => ({
      layers: board.layers.map((one) => ({ ...one })),
      objectOpacity: { tracks: 1, vias: 1, pads: 1, zones: board.zones },
    })),
    setPcbLayerVisibility: vi.fn((name, visible) => {
      layer(name).visible = visible
      changed()
    }),
    setPcbLayerHighlight: vi.fn((name) => {
      for (const one of board.layers) one.highlighted = one.name === name
      changed()
    }),
    applyPcbLayerPreset: vi.fn((preset) => {
      for (const one of board.layers) Object.assign(one, { visible: preset === 'all' || one.name.startsWith('F.'), highlighted: false })
      changed()
    }),
    setPcbObjectOpacity: vi.fn((kind, value) => {
      board[kind] = value
      changed()
    }),
    getHighlightedNets: vi.fn(() => board.nets.map((net) => ({ ...net }))),
    setHighlightedNets: vi.fn((nets) => {
      board.nets = nets.map((net) => ({ ...net }))
      return { applied: nets, unresolved: [] }
    }),
    clearSelection: vi.fn(() => {
      if (!board.nets.length) return
      board.nets = []
      element.dispatchEvent(new CustomEvent(HIGHLIGHT_EVENT))
    }),
  })
  return element
}

/** The panel over a board on screen, mounted. */
function mounted() {
  const element = boardElement()
  const panel = new PcbPanel({ element, active: true })
  panel.setState = (patch) => Object.assign(panel.state, patch)
  panel.componentDidMount()
  return { panel, element }
}

/** The props the panel's tree gives a control, found by a data attribute. */
const control = (panel, attribute, value) => collect(panel.render(),
  (el) => (el.props[attribute] === value ? el : undefined))[0]
const press = (panel, attribute, value) => control(panel, attribute, value).props.onClick()
/** A click on a layer's name: the span that sets the active layer. */
const pressName = (panel, name) => control(panel, 'data-layer', name).props.children[0].props.onClick()
const header = (panel) => texts(panel.render().props.children[0])
const select = (element, detail) => element.dispatchEvent(new CustomEvent(SELECTION_EVENT, { detail }))
const shown = (panel) => panel.state.layers.filter((one) => one.visible).map((one) => one.name)

describe('the board\'s panel', () => {
  it('draws a row per layer of the board, and dims the zones as the board opens', () => {
    const { panel, element } = mounted()
    expect(element.setPcbObjectOpacity).toHaveBeenCalledWith('zones', ZONE_OPACITY)
    const rows = collect(panel.render(), (el) => el.props['data-layer'])
    expect(rows).toEqual(LAYERS)
    expect(texts(panel.render())).toEqual(['Layers', ...PRESETS.map(([, label]) => label), 'Zones', '20%', ...LAYERS])
    const [range] = collect(panel.render(), (el) => (el.props.type === 'range' ? el : undefined))
    expect(range.props.value).toBe(ZONE_OPACITY)
    expect(panel.render().props.style.visibility).toBe('visible')
  })

  it('changes the board through the viewer, and shows what the viewer then holds', () => {
    const { panel, element } = mounted()
    press(panel, 'data-eye', 'In1.Cu')
    expect(element.setPcbLayerVisibility).toHaveBeenCalledWith('In1.Cu', false)
    expect(shown(panel)).toEqual(['F.Cu', 'B.Cu', 'F.SilkS'])
    expect(control(panel, 'data-eye', 'In1.Cu').props.title).toBe('Show this layer')

    pressName(panel, 'B.Cu')
    expect(element.setPcbLayerHighlight).toHaveBeenLastCalledWith('B.Cu')
    expect(control(panel, 'data-layer', 'B.Cu').props.style.background).toBe('var(--accent-bg)')
    // a second click on the active layer leaves no layer active
    pressName(panel, 'B.Cu')
    expect(element.setPcbLayerHighlight).toHaveBeenLastCalledWith(null)
    expect(panel.state.layers.some((one) => one.highlighted)).toBe(false)

    expect(collect(panel.render(), (el) => el.props['data-preset'])).toEqual(['all', 'front', 'back', 'copper'])
    press(panel, 'data-preset', 'front')
    expect(element.applyPcbLayerPreset).toHaveBeenCalledWith('front')
    expect(shown(panel)).toEqual(['F.Cu', 'F.SilkS'])

    const [range] = collect(panel.render(), (el) => (el.props.type === 'range' ? el : undefined))
    range.props.onChange({ target: { value: '0.45' } })
    expect(element.setPcbObjectOpacity).toHaveBeenLastCalledWith('zones', 0.45)
    expect(texts(panel.render())).toContain('45%')
  })

  it('follows what the element reports, and reads it again when the board is back on screen', () => {
    const { panel, element } = mounted()
    element.setPcbLayerVisibility('F.SilkS', false)
    expect(shown(panel)).toEqual(['F.Cu', 'In1.Cu', 'B.Cu'])

    select(element, { sourceContext: 'PCB', itemType: 'track', net: 'GND', netCode: 1 })
    panel.props = { element, active: false }
    panel.componentDidUpdate({ element, active: true })
    expect(panel.render().props.style.visibility).toBe('hidden')
    // a part selected in the schematic while the board is hidden puts its net
    // out, and the viewer says nothing
    element.board.nets = []
    expect(header(panel)).toEqual(['Layers', 'net', 'GND'])
    panel.props = { element, active: true }
    panel.componentDidUpdate({ element, active: false })
    expect(header(panel)).toEqual(['Layers'])
    // and the panel still works on the element it had
    press(panel, 'data-eye', 'F.Cu')
    expect(element.setPcbLayerVisibility).toHaveBeenLastCalledWith('F.Cu', false)
  })

  it('lights the whole net of a clicked track, pad, via or zone and names it', () => {
    const { panel, element } = mounted()
    select(element, { sourceContext: 'PCB', itemType: 'track', net: '+5V', netCode: 14, layer: 'In2.Cu' })
    expect(element.setHighlightedNets).toHaveBeenLastCalledWith([{ name: '+5V', netCode: 14 }])
    expect(header(panel)).toEqual(['Layers', 'net', '+5V'])
    for (const itemType of ['pad', 'via', 'zone']) {
      select(element, { sourceContext: 'PCB', itemType, reference: 'L501', net: `/amp/${itemType}`, netCode: 9 })
      expect(element.setHighlightedNets).toHaveBeenLastCalledWith([{ name: `/amp/${itemType}`, netCode: 9 }])
    }
    expect(header(panel)).toEqual(['Layers', 'net', '/amp/zone'])
  })

  it('puts the net out on a click on what has none, the bare board included', () => {
    const { panel, element } = mounted()
    for (const nothing of [{ itemType: 'footprint', reference: 'C120' }, { itemType: '' }, { itemType: 'pad', reference: 'H1', net: '' }]) {
      select(element, { sourceContext: 'PCB', itemType: 'track', net: 'GND', netCode: 1 })
      select(element, { sourceContext: 'PCB', ...nothing })
      expect(element.setHighlightedNets).toHaveBeenLastCalledWith([])
      expect(header(panel)).toEqual(['Layers'])
    }
    // and when nothing is lit, it asks the viewer for nothing
    element.setHighlightedNets.mockClear()
    select(element, { sourceContext: 'PCB', itemType: '' })
    expect(element.setHighlightedNets).not.toHaveBeenCalled()
  })

  it('follows a net put out from outside (KicadView clears the board\'s selection)', () => {
    const { panel, element } = mounted()
    select(element, { sourceContext: 'PCB', itemType: 'via', net: 'GND', netCode: 1 })
    element.clearSelection()
    expect(header(panel)).toEqual(['Layers'])
  })

  it('lights the net again after the layers change, which the viewer does not repaint', () => {
    const { panel, element } = mounted()
    select(element, { sourceContext: 'PCB', itemType: 'track', net: '+5V', netCode: 14 })
    element.setHighlightedNets.mockClear()
    press(panel, 'data-eye', 'B.Cu')
    expect(element.setHighlightedNets).toHaveBeenCalledWith([{ name: '+5V', netCode: 14 }])
    element.setHighlightedNets.mockClear()
    pressName(panel, 'F.Cu')
    press(panel, 'data-preset', 'back')
    expect(element.setHighlightedNets).toHaveBeenCalledTimes(2)
    // the zone fills are no layer: nothing to light again
    element.setHighlightedNets.mockClear()
    collect(panel.render(), (el) => (el.props.type === 'range' ? el : undefined))[0].props.onChange({ target: { value: '0.3' } })
    expect(element.setHighlightedNets).not.toHaveBeenCalled()
  })

  it('stops listening once unmounted, and moves to an element it is handed instead', () => {
    const { panel, element } = mounted()
    const other = boardElement()
    panel.props = { element: other, active: true }
    panel.componentDidUpdate({ element, active: true })
    expect(other.setPcbObjectOpacity).toHaveBeenCalledWith('zones', ZONE_OPACITY)
    select(element, { sourceContext: 'PCB', itemType: 'track', net: 'GND', netCode: 1 })
    expect(element.setHighlightedNets).not.toHaveBeenCalled()
    select(other, { sourceContext: 'PCB', itemType: 'track', net: 'GND', netCode: 1 })
    expect(other.setHighlightedNets).toHaveBeenCalledTimes(1)

    panel.componentWillUnmount()
    select(other, { sourceContext: 'PCB', itemType: 'track', net: 'VBUS', netCode: 2 })
    expect(other.setHighlightedNets).toHaveBeenCalledTimes(1)
  })
})
