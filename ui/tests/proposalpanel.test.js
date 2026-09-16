// The proposal panel on the build page: a rough body, in numbers, over a model.
//
// WHAT IT IS FOR is ui-brief block 6 one step further on. Block 6 lets somebody
// MOVE a part to show the agent what they want instead of describing it, and
// says out loud that this is not an edit of the model. This is the same
// statement about a body the model has to FIT or to follow — the motor it must
// clear, the wall it bolts to, the bought part it holds, the layout the author
// wants — assembled out of primitives and sent to the agent as text.
//
// The document and the kernel are tested next door in ui/tests/proposal.test.js,
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

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { PLACE, PROPOSALMOVE } from '../src/events.js'
import { indexTree } from '../src/hub.js'
import {
  addNode, DIM_OPS, emptyProposal, proposalText,
} from '../src/proposal.js'
import { SHAPE_OPS } from '../src/proposalgeom.js'
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
const PROPOSAL_ATTRIBUTE = 'data-proposal-panel'

const stampProposal = (on) => {
  document.documentElement.setAttribute(PROPOSAL_ATTRIBUTE, on ? 'on' : 'off')
}

// Back to a page nobody stamped, so a fixture that forgets to say cannot inherit
// the last test's hub.
afterEach(() => {
  document.documentElement.removeAttribute(PROPOSAL_ATTRIBUTE)
})

/** A box with a name worth recognising in an assertion. */
const BLOCK = {
  id: 'n1', name: 'korpus', op: 'box', role: 'solid',
  at: [0, 0, 0], rot: [0, 0, 0], size: [20, 20, 20],
};

const withBlock = () => addNode(emptyProposal(), BLOCK);

/**
 * The component as `computed()` and the panel's handlers see it.
 *
 * `setState` is the real one's CONTRACT — merge, then run the callback — because
 * `set()` reaches `sync()` through that callback, and `proposalAdd` goes through
 * `set()`. The element is three spies: `setOverlay`, `clearOverlay` and the one
 * question this page asks it back — whether a path is a body of the overlay —
 * and what the viewport DOES with the parts, `isOverlay`'s own answer included,
 * is element.test.js's subject.
 */
function panel({ token = 'sekrit', proposal, open = true, narrow = false,
                 served = true } = {}) {
  stampProposal(served)
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
  c._proposalSeq = proposal ? proposal.nodes.length : 0
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
    proposal: proposal || emptyProposal(), proposalOpen: open, proposalError: null,
    proposalDraft: null,
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
const ops = (c) => c.computed().proposalOps.map((op) => op.key)

/** One body's size fields, whatever op it is. */
const sizeFields = (c, index = 0) => c.computed().proposalBodies[index].groups[0].fields

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

/**
 * The DOM node a number field is drawn as, the way react-dom draws it.
 *
 * THE `value` ATTRIBUTE AS WELL AS THE PROPERTY, because the attribute is the
 * STEP BASE: with it, a size of 42.3 and a step of 1 nudge to 43.3, and without
 * it the base is 0 and the same nudge snaps to 43. A fixture that set only the
 * property would be asserting about a field this panel does not have.
 *
 * WHICH IS A FIELD WHOSE VALUE IS ALREADY COMMITTED, and the fixture should be
 * read as standing for that one only. react-dom syncs the attribute on BLUR
 * rather than on every render — `setDefaultValue` skips a `type=number` that
 * currently has the focus — so in a browser the step base is the value as of the
 * last time the focus left. That is the state every test below is in, since
 * `type()` commits through a blur before anything is nudged; a decimal typed and
 * NOT committed would step from the older number instead.
 */
const numberNode = (f) => {
  const node = document.createElement('input')
  node.type = f.type
  node.step = String(f.step)
  node.setAttribute('value', f.value)
  node.value = f.value
  return node
}

/**
 * One field's own arrows, nudged — the whole gesture as the platform delivers
 * it, and the value it leaves in the field.
 *
 * A REAL `<input type="number">` DOES THE STEPPING, built out of the field's own
 * `type` and `step`, so what is asserted below is the number the browser would
 * have arrived at rather than one this file worked out. Then the two events a
 * step fires, in the order they fire: `input`, which React hands to `onChange`
 * and which touches the draft alone, and `change`, which is a real DOM event and
 * reaches the handler the field's `ref` put on the node.
 *
 * AND THEN THE TIMERS, because the document is written on the trailing edge of a
 * run of nudges rather than on each one — `nudgeProposal` says why — and a
 * single click of an arrow is a run of one.
 */
const nudge = (f, way = 'up') => {
  const node = numberNode(f)
  f.ref(node)
  if (way === 'up') node.stepUp()
  else node.stepDown()
  f.onChange({ target: node })
  node.dispatchEvent(new Event('change'))
  vi.runAllTimers()
  return node.value
}

// -- what it is, and when it is on screen -------------------------------------

describe('the panel', () => {
  it('is drawn only when it is open, and is gone from a reader with no token', () => {
    // The gate Move part carries and Measure does not: everything the proposal
    // produces leaves this page as a comment, which is behind the token, so a
    // reader who cannot comment has nowhere to send it.
    expect(css(panel({ open: false }).c.computed().proposalPanelStyle).display).toBe('none')
    expect(css(panel({ open: true }).c.computed().proposalPanelStyle).display).toBe('block')
    expect(css(panel().c.computed().proposalBtnStyle).display).not.toBe('none')
    expect(css(panel({ token: null }).c.computed().proposalBtnStyle).display).toBe('none')
  })

  it('is gone entirely from a hub that did not ask to serve it', () => {
    // The SECOND gate of the same kind, and it answers about the HUB rather
    // than about the reader: one setting, `PROPOSAL_PANEL`, stamped on `<html>`
    // before the page was sent. Unset means off, so a deployment that never
    // heard of this feature does not serve it — and neither half of it appears,
    // with a token in hand, with the flag open and with a body already typed in.
    const { c } = panel({ served: false, proposal: withBlock(), open: true })

    expect(c.state.token).toBe('sekrit')
    expect(c.state.proposalOpen).toBe(true)

    // OUT OF THE TREE AND NOT MERELY UNPAINTED, which is the difference between
    // this gate and the token's one line up. `display:none` is the right answer
    // about a READER who cannot use a feature this hub serves; a hub that never
    // asked for the feature should not be sending its markup at all. Asserted
    // against the rendered tree, because a `display` assertion passes either way
    // and would not notice the day the markup came back.
    // The button by its label, and the panel by the one line that belongs to it
    // alone — NOT by `add to comment`, which a measurement's chip says too, and
    // which therefore answers about the wrong half of the page.
    expect(texts(c.render())).not.toContain('Proposal')
    expect(texts(c.render())).not.toContain('result = union(solid) − union(hole)')

    // And with it the page is the page it always was: the flag takes away the
    // proposal and nothing else.
    expect(css(c.computed().measureBtnStyle).display).not.toBe('none')
  })

  it('is there again the moment the hub says so', () => {
    // The other direction, which is the half that would go unnoticed: a gate
    // spelled wrong — a wrong attribute name, a wrong value — reads as "off"
    // for every reader and fails nothing, because off is what the page looks
    // like when nobody asked. So the ON case is asserted too.
    const { c } = panel({ served: true, proposal: withBlock(), open: true })
    expect(css(c.computed().proposalBtnStyle).display).not.toBe('none')
    expect(css(c.computed().proposalPanelStyle).display).toBe('block')

    // THE SAME TWO STRINGS THE OFF CASE LOOKS FOR, and this half is what keeps
    // that half honest: `not.toContain` passes just as well against a string
    // that is misspelled here as against markup that is genuinely gone.
    expect(texts(c.render())).toContain('Proposal')
    expect(texts(c.render())).toContain('result = union(solid) − union(hole)')
  })

  it('is NOT taken out of service by a comparison, unlike the three tools', () => {
    // `toolsOff` guards a task filed in the BUILD's terms against a scene that
    // is not the build — a `/cmp/…` path in `partId`. A proposal names no part of
    // anything: it posts no path, and the body it describes is as true over a
    // comparison as over a build.
    const { c } = panel()
    c.state = {
      ...c.state,
      compare: true, cmpPair: ['a', 'b'], cmpView: 'assembled', cmpStage: 'ready',
    }
    expect(c.toolsOff()).toBe(true)
    expect(css(c.computed().proposalBtnStyle).pointerEvents).not.toBe('none')
    expect(css(c.computed().measureBtnStyle).pointerEvents).toBe('none')
  })

  it('really draws the rows, and not merely a panel with a heading on it', () => {
    // `computed()` answering with a list of bodies is not the same as the page
    // putting them on the screen — the lesson eltree.js is written around, where
    // a view body that drew no cards passed everything because the container it
    // emits was recognised. So this reads the element tree `render()` returned.
    const { c } = panel({ proposal: withBlock() })
    const values = collect(c.render(),
                           (el) => (el.type === 'input' ? el.props.value : undefined))

    expect(texts(c.render())).toContain('Proposal')
    // The body: its name, its three sizes, its place and its turn.
    expect(values).toContain('korpus')
    expect(values.filter((value) => value === '20')).toHaveLength(3)
    expect(values.filter((value) => value === '0')).toHaveLength(6)
  })

  it('draws nothing over the model until there is a body in it', () => {
    // An empty document builds a payload with no parts in it, and an empty
    // overlay in the tree says less than no overlay at all.
    const { c, el } = panel({ open: false })
    c.computed().tProposal()
    expect(c.state.proposalOpen).toBe(true)
    expect(el.setOverlay).not.toHaveBeenCalled()
    expect(el.clearOverlay).toHaveBeenCalled()
  })

  it('takes the body off the model when it is closed, and keeps the document', () => {
    // The panel is the only thing on screen saying the body is not part of the
    // model — there is no chip for it, because the panel it came out of is
    // standing right there. So a closed panel must not leave one over the model.
    // The DOCUMENT stays: a reader who shut the panel to look underneath comes
    // back to what they had.
    const { c, el } = panel({ proposal: withBlock() })
    c.computed().proposalClose(click)

    expect(c.state.proposalOpen).toBe(false)
    expect(el.clearOverlay).toHaveBeenCalledTimes(1)
    expect(c.state.proposal.nodes).toHaveLength(1)

    c.computed().tProposal()
    expect(overlay(el)).toEqual(['korpus'])
  })

  it('goes when the token does, and takes its body off the model with it', () => {
    // The panel is HIDDEN WITHOUT A TOKEN, like Move part, because everything it
    // produces leaves this page as a comment. `tokenClear` cleared the other two
    // surfaces the token gates and left this one standing: the header's button
    // was gone, so nothing could reopen it, `add to comment` was gone from under
    // it, and a body stood over the model with nothing on screen to account for
    // it — the panel being the only thing that says the body is not part of the
    // model.
    const { c, el } = panel({ proposal: withBlock() })

    c.computed().tokenClear(click)

    expect(c.state.token).toBeNull()
    expect(c.state.proposalOpen).toBe(false)
    expect(el.clearOverlay).toHaveBeenCalled()
    expect(css(c.computed().proposalPanelStyle).display).toBe('none')
    expect(css(c.computed().proposalBtnStyle).display).toBe('none')
  })
})

// -- the bodies ---------------------------------------------------------------

describe('a body', () => {
  it('can be any of the four ops, and each one draws something', () => {
    expect(ops(panel().c)).toEqual(['box', 'cylinder', 'sphere', 'extrude'])

    for (const [index, op] of ops(panel().c).entries()) {
      const { c, el } = panel()
      c.computed().proposalOps[index].onClick()

      expect(c.state.proposal.nodes[0].op).toBe(op)
      expect(c.state.proposalError).toBeNull()
      // It is a body big enough to see rather than a zero the kernel refuses —
      // a button that added an invisible thing would read as a button that did
      // nothing.
      expect(overlay(el)).toEqual([`${op}1`])
      expect(el.setOverlay.mock.calls.at(-1)[0][0].shape.vertices.length)
        .toBeGreaterThan(0)
    }
  })

  it('is added under an id of its own, however many have been deleted', () => {
    // A counter and not the length of the list: deleting the second of two and
    // adding another would mint `n2` twice, and two nodes under one id make
    // `updateNode` edit both.
    const { c } = panel()
    c.computed().proposalOps[0].onClick()
    c.computed().proposalOps[0].onClick()
    c.computed().proposalBodies[0].onRemove()
    c.computed().proposalOps[0].onClick()

    const ids = c.state.proposal.nodes.map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('takes its size, its place and its turn from the fields', () => {
    const { c, el } = panel({ proposal: withBlock() })
    type(sizeFields(c)[0], '30')
    type(c.computed().proposalBodies[0].groups[1].fields[2], '-4.5')
    type(c.computed().proposalBodies[0].groups[2].fields[1], '45')

    const node = c.state.proposal.nodes[0]
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
    const { c } = panel({ proposal: withBlock() })
    type(c.computed().proposalBodies[0].name, 'motor')
    expect(c.state.proposal.nodes[0].name).toBe('motor')

    type(c.computed().proposalBodies[0].name, '   ')
    expect(c.state.proposal.nodes[0].name).toBe('motor')
  })

  it('cannot be given a name another body already has', () => {
    // TWO PARTS UNDER ONE NAME ARE ONE ROW AND ONE GROUPS ENTRY: the second
    // stands in for the first, and the eye belongs to whichever arrived last.
    // The bodies are the whole of it — `firstFree` in proposal.js is the rule.
    const { c } = panel({ proposal: withBlock() })
    c.computed().proposalOps[1].onClick()
    type(c.computed().proposalBodies[1].name, 'korpus')
    expect(c.state.proposal.nodes.map((node) => node.name)).toEqual(['korpus', 'korpus2'])

    // AND THE PAYLOAD KEEPS NO NAME FOR ITSELF any more: it is one part per
    // body and nothing else, so `result` is a name like any other.
    type(c.computed().proposalBodies[1].name, 'result')
    expect(c.state.proposal.nodes[1].name).toBe('result')

    // ...and a body may still be renamed to the name it already has.
    type(c.computed().proposalBodies[0].name, 'korpus')
    expect(c.state.proposal.nodes[0].name).toBe('korpus')
  })

  it('flips between solid and hole, and a hole is drawn beside the bodies', () => {
    // The whole reason the subtraction tool is in the payload: a hole inside the
    // body is invisible the moment it is inside it, so the person cannot see
    // what they asked for or tell a hole that missed from one never added.
    const { c, el } = panel({
      proposal: addNode(withBlock(), {
        id: 'n2', name: 'bore', op: 'cylinder', role: 'solid',
        at: [0, 0, 0], rot: [0, 0, 0], d: 6, h: 40,
      }),
    })
    expect(c.computed().proposalBodies[1].role).toBe('solid')

    c.computed().proposalBodies[1].onRole()

    expect(c.state.proposal.nodes[1].role).toBe('hole')
    expect(overlay(el)).toEqual(['korpus', 'bore'])
  })

  it('goes away on the cross, and the last one takes the overlay with it', () => {
    const { c, el } = panel({ proposal: withBlock() })
    c.computed().proposalBodies[0].onRemove()

    expect(c.state.proposal.nodes).toEqual([])
    expect(el.clearOverlay).toHaveBeenCalledTimes(1)
  })

  it('spells an extruded profile as points, and reads them back the same way', () => {
    const { c } = panel()
    c.computed().proposalOps[3].onClick()
    const profile = c.computed().proposalBodies[0].groups[0].fields[1]
    expect(profile.value).toBe('0,0; 20,0; 20,10; 0,10')

    type(profile, '0,0; 10,0; 10,10;')
    // The trailing `;` somebody types before the next point is dropped rather
    // than guessed at — a corner at the origin would be a point nobody asked for.
    expect(c.state.proposal.nodes[0].profile).toEqual([[0, 0], [10, 0], [10, 10]])
  })

  it('drops a pair that does not read as two numbers, rather than guessing at it', () => {
    // A PAIR IS TWO FINITE NUMBERS OR IT IS NOT A PAIR. Parsed with the same
    // reader the placements use — which answers 0 for anything that is not a
    // number — `a,b` planted a corner at the origin and `20,` one on the axis:
    // points nobody typed, in a profile the reader is looking at.
    const { c } = panel()
    c.computed().proposalOps[3].onClick()
    const profile = () => c.computed().proposalBodies[0].groups[0].fields[1]

    type(profile(), '0,0; a,b; 20,10')
    expect(c.state.proposal.nodes[0].profile).toEqual([[0, 0], [20, 10]])

    type(profile(), '0,0; 20,; 20,10; 5')
    expect(c.state.proposal.nodes[0].profile).toEqual([[0, 0], [20, 10]])

    // Whitespace around the numbers is not what makes a pair unreadable.
    type(profile(), ' 0 , 0 ; -2.5,10 ')
    expect(c.state.proposal.nodes[0].profile).toEqual([[0, 0], [-2.5, 10]])
  })
})

// -- what happens when it will not build --------------------------------------

describe('a document the kernel refuses', () => {
  /** The size fields of the body added last, whatever op it is. */
  const lastSize = (c) => {
    const bodies = c.computed().proposalBodies
    return bodies[bodies.length - 1].groups[0].fields
  }

  it('says what it said, and leaves the last good body on the model', () => {
    // THE ASSERTION THIS PANEL NEEDS MOST. The commonest way to reach a
    // document that will not build is halfway through saying something — an
    // extrusion whose profile has two of its points typed so far, which is no
    // polygon at all — and blanking the model at that moment would make the
    // body flash away and back on the way to a shape that is perfectly fine.
    const { c, el } = panel({ proposal: withBlock() })
    c.computed().proposalOps[3].onClick()
    const good = el.setOverlay.mock.calls.length

    type(lastSize(c)[1], '0,0; 20,0')

    expect(c.state.proposalError).toMatch(/three or more points/)
    expect(css(c.computed().proposalSaysStyle).display).toBe('block')
    // Not one more call: the shape on screen is the last one that meant
    // something, and nothing was taken off.
    expect(el.setOverlay).toHaveBeenCalledTimes(good)
    expect(el.clearOverlay).not.toHaveBeenCalled()
  })

  it('takes the message back as soon as the document builds again', () => {
    const { c, el } = panel({ proposal: withBlock() })
    c.computed().proposalOps[3].onClick()
    type(lastSize(c)[1], '0,0; 20,0')
    expect(c.state.proposalError).toBeTruthy()

    type(lastSize(c)[1], '0,0; 20,0; 20,10')

    expect(c.state.proposalError).toBeNull()
    expect(overlay(el)).toEqual(['korpus', 'extrude2'])
  })

  it('is not what an emptied field makes — that is a zero, and a zero builds', () => {
    // What an empty field settles is what the reader sees mid-edit: a zero
    // flattens the body in front of them and comes back with the next digit,
    // which is visibly about the field they are typing in.
    const { c, el } = panel({ proposal: withBlock() })
    type(sizeFields(c)[0], '')

    expect(c.state.proposal.nodes[0].size).toEqual([0, 20, 20])
    expect(c.state.proposalError).toBeNull()
    expect(overlay(el)).toEqual(['korpus'])
  })
})

// -- typing -------------------------------------------------------------------

describe('a field being typed in', () => {
  const at = (c, axis = 0) => c.computed().proposalBodies[0].groups[1].fields[axis]

  it('costs nothing at all until the value is settled', () => {
    // THE ASSERTION THE COMMIT MODEL EXISTS FOR. A keystroke that reached the
    // document rebuilt the bodies and handed them to the viewport, and the
    // viewport answers an overlay with a whole scene: `clear()` disposes every
    // geometry and every material, `render()` builds them again, the tree goes
    // back up to React. Measured on this repository's own kernel, the CSG alone
    // is 81 ms at twelve bodies and 23 ms at four — before any of the rest of it
    // — so `-12.5` was five of those on the way to one number.
    //
    // THE VALUES ARE THE PLATFORM'S, keystroke by keystroke — measured in Chrome
    // 153 by typing `-12.5` into a real `<input type="number">` and reading
    // `value` on every `input` event, rather than worked out here. The lone `-`
    // arrives as `''`; the trailing dot of `-12.` is DROPPED rather than
    // emptying the field, so that keystroke reports the same `-12` as the one
    // before it.
    const { c, el } = panel({ proposal: withBlock() })
    for (const text of ['', '-1', '-12', '-12', '-12.5']) {
      at(c).onChange({ target: { value: text } })
    }

    expect(el.setOverlay).not.toHaveBeenCalled()
    expect(c.state.proposal.nodes[0].at[0]).toBe(0)
    // ...and what the reader has typed is on screen the whole time.
    expect(at(c).value).toBe('-12.5')

    at(c).onBlur({ target: { value: '-12.5' } })

    expect(c.state.proposal.nodes[0].at[0]).toBe(-12.5)
    expect(el.setOverlay).toHaveBeenCalledTimes(1)
  })

  it('settles on Enter as well, without waiting for the focus to leave', () => {
    const { c, el } = panel({ proposal: withBlock() })
    at(c).onChange({ target: { value: '7' } })
    at(c).onKeyDown({ key: 'Enter', target: { value: '7' } })

    expect(c.state.proposal.nodes[0].at[0]).toBe(7)
    expect(el.setOverlay).toHaveBeenCalledTimes(1)

    // Any other key is just a key: the commit is `change`, and `change` is a
    // blur or an Enter.
    at(c).onChange({ target: { value: '8' } })
    at(c).onKeyDown({ key: 'a', target: { value: '8' } })
    expect(c.state.proposal.nodes[0].at[0]).toBe(7)
  })

  it('keeps text the document cannot hold, so nothing is rewritten mid-word', () => {
    // A FIELD EMPTIED ON THE WAY TO ANOTHER NUMBER — selected and overtyped, or
    // cleared back to nothing, or standing on the `-` that begins a negative
    // one, which the platform reports as empty too. Drawn from the document
    // alone, the field would put the number that is still in there back under
    // the cursor between one keystroke and the next. That is what the draft is
    // for, and it is why it outlives the keystroke rather than being read back
    // off the document.
    const { c } = panel({ proposal: withBlock() })

    at(c).onChange({ target: { value: '' } })

    expect(at(c).value).toBe('')
    expect(c.state.proposalDraft).toEqual({ key: 'n1.at.0', text: '' })
  })

  it('hands the field back to the document when the typing ends', () => {
    // And the commit is what normalises the spelling: `5.0` is the number 5,
    // and the field shows the document's answer once the typing is over.
    const { c } = panel({ proposal: withBlock() })
    at(c).onChange({ target: { value: '5.0' } })

    at(c).onBlur({ target: { value: '5.0' } })

    expect(c.state.proposalDraft).toBeNull()
    expect(c.state.proposal.nodes[0].at[0]).toBe(5)
    expect(at(c).value).toBe('5')
  })

  it('commits nothing for a field nobody typed in', () => {
    // A blur reaches every field the focus leaves, the ones only tabbed through
    // included. Committing those would stage a whole scene for a value that did
    // not change — the draft is the record of having typed, so it is also the
    // condition.
    const { c, el } = panel({ proposal: withBlock() })

    at(c).onBlur({ target: { value: '0' } })

    expect(el.setOverlay).not.toHaveBeenCalled()
    expect(c.state.proposal).toEqual(withBlock())
  })

  it('holds one field and not a map of them, so no other field is stale', () => {
    const { c } = panel({ proposal: withBlock() })
    type(at(c, 0), '5.0')
    at(c, 1).onChange({ target: { value: '7' } })

    // The committed one reads off the document, the one being typed in off the
    // draft — and there is exactly one draft, so no third field can be showing
    // somebody's abandoned text.
    expect(at(c, 0).value).toBe('5')
    expect(at(c, 1).value).toBe('7')
    expect(at(c, 2).value).toBe('0')
  })
})

// -- a number moved with the arrows instead of the keyboard -------------------

describe('a number field', () => {
  const at = (c, axis = 0) => c.computed().proposalBodies[0].groups[1].fields[axis]
  const rot = (c, axis = 0) => c.computed().proposalBodies[0].groups[2].fields[axis]

  // THE CLOCK IS THIS BLOCK'S SUBJECT and not its background: a run of nudges is
  // one document written when the run stops, so every test in here has to be
  // able to say when the arrow was let go.
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is a number with a step, where the profile is text with none', () => {
    // THE ARROWS ARE THE PLATFORM'S: a `type` of `number` and a `step` is the
    // whole of what the panel says about them, and it is what brings the
    // spinner, the up and down keys and the repeat on a held key. A profile is
    // `x,y; x,y; …` and no kind of number, so it gets neither.
    const { c } = panel({ proposal: withBlock() })
    c.computed().proposalOps[3].onClick()

    for (const f of [...sizeFields(c), at(c, 0), at(c, 1), at(c, 2)]) {
      expect(f.type).toBe('number')
      expect(f.step).toBe(1)
    }
    // A TURN IS NOT A MILLIMETRE, which is the one place the two steps differ:
    // the angles a body is set to are the corners, and a degree a click would
    // be two dozen clicks to reach any of them.
    for (const axis of [0, 1, 2]) expect(rot(c, axis).step).toBe(15)

    const extrusion = c.computed().proposalBodies[1]
    expect(extrusion.groups[0].fields[0]).toMatchObject({ type: 'number', step: 1 })
    expect(extrusion.groups[0].fields[1].type).toBe('text')
    expect(extrusion.groups[0].fields[1].step).toBeUndefined()
    // Nor is a name a number, and nothing nudges one.
    expect(extrusion.name.type).toBe('text')
    expect(extrusion.name.ref).toBeUndefined()
  })

  it('reaches the document and the model when it is nudged', () => {
    // A NUDGE IS AN EDIT LIKE ANY OTHER, so it goes the whole way: the document
    // holds the new number and the viewport is handed the body built out of it.
    const { c, el } = panel({ proposal: withBlock() })

    expect(nudge(sizeFields(c)[0])).toBe('21')

    expect(c.state.proposal.nodes[0].size).toEqual([21, 20, 20])
    expect(overlay(el)).toEqual(['korpus'])
    expect(el.setOverlay).toHaveBeenCalledTimes(1)

    // Down as well as up, on the row whose step is its own.
    expect(nudge(rot(c, 1), 'down')).toBe('-15')
    expect(c.state.proposal.nodes[0].rot).toEqual([0, -15, 0])
    expect(proposalText(c.state.proposal)).toContain('rot (0, -15, 0)')

    // AND A NUDGE IS A MILLIMETRE FROM WHEREVER THE NUMBER IS, not a jump onto a
    // grid of whole ones: the step base is the field's own value, so a size
    // somebody measured off a real part keeps its decimal.
    type(sizeFields(c)[1], '42.3')
    expect(nudge(sizeFields(c)[1])).toBe('43.3')
    expect(c.state.proposal.nodes[0].size).toEqual([21, 43.3, 20])
  })

  it('lands on the `change` the platform fires, which React does not pass on', () => {
    // WHERE THE EDIT ACTUALLY LANDS, measured rather than assumed. React's
    // `onChange` is the DOM's `input` event — the keystroke, which touches the
    // draft alone — and the `change` a step fires straight after it is dropped
    // by React's own value tracker, which sees a value it has already reported
    // (react-dom 18.3.1). So the `input` half of a nudge moves the number in the
    // field and nothing else; it is the node's own `change` handler, put there
    // by the field's `ref`, that takes the same road a typed number takes.
    const { c, el } = panel({ proposal: withBlock() })
    const size = sizeFields(c)[0]
    const node = numberNode(size)
    size.ref(node)
    node.stepUp()

    size.onChange({ target: node })
    vi.runAllTimers()

    expect(c.state.proposal.nodes[0].size).toEqual([20, 20, 20])
    expect(c.state.proposalDraft).toEqual({ key: 'n1.size.0', text: '21' })
    expect(el.setOverlay).not.toHaveBeenCalled()

    node.dispatchEvent(new Event('change'))
    vi.runAllTimers()

    expect(c.state.proposal.nodes[0].size).toEqual([21, 20, 20])
    expect(c.state.proposalDraft).toBeNull()
    expect(el.setOverlay).toHaveBeenCalledTimes(1)
  })

  it('writes one document for a run of them, however long the arrow is held', () => {
    // A HELD ARROW IS NOT ONE EDIT. A browser repeats a held key and a held
    // spinner button at about 30 ms a tick and fires `input` and `change` on
    // every one, and a `change` that went straight to the document was a whole
    // proposal, a whole overlay and a whole scene staged again per tick: 23 ms of
    // CSG at four bodies, 81 ms at twelve, against the 30 ms the next tick
    // arrives in. The draft/commit split exists to keep a keystroke off that
    // road, and this is the same road by another door.
    const { c, el } = panel({ proposal: withBlock() })
    const node = numberNode(sizeFields(c)[0])

    // A second of holding the up arrow, at the rate a browser repeats it. The
    // same node throughout, with the `ref` put back on it every render, which is
    // what a re-render between two ticks actually does.
    for (let tick = 0; tick < 25; tick += 1) {
      const f = sizeFields(c)[0]
      f.ref(node)
      node.stepUp()
      f.onChange({ target: node })
      node.dispatchEvent(new Event('change'))
      vi.advanceTimersByTime(30)
    }

    // The FIELD is not waiting for anything — every tick landed in the draft, so
    // the number under the cursor moved with the arrow. The model did not.
    expect(node.value).toBe('45')
    expect(c.state.proposalDraft).toEqual({ key: 'n1.size.0', text: '45' })
    expect(c.state.proposal.nodes[0].size).toEqual([20, 20, 20])
    expect(el.setOverlay).not.toHaveBeenCalled()

    // And then the arrow is let go: the number it stopped on, once.
    vi.runAllTimers()

    expect(c.state.proposal.nodes[0].size).toEqual([45, 20, 20])
    expect(el.setOverlay).toHaveBeenCalledTimes(1)
  })

  it('drops a nudge that has not landed when the reader starts typing', () => {
    // TWO GESTURES IN THE SAME FIELD, which the spinner makes easy: a click of
    // the arrow leaves the focus in the field, so the next thing that happens can
    // be a keystroke. The waiting nudge holds the text it was handed rather than
    // reading the field when it wakes, so writing it then would put the stepped
    // number over what is being typed.
    const { c, el } = panel({ proposal: withBlock() })
    const f = at(c)
    const node = numberNode(f)
    f.ref(node)
    node.stepUp()
    f.onChange({ target: node })
    node.dispatchEvent(new Event('change'))

    vi.advanceTimersByTime(40)
    at(c).onChange({ target: { value: '9' } })
    vi.runAllTimers()

    expect(c.state.proposalDraft).toEqual({ key: 'n1.at.0', text: '9' })
    expect(c.state.proposal.nodes[0].at[0]).toBe(0)
    expect(el.setOverlay).not.toHaveBeenCalled()
  })

  it('writes once when the focus leaves before the nudge has landed', () => {
    // THE ORDINARY END OF EVERY NUDGE and not a rare path: a click of an arrow
    // leaves the focus in the field, so what follows is a click on the next
    // body, a Tab, or an Enter — and the commit those cause is synchronous while
    // the nudge is still waiting out its quiet window. The blur drops the draft
    // on its way through, and the timer that wakes up behind it finds none and
    // does nothing. That check on the draft is the whole of what keeps it quiet:
    // take it out and this gesture stages the scene twice — 23 ms of CSG at four
    // bodies, 81 ms at twelve — and the trailing edge has bought nothing. Which
    // is what this test fails on, and the only thing it is claiming.
    const { c, el } = panel({ proposal: withBlock() })
    const f = sizeFields(c)[0]
    const node = numberNode(f)
    f.ref(node)
    node.stepUp()
    f.onChange({ target: node })
    node.dispatchEvent(new Event('change'))

    // The focus leaves while that is still in the air.
    sizeFields(c)[0].onBlur({ target: node })

    expect(c.state.proposal.nodes[0].size).toEqual([21, 20, 20])
    expect(c.state.proposalDraft).toBeNull()
    expect(el.setOverlay).toHaveBeenCalledTimes(1)

    // And then the timer comes back to a field nobody is typing in.
    vi.runAllTimers()

    expect(c.state.proposal.nodes[0].size).toEqual([21, 20, 20])
    expect(el.setOverlay).toHaveBeenCalledTimes(1)

    // Enter is the same door by another key, and answers the same way.
    const g = sizeFields(c)[1]
    g.ref(node)
    node.setAttribute('value', '20')
    node.value = '20'
    node.stepUp()
    g.onChange({ target: node })
    node.dispatchEvent(new Event('change'))
    sizeFields(c)[1].onKeyDown({ key: 'Enter', target: node })
    vi.runAllTimers()

    expect(c.state.proposal.nodes[0].size).toEqual([21, 21, 20])
    expect(el.setOverlay).toHaveBeenCalledTimes(2)
  })

  it('does nothing at all once the panel is gone', () => {
    // The wait outlives the gesture, so the timer can come back on a component
    // that has been unmounted — a `setState` on a page nobody is on any more.
    // `componentWillUnmount` clears it; this is the line that says so, and the
    // same net `_swap` has in interface.test.js.
    const { c } = panel({ proposal: withBlock() })
    const f = sizeFields(c)[0]
    const node = numberNode(f)
    f.ref(node)
    node.stepUp()
    f.onChange({ target: node })
    node.dispatchEvent(new Event('change'))
    // The draft's own write is not what this is about.
    c.setState.mockClear()

    c.componentWillUnmount()
    vi.runAllTimers()

    expect(c.setState).not.toHaveBeenCalled()
    expect(c.state.proposal.nodes[0].size).toEqual([20, 20, 20])
  })

  it('lets the wheel scroll the sheet instead of stepping the body under it', () => {
    // THE PATH A READER TAKES EVERY TIME: click into a size, type, then scroll
    // down to the next body with the cursor still standing on that field. Over a
    // FOCUSED number input the wheel is a step of the value in Chrome and in
    // Firefox, `input` and `change` and all, so that path was ±1 mm per click of
    // the wheel — ±15° in a `rot` row — on a body nobody meant to touch. A text
    // field never had such a road.
    const { c } = panel({ proposal: withBlock() })
    const node = numberNode(sizeFields(c)[0])
    document.body.appendChild(node)
    onTestFinished(() => node.remove())
    node.focus()
    expect(document.activeElement).toBe(node)

    const wheel = { target: node, preventDefault: vi.fn() }
    sizeFields(c)[0].onWheel(wheel)

    // DROPPING THE FOCUS IS WHAT TAKES THE STEP AWAY, since the platform only
    // steps a field that has it — and not `preventDefault`, which React's
    // passive `wheel` listener (react-dom 18.3.1) would ignore anyway.
    expect(document.activeElement).not.toBe(node)
    expect(wheel.preventDefault).not.toHaveBeenCalled()

    // And a field with no arrows on it has nothing to take away.
    c.computed().proposalOps[3].onClick()
    expect(c.computed().proposalBodies[1].groups[0].fields[1].onWheel).toBeUndefined()
    expect(c.computed().proposalBodies[1].name.onWheel).toBeUndefined()
  })

  it('keeps the number that was there when the text is not one the browser can read', () => {
    // A LONE `-` OR A LONE `.`: a number input reports an EMPTY value for those
    // two and, measured in Chrome 153 one keystroke at a time, for nothing else
    // — `.5` reads back as `.5` and `12.` as `12`. An empty field is a zero in
    // this panel, so a negative number begun and then abandoned, the focus
    // leaving on a click elsewhere, used to zero the dimension and flatten the
    // body. `badInput` is the platform's own answer to "there is text in here
    // and I could not read it", and jsdom cannot have one: it never saw anybody
    // type, so the fixture supplies the answer the browser gives.
    const { c, el } = panel({ proposal: withBlock() })
    type(at(c), '7')
    expect(c.state.proposal.nodes[0].at[0]).toBe(7)

    at(c).onChange({ target: { value: '', validity: { badInput: true } } })
    at(c).onBlur({ target: { value: '', validity: { badInput: true } } })

    expect(c.state.proposal.nodes[0].at[0]).toBe(7)
    expect(el.setOverlay).toHaveBeenCalledTimes(1)
    // The draft goes even so, so the field stops showing the half-typed text and
    // hands itself back to the number that is still in the document.
    expect(c.state.proposalDraft).toBeNull()
    expect(at(c).value).toBe('7')
  })

  it('still reads a field emptied on the way to another number as a zero', () => {
    // THE OTHER HALF OF THE SAME TEST, and the rule that was already written
    // down: an empty field is a zero, and a zero builds. That is what lets the
    // body go flat under the cursor while a number is being replaced, and
    // `badInput` is the only thing that has to be told apart from it.
    const { c, el } = panel({ proposal: withBlock() })
    type(at(c), '7')

    at(c).onChange({ target: { value: '', validity: { badInput: false } } })
    at(c).onBlur({ target: { value: '', validity: { badInput: false } } })

    expect(c.state.proposal.nodes[0].at[0]).toBe(0)
    expect(el.setOverlay).toHaveBeenCalledTimes(2)
  })

  it('draws the arrows on the page and not only in `computed()`', () => {
    // The lesson eltree.js is written around: a field that answers `number` to a
    // test and reaches the markup without its `type` is a field with no arrows
    // on it, and every assertion above would still pass.
    const { c } = panel({ proposal: withBlock() })
    c.computed().proposalOps[3].onClick()
    // THE ELEMENTS AND NOT THEIR `props`, because `ref` is not one: React keeps
    // it on the element itself, and reading it off the props bag answers
    // `undefined` for a field that carries one perfectly well.
    const inputs = collect(c.render(), (el) => (el.type === 'input' ? el : undefined))
    const numbers = inputs.filter((el) => el.props.type === 'number')

    // The box's three sizes, three places and three turns; the extrusion's
    // height, its three places and its three turns.
    expect(numbers).toHaveLength(16)
    expect(numbers.filter((el) => el.props.step === 15)).toHaveLength(6)
    expect(numbers.filter((el) => el.props.step === 1)).toHaveLength(10)
    // And the handler that carries a nudge into the document is on every one,
    // as is the one that keeps a wheel over a focused field from being an edit.
    expect(numbers.every((el) => typeof el.ref === 'function')).toBe(true)
    expect(numbers.every((el) => typeof el.props.onWheel === 'function')).toBe(true)

    const profile = inputs.find((el) => el.props.value === '0,0; 20,0; 20,10; 0,10')
    expect(profile.props.type).toBe('text')
    expect(profile.props.step).toBeUndefined()
    expect(profile.props.onWheel).toBeUndefined()
  })
})

// -- reaching the agent -------------------------------------------------------

describe('add to comment', () => {
  it('opens the composer with the projection the agent reads', () => {
    const doc = withBlock()
    const { c } = panel({ proposal: doc })

    c.computed().proposalAdd()

    expect(c.state.composer.proposal).toBe(proposalText(doc))
    // `part` is EMPTY where the measurement's door and the drag's fill it: a
    // proposal is about a body that is in no build and no catalogue, so there is
    // no row to name and no key to anchor to.
    expect(c.state.composer.part).toBe('')
    expect(c.state.composer.partId).toBeNull()
    expect(c.state.composer.key).toBeNull()
    expect(c.state.tool).toBeNull()
    expect(c.sync).toHaveBeenCalled()
  })

  it('is not offered on an empty proposal, nor to a reader with no token', () => {
    // The panel is already closed to a reader with no token; the link carries
    // the gate anyway, because without it it would open a composer
    // `composerStyle` keeps at `display:none` — nothing appears, and there is no
    // close button on screen to take it back.
    expect(css(panel().c.computed().proposalAddStyle).display).toBe('none')
    expect(css(panel({ proposal: withBlock() }).c.computed().proposalAddStyle).display)
      .not.toBe('none')
    expect(css(panel({ proposal: withBlock(), token: null }).c.computed().proposalAddStyle)
      .display).toBe('none')
  })

  it('can be taken off a draft again', () => {
    const { c } = panel({ proposal: withBlock() })
    c.computed().proposalAdd()
    expect(css(c.computed().compProposalChipStyle).display).toBe('flex')

    c.computed().compProposalRemove(click)

    expect(c.state.composer.proposal).toBeNull()
    expect(css(c.computed().compProposalChipStyle).display).toBe('none')
  })

  it('is not offered on a document the panel has already flagged', () => {
    // A DOCUMENT THE KERNEL WOULD NOT BUILD IS NOT ONE TO SEND, and the link
    // used to stand over it anyway: the offer was there, and where the refusal
    // is an op no table knows, pressing it threw inside a React handler —
    // nothing opened, and the feature's only exit silently did nothing. The
    // panel is already saying what is wrong; what it must not do is offer to
    // send it.
    const { c } = panel({ proposal: withBlock() })
    const profile = () => c.computed().proposalBodies[1].groups[0].fields[1]
    c.computed().proposalOps[3].onClick()
    type(profile(), '0,0; 20,0')
    expect(c.state.proposalError).toBeTruthy()
    expect(css(c.computed().proposalAddStyle).display).toBe('none')

    // ...and the handler refuses too, because a hidden link is a decision about
    // what is drawn and this is a decision about what happens.
    expect(() => c.computed().proposalAdd()).not.toThrow()
    expect(c.state.composer).toBeNull()

    // The offer is back as soon as the document builds again.
    type(profile(), '0,0; 20,0; 20,10')
    expect(css(c.computed().proposalAddStyle).display).not.toBe('none')
    c.computed().proposalAdd()
    expect(c.state.composer.proposal).toBe(proposalText(c.state.proposal))
  })
})

// -- a body moved with the hand instead of with the fields --------------------

describe('a body dragged in the scene', () => {
  // THE COMPLAINT THIS ANSWERS, in the reader's words: "and how am I supposed to
  // move a proposal body — by typing a number?" The `at` fields stay what they
  // are; the Move tool over the body itself is the second way of saying the same
  // thing, and it ends HERE — `hmr:proposalmove`, naming the body and how far it
  // went. Everything from this point on is an ordinary edit of the document,
  // indistinguishable from the same numbers typed in.
  //
  // WHERE THE OTHER HALF IS TESTED: the gesture, what it refuses and what it
  // must not record, is ui/tests/tools.test.js — the viewport tells such a body
  // from a part of the build at the press, because only it knows the group's
  // name.
  //
  // WHAT IS GRABBABLE comes from the payload the panel builds (proposalgeom.js):
  // one part per body, solids and holes alike, so a grab is about the one node
  // that part was built from and the bodies beside it do not move.

  /** A hole with a place of its own, so a shift reads as an addition. */
  const BORE = {
    id: 'n2', name: 'bore', op: 'cylinder', role: 'hole',
    at: [5, 0, 0], rot: [0, 0, 0], d: 6, h: 40,
  }

  const fire = (name, delta) => window.dispatchEvent(
    new CustomEvent(PROPOSALMOVE, { detail: { name, delta } }))

  /** Every body's place, in document order. */
  const places = (c) => c.state.proposal.nodes.map((node) => node.at)

  /** What the panel's own `at` fields are showing for one body. */
  const atFields = (c, index = 0) => c.computed().proposalBodies[index].groups[1]
    .fields.map((f) => f.value)

  const withBore = () => addNode(withBlock(), BORE)

  it('moves the one body that was grabbed, and leaves the others alone', () => {
    // THE COMPLAINT THIS ANSWERS IN ITS TURN: "they all move together". Every
    // body is a part of its own in the payload, so a grab reaches one node —
    // which is what makes a proposal something you assemble by shifting its
    // pieces against each other rather than one block you slide about.
    const { c, el } = mounted({ proposal: withBore() })

    fire('korpus', [3, 0, -1.5])

    expect(places(c)).toEqual([[3, 0, -1.5], [5, 0, 0]])
    // And the body on the model is staged out of the document that says so —
    // the group the drag moved was live feedback and nothing more.
    expect(overlay(el)).toEqual(['korpus', 'bore'])
  })

  it('moves the one hole when the hole is what was grabbed', () => {
    const { c } = mounted({ proposal: withBore() })

    fire('bore', [0, 2, 0])

    expect(places(c)).toEqual([[0, 0, 0], [5, 2, 0]])
  })

  it('shows the new numbers in the fields the reader types in', () => {
    // THE TWO WAYS OF SAYING IT ARE ONE THING. A drag that moved the body
    // without moving the fields would leave the panel describing a place the
    // body is not in — and the projection the agent reads is rendered off those
    // same numbers.
    const { c } = mounted({ proposal: withBore() })

    fire('korpus', [3, 0, -1.5])

    expect(atFields(c)).toEqual(['3', '0', '-1.5'])
    expect(atFields(c, 1)).toEqual(['5', '0', '0'])
    expect(proposalText(c.state.proposal)).toContain('at (3, 0, -1.5)')
  })

  it('keeps the numbers readable, drag after drag', () => {
    // `42.3 + 0.1` is `42.400000000000006` in binary floating point, and the
    // field is the reader's own: a body placed by hand and then nudged would
    // come back with fifteen digits nobody typed. The snap step can be a tenth
    // or a hundredth (`niceStep` in viewport/tools.js), so the rounding has to
    // keep the digits that are real and drop only these.
    const { c } = mounted({
      proposal: addNode(emptyProposal(), { ...BLOCK, at: [42.3, 0, 0] }),
    })

    fire('korpus', [0.1, 0, 0])
    expect(atFields(c)).toEqual(['42.4', '0', '0'])

    // AND EACH DRAG STARTS FROM WHERE THE LAST ONE LEFT IT, because the document
    // is where the body's place lives: the viewport reports a delta and carries
    // none of them, so two drags of the same distance go twice as far.
    fire('korpus', [0.1, 0, 0])
    expect(atFields(c)).toEqual(['42.5', '0', '0'])
  })

  it('drops a field the reader was in the middle of typing in', () => {
    // THE FIRST DOOR INTO `setProposal` THAT A DRAFT CAN SURVIVE. A field renders
    // from `proposalDraft` while one stands on its key, and every other door is a
    // button — a real click blurs the field and commits it on the way in. A drag
    // does not: the press is taken in the capture phase, so the focus never
    // leaves. Left standing, the panel would show typed text over a body that
    // has already moved, and the blur that came later would commit that text
    // back over the axis the drag had just written.
    const { c } = mounted({ proposal: withBore() })
    const x = () => c.computed().proposalBodies[0].groups[1].fields[0]
    x().onChange({ target: { value: '9' } })
    expect(c.state.proposalDraft).toEqual({ key: 'n1.at.0', text: '9' })

    fire('korpus', [3, 0, 0])

    expect(c.state.proposalDraft).toBeNull()
    expect(atFields(c)).toEqual(['3', '0', '0'])
  })

  it('raises no chip, and leaves the one about a part of the build alone', () => {
    // A proposal body is in no build, so there is nothing for `moved` to file it
    // against and nothing for `__resetMove` to put back — the panel standing
    // open is what says the body is not part of the model. A chip standing about
    // a part of the BUILD is a different statement and is not disturbed.
    const { c } = mounted({ proposal: withBore() })
    c.setState({ moved: { id: '/model/plate', name: 'plate', mag: 3 } })

    fire('korpus', [3, 0, 0])

    expect(c.state.moved).toEqual({ id: '/model/plate', name: 'plate', mag: 3 })
    expect(places(c)[0]).toEqual([3, 0, 0])
  })

  it('moves nothing at all when no body answers to the name', () => {
    // A drag that landed after the body it grabbed was deleted from the panel.
    // Nothing is guessed at: the document is left exactly as it is, and the next
    // stage puts the scene back in agreement with it.
    const { c, el } = mounted({ proposal: withBore() })
    const staged = el.setOverlay.mock.calls.length

    fire('motor', [3, 0, 0])

    expect(places(c)).toEqual([[0, 0, 0], [5, 0, 0]])
    expect(el.setOverlay).toHaveBeenCalledTimes(staged)
  })
})

// -- the doors the bodies are not for -----------------------------------------

describe('a proposal body as the part a task is filed against', () => {
  // The bodies are staged INTO the scene (`staged()` in viewport/element.js), so
  // each is an ordinary row in the tree and an ordinary pick target — which puts
  // them in front of every door that files a task about a PART. Each would write
  // it in the BUILD's terms against a body that is in no build, no catalogue and
  // no revision: `partId: "/model/proposal/korpus"` names nothing the agent can
  // look up. This is the class `toolsOff` exists for, read off the other source
  // of parts.
  //
  // THE MEASUREMENT IS NOT ONE OF THEM: a distance between two faces of a
  // proposal body is what the panel is for, and the number goes to the agent
  // unchanged. Only the part it would be filed against is refused.
  //
  // THE MOVE TOOL IS NOT ONE OF THEM AT ALL, and it is the one that reads as
  // though it should be. A drag of one is not a task filed badly: it is a
  // DIFFERENT GESTURE, told apart at the press by the viewport and ending in
  // `hmr:proposalmove`, which edits the panel's own document — the describe above
  // is where that lands, and ui/tests/tools.test.js is where the press decides.
  //
  // WHICH PATHS ARE THE OVERLAY'S IS THE VIEWPORT'S ANSWER, because that is
  // where the group's name is minted — `proposal`, or `proposal2` beside a model
  // that publishes a group of that name. The spy says so for the paths spelled
  // here; the real answer is element.test.js's subject, like everything else
  // this file asks of the viewport.
  //
  // THE GROUP NODE ANSWERS YES TOO, exactly as the real one does: it is a row of
  // the tree, a row is selected with the mouse, and `selectedPaths()` sends a
  // node's own id.
  const staging = (el) => el.isOverlay.mockImplementation(
    (id) => typeof id === 'string'
      && (id === '/model/proposal' || id.startsWith('/model/proposal/')))

  const fire = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }))

  // The tree as it stands with a body staged in: the model's own part beside the
  // body under the overlay's group. That body carries NO `key` — the catalogue
  // identity a comment outlives a rebuild by — because `part()` in proposalgeom.js
  // mints none for a body that is in no catalogue.
  const STAGED = {
    id: '/model',
    name: 'model',
    children: [
      { id: '/model/plate', name: 'plate', key: 'plate', known: true },
      {
        id: '/model/proposal',
        name: 'proposal',
        children: [{ id: '/model/proposal/korpus', name: 'korpus', known: true }],
      },
    ],
  }

  /** The page with a measurement standing and one path selected. */
  function measured(sel, selName) {
    const { c, el } = panel({ proposal: withBlock() })
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
    const { c, el } = mounted({ proposal: withBlock() })
    staging(el)

    fire(PLACE, { id: '/model/proposal/korpus', name: 'korpus', p: [1, 2, 3] })

    expect(c.state.composer).toBeNull()

    fire(PLACE, { id: '/model/plate', name: 'plate', p: [1, 2, 3] })

    expect(c.state.composer).toMatchObject({ part: 'plate', partId: '/model/plate' })
  })

  it('sends a measurement taken on it with no part named at all', () => {
    // The reader clicked the body to look at it — which is what `sel` holds,
    // since `onPick` writes any path picked — measured a distance on it and
    // pressed `add to comment`. The number travels; the attribution does not.
    const c = measured('/model/proposal/korpus', 'korpus')

    c.computed().measAdd()

    expect(c.state.composer.meas).toBe('12.00 mm')
    expect(c.state.composer.part).toBeFalsy()
    expect(c.state.composer.partId).toBeNull()
    expect(c.state.composer.key).toBeNull()
  })

  it('sends no part for the GROUP the bodies hang under either', () => {
    // The row over them all, selected from the tree — `proposal` is no more a part
    // of the build than `korpus` is, and `/model/proposal` resolves in it no
    // better.
    const c = measured('/model/proposal', 'proposal')

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
    // `DIMS` in proposal.js says how an op spells its size to the agent, `SHAPES`
    // in proposalgeom.js builds its geometry, and `SIZES` in the panel draws its
    // fields. THREE COMMENTS SAID SO AND NOTHING CHECKED IT: an op added to two
    // of them builds, draws, and passes every other test in this directory —
    // and then throws at `add to comment`, which is the one door nothing else
    // covers, in a React handler, where the reader sees nothing happen.
    //
    // `proposalOps` IS `SIZES`'s KEY LIST, read off the table rather than written
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
      c.computed().proposalOps[index].onClick()

      expect(c.state.proposalError).toBeNull()
      expect(c.computed().proposalBodies[0].groups[0].fields.length)
        .toBeGreaterThan(0)
      expect(proposalText(c.state.proposal)).toContain(`solid  ${op}`)
    }
  })
})

// -- what a re-stage does NOT do ----------------------------------------------

describe('the model event a re-stage sends back', () => {
  // The scene the viewport composed out of the document it already had, with
  // the proposal's body in it. It arrives on the same event a rebuild does, and
  // the difference is the flag.
  const TREE = {
    id: '/model',
    name: 'model',
    children: [
      { id: '/model/plate', name: 'plate', key: 'plate', known: true },
      {
        id: '/model/proposal',
        name: 'proposal',
        children: [{ id: '/model/proposal/result', name: 'result', known: true }],
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
    const { c } = panel({ proposal: withBlock() })
    c.state = {
      ...c.state,
      measure: { text: '2.4 mm' },
      moved: { text: 'plate by 3 mm' },
    }

    c.onModel({ tree: TREE, view: 'assembled', live: true, restage: true })

    expect(c.state.measure).toEqual({ text: '2.4 mm' })
    expect(c.state.moved).toEqual({ text: 'plate by 3 mm' })
    // The tree still lands: it is what the proposal's own rows arrive in.
    expect([...c.state.tree.nodes.keys()]).toContain('/model/proposal/result')
  })

  it('still drops both when the model itself was replaced', () => {
    // The default, and the reason the flag had to be added rather than the
    // clearing simply removed: on a rebuild every part goes back where the model
    // puts it and the faces a distance was measured between may be gone.
    const { c } = panel({ proposal: withBlock() })
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
  it('leaves the proposal and its attachment alone', () => {
    // Everything `leaveBuild` clears is a coordinate this page took off geometry
    // that has left: which solid was picked, where in space, a measurement
    // between two faces, a part dragged out of the assembly. A proposal is none of
    // those — it is the reader's own claim about a motor or a wall, and it is as
    // true of the revision arriving as of the one leaving.
    const { c } = panel({ proposal: withBlock() })
    c.computed().proposalAdd()

    const { state } = c.leaveBuild(true)

    expect('proposal' in state).toBe(false)
    expect('proposalOpen' in state).toBe(false)
    expect(state.composer.proposal).toBe(proposalText(c.state.proposal))
    // ...while the fields that DID describe the build that left are emptied.
    expect(state.composer.part).toBe('')
    expect(state.composer.meas).toBeNull()
  })
})
