// ui/src/viewport/scene3d.js — the scaffolding of a widget that lives IN the
// library's scene rather than over it.
//
// Three is the real one, imported from the committed file the hub serves
// (`static/_v/three.module.js`, the same file hatch.test.js and outline.test.js
// read as text), because the module's claims are three's own arithmetic: a
// group in a scene, a uniform scale, material flags, layers and a ray cast
// through a camera. No GPU and no pixels; a `Scene` and a `Raycaster` need
// neither.
//
// A frame is driven by the library, not a timer: the widget is placed in the
// fork's `onBeforeRender` at the top of `Viewer.update`, so `rendered(viewer)`
// is a frame the library drew, and `framesAsked()` is checked after every test.
// A widget with its own loop would be invisible on an idle page.
//
// The camera is two objects. `orthoCamera()` is the suite's own model of an
// ortho projection; `realCamera()` puts a real `THREE.OrthographicCamera` where
// `getCamera()` answers, for the tests that cast a ray. The two share a pose,
// which the press block asserts first.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'

import { internals } from '../src/viewport/internals.js'
import {
  GIZMO_ORDER, HANDLE_ORDER, PINS_ORDER, RINGS_ORDER, createScene3D, joinPresses,
  widgetMaterial,
} from '../src/viewport/scene3d.js'
import { RECT, framesAsked, rendered, stubFrames } from './component.js'
import { fakeViewer, fakeViewport, orthoCamera, realCamera } from './fakes.js'

const widgets = []

beforeEach(() => {
  vi.clearAllMocks()
  // STUBBED SO THAT NOTHING CAN ASK FOR A FRAME UNSEEN, and not so that frames
  // can be driven: nothing in this file runs one.
  stubFrames()
})

afterEach(() => {
  // Before the next test dispatches on the window: a widget left standing would
  // leave a dead viewport's capture-phase listeners there to answer for it.
  while (widgets.length) widgets.pop().destroy()
  // NOT ONE ANIMATION FRAME, in any test above — the whole point of placing a
  // scene widget from the render pass. An idle page with a cut standing on it
  // asks for nothing, and a loop creeping back in beside the render is the one
  // failure every other assertion here would stay green through.
  expect(framesAsked(), 'a widget in the scene asks for no frames').toBe(0)
  vi.unstubAllGlobals()
})

/** The size of the test widget's one mesh, in the module's units — pixels. */
const BOX_PX = 20

/**
 * A viewport with a scene on it and one widget standing in the scene.
 *
 * The canvas is a real node: the press is read in a capture-phase window
 * listener that declines any target but the canvas. The rect is stubbed because
 * jsdom computes no layout.
 *
 * `place` puts the group at the origin and `press` takes every press, unless a
 * test says otherwise.
 */
function stage({
  camera, wanted = () => true, place, press, cut = true, order = HANDLE_ORDER,
} = {}) {
  const model = camera || orthoCamera()
  const viewer = fakeViewer({ camera: model, rect: RECT })
  const canvas = document.createElement('div')
  canvas.getBoundingClientRect = () => ({ ...RECT })
  document.body.appendChild(canvas)
  viewer.canvas = canvas
  viewer.renderer.domElement = canvas
  viewer.scene = new THREE.Scene()

  const vp = fakeViewport(viewer, { cut })
  const built = []
  const calls = { place: 0, press: 0 }
  const widget = createScene3D(vp, {
    wanted,
    build(three, group) {
      const mesh = new three.Mesh(
        new three.BoxGeometry(BOX_PX, BOX_PX, BOX_PX),
        widgetMaterial(three, 0x2f353d))
      group.add(mesh)
      built.push(mesh)
    },
    place(group, g) {
      calls.place += 1
      if (place) return place(group, g)
      group.position.set(0, 0, 45)
      return true
    },
    press(event, g, hit) {
      calls.press += 1
      return press ? press(event, g, hit) : true
    },
    cursor: 'grab',
    order,
  })
  widgets.push(widget)
  return { model, viewer, vp, canvas, widget, built, calls }
}

/** The one group of ours in the scene, or null. */
const inScene = (viewer) => viewer.scene.children.find((child) => child.isGroup) || null

/** Put the widget in the scene and let the library draw one frame. */
function drawn(s) {
  s.widget.attach(THREE)
  rendered(s.viewer)
  return inScene(s.viewer)
}

/** A press on the canvas, with both refusals watched. */
function pressAt(canvas, [clientX, clientY], button = 0) {
  const event = new MouseEvent('pointerdown', {
    button, clientX, clientY, bubbles: true, cancelable: true,
  })
  vi.spyOn(event, 'stopImmediatePropagation')
  vi.spyOn(event, 'preventDefault')
  canvas.dispatchEvent(event)
  return event
}

/** A move over the canvas, which is where the hover cursor is read. */
const moveAt = (canvas, [clientX, clientY]) =>
  canvas.dispatchEvent(new MouseEvent('pointermove', {
    clientX, clientY, bubbles: true,
  }))

describe('the group and the scene it stands in', () => {
  it('builds nothing at all until it is given the namespace', () => {
    // `attach` is called from `show()` with whatever the loader handed back, and
    // a build that answered without a `THREE` on it is a page whose viewer came
    // from somewhere this code does not recognise. The reader still gets their
    // model; they get no widgets, and nothing throws on the render path.
    const s = stage()
    s.widget.attach(undefined)
    rendered(s.viewer)

    expect(inScene(s.viewer)).toBeNull()
    expect(s.built).toHaveLength(0)
    expect(s.calls.place).toBe(0)
  })

  it('joins the scene that is on screen, and is the same group in the next one', () => {
    // THE POINT OF THE WHOLE LIFECYCLE. `clear()` disposes the scene it is given
    // and `render()` builds a NEW one, so the group has to be moved rather than
    // rebuilt — rebuilt, it would be a fresh geometry and a fresh material per
    // build the reader opens, and the old ones would already have been freed
    // underneath the widget that was still using them.
    const s = stage()
    const group = drawn(s)
    expect(group).not.toBeNull()
    expect(s.built).toHaveLength(1)

    const next = new THREE.Scene()
    s.viewer.scene = next
    s.widget.attach(THREE)

    expect(next.children).toContain(group)
    expect(s.built, 'built once, not once per scene').toHaveLength(1)
  })

  it('leaves the scene on detach, keeping everything it is made of', () => {
    // What `show()` calls one line before `viewer.clear()`, which deep-disposes
    // everything still in the scene. The geometry surviving is the half that
    // cannot be seen without asking: a disposed one goes on drawing until the
    // renderer next uploads it.
    const s = stage()
    const group = drawn(s)
    const geometry = s.built[0].geometry
    const spy = vi.spyOn(geometry, 'dispose')

    s.widget.detach()

    expect(s.viewer.scene.children).not.toContain(group)
    expect(group.parent).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('is put into the scene once, however often it is attached', () => {
    const s = stage()
    drawn(s)
    s.widget.attach(THREE)
    s.widget.attach(THREE)
    expect(s.viewer.scene.children.filter((child) => child.isGroup)).toHaveLength(1)
  })
})

describe('the frame', () => {
  it('is placed BY the render, from the hook the fork calls at the top of it', () => {
    // THE WHOLE FIX. The library renders on demand and it is the render that
    // puts the widget where it belongs, in the very frame that then draws it —
    // so the placement is reachable through `viewer.onBeforeRender` and through
    // nothing else. Placed from a loop beside the render instead, the group
    // stands in the scene perfectly positioned and nothing is on screen until
    // something happens to repaint, which is what was measured in a browser.
    const s = stage()
    s.widget.attach(THREE)
    expect(typeof s.viewer.onBeforeRender, 'the widget is on the hook').toBe('function')

    const before = s.calls.place
    s.viewer.onBeforeRender()
    expect(s.calls.place).toBe(before + 1)
  })

  it('places what there is to draw on every frame the library draws', () => {
    const s = stage()
    const group = drawn(s)
    expect(group.visible).toBe(true)

    const before = s.calls.place
    rendered(s.viewer)
    expect(s.calls.place).toBe(before + 1)
  })

  it('moves for nothing until the library draws again', () => {
    // A TIMER WOULD NOT LEAVE IT ALONE, which is how this test tells the two
    // arrangements apart: the camera has moved and nothing has rendered, so the
    // group is exactly as the last frame left it — and it catches up in the
    // frame that draws it, not a sixtieth of a second before one.
    const s = stage()
    const group = drawn(s)
    const was = group.scale.x
    const before = s.calls.place

    s.model.zoom = 2
    expect(s.calls.place, 'nothing placed it').toBe(before)
    expect(group.scale.x, 'and nothing moved it').toBe(was)

    rendered(s.viewer)
    expect(s.calls.place).toBe(before + 1)
    expect(group.scale.x).toBeCloseTo(was / 2, 12)
  })

  it('asks for no render from inside one, which is how a loop would come back', () => {
    // A `refresh` reached from `place` would be a render asking for a render:
    // the library would repaint every frame it painted, for ever, and the page
    // would look exactly right while burning a core.
    const s = stage()
    drawn(s)
    s.viewer.update.mockClear()

    rendered(s.viewer)
    expect(s.viewer.update).toHaveBeenCalledTimes(1)
  })

  it('takes it off the screen on the frame that finds nothing to draw', () => {
    // `wanted` is asked on every frame rather than remembered, and the frame
    // that reads it false is the same frame that hides the group — so a cut
    // going away needs a frame and nothing else: no synchronous hide anywhere.
    let cut = true
    const s = stage({ wanted: () => cut })
    const group = drawn(s)
    expect(group.visible).toBe(true)

    cut = false
    rendered(s.viewer)
    expect(group.visible).toBe(false)
  })

  it('takes the widget off screen when the widget declines the frame', () => {
    // `place` ANSWERS rather than hiding, and this is the half of that contract
    // a widget owns: a grip whose plane it cannot read says so and the shared
    // flag goes off. Two owners of one flag would be a widget that flickers on
    // whichever of them ran last.
    let standing = true
    const s = stage({ place: (group) => { group.position.set(0, 0, 45); return standing } })
    const group = drawn(s)
    expect(group.visible).toBe(true)

    standing = false
    rendered(s.viewer)
    expect(group.visible).toBe(false)
  })
})

describe('`refresh` is asking the library to draw', () => {
  it('asks for a frame, which is the one thing it means now', () => {
    // FOR A CHANGE THE LIBRARY DID NOT MAKE ITSELF — in practice the cut
    // appearing or going away (`reconcile` in element.js). Everything else a
    // widget follows already ends in a render of the library's own, and the
    // hook places it in that same frame.
    //
    // `(true, false)` is the call the rest of this codebase makes (parts.js):
    // the orientation marker keeps up, and nothing is notified, because no
    // state the interface holds has changed.
    const s = stage()
    drawn(s)
    s.viewer.update.mockClear()

    s.widget.refresh()
    expect(s.viewer.update).toHaveBeenCalledTimes(1)
    expect(s.viewer.update).toHaveBeenCalledWith(true, false)
  })

  it('asks for nothing when there is nothing to draw and nothing drawn', () => {
    // THE WHOLE POINT OF THE GUARD. The only caller is `reconcile` in
    // element.js, which runs on every `hmr:state` -- and that, by its own
    // comment there, arrives on every click in the tree. A render is the whole
    // scene plus the grid and the orientation marker, so a page whose reader has
    // never opened a section must not pay for one on every click.
    const s = stage({ wanted: () => false })
    s.widget.attach(THREE)
    s.viewer.update.mockClear()

    s.widget.refresh()
    expect(s.viewer.update).not.toHaveBeenCalled()
  })

  it('asks for exactly one when what was drawn has to come off', () => {
    // THE OTHER HALF, and the half whose absence is VISIBLE: a cut going away
    // leaves the grip standing on the model until the reader happens to touch
    // something else. One frame takes it off -- and then no more, because after
    // it there is neither anything to draw nor anything drawn.
    let cut = true
    const s = stage({ wanted: () => cut })
    const group = drawn(s)
    expect(group.visible).toBe(true)
    s.viewer.update.mockClear()

    cut = false
    s.widget.refresh()
    expect(s.viewer.update).toHaveBeenCalledTimes(1)
    expect(group.visible, 'and that frame is what took it off').toBe(false)

    s.viewer.update.mockClear()
    s.widget.refresh()
    expect(s.viewer.update, 'and not one after that').not.toHaveBeenCalled()
  })

  it('asks for one when the group joins a scene that has already been drawn', () => {
    // `show()` attaches on the far side of `render()`, so the frame that built
    // the scene had no group of ours in it. Without this the grip is missing
    // until the reader happens to touch something — which is the same failure
    // the loop had, one scene swap later.
    const s = stage()
    s.viewer.update.mockClear()

    s.widget.attach(THREE)
    expect(s.viewer.update).toHaveBeenCalledWith(true, false)
    expect(s.calls.place, 'and that frame placed it').toBe(1)
  })
})

describe('the one hook on the viewer', () => {
  /** A second widget in the same scene, as the next slices will bring. */
  function second(s) {
    const calls = { place: 0 }
    const widget = createScene3D(s.vp, {
      wanted: () => true,
      build(three, group) { group.add(new three.Mesh(new three.BoxGeometry(1, 1, 1),
                                                     widgetMaterial(three, 0))) },
      place(group) { calls.place += 1; group.position.set(0, 0, 45); return true },
      press: () => true,
      cursor: 'grab',
    })
    widgets.push(widget)
    return { widget, calls }
  }

  it('fans one field out to every widget standing in the scene', () => {
    // The library has ONE `onBeforeRender` and several widgets are coming, so
    // the second one to attach has to join what the first installed rather than
    // assign over it — which would leave the grip in the scene, correctly
    // placed by nobody.
    const s = stage()
    drawn(s)
    const other = second(s)
    other.widget.attach(THREE)

    const before = [s.calls.place, other.calls.place]
    rendered(s.viewer)
    expect(s.calls.place).toBe(before[0] + 1)
    expect(other.calls.place).toBe(before[1] + 1)
  })

  it('hands the field back to what was there when the last widget goes', () => {
    // The field is the library's and we are borrowing it. Kept as the literal
    // thing to put back rather than a hard null, for the reason the pinch guard
    // keeps `noRotate`'s previous value: the restore stays correct on its own
    // terms the day somebody else uses the field.
    const was = vi.fn()
    const s = stage()
    s.viewer.onBeforeRender = was
    drawn(s)
    const other = second(s)
    other.widget.attach(THREE)
    expect(s.viewer.onBeforeRender).not.toBe(was)

    s.widget.destroy()
    widgets.splice(widgets.indexOf(s.widget), 1)
    expect(s.viewer.onBeforeRender, 'one widget is still on it').not.toBe(was)

    other.widget.destroy()
    widgets.splice(widgets.indexOf(other.widget), 1)
    expect(s.viewer.onBeforeRender).toBe(was)
  })

  it('leaves a hook somebody else assigned over ours exactly where it is', () => {
    // Taking the field back from whoever owns it now would break them rather
    // than tidy up — the same rule `installPinchGuard` applies to
    // `viewer.update`, which it restores only while the wrapper is still its
    // own.
    const s = stage()
    drawn(s)
    const theirs = vi.fn()
    s.viewer.onBeforeRender = theirs

    s.widget.destroy()
    widgets.splice(widgets.indexOf(s.widget), 1)
    expect(s.viewer.onBeforeRender).toBe(theirs)
  })
})

describe('one unit of geometry is one pixel', () => {
  it('scales the group by the frustum over the canvas', () => {
    // The whole of "constant pixel size": 30 world units of frustum height over
    // 600 px of canvas is a twentieth of a world unit per pixel, so the 20-unit
    // box above is 20 px on screen — on a 2 mm part and on a 200 mm one alike,
    // which is what the numbers in options.js are written in.
    const s = stage()
    const group = drawn(s)
    expect(group.scale.x).toBeCloseTo(30 / 600, 12)
    // UNIFORM, or the box would be a different size along each screen axis on a
    // canvas that is not square — this one is 800x600.
    expect(group.scale.y).toBe(group.scale.x)
    expect(group.scale.z).toBe(group.scale.x)
  })

  it('follows the zoom, because the frustum the reader sees is divided by it', () => {
    // `OrthographicCamera.updateProjectionMatrix` divides the frustum by `zoom`,
    // so the world a pixel covers halves when the reader zooms in twice — and a
    // widget that did not follow would double in size on screen.
    const s = stage()
    const group = drawn(s)
    const before = group.scale.x

    s.model.zoom = 2
    rendered(s.viewer)
    expect(group.scale.x).toBeCloseTo(before / 2, 12)
  })

  it('draws nothing at all on a camera it cannot measure', () => {
    // The viewport is orthographic BY CONSTRUCTION (options.js), and a
    // perspective camera would need the widget's distance from the eye as well.
    // Nothing here has ever seen one, so a guess would be a size that is wrong
    // by however far the handle is from the camera — with nothing on screen
    // saying so. An undrawn widget is the honest answer.
    const s = stage()
    const group = drawn(s)
    expect(group.visible).toBe(true)

    s.model.cam.isOrthographicCamera = false
    rendered(s.viewer)
    expect(group.visible).toBe(false)
  })

  it('draws nothing on a canvas of no size', () => {
    // A viewport mid-layout, or one on a hidden tab: the division would be by
    // zero and the group would take a scale of Infinity into the scene.
    const s = stage()
    const group = drawn(s)
    s.viewer.canvas.getBoundingClientRect = () => ({ ...RECT, height: 0 })

    rendered(s.viewer)
    expect(group.visible).toBe(false)
  })
})

describe('what a handle promises the rest of the scene', () => {
  it('is never hidden, never cut and never graded', () => {
    // Three flags, three different silent failures. Depth-tested, half the grip
    // disappears into the face it is standing on. Clipped, the widget that moves
    // the section is cut by the section — and the library clips PER MATERIAL, so
    // an empty list is all it takes to be left out. Tone mapped, the ink is
    // graded towards a colour nobody chose.
    const s = stage()
    drawn(s)
    const material = s.built[0].material
    expect(material.depthTest).toBe(false)
    expect(material.clippingPlanes).toEqual([])
    expect(material.toneMapped).toBe(false)
  })

  it('is drawn after the model, its edges and the section contour', () => {
    // The library puts its own edges and translucent faces at 999 and its
    // highlight points at 1000, and the section contour takes that same 1000
    // (outline.js). A handle has to be above all of them or it is drawn into the
    // part it is a handle for — and WHICH of the four bands it takes is the
    // caller's to say, because being drawn over the others is a fact about the
    // set of widgets rather than about this scaffolding.
    //
    // The comment arrows are the one band BELOW 1000: they are depth-tested
    // objects of the model, and from 1000 up the library's depth peeling draws
    // them in its overlay pass, over the composited glass at full strength
    // (`OVERLAY_RENDER_ORDER`). Still the lowest band, so every control keeps a
    // press over an arrow.
    const s = stage({ order: GIZMO_ORDER })
    const group = drawn(s)
    expect(group.renderOrder).toBe(GIZMO_ORDER)
    for (const band of [RINGS_ORDER, HANDLE_ORDER, GIZMO_ORDER]) {
      expect(band, `${band}`).toBeGreaterThan(1000)
    }
    expect(PINS_ORDER).toBeLessThan(1000)
    expect(PINS_ORDER).toBeLessThan(Math.min(RINGS_ORDER, HANDLE_ORDER, GIZMO_ORDER))
  })

  it('stays on layer 0, where the id-picker never looks', () => {
    // The picker renders the scene BY CAMERA LAYER and marks what is pickable
    // with `layers.enable` (viewer/src/rendering/id-picking.ts), so an object
    // left on the visual layer alone never reaches the pick buffer: the model
    // goes on being pickable straight through a handle standing in front of it,
    // and no comment anywhere has to ask a widget to opt out.
    //
    // A mask of 1 is layer 0 and nothing else — the value `new Layers()` starts
    // at, which is exactly the claim.
    const s = stage()
    const group = drawn(s)
    expect(group.layers.mask).toBe(1)
    for (const child of group.children) expect(child.layers.mask).toBe(1)
  })
})

describe('the press', () => {
  /** The same stage with a REAL camera in the place `getCamera()` answers with. */
  function aimed(options = {}) {
    const model = orthoCamera()
    realCamera(THREE, model)
    return stage({ ...options, camera: model })
  }

  it('is cast through the camera the model is drawn with', () => {
    // THE PREMISE OF EVERY TEST BELOW, asserted rather than assumed: the real
    // camera installed for the raycaster is the same pose this directory's own
    // model projects with, so a point that lands in the middle of the canvas by
    // one lands there by the other. Without this the ray could be perfectly
    // right about a camera nothing else in the suite believes in.
    const s = aimed()
    const g = internals(s.viewer)
    const at = new THREE.Vector3(6, -3, 45).project(g.cam)
    const [x, y] = s.model.project([6, -3, 45])
    expect(at.x).toBeCloseTo(x, 12)
    expect(at.y).toBeCloseTo(y, 12)
  })

  it('takes a press the ray lands on, and suppresses it only then', () => {
    // The refusal keeps the trackball off: tools.js listens in the capture phase
    // on the container and the library's controls on the canvas, and either would
    // orbit the model while dragging the handle. `stopImmediatePropagation` also
    // sets the propagation flag, so a `stopPropagation` beside it would change
    // nothing. `preventDefault` suppresses the compatibility mouse events, so the
    // press cannot become a double-click elsewhere.
    const s = aimed()
    drawn(s)

    const event = pressAt(s.canvas, [400, 300])
    expect(s.calls.press).toBe(1)
    expect(event.stopImmediatePropagation).toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('takes the press away from the OTHER window listener too, not just onward', () => {
    // The press is refused on the window in the capture phase, and
    // `stopPropagation` does not reach a second listener on the same node.
    // Without `stopImmediatePropagation`, a window listener added after the
    // widgets' own would still see a press one of them had taken. Which of two
    // widgets keeps a contested press is the paint band, tested below.
    const s = aimed()
    drawn(s)
    const later = vi.fn()
    addEventListener('pointerdown', later, true)
    try {
      pressAt(s.canvas, [400, 300])
      expect(s.calls.press).toBe(1)
      expect(later).not.toHaveBeenCalled()
      // And a press that misses still reaches it, or the guard above would be
      // indistinguishable from a listener that never fires at all.
      pressAt(s.canvas, [700, 550])
      expect(later).toHaveBeenCalledTimes(1)
    } finally {
      removeEventListener('pointerdown', later, true)
    }
  })

  it('leaves a press that misses completely alone', () => {
    // The whole purchase of reading the press off the CANVAS instead of hanging
    // a listener on something: a press that misses is not ours, so it goes on to
    // the tools' own listener and to the trackball behind it, and the reader can
    // still orbit, pick and open the part menu with a widget on screen.
    const s = aimed()
    drawn(s)

    const event = pressAt(s.canvas, [700, 550])
    expect(s.calls.press).toBe(0)
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('leaves alone a press the widget itself declines', () => {
    // Which buttons a widget answers to is the widget's own business, and a
    // press it does not want is a press it has no business taking away from
    // anybody else — the right button is the part menu and the library's pan.
    const s = aimed({ press: () => false })
    drawn(s)

    const event = pressAt(s.canvas, [400, 300], 2)
    expect(s.calls.press).toBe(1)
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('ignores a press that landed on anything but the canvas', () => {
    // The listener is on the WINDOW, so every press on the page goes past it:
    // the tree, the panels, the view cube and the four layers stacked over the
    // canvas. Without this guard a click on a button would be read as a press on
    // whatever the widget happens to be standing under.
    const s = aimed()
    drawn(s)

    const elsewhere = document.createElement('div')
    document.body.appendChild(elsewhere)
    const event = pressAt(elsewhere, [400, 300])

    expect(s.calls.press).toBe(0)
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
  })

  it('ignores a press while nothing is on screen', () => {
    // three's raycaster tests an object's LAYERS and never its visibility, so
    // the module has to ask about `group.visible` itself. Without that line a
    // widget the last frame took off the screen would go on answering presses
    // at wherever it was last placed — an invisible grip stealing the reader's
    // orbit.
    let cut = true
    const s = aimed({ wanted: () => cut })
    const group = drawn(s)
    cut = false
    rendered(s.viewer)
    expect(group.visible).toBe(false)

    const event = pressAt(s.canvas, [400, 300])
    expect(s.calls.press).toBe(0)
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
  })

  it('reads where the last frame put it, whether or not one composed the group', () => {
    // A press does not know which frame it is standing on: the renderer composes
    // the group on its way out of every frame that placed it, but a group that
    // has just joined a scene nothing has drawn has no world matrix at all — and
    // there is no renderer here to build one either. So the router composes it
    // before it casts, and the ray meets the widget where `place` put it.
    const s = aimed({ place: (group) => { group.position.set(12, 0, 45); return true } })
    drawn(s)

    // 12 world units right of the middle, at 20 px each on this camera.
    expect(pressAt(s.canvas, [400, 300]).stopImmediatePropagation).not.toHaveBeenCalled()
    expect(pressAt(s.canvas, [640, 300]).stopImmediatePropagation).toHaveBeenCalled()
  })

  it('cannot be pressed from behind the reader', () => {
    // Under an ortho projection the frustum has a back and the model turns
    // through it. The ray starts at the camera's near plane, so a widget behind
    // it is at a negative distance and is not intersected — which is the same
    // answer the renderer gives by culling it, and the reason this file does not
    // ask `place` about depth.
    const s = aimed({ place: (group) => { group.position.set(0, 0, 90); return true } })
    drawn(s)

    expect(pressAt(s.canvas, [400, 300]).stopImmediatePropagation).not.toHaveBeenCalled()
  })
})

describe('the one press listener on a viewport', () => {
  // NO GEOMETRY AND NO RAY: each participant here is a bare `take` that says
  // yes or no, so what is measured is the dispatcher's choice and nothing a
  // widget does before it answers.
  function join(vp, order, takes) {
    const take = vi.fn(() => takes)
    widgets.push({ destroy: joinPresses(vp, order, take) })
    return take
  }

  it('gives the press to the highest band, whatever order the bands joined in', () => {
    const vp = {}
    const one = join(vp, 1, true)
    const two = join(vp, 2, true)
    const three = join(vp, 3, true)

    const event = pressAt(document.body, [400, 300])
    expect(three).toHaveBeenCalledTimes(1)
    expect(two).not.toHaveBeenCalled()
    expect(one).not.toHaveBeenCalled()
    expect(event.stopImmediatePropagation).toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('passes it down to the next band when the top one declines', () => {
    const vp = {}
    const one = join(vp, 1, true)
    const two = join(vp, 2, true)
    const three = join(vp, 3, false)

    pressAt(document.body, [400, 300])
    expect(three).toHaveBeenCalledTimes(1)
    expect(two).toHaveBeenCalledTimes(1)
    expect(one).not.toHaveBeenCalled()
  })

  it('asks equal bands in the order they joined', () => {
    const vp = {}
    const first = join(vp, 1, true)
    const second = join(vp, 1, true)

    pressAt(document.body, [400, 300])
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  it('leaves the window with the last participant and comes back for the next', () => {
    // A viewport put back into the document builds its widgets again on the
    // same `vp`, and they have to find a dispatcher that listens.
    const removed = vi.spyOn(globalThis, 'removeEventListener')
    try {
      const vp = {}
      const a = vi.fn(() => false)
      const leaveA = joinPresses(vp, 1, a)
      const leaveB = joinPresses(vp, 2, () => false)

      leaveB()
      pressAt(document.body, [400, 300])
      expect(a).toHaveBeenCalledTimes(1)
      expect(removed).not.toHaveBeenCalledWith('pointerdown', expect.any(Function), true)

      leaveA()
      leaveA()
      expect(removed).toHaveBeenCalledTimes(1)
      expect(removed).toHaveBeenCalledWith('pointerdown', expect.any(Function), true)

      const c = join(vp, 1, true)
      pressAt(document.body, [400, 300])
      expect(a).toHaveBeenCalledTimes(1)
      expect(c).toHaveBeenCalledTimes(1)
    } finally {
      removed.mockRestore()
    }
  })
})

describe('the cursor', () => {
  function aimed(options = {}) {
    const model = orthoCamera()
    realCamera(THREE, model)
    return stage({ ...options, camera: model })
  }

  it('wears the widget`s cursor while the pointer is over it', () => {
    // What a div got from the browser for nothing. A widget in the scene is not
    // an element, so the hover is raycast and the canvas written to by hand —
    // and without it the one thing that says "this can be grabbed" before it is
    // grabbed is gone.
    const s = aimed()
    drawn(s)

    moveAt(s.canvas, [400, 300])
    expect(s.canvas.style.cursor).toBe('grab')
  })

  it('hands the canvas back when the pointer leaves', () => {
    // The canvas is the library's element, not ours: a cursor left on it would
    // be a grab cursor over the whole model for the rest of the page's life.
    const s = aimed()
    drawn(s)
    moveAt(s.canvas, [400, 300])

    moveAt(s.canvas, [700, 550])
    expect(s.canvas.style.cursor).toBe('')
  })

  it('holds `grabbing` for the whole gesture, wherever the hand goes', () => {
    // THE HAND LEAVES THE WIDGET ALMOST AT ONCE, which is what makes this more
    // than a nicety: a drag carries the pointer off an 18 px target within a few
    // pixels of across-axis travel, and a cursor recomputed from the ray would
    // go back to the default in the middle of a gesture that is still running --
    // the one thing a cursor is there to deny. The DOM widget got this free by
    // writing `grabbing` on its own element; a mesh has no element.
    const s = aimed()
    drawn(s)
    moveAt(s.canvas, [400, 300])
    expect(s.canvas.style.cursor).toBe('grab')

    s.widget.grabbed(true)
    expect(s.canvas.style.cursor).toBe('grabbing')
    // Far off the widget, where the hover would have handed the canvas back.
    moveAt(s.canvas, [700, 550])
    expect(s.canvas.style.cursor).toBe('grabbing')

    s.widget.grabbed(false)
    moveAt(s.canvas, [700, 550])
    expect(s.canvas.style.cursor).toBe('')
  })

  it('hands it back when the widget goes away mid-hover', () => {
    const s = aimed()
    drawn(s)
    moveAt(s.canvas, [400, 300])
    expect(s.canvas.style.cursor).toBe('grab')

    s.widget.destroy()
    widgets.pop()
    expect(s.canvas.style.cursor).toBe('')
  })
})

describe('the file the hub serves still calls the hook', () => {
  // WHAT NOTHING ELSE IN THIS SUITE CAN SEE. Every test above places the widget
  // through `fakeViewer.update`, which is a MODEL of the library's render pass —
  // so a bundle built from a source that lost our patch (a rebase onto a new
  // tag, a `make viewer` that was never run) leaves this whole file green and
  // the grip invisible on the page. The patch is listed in
  // static/_v/PROVENANCE.md; this is the assertion behind that entry.

  /** One of the viewer's own arrow properties, from its name to the next. */
  function body(name, next) {
    const source = readFileSync(
      resolve(process.cwd(), '../static/_v/three-cad-viewer.esm.js'), 'utf8')
    const start = source.indexOf(`this.${name} = `)
    expect(start, `the library still has \`${name}\``).toBeGreaterThanOrEqual(0)
    const end = source.indexOf(`this.${next} = `, start)
    expect(end).toBeGreaterThan(start)
    return source.slice(start, end)
  }

  it('runs the hook before the frame clears, so a widget can still be moved', () => {
    // AT THE TOP OF `update` is the whole of what makes this hook usable: a
    // widget placed after the clear would be placed for the NEXT frame, which is
    // the same one-frame lag the loop had.
    const update = body('update', 'animate')
    const hook = update.indexOf('this.onBeforeRender()')
    expect(hook, 'the hook is called at all').toBeGreaterThan(0)
    expect(update.indexOf('this.renderer.clear()'),
           'and before anything is drawn').toBeGreaterThan(hook)
  })

  it('draws when the clip slider moves, which is what carries the grip', () => {
    // THE OTHER HALF of `refresh` meaning "only for a change the library did not
    // make itself". A drag of this very widget moves the plane through
    // `setClipSlider`, and that setter renders — so the grip follows the hand
    // with nobody asking for a frame. If it ever stopped, the arrow would stand
    // still under a plane that was sliding, which is what it did before it was
    // an object in the scene at all.
    expect(body('setClipSlider', 'resetClip')).toContain('this.update(')
  })
})

describe('the teardown', () => {
  it('leaves the hook, drops the listeners, leaves the scene and frees the geometry', () => {
    // Every one of the four is a leak with no symptom: a placement running on
    // every frame the library draws for a widget that is gone, two capture-phase
    // listeners on the window answering for a scene that is gone, a group
    // holding the disposed scene alive, and the only geometry in this tree that
    // nothing else will ever free — the library disposes the scene's own on
    // `clear()`, and this group is precisely the thing that is not in it by
    // then.
    const model = orthoCamera()
    realCamera(THREE, model)
    const s = stage({ camera: model })
    const group = drawn(s)
    const geometry = vi.spyOn(s.built[0].geometry, 'dispose')
    const material = vi.spyOn(s.built[0].material, 'dispose')

    s.widget.destroy()
    widgets.pop()

    expect(s.viewer.scene.children).not.toContain(group)
    expect(geometry).toHaveBeenCalledTimes(1)
    expect(material).toHaveBeenCalledTimes(1)

    const before = s.calls.place
    rendered(s.viewer)
    expect(s.calls.place, 'the render places it no more').toBe(before)
    expect(s.viewer.onBeforeRender, 'and the field is the library`s again').toBeNull()

    pressAt(s.canvas, [400, 300])
    moveAt(s.canvas, [400, 300])
    expect(s.calls.press).toBe(0)
    expect(s.canvas.style.cursor).toBe('')
  })
})
