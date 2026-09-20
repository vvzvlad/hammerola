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

// -- colours, for the selection ------------------------------------------------
//
// Transcribed from the library's own source in viewer/, not invented: the two
// highlight colours the `HighlightController` module declares
// (viewer/src/rendering/highlight.ts:21-24) and hands its shader as uniforms,
// and the per-plane colours `Clipping` starts every cap material at
// (`PLANE_COLORS`, viewer/src/scene/clipping.ts:20) before `setObjectColorCaps`
// writes the solids' own over them.

/** Highlight colour for a SELECTED component — `HIGHLIGHT_COLOR_SELECTED`. */
export const HIGHLIGHT_COLOR_SELECTED = 0x53a0e3
/** ...and for a hovered, not-selected one — `HIGHLIGHT_COLOR_HOVER`. */
export const HIGHLIGHT_COLOR_HOVER = 0x89b9e3
/** `PLANE_COLORS.light`, one per clip plane, in the library's own order. */
export const PLANE_COLORS = [0xff0000, 0x00ff00, 0x0000ff]

/**
 * A `THREE.Color`, in the operations the viewport and the suite ask of one:
 * `setHex`, `getHex`, `clone` and `copy`.
 *
 * Three's own `Color` converts sRGB to the renderer's working colour space on
 * the way in and back on the way out, and this does not — deliberately, because
 * nothing under test performs that conversion: the viewport copies one colour
 * onto another and remembers what was there, and the channels only ever come
 * back out through `getHex`. What the model DOES have to keep is that a `copy`
 * writes into the colour it was called on rather than replacing it, since the
 * library hands out the very `Color` object its uniform is bound to.
 */
function fakeColor(hex = 0xffffff) {
  const color = { r: 1, g: 1, b: 1 }
  color.setHex = (value) => {
    color.r = ((value >> 16) & 255) / 255
    color.g = ((value >> 8) & 255) / 255
    color.b = (value & 255) / 255
    return color
  }
  color.getHex = () => (Math.round(color.r * 255) << 16)
    ^ (Math.round(color.g * 255) << 8) ^ Math.round(color.b * 255)
  color.clone = () => fakeColor().copy(color)
  color.copy = (other) => {
    color.r = other.r
    color.g = other.g
    color.b = other.b
    return color
  }
  return color.setHex(hex)
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
    //
    // THE FRUSTUM IS FIVE GETTERS and not five numbers, because two of the
    // fields they read are written DURING a test: `setCameraLocationSettings`
    // moves the zoom, and the scale `scene3d.js` computes off `top`, `bottom`
    // and `zoom` would then be measuring a camera that has been left behind.
    // `OrthographicCamera` keeps these as the half-extents the projection
    // divides by `zoom`, which is exactly what `project()` below does with
    // `halfW` and `halfH`. `cam.right` is that half-width and NOT the basis
    // vector of the same name one object out; they are different questions with
    // three's spelling for both.
    cam: {
      isOrthographicCamera: true,
      updateMatrixWorld: vi.fn(),
      get left() { return -camera.halfW },
      get right() { return camera.halfW },
      get top() { return camera.halfH },
      get bottom() { return -camera.halfH },
      get zoom() { return camera.zoom },
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

/**
 * Put a REAL `THREE.OrthographicCamera` in the place `getCamera()` answers with,
 * at the pose the model above describes. Returns it.
 *
 * FOR THE RAYCASTER AND NOTHING ELSE. `scene3d.js` casts a ray with three's own
 * `Raycaster`, which reads `matrixWorld` and `projectionMatrixInverse` off the
 * camera it is handed — matrices the model above has no reason to carry, since
 * every other reader of `g.cam` goes through `project`/`unproject` here.
 *
 * THE MODEL'S ARITHMETIC IS UNTOUCHED. `vector.project` compares the camera it
 * is given against `camera.cam` and then answers with the model's own numbers,
 * so swapping the object that identity points at leaves every projection in
 * this directory exactly as it was — and the two agree about x and y, which is
 * asserted in scene3d.test.js rather than assumed here.
 *
 * `three` is PASSED IN rather than imported: this file is imported by every test
 * in the directory and three is two megabytes of parse per file that would never
 * touch it.
 *
 * The basis is written straight onto the rotation rather than reached through
 * `lookAt`, which would re-derive `right` from `up` and quietly straighten a
 * camera a test has deliberately rolled. Near and far put the model's `depth`
 * exactly in the middle of the frustum, which is where its own `unproject`
 * places a point at z = 0.
 */
export function realCamera(three, camera) {
  const cam = new three.OrthographicCamera(
    -camera.halfW, camera.halfW, camera.halfH, -camera.halfH,
    0.1, 2 * camera.depth)
  cam.zoom = camera.zoom
  cam.position.set(camera.eye[0], camera.eye[1], camera.eye[2])
  // three's camera looks down its own -Z, so the third basis vector of its world
  // matrix is the view direction REVERSED.
  cam.quaternion.setFromRotationMatrix(new three.Matrix4().makeBasis(
    new three.Vector3(...camera.right),
    new three.Vector3(...camera.up),
    new three.Vector3(...camera.forward).negate()))
  cam.updateProjectionMatrix()
  cam.updateMatrixWorld(true)
  camera.cam = cam
  return cam
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
  capUnits = [],
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
      // `Clipping` starts this as `[]` (viewer/src/scene/clipping.ts:357) and
      // `_createStencils` fills it, so an empty array is what a scene with no
      // solids in it looks like — not a missing field.
      _capUnits: capUnits,
    },
    // `localClippingEnabled` is the renderer flag `Viewer.setLocalClipping`
    // writes (viewer/src/core/viewer.ts:2014) and the only place the answer to
    // "is a cut actually cutting" is kept. Modelled rather than spied on alone,
    // because reading it back is how the menu decides whether a cut face can be
    // under the cursor.
    renderer: { domElement: canvas, localClippingEnabled: false },
    idPicker: {},
    nestedGroup: {
      groups,
      // `NestedGroup` carries the viewport size its edge materials are
      // resolution'd against — the constructor takes width/height and
      // `_renderEdges` feeds them to `createEdgeMaterial`.
      width: rect.width,
      height: rect.height,
      // `HighlightController`: the two calls the selection pass makes, and the
      // shared uniform objects its constructor builds
      // (viewer/src/rendering/highlight.ts:241-248) — the selected colour is the
      // one the patched fragment shader assigns to `diffuseColor.rgb`, and the
      // cut-face tint is read off THIS object rather than off a number of its
      // own.
      highlight: {
        clear: vi.fn(),
        selectSolid: vi.fn(),
        uniforms: {
          uHighlightSelectedColor: { value: fakeColor(HIGHLIGHT_COLOR_SELECTED) },
          uHighlightHoverColor: { value: fakeColor(HIGHLIGHT_COLOR_HOVER) },
        },
      },
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
    setLocalClipping: vi.fn((flag) => {
      viewer.renderer.localClippingEnabled = !!flag
    }),
    setActiveTab: vi.fn(),

    // -- the render ----------------------------------------------------------
    // `Viewer.onBeforeRender` — hammerola's own addition to the fork
    // (viewer/src/core/viewer.ts, listed in static/_v/PROVENANCE.md), called at
    // the TOP of `update()`. It starts at null, exactly as the constructor
    // leaves it, so a suite that never installs one sees the library it always
    // saw.
    onBeforeRender: null,

    // -- parts -------------------------------------------------------------
    getStates: vi.fn(() => ({ ...states })),
    setStates: vi.fn((next) => { states = { ...next } }),
    // `Viewer.update`, in the one half a widget standing in the scene hangs off:
    // it runs the hook above and then paints. There is no GPU here and nothing
    // to paint with, so the spy's record IS the frame — which is what every
    // `rendered()` in this directory means.
    update: vi.fn(() => {
      if (viewer.onBeforeRender) viewer.onBeforeRender()
    }),
    dispose: vi.fn(),
  }
  return viewer
}

/** A group as `nestedGroup.groups[path]` holds one: a placement and a toggle.
 *
 *  `setTransparent` is `ObjectGroup.setTransparent` in its effect: the FACE
 *  materials go to `opacity * alpha` when on and back to `alpha` when off —
 *  the value the ghost pass reads back off `front.material`.
 *
 *  THE QUATERNION IS THERE BECAUSE EVERY ObjectGroup IS AN Object3D and carries
 *  one — and because the library writes a leaf's `loc[1]` onto it (`renderLoop`:
 *  `mesh.quaternion.set(...shape.loc[1])`), so it is where a part's SEATED POSE
 *  lives. It starts at the identity here, which is a part its view did not turn;
 *  `parts.test.js` builds the seated case by writing one. No geometry, though,
 *  so `partCentre` says nothing about one of these — which is the state a TURN
 *  is refused in, and `fakeShapeSolid` is the fake that can be turned. */
export function fakeGroup(position = [0, 0, 0]) {
  const group = {
    opacity: 1,
    alpha: 1,
    transparent: false,
    front: { material: { opacity: 1 } },
    position: {
      x: position[0], y: position[1], z: position[2],
      set(x, y, z) { this.x = x; this.y = y; this.z = z },
    },
    quaternion: {
      x: 0, y: 0, z: 0, w: 1,
      set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w },
    },
    setTransparent: vi.fn((on) => {
      group.transparent = on
      group.front.material.opacity = on ? group.opacity * group.alpha : group.alpha
    }),
  }
  return group
}

// -- the section caps, for the hatch -------------------------------------------
//
// Transcribed from the library's own source in viewer/, not invented: the
// `PlaneMesh` constructor (viewer/src/scene/clipping.ts:244-263) and
// `Clipping._createStencils` (viewer/src/scene/clipping.ts:478-563), which is
// what builds `Clipping._capUnits` — one entry PER SOLID,
// `{ solid, stencilGroups, capMeshes, radiusPx }`, with `capMeshes` pushed
// plane-major so they are ordered by plane within the unit. The solids' tree
// paths arrive with `/` already replaced by `|`, as the library spells it
// (`group.name = path.replaceAll("/", this.delim)`, delim `|`).

/** A world matrix as `Object3D.matrixWorld` carries one: column-major, as the
 *  bundle's `makeReflectionMatrix`/`compose` results are read back. Diagonal
 *  scale plus translation only — enough for the outline suite, which does read
 *  it, and for the hatch suite, which varies it as a NEGATIVE CONTROL: the
 *  pitch is one constant counted in pixels now, so a part placed at twice its
 *  own scale has to hatch identically. */
export function fakeMatrix({ scale = [1, 1, 1], position = [0, 0, 0] } = {}) {
  const e = new Array(16).fill(0)
  e[0] = scale[0]; e[5] = scale[1]; e[10] = scale[2]; e[15] = 1
  e[12] = position[0]; e[13] = position[1]; e[14] = position[2]
  return { elements: e }
}

/** A cap material as the library builds one: a `MeshStandardMaterial` with
 *  three.js's default no-op `onBeforeCompile`, the `userData` box every THREE
 *  material carries, and the `color` the cap is filled with — which
 *  `createStencilPlaneMaterial` is handed and `PlaneMesh`'s constructor then
 *  `set`s a second time from its own `color` argument
 *  (viewer/src/scene/clipping.ts:255). */
export function fakeCapMaterial(color = PLANE_COLORS[0]) {
  return {
    defines: { STANDARD: '' },
    needsUpdate: false,
    onBeforeCompile: function noop() {},
    userData: {},
    color: fakeColor(color),
  }
}

/** A `PlaneMesh` as its constructor leaves it: the fields it writes (`type`,
 *  `index`, `plane`, `size`, `center`) on a `PlaneGeometry(2, 2)` that
 *  `updateMatrixWorld` scales to `0.5 * size` — so one uv unit ACROSS the cap
 *  quad is `size` world units. `size` is the clipping region's size and every
 *  cap of a scene carries the same one. Nothing in `hatch.js` reads it any
 *  more: the pitch is counted in PIXELS — CSS ones now, framebuffer ones for
 *  the line and its band, and the difference does not matter here — and a
 *  measure in pixels of any kind is what makes that factor cancel. The hatch
 *  suite varies `size` exactly to prove it cancels.
 *
 *  The `plane` is the `CenteredPlane` the constructor was handed, and its
 *  `normal` is a THREE `Vector3` — read as `.x/.y/.z`, NOT as the array the
 *  slider-side model above uses. Same library, two shapes, depending on which
 *  side of `clipPlanes[i]` you stand on. */
export function fakeCap(index, size, normal = [0, 0, 1], color = PLANE_COLORS[index]) {
  const [nx, ny, nz] = norm(normal)
  return {
    type: `StencilPlane-${index}-0`,
    index,
    plane: { normal: { x: nx, y: ny, z: nz }, constant: 0, center: [0, 0, 0] },
    size,
    center: [0, 0, 0],
    // `Object3D.visible`, which is what `Clipping.cull`
    // (viewer/src/scene/clipping.ts:694) writes to take a cap off the screen —
    // so a cap that has not been culled starts true, the way every Object3D
    // does.
    visible: true,
    material: fakeCapMaterial(color),
  }
}

/** An `ObjectGroup` as `_createStencils` reads one: `name` is the tree path,
 *  and `front` carries the LOCAL bounding box the library computes at build
 *  time (`front.geometry.computeBoundingBox()`,
 *  viewer/src/scene/nestedgroup.ts:851) plus the `matrixWorld` that takes it to
 *  world. Defaults to the suite's 10 mm cube. */
export function fakeSolidObject(name, { min = [0, 0, 0], max = [10, 10, 10], matrix } = {}) {
  return {
    name,
    front: {
      matrixWorld: matrix || fakeMatrix(),
      geometry: {
        boundingBox: {
          min: { x: min[0], y: min[1], z: min[2] },
          max: { x: max[0], y: max[1], z: max[2] },
        },
      },
    },
  }
}

/** `Clipping._createStencils`' answer for a scene: one unit per solid, each
 *  holding one cap per plane, planes in the library's own order.
 *
 *  `omit` leaves the named PLANE INDICES out of every unit while the caps that
 *  remain keep their own `index`. That is the case the cap lookup's comment is
 *  about: `capMeshes` is filled plane-major, so a unit the loop skipped for one
 *  plane has the rest shifted along, and reading `capMeshes[SECTION_INDEX]`
 *  would then hand back another plane's cap with nothing to say it had.
 *
 *  `colors` is one hex PER SOLID, which is the scene `clipObjectColors` builds:
 *  `setObjectColorCaps(true)` writes each solid's own colour over every cap of
 *  it, so caps differ by PART rather than by plane. Left out, the caps keep the
 *  per-plane colours the constructor gave them. */
export function fakeCapUnits(solids, {
  size = 36, planes = [[0, 0, 1], [0, 1, 0], [1, 0, 0]], omit = [], colors = null,
} = {}) {
  return solids.map((solid, at) => ({
    solid,
    stencilGroups: [],
    capMeshes: planes
      .map((n, i) => (omit.includes(i)
        ? null
        : fakeCap(i, size, n, colors ? colors[at] : PLANE_COLORS[i])))
      .filter(Boolean),
    radiusPx: 0,
  }))
}

// -- the fat-line stack, for the section outline -------------------------------
//
// Transcribed from the vendored files, not invented. The trio the outline
// harvests off a live solid's edges is `three/examples/jsm`, which the bundle
// keeps carrying even though three itself is external to it now:
// `LineSegmentsGeometry.setPositions`
// (three/examples/jsm/lines/LineSegmentsGeometry.js) keeps the segments in ONE
// interleaved buffer of stride 6 — `instanceStart` reads xyz at offset 0,
// `instanceEnd` at offset 3 — and `LineMaterial`
// (three/examples/jsm/lines/LineMaterial.js) keeps `color`, `linewidth`,
// `resolution` and `opacity` in uniforms its own accessor properties mirror,
// with shader clipping turned on in the constructor and kept by
// `ShaderMaterial.copy`, which is three's own (static/_v/three.core.js:37712).
//
// `worldUnits` is not a field at all but a view onto the SHADER DEFINES
// (`get`/`set worldUnits`, three/examples/jsm/lines/LineMaterial.js), which is
// why it is modelled here as one: the getter asks whether `WORLD_UNITS` is in
// `defines`, and the setter raises `needsUpdate` when — and only when — the flag
// actually changes. `defines` rides `ShaderMaterial.copy` as its own fresh
// object, so a clone starts wherever its donor stood.

/** A `THREE.Vector2` as `LineMaterial.uniforms.resolution.value` holds one. */
function fakeVector2(x = 0, y = 0) {
  return {
    x, y,
    set(x2, y2) { this.x = x2; this.y = y2; return this },
    clone() { return fakeVector2(this.x, this.y) },
  }
}

function LineMaterial(parameters = {}) {
  this.isLineMaterial = true
  this.type = "LineMaterial"
  this.uniforms = {
    diffuse: { value: fakeColor(parameters.color ?? 0xffffff) },
    // From `UniformsLib.common`, which `ShaderLib.line.uniforms` merges in.
    opacity: { value: 1 },
    linewidth: { value: parameters.linewidth ?? 1 },
    resolution: { value: fakeVector2(1, 1) },
  }
  this.defines = {}
  this.clipping = true
  this.clippingPlanes = null
  this.clipIntersection = false
  this.transparent = true
  // `Material`'s own default, and load-bearing for the contour: it is ordered
  // above every face in the scene, so the depth test is the only thing left
  // that keeps it behind an opaque part standing in front of it.
  this.depthTest = true
  this.needsUpdate = false
  const material = this
  Object.defineProperties(material, {
    color: { get() { return material.uniforms.diffuse.value } },
    worldUnits: {
      get() { return "WORLD_UNITS" in material.defines },
      set(value) {
        if ((value === true) !== material.worldUnits) material.needsUpdate = true
        if (value === true) material.defines.WORLD_UNITS = ""
        else delete material.defines.WORLD_UNITS
      },
    },
    opacity: {
      get() { return material.uniforms.opacity.value },
      set(value) { material.uniforms.opacity.value = value },
    },
    linewidth: {
      get() { return material.uniforms.linewidth.value },
      set(value) { material.uniforms.linewidth.value = value },
    },
    resolution: {
      get() { return material.uniforms.resolution.value },
      set(value) { material.uniforms.resolution.value.copy(value) },
    },
  })
}

// `ShaderMaterial.clone` is `new this.constructor().copy(source)`; the copy
// takes fresh uniform values, so nothing is shared with its source.
LineMaterial.prototype.clone = function clone() {
  const material = new LineMaterial({ linewidth: this.uniforms.linewidth.value })
  const source = this.uniforms.diffuse.value
  const copy = material.uniforms.diffuse.value
  copy.r = source.r
  copy.g = source.g
  copy.b = source.b
  material.uniforms.resolution.value = this.uniforms.resolution.value.clone()
  material.defines = Object.assign({}, this.defines)
  material.clipping = this.clipping
  material.clippingPlanes = this.clippingPlanes
  material.clipIntersection = this.clipIntersection
  material.depthTest = this.depthTest
  return material
}

function LineSegmentsGeometry() {
  this.isLineSegmentsGeometry = true
  this.type = "LineSegmentsGeometry"
  this.instanceCount = 0
  this.setPositionsCalls = 0
  // `BufferGeometry.dispose` (static/_v/three.core.js:19562) — it fires the
  // event `onGeometryDispose` (static/_v/three.module.js:4221) answers, which is
  // what releases the GPU buffer and the vertex-array object of a geometry
  // nothing refers to any more. Recorded rather than ignored, because the
  // contour hands its old geometry over to it on every refill and a leak there
  // is silent.
  this.disposed = 0
}

LineSegmentsGeometry.prototype.dispose = function dispose() {
  this.disposed += 1
}

// The bundle wraps a plain array in a Float32Array and stores everything in
// one interleaved buffer; the two attributes are views onto it.
LineSegmentsGeometry.prototype.setPositions = function setPositions(array) {
  const lineSegments = array instanceof Float32Array ? array : new Float32Array(array)
  const buffer = { array: lineSegments, stride: 6 }
  this.instanceStart = { data: buffer, itemSize: 3, offset: 0 }
  this.instanceEnd = { data: buffer, itemSize: 3, offset: 3 }
  this.instanceCount = lineSegments.length / 6
  this.setPositionsCalls += 1
  return this
}

function LineSegments2(geometry, material) {
  this.isLineSegments2 = true
  // Via the `Mesh` base — what makes `_forEachMaterial` treat the outline as
  // a mesh (`isMesh`, static/_v/three.core.js:23040).
  this.isMesh = true
  this.type = "LineSegments2"
  this.geometry = geometry
  this.material = material
  this.name = ""
  this.renderOrder = 0
  this.visible = true
}

// The fat-line addon's own hook (`LineSegments2.onBeforeRender`,
// three/examples/jsm/lines/LineSegments2.js): before every draw it re-reads
// the viewport and writes it into the material's `resolution`, which is what
// keeps `linewidth` a count of CSS pixels as the canvas resizes. Modelled here
// because the section contour WRAPS it rather than replacing it, and a wrapper
// that dropped it would leave a fat line frozen at the size of the first frame.
LineSegments2.prototype.onBeforeRender = function onBeforeRender(renderer) {
  if (!renderer || typeof renderer.getViewport !== "function") return
  const viewport = renderer.getViewport()
  this.material.resolution.set(viewport.z, viewport.w)
}

/** A renderer as `onBeforeRender` reads one: a viewport and nothing else. */
export function fakeRenderer({ width = 800, height = 600 } = {}) {
  return { getViewport: () => ({ x: 0, y: 0, z: width, w: height }) }
}

/** A solid's `edges` overlay as `_renderEdges`
 *  (viewer/src/scene/nestedgroup.ts:483) leaves it: a
 *  `LineSegments2` over a fresh geometry, under a `LineMaterial` whose
 *  resolution the factory sets from the NestedGroup's own width and height.
 *  The geometry starts empty — the donor's own segments are the scene's edge
 *  list, which no test here needs to spell out. */
export function fakeEdges({ width = 800, height = 600 } = {}) {
  const material = new LineMaterial()
  material.resolution.set(width, height)
  return new LineSegments2(new LineSegmentsGeometry(), material)
}

/** `BufferGeometry.computeBoundingBox` as renderShape triggers it
 *  (viewer/src/scene/nestedgroup.ts:851): a scan of the position attribute —
 *  the index is not consulted. */
function computeBoundingBox(geometry) {
  const { array } = geometry.attributes.position
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (let at = 0; at < array.length; at += 3) {
    min.x = Math.min(min.x, array[at])
    max.x = Math.max(max.x, array[at])
    min.y = Math.min(min.y, array[at + 1])
    max.y = Math.max(max.y, array[at + 1])
    min.z = Math.min(min.z, array[at + 2])
    max.z = Math.max(max.z, array[at + 2])
  }
  geometry.boundingBox = { min, max }
}

/** An ObjectGroup as `NestedGroup.renderShape`
 *  (viewer/src/scene/nestedgroup.ts:690) leaves one — the shape a GPU-less test
 *  can intersect. `front.geometry` carries the
 *  tessellation exactly as the library sets it: a position BufferAttribute of
 *  xyz triples and the triangle index, the bounding box computed at build
 *  time, and the edges overlay attached only when the shape lists edges at
 *  all. `children` and `add` stand in for the Object3D base. */
export function fakeShapeSolid(name, { positions, index, matrix, edges = true } = {}) {
  const front = {
    name,
    matrixWorld: matrix || fakeMatrix(),
    // The face material `createFrontFaceMaterial` builds, in the two fields
    // anything outside the library reads off it: `setStates` writes `visible`
    // when a part is hidden, `setTransparent` writes `opacity` when it is
    // ghosted, and both start where a shown, solid part starts.
    material: { visible: true, opacity: 1 },
    geometry: {
      attributes: {
        position: { array: positions, itemSize: 3, count: positions.length / 3 },
      },
      index: { array: index },
    },
  }
  if (front.geometry.boundingBox == null) computeBoundingBox(front.geometry)
  const group = {
    name,
    front,
    edges: edges ? fakeEdges() : null,
    // The ObjectGroup fields the part passes drive (`applyGhost`), plus the
    // `position` and `quaternion` objects `movePart` writes the move through.
    opacity: 1,
    alpha: 1,
    transparent: false,
    position: {
      x: 0, y: 0, z: 0,
      set(x, y, z) { this.x = x; this.y = y; this.z = z },
    },
    quaternion: {
      x: 0, y: 0, z: 0, w: 1,
      set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w },
    },
    // `ObjectGroup.setTransparent` in its effect: the FACE materials go to
    // `opacity * alpha` when on and back to `alpha` when off — the value the
    // ghost pass reads back off `front.material`.
    setTransparent: vi.fn((on) => {
      group.transparent = on
      front.material.opacity = on ? group.opacity * group.alpha : group.alpha
    }),
    children: [],
    add(child) { group.children.push(child) },
  }
  if (group.edges) group.edges.name = name
  return group
}

/** The `vp` an adapter function is called with, without booting an element. */
export function fakeViewport(viewer, state = {}) {
  return {
    viewer,
    state: {
      hidden: [], ghost: [], selected: [],
      cut: false, cutOffset: 0, cutFlip: false, cutHatch: true, pins: [],
      ...state,
    },
    sectionSeed: null,
    zoomAnchor: null,
    moved: new Map(),
    partHome: new Map(),
    partPivot: new Map(),
    partFacing: new Map(),
    // Empty, exactly as `connectedCallback` starts it: a viewport nothing has
    // pushed a step at, where every drag rounds to the grid's own.
    snapSteps: new Map(),
    overlay: { setPins: vi.fn(), refresh: vi.fn() },
  }
}

/** A wheel/pointer event as the adapter reads one: a target and a position. */
export function eventAt(viewer, clientX, clientY) {
  return { target: viewer.canvas, clientX, clientY }
}
