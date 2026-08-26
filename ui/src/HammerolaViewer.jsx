/**
 * ============================================================================
 *  HammerolaViewer — the build page: tree, section, measure, move, comments
 * ============================================================================
 *
 * The designer's mock-up, ported onto the hub's real data and the real viewport.
 * What changed from the mock, and why, in one place so nobody has to diff it:
 *
 *   PARTS / NODES  -> the part tree the viewport hands over on `hmr:model`,
 *                     walked recursively (hub.indexTree). There is no flat node
 *                     list and there is not going to be one: the nesting IS the
 *                     assembly structure. This side does NOT fetch the view file
 *                     — the viewport fetches it to render it, and the tree is
 *                     inside that same two-megabyte document.
 *   REVS           -> /project/<pid>/builds.json, which carries the pointers
 *                     (`has_dev`, `latest`) beside the history of commits.
 *   DIFF           -> nothing. The hub has no endpoint that compares two
 *                     builds (plan step 8), so the panel is drawn and says so.
 *   notes          -> localStorage, keyed by part NAME, per project. No
 *                     endpoint exists; the editor says where they live.
 *   comments       -> the write endpoint is real and used. The FEED is not:
 *                     reading the queue is behind COMMENT_READ_TOKEN, an agent
 *                     secret shared across every project, which can never
 *                     travel to a browser. So the rail shows what was sent
 *                     from this session and explains the absence.
 *   buildStatus    -> polling meta.json on the two pointer URLs, which answers
 *                     exactly one of the brief's three questions: "has a new
 *                     build arrived while I was looking at this one".
 *   viewerMode     -> derived, not a prop: it is `no token`.
 *
 * THE TOKEN (brief, "Что разделяет заказчика и зрителя"). Whoever has it can
 * edit and comment; whoever does not gets the interface to look with. It is
 * typed in by the person, kept in localStorage per project, and removable.
 * Closed without it: the note on a part, moving a part, and comments entirely.
 * Open always: orbiting, the tree, the section, measuring, the downloads and the
 * frame grab.
 *
 * CONTRACT WITH THE VIEWPORT — see events.js for the names. Down, one event
 * carrying the whole of what should be on screen; up, nine. `sync()` below is
 * the only place this file writes to that event, exactly as in the mock.
 *
 * THREE PLACES THE MOCK'S CONTRACT WAS NOT TAKEN LITERALLY, all three because
 * the real viewport is a real one:
 *
 *   * `camera` does not travel in `hmr:state` from this side at all. The mock
 *     sent `{theta, phi, r}` about its own scene; the viewport wants the
 *     library's `{position, quaternion, target, zoom}`, and the only sensible
 *     source of those is the viewport itself. So Fit is `el.setCamera(home)`
 *     through the element's own imperative half, where `home` is the frame the
 *     library fitted when it first rendered this view. Going through the state
 *     event would also mean a camera that is applied once and then compares
 *     equal forever — Fit would work exactly one time.
 *   * the SNAPSHOT a comment carries is `el.snapshot()`, the library's own
 *     `getImage`, not a `canvas.toDataURL()` from outside. A WebGL canvas
 *     without `preserveDrawingBuffer` reads back blank unless the grab lands in
 *     the same frame as a draw.
 *   * the hold key is C and it belongs to the viewport, which knows which
 *     letters the library already eats. This file only listens for `hmr:tool`
 *     and shows what it is told.
 *
 * STYLING is inline, carried over from the mock so the layout stays 1:1 —
 * `css()` parses a CSS string into a React style object. Two exceptions, both
 * forced: the comment pins are DOM the viewport creates, so they are styled by
 * class from the one `<style>` block below; and the fonts are a system stack
 * rather than the mock's Google Fonts link, because this page's CSP is
 * `default-src 'self'`.
 */

import React from 'react';

import {
  STATE, PICK, FACE, MEASURE, MOVED, PLACE, PIN, MODEL, ERROR, TOOL,
  VIEWPORT_TAG,
} from './events.js';
import {
  PAGE, ASSEMBLED_VIEW_ID, isPointerPage, buildKey, indexTree,
  loadMeta, loadBuilds, shortId, stamp, day, mb,
} from './hub.js';
import {
  readToken, writeToken, clearToken, readNotes, writeNotes, rememberPointer,
} from './store.js';
// The canvas theme lives with the rest of the viewport's options, and so does the
// storage for it: `tests/test_ui_source.py` allows this side exactly one module
// that touches localStorage (store.js), and the viewport keeps its own answers
// under its own guard. Only the two functions come across — importing the option
// objects themselves would be this file deciding how the library is started.
import { readTheme, writeTheme } from './viewport/options.js';

/* CSS string -> React style object. Only here to keep the mock's markup 1:1. */
const cssCache = new Map();
export function css(str) {
  if (!str) return undefined;
  if (cssCache.has(str)) return cssCache.get(str);
  const out = {};
  str.split(';').forEach((decl) => {
    const i = decl.indexOf(':');
    if (i < 0) return;
    const prop = decl.slice(0, i).trim();
    const val = decl.slice(i + 1).trim();
    if (!prop || !val) return;
    const key = prop.startsWith('--') ? prop : prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = val;
  });
  cssCache.set(str, out);
  return out;
}

// The two families every rule below names, as custom properties on the root.
// System stacks and not a webfont: the page is served under `default-src 'self'`
// (src/app.py, CSP_HTML), so a font from another origin is blocked, and
// self-hosting one would add a binary to static/_v/ plus a line to every file
// that copies assets by name. A face is worth that when the typography carries
// meaning; here it does not.
const FONTS = {
  '--hmr-sans': 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
  '--hmr-mono': 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace',
};
const SANS = 'var(--hmr-sans)';
const MONO = 'var(--hmr-mono)';

/**
 * The only rules that cannot be inline styles.
 *
 * A comment pin is an element the VIEWPORT creates and positions — it has to be,
 * because its place on screen is a world point projected through a camera that
 * moves sixty times a second, and routing that through React would re-render the
 * interface on every mouse move. What crosses the boundary is the data and the
 * click; how a pin LOOKS stays here, which is why the viewport sets only class
 * names on it.
 *
 * Four class names, and the division between them and the viewport is the same
 * one every time: the viewport POSITIONS (inline, per frame, in code), this
 * stylesheet DECIDES HOW IT LOOKS. `.hmr_canvas` and `.hmr_overlay` are the two
 * layers the element builds — the library's container and the layer of pins over
 * it. Neither needs layout from here; what they need is the page's own colour
 * under the model instead of the browser's white, which is what shows while the
 * viewer module is still loading, and a font for anything the overlay grows
 * later. `.hmr_pin` and `.hmr_measure_label` are the two things drawn IN that
 * overlay, and their whole appearance is here.
 *
 * Injected as a `<style>` element rather than an imported stylesheet: an
 * `import './x.css'` would make this build emit a second output file, and that
 * name would then have to be added to the Makefile, the Dockerfile, ci/smoke.py
 * and the page template — see ui/vite.config.mjs, which says so at length.
 */
const PIN_CSS = `
.hmr_canvas {
  background: #e4e7ea;
}
.hmr_overlay {
  color: #1c1f23;
  font-family: ${FONTS['--hmr-sans']};
}
.hmr_pin {
  display: flex; align-items: center; justify-content: center;
  min-width: 20px; height: 20px; padding: 0 5px;
  transform: translate(-50%, -100%);
  border: none; border-radius: 10px 10px 10px 3px;
  background: #1f7ae0; color: #fff; cursor: pointer;
  font: 600 10.5px ${FONTS['--hmr-mono']};
  box-shadow: 0 2px 6px rgba(20, 24, 28, .35);
}
.hmr_pin.is_active { background: #14538f; box-shadow: 0 0 0 3px rgba(31, 122, 224, .35); }
.hmr_pin.is_resolved { background: #c3c8cf; color: #4a5057; }
.hmr_measure_label {
  padding: 3px 7px; border-radius: 4px;
  background: rgba(28, 31, 35, .88); color: #f2f3f5;
  font: 600 11px ${FONTS['--hmr-mono']};
}
`;

// The same number as the hub's ceiling on comment text — `comment_max_text_chars`
// in src/settings.py — spelled a second time here, because there is no way for
// the page to be told the hub's: `templates/build.html` is written into the build
// directory at PUBLISH time (src/render.py) and carries no per-hub values, and
// meta.json is written then too, while the setting is read per request and can
// change under a page that is already open.
//
// So this is a copy that can go stale, and it is worth being precise about which
// direction hurts. Raised on the hub, the form is merely stricter than it needs
// to be. LOWERED on the hub — the only reason anyone would touch it — and the
// textarea keeps accepting text the hub will refuse, which arrives back as a 422
// and the toast about photo formats. What this ceiling does buy, at every
// setting, is that the browser stops a runaway paste before it becomes a
// multipart upload.
const MAX_COMMENT_CHARS = 4000;

// How often a pointer page asks whether a newer build has landed. Below a
// second the poll costs more than what it watches for; above five the "did that
// take?" pause gets long enough that people reload by hand. Three is what this
// site has polled at since live reload existed; nothing depends on the exact
// value, only on it staying inside that window.
const POLL_MS = 3000;
const POLL_MAX_MS = 60000;

// How long a swap waits for the reader's hand, and how often it looks again.
//
// The viewport answers `isBusy()` for a drag in progress and for a moment after
// one (viewport/live.js), and a swap re-renders the scene and re-seats the
// camera — doing that between a press and its release pulls the model out from
// under the pointer. So the swap waits, and `pending` stays exactly where it is
// while it does, which is what keeps the offer from being lost.
//
// AND IT HAS A DEADLINE, because "busy" hangs on a `pointerup` this page is not
// guaranteed to see: a release over another window, or a tab that lost focus
// mid-drag, leaves the flag set with nobody left to clear it. The reader pressed
// Switch; a button that quietly does nothing for ever is worse than a model that
// jumps under a hand that is no longer there.
const BUSY_RETRY_MS = 250;
const BUSY_WAIT_MS = 5000;

/** The letter the viewport holds the cut tool up on. Shown, never bound here. */
const HOLD_KEY_LABEL = 'C';

/**
 * `meta.downloads` regrouped as part name -> the files published for that part.
 *
 * The hub publishes `{label: filename}` and nothing that says which part a file
 * belongs to — the answer is in the FILENAME, which is always `<part>.<ext>` for
 * ext in step/stl/3mf (`download_labels` in src/cadbuild/printables.py). Nothing
 * about the wire format changes for this; the grouping is done here, in the one
 * place that needs it.
 *
 * READ THE VALUE, NEVER THE KEY, and that is the whole trap: with a single
 * printable the LABEL degenerates to a bare `step` / `stl` / `3mf` with the part
 * name gone from it, while the filename does not degenerate at all. A menu built
 * by matching labels against a part name would therefore work on every assembly
 * except the one-part one, which is the smallest and most common case there is.
 *
 * SPLIT AT THE LAST DOT: a printable's name may itself contain dots (MEMBER_RE
 * allows them), so `v1.2.plate.stl` is the part `v1.2.plate`, not `v1`.
 *
 * A Map rather than an object, because the keys are model-supplied strings and
 * `__proto__` is a legal printable name — assigning it on an object literal
 * silently stores nothing.
 */
export function filesByPart(downloads) {
  const out = new Map();
  Object.values((downloads && typeof downloads === 'object') ? downloads : {})
    .forEach((value) => {
      const file = String(value);
      const cut = file.lastIndexOf('.');
      // No extension, or nothing before the dot: not a `<part>.<ext>` name, and
      // guessing at one would put a row in the menu that downloads nothing.
      if (cut <= 0 || cut === file.length - 1) return;
      const name = file.slice(0, cut);
      if (!out.has(name)) out.set(name, []);
      // In the order the hub wrote them — step, stl, 3mf — rather than sorted,
      // so the menu lists what was published in the order it was published.
      out.get(name).push({ ext: file.slice(cut + 1), file });
    });
  return out;
}

export default class HammerolaViewer extends React.Component {
  static defaultProps = { commentsOpen: true };

  constructor(props) {
    super(props);
    this.host = React.createRef();
    // The frame the library fitted when it first rendered this view, which is
    // the only definition of "fit" available to a side that does not know the
    // model's bounding box.
    this.home = null;
    this.state = {
      // -- what the hub said
      meta: null, builds: null, tree: null, error: null, viewError: null,
      pending: null,          // a newer build, seen by the poll, not applied
      // -- what the reader is doing
      view: null, tool: null, held: false, sel: null, selName: '',
      hidden: [], ghost: [], expanded: {},
      secOn: false, secOff: 0, secRange: null, secFlip: false, hatch: true,
      secFace: null, secPop: false,
      revOpen: false, dlOpen: false, cmp: [], compare: false, diffShow: 'both',
      bannerGone: false, rail: null, menu: null,
      notePop: null, noteDraft: '', notes: {},
      comments: [], activePin: null, composer: null,
      measure: null, moved: null, toast: null,
      // -- who the reader is
      token: readToken(PAGE.pid), tokenPop: false, tokenDraft: '',
      // -- and what they want to look at the model against. Read here so the
      // first paint is already the reader's answer: the same read seeds the
      // options the viewport starts the library with (viewport/options.js), so
      // the button below never has to correct a canvas that came up wrong.
      theme: readTheme(),
    };
  }

  /** No token, no edits. The whole of the customer/viewer split (brief). */
  viewer() { return !this.state.token; }

  // -- loading --------------------------------------------------------------
  componentDidMount() {
    this.setState({ notes: readNotes(PAGE.pid) });

    // This page IS the arrival, so this is where the reader's pointer is
    // recorded (SPEC 9, and store.js for why it is written here and read
    // somewhere else). Before the load rather than after it: what is being
    // remembered is the URL that was opened, and it is already known — a build
    // whose meta.json never arrives was still the build this reader asked for.
    //
    // Only on a pointer page. On `/project/<pid>/<commit>/` there is no choice
    // between the two moving names to record, and the URL that names a pointer
    // has to keep winning over the remembered one.
    if (isPointerPage()) rememberPointer(PAGE.pid, PAGE.slot);
    this.load().catch((error) => {
      console.error('hammerola', error);
      this.setState({ error: String(error && error.message ? error.message : error) });
    });

    this._h = {
      [PICK]: (e) => {
        const id = (e.detail && e.detail.id) || null;
        this.set({ sel: id, selName: (e.detail && e.detail.name) || '', menu: null });
      },
      // The plane moved: either it was just laid on a face, or a drag of it
      // ended. Both carry the depth measured FROM THAT FACE and the range the
      // slider has to span, so neither number is invented on this side.
      [FACE]: (e) => {
        const d = e.detail || {};
        this.set({
          secOn: true,
          secFace: d.name || 'face',
          secOff: Number.isFinite(d.offset) ? d.offset : this.state.secOff,
          secRange: Array.isArray(d.range) ? d.range : this.state.secRange,
          tool: null,
        });
      },
      [MEASURE]: (e) => {
        const answer = e.detail;
        if (!answer || !Number.isFinite(answer.value)) return;
        const measure = this.measureLabel(answer);
        this.setState((s) => ({
          measure,
          composer: s.composer ? { ...s.composer, meas: measure.full } : s.composer,
        }));
      },
      [MOVED]: (e) => {
        const d = (e.detail && e.detail.delta) || [];
        if (d.length !== 3 || !d.every(Number.isFinite)) return;
        const mag = Math.round(Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) * 10) / 10;
        this.setState({ moved: { id: e.detail.id, name: e.detail.name, mag } });
      },
      [PLACE]: (e) => {
        // A comment is a task for the agent, and only the customer files one.
        if (this.viewer()) return;
        const d = e.detail || {};
        this.set({
          composer: {
            part: d.name || 'model', partId: d.id || null, p: d.p || null,
            text: '', photo: null,
            meas: this.state.measure ? this.state.measure.full : null,
          },
          tool: null,
        });
      },
      [PIN]: (e) => this.set({ activePin: e.detail && e.detail.id, rail: true }),

      // A view finished rendering, and brought the tree with it.
      [MODEL]: (e) => {
        const d = e.detail || {};
        const tree = indexTree(d.tree);
        this.setState((s) => ({
          tree,
          view: d.view || s.view,
          viewError: null,
          // Both belonged to the scene that has just been torn down: the
          // viewport clears its own tape and its own offsets on every load, and
          // a chip left standing here would describe a model that is gone.
          measure: null,
          moved: null,
          // The reader's own collapses survive: part paths are the same across a
          // rebuild, and this is the tree they were reading a moment ago.
          expanded: { ...this.defaultExpanded(tree), ...s.expanded },
        }), () => { if (!d.live) this.captureHome(); });
      },
      // Block 11: a page that shows nothing has to say why. A silent viewport
      // leaves this interface drawing a frame around a hole.
      //
      // `setState` AND NOT `set()`, and that is load-bearing rather than a
      // shorthand: `set()` ends in `sync()`, which dispatches `hmr:state`, which
      // is what the viewport decides a load on. Reporting a failed load through
      // it would answer the report with another attempt at the same fetch —
      // forever, at whatever rate the errors come back. The viewport keeps its
      // own half of this (`loadFailed` in viewport/element.js); this line is the
      // other half, and neither one alone is enough.
      [ERROR]: (e) => this.setState({
        viewError: (e.detail && e.detail.message) || 'the viewport could not render this view',
      }),
      // The hold key, which the viewport owns. Display only — writing `cut` into
      // the tool this interface owns would make the release ambiguous, since the
      // viewport reports back the tool IT believes we set when the key comes up.
      [TOOL]: (e) => {
        const d = e.detail || {};
        this.setState({ held: !!d.held });
        if (d.escape) this.set({ tool: null });
      },
    };
    Object.keys(this._h).forEach((k) => window.addEventListener(k, this._h[k]));

    // Escape closes what is OPEN — a menu, a popover, an armed tool. It
    // deliberately does not close the composer: a half-written comment is the
    // most expensive thing on this page to lose, and Escape gets pressed by
    // reflex.
    this._kd = (e) => {
      if (e.key !== 'Escape') return;
      this.set({ menu: null, secPop: false, revOpen: false, dlOpen: false,
                 notePop: null, tokenPop: false, tool: null });
    };
    window.addEventListener('keydown', this._kd);

    // The viewport listens for `hmr:state` from its `connectedCallback`, so a
    // state sent before the element upgrades is simply lost. This is the resend
    // for the case where the adapter's module lands after the first paint — the
    // mock did the same thing with three timers, which is the version of this
    // that fails on a slow connection.
    if (window.customElements) {
      window.customElements.whenDefined(VIEWPORT_TAG)
        .then(() => this.sync())
        .catch((error) => console.warn('viewport', error));
    }
  }

  componentWillUnmount() {
    Object.keys(this._h || {}).forEach((k) => window.removeEventListener(k, this._h[k]));
    window.removeEventListener('keydown', this._kd);
    clearTimeout(this._tt);
    clearTimeout(this._poll);
    // The deferred swap goes with them: it holds `this` and would come back on a
    // component that is gone, to `setState` on it.
    clearTimeout(this._swap);
    this._gone = true;
  }

  async load() {
    const meta = await loadMeta();
    const builds = await loadBuilds().catch((error) => {
      // A project with no builds.json is a project whose picker is empty, not a
      // page that failed: the model in front of the reader is unaffected.
      console.warn('builds', error);
      return null;
    });
    const wanted = new URLSearchParams(location.search).get('v');
    const variant = meta.variants.find((v) => v.id === wanted) || meta.variants[0];
    // `view` is what makes the viewport fetch and render: it starts null on both
    // sides, so this first sync is also the load.
    this.setState({ meta, builds, view: variant.id },
                  () => { this.sync(); this.schedulePoll(POLL_MS); });
  }

  /**
   * Which nodes start open.
   *
   * Everything, on the assemblies people actually look at. The ceiling is there
   * because the brief asks for the hundred-part case too, and a hundred rows
   * opened over the model is the tree covering the thing it describes.
   */
  defaultExpanded(tree) {
    const open = {};
    const all = tree.nodes.size <= 200;
    tree.nodes.forEach((node) => {
      if (node.isNode && (all || node.depth === 0)) open[node.id] = true;
    });
    return open;
  }

  node(id) {
    const tree = this.state.tree;
    return id && tree ? tree.nodes.get(id) || null : null;
  }

  // -- the one place the interface writes to the viewport -------------------
  sync(extra) {
    const s = this.state;
    const meta = s.meta;
    const pins = s.comments
      .filter((c) => c.pin)
      .map((c) => ({ id: c.id, label: c.label, p: c.pin, resolved: c.resolved,
                     active: s.activePin === c.id }));
    if (s.composer && s.composer.p) {
      pins.push({ id: 'draft', label: '+', p: s.composer.p, active: true });
    }
    window.dispatchEvent(new CustomEvent(STATE, {
      detail: {
        // Where the geometry is and which of it to show. `views` is meta.json's
        // own list, passed through rather than reshaped: the viewport reads `id`
        // and `file` off it, which is exactly what src/render.py writes.
        base: PAGE.base,
        views: (meta && meta.variants) || [],
        view: s.view,
        // What makes one build different from the last. The viewport uses it to
        // tell a LIVE RELOAD (same view, new geometry — keep the frame) from a
        // first load, and this side computes it because this side reads
        // meta.json.
        buildKey: buildKey(meta),

        hidden: s.hidden, ghost: s.ghost, selected: s.sel,
        cut: s.secOn, cutOffset: s.secOff, cutFlip: s.secFlip, tool: s.tool,
        // `single` is the only mode this can be in today: `diff` asks the
        // viewport to ghost both revisions and light up the difference, and
        // there is no difference to light up until the hub can compute one.
        mode: 'single', diffShow: s.diffShow, pins,
        ...(extra || {}),
      },
    }));
  }

  set(patch, extra) { this.setState(patch, () => this.sync(extra)); }

  toast(msg) {
    clearTimeout(this._tt);
    this.setState({ toast: msg });
    this._tt = setTimeout(() => this.setState({ toast: null }), 2600);
  }

  // -- the viewport's imperative half ---------------------------------------
  // Questions and one-shot commands rather than state, so they are method calls
  // rather than events: a comment needs the frame and a PNG of it AT THE MOMENT
  // SEND IS PRESSED, and Fit has to work the second time it is pressed as well
  // as the first, which a field compared against its last applied value does
  // not.
  el() { return this.host.current; }

  captureHome() {
    const el = this.el();
    if (!el || typeof el.getCamera !== 'function') return;
    try {
      this.home = el.getCamera();
    } catch (error) {
      console.warn('camera', error);
    }
  }

  fitView() {
    const el = this.el();
    if (!el || !this.home || typeof el.setCamera !== 'function') {
      this.toast('Nothing to fit to yet');
      return;
    }
    el.setCamera(this.home);
  }

  frameBlob() {
    const el = this.el();
    if (!el || typeof el.snapshot !== 'function') return Promise.resolve(null);
    return Promise.resolve(el.snapshot('hammerola')).catch((error) => {
      console.warn('snapshot', error);
      return null;
    });
  }

  frameCamera() {
    const el = this.el();
    if (!el || typeof el.getCamera !== 'function') return null;
    try {
      return el.getCamera();
    } catch (error) {
      console.warn('camera', error);
      return null;
    }
  }

  async saveFrame() {
    const blob = await this.frameBlob();
    if (!blob) { this.toast('The viewport has no frame to save yet'); return; }
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${this.state.meta.project}-${shortId(this.state.meta.commit)}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) {
      console.warn('frame', error);
      this.toast('Could not save the frame');
    }
  }

  /**
   * Light or dark under the model — remembered, and applied to the live scene.
   *
   * THE CHROME DOES NOT MOVE. Everything this interface draws stays light in
   * both modes; what changes is the canvas, which is the library's and which is
   * the whole of what looked out of place. `theme` is the library's own word for
   * it and carries more than the background — the grid and the orientation
   * marker are tinted with it — but both of those are off in this viewport
   * (viewport/options.js), so on this page it IS the background.
   *
   * WHY IT GOES THROUGH `viewer` AND NOT THROUGH THE ELEMENT. This is the one
   * place this file reaches past the element's imperative half, and it is worth
   * saying why rather than tidying later. The library resolves the theme once,
   * at construction, into its own state, and re-asserts THAT value at the end of
   * every render — so setting the attribute from outside, or changing the option
   * object, holds only until the next view switch. `setTheme` is the library's
   * public answer to exactly this and keeps its state in step; the element has no
   * method to forward it, and adding one is not this change's file to edit.
   *
   * Guarded end to end, because every step of it is allowed to be missing: no
   * adapter on the page, a viewport that has not rendered yet, an older library.
   * The setting is still stored, and the next page load comes up in it.
   */
  applyTheme(value) {
    const theme = writeTheme(value);
    this.setState({ theme });
    try {
      const el = this.el();
      const viewer = el && el.viewer;
      if (viewer && typeof viewer.setTheme === 'function') viewer.setTheme(theme);
    } catch (error) {
      console.warn('theme', error);
    }
  }

  // -- has a newer build landed while we were looking at this one? ----------
  // The only one of the brief's three build questions (block 11) with a source
  // today: `building` and `failed` need the job status endpoint that comes with
  // plan step 5. And it never swaps the model by itself — somebody in the middle
  // of a section with half the tree hidden reads a model that changed under them
  // as a breakage.
  schedulePoll(delay) {
    if (!isPointerPage() || this._gone) return;
    clearTimeout(this._poll);
    this._poll = setTimeout(() => this.poll(), delay);
  }

  async poll() {
    if (this._gone) return;
    let delay = POLL_MS;
    try {
      if (document.visibilityState !== 'hidden') {
        const next = await loadMeta(true);
        const key = buildKey(next);
        if (key && key !== buildKey(this.state.meta)
            && Array.isArray(next.variants) && next.variants.length) {
          // `bannerGone` is lifted only for a build this page has not offered
          // yet. The same build is seen again on every poll for as long as
          // nobody takes it, so clearing the flag unconditionally would put the
          // banner back three seconds after Later took it down and leave that
          // button meaning nothing at all.
          const offered = key === buildKey(this.state.pending);
          this.setState({ pending: next, ...(offered ? null : { bannerGone: false }) });
        }
      }
    } catch (error) {
      // A hub that is down — a deploy, most likely — must not be hammered at
      // full rate by every tab anyone left open.
      delay = Math.min(POLL_MAX_MS, (this._pollDelay || POLL_MS) * 2);
      console.warn('poll', error);
    }
    this._pollDelay = delay;
    this.schedulePoll(delay);
  }

  /** Take the build the banner is offering, keeping the frame and the tree.
   *
   * NOT WHILE THE VIEWPORT IS IN THE READER'S HANDS. `isBusy()` is the one
   * question the viewport can answer and this side cannot — a drag in progress,
   * and the moment just after one — and the swap it guards is the whole scene
   * being rebuilt under the pointer. The wait is bounded (BUSY_WAIT_MS above);
   * `since` is how a retry tells this call when the reader pressed the button,
   * and nothing else passes it.
   */
  takePending(since) {
    const next = this.state.pending;
    if (this._gone || !next || !Array.isArray(next.variants) || !next.variants.length) return;
    // At most one wait at a time: a second press must not leave two timers
    // racing to swap the same build.
    clearTimeout(this._swap);
    const asked = since || Date.now();
    let busy = false;
    try {
      const el = this.el();
      busy = !!(el && typeof el.isBusy === 'function' && el.isBusy());
    } catch (error) {
      // A viewport that cannot answer is not a reason to refuse the build.
      console.warn('viewport busy', error);
    }
    if (busy && Date.now() - asked < BUSY_WAIT_MS) {
      // `pending` is left standing, so the banner stays up and Switch keeps its
      // meaning while the wait runs. The TIMER, meanwhile, is owned by exactly
      // two other places, and both of them cancel it rather than letting it
      // arrive: `componentWillUnmount` (it would come back on a component that
      // is gone) and `dismissPending` (Later is an answer, and a swap that
      // happened a quarter of a second after it would be this page overruling
      // the reader).
      this._swap = setTimeout(() => this.takePending(asked), BUSY_RETRY_MS);
      return;
    }
    const keep = next.variants.some((v) => v.id === this.state.view);
    this.setState({
      meta: next, pending: null, bannerGone: true,
      view: keep ? this.state.view : next.variants[0].id,
    }, () => {
      // A changed `buildKey` under the same `view` is what the viewport reads as
      // a live reload: it captures the camera, the visibility and the section,
      // renders the new geometry and puts them all back. Nothing here has to
      // arrange that beyond sending the new numbers.
      this.sync();
      this.toast(`Now viewing ${shortId(next.commit)} — your frame and tree are kept`);
    });
  }

  /** Later: this build is not wanted now.
   *
   * IT HAS TO CANCEL THE WAIT, and that is the whole of why this is a method
   * rather than a `setState` at the call site. Switch defers while the reader's
   * hand is on the model (`takePending` above), and hiding the banner does not
   * reach the timer that deferral left running — so a reader who pressed Switch,
   * saw nothing happen and pressed Later got the swap anyway, a quarter of a
   * second after refusing it. On a real prototype, with fake timers: `after
   * Later: meta = abc, pending = null`.
   *
   * THE OFFER ITSELF IS KEPT on `pending` and only the banner goes, so nothing
   * is lost and `poll` has something to compare against: it lifts `bannerGone`
   * for a build this page has not offered yet and leaves it standing for the one
   * that was just refused. Dismissing a build therefore lasts until a NEWER one
   * lands, rather than until the next poll three seconds later — which would
   * make this button a no-op that looks like a broken one.
   */
  dismissPending() {
    clearTimeout(this._swap);
    this.setState({ bannerGone: true });
  }

  // -- measurements ---------------------------------------------------------
  /**
   * One measurement, with the qualifier the brief (block 7) insists on.
   *
   * The viewport reports two facts about every answer: whether it spans two
   * different parts, and whether anything has been dragged. Inside one part — a
   * wall thickness, a hole, an edge — no arrangement of the assembly can make
   * the number wrong. BETWEEN parts it is a distance between where they are
   * standing right now, which on a print bed, or after a drag, is not where they
   * are in the assembly. These numbers travel to an agent as a task, so that
   * cannot be handed over silently.
   */
  measureLabel(a) {
    const unit = a.kind === 'area' ? 'mm²' : a.kind === 'volume' ? 'mm³' : 'mm';
    const value = `${a.approximate ? '≈' : ''}${Number(a.value).toFixed(2)} ${unit}`;
    const text = a.kind === 'distance' ? value : `${a.kind} ${value}`;
    const laidOut = a.moved || this.state.view !== ASSEMBLED_VIEW_ID;
    const note = a.crossPart && laidOut ? 'as the parts stand in this view' : '';
    return { text, note, full: note ? `${text} · ${note}` : text };
  }

  // -- comments -------------------------------------------------------------
  async sendComment() {
    const c = this.state.composer;
    const meta = this.state.meta;
    if (!c || !meta) return;
    const text = (c.text || '').trim();
    if (!text) { this.toast('Write something first'); return; }

    // The hub's comment schema is closed — src/comments.py keeps `text`, `view`,
    // `part`, `point` and `camera` and DROPS everything else without saying so —
    // so the measurement and the drag ride in the text, where the agent will
    // actually read them, rather than in fields discarded on the way in.
    const extra = [];
    if (c.meas) extra.push(`measured: ${c.meas}`);
    if (c.move) extra.push(`moved: ${c.move} (temporary, not in the model)`);

    const form = new FormData();
    form.append('comment', JSON.stringify({
      text: extra.length ? `${text}\n\n${extra.join('\n')}` : text,
      view: this.state.view,
      part: c.partId || null,
      point: c.p || null,
      camera: this.frameCamera(),
    }));
    if (c.photo) form.append('photo', c.photo, 'photo');
    const shot = await this.frameBlob();
    if (shot) form.append('shot', shot, 'shot.png');

    // Sent whether or not the hub asks for it yet: the write endpoint is still
    // public (plan step 0 closes it), and a header it ignores today is the
    // header it will require tomorrow.
    const headers = {};
    if (this.state.token) headers.Authorization = `Bearer ${this.state.token}`;

    let response = null;
    try {
      response = await fetch(`/api/v1/comments/${PAGE.pid}/${meta.commit}`,
                             { method: 'POST', body: form, headers });
    } catch (error) {
      console.error('comment', error);
      this.toast('Could not reach the hub');
      return;
    }
    if (response.status !== 201) {
      // Fixed sentences rather than the hub's own message: nothing on this page
      // should be in the habit of putting a response body on the screen.
      const said = {
        401: 'The hub refused the token',
        404: 'This build is no longer available',
        413: 'Too large — try a smaller photo',
        422: 'The hub refused this comment. Is the photo a JPEG, PNG or WebP?',
        429: 'Too many comments from here. Try again in a few minutes.',
      }[response.status];
      this.toast(said || 'Could not send the comment');
      return;
    }

    let id = `local-${Date.now()}`;
    try {
      const body = await response.json();
      if (body && typeof body.id === 'string') id = body.id;
    } catch (error) {
      console.warn('comment id', error);
    }
    this.set({
      comments: this.state.comments.concat({
        id, label: String(this.state.comments.length + 1),
        part: c.part, partId: c.partId, pin: c.p, text,
        time: 'just now', resolved: false, meas: c.meas || null,
      }),
      composer: null,
      moved: c.move ? null : this.state.moved,
      rail: true,
    }, c.move ? { __resetMove: true } : null);
    this.toast('Sent to the agent — a rebuild will follow');
  }

  // -- helpers --------------------------------------------------------------
  toggle(list, ids) {
    const set = new Set(list);
    const anyOn = ids.some((id) => set.has(id));
    ids.forEach((id) => { if (anyOn) set.delete(id); else set.add(id); });
    return Array.from(set);
  }

  saveNotes(notes) {
    writeNotes(PAGE.pid, notes);
    this.setState({ notes });
  }

  subtitle() {
    const meta = this.state.meta;
    const current = meta.variants.find((v) => v.id === this.state.view) || meta.variants[0];
    const total = meta.variants.reduce((sum, v) => sum + Number(v.gzip || 0), 0);
    const views = meta.variants.length === 1 ? '1 view' : `${meta.variants.length} views`;
    return `${current.parts} parts · ${views} · ${mb(total)}`;
  }

  /** A note hangs on a part NAME, so a group row has none of its own. */
  selectedName() {
    const node = this.node(this.state.sel);
    if (node) return node.isNode ? '' : node.name;
    return this.state.selName || '';
  }

  selectedNote() {
    const name = this.selectedName();
    return (name && this.state.notes[name]) || '';
  }

  /**
   * Switch views.
   *
   * One field, and the viewport does the rest: a changed `view` is a different
   * arrangement of the same parts, with its own extent and orientation, so it is
   * fetched and shown whole rather than under the old camera (brief, block 2).
   */
  showView(id) {
    if (id === this.state.view) return;
    this.set({ view: id });
  }

  /**
   * Ask the viewport for this view again — the button in block 11's panel.
   *
   * THE ONLY WAY BACK from a view that did not render, and it had to be added
   * rather than found: the viewport remembers a failed load so that the state
   * event this interface sends on every click does not re-fetch a missing file
   * forever (viewport/element.js, `loadFailed`), and nothing on this page could
   * clear that memory. Choosing a revision is a whole navigation, `showView`
   * returns immediately when the id is the one already chosen, and the panel
   * itself was text with nothing to press — so on a build with a single view a
   * blip in the network was a dead end until somebody thought to reload the page.
   *
   * `__retry` and not a method call on the element, because it IS a one-shot
   * command and the element already takes three of those the same way
   * (`__resetMove`, `__resetCut`, `__clearMeasure`): it rides the one state
   * event, is acted on, and is deleted rather than left standing in a field.
   *
   * `viewError` is cleared here so the panel goes while the fetch runs. Nothing
   * else has to put it back — a second failure emits `hmr:error` again, and a
   * success clears it through the model handler.
   */
  retryView() {
    this.set({ viewError: null }, { __retry: true });
  }

  /** All derived values and handlers. render() below only lays them out. */
  computed() {
    const s = this.state;
    const tree = s.tree;
    const meta = s.meta;
    const viewer = this.viewer();
    const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };
    const hiddenSet = new Set(s.hidden);
    const ghostSet = new Set(s.ghost);

    // -- the tree: a flat list of rows, indented by depth
    const rows = [];
    const eyeOuter = (st) => 'width:15px;height:10px;border:1.5px solid ' + (st === 'off' ? '#c3c8cf' : '#4a5057') + ';border-radius:50%;display:flex;align-items:center;justify-content:center';
    const eyeDot = (st) => 'width:5px;height:5px;border-radius:3px;' + (st === 'on' ? 'background:#4a5057' : st === 'part' ? 'background:linear-gradient(90deg,#4a5057 50%,#c3c8cf 50%)' : 'background:transparent');
    const ghostIcon = (on) => 'width:11px;height:11px;border-radius:3px;' + (on ? 'background:linear-gradient(135deg,#4a5057 50%,rgba(74,80,87,.2) 50%);border:1px solid #4a5057' : 'border:1px solid #b6bcc4;background:linear-gradient(135deg,rgba(182,188,196,.5) 50%,transparent 50%)');

    const emit = (node) => {
      const expanded = !!s.expanded[node.id];
      const visible = node.leaves.filter((id) => !hiddenSet.has(id)).length;
      const eye = visible === 0 ? 'off' : visible === node.leaves.length ? 'on' : 'part';
      const ghosted = node.leaves.length > 0 && node.leaves.every((id) => ghostSet.has(id));
      const selected = s.sel === node.id;
      const meta_ = node.isNode
        ? (eye === 'part' ? `${visible}/${node.leaves.length}` : String(node.leaves.length))
        : (node.known ? '' : '?');
      rows.push({
        key: node.id,
        rowStyle: 'display:inline-flex;align-items:center;gap:2px;height:24px;padding:0 6px 0 3px;margin:0 0 1px ' + (node.depth * 16) + 'px;border-radius:4px;background:' + (selected ? '#cfe6fb' : 'rgba(255,255,255,.78)') + ';cursor:default',
        caret: node.isNode ? (expanded ? '▾' : '▸') : '',
        caretStyle: 'width:14px;flex:none;text-align:center;font-size:9px;color:#8a9099;cursor:pointer;' + (node.isNode ? '' : 'visibility:hidden'),
        onExpand: stop(() => node.isNode
          && this.setState({ expanded: { ...s.expanded, [node.id]: !expanded } })),
        eyeOuter: eyeOuter(eye), eyeDot: eyeDot(eye), ghostIcon: ghostIcon(ghosted),
        dotStyle: 'width:9px;height:9px;border-radius:3px;flex:none;margin:0 4px 0 2px;background:' + (node.color || 'transparent') + (node.isNode ? ';border:1px solid #c3c8cf;background:transparent' : ''),
        name: node.name,
        nameStyle: 'white-space:nowrap;cursor:pointer;padding-right:4px;font:' + (node.isNode ? '600 12px ' : '400 12px ') + MONO + ';color:' + (eye === 'off' ? '#9aa1a9' : '#2a2e33'),
        meta: meta_,
        // Said out loud rather than dropped: a leaf the viewport could not match
        // to the library's own state map is a row nothing can be done to, and a
        // tree missing a row reads as a build with fewer parts.
        metaTitle: node.isNode || node.known ? '' : 'the viewport does not know this part',
        metaStyle: `flex:none;font:400 10px ${MONO};color:#b0b6bd;padding:0 2px`,
        // A group toggles as a whole: anything still visible means hide it all,
        // nothing visible means show it all. Expressed in LEAF ids — see
        // hub.indexTree for why.
        onVis: stop(() => this.set({ hidden: this.toggle(s.hidden, node.leaves) })),
        onGhost: stop(() => this.set({ ghost: this.toggle(s.ghost, node.leaves) })),
        onSelect: stop(() => this.set({ sel: node.id, selName: node.name })),
        onMenu: stop((e) => {
          e.preventDefault();
          this.setState({
            menu: {
              id: node.id,
              x: Math.min(e.clientX, Math.max(0, window.innerWidth - 246)),
              y: Math.min(e.clientY, Math.max(0, window.innerHeight - 300)),
            },
          });
        }),
      });
      if (node.isNode && expanded) node.children.forEach((id) => emit(tree.nodes.get(id)));
    };
    if (tree) tree.roots.forEach((id) => emit(tree.nodes.get(id)));

    const secSub = s.secOn
      ? `${s.secFace || 'plane'} · ${s.secOff >= 0 ? '+' : ''}${s.secOff.toFixed(1)} mm`
      : 'off';
    const secRange = Array.isArray(s.secRange) ? s.secRange : [-30, 30];

    // -- the revision picker, from builds.json
    const info = s.builds || { has_dev: false, latest: null, builds: [] };
    const history = Array.isArray(info.builds) ? info.builds : [];
    const revs = [];
    if (info.has_dev) {
      revs.push({ id: 'dev', head: 'POINTERS', badge: '→ local build',
                  date: '', pointer: true });
    }
    if (info.latest) {
      revs.push({ id: 'latest', head: info.has_dev ? '' : 'POINTERS',
                  badge: `→ ${shortId(info.latest)}`, date: '', pointer: true });
    }
    history.forEach((b, at) => revs.push({
      id: b.commit, head: at === 0 ? 'BUILDS' : '', badge: '',
      date: day(b.built), pointer: false,
    }));

    const revRows = revs.map((r) => {
      const current = r.id === PAGE.slot;
      const inCmp = s.cmp.includes(r.id);
      return {
        key: r.id,
        head: r.head || '',
        headStyle: r.head ? `padding:7px 14px 3px;font:600 9.5px ${MONO};color:#9aa1a9;letter-spacing:.09em` : 'display:none',
        id: r.pointer ? r.id : shortId(r.id),
        date: r.date,
        idStyle: `font:600 12px ${MONO};color:` + (current ? '#1f6fd0' : r.pointer ? '#7c3aad' : '#2a2e33'),
        badge: current && !r.badge ? 'viewing' : r.badge,
        badgeStyle: `font:500 10.5px ${MONO};` + (r.pointer ? 'color:#8a9099' : (current || r.badge) ? 'padding:2px 6px;border-radius:4px;background:#e3effc;color:#1f6fd0' : 'display:none'),
        style: 'display:flex;align-items:center;gap:4px;padding:7px 14px 7px 10px;' + (current ? 'background:#f0f6fd;' : '') + 'cursor:default',
        cmpMark: inCmp ? '✓' : '',
        cmpStyle: `width:16px;height:16px;border-radius:4px;flex:none;margin-right:6px;display:flex;align-items:center;justify-content:center;font:600 10px ${MONO};cursor:pointer;` + (inCmp ? 'background:#1f7ae0;color:#fff;border:1px solid #1c67c2' : 'border:1px solid #c3c8cf;background:#fff;color:transparent'),
        onCmp: stop(() => {
          let picked = s.cmp.includes(r.id) ? s.cmp.filter((x) => x !== r.id) : s.cmp.concat(r.id);
          if (picked.length > 2) picked = picked.slice(-2);
          this.setState({ cmp: picked });
        }),
        // A build is an ADDRESS, so switching to one is a navigation and not a
        // state change: the URL is the thing that has to keep saying which
        // geometry this is, a year from now, to whoever the link was sent to.
        onPick: stop(() => { location.href = `/project/${PAGE.pid}/${r.id}/`; }),
      };
    });
    const cmpReady = s.cmp.length === 2;

    // -- the downloads, from meta.downloads: label -> file name
    const fileHref = (file) => PAGE.base + encodeURIComponent(String(file));
    const downloads = Object.entries((meta && meta.downloads) || {}).map(([label, file]) => ({
      key: label,
      label: String(label).toUpperCase(),
      file: String(file),
      href: fileHref(file),
    }));
    // The same files, cut up by part, for the row menu below.
    const partFiles = filesByPart(meta && meta.downloads);

    const threads = s.comments.map((c) => ({
      key: c.id, label: c.label, part: c.part, time: c.time, text: c.text, meas: c.meas,
      style: 'padding:10px 12px;background:#fff;border:1px solid ' + (s.activePin === c.id ? '#9cc4f0' : '#e3e6ea') + ';border-radius:8px;cursor:pointer;' + (c.resolved ? 'opacity:.62' : ''),
      pinStyle: `width:20px;height:20px;border-radius:10px 10px 10px 3px;flex:none;display:flex;align-items:center;justify-content:center;font:600 10.5px ${MONO};` + (c.resolved ? 'background:#e3e6ea;color:#8a9099' : 'background:#1f7ae0;color:#fff'),
      measStyle: c.meas ? `margin-top:6px;display:inline-flex;padding:3px 7px;background:#fdf0d8;border-radius:4px;font:500 10.5px ${MONO};color:#8a6a1f` : 'display:none',
      onOpen: stop(() => this.set({ activePin: c.id })),
      // Closing an item is the agent's move, through the queue endpoint behind
      // COMMENT_READ_TOKEN. That token is shared across every project's queue,
      // so it cannot come to a browser and this cannot become a button here.
      onResolve: stop(() => this.toast('Marking a comment processed is the agent’s side of the queue')),
    }));
    const openCount = s.comments.filter((c) => !c.resolved).length;

    // -- context menu on a tree row
    const mNode = this.node(s.menu && s.menu.id);
    const mName = mNode ? mNode.name : '';
    const note = mNode ? s.notes[mNode.name] : '';
    // `href` turns the row into a real `<a download>` — see the files block
    // below — and `tone` is 'top' for a rule above the row, 'said' for a row that
    // states something rather than doing it.
    //
    // A 'said' ROW GETS NO HANDLER AT ALL, which is what makes its `cursor:
    // default` and its grey true rather than a costume. It used to be styled
    // unclickable and then handed an `onClick` anyway — one that stopped the
    // event and closed the menu, i.e. a row that acted while saying it would
    // not. Without one the row is inert, which is exactly what it claims to be:
    // the click stops at the menu's own wrapper (which stops propagation so that
    // a press on the menu's padding does not close it through `rootClick`), and
    // the menu closes on the next click anywhere outside, as it always has.
    const mi = (label, hint, fn, tone, href) => ({
      key: label, label, hint: hint || '', href: href || '',
      style: `display:flex;align-items:center;gap:10px;padding:7px 14px;text-decoration:none;font:400 12px ${SANS};`
        + (tone === 'said' ? 'cursor:default;color:#8a9099' : 'cursor:pointer;color:#2a2e33')
        + (tone === 'top' || tone === 'said' ? ';border-top:1px solid #e3e6ea' : ''),
      onClick: tone === 'said'
        ? undefined
        : stop(() => { fn(); this.setState({ menu: null }); }),
    });

    /**
     * This part's files — the row-menu half of the header's Downloads menu.
     *
     * Three rows and not a submenu: one click cannot sensibly deliver three
     * files, this menu has no submenu machinery anywhere in it, and a row per
     * file is exactly what the header's menu already looks like — extension on
     * the left, filename on the right. Each one is a plain `<a href download>`
     * against the same base URL the header builds, so middle-click and "save
     * link as" work on it like any other link on the page.
     *
     * BOTH EMPTY CASES SAY SO OUT LOUD. A reference part — a tree node that is
     * not in `printables()` — has no files and never will, and a menu that
     * silently dropped the item would read as a menu that forgot. Same for a
     * build that ships nothing: the header's menu has a sentence for that case
     * and this one must not be worse.
     */
    const fileRows = (name) => {
      if (!downloads.length) return [mi('No files in this build', '', () => {}, 'said')];
      const files = partFiles.get(name) || [];
      if (!files.length) return [mi('No files for this part', 'not a printable', () => {}, 'said')];
      return files.map((f, at) => mi(f.ext.toUpperCase(), f.file, () => {},
                                     at === 0 ? 'top' : '', fileHref(f.file)));
    };

    const menuItems = !mNode ? [] : [
      mi('Isolate', 'show only this', () => {
        const keep = new Set(mNode.leaves);
        this.set({ hidden: tree.leaves.filter((id) => !keep.has(id)),
                   sel: mNode.id, selName: mNode.name });
      }),
      mi('Hide', '', () => this.set({ hidden: this.toggle(s.hidden, mNode.leaves) })),
      mi('Translucent', 'see through it', () => this.set({ ghost: this.toggle(s.ghost, mNode.leaves) })),
      ...(viewer || mNode.isNode ? [] : [mi('Note', note ? (note.length > 22 ? `${note.slice(0, 22)}…` : note) : '',
        () => this.setState({ notePop: mNode.name, noteDraft: note || '' }))]),
      // Files hang on a PART, so a group row has none of its own — the same rule
      // and the same reason as the note above it. A group is not a printable and
      // never has files under its own name; offering the union of its leaves'
      // instead would be one click asking the browser for a dozen downloads,
      // which browsers block after the first, and the whole build's files are one
      // menu away in the header already.
      ...(mNode.isNode ? [] : fileRows(mNode.name)),
      mi('Copy name', '', () => {
        try {
          navigator.clipboard.writeText(mNode.name);
          this.toast(`copied: ${mNode.name}`);
        } catch (error) {
          console.warn('clipboard', error);
          this.toast('Could not copy the name');
        }
      }, 'top'),
    ];

    const btn = (active, hide) => `display:flex;align-items:center;gap:6px;padding:6px 11px;border-radius:6px;font:500 12px ${SANS};cursor:pointer;border:1px solid ` + (active ? '#9cc4f0;background:#dcebfc;color:#155bb5' : 'transparent;color:#3c4147') + (hide ? ';display:none' : '');
    const tab = (active) => `padding:5px 13px;border-radius:5px;font:500 12px ${SANS};cursor:pointer;` + (active ? 'background:#fff;color:#1c1f23;box-shadow:0 1px 2px rgba(0,0,0,.1)' : 'color:#5b6470');
    const chip = (show, bg, border, color) => 'pointer-events:auto;display:' + (show ? 'flex' : 'none') + `;align-items:center;gap:8px;padding:7px 12px;background:${bg};border:1px solid ${border};border-radius:7px;font:500 11.5px ${SANS};color:${color};box-shadow:0 2px 8px rgba(20,24,28,.08)`;

    const setTool = (t) => () => {
      this.set({ tool: s.tool === t ? null : t, revOpen: false, dlOpen: false, menu: null });
      if (t === 'comment' && s.tool !== 'comment') this.toast('Click a spot on the model to pin the task');
      if (t === 'measure' && s.tool !== 'measure') this.toast('Click a part for its size, or two for the gap between them');
      if (t === 'move' && s.tool !== 'move') this.toast('Drag a part — it snaps back on the next rebuild');
    };

    // Two of these are reachable today. `building` and `failed` need the job
    // status endpoint that arrives with plan step 5; the brief (block 11) asks
    // for all of them, and that step is what fills them in.
    const status = s.pending
      ? { text: 'new build ready', style: 'color:#1f6fd0;background:#e3effc;border:1px solid #bcd8f5', dot: '#1f7ae0' }
      : { text: isPointerPage() ? 'up to date' : 'pinned build', style: 'color:#5b6470;background:transparent;border:1px solid transparent', dot: '#2e9e44' };

    const railOpen = s.rail === null ? this.props.commentsOpen : s.rail;
    const cutOn = s.secOn || s.held;

    return {
      rootClick: () => this.setState({ menu: null, revOpen: false, dlOpen: false, tokenPop: false }),

      title: (meta && (meta.title || meta.project)) || '',
      subtitle: meta ? this.subtitle() : '',
      slot: PAGE.slot,
      slotBadge: PAGE.slot === 'dev' ? 'auto-updates' : PAGE.slot === 'latest' ? 'follows CI' : 'pinned',
      slotDate: meta ? stamp(meta.built) : '',
      revToggle: stop(() => this.setState({ revOpen: !s.revOpen, dlOpen: false, tokenPop: false })),
      revBtnStyle: 'display:flex;align-items:center;gap:8px;padding:6px 11px;border:1px solid #d3d8de;background:#fff;border-radius:6px;cursor:pointer',
      revMenuStyle: 'position:absolute;left:0;top:40px;width:430px;background:#fff;border:1px solid #d3d8de;border-radius:9px;box-shadow:0 10px 34px rgba(20,24,28,.16);z-index:40;display:' + (s.revOpen ? 'block' : 'none'),
      revRows,
      revEmpty: revRows.length === 0,
      cmpLabel: cmpReady ? `${s.cmp[0]} → ${s.cmp[1]}` : '',
      compareBtnStyle: `padding:7px 14px;border-radius:6px;font:600 12px ${SANS};cursor:pointer;` + (cmpReady ? 'background:#1f7ae0;color:#fff' : 'background:#eceef1;color:#b0b6bd;pointer-events:none'),
      startCompare: stop(() => this.setState({ compare: true, revOpen: false })),

      statusChipStyle: `display:flex;align-items:center;gap:7px;padding:6px 11px;border-radius:6px;font:500 11.5px ${SANS};` + status.style,
      statusText: status.text,
      statusDotStyle: `width:8px;height:8px;border-radius:4px;background:${status.dot};flex:none`,

      downloads,
      dlToggle: stop(() => this.setState({ dlOpen: !s.dlOpen, revOpen: false, tokenPop: false })),
      dlBtnStyle: btn(s.dlOpen) + ';border:1px solid #d3d8de;background:#fff',
      dlMenuStyle: 'position:absolute;right:0;top:40px;width:250px;background:#fff;border:1px solid #d3d8de;border-radius:9px;box-shadow:0 10px 34px rgba(20,24,28,.16);padding:6px 0;z-index:40;display:' + (s.dlOpen ? 'block' : 'none'),

      // -- the token: the whole customer/viewer split, in one control
      viewer,
      tokenToggle: stop(() => this.setState({
        tokenPop: !s.tokenPop, tokenDraft: '', revOpen: false, dlOpen: false })),
      tokenBtnStyle: btn(false) + ';border:1px solid ' + (viewer ? '#d3d8de;background:#fff' : '#9cc4f0;background:#dcebfc;color:#155bb5'),
      tokenLabel: viewer ? 'View only' : 'Editing on',
      tokenPopStyle: 'position:absolute;right:0;top:40px;width:320px;background:#fff;border:1px solid #d3d8de;border-radius:10px;padding:13px 14px;box-shadow:0 10px 34px rgba(20,24,28,.16);z-index:40;display:' + (s.tokenPop ? 'block' : 'none'),
      tokenDraft: s.tokenDraft,
      tokenType: (e) => this.setState({ tokenDraft: e.target.value }),
      tokenSave: stop(() => {
        const value = s.tokenDraft.trim();
        if (!value) { this.toast('Paste the token first'); return; }
        writeToken(PAGE.pid, value);
        this.setState({ token: value, tokenPop: false, tokenDraft: '' });
        this.toast('Editing is on for this project in this browser');
      }),
      tokenClear: stop(() => {
        clearToken(PAGE.pid);
        this.setState({ token: null, tokenPop: false, tokenDraft: '',
                        composer: null, notePop: null });
        this.set({ tool: null });
        this.toast('Token removed — back to viewing');
      }),

      railToggle: stop(() => this.setState({ rail: !railOpen })),
      railBtnStyle: btn(false) + ';border:1px solid #d3d8de;background:#fff' + (viewer ? ';display:none' : ''),
      railCountStyle: 'min-width:17px;height:17px;padding:0 5px;border-radius:9px;background:' + (openCount ? '#1f7ae0' : '#c3c8cf') + `;color:#fff;display:flex;align-items:center;justify-content:center;font:600 10px ${MONO}`,
      openCount,
      railStyle: 'width:300px;flex:none;background:#f7f8fa;border-left:1px solid #d8dce1;display:' + (railOpen && !viewer ? 'flex' : 'none') + ';flex-direction:column;min-height:0',
      threads,

      // Views come from the model's code: as many tabs as it declares.
      viewTabs: ((meta && meta.variants) || []).map((v) => ({
        key: v.id,
        label: v.name,
        hint: `${v.parts} parts · ${mb(v.gzip)}`,
        style: tab(s.view === v.id),
        onClick: () => this.showView(v.id),
      })),
      tMeasure: setTool('measure'), measureBtnStyle: btn(s.tool === 'measure'),
      tMove: setTool('move'), moveBtnStyle: btn(s.tool === 'move', viewer),
      tComment: setTool('comment'), commentBtnStyle: btn(s.tool === 'comment', viewer),
      fitView: () => this.fitView(),
      grabFrame: () => this.saveFrame(),

      // The canvas theme, in the strip that belongs to the viewport rather than
      // in a menu about something else — it changes what is behind the model, so
      // it sits with the other things that do. The button names the mode the
      // reader is IN, the way the access button beside the token does; what it
      // switches to is in the tooltip.
      themeDark: s.theme === 'dark',
      themeLabel: s.theme === 'dark' ? 'Dark' : 'Light',
      themeTitle: s.theme === 'dark'
        ? 'the model sits on a dark canvas — click for light'
        : 'the model sits on a light canvas — click for dark',
      toggleTheme: () => this.applyTheme(s.theme === 'dark' ? 'light' : 'dark'),
      hintText: s.tool === 'comment' ? 'click the model to pin a task'
        : s.tool === 'measure' ? 'click a part, or two, to measure'
        : s.tool === 'move' ? 'drag a part · esc to stop'
        : s.tool === 'cut' ? 'click a face to place the section plane'
        : `drag — orbit · wheel — zoom · hold ${HOLD_KEY_LABEL} — section`,

      viewError: s.viewError || '',
      viewErrorStyle: 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:420px;padding:14px 16px;background:#fff;border:1px solid #e0bcbc;border-radius:9px;box-shadow:0 8px 28px rgba(20,24,28,.14);z-index:14;text-align:center;display:' + (s.viewError ? 'block' : 'none'),
      retryView: () => this.retryView(),

      notCompare: !s.compare, compare: s.compare,
      hasTree: !!tree,
      expandAll: () => this.setState({
        expanded: Object.fromEntries(Array.from(tree ? tree.nodes.values() : [])
          .filter((n) => n.isNode).map((n) => [n.id, true])) }),
      collapseAll: () => this.setState({ expanded: {} }),
      showAll: () => this.set({ hidden: [], ghost: [] }),
      rows,

      // The section is a ROW in the tree with its own eye, not a mode with a
      // panel: a panel in the page's column takes height from the canvas, so
      // every press and release of the hold key would resize the model.
      secRowStyle: 'flex:none;display:inline-flex;align-items:center;gap:7px;margin:0 0 3px;padding:4px 8px;border-radius:5px;border:1px solid ' + (cutOn ? '#9cc4f0;background:rgba(234,243,253,.92)' : 'transparent;background:rgba(255,255,255,.78)'),
      secEyeClick: stop(() => this.set({ secOn: !s.secOn })),
      secEyeOuter: eyeOuter(cutOn ? 'on' : 'off'), secEyeDot: eyeDot(cutOn ? 'on' : 'off'),
      secSub: s.held ? `held · ${HOLD_KEY_LABEL}` : secSub,
      openSecPop: stop(() => this.setState({ secPop: true })),
      closeSecPop: stop(() => this.setState({ secPop: false })),
      secPopStyle: 'position:absolute;left:278px;top:52px;width:270px;background:#fff;border:1px solid #d3d8de;border-radius:10px;padding:13px 14px;box-shadow:0 10px 34px rgba(20,24,28,.16);z-index:15;display:' + (s.secPop ? 'block' : 'none'),
      pickFace: stop(() => { this.set({ tool: 'cut', secPop: false }); this.toast('Click a face — the plane will sit on it'); }),
      pickFaceStyle: `padding:7px;text-align:center;border-radius:6px;font:600 11.5px ${MONO};cursor:pointer;` + (s.tool === 'cut' ? 'background:#dcebfc;color:#155bb5;border:1px solid #9cc4f0' : 'background:#1f7ae0;color:#fff;border:1px solid #1c67c2'),
      pickFaceText: s.tool === 'cut' ? 'now click a face on the model…' : (s.secFace ? 'pick another face' : 'pick a face to place the plane'),
      secOff: s.secOff, secMin: secRange[0], secMax: secRange[1],
      secStep: Math.max(0.1, Math.round((secRange[1] - secRange[0]) / 40) / 10),
      secOffLabel: `${s.secOff >= 0 ? '+' : ''}${s.secOff.toFixed(1)} mm`,
      setSecOff: (e) => this.set({ secOff: parseFloat(e.target.value), secOn: true }),
      flipSec: stop(() => this.set({ secFlip: !s.secFlip })),
      resetSec: stop(() => this.set({ secOn: false, secFace: null, secOff: 0, secFlip: false },
                                     { __resetCut: true })),
      // Local, and it stays local until the viewport takes a field for it: the
      // contract carries no `hatch`, and inventing one here would be a field
      // only one side has ever heard of.
      toggleHatch: stop(() => this.setState({ hatch: !s.hatch })),
      hatchBox: 'width:15px;height:15px;border-radius:4px;flex:none;display:flex;align-items:center;justify-content:center;font:600 10px monospace;' + (s.hatch ? 'background:#1f7ae0;color:#fff' : 'border:1px solid #c3c8cf;background:#fff;color:transparent'),
      hatchMark: s.hatch ? '✓' : '',

      noteBoxStyle: 'position:absolute;right:14px;top:14px;width:250px;padding:9px 11px;background:#fdf6e3;border:1px solid #eadfc0;border-radius:7px;box-shadow:0 4px 16px rgba(20,24,28,.1);z-index:11;display:' + (!s.compare && !viewer && this.selectedNote() ? 'block' : 'none'),
      noteName: this.selectedName(),
      noteText: this.selectedNote(),
      editNote: stop(() => this.setState({ notePop: this.selectedName(), noteDraft: this.selectedNote() })),

      cmpA: s.cmp[0] || '', cmpB: s.cmp[1] || '',
      exitCompare: stop(() => this.setState({ compare: false })),
      dsBothStyle: tab(s.diffShow === 'both') + ';flex:1;text-align:center;opacity:.5',
      dsAStyle: tab(false) + ';flex:1;text-align:center;opacity:.5',
      dsBStyle: tab(false) + ';flex:1;text-align:center;opacity:.5',

      // The new build is offered, never substituted: somebody may be halfway
      // through a section with half the tree hidden, and a model that changes by
      // itself reads as a breakage.
      bannerStyle: chip(!!s.pending && !s.bannerGone, '#fff', '#d3d8de', '#1c1f23') + ';padding:8px 8px 8px 14px',
      bannerId: s.pending ? shortId(s.pending.commit) : '',
      bannerSwitch: () => this.takePending(),
      bannerLater: () => this.dismissPending(),

      movedChipStyle: chip(!!s.moved, '#fdf0d8', '#f0dcae', '#6b5210'),
      movedText: s.moved ? `${s.moved.name} moved ${s.moved.mag} mm` : '',
      movedReset: () => this.set({ moved: null }, { __resetMove: true }),
      movedAttach: () => this.set({
        composer: {
          part: s.moved.name, partId: s.moved.id, p: null, text: '', photo: null,
          meas: s.measure ? s.measure.full : null,
          move: `${s.moved.name} by ${s.moved.mag} mm`,
        },
        tool: null,
      }),
      measChipStyle: chip(!!s.measure && !s.composer, '#fff', '#d3d8de', '#1c1f23'),
      measText: s.measure ? s.measure.text : '',
      measNote: s.measure ? s.measure.note : '',
      // Measuring is open to everyone, so the CHIP stays; filing a comment is
      // not, so the link goes — the same gate the move tool, the comment tool,
      // the note box and the composer carry. Without it the link opens a
      // composer that `composerStyle` keeps at `display:none`: nothing appears,
      // the chip goes grey because it hides itself while a composer stands, and
      // there is no close button on screen to take it back. The composer then
      // opens with that stale measurement in it the moment a token is entered.
      measAddStyle: 'cursor:pointer;text-decoration:underline'
        + (viewer ? ';display:none' : ''),
      measAdd: () => {
        const node = this.node(s.sel);
        this.set({
          composer: {
            part: node ? node.name : (s.selName || 'model'),
            partId: s.sel || null,
            p: null, text: '', photo: null, meas: s.measure.full,
          },
          tool: null,
        });
      },
      measClear: () => this.set({ measure: null }, { __clearMeasure: true }),

      composerStyle: 'position:absolute;right:16px;bottom:16px;width:400px;background:#fff;border:1px solid #d3d8de;border-radius:10px;box-shadow:0 12px 40px rgba(20,24,28,.2);z-index:16;display:' + (s.composer && !viewer ? 'block' : 'none'),
      nextLabel: String(s.comments.length + 1),
      composerPart: s.composer ? s.composer.part : '',
      composerText: s.composer ? s.composer.text : '',
      compType: (e) => this.setState({ composer: { ...s.composer, text: e.target.value } }),
      compMeasChipStyle: 'display:' + (s.composer && s.composer.meas ? 'flex' : 'none') + `;align-items:center;gap:5px;padding:4px 8px;background:#fdf0d8;border-radius:5px;font:500 10.5px ${MONO};color:#8a6a1f`,
      compMeasText: (s.composer && s.composer.meas) || '',
      compMeasRemove: stop(() => this.setState({ composer: { ...s.composer, meas: null } })),
      compMoveChipStyle: 'display:' + (s.composer && s.composer.move ? 'flex' : 'none') + `;align-items:center;gap:5px;padding:4px 8px;background:#fdf0d8;border-radius:5px;font:500 10.5px ${MONO};color:#8a6a1f`,
      compMoveText: (s.composer && s.composer.move) || '',
      compPhotoName: s.composer && s.composer.photo ? s.composer.photo.name : '',
      compPhoto: (e) => {
        const file = e.target.files && e.target.files[0];
        this.setState({ composer: { ...s.composer, photo: file || null } });
      },
      compCancel: stop(() => this.set({ composer: null })),
      compSend: () => this.sendComment().catch((error) => {
        console.error('comment', error);
        this.toast('Could not send the comment');
      }),

      menuStyle: 'position:fixed;width:230px;background:#fff;border:1px solid #d3d8de;border-radius:9px;box-shadow:0 12px 40px rgba(20,24,28,.2);padding:2px 0 6px;z-index:60;display:' + (s.menu ? 'block' : 'none') + ';left:' + (s.menu ? s.menu.x : 0) + 'px;top:' + (s.menu ? s.menu.y : 0) + 'px',
      menuName: mName, menuItems,

      notePopStyle: 'position:absolute;left:310px;top:120px;width:300px;background:#fff;border:1px solid #d3d8de;border-radius:10px;padding:13px 14px;box-shadow:0 12px 40px rgba(20,24,28,.2);z-index:60;display:' + (s.notePop ? 'block' : 'none'),
      notePopName: s.notePop || '',
      noteDraft: s.noteDraft,
      noteType: (e) => this.setState({ noteDraft: e.target.value }),
      noteCancel: stop(() => this.setState({ notePop: null })),
      noteSave: stop(() => {
        const notes = { ...s.notes };
        if (s.noteDraft.trim()) notes[s.notePop] = s.noteDraft.trim();
        else delete notes[s.notePop];
        this.saveNotes(notes);
        this.setState({ notePop: null });
      }),

      toastStyle: `position:absolute;left:50%;bottom:18px;transform:translateX(-50%);padding:9px 16px;background:#1c1f23;color:#f2f3f5;border-radius:7px;font:500 12px ${SANS};box-shadow:0 6px 20px rgba(20,24,28,.3);z-index:70;display:` + (s.toast ? 'block' : 'none'),
      toastText: s.toast || '',
    };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ ...css(`position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#eceef1;color:#1c1f23;font:400 13px ${SANS};z-index:5`), ...FONTS }}>
          <div style={css('max-width:420px;padding:18px 20px;background:#fff;border:1px solid #d3d8de;border-radius:9px')}>
            <div style={css(`font:600 13px ${SANS};margin-bottom:6px`)}>This build did not load</div>
            <div style={css(`font:400 12px/1.6 ${MONO};color:#5b6470`)}>{this.state.error}</div>
          </div>
        </div>
      );
    }
    if (!this.state.meta) return null;

    const v = this.computed();

    return (
      // position:fixed, because this interface is the WHOLE page: build.html
      // carries nothing but the div this mounts into, so there is no page
      // layout to fit into and nothing underneath to leave visible.
      <div onClick={v.rootClick} style={{ ...css(`position:fixed;inset:0;display:flex;flex-direction:column;background:#eceef1;color:#1c1f23;font-family:${SANS};font-size:13px;overflow:hidden;z-index:5`), ...FONTS }}>
        <style>{PIN_CSS}</style>

        {/* ── header: model, revision, status, downloads, access, comments ── */}
        <div style={css('height:50px;flex:none;display:flex;align-items:center;gap:12px;padding:0 16px;background:#f7f8fa;border-bottom:1px solid #d8dce1;position:relative;z-index:30')}>
          <a href="/" title="all projects" style={css('display:flex;align-items:center;gap:8px;text-decoration:none;color:inherit')}>
            <svg width="18" height="18" viewBox="0 0 18 18">
              <path d="M9 1.5l6.5 3.75v7.5L9 16.5l-6.5-3.75v-7.5z" fill="none" stroke="#1c1f23" strokeWidth="1.6" />
              <path d="M9 1.5v7.5M9 9l6.5 3.75M9 9L2.5 12.75" fill="none" stroke="#1c1f23" strokeWidth="1.2" opacity=".55" />
            </svg>
            <span style={css(`font:700 14px ${SANS};letter-spacing:-.2px`)}>hammerola</span>
          </a>
          <div style={css('width:1px;height:22px;background:#d8dce1')} />
          <div style={css('display:flex;flex-direction:column;gap:1px;flex:none;min-width:0')}>
            <div style={css(`font:600 13.5px ${SANS};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`)}>{v.title}</div>
            <div style={css(`font:400 10.5px ${MONO};color:#787f87;white-space:nowrap`)}>{v.subtitle}</div>
          </div>

          <div style={css('position:relative;margin-left:8px;flex:none')}>
            <div onClick={v.revToggle} style={css(v.revBtnStyle)}>
              <span style={css(v.statusDotStyle)} />
              <span style={css(`font:600 12px ${MONO}`)}>{v.slot}</span>
              <span style={css(`font:500 10.5px ${MONO};color:#fff;background:#5b6470;padding:2px 6px;border-radius:4px`)}>{v.slotBadge}</span>
              <span style={css(`font:400 11px ${MONO};color:#787f87`)}>{v.slotDate}</span>
              <span style={css('font-size:9px;color:#9aa1a9')}>&#9662;</span>
            </div>

            {/* pointers on top, the history below; the ticks pick two to compare */}
            <div style={css(v.revMenuStyle)}>
              <div style={css('max-height:308px;overflow:auto')}>
                {v.revRows.map((r) => (
                  <React.Fragment key={r.key}>
                    <div style={css(r.headStyle)}>{r.head}</div>
                    <div style={css(r.style)}>
                      <span onClick={r.onCmp} style={css(r.cmpStyle)}>{r.cmpMark}</span>
                      <span onClick={r.onPick} style={css('display:flex;align-items:center;gap:10px;flex:1;cursor:pointer;min-width:0')}>
                        <span style={css(r.idStyle)}>{r.id}</span>
                        <span style={css(r.badgeStyle)}>{r.badge}</span>
                        <span style={css('flex:1')} />
                        <span style={css(`font:400 11px ${MONO};color:#8a9099`)}>{r.date}</span>
                      </span>
                    </div>
                  </React.Fragment>
                ))}
                {v.revEmpty && (
                  <div style={css(`padding:12px 14px;font:400 11.5px ${SANS};color:#8a9099`)}>
                    This project has no other builds yet.
                  </div>
                )}
              </div>
              <div style={css('display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid #e3e6ea')}>
                <div onClick={v.startCompare} style={css(v.compareBtnStyle)}>Compare {v.cmpLabel}</div>
              </div>
            </div>
          </div>

          <div style={css(v.statusChipStyle)}>{v.statusText}</div>
          <div style={css('flex:1')} />

          {/* downloads: whole-build files, exactly the ones meta.json names */}
          <div style={css('position:relative')}>
            <div onClick={v.dlToggle} style={css(v.dlBtnStyle)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 1.5v9M4.5 7L8 10.5 11.5 7M2 13.5h12" /></svg>
              Downloads
            </div>
            <div style={css(v.dlMenuStyle)}>
              {v.downloads.map((d) => (
                <a key={d.key} href={d.href} download
                   style={css(`display:flex;align-items:center;gap:10px;padding:7px 14px;text-decoration:none;color:#2a2e33;font:400 12px ${SANS}`)}>
                  <span style={css('flex:1')}>{d.label}</span>
                  <span style={css(`font:400 10.5px ${MONO};color:#b0b6bd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px`)}>{d.file}</span>
                </a>
              ))}
              {v.downloads.length === 0 && (
                <div style={css(`padding:10px 14px;font:400 11.5px ${SANS};color:#8a9099`)}>
                  This build ships no files to download.
                </div>
              )}
            </div>
          </div>

          {/* access: the token is what turns a viewer into the customer */}
          <div style={css('position:relative')}>
            <div onClick={v.tokenToggle} style={css(v.tokenBtnStyle)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2.5" y="7" width="11" height="7" rx="1.5" /><path d="M5 7V4.8a3 3 0 0 1 6 0V7" /></svg>
              {v.tokenLabel}
            </div>
            <div onClick={(e) => e.stopPropagation()} style={css(v.tokenPopStyle)}>
              <div style={css(`font:600 12.5px ${SANS};margin-bottom:4px`)}>
                {v.viewer ? 'Enter your token' : 'Editing is on'}
              </div>
              <div style={css(`font:400 11.5px/1.6 ${SANS};color:#5b6470;margin-bottom:9px`)}>
                {v.viewer
                  ? 'A token opens notes, moving a part and comments. Without one everything else still works: orbiting, the tree, the section, measuring and the downloads. It is kept in this browser, for this project only.'
                  : 'The token is stored in this browser for this project. Remove it to go back to viewing.'}
              </div>
              {v.viewer ? (
                <>
                  <input type="password" value={v.tokenDraft} onChange={v.tokenType}
                         placeholder="paste the token"
                         style={css(`width:100%;box-sizing:border-box;border:1px solid #d3d8de;border-radius:6px;outline:none;padding:8px 10px;font:400 12px ${MONO};background:#fff`)} />
                  <div style={css('display:flex;justify-content:flex-end;margin-top:9px')}>
                    <span onClick={v.tokenSave} style={css(`padding:6px 14px;background:#1f7ae0;color:#fff;border-radius:6px;font:600 11.5px ${SANS};cursor:pointer`)}>Save</span>
                  </div>
                </>
              ) : (
                <div style={css('display:flex;justify-content:flex-end')}>
                  <span onClick={v.tokenClear} style={css(`padding:6px 14px;border:1px solid #d3d8de;border-radius:6px;font:600 11.5px ${SANS};cursor:pointer;color:#b03a2e;background:#fff`)}>Remove token</span>
                </div>
              )}
            </div>
          </div>

          <div onClick={v.railToggle} style={css(v.railBtnStyle)}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 2.5h12v8.5H8.5L5.5 14v-3H2z" /></svg>
            Comments
            <span style={css(v.railCountStyle)}>{v.openCount}</span>
          </div>
        </div>

        <div style={css('flex:1;display:flex;min-height:0;position:relative')}>

          {/* ── the tree, floating over the model ── */}
          <div style={css('position:absolute;left:12px;top:10px;max-height:calc(100% - 20px);display:flex;flex-direction:column;align-items:flex-start;overflow:auto;z-index:10')}>
            {v.notCompare && (
              <div style={css('display:flex;flex-direction:column;min-height:0')}>
                <div style={css('flex:none;display:flex;align-items:center;gap:2px;padding:0 0 3px')}>
                  <span onClick={v.expandAll} title="expand all" style={css('width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:4px;color:#5b6470;cursor:pointer;background:rgba(255,255,255,.78)')}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 5.5L8 1.5l4 4M4 10.5l4 4 4-4" /></svg>
                  </span>
                  <span onClick={v.collapseAll} title="collapse all" style={css('width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:4px;color:#5b6470;cursor:pointer;background:rgba(255,255,255,.78)')}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 1.5l4 4 4-4M4 14.5l4-4 4 4" /></svg>
                  </span>
                  <span onClick={v.showAll} title="show all parts" style={css('width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:4px;color:#5b6470;cursor:pointer;background:rgba(255,255,255,.78)')}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><ellipse cx="8" cy="8" rx="6.5" ry="4.5" /><circle cx="8" cy="8" r="1.8" /></svg>
                  </span>
                </div>

                <div style={css(v.secRowStyle)}>
                  <div onClick={v.secEyeClick} style={css('width:24px;display:flex;justify-content:center;cursor:pointer;padding:2px 0')}>
                    <span style={css(v.secEyeOuter)}><span style={css(v.secEyeDot)} /></span>
                  </div>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#5b6470" strokeWidth="1.4" style={{ flex: 'none' }}><rect x="2" y="2" width="12" height="12" rx="1" /><path d="M2 14L14 2" /></svg>
                  <span onClick={v.openSecPop} style={css(`font:600 12px ${MONO};color:#2a2e33;cursor:pointer;white-space:nowrap`)}>section</span>
                  <span onClick={v.openSecPop} style={css(`font:400 10.5px ${MONO};color:#8a9099;cursor:pointer;white-space:nowrap;padding-right:2px`)}>{v.secSub}</span>
                </div>

                <div style={css('padding:1px 0 6px;display:flex;flex-direction:column;align-items:flex-start')}>
                  {v.rows.map((row) => (
                    <div key={row.key} onContextMenu={row.onMenu} style={css(row.rowStyle)}>
                      <span onClick={row.onExpand} style={css(row.caretStyle)}>{row.caret}</span>
                      <span onClick={row.onVis} title="show / hide" style={css('width:24px;display:flex;justify-content:center;cursor:pointer;flex:none')}>
                        <span style={css(row.eyeOuter)}><span style={css(row.eyeDot)} /></span>
                      </span>
                      <span onClick={row.onGhost} title="translucent" style={css('width:22px;display:flex;justify-content:center;cursor:pointer;flex:none')}>
                        <span style={css(row.ghostIcon)} />
                      </span>
                      <span style={css(row.dotStyle)} />
                      <span onClick={row.onSelect} style={css(row.nameStyle)}>{row.name}</span>
                      <span title={row.metaTitle} style={css(row.metaStyle)}>{row.meta}</span>
                    </div>
                  ))}
                  {/* Not an empty tree — a tree that has not arrived. It comes up
                      on `hmr:model`, i.e. once the viewport has fetched and drawn
                      a view, so this is also what a page with no adapter shows. */}
                  {!v.hasTree && (
                    <div style={css(`padding:6px 8px;border-radius:4px;background:rgba(255,255,255,.78);font:400 11.5px ${SANS};color:#8a9099`)}>
                      waiting for the model&hellip;
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── comparing two revisions ── */}
            {v.compare && (
              <div style={css('display:flex;flex-direction:column;min-height:0;width:288px;background:rgba(249,250,252,.95);border:1px solid #d3d8de;border-radius:10px;box-shadow:0 6px 24px rgba(20,24,28,.12);overflow:hidden')}>
                <div style={css('flex:none;padding:12px 14px;border-bottom:1px solid #e3e6ea')}>
                  <div style={css('display:flex;align-items:center;gap:8px')}>
                    <span style={css(`font:600 12.5px ${SANS}`)}>Comparing</span>
                    <span style={css(`font:600 12px ${MONO};background:#e3e6ea;padding:2px 7px;border-radius:4px`)}>{v.cmpA}</span>
                    <span style={css('color:#8a9099')}>&#8594;</span>
                    <span style={css(`font:600 12px ${MONO};background:#e3e6ea;padding:2px 7px;border-radius:4px`)}>{v.cmpB}</span>
                    <span style={css('flex:1')} />
                    <span onClick={v.exitCompare} style={css(`font:500 11px ${MONO};color:#1f6fd0;cursor:pointer`)}>exit &#10005;</span>
                  </div>
                  <div style={css('display:flex;gap:2px;padding:3px;background:#e3e6ea;border-radius:7px;margin-top:10px')}>
                    <div style={css(v.dsBothStyle)}>Overlay</div>
                    <div style={css(v.dsAStyle)}>{v.cmpA} only</div>
                    <div style={css(v.dsBStyle)}>{v.cmpB} only</div>
                  </div>
                </div>
                {/* No source, and saying so beats an empty list that reads as
                    "nothing changed" — which is itself one of the answers this
                    block has to be able to give. */}
                <div style={css('flex:1;overflow:auto;padding:12px 14px')}>
                  <div style={css(`font:600 11.5px ${SANS};margin-bottom:6px`)}>Not available yet</div>
                  <div style={css(`font:400 11.5px/1.6 ${SANS};color:#5b6470`)}>
                    The hub cannot compare two builds yet — there is no endpoint that
                    returns the difference, so nothing can be listed here and nothing
                    can be lit up on the model. This panel is the shape it will take.
                  </div>
                </div>
                <div style={css('flex:none;margin:0 14px 14px;padding:10px 12px;background:#fff;border:1px solid #e3e6ea;border-radius:7px')}>
                  <div style={css(`font:600 10px ${MONO};color:#8a9099;letter-spacing:.08em;margin-bottom:7px`)}>LEGEND &mdash; WHAT THE COLOURS WILL MEAN</div>
                  <div style={css('display:flex;align-items:center;gap:8px;margin-bottom:5px')}><span style={css('width:12px;height:12px;border-radius:3px;background:#1f7ae0;flex:none')} /><span style={css(`font:400 11.5px ${SANS}`)}>added &mdash; material only in {v.cmpB}</span></div>
                  <div style={css('display:flex;align-items:center;gap:8px;margin-bottom:5px')}><span style={css('width:12px;height:12px;border-radius:3px;background:#e08a1f;flex:none')} /><span style={css(`font:400 11.5px ${SANS}`)}>removed &mdash; material only in {v.cmpA}</span></div>
                  <div style={css('display:flex;align-items:center;gap:8px')}><span style={css('width:12px;height:12px;border-radius:3px;background:#b8bec6;flex:none')} /><span style={css(`font:400 11.5px ${SANS}`)}>unchanged (ghosted)</span></div>
                </div>
              </div>
            )}
          </div>

          {/* ── the model, and everything laid over it ── */}
          <div style={css('flex:1;position:relative;min-width:0;background:linear-gradient(165deg,#f2f4f6 0%,#e2e5e9 60%,#d4d8dd 100%)')}>
            {/* The custom element the adapter registers. RENDERED BY NAME rather
                than by a reference to the class, and that is the point: what
                defines the tag is `import './viewport/index.js'` in main.jsx,
                where evaluating the module IS the registration. Naming the class
                here would pull `customElements.define` into the import graph of
                a component that only wanted to draw a box. */}
            {React.createElement(VIEWPORT_TAG, {
              ref: this.host,
              style: { position: 'absolute', inset: 0, width: '100%', height: '100%' },
            })}

            {/* views and tools */}
            <div style={css('position:absolute;left:0;right:0;bottom:12px;display:flex;justify-content:center;pointer-events:none;z-index:12')}>
              <div style={css('pointer-events:auto;display:flex;align-items:center;gap:8px;padding:4px;background:rgba(249,250,252,.92);backdrop-filter:blur(10px);border:1px solid #d3d8de;border-radius:9px;box-shadow:0 4px 16px rgba(20,24,28,.1)')}>
                <div style={css('display:flex;gap:2px;padding:2px;background:#e3e6ea;border-radius:6px')}>
                  {v.viewTabs.map((t) => (
                    <div key={t.key} onClick={t.onClick} title={t.hint} style={css(t.style)}>{t.label}</div>
                  ))}
                </div>
                <div style={css('width:1px;height:18px;background:#d8dce1')} />
                <div onClick={v.tMeasure} style={css(v.measureBtnStyle)}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 14L14 2M2 14l2.2-.55M14 2l-.55 2.2M6.2 9.8l1.4 1.4M9 7l1.4 1.4" /></svg>
                  Measure
                </div>
                <div onClick={v.tMove} style={css(v.moveBtnStyle)}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M8 1.5v13M1.5 8h13M8 1.5L6.2 3.3M8 1.5l1.8 1.8M8 14.5l-1.8-1.8M8 14.5l1.8-1.8M1.5 8l1.8-1.8M1.5 8l1.8 1.8M14.5 8l-1.8-1.8M14.5 8l-1.8 1.8" /></svg>
                  Move part
                </div>
                <div onClick={v.tComment} style={css(v.commentBtnStyle)}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 2.5h12v8.5H8.5L5.5 14v-3H2z" /><path d="M5 5.5h6M5 8h4" /></svg>
                  Comment
                </div>
                <div style={css('width:1px;height:18px;background:#d8dce1')} />
                <div onClick={v.fitView} title="back to the frame this view opened in" style={css(`display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:6px;font:500 12px ${SANS};color:#3c4147;cursor:pointer;border:1px solid transparent`)}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5" /></svg>
                  Fit
                </div>
                <div onClick={v.grabFrame} title="save the current frame as a PNG" style={css(`display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:6px;font:500 12px ${SANS};color:#3c4147;cursor:pointer;border:1px solid transparent`)}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1.5" y="4" width="13" height="9.5" rx="1.5" /><circle cx="8" cy="8.7" r="2.6" /></svg>
                  Frame
                </div>
                <div style={css('width:1px;height:18px;background:#d8dce1')} />
                {/* what the model stands on — the canvas only, never the chrome */}
                <div onClick={v.toggleTheme} title={v.themeTitle} style={css(`display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:6px;font:500 12px ${SANS};color:#3c4147;cursor:pointer;border:1px solid transparent`)}>
                  {v.themeDark ? (
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M13.4 9.9A5.9 5.9 0 0 1 6.1 2.6 5.9 5.9 0 1 0 13.4 9.9z" /></svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="3.1" /><path d="M8 1.2v1.7M8 13.1v1.7M1.2 8h1.7M13.1 8h1.7M3.2 3.2l1.2 1.2M11.6 11.6l1.2 1.2M12.8 3.2l-1.2 1.2M4.4 11.6l-1.2 1.2" /></svg>
                  )}
                  {v.themeLabel}
                </div>
              </div>
            </div>

            {/* a newer build landed — offered, not substituted */}
            <div style={css('position:absolute;left:0;right:0;top:14px;display:flex;justify-content:center;pointer-events:none;z-index:13')}>
              <div style={css(v.bannerStyle)}>
                <span style={css('width:8px;height:8px;border-radius:4px;background:#2e9e44;flex:none')} />
                <span style={css(`font:500 12.5px ${SANS}`)}>
                  Build <b style={{ fontFamily: MONO }}>{v.bannerId}</b> is ready &mdash; you are viewing {v.slot}
                </span>
                <span onClick={v.bannerSwitch} style={css(`padding:5px 12px;background:#1f7ae0;color:#fff;border-radius:5px;font:600 12px ${SANS};cursor:pointer`)}>Switch</span>
                <span onClick={v.bannerLater} style={css(`padding:5px 10px;color:#5b6470;border-radius:5px;font:500 12px ${SANS};cursor:pointer`)}>Later</span>
              </div>
            </div>

            {/* state chips: a moved part, a live measurement */}
            <div style={css('position:absolute;left:278px;top:14px;display:flex;flex-direction:column;gap:8px;align-items:flex-start;pointer-events:none;z-index:13')}>
              <div style={css(v.movedChipStyle)}>
                <span style={css('width:7px;height:7px;border-radius:4px;background:#b8710d;flex:none')} />
                {v.movedText} &mdash; temporary, not saved to the model
                <span onClick={v.movedAttach} style={css('cursor:pointer;text-decoration:underline;margin-left:2px')}>attach to comment</span>
                <span onClick={v.movedReset} style={css('cursor:pointer;text-decoration:underline')}>reset</span>
              </div>
              <div style={css(v.measChipStyle)}>
                <span style={css(`font:600 12px ${MONO}`)}>{v.measText}</span>
                {/* The qualifier the brief insists on: a distance taken between
                    parts that have been laid apart is not the assembled one. */}
                {v.measNote && <span style={css(`font:500 10.5px ${MONO};color:#8a6a1f;background:#fdf0d8;padding:3px 7px;border-radius:4px`)}>{v.measNote}</span>}
                <span onClick={v.measAdd} style={css(v.measAddStyle)}>add to comment</span>
                <span onClick={v.measClear} style={css('cursor:pointer;opacity:.6')}>&#10005;</span>
              </div>
            </div>

            {/* the selected part's note */}
            <div style={css(v.noteBoxStyle)}>
              <div style={css(`display:flex;align-items:center;gap:6px;font:600 10px ${MONO};color:#8a6a1f;letter-spacing:.06em`)}>
                NOTE &middot; {v.noteName}
                <span style={css('flex:1')} />
                <span onClick={v.editNote} style={css('cursor:pointer;color:#8a9099;font-weight:400;text-transform:lowercase')}>edit</span>
              </div>
              <div style={css(`font:400 11.5px/1.5 ${SANS};color:#4a4436;margin-top:4px`)}>{v.noteText}</div>
            </div>

            {/* the viewport could not draw this view — block 11. The button is
                the only way back: the viewport remembers a failed load so an
                ordinary click cannot re-fetch it, and nothing else on this page
                clears that memory. */}
            <div style={css(v.viewErrorStyle)}>
              <div style={css(`font:600 12.5px ${SANS};margin-bottom:5px`)}>This view did not render</div>
              <div style={css(`font:400 11.5px/1.6 ${MONO};color:#5b6470`)}>{v.viewError}</div>
              <div onClick={v.retryView} style={css(`display:inline-block;margin-top:11px;padding:6px 14px;background:#1f7ae0;color:#fff;border-radius:6px;font:600 11.5px ${SANS};cursor:pointer`)}>Try again</div>
            </div>

            {/* The bottom-left corner is the VIEWPORT'S: it draws the view cube
                there (ui/src/viewport/viewcube.js). A static axis triad used to
                be drawn here instead, and it never turned with the camera — see
                SPEC §8, entries 23 and 24. */}

            <div style={css(`position:absolute;right:14px;bottom:12px;font:400 10.5px ${MONO};color:#9aa1a9;pointer-events:none`)}>{v.hintText}</div>

            {/* the composer: the frame rides along by itself, the photo does not */}
            <div onClick={(e) => e.stopPropagation()} style={css(v.composerStyle)}>
              <div style={css('display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #e3e6ea')}>
                <span style={css(`width:20px;height:20px;border-radius:10px 10px 10px 3px;background:#1f7ae0;color:#fff;display:flex;align-items:center;justify-content:center;font:600 10.5px ${MONO}`)}>{v.nextLabel}</span>
                <span style={css(`font:600 12px ${SANS}`)}>Task for the agent</span>
                <span style={css(`font:400 11px ${MONO};color:#8a9099`)}>&middot; {v.composerPart}</span>
                <span style={css('flex:1')} />
                <span onClick={v.compCancel} style={css('color:#9aa1a9;cursor:pointer')}>&#10005;</span>
              </div>
              <textarea
                value={v.composerText}
                onChange={v.compType}
                maxLength={MAX_COMMENT_CHARS}
                placeholder="e.g. gap here is 2.4 — make it 3"
                style={css(`width:100%;box-sizing:border-box;border:none;outline:none;resize:none;padding:10px 12px;font:400 12.5px/1.5 ${SANS};color:#1c1f23;height:64px;background:transparent`)}
              />
              <div style={css('display:flex;align-items:center;gap:6px;padding:0 12px 10px;flex-wrap:wrap')}>
                <span style={css(`display:flex;align-items:center;gap:5px;padding:4px 8px;background:#eef1f4;border-radius:5px;font:400 10.5px ${MONO};color:#5b6470`)}>
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1.5" y="4" width="13" height="9.5" rx="1.5" /><circle cx="8" cy="8.7" r="2.6" /></svg>
                  camera frame &mdash; attached automatically
                </span>
                <span style={css(v.compMeasChipStyle)}>&#8596; {v.compMeasText} <span onClick={v.compMeasRemove} style={css('cursor:pointer;opacity:.6')}>&#10005;</span></span>
                <span style={css(v.compMoveChipStyle)}>&#10021; {v.compMoveText}</span>
                <label style={css(`padding:4px 8px;border:1px dashed #c3c8cf;border-radius:5px;font:400 10.5px ${MONO};color:#8a9099;cursor:pointer`)}>
                  {v.compPhotoName ? `photo: ${v.compPhotoName}` : '+ photo of the print'}
                  <input type="file" accept="image/jpeg,image/png,image/webp"
                         onChange={v.compPhoto} style={{ display: 'none' }} />
                </label>
                <span style={css('flex:1')} />
                <span onClick={v.compSend} style={css(`padding:6px 14px;background:#1f7ae0;color:#fff;border-radius:6px;font:600 12px ${SANS};cursor:pointer`)}>Send</span>
              </div>
            </div>

            {/* the section plane */}
            <div onClick={(e) => e.stopPropagation()} style={css(v.secPopStyle)}>
              <div style={css('display:flex;align-items:center;gap:8px;margin-bottom:10px')}>
                <span style={css(`font:600 12.5px ${SANS}`)}>Section plane</span>
                <span style={css('flex:1')} />
                <span onClick={v.closeSecPop} style={css('color:#9aa1a9;cursor:pointer')}>&#10005;</span>
              </div>
              <div onClick={v.pickFace} style={css(v.pickFaceStyle)}>{v.pickFaceText}</div>
              <div style={css(`display:flex;justify-content:space-between;font:500 11px ${MONO};color:#5b6470;margin:12px 0 5px`)}>
                <span>offset</span><span style={css('color:#1c1f23')}>{v.secOffLabel}</span>
              </div>
              {/* The range is the viewport's: it comes back on `hmr:face` from the
                  model's own extent, so a 400 mm part and a 4 mm one both get a
                  slider that spans them. */}
              <input type="range" min={v.secMin} max={v.secMax} step={v.secStep}
                     value={v.secOff} onChange={v.setSecOff} style={{ width: '100%' }} />
              <div style={css('display:flex;gap:6px;margin-top:10px')}>
                <div onClick={v.flipSec} style={css(`flex:1;padding:6px;text-align:center;border:1px solid #d3d8de;border-radius:5px;font:500 11px ${MONO};color:#3c4147;cursor:pointer;background:#fff`)}>flip side</div>
                <div onClick={v.resetSec} style={css(`flex:1;padding:6px;text-align:center;border:1px solid #d3d8de;border-radius:5px;font:500 11px ${MONO};color:#3c4147;cursor:pointer;background:#fff`)}>reset</div>
              </div>
              <div onClick={v.toggleHatch} style={css('display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:11px')}>
                <span style={css(v.hatchBox)}>{v.hatchMark}</span>
                <span style={css(`font:400 11.5px ${SANS};color:#3c4147`)}>hatch the cut face</span>
              </div>
            </div>

            <div style={css(v.toastStyle)}>{v.toastText}</div>
          </div>

          {/* ── the comment rail ── */}
          <div style={css(v.railStyle)}>
            <div style={css('flex:none;display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #e3e6ea')}>
              <span style={css(`font:600 12.5px ${SANS}`)}>Comments</span>
              <span style={css(`font:500 10.5px ${MONO};background:#e3e6ea;color:#5b6470;padding:2px 7px;border-radius:8px`)}>{v.openCount} sent here</span>
              <span style={css('flex:1')} />
              <span onClick={v.railToggle} style={css('color:#9aa1a9;cursor:pointer;font-size:14px')}>&#10005;</span>
            </div>
            {/* The feed has no source yet, and an empty list would read as "no
                comments on this build" — which is a different statement. */}
            <div style={css(`flex:none;margin:10px;padding:10px 12px;background:#fdf6e3;border:1px solid #eadfc0;border-radius:7px;font:400 11.5px/1.6 ${SANS};color:#4a4436`)}>
              The history of comments is not shown yet. Reading the queue is behind
              the agent&#8217;s own token, which is shared across every project and never
              travels to a browser; the page will get a key of its own. Until then
              this lists only what was sent from this session.
            </div>
            <div style={css('flex:1;overflow:auto;padding:0 10px 10px;display:flex;flex-direction:column;gap:10px')}>
              {v.threads.map((c) => (
                <div key={c.key} onClick={c.onOpen} style={css(c.style)}>
                  <div style={css('display:flex;align-items:center;gap:8px')}>
                    <span style={css(c.pinStyle)}>{c.label}</span>
                    <span style={css(`font:500 11.5px ${MONO};color:#2a2e33`)}>{c.part}</span>
                    <span style={css('flex:1')} />
                    <span style={css(`font:400 10.5px ${MONO};color:#9aa1a9`)}>{c.time}</span>
                  </div>
                  <div style={css(`font:400 12px/1.5 ${SANS};color:#2a2e33;margin:7px 0 8px`)}>{c.text}</div>
                  <div style={css(c.measStyle)}>&#8596; {c.meas}</div>
                  <div style={css('display:flex;align-items:center;gap:10px;margin-top:8px')}>
                    <span onClick={c.onResolve} style={css(`font:500 10.5px ${MONO};color:#8a9099;cursor:pointer`)}>mark processed</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── the tree row's context menu ── */}
          <div onClick={(e) => e.stopPropagation()} style={css(v.menuStyle)}>
            <div style={css(`padding:7px 14px 6px;font:600 10.5px ${MONO};color:#8a9099;border-bottom:1px solid #e3e6ea`)}>{v.menuName}</div>
            {/* A row that carries a file is an ANCHOR and not a div: the download
                is the browser's to do, exactly as in the header's menu, so the
                link is a real one and can be middle-clicked or saved as. */}
            {v.menuItems.map((m) => {
              const inner = (
                <>
                  <span style={css('flex:1')}>{m.label}</span>
                  <span style={css(`font:400 10.5px ${MONO};color:#b0b6bd`)}>{m.hint}</span>
                </>
              );
              return m.href
                ? <a key={m.key} href={m.href} download onClick={m.onClick} style={css(m.style)}>{inner}</a>
                : <div key={m.key} onClick={m.onClick} style={css(m.style)}>{inner}</div>;
            })}
          </div>

          {/* ── the note editor: bound to a part NAME, for the whole project ── */}
          <div onClick={(e) => e.stopPropagation()} style={css(v.notePopStyle)}>
            <div style={css(`font:600 12px ${SANS};margin-bottom:2px`)}>
              Note &middot; <span style={css(`font:500 11.5px ${MONO};color:#5b6470`)}>{v.notePopName}</span>
            </div>
            <textarea
              value={v.noteDraft}
              onChange={v.noteType}
              placeholder="e.g. thin wall here — do not touch"
              style={css(`width:100%;box-sizing:border-box;border:1px solid #d3d8de;border-radius:6px;outline:none;resize:none;padding:8px 10px;font:400 12px/1.5 ${SANS};height:64px;background:#fff`)}
            />
            <div style={css(`font:400 10.5px/1.5 ${MONO};color:#9aa1a9;margin-top:6px`)}>
              kept in this browser &mdash; the hub has no endpoint for notes yet
            </div>
            <div style={css('display:flex;gap:8px;justify-content:flex-end;margin-top:8px')}>
              <span onClick={v.noteCancel} style={css(`padding:6px 12px;border-radius:6px;font:500 11.5px ${SANS};color:#5b6470;cursor:pointer`)}>Cancel</span>
              <span onClick={v.noteSave} style={css(`padding:6px 14px;background:#1f7ae0;color:#fff;border-radius:6px;font:600 11.5px ${SANS};cursor:pointer`)}>Save</span>
            </div>
          </div>

        </div>
      </div>
    );
  }
}
