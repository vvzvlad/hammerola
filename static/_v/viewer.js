// Shared viewer for every project and every build.
// The page is identical everywhere; what it shows comes from its own URL:
//   /project/<pid>/latest/   /project/<pid>/dev/   or   /project/<pid>/<commit>/
import { Viewer, Display } from "/_v/three-cad-viewer.esm.js";
import { POINTER_NAMES, rememberPointer } from "/_v/pointer_pref.js";

const $ = (id) => document.getElementById(id);
const fail = (stage, e) => {
  $("err").style.display = "block";
  $("err").textContent = `FAILED at ${stage}\n\n${e && e.stack ? e.stack : e}`;
  console.error(stage, e);
};

// The build directory is simply where this page lives; nothing to configure.
const BASE = location.pathname.replace(/[^/]*$/, "");
const PID = location.pathname.split("/")[2];
// The last segment of that URL: a commit id, or one of the two moving names
// (`latest`, `dev`). It is HOW this page was reached, which is a different
// question from which build answered — and the build picker has to show the
// former, because that is what the reader would be navigating away from.
const SLOT = location.pathname.split("/")[3];

// The meta.json of the build currently ON SCREEN. Module-level and not a
// parameter passed around, because on a pointer page it is replaced whenever the
// author publishes (see "live reload" below) and everything that reads it —
// where a comment is posted, what the downloads point at — has to follow the
// swap rather than keep answering for the build the page opened with.
let meta = null;

const box = $("cad_viewer");
// Everything that edits APPEARANCE is off. This is a snapshot page: the model is
// whatever the commit says it is, and a viewer setting a reader changes is lost on
// the next reload anyway. Upstream ships these on because OCP CAD Viewer is an
// interactive workbench, where someone is tuning how a part looks while modelling.
//
// `studioTool` is the expensive one: it carries its own postprocessing composer
// (postprocessing + n8ao), which is a visible share of the 3.4 MB bundle.
const displayOptions = {
  glass: true, tools: true, theme: "dark", treeWidth: 240,
  cadWidth: 800, height: 600,
  measureTools: false,   // needs a backend we do not run (SPEC 2.4)
  // Off for ordinary viewing and turned on only in comment mode, through
  // `viewer.showSelectTool(true)` (SPEC 7A.6). A reader who is just looking at a
  // model has no use for selecting parts; a reader leaving a comment has to be
  // able to point at one.
  selectTool: false,
  explodeTool: true,     // genuinely useful on an assembly, and read-only
  zscaleTool: false,
  zebraTool: false,
  studioTool: false,     // lighting studio: appearance only
};
const renderOptions = {
  ambientIntensity: 1.0, directIntensity: 1.1,
  metalness: 0.3, roughness: 0.65,
  edgeColor: 0x707070, defaultOpacity: 0.5, normalLen: 0,
};
const viewerOptions = {
  // `trackball`, not `orbit`. OrbitControls keeps a fixed up axis and clamps the
  // polar angle (minPolarAngle/maxPolarAngle), so rotation stops dead at the poles
  // — you cannot get under a part or look at it from an arbitrary angle, which is
  // exactly the view someone usually wants when something looks wrong.
  //
  // The library's own note: "orbit: familiar Google Maps style rotation" versus
  // "trackball: unrestricted rotation with optional Holroyd mode". Holroyd is the
  // non-tumbling projection — it keeps the model from rolling into a disorienting
  // pose while still allowing any direction — and CADTrackballControls sets
  // `this.holroyd = true` by DEFAULT, so this needs no second option.
  ortho: true, control: "trackball", up: "Z",
  axes: false, axes0: false, grid: [false, false, false],
  transparent: false, blackEdges: false, collapse: 1,
};

let viewer = null;

// cadWidth/height describe the CANVAS, but the viewer wraps it in chrome of its
// own -- a margin on its root, margins and padding on the toolbar and view rows,
// and the toolbar row itself once `tools` is on. Handing it the raw container
// size therefore builds a widget wider and taller than the container, and
// #cad_viewer (overflow:hidden, deliberately) clips the difference: the right
// end of the toolbar and the bottom of the canvas simply disappear. Measured off
// the DOM rather than hardcoded, so restyled chrome in a viewer upgrade cannot
// quietly put the numbers out of date. One shot -- after the first correction
// the root is `requested + chrome`, so measuring again would read back zero.
let viewerChrome = [0, 0];
let viewerChromeKnown = false;
const measureChrome = (reqW, reqH) => {
  const root = box.querySelector(".tcv_cad_viewer");
  if (!root || viewerChromeKnown) return;
  const cs = getComputedStyle(root);
  const mx = parseFloat(cs.marginLeft) + parseFloat(cs.marginRight);
  const my = parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
  viewerChrome = [Math.max(0, root.offsetWidth + mx - reqW),
                  Math.max(0, root.offsetHeight + my - reqH)];
  viewerChromeKnown = true;
};

// Size from the CONTAINER, never from the window: an assumed header height puts
// the header off-screen the moment it is wrong (SPEC 5.2).
const sized = () => [Math.max(320, box.clientWidth - viewerChrome[0]),
                     Math.max(240, box.clientHeight - viewerChrome[1])];

// The tree floats over the canvas in glass mode, and a fixed 240px of it is half
// of a 500px screen -- the model ends up behind the file list. Keep 240 as the
// ceiling so nothing changes on a desktop, and let it shrink with the canvas
// below that.
const treeWidth = (w) =>
  Math.max(120, Math.min(displayOptions.treeWidth, Math.round(w * 0.4)));

const refit = () => {
  if (!viewer) return;
  const [w, h] = sized();
  // The 4th argument is `glass`, and it defaults to false. Leaving it out means
  // the viewer silently drops out of glass mode -- the tree stops floating over
  // the canvas and the layout jumps.
  viewer.resizeCadView(w, treeWidth(w), h, displayOptions.glass);
};

// What the viewer last reported as picked, kept as the FALLBACK source of a part
// name: `idPicker.pickAt` below gives both the part and the exact point, but it
// is a lower-level entry point than the notification, so if a library upgrade
// moves it the comment still gets an anchor — just without the coordinate.
let lastPick = null;
// Which of the library's sidebar tabs the reader has open. Tracked here because
// the library has no getter for it, and a live reload has to put the reader back
// on the tab they were on. `render()` parks it on "tree" with notify=false, so
// this value survives a swap and is exactly the pre-swap tab.
// Seeded with the library's own runtime default (`ViewerState.RUNTIME_DEFAULTS`
// has `activeTab: "tree"`), which is set without a notification and would
// otherwise leave this null until the reader clicks a tab for the first time.
// That null was not free: the hold key has to put the reader back where they
// were, and "nowhere recorded yet" is precisely the state a first-time reader
// is in when they hold C on the tree they have been looking at all along.
let currentTab = "tree";
const onNotify = (changes) => {
  if (!changes) return;
  if (changes.lastPick && changes.lastPick.new) {
    lastPick = changes.lastPick.new;
  }
  // `tab` is the library's outward name for its `activeTab` state, and this is
  // the same notification its own tab machinery subscribes to — which is why
  // the section tool can hang the restore of the cut off it instead of watching
  // the tab buttons for clicks. Anything but `clip` has just turned clipping
  // off inside the library; see keepSectionCut.
  if (changes.tab && changes.tab.new) {
    currentTab = changes.tab.new;
    if (currentTab !== "clip") {
      // A tab other than `clip` arriving while a hold owes a restore is the
      // reader picking one themselves: the tool only ever switches TO `clip`,
      // and the restore runs after the hold is already over. Their choice is
      // newer than the tab saved when the key went down, so the debt is off —
      // returning them to where they were two clicks ago would be the same
      // wrong-place problem this restore exists to fix.
      sectionTabBeforeHold = null;
      keepSectionCut();
    }
  }
};

// The variant currently on screen, so a comment can say which view it was
// written against (SPEC 7A.1).
let currentView = null;

async function showVariant(id) {
  const v = meta.variants.find((x) => x.id === id) || meta.variants[0];
  // fetch, NOT `<script type="module">`: data loaded as a module stays inside the
  // module scope, the scene renders empty and nothing appears in the console
  // (SPEC 5.1 — this one has already cost a debugging session).
  const r = await fetch(BASE + v.file);
  if (!r.ok) throw new Error(`${v.file} -> HTTP ${r.status}`);
  const shapes = await r.json();
  const [w, h] = sized();
  // The cut goes before the scene it was measured against does: a depth taken
  // from a face of the variant that is about to leave the screen would be a
  // number about nothing. Before `clear()` and not after, because `clear()`
  // switches the library back to its Tree tab, and a seed still standing at
  // that moment would have keepSectionCut re-assert clipping on a scene that is
  // being torn down.
  //
  // Unconditional, and that is the whole difference between the two ways a
  // scene gets replaced. Picking `print` instead of `assembled` is a reader
  // choosing a different shape to look at, and a cut measured on the other one
  // has nothing to say about it. A LIVE RELOAD is the same shape published
  // again, so swapBuild captures the plane in world coordinates on the way in
  // and restoreLive puts it back afterwards (SPEC 8.8) — the reset here is what
  // that restore starts from.
  endSectionDrag();
  sectionSeed = null;
  if (!viewer) {
    const opts = { ...displayOptions, cadWidth: w, height: h, treeWidth: treeWidth(w) };
    viewer = new Viewer(new Display(box, opts), opts, onNotify, null);
  } else {
    viewer.clear();
  }
  viewer.render(shapes, renderOptions, viewerOptions);
  // Only now does the widget exist to be measured; the first pass above asked
  // for the whole container, so re-fit it to what is left once its own chrome is
  // accounted for. A no-op on every later call.
  measureChrome(w, h);
  refit();
  currentView = v.id;
  lastPick = null;
  // `render` rebuilds the scene and the toolbar's tool visibility with it, so
  // comment mode has to re-assert the select tool after every variant switch.
  // After refit(), so the tool is re-asserted on the final layout.
  applyCommentMode();
  // Same for the section tool; its plane was already dropped above.
  applySectionMode();
  const q = id === meta.variants[0].id ? "" : "?v=" + id;
  history.replaceState(null, "", BASE + q);
}

// -- comments (SPEC 7A) -----------------------------------------------------
// The page can WRITE to the queue and can never read it back, which is why
// nothing below ever displays a comment: not this visitor's, not anyone's. The
// only feedback is "sent" or a failure, and that is a deliberate design choice
// rather than an unfinished feature — it leaves this page with no path at all
// from a stranger's text to somebody else's browser (SPEC 7A.4).
//
// Everything here is built with textContent on elements that are already in the
// template. No innerHTML anywhere, for the same reason the downloads list above
// is assembled through the DOM.

// What a status code means to the person who pressed Send. Mapped to fixed
// sentences rather than showing the hub's own message: the reply body is JSON we
// wrote, but nothing on this page should be in the habit of putting a response
// into the document.
const SEND_MESSAGES = {
  201: "Sent — thank you.",
  404: "This build is no longer available.",
  413: "Too large. Try a smaller photo.",
  422: "The hub refused this comment. Is the photo a JPEG, PNG or WebP?",
  429: "Too many comments from here. Try again in a few minutes.",
};

let commentMode = false;
let anchor = null;  // {part, point} — where on the model this comment points
let commentSending = false;   // a POST is in flight; see liveBusy()

const commentStatus = (text, kind) => {
  const el = $("comment_status");
  el.textContent = text;
  el.className = kind || "";
};

function applyCommentMode() {
  // The library's own select tool, on only while commenting (SPEC 7A.6).
  try {
    if (viewer && typeof viewer.showSelectTool === "function") {
      viewer.showSelectTool(commentMode);
    }
  } catch (e) {
    console.warn("select tool", e);
  }
}

function setCommentMode(on) {
  // The section tool owns press-and-drag on the canvas; commenting owns the
  // double click. Arming one disarms the other (SPEC 7B).
  if (on && sectionMode) setSectionMode(false);
  commentMode = on;
  $("comment_panel").hidden = !on;
  $("comment_btn").setAttribute("aria-pressed", String(on));
  applyCommentMode();
  // BOTH directions, and before the early return below. The panel is a sibling of
  // #cad_viewer in the page's flex column, so showing it takes height away from the
  // canvas and hiding it gives that height back — but the viewer sizes itself once,
  // from its container, and never notices either on its own.
  //
  // This used to sit after `if (!on) return`, so it ran on open and not on close:
  // the canvas shrank correctly, then stayed shrunk after the comment was sent,
  // leaving a dead black band along the bottom of the page until a manual window
  // resize. Reported from a real model, not a test.
  refit();
  if (!on) return;
  anchor = null;
  showAnchor();
  commentStatus("", "");
}

function showAnchor() {
  const hint = $("comment_hint");
  if (!anchor) {
    hint.textContent = "Double-click a part to anchor the comment.";
    hint.className = "";
    return;
  }
  // The part name comes from the pushed view file, which the hub already
  // validated on the way in (render.check_view_file), and it goes in as TEXT.
  hint.textContent = anchor.part;
  hint.className = "set";
}

/** Turn a double-click on the canvas into {part, point}. */
function pickAnchor(event) {
  if (!commentMode || !viewer) return;
  let part = null;
  let point = null;
  try {
    const canvas = viewer.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const hit = viewer.idPicker.pickAt(event.clientX - rect.left,
                                       event.clientY - rect.top);
    if (hit && hit.info) {
      // The same rule the library uses to turn a face/edge/vertex hit into the
      // solid that owns it, spelled out here because the helper is internal.
      part = hit.info.solidPath ||
        String(hit.info.path).replace(/\/(faces|edges|vertices)\/[^/]+$/, "");
      if (hit.point) point = [hit.point.x, hit.point.y, hit.point.z];
    }
  } catch (e) {
    console.warn("pick", e);
  }
  if (!part && lastPick && lastPick.path) part = `${lastPick.path}/${lastPick.name}`;
  if (!part) return;
  anchor = { part, point: point && point.every(Number.isFinite) ? point : null };
  showAnchor();
}

/** The frame this comment was written in front of, so the link reopens it. */
function cameraState() {
  try {
    if (typeof viewer.getCameraLocationSettings === "function") {
      const c = viewer.getCameraLocationSettings();
      return { position: c.position, quaternion: c.quaternion,
               target: c.target, zoom: c.zoom };
    }
    return {
      position: viewer.getCameraPosition(),
      quaternion: viewer.getCameraQuaternion(),
      target: viewer.getCameraTarget(),
      zoom: viewer.getCameraZoom(),
    };
  } catch (e) {
    // A comment without a camera is still a useful comment: the part name is
    // what leads to the code (SPEC 7A.1). Losing the frame must not lose it.
    console.warn("camera", e);
    return null;
  }
}

/** The viewer's own render of the current frame, as a PNG blob.
 *
 * `getImage` and NOT `pinAsPng`: pinAsPng builds an <img> and, when a
 * pinAsPngCallback is set, does nothing else with it — the callback is only ever
 * read as a null check in the vendored bundle, so it never delivers the data
 * URL. `getImage` is the public API pinAsPng itself calls to produce exactly the
 * same screenshot.
 *
 * Decoded by hand rather than with `fetch(dataUrl)`: the page's CSP is
 * `default-src 'self'`, connect-src inherits it, and a data: URL is not 'self'.
 */
async function shotBlob() {
  const prefix = "data:image/png;base64,";
  try {
    const data = await viewer.getImage("comment");
    const url = data && data.dataUrl;
    if (typeof url !== "string" || !url.startsWith(prefix)) return null;
    const raw = atob(url.slice(prefix.length));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return new Blob([bytes], { type: "image/png" });
  } catch (e) {
    console.warn("shot", e);
    return null;
  }
}

async function sendComment() {
  const text = $("comment_text").value.trim();
  if (!text) {
    commentStatus("Write something first.", "bad");
    return;
  }
  const form = new FormData();
  form.append("comment", JSON.stringify({
    text,
    view: currentView,
    part: anchor ? anchor.part : null,
    point: anchor ? anchor.point : null,
    camera: cameraState(),
  }));
  const chosen = $("comment_photo").files[0];
  if (chosen) form.append("photo", chosen, "photo");
  const shot = await shotBlob();
  if (shot) form.append("shot", shot, "shot.png");

  // Addressed by what meta.json says this build IS, never by how the page was
  // reached: the comment is about the geometry in front of the reader, and
  // `latest` will be a different build tomorrow. On the local slot the two
  // coincide — `dev` is both the name and the id — which is as close as a
  // build with no commit can get, and its audience is the person watching it.
  const r = await fetch(`/api/v1/comments/${PID}/${meta.commit}`,
                        { method: "POST", body: form });
  if (r.status === 201) {
    $("comment_text").value = "";
    $("comment_photo").value = "";
    anchor = null;
    showAnchor();
    commentStatus(SEND_MESSAGES[201], "ok");
    return;
  }
  commentStatus(SEND_MESSAGES[r.status] || "Could not send the comment.", "bad");
}

function setupComments() {
  $("comment_btn").onclick = () => setCommentMode(!commentMode);
  $("comment_cancel").onclick = () => setCommentMode(false);
  box.addEventListener("dblclick", pickAnchor);
  const send = $("comment_send");
  send.onclick = async () => {
    send.disabled = true;
    commentSending = true;
    commentStatus("Sending…", "");
    try {
      await sendComment();
    } catch (e) {
      console.error("comment", e);
      commentStatus("Could not reach the hub.", "bad");
    } finally {
      send.disabled = false;
      commentSending = false;
    }
  };
}

// -- section plane (SPEC 7B) -------------------------------------------------
// Section analysis, the Fusion move: click a face, the cutting plane takes that
// face's orientation and lands flush on it, then you drag the plane along its
// own normal to see what is inside. A tool for a PERSON — nothing here is
// stored, nothing rides along with a comment, and the agent side of the hub
// knows nothing about it.
//
// The library gives us the plane (`setClipNormal` takes an ARBITRARY normal;
// the axes in `resetClip` are only its defaults) and the movement
// (`setClipSlider`). What it does not give is the normal of a face, and the
// three functions below are the whole of what we add.
//
// Everything reached through `viewer.clipping`, `viewer.idPicker` and
// `camera.getCamera()` is the library's own plumbing rather than its public
// API. It is all funnelled through `sectionInternals()` for one reason: THIS IS
// THE FIRST PLACE A three-cad-viewer UPGRADE WILL BREAK. When a piece goes
// missing the tool goes quiet — the button stops doing anything — instead of
// throwing into a page that has already painted.

const SECTION_INDEX = 0;       // which of the three clip planes this tool drives
const SECTION_CLICK_PX = 4;    // pointer travel below which a press is a click
const SECTION_PROBE_PX = [7, 14, 26];   // ring radii for sampling the face
const SECTION_MIN_SPREAD = 0.2;         // sine between two samples to trust them
// ~8.6 deg. Below this the normal points nearly straight at the camera, its
// screen projection collapses and the px -> world factor runs away to infinity;
// no drag is better than a plane that teleports (SPEC 7B).
const SECTION_MIN_SINE = 0.15;
// Depth bias, as a fraction of the grid. A plane laid EXACTLY on a face is
// coplanar with it, and the library's stencil cap quad and the face itself then
// z-fight over every pixel: measured in the browser, the whole part comes back
// covered in moving stripes and reads as broken. A ten-thousandth of the grid
// puts the plane just inside the surface, which clears it completely and is far
// below anything a reader could care about -- 0.009 mm on a 90 mm part, still
// 0.000 at the three decimals the depth is shown to. Relative to the grid so it
// scales with the model rather than being right for one size of part.
const SECTION_BIAS = 1e-4;

// -- the hold key -------------------------------------------------------------
// The second way into the tool: hold it and the tool is up, let go and it is
// gone. For the "just glance inside" that is not worth a trip to the header.
//
// WHY A PLAIN LETTER AND NOT A MODIFIER. Command was the obvious candidate and
// it does not survive contact:
//
//   * it is already spoken for INSIDE the library. Its `keyMapping` deliberately
//     permutes the modifiers (`{shift: "ctrlKey", ctrl: "shiftKey",
//     meta: "altKey", alt: "metaKey"}`), so `metaKey` reads as the logical `alt`
//     there, and the trackball pans on a left drag with ctrl/meta/shiftKey. The
//     flag is read off the POINTER event, not off a keydown we could swallow, so
//     there is nothing to intercept: we cannot strip a modifier from a native
//     pointermove;
//   * Cmd+wheel is the browser's own page zoom, and a hold-to-peek is exactly
//     when a reader reaches for the wheel;
//   * and it is the worst case for the stuck-key problem below. macOS hands
//     Cmd+Tab, Cmd+Space and every menu-bar shortcut to the system, taking the
//     keyup with them.
//
// A plain letter, then — but NOT any plain letter. The library has a shortcut
// table of its own (`ViewerState.DISPLAY_DEFAULTS.keymap`), it hangs
// `_handleKeyboardShortcut` on the CONTAINER, and a key it recognises is
// answered with `preventDefault(); stopPropagation()`. The container takes focus
// the moment anybody clicks the model, so from then on a colliding key never
// reaches this file at all. Its letters, measured off the bundle rather than
// guessed: A 0 g G p t b R r 5 1 3 8 2 4 6 x L D P I h space Escape T C M Z S,
// plus a/v/e/f/s while the topo-filter dropdown is open and Backspace with the
// select tool. `x` is `explode` — the first choice here, and it was silently
// eaten after every click on the part until this was found.
//
// So: C. `c` is free, `C` is the library's own Clip tab, and the tool this key
// holds up is the one that drives that tab's plane — the shift is the panel, the
// bare letter is the cut. It is also under the left hand while the right is on
// the mouse, which is what a hold-to-peek wants.
//
// The listeners below are registered in the CAPTURE phase for the same reason
// the collision was possible at all: capture on the window runs before anything
// on the container, so nothing downstream can swallow this key even if the
// library's table grows a `c` one day.
//
// Matched on `code`, not `key`: `code` is the physical key, so this still works
// on a Cyrillic layout, where the same key produces "с". `key` is the fallback
// for the rare input path that reports no code at all.
// There is no third constant for the LETTER shown to the reader. There was one
// while the tool had a panel that named the key it was being held up by; the
// only place that letter still appears is the Section button's own title in
// build.html, which is a static string in the template. The tie between the two
// files is held by a test instead (test_section_hold.py).
const SECTION_HOLD_CODE = "KeyC";
const SECTION_HOLD_KEY = "c";
const isSectionHoldKey = (e) =>
  (e.code ? e.code === SECTION_HOLD_CODE
          : String(e.key || "").toLowerCase() === SECTION_HOLD_KEY);

/** True when the keystroke belongs to something the reader is typing into.
 *
 * The comment form has a textarea, and a shortcut that fires while somebody is
 * writing a sentence is a shortcut that eats the sentence. A `<select>` counts
 * too — the two pickers in the header jump to an option by its first letter.
 *
 * "Any `<input>`" would be the wrong rule, and measurably so: the library's tab
 * strip is `<input>`, so are the Clip panel's checkboxes and the Settings
 * radios, and under that rule one click on Clip or on Trackpad would cost the
 * reader the shortcut with nothing on screen to explain it. Same test the
 * library applies in its own `_handleKeyboardShortcut` — text-entry inputs only.
 */
const NOT_TEXT_INPUT = new Set(["button", "checkbox", "radio", "submit",
                                "reset", "file", "image", "range", "color"]);

function typingTarget() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !NOT_TEXT_INPUT.has(String(el.type || "text").toLowerCase());
}

const sub3 = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.sqrt(dot3(a, a));
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1],
                          a[2] * b[0] - a[0] * b[2],
                          a[0] * b[1] - a[1] * b[0]];
const unit3 = (a) => {
  const l = len3(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The library internals this tool needs, or null if any of them moved. */
function sectionInternals() {
  try {
    if (!viewer || !viewer.ready) return null;
    const camera = viewer.camera;
    const cam = camera && camera.getCamera();
    const clipping = viewer.clipping;
    const plane = clipping && clipping.clipPlanes && clipping.clipPlanes[SECTION_INDEX];
    const canvas = viewer.renderer && viewer.renderer.domElement;
    const picker = viewer.idPicker;
    if (!cam || !canvas || !picker) return null;
    // `distanceToPoint` is the one thing the value maths below leans on, so a
    // plane that no longer has it counts as a missing plane.
    if (!plane || typeof plane.distanceToPoint !== "function") return null;
    if (typeof camera.getPosition !== "function") return null;
    // `clipping` and `controls` ride along for one call site each —
    // keepSectionCut() and the cursor pivot — and are deliberately NOT guarded
    // above: a missing `setVisible` should cost the cut its stencil caps on
    // other tabs, not stop a face from being pickable, and a controls object
    // that has moved should cost the page its pivot and nothing else. Both call
    // sites check what they use themselves (see orbitTrackball).
    const controls = viewer.controls;
    return { camera, cam, plane, canvas, picker, clipping, controls };
  } catch (e) {
    console.warn("section internals", e);
    return null;
  }
}

/** One face pixel: its component id and its world position, or null. */
function probeFace(picker, x, y, single) {
  // `topoFilter` is what keeps this on a FACE. The picker resolves
  // vertex > edge > face by priority, so a click a few pixels from an edge
  // would otherwise come back as that edge — whose "normal" is meaningless and
  // whose position sits on a different surface than the one that was aimed at.
  // `windowSize: 1` reads the exact pixel; the centre probe keeps the default
  // 3x3 window so the user's aim gets the same tolerance as anywhere else.
  const opts = single ? { topoFilter: ["face"], windowSize: 1 }
                      : { topoFilter: ["face"] };
  const hit = picker.pickAt(x, y, opts);
  if (!hit || !hit.point) return null;
  return { id: hit.id, point: hit.point };
}

/** World normal + world point of the face under a canvas pixel, or null.
 *
 * SPEC 7B calls for a three.js `Raycaster` alongside the id picker. That is not
 * available here: the vendored bundle exports Viewer and Display and nothing
 * else — no `Raycaster`, no `Ray`, no `Vector3` — and shipping a second copy of
 * three.js to read one normal is not a trade worth making.
 *
 * The picker itself has what is needed. Its render target carries WORLD
 * POSITION next to the id, so three pixels of the SAME face read off that
 * buffer give the normal as a cross product. Two things fall out of that for
 * free: the result is already in world space, so there is no object matrix and
 * no normal matrix to get wrong (a normal does not transform by the same matrix
 * as a point, and that is a classic way to end up with a plane that is subtly
 * skew); and the samples honour clipping exactly the way the pixels on screen
 * do, so clicking a surface that an earlier cut exposed reads THAT surface and
 * not the one that was cut away.
 *
 * On a curved face this returns the local tangent plane, which is the useful
 * answer: it is the plane the cut will actually follow at that spot.
 */
function faceNormalAt(picker, x, y) {
  const centre = probeFace(picker, x, y, false);
  if (!centre) return null;
  const ring = [[1, 0], [0, 1], [-1, 0], [0, -1],
                [1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (const r of SECTION_PROBE_PX) {
    const pts = [];
    for (const [dx, dy] of ring) {
      const s = probeFace(picker, x + dx * r, y + dy * r, true);
      // Same component id, or the sample belongs to another face and the cross
      // product would describe an edge between two surfaces rather than one.
      if (s && s.id === centre.id) pts.push(s.point);
    }
    let best = null;
    let bestSine = 0;
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        const a = sub3(pts[i], centre.point);
        const b = sub3(pts[j], centre.point);
        const n = cross3(a, b);
        const scale = len3(a) * len3(b);
        if (scale <= 0) continue;
        // |a x b| / (|a||b|) is the sine of the angle between the two samples:
        // scale-free, so a nearly collinear pair is rejected the same way on a
        // 2 mm part and a 2 m one.
        const sine = len3(n) / scale;
        if (sine > bestSine) {
          bestSine = sine;
          best = unit3(n);
        }
      }
    }
    if (best && bestSine > SECTION_MIN_SPREAD) {
      return { normal: best, point: centre.point };
    }
  }
  return null;
}

// Two ways into the tool and ONE state that says whether it is up.
//
// `sectionMode` is DERIVED — `sectionLatched || sectionHeld` — and never
// assigned anywhere but syncSectionMode(). That is the whole trick to keeping
// the button and the hold key from drifting apart: the pair of intents is the
// state, "is the tool armed" is a function of it, and every reader in this file
// (sectionDown, applySectionMode, setCommentMode, restoreLive) keeps asking the
// same question it asked before the key existed.
let sectionLatched = false;   // the Section button's own on/off
let sectionHeld = false;      // the hold key is down right now
let sectionMode = false;      // what the tool actually is: latched || held
// Which tab the reader was on when the hold started, or null when there is
// nothing to put back. A momentary mode has to leave the page as it found it:
// the tool switches the library to its Clip tab, and somebody who held C while
// reading the part tree got dropped somewhere they never asked to be.
//
// One nullable value and no second flag: it is set only when a restore is owed,
// and every reason not to owe one any more — the reader picked a tab themselves,
// the button latched the tool, the hold ended — clears it. So "is a restore
// owed" is never a question about two variables agreeing.
let sectionTabBeforeHold = null;
let sectionSeed = null;   // {value, point} — where the plane was laid down
let sectionDrag = null;   // live gesture, see sectionDown

/** Half the grid: the range the library's own clip sliders span. */
const sectionLimit = () => {
  const g = viewer && viewer.gridSize;
  return Number.isFinite(g) && g > 0 ? g / 2 : null;
};
const sectionValue = (v) => {
  const lim = sectionLimit();
  return lim === null ? v : clamp(v, -lim, lim);
};
// Ceiling on one pointermove's worth of travel. The angle guard already keeps
// the px -> world factor finite, but "finite" is not "small": a plane 9 degrees
// off the view axis still moves ~6 world units per pixel, and one flick would
// send it clean through the model. A tenth of the full travel per event is more
// than a hand can produce and less than a jump anyone would notice.
const sectionStepCap = () => (sectionLimit() || 1) / 10;

/** Unit direction from the camera towards `pointVec`, or null. */
function sectionViewDir(g, pointVec) {
  const eye = g.camera.getPosition();
  if (!eye || !Number.isFinite(eye.x)) return null;
  return unit3(sub3(pointVec, eye));
}

/** Lay the cutting plane on a face: `normal` orients it, `pointVec` locates it.
 *
 * The slider's frame of reference, read off the library rather than guessed at:
 *
 *   `setClipSlider(i, value)` -> `Clipping.setConstant(i, value)` ->
 *   `CenteredPlane.setConstant(value)`, which computes
 *       constant = distanceToPoint(0) - distanceToPoint(centre) + value
 *                = value - normal . centre
 *   so with three.js's `distanceToPoint(p) = normal . p + constant` the plane
 *   sits where `normal . (p - centre) = -value` and the half-space kept is
 *   `normal . (p - centre) + value >= 0`. THE ZERO OF THE SLIDER IS THE CENTRE
 *   OF THE CLIPPING REGION — the grid centre — and not the model origin. That
 *   is why `resetClip` parks it at `gridSize / 2`: the far edge of the grid,
 *   where the plane cuts nothing.
 *
 * The consequence this code actually uses: `distanceToPoint` is affine in
 * `value` with slope exactly 1, so from ANY current value `v` the value that
 * puts the plane through P is `v - plane.distanceToPoint(P)`. That needs
 * neither the centre nor the grid size, it is one subtraction, and it stays
 * right if the library moves its origin again. The same slope-of-1 is what
 * makes the drag below a plain subtraction too.
 */
/** Slide the plane along its own normal until it passes through `pointVec`.
 *
 * The one place the affine relation above is spent, so that the two callers
 * that need it — laying a plane on a face, and putting one back after a live
 * reload — cannot drift into two subtly different subtractions. `back` pushes
 * the answer further along the normal (the placement bias) and is 0 when the
 * plane has to land exactly on the point. Returns the value it set, or null
 * when the numbers came back unusable, in which case nothing was written.
 */
function slideSectionTo(g, pointVec, back) {
  const v0 = viewer.getClipSlider(SECTION_INDEX);
  if (!Number.isFinite(v0)) return null;
  const value = sectionValue(v0 - g.plane.distanceToPoint(pointVec) - back);
  if (!Number.isFinite(value)) return null;
  viewer.setClipSlider(SECTION_INDEX, value, true);
  return value;
}

function placeSectionPlane(g, normal, pointVec) {
  const view = sectionViewDir(g, pointVec);
  if (!view) return false;
  // three.js keeps the half-space the normal points INTO. A normal pointing
  // away from the camera therefore throws away the near side — everything
  // between the viewer and the face — which is the direction a section cut
  // opens. Taken from the camera rather than from the face winding, so a
  // model whose triangles are wound inwards still cuts the way it looks like
  // it should.
  const n = dot3(normal, view) < 0
    ? [-normal[0], -normal[1], -normal[2]] : normal;
  // null, not the current value: `setClipNormal` then puts the slider at its
  // documented default, and the lines below correct it from a KNOWN state.
  viewer.setClipNormal(SECTION_INDEX, n, null, true);
  // The bias: a larger `value` holds the plane further back, so taking it away
  // slides the plane the sliver INTO the part that keeps the cap quad off the
  // face it would otherwise fight with.
  const value = slideSectionTo(g, pointVec, (sectionLimit() || 1) * SECTION_BIAS);
  if (value === null) return false;
  // The plane lands ON the face, cutting away nothing but the bias sliver.
  // Dragging is what opens the part up, exactly as it reads in Fusion. `value`
  // and not the un-biased number, so the depth below is measured from where the
  // plane actually IS and starts at a true zero.
  sectionSeed = { value, point: pointVec.clone() };
  return true;
}

/** Canvas px of screen travel per one world unit along the clip normal.
 *
 * null when the normal is too close to the view axis: its screen projection
 * collapses there and `px -> world` runs away to infinity, so a two-pixel
 * twitch would fling the plane across the model (SPEC 7B).
 */
function sectionAxis(g, pointVec) {
  let n = null;
  try {
    n = viewer.getClipNormal(SECTION_INDEX);
  } catch (e) {
    console.warn("section normal", e);
    return null;
  }
  n = Array.isArray(n) ? unit3(n) : null;
  if (!n) return null;
  const view = sectionViewDir(g, pointVec);
  if (!view) return null;
  const cos = clamp(dot3(n, view), -1, 1);
  if (Math.sqrt(1 - cos * cos) < SECTION_MIN_SINE) return null;
  const rect = g.canvas.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  // A short step rather than a whole world unit: on a perspective camera this
  // is a local linearisation, and on the ortho camera the page actually uses it
  // is exact at any length.
  const L = (sectionLimit() || 1) / 100;
  const a = pointVec.clone().project(g.cam);
  const b = pointVec.clone()
    .set(pointVec.x + n[0] * L, pointVec.y + n[1] * L, pointVec.z + n[2] * L)
    .project(g.cam);
  const sx = ((b.x - a.x) * rect.width / 2) / L;
  const sy = (-(b.y - a.y) * rect.height / 2) / L;   // NDC y is up, pixels are down
  const s2 = sx * sx + sy * sy;
  if (!(s2 > 1e-12)) return null;
  return { sx, sy, s2 };
}

function endSectionDrag() {
  sectionDrag = null;
  removeEventListener("pointermove", sectionMove, true);
  removeEventListener("pointerup", sectionUp, true);
  removeEventListener("pointercancel", sectionUp, true);
}

/** Turn a click on a face into an oriented, located cutting plane.
 *
 * Every way this can fail ends in the plane staying where it was, and none of
 * them says anything: the tool has no chrome to say it in. That is a deliberate
 * trade rather than an oversight -- a click that misses the model, or lands on
 * an edge instead of a face, simply cuts nothing, and the reader's next click is
 * the whole of the recovery. What used to be a line of prose in a panel cost a
 * canvas resize every time the tool opened or closed.
 */
function seedSectionAt(x, y) {
  const g = sectionInternals();
  if (!g) return;
  let found = null;
  try {
    found = faceNormalAt(g.picker, x, y);
  } catch (e) {
    console.warn("section pick", e);
  }
  if (!found) return;
  if (!placeSectionPlane(g, found.normal, found.point)) return;
  // A plane placed while some other tab is open would be a cut nobody can see:
  // the library only turns clipping on for its Clip tab, and the reader is
  // standing in the Tree. There is now a cut, so make it cut.
  keepSectionCut();
}

function sectionDown(e) {
  if (!sectionMode || e.button !== 0) return;
  // Nothing to say when the library has moved under us: the press falls through
  // to the trackball, which is the behaviour this page had before the tool
  // existed and is a better failure than a canvas that stops responding.
  const g = sectionInternals();
  if (!g) return;
  if (e.target !== g.canvas) return;   // the toolbar and the tree stay clickable
  // Take the press away from the trackball. A capture-phase listener on the
  // CONTAINER runs before the canvas's own pointerdown handler, so stopping it
  // here means the controls never begin a rotation; `wheel` is deliberately
  // left alone, so zoom keeps working while the tool is armed. preventDefault
  // also suppresses the compatibility mouse events, which keeps this press from
  // reaching the comment tool's double-click.
  e.preventDefault();
  e.stopPropagation();
  const rect = g.canvas.getBoundingClientRect();
  sectionDrag = {
    x: e.clientX, y: e.clientY,
    startX: e.clientX, startY: e.clientY,
    cx: e.clientX - rect.left, cy: e.clientY - rect.top,
    moved: false, axis: undefined,
  };
  addEventListener("pointermove", sectionMove, true);
  addEventListener("pointerup", sectionUp, true);
  addEventListener("pointercancel", sectionUp, true);
}

function sectionMove(e) {
  const d = sectionDrag;
  if (!d) return;
  if (!d.moved
      && Math.abs(e.clientX - d.startX) < SECTION_CLICK_PX
      && Math.abs(e.clientY - d.startY) < SECTION_CLICK_PX) return;
  d.moved = true;
  const g = sectionInternals();
  if (!g) return;
  // Nothing has been laid down yet, so there is nothing to drag.
  if (!sectionSeed) return;
  // Once per gesture: the controls are held off for its whole duration, so the
  // camera cannot move underneath and the projection stays valid throughout.
  if (d.axis === undefined) d.axis = sectionAxis(g, sectionSeed.point);
  // Edge-on to the view: the plane's screen projection has collapsed and a drag
  // here would fling it across the model. It stands still until the model is
  // turned, which is the same answer the panel used to spell out.
  if (!d.axis) return;
  const dx = e.clientX - d.x;
  const dy = e.clientY - d.y;
  d.x = e.clientX;
  d.y = e.clientY;
  // Least-squares projection of the pixel delta onto the screen direction of
  // the normal: only the component along that direction moves the plane, and a
  // drag across it moves nothing.
  const cap = sectionStepCap();
  const step = clamp((dx * d.axis.sx + dy * d.axis.sy) / d.axis.s2, -cap, cap);
  const v = viewer.getClipSlider(SECTION_INDEX);
  if (!Number.isFinite(v)) return;
  // Slope of 1, from the note on placeSectionPlane: sliding the plane `step`
  // along its own normal is the slider minus `step`.
  viewer.setClipSlider(SECTION_INDEX, sectionValue(v - step), true);
}

function sectionUp(e) {
  const d = sectionDrag;
  endSectionDrag();
  // A press that never moved is a click: that is what lays the plane down, and
  // it costs the trackball nothing, since a rotation of zero pixels is no
  // rotation at all.
  if (d && !d.moved && e.type === "pointerup") seedSectionAt(d.cx, d.cy);
}

/** Put the cut back after the library switched tabs away from Clip.
 *
 * The library keeps clipping alive only on its own Clip tab: the `activeTab`
 * subscription runs `Display.switchToTab`, which calls `clipping.setVisible`
 * (the stencil caps that close the cut off) and `setLocalClipping` (the
 * renderer flag that makes the planes cut at all) with `tab === "clip"`. That
 * is deliberate on their side — "only allow clipping when Clipping tab is
 * selected" is written in their init — but it means a reader who opens the
 * TREE to see which part they are looking into loses the cut on the way, which
 * is the one moment the cut is most wanted (SPEC 7B).
 *
 * So both flags go straight back on. Both are public methods on `Viewer`, and
 * this runs from the same notification that drove `switchToTab` — the library's
 * own subscriber is called first, so this lands after it rather than fighting
 * it, and no deferral is needed.
 *
 * `setClipPlaneHelpers` is NOT restored: the plane outlines are Clip-tab
 * furniture, and the point here is the cut, not the tooling around it.
 *
 * Only while a cut exists. `sectionSeed` is what makes the difference between a
 * plane the reader has placed and the untouched defaults that sit at the far
 * edge of the grid cutting nothing, and Reset clears it — so after Reset no
 * amount of tab switching brings anything back, and a reader who never opened
 * the tool never has the library's behaviour altered underneath them.
 */
function keepSectionCut() {
  if (!sectionSeed) return;
  const g = sectionInternals();
  if (!g) return;
  try {
    if (g.clipping && typeof g.clipping.setVisible === "function") {
      g.clipping.setVisible(true);
    }
    viewer.setLocalClipping(true);
  } catch (e) {
    console.warn("section keep", e);
  }
}

/** Where the cutting plane stands, in WORLD coordinates, or null for no cut.
 *
 * What a live reload must NOT carry across is the slider value: its zero is the
 * centre of the clipping region, which is the centre of the GRID, and the grid
 * is sized from the model's bounding box. Republish a model half a millimetre
 * wider and the same number names a different physical plane — the cut would
 * appear to have jumped for no reason anybody could see (SPEC 8.8).
 *
 * A normal and a point do not have that problem: they are the plane itself, in
 * the model's own space, and the value that reproduces them in the new scene is
 * one subtraction away (see placeSectionPlane, and restoreSection below).
 *
 * `point` is the foot of the plane — the seed point projected onto where the
 * plane actually IS, so every drag since it was laid down is folded in — and
 * from the origin when there is no seed, which is the `From view` cut: the
 * library's own Clip tab sets a normal from the camera and the reader opens the
 * part with the slider, never touching this tool. Any point on the plane
 * reproduces it, so that cut carries across on exactly the same two numbers.
 *
 * "Is there a cut" is asked of the SLIDER rather than of `sectionSeed`, for the
 * same reason: `resetClip` parks it at `gridSize / 2` and a freshly rendered
 * scene starts there, so a value below the limit means something is being cut
 * no matter which of the two tools did it.
 */
function captureSection() {
  const g = sectionInternals();
  if (!g) return null;
  let normal = null;
  try {
    normal = viewer.getClipNormal(SECTION_INDEX);
  } catch (e) {
    console.warn("section capture", e);
    return null;
  }
  normal = Array.isArray(normal) ? unit3(normal) : null;
  if (!normal) return null;
  const v = viewer.getClipSlider(SECTION_INDEX);
  if (!Number.isFinite(v)) return null;
  const lim = sectionLimit();
  if (lim !== null && v >= lim) return null;   // parked at the far edge: cuts nothing
  // The bundle exports no Vector3, so the one point this needs is cloned off
  // something that already is one: the seed, or — with no seed — the plane's
  // own normal, emptied to the origin.
  const src = sectionSeed ? sectionSeed.point : g.plane.normal;
  if (!src || typeof src.clone !== "function") return null;
  const point = src.clone();
  if (!sectionSeed) point.set(0, 0, 0);
  const d = g.plane.distanceToPoint(point);
  if (!Number.isFinite(d)) return null;
  // `distanceToPoint` is signed along the unit normal, so stepping the point
  // back by it lands it on the plane, with every drag since the seed folded in.
  point.set(point.x - normal[0] * d, point.y - normal[1] * d,
            point.z - normal[2] * d);
  // `placed` keeps the two tools' behaviour apart across the swap. A cut this
  // page laid down survives a trip to the Tree tab (keepSectionCut) and a
  // `From view` one never has — carrying the flag is what stops a reload from
  // silently granting the second the habits of the first.
  return { normal, point, placed: !!sectionSeed };
}

/** Put the captured plane back on the scene that has just been rendered.
 *
 * The normal goes back verbatim — no re-orienting against the camera. The one
 * in `keep` is already the oriented one, and re-deciding which half-space to
 * keep would invert the cut for a reader who had turned the model more than a
 * quarter turn since they made it.
 *
 * If the geometry changed enough that the plane now misses the part, it lands
 * outside it and cuts nothing visible. That is the honest answer: the cut is
 * plainly somewhere else and one drag brings it back, where a plane quietly
 * re-seated on a number would be wrong with nothing to show for it. The travel
 * is bounded all the same — `slideSectionTo` clamps to the grid — so it can
 * never run off to a value the sliders cannot express.
 *
 * Every failure ends in a scene with no cut on it, and none of them is allowed
 * out: this runs inside a swap, and a swap that throws takes live updates down
 * with it (applyPending). A lost plane is a drag to put back; a lost live page
 * is a reload nobody knows they need.
 */
function restoreSection(keep) {
  if (!keep) return false;
  const g = sectionInternals();
  if (!g) return false;
  try {
    // null, not a value: the same known state placeSectionPlane starts from.
    viewer.setClipNormal(SECTION_INDEX, keep.normal, null, true);
    const value = slideSectionTo(g, keep.point, 0);
    if (value === null) return false;
    if (keep.placed) sectionSeed = { value, point: keep.point.clone() };
    // Self-gating on `placed` through sectionSeed, and it has to run: `render`
    // left local clipping off, and on any tab but Clip nothing else turns it on.
    keepSectionCut();
  } catch (e) {
    console.warn("section restore", e);
    return false;
  }
  return true;
}

/** Put the library's sidebar on one of its tabs, keeping any cut that stands.
 *
 * The cut survives the move on its own: `setActiveTab` notifies, the library's
 * subscriber runs first and turns clipping off on the way out of Clip, and
 * onNotify then runs keepSectionCut, which puts it straight back. That is the
 * same path a reader clicking the tab takes, so there is nothing special to do
 * here — the point of routing every switch through one function is that there
 * is nowhere for a second, subtly different one to appear.
 */
function showTab(name) {
  try {
    if (viewer && typeof viewer.setActiveTab === "function") {
      viewer.setActiveTab(name);
    }
  } catch (e) {
    console.warn("section tab", e);
  }
}

/** Re-assert the tool after a render: `render` rebuilds the clipping planes. */
function applySectionMode() {
  if (!sectionMode) return;
  // Clipping is only live while the library's own Clip tab is the active one
  // (see keepSectionCut above, which is what carries the cut onto every other
  // tab). Leaving the tool by the BUTTON does not switch back — that is a
  // deliberate stay, and the three sliders on the Clip tab are where the plane's
  // position shows up (SPEC 7B). Leaving it by releasing the HOLD key does
  // switch back, because a momentary mode that moves the reader somewhere and
  // leaves them there is not momentary; see releaseSectionHold.
  showTab("clip");
}

/** Bring the tool in line with the two intents. The ONLY writer of sectionMode.
 *
 * Everything that turns the tool on or off goes through here, so the button and
 * the key cannot end up disagreeing about what is on screen: there is nothing to
 * disagree with, only `latched || held` read afresh.
 */
function syncSectionMode() {
  const on = sectionLatched || sectionHeld;
  // Nothing changed. The ways out are deliberately redundant, so they overlap: a
  // tab going to the background fires `blur` AND `visibilitychange`, and the
  // keyup that was lost may still turn up afterwards. Cheap now that the rest of
  // this function only flips an attribute, but kept as the statement that the
  // redundancy is expected rather than a bug.
  if (on === sectionMode) return;
  // Both tools take the canvas over — comment mode owns the double click, this
  // one owns press and drag — so only one of them is ever armed.
  if (on && commentMode) setCommentMode(false);
  sectionMode = on;
  $("section_btn").setAttribute("aria-pressed", String(on));
  if (!on) endSectionDrag();
  applySectionMode();
  // NOTHING HERE MAY CHANGE THE LAYOUT, and there is no `dispatchEvent(resize)`
  // for the same reason. The tool used to own a row under the header; showing it
  // took height from #cad_viewer and hiding it gave the height back, and the
  // viewer sizes its canvas from that container — so arming the tool and leaving
  // it each resized the model under the reader's eyes. With the hold key that is
  // a jump on every press and every release of a key held for two seconds. The
  // tool is chrome-less now, and it has to stay that way: anything added to this
  // function that occupies space in the page's flex column brings the jump back.
}

/** The button's intent: latch the tool on, or take it away entirely. */
function setSectionMode(on) {
  sectionLatched = on;
  // An explicit "off" — the button, Done, Escape, or arming the comment tool —
  // is the reader's last word, and a key that happens to still be down must not
  // outvote it. Dropping the hold too is what lets Escape leave the tool while
  // the key is still down; the auto-repeat of that same key cannot bring it
  // back, because repeats are ignored on the way in.
  //
  // Through releaseSectionHold, and not by clearing the flag here: Escape
  // pressed mid-hold ends that hold, and it has to hand the tab back like any
  // other ending. Clearing the flag by hand would make the real keyup arrive to
  // an early return and strand the reader on Clip — the very bug, reachable by
  // one extra keystroke.
  if (!on) releaseSectionHold();
  syncSectionMode();
}

/** Let the hold go, wherever the news came from — and undo what it moved.
 *
 * The tab goes back because this mode is MOMENTARY: it is held for the length
 * of a glance inside, and a glance that leaves somebody on a different tab has
 * taken away the thing they were reading. The latched mode deliberately does
 * not do this — there the reader chose to be in the tool and Clip is where the
 * controls are.
 */
function releaseSectionHold() {
  if (!sectionHeld) return;
  sectionHeld = false;
  // Read and cleared BEFORE the tab is touched: showTab notifies, onNotify
  // clears this on any tab that is not `clip`, and a restore that cancelled its
  // own debt would be relying on that order rather than stating it.
  const back = sectionTabBeforeHold;
  sectionTabBeforeHold = null;
  syncSectionMode();
  // Only if the hold was the whole of the tool. Pressing the button while the
  // key was down latches it, and that intent is newer: the reader is staying.
  if (back && !sectionMode) showTab(back);
}

// The tool went chrome-less with the panel, and three of its controls went with
// it rather than moving somewhere else:
//
//   * Done — Escape leaves the tool, and so does the Section button, which is
//     the control that armed it in the first place;
//   * Reset — `resetClip` is on the library's own Clip tab, which this tool
//     activates (applySectionMode) and therefore already puts in front of the
//     reader;
//   * From view — a convenience, and not one worth a permanent row of layout.
//
// Each was a wrapper around one library call, so bringing any of them back is a
// question of where a button can live without taking room in the flex column,
// not of rewriting the tool.

function setupSection() {
  $("section_btn").onclick = () => setSectionMode(!sectionMode);
  box.addEventListener("pointerdown", sectionDown, true);

  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sectionMode) {
      setSectionMode(false);
      return;
    }
    // A keyup for an ordinary key is NOT delivered while Command is down on
    // macOS: press C, then Cmd, then let C go, and the release never arrives.
    // From the moment Cmd goes down the real release cannot be relied on, so
    // treat Cmd itself as the release. Costs a peek that nobody asked to end
    // this way; the alternative is a tool stuck on with no key to press.
    if (e.key === "Meta") releaseSectionHold();
    if (!isSectionHoldKey(e)) return;
    // Auto-repeat is the same press, still held. Ignoring it is also what stops
    // Escape from being undone a moment later by a finger that never lifted.
    if (e.repeat) return;
    // Any modifier and this is somebody aiming at a browser or OS shortcut
    // (Cmd+C is copy), whose keyup the platform may well keep to itself.
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (typingTarget()) return;
    // Where to come back to, decided before anything moves. Nothing is owed in
    // the two cases where the hold moves nothing: the tool is already up, so it
    // is already on Clip and no switch is coming, or Clip is where the reader
    // was to begin with — and putting somebody "back" on the tab they never
    // left is how a restore turns into a surprise of its own.
    sectionTabBeforeHold =
      !sectionMode && currentTab !== "clip" ? currentTab : null;
    sectionHeld = true;
    syncSectionMode();
  }, true);
  // No typingTarget() guard and no modifier guard on the way OUT: a release is
  // only ever allowed to turn the tool off, and a release that gets filtered is
  // exactly the stuck key this whole block is written around. Same reason it
  // sits on the window rather than on the canvas, and in the capture phase.
  addEventListener("keyup", (e) => {
    if (isSectionHoldKey(e)) releaseSectionHold();
  }, true);

  // The three ways a keyup goes missing entirely. None of them is hypothetical:
  // Cmd+Tab away, a system menu opening over the page, or the tab going to the
  // background all leave the key down as far as this document is concerned, and
  // the tool would still be up when the reader came back — reading as a viewer
  // that has broken rather than a mode nobody left.
  addEventListener("blur", releaseSectionHold);
  addEventListener("pagehide", releaseSectionHold);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") releaseSectionHold();
  });
}

// -- zoom to the cursor -------------------------------------------------------
// The trackball zooms to the CENTRE of the canvas and there is no option to
// change that: `TrackballControls._zoomCamera` scales `camera.zoom` and moves
// nothing sideways. OrbitControls DOES have one — `zoomToCursor`, with
// `_updateZoomParameters` and `_performCursorZoom` behind it — but switching the
// page back to orbit to get it is not on the table: orbit keeps a fixed up axis
// and clamps the polar angle, which is exactly why viewerOptions above picks the
// trackball. So the behaviour is built here instead, on top of the trackball.
//
// The camera is ORTHOGRAPHIC, and that makes the correction not just exact but
// DEPTH-FREE. Under an ortho projection every world point on the ray through the
// cursor lands on the same pixel, and zoom scales the frustum without touching
// the view axis, so all of them stay on that pixel together. There is therefore
// nothing to pick: whether the cursor is over a face, an edge or empty
// background cannot change the answer, and this tool needs no render-target
// probe at all — which is also why it has no "cursor over the background"
// special case to get wrong.
//
// The correction. Write R and U for the camera's screen axes, C for its
// position, and take any point P on the cursor ray. three.js divides the frustum
// by `zoom` in `OrthographicCamera.updateProjectionMatrix`, so P's horizontal NDC
// is
//
//     n = ((P - C) . R - cx) / (halfW / zoom)
//
// with halfW half the frustum width and cx its centre. Holding n fixed while
// zoom goes z0 -> z1 and the camera moves by d gives
//
//     d . R = ((P - C0) . R - cx) * (1 - z0/z1)
//
// and the same in U. halfW and cx cancel, and what is left is exactly the part
// of `P - C0` PERPENDICULAR to the view axis, scaled by `1 - z0/z1`. Zooming in
// (z1 > z0) makes the factor positive and walks the camera towards the cursor;
// zooming out walks it back by the same law, so a scroll down undoes a scroll up.
//
// Camera and target move by the SAME d, which makes this a pan: the view
// direction is untouched, the distance along it is untouched, and the trackball
// keeps no state in either. That is what lets this ride on top of the controls
// instead of fighting them — rotation and panning are not touched at all.
//
// The library plumbing this needs is reached through `sectionInternals()` and
// nowhere else. It carries more than this tool uses (the clip plane), so an
// upgrade that moves the clipping internals costs the cursor zoom too — a wider
// net than strictly necessary, and deliberately so: ONE guarded door into the
// library's internals is worth more than a second, differently-wrong copy of it.
// When it comes back null the wheel simply keeps the library's own zoom, which
// is the centre zoom this page had before.

// The pre-zoom camera, taken in the capture phase and spent in the bubble phase.
// Two listeners rather than one because the anchor has to be measured against
// the camera the reader was LOOKING at: by the time the event bubbles back out
// of the canvas the controls have already changed `zoom` underneath it.
let zoomAnchor = null;

/** Where an event sits on the canvas, in NDC (-1..1, y up), or null. */
function ndcAt(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
  return Number.isFinite(nx) && Number.isFinite(ny) ? [nx, ny] : null;
}

/**
 * The preconditions every gesture that moves this camera by hand shares, or null
 * if any of them fails. Both wheel gestures ask it, and so does the press that
 * anchors the cursor pivot — the event is a `wheel` or a `pointerdown`, and the
 * questions asked of it are the same three.
 *
 * Only the canvas takes such a gesture. The tree and the toolbar sit inside the
 * same container and their events bubble through here too, and the controls
 * ignore those — so acting on one would be a camera move with no gesture under
 * it.
 *
 * Perspective would need the depth of the point under the cursor, i.e. the
 * picker, and a whole second code path for the background. The page is ortho
 * (viewerOptions), so that path would be dead code; a viewer that is somehow not
 * ortho keeps the library's own centre zoom and gets no swipe pan and no cursor
 * pivot.
 */
function wheelInternals(e) {
  const g = sectionInternals();
  if (!g) return null;
  if (e.target !== g.canvas) return null;
  if (!g.cam.isOrthographicCamera) return null;
  if (typeof viewer.getCameraZoom !== "function") return null;
  if (typeof viewer.getCameraTarget !== "function") return null;
  if (typeof viewer.setCameraLocationSettings !== "function") return null;
  return g;
}

/** Camera position, target and unit view axis, or null if any is unusable. */
function cameraBasis(g) {
  const target = viewer.getCameraTarget();
  if (!Array.isArray(target) || !target.every(Number.isFinite)) return null;
  // matrixWorld is what `unproject` reads, and the renderer refreshes it every
  // frame — but only for a camera it drew with. Refreshing it here costs one
  // matrix compose and removes the assumption.
  if (typeof g.cam.updateMatrixWorld === "function") g.cam.updateMatrixWorld();
  const eye = g.camera.getPosition();
  if (!eye || !Number.isFinite(eye.x) || !Number.isFinite(eye.y)
      || !Number.isFinite(eye.z)) return null;
  const view = unit3(sub3({ x: target[0], y: target[1], z: target[2] }, eye));
  if (!view) return null;
  return { eye, C: [eye.x, eye.y, eye.z], target, view };
}

/**
 * World offset of the point the canvas shows at NDC (nx, ny), measured from the
 * camera and with the component ALONG the view axis removed — the part an ortho
 * projection throws away, and the part that must not move the camera. Null when
 * anything in it is not finite.
 *
 * The one place where a position on the canvas becomes a position in the world,
 * and both wheel gestures are built on it: the cursor zoom takes the offset of
 * the point under the cursor, the swipe pan takes the DIFFERENCE of two offsets,
 * which is exactly the world vector a screen displacement spans. Under ortho
 * neither of them has to pick anything — every point on the ray through a pixel
 * has the same perpendicular offset.
 *
 * `unproject` rather than the frustum numbers by hand: it goes through the
 * projection matrix the camera is actually drawing with, so an off-centre or
 * offset frustum needs no separate handling. z = 0 puts the point midway between
 * near and far, and under ortho the depth along the ray does not enter the
 * answer anyway.
 */
function ndcOffset(g, eye, view, nx, ny) {
  const p = eye.clone().set(nx, ny, 0).unproject(g.cam);
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)
      || !Number.isFinite(p.z)) return null;
  const rel = [p.x - eye.x, p.y - eye.y, p.z - eye.z];
  const along = dot3(rel, view);
  if (!Number.isFinite(along)) return null;
  const off = [rel[0] - along * view[0],
               rel[1] - along * view[1],
               rel[2] - along * view[2]];
  return off.every(Number.isFinite) ? off : null;
}

/** Capture phase: remember the camera the wheel is about to zoom. */
function zoomWheelBefore(e) {
  zoomAnchor = null;
  const g = wheelInternals(e);
  if (!g) return;
  const ndc = ndcAt(g.canvas, e);
  if (!ndc) return;
  try {
    const z0 = viewer.getCameraZoom();
    if (!Number.isFinite(z0) || z0 <= 0) return;
    const b = cameraBasis(g);
    if (!b) return;
    const off = ndcOffset(g, b.eye, b.view, ndc[0], ndc[1]);
    if (!off) return;
    zoomAnchor = { z0, off, C: b.C, target: b.target };
  } catch (err) {
    console.warn("zoom anchor", err);
    zoomAnchor = null;
  }
}

/** Bubble phase: the controls have zoomed, now slide the cursor point back. */
function zoomWheelAfter() {
  const a = zoomAnchor;
  zoomAnchor = null;
  if (!a || !viewer) return;
  try {
    const z1 = viewer.getCameraZoom();
    if (!Number.isFinite(z1) || z1 <= 0) return;
    // Zero when the wheel changed nothing — a horizontal scroll, or a zoom the
    // controls clamped at minZoom/maxZoom. Nothing to compensate for, and moving
    // the camera anyway would drift the model sideways at the end of the travel.
    const k = 1 - a.z0 / z1;
    if (!Number.isFinite(k) || k === 0) return;
    const d = [a.off[0] * k, a.off[1] * k, a.off[2] * k];
    if (!d.every(Number.isFinite)) return;
    // Camera and target together, in one call: `setCameraLocationSettings` is
    // the library's own entry point for placing the camera, and it ends in the
    // `controls.update()` + `update()` pair that keeps the trackball's own eye
    // vector and the render in step. Quaternion and zoom stay null — the
    // rotation is not ours to touch and the zoom is already the reader's.
    viewer.setCameraLocationSettings(
      [a.C[0] + d[0], a.C[1] + d[1], a.C[2] + d[2]], null,
      [a.target[0] + d[0], a.target[1] + d[1], a.target[2] + d[2]], null, true);
  } catch (err) {
    console.warn("zoom to cursor", err);
  }
}

// -- orbit around the point under the cursor ----------------------------------
// Fusion turns the model about the point you grabbed. This trackball turns it
// about `target`, and `target` is always in the middle of the canvas: its
// `update()` rebuilds the camera position as `target + eye` and, on the ortho
// camera this page uses, ends in `lookAt(target)`. So the pivot is not a setting
// that was left on the wrong value — it is where the axis of this trackball
// lives, and a reader inspecting a corner of a large part watches that corner
// swing off the screen while the middle of the canvas, which they were not
// looking at, stays put.
//
// SWAPPING THE TARGET FOR THE PICKED POINT DOES NOT WORK, and that is worth
// writing down because it is the obvious move. `lookAt(target)` is in the ortho
// branch too, so a target moved off the view axis is a camera turned to face it:
// the whole view swings the moment the press lands. This trackball's pivot has
// to stay on the axis of view, and the point under the cursor is, in general,
// not on it.
//
// So the same shape as the cursor zoom, one line up: LET THE LIBRARY ROTATE AS
// IT ALWAYS HAS, then slide the camera sideways so the grabbed point lands back
// on the pixel it was grabbed at. Rotation is untouched — the library keeps its
// holroyd projection, its speeds and its whole feel — and what this adds is a
// pan, which is exactly what the wheel gestures above already add. The maths is
// theirs as well: `cameraBasis` and `ndcOffset` and no third copy of it.
//
// The correction, in one line. Write C for the camera, v for the unit view axis,
// P for the grabbed point and n for the pixel it was grabbed at, in NDC. Under
// ortho, everything on the ray through n sits at the same offset from the camera
// once the component along v is dropped, and `ndcOffset(n)` is that offset. P is
// on that pixel exactly when its own dropped-along-v offset equals it, so
//
//     d = perp(P - C) - ndcOffset(n)
//
// is what the camera is out by, and moving CAMERA AND TARGET both by d puts it
// right: the view direction is untouched, the distance along it is untouched,
// and the trackball keeps no state in either — the same reason the cursor zoom
// can ride on top of the controls instead of fighting them.
//
// WHEN. The correction is recomputed from scratch on every frame the camera
// moves, so nothing accumulates and a dropped frame costs nothing. The hook is
// the trackball's own "change" event, which it dispatches at the end of the
// `update()` that applied the rotation — inside the pointermove handler in
// holroyd mode, and inside the animation loop otherwise. Either way it lands
// before the frame is drawn, so the point does not visibly leave the cursor and
// come back.
//
// The listener is added on the press and removed on the release rather than once
// at startup, which is not tidiness: `render()` builds a NEW controls object,
// and this page calls it on every variant switch and every live reload. A
// listener parked on the old one would be a pivot that silently stopped working
// after the first reload. Between gestures this feature has nothing hooked into
// the library at all.

// The trackball's own state numbers (`STATE` in the bundle: NONE -1, ROTATE 0,
// ZOOM 1, PAN 2). Read rather than re-derived from the event, because WHICH
// PRESS ROTATES is the library's to decide and its rule is not the obvious one:
// `KeyMapper` permutes the modifiers, so the drag that pans is the one with the
// CTRL key held, spelled `shift` inside the bundle, and the keyboard can put the
// controls in a pan or zoom state with no modifier on the event at all. A second
// copy of that rule here would be one upgrade away from anchoring a pan.
const TRACKBALL_NONE = -1;
const TRACKBALL_ROTATE = 0;

// The gesture in progress: the world point it turns about, the pixel that point
// has to stay on, and the trackball it is riding. Null between gestures, and
// null for a press that started over the background — there is no point under
// the cursor then, so the rotation is the library's own, about `target`, exactly
// as this page has always done.
let orbitAnchor = null;
// The correction moves the camera, which makes the trackball dispatch "change"
// again from inside our own handler. One flag rather than a debounce: what has
// to be stopped is re-entry, not repetition.
let orbitBusy = false;

/** The trackball itself, or null if the library has moved under us.
 *
 * `viewer.controls` is the library's wrapper; the object that carries the state
 * and the "change" event is the three.js `TrackballControls` inside it. Reached
 * through `sectionInternals()` like everything else in this file, and every
 * method used is checked here rather than there — see the note in that function
 * about what rides along unguarded.
 */
function orbitTrackball(g) {
  const tb = g && g.controls && g.controls.controls;
  if (!tb) return null;
  if (typeof tb.addEventListener !== "function") return null;
  if (typeof tb.removeEventListener !== "function") return null;
  if (typeof tb.update !== "function") return null;
  return tb;
}

/** Forget the gesture and unhook from the library. Safe to call at any time. */
function orbitRelease() {
  const a = orbitAnchor;
  orbitAnchor = null;
  removeEventListener("pointerup", orbitEnd, true);
  removeEventListener("pointercancel", orbitEnd, true);
  if (!a) return;
  try {
    a.tb.removeEventListener("change", orbitChange);
  } catch (err) {
    console.warn("orbit release", err);
  }
}

/**
 * Take the pivot, ONCE, at the moment of the press.
 *
 * Once and not per frame, and that is the whole difference between a pivot and a
 * point that crawls: re-picking mid-gesture would read whatever the rotation has
 * just brought under the cursor, and the model would slide out from under the
 * finger. What the reader grabbed is what it turns about until they let go.
 */
function orbitDown(e) {
  // A press with the last gesture still hooked up means its release went astray
  // (a pointerup outside the window, say). Start clean rather than accumulate.
  orbitRelease();
  const g = wheelInternals(e);
  if (!g) return;
  const tb = orbitTrackball(g);
  if (!tb) return;
  // Is this press a rotation? This listener is on the CONTAINER in the bubble
  // phase, and the trackball's own pointerdown handler is on the canvas, so by
  // the time the event arrives here the press has been classified and `state`
  // is this press's own answer.
  if (tb.state !== TRACKBALL_ROTATE || tb.keyState !== TRACKBALL_NONE) return;
  const ndc = ndcAt(g.canvas, e);
  if (!ndc) return;
  let point = null;
  try {
    const rect = g.canvas.getBoundingClientRect();
    // The picker's default priority is vertex > edge > face, which is the snap
    // this wants and did not have to be built: aim near a corner and the corner
    // is what the model turns about, the way it does in a CAD package.
    const hit = g.picker.pickAt(e.clientX - rect.left, e.clientY - rect.top);
    if (hit && hit.point) point = hit.point;
  } catch (err) {
    console.warn("orbit pick", err);
    return;
  }
  // Nothing under the cursor. NOT a failure and not a case for an invented
  // point: a press on the background rotates about `target`, which is what this
  // page has always done and what the reader who pressed there is used to.
  if (!point) return;
  const b = cameraBasis(g);
  if (!b) return;
  const off = ndcOffset(g, b.eye, b.view, ndc[0], ndc[1]);
  if (!off) return;
  const rel = [point.x - b.C[0], point.y - b.C[1], point.z - b.C[2]];
  const along = dot3(rel, b.view);
  if (!Number.isFinite(along)) return;
  // The picked point SNAPPED ONTO THE RAY THROUGH THE CURSOR: same point, at the
  // depth the picker read it, but with its sideways position taken from the
  // projection rather than from the picker's own buffer. The two disagree by a
  // fraction of a pixel, and that fraction would be a correction applied on the
  // first frame of every gesture — a visible twitch before anything has turned.
  // This makes the correction identically zero until the model actually moves.
  const pivot = [b.C[0] + off[0] + along * b.view[0],
                 b.C[1] + off[1] + along * b.view[1],
                 b.C[2] + off[2] + along * b.view[2]];
  if (!pivot.every(Number.isFinite)) return;
  orbitAnchor = { pivot, ndc, tb };
  tb.addEventListener("change", orbitChange);
  // On the window and in the capture phase, for the same reason the section drag
  // listens there: a release that happens over the toolbar, over the tree or
  // outside the canvas is still the end of this gesture.
  addEventListener("pointerup", orbitEnd, true);
  addEventListener("pointercancel", orbitEnd, true);
}

/** The camera has moved: slide the grabbed point back onto its pixel. */
function orbitChange() {
  const a = orbitAnchor;
  if (!a || orbitBusy) return;
  const g = sectionInternals();
  if (!g) return;
  // The scene was rebuilt under the gesture — a variant switch, or a live reload
  // landing mid-drag. The pivot was measured against a camera that no longer
  // exists, so the gesture is over as far as this is concerned.
  if (orbitTrackball(g) !== a.tb) return;
  // The controls are still rotating. A release can go missing — Cmd+Tab in the
  // middle of a drag is enough — and an anchor that outlived its gesture would
  // otherwise turn the reader's next WHEEL into a zoom that holds a point they
  // grabbed minutes ago. The release is what normally clears this; the state is
  // what makes a lost release cost nothing. It is still ROTATE when `orbitEnd`
  // runs: that listener is on the window in the capture phase and the
  // trackball's own pointerup handler is on the canvas, so the flush is not
  // caught by this.
  if (a.tb.state !== TRACKBALL_ROTATE) return;
  try {
    const b = cameraBasis(g);
    if (!b) return;
    const off = ndcOffset(g, b.eye, b.view, a.ndc[0], a.ndc[1]);
    if (!off) return;
    const rel = [a.pivot[0] - b.C[0], a.pivot[1] - b.C[1], a.pivot[2] - b.C[2]];
    const along = dot3(rel, b.view);
    if (!Number.isFinite(along)) return;
    const d = [rel[0] - along * b.view[0] - off[0],
               rel[1] - along * b.view[1] - off[1],
               rel[2] - along * b.view[2] - off[2]];
    if (!d.every(Number.isFinite)) return;
    // The first frame of every gesture, and any frame the trackball reported a
    // change that was not a rotation. Nothing to put right, and the call below
    // would be a render for nothing.
    if (d[0] === 0 && d[1] === 0 && d[2] === 0) return;
    orbitBusy = true;
    // The same call, with the same two arguments left null, as the cursor zoom
    // and the swipe pan: one description of how this camera moves sideways.
    viewer.setCameraLocationSettings(
      [b.C[0] + d[0], b.C[1] + d[1], b.C[2] + d[2]], null,
      [b.target[0] + d[0], b.target[1] + d[1], b.target[2] + d[2]], null, true);
  } catch (err) {
    console.warn("orbit pivot", err);
  } finally {
    orbitBusy = false;
  }
}

/** The release. Flush whatever rotation is still owed, then unhook.
 *
 * The flush is not decoration. The trackball records the pointer where it lands
 * and turns it into a rotation in a LATER `update()`; with holroyd on that
 * update runs in the pointermove handler and there is never anything pending,
 * but the library reads `holroyd` from its own state and the plain trackball
 * rotates in the animation loop instead. A release that arrives between the last
 * move and the next frame would then leave one rotation with no correction after
 * it — the grabbed point jumping off the cursor at the very end of the gesture,
 * which is the one moment the reader is looking at it.
 *
 * `update()` is the library's own apply step (every one of its camera setters
 * ends in it) and applying a rotation that has already been applied is a no-op:
 * `_rotateCamera` copies its end state onto its start state. So this costs
 * nothing when there is nothing owed.
 */
function orbitEnd() {
  const a = orbitAnchor;
  if (!a) return;
  try {
    a.tb.update();
  } catch (err) {
    console.warn("orbit flush", err);
  }
  orbitRelease();
}

function setupOrbit() {
  // Bubble phase, deliberately: this listener does not want the event, it wants
  // the trackball's verdict on the event, and that only exists once the canvas's
  // own handler has run. Nothing here calls preventDefault or stopPropagation —
  // the rotation stays entirely the library's, and the section tool, which DOES
  // stop the press in the capture phase, keeps the canvas to itself.
  box.addEventListener("pointerdown", orbitDown);
}

// -- the pointing device: trackpad or mouse -----------------------------------
// The library pans on the RIGHT button, or on the left with ctrl/meta/shift. It
// knows nothing about a two-finger swipe, and on a Mac that is how everything
// else on the machine is moved around, so the model is the one thing on screen
// that will not follow the fingers.
//
// There is no touch event to hang this on: a trackpad in a browser is a mouse.
// A swipe and a wheel notch arrive as THE SAME EVENT with the same fields, and
// the W3C pointer-events issue about exactly this states it plainly — "a
// two-finger drag on a touchpad pans the camera, a scroll on the mouse zooms the
// camera. However, as far as the browser is concerned, these are exactly the
// same mouse event". Every published answer to it is a guess at the shape of the
// deltas (pixels vs lines, fractional vs whole, small vs a ~100 px notch), tuned
// against whichever devices the author owned, and a free-spinning mouse wheel
// defeats all of them. So none of that is here. Nothing in this file looks at
// how big a delta is.
//
// What is asked instead is the one question a guess was standing in for: WHAT
// IS THE READER POINTING WITH. It is one question and not three, because a
// trackpad has a swipe and a pinch and no wheel, while a mouse has a wheel and
// neither of the other two — so the whole of the wheel's behaviour follows from
// the answer, and none of it is separately settable.
//
//   * TRACKPAD. macOS turns a two-finger PINCH into `wheel` WITH a synthetic
//     `ctrlKey` — a convention, not a real key — and a two-finger SWIPE into
//     `wheel` without it. So: ctrlKey zooms at the gesture's own scale,
//     everything else pans. Nothing zooms on a notch, because there are no
//     notches, and there is nothing left to guess about.
//   * MOUSE. Exactly the behaviour this page has always had: the wheel zooms,
//     at the library's speed, and `ctrlKey` is left to the browser (on Windows
//     and Linux it is the browser's own page zoom). This page is public and most
//     of the world opens it with an ordinary mouse.
//
// Neither is detectable — a Mac with a plain mouse and a Windows laptop with a
// trackpad are both real and neither announces itself — so the PLATFORM only
// supplies the opening answer and the reader can say otherwise, in Settings. It
// is the sort of setting you touch once on a machine and never think about
// again, which is why it lives there and not in the header.

const INPUT_KEY = "hammerola.pointing_device";

/**
 * Pixels of `deltaY` the browser emits per e-fold of PINCH SCALE. Not a taste
 * setting and not a fudge factor -- it is the browser's own encoding of the
 * gesture, measured.
 *
 * macOS hands the browser a pinch as a gesture carrying a SCALE, and the browser
 * turns that into ctrl+wheel before the page ever sees it. Measured on this
 * machine (Chrome 151, driven through CDP `Input.synthesizePinchGesture` with
 * `gestureSourceType: "mouse"`, which is the same touchpad-pinch code path a
 * real trackpad goes down):
 *
 *     gesture scale   events   sum of deltaY      -100 * ln(scale)
 *          2.00         11         -69.31             -69.31
 *          1.50         10         -40.55             -40.55
 *          1.25          6         -22.31             -22.31
 *          0.50         17         +69.31             +69.31
 *
 * -- exact to five digits, and the SAME total however fast the gesture is run;
 * speed only changes how many events it is chopped into (11 at one speed, 33 at
 * half of it, same -69.31). So `sum(deltaY)` is `-100 * ln(scale)`, and
 *
 *     zoom *= exp(-deltaY / 100)
 *
 * makes the zoom follow the gesture's own scale EXACTLY: spread the fingers
 * until the gesture says "twice as big" and the model is twice as big. That is
 * the target -- a comfortable pinch, a couple of centimetres of finger travel,
 * is a scale of about 2 -- and it is hit by construction rather than by tuning,
 * which is why there is no calibration here to redo by feel.
 *
 * Exponential in the delta, not linear, and that is not a detail: the same
 * finger travel has to mean the same RATIO wherever the reader already is, or
 * the gesture crawls when zoomed in and jumps when zoomed out.
 *
 * WHY THE LIBRARY'S ZOOM IS NOT USED FOR THIS. Its wheel path is
 * `deltaY * 0.00025 * zoomSpeed`, calibrated for the ~100 px notch of a mouse
 * wheel; at the trackball's `zoomSpeed` of 2.0 that is an e-fold every ~2000 px,
 * TWENTY TIMES slower than the browser's own pinch scale. Measured: the whole
 * scale-2 gesture above moved the zoom by x1.035, so doubling the view took
 * twenty repetitions of it. That is the bug this replaces.
 *
 * Which is also why the pinch is intercepted before the controls see it and the
 * zoom is set through the public API: the speed is ours end to end and does NOT
 * depend on `zoomSpeed`. A library upgrade that changes `zoomSpeed` cannot move
 * the pinch -- but it does move the mouse wheel, which still goes through the
 * controls, so the two can drift apart. If the wheel ever starts feeling wrong
 * next to the pinch, that is what changed: re-measure both as
 * `ln(zoom ratio) / sum(deltaY)` and compare against the 0.01 this constant is.
 */
const PINCH_DELTA_PER_E_FOLD = 100;

/**
 * Is this a Mac, i.e. is the pinch/swipe split above the right rule here?
 *
 * BOTH WAYS OF ASKING ARE ON THEIR WAY OUT, and this is the line that will break
 * on some future browser. `navigator.platform` is deprecated, and browsers
 * already freeze it to a fixed string rather than report anything real.
 * `navigator.userAgentData` is the replacement, but it is Chromium-only —
 * Safari and Firefox, i.e. a good share of the Macs this matters for, do not
 * have it — so the deprecated one is still the fallback and cannot be dropped.
 * Should both eventually answer nothing, this returns false, the page zooms on
 * the wheel exactly as it did before this feature existed, and the reader who
 * wanted the pan has a button to press.
 *
 * Deliberately NOT sniffed from the user-agent string, and deliberately not a
 * check for a touchpad: there is no such check, which is the whole reason this
 * function exists.
 */
function isMacPlatform() {
  try {
    const hinted = navigator.userAgentData && navigator.userAgentData.platform;
    const name = (typeof hinted === "string" && hinted) || navigator.platform;
    return typeof name === "string" && /mac/i.test(name);
  } catch (e) {
    console.warn("platform", e);
    return false;
  }
}

/**
 * Is the reader on a trackpad? False means a mouse, which is also what this page
 * assumes until `setupWheel` has read the setting, so nothing below can claim a
 * gesture before the answer is known.
 */
let trackpad = false;

/**
 * Pan on a two-finger swipe, which on a trackpad means every wheel event that is
 * not a pinch. True when the event was spent on a pan and must not reach the
 * controls; false leaves it alone, and the page keeps the zoom it has always
 * had — which is what every failure in here degrades to.
 *
 * The maths is `ndcOffset` and nothing else: the world vector a screen
 * displacement spans is the difference between the offsets of its two ends, and
 * camera and target move by that same vector. Same call, same guards and same
 * `setCameraLocationSettings` as the cursor zoom, so there is one description of
 * how this camera moves sideways rather than two that can drift apart.
 *
 * DIRECTION. The model follows the fingers, which is what the right button
 * already does — drag down, the model goes down. A wheel delta is the negative
 * of the finger movement (that is what "natural scrolling" means), and the
 * camera moves opposite to the model, so the two negations cancel: the camera
 * moves by the world vector of the displacement (deltaX right, deltaY down)
 * taken literally. Hence the NDC y below is negated once, for NDC y pointing up
 * while deltaY, like every screen coordinate, points down — and no more.
 */
function panWheel(e) {
  if (!trackpad) return false;
  // The pinch, and the only branch in this feature that reads a field of the
  // event to decide anything. macOS sets `ctrlKey` on a pinch and on nothing
  // else here, so this is a fact rather than a guess — and it is what keeps the
  // zoom reachable on a Mac once the wheel has stopped zooming. `pinchWheel`
  // below is the other side of this same line.
  if (e.ctrlKey) return false;
  const g = wheelInternals(e);
  if (!g) return false;
  try {
    const rect = g.canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return false;
    const nx = (2 * e.deltaX) / rect.width;
    const ny = -(2 * e.deltaY) / rect.height;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return false;
    const b = cameraBasis(g);
    if (!b) return false;
    // Both ends of the displacement, not one: the centre of the canvas is only
    // the camera's own axis on a symmetric frustum, and the difference is right
    // whatever the projection matrix turns out to be.
    const far = ndcOffset(g, b.eye, b.view, nx, ny);
    const near = ndcOffset(g, b.eye, b.view, 0, 0);
    if (!far || !near) return false;
    const d = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
    if (!d.every(Number.isFinite)) return false;
    // A gesture that resolves to no movement is still the reader's gesture and
    // still must not reach the controls, or a slow swipe would zoom in fits.
    if (d[0] === 0 && d[1] === 0 && d[2] === 0) return true;
    viewer.setCameraLocationSettings(
      [b.C[0] + d[0], b.C[1] + d[1], b.C[2] + d[2]], null,
      [b.target[0] + d[0], b.target[1] + d[1], b.target[2] + d[2]], null, true);
    return true;
  } catch (err) {
    console.warn("swipe pan", err);
    return false;
  }
}

/**
 * Zoom on a pinch, at the browser's own gesture scale. True when the event was
 * spent here and must not reach the controls.
 *
 * Only on the trackpad setting, and that is not a coupling to be undone: a
 * reader on a mouse HAS NO PINCH, so there is no gesture here to be fast or
 * slow. What ctrl+wheel means to them is whatever it means to their browser --
 * page zoom on Windows and Linux -- and this page leaves it there, exactly as it
 * did before any of this existed.
 *
 * The gesture is not measured here, only decoded: `PINCH_DELTA_PER_E_FOLD` says
 * what the delta already means, and this is the two lines that read it. The
 * cursor correction is the wheel's own, unchanged -- `zoomWheelBefore` anchors
 * on the camera the reader is still looking at, our zoom goes in the middle
 * where the controls' zoom used to be, and `zoomWheelAfter` slides the point
 * under the cursor back. Calling the pair by hand rather than leaving it to the
 * listeners because this event never reaches the bubble phase: `wheelCapture`
 * stops it, or the controls would zoom a second time.
 *
 * NO CLAMP, deliberately. `TrackballControls` clamps to `minZoom`/`maxZoom`,
 * which the library leaves at the three.js defaults of 0 and Infinity and never
 * sets -- so its clamp is not one, and inventing a range here would be a limit
 * this page never had. What is left is the finiteness the maths needs.
 *
 * Two gestures reach this that are not a trackpad pinch, both only on the
 * trackpad setting: ctrl held over a real mouse wheel, and ctrl held during a
 * two-finger scroll. Both zoom, and fast, because both are spelled exactly like
 * a pinch and the browser gives nothing to tell them apart -- and "ctrl and
 * scroll" means zoom everywhere else on the machine anyway.
 */
function pinchWheel(e) {
  if (!trackpad) return false;
  if (!e.ctrlKey) return false;
  // Pixels. The pinch is always deltaMode 0 (measured); a ctrl+wheel counted in
  // LINES or PAGES is some other device, whose lines are not this constant's
  // pixels, and it keeps the library's own zoom rather than get this one
  // multiplied by a unit that does not match.
  if (e.deltaMode !== 0) return false;
  // Asked for the preconditions, not for the internals: what this needs from the
  // library is `getCameraZoom`/`setCameraZoom`, and what it needs from the event
  // is that it landed on the canvas of an ortho viewer. `zoomWheelBefore` and
  // `zoomWheelAfter` ask the same door again for the camera itself.
  if (!wheelInternals(e)) return false;
  let z1;
  try {
    const z0 = viewer.getCameraZoom();
    if (!Number.isFinite(z0) || z0 <= 0) return false;
    z1 = z0 * Math.exp(-e.deltaY / PINCH_DELTA_PER_E_FOLD);
    if (!Number.isFinite(z1) || z1 <= 0) return false;
  } catch (err) {
    // Nothing has moved yet, so the cheapest honest answer is to let the
    // controls have the gesture: slow is still better than dead.
    console.warn("pinch zoom", err);
    return false;
  }
  zoomWheelBefore(e);
  try {
    viewer.setCameraZoom(z1);
  } catch (err) {
    // Past the point of no return: the controls must not now zoom on top of
    // whatever this did, so the gesture stays spent.
    console.warn("pinch zoom", err);
    zoomAnchor = null;
    return true;
  }
  zoomWheelAfter();
  return true;
}

/**
 * Say what the reader is pointing with. `true` is a trackpad — swipe pans, pinch
 * zooms, and the wheel does not zoom because there is no wheel — and `false` is
 * a mouse, which is what this page has always done and what a non-Mac starts on.
 *
 * The mouse setting is not a degraded one. It is the right answer for a mouse,
 * so it has to be reachable on a Mac too, where a reader with a plain mouse
 * would otherwise have no zoom at all.
 *
 * The hint under the radios is written from here rather than left in the markup
 * because it describes the answer in force, not the choice on offer: a reader
 * who does not know what "trackpad" is going to do to their wheel can read what
 * it is doing now.
 */
function setPointingDevice(on, persist = true) {
  trackpad = on;
  $("pointer_trackpad").checked = on;
  $("pointer_mouse").checked = !on;
  $("pointer_hint").textContent = on
    ? "Two-finger swipe pans the model, pinch zooms it."
    : "The wheel zooms.";
  if (persist) {
    try {
      localStorage.setItem(INPUT_KEY, on ? "trackpad" : "mouse");
    } catch (e) {
      // Private mode, or storage turned off. The setting still holds for this
      // page; it just will not be remembered for the next one.
      console.warn("pointing device", e);
    }
  }
}

/**
 * One capture listener for the whole wheel, because pan and zoom are three
 * answers to the same event and the choice has to be made in one place, before
 * the controls see it.
 *
 * Order is not free: `panWheel` declines a pinch and `pinchWheel` takes only a
 * pinch, so the two never both want an event and the wheel is what is left.
 */
function wheelCapture(e) {
  // Both spend the gesture the same way, and the way is the point: whatever the
  // camera did, it was done HERE and in full, so the controls must not see the
  // event and add a second helping of their own.
  if (panWheel(e) || pinchWheel(e)) {
    // Either no zoom is coming, or the one that came has already had its cursor
    // correction applied; a stale anchor would be spent on the next gesture.
    zoomAnchor = null;
    // preventDefault because the trackball's own handler — the one that used to
    // do it — is not going to run: without this a horizontal swipe is a
    // back/forward navigation and the page leaves, and a pinch is a browser page
    // zoom on top of the model one.
    e.preventDefault();
    // And this is what keeps the event off the canvas, where the controls would
    // zoom on it. stopPropagation does NOT silence the other listeners on this
    // same element, so the live-reload idle clock still sees the gesture; it
    // does stop the bubble phase, which is why zoomWheelAfter stays quiet.
    e.stopPropagation();
    return;
  }
  zoomWheelBefore(e);
}

function setupWheel() {
  // Capture on the CONTAINER runs before any listener on the canvas, bubble runs
  // after all of them, so the pair brackets the controls' zoom without depending
  // on the order the library registered its own listeners in.
  //
  // The capture half is NOT passive, and cannot be: on a swipe it is the one
  // that calls preventDefault, and a passive listener may not. It only ever does
  // so on a gesture it has already decided to spend, so a wheel that still
  // zooms is passed on untouched.
  box.addEventListener("wheel", wheelCapture, { capture: true, passive: false });
  box.addEventListener("wheel", zoomWheelAfter, { capture: false, passive: true });

  $("pointer_trackpad").onchange = () => setPointingDevice(true);
  $("pointer_mouse").onchange = () => setPointingDevice(false);
  let saved = null;
  try {
    saved = localStorage.getItem(INPUT_KEY);
  } catch (e) {
    console.warn("pointing device", e);
  }
  // The platform picks the default; a reader who has answered keeps their
  // answer, on either platform, because a Mac user on a mouse and a Windows user
  // on a Surface trackpad are both real and neither is detectable.
  setPointingDevice(
    saved === "trackpad" || (saved !== "mouse" && isMacPlatform()), false);
}

// -- the header, filled from meta.json ---------------------------------------
// Split out of the bootstrap at the bottom because a live reload has to redo
// every one of them: on a pointer URL the build this page describes is not the
// build it opened with.
//
// Everything here goes in through the DOM and textContent. The view names, the
// download labels and the filenames all come out of a PUSHED meta.json, and
// every project on this host shares one origin, so interpolating any of them
// into innerHTML would let one push script the whole site.

function fillHeader() {
  $("title").textContent = meta.title || meta.project;
  // Date only. The full ISO stamp is twenty characters of header for a time
  // nobody reads off a snapshot page; the whole of it, and the whole commit id,
  // stay one hover away.
  // A local build has no commit — its `commit` field reads `dev`, the name of
  // the slot it lives in — so it says so instead of putting `dev` where seven
  // characters of hash belong, which would read like a commit that is not one.
  const id = meta.dev ? "local build" : meta.commit.slice(0, 7);
  $("meta").textContent = `${id} · ${meta.built.slice(0, 10)}`;
  $("meta").title = `${meta.commit} · ${meta.built}`;
}

/** Downloads for this exact build -- never "the latest", always this commit. */
function fillDownloads() {
  $("dl").replaceChildren(...Object.entries(meta.downloads).map(([k, f]) => {
    const a = document.createElement("a");
    a.href = BASE + encodeURIComponent(f);
    a.download = "";
    a.textContent = String(k).toUpperCase();
    return a;
  }));
}

/**
 * The two header dropdowns, Downloads and Settings, are one at a time.
 *
 * `<details>` has no notion of siblings — two of them open at once quite happily
 * — and these two are anchored to the same right edge of the bar, so both open
 * is one panel drawn over the other. Closing the other on `toggle` is the whole
 * of it, and it is left to the element rather than to a click handler so that
 * every way a panel opens (mouse, Enter, Space, find-in-page) is covered.
 */
function setupPanels() {
  const panels = [$("dlbox"), $("setbox")];
  for (const one of panels) {
    one.addEventListener("toggle", () => {
      if (!one.open) return;
      for (const other of panels) {
        if (other !== one) other.open = false;
      }
    });
  }
}

/** The view picker. `prefer` stays selected if the new build still has it. */
function fillVariants(prefer) {
  const vsel = $("variant");
  vsel.replaceChildren();
  meta.variants.forEach((v) => vsel.add(
    new Option(`${v.name} · ${v.parts}p · ${(v.gzip / 1e6).toFixed(1)}MB`, v.id)));
  vsel.value = prefer && meta.variants.some((v) => v.id === prefer)
    ? prefer
    : meta.variants[0].id;
}

/** Build picker: the two moving names, then the history of commits.
 *
 * Three destinations, and they are not the same kind of thing, so they are not
 * offered as one flat list. `dev` and `latest` are NAMES that resolve to
 * whatever is current — the local slot and the newest build from CI — and both
 * are rewritten under the reader; everything below them is a commit with a
 * permanent URL that will answer with the same geometry next year. An
 * <optgroup> is what says that inside the picker: a browser renders its label
 * greyed and unselectable, so the split shows without inventing a disabled
 * option to act as a rule.
 *
 * Each name is offered ONLY when it resolves to something, which is what
 * `has_dev` and `latest` are in builds.json for: a project nobody has pushed
 * from a laptop has no slot, one that has only ever been pushed from a laptop
 * has no `latest`, and an entry that navigates to a 404 is worse than no entry.
 */
function fillBuilds(info) {
  const bsel = $("build");
  bsel.replaceChildren();
  // Everything below goes in through createElement and `new Option`, never
  // innerHTML: `built` and the commit id come out of a PUSHED build, and every
  // project on this host shares one origin.
  const group = (label, entries) => {
    if (!entries.length) return;
    const og = document.createElement("optgroup");
    og.label = label;   // a property, so markup in it would be text
    entries.forEach(([value, text]) => og.appendChild(new Option(text, value)));
    bsel.appendChild(og);
  };

  const moving = [];
  if (info.has_dev) moving.push(["dev", "dev · current local build"]);
  if (info.latest) moving.push(["latest", "latest · newest from CI"]);
  group("Current", moving);

  const builds = Array.isArray(info.builds) ? info.builds : [];
  group("Commits", builds.map(
    (b) => [b.commit, `${b.commit.slice(0, 7)} · ${b.built.slice(0, 10)}`]));

  // By the URL, not by `meta.commit`. On /dev/ and /latest/ the build on screen
  // was reached through a NAME, and its own id is either `dev` — which is in no
  // list — or a commit that has its own entry further down; selecting by id
  // would leave the picker either blank or pointing at the wrong row, and the
  // row it points at is what the reader is about to navigate away from.
  // Assigning a value no option carries stays a no-op that leaves the select
  // blank, which is still the honest answer for a build that was pruned out of
  // the list under a reader who kept the page open.
  bsel.value = SLOT;
}

// -- live reload -------------------------------------------------------------
// The author changes the model and publishes; the page they already have open
// picks the new build up on its own, WITHOUT losing the angle. That last part is
// the whole feature: somebody aims the camera at the thing they are fixing, and
// a reload that puts them back at the default iso view has taken away the one
// piece of state they set by hand.
//
// Only on the two pointer URLs, `latest` and `dev`. A /<commit>/ page is
// immutable by contract — that is what buys it a year of `immutable` caching and
// what makes the link safe to paste into a chat — so there is nothing there to
// watch for, and swapping the model under one would contradict the address.
//
// By POLLING, and deliberately not by SSE or a websocket. The hub is a
// ThreadingHTTPServer: one thread per connection, and a long-lived connection is
// therefore a thread parked for as long as a tab stays open. That is the same
// resource the publish semaphore and the socket timeout exist to protect, and
// four forgotten tabs must not be able to compete with a CI push for it. One
// meta.json is ~900 bytes and the loop stops when nobody is looking.

// The two names come from pointer_pref.js, which is also what remembers them:
// one list, so live reload and the remembered choice can never disagree about
// what counts as a moving pointer.
/** Which moving pointer this page is, or null on an immutable /<commit>/ page. */
const POINTER = (() => {
  const parts = location.pathname.split("/").filter(Boolean);
  return parts[0] === "project" && POINTER_NAMES.includes(parts[2])
    ? parts[2] : null;
})();

// Being on a pointer page IS the choice (SPEC 9), so it is recorded here and
// nowhere else — one line that covers every way of arriving: the build picker,
// a pasted link, a bookmark, the back button. /project/<pid>/ then opens it next
// time; this page itself shows exactly what its own URL says and never redirects
// anywhere, which is what keeps a link to `latest` a link to `latest` for the
// person it was sent to.
//
// Written on LOAD rather than after the model renders: what is being remembered
// is which name the reader opened, and a build that fails to load is still that.
// A /<commit>/ page records nothing — POINTER is null there — because a commit
// is a permanent address, not a standing preference.
if (POINTER) rememberPointer(PID, POINTER);

// 3 s. The hub sends neither ETag nor Last-Modified on meta.json, so a poll is
// always the full ~900-byte body — 300 B/s per open tab, and only while the tab
// is on screen. Below a second the loop starts costing more than the thing it is
// watching for; above five, the "did that take?" pause after a publish gets long
// enough that the author reloads by hand, which is exactly what this replaces. A
// dev push is a build plus an upload, so a second or two of latency on top of it
// is invisible.
const POLL_MS = 3000;
// Errors back off geometrically to a minute, then stay there. A hub that is
// down — restarted for a deploy, most likely — must not be hammered at full rate
// by every tab anyone ever left open, and finding it again a minute late costs
// nothing.
const POLL_MAX_MS = 60000;
// How long after the last press or wheel on the canvas the page still counts as
// being in someone's hands. A swap re-renders the scene and re-seats the camera;
// doing that between a mousedown and the mouseup is pulling the model out from
// under the pointer.
const IDLE_MS = 1200;

const LIVE_KEY = "hammerola.live";

let liveOn = false;
let pollTimer = null;
let pollDelay = POLL_MS;
let pending = null;        // a newer meta.json, fetched but not applied yet
let swapping = false;
let pointerHeld = false;   // a button is down on the canvas right now
let lastTouch = 0;         // performance.now() of the last canvas interaction
let freshTimer = null;

const liveNote = (text, kind) => {
  const el = $("live_note");
  el.textContent = text;
  el.className = `meta ${kind || ""}`.trim();
  el.hidden = !text;
};

/** True while the page is in the reader's hands and must not be re-rendered.
 *
 * The rule this encodes: a stale model is a smaller loss than anything the
 * person in front of it is in the middle of. A comment half typed is the clearest
 * case — the model is three seconds away, the sentence is not — but a drag and a
 * press count too, because a swap moves the geometry under the pointer.
 */
function liveBusy() {
  if ($("comment_text").value.trim()) return true;
  if ($("comment_photo").files.length) return true;
  if (commentSending) return true;
  // Mid-gesture: dragging the section plane, or turning/zooming the model.
  if (sectionDrag || pointerHeld) return true;
  if (performance.now() - lastTouch < IDLE_MS) return true;
  // Rebuilding the options of a select while it is the focused element would
  // change what the key or click about to land is going to choose.
  const active = document.activeElement;
  if (active === $("variant") || active === $("build")) return true;
  return false;
}

/** Everything a swap carries across, read off the viewer BEFORE it is cleared. */
function captureLive() {
  const keep = { view: currentView, tab: currentTab, camera: cameraState(),
                 section: captureSection(), states: null };
  try {
    if (viewer && typeof viewer.getStates === "function") {
      keep.states = viewer.getStates();
    }
  } catch (e) {
    console.warn("live states", e);
  }
  return keep;
}

/** Put back what captureLive() took, on the freshly rendered scene. */
function restoreLive(keep) {
  // Tree first, camera last. Hiding a part runs an update of its own, and the
  // camera should have the final say on what the frame looks like.
  try {
    if (keep.states && viewer && typeof viewer.setStates === "function") {
      // A path the new build no longer has is a no-op inside the library
      // (`setState` looks the node up and returns when it is missing), so a part
      // that was renamed or removed simply comes back visible instead of
      // throwing away the rest of the tree state.
      viewer.setStates(keep.states);
    }
  } catch (e) {
    console.warn("live states", e);
  }
  const c = keep.camera;
  try {
    if (c && typeof viewer.setCameraLocationSettings === "function") {
      // notify: false — this is restoring the frame the reader already had, not
      // a camera move anything downstream should react to.
      viewer.setCameraLocationSettings(c.position, c.quaternion, c.target,
                                       c.zoom, false);
    }
  } catch (e) {
    console.warn("live camera", e);
  }
  try {
    // Not while the section tool is armed: applySectionMode() has just put the
    // reader on the Clip tab on purpose, and that is the newer intent.
    if (keep.tab && !sectionMode && viewer
        && typeof viewer.setActiveTab === "function") {
      viewer.setActiveTab(keep.tab);
    }
  } catch (e) {
    console.warn("live tab", e);
  }
  // Last, and after the tab: switching INTO Clip turns local clipping on and
  // switching out of it turns clipping off, so a plane put back before the tab
  // moved would be a plane the library then un-cut. This ordering also means
  // the cut is restored onto the tab the reader will actually be looking at.
  restoreSection(keep.section);
}

const two = (n) => String(n).padStart(2, "0");

/** Say that the model just changed, because a model that changes in silence
 *  reads as a model the reader broke themselves. */
function noteUpdate() {
  const t = new Date();
  liveNote(`updated ${two(t.getHours())}:${two(t.getMinutes())}:${two(t.getSeconds())}`);
  const el = $("meta");
  el.classList.remove("fresh");
  void el.offsetWidth;   // restart the animation; without the reflow it is a no-op
  el.classList.add("fresh");
  clearTimeout(freshTimer);
  freshTimer = setTimeout(() => el.classList.remove("fresh"), 2600);
}

/** Show `next` in place of what is on screen, keeping the frame. */
async function swapBuild(next) {
  const keep = captureLive();
  meta = next;
  fillHeader();
  fillDownloads();
  fillVariants(keep.view);
  await showVariant($("variant").value);
  restoreLive(keep);
  // The picker is a convenience; a stale one is not worth failing a swap over,
  // and the next publish will rewrite it anyway.
  try {
    fillBuilds(await (await fetch(`/project/${PID}/builds.json`,
                                  { cache: "no-store" })).json());
  } catch (e) {
    console.warn("live builds", e);
  }
  // The anchor named a part of the geometry that has just been replaced, and its
  // point is a coordinate on a surface that may have moved. Cleared rather than
  // carried over, so a comment cannot quietly end up pointing at the old shape.
  // Only reachable with an EMPTY comment box — anything typed defers the swap.
  if (anchor) {
    anchor = null;
    showAnchor();
  }
  noteUpdate();
}

async function applyPending() {
  if (!pending || swapping) return;
  if (liveBusy()) {
    // Say why nothing is happening. Without this the deferral is indistinguishable
    // from the feature being broken.
    liveNote("new build waiting", "wait");
    return;
  }
  const next = pending;
  pending = null;
  swapping = true;
  try {
    await swapBuild(next);
  } catch (e) {
    // Half-swapped, and there is no telling how far it got. That is the page's
    // real error channel, not a word in the header — and live updates go off
    // with it, because retrying the same failing build every three seconds would
    // only clear the screen again each time.
    setLive(false, false);
    fail("live update", e);
  } finally {
    swapping = false;
  }
}

function schedulePoll(delay) {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (!liveOn || !POINTER) return;
  // A tab nobody is looking at costs the hub nothing. The visibilitychange
  // handler polls immediately when it comes back, so this is a pause and not a
  // way to end up several minutes stale on return.
  if (document.visibilityState === "hidden") return;
  pollTimer = setTimeout(poll, delay);
}

/** What makes one build different from the last, as one comparable string.
 *
 * `commit` alone answered this while every build had an id of its own. The
 * local slot does not: it is one directory called `dev` that holds a different
 * build after every push, so its `commit` never changes and `published` — the
 * arrival time the hub stamps, and only when the slot really changed — is what
 * moves. Both go into the key rather than branching on which URL this is: one
 * key that is right everywhere is one fewer place to get it wrong.
 *
 * null for a meta that cannot answer, and the caller treats null as "no change"
 * in both directions: a truncated or hand-edited meta.json is a reason not to
 * swap the model on screen, never a reason to swap to it.
 */
function buildKey(m) {
  return m && typeof m.commit === "string" && typeof m.published === "string"
    ? `${m.commit}@${m.published}`
    : null;
}

async function poll() {
  pollTimer = null;
  if (!liveOn || !POINTER || document.visibilityState === "hidden") return;
  try {
    // `no-store` rather than trusting the response: the pointer URLs are served
    // no-cache so this is a real request either way, but a poll that a proxy or
    // a back/forward cache could answer would be a poll that never sees the new
    // build at all.
    const r = await fetch(BASE + "meta.json", { cache: "no-store" });
    if (!r.ok) throw new Error(`meta.json -> HTTP ${r.status}`);
    const next = await r.json();
    pollDelay = POLL_MS;
    // What identifies "a different build" differs between the two names, and
    // `buildKey` is where that lives: under `latest` the commit id changes,
    // while the local slot keeps the name `dev` for every build it ever holds,
    // so there the answer is `published` — the moment the hub accepted the push,
    // which it stamps only when the slot actually changed. Never `built`: that
    // one is written by the model's own build script, is optional and has
    // second resolution at best, so an edit-build-look loop produces ties.
    const key = buildKey(next);
    if (key && meta && key !== buildKey(meta)
        && Array.isArray(next.variants) && next.variants.length) {
      pending = next;
    }
  } catch (e) {
    pollDelay = Math.min(POLL_MAX_MS, pollDelay * 2);
    console.warn("live poll", e);
  }
  await applyPending();
  schedulePoll(pollDelay);
}

function setLive(on, persist = true, delay = 0) {
  liveOn = on;
  $("live_cb").checked = on;
  if (persist) {
    try {
      localStorage.setItem(LIVE_KEY, on ? "on" : "off");
    } catch (e) {
      // Private mode, or storage turned off. The switch still works for this
      // page; it just will not be remembered for the next one.
      console.warn("live setting", e);
    }
  }
  if (on) {
    pollDelay = POLL_MS;
    schedulePoll(delay);
  } else {
    clearTimeout(pollTimer);
    pollTimer = null;
    pending = null;
    liveNote("");
  }
}

function setupLive() {
  if (!POINTER) return;   // an immutable build has nothing to watch for
  $("live_row").hidden = false;
  $("live_hint").hidden = false;
  $("live_cb").onchange = () => setLive($("live_cb").checked);

  // These three only ever write a timestamp or a flag. Passive, so they can
  // never call preventDefault, and they must stay that way: the trackball and
  // the section tool own these same events and neither may notice this exists.
  const opts = { capture: true, passive: true };
  const touched = () => { lastTouch = performance.now(); };
  box.addEventListener("pointerdown", () => {
    pointerHeld = true;
    touched();
  }, opts);
  box.addEventListener("wheel", touched, opts);
  // On the WINDOW: the trackball captures the pointer, so a drag that starts on
  // the canvas can perfectly well end outside it, and a pointerup missed here
  // would leave the page "busy" for good.
  for (const name of ["pointerup", "pointercancel"]) {
    addEventListener(name, () => {
      pointerHeld = false;
      touched();
    }, opts);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      pollDelay = POLL_MS;
      schedulePoll(0);
    } else {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  });

  let saved = null;
  try {
    saved = localStorage.getItem(LIVE_KEY);
  } catch (e) {
    console.warn("live setting", e);
  }
  // On unless it was switched off, and the first poll waits a full interval:
  // meta.json was fetched a moment ago by the bootstrap below and cannot have
  // changed since.
  setLive(saved !== "off", false, POLL_MS);
}

try {
  meta = await (await fetch(BASE + "meta.json")).json();
  fillHeader();
  fillDownloads();

  const vsel = $("variant");
  const want = new URLSearchParams(location.search).get("v");
  fillVariants(want);
  vsel.onchange = () => showVariant(vsel.value).catch((e) => fail("variant", e));

  fillBuilds(await (await fetch(`/project/${PID}/builds.json`)).json());
  const bsel = $("build");
  bsel.onchange = () => { location.href = `/project/${PID}/${bsel.value}/`; };

  await showVariant(vsel.value);
  setupComments();
  setupSection();
  setupPanels();
  setupWheel();
  setupOrbit();
  setupLive();

  addEventListener("resize", refit);
} catch (e) {
  fail("viewer init", e);
}
