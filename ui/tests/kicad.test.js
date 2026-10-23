// A KiCad design as a document: its tabs, what each viewer is handed, and the
// link between the two.
//
// The viewer itself (static/_v/ecad-viewer.js) needs a GPU and is checked in a
// browser; here its two elements are plain DOM elements carrying the two
// methods this component calls, and a double click is the event the viewer
// dispatches for one.

import { describe, expect, it, vi } from 'vitest'

import { docHint, documentBody } from '../src/DocumentView.jsx'
import KicadView, {
  CROSSPROBE_EVENT, crossProbeRequest, designFiles, designSources, kicadTabs, PCB, SCH,
} from '../src/KicadView.jsx'
import { collect, texts } from './eltree.js'

const BASE = '/project/kicad0001/abc123/'

const design = (pcb = 'hw/board.kicad_pcb') => ({
  id: 'hw__board.kicad_pro', name: 'hw/board.kicad_pro', type: 'kicad',
  file: 'hw/board.kicad_pro', bytes: 4_612_345,
  kicad: { schematics: ['hw/board.kicad_sch', 'hw/sub/power.kicad_sch'], pcb },
})

const ofType = (tree, type) => collect(tree, (el) => (el.type === type ? el : undefined))

/** A view with its two elements attached, as React would attach them. */
function mounted(doc = design()) {
  const view = new KicadView({ doc, base: BASE })
  view.setState = (patch, done) => {
    Object.assign(view.state, patch)
    if (done) done()
  }
  const elements = {}
  for (const context of kicadTabs(doc)) {
    const element = document.createElement('ecad-viewer')
    element.requestCrossProbe = vi.fn(() => true)
    element.setActive = vi.fn()
    view.refCallbacks[context](element)
    elements[context] = element
  }
  return { view, elements }
}

const doubleClick = (element, detail) => element.dispatchEvent(new CustomEvent(CROSSPROBE_EVENT, { detail }))

describe('a KiCad design', () => {
  it('is labelled with its sheets and size, and drawn by its own view', () => {
    expect(docHint(design())).toBe('kicad · 2 sheets · 4.6 MB')
    const flat = { ...design(), kicad: { schematics: ['hw/board.kicad_sch'], pcb: null } }
    expect(docHint(flat)).toBe('kicad · 1 sheet · 4.6 MB')
    const [view] = collect(documentBody(design(), BASE, null, ''), (el) => (el.type === KicadView ? el : undefined))
    expect(view.props).toEqual({ doc: design(), base: BASE })
  })

  it('has a PCB tab only when it has a board', () => {
    expect(kicadTabs(design())).toEqual([SCH, PCB])
    expect(kicadTabs(design(null))).toEqual([SCH])
    const { view } = mounted()
    expect(ofType(view.render(), 'button').map((b) => texts(b).join(''))).toEqual(['Schematic', 'PCB'])
    expect(ofType(new KicadView({ doc: design(null), base: BASE }).render(), 'button')).toHaveLength(1)
  })

  it('keeps both viewers mounted and hides the other one without collapsing it', () => {
    const { view } = mounted()
    const viewers = ofType(view.render(), 'ecad-viewer')
    expect(viewers.map((v) => [v.props['source-mode'], v.props['show-header'], v.props['hide-chrome']]))
      .toEqual([['host', 'false', 'true'], ['host', 'false', 'true']])
    expect(viewers.map((v) => v.props.style.visibility)).toEqual(['visible', 'hidden'])
    expect(viewers.map((v) => v.props.style.height)).toEqual(['100%', '100%'])
    view.state.tab = PCB
    expect(ofType(view.render(), 'ecad-viewer').map((v) => v.props.style.visibility))
      .toEqual(['hidden', 'visible'])
  })

  it('tells each viewer whether it is the one on screen', () => {
    const { view, elements } = mounted()
    view.state.tab = PCB
    view.activate()
    expect(elements[SCH].setActive).toHaveBeenLastCalledWith(false)
    expect(elements[PCB].setActive).toHaveBeenLastCalledWith(true)
  })

  it('hands each viewer its files under their paths, the project first', () => {
    const doc = design()
    expect(designFiles(doc)).toEqual(['hw/board.kicad_pro', 'hw/board.kicad_sch',
      'hw/sub/power.kicad_sch', 'hw/board.kicad_pcb'])
    const sources = designSources(doc, Object.fromEntries(designFiles(doc).map((f) => [f, `<${f}>`])))
    expect(sources[SCH]).toEqual([
      { filename: 'hw/board.kicad_pro', content: '<hw/board.kicad_pro>' },
      { filename: 'hw/board.kicad_sch', content: '<hw/board.kicad_sch>' },
      { filename: 'hw/sub/power.kicad_sch', content: '<hw/sub/power.kicad_sch>' }])
    expect(sources[PCB].map((s) => s.filename)).toEqual(['hw/board.kicad_pro', 'hw/board.kicad_pcb'])
    // a schematic goes with the pin entries the viewer draws pins from
    const bare = '(kicad_sch (lib_symbols (symbol "Device:R" (symbol "R_1_1" (pin passive line (number "1")))))'
      + ' (symbol (lib_id "Device:R") (uuid "r1")))'
    const handed = designSources(doc, { ...Object.fromEntries(designFiles(doc).map((f) => [f, f])), 'hw/sub/power.kicad_sch': bare })
    expect(handed[SCH][2].content).toMatch(/\(lib_id "Device:R"\) \(uuid "r1"\) \(pin "1" \(uuid "[0-9a-f-]{36}"\)\)\)\)$/)
  })
})

describe('the link between the schematic and the board', () => {
  it('asks for a part by its designator and a net by its name', () => {
    expect(crossProbeRequest({ itemType: 'symbol', reference: 'R104', uuid: 'u' }, PCB))
      .toEqual({ targetContext: PCB, kind: 'designator', value: 'R104' })
    // a pin asks for its part
    expect(crossProbeRequest({ itemType: 'pin', reference: 'U201', pin: '30' }, PCB))
      .toEqual({ targetContext: PCB, kind: 'designator', value: 'U201' })
    expect(crossProbeRequest({ itemType: 'net', net: '/VBUS', netCode: 3 }, SCH))
      .toEqual({ targetContext: SCH, kind: 'net', value: '/VBUS' })
    expect(crossProbeRequest({ itemType: 'wire' }, PCB)).toBeNull()
  })

  it('a double click on the schematic opens the board with that part selected', () => {
    const { view, elements } = mounted()
    doubleClick(elements[SCH], { sourceContext: SCH, itemType: 'symbol', reference: 'C523' })
    expect(view.state.tab).toBe(PCB)
    expect(elements[PCB].requestCrossProbe).toHaveBeenCalledWith(
      { targetContext: PCB, kind: 'designator', value: 'C523' })
    expect(elements[SCH].requestCrossProbe).not.toHaveBeenCalled()
  })

  it('a double click on a track opens the schematic with its net selected', () => {
    const { view, elements } = mounted()
    view.state.tab = PCB
    doubleClick(elements[PCB], { sourceContext: PCB, itemType: 'net', net: 'GND' })
    expect(view.state.tab).toBe(SCH)
    expect(elements[SCH].requestCrossProbe).toHaveBeenCalledWith(
      { targetContext: SCH, kind: 'net', value: 'GND' })
  })

  it('does nothing without a board, or once an element is detached', () => {
    const lone = mounted(design(null))
    doubleClick(lone.elements[SCH], { reference: 'R1' })
    expect(lone.view.state.tab).toBe(SCH)

    const { view, elements } = mounted()
    view.refCallbacks[SCH](null)
    doubleClick(elements[SCH], { reference: 'R1' })
    expect(elements[PCB].requestCrossProbe).not.toHaveBeenCalled()
  })
})
