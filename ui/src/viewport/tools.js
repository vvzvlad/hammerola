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
import { cameraBasis, canvasXY, ndcAt, ndcOffset } from "./camera.js";
import { gestureInternals, internals } from "./internals.js";
import { measureDistance, measureEntity } from "./measure.js";
import { groupHome, movePart, movableGroup, nudgePart } from "./parts.js";
import { capOwnerAt, faceNormalAt, pickEntity } from "./picking.js";
import { CLICK_PX } from "./options.js";
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
 * EXPORTED BECAUSE THERE ARE TWO GESTURES THAT MOVE A PART NOW — the free drag
 * below and the axis arrows (gizmo.js) — and a second copy of this rule would be
 * two vocabularies for one document: the same hand, on the same part, would
 * round differently depending on which of the two it reached for.
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
 * `restage()`, which reads `this.payload` and renders it. One of the two
 * callers of `conclude` is `endGesture`, and `endGesture` is called from
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
 * (`endGesture`, element.js) — so the press and its window listeners were torn
 * down one snap step into the drag and the part froze under the cursor. A
 * report per gesture cannot do that: by the time it lands, the gesture it
 * would end is already over.
 *
 * THE SAME FOUR ENDINGS AS THE BODY ABOVE, which is `conclude` and
 * `concludeMove` between them, and the teardown reports nothing. An
 * interrupted drag has to be reported for the reason `concludeMove` gives: the
 * part is standing displaced in `vp.moved` with nothing in the document
 * claiming it, and the next push would send it home under the reader's hand.
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
 * `count` IS WHAT MOVED and not what the row holds — the two differ, which is
 * why it is reported rather than looked up on the other side. A grab made with
 * NOTHING SELECTED drags the one copy it hit, because the viewport is told
 * which paths are selected and knows nothing about the rest; the pick that
 * press emits selects the whole row, so the NEXT drag takes all of it.
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
 * the build carries none. That is the dispatch `concludeMove` was written as,
 * and lifting it out of `installTools` is what lets the axis arrows (gizmo.js)
 * end their own drag through the same sentence rather than through a second
 * copy of it — which is the defect worth naming, because a copy would not
 * fail: it would simply drift, and the two gestures would start reporting the
 * same hand differently.
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
 * MODULE-LEVEL AND EXPORTED because two gestures make one of these now — the
 * canvas drag below and the axis arrows (gizmo.js) — and every field is a
 * decision with a reason, which is exactly the kind of thing a second hand-made
 * copy gets subtly wrong.
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
 * grabbed copy's offset so it does not leap out from under the cursor.
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

  /** The end of a gesture that moved something, for the two endings that always
   * answered for one: the release (`onUp`) and the scene being swapped out from
   * under a hand that has not come off the model (`endGesture`).
   *
   * THERE ARE FIVE ENDINGS IN THIS FILE, not two and not four. Besides those:
   * the platform taking the pointer away (`onCancel`), a second press arriving
   * with one still live (`onDown`) — both of which conclude the MOVE alone, see
   * `concludeMove` — and the teardown in `installTools`, which calls a bare
   * `finish()` and reports nothing, because a gesture cannot outlive the element
   * it was made on.
   *
   * IT IS CALLED AFTER `finish()`, never before. `reportCut` can reach back into
   * the element, and a report that ends up re-staging runs `endGesture` again:
   * with `press` already cleared there is nothing left to conclude twice.
   */
  const conclude = (p) => {
    if (!p || !p.moved) return;
    if (p.tool === "cut") reportCut(vp);
    else concludeMove(p);
  };

  /** The same end, for a gesture that was MOVING something — a body of the
   *  proposal or a part of the build.
   *
   * THE TWO MEANINGS PART IN `reportMove` AND NOT HERE, which is why this reads
   * as one line: whichever it was, the thing is
   * standing somewhere the document does not have it, and that is what an ending
   * is for. `conclude` above goes through this one rather than repeating it, so
   * the four endings cannot drift into answering differently — and the axis
   * arrows (gizmo.js) end their own drag in that same `reportMove`, which is why
   * it is a module-level function rather than this pair of lines.
   *
   * WHY THE CUT IS NOT REPORTED FROM HERE, though the staleness is real and the
   * readback would fix it: these two endings dropped every gesture before this
   * change, and taking the cut with them would alter a tool nobody asked about.
   * `reportCut` is not a bare readback — the interface answers `hmr:face` by
   * DISARMING the armed tool, so an interrupted plane drag would start turning
   * the cut tool off, which no reader asked for and no test describes. The move
   * half has no such reach: it edits the document the reader is drawing and
   * nothing else.
   *
   * THE ASYMMETRY IS THE POINT rather than an oversight. An unreported cut
   * leaves the interface printing a depth the plane has not been at — a wrong
   * NUMBER beside a plane that is standing correctly. An unreported move leaves
   * the thing where the hand dragged it while the document still says otherwise:
   * for a body, the panel's next edit stages it home; for a part of the build,
   * the next `reconcileMoves` sends it home, because the document claims no such
   * offset. Either way the drag is silently undone, which for a gesture whose
   * POSITION IS THE DATA is the whole of it.
   *
   * NO `tool === "cut"` TEST, and none is needed: `press.move` is filled in only
   * on the `move` branch of `onDown`, so a cut gesture reaches here with no
   * `move` at all and the guard below turns it away without naming the tool. A
   * branch on the tool would be one nothing can enter.
   */
  const concludeMove = (p) => {
    if (!p || !p.moved || !p.move) return;
    reportMove(vp, p.move);
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
    // or away from the reader — which is what "show me where" means with a mouse.
    //
    // THE TURN IS NOT IN THIS GESTURE. A move node carries one now (`turn` in
    // ui/src/proposal.js), and it is typed into the row's own fields in the
    // proposal branch of the tree rather than dragged: the hand does one thing
    // here, and the turn the part is already standing at is carried along
    // untouched (`press.move.turn` below).
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
    // A BODY OF THE PROPOSAL GOES NO FURTHER THAN THE SCREEN while the hand is
    // down. It is moved so the reader can see where they are putting it, and
    // NOTHING IS RECORDED for it: `vp.moved` is re-applied after every re-stage
    // (`restageMoves`) and the panel re-stages on the next edit, so a delta left
    // there would be added on top of the position the document will by then
    // carry, and the body would walk away by twice the distance. No move node
    // either — `hmr:moved` is the interface's statement about a part of the
    // BUILD, and this body is in no build. The release is what reaches the panel
    // (`reportProposalMove`), and the stage that follows is what really puts the
    // body where it now stands.
    if (d.body) {
      nudgePart(vp, d.paths, d.homes, delta);
      return;
    }
    // A PART OF THE BUILD ALSO GOES NO FURTHER THAN THE SCREEN while the hand is
    // down, and unlike the body above it leaves `vp.moved` behind — which is the
    // whole difference between the two: the offset is real, the scene is holding
    // it, and the release is what tells the interface (`reportModelMove`). The
    // report used to go out from here, on every snap step, and that is what the
    // panel opening on a recorded move turned into a broken drag: the overlay
    // changed, `restage()` called `show()`, and `show()` ended this very gesture
    // one step in.
    //
    // A GRAB OUTSIDE A STANDING SELECTION NEVER REACHES THIS LINE: `onDown`
    // answers it with `null`, so the press degrades to a rotation and no part is
    // moved at all.
    //
    // `stood` IS THE LAST DELTA THAT LANDED, and it is a second field rather
    // than `last` because `movePart` can refuse — a path whose group has gone,
    // or a `position.set` that throws part way down a row (parts.js says why
    // neither is unwound). `last` has to advance whatever happens, or a step
    // that fails is retried on every pointermove for the rest of the gesture.
    //
    // IT IS NOT "WHERE THE PARTS ARE", and the difference matters in exactly the
    // case it exists for: a refusal that threw half way down a row leaves the
    // paths before the throw at the NEWER delta and the rest at this one, so no
    // single number describes the scene. What this holds is the last offset the
    // whole gesture is known to have reached, which is the truest thing there is
    // to announce — and `reconcileMoves` is what settles the stragglers, since
    // it walks `vp.moved` and writes every path the document's offset is not
    // already standing at. Reporting per step made the distinction for free: a
    // failed step simply emitted nothing.
    if (movePart(vp, d.paths, delta, d.turn)) d.stood = delta;
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
      conclude(p);
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

  /** The pointer was taken away — the platform scrolling, a gesture the browser
   *  decided was its own. No `pointerup` follows one of these.
   *
   * THE MOVE IS CONCLUDED HERE AND THE CUT IS NOT — `concludeMove` carries the
   * reason, and this is deliberately not "concluded like every other ending".
   * What a cancel interrupts is something already standing somewhere else on
   * screen: abandoned, the document keeps the place the thing has just left, and
   * the next stage or reconcile puts it back — the drag silently undone, the one
   * failure this whole gesture is written around. There is nothing to undo on the
   * way out: the report is the position the thing is already at. A cut
   * interrupted here is dropped exactly as it was before anything could be
   * dragged.
   */
  function onCancel() {
    const p = press;
    finish();
    concludeMove(p);
  }

  const onDown = (event) => {
    // A PRESS ARRIVING WITH ONE STILL LIVE, which is either a gesture whose
    // release this page never saw or a second button — or finger — coming down
    // mid-drag. Either way the old one ends HERE. A move is concluded for the
    // reason `onCancel` gives: the thing is standing where the reader dragged it
    // and only the document can be wrong about that. A cut is dropped, exactly
    // as it was before anything could be dragged at all — `concludeMove` says
    // why that asymmetry is deliberate.
    //
    // WHAT CONCLUDING COSTS, said out loud because it is a real cost: a report
    // can lead to a re-stage, and a re-stage ends whatever gesture is live by
    // then — this very press, which by the time the deferred report lands has
    // been built below. So the press that interrupted a moved thing does nothing
    // and the reader presses again. That is the same thing a build landing
    // mid-drag already does, it happens only when there was a displacement to
    // report, and the alternative is losing the drag itself.
    const live = press;
    finish();
    concludeMove(live);
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
    // THE TURN TOOL OWNS NO PRESS ON THIS ELEMENT, and saying so is what keeps
    // the model turnable while it is armed. Its gesture is on the rings
    // (rings.js), which take their press in a capture-phase listener on the
    // WINDOW and stop it there — so a press that reaches this listener is one
    // that missed every ring, and it belongs to the trackball exactly as it
    // would with no tool armed. Left to fall through, it would be swallowed by
    // the two lines at the foot of this function, and a reader who armed the
    // tool that turns a PART would find they could no longer turn the VIEW.
    //
    // DEGRADED AND NOT DROPPED, which is the Move tool's own answer to a press
    // it cannot use: `press.tool = null` leaves a click selecting and a drag
    // rotating, so the reader reaches the part they meant to turn without
    // leaving the tool first.
    if (tool === "turn") {
      press.tool = null;
      return;
    }
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
      // WHICH OF TWO GESTURES THIS IS, and the question is the viewport's own
      // (`isOverlay`). The proposal panel stages its bodies into the scene, so
      // each is an ordinary group here and an ordinary pick target — but such a
      // body is the READER'S OWN DRAWING and not a part of the build, so dragging
      // one means something else entirely. A part of the model moves as a
      // STATEMENT to the agent: `hmr:moved` files the paths in the build's terms
      // and the panel records them beside its bodies, the model itself being
      // untouched. A proposal body moves as an EDIT of the panel's document:
      // `hmr:proposalmove` names the body, the panel adds the delta to its `at`,
      // and nothing is filed about anything. Same hand, same snapping, two
      // MEANINGS — "ending" is this file's word for a place a gesture can stop,
      // and there are five of those. They part in two places now: `dragPart`,
      // which decides what the scene does while the hand is down, and
      // `concludeMove`, which decides what is said when it comes off.
      //
      // `some` AND THEN `every`, which is what refuses a MIXED grab — a proposal
      // body selected together with a part of the model — whole rather than
      // quietly moving the half it may: one overlay path makes this a proposal
      // drag, and then a model path has no body name and is not grabbable into
      // it. The same all-or-nothing `movePart` keeps for the copies of a row, and
      // the group node the bodies hang under is refused by the same line (see
      // `overlayBody`, which answers null for it).
      //
      // REFUSED WITH THE GESTURE and not later, in the same breath as a part the
      // scene cannot move at all: here nothing has moved yet, and the press
      // degrades into the plain one below.
      const proposal = wanted ? wanted.some((path) => vp.isOverlay(path)) : false;
      const grabbable = (path) => !!movableGroup(viewer, path)
        && (!proposal || !!vp.overlayBody(path));
      if (!wanted || !ndc || !wanted.every(grabbable)) {
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
      // what is chosen here, and neither strands a part — `reconcileMoves` walks
      // exactly the paths `vp.moved` holds and puts back every one the proposal
      // document does not claim. So the convergence is not avoidable, and the
      // only thing left to choose is WHO does not jump to reach it. It is the
      // grabbed copy: under direct manipulation the part the reader is
      // holding must not leap out from under the cursor, while a sibling
      // snapping into line beside it reads as the row closing up.
      //
      // `wanted[0]` is the fallback for a gesture with no hit at all — a press
      // on empty space while a selection stands, which drags the selection.
      const anchor = hit && wanted.includes(hit.id) ? hit.id : wanted[0];
      // Every field of the record, and why each is what it is, lives in
      // `moveRecord` above: the axis arrows make one of these too, and a second
      // hand-written copy is how the two gestures would start disagreeing about
      // what a drag of the same part means.
      press.move = moveRecord(vp, wanted, ndc, anchor, proposal);
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
    // `finish` and NOT `endGesture` — the FIFTH ending, and the one that reports
    // nothing. This is the viewport going away, and each of the three things a
    // gesture can be holding goes with it. For a cut there is no scene left to
    // read the plane off. For a body of the proposal there is no gesture that can
    // outlive the element it was made on — the body goes with the viewport, and
    // whatever comes next stages it from the document. For a part of the BUILD
    // the same is true from the other end: `vp.moved` is this element's own map
    // and dies here too, so the displacement being reported is one nothing is
    // left standing at. Nothing on screen is left disagreeing with anything.
    // Only the listeners have to go.
    finish();
    if (vp.endGesture === endGesture) vp.endGesture = null;
  };
}
