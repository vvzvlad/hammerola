// The page of a build with no model, the drawing of one document both pages
// share, and the markdown under it.
//
// Read off the element trees the code returns (`eltree.js`), as the rest of this
// directory does: `markdownElements`, `documentBody` and `DocPage` are pure; the
// two components are driven on instances whose `setState` writes straight into
// their state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import DocShell, { DocPage, docQuery, pickDocument } from '../src/DocShell.jsx'
import DocumentView, { docBase, docHint, documentBody, docUrl } from '../src/DocumentView.jsx'
import { markdownElements, NOWRAP_CLASS, resolveHref } from '../src/docmd.js'
import { rereadPage } from '../src/hub.js'
import { collect, texts } from './eltree.js'

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

  it('serves a document at its path and resolves its links from its directory', () => {
    expect(docUrl(BASE, cutList)).toBe(`${BASE}docs/cut-list.md`)
    expect(docBase(BASE, cutList)).toBe(`${BASE}docs/`)
    expect(docBase(BASE, META.documents[0])).toBe(BASE)
    const tree = documentBody(cutList, BASE, '![s](../ref/sketch.jpg) [n](notes.md)', '')
    expect(ofType(tree, 'img')[0].props.src).toBe(`${BASE}ref/sketch.jpg`)
    expect(ofType(tree, 'a')[0].props.href).toBe(`${BASE}docs/notes.md`)
  })

  it('carries the rule its short cells are styled by', () => {
    const styles = ofType(documentBody(cutList, BASE, '| a |\n|---|\n| 1 |', ''), 'style')
    expect(styles.map(text)).toEqual([`.${NOWRAP_CLASS}{white-space:nowrap}`])
  })

  it('draws markdown itself, a picture as an image and the rest in a frame', () => {
    expect(text(documentBody(cutList, BASE, null, ''))).toBe('Loading…')
    expect(text(documentBody(cutList, BASE, null, 'docs/cut-list.md did not load: HTTP 404')))
      .toBe('docs/cut-list.md did not load: HTTP 404')
    expect(ofType(documentBody(META.documents[1], BASE, null, ''), 'img')[0].props.src)
      .toBe(`${BASE}ref/photo.png`)
    for (const one of META.documents.slice(2)) {
      const frames = ofType(documentBody(one, BASE, null, ''), 'iframe')
      expect(frames.map((f) => f.props.src)).toEqual([`${BASE}${one.file}`])
    }
  })

  it('labels a document with its type and size', () => {
    expect(docHint(cutList)).toBe('markdown · 7.8 kB')
    // From a megabyte, as a view's size is written.
    expect(docHint({ ...cutList, type: 'pdf', bytes: 4_700_000 })).toBe('pdf · 4.7 MB')
  })

  describe('the holder', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '# Fetched' })))
    })
    afterEach(() => vi.unstubAllGlobals())

    const mounted = (one) => {
      const view = new DocumentView({ doc: one, base: BASE })
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

    it('drops an answer that arrives after it was taken off the page', async () => {
      const view = mounted(cutList)
      view.componentWillUnmount()
      // Past every step of the fetch chain.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(view.state.text).toBeNull()
    })
  })
})

describe('the page of a build with no model', () => {
  const page = (active) => DocPage({ meta: META, active, base: BASE, onPick: () => {} })
  const shown = (tree) => collect(tree, (el) => (el.type === DocumentView ? el : undefined))

  it('draws one tab per document, in the order meta.json lists them', () => {
    const tabs = ofType(page('list.md'), 'button')
    expect(tabs.map(text)).toEqual(META.documents.map((d) => d.name))
    expect(tabs.map((tab) => tab.props['aria-selected'])).toEqual([true, false, false, false])
  })

  it('styles the open tab and the others with the same properties', () => {
    // React patches only the properties that differ between two renders. A
    // longhand that only the open tab carries is REMOVED when the tab closes,
    // and the shorthand it sat on is not re-applied, so the underline of the
    // tab just left turned `currentcolor` (black) in a real browser.
    const [open, closed] = ofType(page('list.md'), 'button')
    expect(Object.keys(closed.props.style)).toEqual(Object.keys(open.props.style))
    expect(closed.props.style.borderBottomColor).toBe('transparent')
  })

  it('names the project and the revision in the header', () => {
    const header = texts(page('list.md'))
    expect(header).toContain('Shopping list (shopping)')
    expect(header).toContain('abc1234')
    const dev = DocPage({ meta: { ...META, dev: true, commit: 'dev' }, active: 'list.md',
      base: BASE, onPick: () => {} })
    expect(texts(dev)).toContain('dev')
  })

  it('puts the open document under the tabs, one instance per document', () => {
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

  it('writes the tab into the address, and drops ?d= for the first', () => {
    mount('?d=report.pdf')
    shell.pick('list.md')
    expect(window.location.search).toBe('')
    expect(shell.state.active).toBe('list.md')
    shell.pick('page.html')
    expect(window.location.search).toBe('?d=page.html')
    expect(shell.state.active).toBe('page.html')
  })
})
