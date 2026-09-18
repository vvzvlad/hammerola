// The move tool's axis arrows: three of them, out of the selected part along
// world +X, +Y and +Z, each dragged to slide the part along THAT AXIS ONLY.
//
// WHY IT EXISTS. The Move tool has always dragged a part freely in the plane of
// the screen (`dragPart` in tools.js), which is the right gesture for "put it
// about there" and the wrong one for every sentence that names a direction —
// "three millimetres further out", "up off the plate". Under an ortho camera a
// free drag can produce a delta on all three axes at once, and nothing in the
// hand can say which of them the reader meant. Blender's answer is this widget,
// and it is the one readers arrive already knowing.
//
// A FOURTH DOM OVERLAY LAYER, built exactly like handle.js and for the reasons
// written out at length there: `viewer.clear()` deep-disposes everything in the
// scene, so a gizmo living in it would have to be rebuilt on a render path that
// has enough to get right already; and the browser hit-tests these three boxes
// and picks a cursor for nothing, where the picker would have to be taught to.
//
// DRAWN OUT OF DIVS rather than out of an SVG, which handle.js also explains and
// is worth repeating because it looks like taste and is not: `tests/test_ui_source
// .py` waves the SVG namespace through as an identifier that merely looks like a
// URL and then pins that exemption to the single `const SVG_NS` in viewcube.js. A
// shaft and a CSS border triangle need no namespace.
//
// EVERY NUMBER A DRAG PRODUCES COMES FROM tools.js. The constrained delta is the
// free drag's own world displacement projected onto one axis, and from there it
// is the same `niceStep`, the same `snap`, the same `movePart`/`nudgePart`, the
// same `stood`/`last` distinction and the same `reportMove` — so a part dragged
// by an arrow and a part dragged by hand reach the proposal document as the same
// kind of sentence. A second copy of any of that would not fail; it would drift,
// which is worse.

import { internals } from "./internals.js";
import { cameraBasis, ndcAt, ndcOffset, projectPoint } from "./camera.js";
import { clamp, dot3 } from "./math.js";
import { movableGroup, movePart, nudgePart, partCentre } from "./parts.js";
import { moveRecord, niceStep, reportMove, snap } from "./tools.js";
import {
  CLICK_PX,
  GIZMO_HEAD_PX, GIZMO_HIT_PX, GIZMO_MIN_SCALE, GIZMO_PX, GIZMO_SHAFT_PX,
} from "./options.js";

/** The three axes, in the order they are drawn and in the colours everything
 *  that draws an axis triad uses.
 *
 * RED, GREEN, BLUE FOR X, Y, Z is not a palette choice — it is the convention
 * every CAD and DCC tool the reader has already used spells its axes in, so it
 * is the one thing about this widget nobody has to be told.
 *
 * THE INK BRINGS ITS OWN CONTRAST, exactly as `INK`/`HALO` do in handle.js and
 * for the same reason: the canvas under the arrows is white or near-black
 * depending on the reader's answer (`readTheme` in ui/src/store.js), so a single
 * colour has to read on both. These three are dark enough to hold against the
 * light canvas and are carried on the dark one by the same white halo the grip
 * uses — one filter over the whole arrow, so it follows the head as well as the
 * shaft.
 */
const AXES = [
  { world: [1, 0, 0], ink: "#c93a31" },
  { world: [0, 1, 0], ink: "#2e8b40" },
  { world: [0, 0, 1], ink: "#2d66c7" },
];

const HALO = "drop-shadow(0 0 1px #fff) drop-shadow(0 1px 2px rgba(20,24,28,.45))";

/**
 * Where a unit world axis points ON THE SCREEN at `at`, and how much of it the
 * projection leaves: `{sx, sy, sine}` with `sy` counted DOWNWARDS. Null for a
 * scene that cannot be measured at all.
 *
 * `sectionGripAxis` + `foreshorten` in section.js, asked about an axis of the
 * world instead of about a clip normal, and the two halves are measured the same
 * way they are there.
 *
 * THE DIRECTION COMES FROM A PROJECTED STEP and the LENGTH does not, which is
 * the one thing worth being exact about. `sine` is the angle between the axis
 * and the camera's own projection axis — `sqrt(1 - cos^2)` off `cameraBasis().
 * view` — and that is a property of the pose alone: under an ortho camera every
 * point projects along one fixed direction, so an axis is foreshortened by the
 * same amount wherever on screen the part happens to sit. Measured off the
 * projected step instead, the arrow's length would be telling the reader about
 * the zoom.
 *
 * A STEP OF ONE WORLD UNIT, and no shorter, because there is nothing here to
 * linearise: this viewport's camera is orthographic by construction (options.js)
 * so the projection is affine and the DIRECTION of a projected step is exact at
 * any length. `sectionAxis` takes a short step because it reads the step's
 * MAGNITUDE as a px-per-world-unit scale, which this does not.
 *
 * THE BASIS AND THE RECT ARE HANDED IN, and that is not tidiness either. This is
 * asked three times per frame, sixty frames a second, for as long as the Move
 * tool is armed; measured inside, each call would re-walk the camera
 * (`cameraBasis` updates matrices) and read `getBoundingClientRect` — a layout
 * read interleaved with the style writes `place` makes for the previous arrow,
 * which is the shape that forces a synchronous reflow three times a frame. Both
 * are properties of the camera and the canvas rather than of the axis, so the
 * caller reads them once.
 */
function axisOnScreen(g, basis, rect, at, n) {
  // Both are unit vectors, so the dot IS the cosine. `clamp` because it can land
  // a hair outside [-1, 1] in floating point, where the root would go NaN.
  const cos = clamp(dot3(n, basis.view), -1, 1);
  // `basis.eye` AND NOT A SECOND `getPosition()`, which is the same argument as
  // the basis itself: it is that call's own answer, already checked, and asking
  // the camera again three times a frame buys nothing. It is only ever used as a
  // vector to clone, so nothing here can reach the camera through it.
  const a = basis.eye.clone().set(at[0], at[1], at[2]).project(g.cam);
  const b = basis.eye.clone().set(at[0] + n[0], at[1] + n[1], at[2] + n[2])
    .project(g.cam);
  // BOTH COORDINATES OF BOTH ENDS, which `projectPoint` in camera.js also
  // insists on: a non-finite `y` alone leaves `sy` NaN, `rotate(NaNdeg)` is not
  // CSS the browser will take, and the arrow is then drawn UNROTATED — pointing
  // along screen x while claiming to be an axis of the world.
  if (!a || !b
      || !Number.isFinite(a.x) || !Number.isFinite(b.x)
      || !Number.isFinite(a.y) || !Number.isFinite(b.y)) return null;
  return {
    sx: ((b.x - a.x) * rect.width) / 2,
    sy: (-(b.y - a.y) * rect.height) / 2,  // NDC y is up, pixels are down
    sine: Math.sqrt(1 - cos * cos),
  };
}

export function createGizmo(vp) {
  const root = document.createElement("div");
  // `pointer-events: none` on the layer and back on for each arrow, exactly as
  // the overlay, the view cube and the section grip do it: the layer covers the
  // whole canvas, so without this it would swallow every press meant for the
  // model — rotation included.
  //
  // NO CLASS NAME, for the view cube's reason: a class is a promise the
  // interface's stylesheet keeps a rule for it (tests/test_ui_source.py checks
  // exactly that), and everything about how this looks is a legibility
  // requirement over two canvases rather than a palette the designer owns.
  root.style.cssText =
    "position:absolute;inset:0;overflow:hidden;pointer-events:none";

  /** One arrow: the box that takes the press, and the ink inside it. */
  const build = ({ world, ink: colour }) => {
    // THE BOX IS THE TARGET AND WHAT IS DRAWN IN IT IS THINNER, the same split
    // handle.js makes in the one dimension it still holds for: the arrow takes
    // presses over all `GIZMO_HIT_PX` of its height while the shaft is
    // `GIZMO_SHAFT_PX`. ALONG its length the two agree, and `place` says why —
    // three arrows meeting at a point cannot afford targets longer than their
    // ink. So the box's WIDTH is the drawing, set per frame from how much of the
    // axis the projection leaves.
    //
    // `transform-origin` AT THE LEFT EDGE, which is the one real difference from
    // the grip's geometry. The grip is CENTRED on its anchor because a plane
    // slides both ways from there; an axis arrow STANDS ON the part and points
    // away along its axis, so the tail is the fixed point the rotation turns
    // about — and since a narrowing box keeps its left edge, foreshortening
    // pulls the tip back towards the part instead of sliding the arrow off it.
    const arrow = document.createElement("div");
    arrow.style.cssText = "position:absolute;left:0;top:0;display:none;"
      + `width:${GIZMO_PX}px;height:${GIZMO_HIT_PX}px;transform-origin:0 50%;`
      + `pointer-events:auto;cursor:grab;filter:${HALO}`;
    root.appendChild(arrow);

    const piece = (css) => {
      const el = document.createElement("div");
      el.style.cssText = `position:absolute;${css}`;
      arrow.appendChild(el);
    };

    // The shaft, from the tail up to the head.
    piece(`left:0;right:${GIZMO_HEAD_PX}px;top:50%;`
      + `height:${GIZMO_SHAFT_PX}px;margin-top:${-GIZMO_SHAFT_PX / 2}px;`
      + `background:${colour}`);
    // The head, as a CSS border triangle: a box of zero size whose one remaining
    // border is a wedge. THE BORDER AND THE EDGE ARE OPPOSITE SIDES — the border
    // left standing is the one AWAY from the point — so a wedge made of
    // `border-left` points RIGHT and belongs at the right edge, which is where
    // the arrow's tip is.
    piece(`right:0;top:50%;margin-top:${-GIZMO_HEAD_PX / 2}px;width:0;height:0;`
      + `border-top:${GIZMO_HEAD_PX / 2}px solid transparent;`
      + `border-bottom:${GIZMO_HEAD_PX / 2}px solid transparent;`
      + `border-left:${GIZMO_HEAD_PX}px solid ${colour}`);

    const arm = { world, arrow };
    arrow.addEventListener("pointerdown", (event) => onDown(event, arm));
    return arm;
  };

  const arms = AXES.map(build);

  let frame = 0;
  // The gesture in progress: the world axis it is constrained to, how much of
  // that axis the camera leaves (`sine`, measured once at the press), where the
  // press landed, the move record it is applying, and whether the pointer has
  // travelled far enough to be a drag at all. Null between gestures.
  let drag = null;

  /**
   * The selection these arrows stand for, or null when there is nothing to put
   * them on.
   *
   * THE SAME QUESTION `onDown` IN tools.js ASKS OF A GRAB, and it has to be:
   * arrows offering a move that the press would then refuse are a promise the
   * widget cannot keep. So the Move tool has to be in force, something has to be
   * selected, and every selected path has to be one the scene can actually move
   * — with the extra clause a drag of the reader's own drawing carries, that a
   * proposal body is grabbable only when the panel can name it (`overlayBody`).
   *
   * `activeTool` AND NOT `state.tool`, for the reason tools.js gives: the hold
   * key puts the cut up without writing to `state`, and arrows left standing
   * under a cut gesture would be offering a move the press is no longer for.
   *
   * READ EVERY FRAME rather than remembered, which is what lets the loop below
   * stop by itself when the reader disarms the tool or clears the selection.
   */
  const held = () => {
    if (vp.activeTool !== "move") return null;
    const paths = Array.isArray(vp.state.selected) ? vp.state.selected : [];
    if (!paths.length) return null;
    const proposal = paths.some((path) => vp.isOverlay(path));
    const grabbable = (path) => !!movableGroup(vp.viewer, path)
      && (!proposal || !!vp.overlayBody(path));
    return paths.every(grabbable) ? { paths, proposal } : null;
  };

  const wanted = () => !!held();

  const hide = () => {
    for (const arm of arms) arm.arrow.style.display = "none";
  };

  /** Put the three arrows on the part, or take them off the screen. */
  const place = () => {
    const sel = held();
    if (!sel) {
      hide();
      return;
    }
    const g = internals(vp.viewer);
    if (!g) {
      hide();
      return;
    }
    // READ OFF THE SCENE EVERY FRAME AND NOT OUT OF THE MOVE RECORD, which is
    // the whole of whether this is a widget the reader is holding or a picture
    // beside one. The record's `base` is where the drag STARTED; the part is
    // somewhere else for the length of the gesture, and arrows anchored on the
    // record would stand still while the part slid out from under them and then
    // jump to catch up at the release. `handle.js`'s `anchor()` argues exactly
    // this about the plane.
    //
    // THE FIRST SELECTED PATH, which is the same anchor the press takes below:
    // a row standing for five copies of a part moves as one thing, and the
    // arrows have to stand on one of them rather than between them.
    const at = partCentre(vp.viewer, sel.paths[0]);
    if (!at) {
      hide();
      return;
    }
    // ONCE FOR THE THREE, this and the camera basis below — see `axisOnScreen`,
    // which used to take each for itself and so read the layout between the
    // style writes of one arrow and the next.
    const rect = g.canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) {
      hide();
      return;
    }
    // BEFORE THE PROJECTION, which is the order handle.js takes and the
    // reason is inside `cameraBasis`: it calls `updateMatrixWorld`. Projected
    // first, the anchor would be placed off whatever the matrices held from the
    // last render while the three directions were measured off the refreshed
    // ones — one frame drawn from two states of the same camera.
    const basis = cameraBasis(vp.viewer, g);
    if (!basis) {
      hide();
      return;
    }
    const ndc = projectPoint(g, at);
    // z > 1 is behind the camera's far plane, i.e. behind the reader — under an
    // ortho projection a real case rather than a curiosity, exactly as the
    // overlay's `place` says.
    if (!ndc || ndc[2] > 1) {
      hide();
      return;
    }
    const box = vp.box.getBoundingClientRect();
    const left = (ndc[0] * 0.5 + 0.5) * rect.width + (rect.left - box.left);
    const top = (-ndc[1] * 0.5 + 0.5) * rect.height + (rect.top - box.top);
    for (const arm of arms) {
      const axis = axisOnScreen(g, basis, rect, at, arm.world);
      // NEARLY END-ON IS GONE, not shortened — `GIZMO_MIN_SCALE` carries the
      // argument. A null is the scene refusing to be measured at all, and it
      // takes the arrow off for the same reason.
      if (!axis || axis.sine < GIZMO_MIN_SCALE) {
        arm.arrow.style.display = "none";
        continue;
      }
      arm.arrow.style.display = "";
      arm.arrow.style.left = `${left}px`;
      arm.arrow.style.top = `${top}px`;
      // THE BOX FORESHORTENS WITH THE INK, which is where this parts company
      // with handle.js and has to. There the box is held at full length so the
      // grip stays easy to hit exactly where it collapses — and nothing is
      // behind it to take the press from. Here there are THREE, they meet at the
      // part, and a box longer than what is drawn is an invisible tail lying
      // across its neighbours: with the camera near an axis, the stub of Z keeps
      // a 64 px target over the full-length X beside it, and since the three are
      // siblings with no `z-index` the last one built wins. The reader presses
      // the red arrow they can see and drags the blue one they cannot.
      //
      // WHICH IS WHY THE HEAD NO LONGER SQUEEZES. Scaling the ink shrank the
      // whole group, head included; a narrower box shortens the SHAFT and leaves
      // the head its own size at the tip. That is also the widget every reader
      // has used — a gizmo's cap is a screen-space target and keeps its size —
      // and at the floor `GIZMO_MIN_SCALE` puts under this, about 13 px, a head
      // squeezed in proportion would be a smear with nothing to aim at.
      arm.arrow.style.width = `${GIZMO_PX * axis.sine}px`;
      // `sy` is counted DOWNWARDS, which is the direction CSS rotates in as
      // well, so the angle of that vector is the angle of the arrow with nothing
      // to flip. `translate(0,-50%)` lifts the box by half its height so the
      // tail — the middle of the left edge, which is the transform's origin —
      // sits exactly on the part's centre.
      arm.arrow.style.transform = "translate(0,-50%) "
        + `rotate(${(Math.atan2(axis.sy, axis.sx) * 180) / Math.PI}deg)`;
    }
  };

  const draw = () => {
    frame = 0;
    place();
    schedule();
  };

  /**
   * One rAF loop, and only while there is a selection to put arrows on.
   *
   * The library owns the render loop and offers no post-render hook, so the
   * alternative would be re-projecting from the trackball's `change` event —
   * which fires on camera moves and NOT on the frames a live swap, a visibility
   * change or a drag of this very widget redraws. A loop that stops on its own
   * costs nothing on the ordinary page, which has no Move tool armed.
   *
   * THE INVARIANT THAT MAKES `refresh` ENOUGH is handle.js's: while an arrow is
   * on screen a frame is always pending, because the only thing that shows one is
   * `place`, which runs from `draw`, which re-arms. So a selection going away
   * needs no synchronous hide here — the queued frame runs `place`, `held` is
   * null by then, and the same call takes the arrows off and lets the loop stop.
   */
  const schedule = () => {
    if (frame) return;
    if (!wanted()) return;
    frame = requestAnimationFrame(draw);
  };

  /** Let go of the gesture, wherever it ended.
   *
   * The listeners are on the WINDOW and in the capture phase for the reason
   * tools.js's `watch` gives: a drag that starts on an arrow can perfectly well
   * end anywhere, and a release missed here strands the gesture forever.
   */
  const finish = () => {
    if (drag) drag.arm.arrow.style.cursor = "grab";
    drag = null;
    removeEventListener("pointermove", onMove, true);
    removeEventListener("pointerup", onUp, true);
    removeEventListener("pointercancel", onCancel, true);
  };

  /** End the gesture and say where the part ended up.
   *
   * ONE FUNCTION FOR EVERY ENDING THERE IS HERE — the release, a pointer the
   * platform took away, a second press arriving with one live, and the scene
   * being swapped out from under a hand that has not come off. tools.js splits
   * those (`conclude` vs `concludeMove`) only because a section drag ends
   * differently from a move; there is no cut in this widget, so they collapse
   * into one, and `concludeMove`'s docblock is the argument for why a move is
   * reported from all four: the part is already standing where the reader
   * dragged it, and only the document can be wrong about that.
   *
   * ONLY IF THE GESTURE REALLY WAS A DRAG, which is the canvas gesture's rule
   * (`if (p.moved)`) with the canvas gesture's meaning of `moved`: `CLICK_PX` of
   * travel, not one pixel of it (`onMove` above). A bare press on an arrow is
   * not a placement, and `reportMove` would answer it by writing a node.
   */
  const stop = () => {
    const live = drag;
    finish();
    if (live && live.moved) reportMove(vp, live.move);
  };

  function onMove(event) {
    if (!drag) return;
    // A CLICK IS NOT A ONE-PIXEL DRAG, and the canvas gesture spells the same
    // rule out (`onMove` in tools.js): until the pointer has travelled
    // `CLICK_PX` this press is still a click, and a hand that shifts two pixels
    // between the press and the release has said nothing. It matters more here
    // than there, because there IS no click on an arrow — nothing selects, and
    // the only thing a twitch can do is snap the part one step and file a move
    // node the reader never asked for, which opens the panel on top of it.
    if (!drag.moved
        && Math.abs(event.clientX - drag.startX) < CLICK_PX
        && Math.abs(event.clientY - drag.startY) < CLICK_PX) return;
    drag.moved = true;
    const viewer = vp.viewer;
    const g = internals(viewer);
    if (!g) return;
    const ndc = ndcAt(g.canvas, event);
    if (!ndc) return;
    const b = cameraBasis(viewer, g);
    if (!b) return;
    const d = drag.move;
    // THE FREE DRAG'S OWN DISPLACEMENT, PROJECTED — which is the whole of what
    // "along one axis" means here, and it is computed out of the same two
    // `ndcOffset` readings `dragPart` takes: the world vector a screen
    // displacement spans is the difference of the two ends' offsets, and under
    // ortho that is depth-free. Taking the dot with the axis and walking the
    // axis by it keeps everything the unconstrained gesture already gets right —
    // the px-per-world-unit scale, the zoom, the pan — and adds exactly one
    // thing: the two components the reader did not ask for are dropped.
    //
    // WHICH IS ALSO WHY AN AXIS SEEN END-ON IS NOT DRAWN. The `sine^2` below
    // divides, so the nearer the axis comes to pointing at the reader the more
    // world the same pixel of hand buys — at the floor `GIZMO_MIN_SCALE` puts
    // under it, twenty-five times — and past that a steady hand is a jump of
    // several snap steps (`GIZMO_MIN_SCALE` in options.js carries this).
    const from = ndcOffset(g, b.eye, b.view, d.ndc[0], d.ndc[1]);
    const to = ndcOffset(g, b.eye, b.view, ndc[0], ndc[1]);
    if (!from || !to) return;
    const along = dot3([to[0] - from[0], to[1] - from[1], to[2] - from[2]],
                       drag.axis) / (drag.sine * drag.sine);
    // THE SAME STEP AND THE SAME SNAP the free drag rounds to, so a move made
    // with an arrow reads like a move made by hand and lands on the same
    // numbers in `vp.moved`, on the event and in the proposal document.
    //
    // AND ONLY ON THE AXIS THE HAND IS ON. The other two components are handed
    // through untouched rather than passed through `snap` with nothing added to
    // them, because an offset already standing need not be on this grid at all:
    // it arrives from the proposal document, whose `delta.<axis>` fields are
    // typed by hand. Rounded here, a drag along X would quietly move the part
    // along Y as well — a number the reader wrote as 12.3 coming back as 12.5,
    // reported as part of a gesture that never touched it.
    const step = niceStep(viewer);
    const delta = d.base.map((v, i) => (drag.axis[i]
      ? snap(v + drag.axis[i] * along, step)
      : v));
    if (delta[0] === d.last[0] && delta[1] === d.last[1]
        && delta[2] === d.last[2]) return;
    d.last = delta;
    // THE TWO MEANINGS, AND THE SAME TWO CALLS `dragPart` MAKES. A body of the
    // proposal is moved for the eye alone and NOTHING IS RECORDED for it — a
    // delta in `vp.moved` would be re-applied on top of the position the
    // document will carry after the re-stage, and the body would walk away by
    // twice the distance. A part of the build leaves `vp.moved` behind, which is
    // the offset the scene is really holding; `stood` is the last delta that
    // LANDED, a second field because `movePart` can refuse and `last` has to
    // advance whatever happens or a failed step is retried on every event.
    if (d.body) {
      nudgePart(vp, d.paths, d.homes, delta);
      return;
    }
    if (movePart(vp, d.paths, delta, d.turn)) d.stood = delta;
  }

  function onUp() {
    stop();
  }

  function onCancel() {
    stop();
  }

  function onDown(event, arm) {
    // THE PRIMARY BUTTON AND NOTHING ELSE, and handle.js says what that buys:
    // a press on an arrow never reaches `vp.box` or the canvas in the first
    // place — this layer is a SIBLING of the box — so neither the part menu nor
    // the library's pan is reachable over these boxes whatever this line does.
    // What the filter buys is that a right-drag the reader meant as a pan, and a
    // middle click, no longer move the part.
    if (event.button !== 0) return;
    // A previous gesture is concluded before a new one begins, exactly as
    // `onDown` in tools.js does it and for the same two reasons: a second
    // pointer landing on an arrow would otherwise overwrite the press point with
    // its own, and the part it interrupted is standing somewhere no node claims.
    stop();
    // `stopPropagation` is belt and braces and nothing more, because this layer
    // is a sibling of `vp.box`: no listener on that element is on this event's
    // path at all. It stays for the day the layer moves inside the box.
    // `preventDefault` is the half that matters on its own: it suppresses the
    // compatibility mouse events, so this press cannot turn into a double-click
    // somewhere else.
    event.stopPropagation();
    event.preventDefault();
    const sel = held();
    if (!sel) return;
    const g = internals(vp.viewer);
    if (!g) return;
    const ndc = ndcAt(g.canvas, event);
    if (!ndc) return;
    // THE ANCHOR IS THE FIRST SELECTED PATH, the same one `place` stands the
    // arrows on. The canvas drag chooses the copy under the cursor instead,
    // because there IS one there and a part the reader is holding must not leap
    // out from under them; here the cursor is on a widget rather than on a part,
    // and the row converges onto whichever copy is named (`movePart`), so the
    // one the arrows are drawn from is the only answer that does not move the
    // thing the reader is aiming at.
    // MEASURED ONCE AND HELD FOR THE WHOLE GESTURE, exactly as `onDown` in
    // handle.js takes the plane's screen axis: the camera cannot move under a
    // press this widget owns, and re-measuring per event would let the part
    // drift away from the hand. THROUGH THE SAME FUNCTION `place` DRAWS FROM, so
    // the arrow on screen is the arrow that drags.
    const at = partCentre(vp.viewer, sel.paths[0]);
    if (!at) return;
    const basis = cameraBasis(vp.viewer, g);
    if (!basis) return;
    const axis = axisOnScreen(g, basis, g.canvas.getBoundingClientRect(),
                              at, arm.world);
    // Zero is an axis pointing straight at the reader, which `place` never draws
    // and the division below could not survive.
    if (!axis || !(axis.sine > 0)) return;
    drag = {
      arm,
      axis: arm.world,
      // HOW FAR ALONG THE AXIS ONE UNIT OF PROJECTED DISPLACEMENT GOES, and the
      // square is the whole of it. The world vector a screen displacement spans
      // lies IN the plane of the screen, so of the axis it only ever sees the
      // part that lies there too — length `sine`. Walk the part by `t` and its
      // projection moves by `t * sine`; dot that with the axis and another
      // factor of `sine` comes off, so a bare dot answers `t * sine^2`. Taken as
      // `t`, the part crawls behind the cursor by exactly that factor — two
      // thirds of the travel lost on an ordinary three-quarter view — and
      // direct manipulation has one thing it must get right.
      sine: axis.sine,
      startX: event.clientX,
      startY: event.clientY,
      move: moveRecord(vp, sel.paths, ndc, sel.paths[0], sel.proposal),
      moved: false,
    };
    arm.arrow.style.cursor = "grabbing";
    addEventListener("pointermove", onMove, true);
    addEventListener("pointerup", onUp, true);
    addEventListener("pointercancel", onCancel, true);
  }

  /** End a drag the reader has not let go of, because the scene is going away.
   *
   * THE TWIN OF `vp.endGesture` and of the section grip's `endDrag`, and it
   * exists for the same failure both were written for: the press landed on a
   * layer that is a SIBLING of `vp.box`, so neither that gesture nor the idle
   * clock that defers the swap ever saw it, and the release that would have
   * concluded it never comes. Concluding rather than abandoning is
   * `concludeMove`'s argument: the part stands displaced in `vp.moved` with
   * nothing in the document claiming it, and the next push sends it home under
   * the reader's hand.
   */
  const endDrag = () => {
    stop();
  };

  return {
    root,
    refresh: schedule,
    endDrag,
    destroy() {
      // `if (frame)` is safe because a browser rAF handle is non-zero by spec
      // (HTML §8.10), the same reading the view cube's teardown leans on.
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      // A viewport unmounted mid-drag would otherwise leave three capture-phase
      // listeners on the window holding a scene that is gone. `finish` and not
      // `stop`: this is the element going away, and `vp.moved` goes with it, so
      // the displacement there would be to report is one nothing is left
      // standing at — the same fifth ending tools.js's teardown takes.
      finish();
      root.remove();
    },
  };
}
