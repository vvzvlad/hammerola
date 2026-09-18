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
import { MOVED, PLACE, PROPOSALMOVE } from '../src/events.js'
import { indexTree } from '../src/hub.js'
import {
  addNode, DIM_OPS, dropMoves, emptyProposal, moves, proposalText, removeNode,
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

/**
 * A part of the BUILD dragged in the scene, exactly as the viewport reports one:
 * every path that moved, the solid's own name, the offset from where the build
 * puts it, and the build it was measured on.
 *
 * `build` IS THE FIXTURE'S OWN KEY and is on every one of these because it is on
 * every real report: the viewport stamps the press with the key the interface
 * handed it, and the handler drops a report whose stamp is not the build now on
 * screen. A helper that left it off would be testing the drop and nothing else.
 *
 * Reaches the page's real listener, so `mounted()` is what a caller needs — the
 * handler this lands in is the one `componentDidMount` built.
 */
const drag = (path, delta, over = {}) => window.dispatchEvent(
  new CustomEvent(MOVED, {
    detail: {
      id: path, name: path.split('/').filter(Boolean).pop(), paths: [path],
      count: 1, build: REV, delta, ...over,
    },
  }))

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
    setOverlay: vi.fn(), clearOverlay: vi.fn(), setMoves: vi.fn(),
    isOverlay: vi.fn(() => false),
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
    feed: [], activePin: null, composer: null, sending: false,
    measure: null, toast: null,
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

/** The moves the viewport was last handed, in the shape the door takes them. */
const pushed = (el) => el.setMoves.mock.calls.at(-1)[0]

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
    // The gate Move carries and Measure does not: everything the proposal
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

    // AND THE MOVE ROW GOES WITH IT, which is not a second feature being taken
    // away but the same one: a displacement is a NODE of the proposal, so where
    // there is no proposal there is nowhere for one to be. Left offered, the
    // tool would arm, the part would follow the hand, and the release would
    // reach a page with no row saying the part is out of place, no `×` to put it
    // back and no projection to send it in — ui-brief block 6 unanswered in all
    // three of its parts, with the part standing displaced until the next
    // rebuild.
    //
    // A REAL LEAF ROW UNDER THE MENU, and the same menu on a hub that DID ask,
    // because every other reason the row can be absent — no row at all, a group,
    // no token, a narrow window — reads identically from here. Without the pair
    // this would pass on a page whose tree simply has nothing in it.
    // The flag is read where the answer is spent (`proposalPanelOn`) rather than
    // held in state, so it is stamped either side of the pair rather than at the
    // fixtures: whichever component is asked LAST would otherwise decide for
    // both, and the order these two lines are written in is not a thing the next
    // reader should have to notice.
    const menu = { id: '/model/plate', x: 10, y: 10 }
    const tree = indexTree({ id: '/model', name: 'model', children: [
      { id: '/model/plate', name: 'plate', key: 'plate' }] })
    c.state = { ...c.state, tree, menu }

    stampProposal(false)
    expect(c.computed().menuItems.map((m) => m.label)).not.toContain('Move')
    stampProposal(true)
    expect(c.computed().menuItems.map((m) => m.label)).toContain('Move')
    stampProposal(false)

    // What the flag does NOT take away: everything that was never the
    // proposal's. Measure is the one next door in the toolbar and files its
    // answer through the composer, which this hub still serves.
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
    // The panel is HIDDEN WITHOUT A TOKEN, like Move, because everything it
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

  it('is not held off a name a MOVE happens to carry', () => {
    // The two names are in different namespaces: a body's is its part's name in
    // the payload this panel builds, a move's is a row of the BUILD's, which the
    // reader never chose and cannot edit. Counted together, dragging a part
    // called `plate` in the scene would rename the reader's own `plate` to
    // `plate2` under their hands — for a collision that is about nothing.
    const { c } = mounted({ proposal: withBlock() })
    drag('/model/motor', [3, 0, 0])

    type(c.computed().proposalBodies[0].name, 'motor')

    expect(c.state.proposal.nodes[0].name).toBe('motor')
    expect(moves(c.state.proposal)[0].name).toBe('motor')
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

  it('records no move of its own, and leaves a move of the BUILD alone', () => {
    // A proposal body is in no build, so there is no path to record it under and
    // nothing to put back — the panel standing open is what says the body is not
    // part of the model, and the body's own `at` is where it went. A part of the
    // BUILD dragged is a node of this same document and a different statement,
    // and it is not disturbed by a body moving beside it.
    const { c } = mounted({ proposal: withBore() })
    drag('/model/plate', [3, 0, 0])
    const recorded = moves(c.state.proposal)
    expect(recorded).toHaveLength(1)

    fire('korpus', [3, 0, 0])

    expect(moves(c.state.proposal)).toEqual(recorded)
    expect(places(c)[0]).toEqual([3, 0, 0])
  })

  it('moves the body and not a move node that answers to the same name', () => {
    // A MOVE CARRIES A NAME TOO — a row of the build's, which the reader never
    // chose — and this gesture finds the body it grabbed BY NAME. Run together,
    // the drag would reach a node that has no `at` at all.
    const { c } = mounted({ proposal: withBlock() })
    drag('/model/korpus', [9, 0, 0])

    fire('korpus', [3, 0, 0])

    expect(places(c)[0]).toEqual([3, 0, 0])
    expect(moves(c.state.proposal)[0].delta).toEqual([9, 0, 0])
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

// -- a part of the BUILD moved with the same hand ------------------------------

describe('a part of the build dragged in the scene', () => {
  // THE SAME GESTURE ON THE OTHER SOURCE OF PARTS, and the opposite meaning: a
  // body of the proposal is the reader's own drawing and its `at` is edited,
  // while a part of the build belongs to the model and is not touched at all —
  // what is recorded is that it should BE somewhere else. Both end in this one
  // document, so both travel to the agent in one projection, and putting the
  // part back is deleting the entry rather than pressing anything.
  //
  // WHERE THE OTHER HALF IS TESTED: that the offsets actually land on the
  // scene's groups is ui/tests/parts.test.js, and that the door reaches them is
  // ui/tests/element.test.js. What is HERE is what the document records and what
  // it hands over.

  it('records the drag beside the bodies, and prints it in the projection', () => {
    const { c } = mounted({ proposal: withBlock() })

    drag('/model/plate', [3.2, 0, -1])

    expect(moves(c.state.proposal)).toEqual([{
      id: 'm2', role: 'move', paths: ['/model/plate'], name: 'plate',
      delta: [3.2, 0, -1],
      // A DRAG SAYS NOTHING ABOUT WHICH WAY ROUND, so the node it mints starts
      // at no turn and the row's own fields are where that changes.
      turn: [0, 0, 0],
    }])
    expect(proposalText(c.state.proposal))
      .toContain('move "plate" by (3.2, 0, -1)')
  })

  it('carries every path the gesture moved, not just the one it named', () => {
    // A row standing for five copies of a part moves all five, and the viewport
    // reports the first of them as `id` while `paths` is the lot. Recorded off
    // `id` alone, the other four would be displaced with nothing claiming them —
    // and the very next push of this document would send them home.
    const { c, el } = mounted({ proposal: withBlock() })
    const row = ['/model/pin', '/model/pin(2)', '/model/pin(3)']

    drag('/model/pin', [3, 0, 0], { paths: row, count: 3 })

    expect(moves(c.state.proposal)[0].paths).toEqual(row)
    expect(pushed(el)).toEqual([{ paths: row, delta: [3, 0, 0], turn: [0, 0, 0] }])
  })

  it('writes the number the viewport sent, and does not round it again', () => {
    // WHERE THE ROUNDING IS, said here because it used to be here. A drag is
    // snapped to a 1-2-5 step and `Math.round(v / step) * step` lands on numbers
    // like `0.6000000000000001`, which nobody dragged anything to — so `snap` in
    // viewport/tools.js rounds its own arithmetic by the document's rule
    // (`tidy`) and the delta arrives already at a place somebody could have
    // typed. That is pinned where it happens, in ui/tests/tools.test.js.
    //
    // WHAT IS PINNED HERE is that this side adds nothing: the number in the node
    // is the number on the wire, and the row and the projection print that one.
    // A second rounding would be two places having to agree about a value
    // neither of them computed.
    const { c } = mounted({})

    drag('/model/plate', [0.6, 0, 0])

    expect(moves(c.state.proposal)[0].delta).toEqual([0.6, 0, 0])
    expect(proposalText(c.state.proposal)).toContain('by (0.6, 0, 0)')
    expect(c.computed().proposalMoveRows[0].groups[0].fields.map((f) => f.value))
      .toEqual(['0.6', '0', '0'])
  })

  it('replaces the move of the same grab rather than adding it up', () => {
    // The delta the viewport reports is CUMULATIVE from where the build puts the
    // part: each press starts from the offset already standing, so the second
    // drag describes the whole displacement again. Added, the part would end up
    // twice as far out as the scene has it.
    const { c } = mounted({ proposal: withBlock() })

    drag('/model/plate', [3, 0, 0])
    drag('/model/plate', [5, 0, 0])

    expect(moves(c.state.proposal)).toHaveLength(1)
    expect(moves(c.state.proposal)[0].delta).toEqual([5, 0, 0])
  })

  it('replaces the move that shares a path, whatever the gesture came in as', () => {
    // THE SEQUENCE THAT MADE THIS NECESSARY, and every step of it is ordinary:
    // Move is armed from a collapsed row's menu, so the selection is all three
    // copies; a press on empty space degrades to a pick and CLEARS the
    // selection while the tool stays armed; the next drag therefore takes the
    // one copy it hit — arriving under that copy's own path — and the pick it
    // emits puts the whole row back under the hand, so the drag after it arrives
    // under the row's first path. Matched on the first path, those two gestures
    // wrote two nodes both claiming `pin(3)`: two contradictory `move` lines in
    // the projection, and two rows of which one `×` looked broken.
    const { c, el } = mounted({})
    const row = ['/model/pin', '/model/pin(2)', '/model/pin(3)']

    drag('/model/pin(3)', [3, 0, 0])
    drag('/model/pin', [5, 0, 0], { paths: row, count: 3 })

    expect(moves(c.state.proposal)).toHaveLength(1)
    expect(moves(c.state.proposal)[0].paths).toEqual(row)
    expect(moves(c.state.proposal)[0].delta).toEqual([5, 0, 0])
    expect(pushed(el)).toEqual([{ paths: row, delta: [5, 0, 0], turn: [0, 0, 0] }])
  })

  it('drops every move the new gesture touches, where more than one does', () => {
    // Two copies dragged apart one at a time, and then the row that holds both:
    // one gesture has superseded whatever either node said about them, and
    // keeping either would leave the document claiming an offset the scene does
    // not have.
    const { c, el } = mounted({})
    const row = ['/model/pin', '/model/pin(2)', '/model/pin(3)']

    drag('/model/pin', [3, 0, 0])
    drag('/model/pin(2)', [0, 3, 0])
    expect(moves(c.state.proposal)).toHaveLength(2)

    drag('/model/pin', [5, 0, 0], { paths: row, count: 3 })

    expect(moves(c.state.proposal)).toHaveLength(1)
    expect(moves(c.state.proposal)[0].paths).toEqual(row)
    expect(pushed(el)).toEqual([{ paths: row, delta: [5, 0, 0], turn: [0, 0, 0] }])
  })

  it('subtracts the grabbed copy and leaves the rest of the row displaced', () => {
    // A ROW MOVED, THEN ONE COPY OUT OF IT NUDGED FURTHER. Three copies at +3
    // and then one dragged to +8 means two are at +3 and one is at +8 — the
    // second gesture says nothing whatever about the other two. Dropping the
    // node they were in would send them home on the very next push: two moves
    // the reader made, undone by a nudge of a third, with two parts jumping
    // across the scene for no reason shown anywhere.
    const { c, el } = mounted({})
    const row = ['/model/pin', '/model/pin(2)', '/model/pin(3)']

    drag('/model/pin', [3, 0, 0], { paths: row, count: 3 })
    drag('/model/pin(2)', [8, 0, 0])

    expect(moves(c.state.proposal).map((m) => [m.paths, m.delta])).toEqual([
      [['/model/pin', '/model/pin(3)'], [3, 0, 0]],
      [['/model/pin(2)'], [8, 0, 0]],
    ])
    // AND THE VIEWPORT IS TOLD ALL OF IT, which is where "still displaced"
    // stops being a claim about a document and becomes one about the scene.
    expect(pushed(el)).toEqual([
      { paths: ['/model/pin', '/model/pin(3)'], delta: [3, 0, 0], turn: [0, 0, 0] },
      { paths: ['/model/pin(2)'], delta: [8, 0, 0], turn: [0, 0, 0] },
    ])
  })

  it('carries the turn the superseded nodes agree on into the minted one', () => {
    // SEVERAL NODES COVERED AT ONCE is the reader having moved these copies
    // apart one at a time, and the commonest way to have several is to have
    // TURNED them together — a fresh node minted at zero would straighten every
    // one of them on a gesture that was about where they stand.
    const { c, el } = mounted({})
    const row = ['/model/pin', '/model/pin(2)', '/model/pin(3)']
    drag('/model/pin', [3, 0, 0])
    drag('/model/pin(2)', [0, 3, 0])
    for (const at of [0, 1]) {
      type(c.computed().proposalMoveRows[at].groups[1].fields[2], '90')
    }

    drag('/model/pin', [5, 0, 0], { paths: row, count: 3 })

    expect(moves(c.state.proposal)).toHaveLength(1)
    expect(moves(c.state.proposal)[0].turn).toEqual([0, 0, 90])
    expect(pushed(el)).toEqual([{ paths: row, delta: [5, 0, 0], turn: [0, 0, 90] }])
  })

  it('mints at no turn where the superseded nodes do not agree on one', () => {
    // THE OTHER BRANCH, and zero is the honest answer for it: two copies turned
    // different ways have no single turn to carry onto the one sentence that
    // now speaks for both, and picking either would be this handler choosing
    // which of the reader's two statements to keep.
    const { c } = mounted({})
    const row = ['/model/pin', '/model/pin(2)', '/model/pin(3)']
    drag('/model/pin', [3, 0, 0])
    drag('/model/pin(2)', [0, 3, 0])
    type(c.computed().proposalMoveRows[0].groups[1].fields[2], '90')
    type(c.computed().proposalMoveRows[1].groups[1].fields[2], '45')

    drag('/model/pin', [5, 0, 0], { paths: row, count: 3 })

    expect(moves(c.state.proposal)).toHaveLength(1)
    expect(moves(c.state.proposal)[0].turn).toEqual([0, 0, 0])
  })

  it('turns a copy nobody turned, when one gesture merges it with one that is', () => {
    // THE OTHER FACE OF "A DRAG CANNOT STRAIGHTEN ANYTHING", and it is held
    // here rather than in prose because prose does not fail. One node carries
    // one turn for ALL its paths, so a gesture that merges a turned copy with
    // an untouched one has nowhere to keep the difference and something has to
    // give. It gives this way round: the untouched copy comes out turned.
    //
    // THE BRANCH THIS GOES THROUGH IS THE EXPANDING ONE, not the minting one —
    // the turned node is covered whole, so its sentence is corrected rather
    // than replaced, and it gains the second path while keeping the turn the
    // patch never names. So this does not pin `shared`, which the two tests
    // above do; what it catches is someone deciding that widening a node's
    // paths should straighten what it already said.
    const { c } = mounted({})
    drag('/model/pin', [3, 0, 0])
    type(c.computed().proposalMoveRows[0].groups[1].fields[2], '90')

    drag('/model/pin', [6, 0, 0], { paths: ['/model/pin', '/model/pin(2)'], count: 2 })

    expect(moves(c.state.proposal).map((m) => [m.paths, m.turn])).toEqual([
      [['/model/pin', '/model/pin(2)'], [0, 0, 90]],
    ])
  })

  it('leaves no empty sentence when a row of disagreeing turns is dragged home', () => {
    // A row whose copies were turned to DIFFERENT angles cannot be carried by
    // one node, so dragging it home straightens them — that is the price of the
    // disagreement and it is decided. What must not survive is a node saying
    // nothing: `move "pin ×2" by (0, 0, 0)` with no turn on it is a line for the
    // agent to puzzle over and a row to close by hand, and the panel does not
    // even open on a flat drag to show it.
    //
    // The retraction therefore asks what the node would COME OUT carrying,
    // which is `shared`, and not whether any turn exists anywhere.
    const { c } = mounted({})
    drag('/model/pin', [3, 0, 0])
    type(c.computed().proposalMoveRows[0].groups[1].fields[2], '90')
    drag('/model/pin(2)', [5, 0, 0])
    type(c.computed().proposalMoveRows[1].groups[1].fields[2], '45')

    drag('/model/pin', [0, 0, 0], { paths: ['/model/pin', '/model/pin(2)'], count: 2 })

    expect(moves(c.state.proposal)).toEqual([])
  })

  it('sends a copy out of a turned row still facing the way the row faced', () => {
    // A DRAG SAYS WHERE AND NEVER WHICH WAY, and this is the case that says it
    // about a node nothing supersedes. The old node is still standing and still
    // claims the two copies left behind, so reading the turn off the COVERED
    // nodes alone would find none to carry and straighten the one copy the
    // reader has hold of — a rotation undone by a gesture that was about
    // position. `touching` is what closes it.
    //
    // THE TRIMMING TOUCHES THE PATHS AND THE NAME AND NOTHING ELSE, so the two
    // left behind keep the offset they were already at and their turn. Both
    // halves of the row therefore come out of this facing the same way, which
    // is what the reader did to them and all they did to them.
    const { c } = mounted({})
    const row = ['/model/pin', '/model/pin(2)', '/model/pin(3)']
    drag('/model/pin', [3, 0, 0], { paths: row, count: 3 })
    type(c.computed().proposalMoveRows[0].groups[1].fields[0], '30')

    drag('/model/pin(2)', [8, 0, 0])

    expect(moves(c.state.proposal).map((m) => [m.paths, m.turn])).toEqual([
      [['/model/pin', '/model/pin(3)'], [30, 0, 0]],
      [['/model/pin(2)'], [30, 0, 0]],
    ])
  })

  it('pushes the document that was COMMITTED, not the one it computed', () => {
    // WHAT A COMPLETION CALLBACK IS FOR. The handler writes its document in a
    // functional updater, and the updater's own result is what this edit WOULD
    // have committed — not necessarily what did. React batches, so another
    // functional patch can be applied behind it before the callback runs, and
    // the one that matters is `onModel`'s `dropMoves`: a build landing while the
    // report is in flight. Pushing the updater's result at `setMoves` after that
    // displaces a part of the NEW build by a node the committed document no
    // longer holds — no row, no `×`, and nothing staging after it to correct the
    // scene.
    //
    // THE BATCH IS STAGED BY HAND because this harness commits synchronously and
    // React does not: the second updater below is what the real one interleaves
    // on its own, and without it there is no arrangement in which the two
    // documents differ.
    const { c, el } = mounted({ proposal: withBlock() })
    const commit = c.setState
    c.setState = vi.fn((patch, done) => {
      commit(patch)
      commit((s) => ({ proposal: dropMoves(s.proposal || emptyProposal()) }))
      if (done) done()
    })

    drag('/model/plate', [3, 0, 0])

    expect(moves(c.state.proposal)).toEqual([])
    expect(pushed(el)).toEqual([])
  })

  it('hands the viewport the whole set, so the drag it echoes is a no-op', () => {
    // The document is pushed straight back at the viewport the part was just
    // dragged in, and that push must leave it exactly where the hand left it:
    // the entry says the offset the drag already applied.
    const { c, el } = mounted({ proposal: withBlock() })

    drag('/model/plate', [3, 0, 0])

    expect(pushed(el))
      .toEqual([{ paths: ['/model/plate'], delta: [3, 0, 0], turn: [0, 0, 0] }])
    expect(moves(c.state.proposal)[0].delta).toEqual([3, 0, 0])
  })

  it('sends the part home by having its entry deleted', () => {
    // WHAT PUTTING IT BACK IS, now that there is no button for it: the node goes
    // and the viewport is told what is left, which for the last one is nothing
    // at all.
    const { c, el } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])

    c.setProposal(removeNode(c.state.proposal, moves(c.state.proposal)[0].id))

    expect(moves(c.state.proposal)).toEqual([])
    expect(pushed(el)).toEqual([])
    // The bodies are untouched by any of it: a move draws nothing.
    expect(overlay(el)).toEqual(['korpus'])
  })

  it('takes the entry away when the part is dragged back where it belongs', () => {
    // A ZERO IS A RETRACTION, not a move of nothing. The viewport reports a
    // delta of (0, 0, 0) only when something WAS standing displaced, so this is
    // the reader putting the part back by hand — the plainest way anybody says
    // "never mind". Written down as a node it would be a `move "plate" by
    // (0, 0, 0)` line in the projection for an agent to puzzle over and a row in
    // the panel to be closed by a second gesture.
    const { c, el } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])
    expect(moves(c.state.proposal)).toHaveLength(1)

    drag('/model/plate', [0, 0, 0])

    expect(moves(c.state.proposal)).toEqual([])
    expect(proposalText(c.state.proposal)).not.toContain('move "plate"')
    // And the viewport hears the whole set, which for the last one is nothing:
    // that push is what forgets the path and puts `measure.js` back to
    // describing an assembly nothing is displaced in.
    expect(pushed(el)).toEqual([])
  })

  it('keeps a TURNED node when the part is dragged back, and zeroes the delta', () => {
    // A TRANSLATION GESTURE EDITS THE TRANSLATION. The hand was on the part's
    // position, so "put it back where it was" is an answer about WHERE — and a
    // node that also says which way the part faces has not been retracted by
    // it. Dropped anyway, the drag would take a rotation the reader set in the
    // panel and never mentioned, with nothing on screen saying why.
    //
    // WHAT IS LEFT IS THE SENTENCE WITH ITS DELTA AT NOTHING: the part is back
    // where the build puts it and still turned, the row still says so, and the
    // `×` is still how the whole statement is undone.
    const { c, el } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])
    type(c.computed().proposalMoveRows[0].groups[1].fields[2], '90')

    drag('/model/plate', [0, 0, 0])

    expect(moves(c.state.proposal)).toHaveLength(1)
    expect(moves(c.state.proposal)[0].delta).toEqual([0, 0, 0])
    expect(moves(c.state.proposal)[0].turn).toEqual([0, 0, 90])
    expect(c.computed().proposalMoveRows).toHaveLength(1)
    expect(proposalText(c.state.proposal))
      .toContain('move "plate" by (0, 0, 0) turned (0, 0, 90)')
    // AND THE SCENE IS TOLD THE SAME THING, so the part really does stand at
    // home still turned rather than the document alone claiming it.
    expect(pushed(el)).toEqual([
      { paths: ['/model/plate'], delta: [0, 0, 0], turn: [0, 0, 90] },
    ])
  })

  it('still drops a node dragged home when it says nothing but the offset', () => {
    // The rule above narrowed and not replaced: with no turn on it, a drag home
    // is the plain retraction it always was.
    const { c, el } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])

    drag('/model/plate', [0, 0, 0])

    expect(moves(c.state.proposal)).toEqual([])
    expect(pushed(el)).toEqual([])
  })

  it('takes only the copies the retraction names out of a row\'s entry', () => {
    // The same subtraction the other direction: a row of three at one offset,
    // one copy dragged home. That copy loses its claim and the other two keep
    // theirs, so the node shrinks and is renamed rather than being dropped.
    const { c, el } = mounted({})
    const row = ['/model/pin', '/model/pin(2)', '/model/pin(3)']
    drag('/model/pin', [3, 0, 0], { paths: row, count: 3 })

    drag('/model/pin(2)', [0, 0, 0])

    expect(moves(c.state.proposal).map((m) => m.paths))
      .toEqual([['/model/pin', '/model/pin(3)']])
    expect(pushed(el)).toEqual([
      { paths: ['/model/pin', '/model/pin(3)'], delta: [3, 0, 0], turn: [0, 0, 0] },
    ])
  })

  it('leaves the panel shut for a retraction, having nothing to show', () => {
    // The panel comes up to SHOW a displacement and the row that undoes it. A
    // drag home is the undoing, so opening the panel to announce it would be
    // answering "never mind" with a demand to look.
    const { c } = mounted({ proposal: withBlock(), open: false })
    drag('/model/plate', [3, 0, 0])
    c.setState({ proposalOpen: false })

    drag('/model/plate', [0, 0, 0])

    expect(c.state.proposalOpen).toBe(false)
    expect(moves(c.state.proposal)).toEqual([])
  })

  it('touches the bodies over the model not at all, panel already open', () => {
    // A move changes no body, so the bodies standing over the model are already
    // the ones a rebuild would produce — and while the panel is open it writes
    // the document and pushes the offsets, leaving the geometry neither rebuilt
    // nor re-staged. What that buys is the measurement at `field` in `computed`:
    // rebuilding them here would cost 23 ms at four bodies and 81 ms at twelve,
    // spent on nothing.
    const { c, el } = mounted({ proposal: withBlock() })
    el.setOverlay.mockClear()
    el.clearOverlay.mockClear()

    drag('/model/plate', [3, 0, 0])

    expect(moves(c.state.proposal)).toHaveLength(1)
    expect(el.setOverlay).not.toHaveBeenCalled()
    expect(el.clearOverlay).not.toHaveBeenCalled()
    expect(pushed(el))
      .toEqual([{ paths: ['/model/plate'], delta: [3, 0, 0], turn: [0, 0, 0] }])
  })

  it('opens the panel it was recorded in, if the reader had it shut', () => {
    // UI-BRIEF BLOCK 6: a displaced part has to be visibly displaced, visibly
    // temporary, and have a way back. The way back is the row's `×` and the row
    // is in the panel — and the Move tool is armed from a part's own menu, with
    // no panel needed — so a drag with it shut would otherwise leave the model
    // quietly out of shape with nothing on screen saying so.
    const { c, el } = mounted({ proposal: withBlock(), open: false })

    drag('/model/plate', [3, 0, 0])

    expect(c.state.proposalOpen).toBe(true)
    expect(c.computed().proposalMoveRows).toHaveLength(1)
    expect(css(c.computed().proposalPanelStyle).display).toBe('block')
    // AND THE BODIES GO BACK OVER THE MODEL WITH IT, because that is what an
    // open panel means — closing it is what took them off (`toggleProposal`),
    // and a panel listing bodies the model does not show is the same
    // disagreement read the other way.
    expect(overlay(el)).toEqual(['korpus'])
    expect(pushed(el))
      .toEqual([{ paths: ['/model/plate'], delta: [3, 0, 0], turn: [0, 0, 0] }])
  })

  it('records nothing while the scene on screen is a comparison\'s', () => {
    // `toolsOff`: the paths of a comparison's scene are `/cmp/…`, which name a
    // part no revision has — a displacement of one, in a document the agent
    // reads as a statement about this build.
    const { c } = mounted({ proposal: withBlock() })
    c.setState({ compare: true, cmpPair: ['a', 'b'], cmpView: 'assembled',
                 cmpStage: 'ready' })

    drag('/cmp/added/plate', [3, 0, 0])

    expect(moves(c.state.proposal)).toEqual([])
  })

  it('records nothing for a delta that is not three finite numbers', () => {
    const { c } = mounted({ proposal: withBlock() })

    drag('/model/plate', [3, NaN, 0])
    drag('/model/plate', [3, 0])

    expect(moves(c.state.proposal)).toEqual([])
  })
})

// -- and the row it gets in the panel -----------------------------------------

describe('the row a move is drawn as', () => {
  // WHY THERE HAS TO BE ONE AT ALL: a dragged part goes home by having its entry
  // DELETED, and a row nobody can see is an entry nobody can delete. It is in the
  // same list as the bodies because it is the same kind of statement — the
  // reader's own words for it were "you have new parts in that tree, just add
  // `shift of an existing part` to it".

  /** The rows the panel draws for the moves, as `computed()` hands them over. */
  const rows = (c) => c.computed().proposalMoveRows

  it('shows the part, and its numbers in fields a body would know', () => {
    const { c } = mounted({ proposal: withBlock() })

    drag('/model/plate', [3.2, 0, -1], { count: 3, name: 'plate' })

    expect(rows(c)).toHaveLength(1)
    // The name the node was recorded under, count and all: what the row says and
    // what the projection prints are the same string, resolved once at the drag.
    // IT IS STILL NOT A FIELD — it is a row of the build's, and the reader never
    // chose it.
    expect(rows(c)[0].name).toBe('plate ×3')
    // TWO ROWS OF THREE, exactly as a body's `at` and `rot°` are drawn, because
    // they are the same kind of number: the offset the drag left, and a turn
    // that has no gesture at all and could not be said any other way.
    expect(rows(c)[0].groups.map((g) => g.label)).toEqual(['by', 'turn°'])
    expect(rows(c)[0].groups.map((g) => g.fields.map((f) => f.value)))
      .toEqual([['3.2', '0', '-1'], ['0', '0', '0']])
    // AND THE ARROWS ARE THE PLATFORM'S OWN, stepped in the units of the row:
    // millimetres for the offset, and the body's own `STEP_DEG` for the turn.
    expect(rows(c)[0].groups.map((g) => g.fields[0].type)).toEqual(['number', 'number'])
    expect(rows(c)[0].groups[0].fields[0].step)
      .toBe(c.computed().proposalBodies[0].groups[1].fields[0].step)
    expect(rows(c)[0].groups[1].fields[0].step)
      .toBe(c.computed().proposalBodies[0].groups[2].fields[0].step)
    expect(proposalText(c.state.proposal)).toContain('by (3.2, 0, -1)')
  })

  it('types a turn into the document, and pushes it at the viewport', () => {
    // THE ONLY DOOR THERE IS FOR ONE: the drag says where, and three numbers in
    // this row say which way round. What leaves the page is the node — the
    // projection prints it, and the scene is handed the same three degrees.
    const { c, el } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])

    type(rows(c)[0].groups[1].fields[2], '90')

    expect(moves(c.state.proposal)[0].turn).toEqual([0, 0, 90])
    expect(pushed(el)).toEqual([
      { paths: ['/model/plate'], delta: [3, 0, 0], turn: [0, 0, 90] },
    ])
    expect(proposalText(c.state.proposal))
      .toContain('move "plate" by (3, 0, 0) turned (0, 0, 90)')
  })

  it('types an offset into the same row, which is the drag said exactly', () => {
    const { c, el } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])

    type(rows(c)[0].groups[0].fields[2], '12')

    expect(moves(c.state.proposal)[0].delta).toEqual([3, 0, 12])
    expect(pushed(el)).toEqual([
      { paths: ['/model/plate'], delta: [3, 0, 12], turn: [0, 0, 0] },
    ])
  })

  it('is drawn on the page, in the list the bodies are in and after them', () => {
    // `computed()` answering with a row is not the same as the page drawing one
    // — the lesson eltree.js is written around — and a row nobody draws is a
    // part that cannot be put back.
    const { c } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])

    const said = texts(c.render())
    expect(said).toContain('turn°')
    expect(said).toContain('plate')
    // AFTER THE BODIES AND BEFORE THE BUTTONS THAT ADD ONE, which is what puts
    // it in the same list rather than in a section of its own.
    expect(said.indexOf('turn°')).toBeGreaterThan(said.indexOf('rot°'))
    expect(said.indexOf('turn°')).toBeLessThan(said.indexOf('+ box'))
  })

  it('leaves the bodies their own rows, and takes none of them', () => {
    const { c } = mounted({ proposal: withBlock() })

    drag('/model/plate', [3, 0, 0])

    expect(c.computed().proposalBodies.map((b) => b.name.value)).toEqual(['korpus'])
  })

  it('puts the part back when the row is closed', () => {
    // THE WHOLE FEATURE, END TO END: the `×` deletes the node, the document is
    // pushed back at the viewport without that path in it, and the reconcile on
    // the other side is what walks `vp.moved` and sends the part home
    // (ui/tests/parts.test.js holds that half).
    const { c, el } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])
    expect(pushed(el))
      .toEqual([{ paths: ['/model/plate'], delta: [3, 0, 0], turn: [0, 0, 0] }])

    rows(c)[0].onRemove()

    expect(rows(c)).toEqual([])
    expect(pushed(el)).toEqual([])
    // The body beside it is untouched, and so is the overlay it is staged as.
    expect(c.computed().proposalBodies).toHaveLength(1)
    expect(overlay(el)).toEqual(['korpus'])
  })

  it('leaves the other moves alone when one of them is closed', () => {
    const { c, el } = mounted({})
    drag('/model/plate', [3, 0, 0])
    drag('/model/lid', [0, 4, 0])

    rows(c)[0].onRemove()

    expect(rows(c).map((row) => row.name)).toEqual(['lid'])
    expect(pushed(el))
      .toEqual([{ paths: ['/model/lid'], delta: [0, 4, 0], turn: [0, 0, 0] }])
  })
})

// -- a proposal that is nothing but moves -------------------------------------

describe('a document holding moves and no bodies', () => {
  // It is not an empty document: a part the reader dragged is a statement to the
  // agent on its own, and the panel has to treat it as one — there is something
  // to send, and nothing to explain.

  it('draws its rows and offers the projection', () => {
    const { c } = mounted({})

    drag('/model/plate', [3, 0, 0])

    expect(c.computed().proposalBodies).toEqual([])
    expect(c.computed().proposalMoveRows).toHaveLength(1)
    expect(css(c.computed().proposalAddStyle).display).not.toBe('none')
    expect(texts(c.render())).toContain('turn°')
  })

  it('stops explaining what a body is, because something has been put in it', () => {
    const { c } = mounted({})
    expect(css(c.computed().proposalEmptyStyle).display).toBe('block')

    drag('/model/plate', [3, 0, 0])

    expect(css(c.computed().proposalEmptyStyle).display).toBe('none')
  })

  it('sends the projection with the move in it and no bodies at all', () => {
    const { c } = mounted({})
    drag('/model/plate', [3, 0, 0])

    c.computed().proposalAdd()

    expect(c.state.composer.proposal).toBe(proposalText(c.state.proposal))
    expect(c.state.composer.proposal).toContain('move "plate" by (3, 0, 0)')
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
  // THE MOVE GESTURE IS NOT ONE OF THEM AT ALL, and it is the one that reads as
  // though it should be. A drag of one is not a task filed badly: it is a
  // DIFFERENT GESTURE, told apart at the press by the viewport and ending in
  // `hmr:proposalmove`, which edits the panel's own document — the describe above
  // is where that lands, and ui/tests/tools.test.js is where the press decides.
  // Its ROW IS OFFERED for that very reason: a body needs the same armed tool a
  // part does, the row is the only door onto it now, and the row sets a
  // selection — so withholding it would arm the tool holding something else and
  // freeze the bodies. Only the SENTENCE the row raises differs, because the two
  // moves mean different things. Both are asserted at the end of this describe.
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

  it('is offered a Move row of its own, since without it a body costs a click first', () => {
    // THIS ROW IS THE ONLY DOOR ONTO THE TOOL, now that the toolbar has no
    // button, and a body needs the tool exactly as a part does — `onDown`
    // returns on no tool at all. The selection the row sets is what makes its
    // absence cost something: an armed tool drags what is SELECTED, and a press
    // outside a standing selection is refused whole (tools.test.js, 'moves
    // nothing when the grab lands on a part outside the selection'). So a menu
    // offering Move on the build's parts and withholding it from the bodies
    // would arm the tool holding a PART every time, and the first grab on a body
    // would be refused — recoverable with a separate click, which selects it,
    // but not by trying to drag again, which only orbits.
    const labelsOn = (id) => {
      const { c, el } = panel({ proposal: withBlock() })
      staging(el)
      c.state = { ...c.state, tree: indexTree(STAGED), menu: { id, x: 0, y: 0 } }
      return c.computed().menuItems.map((m) => m.label)
    }

    expect(labelsOn('/model/proposal/korpus')).toContain('Move')
    expect(labelsOn('/model/plate')).toContain('Move')
    // THE GROUP THE BODIES HANG UNDER IS STILL REFUSED, but for the reason every
    // group is and not for being the proposal's: a group's selection is the
    // node's own path, which no press can hit. Here it would be worse than
    // elsewhere — `overlayBody` answers null for that node, so even a press that
    // missed the model would move nothing at all.
    expect(labelsOn('/model/proposal')).not.toContain('Move')
  })

  it('is offered NO Turn row, because it has a rot° row of its own', () => {
    // THE ONE ROW OF THE TWO THAT A BODY MUST NOT HAVE. Move is offered because
    // the DRAG is re-routed at the press — the viewport tells the two gestures
    // apart and sends a body's on `hmr:proposalmove`, which edits the `at`
    // beside that very `rot` — and there is no such routing for a row that
    // MINTS A NODE. Turn on a body would put a move node on an overlay path: a
    // second way to turn the same body, contradicting the fields three rows up
    // the same panel, and printing `move "korpus" turned (…)` about a body that
    // is in no build for the agent to read beside its own `rot (…)`.
    const labelsOn = (id) => {
      const { c, el } = panel({ proposal: withBlock() })
      staging(el)
      c.state = { ...c.state, tree: indexTree(STAGED), menu: { id, x: 0, y: 0 } }
      return c.computed().menuItems.map((m) => m.label)
    }

    expect(labelsOn('/model/proposal/korpus')).toContain('Move')
    expect(labelsOn('/model/proposal/korpus')).not.toContain('Turn')
    // AND THE BUILD'S OWN PARTS KEEP BOTH, so what is withheld is the body's
    // case and not the row.
    expect(labelsOn('/model/plate')).toEqual(
      expect.arrayContaining(['Move', 'Turn']))
  })

  it('is told apart from a build part by the sentence the row raises', () => {
    // The two drags MEAN different things and the toast is where the reader is
    // told which one they are in. A part of the build moves as a statement to
    // the agent and snaps back on the next rebuild; a body moves as an edit of
    // the panel's document and stays where it is put. A single sentence would be
    // false on one of them.
    const armOn = (id) => {
      const { c, el } = panel({ proposal: withBlock() })
      staging(el)
      c.state = { ...c.state, tree: indexTree(STAGED), menu: { id, x: 0, y: 0 } }
      c.computed().menuItems.find((m) => m.label === 'Move')
        .onClick({ stopPropagation() {}, preventDefault() {} })
      return { c, said: c.toast.mock.calls.map(([text]) => text).join('') }
    }

    const body = armOn('/model/proposal/korpus')
    expect(body.said).toContain('proposal')
    expect(body.said).not.toContain('snaps back')
    // And the selection is the body itself, which is what the drag needs.
    expect(body.c.state.sel).toBe('/model/proposal/korpus')
    expect(body.c.state.tool).toBe('move')

    expect(armOn('/model/plate').said).toContain('snaps back')
  })
})

// -- the row that makes a move where no drag has been --------------------------

describe('Turn, in a part\'s own menu', () => {
  // A DISPLACEMENT HAS A GESTURE AND A TURN HAS NONE. The hand says "about here"
  // better than a field does, and there is no such hand for three angles — so a
  // part nobody has dragged has no row in the panel, and therefore nowhere to
  // type them. This row is what makes the row exist.

  const STAGED = {
    id: '/model',
    name: 'model',
    children: [
      { id: '/model/plate', name: 'plate', key: 'plate', known: true },
      { id: '/model/pin', name: 'pin', key: 'pin', known: true },
      { id: '/model/pin(2)', name: 'pin', key: 'pin', known: true },
      {
        id: '/model/housing',
        name: 'housing',
        children: [{ id: '/model/housing/lid', name: 'lid', key: 'lid', known: true }],
      },
    ],
  }

  /** The page with a row's menu open on `id`. */
  function menu(id, over = {}) {
    const { c, el } = panel({ proposal: withBlock(), ...over })
    c.state = { ...c.state, tree: indexTree(STAGED), menu: { id, x: 0, y: 0 } }
    return { c, el }
  }

  const labels = (c) => c.computed().menuItems.map((m) => m.label)

  const choose = (c, label) => c.computed().menuItems.find((m) => m.label === label)
    .onClick({ stopPropagation() {}, preventDefault() {} })

  it('stands beside Move, under exactly the same four gates', () => {
    // THE SAME NODE OF THE SAME DOCUMENT comes out of both rows, so the four
    // answers that take Move away take this away with it: a reader with no token
    // has nowhere to send it, a phone has no room to aim, a group is a path no
    // press can hit, and a hub that serves no panel has nowhere to draw the row.
    expect(labels(menu('/model/plate').c)).toContain('Turn')
    expect(labels(menu('/model/plate', { token: null }).c)).not.toContain('Turn')
    expect(labels(menu('/model/plate', { narrow: true }).c)).not.toContain('Turn')
    expect(labels(menu('/model/housing').c)).not.toContain('Turn')
    expect(labels(menu('/model/plate', { served: false }).c)).not.toContain('Turn')
    // And the two rows are gated together rather than each on its own reading of
    // the same four questions.
    for (const over of [{ token: null }, { narrow: true }, { served: false }]) {
      const said = labels(menu('/model/plate', over).c)
      expect(said.includes('Turn')).toBe(said.includes('Move'))
    }
  })

  it('mints a row at no offset and no turn, and opens the panel on it', () => {
    const { c, el } = menu('/model/plate', { open: false })

    choose(c, 'Turn')

    expect(moves(c.state.proposal)).toEqual([{
      id: 'm2', role: 'move', paths: ['/model/plate'], name: 'plate',
      delta: [0, 0, 0], turn: [0, 0, 0],
    }])
    // THE PANEL COMES UP WITH IT, because a row nobody can see is a row nobody
    // can type in — which is the whole of what this item is for.
    expect(c.state.proposalOpen).toBe(true)
    expect(c.computed().proposalMoveRows).toHaveLength(1)
    expect(c.computed().proposalMoveRows[0].groups.map((g) => g.label))
      .toEqual(['by', 'turn°'])
    // AND THE VIEWPORT IS TOLD, so the scene and the document agree from the
    // first moment the row exists — at nothing, which is where the part already
    // stands.
    expect(pushed(el))
      .toEqual([{ paths: ['/model/plate'], delta: [0, 0, 0], turn: [0, 0, 0] }])
  })

  it('takes every copy a collapsed row stands for, and its counted name', () => {
    // The same paths Hide and Isolate take, because it is the same object: a row
    // reading `pin ×2` is two solids, and turning one of them alone would be the
    // row quietly meaning something else here than it does everywhere else.
    const { c } = menu('/model/pin')

    choose(c, 'Turn')

    expect(moves(c.state.proposal)[0].paths).toEqual(['/model/pin', '/model/pin(2)'])
    expect(moves(c.state.proposal)[0].name).toBe('pin ×2')
  })

  it('survives the reconcile that follows, which drops nothing it did not', () => {
    // THE RULE THIS IS NOT. A node is dropped when a DRAG is reported at zero —
    // the reader putting a displacement back by hand — and a node minted here is
    // a row asked for rather than a statement withdrawn, so nothing looks at its
    // zeroes. Pushing the document is what would have shown otherwise: the
    // viewport is handed the node, and the document still holds it afterwards.
    const { c, el } = menu('/model/plate')

    choose(c, 'Turn')
    c.proposalMoves(c.state.proposal)

    expect(moves(c.state.proposal)).toHaveLength(1)
    expect(pushed(el))
      .toEqual([{ paths: ['/model/plate'], delta: [0, 0, 0], turn: [0, 0, 0] }])
    // And it is still there to be typed into after the row has been redrawn.
    expect(c.computed().proposalMoveRows).toHaveLength(1)
  })

  it('types a turn into the row it just made', () => {
    const { c, el } = menu('/model/plate')
    choose(c, 'Turn')

    const row = c.computed().proposalMoveRows[0]
    type(row.groups[1].fields[1], '45')

    expect(moves(c.state.proposal)[0].turn).toEqual([0, 45, 0])
    expect(pushed(el))
      .toEqual([{ paths: ['/model/plate'], delta: [0, 0, 0], turn: [0, 45, 0] }])
    expect(proposalText(c.state.proposal))
      .toContain('move "plate" by (0, 0, 0) turned (0, 45, 0)')
  })

  it('gives a part that already has a row no second one', () => {
    // Two nodes claiming one path are two contradictory sentences about it in the
    // projection and two rows of which only one `×` appears to do anything — the
    // hazard the drag handler matches by intersection to avoid. The row is
    // already there; all this has left to do is open the panel it is in.
    const { c } = mounted({ proposal: withBlock(), open: false })
    drag('/model/plate', [3, 0, 0])
    c.setState({ proposalOpen: false })
    c.state = { ...c.state, tree: indexTree(STAGED), menu: { id: '/model/plate', x: 0, y: 0 } }

    choose(c, 'Turn')

    expect(moves(c.state.proposal)).toHaveLength(1)
    expect(moves(c.state.proposal)[0].delta).toEqual([3, 0, 0])
    expect(c.state.proposalOpen).toBe(true)
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

  /** The document with a body in it and a part of the build dragged. */
  const withMove = () => addNode(withBlock(), {
    id: 'm2', role: 'move', paths: ['/model/plate'], name: 'plate',
    delta: [3, 0, 0], turn: [0, 0, 0],
  })

  it('leaves the measurement and the moved part exactly where they were', () => {
    // BLOCKS 6 AND 7, AND BLOCK 6 IS WHAT THIS FEATURE IS MODELLED ON. Both
    // describe the model, and a re-stage does not touch the model: it is the
    // same document with a body drawn over it. Dropped here, they went on the
    // keystroke that committed a number in a panel that has nothing to do with
    // either — and the viewport's own halves of them survive, so the page would
    // also have been disagreeing with the scene.
    const { c } = panel({ proposal: withMove() })
    c.state = { ...c.state, measure: { text: '2.4 mm' } }

    c.onModel({ tree: TREE, view: 'assembled', live: true, restage: true })

    expect(c.state.measure).toEqual({ text: '2.4 mm' })
    expect(moves(c.state.proposal)).toHaveLength(1)
    // The tree still lands: it is what the proposal's own rows arrive in.
    expect([...c.state.tree.nodes.keys()]).toContain('/model/proposal/result')
  })

  it('still drops both when the model itself was replaced', () => {
    // The default, and the reason the flag had to be added rather than the
    // clearing simply removed: on a rebuild every part goes back where the model
    // puts it — the viewport clears its own map on the way through — and the
    // faces a distance was measured between may be gone. A delta against a
    // build that has left describes nothing, so it goes with them.
    const { c } = panel({ proposal: withMove() })
    c.state = { ...c.state, measure: { text: '2.4 mm' } }

    c.onModel({ tree: TREE, view: 'assembled', live: true })

    expect(c.state.measure).toBeNull()
    expect(moves(c.state.proposal)).toEqual([])
  })

  it('refuses a report measured on the build that has just left', async () => {
    // THE ORDER THIS HAPPENS IN, which is the whole bug. The viewport defers its
    // report by a microtask so it cannot be raised from inside a render, and
    // `show()` runs `endGesture` — which queues it — and then dispatches
    // `hmr:model` with no `await` between the two. So an ordinary live rebuild
    // landing mid-drag delivers the model event FIRST, `dropMoves` clears the
    // moves, and the report arrives afterwards holding paths and an offset
    // measured against an assembly that is no longer on screen. Taken, it would
    // displace a part of the NEW build by a number nobody measured against it —
    // and `proposalMoves` would push that straight at the scene.
    const { c } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])
    expect(moves(c.state.proposal)).toHaveLength(1)

    queueMicrotask(() => drag('/model/pin', [5, 0, 0]))
    c.setState({ meta: { ...c.state.meta, commit: `${REV.slice(0, 63)}f` } })
    c.onModel({ tree: TREE, view: 'assembled', live: true })
    await Promise.resolve()

    // NOT ONE AND NOT THE OLD ONE: the move the build that left carried is gone
    // with it, and the late report wrote nothing in its place.
    expect(moves(c.state.proposal)).toEqual([])
  })

  it('keeps the BODIES through that, because they are in no build', () => {
    // The other half of the same line, and the reason it is `dropMoves` rather
    // than a fresh document: a motor the model has to clear is as true of the
    // build arriving as of the one that left, and the reader typed it.
    const { c } = panel({ proposal: withMove() })

    c.onModel({ tree: TREE, view: 'assembled', live: true })

    expect(c.state.proposal.nodes.map((node) => node.name)).toEqual(['korpus'])
  })
})

// -- what a build swap does to it ---------------------------------------------

describe('another revision opening', () => {
  it('leaves the proposal and its attachment alone', () => {
    // Everything `leaveBuild` clears is a coordinate this page took off geometry
    // that has left: which solid was picked, where in space, a measurement
    // between two faces, a part dragged out of the assembly. A BODY is none of
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

  it('takes the moves out of an attachment already captured', () => {
    // THE ATTACHMENT IS TEXT, taken when `add to comment` was pressed, and a
    // move line in it is a delta measured against where THIS build put a part.
    // `dropMoves` takes those out of the document when the new build lands, and
    // an attachment left as captured would hand the agent exactly the sentences
    // the document has just stopped making.
    const { c } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])
    c.computed().proposalAdd()
    expect(c.state.composer.proposal).toContain('move "plate"')

    const { state } = c.leaveBuild(true)

    expect(state.composer.proposal).not.toContain('move "plate"')
    expect(state.composer.proposal).toContain('"korpus"')
    expect(state.composer.proposal)
      .toBe(proposalText(dropMoves(c.state.proposal)))
  })

  it('drops the attachment where the moves were all there was', () => {
    // A MOVE-ONLY PROPOSAL HAS NOTHING LEFT once the moves go, and what would
    // otherwise ride along is a `proposal` block with no statement in it — the
    // agent handed a heading and a `result =` line and asked to design against
    // them. `proposalAddStyle` refuses exactly that document at the front door,
    // so the swap must not post what the link would not have offered.
    const { c } = mounted({})
    drag('/model/plate', [3, 0, 0])
    c.computed().proposalAdd()
    expect(c.state.composer.proposal).toContain('move "plate"')

    const { state } = c.leaveBuild(true)

    expect(state.composer.proposal).toBeNull()
  })

  it('attaches nothing to a draft that had no projection on it', () => {
    const { c } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])
    c.setState({ composer: { part: 'plate', text: 'too thin' } })

    const { state } = c.leaveBuild(true)

    expect('proposal' in state.composer).toBe(false)
  })
})
