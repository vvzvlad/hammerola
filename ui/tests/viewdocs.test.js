// A model's documents, as rows of its list of views.
//
// The files a project.json lists to be read ride on the model's own page: below
// the views in the toolbar's list, one row each, and choosing one lays it over
// the model while the viewport stays mounted underneath. Choosing a view brings
// the model back. `?d=` opens one on arrival, as `?v=` opens a view, and the
// list does not move the address, as it does not for a view.
//
// The arrangement of the rest of this directory: the real prototype with the
// state spelled out (`component.js`), `computed()` read for values and `render()`
// for what was drawn (`eltree.js`). The two hub fetches `load()` makes are
// mocked, as ui/tests/tabs.test.js does.

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

const { PAGE } = vi.hoisted(() => ({
  PAGE: { pid: 'proj1', slot: 'latest', base: '/project/proj1/latest/' },
}))

vi.mock('../src/hub.js', async (importOriginal) => ({
  ...(await importOriginal()),
  PAGE,
  loadMeta: vi.fn(),
  loadBuilds: vi.fn(),
}))

import DocumentView from '../src/DocumentView.jsx'
import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { loadBuilds, loadMeta } from '../src/hub.js'
import { STATE, VIEWPORT_TAG } from '../src/events.js'
import { css } from '../src/style.jsx'
import { DOC_LIST, VIEW_LIST, viewMenuStyle } from '../src/viewlist.jsx'
import { makeComponent, replaceState } from './component.js'
import { collect, texts } from './eltree.js'

const DOCS = [
  { id: 'docs__cut-list.md', name: 'docs/cut-list.md', type: 'markdown',
    file: 'docs/cut-list.md', bytes: 7765 },
  { id: 'ref__terr-raspil.svg', name: 'ref/terr-raspil.svg', type: 'svg',
    file: 'ref/terr-raspil.svg', bytes: 4235 },
]

// Two KiCad designs, a schematic and a board each, every one a document with
// its own title, and a datasheet listed hidden.
const SUFFIX = { schematic: 'kicad_sch', board: 'kicad_pcb' }
function kicad(stem, type, name) {
  const file = `${stem}.${SUFFIX[type]}`
  return { id: file.replaceAll('/', '__'), name, type, file, bytes: 4_612_345,
    kicad: { ...(type === 'schematic' ? { schematics: [file] } : {}), project: `${stem}.kicad_pro` } }
}
const KICAD = [kicad('hw/main', 'schematic', 'Главная · схема'), kicad('hw/main', 'board', 'Главная · плата'),
  kicad('hw/psu', 'schematic', 'БП · схема'), kicad('hw/psu', 'board', 'БП · плата')]
const DATASHEET = { id: 'ds__ne555.pdf', name: 'ds/ne555.pdf', type: 'pdf', file: 'ds/ne555.pdf',
  bytes: 9, hidden: true }

// Two views: few enough that without documents the views are a strip of tabs.
const VIEWS = [
  { id: 'closed', name: 'closed', file: 'closed.json', parts: ['lid'], gzip: 1000 },
  { id: 'open', name: 'open', file: 'open.json', parts: ['lid'], gzip: 1000 },
]

// The bar's tools, in the order it draws them, and the styles they are drawn
// with.
const TOOLS = ['Measure', 'Comment', 'Add primitive', 'Fit', 'Frame', 'Settings']
const TOOL_STYLES = ['measureBtnStyle', 'commentBtnStyle', 'proposalBtnStyle', 'fitBtnStyle', 'frameBtnStyle',
  'settingsBtnStyle']

const meta = (documents = DOCS) => ({
  project: 'terrarium', title: 'Terrarium (terrarium)', commit: 'abc1234',
  built: '', parts: { lid: { kind: 'printable' } }, views: VIEWS,
  ...(documents ? { documents } : {}),
})

function component(state = {}) {
  return makeComponent(HammerolaViewer, {
    state: { meta: meta(), view: 'closed', rail: null, menu: { id: null, x: 0, y: 0 }, ...state },
  })
}

const drawn = (c) => texts(c.render())
const shownDocs = (c) => collect(c.render(), (el) => (el.type === DocumentView ? el : undefined))
const viewports = (c) => collect(c.render(), (el) => (el.type === VIEWPORT_TAG ? el : undefined))
const LIT = 'var(--accent-bg)'
// The elements of one render drawn with this style string: `css()` caches by
// string.
const drawnAs = (tree, style) => collect(tree, (el) => (el.props.style === css(style) ? el : undefined))

afterEach(() => {
  window.history.replaceState(null, '', '/')
  vi.clearAllMocks()
})

describe('the documents in the list of views', () => {
  it('follow the views, a row each, with their type and size where a view has its parts', () => {
    const v = component().computed()
    // Two views would be a strip; the documents are rows of a list, so a build
    // listing any gets the list.
    expect(v.viewMenu).toBe(true)
    expect(v.viewTabs.map((t) => t.label)).toEqual(['closed', 'open'])
    expect(v.docRows.map((t) => [t.label, t.hint])).toEqual([
      ['docs/cut-list.md', 'markdown · 7.8 kB'],
      ['ref/terr-raspil.svg', 'svg · 4.2 kB']])
    const shown = drawn(component())
    expect(shown.indexOf('open')).toBeLessThan(shown.indexOf('docs/cut-list.md'))
    expect(shown).toContain('markdown · 7.8 kB')
  })

  it('are not there for a build that lists none, which keeps its strip', () => {
    const v = component({ meta: meta(null) }).computed()
    expect(v.docRows).toEqual([])
    expect(v.viewMenu).toBe(false)
    expect(v.docOpen).toBeNull()
  })

  it('lay the chosen document over the model, which stays mounted under it', () => {
    const c = component({ viewsOpen: true })
    c.computed().docRows[0].onClick()
    expect(c.state.doc).toBe('docs__cut-list.md')
    expect(c.state.viewsOpen).toBe(false)
    // As a view, the choice does not move the address.
    expect(window.location.search).toBe('')

    const v = c.computed()
    expect(v.docOpen.id).toBe('docs__cut-list.md')
    expect(v.viewLabel).toBe('docs/cut-list.md')
    expect(v.docRows[0].rowStyle).toContain(LIT)
    expect(v.viewTabs[0].rowStyle).not.toContain(LIT)

    const [doc] = shownDocs(c)
    expect(doc.props.doc.file).toBe('docs/cut-list.md')
    expect(doc.props.base).toBe(PAGE.base)
    expect(viewports(c)).toHaveLength(1)
  })

  it('keep the whole bar over one, its tools out of service, and take the parts tree away', () => {
    // The same controls in the same places over the model and over a document.
    const model = component({ token: 'secret' })
    const c = component({ token: 'secret', doc: 'ref__terr-raspil.svg' })
    for (const page of [model, c]) expect(drawn(page).filter((word) => TOOLS.includes(word))).toEqual(TOOLS)
    // Over a picture every one of them is grey and takes no click; over the
    // model none is.
    for (const key of TOOL_STYLES) {
      expect(css(c.computed()[key]), key).toMatchObject({ color: 'var(--text-faint)', cursor: 'default', pointerEvents: 'none' })
      expect(css(model.computed()[key]).pointerEvents, key).toBeUndefined()
    }
    // The list that brings the model back stays, captioned with the document.
    expect(drawn(c)).toContain('ref/terr-raspil.svg')
    const tree = collect(c.render(), (el) => (
      el.props.style && el.props.style.zIndex === '10' ? el : undefined))
    expect(tree.map((el) => el.props.style.display)).toEqual(['none'])
  })

  it('drive Fit and Frame through the view of a document that can, and save the frame named after the build', async () => {
    const gerbers = { id: 'fab__board.zip', name: 'fab/board.zip', type: 'gerbers', file: 'fab/board.zip', bytes: 9 }
    const c = component({ meta: meta([...DOCS, gerbers]), doc: gerbers.id })
    const live = () => ['fitBtnStyle', 'frameBtnStyle'].map((key) => css(c.computed()[key]).pointerEvents !== 'none')
    expect(live()).toEqual([false, false])
    // the view says what it can do once it has drawn the zip
    const blob = new Blob(['png'], { type: 'image/png' })
    const tools = { fit: vi.fn(), frame: vi.fn(async () => blob) }
    shownDocs(c)[0].props.onTools(tools)
    expect(live()).toEqual([true, true])
    c.computed().fitView()
    expect(tools.fit).toHaveBeenCalledTimes(1)
    const saved = []
    // jsdom has neither; the page hands the blob over by an object URL.
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:frame'), revokeObjectURL: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() { saved.push(this.download) })
    await c.computed().grabFrame()
    expect(saved).toEqual(['terrarium-abc1234.png'])
    // a view that goes takes them with it
    shownDocs(c)[0].props.onTools(null)
    expect(live()).toEqual([false, false])
    vi.restoreAllMocks()
  })

  it('give the model back when a view is chosen, the one on screen included', () => {
    const c = component({ doc: 'docs__cut-list.md', viewsOpen: true })
    c.computed().viewTabs[0].onClick()
    expect(c.state.doc).toBeNull()
    expect(c.state.view).toBe('closed')
    expect(c.state.viewsOpen).toBe(false)
    expect(shownDocs(c)).toEqual([])
    expect(drawn(c)).toContain('Fit')

    c.state.doc = 'docs__cut-list.md'
    c.computed().viewTabs[1].onClick()
    expect([c.state.doc, c.state.view]).toEqual([null, 'open'])
  })

  it('start the card at the button, whatever is on screen: the button never stands in the bar alone', () => {
    expect(css(viewMenuStyle(true))).toMatchObject({ left: '0' })
    expect(css(viewMenuStyle(true)).transform).toBeUndefined()
    for (const over of [{ doc: 'docs__cut-list.md' }, {}, { doc: 'docs__cut-list.md', narrow: true }]) {
      const c = component({ viewsOpen: true, ...over })
      expect(drawnAs(c.render(), viewMenuStyle(true))).toHaveLength(1)
      expect(drawn(c)).toContain('Fit')
    }
  })

  it('stay in sight under twelve views: those scroll, the documents do not', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({ ...VIEWS[0], id: `v${i}`, name: `view ${i}` }))
    const c = component({ meta: { ...meta(), views: twelve }, view: 'v0', viewsOpen: true })
    const v = c.computed()
    const tree = c.render()
    const [menu] = drawnAs(tree, viewMenuStyle(true))
    const [views] = drawnAs(tree, VIEW_LIST)
    const [docs] = drawnAs(tree, DOC_LIST)
    // The card holds the scroll of the views and the documents, in that order,
    // and scrolls none of them itself.
    expect(menu.props.children.filter(Boolean)).toEqual([views, docs])
    expect(css(viewMenuStyle(true))).toMatchObject({ display: 'flex', flexDirection: 'column', maxHeight: '308px' })
    expect(css(viewMenuStyle(true)).overflow).toBeUndefined()
    expect(css(VIEW_LIST)).toMatchObject({ overflow: 'auto', minHeight: '0', flex: '1 1 auto' })
    expect(texts(views)).toContain('view 11')
    expect(texts(views)).not.toContain('docs/cut-list.md')
    // The documents keep their height and scroll on their own past four rows.
    expect(css(DOC_LIST)).toMatchObject({ flex: 'none', maxHeight: '132px', overflow: 'auto' })
    expect(texts(docs)).toEqual(['docs/cut-list.md', 'markdown · 7.8 kB', 'ref/terr-raspil.svg', 'svg · 4.2 kB'])
  })

  it('cover the model to its bottom edge, under the toolbar, and stop the text above the toolbar', () => {
    const v = component({ doc: 'docs__cut-list.md' }).computed()
    const layer = css(v.docLayerStyle)
    // To the bottom edge: what the model draws there (the view cube, the
    // "drag — orbit" hint) is under the document rather than beside it.
    expect(layer).toMatchObject({ position: 'absolute', top: '0', left: '0', right: '0', bottom: '0' })
    expect(Number(css(v.toolbarStyle).zIndex)).toBeGreaterThan(Number(layer.zIndex))
    // The toolbar's strip, 12px off the bottom and about 50px tall, is padding
    // at the end of what scrolls.
    expect(layer).toMatchObject({ overflow: 'auto', paddingBottom: '72px', boxSizing: 'border-box' })
  })

  it('leave the comment draft hidden under one, not dropped, and give it back with the model', () => {
    const composer = { part: '', partId: null, key: null, p: null, text: 'too thin', photo: null }
    const c = component({ token: 'secret', composer, doc: 'docs__cut-list.md' })
    const v = c.computed()
    // The composer sits at the document's own layer and later in the page, so
    // drawn it would stand over the document.
    expect(css(v.composerStyle).display).toBe('none')
    expect(drawnAs(c.render(), v.composerStyle)).toHaveLength(1)
    c.computed().viewTabs[0].onClick()
    expect(css(c.computed().composerStyle).display).toBe('block')
    expect(c.state.composer.text).toBe('too thin')
  })

  it('put the new-build banner over the document and the toolbar over both', () => {
    const z = (v, key) => Number(css(v[key]).zIndex)
    const open = component({ doc: 'docs__cut-list.md' }).computed()
    expect(z(open, 'docLayerStyle')).toBeLessThan(z(open, 'bannerLayerStyle'))
    expect(z(open, 'bannerLayerStyle')).toBeLessThan(z(open, 'toolbarStyle'))
    // With the model on screen the banner keeps its place under the overlays.
    expect(z(component().computed(), 'bannerLayerStyle')).toBe(13)
    const c = component({ doc: 'docs__cut-list.md' })
    expect(drawnAs(c.render(), c.computed().bannerLayerStyle)).toHaveLength(1)
  })

  it('take the Parts button out of a narrow header, and a comment in the rail brings the model back', () => {
    const narrow = component({ narrow: true, doc: 'docs__cut-list.md' }).computed()
    expect(css(narrow.treeBtnStyle).display).toBe('none')
    expect(css(component({ narrow: true }).computed().treeBtnStyle).display).toBe('flex')

    const comment = {
      id: 'c1', pid: 'proj1', commit: 'abc1234', view: 'closed', part: null, key: null,
      point: null, camera: null, text: 'too thin', status: 'open',
      created: '2026-08-27T18:20:00Z', resolved: null, note: null,
    }
    const c = component({ doc: 'docs__cut-list.md', feed: [comment] })
    c.computed().threads[0].onOpen({ stopPropagation() {} })
    expect([c.state.activePin, c.state.doc]).toEqual(['c1', null])
  })

  it('give each schematic and each board a row of its own, by its title, and a hidden one none', () => {
    const rows = component({ meta: meta([...DOCS, ...KICAD, DATASHEET]) }).computed().docRows
    expect(rows.map((t) => [t.label, t.hint])).toEqual([
      ['docs/cut-list.md', 'markdown · 7.8 kB'],
      ['ref/terr-raspil.svg', 'svg · 4.2 kB'],
      ['Главная · схема', '1 sheet'], ['Главная · плата', 'board'],
      ['БП · схема', '1 sheet'], ['БП · плата', 'board']])
    // Only hidden documents: no rows, so the views keep their strip.
    const hidden = component({ meta: meta([DATASHEET]) }).computed()
    expect([hidden.docRows, hidden.viewMenu]).toEqual([[], false])
  })

  it('open a hidden document by its id, named on the button though it has no row', () => {
    const c = component({ meta: meta([...DOCS, DATASHEET]), doc: DATASHEET.id })
    const v = c.computed()
    expect(v.docOpen.id).toBe(DATASHEET.id)
    expect(v.viewLabel).toBe('ds/ne555.pdf')
    expect(v.docRows.map((t) => t.rowStyle.includes(LIT))).toEqual([false, false])
    expect(shownDocs(c)[0].props.doc.file).toBe('ds/ne555.pdf')
  })

  it('give a page whose only document is hidden and open the menu, naming it', () => {
    const v = component({ meta: meta([DATASHEET]), doc: DATASHEET.id }).computed()
    expect([v.docRows, v.viewMenu, v.viewLabel]).toEqual([[], true, 'ds/ne555.pdf'])
  })

  it('open the member the right-click menu shows a part in, light its row and keep the one view of the design', () => {
    const c = component({ meta: meta(KICAD), doc: KICAD[0].id })
    const lit = () => c.computed().docRows.map((t) => t.rowStyle.includes(LIT))
    expect(lit()).toEqual([true, false, false, false])
    const [before] = shownDocs(c)
    expect(before.props.documents).toBe(KICAD)
    // The page's door for opening a document, which the view calls with the
    // other member's id.
    before.props.onOpen(KICAD[1].id)
    expect(c.state.doc).toBe(KICAD[1].id)
    expect(lit()).toEqual([false, true, false, false])
    expect(c.computed().viewLabel).toBe('Главная · плата')
    const [after] = shownDocs(c)
    expect(after.props.doc.id).toBe(KICAD[1].id)
    expect(after.key).toBe(before.key)
    // another design is another view
    c.computed().docRows[2].onClick()
    expect(shownDocs(c)[0].key).not.toBe(before.key)
  })

  it('show the model for a document this revision does not list', () => {
    const v = component({ doc: 'gone.md' }).computed()
    expect(v.docOpen).toBeNull()
    expect(v.viewLabel).toBe('closed')
  })
})

describe('another revision with a document open', () => {
  it('mounts a new view of it, which fetches that revision\'s text', () => {
    const c = component({ doc: 'docs__cut-list.md' })
    const [before] = shownDocs(c)
    c.state.meta = { ...meta(), commit: 'def5678' }
    const [after] = shownDocs(c)
    expect(after.props.doc.id).toBe(before.props.doc.id)
    expect(after.key).not.toBe(before.key)
  })

  it('mounts a new view of it when the local slot is rebuilt under the same name', () => {
    // In the slot `commit` is `dev` for every build; only `published` moves.
    const c = component({ doc: 'docs__cut-list.md' })
    c.state.meta = { ...meta(), commit: 'dev', dev: true, published: '2026-10-23T10:00:00Z' }
    const [before] = shownDocs(c)
    c.state.meta = { ...c.state.meta, published: '2026-10-23T10:05:00Z' }
    const [after] = shownDocs(c)
    expect(after.key).not.toBe(before.key)
  })

  it('keeps it where that revision lists it, and forgets it where it does not', () => {
    // `leaveBuild` is the list both doors into another build spread.
    expect(component({ doc: 'docs__cut-list.md' }).leaveBuild(true, meta()).state.doc)
      .toBe('docs__cut-list.md')
    const c = component({ doc: 'docs__cut-list.md' })
    const gone = c.leaveBuild(true, meta(null))
    expect(gone.state.doc).toBeNull()
    // So a return to a revision that lists it opens on the model.
    c.state.doc = gone.state.doc
    c.state.meta = meta()
    expect(c.computed().docOpen).toBeNull()
  })
})

describe('?d= on arrival', () => {
  const arrive = async (search) => {
    window.history.replaceState(null, '', `/${search}`)
    const c = component({ view: null })
    loadMeta.mockResolvedValue(meta())
    loadBuilds.mockResolvedValue(null)
    await c.load()
    return c
  }

  it('opens that document over the view the address names', async () => {
    const c = await arrive('?v=open&d=ref__terr-raspil.svg')
    expect([c.state.view, c.state.doc]).toEqual(['open', 'ref__terr-raspil.svg'])
    expect(c.computed().docOpen.file).toBe('ref/terr-raspil.svg')
  })

  it('opens the model when the address names no document', async () => {
    const c = await arrive('?v=open')
    expect(c.state.doc).toBeNull()
    expect(c.computed().docOpen).toBeNull()
  })
})

describe('the model under a document opened on arrival', () => {
  // What the viewport is told to show, one entry per `hmr:state`: the page
  // with the real `setState` contract, so a `set()` reaches `sync()`.
  const arriving = async (search = '?v=open&d=docs__cut-list.md', documents = DOCS, setState = replaceState) => {
    const seen = []
    const listen = (event) => seen.push(event.detail.view)
    window.addEventListener(STATE, listen)
    onTestFinished(() => window.removeEventListener(STATE, listen))
    window.history.replaceState(null, '', `/${search}`)
    const c = makeComponent(HammerolaViewer, {
      state: { meta: meta(documents), view: null, rail: null, menu: { id: null, x: 0, y: 0 } },
      setState, schedulePoll: vi.fn(),
    })
    loadMeta.mockResolvedValue(meta(documents))
    loadBuilds.mockResolvedValue(null)
    await c.load()
    return { c, seen }
  }

  it('waits for the document to have its file, and once given is never taken back', async () => {
    const { c, seen } = await arriving()
    expect(seen).toEqual([null])
    shownDocs(c)[0].props.onReady()
    expect(seen).toEqual([null, 'open'])
    // back to the model on another view: one `hmr:state`, that view's
    c.computed().viewTabs[0].onClick()
    expect(seen).toEqual([null, 'open', 'closed'])
    // another document over it, and that one fetching
    c.computed().docRows[1].onClick()
    c.sync()
    shownDocs(c)[0].props.onReady()
    expect(seen).toEqual([null, 'open', 'closed', 'closed'])
  })

  it('hands the view over once when the document has its file before the page\'s first word to the viewport', async () => {
    // React mounts the document, whose `componentDidMount` tells the page, and
    // only then runs the callback of the `setState` that put it there.
    const callbacks = []
    const later = (c) => vi.fn((patch, done) => {
      c.state = { ...c.state, ...patch }
      if (done) callbacks.push(done)
    })
    const plain = { id: 'cut__glass.dxf', name: 'cut/glass.dxf', type: 'file', file: 'cut/glass.dxf', bytes: 9 }
    const { c, seen } = await arriving('?v=open&d=cut__glass.dxf', [...DOCS, plain], later)
    shownDocs(c)[0].props.onReady()
    callbacks.forEach((done) => done())
    expect(seen).toEqual(['open'])
  })

  it('comes in when the document is closed before it has its file', async () => {
    const { c, seen } = await arriving()
    // the view on screen, chosen again: nothing to switch, the document goes
    c.computed().viewTabs[1].onClick()
    expect(seen).toEqual([null, 'open'])
  })
})
