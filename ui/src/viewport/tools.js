// What a press on the canvas means, which depends on which tool is IN FORCE —
// `vp.activeTool`, i.e. the tool the interface armed, or the cut for as long as
// the hold key is down.
//
// One capture-phase listener decides, and the rule it applies is the one the
// page viewer this interface replaced arrived at for its section tool: A TOOL
// THAT OWNS THE PRESS TAKES IT AWAY FROM THE TRACKBALL, in the capture phase,
// before the canvas's own handler runs — otherwise the model rotates under the
// gesture. With no tool
// armed nothing is taken: the press is watched, so a release that never moved
// can be reported as a pick, and the rotation stays entirely the library's.
//
// `wheel` is deliberately left alone in every mode, so zoom keeps working while
// a tool is up.
//
// THE RIGHT BUTTON IS A SECOND GESTURE ON THE SAME LISTENER, and it is the one
// exception to the paragraph above: it opens the interface's part menu, and it
// takes NOTHING from the library, because the library pans on that button
// (wheel.js). Both readings of the press stay live until the release, where
// travel decides — under CLICK_PX it was a click and the menu opens, at or over
// it the reader was panning and this side says nothing.

import {
  EVENT_FACE, EVENT_MEASURE, EVENT_MENU, EVENT_PICK, EVENT_PLACE, emit,
} from "./events.js";
import { canvasXY, ndcAt } from "./camera.js";
import { travelled, watchDrag } from "./drag.js";
import { internals } from "./internals.js";
import { measureDistance, measureEntity } from "./measure.js";
import { capOwnerAt, faceNormalAt, pickEntity } from "./picking.js";
import {
  dragSection, keepSectionCut, placeSectionPlane, sectionAxis,
  sectionOffset, sectionRange,
} from "./section.js";
import { tidy } from "../proposal.js";

/**
 * A rounding step for a dragged part: a 1-2-5 decade near a two-hundredth of the
 * grid, so a 90 mm assembly snaps to half a millimetre and a 2 mm one does not
 * become undraggable.
 *
 * Snapped at all because a move is a SENTENCE — "about three millimetres that
 * way" — and 2.8371 mm says a precision the gesture does not have. The number
 * travels to an agent, so it should read like an instruction.
 *
 * EXPORTED BECAUSE THE GESTURES THAT MOVE A PART LIVE IN ANOTHER FILE — the
 * axis arrows and the plane quads (gizmo.js) — and a second copy of this rule
 * would be two vocabularies for one document: the same hand, on the same part,
 * would round differently depending on which piece it reached for.
 */
export function niceStep(viewer) {
  const grid = viewer && viewer.gridSize;
  const raw = Number.isFinite(grid) && grid > 0 ? grid / 200 : 0.5;
  const decade = 10 ** Math.floor(Math.log10(raw));
  const mult = raw / decade;
  return (mult >= 5 ? 5 : mult >= 2 ? 2 : 1) * decade;
}

/** The snapped value, and the SAME NUMBER the document will carry.
 *
 * `Math.round(v / step) * step` is exact arithmetic on paper and binary
 * arithmetic here: six steps of 0.1 come out as `0.6000000000000001`, and that
 * number goes three places at once — into `vp.moved`, out on the event, and from
 * there into the proposal document. `reconcileMoves` then compares the offset
 * the document asks for against the one the map already holds, element by
 * element, and a document rounded anywhere but here disagrees with the map about
 * a part nobody has touched: every push re-applies a move that is already
 * standing. Rounding at the source is what makes the three one number by
 * construction instead of three that have to be kept in step.
 *
 * `tidy` IS THE DOCUMENT'S OWN RULE and is imported rather than copied, because
 * copying it is exactly the disagreement above written a second time. The
 * viewport reaching into `ui/src/` for it is not new ground — `options.js` takes
 * `readTheme` from `../store.js` — and `proposal.js` reaches only
 * `viewport/math.js`, which imports nothing at all, so nothing of the interface
 * comes with it. It used to import nothing whatever, and this sentence said so;
 * composing a turn gave it that one dependency, and the shape of it is the
 * whole point — `math.js` is a leaf, `parts.js` re-exports the same helpers and
 * reaches the viewer, and taking them from there made `proposal.js` throw
 * `location is not defined` outside a browser. `tests/test_ui_source.py` pins
 * the leaf so this paragraph cannot go stale again in silence.
 *
 * EXPORTED FOR THE REASON `niceStep` IS, and the disagreement it describes is
 * exactly what a second copy of this line would produce.
 */
export const snap = (v, step) => tidy(Math.round(v / step) * step);

/** Where the section plane ended up, announced once.
 *
 * The drag moved the library's slider, whose zero is the grid centre. What the
 * interface's own control shows is the depth from the FACE, so it is read back
 * and announced at the end of the gesture — and this is the only place that
 * writes `state.cutOffset`, so the number on screen and the number the next
 * `applySection` walks the plane by cannot come apart.
 *
 * Read against the scene THAT IS STILL ON SCREEN, which is what makes it safe to
 * call from `endGesture` below: `show()` ends the gesture before it captures
 * anything and long before it clears the viewer.
 *
 * MODULE-LEVEL AND EXPORTED because there are two gestures that end a section
 * drag now — the press on the canvas below, and the press on the handle
 * (handle.js) — and the sentence above about one writer is the whole reason this
 * is a function at all. It closed over nothing when it lived inside
 * `installTools`, so lifting it costs the caller one argument and buys the
 * guarantee that the second gesture cannot grow its own copy.
 */
export function reportCut(vp) {
  if (!vp.sectionSeed) return;
  vp.state.cutOffset = sectionOffset(vp);
  emit(vp, EVENT_FACE, {
    id: vp.sectionSeed.id || null,
    name: vp.sectionSeed.name || null,
    // WHETHER THE PLANE STILL LIES ON THE FACE IT WAS PLACED FROM, which is the
    // one thing about a cut the two halves of the seed cannot say between them:
    // the id and the name go on naming that face after the grip's rings have
    // tipped the plane off it (handle.js), and the panel heads the cut with
    // exactly that name.
    turned: !!vp.sectionSeed.turned,
    point: vp.sectionSeed.point,
    normal: vp.sectionSeed.normal,
    offset: vp.state.cutOffset,
    range: sectionRange(vp.viewer),
  });
}

export function installTools(vp) {
  let press = null;

  /** Follow this press to wherever it is released — `watch.arm()` at the press
   *  and `watch.disarm()` in `finish`, on the window and in the capture phase
   *  for the reason `drag.js` writes out. */
  const watch = watchDrag({ onMove, onUp, onCancel });

  const finish = () => {
    press = null;
    watch.disarm();
  };

  /** The end of the one gesture this file can still be holding — a drag of the
   * section plane — for the two endings that say where it ended up: the release
   * (`onUp`) and the scene being swapped out from under a hand that has not
   * come off the model (`endGesture`).
   *
   * THE OTHER THREE ENDINGS SAY NOTHING, and that was already the cut's rule
   * before the move left this file: the platform taking the pointer away
   * (`onCancel`), a second press arriving with one still live (`onDown`) and
   * the teardown in `installTools` all call a bare `finish()`. A cut
   * interrupted that way is simply dropped — `reportCut` is not a bare
   * readback, since the interface answers `hmr:face` by DISARMING the armed
   * tool, so an interrupted plane drag would start turning the cut tool off,
   * which no reader asked for.
   *
   * WHAT AN UNREPORTED CUT COSTS, said out loud because it is a real cost: the
   * interface goes on printing a depth the plane has not been at — a wrong
   * NUMBER beside a plane that is standing correctly.
   *
   * IT IS CALLED AFTER `finish()`, never before. `reportCut` can reach back into
   * the element, and a report that ends up re-staging runs `endGesture` again:
   * with `press` already cleared there is nothing left to conclude twice.
   */
  const conclude = (p) => {
    if (p && p.moved && p.tool === "cut") reportCut(vp);
  };

  // Published so the element can end a gesture the reader has not let go of,
  // which is what a scene being replaced under one is. What a live press
  // holds — the plane's screen axis — was measured against the scene that is
  // going away, so continuing it would move the NEW model's plane by numbers
  // about the old one.
  //
  // IT CONCLUDES THE GESTURE RATHER THAN ABANDONING IT, and the difference is
  // one readback. A swap can arrive mid-drag — the interface waits for the hand
  // to come off the model but gives up after a deadline (BUSY_WAIT_MS), which is
  // there so a `pointerup` this page never sees cannot strand the reader's own
  // Switch. The release that would have run `reportCut` then never comes, and
  // `state.cutOffset` keeps the depth from BEFORE the drag: the plane still
  // lands correctly, because `restoreSection` subtracts that same stale offset
  // and the seed simply moves to absorb the difference — but the seed is no
  // longer on the face that was clicked and the interface goes on printing a
  // depth the plane has not been at since the drag started.
  const endGesture = () => {
    const p = press;
    finish();
    conclude(p);
  };
  vp.endGesture = endGesture;

  /** Turn a click on a face into an oriented, located cutting plane.
   *
   * Every way this can fail ends in the plane staying where it was, and none of
   * them says anything: a click that misses the model, or lands on an edge
   * instead of a face, simply cuts nothing, and the reader's next click is the
   * whole of the recovery.
   */
  const seedCut = (g, x, y) => {
    let found = null;
    try {
      found = faceNormalAt(g.picker, x, y);
    } catch (error) {
      console.warn("section pick", error);
    }
    if (!found) return;
    const point = [found.point.x, found.point.y, found.point.z];
    // The offset starts over: it is measured from the face just clicked, and
    // carrying the previous plane's depth would put this one somewhere nobody
    // pointed at.
    vp.state.cutOffset = 0;
    if (!placeSectionPlane(vp, g, found.normal, point)) return;
    keepSectionCut(vp, g);
    const owner = found.info ? (found.info.solidPath
      || String(found.info.path).replace(/\/(faces|edges|vertices)\/[^/]+$/, "")) : null;
    // Which part the plane was laid on, kept ON THE SEED so the end of a later
    // drag can name the same part without picking again — by then the cursor is
    // wherever the drag ended, which is usually not on that face any more.
    vp.sectionSeed.id = owner;
    vp.sectionSeed.name = owner ? owner.split("/").filter(Boolean).pop() : null;
    emit(vp, EVENT_FACE, {
      id: owner,
      name: vp.sectionSeed.name,
      point,
      normal: found.normal,
      offset: 0,
      range: sectionRange(vp.viewer),
    });
  };

  /** One click of the measure tool. */
  const measureAt = (g, x, y) => {
    const entity = pickEntity(g, x, y);
    if (!entity) {
      // A click on the background clears the tape rather than leaving half a
      // measurement standing: two clicks that are not both on the model are not
      // a measurement of anything.
      vp.measurePicks = [];
      vp.measureLabel = null;
      vp.overlay.refresh();
      return;
    }
    vp.measurePicks.push(entity);
    if (vp.measurePicks.length > 2) vp.measurePicks = [entity];
    const answer = vp.measurePicks.length === 2
      ? measureDistance(vp, vp.measurePicks[0], vp.measurePicks[1])
      : measureEntity(vp, entity);
    if (!answer) return;
    // Mid-point of the two ends, or the point itself, so the label sits on what
    // it is describing rather than in a corner.
    const pts = answer.points.filter(Boolean);
    vp.measureLabel = pts.length
      ? {
          text: `${answer.value.toFixed(2)}`,
          point: pts.length === 2
            ? [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2,
               (pts[0][2] + pts[1][2]) / 2]
            : pts[0],
        }
      : null;
    vp.overlay.refresh();
    emit(vp, EVENT_MEASURE, answer);
  };

  function onMove(event) {
    if (!press) return;
    if (!travelled(event, press)) return;
    press.moved = true;
    if (press.tool === "cut") {
      const g = internals(vp.viewer);
      if (!g || !vp.sectionSeed) return;
      // Once per gesture: the controls are held off for its whole duration, so
      // the camera cannot move underneath and the projection stays valid.
      if (press.axis === undefined) {
        press.axis = sectionAxis(vp.viewer, g, vp.sectionSeed.point);
      }
      // Edge-on to the view: the plane's screen projection has collapsed and a
      // drag here would fling it across the model. It stands still until the
      // model is turned.
      if (!press.axis) return;
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      press.x = event.clientX;
      press.y = event.clientY;
      dragSection(vp, g, press.axis, dx, dy);
    }
  }

  /**
   * What is under the cursor, with the CUT FACE asked about first.
   *
   * The stencil cap that closes a cut off carries no component id, so the picker
   * reads straight through it to the next surface along the same ray — the part
   * lying flush underneath, which at that pixel the reader cannot see at all
   * (issue #73; `picking.js` says why it cannot be fixed at the picker, and
   * carries the browser measurement: the cut face of `plate` answered
   * `reference_spacer`).
   *
   * AND ONLY WHILE A CUT STANDS — with none, `capOwnerAt` returns before it does
   * any work and this is the same line it always was.
   *
   * TWO CALLERS, WHICH IS WHY THIS IS A FUNCTION AND NOT A LINE WRITTEN TWICE.
   * The menu and the plain selection ask the same question about the same pixel
   * and must not answer it differently — a right click naming `plate` and a left
   * click naming the part hidden under it is what the reader reported. A second
   * hand-written copy is how the two would start disagreeing, which is the
   * argument `gestureRecord` in gesture.js makes for the same reason.
   *
   * THE OTHER THREE CALLERS OF `pickEntity` — measure, comment, move — are about
   * a point on a REAL SURFACE: a distance, a pin, a grab. A cap is a quad the
   * library synthesised and has no surface to measure, pin or drag, so they ask
   * the picker directly and get the solid the ray truly reaches. A selection is
   * an identity and nothing more (`onPick` reads `id` and `name`), and a menu is
   * about a part rather than a place, so the cap answers both as completely as
   * the picker would.
   */
  function entityAt(g, event, x, y) {
    const ndc = ndcAt(g.canvas, event);
    return (ndc && capOwnerAt(vp, g, ndc)) || pickEntity(g, x, y);
  }

  function onUp(event) {
    const p = press;
    finish();
    if (!p) return;
    const g = internals(vp.viewer);
    if (!g) return;
    if (p.moved) {
      conclude(p);
      return;
    }
    // A press that never moved is a click, and it costs the trackball nothing:
    // a rotation of zero pixels is no rotation at all.
    const at = canvasXY(g.canvas, event);
    if (!at) return;
    const [x, y] = at;
    if (p.menu) {
      // `entityAt` and not `pickEntity`: it is the same resolver the plain pick
      // below takes, so the identifier is of the same kind, the interface looks
      // it up in the same tree, and on a CUT FACE the two name one part. The
      // whole of why the cut face is asked about first is written on `entityAt`.
      //
      // AND IT DOES NOT EMIT A PICK. The menu is about the part under the
      // cursor; the selection is about the part the reader chose. A tree row's
      // menu leaves the selection where it was, and one menu with two behaviours
      // is worse than either.
      const entity = entityAt(g, event, x, y);
      emit(vp, EVENT_MENU, {
        id: entity ? entity.id : null,
        name: entity ? entity.name : null,
        // The CURSOR, which is where a context menu opens. Client coordinates
        // rather than canvas ones: the menu is `position: fixed` on the page,
        // not inside the viewport.
        x: event.clientX,
        y: event.clientY,
      });
      return;
    }
    if (p.tool === "cut") {
      seedCut(g, x, y);
      return;
    }
    if (p.tool === "measure") {
      measureAt(g, x, y);
      return;
    }
    if (p.tool === "comment") {
      const entity = pickEntity(g, x, y);
      if (!entity) return;
      emit(vp, EVENT_PLACE, {
        id: entity.id, name: entity.name, p: entity.point,
      });
      return;
    }
    // No tool: a plain selection, and the background is an answer too — it is
    // how a reader deselects.
    //
    // `entityAt` AND NOT `pickEntity`, the same resolver the menu takes, which
    // is what makes a right click and a left click on one pixel name one part.
    // Left to the picker, a left click on the cut face of the part the reader is
    // looking INTO selected the surface the cap hides — the part flush
    // underneath, invisible at that pixel. That function carries the rest.
    const entity = entityAt(g, event, x, y);
    emit(vp, EVENT_PICK, entity
      ? { id: entity.id, name: entity.name, point: entity.point }
      : { id: null, name: null, point: null });
  }

  /** The pointer was taken away — the platform scrolling, a gesture the browser
   *  decided was its own. No `pointerup` follows one of these.
   *
   * NOTHING IS REPORTED, which is deliberately not "concluded like the
   * release": a cut interrupted here is dropped, exactly as it was before there
   * was anything else this listener could be holding. `conclude` carries the
   * reason and the cost.
   */
  function onCancel() {
    finish();
  }

  const onDown = (event) => {
    // A PRESS ARRIVING WITH ONE STILL LIVE, which is either a gesture whose
    // release this page never saw or a second button — or finger — coming down
    // mid-drag. Either way the old one ends HERE and says nothing, which is the
    // cut's rule for every ending but the release (`conclude`).
    finish();
    // Two buttons mean something here and the rest mean nothing: the left is
    // every tool and the plain pick, the right is the part menu.
    if (event.button !== 0 && event.button !== 2) return;
    const viewer = vp.viewer;
    if (!viewer) return;
    const g = internals(viewer);
    if (!g || event.target !== g.canvas) return;
    if (event.button === 2) {
      // THE PRESS IS ONLY WATCHED, never taken. The library PANS on the right
      // button (wheel.js), so this gesture shares it: the press goes on to the
      // controls exactly as before, and what decides between the two at the END
      // is travel — under CLICK_PX it was a click and the menu opens, at or over
      // it the reader was panning and nothing happens. That is the same
      // threshold, and the same reasoning, `onMove` already applies to the left
      // button's clicks.
      //
      // `tool` is null rather than a name of its own: none of the tool branches
      // is meant to fire for this press, and a sentinel in that field would be a
      // second vocabulary in a variable that holds the interface's tools.
      press = {
        tool: null, menu: true,
        x: event.clientX, y: event.clientY,
        startX: event.clientX, startY: event.clientY,
        moved: false, axis: undefined,
      };
      watch.arm();
      return;
    }
    // `activeTool`, NOT `state.tool`: the hold key puts the cut up without
    // writing to `state` (the interface owns that field), so reading `state`
    // here would light the interface's "cut is on" indicator while a press went
    // on doing a plain pick — a mode that says it is armed and is not.
    //
    // Read ONCE, and the value lives on `press` for the rest of the gesture.
    // Letting go of the key mid-drag must not turn a cut that is already under
    // way into something else half-way through.
    const tool = vp.activeTool;
    press = {
      tool,
      x: event.clientX, y: event.clientY,
      startX: event.clientX, startY: event.clientY,
      moved: false, axis: undefined,
    };
    watch.arm();
    if (!tool) return;
    // THE MOVE TOOL TAKES NO PRESS ON THIS ELEMENT AT ALL, which is what makes
    // it the one armed tool the trackball still shares the canvas with. A part
    // is moved by the manipulator standing on it and by nothing else — an axis
    // arrow or a plane quad (gizmo.js), a rotation disc (rings.js) — and each
    // of those takes its own press in a capture-phase listener on the WINDOW,
    // which runs before this one and stops what it wants there. So a press that
    // reaches this line under `move` is one that missed every piece of the
    // widget, and it means exactly what it means with no tool armed: a click
    // selects and a drag orbits.
    //
    // THE FREE DRAG IS WHAT THIS REPLACES. A press on the part itself used to
    // slide it in the plane of the screen, which under an ortho camera puts a
    // delta on all three axes at once with nothing in the hand to say which of
    // them the reader meant — and it cost them the orbit, the one gesture the
    // viewport can least afford to take away, for as long as the tool was up.
    //
    // THE TOOL STAYS ON `press` rather than being cleared to null: this press
    // falls past every branch of `onUp` and reaches the plain pick at the foot
    // of it, exactly as a tool this file has never heard of does.
    if (tool === "move") return;
    // Take the press away from the trackball. A capture-phase listener on the
    // CONTAINER runs before the canvas's own pointerdown handler, so stopping it
    // here means the controls never begin a rotation. preventDefault also
    // suppresses the compatibility mouse events, which keeps this press from
    // turning into a double-click somewhere else.
    event.preventDefault();
    event.stopPropagation();
  };

  /** The browser's own menu, kept off the canvas.
   *
   * The right button is this page's menu gesture now, and the native one would
   * come up on top of it — on some platforms before the release that opens ours
   * has even happened, since `contextmenu` fires on the press rather than the
   * release outside Windows. Preventing it is also what keeps the release
   * arriving at all where the native menu would otherwise have taken the pointer.
   */
  const onContextMenu = (event) => event.preventDefault();

  vp.box.addEventListener("pointerdown", onDown, true);
  vp.box.addEventListener("contextmenu", onContextMenu);

  // The teardown, and it has to take the WINDOW listeners with it: a viewport
  // unmounted mid-drag (React re-render, a route change) would otherwise leave
  // three capture-phase listeners on the window holding a reference to a scene
  // that is gone.
  return () => {
    vp.box.removeEventListener("pointerdown", onDown, true);
    vp.box.removeEventListener("contextmenu", onContextMenu);
    // `finish` and NOT `endGesture`. This is the viewport going away, and what
    // a gesture can be holding goes with it: for a cut there is no scene left
    // to read the plane off, and a gesture cannot outlive the element it was
    // made on. Nothing on screen is left disagreeing with anything. Only the
    // listeners have to go.
    finish();
    if (vp.endGesture === endGesture) vp.endGesture = null;
  };
}
