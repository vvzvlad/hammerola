// The joints of a view document (issue #143): where `jointPose` stands a node
// a joint moves, and the motion row of the parts tree that moves them.
//
// THE ARITHMETIC IS CHECKED AGAINST THREE.JS, not against a second copy of
// itself: the expected placement is built out of three's own matrices — the
// joint's motion `M(v)` as a translation, a rotation about an axis and the
// translation back, times the node's `loc` — and the group the module's answer
// is written on is composed by three, which is what the library draws. A point
// of the part has to land in the same place both ways.
//
// THE ROW IS ASKED AS settings.test.js asks the Settings card: the real
// prototype over a hand-written state, the real `onModel`, `computed()` and
// handlers, the real `sync` and its `hmr:state` event. The viewport is a spy
// with the one door the row reaches it by.

import { describe, expect, it, onTestFinished, vi } from 'vitest'

import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { JOINTS, STATE } from '../src/events.js'
import {
  jointAbove, jointInWorld, jointPose, rayAngle, slidBy, unwrapped, withinLimits,
} from '../src/viewport/joints.js'
import * as THREE from '../../static/_v/three.module.js'
import { makeComponent, replaceState } from './component.js'
import { texts } from './eltree.js'

const RADIANS = Math.PI / 180

/** A hinge whose line misses the world origin, about an axis on no world
 *  axis — so neither a turn about the origin nor a mixed-up axis can pass. */
const HINGE = {
  id: 'hinge', type: 'revolute', origin: [10, -4, 7], axis: [1 / 3, 2 / 3, 2 / 3],
  limits: [0, 120],
}
/** A drawer sliding along a unit axis in the y-z plane. */
const DRAWER = { id: 'drawer', type: 'slider', axis: [0, 0.6, 0.8], limits: [0, 300] }
const POSES = [{ name: 'open', values: { hinge: 110 } }]

/** A node's own placement in its document: off the origin and turned. */
const LOC = [[3, 5, -2],
             new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.5, 1.1)).toArray()]
/** Points of the part, in its own frame. */
const POINTS = [[0, 0, 0], [12, -3, 4], [-7, 8, 1]]

/** The joint's motion `M(v)` as three builds it. */
function motion(joint, value) {
  if (joint.type === 'revolute') {
    const [x, y, z] = joint.origin
    return new THREE.Matrix4().makeTranslation(x, y, z)
      .multiply(new THREE.Matrix4().makeRotationAxis(
        new THREE.Vector3(...joint.axis), value * RADIANS))
      .multiply(new THREE.Matrix4().makeTranslation(-x, -y, -z))
  }
  const [x, y, z] = joint.axis.map((a) => a * value)
  return new THREE.Matrix4().makeTranslation(x, y, z)
}

/** A placement `[position, quaternion]` as three's matrix. */
const placed = ([position, quaternion]) => new THREE.Matrix4().compose(
  new THREE.Vector3(...position), new THREE.Quaternion(...quaternion),
  new THREE.Vector3(1, 1, 1))

/** A group standing at `[position, quaternion]`, as `stand` in parts.js
 *  writes one. */
function group([position, quaternion]) {
  const g = new THREE.Group()
  g.position.set(...position)
  g.quaternion.set(...quaternion)
  return g
}

/** Where the part's points land through `matrix`. */
const through = (matrix) => POINTS.map(
  (p) => new THREE.Vector3(...p).applyMatrix4(matrix).toArray())

const near = (actual, expected) => actual.forEach((point, at) => point.forEach(
  (value, axis) => expect(value, `point ${at} axis ${axis}`).toBeCloseTo(expected[at][axis], 9)))

describe('jointPose', () => {
  it('turns a node about the hinge line through its origin, after its own placement', () => {
    const g = group(jointPose(HINGE, 37, LOC))
    g.updateMatrixWorld()
    near(through(g.matrixWorld), through(motion(HINGE, 37).multiply(placed(LOC))))
  })

  it('slides a node along its axis and leaves which way it faces', () => {
    const [position, quaternion] = jointPose(DRAWER, 120, LOC)
    expect(quaternion).toEqual(LOC[1])
    const g = group([position, quaternion])
    g.updateMatrixWorld()
    near(through(g.matrixWorld), through(motion(DRAWER, 120).multiply(placed(LOC))))
  })

  it('composes a jointed node under a jointed group as a chain', () => {
    // Each joint is in the frame of its node's `loc`, its parent's, so the
    // child's motion rides on the group's: three's parent groups compose it.
    const LID = [[2, 0, 1],
                 new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.7, 0.2, 0)).toArray()]
    const parent = group(jointPose(HINGE, -64, LOC))
    const child = group(jointPose(DRAWER, 15, LID))
    parent.add(child)
    parent.updateMatrixWorld()
    const want = motion(HINGE, -64).multiply(placed(LOC))
      .multiply(motion(DRAWER, 15)).multiply(placed(LID))
    near(through(child.matrixWorld), through(want))
  })
})

describe('dragging a joint in the scene', () => {
  it('takes the nearest joint up the tree from the part under the press', () => {
    const door = { joint: HINGE, loc: LOC }
    const latch = { joint: DRAWER, loc: LOC }
    const nodes = new Map([['/model/door', door], ['/model/door/latch', latch]])
    expect(jointAbove(nodes, '/model/door/latch/bar')).toEqual({ path: '/model/door/latch', node: latch })
    expect(jointAbove(nodes, '/model/door/panel')).toEqual({ path: '/model/door', node: door })
    // A path segment, not a string prefix: `door(2)` is not inside `door`.
    expect(jointAbove(nodes, '/model/door(2)/panel')).toBeNull()
    expect(jointAbove(nodes, '/model/frame')).toBeNull()
  })

  it('carries the hinge line into the world through its parent\'s matrix', () => {
    const parent = placed(LOC)
    const { origin, axis } = jointInWorld(HINGE, parent.elements)
    const want = new THREE.Vector3(...HINGE.origin).applyMatrix4(parent).toArray()
    origin.forEach((v, i) => expect(v).toBeCloseTo(want[i], 9))
    const dir = new THREE.Vector3(...HINGE.axis).transformDirection(parent).toArray()
    axis.forEach((v, i) => expect(v).toBeCloseTo(dir[i], 9))
    expect(jointInWorld(DRAWER, parent.elements).origin).toBeNull()
  })

  it('reads the angle a point is turned about the hinge, where a ray meets its plane', () => {
    // The point turned by three about the hinge's own axis, so a pair `u`, `v`
    // wound the wrong way round (or the wrong plane) comes out as -37 or worse.
    const o = new THREE.Vector3(...HINGE.origin)
    const n = new THREE.Vector3(...HINGE.axis)
    const off = new THREE.Vector3(5, -1, 0).projectOnPlane(n)
    const turnedBy = (deg) => o.clone().add(off.clone().applyAxisAngle(n, deg * RADIANS))
    // A ray from far off along a slant direction, aimed through the point.
    const dir = [0.2, -0.3, 0.9327379053088815]
    const rayTo = (p) => ({ origin: [p.x - 40 * dir[0], p.y - 40 * dir[1], p.z - 40 * dir[2]], dir })
    const from = rayAngle(rayTo(turnedBy(0)), HINGE.origin, HINGE.axis)
    const to = rayAngle(rayTo(turnedBy(37)), HINGE.origin, HINGE.axis)
    expect(unwrapped(to - from)).toBeCloseTo(37, 9)
    // A ray lying in the plane meets it nowhere (`2, -1, 0` is square to the
    // axis exactly, in floating point too).
    expect(rayAngle({ origin: [0, 0, 0], dir: [2, -1, 0] }, HINGE.origin, HINGE.axis)).toBeNull()
  })

  it('keeps counting through the half turn, step by step', () => {
    // Four quarter steps read off atan2 (which jumps from 180 to -180).
    const read = [0, 90, 180, -90, 0]
    let swept = 0
    for (let i = 1; i < read.length; i += 1) swept += unwrapped(read[i] - read[i - 1])
    expect(swept).toBe(360)
    expect(unwrapped(180)).toBe(180)
    expect(unwrapped(-180)).toBe(180)
  })

  it('slides a part as far as the hand went along its foreshortened axis', () => {
    // The part moved by 7 along an axis the view sees at a slant: what the hand
    // has to travel is that move with its component along the view removed.
    const view = [0, 0, -1]
    const t = 7
    const along = DRAWER.axis[0] * view[0] + DRAWER.axis[1] * view[1] + DRAWER.axis[2] * view[2]
    const hand = DRAWER.axis.map((a, i) => t * (a - along * view[i]))
    expect(slidBy(hand, DRAWER.axis, Math.sqrt(1 - along * along))).toBeCloseTo(t, 9)
  })

  it('holds a value to the joint\'s limits', () => {
    expect(withinLimits(HINGE, 150)).toBe(120)
    expect(withinLimits(HINGE, -5)).toBe(0)
    expect(withinLimits(HINGE, 42)).toBe(42)
  })
})

describe('the motion row', () => {
  const click = { stopPropagation() {}, preventDefault() {} }
  const TREE = { id: '/model', name: 'model', children: [] }

  /** The page over a viewport that takes the joints' values. */
  function page() {
    const el = { setJoints: vi.fn() }
    const c = makeComponent(HammerolaViewer, {
      setState: replaceState, host: { current: el }, captureHome: vi.fn(),
    })
    return { c, el }
  }

  /** The detail of every `hmr:state` event from here on. */
  function listening() {
    const seen = []
    const listen = (event) => seen.push(event.detail)
    window.addEventListener(STATE, listen)
    onTestFinished(() => window.removeEventListener(STATE, listen))
    return seen
  }

  it('is drawn only for a view whose document declares joints', () => {
    const { c } = page()
    c.onModel({ view: 'assembled', tree: TREE, live: false })
    expect(c.computed().motionShown).toBe(false)
    expect(texts(c.render())).not.toContain('motion')

    c.onModel({ view: 'assembled', tree: TREE, live: false, joints: [HINGE, DRAWER], poses: POSES })
    expect(c.computed().motionShown).toBe(true)
    const drawn = texts(c.render())
    expect(drawn).toContain('motion')
    for (const label of ['hinge', 'drawer', 'open', 'Reset']) expect(drawn).toContain(label)
  })

  it('hands a slider, a pose and Reset to the viewport, and drops the measurement', () => {
    const { c, el } = page()
    const seen = listening()
    c.onModel({ view: 'assembled', tree: TREE, live: false, joints: [HINGE, DRAWER], poses: POSES })
    // Every joint starts at 0, the document's own placement.
    expect(el.setJoints).toHaveBeenLastCalledWith({ hinge: 0, drawer: 0 })

    c.setState({ measure: { text: '12.00 mm', note: '', full: '12.00 mm' } })
    const slider = (id) => c.computed().motionRows.find((row) => row.key === id)
    slider('drawer').onChange({ target: { value: '30' } })
    expect(el.setJoints).toHaveBeenLastCalledWith({ hinge: 0, drawer: 30 })
    // Its points were taken on parts that have moved since.
    expect(c.state.measure).toBeNull()
    expect(seen.at(-1).__clearMeasure).toBe(true)

    // A pose sets the joints it names; the rest go to 0.
    const pill = (label) => c.computed().motionPills.find((p) => p.label === label)
    pill('open').onClick(click)
    expect(el.setJoints).toHaveBeenLastCalledWith({ hinge: 110, drawer: 0 })

    pill('Reset').onClick(click)
    expect(el.setJoints).toHaveBeenLastCalledWith({ hinge: 0, drawer: 0 })
  })

  it('takes a drag in the scene by the slider\'s own path', () => {
    // Mounted, so the viewport's event reaches the handler the page listens
    // with; the fetches the mount starts are stubbed.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { c, el } = page()
    c.load = vi.fn(async () => {})
    c.loadFeed = vi.fn(async () => {})
    c.loadProposal = vi.fn(async () => {})
    c.componentDidMount()
    onTestFinished(() => {
      c.componentWillUnmount()
      vi.restoreAllMocks()
    })
    c.onModel({ view: 'assembled', tree: TREE, live: false, joints: [HINGE, DRAWER], poses: POSES })
    c.setState({ measure: { text: '12.00 mm', note: '', full: '12.00 mm' } })

    window.dispatchEvent(new CustomEvent(JOINTS, { detail: { values: { hinge: 45, drawer: 0 } } }))
    expect(el.setJoints).toHaveBeenLastCalledWith({ hinge: 45, drawer: 0 })
    expect(c.computed().motionRows.find((row) => row.key === 'hinge').value).toBe(45)
    expect(c.state.measure).toBeNull()
  })

  it('keeps the values across a rebuild of the view, clamped to the new limits, and starts another view at 0', () => {
    const { c, el } = page()
    c.onModel({ view: 'assembled', tree: TREE, live: false, joints: [HINGE, DRAWER], poses: POSES })
    const slider = (id) => c.computed().motionRows.find((row) => row.key === id)
    slider('hinge').onChange({ target: { value: '110' } })
    slider('drawer').onChange({ target: { value: '250' } })

    // The same view rebuilt with the hinge's travel cut to 90.
    c.onModel({ view: 'assembled', tree: TREE, live: false,
                joints: [{ ...HINGE, limits: [0, 90] }, DRAWER], poses: POSES })
    expect(el.setJoints).toHaveBeenLastCalledWith({ hinge: 90, drawer: 250 })

    // Another view declaring joints of the same ids.
    c.onModel({ view: 'exploded', tree: TREE, live: false, joints: [HINGE, DRAWER], poses: POSES })
    expect(el.setJoints).toHaveBeenLastCalledWith({ hinge: 0, drawer: 0 })
  })
})
