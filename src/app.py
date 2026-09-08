"""HTTP surface: the publish endpoint and the static site it produces.

Standard library only — `ThreadingHTTPServer` over `BaseHTTPRequestHandler`. What
this service does is receive a tarball and then serve files off disk, and neither
half is made simpler by a framework.

Routing (SPEC 3, 7.4):

    GET  /health                              liveness for the compose healthcheck
    GET  /                                    the front page shell, from templates/
    GET  /index.json                          what is on this hub      EDIT_TOKEN
    GET  /_v/<file>                           shared viewer bundle, one per site
    GET  /start                               how to start: three paths, the
                                              skill's version, and whether this
                                              hub is empty
    GET  /start/skill.md                      the agent instructions
    GET  /start/hammerola                     the client, as one file
    GET  /start/template.tar.gz               a model directory that builds
    GET  /project/<pid>/                      302 -> latest/
    GET  /project/<pid>/builds.json           build picker
    GET  /project/<pid>/latest/<file>         newest build of a commit, no-cache
    GET  /project/<pid>/dev/<file>            the local slot, no-cache
    GET  /project/<pid>/<commit>/<file>       one build's files, immutable forever
    GET  /project/<pid>/<commit>/             the page shell, from the template
    POST /api/v1/publish/<pid>                accept a push, 202 + a job; the
                                              HUB names the revision and the
                                              reply says which name
    POST /api/v1/publish/<pid>/<commit>       same, under a name the caller
                                              chose
    POST /api/v1/publish/<pid>/dev            same, into the local slot
    GET  /api/v1/jobs/<id>                    how that build is going  EDIT_TOKEN
    GET  /api/v1/jobs/<id>/log                what the build printed   EDIT_TOKEN

    GET  /api/v1/sources/<revision>           the code that built it   EDIT_TOKEN
    GET  /api/v1/sources/<revision>/log       and what it printed      EDIT_TOKEN

    POST   /api/v1/projects/<pid>/title       rename the project       EDIT_TOKEN
    DELETE /api/v1/projects/<pid>             remove it entirely       EDIT_TOKEN

    POST /api/v1/comments/<pid>/<commit>      leave a comment          EDIT_TOKEN
    GET  /api/v1/comments                     the queue                EDIT_TOKEN
    GET  /api/v1/comments/<id>                one comment              EDIT_TOKEN
    GET  /api/v1/comments/<id>/photo          its photo                EDIT_TOKEN
    GET  /api/v1/comments/<id>/shot           its rendered frame       EDIT_TOKEN
    POST /api/v1/comments/<id>/resolve        mark it handled          EDIT_TOKEN

ONE SECRET GUARDS EVERY WRITE AND EVERY PRIVATE READ (issue #26, step 0
of the plan), and there is exactly one string on the private side of it. There
used to be two, PUBLISH_TOKEN and COMMENT_READ_TOKEN, and writing a comment used
to be on the PUBLIC side; both facts are gone, and `_handle_comment_post` below
is no longer the odd one out on this service.

WHERE THE LINE RUNS IS NOT "pages public, API private", and it is worth being
exact because the two halves look inconsistent side by side. A BUILD is public:
its page, its meta.json, its geometry, all anonymous and cached for a year. That
is the product — a permanent link somebody was given and pasted into a chat, and
a link that asks the recipient for a secret is not one. THE LIST OF WHAT EXISTS
is not: `/index.json` is the only document that answers "what is on this hub",
nobody is handed it, and every id in it is the prefix of every permanent URL that
project will ever have. So the rule is that being given a link gets you that
build, and nothing gets you the enumeration.

`/start` IS THE ONE EXCEPTION TO THE SECOND HALF OF THAT, at the width of a
single boolean. It is public because it exists to be read by somebody who has no
token — the person who has just deployed this and is looking at a login form —
and it says whether anything has ever been published here, so that the sign-in
page offers what a first run needs instead of nothing. That page is written
(`ui/src/HammerolaEntry.jsx`, issue #48): when the boolean says the hub is
empty, the form carries five lines somebody hands to their agent, built out of
`skill` and `client` and the browser's own origin. Every one of the manifest's
four fields is read now, where the route once had no reader at all —
`hammerola create` follows `template`, and the door reads `empty` (the gate on
whether it draws the block) and then `skill` and `client`. What the
route must never grow is a number, a name or a date: `src/onboarding.py` carries
that argument in full, and `Store.empty` is the only thing on this service that
answers a question about the deployment without a token.

WHY THE COMMENT WRITE MOVED (SPEC 8A.1). This hub now BUILDS the code it is
sent, and an anonymous write was the first step of a path with no vulnerability
anywhere in it: anyone writes a comment -> it lands in the queue -> an agent
reads the queue as a task -> the agent edits model.py -> the hub executes
model.py. Closing the first step is what breaks the chain.

THE CODE OF A REVISION IS THE ONE THING THE SITE SERVES THAT IS NOT PUBLIC. A
build directory is world-readable and cached for a year; the sources that
produced it are behind EDIT_TOKEN and live in a tree the file server cannot
reach at all (issue #17). The hub is a forge, so it has to HOLD the code —
that is not the same as showing it.

THE TWO PROJECT ROUTES ARE THE ONLY ONES THAT UNMAKE SOMETHING, and what each of
them may touch is fixed by SPEC 3.1 rather than by convenience. `title` renames
the project and NOTHING ELSE: the id is what every permanent URL is built from,
those URLs serve builds cached for a year that cannot be recalled, so there is no
route that changes an id and there is not going to be one. `DELETE` removes the
whole project — never one build, because removing a build breaks a permanent URL
while removing the project takes away the thing the URL was about.

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

from hammerola import buildnames
from src import onboarding, render
from src.comments import (PHOTO_KIND, SHOT_KIND, CommentError, CommentStore,
                          normalize_since, validate_payload)
from src.jobs import (HANDOVER_ERROR, LOG_TRUNCATED_NOTE, MAX_LOG_BYTES,
                      QUEUE_FULL_ERROR, QUEUE_FULL_RETRY_AFTER_SECONDS,
                      STATE_FAILED, STOPPED_ERROR, SUBMIT_ACCEPTED,
                      SUBMIT_QUEUE_FULL, BuildQueue, BuildTask, JobStore)
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
# The two types the `/start` artefacts are served as. Markdown so the skill can
# be read in a browser as text — with `nosniff` on every reply, no browser
# renders it as a document — and gzip for the template, which is a tar.
MARKDOWN_TYPE = "text/markdown; charset=utf-8"
GZIP_TYPE = "application/gzip"

# Only the vendored bundle may be cached forever: its name carries the library's
# identity and it is replaced by a differently named file, never edited. Our own
# `hammerola.js` and `site.css` DO change with the image under a stable name, so
# an immutable year would leave people on the old page until 2027 after a deploy.
VENDORED_ASSET_PREFIX = "three-cad-viewer."

# The site icon, and the one asset with two URLs. The pages link it by its real
# name; `/favicon.ico` serves the same file for the clients that never parsed any
# HTML to find that link.
FAVICON_ASSET = "favicon.svg"

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
# it is behind EDIT_TOKEN, the note itself is capped at a couple of hundred
# characters by `comments.MAX_FIELD_CHARS`, and this only exists so the endpoint
# cannot be handed a megabyte to parse.
MAX_RESOLVE_BODY_BYTES = 8 * 1024

# The rename body: one JSON object with one short string in it. Deliberately
# smaller than the resolve ceiling above — a note explains what was done about a
# comment and can be a paragraph, while a title is a caption and `render` refuses
# anything past MAX_TEXT characters a moment later.
MAX_TITLE_BODY_BYTES = 2 * 1024

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
#
# WHAT LETS A TYPE ONTO THIS LIST is that a browser handed it cannot be made to
# EXECUTE anything with it — not that the type is common or that some file here
# happens to be one. `.png` qualifies: a decoder renders it and there is no
# script in it, so the build's previews (`assembled_preview.png` and the rest)
# are shown rather than downloaded. `image/svg+xml` does NOT and must never be
# added, however image-shaped it looks in a list of extensions: an SVG is a
# document that runs script in this origin. That is the same reason an SVG is
# refused on the way IN as a comment attachment — by `comments.sniff_image`,
# which decides an upload's type from its leading BYTES and names SVG explicitly
# to refuse it. `ATTACHMENT_CONTENT_TYPES` below is the other end of that one
# decision rather than the decision itself: a different table, for a different
# source of files, closed on three extensions because those three are all
# `sniff_image` ever stores.
BUILD_CONTENT_TYPES = {
    ".json": "application/json",
    ".stl": "model/stl",
    ".step": "model/step",
    ".stp": "model/step",
    ".3mf": "model/3mf",
    ".png": "image/png",
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


def _nonblocking(path, flags):
    """`open()`'s opener, adding O_NONBLOCK — see `_send_file` for why.

    An opener rather than `os.fdopen(os.open(...))`, and the difference is a
    descriptor leak rather than style: `os.open` SUCCEEDS on a directory, and
    the `os.fdopen` that follows then raises `IsADirectoryError` without closing
    what it was handed. Through an opener the descriptor belongs to CPython's
    `FileIO` the moment this returns, and `FileIO` closes it on every failure
    path of its own.

    NOT a rule for the whole repository, and the counter-example is deliberate:
    `Store._extract_members` keeps the `os.fdopen` shape with a hand-rolled
    `os.close` in its error branch, correctly, because its `os.open` carries
    `dir_fd=parent_fd`, which an opener's `(path, flags)` signature cannot pass.
    """
    return os.open(path, flags | os.O_NONBLOCK)


def _safe_name(name: str) -> bool:
    """One ordinary filename, and nothing that navigates.

    THE RULE IS NOT WRITTEN HERE, and that is the point of the indirection. It
    lives in `buildnames.unservable_reason`, because the other halves of it are
    the check every name a push DECLARES goes through
    (`render._check_declared_file`, from all five of the places a pointer can
    sit — a view's `file`, its `overview` and its `preview`, and a catalogue
    record's exported `files` and its own `preview`) and the client's
    own re-check of every name it is about to write to a disk
    (`hammerola/artifacts.py`) — and two copies of one rule is how a build came
    to publish with a 201 into an immutable directory and then answer 404 for a
    file it had named: the declaration took a leading dot and this did not
    (issue #53). Keeping the rule in one module is what stops that recurring,
    and `tests/test_publish.py` compares the answers over a table of names.

    Rejecting every name that starts with a dot does two jobs at once: it kills
    `.` and `..` outright, and it hides the bookkeeping files the store writes
    beside a build — `.payload.sha256` above all, which is what tells a retry
    from a collision and is nobody's business to read.

    SERVING GOT STRICTER WHEN THE RULE MOVED, and that was inherited rather than
    chosen: this used to be `bool(name) and not name.startswith(".") and "/" not
    in name`, and the shared rule adds the non-printable category to it. Through
    a URL that newly refuses `Cc` and `Cf` — a `%01`, a U+202E — and NOT a lone
    surrogate: the segment arrives via `unquote` (`_split` below), whose default
    is `errors='replace'`, so an undecodable byte is already a U+FFFD, category
    `So`. Lone surrogates are a DECLARATION-side matter, and only in ONE range:
    `\\udc80`-`\\udcff` is what `surrogateescape` turns back into a byte at the
    `os` layer, so a name carrying one can exist on disk (`os.stat('/tmp/x')`
    with `x = '\\udcff'` raises `FileNotFoundError` — the encode succeeded),
    while any other lone surrogate never reaches the filesystem at all
    (`'\\ud800'` raises `UnicodeEncodeError: surrogates not allowed`). Even in
    that range the `Cs` clause is the SECOND thing such a name meets:
    `render._check_declared_file` asks `name not in files` first, so a name out
    of a build's JSON reads as "did not declare" unless the build really wrote
    it AND declared it. Builds already on disk sit in immutable directories and
    cannot be re-pushed, so a name that got in before could now stop being
    served. Two things are why that is acceptable, and NEITHER of them is
    `store.SAFE_COMPONENT` — that alphabet holds the members of the uploaded
    ARCHIVE, which since the move is the model's SOURCE tree, while what gets
    served is what the BUILD wrote, and no alphabet is applied to an output name
    anywhere: `runner._verify_output_file` checks the path's shape, its symlinks
    and that the file exists, and stops there. What is true is that this service
    has never been deployed (AGENTS.md, step 0), so no build exists anywhere
    holding an old name to lose; and that an honest `cadbuild` writes only
    `<stem>.stl|.step|.3mf`, `<vid>.json`, `<stem>_preview.png`, `meta.json` and
    `metrics.json`. A DISHONEST model could have written such a name — it names
    its own output — which is exactly why the tightening is recorded here rather
    than passed over: "the file server started refusing a name it used to serve"
    is invisible until somebody opens a two-year-old build.

    It sits at MODULE level rather than on the handler — where it used to be —
    so a test can ask it directly: the handler class is minted per server inside
    the closure below, and a rule that is pinned against another module's copy
    has to be reachable without standing a server up.
    """
    return buildnames.unservable_reason(name) is None


def make_handler(store: Store, comment_store: CommentStore, settings,
                 jobs: JobStore, builds: BuildQueue):
    """Build the request handler class bound to one store and one settings object.

    A closure rather than class attributes so a test can stand up several
    independent servers in one process without any global state between them.
    """
    # One per server, for the same reason: two hubs in one test process must not
    # share a concurrency budget.
    publish_slots = threading.BoundedSemaphore(MAX_CONCURRENT_PUBLISHES)
    edit_token = settings.edit_token
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
                if head == onboarding.START_SEGMENT:
                    return self._serve_start(segments[1:], with_body)
                if head == "favicon.ico" and len(segments) == 1:
                    # SVG bytes at a `.ico` URL, deliberately. Every page links
                    # the icon by its real name, so this path is only ever taken
                    # by a client that arrived without parsing any HTML — and
                    # what decides how one renders is the Content-Type, which
                    # `_serve_asset` derives from the file's own extension. The
                    # alternative is generating and committing a binary .ico
                    # nobody would ever regenerate, for a URL almost nothing
                    # takes.
                    return self._serve_asset([FAVICON_ASSET], with_body)
                if head == "project":
                    return self._serve_project(segments[1:], trailing_slash,
                                               with_body)
                if segments[:3] == ["api", "v1", "comments"]:
                    return self._serve_comments(segments[3:], query, with_body)
                if segments[:3] == ["api", "v1", "jobs"]:
                    return self._serve_jobs(segments[3:], with_body)
                if segments[:3] == ["api", "v1", "sources"]:
                    return self._serve_sources(segments[3:], with_body)
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
            """The project cards — EDIT_TOKEN. Absent until the first push.

            THE ONE LIST OF EVERYTHING ON THIS HUB, and the only document here
            that answers "what exists". That is what puts it behind the token
            while a build page stays public, and the distinction is worth stating
            because it looks inconsistent from the outside: a build URL is a
            permanent link somebody was GIVEN, shared into a chat and cached for
            a year, and closing those would break what the service is for. This
            file is the opposite — nobody is given it, it is how you would find
            out that a project exists at all, and every id in it is the prefix of
            every permanent URL that project will ever have.

            Checked BEFORE the file is touched, like every other guarded route
            here: an unauthenticated caller must not be able to make the hub read
            anything off the volume, and must not be able to tell a hub with no
            projects from one with forty by how long the refusal takes.
            """
            if not self._require_token(with_body):
                return None
            path = store.root / "index.json"
            if not path.is_file():
                return self._json(200, [], CACHE_NONE, with_body=with_body)
            return self._serve_bytes(path.read_bytes(), "application/json",
                                     CACHE_NONE, with_body)

        # -- getting started -------------------------------------------
        def _serve_start(self, rest: list[str], with_body: bool):
            """`/start` and the three files it names. PUBLIC, all four.

            The whole argument for that — including why the manifest may say
            whether this hub is empty and may say nothing else about it — is in
            `src/onboarding.py`. In one line: these are read by somebody who does
            not have the token yet, and they are the software rather than a
            statement about what is published here.

            No cache. The three files change with the image under stable names,
            exactly like `site.css` and the bundle in `_serve_asset`, and the
            manifest carries a value that changes with the first push.

            THREE KINDS OF BREAKAGE ARE CAUGHT HERE and they are one thing: a
            defect of the ARTEFACT rather than of the request. An OSError means
            the image is missing a file the smoke gate checks for
            (`ci/smoke.py`, REQUIRED_PATHS). A ValueError means an archive
            cannot honestly be built out of what is here — the template tree
            holds a path no client would unpack
            (`onboarding._refuse_unservable`), or a module the client imports
            did not reach the image (`onboarding._refuse_unimportable`). An
            ImportError means the same defect arriving by the other road: the
            template builder borrows the CLIENT's own unpacking rules at call
            time, so a client module `.dockerignore` kept out takes this route
            down as well, and it does it with a ModuleNotFoundError rather than
            with either of the other two. Without that clause it was the one
            failure here that reached the socket as a dropped connection
            instead of an answer.

            All three are logged as such and answered 404 rather than 500,
            because "this hub does not serve that" is the true and useful answer
            to whoever asked. THE MANIFEST IS HELD TO THE SAME RULE, which it
            did not need while it opened no file: it now reads the version out
            of the shipped skill, so the two failures of that read get the same
            treatment one line further down.
            """
            if not rest:
                # THE MANIFEST OPENS A FILE TOO, since it began carrying the
                # version of the skill this image ships — so it can fail the
                # one way the three files below can, on an image whose
                # `SKILL.md` is missing or whose frontmatter lost its
                # `version:`. Same answer for the same reason: a defect of the
                # ARTEFACT is a logged 404, never an exception out of a request
                # handler, which reaches the browser as a dropped connection.
                try:
                    document = onboarding.manifest(empty=store.empty())
                except (OSError, ValueError) as error:
                    logger.error(f"cannot serve /start: {error}. The image's "
                                 f"skill file is missing or carries no version "
                                 f"in its frontmatter.")
                    return self._error(404, "not found", with_body=with_body)
                return self._json(200, document, CACHE_NONE,
                                  with_body=with_body)
            if len(rest) != 1:
                return self._error(404, "not found", with_body=with_body)
            builders = {
                onboarding.SKILL_NAME: (onboarding.skill_bytes, MARKDOWN_TYPE, {}),
                # Handed over as an attachment, like everything else here whose
                # bytes are not text: it is a zip with a shebang on it, and a
                # browser asked to display one has no better idea than to save it.
                onboarding.CLIENT_NAME: (onboarding.client_bytes, OCTET_TYPE,
                                         {"Content-Disposition": "attachment"}),
                onboarding.TEMPLATE_NAME: (onboarding.template_bytes, GZIP_TYPE,
                                           {"Content-Disposition": "attachment"}),
            }
            entry = builders.get(rest[0])
            if entry is None:
                return self._error(404, "not found", with_body=with_body)
            build, ctype, extra = entry
            try:
                body = build()
            except (OSError, ValueError, ImportError) as error:
                # All three causes the docstring names, because the reader of
                # this line has nothing else: the image is missing a file the
                # gate checks for, or holds a template path no client would
                # unpack, or did not carry a module the client imports. The
                # third was the one missing here.
                logger.error(f"cannot serve /start/{rest[0]}: {error}. The "
                             f"image is missing a file ci/smoke.py checks for, "
                             f"carries a template path no client would unpack, "
                             f"or is missing a module the client imports.")
                return self._error(404, "not found", with_body=with_body)
            return self._send(200, body, ctype, CACHE_NONE, extra, with_body)

        # -- static files ----------------------------------------------
        def _send_file(self, path: Path, cache: str, with_body: bool,
                       uploaded: bool = False, content: tuple | None = None):
            """Stream a file, refusing anything that resolves outside the store.

            The path was already assembled from whitelisted segments, so this
            check is defence in depth rather than the primary control — but it is
            the one that keeps holding if a future edit relaxes a segment rule,
            and it costs one stat. Note it must be done on the RESOLVED path:
            `latest` is a symlink, and following it is the whole point, so the
            question is not "is there a symlink" but "where did it land".

            `uploaded` says whether the bytes came out of a push, which decides
            how narrowly the content type is whitelisted. `content` overrides
            both the type and the extra headers outright, for the one file whose
            type is not a property of its NAME: a revision's source archive is
            served as an opaque attachment whatever it is called.
            """
            try:
                resolved = path.resolve(strict=True)
                resolved.relative_to(store.root)
            except (OSError, ValueError):
                return self._error(404, "not found", with_body=with_body)

            # Opened BEFORE the first header goes out. stat-then-open leaves a
            # window in which the file disappears between the two — the `dev`
            # slot being swapped, or somebody clearing space by hand — and the
            # client then gets a Content-Length with nothing behind it while the
            # log gets a traceback for a situation that is entirely normal.
            #
            # O_NONBLOCK IS WHAT MAKES THAT ORDER SAFE, and it is not an
            # optimisation: a plain `open()` on a FIFO blocks until a writer
            # appears, so the S_ISREG refusal just below is never reached and
            # the handler thread is gone for good. Model code writes its own
            # output directory and nothing on the build path stops it from
            # calling mkfifo there — an UNDECLARED one at that, which no
            # declaration check ever sees — and publication moves that directory
            # whole, so the fifo lands at a public URL. `runner._verified_files`
            # names the same hazard ("a fifo is a read that never returns") for
            # DECLARED names; this is the other half. On a regular file the flag
            # changes nothing about the read below.
            #
            # A DIRECTORY AND A FIFO ARE REFUSED IN TWO DIFFERENT PLACES, and
            # they are not one check: the directory never reaches `S_ISREG` at
            # all, because `open()` fstats what the opener handed it and raises
            # `IsADirectoryError` — caught here as the 404; the fifo passes the
            # open and is refused by `S_ISREG` below. Both land on the same
            # answer, which is why the leak this shape closed was invisible:
            # every response was already correct while `os.fdopen(os.open(...))`
            # lost one descriptor per request on a directory (see
            # `_nonblocking`), on a public unauthenticated route, until
            # `accept()` had none left.
            try:
                handle = open(resolved, "rb", opener=_nonblocking)
            except OSError:
                return self._error(404, "not found", with_body=with_body)
            with handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode):
                    return self._error(404, "not found", with_body=with_body)
                if content is not None:
                    ctype, extra = content
                elif uploaded:
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
            if len(rest) != 1 or not _safe_name(rest[0]):
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
                # Only the vendored bundle gets the immutable year. Our own
                # scripts and `site.css` change under a stable name with every
                # image, so `immutable` on them would pin visitors to the page
                # that shipped the day they first loaded the site.
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
            CHANGES with the image: the day the browser code needs one more
            element, every page has to have it. A copy written into each build directory
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
            not a build inside it: a project whose builds somebody has cleared
            out by hand is still a project, and `latest` is the honest thing to
            answer with.
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

            # The two moving names — `latest` for a commit, `dev` for the
            # author's laptop (SPEC 7.6) — are the only moving targets on the
            # whole site, so they are the only things that may not be cached; a
            # commit directory can never change and gets a year (SPEC 3.2, 7.4).
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

            if len(rest) != 3 or not _safe_name(rest[2]):
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
            if not self._require_token(with_body):
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

            These are the only bytes on the service that arrived outside the
            archive rules and are then handed back, so the content type comes
            from the closed set above and never from the request.
            `Content-Disposition: attachment` on top of it: the queue is read by
            a tool, not browsed, and an inline image is one content-type mistake
            away from being a page. Cached not at all — the URL is behind a
            token and the reader is an agent.
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
        def _authorized(self) -> bool:
            """Constant-time check of the bearer token (SPEC 7, 7A.2).

            ONE SECRET, so no parameter. This used to take the expected value
            because two tokens guarded two different things and neither could be
            accepted where the other belonged; since step 0 there is one string
            for the whole system (issue #26) and a parameter here would
            only be a place for a second one to reappear.

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
                presented.strip().encode("utf-8"), edit_token.encode("utf-8"))

        def _require_token(self, with_body: bool = True,
                           close: bool = False) -> bool:
            """Answer 401 and return False unless the caller presented the token.

            `close` for the verbs that carry a body: refusing before reading it
            leaves the remains on the socket, and on a keep-alive connection
            those would be parsed as the next request.
            """
            if self._authorized():
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
                # price than a fifth path segment on the comment endpoint.
                if segments[4] == "resolve":
                    return self._handle_comment_resolve(segments[3])
                return self._handle_comment_post(segments[3], segments[4])

            if segments[:3] == ["api", "v1", "projects"]:
                if len(segments) == 5 and segments[4] == "title":
                    return self._handle_rename(segments[3])
                return self._error(404, "not found", {"Connection": "close"})

            if segments[:3] != ["api", "v1", "publish"] or \
                    len(segments) not in (4, 5):
                return self._error(404, "not found", {"Connection": "close"})

            # Auth BEFORE the body is read: an unauthenticated caller must not be
            # able to make us receive 64 MiB just to be told no.
            if not self._authorized():
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

            pid = segments[3]
            # FOUR SEGMENTS IS THE MINTING ROUTE and five is the named one, and
            # the missing segment is the whole difference: the pusher has no name
            # for this revision, so the hub makes one out of the sources it
            # receives (`Store.mint_revision`). `dev` arrives as a name like any
            # other and stays the local slot (SPEC 7.6).
            #
            # A path segment rather than a query parameter or a header, because
            # the ABSENCE of the id is what is being expressed and a URL says
            # that by not having it. It also keeps the one rule this endpoint has
            # always had: where a build lands is decided by the URL, never by the
            # body.
            commit = segments[4] if len(segments) == 5 else None
            # For the log lines BEFORE the sources are hashed, where there is no
            # name yet on the minting route.
            target = f"{pid}/{commit}" if commit is not None else f"{pid} (new)"

            # Reading the body, unpacking it and hashing it all cost real memory
            # and disk, and nothing above this point limits how many connections
            # do it at once. The permit is taken BEFORE the body is read, so an
            # overloaded hub stops pulling bytes instead of accepting work it
            # cannot do.
            if not publish_slots.acquire(timeout=PUBLISH_WAIT_SECONDS):
                logger.warning(
                    f"publish {target} refused: no free slot after "
                    f"{PUBLISH_WAIT_SECONDS}s")
                return self._error(
                    503, "too many publishes in flight, retry later",
                    {"Connection": "close", "Retry-After": "30"})
            try:
                spool = store.upload_path()
                # WHAT TO ANSWER IS DECIDED HERE AND SENT BELOW THE CLEANUP, the
                # order `_queue_build` already keeps for the same reason: a
                # client that has been answered is entitled to assume the hub is
                # done with its push. `_error` writes to the socket where it is
                # called, so answering inside the `try` left every REFUSAL
                # racing its own `finally` — the pusher had its 408, 422 or 500
                # and the spool file was still on the volume. The successful
                # path never had that window (`_queue_build` is below the
                # `finally`), which is what made this look like a flaky test
                # rather than an ordering bug: it takes a loaded machine for the
                # request thread to lose the race, and CI is one.
                refusal = None          # (status, message, extra headers)
                accepted = None
                try:
                    problem = self._spool_body(length, spool)
                    if problem is not None:
                        status, message = problem
                        logger.warning(
                            f"publish {target} refused: {message}")
                        # Closed, like every other refusal that leaves bytes
                        # unread: on a keep-alive connection the remains of the
                        # body would be parsed as the next request.
                        refusal = (status, message, {"Connection": "close"})
                    else:
                        # `<pid>/dev` is the laptop's route (SPEC 7.6): the work
                        # has no commit to be addressed by, so it goes into the
                        # project's one local slot, overwriting whatever was
                        # there — the same name, the same meaning as in the URL
                        # people read. It is a reserved build name, so this can
                        # never shadow a commit that could otherwise have been
                        # published. Both routes are accepted identically; only
                        # the last step differs, and that step happens in the
                        # worker.
                        accepted = store.accept_sources(
                            pid, commit, spool, length)
                except PublishError as error:
                    logger.warning(
                        f"publish {target} refused: {error.message}")
                    refusal = (error.status, error.message, None)
                except (BrokenPipeError, ConnectionResetError):
                    # Handed to do_POST above rather than to `except Exception`
                    # below: these are subclasses of OSError, so without this
                    # clause a disconnect became `logger.exception` plus a second
                    # traceback from trying to answer on the closed socket. It
                    # still leaves through the `finally`, so the spool goes
                    # either way — there is simply nobody left to answer.
                    raise
                except Exception:
                    logger.exception(f"publish {target} failed")
                    refusal = (500, "internal error", None)
                finally:
                    try:
                        spool.unlink(missing_ok=True)
                    except OSError:
                        # Swallowed for the reason the same `finally` in
                        # `_queue_build` gives: this now runs BEFORE the reply is
                        # written, so a volume that will not take the unlink
                        # would turn an ordinary refusal into a dropped
                        # connection. The leftover is dot-prefixed and swept by
                        # `Store._sweep_leftovers`.
                        logger.exception(
                            f"publish {target}: the spooled body could not be "
                            f"removed")
                if refusal is not None:
                    status, message, extra = refusal
                    return self._error(status, message, extra)
                return self._queue_build(pid, accepted, minted=commit is None)
            finally:
                publish_slots.release()

        def _queue_build(self, pid: str, accepted, *, minted: bool):
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

            `minted` says the hub chose the name, and it decides one thing: the
            reply then carries `revision`, because the pusher has no other way to
            learn it. TWO IDENTIFIERS LEAVE HERE ON A 202 AND THEY ARE NOT THE
            SAME KIND OF THING — `job` addresses this BUILD (its progress, its
            log; it is unpredictable and per-attempt), `revision` addresses what
            the build will PUBLISH (permanent, immutable, the thing that gets
            pasted into a chat). A second push of the same sources gets a
            different job and the same revision, which is the whole point.
            """
            commit = accepted.commit
            # Only on the minting route: on the named one the caller already
            # knows the id it chose, and adding it would change a reply every
            # existing pusher parses.
            named = {"revision": commit} if minted else {}
            handed_over = False
            job_id = None
            reply = None            # (status, payload, extra headers)
            try:
                settled = store.settled(pid, commit, accepted.digest)
                if settled is not None:
                    status, payload = settled
                    reply = (status, {**payload, **named}, None)
                else:
                    record = jobs.create(pid, commit)
                    job_id = record["id"]
                    outcome = builds.submit(BuildTask(
                        job_id=job_id, pid=pid, commit=commit,
                        sources=accepted.sources, archive=accepted.archive,
                        digest=accepted.digest))
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
                                  "log_url": f"{status_url}/log", **named},
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
                # The worker owns the tree AND the body it came out of from the
                # moment the task is submitted, and nobody does before that —
                # including on the paths where this answered 200, 409 or 503.
                # None of those paths builds anything, so none of them publishes
                # a revision, so the body is not the code of one: it goes.
                if not handed_over:
                    shutil.rmtree(accepted.sources, ignore_errors=True)
                    try:
                        accepted.archive.unlink(missing_ok=True)
                    except OSError:
                        # Swallowed like `rmtree`'s failures right above it: this
                        # is a `finally` whose caller still has a reply to send,
                        # and a volume that will not take the unlink must not
                        # turn a 200 into a dropped connection. The leftover is
                        # dot-prefixed and swept by `Store._sweep_leftovers`.
                        logger.exception(
                            f"publish {pid}: the accepted body could not be "
                            f"removed after the push was answered")

            status, payload, extra = reply
            return self._json(status, payload, CACHE_NONE, extra)

        def _fail_handover(self, job_id, handed_over: bool) -> None:
            """Answer a job the handover threw underneath. Never raises.

            The window is two statements wide — `jobs.create` returns, and
            `builds.submit` is next — and the invariant it protects has no
            window in it: a job that never becomes terminal is one nothing can
            reclaim — the status endpoint answers `queued` about a build nobody
            is running, and goes on doing so until the hub restarts and `_load`
            fails it. Every
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

            Behind EDIT_TOKEN, and checked BEFORE the id is looked at, so a
            caller without it cannot use the difference between 401 and 404 to
            find out which jobs exist. An id this hub never issued and an id
            belonging to somebody else's push get the SAME 404: the id is the
            only thing separating one pusher's build log from another's, so a
            reply that confirms existence would hand out half of it.
            """
            if not self._require_token(with_body):
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

        # -- the code of a revision ------------------------------------
        def _serve_sources(self, rest: list[str], with_body: bool):
            """GET /api/v1/sources/<revision>[/log] (issue #17).

            THE CODE IS NOT PUBLIC, and this is the only way out of the store.
            Behind EDIT_TOKEN — the same secret that publishes, because there
            is one secret on this service and holding it means being allowed to
            do anything — and checked BEFORE the revision is looked at, so the
            difference between 401 and 404 cannot be used to find out which
            revisions the hub has the code of.

            EVERY MISS IS THE SAME 404: a revision that was never published, one
            whose build failed, one this hub stored before somebody removed the
            file by hand, and a segment that is not a revision id at all. The
            hub does not confirm what it holds — a build page is public, so
            "which revisions exist" is already known, but "whose code is on
            disk" is a different question and this endpoint answers it only by
            handing the code over.

            The archive decides existence, not the directory (`source_archive`):
            a directory holding only a log is what a rename killed half way
            through leaves, and it must read as absent rather than as half a
            revision.
            """
            if not self._require_token(with_body):
                return None
            if not rest or len(rest) > 2:
                return self._error(404, "not found", with_body=with_body)
            if len(rest) == 2 and rest[1] != "log":
                return self._error(404, "not found", with_body=with_body)

            revision = rest[0]
            # The same alphabet a build directory is named with, and for the same
            # reason: a revision id IS a build id (SPEC 7.7 — the hub names a
            # revision after the digest of its sources). So nothing here can
            # carry a separator or a dot component, and the path below is one
            # segment deep by construction.
            if not store.valid_build_id(revision):
                return self._error(404, "not found", with_body=with_body)
            archive = store.source_archive(revision)
            if not archive.is_file():
                return self._error(404, "not found", with_body=with_body)

            if len(rest) == 2:
                # text/plain for the same reason the job log is: this is output
                # the MODEL produced, on an origin that serves everybody's
                # builds. An empty body rather than a 404 when the log is
                # missing — the code is there, so the revision is, and 404 would
                # say something different and untrue.
                #
                # READ WITH A CEILING, for the reason `JobStore.log` spells out
                # about its own copy: `data/` is one volume and every build can
                # write anywhere in it, so the size of the file that comes back
                # is not a number this hub gets to decide. A model can plant a
                # multi-gigabyte `log.txt` beside an empty archive and this
                # branch would pull all of it into the request thread — the
                # container carries no memory ceiling on purpose (step 0).
                #
                # `MAX_LOG_BYTES` rather than a number of our own:
                # `Store.keep_build_log` already says the ceiling belongs to
                # whoever captured the log, and a second constant is how the
                # two come apart. Truncation is not written back, again as the
                # job copy reasons — the oversized file is evidence about a
                # build that misbehaved, and rewriting it destroys what
                # somebody came to read.
                log = store.source_log(revision)
                try:
                    with open(log, "rb") as handle:
                        raw = handle.read(MAX_LOG_BYTES + 1)
                except OSError:
                    raw = b""
                if len(raw) > MAX_LOG_BYTES:
                    logger.warning(
                        f"revision {revision}: its stored log is over "
                        f"{MAX_LOG_BYTES} bytes, which is more than a "
                        f"build can produce; serving it truncated")
                    raw = (raw[:MAX_LOG_BYTES]
                           + LOG_TRUNCATED_NOTE.encode("utf-8"))
                return self._send(200, raw, "text/plain; charset=utf-8",
                                  CACHE_NONE, with_body=with_body)

            # An opaque attachment, never a type a browser will act on: these are
            # bytes a pusher supplied, handed back whole. The filename is built
            # from the revision, which has just been through the id whitelist, so
            # there is nothing in it to quote or escape.
            return self._send_file(
                archive, CACHE_NONE, with_body,
                content=(OCTET_TYPE, {
                    "Content-Disposition":
                        f'attachment; filename="{revision}.tar.gz"'}))

        # -- the project itself: rename, and remove ---------------------
        def _handle_rename(self, pid: str):
            """POST /api/v1/projects/<pid>/title — the TITLE and nothing else.

            A project has an id and a name, and they are separate on purpose
            (SPEC 3.1): the id may not be derived from the name, because it would
            then change at exactly the moment it exists to survive. So this route
            renames and there is no route that re-identifies — every permanent
            URL of the project is built from the id, and the builds behind those
            URLs went out with a year of `immutable` and cannot be recalled.

            Behind EDIT_TOKEN, checked BEFORE anything about the project is
            looked at or touched. A project that does not exist and an id that is
            not one this hub could ever have get the SAME 404 with the same body,
            so the reply says nothing about which projects are on the volume that
            the public index does not already say.
            """
            if not self._require_token(close=True):
                return None
            if self.headers.get("Transfer-Encoding"):
                # Nothing here decodes chunked, and answering while leaving an
                # unread body on the socket would turn its remains into the next
                # request on a keep-alive connection.
                return self._error(411, "Content-Length is required",
                                   {"Connection": "close"})
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                return self._error(411, "Content-Length is required",
                                   {"Connection": "close"})
            if length < 0:
                return self._error(400, "invalid Content-Length",
                                   {"Connection": "close"})
            if length > MAX_TITLE_BODY_BYTES:
                return self._error(413, "title body is too large",
                                   {"Connection": "close"})
            body, problem = self._read_body(length)
            if problem is not None:
                status, message = problem
                return self._error(status, message, {"Connection": "close"})
            try:
                payload = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._error(422, "body is not valid JSON")
            if not isinstance(payload, dict):
                return self._error(422, "body must be a JSON object")
            try:
                # The same rule a build's own title goes through on the way in,
                # asked of the same function: a title set here is shown in the
                # same two places, so a second, looser rule here would be a way
                # to put on the index page what a push cannot.
                title = render.project_title(payload.get("title"))
            except ValueError as error:
                return self._error(422, str(error))

            # The body is read and validated BEFORE the project is looked for, so
            # that every refusal above happens without this hub saying whether
            # the project is there.
            if not store.valid_pid(pid) or not store.set_title(pid, title):
                return self._error(404, "not found")
            logger.info(f"project {pid} renamed")
            return self._json(200, {"pid": pid, "title": title})

        def do_DELETE(self):
            try:
                return self._handle_delete()
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
                return None

        def _handle_delete(self):
            """DELETE /api/v1/projects/<pid> — the whole project, all of it.

            THE ONLY WAY ANYTHING LEAVES THE VOLUME. There is no retention
            (SPEC 5.3) and no route that removes a single build, and the second
            of those is the deliberate half: a build's URL is permanent and
            immutable, so removing one build turns a promise into a 404 while
            leaving the project standing. Removing the PROJECT takes the promise
            away together with everything it was about — its builds, its
            pointers, its comment queue and the stored code of its revisions —
            which is the honest shape for "I made a test project and I am done
            with it" (issue #26).

            Behind EDIT_TOKEN and checked first, so nothing about a project is
            read or touched without it, and every miss is the same 404.
            """
            if not self._require_token(close=True):
                return None
            path = self.path.split("?", 1)[0]
            segments = self._split(path)
            if segments[:3] != ["api", "v1", "projects"] or len(segments) != 4:
                return self._error(404, "not found", {"Connection": "close"})
            # A body would sit unread on the socket and be parsed as the next
            # request. Nothing about this route takes one, so it is refused
            # rather than drained.
            if self.headers.get("Transfer-Encoding") or \
                    (self.headers.get("Content-Length") or "0").strip() not in \
                    ("", "0"):
                return self._error(400, "this endpoint takes no body",
                                   {"Connection": "close"})

            pid = segments[3]
            if not store.valid_pid(pid):
                return self._error(404, "not found")
            removed = store.remove_project(pid)
            if removed is None:
                return self._error(404, "not found")
            # After the project, and only for a project that existed: the queue
            # anchors to <pid>/<commit> (SPEC 7A.1), so once the builds are gone
            # every entry in it points at something nobody can open.
            removed["comments"] = comment_store.remove_project(pid)
            logger.info(f"project {pid} removed: {removed}")
            return self._json(200, removed)

        # -- comment queue, write side ---------------------------------
        def _handle_comment_resolve(self, cid: str):
            """POST /api/v1/comments/<id>/resolve — the agent closing an item."""
            if not self._require_token(close=True):
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
            """POST /api/v1/comments/<pid>/<commit> — EDIT_TOKEN (SPEC 7A.2).

            THE TOKEN IS CHECKED FIRST, ahead of the route and ahead of
            Content-Length, and that ordering is the point of step 0 rather than
            a detail. A caller without the secret must not be able to make this
            hub receive twenty megabytes and parse them as a multipart document
            just to be told no — and must not learn from a 404 which builds
            exist either, though that one is a formality here, because the build
            page is public anyway.

            This used to be the one endpoint that read a body from an
            unauthenticated caller, and everything below it was ordered around
            that. It no longer is (SPEC 8A.1: a hub that EXECUTES what it is
            sent cannot also take anonymous input into a queue an agent works
            from), so what remains below is ordinary bounding: refuse everything
            that can be refused without reading, then read.

            Every early refusal closes the connection, for the same reason a
            refused publish does: the unread remains of the body would otherwise
            be parsed as the next request on a keep-alive connection.
            """
            if not self._require_token(close=True):
                return None

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
            # it. The reverse is explicitly fine: a comment whose build somebody
            # later removes by hand stays in the queue (SPEC 7A.3), because the
            # check is here, at write time, and nothing revisits it.
            if not (store.projects_dir / pid / commit / "meta.json").is_file():
                return self._error(404, "not found", {"Connection": "close"})

            # NOTHING THROTTLES THIS ROUTE and nothing counts what is already in
            # the queue (SPEC 7A.4). A rate limit stood exactly here until
            # 2026-08-27, keyed on the client address read out of Traefik's
            # X-Forwarded-For; it was written when anybody who knew the URL could
            # post, and once the door took EDIT_TOKEN the only caller it could
            # ever refuse was the one holding the secret that also erases the
            # project. Everything from here down is about SIZE.
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
            # Only the id comes back. The text is never echoed to the caller
            # and never rendered on a page (SPEC 7A.4) — that is what keeps this
            # endpoint off the XSS surface entirely, and it stays true now that
            # the writer holds the token: the queue is still read by a tool, and
            # a page that rendered its own input would be a stored XSS on a
            # same-origin URL whatever the writer's credentials were.
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
        max_build_bytes=settings.max_build_bytes,
    )
    # A separate tree under the same data directory, and a separate object: a
    # comment is not part of the build it is about, so it must not inherit that
    # directory's year of `immutable` or its public reach (SPEC 7A.3).
    comment_store = CommentStore(
        data_dir=settings.data_dir,
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
