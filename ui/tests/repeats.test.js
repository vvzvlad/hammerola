// Five copies of one part are one row that says `pin ×5` — issue #75.
//
// WHAT THE COUNT IS: how many times the row's key stands next to itself in the
// tree being drawn. It is `leaves.length`, computed where it is drawn. There is
// no `qty` anywhere — not in `meta.json`, not on a node, not in this file's
// fixtures — because a stored number is one that can disagree with the assembly,
// and the assembly is the thing the reader is looking at.
//
// THE FIXTURE KEEPS THE TWO NAMES APART ON PURPOSE, and that is the trap this
// file exists to stay out of. A view holding two copies of `pin` gets leaves
// NAMED `pin` and `pin(2)` — the tessellator numbers them so the paths stay
// unique — and KEYED `pin` both. Written with the names left equal, every test
// below would pass under a collapse that grouped by name, by path stem or by
// colour. So the names are always spelled apart, and the keys are always the
// thing that is equal.
//
// THE TREES ARE WRITTEN OUT HERE, node by node; the only thing taken from
// `tests/fixtures/assembled.json` is one colour (`REAL[0].color`), so a leaf
// carries the field the real ones carry. That is fair here and would not be
// everywhere: what is under test is `indexTree`, which reads `id`, `name`,
// `key`, `children`, `color` and `known` exactly as given and asks nothing else
// of a node, so a hand-written child exercises it as faithfully as a pushed
// one. It is also unavoidable — the fixture's own model references no part
// twice, so it holds no run of repeats to collapse, and none of its four leaves
// (`plate`, `post`, `cap`, `reference_spacer`) is called `pin`.
//
// THE ROW'S OWN CHROME IS TESTED HERE TOO, past the last `describe`, and that
// is a borrowed home rather than a subject: the caret a row expands from has
// nothing to do with repeats, but this is the only file that already renders a
// tree with a node and leaves under it (`component`, `rowFor`), so it is the one
// place a row's drawn parts can be read without building a second harness.
//
// MOST OF IT NEVER MOUNTS: `component()` is the real prototype with the state
// spelled out and `computed()` called on it, exactly as notes.test.js and
// revswitch.test.js do it. Where a test needs the handler a VIEWPORT EVENT
// actually reaches, `mounted()` runs `componentDidMount` so the page's own
// listeners go on the window — the same helper, under the same name, as
// revswitch.test.js's.

import { describe, expect, it, onTestFinished, vi } from 'vitest'

import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { countedName, indexTree } from '../src/hub.js'
import { FACE, MEASURE, MOVED, PICK, PLACE, STATE } from '../src/events.js'
import { css } from '../src/style.jsx'
import assembled from './fixtures/assembled.json'
import { collect } from './eltree.js'

/** The fixture's own leaves, as the view file spells them. */
const REAL = assembled.parts

/** A leaf of the tree the viewport emits: a path, a name and a catalogue key. */
const leaf = (name, key, over = {}) => ({
  id: `/model/${name}`, name, key, color: REAL[0].color, ...over,
});

/**
 * A run of copies of one part, named the way the tessellator names them.
 *
 * `pin`, `pin(2)`, `pin(3)` … — one key, three names, three paths. The names
 * are what makes every assertion below a claim about the KEY.
 */
const copies = (key, count) => Array.from({ length: count }, (_, at) =>
  leaf(at === 0 ? key : `${key}(${at + 1})`, key));

/** The viewport's `hmr:model` tree, with these children under one root. */
const model = (children) => ({ id: '/model', name: 'model', children });

// -- indexTree ----------------------------------------------------------------

describe('indexTree collapses the copies of one part', () => {
  it('draws one row for a run of them, named by the first path', () => {
    const tree = indexTree(model(copies('pin', 5)))
    const rows = tree.roots.map((id) => tree.nodes.get(id))[0].children

    expect(rows).toEqual(['/model/pin'])
    const row = tree.nodes.get('/model/pin')
    expect(row.leaves).toEqual(['/model/pin', '/model/pin(2)', '/model/pin(3)',
                                '/model/pin(4)', '/model/pin(5)'])
    // Still a leaf: it is one PART, and a group is not a part at all.
    expect(row.isNode).toBe(false)
    expect(row.key).toBe('pin')
    expect(row.name).toBe('pin')
  })

  it('groups by the KEY and never by the name', () => {
    // Two leaves that read as different parts and are one; two that read as one
    // part and are two. A collapse written on the display name gets both
    // backwards.
    const sameKey = indexTree(model([leaf('pin', 'pin'), leaf('pin(2)', 'pin')]))
    expect(sameKey.nodes.get('/model').children).toEqual(['/model/pin'])

    const sameName = indexTree(model([leaf('pin', 'pin'), leaf('pin', 'screw')]))
    // `pathOf` keeps the second path unique; what matters is that there are two
    // rows and not one.
    expect(sameName.nodes.get('/model').children).toHaveLength(2)
  })

  it('collapses copies that differ in EVERY field but the key and `known`', () => {
    // The two conditions in `repeats` are the whole rule, and this is what
    // holds it to two. A third one on the NAME already fails all over this
    // file, since every fixture spells the copies apart on purpose; a third one
    // on the COLOUR would have failed nowhere, because `leaf()` hands every
    // copy the same `REAL[0].color`. So these two are spelled as far apart as a
    // leaf can be — one red and one green, named nothing like each other — and
    // the key is left as the only thing they share.
    const tree = indexTree(model([
      leaf('pin', 'pin', { color: '#ff0000' }),
      leaf('bolt', 'pin', { color: '#00ff00' }),
    ]))
    expect(tree.nodes.get('/model').children).toEqual(['/model/pin'])
    expect(tree.nodes.get('/model/pin').leaves)
      .toEqual(['/model/pin', '/model/bolt'])
  })

  it('leaves the flat leaf list holding every copy, in document order', () => {
    // `leaves` is what Isolate subtracts from and what `rejoin` reads names off:
    // a copy missing from it is a part nothing can hide and nothing can carry
    // across a revision switch.
    const tree = indexTree(model([...copies('pin', 3), leaf('lid', 'lid')]))
    expect(tree.leaves).toEqual(['/model/pin', '/model/pin(2)', '/model/pin(3)',
                                 '/model/lid'])
  })

  it('mints a path for every copy, so two that arrived alike stay apart', () => {
    // The uniqueness guard `indexTree` has always had, now reaching the copies a
    // row collapsed rather than only the row: two leaves under one id would put
    // one string in `leaves` twice, and the eye would be hiding a list with a
    // hole in it while the row went on saying `pin ×2`.
    const tree = indexTree(model([
      { id: '/model/pin', name: 'pin', key: 'pin' },
      { id: '/model/pin', name: 'pin(2)', key: 'pin' },
    ]))
    const row = tree.nodes.get('/model/pin')

    expect(row.leaves).toHaveLength(2)
    expect(new Set(row.leaves).size).toBe(2)
    expect(tree.leaves).toEqual(row.leaves)
  })

  it('answers with the ROW for every path of it, not only the first', () => {
    // What a pick in the SCENE needs: it names the solid the reader hit.
    const tree = indexTree(model(copies('pin', 3)))
    const row = tree.nodes.get('/model/pin')
    for (const path of row.leaves) expect(tree.nodes.get(path)).toBe(row)
  })

  it('counts a collapsed child once in its parent and its copies all of them', () => {
    const tree = indexTree(model([
      { id: '/model/housing', name: 'housing', children: copies('pin', 3) },
      leaf('lid', 'lid'),
    ]))
    const housing = tree.nodes.get('/model/housing')
    expect(housing.children).toEqual(['/model/pin'])
    expect(housing.leaves).toEqual(['/model/pin', '/model/pin(2)', '/model/pin(3)'])
    expect(tree.nodes.get('/model').leaves).toHaveLength(4)
  })
})

describe('indexTree keeps apart what is not one row', () => {
  it('does not reach across a group, because a group is the author\'s structure', () => {
    // Two pins in `housing` and one in `fasteners` are `pin ×2` there and `pin`
    // here. Pulling them together would answer a question about the whole build
    // inside a row that is describing one group.
    const tree = indexTree(model([
      { id: '/model/housing', name: 'housing', children: copies('pin', 2) },
      { id: '/model/fasteners', name: 'fasteners',
        children: [leaf('pin(3)', 'pin')] },
    ]))
    expect(tree.nodes.get('/model/housing').leaves).toHaveLength(2)
    expect(tree.nodes.get('/model/fasteners').leaves).toEqual(['/model/pin(3)'])
  })

  it('does not reach past a different part standing between them', () => {
    // ADJACENT, which is the whole rule: `pin, lid, pin` is three rows.
    const tree = indexTree(model([
      leaf('pin', 'pin'), leaf('lid', 'lid'), leaf('pin(2)', 'pin'),
    ]))
    expect(tree.nodes.get('/model').children)
      .toEqual(['/model/pin', '/model/lid', '/model/pin(2)'])
  })

  it('never collapses two leaves that name NO key', () => {
    // A leaf without a key has no link to the catalogue at all
    // (`treeFromShapes`), so two of them are not known to be the same part —
    // and `null === null` would say they are.
    const tree = indexTree(model([
      { id: '/model/a', name: 'a' }, { id: '/model/b', name: 'b' },
    ]))
    expect(tree.nodes.get('/model').children).toEqual(['/model/a', '/model/b'])
  })

  it('never collapses two GROUPS, whatever key a hand-made TREE puts on them', () => {
    // An assembly is not a part, so `lid ×2` over two groups would be the tree
    // claiming a count of something that has no record.
    //
    // A PUSH CANNOT REACH THIS SHAPE, which is why the tree below is written
    // out by hand rather than pushed: `treeFromShapes` sets `key` on its leaf
    // branch alone, so a group loses whatever key the view file gave it one
    // storey before `indexTree` sees it (parts.test.js pins that). What is held
    // here is `leafKey`'s own rule — the second of the two places that decide,
    // and the only one this function can be held to.
    const tree = indexTree(model([
      { id: '/model/one', name: 'one', key: 'lid', children: [leaf('a', 'a')] },
      { id: '/model/two', name: 'two', key: 'lid', children: [leaf('b', 'b')] },
    ]))
    expect(tree.nodes.get('/model').children).toEqual(['/model/one', '/model/two'])
  })

  it('splits the run where the viewport does not know a copy', () => {
    // A row is a promise about what its eye acts on, and the viewport can act
    // only on a path its own state map holds. `pin ×3` covering two reachable
    // copies would break that silently; two rows keep `?` meaning what it has
    // always meant here — nothing can be done to this one.
    const tree = indexTree(model([
      leaf('pin', 'pin'), leaf('pin(2)', 'pin', { known: false }),
      leaf('pin(3)', 'pin'),
    ]))
    const rows = tree.nodes.get('/model').children.map((id) => tree.nodes.get(id))

    expect(rows.map((row) => row.leaves))
      .toEqual([['/model/pin'], ['/model/pin(2)'], ['/model/pin(3)']])
    expect(rows.map((row) => row.known)).toEqual([true, false, true])
  })
})

// -- the label ----------------------------------------------------------------

describe('countedName', () => {
  it('is the name alone for one, and the name and a count for more', () => {
    expect(countedName('pin', 1)).toBe('pin')
    expect(countedName('pin', 5)).toBe('pin ×5')
  })

  it('uses the multiplication sign and not the letter x', () => {
    // A row reading `pin x5` is a part called that on half the fleet's models.
    expect(countedName('pin', 5)).toContain('×')
    expect(countedName('pin', 5)).not.toContain('x')
  })
})

// -- the row the interface draws ----------------------------------------------

/**
 * The component as `computed()` and the handler map see it.
 *
 * `setState` is the real one's contract — merge, then run the callback — because
 * the callback is where the interface tells the viewport what is selected.
 */
function component(tree, over = {}) {
  const c = Object.create(HammerolaViewer.prototype)
  c.props = { ...HammerolaViewer.defaultProps }
  c.home = null
  c.carry = null
  c.history = []
  c.host = { current: null }
  c.state = {
    meta: {
      project: 'fixture', commit: 'abc1234', built: '',
      parts: { pin: { kind: 'printable', files: { stl: 'pin.stl' }, note: 'M3' },
               lid: { kind: 'printable', files: { stl: 'lid.stl' } } },
      views: [{ id: 'assembled', name: 'assembled', file: 'a.json',
                parts: ['pin', 'lid'], gzip: 1000 }],
    },
    builds: null,
    tree: indexTree(tree),
    error: null, viewError: null, pending: null,
    view: 'assembled', tool: null, held: false,
    sel: null, selName: '', hidden: [], ghost: [],
    expanded: { '/model': true, '/model/housing': true },
    secOn: false, secOff: 0, secRange: null, secFlip: false, hatch: true,
    secFace: null, secPop: false,
    revOpen: false, dlOpen: false, cmp: [], compare: false, diffShow: 'both',
    bannerGone: false, rail: false, menu: null, swapping: false,
    notePop: null, noteDraft: '', notes: {},
    feed: [], activePin: null, composer: null,
    measure: null, moved: null, toast: null,
    token: 'sekrit', tokenPop: false, tokenDraft: '',
    theme: 'light',
    ...over,
  }
  c.setState = vi.fn((patch, done) => {
    const next = typeof patch === 'function' ? patch(c.state) : patch
    c.state = { ...c.state, ...next }
    if (done) done()
  })
  c.sync = vi.fn()
  c.schedulePoll = vi.fn()
  c.toast = vi.fn()
  return c
}

/**
 * The same component with its REAL listeners on the window, so the handlers a
 * viewport event reaches are the ones the page builds.
 *
 * `load` is stubbed out because `componentDidMount` starts with it and it would
 * reach a hub; `sync` is put back, since what these tests read is the event it
 * dispatches. The pattern — and the console stub, for a runner with no
 * `localStorage` — is revswitch.test.js's `mounted`.
 */
function mounted(tree, over = {}) {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const c = component(tree, over)
  delete c.sync
  c.load = vi.fn(async () => {})
  c.componentDidMount()
  onTestFinished(() => {
    c.componentWillUnmount()
    vi.restoreAllMocks()
  })
  return c
}

/** The tree the tests below draw unless one of them spells out its own: a run
 *  of three pins beside a lid. */
const THREE_PINS = model([...copies('pin', 3), leaf('lid', 'lid')])
const PIN_PATHS = ['/model/pin', '/model/pin(2)', '/model/pin(3)']

/** One row of the panel, by the id it is drawn under. */
const rowFor = (c, id) => {
  const row = c.computed().rows.find((r) => r.key === id)
  expect(row, `no tree row for ${id}`).toBeTruthy()
  return row
}

const click = { stopPropagation() {}, preventDefault() {} }

describe('the row a run of copies draws as', () => {
  it('says how many, and says nothing where there is one', () => {
    const c = component(THREE_PINS)
    expect(rowFor(c, '/model/pin').name).toBe('pin ×3')
    expect(rowFor(c, '/model/lid').name).toBe('lid')
  })

  it('leaves a GROUP unlabelled, since the count would be another quantity', () => {
    // `leaves.length` on a group is every solid UNDER it, so `housing ×3` would
    // read as three housings where the three are the parts inside one. The meta
    // column draws that same number — as `visible/total` while SOME BUT NOT ALL
    // of them are hidden, and bare otherwise, which covers none hidden (the case
    // here) and every one of them hidden alike — and that is why the figure is
    // still on the row at all, not why it is kept out of the name.
    const c = component(model([
      { id: '/model/housing', name: 'housing', children: copies('pin', 3) }]))
    const row = rowFor(c, '/model/housing')
    expect(row.name).toBe('housing')
    expect(row.meta).toBe('3')
  })

  it('hides every copy from the one eye', () => {
    const c = component(THREE_PINS)
    rowFor(c, '/model/pin').onVis(click)
    expect(c.state.hidden).toEqual(PIN_PATHS)
  })

  it('ghosts every copy from the one square', () => {
    const c = component(THREE_PINS)
    rowFor(c, '/model/pin').onGhost(click)
    expect(c.state.ghost).toEqual(PIN_PATHS)
  })

  it('isolates to every copy, not to the first of them', () => {
    const c = component(THREE_PINS)
    c.state.menu = { id: '/model/pin', x: 0, y: 0 }
    const isolate = c.computed().menuItems.find((m) => m.label === 'Isolate')
    expect(isolate, 'no Isolate item on the menu').toBeTruthy()
    isolate.onClick(click)
    // Everything BUT the three pins.
    expect(c.state.hidden).toEqual(['/model/lid'])
  })

  it('isolates without touching the selection, because colour is an assertion', () => {
    // `sel` reaches `selectSolid`, whose shader REPLACES the part's colour with
    // the selection blue, and on this page a colour is a statement about the
    // part — grey means a mock. Isolate used to write it, so isolating a part
    // destroyed the very thing the reader isolated it to look at (issue #83).
    const c = component(THREE_PINS, { sel: '/model/lid', selName: 'lid' })
    c.state.menu = { id: '/model/pin', x: 0, y: 0 }
    const isolate = c.computed().menuItems.find((m) => m.label === 'Isolate')
    isolate.onClick(click)

    expect(c.state.hidden).toEqual(['/model/lid'])
    expect(c.state.sel).toBe('/model/lid')
    expect(c.state.selName).toBe('lid')
  })

  it('heads the menu with the count, because the items act on all of it', () => {
    // Right-clicked in the SCENE, on the SECOND copy — so the header is the
    // row's answer and not the hit solid's. A menu headed plain `pin` over a
    // row whose Hide takes three parts names one and acts on three.
    const c = component(THREE_PINS)
    c.state.menu = { id: '/model/pin(2)', x: 0, y: 0 }
    expect(c.computed().menuName).toBe('pin ×3')

    c.state.menu = { id: '/model/lid', x: 0, y: 0 }
    expect(c.computed().menuName).toBe('lid')
  })

  it('heads a GROUP without one, because that would be a different number', () => {
    // The tree row's reason does not carry over — this menu has no meta column
    // for the count to be duplicating. What holds here is that `leaves` on a
    // group is every part UNDERNEATH it, so `housing ×3` would read as three
    // housings when the three are the pins inside one. The items still act on
    // all three, which is the argument FOR the count on a leaf run and is not
    // enough on its own.
    const c = component(model([
      { id: '/model/housing', name: 'housing', children: copies('pin', 3) }]))
    c.state.menu = { id: '/model/housing', x: 0, y: 0 }
    const v = c.computed()

    expect(v.menuName).toBe('housing')
    // And the items below it that ACT ON PARTS really do take all three —
    // Isolate, Hide and Translucent are each expressed in `mNode.leaves` — so
    // the header is not bare because the menu is narrow. The rest of the menu
    // takes no path at all: Note and the file rows hang off `mKey`, and Copy
    // name off the name.
    v.menuItems.find((m) => m.label === 'Hide').onClick(click)
    expect(c.state.hidden).toEqual(
      ['/model/pin', '/model/pin(2)', '/model/pin(3)'])
  })

  it('copies the name BARE, which is the other half of that decision', () => {
    // The clipboard gets a part's name, never a tally of it: what is pasted
    // goes into a message or a search box, and `pin ×3` is neither a part nor
    // a name the catalogue answers to.
    const c = component(THREE_PINS)
    c.state.menu = { id: '/model/pin', x: 0, y: 0 }
    const written = []
    c.toast = vi.fn()
    // jsdom has no clipboard; downloads.test.js puts one here the same way, and
    // takes it away again so the next file does not inherit a global.
    Object.defineProperty(navigator, 'clipboard',
                          { value: { writeText: (t) => written.push(t) },
                            configurable: true })
    try {
      c.computed().menuItems.find((m) => m.label === 'Copy name').onClick(click)
    } finally {
      delete navigator.clipboard
    }
    expect(written).toEqual(['pin'])
  })

  it('reads its note under the shared key, once', () => {
    const c = component(THREE_PINS, { sel: '/model/pin' })
    const v = c.computed()
    expect(v.noteName).toBe('pin')
    expect(v.authorNote).toBe('M3')
  })
})

// -- what the viewport is told ------------------------------------------------

describe('the selection the viewport is given', () => {
  /** `sync()` for real, with the event it dispatches caught. */
  function synced(c) {
    const seen = []
    const listen = (event) => seen.push(event.detail)
    window.addEventListener(STATE, listen)
    try {
      delete c.sync
      c.sync()
    } finally {
      window.removeEventListener(STATE, listen)
    }
    return seen[0]
  }

  it('is every copy of the selected row', () => {
    const c = component(THREE_PINS, { sel: '/model/pin' })
    expect(synced(c).selected).toEqual(PIN_PATHS)
  })

  it('is a COPY of the row\'s list, because the viewport keeps what it is given', () => {
    // `applied.selected` in element.js holds on to the array that arrived, and
    // `node.leaves` is the list the eye, the ghost square and Isolate are all
    // written in — one sort or splice on the far side would be an edit to the
    // tree, with nothing on this side having asked for one.
    const c = component(THREE_PINS, { sel: '/model/pin' })
    const row = c.state.tree.nodes.get('/model/pin')
    expect(synced(c).selected).not.toBe(row.leaves)
  })

  it('is the one path where the row stands for one part', () => {
    const c = component(THREE_PINS, { sel: '/model/lid' })
    expect(synced(c).selected).toEqual(['/model/lid'])
  })

  it('is an empty list when nothing is selected', () => {
    expect(synced(component(THREE_PINS)).selected).toEqual([])
  })

  it('is the GROUP\'s own id, which is what it has always been', () => {
    // `selectSolid` has nothing to say about a node path, so selecting an
    // assembly highlights nothing — today and before this change. Expanding it
    // to its leaves here would be a different feature arriving inside this one.
    const c = component(
      model([{ id: '/model/housing', name: 'housing', children: copies('pin', 3) }]),
      { sel: '/model/housing' })
    expect(synced(c).selected).toEqual(['/model/housing'])
  })

  it('follows a pick in the SCENE to the row, whichever copy was hit', () => {
    // The viewport names the solid under the cursor — `/model/pin(3)` — and
    // `sel` has always been a ROW id: it is what the tree resolves through
    // `node()` to draw the highlight, and what every catalogue lookup goes
    // through.
    const c = mounted(THREE_PINS)
    window.dispatchEvent(new CustomEvent(PICK,
      { detail: { id: '/model/pin(3)', name: 'pin(3)' } }))

    expect(c.state.sel).toBe('/model/pin')
    expect(synced(c).selected).toEqual(PIN_PATHS)
    // And the row draws as the selected one, which is the half a raw path would
    // have lost: `/model/pin(3)` is the id of no row at all.
    expect(rowFor(c, '/model/pin').rowStyle).toContain('var(--accent-bg)')
  })

  it('draws the row highlighted for a copy\'s path the pick never resolved', () => {
    // `sel` is left holding a raw path whenever the pick landed BEFORE the tree
    // did — `node()` answered null then, and nothing resolves it afterwards,
    // since `onModel` leaves `sel` alone. The SCENE lights all three copies up
    // regardless, because `selectedPaths()` resolves the same value through
    // `node()`; a panel asking `s.sel === node.id` would light none of them, so
    // the two halves of one selection would disagree on screen.
    const c = component(THREE_PINS, { sel: '/model/pin(2)' })
    expect(synced(c).selected).toEqual(PIN_PATHS)
    expect(rowFor(c, '/model/pin').rowStyle).toContain('var(--accent-bg)')

    // And a path no row claims still highlights nothing, which is what the raw
    // comparison did too: `node()` answers null and a row is always an object.
    const stale = component(THREE_PINS, { sel: '/elsewhere/x' })
    expect(stale.computed().rows.filter((r) => r.rowStyle.includes('var(--accent-bg)')))
      .toEqual([])
  })

  it('keeps a picked path that no row claims, so an early pick is not lost', () => {
    // The tree arrives with the render; a pick before it has nothing to resolve
    // against and travels on as the path it came with, exactly as it did before
    // this lookup existed.
    const c = mounted(THREE_PINS)
    window.dispatchEvent(new CustomEvent(PICK,
      { detail: { id: '/elsewhere/x', name: 'x' } }))
    expect(c.state.sel).toBe('/elsewhere/x')
  })
})

// -- across a revision switch --------------------------------------------------

describe('a hidden row carried onto the next build', () => {
  it('comes back as every copy, not as the first of them', () => {
    // The snapshot a swap takes is NAMES (`namesOf`), because the ids belong to
    // the build being left; `rejoin` turns them back into ids of the build that
    // landed. Both walk `nodes` by path, so both depend on every copy's path
    // answering with its row — without that a reader who hid `pin ×3` would get
    // one pin back hidden and two on screen.
    const c = component(THREE_PINS)
    c.captureHome = vi.fn()
    c.state.hidden = PIN_PATHS

    expect(c.namesOf(c.state.hidden)).toEqual(['pin'])

    c.carry = { hidden: c.namesOf(c.state.hidden), ghost: [] }
    c.onModel({ tree: THREE_PINS, view: 'assembled', live: true })

    expect(c.state.hidden).toEqual(PIN_PATHS)
  })
})

// -- the row that arms that drag ----------------------------------------------
//
// Move used to be a button in the toolbar: it armed a gesture and left the
// reader to find the part afterwards. It is a row of each object's own menu now,
// which means the object is already named when the tool is armed — and a row
// standing for three copies names all three, which is why this is the file that
// holds it.

describe('the Move row of the part menu', () => {
  /** The menu open on one row, and the row that arms the tool from it. */
  const moveOn = (id, over = {}) => {
    const c = component(THREE_PINS, { menu: { id, x: 0, y: 0 }, ...over })
    return { c, row: c.computed().menuItems.find((m) => m.label === 'Move') }
  }

  it('selects the object it was opened on before it arms the tool', () => {
    // ONE WRITE, and the selection is the half that makes the row mean what it
    // says: the armed tool drags what is SELECTED and only falls back to the
    // part under the cursor when nothing is (`onDown` in viewport/tools.js).
    // Neither door into this menu writes `sel` — a right-click selects nothing,
    // from the tree or from the scene — so Move chosen on the pins while the LID
    // stood selected would have dragged the lid.
    const { c, row } = moveOn('/model/pin', { sel: '/model/lid', selName: 'lid' })

    row.onClick(click)

    expect(c.state.sel).toBe('/model/pin')
    expect(c.state.selName).toBe('pin')
    expect(c.state.tool).toBe('move')
    // AND THE VIEWPORT IS TOLD, which is what `set` buys over `setState`: it is
    // holding both the tool and the selection, and a page that only wrote them
    // on this side would arm a drag the library never heard about.
    expect(c.sync).toHaveBeenCalled()
  })

  it('is not offered on a group, whose selection no press can ever hit', () => {
    // A LEAF IS SPREAD INTO ITS COPIES AND A GROUP IS NOT: `selectedPaths`
    // answers a group with the node's OWN path, which is not the path of
    // anything the reader can put a cursor on. The armed tool then refuses every
    // grab on a part inside that group, because a press outside the standing
    // selection is refused whole — see 'moves nothing when the grab lands on a
    // part outside the selection' in tools.test.js. The only press that would
    // move anything is one that MISSES the model, which takes the entire
    // sub-assembly: not what a row promising to move THIS object means.
    const { c, row } = moveOn('/model')

    expect(row).toBeUndefined()
    // And the rest of the group's menu is untouched by that.
    expect(c.computed().menuItems.map((m) => m.label)).toContain('Isolate')
  })

  it('arms the drag for every copy the row stands for', () => {
    // `selectedPaths` expands a leaf row to its whole run, which is what the
    // viewport is given and what `movePart` then moves. The row says `pin ×3`
    // and three is what goes.
    const { c, row } = moveOn('/model/pin')

    row.onClick(click)

    expect(c.selectedPaths()).toEqual(PIN_PATHS)
  })

  it('says the move is temporary, because that is the surprising half', () => {
    // The sentence the button used to raise. A drag is a STATEMENT to the agent
    // and the model is untouched, so the part is back where the build put it on
    // the next rebuild — which nothing else on the screen says.
    const { c, row } = moveOn('/model/pin')

    row.onClick(click)

    expect(c.toast).toHaveBeenCalledWith(
      'Drag a part — it snaps back on the next rebuild')
  })

  it('arms rather than toggles, unlike the button it replaced', () => {
    // A row of a menu that closes behind it is not something a reader presses a
    // second time to undo, so pressing it with the tool already in hand leaves
    // it in hand. Escape is still what puts it away.
    const { c, row } = moveOn('/model/pin', { tool: 'move' })

    row.onClick(click)

    expect(c.state.tool).toBe('move')
  })

  it('is not offered to a reader with no token', () => {
    // The gate the button carried, spelled as absence: a drag's only outcome is
    // the chip, whose one door is `movedAttach` — a composer, and a comment is
    // behind the token. Both sides, so this is a claim about the token rather
    // than about the row having gone missing altogether.
    expect(moveOn('/model/pin', { token: null }).row).toBeUndefined()
    expect(moveOn('/model/pin').row).toBeDefined()
  })

  it('closes the menu behind it, like every other row that acts', () => {
    const { c, row } = moveOn('/model/pin')

    row.onClick(click)

    expect(c.state.menu).toBeNull()
  })
})

// -- the moved chip -----------------------------------------------------------

describe('the chip that reports a drag', () => {
  it('says how many copies WENT, which is not how many the row holds', () => {
    // The two differ, and that is why `hmr:moved` reports a count instead of
    // this side looking one up: a grab made with NOTHING SELECTED drags the one
    // copy it hit, out of a row standing for three. The SECOND event is what
    // that actually looks like on the wire — the viewport names the solid it
    // grabbed (`tools.js` takes the name off the dragged path), so the drag of
    // one copy arrives as `pin(2)`, a name no row is drawn under once the run
    // has collapsed into one — which it has here. The chip answers with the
    // row's.
    const c = mounted(THREE_PINS)
    window.dispatchEvent(new CustomEvent(MOVED,
      { detail: { id: '/model/pin', name: 'pin', count: 3, delta: [3, 0, 0] } }))
    expect(c.computed().movedText).toBe('pin ×3 moved 3 mm')

    window.dispatchEvent(new CustomEvent(MOVED,
      { detail: { id: '/model/pin(2)', name: 'pin(2)', count: 1,
                  delta: [3, 0, 0] } }))
    expect(c.computed().movedText).toBe('pin moved 3 mm')
  })

  it('falls back to the name for a path no row claims', () => {
    // The tree arrives with the render, so a drag reported before it has
    // nothing to resolve against — the same case the pick handler answers by
    // keeping the path it came with.
    const c = mounted(THREE_PINS)
    window.dispatchEvent(new CustomEvent(MOVED,
      { detail: { id: '/elsewhere/x', name: 'x', count: 1, delta: [3, 0, 0] } }))
    expect(c.computed().movedText).toBe('x moved 3 mm')
  })

  it('carries that name into the comment it offers to attach', () => {
    // The chip is a sentence the reader hands to the agent; `pin moved` about
    // three of them is a task written against the wrong part count.
    const c = mounted(THREE_PINS)
    window.dispatchEvent(new CustomEvent(MOVED,
      { detail: { id: '/model/pin', name: 'pin', count: 3, delta: [3, 0, 0] } }))
    c.computed().movedAttach()
    expect(c.state.composer.part).toBe('pin ×3')
    expect(c.state.composer.move).toBe('pin ×3 by 3 mm')
    // The counted name is for the reader; the KEY is what the comment hangs on
    // once this build is gone, and it is the row's bare one either way.
    expect(c.state.composer.key).toBe('pin')
  })
})

// -- the other two doors onto `composer.part` ---------------------------------
//
// `movedAttach` above is the door a DRAG opens, and the two below are the ones
// the row lookup reached last. All three word the field for a person to read,
// and none of them may word it with a name the tree does not draw.

describe('the part a comment is opened against', () => {
  it('is the ROW where a point was placed on a later copy', () => {
    // `hmr:place` names the SOLID under the cursor — `tools.js` takes the name
    // off the picked path — so a point on the second pin arrives as `pin(2)`,
    // and no row is drawn under that name since the run collapsed into one.
    const c = mounted(THREE_PINS)
    window.dispatchEvent(new CustomEvent(PLACE,
      { detail: { id: '/model/pin(2)', name: 'pin(2)', p: [1, 2, 3] } }))

    expect(c.state.composer.part).toBe('pin')
    // BARE, not `pin ×3`: a point sits on one solid, and the anchor posted with
    // it stays that solid's own path rather than the row's first.
    expect(c.state.composer.partId).toBe('/model/pin(2)')
    // The catalogue key is the row's and says nothing about WHICH copy — which
    // is the point of it: the path renumbers on a rebuild and this does not.
    expect(c.state.composer.key).toBe('pin')
  })

  it('falls back to the placed name for a path no row claims', () => {
    // A point placed before the tree landed, which is the case every lookup on
    // this side answers by keeping what it was handed.
    const c = mounted(THREE_PINS)
    window.dispatchEvent(new CustomEvent(PLACE,
      { detail: { id: '/elsewhere/x', name: 'x', p: [1, 2, 3] } }))
    expect(c.state.composer.part).toBe('x')
    // NULL, AND NOT THE NAME AS A STAND-IN. A path no row claims has no
    // catalogue key, and inventing one would anchor the comment to whatever
    // part happens to be keyed `x` in some later build.
    expect(c.state.composer.key).toBeNull()
  })

  it('agrees with the id it posts after a pick, a view tab and a measurement',
     () => {
    // THE ROUTE THAT MAKES `selName` A ROW NAME AND NOT A SOLID's, walked end
    // to end on a build nobody leaves. `measAdd` takes `partId` from `sel` and
    // `part` from the row — or, where the tree cannot answer, from `selName` —
    // and the tree stops answering on an ordinary view tab: `showView` writes
    // to neither half of the pair, and neither does `onModel`, which replaces
    // the tree.
    //
    // With `selName` left the picked solid's, this comment went to the hub
    // anchored on the FIRST copy under the THIRD copy's name.
    const c = mounted(THREE_PINS)
    window.dispatchEvent(new CustomEvent(PICK,
      { detail: { id: '/model/pin(3)', name: 'pin(3)' } }))
    expect(c.state.sel).toBe('/model/pin')
    expect(c.state.selName).toBe('pin')

    // The next view holds no pin at all, so nothing resolves `sel` any more.
    c.showView('exploded')
    c.onModel({ tree: model([leaf('lid', 'lid')]), view: 'exploded' })
    expect(c.state.sel).toBe('/model/pin')
    expect(c.node(c.state.sel)).toBe(null)

    window.dispatchEvent(new CustomEvent(MEASURE,
      { detail: { kind: 'distance', value: 4, approximate: false,
                  crossPart: false, moved: false } }))
    c.computed().measAdd()

    expect(c.state.composer.partId).toBe('/model/pin')
    expect(c.state.composer.part).toBe('pin')
    // AND THE KEY IS NULL HERE, on the one door of the three where the name
    // survives the tree that carried it. `part` comes from `selName`, cached by
    // the pick handler while the row was still drawn; the key is read from the
    // tree at this instant, and this view has no pin in it. So the comment goes
    // to the hub UNANCHORED under a name the reader recognises — which is the
    // honest pair, and the reason the rail's `none` sentence cannot say the
    // record predates keys.
    expect(c.state.composer.key).toBeNull()
  })
})

// -- the fourth surface that draws a solid's name -----------------------------
//
// The section panel heads the cut with the part the plane was laid on, and it is
// NOT a door onto `composer.part` — nothing here reaches a comment. It is on this
// list because the failure is the same one, which is the lesson of #75 rather
// than a fact about comments: `hmr:face` names the SOLID (`seedCut` takes the
// name off the owner path, `reportCut` reads it back off the seed), so a cut
// placed on the second copy arrives as `pin(2)`, and no row is drawn under that
// name once the run has collapsed into one.

describe('the part the section plane says it is cut from', () => {
  it('is the ROW where the face was clicked on a later copy', () => {
    const c = mounted(THREE_PINS)
    window.dispatchEvent(new CustomEvent(FACE,
      { detail: { id: '/model/pin(2)', name: 'pin(2)', offset: 3,
                  range: [-30, 30] } }))

    expect(c.state.secFace).toBe('pin')
    // BARE, on the same ground as the placed point: the plane lies on one face
    // of one solid, so `pin ×3` here would tally parts nothing was aimed at.
    expect(c.computed().secSub).toBe('pin · +3.0 mm')
  })

  it('falls back to the reported name for a path no row claims', () => {
    // A face clicked before the tree landed, which is the case every lookup on
    // this side answers by keeping what it was handed.
    const c = mounted(THREE_PINS)
    window.dispatchEvent(new CustomEvent(FACE,
      { detail: { id: '/elsewhere/x', name: 'x', offset: 0, range: [-30, 30] } }))
    expect(c.state.secFace).toBe('x')
  })

  it('says `face` where the hit named no owner at all', () => {
    // `seedCut` sends both halves null when the picker handed it no `info` to
    // take a solid path off, and the panel still has to head the cut with
    // something.
    const c = mounted(THREE_PINS)
    window.dispatchEvent(new CustomEvent(FACE,
      { detail: { id: null, name: null, offset: 0, range: [-30, 30] } }))
    expect(c.state.secFace).toBe('face')
  })
})

describe('the caret a row expands from', () => {
  // A STROKED PATH AND NOT A GLYPH, and why that is a test rather than a
  // sentence beside the render: the point of leaving `▾` behind was that a
  // glyph's ink is a fraction of the font size which the FONT decides, so the
  // mark now comes from three numbers this interface sets — the box it is drawn
  // in, the viewBox it is drawn on and the stroke it is drawn with. "The same
  // weight as the buttons above the tree" cannot be re-checked as prose.
  //
  // READ OFF THE RENDER and not off `computed()`, which is the failure
  // ui/tests/eltree.js records: `computed().slotTitle` was the whole of "the
  // digest is within reach", so deleting `title={v.slotTitle}` from the render
  // left 378 tests green. Deleting the whole `<svg>` from the row here does
  // exactly that — `caretPath` goes on being computed for nobody.
  //
  // THE WEIGHT AND THE PRESENCE, NEVER THE `d` ITSELF: the chevron may be
  // redrawn, and a test holding its path would fail for a change that is not a
  // regression.

  /** The one `<svg>` inside an element, as everything that decides what it puts
   *  on screen — the size AND the ink. `stroke` and `fill` are in here because
   *  without them the failure this whole change is about walks straight through:
   *  drop `stroke="currentColor"` and the mark is `fill="none"` over nothing, so
   *  the caret is invisible with every element still in place. The buttons above
   *  the tree carry the same two values, so comparing against them still holds. */
  const markOf = (el) => {
    const found = collect(el, (node) => (node.type === 'svg' ? node : undefined))
    expect(found, 'the element draws no mark at all').toHaveLength(1)
    const { width, height, viewBox, strokeWidth, stroke, fill } = found[0].props
    return { width, height, viewBox, strokeWidth, stroke, fill }
  }

  const pathsIn = (el) =>
    collect(el, (node) => (node.type === 'path' ? node : undefined))

  it('is the same chevron as the buttons above the tree, and only on a node', () => {
    // `css()` caches by string, so the object the render put on a caret is the
    // very one `computed()` names for that row — which is how the element is
    // found without a DOM (ui/tests/narrow.test.js does it this way too).
    const c = component(THREE_PINS, { narrow: false, treeOpen: false, tabs: [] })
    const drawn = c.render()
    const byStyle = (style) => collect(
      drawn, (el) => (el.props.style === css(style) ? el : undefined))
    const titled = (title) => {
      const found = collect(drawn, (el) => (el.props.title === title ? el : undefined))
      expect(found, `nothing on the page is titled "${title}"`).toHaveLength(1)
      return found[0]
    }

    // THE PAIR ABOVE THE TREE, which this is a per-row version of: same box,
    // same viewBox, same stroke, so the row's mark reads at the same weight.
    const carets = byStyle(rowFor(c, '/model').caretStyle)
    expect(carets, 'no element on the page carries the node row\'s caret style')
      .toHaveLength(1)
    expect(markOf(carets[0])).toEqual(markOf(titled('expand all')))
    expect(markOf(carets[0])).toEqual(markOf(titled('collapse all')))
    expect(pathsIn(carets[0])).toHaveLength(1)

    // A LEAF DRAWS NOTHING. Both leaf rows of this tree share one caret style,
    // so both are found by it, and neither may carry a mark.
    const leaves = byStyle(rowFor(c, '/model/pin').caretStyle)
    expect(leaves).toHaveLength(2)
    for (const leaf_ of leaves) expect(pathsIn(leaf_)).toHaveLength(0)

    // AND STILL OCCUPIES ITS BOX, hidden rather than absent: the 20x20 is what
    // keeps a leaf's name lined up under the names on the level above it.
    const box = css(rowFor(c, '/model/pin').caretStyle)
    expect(box.width).toBe('20px')
    expect(box.height).toBe('20px')
    expect(box.visibility).toBe('hidden')
    expect(css(rowFor(c, '/model').caretStyle).visibility).toBeUndefined()
  })
})
