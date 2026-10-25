/**
 * HammerolaEntry — the front page: sign in, and the list of projects.
 *
 * Data mapping (the mock's fields onto the hub's real index):
 *   PROJECTS   -> GET /index.json, rewritten by `Store._refresh_index` on every
 *                 publish; `hub.projectCard` is the whole mapping.
 *   preview    -> the first view with a rendered sheet (`index_card`); a build
 *                 with no picture draws a neutral plate.
 *   status     -> the last DRAFT build only: `idle`/`building`/`failed`. The chip
 *                 is drawn for `building` and `failed`; a commit build in flight
 *                 stays invisible (see `projectCard` in hub.js).
 *   rev / hash -> one thing: a revision is named by the digest of its sources
 *                 (SPEC 7.7).
 *   createdAt  -> the OLDEST build the hub still holds, labelled "first built"
 *                 (render.index_card).
 *   login      -> the same `EDIT_TOKEN` and storage functions as the build page
 *                 (store.js); the field says that name because it is what
 *                 `hammerola login` asks for.
 *   onSubmit   -> answered by fetching the list with the token: the list IS what
 *                 the token opens, so there is no separate check call.
 *
 * No token, no list: unlike a build, this page enumerates the whole hub, so
 * there is no view-only state. `/index.json` answers 403 without the token
 * (src/app.py, `_serve_index_json`); this component only makes the refusal
 * legible.
 *
 * Both screens carry a block of lines to hand to an agent (`agentBrief`, the
 * client's path from `/start` in src/onboarding.py). The door's copy says where
 * the token comes from and is drawn only on an empty hub; the list's copy
 * carries the token and
 * is drawn on every hub. Every failure of the `/start` fetch is silence
 * (`loadStart` in hub.js).
 *
 * A card is an `<a>` so middle-click, copy-link and the status bar work;
 * `hub.projectUrl` decides where it points.
 *
 * Styling is inline (`css()` in style.jsx parses a CSS string), except the rules
 * in ENTRY_CSS. Fonts are the system stacks — see style.jsx and
 * tests/test_ui_source.py.
 */

import React from 'react';

import {
  deleteProject, hubOrigin, loadIndex, loadStart, projectCard, projectUrl,
  stamp, Unauthorized,
} from './hub.js';
import {
  ACCENT_MONO, BADGE_SANS, BODY_MONO, BODY_SANS, CARD, DANGER, DIALOG_BTN,
  FAINT_MONO, FILL, HEADER_BAR, HEADER_RULE, HIDDEN, META_MONO,
  META_MONO_ONE_LINE, NAME_SANS, NOTE_BOX, ON_CARD, PILL, ROW, SEGMENTED, STACK,
  SUNKEN, TAB_OFF, TAB_ON, TITLE, WORDMARK,
} from './panelstyle.js';
import {
  PROJECT_SORTS, PROJECT_VIEWS, clearToken, readProjectSort, readProjectView,
  readToken, writeProjectSort, writeProjectView, writeToken,
} from './store.js';
import {
  css, FONTS, SANS, MONO, Mark, PAGE_BG, PAGE_FG,
} from './style.jsx';

/**
 * The only two rules that cannot be inline styles: `@keyframes` has no inline
 * form, and `html`/`body` are above anything React renders. The page colour is
 * painted by the `html, body` rule in `static/_v/tokens.css`; restating it here
 * would win (this block is injected later at the same specificity) and could
 * drift.
 *
 * Injected as a `<style>` element because `import './x.css'` would emit a second
 * build output that the Makefile, Dockerfile, ci/smoke.py and the page template
 * would all have to name (see ui/vite.config.mjs). The CSP allows inline styles
 * (src/app.py, CSP_HTML).
 *
 * `hmr_spin`, not `spin`: keyframe names are document-global and the document
 * also holds a vendored stylesheet.
 */
const ENTRY_CSS = `
html, body { margin: 0; }
@keyframes hmr_spin { to { transform: rotate(360deg) } }
`;

/* ───────────────────────────────────────────────────────────────────────────
   The backdrop: icospheres whose mesh keeps refining and coarsening.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Icosphere levels: 0 is the icosahedron, each next one a subdivision.
 *
 * `parents[i] = [a, b]` is the edge vertex `i` is the midpoint of. A vertex is
 * born at `min(a, b)`, where every edge of it is zero-length or lies on an edge
 * of the previous level, so the transition is one mesh unfolding; opacity only
 * says depth.
 *
 * Built on first use: the bundle also serves the build page, which never draws
 * the backdrop and should not subdivide 1280 faces on first paint.
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
 * It stops under `prefers-reduced-motion: reduce` (one frame, read once at
 * mount) and on unmount (signing in swaps this screen for the list). A hidden
 * tab needs nothing: `requestAnimationFrame` does not run there.
 *
 * The ink cannot be a `var()`: a canvas context discards an unparseable colour
 * and keeps the initial black. So the token is set as `color` on the canvas
 * element and read back with `getComputedStyle`, which yields an `rgb(…)` the
 * context parses. That read flushes style, so it is cached and refreshed by a
 * `MutationObserver` on `data-theme` (store.js) instead of per frame.
 * `canvas.width = …` resets the context, so `strokeStyle` and `lineJoin` are
 * assigned every frame.
 *
 * `--text-muted` is the faintest role that still has to be seen; per-edge depth
 * goes into `globalAlpha`, which multiplies whatever the stroke colour is.
 */
export class MeshBackdrop extends React.Component {
  static defaultProps = {
    shapes: BACKDROP_SHAPES, period: 54, color: 'var(--text-muted)',
  };

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

    // Re-read only when `data-theme` changes. Guarded: without an observer the
    // backdrop keeps the ink the page arrived in.
    let ink = window.getComputedStyle(canvas).color;
    try {
      this.watch = new MutationObserver(() => {
        ink = window.getComputedStyle(canvas).color;
      });
      this.watch.observe(document.documentElement,
        { attributes: true, attributeFilter: ['data-theme'] });
    } catch (error) {
      console.warn('backdrop', error);
    }

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
      // The resize above resets the context to its defaults.
      ctx.strokeStyle = ink;

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
          ctx.globalAlpha = 0.26 + 0.34 * (depth + 1) / 2;
          ctx.lineWidth = 0.6 + 0.4 * (depth + 1) / 2;
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
          ctx.stroke();
        });
      });
      // Restore the context default for whatever draws next.
      ctx.globalAlpha = 1;

      if (!reduce) this.raf = requestAnimationFrame(draw);
    };
    this.raf = requestAnimationFrame(draw);
  }

  componentWillUnmount() {
    cancelAnimationFrame(this.raf);
    // This component unmounts while the page stays open.
    if (this.watch) this.watch.disconnect();
  }

  render() {
    return (
      <canvas
        ref={(el) => { this.canvas = el; }}
        style={css('position:absolute;inset:0;width:100%;height:100%;pointer-events:none;'
          + `color:${this.props.color}`)}
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
 * The block both screens offer, as the lines it is made of.
 *
 * Addressed to an agent: imperative and short, because everything about
 * hammerola is in the skill — which this block does not link to but INSTALLS,
 * because the client never looks at the agent's skills directory by itself
 * (`hammerola/skill.py`) and a line asking for the skill to be installed is a
 * line somebody has to work out how to carry out. The commands do it: the
 * client is one file off this hub, and `skill update` writes the whole skill
 * from it.
 *
 * `skill update` carries the address itself rather than waiting for `login` to
 * store it: the skill is public (`/start` needs no token) and `login` asks for
 * the password at the terminal, which an agent's shell does not have. Chained
 * behind it, the skill would be installed only when a human happened to be
 * watching. So `login` comes last and stands alone: it is the one step that
 * needs a person.
 *
 * The `Hub:` line is the one only this page can write — the skill names no
 * deployment (`test_the_skill_names_no_deployment`) — and it stands alone
 * because it is the argument to `hammerola login`.
 *
 * The last line is the token when `token` is passed (the list, which holds an
 * accepted token; the block is then a credential, which the list says beside its
 * button) and otherwise says where the token comes from (the door) — which is
 * what `login` asks for. One function keeps the six shared lines in one place.
 *
 * Everything addressable is built from the caller's `origin` (`hubOrigin`) and
 * the manifest's path for the client; nothing here names a host. "Client" is the
 * repository's one word for `hammerola/`.
 */
export function agentBrief({ origin, client, token }) {
  return [
    `Client: ${origin}${client}`,
    `Hub: ${origin}`,
    `Install: mkdir -p ~/.local/bin && curl -fsSL ${origin}${client} `
      + '-o ~/.local/bin/hammerola && chmod +x ~/.local/bin/hammerola',
    `Skill: HUB_URL=${origin} hammerola skill update`,
    `Then: hammerola login ${origin}`,
    'Read the skill, and follow it.',
    // `Token:` with nothing after it would read as a hub without a secret.
    token ? `Token: ${token}` : 'Ask the owner of this instance for the token.',
  ];
}

/**
 * What the copy button says once it knows, keyed by what happened.
 *
 * `none`: `navigator.clipboard` is absent in an insecure context, such as a hub
 * on plain http on a local network. The button must not claim a copy then.
 */
const COPY_LABELS = { done: 'Copied', failed: 'Copy failed', none: 'Copy by hand' };

/**
 * The lines into the clipboard, in one piece; resolves to a key of COPY_LABELS
 * for every outcome and never rejects. Shared by both blocks.
 */
function copyLines(lines) {
  const clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== 'function') return Promise.resolve('none');
  return clipboard.writeText(lines.join('\n')).then(
    () => 'done',
    // Rejected: the document was not focused or permission was refused.
    () => 'failed',
  );
}

/**
 * The door: the screen a refusal looks like.
 *
 * It has one state. Holding a token the hub accepts means being on the list
 * instead, so a signed-in half would be unreachable; signing out lives in the
 * list's header.
 */
export class HammerolaLogin extends React.Component {
  static defaultProps = {
    title: 'hammerola',
    description: DESCRIPTION,
    animate: true,
    busy: false,
    error: '',
    // `{origin, skill, client, empty}` once the hub answered its manifest, null
    // until then or if it could not be asked. The block is drawn only where
    // `empty` is true.
    start: null,
  };

  state = { token: '', hover: false, focus: false, copied: '' };

  /**
   * A clipboard verdict is about the text that was copied, so it is cleared when
   * the lines change.
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
   * The whole block into the clipboard, in one piece, from the same `agentBrief`
   * call the screen draws, so what is copied matches what is read.
   */
  copy = () => {
    const { start } = this.props;
    if (!start) return Promise.resolve();
    // Clear the previous verdict so a retry does not read as its own result.
    if (this.state.copied) this.setState({ copied: '' });
    // No token: this screen has none. See `agentBrief`.
    return copyLines(agentBrief(start)).then((copied) => this.setState({ copied }));
  };

  /**
   * The block, inside the card under a hairline, so an empty hub reads as one
   * screen with two halves: sign in, or hand this over.
   *
   * Whether to call it is `render`'s decision: "Nothing published here yet" would
   * be false on a hub with projects.
   */
  drawStart(start) {
    return (
      <div style={css('width:100%;margin-top:24px;padding-top:18px;border-top:1px solid var(--line-soft)')}>
        <div style={css(ROW)}>
          <span style={css(NAME_SANS)}>Nothing published here yet</span>
          <span style={css(FILL)} />
          <div
            onClick={this.copy}
            style={css(PILL + BADGE_SANS + ON_CARD)}
          >
            {COPY_LABELS[this.state.copied] || 'Copy'}
          </div>
        </div>
        <div style={css(BODY_SANS)}>
          Hand this to your agent.
        </div>
        <div style={css(NOTE_BOX + SUNKEN + ';' + STACK)}>
          {agentBrief(start).map((line) => (
            <span key={line} style={css(BODY_MONO)}>
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
          + CARD
          + 'box-shadow:0 14px 44px var(--shadow);padding:40px 36px 32px;'
          + 'display:flex;flex-direction:column;align-items:center')}
        >
          <Mark size={44} />
          <div style={css(`font:700 22px ${SANS};letter-spacing:-.3px;margin-top:14px`)}>{title}</div>
          <div style={css(`font:400 12.5px/1.55 ${SANS};color:var(--text-muted);text-align:center;margin-top:8px;text-wrap:pretty`)}>
            {description}
          </div>

          <div style={css('width:100%;display:flex;flex-direction:column;gap:10px;margin-top:26px')}>
            {/* THE FIELD IS RECESSED AT REST AND RISES TO THE CARD ON FOCUS, which
                is what the three fills say and the one thing to get right when
                reading them: `--sunken-bg` is a surface set INTO whatever it
                sits in, `--card-bg` is that surface itself. In the light theme
                those are an off-white and a white and the difference is barely a
                tint; in the dark one the same two tokens are what keeps a field
                from being a hole in the card. The error state paints the palette's
                own red tint rather than a third neutral. */}
            <input
              type="password"
              placeholder="EDIT_TOKEN"
              value={s.token}
              autoComplete="off"
              onChange={(e) => this.setState({ token: e.target.value })}
              onFocus={() => this.setState({ focus: true })}
              onBlur={() => this.setState({ focus: false })}
              onKeyDown={(e) => { if (e.key === 'Enter') this.submit(); }}
              style={css(`width:100%;box-sizing:border-box;height:38px;padding:0 12px;border-radius:6px;font:500 13px ${MONO};color:var(--text);outline:none;`
                + (error ? DANGER
                  : s.focus ? 'border:1px solid var(--accent-line);background:var(--card-bg)'
                    : SUNKEN))}
            />
            <div style={css(error ? `font:400 11px ${SANS};color:var(--danger);margin-top:-4px` : HIDDEN)}>
              {error}
            </div>
            <div
              onClick={this.submit}
              onMouseEnter={() => this.setState({ hover: true })}
              onMouseLeave={() => this.setState({ hover: false })}
              style={css('display:flex;align-items:center;justify-content:center;gap:8px;height:38px;'
                + `border-radius:6px;color:var(--text-on-accent);font:600 13px ${SANS};cursor:pointer;background:`
                // `--accent-muted` is the button waiting: the accent washed
                // toward the ground, readable under white text in either theme.
                + (busy ? 'var(--accent-muted);cursor:default'
                  : s.hover ? 'var(--accent-strong)' : 'var(--accent)'))}
            >
              {busy && (
                // A ring of the button's ink, dimmed with element opacity (the
                // palette has no translucent white).
                <span style={css('width:11px;height:11px;border-radius:50%;opacity:.55;'
                  + 'border:1.6px solid var(--text-on-accent);border-top-color:transparent;'
                  + 'animation:hmr_spin .9s linear infinite')}
                />
              )}
              {busy ? 'Checking…' : 'Sign in'}
            </div>
            <div style={css(`font:400 11px/1.6 ${SANS};color:var(--text-muted);text-align:center`)}>
              The same token <span style={css(`font:500 11px ${MONO}`)}>hammerola login</span> asks
              for. Kept in this browser only. A build somebody linked you to
              opens without it; the list of what is here does not.
            </div>
          </div>

          {/* The door's only gate: the paths arrive on every hub, so this
              boolean alone keeps the block off a hub that has projects. */}
          {start && start.empty && this.drawStart(start)}

          <div style={css(`font:400 11px ${MONO};color:var(--text-faint);margin-top:22px`)}>rev-pinned · agent-built</div>
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
 * The picture is fitted whole (`object-fit:contain`), not cropped: the box has a
 * fluid width (`minmax(min(320px,100%),1fr)` in the grid body) at a fixed height,
 * so its ratio moves with the window. The build ships a band-less render for
 * this box (`cadbuild.artifacts.CARD_SUFFIX`); a build without one names only the
 * sheet, which is fitted whole.
 *
 * The plate stays underneath: it fills the margins `contain` leaves, shows while
 * the picture loads, and remains if it never arrives (`onError` hides the img
 * instead of showing a broken-image glyph; it writes the style directly because
 * this is a hook-free function component). With no `src` only the plate is
 * drawn, which reads as "a model" rather than a broken image.
 */
const Preview = ({ radius, src }) => (
  // Two neighbouring neutrals: a shallow gradient reads as a surface, a flat
  // fill as a missing image. `--hover-bg` stays a neighbour of `--sunken-bg` in
  // both themes; `--chip-bg` would read as an edge.
  <div style={css('position:absolute;inset:0;'
    + 'background:linear-gradient(160deg,var(--sunken-bg),var(--hover-bg));'
    + `overflow:hidden;border-radius:${radius || 0}px`)}
  >
    <svg width="100%" height="100%" viewBox="0 0 120 80" preserveAspectRatio="xMidYMid slice" style={css('display:block')}>
      {/* A presentation attribute is a CSS declaration, so `var()` resolves
          against the cascade, as for the mark in style.jsx. */}
      <g stroke="var(--line-strong)" strokeWidth=".7" fill="none">
        <path d="M60 22l22 13v22L60 70 38 57V35z" />
        <path d="M38 35l22 13 22-13M60 48v22" opacity=".7" />
      </g>
    </svg>
    {src && (
      <img
        src={src}
        alt=""
        onError={(e) => { e.currentTarget.style.display = 'none'; }}
        style={css('position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block')}
      />
    )}
  </div>
);

/**
 * What the newest build of this project is.
 *
 * One identifier: a revision is named by the digest of its sources, cut to seven
 * characters. The `dev` chip says the local slot holds work no commit has
 * published, never what it is (SPEC 7.6); a commit fills the slot with itself,
 * so "slot occupied" would be every card.
 *
 * The status chip appears only for a draft build in flight or failed; `idle`, or
 * a hub that answers no status, gets none.
 *
 * Exported because `texts()` over a view body stops at component elements, so
 * `entry.test.js` calls this directly.
 */
const STATUS_CHIPS = Object.freeze({
  building: {
    title: 'a build of this project\'s draft is running now',
    style: 'color:var(--warn);background:var(--warn-bg)',
  },
  failed: {
    title: 'the last build of this project\'s draft failed',
    style: 'color:var(--danger);background:var(--danger-bg)',
  },
});

export const RevLine = ({ p }) => {
  const status = STATUS_CHIPS[p.status];
  return (
    <React.Fragment>
      <span style={css(ACCENT_MONO)}>{p.rev}</span>
      {p.dev && (
        <span
          title="this project also has uncommitted work in its dev slot"
          style={css(`font:500 10px ${MONO};color:var(--note);background:var(--note-bg);padding:2px 6px;border-radius:4px`)}
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
 * Everything an arrangement's id reaches, in tables keyed by that id.
 *
 * A sort is a tab, a comparator and a value store.js keeps; a view is a tab, a
 * body and the same stored value. Tables make the four key sets one set: a sort
 * missing its comparator would hand `Array.prototype.sort` `undefined` and
 * silently keep arrival order.
 *
 * The views are named in prose here, not quoted: `tests/test_ui_source.py`
 * forbids a quoted view id anywhere in this file outside defaultProps, comments
 * included.
 *
 * Exported so `ui/tests/vocabulary.test.js` compares `Object.keys` against
 * store.js's lists, and frozen so no importer adds a key that check never saw.
 */
export const SORT_LABELS = Object.freeze({ name: 'Name', modified: 'Last built', first: 'First built' });

export const SORT_CMP = Object.freeze({
  // No locale argument: a title can be in any language, and the reader's is
  // not knowable here.
  name: (a, b) => String(a.title).localeCompare(String(b.title)),
  modified: (a, b) => ts(b.built) - ts(a.built),
  first: (a, b) => ts(b.first) - ts(a.first),
});

export const VIEW_ICONS = Object.freeze({
  grid: 'M1 1h4.5v4.5H1zM7.5 1H12v4.5H7.5zM1 7.5h4.5V12H1zM7.5 7.5H12V12H7.5z',
  list: 'M1 1.5h11v2H1zM1 5.5h11v2H1zM1 9.5h11v2H1z',
});

/** How each view draws the rows. `page` is the component: hover, card style, and
 *  the delete control — the one thing on a card that is not part of its link. */
export const VIEW_BODIES = Object.freeze({
  grid: (page, rows) => (
    // `min(320px,100%)`, not `320px`: on a phone the container is narrower than
    // 320px after its padding, and a fixed floor would scroll the page sideways.
    <div style={css('display:grid;grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr));gap:16px')}>
      {rows.map((p) => (
        <a
          key={p.pid}
          href={projectUrl(p.pid)}
          {...page.hover(p.pid)}
          style={css(`${page.cardStyle(p.pid)}overflow:hidden;display:flex;flex-direction:column`)}
        >
          <div style={css('position:relative;height:190px;flex:none')}>
            {/* The band-less picture when the build wrote one, else the sheet. */}
            <Preview src={p.card || p.preview} />
          </div>
          <div style={css('display:flex;flex-direction:column;gap:8px;padding:12px 14px 13px')}>
            <div style={css('display:flex;flex-direction:column;gap:2px;min-width:0')}>
              <span style={css(TITLE)}>{p.title}</span>
              <span style={css(META_MONO_ONE_LINE)}>
                {p.slug} · {p.meta}
              </span>
            </div>
            <div style={css(ROW)}>
              <RevLine p={p} />
              <span style={css(FILL)} />
              <span title={stamp(p.built)} style={css(META_MONO)}>{relTime(p.built)}</span>
            </div>
            <div style={css(ROW)}>
              <span style={css(FAINT_MONO)}>first built {monthYear(p.first)}</span>
              <span style={css(FILL)} />
              {page.remover(p.pid)}
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
            <Preview radius={6} src={p.card || p.preview} />
          </div>
          <div style={css('flex:1;min-width:0;display:flex;flex-direction:column;gap:2px')}>
            <span style={css(`font:600 13px ${SANS};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`)}>{p.title}</span>
            <span style={css(META_MONO_ONE_LINE)}>
              {p.slug} · {p.meta}
            </span>
          </div>
          <div style={css('width:150px;flex:none;display:flex;align-items:center;gap:8px')}>
            <RevLine p={p} />
          </div>
          <div title={stamp(p.built)} style={css(`width:110px;flex:none;font:400 11px ${MONO};color:var(--text-muted)`)}>{relTime(p.built)}</div>
          <div style={css(`width:150px;flex:none;font:400 10.5px ${MONO};color:var(--text-faint)`)}>first built {monthYear(p.first)}</div>
          {page.remover(p.pid)}
        </a>
      ))}
    </div>
  ),
});

/**
 * The delete control's tooltip: the control is a 13px glyph, and the act is
 * spelled out once pressed (`drawConfirm`). Exported so `entry.test.js` finds the
 * control by the same string.
 */
export const REMOVE_TITLE = 'Delete this project';

export class HammerolaProjects extends React.Component {
  static defaultProps = {
    projects: [],
    defaultView: 'grid',
    defaultSort: 'modified',
    // `{origin, skill, client, empty}` once the hub answered its manifest, null
    // until then. `empty` is the door's condition and is not read here: this
    // page draws its block wherever the paths arrived.
    start: null,
    // The token this browser got in with: the footer's block prints it, and it
    // decides whether a card carries a delete control (`remover`). It is never
    // sent from here; the page above makes the request (`onDelete`).
    token: '',
    // Remove one project, whole. Returns a promise that resolves once the hub
    // has done it and rejects with the sentence to show (see `remove`). Null
    // draws no control.
    onDelete: null,
  };

  // Seeded from storage; `null` when nothing legible was stored, which the
  // getters below read as "use defaultProps". Read in the constructor, not at
  // module scope, because this bundle also serves the build page.
  constructor(props) {
    super(props);
    this.state = {
      view: readProjectView(),
      sort: readProjectSort(),
      hover: null,
      copied: '',
      // The confirmation: `doomed` is the pid being confirmed (and whether the
      // box is shown), `typed` the text typed so far, `erasing` that the hub was
      // asked and has not answered, `failed` its refusal. Cleared together
      // (`askRemove`, `cancelRemove`) so a refusal never shows under another
      // project.
      doomed: null,
      typed: '',
      erasing: false,
      failed: '',
    };
  }

  get view() { return this.state.view || this.props.defaultView; }

  get sort() { return this.state.sort || this.props.defaultSort; }

  /**
   * A tab click: what is drawn now, and what the next visit opens on.
   *
   * Storage goes through store.js only (enforced by `tests/test_ui_source.py`).
   * An id store.js does not know is ignored here too, not only on the way to
   * storage: the tables have no fallback, so an unknown view would draw a blank
   * page. This matches `recall()` in store.js.
   */
  choose(patch) {
    const next = {};
    if (PROJECT_VIEWS.includes(patch.view)) next.view = patch.view;
    if (PROJECT_SORTS.includes(patch.sort)) next.sort = patch.sort;
    if (next.view) writeProjectView(next.view);
    if (next.sort) writeProjectSort(next.sort);
    this.setState(next);
  }

  // No fallback: every input is pinned — store.js validates what it returns,
  // `choose()` refuses unknown ids, and `ui/tests/vocabulary.test.js` checks
  // defaultProps. That check matters because a miss here is silent:
  // `sort(undefined)` compares every row as "[object Object]" and keeps arrival
  // order, whereas an unknown view throws in `render()`.
  sorted() {
    return this.props.projects.slice().sort(SORT_CMP[this.sort]);
  }

  hover = (id) => ({
    onMouseEnter: () => this.setState({ hover: id }),
    onMouseLeave: () => this.setState({ hover: null }),
  });

  /** A card's frame, the only thing the two view bodies share. `--line` is the
   * same border the sign-in card uses. */
  cardStyle(id) {
    const lit = this.state.hover === id;
    return 'background:var(--card-bg);border:1px solid '
      + (lit ? 'var(--accent-line)' : 'var(--line)')
      + ';border-radius:10px;text-decoration:none;color:inherit;'
      + (lit ? 'box-shadow:0 3px 14px var(--shadow-soft);' : '');
  }

  tab(active, onClick, content, key) {
    return (
      <div
        key={key}
        onClick={onClick}
        style={css(`display:flex;align-items:center;padding:4px 12px;border-radius:5px;font:500 11.5px ${SANS};cursor:pointer;user-select:none;`
          + (active ? TAB_ON : TAB_OFF))}
      >
        {content}
      </div>
    );
  }

  /* ─── removing a project ───────────────────────────────────────────────
     The same act and confirmation as `hammerola rm`. `token` decides whether to
     draw the control; the request is the page's (`onDelete`). */

  /**
   * The delete control on one card, or nothing.
   *
   * Drawn only with a token and an `onDelete` handler: the class is exported and
   * `token` defaults to empty. It sits inside the card's `<a>`, hence
   * `preventDefault` and `stopPropagation` so the click does not navigate.
   */
  remover(pid) {
    if (!this.props.token || !this.props.onDelete) return null;
    return (
      <span
        title={REMOVE_TITLE}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          this.askRemove(pid);
        }}
        style={css('display:flex;align-items:center;flex:none;padding:4px;border-radius:5px;'
          + 'cursor:pointer;color:var(--text-faint)')}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M2.8 4.2h10.4M6.4 4.2V2.8h3.2v1.4M4.3 4.2l.6 8.4c.03.5.44.8.9.8h4.4c.46 0 .87-.3.9-.8l.6-8.4" />
        </svg>
      </span>
    );
  }

  /** Raise the confirmation over one project, with nothing carried into it. */
  askRemove(pid) {
    this.setState({ doomed: pid, typed: '', erasing: false, failed: '' });
  }

  cancelRemove = () => {
    this.setState({ doomed: null, typed: '', erasing: false, failed: '' });
  };

  /**
   * Whether what has been typed is the id of the project being removed.
   *
   * The id, not a yes, as `hammerola rm` asks (`admin.CONFIRM_PROMPT`): deletion
   * is irreversible (SPEC 5.3, 7.3). Only trimmed, like the client's `.strip()`,
   * because a pasted id often carries whitespace.
   */
  get confirmed() {
    const pid = this.state.doomed;
    return !!pid && this.state.typed.trim() === pid;
  }

  /**
   * Ask the page to remove the project, once the id has been typed back.
   *
   * The guard is here, not only in the button's look: Enter in the field runs
   * this too, and it is public on an exported class. A failure leaves the box
   * open with the hub's sentence, so the reader learns the project is still there.
   */
  remove = () => {
    if (!this.confirmed || this.state.erasing || !this.props.onDelete) {
      return Promise.resolve();
    }
    this.setState({ erasing: true, failed: '' });
    return Promise.resolve(this.props.onDelete(this.state.doomed)).then(
      // The card leaves because the page dropped it from its state; filtering
      // here too would be a second answer to "what is on this hub".
      () => this.setState({ doomed: null, typed: '', erasing: false, failed: '' }),
      (error) => this.setState({
        erasing: false,
        failed: String((error && error.message) || error),
      }),
    );
  };

  /**
   * The confirmation, over the whole page rather than inside the card, which is
   * too small in either view for three sentences and a field. Falls back to the
   * id when the row's `title` is empty.
   */
  drawConfirm() {
    const pid = this.state.doomed;
    if (!pid) return null;
    const row = this.props.projects.find((p) => p.pid === pid);
    const { erasing, failed } = this.state;
    const armed = this.confirmed && !erasing;
    return (
      <div style={css('position:fixed;inset:0;z-index:40;padding:20px;box-sizing:border-box;'
        + 'display:flex;align-items:center;justify-content:center;background:var(--shadow)')}
      >
        <div style={css('width:380px;max-width:100%;box-sizing:border-box;'
          + CARD
          + 'box-shadow:0 14px 44px var(--shadow);padding:22px 22px 18px;'
          + 'display:flex;flex-direction:column;gap:10px')}
        >
          <div style={css(`font:700 15px ${SANS}`)}>Delete this project</div>
          <div style={css(`font:400 12px/1.6 ${SANS};color:var(--text-muted)`)}>
            <span style={css(`font:600 12px ${SANS};color:var(--text)`)}>{(row && row.title) || pid}</span>
            {' '}goes whole: every build, both pointers, the comment queue and the stored
            code of each revision. Its links stop resolving, the hub keeps no copy, and
            nothing undoes this.
          </div>
          <div style={css(`font:400 12px/1.6 ${SANS};color:var(--text)`)}>
            Type <span style={css(ACCENT_MONO)}>{pid}</span> to confirm.
          </div>
          {/* As the sign-in field: recessed at rest, red tint once refused. */}
          <input
            type="text"
            placeholder="project id"
            value={this.state.typed}
            autoComplete="off"
            spellCheck="false"
            onChange={(e) => this.setState({ typed: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') this.remove(); }}
            style={css(`width:100%;box-sizing:border-box;height:36px;padding:0 12px;border-radius:6px;font:500 13px ${MONO};color:var(--text);outline:none;`
              + (failed ? DANGER : SUNKEN))}
          />
          <div style={css(failed ? `font:400 11px/1.5 ${SANS};color:var(--danger)` : HIDDEN)}>
            {failed}
          </div>
          <div style={css('display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:2px')}>
            <div
              onClick={this.cancelRemove}
              style={css(DIALOG_BTN
                + `cursor:pointer;user-select:none;font:600 12px ${SANS};`
                + 'border:1px solid var(--line);background:var(--card-bg);color:var(--text)')}
            >
              Cancel
            </div>
            {/* Inert neutral until the id is typed back (`remove` refuses on its
                own account regardless); armed it takes the danger tint, as the
                error lines do. */}
            <div
              onClick={this.remove}
              style={css(DIALOG_BTN
                + `user-select:none;font:600 12px ${SANS};`
                + (armed
                  ? 'border:1px solid var(--danger-line);background:var(--danger-bg);'
                    + 'color:var(--danger);cursor:pointer'
                  : SUNKEN + ';'
                    + 'color:var(--text-faint);cursor:default'))}
            >
              {erasing ? 'Deleting…' : 'Delete'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  /**
   * The block's text, from the one call the box and the button both read, so
   * what is copied matches what is shown: the page's `start` plus this token.
   */
  brief() {
    return agentBrief({ ...this.props.start, token: this.props.token });
  }

  copy = () => {
    if (!this.props.start) return Promise.resolve();
    // The verdict is about the press before this one — see the door's `copy`.
    if (this.state.copied) this.setState({ copied: '' });
    return copyLines(this.brief()).then((copied) => this.setState({ copied }));
  };

  /**
   * The block in the footer, on every hub whose paths came back: the reader is
   * the owner starting the next project. Its last line is the token, which is
   * why the sentence under the heading calls it a credential.
   *
   * No `componentDidUpdate` clearing the verdict, unlike the door: `start`
   * arrives once and before the block exists, and losing the token takes the
   * page back to the door (`entry.test.js` holds this).
   */
  drawBrief() {
    if (!this.props.start) return null;
    return (
      <div style={css('max-width:560px;margin:14px auto 0;box-sizing:border-box;'
        + 'padding:12px 13px;border-radius:8px;'
        + 'border:1px solid var(--line);background:var(--card-bg);text-align:left')}
      >
        <div style={css('display:flex;align-items:center;gap:8px;flex-wrap:wrap')}>
          <span style={css(NAME_SANS)}>Hand this to your agent</span>
          <span style={css(FILL)} />
          <div
            onClick={this.copy}
            style={css(PILL + BADGE_SANS + ON_CARD)}
          >
            {COPY_LABELS[this.state.copied] || 'Copy'}
          </div>
        </div>
        <div style={css(BODY_SANS)}>
          It carries this hub&apos;s token: whatever you paste it into is holding a credential.
        </div>
        <div style={css(NOTE_BOX + SUNKEN + ';' + STACK)}>
          {this.brief().map((line) => (
            <span key={line} style={css(BODY_MONO)}>
              {line}
            </span>
          ))}
        </div>
      </div>
    );
  }

  render() {
    const rows = this.sorted();
    // Looked up, no fallback — see `sorted()`.
    const body = VIEW_BODIES[this.view];

    return (
      <div style={{
        ...css(`min-height:100vh;background:${PAGE_BG};font-family:${SANS};color:${PAGE_FG};font-size:13px`),
        ...FONTS,
      }}
      >
        <style>{ENTRY_CSS}</style>

        {/* ── header ──
            `min-height` and `flex-wrap` (as in `static/_v/site.css`): when the
            row does not fit it wraps instead of pushing the sign-out button off
            screen. No breakpoint needed; the row gap applies only once wrapped. */}
        <div style={css('min-height:50px;display:flex;flex-wrap:wrap;align-items:center;'
          + 'gap:6px 12px;padding:0 20px;'
          + HEADER_BAR)}>
          <div style={css(ROW)}>
            <Mark />
            <span style={css(WORDMARK)}>hammerola</span>
          </div>
          <div style={css(HEADER_RULE)} />
          <span style={css(`font:600 13px ${SANS};color:var(--text-soft)`)}>Projects</span>
          <span style={css(FILL)} />
          <span style={css(`font:400 11px ${MONO};color:var(--text-faint)`)}>
            {rows.length === 1 ? '1 project' : `${rows.length} projects`}
          </span>
          {/* Being here is being signed in, so this is the header's only
              control. */}
          <div
            onClick={this.props.onSignOut}
            style={css('display:flex;align-items:center;gap:7px;padding:6px 11px;border-radius:6px;cursor:pointer;'
              + `font:600 11.5px ${SANS};border:1px solid var(--line);`
              + ON_CARD)}
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
            <span style={css(`font:500 11px ${SANS};color:var(--text-muted)`)}>Sort by</span>
            {/* The track is `--chip-bg` because it lies on `--page-bg`, where
                `--sunken-bg` would be lighter than the page. Both pills share it. */}
            <div style={css(SEGMENTED)}>
              {PROJECT_SORTS.map((id) =>
                this.tab(this.sort === id, () => this.choose({ sort: id }), SORT_LABELS[id], id))}
            </div>
            <span style={css(FILL)} />
            <div style={css(SEGMENTED)}>
              {PROJECT_VIEWS.map((id) =>
                this.tab(this.view === id, () => this.choose({ view: id }),
                  <svg width="13" height="13" viewBox="0 0 13 13"><path d={VIEW_ICONS[id]} fill="currentColor" /></svg>, id))}
            </div>
          </div>

          {/* ── the rows, drawn the way the chosen view draws them ── */}
          {body(this, rows)}

          {!rows.length && (
            <div style={css(`padding:60px 0;text-align:center;font:400 12px ${SANS};color:var(--text-muted)`)}>
              No projects yet.
            </div>
          )}

          {/* A project whose only build is in the local slot has no card here
              (SPEC 7.6, Store._refresh_index); saying so keeps "my project is
              missing" from looking like a bug. */}
          <div style={css(`font:400 11px/1.7 ${MONO};color:var(--text-faint);text-align:center;padding-top:28px`)}>
            a project is listed from its first `hammerola commit` — never from a `dev` push
          </div>
          {this.drawBrief()}
        </div>

        {/* Outside the column and `position:fixed`, so it appears mid-screen
            however far the list is scrolled. */}
        {this.drawConfirm()}
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
      // `null` is "not fetched yet", `[]` is "this hub has no projects"; they
      // are drawn differently.
      projects: null,
      token: readToken(),
      busy: false,
      refused: '',
      // What both screens build their block from: `{origin, skill, client,
      // empty}`, or null for "not asked yet" and "could not be asked" alike (see
      // `askStart`). The door reads `empty`; the list does not.
      start: null,
    };
    // `answered`: the hub has answered (not merely been asked), so a failed ask
    // is retried at the next arrival. `asking`: the request in flight, so
    // arrivals during it share it. Instance fields: neither changes rendering.
    this.answered = false;
    this.asking = null;
  }

  componentDidMount() {
    // A token goes straight to the list, which asks for `/start` itself once
    // the list is back; otherwise this is the door.
    if (this.state.token) {
      this.open(this.state.token);
      return;
    }
    this.askStart();
  }

  /**
   * Fetch `/start` until the hub has answered once.
   *
   * Called on every arrival at the door (page load without a token, sign-out, a
   * refused token) and when the list comes back; the door reads `empty`, the
   * list ignores it.
   *
   * `answered` is set on the answer, not the request: a `null` (no answer, or an
   * unreadable one — hub.js) leaves it down and the next arrival asks again. That
   * matters because a failed first ask on page load would otherwise hide the
   * block after the following 403. `asking` makes concurrent arrivals share one
   * request. `empty` only turns false by a push, after which the reader reloads;
   * the paths are constants of the image.
   *
   * No `catch`: `loadStart` resolves for every failure it expects
   * (`ui/tests/start.test.js`), so a rejection is a defect that should reach the
   * console. The flight is cleared on both branches so a rejection does not
   * stay in `asking` and block every later ask; it is re-thrown.
   */
  askStart() {
    if (this.answered) return Promise.resolve();
    if (this.asking) return this.asking;
    this.asking = loadStart().then(
      (hint) => {
        this.asking = null;
        if (hint) this.answered = true;
        // Origin from the browser, joined to the manifest's relative paths.
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
   * One path for a stored token and a typed one, so a stored token the hub no
   * longer accepts lands on the sign-in screen exactly as a mistyped one does.
   */
  open(token) {
    this.setState({ busy: true, refused: '' });
    return loadIndex(token).then(
      (cards) => {
        writeToken(token);
        const rows = (Array.isArray(cards) ? cards : []).map(projectCard);
        this.setState({
          projects: rows,
          token,
          busy: false,
          refused: '',
        });
        // The list draws the block whatever the hub holds, so ask now; a door
        // arrival that already got an answer makes no second request.
        this.askStart();
      },
      (error) => {
        if (error instanceof Unauthorized) {
          // Cleared from storage so later page loads do not start refused.
          clearToken();
          this.setState({
            token: null, busy: false, projects: null,
            refused: 'The hub refused that token.',
          });
          // Back at the door; the hub answered, so it can be asked for `/start`.
          this.askStart();
          return;
        }
        console.error('index', error);
        // Not asked here: the hub did not answer at all.
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

  /**
   * Remove one project from the hub, and its card from the list.
   *
   * The request is the page's (it holds the token and the list); the promise
   * lets the box stay open with a sentence on failure
   * (`HammerolaProjects.remove`). A 403 gets `open`'s wording; anything else
   * carries the hub's message (a 404 means someone removed it already). Unlike
   * `open`, a 403 here does not sign the reader out: the list on screen was
   * fetched with this token moments ago.
   */
  remove(pid) {
    return deleteProject(pid, this.state.token).then(
      () => {
        this.setState({
          projects: (this.state.projects || []).filter((p) => p.pid !== pid),
        });
      },
      (error) => {
        if (error instanceof Unauthorized) {
          throw new Error('The hub refused that token.');
        }
        console.error('remove', error);
        throw new Error(`The hub did not remove it: ${String((error && error.message) || error)}`);
      },
    );
  }

  signOut() {
    clearToken();
    this.setState({ token: null, projects: null, refused: '' });
    // Back at the door, which needs the block if the hub is empty.
    this.askStart();
  }

  render() {
    const s = this.state;
    // The only condition: a list exists exactly when the hub answered with one.
    // Anything else — no token, refused, unreachable — is the door.
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
        start={s.start}
        token={s.token}
        onDelete={(pid) => this.remove(pid)}
        onSignOut={() => this.signOut()}
      />
    );
  }
}
