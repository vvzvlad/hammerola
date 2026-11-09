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
import { STATE } from '../src/events.js'
import { jointPose } from '../src/viewport/joints.js'
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
