// <hmr-viewport> — the CAD viewport as a custom element.
//
// It replaces the mock-up at /Users/vvzvlad/Downloads/export/viewport.js, which
// drew boxes with a CDN copy of three.js. The contract is that file's — one
// `hmr:state` down, one event per action up — and everything behind it is
// three-cad-viewer with its own interface switched off (`tools: false`), driven
// by logic ported from the page viewer this interface replaced.
//
// A CUSTOM ELEMENT AND NOT A REACT COMPONENT, deliberately. What is inside it is
// a WebGL scene the library owns and re-renders sixty times a second from state
// React must never own: a camera, a trackball, a picking buffer, three clip
// planes. Making that a React subtree would mean either reconciling a DOM React
// did not build or lifting the camera into React state, and the second one turns
// every mouse move into a re-render. The boundary is the same one the mock-up
// drew, and it is drawn in the right place.
//
// NO SHADOW ROOT. The library's stylesheet is a global one the hub already
// serves (`/_v/three-cad-viewer.css`, linked from templates/build.html), and its
// rules are written against `.tcv_*` class names in an ordinary document. A
// shadow root would keep every one of them out and leave the widget unstyled.

import {
  EVENT_ERROR, EVENT_MODEL, EVENT_STATE, EVENT_TOOL, emit,
} from "./events.js";
import { safeHatch, setCutHatch } from "./hatch.js";
import { installHoldKey } from "./holdkey.js";
import { installIdleClock, captureLive, restoreLive, cameraState, isBusy, snapshot }
  from "./live.js";
import { installOrbit } from "./orbit.js";
import { installPinchGuard } from "./pinch.js";
import { installTools } from "./tools.js";
import { installWheel, initialPointingDevice, setPointingDevice } from "./wheel.js";
import { createOverlay } from "./overlay.js";
import { createHandle } from "./handle.js";
import { createViewCube } from "./viewcube.js";
import { internals } from "./internals.js";
import { loadViewerLibrary } from "./library.js";
import { measureChrome, refit, sized, treeWidth } from "./sizing.js";
import { muteStatusLine } from "./statusline.js";
import { applyGhost, applyHidden, applySelected, partCentre, resetMoves,
  restageMoves, statesOf, treeFromShapes } from "./parts.js";
import { applySection, keepSectionCut, suspendSectionCut } from "./section.js";
import { displayOptions, renderOptions, viewerOptions } from "./options.js";

/** The state the viewport starts in — the mock-up's shape, plus the four fields
 *  a real build needs and a mock-up does not (where the geometry comes from). */
const INITIAL_STATE = {
  // Where view files are fetched from and which of them is on screen. `base`
  // defaults to the directory of the page, which is exactly what it is on a
  // build page: /project/<pid>/<build>/.
  base: null,
  views: [],
  view: null,
  // What makes one build different from the last, as one comparable string. A
  // change here with the same `view` is a LIVE RELOAD — the same shape published
  // again — and is the difference between "keep the frame" and "start fresh".
  // The interface computes it, because it is the half that reads meta.json.
  buildKey: null,

  hidden: [],
  ghost: [],
  // The PATHS of the selected row, not one path: a row may stand for several
  // copies of one part (hub.indexTree), and all of them light up together.
  selected: [],
  cut: false,
  cutOffset: 0,
  cutFlip: false,
  cutHatch: true,
  tool: null,
  pins: [],
  camera: null,
  // WHICH KIND OF SCENE THIS IS, told rather than acted on. Nothing in here
  // branches on either field and nothing is meant to: comparing two revisions
  // (ui-brief block 9) reaches this element as an ORDINARY view document with an
  // ordinary tree, and the three ways of looking at it — both revisions, one
  // revision, the other — are expressed in `hidden`, which is a list of paths
  // this element already applies by prefix. The interface owns the translation
  // because the group ids in it are the hub's contract and not the viewport's.
  // What these two are for is the reader of a `hmr:state` in a debugger, and the
  // day something in here does have to know.
  mode: "single",
  diffShow: "both",
  // The secret a GUARDED document needs, or null for everything that needs
  // none. A build's view files are public and this stays null on a build page;
  // a comparison's `scene.json` is behind EDIT_TOKEN (hub.js), and this element
  // is the only thing that fetches it — it fetches every view file it renders,
  // deliberately and as the one entrance (`load` below). So the token comes down
  // the same event the rest of the state does rather than being read here:
  // `store.js` is the one module on this side allowed to touch localStorage.
  token: null,
  // "trackpad" | "mouse" | null for "whatever the platform and localStorage say".
  pointingDevice: null,
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// WHERE THE OVERLAY'S BODIES HANG, and a group of their own is the whole of the
// answer to a collision. A sketch body is a MOCK OF A MODEL PART — the motor the
// bracket has to clear, the wall it bolts to — so it is named after the thing it
// mocks, and `post` over a model that already has a `post` is the expected case
// rather than an edge one. Laid flat beside the model's parts, the two would
// share `/<root>/post`: one entry in `nestedGroup.groups`, one row in the tree,
// one path in the measurement backend, and the real part's eye hiding the mock.
// Under a group nothing of ours can reach a path of theirs — every overlay path
// starts `/<root>/<group>/`, and the group's own name is the only string that
// has to be free.
const OVERLAY_GROUP = "sketch";

/** The first free `sketch`, `sketch2`, … among the root's own children. */
function groupName(parts) {
  const taken = new Set((Array.isArray(parts) ? parts : [])
    .map((part) => (part && typeof part.name === "string" ? part.name : "")));
  if (!taken.has(OVERLAY_GROUP)) return OVERLAY_GROUP;
  // The same "first free" the sketch panel mints param names by, and here it is
  // what turns "a collision is unlikely" into "a collision cannot happen": a
  // model may legitimately publish a group called `sketch`, and one that does
  // gets `sketch2` laid beside it rather than merged into it.
  let n = 2;
  while (taken.has(`${OVERLAY_GROUP}${n}`)) n += 1;
  return `${OVERLAY_GROUP}${n}`;
}

/**
 * Where an overlay's bodies hang over this document: the group's name, and the
 * path everything under it is spelled from.
 *
 * MINTED IN ONE PLACE BECAUSE IT IS ANSWERED IN TWO. `staged()` below lays the
 * group out, and `isOverlay()` reads a path back against it for the interface,
 * which refuses the Move and Comment tools a body of the sketch: a task filed in
 * the build's terms against a body that is in no build. That second reader is
 * the reason this is a function rather than two lines inside `staged()` — the
 * alternative is matching `sketch|sketch2|…` against a path, which answers yes
 * for a model that legitimately publishes a part called `sketch`, and the whole
 * point of `groupName` is that the overlay steps aside for exactly that model.
 */
function overlayAt(payload) {
  // Spelled exactly as `treeFromShapes` spells the root, non-string name and
  // all, because agreeing with it is the entire point.
  const root = `/${typeof payload.name === "string" ? payload.name : ""}`;
  const name = groupName(Array.isArray(payload.parts) ? payload.parts : []);
  return { name, at: `${root}/${name}` };
}

/**
 * The scene as it stands: the fetched view document with the overlay's parts in
 * it. THE ONE PLACE THE TWO SOURCES MEET — `show()` is its only caller, and
 * `show()` is reached from `load()` and from `restage()` alike, which is what
 * makes an auto-refresh re-apply the overlay by construction.
 *
 * A COPY, never a write into either side: the fetched document is kept as it
 * arrived so the next stage composes from the model and not from the model plus
 * the overlay it was last shown with, and the parts the interface handed over
 * are its own to hold.
 *
 * ONE GROUP NODE, AND THE IDS REWRITTEN UNDER IT — that is the whole of the
 * surgery. The library keys `nestedGroup.groups` and the picking registry's
 * `solidPath` by a part's OWN `id`, while its navigation tree — and therefore
 * `getStates`, and therefore every path the interface sends back in `hidden`,
 * `ghost` and `selected` — is keyed by where the part SITS, parent path plus
 * `/<name>` (`_buildTreeData` and `TreeModel._buildTreeStructure` in the
 * vendored library; `treeFromShapes` on this side spells it the same way). In a
 * pushed view file the two are the same string and nothing notices they are two
 * questions. An overlay built somewhere else carries ids of its own
 * (`/sketch/result`), and left alone it renders perfectly while ghosting and
 * selection quietly do nothing to it: both look the part up by the tree's
 * spelling and miss.
 *
 * A GROUP IS WHAT THE DOCUMENT ALREADY HAS: the hub publishes a model's own
 * groups as `{name, id, loc, parts}` and the library descends into anything with
 * a `parts` field (`isShapeTree`). No `key` on it, which is the rule
 * `treeFromShapes` keeps — a group is not a part and answers for no catalogue
 * record.
 */
function staged(payload, parts) {
  const list = Array.isArray(parts) ? parts : [];
  if (!payload || !list.length) return payload;
  const below = Array.isArray(payload.parts) ? payload.parts : [];
  const { name, at } = overlayAt(payload);
  return {
    ...payload,
    parts: [
      ...below,
      {
        name,
        id: at,
        // Spelled out rather than left off: `renderLoop` writes an identity
        // `loc` into a node that carries none, which would be this function
        // handing the library an object for it to patch.
        loc: [[0, 0, 0], [0, 0, 0, 1]],
        parts: list.map((part) => ({ ...part, id: `${at}/${part.name}` })),
      },
    ],
  };
}

/**
 * Two overlays that would put the same thing on the screen.
 *
 * WHAT IT SAVES IS A WHOLE SCENE. A stage disposes every geometry and every
 * material in `clear()` and builds them again in `render()`, and the tree goes
 * up to React with them — so an overlay set to what is already staged is that
 * price paid for no change at all. The panel really does ask for it: opening it
 * over a document nothing has been put in yet, closing it again, committing a
 * field whose text did not change.
 *
 * BY IDENTITY FIRST AND BY VALUE ONLY THEN. Identity settles the two cases that
 * matter — the empty list against the empty list, and the same array handed back
 * — without touching a mesh; the value comparison behind it is the honest answer
 * for parts rebuilt from a document that came out the same, and it is bounded by
 * the SKETCH's own bodies rather than by the model's, which is what makes it
 * affordable at all.
 */
function sameParts(a, b) {
  if (a.length !== b.length) return false;
  return a.every((part, at) => part === b[at] || same(part, b[at]));
}

export class HmrViewport extends HTMLElement {
  connectedCallback() {
    if (this.booted) return;
    this.booted = true;

    // Two properties the element needs to work at all, and BOTH are set only if
    // the page has not already settled them. An unknown element is `display:
    // inline` by default, which gives it no height whatever its parent does, and
    // the canvas and the overlay are positioned against it, which needs it to be
    // a containing block. But the interface owns the LAYOUT — its own wrapper
    // places this element with `position: absolute; inset: 0` — and React writes
    // those inline styles before the element is upgraded, so overwriting them
    // here unconditionally would take the interface's placement away in a way
    // that looks like a bug in the interface.
    const css = getComputedStyle(this);
    if (css.display === "inline") this.style.display = "block";
    if (css.position === "static") this.style.position = "relative";
    this.style.overflow = "hidden";

    // The library is handed a container of its own rather than the element: it
    // writes `container.innerHTML = TEMPLATE(...)` on construction, which would
    // take the overlay with it.
    this.box = document.createElement("div");
    this.box.className = "hmr_canvas";
    this.box.style.cssText = "position:absolute;inset:0";
    this.appendChild(this.box);

    this.state = { ...INITIAL_STATE };
    this.applied = {
      hidden: null, ghost: null, selected: undefined, camera: null,
      cutHatch: null,
    };
    this.viewer = null;
    this.view = null;
    this.tab = "tree";          // the library's own runtime default
    this.lastPick = null;
    this.chrome = [0, 0];
    this.chromeKnown = false;
    this.zoomAnchor = null;
    this.orbitAnchor = null;
    this.sectionSeed = null;
    this.measurePicks = [];
    this.measureLabel = null;
    this.moved = new Map();
    this.partHome = new Map();
    // THE IDS OF THE POINTERS CURRENTLY DOWN ON THE CANVAS, and not a flag: two
    // fingers on the glass are two presses, and one bit meant the first release
    // answered for the second — see `installIdleClock`, which is the only thing
    // that writes this.
    this.pointersDown = new Set();
    // -Infinity AND NOT 0, because `lastTouch` holds a `performance.now()`
    // reading and that clock is zeroed at the START OF THE NAVIGATION: 0 does
    // not mean "long ago", it means "the instant this page opened". A viewport
    // nobody had touched therefore answered `isBusy()` with true for the first
    // IDLE_MS of its life, which is the same trap the `pointerup` guard in
    // `installIdleClock` closes from the other end.
    this.lastTouch = -Infinity;
    this.trackpad = false;
    this.hoverText = "";
    this.loadToken = 0;
    // THE TWO SOURCES A SCENE IS MADE OF, and both are remembered rather than
    // passed through. `payload` is the view document the last fetch brought
    // back, kept so the overlay can be changed without going to the hub again;
    // `overlayParts` is the second source — a sketch the interface assembled in
    // the browser (ui/src/sketchgeom.js), which belongs to no build, is fetched
    // from nowhere, and has to survive every rebuild of the model under it.
    // `staged()` composes them, and it is the only thing that does.
    //
    // NOT `this.overlay`, which is created a few lines down and is the pin
    // layer — a different thing with an unfortunately similar name.
    this.payload = null;
    this.overlayParts = [];
    // Both of these are patches applied to something the element no longer has
    // after a `destroy()`, so a re-attached element has to start over on them.
    // `statusPatched` guards `muteStatusLine`, which patches a method on the
    // library's `Display` — a new attach builds a NEW display, and a flag left
    // standing means its badge is never silenced and sits over the canvas for
    // good. `loadFailed` is the view that could not be shown; keeping it would
    // stop the fresh element ever loading one.
    this.statusPatched = false;
    this.loadFailed = null;
    this.holdActive = false;

    this.overlay = createOverlay(this);
    this.appendChild(this.overlay.root);

    // AFTER the overlay, so its cells stay clickable where a pin happens to be
    // over the same corner: the overlay's layer covers the whole canvas, and the
    // later sibling is the one that gets the press.
    this.viewcube = createViewCube(this);
    this.appendChild(this.viewcube.root);

    // AND THE SECTION HANDLE LAST, by the same rule read the other way: it is on
    // screen only while a cut stands and it is the thing under the reader's hand
    // at that moment, so where it happens to overlap the cube's corner the grip
    // is what the press should reach.
    this.handle = createHandle(this);
    this.appendChild(this.handle.root);

    setPointingDevice(this, initialPointingDevice(), false);

    this.teardown = [
      installWheel(this),
      installOrbit(this),
      // ITS RELEASE HAS TO RUN BEFORE THE TOOL'S, and what secures that is WHEN
      // the listener is added rather than where this line sits in the array.
      // The guard puts its capture-phase `pointerup` on the window HERE, at
      // install; `tools.js` (`watch`) and `orbit.js` add theirs inside their own
      // `pointerdown`, i.e. never earlier than the first press. Listeners on one
      // node in one phase run in the order they were added, so the guard's is
      // always the older registration — and its release is what flushes a
      // deferred `update`, which re-marks the id-picker before the tool's
      // release pick reads that buffer.
      installPinchGuard(this),
      installIdleClock(this),
      installTools(this),
    ];

    // The hold key drives the CUT tool and nothing else, and it overrides
    // `state.tool` for as long as it is down rather than writing to it: the
    // interface owns that field, and a momentary mode that edited it would leave
    // the two disagreeing the moment a release went missing. The interface is
    // told so it can show the cut is on — block 4 requires that — and what it
    // does with the news is its own business.
    this.teardown.push(installHoldKey({
      onHold: () => {
        this.holdActive = true;
        emit(this, EVENT_TOOL, { tool: "cut", held: true });
      },
      onRelease: () => {
        if (!this.holdActive) return;
        this.holdActive = false;
        emit(this, EVENT_TOOL, { tool: this.state.tool || null, held: false });
      },
      onEscape: () => emit(this, EVENT_TOOL, { tool: null, held: false, escape: true }),
    }));

    this.onState = (event) => this.setState(event.detail);
    addEventListener(EVENT_STATE, this.onState);

    // Sized from the CONTAINER, never from the window: the interface decides how
    // much room the viewport gets, and an assumed header height puts the header
    // off-screen the moment it is wrong.
    this.observer = new ResizeObserver(() => refit(this));
    this.observer.observe(this);
  }

  /**
   * A REMOVAL AND A MOVE LOOK IDENTICAL HERE, and telling them apart is what this
   * indirection buys.
   *
   * Moving a node in the DOM — which is what React does when a list is reordered
   * or a subtree is reparented — is a `disconnectedCallback` followed
   * synchronously by a `connectedCallback`. Tearing the scene down on the spot
   * would therefore dispose a live viewer on an ordinary re-render, and rebuilding
   * it costs the reader their camera and a second parse of a two-megabyte
   * payload. By the time a microtask runs the move is finished, so `isConnected`
   * is the answer: still in the document means it was a move.
   */
  disconnectedCallback() {
    queueMicrotask(() => {
      if (!this.isConnected) this.destroy();
    });
  }

  destroy() {
    if (!this.booted) return;
    this.booted = false;
    removeEventListener(EVENT_STATE, this.onState);
    if (this.observer) this.observer.disconnect();
    for (const off of this.teardown || []) {
      try {
        off();
      } catch (error) {
        console.warn("viewport teardown", error);
      }
    }
    this.teardown = [];
    if (this.overlay) this.overlay.destroy();
    if (this.viewcube) this.viewcube.destroy();
    if (this.handle) this.handle.destroy();
    try {
      if (this.viewer) this.viewer.dispose();
    } catch (error) {
      console.warn("viewport dispose", error);
    }
    this.viewer = null;
    // THE PAYLOAD IS LET GO HERE, and these two lines are the whole of what
    // makes keeping one affordable. `show` remembers the parsed view file so
    // `setOverlay` can re-stage it without a second fetch — a couple of
    // megabytes of buffers with a field of this element pointing at them — and a
    // detached element can sit in a React tree for a while, so left standing
    // that is a leak with no symptom short of a heap snapshot. This used to read
    // "nothing here keeps the payload"; something does now, and it is dropped on
    // the same line the viewer is.
    this.payload = null;
    this.overlayParts = [];

    // The library's own DOM goes with it. Without this a re-attached element
    // would build a SECOND widget beside the dead one — two canvases stacked,
    // the top one inert, and nothing in the console about it.
    if (this.box) this.box.remove();
    this.box = null;
  }

  // -- the way in ------------------------------------------------------------

  /** Merge one state patch and reconcile. Also the method form of `hmr:state`,
   *  which is what a page with two viewports on it will have to use. */
  setState(patch) {
    if (!patch || typeof patch !== "object") return;
    const before = this.state;
    this.state = { ...before, ...patch };

    // The imperative flags. They are commands rather than state — "forget the
    // moves", "drop the plane", "clear the tape", "try that view again" — so they
    // are acted on and then taken back out of `state`. Left in, they would sit
    // there reading like a viewport permanently in the middle of a reset, which
    // is the sort of thing somebody later writes a condition against.
    //
    // `__retry` is the fourth and is acted on further down, where the decision
    // to load lives; the mock-up's three are here because they are self-contained.
    for (const flag of ["__resetMove", "__resetCut", "__clearMeasure", "__retry"]) {
      delete this.state[flag];
    }
    if (patch.__resetMove) resetMoves(this);
    if (patch.__resetCut) {
      this.sectionSeed = null;
      this.state.cutOffset = 0;
      suspendSectionCut(this);
    }
    if (patch.__clearMeasure) {
      this.measurePicks = [];
      this.measureLabel = null;
      this.overlay.refresh();
    }
    if (typeof patch.pointingDevice === "string") {
      setPointingDevice(this, patch.pointingDevice === "trackpad");
    }

    const reload = patch.view !== undefined && patch.view !== before.view;
    // A SWAP IS EITHER OF TWO CHANGES, and the second one is why a revision
    // switch works at all. `buildKey` says the geometry was published again;
    // `base` says the geometry is somewhere else — a different revision of the
    // same project, chosen in the picker (issue #62). The same view id
    // under a new base names a DIFFERENT FILE, so without this line the element
    // would keep the scene it had and quietly disagree with the address bar.
    //
    // Both are guarded on the previous value not being null, which is the FIRST
    // load in each case: the element starts with `base: null` and `buildKey:
    // null`, and the first `hmr:state` fills them in beside the first `view`.
    // That is a load with nothing to keep, and it is caught by the third
    // disjunction below rather than by being called a swap.
    const changed = (key) => patch[key] !== undefined && patch[key] !== before[key]
      && before[key] !== null;
    const swap = changed("buildKey") || changed("base");
    // A new view or a new build is a new thing to try, so whatever failed last
    // time stops counting. Anything else does not: the third disjunction below
    // is the FIRST load — a view named and no scene yet — and it is NOT
    // one-shot on its own. A fetch that 404s leaves `this.viewer` null, so
    // without `loadFailed` every later `hmr:state` would go straight back into
    // `load()`, and the interface sends one on every `set()`: opening a node in
    // the tree, a view tab, a pin. That is a request to the hub and a
    // `console.error` per click, for as long as the reader stays on the page.
    //
    // IT IS NOT A LOOP TODAY, and what stops it is one line on the other side
    // rather than anything here: the interface's `hmr:error` handler uses
    // `setState` and not its own `set()`, so nothing dispatches `hmr:state` back
    // at us (HammerolaViewer.jsx, the ERROR handler, where the same thing is
    // written down). Change that one call and the storm closes into a real loop.
    //
    // AND THE READER ASKING AGAIN IS THE THIRD WAY IT STOPS COUNTING — the
    // Retry button in the interface's error panel, which arrives here as
    // `__retry`. Without one, `loadFailed` closed the accidental repeat and
    // took the deliberate one with it: choosing a revision is a whole
    // navigation, `showView(id)` returns immediately for the id already on
    // screen, and a build with a single view therefore had NO path back at all
    // short of reloading the page — so a network blip that lasted a second
    // stayed on screen until somebody pressed F5.
    const retry = !!patch.__retry;
    if (reload || swap || retry) this.loadFailed = null;
    if (reload || swap || retry
        || (this.state.view && !this.viewer && !this.loadFailed)) {
      // A build that changed under the same view is a LIVE RELOAD and keeps the
      // frame; a different view is a different arrangement of the same parts,
      // whose own extent and orientation the camera has to be re-fitted to
      // (ui-brief block 2), so it deliberately does not.
      //
      // A retry keeps the frame under exactly one condition, and it is the same
      // one spelled differently: there is a scene on screen AND it is showing
      // the view being fetched again. That is a live reload whose fetch failed —
      // the previous build is still standing under the reader's camera. A retry
      // after a failed VIEW SWITCH leaves a different view on screen, and
      // carrying that camera over would be the very thing the line above refuses.
      const live = !reload
        && (swap || (retry && !!this.viewer && this.view === this.state.view));
      this.load({ live });
      return;
    }
    this.reconcile();
  }

  /** Fetch a view file and render it. THE ONLY WAY A MODEL GETS IN.
   *
   * The element fetches for itself rather than being handed a payload, and that
   * is what makes a live reload atomic: capture, fetch, render, restore runs
   * from here in one order that nothing can interleave — states, then camera,
   * then tab, then the cut. A second entrance beside this one would be an
   * invitation to drive the same pipeline from a React render, and the result —
   * a section that quietly moved after an auto-refresh — throws nothing and logs
   * nothing.
   *
   * `show()` HAS A SECOND CALLER NOW, and this paragraph is what says why it is
   * not that entrance. `restage()` — behind `setOverlay()` and `clearOverlay()`
   * — hands `show` the very document THIS method fetched and remembered, so it
   * brings in no geometry of its own and cannot put a scene on screen that no
   * load asked for. What it changes is the OVERLAY, the second source `staged()`
   * composes in, and composing happens inside `show` rather than at either call
   * site: a rebuild landing under an open sketch panel therefore re-applies the
   * overlay by construction instead of by the interface remembering to put it
   * back, which is the same failure the paragraph above describes read from the
   * other end. It re-stages LIVE, so the frame, the tree states and the cut
   * survive it exactly as they survive a rebuild — and it says `restage`, which
   * is what carries the things a rebuild is RIGHT to throw away: a measurement
   * is about faces of the model, and a dragged part is an offset from where the
   * build put it, so a new build invalidates both and a new overlay over the
   * same build invalidates neither (ui-brief blocks 6 and 7). Both sides of that
   * are below, in `show`.
   *
   * `loadToken` orders the loads among THEMSELVES: a reader who clicks twice, or
   * a build that lands mid-fetch, starts a second one, and whichever was started
   * last owns the scene. A re-stage takes the CURRENT token rather than a new
   * one, deliberately: bumping it would make an overlay edit typed during a
   * fetch cancel the build that was on its way, and a build silently dropped is
   * worse than the two renders landing in the order they were asked for.
   */
  async load({ live } = {}) {
    const token = ++this.loadToken;
    const { views, view } = this.state;
    const list = Array.isArray(views) ? views : [];
    const chosen = list.find((v) => v && v.id === view) || list[0] || null;
    if (!chosen || !chosen.file) {
      // THE EXIT THAT USED TO SAY NOTHING. There is no file to fetch, so the
      // scene stays empty — and with no event the interface's `viewError` stays
      // null, block 11's panel is not drawn, and the reader is left looking at a
      // frame around a hole. Same `stage` as the failures below, because from
      // where they are sitting it is the same event: this view did not arrive.
      this.loadFailed = (chosen && chosen.id) || true;
      emit(this, EVENT_ERROR, {
        stage: "load", view: (chosen && chosen.id) || view || null,
        message: chosen
          ? `the view ${JSON.stringify(chosen.id || null)} names no file`
          : "this build lists no views",
      });
      return;
    }
    const base = this.state.base
      || location.pathname.replace(/[^/]*$/, "");
    try {
      // `fetch`, NOT a `<script type="module">`. Data loaded as a module stays
      // inside the module scope: the scene renders empty, and nothing appears in
      // the console. That one has already cost a debugging session.
      //
      // Before anything is torn down, so a view file that 404s leaves the scene
      // that is on screen exactly where it was.
      //
      // THE HEADER GOES ONLY WHERE THE INTERFACE PUT A TOKEN IN THE STATE, which
      // on a build page is nowhere: those files are public, and sending the
      // secret that publishes with every two-megabyte view fetch would be this
      // element deciding, on its own, that a public document is a guarded one.
      //
      // `secret` and not `token`, which is taken: the `token` in this method is
      // the load-ordering number at the top of it, and two different things
      // under one name in twenty lines is how the wrong one gets read.
      const secret = this.state.token;
      const response = await fetch(base + chosen.file,
                                   secret
                                     ? { headers: { Authorization: `Bearer ${secret}` } }
                                     : undefined);
      if (!response.ok) throw new Error(`${chosen.file} -> HTTP ${response.status}`);
      const shapes = await response.json();
      await this.show(shapes, { live, view: chosen.id, token });
    } catch (error) {
      if (token !== this.loadToken) return;
      // Remembered so the next `hmr:state` does not fetch it all over again —
      // see the note at the call site in `setState`. Cleared there too, when a
      // different view or a new build makes it worth another try.
      this.loadFailed = chosen.file;
      console.error("viewport load", error);
      emit(this, EVENT_ERROR, {
        stage: "load", view: chosen.id,
        message: String((error && error.message) || error),
      });
    }
  }

  /**
   * Put one payload on screen. The whole pipeline.
   *
   * `restage` IS "THE SAME DOCUMENT, A DIFFERENT OVERLAY" and it is the one
   * thing this method branches on beyond `live`. Everything a load brings is new
   * geometry; a re-stage brings none — the model under it is the very document
   * that is already on screen — so the state that is measured AGAINST that
   * model has to survive it. `restage()` below is the only caller that sets it.
   */
  async show(shapes, { live, view, token, restage }) {
    // Which view this call is about, resolved ONCE. Three lines below used to
    // spell it out separately, and the moment one of them drifts the reader is
    // told a different view failed than the one the element stopped retrying.
    const named = view === undefined ? this.state.view : view;
    if (!shapes || typeof shapes !== "object") {
      // THE OTHER EXIT THAT SAID NOTHING — `load` had one and it was fixed; this
      // is the same failure one step further in, reachable with a view file that
      // parsed into a JSON scalar. Silence here costs both halves of block 11 at
      // once: no `hmr:error`, so the interface's `viewError` stays null and the
      // panel is never drawn, and no `loadFailed`, so the next `hmr:state` — one
      // arrives on every click in the tree — fetches the same file again.
      if (token !== this.loadToken) return;
      this.loadFailed = named || true;
      emit(this, EVENT_ERROR, {
        stage: "render", view: named || null,
        message: "the view file does not describe a model",
      });
      return;
    }
    try {
      const { Viewer, Display } = await loadViewerLibrary();
      // Another load overtook this one — the reader clicked twice, or a build
      // landed mid-fetch. The newer one owns the scene.
      if (token !== this.loadToken || !this.booted) return;

      // The two sources composed, once, for the render AND for the tree that
      // goes up with it. `shapes` is left exactly as it arrived; it is what gets
      // remembered further down, so the next stage composes the model with the
      // overlay rather than the overlay with itself.
      const scene = staged(shapes, this.overlayParts);

      // A gesture the reader has not let go of ends here, before anything is
      // torn down: what it holds was measured against the scene that is going
      // away. The page viewer this replaced ended its own section drag at the
      // same point in its render path, for the same reason.
      if (this.endGesture) this.endGesture();
      // The grip's drag is a SECOND gesture and needs saying so separately: its
      // press lands on a layer that is a sibling of `this.box`, so neither the
      // line above nor the idle clock that defers this swap ever sees it.
      this.handle.endDrag();

      const keep = live ? captureLive(this) : null;
      const [w, h] = sized(this);
      // The cut goes before the scene it was measured against does: a depth
      // taken from a face of the view that is about to leave the screen would be
      // a number about nothing. Before `clear()` and not after, because `clear()`
      // switches the library back to its Tree tab, and a seed still standing at
      // that moment would have `keepSectionCut` re-assert clipping on a scene
      // that is being torn down.
      this.sectionSeed = null;
      // The outline children hung on the scene's own ObjectGroups, so they are
      // gone with it — the rebuild memo has to be, or it would suppress the
      // first outline of the new scene (outline.js).
      this.sectionOutlineKey = null;
      // THE TWO THINGS A REBUILD INVALIDATES AND A RE-STAGE DOES NOT, which is
      // why this is the one block with a condition on it.
      //
      // The tape and the offsets belong to the geometry that is going away — a
      // rebuild puts every part back where the model says it goes (ui-brief
      // block 6), so carrying them would move parts of the NEW build by numbers
      // measured against the old, and leave a distance between two faces that
      // may not exist any more.
      //
      // A RE-STAGE IS THE SAME MODEL, though: the document below is the one
      // that is already on screen, and what changed is a body drawn OVER it.
      // Clearing here would make opening the sketch panel — or closing it, or
      // typing one digit into it — snap a dragged part home and drop a live
      // measurement, with `partHome` gone so the move could not even be undone.
      // Block 6 is the precedent this feature is modelled on and block 7 is its
      // pair; neither survives a second statement quietly cancelling the first.
      if (!restage) {
        this.measurePicks = [];
        this.measureLabel = null;
        this.moved.clear();
        this.partHome.clear();
      }

      if (!this.viewer) {
        const opts = {
          ...displayOptions, cadWidth: w, height: h, treeWidth: treeWidth(w),
        };
        this.viewer = new Viewer(new Display(this.box, opts), opts,
                                 (changes) => this.onNotify(changes), null);
      } else {
        this.viewer.clear();
      }
      this.viewer.render(scene, renderOptions, viewerOptions);
      // Only now does the widget exist to be measured; the first pass asked for
      // the whole container, so re-fit it to what is left once its own chrome is
      // accounted for. A no-op on every later call.
      measureChrome(this, w, h);
      refit(this);
      const g = internals(this.viewer);
      if (g) muteStatusLine(this, g.display);
      // The cut faces are hatched HERE and only here, because this is the one
      // moment the library's cap meshes exist to be patched: it builds one per
      // (plane, solid) inside `render()`, and throws them away on `clear()`.
      // See hatch.js for the second path that would rebuild them.
      //
      // `safeHatch` AND NOT `hatchSectionCaps`, which is the guarded entry point
      // and the only one the viewport should ever call: this method's own catch
      // draws the error panel INSTEAD OF THE MODEL and sets `loadFailed`, so an
      // exception from a decoration would cost the reader the viewer and stop
      // the next `hmr:state` retrying. The guard lives at hatch.js's definition
      // rather than in a `try` written around this line, because there a test
      // can make the patching really throw instead of reading this file.
      //
      // The checkbox rides along: a scene rendered while `cutHatch` is unticked
      // comes up patched but hatching nothing, so the toggle stays a uniform
      // write whatever order the reader does things in.
      safeHatch(g, this.state.cutHatch);
      this.view = named;
      // WHAT IS ON THE SCREEN, remembered beside the view it is of and for the
      // same reason — both are answers to "what is the reader looking at", and
      // `restage()` needs the pair. DOWN HERE rather than beside `staged()`
      // above, because everything that could have gone wrong has: a document
      // the library refused is one `setOverlay` would hand straight back to it,
      // once per keystroke, and each failure draws block 11's panel again.
      this.payload = shapes;
      this.lastPick = null;
      this.applied = {
        hidden: null, ghost: null, selected: undefined, camera: null,
        cutHatch: null,
      };
      this.reconcile();
      if (keep) restoreLive(this, keep);
      // KEEPING THE OFFSETS IS NOT THE SAME AS KEEPING THE PART WHERE IT WAS,
      // and this line is the difference. `clear()` disposed the ObjectGroups the
      // drag was written on and `render()` built new ones, at the positions the
      // model gives them — so the map above would describe a part standing at
      // home while the chip in the interface said it was moved. AFTER
      // `restoreLive`, which re-asserts the tree states, for the same reason
      // `movePart` redraws the cut contour: the offset has to be the last thing
      // written to a group's position.
      if (restage) restageMoves(this);
      this.overlay.refresh();
      // The tree travels with the render rather than being asked for, because
      // this is the only moment both halves of it exist at once: the nesting and
      // the colours come from the payload, and whether a leaf is one the library
      // will answer for comes from the scene that was just built out of it.
      emit(this, EVENT_MODEL, {
        view: this.view,
        buildKey: this.state.buildKey,
        // THE STAGED DOCUMENT and not the fetched one, so the overlay's bodies
        // are rows in the tree like everything else on screen — able to be
        // hidden, ghosted and selected. A tree drawn off `shapes` would list
        // parts that are not all of what the reader is looking at.
        tree: treeFromShapes(scene, statesOf(this.viewer)),
        live: !!live,
        // THE SAME MODEL, A DIFFERENT OVERLAY — said out loud because the
        // interface spends its own half of this decision on it. Its `onModel`
        // drops the measurement chip and the move chip on every model event,
        // which is right for geometry that has been replaced and wrong for a
        // scene the viewport has just re-composed out of the document it
        // already had. `live` cannot answer that question: a rebuild landing
        // under the reader's camera is live too.
        restage: !!restage,
      });
    } catch (error) {
      if (token !== this.loadToken) return;
      // Same reason as in `load`: a failure before the widget exists — the
      // library's own module not loading is the likely one — leaves `viewer`
      // null, and the first-load branch in `setState` would come straight back
      // here on the next patch.
      //
      // `|| true`, exactly as the no-file exit in `load` writes it: what is
      // stored is only ever read as a yes/no, and `named` is perfectly able to
      // be null — a build whose views carry no `id`, on a page that has not
      // settled one either. Storing that null switches the guard OFF at the one
      // moment it is there for.
      this.loadFailed = named || true;
      console.error("viewport render", error);
      emit(this, EVENT_ERROR, {
        stage: "render", view: named || null,
        message: String((error && error.message) || error),
      });
    }
  }

  /** Bring the scene in line with `state`. Cheap, and safe to run often. */
  reconcile() {
    if (!this.viewer) return;
    const s = this.state;
    if (!same(s.hidden, this.applied.hidden)) {
      applyHidden(this.viewer, s.hidden);
      this.applied.hidden = s.hidden;
    }
    if (!same(s.ghost, this.applied.ghost)) {
      applyGhost(this.viewer, s.ghost);
      this.applied.ghost = s.ghost;
    }
    // BY VALUE like the two lists above, and here it is UNCONDITIONAL rather
    // than a precaution for some pushes: `selectedPaths` in HammerolaViewer
    // MINTS A NEW ARRAY IN ALL THREE OF ITS BRANCHES — a copy of a leaf row's
    // `leaves`, `[sel]` wherever `node()` cannot answer with such a row — a
    // group, a tree that has not landed yet, a path no row claims — and `[]`
    // for nothing selected. No push ever carries the array the last one did,
    // so an identity check would clear and repaint the highlight on EVERY
    // `hmr:state` rather than on a subset of them — and one of those goes out
    // per step of the section-plane slider (`setSecOff` calls `set`, and `set`
    // is what syncs).
    if (!same(s.selected, this.applied.selected)) {
      applySelected(this.viewer, s.selected);
      this.applied.selected = s.selected;
    }
    if (s.camera && !same(s.camera, this.applied.camera)) {
      this.setCamera(s.camera);
      this.applied.camera = s.camera;
    }
    // The cut is a THING THAT IS ON, not a mode you enter and leave (ui-brief
    // block 4): turning it off leaves the plane where it was so turning it back
    // on needs no second click. `suspendSectionCut` parks the slider where the
    // library's own reset parks it, which cuts nothing, and leaves the normal
    // alone.
    if (s.cut && this.sectionSeed) applySection(this);
    else if (!s.cut) suspendSectionCut(this);
    // The hatch over the cut face. A `cutHatch` change arrives HERE — it
    // triggers no reload — and reconcile runs on every state event that starts
    // no load, one per section-slider step, so the change is memo'd against
    // `applied` like the three fields above and the toggle it triggers is a
    // UNIFORM WRITE, not a recompile (hatch.js `setCutHatch`). After a render
    // this re-asserts the value the fresh materials were patched with, exactly
    // like the lists do.
    if (!same(s.cutHatch, this.applied.cutHatch)) {
      setCutHatch(internals(this.viewer), s.cutHatch);
      this.applied.cutHatch = s.cutHatch;
    }
    this.overlay.setPins(s.pins);
    // The handle's own loop stops itself whenever there is no cut, so a cut that
    // has just appeared — this pass is where it appears — has to wake it. Every
    // other frame it draws it asks for itself.
    this.handle.refresh();
  }

  /** The library's notification channel. */
  onNotify(changes) {
    if (!changes) return;
    if (changes.lastPick && changes.lastPick.new) {
      // Kept as a FALLBACK source of a part name: `pickAt` gives both the part
      // and the exact point, but it is a lower-level entry point than the
      // notification, so if a library upgrade moves it a comment still gets an
      // anchor — just without the coordinate.
      this.lastPick = changes.lastPick.new;
    }
    if (changes.tab && changes.tab.new) {
      this.tab = changes.tab.new;
      // Anything but `clip` has just turned clipping off inside the library.
      // This is the same notification its own tab machinery subscribes to, and
      // its subscriber runs first, so this lands after it rather than fighting
      // it (see keepSectionCut).
      if (this.tab !== "clip") keepSectionCut(this);
    }
  }

  // -- the imperative half ---------------------------------------------------
  // Questions rather than state, so they are methods rather than events: a
  // comment needs the frame and a PNG of it AT THE MOMENT SEND IS PRESSED, and
  // routing that through an event round-trip would mean keeping a copy of both
  // in React, refreshed on every camera move.

  /**
   * Lay a second source of parts over the model — the sketch panel's rough body
   * (ui-brief block 6, one step on: a statement to the agent rather than an edit
   * of anything).
   *
   * A METHOD AND NOT AN EVENT, for the reason the four below are: this answers
   * to a person typing in a field, which is a gesture and not a state the
   * interface holds a second copy of. `snapshot()` and `getCamera()` are already
   * reached this way.
   *
   * IT DOES NOT FETCH AND IT DOES NOT REPLACE THE MODEL. What it changes is one
   * of the two lists `staged()` composes; the document under it is the one
   * `load()` brought back, and a rebuild landing afterwards composes the overlay
   * in again without being asked.
   */
  setOverlay(parts) {
    const next = Array.isArray(parts) ? parts : [];
    // AN OVERLAY THAT IS ALREADY ON SCREEN IS NOT A CHANGE, and answering one
    // costs a full teardown of the scene — see `sameParts`. The panel asks for
    // exactly that more often than it asks for anything else: it sets an empty
    // overlay over an empty one every time it opens on a document nothing has
    // been put in yet, and again every time it closes.
    if (sameParts(next, this.overlayParts)) return Promise.resolve();
    this.overlayParts = next;
    return this.restage();
  }

  /** Take the overlay off again. The panel closing, and nothing else. */
  clearOverlay() {
    return this.setOverlay([]);
  }

  /**
   * Is this path one of the overlay's own bodies rather than a part of the
   * model?
   *
   * THE QUESTION THE INTERFACE CANNOT ANSWER FOR ITSELF, and a method for the
   * reason the two above are: it is asked of the scene as it stands right now.
   * A staged body is an ordinary row in the tree and an ordinary pick target, so
   * the Move and Comment tools would otherwise file a task in the BUILD's terms
   * — `partId: "/<root>/sketch/motor"` — against a body that is in no build and
   * no catalogue. The group's name is minted here, against the model's own
   * parts, so only here can it be told apart from a model part that is honestly
   * called `sketch`.
   *
   * THE GROUP NODE ITSELF ANSWERS YES, and it is the case that reads as an edge
   * one and is not: the group is a ROW OF THE TREE, a row is selected with the
   * mouse (`onSelect`), and `selectedPaths()` hands a node's OWN id over rather
   * than the leaves under it. So `/<root>/sketch` arrives here as an ordinary
   * selection — the move tool drags the whole mock assembly with it when a press
   * misses the model, and `add to comment` on a measurement heads the composer
   * `sketch` — and it is the same task about a body in no build that a single
   * mock is. Nothing PICKS the group in the scene, which is what made it look
   * safe; the tree is the other door.
   *
   * NOTHING IS A BODY OF AN OVERLAY THAT IS NOT STAGED: with the panel closed
   * `overlayParts` is empty, `staged()` hands the document straight back, and
   * every path on screen is the model's own.
   */
  isOverlay(id) {
    if (!this.payload || !this.overlayParts.length) return false;
    if (typeof id !== "string") return false;
    const { at } = overlayAt(this.payload);
    return id === at || id.startsWith(`${at}/`);
  }

  /**
   * The remembered document back on screen, composed with the overlay as it now
   * stands.
   *
   * NOTHING TO STAGE IS NOT A FAILURE: an overlay set before any view has landed
   * — the panel is open and the reader switched builds — is simply remembered,
   * and the load that follows composes it in.
   */
  restage() {
    if (!this.payload) return Promise.resolve();
    return this.show(this.payload, {
      live: true, view: this.view, token: this.loadToken, restage: true,
    });
  }

  /** The frame on screen, in the shape a comment stores and reopens. */
  getCamera() {
    return cameraState(this.viewer);
  }

  setCamera(c) {
    try {
      if (this.viewer && c && typeof this.viewer.setCameraLocationSettings === "function") {
        this.viewer.setCameraLocationSettings(
          c.position || null, c.quaternion || null, c.target || null,
          Number.isFinite(c.zoom) ? c.zoom : null, false);
      }
    } catch (error) {
      console.warn("camera", error);
    }
  }

  /** Where one part is in the world: the centre of its box, or null.
   *
   * Asked per comment whose anchor is a PART rather than a point, so the pin
   * follows the part through a rebuild that moved it.
   */
  partPoint(path) {
    return partCentre(this.viewer, path);
  }

  /** This frame as a PNG blob, for the snapshot a comment carries. */
  snapshot(label) {
    return snapshot(this, label);
  }

  /** True while a gesture is in progress and a build swap would yank the model. */
  isBusy() {
    return isBusy(this);
  }

  /** Visibility, as the library holds it. NOTHING CALLS THIS YET.
   *
   * Kept rather than deleted because it costs one line over a module function
   * that stays either way, and because the swap it was written for is the one
   * the viewport currently performs for itself (`captureLive`): the day the
   * interface has a reason to drive one — comparing two revisions is plan step 8
   * — this is the question it will have to ask.
   */
  getStates() {
    return statesOf(this.viewer);
  }

  /** Which tool is really in force, hold key included. */
  get activeTool() {
    return this.holdActive ? "cut" : (this.state.tool || null);
  }

  /** Re-fit to the container. NOTHING CALLS THIS YET either.
   *
   * The `ResizeObserver` in `connectedCallback` covers every layout change the
   * interface makes today, the comments rail included — it observes this
   * element, and the element is what those changes resize. This is for the kind
   * that never reaches the element's own box: a transform on an ancestor, a
   * device pixel ratio that changed under a window moved between screens.
   */
  refit() {
    refit(this);
  }
}
