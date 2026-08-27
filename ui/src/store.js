// Everything these pages remember in the browser, and nothing else.
//
// Three things are kept, all under the `hammerola.` prefix the rest of the site
// already uses — `hammerola.pointing_device`, the viewport's own answer
// (viewport/options.js). Two of them are keyed BY PROJECT for the reason
// pointer_pref.js gives about its own key: somebody editing one model and merely
// looking at another must not have the two answers collide. The token is the one
// that is not, and the section below says why that changed.
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
// having it leaves the interface to look with.
//
// ONE KEY FOR THE WHOLE SITE, and that is a fact about the hub rather than a
// preference expressed here. Step 0 collapsed the hub's two secrets into a
// single `EDIT_TOKEN` (SPEC 8, entry 26), so there is exactly one string a
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
