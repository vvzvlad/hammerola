// What a gesture of the move tool REMEMBERS and what it SAYS: the record a
// press builds off the scene, and the one report a release sends.
//
// ONE CYCLE, TWO FIELDS OF ONE NODE. A move node of the proposal document
// carries an offset AND three angles (ui/src/proposal.js), and each is written
// by its own piece of one manipulator — the axis arrows and the plane quads
// (gizmo.js) write the offset, the rotation handles (rings.js) the angles. From
// the press to the report the two are the same sentence: read what is ALREADY
// STANDING off `vp.moved`, carry `last` and `stood` while the hand is down, and
// announce the result once — to the interface as a STATEMENT about a build
// nothing has changed, or to the panel as an ordinary EDIT of the document the
// reader is drawing. Which field of the node a gesture writes and which two
// names it goes out under is the whole of what separates them, so that is what
// the caller passes (#101).
//
// WHAT STAYS WITH EACH GESTURE is what only one of them has, and both are
// snapshots of the scene rather than of the record: the press's own NDC and the
// group homes a slide nudges a body by (gizmo.js), and the seats a turn needs
// instead, which carry a pose and the body's own centre on top of the home
// (rings.js). Neither can be assembled without knowing which gesture is being
// built, which is the line between what is here and what is beside it.

import { emit } from "./events.js";

/**
 * Everything a gesture has to remember about the scene it started on, assembled
 * once at the press.
 *
 * `paths` is what the gesture holds, `anchor` the path every other field is read
 * off, `proposal` whether this is a drag of the reader's own drawing rather than
 * of the build, and `field` which half of a move node this gesture writes —
 * `delta` for a slide, `turn` for a rotation.
 *
 * MODULE-LEVEL AND EXPORTED because the gestures that make one live in the
 * widgets and the report that reads it is `reportGesture` below. Every field is
 * a decision with a reason, which is exactly the kind of thing a second
 * hand-made copy gets subtly wrong.
 *
 * `base` IS WHAT IS ALREADY STANDING in that field, and `last` and `stood` start
 * there: a press can perfectly well land on a part that has been moved or turned
 * before, and a gesture that started from zero would jerk it home on its first
 * step. For a body of the proposal it is always zero — nothing writes one for it
 * — and that is the point rather than a coincidence: each drag of a body starts
 * from where the document now puts it, because the previous one is already in
 * the document.
 *
 * THE OTHER FIELD IS CARRIED AND NEVER CHANGED, under its own name, and it is
 * the anchor's for the same reason `base` is: `movePart` writes position and
 * orientation together on every call, so a gesture that left the other half out
 * would flatten a part the reader had turned the instant they slid it, and send
 * a part they had dragged home the instant they turned it.
 *
 * `bases` IS THE SAME QUESTION ASKED OF EVERY PATH, and the two are not the same
 * list because the copies of a row need not agree. `base` is the anchor's alone
 * and decides where the gesture STARTS FROM, which is the value of the copy the
 * manipulator is standing on, so the widget and the part under it do not leap
 * apart at the first snap step. Every other path is carried to that same value
 * by the first step, and where each of them WAS is the only record of what this
 * gesture actually changed — which is what `reportModel` asks at the release.
 *
 * WHICH MAKES THE PICTURE DURING THE DRAG THE ANCHOR'S AND THE ANSWER THE
 * DOCUMENT'S, and the two can disagree for the length of one gesture. Grab
 * copies that are turned differently and they all stand at the anchor's turn
 * while the hand is down; on release the interface merges them into one node,
 * finds no turn they agree on, and they straighten (`hmr:moved` in
 * HammerolaViewer.jsx). The end state is the document's and it is right; what is
 * in between is a preview, and this is the only place that says so.
 *
 * `build` IS WHICH SCENE THESE NUMBERS ARE ABOUT, and it is read here because
 * here is the last moment it is unambiguous: a build landing mid-drag replaces
 * the scene while the hand is still down, and a report deferred past that would
 * otherwise arrive describing an assembly that has left. It is the interface's
 * own key for the build, so the two sides compare the same string.
 *
 * `drawnKey` AND NOT `state.buildKey`, which is the difference between the build
 * that is DRAWN and the one that has been announced. The state field moves the
 * moment the interface says a swap is coming, and the geometry arrives later —
 * after the `await fetch` in `load()`. Nothing disarms the Move tool across that
 * window, so a press begun inside it would carry the new build's key, match on
 * arrival, and file paths read off the assembly that was still on screen.
 * `show()` writes `drawnKey` beside the payload, which is the line that means
 * the new scene is really up.
 *
 * `body` IS THE NAME THE PANEL DREW A PROPOSAL BODY UNDER, which is the only
 * thing the panel can find a node by, and it is also the FLAG the two endings
 * are told apart by (`reportGesture`): a part of the model has none.
 *
 * `already` AND NOT `stood`, which is taken: `stood` is the last value a GESTURE
 * has landed, and two different things under one name in ten lines is how the
 * wrong one gets read.
 */
export function gestureRecord(vp, paths, anchor, proposal, field) {
  const already = vp.moved.get(anchor);
  const other = field === "delta" ? "turn" : "delta";
  const base = already ? already[field] : [0, 0, 0];
  return {
    paths,
    base,
    last: base,
    stood: base,
    [other]: already ? already[other] : [0, 0, 0],
    bases: paths.map((path) => {
      const held = vp.moved.get(path);
      return held ? held[field] : [0, 0, 0];
    }),
    build: vp.drawnKey,
    body: proposal ? vp.overlayBody(anchor) : null,
  };
}

/** Where a dragged PROPOSAL body ended up, announced once.
 *
 * THE RELEASE IS THE ONLY REPORT, and the part of the build this gesture is
 * shared with is reported the same way for the same reason (`reportModel`
 * below). This one ends in an EDIT of the proposal document, whose bodies are
 * STAGED out of that document, and an edit per step would rebuild them, hand
 * them to the viewport, and have the whole scene disposed and rendered again —
 * while the reader is still dragging. `typeProposal`/`commitProposal` on the
 * other side make exactly this decision about a field being typed in, for
 * exactly this reason.
 *
 * A GESTURE THAT WENT NOWHERE SAYS NOTHING. `last` is the value the hand has
 * landed on and it starts at nothing for a body — the document holds the body's
 * place and its pose, and this side has never written either — so a drag that
 * never left the first step, or that came back to where it started, changed the
 * body by nothing, and reporting it would be a whole re-stage of a document
 * nothing changed in.
 *
 * AND IT IS NEVER SENT FROM INSIDE A RENDER, which is what the microtask is for
 * and the one thing here that is not obvious. This report comes back as a
 * STAGE: the panel writes the body's own field and calls `setOverlay`, which
 * reaches `restage()`, which reads `this.payload` and renders it. One of the
 * endings that raise this report is a widget's `endDrag` (gizmo.js, rings.js),
 * and `endDrag` is called from inside `show()` — after its only `await` and
 * BEFORE `this.payload = shapes`, which is deliberately the last thing a
 * successful render does (element.js says why). Sent synchronously from there,
 * the re-stage would read the payload of the build being REPLACED, sleep on its
 * own `await` while the outer render finished, and then repaint the previous
 * build and write its document back over the new one — under the same load
 * token, so nothing would notice, and the reader would be left looking at the
 * old build with no reload coming. A microtask puts the report after the render
 * that raised it, whichever caller raised it: by then the payload, the tree and
 * the scene are the new build's, and the re-stage composes the moved body into
 * THAT.
 *
 * `reportCut` in tools.js stays synchronous and must: it READS BACK off the
 * scene that is still on screen, so a microtask would measure the next one.
 */
function reportProposal(vp, rec, proposalEvent, key) {
  const d = rec.last;
  if (!d[0] && !d[1] && !d[2]) return;
  queueMicrotask(() => emit(vp, proposalEvent, {
    name: rec.body, [key]: d,
  }));
}

/** Where a dragged part of the BUILD ended up, announced once.
 *
 * THE RELEASE IS THE ONLY REPORT, AND IT HAS TO BE. Reported on every step it
 * reads as the cheaper thing — the part is already standing there, so a document
 * handed straight back costs the scene nothing (`reconcileMoves`). It is not
 * cheap at all once the interface answers by OPENING THE PANEL: an overlay that
 * changed reaches `restage()`, `restage()` calls `show()`, and `show()` ends the
 * gesture the reader has not let go of (`endDrag`, element.js) — so the press
 * and its window listeners would be torn down one step into the drag and the
 * part would freeze under the cursor. A report per gesture cannot do that: by
 * the time it lands, the gesture it would end is already over.
 *
 * EVERY ENDING THE WIDGET HAS RAISES IT, which is `stop()` in gizmo.js and in
 * rings.js: an interrupted drag has to be reported because the part is standing
 * moved or turned in `vp.moved` with nothing in the document claiming it, and
 * the next push would send it home under the reader's hand.
 *
 * A GESTURE THAT CHANGED NOTHING SAYS NOTHING, and for a part of the build
 * "nothing" is measured against what was STANDING rather than against zero:
 * unlike a body, a part may already have been moved when this press started. A
 * drag that never crossed a step, or that came back to the one it started on,
 * leaves `stood` equal to those — and announcing that would write a node the
 * document already has and open the panel to show it.
 *
 * AGAINST EVERY PATH'S OWN AND NOT THE ANCHOR'S, which is the whole reason
 * `bases` is a list. One gesture applies one answer to every path it holds
 * (`movePart`), so a grab on a copy that stands APART from its row carries all
 * of its siblings onto the anchor's value and can then come back to exactly
 * where the anchor started. Asked about the anchor alone that reads as "nothing
 * happened", and the siblings are left standing somewhere no node claims — until
 * the next push jerks them home.
 *
 * `count` IS WHAT MOVED, reported rather than looked up on the other side
 * because the viewport is the half that knows what the gesture actually took
 * hold of — the paths the manipulator was standing on when the press was made,
 * which need not be the selection the interface holds by the time this lands.
 *
 * `paths` IS EVERY ONE OF THEM AND `id` IS STILL THE FIRST, because the two are
 * read by different halves of the other side. The interface looks the dragged
 * part up in its tree to name it, which is one lookup and wants one path; what
 * it RECORDS is a displacement, and that has to name every path this gesture
 * actually moved — recorded off `id` alone, the four other copies of a five-copy
 * row would be standing changed with nothing claiming them, and the first push
 * of the document back to this viewport would send them home under the reader's
 * hand.
 *
 * `build` IS WHICH SCENE THE NUMBERS ARE ABOUT, stamped at the press and carried
 * out on the report, because the microtask that defers this can outlive the
 * build it was measured on. `show()` runs `endGesture` and then dispatches
 * `hmr:model` with no `await` between them, so a live rebuild landing mid-drag
 * delivers the model event FIRST and this report afterwards — paths and a value
 * belonging to an assembly that has left, handed to an interface that has
 * already dropped its moves for exactly that reason. The other side compares
 * this against the build it is now showing and drops what does not match; the
 * stamp is here because this is the only half that knows which scene the hand
 * was on.
 */
function reportModel(vp, rec, modelEvent, key) {
  const d = rec.stood;
  if (rec.bases.every((base) => d.every((v, axis) => v === base[axis]))) return;
  queueMicrotask(() => emit(vp, modelEvent, {
    id: rec.paths[0],
    name: rec.paths[0].split("/").filter(Boolean).pop(),
    paths: [...rec.paths],
    count: rec.paths.length,
    build: rec.build,
    [key]: d,
  }));
}

/** What one finished gesture SAYS, whichever of the two things it was holding.
 *
 * THE TWO MEANINGS PART HERE AND NOWHERE ELSE, on the one field that tells them
 * apart: a proposal body carries the name the panel drew it under and a part of
 * the build carries none. They are opposite claims about the model — a part of
 * the build is a STATEMENT to the agent about a model nothing has changed, a
 * body is an ordinary EDIT of the document the reader is drawing — so they part
 * here rather than behind a flag on one event.
 *
 * THE TWO NAMES AND THE FIELD COME FROM THE CALLER, which is the whole of what a
 * slide and a turn disagree about by the time they get here. `key` is the field
 * of `vp.moved` the gesture wrote, and the value goes out on the event under
 * that same name — `recordGesture(e.detail, 'delta')` in HammerolaViewer.jsx
 * reads it back by it.
 */
export function reportGesture(vp, rec, { modelEvent, proposalEvent, key }) {
  if (rec.body) reportProposal(vp, rec, proposalEvent, key);
  else reportModel(vp, rec, modelEvent, key);
}
