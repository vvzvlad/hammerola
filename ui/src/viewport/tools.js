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
  EVENT_PROPOSALMOVE, emit,
} from "./events.js";
import { canvasXY, ndcAt } from "./camera.js";
import { travelled, watchDrag } from "./drag.js";
import { internals } from "./internals.js";
import { measureDistance, measureEntity } from "./measure.js";
import { groupHome } from "./parts.js";
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

/** Where a dragged PROPOSAL body ended up, announced once.
 *
 * THE RELEASE IS THE ONLY REPORT, and the model part this gesture is shared
 * with is reported the same way for the same reason (`reportModelMove` below).
 * This one ends in an EDIT of the proposal document, whose bodies are STAGED
 * out of that document, and an edit per snap step would rebuild them, hand
 * them to the viewport, and have the whole scene disposed and rendered again —
 * while the reader is still dragging.
 * `typeProposal`/`commitProposal` on the other side make exactly this decision
 * about a field being typed in, for exactly this reason.
 *
 * A GESTURE THAT WENT NOWHERE SAYS NOTHING. `last` is the SNAPPED delta and it
 * starts at zero, so a drag that never left the first snap step — or that came
 * back to where it started — moved the body by nothing, and reporting it would
 * be a whole re-stage of a document nothing changed in.
 *
 * AND IT IS NEVER SENT FROM INSIDE A RENDER, which is what the microtask is
 * for and the one thing here that is not obvious. This report comes back as a
 * STAGE: the panel writes the body's `at` and calls `setOverlay`, which reaches
 * `restage()`, which reads `this.payload` and renders it. One of the endings
 * that raise this report is the widget's `endDrag` (gizmo.js, rings.js), and
 * `endDrag` is called from
 * inside `show()` — after its only `await` and BEFORE `this.payload = shapes`,
 * which is deliberately the last thing a successful render does (element.js
 * says why). Sent synchronously from there, the re-stage would read the
 * payload of the build being REPLACED, sleep on its own `await` while the
 * outer render finished, and then repaint the previous build and write its
 * document back over the new one — under the same load token, so nothing
 * would notice, and the reader would be left looking at the old build with no
 * reload coming. A microtask puts the report after the render that raised it,
 * whichever caller raised it: by then the payload, the tree and the scene are
 * the new build's, and the re-stage composes the moved body into THAT.
 *
 * `reportCut` beside it stays synchronous and must: it READS BACK off the
 * scene that is still on screen, so a microtask would measure the next one.
 */
function reportProposalMove(vp, move) {
  const d = move.last;
  if (!d[0] && !d[1] && !d[2]) return;
  queueMicrotask(() => emit(vp, EVENT_PROPOSALMOVE, {
    name: move.body, delta: d,
  }));
}

/** Where a dragged part of the BUILD ended up, announced once.
 *
 * THE RELEASE IS THE ONLY REPORT, AND IT HAS TO BE. This used to go out on
 * every snap step, which read as the cheaper thing — the part is already
 * standing there, so a document handed straight back costs the scene nothing
 * (`reconcileMoves`). It is not cheap at all once the interface answers by
 * OPENING THE PANEL: an overlay that changed reaches `restage()`, `restage()`
 * calls `show()`, and `show()` ends the gesture the reader has not let go of
 * (`endDrag`, element.js) — so the press and its window listeners were torn
 * down one snap step into the drag and the part froze under the cursor. A
 * report per gesture cannot do that: by the time it lands, the gesture it
 * would end is already over.
 *
 * EVERY ENDING THE WIDGET HAS RAISES IT, which is `stop()` in gizmo.js and in
 * rings.js: an interrupted drag has to be reported because the part is standing
 * displaced in `vp.moved` with nothing in the document claiming it, and the
 * next push would send it home under the reader's hand.
 *
 * A GESTURE THAT CHANGED NOTHING SAYS NOTHING, and for a part of the build
 * "nothing" is measured against the offsets that were STANDING rather than
 * against zero: unlike a body, a part may already have been displaced when
 * this press started. A drag that never crossed a snap step, or that came back
 * to the one it started on, leaves `stood` equal to those — and announcing
 * that would write a node the document already has and open the panel to show
 * it.
 *
 * AGAINST EVERY PATH'S OWN OFFSET AND NOT THE ANCHOR'S, which is the whole
 * reason `bases` is a list. One gesture applies one delta to every path it
 * holds (`movePart`), so a grab on a copy that stands APART from its row moves
 * all of its siblings onto the anchor's offset and can then come back to
 * exactly where the anchor started. Asked about the anchor alone that reads as
 * "nothing happened", and the siblings are left standing somewhere no node
 * claims — until the next push jerks them home.
 *
 * `count` IS WHAT MOVED, reported rather than looked up on the other side
 * because the viewport is the half that knows what the gesture actually took
 * hold of — the paths the manipulator was standing on when the press was made,
 * which need not be the selection the interface holds by the time this lands.
 *
 * `paths` IS EVERY ONE OF THEM AND `id` IS STILL THE FIRST, because the two
 * are read by different halves of the other side. The interface looks the
 * dragged part up in its tree to name it, which is one lookup and wants one
 * path; what it RECORDS is a displacement, and that has to name every path
 * this gesture actually moved — recorded off `id` alone, the four other copies
 * of a five-copy row would be standing displaced with nothing claiming them,
 * and the first push of the document back to this viewport would send them
 * home under the reader's hand.
 *
 * `build` IS WHICH SCENE THE NUMBERS ARE ABOUT, stamped at the press and
 * carried out on the report, because the microtask that defers this can outlive
 * the build it was measured on. `show()` runs `endGesture` and then dispatches
 * `hmr:model` with no `await` between them, so a live rebuild landing mid-drag
 * delivers the model event FIRST and this report afterwards — paths and an
 * offset belonging to an assembly that has left, handed to an interface that
 * has already dropped its moves for exactly that reason. The other side
 * compares this against the build it is now showing and drops what does not
 * match; the stamp is here because this is the only half that knows which
 * scene the hand was on.
 */
function reportModelMove(vp, move) {
  const d = move.stood;
  if (move.bases.every((base) => d.every((v, axis) => v === base[axis]))) return;
  queueMicrotask(() => emit(vp, EVENT_MOVED, {
    id: move.paths[0],
    name: move.paths[0].split("/").filter(Boolean).pop(),
    paths: [...move.paths],
    count: move.paths.length,
    build: move.build,
    delta: d,
  }));
}

/** What one finished move SAYS, whichever of the two things it was moving.
 *
 * THE TWO MEANINGS PART HERE AND NOWHERE ELSE, on the one field that tells them
 * apart: a proposal body carries the name the panel drew it under and a part of
 * the build carries none.
 *
 * MODULE-LEVEL AND EXPORTED although nothing in this file calls it: the
 * gestures that move a part are the manipulator's (gizmo.js, rings.js), and
 * what they end in is this sentence rather than a copy of it — which is the
 * defect worth naming, because a copy would not fail: it would simply drift,
 * and the pieces would start reporting the same hand differently. It stays
 * HERE, beside `snap` and the two reports it dispatches between, so the record
 * and the sentence that reads it cannot come apart.
 */
export function reportMove(vp, move) {
  if (move.body) reportProposalMove(vp, move);
  else reportModelMove(vp, move);
}

/**
 * Everything a move gesture has to remember about the scene it started on,
 * assembled once at the press.
 *
 * `paths` is what the gesture holds, `ndc` where the pointer was when it was
 * made, `anchor` the path the other fields are read off, and `proposal` whether
 * this is a drag of the reader's own drawing rather than of the build.
 *
 * MODULE-LEVEL AND EXPORTED because the gesture that makes one lives in
 * gizmo.js — whichever of its six targets the press landed on — while the
 * report that reads it is `reportMove` above. Every field is a decision with a
 * reason, which is exactly the kind of thing a second hand-made copy gets
 * subtly wrong.
 *
 * WHAT THE PROPOSAL DRAG CARRIES INSTEAD OF `vp.moved`, and both fields
 * are the gesture's own and die with it. `body` is the name the panel drew
 * the grabbed body under, which is the only thing the panel can find a node
 * by, and it is also the FLAG the two endings are told apart by — a part
 * of the model has none. `homes` is where the groups stand at the press,
 * read straight off the scene rather than remembered in `vp.partHome`:
 * this body's home is whatever the document last said, so a home kept
 * across the re-stage the last drag caused would be a home that has moved.
 *
 * `base` STAYS THE OFFSET ALREADY STANDING, which for a proposal body is
 * always zero — nothing writes one for it — and that is the point rather
 * than a coincidence: each drag of a body starts from where the document
 * now puts it, because the previous one is already in the document.
 *
 * `bases` IS THE SAME QUESTION ASKED OF EVERY PATH, and the two are not
 * the same list because the copies of a row need not agree: `base` is the
 * anchor's alone and decides where the drag STARTS FROM, which is the
 * offset of the copy the manipulator is standing on, so the widget and the
 * part under it do not leap apart at the first snap step.
 * Every other path is carried to that same offset by the first snap step,
 * and where each of them WAS is the only record of what this gesture
 * actually changed — which is what `reportModelMove` asks at the release.
 *
 * `build` IS THE SCENE THESE NUMBERS BELONG TO, and it is read here
 * because here is the last moment it is unambiguous: a build landing
 * mid-drag replaces the scene while the hand is still down, and a report
 * deferred past that would otherwise arrive describing an assembly that
 * has left. It is the interface's own key for the build, so the two sides
 * compare the same string.
 *
 * `drawnKey` AND NOT `state.buildKey`, which is the difference between the
 * build that is DRAWN and the one that has been announced. The state field
 * moves the moment the interface says a swap is coming, and the geometry
 * arrives later — after the `await fetch` in `load()`. Nothing disarms the
 * Move tool across that window, so a press begun inside it would carry the
 * new build's key, match on arrival, and file paths read off the assembly
 * that was still on screen. `show()` writes `drawnKey` beside the payload,
 * which is the line that means the new scene is really up.
 *
 * `turn` IS CARRIED AND NEVER CHANGED BY THIS GESTURE, and it is the
 * anchor's for the same reason `base` is: one call of `movePart` writes one
 * turn onto every path it holds, so a drag that left it out would flatten a
 * part the reader had turned the moment they slid it (`movePart` writes the
 * group's quaternion on every call). The panel's fields are where it moves.
 *
 * WHICH MAKES THE PICTURE DURING THE DRAG THE ANCHOR'S AND THE ANSWER THE
 * DOCUMENT'S, and the two can disagree for the length of one gesture.
 * Grab copies that are turned differently and they all stand at the
 * anchor's turn while the hand is down; on release the interface merges
 * them into one node, finds no turn they agree on, and they straighten
 * (`hmr:moved` in HammerolaViewer.jsx). The end state is the document's
 * and it is right; what is in between is a preview, and this is the only
 * place that says so.
 *
 * `already` AND NOT `stood`, which is taken: `stood` below is the last delta a
 * GESTURE has landed, and two different things under one name in ten lines is
 * how the wrong one gets read.
 */
export function moveRecord(vp, paths, ndc, anchor, proposal) {
  const already = vp.moved.get(anchor);
  const base = already ? already.delta : [0, 0, 0];
  return {
    paths, ndc, base, last: base, stood: base,
    turn: already ? already.turn : [0, 0, 0],
    bases: paths.map((path) => {
      const held = vp.moved.get(path);
      return held ? held.delta : [0, 0, 0];
    }),
    build: vp.drawnKey,
    body: proposal ? vp.overlayBody(anchor) : null,
    homes: proposal ? paths.map((path) => groupHome(vp.viewer, path)) : null,
  };
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
   * argument `moveRecord` makes further down for the same reason.
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
