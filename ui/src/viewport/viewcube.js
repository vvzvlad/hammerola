// The view cube: a small cube drawn over the canvas that turns with the camera
// and snaps it to a standard view when a cell is clicked. Fusion's widget and
// subdivision: 6 faces + 12 edges + 8 corners = 26 targets, all cells of one
// 3x3 grid per face.
//
// It lives in the viewport rather than in React for overlay.js's reason: it is
// a projection through a camera that moves sixty times a second. Nothing
// crosses the boundary; the widget reads and writes the camera only.
//
// Not a second three.js scene: a unit cube is eight corners and six quads, not
// worth a second WebGL context. The projection is done by hand and is
// orthographic (camera-space z dropped), independent of the scene's own
// projection.

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
 * fraction of the em, so text is sized without reading geometry back from the
 * DOM every frame. Measured with `getComputedTextLength()` in Chrome on the iso
 * view's three labels: 0.725, 0.664 and 0.715 em per character, so 0.75.
 *
 * `CAPTION_MARGIN` is how much of the face's width the label may take: the face
 * is a rhombus and the chord is measured through its centre, so a label filling
 * the chord would cross the sloping sides above and below it.
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
 * The two vocabularies differ on one word: the label BACK is the library's
 * `rear` (`defaultDirections.z_up` in static/_v/three-cad-viewer.esm.js).
 * `preset` is the library's spelling, the only one passed to the API; `label`
 * never leaves the drawing.
 *
 * `u` and `v` span the face: its corners are `n ± u ± v` and the cell at grid
 * offset (su, sv) points at `n + su*u + sv*v`. They are right-handed with the
 * normal (`u × v = n`), winding all six quads the same way, and match the screen
 * axes of that face's preset view, so the grid lines up with the result of a
 * click.
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
 * Rotate `v` by the conjugate of the unit quaternion `q = [x, y, z, w]`.
 *
 * `getCameraQuaternion()` is the camera's rotation, camera space to world; the
 * cube as seen from the camera needs the inverse, which for a unit quaternion
 * is the conjugate. The arithmetic is three.js's `Vector3.applyQuaternion` with
 * the vector part negated; this is its only caller.
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
 * The faces turned towards the reader, back to front.
 *
 * A face is visible when its rotated outward normal has positive camera-space
 * z. For a cube centred on the origin the normal is the face centroid, so the
 * same z orders the faces by depth. Three are visible in general, one or two in
 * axis-aligned views (edge-on faces would be slivers).
 *
 * Visible faces of a convex body cannot overlap, so the order is only a cheap
 * safeguard.
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
 * The six faces go one way and the other twenty the other; unifying them puts
 * a randomly rolled top view on screen. From the vendored library
 * (static/_v/three-cad-viewer.esm.js):
 *
 *   * `setCameraPosition(position, relative, notify)` calls `camera.setPosition`
 *     (position only, no aiming) and then `controls.update()`;
 *     `TrackballControls.update()` ends, for an orthographic camera, in
 *     `this.object.lookAt(this.target)`.
 *   * `Object3D.lookAt` (three's code, static/_v/three.core.js) derives the roll
 *     from `camera.up`, `[0, 0, 1]` here (`up: "Z"` in options.js). With the view
 *     direction parallel to up the cross product degenerates and the roll is
 *     arbitrary.
 *   * Looking straight down (`top`) or up (`bottom`) is that case, which is why
 *     `defaultDirections.z_up` carries an explicit quaternion for those two and
 *     `presetCamera` applies it after the `lookAt`.
 *
 * So the faces go through `presetCamera` (`front`, `rear`, `left`, `right` too:
 * same table, the library's own entry point, and `presetCamera(dir, zoom =
 * null)` keeps the current zoom).
 *
 * The twelve edges and eight corners have no preset. None is parallel to
 * `[0, 0, 1]`, so the roll is well defined, and `relative: true` makes the
 * vector a direction (normalised and scaled by the current camera distance).
 * The `lookAt` in that chain does not run under this configuration; see
 * `applyCameraTarget`.
 *
 * The target: `presetCamera` re-seats the camera target on the bounding box
 * centre (`camera.target` and `controls.target`), discarding any pan.
 * `applyCameraTarget` recentres on the edge/corner path too, so every click on
 * the cube goes to a centred standard view; any click discards a pan.
 */
export function cameraTarget(dir) {
  const preset = PRESET_BY_NORMAL.get(dir.join(","));
  if (preset) return { kind: "preset", preset };
  return { kind: "position", position: [dir[0], dir[1], dir[2]] };
}

/**
 * Point the camera at one of the 26 directions (see `cameraTarget` for the two
 * paths).
 *
 * The edge/corner path needs a second call. `control: "trackball"` is
 * `CADTrackballControls`, whose `update()` skips the `lookAt` while `holroyd`
 * is on (its default, and why the option was chosen, options.js): holroyd sets
 * the quaternion directly and a `lookAt` would undo the tilted rotation axis.
 *
 * So `setCameraPosition` alone moves the eye and leaves the camera pointing
 * where it was. Measured against the fixture build: from the top view,
 * `setCameraPosition([-1, 1, 1], true, true)` put the camera at
 * (-49, 49, 56.6) with quaternion (0, 0, 0, 1), still staring down, and 19 of
 * the 20 edge/corner targets put the whole model outside the frustum (an empty
 * canvas, no error). `camera.lookAtTarget()`, the call the override skips,
 * fixes it with the same `camera.up`-derived roll every preset gets.
 *
 * It goes through `internals()` because the only public alternative,
 * `setCameraQuaternion`, would mean reimplementing the library's roll
 * convention here.
 *
 * The aiming is checked before the move, and the move is abandoned without it:
 * a camera moved without turning is worse than a click that did nothing.
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
    // `notify: false` on the move, since the frame is half-built until aimed;
    // `viewer.update(true, true)` below renders it and notifies subscribers.
    viewer.setCameraPosition(target.position, true, false);
    g.camera.lookAtTarget();
    if (typeof viewer.update === "function") viewer.update(true, true);
  } catch (error) {
    console.warn("viewcube", error);
  }
}

/**
 * Put the camera target back on the bounding box centre, as `presetCamera`
 * does (see `cameraTarget`).
 *
 * Both targets, separate objects in the library: `Camera.target` is what
 * `setupCamera(relative)` measures the new eye position from and what
 * `lookAtTarget()` aims at; `controls.target` is what the trackball turns
 * around. `Viewer.presetCamera` writes the first and copies it into the second,
 * and nothing else writes `Camera.target` (a pan moves `controls.target` only).
 * Writing one alone would aim at one point and spin about another.
 *
 * `Camera.target` is mutated in place, since the only `Vector3` constructor is
 * inside the bundle. Each field is guarded: a widget that cannot recentre
 * should still snap to the clicked direction.
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
 * Opaque and the same in both themes: the canvas is white or near-black
 * (`readTheme` in ui/src/store.js), so light grey faces in a dark outline
 * bring their own ground and read on either.
 */
function shade(nz) {
  const value = 214 + Math.round(32 * Math.min(1, Math.max(0, nz)));
  return `rgb(${value},${value},${value})`;
}

/**
 * Half the horizontal chord of a face's projected parallelogram, through its
 * centre: the room its upright caption has.
 *
 * A projected face is `{ c + a*pu + b*pv : |a| <= 1, |b| <= 1 }`, and the
 * horizontal line through `c` is where `a*pu.y + b*pv.y = 0`. Pushing the axis
 * with the larger y component to its edge keeps the other within its bound,
 * hence the branch on that comparison.
 *
 * The faces are rhombi that change shape as the cube turns, so a fixed font
 * size is either too big for narrow ones or too small for all.
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
  // No class name, unlike the overlay's root: a class promises a stylesheet
  // rule (tests/test_ui_source.py checks that), and this widget is styled
  // entirely from inside for legibility on both themes.
  //
  // The bottom-left corner is the only one free of interface chrome.
  //
  // `pointer-events: none` on the layer and back on for the cells, as in the
  // overlay, so the layer does not block rotation in the patch it covers.
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
  // The cell path under the pointer, or null. Kept here and used by `draw`,
  // which rewrites every cell's `fill` each frame the camera moves.
  let hovered = null;
  // Whether the last read of the camera threw AND has already been reported.
  let warned = false;
  // The visible faces of the last draw, in the order they were stacked in.
  let order = "";

  /** The camera's rotation, or null if there is no scene to ask. */
  const quaternion = () => {
    try {
      const viewer = vp && vp.viewer;
      // `viewer.ready`, as in internals.js, rather than catching: the library's
      // `get rendered()` throws until `render()` succeeds, and
      // `getCameraQuaternion` reads through it. A failed view file leaves
      // `vp.viewer` standing (element.js sets `loadFailed`, emits `hmr:error`),
      // and this loop runs every frame.
      if (!viewer || !viewer.ready
          || typeof viewer.getCameraQuaternion !== "function") return null;
      const q = viewer.getCameraQuaternion();
      if (!Array.isArray(q) || q.length !== 4 || !q.every(Number.isFinite)) {
        return null;
      }
      // Whatever was wrong is over; a recurring fault gets a new console line.
      warned = false;
      return q;
    } catch (error) {
      // Once, not every frame: this runs inside a rAF loop.
      if (!warned) {
        warned = true;
        console.warn("viewcube", error);
      }
      return null;
    }
  };

  /**
   * Every element of one face, built once: nine cells, an outline and a caption.
   * `draw` only writes `d`, `fill` and `display` on them, so a moving camera
   * costs attribute writes, not a rebuild.
   *
   * Listeners are delegated: one per event type on the `svg`, resolved back to a
   * cell through `dataset`, which is why `dataset` carries the indices.
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

    // The face's name, upright at its centre, hidden when it does not fit.
    //
    // Horizontal, not in the face's plane: in-plane text would turn upside down
    // at half the reachable orientations (the trackball has no pole, options.js);
    // the cube itself carries the orientation.
    //
    // Only position and size change, so the label is written once.
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

  // `pointerover`/`pointerout`, not `pointerenter`/`pointerleave`, which do not
  // bubble and cannot be delegated. Moving between cells fires the old `out`
  // before the new `over`, the order these handlers need.
  svg.addEventListener("pointerover", (event) => hover(event.target, true));
  svg.addEventListener("pointerout", (event) => hover(event.target, false));

  // A safeguard only. The cube's root is a sibling of `vp.box`, and every press
  // listener (tools.js, orbit.js, live.js, wheel.js) is on `vp.box` or `window`,
  // so a cell press never traverses them; overlay.js listens on the pin buttons.
  // tools.js, the capture-phase one, also checks `event.target !== g.canvas`,
  // which is what actually keeps it safe. This matters only if the cube is ever
  // reparented under `vp.box`.
  svg.addEventListener("pointerdown", (event) => {
    if (cellAt(event.target)) event.stopPropagation();
  });

  // The `click` is let through: the interface closes every open menu (tree
  // row, revision dropdown, Downloads, token popup) from one `onClick` on its
  // root div (HammerolaViewer.jsx, `rootClick`). Only the press must be kept
  // off the canvas.
  svg.addEventListener("click", (event) => {
    const found = cellAt(event.target);
    if (!found) return;
    applyCameraTarget(vp && vp.viewer,
                      cellDirection(found.entry.face, found.cell.col, found.cell.row));
  });

  /** Place and size one face's caption, or hide it.
   *
   * Sized from the face, since the rhombi change width and the labels are three
   * to six characters. A face nearly edge-on gets no caption: a name drawn
   * across its neighbours reads as a rendering fault.
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
    // Back to front, by moving the groups (`appendChild` relocates an existing
    // child), and only when the order changed, which happens only when the
    // camera crosses an axis-aligned view.
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
   * One rAF loop that never stops, with four float comparisons per frame.
   *
   * Unlike the overlay (whose loop stops when there are no pins), the cube
   * always has something to draw. The loop is cheap; the DOM is what costs, so
   * elements are built once and a moving camera costs attribute writes. The
   * browser suspends rAF for hidden tabs.
   *
   * Not the trackball's `change` event, which does not fire on frames redrawn
   * for a live build swap or a visibility change; a swap re-seats the camera.
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
      // `if (frame)` is safe because a browser rAF handle is a positive integer
      // (HTML §8.10).
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      last = null;
      root.remove();
    },
  };
}
