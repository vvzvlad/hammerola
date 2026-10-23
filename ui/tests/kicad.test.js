// A KiCad design as a document: the side on screen, what each viewer is
// handed, and the link between the two.
//
// Which side is on screen, the schematic or the board, is the page's: two rows
// of its list of views (viewlist.jsx), handed down as `side`. A double click
// that crosses to the other side asks the page for it (`onSide`) and selects
// there once the page has answered.
//
// The viewer itself (static/_v/ecad-viewer.js) needs a GPU and is checked in a
// browser; here its two elements are plain DOM elements carrying the two
// methods this component calls, and a double click is the event the viewer
// dispatches for one.

import { describe, expect, it, vi } from 'vitest'

import { documentBody } from '../src/DocumentView.jsx'
import { documentRows } from '../src/viewlist.jsx'
import KicadView, {
  CROSSPROBE_EVENT, crossProbeRequest, designFiles, designSources, kicadSides, PCB, SCH,
} from '../src/KicadView.jsx'
import { collect, texts } from './eltree.js'

const BASE = '/project/kicad0001/abc123/'

const design = (pcb = 'hw/board.kicad_pcb') => ({
  id: 'hw__board.kicad_pro', name: 'hw/board.kicad_pro', type: 'kicad',
  file: 'hw/board.kicad_pro', bytes: 4_612_345,
  kicad: { schematics: ['hw/board.kicad_sch', 'hw/sub/power.kicad_sch'], pcb },
})

const ofType = (tree, type) => collect(tree, (el) => (el.type === type ? el : undefined))

/** A view with its two elements attached, as React would attach them, under a
 *  page that answers `onSide` by handing the side down, as both pages do. */
function mounted(doc = design(), side = SCH) {
  const onSide = vi.fn((next) => {
    const before = view.props
    view.props = { ...before, side: next }
    view.componentDidUpdate(before)
  })
  const view = new KicadView({ doc, base: BASE, side, onSide })
  view.setState = (patch, done) => {
    Object.assign(view.state, patch)
    if (done) done()
  }
  const elements = {}
  for (const context of kicadSides(doc)) {
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
  it('has a row per side hinted with its sheets and its board, and is drawn by its own view', () => {
    expect(documentRows([design()], null, null, () => {}).map((row) => [row.label, row.hint])).toEqual([
      ['hw/board.kicad_pro · Schematic', '2 sheets'], ['hw/board.kicad_pro · PCB', 'board']])
    const [view] = collect(documentBody(design(), BASE, null, ''), (el) => (el.type === KicadView ? el : undefined))
    expect(view.props).toMatchObject({ doc: design(), base: BASE })
    // the side the page holds, and its door for changing it
    const onSide = () => {}
    const [handed] = collect(documentBody(design(), BASE, null, '', PCB, onSide),
      (el) => (el.type === KicadView ? el : undefined))
    expect(handed.props).toMatchObject({ side: PCB, onSide })
  })

  it('draws no tabs of its own: the side on screen is the one it is handed', () => {
    expect(kicadSides(design())).toEqual([SCH, PCB])
    expect(kicadSides(design(null))).toEqual([SCH])
    const { view } = mounted(design(), PCB)
    const tree = view.render()
    expect(ofType(tree, 'button')).toEqual([])
    expect(texts(tree)).not.toContain('Schematic')
    expect(ofType(tree, 'ecad-viewer').map((v) => v.props.style.visibility)).toEqual(['hidden', 'visible'])
    // a board asked of a design without one shows the schematic
    const flat = new KicadView({ doc: design(null), base: BASE, side: PCB })
    expect(ofType(flat.render(), 'ecad-viewer').map((v) => v.props.style.visibility)).toEqual(['visible'])
  })

  it('keeps both viewers mounted and hides the other one without collapsing it', () => {
    const { view } = mounted()
    const viewers = ofType(view.render(), 'ecad-viewer')
    expect(viewers.map((v) => [v.props['source-mode'], v.props['show-header'], v.props['hide-chrome']]))
      .toEqual([['host', 'false', 'true'], ['host', 'false', 'true']])
    expect(viewers.map((v) => v.props.style.visibility)).toEqual(['visible', 'hidden'])
    expect(viewers.map((v) => v.props.style.height)).toEqual(['100%', '100%'])
  })

  it('tells each viewer whether it is the one on screen', () => {
    const { view, elements } = mounted(design(), PCB)
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

  it('a double click on the schematic asks the page for the board, then selects the part there', () => {
    const { view, elements } = mounted()
    doubleClick(elements[SCH], { sourceContext: SCH, itemType: 'symbol', reference: 'C523' })
    expect(view.props.onSide).toHaveBeenCalledWith(PCB)
    // selected once the board is the side on screen, not before
    expect(elements[PCB].setActive).toHaveBeenLastCalledWith(true)
    expect(elements[PCB].requestCrossProbe).toHaveBeenCalledWith(
      { targetContext: PCB, kind: 'designator', value: 'C523' })
    expect(elements[SCH].requestCrossProbe).not.toHaveBeenCalled()
  })

  it('a double click on a track asks for the schematic, and selects its net there', () => {
    const { view, elements } = mounted(design(), PCB)
    doubleClick(elements[PCB], { sourceContext: PCB, itemType: 'net', net: 'GND' })
    expect(view.props.onSide).toHaveBeenCalledWith(SCH)
    expect(elements[SCH].requestCrossProbe).toHaveBeenCalledWith(
      { targetContext: SCH, kind: 'net', value: 'GND' })
  })

  it('selects nothing while the page has not moved to the other side', () => {
    const view = new KicadView({ doc: design(), base: BASE, side: SCH, onSide: vi.fn() })
    view.setState = (patch, done) => {
      Object.assign(view.state, patch)
      if (done) done()
    }
    const elements = {}
    for (const context of [SCH, PCB]) {
      elements[context] = document.createElement('ecad-viewer')
      elements[context].requestCrossProbe = vi.fn(() => true)
      elements[context].setActive = vi.fn()
      view.refCallbacks[context](elements[context])
    }
    doubleClick(elements[SCH], { reference: 'R1' })
    view.componentDidUpdate(view.props)
    expect(elements[PCB].requestCrossProbe).not.toHaveBeenCalled()
  })

  it('does nothing without a board, or once an element is detached', () => {
    const lone = mounted(design(null))
    doubleClick(lone.elements[SCH], { reference: 'R1' })
    expect(lone.view.props.onSide).not.toHaveBeenCalled()

    const { view, elements } = mounted()
    view.refCallbacks[SCH](null)
    doubleClick(elements[SCH], { reference: 'R1' })
    expect(view.props.onSide).not.toHaveBeenCalled()
    expect(elements[PCB].requestCrossProbe).not.toHaveBeenCalled()
  })
})
