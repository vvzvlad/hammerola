// What the pages are showing, and the fetches that say what is in them.
//
// Kept out of the components because none of it is React and all of it is the
// hub's contract. The URL scheme is the whole of the addressing (src/app.py):
//
//     /index.json                       what is on this hub -- EDIT_TOKEN, the
//                                       only one of the routes LISTED HERE that
//                                       is guarded (the comment, job and source
//                                       APIs are guarded too and are not here)
//     /start                            where to get the skill and the client,
//                                       and whether anything is published here
//                                       yet -- PUBLIC. `meta.json` and
//                                       `builds.json` below are asked for
//                                       without a token as well; what is
//                                       special here is that the ANSWER is for
//                                       a reader who has no token at all
//     /project/<pid>/                   the project, on whichever pointer the
//                                       reader was last on (SPEC 9)
//     /project/<pid>/<slot>/            the page, where <slot> is a commit id
//                                       or one of the two moving names
//     /project/<pid>/<slot>/meta.json   this build: title, views, part catalogue
//     /project/<pid>/builds.json        the picker: pointers plus the history
//     /project/<pid>/<slot>/<view file> the geometry, ~2 MB of it
//
// The last of those is NOT fetched here, and that is deliberate: the viewport
// fetches it to render it and hands the tree back on `hmr:model`. Fetching it on
// this side as well would double two megabytes per view switch to re-derive
// something the other half already holds.
//
// Nothing here invents an endpoint. Where a block of the brief has no source on
// the server the component says so on the screen rather than guessing a shape
// the hub might answer with one day.

/** The two moving names. Same list as static/_v/pointer_pref.js. */
export const POINTER_NAMES = ['latest', 'dev'];

/**
 * The id of the view a model is assembled in.
 *
 * A constant shared with the build half, where it is spelled in
 * `src/cadbuild/artifacts.py` as `ASSEMBLED_VIEW_ID`. No model INHERITS it:
 * `views.prepare_views` refuses a model that declares no view under this id, so
 * every build that reaches this hub has one. It matters because a distance
 * measured BETWEEN two parts only means anything where the parts stand as
 * assembled — on a print bed they have been moved apart on purpose, and a
 * number taken there would reach the agent as a gap that is not a gap (brief,
 * block 7). A rename on the build side would leave every CROSS-PART measurement
 * here labelled as belonging to the current layout instead — the safe
 * direction, and silent; a single-part measurement carries `crossPart: false`
 * and is never labelled either way. The two spellings are checked against each
 * other by `tests/test_ui_source.py`, which is the only place that can: neither
 * runtime can import the other's constant.
 */
export const ASSEMBLED_VIEW_ID = 'assembled';

/** The three fields, read off one pathname. Pure, and the ONLY place that
 *  arithmetic is written — `PAGE` below and `rereadPage` after it are two
 *  moments, not two rules, and a second copy of the slicing is how they would
 *  come to disagree about what `/project/x/dev/` means. */
function pageFrom(pathname) {
  const parts = String(pathname).split('/');
  return {
    pid: parts[2] || '',
    // HOW the page was reached, which is not the same question as which build
    // answered: on `/latest/` the slot is `latest` and meta.commit is a hash.
    slot: parts[3] || '',
    base: String(pathname).replace(/[^/]*$/, ''),
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
 * Switching revisions is a `history.pushState` rather than a navigation
 * (issue #62): the address still has to say which geometry is on screen, but
 * throwing the document away to change it costs the reader the camera, the
 * hidden parts and the section — everything they set up in order to compare two
 * builds. What survives that is exactly what this function exists for: nothing
 * re-derives `PAGE` on its own, so after a push every reader of `PAGE.base`
 * would go on fetching the revision that was on screen a moment ago.
 *
 * `Object.assign` ONTO THE SAME OBJECT and not a reassignment, because every
 * module here imported the object itself and reads it as data — `PAGE.base` in
 * a template string, `PAGE.slot` in a comparison. Rebinding the export would
 * leave each of those pointing at the old record; a function would mean editing
 * a dozen call sites into `PAGE().base` for no gain.
 *
 * The argument is for tests and for a caller that knows the path before the
 * browser does; with none, the browser's own URL is the answer, which is the
 * whole definition of this record.
 */
export function rereadPage(pathname) {
  return Object.assign(
    PAGE, pageFrom(pathname === undefined ? location.pathname : pathname));
}

/** True on the two URLs whose content can be rewritten under the reader. */
export const isPointerPage = () => POINTER_NAMES.includes(PAGE.slot);

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

/** The build picker: `{pid, project, title, has_dev, latest, builds[]}`. */
export const loadBuilds = () => getJson(`/project/${PAGE.pid}/builds.json`);

// -- the front page ---------------------------------------------------------

/** The hub said no. Distinguished from every other failure by the caller. */
export class Unauthorized extends Error {}

/**
 * Every project's card, as `Store._refresh_index` wrote them — BEHIND THE TOKEN.
 *
 * This is the one route the front page needs and the only document on the
 * service that enumerates what exists, so it is guarded while a build page is
 * not (src/app.py says why at length). Which makes this function the whole of
 * the front page's access control AND its sign-in check: there is no separate
 * "is this token good" endpoint to ask, because the answer to that question and
 * the answer to "what may I see" are the same response.
 *
 * A 401 is raised apart from everything else. "The token is wrong" and "the hub
 * is unreachable" lead to different screens and different words, and collapsing
 * them tells somebody to retype a token that was fine.
 */
export async function loadIndex(token) {
  const response = await fetch('/index.json', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    cache: 'no-store',
  });
  if (response.status === 401) throw new Unauthorized('/index.json -> HTTP 401');
  if (!response.ok) throw new Error(`/index.json -> HTTP ${response.status}`);
  return response.json();
}

/**
 * A card's link: THE PROJECT, and never one of its pointers.
 *
 * A card means "open this model", and the URL naming no pointer is the one that
 * opens whichever of `latest` and `dev` this reader was last on (SPEC 9).
 * Linking straight at `latest` here would quietly overwrite that memory on every
 * visit to the front page — which is the route somebody browsing their own
 * projects takes most.
 */
export const projectUrl = (pid) => `/project/${encodeURIComponent(pid)}/`;

/**
 * One FILE of one build, by the name that build declared for it.
 *
 * The commit and not a pointer, because the card already names the commit it was
 * built from: a picture fetched from `latest` could be a different build's the
 * moment somebody publishes while the list is open, and it would be a picture of
 * something other than what the card says.
 *
 * All three parts are escaped. A pid is a hex id and a commit is a digest today,
 * but the file name comes out of a build — the model chooses it — and a name is
 * a path segment here, not a path.
 */
export const buildFileUrl = (pid, commit, file) => (
  `/project/${encodeURIComponent(pid)}/${encodeURIComponent(commit)}`
  + `/${encodeURIComponent(file)}`);

/**
 * One card of `/index.json`, as the front page renders it.
 *
 * The mapping is HERE, in one function, rather than spread through the JSX, and
 * that is what lets `tests/test_ui_source.py` compare the fields read off a card
 * against the keys `render.index_card` actually writes. A field that is not
 * there reads as `undefined`, which renders as an empty string and formats as
 * `NaN` — never as an error.
 *
 * A PREVIEW IS ANSWERED NOW (issue #34), and by a picture that was there all
 * along: every build renders a sheet per whole-view mesh and declares it on the
 * view it is of, so `render.index_card` puts the first such name on the card and
 * this line turns it into a URL under that build. THE PLATE IS STILL THE ANSWER
 * for a card whose build has no picture — an image with no rendering stack ships
 * no PNGs — and `null` is what says so, rather than a URL that would 404.
 *
 * One of the designer's fields still has no line here, and the absence is a fact
 * about the hub rather than an omission: a REVISION NUMBER does not exist. A
 * revision is named by the digest of its sources (SPEC 7.7), so there is no
 * `v241` to show and there is not going to be one; the hash is shown at the
 * length the rest of this site reads it.
 *
 * `status` IS ANSWERED, AND ABOUT THE DRAFT ONLY (issue #32). It is one of
 * `idle`/`building`/`failed`, and what it describes is the last build pushed AS
 * A DRAFT — not "the last build in the `dev` slot", which a commit answers too
 * since it mirrors itself in there (issue #78). The hub records that job's id
 * when the build STARTS, and `/index.json` maps its live state onto the word per
 * request (`_serve_index_json` in src/app.py, `render.card_status`). So a draft
 * that is building says so while it builds, and one that failed keeps saying so
 * until the next draft push or until a commit replaces what is in the slot — a
 * restart included, because a job left in flight by a crash is failed at the
 * next start rather than left building for ever.
 *
 * WHAT IT DOES NOT ANSWER is a COMMIT build in flight, and that is deliberate
 * rather than pending: the card describes what has been published from a commit
 * (SPEC 7.6), and a chip saying a commit build is running would be the front
 * page reporting on work that has published nothing. A project whose only build
 * is local has no card at all, so it shows no status either.
 *
 * `first` is the one field whose NAME differs from what the mock asked for, and
 * deliberately: the mock wanted a creation date, the hub has the oldest build it
 * holds, and those are different claims — see `render.index_card`.
 *
 * `printables` IS COUNTED AND NAMED, and the word on the card changed with the
 * field (issue #75). It used to read `card.parts`, which was the part count of
 * the biggest view; the catalogue's `parts` is now every part a build declares
 * — the bought screws and the scenery included — so a card built from its size
 * would tell somebody a three-part model with nine screws had twelve parts to
 * print. The hub therefore counts the printable records and calls the field
 * `printables`, and this line says the same word rather than a friendlier one:
 * "parts" over a number that counts only what gets printed is the very
 * mismatch the rename exists to end.
 */
export function projectCard(card) {
  return {
    pid: card.pid,
    title: card.title || card.project || card.pid,
    slug: card.project,
    meta: `${card.printables} printables · ${card.views} views · ${card.mb} MB`,
    rev: shortId(card.commit),
    dev: !!card.dev,
    status: card.status,
    built: card.built,
    first: card.first_built,
    preview: card.preview
      ? buildFileUrl(card.pid, card.commit, card.preview)
      : null,
  };
}

// -- getting started --------------------------------------------------------
// The route whose ANSWER is meant for somebody who has no token at all, because
// whoever needs it has not got one yet (src/onboarding.py). It carries six keys
// — three relative paths, two version numbers and one boolean about this
// deployment; `onboarding.manifest` is where they are written and
// tests/test_onboarding.py is what pins the set, so this list is a summary and
// not the source. This file reads the boolean and two of the paths, and the
// door renders a block out of them when the boolean says the hub is empty.

const START_URL = '/start';

/**
 * This hub's address, as the browser has it — read, never written down.
 *
 * The block the door draws is a set of addresses somebody hands to an agent, and
 * the hub's own is one of them. It cannot come from a constant: this repository
 * carries the address of no deployment (AGENTS.md), the same rule the skill is
 * held to (`test_the_skill_names_no_deployment`), and a page served BY the hub
 * already knows where it is.
 *
 * Called at the moment the answer is stored rather than read at module scope,
 * because this bundle also serves the build page, which draws no block.
 */
export const hubOrigin = () => String(window.location.origin || '');

/**
 * A path the block can print, or '' for anything else.
 *
 * ROBUSTNESS, NOT A GUARD, and the distinction is the whole of why this is two
 * lines. There is no boundary here to defend: `/start` is served by the SAME hub
 * that served this page and this bundle, so a hub inclined to send an agent
 * somewhere else writes the address into the HTML and never touches its own
 * manifest — and anyone who could rewrite the manifest in flight is rewriting
 * the page and the script on the same connection. Checking this field against
 * the hub that supplied it would be a door standing in an open field.
 *
 * What it IS for is a manifest that is no good for ordinary reasons: a broken
 * image, a proxy answering HTML, a route that grew a field of another type. A
 * line reading `Skill: undefined` helps nobody, so a field that is not a string
 * beginning with `/` takes the whole block down instead (`startHint`).
 */
function hubPath(value) {
  if (typeof value !== 'string') return '';
  if (value[0] !== '/') return '';
  return value;
}

/**
 * What the door may offer out of a `/start` document — or nothing at all.
 *
 * `empty !== true` and not a falsy test, because what arrives here need not be
 * the manifest at all — a string, a number, a missing key and an object are all
 * "truthy-ish" answers to a question that has exactly one affirmative, and the
 * cost of reading one of them as yes is a "nothing published here yet" block on
 * a hub with forty projects. A hub with projects on it and
 * a document this cannot read are the same answer here — `null`, meaning no
 * block — and collapsing them is deliberate: the block is a hint, and there is
 * nothing a reader of the door could do about either.
 */
export function startHint(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  if (manifest.empty !== true) return null;
  const skill = hubPath(manifest.skill);
  const client = hubPath(manifest.client);
  if (!skill || !client) return null;
  return { skill, client };
}

/**
 * `GET /start`, as the door reads it. IT RESOLVES FOR EVERY FAILURE.
 *
 * The one function here that answers `null` instead of throwing, and the
 * asymmetry with `loadIndex` beside it is the whole point. That fetch IS the
 * page — a refusal is what the reader came to see. This one is a hint on top of
 * a form that works without it, so a hub that did not answer, a proxy that
 * returned HTML and a document with the wrong fields must all end as "no block"
 * and nothing else. A rejected promise would put that obligation on every call
 * site instead, and the failure of forgetting it is a sign-in page taken down by
 * an unhandled rejection over a decoration.
 *
 * No `Authorization` header, deliberately: the route is public and the reader of
 * it has no token — sending one would make the block's arrival depend on the
 * very thing it exists to help somebody get.
 *
 * ONLY THE WIRE IS INSIDE THE `try`, and `startHint` is deliberately after it.
 * What the promise above is for is somebody ELSE's failure — an unreachable hub,
 * a captive portal answering HTML — and `startHint` is neither: it is pure, it
 * touches nothing outside its argument, and the only way it throws is a defect
 * in this bundle. Under the wider `try` such a defect showed as "no block" on
 * every hub forever, with nothing anywhere saying so; outside it, it is a stack
 * trace on the console of the person who wrote it. Silence is the contract for
 * the network, never for this file.
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

/**
 * What identifies "a different build" under a moving name.
 *
 * The rule differs between the two names on
 * purpose: under `latest` the commit changes, while the local slot keeps the
 * name `dev` for every build it ever holds, so there the answer is the moment
 * the hub accepted the push. Never `built` — that one is written by the model's
 * own script, is optional, and has second resolution at best, so an
 * edit-build-look loop produces ties.
 */
export function buildKey(meta) {
  if (!meta) return null;
  return meta.dev ? meta.published || null : meta.commit || null;
}

// -- the part tree ----------------------------------------------------------
// It arrives on `hmr:model` as `{id, name, color, children?, key?, known?}`
// nested as deep as the model nests — the shape `treeFromShapes` builds from
// the pushed view file; `children` is a group's own field and `key`/`known` are
// a leaf's. There is no flat list of nodes anywhere and there is not going to
// be one: this IS the assembly structure, and reading it is a walk.

/** Same ceiling the hub refuses a push over (render.MAX_VIEW_DEPTH). */
const MAX_DEPTH = 64;

/**
 * The catalogue key of a raw LEAF, or `null` for everything else.
 *
 * A group answers `null` whatever it carries: an assembly is not a part, so two
 * adjacent groups are never "the same thing twice" however their keys read.
 *
 * THIS IS NOT "a group has no key" BEING ENFORCED A SECOND TIME, and `indexTree`
 * below explains why the two must not be collapsed into one. The key that walk
 * reports outward is whatever THE TREE IT WAS HANDED carried, untouched — which
 * is not the same as what the view file carried, since `treeFromShapes` never
 * puts one on a group on the way here. This function settles ONE local question
 * — may these two siblings draw as one row — and answers it `no` for groups on
 * its own account, rather than by disbelieving what it was given.
 */
const leafKey = (raw) => (
  raw && typeof raw === 'object' && !Array.isArray(raw.children)
    && typeof raw.key === 'string' && raw.key ? raw.key : null);

/**
 * Two adjacent siblings the tree draws as ONE row: the same part, twice.
 *
 * THE KEY IS THE IDENTITY and the name is not consulted at all — the
 * tessellator names the repeats apart (`pin`, `pin(2)`) precisely so the paths
 * stay unique, so a comparison of names would find no repeats anywhere.
 *
 * `known` HAS TO AGREE, and that is the one thing here beyond "same key". A row
 * is a promise about what its eye and its ghost square act on, and `known` is
 * exactly the flag `treeFromShapes` sets false on a leaf "nothing can be done
 * to"; a row saying `pin ×5` while two of the five are unreachable would break
 * that promise silently. Kept apart, each row means what `known` has always
 * meant on this side — the `?` drawn against it in the meta column — and
 * neither row lies about its count.
 */
const repeats = (a, b) => {
  const key = leafKey(a);
  return key !== null && key === leafKey(b)
    && (a.known !== false) === (b.known !== false);
};

/**
 * Raw siblings grouped into the rows they draw as: a run of repeats is one row.
 *
 * ADJACENT ONLY, and that is a decision rather than a shortcut (issue #75). A
 * view's groups are the author's own structure, so two pins in `housing` and one
 * in `fasteners` are `pin ×2` in the first and `pin` in the second — pulling
 * them into a single row would answer a question about the whole build in a
 * place that is describing one group.
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
 * A ROW MAY STAND FOR SEVERAL SOLIDS EVEN WHEN IT IS NOT A GROUP (issue #75):
 * adjacent siblings that are the same part collapse into one row, drawn `pin
 * ×5`. Its `id` is the FIRST of their paths — so it is still a path, still
 * unique and still a usable React key — and `leaves` holds all of them, which is
 * exactly the list hiding, ghosting and isolating were already written in. THE
 * COUNT IS NEVER STORED: it is `leaves.length`, computed where it is drawn, so
 * there is no second number that can disagree with the assembly.
 *
 * EVERY ONE OF THOSE PATHS IS A KEY OF `nodes`, all of them answering with the
 * same row. That is what lets a pick or a right-click in the SCENE — which names
 * the solid the reader hit, `/model/pin(2)` and not the row — find the row it
 * belongs to. IT IS ALSO WHAT CARRIES A HIDDEN PART ACROSS A SWITCH, and the two
 * halves of that are worth naming apart, because only one of them reads a path.
 * `namesOf` is the one that does: it walks the hidden ids through this map, so a
 * later copy answers with its row's name whether or not the run's FIRST path is
 * on the list — hiding is expressed in leaves, so `['/model/pin(2)']` on its own
 * is an ordinary state, and without every path being a key it would carry no
 * name at all. `rejoin` is handed those NAMES and never a path; what it walks is
 * `leaves`, through this same map, to turn each name back into every id the new
 * tree spells it under. `nodes.size` therefore counts paths and not rows, which
 * is what it counted before this collapsing existed.
 *
 * That last part is a decision worth a sentence, because the viewport supports
 * BOTH: its `covers()` matches a hidden entry against a leaf path by prefix, so
 * a node id would hide the whole subtree in one string. Leaves are sent anyway
 * because the mixed state forces it either way — the moment one part under a
 * hidden group is shown again, the group id has to come out and its siblings go
 * in — and a rule that is sometimes leaves and sometimes nodes is two rules. The
 * cost is a longer array; the prefix machinery on the other side still handles
 * it, since a leaf path covers itself.
 *
 * `known: false` on a leaf means the viewport found no such path in the
 * library's own state map. Such a row is still drawn, deliberately: a tree
 * missing a row reads as a build with fewer parts, while a row marked unknown
 * reads as what it is.
 *
 * `key` IS THE OTHER NAME A ROW HAS, and it is carried through untouched from
 * the view file (`treeFromShapes` says why the two exist). `id` is the path the
 * viewport operates on; `key` is the entry in `meta.parts` — the files, the
 * note, the kind. It is `null` on a leaf that names none, and it is NEVER
 * filled in from `name`: guessing the identity out of a string is exactly what
 * the catalogue replaced (issue #75).
 *
 * A GROUP HAS NONE EITHER, and that is `treeFromShapes`'s doing rather than
 * this walk's: it assigns `key` on the leaf branch alone — a group row is
 * returned on the branch above that line — so a group reaches here carrying no
 * such field at all, whatever the view file wrote on it. Over there that is
 * stated as a RULE, and it is the rule that actually holds, because the hub
 * does not enforce it (`check_view_file` declares a key wherever it sits, in
 * its own words): the browser is where a keyed group stops.
 *
 * THIS FIELD ENFORCES NOTHING AND COPIES WHAT IT IS GIVEN — a second copy of
 * the rule here would be this side quietly disagreeing with the document it was
 * handed. That is not the same as saying a pushed group's key is carried out
 * untouched: no such key ever arrives, because the storey above never put one on.
 * The only way to hand this walk a keyed group is to build the tree BY HAND,
 * which is what `ui/tests/repeats.test.js` does. TWO PLACES DECIDE where a key
 * may sit, not one — `check_view_file` on the way in, which permits it
 * anywhere, and `treeFromShapes` on the way to the screen, which does not — and
 * the second of them is on this side of the wire.
 *
 * `leafKey` ABOVE READS LIKE THAT SECOND COPY AND ANSWERS A DIFFERENT QUESTION,
 * which is why both stand and neither is the other's bug to fix. It blanks a
 * group's key for the COLLAPSING DECISION ALONE — are these two siblings one
 * thing twice — and an assembly is never that, whatever key it arrives
 * carrying, so two keyed groups stay two rows (`repeats`, pinned by a test in
 * ui/tests/repeats.test.js). That says nothing about what a row REPORTS: `key`
 * here is still whatever the tree carried, group or leaf. Reporting is where
 * this walk defers to what it was handed; collapsing is a judgement it has to
 * make itself.
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
      // One reading for both kinds of child, now that a leaf row carries every
      // path it stands for: a group's leaves are its rows' leaves, end to end.
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
 * THE COUNT IS ALWAYS PASSED IN, never stored beside a name: on a tree row and
 * on that row's context menu it is `leaves.length` off the row, and on the
 * moved chip it is what the viewport reported it actually moved. A `qty`
 * written down anywhere is a number that can disagree with the assembly, which
 * is the whole reason this is derived (issue #75).
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

// There used to be a `day()` beside `stamp` — the date alone, "for a list where
// the time is noise". Its one caller was the revision picker, and the premise
// stopped holding when publishing moved from CI to `hammerola build`: an author
// runs that as often as they save, so a build list without a clock is a column
// of identical dates. It is taken out rather than left unused, because an
// exported helper reads as one somebody should be reaching for.

export const mb = (bytes) => `${(Number(bytes || 0) / 1e6).toFixed(1)} MB`;
