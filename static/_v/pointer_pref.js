// Which moving pointer — `latest` or `dev` — a reader last opened, PER PROJECT.
//
// Two pages need this and they are not the same page: the build page writes it
// (viewer.js), the resolver at /project/<pid>/ reads it (pointer.js). One module
// so there is exactly one spelling of the key and one answer to "what counts as
// a valid stored value": a copy in each file is a pair that agrees until the day
// one of them is edited, and the failure would be silent — a reader whose choice
// simply stops being remembered.
//
// PER PROJECT, not one flag for the whole site. Someone editing one model lives
// in `dev` while merely looking at another, and a single flag would open the
// second one on a local build that has nothing to do with what they wanted.

/** The two moving names. A commit id is neither, and is never remembered. */
export const POINTER_NAMES = ["latest", "dev"];

// Namespaced like the other two keys this site stores (`.pointing_device`,
// `.live`), and suffixed with the project id, which is why it is a PREFIX.
const KEY_PREFIX = "hammerola.pointer.";

const key = (pid) => KEY_PREFIX + pid;

/**
 * The remembered pointer for one project, or null.
 *
 * Anything that is not one of the two names reads as null — an old value, a key
 * somebody set by hand, a name this site no longer has. The caller then falls
 * back to `latest`, which is the answer that is always safe.
 */
export function readPointer(pid) {
  if (!pid) return null;
  let saved = null;
  try {
    saved = localStorage.getItem(key(pid));
  } catch (e) {
    // Private mode, or storage turned off. Nothing was remembered, and that is
    // a complete answer — not an error worth showing anybody.
    console.warn("pointer preference", e);
  }
  return POINTER_NAMES.includes(saved) ? saved : null;
}

/**
 * Remember that this project was last opened on `name`.
 *
 * Called from the pointer pages themselves, which is what makes the choice
 * follow what the reader ACTUALLY looked at rather than what they clicked in a
 * picker: arriving at /dev/ by any route — the build picker, a pasted link, the
 * back button — is the same fact, and it is recorded in one place.
 */
export function rememberPointer(pid, name) {
  if (!pid || !POINTER_NAMES.includes(name)) return;
  try {
    localStorage.setItem(key(pid), name);
  } catch (e) {
    // The page works exactly as before; only the memory is lost.
    console.warn("pointer preference", e);
  }
}
