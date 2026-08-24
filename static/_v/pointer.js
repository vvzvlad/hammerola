// The resolver behind /project/<pid>/ — the one URL that names no pointer.
//
// It exists because the answer lives in localStorage and the server cannot read
// it. The alternative that was rejected: keep the 302 to `latest` and let the
// build page jump to `dev` afterwards. That is a visible double navigation, a
// second full page load, and a flash of the wrong build every time.
//
// THE RULE THIS PAGE IS BUILT AROUND: a URL that names a pointer wins over the
// remembered one, always. /project/<pid>/latest/ is the link people paste to
// each other, and a reader who is quietly moved to somebody else's `dev` sees
// something other than what they were sent and has no way to notice. So the
// remembered choice is applied HERE and nowhere else — the pointer pages
// themselves only ever record it (see pointer_pref.js).
//
// A separate file rather than an inline <script>: the HTML responses carry
// `Content-Security-Policy: default-src 'self'`, which refuses inline script.
import { readPointer } from "/_v/pointer_pref.js";

// /project/<pid>/ -> <pid>. The trailing slash is guaranteed: the hub redirects
// /project/<pid> to it, which is also what makes the relative URLs below — and
// the no-script link in the page — resolve inside the project directory.
const PID = location.pathname.split("/")[2];

// `replace`, never `href`: this page is a decision, not a destination. In the
// history it would sit between the reader and wherever they came from, and Back
// would land on it and be resolved forward again — the classic redirect loop
// that traps the back button.
const go = (name) => location.replace(name + "/");

/** Is the local slot actually occupied? (SPEC 7.6) */
async function hasDev() {
  try {
    // `no-store` because the answer decides where the reader lands: builds.json
    // is served no-cache, but a revalidation skipped by a back/forward cache
    // would resolve today's visit on yesterday's slot.
    const r = await fetch("builds.json", { cache: "no-store" });
    if (!r.ok) return false;
    const info = await r.json();
    return Boolean(info && info.has_dev);
  } catch (e) {
    // A project that has never been pushed has no builds.json at all, and a hub
    // mid-restart has nothing to say. Either way the honest answer is "no", and
    // the fallback below is a build that at least might exist.
    console.warn("builds.json", e);
    return false;
  }
}

const saved = readPointer(PID);

// `latest` and "nothing remembered" take the same path, and they take it with
// no extra request: this is the common case, and a network round trip to
// confirm the default would be paid by every reader who never chose anything.
if (saved !== "dev") {
  go("latest");
} else {
  // Remembered `dev`, which is the one answer that can have gone stale — the
  // slot is local, it may never have been filled, and it can be pruned. A 404
  // where the reader expected their project is a worse outcome than opening
  // the build CI published, so it is checked rather than assumed.
  go(await hasDev() ? "dev" : "latest");
}
