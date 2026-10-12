/**
 * The panel that stands where the tree stands while two revisions are compared.
 * Not `compareView`: hub.js already uses that name for the view a comparison
 * is of. This panel draws the comparison report.
 *
 * It reads only the five `cmp*` fields, so it takes three actions
 * (`leaveCompare`, `compareRevisions`, `set`), two pieces of page chrome
 * (`tab`, `stop`) and the readers of the hub's report. `NOT_COMPARED_WHY`
 * stays in HammerolaViewer.jsx because `tests/test_ui_source.py` reads it
 * there as text and checks it against what the hub writes on every
 * `not compared` row.
 */
import { DIFF_COLOURS, shortId } from './hub.js';
import { tab } from './panelstyle.js';
import { MONO, SANS } from './style.jsx';

export function comparePanel(s, deps) {
  const {
    stop,
    compareRows, compareSummary, statusChip, rowReason, mm3,
    NOT_COMPARED, NOT_COMPARED_WHY,
    set, leaveCompare, compareRevisions,
  } = deps;

  // -- the comparison panel, which stands where the tree stands
  //
  // Four states, only one of them a list: waiting for the hub, refused (no
  // token in this browser), failed (with the hub's words), and the report.
  // The first three are a heading and a paragraph; an empty list would read as
  // "nothing changed", which must stay a truthful answer.
  const cmpPair = Array.isArray(s.cmpPair) ? s.cmpPair : [];
  const cmpRows = compareRows(s.cmpReport);
  const cmpDone = s.cmpStage === 'ready';
  const cmpNote = cmpDone ? null
    : s.cmpStage === 'locked'
      ? { head: 'This needs the editing token',
          body: 'A comparison is computed on request, and both of its documents'
            + ' are read under the same token that publishes. Add the token in'
            + ' the header, then press Compare again.' }
      : s.cmpStage === 'failed'
        ? { head: 'The comparison did not finish',
            body: s.cmpError || 'the hub did not say why' }
        : { head: 'Measuring the difference…',
            body: 'The hub is intersecting the two revisions part by part. It'
              + ' takes a second or two once the build queue reaches it.' };

  return {
    // -- comparing two revisions ----------------------------------------------
    cmpA: shortId(cmpPair[0] || ''), cmpB: shortId(cmpPair[1] || ''),
    // A method rather than a closure, because closing the panel has an
    // ADDRESS to put back when this page was opened as a comparison, and that
    // is a paragraph of reasoning rather than a state patch (`leaveCompare`).
    exitCompare: stop(() => leaveCompare()),
    // The three ways of looking at one comparison. Each is one group hidden in
    // the scene (`diffHidden`), so they are `set` like any other viewport
    // state and cost no fetch.
    // Flex with `min-width:0`: two labels carry a revision identifier (up to
    // sixty-four characters), and a flex item does not shrink below its content
    // unless allowed to, so a long one would widen the whole control. The name
    // ellipses, the word beside it does not; `padding:0` because the box
    // centres its own children.
    dsBothStyle: tab(s.diffShow === 'both') + ';flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:4px;padding-left:0;padding-right:0',
    dsAStyle: tab(s.diffShow === 'a') + ';flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:4px;padding-left:0;padding-right:0',
    dsBStyle: tab(s.diffShow === 'b') + ';flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:4px;padding-left:0;padding-right:0',
    // The half of a mode label that may be too long, and the half that must
    // never be dropped: without "only" the three tabs stop naming choices.
    dsNameStyle: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
    dsWordStyle: 'flex:none',
    showBoth: stop(() => set({ diffShow: 'both' })),
    showA: stop(() => set({ diffShow: 'a' })),
    showB: stop(() => set({ diffShow: 'b' })),

    cmpNoteStyle: 'display:' + (cmpNote ? 'block' : 'none'),
    cmpNoteHead: cmpNote ? cmpNote.head : '',
    cmpNote: cmpNote ? cmpNote.body : '',
    cmpRetryStyle: `margin-top:9px;padding:5px 11px;border-radius:6px;font:600 11.5px ${SANS};cursor:pointer;background:var(--accent);color:var(--text-on-accent);display:`
      + (s.cmpStage === 'failed' || s.cmpStage === 'locked' ? 'inline-block' : 'none'),
    retryCompare: stop(() => compareRevisions(s.cmpPair)),

    cmpSummary: cmpDone ? compareSummary(cmpRows) : '',
    cmpSummaryStyle: `font:600 11.5px ${SANS};padding:0 2px 8px;display:`
      + (cmpDone ? 'block' : 'none'),
    cmpRows: cmpRows.map((row) => ({
      key: row.key,
      // The catalogue key is drawn, not a name looked up in this build's
      // catalogue: the compared pair need not include this build, and a `new`
      // part has no entry in the older revision's catalogue. The key is the
      // identity, what the author wrote and what the agent is told about.
      name: row.key,
      status: row.status,
      volume: [row.added > 0 ? `+${mm3(row.added)}` : '',
               row.removed > 0 ? `−${mm3(row.removed)}` : '']
        .filter(Boolean).join(' / ') + (row.added > 0 || row.removed > 0 ? ' mm³' : ''),
      // A column, because a refused part has a second line under it; the
      // first line is the flex row, and the sentence below is `display:none`
      // where there is nothing to say.
      rowStyle: 'padding:4px 6px;border-radius:5px;cursor:pointer;background:'
        + (s.cmpSel === row.key ? 'var(--accent-bg)' : 'transparent'),
      nameStyle: `flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:400 11.5px ${MONO};color:var(--text)`,
      // The chip, and the legend's line about `not compared` wears the same
      // one — see `statusChip`, where the argument for each colour is.
      statusStyle: statusChip(row.status),
      volumeStyle: `flex:none;font:400 10px ${MONO};color:var(--text-muted)`,
      // WHY THE KERNEL WOULD NOT ANSWER FOR THIS PART, in the hub's own words
      // and only where the words are about THIS part (`rowReason`). It wraps
      // rather than being cut to a hint: it names which identity failed and by
      // how much, and half of that is no use.
      reason: rowReason(row),
      reasonStyle: `padding:1px 1px 0;font:400 10.5px/1.45 ${SANS};color:var(--text-muted);display:`
        + (rowReason(row) ? 'block' : 'none'),
      // The other half of "по строке списка можно попасть к детали на модели,
      // и наоборот": this direction writes the key and `comparePaths` turns it
      // into every solid the scene draws it as. The `hmr:pick` handler is the
      // other one.
      onSelect: stop(() => set({ cmpSel: row.key })),
    })),
    // The legend's swatches are the payload's OWN colours (hub.DIFF_COLOURS)
    // and deliberately not palette roles: they are samples of what is on the
    // model, and a sample that followed the theme would stop being one.
    legendAddedStyle: `width:12px;height:12px;border-radius:3px;flex:none;background:${DIFF_COLOURS.added}`,
    legendRemovedStyle: `width:12px;height:12px;border-radius:3px;flex:none;background:${DIFF_COLOURS.removed}`,
    legendNeutralStyle: `width:12px;height:12px;border-radius:3px;flex:none;background:${DIFF_COLOURS.neutral}`,
    // THE WORD IS THE HUB'S AND NOT A LABEL WRITTEN AGAIN HERE: the legend
    // explains the chip the rows wear, so it draws the same chip with the same
    // word in it, and a spelling that drifted from the hub's would be a legend
    // about a status nothing in the list has.
    legendNotCompared: NOT_COMPARED,
    legendNotComparedStyle: statusChip(NOT_COMPARED),
    // THE SENTENCE UNDER THE WORD, out here rather than written into the
    // markup for the reason the word is: it has to agree with what the hub
    // writes on the row (`NOT_COMPARED_WHY`), and an assertion about that is
    // a test rather than a note in two files.
    legendNotComparedWhy: NOT_COMPARED_WHY,
  };
}
