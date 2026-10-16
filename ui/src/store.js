// Everything these pages remember in the browser, and nothing else.
//
// Seven things are kept, all under the `hammerola.` prefix the rest of the site
// uses (`hammerola.pointing_device`, viewport/options.js). Six live in
// `localStorage`; the theme is a cookie because the server has to know it to
// send the page already painted (see the theme section). Two of the six are
// keyed by project (notes, the pointer) so that editing one model and viewing
// another do not collide; the token, the project-list arrangement, the tab
// strip and the retina setting are one key for the whole site.
//
// EVERY access goes through the two functions at the top and the cookie's two
// at the bottom. `localStorage` and `document.cookie` THROW on the getter in a
// private window, with site data blocked, or in a sandboxed frame, and a throw
// here happens during render. `tests/test_ui_source.py` holds both to one site
// per side and to a `try` around every access.

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
// One key for the whole site: the hub has a single `EDIT_TOKEN`, the same value
// `hammerola login` stores on a laptop, and the front page (`/`) names no
// project. It is a key, not an account: not tied to a person, revoked by
// changing it on the hub, removable here in one click.
//
// Verification is not done here and could not be: the only thing that can say
// whether a token is good is the hub. The front page writes this key only after
// `loadIndex` has answered with a list, and clears it when that answers 403
// (HammerolaEntry.open). This module's whole job is remembering.

const TOKEN_KEY = `${NS}token`;

export const readToken = () => read(TOKEN_KEY) || null;

export function writeToken(value) {
  const trimmed = String(value || '').trim();
  write(TOKEN_KEY, trimmed || null);
}

export const clearToken = () => write(TOKEN_KEY, null);

// -- notes ------------------------------------------------------------------
// A note is a property of a part and belongs to the project, not to a build or
// a browser (brief, block 5). There is no endpoint for it, so it is kept here
// and the editor says so on screen. Keyed by the CATALOGUE KEY (the identity
// `meta.parts` uses), not the row's name: the tessellator names two instances
// `pin` and `pin(2)`, and the key is the same in every view. Do not add a
// fallback lookup by name.

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
// `static/_v/pointer_pref.js` and must not pull this bundle, so the key is
// spelled in both files; `tests/test_pointer_memory.py` checks they agree. A
// URL naming a pointer always wins over the remembered one: the pointer pages
// record and never act, the pointer-less URL acts and never records.
//
// Recorded on arrival, not on a picker click, so the memory follows what the
// reader actually looked at (picker, pasted link or back button alike).
//
// A pinned commit records nothing (guarded here and by the caller): the
// resolver compares only against the two pointer names.

const pointerKey = (pid) => `${NS}pointer.${pid}`;

export function rememberPointer(pid, name) {
  if (!pid || !POINTER_NAMES.includes(name)) return;
  write(pointerKey(pid), name);
}

// -- how the project list is arranged ----------------------------------------
// Which way the front page draws its projects — tiles or rows — and in what
// order. One key each for the whole site: `/` names no project, and the choice
// is the person's, like `hammerola.pointing_device` (viewport/wheel.js).
//
// Two keys rather than one JSON object, so an unreadable value loses only
// itself.
//
// What comes back is checked against a list: storage holds whatever any page
// version or a storage inspector wrote. An unknown id reads as `null`
// ("nothing remembered") and the page draws its default.
//
// This is the only check on that path: the four tables in HammerolaEntry.jsx
// are looked up directly, and a miss is not always loud (`SORT_CMP[unknown]`
// handed to `sort` silently keeps arrival order). This function filters
// storage, `choose()` filters callers, and `ui/tests/vocabulary.test.js` holds
// the tables' key sets equal to the two lists here.
//
// The default is not here: it is `HammerolaProjects.defaultProps`.

const VIEW_KEY = `${NS}projects_view`;
const SORT_KEY = `${NS}projects_sort`;

// Frozen: these are the filter every stored value and caller's patch is checked
// against AND the list the tabs are drawn from, so a `push` anywhere would mint
// an id `VIEW_BODIES[…]` has never had.

/** The two ways the list is drawn, in the order the switch offers them. */
export const PROJECT_VIEWS = Object.freeze(['grid', 'list']);

/** The orders it can be in — exactly the ids `sorted()` has a comparator for. */
export const PROJECT_SORTS = Object.freeze(['name', 'modified', 'first']);

const recall = (key, known) => {
  const saved = read(key);
  return known.includes(saved) ? saved : null;
};

// Refused rather than corrected, like `rememberPointer`: overwriting a real
// remembered answer with a default would lose it to a caller's typo.
const remember = (key, known, value) => {
  if (known.includes(value)) write(key, value);
};

export const readProjectView = () => recall(VIEW_KEY, PROJECT_VIEWS);
export const readProjectSort = () => recall(SORT_KEY, PROJECT_SORTS);
export const writeProjectView = (value) => remember(VIEW_KEY, PROJECT_VIEWS, value);
export const writeProjectSort = (value) => remember(SORT_KEY, PROJECT_SORTS, value);

// -- the strip of projects this browser has been in --------------------------
// A list of links at `/project/<pid>/` (the pointer-less URL `projectUrl`
// builds). Which one is active is not stored: it is the pid in the address.
//
// A tab is a project, not a build: the pointer-less URL opens whichever of
// `latest` and `dev` the reader was last on.
//
// One key for the whole site: the list is about several projects at once.
//
// TWO ORDERS, AND THEY MUST STAY DIFFERENT. Position is the order of opening:
// an arrival is appended and stays put, so a link never moves under a reader
// aiming at it. Eviction is by last visit: at the cap the entry opened longest
// ago goes. Dropping the leftmost would evict the project opened first and
// returned to daily.
//
// Bad elements are dropped per element and the rest kept: one hand-edited
// entry must not cost the good tabs beside it. Text that will not parse or a
// value that is not an array yields an empty strip.
//
// An entry is exactly three fields — pid (the link), title, and the stamp of
// the last visit (the eviction input); anything else is dropped on read.

const TABS_KEY = `${NS}tabs`;

/** How many the strip holds. The eleventh arrival evicts the coldest entry. */
export const TAB_CAP = 10;

/** Everything an entry needs to be drawn as a link and to be evicted fairly. */
const usableTab = (entry) => (
  !!entry && typeof entry === 'object' && !Array.isArray(entry)
  && typeof entry.pid === 'string' && !!entry.pid
  && typeof entry.title === 'string'
  && typeof entry.seen === 'number' && Number.isFinite(entry.seen));

// Down to the cap by last visit, leaving the survivors' order alone. Applied on
// read as well as on write, so a cell grown by hand still yields at most ten.
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
    // Written by an older version or edited by hand. An empty strip is a
    // working page; throwing here happens during render.
    console.warn('tabs', error);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
    // One entry per pid, keeping the first: a hand-edited cell can hold two,
    // which would draw two pills under one React key. The first is kept because
    // position is the order of opening.
  const byPid = new Map();
  parsed.filter(usableTab).forEach(({ pid, title, seen }) => {
    if (!byPid.has(pid)) byPid.set(pid, { pid, title, seen });
  });
  return cappedTabs([...byPid.values()]);
}

/**
 * Record an arrival: this project, under this title, now.
 *
 * Appended if new, refreshed if not: a known project keeps its position and
 * only its stamp changes, moving it to the back of the eviction queue. The
 * title is refreshed too, so a model renamed in `model.py` shows its new name.
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

// -- whether the model is drawn at the display's full density ----------------
// The Settings card's "Retina resolution": on, the renderer draws at
// `window.devicePixelRatio`; off, at 1 — a quarter of the pixels on a 2x screen,
// which is what keeps orbiting at 60 fps on a retina Mac (viewport/element.js).
// One key for the whole site: it is about this screen, not any model.
//
// Nothing stored reads as on; only the exact word `off` turns it off.

const RETINA_KEY = `${NS}retina`;

export const readRetina = () => read(RETINA_KEY) !== 'off';

export const writeRetina = (on) => write(RETINA_KEY, on ? 'on' : 'off');

// -- the theme ---------------------------------------------------------------
// Which of the two palettes this reader is in, per browser.
//
// A COOKIE, NOT `localStorage`: the server stamps `data-theme` on `<html>`
// (`src/render.py` reads the cookie) so the first paint is right. An inline
// pre-paint script is refused by the CSP (`default-src 'self'`, src/app.py),
// and the resolver page at /project/<pid>/ runs no JavaScript of ours. The
// viewport reads the theme from here.

const THEME_COOKIE = `${NS}theme`;

/** The two the palette and the vendored library both take. */
export const THEMES = Object.freeze(['light', 'dark']);

/** What a browser that has never said anything gets, on every page. */
export const DEFAULT_THEME = 'light';

// A year: a session cookie would forget the answer when the browser closes.
//
// No `Secure`: the hub is reachable over plain HTTP (SPEC 3), where a `Secure`
// cookie is never sent. `SameSite=Lax` is the browser default, stated
// explicitly.
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
 * The return value is the theme taken: an unknown one is corrected to the
 * default here, so a caller cannot store one thing and show another.
 *
 * Writes in two places: the cookie is for the next page load, where the server
 * stamps the attribute; the attribute is for this page, where every
 * `var(--…)` resolves against it.
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
