// The view cube: a small cube drawn over the canvas that turns WITH the camera
// and snaps it to a standard view when a cell of it is clicked. Fusion's widget,
// and Fusion's subdivision — 6 faces + 12 edges + 8 corners = 26 targets, all of
// them cells of one 3x3 grid per face.
//
// It lives in the viewport rather than in React for the reason overlay.js gives
// at length: what it draws is a projection through a camera that moves sixty
// times a second, and routing that through React state would re-render the whole
// interface on every mouse move. Nothing crosses the boundary here at all — the
// widget reads the camera and writes the camera, and the interface never hears
// about either.
//
// IT REPLACES THE STATIC AXIS TRIAD that used to sit in this corner
// (issues #23 and #24). That triad was three fixed SVG lines: right by accident
// while the model was still in its opening pose, and confidently wrong about
// where X, Y and Z had gone the moment anybody rotated the scene. A marker that
// lies about which way is up is worse than no marker, so it is gone rather than
// fixed — a cube that turns with the camera answers the same question and cannot
// drift out of step with it.
//
// NOT A SECOND three.js SCENE. A unit cube is eight corners and six quads; a
// second WebGL context to draw them would cost a context, a render loop and the
// library's bundle over again. The projection here is done by hand and is
// ORTHOGRAPHIC BY CONSTRUCTION — the camera-space z is dropped and nothing else
// — so it neither needs nor assumes anything about the scene's own projection.

import { internals } from "./internals.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Widget box, in CSS pixels, and the SVG user units that match it 1:1. */
export const SIZE = 72;
const CENTER = SIZE / 2;

/**
 * World units per SVG unit.
 *
 * A corner of a unit cube sits at distance sqrt(3) from the centre, and its
 * projected distance is at most that — reached when the corner lies exactly in
 * the projection plane. `32 / sqrt(3)` therefore keeps the silhouette inside a
 * 32-unit radius for EVERY orientation, which is what stops the cube clipping
 * its own box at some angles and not others.
 */
const SCALE = 32 / Math.sqrt(3);

/** Below this, a face is edge-on and drawing it would be a sliver. */
const VISIBLE_EPS = 1e-6;

/** Caption sizing.
 *
 * `GLYPH_EM` is the average advance of an upper-case semibold sans glyph as a
 * fraction of the em, which is what lets the text be sized without a layout
 * pass — and a layout pass is the thing worth avoiding here, since measuring
 * means reading a geometry property back out of the DOM inside a loop that runs
 * every frame. MEASURED rather than guessed: `getComputedTextLength()` in Chrome
 * on the three labels of the iso view came back at 0.725, 0.664 and 0.715 em per
 * character, so 0.75 is the round number just above all of them.
 *
 * `CAPTION_MARGIN` is then how much of the face's width the label may take. The
 * face is a RHOMBUS and the chord is measured through its centre, so a label
 * that filled the chord would still run out through the sloping sides above and
 * below the centre line — which is what the first version of this did.
 */
const GLYPH_EM = 0.75;
const CAPTION_MARGIN = 0.72;
const MAX_CAPTION_PX = 7;
/** Below this much room the face gets no caption at all. */
const MIN_CAPTION_ROOM = 12;

const GRID_STROKE = "#9aa1a9";
const EDGE_STROKE = "#454b53";
const TEXT_FILL = "#2f353d";
const HOVER_FILL = "#9fc6f2";

/**
 * The six faces: the label a reader sees, the library's own name for the same
 * direction, the outward normal, and the two in-plane axes the 3x3 grid runs
 * along.
 *
 * TWO VOCABULARIES MEET HERE and they disagree on exactly one word: what the
 * label calls BACK the library calls `rear` (`defaultDirections.z_up` in
 * static/_v/three-cad-viewer.esm.js). `preset` is always the library's spelling
 * and is the only one that may be passed to an API call; `label` is always the
 * reader's and never leaves the drawing.
 *
 * `u` and `v` span the face, so its four corners are `n ± u ± v` and the cell at
 * grid offset (su, sv) points at `n + su*u + sv*v`. Which of the two is "across"
 * and which is "up" makes no difference to the directions — every combination of
 * signs is enumerated either way — so they are chosen to be right-handed with
 * the normal (`u × v = n`), which winds all six quads the same way round. They
 * also happen to be the screen axes of that face's own preset view, which is
 * what makes the grid line up with what the reader gets after clicking it.
 */
export const FACES = [
  { label: "TOP", preset: "top", n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { label: "BOTTOM", preset: "bottom", n: [0, 0, -1], u: [1, 0, 0], v: [0, -1, 0] },
  { label: "FRONT", preset: "front", n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { label: "BACK", preset: "rear", n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] },
  { label: "LEFT", preset: "left", n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] },
  { label: "RIGHT", preset: "right", n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
];

/** Face normal -> the library's preset name. The six directions that have one. */
const PRESET_BY_NORMAL = new Map(FACES.map((face) => [face.n.join(","), face.preset]));

/**
 * Rotate `v` by the CONJUGATE of the unit quaternion `q = [x, y, z, w]`.
 *
 * `getCameraQuaternion()` hands back the camera object's own rotation, which
 * takes a direction from camera space out into the world. What is wanted here is
 * the other way round — the cube as seen FROM the camera — so the conjugate is
 * applied, which for a unit quaternion is its inverse.
 *
 * The arithmetic is three.js's `Vector3.applyQuaternion` with the vector part
 * negated. Kept here rather than in math.js: that module's header pins it as a
 * verbatim port of the previous viewer's helpers, and this is the only caller.
 */
export function rotateByConjugate(q, v) {
  const w = q[3];
  const cx = -q[0];
  const cy = -q[1];
  const cz = -q[2];
  const tx = 2 * (cy * v[2] - cz * v[1]);
  const ty = 2 * (cz * v[0] - cx * v[2]);
  const tz = 2 * (cx * v[1] - cy * v[0]);
  return [
    v[0] + w * tx + cy * tz - cz * ty,
    v[1] + w * ty + cz * tx - cx * tz,
    v[2] + w * tz + cx * ty - cy * tx,
  ];
}

/**
 * A point of the unit cube, in SVG coordinates.
 *
 * Orthographic: the camera-space z is dropped outright. The y axis is flipped
 * because SVG's grows downward while the world's grows up.
 */
export function projectCubePoint(q, p) {
  const c = rotateByConjugate(q, p);
  return [CENTER + c[0] * SCALE, CENTER - c[1] * SCALE];
}

/** A point on a face, at grid coordinates (a, b) in [-1, 1]. */
function facePoint(q, face, a, b) {
  return projectCubePoint(q, [
    face.n[0] + a * face.u[0] + b * face.v[0],
    face.n[1] + a * face.u[1] + b * face.v[1],
    face.n[2] + a * face.u[2] + b * face.v[2],
  ]);
}

/**
 * The faces turned towards the reader, BACK TO FRONT.
 *
 * A face is visible when its outward normal, rotated the same way the corners
 * are, has a positive camera-space z. For a cube centred on the origin the
 * normal IS the face centroid, so ordering by that same z orders the faces by
 * depth. Three come back in a general orientation and one or two in the
 * axis-aligned ones — those are the views where the cube is a square or a
 * rectangle, and drawing the edge-on faces would draw slivers.
 *
 * The visible faces of a convex body cannot overlap, so the ordering buys
 * nothing on its own; it costs one comparison and means the drawing is right
 * whatever is added to it later.
 */
export function visibleFaces(q) {
  return FACES
    .map((face) => ({ face, normal: rotateByConjugate(q, face.n) }))
    .filter((entry) => entry.normal[2] > VISIBLE_EPS)
    .sort((a, b) => a.normal[2] - b.normal[2]);
}

/**
 * The direction one cell of a face's 3x3 grid points at — Fusion's own scheme.
 *
 * The centre cell is the face itself, a side cell is the edge this face shares
 * with the neighbour on that side, and a corner cell is the corner where three
 * faces meet. Across all six faces the 54 cells name exactly the 26 vectors of
 * {-1, 0, 1}^3 that are not the origin: 6 faces, 12 edges, 8 corners.
 */
export function cellDirection(face, col, row) {
  const su = col - 1;
  const sv = 1 - row;
  return [
    face.n[0] + su * face.u[0] + sv * face.v[0],
    face.n[1] + su * face.u[1] + sv * face.v[1],
    face.n[2] + su * face.u[2] + sv * face.v[2],
  ];
}

/**
 * How a direction has to be given to the viewer: the library's preset path, or a
 * relative camera position.
 *
 * THE SIX FACES GO ONE WAY AND THE OTHER TWENTY GO THE OTHER, and that split is
 * not a matter of taste — unifying it puts a randomly rolled top view on screen.
 * Read out of the vendored library (static/_v/three-cad-viewer.esm.js):
 *
 *   * `setCameraPosition(position, relative, notify)` calls `camera.setPosition`,
 *     which sets the POSITION and never aims the camera, and then
 *     `controls.update()`. Aiming is that call's job: `TrackballControls.update()`
 *     ends, for an orthographic camera, in `this.object.lookAt(this.target)`.
 *   * `lookAt` — `Object3D.lookAt`, the one bullet here that is three's own code
 *     and is read in static/_v/three.core.js rather than in the bundle —
 *     derives the camera's ROLL from `camera.up`, which is `[0, 0, 1]`
 *     here (`up: "Z"` in options.js). When the view direction is PARALLEL to up
 *     the cross product that fixes the roll degenerates, and the roll that comes
 *     out is arbitrary.
 *   * Looking straight down (`top`) or straight up (`bottom`) is exactly that
 *     case. That is why `defaultDirections.z_up` carries an explicit quaternion
 *     for those two entries and for no others, and why `presetCamera` applies it
 *     AFTER the `lookAt` that would otherwise have decided the roll.
 *
 * So `top` and `bottom` must go through the library's own path and never through
 * `setCameraPosition`. `front`, `rear`, `left` and `right` go through it too:
 * they are in the same table, it is the library's own entry point, and
 * `presetCamera(dir, zoom = null)` defaults the zoom to the camera's CURRENT
 * one, so the snap turns the model without also rescaling it.
 *
 * The twelve edges and eight corners have no preset to go through. None of those
 * twenty directions is parallel to `[0, 0, 1]`, so the degenerate roll cannot
 * arise for them, and `relative: true` makes the vector a DIRECTION — the
 * library normalises it and multiplies by the current camera distance.
 *
 * AND THE `lookAt` IN THAT CHAIN NEVER RUNS UNDER THIS CONFIGURATION — see
 * `applyCameraTarget`, which is what puts it back.
 *
 * THE TARGET IS THE THIRD DIFFERENCE, and it is the one a reader can see. The
 * library's `presetCamera` opens by re-seating the camera target on the bounding
 * box centre — `camera.target` and `controls.target` both — so a click on a FACE
 * throws away whatever panning was done by hand. The edge/corner path has no
 * such step of its own, which used to leave the two answering differently for
 * one gesture: FRONT recentred and FRONT-TOP did not. `applyCameraTarget` now
 * recentres on both paths, DELIBERATELY: a click on this cube means "go to a
 * standard view", a standard view is centred, and a widget that keeps the pan
 * for twenty of its twenty-six targets and discards it for the other six is
 * worse than either consistent answer. The cost is stated rather than hidden —
 * ANY click on the cube discards a pan.
 */
export function cameraTarget(dir) {
  const preset = PRESET_BY_NORMAL.get(dir.join(","));
  if (preset) return { kind: "preset", preset };
  return { kind: "position", position: [dir[0], dir[1], dir[2]] };
}

/**
 * Point the camera at one of the 26 directions. See `cameraTarget` for which of
 * the two paths a direction takes and why.
 *
 * THE EDGE/CORNER PATH TAKES A SECOND CALL, and this is the part that had to be
 * MEASURED rather than read. `setCameraPosition` ends in `controls.update()`,
 * and stock `TrackballControls.update()` does aim an orthographic camera at its
 * target. But this viewport runs `control: "trackball"`, which is
 * `CADTrackballControls`, and that subclass OVERRIDES `update()` and skips the
 * `lookAt` whenever `holroyd` is on — which is its default, and the property the
 * option was chosen for (options.js). Its own comment says why: holroyd sets the
 * quaternion directly, and a `lookAt` would undo the tilted rotation axis that
 * makes the trackball non-tumbling.
 *
 * So under this configuration `setCameraPosition` moves the eye and leaves the
 * camera pointing wherever it already pointed. Driven from a browser against the
 * fixture build: from the top view, `setCameraPosition([-1, 1, 1], true, true)`
 * put the camera at (-49, 49, 56.6) and left the quaternion at (0, 0, 0, 1) —
 * the eye at a corner, still staring straight down. `camera.lookAtTarget()`, the
 * one call the override skips, fixes it exactly, and the roll it produces is the
 * same `camera.up`-derived one every preset gets.
 *
 * WHAT THAT LOOKS LIKE FROM THE OUTSIDE IS "THE MODEL DISAPPEARED", which is how
 * it was first reported. A camera moved off to one side and still aimed the old
 * way has the model outside its frustum entirely, so the canvas goes empty — no
 * error, no warning, nothing in the console. Sweeping all twenty edge and corner
 * targets through the un-aimed path against the fixture build, 19 of them put
 * every one of the model's eight bounding-box corners outside the NDC box. The
 * twentieth was the direction the camera was ALREADY at, where nothing moved.
 *
 * It comes through `internals()` because there is no public equivalent: the
 * Viewer exposes `setCameraQuaternion`, which would mean computing the lookAt
 * here — a second implementation of the very roll convention that has to agree
 * with the library's. This borrows the library's.
 *
 * The aiming is therefore checked BEFORE the move and the move is abandoned
 * without it: a camera that moved without turning shows the model from the wrong
 * place AND facing the wrong way, which is worse than a click that did nothing.
 */
export function applyCameraTarget(viewer, dir) {
  if (!viewer) return;
  const target = cameraTarget(dir);
  try {
    if (target.kind === "preset") {
      viewer.presetCamera(target.preset);
      return;
    }
    const g = internals(viewer);
    if (!g || !g.camera || typeof g.camera.lookAtTarget !== "function"
        || typeof viewer.setCameraPosition !== "function") {
      console.warn("viewcube: cannot aim the camera, so it was not moved");
      return;
    }
    recentre(viewer, g);
    // `notify: false` on the move, because the frame is only half-built until
    // the aiming lands; `viewer.update(true, true)` below is the one that
    // renders it and tells the library's subscribers about it.
    viewer.setCameraPosition(target.position, true, false);
    g.camera.lookAtTarget();
    if (typeof viewer.update === "function") viewer.update(true, true);
  } catch (error) {
    console.warn("viewcube", error);
  }
}

/**
 * Put the camera target back on the bounding box centre, the way `presetCamera`
 * opens — see the last paragraph of `cameraTarget` for why both paths do it.
 *
 * BOTH TARGETS, because the library keeps two and they are separate objects.
 * `Camera.target` is what `setupCamera(relative)` measures the new eye position
 * from and what `lookAtTarget()` aims at; `controls.target` is what the trackball
 * turns around afterwards. `Viewer.presetCamera` writes the first and copies it
 * into the second (three-cad-viewer.esm.js, `presetCamera`), and NOTHING ELSE in
 * the library ever writes `Camera.target` — a pan moves `controls.target` alone.
 * So writing one of the two here would leave a camera aimed at one point and
 * spinning about another.
 *
 * `Camera.target` is mutated in place rather than replaced, because the only
 * `Vector3` constructor is inside the bundle and there is no public export of
 * it. Everything is guarded one field at a time: a widget that cannot recentre
 * should still snap to the direction that was clicked, which is what the reader
 * asked for.
 */
function recentre(viewer, g) {
  const bbox = viewer.bbox;
  const centre = bbox && typeof bbox.center === "function" ? bbox.center() : null;
  if (!Array.isArray(centre) || centre.length !== 3
      || !centre.every(Number.isFinite)) return;
  const at = g.camera.target;
  if (!at || typeof at.set !== "function") return;
  at.set(centre[0], centre[1], centre[2]);
  if (g.controls && typeof g.controls.setTarget === "function") {
    g.controls.setTarget(at);
  }
}

/** Face fill: lighter the more squarely the face faces the reader.
 *
 * OPAQUE, AND THE SAME IN BOTH THEMES on purpose. The canvas under this widget
 * is white or near-black depending on the reader's answer (`readTheme` in
 * ui/src/store.js), so the cube brings its own ground instead of borrowing
 * one: light grey faces inside a dark outline read on either. A palette that
 * followed the theme would have to be measured against both canvases, and
 * nothing here has been measured.
 */
function shade(nz) {
  const value = 214 + Math.round(32 * Math.min(1, Math.max(0, nz)));
  return `rgb(${value},${value},${value})`;
}

/**
 * Half the HORIZONTAL chord of a face's projected parallelogram, taken through
 * its centre — the room its upright caption has to fit into.
 *
 * A face is `{ c + a*pu + b*pv : |a| <= 1, |b| <= 1 }` once projected, and the
 * horizontal line through `c` is where `a*pu.y + b*pv.y = 0`. Pushing whichever
 * of the two has the larger y component all the way to its edge is what puts the
 * other one inside its own bound, which is why the branch is on that comparison
 * rather than on a sign.
 *
 * Needed because the faces are rhombi that change shape as the cube turns: a
 * fixed font size is either too big for the narrow ones — the label spills over
 * the neighbours and reads as a rendering fault — or too small for all of them.
 */
export function halfChord(q, face) {
  const c = facePoint(q, face, 0, 0);
  const pu = facePoint(q, face, 1, 0);
  const pv = facePoint(q, face, 0, 1);
  const ux = pu[0] - c[0];
  const uy = pu[1] - c[1];
  const vx = pv[0] - c[0];
  const vy = pv[1] - c[1];
  // Both axes horizontal: the face has collapsed to a horizontal segment, and
  // every point of it is on the chord.
  if (Math.abs(uy) < 1e-9 && Math.abs(vy) < 1e-9) return Math.abs(ux) + Math.abs(vx);
  if (Math.abs(vy) >= Math.abs(uy)) return Math.abs(ux - (vx * uy) / vy);
  return Math.abs(vx - (ux * vy) / uy);
}

/** An SVG path `d` through the given projected points, closed. */
function polygon(points) {
  return `${points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`)
    .join("")}Z`;
}

export function createViewCube(vp) {
  const root = document.createElement("div");
  // NO CLASS NAME ON IT, unlike the overlay's root. A class here would be a
  // promise the interface's stylesheet keeps a rule for it — which is what
  // tests/test_ui_source.py checks, and rightly: a pin is an empty div that is
  // zero pixels across without one. This widget is styled entirely from inside,
  // because its whole look is a legibility requirement over two themes rather
  // than a palette the designer owns, so there is no rule for a class to name.
  //
  // The corner the static triad occupied, and the only one that is free — every
  // other corner of the viewport has interface chrome in or near it.
  //
  // `pointer-events: none` on the layer and back on for the cells, exactly as
  // the overlay does it: this sits over the canvas, and a layer that swallowed
  // presses would kill rotation in the patch it covers.
  root.style.cssText = "position:absolute;left:16px;bottom:14px;"
    + `width:${SIZE}px;height:${SIZE}px;pointer-events:none`;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(SIZE));
  svg.setAttribute("height", String(SIZE));
  svg.setAttribute("viewBox", `0 0 ${SIZE} ${SIZE}`);
  svg.style.cssText = "pointer-events:none;"
    + "filter:drop-shadow(0 1px 2px rgba(20,24,28,.35))";
  root.appendChild(svg);

  let frame = 0;
  // The four floats of the last quaternion drawn, or null for "nothing drawn".
  let last = null;
  // The cell path under the pointer, or null. Held HERE and consulted by `draw`,
  // rather than living in the `fill` attribute the way it used to: `draw` writes
  // that attribute on every cell of every frame the camera moves, so a highlight
  // that existed only in the attribute was wiped on the first frame of a drag —
  // the cell under the cursor went grey the moment the model started turning.
  let hovered = null;
  // Whether the last read of the camera threw AND has already been reported.
  let warned = false;
  // The visible faces of the last draw, in the order they were stacked in.
  let order = "";

  /** The camera's rotation, or null if there is no scene to ask. */
  const quaternion = () => {
    try {
      const viewer = vp && vp.viewer;
      // `viewer.ready` — the guard internals.js opens with, and the convention
      // in this directory — and NOT an exception used as control flow. The
      // library's `get rendered()` THROWS ("Viewer.render() must be called
      // before this operation") for as long as `_rendered` is null, and
      // `getCameraQuaternion` reads through it. A page whose view file failed to
      // render leaves `vp.viewer` standing (element.js sets `loadFailed` and
      // emits `hmr:error` but keeps the viewer), so without this the loop below
      // built an Error, captured a stack and warned about it SIXTY TIMES A
      // SECOND for as long as the page stayed open.
      if (!viewer || !viewer.ready
          || typeof viewer.getCameraQuaternion !== "function") return null;
      const q = viewer.getCameraQuaternion();
      if (!Array.isArray(q) || q.length !== 4 || !q.every(Number.isFinite)) {
        return null;
      }
      // Whatever was wrong is over. A fault that comes back afterwards is worth
      // a second line in the console.
      warned = false;
      return q;
    } catch (error) {
      // ONCE, not once a frame. The guard above closes the failure that is
      // known; anything else still able to throw in here is inside a rAF loop,
      // and a `console.warn` there is the same defect wearing another hat.
      if (!warned) {
        warned = true;
        console.warn("viewcube", error);
      }
      return null;
    }
  };

  /**
   * Every element of one face, built ONCE: nine cells, an outline and a caption.
   *
   * THE WIDGET USED TO BE REBUILT ON EVERY FRAME THE CAMERA MOVED — ~33 SVG
   * elements created, 81 listeners attached and a `replaceChildren` — i.e.
   * exactly the rewrite the loop's own comment says is the thing worth avoiding.
   * The quaternion dirty-check made the STILL case free and left the moving one
   * at its worst: a full SVG repaint on every frame of a drag, alongside the
   * WebGL frame the reader is dragging. `draw` now only ever writes `d`, `fill`
   * and `display` on what is already here.
   *
   * THE LISTENERS ARE NOT HERE EITHER: three per cell became one per event on
   * the `svg`, resolved back to a cell through `dataset`. That is what makes 27
   * cells cost four listeners instead of 81, and it is why `dataset` carries the
   * indices — the elements are the only place a delegated listener can read them
   * from.
   */
  const buildFace = (face, index) => {
    const group = document.createElementNS(SVG_NS, "g");
    const cells = [];
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("stroke", GRID_STROKE);
        path.setAttribute("stroke-width", "0.4");
        path.style.cssText = "pointer-events:auto;cursor:pointer";
        path.dataset.face = String(index);
        path.dataset.cell = String(cells.length);
        group.appendChild(path);
        cells.push({ path, col, row });
      }
    }

    const border = document.createElementNS(SVG_NS, "path");
    border.setAttribute("fill", "none");
    border.setAttribute("stroke", EDGE_STROKE);
    border.setAttribute("stroke-width", "0.9");
    border.setAttribute("stroke-linejoin", "round");
    border.style.pointerEvents = "none";
    group.appendChild(border);

    // The face's name, upright at its centre, and hidden when it will not fit.
    //
    // HORIZONTAL AND NOT IN THE PLANE OF THE FACE. Laying the text into the face
    // would read as more of a cube, and it would also turn upside down at half
    // the orientations the reader can reach — the trackball has no pole to stop
    // at (options.js, `control: "trackball"`). Upright text is legible from every
    // one of them, and it is the CUBE that carries the orientation.
    //
    // Only the position and the size move; the label itself never changes, so it
    // is written once here.
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    text.setAttribute("fill", TEXT_FILL);
    text.setAttribute("font-weight", "600");
    text.setAttribute("font-family", "system-ui, -apple-system, sans-serif");
    text.style.pointerEvents = "none";
    text.style.display = "none";
    text.textContent = face.label;
    group.appendChild(text);

    group.style.display = "none";
    return { face, group, cells, border, text, fill: shade(0) };
  };

  const faces = FACES.map(buildFace);
  const byFace = new Map(faces.map((entry) => [entry.face, entry]));
  for (const entry of faces) svg.appendChild(entry.group);

  /** The face entry and cell a delegated event landed on, or null. */
  const cellAt = (target) => {
    if (!target || !target.dataset || target.dataset.face === undefined) {
      return null;
    }
    const entry = faces[Number(target.dataset.face)];
    const cell = entry && entry.cells[Number(target.dataset.cell)];
    return cell ? { entry, cell } : null;
  };

  /** Repaint one cell as hovered or not. A 26-target widget with no feedback
   *  gives the reader no way to tell which of them a click is about to take. */
  const hover = (target, on) => {
    const found = cellAt(target);
    if (!found) return;
    const { path } = found.cell;
    if (on) hovered = path;
    else if (hovered === path) hovered = null;
    path.setAttribute("fill", hovered === path ? HOVER_FILL : found.entry.fill);
  };

  // `pointerover`/`pointerout` and NOT `pointerenter`/`pointerleave`: the latter
  // pair does not bubble, so it cannot be delegated at all. Moving between two
  // cells fires the `out` of the old one BEFORE the `over` of the new one, which
  // is the order this pair of handlers needs.
  svg.addEventListener("pointerover", (event) => hover(event.target, true));
  svg.addEventListener("pointerout", (event) => hover(event.target, false));

  // Belt and braces, and NOT the thing that keeps a press off the canvas —
  // read it as no more than it is. The cube's root is a SIBLING of `vp.box`,
  // and every press listener a cell's press could bubble INTO is attached to
  // `vp.box` or to `window` (tools.js, orbit.js, live.js, wheel.js), so a press
  // on a cell never traverses any of them: they are not on its event path at
  // all. overlay.js listens for a press too, but on the pin buttons
  // themselves, which are no ancestor of the cube either. The one that does
  // listen in the CAPTURE phase, tools.js, additionally bails
  // on `event.target !== g.canvas` — that check, not this call, is what makes
  // it safe. This stays for the day the cube is reparented under `vp.box`.
  svg.addEventListener("pointerdown", (event) => {
    if (cellAt(event.target)) event.stopPropagation();
  });

  // AND THE `click` IS DELIBERATELY LET THROUGH, which the press above is not.
  // The interface closes every open menu — the tree row's, the revision
  // dropdown, Downloads, the token popup — from one `onClick` on its root div
  // (HammerolaViewer.jsx, `rootClick`). Stopping the click here stopped it
  // before React ever saw it, so with the Downloads menu open a click on the
  // cube turned the model behind a menu that stayed up. Nothing needs the click
  // stopped: the press is the half that has to be kept off the canvas.
  svg.addEventListener("click", (event) => {
    const found = cellAt(event.target);
    if (!found) return;
    applyCameraTarget(vp && vp.viewer,
                      cellDirection(found.entry.face, found.cell.col, found.cell.row));
  });

  /** Place and size one face's caption, or hide it.
   *
   * The size is taken from the face rather than fixed, because the faces are
   * rhombi whose width changes as the cube turns and the six labels are three to
   * six characters long. A face turned nearly edge-on gets NO caption: a name
   * drawn across its neighbours reads as a rendering fault, and the cube still
   * says which face that is by which way it is turned.
   */
  const caption = (q, entry) => {
    const room = 2 * halfChord(q, entry.face) * CAPTION_MARGIN;
    if (room < MIN_CAPTION_ROOM) {
      entry.text.style.display = "none";
      return;
    }
    const [x, y] = facePoint(q, entry.face, 0, 0);
    entry.text.style.display = "";
    entry.text.setAttribute("x", x.toFixed(2));
    entry.text.setAttribute("y", y.toFixed(2));
    entry.text.setAttribute("font-size",
      Math.min(MAX_CAPTION_PX,
               room / (entry.face.label.length * GLYPH_EM)).toFixed(2));
  };

  /** Nothing on screen, without taking the elements away. */
  const blank = () => {
    for (const entry of faces) entry.group.style.display = "none";
    hovered = null;
    order = "";
  };

  const draw = (q) => {
    const visible = visibleFaces(q);
    const shown = new Set();
    for (const { face, normal } of visible) {
      const entry = byFace.get(face);
      shown.add(entry);
      entry.fill = shade(normal[2]);
      entry.group.style.display = "";
      for (const cell of entry.cells) {
        const a0 = -1 + cell.col * (2 / 3);
        const a1 = a0 + 2 / 3;
        const b1 = 1 - cell.row * (2 / 3);
        const b0 = b1 - 2 / 3;
        cell.path.setAttribute("d", polygon([
          facePoint(q, face, a0, b0), facePoint(q, face, a1, b0),
          facePoint(q, face, a1, b1), facePoint(q, face, a0, b1),
        ]));
        cell.path.setAttribute("fill",
          cell.path === hovered ? HOVER_FILL : entry.fill);
      }
      entry.border.setAttribute("d", polygon([
        facePoint(q, face, -1, -1), facePoint(q, face, 1, -1),
        facePoint(q, face, 1, 1), facePoint(q, face, -1, 1),
      ]));
      caption(q, entry);
    }
    for (const entry of faces) {
      if (shown.has(entry)) continue;
      entry.group.style.display = "none";
      // A face that turned away takes the highlight with it: an element that
      // merely stops being displayed is not guaranteed a `pointerout`.
      if (hovered && entry.cells.some((cell) => cell.path === hovered)) {
        hovered = null;
      }
    }
    // BACK TO FRONT, and by MOVING the groups rather than rebuilding them —
    // `appendChild` on a node that is already a child relocates it. Guarded on
    // the order having actually changed, which during a drag it almost never
    // does: it changes only when the camera crosses an axis-aligned view.
    const key = visible.map(({ face }) => face.label).join(",");
    if (key !== order) {
      order = key;
      for (const { face } of visible) svg.appendChild(byFace.get(face).group);
    }
  };

  /**
   * One step of the loop: redraw only if the camera has turned since the last
   * one. Returns whether it touched the DOM.
   */
  const refresh = () => {
    const q = quaternion();
    if (!q) {
      // No scene to ask — before the first view lands, and again after a
      // `destroy()` that a re-attach follows. Clear once, not every frame.
      if (last === null) return false;
      last = null;
      blank();
      return true;
    }
    if (last && q[0] === last[0] && q[1] === last[1]
        && q[2] === last[2] && q[3] === last[3]) return false;
    last = q;
    draw(q);
    return true;
  };

  /**
   * ONE rAF LOOP THAT NEVER STOPS, and four float comparisons inside it.
   *
   * The overlay's loop stops itself when it has nothing to place, which works
   * there because the ordinary page has no pins; the cube always has something
   * to draw, so the same shape would spin a loop forever on every page. What is
   * cheap is not the loop but the DOM: four comparisons a frame are nothing,
   * a rewrite of thirty elements a frame is not — which is why the elements are
   * built once (`buildFace`) and a moving camera costs attribute writes rather
   * than a rebuild. The browser suspends rAF for a hidden tab by itself, so
   * there is no bookkeeping to do beyond this.
   *
   * NOT the trackball's `change` event, for the reason overlay.js gives: it
   * fires on camera moves and NOT on the frames a live build swap or a
   * visibility change redraws — and a swap re-seats the camera, which is exactly
   * the moment the cube must not be stale.
   */
  const tick = () => {
    frame = requestAnimationFrame(tick);
    refresh();
  };
  frame = requestAnimationFrame(tick);

  return {
    root,
    refresh,
    destroy() {
      // `if (frame)` is safe because a browser rAF handle is non-zero by spec
      // (HTML §8.10: the id is a positive integer). It would silently cancel
      // nothing under a shim that returns 0, which is the one way this loop
      // could outlive the element.
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      last = null;
      root.remove();
    },
  };
}
