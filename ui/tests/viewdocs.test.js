// A model's documents, as rows of its list of views.
//
// The files a project.json lists to be read ride on the model's own page: below
// the views in the toolbar's list, one row each, and choosing one lays it over
// the model while the viewport stays mounted underneath. Choosing a view brings
// the model back. `?d=` opens one on arrival, as `?v=` opens a view, and each
// choice is a step of history whose address names it as `?d=` or `?v=`.
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

import CopyLink from '../src/copylink.jsx'
import DocumentView from '../src/DocumentView.jsx'
import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { loadBuilds, loadMeta } from '../src/hub.js'
import { STATE, VIEWPORT_TAG } from '../src/events.js'
import { css } from '../src/style.jsx'
import { DocFile, documentRows, menuRow, SheetRows, toolBar, viewList, viewMenuStyle } from '../src/viewlist.jsx'
import { makeComponent, replaceState } from './component.js'
import { collect, links, texts } from './eltree.js'

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

// A schematic of three files, its root placing the other two, and their texts
// as the build serves them.
const placed = (uuid, name, file, page) => `(sheet (uuid "${uuid}") (property "Sheetname" "${name}")`
  + ` (property "Sheetfile" "${file}") (instances (project "p" (path "/r" (page "${page}")))))`
const SHEET_FILES = {
  'hw/main.kicad_sch': `(kicad_sch (uuid "r") ${placed('a', 'amp', 'amp.kicad_sch', '2')} ${placed('b', 'psu', 'psu.kicad_sch', '3')})`,
  'hw/amp.kicad_sch': '(kicad_sch (uuid "x"))',
  'hw/psu.kicad_sch': '(kicad_sch (uuid "y"))',
}
const MAIN = { ...KICAD[0], kicad: { ...KICAD[0].kicad, schematics: Object.keys(SHEET_FILES) } }

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
  it('follow the views, a row each under its type, with its size where a view has its parts', () => {
    const v = component().computed()
    // Two views would be a strip; the documents are rows of a list, so a build
    // listing any gets the list.
    expect(v.viewMenu).toBe(true)
    expect(v.viewTabs.map((t) => t.label)).toEqual(['closed', 'open'])
    expect(v.docRows.map((t) => [t.group, t.label, t.hint])).toEqual([
      ['MARKDOWN', 'docs/cut-list.md', '7.8 kB'],
      ['SVG', 'ref/terr-raspil.svg', '4.2 kB']])
    const shown = drawn(component())
    expect(shown.indexOf('open')).toBeLessThan(shown.indexOf('docs/cut-list.md'))
    expect(shown.slice(shown.indexOf('MARKDOWN'), shown.indexOf('4.2 kB') + 1)).toEqual(['MARKDOWN',
      'docs/cut-list.md', '7.8 kB', 'SVG', 'ref/terr-raspil.svg', '4.2 kB'])
  })

  it('gather under one heading per type wherever the project lists them, a KiCad design under one', () => {
    // The owner's "чтобы одинаковые типы группировались в группы": notes listed
    // around the schematic, a board and two CSVs of a plain file.
    const note = (name) => ({ ...DOCS[0], id: name, name, file: `${name}.md` })
    const csv = (name) => ({ id: name, name, type: 'file', file: `fab/${name}.csv`, bytes: 4600 })
    const listed = [note('note'), KICAD[0], note('wiring'), csv('BOM'), KICAD[1], note('stackup'), csv('CPL')]
    const shown = drawn(component({ meta: meta(listed), viewsOpen: true }))
    expect(shown.slice(shown.indexOf('3D VIEWS'), shown.lastIndexOf('4.6 kB') + 1)).toEqual(['3D VIEWS', 'closed', '1 parts · 0.0 MB',
      'open', '1 parts · 0.0 MB',
      'MARKDOWN', 'note', '7.8 kB', 'wiring', '7.8 kB', 'stackup', '7.8 kB',
      'KICAD', 'Главная · схема', '1 sheet', 'Главная · плата', 'board',
      'CSV', 'BOM', '4.6 kB', 'CPL', '4.6 kB'])
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
    // The address says what is on screen, so a copied link opens on it.
    expect(window.location.search).toBe('?d=docs__cut-list.md')

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

  it('put the open one\'s Download and Copy link beside the bar, and over the model neither', () => {
    // The strip as the page draws it (`toolBar(v, …)`), without the header's
    // Downloads menu and its own Copy links: the file's buttons in it, none in
    // the bar itself.
    const strip = (state) => {
      const tree = toolBar(component(state).computed())
      return [collect(tree, (el) => (el.type === DocFile ? el.props.href : undefined)),
        links(tree).length + collect(tree, (el) => (el.type === CopyLink ? el : undefined)).length]
    }
    const href = `${PAGE.base}ref/terr-raspil.svg`
    expect(strip({ doc: 'ref__terr-raspil.svg' })).toEqual([[href], 0])
    expect(strip({})).toEqual([[], 0])
  })

  it('download the open one\'s file and copy its link, the word Download in the link\'s title', () => {
    // Words or icons is CSS's to decide (`DocFile`), and how it looks is
    // checked by eye: here only where every copy of the row points.
    const href = `${PAGE.base}ref/terr-raspil.svg`
    const drawn = DocFile({ href })
    // `download`: a PDF, HTML or SVG at the same address would open in the tab instead
    expect(new Set(links(drawn).map((a) => `${a.props.href} ${a.props.title} ${a.props.download}`)))
      .toEqual(new Set([`${href} Download true`]))
    expect(new Set(collect(drawn, (el) => (el.type === CopyLink ? el.props.href : undefined)))).toEqual(new Set([href]))
    // One row the reader can press; the two the layout is sized by are hidden,
    // which takes them out of clicks, focus and what is read out.
    const unseen = []
    const walk = (node, hidden) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) {
        node.forEach((child) => walk(child, hidden))
        return
      }
      if (!node.props) return
      const under = hidden || node.props.style?.visibility === 'hidden'
      if (node.type === 'a') unseen.push(under)
      walk(node.props.children, under)
    }
    walk(drawn, false)
    expect(unseen.sort()).toEqual([false, true, true])
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
    window.history.replaceState(null, '', '/?files=K&d=docs__cut-list.md')
    const c = component({ doc: 'docs__cut-list.md', viewsOpen: true })
    c.computed().viewTabs[0].onClick()
    expect(c.state.doc).toBeNull()
    expect(c.state.view).toBe('closed')
    expect(c.state.viewsOpen).toBe(false)
    expect(shownDocs(c)).toEqual([])
    expect(drawn(c)).toContain('Fit')
    // And the address stops naming the document; the rest of it stays.
    expect(window.location.search).toBe('?files=K')

    c.state.doc = 'docs__cut-list.md'
    c.computed().viewTabs[1].onClick()
    expect([c.state.doc, c.state.view]).toEqual([null, 'open'])
  })

  it('make each choice a step of history, with the frame only of the view it stays on, and the row shown none', () => {
    // Back returns to the choice before (`pushChoice`). The frame describes the
    // model on screen: a document's entry carries none, nor another view's,
    // whose own frame `onModel` writes once it is drawn, nor a schematic's
    // sheet (`s=`) another document's. The rest of the address stays, and so
    // does the state of the entry.
    window.history.replaceState({ hmr: 'latest' }, '', '/?d=hw__a.kicad_sch&files=K&s=amp')
    const c = component()
    c.host = { current: { getCamera: () => ({
      position: [10, -20, 30.5], quaternion: [0, 0, 0, 1], target: [1, 2, 3], zoom: 1.5 }) } }
    const push = vi.spyOn(window.history, 'pushState')
    onTestFinished(() => push.mockRestore())
    const entries = () => [push.mock.calls.length, window.location.search]
    c.computed().docRows[0].onClick()
    expect(entries()).toEqual([1, '?files=K&d=docs__cut-list.md'])
    expect(window.history.state).toEqual({ hmr: 'latest' })
    c.computed().docRows[0].onClick()
    c.computed().viewTabs[0].onClick()
    expect(entries()).toEqual([2, '?files=K&c=10,-20,30.5,0,0,0,1,1,2,3,1.5'])
    c.computed().viewTabs[1].onClick()
    expect(entries()).toEqual([3, '?files=K&v=open'])
    c.computed().viewTabs[1].onClick()
    expect(push).toHaveBeenCalledTimes(3)
  })

  it('make a sheet chosen under a schematic a step whose address names it, the root none, on the schematic on screen too', () => {
    window.history.replaceState({ hmr: 'latest' }, '', '/?files=K')
    const c = component({ meta: meta([MAIN]), viewsOpen: true })
    const push = vi.spyOn(window.history, 'pushState')
    onTestFinished(() => push.mockRestore())
    const choose = (value) => c.computed().docRows[0].chooseSheet(value)
    choose('amp')
    expect([push.mock.calls.length, window.location.search, c.state.doc, c.state.viewsOpen])
      .toEqual([1, `?files=K&d=${MAIN.id}&s=amp`, MAIN.id, false])
    // another sheet of the schematic on screen, then its root
    choose('hw/psu.kicad_sch:/r/b')
    expect(window.location.search).toBe(`?files=K&d=${MAIN.id}&s=${encodeURIComponent('hw/psu.kicad_sch:/r/b')}`)
    choose('')
    expect(window.location.search).toBe(`?files=K&d=${MAIN.id}`)
    // the sheet the entry already names
    choose('')
    expect(push).toHaveBeenCalledTimes(3)
  })

  it('start the card at the button, whatever is on screen: the button never stands in the bar alone', () => {
    expect(css(viewMenuStyle(true))).toMatchObject({ left: '0' })
    expect(css(viewMenuStyle(true)).transform).toBeUndefined()
    for (const over of [{ doc: 'docs__cut-list.md' }, {}, { doc: 'docs__cut-list.md', narrow: true }]) {
      const c = component({ viewsOpen: true, ...over })
      expect(drawnAs(c.render(), viewMenuStyle(true, !over.narrow))).toHaveLength(1)
      expect(drawn(c)).toContain('Fit')
    }
  })

  it('share one scroll with twelve views: the card is one list, not two', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({ ...VIEWS[0], id: `v${i}`, name: `view ${i}` }))
    const c = component({ meta: { ...meta(), views: twelve }, view: 'v0', viewsOpen: true })
    const tree = c.render()
    const [menu] = drawnAs(tree, viewMenuStyle(true))
    // Every row and heading is a child of the card itself, the views then the
    // documents; there is no inner box that scrolls apart from the rest.
    const rows = menu.props.children.flat().filter(Boolean)
    expect(rows).toHaveLength(17)
    expect(texts(rows.at(12))).toContain('view 11')
    expect(texts(rows.slice(13))).toEqual(['MARKDOWN', 'docs/cut-list.md', '7.8 kB', 'SVG', 'ref/terr-raspil.svg', '4.2 kB'])
    expect(css(viewMenuStyle(true))).toMatchObject({ display: 'block', maxHeight: 'calc(100dvh - 240px)', overflow: 'auto' })
    expect(collect(rows, (el) => el.props.style?.overflow)).toEqual([])
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
    window.history.replaceState(null, '', '/?d=docs__cut-list.md')
    const c = component({ doc: 'docs__cut-list.md', feed: [comment] })
    c.computed().threads[0].onOpen({ stopPropagation() {} })
    expect([c.state.activePin, c.state.doc]).toEqual(['c1', null])
    expect(window.location.search).toBe('')
  })

  it('give each schematic and each board a row of its own, by its title, and a hidden one none', () => {
    const rows = component({ meta: meta([...DOCS, ...KICAD, DATASHEET]) }).computed().docRows
    expect(rows.map((t) => [t.label, t.hint])).toEqual([
      ['docs/cut-list.md', '7.8 kB'],
      ['ref/terr-raspil.svg', '4.2 kB'],
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

  it('write the sheet the schematic reports as `s=`, a step of history for the reader\'s, in place otherwise', () => {
    // The schematic's view tells the page its sheet (`onSheet`), and the page
    // writes it beside the `d=` naming the schematic; the root sheet is none.
    window.history.replaceState({ hmr: 'latest' }, '', `/?d=${KICAD[0].id}`)
    const c = component({ meta: meta(KICAD), doc: KICAD[0].id })
    const push = vi.spyOn(window.history, 'pushState')
    const rewrite = vi.spyOn(window.history, 'replaceState')
    onTestFinished(() => { push.mockRestore(); rewrite.mockRestore() })
    const written = () => [push.mock.calls.length, rewrite.mock.calls.length, window.location.search]
    shownDocs(c)[0].props.onSheet('amp', true)
    expect(written()).toEqual([1, 0, `?d=${KICAD[0].id}&s=amp`])
    shownDocs(c)[0].props.onSheet('', false)
    expect(written()).toEqual([1, 1, `?d=${KICAD[0].id}`])
  })

  it('show the model for a document this revision does not list', () => {
    const v = component({ doc: 'gone.md' }).computed()
    expect(v.docOpen).toBeNull()
    expect(v.viewLabel).toBe('closed')
  })
})

describe('a schematic\'s sheets under its row', () => {
  // The rows a page hands the list, and the sheets' component as `viewList`
  // draws it, driven on an instance whose `setState` writes into its state.
  const rows = (open, choose = vi.fn(), build = 'c1') => documentRows([MAIN, KICAD[1], KICAD[2], ...DOCS], open, choose, PAGE.base, build)
  const sheets = (row, open = true) => {
    const one = new SheetRows({ row, open })
    one.setState = (patch) => Object.assign(one.state, patch)
    one.componentDidMount()
    onTestFinished(() => one.componentWillUnmount())
    return one
  }
  /** The rows under the schematic's own, by what they say. */
  const under = (one) => collect(one.render(), (el) => (el.type === 'div' && el.props.style !== css(one.props.row.rowStyle)
    ? texts(el).join('') : undefined))
  const served = vi.fn(async (url) => new Response(SHEET_FILES[decodeURIComponent(url.slice(PAGE.base.length))]))
  afterEach(() => {
    served.mockClear()
    vi.unstubAllGlobals()
  })

  it('are there for a schematic of several files alone, its row opening it and a chevron at its end showing and hiding them', () => {
    vi.stubGlobal('fetch', served)
    const choose = vi.fn()
    const listed = rows(null, choose)
    const drawn = (documents) => collect(viewList({ label: '', open: true, onToggle: () => {}, documents }),
      (el) => (el.type === SheetRows ? [el.props.row.key, el.key] : undefined))
    // keyed by the build too: another revision of the same document id, swapped
    // in on the page, is a new component that reads its own sheets
    expect([drawn(listed), drawn(rows(null, choose, 'c2'))]).toEqual([[[MAIN.id, `c1:${MAIN.id}`]], [[MAIN.id, `c2:${MAIN.id}`]]])
    const one = sheets(listed[0])
    const [row] = collect(one.render(), (el) => (el.props.style === css(listed[0].rowStyle) ? el : undefined))
    expect([texts(row), collect(row, (el) => (el.type === 'svg' ? el : undefined)).length]).toEqual([['Главная · схема', '3 sheets'], 1])
    row.props.onClick()
    expect(choose.mock.calls).toEqual([[MAIN.id]])
    // the chevron, whose click is not the row's
    const [chevron] = collect(row, (el) => (el.type === 'span' && el.props.onClick ? el : undefined))
    const stop = vi.fn()
    chevron.props.onClick({ stopPropagation: stop })
    one.componentDidUpdate()
    expect([stop.mock.calls.length, under(one), served.mock.calls.length]).toEqual([1, ['loading…'], 3])
    chevron.props.onClick({ stopPropagation: stop })
    expect(under(one)).toEqual([])
  })

  it('are shown while the schematic is on screen, read from its files once, when the card is open', async () => {
    vi.stubGlobal('fetch', served)
    const one = sheets(rows(MAIN.id)[0], false)
    expect(served).not.toHaveBeenCalled()
    one.props = { ...one.props, open: true }
    one.componentDidUpdate()
    expect(under(one)).toEqual(['loading…'])
    await vi.waitFor(() => expect(under(one)).toEqual(['Root', 'amp', 'psu']))
    one.componentDidUpdate()
    expect(served.mock.calls.map(([url]) => url)).toEqual(Object.keys(SHEET_FILES).map((file) => `${PAGE.base}${file}`))
  })

  it('light the sheet the address names, the root for none, and hand a sheet\'s click to the page with its `s=`', async () => {
    vi.stubGlobal('fetch', served)
    const choose = vi.fn()
    const one = sheets(rows(MAIN.id, choose)[0])
    await vi.waitFor(() => expect(under(one)).toEqual(['Root', 'amp', 'psu']))
    const lit = () => collect(one.render(), (el) => (el.props.style === css(menuRow(true, 30)) ? texts(el).join('') : undefined))
    window.history.replaceState(null, '', `/?d=${MAIN.id}&s=psu`)
    expect(lit()).toEqual(['psu'])
    window.history.replaceState(null, '', `/?d=${MAIN.id}`)
    expect(lit()).toEqual(['Root'])
    const own = (el) => el.type === 'div' && el.props.onClick && el.props.style !== css(one.props.row.rowStyle)
    for (const row of collect(one.render(), (el) => (own(el) ? el : undefined))) row.props.onClick()
    expect(choose.mock.calls).toEqual([[MAIN.id, ''], [MAIN.id, 'amp'], [MAIN.id, 'psu']])
    // none lit while another document is on screen, the chevron showing them
    one.props = { ...one.props, row: rows(KICAD[1].id, choose)[0] }
    const [chevron] = collect(one.render(), (el) => (el.type === 'span' && el.props.onClick ? el : undefined))
    chevron.props.onClick({ stopPropagation() {} })
    expect([under(one), lit()]).toEqual([['Root', 'amp', 'psu'], []])
    // the root's row not lit names the root by its path
    choose.mockClear()
    collect(one.render(), (el) => (own(el) ? el : undefined))[0].props.onClick()
    expect([choose.mock.calls, one.state.pages[0].name]).toEqual([[[MAIN.id, one.state.pages[0].projectPath]], 'Root'])
  })

  it('are none where the files do not come', async () => {
    // a refusal whose body would read as the files: its status alone keeps the sheets out
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(SHEET_FILES[decodeURIComponent(url.slice(PAGE.base.length))],
      { status: 404 })))
    const one = sheets(rows(MAIN.id)[0])
    await vi.waitFor(() => expect(one.state.pages).toEqual([]))
    expect(under(one)).toEqual([])
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

describe('a comment on a KiCad design', () => {
  /** A stored comment on the amp sheet of the first design's schematic. */
  const comment = {
    id: 'c1', pid: 'proj1', commit: 'abc1234', view: null, part: null, key: null, point: null, camera: null,
    text: 'too hot', status: 'open', created: '2026-08-27T18:20:00Z', resolved: null, note: null,
    doc: 'hw/main.kicad_sch', frame: 'sheet', sheet: 'hw/amp.kicad_sch', area: [10, 20, 4, 6], items: ['C1'],
  }

  it('has the Comment tool in service over a schematic and a board, and out of it over a datasheet', () => {
    const takes = (doc) => css(component({ token: 'secret', meta: meta([...KICAD, DATASHEET]), doc })
      .computed().commentBtnStyle).pointerEvents !== 'none'
    expect([KICAD[0].id, KICAD[1].id, DATASHEET.id].map(takes)).toEqual([true, true, false])
  })

  it('opens the document of a row in the rail as a step of history and asks it to show the place, its sheet the reader\'s step where it was on screen', () => {
    window.history.replaceState({ hmr: 'latest' }, '', '/?files=K')
    const c = component({ meta: meta(KICAD), feed: [comment] })
    const push = vi.spyOn(window.history, 'pushState')
    onTestFinished(() => push.mockRestore())
    const open = () => c.computed().threads[0].onOpen({ stopPropagation() {} })
    open()
    expect([push.mock.calls.length, window.location.search, c.state.doc, c.state.activePin])
      .toEqual([1, `?files=K&d=${KICAD[0].id}`, KICAD[0].id, 'c1'])
    expect(c.state.docFocus).toEqual({ doc: 'hw/main.kicad_sch', sheet: 'hw/amp.kicad_sch', area: [10, 20, 4, 6], step: false })
    open()
    expect([push.mock.calls.length, c.state.docFocus.step]).toEqual([1, true])
  })
})
