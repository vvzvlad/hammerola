// ui/src/viewport/viewcube.js — the projection, the 26 targets, and the one
// routing rule that has to survive every later tidy-up.
//
// The widget is drawn by hand out of a quaternion, so everything that decides
// WHAT is drawn and WHERE a click goes is a pure function and is checked here
// against arithmetic that does not come from the module. Two independent
// yardsticks are used deliberately:
//
//   * for the projection, the identity quaternion, where the answer can be read
//     off by hand — and where the library's own `defaultDirections.z_up.top`
//     quaternion happens to be exactly `(0, 0, 0, 1)`, so "identity" and "the
//     top view" are the same statement;
//   * for visibility, the dot product. The camera's +Z axis in world space IS
//     the direction the camera looks FROM, so a face's camera-space z equals
//     `n . d` for that direction — a formula with no quaternion in it, checked
//     against the module's quaternion sandwich.
//
// The last describe block is the point of the exercise. `top` and `bottom` must
// go through `presetCamera`, because `setCameraPosition` ends in a `lookAt` whose
// roll is undefined when the view direction is parallel to `up` — see the long
// comment on `cameraTarget`. A refactor that "unifies" the two paths has to fail
// here, loudly, rather than ship a top view rolled to a random angle.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FACES, SIZE, applyCameraTarget, cameraTarget, cellDirection, createViewCube,
  halfChord, projectCubePoint, rotateByConjugate, visibleFaces,
} from '../src/viewport/viewcube.js'
import { fakeViewer } from './fakes.js'

const IDENTITY = [0, 0, 0, 1]

// The camera quaternion for the iso view under `up: "Z"` — three.js's
// `Matrix4.lookAt` basis for eye direction (1, -1, 1) with up (0, 0, 1), turned
// into a quaternion by `Quaternion.setFromRotationMatrix`. Written out rather
// than derived so the test does not reimplement the thing it is checking; the
// first assertion below verifies it against the dot product instead.
const ISO = [0.424708200277867, 0.175919896606161,
             0.339851142979987, 0.820473238570283]

// The same construction for the eye direction (3, -1, 2) — an orientation with
// no two faces at the same depth, which is what the ordering check needs.
const OBLIQUE = [0.391367612113690, 0.282081814862292,
                 0.512167908713126, 0.710595014897267]

// And for (10, -1, 1): RIGHT nearly square on, TOP and FRONT at 0.099 — two
// slivers, which is the case the captions have to give up on.
const GRAZING = [0.497653651758119, 0.450370365080758,
                 0.497407956054711, 0.549629604736052]

const CENTER = SIZE / 2
const SCALE = 32 / Math.sqrt(3)

const unit = (a) => {
  const l = Math.hypot(...a)
  return a.map((x) => x / l)
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const labels = (entries) => entries.map((entry) => entry.face.label)

/** Every cell of every face: 6 x 9 = 54 of them. */
const allCells = () => {
  const out = []
  for (const face of FACES) {
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 3; col += 1) out.push({ face, col, row })
    }
  }
  return out
}

/** The 26 distinct directions, as a sorted list of "x,y,z" keys. */
const allDirections = () => [
  ...new Set(allCells().map(({ face, col, row }) => cellDirection(face, col, row)
    .join(','))),
]

describe('rotateByConjugate', () => {
  it('applies the INVERSE of the rotation, not the rotation', () => {
    // A quarter turn about Z. The camera's own rotation would take X to Y; the
    // conjugate — the world seen FROM that camera — takes it to -Y.
    const s = Math.SQRT1_2
    const quarterTurnAboutZ = [0, 0, s, s]
    const v = rotateByConjugate(quarterTurnAboutZ, [1, 0, 0])
    expect(v[0]).toBeCloseTo(0, 12)
    expect(v[1]).toBeCloseTo(-1, 12)
    expect(v[2]).toBeCloseTo(0, 12)
  })

  it('leaves a vector alone under the identity quaternion', () => {
    expect(rotateByConjugate(IDENTITY, [1, -2, 3])).toEqual([1, -2, 3])
  })

  it('keeps lengths, which is what makes the visibility test a sign test', () => {
    const v = rotateByConjugate(ISO, [1, 1, 1])
    expect(Math.hypot(...v)).toBeCloseTo(Math.sqrt(3), 12)
  })
})

describe('projectCubePoint under the identity quaternion', () => {
  // Identity is the library's own `top` quaternion, so this is the top view:
  // world +X runs right across the widget and world +Y runs UP, which in SVG
  // coordinates means down the y axis.
  it('puts the eight corners where the top view says they go', () => {
    const expected = [
      [[-1, -1, -1], [CENTER - SCALE, CENTER + SCALE]],
      [[+1, -1, -1], [CENTER + SCALE, CENTER + SCALE]],
      [[-1, +1, -1], [CENTER - SCALE, CENTER - SCALE]],
      [[+1, +1, -1], [CENTER + SCALE, CENTER - SCALE]],
      [[-1, -1, +1], [CENTER - SCALE, CENTER + SCALE]],
      [[+1, -1, +1], [CENTER + SCALE, CENTER + SCALE]],
      [[-1, +1, +1], [CENTER - SCALE, CENTER - SCALE]],
      [[+1, +1, +1], [CENTER + SCALE, CENTER - SCALE]],
    ]
    for (const [corner, want] of expected) {
      const got = projectCubePoint(IDENTITY, corner)
      expect(got[0]).toBeCloseTo(want[0], 10)
      expect(got[1]).toBeCloseTo(want[1], 10)
    }
  })

  it('is orthographic: the two corners on one view ray land on one point', () => {
    // Nothing about depth may reach the answer — that is the whole of "drop the
    // camera-space z", and it is what lets the widget ignore the scene's own
    // projection settings.
    expect(projectCubePoint(IDENTITY, [1, 1, 1]))
      .toEqual(projectCubePoint(IDENTITY, [1, 1, -1]))
  })

  it('never leaves the widget box, whatever the orientation', () => {
    for (const q of [IDENTITY, ISO, OBLIQUE]) {
      for (const corner of [[1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1],
                            [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1]]) {
        const [x, y] = projectCubePoint(q, corner)
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(SIZE)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(SIZE)
      }
    }
  })
})

describe('visibleFaces', () => {
  it('agrees with the dot product, which has no quaternion in it', () => {
    // The camera's +Z axis in world space is the direction it looks FROM, so a
    // face's camera-space z is `n . d`. This is the assertion that makes ISO
    // above a trustworthy constant rather than eight digits nobody checked.
    const d = unit([1, -1, 1])
    for (const face of FACES) {
      expect(rotateByConjugate(ISO, face.n)[2]).toBeCloseTo(dot(face.n, d), 12)
    }
  })

  it('returns exactly the three faces the iso view shows', () => {
    expect(labels(visibleFaces(ISO)).sort())
      .toEqual(['FRONT', 'RIGHT', 'TOP'])
  })

  it('returns them back to front', () => {
    // At the exact iso angle all three faces are at the same depth, so the
    // ordering says nothing there; an oblique view is where it can be read.
    const seen = visibleFaces(OBLIQUE)
    expect(seen).toHaveLength(3)
    const depths = seen.map((entry) => entry.normal[2])
    expect(depths[0]).toBeLessThan(depths[1])
    expect(depths[1]).toBeLessThan(depths[2])
  })

  it('drops the edge-on faces rather than drawing slivers of them', () => {
    // The top view: one face towards the reader, one away, four exactly edge-on.
    expect(labels(visibleFaces(IDENTITY))).toEqual(['TOP'])
  })
})

describe('halfChord — the room a caption gets', () => {
  it('is half the width of a face seen square on', () => {
    // The top view: the TOP face is a square of side 2*SCALE, so the horizontal
    // chord through its centre is 2*SCALE and half of it is SCALE.
    const top = FACES.find((f) => f.label === 'TOP')
    expect(halfChord(IDENTITY, top)).toBeCloseTo(SCALE, 9)
  })

  it('shrinks as a face turns away, and goes to nothing edge-on', () => {
    const front = FACES.find((f) => f.label === 'FRONT')
    const iso = halfChord(ISO, front)
    const grazing = halfChord(GRAZING, front)
    expect(iso).toBeGreaterThan(grazing)
    expect(grazing).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(grazing)).toBe(true)
  })
})

describe('the 3x3 subdivision', () => {
  it('is Fusion\'s: 6 faces + 12 edges + 8 corners = 26 targets', () => {
    const keys = allDirections()
    expect(keys).toHaveLength(26)

    const byKind = { face: [], edge: [], corner: [] }
    for (const key of keys) {
      const dir = key.split(',').map(Number)
      const nonzero = dir.filter((c) => c !== 0).length
      byKind[{ 1: 'face', 2: 'edge', 3: 'corner' }[nonzero]].push(key)
    }
    expect(byKind.face).toHaveLength(6)
    expect(byKind.edge).toHaveLength(12)
    expect(byKind.corner).toHaveLength(8)
  })

  it('omits nothing: the 26 are every direction of {-1,0,1}^3 but the origin', () => {
    const every = []
    for (const x of [-1, 0, 1]) {
      for (const y of [-1, 0, 1]) {
        for (const z of [-1, 0, 1]) {
          if (x || y || z) every.push([x, y, z].join(','))
        }
      }
    }
    expect(allDirections().sort()).toEqual(every.sort())
  })

  it('duplicates nothing per face: nine cells, nine directions', () => {
    for (const face of FACES) {
      const seen = new Set()
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 3; col += 1) {
          seen.add(cellDirection(face, col, row).join(','))
        }
      }
      expect(seen.size).toBe(9)
    }
  })

  it('puts the face itself in the centre cell', () => {
    for (const face of FACES) {
      expect(cellDirection(face, 1, 1)).toEqual(face.n)
    }
  })

  it('shares each edge cell with the neighbour it names', () => {
    // The cell above the centre of FRONT and the cell below the centre of TOP
    // are two ways of asking for the same edge, and both have to produce it.
    const front = FACES.find((f) => f.label === 'FRONT')
    const top = FACES.find((f) => f.label === 'TOP')
    expect(cellDirection(front, 1, 0)).toEqual([0, -1, 1])
    expect(cellDirection(top, 1, 2)).toEqual([0, -1, 1])
  })
})

describe('the camera call — the trap this whole module is written around', () => {
  // A real-enough viewer: `applyCameraTarget` goes through `internals()` for the
  // aiming step, and `internals()` refuses a viewer whose plumbing has moved. The
  // shared fake is what models that plumbing, so it is what is used here — a
  // hand-rolled object beside it would be a second, differently-wrong copy of
  // the same preconditions.
  const spyViewer = () => {
    const viewer = fakeViewer()
    viewer.presetCamera = vi.fn()
    viewer.setCameraPosition = vi.fn()
    viewer.camera.lookAtTarget = vi.fn()
    // What the recentring step reads and writes, modelled from the library:
    // `Viewer.bbox.center()` is an array, `Camera.target` is a Vector3 the
    // library owns (and the only thing `setupCamera(relative)` and
    // `lookAtTarget()` measure from), and `Controls.setTarget` COPIES a Vector3
    // into a second one of its own — two objects, which is why both are written.
    viewer.bbox = { center: () => [10, 20, 30] }
    viewer.camera.target = {
      x: 1, y: 2, z: 3,
      set(x, y, z) { this.x = x; this.y = y; this.z = z; return this },
    }
    viewer.controls.setTarget = vi.fn()
    return viewer
  }

  const kindOf = (key) => {
    const nonzero = key.split(',').map(Number).filter((c) => c !== 0).length
    return nonzero === 1 ? 'face' : 'edge-or-corner'
  }

  it('sends top and bottom through presetCamera and NEVER setCameraPosition', () => {
    // The one that cannot be unified away. `setCameraPosition` sets the position
    // and leaves the aiming to `controls.update()`, which ends in
    // `lookAt(target)`; `lookAt` takes the roll from `camera.up`, which is
    // [0, 0, 1] here, and straight down or straight up is exactly the degenerate
    // case where that cross product vanishes. The library hard-codes a
    // quaternion for these two entries and for no others, and `presetCamera` is
    // the only path that applies it.
    for (const preset of ['top', 'bottom']) {
      const dir = FACES.find((f) => f.preset === preset).n
      const viewer = spyViewer()
      applyCameraTarget(viewer, dir)
      expect(viewer.presetCamera).toHaveBeenCalledWith(preset)
      expect(viewer.setCameraPosition).not.toHaveBeenCalled()
    }
  })

  it('sends the four side faces through presetCamera too', () => {
    // Not for the roll — none of these is parallel to up — but because it is the
    // library's own entry point and `presetCamera(dir, zoom = null)` defaults the
    // zoom to the CURRENT one, so the snap turns the model without rescaling it.
    for (const preset of ['front', 'rear', 'left', 'right']) {
      const dir = FACES.find((f) => f.preset === preset).n
      const viewer = spyViewer()
      applyCameraTarget(viewer, dir)
      expect(viewer.presetCamera).toHaveBeenCalledWith(preset)
      expect(viewer.setCameraPosition).not.toHaveBeenCalled()
    }
  })

  it('sends BACK as the library\'s `rear`, the one word the two vocabularies differ on', () => {
    const viewer = spyViewer()
    applyCameraTarget(viewer, FACES.find((f) => f.label === 'BACK').n)
    expect(viewer.presetCamera).toHaveBeenCalledWith('rear')
  })

  it('sends all twenty edges and corners through setCameraPosition, relative', () => {
    const others = allDirections().filter((key) => kindOf(key) !== 'face')
    expect(others).toHaveLength(20)
    for (const key of others) {
      const dir = key.split(',').map(Number)
      const viewer = spyViewer()
      applyCameraTarget(viewer, dir)
      expect(viewer.presetCamera).not.toHaveBeenCalled()
      expect(viewer.setCameraPosition).toHaveBeenCalledTimes(1)
      const [position, relative] = viewer.setCameraPosition.mock.calls[0]
      expect(position).toEqual(dir)
      // `relative: true` is what makes the vector a DIRECTION: the library
      // normalises it and multiplies by the current camera distance. Passed
      // absolutely, [1, 1, 0] would put the camera a millimetre from the origin.
      expect(relative).toBe(true)
    }
  })

  it('aims the camera after moving it, which setCameraPosition does NOT do here', () => {
    // The measured half of the split. `CADTrackballControls.update()` skips the
    // `lookAt` while `holroyd` is on, so the move alone leaves the camera at a
    // corner still facing whichever way it faced before. Drop this second call
    // and every one of the twenty gives a wrong view with nothing thrown.
    const viewer = spyViewer()
    applyCameraTarget(viewer, [1, 1, 1])
    expect(viewer.camera.lookAtTarget).toHaveBeenCalledTimes(1)
    expect(viewer.update).toHaveBeenCalled()
    // The order matters: aiming before the move aims from the old position.
    expect(viewer.setCameraPosition.mock.invocationCallOrder[0])
      .toBeLessThan(viewer.camera.lookAtTarget.mock.invocationCallOrder[0])
  })

  it('moves nothing at all when it cannot aim', () => {
    // Half a snap — the eye at the corner, the camera still facing the old way —
    // is a view the reader has to rescue by hand. A click that does nothing is
    // the better failure, so the aiming is checked BEFORE the move.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const viewer = spyViewer()
    delete viewer.camera.lookAtTarget
    applyCameraTarget(viewer, [1, 1, 1])
    expect(viewer.setCameraPosition).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('leans on none of those twenty being parallel to up', () => {
    // The premise of the branch above, asserted rather than assumed: if one of
    // them were parallel to [0, 0, 1] it would need a preset of its own.
    for (const key of allDirections().filter((k) => kindOf(k) !== 'face')) {
      const dir = key.split(',').map(Number)
      const cross = [dir[1] * 1 - dir[2] * 0, dir[2] * 0 - dir[0] * 1,
                     dir[0] * 0 - dir[1] * 0]
      expect(Math.hypot(...cross)).toBeGreaterThan(0)
    }
  })

  it('recentres on the bbox before it moves, so a click discards a pan', () => {
    // BOTH PATHS RECENTRE, deliberately. `Viewer.presetCamera` opens by putting
    // both targets back on the bounding box centre, so a click on a FACE has
    // always thrown a hand-made pan away; the edge/corner path had no such step,
    // and a widget that keeps the pan for twenty of its twenty-six targets and
    // discards it for the other six is worse than either consistent answer.
    const viewer = spyViewer()
    applyCameraTarget(viewer, [1, 1, 1])
    expect([viewer.camera.target.x, viewer.camera.target.y, viewer.camera.target.z])
      .toEqual([10, 20, 30])
    // The second of the library's two targets. `Camera.target` is what the move
    // and the aiming use; `controls.target` is what the trackball turns around
    // afterwards, and nothing in the library keeps them in step by itself — a
    // pan moves the second alone. Writing one would leave the camera aimed at
    // one point and spinning about another.
    expect(viewer.controls.setTarget).toHaveBeenCalledWith(viewer.camera.target)
    // BEFORE the move: the eye is placed relative to the target, so recentring
    // after it would put the camera at a distance measured from the old one.
    expect(viewer.controls.setTarget.mock.invocationCallOrder[0])
      .toBeLessThan(viewer.setCameraPosition.mock.invocationCallOrder[0])
  })

  it('still snaps when there is nothing to recentre on', () => {
    // A viewer with no bbox yet, or a library that stopped carrying one. The
    // reader asked for a direction; giving them the direction without the
    // recentring is a working answer, and refusing the click is not.
    const viewer = spyViewer()
    delete viewer.bbox
    applyCameraTarget(viewer, [1, 1, 1])
    expect(viewer.controls.setTarget).not.toHaveBeenCalled()
    expect(viewer.setCameraPosition).toHaveBeenCalledTimes(1)
    expect(viewer.camera.lookAtTarget).toHaveBeenCalledTimes(1)
  })

  it('leaves the face path to recentre itself, inside the library', () => {
    // `presetCamera` does it for us, and doing it twice would be this module
    // guessing at the library's own order.
    const viewer = spyViewer()
    applyCameraTarget(viewer, FACES.find((f) => f.preset === 'front').n)
    expect(viewer.controls.setTarget).not.toHaveBeenCalled()
    expect(viewer.presetCamera).toHaveBeenCalledWith('front')
  })

  it('routes without a viewer rather than throwing', () => {
    expect(() => applyCameraTarget(null, [1, 1, 1])).not.toThrow()
  })

  it('classifies every direction, so nothing falls between the two paths', () => {
    for (const key of allDirections()) {
      const target = cameraTarget(key.split(',').map(Number))
      expect(['preset', 'position']).toContain(target.kind)
    }
  })
})

describe('the widget', () => {
  const cubes = []

  // rAF UNDER THIS TEST'S CONTROL, because half of what is asked below is about
  // the LOOP rather than about one draw: that it warns once instead of once a
  // frame, and that `destroy()` really stops it. Neither question can be put to
  // a real animation frame, which arrives when the runner is no longer looking.
  let pending = []
  let handles = 0

  beforeEach(() => {
    pending = []
    handles = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      handles += 1
      pending.push({ handle: handles, cb })
      return handles
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) => {
      pending = pending.filter((frame) => frame.handle !== handle)
    })
  })

  afterEach(() => {
    // Every cube starts a rAF loop that outlives the test otherwise.
    while (cubes.length) cubes.pop().destroy()
    vi.restoreAllMocks()
  })

  /** Run `n` frames of every loop currently waiting for one. */
  const runFrames = (n) => {
    for (let i = 0; i < n; i += 1) {
      const due = pending
      pending = []
      for (const frame of due) frame.cb(0)
    }
  }

  /** A `vp` with just the one method the cube reads, and a settable rotation.
   *
   * `ready` is not decoration: it is the flag the cube gates the read on, the
   * same one internals.js opens with, and a fake without it would make every
   * test here answer for a viewport that has not rendered.
   */
  const fakeViewport = (quaternion) => {
    const vp = {
      viewer: quaternion === null ? null : {
        ready: true,
        getCameraQuaternion: () => vp.quaternion,
      },
      quaternion,
    }
    return vp
  }

  const build = (vp) => {
    const cube = createViewCube(vp)
    cubes.push(cube)
    return cube
  }

  /** Everything `draw` is allowed to write, in document order, as one string.
   *
   * The elements are built once and never replaced now, so node identity says
   * nothing about whether a frame drew: what changes is attributes, `display`
   * and — when the depth order changes — the order of the groups. All three are
   * in here, which is what makes "the DOM was not touched" a real assertion.
   */
  const painted = (cube) => [...cube.root.querySelectorAll('g, path, text')]
    .map((el) => [el.tagName, el.style.display, el.getAttribute('d'),
                  el.getAttribute('fill'), el.getAttribute('x'),
                  el.getAttribute('y'), el.getAttribute('font-size')].join('|'))
    .join('\n')

  const groupsOf = (cube) => [...cube.root.querySelectorAll('g')]
  const shownGroups = (cube) =>
    groupsOf(cube).filter((g) => g.style.display !== 'none')
  /** The nine clickable cells of a group — everything but the outline. */
  const cellsOf = (group) => [...group.querySelectorAll('path')]
    .filter((p) => p.getAttribute('fill') !== 'none')
  const shownCaptions = (cube) => shownGroups(cube)
    .map((group) => group.querySelector('text'))
    .filter((text) => text && text.style.display !== 'none')
    .map((text) => text.textContent)

  it('draws one group per visible face, in the corner the triad had', () => {
    const cube = build(fakeViewport([...ISO]))
    cube.refresh()
    expect(cube.root.style.left).toBe('16px')
    expect(cube.root.style.bottom).toBe('14px')
    // SIX groups exist and three of them are shown: the elements are built once
    // and a face that turned away is hidden, not removed.
    expect(groupsOf(cube)).toHaveLength(6)
    expect(shownGroups(cube)).toHaveLength(3)
    // Nine cells and an outline per face, six faces' worth.
    expect(cube.root.querySelectorAll('path')).toHaveLength(6 * 10)
    expect(shownCaptions(cube).sort()).toEqual(['FRONT', 'RIGHT', 'TOP'])
  })

  it('gives a sliver of a face no caption, and keeps its cells', () => {
    // The label is sized from the face, and a face with no room for one gets
    // none: drawn anyway it runs out across the neighbours and reads as a
    // rendering fault. The CELLS stay, so the direction is still clickable.
    //
    // FRONT is the one that loses its caption here and TOP is not, even though
    // both are at the same depth — because the room measured is the HORIZONTAL
    // chord, and at this angle FRONT's sliver stands nearly upright while TOP's
    // lies flat and stays wide. That is the right measure for upright text.
    const cube = build(fakeViewport([...GRAZING]))
    cube.refresh()
    expect(shownGroups(cube)).toHaveLength(3)
    const shown = shownCaptions(cube)
    expect(shown).toContain('RIGHT')
    expect(shown).not.toContain('FRONT')
    for (const group of shownGroups(cube)) {
      expect(cellsOf(group)).toHaveLength(9)
    }
  })

  it('lets presses through everywhere except the cells', () => {
    // The layer covers a patch of canvas. If it swallowed presses, rotation
    // would die in this corner — the same trap the overlay's root comment names.
    const cube = build(fakeViewport([...ISO]))
    cube.refresh()
    expect(cube.root.style.pointerEvents).toBe('none')
    const svg = cube.root.querySelector('svg')
    expect(svg.style.pointerEvents).toBe('none')
    const cells = shownGroups(cube).flatMap(cellsOf)
    expect(cells).toHaveLength(27)
    for (const cell of cells) expect(cell.style.pointerEvents).toBe('auto')
  })

  it('does not touch the DOM when the camera has not turned', () => {
    // THE REASON THE LOOP CAN RUN FOREVER. It ticks on every frame of every page
    // — four float comparisons — and a rewrite of thirty elements sixty times a
    // second is what that comparison is there to avoid.
    const vp = fakeViewport([...ISO])
    const cube = build(vp)
    expect(cube.refresh()).toBe(true)

    const before = painted(cube)
    expect(cube.refresh()).toBe(false)
    expect(painted(cube)).toBe(before)

    // A different value in the same four floats, and it redraws.
    vp.quaternion = [...OBLIQUE]
    expect(cube.refresh()).toBe(true)
    expect(painted(cube)).not.toBe(before)
  })

  it('rewrites attributes on a turn and never rebuilds the elements', () => {
    // THE OTHER HALF OF THAT TRADE, and the one the dirty-check does not cover.
    // Every frame the camera MOVES used to create ~33 SVG elements, attach 81
    // listeners and call `replaceChildren` — a full SVG repaint alongside the
    // WebGL frame the reader is dragging, i.e. exactly the rewrite the loop's
    // comment calls the expensive half. Node identity is what says it stopped.
    const vp = fakeViewport([...ISO])
    const cube = build(vp)
    cube.refresh()
    const nodes = [...cube.root.querySelectorAll('g, path, text')]

    vp.quaternion = [...OBLIQUE]
    cube.refresh()
    expect([...cube.root.querySelectorAll('g, path, text')].sort(
      (a, b) => nodes.indexOf(a) - nodes.indexOf(b))).toEqual(nodes)
  })

  it('keeps the highlight under the pointer while the camera turns', () => {
    // The visible symptom of the rebuild: the hover fill was written straight
    // into the attribute, and a redraw rewrote every attribute — so the cell
    // under the cursor went grey the instant the model started moving. The
    // highlight is now state the redraw reads rather than something it clobbers.
    const vp = fakeViewport([...ISO])
    const cube = build(vp)
    cube.refresh()
    const cell = cellsOf(shownGroups(cube)[0])[0]
    const plain = cell.getAttribute('fill')

    cell.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true }))
    const lit = cell.getAttribute('fill')
    expect(lit).not.toBe(plain)

    vp.quaternion = [...OBLIQUE]
    cube.refresh()
    expect(cell.getAttribute('fill')).toBe(lit)

    cell.dispatchEvent(new window.PointerEvent('pointerout', { bubbles: true }))
    expect(cell.getAttribute('fill')).not.toBe(lit)
  })

  it('clears itself once when there is no scene to ask, not every frame', () => {
    const vp = fakeViewport([...ISO])
    const cube = build(vp)
    cube.refresh()
    expect(shownGroups(cube).length).toBeGreaterThan(0)

    vp.viewer = null
    expect(cube.refresh()).toBe(true)
    expect(shownGroups(cube)).toHaveLength(0)
    expect(cube.refresh()).toBe(false)
  })

  it('says nothing about a viewer that has not rendered yet', () => {
    // `viewer.ready` IS THE GUARD, and this is the page it was written for: a
    // view file that failed to render leaves `vp.viewer` standing (element.js
    // keeps it and only records `loadFailed`), and the library's `get rendered()`
    // THROWS for as long as `_rendered` is null. Asking anyway would have built
    // an Error and printed it on every frame, for as long as the page was open.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cube = build({
      viewer: {
        ready: false,
        getCameraQuaternion: () => {
          throw new Error('Viewer.render() must be called before this operation')
        },
      },
    })
    const before = painted(cube)
    runFrames(200)
    expect(warn).not.toHaveBeenCalled()
    expect(painted(cube)).toBe(before)
  })

  it('warns ONCE for a viewer that keeps throwing, not once a frame', () => {
    // Anything still able to throw in there is inside a rAF loop, and a
    // `console.warn` in a rAF loop is the same defect wearing another hat.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cube = build({
      viewer: { ready: true, getCameraQuaternion: () => { throw new Error('nope') } },
    })
    const before = painted(cube)
    expect(() => runFrames(200)).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(painted(cube)).toBe(before)
  })

  it('warns again once the fault comes back after a good frame', () => {
    // The flag is reset by a read that succeeds, so a second, later fault is
    // still reported. One-shot for the life of the widget would silence it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let broken = true
    const cube = build({
      viewer: {
        ready: true,
        getCameraQuaternion: () => {
          if (broken) throw new Error('nope')
          return [...ISO]
        },
      },
    })
    runFrames(5)
    expect(warn).toHaveBeenCalledTimes(1)
    broken = false
    runFrames(2)
    broken = true
    runFrames(5)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(cube.root.querySelectorAll('g')).toHaveLength(6)
  })

  it('sends a click on a cell to the camera', () => {
    const vp = fakeViewport([...ISO])
    vp.viewer.presetCamera = vi.fn()
    vp.viewer.setCameraPosition = vi.fn()
    const cube = build(vp)
    cube.refresh()
    // The TOP face is drawn last at this angle only by tie-break, so find it by
    // its caption's group rather than by position.
    const group = shownGroups(cube)
      .find((g) => g.querySelector('text').textContent === 'TOP')
    // Row-major: the fifth of nine is the centre cell, i.e. the face itself.
    cellsOf(group)[4].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    expect(vp.viewer.presetCamera).toHaveBeenCalledWith('top')
    expect(vp.viewer.setCameraPosition).not.toHaveBeenCalled()
  })

  it('stops the PRESS and lets the CLICK through', () => {
    // Two different jobs on one element. The press must not reach the canvas
    // (belt and braces — see the comment in the module about why it is not what
    // makes it safe today), while the click must reach the app's root: that one
    // `onClick` is what closes the tree-row menu, the revision dropdown, the
    // Downloads menu and the token popup. Stopping it turned the model behind a
    // menu that stayed up.
    const vp = fakeViewport([...ISO])
    vp.viewer.presetCamera = vi.fn()
    vp.viewer.setCameraPosition = vi.fn()
    const cube = build(vp)
    cube.refresh()
    const cell = cellsOf(shownGroups(cube)[0])[0]

    const press = new window.PointerEvent('pointerdown', { bubbles: true })
    const pressStopped = vi.spyOn(press, 'stopPropagation')
    cell.dispatchEvent(press)
    expect(pressStopped).toHaveBeenCalled()

    const click = new window.MouseEvent('click', { bubbles: true })
    const clickStopped = vi.spyOn(click, 'stopPropagation')
    cell.dispatchEvent(click)
    expect(clickStopped).not.toHaveBeenCalled()
  })

  it('cancels the frame it is actually waiting on, and stops drawing', () => {
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')
    const vp = fakeViewport([...ISO])
    const cube = createViewCube(vp)
    const host = document.createElement('div')
    host.appendChild(cube.root)
    runFrames(3)
    const before = painted(cube)

    cube.destroy()
    // THE HANDLE, and not merely "cancel was called": cancelling a stale handle
    // passes that weaker assertion and leaves the loop running, which is the
    // exact failure this is here to catch.
    const asked = window.requestAnimationFrame.mock.results
    expect(cancel).toHaveBeenLastCalledWith(asked[asked.length - 1].value)
    expect(host.children).toHaveLength(0)

    // And the convincing half: the loop is gone, so nothing draws any more.
    vp.quaternion = [...OBLIQUE]
    runFrames(50)
    expect(painted(cube)).toBe(before)
  })
})
