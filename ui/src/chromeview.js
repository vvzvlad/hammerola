/**
 * The page's chrome: the header, the token control, the tab strip, the view
 * switcher and the floating toolbar — everything round the model that is not a
 * panel about the model.
 *
 * One section of the build page's `computed()`: it takes the page's state, its
 * props and a bag of the page's actions, and returns the keys `render()` draws
 * all of that from.
 *
 * `props` is a separate argument, not part of `deps`, because it is not an
 * action: `commentsOpen` is what the rail falls back to before the reader has
 * chosen, a fact about how the page was mounted.
 *
 * `deps` carries the writers and the two toggles (component methods, since
 * they write its state and push its viewport); `threads`, `openCount`,
 * `revRows` and `downloadGroups`, the other panels' answers drawn by controls
 * up here (the comments button's count, the picker's rows in the header
 * menu); and `narrow`, the layout every panel shares. `popover` and `tab`
 * come from ui/src/panelstyle.js.
 */
import { format, fresh, parse, viewParam } from './address.js';
import { railView } from './comments.jsx';
import { COMMENTABLE, docUrl } from './DocumentView.jsx';
import {
  PAGE, buildKey, buildPath, isPointerPage, mb, projectUrl, shortId, stamp,
} from './hub.js';
import {
  BLANK_BOX, ELLIPSIS, HEADER_BAR, INK, ON_ACCENT, btn, popover, tab,
} from './panelstyle.js';
import { dropMoves, emptyProposal } from './proposal.js';
import { clearToken, writeRetina, writeToken } from './store.js';
import { MONO, SANS } from './style.jsx';
import { BAR_LAYER, DOC_LAYER, documentRows, menuRow, quietBtn } from './viewlist.jsx';
import { variantChoices } from './variants.jsx';

export function chromeView(s, props, deps) {
  const {
    // -- what `computed()` has already worked out; `variant` is the one this
    // page is of (`pageVariant` in hub.js), `arCapable` whether the browser has
    // AR Quick Look (`arSupported` in ar.js)
    meta, viewer, narrow, stop, variant, arCapable,
    // -- the other panels' answers, drawn by controls that live up here
    revRows, downloadGroups, dlShown, threads, openCount,
    // -- the lookups and constants that stay beside the component
    viewPartCount, HOLD_KEY_LABEL, VIEW_TABS_MAX,
    // -- the page's own doors
    set, setState, stateNow, toast, toolsOff, subtitle,
    applyTheme, closeTab, compareRevisions, fitView, saveFrame, showView,
    loadFeed, loadProposal, proposalMoves, proposalOverlay, stageProposal,
    refreshBuilds, cameraParam, pushChoice, openAr,
  } = deps;

  const cmpReady = s.cmp.length === 2;

  // The tool really in force, which is not always `s.tool`: opening a
  // comparison does not disarm one (the three handlers guard themselves via
  // `toolsOff`), so the field can name a tool that cannot fire. Only the hint
  // below reads this; the buttons are drawn from `s.tool === t` so the armed
  // one still shows as armed while out of service and comes back when the
  // panel closes. `cut` is not one of the three: the hold key sections a
  // comparison's scene like any other.
  const armed = toolsOff() && s.tool !== 'cut' ? null : s.tool;

  const setTool = (t) => () => {
    set({ tool: s.tool === t ? null : t, revOpen: false, dlOpen: false, viewsOpen: false, menu: null });
    if (t === 'comment' && s.tool !== 'comment') {
      toast(docCommentable ? COMMENTABLE.get(docOpen.type) : 'Click a spot on the model to pin the task');
    }
    if (t === 'measure' && s.tool !== 'measure') toast('Click a part for its size, or two for the gap between them');
  };

  // Two of these are reachable. `building` and `failed` need a job id this
  // page does not have: `GET /api/v1/jobs/<id>` exists behind EDIT_TOKEN, but
  // nothing tells a build page which job produced it. (The front page shows
  // both words off the draft pointer, which a build page has no equivalent of.)
  const status = s.pending
    ? { text: 'new build ready', style: 'color:var(--accent-text);background:var(--accent-bg);border:1px solid var(--accent-line)', dot: 'var(--accent)' }
    : { text: isPointerPage() ? 'up to date' : 'pinned build', style: 'color:var(--text-soft);background:transparent;border:1px solid transparent', dot: 'var(--ok)' };

  const railOpen = s.rail === null ? props.commentsOpen : s.rail;

  // `|| []` because `computed()` runs over a state built by hand as often as
  // over the constructor's: every test file in ui/tests spells the fields out,
  // and a field added here would otherwise take down the ones written before
  // it existed, at `.length`.
  const openTabs = s.tabs || [];

  // The views this build declares, and the one on screen, read once: the
  // switcher below asks three separate questions of them — how many there
  // are, which is active, what it is called — and three reads of `meta.views`
  // are three chances for the button to name a view the rows disagree with.
  const views = (meta && meta.views) || [];
  const shownView = views.find((v) => v.id === s.view);
  // THE BUILD'S DOCUMENTS, the files its project.json lists to be read: rows of
  // the same list as the views, below them. `docOpen` is the one laid over the
  // model, or null; looked up rather than trusted, so a revision switched to
  // that does not list `s.doc` shows its model.
  const documents = (meta && Array.isArray(meta.documents)) ? meta.documents : [];
  const docOpen = documents.find((d) => d.id === s.doc) || null;
  // A document over the model that takes a comment (`COMMENTABLE`): a place
  // taken on it is the comment's place, which arming the tool says how to take.
  const docCommentable = !!docOpen && COMMENTABLE.has(docOpen.type);
  // Opening a document: what its row does, what `Show in …` of a KiCad
  // design's right-click menu does with the other member's id, and what a
  // markdown link to another document does. A step of history whose address
  // says it as `?d=` (`pushChoice`). Given a schematic's `sheet` — a row of
  // its sheets in the list (`SheetRows` in viewlist.jsx) — the address names
  // that sheet as `s=`, the root none, and the schematic follows it
  // (`followPage` in KicadView.jsx).
  const openDoc = (id, sheet) => {
    setState({ doc: id, viewsOpen: false });
    pushChoice(s.view, id, sheet);
  };
  // The rename window over the page (rename.jsx), opened by a pencil beside
  // the title, a variant's row and a row of the views menu: with the token
  // only, since the hub takes a rename only with it. It starts at the name on
  // screen, and the commit goes on the branch of `variant`, the page's own but
  // for a variant's row. The menus shut under it.
  const askRename = viewer ? null : (subject) => setState({
    rename: subject, viewsOpen: false, variantsOpen: false, revOpen: false, dlOpen: false, tokenPop: false });
  const title = (meta && (meta.title || meta.project)) || '';
  // A document listed `hidden` has no row (viewlist.jsx).
  const docRows = documentRows(documents, docOpen ? docOpen.id : null, openDoc, PAGE.base, buildKey(meta),
    askRename && ((doc) => askRename({ kind: 'document', variant, id: doc.id, name: doc.name })));
  // Whether `View in AR` (`arBtn`) can make a file: where a model view is on
  // screen. A document over the model, a schematic or a board's 3D among them,
  // has none.
  const arShown = !!arCapable && views.length > 0 && !docOpen;

  // The Share window's address and the key it may add, read once: the link
  // text and Copy must say the same thing. `s.share.id` is `latest` or a full
  // commit, never the shortened one a row shows; `latest` is the one of the
  // variant on screen. The key is the hub's own (`files_keys` on builds.json,
  // the variant's); without one the box cannot be ticked.
  const share = s.share || null;
  const shareKeys = (s.builds && s.builds.files_keys) || null;
  const shareKey = share && shareKeys
    && Object.prototype.hasOwnProperty.call(shareKeys, share.id)
    && typeof shareKeys[share.id] === 'string' ? shareKeys[share.id] : '';
  const shareFiles = !!(share && share.files && shareKey);
  // On the view on screen, as every address this page writes (`viewParam` in
  // address.js). A revision without that view opens on its first one, as a
  // fresh load with an unknown `?v=` does. And on the document over it, when
  // one is open: a revision that does not list it opens on the model, as a
  // fresh load with an unknown `?d=` does. With no document open and the
  // Current view box ticked, from the camera's angle too (`cameraParam`), read
  // as this window renders; a document covers the model, so its link carries
  // no frame and the window offers no box. A schematic open on a sheet below
  // its root carries the sheet the address names (`s=`).
  const shareCamera = !!(share && share.camera && !docOpen);
  const shareBox = (on) => 'width:15px;height:15px;border-radius:4px;flex:none;display:flex;'
    + `align-items:center;justify-content:center;font:600 10px ${MONO};`
    + (on ? ON_ACCENT : BLANK_BOX);
  const shareLink = !share ? ''
    : `${location.origin}${format(fresh(buildPath(PAGE.pid, share.id, variant), {
      view: viewParam(s.view, views),
      doc: docOpen ? docOpen.id : null,
      sheet: docOpen ? parse().sheet : null,
      camera: shareCamera ? cameraParam() : null,
      files: shareFiles ? shareKey : null,
    }))}`;

  return {
    // -- the header row ------------------------------------------------------
    //
    // `min-height` rather than `height`, and it wraps: below the breakpoint the
    // mark, title, revision picker and five controls are still wider than a
    // phone, and the root is `overflow:hidden`, so a row that cannot wrap is
    // silently cut off (the comments button would vanish). Same rule as
    // `static/_v/site.css` on the resolver's copy of this header.
    headerStyle: 'min-height:50px;flex:none;display:flex;flex-wrap:wrap;align-items:center;'
      + 'gap:6px 12px;padding:0 16px;'
      + `${HEADER_BAR};position:relative;z-index:30`,

    // WHAT THE HEADER LETS GO OF FIRST, and each of these is chosen because
    // the page still says it somewhere else. The wordmark sits beside a mark
    // that stays and goes on linking home; the subtitle is a description of
    // the build (parts, views, size) and not a control, with the same counts
    // on the view tabs; and the status chip's dot is already on the revision
    // button next to it, while the one status worth interrupting somebody for
    // — a newer build — announces itself with the banner over the model.
    showWordmark: !narrow,
    showSubtitle: !narrow,
    showStatus: !narrow,

    title,
    renameTitle: askRename && (() => askRename({ kind: 'project', variant, name: title })),
    // The title column must be able to shrink, or the title's
    // `text-overflow:ellipsis` never fires and a long model name pushes the row
    // past the window edge. `0 1 auto`: shrink allowed, grow refused, because a
    // title that claimed the leftover room would push the picker away from it.
    titleColStyle: 'display:flex;flex-direction:column;gap:1px;flex:0 1 auto;min-width:0',
    // The variants beside the title (variants.jsx), for every reader: the list
    // needs no token. Null, and nothing drawn, on a project of one variant.
    variantChoices: variantChoices(s.variants, PAGE.pid, variant),
    variantRename: askRename && ((row) => askRename({ kind: 'variant', variant: row.key, name: row.label })),
    variantsOpen: !!s.variantsOpen,
    variantsToggle: stop(() => setState({
      variantsOpen: !s.variantsOpen, revOpen: false, dlOpen: false, viewsOpen: false, tokenPop: false })),
    narrowMenus: narrow,
    subtitle: meta ? subtitle() : '',
    // Shortened: `PAGE.slot` comes straight from the URL, so on a pinned
    // revision it is the full 64-character source digest, too wide for the
    // header row. The picker draws the same value via `shortId`, so the two
    // agree. Pointer names pass through: `dev` is special-cased and `latest` is
    // shorter than the cut.
    slot: shortId(PAGE.slot),
    // The whole of it, for the reader who needs to copy one. A revision is
    // addressed by its full digest everywhere off this page — `hammerola
    // source <rev>`, a permanent URL — and the seven characters above cannot
    // be pasted anywhere. Empty when nothing was cut: a tooltip that repeats
    // the word under the cursor is noise, and `dev` and `latest` are shown
    // whole already.
    slotTitle: shortId(PAGE.slot) === PAGE.slot ? '' : PAGE.slot,
    slotDate: meta ? stamp(meta.built) : '',
    // WITHOUT A TOKEN THE BUTTON IS A LABEL: builds.json is behind the token,
    // so a reader holding a shared link has no list to open and no menu.
    revPicker: !viewer,
    revToggle: viewer ? undefined
      : stop(() => setState({ revOpen: !s.revOpen, dlOpen: false, viewsOpen: false, tokenPop: false, variantsOpen: false })),
    revBtnStyle: 'display:flex;align-items:center;gap:8px;padding:6px 11px;border:1px solid var(--line);background:var(--card-bg);border-radius:6px'
      + (viewer ? '' : ';cursor:pointer'),
    revMenuStyle: popover({
      narrow, anchor: 'left:0;top:40px', width: '430px', radius: '9px', z: 40, open: s.revOpen }),
    revRows,
    revEmpty: revRows.length === 0,
    // SHORTENED, like every other place this site prints a revision. A commit
    // is the digest of its sources (SPEC 7.7), so `s.cmp` holds 64 characters
    // per side and this label is a button in a 430px menu.
    cmpLabel: cmpReady ? `${shortId(s.cmp[0])} → ${shortId(s.cmp[1])}` : '',
    compareBtnStyle: `padding:7px 14px;border-radius:6px;font:600 12px ${SANS};cursor:pointer;` + (cmpReady ? ON_ACCENT : 'background:var(--sunken-bg);color:var(--text-faint);pointer-events:none'),
    startCompare: stop(() => compareRevisions(s.cmp)),

    // -- the Share window, opened from a row of the revision picker ----------
    //
    // Over the whole page, built like the front page's delete confirmation:
    // the overlay, Close and Escape close it, and a click on the card stops
    // there. The row says which address: `latest` gives a link that follows
    // every new build, a revision a link to exactly that one. Ticked, the link
    // carries that address's key and its reader may download the files. The
    // second box, Current view, adds the frame on screen as `c=`; it is off
    // whenever the window opens and absent while a document is open.
    shareOpen: !!share,
    shareHead: !share ? '' : share.id === 'latest' ? 'Share latest' : `Share ${shortId(share.id)}`,
    shareFilesRowStyle: `display:flex;align-items:center;gap:8px;font:400 12px ${SANS};`
      + (shareKey ? 'cursor:pointer;color:var(--text)' : 'cursor:default;color:var(--text-faint)'),
    shareFilesBox: shareBox(shareFiles),
    shareFilesMark: shareFiles ? '✓' : '',
    // Untickable when builds.json came without the keys (the hub could not
    // read its own file, and logged it): a link offering files it cannot open
    // would be a lie.
    shareFilesHint: share && !shareKey ? 'This hub did not send the download keys' : '',
    toggleShareFiles: !shareKey ? undefined
      : () => setState({ share: { ...share, files: !share.files } }),
    shareCameraShown: !!share && !docOpen,
    shareCameraRowStyle: `display:flex;align-items:center;gap:8px;font:400 12px ${SANS};cursor:pointer;color:var(--text)`,
    shareCameraBox: shareBox(shareCamera),
    shareCameraMark: shareCamera ? '✓' : '',
    toggleShareCamera: () => setState({ share: { ...share, camera: !share.camera } }),
    shareLink,
    // `writeText` refuses through its promise (no focus, no permission), and
    // `navigator.clipboard` is missing altogether outside https — both have to
    // end in the failure toast rather than in "copied".
    copyShare: !share ? undefined : () => Promise.resolve()
      .then(() => navigator.clipboard.writeText(shareLink))
      .then(() => toast('link copied'), (error) => {
        console.warn('clipboard', error);
        toast('Could not copy the link');
      }),
    closeShare: () => setState({ share: null }),

    statusChipStyle: `display:flex;align-items:center;gap:7px;padding:6px 11px;border-radius:6px;font:500 11.5px ${SANS};` + status.style,
    statusText: status.text,
    statusDotStyle: `width:8px;height:8px;border-radius:4px;background:${status.dot};flex:none`,

    downloadGroups,
    // NO KEY, NO BUTTON: the hub would refuse every file in the menu.
    dlShown,
    dlToggle: stop(() => setState({ dlOpen: !s.dlOpen, revOpen: false, viewsOpen: false, tokenPop: false, variantsOpen: false })),
    dlBtnStyle: btn(s.dlOpen) + ';border:1px solid var(--line);background:var(--card-bg)',
    // Clamped like the other two: this header button survives the narrow
    // branch, and once the row wraps `right:0` is no longer the window's right
    // edge, so a 250px menu would start off the left of a 390px screen and be
    // cut off by the root's `overflow:hidden`.
    dlMenuStyle: popover({
      narrow, anchor: 'right:0;top:40px', width: '250px', radius: '9px',
      tail: 'padding:6px 0;', z: 40, open: s.dlOpen }),

    // -- the token: the whole customer/viewer split, in one control
    viewer,
    tokenToggle: stop(() => setState({
      tokenPop: !s.tokenPop, tokenDraft: '', revOpen: false, dlOpen: false, viewsOpen: false,
      variantsOpen: false })),
    tokenBtnStyle: btn(false) + ';border:1px solid ' + (viewer ? 'var(--line);background:var(--card-bg)' : 'var(--accent-line);background:var(--accent-bg);color:var(--accent-text)'),
    tokenLabel: viewer ? 'View only' : 'Editing on',
    tokenPopStyle: popover({
      narrow, anchor: 'right:0;top:40px', width: '320px', radius: '10px',
      pad: '13px 14px', z: 40, open: s.tokenPop }),
    tokenDraft: s.tokenDraft,
    tokenType: (e) => setState({ tokenDraft: e.target.value }),
    tokenSave: stop(() => {
      const value = s.tokenDraft.trim();
      if (!value) { toast('Paste the token first'); return; }
      writeToken(value);
      // The queue is behind the same token, so entering one is the moment it
      // can be asked for — from the callback, because `stateNow().token` is
      // still the old one until the update lands.
      //
      // `proposalOff` is cleared too, undoing the other half of `tokenClear`.
      // That action hides the proposal as a default for a reader who stopped
      // being an editor; kept across a round trip it would make `stageProposal`
      // silently refuse the next `add a box`.
      //
      // Staged from the callback for the same reason as the feed: the flag is
      // read inside those actions, so a push before this update landed would be
      // refused by the very value being cleared.
      setState({ token: value, tokenPop: false, tokenDraft: '',
                      proposalOff: false },
                    () => {
                      loadFeed();
                      // AND THE STORED PROPOSAL, which is behind the same
                      // token: this is the second of the two doors the token
                      // arrives through, and `loadProposal` says why there is
                      // no third. From the callback for the reason the feed
                      // is: the request reads `stateNow().token`.
                      loadProposal();
                      // And the revision list, behind the same token.
                      refreshBuilds();
                      stageProposal(stateNow().proposal || emptyProposal());
                    });
      toast('Editing is on in this browser');
    }),
    tokenClear: stop(() => {
      clearToken();
      // The feed goes with it: it was fetched under a token this browser no
      // longer has, and a reader without one may not read the queue at all.
      //
      // The `Add primitive` menu closes too: its button is hidden without a
      // token, like Move, so an open menu would have no way back.
      //
      // The proposal comes off the model through the eye, not a bare
      // `proposalOverlay(null)`: `proposalOff` is the single answer to "is the
      // proposal on the model", and both viewport actions read it. Clearing the
      // overlay alone would leave the flag on, and the first edit through a
      // branch row would call `setProposal` and stage the bodies back.
      //
      // Off because a reader giving up the token can no longer send what the
      // bodies say. The branch stays, so the document can still be read and the
      // eye can put it back: a default, not a permission gate.
      //
      // Both pushes carry their own answer instead of relying on the flag:
      // `setState` has not landed when they run, so the actions would still read
      // the old `proposalOff`. `null` and a document with no moves mean the same
      // on either side of the update, so order does not matter. The moves need
      // the second call because nothing else pushes here; without it displaced
      // parts would stay displaced until a later edit sent a document.
      setState({ token: null, tokenPop: false, tokenDraft: '',
                      composer: null, notePop: null, feed: [],
                      opsOpen: false, settingsOpen: false, proposalOff: true,
                      // The revision list and its menu were read under it too.
                      builds: null, revOpen: false });
      proposalOverlay(null);
      proposalMoves(dropMoves(stateNow().proposal));
      set({ tool: null });
      toast('Token removed — back to viewing');
    }),

    // -- the tree, which on narrow is something you open ---------------------
    //
    // Wide, it floats over a corner of the model and there is room for both.
    // Narrow, it covers the thing it describes — so it starts closed and this
    // button in the header is what opens it. Its openness is state and only
    // state; the constructor says why it is not remembered.
    // Not while two revisions are compared either: the compare panel stands in
    // the tree's place, so the button would open nothing. Nor under a document,
    // which hides the tree with the rest of the model.
    treeShown: !narrow || s.treeOpen,
    treeToggle: stop(() => setState({ treeOpen: !s.treeOpen })),
    treeBtnStyle: btn(false, !narrow || s.compare || !!docOpen) + ';border:1px solid '
      + (s.treeOpen ? 'var(--accent-line);background:var(--accent-bg);color:var(--accent-text)' : 'var(--line);background:var(--card-bg)'),

    // -- the comment rail and the header's button that opens it (comments.jsx)
    ...railView({ open: railOpen, viewer, narrow, threads, openCount, stop, setState }),

    // -- the theme, standing next to the comments ----------------------------
    //
    // In the header, not the floating strip: it changes the whole page, and the
    // strip is not drawn on a phone (`showTools`), where a reader most likely
    // wants the dark theme.
    //
    // Beside the comments button, not inside the rail: the rail is
    // `display:none` while closed and for a reader with no token, while the
    // header row is drawn at every width for every reader and wraps instead of
    // clipping.
    //
    // No `stop()`, unlike the two buttons before it: Parts and Comments open
    // something the same click must not close, this one opens nothing, so the
    // click reaching `rootClick` dismisses a menu left open elsewhere.
    //
    // The label names the current mode, like the access button beside the
    // token; the tooltip names the mode it switches to.
    themeDark: s.theme === 'dark',
    themeLabel: s.theme === 'dark' ? 'Dark' : 'Light',
    themeTitle: s.theme === 'dark'
      ? 'the whole interface is dark — click for light'
      : 'the whole interface is light — click for dark',
    themeBtnStyle: btn(false) + ';border:1px solid var(--line);background:var(--card-bg)',
    toggleTheme: () => applyTheme(s.theme === 'dark' ? 'light' : 'dark'),

    // -- the strip under the header: the projects this browser has been in
    //
    // A row of its own, not part of the 50px header, which already carries a
    // title, a picker, a status chip and four controls.
    //
    // Below two tabs it is not rendered at all: a strip whose only link is the
    // project on screen is noise, and it costs 30px of model.
    //
    // The active tab is derived from the address (`PAGE.pid`) and nothing else,
    // so the highlight cannot disagree with the page (store.js says why).
    // It wraps: ten pills at the 190px cap are close to 2000px and the root is
    // `overflow:hidden`, so a non-wrapping strip would silently lose its tail.
    // Same rule as `static/_v/site.css` on the resolver's header.
    tabsShown: openTabs.length > 1,
    tabsStyle: 'flex:none;display:flex;align-items:center;flex-wrap:wrap;gap:4px;padding:5px 12px;'
      + HEADER_BAR,
    tabs: openTabs.map((t) => ({
      key: t.pid,
      // The pointer-less URL, exactly what a card on the front page links at:
      // a tab is a PROJECT, and which revision of it opens is the reader's own
      // remembered answer rather than this strip's to decide (hub.projectUrl).
      href: projectUrl(t.pid),
      label: t.title,
      // The pill the view switcher is drawn with, so "the one you are on"
      // reads the same way here as it does there rather than in a second
      // visual language invented for one row.
      style: tab(t.pid === PAGE.pid)
        + ';display:flex;align-items:center;gap:7px;max-width:190px;text-decoration:none;color:inherit',
      // Capped and ellipsised like the header's title: a model named after its
      // whole assembly must not be able to push the page wider than the
      // window, and ten of them must not push the strip off the side.
      labelStyle: ELLIPSIS,
      // BOTH CALLS, and `preventDefault` is the one that does the work here:
      // the ✕ sits INSIDE the anchor, so stopping React's synthetic bubbling
      // leaves the browser's own navigation entirely untouched and closing a
      // tab would open it. `stopPropagation` is for the root's click handler,
      // which would take the open menus down under a gesture about neither.
      onClose: (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeTab(t.pid);
      },
    })),

    // Views come from the model's code: as many tabs as it declares.
    //
    // One list, drawn two ways: each entry carries `style` (the pill in the
    // strip) and `rowStyle` (the line in the menu), because which one shows
    // depends only on how many views there are. Building rows only in the
    // branch that shows them would put the switcher's identity in two places.
    viewTabs: views.map((v) => ({
      key: v.id,
      label: v.name,
      hint: `${viewPartCount(v)} parts · ${mb(v.gzip)}`,
      // Cut by an ellipsis rather than widened by its name: when the bar is
      // short of room the strip shrinks (`TAB_STRIP` in viewlist.jsx).
      style: `${tab(s.view === v.id)};min-width:0;${ELLIPSIS}`,
      // The menu's own row, shaped like the tree menu's items (`mi`) rather
      // than like a pill: in a column it is the highlight that says which one
      // is on, and a pill's raised card in a list reads as a stray button.
      // Not lit while a document covers the model.
      rowStyle: menuRow(!docOpen && s.view === v.id),
      // Its pencil in the menu; the strip has one pencil of its own
      // (`renameView` below).
      onRename: askRename && (() => askRename({ kind: 'view', variant, id: v.id, name: v.name })),
      // CLOSES THE MENU WHATEVER `showView` DOES WITH THE CLICK — it returns
      // without touching a thing when the view asked for is the one already
      // on screen, and a menu left standing open on the row you just pressed
      // is a control that ignored you. And puts the model back: a view chosen
      // while a document is open is a request to see the model. On the view
      // already on screen, through `set`: `showView` sends nothing then, and
      // the model the document held back (`sync`) is let go here. On another,
      // `showView` sends it, and a second `hmr:state` before the model is
      // drawn is one the viewport has to ignore (`fetching` in
      // viewport/element.js).
      onClick: () => {
        (s.view === v.id ? set : setState)({ doc: null });
        // A step of history whose address names the view and no document
        // (`pushChoice`).
        pushChoice(v.id, null);
        showView(v.id);
        setState({ viewsOpen: false });
      },
    })),
    // The documents below the views (viewlist.jsx): a row each but for a
    // hidden one. Choosing one lays it over the model (`docOpen`), which stays
    // mounted underneath with its camera, cut and hidden parts; `Show in …` of
    // a KiCad design's right-click menu opens the other member the same way
    // (`onDocOpen`). The choice is a step of history whose address names it as
    // `?d=` (`pushChoice`), which opens it on arrival (`load`), a hidden one too.
    docRows,
    onDocOpen: openDoc,
    // PAST THE THRESHOLD THE STRIP BECOMES ONE BUTTON — see `VIEW_TABS_MAX`
    // for what the strip does to the toolbar when it is too long for it. A
    // build with rows of documents always gets the menu: they are rows of it.
    // So does a page with a hidden document open, which has no row: the strip
    // would light the model's view over a document and name neither.
    viewMenu: views.length > VIEW_TABS_MAX || docRows.length > 0 || !!docOpen,
    // `View in AR` beside Fit (`floatBar` in viewlist.jsx) in a browser with
    // AR Quick Look, null elsewhere. On every view, so the bar keeps its shape
    // (AGENTS.md): out of service where no model view is on screen
    // (`arShown`) and while its file is made. A tap makes the file of the view
    // as it stands and hands it to Quick Look (`openAr`); the title says when
    // the last try failed (`s.ar`).
    arBtn: !arCapable ? null : {
      onClick: arShown && !(s.ar && s.ar.busy) ? () => openAr() : null,
      title: s.ar && s.ar.busy ? 'preparing the AR file…'
        : s.ar && s.ar.failed ? 'the AR file could not be made; tap to try again'
          : 'view the model in AR at 1:1',
    },
    // The strip's one pencil, at its end: it renames the view on screen. One
    // for the whole strip rather than one per pill, so the strip keeps its
    // width and its pills their places from view to view (AGENTS.md).
    renameView: askRename && shownView
      && (() => askRename({ kind: 'view', variant, id: shownView.id, name: shownView.name })),
    // What that button says: the document over the model, else the view on
    // screen. Empty where none matches — `s.view` is null until the first view
    // lands, and a switcher captioned `undefined` is worse than a bare one.
    viewLabel: docOpen ? docOpen.name : shownView ? shownView.name : '',
    // The document laid over the model, or null. Over the WHOLE of the model's
    // area, down to its bottom edge, so nothing drawn for the model shows
    // beside it (the view cube, the "drag — orbit" hint). The layers, while
    // one is open: the overlays about the model under it (the failed-view
    // card 14, the section panel 15); the comment composer, a sibling at the
    // same 16 drawn later, hidden rather than over it (`composerStyle`); the
    // new-build banner over it (`bannerLayerStyle`, 17), because a newer
    // build is news about the documents too; the toolbar over both (18), so
    // the list stays in reach. The bottom padding is the toolbar's strip: the
    // last lines of a page and the end of a PDF's frame stop above the
    // buttons rather than under them.
    docOpen,
    // Its file, which Download takes and Copy link copies (`DocFile` in
    // viewlist.jsx, on the strip left of the bar), from the address
    // DocumentView draws it from; null over the model, which leaves the strip
    // without the two.
    docHref: docOpen ? docUrl(PAGE.base, docOpen) : null,
    bannerLayerStyle: 'position:absolute;left:0;right:0;top:14px;display:flex;justify-content:center;pointer-events:none;z-index:'
      + (docOpen ? '17' : '13'),
    docLayerStyle: DOC_LAYER,
    viewsOpen: !!s.viewsOpen,
    viewsToggle: stop(() => setState({
      viewsOpen: !s.viewsOpen, revOpen: false, dlOpen: false, tokenPop: false, menu: null,
      variantsOpen: false,
      // The other menus in this toolbar, which open upwards from buttons a few
      // pixels along: two of them at once would overlap.
      opsOpen: false, settingsOpen: false })),
    // The toolbar's layer, raised while any of its menus is open so it covers
    // the overlays sharing the model's area — the "This view did not render"
    // card (14), the section panel (15) and the composer (16) — otherwise a
    // click on a covered row lands in the overlay. It stays under the narrow
    // tree rail (20) and the header (30). Closed, it is 12. While a document
    // covers the model it is 18, over the document (16) and over the banner
    // the document lifts to 17 (`docLayerStyle`), so the list that brings the
    // model back opens over both.
    toolbarStyle: BAR_LAYER
      + (docOpen ? '18' : s.viewsOpen || s.opsOpen || s.settingsOpen ? '17' : '12'),
    // At phone width the toolbar keeps the view tabs and Fit, the controls for
    // looking at the model. Measure and Comment want a pointer and room to aim,
    // Frame saves a PNG a phone has nowhere to put, the theme toggle is a
    // preference; the dividers go with them.
    //
    // Move is not on this strip but reads the same flag from its row in
    // `menuItems`: the same gesture wanting the same room.
    //
    // None of these buttons opens a popover, so this narrows only the toolbar.
    // Which popovers are clamped is asserted in `narrow.test.js`, not listed
    // here.
    //
    // A document over the model takes none of them away: the bar is the same
    // on every page and over every view (`toolBar` in viewlist.jsx). The four
    // about the model — Measure, Comment, Add primitive, Settings — are out of
    // service under it, Comment except over a document that takes a comment
    // (`docCommentable`), Fit and Frame unless its view can do them. The
    // document's Download and Copy link (`docHref`) stay on a narrow window.
    showTools: !narrow,
    // Both are out of service while the scene is a comparison's, and under a
    // document, which covers the model — Comment not under one that takes a
    // comment, whose own drawing it pins to. That differs from `viewer`: that one
    // is about who the reader is, this about what is under the cursor.
    // `toolsOff()` documents why it is not `s.compare`. The buttons are the
    // visible half; the handlers stop a tool armed before the panel opened.
    //
    // Move is armed from the object's row menu (`menuItems`), where the reader
    // has already picked the object; its share of `toolsOff` is the `compared`
    // exclusion that row sits inside.
    tMeasure: setTool('measure'),
    measureBtnStyle: btn(s.tool === 'measure', false, toolsOff() || !!docOpen),
    tComment: setTool('comment'),
    commentBtnStyle: btn(s.tool === 'comment', viewer, toolsOff() || (!!docOpen && !docCommentable)),
    // Not one of `s.tool`: the two buttons above arm a canvas gesture, this
    // one drops a menu of primitives and arms nothing. The bodies it adds can be
    // dragged with the Move tool (armed from any row menu), since a staged body
    // is a body in the scene like any other; that drag ends in
    // `hmr:proposalmove` and writes the body's `at`, raising no chip. So it is
    // drawn like its neighbours and lit from its own flag.
    //
    // Built like the view switcher's menu: a page flag, a `stop()`ed toggle
    // that shuts the other menus, a card measured upwards (`viewMenuStyle`
    // says why), and `rootClick`/Escape to dismiss. The rows are `proposalOps`
    // in ui/src/proposalview.js, read off the table that gives each op its size
    // fields.
    //
    // Hidden without a token, like Move and unlike Measure: everything the
    // proposal produces is stored on the hub under that token.
    //
    // Not disabled by a comparison, unlike the other three: `toolsOff` guards
    // tasks filed in the build's terms against a `/cmp/…` scene, and a body
    // added here names no part — it is the reader's claim about a motor or a
    // wall, true over either scene. Out of service under a document, which
    // covers the model it would be added beside.
    //
    // The branch's rows do write `sel`, though: under a comparison the path a
    // body is staged under is the comparison's, so those rows select by the
    // document's own node id (see `path` in `proposalRows`), and `measAdd`
    // refuses such a value by its shape.
    tProposal: stop(() => setState({
      opsOpen: !s.opsOpen, revOpen: false, dlOpen: false, viewsOpen: false,
      settingsOpen: false, tokenPop: false, menu: null, variantsOpen: false })),
    proposalBtnStyle: btn(s.opsOpen, viewer, !!docOpen),
    // The card, drawn like the view switcher's: upwards from the button, no
    // `z-index` (the toolbar is its own stacking context), and no sheet on a
    // narrow window (`showTools` hides the button there, and a `fixed` child of
    // a `contain:layout` element is bound to that element anyway).
    //
    // Narrower because a row is one word, and no height cap because the ops are
    // this page's own table of three, not something a model declares.
    proposalMenuStyle: 'position:absolute;left:0;bottom:38px;width:170px;'
      + 'background:var(--card-bg);border:1px solid var(--line);border-radius:9px;box-shadow:0 10px 34px var(--shadow);padding:6px 0;display:'
      + (s.opsOpen ? 'block' : 'none'),
    // The row the menu draws an op as, shaped like the view switcher's rows —
    // which are shaped like the tree menu's items — except for the MONO, which
    // is the ink the document's own words are printed in everywhere else.
    proposalOpStyle: `display:flex;align-items:center;padding:7px 14px;font:400 11.5px ${MONO};cursor:pointer;`
      + INK,
    // SETTINGS, BUILT EXACTLY AS `Add primitive` IS — a flag of the page's, a
    // `stop()`ed toggle that shuts the other menus, a card measured upwards,
    // `rootClick`/Escape to dismiss — and SHOWN WITHOUT A TOKEN: what it holds
    // is about this browser's screen rather than about the model. Out of
    // service under a document: the resolution it sets is the model's canvas'.
    tSettings: stop(() => setState({
      settingsOpen: !s.settingsOpen, revOpen: false, dlOpen: false, viewsOpen: false,
      opsOpen: false, tokenPop: false, menu: null, variantsOpen: false })),
    settingsBtnStyle: btn(s.settingsOpen, false, !!docOpen),
    // `right:0` AND NOT `left:0`: this is the last button in the bar, so a card
    // measured from its left edge would hang out past the toolbar's end rather
    // than open over it.
    settingsMenuStyle: 'position:absolute;right:0;bottom:38px;width:190px;'
      + 'background:var(--card-bg);border:1px solid var(--line);border-radius:9px;box-shadow:0 10px 34px var(--shadow);padding:6px 0;display:'
      + (s.settingsOpen ? 'block' : 'none'),
    settingsRowStyle: `display:flex;align-items:center;gap:8px;padding:7px 14px;font:400 11.5px ${SANS};cursor:pointer;`
      + INK,
    // The renderer's pixel ratio (viewport/element.js), drawn like the section
    // panel's hatch checkbox. Remembered per browser, like the screen it is
    // about; the viewport hears it through `sync`, which `set` runs.
    toggleRetina: () => {
      set({ retina: !s.retina });
      writeRetina(!s.retina);
    },
    retinaBox: 'width:15px;height:15px;border-radius:4px;flex:none;display:flex;align-items:center;justify-content:center;font:600 10px monospace;'
      + (s.retina ? ON_ACCENT : BLANK_BOX),
    retinaMark: s.retina ? '✓' : '',
    // FIT AND FRAME ACT ON WHAT IS ON SCREEN: the model, or the document over
    // it through what its view told the page it can do (`docTools`, `onTools`
    // in DocumentView.jsx). Over a document whose view cannot — a page of text,
    // a picture, a PDF — both are out of service, and there is no handler to
    // call: the button carries none, as the documents page's does not
    // (`docBar` in DocShell.jsx).
    fitView: docOpen ? (s.docTools ? () => s.docTools.fit() : undefined) : () => fitView(),
    fitBtnStyle: quietBtn(!!docOpen && !s.docTools),
    grabFrame: docOpen ? (s.docTools ? () => saveFrame(s.docTools.frame()) : undefined) : () => saveFrame(),
    frameBtnStyle: quietBtn(!!docOpen && !s.docTools),
    // OFF `armed` AND NOT OFF `s.tool`, so the strip stops instructing the
    // reader to click a model that will not answer: a tool armed before a
    // comparison opened stays armed and stops firing, and this line is the
    // only place on the page that would still have described it as live.
    hintText: armed === 'comment' ? 'click the model to pin a task'
      : armed === 'measure' ? 'click a part, or two, to measure'
      // `it`, not `a part`: the tool arms on a proposal body as readily as on
      // a build part, and the row that armed it already says which.
      //
      // Both halves of the widget in one line, since this is the only place
      // describing the tool while it is in force: it slides and turns.
      //
      // The disc, not the ring: the press is taken by the coloured handle. The
      // arc through it is drawn by `rings.js` but answers no ray, so a press on
      // it falls through to the trackball and orbits.
      //
      // The arrow and the quad likewise: a press on the part itself moves
      // nothing (`viewport/tools.js`) — a drag that starts off the widget
      // orbits. The origin dot takes no press and is left unnamed.
      : armed === 'move' ? 'drag an arrow or a quad to slide, a coloured disc to turn · esc to stop'
      : armed === 'cut' ? 'click a face to place the section plane'
      : `drag — orbit · wheel — zoom · hold ${HOLD_KEY_LABEL} — section`,
  };
}
