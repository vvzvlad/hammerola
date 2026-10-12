// What a gesture of the move tool REMEMBERS and what it SAYS: the record a
// press builds off the scene, and the one report a release sends.
//
// A move node of the proposal document carries an offset AND three angles
// (ui/src/proposal.js); the axis arrows and plane quads (gizmo.js) write the
// offset and the rotation handles (rings.js) the angles. Both follow one cycle:
// read what is already standing off `vp.moved`, carry `last` and `stood` while
// the hand is down, and report once — to the interface as a STATEMENT about an
// unchanged build, or to the panel as an EDIT of the reader's document. The
// caller passes which field it writes and which two event names it uses.
//
// What only one gesture needs stays with it: the press NDC and group homes of a
// slide (gizmo.js), the seats with pose and body centre of a turn (rings.js).

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
 * Module-level and exported: the widgets build it and `reportGesture` reads it.
 *
 * `base` is what is already standing in that field, and `last`/`stood` start
 * there, so a part moved or turned before does not jerk home on the first step.
 * For a proposal body it is always zero: the previous drag is already in the
 * document.
 *
 * The other field is carried unchanged: `movePart` writes position and
 * orientation together, so leaving it out would undo a turn on a slide (and
 * vice versa).
 *
 * `bases` asks the same of every path, since copies of a row need not agree.
 * `base` (the anchor's) is where the gesture starts, so the widget and the part
 * under it do not leap apart; the first step carries every path to that value,
 * and `bases` is the only record of what changed, read by `reportModel`. So
 * during the drag the picture is the anchor's: copies turned differently all
 * stand at the anchor's turn, and on release the interface merges them into
 * one node and, finding no shared turn, straightens them (`hmr:moved` in
 * HammerolaViewer.jsx).
 *
 * `build` is which scene these numbers are about, read at the press because a
 * build landing mid-drag replaces the scene before the report. It is
 * `drawnKey`, not `state.buildKey`: the state field moves when a swap is
 * announced, while `show()` writes `drawnKey` beside the payload once the new
 * geometry is really up, and nothing disarms the tool in between.
 *
 * `body` is the name the panel drew a proposal body under (how the panel finds
 * the node), and also the flag `reportGesture` splits on: a build part has none.
 *
 * The local is `already`, not `stood`, which is the last value a gesture landed.
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
 * The release is the only report: each edit re-stages the bodies (the scene is
 * disposed and rendered again), which must not happen while the reader is
 * still dragging — the same reason `typeProposal`/`commitProposal` commit a
 * typed field only once.
 *
 * A gesture that went nowhere says nothing: for a body `last` starts at zero,
 * so a zero value means the body did not change.
 *
 * Never sent from inside a render, hence the microtask. The report comes back
 * as a re-stage (`setOverlay` → `restage()`, which reads `this.payload`), and a
 * widget's `endDrag` runs inside `show()` after its `await` but before
 * `this.payload = shapes` (element.js). Sent synchronously, the re-stage would
 * read the payload of the build being replaced and paint it back over the new
 * one under the same load token. Deferred, it composes the moved body into the
 * new build.
 *
 * `reportCut` in tools.js stays synchronous: it reads back off the scene still
 * on screen, so a microtask would measure the next one.
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
 * The release is the only report: the interface answers by opening the panel,
 * which reaches `restage()` → `show()`, which ends the gesture (`endDrag`,
 * element.js). A per-step report would tear the press down one step in and
 * freeze the part under the cursor.
 *
 * Every ending raises it (`stop()` in gizmo.js and rings.js): after an
 * interrupted drag the part stands moved in `vp.moved` with no node claiming
 * it, and the next push would send it home.
 *
 * A gesture that changed nothing says nothing, measured against what each path
 * had standing (`bases`), not against zero or the anchor alone: a grab on a
 * copy standing apart from its row carries every sibling to the anchor's value,
 * and coming back to the anchor's start would otherwise read as "nothing
 * happened" while the siblings stand unclaimed.
 *
 * `count` is what moved, reported from here because the viewport knows what the
 * press took hold of, which need not be the interface's current selection.
 *
 * `paths` is every path moved and `id` the first: the interface names the part
 * from one path but must record a displacement for all of them, or the other
 * copies would stand changed with nothing claiming them.
 *
 * `build` is stamped at the press because the microtask can outlive the build:
 * `show()` runs `endGesture` and then dispatches `hmr:model` with no `await`
 * between, so a rebuild mid-drag delivers the model event first. The interface
 * drops a report whose build does not match the one it shows.
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
 * The two meanings part here, on the one field that tells them apart: a
 * proposal body carries the name the panel drew it under, a build part none.
 *
 * The two event names and the field come from the caller. `key` is the field of
 * `vp.moved` the gesture wrote, and the value goes out under that name —
 * `recordGesture(e.detail, 'delta')` in HammerolaViewer.jsx reads it back.
 */
export function reportGesture(vp, rec, { modelEvent, proposalEvent, key }) {
  if (rec.body) reportProposal(vp, rec, proposalEvent, key);
  else reportModel(vp, rec, modelEvent, key);
}
