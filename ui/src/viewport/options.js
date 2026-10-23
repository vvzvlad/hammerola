// How the library is started, and the constants the tools around it are tuned
// to. Each value's reason is written beside it so nobody "simplifies" it; the
// measured ones are pinned again in tests/test_viewport_adapter.py.

// The theme is the whole interface's palette, decided by the server and kept
// with the rest of the per-reader state in store.js (a cookie).
import { readTheme } from "../store.js";

/**
 * `tools: false`: the library keeps the scene and we draw the interface.
 *
 * It is only CSS (docs/viewer-api.md §1): the tree, toolbar, orientation marker
 * and animation slider get `style.display = "none"`, while everything behind
 * them stays live. `setStates`, `setClipNormal`, the id picker, the mesh
 * measurement backend and switching the library's tabs from code (which the
 * section tool depends on) all keep working.
 *
 * Every tool that restyles the model stays off: a build page is a snapshot of
 * what was pushed, and a reader must not be able to show it as something else.
 * `studioTool` would also drag in a postprocessing composer and break per-part
 * transparency, because Studio shares materials between parts
 * (docs/viewer-api.md §3).
 *
 * The canvas is not the model, so `theme` below is the reader's own choice
 * (`readTheme`, ui/src/store.js).
 */
export const displayOptions = {
  glass: true,
  tools: false,
  // A getter, not a value: reading at module scope would run on every import
  // (including test runners with no cookie jar) and freeze the answer at import
  // time. It runs once, where element.js spreads this object into the viewer.
  get theme() { return readTheme(); },
  treeWidth: 240,
  cadWidth: 800,
  height: 600,
  measureTools: false,
  selectTool: false,
  explodeTool: false,
  zscaleTool: false,
  zebraTool: false,
  studioTool: false,
};

export const renderOptions = {
  ambientIntensity: 1.0,
  directIntensity: 1.1,
  metalness: 0.3,
  roughness: 0.65,
  // One value for both themes, measured in Chrome on the fixture build
  // (`make ui-fixture-data`) from screenshot pixels. The edge renders as
  // (112, 112, 112) in both themes:
  //
  //     against the canvas    light #fff  4.95:1     dark #444  1.97:1
  //     against a face        identical in both (1.45:1 on the olive cap,
  //                           2.2:1 on the yellow plate)
  //
  // Interior edges cannot depend on the theme; only the silhouette meets the
  // canvas, and light already separates better than dark.
  edgeColor: 0x707070,
  defaultOpacity: 0.5,
  normalLen: 0,
};

export const viewerOptions = {
  // Orthographic, and load-bearing: under ortho every world point on the ray
  // through a pixel has the same offset from the camera once the view-axis
  // component is dropped, so the wheel zoom, swipe pan and cursor pivot need no
  // depth and no picking. `gestureInternals` checks `isOrthographicCamera` and
  // leaves everything to the library (its centre zoom) under perspective.
  ortho: true,
  // `trackball`, not `orbit`: OrbitControls clamps the polar angle, so you
  // cannot get under a part. CADTrackballControls defaults to
  // `holroyd = true`, the non-tumbling projection.
  control: "trackball",
  up: "Z",
  axes: false,
  axes0: false,
  grid: [false, false, false],
  transparent: false,
  blackEdges: false,
  collapse: 1,
  // The cut face takes the part's own colour (Fusion's `Section Color: From
  // Component`). The library default, `PLANE_COLORS[theme][index]`, colours by
  // which clip plane made the cut, so every cut here (plane 0) would be the
  // same red and every part would read as one material.
  //
  // `Clipping.setObjectColorCaps` walks the caps in build order (plane-major,
  // one per (plane, solid)) against `objectColors` recorded in the same order,
  // so each cap carries its solid's `color`; `hatch.js` shades its lines from it.
  clipObjectColors: true,
};

/** Pointer travel below which a press counts as a click rather than a drag. */
export const CLICK_PX = 4;

/** The opacity a ghosted part is finally shown at — an answer, not a factor.
 *
 * `applyGhost` writes `group.opacity`, and the library shows a face at
 * `group.opacity * group.alpha` (`ObjectGroup.setTransparent`), so that field
 * multiplies the model's own alpha. parts.js divides this number by the alpha
 * to get the field.
 *
 * 0.5 matches `renderOptions.defaultOpacity` above, the project's answer to
 * "how see-through is translucent".
 *
 * A ceiling, not a target: a part the author published at `alpha <= 0.5` is
 * already at or past ghost level, so ghosting it is a no-op and un-ghosting
 * restores exactly the model's alpha.
 */
export const GHOST_OPACITY = 0.5;

/** Ring radii, in CSS pixels, for sampling a face around the cursor.
 *
 * Not to be retuned by eye. `IdPicker.pickAt` renders at `width * dpr * 0.5`
 * (half resolution), so the smallest radius is a couple of texels at dpr 1;
 * shrinking them collapses the ring onto the centre pixel and the cross product
 * it feeds becomes noise.
 */
export const PROBE_PX = [7, 14, 26];

/** Sine between two ring samples below which the pair is too collinear to trust. */
export const MIN_SPREAD = 0.2;

/** ~8.6 degrees. Below this the clip normal points nearly straight at the
 *  camera, its screen projection collapses and the px -> world factor runs away
 *  to infinity; no drag is better than a plane that teleports. */
export const MIN_SINE = 0.15;

/** Depth bias when laying the plane on a face, as a fraction of the grid.
 *
 * A plane exactly on a face makes the stencil cap quad z-fight the face (the
 * part is covered in moving stripes). A ten-thousandth of the grid puts the
 * plane just inside the surface (0.009 mm on a 90 mm part) and scales with the
 * model.
 */
export const SECTION_BIAS = 1e-4;

/** Which of the library's three clip planes this tool drives. */
export const SECTION_INDEX = 0;

/* The section plane's handle (handle.js). Lengths are CSS pixels, so the grip
 * is the same size on a 2 mm part and a 200 mm one: `scene3d.js` scales its
 * mesh group every frame so one geometry unit is one canvas pixel. Projection
 * foreshortens the arrow by itself, so nothing here compensates for the
 * camera. */

/** The whole arrow's length. Long enough to read as a two-way arrow beside the
 *  cut, short enough not to cover the face it is standing on. */
export const HANDLE_PX = 56;

/** Each head, as long as it is wide: a cone this tall on a base this far
 *  across, so the arrow reads as an arrow from any side it is seen from. Seen
 *  nearly end-on it is a disc, which is what an arrow pointing at the reader
 *  looks like. */
export const HANDLE_HEAD_PX = 10;

/** The shaft's thickness. Twice the weight of the view cube's silhouette, which
 *  is drawn at 0.9: the cube stands on the empty corner of the canvas and this
 *  stands on the model, over a cut face and whatever colour the part happens to
 *  be, so the cube's hairline would disappear into it. */
export const HANDLE_SHAFT_PX = 2;

/** The diameter of the cylinder that takes the press. A hand cannot reliably hit
 *  a 2 px shaft, so the target is fatter than the ink: this is the whole width
 *  of it, against that shaft, and it is never drawn. */
export const HANDLE_HIT_PX = 18;

/**
 * How far the white casing stands outside the arrow's dark ink, in pixels.
 *
 * The grip is one dark colour on a canvas that is white or near-black
 * (`readTheme` in ui/src/store.js), so on the dark theme the ink nearly
 * matches the background. A slightly larger white copy drawn underneath gives
 * the contrast, the same construction as the rotation handles (`RING_CASE_PX`).
 * Two pixels reads without thickening the 2 px shaft into a slab.
 */
export const HANDLE_CASE_PX = 2;

/**
 * The radius of the grip's two rotation rings: the outer edge of their ink,
 * as `HANDLE_PX` is for the arrow.
 *
 * Derived from the arrow: both rings tilt the plane's normal, so each lies in a
 * plane containing the normal and crosses the arrow's axis at this radius,
 * twice. The number is the clearance over the arrowheads and must move with
 * `HANDLE_PX`.
 *
 * Three quarters of the arrow: the heads end at 28, their casing at 30, and the
 * ring's outermost band comes down to 37, leaving seven pixels, with the widget
 * inside 90 px across.
 */
export const HANDLE_RING_PX = (HANDLE_PX * 3) / 4;

/* A comment's arrow on the model (pins.js), in CSS pixels for the same reason
 * as the section grip: the same size on a 2 mm part and a 200 mm one. Separate
 * constants from `HANDLE_*`: the grip is a control standing on the cut, this is
 * a marker pointing into a face. */

/** The whole arrow, tip to tail. Long enough to stand clear of the face it
 *  points into, short enough that two comments on one part do not cross the
 *  model. */
export const PIN_PX = 40;

/** The head, as long as it is wide, like the grip's (`HANDLE_HEAD_PX`). It is
 *  most of what a press lands on, so it is wider than the grip's. */
export const PIN_HEAD_PX = 12;

/** The shaft's thickness. Heavier than the grip's 2 px, which stands on a white
 *  casing: this is red ink with nothing under it, on whatever colour the part
 *  is. */
export const PIN_SHAFT_PX = 3;

/**
 * Pixels of `deltaY` the browser emits per e-fold of pinch scale. A measurement.
 *
 * macOS hands a pinch to the browser as a scale gesture, which the browser turns
 * into ctrl+wheel. Measured in Chrome 151 via CDP
 * `Input.synthesizePinchGesture` with `gestureSourceType: "mouse"` (the real
 * trackpad path):
 *
 *     gesture scale   events   sum of deltaY      -100 * ln(scale)
 *          2.00         11         -69.31             -69.31
 *          1.50         10         -40.55             -40.55
 *          1.25          6         -22.31             -22.31
 *          0.50         17         +69.31             +69.31
 *
 * Exact to five digits, independent of gesture speed. So
 * `zoom *= exp(-deltaY / 100)` follows the gesture's own scale exactly.
 * Exponential, so the same finger travel means the same ratio at any zoom.
 *
 * The library's wheel path (`deltaY * 0.00025 * zoomSpeed`, tuned for ~100 px
 * mouse notches) at trackball `zoomSpeed` 2.0 is twenty times slower: the
 * scale-2 gesture above moves its zoom by x1.035.
 */
export const PINCH_DELTA_PER_E_FOLD = 100;

/** localStorage key for the one pointing-device answer. */
export const INPUT_KEY = "hammerola.pointing_device";

/* The move tool's axis arrows (gizmo.js), in CSS pixels for the same reason
 * as the section grip. Separate constants from `HANDLE_*`: the grip is one
 * double-headed arrow, this is three single-headed ones on one point, and
 * three arrows the grip's size would cover the part. Values that happen to
 * match must not tie the two widgets together. */

/** One arrow's length, from the part's centre outwards. */
export const GIZMO_PX = 64;

/** Each head, as long as it is wide. One head, pointing away from the part
 *  along the axis it is named for; the drag goes both ways. */
export const GIZMO_HEAD_PX = 9;

/** The shaft's thickness. Thinner than the grip's: three of these cross at the
 *  part's centre and a heavier line turns that crossing into a blot. */
export const GIZMO_SHAFT_PX = 2;

/** The width of the press cylinder against the 2 px shaft. Thinner than the
 *  grip's: three targets meet at one point, and fat ones would let the ray
 *  decide which axis the reader gets. */
export const GIZMO_HIT_PX = 14;

/** How much of an axis must survive the projection for its arrow to be drawn
 *  at all (the fraction `foreshorten` measures). Below it the arrow is removed,
 *  not shrunk.
 *
 * Unlike the section grip, which still drags as a disc on the vertical fallback
 * `sectionGripAxis` invents, an axis arrow has no fallback. And a nearly end-on
 * axis is violent, not dead: the drag divides by this fraction squared
 * (`onMove` in gizmo.js), so at 0.2 one pointer pixel moves 25 times as much
 * world as face-on. Turning the model a little brings the arrow back.
 *
 * 0.2 is about 11.5 degrees off the view axis, where the arrow is 13 px of its
 * 64.
 *
 * It is also the plane quads' floor, applied to `face`, the cosine between a
 * plane's normal and the view axis: the same 11.5 degrees measured from
 * edge-on, so an axis and the plane square to it are never both removed. A
 * quad's drag divides by `view . n`, which is `face`, so this floor bounds the
 * factor at five and `gizmo.js` needs no guard of its own.
 */
export const GIZMO_MIN_SCALE = 0.2;

/* The plane quads and origin dot of the same widget (gizmo.js), modelled on
 * Fusion's triad (`TriadCommandInput`): an origin, three arrows, three plane
 * quads and three rotation handles under one command.
 *
 * The placement is ours, not measured from Fusion: a third and a quarter of the
 * arrow length, so a quad clears the crossing of the shafts and ends inside the
 * arrowheads (21 px out to 37 px at its far corner, against a reach of 64).
 * Derived from `GIZMO_PX` so the quads follow the arrows. */

/** How far the near corner of a plane quad stands off the widget's centre, at
 *  the full px-per-world-unit — a third of one arrow. */
export const GIZMO_PLANE_GAP_PX = GIZMO_PX / 3;

/** The quad's side at that same scale — a quarter of one arrow. Its outer edge:
 *  the casing and rim are drawn inside it, so this is all the quad covers. */
export const GIZMO_PLANE_PX = GIZMO_PX / 4;

/** The origin dot's diameter, in CSS pixels.
 *
 * Screen-space, since the point has no axis or plane to foreshorten. Larger
 * than an arrowhead, so it covers the crossing of the shafts. It is drawn,
 * never pressed (`gizmo.js`), so the size is about legibility. */
export const GIZMO_DOT_PX = 12;

/** The light casing the quads and the dot are carried on, in CSS pixels at
 *  full scale.
 *
 * The same construction as `RING_CASE_PX`/`RING_RIM_PX` (a light casing inside a
 * dark rim, the only legibility that survives a red mark on a red part on both
 * canvases), but separate constants so the widgets can diverge. */
export const GIZMO_CASE_PX = 2;

/** The dark rim outside that casing, in px.
 *
 * A hairline: the casing holds the ink against dark geometry and the rim holds
 * the casing against a light canvas. One pixel is an edge without reading as a
 * second colour. Its own constant, not `RING_RIM_PX`, so the widgets can
 * diverge. */
export const GIZMO_RIM_PX = 1;

/* The same widget's rotation handles (rings.js), part of the `move` tool. CSS
 * pixels, so a ring is neither a thread round a 200 mm part nor a hoop round a
 * 2 mm one. A ring shares no dimension with an arrow, so these are separate
 * constants. */

/** The ring's radius on the screen: the semi-axis of the ellipse at its widest.
 *
 * Fusion's number, measured off its installed manipulator sprites. The press is
 * taken by a disc on the circle (`RING_DISC_PX`), not by the curve.
 *
 * A handle sits at `RING_PX` times the sine of the angle between its axis and
 * the view direction. Down the diagonal (the fixtures' pose) all three discs
 * come in to about 61 px, and an arrow is drawn at about 52 px, so the discs sit
 * outside the arrowheads; at the `RING_MIN_PX` floor a handle is 21 px from the
 * centre. The halves do not fight because only a disc takes a press here, only
 * its own element on the arrows' side, and the rest goes to the trackball.
 *
 * The widest point: under an ortho camera the plane of any circle meets the
 * screen plane in a line, so one direction of every ring projects at full
 * px-per-world-unit, which makes one number enough for all three.
 */
export const RING_PX = 105;

/** The disc handle's width at that same widest point — the one thing on a ring
 *  that takes a press.
 *
 * Fusion's number. Three equal circles cross six times and knot at the centre,
 * so aiming at a curve is hard; a 20 px disc is aimed at like a button, and the
 * target is as wide as what is drawn.
 *
 * A flat disc in the ring's own plane (`rings.js`), not a screen dot: the camera
 * squashes it with its ring, so a ring turned nearly edge-on flattens its
 * handle too. */
export const RING_DISC_PX = 20;

/** Half the arc drawn through the disc at rest, in degrees of the ring's own
 *  circle, the ink fading to nothing at both ends.
 *
 * Measured from Fusion's at-rest sprite. ±57 degrees is a third of a full
 * circle's ink, pointing along the way the part will go, so the rings do not
 * drown the geometry. It still reaches the crossings (the handle sits at 45
 * degrees, the other rings cross at 0 and 90) with about a fifth of the ink
 * left there. Hover draws the full circle (`rings.js`). */
export const RING_ARC_DEG = 57;

/** The white casing carried by everything this widget draws, in px at the
 *  widest point.
 *
 * Fusion's construction, not its palette: ours keep the RGB triad `gizmo.js`
 * spells. A light casing inside a dark rim is the only legibility that works
 * for a red disc on a red part on both canvases (`readTheme`).
 *
 * The casing is a slightly larger copy of the ink drawn underneath (meshes, so
 * no CSS filter), a band of known width, which keeps the ring's widest point at
 * exactly `RING_PX`. */
export const RING_CASE_PX = 2;

/** The dark rim outside that casing. A hairline, because it is doing the
 *  opposite job: the white casing is what holds the ink against dark geometry,
 *  and this is what holds the CASING against the light canvas — which needs a
 *  boundary and not a band. */
export const RING_RIM_PX = 1;

/** The ring's line width, uniform along the curve under every camera.
 *
 * The same weight as the arrows' shaft: three of these cross the part, and a
 * heavier line turns the crossings into blots.
 *
 * The ring is a round tube, the circle grown by a ball; an orthographic
 * projection of that is the projected ellipse grown by a disc of the same
 * radius, so the line is 2 px wide all the way round. `RING_PX` names the
 * widest point exactly because the tube is centred half a shaft inside it.
 */
export const RING_SHAFT_PX = 2;

/** How flat a ring may be seen before it is removed rather than floored — the
 *  minor semi-axis of its projected ellipse, in pixels.
 *
 * Set by the disc: it is squashed with its ring (`rings.js`), so at this floor
 * it is `RING_DISC_PX * RING_MIN_PX / RING_PX` (four pixels) across at its
 * narrowest. A control the reader can see but not aim at is worse than none;
 * turning the model a little brings it back. The drag angle has no such floor
 * (only a ray lying exactly in the ring's plane has no answer).
 *
 * 21 is `RING_PX * GIZMO_MIN_SCALE`: foreshortened to a fifth, 11.5 degrees of
 * tilt. But an arrow collapses as its axis approaches the view axis, while a
 * ring collapses as its axis approaches the screen plane, so they stay separate
 * constants.
 *
 * The section grip's rings have a major semi-axis of `HANDLE_RING_PX` (42), so
 * the same 21 px is a half there, i.e. 30 degrees of tilt; `handle.js` justifies
 * it from its 9 px hit-tube half-width. Retuning this moves the grip's
 * threshold too.
 */
export const RING_MIN_PX = 21;

/** How long after the last press or wheel the viewport still counts as busy.
 *
 * A live swap re-renders the scene and re-seats the camera; doing that between a
 * mousedown and the mouseup is pulling the model out from under the pointer.
 */
export const IDLE_MS = 1200;
