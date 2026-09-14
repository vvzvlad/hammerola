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
  EVENT_FACE, EVENT_MEASURE, EVENT_MENU, EVENT_MOVED, EVENT_PICK, EVENT_PLACE,
  emit,
} from "./events.js";
import { cameraBasis, canvasXY, ndcAt, ndcOffset } from "./camera.js";
import { gestureInternals, internals } from "./internals.js";
import { measureDistance, measureEntity } from "./measure.js";
import { movePart, movableGroup } from "./parts.js";
import { capOwnerAt, faceNormalAt, pickEntity } from "./picking.js";
import { CLICK_PX } from "./options.js";
import {
  dragSection, keepSectionCut, placeSectionPlane, sectionAxis,
  sectionOffset, sectionRange,
} from "./section.js";

/**
 * A rounding step for a dragged part: a 1-2-5 decade near a two-hundredth of the
 * grid, so a 90 mm assembly snaps to half a millimetre and a 2 mm one does not
 * become undraggable.
 *
 * Snapped at all because a move is a SENTENCE — "about three millimetres that
 * way" — and 2.8371 mm says a precision the gesture does not have. The number
 * travels to an agent, so it should read like an instruction.
 */
function niceStep(viewer) {
  const grid = viewer && viewer.gridSize;
  const raw = Number.isFinite(grid) && grid > 0 ? grid / 200 : 0.5;
  const decade = 10 ** Math.floor(Math.log10(raw));
  const mult = raw / decade;
  return (mult >= 5 ? 5 : mult >= 2 ? 2 : 1) * decade;
}

const snap = (v, step) => Math.round(v / step) * step;

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
    point: vp.sectionSeed.point,
    normal: vp.sectionSeed.normal,
    offset: vp.state.cutOffset,
    range: sectionRange(vp.viewer),
  });
}

export function installTools(vp) {
  let press = null;

  const finish = () => {
    press = null;
    removeEventListener("pointermove", onMove, true);
    removeEventListener("pointerup", onUp, true);
    removeEventListener("pointercancel", onCancel, true);
  };

  /** Follow this press to wherever it is released.
   *
   * On the WINDOW and in the capture phase: the trackball captures the pointer,
   * so a drag that starts on the canvas can perfectly well end outside it, and a
   * release missed here strands the gesture forever.
   */
  const watch = () => {
    addEventListener("pointermove", onMove, true);
    addEventListener("pointerup", onUp, true);
    addEventListener("pointercancel", onCancel, true);
  };

  // Published so the element can end a gesture the reader has not let go of,
  // which is what a scene being replaced under one is. Everything a live press
  // holds — the plane's screen axis, a part's starting offset — was measured
  // against the scene that is going away, so continuing it would move the NEW
  // model by numbers about the old one.
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
    if (p && p.moved && p.tool === "cut") reportCut(vp);
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

  /** One pointermove while a part is being dragged. */
  const dragPart = (event) => {
    const d = press.move;
    const viewer = vp.viewer;
    const g = internals(viewer);
    if (!g) return;
    const ndc = ndcAt(g.canvas, event);
    if (!ndc) return;
    const b = cameraBasis(viewer, g);
    if (!b) return;
    // The world vector a screen displacement spans, exactly as the swipe pan
    // computes it: the difference of the two ends' offsets. Under ortho that is
    // depth-free, so a part slides in the plane of the screen and never towards
    // or away from the reader — which is what "show me where" means with a mouse
    // and is the reason no gizmo is needed for it.
    const from = ndcOffset(g, b.eye, b.view, d.ndc[0], d.ndc[1]);
    const to = ndcOffset(g, b.eye, b.view, ndc[0], ndc[1]);
    if (!from || !to) return;
    const step = niceStep(viewer);
    const delta = [
      snap(d.base[0] + to[0] - from[0], step),
      snap(d.base[1] + to[1] - from[1], step),
      snap(d.base[2] + to[2] - from[2], step),
    ];
    if (delta[0] === d.last[0] && delta[1] === d.last[1]
        && delta[2] === d.last[2]) return;
    d.last = delta;
    if (!movePart(vp, d.paths, delta)) return;
    // On the snapped value CHANGING, not on every frame: the interface shows
    // this number and puts it in a sentence, and sixty updates a second of a
    // number that did not change is a re-render for nothing.
    //
    // `count` IS WHAT MOVED and not what the row holds — the two differ, which
    // is why it is reported rather than looked up on the other side. A grab made
    // with NOTHING SELECTED drags the one copy it hit, because the viewport is
    // told which paths are selected and knows nothing about the rest; the pick
    // this press emits selects the whole row, so the NEXT drag takes all of it.
    //
    // A GRAB OUTSIDE A STANDING SELECTION IS NOT THAT CASE, and the two are easy
    // to run together: `onDown` answers it with `null`, so the press degrades to
    // a rotation and this event is never emitted at all.
    emit(vp, EVENT_MOVED, {
      id: d.paths[0],
      name: d.paths[0].split("/").filter(Boolean).pop(),
      count: d.paths.length,
      delta,
    });
  };

  function onMove(event) {
    if (!press) return;
    if (!press.moved
        && Math.abs(event.clientX - press.startX) < CLICK_PX
        && Math.abs(event.clientY - press.startY) < CLICK_PX) return;
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
      return;
    }
    if (press.tool === "move" && press.move) dragPart(event);
  }

  function onUp(event) {
    const p = press;
    finish();
    if (!p) return;
    const g = internals(vp.viewer);
    if (!g) return;
    if (p.moved) {
      if (p.tool === "cut") reportCut(vp);
      return;
    }
    // A press that never moved is a click, and it costs the trackball nothing:
    // a rotation of zero pixels is no rotation at all.
    const at = canvasXY(g.canvas, event);
    if (!at) return;
    const [x, y] = at;
    if (p.menu) {
      // The same `pickEntity` the plain pick below uses, so the identifier is of
      // the same kind and the interface looks it up in the same tree. On a CUT
      // FACE it is not the same identifier a selection would produce — the cut
      // face is asked about first, and the paragraph below says why only here.
      //
      // AND IT DOES NOT EMIT A PICK. The menu is about the part under the
      // cursor; the selection is about the part the reader chose. A tree row's
      // menu leaves the selection where it was, and one menu with two behaviours
      // is worse than either.
      //
      // THE CUT FACE IS ASKED ABOUT FIRST, and only while a cut stands — with
      // none, `capOwnerAt` returns before it does any work and this is the same
      // line it always was. The stencil cap that closes a cut off carries no
      // component id, so the picker reads straight through it to whatever lies
      // behind (picking.js says why that cannot be fixed at the picker), and the
      // menu would open on the wrong part. HERE ONLY: the other four callers of
      // `pickEntity` — measure, comment, move, plain selection — are about a
      // point on a real surface, and a cap has no surface to measure or pin.
      const ndc = ndcAt(g.canvas, event);
      const entity = (ndc && capOwnerAt(vp, g, ndc)) || pickEntity(g, x, y);
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
    const entity = pickEntity(g, x, y);
    if (p.tool === "comment") {
      if (!entity) return;
      emit(vp, EVENT_PLACE, {
        id: entity.id, name: entity.name, p: entity.point,
      });
      return;
    }
    // No tool: a plain selection, and the background is an answer too — it is
    // how a reader deselects.
    emit(vp, EVENT_PICK, entity
      ? { id: entity.id, name: entity.name, point: entity.point }
      : { id: null, name: null, point: null });
  }

  function onCancel() {
    finish();
  }

  const onDown = (event) => {
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
        moved: false, axis: undefined, move: null,
      };
      watch();
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
      moved: false, axis: undefined, move: null,
    };
    watch();
    if (!tool) return;
    if (tool === "move") {
      const at = canvasXY(g.canvas, event);
      const hit = at ? pickEntity(g, at[0], at[1]) : null;
      // The selected part if there is one, otherwise whatever was grabbed — and
      // then the interface is told, so its selection follows the hand rather
      // than the reader having to select first and drag second.
      //
      // A LIST BECAUSE THE SELECTION IS ONE: a row standing for five copies of
      // one part sends all five paths, and grabbing any of them drags the row.
      const sel = Array.isArray(vp.state.selected) ? vp.state.selected : [];
      const wanted = sel.length
        ? (hit && !sel.includes(hit.id)
          ? null                                // grabbed a different part
          : sel)
        : (hit && hit.id ? [hit.id] : null);
      const ndc = wanted ? ndcAt(g.canvas, event) : null;
      if (!wanted || !ndc || !wanted.every((path) => movableGroup(viewer, path))) {
        // Nothing here to drag. The press DEGRADES to a plain one rather than
        // being dropped: a click still selects and a drag still rotates, which
        // is how a reader reaches the part they meant to move without leaving
        // the tool first.
        press.tool = null;
        return;
      }
      if (!sel.length && hit) {
        emit(vp, EVENT_PICK, { id: hit.id, name: hit.name, point: hit.point });
      }
      // THE ANCHOR IS THE COPY UNDER THE HAND, and the copies of a row do not
      // always agree on where they are.
      //
      // A gesture applies ONE delta to all of its paths, each from its OWN home
      // (`movePart`), so whatever offsets the paths carried before it are
      // replaced by a single one: the row converges back into one thing, which
      // is what a row claims to be. TWO THINGS DRIVE THEM APART, and the second
      // is the one that gets forgotten. The ordinary one: a grab made with
      // NOTHING SELECTED drags the one copy it hit, since the viewport is only
      // told which paths are selected (see the note on `count` in `dragPart`),
      // and the pick that press emits then puts the whole row under this one.
      // The other is a FAILURE: past its pre-check `movePart` is not atomic, so
      // a `position.set` that throws on the third path leaves the first two
      // displaced and recorded in `vp.moved` (the note on it in `parts.js` says
      // why that is answered with `false` and no unwinding). Neither one changes
      // what is chosen here, and neither strands a part — `resetMoves` walks
      // exactly the paths `vp.moved` holds. So the convergence is not avoidable,
      // and the only thing left to choose is WHO does not jump to reach it. It
      // is the grabbed copy: under direct manipulation the part the reader is
      // holding must not leap out from under the cursor, while a sibling
      // snapping into line beside it reads as the row closing up.
      //
      // `wanted[0]` is the fallback for a gesture with no hit at all — a press
      // on empty space while a selection stands, which drags the selection.
      const anchor = hit && wanted.includes(hit.id) ? hit.id : wanted[0];
      const base = vp.moved.get(anchor) || [0, 0, 0];
      press.move = { paths: wanted, ndc, base, last: base };
    }
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
    // `finish` and NOT `endGesture`: this is the viewport going away, so there
    // is nobody left to tell where the plane ended up and no scene to read it
    // off. Only the listeners have to go.
    finish();
    if (vp.endGesture === endGesture) vp.endGesture = null;
  };
}
