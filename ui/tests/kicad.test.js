// KiCad documents: a schematic, a board and a board's 3D model are each a
// document of their own, grouped into a design by their path minus the
// extension; what each viewer is handed; and the links between them.
//
// Which member is on screen is the page's: a row each in its list of views
// (viewlist.jsx), handed down as `doc`. A click that selects a part selects it
// in the other views too, without asking the page for anything; a double click
// that crosses to another member asks the page to open it (`onOpen`, with its
// id) and selects there once the page has answered.
//
// The viewers themselves (static/_v/ecad-viewer.js, BoardView3D.jsx) need a GPU
// and are checked in a browser; here the two elements are plain DOM elements
// carrying the methods this component calls, a click or a double click is the
// event the viewer dispatches for one, and the 3D view is a stand-in whose
// props are read off the drawn tree.

import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/BoardView3D.jsx', () => ({ default: function BoardView3D() { return null } }))

import BoardView3D from '../src/BoardView3D.jsx'
import { docHint, documentBody, docViewKey } from '../src/DocumentView.jsx'
import PcbPanel from '../src/PcbPanel.jsx'
import { documentRows } from '../src/viewlist.jsx'
import KicadView, {
  BOARD3D, CROSSPROBE_EVENT, crossProbeRequest, designFiles, designKey, designMembers,
  designSources, drawnViews, jumpTarget, PCB, SCH, SELECTION_EVENT,
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
 *  page that answers `onOpen` by handing that document down, as both pages do.
 *  `viewer` false: plain elements, as when the viewer's module did not load. */
function mounted(doc = DOCS[0], documents = DOCS, viewer = true) {
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
    if (viewer) {
      element.requestCrossProbe = vi.fn(() => true)
      element.setActive = vi.fn()
      element.clearSelection = vi.fn()
    }
    view.refCallbacks[context](element)
    elements[context] = element
  }
  return { view, elements }
}

const doubleClick = (element, detail) => element.dispatchEvent(new CustomEvent(CROSSPROBE_EVENT, { detail }))
const click = (element, detail) => element.dispatchEvent(new CustomEvent(SELECTION_EVENT, { detail }))

/** The 3D view as drawn: its props, and the box that shows or hides it. */
const view3d = (view) => {
  const tree = view.render()
  const [box] = collect(tree, (el) => (el.props['data-view'] === BOARD3D ? el : undefined))
  return { box, three: box && ofType(box, BoardView3D)[0] }
}
const designator = (context, value) => ({ targetContext: context, kind: 'designator', value })

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

  it('keeps the 3D model mounted as a third view, drawing only while it is on screen', () => {
    const { view } = mounted(DOCS[1])
    let { box, three } = view3d(view)
    expect([box.props.style.visibility, box.props.style.height]).toEqual(['hidden', '100%'])
    expect(three.props).toMatchObject({ url: `${BASE}hw/board.glb`, active: false, selected: null })

    view.props = { ...view.props, doc: DOCS[2] }
    ;({ box, three } = view3d(view))
    expect(box.props.style.visibility).toBe('visible')
    expect(three.props.active).toBe(true)
    const tree = view.render()
    expect(ofType(tree, 'ecad-viewer').map((v) => v.props.style.visibility)).toEqual(['hidden', 'hidden'])
    // the 2D views still loading say so over themselves only
    expect(view.state.ready).toBe(false)
    expect(texts(tree)).toEqual([])
  })

  it('draws a 3D model with no sibling alone, and no 3D view where none is listed', () => {
    const lone = new KicadView({ doc: model3d('case/lid view.glb'), documents: DOCS, base: BASE })
    expect(ofType(lone.render(), 'ecad-viewer')).toEqual([])
    expect(view3d(lone).three.props).toMatchObject({ url: `${BASE}case/lid%20view.glb`, active: true })
    expect(view3d(new KicadView({ doc: DOCS[4], documents: DOCS, base: BASE })).box).toBeUndefined()
  })

  it('draws its panel over the board once the files are in, shown with the board', () => {
    const { view, elements } = mounted(DOCS[1])
    const panel = () => ofType(view.render(), PcbPanel)[0]
    expect(panel()).toBeUndefined()
    view.setState({ ready: true })
    expect(panel().props).toEqual({ element: elements[PCB], active: true })
    view.props = { ...view.props, doc: DOCS[0] }
    expect(panel().props.active).toBe(false)
    view.setState({ error: 'hw/board.kicad_pcb did not load: HTTP 404' })
    expect(panel()).toBeUndefined()
    // no board in the design, no panel
    const alone = mounted(schematic(), [schematic(), pdf])
    alone.view.setState({ ready: true })
    expect(ofType(alone.view.render(), PcbPanel)).toEqual([])
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

describe('where a double click jumps', () => {
  it('schematic and board to each other, the 3D model to the board else the schematic, never to 3D', () => {
    const jumps = {}
    for (const listed of [[SCH], [PCB], [BOARD3D], [SCH, PCB], [SCH, BOARD3D], [PCB, BOARD3D], [SCH, PCB, BOARD3D]]) {
      const members = Object.fromEntries(listed.map((view) => [view, {}]))
      for (const from of listed) jumps[`${listed} ${from}`] = jumpTarget(from, members)
    }
    expect(jumps).toEqual({
      'SCH SCH': null, 'PCB PCB': null, '3D 3D': null,
      'SCH,PCB SCH': PCB, 'SCH,PCB PCB': SCH,
      'SCH,3D SCH': null, 'SCH,3D 3D': SCH,
      'PCB,3D PCB': null, 'PCB,3D 3D': PCB,
      'SCH,PCB,3D SCH': PCB, 'SCH,PCB,3D PCB': SCH, 'SCH,PCB,3D 3D': PCB,
    })
  })
})

describe('a click selects the same part in every view', () => {
  it('from the schematic or the board: the others select it, nothing on screen changes', () => {
    const { view, elements } = mounted()
    click(elements[SCH], { sourceContext: SCH, itemType: 'symbol', reference: 'C523', uuid: 'u' })
    expect(elements[PCB].requestCrossProbe).toHaveBeenCalledWith(designator(PCB, 'C523'))
    expect(elements[SCH].requestCrossProbe).not.toHaveBeenCalled()
    expect(view3d(view).three.props.selected).toBe('C523')
    // a pad on the board stands for its part
    click(elements[PCB], { sourceContext: PCB, itemType: 'pad', reference: 'R104', pin: '1', net: 'GND' })
    expect(elements[SCH].requestCrossProbe).toHaveBeenCalledWith(designator(SCH, 'R104'))
    expect(view3d(view).three.props.selected).toBe('R104')
    expect(view.props.onOpen).not.toHaveBeenCalled()
    expect(view.props.doc.id).toBe('hw__board.kicad_sch')
  })

  it('a click on what is no part puts the part out in the others', () => {
    const { view, elements } = mounted()
    click(elements[PCB], { sourceContext: PCB, itemType: 'footprint', reference: 'U501' })
    click(elements[PCB], { sourceContext: PCB, itemType: 'track', net: 'GND' })
    expect(elements[SCH].clearSelection).toHaveBeenCalledTimes(1)
    expect(elements[PCB].clearSelection).not.toHaveBeenCalled()
    expect(view3d(view).three.props.selected).toBeNull()
  })

  it('a view without the part puts out what it had selected', () => {
    const { view, elements } = mounted()
    // a power symbol has no footprint: the board answers false
    elements[PCB].requestCrossProbe.mockReturnValue(false)
    click(elements[SCH], { sourceContext: SCH, itemType: 'symbol', reference: '#PWR0101' })
    expect(elements[PCB].requestCrossProbe).toHaveBeenCalledWith(designator(PCB, '#PWR0101'))
    expect(elements[PCB].clearSelection).toHaveBeenCalledTimes(1)
    expect(view3d(view).three.props.selected).toBe('#PWR0101')
    // a part it has stays selected
    elements[PCB].requestCrossProbe.mockReturnValue(true)
    click(elements[SCH], { sourceContext: SCH, itemType: 'symbol', reference: 'C523' })
    expect(elements[PCB].clearSelection).toHaveBeenCalledTimes(1)
  })

  it('throws nothing at elements the viewer never defined (its module did not load)', () => {
    const { view } = mounted(DOCS[2], DOCS, false)
    const three = () => view3d(view).three.props
    expect(() => {
      three().onSelect('L101')
      three().onSelect(null)
      three().onJump('L101')
    }).not.toThrow()
    expect(view.props.onOpen).toHaveBeenCalledWith('hw__board.kicad_pcb')
  })

  it('from the 3D model: both drawings select it, and a click on the bare board puts it out', () => {
    const { view, elements } = mounted(DOCS[2])
    view3d(view).three.props.onSelect('L101')
    expect(elements[SCH].requestCrossProbe).toHaveBeenCalledWith(designator(SCH, 'L101'))
    expect(elements[PCB].requestCrossProbe).toHaveBeenCalledWith(designator(PCB, 'L101'))
    expect(view3d(view).three.props.selected).toBe('L101')
    view3d(view).three.props.onSelect(null)
    expect([elements[SCH].clearSelection, elements[PCB].clearSelection].map((f) => f.mock.calls.length)).toEqual([1, 1])
    expect(view.props.onOpen).not.toHaveBeenCalled()
  })

  it('a double click on the 3D model opens the board, else the schematic, and selects the part there', () => {
    const { view, elements } = mounted(DOCS[2])
    view3d(view).three.props.onJump('L101')
    expect(view.props.onOpen).toHaveBeenCalledWith('hw__board.kicad_pcb')
    expect(elements[PCB].requestCrossProbe).toHaveBeenLastCalledWith(designator(PCB, 'L101'))
    expect(view3d(view).three.props.active).toBe(false)

    const docs = [schematic(), model3d()]
    const bare = mounted(docs[1], docs)
    view3d(bare.view).three.props.onJump('U501')
    expect(bare.view.props.onOpen).toHaveBeenCalledWith('hw__board.kicad_sch')
    expect(bare.elements[SCH].requestCrossProbe).toHaveBeenCalledWith(designator(SCH, 'U501'))
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

describe('the selected part\'s datasheet', () => {
  const tpa = { id: 'hw__ds__tpa3250.pdf', name: 'TPA3250', type: 'pdf', file: 'hw/ds/tpa3250.pdf', bytes: 9, hidden: true }
  const docs = [...DOCS, tpa]
  /** The design with its parts' `Datasheet` values read, `doc` on screen. */
  const withSheets = (doc = docs[0]) => {
    const one = mounted(doc, docs)
    one.view.setState({ ready: true, datasheets: new Map([
      ['U501', '${KIPRJMOD}/ds/tpa3250.pdf'], ['U502', 'https://www.ti.com/lit/ds/tpa3250.pdf'], ['C1', '../ds/ne555.pdf']]) })
    return one
  }
  const chipOf = (view) => collect(view.render(), (el) => (el.props['data-datasheet'] ? el : undefined))[0]
  const onScreen = (view, doc) => {
    view.props = { ...view.props, doc }
    return chipOf(view)
  }

  it('is one chip at the bottom left of every view, naming the document, wherever the part was selected', () => {
    const { view, elements } = withSheets()
    expect(chipOf(view)).toBeUndefined()
    const selections = [
      () => click(elements[SCH], { sourceContext: SCH, itemType: 'symbol', reference: 'U501' }),
      () => click(elements[PCB], { sourceContext: PCB, itemType: 'pad', reference: 'U501', pin: '3', net: 'GND' }),
      () => view3d(view).three.props.onSelect('U501'),
    ]
    for (const select of selections) {
      view.setState({ selected: null })
      select()
      for (const doc of docs.slice(0, 3)) {
        const chip = onScreen(view, doc)
        expect(chip.props['data-datasheet']).toBe(tpa.id)
        expect(texts(chip)).toEqual(['Datasheet · TPA3250'])
        expect(chip.props.style).toMatchObject({ position: 'absolute', left: '10px', bottom: '10px',
          display: 'flex', background: 'var(--float-bg)', color: 'var(--text)', cursor: 'pointer' })
        // beside the board's panel (200px, 10px in from the right) it stops short of it
        expect(chip.props.style.maxWidth).toBe(doc.type === 'board' ? 'calc(100% - 230px)' : 'calc(100% - 20px)')
      }
    }
  })

  it('opens the document as a row does, and goes with a click on nothing or a part with no link', () => {
    const { view, elements } = withSheets(docs[1])
    click(elements[PCB], { sourceContext: PCB, itemType: 'footprint', reference: 'U501' })
    chipOf(view).props.onClick()
    expect(view.props.onOpen).toHaveBeenCalledWith(tpa.id)
    expect(view.props.doc).toBe(tpa)

    const after = withSheets()
    const pick = (reference) => {
      click(after.elements[SCH], { sourceContext: SCH, itemType: reference ? 'symbol' : 'wire', reference })
      const chip = chipOf(after.view)
      return chip ? texts(chip)[0] : null
    }
    expect(['U501', undefined, 'U502', 'R104', 'C1'].map(pick))
      .toEqual(['Datasheet · TPA3250', null, null, null, 'Datasheet · ds/ne555.pdf'])
    expect(after.view.props.onOpen).not.toHaveBeenCalled()
  })
})
