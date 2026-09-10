/**
 * ============================================================================
 *  HammerolaEntry — the front page: sign in, and the list of projects
 * ============================================================================
 *
 * The designer's second mock-up (blocks 13 and "Что разделяет заказчика и
 * зрителя"), ported onto the hub's real index and the real secret. What changed
 * from the mock, and why, in one place so nobody has to diff it:
 *
 *   PROJECTS   -> GET /index.json, the file `Store._refresh_index` rewrites on
 *                 every publish. `hub.projectCard` is the whole mapping and says
 *                 which of the mock's fields the hub can answer.
 *   preview    -> the build's own picture (issue #34). Every build renders a
 *                 sheet for the view it assembles and declares it in meta.json,
 *                 so `index_card` puts the first view that has one on the card.
 *                 A build with no picture draws the mock's own neutral plate.
 *   status     -> the DRAFT's, and only that (issue #32). `/index.json` answers
 *                 `idle`/`building`/`failed` for the last build pushed AS A
 *                 DRAFT — not for the last build in the project's `dev` slot,
 *                 which a commit build fills too (issue #78) while deliberately
 *                 moving no pointer; the chip is drawn for the middle two and
 *                 for nothing else, because a pill on every card is a pill
 *                 nobody reads. A COMMIT build in flight stays invisible here on
 *                 purpose — see `projectCard` in hub.js.
 *   rev / hash -> one thing, not two: a revision is named by the digest of its
 *                 sources (SPEC 7.7), so there is no `v241` beside the hash.
 *   createdAt  -> the OLDEST build the hub still holds, labelled "first built"
 *                 rather than "created", because that is the claim the data
 *                 supports (render.index_card).
 *   login      -> the same secret and the same three storage functions the build
 *                 page uses (store.js), not a second mechanism. This screen is
 *                 another surface for `EDIT_TOKEN`, which is why it says that
 *                 name on the field: it is the string `hammerola login` asks for
 *                 on a terminal, and a person holding it should not have to
 *                 guess that the two are the same.
 *   onSubmit   -> answered by fetching the list with the token, which is what
 *                 makes the mock's `busy` and `error` props real rather than
 *                 decorative. There is no separate "check this token" call
 *                 because there is nothing to check separately: the list IS what
 *                 the token opens.
 *
 * THE TWO SCREENS ARE ONE DOOR, which is why the designer sent them in one file
 * and why they are in one here. No token, no list — and NOT a "view only" list
 * like the build page's. The two are genuinely different: a build is a permanent
 * link somebody was GIVEN and it is public, while this page is the enumeration
 * of everything on the hub, which nobody is given. `viewer()` has no meaning
 * here, and there is deliberately no state in which this component draws a card
 * without a secret.
 *
 * AND THE DOOR IS ON THE SERVER. `/index.json` answers 401 without the token
 * (src/app.py, `_serve_index_json`), so this component is not what makes the
 * list private — it is what makes the refusal legible. A page that merely
 * declined to DRAW cards it had already fetched would be decoration: the data
 * would be one devtools tab away, and the check would live on the wrong side of
 * the wire.
 *
 * AND ON A HUB WITH NOTHING ON IT THE DOOR CARRIES ONE MORE THING: five lines a
 * person copies and hands to their agent — where the skill is, where the client
 * is, what this hub's address is, install the skill and follow it, ask the owner
 * for the token. It is on the DOOR and not on the list, because the list is
 * behind the very token somebody opening an empty hub does not have yet: a block
 * living past the form would only ever be read by whoever no longer needs it.
 * `agentBrief` below is the whole of the text and `/start` (src/onboarding.py)
 * is where the paths come from; the two properties that make it safe to add to a
 * page whose job is elsewhere are that it is fetched LAZILY — a reader with a
 * token goes straight to the list and pays for no second request — and that
 * every failure of that fetch is silence. See `loadStart` in hub.js.
 *
 * A CARD IS AN `<a>`, not a div with a click handler, which is the one place the
 * mock's markup was not taken literally. The page it replaced used a real link
 * and the reasons hold: middle-click, copy-link-address and the status bar all
 * come from the element rather than from us. Where it points is a decision of
 * its own — `hub.projectUrl` explains it.
 *
 * STYLING is inline, carried over from the mock so the layout stays 1:1;
 * `css()` in style.jsx parses a CSS string into a React style object. The one
 * exception is the two rules in ENTRY_CSS below, which have nowhere inline to
 * live. Fonts are the system stacks and not the mock's webfont — style.jsx says
 * why, and tests/test_ui_source.py holds the line.
 */

import React from 'react';

import {
  hubOrigin, loadIndex, loadStart, projectCard, projectUrl, stamp, Unauthorized,
} from './hub.js';
import {
  PROJECT_SORTS, PROJECT_VIEWS, clearToken, readProjectSort, readProjectView,
  readToken, writeProjectSort, writeProjectView, writeToken,
} from './store.js';
import {
  css, FONTS, SANS, MONO, Mark, PAGE_BG, PAGE_FG, HEADER_BG, HEADER_LINE,
} from './style.jsx';

/**
 * The only two rules that cannot be inline styles.
 *
 * A `@keyframes` has no inline form at all, and `html`/`body` are elements above
 * anything React renders here. The page background is on both because this page
 * SCROLLS — unlike the build page, whose root is a fixed full-screen box — so
 * the document's own canvas shows through past the end of the list and, for a
 * moment, before the first render.
 *
 * Injected as a `<style>` element rather than an imported stylesheet: an
 * `import './x.css'` would make this build emit a second output file, and that
 * name would then have to be added to the Makefile, the Dockerfile, ci/smoke.py
 * and the page template — see ui/vite.config.mjs, which says so at length. The
 * page's CSP allows it: `style-src` carries 'unsafe-inline', `script-src` does
 * not (src/app.py, CSP_HTML).
 *
 * The keyframe is named `hmr_spin` rather than `spin` for the reason every class
 * this bundle writes carries the prefix: the name is global to the document, and
 * the document also holds a vendored stylesheet nobody here maintains.
 */
const ENTRY_CSS = `
html, body { margin: 0; background: ${PAGE_BG}; }
@keyframes hmr_spin { to { transform: rotate(360deg) } }
`;

/* ───────────────────────────────────────────────────────────────────────────
   The backdrop: icospheres whose mesh keeps refining and coarsening.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Icosphere levels: 0 is the icosahedron, each next one a subdivision.
 *
 * `parents[i] = [a, b]` is the edge vertex `i` is the midpoint of. A vertex is
 * BORN AT `min(a, b)`, and at that moment every edge of it is either zero-length
 * or lies exactly on an edge of the previous level. That is what makes the
 * transition geometric — one mesh unfolding — rather than a second shape fading
 * in over the first; opacity is left to say depth and nothing else.
 *
 * BUILT ON FIRST USE, not at module scope, and the laziness is the point rather
 * than tidiness: this is one bundle serving two pages, so a top-level `(() =>
 * {...})()` here would subdivide 1280 faces during the build page's first paint,
 * every time, for a backdrop that page never draws.
 */
let icoLevels = null;
function levels() {
  if (icoLevels) return icoLevels;
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
    [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map((v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; });
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4],
    [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const edgesOf = (fs) => {
    const set = new Set();
    fs.forEach((f) => {
      for (let i = 0; i < 3; i += 1) {
        const a = f[i];
        const b = f[(i + 1) % 3];
        set.add(a < b ? `${a},${b}` : `${b},${a}`);
      }
    });
    return Array.from(set).map((s) => s.split(',').map(Number));
  };
  const built = [{ verts, edges: edgesOf(faces), parents: {} }];
  for (let k = 0; k < 3; k += 1) {
    const mid = new Map();
    const parents = {};
    const nv = verts.slice();
    const nf = [];
    const getMid = (a, b) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (mid.has(key)) return mid.get(key);
      const va = verts[a];
      const vb = verts[b];
      const m = [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2];
      const l = Math.hypot(m[0], m[1], m[2]);
      const idx = nv.length;
      nv.push([m[0] / l, m[1] / l, m[2] / l]);
      parents[idx] = [a, b];
      mid.set(key, idx);
      return idx;
    };
    faces.forEach((f) => {
      const [a, b, c] = f;
      const ab = getMid(a, b);
      const bc = getMid(b, c);
      const ca = getMid(c, a);
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    });
    verts = nv;
    faces = nf;
    built.push({ verts, edges: edgesOf(faces), parents });
  }
  icoLevels = built;
  return icoLevels;
}

/** Where the shapes sit, as fractions of the frame, so the backdrop fits any size. */
const BACKDROP_SHAPES = [
  { cx: 0.80, cy: 0.30, r: 0.34, phase: 0, spin: 0.00016, tilt: 0.45 },
  { cx: 0.13, cy: 0.80, r: 0.26, phase: 7.5, spin: -0.00013, tilt: -0.3 },
  { cx: 0.30, cy: 0.10, r: 0.15, phase: 13, spin: 0.0002, tilt: 0.8 },
];

/**
 * The animated backdrop. Canvas 2D, no dependency, ~2k lines a frame.
 *
 * IT STOPS in all three ways it has to, and only one of them is code here:
 *
 *   * REDUCED MOTION — `prefers-reduced-motion: reduce` draws exactly one frame
 *     and never asks for another, so the shapes are there and still. Read once,
 *     at mount: a person who changes that setting mid-session gets it on the
 *     next page, which is the same bargain every other reduced-motion answer on
 *     this site makes.
 *   * UNMOUNT — the pending frame is cancelled. This matters here rather than
 *     being boilerplate, because this component really is unmounted while the
 *     page stays open: signing in swaps this screen for the list.
 *   * A HIDDEN TAB — nothing, deliberately. `requestAnimationFrame` callbacks
 *     are not run for a document that is not being rendered, so a backgrounded
 *     tab already costs nothing, and a `visibilitychange` listener beside it
 *     would be a second mechanism that cannot be observed to work.
 */
export class MeshBackdrop extends React.Component {
  static defaultProps = { shapes: BACKDROP_SHAPES, period: 54, color: '122,130,140' };

  componentDidMount() {
    const canvas = this.canvas;
    if (!canvas) return;
    const reduce = window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const smooth = (x) => x * x * (3 - 2 * x);
    const ico = levels();
    const TOP = ico.length - 1;

    const draw = (now) => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.lineJoin = 'round';

      this.props.shapes.forEach((sp) => {
        // How detailed, as a triangle wave 0..TOP..0 that dwells on whole levels.
        const u = ((now / 1000 + sp.phase) / this.props.period) % 1;
        const tt = TOP * (1 - Math.abs(2 * u - 1));
        const L = Math.min(Math.floor(tt), TOP - 1);
        const f = smooth(Math.min(Math.max(((tt - L) - 0.2) / 0.6, 0), 1));
        const lvl = ico[L + 1];

        const ry = now * sp.spin + sp.phase;
        const rx = sp.tilt + Math.sin(now / 9000 + sp.phase) * 0.15;
        const cy0 = Math.cos(ry);
        const sy0 = Math.sin(ry);
        const cx0 = Math.cos(rx);
        const sx0 = Math.sin(rx);
        const R = Math.min(w, h) * sp.r;
        const CX = sp.cx * w;
        const CY = sp.cy * h;
        const proj = (v) => {
          const x = v[0] * cy0 + v[2] * sy0;
          const z1 = -v[0] * sy0 + v[2] * cy0;
          const y = v[1] * cx0 - z1 * sx0;
          const z = v[1] * sx0 + z1 * cx0;
          return [CX + x * R, CY + y * R, z];
        };

        // The vertex split: a new vertex travels out of an existing one onto the
        // sphere, so nothing has to appear from nowhere.
        const p = lvl.verts.map((v, i) => {
          const par = lvl.parents[i];
          if (!par || f >= 1) return proj(v);
          const s = lvl.verts[Math.min(par[0], par[1])];
          return proj([s[0] + (v[0] - s[0]) * f,
            s[1] + (v[1] - s[1]) * f,
            s[2] + (v[2] - s[2]) * f]);
        });

        lvl.edges.forEach((e) => {
          const a = p[e[0]];
          const b = p[e[1]];
          // A collapsed edge, i.e. a vertex that has not left its parent yet.
          if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 0.7) return;
          const depth = (a[2] + b[2]) / 2; // -1 behind .. 1 in front
          ctx.strokeStyle = `rgba(${this.props.color},${(0.26 + 0.34 * (depth + 1) / 2).toFixed(3)})`;
          ctx.lineWidth = 0.6 + 0.4 * (depth + 1) / 2;
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
          ctx.stroke();
        });
      });

      if (!reduce) this.raf = requestAnimationFrame(draw);
    };
    this.raf = requestAnimationFrame(draw);
  }

  componentWillUnmount() {
    cancelAnimationFrame(this.raf);
  }

  render() {
    return (
      <canvas
        ref={(el) => { this.canvas = el; }}
        style={css('position:absolute;inset:0;width:100%;height:100%;pointer-events:none')}
      />
    );
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   The sign-in screen
   ────────────────────────────────────────────────────────────────────────── */

const DESCRIPTION = '3D models built from code. Every link is pinned to a revision '
  + 'and always shows the exact same geometry.';

/**
 * The block a hub with nothing on it offers, as the lines it is made of.
 *
 * IT IS ADDRESSED TO AN AGENT, not to the person copying it — imperative, no
 * greeting, no explanation of what this service is. That is the shape of the
 * requirement (issue #48) and it is also what makes it short: everything
 * about hammerola is already written in the skill, which is the first address
 * here, so a second account of it on this page would be a copy that goes stale
 * and a wall of text an agent has to read before it can get the real one.
 *
 * FIVE LINES, AND THE THIRD IS THE ONE THAT COULD ONLY BE WRITTEN HERE. The
 * skill carries no deployment's address on purpose (issue #47, and
 * `test_the_skill_names_no_deployment` holds it to that) — it says the hub is
 * whichever one you were given. This is where it is given, and it is a line of
 * its own rather than something to be cut out of the two above it because that
 * is how it is used: as the argument to `hammerola login`.
 *
 * NO TOKEN, AND NO FIELD FOR ONE. The secret travels another way, from a person
 * to a person; what stands here is the sentence that says so. A block that
 * carried it would be a credential in whatever the reader pasted it into.
 *
 * Everything addressable is BUILT from what the caller passes: `origin` is the
 * browser's own (`hubOrigin`), the two paths are the manifest's. Nothing in this
 * file names a host.
 *
 * `Client:` AND NOT `Helper:`, which is what the second line said first. This
 * repository has one word for that file and uses it everywhere — `hammerola/`,
 * "the client" in AGENTS.md and the SPEC, `hammerola` once it is on a PATH — and
 * a third name invented on this one page leaves the agent that reads the block
 * and then the skill working out that the two are the same thing.
 */
export function agentBrief({ origin, skill, client }) {
  return [
    `Skill: ${origin}${skill}`,
    `Client: ${origin}${client}`,
    `Hub: ${origin}`,
    'Install the skill and follow it.',
    'Ask the owner of this instance for the token.',
  ];
}

/**
 * What the copy button says once it knows, keyed by what happened.
 *
 * `none` is the case worth the table: `navigator.clipboard` is absent in an
 * insecure context, and a hub reached over plain http on a local network is
 * exactly that — a perfectly ordinary deployment of this service. The button
 * still answers, and what it must not do is say the text was copied when
 * nothing was: the person would paste whatever was in the buffer before.
 */
const COPY_LABELS = { done: 'Copied', failed: 'Copy failed', none: 'Copy by hand' };

/**
 * The door. Everything on the other side of it is one fetch away, and this
 * screen is what a refusal looks like.
 *
 * It has ONE state, unlike the control on the build page, and the asymmetry is
 * the design rather than an omission. There, a token can be removed while the
 * page keeps working, because a build is public and viewing it is the ordinary
 * case; the popover therefore has a signed-in half. Here, having a token the
 * hub accepts means being on the list instead — so the only thing this screen
 * can ever be showing is the absence of one, and a "signed in" half would be
 * unreachable code that still had to be maintained. Signing out lives where it
 * can be reached: the header of the list.
 */
export class HammerolaLogin extends React.Component {
  static defaultProps = {
    title: 'hammerola',
    description: DESCRIPTION,
    animate: true,
    busy: false,
    error: '',
    // `{origin, skill, client}` when this hub has nothing published on it, and
    // null every other time — including when the hub could not be asked. The
    // page above decides; this screen only draws what it was handed.
    start: null,
  };

  state = { token: '', hover: false, focus: false, copied: '' };

  /**
   * A verdict on the clipboard is about the text that was in it, so it does not
   * outlive that text.
   *
   * `Copied` under a block whose lines have since changed is a claim about a
   * clipboard holding something else; `Copy failed` under new lines reports a
   * failure that happened to different ones. Neither can be corrected by the
   * reader, because the button says nothing until it is pressed again.
   */
  componentDidUpdate(previous) {
    if (previous.start !== this.props.start && this.state.copied) {
      this.setState({ copied: '' });
    }
  }

  submit = () => {
    if (this.props.busy) return;
    if (this.props.onSubmit) this.props.onSubmit(this.state.token);
  };

  /**
   * The whole block into the clipboard, in one piece.
   *
   * The lines exist to be handed over together — three addresses and two
   * instructions are one message, and a person selecting them out of the box by
   * hand drops a character off an address about as often as not, which is the
   * reason this button exists at all.
   *
   * THE TEXT COMES FROM `agentBrief`, the same call the screen draws from, so
   * what is copied cannot differ from what is read.
   */
  copy = () => {
    const { start } = this.props;
    if (!start) return Promise.resolve();
    // The last verdict was about the press before this one. Clearing it first is
    // what keeps a retry from reading as its own result for however long the
    // clipboard takes to answer.
    if (this.state.copied) this.setState({ copied: '' });
    const clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      this.setState({ copied: 'none' });
      return Promise.resolve();
    }
    return clipboard.writeText(agentBrief(start).join('\n')).then(
      () => this.setState({ copied: 'done' }),
      // Rejected rather than absent: the document was not focused, or the
      // permission was refused. Same rule as the branch above — say what
      // happened, never "Copied".
      () => this.setState({ copied: 'failed' }),
    );
  };

  /**
   * The block, INSIDE the card and under a hairline, rather than a panel of its
   * own beside it.
   *
   * A reader arriving at an empty hub is being shown one thing with two halves —
   * sign in if this is yours, hand this over if you are setting it up — and a
   * second card would make them two screens competing for the middle of the
   * page. Same card, same fonts, same palette; the mono box is the interface's
   * own input colour, so it reads as text to be taken rather than as a warning.
   */
  drawStart(start) {
    return (
      <div style={css('width:100%;margin-top:24px;padding-top:18px;border-top:1px solid #e9ecef')}>
        <div style={css('display:flex;align-items:center;gap:8px')}>
          <span style={css(`font:600 11.5px ${SANS};color:#2a2e33`)}>Nothing published here yet</span>
          <span style={css('flex:1')} />
          <div
            onClick={this.copy}
            style={css('padding:4px 9px;border-radius:5px;cursor:pointer;user-select:none;'
              + `font:600 10.5px ${SANS};border:1px solid #d3d8de;background:#fff;color:#2a2e33`)}
          >
            {COPY_LABELS[this.state.copied] || 'Copy'}
          </div>
        </div>
        <div style={css(`font:400 11px/1.55 ${SANS};color:#8a9099;margin-top:5px`)}>
          Hand this to your agent.
        </div>
        <div style={css('margin-top:9px;padding:10px 11px;border-radius:6px;'
          + 'border:1px solid #d3d8de;background:#f7f8fa;display:flex;flex-direction:column;gap:3px')}
        >
          {agentBrief(start).map((line) => (
            <span key={line} style={css(`font:400 11px/1.55 ${MONO};color:#1c1f23;overflow-wrap:anywhere`)}>
              {line}
            </span>
          ))}
        </div>
      </div>
    );
  }

  render() {
    const { title, description, animate, busy, error, start } = this.props;
    const s = this.state;
    return (
      <div style={{
        ...css('width:100%;min-height:100vh;position:relative;overflow:hidden;'
          + `background:${PAGE_BG};font-family:${SANS};color:${PAGE_FG};`
          + 'display:flex;align-items:center;justify-content:center'),
        ...FONTS,
      }}
      >
        <style>{ENTRY_CSS}</style>
        {animate && <MeshBackdrop />}

        <div style={css('position:relative;width:360px;max-width:calc(100% - 32px);box-sizing:border-box;'
          + 'background:#fff;border:1px solid #d8dce1;border-radius:12px;'
          + 'box-shadow:0 14px 44px rgba(20,24,28,.10);padding:40px 36px 32px;'
          + 'display:flex;flex-direction:column;align-items:center')}
        >
          <Mark size={44} />
          <div style={css(`font:700 22px ${SANS};letter-spacing:-.3px;margin-top:14px`)}>{title}</div>
          <div style={css(`font:400 12.5px/1.55 ${SANS};color:#787f87;text-align:center;margin-top:8px;text-wrap:pretty`)}>
            {description}
          </div>

          <div style={css('width:100%;display:flex;flex-direction:column;gap:10px;margin-top:26px')}>
            <input
              type="password"
              placeholder="EDIT_TOKEN"
              value={s.token}
              autoComplete="off"
              onChange={(e) => this.setState({ token: e.target.value })}
              onFocus={() => this.setState({ focus: true })}
              onBlur={() => this.setState({ focus: false })}
              onKeyDown={(e) => { if (e.key === 'Enter') this.submit(); }}
              style={css(`width:100%;box-sizing:border-box;height:38px;padding:0 12px;border-radius:6px;font:500 13px ${MONO};color:#1c1f23;outline:none;`
                + (error ? 'border:1px solid #e2a8a0;background:#fdf5f4'
                  : s.focus ? 'border:1px solid #9cc4f0;background:#fff'
                    : 'border:1px solid #d3d8de;background:#f7f8fa'))}
            />
            <div style={css(error ? `font:400 11px ${SANS};color:#b03a2e;margin-top:-4px` : 'display:none')}>
              {error}
            </div>
            <div
              onClick={this.submit}
              onMouseEnter={() => this.setState({ hover: true })}
              onMouseLeave={() => this.setState({ hover: false })}
              style={css('display:flex;align-items:center;justify-content:center;gap:8px;height:38px;'
                + `border-radius:6px;color:#fff;font:600 13px ${SANS};cursor:pointer;background:`
                + (busy ? '#9cc0e8;cursor:default' : s.hover ? '#1a6bc7' : '#1f7ae0'))}
            >
              {busy && (
                <span style={css('width:11px;height:11px;border-radius:50%;'
                  + 'border:1.6px solid rgba(255,255,255,.55);border-top-color:transparent;'
                  + 'animation:hmr_spin .9s linear infinite')}
                />
              )}
              {busy ? 'Checking…' : 'Sign in'}
            </div>
            <div style={css(`font:400 11px/1.6 ${SANS};color:#8a9099;text-align:center`)}>
              The same token <span style={css(`font:500 11px ${MONO}`)}>hammerola login</span> asks
              for. Kept in this browser only. A build somebody linked you to
              opens without it; the list of what is here does not.
            </div>
          </div>

          {start && this.drawStart(start)}

          <div style={css(`font:400 11px ${MONO};color:#b0b6bd;margin-top:22px`)}>rev-pinned · agent-built</div>
        </div>
      </div>
    );
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   The project list (brief, block 13)
   ────────────────────────────────────────────────────────────────────────── */

const ts = (v) => (v instanceof Date ? v.getTime() : Date.parse(v) || 0);

/** `18 min ago` / `yesterday` / `Aug 12` — no dependency, no locale guess. */
export function relTime(v) {
  const t = ts(v);
  if (!t) return '—';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  if (mins < 48 * 60) return 'yesterday';
  if (mins < 7 * 24 * 60) return `${Math.round(mins / 1440)} days ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const monthYear = (v) => (ts(v)
  ? new Date(ts(v)).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  : '—');

/**
 * The preview plate, and the build's own picture over it when there is one.
 *
 * `src` is a sheet the build already rendered for one of its whole-view meshes
 * — which view it was of is not promised, see `render.index_card` — and it is
 * used AS IT IS (issue #34): the sheet is a square frame with a title band
 * above it and a two-line footer below, and `object-fit:cover` at card size
 * carries both bands off-frame by itself. No second artefact, and no cropping by
 * pixel arithmetic here — that would be this file holding an opinion about a
 * layout the build side owns.
 *
 * THE PLATE STAYS UNDERNEATH rather than being swapped out, which makes it two
 * answers for the price of one: it is what shows while the picture loads, and it
 * is what is left if the picture never arrives. `onError` hides the img — a
 * build whose file 404s falls back to the plate instead of the browser's
 * broken-image glyph — and it writes the style directly because this file uses
 * no hooks and this has to stay a function component.
 *
 * With no `src` the output is the plate and nothing else, exactly as it was
 * before any of this: a build made by an image with no rendering stack ships no
 * pictures, and the placeholder is drawn rather than left blank because a card
 * with a hole in it reads as a broken image, while this reads as "a model".
 */
const Preview = ({ radius, src }) => (
  <div style={css('position:absolute;inset:0;background:linear-gradient(160deg,#f4f5f7,#e2e5e9);'
    + `overflow:hidden;border-radius:${radius || 0}px`)}
  >
    <svg width="100%" height="100%" viewBox="0 0 120 80" preserveAspectRatio="xMidYMid slice" style={css('display:block')}>
      <g stroke="#c9ced4" strokeWidth=".7" fill="none">
        <path d="M60 22l22 13v22L60 70 38 57V35z" />
        <path d="M38 35l22 13 22-13M60 48v22" opacity=".7" />
      </g>
    </svg>
    {src && (
      <img
        src={src}
        alt=""
        onError={(e) => { e.currentTarget.style.display = 'none'; }}
        style={css('position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block')}
      />
    )}
  </div>
);

/**
 * What the newest build of this project is.
 *
 * One identifier and not the mock's two. A revision is named by the digest of
 * its sources, so the hash IS the revision and there is no number beside it; it
 * is cut to the same seven characters the rest of the site reads a commit at.
 * The `dev` chip says that the project's local slot holds work no commit has
 * published — never what that work is, which is the whole of SPEC 7.6 as it
 * applies to this page. It is deliberately not "the slot is occupied": a commit
 * fills the slot with itself (issue #78), so that would be every card.
 *
 * The STATUS chip beside it says what the draft's last build is DOING, and only
 * while there is something to say: a build in flight and a build that failed
 * (issue #32). `idle` gets no chip at all — a pill on every card is a pill
 * nobody reads — and neither does a card from a hub that answers no status,
 * which is what the table lookup buys over two comparisons.
 *
 * EXPORTED for the same reason the four tables below are: a chip lives inside a
 * component element, and `texts()` over a view body stops at that element rather
 * than descending into it — so a test reading the body's tree would pass whether
 * or not either chip was ever drawn. `entry.test.js` calls this directly.
 */
const STATUS_CHIPS = Object.freeze({
  building: {
    title: 'a build of this project\'s draft is running now',
    style: 'color:#8a5a00;background:#fdf1d8',
  },
  failed: {
    title: 'the last build of this project\'s draft failed',
    style: 'color:#a32020;background:#fbe6e6',
  },
});

export const RevLine = ({ p }) => {
  const status = STATUS_CHIPS[p.status];
  return (
    <React.Fragment>
      <span style={css(`font:600 12px ${MONO};color:#1f6fd0`)}>{p.rev}</span>
      {p.dev && (
        <span
          title="this project also has uncommitted work in its dev slot"
          style={css(`font:500 10px ${MONO};color:#7c3aad;background:#f3ebfa;padding:2px 6px;border-radius:4px`)}
        >
          dev
        </span>
      )}
      {status && (
        <span
          title={status.title}
          style={css(`font:500 10px ${MONO};${status.style};padding:2px 6px;border-radius:4px`)}
        >
          {p.status}
        </span>
      )}
    </React.Fragment>
  );
};

/**
 * EVERYTHING AN ARRANGEMENT'S ID REACHES, IN TABLES KEYED BY THAT ID.
 *
 * A sort is three things — a tab, a comparator, and a value store.js will keep
 * — and a view is three too: a tab, a body that draws the list, and the same
 * stored value. Two of the six used to be written as code rather than as a
 * table: the comparators lived in an object literal inside `sorted()`, and the
 * two bodies were `{grid && …}` / `{!grid && …}` in the middle of `render()`.
 * That is four sets of names that have to be the same set, and nothing made
 * them one.
 *
 * It is not a hypothetical. Adding a sort to store.js and to `SORT_LABELS`
 * without touching the comparator passes the whole suite and, in a browser,
 * hands `Array.prototype.sort` an `undefined` comparator: the list comes back in
 * whatever order it arrived in, the new tab is lit, and the choice is remembered
 * for ever. The negated-tiles branch was worse in a quieter way — it drew the
 * dense list for every id that was not the tile view, so an unknown view looked
 * like a working answer.
 *
 * The two views are named in prose here rather than quoted, and that is the
 * house rule rather than shyness: `tests/test_ui_source.py` forbids a view id
 * appearing anywhere in this file except its defaultProps, in any of the three
 * quote characters, precisely so that no branch on one can hide from the tables
 * — and a rule with an exception for comments is a rule that reads the same
 * text two ways.
 *
 * So each of the four is a table now and all four are EXPORTED, which is the
 * part that makes the check trustworthy: `ui/tests/vocabulary.test.js` imports
 * them and compares `Object.keys` against store.js's two lists. The first
 * version of that check read this file as text and matched braces and commas —
 * and it passed on the very defect it was written for, because a trailing `//`
 * comment holding a comma made the parser take the next word for a key. A set of
 * keys is a thing the language computes exactly; there is no reason to guess at
 * it from the source, and every reason not to.
 *
 * FROZEN, because exporting them made "who may add a key" a question at all.
 * The key sets are checked once, at import time, against store.js's two lists;
 * an importer writing a fifth entry afterwards would put the page in an
 * arrangement no check ever saw. Freezing costs nothing and answers it here.
 */
export const SORT_LABELS = Object.freeze({ name: 'Name', modified: 'Last built', first: 'First built' });

export const SORT_CMP = Object.freeze({
  // No locale argument: a title comes out of the model's own project.json and
  // can be in any language, and the reader's is not knowable here.
  name: (a, b) => String(a.title).localeCompare(String(b.title)),
  modified: (a, b) => ts(b.built) - ts(a.built),
  first: (a, b) => ts(b.first) - ts(a.first),
});

export const VIEW_ICONS = Object.freeze({
  grid: 'M1 1h4.5v4.5H1zM7.5 1H12v4.5H7.5zM1 7.5h4.5V12H1zM7.5 7.5H12V12H7.5z',
  list: 'M1 1.5h11v2H1zM1 5.5h11v2H1zM1 9.5h11v2H1z',
});

/** How each view draws the rows. `page` is the component: hover and card style. */
export const VIEW_BODIES = Object.freeze({
  grid: (page, rows) => (
    // `min(320px,100%)` RATHER THAN `320px`, and the difference is the whole of
    // whether this page fits a phone. `minmax(320px,1fr)` states a floor no
    // narrower window can honour: on a 320px screen the container is already
    // 320 minus its own `padding:24px 20px`, so every track was 40px wider than
    // the room for it and the page scrolled sideways for ever. `min()` lets the
    // floor fall to the container's own width when there is less than 320 of it,
    // which on a wide screen is not reached and changes nothing.
    <div style={css('display:grid;grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr));gap:16px')}>
      {rows.map((p) => (
        <a
          key={p.pid}
          href={projectUrl(p.pid)}
          {...page.hover(p.pid)}
          style={css(`${page.cardStyle(p.pid)}overflow:hidden;display:flex;flex-direction:column`)}
        >
          <div style={css('position:relative;height:190px;flex:none')}>
            <Preview src={p.preview} />
          </div>
          <div style={css('display:flex;flex-direction:column;gap:8px;padding:12px 14px 13px')}>
            <div style={css('display:flex;flex-direction:column;gap:2px;min-width:0')}>
              <span style={css(`font:600 13.5px ${SANS};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`)}>{p.title}</span>
              <span style={css(`font:400 10.5px ${MONO};color:#787f87;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`)}>
                {p.slug} · {p.meta}
              </span>
            </div>
            <div style={css('display:flex;align-items:center;gap:8px')}>
              <RevLine p={p} />
              <span style={css('flex:1')} />
              <span title={stamp(p.built)} style={css(`font:400 11px ${MONO};color:#787f87`)}>{relTime(p.built)}</span>
            </div>
            <div style={css('display:flex;align-items:center;gap:8px')}>
              <span style={css(`font:400 10.5px ${MONO};color:#b0b6bd`)}>first built {monthYear(p.first)}</span>
            </div>
          </div>
        </a>
      ))}
    </div>
  ),

  list: (page, rows) => (
    <div style={css('display:flex;flex-direction:column;gap:6px')}>
      {rows.map((p) => (
        <a
          key={p.pid}
          href={projectUrl(p.pid)}
          {...page.hover(p.pid)}
          style={css(`${page.cardStyle(p.pid)}display:flex;align-items:center;gap:12px;padding:8px 12px 8px 8px`)}
        >
          <div style={css('position:relative;width:96px;height:60px;flex:none;border-radius:6px;overflow:hidden')}>
            <Preview radius={6} src={p.preview} />
          </div>
          <div style={css('flex:1;min-width:0;display:flex;flex-direction:column;gap:2px')}>
            <span style={css(`font:600 13px ${SANS};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`)}>{p.title}</span>
            <span style={css(`font:400 10.5px ${MONO};color:#787f87;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`)}>
              {p.slug} · {p.meta}
            </span>
          </div>
          <div style={css('width:150px;flex:none;display:flex;align-items:center;gap:8px')}>
            <RevLine p={p} />
          </div>
          <div title={stamp(p.built)} style={css(`width:110px;flex:none;font:400 11px ${MONO};color:#787f87`)}>{relTime(p.built)}</div>
          <div style={css(`width:150px;flex:none;font:400 10.5px ${MONO};color:#b0b6bd`)}>first built {monthYear(p.first)}</div>
        </a>
      ))}
    </div>
  ),
});

export class HammerolaProjects extends React.Component {
  static defaultProps = { projects: [], defaultView: 'grid', defaultSort: 'modified' };

  // Seeded from what this browser remembered, and `null` when it remembered
  // nothing legible — which is what the two getters below already read as "use
  // the default", so the default stays in one place (defaultProps) whether it is
  // reached on a first visit or after a stored value was thrown away.
  //
  // READ IN THE CONSTRUCTOR, not at module scope: this bundle also serves the
  // build page, and a read up there would touch storage on a page that never
  // draws this list.
  constructor(props) {
    super(props);
    this.state = { view: readProjectView(), sort: readProjectSort(), hover: null };
  }

  get view() { return this.state.view || this.props.defaultView; }

  get sort() { return this.state.sort || this.props.defaultSort; }

  /**
   * Both halves of a click on a tab: what is drawn now, and what the next visit
   * opens on.
   *
   * The write goes through store.js and nothing here touches `localStorage`
   * itself — the rule `tests/test_ui_source.py` enforces, so that the one place
   * an absent storage has to be caught stays one place.
   *
   * FILTERED ON THE WAY IN, not only on the way to storage, and the asymmetry
   * that made that necessary is worth naming: `writeProjectView` already
   * refuses an id store.js does not know, so an unrecognised choice was NOT
   * written — and `setState` took it anyway. With no `||` behind the table
   * lookups any more, `choose({ view: 'kanban' })` drew a blank page off a
   * value the next visit could not even reproduce. This method is public on an
   * exported class, so "nothing calls it with that" is not a property of this
   * file. An unknown id now leaves the arrangement where it was, which is what
   * `recall()` in store.js does with an unknown cell.
   */
  choose(patch) {
    const next = {};
    if (PROJECT_VIEWS.includes(patch.view)) next.view = patch.view;
    if (PROJECT_SORTS.includes(patch.sort)) next.sort = patch.sort;
    if (next.view) writeProjectView(next.view);
    if (next.sort) writeProjectSort(next.sort);
    this.setState(next);
  }

  // NO FALLBACK, and the one that used to be here is worth naming because it
  // looked like defence and was not: `SORT_CMP[this.sort] ||
  // SORT_CMP[this.props.defaultSort]` cannot fire, because the only way
  // `this.sort` is missing from the table is that it CAME from `defaultSort` —
  // `state.sort` holds nothing store.js would not hand back. So the second
  // lookup reads the same key as the first, and the branch was dead code that
  // read as cover.
  //
  // What keeps this total is that every input is pinned: store.js validates
  // what it hands back, `choose()` refuses a patch these tables cannot answer,
  // and `ui/tests/vocabulary.test.js` asserts `defaultProps` names arrangements
  // they have. A prop naming something else is a programming error caught at
  // build time.
  //
  // IT HAS TO BE CAUGHT THERE, because a miss on THIS table would not announce
  // itself at runtime. `SORT_CMP[unknown]` is `undefined`, and
  // `Array.prototype.sort(undefined)` is a perfectly legal call: it compares by
  // the default string conversion, which is `"[object Object]"` for every row,
  // so the list comes back in arrival order looking sorted and nothing is
  // thrown. The view half is the loud one — `VIEW_BODIES[unknown]` is
  // `undefined` and throws where `render()` calls it — and the difference is
  // the whole reason the three checks above are the guarantee rather than a
  // formality.
  sorted() {
    return this.props.projects.slice().sort(SORT_CMP[this.sort]);
  }

  hover = (id) => ({
    onMouseEnter: () => this.setState({ hover: id }),
    onMouseLeave: () => this.setState({ hover: null }),
  });

  /** A card's frame, which is the only thing the two view bodies share. */
  cardStyle(id) {
    const lit = this.state.hover === id;
    return 'background:#fff;border:1px solid ' + (lit ? '#9cc4f0' : '#e3e6ea')
      + ';border-radius:10px;text-decoration:none;color:inherit;'
      + (lit ? 'box-shadow:0 3px 14px rgba(20,24,28,.07);' : '');
  }

  tab(active, onClick, content, key) {
    return (
      <div
        key={key}
        onClick={onClick}
        style={css(`display:flex;align-items:center;padding:4px 12px;border-radius:5px;font:500 11.5px ${SANS};cursor:pointer;user-select:none;`
          + (active ? 'background:#fff;color:#1c1f23;box-shadow:0 1px 2px rgba(0,0,0,.10)' : 'color:#5b6470'))}
      >
        {content}
      </div>
    );
  }

  render() {
    const rows = this.sorted();
    // Looked up, not branched on, and with no `||` behind it for the reason
    // `sorted()` gives: the fallback that used to be here could only ever repeat
    // the lookup that had just missed.
    const body = VIEW_BODIES[this.view];

    return (
      <div style={{
        ...css(`min-height:100vh;background:${PAGE_BG};font-family:${SANS};color:${PAGE_FG};font-size:13px`),
        ...FONTS,
      }}
      >
        <style>{ENTRY_CSS}</style>

        {/* ── header ──
            `min-height` and `flex-wrap`, for the reason `static/_v/site.css`
            gives on the resolver's copy of this row and the build page's header
            repeats: a row that cannot break its line can only overflow, and a
            header that overflows is one whose right-hand end — here the sign-out
            button — is simply not on the screen. When the row no longer fits it
            grows a second line instead; this page asks no breakpoint and needs
            none, since the six items here run out of room at around 380px on
            their own. The row gap only ever applies once it has wrapped. */}
        <div style={css('min-height:50px;display:flex;flex-wrap:wrap;align-items:center;'
          + 'gap:6px 12px;padding:0 20px;'
          + `background:${HEADER_BG};border-bottom:1px solid ${HEADER_LINE}`)}>
          <div style={css('display:flex;align-items:center;gap:8px')}>
            <Mark />
            <span style={css(`font:700 14px ${SANS};letter-spacing:-.2px`)}>hammerola</span>
          </div>
          <div style={css(`width:1px;height:22px;background:${HEADER_LINE}`)} />
          <span style={css(`font:600 13px ${SANS};color:#5b6470`)}>Projects</span>
          <span style={css('flex:1')} />
          <span style={css(`font:400 11px ${MONO};color:#9aa1a9`)}>
            {rows.length === 1 ? '1 project' : `${rows.length} projects`}
          </span>
          {/* The only control the header needs, because being here IS being
              signed in — there is no view-only state of this page to switch to.
              It says "Sign out" rather than the build page's "Editing on",
              which would read as a status on a page whose existence already is
              one. */}
          <div
            onClick={this.props.onSignOut}
            style={css('display:flex;align-items:center;gap:7px;padding:6px 11px;border-radius:6px;cursor:pointer;'
              + `font:600 11.5px ${SANS};border:1px solid #d3d8de;background:#fff;color:#2a2e33`)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2.5" y="7" width="11" height="7" rx="1.5" />
              <path d="M5 7V4.8a3 3 0 0 1 6 0V7" />
            </svg>
            Sign out
          </div>
        </div>

        <div style={css('width:100%;max-width:1180px;margin:0 auto;padding:24px 20px 48px;box-sizing:border-box')}>
          {/* ── sort, and which way to look at it ── */}
          <div style={css('display:flex;align-items:center;gap:8px;padding:0 2px 16px;flex-wrap:wrap')}>
            <span style={css(`font:500 11px ${SANS};color:#8a9099`)}>Sort by</span>
            <div style={css('display:flex;background:#e0e3e8;border-radius:6px;padding:2px;gap:2px')}>
              {PROJECT_SORTS.map((id) =>
                this.tab(this.sort === id, () => this.choose({ sort: id }), SORT_LABELS[id], id))}
            </div>
            <span style={css('flex:1')} />
            <div style={css('display:flex;background:#e0e3e8;border-radius:6px;padding:2px;gap:2px')}>
              {PROJECT_VIEWS.map((id) =>
                this.tab(this.view === id, () => this.choose({ view: id }),
                  <svg width="13" height="13" viewBox="0 0 13 13"><path d={VIEW_ICONS[id]} fill="currentColor" /></svg>, id))}
            </div>
          </div>

          {/* ── the rows, drawn the way the chosen view draws them ── */}
          {body(this, rows)}

          {!rows.length && (
            <div style={css(`padding:60px 0;text-align:center;font:400 12px ${SANS};color:#8a9099`)}>
              No projects yet.
            </div>
          )}

          {/* Both halves of this sentence are load-bearing, and the second one is
              the one that answers a support question: a project whose only build
              is in the local slot has NO card here, on purpose (SPEC 7.6, and
              Store._refresh_index). Without saying so, "I published and my
              project is missing" looks like a bug. */}
          <div style={css(`font:400 11px/1.7 ${MONO};color:#b0b6bd;text-align:center;padding-top:28px`)}>
            a project appears here after its first `hammerola commit` —
            <br />
            work published into the local dev slot is never listed
          </div>
        </div>
      </div>
    );
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   The page: which of the two screens, and the one secret between them
   ────────────────────────────────────────────────────────────────────────── */

export default class HammerolaEntry extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      // `null` is "not fetched yet" and `[]` is "fetched, and this hub has no
      // projects". They are drawn differently and must not collapse: the second
      // is a real answer somebody acts on by pushing something.
      projects: null,
      token: readToken(),
      busy: false,
      refused: '',
      // The block the door draws when this hub has nothing on it: `{origin,
      // skill, client}`, or null for "not asked", "not empty" and "could not be
      // asked" alike. Those three are one state on purpose — see `askStart`.
      start: null,
    };
    // Whether the hub has ANSWERED — not whether it has been asked. Two fields
    // rather than one because "no answer yet" and "being asked right now" want
    // opposite things: the first has to be asked again at the next arrival, the
    // second must not be asked over the top of itself. Instance fields rather
    // than state: nothing renders differently for either, and a re-render on the
    // answer is what `start` is for.
    this.answered = false;
    this.asking = null;
  }

  componentDidMount() {
    // THE REQUEST IS LAZY, and the branch is the whole of it: somebody who
    // already has a token is going to the list, and asking a hub with forty
    // projects whether it is empty answers a question nothing on that screen
    // asks. The door is the only screen that reads it, so the door is what pays.
    if (this.state.token) {
      this.open(this.state.token);
      return;
    }
    this.askStart();
  }

  /**
   * Ask the hub whether it has anything published — once it has ANSWERED.
   *
   * Called from every arrival AT THE DOOR: a page load with no token, signing
   * out, and a stored token the hub refused. The last two are how a reader ends
   * up looking at the form without ever having been shown it, and the block has
   * to be there — a hub is at its emptiest for the person who just signed out of
   * one they had nothing in.
   *
   * THE FLAG IS SET ON THE ANSWER AND NOT ON THE REQUEST, which is the whole of
   * what `this.answered` is worth saying about. Set on the way in, one failed
   * ask spent the only one there was: the door's first arrival is a page load,
   * `/start` did not come back, and the 401 a moment later — the arrival the
   * block is most written for, since somebody typing a token into an empty hub
   * is usually its owner — found the question already asked and drew nothing
   * until a reload. That is the ordinary sequence, not a corner of it.
   *
   * A `null` therefore leaves the flag down, and a hub with projects on it is
   * asked again at the next arrival, because `loadStart` collapses "not empty"
   * and "could not ask" into one value on purpose (hub.js). The cost of that is
   * one public, uncached GET per sign-out or mistyped token, which is nothing;
   * the alternative is telling the two apart, and there is nothing the door
   * would do differently if it could. `this.asking` covers the other direction —
   * two arrivals inside one flight ask once between them.
   *
   * The answer cannot go stale in the direction that matters: what turns `empty`
   * false is a push, and the person who pushes reloads to see it.
   *
   * NO `catch`, and that is a property of `loadStart` rather than an oversight:
   * it resolves for every failure it can have, so there is nothing here to
   * catch and no way for a hint to take the sign-in form down. hub.js says why
   * at length, and `ui/tests/start.test.js` is what holds it to it.
   *
   * THE FLIGHT IS CLEARED ON BOTH BRANCHES ALL THE SAME, and the reason is the
   * sentence above rather than a case it misses: "there is nothing to catch" is
   * a fact about `loadStart` TODAY, and it is the first thing here that goes
   * stale — the paragraph above says why the rejecting path was deliberately
   * left open (a defect in this bundle has to arrive as a stack trace, not as a
   * hub that silently never has a block). Clearing on the fulfilled branch
   * ALONE makes that day cost two failures instead of one: the rejected promise
   * stays in `this.asking`, and every later arrival at the door is handed it
   * back unasked — the block never appears again for the life of the page, on a
   * hub that would have answered. The rejection is re-thrown rather than
   * swallowed so the stack trace the docstring promises still reaches the
   * console.
   */
  askStart() {
    if (this.answered) return Promise.resolve();
    if (this.asking) return this.asking;
    this.asking = loadStart().then(
      (hint) => {
        this.asking = null;
        if (hint) this.answered = true;
        // The origin is read HERE, from the browser, and joined to the
        // manifest's relative paths. Neither half is written down anywhere in
        // this bundle.
        this.setState({ start: hint ? { origin: hubOrigin(), ...hint } : null });
      },
      (error) => {
        this.asking = null;
        throw error;
      },
    );
    return this.asking;
  }

  /**
   * Fetch the list with a token, and let the answer decide the screen.
   *
   * ONE PATH FOR BOTH ARRIVALS — a stored token on page load, and one just
   * typed in — because they are the same question asked of the same route, and
   * two paths would be two places for "what does a 401 mean here" to drift. A
   * stored token that the hub no longer accepts (it was rotated, or this browser
   * has been shut for a month) has to land on the sign-in screen exactly as a
   * mistyped one does.
   */
  open(token) {
    this.setState({ busy: true, refused: '' });
    return loadIndex(token).then(
      (cards) => {
        writeToken(token);
        this.setState({
          projects: (Array.isArray(cards) ? cards : []).map(projectCard),
          token,
          busy: false,
          refused: '',
        });
      },
      (error) => {
        if (error instanceof Unauthorized) {
          // Taken out of storage rather than merely not written. A token the hub
          // refuses is not worth keeping, and leaving it would make every later
          // page load start by being refused again.
          clearToken();
          this.setState({
            token: null, busy: false, projects: null,
            refused: 'The hub refused that token.',
          });
          // The reader is at the door and may well be its owner setting the hub
          // up with the wrong string in the browser. The hub answered, so it is
          // there to ask.
          this.askStart();
          return;
        }
        console.error('index', error);
        // NOT asked here, and the difference from the branch above is the whole
        // reason: this one means the hub did not answer at all, so a second
        // question would be one more request nobody can get an answer to.
        this.setState({
          busy: false,
          refused: 'Could not reach the hub. Try again in a moment.',
        });
      },
    );
  }

  submit(value) {
    const token = String(value || '').trim();
    if (!token) {
      this.setState({ refused: 'Paste the token first.' });
      return Promise.resolve();
    }
    return this.open(token);
  }

  signOut() {
    clearToken();
    this.setState({ token: null, projects: null, refused: '' });
    // Back at the door, and it is a door like any other: if there is nothing on
    // this hub, whoever is looking at it needs the block. This is also the only
    // arrival that never passes through a page load.
    this.askStart();
  }

  render() {
    const s = this.state;
    // THE ONLY CONDITION, and it is deliberately the data rather than a screen
    // name: there is a list to show exactly when the hub answered with one.
    // Anything else — no token, a refused token, a hub that did not answer — is
    // the door, which is also the only place any of those can be acted on.
    if (!s.projects) {
      return (
        <HammerolaLogin
          busy={s.busy}
          error={s.refused}
          start={s.start}
          onSubmit={(value) => this.submit(value)}
        />
      );
    }
    return (
      <HammerolaProjects
        projects={s.projects}
        onSignOut={() => this.signOut()}
      />
    );
  }
}
