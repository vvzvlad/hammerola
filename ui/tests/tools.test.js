// What a press on the canvas means: the one branch that decides it, and the
// one moment it is decided at.
//
// The branch is why `activeTool` exists. The hold key (holdkey.js) puts the cut
// up while it is down without writing `state.tool`, because the interface owns
// that field and a momentary mode editing it would leave the two disagreeing
// when a release went missing. A press that read `state.tool` would pick while
// the interface's indicator (fed by `hmr:tool`) showed a cut armed, silently.
//
// The tool is read once, at pointerdown, and lives on `press` until the gesture
// ends, so releasing the key mid-drag cannot change a cut under way.
//
// No GPU here: `internals()` is satisfied by the fake viewer, and the two calls
// a click ends in (`faceNormalAt` for the cut, `pickEntity` for the pick) are
// mocked, because which one is reached is the question. The element's real
// `activeTool` getter is used.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'

// Only the two the branch ends in are replaced; everything else in the module
// stays real, because measure.js imports from it too and a stubbed-out module
// would fail to load rather than fail a test.
vi.mock('../src/viewport/picking.js', async (importOriginal) => ({
  ...(await importOriginal()),
  faceNormalAt: vi.fn(() => null),
  pickEntity: vi.fn(() => null),
}))

import {
  EVENT_FACE, EVENT_MENU, EVENT_MOVED, EVENT_PICK, EVENT_PLACE,
} from '../src/viewport/events.js'
import { projectPoint } from '../src/viewport/camera.js'
import { internals } from '../src/viewport/internals.js'
import { CLICK_PX } from '../src/viewport/options.js'
import { faceNormalAt, pickEntity } from '../src/viewport/picking.js'
import { placeSectionPlane, sectionOffset } from '../src/viewport/section.js'
import { installTools } from '../src/viewport/tools.js'
import { menuOpened } from '../src/longpress.js'
import { makeViewport, RECT, settled } from './component.js'
import {
  fakeCapUnits, fakeGroup, fakeShapeSolid, fakeViewer, fakeViewport, orthoCamera,
  realCamera,
} from './fakes.js'

const teardowns = []

/**
 * The viewport `installTools` is handed.
 *
 * Built on the real prototype so `activeTool` is the element's own getter. Two
 * of its fields are deliberately not the real thing:
 *
 *   * `box` hands its listener back instead of being a DOM node, which is why
 *     it is spelled here rather than taken from the shared fixture. `onDown`
 *     refuses any press whose `event.target` is not the library's canvas, and
 *     the fake canvas is not a node an event could be dispatched at;
 *   * `dispatchEvent` is a spy — `makeViewport`'s, for the reason it gives
 *     there: the object's prototype chain reaches HTMLElement, but nothing
 *     built it through the DOM, so the inherited one would throw.
 */
function toolViewport(state = {}, viewer = fakeViewer()) {
  const vp = makeViewport({
    ...fakeViewport(viewer, state),
    box: {
      down: null,
      // Every listener by type, not just the press: the right-button menu also
      // needs the browser's own context menu kept off the canvas, and that is a
      // second listener on this same element.
      on: {},
      // Whether each listener is in the capture phase.
      capture: {},
      addEventListener(type, fn, capture) {
        this.on[type] = fn
        this.capture[type] = capture === true
        if (type === 'pointerdown') this.down = fn
      },
      removeEventListener() {},
    },
  })
  teardowns.push(installTools(vp))
  return vp
}

/** A press on the canvas. The event is returned so a test can ask who got it. */
function pointerDown(vp, [clientX, clientY] = [100, 100], button = 0, pointerType = 'mouse') {
  const event = {
    button,
    pointerType,
    target: vp.viewer.canvas,
    clientX,
    clientY,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  }
  vp.box.down(event)
  return event
}

/** The other button: the one the part menu hangs off. */
const rightDown = (vp, at) => pointerDown(vp, at, 2)

/** The release. It goes to the WINDOW, which is where onDown put the listener. */
function pointerUp([clientX, clientY] = [100, 100]) {
  window.dispatchEvent(new MouseEvent('pointerup', { clientX, clientY }))
}

/** A drag, to the same place. Far enough to be past CLICK_PX. */
function pointerMove([clientX, clientY]) {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY }))
}

const emitted = (vp) => vp.dispatchEvent.mock.calls.map(([event]) => event.type)

/** What was carried by every event of one name, in the order they went out. */
const details = (vp, type) => vp.dispatchEvent.mock.calls
  .map(([event]) => event)
  .filter((event) => event.type === type)
  .map((event) => event.detail)

beforeEach(() => {
  vi.clearAllMocks()
  // `clearAllMocks` clears the CALLS and leaves the implementation standing, so
  // a `mockReturnValue` set by one test goes on answering for every test after
  // it — in file order, silently, and only for the ones that never set their
  // own. Both probes go back to MISSING here, which is what the module factory
  // at the top of this file says they do.
  faceNormalAt.mockReturnValue(null)
  pickEntity.mockReturnValue(null)
})

afterEach(() => {
  // Before the next test dispatches on the window: a teardown left undone would
  // leave a dead viewport's capture-phase listeners there to answer for it.
  while (teardowns.length) teardowns.pop()()
})

describe('which branch a click takes', () => {
  it('cuts while the hold key is down, though the interface armed no tool', () => {
    const vp = toolViewport({ tool: null })
    vp.holdActive = true
    pointerDown(vp)
    pointerUp()
    expect(faceNormalAt).toHaveBeenCalledTimes(1)
    expect(pickEntity).not.toHaveBeenCalled()
    expect(emitted(vp)).not.toContain(EVENT_PICK)
  })

  it('picks when the key is not down and nothing else is armed', () => {
    const vp = toolViewport({ tool: null })
    pointerDown(vp)
    pointerUp()
    expect(pickEntity).toHaveBeenCalledTimes(1)
    expect(faceNormalAt).not.toHaveBeenCalled()
    // The background is an answer too — it is how a reader deselects.
    expect(emitted(vp)).toEqual([EVENT_PICK])
  })

  it('still honours the tool the interface armed', () => {
    // The hold key overrides `state.tool`; it does not replace it. With the key
    // up, `activeTool` has to be exactly what the interface asked for.
    const vp = toolViewport({ tool: 'measure' })
    pointerDown(vp)
    pointerUp()
    // A measure click on nothing clears the tape and redraws rather than
    // reporting a selection.
    expect(vp.overlay.refresh).toHaveBeenCalled()
    expect(emitted(vp)).not.toContain(EVENT_PICK)
  })

  it('has no branch left for the retired turn value', () => {
    // `turn` WAS A TOOL AND HAD A BRANCH HERE — `press.tool = null`, because
    // its whole gesture was on the rings and every press that reached this
    // listener had missed one. The rings answer to `move` now, so the value
    // never arrives and the branch is gone; what is pinned is that its absence
    // costs nothing, because an unknown tool falls past every branch and
    // reaches the two lines at the foot of `onDown` exactly as `comment` does.
    const vp = toolViewport({ tool: 'turn' })
    const event = pointerDown(vp)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalled()

    pointerUp()
    expect(emitted(vp)).toEqual([EVENT_PICK])
    expect(faceNormalAt).not.toHaveBeenCalled()
  })

  it('leaves the press alone under the move tool', () => {
    // The widget owns its own presses and nothing else, which keeps the model
    // turnable while a tool is armed. Every piece of the manipulator takes its
    // press in a window capture listener and stops it there, so a press that
    // reaches here missed all of them and belongs to the trackball. Without this,
    // it would fall through to the two lines at the foot of `onDown` that take
    // the press from the controls, and arming Move would stop the view turning.
    const vp = toolViewport({ tool: 'move' })
    const event = pointerDown(vp)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()

    // AND IT MEANS WHAT A PLAIN PRESS MEANS: a click still selects, so the
    // reader reaches the part they meant without leaving the tool first.
    pointerUp()
    expect(emitted(vp)).toEqual([EVENT_PICK])
    expect(faceNormalAt).not.toHaveBeenCalled()
  })

  it('keeps the cut for the whole gesture when the key goes up mid-press', () => {
    const vp = toolViewport({ tool: null })
    vp.holdActive = true
    pointerDown(vp)
    vp.holdActive = false
    pointerUp()
    expect(faceNormalAt).toHaveBeenCalledTimes(1)
    expect(pickEntity).not.toHaveBeenCalled()
  })
})

describe('a comment tool click', () => {
  // The camera looks down -Z (`orthoCamera`), so a normal with +Z in it faces
  // the reader. No zero components, so a flip is exact negation and no -0
  // stands in for a 0.
  const AWAY = [0.48, 0.6, -0.64]
  const TOWARDS = [-0.48, -0.6, 0.64]

  /** One click of the comment tool on a face whose normal the picker gives. */
  function placed(normal) {
    pickEntity.mockReturnValue({ id: '/model/plate', name: 'plate', point: [1, 2, 3] })
    faceNormalAt.mockReturnValue({ normal, point: { x: 1, y: 2, z: 3 }, info: null })
    const vp = toolViewport({ tool: 'comment' })
    pointerDown(vp)
    pointerUp()
    return details(vp, EVENT_PLACE)
  }

  it('turns a normal facing away from the reader round, so the arrow stands out', () => {
    // `faceNormalAt`'s sign is whichever way its samples wound; left as it came,
    // the comment's arrow would stand out of the back of the face, in the part.
    expect(placed(AWAY)).toEqual([
      { id: '/model/plate', name: 'plate', p: [1, 2, 3], n: TOWARDS },
    ])
  })

  it('leaves a normal already facing the reader as it is', () => {
    expect(placed(TOWARDS)).toEqual([
      { id: '/model/plate', name: 'plate', p: [1, 2, 3], n: TOWARDS },
    ])
  })

  // THE MESH'S OWN NORMAL, cast for with a real ray: a real three camera at the
  // suite's pose (`realCamera`), so the middle of the canvas looks down -Z along
  // x = y = 0. The probe rings stay mocked and answer nothing unless a case
  // says so, which is what they answer on a part a few pixels across.
  const MIDDLE = [400, 300]
  const TILTED = [0, 0.6, 0.8]
  // A triangle through (0, 0, 45) on the plane whose normal is TILTED, wound
  // towards +Z, as flat xyz runs.
  const SLOPE = [-1, -1, 45.75, 1, -1, 45.75, 0, 1, 44.25]
  // Two pixels across, so every probe ring sample falls off it, in its mesh's
  // own frame: flat on z = 0, its right edge through (0.025, 0, 0).
  const TINY = [-0.05, -0.05, 0, 0.05, -0.05, 0, 0, 0.05, 0]
  // Two pixels to the right of the middle: 0.1 along x, off TINY wherever it is
  // stood, whose reach along x = 0 is 0.025.
  const BESIDE = [MIDDLE[0] + 2, MIDDLE[1]]

  /** A solid whose `front` mesh is these triangles, as the library hangs it:
   *  flat xyz runs, or vertices and an `index` into them. */
  function solid(positions, index = null) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    if (index) geometry.setIndex(index)
    const group = new THREE.Group()
    group.front = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
    group.add(group.front)
    return group
  }

  /** A solid tilted by its mesh and stood at z = 45 by its group, so its
   *  normal is TILTED only through the world matrix. TINY becomes a latch
   *  whose right edge passes through (0.025, 0, 45). */
  function latch(positions = TINY, index = null) {
    const part = solid(positions, index)
    part.front.rotation.x = -Math.asin(0.6)
    part.position.set(0, 0, 45)
    return part
  }

  /** The `n` one comment click at `at` on the canvas sends, on `group`
   *  picked at `point` under the name `id`. */
  function sentOn(group, {
    three = THREE, point = [0, 0, 45], at = MIDDLE, id = '/model/latch',
  } = {}) {
    const model = orthoCamera()
    realCamera(THREE, model)
    const vp = toolViewport({ tool: 'comment' },
      fakeViewer({ camera: model, groups: { '/model/latch': group } }))
    vp.three = three
    pickEntity.mockReturnValue({ id, name: 'latch', point })
    pointerDown(vp, at)
    pointerUp(at)
    return details(vp, EVENT_PLACE)[0].n
  }

  const isVector = (actual, expected, message) => {
    expect(actual, message).toHaveLength(3)
    expected.forEach((v, at) => expect(actual[at], message).toBeCloseTo(v, 6))
  }

  it('takes the face normal of a part too small for the probe rings', () => {
    isVector(sentOn(latch()), TILTED)
  })

  it('takes the crossing nearest the picked point, not the nearest to the camera', () => {
    // The ray does not honour the section's clip planes, so the face at z = 50
    // can be one the cut removed; the picker, which does, saw z = 45.
    const part = solid([-1, -1, 50, 1, -1, 50, 0, 1, 50, ...SLOPE])
    isVector(sentOn(part, { point: [0, 0, 45] }), TILTED)
  })

  it('takes the normal of a small part for a click just beside it', () => {
    // The picker takes a part from a few pixels round the click, so a click
    // beside the latch picks it with the point on its edge, and the ray
    // through the click misses it. On the edge, and a hair beyond it, where
    // the ray along the view through the point misses too.
    for (const x of [0.025, 0.0251]) {
      isVector(sentOn(latch(), { at: BESIDE, point: [x, 0, 45] }), TILTED, `x = ${x}`)
    }
  })

  it('walks an indexed mesh for the nearest triangle, in the mesh\'s own frame', () => {
    // The library's meshes are indexed. Vertex 0 is in no triangle, so a walk
    // that ignored the index would take one through it. The wall on x = 0.025
    // at z = 44..46 of the mesh's frame is where the picked point's WORLD
    // coordinates fall in that frame, so a walk that never took the point into
    // it would take the wall.
    const part = latch(
      [0, 0, 5, ...TINY, 0.025, -1, 44, 0.025, 1, 44, 0.025, 0, 46],
      [1, 2, 3, 4, 5, 6])
    isVector(sentOn(part, { at: BESIDE, point: [0.0251, 0, 45] }), TILTED)
  })

  it('takes the face the view crosses at the picked point before the nearest triangle', () => {
    // A point off the surface, here 0.2 in front of the slope: of the two, the
    // reader sees the slope under it, while the wall on x = 0.1 is nearer. The
    // click a unit to the left of the point misses both.
    const part = solid([...SLOPE, 0.1, -1, 44.5, 0.1, 1, 44.5, 0.1, 0, 46.5])
    isVector(sentOn(part, { at: [MIDDLE[0] - 20, MIDDLE[1]], point: [0, 0, 45.2] }), TILTED)
  })

  it('falls back to the probe rings without the namespace, the mesh or its triangles', () => {
    faceNormalAt.mockReturnValue({ normal: TOWARDS, point: { x: 0, y: 0, z: 45 }, info: null })
    expect(sentOn(solid(SLOPE), { three: null }), 'no namespace').toEqual(TOWARDS)
    expect(sentOn(solid(SLOPE), { id: '/model/gone' }), 'no mesh').toEqual(TOWARDS)
    const bare = new THREE.Group()
    bare.front = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
    bare.add(bare.front)
    expect(sentOn(bare), 'no triangles').toEqual(TOWARDS)
  })
})

describe('who owns the press', () => {
  it('is taken from the trackball while the hold key is down', () => {
    // Otherwise the model rotates under the gesture: the library's own handler
    // runs after this capture-phase one and would start a rotation.
    const vp = toolViewport({ tool: null })
    vp.holdActive = true
    const event = pointerDown(vp)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalled()
    pointerUp()
  })

  it('is left with the trackball when no tool is in force', () => {
    // With nothing armed the press is only WATCHED, so a release that never
    // moved can be reported as a pick and the rotation stays the library's.
    const vp = toolViewport({ tool: null })
    const event = pointerDown(vp)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
    pointerUp()
  })
})

const PLATE = { id: '/model/plate', name: 'plate', point: [1, 2, 3] }

describe('the right button: a menu or a pan', () => {
  it('asks for the part menu when the press did not travel', () => {
    const vp = toolViewport({ tool: null })
    pickEntity.mockReturnValueOnce(PLATE)

    rightDown(vp, [140, 90])
    pointerUp([140, 90])

    expect(details(vp, EVENT_MENU)).toEqual([
      // The CURSOR, because that is where a context menu opens, and the
      // identifier `pickEntity` gives — the same one a selection would carry, so
      // the interface looks it up in the same tree.
      { id: '/model/plate', name: 'plate', x: 140, y: 90 },
    ])
  })

  it('says nothing when the press travelled — that was a pan', () => {
    // The library pans on this button (wheel.js), so travel is the only thing
    // that tells the two apart, and the threshold is the one already used to
    // decide a left-button press was a click.
    // Nothing is asked of `pickEntity` here, and that is part of the claim: a
    // pan must not even resolve what is under the cursor.
    const vp = toolViewport({ tool: null })

    rightDown(vp, [140, 90])
    pointerMove([140 + CLICK_PX, 90])
    pointerUp([140 + CLICK_PX, 90])

    expect(emitted(vp)).not.toContain(EVENT_MENU)
    expect(pickEntity).not.toHaveBeenCalled()
  })

  it('still opens one just under the threshold', () => {
    // The other side of the same line, so a threshold quietly changed to zero
    // (or to "any movement at all") fails here rather than making the menu
    // unreachable on a mouse that jitters.
    const vp = toolViewport({ tool: null })
    pickEntity.mockReturnValue(PLATE)

    rightDown(vp, [140, 90])
    pointerMove([140 + CLICK_PX - 1, 90])
    pointerUp([140 + CLICK_PX - 1, 90])

    expect(details(vp, EVENT_MENU)).toHaveLength(1)
  })

  it('leaves the press with the library, so panning keeps working', () => {
    // Nothing is taken here — unlike a tool's press, which is stopped in the
    // capture phase precisely so the controls never see it. Both readings of a
    // right press stay live until the release decides between them.
    const vp = toolViewport({ tool: null })
    const event = rightDown(vp)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
    pointerUp()
  })

  it('reports empty space as a menu with no id, which is how the menu closes', () => {
    // `pickEntity` misses — the state `beforeEach` puts it back into.
    const vp = toolViewport({ tool: null })

    rightDown(vp, [10, 10])
    pointerUp([10, 10])

    expect(details(vp, EVENT_MENU)).toEqual([{ id: null, name: null, x: 10, y: 10 }])
  })

  it('does not move the selection while opening a menu', () => {
    // A tree row's menu leaves the selection alone, and one menu with two
    // behaviours is worse than either. A PICK going out beside the menu is
    // exactly how the second behaviour would arrive.
    const vp = toolViewport({ tool: null })
    pickEntity.mockReturnValue(PLATE)

    rightDown(vp, [140, 90])
    pointerUp([140, 90])

    expect(emitted(vp)).toEqual([EVENT_MENU])
  })

  it('opens the menu whatever tool the interface armed', () => {
    // The tools all live on the LEFT button; this gesture is not a tool and does
    // not consult `activeTool`. A cut armed with the menu unreachable would be a
    // mode a reader has to leave in order to look at a part.
    const vp = toolViewport({ tool: 'measure' })
    pickEntity.mockReturnValue(PLATE)

    rightDown(vp, [140, 90])
    pointerUp([140, 90])

    expect(details(vp, EVENT_MENU)).toHaveLength(1)
    expect(faceNormalAt).not.toHaveBeenCalled()
  })

  it('keeps the browser\'s own menu off the canvas', () => {
    // Ours would otherwise open under the native one — and on every platform but
    // Windows the native one comes up on the PRESS, before the release that
    // opens ours has happened.
    const vp = toolViewport({ tool: null })
    const event = { preventDefault: vi.fn() }
    vp.box.on.contextmenu(event)
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('does not open on the browser\'s menu event during the press', () => {
    // That event comes on the press outside Windows; opening there would open
    // the menu at the start of every pan.
    const vp = toolViewport({ tool: null })
    pickEntity.mockReturnValue(PLATE)

    rightDown(vp, [140, 90])
    vp.box.on.contextmenu({ clientX: 140, clientY: 90, preventDefault: vi.fn() })

    expect(emitted(vp)).not.toContain(EVENT_MENU)
    pointerUp([140, 90])
  })
})

describe('a finger\'s long press', () => {
  // A phone has no right button: the long press arrives as `contextmenu` while
  // the finger is still down (ui/src/longpress.js, or Android's own).
  const touchDown = (vp, at) => pointerDown(vp, at, 0, 'touch')
  /** The long press's `contextmenu`, handed back so a test can read its mark. */
  const held = (vp, [clientX, clientY]) => {
    const event = { clientX, clientY, preventDefault: vi.fn() }
    vp.box.on.contextmenu(event)
    return event
  }

  it('opens the part menu, and its release neither picks nor closes it', () => {
    // A pick going out on the release is what would close the menu: the
    // interface shuts it on every pick. And the event is marked, so the click
    // iOS sends on the release is eaten too (longpress.js).
    const vp = toolViewport({ tool: null })
    pickEntity.mockReturnValue(PLATE)

    touchDown(vp, [140, 90])
    const event = held(vp, [140, 90])
    pointerUp([140, 90])

    expect(details(vp, EVENT_MENU)).toEqual([
      { id: '/model/plate', name: 'plate', x: 140, y: 90 },
    ])
    expect(emitted(vp)).toEqual([EVENT_MENU])
    expect(menuOpened(event)).toBe(true)
  })

  it('hears the event before the library\'s canvas stops it', () => {
    // viewer/src/core/viewer.ts stops `contextmenu` on its canvas, so only a
    // capture-phase listener on the box ever hears the long press.
    const vp = toolViewport({ tool: null })
    expect(vp.box.capture.contextmenu).toBe(true)
  })

  it('opens once, though Android\'s own event can follow ours', () => {
    const vp = toolViewport({ tool: null })
    pickEntity.mockReturnValue(PLATE)

    touchDown(vp, [140, 90])
    held(vp, [140, 90])
    held(vp, [141, 90])
    pointerUp([141, 90])

    expect(details(vp, EVENT_MENU)).toHaveLength(1)
  })

  it('takes the release from an armed tool', () => {
    // The right button's rule: the menu is reachable whatever is armed, and
    // the release that ends the press is not the tool's click.
    const vp = toolViewport({ tool: 'measure' })
    pickEntity.mockReturnValue(PLATE)

    touchDown(vp, [140, 90])
    held(vp, [140, 90])
    pointerUp([140, 90])

    expect(emitted(vp)).toEqual([EVENT_MENU])
  })

  it('is a mouse\'s plain click when the press is not a finger', () => {
    // Control-click on a Mac: a left press with the browser's menu event.
    const vp = toolViewport({ tool: null })
    pickEntity.mockReturnValue(PLATE)

    pointerDown(vp, [140, 90])
    held(vp, [140, 90])
    pointerUp([140, 90])

    expect(emitted(vp)).toEqual([EVENT_PICK])
  })
})

describe('with a section cut standing', () => {
  // The stencil cap that closes a cut carries no component id, so the picker
  // reads through it to the part flush underneath (in a browser, the cut face of
  // `plate` answered `reference_spacer`). Both buttons therefore ask about the
  // cut face first while a cut stands, through one resolver so one pixel cannot
  // name two parts; that is why this block is at the top level.
  //
  // `pickEntity` is the witness: whether it was consulted says which path a
  // press took.

  // A 2 mm cube with three inward-facing triangles (unlike the outward-wound
  // copy in `outline.test.js`). `insideSection` counts ray crossings by parity,
  // so winding cannot affect its answer, and this fixture shows that.
  const CUBE_POSITIONS = new Float32Array([
    0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0,
    0, 0, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2,
  ])
  const CUBE_INDEX = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7,
    0, 5, 4, 0, 1, 5, 3, 2, 6, 3, 6, 7,
    0, 3, 7, 0, 7, 4, 1, 2, 6, 1, 6, 5,
  ])
  /** A viewport over one cube, looking down -Z, with the real cut laid on its
   *  +z face. `standing` is the renderer's clipping flag: switched off, the
   *  plane and the seed stay exactly where they are and nothing is cut — the
   *  state `suspendSectionCut` leaves behind. */
  function plateScene({ standing = true, tool = null } = {}) {
    const camera = orthoCamera({
      eye: [0, 0, 80], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1],
    })
    const solid = fakeShapeSolid('model|plate', {
      positions: CUBE_POSITIONS, index: CUBE_INDEX,
    })
    const viewer = fakeViewer({
      camera, groups: { '/model/plate': solid },
      capUnits: fakeCapUnits([solid]), rect: RECT,
    })
    const vp = toolViewport({ tool }, viewer)
    expect(placeSectionPlane(vp, internals(viewer), [0, 0, 1], [1, 1, 1]))
      .toBe(true)
    viewer.setLocalClipping(standing)
    return { solid, viewer, vp }
  }

  /** The client pixel a world point sits under. The canvas is at the page
   *  origin here, so the NDC the module's own `projectPoint` gives is the
   *  whole of the conversion. */
  function clientOver(vp, x, y) {
    const [nx, ny] = projectPoint(internals(vp.viewer), [x, y, 0])
    return [((nx + 1) / 2) * RECT.width, ((1 - ny) / 2) * RECT.height]
  }

  it('opens the menu on the part the cut belongs to, not on what lies behind', () => {
    const { vp } = plateScene()
    const at = clientOver(vp, 1, 1)

    rightDown(vp, at)
    pointerUp(at)

    expect(details(vp, EVENT_MENU)).toEqual([
      { id: '/model/plate', name: 'plate', x: at[0], y: at[1] },
    ])
    // And the picker was never asked: its answer would be the part underneath.
    expect(pickEntity).not.toHaveBeenCalled()
  })

  it('still closes the menu on empty space while a cut stands', () => {
    // The other side of the same branch, and the one that keeps the menu
    // dismissable: a pixel the cut face does not cover falls through to the
    // picker exactly as it always did, and a miss there is still `id: null`.
    const { vp } = plateScene()
    const at = clientOver(vp, 9, 9)

    rightDown(vp, at)
    pointerUp(at)

    expect(pickEntity).toHaveBeenCalledTimes(1)
    expect(details(vp, EVENT_MENU))
      .toEqual([{ id: null, name: null, x: at[0], y: at[1] }])
  })

  it('leaves the same pixel entirely to the picker when no cut stands', () => {
    // Nothing new runs without a cut on screen. The plane and the seed are
    // exactly where the test above has them — `suspendSectionCut` keeps both,
    // so that turning the cut back on needs no second click — and the very
    // pixel that resolved to the cut face goes to `pickEntity` instead, whose
    // answer is used unchanged.
    const { vp } = plateScene({ standing: false })
    pickEntity.mockReturnValue(PLATE)
    const at = clientOver(vp, 1, 1)

    rightDown(vp, at)
    pointerUp(at)

    expect(pickEntity).toHaveBeenCalledTimes(1)
    expect(details(vp, EVENT_MENU)).toEqual([
      { id: '/model/plate', name: 'plate', x: at[0], y: at[1] },
    ])
  })

  it('selects the part the cut belongs to, not what lies behind', () => {
    // THE OTHER HALF OF THE SAME PIXEL. A right click here already named
    // `plate` while a left click named the surface the cap hides — the part
    // flush underneath, invisible at that pixel: two answers about one place,
    // and the left one a part the reader cannot see. A selection is an IDENTITY and
    // nothing more (`onPick` reads `id` and `name`), so the cap answers it as
    // completely as the picker would; measure, comment and move are the ones
    // that need a point on a real surface.
    const { vp } = plateScene()
    // WHAT LIES BEHIND, spelled out rather than left as an absent answer: with
    // the picker mocked to null the test would pass on `null` too, and the
    // failure a reverted correction produces would read "null instead of
    // plate" rather than naming the part the reader was actually given.
    pickEntity.mockReturnValue({
      id: '/model/spacer', name: 'spacer', point: [1, 1, 0],
    })
    const at = clientOver(vp, 1, 1)

    pointerDown(vp, at)
    pointerUp(at)

    const [pick] = details(vp, EVENT_PICK)
    expect({ id: pick.id, name: pick.name })
      .toEqual({ id: '/model/plate', name: 'plate' })
    expect(pickEntity).not.toHaveBeenCalled()
    // AND THE POINT IS ON THE CUT PLANE, asked of the plane itself rather
    // than pinned to a literal: the cap stands a hair inside the solid, and a
    // test carrying that offset as a number would be reporting the arithmetic
    // back to itself. `onPick` reads no point, but a caller that ever does
    // must not be handed the surface the picker would have read THROUGH.
    expect(pick.point[0]).toBeCloseTo(1, 6)
    expect(pick.point[1]).toBeCloseTo(1, 6)
    const [px, py, pz] = pick.point
    expect(internals(vp.viewer).plane.distanceToPoint({ x: px, y: py, z: pz }))
      .toBeCloseTo(0, 6)
  })

  it('places a comment on the cut face, not on what lies behind', () => {
    // The comment's arrow is depth-tested, so one placed on the surface the
    // picker reads through to would stand hidden behind the cap the reader
    // clicked. On the cap it stands on the cut plane, out along the plane's
    // normal turned to the reader (the camera looks down -Z).
    const { vp } = plateScene({ tool: 'comment' })
    pickEntity.mockReturnValue({
      id: '/model/spacer', name: 'spacer', point: [1, 1, 0],
    })
    const at = clientOver(vp, 1, 1)

    pointerDown(vp, at)
    pointerUp(at)

    const [place] = details(vp, EVENT_PLACE)
    expect({ id: place.id, name: place.name })
      .toEqual({ id: '/model/plate', name: 'plate' })
    expect(pickEntity).not.toHaveBeenCalled()
    const [px, py, pz] = place.p
    expect(px).toBeCloseTo(1, 6)
    expect(py).toBeCloseTo(1, 6)
    expect(internals(vp.viewer).plane.distanceToPoint({ x: px, y: py, z: pz }))
      .toBeCloseTo(0, 6)
    expect(place.n.map((c) => c + 0)).toEqual([0, 0, 1])
  })

  it('still deselects on empty space while a cut stands', () => {
    // The road out. If the cap answered a pixel it does not cover, a reader
    // standing in front of a cut could no longer put the selection down.
    const { vp } = plateScene()
    const at = clientOver(vp, 9, 9)

    pointerDown(vp, at)
    pointerUp(at)

    expect(pickEntity).toHaveBeenCalledTimes(1)
    expect(details(vp, EVENT_PICK))
      .toEqual([{ id: null, name: null, point: null }])
  })

  it('leaves the pick entirely to the picker when no cut stands', () => {
    // Nothing new runs without a cut on screen, the selection included: the
    // plane and the seed are where they were, and the very pixel that
    // resolved to the cut face goes to `pickEntity`, whose answer is used
    // unchanged — the POINT included, which is the field the cap would have
    // spelled differently.
    const { vp } = plateScene({ standing: false })
    pickEntity.mockReturnValue(PLATE)
    const at = clientOver(vp, 1, 1)

    pointerDown(vp, at)
    pointerUp(at)

    expect(pickEntity).toHaveBeenCalledTimes(1)
    expect(details(vp, EVENT_PICK)).toEqual([PLATE])
  })
})

describe('where the section drag says the plane ended up', () => {
  /** A viewport with the cut tool armed and a plane already laid on a face, in
   *  an orientation the drag can actually move: the fake camera looks down -Z,
   *  and a normal along X is the one whose screen projection has not collapsed. */
  function cutting() {
    const vp = toolViewport({ tool: 'cut' })
    placeSectionPlane(vp, internals(vp.viewer), [1, 0, 0], [0, 0, 0])
    vp.sectionSeed.id = '/Group/wall'
    vp.sectionSeed.name = 'wall'
    vi.clearAllMocks()
    return vp
  }

  /** A press, a drag of 200 px along the plane's own screen axis. */
  const dragFrom = (vp) => {
    pointerDown(vp, [100, 100])
    pointerMove([300, 100])
  }

  it('is announced once, at the release', () => {
    const vp = cutting()
    // Nothing is written while the drag runs: the number the interface shows is
    // a readback, and sixty of them a second is a re-render per frame.
    dragFrom(vp)
    expect(vp.state.cutOffset).toBe(0)
    expect(emitted(vp)).not.toContain(EVENT_FACE)

    pointerUp([300, 100])
    expect(emitted(vp)).toContain(EVENT_FACE)
    expect(Math.abs(vp.state.cutOffset)).toBeGreaterThan(0.5)
    expect(vp.state.cutOffset).toBeCloseTo(sectionOffset(vp), 9)
  })

  it('is announced by a SWAP that ends the gesture too', () => {
    // `show()` ends a gesture the reader has not let go of, because everything
    // it holds was measured against the scene about to be torn down, and a swap
    // can arrive mid-drag (the interface waits for the hand to come off the
    // model, up to a deadline). Without this readback `state.cutOffset` keeps
    // the depth from before the drag: the plane still lands right, since the
    // restore subtracts the same stale number, but the seed is off the clicked
    // face and the interface prints the wrong depth.
    const vp = cutting()
    dragFrom(vp)

    vp.endGesture()

    expect(emitted(vp)).toContain(EVENT_FACE)
    expect(Math.abs(vp.state.cutOffset)).toBeGreaterThan(0.5)
    expect(vp.state.cutOffset).toBeCloseTo(sectionOffset(vp), 9)
  })

  it('is still DROPPED by the two endings that always dropped it', () => {
    // `onCancel` (the platform claiming the pointer) and the leading `finish()`
    // in `onDown` (a second button or finger mid-drag) tear the listeners down
    // and report nothing, leaving `state.cutOffset` at the pre-drag depth. The
    // cut is not concluded here on purpose: answering `hmr:face` disarms the
    // armed tool, so reporting would turn the cut tool off on an interrupted
    // drag. Changing that would flip this test.
    const endings = {
      'the pointer taken away': () => window.dispatchEvent(
        new MouseEvent('pointercancel', {})),
      'a second press': (vp) => rightDown(vp, [300, 100]),
    }
    for (const [what, interrupt] of Object.entries(endings)) {
      const vp = cutting()
      const before = vp.state.cutOffset
      dragFrom(vp)

      interrupt(vp)

      expect(emitted(vp), `${what} announced the cut`).not.toContain(EVENT_FACE)
      expect(vp.state.cutOffset).toBe(before)
    }
  })

  it('says nothing when the gesture never moved the plane', () => {
    // A press the reader has not dragged is a click, and a click that a swap
    // interrupts placed nothing. Announcing an offset there would report a depth
    // for a plane that is exactly where it was.
    const vp = cutting()
    pointerDown(vp, [100, 100])

    vp.endGesture()

    expect(emitted(vp)).not.toContain(EVENT_FACE)
    expect(vp.state.cutOffset).toBe(0)
  })
})

describe('with the move tool armed', () => {
  // There is no free drag: a press under `move` takes the plain path, so the
  // trackball keeps the canvas and only the manipulator on the part (gizmo.js,
  // rings.js) moves it, taking its presses elsewhere.
  //
  // The fixtures keep a selection, because a press on empty space with a
  // standing selection is the case a drag-the-selection branch would catch.

  const PINS = ['/Group/pin', '/Group/pin(2)']

  /** The move tool, armed, with the whole row selected. */
  function moving(selected = PINS) {
    const groups = Object.fromEntries(
      [...PINS, '/Group/lid'].map((path) => [path, fakeGroup()]))
    const vp = toolViewport({ tool: 'move', selected }, fakeViewer({ groups }))
    vp.drawnKey = 'build-1'
    return { groups, vp }
  }

  /** Where a group ended up, as three numbers. */
  const at = (group) => [group.position.x, group.position.y, group.position.z]

  it('leaves a drag from empty space to the trackball, moving nothing', async () => {
    // Nothing under the cursor, a row selected, and 200 px of travel: the press
    // goes to the library and orbits the model, as with no tool armed.
    const { groups, vp } = moving()
    pickEntity.mockReturnValue(null)

    const event = pointerDown(vp, [100, 100])
    pointerMove([300, 100])
    pointerUp([300, 100])
    await settled()

    for (const path of [...PINS, '/Group/lid']) {
      expect(at(groups[path]), `${path} moved anyway`).toEqual([0, 0, 0])
    }
    expect(vp.moved.size).toBe(0)
    expect(emitted(vp)).not.toContain(EVENT_MOVED)
    // And it went to the library, which is what turns the model: nothing was
    // taken from the trackball in the capture phase.
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })

  it('still selects on a click, so the next part is reachable', async () => {
    // A press ON the selected part, released without travelling: the reader
    // reaching for another object without leaving the tool first. It selects,
    // like any click with nothing armed — and it is not taken from the
    // trackball, which is the half that would have been true of the old branch
    // only when there was nothing to grab.
    const { groups, vp } = moving()
    pickEntity.mockReturnValue({ id: PINS[0], name: 'pin', point: [1, 2, 3] })

    const event = pointerDown(vp, [100, 100])
    pointerUp([100, 100])
    await settled()

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(details(vp, EVENT_PICK)).toEqual([
      { id: PINS[0], name: 'pin', point: [1, 2, 3] },
    ])
    expect(at(groups[PINS[0]])).toEqual([0, 0, 0])
    expect(emitted(vp)).not.toContain(EVENT_MOVED)
  })
})

