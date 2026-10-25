// <hmr-viewport> — the CAD viewport as a custom element.
//
// The contract is the designer's mock-up's — one `hmr:state` down, one event per
// action up — and behind it is three-cad-viewer with its own interface switched
// off (`tools: false`).
//
// A custom element, not a React component: inside is a WebGL scene the library
// re-renders from state React must never own (camera, trackball, picking
// buffer, clip planes). Lifting the camera into React state would turn every
// mouse move into a re-render.
//
// No shadow root: the library's stylesheet is global (`/_v/three-cad-viewer.css`,
// linked from templates/build.html) and written against `.tcv_*` classes in an
// ordinary document; a shadow root would leave the widget unstyled.

import {
  EVENT_CAMERA, EVENT_ERROR, EVENT_MODEL, EVENT_STATE, EVENT_TOOL, emit,
} from "./events.js";
import { settleCoplanar } from "./coplanar.js";
import { safeHatch, setCutHatch } from "./hatch.js";
import { installHoldKey } from "./holdkey.js";
import { installIdleClock, captureLive, restoreLive, cameraState, isBusy, snapshot }
  from "./live.js";
import { installOrbit } from "./orbit.js";
import { installPinchGuard } from "./pinch.js";
import { installTools } from "./tools.js";
import { installWheel, initialPointingDevice, setPointingDevice } from "./wheel.js";
import { createOverlay } from "./overlay.js";
import { createGizmo } from "./gizmo.js";
import { createHandle } from "./handle.js";
import { createPins } from "./pins.js";
import { createRings } from "./rings.js";
import { createViewCube } from "./viewcube.js";
import { internals } from "./internals.js";
import { loadViewerLibrary } from "./library.js";
import { measureChrome, refit, sized, treeWidth } from "./sizing.js";
import { muteStatusLine } from "./statusline.js";
import { applyGhost, applyHidden, applySelected, partTop, reconcileMoves,
  restageMoves, statesOf, treeFromShapes } from "./parts.js";
import { applySection, keepSectionCut, suspendSectionCut } from "./section.js";
import { displayOptions, renderOptions, viewerOptions } from "./options.js";

/** The state the viewport starts in — the mock-up's shape, plus the fields a
 *  real build needs (where the geometry comes from). */
const INITIAL_STATE = {
  // Where view files are fetched from and which of them is on screen. `base`
  // defaults to the directory of the page, which is exactly what it is on a
  // build page: /project/<pid>/<build>/.
  base: null,
  views: [],
  view: null,
  // What makes one build different from the last, as one comparable string. A
  // change here with the same `view` is a LIVE RELOAD — keep the frame rather
  // than start fresh. The interface computes it from meta.json.
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
  // The renderer's pixel ratio: the display's own when true, 1 when false —
  // the interface's "Retina resolution" setting (store.js remembers it).
  retina: true,
  tool: null,
  pins: [],
  camera: null,
  // Which kind of scene this is, informational only: nothing here branches on
  // it. A comparison (ui-brief block 9) arrives as an ordinary view document,
  // and its three ways of looking are expressed in `hidden` (applied by
  // prefix); the interface owns that translation because the group ids are the
  // hub's contract. Useful when reading `hmr:state` in a debugger.
  mode: "single",
  diffShow: "both",
  // The secret a guarded document needs, or null. A build's view files are
  // public; a comparison's `scene.json` is behind EDIT_TOKEN (hub.js), and this
  // element fetches every view file it renders (`load` below). The token comes
  // down with the state because `store.js` is the only module allowed to touch
  // localStorage.
  token: null,
  // "trackpad" | "mouse" | null for "whatever the platform and localStorage say".
  pointingDevice: null,
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Where the overlay's bodies hang. A proposal body is named after what it stands
// for (the motor, the wall), so `post` over a model that already has a `post` is
// expected; laid flat beside the model's parts they would share one path (one
// `nestedGroup.groups` entry, one tree row, one measurement path). Under a group
// every overlay path starts `/<root>/<group>/`, so only the group's name has to
// be free.
const OVERLAY_GROUP = "proposal";

/** The first free `proposal`, `proposal2`, … among the root's children. */
function groupName(parts) {
  const taken = new Set((Array.isArray(parts) ? parts : [])
    .map((part) => (part && typeof part.name === "string" ? part.name : "")));
  if (!taken.has(OVERLAY_GROUP)) return OVERLAY_GROUP;
  // The same "first free" the panel mints body names by: a model that publishes
  // a group called `proposal` gets `proposal2` beside it.
  let n = 2;
  while (taken.has(`${OVERLAY_GROUP}${n}`)) n += 1;
  return `${OVERLAY_GROUP}${n}`;
}

/**
 * Where an overlay's bodies hang over this document: the group's name, and the
 * path everything under it is spelled from.
 *
 * Minted in one place because three things read it: `staged()` lays the group
 * out; `isOverlay()` reads a path back for the interface, which refuses the
 * Comment tool on a proposal body (it is in no build); `overlayBody()` reads one
 * segment further for the Move tool, which drags a body as an edit of the
 * document. Matching `proposal|proposal2|…` against a path instead would wrongly
 * claim a model's own part called `proposal`.
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
 * it. The one place the two sources meet — `show()` is its only caller, reached
 * from `load()` and `restage()` alike, so an auto-refresh re-applies the
 * overlay.
 *
 * A copy, never a write into either side, so the next stage composes from the
 * model as fetched.
 *
 * One group node with the ids rewritten under it. The library keys
 * `nestedGroup.groups` and the picking registry's `solidPath` by a part's own
 * `id`, while its navigation tree — and so `getStates` and every path the
 * interface sends in `hidden`, `ghost` and `selected` — is keyed by where the
 * part sits, parent path plus `/<name>` (`_buildTreeData` and
 * `TreeModel._buildTreeStructure` in the vendored library; `treeFromShapes`
 * here). In a pushed view file the two agree; an overlay's own ids
 * (`/proposal/motor`) would render but ghosting and selection would miss it.
 *
 * The hub publishes a model's groups as `{name, id, loc, parts}` and the
 * library descends into anything with `parts` (`isShapeTree`). No `key`: a
 * group answers for no catalogue record.
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
        // Spelled out: `renderLoop` would otherwise patch an identity `loc` into
        // an object this function hands over.
        loc: [[0, 0, 0], [0, 0, 0, 1]],
        parts: list.map((part) => ({ ...part, id: `${at}/${part.name}` })),
      },
    ],
  };
}

/**
 * Two overlays that would put the same thing on the screen.
 *
 * Saves a whole re-stage: a stage disposes every geometry and material in
 * `clear()`, rebuilds them in `render()`, and sends the tree to React. The panel
 * really asks for no-op overlays (opening over an empty document, committing an
 * unchanged field).
 *
 * By identity first (the empty list, the same array), then by value for parts
 * rebuilt from an unchanged document — bounded by the proposal's bodies, not
 * the model's.
 */
function sameParts(a, b) {
  if (a.length !== b.length) return false;
  return a.every((part, at) => part === b[at] || same(part, b[at]));
}

export class HmrViewport extends HTMLElement {
  connectedCallback() {
    if (this.booted) return;
    this.booted = true;

    // Set only if the page has not settled them: an unknown element is
    // `display: inline` (no height), and the canvas and overlay need a
    // containing block. The interface owns the layout — React writes inline
    // `position: absolute; inset: 0` before the upgrade — so these must not be
    // overwritten unconditionally.
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
    // The three namespace the library brought, null until `show()` has it.
    this.three = null;
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
    // Where a part is turned about and which way it faced before any turn
    // (`pivot` and `facing` in parts.js); read off the scene before the part
    // moved, and invalid once those groups are gone.
    this.partPivot = new Map();
    this.partFacing = new Map();
    // How coarsely a drag of each path rounds, in millimetres, where the
    // interface set it (`setSnapSteps`); otherwise `niceStep` in tools.js.
    this.snapSteps = new Map();
    // The ids of the pointers currently down on the canvas, not a flag: two
    // fingers are two presses. Only `installIdleClock` writes it.
    this.pointersDown = new Set();
    // -Infinity, not 0: `lastTouch` holds a `performance.now()` reading, which
    // is zero at the start of the navigation, so 0 would make `isBusy()` true
    // for the first IDLE_MS.
    this.lastTouch = -Infinity;
    this.trackpad = false;
    this.hoverText = "";
    this.loadToken = 0;
    // The two sources a scene is made of, both remembered. `payload` is the
    // last fetched view document, kept so the overlay can change without a
    // fetch; `overlayParts` is the proposal assembled in the browser
    // (ui/src/proposalgeom.js), which belongs to no build and must survive every
    // rebuild. Only `staged()` composes them.
    //
    // Not `this.overlay`, which is the measurement label's layer below.
    this.payload = null;
    // Which build the geometry on screen is of; `show()` says why it is not
    // `state.buildKey`.
    this.drawnKey = null;
    this.overlayParts = [];
    // Both are reset because a re-attached element starts over: `statusPatched`
    // guards `muteStatusLine`, which patches the library's `Display`, and a new
    // attach builds a new display. `loadFailed` would stop a fresh element from
    // ever loading the view.
    this.statusPatched = false;
    this.loadFailed = null;
    this.holdActive = false;

    this.overlay = createOverlay(this);
    this.appendChild(this.overlay.root);

    // AFTER the overlay: the overlay's layer covers the whole canvas, and of two
    // absolutely-positioned siblings the later is painted on top, so a
    // measurement label never covers a cell.
    this.viewcube = createViewCube(this);
    this.appendChild(this.viewcube.root);

    // The section grip, the move tool's arrows/quads/dot, its rotation handles
    // and the comment arrows are meshes in the library's own scene
    // (`scene3d.js`), so they have no root to append; their lifecycle lines are
    // in `show()`.
    //
    // A press goes by paint band, not by this order: `joinPresses`
    // (scene3d.js) asks the top band first, and the move tool's arrows are on
    // top. Only the hover cursor goes by creation order.
    this.gizmo = createGizmo(this);
    this.handle = createHandle(this);
    this.rings = createRings(this);
    this.pins = createPins(this);

    setPointingDevice(this, initialPointingDevice(), false);

    this.teardown = [
      installWheel(this),
      installOrbit(this),
      // Its release must run before the tool's. The guard adds its
      // capture-phase window `pointerup` here at install, while tools.js and
      // orbit.js add theirs inside their own `pointerdown`; same-phase listeners
      // run in registration order. Its release flushes a deferred `update`,
      // which re-marks the id-picker before the tool's release pick reads it.
      installPinchGuard(this),
      installIdleClock(this),
      installTools(this),
    ];

    // The hold key drives the CUT tool and overrides `state.tool` while down
    // without writing it: the interface owns that field, and a missed release
    // would leave them disagreeing. The interface is told so it can show the
    // cut is on (block 4).
    this.teardown.push(installHoldKey({
      onHold: () => {
        this.holdActive = true;
        emit(this, EVENT_TOOL, { tool: "cut", held: true });
      },
      onRelease: () => {
        if (!this.holdActive) return;
        this.holdActive = false;
        emit(this, EVENT_TOOL, { tool: this.state.tool || null, held: false });
        // The library draws on demand and only `hmr:state` pushes wake it; this
        // release emits `hmr:tool` alone, which the interface answers without a
        // push. So both halves of the manipulator (gizmo and rings) ask for one
        // frame (`scene3d.js`) to come back. Not needed on `onHold`: the press
        // that places the cut ends in a frame (`applySection`).
        this.gizmo.refresh();
        this.rings.refresh();
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
    if (this.gizmo) this.gizmo.destroy();
    // The rings also own a hover listener on the window (which knob is lit),
    // beside the one `scene3d.js` keeps for each widget.
    if (this.rings) this.rings.destroy();
    if (this.pins) this.pins.destroy();
    try {
      if (this.viewer) this.viewer.dispose();
    } catch (error) {
      console.warn("viewport dispose", error);
    }
    this.viewer = null;
    // The payload is released here: `show` keeps the parsed view file (a couple
    // of megabytes) so `setOverlay` can re-stage without a fetch, and a detached
    // element can linger in a React tree.
    this.payload = null;
    this.drawnKey = null;
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

    // The imperative flags are commands, not state ("drop the plane", "clear
    // the tape", "try that view again"), so they are acted on and removed from
    // `state`. `__retry` is acted on further down, where the load decision is.
    // There is no "forget the moves" flag: which parts stand displaced is the
    // proposal document's, asserted through `setMoves`.
    for (const flag of ["__resetCut", "__clearMeasure", "__retry"]) {
      delete this.state[flag];
    }
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
    // A swap is either of two changes: `buildKey` (the geometry was published
    // again) or `base` (a different revision of the same project). The same view
    // id under a new base names a different file.
    //
    // Both ignore a change from null, which is the first load: the element
    // starts with `base: null` and `buildKey: null`; the first load is caught by
    // the third disjunction below.
    const changed = (key) => patch[key] !== undefined && patch[key] !== before[key]
      && before[key] !== null;
    const swap = changed("buildKey") || changed("base");
    // A new view, a new build or an explicit retry clears `loadFailed`; nothing
    // else does. The first-load disjunction below is not one-shot on its own:
    // a 404 leaves `this.viewer` null, and the interface sends `hmr:state` on
    // every `set()` (tree clicks, view tabs, pins), so without `loadFailed`
    // every click would refetch and log an error.
    //
    // It is not a loop only because the interface's `hmr:error` handler uses
    // `setState`, not `set()`, so it sends no `hmr:state` back
    // (HammerolaViewer.jsx, the ERROR handler).
    //
    // `__retry` is the error panel's Retry button: `showView(id)` returns
    // immediately for the id already on screen, so a single-view build would
    // otherwise have no way back short of a page reload.
    const retry = !!patch.__retry;
    if (reload || swap || retry) this.loadFailed = null;
    if (reload || swap || retry
        || (this.state.view && !this.viewer && !this.loadFailed)) {
      // A build changed under the same view is a LIVE RELOAD and keeps the
      // frame; a different view is re-fitted (ui-brief block 2).
      //
      // A retry keeps the frame only when a scene is on screen showing the view
      // being refetched (a live reload whose fetch failed); after a failed view
      // switch the scene on screen is a different view.
      const live = !reload
        && (swap || (retry && !!this.viewer && this.view === this.state.view));
      this.load({ live });
      return;
    }
    this.reconcile();
  }

  /** Fetch a view file and render it. THE ONLY WAY A MODEL GETS IN.
   *
   * The element fetches for itself rather than being handed a payload, so a
   * live reload runs capture, fetch, render, restore in one order nothing can
   * interleave — states, camera, tab, then the cut. A second entrance would
   * invite driving the pipeline from a React render.
   *
   * `restage()` (behind `setOverlay()`/`clearOverlay()`) also calls `show`, but
   * with the document this method fetched, so it brings in no geometry.
   * Composition happens inside `show`, so a rebuild under an open proposal
   * re-applies the overlay by construction. A re-stage is live (frame, tree
   * states and cut survive) and keeps what a rebuild rightly drops: a
   * measurement and a dragged part's offset are about this build's geometry
   * (ui-brief blocks 6 and 7). See `show`.
   *
   * `loadToken` orders loads among themselves: the last one started owns the
   * scene. A re-stage takes the CURRENT token rather than a new one, so an
   * overlay edit during a fetch does not cancel the build on its way.
   */
  async load({ live } = {}) {
    const token = ++this.loadToken;
    const { views, view } = this.state;
    const list = Array.isArray(views) ? views : [];
    const chosen = list.find((v) => v && v.id === view) || list[0] || null;
    if (!chosen || !chosen.file) {
      // No file to fetch: report it, or the interface's `viewError` stays null
      // and block 11's panel is not drawn. Same `stage` as the failures below.
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
      // `fetch`, not a `<script type="module">`: data loaded as a module stays
      // in module scope and the scene renders empty with nothing in the console.
      //
      // Before anything is torn down, so a 404 leaves the current scene intact.
      //
      // The header goes only where the interface put a token in the state; a
      // build page's view files are public.
      //
      // `secret`, not `token`, which is the load-ordering number above.
      const secret = this.state.token;
      const response = await fetch(base + chosen.file,
                                   secret
                                     ? { headers: { "X-Hammerola-Token": secret } }
                                     : undefined);
      if (!response.ok) throw new Error(`${chosen.file} -> HTTP ${response.status}`);
      const shapes = await response.json();
      await this.show(shapes, { live, view: chosen.id, token });
    } catch (error) {
      if (token !== this.loadToken) return;
      // Remembered so the next `hmr:state` does not refetch (see `setState`),
      // and cleared there by a new view, a new build or a retry.
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
   * `restage` means "the same document, a different overlay": it brings no new
   * geometry, so the state measured against the model must survive it.
   * `restage()` below is the only caller that sets it.
   */
  async show(shapes, { live, view, token, restage }) {
    // Which view this call is about, resolved once, so every report names the
    // same one.
    const named = view === undefined ? this.state.view : view;
    if (!shapes || typeof shapes !== "object") {
      // A view file that parsed into a JSON scalar. Without the event the
      // interface's panel is never drawn, and without `loadFailed` every
      // `hmr:state` refetches.
      if (token !== this.loadToken) return;
      this.loadFailed = named || true;
      emit(this, EVENT_ERROR, {
        stage: "render", view: named || null,
        message: "the view file does not describe a model",
      });
      return;
    }
    try {
      // The whole namespace, not just the two classes: the widgets are built
      // from three, and the library leaves three external and re-exports its
      // namespace (`viewer/src/index.ts`).
      const library = await loadViewerLibrary();
      const { Viewer, Display } = library;
      // Another load overtook this one — the reader clicked twice, or a build
      // landed mid-fetch. The newer one owns the scene.
      if (token !== this.loadToken || !this.booted) return;

      // The two sources composed once, for the render and for the tree sent up
      // with it. `shapes` is remembered as it arrived, so the next stage
      // composes the model, not the overlay with itself.
      const scene = staged(shapes, this.overlayParts);

      // A gesture the reader has not let go of ends here, before anything is
      // torn down: what it holds was measured against the outgoing scene.
      if (this.endGesture) this.endGesture();
      // The grip, the arrows/quads and the rings each take their press in a
      // window listener that neither `endGesture` nor the idle clock sees, so
      // each is concluded separately. The manipulator's drags report rather
      // than abandon: the part stands moved or turned in `this.moved` with no
      // node claiming it, and the next push would send it home.
      this.handle.endDrag();
      this.gizmo.endDrag();
      this.rings.endDrag();

      const keep = live ? captureLive(this) : null;
      const [w, h] = sized(this);
      // The cut goes before the scene it was measured against, and before
      // `clear()`, which switches the library to its Tree tab — a standing seed
      // would make `keepSectionCut` re-assert clipping on a scene being torn
      // down.
      this.sectionSeed = null;
      // The outline children hung on the scene's own ObjectGroups, so they are
      // gone with it — the rebuild memo has to be, or it would suppress the
      // first outline of the new scene (outline.js).
      this.sectionOutlineKey = null;
      // What a rebuild invalidates and a re-stage does not. The tape and the
      // offsets belong to the outgoing geometry: a rebuild puts every part back
      // (ui-brief block 6), and the interface drops its move nodes off the model
      // event (see the `restage` flag below). A re-stage is the same model with a
      // different overlay, so clearing would snap dragged parts home and drop a
      // measurement on every proposal edit.
      if (!restage) {
        this.measurePicks = [];
        this.measureLabel = null;
        this.moved.clear();
        this.partHome.clear();
        this.partPivot.clear();
        this.partFacing.clear();
        // Snap steps are keyed by path, and a path is only as stable as the
        // build (`/model/pin(2)` can name a different part next build).
        this.snapSteps.clear();
      }

      if (!this.viewer) {
        const opts = {
          ...displayOptions, cadWidth: w, height: h, treeWidth: treeWidth(w),
        };
        this.viewer = new Viewer(new Display(this.box, opts), opts,
                                 (changes) => this.onNotify(changes), null);
      } else {
        // The widgets come out of the scene before `clear()`, which runs
        // `deepDispose` over everything in it (viewer/src/core/viewer.ts). Their
        // groups are built once and kept, so disposal would free geometry and
        // materials nothing rebuilds.
        this.handle.detach();
        this.gizmo.detach();
        this.rings.detach();
        this.pins.detach();
        this.viewer.clear();
      }
      this.viewer.render(scene, renderOptions, viewerOptions);
      // And back into the new THREE.Scene `render()` just built. The namespace
      // is handed over here because this is where the page has it.
      this.handle.attach(library.THREE);
      this.gizmo.attach(library.THREE);
      this.rings.attach(library.THREE);
      this.pins.attach(library.THREE);
      // Kept for the comment tool, which casts a ray at the picked part for the
      // exact normal under the click (`meshNormalAt` in tools.js).
      this.three = library.THREE;
      // Only now does the widget exist to be measured; the first pass asked for
      // the whole container, so re-fit it to what is left once its own chrome is
      // accounted for. A no-op on every later call.
      measureChrome(this, w, h);
      refit(this);
      const g = internals(this.viewer);
      if (g) muteStatusLine(this, g.display);
      // The cut faces are hatched here only: the library builds its cap meshes
      // per (plane, solid) inside `render()` and drops them on `clear()` (see
      // hatch.js for the other path that rebuilds them).
      //
      // `safeHatch`, the guarded entry point: this method's catch replaces the
      // model with the error panel and sets `loadFailed`, so a decoration must
      // not throw here. The guard lives in hatch.js so a test can make it throw.
      //
      // A scene rendered with `cutHatch` off comes up patched but hatching
      // nothing, so the toggle stays a uniform write.
      safeHatch(g, this.state.cutHatch);
      // Parts flush in one plane are given a fixed winner here: `render()` has
      // just built fresh materials, and the offset lives on them. Guarded
      // inside, like the hatch.
      settleCoplanar(this.viewer.nestedGroup, scene);
      this.view = named;
      // What is on screen, remembered beside the view for `restage()`. Set only
      // after the render succeeded: a refused document would otherwise be handed
      // back to the library on every keystroke.
      this.payload = shapes;
      // Which build the geometry on screen is of — not `state.buildKey`, which
      // moves when the interface announces a swap, before the fetch in `load()`
      // completes. Nothing disarms the Move tool in between, so a press there
      // would be stamped with a key the scene has not reached; across a
      // revision a path can be a different part. Set here, beside the payload.
      this.drawnKey = this.state.buildKey;
      this.lastPick = null;
      this.applied = {
        hidden: null, ghost: null, selected: undefined, camera: null,
        cutHatch: null,
      };
      this.reconcile();
      if (keep) restoreLive(this, keep);
      // Keeping the offsets is not keeping the parts where they were: `clear()`
      // disposed the groups the drag was written on and `render()` built new
      // ones at home. After `restoreLive` (which re-asserts tree states), so the
      // offset is the last thing written to a group's position.
      if (restage) restageMoves(this);
      this.overlay.refresh();
      // The tree travels with the render: the nesting and colours come from
      // the payload, and whether the library answers for a leaf comes from the
      // scene just built.
      emit(this, EVENT_MODEL, {
        view: this.view,
        buildKey: this.state.buildKey,
        // The staged document, not the fetched one, so the overlay's bodies are
        // rows like everything else on screen.
        tree: treeFromShapes(scene, statesOf(this.viewer)),
        live: !!live,
        // The interface's `onModel` drops the measurement chip and the
        // document's moves on every model event, which is wrong for a re-stage.
        // `live` cannot tell: a rebuild under the reader's camera is live too.
        restage: !!restage,
      });
    } catch (error) {
      if (token !== this.loadToken) return;
      // As in `load`: a failure before the widget exists (the library module
      // not loading) leaves `viewer` null, and `setState`'s first-load branch
      // would come straight back here. `|| true` because `named` may be null and
      // the flag is read as a boolean.
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
    // By value: `selectedPaths` in HammerolaViewer mints a new array on every
    // push, and one push goes out per section-slider step, so an identity
    // check would repaint the highlight every time.
    if (!same(s.selected, this.applied.selected)) {
      applySelected(this.viewer, s.selected);
      this.applied.selected = s.selected;
    }
    if (s.camera && !same(s.camera, this.applied.camera)) {
      this.setCamera(s.camera);
      this.applied.camera = s.camera;
    }
    // The cut is a thing that is on, not a mode (ui-brief block 4): turning it
    // off keeps the plane. `suspendSectionCut` parks the slider where the
    // library's own reset does, which cuts nothing, and leaves the normal alone.
    if (s.cut && this.sectionSeed) applySection(this);
    else if (!s.cut) suspendSectionCut(this);
    // A `cutHatch` change arrives here (no reload), and reconcile runs once per
    // slider step, so it is memo'd against `applied` and the toggle is a
    // uniform write, not a recompile (hatch.js `setCutHatch`). After a render
    // this re-asserts the value the fresh materials were patched with.
    if (!same(s.cutHatch, this.applied.cutHatch)) {
      setCutHatch(internals(this.viewer), s.cutHatch);
      this.applied.cutHatch = s.cutHatch;
    }
    // The pixel ratio, asked of the renderer rather than memo'd in `applied`
    // (which every render resets): `setPixelRatio` reallocates the drawing
    // buffer, so it runs only when the ratio changes. A fresh viewer starts at
    // the display's density; the reconcile after its first render corrects it.
    // The hatch pitch is in framebuffer pixels (hatch.js `hatchPitchPx`), so the
    // caps are updated too.
    const renderer = this.viewer.renderer;
    const want = s.retina === false ? 1 : (window.devicePixelRatio || 1);
    if (renderer.getPixelRatio() !== want) {
      renderer.setPixelRatio(want);
      setCutHatch(internals(this.viewer), s.cutHatch);
      this.viewer.update(true, true);
    }
    // The comment arrows follow the list, and ask for the frame that draws them.
    this.pins.setPins(s.pins);
    // The widgets are placed by the library's render pass (`scene3d.js`), so
    // `refresh` asks for a frame. The grip comes and goes with the cut; the
    // arrows/quads/dot and the rings with the Move tool and the selection.
    this.handle.refresh();
    this.gizmo.refresh();
    this.rings.refresh();
  }

  /** The library's notification channel. */
  onNotify(changes) {
    if (!changes) return;
    if (changes.lastPick && changes.lastPick.new) {
      // A fallback source of a part name: `pickAt` gives part and point, but it
      // is a lower-level entry point, so if a library upgrade moves it a comment
      // still gets an anchor, without the coordinate.
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
    // The library reports these four on every frame the camera moved and at the
    // end of a render (its fit of the new scene); `setCamera` passes
    // `notify: false`, so a frame the interface put on screen is not echoed.
    if (changes.position || changes.quaternion || changes.target || changes.zoom) {
      emit(this, EVENT_CAMERA);
    }
  }

  // -- the imperative half ---------------------------------------------------
  // Questions rather than state, so they are methods rather than events: a
  // comment needs the frame and a PNG of it AT THE MOMENT SEND IS PRESSED, and
  // routing that through an event round-trip would mean keeping a copy of both
  // in React, refreshed on every camera move.

  /**
   * Lay a second source of parts over the model — the proposal panel's rough
   * bodies (a statement to the agent, ui-brief block 6).
   *
   * A method, not an event: it answers a person typing in a field, not a state
   * the interface holds a second copy of.
   *
   * It does not fetch or replace the model: it changes one of the two lists
   * `staged()` composes, and a later rebuild composes the overlay in again.
   */
  setOverlay(parts) {
    const next = Array.isArray(parts) ? parts : [];
    // An overlay already on screen is not a change, and answering it costs a
    // full scene teardown (see `sameParts`). The panel asks for it often: an
    // empty overlay over an empty one, and every stage while the branch eye is
    // shut.
    if (sameParts(next, this.overlayParts)) return Promise.resolve();
    this.overlayParts = next;
    return this.restage();
  }

  /** Take the overlay off again. Callers: the branch's eye shut (via
   * `stageProposal`, also taken by a refused document while the eye is down),
   * the reader giving up the edit token, and a stage that builds no geometry. */
  clearOverlay() {
    return this.setOverlay([]);
  }

  /**
   * Which parts of the BUILD stand displaced, as the whole list of them:
   * `{paths, delta, turn}` per entry — world units, and three degrees about the
   * part's own centre.
   *
   * The counterpart of `setOverlay`: that lays bodies the reader drew, this
   * shifts parts the model already has. Both read off the proposal document
   * (ui/src/proposal.js), pushed whenever it changes, so the document decides
   * where a part stands.
   *
   * The whole list: putting a part back is deleting its entry, so the call must
   * be able to say "nothing else is moved" — `reconcileMoves` puts back exactly
   * the paths no longer claimed.
   *
   * Not a re-stage: synchronous, nothing rebuilt. The offsets survive the next
   * re-stage through `restageMoves`, which works off `vp.moved`.
   */
  setMoves(list) {
    reconcileMoves(this, Array.isArray(list) ? list : []);
  }

  /**
   * How coarsely a drag rounds, per path: `{path, step}` per entry, in
   * millimetres.
   *
   * The whole set every time: an override is removed by being left out.
   *
   * A path with no entry falls back to `niceStep` (viewport/tools.js).
   *
   * Nothing on screen changes: it is read at the next drag (`gizmo.js`).
   */
  setSnapSteps(list) {
    this.snapSteps = new Map((Array.isArray(list) ? list : [])
      .map((entry) => [entry.path, entry.step]));
  }

  /**
   * Is this path one of the overlay's own bodies rather than a part of the
   * model?
   *
   * Asked of the scene as it stands. A staged body is an ordinary pick target,
   * so without this the Comment tool would file a task in the build's terms
   * (`partId: "/<root>/proposal/motor"`) against a body in no build. The group
   * name is minted here against the model's parts, so only here can it be told
   * apart from a model part honestly called `proposal`.
   *
   * `computed()` in HammerolaViewer.jsx also uses it to locate the group, so the
   * proposal branch can resolve each body to its staged row and the parts tree
   * can leave those rows out; `onModel` uses the same lookup to carry a
   * selection onto a body's new path.
   *
   * The Move tool asks it too (`grabbable` in viewport/parts.js): a proposal
   * body is dragged as an edit (`hmr:proposalmove` instead of `hmr:moved`), and
   * a mixed grab of a body and a model part is refused whole.
   *
   * The group node itself answers yes: `overlayBody` builds on this and returns
   * null for the group (how the Move tool refuses dragging it), and `computed()`
   * locates the group by asking this of the group's own path.
   *
   * With `overlayParts` empty nothing is an overlay body. What empties it is
   * the branch's eye, the token being given up, or a document with no geometry —
   * not closing the sheet.
   */
  isOverlay(id) {
    if (!this.payload || !this.overlayParts.length) return false;
    if (typeof id !== "string") return false;
    const { at } = overlayAt(this.payload);
    return id === at || id.startsWith(`${at}/`);
  }

  /**
   * Which BODY of the overlay this path is, by the name the panel drew it under
   * — or null for everything else, the overlay's own group node included.
   *
   * `isOverlay` one segment further in: the panel's document is a list of named
   * bodies, so "this body moved" is about `bore`, not `/<root>/proposal/bore`.
   * The name is the part's `name` in the payload the panel built
   * (proposalgeom.js), one part per body.
   *
   * The group answers null: it stands for no body, and a drag reported as
   * `proposal` would match no node and leave the body displaced against the
   * document. Refused at the press instead, where the gesture becomes a
   * rotation.
   *
   * One segment and no deeper: a path under a body's subtree names no node.
   */
  overlayBody(id) {
    if (!this.isOverlay(id)) return null;
    const { at } = overlayAt(this.payload);
    if (!id.startsWith(`${at}/`)) return null;
    const name = id.slice(at.length + 1);
    return name && !name.includes("/") ? name : null;
  }

  /**
   * The remembered document back on screen, composed with the overlay as it now
   * stands.
   *
   * Nothing to stage is not a failure: an overlay set before any view has
   * landed is remembered, and the following load composes it in.
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

  /** Where an arrow stands on one part: the top of its world box (centre in x
   * and y, highest z), or null.
   *
   * Asked per comment whose anchor is a PART rather than a point, so the arrow
   * follows the part through a rebuild that moved it. Such an arrow carries no
   * normal and stands from above, so it stands on the top of the part's box;
   * at the centre the part itself would hide it (`partTop`).
   */
  partPoint(path) {
    return partTop(this.viewer, path);
  }

  /** Where a point and a face normal taken in ANOTHER view of this build stand
   * on the part at `path` in this one: `{p, n}`, or null when the scene draws no
   * part there. `n` is null when no normal is given.
   *
   * A view moves a part and keeps its vertices, so the point is taken out of
   * `from` (`{position, quaternion}`, where that view placed the part,
   * `hub.placementIn`) and put back where this scene stands it:
   * `M_here · M_from⁻¹`. The normal takes the rotation only.
   *
   * `M_here` is `front.matrixWorld`, recomposed first, as `partCentre` reads it,
   * so a part the reader dragged takes its arrow along. It is the composed locs
   * and nothing more: the library hangs the document's root group straight on
   * the scene (`buildInitialGroup`, viewer/src/core/viewer.ts) and `front` at
   * the identity in its part's group (`renderShape`,
   * viewer/src/scene/nestedgroup.ts).
   */
  carryPoint(path, from, point, normal) {
    const three = this.three;
    const g = internals(this.viewer);
    const group = g && g.nestedGroup && g.nestedGroup.groups
      ? g.nestedGroup.groups[path] : null;
    const front = group && group.front;
    if (!three || !front || !front.matrixWorld) return null;
    group.updateMatrixWorld();
    const source = new three.Matrix4().compose(
      new three.Vector3(...from.position),
      new three.Quaternion(...from.quaternion),
      new three.Vector3(1, 1, 1));
    const m = front.matrixWorld.clone().multiply(source.invert());
    const p = new three.Vector3(...point).applyMatrix4(m);
    const n = normal ? new three.Vector3(...normal).transformDirection(m) : null;
    return { p: [p.x, p.y, p.z], n: n ? [n.x, n.y, n.z] : null };
  }

  /** This frame as a PNG blob, for the snapshot a comment carries. */
  snapshot(label) {
    return snapshot(this, label);
  }

  /** True while a gesture is in progress and a build swap would yank the model. */
  isBusy() {
    return isBusy(this);
  }

  /** Visibility, as the library holds it. Not called yet; kept for an
   *  interface-driven swap (the viewport does its own today, `captureLive`). */
  getStates() {
    return statesOf(this.viewer);
  }

  /** Which tool is really in force, hold key included. */
  get activeTool() {
    return this.holdActive ? "cut" : (this.state.tool || null);
  }

  /** Re-fit to the container. Not called yet: the `ResizeObserver` in
   *  `connectedCallback` covers every layout change the interface makes. This
   *  is for changes that never reach the element's box (an ancestor transform,
   *  a device pixel ratio changed by moving the window between screens). */
  refit() {
    refit(this);
  }
}
