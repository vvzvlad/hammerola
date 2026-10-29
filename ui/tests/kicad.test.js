// KiCad documents: a schematic, a board and a board's 3D model are each a
// document of their own, grouped into a design by their path minus the
// extension; what each viewer is handed; and the links between them.
//
// Which member is on screen is the page's: a row each in its list of views
// (viewlist.jsx), handed down as `doc`. A click that selects a part selects it
// in the other views too, without asking the page for anything; a click on
// nothing puts out everything. A click on a part or a net opens one menu of
// rows, which ‹ › and a click on a row step through: a row of another member
// asks the page to open it (`onOpen`, with its id) and selects there once the
// page has answered, a row of the view on screen asks its element at once, and
// a part's datasheet opens in a window over the design, asking the page for
// nothing. The menu stays open over every member a step brings.
//
// The viewers themselves (static/_v/ecad-viewer.js, BoardView3D.jsx) need a GPU
// and are checked in a browser; here the two elements are plain DOM elements
// carrying the methods this component calls, a click is the event the viewer
// dispatches for one, and each holds a canvas and answers `selectAt` with what
// the test put under the pointer (`element.under`), as the viewer's own click
// does. The 3D view is a stand-in whose props are read off the drawn tree.

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

vi.mock('../src/BoardView3D.jsx', () => ({ default: function BoardView3D() { return null } }))
// The viewer's module, imported by its address on the hub: a module of nothing
// here, the elements below carrying what it would define.
vi.mock('/_v/ecad-viewer.js', () => ({}))

import { navigate, parse, respell } from '../src/address.js'
import BoardView3D from '../src/BoardView3D.jsx'
import BomView from '../src/BomView.jsx'
import DocumentView, { docHint, DocumentLayers, documentBody, docViewKey } from '../src/DocumentView.jsx'
import PcbPanel from '../src/PcbPanel.jsx'
import { documentRows } from '../src/viewlist.jsx'
import KicadView, {
  AREA_EVENT, BOARD3D, BOM, crossProbeRequest, designFiles, designKey, designMembers, designSources, DRAFT_MARK,
  drawingOf, drawnViews, MARKER_EVENT, menuFor, menuHeight, menuPlace, PAGE_EVENT, PAN_SLOP, PCB, SCH,
  SELECTION_EVENT, SHEET_LOADED_EVENT,
} from '../src/KicadView.jsx'
import { loadMeta } from '../src/hub.js'
import { bomRows, withBoms } from '../src/kicadbom.js'
import { netIndex } from '../src/kicadnets.js'
import { collect, texts } from './eltree.js'
import { guardSubscribers } from './addressguard.js'

guardSubscribers()

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

/** The view area, where the page puts it. */
const AREA = { left: 0, top: 50, width: 800, height: 600 }

/** A view with its elements attached, as React would attach them, under a
 *  page that answers `onOpen` by handing that document down and `onSheet` by
 *  writing the sheet into the address, as both pages do. `viewer` false: plain
 *  elements, as when the viewer's module did not load. */
function mounted(doc = DOCS[0], documents = DOCS, viewer = true) {
  const onOpen = vi.fn((id) => {
    const before = view.props
    view.props = { ...before, doc: documents.find((one) => one.id === id) }
    view.componentDidUpdate(before)
  })
  const onSheet = (sheet, push) => navigate(respell(parse(), { sheet }), { push })
  const view = new KicadView({ doc, documents, base: BASE, onOpen, onSheet, onTools: vi.fn(), onReady: vi.fn() })
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
      element.replaceSources = vi.fn(async () => {})
    }
    // The canvas the viewer draws on, and the element's hit test: `selectAt`
    // reports what is under the point, as the viewer's own click does.
    // `picks` is the points it was asked for.
    const canvas = document.createElement('canvas')
    element.append(canvas)
    element.canvas = canvas
    element.picks = []
    element.selectAt = (x, y) => {
      element.picks.push([x, y])
      click(element, element.under)
    }
    view.refCallbacks[context](element)
    elements[context] = element
  }
  view.shell = { getBoundingClientRect: () => AREA }
  return { view, elements }
}

const click = (element, detail) => element.dispatchEvent(new CustomEvent(SELECTION_EVENT, { detail }))
/** A right press on a view's canvas and its release `moved` px further on, as
 *  the browser reports them, out of the viewer's shadow tree. */
function rightClick(element, x, y, moved = 0, button = 2) {
  const { canvas } = element
  const at = (type, dx) => new MouseEvent(type, { button, clientX: x + dx, clientY: y, bubbles: true, composed: true })
  canvas.dispatchEvent(at('pointerdown', 0))
  canvas.dispatchEvent(at('pointerup', moved))
}
/** The menu as drawn, its rows, their lines, its head (the active row's name,
 *  ‹, `n / N`, ›), and a press of its arrow `title` (`Previous`, `Next`). */
const menuOf = (view) => collect(view.render(), (el) => (el.props['data-menu'] ? el : undefined))[0]
const itemsOf = (view) => collect(menuOf(view), (el) => (el.props['data-show'] ? el : undefined))
const linesOf = (view) => (menuOf(view) ? itemsOf(view).flatMap((item) => texts(item)) : null)
const headOf = (view) => texts(menuOf(view)).slice(0, 4)
const arrow = (view, title) => collect(menuOf(view), (el) => (el.props.title === title ? el : undefined))[0]
  .props.onClick()
const ESCAPE = () => new KeyboardEvent('keydown', { key: 'Escape' })

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
    // a row per document, every member under one heading and the hint saying
    // which member it is
    expect(documentRows(DOCS, null, () => {}).map((row) => [row.group, row.label, row.hint])).toEqual([
      ['KICAD', 'hw/board.kicad_sch', '2 sheets'], ['KICAD', 'hw/board.kicad_pcb', 'board'],
      ['KICAD', 'hw/board.glb', '3D'], ['PDF', 'ds/ne555.pdf', '0.0 kB'], ['KICAD', 'psu/psu.kicad_pcb', 'board']])
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
    // the viewer's own list of a label's places opens only when the page asks
    expect(viewers.map((v) => [v.props['data-view'], v.props['source-mode'], v.props['show-header'], v.props['hide-chrome'],
      v.props['show-selection-panel']])).toEqual([[SCH, 'host', 'false', 'true', 'false'], [PCB, 'host', 'false', 'true', 'false']])
    // the open member's viewer too, until its files are drawn: before that it
    // shows only its own spinner, right under the load bar
    expect(viewers.map((v) => v.props.style.visibility)).toEqual(['hidden', 'hidden'])
    view.setState({ ready: true })
    expect(ofType(view.render(), 'ecad-viewer').map((v) => v.props.style.visibility)).toEqual(['hidden', 'visible'])
    expect(viewers.map((v) => v.props.style.height)).toEqual(['100%', '100%'])
  })

  it('draws a member with no sibling alone', () => {
    const lone = new KicadView({ doc: DOCS[4], documents: DOCS, base: BASE })
    Object.assign(lone.state, { ready: true })
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
  })
})

describe('what is on screen downloads first', () => {
  afterEach(() => vi.unstubAllGlobals())
  const FILES = designFiles(designMembers(DOCS, DOCS[0])).map((file) => `${BASE}${file}`)
  const asked = () => fetch.mock.calls.map(([url]) => url)

  it('opened on the 3D view, fetches the 2D files once the board\'s model is in or failed, and tells the page then', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(`<${url}>`)))
    const { view } = mounted(DOCS[2])
    view.componentDidMount()
    expect(asked()).toEqual([])
    view3d(view).three.props.onFetched()
    expect(view.props.onReady).toHaveBeenCalledTimes(1)
    expect(asked()).toEqual(FILES)
    await vi.waitFor(() => expect(view.state.got).toBe(true))
    expect(view.props.onReady).toHaveBeenCalledTimes(1)
    view.componentWillUnmount()
  })

  it('opened on the schematic or the board, fetches them at once and tells the page when they are in', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(`<${url}>`)))
    const { view } = mounted(DOCS[1])
    view.componentDidMount()
    expect(asked()).toEqual(FILES)
    expect(view.props.onReady).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(view.props.onReady).toHaveBeenCalledTimes(1))
    view.componentWillUnmount()
  })

  it('opened on the 3D view and moved to the schematic before the model is in, fetches its files then, once', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(`<${url}>`)))
    const { view } = mounted(DOCS[2])
    view.componentDidMount()
    view.props.onOpen(DOCS[0].id)
    expect(asked()).toEqual(FILES)
    view3d(view).three.props.onFetched()
    expect(asked()).toEqual(FILES)
    await vi.waitFor(() => expect(view.state.ready).toBe(true))
    expect(view.props.onReady).toHaveBeenCalledTimes(1)
    view.componentWillUnmount()
  })

  it('selects in the drawn views, once they have their files, a part picked in the 3D view while they had none', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(`<${url}>`)))
    const { view, elements } = mounted(DOCS[2])
    view.componentDidMount()
    view3d(view).three.props.onSelect('C1')
    // asked of viewers with nothing in them yet, which find nothing
    for (const context of [SCH, PCB]) elements[context].requestCrossProbe.mockClear()
    view3d(view).three.props.onFetched()
    await vi.waitFor(() => expect(view.state.ready).toBe(true))
    expect(elements[SCH].requestCrossProbe.mock.calls).toEqual([[designator(SCH, 'C1')]])
    expect(elements[PCB].requestCrossProbe.mock.calls).toEqual([[designator(PCB, 'C1')]])
    view.componentWillUnmount()
  })

  it('keeps the schematic\'s row of the menu from the 3D view until the schematic has its files', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(`<${url}>`)))
    const { view, elements } = mounted(DOCS[2])
    view.componentDidMount()
    // a right click in the 3D view selects the part, then opens its menu
    view3d(view).three.props.onSelect('C1')
    view3d(view).three.props.onMenu('C1', 100, 100)
    elements[SCH].requestCrossProbe.mockClear()
    itemsOf(view).find((item) => item.props['data-show'] === SCH).props.onClick()
    expect(view.props.doc).toBe(DOCS[0])
    expect(elements[SCH].requestCrossProbe).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(view.state.ready).toBe(true))
    // React's update after the state that says so: the selection carried over,
    // then the probe handed
    view.componentDidUpdate(view.props)
    expect(elements[SCH].requestCrossProbe.mock.calls).toEqual([[designator(SCH, 'C1')], [designator(SCH, 'C1')]])
    view.componentWillUnmount()
  })
})

describe('a design the page keeps while another document is on screen', () => {
  afterEach(() => vi.unstubAllGlobals())
  const NOTES = { id: 'notes.md', name: 'notes.md', type: 'markdown', file: 'notes.md', bytes: 9 }
  const FILES = designFiles(designMembers(DOCS, DOCS[0])).map((file) => `${BASE}${file}`)
  /** The page handing the view `shown`, as `DocumentLayers` does. */
  const keep = (view, shown) => {
    const before = view.props
    view.props = { ...before, shown }
    view.componentDidUpdate(before)
  }

  it('is one view of it under a markdown document and back, its files fetched once, kept in the order opened', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(`<${url}>`)))
    const page = new DocumentLayers({ build: 'abc', layer: 'position:absolute;inset:0', doc: DOCS[0],
      documents: [...DOCS, NOTES], base: BASE, onTools: vi.fn(), onReady: vi.fn() })
    /** The page drawn with `doc` on screen, its layers' state kept as React keeps it. */
    const draw = (doc) => {
      page.props = { ...page.props, doc }
      page.state = DocumentLayers.getDerivedStateFromProps(page.props, page.state)
      return page.render()
    }
    /** What a layer hands its design's view, through the DocumentView in it. */
    const handed = (layer) => new DocumentView(layer.props.children.props).render().props
    const [design] = draw(DOCS[0])
    const { view } = mounted(DOCS[0])
    view.props = handed(design)
    view.componentDidMount()
    onTestFinished(() => view.componentWillUnmount())
    await vi.waitFor(() => expect(view.state.ready).toBe(true))
    const over = draw(NOTES)
    expect(over.map((layer) => [layer.key, layer.props.children.props.shown])).toEqual([[design.key, false],
      ['abc:notes.md', true]])
    // hidden in a layer of the same size, so its canvases keep theirs
    expect(over[0].props.style).toEqual({ ...design.props.style, visibility: 'hidden' })
    for (const layers of [over, draw(DOCS[0])]) {
      const before = view.props
      view.props = handed(layers[0])
      view.componentDidUpdate(before)
    }
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(FILES)
    // another design after it, and its board: none moved
    expect(draw(DOCS[4]).map((layer) => [layer.key, layer.props.children.props.shown]))
      .toEqual([[design.key, false], ['abc:design/psu/psu', true]])
    expect(draw(DOCS[1]).map((layer) => [layer.key, layer.props.children.props.doc]))
      .toEqual([[design.key, DOCS[1]], ['abc:design/psu/psu', DOCS[4]]])
  })

  it('hidden, draws no view, puts its elements and comment mode out, shuts its menu and calls none of the page\'s doors', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(`<${url}>`)))
    const comment = { on: true, marks: [], focus: null, onArea: vi.fn(), onMarker: vi.fn(), onFocused: vi.fn(),
      onLost: vi.fn() }
    const { view, elements } = mounted(DOCS[1])
    for (const element of Object.values(elements)) element.setCommentMode = vi.fn()
    view.props = { ...view.props, comment }
    view.componentDidMount()
    onTestFinished(() => view.componentWillUnmount())
    await vi.waitFor(() => expect(view.state.ready).toBe(true))
    view.componentDidUpdate(view.props)
    view.setState({ menu: { from: PCB }, sheet: { doc: pdf, from: PCB } })
    const told = view.props.onTools.mock.calls.length
    keep(view, false)
    // what would call the page: a place asked for on the board, Escape, an area
    // drawn and a marker clicked there
    view.props = { ...view.props, comment: { ...comment, focus: { doc: DOCS[1].file, area: [0, 0, 2, 2] } } }
    view.componentDidUpdate(view.props)
    for (const element of Object.values(elements)) element.clearSelection.mockClear()
    window.dispatchEvent(ESCAPE())
    elements[PCB].dispatchEvent(new CustomEvent(AREA_EVENT, { detail: { context: PCB, bounds: [1, 2, 3, 4] } }))
    elements[PCB].dispatchEvent(new CustomEvent(MARKER_EVENT, { detail: { commentId: 'c1' } }))
    expect(view.props.onTools).toHaveBeenCalledTimes(told)
    expect([comment.onArea, comment.onMarker, comment.onFocused, comment.onLost].map((fn) => fn.mock.calls.length))
      .toEqual([0, 0, 0, 0])
    expect([view.state.menu, view.state.sheet]).toEqual([null, null])
    for (const element of Object.values(elements)) {
      expect([element.setActive.mock.lastCall, element.setCommentMode.mock.lastCall, element.clearSelection.mock.calls])
        .toEqual([[false], [false], []])
    }
    const tree = view.render()
    expect(collect(tree, (el) => (el.props.style && el.props.style.visibility === 'visible' ? el : undefined)))
      .toEqual([])
    expect([ofType(tree, PcbPanel)[0].props.active, view3d(view).three.props.active, view3d(view).three.props.comment])
      .toEqual([false, false, null])
    // shown again: the bar told afresh what the board can do
    keep(view, true)
    expect(view.props.onTools).toHaveBeenCalledTimes(told + 1)
    expect(Object.keys(view.props.onTools.mock.lastCall[0])).toEqual(['fit', 'frame'])
  })

  it('owes the page the files that came in while it was hidden, and tells it when shown', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(`<${url}>`)))
    // opened on the schematic, and on the 3D model, whose `.glb` lands hidden
    for (const doc of [DOCS[0], DOCS[2]]) {
      const { view } = mounted(doc)
      view.componentDidMount()
      onTestFinished(() => view.componentWillUnmount())
      keep(view, false)
      if (doc === DOCS[2]) view3d(view).three.props.onFetched()
      await vi.waitFor(() => expect(view.state.ready).toBe(true))
      expect(view.props.onReady).not.toHaveBeenCalled()
      // React's update after the files, and the 3D model's tools: the bar hears
      // of neither while the design is hidden
      const told = view.props.onTools.mock.calls.length
      if (doc === DOCS[2]) view3d(view).three.props.onTools({ fit() {}, frame() {} })
      view.componentDidUpdate(view.props)
      expect(view.props.onTools).toHaveBeenCalledTimes(told)
      keep(view, true)
      expect(view.props.onReady).toHaveBeenCalledTimes(1)
    }
  })
})

describe('the schematic\'s page', () => {
  // Named in the address as `s=`, beside the schematic's `d=`. The element
  // switches as the viewer does, reporting the change inside `switchPage`.
  const SHEET = 'hw__board.kicad_sch'
  const BOARD = 'hw__board.kicad_pcb'
  const ROOT = 'hw/board.kicad_sch:/root'
  const AMP = 'hw/board.kicad_sch:/root/amp'
  // Two sheets of one name, which `s=` tells apart by their paths.
  const PSU_A = 'hw/board.kicad_sch:/root/psu-a'
  const PSU_B = 'hw/board.kicad_sch:/root/amp/psu-b'
  const PAGES = [
    { projectPath: ROOT, name: 'board', parentProjectPath: null },
    { projectPath: AMP, name: 'amp', parentProjectPath: ROOT },
    { projectPath: PSU_A, name: 'psu', parentProjectPath: ROOT },
    { projectPath: PSU_B, name: 'psu', parentProjectPath: AMP },
  ]
  // What the amp sheet draws: a part, and a net, a place of which is a row of
  // the menu, beside its place on the root sheet and the board's row.
  const ON_AMP = ['U7', 'AMP_FAULT']
  const FAULT = { targetContext: SCH, kind: 'net', value: 'AMP_FAULT', sheet: 'hw/sub/amp.kicad_sch', uuid: 'fault-amp' }
  const SHOW_FAULT = { title: 'AMP_FAULT', label: 'amp:AMP_FAULT', view: SCH, id: SHEET, request: FAULT }
  const FAULT_MENU = { from: SCH, active: 0, rows: [
    { title: 'AMP_FAULT', label: 'board:AMP_FAULT', view: SCH, id: SHEET,
      request: { ...FAULT, sheet: 'hw/board.kicad_sch', uuid: 'fault-root' } },
    SHOW_FAULT,
    { title: 'AMP_FAULT', label: 'AMP_FAULT · hw/board.kicad_pcb', view: PCB, id: BOARD,
      request: { targetContext: PCB, kind: 'net', value: 'AMP_FAULT' } },
  ] }
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    window.history.replaceState(null, '', '/')
  })

  /** The design opened on `doc`, its viewers ready, the schematic on `ROOT`;
   *  `meanwhile` runs while its files are still coming in. */
  const opened = async (doc = DOCS[0], meanwhile = () => {}) => {
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(`<${url}>`)))
    const { view, elements } = mounted(doc)
    const sch = elements[SCH]
    sch.page = ROOT
    sch.replaceSources = vi.fn(async () => { sch.loaded = true })
    sch.getSchematicPages = () => PAGES
    sch.getActiveSchematicPage = () => ({ projectPath: sch.page, name: 'board', page: '1' })
    sch.show = (to) => {
      sch.page = to
      sch.dispatchEvent(new CustomEvent(PAGE_EVENT))
    }
    // An element without its files switches nothing.
    sch.switchPage = vi.fn((to) => {
      if (!sch.loaded) return false
      sch.show(to)
      return true
    })
    sch.requestCrossProbe = vi.fn((request) => {
      if (ON_AMP.includes(request.value)) sch.show(AMP)
      return true
    })
    view.componentDidMount()
    onTestFinished(() => view.componentWillUnmount())
    meanwhile(view)
    await vi.waitFor(() => expect(view.state.ready).toBe(true))
    return { view, elements, sch }
  }
  /** The browser's own Back and Forward, which restore the entry tasks later. */
  const go = async (delta) => {
    const popped = new Promise((done) => { window.addEventListener('popstate', done, { once: true }) })
    window.history.go(delta)
    await popped
  }
  /** The page answering `onOpen` as the model's page does, with a step of its
   *  own naming the member (`pushChoice`) before handing it down. */
  const answering = (view) => {
    const open = view.props.onOpen
    view.props = { ...view.props, onOpen: (id) => {
      window.history.pushState(window.history.state, '', `${BASE}?d=${id}`)
      open(id)
    } }
  }

  it('is a step of history on every change, named as `s=` in the address, the root sheet as none', async () => {
    window.history.replaceState({ hmr: 'latest' }, '', `${BASE}?d=${SHEET}&files=K#top`)
    const { sch } = await opened()
    const replace = vi.spyOn(window.history, 'replaceState')
    const push = vi.spyOn(window.history, 'pushState')
    // a double click on a sheet symbol, inside the viewer
    sch.switchPage(AMP)
    expect(push.mock.calls).toEqual([[{ hmr: 'latest' }, '', `${BASE}?d=${SHEET}&files=K&s=amp#top`]])
    // a sheet whose name another sheet has goes by its path
    sch.switchPage(PSU_B)
    expect(window.location.search).toBe(`?d=${SHEET}&files=K&s=${encodeURIComponent(PSU_B)}`)
    sch.switchPage(ROOT)
    expect(window.location.search).toBe(`?d=${SHEET}&files=K`)
    // a report that moved no page, as for another change of the project
    sch.dispatchEvent(new CustomEvent(PAGE_EVENT))
    expect([push.mock.calls.length, replace.mock.calls.length]).toEqual([3, 0])
  })

  it('is put back by Back and Forward, which write nothing', async () => {
    window.history.replaceState(null, '', `${BASE}?d=${SHEET}`)
    const { sch } = await opened()
    sch.switchPage(AMP)
    sch.switchPage(PSU_B)
    sch.switchPage.mockClear()
    const replace = vi.spyOn(window.history, 'replaceState')
    const push = vi.spyOn(window.history, 'pushState')
    await go(-1)
    expect([sch.page, sch.switchPage.mock.calls]).toEqual([AMP, [[AMP]]])
    await go(-1)
    expect([sch.page, sch.switchPage.mock.calls]).toEqual([ROOT, [[AMP], [ROOT]]])
    await go(2)
    expect([sch.page, sch.switchPage.mock.calls]).toEqual([PSU_B, [[AMP], [ROOT], [PSU_B]]])
    expect([push.mock.calls.length, replace.mock.calls.length]).toEqual([0, 0])
  })

  it('is left as it is by an address naming another document', async () => {
    const { sch } = await opened()
    for (const query of [`?d=${BOARD}&s=amp`, '?s=amp', '?d=psu__psu.kicad_sch&s=amp']) {
      window.history.replaceState(null, '', `${BASE}${query}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }
    expect(sch.switchPage).not.toHaveBeenCalled()
  })

  it('is the address\'s once the viewers are ready: a link, a reload, Back onto a design no longer open', async () => {
    // The browser restores the entry, and the page mounts the design after the
    // `popstate`; Back while the files are still coming in waits for them.
    window.history.replaceState({ hmr: 'latest' }, '', `${BASE}?d=${SHEET}&s=amp`)
    window.dispatchEvent(new PopStateEvent('popstate'))
    const replace = vi.spyOn(window.history, 'replaceState')
    const push = vi.spyOn(window.history, 'pushState')
    const { sch } = await opened(DOCS[0], () => window.dispatchEvent(new PopStateEvent('popstate')))
    expect([sch.page, sch.switchPage.mock.calls]).toEqual([AMP, [[AMP]]])
    expect([push.mock.calls.length, replace.mock.calls.length]).toEqual([0, 0])
  })

  it('is the root sheet for an `s=` naming no sheet of the schematic, or a name two sheets share, which the address opened drops and Back and Forward keep', async () => {
    // a link naming a sheet this revision does not have
    window.history.replaceState(null, '', `${BASE}?d=${SHEET}&s=nowhere`)
    const { view, sch } = await opened()
    const seen = [[sch.page, window.location.search]]
    // Back onto another revision's entry, this design still mounted while the
    // page swaps that revision in: the entry keeps its sheet for it
    for (const value of ['amp', 'psu', PSU_B, 'nowhere']) {
      window.history.replaceState(null, '', `${BASE}?d=${SHEET}&s=${encodeURIComponent(value)}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
      seen.push([sch.page, window.location.search])
    }
    // and through an update the page makes later, while that revision comes in
    view.componentDidUpdate(view.props)
    seen.push([sch.page, window.location.search])
    expect(seen).toEqual([[ROOT, `?d=${SHEET}`], [AMP, `?d=${SHEET}&s=amp`], [ROOT, `?d=${SHEET}&s=psu`],
      [PSU_B, `?d=${SHEET}&s=${encodeURIComponent(PSU_B)}`], [ROOT, `?d=${SHEET}&s=nowhere`], [ROOT, `?d=${SHEET}&s=nowhere`]])
  })

  it('is the entry\'s on Back onto the schematic from its board, though the design hears of Back before the page hands the schematic down', async () => {
    // The page's update, standing here as a listener after address.js's own:
    // the design is handed the entry first (`onPop`, subscribed there) with the
    // props of the entry being left, the board, and then the page's update
    // hands down the member the entry names, under the same `popstate`, as
    // React applies it once the subscribers have run.
    let view = null
    const page = () => {
      const doc = DOCS.find((one) => one.id === new URLSearchParams(window.location.search).get('d'))
      if (!view || doc === view.props.doc) return
      const before = view.props
      view.props = { ...before, doc }
      view.componentDidUpdate(before)
    }
    window.addEventListener('popstate', page)
    onTestFinished(() => window.removeEventListener('popstate', page))
    window.history.replaceState(null, '', `${BASE}?d=${SHEET}&s=amp`)
    const design = await opened()
    view = design.view
    // Alt+Backspace to the root sheet, then the board
    design.sch.switchPage(ROOT)
    answering(view)
    view.props.onOpen(BOARD)
    await go(-2)
    expect([view.props.doc.id, design.sch.page, window.location.search]).toEqual([SHEET, AMP, `?d=${SHEET}&s=amp`])
    // Back onto the root sheet's entry, the hidden schematic moved to the amp
    // sheet by a part clicked on the board meanwhile
    design.sch.switchPage(ROOT)
    view.props.onOpen(BOARD)
    click(design.elements[PCB], { sourceContext: PCB, itemType: 'footprint', reference: 'U7' })
    expect(design.sch.page).toBe(AMP)
    await go(-1)
    expect([view.props.doc.id, design.sch.page, window.location.search]).toEqual([SHEET, ROOT, `?d=${SHEET}`])
    // Back onto another revision's entry, naming a sheet this schematic does
    // not have, while the page swaps that revision in: the entry keeps it
    window.history.replaceState(null, '', `${BASE}?d=${SHEET}&s=nowhere`)
    view.props.onOpen(BOARD)
    await go(-1)
    view.componentDidUpdate(view.props)
    expect([view.props.doc.id, design.sch.page, window.location.search]).toEqual([SHEET, ROOT, `?d=${SHEET}&s=nowhere`])
  })

  it('is rewritten in place where the page moved the schematic on screen, and left alone while it is hidden', async () => {
    // a part clicked on the board, its symbol on another sheet of the hidden
    // schematic, and any other move of it there
    window.history.replaceState({ hmr: 'latest' }, '', `${BASE}?d=${BOARD}`)
    const board = await opened(DOCS[1])
    const replace = vi.spyOn(window.history, 'replaceState')
    const push = vi.spyOn(window.history, 'pushState')
    click(board.elements[PCB], { sourceContext: PCB, itemType: 'footprint', reference: 'U7' })
    expect(board.sch.page).toBe(AMP)
    board.sch.show(ROOT)
    expect([window.location.search, replace.mock.calls.length]).toEqual([`?d=${BOARD}`, 0])
    // a part selected in the 3D view while the files came in, selected in the
    // schematic on screen once they are in
    window.history.replaceState({ hmr: 'latest' }, '', `${BASE}?d=${SHEET}`)
    replace.mockClear()
    const { sch } = await opened(DOCS[0], (view) => view.setState({ selected: 'U7' }))
    expect([sch.page, window.location.search, replace.mock.calls.length]).toEqual([AMP, `?d=${SHEET}&s=amp`, 1])
    expect(push).not.toHaveBeenCalled()
  })

  it('is taken up by the address, in place, when the schematic comes on screen on a sheet below its root', async () => {
    window.history.replaceState({ hmr: 'latest' }, '', `${BASE}?d=${BOARD}`)
    const { view, elements, sch } = await opened(DOCS[1])
    answering(view)
    click(elements[PCB], { sourceContext: PCB, itemType: 'footprint', reference: 'U7' })
    const replace = vi.spyOn(window.history, 'replaceState')
    const push = vi.spyOn(window.history, 'pushState')
    view.props.onOpen(SHEET)
    expect([sch.page, window.location.search]).toEqual([AMP, `?d=${SHEET}&s=amp`])
    expect([push.mock.calls.length, replace.mock.calls.length]).toEqual([1, 1])
  })

  it('follows a sheet chosen in the list of views, over the schematic and over the board, adding no step of its own', async () => {
    // The page's step naming the sheet (`pushChoice`, through address.js), then
    // the schematic handed down, or the page drawn again round it as the list
    // shuts.
    const choose = (view, query) => {
      navigate(parse({ pathname: BASE, search: query, hash: '' }, null), { push: true })
      const before = view.props
      view.props = { ...before, doc: DOCS[0] }
      view.componentDidUpdate(before)
      return window.location.search
    }
    window.history.replaceState(null, '', `${BASE}?d=${SHEET}`)
    const { view, sch } = await opened()
    const replace = vi.spyOn(window.history, 'replaceState')
    const push = vi.spyOn(window.history, 'pushState')
    const seen = [`?d=${SHEET}&s=amp`, `?d=${SHEET}&s=${encodeURIComponent(PSU_B)}`, `?d=${SHEET}`]
      .map((query) => [choose(view, query), sch.page])
    expect(seen).toEqual([[`?d=${SHEET}&s=amp`, AMP], [`?d=${SHEET}&s=${encodeURIComponent(PSU_B)}`, PSU_B],
      [`?d=${SHEET}`, ROOT]])
    expect([push.mock.calls.length, replace.mock.calls.length]).toEqual([3, 0])
    // a sheet chosen, the reader's own step off it, which the page draws
    // nothing for, and the same sheet chosen again
    choose(view, `?d=${SHEET}&s=amp`)
    sch.switchPage(PSU_B)
    expect([choose(view, `?d=${SHEET}&s=amp`), sch.page]).toEqual([`?d=${SHEET}&s=amp`, AMP])
    window.history.replaceState(null, '', `${BASE}?d=${BOARD}`)
    const board = await opened(DOCS[1])
    replace.mockClear()
    push.mockClear()
    expect([choose(board.view, `?d=${SHEET}&s=amp`), board.sch.page]).toEqual([`?d=${SHEET}&s=amp`, AMP])
    expect([push.mock.calls.length, replace.mock.calls.length]).toEqual([1, 0])
    // the root, by its path, over the board, the hidden schematic moved to the
    // amp sheet by a part clicked there: put, and the address spelled with no `s=`
    window.history.replaceState(null, '', `${BASE}?d=${BOARD}`)
    const moved = await opened(DOCS[1])
    click(moved.elements[PCB], { sourceContext: PCB, itemType: 'footprint', reference: 'U7' })
    replace.mockClear()
    push.mockClear()
    expect([moved.sch.page, choose(moved.view, `?d=${SHEET}&s=${encodeURIComponent(ROOT)}`), moved.sch.page])
      .toEqual([AMP, `?d=${SHEET}`, ROOT])
    expect([push.mock.calls.length, replace.mock.calls.length]).toEqual([1, 1])
  })

  it('puts out the selection of the sheet left on the reader\'s change and on Back, not on a probe\'s', async () => {
    window.history.replaceState(null, '', `${BASE}?d=${SHEET}`)
    const { sch, elements } = await opened()
    sch.clearSelection.mockClear()
    // a part clicked on the board, its symbol on the amp sheet
    click(elements[PCB], { sourceContext: PCB, itemType: 'footprint', reference: 'U7' })
    expect([sch.page, sch.clearSelection.mock.calls]).toEqual([AMP, []])
    sch.switchPage(PSU_B)
    await go(-1)
    expect([sch.page, sch.clearSelection.mock.calls]).toEqual([AMP, [[{ keepHighlights: true }], [{ keepHighlights: true }]]])
  })

  it('moves with a place stepped to from the board inside the one entry that opens the schematic', async () => {
    window.history.replaceState({ hmr: 'latest' }, '', `${BASE}?d=${BOARD}`)
    const { view, sch } = await opened(DOCS[1])
    answering(view)
    const push = vi.spyOn(window.history, 'pushState')
    view.setState({ menu: { ...FAULT_MENU, from: PCB, active: 2 } })
    view.go(1)
    expect(push).toHaveBeenCalledTimes(1)
    expect([sch.page, window.location.search]).toEqual([AMP, `?d=${SHEET}&s=amp`])
    await go(-1)
    expect(window.location.search).toBe(`?d=${BOARD}`)
  })

  it('moves with a place stepped to over the schematic on screen as the reader\'s own step, the selection kept', async () => {
    window.history.replaceState(null, '', `${BASE}?d=${SHEET}`)
    const { view, sch } = await opened()
    const push = vi.spyOn(window.history, 'pushState')
    sch.clearSelection.mockClear()
    view.setState({ menu: FAULT_MENU })
    view.go(1)
    expect([sch.requestCrossProbe.mock.lastCall, view.props.onOpen.mock.calls, sch.clearSelection.mock.calls])
      .toEqual([[FAULT], [], []])
    expect([push.mock.calls.length, sch.page, window.location.search, view.state.menu.active])
      .toEqual([1, AMP, `?d=${SHEET}&s=amp`, 1])
  })

  it('is the address\'s when the page shows again the design it kept hidden, which nothing writes meanwhile', async () => {
    window.history.replaceState(null, '', `${BASE}?d=${SHEET}&s=amp`)
    const { view, sch } = await opened()
    /** The page handing the view `shown`, and the member on screen. */
    const keep = (shown, doc = view.props.doc) => {
      const before = view.props
      view.props = { ...before, shown, doc }
      view.componentDidUpdate(before)
    }
    // a markdown document on screen over the schematic, a step of the page's
    window.history.pushState(null, '', `${BASE}?d=notes.md`)
    keep(false)
    sch.switchPage.mockClear()
    // moved meanwhile, Back onto the schematic's entry heard before the page
    // shows it, and an update of the page's while it is still hidden
    sch.show(PSU_B)
    const left = window.location.search
    window.history.replaceState(null, '', `${BASE}?d=${SHEET}&s=amp`)
    window.dispatchEvent(new PopStateEvent('popstate'))
    view.componentDidUpdate(view.props)
    expect([left, window.location.search, sch.switchPage.mock.calls]).toEqual(['?d=notes.md', `?d=${SHEET}&s=amp`, []])
    keep(true)
    expect([sch.page, window.location.search]).toEqual([AMP, `?d=${SHEET}&s=amp`])
    // hidden over its board, and shown on the schematic's row, which names no
    // sheet: on the root, as a fresh mount opens
    keep(true, DOCS[1])
    window.history.pushState(null, '', `${BASE}?d=notes.md`)
    keep(false)
    window.history.pushState(null, '', `${BASE}?d=${SHEET}`)
    keep(true, DOCS[0])
    expect([sch.page, window.location.search]).toEqual([ROOT, `?d=${SHEET}`])
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
      view.key(ESCAPE())
      three().onMenu('L101', 10, 60)
      itemsOf(view)[1].props.onClick()
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

  it('a click on nothing, and Escape, put out what is lit in every view, the clicked one included', () => {
    const { view, elements } = mounted(DOCS[1])
    const cleared = () => [SCH, PCB].map((context) => elements[context].clearSelection.mock.calls.length)
    click(elements[SCH], { sourceContext: SCH, itemType: 'symbol', reference: 'U501' })
    click(elements[PCB], { sourceContext: PCB, itemType: '' })
    expect(cleared()).toEqual([1, 1])
    expect(view3d(view).three.props.selected).toBeNull()

    click(elements[SCH], { sourceContext: SCH, itemType: 'symbol', reference: 'U501' })
    // not while typing in a field of the page, and no other key
    const field = document.body.appendChild(document.createElement('textarea'))
    field.focus()
    view.key(ESCAPE())
    field.remove()
    view.key(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect([cleared(), view.state.selected]).toEqual([[1, 1], 'U501'])
    // an Escape the page took (it closed an overlay with it) leaves the selection alone
    const taken = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    taken.preventDefault()
    view.key(taken)
    expect([cleared(), view.state.selected]).toEqual([[1, 1], 'U501'])
    view.key(ESCAPE())
    expect([cleared(), view.state.selected]).toEqual([[2, 2], null])
  })
})

describe('the link between the schematic and the board', () => {
  it('asks for a part by its designator and a net by its name', () => {
    expect(crossProbeRequest({ itemType: 'symbol', reference: 'R104', uuid: 'u' }, PCB))
      .toEqual({ part: { targetContext: PCB, kind: 'designator', value: 'R104' }, net: null })
    // a pin asks for its part
    expect(crossProbeRequest({ itemType: 'pin', reference: 'U201', pin: '30' }, PCB))
      .toEqual({ part: { targetContext: PCB, kind: 'designator', value: 'U201' }, net: null })
    expect(crossProbeRequest({ itemType: 'net', net: '/VBUS', netCode: 3 }, SCH))
      .toEqual({ part: null, net: { targetContext: SCH, kind: 'net', value: '/VBUS' } })
    expect(crossProbeRequest({ itemType: 'wire' }, PCB)).toEqual({ part: null, net: null })
  })

})

describe('the menu', () => {
  const C523 = { sourceContext: SCH, itemType: 'symbol', reference: 'C523' }

  it('has a row per member for a part, the one clicked in included and active, and for a net the drawings', () => {
    const offered = (from, detail, views) => {
      const menu = menuFor(from, detail, Object.fromEntries(views.map((view) => [view, { id: `id-${view}`, name: view }])))
      return menu && menu.rows.map((row, i) => `${i === menu.active ? '*' : ''}${row.label} (${row.id})`).join(', ')
    }
    const all = [SCH, PCB, BOARD3D]
    const pad = { itemType: 'pad', reference: 'U501', pin: '3', net: 'GND' }
    const track = { itemType: 'track', net: '+5V', netCode: 14 }
    expect([
      offered(SCH, C523, all), offered(PCB, { itemType: 'footprint', reference: 'U501' }, all),
      offered(BOARD3D, { reference: 'L101' }, all),
      // a pad: its part's rows, active on the board's, then its net's
      offered(PCB, pad, all),
      // a track: the net in the drawings only, never the 3D model
      offered(PCB, track, all),
      // no board, no 3D model
      offered(SCH, C523, [SCH, BOARD3D]), offered(PCB, pad, [SCH, PCB]), offered(PCB, track, [PCB, BOARD3D]),
      // neither a part nor a net, a part of a design of one, a power symbol and flag no sheet names
      offered(SCH, { itemType: 'wire' }, all), offered(SCH, { itemType: '' }, all), offered(SCH, C523, [SCH]),
      offered(SCH, { itemType: 'symbol', reference: '#PWR0101' }, all), offered(SCH, { itemType: 'pin', reference: '#FLG0101', pin: '1' }, all),
    ]).toEqual([
      '*C523 · SCH (id-SCH), C523 · PCB (id-PCB), C523 · 3D (id-3D)',
      'U501 · SCH (id-SCH), *U501 · PCB (id-PCB), U501 · 3D (id-3D)',
      'L101 · SCH (id-SCH), L101 · PCB (id-PCB), *L101 · 3D (id-3D)',
      'U501 · SCH (id-SCH), *U501 · PCB (id-PCB), U501 · 3D (id-3D), GND · SCH (id-SCH), GND · PCB (id-PCB)',
      '+5V · SCH (id-SCH), *+5V · PCB (id-PCB)',
      '*C523 · SCH (id-SCH), C523 · 3D (id-3D)',
      'U501 · SCH (id-SCH), *U501 · PCB (id-PCB), GND · SCH (id-SCH), GND · PCB (id-PCB)', null,
      null, null, null, null, null,
    ])
    // each asks its view for the part by its designator, the net by its name
    expect(menuFor(PCB, pad, { [SCH]: { id: 's' }, [PCB]: { id: 'p' } }).rows.map((row) => row.request)).toEqual([
      designator(SCH, 'U501'), designator(PCB, 'U501'),
      { targetContext: SCH, kind: 'net', value: 'GND' }, { targetContext: PCB, kind: 'net', value: 'GND' }])
  })

  it('asks the element what is under a right click, selects it, and opens there', () => {
    const { view, elements } = mounted()
    elements[SCH].under = C523
    rightClick(elements[SCH], 300, 250)
    expect(elements[SCH].picks).toEqual([[300, 250]])
    // selected as a left click selects it
    expect(elements[PCB].requestCrossProbe).toHaveBeenCalledWith(designator(PCB, 'C523'))
    expect(view3d(view).three.props.selected).toBe('C523')
    // at the pointer, in the view area
    expect(menuOf(view).props.style).toMatchObject({ position: 'absolute', left: '300px', top: '200px' })
    expect(texts(menuOf(view))).toEqual(['C523', '‹', '1 / 3', '›', 'C523 · hw/board.kicad_sch',
      'C523 · hw/board.kicad_pcb', 'C523 · hw/board.glb'])
    expect(view.props.onOpen).not.toHaveBeenCalled()
  })

  it('opens nothing for a press the viewer panned with, another button, or a release off its canvas', () => {
    const { view, elements } = mounted()
    elements[SCH].under = C523
    rightClick(elements[SCH], 300, 250, PAN_SLOP)
    rightClick(elements[SCH], 300, 250, 0, 0)
    elements[SCH].dispatchEvent(new MouseEvent('pointerdown', { button: 2, clientX: 9, clientY: 9 }))
    elements[SCH].dispatchEvent(new MouseEvent('pointerup', { button: 2, clientX: 9, clientY: 9 }))
    expect([elements[SCH].picks, menuOf(view)]).toEqual([[], undefined])
    rightClick(elements[SCH], 300, 250, PAN_SLOP - 1)
    expect(menuOf(view)).toBeDefined()
  })

  it('a row of another member opens it and selects the same part or net there, once the page hands it down', () => {
    const { view, elements } = mounted()
    // drawn: the viewers have their files
    view.setState({ ready: true })
    elements[SCH].under = C523
    rightClick(elements[SCH], 300, 250)
    // the page answers later: nothing more is asked of the board until it does
    const answer = view.props.onOpen
    view.props.onOpen = vi.fn()
    itemsOf(view)[1].props.onClick()
    view.componentDidUpdate()
    expect([view.props.onOpen.mock.calls, elements[PCB].requestCrossProbe.mock.calls.length])
      .toEqual([[['hw__board.kicad_pcb']], 1])
    view.props.onOpen = answer
    answer('hw__board.kicad_pcb')
    expect(elements[PCB].requestCrossProbe).toHaveBeenCalledTimes(2)
    expect(elements[PCB].requestCrossProbe).toHaveBeenLastCalledWith(designator(PCB, 'C523'))
    expect(elements[PCB].setActive).toHaveBeenLastCalledWith(true)

    // a track's net, shown in the schematic
    elements[PCB].under = { sourceContext: PCB, itemType: 'track', net: 'GND', netCode: 1 }
    rightClick(elements[PCB], 100, 100)
    expect(texts(menuOf(view))).toEqual(['GND', '‹', '2 / 2', '›', 'GND · hw/board.kicad_sch', 'GND · hw/board.kicad_pcb'])
    itemsOf(view)[0].props.onClick()
    expect(view.props.onOpen).toHaveBeenLastCalledWith('hw__board.kicad_sch')
    expect(elements[SCH].requestCrossProbe).toHaveBeenLastCalledWith({ targetContext: SCH, kind: 'net', value: 'GND' })
  })

  it('steps with ‹ › round its ends, each step shown, and stays open over the member a step brings', () => {
    const { view, elements } = mounted()
    view.setState({ ready: true })
    elements[SCH].under = C523
    rightClick(elements[SCH], 300, 250)
    for (const context of [SCH, PCB]) elements[context].requestCrossProbe.mockClear()
    // the row of the view on screen: its element asked at once, the page nothing
    itemsOf(view)[0].props.onClick()
    expect([elements[SCH].requestCrossProbe.mock.calls, view.props.onOpen.mock.calls]).toEqual([[[designator(SCH, 'C523')]], []])
    const seen = []
    for (const title of ['Next', 'Next', 'Next', 'Previous']) {
      arrow(view, title)
      seen.push([view.props.doc.id, headOf(view)[2]])
    }
    expect(seen).toEqual([['hw__board.kicad_pcb', '2 / 3'], ['hw__board.glb', '3 / 3'], ['hw__board.kicad_sch', '1 / 3'],
      ['hw__board.glb', '3 / 3']])
    expect(elements[PCB].requestCrossProbe.mock.calls).toEqual([[designator(PCB, 'C523')]])
    expect(elements[SCH].requestCrossProbe.mock.lastCall).toEqual([designator(SCH, 'C523')])
    // the 3D model on screen is handed the part, the page asked for nothing
    view.props.onOpen.mockClear()
    itemsOf(view)[2].props.onClick()
    expect([view.props.onOpen.mock.calls, view3d(view).three.props.selected, headOf(view)[0]]).toEqual([[], 'C523', 'C523'])
  })

  it('from the 3D model offers both drawings, and opens nothing for a design without them', () => {
    const { view, elements } = mounted(DOCS[2])
    view3d(view).three.props.onSelect('L101')
    view3d(view).three.props.onMenu('L101', 700, 640)
    // no room right of or below the pointer: left of and above it
    expect(menuOf(view).props.style).toMatchObject({ left: '540px', top: `${590 - menuHeight(3)}px` })
    itemsOf(view)[0].props.onClick()
    expect(view.props.onOpen).toHaveBeenCalledWith('hw__board.kicad_sch')
    expect(elements[SCH].requestCrossProbe).toHaveBeenLastCalledWith(designator(SCH, 'L101'))

    const lone = mounted(model3d(), [model3d()])
    view3d(lone.view).three.props.onMenu('L101', 10, 60)
    expect(menuOf(lone.view)).toBeUndefined()
  })

  it('goes on Escape, a press elsewhere and a resize, not on the wheel nor another member on screen; one at a time', () => {
    const { view, elements } = mounted()
    // in the page, where a press on a view reaches the document
    document.body.append(...Object.values(elements))
    view.listen(true)
    elements[SCH].under = C523
    const opened = (x = 300) => {
      rightClick(elements[SCH], x, 250)
      return menuOf(view)
    }
    // the right press of a second right click puts the first menu out
    opened()
    expect(opened(500).props.style.left).toBe('500px')
    expect(collect(view.render(), (el) => el.props['data-menu'])).toEqual([SCH])
    // Escape closes it and leaves the part selected
    window.dispatchEvent(ESCAPE())
    expect([menuOf(view), view.state.selected, elements[SCH].clearSelection.mock.calls.length]).toEqual([undefined, 'C523', 0])
    // a press on the menu keeps it, a press anywhere else does not
    opened()
    view.setMenu(document.body.appendChild(document.createElement('div')))
    view.menuNode.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(menuOf(view)).toBeDefined()
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(menuOf(view)).toBeUndefined()
    // the wheel moves the drawing under it: nothing takes it
    opened()
    elements[SCH].dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    expect([menuOf(view), view.render().props.onWheelCapture]).toEqual([expect.anything(), undefined])
    window.dispatchEvent(new Event('resize'))
    expect(menuOf(view)).toBeUndefined()
    // the page shows another member
    opened()
    view.props = { ...view.props, doc: DOCS[1] }
    view.componentDidUpdate()
    expect([menuOf(view).props['data-menu'], headOf(view)[2]]).toEqual([SCH, '1 / 3'])
    view.componentWillUnmount()
    view.props = { ...view.props, doc: DOCS[0] }
    opened()
    window.dispatchEvent(new Event('resize'))
    expect(menuOf(view)).toBeDefined()
    for (const node of [view.menuNode, ...Object.values(elements)]) node.remove()
  })

  it('stays inside the view area wherever it opens, a phone\'s too', () => {
    expect(menuPlace(100, 100, 2, { width: 800, height: 600 })).toEqual({ left: 100, top: 100, width: 160 })
    expect(menuPlace(700, 580, 2, { width: 800, height: 600 })).toEqual({ left: 540, top: 580 - menuHeight(2), width: 160 })
    for (const rows of [1, 2, 3]) {
      for (const x of [0, 120, 195, 300, 389]) {
        for (const y of [0, 350, 699]) {
          const { left, top, width } = menuPlace(x, y, rows, { width: 390, height: 700 })
          expect([left >= 8, left + width <= 382, top >= 8, top + menuHeight(rows) <= 692]).toEqual([true, true, true, true])
        }
      }
    }
    // an area narrower than the menu narrows it
    expect(menuPlace(10, 10, 1, { width: 150, height: 300 }).width).toBe(134)
    // a line wider than the menu widens it, as far as the area lets it
    expect(menuPlace(100, 100, 2, { width: 800, height: 600 }, 287.2).width).toBe(316)
    expect(menuPlace(10, 10, 1, { width: 300, height: 300 }, 400).width).toBe(284)
    // rows that scroll leave room for the list's scroll bar beside that line
    expect(menuPlace(100, 100, 12, { width: 800, height: 600 }, 287.2).width).toBe(332)
  })

  it('does nothing without a sibling, or once an element is detached', () => {
    const lone = mounted(schematic(), [schematic(), pdf])
    lone.elements[SCH].under = C523
    rightClick(lone.elements[SCH], 300, 250)
    expect(menuOf(lone.view)).toBeUndefined()

    const { view, elements } = mounted()
    view.refCallbacks[SCH](null)
    elements[SCH].under = C523
    rightClick(elements[SCH], 300, 250)
    expect([elements[SCH].picks, menuOf(view)]).toEqual([[], undefined])
  })
})

describe('a net across the schematic\'s sheets', () => {
  // What names a net on the design's sheets, the root's two sheet symbols
  // pointing at the other two with a pin each for their hierarchical label,
  // the root's global label wired to the pin of `dsp`, and the board's nets, as
  // KiCad writes them.
  const power = (reference, value, uuid) => `(symbol (lib_id "power:${value}") (at 0 0 0)`
    + ` (property "Reference" "${reference}" (at 0 0 0)) (property "Value" "${value}" (at 0 0 0)) (uuid "${uuid}"))`
  const global = (name, uuid, at = '0 0 0') => `(global_label "${name}" (shape input) (at ${at}) (uuid "${uuid}"))`
  const hierarchical = (name, uuid) => `(hierarchical_label "${name}" (shape input) (at 0 0 0) (uuid "${uuid}"))`
  const sheetSymbol = (name, at = '0 0 0') => `(sheet (at 0 0) (uuid "sheet-${name}") (property "Sheetname" "${name}")`
    + ` (property "Sheetfile" "sub/${name}.kicad_sch") (pin "AMP_FAULT" input (at ${at}) (uuid "pin-fault-${name}")))`
  const NETS = netIndex({
    'hw/board.kicad_sch': `(kicad_sch ${global('AMP_CLIP_OTW', 'clip-board', '50.8 25.4 0')}`
      + ' (wire (pts (xy 50.8 25.4) (xy 63.5 25.4)) (uuid "wire-clip"))'
      + ` ${sheetSymbol('power')} ${sheetSymbol('dsp', '63.5 25.4 0')} ${power('#PWR0101', '+12V', 'pwr-board')})`,
    'hw/sub/power.kicad_sch': `(kicad_sch ${global('AMP_CLIP_OTW', 'clip-power')} ${power('#PWR0201', '+12V', 'pwr-power')}`
      + ` ${power('#PWR0202', '+12V', 'pwr-power-2')} ${power('#FLG0201', 'PWR_FLAG', 'flg-power')}`
      + ` ${hierarchical('AMP_FAULT', 'fault-power')})`,
    // the global net's name on a sheet only as a local label, a net of that sheet's own
    'hw/sub/dsp.kicad_sch': `(kicad_sch (label "AMP_CLIP_OTW" (at 0 0 0) (uuid "clip-local")) ${hierarchical('AMP_FAULT', 'fault-dsp')})`,
    // the hierarchical net named after the second of its sheets
    'hw/board.kicad_pcb': '(kicad_pcb (net 0 "") (net 1 "/dsp/AMP_FAULT") (net 2 "+12V"))',
  }, 'hw/board.kicad_sch')
  /** The design with its sheets' nets read, `doc` on screen. */
  const withNets = (doc = DOCS[0]) => {
    const one = mounted(doc)
    one.view.setState({ ready: true, nets: NETS })
    return one
  }
  /** The menu's lines for a right click on `detail` in the view on screen. */
  const offered = ({ view, elements }, detail) => {
    const element = elements[view.side()]
    element.under = { sourceContext: view.side(), ...detail }
    rightClick(element, 300, 250)
    return linesOf(view)
  }
  const net = (value, sheet, uuid) => ({ targetContext: SCH, kind: 'net', value, sheet, uuid })
  /** The menu for `detail` clicked on the schematic (`menuFor`), of the
   *  design's members `members`: its rows, the active one starred, a place's
   *  as its uuid, the board's as its line and the board's name of the net. */
  const rowsOf = (detail, members = designMembers(DOCS, DOCS[0])) => {
    const menu = menuFor(SCH, { sourceContext: SCH, ...detail }, members, null, NETS)
    return menu && menu.rows.map((row, i) => (i === menu.active ? '*' : '')
      + (row.request.uuid || `${row.label} → ${row.request.value}`))
  }
  /** The design without its board. */
  const NO_BOARD = designMembers([DOCS[0], DOCS[2]], DOCS[0])

  it('a power symbol is its net: every place of it on every sheet, the one clicked active, and the board; a power flag none', () => {
    const board = '+12V · hw/board.kicad_pcb → +12V'
    expect(rowsOf({ itemType: 'symbol', reference: '#PWR0101', uuid: 'pwr-board' }))
      .toEqual(['*pwr-board', 'pwr-power', 'pwr-power-2', board])
    expect(rowsOf({ itemType: 'symbol', reference: '#PWR0201', uuid: 'pwr-power' }))
      .toEqual(['pwr-board', '*pwr-power', 'pwr-power-2', board])
    expect(rowsOf({ itemType: 'symbol', reference: '#FLG0201', uuid: 'flg-power' })).toBeNull()
    // a place's row is `<sheet>:<name>`, asked for on its sheet at its occurrence
    const menu = menuFor(SCH, { itemType: 'symbol', reference: '#PWR0201', uuid: 'pwr-power' },
      designMembers(DOCS, DOCS[0]), null, NETS)
    expect(menu.rows.slice(0, 2).map((row) => [row.title, row.label, row.request])).toEqual([
      ['+12V', 'board:+12V', net('+12V', 'hw/board.kicad_sch', 'pwr-board')],
      ['+12V', 'power:+12V', net('+12V', 'hw/sub/power.kicad_sch', 'pwr-power')]])
  })

  it('a pad of the board is its part and its net, the net at every place of it on every sheet', () => {
    const one = withNets(DOCS[1])
    expect(offered(one, { itemType: 'pad', reference: 'C507', pin: '1', net: '+12V', netCode: 4, uuid: 'pad' }))
      .toEqual(['C507 · hw/board.kicad_sch', 'C507 · hw/board.kicad_pcb', 'C507 · hw/board.glb',
        'board:+12V', 'power:+12V', 'power:+12V', '+12V · hw/board.kicad_pcb'])
    expect(headOf(one.view)).toEqual(['C507', '‹', '2 / 7', '›'])
  })

  it('a global label, and the wire it is on, has its namesakes and every place of the net of the sheet pin wired to it', () => {
    // a wire, no place itself, opens on the place its net is named after
    for (const detail of [{ itemType: 'global-label', net: 'AMP_CLIP_OTW', uuid: 'clip-board' }, { itemType: 'wire', uuid: 'wire-clip' }]) {
      expect(rowsOf(detail)).toEqual(['*clip-board', 'pin-fault-power', 'pin-fault-dsp', 'clip-power', 'fault-power',
        'fault-dsp', 'AMP_CLIP_OTW · hw/board.kicad_pcb → AMP_CLIP_OTW'])
    }
    // that place is not the first one of the net
    const nets = netIndex({
      'hw/board.kicad_sch': `(kicad_sch ${global('AMP_CLIP_OTW', 'clip-board')} ${sheetSymbol('power')})`,
      'hw/sub/power.kicad_sch': `(kicad_sch ${global('AMP_CLIP_OTW', 'clip-power', '50.8 25.4 0')}`
        + ' (wire (pts (xy 50.8 25.4) (xy 63.5 25.4)) (uuid "wire-power")))',
    }, 'hw/board.kicad_sch')
    const menu = menuFor(SCH, { sourceContext: SCH, itemType: 'wire', uuid: 'wire-power' },
      designMembers(DOCS, DOCS[0]), null, nets)
    expect(menu.rows[menu.active].request.uuid).toBe('clip-power')
  })

  it('is as wide as its longest line needs, so the name a line ends with is not cut', () => {
    // a page that lays a line out 7px a character; jsdom lays out nothing
    const rect = vi.spyOn(HTMLSpanElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function () { return { width: this.textContent.length * 7 } })
    const one = withNets(DOCS[1])
    const lines = offered(one, { itemType: 'track', net: '/dsp/AMP_FAULT', netCode: 1 })
    rect.mockRestore()
    // the longest line is not the first row's
    const longest = Math.max(...lines.map((line) => line.length))
    expect([longest > lines[0].length, menuOf(one.view).props.style.width]).toEqual([true, `${longest * 7 + 28}px`])
  })

  it('a local label is a net of its own sheet: no menu without the board, nor for a net no sheet names', () => {
    const local = { itemType: 'label', net: 'AMP_CLIP_OTW', uuid: 'clip-local' }
    const unnamed = { itemType: 'global-label', net: 'EFUSE_PGOOD' }
    expect([rowsOf(local), rowsOf(unnamed), rowsOf(local, NO_BOARD), rowsOf(unnamed, NO_BOARD)]).toEqual([
      ['*clip-local', 'AMP_CLIP_OTW · hw/board.kicad_pcb → /dsp/AMP_CLIP_OTW'], null, null, null])
  })

  it('a hierarchical label, and a sheet pin of its name, are one net with its namesakes and the root\'s pins, the board asked by its name', () => {
    const board = 'AMP_FAULT · hw/board.kicad_pcb → /dsp/AMP_FAULT'
    expect(rowsOf({ itemType: 'hierarchical-label', net: 'AMP_FAULT', uuid: 'fault-power' }))
      .toEqual(['pin-fault-power', 'pin-fault-dsp', '*fault-power', 'fault-dsp', board])
    expect(rowsOf({ itemType: 'sheet-pin', net: 'AMP_FAULT', uuid: 'pin-fault-power' }))
      .toEqual(['*pin-fault-power', 'pin-fault-dsp', 'fault-power', 'fault-dsp', board])
  })

  it('a track is shown at every place of its net, the root through its pin, each asked for there', () => {
    const one = withNets(DOCS[1])
    expect(offered(one, { itemType: 'track', net: '/dsp/AMP_FAULT', netCode: 1 })).toEqual(['board:AMP_FAULT',
      'board:AMP_FAULT', 'power:AMP_FAULT', 'dsp:AMP_FAULT', '/dsp/AMP_FAULT · hw/board.kicad_pcb'])
    expect(headOf(one.view)).toEqual(['/dsp/AMP_FAULT', '‹', '5 / 5', '›'])
    itemsOf(one.view)[2].props.onClick()
    expect(one.view.props.onOpen).toHaveBeenCalledWith('hw__board.kicad_sch')
    expect(one.elements[SCH].requestCrossProbe).toHaveBeenLastCalledWith(net('AMP_FAULT', 'hw/sub/power.kicad_sch', 'fault-power'))
  })

  it('opens for a net of the schematic by either button, the left at the press, and for a part by the right alone', () => {
    const { view, elements } = withNets()
    const sch = elements[SCH]
    // a left click on a power symbol: the press, then the viewer's own click
    sch.under = { sourceContext: SCH, itemType: 'symbol', reference: '#PWR0201', uuid: 'pwr-power' }
    rightClick(sch, 120, 80, 0, 0)
    click(sch, sch.under)
    expect([menuOf(view).props.style.left, menuOf(view).props.style.top, headOf(view), linesOf(view)]).toEqual(['120px',
      '30px', ['+12V', '‹', '2 / 4', '›'], ['board:+12V', 'power:+12V', 'power:+12V', '+12V · hw/board.kicad_pcb']])
    // a left click on a part opens nothing, a right one its menu
    sch.under = { sourceContext: SCH, itemType: 'symbol', reference: 'C523', uuid: 'c523' }
    rightClick(sch, 300, 250, 0, 0)
    click(sch, sch.under)
    expect(headOf(view)[0]).toBe('+12V')
    rightClick(sch, 300, 250)
    expect(linesOf(view)).toEqual(['C523 · hw/board.kicad_sch', 'C523 · hw/board.kicad_pcb', 'C523 · hw/board.glb'])
    // a right click on a label: at the pointer, on the place clicked
    sch.under = { sourceContext: SCH, itemType: 'hierarchical-label', net: 'AMP_FAULT', uuid: 'fault-dsp' }
    rightClick(sch, 300, 250)
    expect([menuOf(view).props.style.top, headOf(view)]).toEqual(['200px', ['AMP_FAULT', '‹', '4 / 5', '›']])
    // its board row opens the board, which is asked for the net by the board's name of it
    itemsOf(view).at(-1).props.onClick()
    expect(view.props.onOpen).toHaveBeenCalledWith('hw__board.kicad_pcb')
    expect(elements[PCB].requestCrossProbe).toHaveBeenLastCalledWith({ targetContext: PCB, kind: 'net', value: '/dsp/AMP_FAULT' })
  })

  describe('asks the board for a label\'s net by the board\'s name of it', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('a local label\'s with its sheet\'s path in front, a global label\'s bare; the row shows the label\'s own', async () => {
      // The root's sheet symbol `amp` points at the design's other file: the
      // path is the sheet's name, not its file's.
      const files = {
        'hw/board.kicad_sch': '(kicad_sch (sheet (at 0 0) (uuid "sheet-amp") (property "Sheetname" "amp")'
          + ' (property "Sheetfile" "sub/power.kicad_sch")))',
        'hw/sub/power.kicad_sch': '(kicad_sch (label "OUT_C" (at 0 0 0) (uuid "out-c"))'
          + ` ${global('AMP_FAULT', 'fault')})`,
      }
      vi.stubGlobal('fetch', vi.fn(async (url) => new Response(files[url.slice(BASE.length)] || `<${url}>`)))
      const one = mounted()
      one.view.componentDidMount()
      await vi.waitFor(() => expect(one.view.state.ready).toBe(true))
      for (const [detail, board] of [[{ itemType: 'label', net: 'OUT_C', uuid: 'out-c' }, '/amp/OUT_C'],
        [{ itemType: 'global-label', net: 'AMP_FAULT', uuid: 'fault' }, 'AMP_FAULT']]) {
        one.view.props.onOpen(DOCS[0].id)
        one.elements[SCH].under = { sourceContext: SCH, ...detail }
        rightClick(one.elements[SCH], 300, 250)
        const row = itemsOf(one.view).at(-1)
        row.props.onClick()
        expect([texts(row), one.elements[PCB].requestCrossProbe.mock.lastCall])
          .toEqual([[`${detail.net} · hw/board.kicad_pcb`], [{ targetContext: PCB, kind: 'net', value: board }]])
      }
      one.view.componentWillUnmount()
    })
  })
})

describe('a part\'s datasheet', () => {
  const tpa = { id: 'hw__ds__tpa3250.pdf', name: 'TPA3250', type: 'pdf', file: 'hw/ds/tpa3250.pdf', bytes: 9, hidden: true }
  const docs = [...DOCS, tpa]
  const SHEETS = new Map([['U501', '${KIPRJMOD}/ds/tpa3250.pdf'], ['C1', '../ds/ne555.pdf'], ['#PWR01', 'ds/ne555.pdf']])
  /** The design with its parts' `Datasheet` values read, `doc` on screen. */
  const withSheets = (doc = docs[0], documents = docs) => {
    const one = mounted(doc, documents)
    one.view.setState({ ready: true, datasheets: SHEETS })
    return one
  }
  /** The menu's lines for a right click on `detail` in `context`, on screen. */
  const offered = ({ view, elements }, context, detail) => {
    view.props = { ...view.props, doc: view.members()[context] }
    elements[context].under = { sourceContext: context, ...detail }
    rightClick(elements[context], 300, 250)
    return linesOf(view)
  }

  it('is a row of a part\'s menu after its members, in every view, when its field names a document of the build', () => {
    const one = withSheets()
    const sheet = 'Datasheet · TPA3250'
    expect(offered(one, SCH, { itemType: 'symbol', reference: 'U501' }))
      .toEqual(['U501 · hw/board.kicad_sch', 'U501 · hw/board.kicad_pcb', 'U501 · hw/board.glb', sheet])
    expect(offered(one, PCB, { itemType: 'pad', reference: 'U501', pin: '3', net: 'GND' })).toEqual(['U501 · hw/board.kicad_sch',
      'U501 · hw/board.kicad_pcb', 'U501 · hw/board.glb', sheet, 'GND · hw/board.kicad_sch', 'GND · hw/board.kicad_pcb'])
    // in the menu's own rows, and nothing drawn for it anywhere else
    expect(itemsOf(one.view).map((item) => item.props['data-show'])).toEqual([SCH, PCB, BOARD3D, 'datasheet', SCH, PCB])
    expect(itemsOf(one.view)[3].props.style).toEqual(itemsOf(one.view)[2].props.style)
    expect(collect(one.view.render(), (el) => el.props['data-datasheet'])).toEqual([])
    one.view.props = { ...one.view.props, doc: docs[2] }
    view3d(one.view).three.props.onMenu('U501', 300, 250)
    expect(linesOf(one.view).at(-1)).toBe(sheet)
    // a path from the schematic's directory; no document, a net, a power symbol: no row
    expect([
      offered(one, PCB, { itemType: 'footprint', reference: 'C1' }), offered(one, PCB, { itemType: 'footprint', reference: 'R104' }),
      offered(one, PCB, { itemType: 'track', net: 'GND' }), offered(one, SCH, { itemType: 'symbol', reference: '#PWR01' }),
    ].map((lines) => lines && lines.at(-1))).toEqual(['Datasheet · ds/ne555.pdf', 'R104 · hw/board.glb',
      'GND · hw/board.kicad_pcb', null])
  })

  it('is the menu, beside the part\'s own row, of a part with no other member', () => {
    const lone = withSheets(schematic(), [schematic(), pdf, tpa])
    expect(offered(lone, SCH, { itemType: 'symbol', reference: 'U501' })).toEqual(['U501 · hw/board.kicad_sch',
      'Datasheet · TPA3250'])
    expect(offered(lone, SCH, { itemType: 'symbol', reference: 'R104' })).toBeNull()
  })

  describe('opens in a window over the design', () => {
    /** The window as drawn: the veil over the view area, the window on it, its
     *  `×` and the document view it draws. */
    const windowOf = (view) => {
      const [veil] = collect(view.render(), (el) => (el.props['data-sheet'] ? el : undefined))
      if (!veil) return undefined
      const pick = (test) => collect(veil, (el) => (test(el) ? el : undefined))[0]
      return { veil, window: pick((el) => el.props.role === 'dialog'), close: pick((el) => el.props.title === 'Close'),
        body: ofType(veil, DocumentView)[0] }
    }
    /** The board on screen with U501 selected and its datasheet's window open. */
    const opened = (one = withSheets(docs[1])) => {
      offered(one, PCB, { itemType: 'footprint', reference: 'U501' })
      itemsOf(one.view).at(-1).props.onClick()
      return one
    }
    /** A click on `target`, as React hands it to the veil's `onClick`. */
    const clickVeil = (shown, target) => shown.veil.props.onClick({ target, currentTarget: shown.veil })

    it('drawn as the page draws a document, the page asked for nothing and the design left as it was', () => {
      const { view, elements } = opened()
      const shown = windowOf(view)
      // the menu stays on the board's row: a datasheet is no place
      expect([view.props.onOpen.mock.calls, view.props.doc.id, view.state.menu.active, view.state.selected])
        .toEqual([[], 'hw__board.kicad_pcb', 1, 'U501'])
      expect([elements[PCB].clearSelection.mock.calls, elements[SCH].clearSelection.mock.calls]).toEqual([[], []])
      expect(shown.body.props).toMatchObject({ doc: tpa, base: BASE })
      // the viewer's own keys (`[`, `]`) stand aside for an open dialog of the page
      expect(shown.window.props).toMatchObject({ role: 'dialog', 'data-state': 'open' })
      expect(texts(shown.veil)).toEqual(['TPA3250', '×'])
      // over the view area
      expect(shown.veil.props.style).toMatchObject({ position: 'absolute', inset: '0', padding: '12px' })
    })

    it('closes on its ×, and on a click on the veil beside it but not on one inside it', () => {
      const one = opened()
      const { view } = one
      windowOf(view).close.props.onClick()
      expect(windowOf(view)).toBeUndefined()
      const shown = windowOf(opened(one).view)
      clickVeil(shown, shown.body)
      expect(windowOf(view)).toBeDefined()
      clickVeil(shown, shown.veil)
      expect([windowOf(view), view.state.selected]).toEqual([undefined, 'U501'])
    })

    it('Escape closes it alone and is taken, the menu and the part left; the next the menu, the third puts the part out', () => {
      const { view, elements } = opened()
      view.listen(true)
      const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
      window.dispatchEvent(escape)
      expect([windowOf(view), escape.defaultPrevented, Boolean(menuOf(view)), view.state.selected,
        elements[PCB].clearSelection.mock.calls]).toEqual([undefined, true, true, 'U501', []])
      window.dispatchEvent(ESCAPE())
      expect([menuOf(view), view.state.selected]).toEqual([undefined, 'U501'])
      window.dispatchEvent(ESCAPE())
      expect([view.state.selected, elements[PCB].clearSelection.mock.calls.length]).toEqual([null, 1])
      view.componentWillUnmount()
    })

    it('is passed over by the arrows, which close it and count the places alone, and opened by its row', () => {
      const { view } = opened()
      expect(headOf(view)[2]).toBe('2 / 3')
      const seen = []
      for (const title of ['Next', 'Next', 'Previous']) {
        arrow(view, title)
        seen.push([Boolean(windowOf(view)), view.props.doc.id, headOf(view)[2]])
      }
      expect(seen).toEqual([[false, 'hw__board.glb', '3 / 3'], [false, 'hw__board.kicad_sch', '1 / 3'],
        [false, 'hw__board.glb', '3 / 3']])
      // over the member then on screen
      itemsOf(view).at(-1).props.onClick()
      expect([windowOf(view).body.props.doc, view.props.doc.id, headOf(view)[2]]).toEqual([tpa, 'hw__board.glb', '3 / 3'])
    })

    it('goes when its view leaves the screen', () => {
      const { view } = opened()
      view.props = { ...view.props, doc: docs[0] }
      expect(windowOf(view)).toBeUndefined()
      view.componentDidUpdate()
      expect(view.state.sheet).toBeNull()
    })
  })
})

describe('what the page\'s bar can do with the view on screen', () => {
  /** The viewer's own drawing inside `element`, two open shadow trees down,
   *  as the viewer builds it. */
  function withDrawing(element, tag) {
    const app = document.createElement('kc-viewer-app')
    element.attachShadow({ mode: 'open' }).append(app)
    const drawing = document.createElement(tag)
    app.attachShadow({ mode: 'open' }).append(drawing)
    drawing.canvas = document.createElement('canvas')
    drawing.viewer = { zoom_fit_top_item: vi.fn(), draw_now: vi.fn() }
    return drawing
  }
  const told = (view) => view.props.onTools.mock.calls.map(([tools]) => tools)
  const show = (view, doc) => {
    view.props = { ...view.props, doc }
    view.componentDidUpdate()
  }

  it('is nothing until the files are in, then Fit and Frame for whichever drawing is on screen', async () => {
    const { view, elements } = mounted(DOCS[0])
    const drawings = { [SCH]: withDrawing(elements[SCH], 'kc-schematic-viewer'), [PCB]: withDrawing(elements[PCB], 'kc-board-viewer') }
    view.componentDidUpdate()
    expect(told(view)).toEqual([null])
    view.setState({ ready: true })
    view.componentDidUpdate()
    const [, tools] = told(view)
    expect(Object.keys(tools)).toEqual(['fit', 'frame'])
    // the board on screen: the same tools, acting on it
    show(view, DOCS[1])
    expect(told(view)).toHaveLength(2)
    tools.fit()
    expect(drawings[PCB].viewer.zoom_fit_top_item).toHaveBeenCalledTimes(1)
    expect(drawings[SCH].viewer.zoom_fit_top_item).not.toHaveBeenCalled()
    const blob = new Blob(['png'], { type: 'image/png' })
    drawings[PCB].canvas.toBlob = vi.fn((done, type) => {
      expect([type, drawings[PCB].viewer.draw_now.mock.calls.length]).toEqual(['image/png', 1])
      done(blob)
    })
    await expect(tools.frame()).resolves.toBe(blob)
    // a design whose files did not load can do neither
    view.setState({ error: 'hw/board.kicad_pcb did not load: HTTP 404' })
    view.componentDidUpdate()
    expect(told(view).at(-1)).toBeNull()
  })

  it('is what the 3D view says on the 3D model', () => {
    const { view } = mounted(DOCS[0])
    view.setState({ ready: true })
    view.componentDidUpdate()
    show(view, DOCS[2])
    expect(told(view).at(-1)).toBeNull()
    const three = { fit: vi.fn(), frame: vi.fn() }
    view3d(view).three.props.onTools(three)
    view.componentDidUpdate()
    expect(told(view).at(-1)).toBe(three)
    show(view, DOCS[1])
    expect(Object.keys(told(view).at(-1))).toEqual(['fit', 'frame'])
  })

  it('finds the drawing only inside the element', () => {
    expect(drawingOf(document.createElement('ecad-viewer'))).toBeNull()
    expect(drawingOf(undefined)).toBeNull()
  })
})


describe('a comment on a design', () => {
  // The schematic's two sheets as the element lists them, each with its file.
  const ROOT = 'hw/board.kicad_sch:/root'
  const AMP = 'hw/board.kicad_sch:/root/amp'
  const PAGES = [
    { projectPath: ROOT, name: 'board', parentProjectPath: null, filename: 'hw/board.kicad_sch' },
    { projectPath: AMP, name: 'amp', parentProjectPath: ROOT, filename: 'hw/sub/amp.kicad_sch' },
  ]
  // The page's open comments: one on each sheet and one on the board.
  const MARKS = [
    { id: 'c1', doc: 'hw/board.kicad_sch', sheet: 'hw/board.kicad_sch', area: [0, 0, 10, 10] },
    { id: 'c2', doc: 'hw/board.kicad_sch', sheet: 'hw/sub/amp.kicad_sch', area: [10, 20, 4, 6] },
    { id: 'c3', doc: 'hw/board.kicad_pcb', sheet: null, area: [5, 5, 2, 2] },
  ]
  afterEach(() => {
    vi.unstubAllGlobals()
    window.history.replaceState(null, '', '/')
  })

  /** The design opened on `doc` under the page's `comment`, its viewers ready
   *  and drawn, the schematic on its root sheet. */
  const opened = async (doc = DOCS[0], comment = {}) => {
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(`<${url}>`)))
    const { view, elements } = mounted(doc)
    view.props = { ...view.props, comment: {
      on: false, marks: MARKS, onArea: vi.fn(), onMarker: vi.fn(), focus: null, onFocused: vi.fn(), ...comment } }
    for (const element of Object.values(elements)) {
      Object.assign(element, {
        setCommentMode: vi.fn(), setCommentOverlays: vi.fn(), clearCommentOverlays: vi.fn(),
        zoomToLocation: vi.fn(), itemsInArea: vi.fn(() => ['C1', 'R2']),
      })
    }
    const sch = elements[SCH]
    sch.page = ROOT
    sch.getSchematicPages = () => PAGES
    sch.getActiveSchematicPage = () => PAGES.find((one) => one.projectPath === sch.page)
    sch.switchPage = vi.fn((to) => {
      sch.page = to
      sch.dispatchEvent(new CustomEvent(PAGE_EVENT))
      return true
    })
    view.componentDidMount()
    onTestFinished(() => view.componentWillUnmount())
    await vi.waitFor(() => expect(view.state.ready).toBe(true))
    return { view, elements, sch }
  }
  /** The page handing down `comment`, changed. */
  const handed = (view, comment) => {
    const before = view.props
    view.props = { ...before, comment: { ...before.comment, ...comment } }
    view.componentDidUpdate(before)
  }
  const aTask = () => new Promise((done) => { setTimeout(done, 0) })

  it('puts the view on screen alone in the viewer\'s comment mode while the page\'s tool is armed, each told of a change', async () => {
    const { view, elements } = await opened()
    handed(view, { on: true })
    handed(view, { on: true })
    handed(view, { on: false })
    expect([elements[SCH].setCommentMode.mock.calls, elements[PCB].setCommentMode.mock.calls])
      .toEqual([[[true], [false]], [[false]]])
  })

  it('hands the page an area drawn on either view, with the file of its sheet and what is in it', async () => {
    const { view, elements } = await opened(DOCS[0], { on: true })
    const draw = (context, detail) => elements[context].dispatchEvent(new CustomEvent(AREA_EVENT, { detail }))
    draw(SCH, { context: SCH, bounds: [1, 2, 3, 4], page: 'hw/sub/amp.kicad_sch' })
    draw(PCB, { context: PCB, bounds: [5, 6, 7, 8] })
    expect(view.props.comment.onArea.mock.calls).toEqual([
      [DOCS[0], { frame: 'sheet', sheet: 'hw/sub/amp.kicad_sch', area: [1, 2, 3, 4], items: ['C1', 'R2'] }],
      [DOCS[1], { frame: 'board', sheet: null, area: [5, 6, 7, 8], items: ['C1', 'R2'] }],
    ])
    expect(elements[SCH].itemsInArea).toHaveBeenCalledWith(SCH, [1, 2, 3, 4])
  })

  it('stands the open comments on their member, on the schematic the sheet\'s on screen, the new sheet\'s as its page changes', async () => {
    const { view, elements, sch } = await opened()
    view.componentDidUpdate(view.props)
    view.componentDidUpdate(view.props)
    const marker = (id, x, y, area, page) => ({ id, anchor: { kind: 'world', x, y, ...(page ? { page } : {}) }, areaBounds: area })
    expect(elements[PCB].setCommentOverlays.mock.calls)
      .toEqual([[{ context: PCB, comments: [marker('c3', 6, 6, [5, 5, 2, 2])] }]])
    const onRoot = { context: SCH, comments: [marker('c1', 5, 5, [0, 0, 10, 10], 'hw/board.kicad_sch')] }
    const onAmp = { context: SCH, comments: [marker('c2', 12, 23, [10, 20, 4, 6], 'hw/sub/amp.kicad_sch')] }
    expect(sch.setCommentOverlays.mock.calls).toEqual([[onRoot]])
    // handed while the element loads the sheet, and not again once it has
    sch.switchPage(AMP)
    expect(sch.setCommentOverlays.mock.calls).toEqual([[onRoot], [onAmp]])
    sch.dispatchEvent(new CustomEvent(SHEET_LOADED_EVENT))
    await aTask()
    expect([sch.clearCommentOverlays.mock.calls, sch.setCommentOverlays.mock.calls]).toEqual([[], [[onRoot], [onAmp]]])
  })

  it('names the comment of a marker clicked to the page, and the draft\'s none', async () => {
    const { view, elements } = await opened()
    for (const commentId of ['c2', DRAFT_MARK]) {
      elements[SCH].dispatchEvent(new CustomEvent(MARKER_EVENT, { detail: { commentId } }))
    }
    expect(view.props.comment.onMarker.mock.calls).toEqual([['c2']])
  })

  it('shows the place the page asks for on its sheet, then at its centre once the sheet has loaded, a step of history only where asked', async () => {
    const focus = (step) => ({ doc: 'hw/board.kicad_sch', sheet: 'hw/sub/amp.kicad_sch', area: [10, 20, 4, 6], step })
    for (const step of [true, false]) {
      window.history.replaceState(null, '', `${BASE}?d=${DOCS[0].id}`)
      const { view, sch } = await opened()
      const length = window.history.length
      handed(view, { focus: focus(step) })
      expect([sch.switchPage.mock.calls, window.location.search, window.history.length - length])
        .toEqual([[[AMP]], `?d=${DOCS[0].id}&s=amp`, step ? 1 : 0])
      expect(view.props.comment.onFocused).toHaveBeenCalledTimes(1)
      sch.dispatchEvent(new CustomEvent(SHEET_LOADED_EVENT))
      await aTask()
      expect(sch.zoomToLocation.mock.calls).toEqual([[12, 23]])
    }
    // on the board, at once
    const { view, elements } = await opened(DOCS[1])
    handed(view, { focus: { doc: 'hw/board.kicad_pcb', sheet: null, area: [5, 5, 2, 2], step: false } })
    await aTask()
    expect(elements[PCB].zoomToLocation.mock.calls).toEqual([[6, 6]])
  })
})

describe('a comment on the design\'s 3D model', () => {
  const page = () => ({
    on: true, focus: null, onArea: vi.fn(), onMarker: vi.fn(), onFocused: vi.fn(), onLost: vi.fn(),
    marks: [
      { id: 'c1', doc: 'hw/board.glb', part: 'R1' },
      { id: 'draft', doc: 'hw/board.glb', part: 'C2' },
      { id: 'c2', doc: 'hw/board.kicad_pcb', area: [0, 0, 1, 1] },
    ],
  })

  it('hands the model its arrows and keeps the draft out of what the page hears back', () => {
    const comment = page()
    const view = new KicadView({ doc: DOCS[2], documents: DOCS, base: BASE, comment })
    const told = view.comment3D()
    expect(told.on).toBe(true)
    expect(told.marks.map((one) => one.id)).toEqual(['c1', 'draft'])
    told.onMarker('draft')
    told.onMarker('c1')
    expect(comment.onMarker.mock.calls).toEqual([['c1']])
    told.onLost(['draft', 'c1'])
    expect(comment.onLost.mock.calls).toEqual([['hw/board.glb', ['c1']]])
  })

  it('arms the model only while it is on screen', () => {
    const view = new KicadView({ doc: DOCS[1], documents: DOCS, base: BASE, comment: page() })
    expect(view.comment3D().on).toBe(false)
  })
})

describe('the BOM of a design', () => {
  const sch = schematic()
  const listed = withBoms(DOCS)
  const bom = listed[1]

  it('follows each schematic among the build\'s documents, under its file, so it is a member of its design', () => {
    expect(listed.map((doc) => doc.id)).toEqual(['hw__board.kicad_sch', 'hw__board.kicad_sch~bom',
      'hw__board.kicad_pcb', 'hw__board.glb', 'ds__ne555.pdf', 'psu__psu.kicad_pcb'])
    expect(bom).toEqual({ id: 'hw__board.kicad_sch~bom', type: 'bom', name: 'hw/board.kicad_sch · BOM',
      file: sch.file, bytes: sch.bytes, kicad: sch.kicad })
    // the documents the hub listed are the very ones it listed
    expect(listed.filter((doc) => doc !== bom).every((doc, i) => doc === DOCS[i])).toBe(true)
    expect([designKey(bom), docViewKey(bom)]).toEqual([designKey(sch), docViewKey(sch)])
    expect(withBoms([{ ...sch, hidden: true }])[1].hidden).toBe(true)
  })

  it('lists each row\'s designators, and the rows by their first, in KiCad\'s order: the prefix, then the number', () => {
    const rows = bomRows([{ references: ['R10', 'R2', 'R1'] }, { references: ['U10A', 'U2', 'U10'] },
      { references: ['C12'] }, { references: ['TP'] }, { references: ['C3'] }])
    // a designator with no number is all prefix
    expect(rows.map((row) => row.references)).toEqual([['C3'], ['C12'], ['R1', 'R2', 'R10'], ['TP'],
      ['U2', 'U10', 'U10A']])
  })

  it('is listed by the one fetch of meta.json', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ documents: DOCS }))))
    onTestFinished(() => vi.unstubAllGlobals())
    expect((await loadMeta(false, '/b/')).documents.map((doc) => doc.id)).toEqual(listed.map((doc) => doc.id))
  })

  it('has no rename pencil in the list of views: the hub renames what it publishes', () => {
    expect(documentRows(listed, null, () => {}, BASE, 'b', () => {}).map((row) => typeof row.onRename))
      .toEqual(['function', 'undefined', 'function', 'function', 'function', 'function'])
  })

  describe('on screen', () => {
    afterEach(() => vi.unstubAllGlobals())
    const ITEMS = [
      { references: ['R10', 'R2'], value: '10k', footprint: 'R_0603', qty: 2, dnp: false },
      { references: ['C3'], value: '100n', footprint: 'C_0603', qty: 1, dnp: true },
      { references: ['C4'], value: '1u', footprint: 'C_0603', qty: 1, dnp: false },
    ]
    // The root sheet names a datasheet for two parts: a document of the build,
    // by its path from the project's directory, and a web address.
    const SHEET = `(kicad_sch (version 20250610)
      (symbol (lib_id "Device:R") (property "Reference" "R2") (property "Datasheet" "../ds/ne555.pdf"))
      (symbol (lib_id "Device:C") (property "Reference" "C3") (property "Datasheet" "https://www.ti.com/lit/ds/c3.pdf")))`
    /** The view on the BOM of `documents` once the files are in, its
     *  schematic's element computing `ITEMS`. */
    async function opened(documents) {
      vi.stubGlobal('fetch', vi.fn(async (url) => new Response(url === `${BASE}hw/board.kicad_sch` ? SHEET : `<${url}>`)))
      const { view, elements } = mounted(documents.find((one) => one.type === 'bom'), documents)
      elements[SCH].getBomItems = () => ITEMS
      view.componentDidMount()
      await vi.waitFor(() => expect(view.state.ready).toBe(true))
      onTestFinished(() => view.componentWillUnmount())
      return { view, elements }
    }
    const table = (view) => collect(view.render(), (el) => (el.props['data-view'] === BOM ? el : undefined))[0]
    /** The BOM's own drawing, from the props the view hands it. */
    const bomOf = (view) => new BomView(ofType(table(view), BomView)[0].props).render()
    const links = (view) => collect(bomOf(view), (el) => (el.props['data-ref'] ? el : undefined))

    it('lists the schematic\'s parts, a designator opening the board with its part selected once the page hands it down', async () => {
      const { view, elements } = await opened(listed)
      expect(ofType(table(view), BomView)[0].props).toMatchObject({ items: bomRows(ITEMS), hasBoard: true })
      expect(links(view).map((el) => el.props['data-ref'])).toEqual(['C3', 'C4', 'R2', 'R10'])
      // the part is selected in every view at once, hidden as they are, and the
      // board asked again once the page, answering later, has it on screen
      const answer = view.props.onOpen
      view.props.onOpen = vi.fn()
      links(view)[3].props.onClick()
      expect(view.props.onOpen.mock.calls).toEqual([['hw__board.kicad_pcb']])
      expect(elements[SCH].requestCrossProbe.mock.calls).toEqual([[designator(SCH, 'R10')]])
      expect(elements[PCB].requestCrossProbe.mock.calls).toEqual([[designator(PCB, 'R10')]])
      expect(view.state.selected).toBe('R10')
      expect(table(view).props.style.visibility).toBe('visible')
      view.props.onOpen = answer
      answer('hw__board.kicad_pcb')
      expect(elements[PCB].requestCrossProbe.mock.calls).toEqual([[designator(PCB, 'R10')], [designator(PCB, 'R10')]])
      // the table stays, off screen, for Back to find it as it was scrolled
      expect(table(view).props.style.visibility).toBe('hidden')
    })

    it('gives the bar nothing to fit or frame', async () => {
      const { view } = await opened(listed)
      view.componentDidUpdate(view.props)
      expect(view.props.onTools.mock.lastCall).toEqual([null])
    })

    it('opens a datasheet of the build in the window over it, and a web one in a new tab', async () => {
      const { view } = await opened(listed)
      const cells = collect(bomOf(view), (el) => (el.type === 'tr' && el.key !== null ? el : undefined))
        .map((row) => collect(row, (el) => (el.type === 'td' ? el : undefined)).at(-1))
      // a grouped row's is its first designator's: R2's, not R10's
      const [web, none, doc] = cells.map((cell) => collect(cell, (el) => el)[1])
      expect(web.props).toMatchObject({ href: 'https://www.ti.com/lit/ds/c3.pdf', target: '_blank', rel: 'noopener noreferrer',
        children: 'www.ti.com' })
      expect([none, texts(cells[1]), texts(doc)]).toEqual([undefined, [''], ['ds/ne555.pdf']])
      doc.props.onClick()
      expect(view.state.sheet).toEqual({ doc: pdf, from: BOM })
      expect(collect(view.render(), (el) => el.props['data-sheet'])).toEqual([pdf.id])
      expect(view.props.onOpen).not.toHaveBeenCalled()
    })

    it('hands a design with no board its designators as plain text', async () => {
      const { view } = await opened(withBoms([schematic(), pdf]))
      expect(ofType(table(view), BomView)[0].props.hasBoard).toBe(false)
    })
  })
})
