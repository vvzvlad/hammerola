// The sketch panel on the build page: a rough body, in numbers, over the model.
//
// WHAT IT IS FOR is ui-brief block 6 one step further on. Block 6 lets somebody
// MOVE a part to show the agent what they want instead of describing it, and
// says out loud that this is not an edit of the model. This is the same
// statement about a body the model has to FIT — the motor it must clear, the
// wall it bolts to, the bought part it holds — assembled out of primitives and
// sent to the agent as text.
//
// The document and the kernel are tested next door in ui/tests/sketch.test.js,
// where the volumes are measured; the composition into the scene is in
// ui/tests/element.test.js. What is HERE is the panel: that every edit reaches
// the viewport, that a document which will not build says so without taking the
// last good body off the screen, and that what leaves the page is the text the
// agent reads rather than a field the hub would drop.
//
// NOTHING IS MOUNTED, which is this directory's arrangement (feed.test.js,
// narrow.test.js, notes.test.js): the real prototype over a state object spelled
// out by hand, with the real `computed()` and the real handlers run against it.
// The VIEWPORT is a pair of spies, because what this file asks about it is
// exactly what element.test.js answers for: was it handed the parts.

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { PLACE } from '../src/events.js'
import { indexTree } from '../src/hub.js'
import {
  addNode, addParam, DIM_OPS, emptySketch, sketchText,
} from '../src/sketch.js'
import { SHAPE_OPS } from '../src/sketchgeom.js'
import { css } from '../src/style.jsx'
import { collect, texts } from './eltree.js'

const REV = 'e05f73ba91b263b8517147e338d23e868533c6a034a342ad5926abb6edcb7b40'

const click = { stopPropagation() {}, preventDefault() {} }

// WHAT THE HUB SAID ABOUT THIS FEATURE, which on a real page is an attribute the
// server stamps on `<html>` before the bundle runs (`src/render.py`, and
// `tests/test_ui_source.py` holds the spelling equal on both sides). Every
// fixture below is a hub that ASKED for the panel, because that is what this
// file is about; the one test that asks what a hub which did not looks like
// turns it off by name.
const SKETCH_ATTRIBUTE = 'data-sketch-panel'

const stampSketch = (on) => {
  document.documentElement.setAttribute(SKETCH_ATTRIBUTE, on ? 'on' : 'off')
}

// Back to a page nobody stamped, so a fixture that forgets to say cannot inherit
// the last test's hub.
afterEach(() => {
  document.documentElement.removeAttribute(SKETCH_ATTRIBUTE)
})

/** A box with a name worth recognising in an assertion. */
const BLOCK = {
  id: 'n1', name: 'korpus', op: 'box', role: 'solid',
  at: [0, 0, 0], rot: [0, 0, 0], size: [20, 20, 20],
};

/** A param the box below can be sized from. */
const BODY = {
  name: 'body', type: 'slider', caption: 'Body', initial: 42.3,
  min: 40, max: 45, step: 0.1,
};

const withBlock = () => addNode(emptySketch(), BLOCK);

/**
 * The component as `computed()` and the panel's handlers see it.
 *
 * `setState` is the real one's CONTRACT — merge, then run the callback — because
 * `set()` reaches `sync()` through that callback, and `sketchAdd` goes through
 * `set()`. The element is three spies: `setOverlay`, `clearOverlay` and the one
 * question this page asks it back — whether a path is a body of the overlay —
 * and what the viewport DOES with the parts, `isOverlay`'s own answer included,
 * is element.test.js's subject.
 */
function panel({ token = 'sekrit', sketch, open = true, narrow = false,
                 served = true } = {}) {
  stampSketch(served)
  const el = {
    setOverlay: vi.fn(), clearOverlay: vi.fn(), isOverlay: vi.fn(() => false),
  }
  const c = Object.create(HammerolaViewer.prototype)
  c.props = { ...HammerolaViewer.defaultProps }
  c.home = null
  c.carry = null
  c.history = []
  // AS MANY BODIES AS THE DOCUMENT ALREADY HAS, because that is what the
  // counter means: every id in a real component's document was minted by it, so
  // a fixture that seeded nodes and left it at 0 would hand the next body an id
  // one of them already carries — a state the panel cannot reach, in which
  // `updateNode` edits two nodes at once.
  c._sketchSeq = sketch ? sketch.nodes.length : 0
  c.host = { current: el }
  c.sync = vi.fn()
  c.toast = vi.fn()
  c.setState = vi.fn((patch, done) => {
    const next = typeof patch === 'function' ? patch(c.state) : patch
    c.state = { ...c.state, ...next }
    if (done) done()
  })
  c.state = {
    meta: {
      project: 'fixture', title: 'Fixture', commit: REV, built: '', parts: {},
      views: [{ id: 'assembled', name: 'assembled', file: 'a.json',
                parts: [], gzip: 1000 }],
    },
    builds: null,
    tree: indexTree({ id: '/model', name: 'model', children: [] }),
    error: null, viewError: null, pending: null, swapping: false,
    view: 'assembled', tool: null, held: false,
    sel: null, selName: '', hidden: [], ghost: [], expanded: {},
    secOn: false, secOff: 0, secRange: null, secFlip: false, hatch: true,
    secFace: null, secPop: false,
    revOpen: false, dlOpen: false, cmp: [], compare: false, diffShow: 'both',
    bannerGone: false, rail: false, menu: null,
    notePop: null, noteDraft: '', notes: {},
    feed: [], activePin: null, composer: null,
    measure: null, moved: null, toast: null,
    sketch: sketch || emptySketch(), sketchOpen: open, sketchError: null,
    sketchHint: null, sketchDraft: null,
    token, tokenPop: false, tokenDraft: '',
    theme: 'light', tabs: [], narrow, treeOpen: false,
  }
  return { c, el }
}

/**
 * The same panel with the page's OWN listeners on the window, so a viewport
 * event reaches the handler `componentDidMount` built rather than one a test
 * called by hand. The helper, and the name, are repeats.test.js's.
 *
 * The two fetches the mount starts are stubbed: there is no hub here, and what
 * these tests are about begins after the page is listening.
 */
function mounted(over = {}) {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { c, el } = panel(over)
  c.load = vi.fn(async () => {})
  c.loadFeed = vi.fn(async () => {})
  c.componentDidMount()
  onTestFinished(() => {
    c.componentWillUnmount()
    vi.restoreAllMocks()
  })
  return { c, el }
}

/** The names of the parts the viewport was last handed. */
const overlay = (el) => el.setOverlay.mock.calls.at(-1)[0].map((part) => part.name)

/** The four ops, in the order the panel offers them. */
const ops = (c) => c.computed().sketchOps.map((op) => op.key)

/** One body's size fields, whatever op it is. */
const sizeFields = (c, index = 0) => c.computed().sketchBodies[index].groups[0].fields

/**
 * A field typed in and FINISHED WITH — the `change` the panel commits on.
 *
 * Two events, because the panel answers to two: `onChange` is the keystroke and
 * touches the draft alone, and the blur is what turns the text into the next
 * document. Every test that is about a VALUE goes through this; the ones about
 * typing itself call the two halves apart, which is the whole of what they are
 * asking.
 */
const type = (f, text) => {
  f.onChange({ target: { value: text } })
  f.onBlur({ target: { value: text } })
}

// -- what it is, and when it is on screen -------------------------------------

describe('the panel', () => {
  it('is drawn only when it is open, and is gone from a reader with no token', () => {
    // The gate Move part carries and Measure does not: everything the sketch
    // produces leaves this page as a comment, which is behind the token, so a
    // reader who cannot comment has nowhere to send it.
    expect(css(panel({ open: false }).c.computed().sketchPanelStyle).display).toBe('none')
    expect(css(panel({ open: true }).c.computed().sketchPanelStyle).display).toBe('block')
    expect(css(panel().c.computed().sketchBtnStyle).display).not.toBe('none')
    expect(css(panel({ token: null }).c.computed().sketchBtnStyle).display).toBe('none')
  })

  it('is gone entirely from a hub that did not ask to serve it', () => {
    // The SECOND gate of the same kind, and it answers about the HUB rather
    // than about the reader: one setting, `SKETCH_PANEL`, stamped on `<html>`
    // before the page was sent. Unset means off, so a deployment that never
    // heard of this feature does not serve it — and neither half of it appears,
    // with a token in hand, with the flag open and with a body already typed in.
    const { c } = panel({ served: false, sketch: withBlock(), open: true })

    expect(c.state.token).toBe('sekrit')
    expect(c.state.sketchOpen).toBe(true)

    // OUT OF THE TREE AND NOT MERELY UNPAINTED, which is the difference between
    // this gate and the token's one line up. `display:none` is the right answer
    // about a READER who cannot use a feature this hub serves; a hub that never
    // asked for the feature should not be sending its markup at all. Asserted
    // against the rendered tree, because a `display` assertion passes either way
    // and would not notice the day the markup came back.
    // The button by its label, and the panel by the one line that belongs to it
    // alone — NOT by `add to comment`, which a measurement's chip says too, and
    // which therefore answers about the wrong half of the page.
    expect(texts(c.render())).not.toContain('Sketch')
    expect(texts(c.render())).not.toContain('result = union(solid) − union(hole)')

    // And with it the page is the page it always was: the flag takes away the
    // sketch and nothing else.
    expect(css(c.computed().measureBtnStyle).display).not.toBe('none')
  })

  it('is there again the moment the hub says so', () => {
    // The other direction, which is the half that would go unnoticed: a gate
    // spelled wrong — a wrong attribute name, a wrong value — reads as "off"
    // for every reader and fails nothing, because off is what the page looks
    // like when nobody asked. So the ON case is asserted too.
    const { c } = panel({ served: true, sketch: withBlock(), open: true })
    expect(css(c.computed().sketchBtnStyle).display).not.toBe('none')
    expect(css(c.computed().sketchPanelStyle).display).toBe('block')

    // THE SAME TWO STRINGS THE OFF CASE LOOKS FOR, and this half is what keeps
    // that half honest: `not.toContain` passes just as well against a string
    // that is misspelled here as against markup that is genuinely gone.
    expect(texts(c.render())).toContain('Sketch')
    expect(texts(c.render())).toContain('result = union(solid) − union(hole)')
  })

  it('is NOT taken out of service by a comparison, unlike the three tools', () => {
    // `toolsOff` guards a task filed in the BUILD's terms against a scene that
    // is not the build — a `/cmp/…` path in `partId`. A sketch names no part of
    // anything: it posts no path, and the body it describes is as true over a
    // comparison as over a build.
    const { c } = panel()
    c.state = {
      ...c.state,
      compare: true, cmpPair: ['a', 'b'], cmpView: 'assembled', cmpStage: 'ready',
    }
    expect(c.toolsOff()).toBe(true)
    expect(css(c.computed().sketchBtnStyle).pointerEvents).not.toBe('none')
    expect(css(c.computed().measureBtnStyle).pointerEvents).toBe('none')
  })

  it('really draws the rows, and not merely a panel with a heading on it', () => {
    // `computed()` answering with a list of bodies is not the same as the page
    // putting them on the screen — the lesson eltree.js is written around, where
    // a view body that drew no cards passed everything because the container it
    // emits was recognised. So this reads the element tree `render()` returned.
    const { c } = panel({ sketch: addParam(withBlock(), BODY) })
    const values = collect(c.render(),
                           (el) => (el.type === 'input' ? el.props.value : undefined))

    expect(texts(c.render())).toContain('Sketch')
    // The body: its name, its three sizes, its place and its turn.
    expect(values).toContain('korpus')
    expect(values.filter((value) => value === '20')).toHaveLength(3)
    expect(values.filter((value) => value === '0')).toHaveLength(6)
    // The param beside it: name, caption and the four numbers.
    expect(values).toContain('body')
    expect(values).toContain('Body')
    expect(values).toContain('42.3')
    expect(values).toContain('0.1')
  })

  it('draws nothing over the model until there is a body in it', () => {
    // An empty document builds a result with no geometry, and a part with no
    // vertices in the tree says less than no overlay at all.
    const { c, el } = panel({ open: false })
    c.computed().tSketch()
    expect(c.state.sketchOpen).toBe(true)
    expect(el.setOverlay).not.toHaveBeenCalled()
    expect(el.clearOverlay).toHaveBeenCalled()
  })

  it('takes the body off the model when it is closed, and keeps the document', () => {
    // The panel is the only thing on screen saying the body is not part of the
    // model — there is no chip for it, because the panel it came out of is
    // standing right there. So a closed panel must not leave one over the model.
    // The DOCUMENT stays: a reader who shut the panel to look underneath comes
    // back to what they had.
    const { c, el } = panel({ sketch: withBlock() })
    c.computed().sketchClose(click)

    expect(c.state.sketchOpen).toBe(false)
    expect(el.clearOverlay).toHaveBeenCalledTimes(1)
    expect(c.state.sketch.nodes).toHaveLength(1)

    c.computed().tSketch()
    expect(overlay(el)).toEqual(['result'])
  })

  it('goes when the token does, and takes its body off the model with it', () => {
    // The panel is HIDDEN WITHOUT A TOKEN, like Move part, because everything it
    // produces leaves this page as a comment. `tokenClear` cleared the other two
    // surfaces the token gates and left this one standing: the header's button
    // was gone, so nothing could reopen it, `add to comment` was gone from under
    // it, and a body stood over the model with nothing on screen to account for
    // it — the panel being the only thing that says the body is not part of the
    // model.
    const { c, el } = panel({ sketch: withBlock() })

    c.computed().tokenClear(click)

    expect(c.state.token).toBeNull()
    expect(c.state.sketchOpen).toBe(false)
    expect(el.clearOverlay).toHaveBeenCalled()
    expect(css(c.computed().sketchPanelStyle).display).toBe('none')
    expect(css(c.computed().sketchBtnStyle).display).toBe('none')
  })
})

// -- the bodies ---------------------------------------------------------------

describe('a body', () => {
  it('can be any of the four ops, and each one draws something', () => {
    expect(ops(panel().c)).toEqual(['box', 'cylinder', 'sphere', 'extrude'])

    for (const [index, op] of ops(panel().c).entries()) {
      const { c, el } = panel()
      c.computed().sketchOps[index].onClick()

      expect(c.state.sketch.nodes[0].op).toBe(op)
      expect(c.state.sketchError).toBeNull()
      // It is a body big enough to see rather than a zero the kernel refuses —
      // a button that added an invisible thing would read as a button that did
      // nothing.
      expect(overlay(el)).toEqual(['result'])
      expect(el.setOverlay.mock.calls.at(-1)[0][0].shape.vertices.length)
        .toBeGreaterThan(0)
    }
  })

  it('is added under an id of its own, however many have been deleted', () => {
    // A counter and not the length of the list: deleting the second of two and
    // adding another would mint `n2` twice, and two nodes under one id make
    // `updateNode` edit both.
    const { c } = panel()
    c.computed().sketchOps[0].onClick()
    c.computed().sketchOps[0].onClick()
    c.computed().sketchBodies[0].onRemove()
    c.computed().sketchOps[0].onClick()

    const ids = c.state.sketch.nodes.map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('takes its size, its place and its turn from the fields', () => {
    const { c, el } = panel({ sketch: withBlock() })
    type(sizeFields(c)[0], '30')
    type(c.computed().sketchBodies[0].groups[1].fields[2], '-4.5')
    type(c.computed().sketchBodies[0].groups[2].fields[1], '45')

    const node = c.state.sketch.nodes[0]
    expect(node.size).toEqual([30, 20, 20])
    expect(node.at).toEqual([0, 0, -4.5])
    // DEGREES, which is what the row says and what the kernel converts. The
    // same number as radians is two and a half turns and still looks like a box.
    expect(node.rot).toEqual([0, 45, 0])
    expect(el.setOverlay).toHaveBeenCalledTimes(3)
  })

  it('may be named after the thing it stands for, and may not be left nameless', () => {
    // The name is not only a label: it is the part's `name` in the payload, and
    // a hole is drawn as a part of its own under it.
    const { c } = panel({ sketch: withBlock() })
    type(c.computed().sketchBodies[0].name, 'motor')
    expect(c.state.sketch.nodes[0].name).toBe('motor')

    type(c.computed().sketchBodies[0].name, '   ')
    expect(c.state.sketch.nodes[0].name).toBe('motor')
  })

  it('cannot be given a name another body or the payload already has', () => {
    // TWO PARTS UNDER ONE NAME ARE ONE ROW AND ONE GROUPS ENTRY: the second
    // stands in for the first, and the eye belongs to whichever arrived last.
    // `result` is the payload's own name for the fused body, so it is taken
    // before the reader starts. The same "first free" the params are minted by.
    const { c } = panel({ sketch: withBlock() })
    c.computed().sketchOps[1].onClick()
    type(c.computed().sketchBodies[1].name, 'korpus')
    expect(c.state.sketch.nodes.map((node) => node.name)).toEqual(['korpus', 'korpus2'])

    type(c.computed().sketchBodies[1].name, 'result')
    expect(c.state.sketch.nodes[1].name).toBe('result2')

    // ...and a body may still be renamed to the name it already has.
    type(c.computed().sketchBodies[0].name, 'korpus')
    expect(c.state.sketch.nodes[0].name).toBe('korpus')
  })

  it('flips between solid and hole, and a hole is drawn beside the result', () => {
    // The whole reason the subtraction tool is in the payload: a hole inside the
    // body is invisible the moment it is inside it, so the person cannot see
    // what they asked for or tell a hole that missed from one never added.
    const { c, el } = panel({
      sketch: addNode(withBlock(), {
        id: 'n2', name: 'bore', op: 'cylinder', role: 'solid',
        at: [0, 0, 0], rot: [0, 0, 0], d: 6, h: 40,
      }),
    })
    expect(c.computed().sketchBodies[1].role).toBe('solid')

    c.computed().sketchBodies[1].onRole()

    expect(c.state.sketch.nodes[1].role).toBe('hole')
    expect(overlay(el)).toEqual(['result', 'bore'])
  })

  it('goes away on the cross, and the last one takes the overlay with it', () => {
    const { c, el } = panel({ sketch: withBlock() })
    c.computed().sketchBodies[0].onRemove()

    expect(c.state.sketch.nodes).toEqual([])
    expect(el.clearOverlay).toHaveBeenCalledTimes(1)
  })

  it('spells an extruded profile as points, and reads them back the same way', () => {
    const { c } = panel()
    c.computed().sketchOps[3].onClick()
    const profile = c.computed().sketchBodies[0].groups[0].fields[1]
    expect(profile.value).toBe('0,0; 20,0; 20,10; 0,10')

    type(profile, '0,0; 10,0; 10,10;')
    // The trailing `;` somebody types before the next point is dropped rather
    // than guessed at — a corner at the origin would be a point nobody asked for.
    expect(c.state.sketch.nodes[0].profile).toEqual([[0, 0], [10, 0], [10, 10]])
  })

  it('drops a pair that does not read as two numbers, rather than guessing at it', () => {
    // A PAIR IS TWO FINITE NUMBERS OR IT IS NOT A PAIR. Parsed with the same
    // reader the placements use — which answers 0 for anything that is not a
    // number — `a,b` planted a corner at the origin and `20,` one on the axis:
    // points nobody typed, in a profile the reader is looking at.
    const { c } = panel()
    c.computed().sketchOps[3].onClick()
    const profile = () => c.computed().sketchBodies[0].groups[0].fields[1]

    type(profile(), '0,0; a,b; 20,10')
    expect(c.state.sketch.nodes[0].profile).toEqual([[0, 0], [20, 10]])

    type(profile(), '0,0; 20,; 20,10; 5')
    expect(c.state.sketch.nodes[0].profile).toEqual([[0, 0], [20, 10]])

    // Whitespace around the numbers is not what makes a pair unreadable.
    type(profile(), ' 0 , 0 ; -2.5,10 ')
    expect(c.state.sketch.nodes[0].profile).toEqual([[0, 0], [-2.5, 10]])
  })
})

// -- the params ---------------------------------------------------------------

describe('a parameter', () => {
  it('is added, named, captioned and given a kind', () => {
    const { c } = panel({ sketch: withBlock() })
    c.computed().sketchAddParam()
    expect(c.state.sketch.params).toHaveLength(1)

    type(c.computed().sketchParams[0].name, 'body')
    type(c.computed().sketchParams[0].caption, 'Body')
    c.computed().sketchParams[0].onType()

    expect(c.state.sketch.params[0])
      .toMatchObject({ name: 'body', caption: 'Body', type: 'slider' })
    c.computed().sketchParams[0].onType()
    expect(c.state.sketch.params[0].type).toBe('number')
  })

  it('carries a value, and bounds it may simply not have', () => {
    const { c } = panel({ sketch: addParam(withBlock(), BODY) })
    const number = (key) => c.computed().sketchParams[0].numbers
      .find((entry) => entry.key === key)

    expect(number('initial').value).toBe('42.3')
    expect(number('min').value).toBe('40')

    type(number('max'), '')

    // `undefined` and not 0: `paramText` prints the range only when both ends
    // are there, and a 0 would read as a real limit. The pieces the param does
    // carry are still spelled out beside it.
    expect(c.state.sketch.params[0].max).toBeUndefined()
    expect(sketchText(c.state.sketch))
      .toContain('body = 42.3 (step 0.1) slider "Body"\n')
  })

  it('drives a dimension by name, which is the whole of the language', () => {
    const { c, el } = panel({ sketch: addParam(withBlock(), BODY) })
    type(sizeFields(c)[0], 'body')

    expect(c.state.sketch.nodes[0].size).toEqual(['body', 20, 20])
    expect(c.state.sketchError).toBeNull()
    expect(overlay(el)).toEqual(['result'])
    expect(sketchText(c.state.sketch)).toContain('42.3 (body)')
  })

  it('goes away on the cross', () => {
    const { c } = panel({ sketch: addParam(withBlock(), BODY) })
    c.computed().sketchParams[0].onRemove()
    expect(c.state.sketch.params).toEqual([])
  })

  it('carries every dimension that names it when it is renamed', () => {
    // RENAMING IS WHAT A READER DOES TO A PARAM, and `wall` -> `wall_t` is typed
    // one character at a time. A rename that rewrote the record alone left
    // `korpus` asking for a param nobody has: the document stopped building on
    // the first character, and there was no way back from the panel, because
    // the name that would repair it is the one the rename took away.
    const { c, el } = panel({
      sketch: addParam(withBlock(), { ...BODY, name: 'wall' }),
    })
    type(sizeFields(c)[0], 'wall')
    expect(c.state.sketchError).toBeNull()

    type(c.computed().sketchParams[0].name, 'wall_t')

    expect(c.state.sketch.params[0].name).toBe('wall_t')
    expect(c.state.sketch.nodes[0].size).toEqual(['wall_t', 20, 20])
    expect(c.state.sketchError).toBeNull()
    expect(overlay(el)).toEqual(['result'])
    expect(sketchText(c.state.sketch)).toContain('42.3 (wall_t)')
  })

  it('refuses to go while a body still names it, and says which bodies', () => {
    // The other way to leave the document unbuildable, and the same repair: a
    // sentence naming what to see to rather than an error naming a param the
    // reader can no longer see anywhere in the panel.
    const { c, el } = panel({ sketch: addParam(withBlock(), BODY) })
    type(sizeFields(c)[0], 'body')
    const drawn = el.setOverlay.mock.calls.length

    c.computed().sketchParams[0].onRemove()

    expect(c.state.sketch.params).toHaveLength(1)
    expect(c.computed().sketchSays).toMatch(/body is still a dimension of korpus/)
    expect(css(c.computed().sketchSaysStyle).display).toBe('block')
    // Nothing was staged over it either: the body on the model is the one the
    // document still describes.
    expect(el.setOverlay).toHaveBeenCalledTimes(drawn)

    // ...and it goes the moment nothing spends it.
    type(sizeFields(c)[0], '20')
    c.computed().sketchParams[0].onRemove()
    expect(c.state.sketch.params).toEqual([])
    expect(c.computed().sketchSays).toBe('')
  })

  it('refuses the EDIT without taking `add to comment` with it', () => {
    // A REFUSAL OF A GESTURE IS NOT A DOCUMENT THAT WILL NOT PROJECT, and the
    // two used to be written into one field. The × on a param in use changes
    // nothing — the document is the one that was on screen a moment ago — so
    // hiding the link left a sketch that projects perfectly with no way out of
    // the panel at all, which is the feature's only exit.
    const { c } = panel({ sketch: addParam(withBlock(), BODY) })
    type(sizeFields(c)[0], 'body')

    c.computed().sketchParams[0].onRemove()

    expect(css(c.computed().sketchAddStyle).display).not.toBe('none')
    c.computed().sketchAdd()
    expect(c.state.composer.sketch).toContain('42.3 (body)')
    // The kernel's own refusal still closes it, which is the half that stays.
    type(sizeFields(c)[0], 'wat')
    expect(css(c.computed().sketchAddStyle).display).toBe('none')
  })

  it('is added under a name no other param has, however the list got here', () => {
    // `addParam` appends whatever it is given, and two params under one name
    // make `updateParam` edit both and `resolveValue` answer with the first.
    // `params.length + 1` is the obvious spelling and is wrong twice: remove
    // `p1` of two and the count says `p2`, which is standing right there.
    const { c } = panel()
    c.computed().sketchAddParam()
    c.computed().sketchAddParam()
    expect(c.state.sketch.params.map((param) => param.name)).toEqual(['p1', 'p2'])

    c.computed().sketchParams[0].onRemove()
    c.computed().sketchAddParam()

    expect(c.state.sketch.params.map((param) => param.name)).toEqual(['p2', 'p3'])
  })

  it('is RENAMED under one too, by the rule a body is renamed by', () => {
    // The same state, reached from the other side. `renameParam` used to write
    // whatever it was given, so `gap` typed onto a document that already has a
    // `body` left two records answering to one name: `resolveValue` reads the
    // first, `updateParam` and `removeParam` write both, and the panel draws the
    // two rows identically — there is no way back out of it, because neither row
    // can be told from the other. `body2`, exactly as a second body called
    // `korpus` comes back `korpus2`.
    const { c } = panel({
      sketch: addParam(addParam(withBlock(), BODY), { ...BODY, name: 'gap' }),
    })
    type(sizeFields(c)[0], 'body')

    type(c.computed().sketchParams[1].name, 'body')

    expect(c.state.sketch.params.map((param) => param.name)).toEqual(['body', 'body2'])
    // And the box is still sized from the param it was sized from.
    expect(c.state.sketch.nodes[0].size).toEqual(['body', 20, 20])
    expect(c.state.sketchError).toBeNull()
  })
})

// -- what happens when it will not build --------------------------------------

describe('a document the kernel refuses', () => {
  it('says what it said, and leaves the last good body on the model', () => {
    // THE ASSERTION THIS PANEL NEEDS MOST. The commonest way to reach a
    // document that will not build is halfway through typing — a dimension
    // naming a param that has not been added yet — and blanking the model at
    // that moment would make the body flash away and back on every keystroke.
    const { c, el } = panel({ sketch: withBlock() })
    c.computed().sketchOps[0].onClick()
    const good = el.setOverlay.mock.calls.length

    type(sizeFields(c)[0], 'wat')

    expect(c.state.sketchError).toMatch(/no param named "wat"/)
    expect(css(c.computed().sketchSaysStyle).display).toBe('block')
    // Not one more call: the shape on screen is the last one that meant
    // something, and nothing was taken off.
    expect(el.setOverlay).toHaveBeenCalledTimes(good)
    expect(el.clearOverlay).not.toHaveBeenCalled()
  })

  it('takes the message back as soon as the document builds again', () => {
    const { c, el } = panel({ sketch: withBlock() })
    type(sizeFields(c)[0], 'wat')
    expect(c.state.sketchError).toBeTruthy()

    type(sizeFields(c)[0], '12')

    expect(c.state.sketchError).toBeNull()
    expect(overlay(el)).toEqual(['result'])
  })

  it('is not what an emptied field makes — that is a zero, and a zero builds', () => {
    // The other half of the same decision. A dimension is a number or the name
    // of a param, so an empty field could be read either way, and what the
    // choice settles is what the reader sees mid-edit: a zero flattens the body
    // in front of them and comes back with the next digit, while an empty NAME
    // would stop the document building and put "no param named \"\"" in the
    // panel — a sentence about a language they never used.
    const { c, el } = panel({ sketch: withBlock() })
    type(sizeFields(c)[0], '')

    expect(c.state.sketch.nodes[0].size).toEqual([0, 20, 20])
    expect(c.state.sketchError).toBeNull()
    expect(overlay(el)).toEqual(['result'])
  })
})

// -- typing -------------------------------------------------------------------

describe('a field being typed in', () => {
  const at = (c, axis = 0) => c.computed().sketchBodies[0].groups[1].fields[axis]

  it('costs nothing at all until the value is settled', () => {
    // THE ASSERTION THE COMMIT MODEL EXISTS FOR. A keystroke that reached the
    // document rebuilt the bodies and handed them to the viewport, and the
    // viewport answers an overlay with a whole scene: `clear()` disposes every
    // geometry and every material, `render()` builds them again, the tree goes
    // back up to React. Measured on this repository's own kernel, the CSG alone
    // is 81 ms at twelve bodies and 23 ms at four — before any of the rest of it
    // — so `-12.5` was five of those on the way to one number.
    const { c, el } = panel({ sketch: withBlock() })
    for (const text of ['-', '-1', '-12', '-12.', '-12.5']) {
      at(c).onChange({ target: { value: text } })
    }

    expect(el.setOverlay).not.toHaveBeenCalled()
    expect(c.state.sketch.nodes[0].at[0]).toBe(0)
    // ...and what the reader has typed is on screen the whole time.
    expect(at(c).value).toBe('-12.5')

    at(c).onBlur({ target: { value: '-12.5' } })

    expect(c.state.sketch.nodes[0].at[0]).toBe(-12.5)
    expect(el.setOverlay).toHaveBeenCalledTimes(1)
  })

  it('settles on Enter as well, without waiting for the focus to leave', () => {
    const { c, el } = panel({ sketch: withBlock() })
    at(c).onChange({ target: { value: '7' } })
    at(c).onKeyDown({ key: 'Enter', target: { value: '7' } })

    expect(c.state.sketch.nodes[0].at[0]).toBe(7)
    expect(el.setOverlay).toHaveBeenCalledTimes(1)

    // Any other key is just a key: the commit is `change`, and `change` is a
    // blur or an Enter.
    at(c).onChange({ target: { value: '8' } })
    at(c).onKeyDown({ key: 'a', target: { value: '8' } })
    expect(c.state.sketch.nodes[0].at[0]).toBe(7)
  })

  it('keeps the decimal point the document cannot hold', () => {
    // `42.` parses to `42`, so a field drawn from the document alone would
    // rewrite the point away under the cursor and land the next digit in the
    // units column. That is what the draft is for, and it is why the draft
    // outlives the keystroke rather than being read back off the document.
    const { c } = panel({ sketch: withBlock() })

    at(c).onChange({ target: { value: '12.' } })

    expect(at(c).value).toBe('12.')
    expect(c.state.sketchDraft).toEqual({ key: 'n1.at.0', text: '12.' })
  })

  it('hands the field back to the document when the typing ends', () => {
    const { c } = panel({ sketch: withBlock() })
    at(c).onChange({ target: { value: '12.' } })

    at(c).onBlur({ target: { value: '12.' } })

    expect(c.state.sketchDraft).toBeNull()
    expect(c.state.sketch.nodes[0].at[0]).toBe(12)
    expect(at(c).value).toBe('12')
  })

  it('commits nothing for a field nobody typed in', () => {
    // A blur reaches every field the focus leaves, the ones only tabbed through
    // included. Committing those would stage a whole scene for a value that did
    // not change — the draft is the record of having typed, so it is also the
    // condition.
    const { c, el } = panel({ sketch: withBlock() })

    at(c).onBlur({ target: { value: '0' } })

    expect(el.setOverlay).not.toHaveBeenCalled()
    expect(c.state.sketch).toEqual(withBlock())
  })

  it('holds one field and not a map of them, so no other field is stale', () => {
    const { c } = panel({ sketch: withBlock() })
    type(at(c, 0), '12.')
    at(c, 1).onChange({ target: { value: '7' } })

    // The committed one reads off the document, the one being typed in off the
    // draft — and there is exactly one draft, so no third field can be showing
    // somebody's abandoned text.
    expect(at(c, 0).value).toBe('12')
    expect(at(c, 1).value).toBe('7')
    expect(at(c, 2).value).toBe('0')
  })
})

// -- reaching the agent -------------------------------------------------------

describe('add to comment', () => {
  it('opens the composer with the projection the agent reads', () => {
    const doc = addParam(withBlock(), BODY)
    const { c } = panel({ sketch: doc })

    c.computed().sketchAdd()

    expect(c.state.composer.sketch).toBe(sketchText(doc))
    // `part` is EMPTY where the measurement's door and the drag's fill it: a
    // sketch is about a body that is in no build and no catalogue, so there is
    // no row to name and no key to anchor to.
    expect(c.state.composer.part).toBe('')
    expect(c.state.composer.partId).toBeNull()
    expect(c.state.composer.key).toBeNull()
    expect(c.state.tool).toBeNull()
    expect(c.sync).toHaveBeenCalled()
  })

  it('is not offered on an empty sketch, nor to a reader with no token', () => {
    // The panel is already closed to a reader with no token; the link carries
    // the gate anyway, because without it it would open a composer
    // `composerStyle` keeps at `display:none` — nothing appears, and there is no
    // close button on screen to take it back.
    expect(css(panel().c.computed().sketchAddStyle).display).toBe('none')
    expect(css(panel({ sketch: withBlock() }).c.computed().sketchAddStyle).display)
      .not.toBe('none')
    expect(css(panel({ sketch: withBlock(), token: null }).c.computed().sketchAddStyle)
      .display).toBe('none')
  })

  it('can be taken off a draft again', () => {
    const { c } = panel({ sketch: withBlock() })
    c.computed().sketchAdd()
    expect(css(c.computed().compSketchChipStyle).display).toBe('flex')

    c.computed().compSketchRemove(click)

    expect(c.state.composer.sketch).toBeNull()
    expect(css(c.computed().compSketchChipStyle).display).toBe('none')
  })

  it('is not offered on a document the panel has already flagged', () => {
    // `sketchText` REFUSES EXACTLY WHAT `setSketch` CAUGHT — a dimension naming
    // a param that is not there — so on such a document the link stood over a
    // projection that cannot be rendered: pressing it threw inside a React
    // handler, nothing opened, and the feature's only exit silently did nothing.
    // The panel is already saying what is wrong; what it must not do is offer to
    // send it.
    const { c } = panel({ sketch: withBlock() })
    type(sizeFields(c)[0], 'wat')
    expect(c.state.sketchError).toBeTruthy()
    expect(css(c.computed().sketchAddStyle).display).toBe('none')

    // ...and the handler refuses too, because a hidden link is a decision about
    // what is drawn and this is a decision about what happens.
    expect(() => c.computed().sketchAdd()).not.toThrow()
    expect(c.state.composer).toBeNull()

    // The offer is back as soon as the document builds again.
    type(sizeFields(c)[0], '12')
    expect(css(c.computed().sketchAddStyle).display).not.toBe('none')
    c.computed().sketchAdd()
    expect(c.state.composer.sketch).toBe(sketchText(c.state.sketch))
  })
})

// -- the doors the bodies are not for -----------------------------------------

describe('a sketch body as the part a task is filed against', () => {
  // The bodies are staged INTO the scene (`staged()` in viewport/element.js), so
  // each is an ordinary row in the tree and an ordinary pick target — which puts
  // them in front of every door that files a task about a PART. Each would write
  // it in the BUILD's terms against a body that is in no build, no catalogue and
  // no revision: `partId: "/model/sketch/korpus"` names nothing the agent can
  // look up. This is the class `toolsOff` exists for, read off the other source
  // of parts.
  //
  // THE MEASUREMENT IS NOT ONE OF THEM: a distance between two faces of a mock
  // is what the panel is for, and the number goes to the agent unchanged. Only
  // the part it would be filed against is refused.
  //
  // THE MOVE TOOL IS REFUSED AT THE PRESS and is therefore not here but in
  // ui/tests/tools.test.js — a chip refused at the `hmr:moved` end arrives with
  // the mock already dragged and its offset already written.
  //
  // WHICH PATHS ARE THE OVERLAY'S IS THE VIEWPORT'S ANSWER, because that is
  // where the group's name is minted — `sketch`, or `sketch2` beside a model
  // that publishes a group of that name. The spy says so for the paths spelled
  // here; the real answer is element.test.js's subject, like everything else
  // this file asks of the viewport.
  //
  // THE GROUP NODE ANSWERS YES TOO, exactly as the real one does: it is a row of
  // the tree, a row is selected with the mouse, and `selectedPaths()` sends a
  // node's own id.
  const staging = (el) => el.isOverlay.mockImplementation(
    (id) => typeof id === 'string'
      && (id === '/model/sketch' || id.startsWith('/model/sketch/')))

  const fire = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }))

  // The tree as it stands with a body staged in: the model's own part beside the
  // mock under the overlay's group. The mock carries NO `key` — the catalogue
  // identity a comment outlives a rebuild by — because `part()` in sketchgeom.js
  // mints none for a body that is in no catalogue.
  const STAGED = {
    id: '/model',
    name: 'model',
    children: [
      { id: '/model/plate', name: 'plate', key: 'plate', known: true },
      {
        id: '/model/sketch',
        name: 'sketch',
        children: [{ id: '/model/sketch/korpus', name: 'korpus', known: true }],
      },
    ],
  }

  /** The page with a measurement standing and one path selected. */
  function measured(sel, selName) {
    const { c, el } = panel({ sketch: withBlock() })
    staging(el)
    c.state = {
      ...c.state,
      tree: indexTree(STAGED),
      sel,
      selName,
      measure: { text: '12.00 mm', note: '', full: '12.00 mm' },
    }
    return c
  }

  it('opens no composer, though a point on the build still does', () => {
    const { c, el } = mounted({ sketch: withBlock() })
    staging(el)

    fire(PLACE, { id: '/model/sketch/korpus', name: 'korpus', p: [1, 2, 3] })

    expect(c.state.composer).toBeNull()

    fire(PLACE, { id: '/model/plate', name: 'plate', p: [1, 2, 3] })

    expect(c.state.composer).toMatchObject({ part: 'plate', partId: '/model/plate' })
  })

  it('sends a measurement taken on it with no part named at all', () => {
    // The reader clicked the mock to look at it — which is what `sel` holds,
    // since `onPick` writes any path picked — measured a distance on it and
    // pressed `add to comment`. The number travels; the attribution does not.
    const c = measured('/model/sketch/korpus', 'korpus')

    c.computed().measAdd()

    expect(c.state.composer.meas).toBe('12.00 mm')
    expect(c.state.composer.part).toBeFalsy()
    expect(c.state.composer.partId).toBeNull()
    expect(c.state.composer.key).toBeNull()
  })

  it('sends no part for the GROUP the bodies hang under either', () => {
    // The row over them all, selected from the tree — `sketch` is no more a part
    // of the build than `korpus` is, and `/model/sketch` resolves in it no
    // better.
    const c = measured('/model/sketch', 'sketch')

    c.computed().measAdd()

    expect(c.state.composer.meas).toBe('12.00 mm')
    expect(c.state.composer.part).toBeFalsy()
    expect(c.state.composer.partId).toBeNull()
  })

  it('still carries the part when the measurement was taken on the build', () => {
    const c = measured('/model/plate', 'plate')

    c.computed().measAdd()

    expect(c.state.composer).toMatchObject({
      part: 'plate', partId: '/model/plate', key: 'plate', meas: '12.00 mm',
    })
  })
})

// -- the three tables that have to carry the same ops --------------------------

describe('the op tables', () => {
  it('are keyed alike in all three places, or the projection throws', () => {
    // `DIMS` in sketch.js says how an op spells its size to the agent, `SHAPES`
    // in sketchgeom.js builds its geometry, and `SIZES` in the panel draws its
    // fields. THREE COMMENTS SAID SO AND NOTHING CHECKED IT: an op added to two
    // of them builds, draws, and passes every other test in this directory —
    // and then throws at `add to comment`, which is the one door nothing else
    // covers, in a React handler, where the reader sees nothing happen.
    //
    // `sketchOps` IS `SIZES`'s KEY LIST, read off the table rather than written
    // beside it (see `computed`), so this really is the third of the three.
    expect([...ops(panel().c)].sort()).toEqual([...DIM_OPS].sort())
    expect([...ops(panel().c)].sort()).toEqual([...SHAPE_OPS].sort())
  })

  it('carry every op the panel can add, all the way to the text', () => {
    // The same agreement read as behaviour: each op is added, built, drawn and
    // projected. An op missing from `NEW_BODY` — the fourth table, which is not
    // an invariant because a missing entry cannot be silent — fails here too.
    for (const [index, op] of ops(panel().c).entries()) {
      const { c } = panel()
      c.computed().sketchOps[index].onClick()

      expect(c.state.sketchError).toBeNull()
      expect(c.computed().sketchBodies[0].groups[0].fields.length)
        .toBeGreaterThan(0)
      expect(sketchText(c.state.sketch)).toContain(`solid  ${op}`)
    }
  })
})

// -- what a re-stage does NOT do ----------------------------------------------

describe('the model event a re-stage sends back', () => {
  // The scene the viewport composed out of the document it already had, with
  // the sketch's body in it. It arrives on the same event a rebuild does, and
  // the difference is the flag.
  const TREE = {
    id: '/model',
    name: 'model',
    children: [
      { id: '/model/plate', name: 'plate', key: 'plate', known: true },
      {
        id: '/model/sketch',
        name: 'sketch',
        children: [{ id: '/model/sketch/result', name: 'result', known: true }],
      },
    ],
  }

  it('leaves the measurement and the moved part exactly where they were', () => {
    // BLOCKS 6 AND 7, AND BLOCK 6 IS WHAT THIS FEATURE IS MODELLED ON. Both
    // chips describe the model, and a re-stage does not touch the model: it is
    // the same document with a body drawn over it. Dropped here, they went on
    // the keystroke that committed a number in a panel that has nothing to do
    // with either — and the viewport's own halves of them survive, so the page
    // would also have been disagreeing with the scene.
    const { c } = panel({ sketch: withBlock() })
    c.state = {
      ...c.state,
      measure: { text: '2.4 mm' },
      moved: { text: 'plate by 3 mm' },
    }

    c.onModel({ tree: TREE, view: 'assembled', live: true, restage: true })

    expect(c.state.measure).toEqual({ text: '2.4 mm' })
    expect(c.state.moved).toEqual({ text: 'plate by 3 mm' })
    // The tree still lands: it is what the sketch's own rows arrive in.
    expect([...c.state.tree.nodes.keys()]).toContain('/model/sketch/result')
  })

  it('still drops both when the model itself was replaced', () => {
    // The default, and the reason the flag had to be added rather than the
    // clearing simply removed: on a rebuild every part goes back where the model
    // puts it and the faces a distance was measured between may be gone.
    const { c } = panel({ sketch: withBlock() })
    c.state = {
      ...c.state,
      measure: { text: '2.4 mm' },
      moved: { text: 'plate by 3 mm' },
    }

    c.onModel({ tree: TREE, view: 'assembled', live: true })

    expect(c.state.measure).toBeNull()
    expect(c.state.moved).toBeNull()
  })
})

// -- what a build swap does to it ---------------------------------------------

describe('another revision opening', () => {
  it('leaves the sketch and its attachment alone', () => {
    // Everything `leaveBuild` clears is a coordinate this page took off geometry
    // that has left: which solid was picked, where in space, a measurement
    // between two faces, a part dragged out of the assembly. A sketch is none of
    // those — it is the reader's own claim about a motor or a wall, and it is as
    // true of the revision arriving as of the one leaving.
    const { c } = panel({ sketch: withBlock() })
    c.computed().sketchAdd()

    const { state } = c.leaveBuild(true)

    expect('sketch' in state).toBe(false)
    expect('sketchOpen' in state).toBe(false)
    expect(state.composer.sketch).toBe(sketchText(c.state.sketch))
    // ...while the fields that DID describe the build that left are emptied.
    expect(state.composer.part).toBe('')
    expect(state.composer.meas).toBeNull()
  })
})
