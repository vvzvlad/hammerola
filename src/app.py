"""HTTP surface: the publish endpoint and the static site it produces.

Standard library only — `ThreadingHTTPServer` over `BaseHTTPRequestHandler`. What
this service does is receive a tarball and then serve files off disk, and neither
half is made simpler by a framework.

Routing (SPEC 3, 7.4):

    GET  /health                              liveness for the compose healthcheck
    GET  /                                    public index page (from templates/)
    GET  /index.json                          cards feeding that page
    GET  /_v/<file>                           shared viewer bundle, one per site
    GET  /project/<pid>/                      302 -> latest/
    GET  /project/<pid>/builds.json           build picker
    GET  /project/<pid>/latest/<file>         newest CI build, no-cache
    GET  /project/<pid>/dev/<file>            the local slot, no-cache
    GET  /project/<pid>/<commit>/<file>       one build's files, immutable forever
    GET  /project/<pid>/<commit>/             the page shell, from the template
    POST /api/v1/publish/<pid>/<commit>       accept a push, 202 + a job
    POST /api/v1/publish/<pid>/dev            same, into the local slot
    GET  /api/v1/jobs/<id>                    how that build is going  PUBLISH_TOKEN
    GET  /api/v1/jobs/<id>/log                what the build printed   PUBLISH_TOKEN

    POST /api/v1/comments/<pid>/<commit>      leave a comment — PUBLIC, no token
    GET  /api/v1/comments                     the queue          COMMENT_READ_TOKEN
    GET  /api/v1/comments/<id>                one comment        COMMENT_READ_TOKEN
    GET  /api/v1/comments/<id>/photo          its photo          COMMENT_READ_TOKEN
    GET  /api/v1/comments/<id>/shot           its rendered frame COMMENT_READ_TOKEN
    POST /api/v1/comments/<id>/resolve        mark it handled    COMMENT_READ_TOKEN

The comment endpoints are the only asymmetric ones on the service: writing is open
to anyone with the URL and reading is not (SPEC 7A.2). Everything unusual about
`_handle_comment_post` below follows from that one fact.

A PUSH IS TWO THINGS NOW, and the split runs right through `_handle_post`. What
arrives is a model's SOURCE, and the hub builds it (SPEC 8A.2 step 5), which is
minutes of CPU and does not belong in a request: the socket timeout is 30 s and
a `ThreadingHTTPServer` holds one thread per connection. So everything that can
be decided FROM THE UPLOAD is decided here and answered here — the token, the
size, the archive, and whether this exact push is already published — and the
build itself becomes a job (`src/jobs.py`) the answer points at with a 202. The
two job endpoints are what replaces the CI job log the pusher used to read.

Cache-Control is not a detail here, it is the load-bearing half of the URL scheme:
a commit directory is immutable by construction, so it gets a year; `latest` and
`dev` move, so they get none. `dev` is the only URL whose CONTENT is rewritten in
place (SPEC 7.6), and `no-cache` is precisely what makes that safe — which is why
it must never be able to fall through to the immutable branch.
"""

import hmac
import json
import os
import shutil
import stat
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote

from loguru import logger

from src import render
from src.comments import (PHOTO_KIND, SHOT_KIND, CommentError, CommentStore,
                          RateLimiter, client_address, normalize_since,
                          validate_payload)
from src.jobs import (HANDOVER_ERROR, QUEUE_FULL_ERROR,
                      QUEUE_FULL_RETRY_AFTER_SECONDS, STATE_FAILED,
                      STOPPED_ERROR, SUBMIT_ACCEPTED, SUBMIT_QUEUE_FULL,
                      BuildQueue, BuildTask, JobStore)
from src.multipart import MultipartError, parse_multipart
from src.store import DEV_LINK, POINTER_NAMES, PublishError, Store

# SPEC 7.4. `immutable` tells a browser not to even revalidate on reload, which is
# only honest because a build directory can never change: republishing the same
# commit with different content is refused with a 409 rather than overwriting.
CACHE_IMMUTABLE = "public, max-age=31536000, immutable"
CACHE_NONE = "no-cache"

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

HTML_TYPE = "text/html; charset=utf-8"
OCTET_TYPE = "application/octet-stream"

# Only the vendored bundle may be cached forever: its name carries the library's
# identity and it is replaced by a differently named file, never edited. Our own
# `viewer.js` and `site.css` DO change with the image under a stable name, so an
# immutable year would leave people on the old viewer until 2027 after a deploy.
VENDORED_ASSET_PREFIX = "three-cad-viewer."

# The pages load everything from this origin and nothing is inline, so the policy
# can be the strictest useful one. It is the BACKSTOP for the validation done on
# the way in — `render._plain_text` on every displayed string and
# `render.check_view_file` on every part name and colour inside a view — not a
# substitute for it: this stops an injected <script> from running, but it says
# nothing about a <form> posting elsewhere or an <a> stretched over the page, and
# a build URL is permanent and shared with every other project on the host.
#
# `img-src 'self' data:` is not a relaxation to trade away. The vendored viewer
# css carries its whole toolbar as 74 `--tcv-icon-*: url("data:image/svg+xml,…")`
# custom properties (SPEC 2.2), and `'self'` does NOT cover the `data:` scheme, so
# a bare `default-src 'self'` silently blanks every button in the toolbar. Inline
# SVG in a data: URI cannot execute script — it is fetched as an image — so this
# costs nothing. `script-src` inherits `default-src 'self'` and must stay there.
#
# `style-src 'self' 'unsafe-inline'` is the other half of the same problem, and it
# is far less obvious than the icons because the page still renders: the vendored
# viewer lays its tab bar out with `style="flex: 1"` ATTRIBUTES written into the
# markup, and CSP without 'unsafe-inline' makes the browser keep the attribute text
# but never parse it. Measured on a live page: the span reports the attribute while
# `getComputedStyle` returns the default `0 1 auto`, so the tabs collapse from 59px
# to 13px and read "T." "C" "M..." instead of "Tree" "Clip" "Material". Setting the
# same value from JS fixes it, which is what identifies CSP as the cause — the CSSOM
# path is not restricted, only the attribute is.
#
# Styles cannot be locked down with a hash or a nonce here: the library writes those
# attributes at runtime, with values that depend on the model. 'unsafe-inline' for
# STYLES is a much smaller concession than for scripts — it cannot execute code — and
# the injection it could otherwise assist is already closed on the way in by
# `render.check_view_file`.
CSP_HTML = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'"

# Per-connection socket timeout, in seconds. See HubHandler.timeout below.
SOCKET_TIMEOUT = 30

# Ceiling on how long ONE request body may take to arrive, end to end.
#
# The socket timeout above is not enough on its own, and the gap is not academic:
# it is rearmed by every packet, so a client sending one byte every 29 seconds
# never trips it and holds its publish slot forever. Four such clients own all of
# MAX_CONCURRENT_PUBLISHES and every real push gets a 503 — a denial of service
# that costs the attacker four sockets and no bandwidth.
#
# 300 s against a 64 MiB ceiling asks for ~1.7 Mbit/s sustained, which is far
# below what a CI runner pushing to a VPS actually does and far above what a
# slowloris can pretend to be.
BODY_DEADLINE_SECONDS = 300

# How many publishes may be in flight at once. Each one holds a body on disk, a
# tar reader and a staging tree, so this is the ceiling on that work — and CI
# retries of several projects at once are exactly the case that would otherwise
# multiply it. Publishing is rare and slow; queueing behind a permit is fine,
# being refused is not.
#
# It is the ceiling on RECEIVING and nothing else. What a push costs to BUILD has
# its own number, `jobs.MAX_CONCURRENT_BUILDS`, because the two are sized by
# different things: this one by a body on disk and a tar reader, that one by
# cores and memory. Merging them would tie two unrelated ceilings together, and
# the day either is retuned the other would move for no reason anybody could
# reconstruct.
MAX_CONCURRENT_PUBLISHES = 4

# Ceiling on the body of a resolve, which is one optional `note`. Not an env var:
# it is behind COMMENT_READ_TOKEN, the note itself is capped at a couple of
# hundred characters by `comments.MAX_FIELD_CHARS`, and this only exists so the
# endpoint cannot be handed a megabyte to parse.
MAX_RESOLVE_BODY_BYTES = 8 * 1024

# How long a publish waits for a permit before giving up. Long enough to outlast
# a normal push, short enough that a wedged one turns into a 503 CI can retry
# rather than a thread parked until the socket times out.
PUBLISH_WAIT_SECONDS = 60

# Types our OWN files are served as — templates and generated JSON only.
CONTENT_TYPES = {
    ".html": HTML_TYPE,
    ".json": "application/json",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".map": "application/json",
    ".txt": "text/plain; charset=utf-8",
}

# Types a file that ARRIVED IN A PUSH may be served as, and nothing else. The
# archive's member names are whitelisted but their extensions are not, so a build
# could contain `page.html` or `logo.svg` — and a build URL is a permanent,
# immutable, same-origin URL shared with every other project on the host. Serving
# either as its "natural" type would be a stored XSS that cannot even be recalled,
# because the year-long immutable caches are already handed out. So: JSON for the
# viewer, the model formats the download buttons point at, and everything else
# becomes an opaque attachment.
BUILD_CONTENT_TYPES = {
    ".json": "application/json",
    ".stl": "model/stl",
    ".step": "model/step",
    ".stp": "model/step",
    ".3mf": "model/3mf",
}


# Types a comment attachment may be served as. The set is closed by construction:
# `comments.sniff_image` only ever stores one of these three extensions, and it
# decides which by reading the file's first bytes rather than by believing the
# uploader. SVG is absent from both ends for the same reason it is refused on the
# way in — it executes.
ATTACHMENT_CONTENT_TYPES = {
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}


def content_type_for(name: str) -> str:
    """Content type by extension for files the image ships; unknown -> bytes."""
    return CONTENT_TYPES.get(Path(name).suffix.lower(), OCTET_TYPE)


def build_content_type(name: str) -> tuple[str, dict]:
    """(content type, extra headers) for a file that came out of a push.

    Anything not on the whitelist is handed back as an attachment: `attachment`
    with no filename on purpose, because the browser then uses the last URL
    segment, which is the member name — and there is nothing to quote or escape.
    """
    ctype = BUILD_CONTENT_TYPES.get(Path(name).suffix.lower())
    if ctype is not None:
        return ctype, {}
    return OCTET_TYPE, {"Content-Disposition": "attachment"}


def make_handler(store: Store, comment_store: CommentStore, settings,
                 jobs: JobStore, builds: BuildQueue):
    """Build the request handler class bound to one store and one settings object.

    A closure rather than class attributes so a test can stand up several
    independent servers in one process without any global state between them.
    """
    # One per server, for the same reason: two hubs in one test process must not
    # share a concurrency budget.
    publish_slots = threading.BoundedSemaphore(MAX_CONCURRENT_PUBLISHES)
    # Likewise per server: a rate limiter shared between two hubs would make one
    # test's comments count against another's ceiling.
    comment_limiter = RateLimiter(settings.comment_rate_limit,
                                  settings.comment_rate_window_seconds)
    publish_token = settings.publish_token
    max_build_bytes = settings.max_build_bytes

    class HubHandler(BaseHTTPRequestHandler):
        # HTTP/1.1 for keep-alive: a build page pulls meta.json, builds.json and a
        # 2 MB view, and a fresh connection for each is pure latency. Every reply
        # below therefore carries an accurate Content-Length, which is what makes
        # persistent connections legal.
        protocol_version = "HTTP/1.1"
        server_version = "hammerola"
        sys_version = ""

        # BaseHTTPRequestHandler passes this to the socket, and without it every
        # read blocks forever. The connection is accepted BEFORE the token is
        # checked — it has to be, the token is in a header — so an unauthenticated
        # client that opens a socket and then sends one byte a minute would
        # otherwise hold a thread indefinitely. Thirty seconds is far more than a
        # real request needs between packets and far less than a slowloris wants.
        timeout = SOCKET_TIMEOUT

        # -- plumbing --------------------------------------------------
        def log_message(self, fmt, *args):
            # Access logs at DEBUG: at INFO they would bury the startup line the
            # CI smoke gate greps for, and every 2 MB view fetch is one more line.
            logger.debug(f"{self.address_string()} {fmt % args}")

        def _headers(self, status: int, content_type: str, length: int,
                     cache: str, extra: dict | None = None):
            """The one place a response line and its headers are written.

            Two headers go out on EVERY reply. `nosniff`, because the whole
            content-type policy above is worthless if the browser is free to
            disagree with it and render an octet-stream as HTML. And on HTML, a
            CSP, which is the backstop for the DOM-building the pages do.
            """
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", cache)
            self.send_header("X-Content-Type-Options", "nosniff")
            if content_type.startswith("text/html"):
                self.send_header("Content-Security-Policy", CSP_HTML)
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()

        def _send(self, status: int, body: bytes, content_type: str,
                  cache: str = CACHE_NONE, extra: dict | None = None,
                  with_body: bool = True):
            self._headers(status, content_type, len(body), cache, extra)
            if with_body:
                self.wfile.write(body)

        def _json(self, status: int, payload, cache: str = CACHE_NONE,
                  extra: dict | None = None, with_body: bool = True):
            body = json.dumps(payload).encode("utf-8")
            self._send(status, body, "application/json", cache, extra, with_body)

        def _error(self, status: int, message: str, extra: dict | None = None,
                   with_body: bool = True):
            self._json(status, {"error": message}, CACHE_NONE, extra, with_body)

        @staticmethod
        def _split(path: str) -> list[str]:
            """Decoded, non-empty path segments.

            Unquoting BEFORE validation is deliberate: `%2e%2e` has to become `..`
            here so that the whitelist further down gets a look at it. Validating
            the raw form and decoding afterwards is the classic way to let a
            traversal through.
            """
            return [s for s in unquote(path).split("/") if s]

        # -- verbs -----------------------------------------------------
        def do_GET(self):
            self._handle_get(with_body=True)

        def do_HEAD(self):
            self._handle_get(with_body=False)

        def _handle_get(self, with_body: bool):
            path, _, query = self.path.partition("?")
            segments = self._split(path)
            trailing_slash = path.endswith("/")

            try:
                if not segments:
                    return self._serve_bytes(
                        render.index_page_html().encode("utf-8"),
                        "text/html; charset=utf-8", CACHE_NONE, with_body)

                head = segments[0]
                if head == "health" and len(segments) == 1:
                    return self._json(200, {"status": "ok"}, CACHE_NONE,
                                      with_body=with_body)
                if head == "index.json" and len(segments) == 1:
                    return self._serve_index_json(with_body)
                if head == "_v":
                    return self._serve_asset(segments[1:], with_body)
                if head == "project":
                    return self._serve_project(segments[1:], trailing_slash,
                                               with_body)
                if segments[:3] == ["api", "v1", "comments"]:
                    return self._serve_comments(segments[3:], query, with_body)
                if segments[:3] == ["api", "v1", "jobs"]:
                    return self._serve_jobs(segments[3:], with_body)
            except (BrokenPipeError, ConnectionResetError):
                # The browser navigated away mid-download, or the client reset
                # the connection. Ordinary during a 2 MB view fetch, not an error
                # worth a stack trace, and nothing can be sent on a dead socket.
                self.close_connection = True
                return None

            return self._error(404, "not found", with_body=with_body)

        def _serve_bytes(self, body: bytes, content_type: str, cache: str,
                         with_body: bool):
            self._send(200, body, content_type, cache, with_body=with_body)

        def _serve_index_json(self, with_body: bool):
            """The project cards. Absent until the first push ever succeeds."""
            path = store.root / "index.json"
            if not path.is_file():
                return self._json(200, [], CACHE_NONE, with_body=with_body)
            return self._serve_bytes(path.read_bytes(), "application/json",
                                     CACHE_NONE, with_body)

        # -- static files ----------------------------------------------
        @staticmethod
        def _safe_name(name: str) -> bool:
            """One ordinary filename, and nothing that navigates.

            Rejecting every name that starts with a dot does two jobs at once: it
            kills `.` and `..` outright, and it hides the bookkeeping files the
            store writes beside a build — `.payload.sha256` above all, which is
            what tells a retry from a collision and is nobody's business to read.
            """
            return bool(name) and not name.startswith(".") and "/" not in name

        def _send_file(self, path: Path, cache: str, with_body: bool,
                       uploaded: bool = False):
            """Stream a file, refusing anything that resolves outside the store.

            The path was already assembled from whitelisted segments, so this
            check is defence in depth rather than the primary control — but it is
            the one that keeps holding if a future edit relaxes a segment rule,
            and it costs one stat. Note it must be done on the RESOLVED path:
            `latest` is a symlink, and following it is the whole point, so the
            question is not "is there a symlink" but "where did it land".

            `uploaded` says whether the bytes came out of a push, which decides
            how narrowly the content type is whitelisted.
            """
            try:
                resolved = path.resolve(strict=True)
                resolved.relative_to(store.root)
            except (OSError, ValueError):
                return self._error(404, "not found", with_body=with_body)

            # Opened BEFORE the first header goes out. stat-then-open leaves a
            # window in which retention deletes the build between the two, and
            # the client then gets a Content-Length with nothing behind it while
            # the log gets a traceback for a situation that is entirely normal.
            try:
                handle = open(resolved, "rb")
            except OSError:
                return self._error(404, "not found", with_body=with_body)
            with handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode):
                    return self._error(404, "not found", with_body=with_body)
                if uploaded:
                    ctype, extra = build_content_type(resolved.name)
                else:
                    ctype, extra = content_type_for(resolved.name), {}
                # Size from the OPEN handle, so it describes the very bytes about
                # to be sent rather than whatever was at that name a moment ago.
                self._headers(200, ctype, info.st_size, cache, extra)
                if not with_body:
                    return None
                # Copied in chunks rather than read whole: a view is ~2 MB and a
                # STEP export can be larger, and there is no reason to hold either
                # in memory per concurrent reader.
                while True:
                    chunk = handle.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            return None

        def _serve_asset(self, rest: list[str], with_body: bool):
            """/_v/<file> — the shared viewer bundle, from the IMAGE not from data/.

            One copy for the entire site. Per-build copies would add 3.6 MB to
            every commit (SPEC 2.3), which is why this path does not go anywhere
            near the store.
            """
            if len(rest) != 1 or not self._safe_name(rest[0]):
                return self._error(404, "not found", with_body=with_body)
            path = (STATIC_DIR / "_v" / rest[0]).resolve()
            assets_root = (STATIC_DIR / "_v").resolve()
            try:
                path.relative_to(assets_root)
            except ValueError:
                return self._error(404, "not found", with_body=with_body)
            try:
                handle = open(path, "rb")
            except OSError:
                return self._error(404, "not found", with_body=with_body)
            with handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode):
                    return self._error(404, "not found", with_body=with_body)
                # Only the vendored bundle gets the immutable year. `viewer.js`
                # and `site.css` are ours and change under a stable name with
                # every image, so `immutable` on them would pin visitors to the
                # viewer that shipped the day they first loaded the site.
                cache = (CACHE_IMMUTABLE
                         if path.name.startswith(VENDORED_ASSET_PREFIX)
                         else CACHE_NONE)
                self._headers(200, content_type_for(path.name), info.st_size,
                              cache)
                if not with_body:
                    return None
                while True:
                    chunk = handle.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            return None

        def _serve_build_page(self, build_dir: Path, with_body: bool):
            """The shell of a build page — from the IMAGE, never from the build.

            It is byte-for-byte the same for every build and every project, and it
            CHANGES with the image: the day `viewer.js` needs one more element,
            every page has to have it. A copy written into each build directory
            and served with the year of `immutable` that a commit URL carries
            would freeze each published build on the markup that shipped the day
            it was pushed — and that permanent URL is the one thing this service
            promises. So it is served like `/` is: from the template, no-cache.
            Everything build-specific is fetched from meta.json at runtime, which
            is exactly what makes one shell enough.

            Existence is decided by meta.json rather than by the directory: the
            build directory can exist without being publishable (nothing else
            creates one, but a restore or a hand-copy can), and a page that then
            fails every fetch is worse than a 404.
            """
            try:
                resolved = (build_dir / "meta.json").resolve(strict=True)
                resolved.relative_to(store.root)
            except (OSError, ValueError):
                return self._error(404, "not found", with_body=with_body)
            return self._serve_bytes(render.build_page_html().encode("utf-8"),
                                     HTML_TYPE, CACHE_NONE, with_body)

        def _serve_pointer_page(self, pid: str, with_body: bool):
            """`/project/<pid>/` — the tiny page that picks a pointer (SPEC 9).

            `no-cache`, like the two pointer pages it hands over to: it stands in
            for a redirect that used to be recomputed on every visit, and a
            cached copy of a decision page is a decision frozen.

            404 for a project nobody has ever pushed, rather than a page that
            resolves to a 404 one navigation later. The directory is the test,
            not a build inside it: a project whose builds retention has taken is
            still a project, and `latest` is the honest thing to answer with.
            """
            if not (store.projects_dir / pid).is_dir():
                return self._error(404, "not found", with_body=with_body)
            return self._serve_bytes(
                render.pointer_page_html().encode("utf-8"),
                HTML_TYPE, CACHE_NONE, with_body)

        def _redirect(self, location: str, with_body: bool):
            self._json(302, {"location": location}, CACHE_NONE,
                       {"Location": location}, with_body)

        def _serve_project(self, rest: list[str], trailing_slash: bool,
                           with_body: bool):
            """Everything under /project/."""
            if not rest:
                return self._error(404, "not found", with_body=with_body)
            pid = rest[0]
            if not store.valid_pid(pid):
                return self._error(404, "not found", with_body=with_body)

            # /project/<pid>/ names no pointer, and is therefore the one URL
            # allowed to open whichever of them this reader last looked at
            # (SPEC 9). That answer is a localStorage key, so it cannot be given
            # here: what is served is a page that reads it and leaves.
            if len(rest) == 1:
                # The trailing slash is load-bearing for the same reason it is on
                # a build URL: the resolver leaves by a RELATIVE url, and its
                # no-script link is a relative href, so this directory has to be
                # what they resolve against.
                if not trailing_slash:
                    return self._redirect(f"/project/{pid}/", with_body)
                return self._serve_pointer_page(pid, with_body)

            second = rest[1]
            if second == "builds.json" and len(rest) == 2:
                return self._send_file(
                    store.projects_dir / pid / "builds.json", CACHE_NONE, with_body)

            # The two moving names — `latest` for CI, `dev` for the author's
            # laptop (SPEC 7.6) — are the only moving targets on the whole site,
            # so they are the only things that may not be cached; a commit
            # directory can never change and gets a year (SPEC 3.2, 7.4).
            # Checked FIRST, and that order is the safety property: `dev` is
            # rewritten in place, so it reaching the immutable branch would hand
            # out a year-long cache of a build that is about to be replaced.
            if second in POINTER_NAMES:
                cache = CACHE_NONE
            elif store.valid_build_id(second):
                cache = CACHE_IMMUTABLE
            else:
                return self._error(404, "not found", with_body=with_body)

            build_dir = store.projects_dir / pid / second
            if len(rest) == 2:
                # The viewer derives every relative fetch from its own directory,
                # so the trailing slash is not cosmetic: without it `meta.json`
                # would be looked up one level too high.
                if not trailing_slash:
                    return self._redirect(f"/project/{pid}/{second}/", with_body)
                return self._serve_build_page(build_dir, with_body)

            if len(rest) != 3 or not self._safe_name(rest[2]):
                return self._error(404, "not found", with_body=with_body)
            # Same page, spelled out. It is generated, so it never comes off the
            # build directory even if a push put a file of that name there.
            if rest[2] == "index.html":
                return self._serve_build_page(build_dir, with_body)
            # meta.json is written by the hub after validation; everything else in
            # a build directory arrived in the tarball and is served under the
            # narrow uploaded-file content-type whitelist.
            uploaded = rest[2] not in render.GENERATED_FILES
            return self._send_file(build_dir / rest[2], cache, with_body,
                                   uploaded=uploaded)

        # -- comment queue, read side ----------------------------------
        def _serve_comments(self, rest: list[str], query: str, with_body: bool):
            """Everything under GET /api/v1/comments (SPEC 7A.2).

            The token is checked BEFORE the shape of the request is, so a caller
            without it cannot use the difference between 401 and 404 to find out
            which comment ids exist.
            """
            if not self._require_token(settings.comment_read_token, with_body):
                return None

            if not rest:
                return self._serve_comment_list(query, with_body)

            cid = rest[0]
            if len(rest) == 1:
                record = comment_store.get(cid)
                if record is None:
                    return self._error(404, "not found", with_body=with_body)
                return self._json(200, record, CACHE_NONE, with_body=with_body)

            if len(rest) == 2 and rest[1] in (PHOTO_KIND, SHOT_KIND):
                return self._serve_attachment(cid, rest[1], with_body)

            return self._error(404, "not found", with_body=with_body)

        def _serve_comment_list(self, query: str, with_body: bool):
            params = parse_qs(query, keep_blank_values=False)
            project = (params.get("project") or [None])[0]
            status = (params.get("status") or [None])[0]
            since = (params.get("since") or [None])[0]
            if project is not None and not store.valid_pid(project):
                return self._error(422, "invalid project", with_body=with_body)
            if status is not None and status not in ("open", "resolved"):
                return self._error(422, "invalid status", with_body=with_body)
            if since is not None:
                since = normalize_since(since)
                if since is None:
                    return self._error(
                        422, "invalid since: expected an ISO-8601 timestamp",
                        with_body=with_body)
            records = comment_store.list(project=project, status=status,
                                         since=since)
            return self._json(200, {"comments": records}, CACHE_NONE,
                              with_body=with_body)

        def _serve_attachment(self, cid: str, kind: str, with_body: bool):
            """An uploaded photo, or the viewer's render of the frame.

            These are the only bytes on the service that a stranger uploaded and
            that are then handed back, so the content type comes from the closed
            set above and never from the request. `Content-Disposition:
            attachment` on top of it: the queue is read by a tool, not browsed,
            and an inline image is one content-type mistake away from being a
            page. Cached not at all — the URL is behind a token and the reader is
            an agent.
            """
            path = comment_store.attachment(cid, kind)
            if path is None:
                return self._error(404, "not found", with_body=with_body)
            ctype = ATTACHMENT_CONTENT_TYPES.get(path.suffix.lower())
            if ctype is None:
                return self._error(404, "not found", with_body=with_body)
            try:
                data = path.read_bytes()
            except OSError:
                return self._error(404, "not found", with_body=with_body)
            return self._send(200, data, ctype, CACHE_NONE,
                              {"Content-Disposition": "attachment"}, with_body)

        # -- publish ---------------------------------------------------
        def _authorized(self, expected: str) -> bool:
            """Constant-time check of a bearer token (SPEC 7, 7A.2).

            Takes the expected secret rather than reading one from the closure:
            two different tokens guard two different things here — CI pushes with
            PUBLISH_TOKEN, the agent reads the comment queue with
            COMMENT_READ_TOKEN — and neither may be accepted where the other
            belongs.

            `hmac.compare_digest` rather than `==` because `==` on bytes short
            circuits at the first differing byte, and the time it takes is
            therefore a measurement of how much of the token the caller already
            has — enough, over many requests, to recover it one byte at a time.
            Encoded to bytes first: compare_digest raises on non-ASCII str.
            """
            header = self.headers.get("Authorization", "")
            scheme, _, presented = header.partition(" ")
            if scheme.lower() != "bearer" or not presented:
                return False
            return hmac.compare_digest(
                presented.strip().encode("utf-8"), expected.encode("utf-8"))

        def _require_token(self, expected: str, with_body: bool = True,
                           close: bool = False) -> bool:
            """Answer 401 and return False unless the caller presented `expected`.

            `close` for the verbs that carry a body: refusing before reading it
            leaves the remains on the socket, and on a keep-alive connection
            those would be parsed as the next request.
            """
            if self._authorized(expected):
                return True
            logger.warning(
                f"refused: bad or missing token from {self.address_string()} "
                f"for {self.path.split('?', 1)[0]}")
            extra = {"WWW-Authenticate": "Bearer"}
            if close:
                extra["Connection"] = "close"
            self._error(401, "invalid or missing bearer token", extra,
                        with_body=with_body)
            return False

        def do_POST(self):
            try:
                return self._handle_post()
            except (BrokenPipeError, ConnectionResetError):
                # The same thing _handle_get already treats as ordinary: CI timed
                # out, or the runner was cancelled mid-upload. Nothing can be sent
                # on a dead socket, and with access logs at DEBUG a stack trace
                # here would be the only thing on INFO — masking the failures that
                # are actually worth reading.
                logger.info("publish aborted: the client closed the connection")
                self.close_connection = True
                return None

        def _handle_post(self):
            path = self.path.split("?", 1)[0]
            segments = self._split(path)

            if segments[:3] == ["api", "v1", "comments"] and len(segments) == 5:
                # Two routes share this shape: `<pid>/<commit>` to leave a
                # comment and `<id>/resolve` to close one. `resolve` decides
                # between them, which reserves it as a commit name for the
                # comment API — a build called `resolve` can still be published
                # and served, it just cannot be commented on. That is a cheaper
                # price than a fifth path segment on the public endpoint.
                if segments[4] == "resolve":
                    return self._handle_comment_resolve(segments[3])
                return self._handle_comment_post(segments[3], segments[4])

            if segments[:3] != ["api", "v1", "publish"] or len(segments) != 5:
                return self._error(404, "not found", {"Connection": "close"})

            # Auth BEFORE the body is read: an unauthenticated caller must not be
            # able to make us receive 64 MiB just to be told no.
            if not self._authorized(publish_token):
                logger.warning(
                    f"publish refused: bad or missing token from "
                    f"{self.address_string()}")
                return self._error(
                    401, "invalid or missing bearer token",
                    {"WWW-Authenticate": "Bearer", "Connection": "close"})

            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                return self._error(
                    411, "Content-Length is required", {"Connection": "close"})
            if length < 0:
                return self._error(
                    400, "invalid Content-Length", {"Connection": "close"})
            if length > max_build_bytes:
                # Answered without reading, so the ceiling actually saves the work
                # rather than just reporting it afterwards. The connection is then
                # closed because the unread body would otherwise be parsed as the
                # next request on a keep-alive connection.
                return self._error(
                    413,
                    f"body is {length} bytes, limit is {max_build_bytes}",
                    {"Connection": "close"})

            pid, commit = segments[3], segments[4]

            # Reading the body, unpacking it and hashing it all cost real memory
            # and disk, and nothing above this point limits how many connections
            # do it at once. The permit is taken BEFORE the body is read, so an
            # overloaded hub stops pulling bytes instead of accepting work it
            # cannot do.
            if not publish_slots.acquire(timeout=PUBLISH_WAIT_SECONDS):
                logger.warning(
                    f"publish {pid}/{commit} refused: no free slot after "
                    f"{PUBLISH_WAIT_SECONDS}s")
                return self._error(
                    503, "too many publishes in flight, retry later",
                    {"Connection": "close", "Retry-After": "30"})
            try:
                spool = store.upload_path()
                try:
                    problem = self._spool_body(length, spool)
                    if problem is not None:
                        status, message = problem
                        logger.warning(
                            f"publish {pid}/{commit} refused: {message}")
                        # Closed, like every other refusal that leaves bytes
                        # unread: on a keep-alive connection the remains of the
                        # body would be parsed as the next request.
                        return self._error(
                            status, message, {"Connection": "close"})
                    # `<pid>/dev` is the laptop's route (SPEC 7.6): the work has
                    # no commit to be addressed by, so it goes into the project's
                    # one local slot, overwriting whatever was there — the same
                    # name, the same meaning as in the URL people read. It is a
                    # reserved build name, so this can never shadow a commit that
                    # could otherwise have been published. Both routes are
                    # accepted identically; only the last step differs, and that
                    # step happens in the worker.
                    accepted = store.accept_sources(pid, commit, spool, length)
                except PublishError as error:
                    logger.warning(
                        f"publish {pid}/{commit} refused: {error.message}")
                    return self._error(error.status, error.message)
                except (BrokenPipeError, ConnectionResetError):
                    # Handed to do_POST above rather than to `except Exception`
                    # below: these are subclasses of OSError, so without this
                    # clause a disconnect became `logger.exception` plus a second
                    # traceback from trying to answer on the closed socket.
                    raise
                except Exception:
                    logger.exception(f"publish {pid}/{commit} failed")
                    return self._error(500, "internal error")
                finally:
                    spool.unlink(missing_ok=True)
                return self._queue_build(pid, commit, accepted)
            finally:
                publish_slots.release()

        def _queue_build(self, pid: str, commit: str, accepted):
            """Hand an accepted source tree to the build pool. 200, 202 or 503.

            200 rather than 202 when this exact push is already published: the
            answer is on disk, and rebuilding minutes of geometry to arrive at it
            would be work done to learn nothing. 409 leaves here as a
            PublishError for the same reason — both codes stay where CI has
            always seen them, on the push itself, instead of moving into a job
            the pusher would have to poll to be told no.

            The permit is still held while this runs. It is a queue insertion and
            three writes, and holding it means the number of source trees on the
            volume with no worker yet is bounded by the accept slots plus the
            queue rather than by how fast a client can open connections.

            WHAT TO ANSWER IS DECIDED FIRST AND SENT LAST, below the cleanup,
            for the reason `_build_and_publish` gives for the same order: a
            client that has been answered is entitled to assume the hub has
            finished with its push. `_json` writes to the socket where it is
            called, so answering inside the `try` left a window — short, and real
            — in which the pusher had its 200, 409 or 503 and an unpacked source
            tree was still sitting on the volume with nobody owning it.
            """
            handed_over = False
            job_id = None
            reply = None            # (status, payload, extra headers)
            try:
                settled = store.settled(pid, commit, accepted.digest)
                if settled is not None:
                    status, payload = settled
                    reply = (status, payload, None)
                else:
                    record = jobs.create(pid, commit)
                    job_id = record["id"]
                    outcome = builds.submit(BuildTask(
                        job_id=job_id, pid=pid, commit=commit,
                        sources=accepted.sources, digest=accepted.digest))
                    if outcome == SUBMIT_ACCEPTED:
                        handed_over = True
                        status_url = f"/api/v1/jobs/{job_id}"
                        logger.info(
                            f"publish {pid}/{commit}: queued as job {job_id}")
                        # 202 with `Location`, which is what the code means: the
                        # request was understood and accepted, and the thing it
                        # created is over there.
                        reply = (202,
                                 {"job": job_id, "status_url": status_url,
                                  "log_url": f"{status_url}/log"},
                                 {"Location": status_url})
                    elif outcome == SUBMIT_QUEUE_FULL:
                        # Refused rather than queued, and the job says so rather
                        # than sitting in `queued` for ever: a job nothing will
                        # ever pick up is a status endpoint that never changes
                        # its answer.
                        jobs.finish(job_id, state=STATE_FAILED, code=503,
                                    error=QUEUE_FULL_ERROR)
                        logger.warning(
                            f"publish {pid}/{commit} refused: the build queue "
                            f"is full")
                        reply = (503, {"error": QUEUE_FULL_ERROR},
                                 {"Retry-After":
                                  str(QUEUE_FULL_RETRY_AFTER_SECONDS)})
                    else:
                        # The hub is stopping. A DIFFERENT refusal from the one
                        # above, and told apart here because both halves of the
                        # answer differ. The pusher is not waiting for a queue to
                        # empty, so there is no Retry-After to give — the hub is
                        # going away and coming back — and the JOB has already
                        # been answered, by the drain inside `shutdown` or by
                        # `submit` itself. Writing over it with "the build queue
                        # is full" replaced the one true sentence the hub had
                        # left to say with a sentence that was not true.
                        logger.warning(
                            f"publish {pid}/{commit} refused: the hub is "
                            f"stopping")
                        reply = (503, {"error": STOPPED_ERROR}, None)
            except PublishError as error:
                logger.warning(
                    f"publish {pid}/{commit} refused: {error.message}")
                reply = (error.status, {"error": error.message}, None)
            except (BrokenPipeError, ConnectionResetError):
                # The JOB outlives the socket, so it is answered before this
                # goes on its way to `do_POST`. Every other clause here answers
                # the PUSHER; a job left `queued` by an exception between
                # `jobs.create` and the handover is answered by nobody at all —
                # see `_fail_handover`.
                self._fail_handover(job_id, handed_over)
                raise
            except Exception:
                logger.exception(f"publish {pid}/{commit} failed")
                self._fail_handover(job_id, handed_over)
                reply = (500, {"error": "internal error"}, None)
            finally:
                # The worker owns the tree from the moment it is submitted, and
                # nobody does before that — including on the paths where this
                # answered 200, 409 or 503.
                if not handed_over:
                    shutil.rmtree(accepted.sources, ignore_errors=True)

            status, payload, extra = reply
            return self._json(status, payload, CACHE_NONE, extra)

        def _fail_handover(self, job_id, handed_over: bool) -> None:
            """Answer a job the handover threw underneath. Never raises.

            The window is two statements wide — `jobs.create` returns, and
            `builds.submit` is next — and the invariant it protects has no
            window in it: a job that never becomes terminal is one
            `_prune_locked` will not drop (it only ever drops a FINISHED job),
            so it holds a MAX_JOBS slot until the hub restarts while the status
            endpoint answers `queued` about a build nobody is running. Every
            other outcome of `_queue_build` already answers its job — the queue
            was full, the pool was stopping, a worker took it — and this is the
            one that used to answer nothing, because both handlers were written
            about the PUSHER and a 500 is not something a job can read.

            `handed_over` is what keeps this from lying in the other direction.
            Once `submit` has returned SUBMIT_ACCEPTED the task belongs to a
            worker, which is going to finish that job itself; anything thrown
            after that point — a logger, the reply tuple — must not fail a build
            that is at that moment running.

            The failure is recorded as a 500 because it is the hub's, not the
            push's: nothing about the sources was wrong, and the honest advice
            is the same one a restart gives, which is to push again.
            """
            if job_id is None or handed_over:
                return
            try:
                jobs.finish(job_id, state=STATE_FAILED, code=500,
                            error=HANDOVER_ERROR)
            except Exception:
                # `finish` is written not to raise; this runs from an exception
                # handler that must reach its own `raise` or its own reply, so
                # it cannot be the thing that replaces one failure with another.
                logger.exception(
                    f"job {job_id}: could not be failed after the handover "
                    f"threw; it stays queued until the hub restarts")

        # -- build jobs ------------------------------------------------
        def _serve_jobs(self, rest: list[str], with_body: bool):
            """GET /api/v1/jobs/<id>[/log] — for whoever pushed (SPEC 8A.2 step 5).

            Behind PUBLISH_TOKEN, and checked BEFORE the id is looked at, so a
            caller without it cannot use the difference between 401 and 404 to
            find out which jobs exist. An id this hub never issued and an id
            belonging to somebody else's push get the SAME 404: the id is the
            only thing separating one pusher's build log from another's, so a
            reply that confirms existence would hand out half of it.
            """
            if not self._require_token(publish_token, with_body):
                return None
            if not rest or len(rest) > 2:
                return self._error(404, "not found", with_body=with_body)
            if len(rest) == 2 and rest[1] != "log":
                return self._error(404, "not found", with_body=with_body)

            job_id = rest[0]
            record = jobs.get(job_id)
            if record is None:
                return self._error(404, "not found", with_body=with_body)

            if len(rest) == 2:
                # text/plain, because it is a build log and it is read by a
                # person or printed by CI. Never text/html — this is output the
                # model produced, on an origin that serves other people's builds.
                return self._send(
                    200, (jobs.log(job_id) or "").encode("utf-8"),
                    "text/plain; charset=utf-8", CACHE_NONE,
                    with_body=with_body)

            payload = dict(record)
            payload["log_url"] = f"/api/v1/jobs/{job_id}/log"
            return self._json(200, payload, CACHE_NONE, with_body=with_body)

        # -- comment queue, write side ---------------------------------
        def _handle_comment_resolve(self, cid: str):
            """POST /api/v1/comments/<id>/resolve — the agent closing an item."""
            if not self._require_token(settings.comment_read_token, close=True):
                return None
            if self.headers.get("Transfer-Encoding"):
                # Nothing here decodes chunked, and answering while leaving an
                # unread body on the socket would turn its remains into the next
                # request on a keep-alive connection.
                return self._error(411, "Content-Length is required",
                                   {"Connection": "close"})
            length = self.headers.get("Content-Length")
            note = None
            if length and length.isdigit() and int(length) > 0:
                if int(length) > MAX_RESOLVE_BODY_BYTES:
                    return self._error(413, "resolve body is too large",
                                       {"Connection": "close"})
                body, problem = self._read_body(int(length))
                if problem is not None:
                    status, message = problem
                    return self._error(status, message, {"Connection": "close"})
                try:
                    payload = json.loads(body.decode("utf-8"))
                except (UnicodeDecodeError, ValueError):
                    return self._error(422, "body is not valid JSON")
                if not isinstance(payload, dict):
                    return self._error(422, "body must be a JSON object")
                note = payload.get("note")
            try:
                record = comment_store.resolve(cid, note)
            except CommentError as error:
                return self._error(error.status, error.message)
            if record is None:
                return self._error(404, "not found")
            logger.info(f"comment {cid} resolved")
            return self._json(200, record)

        def _handle_comment_post(self, pid: str, commit: str):
            """POST /api/v1/comments/<pid>/<commit> — PUBLIC (SPEC 7A.2).

            The only endpoint that reads a body from an unauthenticated caller,
            so the order of what follows is the substance of the feature, not
            plumbing. Everything that can refuse without reading the body does so
            first: the route, the rate limit, then the byte ceiling against
            Content-Length. Only then is a byte pulled off the socket.

            Every early refusal closes the connection, for the same reason a
            refused publish does: the unread remains of the body would otherwise
            be parsed as the next request on a keep-alive connection.
            """
            # The local slot answers here as well as any commit does, and is
            # exactly the thing somebody looking over the author's shoulder wants
            # to comment on (SPEC 7.6). `latest` deliberately does NOT: it means
            # a different build tomorrow, so a comment filed against it would
            # stop naming the geometry it was about. The slot has the same
            # property in principle, but its whole audience is the one person who
            # can see what is on the screen right now.
            if not store.valid_pid(pid) or not (store.valid_build_id(commit)
                                                or commit == DEV_LINK):
                return self._error(404, "not found", {"Connection": "close"})
            # The build has to exist. A comment on a build that was never
            # published is spam by construction — nobody can have been looking at
            # it. The reverse is explicitly fine: a comment whose build retention
            # later deletes stays in the queue (SPEC 7A.3), because the check is
            # here, at write time, and nothing revisits it.
            if not (store.projects_dir / pid / commit / "meta.json").is_file():
                return self._error(404, "not found", {"Connection": "close"})

            # Before the body, not after: a rate limit that first accepts 20 MiB
            # and then says no has already done the work it exists to prevent.
            address = client_address(
                self.client_address[0] if self.client_address else "",
                self.headers.get("X-Forwarded-For", ""))
            allowed, retry_after = comment_limiter.allow(address)
            if not allowed:
                logger.warning(f"comment refused: rate limit hit by {address}")
                return self._error(
                    429, "too many comments from this address, retry later",
                    {"Connection": "close", "Retry-After": str(retry_after)})

            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                # Also the answer to a chunked body: nothing here decodes one,
                # and the ceiling below is applied to Content-Length, so a body
                # of unknown length cannot be bounded before it is read.
                return self._error(411, "Content-Length is required",
                                   {"Connection": "close"})
            if length < 0:
                return self._error(400, "invalid Content-Length",
                                   {"Connection": "close"})
            if length > settings.comment_max_body_bytes:
                return self._error(
                    413,
                    f"body is {length} bytes, limit is "
                    f"{settings.comment_max_body_bytes}",
                    {"Connection": "close"})

            body, problem = self._read_body(length)
            if problem is not None:
                status, message = problem
                return self._error(status, message, {"Connection": "close"})

            try:
                return self._store_comment(pid, commit, body)
            except CommentError as error:
                logger.warning(
                    f"comment on {pid}/{commit} refused: {error.message}")
                return self._error(error.status, error.message)
            except (BrokenPipeError, ConnectionResetError):
                raise
            except Exception:
                logger.exception(f"comment on {pid}/{commit} failed")
                return self._error(500, "internal error")

        def _store_comment(self, pid: str, commit: str, body: bytes):
            """Parse one multipart body and put the comment in the queue."""
            try:
                parts = parse_multipart(body,
                                        self.headers.get("Content-Type", ""))
            except MultipartError as error:
                raise CommentError(422, f"malformed form data: {error}") from error

            field = parts.get("comment")
            if field is None:
                raise CommentError(422, "the `comment` field is required")
            try:
                raw = json.loads(field.data.decode("utf-8"))
            except (UnicodeDecodeError, ValueError) as error:
                raise CommentError(
                    422, f"the `comment` field is not valid JSON: {error}"
                ) from error
            payload = validate_payload(raw, settings.comment_max_text_chars)

            # The attachments are taken by FIELD NAME and read as bytes. Their
            # filenames and their declared content types are dropped here and go
            # no further: `comments.sniff_image` decides what they are.
            attachments = {}
            for kind in (PHOTO_KIND, SHOT_KIND):
                part = parts.get(kind)
                if part is not None and part.data:
                    attachments[kind] = part.data

            record = comment_store.add(pid, commit, payload, attachments)
            # Only the id comes back. The text is never echoed to a public caller
            # and never rendered on a page (SPEC 7A.4) — that is what keeps this
            # endpoint off the XSS surface entirely.
            return self._json(201, {"id": record["id"]})

        def _read_body(self, length: int):
            """Read exactly `length` bytes into memory. (bytes, problem or None).

            The in-memory twin of `_spool_body`, and the difference is deliberate:
            a publish is up to 64 MiB and goes straight to disk, while a comment
            is capped at COMMENT_MAX_BODY_BYTES — single-digit megabytes — and
            has to be parsed as one multipart document anyway. The ceiling was
            already applied to Content-Length by the caller, so this cannot grow
            past it.

            `read1` rather than `read`, for the reason spelled out in
            `_spool_body`: the deadline has to be checked once per packet, not
            once per buffer fill, or a dribbling client is never noticed.
            """
            deadline = time.monotonic() + BODY_DEADLINE_SECONDS
            chunks = bytearray()
            remaining = length
            while remaining > 0:
                if time.monotonic() > deadline:
                    return bytes(chunks), (
                        408,
                        f"request body did not arrive within "
                        f"{BODY_DEADLINE_SECONDS}s")
                chunk = self.rfile.read1(min(remaining, 256 * 1024))
                if not chunk:
                    return bytes(chunks), (400, "request body ended early")
                chunks += chunk
                remaining -= len(chunk)
            return bytes(chunks), None

        def _spool_body(self, length: int, path: Path):
            """Copy exactly `length` bytes from the socket into `path`.

            None when the whole body arrived; otherwise (status, message) for the
            caller to answer with, because both ways this can fail are the
            client's and neither should be reported as a corrupt archive:

            * the client stopped early — `rfile.read(n)` on a socket can return
              short, and a truncated tarball would otherwise surface as a
              confusing 422 about the archive rather than the connection;
            * the body did not finish inside BODY_DEADLINE_SECONDS. The socket
              timeout cannot see this case at all: it measures the gap between
              packets and is rearmed by each one, so it is the deadline here that
              decides how long one client may keep a publish slot.

            Straight to disk rather than into a list of chunks joined at the end.
            That join is a second full copy, so a 64 MiB push peaked at 128 MiB of
            resident memory, and a few concurrent CI retries turned that peak into
            the OOM killer. `length` was checked against the ceiling above, so the
            file cannot outgrow it.
            """
            deadline = time.monotonic() + BODY_DEADLINE_SECONDS
            remaining = length
            with open(path, "wb") as out:
                while remaining > 0:
                    if time.monotonic() > deadline:
                        return (408,
                                f"request body did not arrive within "
                                f"{BODY_DEADLINE_SECONDS}s")
                    # read1, NOT read: `rfile` is a BufferedReader, and its
                    # `read(n)` loops internally until it has all n bytes or hits
                    # EOF. That is the whole 256 KiB, so control would not come
                    # back here — and the deadline above would go unchecked for
                    # exactly as long as the dribbling client cared to keep
                    # dribbling. `read1` comes back with whatever one syscall
                    # produced, so the check runs once per packet.
                    chunk = self.rfile.read1(min(remaining, 256 * 1024))
                    if not chunk:
                        return 400, "request body ended early"
                    out.write(chunk)
                    remaining -= len(chunk)
            return None

    return HubHandler


def create_server(settings, *, build_runner=None, build_workers=None,
                  build_queue_size=None) -> ThreadingHTTPServer:
    """Bind the listening socket and return the server, not yet serving.

    Binding here rather than inside serve_forever() is what lets a test ask for
    port 0 and then read back the port the OS actually chose.

    `build_runner` replaces `src.buildproc.run_build` for the build pool. It is a
    parameter rather than a setting because it is not configuration: a deployment
    has exactly one way to build a model, and the only caller that passes
    anything is a test that has to drive the whole pipeline without CadQuery, a
    subprocess or a real model — none of which the pipeline is about. Same for
    the two sizes: they have module defaults in `src.jobs` and are here so a test
    can stand up a one-worker pool with a queue of one and observe a full one.
    """
    store = Store(
        data_dir=settings.data_dir,
        retention_builds=settings.retention_builds,
        max_build_bytes=settings.max_build_bytes,
    )
    # A separate tree under the same data directory, and a separate object: the
    # comment queue outlives the builds it points at, so retention must have no
    # way to reach it (SPEC 7A.3).
    comment_store = CommentStore(
        data_dir=settings.data_dir,
        max_per_build=settings.comment_max_per_build,
        max_total=settings.comment_max_total,
        max_text_chars=settings.comment_max_text_chars,
        max_photo_bytes=settings.comment_max_photo_bytes,
    )
    # Constructed HERE and not lazily, because its constructor is what fails the
    # jobs a previous run left in flight: a hub that has started has no build
    # running, so anything still `queued` or `building` on the volume is stale by
    # definition and must stop claiming otherwise before the first status poll.
    job_store = JobStore(settings.data_dir)
    extra = {}
    if build_workers is not None:
        extra["workers"] = build_workers
    if build_queue_size is not None:
        extra["queue_size"] = build_queue_size
    builds = BuildQueue(store, job_store, build_runner=build_runner, **extra)
    handler = make_handler(store, comment_store, settings, job_store, builds)

    class Server(ThreadingHTTPServer):
        # Threads die with the process: a hung 2 MB download must never keep the
        # container alive after a stop signal.
        daemon_threads = True
        allow_reuse_address = True

        def server_close(self):
            # The build workers are stopped by the same call that closes the
            # socket, so there is one way to shut a hub down rather than two.
            # A worker that is mid-build is waited for: it is holding a staging
            # directory and is about to rename it into place, and killing it
            # there is how a half-published build happens.
            #
            # THE SOCKET GOES FIRST — and be precise about what that buys,
            # because the obvious reading is wrong. It is NOT that the hub would
            # otherwise accept a push during the stop: `serve_forever` has
            # already returned by the time this runs, so nothing is calling
            # `accept()` any more and no connection is being served from the
            # loop. The listening socket is unattended, not active.
            #
            # What it buys is that the socket stops LISTENING. An unattended
            # listening socket still completes handshakes in the kernel and
            # stacks them in the accept backlog, so for the whole of the stop —
            # the drain, then the join budget — a client that connects gets a
            # connection that looks established, sends its push into it and
            # waits for an answer nobody will ever write, until the process exits
            # and the connection dies unexplained. Closed first, the same client
            # is refused at once and can retry against whatever comes up next,
            # which is what a stopping service owes it. Nothing is waited for any
            # less: the join below still covers a worker in the middle of
            # publishing.
            super().server_close()
            builds.shutdown()

    server = Server((settings.host, settings.port), handler)
    server.store = store
    server.comment_store = comment_store
    server.jobs = job_store
    server.builds = builds
    # Last, so a bind that fails leaves no threads behind to be joined by nobody.
    builds.start()
    return server
