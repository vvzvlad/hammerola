// The view switcher in the floating toolbar: a strip of pills while the views
// fit on one, a menu once they do not.
//
// The strip is what shrinks when the toolbar is short of room, so a row wider
// than the window squeezes its pills until their names are cut to an ellipsis.
// `VIEW_TABS_MAX` is the line between the two shapes and is imported rather
// than retyped.
//
// One list behind both shapes: `viewTabs` carries a pill style and a row style
// per view, and which shape is on screen depends only on how many views there
// are. The assertions are about which of the two reached the screen.
//
// Nothing is mounted: the real prototype runs with the state spelled out, and
// what `computed()` and `render()` drew is read off the returned elements
// (ui/tests/eltree.js). Elements are found by style identity: `css()` caches by
// string, so the object on an element is the one `computed()` names
// (as in ui/tests/narrow.test.js).

import { describe, expect, it, onTestFinished, vi } from 'vitest'

// `vi.hoisted` and ONE MUTABLE OBJECT, exactly as ui/tests/tabs.test.js does it:
// `PAGE` is read at the moment `computed()` runs.
const { PAGE } = vi.hoisted(() => ({
  PAGE: { pid: 'proj1', slot: 'latest', base: '/project/proj1/latest/' },
}))

vi.mock('../src/hub.js', async (importOriginal) => ({
  ...(await importOriginal()),
  PAGE,
}))

import HammerolaViewer, { VIEW_TABS_MAX } from '../src/HammerolaViewer.jsx'
import { css } from '../src/style.jsx'
import { viewButtonStyle, viewMenuStyle } from '../src/viewlist.jsx'
import { makeComponent, replaceState } from './component.js'
import { collect, texts } from './eltree.js'

/** As many views as asked for, named the way a model's code names them. */
const someViews = (count) => Array.from({ length: count }, (unused, i) => ({
  id: `v${i}`, name: `view number ${i}`, file: `v${i}.json`, parts: ['lid'], gzip: 1000,
}))

/**
 * The component as `computed()` and `render()` see it, holding a build's views.
 *
 * `sync` is a double because `showView` goes through `set()`, which is
 * `setState` plus a message to a viewport that is not here.
 */
function component({ views = someViews(2), view = 'v0', narrow = false } = {}) {
  return makeComponent(HammerolaViewer, {
    setState: replaceState,
    sync: vi.fn(),
    state: {
      meta: {
        project: 'fixture', title: 'Fixture bracket', commit: 'abc1234',
        built: '2026-08-27T18:20:00Z',
        parts: { lid: { kind: 'printable', files: { stl: 'lid.stl' } } },
        views,
      },
      view,
      viewsOpen: false,
      rail: null, menu: { id: null, x: 0, y: 0 },
      narrow,
    },
  })
}

const click = { stopPropagation() {}, preventDefault() {} }

/** Every element the page drew with exactly this style, found by identity. */
const drawnWith = (c, style) => {
  const wanted = css(style)
  return collect(c.render(), (el) => (el.props.style === wanted ? el : undefined))
}

// -- which of the two shapes is on screen -------------------------------------

describe('how many views it takes to fold the strip into a menu', () => {
  it('draws a pill per view while they still fit, and no button', () => {
    const c = component({ views: someViews(VIEW_TABS_MAX) })
    const v = c.computed()

    expect(v.viewMenu).toBe(false)
    expect(v.viewTabs).toHaveLength(VIEW_TABS_MAX)
    v.viewTabs.forEach((t) => expect(drawnWith(c, t.style)).not.toHaveLength(0))
    // The menu's two halves are ABSENT rather than hidden: a button that named
    // the current view beside a strip that already names every view would be
    // the switcher twice over.
    expect(drawnWith(c, viewButtonStyle(false))).toHaveLength(0)
    expect(drawnWith(c, viewMenuStyle(false))).toHaveLength(0)
  })

  it('folds into one button the moment there is a view past the threshold', () => {
    const c = component({ views: someViews(VIEW_TABS_MAX + 1) })
    const v = c.computed()

    expect(v.viewMenu).toBe(true)
    expect(drawnWith(c, viewButtonStyle(false))).toHaveLength(1)
    expect(drawnWith(c, viewMenuStyle(false))).toHaveLength(1)
    // And the pills are gone with it — left standing they would be the row that
    // stretched the toolbar, with a button beside it for company.
    v.viewTabs.forEach((t) => expect(drawnWith(c, t.style)).toHaveLength(0))
  })

  it('says which view is on screen, since nothing else on the toolbar does', () => {
    // The whole of what the button has to carry: with the strip folded away,
    // this label is the only thing on the page naming the arrangement in front
    // of the reader.
    const c = component({ views: someViews(9), view: 'v6' })
    expect(c.computed().viewLabel).toBe('view number 6')
    expect(texts(c.render())).toContain('view number 6')
  })

  it('says nothing at all where no view matches', () => {
    // Reachable: `view` is null until the first view lands. A button captioned
    // `undefined` is worse than a bare one.
    const c = component({ views: someViews(9), view: null })
    expect(c.computed().viewLabel).toBe('')
  })

  it('anchors the card to the view button', () => {
    // The bar's `contain:layout` makes it a containing block for the card, so
    // without a `position:relative` wrapper round the button the card would be
    // measured from the bar's whole box and start at its left end (`viewList`).
    const menu = component({ views: someViews(9) }).render()
    const wrapper = collect(menu, (el) => (el.type === 'div' && el.props.style && el.props.style.flexShrink === '100' ? el : undefined))
    expect(wrapper.map((el) => el.props.style.position)).toEqual(['relative'])
  })

  it('names the view whole in a pill\'s tooltip, since a short bar cuts its caption', () => {
    // In the strip there is no menu to read the names in, so the hover is the
    // only place a cut name can be read at all.
    const c = component({ views: someViews(2), view: 'v1' })
    const titles = c.computed().viewTabs.flatMap((t) => drawnWith(c, t.style).map((el) => el.props.title))
    expect(titles.map((title) => title.split(' · ')[0])).toEqual(['view number 0', 'view number 1'])
  })
})

// -- opening and closing it ----------------------------------------------------

describe('the menu itself', () => {
  const opened = (over) => {
    const c = component({ views: someViews(9), ...over })
    c.computed().viewsToggle(click)
    return c
  }

  it('is closed until it is asked for, and the toggle takes it back', () => {
    const c = component({ views: someViews(9) })
    expect(drawnWith(c, viewMenuStyle(false))).toHaveLength(1)

    c.computed().viewsToggle(click)
    expect(c.state.viewsOpen).toBe(true)
    expect(drawnWith(c, viewMenuStyle(true))).toHaveLength(1)

    c.computed().viewsToggle(click)
    expect(drawnWith(c, viewMenuStyle(false))).toHaveLength(1)
  })

  it('draws a row per view, whichever one is showing', () => {
    const c = opened()
    const v = c.computed()
    expect(v.viewTabs).toHaveLength(9)
    v.viewTabs.forEach((t) => expect(drawnWith(c, t.rowStyle)).not.toHaveLength(0))
    expect(texts(c.render())).toContain('view number 8')
  })

  it('marks the row the reader is already on, and only that one', () => {
    // A list of nine identical lines says nothing about where you are — and the
    // strip it replaced had the answer built into it.
    const v = component({ views: someViews(9), view: 'v3' }).computed()
    const marked = v.viewTabs.filter((t) => t.rowStyle.includes('var(--accent-bg)'))
    expect(marked.map((t) => t.key)).toEqual(['v3'])
    v.viewTabs.filter((t) => t.key !== 'v3')
      .forEach((t) => expect(t.rowStyle).toContain('color:var(--text)'))
  })

  it('switches the view and closes behind the row that was pressed', () => {
    const c = opened({ view: 'v0' })
    c.computed().viewTabs[5].onClick()

    expect(c.state.view).toBe('v5')
    expect(c.sync).toHaveBeenCalled()
    expect(c.state.viewsOpen).toBe(false)
  })

  it('closes on the row naming the view already showing, which changes nothing', () => {
    // `showView` returns without touching a thing when the view asked for is
    // the one on screen — so the close cannot ride on the state change.
    const c = opened({ view: 'v2' })
    c.computed().viewTabs[2].onClick()

    expect(c.state.view).toBe('v2')
    expect(c.state.viewsOpen).toBe(false)
  })

  it('goes away on a click anywhere else on the page', () => {
    const c = opened()
    c.computed().rootClick()
    expect(c.state.viewsOpen).toBe(false)
  })

  it('raises the whole toolbar while it is open, and puts it back after', () => {
    // The layer has to move on the CONTAINER and not on the menu: the toolbar
    // carries `contain:layout`, which makes it a stacking context, so a
    // `z-index` inside it only sorts the toolbar's own children. Unraised, the
    // overlays that share the model's area — the view-error card at 14, the
    // section panel at 15, the composer at 16 — take the click meant for a row
    // they cover. Raised, it must still sit under the rail (20) and the header
    // (30), the two things allowed to cover the toolbar.
    const c = component({ views: someViews(9) })
    expect(css(c.computed().toolbarStyle).zIndex).toBe('12')

    c.computed().viewsToggle(click)
    expect(css(c.computed().toolbarStyle).zIndex).toBe('17')

    c.computed().viewsToggle(click)
    expect(css(c.computed().toolbarStyle).zIndex).toBe('12')
  })

  it('clears the overlays it has to clear, and none of the two above it', () => {
    // The list on `toolbarStyle` is a specification and not a remark, so it is
    // asserted rather than described: a composer moved to 18 would open over
    // the menu and take the clicks meant for its rows, and a raised toolbar
    // that also beat the header would cover the controls up there. Read off
    // the other panels' own styles rather than from numbers copied to here,
    // which is what makes the case fail when one of them moves. `narrow`
    // because the rail is the one of the five that carries a layer only at
    // phone width.
    const c = component({ views: someViews(9), narrow: true })
    c.computed().viewsToggle(click)
    const v = c.computed()
    const layer = (style) => Number(css(style).zIndex)

    for (const under of [v.viewErrorStyle, v.secPopStyle, v.composerStyle]) {
      expect(layer(v.toolbarStyle)).toBeGreaterThan(layer(under))
    }
    for (const over of [v.railStyle, v.headerStyle]) {
      expect(layer(v.toolbarStyle)).toBeLessThan(layer(over))
    }
  })

  it('stays where it is on a narrow window, unlike every other popover here', () => {
    // NOT `popSheet`, and this is the case that stops it being "fixed" into one.
    // The toolbar's `contain:layout` makes it a containing block for `fixed`
    // descendants as well as `absolute` ones (CSS Containment 1, §3.2), so a
    // sheet would clamp itself to the TOOLBAR's box rather than the window and
    // come up over the button that opened it. No clamp is needed anyway: the
    // toolbar is centred on the bottom edge and narrow leaves this button and
    // Fit in it, so 260px from the button's left edge is inside the window.
    const card = css(viewMenuStyle(true, false))
    expect(drawnWith(component({ views: someViews(9), narrow: true }), viewMenuStyle(false, false))).toHaveLength(1)
    expect(card.position).toBe('absolute')
    expect(card.width).toBe('260px')
    expect(card.bottom).toBe('38px')
    // A model may declare twenty views and the header lies over the bar, so a
    // menu reaching under it would hide its first rows: the card is capped and
    // scrolls, beside the tools off the window's height.
    expect(card.maxHeight).toBe('308px')
    expect(card.overflow).toBe('auto')
    expect(css(viewMenuStyle(true))).toMatchObject({ maxHeight: 'calc(100dvh - 240px)' })
  })

  it('goes away when another popover opens, so only one is ever up', () => {
    const c = opened()
    c.computed().dlToggle(click)
    expect(c.state.viewsOpen).toBe(false)
    expect(c.state.dlOpen).toBe(true)

    c.computed().viewsToggle(click)
    expect(c.state.viewsOpen).toBe(true)
    expect(c.state.dlOpen).toBe(false)
    expect(c.state.revOpen).toBe(false)
    expect(c.state.tokenPop).toBe(false)
  })
})

// -- View in AR ------------------------------------------------------------------

describe('View in AR, in a browser with AR Quick Look', () => {
  /** The page in such a browser, whose `ar` is as given. */
  const arPage = ({ ar = null, ...over } = {}) => {
    const c = component({ views: someViews(2), ...over })
    Object.assign(c, { arCapable: true })
    c.state = { ...c.state, ar }
    return c
  }
  /** The button `View in AR` the page drew, if any. */
  const arButtons = (c) => collect(c.render(), (el) => (el.key === 'ar' ? el : undefined))
  /** A promise and the hand that settles it, for an export still running. */
  const deferred = () => {
    let resolve
    const promise = new Promise((done) => { resolve = done })
    return { promise, resolve }
  }
  /**
   * The browser's side of handing a file to Quick Look, doubled: jsdom has no
   * object URLs, and a click on a link would navigate. Each address made is
   * `blob:https://hub/<n>` and remembers the blob it was made of; each link
   * clicked is recorded as Safari would read it.
   */
  const quickLook = () => {
    const blobs = []
    const clicked = []
    Object.assign(URL, {
      createObjectURL: vi.fn((blob) => `blob:https://hub/${blobs.push(blob)}`),
      revokeObjectURL: vi.fn(),
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
      clicked.push({ rel: this.rel, href: this.getAttribute('href'),
        elements: [...this.children].map((child) => child.tagName), inPage: document.body.contains(this) })
    })
    onTestFinished(() => vi.restoreAllMocks())
    return { blobs, clicked }
  }
  /** The page with a viewport whose `usdz()` hands out these exports, in turn. */
  const exporting = (...exports) => {
    const c = arPage()
    const usdz = vi.fn()
    exports.forEach((one) => usdz.mockReturnValueOnce(one.promise))
    c.host = { current: { usdz } }
    return { c, usdz }
  }
  /** Long enough for a settled export to have been acted on. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('is a button of the bar, and a strip of two views stays a strip', () => {
    expect(component({ views: someViews(2) }).computed().arBtn).toBe(null)
    const c = arPage()
    expect(c.computed().viewMenu).toBe(false)
    const [button] = arButtons(c)
    expect(texts(button)).toContain('AR')
    expect(typeof button.props.onClick).toBe('function')
    // A phone's window is narrow, where the bar keeps only the views and Fit.
    expect(arButtons(arPage({ narrow: true }))).toHaveLength(1)
  })

  it('makes the file on a tap and hands it to Quick Look at 1:1 through a link Safari takes for one', async () => {
    const { blobs, clicked } = quickLook()
    const file = deferred()
    const { c, usdz } = exporting(file)
    arButtons(c)[0].props.onClick(click)
    // out of service while the file is made
    expect(c.computed().arBtn).toEqual({ onClick: null })
    expect(arButtons(c)[0].props.onClick).toBeUndefined()
    await vi.waitFor(() => expect(usdz).toHaveBeenCalledTimes(1))
    file.resolve(new Uint8Array(3))
    await vi.waitFor(() => expect(c.state.ar).toBe(null))
    expect(blobs.map((blob) => [blob.size, blob.type])).toEqual([[3, 'model/vnd.usdz+zip']])
    // `rel="ar"` and an <img> its one element (WebKit's `isSystemPreviewLink`),
    // the pinch to rescale turned off, and the link gone after the click
    expect(clicked).toEqual([{ rel: 'ar', href: 'blob:https://hub/1#allowsContentScaling=0',
      elements: ['IMG'], inPage: true }])
    expect(document.querySelectorAll('a[rel="ar"]')).toHaveLength(0)
    expect(URL.revokeObjectURL.mock.calls).toEqual([['blob:https://hub/1']])
  })

  it('says in a toast it failed where no file could be made, opens nothing and can be tapped again', async () => {
    const { blobs, clicked } = quickLook()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const file = deferred()
    const { c } = exporting(file)
    c.toast = vi.fn()
    c.computed().arBtn.onClick()
    file.resolve(null)
    await vi.waitFor(() => expect(c.toast).toHaveBeenCalledWith('Could not make the AR file'))
    expect([blobs, clicked, c.state.ar]).toEqual([[], [], null])
    const [button] = arButtons(c)
    expect(typeof button.props.onClick).toBe('function')
  })

  it('writes nothing once the page is gone', async () => {
    const { blobs, clicked } = quickLook()
    const file = deferred()
    const { c, usdz } = exporting(file)
    c.computed().arBtn.onClick()
    await vi.waitFor(() => expect(usdz).toHaveBeenCalledTimes(1))
    c.componentWillUnmount()
    const writes = c.setState.mock.calls.length
    file.resolve(new Uint8Array(3))
    await settle()
    expect([c.setState.mock.calls.length, blobs, clicked]).toEqual([writes, [], []])
  })

  it('stays in the bar over a document, which is not the model, out of service', () => {
    const doc = { id: 'notes.md', name: 'notes.md', type: 'markdown', file: 'notes.md', bytes: 9 }
    const c = arPage()
    c.state = { ...c.state, doc: 'notes.md', meta: { ...c.state.meta, documents: [doc] } }
    expect(c.computed().arBtn.onClick).toBe(null)
    const [button] = arButtons(c)
    expect(button.props.onClick).toBeUndefined()
  })
})
