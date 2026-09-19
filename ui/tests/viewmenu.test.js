// The view switcher in the floating toolbar: a strip of pills while the views
// fit on one, a menu once they do not.
//
// WHY THERE IS A SECOND SHAPE AT ALL. The strip is a centred flex row that does
// not wrap, inside a root that is `overflow:hidden` — so a row wider than the
// window is neither scrollable nor shrunk to fit: it pushes the whole toolbar
// past both edges, where the root clips its ends away, taking Fit and the tools
// with it, and the names inside the pills break onto three lines each. A model declaring nine views with sentences for
// names is what that was seen on. `VIEW_TABS_MAX` is the line between the two
// shapes and it is IMPORTED here rather than typed again: two copies of a
// threshold are two thresholds, and the one in the test is the one that would
// go on passing after the source moved.
//
// ONE LIST BEHIND BOTH SHAPES. `viewTabs` carries a pill style and a row style
// per view, and every case below reads the same entries — because which shape
// is on screen is a question about how MANY views there are and about nothing
// else. The assertions are therefore about which of the two dresses reached the
// screen, never about a second list built somewhere.
//
// NOTHING IS MOUNTED, the arrangement every file in this directory uses: the
// instance is the real prototype with the state spelled out, `computed()` and
// `render()` are the real ones, and what they drew is read straight off the
// returned element objects (ui/tests/eltree.js). Elements are found by style
// IDENTITY — `css()` caches by string, so the object the render put on an
// element is the very one `computed()` names — which is ui/tests/narrow.test.js's
// reading and needs no DOM.

import { describe, expect, it, vi } from 'vitest'

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
    expect(drawnWith(c, v.viewBtnStyle)).toHaveLength(0)
    expect(drawnWith(c, v.viewMenuStyle)).toHaveLength(0)
  })

  it('folds into one button the moment there is a view past the threshold', () => {
    const c = component({ views: someViews(VIEW_TABS_MAX + 1) })
    const v = c.computed()

    expect(v.viewMenu).toBe(true)
    expect(drawnWith(c, v.viewBtnStyle)).toHaveLength(1)
    expect(drawnWith(c, v.viewMenuStyle)).toHaveLength(1)
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

  it('keeps a long name from widening the toolbar it sits in', () => {
    // A view's name is the model's own sentence. The button is inside the same
    // non-wrapping row the strip was, so an uncapped name reintroduces the
    // failure the menu was written to remove.
    const v = component({ views: someViews(9) }).computed()
    expect(v.viewBtnStyle).toContain('max-width')
    expect(v.viewLabelStyle).toContain('text-overflow:ellipsis')
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
    expect(css(c.computed().viewMenuStyle).display).toBe('none')

    c.computed().viewsToggle(click)
    expect(c.state.viewsOpen).toBe(true)
    expect(css(c.computed().viewMenuStyle).display).toBe('block')

    c.computed().viewsToggle(click)
    expect(css(c.computed().viewMenuStyle).display).toBe('none')
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
    // carries a `backdrop-filter`, which makes it a stacking context, so a
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
    // The toolbar's `backdrop-filter` makes it a containing block for `fixed`
    // descendants as well as `absolute` ones (CSS Filter Effects 2, §2.1), so a
    // sheet would clamp itself to the TOOLBAR's box rather than the window and
    // come up over the button that opened it. No clamp is needed anyway: the
    // toolbar is centred on the bottom edge and narrow leaves this button and
    // Fit in it, so 260px from the button's left edge is inside the window.
    const wide = css(component({ views: someViews(9) }).computed().viewMenuStyle)
    const narrow = css(component({ views: someViews(9), narrow: true }).computed().viewMenuStyle)

    for (const style of [wide, narrow]) {
      expect(style.position).toBe('absolute')
      expect(style.width).toBe('260px')
      expect(style.bottom).toBe('38px')
    }
    // A model may declare twenty views and the root is `overflow:hidden`, so a
    // menu taller than the window would be cut off rather than scrolled.
    expect(wide.maxHeight).toBe('308px')
    expect(wide.overflow).toBe('auto')
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
