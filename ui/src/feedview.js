/**
 * The comment rail: the project's whole queue, as `loadFeed` fetched it.
 *
 * One section of the build page's `computed()`. It answers with `threads` and
 * `openCount`, which `chromeView` puts back in the object: the header button
 * that opens the rail wears the count, and a second tally could disagree with
 * the list.
 */
import { anchorFor, rowsByKey, stamp } from './hub.js';
import { sheetName } from './kicadpages.js';
import { ON_ACCENT } from './panelstyle.js';
import { MONO } from './style.jsx';

/** Where in document `doc` a comment hangs, as the composer heads it and the
 *  rail says it: `<sheet> of <document>` on a schematic's sheet, else the
 *  document's name. */
export const docPlace = (record, doc) => (record.sheet ? `${sheetName(record.sheet)} of ${doc.name}` : doc.name);

export function feedView(s, deps) {
  const { meta, catalogue, stop, node: nodeAt, set, pushChoice, resolveComment } = deps;

  // -- the project's comment queue, as `loadFeed` fetched it
  //
  // The hub answers with the project's queue, oldest first (SPEC 7A.2), and the
  // row number is the position in it. The arrow on the model carries no number:
  // pressing it opens its row here.
  //
  // EVERY ROW SAYS WHERE IT HANGS, in words, because most of them cannot be
  // pointed at: a comment left on another revision follows its catalogue key
  // to whatever draws that part today, a comment on a part this view does not
  // draw has no pin at all, and a comment whose part has left the catalogue is
  // ORPHANED — a fact about the model, and the one the reader must not have to
  // infer from a missing pin.
  const anchoredAt = {
    published: (meta && meta.published) || null,
    view: s.view,
    keyRows: rowsByKey(s.tree),
    nodes: s.tree ? s.tree.nodes : null,
    parts: catalogue || {},
  };
  const documents = (meta && meta.documents) || [];
  const threads = s.feed.map((record, i) => {
    const anchor = anchorFor(record, anchoredAt);
    const resolved = record.status === 'resolved';
    // A comment on a document hangs on the one this build lists at its path.
    const target = anchor.state === 'doc' ? documents.find((d) => d.file === record.doc) : null;
    const near = Array.isArray(record.items) && record.items.length ? ` — near ${record.items.join(', ')}` : '';
    // THE HEADING IS A ROW OF THE TREE ON SCREEN or it is the catalogue key,
    // and never the stored path used as a stand-in: on another build that
    // path is a number the tessellator was free to hand to something else.
    // A point in a part's frame reads under the instance this view draws it on.
    const node = anchor.state === 'point'
      ? nodeAt(anchor.path || record.part)
      : (anchor.state === 'part' ? nodeAt(anchor.path) : null);
    // The sentences claim no cause the record does not carry: `none` covers any
    // null key (`measAdd` and the place handler send one whenever nothing or a
    // group is selected), and the hub may store `view` as null
    // (`validate_payload`), so `elsewhere` names it only when present.
    const says = {
      point: 'left here, on this build',
      part: 'follows the part through the rebuild',
      elsewhere: record.view
        ? `the part is not in this view — left on ${record.view}`
        : 'the part is not in this view',
      orphan: 'the part this was left on is no longer in the catalogue',
      none: 'not tied to a part',
      doc: target ? `on ${docPlace(record, target)}${near}` : 'the document is not in this build',
    }[anchor.state];
    return {
      key: record.id,
      label: String(i + 1),
      part: (node && node.name) || record.key || '',
      time: stamp(record.created),
      text: record.text,
      says,
      style: 'padding:10px 12px;background:var(--card-bg);border:1px solid ' + (s.activePin === record.id ? 'var(--accent-line)' : 'var(--line)') + ';border-radius:8px;cursor:pointer;' + (resolved ? 'opacity:.62' : ''),
      // Only the rail draws a resolved badge: the canvas draws no pin for a
      // processed comment (`sync` in HammerolaViewer.jsx).
      pinStyle: `width:20px;height:20px;border-radius:10px 10px 10px 3px;flex:none;display:flex;align-items:center;justify-content:center;font:600 10.5px ${MONO};` + (resolved ? 'background:var(--chip-bg);color:var(--text-muted)' : ON_ACCENT),
      // An orphan is the one anchor state that is news about the model rather
      // than about where the pin went, so it is the one that is coloured.
      saysStyle: `margin-top:6px;font:400 10.5px/1.5 ${MONO};color:`
        + (anchor.state === 'orphan' ? 'var(--warn)' : 'var(--text-muted)'),
      // And the model comes back from under a document, so the pin it lights
      // is in sight: a step of history naming no document (`pushChoice`), so
      // Back reopens the one it covered. Only over a document the build lists:
      // under any other `d=` the model is already on screen.
      //
      // A comment on a document opens that document instead, as its row in
      // the list of views does — a step of history unless it is on screen —
      // and asks it to show the area (`docFocus`, KicadView.jsx): on its
      // sheet, which is a step of its own only where the document was
      // already on screen (`step`).
      onOpen: stop(() => {
        if (anchor.state === 'doc') {
          if (!target) {
            set({ activePin: record.id });
            return;
          }
          const step = s.doc === target.id;
          if (!step) pushChoice(s.view, target.id);
          set({ activePin: record.id, doc: target.id, docFocus: Array.isArray(record.area)
            ? { doc: target.file, sheet: record.sheet || null, area: record.area, step } : null });
          return;
        }
        if (documents.some((d) => d.id === s.doc)) pushChoice(s.view, null);
        set({ activePin: record.id, doc: null });
      }),
      resolved,
      // A real request — see resolveComment. Closing an item is mostly the
      // agent's move, but the person who raised it can take it back too.
      onResolve: stop(() => { if (!resolved) resolveComment(record.id); }),
    };
  });
  const openCount = s.feed.filter((c) => c.status !== 'resolved').length;

  return { threads, openCount };
}
