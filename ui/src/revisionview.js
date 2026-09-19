/**
 * The revision picker: the rows of the menu the header's build button opens.
 *
 * ONE SECTION OF `computed()` IN THE BUILD PAGE, LIFTED WHOLE (issue #103). It
 * answers with the two keys the menu is drawn from — `revRows` and `revEmpty` —
 * which `chromeView` puts back in the object, because the menu hangs off a
 * header button and that is where the rest of it is spelled.
 *
 * `info` IS AN ARGUMENT AND NOT READ HERE, and that is not a shape anybody
 * preferred: the fallback it is built from names exactly what builds.json
 * carries, and `tests/test_ui_source.py` reads that object out of
 * HammerolaViewer.jsx as text to check it against what `src/render.py` writes.
 * Lifting the line would take the check with it.
 */
import { PAGE, shortId, stamp } from './hub.js';
import { BLANK_BOX, HIDDEN, IDLE, ON_ACCENT_EDGE } from './panelstyle.js';
import { MONO, SANS } from './style.jsx';

export function revisionView(s, info, deps) {
  const { stop, commitOf, setState, switchBuild } = deps;

  const history = Array.isArray(info.builds) ? info.builds : [];
  const revs = [];
  if (info.has_dev) {
    revs.push({ id: 'dev', head: 'POINTERS', badge: '→ dev slot',
                date: '', message: '', pointer: true });
  }
  if (info.latest) {
    revs.push({ id: 'latest', head: info.has_dev ? '' : 'POINTERS',
                badge: `→ ${shortId(info.latest)}`, date: '', message: '',
                pointer: true });
  }
  history.forEach((b, at) => revs.push({
    id: b.commit, head: at === 0 ? 'BUILDS' : '', badge: '',
    // THE TIME BELONGS HERE, and this is the list that changed its mind about
    // it. `day()` was written for a picker whose rows were CI commits — one or
    // two a day, so the clock was noise beside the date. Publishing is now
    // `hammerola build` from a laptop (issue #26), which an author runs
    // as often as they save; a column of identical `2026-08-27`s then tells a
    // reader nothing about the one thing this menu is for, which is choosing
    // between two of them. So the picker shows the same `stamp` the header
    // does — and shows it in the same shape, which is the second half of the
    // fix: the two were formatted differently while naming the same instant.
    date: stamp(b.built), pointer: false,
    // WHAT THE AUTHOR SAID THIS REVISION IS (issue #67), and the reason this
    // menu can now be read at all: every other thing on the row — twelve hex
    // characters and a timestamp — tells two revisions apart without saying
    // what either one is. Absent on the ones pushed before the field existed
    // and on any push made without `-m`, so it is read as "" and the row is
    // then exactly the row it always was.
    message: typeof b.message === 'string' ? b.message : '',
  }));

  const revRows = revs.map((r) => {
    const current = r.id === PAGE.slot;
    // THE TICK HOLDS THE COMMIT AND NOT THE ROW'S NAME. The hub refuses a
    // pointer as an end of a pair, so `latest` has to be the commit it
    // resolves to before anything is asked — and `dev` resolves to nothing,
    // which is what takes the tick off that row below.
    const commit = commitOf(r.id);
    const inCmp = !!commit && s.cmp.includes(commit);
    return {
      key: r.id,
      head: r.head || '',
      headStyle: r.head ? `padding:7px 14px 3px;font:600 9.5px ${MONO};color:var(--text-muted);letter-spacing:.09em` : HIDDEN,
      id: r.pointer ? r.id : shortId(r.id),
      date: r.date,
      // IN THE PLACE THE SPACER USED TO HOLD, which is what keeps the row one
      // line: it takes the free width between the id and the date, and gives
      // it back by ellipsis when there is more text than room. `title` is the
      // rest of a long one, and a row with no message is the flexible gap the
      // spacer always was.
      message: r.message,
      messageStyle: `flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:400 11.5px ${SANS};color:var(--text-muted)`,
      idStyle: `font:600 12px ${MONO};color:` + (current ? 'var(--accent-text)' : r.pointer ? 'var(--note)' : 'var(--text)'),
      badge: current && !r.badge ? 'viewing' : r.badge,
      badgeStyle: `font:500 10.5px ${MONO};` + (r.pointer ? 'color:var(--text-muted)' : (current || r.badge) ? 'padding:2px 6px;border-radius:4px;background:var(--accent-bg);color:var(--accent-text)' : HIDDEN),
      // THE SOFT TINT AND NOT THE FULL ONE, because this row says "you are
      // here" and the tree's selected row a few pixels away says "you picked
      // this" — two markers the reader tells apart by weight rather than by
      // hue. One tint for both makes the picker shout and takes the
      // difference away; `--accent-bg-soft` is what the row was drawn in
      // before the palette existed, said as a role.
      style: 'display:flex;align-items:center;gap:4px;padding:7px 14px 7px 10px;' + (current ? 'background:var(--accent-bg-soft);' : '') + IDLE,
      // NO TICK ON A ROW THAT NAMES NO COMMIT, which is the `dev` slot and
      // only it. A comparison is cached under the names it was asked with, so
      // both ends have to be permanent addresses, and the slot has none by
      // decision — `has_dev` is a flag, not an id. Offering the tick and
      // failing at the POST would be the same answer given later and as an
      // error; this is it given honestly, on the row. The box keeps its space
      // so that the rows below still line up under one another.
      cmpMark: inCmp ? '✓' : '',
      cmpStyle: `width:16px;height:16px;border-radius:4px;flex:none;margin-right:6px;display:flex;align-items:center;justify-content:center;font:600 10px ${MONO};cursor:pointer;` + (inCmp ? ON_ACCENT_EDGE : BLANK_BOX) + (commit ? '' : ';visibility:hidden;cursor:default'),
      onCmp: !commit ? undefined : stop(() => {
        let picked = s.cmp.includes(commit) ? s.cmp.filter((x) => x !== commit) : s.cmp.concat(commit);
        if (picked.length > 2) picked = picked.slice(-2);
        setState({ cmp: picked });
      }),
      // A build is an ADDRESS, so switching to one is a navigation and not a
      // state change: the URL is the thing that has to keep saying which
      // geometry this is, a year from now, to whoever the link was sent to.
      //
      // THAT IS A SENTENCE ABOUT THE ADDRESS BAR, NOT ABOUT THE DOCUMENT, and
      // reading it as a refusal is what kept this a full page load. There is
      // no wall here: `history.pushState` satisfies every word of it — the URL
      // changes, the link copies and opens exactly as it did, and the page the
      // hub renders at that address on its own is untouched — while the reader
      // keeps the camera, the hidden parts and the section they set up in
      // order to compare two builds (issue #62). Which is the whole
      // point: those get thrown away at precisely the moment they are worth
      // the most. `switchBuild` is where it happens, and a different PROJECT
      // is still a real navigation, because there everything changes at once.
      onPick: stop(() => {
        switchBuild(PAGE.pid, r.id)
          .catch((error) => console.error('switch', error));
      }),
    };
  });

  return { revRows, revEmpty: revRows.length === 0 };
}
