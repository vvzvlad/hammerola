// The narrow layout: what these two pages do when the window is the width of a
// phone rather than of a desk.
//
// ONE BOOLEAN IN STATE, NOT A `@media` BLOCK, and that decision is the reason
// this file can exist at all. `css()` in ui/src/style.jsx turns every rule in
// the bundle into an INLINE style object, which beats a class rule on
// specificity, so a stylesheet could only reach these elements by shouting
// `!important` at each of them; half of what changes below is structural
// anyway — which toolbar buttons EXIST — which no stylesheet can express; and
// jsdom evaluates no media query, so a `@media` layout would be the one part of
// a heavily-tested interface that nothing here could reach. The flag is state,
// so a test sets it the way it sets any other field.
//
// WHICH IS ALSO THE TRAP THIS FILE IS WRITTEN AGAINST: `narrow` is read in
// `computed()`, once, and every value that depends on it is a string baked
// there. A branch that quietly stopped being taken would leave the wide layout
// on a phone and no test complaining — so every case below asserts BOTH sides,
// narrow and wide. An assertion that only ever saw one of them would pass on a
// flag nothing reads.
//
// NOTHING IS MOUNTED except in the four cases where the lifecycle IS the
// subject — three that cross the breakpoint with the page open and one that
// takes the page away, which together are the only way to reach the listener
// `componentDidMount` registers. Everywhere else the
// instance is the real prototype with the state spelled out, `computed()` and
// `render()` are the real ones, and what they drew is read off the returned
// element objects (ui/tests/eltree.js). The arrangement is
// ui/tests/header.test.js's and ui/tests/tabs.test.js's.
//
// WHAT IS DELIBERATELY NOT HERE: the size of anything a finger has to hit. The
// 24px tree row, the 24×24 eye and the 22×24 ghost are untouched by this work
// and no case below asserts anything about them — this is about what fits on
// the screen, not about what is comfortable to aim at.

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

// `vi.hoisted` and ONE MUTABLE OBJECT, exactly as ui/tests/header.test.js does
// it: `PAGE` is read at the moment `computed()` runs, so the address is a field
// assignment rather than a re-mock.
const { REV, PAGE } = vi.hoisted(() => {
  const rev = 'e05f73ba91b263b8517147e338d23e868533c6a034a342ad5926abb6edcb7b40'
  return { REV: rev, PAGE: { pid: 'proj1', slot: rev, base: `/project/proj1/${rev}/` } }
})

vi.mock('../src/hub.js', async (importOriginal) => ({
  ...(await importOriginal()),
  PAGE,
  loadMeta: vi.fn(),
  loadBuilds: vi.fn(),
}))

import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { HammerolaProjects, VIEW_BODIES } from '../src/HammerolaEntry.jsx'
import { indexTree } from '../src/hub.js'
import { css, NARROW } from '../src/style.jsx'
import { collect, styles, texts } from './eltree.js'

/**
 * A `matchMedia` that answers what the test says and remembers who is listening.
 *
 * DEFINED RATHER THAN SPIED ON, and that is a fact about this runner worth
 * knowing: it has no `window.matchMedia` at all — which is exactly the absence
 * the `window.matchMedia && …` idiom in both pages is written for, and which
 * the third case below asserts is survivable. So there is nothing
 * here to spy on and the property is installed, the way ui/tests/tabs.test.js
 * installs a `localStorage`.
 */
function fakeMatchMedia(matches) {
  const listeners = new Set()
  const asked = []
  const mql = {
    matches,
    addEventListener: (type, fn) => { if (type === 'change') listeners.add(fn) },
    removeEventListener: (type, fn) => { if (type === 'change') listeners.delete(fn) },
  }
  Object.defineProperty(window, 'matchMedia', {
    value: (query) => { asked.push(query); return mql },
    configurable: true,
    writable: true,
  })
  return { asked, listeners, change: (now) => listeners.forEach((fn) => fn({ matches: now })) }
}

afterEach(() => {
  delete window.matchMedia
  vi.restoreAllMocks()
})

/**
 * The component as `computed()` and `render()` see it, at a chosen width.
 *
 * The `setState` double RUNS ITS CALLBACK, which is ui/tests/repeats.test.js's
 * spelling and is load-bearing here rather than thoroughness: `set()` is
 * `setState` plus `sync()`, and one of the cases below is about the viewport
 * being told that a tool has been taken away — a double that swallowed the
 * callback would make that assertion unfalsifiable.
 */
function component({ narrow = false, treeOpen = false, rail = null, tool = null,
                     compare = false } = {}) {
  const c = Object.create(HammerolaViewer.prototype)
  c.props = { ...HammerolaViewer.defaultProps }
  c.home = null
  c.host = { current: null }
  c.setState = vi.fn((patch, done) => {
    const next = typeof patch === 'function' ? patch(c.state) : patch
    c.state = { ...c.state, ...next }
    if (done) done()
  })
  c.sync = vi.fn()
  c.state = {
    meta: {
      project: 'fixture', title: 'Fixture bracket', commit: REV,
      built: '2026-08-27T18:20:00Z',
      parts: { lid: { kind: 'printable', files: { stl: 'lid.stl' } } },
      views: [{ id: 'assembled', name: 'assembled', file: 'a.json',
                parts: ['lid'], gzip: 1000 }],
    },
    builds: null,
    tree: indexTree({ id: '/model', name: 'model', children: [] }),
    error: null, viewError: null, pending: null, swapping: false,
    view: 'assembled', tool, held: false,
    sel: null, selName: '', hidden: [], ghost: [], expanded: {},
    secOn: false, secOff: 0, secRange: null, secFlip: false, hatch: true,
    secFace: null, secPop: false,
    revOpen: false, dlOpen: false, cmp: [], compare, diffShow: 'both',
    bannerGone: false, rail, menu: { id: null, x: 0, y: 0 },
    notePop: null, noteDraft: '', notes: {},
    comments: [], activePin: null, composer: null,
    measure: null, moved: null, toast: null,
    // A token, because half of what the header draws is hidden from a viewer
    // for a reason that has nothing to do with the width.
    token: 'sekrit', tokenPop: false, tokenDraft: '',
    theme: 'light',
    tabs: [],
    narrow, treeOpen,
  }
  return c
}

const click = { stopPropagation() {}, preventDefault() {} }

/** Every style object the page drew, at a given width. */
const drawn = (over) => styles(component(over).render())

// -- which layout the page comes up in ---------------------------------------

describe('which layout the page comes up in', () => {
  it('asks the window the one question style.jsx names, before the first paint', () => {
    // Read in the CONSTRUCTOR and not on the first resize: a page that laid
    // itself out wide and then reflowed is a page that looks broken for a
    // frame. And the query is the exported constant rather than a string typed
    // here — two copies of a breakpoint are two breakpoints.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { asked } = fakeMatchMedia(true)

    expect(new HammerolaViewer({}).state.narrow).toBe(true)
    expect(asked).toEqual([NARROW])
  })

  it('comes up wide where the query does not match', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fakeMatchMedia(false)
    expect(new HammerolaViewer({}).state.narrow).toBe(false)
  })

  it('comes up wide, and not broken, where there is no matchMedia at all', () => {
    // The whole of what the `window.matchMedia && …` idiom buys, and this
    // runner is a browser that has none: the field must be a boolean rather
    // than `undefined`, because a page that threw here would draw nothing at
    // all — a worse answer than the wrong layout.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(window.matchMedia).toBeUndefined()
    expect(new HammerolaViewer({}).state.narrow).toBe(false)
  })

  it('follows the window while the page is open', () => {
    // Turning a phone sideways is a resize, and on the devices this branch is
    // for that is the ordinary case rather than an edge one.
    const { change } = fakeMatchMedia(false)
    const c = mounted()

    change(true)
    expect(c.state.narrow).toBe(true)
    change(false)
    expect(c.state.narrow).toBe(false)
  })

  it('disarms the tool on the way in, since nothing narrow can disarm it', () => {
    // A tool is armed from the toolbar and put away from the same buttons or
    // from Escape — and the narrow branch takes those buttons away, while a
    // phone has no Escape key. Measure armed in landscape would turn every
    // touch after a rotation into a measurement point; Move part would drag a
    // part where an orbit was meant.
    const { change } = fakeMatchMedia(false)
    const c = mounted({ tool: 'measure' })

    change(true)
    expect(c.state.tool).toBe(null)
    // AND THE VIEWPORT IS TOLD, which is the half a plain `setState` would
    // miss: the library is holding that tool too, so a page that only forgot it
    // on this side would go on placing points from a tool nothing here thinks
    // is armed.
    expect(c.sync).toHaveBeenCalled()
  })

  it('takes nothing away on the way back out', () => {
    // The wide direction adds buttons rather than removing them, so there is
    // nothing to put away — and a reader who rotated back to find their tool
    // disarmed for no reason would be right to call that a bug.
    const { change } = fakeMatchMedia(true)
    const c = mounted({ narrow: true, tool: null })

    c.state.tool = 'measure'
    change(false)
    expect(c.state.narrow).toBe(false)
    expect(c.state.tool).toBe('measure')
  })

  it('lets go of the query when the page goes', () => {
    // A live media query holding this component would call `setState` on one
    // that is gone — the same reason every other listener in
    // `componentDidMount` is taken down again.
    const { listeners } = fakeMatchMedia(false)
    const c = mounted()
    expect(listeners.size).toBe(1)

    c.componentWillUnmount()
    expect(listeners.size).toBe(0)
  })

  /**
   * The component with its REAL listeners on the window, the arrangement
   * ui/tests/repeats.test.js uses: `load` would reach a hub and `sync` would
   * dispatch at a viewport that is not here, so both are stubbed and nothing
   * else is.
   *
   * It is unmounted again when the test ends, which the case that unmounts by
   * hand simply does twice — taking a listener off a set it is no longer in is
   * the same no-op the second time as it is on a page that never opened one.
   */
  function mounted(over) {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = component(over)
    c.load = vi.fn(async () => {})
    c.componentDidMount()
    onTestFinished(() => c.componentWillUnmount())
    return c
  }
})

// -- the header --------------------------------------------------------------

describe('the header row', () => {
  it('grows a second line rather than being cut off', () => {
    // Nothing that could be dropped from this row makes it fit a phone, so it
    // has to be able to break its line: the root it sits in is
    // `overflow:hidden`, and a row that overflows there is silently CUT OFF
    // rather than scrolled — the comment button simply not on the screen. The
    // same fix static/_v/site.css already makes on the resolver's copy of it.
    //
    // BOTH WIDTHS, because this one is not a branch: a header that only wraps
    // below the breakpoint would still be clipped at 721px by a long title.
    const wide = css(component().computed().headerStyle)
    const narrow = css(component({ narrow: true }).computed().headerStyle)
    for (const style of [wide, narrow]) {
      expect(style.minHeight).toBe('50px')
      expect(style.height, 'a fixed height cannot grow, so a wrapped row is '
        + 'drawn over the line below it').toBeUndefined()
      expect(style.flexWrap).toBe('wrap')
    }
  })

  it('lets the title column shrink, which is what lets the ellipsis fire', () => {
    // The latent half of the same bug: the title has declared
    // `text-overflow:ellipsis` all along and could never reach it, because the
    // column holding it was `flex:none` — an item that keeps its content width
    // whatever the window does. A model named after its whole assembly pushed
    // the row past the edge instead of being cut.
    const c = component()
    const col = css(c.computed().titleColStyle)
    expect(col.minWidth).toBe('0')
    // The SHRINK factor is what this is about, so the whole shorthand is
    // asserted rather than "not `none`": `flex:0 0 auto` is not `none` and does
    // not shrink either, which is the same bug spelled differently.
    expect(col.flex, 'the column refuses to shrink, so the ellipsis inside it '
      + 'can never fire').toBe('0 1 auto')

    // BOTH HALVES. `css()` caches by string, so the object the render put on
    // the column is the very one `computed()` names — which is how the element
    // is found without a DOM. Asserting the column alone would leave the
    // ellipsis deletable with this file green.
    const wanted = css(c.computed().titleColStyle)
    const found = collect(c.render(), (el) => (el.props.style === wanted ? el : undefined))
    expect(found).toHaveLength(1)
    const cut = collect(found[0], (el) => (
      el.props.style && el.props.style.textOverflow === 'ellipsis' ? el : undefined))
    expect(cut, 'the column can shrink and nothing inside it asks to be cut, so '
      + 'a long title spills out of it instead').toHaveLength(1)
  })

  it('drops the three things it says twice', () => {
    // Each of these is chosen because the page still says it elsewhere: the
    // wordmark sits beside a mark that stays and goes on linking home; the
    // subtitle is a description rather than a control; and the status chip's
    // dot is on the revision button next to it.
    const wide = texts(component().render())
    const narrow = texts(component({ narrow: true }).render())

    expect(wide).toContain('hammerola')
    expect(narrow).not.toContain('hammerola')

    expect(wide).toContain('1 parts · 1 view · 0.0 MB')
    expect(narrow).not.toContain('1 parts · 1 view · 0.0 MB')

    expect(wide).toContain('pinned build')
    expect(narrow).not.toContain('pinned build')
  })

  it('keeps the way home, and the title of what is on screen', () => {
    // What the paragraph above is only allowed to claim because this is true:
    // the mark is still there and still a link, and the model's name is still
    // the first thing the header says.
    const c = component({ narrow: true })
    expect(texts(c.render())).toContain('Fixture bracket')
    expect(collect(c.render(), (el) => (el.type === 'a' && el.props.href === '/' ? el : undefined)))
      .toHaveLength(1)
  })
})

// -- the tree ----------------------------------------------------------------

describe('the tree on a narrow window', () => {
  /** Is the tree's own toolbar on the page? "expand all" is drawn with it. */
  const treeDrawn = (c) => collect(
    c.render(), (el) => (el.props.title === 'expand all' ? el : undefined)).length === 1

  it('starts closed, because it lies over the thing it describes', () => {
    // Wide, it floats in a corner of the model and there is room for both.
    expect(treeDrawn(component())).toBe(true)
    expect(treeDrawn(component({ narrow: true }))).toBe(false)
  })

  it('opens from a header button, and closes again', () => {
    const c = component({ narrow: true })
    c.computed().treeToggle(click)
    expect(c.state.treeOpen).toBe(true)
    expect(treeDrawn(c)).toBe(true)

    c.computed().treeToggle(click)
    expect(c.state.treeOpen).toBe(false)
    expect(treeDrawn(c)).toBe(false)
  })

  it('offers no such button where the tree is simply there', () => {
    // A control saying "Parts" beside a visible list of them is noise.
    expect(css(component().computed().treeBtnStyle).display).toBe('none')
    expect(css(component({ narrow: true }).computed().treeBtnStyle).display).toBe('flex')
  })

  it('is not remembered — a page opens with the tree closed however the last one was left', async () => {
    // BOTH HALVES, and the first one is the half about this page: a real
    // instance comes up closed, whatever the browser did last. Asserting only
    // the second left `treeOpen: false` deletable from the constructor with
    // this case green.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(new HammerolaViewer({}).state.treeOpen).toBe(false)

    // Which of two overlapping things is in front right now is not a preference
    // the next page inherits. store.js is the only module on this side allowed
    // to touch storage at all (tests/test_ui_source.py), so its exports are the
    // whole list of what outlives a visit.
    const store = await import('../src/store.js')
    expect(Object.keys(store).filter((name) => /tree|narrow/i.test(name))).toEqual([])
  })

  it('offers no button while two revisions are being compared, either', () => {
    // The compare panel stands where the tree does, so there is nothing for the
    // button to open — on either width.
    expect(css(component({ narrow: true, compare: true }).computed().treeBtnStyle).display)
      .toBe('none')
    expect(css(component({ compare: true }).computed().treeBtnStyle).display).toBe('none')
  })
})

// -- the comment rail --------------------------------------------------------

describe('the comment rail on a narrow window', () => {
  it('lies over the model rather than taking a third of it', () => {
    const wide = css(component({ rail: true }).computed().railStyle)
    expect(wide.width).toBe('300px')
    expect(wide.position).toBeUndefined()

    const narrow = css(component({ narrow: true, rail: true }).computed().railStyle)
    expect(narrow.position).toBe('absolute')
    expect(narrow.width, '300px out of a phone leaves the model with what is '
      + 'left of it').not.toBe('300px')
  })

  it('still opens and closes exactly as the wide one does', () => {
    // The two spellings this string is read by — `display:none` and
    // `display:flex` — are what ui/tests/header.test.js asserts on, and they
    // have to survive the narrow branch or that file fails for a reason that
    // has nothing to do with what it is about.
    const c = component({ narrow: true, rail: null })
    expect(c.computed().railStyle).toContain('display:none')
    c.computed().railToggle(click)
    expect(c.computed().railStyle).toContain('display:flex')
  })
})

// -- the toolbar under the model ---------------------------------------------

describe('the toolbar on a narrow window', () => {
  it('keeps the two controls about looking at the model, and drops the rest', () => {
    const wide = texts(component().render())
    const narrow = texts(component({ narrow: true }).render())

    // The view tabs are the model's own views, and Fit is how a reader who has
    // orbited into nowhere gets back.
    for (const kept of ['assembled', 'Fit']) {
      expect(wide).toContain(kept)
      expect(narrow).toContain(kept)
    }

    // Gestures that want a pointer and a canvas with room to aim in, a PNG a
    // phone has nowhere to put, and a preference.
    for (const gone of ['Measure', 'Move part', 'Comment', 'Frame', 'Light']) {
      expect(wide).toContain(gone)
      expect(narrow).not.toContain(gone)
    }
  })

  it('draws no rules with nothing left between them', () => {
    // The three `width:1px` dividers separate groups that are no longer there.
    const rules = (over) => drawn(over).filter((s) => s.width === '1px' && s.height === '18px')
    expect(rules({})).toHaveLength(3)
    expect(rules({ narrow: true })).toHaveLength(0)
  })
})

// -- the popovers that are still reachable ------------------------------------

describe('the popovers that become a sheet on a narrow page', () => {
  // THIS LIST IS THE ASSERTION, which is why it is here and not in a sentence
  // in the source: the comment that used to count these panels was wrong twice,
  // because prose cannot be re-checked when a panel is added.
  //
  // What earns a place: a popover placed from the CONTROL that opens it rather
  // than from the window, which at phone width therefore lands off the screen.
  // Two different costs, and the second is the serious one.
  //
  // The revisions, the downloads and the token box hang off buttons in the
  // HEADER, and that header wraps at phone width, so their anchor is no longer
  // near the window's edge and the panel is cut off by the root's
  // `overflow:hidden`. They stay dismissible — `rootClick` clears all three.
  //
  // The section panel and the note editor hang off rows in the TREE, at
  // `left:278px` and `left:310px`, so on a 390px screen their own close
  // controls are past the right-hand edge. Nothing else takes them back:
  // `rootClick` clears neither, both stop the click that would reach it, and a
  // phone has no Escape key — opened, they could only be dismissed by reloading
  // the page.
  //
  // What does not earn a place: `menuStyle`, already clamped by `menuAt`, and
  // the composer, whose ✕ and Send sit at the right end of their rows behind
  // `flex:1` spacers while the panel itself is anchored `right:16px` — so it is
  // the composer's LEFT end that goes off screen, not its controls.
  const sheets = (over) => {
    const v = component(over).computed()
    return [v.revMenuStyle, v.dlMenuStyle, v.tokenPopStyle,
            v.secPopStyle, v.notePopStyle].map(css)
  }

  it('are clamped to the window rather than to the control they hang off', () => {
    for (const wide of sheets({})) expect(wide.position).toBe('absolute')
    expect(sheets({}).map((s) => s.width))
      .toEqual(['430px', '250px', '320px', '270px', '300px'])

    for (const narrow of sheets({ narrow: true })) {
      // `fixed` is the half that does the work: `left`/`right` resolve against
      // the containing block, which for a panel placed this way is its own
      // control's wrapper — after the header wraps, not even at the window's
      // edge any more — so an absolute clamp would make the sheet NARROWER than
      // the popover it replaces and leave it off the side as well.
      expect(narrow.position).toBe('fixed')
      expect(narrow.left).toBe('8px')
      expect(narrow.right).toBe('8px')
      expect(narrow.width).toBe('auto')
    }
  })

  it('are anchored to the bottom edge, the one thing the header cannot move', () => {
    // The header above them wraps BY CONSTRUCTION, so its height is 50px or two
    // rows or three, with a tab strip under it for more again. Any constant
    // measured from the top of the window therefore has a header height at
    // which the sheet opens on top of the button that opened it — and the token
    // sheet stops clicks, so that covered button could not be pressed at all.
    for (const narrow of sheets({ narrow: true })) {
      expect(narrow.bottom).toBe('8px')
      expect(narrow.top, 'a sheet measured from the top of the window is a '
        + 'sheet that can cover the button that opened it').toBe('auto')
    }
  })

  it('still open and close on the same state they always did', () => {
    const c = component({ narrow: true })
    expect(css(c.computed().revMenuStyle).display).toBe('none')
    c.computed().revToggle(click)
    expect(css(c.computed().revMenuStyle).display).toBe('block')

    expect(css(c.computed().dlMenuStyle).display).toBe('none')
    c.computed().dlToggle(click)
    expect(css(c.computed().dlMenuStyle).display).toBe('block')

    expect(css(c.computed().tokenPopStyle).display).toBe('none')
    c.computed().tokenToggle(click)
    expect(css(c.computed().tokenPopStyle).display).toBe('block')
  })
})

// -- the chips over the model -------------------------------------------------

describe('the state chips', () => {
  it('stand clear of the tree, wherever the tree is', () => {
    // 278px is the open tree's width plus its left margin — an offset that on a
    // phone puts the chips off the side of the screen, since there the tree
    // starts closed and covers the model when it opens.
    expect(css(component().computed().chipsStyle).left).toBe('278px')
    expect(css(component({ narrow: true }).computed().chipsStyle).left).toBe('12px')
  })
})

// -- the front page ------------------------------------------------------------

describe('the project list on a narrow window', () => {
  const PAGE_STUB = { hover: () => ({}), cardStyle: () => '' }
  const CARD = {
    pid: '0a1b2c3d4e5f', title: 'Bracket', slug: 'bracket', meta: '2 parts',
    built: '2026-08-27T18:20:00Z', first: '2026-01-01T00:00:00Z', preview: null,
  }

  it('lets a card be as narrow as the window is', () => {
    // `minmax(320px,1fr)` states a floor no narrower window can honour: on a
    // 320px screen the container is already 320 minus its own `padding:24px
    // 20px`, so every track was 40px wider than the room for it and the page
    // scrolled sideways for ever. On a wide screen the `min()` is not reached
    // and nothing changes.
    const grid = styles(VIEW_BODIES.grid(PAGE_STUB, [CARD]))[0]
    expect(grid.gridTemplateColumns).toBe('repeat(auto-fill,minmax(min(320px,100%),1fr))')
  })

  it('grows its header a second line rather than cutting the last control off', () => {
    // The same row as the build page's, with the same failure at the end of it:
    // what falls off the right-hand side here is the only control the page has.
    const c = Object.create(HammerolaProjects.prototype)
    c.props = { ...HammerolaProjects.defaultProps, projects: [] }
    c.state = { view: null, sort: null, hover: null }

    const header = styles(c.render()).filter((s) => s.minHeight === '50px')
    expect(header).toHaveLength(1)
    expect(header[0].height).toBeUndefined()
    expect(header[0].flexWrap).toBe('wrap')
  })
})
