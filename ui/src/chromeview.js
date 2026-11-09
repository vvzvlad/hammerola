/**
 * The model page's chrome: the Share window, the new-build banner's layer, the
 * view switcher and the floating toolbar — everything round the model that is
 * not a panel about the model. The header over it is Header.jsx's.
 *
 * One section of the build page's `computed()`: it takes the page's state, its
 * props and a bag of the page's actions, and returns the keys `render()` draws
 * all of that from.
 *
 * `props` is a separate argument, not part of `deps`, because it is not an
 * action: `commentsOpen` is what the rail falls back to before the reader has
 * chosen, a fact about how the page was mounted.
 *
 * `deps` carries the writers (component methods, since they write its state
 * and push its viewport); `shutHeader` and `onRename`, the doors to the
 * header's menus and the rename window (BuildPage.jsx); `threads` and
 * `openCount`, the feed's answers the rail draws; and `narrow`, the layout
 * every panel shares. `tab` comes from ui/src/panelstyle.js.
 */
import { format, fresh, parse, viewParam } from './address.js';
import { railView } from './comments.jsx';
import { MEASURE_HINT as PART_MEASURE_HINT } from './BoardView3D.jsx';
import { COMMENTABLE, docUrl } from './DocumentView.jsx';
import { PAGE, buildKey, buildPath, mb, shortId } from './hub.js';
import { BOM_TYPE } from './kicadbom.js';
import { BLANK_BOX, ELLIPSIS, INK, ON_ACCENT, btn, menuRow, tab } from './panelstyle.js';
import { writeRetina } from './store.js';
import { MONO, SANS } from './style.jsx';
import { BAR_LAYER, DOC_LAYER, documentRows, quietBtn, settingsView } from './viewlist.jsx';

export function chromeView(s, props, deps) {
  const {
    // -- what `computed()` has already worked out; `variant` is the one this
    // page is of (`pageVariant` in hub.js), `arCapable` whether the browser has
    // AR Quick Look (`arSupported` in ar.js; WebXR's answer is `s.xrCapable`)
    meta, viewer, narrow, stop, variant, arCapable,
    // -- the feed's answers, which the rail draws
    threads, openCount,
    // -- the lookups and constants that stay beside the component
    viewPartCount, HOLD_KEY_LABEL, VIEW_TABS_MAX,
    // -- the page's own doors, and BuildPage's: the header's menus and the
    // rename window
    set, setState, toast, toolsOff, shutHeader, onRename,
    fitView, saveFrame, showView, cameraParam, pushChoice, openAr, openXr,
  } = deps;

  // The tool really in force, which is not always `s.tool`: opening a
  // comparison does not disarm one (the three handlers guard themselves via
  // `toolsOff`), so the field can name a tool that cannot fire. Only the hint
  // below reads this; the buttons are drawn from `s.tool === t` so the armed
  // one still shows as armed while out of service and comes back when the
  // panel closes. `cut` is not one of the three: the hold key sections a
  // comparison's scene like any other.
  const armed = toolsOff() && s.tool !== 'cut' ? null : s.tool;

  const setTool = (t) => () => {
    set({ tool: s.tool === t ? null : t, viewsOpen: false, menu: null });
    shutHeader();
    if (t === 'comment' && s.tool !== 'comment') {
      toast(docCommentable ? COMMENTABLE.get(docOpen.type) : 'Click a spot on the model to pin the task');
    }
    // The model's Measure says what the board's 3D one does (BoardView3D.jsx).
    if (t === 'measure' && s.tool !== 'measure') toast(PART_MEASURE_HINT);
  };

  const railOpen = s.rail === null ? props.commentsOpen : s.rail;

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
  // The insets of a KiCad schematic or board over the model, as its view told
  // the page (`insets` of `docTools`, KicadView.jsx), or null: over the model
  // and over any other document the tool is out of service.
  const docInsets = (docOpen && s.docTools && s.docTools.insets) || null;
  // The measure mode of a KiCad board over the model, as its view told the
  // page (`measure` of `docTools`, KicadView.jsx), or null: over any other
  // document Measure is out of service. Coming on, it puts an armed tool down
  // — the Comment tool on the board would take its clicks — and says how to
  // measure (`hint`).
  const docMeasure = (docOpen && s.docTools && s.docTools.measure) || null;
  const measureDoc = () => {
    if (!docMeasure.on) {
      set({ tool: null, viewsOpen: false, menu: null });
      toast(docMeasure.hint);
    }
    shutHeader();
    docMeasure.toggle();
  };
  // Opening a document: what its row does, what a row of a KiCad design's
  // menu (KicadView.jsx) does with the other member's id, and what a
  // markdown link to another document does. A step of history whose address
  // says it as `?d=` (`pushChoice`). Given a schematic's `sheet` — a row of
  // its sheets in the list (`SheetRows` in viewlist.jsx) — the address names
  // that sheet as `s=`, the root none, and the schematic follows it
  // (`followPage` in KicadView.jsx).
  const openDoc = (id, sheet) => {
    setState({ doc: id, viewsOpen: false });
    pushChoice(s.view, id, sheet);
  };
  // The rename window (rename.jsx, drawn by BuildPage.jsx), opened by a pencil
  // on a row of the views menu, a document's row and the strip: with the token
  // only, since the hub takes a rename only with it. It starts at the name on
  // screen, and the commit goes on the branch of `variant`. The menus shut
  // under it, the header's too.
  const askRename = viewer ? null : (subject) => {
    setState({ viewsOpen: false });
    shutHeader();
    onRename(subject);
  };
  // A document listed `hidden` has no row (viewlist.jsx).
  const docRows = documentRows(documents, docOpen ? docOpen.id : null, openDoc, PAGE.base, buildKey(meta),
    askRename && ((doc) => askRename({ kind: 'document', variant, id: doc.id, name: doc.name })));
  // `View in AR` (`arBtn`) is on the bar in a browser with AR Quick Look, and
  // in one without it whose WebXR said it has AR (`s.xrCapable`). It can show
  // the model where a model view is on screen. A document over the model, a
  // schematic or a board's 3D among them, has none.
  const arShown = !!arCapable || !!s.xrCapable;
  const arReady = arShown && views.length > 0 && !docOpen;

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

    // The new-build banner's "you are viewing …": shortened, like every other
    // place this site prints a revision.
    slot: shortId(PAGE.slot),
    viewer,

    // -- the tree, which on narrow is something you open ---------------------
    //
    // Wide, it floats over a corner of the model and there is room for both.
    // Narrow, it covers the thing it describes — so it starts closed and the
    // Parts row the page adds to the header's menu is what opens it
    // (`headerParts` in HammerolaViewer.jsx). Its openness is state and only
    // state; the constructor says why it is not remembered.
    treeShown: !narrow || s.treeOpen,

    // -- the comment rail (comments.jsx); the header's button that opens it
    // reads the same values from `headerParts`
    ...railView({ open: railOpen, viewer, narrow, threads, openCount, stop, setState }),

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
    // mounted underneath with its camera, cut and hidden parts; a row of a
    // KiCad design's menu (KicadView.jsx) opens the other member the same way
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
    // AR Quick Look or WebXR AR (`arShown`), null elsewhere. On every view, so
    // the bar keeps its shape (AGENTS.md): out of service where no model view
    // is on screen (`arReady`), while its file is made and while a WebXR
    // session starts and runs (`s.ar`). A tap makes the file of the view as it
    // stands and hands it to Quick Look (`openAr`), or, with no Quick Look,
    // shows the view in a WebXR session on the page (`openXr`).
    arBtn: !arShown ? null : {
      onClick: arReady && !(s.ar && s.ar.busy) ? () => (arCapable ? openAr() : openXr()) : null,
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
    // DocumentView draws it from; null over the model and over a BOM, which
    // has no file of its own (kicadbom.js), which leaves the strip without the
    // two.
    docHref: docOpen && docOpen.type !== BOM_TYPE ? docUrl(PAGE.base, docOpen) : null,
    bannerLayerStyle: 'position:absolute;left:0;right:0;top:14px;display:flex;justify-content:center;pointer-events:none;z-index:'
      + (docOpen ? '17' : '13'),
    docLayerStyle: DOC_LAYER,
    viewsOpen: !!s.viewsOpen,
    viewsToggle: stop(() => {
      setState({
        viewsOpen: !s.viewsOpen, menu: null,
        // The other menus in this toolbar, which open upwards from buttons a few
        // pixels along: two of them at once would overlap.
        opsOpen: false, settingsOpen: false });
      shutHeader();
    }),
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
    // service under it, Measure except over a KiCad board (`docMeasure`),
    // Comment except over a document that takes a comment
    // (`docCommentable`), Fit and Frame unless its view can do them. The
    // document's Download and Copy link (`docHref`) stay on a narrow window.
    showTools: !narrow,
    // Both are out of service while the scene is a comparison's, and under a
    // document, which covers the model — Measure not over a KiCad board, which
    // measures itself (`docMeasure`), Comment not under one that takes a
    // comment, whose own drawing it pins to. That differs from `viewer`: that one
    // is about who the reader is, this about what is under the cursor.
    // `toolsOff()` documents why it is not `s.compare`. The buttons are the
    // visible half; the handlers stop a tool armed before the panel opened.
    //
    // Move is armed from the object's row menu (`menuItems`), where the reader
    // has already picked the object; its share of `toolsOff` is the `compared`
    // exclusion that row sits inside.
    // Over a KiCad board, the board's own measure mode (`docMeasure`).
    tMeasure: docMeasure ? measureDoc : setTool('measure'),
    measureBtnStyle: docOpen ? btn(!!docMeasure && docMeasure.on, false, !docMeasure)
      : btn(s.tool === 'measure', false, toolsOff()),
    // Not one of `s.tool` either: the design's own inset mode, which its `I`
    // flips as well, lit while it is on (`docInsets`).
    tInsets: docInsets ? docInsets.toggle : undefined,
    insetsBtnStyle: btn(!!docInsets && docInsets.on, false, !docInsets),
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
    tProposal: stop(() => {
      setState({ opsOpen: !s.opsOpen, viewsOpen: false, settingsOpen: false, menu: null });
      shutHeader();
    }),
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
    // is about this browser rather than about the model. In service under a
    // document too, its rows the documents page's (`settingsView` in
    // viewlist.jsx).
    tSettings: stop(() => {
      setState({ settingsOpen: !s.settingsOpen, viewsOpen: false, opsOpen: false, menu: null });
      shutHeader();
    }),
    settingsBtnStyle: btn(s.settingsOpen, false, false),
    ...settingsView({
      open: s.settingsOpen,
      // The renderer's pixel ratio (viewport/element.js). Remembered per
      // browser, like the screen it is about; the viewport hears it through
      // `sync`, which `set` runs. Out of service under a document, which
      // covers the canvas it is about.
      retina: s.retina,
      onRetina: docOpen ? undefined : () => {
        set({ retina: !s.retina });
        writeRetina(!s.retina);
      },
      // Whether the header draws its strip of projects: BuildPage's answer and
      // door, since the header belongs to neither page (the theme's way).
      tabStrip: props.tabStrip,
      onTabStrip: props.onTabStrip,
    }),
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
