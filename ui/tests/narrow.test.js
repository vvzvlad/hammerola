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
// NOTHING IS MOUNTED except in the cases where the lifecycle IS the
// subject — those that cross the breakpoint with the page open and the one that
// takes the page away, which together are the only way to reach the listener
// `componentDidMount` registers. Everywhere else the
// instance is the real prototype with the state spelled out, `computed()` and
// `render()` are the real ones, and what they drew is read off the returned
// element objects (ui/tests/eltree.js). The arrangement is
// ui/tests/header.test.js's and ui/tests/tabs.test.js's.
//
// WHAT IS DELIBERATELY NOT HERE: the size of anything a finger has to hit. The
// 24px tree row, the 24×24 eye and the 22×24 ghost do not change with the width
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
import { makeComponent, replaceState } from './component.js'
import { collect, styles, texts } from './eltree.js'
import { guardSubscribers } from './addressguard.js'

guardSubscribers()

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
                     compare = false, token = 'sekrit' } = {}) {
  return makeComponent(HammerolaViewer, {
    setState: replaceState,
    sync: vi.fn(),
    state: {
      meta: {
        project: 'fixture', title: 'Fixture bracket', commit: REV,
        built: '2026-08-27T18:20:00Z',
        parts: { lid: { kind: 'printable', files: { stl: 'lid.stl' } } },
        views: [{ id: 'assembled', name: 'assembled', file: 'a.json',
                  parts: ['lid'], gzip: 1000 }],
      },
      tool,
      compare,
      rail, menu: { id: null, x: 0, y: 0 },
      // A token by default, because half of what the header draws is hidden from
      // a viewer for a reason that has nothing to do with the width — and a
      // parameter, because one control in that row is drawn for BOTH readers and
      // one block below is about which.
      token,
      narrow, treeOpen,
    },
  })
}

const click = { stopPropagation() {}, preventDefault() {} }

/** Every style object the page drew, at a given width. */
const drawn = (over) => styles(component(over).render())

/** The header row itself, found by the style `computed()` names for it. */
function header(c) {
  const wanted = css(c.computed().headerStyle)
  const found = collect(c.render(), (el) => (el.props.style === wanted ? el : undefined))
  expect(found, 'no element on the page carries the header row\'s own style').toHaveLength(1)
  return found[0]
}

/** Every header menu on the page, as `[button, card]`: the children of the
 *  element holding the button titled "Menu". */
const menus = (c) => collect(c.render(), (el) => {
  const kids = [].concat(el.props.children)
  return kids.some((kid) => kid && kid.props && kid.props.title === 'Menu') ? kids : undefined
})

/** The row of the header's menu that says `said`. */
const menuRow = (c, said) => collect(menus(c)[0][1],
  (el) => (el.props.onClick && texts(el).includes(said) ? el : undefined))[0]

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
    // A tool is armed from the toolbar — or, for Move, from an object's row
    // menu — and put away from the toolbar buttons or from Escape. The narrow
    // branch takes those buttons away and the row menu with them, while a phone
    // has no Escape key. Measure armed in landscape would turn every touch after
    // a rotation into a measurement point; Move would drag a part where an orbit
    // was meant.
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

  it('puts the `Add primitive` menu away on the way in, and the layer with it', () => {
    // THE CARD UNMOUNTS ON ITS OWN — its button is one of the ones `showTools`
    // takes away — so this is about the FLAG, which nothing narrow can lower.
    // `toolbarStyle` reads it to lift the whole bar to 17 over the composer, so
    // a flag left standing leaves a phone wearing a toolbar raised for a menu
    // that is not on screen. It heals on the first click anywhere, which is the
    // click the reader meant for something else.
    const { change } = fakeMatchMedia(false)
    const c = mounted()

    c.state.opsOpen = true
    change(true)
    expect(c.state.opsOpen).toBe(false)
    expect(css(c.computed().toolbarStyle).zIndex).toBe('12')
  })

  it('puts the Settings card away on the way in, for the same reason', () => {
    const { change } = fakeMatchMedia(false)
    const c = mounted()

    c.state.settingsOpen = true
    change(true)
    expect(c.state.settingsOpen).toBe(false)
    expect(css(c.computed().toolbarStyle).zIndex).toBe('12')
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

  it('puts the header\'s menu down on the way back out', () => {
    // The wide header draws no menu, so a flag left up would bring the menu
    // back open the next time the phone is turned upright.
    const { change } = fakeMatchMedia(true)
    const c = mounted({ narrow: true })

    c.computed().headMenuToggle(click)
    expect(c.state.headMenu).toBe(true)
    change(false)
    expect(c.state.headMenu).toBe(false)
  })

  it('puts the header\'s menu down on Escape', () => {
    fakeMatchMedia(true)
    const c = mounted({ narrow: true })

    c.computed().headMenuToggle(click)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(c.state.headMenu).toBe(false)
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
    // A long title makes the wide row wider than a window just past the
    // breakpoint, so it has to be able to break its line: the root it sits in is
    // `overflow:hidden`, and a row that overflows there is silently CUT OFF
    // rather than scrolled — the comment button simply not on the screen. The
    // same fix static/_v/site.css already makes on the resolver's copy of it.
    //
    // BOTH WIDTHS, because this one is not a branch: a header that only wraps
    // below the breakpoint would still be clipped at 721px by a long title.
    const wide = css(component().computed().headerStyle)
    const narrow = css(component({ narrow: true }).computed().headerStyle)
    for (const style of [wide, narrow]) {
      expect(style.height, 'a fixed height cannot grow, so a wrapped row is '
        + 'drawn over the line below it').toBeUndefined()
      expect(style.flexWrap).toBe('wrap')
    }
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

  it('folds its controls into one menu on a narrow window, and has none wide', () => {
    // The owner, of the phone: the revision, Downloads, the token, Parts,
    // Comments and the theme into one menu, the title beside the mark.
    const wide = component()
    expect(menus(wide)).toEqual([])
    const buttons = collect(header(wide), (el) => (el.props.onClick ? texts(el).join(' ') : undefined))
    expect(buttons).toEqual(expect.arrayContaining(['Editing on', 'Comments 0', 'Light']))

    const c = component({ narrow: true })
    expect(menus(c)).toHaveLength(1)
    expect(menus(c)[0][1].props.style.display).toBe('none')
    c.computed().headMenuToggle(click)
    const [button, card] = menus(c)[0]
    expect(button.props.title).toBe('Menu')
    expect(card.props.style.display).toBe('block')
    // The rows, in the owner's order, and each said once in the whole header:
    // none of them is still a button beside the menu.
    const ROWS = [REV.slice(0, 7), 'Downloads', 'Editing on', 'Parts', 'Comments', 'Light']
    expect(texts(card).filter((said) => ROWS.includes(said))).toEqual(ROWS)
    for (const said of ROWS) expect(texts(header(c)).filter((t) => t === said)).toHaveLength(1)
  })

  it('shuts its menu as a row opens what it stands for, and on a click anywhere else', () => {
    // A row calls what its wide button calls; the sheet it opens lies along
    // the bottom edge, and a menu left open over the model would hide it.
    const c = component({ narrow: true })
    const opens = [[REV.slice(0, 7), 'revOpen'], ['Downloads', 'dlOpen'], ['Editing on', 'tokenPop'],
                   ['Parts', 'treeOpen'], ['Comments', 'rail']]
    for (const [said, field] of opens) {
      c.computed().headMenuToggle(click)
      menuRow(c, said).props.onClick(click)
      expect([said, c.state[field], c.state.headMenu]).toEqual([said, true, false])
    }

    // The title's pencil stops its click, so the rename window shuts the menu
    // itself rather than leaving it to come back when the window closes.
    c.computed().headMenuToggle(click)
    c.computed().renameTitle()
    expect([!!c.state.rename, c.state.headMenu]).toEqual([true, false])

    c.computed().headMenuToggle(click)
    expect(c.state.headMenu).toBe(true)
    c.computed().rootClick()
    expect(c.state.headMenu).toBe(false)
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

  it('opens from the header\'s menu, and closes again', () => {
    const c = component({ narrow: true })
    menuRow(c, 'Parts').props.onClick(click)
    expect(c.state.treeOpen).toBe(true)
    expect(treeDrawn(c)).toBe(true)

    menuRow(c, 'Parts').props.onClick(click)
    expect(c.state.treeOpen).toBe(false)
    expect(treeDrawn(c)).toBe(false)
  })

  it('offers no such row where the tree is simply there', () => {
    // A control saying "Parts" beside a visible list of them is noise.
    expect(css(component().computed().partsRowStyle).display).toBe('none')
    expect(css(component({ narrow: true }).computed().partsRowStyle).display).toBe('flex')
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

  it('offers no row while two revisions are being compared, either', () => {
    // The compare panel stands where the tree does, so there is nothing for the
    // row to open — on either width.
    expect(css(component({ narrow: true, compare: true }).computed().partsRowStyle).display)
      .toBe('none')
    expect(css(component({ compare: true }).computed().partsRowStyle).display).toBe('none')
  })
})

// -- the comment rail --------------------------------------------------------

describe('the comment rail on a narrow window', () => {
  it('lies over the model rather than taking a third of it', () => {
    const wide = css(component({ rail: true }).computed().railStyle)
    expect(wide.position).toBeUndefined()

    const narrow = css(component({ narrow: true, rail: true }).computed().railStyle)
    expect(narrow.position).toBe('absolute')
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

    // Gestures that want a pointer and a canvas with room to aim in, and a PNG
    // a phone has nowhere to put.
    //
    // `Add primitive` IS ON THE LIST FOR A REASON OF ITS OWN, and it is the
    // card rather than the button: a `fixed` child of a `contain:layout`
    // element is pinned to that element instead of to the window, so the menu
    // cannot become a narrow sheet — it opens 170px wide over the button that
    // opened it, on a toolbar its own flag has just lifted above the composer.
    // The case two groups down explains exactly that and says «one of the ones
    // `showTools` takes away»; this is where the sentence is held to.
    //
    // MOVE IS NOT ON THIS LIST because it is not on this strip: it is a row of
    // each object's own menu, and the width takes it away there instead — the
    // group below is where that half is asserted.
    for (const gone of ['Measure', 'Comment', 'Frame', 'Add primitive']) {
      expect(wide).toContain(gone)
      expect(narrow).not.toContain(gone)
    }
    expect(wide).not.toContain('Move part')

    // The theme is not one of them: it lives in the header, beside the
    // comments, so it survives the narrow branch and the one preference on the
    // page stays reachable at the width where a reader is most likely to want
    // the dark one. The block below says WHERE it survives.
    expect(wide).toContain('Light')
    expect(narrow).toContain('Light')
  })

  it('draws no rules with nothing left between them', () => {
    // The two `width:1px` dividers separate groups that are no longer there.
    const rules = (over) => drawn(over).filter((s) => s.width === '1px' && s.height === '18px')
    expect(rules({})).toHaveLength(2)
    expect(rules({ narrow: true })).toHaveLength(0)
  })
})

// -- the tool that is armed from somewhere else -------------------------------

describe('the Move row of an object\'s menu on a narrow window', () => {
  /** The row menu open on one part, at a chosen width. */
  const labelsOn = (over) => {
    const c = component(over)
    c.state.tree = indexTree({ id: '/model',
                               name: 'model',
                               children: [{ id: '/model/lid', name: 'lid', key: 'lid' }] })
    c.state.menu = { id: '/model/lid', x: 0, y: 0 }
    return c.computed().menuItems.map((m) => m.label)
  }

  it('goes with the toolbar, because it is the same gesture wanting the same room',
     () => {
    // Move left the strip above and the width has to keep taking it away, or
    // the narrow branch would hand back through a menu exactly the tool it
    // drops the buttons for. BOTH SIDES, like everything in this file: a row
    // that had gone missing at every width would pass a one-sided check.
    expect(labelsOn({})).toContain('Move')
    expect(labelsOn({ narrow: true })).not.toContain('Move')
  })

  it('leaves the rest of the menu exactly where it was', () => {
    // The width is about aiming a gesture at the model, and nothing else on this
    // menu is a gesture: what a reader can still do to a part on a phone is
    // hide it, isolate it, read its files and copy its name.
    expect(labelsOn({ narrow: true }))
      .toEqual(['Isolate', 'Hide', 'Translucent', 'Note', 'STL', 'Copy name'])
  })
})

// -- the one control that was moved OUT of that strip -------------------------

describe('the theme button', () => {
  it('stands in the header beside the comments: a button wide, the menu\'s row after Comments narrow', () => {
    // The theme button lives with the comments. What makes that a test rather
    // than a sentence is the PAIR of facts: the button is inside the header
    // row, which is the one part of this page drawn at every width, and it is
    // drawn after the comments control rather than somewhere else in the same
    // row. Either one alone is satisfiable by the wrong arrangement.
    const wide = component()
    const said = texts(header(wide))
    expect(said).toContain('Comments')
    expect(said).toContain('Light')
    expect(said.indexOf('Light'), 'the theme button is in the header but not '
      + 'beside the comments').toBeGreaterThan(said.indexOf('Comments'))
    // IN THE MARKUP IS NOT ON THE SCREEN: a control can be taken away by
    // `display:none` rather than by being left out, so a reading that only
    // walks the tree would pass with the theme hidden.
    expect(css(wide.computed().themeBtnStyle).display).toBe('flex')

    // Narrow, the header's controls are rows of its menu, and the theme is the
    // row after Comments, on screen once the menu is open.
    const narrow = component({ narrow: true })
    narrow.computed().headMenuToggle(click)
    const [[, card]] = menus(narrow)
    const rows = texts(card)
    expect(rows).toContain('Comments')
    expect(rows.indexOf('Light'), 'the theme row is in the menu but not after '
      + 'the comments').toBeGreaterThan(rows.indexOf('Comments'))
    expect(card.props.style.display).toBe('block')
    expect(menuRow(narrow, 'Light').props.style.display).toBe('flex')
  })

  it('was MOVED and not copied', () => {
    // A button left behind in the floating strip would keep every assertion
    // above green and give one setting two controls, which disagree the moment
    // one of them is used.
    for (const over of [{}, { narrow: true }]) {
      expect(texts(component(over).render()).filter((t) => t === 'Light')).toHaveLength(1)
    }
  })

  it('is drawn for a reader who has no comments button at all', () => {
    // Which is the whole reason it stands BESIDE the comments rather than
    // inside the rail: without a token the rail and its button are both
    // `display:none`, and the theme is the reader's own answer rather than
    // something they need permission for.
    const c = component({ token: null })
    expect(css(c.computed().railBtnStyle).display).toBe('none')
    expect(css(c.computed().themeBtnStyle).display).toBe('flex')
    expect(texts(header(c))).toContain('Light')
    // Narrow, their menu has no Comments row and still the theme's.
    const [[, card]] = menus(component({ token: null, narrow: true }))
    expect(texts(card)).not.toContain('Comments')
    expect(texts(card)).toContain('Light')
  })
})

// -- the popovers that are still reachable ------------------------------------

describe('the popovers that become a sheet on a narrow page', () => {
  // THIS LIST IS THE ASSERTION: prose counting these panels cannot be
  // re-checked when a panel is added.
  //
  // What earns a place: a popover placed from the CONTROL that opens it rather
  // than from the window, which at phone width therefore lands off the screen.
  // Two different costs, and the second is the serious one.
  //
  // The revisions, the downloads and the token box hang off buttons in the
  // HEADER, and at phone width those buttons are rows of the header's menu,
  // which shuts as the panel opens, so no control is left on screen to hang
  // the panel off. They stay dismissible — `rootClick` clears all three.
  //
  // The section panel and the note editor hang off rows in the TREE, at
  // `left:278px` and `left:310px`, so on a 390px screen their own close
  // controls are past the right-hand edge. Nothing else takes them back:
  // `rootClick` clears neither, both stop the click that would reach it, and a
  // phone has no Escape key — opened, they could only be dismissed by reloading
  // the page.
  //
  // What does not earn a place: `menuStyle`, already clamped by `menuAt`; the
  // composer, whose ✕ and Send sit at the right end of their rows behind
  // `flex:1` spacers while the panel itself is anchored `right:16px` — so it is
  // the composer's LEFT end that goes off screen, not its controls; and the
  // view menu and the `Add primitive` menu, NEITHER of which could take this
  // sheet even if it wanted one. They open
  // inside the floating toolbar, and that toolbar's `contain:layout` makes it
  // a containing block for `fixed` descendants as well as `absolute` ones (CSS
  // Containment 1, §3.2) — so a sheet there would clamp itself to the
  // toolbar's box and come up over the button that opened it. They need no clamp
  // either: the toolbar is centred on the bottom edge and on a narrow window
  // holds the view button and Fit and nothing else — `Add primitive` is one of
  // the ones `showTools` takes away — so 260px from the button's left
  // edge is inside the window. `viewmenu.test.js` holds that one.
  const sheets = (over) => {
    const v = component(over).computed()
    return [v.revMenuStyle, v.dlMenuStyle, v.tokenPopStyle,
            v.secPopStyle, v.notePopStyle].map(css)
  }

  it('are clamped to the window rather than to the control they hang off', () => {
    for (const wide of sheets({})) expect(wide.position).toBe('absolute')

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
    // The header above them wraps BY CONSTRUCTION (`headerStyle`), so any
    // constant measured from the top of the window has a header height at
    // which the sheet opens on top of the control that opened it — and the
    // token sheet stops clicks, so that covered control could not be pressed.
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
  // `remover` answers nothing, which is what it answers for a reader holding no
  // token: this describes how a card behaves on a narrow window, and the delete
  // control adds no width of its own to the track being measured.
  const PAGE_STUB = { hover: () => ({}), cardStyle: () => '', remover: () => null }
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
