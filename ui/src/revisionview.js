/**
 * The revision picker: the rows of the menu the header's build button opens.
 *
 * One section of the build page's `computed()`. It answers with `revRows` and
 * `revEmpty`, which `chromeView` puts back in the object, because the menu hangs
 * off a header button.
 *
 * `info` is an argument rather than read here because `tests/test_ui_source.py`
 * reads its fallback object out of HammerolaViewer.jsx as text to check it
 * against what `src/render.py` writes to builds.json.
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
    // Date and time, in the same `stamp` shape as the header: an author can
    // publish many builds a day, and a date alone would not tell them apart.
    date: stamp(b.built), pointer: false,
    // What the author said this revision is (`-m`). Absent on older pushes and
    // on any push without `-m`, so it is read as "".
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
      // Takes the free width between the id and the date and ellipsizes, which
      // keeps the row one line; with no message it is just the flexible gap.
      message: r.message,
      messageStyle: `flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:400 11.5px ${SANS};color:var(--text-muted)`,
      idStyle: `font:600 12px ${MONO};color:` + (current ? 'var(--accent-text)' : r.pointer ? 'var(--note)' : 'var(--text)'),
      badge: current && !r.badge ? 'viewing' : r.badge,
      badgeStyle: `font:500 10.5px ${MONO};` + (r.pointer ? 'color:var(--text-muted)' : (current || r.badge) ? 'padding:2px 6px;border-radius:4px;background:var(--accent-bg);color:var(--accent-text)' : HIDDEN),
      // The soft tint, not the full one: this row says "you are here" and the
      // tree's selected row says "you picked this" — two markers told apart by
      // weight rather than hue.
      style: 'display:flex;align-items:center;gap:4px;padding:7px 14px 7px 10px;' + (current ? 'background:var(--accent-bg-soft);' : '') + IDLE,
      // No tick on a row that names no commit (the `dev` slot only): a
      // comparison is cached under the names it was asked with, so both ends
      // must be permanent addresses. The box keeps its space so rows line up.
      cmpMark: inCmp ? '✓' : '',
      cmpStyle: `width:16px;height:16px;border-radius:4px;flex:none;margin-right:6px;display:flex;align-items:center;justify-content:center;font:600 10px ${MONO};cursor:pointer;` + (inCmp ? ON_ACCENT_EDGE : BLANK_BOX) + (commit ? '' : ';visibility:hidden;cursor:default'),
      onCmp: !commit ? undefined : stop(() => {
        let picked = s.cmp.includes(commit) ? s.cmp.filter((x) => x !== commit) : s.cmp.concat(commit);
        if (picked.length > 2) picked = picked.slice(-2);
        setState({ cmp: picked });
      }),
      // A build is an address: the URL must keep saying which geometry this is.
      // `switchBuild` changes it with `history.pushState` instead of a page
      // load, so the reader keeps the camera, hidden parts and section while
      // comparing builds. A different project is still a real navigation.
      onPick: stop(() => {
        switchBuild(PAGE.pid, r.id)
          .catch((error) => console.error('switch', error));
      }),
      // The Share window for this row's address: `latest` itself on that row,
      // the full commit on a revision. Not on `dev`, which has no permanent
      // address to give; the icon keeps its space there so rows line up. The
      // click closes the menus as `rootClick` does, and the window opens
      // without the files.
      onShare: r.id === 'dev' ? undefined : stop(() => setState({
        menu: null, revOpen: false, dlOpen: false, viewsOpen: false,
        opsOpen: false, settingsOpen: false, tokenPop: false,
        share: { id: r.id, files: false },
      })),
      shareIconStyle: 'width:22px;height:22px;flex:none;margin-left:4px;border-radius:4px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);cursor:pointer'
        + (r.id === 'dev' ? ';visibility:hidden;cursor:default' : ''),
    };
  });

  return { revRows, revEmpty: revRows.length === 0 };
}
