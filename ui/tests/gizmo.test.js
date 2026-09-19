// ui/src/viewport/gizmo.js — the move tool's manipulator: an origin dot, three
// axis arrows and three plane quads. Its fourth piece, the rotation handles,
// is rings.js and has its own file beside this one.
//
// There is no GPU here and nothing below looks at a pixel, the same discipline
// handle.test.js keeps beside it. What IS assertable is everything that decides
// whether the reader can see and use the widget at all: WHERE it is put (a
// projection, in px, of the selected part's centre), WHICH WAY each arrow points
// (the screen direction of its world axis), HOW LONG it is drawn (the
// foreshortening of that axis against the camera's projection axis), WHICH PLANE
// each quad lies in and how far out it stands, WHEN a piece is taken off the
// screen — an axis seen end-on, a plane seen edge-on, and four different reasons
// for the whole widget — and what one whole drag does to the part and says at the
// end of it.
//
// THE ONE CLAIM THIS FILE EXISTS FOR is that a drag is CONSTRAINED: the free
// drag (tools.js) turns a screen gesture into a world displacement on all three
// axes at once, and each piece puts that displacement back on its own geometry.
// Every drag below therefore travels diagonally, and the assertion is about what
// did NOT move. The origin dot is the exception that says what the other two are
// measured against: it drops nothing at all.
//
// AND THE TWO CONSTRUCTIONS ARE NOT ONE, which is the thing the quad tests are
// really guarding. An arrow takes the NEAREST POINT of its line, because a line
// and the ray through the cursor do not meet in three dimensions. A quad takes
// the point where that ray CUTS its plane, because a plane and a ray do — so
// only the quad can promise that the part follows the pointer, and the
// orthogonal projection that would be the arrow's answer read backwards is a
// DIFFERENT and wrong one for it. Face-on the two agree exactly, so every claim
// about the difference is made on an oblique camera.
//
// The arithmetic the angles and distances are checked against does not come from
// the module: this fake camera puts 20 px on a world unit along both screen axes
// (400 px per 20 halfW across, 300 px per 15 halfH up), so world +X reads 0
// degrees, world +Y reads -90 (screen y grows downwards and so does a CSS
// rotation), and world +Z — which this camera looks straight down — is the axis
// that has to disappear.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HmrViewport } from '../src/viewport/element.js'
import { EVENT_MOVED, EVENT_PROPOSALMOVE } from '../src/viewport/events.js'
import { createGizmo } from '../src/viewport/gizmo.js'
import {
  CLICK_PX, GIZMO_DOT_PX, GIZMO_MIN_SCALE, GIZMO_PLANE_GAP_PX, GIZMO_PLANE_PX,
  GIZMO_PX,
} from '../src/viewport/options.js'
import {
  fakeGroup, fakeShapeSolid, fakeViewer, fakeViewport, orthoCamera,
} from './fakes.js'

const RECT = { left: 0, top: 0, width: 800, height: 600 }

const PART = '/Group/plate'

/** Looking down the diagonal, where EVERY piece of the widget is open enough to
 *  be drawn and to be dragged.
 *
 * Square on — the default camera below — the Z arrow is end-on and two of the
 * three quads are edge-on, which is the right answer and the wrong fixture for
 * anything about a quad. The one quad that survives there is the one whose
 * plane FACES the reader, and that is the single camera where every candidate
 * construction agrees: the hand cannot produce a component along the held axis
 * at all, so no correction of any kind is applied and a drag would pass with
 * the plane arithmetic missing altogether. rings.test.js takes the same basis
 * for the same reason. */
const OBLIQUE = { right: [1, -1, 0], up: [1, 1, -2], forward: [-1, -1, -1] }

// -- the rAF loop, driven by hand ---------------------------------------------
// Same shape as handle.test.js: the module's loop re-arms itself from inside the
// frame it is running, so a snapshot is taken before the callbacks run and what
// they queue lands in the next one.
let frames = new Map()
let nextFrame = 0
const runFrames = () => {
  const due = [...frames.values()]
  frames.clear()
  for (const callback of due) callback(0)
}

const gizmos = []

beforeEach(() => {
  vi.clearAllMocks()
  frames = new Map()
  nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback) => {
    nextFrame += 1
    frames.set(nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id) => frames.delete(id))
})

afterEach(() => {
  // Before the next test dispatches on the window: a gizmo left standing would
  // leave a dead viewport's capture-phase listeners there to answer for it.
  while (gizmos.length) gizmos.pop().destroy()
  vi.unstubAllGlobals()
})

/** A solid whose world centre is `at`, as `partCentre` reads one: a bounding box
 *  computed off the tessellation and an identity `matrixWorld`. */
const PART_AT = [0, 0, 45]

const solid = (name, at = PART_AT) => fakeShapeSolid(name, {
  positions: [at[0] - 5, at[1] - 5, at[2] - 5, at[0] + 5, at[1] + 5, at[2] + 5],
  index: [0, 1, 2],
})

/**
 * A viewport with the Move tool armed over a movable part, and the arrows
 * installed over it.
 *
 * Built on the real prototype so `activeTool`, `isOverlay` and `overlayBody` are
 * the element's own — a fake that re-implemented them would let this file agree
 * with itself instead of with the code, which is the same reason tools.test.js
 * builds its viewport this way.
 *
 * `box` is the container the placement is measured against — jsdom computes no
 * layout, so it is the same rect as the canvas and the two cancel, which is
 * exactly what they do on the page.
 */
function scene({
  selected = [PART], groups = { [PART]: solid(PART) }, camera, gridSize = 100,
  tool = 'move', overlay = null,
} = {}) {
  const viewer = fakeViewer({
    camera: camera || orthoCamera(), rect: RECT, groups, gridSize,
  })
  const vp = Object.create(HmrViewport.prototype)
  Object.assign(vp, fakeViewport(viewer, { tool, selected }))
  vp.holdActive = false
  // WHICH BUILD THE GEOMETRY IS OF — on a real element written in `show()`
  // beside the payload. A fixture that left it null would test a viewport that
  // has rendered nothing.
  vp.drawnKey = 'build-1'
  // The two fields `isOverlay` reads. Null and empty is a page with no proposal
  // panel open, where every path on screen is the model's own.
  vp.payload = overlay ? { name: 'Group', parts: [] } : null
  vp.overlayParts = overlay || []
  vp.box = { getBoundingClientRect: () => ({ ...RECT }) }
  vp.dispatchEvent = vi.fn()
  // THE OTHER HALF OF THE WIDGET, as `element.js` hangs it on the element.
  // A press on any piece ends the rotation handles' gesture as well as this
  // layer's — one tool means both layers can be live at once, and two live
  // drags on one part overwrite each other (`onDown`). A stub here because this
  // file is about the arrows; `rings.test.js` runs the real pair against each
  // other.
  vp.rings = { refresh: vi.fn(), endDrag: vi.fn(), destroy: vi.fn() }
  // AND THE DOOR ONTO THE CANVAS GESTURE, which `installTools` publishes on the
  // element. A press on a piece ends that too: this layer is a sibling of
  // `vp.box`, so tools.js's own `onDown` never sees the press and never
  // concludes what it had running.
  vp.endGesture = vi.fn()
  const gizmo = createGizmo(vp)
  gizmos.push(gizmo)
  vp.gizmo = gizmo
  gizmo.refresh()
  // SEVEN PIECES IN THE ORDER THE MODULE BUILDS THEM: the three arrows, then
  // the three quads, then the origin dot. The order is not decoration — these
  // are siblings with no `z-index`, so the last built wins a press where two
  // overlap, and the filled shapes have to come after the arrows' mostly-empty
  // boxes.
  //
  // A QUAD IS NAMED FOR THE PLANE IT LIES IN and the module indexes it by the
  // axis it is NORMAL to, which are the two ways of saying the same thing: the
  // quad at index 0 holds X still and lies in YZ.
  const [x, y, z, planeYZ, planeZX, planeXY, dot] = gizmo.root.children
  return { viewer, vp, groups, gizmo, x, y, z, planeYZ, planeZX, planeXY, dot }
}

/** Wake the loop and let one frame of it run. */
const drawn = (gizmo) => {
  gizmo.refresh()
  runFrames()
}

const shown = (arrow) => arrow.style.display !== 'none'

/** The rotation the module wrote, in degrees. */
const angleOf = (arrow) => {
  const match = /rotate\((-?[\d.e-]+)deg\)/.exec(arrow.style.transform)
  expect(match, `no rotation in ${arrow.style.transform}`).toBeTruthy()
  return Number(match[1])
}

/** How much of its length the arrow is drawn at, as a fraction of `GIZMO_PX`.
 *
 * READ OFF THE SAME ELEMENT THE ROTATION IS ON, which is the widget's geometry
 * rather than a shortcut in the test. The box takes the press and the shaft and
 * head are laid out against its edges, so its width IS the length of the arrow:
 * target and drawing are one thing along that axis. The section grip keeps them
 * apart — a wrapper inside a box that never changes size — because there is only
 * one grip and nothing behind it; three arrows meet at the part, and a box
 * outliving its ink would be an invisible tail lying across the neighbour drawn
 * before it.
 */
const inkOf = (arrow) => {
  // ASSERTED ON EVERY READ: the width means nothing unless the shaft and the
  // head are the box's own children. Moved back inside a wrapper, they would be
  // drawn at whatever the wrapper's width happened to be while the box went on
  // carrying a perfectly correct number.
  expect(arrow.children.length, 'the box holds the shaft and the head').toBe(2)
  const match = /^([\d.e-]+)px$/.exec(arrow.style.width)
  expect(match, `no width in ${arrow.style.width}`).toBeTruthy()
  return Number(match[1]) / GIZMO_PX
}

/** How light a piece's own fill is, as the sum of its three channels — which is
 *  all "the casing is the light one" needs, and it needs no second copy of the
 *  hexes. rings.test.js reads its own construction the same way. */
const brightness = (el) => {
  const match = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(el.style.backgroundColor)
  expect(match, `no colour in ${el.style.backgroundColor}`).toBeTruthy()
  return Number(match[1]) + Number(match[2]) + Number(match[3])
}

/** The six numbers of the matrix a quad was placed with: the two columns are
 *  the plane's two world axes as the screen sees them, scaled to the quad's own
 *  side, and the translation is its near corner. */
const matrixOf = (quad) => {
  const match = /matrix\(([^)]*)\)/.exec(quad.style.transform)
  expect(match, `no matrix in ${quad.style.transform}`).toBeTruthy()
  return match[1].split(',').map(Number)
}

/** A press on one piece of the widget, with both refusals watched. */
function grab(arrow, [clientX, clientY]) {
  const event = new MouseEvent('pointerdown', {
    clientX, clientY, bubbles: true, cancelable: true,
  })
  vi.spyOn(event, 'stopPropagation')
  vi.spyOn(event, 'preventDefault')
  arrow.dispatchEvent(event)
  return event
}

/** The rest of the gesture. It goes to the WINDOW, which is where the press put
 *  the listeners — a drag that starts on an arrow can end anywhere. */
const pointerMove = ([clientX, clientY]) =>
  window.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY }))
const pointerUp = ([clientX, clientY]) =>
  window.dispatchEvent(new MouseEvent('pointerup', { clientX, clientY }))
const pointerCancel = () =>
  window.dispatchEvent(new MouseEvent('pointercancel', {}))

/** What was carried by every event of one name, in the order they went out. */
const details = (vp, type) => vp.dispatchEvent.mock.calls
  .map(([event]) => event)
  .filter((event) => event.type === type)
  .map((event) => event.detail)

/** Where a group ended up, as three numbers. */
const at = (group) => [group.position.x, group.position.y, group.position.z]

/** One turn of the microtask queue — both reports are deferred by exactly one
 *  (`reportProposalMove` in tools.js says why). */
const settled = () => Promise.resolve()

/**
 * A DIAGONAL drag: 200 px right and 60 px down from the same start.
 *
 * In world terms that is +10 along X and -3 along Y (20 px to the world unit on
 * both screen axes), so the free drag would produce `[10, -3, 0]` and each arrow
 * has to produce one component of it and nothing else. A drag that went straight
 * along one screen axis would pass with no projection in the module at all.
 */
const dragDiagonally = () => {
  pointerMove([300, 160])
}

/**
 * That same drag as a WORLD displacement under the oblique camera, rebuilt from
 * the basis this file declares rather than read back off the module: 10 world
 * units along `right` and -3 along `up`, at the 20 px to the world unit the
 * fixture's camera gives.
 *
 * `dragDiagonally`'s `[10, -3, 0]` is the SQUARE-ON camera's answer, and the
 * whole point of taking it obliquely is that this one has all three components
 * — so a quad that failed to hold its normal axis, or a dot that constrained
 * anything at all, would show.
 */
const unit = (v) => v.map((c) => c / Math.hypot(...v))
const RIGHT = unit(OBLIQUE.right)
const UP = unit(OBLIQUE.up)
/** The direction every pixel of this ortho canvas looks along. The module takes
 *  it from `cameraBasis().view`, which points from the eye at the target; which
 *  end of the axis it names makes no difference to anything below, because it
 *  enters the plane construction once above the line and once below it. */
const VIEW = unit(OBLIQUE.forward)
/** The scalar product, spelled out here so nothing below borrows the
 *  module's. `scalar` and not `dot`, which is taken: the origin dot is one of
 *  the seven pieces `scene()` hands back, and two different things under one
 *  name in one file is how the wrong one gets read. */
const scalar = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0)
const OBLIQUE_WORLD = RIGHT.map((v, i) => v * 10 + UP[i] * -3)

/** Where a world displacement lands ON THE SCREEN, in px — rebuilt from the
 *  basis the test declares rather than read back off the module, exactly as the
 *  oblique arrow drag above rebuilds its own answer. 20 px to the world unit on
 *  both screen axes (400 px per 20 halfW, 300 px per 15 halfH), whatever the
 *  basis, and screen y runs DOWN. */
const onScreen = (v, right = RIGHT, up = UP) =>
  [20 * scalar(v, right), -20 * scalar(v, up)]

/**
 * A camera that sees the XY quad — the plane normal to Z — at exactly `face` of
 * itself, which is the quantity `place` floors on and the quantity
 * `acrossPlane` divides by.
 *
 * `|view . z|` IS `face` BY CONSTRUCTION: the view axis is tilted out of the XY
 * plane by that cosine and the screen basis is completed round it. The eye is
 * put one `depth`-safe step back along the view axis from the part, so the
 * widget lands mid-canvas and inside the far plane whatever `face` is asked for
 * — a fixture that let the part drift to an ndc z past 1 would be testing
 * `projectPoint`'s cull instead of this floor.
 */
const facingZ = (face) => {
  const side = Math.sqrt(1 - face * face)
  const forward = [0, -side, -face]
  return orthoCamera({
    forward,
    right: [1, 0, 0],
    up: [0, face, -side],
    eye: PART_AT.map((v, i) => v - forward[i] * 15),
  })
}

/**
 * The displacement a QUAD drag should produce: the point where the ray through
 * the moved cursor cuts the plane through the point the drag started from,
 * `w - view (w.n)/(view.n)`.
 *
 * WRITTEN OUT HERE AND NOT IMPORTED, which is the whole value of it: the module
 * has its own copy and this is the independent statement of what that copy is
 * supposed to compute.
 */
const intoPlane = (normal) => OBLIQUE_WORLD.map((v, i) =>
  v - VIEW[i] * (scalar(OBLIQUE_WORLD, normal) / scalar(VIEW, normal)))

/** What the ORTHOGONAL projection would have produced instead — the nearest
 *  point of the plane rather than the one under the cursor. Kept so the tests
 *  below can show the gap rather than assert it by absence. */
const ontoPlane = (normal) => OBLIQUE_WORLD.map((v, i) =>
  v - normal[i] * scalar(OBLIQUE_WORLD, normal))

/** What `snap` lands on at the fixture's default grid of 100. */
const STEP = 0.5
const round = (v) => Math.round(v / STEP) * STEP

/** The snapped delta a quad drag lands on, with the held axis left at zero. */
const heldAt = (normal) => intoPlane(normal)
  .map((v, i) => (normal[i] ? 0 : round(v)))

describe('when there is nothing to put arrows on', () => {
  it('draws nothing while no tool is armed', () => {
    // The arrows are the MOVE TOOL's, and a widget offering a drag the press
    // would not take is a promise the page cannot keep.
    const { vp, gizmo, x } = scene()
    drawn(gizmo)
    expect(shown(x), 'the premise: they are on screen with Move armed').toBe(true)

    vp.state = { ...vp.state, tool: null }
    drawn(gizmo)
    expect(shown(x)).toBe(false)
  })

  it('draws nothing for the retired tool value', () => {
    // `turn` WAS A TOOL AND IS NOT ONE ANY MORE. It armed the rotation handles
    // alone, so the reader had to swap tools between the two halves of one
    // widget; both halves answer to `move` now. Nothing must be left answering
    // to the old value — a widget that came up under a name the interface no
    // longer writes would be unreachable and invisible in one move.
    const { gizmo, x, planeXY, dot } = scene({ tool: 'turn' })
    drawn(gizmo)
    expect([x, planeXY, dot].map(shown)).toEqual([false, false, false])
  })

  it('draws nothing while the hold key has the cut up', () => {
    // `activeTool` AND NOT `state.tool`: the hold key puts the cut up without
    // writing to `state`, so arrows read off the state field would stand there
    // offering a move while the very next press placed a section plane.
    const { vp, gizmo, x } = scene()
    drawn(gizmo)
    expect(shown(x)).toBe(true)

    vp.holdActive = true
    drawn(gizmo)
    expect(shown(x)).toBe(false)
  })

  it('draws nothing with an empty selection', () => {
    const { gizmo, x, y } = scene({ selected: [] })
    drawn(gizmo)
    expect(shown(x)).toBe(false)
    expect(shown(y)).toBe(false)
  })

  it('draws nothing when a selected path is one the scene cannot move', () => {
    // THE SAME GRABBABLE TEST `onDown` APPLIES, asked of EVERY path: one gesture
    // moves the whole row, and `movePart` refuses a row it cannot move whole. So
    // arrows over a selection carrying one path the scene has lost would advertise
    // a drag that then silently does nothing.
    const { gizmo, x } = scene({ selected: [PART, '/Group/gone'] })
    drawn(gizmo)
    expect(shown(x)).toBe(false)
  })

  it('draws nothing on a part whose centre the scene cannot give', () => {
    // A node of the tree carries no tessellation, so it has no box and no
    // centre (`partCentre`) — there is no point to stand the arrows on.
    const { gizmo, x } = scene({ groups: { [PART]: fakeGroup() } })
    drawn(gizmo)
    expect(shown(x)).toBe(false)
  })

  it('takes no gesture from an arrow the next frame would remove', () => {
    // Both halves of the module have to agree about what is grabbable — `place`
    // takes the arrow off and `onDown` takes no gesture — or a press would land
    // on an arrow that is on screen only until the next frame.
    const { vp, gizmo, x } = scene()
    drawn(gizmo)
    vp.state = { ...vp.state, selected: [] }

    grab(x, [100, 100])
    dragDiagonally()

    expect(vp.moved.size).toBe(0)
  })
})

describe('what the one tool puts on the part', () => {
  it('puts every piece of the widget up under the one tool', () => {
    // FUSION'S TRIAD IS ONE COMMAND — an origin, three arrows, three plane
    // quads and three rotation handles at once — and this is the half of it
    // that lives here. The handles are the other half and stand up under the
    // same tool; rings.test.js pins the two layers together.
    //
    // DOWN THE DIAGONAL, because square on the count would be about the camera:
    // the Z arrow is end-on and two quads are edge-on there, correctly.
    const { gizmo } = scene({ camera: orthoCamera(OBLIQUE) })
    drawn(gizmo)

    expect([...gizmo.root.children].filter(shown)).toHaveLength(7)
  })
})

describe('where the arrows are drawn', () => {
  it('stands every one of them on the part`s centre, in canvas pixels', () => {
    // The part's box is centred on the view axis, so it projects to the middle
    // of an 800x600 canvas.
    const { gizmo, x, y } = scene()
    drawn(gizmo)

    for (const arrow of [x, y]) {
      expect(shown(arrow)).toBe(true)
      expect(arrow.style.left).toBe('400px')
      expect(arrow.style.top).toBe('300px')
      // THE TAIL IS THE FIXED POINT, not the middle: an arrow stands ON the part
      // and points away along its axis, so the box is lifted by half its height
      // and turned about the middle of its left edge.
      expect(arrow.style.transform.startsWith('translate(0,-50%)')).toBe(true)
      expect(arrow.style.transformOrigin).toBe('0 50%')
    }
  })

  it('follows the part off centre', () => {
    // Four world units along +X at 20 px each is 80 px right of the middle.
    const { gizmo, x } = scene({ groups: { [PART]: solid(PART, [4, 0, 45]) } })
    drawn(gizmo)

    expect(x.style.left).toBe('480px')
    expect(x.style.top).toBe('300px')
  })
})

describe('which way they point', () => {
  it('lies along the screen direction of its own world axis', () => {
    // The camera looks down -Z with +X to the right and +Y up, and a CSS
    // rotation turns the way screen y runs — so +Y reads -90 rather than +90.
    const { gizmo, x, y } = scene()
    drawn(gizmo)

    expect(angleOf(x)).toBeCloseTo(0, 9)
    expect(angleOf(y)).toBeCloseTo(-90, 9)
  })

  it('turns with the camera and not with the world', () => {
    // A camera basis rolled by 30 degrees. The world axes are unchanged; what
    // moves is the screen they are seen on, which is the only thing the
    // projection knows about. Both screen axes are 20 px per world unit here, so
    // the tilt is not distorted.
    const roll = Math.PI / 6
    const camera = orthoCamera({
      right: [Math.cos(roll), Math.sin(roll), 0],
      up: [-Math.sin(roll), Math.cos(roll), 0],
      forward: [0, 0, -1],
    })
    const { gizmo, x } = scene({ camera })
    drawn(gizmo)

    expect(angleOf(x)).toBeCloseTo(30, 6)
  })
})

describe('how long they are drawn', () => {
  it('draws an axis square across the view at its full length', () => {
    const { gizmo, x, y } = scene()
    drawn(gizmo)
    expect(inkOf(x)).toBeCloseTo(1, 9)
    expect(inkOf(y)).toBeCloseTo(1, 9)
  })

  it('takes the axis the reader is looking down off the screen entirely', () => {
    // THE DECISION THIS WIDGET DIFFERS FROM THE SECTION GRIP ON. The grip floors
    // its ink and the stub still drags, because the fallback it drags on is a
    // different axis. An axis arrow has no fallback: the world displacement a
    // screen gesture spans lies in the plane of the screen, so an axis pointing
    // at the reader takes almost nothing from it however far the hand goes. A
    // floored stub would be a visible control that does not move the part.
    const { gizmo, x, y, z } = scene()
    drawn(gizmo)

    expect(shown(x), 'the premise: the other two are up').toBe(true)
    expect(shown(y)).toBe(true)
    expect(shown(z)).toBe(false)
  })

  it('foreshortens the three together on an oblique camera', () => {
    // Looking down the diagonal: each axis sits at the same angle to the
    // camera's projection axis, so all three are drawn at `sqrt(2/3)` — well
    // clear of the floor, so what is pinned is the PROPORTION rather than the
    // threshold.
    const camera = orthoCamera({
      right: [1, -1, 0], up: [1, 1, -2], forward: [-1, -1, -1],
    })
    const { gizmo, x, y, z } = scene({ camera })
    drawn(gizmo)

    for (const arrow of [x, y, z]) {
      expect(shown(arrow)).toBe(true)
      expect(inkOf(arrow)).toBeCloseTo(Math.sqrt(2 / 3), 9)
      expect(Math.sqrt(2 / 3)).toBeGreaterThan(GIZMO_MIN_SCALE)
    }
  })

  it('shortens the box that takes the press along with the arrow', () => {
    // WHERE THIS PARTS COMPANY WITH THE SECTION GRIP, and the reason is that
    // there are three of these. The grip holds its target at full length so it
    // stays easy to hit where it collapses, and nothing is behind it to take the
    // press from. Here a box longer than its ink lies invisibly across the
    // arrows drawn before it — the reader presses the one they can see and drags
    // the one they cannot, since the three are siblings with no `z-index` and
    // the last built wins.
    const square = scene()
    drawn(square.gizmo)
    const oblique = scene({
      camera: orthoCamera({ right: [1, -1, 0], up: [1, 1, -2], forward: [-1, -1, -1] }),
    })
    drawn(oblique.gizmo)

    expect(inkOf(oblique.x)).toBeLessThan(inkOf(square.x))
    expect(Number.parseFloat(oblique.x.style.width))
      .toBeLessThan(Number.parseFloat(square.x.style.width))
    // ACROSS the arrow nothing shrinks: the press is still taken over the full
    // `GIZMO_HIT_PX`, against a shaft of two.
    expect(oblique.x.style.height).toBe(square.x.style.height)
    expect(oblique.x.style.pointerEvents).toBe('auto')
  })
})

describe('where the quads are drawn', () => {
  it('lies in its own plane, spanned by the two arrows that bound it', () => {
    // A QUAD IS A SQUARE IN ITS PLANE, and a square under a linear map is what
    // a CSS `matrix()` draws — so the two columns are the plane's two world
    // axes as the screen sees them and nothing else can be. Square on, X reads
    // 20 px right per world unit and Y reads 20 px UP, i.e. -20 in screen
    // pixels, and both are unforeshortened: the XY quad's columns are therefore
    // the plain `(1, 0)` and `(0, -1)`, which the module scales by the quad's
    // own side through the box it puts them on.
    const { gizmo, planeXY } = scene()
    drawn(gizmo)

    expect(planeXY.style.left).toBe('400px')
    expect(planeXY.style.top).toBe('300px')
    expect(planeXY.style.width).toBe(`${GIZMO_PLANE_PX}px`)
    expect(planeXY.style.transformOrigin).toBe('0 0')

    const [ax, ay, bx, by, tx, ty] = matrixOf(planeXY)
    expect([ax, ay]).toEqual([1, 0])
    expect([bx, by]).toEqual([0, -1])
    // THE NEAR CORNER STANDS OFF ALONG BOTH, which is what keeps the quad clear
    // of the blot where the three shafts cross.
    expect(tx).toBeCloseTo(GIZMO_PLANE_GAP_PX, 9)
    expect(ty).toBeCloseTo(-GIZMO_PLANE_GAP_PX, 9)
    // AND WELL INSIDE THE ARROWHEADS, which is the other half of the
    // placement: corner plus side has to stay under one arrow's reach.
    expect(GIZMO_PLANE_GAP_PX + GIZMO_PLANE_PX).toBeLessThan(GIZMO_PX)
  })

  it('foreshortens with the two arrows it stands between', () => {
    // The quad is world geometry and has to be drawn like it: down the diagonal
    // each axis keeps `sqrt(2/3)` of itself, so each column of the matrix is
    // that long. Read as a LENGTH rather than as two numbers, because the
    // direction is the camera's business and the proportion is the claim.
    const { gizmo, planeXY } = scene({ camera: orthoCamera(OBLIQUE) })
    drawn(gizmo)

    const [ax, ay, bx, by] = matrixOf(planeXY)
    expect(Math.hypot(ax, ay)).toBeCloseTo(Math.sqrt(2 / 3), 9)
    expect(Math.hypot(bx, by)).toBeCloseTo(Math.sqrt(2 / 3), 9)
  })

  it('takes a plane seen edge-on off the screen entirely', () => {
    // THE ARROWS' OWN FLOOR, asked about the complementary quantity, and the
    // two answers are complementary too: looking straight down Z, the Z arrow
    // is gone and the XY quad is at its widest, while the two quads whose
    // planes contain Z are edge-on and go.
    //
    // FOR BOTH REASONS AT ONCE, which is what makes this floor worth two tests.
    // A square seen edge-on is a LINE lying across the two arrows that span it,
    // ready to take the presses meant for them; and its drag divides by
    // `view . n`, which is the very quantity this floors on, so the case below
    // pins that the hiding is also the fence.
    const { gizmo, z, planeYZ, planeZX, planeXY } = scene()
    drawn(gizmo)

    expect(shown(z), 'the premise: the Z arrow is the end-on one').toBe(false)
    expect(shown(planeXY), 'and its own plane is square to the reader').toBe(true)
    expect([shown(planeYZ), shown(planeZX)]).toEqual([false, false])
  })

  it('draws all three on an oblique camera', () => {
    // A third of the way round from every axis: each plane keeps `1/sqrt(3)` of
    // itself, which is clear of the floor — so what is pinned is that three
    // quads really can stand at once rather than the threshold.
    const { gizmo, planeYZ, planeZX, planeXY } = scene({
      camera: orthoCamera(OBLIQUE),
    })
    drawn(gizmo)

    expect([planeYZ, planeZX, planeXY].map(shown)).toEqual([true, true, true])
    expect(1 / Math.sqrt(3)).toBeGreaterThan(GIZMO_MIN_SCALE)
  })
})

describe('where the dot is drawn', () => {
  it('draws the dot at the centre, at a size of its own', () => {
    // NO MATRIX ON THIS ONE, which is the whole of what "free" means here: it
    // stands for a gesture with no axis and no plane in it, so there is nothing
    // about the camera for it to foreshorten to. It is centred on the part
    // rather than standing off it, so the transform is the one `translate` and
    // never changes.
    const square = scene()
    drawn(square.gizmo)
    const oblique = scene({ camera: orthoCamera(OBLIQUE) })
    drawn(oblique.gizmo)

    expect(square.dot.style.left).toBe('400px')
    expect(square.dot.style.top).toBe('300px')
    expect(square.dot.style.width).toBe(`${GIZMO_DOT_PX}px`)
    expect(square.dot.style.transform).toBe('translate(-50%,-50%)')
    expect(oblique.dot.style.transform).toBe(square.dot.style.transform)
    expect(oblique.dot.style.width).toBe(square.dot.style.width)
  })
})

describe('how the two new pieces are made legible', () => {
  it('carries a casing and a rim where the arrows carry a halo', () => {
    // THE DECISION THIS PINS. The arrows wear a `filter` halo, which works on a
    // box whose lengths are its own. A quad is drawn under the projection's own
    // 2x2 matrix and a filter is computed in the element's OWN space before
    // that matrix touches it — `rings.js` makes the same argument pointing the
    // other way, where a ring's matrix would blow a 1 px glow up to a hundred —
    // so a halo would thin away exactly as the quad turned edge-on, which is
    // where it is wanted. And both new pieces are FILLED shapes ten pixels
    // across, where 1 px of soft glow is a hairline round a block of one
    // colour, rather than 2 px shafts that are nearly all edge.
    //
    // SO BOTH TAKE THE RINGS' CONSTRUCTION: a light casing inside a dark rim,
    // as three filled boxes so that one transform carries all three.
    const { gizmo, x, planeXY, dot } = scene()
    drawn(gizmo)

    expect(x.style.filter, 'the arrow keeps its halo').toContain('drop-shadow')
    for (const piece of [planeXY, dot]) {
      expect(piece.style.filter).toBe('')
      expect(piece.style.boxShadow).toBe('')
      // Rim outside casing outside ink, each one box inside the last.
      expect(piece.children).toHaveLength(1)
      const casing = piece.firstElementChild
      expect(casing.children).toHaveLength(1)
      const ink = casing.firstElementChild
      expect(ink.children).toHaveLength(0)
      expect(brightness(casing)).toBeGreaterThan(brightness(piece))
      expect(brightness(casing)).toBeGreaterThan(brightness(ink))
    }
  })
})

describe('one whole drag', () => {
  it('moves the part along the axis grabbed and along nothing else', async () => {
    // THE WHOLE POINT OF THE WIDGET. The same gesture drives both arrows below;
    // free, it would have produced `[10, -3, 0]`, which is a delta on two axes
    // from a hand that named one.
    const across = scene()
    drawn(across.gizmo)
    const press = grab(across.x, [100, 100])
    // The press is kept off the canvas — belt and braces beside tools.js's own
    // `event.target !== g.canvas` — and the compatibility mouse events with it.
    expect(press.stopPropagation).toHaveBeenCalled()
    expect(press.preventDefault).toHaveBeenCalled()
    dragDiagonally()

    expect(at(across.groups[PART])).toEqual([10, 0, 0])

    const up = scene()
    drawn(up.gizmo)
    grab(up.y, [100, 100])
    dragDiagonally()

    expect(at(up.groups[PART])).toEqual([0, -3, 0])
  })

  it('moves nothing at all for a drag square across its own axis', () => {
    // The projection of a displacement perpendicular to the axis is zero, which
    // is the other half of "along that axis only": the part stands still rather
    // than creeping.
    const { gizmo, groups, x } = scene()
    drawn(gizmo)

    grab(x, [100, 100])
    pointerMove([100, 160])

    expect(at(groups[PART])).toEqual([0, 0, 0])
  })

  it('says where the part ended up once, and only when the hand comes off', async () => {
    // THE RELEASE IS THE ONLY REPORT, and it is the same one the canvas drag
    // ends in: the interface answers a recorded move by opening the panel, which
    // re-stages, and a re-stage ends the gesture the reader has not let go of.
    const { vp, gizmo, x } = scene()
    drawn(gizmo)

    grab(x, [100, 100])
    dragDiagonally()
    await settled()
    expect(details(vp, EVENT_MOVED), 'it spoke mid-drag').toEqual([])

    pointerUp([300, 160])
    await settled()

    const reports = details(vp, EVENT_MOVED)
    expect(reports).toHaveLength(1)
    expect(reports[0].delta).toEqual([10, 0, 0])
    expect(reports[0].paths).toEqual([PART])
    expect(reports[0].build).toBe('build-1')

    // And the gesture really ended: the window listeners went with it, so a
    // pointer that moves on past the release moves no part.
    pointerMove([500, 160])
    expect(at(vp.viewer.nestedGroup.groups[PART])).toEqual([10, 0, 0])
  })

  it('rounds to the same step the free drag rounds to', async () => {
    // ONE VOCABULARY FOR ONE DOCUMENT. `niceStep` and `snap` are imported from
    // tools.js rather than copied, so a 20 mm assembly lands on tenths here
    // exactly as it does under a free drag — `0.6` and not the
    // `0.6000000000000001` six steps of a tenth come to in binary.
    const { vp, gizmo, groups, x } = scene({ gridSize: 20 })
    drawn(gizmo)

    grab(x, [100, 100])
    pointerMove([112, 160])
    pointerUp([112, 160])
    await settled()

    expect(details(vp, EVENT_MOVED)[0].delta).toEqual([0.6, 0, 0])
    expect(vp.moved.get(PART)).toEqual({ delta: [0.6, 0, 0], turn: [0, 0, 0] })
    expect(at(groups[PART])).toEqual([0.6, 0, 0])
  })

  it('ignores every button but the primary one', () => {
    // The right button is a gesture of its own on this page — it opens the part
    // menu, and the library pans on it.
    const { vp, gizmo, groups, x } = scene()
    drawn(gizmo)

    const press = new MouseEvent('pointerdown', {
      button: 2, clientX: 100, clientY: 100, bubbles: true, cancelable: true,
    })
    vi.spyOn(press, 'preventDefault')
    x.dispatchEvent(press)
    // Not even the refusals: a press this one does not want is a press it has no
    // business taking away from anybody else.
    expect(press.preventDefault).not.toHaveBeenCalled()

    dragDiagonally()
    expect(at(groups[PART])).toEqual([0, 0, 0])
    expect(details(vp, EVENT_MOVED)).toEqual([])
  })

  it('says nothing when the press never moved', async () => {
    // A bare click on an arrow is not a placement: reported, it would write a
    // node the document already has and open the panel to show the reader
    // nothing new.
    const { vp, gizmo, x } = scene()
    drawn(gizmo)

    grab(x, [100, 100])
    pointerUp([100, 100])
    await settled()

    expect(details(vp, EVENT_MOVED)).toEqual([])
  })

  it('does nothing for a hand that shook, and everything a pixel later', async () => {
    // A CLICK IS NOT A ONE-PIXEL DRAG, which the canvas gesture spells out and
    // this one has to spell the same way. Below `CLICK_PX` there is nothing the
    // reader could have meant: nothing selects on an arrow, so the only thing a
    // twitch between press and release can do is snap the part a step and file a
    // move node — and the interface answers a filed move by opening the panel.
    //
    // A GRID THAT MAKES THE TWITCH COUNT: at 20 the step is a tenth and 20 px go
    // to the world unit, so three pixels is already three steps. Measured with a
    // step too coarse to cross, this test would pass with no threshold at all.
    const { vp, gizmo, groups, x } = scene({ gridSize: 20 })
    drawn(gizmo)
    grab(x, [100, 100])

    pointerMove([100 + CLICK_PX - 1, 100 + CLICK_PX - 1])
    expect(at(groups[PART]), 'still a click').toEqual([0, 0, 0])
    pointerUp([100 + CLICK_PX - 1, 100 + CLICK_PX - 1])
    await settled()
    expect(details(vp, EVENT_MOVED)).toEqual([])

    // And one pixel past it the same gesture is a drag, carrying the whole
    // travel from the PRESS rather than from where the threshold was crossed —
    // the part must not lag the hand by the width of the dead zone.
    grab(x, [100, 100])
    pointerMove([100 + CLICK_PX, 100])
    expect(at(groups[PART])).toEqual([CLICK_PX / 20, 0, 0])
  })

  it('keeps the part under the cursor on an oblique camera', async () => {
    // THE ONE THING DIRECT MANIPULATION HAS TO GET RIGHT, and the arithmetic
    // that gets it wrong is invisible face-on. The world vector a screen
    // displacement spans lies IN the plane of the screen, so of the axis it sees
    // only the part lying there too — `sine` of it. Walking the part by `t`
    // moves its projection by `t * sine`, and dotting that with the axis takes
    // another `sine`: a bare dot answers `t * sine^2`. Every other drag in this
    // file looks square down an axis, where `sine` is 1 and the error cannot
    // show; here it is `sqrt(2/3)`, so a missing division leaves the part at two
    // thirds of where the hand went.
    const camera = orthoCamera({
      right: [1, -1, 0], up: [1, 1, -2], forward: [-1, -1, -1],
    })
    const { vp, gizmo, groups, x } = scene({ camera })
    drawn(gizmo)

    grab(x, [100, 100])
    dragDiagonally()
    pointerUp([300, 160])
    await settled()

    // The gesture's world displacement, rebuilt from the basis this test
    // declares rather than taken from the module: 10 units along `right` and -3
    // along `up`, at the 20 px to the world unit this fixture's camera gives.
    // `dragDiagonally`'s `[10, -3, 0]` is the SQUARE-ON camera's answer and not
    // this one's.
    const unit = (v) => v.map((c) => c / Math.hypot(...v))
    const right = unit([1, -1, 0])
    const up = unit([1, 1, -2])
    const world = right.map((v, i) => v * 10 + up[i] * -3)
    const step = 0.5
    const round = (v) => Math.round(v / step) * step
    // Dotted with X — which is `world[0]` — and divided by `sine^2`.
    const along = round(world[0] / (2 / 3))

    expect(at(groups[PART])).toEqual([along, 0, 0])
    expect(details(vp, EVENT_MOVED)[0].delta).toEqual([along, 0, 0])
    // NOT WHAT A BARE DOT ANSWERS, which is the whole of the defect and the
    // reason this camera is here: face-on the two are the same number.
    expect(round(world[0])).not.toBe(along)
  })

  it('leaves the two axes it is not on exactly as it found them', async () => {
    // AN OFFSET ALREADY STANDING NEED NOT BE ON THIS GRID. It comes from the
    // proposal document, whose `delta.<axis>` fields the reader types by hand —
    // so passing all three components through `snap` rounds the two this gesture
    // never touched. A drag along X would then move the part along Y as well and
    // report it, a number written as 12.3 coming back as 12.5.
    const { vp, gizmo, groups, x } = scene({ gridSize: 20 })
    drawn(gizmo)
    vp.moved.set(PART, { delta: [0, 12.34, -0.07], turn: [0, 0, 0] })

    grab(x, [100, 100])
    pointerMove([120, 100])
    pointerUp([120, 100])
    await settled()

    expect(at(groups[PART])).toEqual([1, 12.34, -0.07])
    expect(details(vp, EVENT_MOVED)[0].delta).toEqual([1, 12.34, -0.07])
  })

  it('is concluded when the pointer is taken away', async () => {
    // A MOVE IS REPORTED FROM EVERY ENDING, which is where this parts company
    // with the section grip: a cancelled cut is dropped, and a cancelled move
    // leaves the part standing somewhere the document does not claim, so the
    // next reconcile would send it home and the drag would be silently undone.
    const { vp, gizmo, x } = scene()
    drawn(gizmo)

    grab(x, [100, 100])
    dragDiagonally()
    pointerCancel()
    await settled()

    expect(details(vp, EVENT_MOVED)).toHaveLength(1)

    // And it really ended.
    pointerMove([500, 160])
    expect(details(vp, EVENT_MOVED)).toHaveLength(1)
  })

  it('concludes a drag the scene is being pulled out from under', async () => {
    // The twin of `vp.endGesture`, and the reason it is a third call rather than
    // the same one: the press landed on a sibling of `vp.box`, so neither that
    // gesture nor the idle clock that defers the swap ever saw it.
    const { vp, gizmo, x } = scene()
    drawn(gizmo)

    grab(x, [100, 100])
    dragDiagonally()

    gizmo.endDrag()
    expect(details(vp, EVENT_MOVED), 'the report went out inside the render')
      .toEqual([])

    await settled()
    expect(details(vp, EVENT_MOVED)).toHaveLength(1)

    // And the release that never came cannot report a second time.
    pointerUp([300, 160])
    await settled()
    expect(details(vp, EVENT_MOVED)).toHaveLength(1)
  })

  it('is concluded when another press arrives with it still live', async () => {
    const { vp, gizmo, x, y } = scene()
    drawn(gizmo)

    grab(x, [100, 100])
    dragDiagonally()
    grab(y, [300, 160])
    await settled()

    expect(details(vp, EVENT_MOVED)).toHaveLength(1)
    pointerUp([300, 160])
  })

  it('edits the panel`s document for a body the proposal staged', async () => {
    // THE SECOND MEANING OF THE SAME GESTURE, and the arrows reach it through
    // the same `reportMove` the canvas drag does. A body of the proposal is the
    // reader's OWN drawing: it moves for the eye alone while the hand is down,
    // nothing is recorded for it, and the release names the body to the panel.
    const BODY = '/Group/proposal/plate'
    const { vp, gizmo, groups, x } = scene({
      selected: [BODY],
      groups: { [BODY]: solid(BODY) },
      overlay: [{ name: 'plate' }],
    })
    drawn(gizmo)
    expect(shown(x), 'the premise: a body is grabbable like any part').toBe(true)

    grab(x, [100, 100])
    dragDiagonally()
    pointerUp([300, 160])
    await settled()

    const [report] = details(vp, EVENT_PROPOSALMOVE)
    expect(report.name).toBe('plate')
    expect(report.delta).toEqual([10, 0, 0])
    expect(at(groups[BODY])).toEqual([10, 0, 0])
    // And none of what a part of the build leaves behind.
    expect(vp.moved.size, 'an offset was written for it').toBe(0)
    expect(vp.partHome.size, 'a home was remembered for it').toBe(0)
    expect(details(vp, EVENT_MOVED)).toEqual([])
  })

  it('stays on the part while the drag runs', async () => {
    // What makes this a widget the reader is holding rather than a picture
    // beside one: the anchor reads the SCENE every frame. The part's group has
    // moved by here, and the arrows are drawn from where it now stands.
    const { vp, gizmo, groups, x } = scene()
    drawn(gizmo)
    expect(x.style.left).toBe('400px')

    grab(x, [100, 100])
    dragDiagonally()
    // The scene's own matrix is what `partCentre` reads, and only a real render
    // refreshes it — so the fake is walked by hand to the place the group now
    // claims, which is what the library would have written.
    groups[PART].front.matrixWorld.elements[12] = at(groups[PART])[0]
    drawn(gizmo)

    // Ten world units at 20 px each, and nothing has been reported yet.
    expect(details(vp, EVENT_MOVED)).toEqual([])
    expect(x.style.left).toBe('600px')
  })
})

describe('one whole drag of a quad', () => {
  it('keeps the grabbed point under the cursor on an oblique plane', () => {
    // THE CLAIM THE WHOLE CONSTRUCTION EXISTS FOR, and the only one that tells
    // the two candidate formulas apart. Under an ortho camera every pixel looks
    // along one fixed direction, so the displacement that leaves the grabbed
    // point under the pointer AND in the plane is where the ray through the
    // moved cursor cuts the plane through where the drag began. The orthogonal
    // projection `w - n(w.n)` answers a different question — the nearest point
    // of the plane to where a free drag would have gone — and lags the hand by
    // whatever it threw away.
    //
    // SO THE ASSERTION IS ABOUT THE SCREEN AND NOT ABOUT THE HELD AXIS. Both
    // formulas hold the normal axis perfectly; only one of them puts the part
    // back under the cursor, so a test that checked the held axis alone would
    // pass on either.
    //
    // AND THE FACE-ON CASE CANNOT CATCH IT. Square on to a plane the normal IS
    // the view direction, so `view (w.n)/(view.n)` reduces to `n (w.n)` and the
    // two formulas are the same expression — and worse, a screen-plane
    // displacement then has no component along the normal at all, so both
    // corrections are zero and the two agree on the answer as well as on the
    // arithmetic. Only an oblique plane separates them.
    const { gizmo, groups, planeXY } = scene({ camera: orthoCamera(OBLIQUE) })
    drawn(gizmo)

    grab(planeXY, [100, 100])
    dragDiagonally()   // 200 px right and 60 px down, from the press

    // HOW CLOSE IS CLOSE ENOUGH: `snap` can move each of the plane's two world
    // coordinates by half a step, which at 20 px to the world unit is at most
    // `STEP * 20` px on the screen once both are counted. Nothing else stands
    // between the hand and the part.
    const slack = STEP * 20
    const went = onScreen(at(groups[PART]))
    expect(Math.abs(went[0] - 200)).toBeLessThan(slack)
    expect(Math.abs(went[1] - 60)).toBeLessThan(slack)

    // AND THE OLD ANSWER IS NOWHERE NEAR IT — about 40 px adrift up the screen,
    // three times the whole slack, which is what this test would have caught.
    const ortho = onScreen(ontoPlane([0, 0, 1]).map(round))
    expect(Math.abs(ortho[1] - 60)).toBeGreaterThan(3 * slack)
  })

  it('is fenced against its own divisor by the very floor that hides it', () => {
    // KEEP THESE TWO IN STEP, which is why it is a test and not a sentence in a
    // comment. `acrossPlane` divides by `view . n` and adds no guard of its
    // own; what makes that safe is that `place` hides a quad below
    // `GIZMO_MIN_SCALE` of `face`, and `face` IS `|view . n|`. They are one
    // number today. Floor `place` on something else — the projected area in px,
    // the way `RING_MIN_PX` does for a ring — and the division loses its fence
    // in silence, with every other test in this file still green.
    //
    // SO THE TRANSITION IS PINNED AT THE FLOOR ITSELF, a hundredth either side:
    // above it the quad is on screen and can be pressed, below it there is
    // nothing to press and the small divisors are unreachable.
    const camera = facingZ(GIZMO_MIN_SCALE + 0.01)
    const above = scene({ camera })
    drawn(above.gizmo)
    expect(shown(above.planeXY)).toBe(true)

    const below = scene({ camera: facingZ(GIZMO_MIN_SCALE - 0.01) })
    drawn(below.gizmo)
    expect(shown(below.planeXY)).toBe(false)

    // AND THE WORST DRAG STILL REACHABLE IS AN ORDINARY ONE. At the floor the
    // divisor is a fifth and the factor five, so the correction along the view
    // axis is large and perfectly finite — and the part still lands under the
    // cursor, which is the whole claim holding at the one camera where it is
    // under most strain.
    grab(above.planeXY, [100, 100])
    dragDiagonally()

    const went = onScreen(at(above.groups[PART]), camera.right, camera.up)
    expect(went.every(Number.isFinite), 'the divisor blew up').toBe(true)
    expect(Math.abs(went[0] - 200)).toBeLessThan(STEP * 20)
    expect(Math.abs(went[1] - 60)).toBeLessThan(STEP * 20)
    // And the axis the plane holds is still held, at the very edge of the fence.
    expect(at(above.groups[PART])[2]).toBe(0)
  })

  it('moves the part on the plane`s two axes and holds the third', async () => {
    // THE CONSTRAINT ITSELF, beside the tracking above: whatever the two axes
    // of the plane do, the third does not move at all.
    //
    // THE PREMISE IS THAT THERE WAS SOMETHING TO HOLD. Square on to the screen
    // the hand cannot produce a Z component in the first place, so this camera
    // is what makes the claim mean anything.
    expect(Math.abs(OBLIQUE_WORLD[2]), 'the drag really does reach Z')
      .toBeGreaterThan(STEP)

    const { gizmo, groups, planeXY } = scene({ camera: orthoCamera(OBLIQUE) })
    drawn(gizmo)

    grab(planeXY, [100, 100])
    dragDiagonally()

    expect(at(groups[PART])).toEqual(heldAt([0, 0, 1]))
  })

  it('takes the same two axes for whichever plane was grabbed', async () => {
    // ONE QUAD PER PLANE AND EACH ONE ITS OWN, which a single quad could not
    // show: the YZ quad has to hold X exactly as the XY quad holds Z, and each
    // meets the cursor's ray with its OWN plane. The same gesture drives both.
    const yz = scene({ camera: orthoCamera(OBLIQUE) })
    drawn(yz.gizmo)
    grab(yz.planeYZ, [100, 100])
    dragDiagonally()

    expect(at(yz.groups[PART])).toEqual(heldAt([1, 0, 0]))

    const zx = scene({ camera: orthoCamera(OBLIQUE) })
    drawn(zx.gizmo)
    grab(zx.planeZX, [100, 100])
    dragDiagonally()

    expect(at(zx.groups[PART])).toEqual(heldAt([0, 1, 0]))
  })

  it('leaves the axis it holds exactly as it found it', () => {
    // AN OFFSET ALREADY STANDING NEED NOT BE ON THIS GRID, which is the arrows'
    // own rule and the reason the held axis is handed through rather than
    // passed to `snap` with nothing added to it. The number arrives from the
    // proposal document, whose `delta.<axis>` fields the reader types by hand:
    // rounded here, a drag on the XY plane would report a Z the reader wrote as
    // 12.34 coming back as 12.5, as part of a gesture that never touched it.
    const { vp, gizmo, groups, planeXY } = scene({
      camera: orthoCamera(OBLIQUE), gridSize: 20,
    })
    drawn(gizmo)
    vp.moved.set(PART, { delta: [0, 0, 12.34], turn: [0, 0, 0] })

    grab(planeXY, [100, 100])
    dragDiagonally()

    expect(at(groups[PART])[2]).toBe(12.34)
  })

  it('says where the part ended up in the same sentence an arrow does', async () => {
    // ONE VOCABULARY FOR ONE DOCUMENT. A quad's drag ends in the same
    // `reportMove` the arrows and the canvas drag end in, so what reaches the
    // panel is a move node like any other — the same `delta`, the same paths,
    // the same build stamp, once, and only when the hand comes off.
    const { vp, gizmo, planeXY } = scene({ camera: orthoCamera(OBLIQUE) })
    drawn(gizmo)

    grab(planeXY, [100, 100])
    dragDiagonally()
    await settled()
    expect(details(vp, EVENT_MOVED), 'it spoke mid-drag').toEqual([])

    pointerUp([300, 160])
    await settled()

    const reports = details(vp, EVENT_MOVED)
    expect(reports).toHaveLength(1)
    expect(reports[0].delta).toEqual(heldAt([0, 0, 1]))
    expect(reports[0].paths).toEqual([PART])
    expect(reports[0].build).toBe('build-1')
    expect(vp.moved.get(PART))
      .toEqual({ delta: heldAt([0, 0, 1]), turn: [0, 0, 0] })
  })
})

describe('one whole drag of the origin dot', () => {
  it('moves the part on all three axes at once', async () => {
    // THE ONE PIECE THAT CONSTRAINS NOTHING, and it is what the other two are
    // measured against: the same gesture that an arrow reduces to one number
    // and a quad to two comes through here as all three.
    const { gizmo, groups, dot } = scene({ camera: orthoCamera(OBLIQUE) })
    drawn(gizmo)

    grab(dot, [100, 100])
    dragDiagonally()

    expect(at(groups[PART])).toEqual(OBLIQUE_WORLD.map(round))
    // And every component really was its own: a widget that quietly held one
    // would pass the line above on a camera that put a zero there.
    for (const v of OBLIQUE_WORLD) expect(Math.abs(v)).toBeGreaterThan(STEP)
  })

  it('is the free drag itself and not a second copy of it', async () => {
    // A SECOND DOOR TO `dragPart` IN tools.js — the very function a press on
    // the part runs — so the two cannot round differently, record differently
    // or report differently. The proof this file can give is that the answer is
    // the one the FREE drag gives and not the one any projection would: square
    // on, the hand spans `[10, -3, 0]` and nothing is dropped from it.
    const { vp, gizmo, groups, dot } = scene()
    drawn(gizmo)

    grab(dot, [100, 100])
    dragDiagonally()
    pointerUp([300, 160])
    await settled()

    expect(at(groups[PART])).toEqual([10, -3, 0])
    expect(details(vp, EVENT_MOVED)[0].delta).toEqual([10, -3, 0])
  })

  it('edits the panel`s document for a body the proposal staged', async () => {
    // THE SECOND MEANING OF THE SAME GESTURE, reached through the same
    // `reportMove`: a body of the proposal moves for the eye alone, nothing is
    // recorded for it, and the release names the body to the panel. It is the
    // arrows' case asked of the piece that goes through tools.js's own
    // function, so a dot wired to anything else would show here.
    const BODY = '/Group/proposal/plate'
    const { vp, gizmo, groups, dot } = scene({
      selected: [BODY],
      groups: { [BODY]: solid(BODY) },
      overlay: [{ name: 'plate' }],
    })
    drawn(gizmo)

    grab(dot, [100, 100])
    dragDiagonally()
    pointerUp([300, 160])
    await settled()

    const [report] = details(vp, EVENT_PROPOSALMOVE)
    expect(report.name).toBe('plate')
    expect(report.delta).toEqual([10, -3, 0])
    expect(at(groups[BODY])).toEqual([10, -3, 0])
    expect(vp.moved.size, 'an offset was written for it').toBe(0)
    expect(details(vp, EVENT_MOVED)).toEqual([])
  })
})

describe('a press that misses every piece', () => {
  it('is left for the trackball, which is what keeps the view turnable', () => {
    // THE WIDGET OWNS ITS OWN PIECES AND NOTHING ELSE. The layer covers the
    // whole canvas, so it declines presses wholesale and each piece takes its
    // own back — which is what lets a press between the arrows reach the canvas
    // underneath, where tools.js decides between grabbing the part and handing
    // the gesture to the controls. Without the split the reader would arm the
    // tool that moves a PART and lose the ability to turn the VIEW.
    //
    // IT IS ALSO WHAT LEAVES THE ROTATION HANDLES THEIRS. They read the press
    // off the canvas in a window listener, so a press this layer swallowed
    // would never get to them — one widget, two layers, and this line is the
    // only thing keeping them out of each other's way.
    const { vp, gizmo, groups } = scene()
    drawn(gizmo)

    expect(gizmo.root.style.pointerEvents).toBe('none')
    for (const piece of gizmo.root.children) {
      expect(piece.style.pointerEvents).toBe('auto')
    }

    // And a press that really does land on the layer rather than on a piece
    // starts nothing: no gesture, no refusals taken from anybody else.
    const event = new MouseEvent('pointerdown', {
      clientX: 100, clientY: 100, bubbles: true, cancelable: true,
    })
    vi.spyOn(event, 'stopPropagation')
    vi.spyOn(event, 'preventDefault')
    gizmo.root.dispatchEvent(event)
    dragDiagonally()

    expect(event.stopPropagation).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(at(groups[PART])).toEqual([0, 0, 0])
    expect(vp.moved.size).toBe(0)
  })
})

describe('a press that this layer does take', () => {
  it('ends every other gesture that could be live', () => {
    // THREE THINGS CAN BE RUNNING WHEN A PIECE IS PRESSED, and until the tools
    // were merged only the first could: this layer's own drag, the rotation
    // handles' drag, and the canvas gesture in tools.js. All three write the
    // same part through `movePart`, which sets position AND orientation
    // together from its own snapshot of the other's half — so any two of them
    // live at once overwrite each other frame by frame and both report at the
    // release.
    //
    // THE CANVAS ONE IS THE ONE A PRESS HERE CANNOT OTHERWISE REACH. tools.js
    // concludes its own previous press at the head of its `onDown`, but that
    // listener is on `vp.box` and this layer is a SIBLING of it, so a press on
    // a piece is not on its path at all. A finger on the part and then a finger
    // on an arrow leaves the free drag live, measuring from the first finger's
    // ndc to wherever the second one now is.
    //
    // THE SECTION GRIP IS THE FOURTH AND IS DELIBERATELY NOT ENDED: it drives
    // the clipping plane, and nothing it writes is anything this reads.
    const { vp, x, planeXY, dot } = scene()
    drawn(vp.gizmo)

    for (const piece of [x, planeXY, dot]) {
      vp.rings.endDrag.mockClear()
      vp.endGesture.mockClear()
      grab(piece, [100, 100])
      pointerUp([100, 100])
      expect(vp.rings.endDrag, 'the handles were left running').toHaveBeenCalled()
      expect(vp.endGesture, 'the canvas drag was left running').toHaveBeenCalled()
    }
  })
})
