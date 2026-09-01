// A stand-in for three-cad-viewer, good enough for the halves that have no GPU
// in them.
//
// WHAT THIS FILE IS ALLOWED TO MODEL, and what it is not. Everything here is a
// model of the LIBRARY — three.js's orthographic camera and the viewer's own
// `CenteredPlane` — and never of the code under test. That distinction is the
// whole reason it can be trusted: a fake that reimplemented `ndcOffset`'s
// arithmetic would let the suite agree with itself, whereas a fake that
// implements `unproject` the way three.js does lets the suite ask whether the
// adapter's arithmetic is right.
//
// Both models are transcribed from a source rather than from memory:
//
//   * the ortho camera from the derivation in ui/src/viewport/zoom.js, which
//     reads it off `OrthographicCamera.updateProjectionMatrix` — the frustum is
//     divided by `zoom`, so a world offset perpendicular to the view axis maps
//     to NDC as `(d . R) * zoom / halfW`. `unproject` at z = 0 lands midway
//     between near and far, which is why the point it returns carries a
//     component ALONG the view axis that the adapter has to strip;
//   * `CenteredPlane.setConstant`, read out of static/_v/three-cad-viewer.esm.js:
//     `constant = distanceToPoint(0) - distanceToPoint(centre) + value`, i.e.
//     `constant = value - normal . centre`. That is the one fact the whole
//     section slider rests on, and it is the reason the zero of the slider is
//     the centre of the grid rather than the model origin.
//     `setClipNormal(i, n, value = null)` is from the same file: it normalises,
//     parks the plane at `gridSize / 2` and then puts the slider at `value`, or
//     at `gridSize / 2` when it is null.
//
// Anything a test does not look at is left out rather than approximated, so a
// module that starts reaching for something new fails loudly here instead of
// quietly reading `undefined`.

import { vi } from 'vitest'

// -- small vector helpers, for the model only ---------------------------------
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
/** `Vector3.normalize`, transcribed rather than remembered.
 *
 * three.js: `normalize() { return this.divideScalar( this.length() || 1 ); }`
 * — and the `|| 1` is the whole of what this function has to get right. Divided
 * unconditionally, as this once was, a zero-length vector comes back as NaNs and
 * every plane built from one is NaN; the library instead leaves it AT ZERO.
 *
 * The difference is not academic, because a zero clip normal is reachable (see
 * `unit3` in math.js) and the two behaviours look nothing alike on screen. NaN
 * would be loud — a plane at NaN clips everything or nothing in a way somebody
 * notices. Zero is silent: the plane is `(0, 0, 0, w)`, the fragment test
 * `dot( vClipPosition, plane.xyz ) > plane.w` becomes `0 > w`, and the model is
 * simply never cut. A fake that produced the loud failure would let the suite
 * assert a symptom the library cannot produce, which is exactly what the header
 * above forbids.
 */
const norm = (a) => {
  const l = Math.sqrt(dot(a, a)) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/**
 * A `Vector3` as the adapter uses one: it never constructs a vector, it borrows
 * the instance the library handed back and overwrites it (`eye.clone().set(...)`).
 * So `clone` has to be independent, `set` has to return `this`, and `project` /
 * `unproject` have to transform IN PLACE and return `this`, exactly like three's.
 */
function vector(camera, x, y, z) {
  return {
    x, y, z,
    clone() { return vector(camera, this.x, this.y, this.z) },
    set(nx, ny, nz) { this.x = nx; this.y = ny; this.z = nz; return this },
    project(cam) {
      if (cam !== camera.cam) throw new Error('project() with a foreign camera')
      const [x1, y1, z1] = camera.project([this.x, this.y, this.z])
      return this.set(x1, y1, z1)
    },
    unproject(cam) {
      if (cam !== camera.cam) throw new Error('unproject() with a foreign camera')
      const [x1, y1, z1] = camera.unproject([this.x, this.y, this.z])
      return this.set(x1, y1, z1)
    },
  }
}

/**
 * An orthographic camera: a position, an orthonormal screen basis and a zoom.
 *
 * `forward` is the direction the camera looks in, so the target sits at
 * `eye + forward * distance` and `cameraBasis().view` comes back equal to it.
 * `depth` is how far along that axis `unproject` places its answer — the
 * component the projection throws away and the adapter must remove.
 */
export function orthoCamera({
  eye = [0, 0, 60],
  right = [1, 0, 0],
  up = [0, 1, 0],
  forward = [0, 0, -1],
  halfW = 20,
  halfH = 15,
  zoom = 1,
  depth = 30,
} = {}) {
  const camera = {
    eye: [...eye],
    right: norm(right),
    up: norm(up),
    forward: norm(forward),
    halfW, halfH, zoom, depth,
    // The object the adapter passes around as `g.cam`. `isOrthographicCamera`
    // is what gestureInternals() gates every camera gesture on.
    cam: {
      isOrthographicCamera: true,
      updateMatrixWorld: vi.fn(),
    },
    project(p) {
      const d = sub(p, camera.eye)
      return [
        (dot(d, camera.right) * camera.zoom) / camera.halfW,
        (dot(d, camera.up) * camera.zoom) / camera.halfH,
        dot(d, camera.forward) / camera.depth,
      ]
    },
    unproject(n) {
      const along = mul(camera.forward, camera.depth)
      const across = add(mul(camera.right, (n[0] * camera.halfW) / camera.zoom),
                         mul(camera.up, (n[1] * camera.halfH) / camera.zoom))
      return add(add(camera.eye, across), along)
    },
    position() {
      return vector(camera, camera.eye[0], camera.eye[1], camera.eye[2])
    },
  }
  return camera
}

/** A `THREE.Plane`: `distanceToPoint(p) = normal . p + constant`.
 *
 * `center` is `CenteredPlane`'s own field, carried here because the placement
 * arithmetic reads it: the slider's zero is that point, so the value that stands
 * a plane through a world point cannot be worked out without it.
 */
function plane(normal, constant, center) {
  return {
    normal: norm(normal),
    constant,
    center,
    distanceToPoint(p) {
      return this.normal[0] * p.x + this.normal[1] * p.y
        + this.normal[2] * p.z + this.constant
    },
    // `CenteredPlane.setConstant`, verbatim in its effect: the slider counts
    // from `centre`, not from the origin.
    //
    // FROM `this.center` AND NOT FROM AN ARGUMENT. The library keeps the centre
    // in ONE field on the plane, so a fake taking it as a parameter has two —
    // this one, which `sectionValueFor` reads through `g.plane.center`, and the
    // viewer's `clipCenter`, which callers were passing in. They are the same
    // object today and nothing notices; a test that changed either one would put
    // the fake in a state the library cannot be in, and the suite would then
    // approve arithmetic done against one centre while the plane stood at the
    // other.
    setCentered(value) {
      this.constant = value - dot(this.normal, this.center)
    },
  }
}

/**
 * The viewer.
 *
 * `gridSize` and `clipCenter` are separate arguments on purpose: they are the
 * two things a republished, slightly larger model changes, and the section
 * capture/restore test is entirely about what happens when they do.
 */
export function fakeViewer({
  camera = orthoCamera(),
  gridSize = 100,
  clipCenter = [0, 0, 0],
  states = {},
  groups = {},
  rect = { left: 0, top: 0, width: 800, height: 600 },
  target = null,
} = {}) {
  const canvas = { getBoundingClientRect: () => ({ ...rect }) }
  const planes = [plane([0, 0, 1], gridSize / 2, clipCenter),
                  plane([0, 1, 0], gridSize / 2, clipCenter),
                  plane([1, 0, 0], gridSize / 2, clipCenter)]
  const sliders = [gridSize / 2, gridSize / 2, gridSize / 2]
  // Wherever the camera is pointing, unless a test pins it somewhere else.
  const aim = target || add(camera.eye, mul(camera.forward, 60))

  const viewer = {
    ready: true,
    gridSize,
    clipCenter,
    camera: {
      getCamera: () => camera.cam,
      getPosition: () => camera.position(),
    },
    clipping: {
      clipPlanes: planes,
      setVisible: vi.fn(),
    },
    renderer: { domElement: canvas },
    idPicker: {},
    nestedGroup: {
      groups,
      highlight: { clear: vi.fn(), selectSolid: vi.fn() },
    },
    display: {},
    controls: {},

    canvas,
    model: camera,
    target: [...aim],

    // -- camera ------------------------------------------------------------
    getCameraZoom: () => camera.zoom,
    getCameraTarget: () => [...viewer.target],
    setCameraLocationSettings: vi.fn((position, quaternion, at, zoom, notify) => {
      viewer.locationCalls.push({ position, quaternion, target: at, zoom, notify })
      if (position) camera.eye = [...position]
      if (at) viewer.target = [...at]
      if (zoom !== null && zoom !== undefined) camera.zoom = zoom
    }),
    locationCalls: [],

    // -- clipping ----------------------------------------------------------
    getClipSlider: (i) => sliders[i],
    setClipSlider: vi.fn((i, value) => {
      // `Viewer.setClipSlider` opens with `if (value === -1 || value == null)
      // return` — -1 is its spelling of "no value given", and a placement that
      // works out to exactly that number is silently not applied. Modelled here
      // because a fake that took it would let the suite agree that a plane
      // stands where the library would have left it parked.
      if (value === -1 || value == null) return
      sliders[i] = value
      planes[i].setCentered(value)
    }),
    getClipNormal: (i) => [...planes[i].normal],
    setClipNormal: vi.fn((i, n, value = null, notify = true) => {
      planes[i].normal = norm(n)
      planes[i].setCentered(viewer.gridSize / 2)
      sliders[i] = viewer.gridSize / 2
      viewer.setClipSlider(i, value === null ? viewer.gridSize / 2 : value, notify)
    }),
    setLocalClipping: vi.fn(),
    setActiveTab: vi.fn(),

    // -- parts -------------------------------------------------------------
    getStates: vi.fn(() => ({ ...states })),
    setStates: vi.fn((next) => { states = { ...next } }),
    update: vi.fn(),
    dispose: vi.fn(),
  }
  return viewer
}

/** A group as `nestedGroup.groups[path]` holds one: a position and a toggle. */
export function fakeGroup(position = [0, 0, 0]) {
  const group = {
    opacity: 1,
    transparent: false,
    position: {
      x: position[0], y: position[1], z: position[2],
      set(x, y, z) { this.x = x; this.y = y; this.z = z },
    },
    setTransparent: vi.fn((on) => { group.transparent = on }),
  }
  return group
}

/** The `vp` an adapter function is called with, without booting an element. */
export function fakeViewport(viewer, state = {}) {
  return {
    viewer,
    state: {
      hidden: [], ghost: [], selected: [],
      cut: false, cutOffset: 0, cutFlip: false, pins: [],
      ...state,
    },
    sectionSeed: null,
    zoomAnchor: null,
    moved: new Map(),
    partHome: new Map(),
    overlay: { setPins: vi.fn(), refresh: vi.fn() },
  }
}

/** A wheel/pointer event as the adapter reads one: a target and a position. */
export function eventAt(viewer, clientX, clientY) {
  return { target: viewer.canvas, clientX, clientY }
}
