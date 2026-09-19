/**
 * The page's chrome: the header, the token control, the tab strip, the view
 * switcher and the floating toolbar — everything round the model that is not a
 * panel about the model.
 *
 * ONE SECTION OF `computed()` IN THE BUILD PAGE, LIFTED WHOLE (issue #103). It
 * takes the page's state, its props and a bag of the page's own doors, and
 * answers with the keys `render()` draws all of that from — the same keys, with
 * the same values, they had while this was a block inside that method.
 *
 * `props` IS ITS OWN ARGUMENT AND NOT PART OF `deps`, because it is not a door:
 * `commentsOpen` is what the rail falls back to before the reader has said
 * anything about it, which is a fact about how this page was mounted rather
 * than a call back into it.
 *
 * WHAT ARRIVES THROUGH `deps`. The writers and the two toggles are methods of
 * the component, because what they write is its state and what they push is its
 * viewport. `threads`, `openCount`, `revRows` and `downloadGroups` are the four
 * panels' own answers, built by the modules beside this one and drawn by
 * controls that live up here — the rail's count on the comments button, the
 * picker's rows inside the header's menu. And `narrow` is the answer every
 * panel on the page shares: which layout this is. What a popover becomes at
 * phone width and how a chosen pill is drawn are `popover` and `tab` in
 * ui/src/panelstyle.js, imported rather than handed over.
 */
import {
  PAGE, isPointerPage, mb, projectUrl, shortId, stamp,
} from './hub.js';
import {
  ELLIPSIS, HEADER_BAR, INK, ON_ACCENT, TAB_OFF, TAB_ON, btn, popover, tab,
} from './panelstyle.js';
import { dropMoves, emptyProposal } from './proposal.js';
import { clearToken, writeToken } from './store.js';
import { MONO, SANS } from './style.jsx';

export function chromeView(s, props, deps) {
  const {
    // -- what `computed()` has already worked out
    meta, viewer, narrow, stop, proposalOn,
    // -- the other panels' answers, drawn by controls that live up here
    revRows, downloadGroups, threads, openCount,
    // -- the lookups and constants that stay beside the component
    viewPartCount, HOLD_KEY_LABEL, VIEW_TABS_MAX,
    // -- the page's own doors
    set, setState, stateNow, toast, toolsOff, subtitle,
    applyTheme, closeTab, compareRevisions, fitView, saveFrame, showView,
    loadFeed, loadProposal, proposalMoves, proposalOverlay, stageProposal,
    toggleProposal,
  } = deps;

  const cmpReady = s.cmp.length === 2;

  // WHICH TOOL IS REALLY IN FORCE DOWN HERE, which is not always `s.tool`:
  // opening a comparison does not disarm one (the three handlers guard
  // themselves instead — `toolsOff`), so the field can name a tool that cannot
  // fire. Only the hint below reads this; the BUTTONS are drawn from
  // `s.tool === t` on purpose, so the one that is armed still shows as armed
  // while it is out of service and comes back armed when the panel closes.
  // `cut` is not one of the three and is left alone: the hold key sections a
  // comparison's scene like any other.
  const armed = toolsOff() && s.tool !== 'cut' ? null : s.tool;

  const setTool = (t) => () => {
    set({ tool: s.tool === t ? null : t, revOpen: false, dlOpen: false, viewsOpen: false, menu: null });
    if (t === 'comment' && s.tool !== 'comment') toast('Click a spot on the model to pin the task');
    if (t === 'measure' && s.tool !== 'measure') toast('Click a part for its size, or two for the gap between them');
  };

  // Two of these are reachable today. `building` and `failed` need a job id
  // this page does not have: `GET /api/v1/jobs/<id>` exists and is behind
  // EDIT_TOKEN, but nothing tells a build page which job produced it. The
  // brief (block 11) asks for all of them; what is missing is that link, not
  // the endpoint. (The front page does show the two words — issue #32 — off
  // the draft pointer, which a build page has no equivalent of.)
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

  return {
    // -- the header row ------------------------------------------------------
    //
    // `min-height` RATHER THAN `height`, AND IT WRAPS. Nothing that could be
    // dropped from this row makes it fit below the breakpoint: what is left —
    // the mark, the title, the revision picker and four controls — is still
    // wider than a phone, and the theme button #35 moved in here is a fifth.
    // A row that cannot break its line can only overflow,
    // and the root this sits in is `overflow:hidden`, so overflowing means
    // silently CUT OFF rather than scrolled: the comment button would simply
    // not be there. It grows a second line instead. Same fix, same reason, as
    // `static/_v/site.css` already makes on the resolver's copy of this header
    // — read the rule there, the argument is written out in full.
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

    title: (meta && (meta.title || meta.project)) || '',
    // THE COLUMN HOLDING THE TITLE HAS TO BE ABLE TO SHRINK, and it could
    // not: `flex:none` stood here, so the item kept its content width whatever
    // the window did, and the `text-overflow:ellipsis` on the title inside it
    // could never fire. A model named after its whole assembly pushed the row
    // past the edge of the window rather than being cut — the failure the
    // ellipsis was written to prevent, with the ellipsis in place.
    // `0 1 auto`: shrink allowed, grow still refused, because a title that
    // claimed the leftover room would push the picker beside it away from it.
    titleColStyle: 'display:flex;flex-direction:column;gap:1px;flex:0 1 auto;min-width:0',
    subtitle: meta ? subtitle() : '',
    // SHORTENED HERE TOO, and this was the one place it was not. `PAGE.slot`
    // is a path segment straight out of the URL, so on a pinned revision it is
    // the full digest of the sources — 64 characters, in a fixed-width header
    // row, next to a title and a status chip that then have nowhere to go. The
    // picker below this button has always drawn the same value at seven
    // (`shortId`), so the header was contradicting the menu it opens. A
    // pointer name passes through unchanged: `dev` is special-cased and
    // `latest` is shorter than the cut.
    slot: shortId(PAGE.slot),
    // The whole of it, for the reader who needs to copy one. A revision is
    // addressed by its full digest everywhere off this page — `hammerola
    // source <rev>`, a permanent URL — and the seven characters above cannot
    // be pasted anywhere. Empty when nothing was cut: a tooltip that repeats
    // the word under the cursor is noise, and `dev` and `latest` are shown
    // whole already.
    slotTitle: shortId(PAGE.slot) === PAGE.slot ? '' : PAGE.slot,
    slotDate: meta ? stamp(meta.built) : '',
    revToggle: stop(() => setState({ revOpen: !s.revOpen, dlOpen: false, viewsOpen: false, tokenPop: false })),
    revBtnStyle: 'display:flex;align-items:center;gap:8px;padding:6px 11px;border:1px solid var(--line);background:var(--card-bg);border-radius:6px;cursor:pointer',
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

    statusChipStyle: `display:flex;align-items:center;gap:7px;padding:6px 11px;border-radius:6px;font:500 11.5px ${SANS};` + status.style,
    statusText: status.text,
    statusDotStyle: `width:8px;height:8px;border-radius:4px;background:${status.dot};flex:none`,

    downloadGroups,
    dlToggle: stop(() => setState({ dlOpen: !s.dlOpen, revOpen: false, viewsOpen: false, tokenPop: false })),
    dlBtnStyle: btn(s.dlOpen) + ';border:1px solid var(--line);background:var(--card-bg)',
    // CLAMPED LIKE THE OTHER TWO. This one is a HEADER button and survives
    // everything the narrow branch drops, so its menu is reachable on a phone
    // — and `right:0` is measured from a button that, once the row has
    // wrapped, is no longer at the window's right edge: a 250px menu then
    // starts off the left of a 390px screen and is cut off by the root's
    // `overflow:hidden` with nothing to scroll.
    dlMenuStyle: popover({
      narrow, anchor: 'right:0;top:40px', width: '250px', radius: '9px',
      tail: 'padding:6px 0;', z: 40, open: s.dlOpen }),

    // -- the token: the whole customer/viewer split, in one control
    viewer,
    tokenToggle: stop(() => setState({
      tokenPop: !s.tokenPop, tokenDraft: '', revOpen: false, dlOpen: false, viewsOpen: false })),
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
      // AND THE PROPOSAL COMES BACK ON THE MODEL, which is the other half of
      // what `tokenClear` did and has to be undone in the same breath. That
      // door shuts the eye as a DEFAULT for a reader who has stopped being an
      // editor; left standing across a round trip it stops being a default and
      // becomes a trap, because nothing connects it to the gesture that caused
      // it. The reader hands the token back, presses `add a box`, and the model
      // does not change — `stageProposal` would reach `proposalOverlay` and be
      // turned away by a flag set before they left.
      //
      // STAGED FROM THE CALLBACK for the same reason the feed is: the flag is
      // read inside those doors, so a push made before this update landed would
      // be refused by exactly the value being cleared.
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
                      stageProposal(stateNow().proposal || emptyProposal());
                    });
      toast('Editing is on in this browser');
    }),
    tokenClear: stop(() => {
      clearToken();
      // The feed goes with it: it was fetched under a token this browser no
      // longer has, and a reader without one may not read the queue at all.
      //
      // AND THE PROPOSAL PANEL, which is HIDDEN WITHOUT A TOKEN like Move
      // — everything it produces leaves this page as a comment. Left open it
      // is a panel the button no longer offers to reopen, with `add to
      // comment` gone from under it.
      //
      // AND THE PROPOSAL COMES OFF THE MODEL, THROUGH THE EYE — which is a
      // different thing from the bare `proposalOverlay(null)` that stood here,
      // and the difference is a state machine that cannot disagree with
      // itself. `proposalOff` is now the one answer to "is the proposal on the
      // model", and both doors to the viewport read it. Cleared by hand
      // instead, the overlay went off while that flag still said it was on —
      // and since the branch now survives this (it is drawn on the document
      // alone), the first edit through any of its rows called `setProposal`
      // and staged the bodies straight back onto a model this had just
      // cleared.
      //
      // WHY OFF AT ALL, given the panel is what carries the token: the reader
      // is giving up the right to edit, and a body standing over the model is
      // a statement they can no longer send. THE BRANCH STAYS, so the document
      // is still there to be read and the eye is still there to put it back —
      // this is a default and not a lock, which is the honest shape for it:
      // nothing here is a permission gate, and pretending otherwise would be
      // the invented adversary AGENTS.md warns about.
      //
      // BOTH PUSHES CARRY THEIR OWN ANSWER rather than leaning on the flag
      // they just set: `setState` has not landed when these run, so the doors
      // would still read the old `proposalOff` and push the proposal back
      // down. `null` and a document with no moves in it mean the same thing on
      // either side of that update, which is what makes the order not matter.
      // The moves need the second call at all because nothing else pushes
      // here, and without it the displaced parts would stand where they are
      // until some later edit happened to send a document.
      setState({ token: null, tokenPop: false, tokenDraft: '',
                      composer: null, notePop: null, feed: [],
                      proposalOpen: false, proposalOff: true });
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
    // AND NOT WHILE TWO REVISIONS ARE BEING COMPARED, which is the other way
    // the tree can be absent: the compare panel stands in its place, so the
    // button would be offering to open something the page is not drawing
    // either way.
    treeShown: !narrow || s.treeOpen,
    treeToggle: stop(() => setState({ treeOpen: !s.treeOpen })),
    treeBtnStyle: btn(false, !narrow || s.compare) + ';border:1px solid '
      + (s.treeOpen ? 'var(--accent-line);background:var(--accent-bg);color:var(--accent-text)' : 'var(--line);background:var(--card-bg)'),

    railToggle: stop(() => setState({ rail: !railOpen })),
    railBtnStyle: btn(false) + ';border:1px solid var(--line);background:var(--card-bg)' + (viewer ? ';display:none' : ''),
    // WHAT SEPARATES THE TWO STATES IS TONE, NOT INK CONTRAST, and saying so
    // plainly is the only honest version. White on `--accent` is 4.27:1 in
    // both themes and cannot be raised without moving the accent itself, so
    // the live pill is not the high-contrast one; and the resting pill
    // cannot be "the faint version" of it either, because a grey that looks
    // faint on a light page is a grey that stands out on a dark one. What
    // does carry across both themes and reads at 17px is the disc turning
    // BLUE — so that is the signal, and each state simply gets an ink its
    // own fill can be read with.
    //
    // WHICH MEANS THE RESTING PILL IS AN ORDINARY CHIP: the neutral chip
    // fill with the secondary ink on it, `--text-soft` on `--chip-bg` —
    // 6.51:1 in light, 8.36:1 in dark. It reads as a count at rest in both.
    //
    // IT WAS `--line-strong` UNDER WHITE, a line role spent as a fill on the
    // strength of a number measured in the light theme alone: white on light
    // `--line-strong` is 1.68:1, which is not "faint" but illegible, and on
    // the dark value it is 9.89:1 — so the resting pill came out CLEARER
    // than the live one, exactly backwards, in half the interface.
    railCountStyle: 'min-width:17px;height:17px;padding:0 5px;border-radius:9px;'
      + (openCount ? ON_ACCENT
                   : 'background:var(--chip-bg);color:var(--text-soft)')
      + `;display:flex;align-items:center;justify-content:center;font:600 10px ${MONO}`,
    openCount,
    // A COLUMN BESIDE THE MODEL, OR A SHEET OVER IT. 300px taken out of the
    // width is a third of a phone's screen, and what is left is the thing the
    // page exists to show — so on narrow the rail stops being a column and
    // covers the body instead, the way the tree already does. It is the same
    // panel either way: it opens and closes by the same button and holds the
    // same threads.
    railStyle: (narrow ? 'position:absolute;inset:0;z-index:20' : 'width:300px;flex:none')
      + ';background:var(--header-bg);border-left:1px solid var(--line);display:'
      + (railOpen && !viewer ? 'flex' : 'none') + ';flex-direction:column;min-height:0',
    threads,

    // -- the theme, standing next to the comments ----------------------------
    //
    // WHERE THE ISSUE PUTS IT, in as many words: «кнопка — жить у
    // комментариев» (#35). It used to sit in the floating strip under the
    // model, with Measure and Fit, and that was right while it changed the
    // CANVAS and nothing else. It changes the whole page now, so the strip
    // that belongs to the viewport is the wrong drawer for it — and it is the
    // one part of this page a phone does not draw at all (`showTools`), which
    // is how a page-wide preference came to be unreachable at the width where
    // a reader is most likely to want the dark one.
    //
    // BESIDE THE COMMENTS BUTTON AND NOT INSIDE THE RAIL, which is the half
    // of that instruction worth writing down rather than deciding twice. The
    // rail is `display:none` two ways over — while it is closed, and for a
    // reader with no token at all — so a control living IN it would be a
    // preference you reach by opening a panel you may not even have. The
    // header row holds the comments control itself, wraps instead of being
    // clipped, and is drawn at every width and for every reader: the button
    // stands next to the comments and stays reachable.
    //
    // NO `stop()`, unlike the two buttons before it — this one is last in the
    // row and nothing follows it. Parts and Comments each open
    // something and must not have the same click close it again; this one
    // opens nothing, so letting the click reach `rootClick` is what makes a
    // press over here dismiss a menu left open over there.
    //
    // THE LABEL NAMES THE MODE THE READER IS IN, the way the access button
    // beside the token does; what it switches to is in the tooltip.
    themeDark: s.theme === 'dark',
    themeLabel: s.theme === 'dark' ? 'Dark' : 'Light',
    themeTitle: s.theme === 'dark'
      ? 'the whole interface is dark — click for light'
      : 'the whole interface is light — click for dark',
    themeBtnStyle: btn(false) + ';border:1px solid var(--line);background:var(--card-bg)',
    toggleTheme: () => applyTheme(s.theme === 'dark' ? 'light' : 'dark'),

    // -- the strip under the header: the projects this browser has been in
    //
    // A ROW OF ITS OWN and not part of the 50px header above, which is already
    // carrying a title, a picker, a status chip and four controls.
    //
    // BELOW TWO IT IS NOT DRAWN AT ALL — not drawn `display:none`, but absent:
    // a strip whose only link is the project already on screen is noise with a
    // border round it, and the row it would occupy is 30px off the model.
    //
    // WHICH ONE IS ACTIVE IS ASKED OF THE ADDRESS, `PAGE.pid`, and of nothing
    // else. Nothing stores it and no state here holds it, so the highlighted
    // pill cannot disagree with the page it is drawn on (store.js says why).
    // IT WRAPS, and that is not a detail. Ten pills at the 190px cap below,
    // with their gaps and this padding, is close to 2000px — wider than the
    // window this interface is drawn for, and the root above is
    // `overflow:hidden`. A row that cannot break its line can only overflow,
    // and overflowing under `overflow:hidden` means silently CUT OFF rather
    // than scrolled: the eleventh project this browser opened would evict the
    // coldest tab, and the reader would watch a strip that never changed. It
    // is the same failure `static/_v/site.css` fixed on the resolver's own
    // header, and it is fixed here the same way — wrap, so a full strip grows
    // a second row instead of losing its tail.
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
    // ONE LIST, DRAWN TWO WAYS. Each entry carries both dresses — `style` is
    // the pill the strip draws it as, `rowStyle` the line the menu draws it
    // as — because which of the two is on screen is a question about how MANY
    // views there are and about nothing else. Building the rows only in the
    // branch that shows them would put the view switcher's identity in two
    // places, free to disagree about which view is the one you are on.
    viewTabs: views.map((v) => ({
      key: v.id,
      label: v.name,
      hint: `${viewPartCount(v)} parts · ${mb(v.gzip)}`,
      style: tab(s.view === v.id),
      // The menu's own row, shaped like the tree menu's items (`mi`) rather
      // than like a pill: in a column it is the highlight that says which one
      // is on, and a pill's raised card in a list reads as a stray button.
      rowStyle: `display:flex;align-items:center;gap:10px;padding:7px 14px;font:400 12px ${SANS};cursor:pointer;`
        + (s.view === v.id ? 'color:var(--accent-text);background:var(--accent-bg)' : INK),
      // CLOSES THE MENU WHATEVER `showView` DOES WITH THE CLICK — it returns
      // without touching a thing when the view asked for is the one already
      // on screen, and a menu left standing open on the row you just pressed
      // is a control that ignored you.
      onClick: () => { showView(v.id); setState({ viewsOpen: false }); },
    })),
    // PAST THE THRESHOLD THE STRIP BECOMES ONE BUTTON — see `VIEW_TABS_MAX`
    // for what the strip does to the toolbar when it is too long for it.
    viewMenu: views.length > VIEW_TABS_MAX,
    // What that button says: the view on screen. Empty where none matches —
    // `s.view` is null until the first view lands, and a switcher captioned
    // `undefined` is worse than a bare one.
    viewLabel: shownView ? shownView.name : '',
    // A view's name is the model's own sentence and can be any length; the
    // button is in a toolbar that must not grow past the window (`viewBtnStyle`
    // caps it), so the name is cut rather than allowed to push.
    viewLabelStyle: ELLIPSIS,
    viewsToggle: stop(() => setState({
      viewsOpen: !s.viewsOpen, revOpen: false, dlOpen: false, tokenPop: false, menu: null })),
    viewBtnStyle: `display:flex;align-items:center;gap:7px;padding:5px 11px;border-radius:5px;font:500 12px ${SANS};cursor:pointer;max-width:220px;`
      + (s.viewsOpen ? TAB_ON : TAB_OFF),
    // OPENS UPWARDS, unlike every other popover on this page: the toolbar it
    // hangs off floats at the BOTTOM of the model, so a menu measured from
    // the top of its button would be drawn off the bottom edge of the window.
    //
    // WHICH MAKES `bottom:38px` A MEASUREMENT AND NOT A TASTE, since the
    // offset is counted up from the button rather than down from anything:
    // the button is about 25px tall (a 12px line box and 5px of padding
    // either side), the toolbar adds its 4px of padding and 1px border, and
    // the rest is the air between the two cards. It moves with
    // `viewBtnStyle` — grow the button and this has to grow with it, or the
    // menu comes down on top of the control that opened it.
    //
    // AND IT IS THE ONE POPOVER THAT TAKES NO SHEET ON A NARROW WINDOW. The
    // toolbar carries `backdrop-filter:blur(10px)`, and a `backdrop-filter`
    // makes the element a containing block for descendants positioned `fixed`
    // AS WELL AS `absolute` (CSS Filter Effects 2, §2.1) — so `popSheet` would
    // resolve its `left`/`right`/`bottom` against the TOOLBAR's box rather
    // than the window, and the "sheet" would come up over the button that
    // opened it. Nor does it need the clamp the header's panels need: this
    // toolbar is always centred on the bottom edge, and on a narrow window it
    // is this button and Fit and nothing else, so 260px measured from the
    // button's left edge is inside a 320px window.
    //
    // NO `z-index`, deliberately: the toolbar is its own stacking context for
    // the same reason, so any value here only sorts this menu against the
    // toolbar's other children. What has to move is the CONTAINER —
    // `toolbarStyle` below.
    //
    // HEIGHT CAPPED like the revision menu's list, because the count here is
    // the model's to choose: a model may declare twenty views, and the root
    // this page lives in is `overflow:hidden` — a menu taller than the window
    // is not scrolled, it is cut off, with the rows past the cut unreachable.
    viewMenuStyle: 'position:absolute;left:0;bottom:38px;width:260px;max-height:308px;overflow:auto;'
      + 'background:var(--card-bg);border:1px solid var(--line);border-radius:9px;box-shadow:0 10px 34px var(--shadow);padding:6px 0;display:'
      + (s.viewsOpen ? 'block' : 'none'),
    // THE LAYER THE WHOLE TOOLBAR SITS ON, raised for as long as the menu is
    // open. While it is, the toolbar has to cover the overlays that share the
    // model's area with it — the "This view did not render" card (14), the
    // section panel (15) and the composer (16) — or a click on a row one of
    // them covers lands in the overlay instead. It stays UNDER the tree rail
    // on a narrow window (20) and under the header (30), which are the two
    // things that are allowed to cover the toolbar. Closed, it is 12 again,
    // so nothing else on the page ever sees a different order.
    toolbarStyle: 'position:absolute;left:0;right:0;bottom:12px;display:flex;justify-content:center;pointer-events:none;z-index:'
      + (s.viewsOpen ? '17' : '12'),
    // WHAT THE TOOLBAR KEEPS WHEN IT IS THE WIDTH OF A PHONE: the view tabs
    // and Fit, which are the two controls about LOOKING at the model. The
    // rest goes — Measure and Comment are gestures that want a pointer and a
    // canvas with room to aim in, Frame saves a PNG a phone has nowhere to
    // put, and the theme toggle is a preference rather than a step. The
    // dividers go with them: three rules with nothing left between them.
    //
    // MOVE IS NOT ON THIS STRIP and goes narrow all the same, out of its own
    // row in `menuItems`: it is the same gesture wanting the same room, and
    // the flag it reads is this one.
    //
    // IT TAKES AWAY NO POPOVER, and this once said the opposite — it read as
    // the reason some of this page's popovers needed clamping and others did
    // not. None of the buttons above opens one, so dropping them narrows
    // nothing but the toolbar itself.
    //
    // WHICH POPOVERS ARE CLAMPED IS NOT WRITTEN DOWN HERE, and that is on
    // purpose: this comment has carried a count of them twice and been wrong
    // both times, because a sentence cannot be re-checked when a panel is
    // added. `narrow.test.js` names the clamped ones and asserts it — the
    // list lives there, where it can fail.
    showTools: !narrow,
    // AND BOTH ARE OUT OF SERVICE WHILE THE SCENE IS A COMPARISON'S, which is
    // a different question from the `viewer` beside it: that one is about who
    // the reader IS, this one about what is under the cursor. What each tool
    // filed against a comparison, and why the answer is `toolsOff()` rather
    // than `s.compare`, is written out on the method. The buttons are the half
    // a person sees; the handlers are the half that stops a tool armed before
    // the panel opened.
    //
    // MOVE IS NOT A BUTTON HERE ANY MORE: it is armed from the object's own
    // row menu (`menuItems`), which is where the reader has already said WHICH
    // object the drag is about. Its share of `toolsOff` is the `compared`
    // exclusion that row sits inside.
    tMeasure: setTool('measure'),
    measureBtnStyle: btn(s.tool === 'measure', false, toolsOff()),
    tComment: setTool('comment'),
    commentBtnStyle: btn(s.tool === 'comment', viewer, toolsOff()),
    // NOT ONE OF `s.tool`, and that is the whole difference between this
    // button and the two above it. Those two ARM A GESTURE on the canvas
    // and the viewport is told which one; this one opens a panel of number
    // fields and arms nothing of its own. The bodies it stages CAN be dragged
    // — under the MOVE tool, armed from any part's row menu, because a staged
    // body is a body in the scene like any other and one tool for moving
    // things is better than two. What that drag means is the panel's business:
    // it ends in `hmr:proposalmove` and writes the body's `at`, raising no
    // chip. So this button is drawn like its neighbours and lit from its own
    // flag.
    //
    // HIDDEN WITHOUT A TOKEN, like Move and unlike Measure: everything the
    // proposal produces leaves this page as a comment, which is behind the
    // token, so a reader who cannot comment has nowhere to send it.
    //
    // AND ABSENT — not hidden — ON A HUB THAT DID NOT ASK FOR THE PANEL. That
    // is a DIFFERENT KIND of gate from the token above, and the difference is
    // who is being answered: the token is about this READER, who cannot use a
    // feature the hub does serve, and `display:none` is the right answer to
    // it. The flag is about this HUB, which never asked for the feature at
    // all (`proposalPanelOn`, decided before the page was sent) — and the right
    // answer to that is no markup, so the button and the panel are wrapped in
    // `v.proposalOn` in `render` and the styles below say nothing about it.
    //
    // AND NOT TAKEN OUT OF SERVICE BY A COMPARISON, unlike all three. What
    // `toolsOff` guards is a task filed in the BUILD's terms against a scene
    // that is not the build — a `/cmp/…` path in `partId`. This panel's own
    // door posts no path at all (`proposalAdd` sends `partId: null`), and the
    // body it describes is the reader's own claim about a motor or a wall,
    // which is as true over a comparison as over a build.
    //
    // THE ROWS DO WRITE `sel`, THOUGH, and that is where the same hazard
    // would have got in by another road: a row of the proposal's branch
    // selects the path its body is staged under, and under a comparison that
    // path is the comparison's. So those rows select by the DOCUMENT's own
    // node id while one is up — the reasoning is on `path` in `proposalRows`,
    // and `measAdd` refuses such a value by its shape.
    tProposal: () => toggleProposal(),
    // THE FLAG ITSELF, because `render` is where it is spent: it decides
    // whether these two nodes exist, not how they look.
    proposalOn,
    proposalBtnStyle: btn(s.proposalOpen, viewer, false),
    fitView: () => fitView(),
    grabFrame: () => saveFrame(),
    // OFF `armed` AND NOT OFF `s.tool`, so the strip stops instructing the
    // reader to click a model that will not answer: a tool armed before a
    // comparison opened stays armed and stops firing, and this line is the
    // only place on the page that would still have described it as live.
    hintText: armed === 'comment' ? 'click the model to pin a task'
      : armed === 'measure' ? 'click a part, or two, to measure'
      // `it` and not `a part`: this tool is armed on a body of the proposal
      // just as readily as on a part of the build, and the row that arms it
      // already says which of the two the reader is in.
      //
      // AND BOTH HALVES OF THE WIDGET IN ONE LINE, because there is one tool
      // now and this is the only place on the page that describes it while it
      // is in force. `drag it` alone was true and incomplete — it slides and
      // says nothing about turning — and the `turn` line that used to stand
      // under this one described the other half of the same widget as though
      // it were a second tool. A reader told half of it never goes looking
      // for the rest.
      //
      // THE DISC AND NOT THE RING, which is the one piece of aim this has
      // room for: the press is taken by the coloured handle, and the arc
      // drawn through it is a picture the trackball still owns (`rings.js`),
      // so naming the ring would send the reader to grab the one part of the
      // widget that does nothing.
      : armed === 'move' ? 'drag it to slide, a coloured disc to turn · esc to stop'
      : armed === 'cut' ? 'click a face to place the section plane'
      : `drag — orbit · wheel — zoom · hold ${HOLD_KEY_LABEL} — section`,
  };
}
