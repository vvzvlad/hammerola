// What the pages are showing, and the fetches that say what is in them.
//
// Kept out of the components because none of it is React and all of it is the
// hub's contract. The URL scheme is the whole of the addressing (src/app.py):
//
//     /index.json                       what is on this hub -- EDIT_TOKEN, the
//                                       one route on this site that is guarded
//     /project/<pid>/                   the project, on whichever pointer the
//                                       reader was last on (SPEC 9)
//     /project/<pid>/<slot>/            the page, where <slot> is a commit id
//                                       or one of the two moving names
//     /project/<pid>/<slot>/meta.json   this build: title, views, downloads
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
 * A convention rather than a field: `src/cadbuild/views.py` names its default
 * view `assembled`, and every model in the fleet inherits it. It matters because
 * a distance measured BETWEEN two parts only means anything where the parts
 * stand as assembled — on a print bed they have been moved apart on purpose, and
 * a number taken there would reach the agent as a gap that is not a gap (brief,
 * block 7). A model that names its views something else loses the qualifier's
 * precision in the safe direction: every measurement is then labelled as
 * belonging to the current layout.
 */
export const ASSEMBLED_VIEW_ID = 'assembled';

/** Where this page sits, read off its own URL and nothing else.
 *
 * No template variable, no data attribute: the hub renders the same static
 * build.html for every project and every build (src/render.py), so the URL is
 * the only thing that says which one this is. The committed page scripts read
 * theirs the same way.
 */
export const PAGE = (() => {
  const parts = String(location.pathname).split('/');
  return {
    pid: parts[2] || '',
    // HOW the page was reached, which is not the same question as which build
    // answered: on `/latest/` the slot is `latest` and meta.commit is a hash.
    slot: parts[3] || '',
    base: String(location.pathname).replace(/[^/]*$/, ''),
  };
})();

/** True on the two URLs whose content can be rewritten under the reader. */
export const isPointerPage = () => POINTER_NAMES.includes(PAGE.slot);

async function getJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

/** This build, as the hub normalised it at publish time (src/render.py). */
export const loadMeta = (fresh) =>
  getJson(`${PAGE.base}meta.json`, fresh ? { cache: 'no-store' } : undefined);

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
 * One card of `/index.json`, as the front page renders it.
 *
 * The mapping is HERE, in one function, rather than spread through the JSX, and
 * that is what lets `tests/test_ui_source.py` compare the fields read off a card
 * against the keys `render.index_card` actually writes. A field that is not
 * there reads as `undefined`, which renders as an empty string and formats as
 * `NaN` — never as an error.
 *
 * Three of the designer's fields have no line here, and each absence is a fact
 * about the hub rather than an omission:
 *
 *   * a PREVIEW image is block 12 of the brief and is not built yet, so every
 *     card draws the neutral plate. No field is invented to hold one.
 *   * a STATUS (`idle`/`building`/`failed`) cannot be answered at all. A build
 *     job is addressable only by its own id, there is no route that lists jobs,
 *     and job order is stored nowhere — it existed for a retention that no
 *     longer exists (SPEC 5.3, and the docstring of src/jobs.py). So the card
 *     carries no status and the page shows none, rather than showing `idle` for
 *     a project that is rebuilding as you look at it.
 *   * a REVISION NUMBER does not exist. A revision is named by the digest of its
 *     sources (SPEC 7.7), so there is no `v241` to show and there is not going
 *     to be one; the hash is shown at the length the rest of this site reads it.
 *
 * `first` is the one field whose NAME differs from what the mock asked for, and
 * deliberately: the mock wanted a creation date, the hub has the oldest build it
 * holds, and those are different claims — see `render.index_card`.
 */
export function projectCard(card) {
  return {
    pid: card.pid,
    title: card.title || card.project || card.pid,
    slug: card.project,
    meta: `${card.parts} parts · ${card.variants} views · ${card.mb} MB`,
    rev: shortId(card.commit),
    dev: !!card.dev,
    built: card.built,
    first: card.first_built,
  };
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
// It arrives on `hmr:model` as `{id, name, color, children?, known?}` nested as
// deep as the model nests — the shape `treeFromShapes` builds from the pushed
// view file. There is no flat list of nodes anywhere and there is not going to
// be one: this IS the assembly structure, and reading it is a walk.

/** Same ceiling the hub refuses a push over (render.MAX_VIEW_DEPTH). */
const MAX_DEPTH = 64;

/**
 * The viewport's tree, indexed so rows can be rendered and addressed.
 *
 * Returns `{nodes, roots, leaves}`: a Map of id -> node, the ids at the top
 * level (the viewport sends one root), and every leaf id in document order. A
 * node carries `leaves`, the ids of the solids underneath it, and that list is
 * what every group-level action is expressed in — hiding a node means hiding ITS
 * LEAVES, never the node id.
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
 */
export function indexTree(root) {
  const nodes = new Map();
  const roots = [];
  const leaves = [];
  const used = new Set();

  const walk = (raw, index, parent, depth) => {
    if (!raw || typeof raw !== 'object' || depth > MAX_DEPTH) return null;
    const name = typeof raw.name === 'string' && raw.name
      ? raw.name
      : `part ${index + 1}`;
    // The viewport's `id` is the part's path and is what it will name in
    // `hmr:pick` and match `hidden`/`ghost` against, so it is the identity here
    // too. The fallbacks exist only so a malformed tree cannot collapse two rows
    // into one React key.
    let id = typeof raw.id === 'string' && raw.id ? raw.id : `${parent || ''}/${name}`;
    while (used.has(id)) id = `${id}~${used.size}`;
    used.add(id);

    const children = Array.isArray(raw.children) ? raw.children : null;
    const node = {
      id,
      name,
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
      children.forEach((child, at) => walk(child, at, id, depth + 1));
      node.leaves = node.children.flatMap((cid) => {
        const kid = nodes.get(cid);
        return kid.isNode ? kid.leaves : [cid];
      });
    } else {
      node.leaves = [id];
      leaves.push(id);
    }
    return id;
  };

  walk(root, 0, null, 0);
  return { nodes, roots, leaves };
}

// -- display helpers --------------------------------------------------------
// Everything below formats a string that came out of a PUSHED meta.json. It is
// rendered as text by React and never as markup, which is the rule every page
// on this site keeps and for the same reason: a build URL is permanent,
// immutable and shares an origin with every other project here.

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
