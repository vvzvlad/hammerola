/**
 * The revision picker: the rows of the card the header's revision button opens
 * (revisions.jsx draws them, Header.jsx asks for them).
 *
 * `s.cmp` is the commits the page's ticks hold, and `s.tagsOnly` keeps the
 * history to its tags while it has any (`toggleTags()` flips it, Header.jsx
 * holds it). The doors are the page's
 * (`headerParts().revisions`): on the model's page `pick(id)` swaps the build
 * in place, `commitOf(name)` resolves a row to the commit its tick holds,
 * `toggleCmp(commit)` ticks it and `share(id)` opens the Share window. The page
 * of a build with no model (DocShell.jsx) gives `href(id)` — the address of
 * revision `id` — and nothing else: there a row is a link but the row of the
 * build on screen, and no row carries a tick or a Share icon.
 *
 * `info` is an argument rather than read here because `tests/test_ui_source.py`
 * reads its fallback object out of Header.jsx as text to check it against what
 * `src/render.py` writes to builds.json.
 */
import { PAGE, shortId, stamp } from './hub.js';
import { BLANK_BOX, HIDDEN, IDLE, ON_ACCENT_EDGE } from './panelstyle.js';
import { MONO, SANS } from './style.jsx';

export function revisionView(s, info, deps) {
  const { stop, commitOf, toggleCmp, pick, share, href, toggleTags } = deps;

  const builds = Array.isArray(info.builds) ? info.builds : [];
  // A tag is a revision where the project's version changed (`tag` in
  // builds.json, `Store._tagged`); "Tags only" keeps the history to them.
  const tagged = builds.some((b) => b.tag === true);
  const history = tagged && s.tagsOnly ? builds.filter((b) => b.tag === true) : builds;
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
    // On a tag only: the rows after it until the next tag carry the same one.
    version: b.tag === true && typeof b.version === 'string' ? b.version : '',
  }));

  const revRows = revs.map((r) => {
    const current = r.id === PAGE.slot;
    // THE TICK HOLDS THE COMMIT AND NOT THE ROW'S NAME. The hub refuses a
    // pointer as an end of a pair, so `latest` has to be the commit it
    // resolves to before anything is asked — and `dev` resolves to nothing,
    // which is what takes the tick off that row below.
    const commit = commitOf ? commitOf(r.id) : null;
    const inCmp = !!commit && s.cmp.includes(commit);
    return {
      key: r.id,
      head: r.head || '',
      headStyle: r.head ? `display:flex;align-items:center;padding:7px 14px 3px;font:600 9.5px ${MONO};color:var(--text-muted);letter-spacing:.09em` : HIDDEN,
      // "Tags only", at the end of the BUILDS heading, while a row is a
      // tag: drawn where there is `onTags`.
      onTags: tagged && r.head === 'BUILDS' ? stop(() => toggleTags()) : undefined,
      tagsStyle: `margin-left:auto;padding:2px 7px;border-radius:4px;font:500 10.5px ${SANS};letter-spacing:0;cursor:pointer;user-select:none;border:1px solid `
        + (s.tagsOnly ? 'var(--accent-line);background:var(--accent-bg);color:var(--accent-text)' : 'var(--line);color:var(--text-soft)'),
      id: r.pointer ? r.id : shortId(r.id),
      version: r.version || '',
      // Drawn on a tag only, where `version` is not empty.
      versionStyle: `flex:none;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 5px;border-radius:4px;font:500 10.5px ${MONO};background:var(--chip-bg);color:var(--text-soft)`,
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
      // With no `commitOf` no row has one, and none keeps the space.
      cmpMark: inCmp ? '✓' : '',
      cmpStyle: !commitOf ? HIDDEN : `width:16px;height:16px;border-radius:4px;flex:none;margin-right:6px;display:flex;align-items:center;justify-content:center;font:600 10px ${MONO};cursor:pointer;` + (inCmp ? ON_ACCENT_EDGE : BLANK_BOX) + (commit ? '' : ';visibility:hidden;cursor:default'),
      onCmp: !commit ? undefined : stop(() => toggleCmp(commit)),
      // A build is an address: the URL must keep saying which geometry this is.
      // The model's page changes it with `history.pushState` instead of a page
      // load (`switchBuild`), so the reader keeps the camera, hidden parts and
      // section while comparing builds. With `href` the row is a link instead,
      // and the build on screen's row has none: its click reaches the header's
      // own, which shuts the card.
      onPick: href ? undefined : stop(() => pick(r.id)),
      href: href && !current ? href(r.id) : undefined,
      // The Share window for this row's address: `latest` itself on that row,
      // the full commit on a revision. Not on `dev`, which has no permanent
      // address to give; the icon keeps its space there so rows line up. With
      // no `commitOf` no row has one.
      onShare: !commitOf || r.id === 'dev' ? undefined : stop(() => share(r.id)),
      shareIconStyle: !commitOf ? HIDDEN : 'width:22px;height:22px;flex:none;margin-left:4px;border-radius:4px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);cursor:pointer'
        + (r.id === 'dev' ? ';visibility:hidden;cursor:default' : ''),
    };
  });

  return { revRows, revEmpty: revRows.length === 0 };
}
