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

import HammerolaViewer, { PROPOSAL_BRANCH } from '../src/HammerolaViewer.jsx'
import {
  MOVED, PLACE, PROPOSALMOVE, PROPOSALTURN, TURNED,
} from '../src/events.js'
import { indexTree, PAGE } from '../src/hub.js'
import {
  addNode, DIM_OPS, dropMoves, emptyProposal, moves, proposalText, removeNode,
} from '../src/proposal.js'
import { SHAPE_OPS } from '../src/proposalgeom.js'
import { css } from '../src/style.jsx'
import { treeFromShapes } from '../src/viewport/parts.js'
import { makeComponent, replaceState } from './component.js'
import { collect, texts, titles } from './eltree.js'

const REV = 'e05f73ba91b263b8517147e338d23e868533c6a034a342ad5926abb6edcb7b40'
// WHICH BUILD THIS PAGE IS SHOWING, off its meta.json — the half of the answer
// that moves on the local slot, where `commit` is the constant `dev` for every
// build it ever holds (SPEC 7.6). A stored proposal carries the same stamp, and
// the two being equal is what says its move nodes still name the parts they were
// measured against.
const STAMP = '2026-09-18T18:00:00.123Z'
const ELSEWHERE = '2026-09-19T09:30:00.456Z'

// AND WHICH VIEW OF IT, which is the other half of the same answer and not a
// detail of it: a view is a separate tree of references with its own grouping
// (`src/cadbuild/views.py`), while `published` is IDENTICAL across the views of
// one build. So a move measured in `ANOTHER_VIEW` names a different part — or
// the same part in a different layout — on the view below, and the record
// carries both. `VIEW` is the one every fixture page here is showing.
const VIEW = 'assembled'
const ANOTHER_VIEW = 'exploded'

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

/**
 * The same part TURNED with the rings, exactly as the viewport reports one: the
 * same fields as a drag with three DEGREES where the offset was.
 *
 * TWO EVENTS AND ONE SENTENCE, which is what the pair of helpers is here to
 * make visible. The two gestures say opposite halves of one node — a drag says
 * where the part should be and nothing about which way it should face, a ring
 * the other way round — so the interface reads them through one method and the
 * difference between these two lines is the whole of the difference.
 */
const spin = (path, turn, over = {}) => window.dispatchEvent(
  new CustomEvent(TURNED, {
    detail: {
      id: path, name: path.split('/').filter(Boolean).pop(), paths: [path],
      count: 1, build: REV, turn, ...over,
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
                 served = true, stored = null, stands = false } = {}) {
  stampProposal(served)
  const el = {
    setOverlay: vi.fn(), clearOverlay: vi.fn(), setMoves: vi.fn(),
    // THE TWO QUESTIONS THIS PAGE ASKS THE ELEMENT BACK, and both are spies for
    // the reason the note above gives: what the viewport DOES with the parts,
    // these two answers included, is element.test.js's subject. `overlayBody`
    // is the one the selection rides on — it is how a rename finds the path it
    // has to move (`selectionAfter`) — so a fixture that left it off would be
    // testing the guard rather than the carry.
    isOverlay: vi.fn(() => false),
    overlayBody: vi.fn(() => null),
  }
  const c = makeComponent(HammerolaViewer, {
    // AS MANY BODIES AS THE DOCUMENT ALREADY HAS, because that is what the
    // counter means: every id in a real component's document was minted by it, so
    // a fixture that seeded nodes and left it at 0 would hand the next body an id
    // one of them already carries — a state the panel cannot reach, in which
    // `updateNode` edits two nodes at once.
    _proposalSeq: proposal ? proposal.nodes.length : 0,
    // A PAGE WHOSE BUILD IS ALREADY ON SCREEN, which is what the tree below and
    // the element above already say and what every test here but the cold loads
    // assumes. `adoptProposal` reads it: the moves of a stored document may only
    // be put back once the model event that would have dropped them has passed
    // (`onModel`), so the tests that are about a RELOAD clear this and hand the
    // page its build afterwards.
    _modelSeen: true,
    host: { current: el },
    sync: vi.fn(),
    toast: vi.fn(),
    setState: replaceState,
    state: {
      meta: {
        project: 'fixture', title: 'Fixture', commit: REV, published: STAMP,
        built: '', parts: {},
        views: [{ id: VIEW, name: VIEW, file: 'a.json',
                  parts: [], gzip: 1000 }],
      },
      view: VIEW,
      // THE DOCUMENT, which the shared default leaves out: a page that is about
      // none of this has none of it under every test in the file, and this is
      // the file that is about it.
      proposal: proposal || emptyProposal(), proposalOpen: open, proposalError: null,
      proposalDraft: null, proposalOff: false,
      // WHAT THE HUB SAID WHEN THE PAGE ASKED FOR THE STORED DOCUMENT, and `null`
      // is "it has not answered yet" — which is the state a page mounts in and
      // the one in which nothing may be written back. So a fixture that says
      // nothing else is a panel whose edits stay on this side, which is what
      // every test written before the document was stored anywhere assumes; the
      // ones that are ABOUT the save say `stored` for themselves.
      //
      // `proposalStands` IS THE OTHER HALF and is a different question — does what
      // the hub holds say anything, which is what a comment points the agent at.
      // It is false on a page that has not learned otherwise, and only the tests
      // about the announcement set it.
      proposalHeld: stored, proposalStands: stands,
      token,
      narrow,
    },
  })
  return { c, el }
}

/**
 * The same panel with the page's OWN listeners on the window, so a viewport
 * event reaches the handler `componentDidMount` built rather than one a test
 * called by hand. The helper, and the name, are repeats.test.js's.
 *
 * The three fetches the mount starts are stubbed: there is no hub here, and what
 * these tests are about begins after the page is listening.
 */
function mounted(over = {}) {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { c, el } = panel(over)
  c.load = vi.fn(async () => {})
  c.loadFeed = vi.fn(async () => {})
  c.loadProposal = vi.fn(async () => {})
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

/**
 * The proposal's own branch of the tree: EVERY node of the document as a row,
 * bodies and moves together and in the order the document holds them.
 *
 * WHERE THE PANEL'S TWO LISTS WENT. They were `proposalBodies` and
 * `proposalMoveRows` in the panel on the right, and the whole document is now
 * one branch below the parts tree — so the two helpers below are a FILTER over
 * the one list rather than two members of `computed()`. What each row is when it
 * is a body and when it is a move is what the describes below still ask.
 */
const rows = (c) => c.computed().proposalRows
const bodyRows = (c) => rows(c).filter((row) => !row.move)
const moveRows = (c) => rows(c).filter((row) => row.move)

/** One body's size fields, whatever op it is. */
const sizeFields = (c, index = 0) => bodyRows(c)[index].groups[0].fields

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

  it('leaves the model exactly as it was when it is closed, and keeps the document', () => {
    // CLOSING THE SHEET IS NOT TAKING THE PROPOSAL OFF THE MODEL, and it used to
    // be half of one: the bodies came off and every displaced part of the build
    // stayed displaced, with the branch that held its row hidden along with the
    // panel. A part standing where the model does not put it, nothing saying
    // why, and no `×` to press. The branch says what is on the model now, and
    // its eye is what takes it off — so the sheet is a sheet of controls.
    const { c, el } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])
    c.computed().proposalClose(click)

    expect(c.state.proposalOpen).toBe(false)
    expect(el.clearOverlay).not.toHaveBeenCalled()
    expect(c.state.proposal.nodes).toHaveLength(2)
    // The moves are still the viewport's, which is what the bodies staying is
    // the other half of.
    expect(pushed(el))
      .toEqual([{ paths: ['/model/plate'], delta: [3, 0, 0], turn: [0, 0, 0] }])

    c.computed().tProposal()
    expect(overlay(el)).toEqual(['korpus'])
  })

  it('draws the branch with the sheet shut, rows, × and all', () => {
    // THE HOLE THE LINE ABOVE LEFT. A move's row is the only place a displaced
    // part can be put back from, so a branch that went off screen with the panel
    // stranded it. The branch is drawn on the DOCUMENT alone now.
    const { c, el } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])
    c.computed().proposalClose(click)

    expect(c.state.proposalOpen).toBe(false)
    expect(css(c.computed().proposalTreeStyle).display).toBe('flex')
    expect(rows(c).map((row) => row.name)).toEqual(['korpus', 'plate'])
    expect(texts(c.render())).toContain('proposal')

    rows(c)[1].onRemove(click)

    expect(pushed(el)).toEqual([])
    expect(c.state.proposal.nodes).toHaveLength(1)
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

// -- the branch of the tree the whole document is drawn in ---------------------

describe('the proposal as a branch of the tree', () => {
  // WHERE THE DOCUMENT IS NOW. It used to be two lists inside the panel on the
  // right; it is a small tree of its own below the parts tree, and what was
  // asked for was "a separate proposal part of the tree with ALL the proposals
  // in it", which "is not part of a group — it is a root of the tree". So every
  // node is a row — bodies and moves alike, in document order — the fields open
  // under the row that is selected, and the panel keeps only what is ABOUT a
  // proposal rather than in one.

  /**
   * The tree as the viewport reports it WITH THE OVERLAY STAGED: the model's own
   * parts, and the proposal's group beside them holding one part per body.
   *
   * THE GROUP'S NAME IS THE VIEWPORT'S TO MINT, which is why `isOverlay` is
   * taught the same path rather than the page being left to match `proposal`
   * against a name: the page asks the element which of the root's children the
   * overlay is (`overlayAt` in viewport/element.js says why only it can answer),
   * and every fixture that wants a staged body has to answer as the real element
   * does.
   *
   * THE COLOURS ARE THE SCENE'S and are spelled out here for that reason: a row
   * shows whatever colour the part it resolves to was given, so the fixture has
   * to give the two kinds of part different ones for the assertion to mean
   * anything. The body's is the neutral grey proposalgeom.js paints a solid.
   */
  const sceneTree = (bodies, parts = ['plate'], root = '/model') => ({
    id: root,
    name: root.slice(1),
    children: [
      ...parts.map((name) => ({ id: `${root}/${name}`, name, color: '#4b5563' })),
      {
        id: `${root}/proposal`,
        name: 'proposal',
        children: bodies.map((name) => ({
          id: `${root}/proposal/${name}`, name, color: '#9aa3ad',
        })),
      },
    ],
  })

  /**
   * The element's two answers about that scene.
   *
   * `overlayBody` TRANSCRIBED rather than stubbed to a value: it is `isOverlay`
   * one segment further in, null for the group and null for anything deeper
   * (viewport/element.js), and the page reads it at moments this fixture cannot
   * enumerate ahead of time — a rename asks it about the selection as it stood
   * BEFORE the document changed.
   */
  const teach = (el, at) => {
    el.isOverlay.mockImplementation(
      (id) => id === at || String(id).startsWith(`${at}/`))
    el.overlayBody.mockImplementation((id) => {
      if (!String(id).startsWith(`${at}/`)) return null
      const name = String(id).slice(at.length + 1)
      return name && !name.includes('/') ? name : null
    })
  }

  const stage = (c, el, bodies, parts = ['plate'], root = '/model') => {
    const at = `${root}/proposal`
    c.state.tree = indexTree(sceneTree(bodies, parts, root))
    teach(el, at)
    return at
  }

  /**
   * The same scene ARRIVING, through the page's own `onModel`.
   *
   * `stage` puts a tree into state; this one delivers it the way the viewport
   * does, which is the only way to reach what the page does AT the moment a
   * stage lands. The element is taught first, because `onModel` asks it which
   * of the root's children the overlay is.
   *
   * THE ROOT IS A PARAMETER, exactly as `stage`'s is, because a comparison's
   * scene lands through this same door: `staged()` lays the overlay into
   * whatever payload is current, so a re-stage with a comparison up brings a
   * tree whose overlay is the comparison's. Hardwiring `/model` here made a test
   * that could only ever watch a build arrive, and a build arriving is the one
   * case where the carry is right.
   */
  const land = (c, el, bodies, parts = ['plate'], root = '/model') => {
    const at = `${root}/proposal`
    teach(el, at)
    c.onModel({ tree: sceneTree(bodies, parts, root), view: 'assembled',
                live: true, restage: true })
    return at
  }

  /** The names of the rows the PARTS tree draws, in draw order. */
  const treeRows = (c) => c.computed().rows.map((row) => row.name)

  it('draws every node of the document as a row, in the order it holds them', () => {
    // BODIES AND MOVES TOGETHER AND NOT TWO LISTS, because they are the same
    // kind of statement: this is what one place to look actually means.
    const { c } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])
    c.computed().proposalOps[0].onClick()

    expect(rows(c).map((row) => row.name)).toEqual(['korpus', 'plate', 'box3'])
    expect(rows(c).map((row) => row.move)).toEqual([false, true, false])
    expect(c.computed().proposalCount).toBe('3')
  })

  it('heads the branch with a row of its own, which folds it away', () => {
    // A ROOT ELEMENT OF THE TREE and not a group inside the model's, which is
    // the owner's other sentence: it is the interface's branch, built from the
    // document, and the caret is the same one a group of the parts tree has.
    const { c } = mounted({ proposal: withBlock() })

    expect(c.computed().proposalHeadName).toBe('proposal')
    expect(rows(c)).toHaveLength(1)
    const open = c.computed().proposalCaretPath

    c.computed().proposalToggle(click)

    expect(rows(c)).toEqual([])
    expect(c.computed().proposalCaretPath).not.toBe(open)
    // And the count stays: what is folded away is still in the document.
    expect(c.computed().proposalCount).toBe('1')

    c.computed().proposalToggle(click)
    expect(rows(c)).toHaveLength(1)
  })

  it('stays folded when the parts tree is expanded or collapsed whole', () => {
    // THE TWO BUTTONS ARE THE PARTS TREE'S — they sit in its own header and are
    // expressed over `tree.nodes`, which this branch is not in — and both
    // REBUILD the expansion map rather than patching it. A branch the reader
    // folded would otherwise spring open at a press meant for the tree below.
    const { c } = mounted({ proposal: withBlock() })
    c.computed().proposalToggle(click)
    expect(rows(c)).toEqual([])

    c.computed().collapseAll()
    expect(rows(c)).toEqual([])

    c.computed().expandAll()
    expect(rows(c)).toEqual([])
  })

  it('is gone from an empty document, and from nothing else', () => {
    // AN EMPTY DOCUMENT IS THE ONLY CONDITION LEFT: there is nothing to show and
    // the panel's own sentence is what explains it. The panel being SHUT is not
    // one — the branch is the only thing on screen that says what the proposal
    // has put on the model, and its eye is the only thing that takes it off, so
    // it cannot go away with a sheet of controls.
    expect(css(mounted({}).c.computed().proposalTreeStyle).display).toBe('none')
    expect(css(mounted({ proposal: withBlock(), open: false }).c
      .computed().proposalTreeStyle).display).toBe('flex')
    expect(css(mounted({ proposal: withBlock() }).c
      .computed().proposalTreeStyle).display).toBe('flex')
  })

  it('takes the overlay out of the parts tree, so no body is drawn twice', () => {
    // THE WHOLE POINT OF THE FILTER in `emit`. A body drawn in both branches is
    // one statement the reader can act on twice — two eyes, two `×`es, one of
    // them putting back what the other took away. The SCENE is untouched: the
    // group is still staged under the model's root, and the row here resolves
    // through exactly that path.
    const { c, el } = mounted({ proposal: withBlock() })
    stage(c, el, ['korpus'])
    c.state.expanded = { '/model': true }

    expect(treeRows(c)).toEqual(['model', 'plate'])
    expect(rows(c).map((row) => row.name)).toEqual(['korpus'])
  })

  it('takes it out of what the root above it counts and hides, too', () => {
    // THE SAME REMOVAL ONE STOREY UP. `indexTree` builds a group's `leaves` out
    // of every leaf underneath it and the overlay is staged as a child of the
    // model's root — so without this the root said `2` over one row, and its eye
    // reached into bodies the branch below has its own eye for. A count of rows
    // nobody can see is the overlay under the root after all, as a digit.
    const { c, el } = mounted({ proposal: withBlock() })
    stage(c, el, ['korpus'])
    c.state.expanded = { '/model': true }

    const root = () => c.computed().rows[0]
    expect(root().meta).toBe('1')

    root().onVis(click)

    expect(c.state.hidden).toEqual(['/model/plate'])
  })

  it('gives a body row the eye, the ghost square and the colour of the part', () => {
    // EVERYTHING THE SCENE GIVES IT, resolved through the staged path — the same
    // controls the part would have had in the tree it has just been taken out
    // of, so nothing was lost by moving it.
    const { c, el } = mounted({ proposal: withBlock() })
    const at = stage(c, el, ['korpus'])
    const row = () => rows(c)[0]

    expect(row().dotStyle).toContain('#9aa3ad')
    expect(css(row().marksStyle).visibility).toBeUndefined()

    row().onVis(click)
    expect(c.state.hidden).toEqual([`${at}/korpus`])
    row().onGhost(click)
    expect(c.state.ghost).toEqual([`${at}/korpus`])
    // And the name goes faint with the body, as a hidden row of the tree does.
    expect(row().nameStyle).toContain('var(--text-faint)')
  })

  it('selects the body in the scene, and opens its fields under the row', () => {
    const { c, el } = mounted({ proposal: withBlock() })
    const at = stage(c, el, ['korpus'])

    expect(css(rows(c)[0].fieldsStyle).display).toBe('none')

    rows(c)[0].onSelect(click)

    expect(c.state.sel).toBe(`${at}/korpus`)
    expect(css(rows(c)[0].fieldsStyle).display).toBe('block')
    // The block is the panel's old one, unchanged: the name, the op, the role
    // switch and the three groups of numbers.
    expect(rows(c)[0].nameField.value).toBe('korpus')
    expect(rows(c)[0].op).toBe('box')
    expect(rows(c)[0].role).toBe('solid')
    expect(rows(c)[0].groups.map((g) => g.label)).toEqual(['size', 'at', 'rot°'])
  })

  it('keeps the fields open on a body whose name was just typed', () => {
    // THE NAME IS IN THE PATH THE ROW IS SELECTED BY, so committing a new one
    // used to leave `sel` on a spelling nothing answers to: the row deselected
    // and the block the reader was typing in shut under them. Every other field
    // on that row commits and stays, and this one has to as well —
    // `selectionAfter` is what carries it.
    const { c, el } = mounted({ proposal: withBlock() })
    const at = stage(c, el, ['korpus'])
    rows(c)[0].onSelect(click)

    type(rows(c)[0].nameField, 'motor')

    // The selection moved with the name BEFORE the scene answered, which is the
    // half that has to hold on its own: the re-stage is asynchronous and the
    // tree lands behind it.
    expect(c.state.sel).toBe(`${at}/motor`)
    expect(c.state.selName).toBe('motor')

    // AND THE BLOCK IS OPEN THROUGHOUT THAT WINDOW, which is the half the
    // assertions above step over. The tree still holds `korpus`, so the row has
    // no scene row at all for the length of one re-stage — and if its identity
    // came from what the tree HOLDS rather than from the path its name wants,
    // the block would go `display:none` and the input the reader has just
    // pressed Enter in would lose the focus with it.
    expect(rows(c)[0].name).toBe('motor')
    expect(css(rows(c)[0].fieldsStyle).display).toBe('block')

    // And once the tree catches up, the row is still the selected one and its
    // block is still open — on the same node, under the new name.
    stage(c, el, ['motor'])
    expect(rows(c)[0].name).toBe('motor')
    expect(css(rows(c)[0].fieldsStyle).display).toBe('block')
  })

  it('keeps it open on a rename the re-stage never comes back from', () => {
    // A DOCUMENT THE KERNEL REFUSED is the case where that window never closes:
    // the last good overlay stays on screen, this body reaches no scene, and
    // nothing arrives to put the row back. `selectionAfter` finds no overlay
    // body under a name the scene never had, so `sel` stays the node's id — and
    // the row has to be selected by that.
    const { c, el } = mounted({ proposal: withBlock() })
    stage(c, el, [])
    rows(c)[0].onSelect(click)
    expect(c.state.sel).toBe('n1')

    type(rows(c)[0].nameField, 'motor')

    expect(c.state.proposal.nodes[0].name).toBe('motor')
    expect(c.state.sel).toBe('n1')
    expect(css(rows(c)[0].fieldsStyle).display).toBe('block')
  })

  it('refuses the id as a partId once the node it named is gone', () => {
    // THE CASE MEMBERSHIP GETS WRONG. A refused document repaired by the `×` on
    // the body that broke it leaves `sel` standing at a node the document no
    // longer holds — so asking whether the node is still THERE says "not a
    // proposal thing" about the one value that could only have come from one.
    // The shape is what answers: it does not begin with `/`, so it is not a path
    // and cannot be posted as one.
    const { c } = mounted({ proposal: withBlock() })
    rows(c)[0].onSelect(click)
    expect(c.state.sel).toBe('n1')

    rows(c)[0].onRemove(click)
    expect(c.state.proposal.nodes).toEqual([])

    c.setState({ measure: { full: '12.0 mm' } })
    c.computed().measAdd()

    expect(c.state.composer.partId).toBeNull()
    expect(c.state.composer.part).toBe('')
  })

  it('carries it onto the name freeName had to number, too', () => {
    // THE CASE A READER IS LEAST EXPECTING: the name they typed was taken, so
    // the document holds `korpus2` and not the `korpus` they pressed Enter on.
    // Resolved by NODE ID for exactly this — a comparison by name would find the
    // typed word missing and give up.
    const { c, el } = mounted({ proposal: withBlock() })
    c.computed().proposalOps[0].onClick()
    const at = stage(c, el, ['korpus', 'box2'])
    rows(c)[1].onSelect(click)
    expect(c.state.sel).toBe(`${at}/box2`)

    type(rows(c)[1].nameField, 'korpus')

    expect(c.state.proposal.nodes[1].name).toBe('korpus2')
    expect(c.state.sel).toBe(`${at}/korpus2`)
  })

  it('leaves the selection alone when it is not the renamed body', () => {
    // A number typed into one row must not move a selection standing on
    // another, and neither must a rename of a body nobody is looking at.
    const { c, el } = mounted({ proposal: withBlock() })
    c.computed().proposalOps[0].onClick()
    const at = stage(c, el, ['korpus', 'box2'])
    rows(c)[0].onSelect(click)

    type(rows(c)[1].nameField, 'motor')
    expect(c.state.sel).toBe(`${at}/korpus`)

    type(rows(c)[0].groups[1].fields[0], '12')
    expect(c.state.sel).toBe(`${at}/korpus`)
  })

  it('opens the fields of the row that is selected and of no other', () => {
    // A tree row is one line; a column of number panels over the model is the
    // tree covering the thing it describes.
    const { c, el } = mounted({ proposal: withBlock() })
    stage(c, el, ['korpus'])
    c.computed().proposalOps[1].onClick()
    stage(c, el, ['korpus', 'cylinder2'])

    rows(c)[1].onSelect(click)

    expect(rows(c).map((row) => css(row.fieldsStyle).display)).toEqual(['none', 'block'])
  })

  it('offers no eye, no ghost and no colour while a comparison is up', () => {
    // THE ONE CONTROL THIS BRANCH INHERITED THAT THE PARTS TREE NEVER HAD THERE,
    // because that tree is not drawn during a comparison at all and this one is.
    // `sync` sends `hidden: diffHidden(s.diffShow), ghost: []` while the scene
    // is a comparison's and never looks at `s.hidden`/`s.ghost` — which is why
    // `menuItems` throws Isolate, Hide and Translucent away under the same
    // question. Left standing, the eye went pale over a body still on screen,
    // and wrote a `/cmp/…` path — one that exists in no build — into `s.hidden`,
    // whence `setVisibility` carries it into the history and the swap's carry.
    const { c, el } = mounted({ proposal: withBlock() })
    stage(c, el, ['korpus'], ['plate'], '/cmp')
    c.setState({ compare: true, cmpPair: ['a', 'b'], cmpView: 'assembled',
                 cmpStage: 'ready' })

    expect(css(rows(c)[0].marksStyle).visibility).toBe('hidden')
    expect(rows(c)[0].dotStyle).toContain('transparent')

    rows(c)[0].onVis(click)
    rows(c)[0].onGhost(click)

    expect(c.state.hidden).toEqual([])
    expect(c.state.ghost).toEqual([])
  })

  it('still names, selects and edits its rows inside that comparison', () => {
    // WHAT THE SILENCE ABOVE MUST NOT TAKE WITH IT. A proposal is the reader's
    // own claim about a motor or a wall, which is as true over a comparison as
    // over a build — the panel was never taken out of service by one, and the
    // rows are the panel now.
    //
    // BUT IT SELECTS BY THE DOCUMENT'S OWN ID, NOT BY THE COMPARISON'S PATH.
    // `/cmp/<a>:<b>/…` names a part no revision has, and `sel` OUTLIVES the
    // comparison — `leaveCompare` does not clear it the way `leaveBuild` does —
    // so such a path left standing is what `measAdd` would post as the `partId`
    // of a comment measured after the panel closed. This branch is the only door
    // of its kind: `onPick` writes `cmpSel` under a comparison, the parts tree
    // is not drawn, and Move is not offered.
    const { c, el } = mounted({ proposal: withBlock() })
    stage(c, el, ['korpus'], ['plate'], '/cmp')
    c.setState({ compare: true, cmpPair: ['a', 'b'], cmpView: 'assembled',
                 cmpStage: 'ready' })

    expect(rows(c).map((row) => row.name)).toEqual(['korpus'])

    rows(c)[0].onSelect(click)
    expect(c.state.sel).toBe('n1')
    expect(css(rows(c)[0].fieldsStyle).display).toBe('block')

    type(rows(c)[0].groups[0].fields[0], '30')
    expect(c.state.proposal.nodes[0].size).toEqual([30, 20, 20])

    // AND THE MENU IS STILL OFFERED, which is why `onMenu` asks `scene` and not
    // `marks`: whether there is a scene object to open a menu ABOUT is a
    // different question from whether its visibility controls would work, and
    // `menuItems` already answers the second — everything that writes visibility
    // or names a file is gone under `compared`, and Copy name is what remains.
    rows(c)[0].onMenu({ ...click, clientX: 10, clientY: 10 })
    expect(c.computed().menuItems.map((m) => m.label)).toEqual(['Copy name'])
  })

  it('never lets a comparison\'s path out as the part a comment is about', () => {
    // THE WHOLE ROAD, END TO END, because every step of it is ordinary: open the
    // panel, compare two revisions, click a body row to read its numbers, change
    // one, close the comparison, measure two faces, `add to comment`. Nothing in
    // between clears `sel`.
    //
    // AND A SCENE LANDS TWICE ALONG IT, which is what a live page does and what
    // this test used to leave out entirely. `staged()` lays the overlay into
    // whatever payload is current, so while a comparison is up the group is
    // really there at a path of the COMPARISON's — and every commit re-stages,
    // so the model event that comes back carries that tree. The row asking
    // `compared` shuts one door onto this hole; the carry in `onModel` is the
    // other, and with no model event in between a test can only see the first.
    const { c, el } = mounted({ proposal: withBlock() })
    stage(c, el, ['korpus'], ['plate'], '/cmp')
    c.setState({ compare: true, cmpPair: ['a', 'b'], cmpView: 'assembled',
                 cmpStage: 'ready' })
    rows(c)[0].onSelect(click)
    expect(c.state.sel).toBe('n1')

    // A view tab switched while comparing: the same scene arrives again.
    land(c, el, ['korpus'], ['plate'], '/cmp')
    expect(c.state.sel).toBe('n1')

    // A number typed into the row that is open: the commit re-stages, and the
    // event that comes back is the one that moved `sel` onto the overlay.
    type(rows(c)[0].groups[0].fields[0], '30')
    land(c, el, ['korpus'], ['plate'], '/cmp')
    expect(c.state.sel).toBe('n1')
    expect(c.state.proposal.nodes[0].size).toEqual([30, 20, 20])
    // AND THE ROW IS STILL OPEN THROUGH ALL OF IT, so the fix is not bought by
    // deselecting the reader mid-edit: `selected` matches on the document id.
    expect(css(rows(c)[0].fieldsStyle).display).toBe('block')

    // The comparison closes; `sel` is whatever the road left there.
    c.setState({ compare: false, cmpPair: [], cmpView: null, cmpStage: null })
    expect(c.state.sel.startsWith('/cmp')).toBe(false)

    c.setState({ measure: { full: '12.0 mm' } })
    c.computed().measAdd()

    expect(c.state.composer.partId).toBeNull()
    expect(c.state.composer.part).toBe('')
  })

  it('keeps a row selected and open when its body is staged afterwards', () => {
    // THE ROW'S IDENTITY CHANGES UNDER THE READER otherwise, which is the rename
    // defect from the other side: `path` is the document's node id while the
    // scene has nothing and the scene's path once it does, so `s.sel` matched
    // neither and the block being typed in shut. The ordinary way in is the
    // staging window — the branch draws from `state.proposal` at once while
    // `show()` waits on the library, so every body row is sceneless for a moment
    // after `+ box` and after each opening of the panel.
    const { c, el } = mounted({ proposal: withBlock() })
    rows(c)[0].onSelect(click)
    expect(c.state.sel).toBe('n1')
    expect(css(rows(c)[0].fieldsStyle).display).toBe('block')

    const at = land(c, el, ['korpus'])

    // MOVED AND NOT MERELY ACCEPTED ALONGSIDE: `sel` is the page's one
    // selection and half a dozen readers take it for a path.
    expect(c.state.sel).toBe(`${at}/korpus`)
    expect(c.state.selName).toBe('korpus')
    expect(css(rows(c)[0].fieldsStyle).display).toBe('block')
  })

  it('leaves the id standing when the stage did not bring that body', () => {
    // A document the kernel refused keeps the LAST GOOD overlay, so the group is
    // on screen and this body is not. Moved onto a path the tree does not hold,
    // the row would break all over again from the other end.
    const { c, el } = mounted({ proposal: withBlock() })
    rows(c)[0].onSelect(click)

    land(c, el, [])

    expect(c.state.sel).toBe('n1')
    expect(css(rows(c)[0].fieldsStyle).display).toBe('block')
  })

  it('never files that id as the part a comment is about', () => {
    // `measAdd` forwards `sel` as `partId`, and a document id resolves in no
    // build — the exact class `proposalBody` refuses, in a spelling it cannot
    // recognise because it is not a path.
    const { c } = mounted({ proposal: withBlock() })
    c.setState({ measure: { full: '12.0 mm' } })
    rows(c)[0].onSelect(click)
    expect(c.state.sel).toBe('n1')

    c.computed().measAdd()

    expect(c.state.composer.partId).toBeNull()
    expect(c.state.composer.part).toBe('')
    expect(c.state.composer.meas).toBe('12.0 mm')
  })

  it('opens a row the scene cannot place, which is how a refusal is repaired', () => {
    // A DOCUMENT THE KERNEL REFUSED KEEPS THE LAST GOOD OVERLAY (`setProposal`),
    // so the body that broke it is in no scene and has no path. The fields are
    // the only way to fix the numbers, so the row still selects — on the
    // document's own node id, which names no part and selects nothing.
    const { c } = mounted({ proposal: withBlock() })

    rows(c)[0].onSelect(click)

    expect(c.state.sel).toBe('n1')
    expect(css(rows(c)[0].fieldsStyle).display).toBe('block')
  })

  it('gives a move row no eye, no ghost and no colour', () => {
    // A move draws NOTHING. It displaces a part the build already draws, and
    // that part keeps its own row, its own eye and its own colour in the tree
    // below — two eyes over one part would be two answers to one question.
    const { c, el } = mounted({})
    stage(c, el, [])
    drag('/model/plate', [3, 0, 0])

    expect(rows(c)[0].move).toBe(true)
    expect(css(rows(c)[0].marksStyle).visibility).toBe('hidden')
    expect(rows(c)[0].dotStyle).toContain('transparent')
    expect(rows(c)[0].nameField).toBeNull()
    expect(rows(c)[0].groups.map((g) => g.label)).toEqual(['by', 'turn°'])
  })

  it('says `move` before the name, so the row is not read as a body', () => {
    // WHAT THE ROW LOOKED LIKE WITHOUT IT: an indented name with three invisible
    // boxes in front of it, which is a body the reader drew and a part of the
    // build displaced drawn identically — the opposite claim about the same
    // model. The word and not a badge, in the order `proposalText` prints it
    // (`move "plate" by (…)`), so the row and the projection read alike.
    const { c } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])

    expect(rows(c).map((row) => row.kind)).toEqual([null, 'move'])
    // The name itself is untouched, count and all.
    expect(rows(c)[1].name).toBe('plate')

    const said = texts(c.render())
    expect(said).toContain('move')
    expect(said.indexOf('move')).toBeLessThan(said.lastIndexOf('plate'))
    // ONE ROW SAYS IT AND THE OTHER DOES NOT. `null` rather than `''` on a body,
    // because an empty string is a child React renders as nothing and every
    // reading of the tree still reports — a blank in a column of words.
    expect(said.filter((word) => word === 'move')).toHaveLength(1)
  })

  it('selects the part of the build a move row displaces', () => {
    // SO THE READER CAN SEE WHAT THE SENTENCE IS ABOUT. The row names a part of
    // the model; selecting it lights that part up, which is the only way to find
    // out which `plate` the sentence means.
    const { c, el } = mounted({})
    stage(c, el, [])
    drag('/model/plate', [3, 0, 0])

    rows(c)[0].onSelect(click)

    expect(c.state.sel).toBe('/model/plate')
    expect(c.state.selName).toBe('plate')
    expect(css(rows(c)[0].fieldsStyle).display).toBe('block')
  })

  it('puts the row\'s BARE name in selName, never the tally', () => {
    // A MOVE NODE'S NAME CARRIES THE COUNT — `pin ×3`, which is the string the
    // projection prints and a tally of parts rather than the name of one. That
    // is fine on the row; it is not fine in `selName`, which `measAdd` heads a
    // composer with when the tree cannot place the selection, and which that
    // method states both of its doors fill with a bare name.
    const { c, el } = mounted({})
    stage(c, el, [], ['plate'])
    drag('/model/plate', [3, 0, 0], { count: 3, name: 'plate' })
    expect(rows(c)[0].name).toBe('plate ×3')

    rows(c)[0].onSelect(click)

    expect(c.state.selName).toBe('plate')
  })

  it('gives a body row back the menu it had in the parts tree', () => {
    // WHAT THE MOVE COST AND THIS RETURNS. Isolate, Hide others and Move were
    // all reachable by right-clicking a staged body's row in the parts tree, and
    // taking that row out took them with it — the scene still has them on a
    // right-click of the body, but a reader who used the tree lost them with
    // nothing saying where they went. It resolves the SAME node the old row
    // was, so the menu that opens is the one `menuItems` already builds.
    const { c, el } = mounted({ proposal: withBlock() })
    const at = stage(c, el, ['korpus'])

    rows(c)[0].onMenu({ ...click, clientX: 40, clientY: 90 })

    expect(c.state.menu.id).toBe(`${at}/korpus`)
    const said = c.computed().menuItems.map((m) => m.label)
    expect(said).toContain('Isolate')
    expect(said).toContain('Move')
    // AND TURN BESIDE IT, which it did not have while that row minted a node
    // rather than arming a gesture — see the case further down, where the whole
    // of what changed is written out.
    expect(said).toContain('Turn')
  })

  it('gives a move row no menu at all', () => {
    // NOTHING IN THAT MENU APPLIES TO IT. Isolate and Hide others are about
    // geometry the node does not own, the Files are the catalogue's, and Move
    // and Turn would mint a second node over paths this one already claims.
    // What is left is a menu ABOUT THE BUILD PART, opened from a row that only
    // names it — the confusion the branch exists to avoid.
    const { c, el } = mounted({})
    stage(c, el, [])
    drag('/model/plate', [3, 0, 0])

    expect(rows(c)[0].onMenu).toBeNull()
  })

  it('gives no menu to a body the scene cannot place', () => {
    // `menuItems` is `[]` for a path no row answers to and `menuStyle` opens on
    // `s.menu` alone, so the gesture would put an empty box on the screen.
    const { c } = mounted({ proposal: withBlock() })

    expect(rows(c)[0].onMenu).toBeNull()
  })

  it('carries the × on both kinds of row', () => {
    const { c, el } = mounted({ proposal: withBlock() })
    stage(c, el, ['korpus'])
    drag('/model/plate', [3, 0, 0])
    expect(rows(c)).toHaveLength(2)

    rows(c)[1].onRemove(click)
    expect(rows(c).map((row) => row.name)).toEqual(['korpus'])
    rows(c)[0].onRemove(click)
    expect(rows(c)).toEqual([])
    expect(c.state.proposal.nodes).toEqual([])
  })

  // -- the branch's own eye: the whole proposal, on the model or off it -------

  it('takes every body and every displaced part off the model when its eye shuts', () => {
    // ONE CONTROL FOR BOTH HALVES, which is what "take the proposal off the
    // model" has to mean: the bodies stop being staged AND every part of the
    // build the document displaces goes back where the build puts it. Half of
    // it would be the defect the panel used to have, with the halves swapped.
    // The drag lands with the sheet shut, which is what stages the bodies as
    // well as recording the move — so both halves are genuinely on the model
    // before the eye is pressed.
    const { c, el } = mounted({ proposal: withBlock(), open: false })
    drag('/model/plate', [3, 0, 0])
    expect(overlay(el)).toEqual(['korpus'])
    expect(pushed(el))
      .toEqual([{ paths: ['/model/plate'], delta: [3, 0, 0], turn: [0, 0, 0] }])

    c.computed().proposalEyeClick(click)

    expect(c.state.proposalOff).toBe(true)
    expect(el.clearOverlay).toHaveBeenCalled()
    expect(pushed(el)).toEqual([])
  })

  it('puts all of it back the moment the eye opens again', () => {
    // IT IS DISPLAY STATE AND NOT AN EDIT, so there is nothing to undo: the
    // document is the same object it was, and the second press stages exactly
    // what the first took away.
    const { c, el } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])
    const before = c.state.proposal

    c.computed().proposalEyeClick(click)
    c.computed().proposalEyeClick(click)

    expect(c.state.proposalOff).toBe(false)
    expect(c.state.proposal).toEqual(before)
    expect(overlay(el)).toEqual(['korpus'])
    expect(pushed(el))
      .toEqual([{ paths: ['/model/plate'], delta: [3, 0, 0], turn: [0, 0, 0] }])
  })

  it('takes the bodies off even on a document the kernel refused', () => {
    // WHERE "LEAVE THE LAST GOOD BODY" AND "TAKE IT ALL AWAY" MEET, and the
    // second one wins because it was asked for out loud. A document that will
    // not build leaves the previous shape standing deliberately — a profile
    // being typed a point at a time must not blink the model away — and the eye
    // has no road to the scene except that same stage. So it went closed, the
    // displaced parts went home, and the bodies stayed: a control drawn off over
    // a thing that is still there.
    const { c, el } = panel({ proposal: withBlock() })
    c.computed().proposalOps[3].onClick()
    // An extrusion with two of its profile's points typed so far, which is no
    // polygon — the commonest way to reach a document that will not build.
    const drawn = bodyRows(c)
    type(drawn[drawn.length - 1].groups[0].fields[1], '0,0; 20,0')
    expect(c.state.proposalError).toMatch(/three or more points/)
    expect(el.clearOverlay).not.toHaveBeenCalled()

    c.computed().proposalEyeClick(click)

    expect(c.state.proposalOff).toBe(true)
    expect(el.clearOverlay).toHaveBeenCalled()
  })

  it('brings the sheet up to say a document would not build', () => {
    // WHERE THE VERDICT IS DRAWN AND WHERE THE FIELDS ARE ARE NOW TWO PLACES.
    // The numbers moved out into this branch and the branch outlives the sheet
    // being shut — which is the state the move was made for — while
    // `proposalSays` is still inside the sheet. So a reader typing a profile
    // with it closed got a refusal that changed nothing on the model and printed
    // nothing anywhere: the model does not blink, by design, and the sentence
    // explaining why was behind `display:none`.
    const { c } = panel({ proposal: withBlock(), open: false })
    c.computed().proposalOps[3].onClick()
    expect(c.state.proposalOpen, 'the premise: it is shut').toBe(false)

    const drawn = bodyRows(c)
    type(drawn[drawn.length - 1].groups[0].fields[1], '0,0; 20,0')

    expect(c.state.proposalError).toMatch(/three or more points/)
    expect(c.state.proposalOpen).toBe(true)
    expect(css(c.computed().proposalSaysStyle).display).toBe('block')
  })

  it('does not put that sheet in front of a reader with no token', () => {
    // A GATE STANDING RIGHT BESIDE THE NEW ONE. Giving up the token shuts the
    // sheet and takes away the button that reopens it — `tokenClear` calls a
    // sheet left standing there a defect in so many words — while the branch
    // outlives that door and every control in it comes back through
    // `stageProposal`. So a refused document plus one press of anything handed a
    // viewer a sheet of editing buttons with no way to put it away. The verdict
    // is for whoever can act on it.
    const { c } = panel({ proposal: withBlock(), token: null, open: false })
    c.computed().proposalOps[3].onClick()
    const drawn = bodyRows(c)
    type(drawn[drawn.length - 1].groups[0].fields[1], '0,0; 20,0')

    expect(c.state.proposalError, 'the premise: it really was refused')
      .toMatch(/three or more points/)
    expect(c.state.proposalOpen).toBe(false)
  })

  it('leaves a sheet the reader shut alone while the document builds', () => {
    // ON A REFUSAL AND NOT ON EVERY STAGE. A reader who closed the sheet to see
    // the model is working, not waiting to be interrupted.
    const { c } = panel({ proposal: withBlock(), open: false })
    // A size typed into the row's own fields, which is the ordinary edit — and
    // a perfectly good one, so nothing has anything to say about it.
    type(bodyRows(c)[0].groups[0].fields[0], '30')

    expect(c.state.proposalError).toBeNull()
    expect(c.state.proposalOpen).toBe(false)
  })

  it('comes back on the model when the token does', () => {
    // A DEFAULT THAT OUTLIVES ITS GESTURE IS A TRAP. Giving up the token shuts
    // the eye, which is reasonable on its own; left standing across a round trip
    // it stops being connected to anything the reader can see. They hand the
    // token back, press `add a box`, and nothing appears on the model — turned
    // away by a flag set before they left.
    const { c, el } = panel({ proposal: withBlock() })
    c.computed().tokenClear(click)
    expect(c.state.proposalOff).toBe(true)
    el.setOverlay.mockClear()

    c.setState({ tokenDraft: 'sekrit again' })
    c.computed().tokenSave(click)

    expect(c.state.proposalOff).toBe(false)
    expect(overlay(el)).toEqual(['korpus'])
  })

  it('goes off the model through that same eye when the token is given up', () => {
    // THE ONE ANSWER TO "IS IT ON THE MODEL", and this door has to use it like
    // any other. Clearing the overlay by hand here — which is what this did
    // while the branch went off screen with the panel — leaves `proposalOff`
    // still saying the proposal is on: the branch survives now, so the first
    // edit through any of its rows calls `setProposal` and stages the bodies
    // straight back onto the model this had just cleared.
    //
    // A DEFAULT AND NOT A LOCK. The reader giving up the right to edit should
    // not be left with a body standing over the model as a statement they can
    // no longer send — but the branch stays drawn and the eye still opens, and
    // nothing here pretends to be a permission gate.
    const { c, el } = mounted({ proposal: withBlock(), open: false })
    drag('/model/plate', [3, 0, 0])
    expect(overlay(el)).toEqual(['korpus'])
    expect(pushed(el)).not.toEqual([])

    c.computed().tokenClear(click)

    expect(c.state.proposalOff).toBe(true)
    expect(el.clearOverlay).toHaveBeenCalled()
    // BOTH HALVES GO, AND THEY GO NOW. The pushes carry their own answer rather
    // than reading the flag they sit beside — `setState` has not landed when
    // they run — and the moves need a push at all because nothing else makes
    // one here: left out, the displaced parts stand where they are until some
    // later edit happens to send a document.
    expect(pushed(el)).toEqual([])
    // The document is untouched, exactly as the eye leaves it.
    expect(c.state.proposal.nodes.length).toBe(withBlock().nodes.length + 1)
  })

  it('keeps the branch on screen and writes no visibility of its own', () => {
    // THE BRANCH CANNOT GO WITH IT — the eye is what reopens it, so a branch
    // taken off screen would be a proposal nothing could bring back.
    //
    // AND IT IS NOT `s.hidden` UNDER ANOTHER NAME, which is the half that would
    // be invisible until somebody reopened it: a body the reader hid stays
    // hidden and a body they did not stays shown, either side of the press. Had
    // this been spelled as "hide every staged path", opening the eye again
    // would have handed back a scene this control decided on rather than the
    // one they had.
    const { c, el } = mounted({ proposal: withBlock() })
    const at = stage(c, el, ['korpus'])
    drag('/model/plate', [3, 0, 0])
    rows(c)[0].onVis(click)
    expect(c.state.hidden).toEqual([`${at}/korpus`])

    c.computed().proposalEyeClick(click)

    expect(css(c.computed().proposalTreeStyle).display).toBe('flex')
    expect(rows(c).map((row) => row.name)).toEqual(['korpus', 'plate'])
    expect(c.computed().proposalCount).toBe('2')
    expect(c.state.hidden).toEqual([`${at}/korpus`])
    expect(c.state.ghost).toEqual([])

    // ...and the eye itself says which way it is, which is the one thing on the
    // head row that the press changes.
    const shut = c.computed().proposalEyeDot
    c.computed().proposalEyeClick(click)
    expect(c.computed().proposalEyeDot).not.toBe(shut)
    expect(c.state.hidden).toEqual([`${at}/korpus`])
  })

  it('is the control that decides this, and the shut sheet is not', () => {
    // THE COUNTERPART, and the pair is the whole point of the eye: closing the
    // sheet leaves everything on the model, closing the eye takes all of it off
    // — with the sheet already shut, and with nothing else having changed.
    const { c, el } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])
    c.computed().proposalClose(click)
    el.setOverlay.mockClear()
    el.clearOverlay.mockClear()

    c.computed().proposalEyeClick(click)

    expect(el.setOverlay).not.toHaveBeenCalled()
    expect(el.clearOverlay).toHaveBeenCalled()
    expect(pushed(el)).toEqual([])
  })

  // -- the tick: a statement written and held back ----------------------------

  it('holds a node back from the text and changes nothing else about it', () => {
    // THE TICK IS ABOUT THE PROJECTION AND ABOUT NOTHING ELSE. The node stays
    // in the document, the body stays over the model, the row stays where it
    // was — which is what makes it different from the `×` beside it.
    const { c, el } = mounted({ proposal: withBlock() })
    stage(c, el, ['korpus'])
    drag('/model/plate', [3, 0, 0])

    rows(c)[0].onSkip(click)

    expect(c.state.proposal.nodes[0].skip).toBe(true)
    expect(proposalText(c.state.proposal)).not.toContain('"korpus"')
    expect(proposalText(c.state.proposal)).toContain('move "plate"')
    expect(overlay(el)).toEqual(['korpus'])
    expect(rows(c).map((row) => row.name)).toEqual(['korpus', 'plate'])
  })

  it('is on a move row like any other, and the part stays displaced', () => {
    // A MOVE IS A STATEMENT THAT CAN BE HELD BACK exactly as a body can, so the
    // square is drawn on its row like any other — which it could not be from
    // inside the marks box, that being `visibility:hidden` on every move.
    const { c, el } = mounted({})
    drag('/model/plate', [3, 0, 0])

    rows(c)[0].onSkip(click)

    expect(moves(c.state.proposal)[0].skip).toBe(true)
    expect(proposalText(c.state.proposal)).not.toContain('move "plate"')
    expect(pushed(el))
      .toEqual([{ paths: ['/model/plate'], delta: [3, 0, 0], turn: [0, 0, 0] }])
  })

  it('reads a node with no such field as one that was never ticked off', () => {
    // A DOCUMENT WRITTEN BEFORE THE FIELD EXISTED has no `skip` on its nodes,
    // and one falsy read is the whole of what that costs: `withBlock()` is such
    // a document, and the first press has to TICK rather than untick.
    const { c } = mounted({ proposal: withBlock() })
    expect('skip' in c.state.proposal.nodes[0]).toBe(false)
    expect(rows(c)[0].skipIcon).toBe(c.computed().proposalSkipIcon)

    rows(c)[0].onSkip(click)

    expect(c.state.proposal.nodes[0].skip).toBe(true)
  })

  it('clears and sets every tick from the head of the branch', () => {
    const { c } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])
    c.computed().proposalOps[0].onClick()
    const ticks = () => c.state.proposal.nodes.map((node) => !!node.skip)
    expect(ticks()).toEqual([false, false, false])

    c.computed().proposalSkipAll(click)
    expect(ticks()).toEqual([true, true, true])

    c.computed().proposalSkipAll(click)
    expect(ticks()).toEqual([false, false, false])
  })

  it('sets the rest where only some are ticked off, rather than clearing them', () => {
    // THE MASTER SHOWS WHAT IT WOULD PUT THE DOCUMENT IN, and half-ticked is
    // not one of the two states it has: a branch with one node held back reads
    // as one with something still to send, and the press holds the rest back
    // too rather than letting that one through.
    const { c } = mounted({ proposal: withBlock() })
    c.computed().proposalOps[0].onClick()
    rows(c)[0].onSkip(click)
    expect(c.computed().proposalSkipIcon).toBe(rows(c)[1].skipIcon)

    c.computed().proposalSkipAll(click)

    expect(c.state.proposal.nodes.map((node) => !!node.skip)).toEqual([true, true])
  })

  it('offers no `add to comment` once nothing survives, and keeps the branch', () => {
    // THE DOOR OUT GATES ON `sendsNothing` AND THE BRANCH ON `isEmpty`, which
    // is why the two predicates are not one: a document ticked off to the last
    // node projects to a heading and a `result =` line, and the rows are the
    // only place the reader can untick anything.
    const { c } = mounted({ proposal: withBlock() })
    expect(css(c.computed().proposalAddStyle).display).not.toBe('none')

    c.computed().proposalSkipAll(click)

    expect(css(c.computed().proposalAddStyle).display).toBe('none')
    expect(css(c.computed().proposalTreeStyle).display).toBe('flex')
    expect(rows(c)).toHaveLength(1)
  })

  it('draws the head\'s eye, the head\'s tick and the rows\' on the page', () => {
    // `computed()` answering with a handler is not the same as the page drawing
    // a control for it — the lesson eltree.js is written around. Read off the
    // titles, because none of these three has any text of its own.
    const { c } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])

    const said = titles(c.render())
    expect(said).toContain('show / hide the whole proposal')
    expect(said).toContain('hold all of it back from the agent')
    expect(said.filter((t) => t === 'leave this out of the text sent to the agent'))
      .toHaveLength(2)
  })

  it('stands over the ghost column it has no control of its own for', () => {
    // KEEP X AND Y IN STEP, WHICH IS A TEST AND NOT A COMMENT. A row spends its
    // width on an eye, a GHOST SQUARE and a tick; the head has an eye and a tick
    // and nothing that would make the whole proposal translucent, so it carries
    // an empty span the width of that square to keep its tick in the same
    // column. Left as prose, the next change to the ghost control's width moves
    // the master tick silently off the ticks it sets and clears — which is where
    // it started, a whole column to the left.
    //
    // THE SPACER AGAINST THE THING IT STANDS IN FOR, and not the two run-ups
    // against each other: those do not agree to the pixel and are not meant to
    // (a row also carries the part's colour dot, which the head has no use for).
    // What has to hold is that the head reserves exactly the ghost column.
    const { c } = mounted({ proposal: withBlock() })
    const drawn = c.render()

    // The children of whichever element holds the control with this title.
    const beside = (node, title) => {
      if (!node || typeof node !== 'object') return null
      if (Array.isArray(node)) {
        for (const child of node) {
          const got = beside(child, title)
          if (got) return got
        }
        return null
      }
      if (!node.props) return null
      const kids = [node.props.children].flat(9).filter(Boolean)
      if (kids.some((k) => k.props && k.props.title === title)) return kids
      return beside(node.props.children, title)
    }
    const widthOf = (el) => (el && el.props && el.props.style
      ? el.props.style.width : undefined)

    const head = beside(drawn, 'hold all of it back from the agent')
    expect(head, 'the premise: the head is on the page').toBeTruthy()
    // REACHED THROUGH THE ROW'S OWN TICK, and not by hunting the page for a
    // `translucent`. The parts tree draws ghost squares too, out of a second
    // string literal — and since this branch moved BELOW it, a search from the
    // top of the render finds that one first. Measured against it, the test goes
    // green while the column it is named for drifts: the row's tick is the only
    // control of the two branches that exists here alone.
    const rowKids = beside(drawn, 'leave this out of the text sent to the agent')
    expect(rowKids, 'the premise: a row of this branch is drawn').toBeTruthy()
    const row = beside(rowKids, 'translucent')
    expect(row, 'the premise: that row draws a ghost square').toBeTruthy()

    // Guarded like `beside` above, and for the same reason: a bare text child
    // in either list would end this walk in `undefined.props` instead of the
    // premise message written for that case. Missing the control is still a
    // failure -- `undefined` width does not equal the ghost's, and `-1` puts
    // the premise assert below on `head[-2]`.
    const ghost = widthOf(row.find((k) => k.props && k.props.title === 'translucent'))
    const tickAt = head.findIndex(
      (k) => k.props && k.props.title === 'hold all of it back from the agent')
    const spacer = head[tickAt - 1]
    // Said out loud rather than thrown as `undefined.props`: a wrapper put round
    // either control breaks the shape this walk assumes, and the next reader
    // should be told that and not left reading a stack trace.
    expect(spacer, 'the premise: the spacer is the tick\'s left neighbour')
      .toBeTruthy()
    // An empty span and not another control: it reserves the column, it does
    // not offer anything in it.
    expect(spacer.props.onClick).toBeUndefined()
    expect(spacer.props.children).toBeUndefined()
    expect(widthOf(spacer)).toBe(ghost)
  })

  it('is drawn on the page, below the parts tree and not in the panel', () => {
    // `computed()` answering with a row is not the same as the page drawing one
    // — the lesson eltree.js is written around.
    const { c, el } = mounted({ proposal: withBlock() })
    stage(c, el, ['korpus'])
    drag('/model/plate', [3, 0, 0])

    const said = texts(c.render())
    expect(said).toContain('proposal')
    expect(said).toContain('korpus')
    expect(said).toContain('turn°')
    // BELOW the parts tree, whose own rows start at the model's root — because
    // selecting a row here opens a block of fields under it, and everything
    // after it in this column moves down by that much. Above the parts, one
    // click on a proposal row jerked the whole tree down the screen.
    expect(said.indexOf('proposal')).toBeGreaterThan(said.indexOf('model'))
    // And the panel's label for the list it no longer has is gone with it.
    expect(said).not.toContain('BODIES AND MOVES')
  })
})

// -- the invariant the branch's two bare-word keys stand on --------------------

describe('every id the tree hands the interface', () => {
  // TWO THINGS IN THE PROPOSAL'S BRANCH ARE BARE WORDS COMPARED AGAINST TREE
  // IDS, and both are safe only because a tree id is always a PATH.
  // `PROPOSAL_BRANCH` is a key in the very `expanded` map the parts tree keys by
  // node id; and a body row whose scene has not staged it is selected by the
  // DOCUMENT's own node id — `n1`, `m2` — which `proposalRows` compares against
  // `s.sel`, a field that otherwise holds tree ids.
  //
  // THE INVARIANT IS NOT `indexTree`'S, which is why this is a test and not a
  // sentence: `pathOf` in hub.js passes any non-empty `id` a node carries
  // straight through. It is `treeFromShapes`', which spells every id as
  // `${parent}/${name}` and never reads the incoming one — so this drives the
  // real pair, in the order the page gets them.

  it('is a path, so a bare word can never collide with one', () => {
    const tree = indexTree(treeFromShapes({
      name: 'model',
      parts: [
        // A MODEL THAT HONESTLY PUBLISHES A PART CALLED `proposal`, which is the
        // case `groupName` steps aside for and the one a bare-word key would
        // collide with if an id were ever a name.
        { name: 'proposal', id: 'proposal' },
        // And two parts named exactly as the document names its own nodes.
        { name: 'n1', id: 'n1' },
        { name: 'assembly', id: 'assembly', parts: [{ name: 'm2', id: 'm2' }] },
      ],
    }, null))

    const ids = [...tree.nodes.keys()]
    expect(ids.length).toBeGreaterThan(3)
    for (const id of ids) expect(id.startsWith('/')).toBe(true)

    expect(ids).not.toContain(PROPOSAL_BRANCH)
    expect(ids).not.toContain('n1')
    expect(ids).not.toContain('m2')
    // The model's own `proposal` is still there — as a path, which is the whole
    // of why the branch's key is not it.
    expect(ids).toContain('/model/proposal')
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
    bodyRows(c)[0].onRemove(click)
    c.computed().proposalOps[0].onClick()

    const ids = c.state.proposal.nodes.map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('takes its size, its place and its turn from the fields', () => {
    const { c, el } = panel({ proposal: withBlock() })
    type(sizeFields(c)[0], '30')
    type(bodyRows(c)[0].groups[1].fields[2], '-4.5')
    type(bodyRows(c)[0].groups[2].fields[1], '45')

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
    type(bodyRows(c)[0].nameField, 'motor')
    expect(c.state.proposal.nodes[0].name).toBe('motor')

    type(bodyRows(c)[0].nameField, '   ')
    expect(c.state.proposal.nodes[0].name).toBe('motor')
  })

  it('cannot be given a name another body already has', () => {
    // TWO PARTS UNDER ONE NAME ARE ONE ROW AND ONE GROUPS ENTRY: the second
    // stands in for the first, and the eye belongs to whichever arrived last.
    // The bodies are the whole of it — `firstFree` in proposal.js is the rule.
    const { c } = panel({ proposal: withBlock() })
    c.computed().proposalOps[1].onClick()
    type(bodyRows(c)[1].nameField, 'korpus')
    expect(c.state.proposal.nodes.map((node) => node.name)).toEqual(['korpus', 'korpus2'])

    // AND THE PAYLOAD KEEPS NO NAME FOR ITSELF any more: it is one part per
    // body and nothing else, so `result` is a name like any other.
    type(bodyRows(c)[1].nameField, 'result')
    expect(c.state.proposal.nodes[1].name).toBe('result')

    // ...and a body may still be renamed to the name it already has.
    type(bodyRows(c)[0].nameField, 'korpus')
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

    type(bodyRows(c)[0].nameField, 'motor')

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
    expect(bodyRows(c)[1].role).toBe('solid')

    bodyRows(c)[1].onRole(click)

    expect(c.state.proposal.nodes[1].role).toBe('hole')
    expect(overlay(el)).toEqual(['korpus', 'bore'])
  })

  it('goes away on the cross, and the last one takes the overlay with it', () => {
    const { c, el } = panel({ proposal: withBlock() })
    bodyRows(c)[0].onRemove(click)

    expect(c.state.proposal.nodes).toEqual([])
    expect(el.clearOverlay).toHaveBeenCalledTimes(1)
  })

  it('spells an extruded profile as points, and reads them back the same way', () => {
    const { c } = panel()
    c.computed().proposalOps[3].onClick()
    const profile = bodyRows(c)[0].groups[0].fields[1]
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
    const profile = () => bodyRows(c)[0].groups[0].fields[1]

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
    const bodies = bodyRows(c)
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
  const at = (c, axis = 0) => bodyRows(c)[0].groups[1].fields[axis]

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
  const at = (c, axis = 0) => bodyRows(c)[0].groups[1].fields[axis]
  const rot = (c, axis = 0) => bodyRows(c)[0].groups[2].fields[axis]

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

    const extrusion = bodyRows(c)[1]
    expect(extrusion.groups[0].fields[0]).toMatchObject({ type: 'number', step: 1 })
    expect(extrusion.groups[0].fields[1].type).toBe('text')
    expect(extrusion.groups[0].fields[1].step).toBeUndefined()
    // Nor is a name a number, and nothing nudges one.
    expect(extrusion.nameField.type).toBe('text')
    expect(extrusion.nameField.ref).toBeUndefined()
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
    expect(bodyRows(c)[1].groups[0].fields[1].onWheel).toBeUndefined()
    expect(bodyRows(c)[1].nameField.onWheel).toBeUndefined()
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

  it('holds a node back that was ticked after the draft was attached', () => {
    // THE ONE EDIT THAT IS ABOUT SENDING, and therefore the one that reaches
    // into a draft already carrying the projection. The attachment is a snapshot
    // on purpose — a size the reader goes on adjusting is just a later number,
    // and a draft rewriting itself under the cursor is worse than a stale one.
    // A tick is not a later number: it says "do not send this", and the branch
    // and the composer are on screen together, so "attach, think again, send"
    // is two clicks.
    // TWO NODES, so what is asserted is a node LEAVING the text rather than the
    // whole attachment going — that empty case is the test below.
    const doc = addNode(withBlock(), {
      id: 'm2', role: 'move', paths: ['/model/plate'], name: 'plate',
      delta: [3, 0, 0], turn: [0, 0, 0],
    })
    const { c } = panel({ proposal: doc })
    c.computed().proposalAdd()
    expect(c.state.composer.proposal).toBe(proposalText(doc))

    rows(c)[0].onSkip(click)

    expect(c.state.composer.proposal).toBe(proposalText(c.state.proposal))
    expect(c.state.composer.proposal).not.toBe(proposalText(doc))
    // The body is gone from it and the move is still there, which is the whole
    // of what the tick was pressed for.
    expect(c.state.composer.proposal).not.toMatch(/korpus/)
    expect(c.state.composer.proposal).toMatch(/move "plate"/)
  })

  it('takes the whole attachment off when nothing is left to send', () => {
    // A HEADING WITH NO STATEMENTS UNDER IT IS NOT AN ATTACHMENT, which is the
    // same answer the revision swap gives through the same predicate — so the
    // two paths that can rewrite a draft's attachment agree about the empty
    // case, and the chip stops claiming something is going.
    const { c } = panel({ proposal: withBlock() })
    c.computed().proposalAdd()
    expect(css(c.computed().compProposalChipStyle).display).toBe('flex')

    c.computed().proposalSkipAll(click)

    expect(c.state.composer.proposal).toBeNull()
    expect(css(c.computed().compProposalChipStyle).display).toBe('none')
  })

  it('gives the attachment back when the ticks come off again', () => {
    // PRESSING THE MASTER TWICE IS A ROUND TRIP, which its own note promises —
    // and on a one-node document the first press takes the whole attachment off,
    // so without this the promise held for the document and not for the draft.
    // The only way back was `add to comment`, which builds a WHOLE NEW composer:
    // the reader's typed comment, photo and measurement go with it.
    const doc = withBlock()
    const { c } = panel({ proposal: doc })
    c.computed().proposalAdd()
    c.setState({ composer: { ...c.state.composer, text: 'clears the motor?' } })

    c.computed().proposalSkipAll(click)
    expect(c.state.composer.proposal).toBeNull()
    c.computed().proposalSkipAll(click)

    expect(c.state.composer.proposal).toBe(proposalText(doc))
    // And the draft it was typed into is the same draft throughout.
    expect(c.state.composer.text).toBe('clears the motor?')
  })

  it('does not grow one back on a draft the chip was taken off', () => {
    // THE TWO ANSWERS ARE DIFFERENT QUESTIONS. A tick empties the text and can
    // fill it again; the `×` on the chip is the reader saying they do not want a
    // proposal on this draft at all, and a tick in the branch behind it must not
    // overrule that.
    const { c } = panel({ proposal: withBlock() })
    c.computed().proposalAdd()
    c.computed().compProposalRemove(click)

    rows(c)[0].onSkip(click)
    rows(c)[0].onSkip(click)

    expect(c.state.composer.proposal).toBeNull()
  })

  it('leaves a draft with no proposal on it alone', () => {
    // The refresh is for a draft that CARRIES one. A comment the reader started
    // about a part, with no proposal attached, must not grow one because they
    // ticked a row in the branch behind it.
    const { c } = panel({ proposal: withBlock() })
    c.setState({ composer: { part: 'plate', partId: '/model/plate', key: null,
                             p: null, text: 'hi', photo: null } })

    rows(c)[0].onSkip(click)

    expect(c.state.composer.proposal).toBeUndefined()
    expect(c.state.composer.text).toBe('hi')
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
    const profile = () => bodyRows(c)[1].groups[0].fields[1]
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
  const atFields = (c, index = 0) => bodyRows(c)[index].groups[1]
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
    const x = () => bodyRows(c)[0].groups[1].fields[0]
    x().onChange({ target: { value: '9' } })
    expect(c.state.proposalDraft).toEqual({ key: 'n1.at.0', text: '9' })

    fire('korpus', [3, 0, 0])

    expect(c.state.proposalDraft).toBeNull()
    expect(atFields(c)).toEqual(['3', '0', '0'])
  })

  it('records no move of its own, and leaves a move of the BUILD alone', () => {
    // A proposal body is in no build, so there is no path to record it under and
    // nothing to put back — the BRANCH is what says the body is not part of the
    // model, and the body's own `at` is where it went. A part of the
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
    expect(moveRows(c)[0].groups[0].fields.map((f) => f.value))
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
      type(moveRows(c)[at].groups[1].fields[2], '90')
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
    type(moveRows(c)[0].groups[1].fields[2], '90')
    type(moveRows(c)[1].groups[1].fields[2], '45')

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
    type(moveRows(c)[0].groups[1].fields[2], '90')

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
    type(moveRows(c)[0].groups[1].fields[2], '90')
    drag('/model/pin(2)', [5, 0, 0])
    type(moveRows(c)[1].groups[1].fields[2], '45')

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
    type(moveRows(c)[0].groups[1].fields[0], '30')

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
    type(moveRows(c)[0].groups[1].fields[2], '90')

    drag('/model/plate', [0, 0, 0])

    expect(moves(c.state.proposal)).toHaveLength(1)
    expect(moves(c.state.proposal)[0].delta).toEqual([0, 0, 0])
    expect(moves(c.state.proposal)[0].turn).toEqual([0, 0, 90])
    expect(moveRows(c)).toHaveLength(1)
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
    expect(moveRows(c)).toHaveLength(1)
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

// -- and the row it gets in the tree -------------------------------------------

describe('a part of the build turned in the scene', () => {
  // THE OTHER HALF OF THE SAME NODE. A move node has carried three degrees
  // beside its offset since it was first written, and the only way to say them
  // was to type them into the row; there are rings round the part now
  // (ui/src/viewport/rings.js) and they end HERE — `hmr:turned`, naming the
  // paths and the whole turn from the pose the build gives them.
  //
  // WHAT THE TWO GESTURES SHARE is everything except which field they are
  // about: one method reads both (`recordGesture`), so the rules this describe
  // is spot-checking — one node per part, matched by intersection, the field
  // the gesture did not touch carried across, a gesture home dropping the node
  // — are the ones the drag's own describe above pins at length. WHAT IS HERE
  // is that they read the same both ways round, which is the whole claim of
  // there being one method.
  //
  // WHERE THE OTHER HALF IS TESTED: the gesture itself, the sign it turns in
  // and what it refuses, is ui/tests/rings.test.js.

  it('records the turn beside the bodies, and prints it in the projection', () => {
    const { c } = mounted({ proposal: withBlock() })

    spin('/model/plate', [0, 0, 90])

    expect(moves(c.state.proposal)).toEqual([{
      id: 'm2', role: 'move', paths: ['/model/plate'], name: 'plate',
      // A TURN SAYS NOTHING ABOUT WHERE, so the node it mints starts at no
      // offset — the mirror of the drag's own note one describe up.
      delta: [0, 0, 0],
      turn: [0, 0, 90],
    }])
    expect(proposalText(c.state.proposal))
      .toContain('move "plate" by (0, 0, 0) turned (0, 0, 90)')
  })

  it('lands as an ordinary edit, the same one the row`s fields make', () => {
    // THE WHOLE POINT OF THE GESTURE. What the ring produces has to be
    // indistinguishable from the three numbers typed into `turn°` — same node,
    // same fields, same push at the viewport — or the panel would be showing
    // one thing and the agent reading another.
    const typed = mounted({ proposal: withBlock() })
    drag('/model/plate', [1, 0, 0])
    type(moveRows(typed.c)[0].groups[1].fields[2], '90')

    const dragged = mounted({ proposal: withBlock() })
    drag('/model/plate', [1, 0, 0])
    spin('/model/plate', [0, 0, 90])

    expect(moves(dragged.c.state.proposal)[0])
      .toEqual(moves(typed.c.state.proposal)[0])
    expect(pushed(dragged.el)).toEqual(pushed(typed.el))
  })

  it('leaves the offset the part is already standing at alone', () => {
    // A TURN MUST NOT SEND A PART HOME, which is the same rule the drag obeys
    // about a turn and is why the two are one method: the node this gesture
    // covers is EDITED, and the patch names one field.
    const { c, el } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, -1])

    spin('/model/plate', [0, 45, 0])

    expect(moves(c.state.proposal)).toHaveLength(1)
    expect(moves(c.state.proposal)[0].delta).toEqual([3, 0, -1])
    expect(pushed(el)).toEqual([{
      paths: ['/model/plate'], delta: [3, 0, -1], turn: [0, 45, 0],
    }])
  })

  it('takes a minted node`s offset from the nodes its paths touched', () => {
    // The mirror of the drag carrying a turn across. A copy taken OUT of a
    // displaced row is not superseding that row's node — it still stands and
    // still claims the copies left behind — so a node minted at no offset would
    // send the one part the reader is holding home.
    const { c } = mounted({ proposal: withBlock() })
    const row = ['/model/pin', '/model/pin(2)']
    drag('/model/pin', [3, 0, 0], { paths: row, count: 2 })

    spin('/model/pin', [0, 0, 90])

    const after = moves(c.state.proposal)
    expect(after).toHaveLength(2)
    expect(after[0].paths).toEqual(['/model/pin(2)'])
    expect(after[1]).toMatchObject({
      paths: ['/model/pin'], delta: [3, 0, 0], turn: [0, 0, 90],
    })
  })

  it('drops the node when the part is turned back square and stands home', () => {
    // A GESTURE THAT PUTS ITS OWN ANSWER BACK TO NOTHING IS A RETRACTION, and
    // for a ring that is a part turned square again — with no displacement left
    // on the node, there is nothing for it to say. Kept, it would print
    // `move "plate" by (0, 0, 0)` for the agent to puzzle over.
    const { c } = mounted({ proposal: withBlock() })
    spin('/model/plate', [0, 0, 90])
    expect(moves(c.state.proposal)).toHaveLength(1)

    spin('/model/plate', [0, 0, 0])

    expect(moves(c.state.proposal)).toEqual([])
  })

  it('keeps it when the part is turned back square but stands displaced', () => {
    // THE OTHER HALF OF THE SAME RULE, and the one a naive reading gets wrong:
    // the part is still somewhere the build does not put it, so the sentence is
    // still true and the row is still what puts it back.
    const { c } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])
    spin('/model/plate', [0, 0, 90])

    spin('/model/plate', [0, 0, 0])

    expect(moves(c.state.proposal)).toHaveLength(1)
    expect(moves(c.state.proposal)[0]).toMatchObject({
      delta: [3, 0, 0], turn: [0, 0, 0],
    })
  })

  it('drops a report measured on a build that has left', () => {
    // The viewport defers this event by a microtask so it cannot be raised from
    // inside a render, and a rebuild landing mid-gesture reaches `onModel`
    // first — so the report can arrive describing an assembly that is no longer
    // on screen. The stamp is what turns it away, and it is the same stamp for
    // both gestures because it is the same line.
    const { c } = mounted({ proposal: withBlock() })

    spin('/model/plate', [0, 0, 90], { build: 'some-other-build' })

    expect(moves(c.state.proposal)).toEqual([])
  })
})

describe('a body turned in the scene', () => {
  // THE SECOND MEANING OF THE RINGS, exactly as `hmr:proposalmove` is the
  // second meaning of a drag: a body is the reader's own drawing, so turning
  // one is an ordinary edit of the `rot` fields rather than a statement about
  // the model.
  //
  // COMPOSED AND NOT SET, which is the one place the two events genuinely
  // differ in shape. The viewport knows the pose the BUILD gives a part and
  // reports the whole turn from it; a body's pose lives in this document, which
  // the viewport has never read, so what it can say is how far this one gesture
  // took the body — and `turnNodes` composes that onto the pose it took it
  // from. The composition itself is pinned in proposal.test.js, where the cases
  // an addition gets wrong are; what these ask is that the panel goes through
  // that door at all.

  const fire = (name, turn) => window.dispatchEvent(
    new CustomEvent(PROPOSALTURN, { detail: { name, turn } }))

  /** Every body's orientation, in document order. */
  const poses = (c) => c.state.proposal.nodes.map((node) => node.rot)

  it('puts the gesture`s own turn onto the body`s rot', () => {
    const { c, el } = mounted({ proposal: withBlock() })

    fire('korpus', [0, 0, 30])
    fire('korpus', [0, 0, 15])

    expect(poses(c)).toEqual([[0, 0, 45]])
    // And the body on the model is staged out of the document that says so.
    expect(overlay(el)).toEqual(['korpus'])
    expect(bodyRows(c)[0].groups[2].fields.map((f) => f.value))
      .toEqual(['0', '0', '45'])
  })

  it('rounds the answer to a place somebody could have typed', () => {
    // `tidy` is the document's rule and it is applied where the ARITHMETIC is,
    // which for a body is this composition: a reader who typed 42.3 and then
    // turned the body by one degree must not find 43.300000000000004 in a field
    // they are looking at — and `atan2`, which the composition comes back
    // through, hands over a dozen digits nobody asked for.
    const { c } = mounted({
      proposal: addNode(emptyProposal(), { ...BLOCK, rot: [42.3, 0, 0] }),
    })

    fire('korpus', [1, 0, 0])

    expect(poses(c)).toEqual([[43.3, 0, 0]])
  })

  it('writes no move node, and turns nothing for a name no body answers to', () => {
    const { c } = mounted({ proposal: withBlock() })

    fire('korpus', [0, 0, 30])
    fire('nothing-of-the-sort', [0, 0, 30])

    expect(moves(c.state.proposal)).toEqual([])
    expect(poses(c)).toEqual([[0, 0, 30]])
  })
})

describe('the row a move is drawn as', () => {
  // WHY THERE HAS TO BE ONE AT ALL: a dragged part goes home by having its entry
  // DELETED, and a row nobody can see is an entry nobody can delete. It is in the
  // same branch as the bodies because it is the same kind of statement — the
  // reader's own words for it were "you have new parts in that tree, just add
  // `shift of an existing part` to it".

  /** The rows of the branch that are moves, as `computed()` hands them over. */
  const rows = moveRows

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
      .toBe(bodyRows(c)[0].groups[1].fields[0].step)
    expect(rows(c)[0].groups[1].fields[0].step)
      .toBe(bodyRows(c)[0].groups[2].fields[0].step)
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

  it('is drawn on the page, in the branch the bodies are in and after them', () => {
    // `computed()` answering with a row is not the same as the page drawing one
    // — the lesson eltree.js is written around — and a row nobody draws is a
    // part that cannot be put back.
    const { c } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])

    const said = texts(c.render())
    expect(said).toContain('turn°')
    expect(said).toContain('plate')
    // AFTER THE BODIES AND BEFORE THE BUTTONS THAT ADD ONE — which are still in
    // the panel — so it is a row among them rather than a section of its own.
    expect(said.indexOf('turn°')).toBeGreaterThan(said.indexOf('rot°'))
    expect(said.indexOf('turn°')).toBeLessThan(said.indexOf('+ box'))
  })

  it('leaves the bodies their own rows, and takes none of them', () => {
    const { c } = mounted({ proposal: withBlock() })

    drag('/model/plate', [3, 0, 0])

    expect(bodyRows(c).map((b) => b.nameField.value)).toEqual(['korpus'])
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

    rows(c)[0].onRemove(click)

    expect(rows(c)).toEqual([])
    expect(pushed(el)).toEqual([])
    // The body beside it is untouched, and so is the overlay it is staged as.
    expect(bodyRows(c)).toHaveLength(1)
    expect(overlay(el)).toEqual(['korpus'])
  })

  it('leaves the other moves alone when one of them is closed', () => {
    const { c, el } = mounted({})
    drag('/model/plate', [3, 0, 0])
    drag('/model/lid', [0, 4, 0])

    rows(c)[0].onRemove(click)

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

    expect(bodyRows(c)).toEqual([])
    expect(moveRows(c)).toHaveLength(1)
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

  it('is offered Turn, and it mints no node for a body', () => {
    // THE ROW A BODY USED TO BE REFUSED, AND WHY IT IS NOT ANY MORE. Turn armed
    // NOTHING while a turn had no gesture: all it could do was mint a move node
    // and open the panel, and a move node on an overlay path is a second way to
    // turn a body that already has a `rot°` three rows up the same sheet —
    // `move "korpus" turned (…)` printed for the agent beside its own
    // `rot (…)`. There are rotation handles now (viewport/rings.js), and the
    // gesture is re-routed at the press exactly as the drag is: a body's turn
    // goes out on `hmr:proposalturn` and edits that very `rot`. So the tool is
    // armed on either kind of object.
    //
    // AND THE TOOL IS `move`, which is not a slip. The handles and the arrows
    // are one manipulator under one command, so both rows arm the same thing
    // and what is left to tell them apart is the node below.
    //
    // WHAT IS STILL THE BUILD'S ALONE is the node: the item makes a row for a
    // part nothing has claimed yet, so that an exact angle has somewhere to be
    // typed, and a body needs none because its own row is already there.
    const menuOn = (id) => {
      const { c, el } = panel({ proposal: withBlock() })
      staging(el)
      c.state = { ...c.state, tree: indexTree(STAGED), menu: { id, x: 0, y: 0 } }
      return { c, items: c.computed().menuItems }
    }
    const labelsOn = (id) => menuOn(id).items.map((m) => m.label)

    expect(labelsOn('/model/proposal/korpus')).toEqual(
      expect.arrayContaining(['Move', 'Turn']))
    expect(labelsOn('/model/plate')).toEqual(
      expect.arrayContaining(['Move', 'Turn']))

    // The tool is armed on the body and the document is left exactly as it was
    // — one node, the body the fixture put there, and no move beside it.
    const { c, items } = menuOn('/model/proposal/korpus')
    const before = c.state.proposal.nodes.length
    items.find((m) => m.label === 'Turn')
      .onClick({ stopPropagation() {}, preventDefault() {} })
    expect(c.state.tool).toBe('move')
    expect(c.state.proposal.nodes).toHaveLength(before)
    expect(moves(c.state.proposal)).toEqual([])
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
  // THIS ROW DOES TWO THINGS AND USED TO DO ONE. It arms a tool on the object it
  // names — the SAME tool Move arms, since the two halves of the manipulator
  // were merged and turning no longer needs a mode of its own — and it writes
  // the selection, because an armed tool acts on what is SELECTED and neither
  // door into this menu writes it. What is left between the two rows is what
  // each does BESIDES arming, which is the rest of this block.
  //
  // AND IT GOES ON MAKING THE ROW, which is what it did when a turn had no
  // gesture at all: a ring says "about this much" and a field says "exactly
  // 90", and a part nobody has dragged has no row in the panel and therefore
  // nowhere to type the second.

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

  it('arms the one manipulator on the object the row names, and says so', () => {
    // THE SELECTION AND THE TOOL IN ONE WRITE, which is what makes the row mean
    // what it says: the armed tool works on what is SELECTED, and a right-click
    // on a row does not select. Chosen while another object stood selected,
    // this would otherwise have put the widget round that one.
    //
    // `move` AND NOT A TOOL OF ITS OWN. `turn` was one, and it meant the widget
    // came up as two halves the reader had to swap between — arrows under one
    // name, rotation handles under the other. There is one manipulator now and
    // this row arms it; what the row still owns is the node it mints and the
    // panel it opens, which is where an exact angle is typed.
    const { c } = menu('/model/plate')

    choose(c, 'Turn')

    expect(c.state.tool).toBe('move')
    expect(c.state.sel).toBe('/model/plate')
    // AND THE SENTENCE NAMES BOTH HALVES, which is the whole of what one tool
    // owes the reader: told only about the discs they would never find the
    // arrows, and told only `drag it` they would never find the discs.
    const said = c.toast.mock.calls.map(([text]) => text).join('')
    expect(said).toContain('slide')
    expect(said).toContain('disc')
    // AND THE STRIP SAYS THE SAME THING, because it is the only line on the
    // page that describes the tool while it is in force. `disc` and not `ring`:
    // there is no full ring on screen at rest, and a press on the arc that IS
    // drawn goes to the trackball, so naming the ring would send the reader to
    // grab the one part of the widget that does nothing.
    expect(c.computed().hintText).toContain('slide')
    expect(c.computed().hintText).toContain('disc')
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
    expect(moveRows(c)).toHaveLength(1)
    expect(moveRows(c)[0].groups.map((g) => g.label))
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
    expect(moveRows(c)).toHaveLength(1)
  })

  it('types a turn into the row it just made', () => {
    const { c, el } = menu('/model/plate')
    choose(c, 'Turn')

    const row = moveRows(c)[0]
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
      expect(bodyRows(c)[0].groups[0].fields.length)
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

  it('drops the attachment where everything left is ticked off', () => {
    // THE SAME GATE AS THE FRONT DOOR, one step further on. The swap re-renders
    // the projection off the document as it stands, and it asks `sendsNothing`
    // rather than `isEmpty` for the same reason the link does: a node the
    // reader held back travels no further than a node that is not there, so
    // what would ride along is a `proposal` block with no statement in it.
    // A BODY TICKED OFF AND A MOVE STILL STANDING, which is the only shape that
    // tells the two predicates apart. Tick everything instead and the attachment
    // is already null before the swap begins (`skipProposal` takes it off), so
    // the ternary below never opens and the test passes with `isEmpty` — or with
    // anything at all — in it. Here the draft still carries a projection on the
    // way in, because the move is in it; the swap then drops the moves, and what
    // is left is one ticked-off body: `sendsNothing` true, `isEmpty` false.
    const { c } = mounted({
      proposal: addNode(withBlock(), {
        id: 'm2', role: 'move', paths: ['/model/plate'], name: 'plate',
        delta: [3, 0, 0], turn: [0, 0, 0],
      }),
    })
    c.computed().proposalAdd()
    expect(c.state.composer.proposal).toContain('"korpus"')

    rows(c)[0].onSkip(click)
    expect(c.state.composer.proposal, 'the premise: the move keeps it alive')
      .toContain('move "plate"')

    const { state } = c.leaveBuild(true)

    expect(state.composer.proposal).toBeNull()
    // ...and the document is untouched by the swap, ticks and all: both nodes
    // are still there to be let through again on the revision that arrives. The
    // move is dropped from the PROJECTION the swap renders, not from the
    // document — `onModel` is what takes it out, when the build actually lands.
    expect(c.state.proposal.nodes.map((node) => !!node.skip))
      .toEqual([true, false])
  })

  it('attaches nothing to a draft that had no projection on it', () => {
    const { c } = mounted({ proposal: withBlock() })
    drag('/model/plate', [3, 0, 0])
    c.setState({ composer: { part: 'plate', text: 'too thin' } })

    const { state } = c.leaveBuild(true)

    expect('proposal' in state.composer).toBe(false)
  })
})

// -- and what survives closing the tab ----------------------------------------
//
// The document used to be held in page state and written nowhere, so a reload
// lost all of it. The hub keeps ONE per project now, read and written under the
// same EDIT_TOKEN the rest of this page is behind, and deleted only when
// somebody says so. Three claims, and each of them has a way of failing
// silently: a load that adopts over live edits, a save that fires before the
// load has answered and destroys what it was about to read, and a delete that
// clears one side of the pair.

describe('the stored proposal', () => {
  /** Each call answered by the next response; the last one stands for the rest. */
  function answering(...responses) {
    const fetching = vi.fn(async () => (responses.length > 1
      ? responses.shift() : responses[0]))
    vi.stubGlobal('fetch', fetching)
    return fetching
  }

  const ok = (record) => ({ status: 200, json: async () => record })

  /** One stored record, in the shape the hub's GET answers with. */
  const stored = (over = {}) => ({
    pid: PAGE.pid, doc: withBlock(), text: proposalText(withBlock()),
    published: STAMP, view: VIEW, saved: '2026-09-19T09:00:00Z', ...over,
  })

  /** A body and a part of the build dragged, which is the pair that parts ways. */
  const withMove = () => addNode(withBlock(), {
    id: 'm2', role: 'move', paths: ['/model/plate'], name: 'plate',
    delta: [3, 0, 0], turn: [0, 0, 0],
  })

  afterEach(() => vi.unstubAllGlobals())

  // -- reading it ------------------------------------------------------------

  describe('read when the token arrives', () => {
    it('is asked for with the token and adopted onto the model', async () => {
      const fetching = answering(ok(stored()))
      const { c, el } = panel({ stored: null })

      await c.loadProposal()

      expect(fetching).toHaveBeenCalledWith(
        `/api/v1/proposals/${PAGE.pid}`,
        { headers: { Authorization: 'Bearer sekrit' } })
      // THROUGH `setProposal`, which is what puts the bodies over the model:
      // adopting into state alone would leave the branch listing rows for
      // geometry nothing had staged.
      expect(c.state.proposal.nodes.map((node) => node.name)).toEqual(['korpus'])
      expect(overlay(el)).toEqual(['korpus'])
      expect(c.state.proposalHeld).toBe(true)
      // AND THAT IT SAYS SOMETHING, which is the other half and a different
      // question: the record's `text` is what a comment points the agent at.
      expect(c.state.proposalStands).toBe(true)
    })

    it('learns there is a record that says nothing at all', async () => {
      // A DOCUMENT TICKED OFF TO THE LAST NODE is stored with `text: null` (the
      // hub writes what this page sent), and the comment must not point an agent
      // at a proposal that would hand it a heading and nothing else. The RECORD
      // is still there, which is the half the save gate reads.
      answering(ok(stored({ text: null })))
      const { c } = panel({ stored: null })

      await c.loadProposal()

      expect(c.state.proposalHeld).toBe(true)
      expect(c.state.proposalStands).toBe(false)
    })

    it('leaves a document the reader has already drawn exactly alone', async () => {
      // THE FETCH LANDS WHENEVER IT LANDS, and by then there may be a body on
      // screen. The reader's own work outranks a document they have not seen —
      // and this is the one door the arrangement has no way to undo, since the
      // adoption is not an edit anybody could take back.
      answering(ok(stored({
        doc: addNode(emptyProposal(), { ...BLOCK, id: 's1', name: 'motor' }),
      })))
      const { c } = panel({ proposal: withBlock(), stored: null })

      await c.loadProposal()

      expect(c.state.proposal.nodes.map((node) => node.name)).toEqual(['korpus'])
      // AND IT STAYS UNANSWERED, which is the state that means "do not write":
      // this page read a record it never showed, so it has not earned the right
      // to post its own document over it.
      expect(c.state.proposalHeld).toBeNull()
      // ...while the page still learns there IS one to read, which is what the
      // comment then tells the agent — that is about the HUB and is unchanged.
      expect(c.state.proposalStands).toBe(true)
    })

    it('tells the reader once that what they are drawing is not being saved',
       async () => {
      // A SILENT REFUSAL LEAVES SOMEBODY DRAWING INTO A PAGE THAT SAVES
      // NOTHING. The record is spent on the first call, so this cannot repeat
      // however many times the adoption is attempted afterwards.
      answering(ok(stored()))
      const { c } = panel({ proposal: withBlock(), stored: null })

      await c.loadProposal()
      c.adoptProposal()
      c.adoptProposal()

      expect(c.toast).toHaveBeenCalledTimes(1)
      expect(c.toast.mock.calls[0][0]).toMatch(/stored proposal/)
      expect(c.toast.mock.calls[0][0]).toMatch(/not being saved/)
    })

    it('drops the moves of one stored on another build, and keeps the bodies', async () => {
      // A MOVE'S `paths` ARE PATHS IN ONE REVISION'S TREE — `/model/pin(2)`, a
      // number the tessellator hands out — and a rebuild renumbers them, so a
      // stored move re-applied on a different build can displace a DIFFERENT
      // part. The bodies are kept for the reason `dropMoves` gives: a motor the
      // model has to clear is as true of one build as of another.
      answering(ok(stored({ doc: withMove(), published: ELSEWHERE })))
      const { c, el } = panel({ stored: null })

      await c.loadProposal()

      expect(c.state.proposal.nodes.map((node) => node.name)).toEqual(['korpus'])
      expect(moves(c.state.proposal)).toEqual([])
      expect(pushed(el)).toEqual([])
    })

    it('keeps them where the stored build and view are the ones on screen',
       async () => {
      answering(ok(stored({ doc: withMove(), published: STAMP, view: VIEW })))
      const { c, el } = panel({ stored: null })

      await c.loadProposal()

      expect(moves(c.state.proposal)).toHaveLength(1)
      expect(pushed(el)).toEqual([
        { paths: ['/model/plate'], delta: [3, 0, 0], turn: [0, 0, 0] },
      ])
    })

    it('and not where they were taken in another view of the same build',
       async () => {
      // THE BUILD ALONE DOES NOT SETTLE IT. `published` is one number for the
      // whole build and is identical across its views, while a view is a
      // separate tree of references with its own grouping — so `/model/plate`
      // over there is a different part, or the same part in a different layout.
      // Within a session `onModel` already drops every move on a view switch
      // (`dropMoves`: "a rebuild, or another revision, or another view"); a tab
      // pressed later does not move the address, so without this a reader who
      // switched view, dragged parts and reloaded came back on the default view
      // with those moves re-applied to the wrong tree.
      answering(ok(stored({ doc: withMove(), published: STAMP,
                            view: ANOTHER_VIEW })))
      const { c, el } = panel({ stored: null })

      await c.loadProposal()

      expect(c.state.proposal.nodes.map((node) => node.name)).toEqual(['korpus'])
      expect(moves(c.state.proposal)).toEqual([])
      expect(pushed(el)).toEqual([])
    })

    it('nor for a record that names no view at all', async () => {
      // The gate is "both match", not "neither disagrees": a record with no view
      // on it cannot say which tree its paths were numbered in, and the bodies
      // are what survives not knowing.
      answering(ok(stored({ doc: withMove(), published: STAMP, view: null })))
      const { c } = panel({ stored: null })

      await c.loadProposal()

      expect(moves(c.state.proposal)).toEqual([])
    })

    it('reads a 404 as "there is nothing stored here yet"', async () => {
      answering({ status: 404, json: async () => ({}) })
      const { c } = panel({ stored: null })

      await c.loadProposal()

      expect(c.state.proposal.nodes).toEqual([])
      // ANSWERED, which is what opens the door to writing: there is nothing
      // left for a save to overwrite.
      expect(c.state.proposalHeld).toBe(false)
      expect(c.toast).not.toHaveBeenCalled()
    })

    it('learns nothing at all from a hub it could not reach', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }))
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { c } = panel({ stored: null })

      await expect(c.loadProposal()).resolves.toBeUndefined()

      expect(c.toast).toHaveBeenCalledWith('Could not reach the hub')
      // AND THE FIELD STAYS NULL, which is the whole of the protection: a page
      // that does not know what is stored may not write over it.
      expect(c.state.proposalHeld).toBeNull()
    })

    it('says so and keeps the page as it was when the hub refuses the token', async () => {
      answering({ status: 401, json: async () => ({}) })
      const { c } = panel({ proposal: withBlock(), stored: null })

      await c.loadProposal()

      expect(c.toast).toHaveBeenCalledWith('The hub refused the token')
      expect(c.state.proposal.nodes).toHaveLength(1)
      expect(c.state.proposalHeld).toBeNull()
    })

  })

  // -- read into a page that is still coming up ------------------------------
  //
  // THE COLD RELOAD IS THE CASE THE WHOLE `published` RULE WAS WRITTEN FOR, and
  // it is the one where the answer lands in the middle of the page opening: one
  // fetch, against the four a build takes to reach the screen. Two things the
  // adoption needs are still in flight when it does. `meta` carries the stamp
  // that says whether the stored moves describe THIS model, and a `meta` that
  // has not landed reads as "some other build" — so every reload came back
  // without them. And the first model event DROPS the moves of the build that
  // lands, so a document adopted ahead of it is stripped a moment later by a
  // line that cannot tell it apart from a rebuild. Either one alone is the whole
  // feature quietly doing nothing.

  describe('read while the build is still on its way', () => {
    /** The build landing: the event `onModel` is the page's handler for. */
    const lands = (c) => c.onModel({
      tree: { id: '/model', name: 'model', children: [] },
      view: 'assembled', live: false,
    })

    /**
     * A page as it is before meta.json and the first view have answered, and
     * `arrive()` for the moment they have.
     *
     * NO ELEMENT EITHER, because both doors to the viewport are a bare early
     * return while it has not upgraded — a document adopted in that window is
     * pushed at nothing and the model comes up bare with the branch listing rows
     * over it.
     */
    function coming() {
      const { c, el } = panel({ stored: null })
      const meta = c.state.meta
      c.state = { ...c.state, meta: null }
      c._modelSeen = false
      c.host.current = null
      const arrive = () => {
        c.host.current = el
        c.state = { ...c.state, meta }
      }
      return { c, el, arrive }
    }

    it('keeps the moves through a reload of the same build', async () => {
      answering(ok(stored({ doc: withMove(), published: STAMP })))
      const { c, el, arrive } = coming()

      await c.loadProposal()

      // NOTHING IS ADOPTED YET, and nothing may be written either: until the
      // record is on the page the load still reads as unanswered.
      expect(c.state.proposal.nodes).toEqual([])
      expect(c.state.proposalHeld).toBeNull()
      expect(el.setOverlay).not.toHaveBeenCalled()

      arrive()
      lands(c)

      expect(c.state.proposal.nodes.map((node) => node.name))
        .toEqual(['korpus', 'plate'])
      expect(moves(c.state.proposal)).toHaveLength(1)
      expect(overlay(el)).toEqual(['korpus'])
      expect(pushed(el)).toEqual([
        { paths: ['/model/plate'], delta: [3, 0, 0], turn: [0, 0, 0] },
      ])
      expect(c.state.proposalHeld).toBe(true)
    })

    it('and does not lose them to the build event that lands behind it', async () => {
      // THE OTHER HALF ON ITS OWN: meta was in when the record arrived, so the
      // stamp read as this build — and the model event a moment later dropped
      // every move anyway, because that is what a build landing does to them.
      answering(ok(stored({ doc: withMove(), published: STAMP })))
      const { c } = panel({ stored: null })
      c._modelSeen = false

      await c.loadProposal()
      lands(c)

      expect(moves(c.state.proposal)).toHaveLength(1)
    })

    it('restores the bodies alone where the reload is another build', async () => {
      // THE RULE ITSELF IS UNCHANGED, and this is the half that was accidentally
      // right: a move's paths are numbered by the tessellator of ONE build, so
      // re-applying them on another can displace a different part.
      answering(ok(stored({ doc: withMove(), published: ELSEWHERE })))
      const { c, el, arrive } = coming()

      await c.loadProposal()
      arrive()
      lands(c)

      expect(c.state.proposal.nodes.map((node) => node.name)).toEqual(['korpus'])
      expect(moves(c.state.proposal)).toEqual([])
      expect(overlay(el)).toEqual(['korpus'])
      expect(pushed(el)).toEqual([])
    })

    it('leaves a reader who drew something first with their own document', async () => {
      // THE WAIT IS ONE MORE REASON there may be a body on screen by the time
      // the record can be taken, and their own work still outranks a document
      // they have not seen. The record is spent either way: the hub is not asked
      // twice, and the page learns there IS one to read.
      answering(ok(stored()))
      const { c, arrive } = coming()

      await c.loadProposal()
      c.setProposal(addNode(emptyProposal(), { ...BLOCK, id: 's1', name: 'motor' }))
      arrive()
      lands(c)

      expect(c.state.proposal.nodes.map((node) => node.name)).toEqual(['motor'])
      expect(c.state.proposalHeld).toBeNull()
      expect(c.state.proposalStands).toBe(true)
    })

    it('and the edit they make next does not destroy the record they never saw',
       async () => {
      // THE WHOLE POINT OF LEAVING THE FLAG DOWN. A reader opens a page whose
      // hub holds a ten-node proposal, presses `+ box` before the first model
      // event lands, and the page declines the record — correctly, for the
      // screen. With the flag raised anyway and the memo empty, the debounce
      // 800 ms after their next edit posted the page's own document over it and
      // the hub held one box.
      vi.useFakeTimers()
      onTestFinished(() => vi.useRealTimers())
      const fetching = answering(ok(stored()))
      const { c, arrive } = coming()

      await c.loadProposal()
      c.setProposal(addNode(emptyProposal(), { ...BLOCK, id: 's1', name: 'motor' }))
      arrive()
      lands(c)
      expect(c.toast, 'the premise: the record was declined')
        .toHaveBeenCalledTimes(1)

      c.setProposal(addNode(emptyProposal(), { ...BLOCK, id: 's1', size: [9, 9, 9] }))
      await vi.advanceTimersByTimeAsync(5000)

      // One call, and it is the GET this test started with.
      expect(fetching).toHaveBeenCalledTimes(1)
      expect(fetching.mock.calls[0][1].method).toBeUndefined()
    })

    it('and a token pasted a second time does not cry wolf over its own work',
       async () => {
      // `loadProposal` RUNS AGAIN ON EVERY `tokenSave`, not only the first. A
      // reader who re-pastes a token they already had brings back a fresh
      // record, and by then the document on screen is the one this page adopted
      // and has been saving all along. Taking the refusal branch there tells
      // them their drawing is not being saved when it is — and the natural
      // answer to that alarm is the branch's `×`, which would lose it for real.
      answering(ok(stored()), ok(stored()))
      const { c, arrive } = coming()

      await c.loadProposal()
      arrive()
      lands(c)
      expect(c.state.proposalHeld, 'the premise: the record was adopted').toBe(true)
      expect(c.toast).not.toHaveBeenCalled()

      await c.loadProposal()

      expect(c.toast).not.toHaveBeenCalled()
      expect(c.state.proposalHeld).toBe(true)
    })

    it('but a record with nothing in it is not work, and does not shut the door',
       async () => {
      // THE CORNER THE REFUSAL ABOVE OPENS IF IT ASKS ONLY ABOUT THE PAGE. The
      // hub legitimately holds a document with no nodes — `saveProposal` writes
      // one when a reader deletes their last body — and there is nothing in it
      // to protect. Declined for that, the reader would go on drawing into a
      // page that had quietly decided never to save again, with the branch's `×`
      // the only way back. Nor may the empty document be taken over what they
      // have drawn: that clears the screen to no purpose.
      vi.useFakeTimers()
      onTestFinished(() => vi.useRealTimers())
      const fetching = answering(ok(stored({ doc: emptyProposal(), text: null })))
      const { c, arrive } = coming()

      await c.loadProposal()
      c.setProposal(addNode(emptyProposal(), { ...BLOCK, id: 's1', name: 'motor' }))
      arrive()
      lands(c)

      expect(c.state.proposal.nodes.map((node) => node.name)).toEqual(['motor'])
      expect(c.toast, 'nothing was declined, so nothing is announced')
        .not.toHaveBeenCalled()
      expect(c.state.proposalHeld).toBe(true)

      c.setProposal(addNode(emptyProposal(), { ...BLOCK, id: 's1', size: [9, 9, 9] }))
      await vi.advanceTimersByTimeAsync(5000)

      expect(fetching).toHaveBeenCalledTimes(2)
      expect(fetching.mock.calls[1][1].method).toBe('POST')
    })

    it('and writes nothing back for having read it, on another build least of all',
       async () => {
      // WHAT A PAGE THAT ONLY OPENED THE SHEET MUST NOT COST. `setProposal` is
      // the save's door, and opening the sheet calls it with the document the
      // page already had — so an adoption that left the memo empty would be
      // followed by a post. On this build that is a request saying nothing; on
      // ANOTHER it is the record rewritten with this page's stamp and without
      // the moves `dropMoves` took out for display, and the reader's moves are
      // then gone from the hub with no way back.
      //
      // The harder half is the one measured here: a different build, where the
      // document on the page is honestly not the document on the hub.
      vi.useFakeTimers()
      try {
        const fetching = answering(ok(stored({ doc: withMove(),
                                               published: ELSEWHERE })))
        const { c, arrive } = coming()

        await c.loadProposal()
        arrive()
        lands(c)
        expect(fetching, 'the premise: the read happened').toHaveBeenCalledTimes(1)

        // SHUT AND OPENED AGAIN, because it is the OPENING that calls the door
        // (`toggleProposal` re-stages what it already had, and only that way
        // round); this fixture starts with the sheet already up.
        c.toggleProposal()
        c.toggleProposal()
        expect(c.state.proposalOpen, 'the premise: the sheet is open again')
          .toBe(true)
        await vi.advanceTimersByTimeAsync(5000)

        expect(fetching).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('records exactly the body a save of the same document would have sent',
       async () => {
      // TWO CALLERS OF ONE BUILDER, held equal here rather than asserted in a
      // comment. `saveProposal` sends that body and `adoptProposal` records it as
      // already sent; spelled out separately they would agree until a field was
      // added to one of them, and then the memo would never match, every opening
      // of the sheet would post, and the test above would be the only thing that
      // noticed. This is the same assertion one layer down, where the failure
      // says what is wrong instead of counting requests.
      answering(ok(stored({ doc: withMove(), published: ELSEWHERE })))
      const { c, arrive } = coming()

      await c.loadProposal()
      arrive()
      lands(c)

      expect(c._proposalSent)
        .toBe(JSON.stringify(c.proposalPayload(c.state.proposal)))
    })
  })

  // -- writing it ------------------------------------------------------------

  describe('written back after the edits stop', () => {
    // THE CLOCK IS THIS BLOCK'S SUBJECT rather than its background: the save is
    // debounced off the one door every edit comes through, so every test here
    // has to be able to say when the typing stopped.
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    /** The body of the nth POST, parsed. */
    const posted = (fetching, at = 0) => JSON.parse(fetching.mock.calls[at][1].body)

    it('writes nothing at all until the load has answered', async () => {
      // WITHOUT THIS GUARD the page mounts holding an empty document, the reader
      // opens the panel, the debounce fires — and the proposal they stored last
      // week is destroyed by a page that had not read it yet.
      const fetching = answering(ok(stored()))
      const { c } = panel({ stored: null })

      c.setProposal(withBlock())
      await vi.advanceTimersByTimeAsync(5000)

      expect(fetching).not.toHaveBeenCalled()
    })

    it('does not write back the document it has just adopted', async () => {
      // THE ADOPTION IS NOT AN EDIT, and it comes through the one door every
      // edit does — so the order inside `adoptProposal` is what keeps a page
      // that has just read a record from immediately re-stamping it with this
      // build and with whatever `dropMoves` took out on the way in.
      const fetching = answering(ok(stored({ doc: withMove(),
                                             published: ELSEWHERE })),
                                 { status: 200, json: async () => ({}) })
      const { c } = panel({ stored: null })

      await c.loadProposal()
      await vi.advanceTimersByTimeAsync(5000)

      expect(fetching).toHaveBeenCalledTimes(1)
      expect(c.state.proposalHeld).toBe(true)
    })

    it('writes the document, its projection and the build and view it stands on',
       async () => {
      const fetching = answering({ status: 200, json: async () => ({}) })
      const { c } = panel({ stored: false })

      c.setProposal(withBlock())
      await vi.advanceTimersByTimeAsync(5000)

      expect(fetching).toHaveBeenCalledTimes(1)
      const [url, sent] = fetching.mock.calls[0]
      expect(url).toBe(`/api/v1/proposals/${PAGE.pid}`)
      expect(sent.method).toBe('POST')
      expect(sent.headers.Authorization).toBe('Bearer sekrit')
      expect(posted(fetching)).toEqual({
        doc: c.state.proposal,
        // THE PROJECTION TRAVELS WITH IT, because it is what an agent reads:
        // rendering it on the far side would be a second copy of `proposalText`.
        text: proposalText(withBlock()),
        // BOTH HALVES OF WHERE THE MOVES WERE MEASURED, because the build alone
        // is the same number in every view of it.
        published: STAMP,
        view: VIEW,
      })
    })

    it('is one write for a run of edits rather than one per keystroke', async () => {
      const fetching = answering({ status: 200, json: async () => ({}) })
      const { c } = panel({ proposal: withBlock(), stored: false })

      type(sizeFields(c)[0], '21')
      await vi.advanceTimersByTimeAsync(200)
      type(sizeFields(c)[1], '22')
      await vi.advanceTimersByTimeAsync(200)
      type(sizeFields(c)[2], '23')
      await vi.advanceTimersByTimeAsync(5000)

      expect(fetching).toHaveBeenCalledTimes(1)
      expect(posted(fetching).doc.nodes[0].size).toEqual([21, 22, 23])
    })

    it('says nothing twice: a panel merely opened is not an edit', async () => {
      // `toggleProposal` calls the one door with the document it already had,
      // deliberately (it re-stages), and so does the adoption in `loadProposal`.
      // Neither is a change, and a request per opening is a request that says
      // nothing.
      const fetching = answering({ status: 200, json: async () => ({}) })
      const { c } = panel({ proposal: withBlock(), stored: false, open: false })

      c.setProposal(withBlock())
      await vi.advanceTimersByTimeAsync(5000)
      expect(fetching).toHaveBeenCalledTimes(1)

      c.toggleProposal()
      await vi.advanceTimersByTimeAsync(5000)

      expect(fetching).toHaveBeenCalledTimes(1)
    })

    it('and a document put back the way it was disarms the write in flight', async () => {
      // THE SKIP HAS TO REACH THE ARMED TIMER, which is why the pending save is
      // cancelled before the payload is compared: a reader who edits and then
      // undoes back to the stored document would otherwise have the
      // intermediate one posted by a timer nothing disarmed.
      const fetching = answering({ status: 200, json: async () => ({}) })
      const { c } = panel({ proposal: withBlock(), stored: false })

      c.setProposal(withBlock())
      await vi.advanceTimersByTimeAsync(5000)
      expect(fetching).toHaveBeenCalledTimes(1)

      c.setProposal(addNode(withBlock(), { ...BLOCK, id: 'n2', name: 'motor' }))
      c.setProposal(withBlock())
      await vi.advanceTimersByTimeAsync(5000)

      expect(fetching).toHaveBeenCalledTimes(1)
    })

    it('writes nothing for a page with no token', async () => {
      // The panel is hidden without one, but the branch of the tree outlives the
      // token and `tokenClear` works right beside this door.
      const fetching = answering({ status: 200, json: async () => ({}) })
      const { c } = panel({ token: null, stored: false })

      c.setProposal(withBlock())
      await vi.advanceTimersByTimeAsync(5000)

      expect(fetching).not.toHaveBeenCalled()
    })

    // -- and what an empty document is worth ---------------------------------

    it('creates no record for a document with nothing in it', async () => {
      // OPENING THE PANEL calls the one door with the document the page mounted
      // with, which on a project nobody has drawn on is the empty one — and a
      // record whose document has no nodes is a file on the volume for a reader
      // who has said nothing, one per project anybody ever opens the panel on.
      const fetching = answering({ status: 200, json: async () => ({}) })
      const { c } = panel({ stored: false, open: false })

      c.toggleProposal()
      await vi.advanceTimersByTimeAsync(5000)

      expect(fetching).not.toHaveBeenCalled()
      expect(c.state.proposalHeld).toBe(false)
    })

    it('stores one ticked off to the last node, which is work somebody did', async () => {
      // THE TEST IS `isEmpty` AND NOT `sendsNothing`: this document has a body
      // in it — sizes, a name, a position — and the reader has only said "do not
      // send it yet". Refusing to store that would lose the drawing to a tick.
      const fetching = answering({ status: 200, json: async () => ({}) })
      const { c } = panel({ stored: false })

      c.setProposal(addNode(emptyProposal(), { ...BLOCK, skip: true }))
      await vi.advanceTimersByTimeAsync(5000)

      expect(fetching).toHaveBeenCalledTimes(1)
      // AND THE PROJECTION IS NULL, which is the hub's word for "this one says
      // nothing" — the same fact the comment's pointer is gated on.
      expect(posted(fetching).text).toBeNull()
      expect(posted(fetching).doc.nodes).toHaveLength(1)
    })

    it('stores a part of the build dragged, which does not come through the door',
       async () => {
      // THE ONE EDIT THAT IS NOT MADE IN THE PANEL. `hmr:moved` writes the
      // document with a functional updater — a patch landing after a swap would
      // put back every node the swap took out — so it never reaches
      // `setProposal`, which is where the save hangs. Left at that, the reader
      // drags a part, sees the row, reloads and the row is gone; and the one kind
      // of node the `published`/`view` stamps exist to bring back would be the
      // only kind that never got stored. The asymmetry was the tell: deleting a
      // move through its `×` saved, making one did not.
      const fetching = answering({ status: 200, json: async () => ({}) })
      const { c } = mounted({ stored: false })

      drag('/model/plate', [3, 0, 0])
      await vi.advanceTimersByTimeAsync(5000)

      expect(fetching).toHaveBeenCalledTimes(1)
      expect(fetching.mock.calls[0][1].method).toBe('POST')
      const sent = posted(fetching).doc.nodes.filter((n) => n.role === 'move')
      expect(sent).toHaveLength(1)
      expect(sent[0].delta).toEqual([3, 0, 0])
      expect(posted(fetching).text).toContain('move "plate" by (3, 0, 0)')
    })

    it('goes on mirroring a record the hub holds when the reader empties it', async () => {
      // THE RECORD MIRRORS THE PAGE once there is one: a reader who deletes
      // their last body means it, and a stored document that outlived the page
      // showing none would come back on the next reload.
      const fetching = answering({ status: 200, json: async () => ({}) })
      const { c } = panel({ proposal: withBlock(), stored: true })

      c.setProposal(emptyProposal())
      await vi.advanceTimersByTimeAsync(5000)

      expect(fetching).toHaveBeenCalledTimes(1)
      expect(posted(fetching).doc.nodes).toEqual([])
    })

    // -- and what the hub says back ------------------------------------------

    it('posts the next edit again when the hub refused the last one', async () => {
      // THE PAYLOAD IS RECORDED AS SENT BEFORE THE REQUEST, so a refusal that
      // nothing reads leaves the memo claiming the hub holds a document it never
      // took — and the edit is lost until the reader happens to make another one
      // that differs from it. Reading the answer and forgetting the memo is the
      // whole of the retry.
      const fetching = answering({ status: 401, json: async () => ({}) },
                                 { status: 200, json: async () => ({}) })
      const { c } = panel({ stored: false })

      c.setProposal(withBlock())
      await vi.advanceTimersByTimeAsync(5000)
      expect(fetching).toHaveBeenCalledTimes(1)
      // NOTHING MOVED ON THIS SIDE EITHER: both flags describe the hub, and the
      // hub took nothing.
      expect(c.state.proposalHeld).toBe(false)
      expect(c.state.proposalStands).toBe(false)

      // THE SAME DOCUMENT, which is the case that used to be skipped: a size
      // nudged and put back, or the panel reopened.
      c.setProposal(withBlock())
      await vi.advanceTimersByTimeAsync(5000)

      expect(fetching).toHaveBeenCalledTimes(2)
      expect(c.state.proposalHeld).toBe(true)
    })

    it('and when the connection dropped, which the hub never saw at all', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      onTestFinished(() => vi.restoreAllMocks())
      const fetching = vi.fn()
        .mockImplementationOnce(async () => { throw new TypeError('Failed to fetch') })
        .mockImplementation(async () => ({ status: 200, json: async () => ({}) }))
      vi.stubGlobal('fetch', fetching)
      const { c } = panel({ stored: false })

      c.setProposal(withBlock())
      await vi.advanceTimersByTimeAsync(5000)
      expect(fetching).toHaveBeenCalledTimes(1)

      c.setProposal(withBlock())
      await vi.advanceTimersByTimeAsync(5000)

      expect(fetching).toHaveBeenCalledTimes(2)
    })

    it('raises what the comment will say when a save lands', async () => {
      // THE ANNOUNCEMENT HAS TO BE CURRENT, not as of the load: a reader who
      // draws a proposal and then writes a comment in the same session gets no
      // pointer at all if nothing revises the flag after this page's own writes.
      const fetching = answering({ status: 200, json: async () => ({}) })
      const { c } = panel({ stored: false })

      c.setProposal(withBlock())
      await vi.advanceTimersByTimeAsync(5000)

      expect(fetching).toHaveBeenCalledTimes(1)
      expect(c.state.proposalStands).toBe(true)
      expect(c.state.proposalHeld).toBe(true)
    })

    it('and lowers it again where what is left would send nothing', async () => {
      // The other direction, and the reason this is not simply "a record
      // exists": everything in the document is ticked off, so the record is
      // still there and there is nothing in it for an agent to read.
      answering({ status: 200, json: async () => ({}) })
      const { c } = panel({ proposal: withBlock(), stored: true, stands: true })

      c.setProposal(addNode(emptyProposal(), { ...BLOCK, skip: true }))
      await vi.advanceTimersByTimeAsync(5000)

      expect(c.state.proposalStands).toBe(false)
      expect(c.state.proposalHeld).toBe(true)
    })
  })

  // -- deleting it -----------------------------------------------------------

  describe('deleted from the branch\'s header', () => {
    it('is offered beside the eye and the master tick', () => {
      const { c } = panel({ proposal: withBlock() })
      const v = c.computed()

      expect(typeof v.proposalRemove).toBe('function')
      expect(v.proposalRemoveTitle).toContain('delete')
    })

    it('asks first, and a refusal leaves both sides standing', async () => {
      // The document is persisted work now, and one misclick must not be the
      // whole of it — which is why this `×` interrupts where the row's does not.
      const fetching = answering({ status: 200, json: async () => ({}) })
      const asked = vi.spyOn(window, 'confirm').mockReturnValue(false)
      const { c } = panel({ proposal: withBlock(), stored: true })

      await c.removeProposal()

      expect(asked).toHaveBeenCalled()
      expect(fetching).not.toHaveBeenCalled()
      expect(c.state.proposal.nodes).toHaveLength(1)
      expect(c.state.proposalHeld).toBe(true)
    })

    it('clears the record and the page together', async () => {
      const fetching = answering({ status: 200, json: async () => ({ removed: true }) })
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const { c, el } = panel({ proposal: withBlock(), stored: true, stands: true })

      await c.removeProposal()

      expect(fetching).toHaveBeenCalledWith(
        `/api/v1/proposals/${PAGE.pid}`,
        { method: 'DELETE', headers: { Authorization: 'Bearer sekrit' } })
      expect(c.state.proposal.nodes).toEqual([])
      expect(c.state.proposalHeld).toBe(false)
      // AND THE COMMENT STOPS POINTING AT IT, which is the half that outlives
      // this panel: a pointer to a document the hub no longer holds is an agent
      // sent to read nothing.
      expect(c.state.proposalStands).toBe(false)
      // AND THE MODEL WITH IT, because the page is cleared through the same one
      // door every other edit goes through.
      expect(el.clearOverlay).toHaveBeenCalled()
    })

    it('cancels the save the clearing itself armed', async () => {
      // `setProposal(emptyProposal())` arms a write like any other edit, and an
      // empty document posted a beat after the DELETE would put the record
      // straight back.
      vi.useFakeTimers()
      onTestFinished(() => vi.useRealTimers())
      const fetching = answering({ status: 200, json: async () => ({ removed: true }) })
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const { c } = panel({ proposal: withBlock(), stored: true })

      await c.removeProposal()
      await vi.advanceTimersByTimeAsync(5000)

      expect(fetching).toHaveBeenCalledTimes(1)
      expect(fetching.mock.calls[0][1].method).toBe('DELETE')
    })

    it('leaves the page alone when the hub would not delete it', async () => {
      const fetching = answering({ status: 401, json: async () => ({}) })
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const { c } = panel({ proposal: withBlock(), stored: true })

      await c.removeProposal()

      expect(fetching).toHaveBeenCalledTimes(1)
      expect(c.toast).toHaveBeenCalledWith('The hub refused the token')
      expect(c.state.proposal.nodes).toHaveLength(1)
      expect(c.state.proposalHeld).toBe(true)
    })
  })
})
