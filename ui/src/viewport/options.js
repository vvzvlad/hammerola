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

/* The section plane's handle (handle.js). The lengths are CSS PIXELS, which is
 * what keeps the grip the same size on a 2 mm part and a 200 mm one — and they
 * still are now that the grip is a group of meshes in the scene rather than a
 * div over it: `scene3d.js` scales that group every frame so one unit of its
 * geometry is one pixel on the canvas.
 *
 * WHAT IS NO LONGER A NUMBER HERE is how much of the arrow a camera leaves. A
 * mesh lying along the plane's normal foreshortens because the projection
 * foreshortens it, so there is nothing left to compute and nothing to floor. */

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
 * THE 3D ANSWER TO `HALO`, and it has to exist in some form: the grip is one
 * dark colour on a canvas that is white or near-black depending on the reader
 * (`readTheme` in ui/src/store.js), so on the dark theme the ink is nearly the
 * background. The DOM layer bought its contrast with a `drop-shadow` filter,
 * which has no meaning for a mesh; a second, slightly larger copy of the arrow
 * drawn underneath in white is the same idea as geometry, and it is the
 * construction the rotation handles already use (`RING_CASE_PX`, which is this
 * number). Two pixels is what reads at a glance without thickening a 2 px shaft
 * into a slab.
 */
export const HANDLE_CASE_PX = 2;

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

/* The move tool's axis arrows (gizmo.js). CSS PIXELS again, and for the same
 * reason the section grip's lengths are: the widget has to be the same size on
 * a 2 mm part and a 200 mm one.
 *
 * THEIR OWN NUMBERS AND NOT THE `HANDLE_*` ONES, though three of the four look
 * alike. The grip is ONE double-headed arrow standing on a cut face; this is
 * THREE single-headed ones standing on the same point, and three arrows that
 * are as long and as fat as that one cover the part they are supposed to be
 * moving. Sharing the constants would make every future adjustment to either
 * widget an adjustment to both, which is a price two numbers that merely happen
 * to be equal today should never be paying. */

/** One arrow's length, from the part's centre outwards. */
export const GIZMO_PX = 64;

/** Each head, as long as it is wide — `HANDLE_HEAD_PX`'s reasoning, one head
 *  instead of two: the arrow points AWAY from the part along its axis, because
 *  that is the direction the axis is named for, and the drag goes both ways. */
export const GIZMO_HEAD_PX = 9;

/** The shaft's thickness. Thinner than the grip's: three of these cross at the
 *  part's centre and a heavier line turns that crossing into a blot. */
export const GIZMO_SHAFT_PX = 2;

/** The height of the box that takes the press, against that 2 px shaft. Lower
 *  than the grip's for the reason above: three overlapping targets meeting at
 *  one point, and a fat one would decide which axis the reader gets by which
 *  arrow happens to be drawn last. */
export const GIZMO_HIT_PX = 14;

/** How much of an axis must survive the projection for its arrow to be drawn
 *  at all — the fraction `foreshorten` measures, and BELOW IT THE ARROW IS
 *  TAKEN OFF THE SCREEN rather than floored.
 *
 * TAKEN OFF AND NOT SHRUNK, deliberately, and the difference from the section
 * grip is what a stub would still be good for. The grip's collapses to a disc
 * and STILL DRAGS: it moves the plane along a normal that is pointing at the
 * reader, on the vertical fallback `sectionGripAxis` invents. An axis arrow has
 * no such fallback, because the constraint is the whole point of it.
 *
 * AND UNUSABLE HERE MEANS VIOLENT RATHER THAN DEAD, which is the half that is
 * easy to get backwards. The drag divides by this fraction SQUARED (`onMove` in
 * gizmo.js says why: the screen only ever sees that much of the axis, and the
 * projection takes the factor twice), so a nearly end-on axis does not sit
 * still — it multiplies every tremor of the hand. At 0.2 one pixel of pointer
 * buys twenty-five times the world it buys face-on, which is already several
 * snap steps; the reader turns the model a little and the arrow comes back.
 *
 * 0.2 is about 11.5 degrees off the view axis, where the arrow is down to 13 px
 * of its 64 — the shaft nearly gone and the head, which keeps its own size,
 * standing for most of what is left.
 *
 * AND IT IS THE PLANE QUADS' FLOOR TOO, read off the complementary quantity:
 * `face`, the cosine between a plane's normal and the same view axis, which is
 * the fraction of that plane the projection leaves. The same fifth, the same
 * 11.5 degrees, now measured from EDGE-ON rather than from end-on — and the
 * two are the two readings of one angle, so an axis and the plane square on to
 * it are never both taken off the screen.
 *
 * IT IS LOAD-BEARING IN THE SAME WAY FOR BOTH. A quad's drag meets the ray
 * through the cursor with its own plane and divides by `view . n`, which IS
 * `face` — so this floor is what keeps that divisor at or above a fifth and
 * the factor at or below five, and `gizmo.js` adds no guard of its own because
 * a quad below it is never on screen to be pressed. Edge-on there is nothing
 * to guard: a plane seen edge-on projects onto one line, and "put the grabbed
 * point back under the pointer" stops naming a point.
 */
export const GIZMO_MIN_SCALE = 0.2;

/* The plane quads and the origin dot of the same widget (gizmo.js), which is
 * Fusion's triad rather than three arrows: an origin, three arrows, three plane
 * quads and three rotation handles, all at once and under one command
 * (`TriadCommandInput`).
 *
 * THE PLACEMENT IS OURS AND IS NOT A MEASUREMENT OF FUSION'S, which is worth
 * saying plainly because the ring family above IS one and the two blocks read
 * alike. Nothing here was read off a sprite; the two numbers are a third and a
 * quarter of the arrows' own length, chosen so that a quad clears the blot at
 * the centre where three shafts cross and still ends well inside the arrowheads
 * — 21 px out and 37 px at its far corner, against a reach of 64.
 *
 * DERIVED FROM `GIZMO_PX` AND NOT WRITTEN OUT, so the quads follow the arrows
 * the day that number moves. Written as two independent lengths they would
 * stay where they are and quietly drift out of the triad. */

/** How far the near corner of a plane quad stands off the widget's centre, at
 *  the full px-per-world-unit — a third of one arrow. */
export const GIZMO_PLANE_GAP_PX = GIZMO_PX / 3;

/** The quad's side at that same scale — a quarter of one arrow. Its outer edge:
 *  the casing and the rim below are drawn INSIDE it, exactly as the ring's
 *  circles are, so this is the whole of what the quad covers. */
export const GIZMO_PLANE_PX = GIZMO_PX / 4;

/** The origin dot's diameter, in CSS pixels.
 *
 * A screen-space circle and not a world one: it stands for the free drag, which
 * has no axis and no plane to be foreshortened by. Larger than an arrowhead,
 * because it is the target the hand goes to when it wants no constraint at all
 * and it sits where three shafts already cross; small enough that it covers
 * about a tenth of each arrow's own reach. */
export const GIZMO_DOT_PX = 12;

/** The light casing the quads and the dot are carried on, and the dark rim
 *  outside it, in CSS pixels at the full scale.
 *
 * `RING_CASE_PX` AND `RING_RIM_PX`'S CONSTRUCTION AND NOT THEIR NUMBERS, for
 * the reason the whole of this file keeps two widgets' lengths apart: what is
 * shared is the MECHANISM — a light casing inside a dark rim — because it is
 * the only kind of legibility that survives a red mark on a red part and two
 * canvases at once, and it is construction rather than palette. They happen to
 * be the same two values today and they are free to move apart.
 *
 * AND NOT THE ARROWS' `filter` HALO, though these two pieces are the arrows'
 * own widget. A halo is an EDGE treatment sized for a 2 px shaft, where the
 * ink is nearly all edge already; the quad and the dot are FILLED shapes ten
 * pixels across, where a 1 px glow is a hairline round a block of one colour.
 * The quad has a second reason of its own, which `gizmo.js` gives at the
 * element: it is drawn under a projection matrix, and a `filter` is computed in
 * the element's own space, so the glow is squashed with the shape rather than
 * drawn round it. `RING_CASE_PX` now reaches the same answer by the same road —
 * its matrix used to MAGNIFY a glow and no longer does, so what is left there
 * is what is left here: geometry gives an exact edge and a filter an
 * approximate one. */
export const GIZMO_CASE_PX = 2;

/** The dark rim outside that casing, in px.
 *
 * A HAIRLINE, because it does the opposite job: the casing holds the ink against
 * dark geometry and the rim holds the CASING against light geometry, and a white
 * band with no edge on a white canvas is a shape with no outline. One pixel is
 * enough for an edge and little enough not to read as a second colour — which is
 * exactly `RING_RIM_PX`'s argument, and this is deliberately a constant of its
 * own rather than a reference to it: the two widgets share the MECHANISM and not
 * the number, and a rim that changed on the arrows because the rings wanted a
 * heavier one would be a change nobody asked for. */
export const GIZMO_RIM_PX = 1;

/* The same widget's rotation handles (rings.js), which answer to the same
 * `move` tool as everything above. CSS PIXELS for the third time, and for the
 * reason the two families above give: a widget that stood at a size in WORLD
 * units would be a thread round a 200 mm part and a hoop round a 2 mm one.
 *
 * THEIR OWN NUMBERS AGAIN, and here the case is easier than it was for the
 * arrows: a ring is not an arrow at all. What it is drawn with — a radius, a
 * line, a disc to take the press, an arc round it, a casing that keeps both
 * legible, and a floor on how flat it may be seen before it goes — has no
 * member in common with a shaft and a head, so there is nothing to share even
 * before the argument about sharing. */

/** The ring's radius ON THE SCREEN: the semi-axis of the ellipse at its widest.
 *
 * FUSION'S OWN NUMBER, measured off its installed manipulator sprites rather
 * than remembered, and it is deliberately NOT the arrows' 64 the way this
 * constant used to be. The two halves stand on the same point and — since the
 * tools were merged — ALWAYS at the same time, which makes the paragraph below
 * about reach a live question rather than an academic one. This half is no
 * longer a hoop the reader aims the curve of: the press is taken by a disc
 * sitting on the circle (`RING_DISC_PX`).
 *
 * AND IT DOES NOT PUT THE WIDGET OUTSIDE THE ARROWS' REACH, which is the
 * tempting thing to say about a radius bigger than `GIZMO_PX` and is false. Only
 * the WIDEST point of a ring is this far out; a handle sits wherever its own
 * circle carries it, at `RING_PX` times the sine of the angle between its axis
 * and the direction of view. Down the diagonal — the pose this project's own
 * fixtures take — every ring's narrow direction is exactly where its handle
 * stands, so all three discs come in to about 61 px, and at the `RING_MIN_PX`
 * floor a handle is 21 px from the centre.
 *
 * AND 64 IS NOT THE NUMBER TO COMPARE THOSE WITH, which is the easy mistake to
 * make twice: an arrow foreshortens too. Down that same diagonal it is drawn at
 * `GIZMO_PX` times its own sine, about 52 px, so the discs are in fact outside
 * the arrowheads there rather than inside them. Both numbers move with the pose
 * and neither is a distance the other can be checked against once. What keeps
 * the two halves from fighting is not distance at all: only a disc takes a press
 * on this side, only its own element takes one on the other, and everything a
 * press misses goes to the trackball.
 *
 * WHY IT IS THE WIDEST POINT and not "the radius". A world circle seen at an
 * angle projects to an ellipse, and under an ortho camera the plane of any such
 * circle meets the plane of the screen in a line — so one direction of every
 * ring is always square on to the reader and always projects at the full
 * px-per-world-unit. That direction is this many pixels for all three rings,
 * whatever the camera is doing, which is what makes one number enough.
 */
export const RING_PX = 105;

/** The disc handle's width at that same widest point — the one thing on a ring
 *  that takes a press.
 *
 * FUSION'S NUMBER AGAIN, and the pair is the whole answer to "you cannot hit the
 * axis you mean". Three circles of one radius cross each other six times and
 * knot at the centre, so a curve is something a hand has to be told how to aim
 * at; a 20 px disc is aimed at the way a button is. It also replaces the
 * tolerance the old curve test needed (`RING_HIT_PX`, deleted with it) — there
 * is nothing left to invent a tolerance for, because the target is now as wide
 * as what is drawn.
 *
 * A CIRCLE IN THE RING'S OWN PLANE and not a dot on the screen, which `rings.js`
 * now draws as exactly that — a flat disc standing on the circle, in the world
 * plane the ring's axis is normal to. The camera squashes it with its ring, so
 * it lies ON the curve instead of floating over it, and a ring turned nearly
 * edge-on says so by flattening its handle along with itself. */
export const RING_DISC_PX = 20;

/** Half the arc drawn through the disc AT REST, in degrees of the ring's own
 *  circle — the ink fading to nothing at both ends.
 *
 * MEASURED, not chosen: it is the span Fusion's own at-rest sprite covers. What
 * it buys is the complaint about the rings drowning in the geometry. Three full
 * circles were three closed curves of one size lying across the part and across
 * each other; ±57 degrees through each handle is a third as much ink and it
 * points along the way the part will go. IT STILL REACHES THE CROSSINGS — the
 * handle sits at 45 degrees of its circle and the two rings it meets cross it at
 * 0 and 90, which are 45 away, well inside this span. What is left of the ink
 * there is about a fifth, and that is the whole difference: the three curves
 * still meet, as three circles about one centre must, but they meet as a hint
 * rather than as the knot the reader could not aim into. The full circle is what
 * HOVER says (`rings.js`), which is when the reader is asking about one axis
 * rather than looking at a part. */
export const RING_ARC_DEG = 57;

/** The white casing carried by everything this widget draws, in px at the
 *  widest point.
 *
 * FUSION'S CONSTRUCTION AND NOT ITS PALETTE, and the difference is deliberate:
 * its handles are grey and ours keep the RGB triad `gizmo.js` spells (half a
 * widget in grey beside arrows in colour would be worse than either). What we
 * take is the LEGIBILITY MECHANISM — a light casing inside a dark rim — because
 * it is construction rather than colour, and it is the only kind that works: a
 * red disc on a red part is invisible whatever red it is, and the two canvases
 * this interface runs on (`readTheme`) rule out picking an ink that carries on
 * both.
 *
 * NOT A GLOW, and there is nothing left for a glow to be: the widget is meshes
 * in the scene now (`rings.js`), where a CSS filter has no meaning at all —
 * which is the same place `HANDLE_CASE_PX` arrived at for the section grip. The
 * casing is a second, slightly larger copy of the ink drawn underneath it, so
 * it is a band of a known width rather than an edge of an approximate one, and
 * that is what lets the rest of this file go on saying the ring's widest point
 * is exactly `RING_PX`. */
export const RING_CASE_PX = 2;

/** The dark rim outside that casing. A hairline, because it is doing the
 *  opposite job: the white casing is what holds the ink against dark geometry,
 *  and this is what holds the CASING against the light canvas — which needs a
 *  boundary and not a band. */
export const RING_RIM_PX = 1;

/** The ring's line at that widest point, and thinner everywhere else.
 *
 * The same weight as the arrows' shaft, for the same reason it is not the
 * grip's: three of these cross the part and a heavier line turns the crossings
 * into blots.
 *
 * IT IS NOW THE WIDTH THE WHOLE RING HAS, at every point of the curve and under
 * every camera, which is a change from the flat widget and is worth stating
 * because the old text's conclusion no longer follows from anything. Drawn flat
 * the ring was an ellipse stroked by a CSS border under the projection's own
 * 2x2, so the line really did thin where the ring turned away. A round tube
 * does not: the solid is the circle grown by a ball of the tube's radius, an
 * orthographic projection carries a sum like that to the sum of the
 * projections, and the projected ball is a disc of the same radius whatever the
 * camera does — so what lands on the canvas is the projected ellipse grown by
 * that disc, 2 px wide all the way round. `RING_PX` still names the widest
 * point exactly, because the ink's tube is centred half a shaft inside it.
 */
export const RING_SHAFT_PX = 2;

/** How flat a ring may be seen before it is TAKEN OFF THE SCREEN rather than
 *  floored — the minor semi-axis of its projected ellipse, in pixels.
 *
 * SET BY THE DISC NOW, and the number moved with the reason. The old floor was
 * the hit tolerance: under it, every pixel inside the ellipse was within
 * `RING_HIT_PX` of the curve, so a flattened ring stopped being a hoop and
 * became a filled sliver stealing presses from the two rings behind it. That
 * argument is gone with the curve test — the press is taken by a disc, which
 * lands in one place and steals nothing — and what is left is the handle
 * itself: the disc is squashed exactly as its ring is (`rings.js`), so at this
 * floor it is `RING_DISC_PX * RING_MIN_PX / RING_PX` across at its narrowest,
 * which is four pixels of target lying along a line.
 *
 * SO THE RING STILL GOES, for `GIZMO_MIN_SCALE`'s reason rather than for the
 * old one: a control the reader can see and cannot aim at is worse than no
 * control, and the remedy is the same — turn the model a little and the ring
 * comes back. The angle the drag is measured in has no such floor any more —
 * it is where the pointer's ray meets the ring's own plane, and only a ray
 * lying exactly IN that plane has no answer — so the handle is the whole of
 * what sets this number.
 *
 * 21 IS `RING_PX * GIZMO_MIN_SCALE`, which is arithmetic rather than sharing:
 * a ring's major semi-axis is always `RING_PX` (`rings.js` says why), so a
 * floor in pixels and the arrows' floor as a FRACTION are the same statement
 * about how far a widget may be FORESHORTENED — to a fifth, which is 11.5
 * degrees of tilt either way. What that tilt is measured FROM is not the same
 * for the two, and the sentence is wrong if it is left to look as though it
 * were: an arrow collapses as its axis approaches the axis of view, while a
 * ring is at its widest exactly then and collapses as its axis approaches the
 * PLANE OF THE SCREEN. They stay separate constants because they are floors on
 * different widgets measured off different quantities.
 */
export const RING_MIN_PX = 21;

/** How long after the last press or wheel the viewport still counts as busy.
 *
 * A live swap re-renders the scene and re-seats the camera; doing that between a
 * mousedown and the mouseup is pulling the model out from under the pointer.
 */
export const IDLE_MS = 1200;
