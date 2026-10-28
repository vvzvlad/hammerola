// The page of a build with no model, the drawing of one document both pages
// share, and the markdown under it.
//
// Read off the element trees the code returns (`eltree.js`), as the rest of this
// directory does: `markdownElements`, `documentBody` and `DocPage` are pure; the
// two components are driven on instances whose `setState` writes straight into
// their state.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

// The KiCad viewer's module, imported by its address on the hub: a module of
// nothing here, the schematic's element below carrying what it would define.
vi.mock('/_v/ecad-viewer.js', () => ({}))

import CopyLink from '../src/copylink.jsx'
import DocShell, { docBar, DocPage, pickDocument } from '../src/DocShell.jsx'
import DocumentView, { docBase, docHint, DocumentLayers, documentBody, docUrl, FILE_TYPE } from '../src/DocumentView.jsx'
import KicadView, { DRAFT_MARK, PAGE_EVENT, SCH } from '../src/KicadView.jsx'
import {
  findQuote, markdownElements, offsetOf, quoteOf, rangeOf, resolveHref, textIndex,
} from '../src/docmd.js'
import { rereadPage } from '../src/hub.js'
import { clearToken, writeToken } from '../src/store.js'
import { collect, texts } from './eltree.js'
import { css } from '../src/style.jsx'
import { DocFile, FILE_SPACER, FLOAT_BAR, viewMenuStyle } from '../src/viewlist.jsx'
import { guardSubscribers } from './addressguard.js'

guardSubscribers()

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
/** The layers a page's `DocumentLayers` draws, as on its first render: a
 *  wrapper each, keyed, its `DocumentView` inside; and those views. */
const layers = (tree) => ofType(tree, DocumentLayers).flatMap((el) => new DocumentLayers(el.props).render())
const views = (tree) => layers(tree).map((layer) => layer.props.children)

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

  it('points relative links and pictures into the same build', () => {
    const tree = markdownElements(
      '[r](report.pdf) [up](./sub/x.md#a) [ext](https://example.org/x) [here](#top)\n\n![p](photo.png)',
      BASE)
    expect(ofType(tree, 'a').map((a) => a.props.href)).toEqual([
      `${BASE}report.pdf`, `${BASE}sub/x.md#a`, 'https://example.org/x', '#top'])
    const img = ofType(tree, 'img')[0]
    expect(img.props.src).toBe(`${BASE}photo.png`)
    expect(img.props.alt).toBe('p')
  })

  it('leaves a link with a scheme, a root path or a bare query alone', () => {
    expect(resolveHref('mailto:a@b', BASE)).toBe('mailto:a@b')
    expect(resolveHref('/project/x/latest/', BASE)).toBe('/project/x/latest/')
    expect(resolveHref('list.md?x=1', BASE)).toBe(`${BASE}list.md?x=1`)
    // the page's own address, which the browser resolves against the page
    expect(resolveHref('?v=open', `${BASE}docs/`)).toBe('?v=open')
  })

  it('keeps a table cell\'s alignment', () => {
    const tree = markdownElements('| a | b |\n|:-|-:|\n| 1 | 2 |', BASE)
    expect(ofType(tree, 'td').map((td) => td.props.style.textAlign)).toEqual(['left', 'right'])
  })
})

describe('a comment\'s quote of markdown', () => {
  it('reads the text as drawn, a style left out, and finds a selection\'s ends in it', () => {
    const root = document.createElement('article')
    root.innerHTML = '<style>.x{}</style><p>mind the <b>gap</b> here</p><p>the gap is wide</p>'
    const index = textIndex(root)
    expect(index.text).toBe('mind the gap herethe gap is wide')
    expect(offsetOf(index, root.querySelector('b').firstChild, 1)).toBe(10)
    // a point between elements: the first text at or after it, or the end
    expect([offsetOf(index, root, 2), offsetOf(index, root, 3)]).toEqual([17, 32])
    expect(rangeOf(index, 5, 12).toString()).toBe('the gap')
    // a passage that starts a node starts in it, not at the end of the one before
    const word = rangeOf(index, 9, 12)
    expect(word.startContainer).toBe(root.querySelector('b').firstChild)
    expect(word.endContainer).toBe(root.querySelector('b').firstChild)
  })

  it('moves the blanks of a selection into its sides, and finds it again where its sides agree most', () => {
    const text = 'mind the gap here, the gap is wide'
    expect(quoteOf(text, 4, 13)).toEqual({ text: 'the gap', before: 'mind ', after: ' here, the gap is wide' })
    expect(quoteOf(text, 4, 5)).toBeNull()
    const second = quoteOf(text, 19, 26)
    expect(second.before).toBe('mind the gap here, ')
    expect(findQuote(text, second)).toEqual([19, 26])
    expect(findQuote(text.replace('is wide', 'is narrow'), second)).toEqual([19, 26])
    expect(findQuote(text, { text: 'the gap', before: '', after: '' })).toEqual([5, 12])
    expect(findQuote(text, { ...second, text: 'a crack' })).toBeNull()
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

  describe('a link to the page\'s own address', () => {
    afterEach(() => window.history.replaceState(null, '', '/'))

    it('is that address with the screen the link names, the key and what it does not name kept', () => {
      window.history.replaceState({ hmr: 'abc123' }, '', `${BASE}?v=glass&files=k1&x=2&s=psu#top`)
      const copied = `${window.location.origin}${BASE}?v=print&c=1,2#x`
      const note = `[o](?v=open) [s](?d=hw__board.kicad_sch&s=amp) [c](${copied}) `
        + '[p](/project/docs0001/abc123/) [h](#top) [l](/project/docs0001/latest/?v=open)'
      // drawn with no door to the page — the datasheet's window — each is that
      // address, key kept, with no click handler and in the same tab
      const loose = ofType(documentBody(cutList, BASE, note, ''), 'a').slice(0, 3)
      expect(loose.map((a) => [a.props.href, a.props.onClick, a.props.target])).toEqual([
        [`${BASE}?files=k1&x=2&v=open`, undefined, undefined],
        [`${BASE}?files=k1&x=2&d=hw__board.kicad_sch&s=amp`, undefined, undefined],
        [`${BASE}?files=k1&x=2&v=print`, undefined, undefined]])
      const tree = documentBody(cutList, BASE, note, '', [], vi.fn())
      const [open, sheet, full, plain, here, other] = ofType(tree, 'a')
      expect([open, sheet, full, plain].map((a) => a.props.href)).toEqual([`${BASE}?files=k1&x=2&v=open`,
        `${BASE}?files=k1&x=2&d=hw__board.kicad_sch&s=amp`, `${BASE}?files=k1&x=2&v=print`, `${BASE}?files=k1&x=2`])
      // a place in the document, and the page of another build, are plain links
      expect([here, other].map((a) => [a.props.href, a.props.onClick]))
        .toEqual([['#top', undefined], ['/project/docs0001/latest/?v=open', undefined]])
      const push = vi.spyOn(window.history, 'pushState')
      onTestFinished(() => push.mockRestore())
      const click = (a, extra) => {
        const event = { button: 0, preventDefault: vi.fn(), ...extra }
        a.props.onClick(event)
        return event.preventDefault.mock.calls.length
      }
      // a modified or middle click is the browser's
      expect([{ ctrlKey: true }, { metaKey: true }, { button: 1 }].map((extra) => click(sheet, extra))).toEqual([0, 0, 0])
      // a plain one is a step of history, none for the screen the address names
      expect(click(sheet)).toBe(1)
      expect([push.mock.calls.length, window.location.search, window.history.state])
        .toEqual([1, '?files=k1&x=2&d=hw__board.kicad_sch&s=amp', { hmr: 'abc123' }])
      click(sheet)
      expect(push).toHaveBeenCalledTimes(1)
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

    it('tells the page\'s bar, as it comes and as it goes, that it can do nothing', () => {
      // as it comes: a design kept hidden before it said nothing as it went
      const view = mounted(META.documents[2])
      expect(view.props.onTools.mock.calls).toEqual([[null]])
      view.componentWillUnmount()
      expect(view.props.onTools.mock.calls).toEqual([[null], [null]])
      // and hands the door to the views that can drive the bar
      const zip = doc('fab/board.zip', 'gerbers')
      const onTools = () => {}
      expect(documentBody(zip, BASE, null, '', [], undefined, onTools).props.onTools).toBe(onTools)
    })
  })

  describe('the page\'s comments on markdown', () => {
    const quote = (text, before = '', after = '') => ({ text, before, after })
    const mark = (id, q, file = cutList.file) => ({ id, doc: file, quote: q })

    /** The document with its text in and drawn, the page's comments handed it
     *  (`comment`): the article's ref given a node in the page, holding the
     *  DOM React draws `mind the **gap** here` and `the gap is wide` as, and
     *  the update after it, as React runs them. `update` hands it the page's
     *  comments changed by `patch`; `release` is the article's pointer-up. */
    const drawn = (extra) => {
      const comment = { on: false, marks: [], focus: null, onArea: vi.fn(), onMarker: vi.fn(), onLost: vi.fn(),
        onFocused: vi.fn(), ...extra }
      const view = new DocumentView({ doc: cutList, base: BASE, comment })
      view.setState = (patch) => Object.assign(view.state, patch)
      view.setState({ text: 'mind the **gap** here\n\nthe gap is wide' })
      const [article] = ofType(view.render(), 'article')
      const node = document.createElement('article')
      node.innerHTML = '<p>mind the <strong>gap</strong> here</p><p>the gap is wide</p>'
      document.body.append(node)
      onTestFinished(() => node.remove())
      article.ref(node)
      view.componentDidUpdate()
      const update = (patch) => {
        view.props = { ...view.props, comment: { ...view.props.comment, ...patch } }
        view.componentDidUpdate()
      }
      return { comment, node, update, release: article.props.onPointerUp }
    }

    it('tells the page which of its quotes the text no longer has, the draft\'s never, only as that set changes', () => {
      const marks = [mark('c1', quote('the gap', 'mind ', ' here')), mark('c2', quote('a crack')),
        mark(DRAFT_MARK, quote('a hole')), mark('c9', quote('a crack'), 'docs/other.md')]
      const { comment, update } = drawn({ marks })
      expect(comment.onLost.mock.calls).toEqual([[cutList.file, ['c2']]])
      // drawn again, and with a comment the text has: the same set, nothing told
      update({})
      update({ marks: [...marks, mark('c3', quote('is wide'))] })
      expect(comment.onLost).toHaveBeenCalledTimes(1)
      // the lost one gone from the page: an empty set
      update({ marks: marks.slice(0, 1) })
      expect(comment.onLost.mock.calls).toEqual([[cutList.file, ['c2']], [cutList.file, []]])
    })

    it('scrolls the block a quote the page asks for starts in to the middle, once for the ask, and says it is done', () => {
      const { comment, node, update } = drawn()
      const [first, second] = node.querySelectorAll('p')
      // jsdom scrolls nothing and has no such method
      for (const block of [first, second]) block.scrollIntoView = vi.fn()
      const focus = { doc: cutList.file, quote: quote('the gap is', 'mind the gap here', ' wide') }
      update({ focus })
      // the paragraph its first character is in, not the one it starts at the end of
      expect([first.scrollIntoView.mock.calls, second.scrollIntoView.mock.calls]).toEqual([[], [[{ block: 'center' }]]])
      expect(comment.onFocused).toHaveBeenCalledTimes(1)
      // drawn again with the same ask, then asked for a quote the text no
      // longer has: told done, nothing scrolled
      update({})
      update({ focus: { ...focus, quote: quote('a crack') } })
      expect(second.scrollIntoView).toHaveBeenCalledTimes(1)
      expect(comment.onFocused).toHaveBeenCalledTimes(2)
    })

    it('takes a passage selected in it for the draft\'s place while the tool is armed, and nothing while it is not', () => {
      const { comment, node, update, release } = drawn()
      const range = document.createRange()
      range.setStart(node.querySelector('p').firstChild, 5)
      range.setEnd(node.querySelector('strong').firstChild, 3)
      window.getSelection().addRange(range)
      onTestFinished(() => window.getSelection().removeAllRanges())
      const up = { button: 0, clientX: 0, clientY: 0 }
      release(up)
      expect(comment.onArea).not.toHaveBeenCalled()
      update({ on: true })
      release(up)
      // with up to QUOTE_CONTEXT characters each side, the text running on across blocks
      expect(comment.onArea.mock.calls).toEqual([[cutList,
        { frame: 'text', quote: { text: 'the gap', before: 'mind ', after: ' herethe gap is wide' } }]])
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
  const shown = views
  /** The rows of the list, by what they say, and the click each one makes. */
  const rows = (tree) => collect(tree, (el) => (el.props.onClick && el.type === 'div'
    && texts(el).length === 2 ? texts(el) : undefined))

  it('has the list of views at the bottom and no tabs at the top', () => {
    const tree = page('list.md', { viewsOpen: true })
    expect(ofType(tree, 'button')).toEqual([])
    expect(collect(tree, (el) => (el.props.role === 'tablist' ? el : undefined))).toEqual([])
    // a row per document, in the order meta.json lists them, each of another
    // type and so under a heading of its own, with its size
    expect(rows(tree)).toEqual(META.documents.map((d) => [d.name, '0.0 kB']))
    expect(texts(tree)).toEqual(expect.arrayContaining(['MARKDOWN', 'IMAGE', 'PDF', 'HTML']))
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
    // over a PDF, which takes no comment
    const bar = (extra) => docBar({ meta: META, doc: META.documents[2], onPick: () => {}, ...extra })
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
    expect(rows(tree)).toEqual([['Схема', '1 sheet'], ['Плата', 'board'], ['list.md', '0.0 kB']])
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
    const schematicView = layers(DocPage({ meta: WITH_KICAD, active: SCHEMATIC.id, base: BASE, onPick: () => {} }))[0]
    expect(schematicView.key).toBe(layers(tree)[0].key)
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
    const [layer] = layers(page('report.pdf'))
    const view = layer.props.children
    expect(view.props.doc.id).toBe('report.pdf')
    expect(layer.key).toBe(`${META.commit}:report.pdf`)
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
    // On screen with no row lit, named on the button.
    const tree = DocPage({ meta: WITH_KICAD, active: DATASHEET.id, base: BASE, onPick: () => {}, viewsOpen: true })
    expect(shown(tree)[0].props.doc.id).toBe(DATASHEET.id)
    expect(rows(tree).map(([label]) => label)).not.toContain('ds/ne555.pdf')
    expect(texts(tree)).toContain('ds/ne555.pdf')
  })
})

// The comments' fields of a shell nobody has commented on.
const AT_REST = {
  feed: [], activePin: null, composer: null, sending: false, rail: false, tool: null,
  docFocus: null, docLost: {}, toast: null,
}

describe('the shell', () => {
  let shell
  const mount = (search) => {
    window.history.replaceState(null, '', `${BASE}${search}`)
    rereadPage(BASE)
    shell = new DocShell({ meta: META })
    shell.setState = (patch) => Object.assign(shell.state, patch)
  }
  /** The browser's own Back and Forward, which restore the entry tasks later. */
  const go = async (delta) => {
    const popped = new Promise((done) => { window.addEventListener('popstate', done, { once: true }) })
    window.history.go(delta)
    await popped
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
    expect(shell.state).toEqual({ active: SCHEMATIC.id, viewsOpen: false, tools: null, narrow: false, ...AT_REST,
                                  variants: null, variantsOpen: false, rename: null })
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
      // narrowing puts an armed Comment down: its button leaves the bar, and a
      // phone has no Escape to put it down with
      shell.state.tool = 'comment'
      listeners.forEach((fn) => fn({ matches: true }))
      expect([shell.state.narrow, shell.state.tool]).toEqual([true, null])
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

  it('makes each pick a step of history, and Back brings the one before, the default included', async () => {
    mount('')
    shell.componentDidMount()
    // a schematic's sheet (`s=`) goes with the document it is of: a pick
    // opens a design on its root sheet; the rest of the address stays
    window.history.replaceState({ hmr: 'latest' }, '', `${BASE}?x=1&s=amp`)
    const push = vi.spyOn(window.history, 'pushState')
    try {
      shell.pick('report.pdf')
      shell.pick('report.pdf')
      expect(push).toHaveBeenCalledTimes(1)
      expect([window.location.search, window.history.state]).toEqual(['?x=1&d=report.pdf', { hmr: 'latest' }])
      await go(-1)
      expect([window.location.search, shell.state.active]).toEqual(['?x=1&s=amp', 'list.md'])
      await go(1)
      expect(shell.state.active).toBe('report.pdf')
    } finally {
      shell.componentWillUnmount()
      push.mockRestore()
    }
  })

  it('follows a markdown link to its own address as a step of history, and one naming only a view nowhere', async () => {
    window.history.replaceState(null, '', `${BASE}?d=list.md&files=k1`)
    rereadPage(BASE)
    shell = new DocShell({ meta: WITH_KICAD })
    shell.setState = (patch) => Object.assign(shell.state, patch)
    shell.componentDidMount()
    onTestFinished(() => shell.componentWillUnmount())
    const [shown] = views(DocPage(shell.render().props))
    const note = new DocumentView(shown.props)
    note.state.text = `[open](?v=open) [amp](?d=${SCHEMATIC.id}&s=amp)`
    const [view, sheet] = ofType(note.render(), 'a')
    const push = vi.spyOn(window.history, 'pushState')
    onTestFinished(() => push.mockRestore())
    const click = (a) => {
      const event = { button: 0, preventDefault: vi.fn() }
      a.props.onClick(event)
      return event.preventDefault.mock.calls.length
    }
    // this page has no views: no step, and no load of the page either
    expect(click(view)).toBe(1)
    expect([push.mock.calls.length, window.location.search, shell.state.active]).toEqual([0, '?d=list.md&files=k1', 'list.md'])
    click(sheet)
    expect([push.mock.calls.length, window.location.search, shell.state.active])
      .toEqual([1, `?files=k1&d=${SCHEMATIC.id}&s=amp`, SCHEMATIC.id])
    await go(-1)
    expect([window.location.search, shell.state.active]).toEqual(['?d=list.md&files=k1', 'list.md'])
  })

  it('makes a sheet picked under the schematic a step whose address names it, on the schematic on screen too', () => {
    window.history.replaceState(null, '', `${BASE}?x=1`)
    rereadPage(BASE)
    shell = new DocShell({ meta: WITH_KICAD })
    shell.setState = (patch) => Object.assign(shell.state, patch)
    const push = vi.spyOn(window.history, 'pushState')
    onTestFinished(() => push.mockRestore())
    const pick = (id, sheet) => shell.render().props.onPick(id, sheet)
    // the default schematic, on screen with no `?d=`, then its root
    pick(SCHEMATIC.id, 'amp')
    pick(SCHEMATIC.id, 'amp')
    expect([push.mock.calls.length, window.location.search]).toEqual([1, '?x=1&s=amp'])
    pick(SCHEMATIC.id, '')
    expect(window.location.search).toBe('?x=1')
    // from the board
    pick(BOARD.id)
    pick(SCHEMATIC.id, 'hw/psu.kicad_sch:/r/b')
    expect([push.mock.calls.length, window.location.search, shell.state.active])
      .toEqual([4, `?x=1&s=${encodeURIComponent('hw/psu.kicad_sch:/r/b')}`, SCHEMATIC.id])
  })

  it('names the default schematic\'s sheet as `?s=` with no `?d=`: a link opens on it, each change is a step Back undoes', async () => {
    const ROOT = 'hw/board.kicad_sch:/root'
    const AMP = 'hw/board.kicad_sch:/root/amp'
    const PSU = 'hw/board.kicad_sch:/root/psu'
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(`<${url}>`)))
    window.history.replaceState(null, '', `${BASE}?s=amp`)
    rereadPage(BASE)
    shell = new DocShell({ meta: WITH_KICAD })
    shell.setState = (patch) => Object.assign(shell.state, patch)
    // The design as the page draws it, its schematic's element switching sheets
    // as the viewer does, reporting the change inside `switchPage`.
    const [shown] = views(DocPage(shell.render().props))
    const view = new KicadView(new DocumentView(shown.props).render().props)
    view.setState = (patch, done) => {
      Object.assign(view.state, patch)
      if (done) done()
    }
    const sch = Object.assign(document.createElement('ecad-viewer'), {
      page: ROOT,
      replaceSources: async () => {},
      getSchematicPages: () => [ROOT, AMP, PSU].map((projectPath, i) => ({
        projectPath, name: projectPath.split('/').at(-1), parentProjectPath: i ? ROOT : null })),
      getActiveSchematicPage: () => ({ projectPath: sch.page }),
      switchPage: (to) => {
        sch.page = to
        sch.dispatchEvent(new CustomEvent(PAGE_EVENT))
        return true
      },
    })
    view.refCallbacks[SCH](sch)
    shell.componentDidMount()
    view.componentDidMount()
    try {
      await vi.waitFor(() => expect(view.state.ready).toBe(true))
      expect([sch.page, window.location.search]).toEqual([AMP, '?s=amp'])
      sch.switchPage(PSU)
      expect(window.location.search).toBe('?s=psu')
      await go(-1)
      expect([sch.page, window.location.search, shell.state.active]).toEqual([AMP, '?s=amp', SCHEMATIC.id])
    } finally {
      view.componentWillUnmount()
      shell.componentWillUnmount()
      vi.unstubAllGlobals()
    }
  })
})

// -- comments, as over a document on the model's page ---------------------------

describe('comments on the page of a build with no model', () => {
  const STAMP = '2026-10-26T18:00:00.123Z'
  const BUILD = { ...WITH_KICAD, published: STAMP }
  /** A comment the hub stored on the amp sheet of the schematic. */
  const stored = (over) => ({
    id: 'c1', pid: 'docs0001', commit: BUILD.commit, published: STAMP, view: null, part: null, key: null,
    point: null, camera: null, text: 'too hot', status: 'open', created: '2026-10-26T18:20:00Z',
    resolved: null, note: null, doc: SCHEMATIC.file, frame: 'sheet', sheet: 'hw/amp.kicad_sch',
    area: [10, 20, 4, 6], items: ['C1'], ...over,
  })
  // and one on a part of a model, which this build has none of
  const ON_MODEL = stored({ id: 'c2', doc: null, frame: 'part', sheet: null, area: null, items: null,
    part: '/model/plate', key: 'plate', view: 'assembled', text: 'too thin' })
  const CLICK = { stopPropagation() {} }

  /** The shell a reader opens at `search`, with the token unless `token` is
   *  null, its `setState` React's contract (a function patch, the callback
   *  after). The hub answers a request with what `answer(url, init)` gives,
   *  `[status, body]`. */
  const opened = ({ search = '', token = 'sekrit', answer = () => [200, { comments: [] }] } = {}) => {
    if (token) writeToken(token)
    else clearToken()
    onTestFinished(() => clearToken())
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const [status, body] = answer(url, init)
      return new Response(JSON.stringify(body), { status })
    }))
    onTestFinished(() => vi.unstubAllGlobals())
    window.history.replaceState(null, '', `${BASE}${search}`)
    rereadPage(BASE)
    const shell = new DocShell({ meta: BUILD })
    shell.setState = (patch, done) => {
      Object.assign(shell.state, typeof patch === 'function' ? patch(shell.state) : patch)
      if (done) done()
    }
    onTestFinished(() => shell.componentWillUnmount())
    return shell
  }
  const values = (shell) => shell.render().props.comments
  const drawn = (shell) => DocPage(shell.render().props)
  /** The bar's Comment, as drawn. */
  const commentTool = (shell) => collect(drawn(shell), (el) => (el.props.onClick && texts(el).join('') === 'Comment'
    ? el : undefined))[0]
  const posted = (shell) => fetch.mock.calls.filter(([, init]) => init && init.method === 'POST')

  afterEach(() => {
    window.history.replaceState(null, '', '/')
    rereadPage('/')
  })

  it('arms Comment over a document that takes one, saying how, and keeps it out of service over one that does not', () => {
    const shell = opened()
    expect(commentTool(shell).props.style.pointerEvents).not.toBe('none')
    commentTool(shell).props.onClick()
    expect([shell.state.tool, shell.state.toast, values(shell).docComment.on])
      .toEqual(['comment', 'Drag an area on the drawing to pin the task', true])
    commentTool(shell).props.onClick()
    expect(values(shell).docComment.on).toBe(false)
    expect(commentTool(opened({ search: '?d=ds__ne555.pdf' })).props.style.pointerEvents).toBe('none')
    // and hidden from a reader without the token, who has no comments button
    const reader = opened({ token: null })
    expect(commentTool(reader).props.style.display).toBe('none')
    expect(css(values(reader).railBtnStyle).display).toBe('none')
  })

  it('takes a place on the document into the composer, puts the tool down, and posts it with the document\'s frame', async () => {
    const shell = opened({ answer: (url, init) => (init && init.method === 'POST' ? [201, { id: 'c1' }]
      : [200, { comments: [stored()] }]) })
    shell.state.tool = 'comment'
    const shot = new Blob(['png'], { type: 'image/png' })
    shell.onTools({ fit() {}, frame: async () => shot })
    const [view] = views(drawn(shell))
    view.props.comment.onArea(SCHEMATIC, { frame: 'sheet', sheet: 'hw/amp.kicad_sch', area: [10, 20, 4, 6], items: ['C1'] })
    expect(shell.state.tool).toBeNull()
    expect([css(values(shell).composerStyle).display, values(shell).composerPart]).toEqual(['block', 'amp of Схема'])
    values(shell).compType({ target: { value: 'too hot' } })
    await values(shell).compSend()

    const [[url, init]] = posted(shell)
    expect(url).toBe(`/api/v1/comments/docs0001/${BUILD.commit}`)
    expect(JSON.parse(init.body.get('comment'))).toEqual({
      text: 'too hot', doc: SCHEMATIC.file, frame: 'sheet', sheet: 'hw/amp.kicad_sch', area: [10, 20, 4, 6],
      items: ['C1'], published: STAMP, view: null, camera: null,
    })
    expect(init.body.get('shot').name).toBe('shot.png')
    // read back off the hub, the rail open on it
    expect([shell.state.composer, shell.state.rail, shell.state.feed]).toEqual([null, true, [stored()]])
  })

  it('loads the queue on arrival with the token, counts the open ones on the header\'s button and lists them all in the rail', async () => {
    const shell = opened({ answer: () => [200, { comments: [stored(), ON_MODEL, stored({ id: 'c3', status: 'resolved' })] }] })
    shell.componentDidMount()
    await vi.waitFor(() => expect(shell.state.feed).toHaveLength(3))
    expect(fetch).toHaveBeenCalledWith('/api/v1/comments?project=docs0001', { headers: { 'X-Hammerola-Token': 'sekrit' } })
    const button = collect(drawn(shell), (el) => (el.props.onClick && texts(el)[0] === 'Comments' ? el : undefined))[0]
    expect(texts(button)).toEqual(['Comments', '2'])
    expect(css(values(shell).railStyle).display).toBe('none')
    button.props.onClick(CLICK)
    expect(css(values(shell).railStyle).display).toBe('flex')
    expect(values(shell).threads.map((t) => t.says)).toEqual(['on amp of Схема — near C1',
      'left on the model, which this build does not have', 'on amp of Схема — near C1'])
    expect(texts(drawn(shell))).toEqual(expect.arrayContaining(['too hot', 'too thin', 'on amp of Схема — near C1']))
    // a reader without the token asks for nothing but the project's
    // variants, which are public
    opened({ token: null }).componentDidMount()
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/project/docs0001/variants.json'])
  })

  it('opens a row\'s document at its place as a step of history, the sheet the reader\'s step where it was on screen, and a row on a model nowhere', () => {
    const shell = opened({ search: '?d=list.md' })
    Object.assign(shell.state, { feed: [stored(), ON_MODEL] })
    const push = vi.spyOn(window.history, 'pushState')
    onTestFinished(() => push.mockRestore())
    const row = (i) => values(shell).threads[i].onOpen(CLICK)
    row(0)
    expect([push.mock.calls.length, window.location.search, shell.state.active, shell.state.activePin])
      .toEqual([1, '', SCHEMATIC.id, 'c1'])
    expect(shell.state.docFocus).toEqual({ doc: SCHEMATIC.file, sheet: 'hw/amp.kicad_sch', area: [10, 20, 4, 6], step: false })
    row(0)
    expect([push.mock.calls.length, shell.state.docFocus.step]).toEqual([1, true])
    row(1)
    expect([push.mock.calls.length, shell.state.active, shell.state.activePin]).toEqual([1, SCHEMATIC.id, 'c2'])
    // another document picked drops the place asked for, so it is not shown later
    shell.pick(BOARD.id)
    expect(shell.state.docFocus).toBeNull()
  })

  it('marks the open comments and the draft on the document, a mark lighting its row in the opened rail', () => {
    const shell = opened()
    Object.assign(shell.state, { feed: [stored(), stored({ id: 'c3', status: 'resolved' })],
      composer: { doc: BOARD.file, frame: 'board', area: [1, 2, 3, 4], text: '' } })
    const { marks, onMarker } = values(shell).docComment
    expect(marks.map((one) => [one.id, one.doc, one.active])).toEqual([['c1', SCHEMATIC.file, false],
      [DRAFT_MARK, BOARD.file, true]])
    onMarker(DRAFT_MARK)
    expect(shell.state.rail).toBe(false)
    onMarker('c1')
    expect([shell.state.activePin, shell.state.rail]).toEqual(['c1', true])
  })

  it('marks a row processed and reads the queue back', async () => {
    const shell = opened({ answer: (url) => (url.endsWith('/resolve') ? [200, {}]
      : [200, { comments: [stored({ status: 'resolved' })] }]) })
    Object.assign(shell.state, { feed: [stored()] })
    values(shell).threads[0].onResolve(CLICK)
    await vi.waitFor(() => expect(shell.state.feed[0].status).toBe('resolved'))
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/comments/c1/resolve',
      '/api/v1/comments?project=docs0001'])
  })

  it('puts the armed tool down on Escape, taking it before a design under it hears it', () => {
    const shell = opened()
    // KicadView's listener, on the window before the shell's
    const design = vi.fn((event) => event.defaultPrevented)
    window.addEventListener('keydown', design)
    onTestFinished(() => window.removeEventListener('keydown', design))
    shell.componentDidMount()
    const escape = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    shell.state.tool = 'comment'
    escape()
    expect(shell.state.tool).toBeNull()
    // nothing armed: the Escape is the design's
    escape()
    expect(design.mock.results.map((one) => one.value)).toEqual([true, false])
  })
})
