// The page's address and the browser's history: every history entry written and
// every Back and Forward followed here. The path is still read on its own where
// a module needs only the build (`PAGE` in hub.js), and a move to another
// project is a plain navigation (`location.href`).
//
// An address is the path of a build — or of a comparison of one (`pageFrom` in
// hub.js) — and a query naming what is on screen: the model's view `v=`, the
// document over the model or on the page of a build with no model `d=`, the
// sheet of the schematic open `s=`, the camera's frame `c=`, and the key to a
// build's files `files=`. `parse` reads all of it at once, with the state of the
// history entry; `format` writes it back. What an address names is each page's
// choice; how it is spelled is this module's:
//
//   * the parameters go in the order v, d, s, c, files, each value escaped as a
//     component of a URL but `c=`, whose commas stay as they are;
//   * nothing is written for a field with no value: the first view has no `v=`
//     (`viewParam`), the root sheet no `s=`;
//   * a parameter a change does not name stays where it stands, spelled as it
//     came — `files=`, and anything this module does not know. A field the
//     change names is taken out and written again at the end (`respell`); the
//     view the camera's write names beside its frame goes at the front instead.
//
// `navigate` is the only caller of `history.pushState` and `replaceState`, and
// the listener below the only one on `popstate`: a component that follows Back
// and Forward subscribes (`subscribe`) and is handed the address the browser
// moved to, in the order the subscriptions were made, as the browser runs its
// listeners. tests/test_ui_source.py holds the rest of ui/src to both.

import { pageFrom } from './hub.js';

/** The query keys of the fields an address names. */
export const VIEW_QUERY = 'v';
export const DOC_QUERY = 'd';
export const SHEET_QUERY = 's';
export const CAMERA_QUERY = 'c';
export const FILES_QUERY = 'files';

// The fields in the order they are written, each with its key and how its
// value is spelled. `c=` is eleven numbers joined by commas (`encodeCamera` in
// hub.js), which an escape would turn into `%2C`.
const FIELDS = [
  ['view', VIEW_QUERY, encodeURIComponent],
  ['doc', DOC_QUERY, encodeURIComponent],
  ['sheet', SHEET_QUERY, encodeURIComponent],
  ['camera', CAMERA_QUERY, String],
  ['files', FILES_QUERY, encodeURIComponent],
];

const keyOf = (pair) => pair.split('=')[0];

/**
 * The address of `where` (`pathname`, `search`, `hash`, the browser's own by
 * default) and the history entry's `state`, read whole: the build's `pid`,
 * `slot`, `base` and `cmp` (`pageFrom`), the `path`, the query's `params` as
 * written, the `hash`, and the value of each field (`view`, `doc`, `sheet`,
 * `camera` — the text of `c=` — and `files`), or null where it is not there.
 */
export function parse(where = window.location, state = window.history.state) {
  const query = new URLSearchParams(where.search);
  return {
    ...pageFrom(where.pathname),
    path: where.pathname,
    params: where.search.slice(1).split('&').filter(Boolean),
    hash: where.hash,
    state,
    ...Object.fromEntries(FIELDS.map(([field, key]) => [field, query.get(key)])),
  };
}

/** The text of address `at`, from its path: what the address bar shows past the origin. */
export function format(at) {
  return `${at.path}${at.params.length ? `?${at.params.join('&')}` : ''}${at.hash}`;
}

/**
 * Address `at` with the fields `fields` names spelled anew: each one's
 * parameter taken out of the query and, where the field has a value, written
 * again after the rest, in the order of `FIELDS`; `viewFirst` puts the view
 * before the rest. Every other parameter, the path, the hash and the state stay.
 */
export function respell(at, fields, viewFirst = false) {
  const named = FIELDS.filter(([field]) => field in fields);
  const taken = named.map(([, key]) => key);
  const spelled = named.filter(([field]) => fields[field])
    .map(([field, key, spell]) => `${key}=${spell(fields[field])}`);
  const front = viewFirst ? spelled.filter((pair) => keyOf(pair) === VIEW_QUERY) : [];
  const params = [
    ...front,
    ...at.params.filter((pair) => !taken.includes(keyOf(pair))),
    ...spelled.filter((pair) => !front.includes(pair)),
  ];
  return parse({ pathname: at.path, search: params.length ? `?${params.join('&')}` : '', hash: at.hash },
    at.state);
}

/** The address at `path` naming `fields` alone, with history state `state`: one
 *  a page writes whole, which carries nothing of the address on screen. */
export function fresh(path, fields, state = null) {
  return respell(parse({ pathname: path, search: '', hash: '' }, state), fields);
}

/** What `v=` says for `view` among a build's `views`: none for the first,
 *  which an address without it opens on. */
export const viewParam = (view, views) => (views[0] && views[0].id === view ? null : view);

/** Address `at` in the address bar: a new entry of the browser's history with
 *  `push`, else the entry on screen rewritten, either with `at.state`. */
export function navigate(at, { push = false } = {}) {
  window.history[push ? 'pushState' : 'replaceState'](at.state, '', format(at));
}

const listeners = new Set();

/** Hand `listener` the address the browser moves to on Back and Forward, after
 *  the listeners subscribed before it. One subscribed twice is called once. */
export function subscribe(listener) {
  listeners.add(listener);
}

/** Stop handing addresses to `listener`; one never subscribed is no error. */
export function unsubscribe(listener) {
  listeners.delete(listener);
}

/** The listeners subscribed now, in the order they are called: what the tests'
 *  check reads to find one a test left behind (ui/tests/addressguard.js). */
export function subscribers() {
  return [...listeners];
}

// Every subscriber is handed the same reading. One unsubscribed during the
// round is left out and one subscribed during it waits for the next, as the
// browser does with listeners removed and added while an event is dispatched.
// One that throws does not stop the rest, as one browser listener throwing does
// not stop the next: its error is thrown again from a microtask of its own,
// where it is reported as uncaught.
window.addEventListener('popstate', () => {
  const at = parse();
  for (const listener of [...listeners]) {
    if (!listeners.has(listener)) continue;
    try {
      listener(at);
    } catch (error) {
      queueMicrotask(() => { throw error; });
    }
  }
});
