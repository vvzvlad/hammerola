// Everything this page remembers in the browser, and nothing else.
//
// Three things are kept, all under the `hammerola.` prefix the rest of the site
// already uses — `hammerola.pointing_device`, the viewport's own answer
// (viewport/options.js) — and all keyed BY PROJECT for the reason
// pointer_pref.js gives about its own key: somebody editing one model and merely
// looking at another must not have the two answers collide.
//
// EVERY access goes through the two functions at the top. `localStorage` is not
// a property that is always there — a private window, a browser set to block
// site data, and an iframe with third-party storage blocked all THROW on the
// getter itself rather than returning null — and an uncaught throw here happens
// during render, which takes the whole interface down over a preference.

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
// having it leaves the interface to look with. It is a KEY that can be revoked,
// not an account, so it is stored where a key belongs: in this browser, for this
// project, removable in one click.
//
// Note what is NOT here: no verification. The endpoint that would check it does
// not exist yet — the hub's comment write is still public and its read is behind
// COMMENT_READ_TOKEN, which is the AGENT's secret and shared across every
// project's queue, so it can never travel to a browser. Step 0 of the plan is
// what decides the shape of the human token. Until then this stores what was
// typed and sends it on the one write that exists; the interface says as much
// rather than implying the hub agreed to anything.

const tokenKey = (pid) => `${NS}token.${pid}`;

export const readToken = (pid) => (pid ? read(tokenKey(pid)) : null) || null;

export function writeToken(pid, value) {
  if (!pid) return;
  const trimmed = String(value || '').trim();
  write(tokenKey(pid), trimmed || null);
}

export const clearToken = (pid) => write(tokenKey(pid), null);

// -- notes ------------------------------------------------------------------
// A note is a PROPERTY OF A PART and belongs to the project, not to a build and
// not to a browser (brief, block 5) — "3.2 mm wall, printer minimum, leave it"
// is true before a rebuild and after one. There is no endpoint for it, so it is
// kept here and the editor says so on the screen. Keyed by part NAME, exactly
// as the brief settles it: a name survives a rebuild, an id does not, and the
// same part is called something different in the print view than in the
// assembled one.

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
