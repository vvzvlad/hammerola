// The page of a build with no model, the drawing of one document both pages
// share, and the markdown under it.
//
// Read off the element trees the code returns (`eltree.js`), as the rest of this
// directory does: `markdownElements`, `documentBody` and `DocPage` are pure; the
// two components are driven on instances whose `setState` writes straight into
// their state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import CopyLink from '../src/copylink.jsx'
import DocShell, { docBar, DocPage, docQuery, pickDocument } from '../src/DocShell.jsx'
import DocumentView, { docBase, docHint, documentBody, docUrl, FILE_TYPE } from '../src/DocumentView.jsx'
import { markdownElements, NOWRAP_CLASS, resolveHref } from '../src/docmd.js'
import { rereadPage } from '../src/hub.js'
import { collect, texts } from './eltree.js'
import { css } from '../src/style.jsx'
import { DocFile, FILE_SPACER, FLOAT_BAR, viewMenuStyle } from '../src/viewlist.jsx'

const BASE = '/project/docs0001/abc123/'

const doc = (file, type, bytes = 9) => ({
  id: file.replaceAll('/', '__'), name: file, type, file, bytes })

// A build with no model: its documents are all there is.
const META = {
  pid: 'docs0001', project: 'shopping', title: 'Shopping list (shopping)',
  commit: 'abc1234567890', dev: false, kind: 'documents',
  documents: [
    doc('list.md', 'markdown'),
    doc('ref/photo.png', 'image'),
    doc('report.pdf', 'pdf'),
    doc('page.html', 'html'),
  ],
}

// The shapes `docs/cut-list.md` of a real project is written in: a heading and
// prose in Cyrillic, an autolink, a table with links and a bold total, a list.
const CUT_LIST = [
  '# Террариум — стёкла и покупки',
  '',
  'Модель: <https://hammerola.vvzvlad.xyz/project/549066fc57de/latest/>. Размеры ниже.',
  '',
  '| Что | Сколько | Цена |',
  '|---|---|---|',
  '| [Петля стекло-стекло чёрная, 55 мм](https://www.ozon.ru/product/6075962638/), по две на дверь | 4 | 1 620 ₽ |',
  '| **Итого** | | **23 673 ₽** |',
  '',
  '- диаметр отверстия не больше 32;',
  '- углы вырезов — радиус не меньше 6.',
].join('\n')

const ofType = (tree, type) => collect(tree, (el) => (el.type === type ? el : undefined))
const text = (el) => texts(el).join('')

describe('markdown', () => {
  it('draws the document as elements, with no markup from a string', () => {
    const tree = markdownElements('# List\n\n- **milk**\n- bread\n\nok `code`', BASE)
    expect(ofType(tree, 'h1').map(text)).toEqual(['List'])
    // A tight list draws its items without the paragraph markdown-it hides.
    const items = ofType(tree, 'li')
    expect(items).toHaveLength(2)
    expect(ofType(items, 'p')).toEqual([])
    expect(texts(ofType(tree, 'strong')[0])).toEqual(['milk'])
    expect(texts(ofType(tree, 'code')[0])).toEqual(['code'])
  })

  it('draws a cut list: Cyrillic, an autolink, a table of links and a total', () => {
    const tree = markdownElements(CUT_LIST, BASE)
    expect(ofType(tree, 'h1').map(text)).toEqual(['Террариум — стёкла и покупки'])
    const links = ofType(tree, 'a')
    expect(links.map((a) => a.props.href)).toEqual([
      'https://hammerola.vvzvlad.xyz/project/549066fc57de/latest/',
      'https://www.ozon.ru/product/6075962638/'])
    // The autolink reads as its own address.
    expect(text(links[0])).toBe('https://hammerola.vvzvlad.xyz/project/549066fc57de/latest/')
    expect(text(links[1])).toBe('Петля стекло-стекло чёрная, 55 мм')
    expect(ofType(tree, 'th').map(text)).toEqual(['Что', 'Сколько', 'Цена'])
    const rows = ofType(ofType(tree, 'tbody'), 'tr')
    expect(rows.map((row) => ofType(row, 'td').map(text))).toEqual([
      ['Петля стекло-стекло чёрная, 55 мм, по две на дверь', '4', '1 620 ₽'],
      ['Итого', '', '23 673 ₽']])
    expect(ofType(rows[1], 'strong').map(text)).toEqual(['Итого', '23 673 ₽'])
    expect(ofType(tree, 'li').map(text)).toEqual([
      'диаметр отверстия не больше 32;', 'углы вырезов — радиус не меньше 6.'])
  })

  it('keeps a short cell on one line, by class, and lets a long one wrap', () => {
    const tree = markdownElements(
      '| Деталь | Размер, мм |\n|---|---|\n'
      + '| Ребро жёсткости над дверями, клеится плашмя | 1223.0 × 24.0 |', BASE)
    const [name, size] = ofType(tree, 'td')
    expect(size.props.className).toBe(NOWRAP_CLASS)
    expect(name.props.className).toBeUndefined()
    expect(size.props.style.whiteSpace).toBeUndefined()
    expect(ofType(tree, 'th').map((th) => th.props.className)).toEqual([NOWRAP_CLASS, NOWRAP_CLASS])
  })

  it('opens a web link in a new tab, and a link into the build in this one', () => {
    const tree = markdownElements('[ozon](https://www.ozon.ru/x) [plain](http://a.b/) [r](report.pdf)', BASE)
    const [ozon, plain, local] = ofType(tree, 'a')
    for (const away of [ozon, plain]) {
      expect(away.props.target).toBe('_blank')
      expect(away.props.rel).toBe('noopener noreferrer')
    }
    expect(local.props.target).toBeUndefined()
    expect(local.props.rel).toBeUndefined()
  })

  it('turns raw HTML into text instead of elements', () => {
    const tree = markdownElements('<script>alert(1)</script>\n\nhi <b>x</b>', BASE)
    expect(ofType(tree, 'script')).toEqual([])
    expect(ofType(tree, 'b')).toEqual([])
    expect(texts(tree).join('')).toContain('<script>alert(1)</script>')
  })

  it('points relative links and pictures into the same build, on paper', () => {
    const tree = markdownElements(
      '[r](report.pdf) [up](./sub/x.md#a) [ext](https://example.org/x) [here](#top)\n\n![p](photo.png)',
      BASE)
    expect(ofType(tree, 'a').map((a) => a.props.href)).toEqual([
      `${BASE}report.pdf`, `${BASE}sub/x.md#a`, 'https://example.org/x', '#top'])
    const img = ofType(tree, 'img')[0]
    expect(img.props.src).toBe(`${BASE}photo.png`)
    expect(img.props.alt).toBe('p')
    // Black lines on nothing would vanish into the dark page.
    expect(img.props.style.background).toBe('var(--paper-bg)')
  })

  it('leaves a link with a scheme or a root path alone', () => {
    expect(resolveHref('mailto:a@b', BASE)).toBe('mailto:a@b')
    expect(resolveHref('/project/x/latest/', BASE)).toBe('/project/x/latest/')
    expect(resolveHref('list.md?x=1', BASE)).toBe(`${BASE}list.md?x=1`)
  })

  it('keeps a table cell\'s alignment', () => {
    const tree = markdownElements('| a | b |\n|:-|-:|\n| 1 | 2 |', BASE)
    expect(ofType(tree, 'td').map((td) => td.props.style.textAlign)).toEqual(['left', 'right'])
  })
})

describe('one document, as both pages draw it', () => {
  const cutList = doc('docs/cut-list.md', 'markdown', 7765)
  // A document of a type the page draws nothing of, which it hands over.
  const cutPlan = { ...doc('cut/glass.dxf', FILE_TYPE, 12_400), name: 'Glass, cut list' }

  it('serves a document at its path and resolves its links from its directory', () => {
    expect(docUrl(BASE, cutList)).toBe(`${BASE}docs/cut-list.md`)
    expect(docBase(BASE, cutList)).toBe(`${BASE}docs/`)
    expect(docBase(BASE, META.documents[0])).toBe(BASE)
    const tree = documentBody(cutList, BASE, '![s](../ref/sketch.jpg) [n](notes.md)', '')
    expect(ofType(tree, 'img')[0].props.src).toBe(`${BASE}ref/sketch.jpg`)
    expect(ofType(tree, 'a')[0].props.href).toBe(`${BASE}docs/notes.md`)
  })

  describe('a link to another document', () => {
    afterEach(() => window.history.replaceState(null, '', '/'))

    it('opens it on the page, not as the raw file', () => {
      window.history.replaceState(null, '', `${BASE}?v=glass&files=k1`)
      const vendors = doc('docs/glass-vendors.md', 'markdown')
      const onOpen = vi.fn()
      const tree = documentBody(cutList, BASE,
        '[v](glass-vendors.md#top) [p](../report.pdf) [n](notes.md) [w](https://x.org/) [x](https://)', '',
        [cutList, vendors, META.documents[2]], onOpen)
      const [v, p, n, w, x] = ofType(tree, 'a')
      // A half-typed address is drawn as written rather than taking the page down.
      expect(x.props.href).toBe('https://')
      // The page's own address with the other parameters kept, so a new tab or a
      // copied link lands on the document too.
      expect(v.props.href).toBe(`${BASE}?v=glass&files=k1&d=docs__glass-vendors.md`)
      expect(p.props.href).toBe(`${BASE}?v=glass&files=k1&d=report.pdf`)
      // A file the build does not list as a document stays the file.
      expect(n.props.href).toBe(`${BASE}docs/notes.md`)
      expect(n.props.onClick).toBeUndefined()
      expect(w.props.target).toBe('_blank')
      const click = (extra) => {
        const event = { button: 0, preventDefault: vi.fn(), ...extra }
        v.props.onClick(event)
        return event
      }
      expect(click().preventDefault).toHaveBeenCalled()
      expect(onOpen.mock.calls).toEqual([['docs__glass-vendors.md']])
      // A modified or middle click is the browser's: a new tab.
      for (const extra of [{ metaKey: true }, { ctrlKey: true }, { button: 1 }]) {
        expect(click(extra).preventDefault).not.toHaveBeenCalled()
      }
      expect(onOpen).toHaveBeenCalledTimes(1)
      // Without a door to open one, a link is a link to the file.
      expect(ofType(documentBody(cutList, BASE, '[v](glass-vendors.md)', '', [vendors]), 'a')[0].props.href)
        .toBe(`${BASE}docs/glass-vendors.md`)
    })
  })

  it('lets a long bare address break, so it cannot push the page wider', () => {
    const [a] = ofType(markdownElements('| a |\n|---|\n| <https://www.avito.ru/moskva/rezka_stekla_i_zerkal_1979990456> |', BASE), 'a')
    expect(a.props.style.overflowWrap).toBe('anywhere')
  })

  it('lets the text of a markdown document be selected under the library body rule', () => {
    const [article] = ofType(documentBody(cutList, BASE, 'text', ''), 'article')
    expect(article.props.style.userSelect).toBe('text')
  })

  it('carries the rule its short cells are styled by', () => {
    const styles = ofType(documentBody(cutList, BASE, '| a |\n|---|\n| 1 |', ''), 'style')
    expect(styles.map(text)).toEqual([`.${NOWRAP_CLASS}{white-space:nowrap}`])
  })

  it('draws markdown itself, a picture as an image and the rest in a frame', () => {
    expect(text(documentBody(cutList, BASE, null, '', [], undefined, undefined, undefined, 3100)))
      .toBe('Loading… 3.1 / 7.8 kB')
    expect(text(documentBody(cutList, BASE, null, 'docs/cut-list.md did not load: HTTP 404')))
      .toBe('docs/cut-list.md did not load: HTTP 404')
    expect(ofType(documentBody(META.documents[1], BASE, null, ''), 'img')[0].props.src)
      .toBe(`${BASE}ref/photo.png`)
    for (const one of META.documents.slice(2)) {
      const frames = ofType(documentBody(one, BASE, null, ''), 'iframe')
      expect(frames.map((f) => f.props.src)).toEqual([`${BASE}${one.file}`])
    }
  })

  it('names a file it cannot draw rather than putting it in a frame, and leaves its download to the bar', () => {
    // A frame fed a type the browser does not render downloads it from inside
    // itself and leaves an empty page with no way to ask again.
    const tree = documentBody(cutPlan, BASE, null, '')
    expect(ofType(tree, 'iframe')).toEqual([])
    expect([ofType(tree, 'a'), ofType(tree, CopyLink)]).toEqual([[], []])
    expect(text(tree)).toContain('Glass, cut list')
    expect(text(tree)).toContain('dxf · 12.4 kB')
    expect(ofType(tree, 'img')).toEqual([])
  })

  it('shows the picture the hub drew of a DXF above its name', () => {
    const tree = documentBody({ ...cutPlan, preview: 'cut/glass.dxf.svg' }, BASE, null, '')
    const [img] = ofType(tree, 'img')
    expect(img.props.src).toBe(`${BASE}cut/glass.dxf.svg`)
    expect(img.props.alt).toBe('Glass, cut list')
    expect(text(tree)).toContain('Glass, cut list')
  })

  it('labels a document with its type and size', () => {
    expect(docHint(cutList)).toBe('markdown · 7.8 kB')
    // From a megabyte, as a view's size is written.
    expect(docHint({ ...cutList, type: 'pdf', bytes: 4_700_000 })).toBe('pdf · 4.7 MB')
    // A file the page does not draw says WHICH file it is: `file` is the type
    // of every one of them, so the word would label them all alike.
    expect(docHint(cutPlan)).toBe('dxf · 12.4 kB')
    expect(docHint({ ...cutPlan, file: 'LICENSE' })).toBe('file · 12.4 kB')
  })

  describe('the holder', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('# Fetched')))
    })
    afterEach(() => vi.unstubAllGlobals())

    const mounted = (one) => {
      const view = new DocumentView({ doc: one, base: BASE, onTools: vi.fn(), onReady: vi.fn() })
      view.setState = (patch) => Object.assign(view.state, patch)
      view.componentDidMount()
      return view
    }

    it('fetches a markdown document and draws it', async () => {
      const view = mounted(cutList)
      expect(fetch).toHaveBeenCalledWith(`${BASE}docs/cut-list.md`)
      await vi.waitFor(() => expect(view.state.text).toBe('# Fetched'))
      expect(ofType(view.render(), 'h1').map(text)).toEqual(['Fetched'])
    })

    it('fetches nothing for a document the browser draws itself', () => {
      mounted(META.documents[2])
      expect(fetch).not.toHaveBeenCalled()
    })

    it('tells the page when it has its file: a text in or failed, a file it does not draw at once, a picture or a frame loaded', async () => {
      const article = mounted(cutList)
      expect(article.props.onReady).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(article.props.onReady).toHaveBeenCalledTimes(1))
      fetch.mockResolvedValueOnce(new Response(null, { status: 404 }))
      const missing = mounted(cutList)
      await vi.waitFor(() => expect(missing.state.error).toBe('docs/cut-list.md did not load: HTTP 404'))
      expect(missing.props.onReady).toHaveBeenCalledTimes(1)
      expect(mounted(cutPlan).props.onReady).toHaveBeenCalledTimes(1)
      const onReady = () => {}
      const [picture] = ofType(documentBody(META.documents[1], BASE, null, '', [], undefined, undefined, onReady), 'img')
      const [frame] = ofType(documentBody(META.documents[2], BASE, null, '', [], undefined, undefined, onReady), 'iframe')
      expect([picture.props.onLoad, picture.props.onError, frame.props.onLoad]).toEqual([onReady, onReady, onReady])
    })

    it('drops an answer that arrives after it was taken off the page', async () => {
      const view = mounted(cutList)
      view.componentWillUnmount()
      // Past every step of the fetch chain.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(view.state.text).toBeNull()
    })

    it('tells the page\'s bar, as it goes, that it can do nothing more', () => {
      const view = mounted(META.documents[2])
      expect(view.props.onTools).not.toHaveBeenCalled()
      view.componentWillUnmount()
      expect(view.props.onTools.mock.calls).toEqual([[null]])
      // and hands the door to the views that can drive the bar
      const zip = doc('fab/board.zip', 'gerbers')
      const onTools = () => {}
      expect(documentBody(zip, BASE, null, '', [], undefined, onTools).props.onTools).toBe(onTools)
    })
  })
})

// A KiCad design among them, its schematic and its board two documents, each
// with its own title; and a datasheet listed hidden, first in the list.
const SCHEMATIC = {
  id: 'hw__board.kicad_sch', name: 'Схема', type: 'schematic', file: 'hw/board.kicad_sch',
  bytes: 4_612_345, kicad: { schematics: ['hw/board.kicad_sch'], project: 'hw/board.kicad_pro' },
}
const BOARD = {
  id: 'hw__board.kicad_pcb', name: 'Плата', type: 'board', file: 'hw/board.kicad_pcb',
  bytes: 812_000, kicad: { project: 'hw/board.kicad_pro' },
}
const DATASHEET = { ...doc('ds/ne555.pdf', 'pdf'), hidden: true }
const WITH_KICAD = { ...META, documents: [DATASHEET, SCHEMATIC, BOARD, ...META.documents.slice(0, 1)] }

describe('the page of a build with no model', () => {
  const page = (active, extra = {}) => DocPage({ meta: META, active, base: BASE, onPick: () => {}, ...extra })
  const shown = (tree) => collect(tree, (el) => (el.type === DocumentView ? el : undefined))
  /** The rows of the list, by what they say, and the click each one makes. */
  const rows = (tree) => collect(tree, (el) => (el.props.onClick && el.type === 'div'
    && texts(el).length === 2 ? texts(el) : undefined))

  it('has the list of views at the bottom and no tabs at the top', () => {
    const tree = page('list.md', { viewsOpen: true })
    expect(ofType(tree, 'button')).toEqual([])
    expect(collect(tree, (el) => (el.props.role === 'tablist' ? el : undefined))).toEqual([])
    // a row per document, in the order meta.json lists them, with its type and size
    expect(rows(tree)).toEqual(META.documents.map((d) => [d.name, docHint(d)]))
    // the button names the document on screen
    expect(texts(tree)).toContain('list.md')
    // and stands in the model's bar, the card starting at its left edge
    expect(collect(tree, (el) => (el.props.style === css(viewMenuStyle(true)) ? el : undefined)))
      .toHaveLength(1)
  })

  it('draws the model\'s bar, the tools about a model out of service, Fit and Frame live where the view can', async () => {
    const TOOLS = ['Measure', 'Comment', 'Add primitive', 'Fit', 'Frame', 'Settings']
    const drawn = (extra) => texts(page('list.md', extra)).filter((word) => TOOLS.includes(word))
    expect(drawn({})).toEqual(TOOLS)
    // a narrow window keeps the list and Fit, as the model's page does
    expect(drawn({ narrow: true })).toEqual(['Fit'])
    const bar = (extra) => docBar({ meta: META, doc: META.documents[0], onPick: () => {}, ...extra })
    const off = (values, key) => css(values[key]).pointerEvents === 'none'
    const KEYS = ['measureBtnStyle', 'commentBtnStyle', 'proposalBtnStyle', 'fitBtnStyle', 'frameBtnStyle', 'settingsBtnStyle']
    expect(KEYS.map((key) => off(bar({}), key))).toEqual([true, true, true, true, true, true])
    const blob = new Blob(['png'], { type: 'image/png' })
    const tools = { fit: vi.fn(), frame: vi.fn(async () => blob) }
    const live = bar({ tools })
    expect(KEYS.map((key) => off(live, key))).toEqual([true, true, true, false, false, true])
    live.fitView()
    expect(tools.fit).toHaveBeenCalledTimes(1)
    const saved = []
    // jsdom has neither; the page hands the blob over by an object URL.
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:frame'), revokeObjectURL: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() { saved.push(this.download) })
    await live.grabFrame()
    expect(saved).toEqual(['shopping-abc1234.png'])
    vi.restoreAllMocks()
    // Comment and Add primitive are hidden from a reader without a token, as on the model's page
    expect([bar({ viewer: true }).commentBtnStyle, bar({ viewer: true }).proposalBtnStyle].map((st) => css(st).display))
      .toEqual(['none', 'none'])
  })

  it('downloads the open document and copies its link outside the bar, at the left of its strip, wide or narrow', () => {
    // The owner's "Download и Copy link в левой части нижней полосы, вне плашки".
    const href = `${BASE}report.pdf`
    for (const extra of [{}, { narrow: true }]) {
      const tree = page('report.pdf', extra)
      // the strip's layer, in order: the file's buttons, the bar, the spacer that keeps the bar centred
      const strip = collect(tree, (el) => {
        if (el.type === DocFile) return ['file', el.props.href]
        if (el.props.style === css(FLOAT_BAR)) return ['bar']
        if (el.props.style === css(FILE_SPACER)) return ['spacer']
        return undefined
      })
      expect(strip).toEqual([['file', href], ['bar'], ['spacer']])
      // and nothing in the bar downloads or copies
      const bar = collect(tree, (el) => (el.props.style === css(FLOAT_BAR) ? el : undefined))[0]
      expect([ofType(bar, 'a'), ofType(bar, CopyLink)]).toEqual([[], []])
    }
  })

  it('gives a schematic and a board a row each by their titles, and a hidden document none', () => {
    const picked = []
    const tree = DocPage({ meta: WITH_KICAD, active: BOARD.id, base: BASE,
      onPick: (id) => picked.push(id), viewsOpen: true })
    expect(rows(tree)).toEqual([['Схема', '1 sheet'], ['Плата', 'board'], ['list.md', docHint(META.documents[0])]])
    expect(texts(tree)).toContain('Плата')
    for (const row of collect(tree, (el) => (el.props.onClick && texts(el).length === 2 ? el : undefined))) {
      row.props.onClick({ stopPropagation() {} })
    }
    expect(picked).toEqual([SCHEMATIC.id, BOARD.id, 'list.md'])
    // The open member is handed the build's documents and the door a row opens
    // with, which `Show in …` of the design's right-click menu uses for the other.
    const [view] = shown(tree)
    expect(view.props).toMatchObject({ doc: BOARD, documents: WITH_KICAD.documents })
    view.props.onOpen(SCHEMATIC.id)
    expect(picked.at(-1)).toBe(SCHEMATIC.id)
    // One instance for the design, whichever member is open.
    const schematicView = shown(DocPage({ meta: WITH_KICAD, active: SCHEMATIC.id, base: BASE, onPick: () => {} }))[0]
    expect(schematicView.key).toBe(view.key)
  })

  it('names the project and the revision in the header', () => {
    const header = texts(page('list.md'))
    expect(header).toContain('Shopping list (shopping)')
    expect(header).toContain('abc1234')
    const dev = DocPage({ meta: { ...META, dev: true, commit: 'dev' }, active: 'list.md',
      base: BASE, onPick: () => {} })
    expect(texts(dev)).toContain('dev')
  })

  it('puts the open document on the page, one instance per document', () => {
    const [view] = shown(page('report.pdf'))
    expect(view.props.doc.id).toBe('report.pdf')
    expect(view.key).toBe('report.pdf')
    expect(view.props.base).toBe(BASE)
  })

  it('opens the first document when the address names none it has', () => {
    expect(pickDocument(META.documents, null).id).toBe('list.md')
    expect(pickDocument(META.documents, 'gone.md').id).toBe('list.md')
    expect(pickDocument(META.documents, 'report.pdf').id).toBe('report.pdf')
  })

  it('opens the first document with a row by default, and a hidden one only by its id', () => {
    expect(pickDocument(WITH_KICAD.documents, null).id).toBe(SCHEMATIC.id)
    expect(pickDocument(WITH_KICAD.documents, DATASHEET.id).id).toBe(DATASHEET.id)
    expect(docQuery('?d=ds__ne555.pdf', SCHEMATIC.id, WITH_KICAD.documents)).toBe('')
    expect(docQuery('', DATASHEET.id, WITH_KICAD.documents)).toBe('?d=ds__ne555.pdf')
    // On screen with no row lit, named on the button.
    const tree = DocPage({ meta: WITH_KICAD, active: DATASHEET.id, base: BASE, onPick: () => {}, viewsOpen: true })
    expect(shown(tree)[0].props.doc.id).toBe(DATASHEET.id)
    expect(rows(tree).map(([label]) => label)).not.toContain('ds/ne555.pdf')
    expect(texts(tree)).toContain('ds/ne555.pdf')
  })

  it('says ?d= only for a document other than the first, and keeps the rest', () => {
    expect(docQuery('', 'report.pdf', META.documents)).toBe('?d=report.pdf')
    expect(docQuery('?d=report.pdf', 'list.md', META.documents)).toBe('')
    expect(docQuery('?x=1&d=a', 'page.html', META.documents)).toBe('?x=1&d=page.html')
  })
})

describe('the shell', () => {
  let shell
  const mount = (search) => {
    window.history.replaceState(null, '', `${BASE}${search}`)
    rereadPage(BASE)
    shell = new DocShell({ meta: META })
    shell.setState = (patch) => Object.assign(shell.state, patch)
  }
  afterEach(() => {
    window.history.replaceState(null, '', '/')
    rereadPage('/')
  })

  it('opens the document the address names', () => {
    mount('?d=report.pdf')
    expect(shell.state.active).toBe('report.pdf')
    expect(shell.render().props.active).toBe('report.pdf')
  })

  it('holds only the open document, which the right-click menu\'s Show in … moves across a design', () => {
    window.history.replaceState(null, '', BASE)
    rereadPage(BASE)
    shell = new DocShell({ meta: WITH_KICAD })
    shell.setState = (patch) => Object.assign(shell.state, patch)
    expect(shell.state).toEqual({ active: SCHEMATIC.id, viewsOpen: false, tools: null, narrow: false })
    // the door `Show in …` on the schematic opens the board through
    shell.render().props.onPick(BOARD.id)
    expect(shell.state.active).toBe(BOARD.id)
    expect(window.location.search).toBe('?d=hw__board.kicad_pcb')
    shell.render().props.onPick(SCHEMATIC.id)
    expect(window.location.search).toBe('')
  })

  it('opens a hidden document the address names', () => {
    window.history.replaceState(null, '', `${BASE}?d=ds__ne555.pdf`)
    rereadPage(BASE)
    shell = new DocShell({ meta: WITH_KICAD })
    expect(shell.state.active).toBe(DATASHEET.id)
  })

  it('holds what the open document\'s view can do, and whether the window is narrow', () => {
    const listeners = new Set()
    const query = { matches: true, addEventListener: (type, fn) => listeners.add(fn), removeEventListener: (type, fn) => listeners.delete(fn) }
    Object.defineProperty(window, 'matchMedia', { value: () => query, configurable: true, writable: true })
    try {
      mount('')
      expect(shell.render().props.narrow).toBe(true)
      shell.componentDidMount()
      listeners.forEach((fn) => fn({ matches: false }))
      expect(shell.render().props.narrow).toBe(false)
      const tools = { fit() {}, frame() {} }
      shell.render().props.onTools(tools)
      expect(shell.render().props.tools).toBe(tools)
      shell.componentWillUnmount()
      expect(listeners.size).toBe(0)
    } finally {
      delete window.matchMedia
    }
  })

  it('opens the list on its button and shuts it on a click elsewhere', () => {
    mount('')
    const stop = vi.fn()
    shell.render().props.onToggle({ stopPropagation: stop })
    expect(stop).toHaveBeenCalled()
    expect(shell.state.viewsOpen).toBe(true)
    shell.render().props.onClose()
    expect(shell.state.viewsOpen).toBe(false)
  })

  it('writes the document into the address, and drops ?d= for the first', () => {
    mount('?d=report.pdf')
    shell.pick('list.md')
    expect(window.location.search).toBe('')
    expect(shell.state.active).toBe('list.md')
    shell.pick('page.html')
    expect(window.location.search).toBe('?d=page.html')
    expect(shell.state.active).toBe('page.html')
  })
})
