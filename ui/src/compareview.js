/**
 * The panel that stands where the tree stands while two revisions are compared.
 *
 * NOT `compareView`, WHICH IS TAKEN: hub.js already spends that name on the
 * view a comparison is OF. This is the panel that draws its report.
 *
 * ONE SECTION OF `computed()` IN THE BUILD PAGE, LIFTED WHOLE (issue #103): the
 * keys `render()` draws the comparison from, with the same values they had
 * while this was a block inside that method.
 *
 * IT ASKS THE STATE AND NOTHING ELSE. Every answer here is a read of the five
 * `cmp*` fields — which pair, which stage, what the hub said, which row is
 * picked — so the bag it takes is three doors out (`leaveCompare`,
 * `compareRevisions`, `set`), two pieces of the page's own chrome (`tab`,
 * `stop`) and the handful of readers of the hub's report
 * that stay beside the component because the legend's own sentence has to:
 * `tests/test_ui_source.py` reads `NOT_COMPARED_WHY` out of
 * HammerolaViewer.jsx as text and holds it against what the hub writes on
 * every `not compared` row.
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
  // FOUR THINGS CAN BE ON THE SCREEN HERE and only one of them is a list:
  // waiting for the hub, a refusal because this browser has no token, a
  // failure with the hub's own words in it, and the report. The first three
  // are one paragraph with a heading — a panel that draws an EMPTY LIST for
  // any of them would be saying "nothing changed", which is one of the
  // answers this block has to be able to give truthfully.
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
    // -- comparing two revisions (issue #10) --------------------------------
    cmpA: shortId(cmpPair[0] || ''), cmpB: shortId(cmpPair[1] || ''),
    // A method rather than a closure, because closing the panel has an
    // ADDRESS to put back when this page was opened as a comparison, and that
    // is a paragraph of reasoning rather than a state patch (`leaveCompare`).
    exitCompare: stop(() => leaveCompare()),
    // The three ways of looking at one comparison. Each is one group hidden in
    // the scene (`diffHidden`), so they are `set` like any other viewport
    // state and cost no fetch.
    // A FLEX BOX AND `min-width:0`, not `text-align:center`. Two of the three
    // labels carry a revision identifier, which is a commit of seven
    // characters or a pointer name of up to sixty-four — and a flex item does
    // not shrink below its own content unless it is told it may, so a long
    // one used to push the whole segmented control wider than the panel. The
    // name inside then ellipses and the word beside it does not; `padding:0`
    // because the box now centres its own children.
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
      // THE CATALOGUE KEY IS WHAT IS DRAWN, and not a name looked up in the
      // build's own catalogue: the pair being compared need not include the
      // build this page is standing on, and a part that is `new` has no entry
      // in the older revision's catalogue at all. The key is the identity
      // (issue #75), it is what the author wrote, and it is what the agent
      // will be told about.
      name: row.key,
      status: row.status,
      volume: [row.added > 0 ? `+${mm3(row.added)}` : '',
               row.removed > 0 ? `−${mm3(row.removed)}` : '']
        .filter(Boolean).join(' / ') + (row.added > 0 || row.removed > 0 ? ' mm³' : ''),
      // A COLUMN, because a refused part has a second line under it. Every
      // other row is one line and looks exactly as it did: the line itself is
      // the flex box that used to be this element, and the sentence below it
      // is `display:none` where there is nothing to say.
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
