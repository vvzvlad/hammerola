// Everything these pages remember in the browser, and nothing else.
//
// Six things are kept, all under the `hammerola.` prefix the rest of the site
// already uses — `hammerola.pointing_device`, the viewport's own answer
// (viewport/options.js). FIVE OF THEM LIVE IN `localStorage` AND ONE IN A
// COOKIE, and the odd one out is the theme: it is the only remembered answer the
// SERVER has to know, because the page has to arrive already painted in it (the
// section at the foot of this file has the whole argument). Everything else here
// is nobody's business but this browser's, and a cookie would only put it on
// every request for nothing.
//
// Two of the FIVE IN `localStorage` are keyed BY PROJECT for the reason
// pointer_pref.js gives about its own key: somebody editing one model and merely
// looking at another must not have the two answers collide. The count is of
// those five and not of all six, because the theme is not in the arithmetic at
// all: it is one answer for the browser, the server reads it, and there is no
// project in a cookie to key it by. The token is one of the other three, and
// the section below says why that changed; the
// arrangement of the project list is another, and it never could be — the page
// that has it names no project; the tab strip is the third, and it is the one
// thing here that is ABOUT several projects at once, so no single project could
// have keyed it either.
//
// EVERY access goes through the two functions at the top, and the cookie's two
// at the bottom. `localStorage` is not a property that is always there — a
// private window, a browser set to block site data, and an iframe with
// third-party storage blocked all THROW on the getter itself rather than
// returning null — and an uncaught throw here happens during render, which takes
// the whole interface down over a preference. `document.cookie` is the same
// shape of hazard: it is an accessor, a sandboxed frame throws on it, and a
// browser that refuses the write simply reads back what was there before.
// `tests/test_ui_source.py` holds both to one site per side and to a `try`
// around every access.

import { POINTER_NAMES } from './hub.js';

const NS = 'hammerola.';

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    // Nothing was remembered. That is a complete answer, not a failure worth
    // showing anyone.
    console.warn('storage', error);
    return null;
  }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (error) {
    // The page works exactly as before; only the memory is lost.
    console.warn('storage', error);
  }
}

// -- the token --------------------------------------------------------------
// What separates the customer from the viewer (brief, "Что разделяет заказчика
// и зрителя"). The person types it in; having it opens edits and comments, not
// having it leaves the interface to look with.
//
// ONE KEY FOR THE WHOLE SITE, and that is a fact about the hub rather than a
// preference expressed here. Step 0 collapsed the hub's two secrets into a
// single `EDIT_TOKEN` (issue #26), so there is exactly one string a
// person can be holding, and the same value is what `hammerola login` stores on
// a laptop. This file used to key it per project — written while the shape of
// the human token was still undecided and deferred to step 0 — and that had two
// costs the moment step 0 answered: it stored N copies of one string, and it
// made a front page with a sign-in unwritable, because `/` names no project and
// so had no key to read or write. It is still a KEY rather than an account: not
// tied to a person, revoked by changing it on the hub, removable here in one
// click.
//
// Verification is not done here and could not be: the only thing that can say
// whether a token is good is the hub. The front page writes this key only after
// `loadIndex` has answered with a list, and clears it when that answers 401
// (HammerolaEntry.open). This module's whole job is remembering.

const TOKEN_KEY = `${NS}token`;

export const readToken = () => read(TOKEN_KEY) || null;

export function writeToken(value) {
  const trimmed = String(value || '').trim();
  write(TOKEN_KEY, trimmed || null);
}

export const clearToken = () => write(TOKEN_KEY, null);

// -- notes ------------------------------------------------------------------
// A note is a PROPERTY OF A PART and belongs to the project, not to a build and
// not to a browser (brief, block 5) — "3.2 mm wall, printer minimum, leave it"
// is true before a rebuild and after one. There is no endpoint for it, so it is
// kept here and the editor says so on the screen. Keyed by the CATALOGUE KEY —
// the identity `meta.parts` is keyed by, which the build declares and the view
// file repeats on every leaf (issue #75). It used to be keyed by the row's
// NAME, on the argument that a name survives a rebuild while an id does not;
// the key survives one too, and it is the same string in the print view as in
// the assembled one, where a name is not: the tessellator tells two instances
// of one part apart by calling them `pin` and `pin(2)`. Notes written under the
// old naming are simply not found any more. That is accepted rather than
// migrated, and it must not be papered over by looking the name up as well —
// the name lookup is precisely the guessed identity this change removes.

const notesKey = (pid) => `${NS}notes.${pid}`;

export function readNotes(pid) {
  const raw = pid ? read(notesKey(pid)) : null;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    // Written by an older version of this page, or edited by hand. Starting
    // empty loses notes; throwing loses the interface.
    console.warn('notes', error);
    return {};
  }
}

export function writeNotes(pid, notes) {
  if (!pid) return;
  write(notesKey(pid), JSON.stringify(notes || {}));
}

// -- which pointer this project was last opened on ---------------------------
// `latest` or `dev`, per project, so that /project/<pid>/ — the URL naming no
// pointer — opens whichever of the two the reader was last on (SPEC 9).
// Somebody editing a model lives in `dev` and should not have to say so on every
// visit.
//
// THIS SIDE ONLY WRITES IT. The reader is the resolver page, which imports
// `static/_v/pointer_pref.js` directly and must not pull this bundle, so the two
// halves cannot share a module and the key is spelled in both files; the check
// that they still agree is `tests/test_pointer_memory.py`. The rule that makes
// the arrangement safe is that a URL naming a pointer ALWAYS wins over the
// remembered one — the pointer pages record and never act, the pointer-less URL
// acts and never records.
//
// RECORDED ON ARRIVAL, not when a picker is clicked, which is what makes the
// memory follow what the reader ACTUALLY looked at: reaching /dev/ by the build
// picker, by a pasted link or by the back button is the same fact, and all three
// land on a page load of the interface.
//
// A PINNED COMMIT RECORDS NOTHING, hence the guard on the caller's side as well
// as the one below. Writing a commit id here would be remembering a build rather
// than a pointer, and the resolver — which only ever compares against the two
// moving names — would read it as nothing and quietly send every later visit to
// `latest`.

const pointerKey = (pid) => `${NS}pointer.${pid}`;

export function rememberPointer(pid, name) {
  if (!pid || !POINTER_NAMES.includes(name)) return;
  write(pointerKey(pid), name);
}

// -- how the project list is arranged ----------------------------------------
// Which way the front page draws its projects — tiles or rows — and what order
// they are in. Both were state of the component until now, which meant they were
// re-chosen on every visit: a reader who works from the dense list by name got
// tiles by last-built again on the next page load, with nothing to say why.
//
// ONE KEY EACH FOR THE WHOLE SITE, and here that is not even a choice. A hub has
// ONE list of projects, on the page at `/`, and that URL names no project to key
// anything by — the same fact that took the per-project key off the token above.
// Per BROWSER rather than per anything else, like the one pointing device this
// browser has — `hammerola.pointing_device`, read and written in
// viewport/wheel.js, and not the per-project `pointer.<pid>` above: it is a
// property of the person in front of the screen, and somebody who asked for
// rows meant rows on the next model too.
//
// TWO KEYS RATHER THAN ONE JSON OBJECT, so that a value nobody can read costs
// only itself. Together they would be one cell to parse, and a cell that fails
// to parse takes both answers with it; apart, an unreadable view still leaves
// the remembered order standing.
//
// WHAT COMES BACK IS CHECKED AGAINST A LIST, never trusted. Storage holds
// whatever any version of this page ever wrote there, plus whatever anything
// else on this origin wrote, plus whatever was typed into a browser's storage
// inspector — so an id that no longer exists is an ordinary arrival rather than
// an attack. An unknown one is answered with `null`, which reads as "nothing was
// remembered", and the page then draws its own default.
//
// THIS CHECK IS THE ONLY ONE ON THAT PATH, and it is worth being exact about
// why, because the page has no runtime fallback behind it. The four tables in
// HammerolaEntry.jsx are looked up directly — the `||` that used to sit there
// could not fire, since the only way the page reaches an id the tables lack is a
// DEFAULT naming one, and the fallback re-read that same key.
//
// WHAT MAKES THOSE LOOKUPS TOTAL IS NOT THAT A MISS WOULD BE LOUD. Only half of
// one is: `VIEW_BODIES[unknown]` is `undefined` and throws where the page calls
// it, while `SORT_CMP[unknown]` is `undefined` handed to
// `Array.prototype.sort`, which is a legal call that compares rows by their
// string conversion — every row equal, arrival order kept, nothing thrown, the
// list looking sorted. Totality is held at the ends instead: this function
// filters everything a reader's storage can contribute, `choose()` filters
// everything a caller can, and `ui/tests/vocabulary.test.js` holds the four key
// sets equal to the two lists here and pins `defaultProps` to them. So
// everything the code contributes is checked at build time, and nothing else
// reaches a lookup unfiltered.
//
// THE DEFAULT IS NOT HERE, deliberately. This module remembers; what the page
// opens on when nothing was remembered is the page's own statement
// (`HammerolaProjects.defaultProps`), and a second copy of it here would make
// "which default won" a question with two answers.

const VIEW_KEY = `${NS}projects_view`;
const SORT_KEY = `${NS}projects_sort`;

// FROZEN, and these two matter more than the four tables in HammerolaEntry.jsx
// that are frozen for symmetry. Those are the ANSWERS — an extra key in one is
// an entry nothing looks up. These are the QUESTIONS: they are the filter every
// stored value and every caller's patch is checked against, AND the list the
// tabs are drawn from, so `PROJECT_VIEWS.push('kanban')` from anywhere on the
// page mints a tab, lets `choose` accept it, lets storage keep it, and then
// hands `VIEW_BODIES[…]` an id it has never had.

/** The two ways the list is drawn, in the order the switch offers them. */
export const PROJECT_VIEWS = Object.freeze(['grid', 'list']);

/** The orders it can be in — exactly the ids `sorted()` has a comparator for. */
export const PROJECT_SORTS = Object.freeze(['name', 'modified', 'first']);

const recall = (key, known) => {
  const saved = read(key);
  return known.includes(saved) ? saved : null;
};

// Refused rather than corrected, which is what `rememberPointer` above does with
// a name it does not know and for the same reason: what was remembered is a real
// answer somebody gave, and overwriting it with a default would lose it to a
// caller's typo. The read side is where an unknown value stops mattering.
const remember = (key, known, value) => {
  if (known.includes(value)) write(key, value);
};

export const readProjectView = () => recall(VIEW_KEY, PROJECT_VIEWS);
export const readProjectSort = () => recall(SORT_KEY, PROJECT_SORTS);
export const writeProjectView = (value) => remember(VIEW_KEY, PROJECT_VIEWS, value);
export const writeProjectSort = (value) => remember(SORT_KEY, PROJECT_SORTS, value);

// -- the strip of projects this browser has been in --------------------------
// A LIST OF LINKS BESIDE THE ADDRESS, and that sentence is the whole design
// (issue #45). An entry is a link at `/project/<pid>/` — the pointer-less URL
// `projectUrl` builds — and nothing more. WHICH ONE IS ACTIVE IS NOT STORED,
// because it is not a fact about this browser: it is the pid in the address the
// reader is standing on. One remembered field fewer, and nothing that can fall
// out of step with the URL bar.
//
// A TAB IS A PROJECT AND NOT A BUILD, for the same reason a card on the front
// page is (`projectUrl` says it at length): the URL naming no pointer opens
// whichever of `latest` and `dev` this reader was last on, and linking straight
// at one would overwrite that memory from the strip on every click.
//
// ONE KEY FOR THE WHOLE SITE, like the arrangement above and for a related but
// not identical reason. That one has no project to key it by at all; this one is
// ABOUT several projects at once, so keying it by any of them would store N
// copies of a list that only means anything whole.
//
// TWO DIFFERENT ORDERS, AND THEY HAVE TO STAY DIFFERENT. POSITION is the order
// of OPENING: an arrival is appended at the end and stays where it is for as
// long as it is remembered, because a strip that re-sorted itself by recency
// would move a link out from under a reader already aiming at it. EVICTION is by
// LAST VISIT: at the cap the entry nobody has opened for longest goes, silently.
// Dropping the leftmost instead — which is what "oldest" reads as when the two
// orders are collapsed into one — would evict the project somebody returns to
// every day and therefore opened first.
//
// THIS IS THE FIRST LIST THIS MODULE STORES, and that raises a question none of
// the scalars above had to answer: what to do with ONE BAD ELEMENT among good
// ones. A scalar has a ready answer — `recall` reads a value it cannot use as
// "nothing was remembered" — and the decision here is that same policy applied
// PER ELEMENT: the unusable entries are dropped and the rest kept. It is the
// least destructive reading available, and that is the argument for it. Storage
// holds whatever any version of this page ever wrote, plus whatever was typed
// into a browser's storage inspector, so one hand-edited entry is an ordinary
// arrival rather than an attack — and it must not cost a reader the nine good
// tabs standing beside it. Refusing the whole cell, which is what `readNotes`
// does with a map it cannot read, would do exactly that. The cell as a whole is
// still all-or-nothing where it has to be: text that will not parse, and a value
// that is not an array, name no elements to keep.
//
// AN ENTRY IS THREE FIELDS AND THERE IS NO FOURTH: the pid, which is the link; a
// title, because a strip of ids is a strip nobody can read; and the stamp of the
// last visit, which is the only input the eviction has. Anything else found in a
// stored entry is dropped on the way in rather than carried forward.

const TABS_KEY = `${NS}tabs`;

/** How many the strip holds. The eleventh arrival evicts the coldest entry. */
export const TAB_CAP = 10;

/** Everything an entry needs to be drawn as a link and to be evicted fairly. */
const usableTab = (entry) => (
  !!entry && typeof entry === 'object' && !Array.isArray(entry)
  && typeof entry.pid === 'string' && !!entry.pid
  && typeof entry.title === 'string'
  && typeof entry.seen === 'number' && Number.isFinite(entry.seen));

// Down to the cap by LAST VISIT, leaving the order of the survivors alone —
// which is what keeps the two orders apart. Applied on the way OUT as well as on
// the way in: a cell somebody grew by hand is answered with the ten that would
// have survived, rather than with twenty a page then draws.
const cappedTabs = (list) => {
  if (list.length <= TAB_CAP) return list;
  const cold = new Set([...list]
    .sort((a, b) => a.seen - b.seen)
    .slice(0, list.length - TAB_CAP));
  return list.filter((entry) => !cold.has(entry));
};

/** The strip as it can be drawn: never null, never over the cap. */
export function readTabs() {
  const raw = read(TABS_KEY);
  if (!raw) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Written by an older version of this page, or edited by hand. An empty
    // strip is what a first visit looks like, which is a page that works;
    // throwing here happens during render and loses the interface.
    console.warn('tabs', error);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // ONE ENTRY PER PID, KEEPING THE FIRST. Nothing here writes a duplicate —
  // `rememberTab` finds the pid before it appends — but a cell somebody edited
  // by hand can hold two, and that is an ordinary arrival rather than an attack
  // (the paragraph above). Two entries for one project draw two pills that go
  // to the same place, under one React key, and only the first of them would
  // ever be refreshed again; the first is kept because position is the order of
  // opening, and the earlier entry is the one that recorded it.
  const byPid = new Map();
  parsed.filter(usableTab).forEach(({ pid, title, seen }) => {
    if (!byPid.has(pid)) byPid.set(pid, { pid, title, seen });
  });
  return cappedTabs([...byPid.values()]);
}

/**
 * Record an arrival: this project, under this title, now.
 *
 * APPENDED IF IT IS NEW, REFRESHED IF IT IS NOT. A project already on the strip
 * keeps its position exactly — a link that moves when you revisit it is a link
 * nobody can aim at — and only its stamp changes, which is what puts it at the
 * back of the eviction queue rather than at the end of the row.
 *
 * THE TITLE IS REFRESHED TOO, and that is deliberate rather than incidental: a
 * model renamed in `model.py` says its new name here on the next visit instead
 * of the one it carried when this browser first saw it.
 */
export function rememberTab(pid, title) {
  if (!pid || typeof pid !== 'string') return;
  const list = readTabs();
  const at = list.findIndex((entry) => entry.pid === pid);
  // The pid where there is no title to draw, the way a card falls back to it on
  // the front page (`projectCard` in hub.js). A blank pill is worse than an ugly
  // one, and what is left standing is still a working link.
  const named = String(title || (at >= 0 ? list[at].title : '') || pid);
  const entry = { pid, title: named, seen: Date.now() };
  if (at >= 0) list[at] = entry;
  else list.push(entry);
  write(TABS_KEY, JSON.stringify(cappedTabs(list)));
}

/** Forget one project. Nothing else moves — a tab is a link, so this is the
 *  whole of closing one. */
export function forgetTab(pid) {
  if (!pid) return;
  write(TABS_KEY, JSON.stringify(readTabs().filter((entry) => entry.pid !== pid)));
}

// -- the theme ---------------------------------------------------------------
// Which of the two palettes this reader is in. Per BROWSER, like the
// arrangement of the project list above and for the same reason: it is a
// property of the eyes in front of the screen, and somebody who asked for a dark
// page on one model meant it for the next one too.
//
// A COOKIE AND NOT `localStorage`, AND IT IS THE ONLY ONE HERE. Everything else
// in this file is read by the page after it has loaded, so storage is the
// cheaper home for it — a cookie is sent on every request, including the
// multi-megabyte view fetches, to tell the hub something the hub has no use for.
// The theme is the exception because the SERVER is what has to know it: the
// whole interface is painted from `data-theme` on `<html>`, and an attribute
// applied after the document arrives is a page that flashes the other theme
// first. The two ways to avoid the flash without a cookie are both closed —
// an inline pre-paint script is refused by the CSP (`default-src 'self'`,
// src/app.py), and the resolver page at /project/<pid>/ runs no JavaScript of
// ours at all by design. So the cookie is what makes the first paint right, and
// `src/render.py` is the half that reads it.
//
// IT MOVED OUT OF THE VIEWPORT TO GET HERE (issue #35). It used to be
// `hammerola.viewport_theme` in ui/src/viewport/options.js, exempt from the
// one-place rule because that is an adapter with storage of its own — which was
// the right place while the theme meant "the colour of the 3D canvas" and the
// rest of the page was light whatever it said. It is the whole interface's
// answer now, so it belongs with the rest of the per-reader state, and the
// viewport reads it from here.
//
// WHAT IS REMEMBERED UNDER THE OLD KEY IS NOT MIGRATED. Reading it once and
// writing it here would mean carrying the old key, its parsing and a "have we
// migrated yet" question forever, to save the two readers who had ever changed
// this setting one click. They come up light and click the toggle again.

const THEME_COOKIE = `${NS}theme`;

/** The two the palette and the vendored library both take. */
export const THEMES = Object.freeze(['light', 'dark']);

/** What a browser that has never said anything gets, on every page. */
export const DEFAULT_THEME = 'light';

// A year, which is "until they say otherwise" in the only unit a cookie has.
// A SESSION cookie would forget the answer when the browser closes, and this is
// a preference rather than a login.
//
// NO `Secure`, deliberately: the hub is reachable over plain HTTP (SPEC 3), and
// a `Secure` cookie is simply never sent there — the setting would be written,
// vanish on the next navigation, and look like a hub that does not remember.
// `SameSite=Lax` is what every browser now defaults an unmarked cookie to, said
// out loud so nobody has to know that; there is no cross-site request to this
// hub that would want it either way.
const THEME_COOKIE_ATTRS = `;Path=/;Max-Age=${60 * 60 * 24 * 365};SameSite=Lax`;

function readCookie(name) {
  let jar = '';
  try {
    jar = document.cookie || '';
  } catch (error) {
    // A sandboxed frame, or a browser refusing site data. "Nothing was
    // remembered" is a complete answer, and this read happens during render.
    console.warn('cookie', error);
    return null;
  }
  for (const part of jar.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

function writeCookie(name, value) {
  try {
    document.cookie = `${name}=${value}${THEME_COOKIE_ATTRS}`;
  } catch (error) {
    // The setting still holds for this page — `writeTheme` stamps the attribute
    // separately — it just will not outlive it.
    console.warn('cookie', error);
  }
}

/** The remembered theme, or the default. Never throws, whatever the jar does. */
export function readTheme() {
  const saved = readCookie(THEME_COOKIE);
  return THEMES.includes(saved) ? saved : DEFAULT_THEME;
}

/**
 * Remember the reader's answer, apply it to the page, and hand back the one
 * that was actually taken.
 *
 * THE RETURN VALUE IS THE POINT: an unknown theme is corrected to the default
 * HERE, so a caller cannot store one thing and show another.
 *
 * IT WRITES IN TWO PLACES, and neither is redundant. The cookie is for the NEXT
 * page load, where the server reads it and stamps the attribute before the
 * document is sent; the attribute written here is for THIS one, where nothing is
 * going to be sent again and every `var(--…)` in the interface resolves against
 * it. Setting only the cookie would leave the reader looking at the old theme
 * until they navigated.
 */
export function writeTheme(value) {
  const theme = THEMES.includes(value) ? value : DEFAULT_THEME;
  writeCookie(THEME_COOKIE, theme);
  // Guarded on its own: a document with no `documentElement` is not a page this
  // code can run on, but a throw here would lose the setting the line above just
  // stored successfully.
  try {
    document.documentElement.setAttribute('data-theme', theme);
  } catch (error) {
    console.warn('theme', error);
  }
  return theme;
}
