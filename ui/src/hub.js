// What the pages are showing, and the fetches that say what is in them.
//
// Kept out of the components because none of it is React and all of it is the
// hub's contract. The URL scheme is the whole of the addressing (src/app.py):
//
//     /index.json                       what is on this hub -- EDIT_TOKEN. The
//                                       guarded routes in this list are marked
//                                       with the secret's name, as this one is;
//                                       the comment, job and source APIs are
//                                       guarded too and are simply not listed
//     /start                            where to get the skill and the client,
//                                       and whether anything is published here
//                                       yet -- PUBLIC. `meta.json` below is
//                                       asked for without a token as well;
//                                       what is special here is that the
//                                       ANSWER is for a reader who has no
//                                       token at all
//     /project/<pid>/                   the project, on whichever pointer the
//                                       reader was last on (SPEC 9)
//     /project/<pid>/<slot>/            the page, where <slot> is a commit id
//                                       or one of the two moving names
//     /project/<pid>/<slot>/meta.json   this build: title, views, part catalogue
//     /project/<pid>/builds.json        the picker: pointers plus the history
//                                       -- EDIT_TOKEN
//     /project/<pid>/<slot>/<view file> the geometry, ~2 MB of it
//     /project/<pid>/<a>/compare/<b>/   the two documents of one comparison --
//                                       EDIT_TOKEN, both of them; see the
//                                       section further down. The PAGE at that
//                                       address is the page of build <a>, which
//                                       is what `pageFrom` below reads off it
//     /api/v1/projects/<pid>            DELETE: the project and everything under
//                                       it -- EDIT_TOKEN. The one address here
//                                       that UNMAKES something, and the only
//                                       write either page makes to a project
//
// A comparison's SCENE is not fetched here: the viewport fetches it to render
// it and hands the tree back on `hmr:model`.
//
// Nothing here invents an endpoint: where a block of the brief has no source on
// the server, the component says so on screen.

import { after, turned } from './viewport/math.js';

/** The two moving names. Same list as static/_v/pointer_pref.js. */
export const POINTER_NAMES = ['latest', 'dev'];

/**
 * The id of the view a model is assembled in.
 *
 * Spelled in `src/cadbuild/artifacts.py` as `ASSEMBLED_VIEW_ID`;
 * `tests/test_ui_source.py` checks the two agree, since neither runtime can
 * import the other's constant. `views.prepare_views` refuses a model without a
 * view under this id. It matters because a distance BETWEEN two parts only
 * means anything where they stand as assembled — on a print bed they are moved
 * apart on purpose (brief, block 7). A single-part measurement carries
 * `crossPart: false` and is never labelled either way.
 */
export const ASSEMBLED_VIEW_ID = 'assembled';

/** The four fields, read off one pathname. Pure, and the only place that
 *  arithmetic is written — `PAGE` and `rereadPage` both use it.
 *
 *  Exported for the `popstate` handler, which has to know what an address
 *  means before anything has been fetched. */
export function pageFrom(pathname) {
  const parts = String(pathname).split('/');
  // `/project/<pid>/<a>/compare/<b>/` IS THE PAGE OF BUILD `<a>`, COMPARING
  // AGAINST `<b>`. Everything but the scene belongs to `<a>` (meta.json,
  // builds.json, picker, downloads, comment rail), so the base is the build's
  // own directory, not the address bar's. The word sits in the fourth segment
  // because `compare` is a legal build id (src/app.py): on
  // `/project/<pid>/compare/` `parts[4]` is the trailing ''.
  const comparing = parts[4] === 'compare';
  return {
    pid: parts[2] || '',
    // HOW the page was reached, which is not the same question as which build
    // answered: on `/latest/` the slot is `latest` and meta.commit is a hash.
    slot: parts[3] || '',
    base: comparing ? `${parts.slice(0, 4).join('/')}/`
                    : String(pathname).replace(/[^/]*$/, ''),
    // The other end of the pair, '' on an ordinary page. The first load reads
    // it to boot straight into the comparison (`load`).
    cmp: comparing ? (parts[5] || '') : '',
  };
}

/** Where this page sits, read off its own URL and nothing else.
 *
 * No template variable, no data attribute: the hub renders the same static
 * build.html for every project and every build (src/render.py), so the URL is
 * the only thing that says which one this is. The committed page scripts read
 * theirs the same way.
 */
export const PAGE = pageFrom(location.pathname);

/**
 * Read it again, IN PLACE, after the URL moved without the page reloading.
 *
 * Switching revisions is a `history.pushState` rather than a navigation, so
 * the reader keeps the camera, hidden parts and section. Nothing re-derives
 * `PAGE` on its own, so after a push this must run or `PAGE.base` would keep
 * fetching the previous revision.
 *
 * `Object.assign` onto the same object, not a reassignment: every module reads
 * the imported object as data (`PAGE.base`, `PAGE.slot`), and rebinding the
 * export would leave them on the old record.
 *
 * The argument is for tests and for a caller that knows the path before the
 * browser does; with none, the browser's own URL is used.
 */
export function rereadPage(pathname) {
  return Object.assign(
    PAGE, pageFrom(pathname === undefined ? location.pathname : pathname));
}

/** True on the two URLs whose content can be rewritten under the reader. */
export const isPointerPage = () => POINTER_NAMES.includes(PAGE.slot);

/** The query key the camera frame travels under in a model page's address. */
export const CAMERA_QUERY = 'c';

/**
 * A camera frame `{position, quaternion, target, zoom}` as the value of `c=`:
 * eleven numbers joined by commas — position x,y,z, quaternion x,y,z,w, target
 * x,y,z, zoom — or null for anything that is not a whole frame.
 *
 * Rounded so the address stays short: position and target to 0.01 (model
 * units, millimetres), the quaternion's unit-length components to 1e-5, the
 * zoom to four significant digits, since it is a ratio that ranges over
 * orders of magnitude.
 */
export function encodeCamera(frame) {
  if (!frame) return null;
  const fixed = (list, size, digits) => (Array.isArray(list) && list.length === size
    ? list.map((v) => (Number.isFinite(v) ? Number(v.toFixed(digits)) : NaN))
    : [NaN]);
  const numbers = [
    ...fixed(frame.position, 3, 2),
    ...fixed(frame.quaternion, 4, 5),
    ...fixed(frame.target, 3, 2),
    Number.isFinite(frame.zoom) ? Number(frame.zoom.toPrecision(4)) : NaN,
  ];
  return numbers.length === 11 && numbers.every(Number.isFinite) ? numbers.join(',') : null;
}

/**
 * The frame `encodeCamera` wrote, back from the text of `c=`: null unless the
 * text is exactly eleven finite numbers, so a damaged link opens as if it
 * carried no camera.
 */
export function decodeCamera(text) {
  const parts = typeof text === 'string' ? text.split(',') : [];
  if (parts.length !== 11) return null;
  const n = parts.map((part) => (part.trim() === '' ? NaN : Number(part)));
  if (!n.every(Number.isFinite)) return null;
  return {
    position: n.slice(0, 3), quaternion: n.slice(3, 7),
    target: n.slice(7, 10), zoom: n[10],
  };
}

async function getJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

/** This build, as the hub normalised it at publish time (src/render.py).
 *
 * `base` names a build OTHER than the one on screen, and it is what lets a
 * revision switch ask before it commits to anything: the swap has to know the
 * target's views before it moves the URL, so that a 404 leaves the page exactly
 * where it was rather than half moved. Left out, it is this page's own build.
 */
export const loadMeta = (fresh, base) =>
  getJson(`${base === undefined ? PAGE.base : base}meta.json`,
          fresh ? { cache: 'no-store' } : undefined);

/** The build picker: `{pid, project, title, has_dev, latest, builds[],
 * files_keys}`.
 *
 * Behind the token: it lists every revision and the draft, and a shared build
 * link must open that build alone. `files_keys` is added by the hub as it
 * answers and is never in the file on its volume: address -> the key that
 * opens that build's STEP, STL and 3MF in a link (`latest`, each revision of
 * `builds`, and `dev` while the slot is occupied). Absent when the hub could
 * not read its own file.
 */
export const loadBuilds = (token) =>
  getJson(`/project/${PAGE.pid}/builds.json`, { headers: tokenHeader(token) });

// -- the front page ---------------------------------------------------------

/** The hub said no. Distinguished from every other failure by the caller. */
export class Unauthorized extends Error {}

/**
 * Every project's card, as `Store._refresh_index` wrote them — BEHIND THE TOKEN.
 *
 * The only document on the service that enumerates what exists, so it is
 * guarded while a build page is not (src/app.py). This function is both the
 * front page's access control and its sign-in check: there is no separate
 * "is this token good" endpoint.
 *
 * A 403 is raised apart from everything else: "the token is wrong" and "the hub
 * is unreachable" lead to different screens.
 */
export async function loadIndex(token) {
  const response = await fetch('/index.json', {
    headers: tokenHeader(token),
    cache: 'no-store',
  });
  if (response.status === 403) throw new Unauthorized('/index.json -> HTTP 403');
  if (!response.ok) throw new Error(`/index.json -> HTTP ${response.status}`);
  return response.json();
}

/**
 * A card's link: THE PROJECT, and never one of its pointers.
 *
 * The pointer-less URL opens whichever of `latest` and `dev` this reader was
 * last on (SPEC 9); linking at `latest` would overwrite that memory on every
 * visit to the front page.
 */
export const projectUrl = (pid) => `/project/${encodeURIComponent(pid)}/`;

/**
 * One FILE of one build, by the name that build declared for it.
 *
 * The commit and not a pointer: a picture fetched from `latest` could be a
 * newer build's than the one the card names.
 *
 * All three parts are escaped: the file name is chosen by the model, and it is
 * a path segment here, not a path.
 */
export const buildFileUrl = (pid, commit, file) => (
  `/project/${encodeURIComponent(pid)}/${encodeURIComponent(commit)}`
  + `/${encodeURIComponent(file)}`);

/**
 * One card of `/index.json`, as the front page renders it.
 *
 * The mapping is in one function so `tests/test_ui_source.py` can compare the
 * fields read here against the keys `render.index_card` writes. A missing field
 * reads as `undefined` and renders empty or `NaN`, never as an error.
 *
 * `preview` is the first whole-view sheet the build declares, as a URL under
 * that build; `null` when the build has no picture (an image without a
 * rendering stack ships no PNGs), and the plate is drawn instead.
 *
 * There is no revision number: a revision is named by the digest of its
 * sources (SPEC 7.7), shown at the length the rest of the site uses.
 *
 * `status` (`idle`/`building`/`failed`) is about the last build pushed AS A
 * DRAFT only — not about whatever is in the `dev` slot, which a commit also
 * mirrors into. The hub records the job id when the build starts and
 * `/index.json` maps its live state per request (`_serve_index_json` in
 * src/app.py, `render.card_status`); a job left in flight by a crash is failed
 * at the next start. A commit build in flight is not reported: the card
 * describes what has been published from a commit (SPEC 7.6).
 *
 * `first` is the oldest build the hub holds, not a creation date — see
 * `render.index_card`.
 *
 * `printables` counts only printable records (the catalogue's `parts` includes
 * bought screws and scenery), and the card says "printables" to match.
 *
 * `documents` is a count on the card of a build with no model and null on a
 * model's card, documents or not (absent on a card written before documents
 * existed), so `== null` is the model's line.
 */
export function projectCard(card) {
  return {
    pid: card.pid,
    title: card.title || card.project || card.pid,
    slug: card.project,
    meta: card.documents == null
      ? `${card.printables} printables · ${card.views} views · ${card.mb} MB`
      : `${card.documents} documents · ${card.mb} MB`,
    rev: shortId(card.commit),
    dev: !!card.dev,
    status: card.status,
    built: card.built,
    first: card.first_built,
    preview: card.preview
      ? buildFileUrl(card.pid, card.commit, card.preview)
      : null,
    // The picture drawn FOR a card: the same render without the sheet's title
    // band and footer. `null` for older builds; the card falls back to
    // `preview`.
    card: card.card
      ? buildFileUrl(card.pid, card.commit, card.card)
      : null,
  };
}

// -- getting started --------------------------------------------------------
// The route whose answer is meant for somebody who has no token yet
// (src/onboarding.py). `onboarding.manifest` writes its keys and
// tests/test_onboarding.py pins the set. This file reads the boolean and two of
// the paths: both pages render a block from the paths, and the boolean is the
// door's own condition for drawing it.

const START_URL = '/start';

/**
 * This hub's address, as the browser has it — read, never written down.
 *
 * The block is a set of addresses handed to an agent, the hub's own among
 * them. It cannot be a constant: the repository carries no deployment's
 * address (AGENTS.md, `test_the_skill_names_no_deployment`).
 *
 * Called when the answer is stored rather than at module scope, because this
 * bundle also serves the build page, which draws no block.
 */
export const hubOrigin = () => String(window.location.origin || '');

/**
 * A path the block can print, or '' for anything else.
 *
 * Robustness, not a guard: `/start` is served by the same hub as this page, so
 * there is no boundary to defend. It catches a manifest that is no good for
 * ordinary reasons (a proxy answering HTML, a field of another type): a field
 * that is not a string beginning with `/` drops the whole block (`startHint`).
 * The block prints no path of its own any more — the skill arrives through the
 * client — but a manifest with a field of the wrong shape is a manifest to
 * believe nothing in, including the client's path the block does print.
 */
function hubPath(value) {
  if (typeof value !== 'string') return '';
  if (value[0] !== '/') return '';
  return value;
}

/**
 * What a `/start` document offers a page — two paths and a boolean — or nothing.
 *
 * `empty` is a field, not a gate: the list draws the block on every hub, and
 * whether the hub is empty is the door's condition (`HammerolaLogin` in
 * HammerolaEntry.jsx).
 *
 * `empty === true`, not a truthy test: what arrives need not be the manifest,
 * and reading a stray truthy value as yes would show "nothing published here
 * yet" on a hub with projects.
 *
 * `null` means there is nothing to print: not a manifest, or paths that cannot
 * be printed. `loadStart` answers the same for a hub that never replied.
 */
export function startHint(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  const skill = hubPath(manifest.skill);
  const client = hubPath(manifest.client);
  if (!skill || !client) return null;
  return { skill, client, empty: manifest.empty === true };
}

/**
 * `GET /start`, as both pages read it. IT RESOLVES FOR EVERY FAILURE.
 *
 * Unlike `loadIndex`, this is a hint on top of a screen that works without it,
 * so an unreachable hub, a proxy returning HTML or a document with the wrong
 * fields all end as "no block"; a rejection would put that burden on every
 * call site.
 *
 * No token header: the route is public, and the reader at the door
 * has no token.
 *
 * Only the wire is inside the `try`. `startHint` is pure and throws only on a
 * defect in this bundle, which should surface on the console rather than
 * silently show as "no block".
 */
export async function loadStart() {
  let manifest = null;
  try {
    const response = await fetch(START_URL, { cache: 'no-store' });
    if (!response.ok) return null;
    manifest = await response.json();
  } catch (error) {
    return null;
  }
  return startHint(manifest);
}

// -- comparing two revisions -------------------------------------------------
//
// ui-brief block 9. A comparison is a pair of documents of its own, computed on
// request and published under an address of its own:
//
//     /project/<pid>/<a>/compare/<b>/scene.json?v=<view>   both revisions and
//                                                  the difference between them,
//                                                  in the ordinary shape of a
//                                                  view file           EDIT_TOKEN
//     /project/<pid>/<a>/compare/<b>/report.json?v=<view>  what happened to each
//                                                  part, as numbers    EDIT_TOKEN
//
// A comparison is of one VIEW (`?v=`): the scene is built from the two
// revisions' view documents (`cadbuild/comparescene.py`), and each is cached
// separately. The query is required; without it the hub answers 404.
//
// Both are behind the token, like a build's own STEP, STL and 3MF and unlike its
// meta.json, views and pictures, and they take no key in the link. The report is
// fetched here with the same header `loadIndex` sends; the scene is fetched by
// the viewport (element.js), so the token travels to it in `hmr:state`.
//
// Nothing is precomputed: the pair space is quadratic and nothing is deleted
// (SPEC 5.3). A pair nobody asked about answers 404, and the answer is to queue
// the job and wait — the same queue a build uses, since the geometry is
// measured by a child process with the CAD kernel.

/** Where one comparison's two documents live. */
export const compareBase = (pid, a, b) =>
  `/project/${encodeURIComponent(pid)}/${encodeURIComponent(a)}`
  + `/compare/${encodeURIComponent(b)}/`;

/**
 * The scene of a comparison, in the shape `meta.views` carries a build's.
 *
 * One entry, handed to the viewport as a `views` array of one so the element
 * loads it on the same path as a build (`base + file`); the `?v=` query rides
 * in `file` because the element concatenates.
 *
 * The id carries the view: the element tells a live reload (same view, keep
 * camera and tree states) from a view change (fit afresh) by `view` alone, so a
 * constant id would carry one view's camera onto another. The `compare:` prefix
 * keeps it from colliding with a build's view id, and the page never writes it
 * into `state.view` (`onModel`).
 */
export const compareView = (view) => Object.freeze({
  id: `compare:${view}`,
  file: `scene.json?v=${encodeURIComponent(view)}`,
});

/**
 * The four groups that scene's tree is made of.
 *
 * The payload arrives already coloured — both revisions neutral and translucent,
 * the two difference groups bright and opaque — so the browser paints nothing.
 * What it does with these ids is HIDE by them: `applyHidden` matches a hidden
 * entry against a leaf path by prefix, so one string takes a whole revision off
 * the screen, which is the whole of the Overlay / A-only / B-only control.
 */
export const COMPARE_GROUPS = Object.freeze({
  a: '/cmp/rev a',
  b: '/cmp/rev b',
  removed: '/cmp/removed',
  added: '/cmp/added',
});

/**
 * The three colours the comparison is published in.
 *
 * Written here because the legend has to show them: there is no convention for
 * "added" and "removed" (green is added in GitHub and NX, red in CATIA), so the
 * brief makes a legend mandatory. They are the payload's colours, not palette
 * roles, and do not follow the theme.
 *
 * This file is therefore excused from
 * `test_the_build_page_spends_the_palette_and_writes_no_colour_of_its_own`,
 * like `proposalgeom.js`; do not add other hex values to this module.
 */
export const DIFF_COLOURS = Object.freeze({
  neutral: '#7a8fa6',
  added: '#2a9d5c',
  removed: '#d1495b',
});

// The two job states that end a wait. Spelled as the hub spells them
// (`src/jobs.py`); the two before them — `queued`, `building` — are not named
// here because nothing on this side has anything different to do about them.
export const JOB_DONE = 'done';
export const JOB_FAILED = 'failed';

/**
 * The header every guarded route reads the token from (`TOKEN_HEADER` in
 * `src/app.py`). Not `Authorization`: a browser attaches the HTTP Basic
 * credentials it holds for a password proxy in front of the hub only to a
 * request that does not set `Authorization` itself (the Fetch standard).
 */
const tokenHeader = (token) => (token ? { 'X-Hammerola-Token': token } : {});

/**
 * One request to a guarded route, with a 403 told apart from everything else.
 *
 * Same division as `loadIndex`. The response is returned unparsed because two
 * of the three callers read the status first — a 404 is an answer here.
 */
async function guarded(url, init) {
  const response = await fetch(url, { ...init, cache: 'no-store' });
  if (response.status === 403) throw new Unauthorized(`${url} -> HTTP 403`);
  return response;
}

// -- a guarded route asked for by a page that is already up -------------------
//
// The same contract as `guarded`, answered in SENTENCES rather than
// exceptions: their caller is the build page, whose model is already on
// screen, so a failure becomes one line in front of the reader. The ui suite
// pins the sentences.

/** The hub never answered at all. */
export const HUB_UNREACHABLE = 'Could not reach the hub';

/** It answered 403. Unexported: `hubTrouble` is its only reader. */
const HUB_REFUSED = 'The hub refused the token';

/**
 * One request that reports a dead hub instead of throwing at its caller.
 *
 * `{response}` or `{error}`, never both. Not `guarded`: here the 403 is a
 * sentence and the init goes out as written, except that the token is merged
 * into `headers` — so a caller's `Content-Type` survives and `FormData` goes
 * without one. The header is unconditional; `_authorized` in `src/app.py`
 * refuses an empty token and a missing header alike.
 */
export async function askHub(url, token, init) {
  try {
    return {
      response: await fetch(url, {
        ...init,
        headers: { ...(init && init.headers), 'X-Hammerola-Token': token },
      }),
    };
  } catch (error) {
    return { error };
  }
}

/**
 * What to say about a reply that is not the one asked for; `null` for the one
 * that is.
 *
 * `ok` is a parameter because a POST that creates something answers 201, and
 * `failed` because the sentence is about what the CALLER was doing — "could not
 * load the comments" and "could not delete the proposal" are not one message.
 * The 403 is the only one the hub itself owns, so it is the only one shared.
 */
export const hubTrouble = (response, ok, failed) => {
  if (response.status === ok) return null;
  return response.status === 403 ? HUB_REFUSED : failed;
};

/**
 * The reply's document, or `{error}` where the body would not parse.
 *
 * A separate step because it is a third failure with a third sentence: a 200
 * carrying a proxy's HTML arrived, was not refused, and cannot be read.
 */
export async function hubBody(response) {
  try {
    return { body: await response.json() };
  } catch (error) {
    return { error };
  }
}

/**
 * What a comparison found, or `null` where the hub has not computed one.
 *
 * A 404 is the ordinary state of a pair nobody has asked about yet; the caller
 * answers it by queueing the job.
 */
export async function loadCompareReport(pid, a, b, view, token) {
  const url = `${compareBase(pid, a, b)}report.json?v=${encodeURIComponent(view)}`;
  const response = await guarded(url, { headers: tokenHeader(token) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

/**
 * The hub's own words for a refusal, where it wrote any.
 *
 * Every refusal on this service is `{"error": "..."}` (`app._error`). Some are
 * actionable sentences (e.g. `app.VIEW_NOT_NAMEABLE_ERROR` for a view whose name
 * cannot be a directory segment), so the body is read when there is one and the
 * status is the fallback.
 *
 * Never throws: a body that is not JSON (a proxy's HTML, an empty 502) must not
 * replace the refusal with a parse error.
 */
async function refusal(url, response) {
  try {
    const body = await response.json();
    const said = body && typeof body.error === 'string' ? body.error.trim() : '';
    if (said) return said;
  } catch (error) {
    // Nothing to add: the status below is what this reply amounts to.
  }
  return `${url} -> HTTP ${response.status}`;
}

/**
 * Queue one comparison. Answers the id of the job that will compute it.
 *
 * The view (fourth segment) is what asks for the artefacts; without it the hub
 * only writes the numbers into the job's log, which is what the command-line
 * client wants.
 *
 * A refusal carries the hub's sentence (`refusal`): the panel prints whatever
 * this throws.
 */
export async function startCompare(pid, a, b, view, token) {
  const url = `/api/v1/compare/${encodeURIComponent(pid)}/${encodeURIComponent(a)}`
    + `/${encodeURIComponent(b)}/${encodeURIComponent(view)}`;
  const response = await guarded(url, { method: 'POST', headers: tokenHeader(token) });
  if (!response.ok) throw new Error(await refusal(url, response));
  const body = await response.json();
  const job = body && typeof body.job === 'string' ? body.job : '';
  if (!job) throw new Error(`${url} accepted the comparison and named no job`);
  return job;
}

/** How one queued job is going: `{state, error, ...}` as the hub records it. */
export async function loadJob(id, token) {
  const url = `/api/v1/jobs/${encodeURIComponent(id)}`;
  const response = await guarded(url, { headers: tokenHeader(token) });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

// -- removing a project ------------------------------------------------------
//
// Removes the project WHOLE: every build, both pointers, the comment queue, the
// stored code of each revision and the comparison cache (`_handle_delete` in
// src/app.py). There is no single-build removal: a build's URL is permanent.
//
// Nothing brings it back: no copy, no retention (SPEC 5.3), no undo — which is
// why the page makes the reader type the id.

/**
 * `DELETE /api/v1/projects/<pid>`, with the secret the rest of this file sends.
 *
 * Resolves with nothing: reading the body would turn a proxy's HTML in front of
 * a successful 200 into a reported failure over a project that is gone. The
 * card leaving the list is the report.
 *
 * `Unauthorized` for a refused token, the hub's own sentence (`refusal`) for
 * anything else — a 404 means somebody else already removed it.
 */
export async function deleteProject(pid, token) {
  const url = `/api/v1/projects/${encodeURIComponent(pid)}`;
  const response = await guarded(url, { method: 'DELETE', headers: tokenHeader(token) });
  if (!response.ok) throw new Error(await refusal(url, response));
}

/**
 * What identifies "a different build" under a moving name.
 *
 * Under `latest` the commit changes; the local slot keeps the name `dev` for
 * every build, so there it is the moment the hub accepted the push. Never
 * `built`: it is written by the model's script, optional, and has second
 * resolution at best, so an edit-build-look loop produces ties.
 */
export function buildKey(meta) {
  if (!meta) return null;
  return meta.dev ? meta.published || null : meta.commit || null;
}

// -- the part tree ----------------------------------------------------------
// It arrives on `hmr:model` as `{id, name, color, children?, key?, known?}`
// nested as deep as the model nests — the shape `treeFromShapes` builds from
// the pushed view file; `children` is a group's field and `key`/`known` are a
// leaf's. This is the assembly structure; reading it is a walk.

/** Same ceiling the hub refuses a push over (render.MAX_VIEW_DEPTH). */
const MAX_DEPTH = 64;

/**
 * The catalogue key of a raw LEAF, or `null` for everything else.
 *
 * A group answers `null` whatever it carries: an assembly is not a part, so two
 * adjacent groups are never "the same thing twice" however their keys read.
 *
 * This settles one local question — may two siblings draw as one row — and
 * answers no for groups on its own account. It is not a second enforcement of
 * "a group has no key": `indexTree` reports whatever key the tree carried.
 */
const leafKey = (raw) => (
  raw && typeof raw === 'object' && !Array.isArray(raw.children)
    && typeof raw.key === 'string' && raw.key ? raw.key : null);

/**
 * Two adjacent siblings the tree draws as ONE row: the same part, twice.
 *
 * The key is the identity; the name is not consulted (the tessellator names
 * repeats apart, `pin`, `pin(2)`).
 *
 * `known` must agree too: a row is a promise about what its eye and ghost
 * square act on, and `pin ×5` with two unreachable copies would break it.
 */
const repeats = (a, b) => {
  const key = leafKey(a);
  return key !== null && key === leafKey(b)
    && (a.known !== false) === (b.known !== false);
};

/**
 * Raw siblings grouped into the rows they draw as: a run of repeats is one row.
 *
 * Adjacent only: a view's groups are the author's structure, so two pins in
 * `housing` and one in `fasteners` are `pin ×2` and `pin`.
 */
const runsOf = (children) => {
  const runs = [];
  children.forEach((raw, at) => {
    const run = runs.length ? runs[runs.length - 1] : null;
    if (run && repeats(run[run.length - 1].raw, raw)) run.push({ raw, at });
    else runs.push([{ raw, at }]);
  });
  return runs;
};

/**
 * The viewport's tree, indexed so rows can be rendered and addressed.
 *
 * Returns `{nodes, roots, leaves}`: a Map of PATH -> the row that stands for it,
 * the ids at the top level (the viewport sends one root), and every leaf path in
 * document order. A node carries `leaves`, the ids of the solids underneath it,
 * and that list is what every group-level action is expressed in — hiding a node
 * means hiding ITS LEAVES, never the node id.
 *
 * A row may stand for several solids even when it is not a group: adjacent
 * siblings that are the same part collapse into one row, drawn `pin ×5`. Its
 * `id` is the FIRST of their paths (still unique, still a React key) and
 * `leaves` holds all of them. The count is never stored: it is
 * `leaves.length`.
 *
 * Every one of those paths is a key of `nodes`, all answering with the same
 * row, so a pick in the scene (`/model/pin(2)`) finds its row, and `namesOf`
 * can carry a hidden later copy across a view switch by name. `nodes.size`
 * counts paths, not rows.
 *
 * Hiding sends leaves, not node ids, although the viewport's `covers()` would
 * accept a node prefix: the mixed state (one part under a hidden group shown
 * again) forces leaves anyway, and one rule beats two.
 *
 * `known: false` means the viewport found no such path in the library's state
 * map. The row is still drawn: a missing row reads as a build with fewer parts.
 *
 * `key` is the row's catalogue entry in `meta.parts` (files, note, kind), copied
 * untouched; `id` is the path the viewport operates on. `key` is `null` on a
 * leaf that names none and is never filled in from `name`. Groups arrive
 * without one because `treeFromShapes` assigns it on the leaf branch only (the
 * hub's `check_view_file` allows a key anywhere); this walk enforces nothing
 * and copies what it is given — only a hand-built tree, as in
 * `ui/tests/repeats.test.js`, carries a keyed group. `leafKey` above blanks a
 * group's key for the collapsing decision alone.
 */
export function indexTree(root) {
  const nodes = new Map();
  const roots = [];
  const leaves = [];
  const used = new Set();

  const nameOf = (raw, index) => (typeof raw.name === 'string' && raw.name
    ? raw.name
    : `part ${index + 1}`);

  // The viewport's `id` is the part's path and is what it will name in
  // `hmr:pick` and match `hidden`/`ghost` against, so it is the identity here
  // too. The fallbacks exist only so a malformed tree cannot collapse two rows
  // into one React key. Called EXACTLY ONCE per raw node and in document order,
  // because it claims the name it hands back.
  const pathOf = (raw, index, parent) => {
    let id = typeof raw.id === 'string' && raw.id
      ? raw.id
      : `${parent || ''}/${nameOf(raw, index)}`;
    while (used.has(id)) id = `${id}~${used.size}`;
    used.add(id);
    return id;
  };

  // `run` is one ROW: its own raw node first, then the repeats collapsed into
  // it. Everything but `leaves` is read off the first, which is the one whose
  // path names the row.
  const walk = (run, parent, depth) => {
    const { raw, at: index } = run[0];
    if (!raw || typeof raw !== 'object' || depth > MAX_DEPTH) return null;
    const name = nameOf(raw, index);
    const id = pathOf(raw, index, parent);

    const children = Array.isArray(raw.children) ? raw.children : null;
    const node = {
      id,
      name,
      // The catalogue key, or nothing at all. No fallback: see the note above.
      key: typeof raw.key === 'string' && raw.key ? raw.key : null,
      color: typeof raw.color === 'string' ? raw.color : null,
      isNode: !!children,
      known: raw.known !== false,
      depth,
      parent,
      children: [],
      leaves: [],
    };
    nodes.set(id, node);
    if (parent) nodes.get(parent).children.push(id);
    else roots.push(id);

    if (children) {
      runsOf(children).forEach((kid) => walk(kid, id, depth + 1));
      // A group's leaves are its rows' leaves, end to end.
      node.leaves = node.children.flatMap((cid) => nodes.get(cid).leaves);
    } else {
      node.leaves = run.map(({ raw: r, at }, n) => (
        n === 0 ? id : pathOf(r, at, parent)));
      node.leaves.forEach((path) => {
        nodes.set(path, node);
        leaves.push(path);
      });
    }
    return id;
  };

  walk([{ raw: root, at: 0 }], null, 0);
  return { nodes, roots, leaves };
}

// -- where a comment hangs ---------------------------------------------------
// A comment is bound to the printed entity, whose identity is its catalogue
// key. Not the tree path (the tessellator numbers repeats apart, so a path
// means something else in the next revision), and not the point (the geometry
// moves under it on the next build). When the key leaves the catalogue the
// comment is ORPHANED, and the feed says so rather than dropping the pin.

/**
 * Every catalogue key in a tree, mapped to the row that draws it.
 *
 * First row in tree order wins: `runsOf` collapses adjacent siblings only, so a
 * part placed in two groups draws as two rows. A comment gets one arrow, because
 * pressing it opens one row in the rail.
 */
export function rowsByKey(tree) {
  const rows = new Map();
  if (!tree || !tree.nodes) return rows;
  // `nodes` keys every leaf PATH as well as every row id, so one row arrives
  // several times; the first insertion is the one in tree order.
  for (const node of tree.nodes.values()) {
    if (node.key && !rows.has(node.key)) rows.set(node.key, node);
  }
  return rows;
}

/**
 * Where one stored comment hangs in the build on screen: `{state, path, point}`.
 *
 * `path` is a tree path to hang the pin on and `point` a world coordinate to
 * hang it at; each is null unless the state names it. The six states, each a
 * different sentence for the reader:
 *
 *   `point`     — the record was written on THIS build in THIS view, so the
 *                 coordinate it stored is still a place in the model on screen.
 *                 On any other build the same numbers point at whatever the
 *                 rebuild moved there.
 *
 *                 Which build this is is `published` alone, and an absent stamp
 *                 never matches. Not `commit`: the local slot's commit is the
 *                 constant `dev` (SPEC 7.6), and a revision minted from the
 *                 slot keeps its stamp, so one build is served under `dev` and
 *                 under its hash.
 *
 *   `carried`   — THIS build in ANOTHER view, and the key names a row here. A
 *                 view moves a part and keeps its vertices, so `point` (the
 *                 coordinate as the record's own view placed the part) is still
 *                 a place on it; `sync` carries it through the two placements.
 *                 `path` is the stored one when this view draws it under the
 *                 same key (`nodes`, the tree's map), else the row's first
 *                 instance.
 *   `part`      — the key names a row in the tree on screen. The pin goes on the
 *                 first instance, `leaves[0]` (see `rowsByKey`).
 *   `elsewhere` — the catalogue has the part, but this view does not draw it:
 *                 the comment was left in another view of the same project.
 *   `orphan`    — the key is in no catalogue entry. The entity the comment was
 *                 left on is gone from the model.
 *   `none`      — no key at all (an older record, or one left on nothing in
 *                 particular). Unanchored.
 *
 * `parts` is read through `hasOwnProperty` and never by `parts[key]`: a key is a
 * string the author chose, and `__proto__` is one they may choose.
 */
export function anchorFor(record, { published, view, keyRows, nodes, parts }) {
  const unanchored = { state: 'none', path: null, point: null };
  if (!record || typeof record !== 'object') return unanchored;

  const p = record.point;
  const placed = Array.isArray(p) && p.length === 3
    && p.every((n) => typeof n === 'number' && Number.isFinite(n));
  const build = typeof published === 'string' && published !== ''
    && record.published === published;
  if (build && placed && record.view === view) {
    return { state: 'point', path: null, point: [p[0], p[1], p[2]] };
  }

  const key = typeof record.key === 'string' && record.key ? record.key : null;
  if (!key) return unanchored;

  const row = keyRows ? keyRows.get(key) : null;
  if (row && row.leaves && row.leaves.length) {
    if (build && placed) {
      // The clicked instance when this view draws it under the same key, even
      // in a group the key's first row is not in (`rowsByKey` keeps that row only).
      const own = nodes && record.part ? nodes.get(record.part) : null;
      const path = own && own.key === key ? record.part : row.leaves[0];
      return { state: 'carried', path, point: [p[0], p[1], p[2]] };
    }
    return { state: 'part', path: row.leaves[0], point: null };
  }
  const known = !!parts && Object.prototype.hasOwnProperty.call(parts, key);
  return { state: known ? 'elsewhere' : 'orphan', path: null, point: null };
}

/**
 * Where a view document places one node: `{position, quaternion}` in the
 * world, or null when the document does not draw `path`.
 *
 * The node's `loc` composed with every ancestor's from the root down, as the
 * library nests one group per node and writes `loc` onto each (`renderLoop` in
 * viewer/src/scene/nestedgroup.ts); a node without one stands where its parent
 * does, as the library renders it.
 */
export function placementIn(doc, path) {
  const walk = (node, parent) => {
    if (!node || typeof node !== 'object') return null;
    const loc = Array.isArray(node.loc) ? node.loc : null;
    const offset = loc ? turned(parent.quaternion, loc[0]) : null;
    const here = loc ? {
      position: parent.position.map((v, i) => v + offset[i]),
      quaternion: after(parent.quaternion, loc[1]),
    } : parent;
    if (node.id === path) return here;
    for (const kid of Array.isArray(node.parts) ? node.parts : []) {
      const found = walk(kid, here);
      if (found) return found;
    }
    return null;
  };
  return walk(doc, { position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
}

// -- display helpers --------------------------------------------------------
// Everything below formats a string that came out of a PUSHED meta.json. It is
// rendered as text by React and never as markup, which is the rule every page
// on this site keeps and for the same reason: a build URL is permanent,
// immutable and shares an origin with every other project here.

/**
 * A part's name, and how many copies of it the thing being labelled stands for.
 *
 * `pin ×5` for five, plain `pin` for one — never `pin ×1`, which would put a
 * number on every row in the tree to say nothing. The sign is U+00D7 MULTIPLI-
 * CATION SIGN and not the letter `x`.
 *
 * The count is always passed in, never stored: `leaves.length` on a tree row
 * and its menu, and what the viewport reported it moved for a proposal move.
 */
export const countedName = (name, count) =>
  (count > 1 ? `${name} ×${count}` : String(name));

/** `dev` stays `dev`; a commit is shown at the length people read. */
export const shortId = (commit) =>
  !commit ? '' : (commit === 'dev' ? 'dev' : String(commit).slice(0, 7));

/** An ISO stamp cut to `YYYY-MM-DD HH:MM`, or whatever it was if it is not one. */
export const stamp = (value) => {
  const text = String(value || '');
  return text.length >= 16 && text[10] === 'T'
    ? `${text.slice(0, 10)} ${text.slice(11, 16)}`
    : text.slice(0, 20);
};

export const mb = (bytes) => `${(Number(bytes || 0) / 1e6).toFixed(1)} MB`;
