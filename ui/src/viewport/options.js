// How the library is started, and the constants the tools around it are tuned
// to. Ported from the page viewer this interface replaced; every value that
// carries a reason carries it here too, because a number whose reason lives
// somewhere else is a number the next person will "simplify". The measured ones
// are pinned again, with their derivations, in tests/test_viewport_adapter.py.

// The one thing this adapter reaches OUT of itself for. The theme stopped being
// a viewport setting with issue #35 — it is the whole interface's palette now
// and the server decides it — so it is read from the module that keeps the rest
// of the per-reader state, rather than kept twice. The foot of this file says
// what used to be here and why it left.
import { readTheme } from "../store.js";

/**
 * `tools: false` is the whole point of this port: the library keeps the scene
 * and we draw the interface.
 *
 * It is CSS and nothing else (docs/viewer-api.md §1) — the tree, the toolbar,
 * the orientation marker and the animation slider get `style.display = "none"`,
 * while every object behind them is built and stays live. So `setStates`,
 * `setClipNormal`, the id picker and the mesh measurement backend all work
 * exactly as they do with the panel up, and switching the library's own tabs
 * from code keeps working too — which the section tool depends on.
 *
 * Every tool that restyles THE MODEL stays off, and the reason is the page rather
 * than the library: a build page is a snapshot and the model is whatever the
 * commit says it is, so a reader must not be able to show it as something other
 * than what was pushed. `studioTool`
 * is the expensive one — it drags in a postprocessing composer — and it is also
 * the one that would break per-part transparency, because Studio shares
 * materials between parts (docs/viewer-api.md §3).
 *
 * That is a rule about the MODEL and not a ban on settings. The canvas the model
 * stands on asserts nothing about the geometry, which is why `theme` below is the
 * reader's own answer and is remembered for them (`readTheme`, ui/src/store.js).
 */
export const displayOptions = {
  glass: true,
  tools: false,
  // A GETTER, not a value: a call at module scope would read the reader's answer
  // on every import of this module — including the ones a runner with no cookie
  // jar makes, where the answer is not wanted and the warning is noise — and it
  // would freeze it at import time, which is before anybody has been asked
  // anything. Read here, it runs exactly once, where element.js spreads this
  // object to build the viewer.
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
  // ONE VALUE FOR BOTH THEMES, and this is a measurement rather than an
  // oversight: it was picked against a dark canvas, so light was the side that
  // had to be checked, and light is the side it does BETTER on.
  //
  // Measured in Chrome on the fixture build (`make ui-fixture-data`), by reading
  // the rendered pixels out of a screenshot of each theme. The edge comes back as
  // exactly (112, 112, 112) in both — nothing about the theme touches it — and
  // the contrast where it matters is:
  //
  //     against the canvas    light #fff  4.95:1     dark #444  1.97:1
  //     against a face        identical in both (1.45:1 on the olive cap,
  //                           2.2:1 on the yellow plate)
  //
  // An interior edge cannot change with the theme at all, since neither colour
  // in that pair depends on it; only the SILHOUETTE meets the canvas, and there
  // light is two and a half times the separation dark ever had. So there is
  // nothing to make theme-dependent, and a lighter value "for the light theme"
  // would be undoing the better of the two cases.
  edgeColor: 0x707070,
  defaultOpacity: 0.5,
  normalLen: 0,
};

export const viewerOptions = {
  // ORTHOGRAPHIC, and this is load-bearing rather than a look. Under an ortho
  // projection every world point on the ray through a pixel has the same offset
  // from the camera once the component along the view axis is dropped, so a
  // gesture that has to keep a point under the cursor — the wheel zoom, the
  // swipe pan, the cursor pivot — needs no depth and therefore no picking at
  // all. `gestureInternals` checks `isOrthographicCamera` and hands everything
  // back to the library under perspective, because none of that maths holds
  // there and the fallback (the library's own centre zoom) is a working viewer.
  ortho: true,
  // `trackball`, not `orbit`. OrbitControls keeps a fixed up axis and clamps the
  // polar angle, so rotation stops dead at the poles — you cannot get under a
  // part, which is exactly the view somebody wants when something looks wrong.
  // CADTrackballControls sets `holroyd = true` by default, which is the
  // non-tumbling projection, so this needs no second option.
  control: "trackball",
  up: "Z",
  axes: false,
  axes0: false,
  grid: [false, false, false],
  transparent: false,
  blackEdges: false,
  collapse: 1,
  // THE CUT FACE IS THE PART'S OWN COLOUR, which is Fusion's `Section Color:
  // From Component` and its default.
  //
  // The library's own default is the other one, and it is not a colour anybody
  // chose for this model: `PLANE_COLORS[theme][index]` is indexed by WHICH OF
  // THE THREE CLIP PLANES cut the face, so every cut this tool makes came back
  // the same red (`light: [0xff0000, ...]`, `dark: [0xff4500, ...]` — this
  // viewport drives plane 0). One saturated red for a plate, a post and a cap
  // says the three are the same material, which is the one thing a section
  // drawing is read for.
  //
  // `Clipping.setObjectColorCaps` walks the cap meshes in the order they were
  // built — plane-major, one per (plane, solid) — against the `objectColors` it
  // recorded in the same order, so each cap ends up carrying the `color` of the
  // solid it caps. That colour is what `hatch.js` shades its lines from.
  clipObjectColors: true,
};

/** Pointer travel below which a press counts as a click rather than a drag. */
export const CLICK_PX = 4;

/** The opacity a ghosted part is FINALLY SHOWN AT — an answer, not a factor.
 *
 * The distinction is the whole reason this constant is written out. The field
 * `applyGhost` writes is `group.opacity`, and the library shows a face at
 * `group.opacity * group.alpha` (`ObjectGroup.setTransparent`), so that field is
 * a MULTIPLIER over the model's own alpha rather than anything a reader sees.
 * Assigning this number to it — which parts.js did, as a bare 0.25 — ghosts a
 * part whose author declared `alpha = 0.5` to half of what was asked for. So
 * parts.js divides by the alpha, and this is the number that comes out.
 *
 * 0.5 IS `renderOptions.defaultOpacity` ABOVE, said again for a second
 * mechanism. That field is what the library shows a globally transparent scene
 * at, so it is already this project's own answer to "how see-through is
 * translucent"; a ghost at some other number would be a second opinion about
 * the same question, differing for no reason anybody could name.
 *
 * A CEILING AND NOT A TARGET. Ghosting means "let me see past this part", so it
 * must never take a part FURTHER from view than that — and a part the author
 * already published at `alpha <= 0.5` is at or past ghost level before anybody
 * touches it. Ghosting it is therefore a no-op rather than a second division
 * that would leave it all but invisible, and un-ghosting gives back exactly the
 * alpha the model asked for.
 */
export const GHOST_OPACITY = 0.5;

/** Ring radii, in CSS pixels, for sampling a face around the cursor.
 *
 * NOT to be retuned by eye. `IdPicker.pickAt` renders its target at
 * `width * dpr * 0.5` — HALF resolution — so these radii are already coarser on
 * the buffer than they look on screen, and the smallest of them is a couple of
 * texels at dpr 1. Shrinking them collapses the ring onto the centre pixel and
 * the cross product it feeds becomes noise.
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
 * A plane laid EXACTLY on a face is coplanar with it, and the library's stencil
 * cap quad then z-fights the face over every pixel: measured in a browser, the
 * whole part comes back covered in moving stripes and reads as broken. A
 * ten-thousandth of the grid puts the plane just inside the surface, which
 * clears it completely — 0.009 mm on a 90 mm part. Relative to the grid so it
 * scales with the model instead of being right for one size of part.
 */
export const SECTION_BIAS = 1e-4;

/** Which of the library's three clip planes this tool drives. */
export const SECTION_INDEX = 0;

/**
 * Pixels of `deltaY` the browser emits per e-fold of PINCH SCALE. A measurement,
 * not a taste setting.
 *
 * macOS hands the browser a pinch as a gesture carrying a SCALE and the browser
 * turns it into ctrl+wheel before the page sees it. Measured (Chrome 151, driven
 * through CDP `Input.synthesizePinchGesture` with `gestureSourceType: "mouse"`,
 * the same code path a real trackpad takes):
 *
 *     gesture scale   events   sum of deltaY      -100 * ln(scale)
 *          2.00         11         -69.31             -69.31
 *          1.50         10         -40.55             -40.55
 *          1.25          6         -22.31             -22.31
 *          0.50         17         +69.31             +69.31
 *
 * — exact to five digits, and the same total however fast the gesture is run;
 * speed only changes how many events it is chopped into. So `sum(deltaY)` is
 * `-100 * ln(scale)` and `zoom *= exp(-deltaY / 100)` follows the gesture's own
 * scale exactly: spread the fingers until the gesture says "twice as big" and
 * the model is twice as big. Exponential and not linear, because the same finger
 * travel has to mean the same RATIO wherever the reader already is.
 *
 * WHY NOT THE LIBRARY'S ZOOM. Its wheel path is `deltaY * 0.00025 * zoomSpeed`,
 * calibrated for the ~100 px notch of a mouse wheel; at the trackball's
 * `zoomSpeed` of 2.0 that is an e-fold every ~2000 px, TWENTY TIMES slower than
 * the browser's own pinch scale — measured, the whole scale-2 gesture above
 * moved the zoom by x1.035. That is the bug this constant replaces.
 */
export const PINCH_DELTA_PER_E_FOLD = 100;

/** localStorage key for the one pointing-device answer. */
export const INPUT_KEY = "hammerola.pointing_device";

/** THE THEME IS NOT KEPT HERE ANY MORE, and this note is what replaces it.
 *
 * `hammerola.viewport_theme` lived in this file, in `localStorage`, and it was
 * the right home for exactly as long as the name said what it was: the colour of
 * the CANVAS, in an interface that was light around it whatever the canvas did.
 * Issue #35 made it the whole page's answer, which is a per-reader fact like the
 * token and the notes rather than a viewport setting, and the SERVER has to know
 * it before the page is sent — so it is a cookie now, and it lives with the rest
 * of that state in ui/src/store.js.
 *
 * What stays here is the one line the library needs: `displayOptions.theme`
 * above, still a getter, still answering at the moment element.js builds the
 * viewer — and `readTheme` is imported at the head of this file for it alone.
 *
 * THE BRIDGE IS GONE TOO. `readTheme` and `writeTheme` were re-exported from
 * here for one caller, HammerolaViewer.jsx, which had always asked this module
 * for them and could not be touched while the palette was being moved. It asks
 * store.js directly now, so the alias has no reader left — and an alias nobody
 * imports is a second name for one function, which is the thing this whole
 * issue is spending its effort removing.
 */

/** How long after the last press or wheel the viewport still counts as busy.
 *
 * A live swap re-renders the scene and re-seats the camera; doing that between a
 * mousedown and the mouseup is pulling the model out from under the pointer.
 */
export const IDLE_MS = 1200;
