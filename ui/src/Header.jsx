// The header over every build page: the mark, the title, the variants, the
// revision, the status, Downloads, the token, Comments and the theme — one
// menu on a narrow window — and under it the strip of the projects this
// browser has been in. BuildPage.jsx draws it over the model's page
// (HammerolaViewer.jsx) or the documents page (DocShell.jsx); it belongs to
// neither. It reads the page at render (`parts()`, the page's `headerParts()`),
// and a page that changed has BuildPage draw it again (`onHeader`). Its own
// state is its menus, the variants, the tabs and the width; the rest are
// BuildPage's props. A toggle here shuts the page's menus (`shutPage`, the
// page's `closeMenus()`); the page shuts these through `shut()`
// (`shutHeader`); a click on the header that nothing stopped shuts both, and
// Escape these (`onKey`). `headerView` is the values, pure.

import React from 'react';

import { parse } from './address.js';
import BambuLink from './bambu.jsx';
import { COMMENT_ICON, commentsButton } from './comments.jsx';
import CopyLink from './copylink.jsx';
import { downloadsView, filesKeyFor, sequentialDownload } from './downloadsview.js';
import { headMenu, headRow } from './headmenu.jsx';
import { PAGE, isPointerPage, loadVariants, pageVariant, projectUrl } from './hub.js';
import {
  ACCENT_BTN, ELLIPSIS, FILL, HEADER_BAR, HEADER_RULE, ON_ACCENT, RELATIVE, TITLE, WORDMARK, btn, popover, tab,
} from './panelstyle.js';
import { Pencil, RENAME_HOST } from './rename.jsx';
import { revisionView } from './revisionview.js';
import { revisionHead, revisionPicker, revisionRow } from './revisions.jsx';
import { clearToken, forgetTab, readTabs, rememberTab, writeToken } from './store.js';
import { css, Mark, MONO, NARROW, SANS } from './style.jsx';
import { VariantSwitch, variantChoices } from './variants.jsx';

// The icons drawn twice: on the buttons of a wide header and on the rows of the
// header's menu on a narrow one (headmenu.jsx).
const DOWNLOAD_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 1.5v9M4.5 7L8 10.5 11.5 7M2 13.5h12" /></svg>
);
const LOCK_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2.5" y="7" width="11" height="7" rx="1.5" /><path d="M5 7V4.8a3 3 0 0 1 6 0V7" /></svg>
);
const MOON_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M13.4 9.9A5.9 5.9 0 0 1 6.1 2.6 5.9 5.9 0 1 0 13.4 9.9z" /></svg>
);
const SUN_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="3.1" /><path d="M8 1.2v1.7M8 13.1v1.7M1.2 8h1.7M13.1 8h1.7M3.2 3.2l1.2 1.2M11.6 11.6l1.2 1.2M12.8 3.2l-1.2 1.2M4.4 11.6l-1.2 1.2" /></svg>
);

/** The header's menus, all shut. */
export const SHUT = { variantsOpen: false, headMenu: false, tokenPop: false, dlOpen: false, revOpen: false };

/**
 * The header's values. `s` is its state (`Header`), `p` what it is drawn from:
 * `meta`, `token`, `theme` and `builds` (BuildPage's), `parts` (the page's
 * `headerParts()`) and `linkKey`, the key to the files the address carried.
 * `act` holds its doors: `stop`, `setState`, `shutPage`, `onToken(token)`,
 * `onTheme(theme)`, `onRename(subject)`, `closeTab(pid)`, `downloadAll(hrefs)`.
 */
export function headerView(s, p, act) {
  const { meta, token, theme, builds, parts, linkKey } = p;
  const { stop, setState, shutPage, onToken, onTheme, onRename, closeTab, downloadAll } = act;
  const viewer = !token;
  const narrow = !!s.narrow;
  const variant = pageVariant(PAGE, meta);
  const toast = (said) => parts.toast(said);

  // A toggle of one of the header's cards: it shuts the others here and the
  // page's menus, and stops its click, which would shut it again.
  const toggle = (key, extra) => stop(() => {
    setState({ ...SHUT, [key]: !s[key], ...extra });
    shutPage();
  });
  // A row of the narrow menu that calls the page: the page's handler stops its
  // click, so the menu is put down here.
  const andShut = (fn) => (event) => {
    fn(event);
    setState({ headMenu: false });
  };

  // What the chip says of the build on screen. A revision is pinned whoever
  // draws it; a pointer is `up to date` only under a page that watches for a
  // newer build (`parts.watching`, the model page's poll), and under one that
  // does not there is no chip and the dot is neutral. `building` and `failed`
  // need a job id the page does not have: nothing tells a build page which job
  // produced it.
  const calm = 'color:var(--text-soft);background:transparent;border:1px solid transparent';
  const status = parts.pending
    ? { text: 'new build ready', style: 'color:var(--accent-text);background:var(--accent-bg);border:1px solid var(--accent-line)', dot: 'var(--accent)' }
    : !isPointerPage() ? { text: 'pinned build', style: calm, dot: 'var(--ok)' }
      : parts.watching ? { text: 'up to date', style: calm, dot: 'var(--ok)' }
        : { text: '', style: calm, dot: 'var(--text-faint)' };

  // The rename window over the page (rename.jsx), opened by the pencil beside
  // the title and on a variant's row: with the token only, since the hub takes
  // a rename only with it. The pencil stops its click, so the menus shut here.
  const askRename = viewer ? null : (subject) => {
    setState(SHUT);
    shutPage();
    onRename(subject);
  };
  const title = (meta && (meta.title || meta.project)) || '';
  const subtitle = parts.subtitle || '';

  // The revision picker's rows (revisionview.js), from `builds.json`, by the
  // page's doors for a revision (`parts.revisions`). The fallback names what
  // builds.json carries; tests/test_ui_source.py reads it against src/render.py.
  const info = p.builds || { has_dev: false, latest: null, builds: [] };
  const rev = parts.revisions || {};
  const cmp = rev.cmp || [];
  const { revRows, revEmpty } = revisionView({ cmp }, info, {
    stop, commitOf: rev.commitOf, toggleCmp: rev.toggleCmp, pick: rev.pick, href: rev.href,
    share: rev.share && ((id) => {
      setState(SHUT);
      rev.share(id);
    }),
  });

  // The downloads, out of the build's catalogue, its documents and the beds of
  // its views, with the key to the build on screen: the owner's from
  // builds.json, else the one the address carried for this slot.
  const filesKey = filesKeyFor(builds, PAGE.slot, linkKey);
  const { downloadGroups, dlShown } = downloadsView((meta && meta.parts) || null, {
    downloadAll, key: filesKey,
    documents: meta && meta.documents, views: meta && meta.views,
  });

  const comments = parts.comments || null;
  const openTabs = s.tabs || [];

  return {
    // `min-height` rather than `height`, and it wraps: with a long title the row
    // is wider than a window just past the breakpoint, and the root is
    // `overflow:hidden`, so a row that cannot wrap is silently cut off. Below
    // the breakpoint the controls are rows of the header's menu (`headFolded`).
    // Same rule as `static/_v/site.css` on the resolver's copy of this header.
    headerStyle: 'min-height:50px;flex:none;display:flex;flex-wrap:wrap;align-items:center;'
      + 'gap:6px 12px;padding:0 16px;'
      + `${HEADER_BAR};position:relative;z-index:30`,

    // WHAT THE HEADER LETS GO OF ON A NARROW WINDOW, each said elsewhere: the
    // wordmark beside a mark that stays and links home; the subtitle, a
    // description of the build and not a control; the status chip, whose dot is
    // on the revision's row of the menu, while a newer build announces itself
    // with the banner over the model.
    showWordmark: !narrow,
    showSubtitle: !narrow && !!subtitle,
    showStatus: !narrow && !!status.text,

    title,
    renameTitle: askRename && (() => askRename({ kind: 'project', variant, name: title })),
    // The title column must be able to shrink, or its ellipsis never fires and a
    // long name pushes the row past the window. Wide, `1 1 200px` capped at
    // `max-content`: the row keeps one line until the title would be cut below
    // 200px, and then the controls move down as one group (`controlsStyle`).
    // Narrow, `1 1 0`: it takes the room the mark, the variants and the menu's
    // button leave.
    titleColStyle: 'display:flex;flex-direction:column;gap:1px;min-width:0;flex:'
      + (narrow ? '1 1 0' : '1 1 200px;max-width:max-content'),
    subtitle,
    // Downloads, the token, Comments and the theme, one group pushed to the
    // right edge: when the row wraps they go to the second line together.
    // Narrow, the buttons are rows of the menu and the group holds only the
    // sheets, so it lays nothing out.
    controlsStyle: narrow ? 'display:contents'
      : 'display:flex;align-items:center;gap:12px;margin-left:auto;flex:none',

    // The variants beside the title (variants.jsx), for every reader: the list
    // needs no token. Null, and nothing drawn, on a project of one variant.
    variantChoices: variantChoices(s.variants, PAGE.pid, variant),
    variantRename: askRename && ((row) => askRename({ kind: 'variant', variant: row.key, name: row.label })),
    variantsOpen: !!s.variantsOpen,
    variantsToggle: toggle('variantsOpen'),
    narrowMenus: narrow,

    // The menu on a narrow window (headmenu.jsx): the revision, Downloads, the
    // token, the page's own rows (Parts on the model's page), Comments and the
    // theme, in that order. A row that opens something calls the toggle the wide
    // header calls for it, and those toggles put the menu down; the theme's row
    // opens nothing and lets its click reach the header's, which shuts it.
    headFolded: narrow,
    headMenuOpen: !!s.headMenu,
    headMenuToggle: toggle('headMenu'),
    // The revision picker's button, its row of the menu and its card
    // (revisions.jsx), the button's dot in the status's colour.
    ...revisionHead({
      narrow, viewer, open: s.revOpen, built: meta && meta.built, dot: status.dot,
      onToggle: toggle('revOpen'),
    }),
    revRows,
    revEmpty,
    cmpLabel: rev.cmpLabel || '',
    compareBtnStyle: `padding:7px 14px;border-radius:6px;font:600 12px ${SANS};cursor:pointer;`
      + (cmp.length === 2 ? ON_ACCENT : 'background:var(--sunken-bg);color:var(--text-faint);pointer-events:none'),
    startCompare: rev.startCompare && stop(() => rev.startCompare()),
    // The wrappers the downloads and the token hang their cards off. Wide, each
    // holds its button and its card; narrow, the buttons are rows of the menu
    // and the cards sheets along the bottom edge (`popover`).
    headWrapStyle: narrow ? 'display:contents' : RELATIVE,
    tokenRowStyle: headRow(!viewer),
    headRowStyle: headRow(false),

    statusChipStyle: `display:flex;align-items:center;gap:7px;padding:6px 11px;border-radius:6px;font:500 11.5px ${SANS};` + status.style,
    statusText: status.text,

    // Whole-build files, one block per format; NO KEY, NO BUTTON: the hub would
    // refuse every file in the menu.
    downloadGroups,
    dlShown,
    dlToggle: toggle('dlOpen'),
    dlBtnStyle: btn(s.dlOpen) + ';border:1px solid var(--line);background:var(--card-bg)',
    dlMenuStyle: popover({
      narrow, anchor: 'right:0;top:40px', width: '250px', radius: '9px',
      tail: 'padding:6px 0;', z: 40, open: s.dlOpen }),

    // -- the token: the whole customer/viewer split, in one control. Save and
    // Remove write it here; BuildPage hands it down to the header and the page.
    viewer,
    tokenToggle: toggle('tokenPop', { tokenDraft: '' }),
    tokenBtnStyle: btn(false) + ';border:1px solid ' + (viewer ? 'var(--line);background:var(--card-bg)' : 'var(--accent-line);background:var(--accent-bg);color:var(--accent-text)'),
    tokenLabel: viewer ? 'View only' : 'Editing on',
    // What the token opens is the page's to say: each page opens different things.
    tokenHint: parts.tokenHint || '',
    tokenPopStyle: popover({
      narrow, anchor: 'right:0;top:40px', width: '320px', radius: '10px',
      pad: '13px 14px', z: 40, open: s.tokenPop }),
    tokenDraft: s.tokenDraft,
    tokenType: (e) => setState({ tokenDraft: e.target.value }),
    tokenSave: stop(() => {
      const value = s.tokenDraft.trim();
      if (!value) { toast('Paste the token first'); return; }
      writeToken(value);
      setState({ tokenPop: false, tokenDraft: '' });
      onToken(value);
      toast('Editing is on in this browser');
    }),
    // The revision list's card goes with the token: without one the button is
    // a label.
    tokenClear: stop(() => {
      clearToken();
      setState({ tokenPop: false, tokenDraft: '', revOpen: false });
      onToken(null);
      toast('Token removed — back to viewing');
    }),

    // The page's comment values (`railView` in comments.jsx): the button wide,
    // a row of the menu narrow, for a reader with the token.
    comments,
    commentsRow: comments && andShut(comments.railToggle),
    // The page's own rows of the narrow menu: `{key, icon, label, style, onClick}`.
    menuRows: (parts.menuRows || []).map((row) => ({ ...row, onClick: andShut(row.onClick) })),

    // -- the theme, beside the comments: it changes the whole page, and the
    // floating strip is not drawn on a phone, where a reader most likely wants
    // the dark one. Drawn for every reader. No `stop()`: it opens nothing, so
    // its click reaching the header's shuts a menu left open — the header's
    // menu, when the click is on its row. The button is the icon of the mode in
    // force; the tooltip says it in words and the one it switches to.
    themeDark: theme === 'dark',
    themeLabel: theme === 'dark' ? 'Dark' : 'Light',
    themeTitle: theme === 'dark'
      ? 'the whole interface is dark — click for light'
      : 'the whole interface is light — click for dark',
    themeBtnStyle: btn(false) + ';border:1px solid var(--line);background:var(--card-bg)',
    toggleTheme: () => onTheme(theme === 'dark' ? 'light' : 'dark'),

    // -- the strip under the header: the projects this browser has been in.
    // Below two tabs it is not drawn: a strip whose only link is the project on
    // screen is noise. Nor on a narrow window, at the owner's word. The active
    // tab is the address (`PAGE.pid`) and nothing else (store.js says why). It
    // wraps: the root is `overflow:hidden`, so a strip that cannot wrap loses
    // its tail silently. Same rule as `static/_v/site.css`.
    tabsShown: openTabs.length > 1 && !narrow,
    tabsStyle: 'flex:none;display:flex;align-items:center;flex-wrap:wrap;gap:4px;padding:5px 12px;'
      + HEADER_BAR,
    tabs: openTabs.map((t) => ({
      key: t.pid,
      // The pointer-less URL a card on the front page links at: a tab is a
      // PROJECT, and which revision opens is the reader's remembered answer.
      href: projectUrl(t.pid),
      label: t.title,
      // The pill the view switcher is drawn with, so "the one you are on" reads
      // the same way in both rows.
      style: tab(t.pid === PAGE.pid)
        + ';display:flex;align-items:center;gap:7px;max-width:190px;text-decoration:none;color:inherit',
      labelStyle: ELLIPSIS,
      // BOTH CALLS: the ✕ sits INSIDE the anchor, so `preventDefault` is what
      // keeps closing a tab from opening it; `stopPropagation` keeps the click
      // off the header's own, which would shut the menus under it.
      onClose: (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeTab(t.pid);
      },
    })),
  };
}

/**
 * The header. Props: `meta`, `token`, `theme` and `builds` (BuildPage's);
 * `parts()`, the page's `headerParts()`; `onToken(token)` and `onTheme(theme)`,
 * the token and the theme taken; `onRename(subject)`, the rename window opened;
 * `shutPage()`, the page's menus shut. Nothing is drawn before a build.
 */
export default class Header extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      ...SHUT,
      // `variants.json` once it comes (`loadVariants` in hub.js), the token's
      // draft, the strip of projects (seeded on the build's arrival, `arrive`)
      // and whether the window is narrow, read before the first paint.
      variants: null, tokenDraft: '', tabs: [],
      narrow: !!(window.matchMedia && window.matchMedia(NARROW).matches),
    };
    // The key to the files that the ADDRESS carried when the page loaded
    // (`?files=`), with the slot it was carried for (`filesKeyFor`).
    this.linkKey = { slot: PAGE.slot, key: parse().files || '' };
    // The address the downloads' links are built on, which a download chain
    // is cut off when it moves (`componentDidUpdate`).
    this.base = PAGE.base;
    this.dl = null;
    this.mq = null;
    this.gone = false;
    // Widening puts the menu down: the wide header draws none, and a flag left
    // up would bring it back open on the next crossing into narrow.
    this.onNarrow = (event) => this.setState(event.matches ? { narrow: true } : { narrow: false, headMenu: false });
    this.onClick = () => {
      this.shut();
      this.props.shutPage();
    };
    // Escape shuts the header's menus over either page, and is taken when it
    // shut one; the page's own layers are the page's.
    this.onKey = (event) => {
      if (event.key === 'Escape' && this.shut()) event.preventDefault();
    };
  }

  componentDidMount() {
    this.mq = window.matchMedia ? window.matchMedia(NARROW) : null;
    if (this.mq) this.mq.addEventListener('change', this.onNarrow);
    // In the capture phase: a KiCad design under the page listens on the
    // window too and puts its selection out on an Escape nobody took
    // (KicadView.jsx).
    window.addEventListener('keydown', this.onKey, true);
    // The switcher's list, with no token: every reader switches variants.
    loadVariants(PAGE.pid).then((variants) => {
      if (!this.gone) this.setState({ variants });
    });
    if (this.props.meta) this.arrive();
  }

  componentDidUpdate(prev) {
    if (!prev.meta && this.props.meta) this.arrive();
    if (PAGE.base !== this.base) {
      this.base = PAGE.base;
      this.cancelDownloads();
    }
  }

  componentWillUnmount() {
    if (this.mq) this.mq.removeEventListener('change', this.onNarrow);
    window.removeEventListener('keydown', this.onKey, true);
    this.cancelDownloads();
    this.gone = true;
  }

  /** The arrival on the tab strip, recorded with the first build: the first
   *  moment the project has a name. A build swapped in place is the same
   *  project, already on the strip, and recording it would refresh the stamp
   *  of a reader who never left, which is what eviction reads (store.js). */
  arrive() {
    rememberTab(PAGE.pid, this.props.meta.title || this.props.meta.project);
    this.setState({ tabs: readTabs() });
  }

  /** Forget one project, and go nowhere: a tab is a link, the one on screen
   *  too, whose page stays. */
  closeTab(pid) {
    forgetTab(pid);
    this.setState({ tabs: readTabs() });
  }

  /** Shut every menu of the header. -> whether one was open. */
  shut() {
    const open = Object.keys(SHUT).some((key) => this.state[key]);
    if (open) this.setState(SHUT);
    return open;
  }

  /** Every file of one format, handed over one at a time (`sequentialDownload`
   *  in downloadsview.js). One signal for the header: two group links
   *  pressed in a row are both about the same build and end together. */
  downloadAll(hrefs, options) {
    if (!this.dl) this.dl = new AbortController();
    return sequentialDownload(hrefs, { ...(options || null), signal: this.dl.signal });
  }

  /** Stop handing over files: their addresses are `PAGE.base` plus a file
   *  name (`fileHref`), and the page has moved off it or gone. */
  cancelDownloads() {
    if (this.dl) this.dl.abort();
    this.dl = null;
  }

  /** The values the header is drawn from (`headerView`). */
  view() {
    const { meta, token, theme, builds } = this.props;
    return headerView(this.state, {
      meta, token, theme, builds, parts: this.props.parts(), linkKey: this.linkKey,
    }, {
      stop: (fn) => (e) => { e.stopPropagation(); fn(e); },
      setState: (patch) => this.setState(patch),
      shutPage: () => this.props.shutPage(),
      onToken: (value) => this.props.onToken(value),
      onTheme: (value) => this.props.onTheme(value),
      onRename: (subject) => this.props.onRename(subject),
      closeTab: (pid) => this.closeTab(pid),
      downloadAll: (hrefs) => this.downloadAll(hrefs),
    });
  }

  render() {
    if (!this.props.meta) return null;
    const v = this.view();
    return (
      <div onClick={this.onClick} style={css('flex:none')}>
        <div style={css(v.headerStyle)}>
          <a href="/" title="all projects" style={css('display:flex;align-items:center;gap:8px;text-decoration:none;color:inherit')}>
            <Mark />
            {v.showWordmark && <span style={css(WORDMARK)}>hammerola</span>}
          </a>
          <div style={css(HEADER_RULE)} />
          <div style={css(v.titleColStyle)}>
            <div className={v.renameTitle ? RENAME_HOST : undefined}
                 style={css('display:flex;align-items:center;gap:2px;min-width:0')}>
              <div style={css(`${TITLE};min-width:0`)}>{v.title}</div>
              {v.renameTitle && <Pencil title="Rename project" onClick={v.renameTitle} />}
            </div>
            {v.showSubtitle && <div style={css(`font:400 10.5px ${MONO};color:var(--text-muted);white-space:nowrap`)}>{v.subtitle}</div>}
          </div>
          <VariantSwitch choices={v.variantChoices} open={v.variantsOpen}
                         onToggle={v.variantsToggle} narrow={v.narrowMenus} onRename={v.variantRename} />

          {/* The revision, the downloads and the token: each a button with its
              card on a wide window; on a narrow one the button is a row of the
              menu below and the card a sheet. */}
          {revisionPicker(v)}

          {v.showStatus && <div style={css(v.statusChipStyle)}>{v.statusText}</div>}

          <div style={css(v.controlsStyle)}>
            {v.dlShown && (
              <div style={css(v.headWrapStyle)}>
                {!v.headFolded && (
                  <div onClick={v.dlToggle} style={css(v.dlBtnStyle)}>
                    {DOWNLOAD_ICON}
                    Downloads
                  </div>
                )}
                <div style={css(v.dlMenuStyle)}>
                  {v.downloadGroups.map((g) => (
                    <React.Fragment key={g.key}>
                      <div style={css(g.headStyle)}>
                        <span style={css(FILL)}>{g.ext}</span>
                        <span onClick={g.onAll} style={css(g.allStyle)}>download all</span>
                      </div>
                      {g.files.map((f) => (
                        <div key={f.key} style={css(f.rowStyle)}>
                          <a href={f.href} download style={css(f.style)}>
                            <span style={css(FILL)}>{f.label}</span>
                            <span style={css(`font:400 10.5px ${MONO};color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px`)}>{f.file}</span>
                          </a>
                          {f.bambu && <BambuLink href={f.href} style={f.bambuStyle} />}
                          <CopyLink href={f.href} style={f.copyStyle} />
                        </div>
                      ))}
                    </React.Fragment>
                  ))}
                  {v.downloadGroups.length === 0 && (
                    <div style={css(`padding:10px 14px;font:400 11.5px ${SANS};color:var(--text-muted)`)}>
                      This build ships no files to download.
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* access: the token is what turns a viewer into the customer */}
            <div style={css(v.headWrapStyle)}>
              {!v.headFolded && (
                <div onClick={v.tokenToggle} style={css(v.tokenBtnStyle)}>
                  {LOCK_ICON}
                  {v.tokenLabel}
                </div>
              )}
              <div onClick={(e) => e.stopPropagation()} style={css(v.tokenPopStyle)}>
                <div style={css(`font:600 12.5px ${SANS};margin-bottom:4px`)}>
                  {v.viewer ? 'Enter your token' : 'Editing is on'}
                </div>
                <div style={css(`font:400 11.5px/1.6 ${SANS};color:var(--text-soft);margin-bottom:9px`)}>
                  {v.viewer
                    ? v.tokenHint
                    : 'The token is stored in this browser, for the whole site. Remove it to go back to viewing.'}
                </div>
                {v.viewer ? (
                  <>
                    <input type="password" value={v.tokenDraft} onChange={v.tokenType}
                           placeholder="paste the token"
                           style={css(`width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:6px;outline:none;padding:8px 10px;font:400 12px ${MONO};background:var(--card-bg)`)} />
                    <div style={css('display:flex;justify-content:flex-end;margin-top:9px')}>
                      <span onClick={v.tokenSave} style={css(ACCENT_BTN)}>Save</span>
                    </div>
                  </>
                ) : (
                  <div style={css('display:flex;justify-content:flex-end')}>
                    <span onClick={v.tokenClear} style={css(`padding:6px 14px;border:1px solid var(--line);border-radius:6px;font:600 11.5px ${SANS};cursor:pointer;color:var(--danger);background:var(--card-bg)`)}>Remove token</span>
                  </div>
                )}
              </div>
            </div>

            {!v.headFolded && v.comments && commentsButton(v.comments)}

            {/* Light or dark for the whole page, right after the comments, for
                every reader: the one control in the row that belongs to the
                person rather than to what they are allowed to do. */}
            {!v.headFolded && (
              <div onClick={v.toggleTheme} title={v.themeTitle} style={css(v.themeBtnStyle)}>
                {v.themeDark ? MOON_ICON : SUN_ICON}
              </div>
            )}
          </div>

          {v.headFolded && headMenu(v.headMenuOpen, v.headMenuToggle, (
            <>
              {revisionRow(v)}
              {v.dlShown && (
                <div onClick={v.dlToggle} style={css(v.headRowStyle)}>
                  {DOWNLOAD_ICON}
                  Downloads
                </div>
              )}
              <div onClick={v.tokenToggle} style={css(v.tokenRowStyle)}>
                {LOCK_ICON}
                {v.tokenLabel}
              </div>
              {v.menuRows.map((row) => (
                <div key={row.key} onClick={row.onClick} style={css(row.style)}>
                  {row.icon}
                  {row.label}
                </div>
              ))}
              {v.comments && !v.viewer && (
                <div onClick={v.commentsRow} style={css(v.headRowStyle)}>
                  {COMMENT_ICON}
                  Comments
                  <span style={css(v.comments.railCountStyle)}>{v.comments.openCount}</span>
                </div>
              )}
              <div onClick={v.toggleTheme} title={v.themeTitle} style={css(v.headRowStyle)}>
                {v.themeDark ? MOON_ICON : SUN_ICON}
                {v.themeLabel}
              </div>
            </>
          ))}
        </div>

        {/* ── the tab strip: the projects this browser has been in lately ──
            plain links, in the order they were opened, the one matching this
            page's pid drawn as the active pill. */}
        {v.tabsShown && (
          <div style={css(v.tabsStyle)}>
            {v.tabs.map((t) => (
              <a key={t.key} href={t.href} title={t.label} style={css(t.style)}>
                <span style={css(t.labelStyle)}>{t.label}</span>
                {/* A bare span, as every other close control here: a `<button>`
                    inside an `<a>` is not markup a browser has to make sense of. */}
                <span onClick={t.onClose} title="forget this project"
                      style={css('color:var(--text-faint);cursor:pointer;flex:none')}
                >&#10005;</span>
              </a>
            ))}
          </div>
        )}
      </div>
    );
  }
}
