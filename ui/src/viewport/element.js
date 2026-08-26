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
import { installHoldKey } from "./holdkey.js";
import { installIdleClock, captureLive, restoreLive, cameraState, isBusy, snapshot }
  from "./live.js";
import { installOrbit } from "./orbit.js";
import { installTools } from "./tools.js";
import { installWheel, initialPointingDevice, setPointingDevice } from "./wheel.js";
import { createOverlay } from "./overlay.js";
import { createViewCube } from "./viewcube.js";
import { internals } from "./internals.js";
import { loadViewerLibrary } from "./library.js";
import { measureChrome, refit, sized, treeWidth } from "./sizing.js";
import { muteStatusLine } from "./statusline.js";
import { applyGhost, applyHidden, applySelected, resetMoves, statesOf, treeFromShapes }
  from "./parts.js";
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
  selected: null,
  cut: false,
  cutOffset: 0,
  cutFlip: false,
  tool: null,
  pins: [],
  camera: null,
  // Accepted and not yet acted on: comparing two revisions is SPEC 8A.2 step 8
  // and needs a hub that can answer for two builds at once. Kept in the shape so
  // the interface can be written against the finished contract.
  mode: "single",
  diffShow: "both",
  // "trackpad" | "mouse" | null for "whatever the platform and localStorage say".
  pointingDevice: null,
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
    this.applied = { hidden: null, ghost: null, selected: undefined, camera: null };
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

    setPointingDevice(this, initialPointingDevice(), false);

    this.teardown = [
      installWheel(this),
      installOrbit(this),
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
    try {
      if (this.viewer) this.viewer.dispose();
    } catch (error) {
      console.warn("viewport dispose", error);
    }
    this.viewer = null;
    // NOTHING HERE KEEPS THE PAYLOAD, and that is deliberate rather than an
    // omission: `show` hands the parsed view file straight to the library and
    // to `treeFromShapes` and holds no field of its own pointing at it. A
    // detached element can sit in a React tree for a while, and a couple of
    // megabytes of buffers would sit there with it for as long as anything held
    // the element — a leak with no symptom short of a heap snapshot.

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
    const swap = patch.buildKey !== undefined && patch.buildKey !== before.buildKey
      && before.buildKey !== null;
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

  /** Fetch a view file and render it. THE ONLY WAY GEOMETRY GETS IN.
   *
   * The element fetches for itself rather than being handed a payload, and that
   * is what makes a live reload atomic: capture, fetch, render, restore runs
   * from here in one order that nothing can interleave — states, then camera,
   * then tab, then the cut. A second entrance beside this one would be an
   * invitation to drive the same pipeline from a React render, and the result —
   * a section that quietly moved after an auto-refresh — throws nothing and logs
   * nothing.
   *
   * `loadToken` orders the loads among THEMSELVES: a reader who clicks twice, or
   * a build that lands mid-fetch, starts a second one, and whichever was started
   * last owns the scene.
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
      const response = await fetch(base + chosen.file);
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

  /** Put one payload on screen. The whole pipeline, and `load` is its one caller. */
  async show(shapes, { live, view, token }) {
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

      // A gesture the reader has not let go of ends here, before anything is
      // torn down: what it holds was measured against the scene that is going
      // away. The page viewer this replaced ended its own section drag at the
      // same point in its render path, for the same reason.
      if (this.endGesture) this.endGesture();

      const keep = live ? captureLive(this) : null;
      const [w, h] = sized(this);
      // The cut goes before the scene it was measured against does: a depth
      // taken from a face of the view that is about to leave the screen would be
      // a number about nothing. Before `clear()` and not after, because `clear()`
      // switches the library back to its Tree tab, and a seed still standing at
      // that moment would have `keepSectionCut` re-assert clipping on a scene
      // that is being torn down.
      this.sectionSeed = null;
      this.measurePicks = [];
      this.measureLabel = null;
      // The offsets belong to the geometry that is going away — a rebuild puts
      // every part back where the model says it goes (ui-brief block 6), so
      // carrying them would move parts of the NEW build by numbers measured
      // against the old.
      this.moved.clear();
      this.partHome.clear();

      if (!this.viewer) {
        const opts = {
          ...displayOptions, cadWidth: w, height: h, treeWidth: treeWidth(w),
        };
        this.viewer = new Viewer(new Display(this.box, opts), opts,
                                 (changes) => this.onNotify(changes), null);
      } else {
        this.viewer.clear();
      }
      this.viewer.render(shapes, renderOptions, viewerOptions);
      // Only now does the widget exist to be measured; the first pass asked for
      // the whole container, so re-fit it to what is left once its own chrome is
      // accounted for. A no-op on every later call.
      measureChrome(this, w, h);
      refit(this);
      const g = internals(this.viewer);
      if (g) muteStatusLine(this, g.display);
      this.view = named;
      this.lastPick = null;
      this.applied = { hidden: null, ghost: null, selected: undefined, camera: null };
      this.reconcile();
      if (keep) restoreLive(this, keep);
      this.overlay.refresh();
      // The tree travels with the render rather than being asked for, because
      // this is the only moment both halves of it exist at once: the nesting and
      // the colours come from the payload, and whether a leaf is one the library
      // will answer for comes from the scene that was just built out of it.
      emit(this, EVENT_MODEL, {
        view: this.view,
        buildKey: this.state.buildKey,
        tree: treeFromShapes(shapes, statesOf(this.viewer)),
        live: !!live,
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
    if (s.selected !== this.applied.selected) {
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
    this.overlay.setPins(s.pins);
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
