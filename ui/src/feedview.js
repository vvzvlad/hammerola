/**
 * The comment rail: the project's whole queue, as `loadFeed` fetched it.
 *
 * One section of the build page's `computed()`. It answers with `threads` and
 * `openCount`, which `chromeView` puts back in the object: the header button
 * that opens the rail wears the count, and a second tally could disagree with
 * the list.
 */
import { anchorFor, rowsByKey, stamp } from './hub.js';
import { ON_ACCENT } from './panelstyle.js';
import { MONO } from './style.jsx';

export function feedView(s, deps) {
  const { meta, catalogue, stop, node: nodeAt, set, resolveComment } = deps;

  // -- the project's comment queue, as `loadFeed` fetched it
  //
  // The hub answers with the project's queue, oldest first (SPEC 7A.2), and the
  // row number is the position in it — the same number `sync` writes on the
  // pin, so the badge on the model and the badge in the rail name the same item.
  //
  // EVERY ROW SAYS WHERE IT HANGS, in words, because most of them cannot be
  // pointed at: a comment left on another revision follows its catalogue key
  // to whatever draws that part today, a comment on a part this view does not
  // draw has no pin at all, and a comment whose part has left the catalogue is
  // ORPHANED — a fact about the model, and the one the reader must not have to
  // infer from a missing pin.
  const anchoredAt = {
    commit: (meta && meta.commit) || null,
    published: (meta && meta.published) || null,
    view: s.view,
    keyRows: rowsByKey(s.tree),
    parts: catalogue || {},
  };
  const threads = s.feed.map((record, i) => {
    const anchor = anchorFor(record, anchoredAt);
    const resolved = record.status === 'resolved';
    // THE HEADING IS A ROW OF THE TREE ON SCREEN or it is the catalogue key,
    // and never the stored path used as a stand-in: on another build that
    // path is a number the tessellator was free to hand to something else.
    const node = anchor.state === 'point'
      ? nodeAt(record.part)
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
    }[anchor.state];
    return {
      key: record.id,
      label: String(i + 1),
      part: (node && node.name) || record.key || '',
      time: stamp(record.created),
      text: record.text,
      says,
      style: 'padding:10px 12px;background:var(--card-bg);border:1px solid ' + (s.activePin === record.id ? 'var(--accent-line)' : 'var(--line)') + ';border-radius:8px;cursor:pointer;' + (resolved ? 'opacity:.62' : ''),
      // Resolved is a lighter grey here than on the canvas on purpose: on a rail
      // card the chip fill is already a visible pill, while `.hmr_pin.is_resolved`
      // sits on the 3D model, where nothing lighter than `--line-strong` keeps a
      // silhouette against a white canvas.
      pinStyle: `width:20px;height:20px;border-radius:10px 10px 10px 3px;flex:none;display:flex;align-items:center;justify-content:center;font:600 10.5px ${MONO};` + (resolved ? 'background:var(--chip-bg);color:var(--text-muted)' : ON_ACCENT),
      // An orphan is the one anchor state that is news about the model rather
      // than about where the pin went, so it is the one that is coloured.
      saysStyle: `margin-top:6px;font:400 10.5px/1.5 ${MONO};color:`
        + (anchor.state === 'orphan' ? 'var(--warn)' : 'var(--text-muted)'),
      onOpen: stop(() => set({ activePin: record.id })),
      resolved,
      // A real request — see resolveComment. Closing an item is mostly the
      // agent's move, but the person who raised it can take it back too.
      onResolve: stop(() => { if (!resolved) resolveComment(record.id); }),
    };
  });
  const openCount = s.feed.filter((c) => c.status !== 'resolved').length;

  return { threads, openCount };
}
