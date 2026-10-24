// KiCad documents: a schematic, a board and a board's 3D model are each a
// document of their own, grouped into a design by their path minus the
// extension; what each viewer is handed; and the link between the two.
//
// Which member is on screen is the page's: a row each in its list of views
// (viewlist.jsx), handed down as `doc`. A double click that crosses to the
// other member asks the page to open it (`onOpen`, with its id) and selects
// there once the page has answered.
//
// The viewer itself (static/_v/ecad-viewer.js) needs a GPU and is checked in a
// browser; here its two elements are plain DOM elements carrying the two
// methods this component calls, and a double click is the event the viewer
// dispatches for one.

import { describe, expect, it, vi } from 'vitest'

import { docHint, documentBody, docViewKey } from '../src/DocumentView.jsx'
import { documentRows } from '../src/viewlist.jsx'
import KicadView, {
  BOARD3D, BOARD3D_NOTE, CROSSPROBE_EVENT, crossProbeRequest, designFiles, designKey, designMembers,
  designSources, drawnViews, PCB, SCH,
} from '../src/KicadView.jsx'
import { collect, texts } from './eltree.js'

const BASE = '/project/kicad0001/abc123/'

const schematic = (file = 'hw/board.kicad_sch', project = 'hw/board.kicad_pro', name = file) => ({
  id: file.replaceAll('/', '__'), name, type: 'schematic', file, bytes: 4_612_345,
  kicad: { schematics: [file, 'hw/sub/power.kicad_sch'], project },
})
const board = (file = 'hw/board.kicad_pcb', project = 'hw/board.kicad_pro', name = file) => ({
  id: file.replaceAll('/', '__'), name, type: 'board', file, bytes: 812_000, kicad: { project },
})
const model3d = (file = 'hw/board.glb') => ({
  id: file.replaceAll('/', '__'), name: file, type: 'board3d', file, bytes: 2_000_000,
})
const pdf = { id: 'ds__ne555.pdf', name: 'ds/ne555.pdf', type: 'pdf', file: 'ds/ne555.pdf', bytes: 9 }

// One design of three members, a datasheet and a second design of one.
const DOCS = [schematic(), board(), model3d(), pdf, board('psu/psu.kicad_pcb', null)]

const ofType = (tree, type) => collect(tree, (el) => (el.type === type ? el : undefined))

/** A view with its elements attached, as React would attach them, under a
 *  page that answers `onOpen` by handing that document down, as both pages do. */
function mounted(doc = DOCS[0], documents = DOCS) {
  const onOpen = vi.fn((id) => {
    const before = view.props
    view.props = { ...before, doc: documents.find((one) => one.id === id) }
    view.componentDidUpdate(before)
  })
  const view = new KicadView({ doc, documents, base: BASE, onOpen })
  view.setState = (patch, done) => {
    Object.assign(view.state, patch)
    if (done) done()
  }
  const elements = {}
  for (const context of drawnViews(view.members())) {
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
  it('is its listed members with one path minus the extension, each a row of its own', () => {
    expect(DOCS.map(designKey)).toEqual(['hw/board', 'hw/board', 'hw/board', null, 'psu/psu'])
    const members = designMembers(DOCS, DOCS[1])
    expect(Object.fromEntries(Object.entries(members).map(([view, doc]) => [view, doc.id]))).toEqual({
      [SCH]: 'hw__board.kicad_sch', [PCB]: 'hw__board.kicad_pcb', [BOARD3D]: 'hw__board.glb' })
    // a design of one: the other design's board has no sibling
    expect(Object.keys(designMembers(DOCS, DOCS[4]))).toEqual([PCB])
    // a row per document, the hint saying what each member is
    expect(documentRows(DOCS, null, () => {}).map((row) => [row.label, row.hint])).toEqual([
      ['hw/board.kicad_sch', '2 sheets'], ['hw/board.kicad_pcb', 'board'], ['hw/board.glb', '3D'],
      ['ds/ne555.pdf', 'pdf · 0.0 kB'], ['psu/psu.kicad_pcb', 'board']])
    expect(docHint({ ...schematic(), kicad: { schematics: ['a.kicad_sch'], project: null } })).toBe('1 sheet')
  })

  it('is keyed by its design on the page, so moving between its members keeps one view', () => {
    expect(new Set(DOCS.slice(0, 3).map(docViewKey))).toEqual(new Set(['design/hw/board']))
    expect(docViewKey(DOCS[4])).toBe('design/psu/psu')
    expect(docViewKey(pdf)).toBe(pdf.id)
  })

  it('draws each member with its own view, handed the build\'s documents and the page\'s door', () => {
    const onOpen = () => {}
    for (const doc of DOCS.slice(0, 3)) {
      const [view] = collect(documentBody(doc, BASE, null, '', DOCS, onOpen),
        (el) => (el.type === KicadView ? el : undefined))
      expect(view.props).toMatchObject({ doc, documents: DOCS, base: BASE, onOpen })
    }
    expect(ofType(documentBody(pdf, BASE, null, '', DOCS, onOpen), 'iframe')).toHaveLength(1)
  })

  it('keeps both viewers mounted, shows the open member\'s and hides the other without collapsing it', () => {
    const { view } = mounted(DOCS[1])
    const tree = view.render()
    expect(ofType(tree, 'button')).toEqual([])
    const viewers = ofType(tree, 'ecad-viewer')
    expect(viewers.map((v) => [v.props['data-view'], v.props['source-mode'], v.props['show-header'], v.props['hide-chrome']]))
      .toEqual([[SCH, 'host', 'false', 'true'], [PCB, 'host', 'false', 'true']])
    expect(viewers.map((v) => v.props.style.visibility)).toEqual(['hidden', 'visible'])
    expect(viewers.map((v) => v.props.style.height)).toEqual(['100%', '100%'])
  })

  it('draws a member with no sibling alone', () => {
    const lone = new KicadView({ doc: DOCS[4], documents: DOCS, base: BASE })
    expect(ofType(lone.render(), 'ecad-viewer').map((v) => [v.props['data-view'], v.props.style.visibility]))
      .toEqual([[PCB, 'visible']])
  })

  it('shows a note for the board\'s 3D model over both viewers, hidden', () => {
    const { view } = mounted(DOCS[2])
    const tree = view.render()
    expect(ofType(tree, 'ecad-viewer').map((v) => v.props.style.visibility)).toEqual(['hidden', 'hidden'])
    expect(texts(tree)).toEqual([BOARD3D_NOTE])
  })

  it('tells each viewer whether it is the one on screen', () => {
    const { view, elements } = mounted(DOCS[1])
    view.activate()
    expect(elements[SCH].setActive).toHaveBeenLastCalledWith(false)
    expect(elements[PCB].setActive).toHaveBeenLastCalledWith(true)
  })

  it('hands each viewer its files under their paths, the project first where there is one', () => {
    const members = designMembers(DOCS, DOCS[0])
    expect(designFiles(members)).toEqual(['hw/board.kicad_pro', 'hw/board.kicad_sch',
      'hw/sub/power.kicad_sch', 'hw/board.kicad_pcb'])
    const sources = designSources(members, Object.fromEntries(designFiles(members).map((f) => [f, `<${f}>`])))
    expect(sources[SCH]).toEqual([
      { filename: 'hw/board.kicad_pro', content: '<hw/board.kicad_pro>' },
      { filename: 'hw/board.kicad_sch', content: '<hw/board.kicad_sch>' },
      { filename: 'hw/sub/power.kicad_sch', content: '<hw/sub/power.kicad_sch>' }])
    expect(sources[PCB].map((s) => s.filename)).toEqual(['hw/board.kicad_pro', 'hw/board.kicad_pcb'])
    // no project: each viewer gets its own files alone
    expect(designFiles(designMembers(DOCS, DOCS[4]))).toEqual(['psu/psu.kicad_pcb'])
    // a schematic goes with the pin entries the viewer draws pins from
    const bare = '(kicad_sch (lib_symbols (symbol "Device:R" (symbol "R_1_1" (pin passive line (number "1")))))'
      + ' (symbol (lib_id "Device:R") (uuid "r1")))'
    const handed = designSources(members, { ...Object.fromEntries(designFiles(members).map((f) => [f, f])), 'hw/sub/power.kicad_sch': bare })
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

  it('a double click on the schematic asks the page to open the board, then selects the part there', () => {
    const { view, elements } = mounted()
    doubleClick(elements[SCH], { sourceContext: SCH, itemType: 'symbol', reference: 'C523' })
    expect(view.props.onOpen).toHaveBeenCalledWith('hw__board.kicad_pcb')
    // selected once the board is the member on screen, not before
    expect(view.props.doc.id).toBe('hw__board.kicad_pcb')
    expect(elements[PCB].setActive).toHaveBeenLastCalledWith(true)
    expect(elements[PCB].requestCrossProbe).toHaveBeenCalledWith(
      { targetContext: PCB, kind: 'designator', value: 'C523' })
    expect(elements[SCH].requestCrossProbe).not.toHaveBeenCalled()
  })

  it('a double click on a track asks for the schematic, and selects its net there', () => {
    const { view, elements } = mounted(DOCS[1])
    doubleClick(elements[PCB], { sourceContext: PCB, itemType: 'net', net: 'GND' })
    expect(view.props.onOpen).toHaveBeenCalledWith('hw__board.kicad_sch')
    expect(elements[SCH].requestCrossProbe).toHaveBeenCalledWith(
      { targetContext: SCH, kind: 'net', value: 'GND' })
  })

  it('selects nothing while the page has not opened the other member', () => {
    const view = new KicadView({ doc: DOCS[0], documents: DOCS, base: BASE, onOpen: vi.fn() })
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

  it('does nothing without a sibling, or once an element is detached', () => {
    const lone = mounted(schematic(), [schematic(), pdf])
    expect(drawnViews(lone.view.members())).toEqual([SCH])
    doubleClick(lone.elements[SCH], { reference: 'R1' })
    expect(lone.view.props.onOpen).not.toHaveBeenCalled()

    const { view, elements } = mounted()
    view.refCallbacks[SCH](null)
    doubleClick(elements[SCH], { reference: 'R1' })
    expect(view.props.onOpen).not.toHaveBeenCalled()
    expect(elements[PCB].requestCrossProbe).not.toHaveBeenCalled()
  })
})
