"""HTTP surface: the git server, the pre-receive hook's answer and the site.

Standard library only — `ThreadingHTTPServer` over `BaseHTTPRequestHandler`. What
this service does is take a push and then serve files off disk, and neither half
is made simpler by a framework.

Routing (SPEC 3, 7.4):

    GET  /health                              liveness for the compose healthcheck
    GET  /                                    the front page shell, from templates/
    GET  /index.json                          what is on this hub      EDIT_TOKEN
    GET  /_v/<file>                           shared viewer bundle, one per site
    GET  /start                               how to start: three paths, two
                                              versions, and whether this hub
                                              is empty
    GET  /start/skill.tar.gz                  the agent instructions, as the
                                              directory they are read from
    GET  /start/hammerola                     the client, as one file
    GET  /start/template.tar.gz               a model directory that builds
    GET  /favicon.ico                         the site icon, as SVG bytes
    GET  /project/<pid>/                      picks the pointer this reader last
                                              opened (SPEC 9) of the default
                                              variant; the URL without the
                                              slash 302s to this one
    GET  /project/<pid>/builds.json           the default variant's build
                                              picker, and the key to each
                                              build's files            EDIT_TOKEN
    GET  /project/<pid>/variants.json         the project's variants — its
                                              branches — the default first,
                                              each with its label
    GET  /project/<pid>/latest/<file>         newest build of a commit, no-cache
    GET  /project/<pid>/dev/<file>            the local slot, no-cache
    GET  /project/<pid>/v/<variant>/builds.json
                                              another variant's picker  EDIT_TOKEN
    GET  /project/<pid>/v/<variant>/latest/<file>
                                              that variant's `latest`, no-cache
    GET  /project/<pid>/v/<variant>/dev/<file>
                                              and its local slot, no-cache;
                                              the default variant has its own
                                              addresses above and none here
    GET  /project/<pid>/<commit>/<file>       one build's files, immutable forever;
                                              of these three, every file but
                                              `.json` and a document's own
                                              types (the STEP, STL, 3MF)
                                              EDIT_TOKEN or ?files=<key>;
                                              `<file>` may be a path, since a
                                              document keeps its place in the
                                              tree (`docs/cut-list.md`)
    GET  /project/<pid>/<commit>/             the page shell, from the template;
                                              `latest/` and `dev/` answer the
                                              same, and a URL without the slash
                                              302s to the one with it
    GET  /project/<pid>/<a>/compare/<b>/      the comparison page, always no-cache
    GET  /project/<pid>/<a>/compare/<b>/<name>?v=<view>
                                              scene.json and report.json of one
                                              computed comparison      EDIT_TOKEN
    POST /api/v1/compare/<pid>/<old>/<new>    measure two revisions
                                              against each other, 202 +
                                              a job whose LOG is the
                                              report                   EDIT_TOKEN
    POST /api/v1/compare/<pid>/<old>/<new>/<view>
                                              the same, and the job also
                                              builds the scene of that view
                                              for the page above       EDIT_TOKEN
    POST /api/v1/snapshot/<pid>/<build>       picture one build from an
                                              angle, `<build>` a revision,
                                              `latest` or `dev`; 202 + a
                                              job, its picture below   EDIT_TOKEN
    POST /api/v1/snapshot/<pid>/v/<variant>/<pointer>
                                              the same, of another
                                              variant's `latest` or `dev`
                                                                       EDIT_TOKEN
    POST /api/v1/measure/<pid>/<build>        how near two of its parts
                                              come, 202 + a job whose LOG
                                              is the answer            EDIT_TOKEN
    POST /api/v1/measure/<pid>/v/<variant>/<pointer>
                                              the same, of another
                                              variant's pointer        EDIT_TOKEN
    GET  /api/v1/jobs/<id>                    how that build is going  EDIT_TOKEN
    GET  /api/v1/jobs/<id>/log                what the build printed   EDIT_TOKEN
    GET  /api/v1/jobs/<id>/snapshot.png       what a snapshot job drew EDIT_TOKEN
    GET  /api/v1/logs/<pid>/<revision>        what the build of that
                                              revision printed         EDIT_TOKEN

    POST   /api/v1/projects/<pid>/title       rename the project       EDIT_TOKEN
    POST   /api/v1/projects/<pid>/names       rename the project, a
                                              variant, a view or a
                                              document by a commit to
                                              project.json, published
                                              as a revision            EDIT_TOKEN
    DELETE /api/v1/projects/<pid>             remove it entirely       EDIT_TOKEN

    GET  /git/<pid>.git/info/refs?service=<service>
                                              the refs, for one of the
                                              two services below       EDIT_TOKEN
    POST /git/<pid>.git/git-upload-pack       clone and fetch          EDIT_TOKEN
    POST /git/<pid>.git/git-receive-pack      push: a version or a
                                              draft                    EDIT_TOKEN
    POST /internal/pre-receive                the hook of that push asking
                                              whether it may go in     the hook's
                                                                       secret

    POST /api/v1/comments/<pid>/<commit>      leave a comment          EDIT_TOKEN
    POST /api/v1/comments/<pid>/v/<variant>/dev
                                              one on another variant's
                                              draft                    EDIT_TOKEN
    GET  /api/v1/comments                     the queue                EDIT_TOKEN
    GET  /api/v1/comments/<id>                one comment              EDIT_TOKEN
    GET  /api/v1/comments/<id>/photo          its photo                EDIT_TOKEN
    GET  /api/v1/comments/<id>/shot           its rendered frame       EDIT_TOKEN
    POST /api/v1/comments/<id>/resolve        mark it handled          EDIT_TOKEN

    GET    /api/v1/proposals/<pid>            the project's proposal   EDIT_TOKEN
    POST   /api/v1/proposals/<pid>            store it, replacing
                                              whatever was there       EDIT_TOKEN
    DELETE /api/v1/proposals/<pid>            put it away              EDIT_TOKEN

ONE SECRET, EDIT_TOKEN, guards every write and every private read.

The line is not "pages public, API private". A BUILD can be LOOKED AT by
anybody holding its address: its page, meta.json, the views and the pictures,
anonymous and cached for a year, because a shared link must work without a
secret, and so are the documents it lists, which are what its link with
`?d=` shows — whatever their extension, since a document may be a file the
page hands over rather than draws. Its other FILES — the ones this build does
not list as a document and whose extension is outside `OPEN_SUFFIXES`, so the
STEP, STL and 3MF — leave only to the token or to a link carrying the key of
that address (`files_key`), which the owner's Share window adds or leaves out.
THE ENUMERATION is not public at all: `/index.json` (what is on this hub) and
`builds.json` (every revision of a variant, and whether a draft exists) need
the token. A link gets you that build, and its files only if it says so;
nothing gets you the list. The list of a project's variants is the exception
the owner chose (SPEC §4): `variants.json` is open to anybody holding a link,
so a reader without the token switches variants as the owner does.

`/start` is the one exception, at the width of a single boolean: it is read
before login and says whether the hub is empty, so the sign-in page
(`ui/src/HammerolaEntry.jsx`) can offer first-run instructions. It must never
grow a number, a name or a date; see `src/onboarding.py`, which also names the
reader of each manifest field (`tests/test_onboarding.py` pins the set).
`Store.empty` is the only answer about the deployment given without a token.

Writing a comment needs the token (SPEC 8A.1): the hub executes the code it is
sent, and an anonymous comment could become an agent's task to edit model.py.

The code of a revision opens to no key: it is the commit it was built from, in
the project's git repository, which `git http-backend` serves under `/git/`
behind EDIT_TOKEN (`src/githttp.py`).

The two project routes are the only ones that unmake something (SPEC 3.1):
`title` renames and nothing else, since no route ever changes an id; `DELETE`
removes the whole project, never one build, since that would break a permanent
URL.

A push is `git push`, and the hub publishes inside it. git receives the
objects and runs the pre-receive hook before it moves any ref; the hook posts
the ref updates to `/internal/pre-receive`, where `src/prereceive.py` checks
every ref, builds what is to be built in the ordinary queue (`src/jobs.py`) and
publishes it, streaming the build's log back as the hook's output. A failed
build refuses the push. Once git has written the ref, the end of the request
recomputes `latest` from the branch (`githttp.end_of_request`).

Cache-Control is not a detail here, it is the load-bearing half of the URL scheme:
a commit directory is immutable by construction, so it gets a year; `latest` and
`dev` move, so they get none, and a weak ETag so that a revisit is a 304. `dev` is the only URL whose CONTENT is rewritten in
place (SPEC 7.6), and `no-cache` is precisely what makes that safe — which is why
it must never be able to fall through to the immutable branch.
"""

import hashlib
import hmac
import json
import os
import secrets
import stat
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote

from loguru import logger

from hammerola import buildnames
# `proposals` as a module: it exports a `validate_payload` of its own, and so
# does `src.comments`.
from src import githttp, onboarding, prereceive, proposals, render
from src.comments import (PHOTO_KIND, SHOT_KIND, CommentError, CommentStore,
                          normalize_since, validate_payload)
from src.buildproc import INSPECT_MEASURE, INSPECT_SNAPSHOT
from src.jobs import (QUEUE_FULL_ERROR, QUEUE_FULL_RETRY_AFTER_SECONDS,
                      SNAPSHOT_NAME, STATE_FAILED, STOPPED_ERROR,
                      SUBMIT_ACCEPTED, SUBMIT_QUEUE_FULL, BuildQueue,
                      CompareTask, InspectTask, JobStore)
from src.multipart import MultipartError, parse_multipart
from src.store import (BUILD_META_FILE, COMPARE_FILES, DEV_LINK, LATEST_LINK,
                       MAIN_BRANCH, POINTER_NAMES, PROJECT_BUILDS_FILE, SITE_INDEX_FILE,
                       VARIANT_SEGMENT, VARIANTS_FILE, ImportFailed, Store)

# SPEC 7.4. `immutable` tells a browser not to even revalidate on reload, which is
# only honest because a build directory can never change: republishing the same
# commit with different content is refused with a 409 rather than overwriting.
CACHE_IMMUTABLE = "public, max-age=31536000, immutable"
# The same year, only in the reader's own browser. The token travels in
# `TOKEN_HEADER`, not in `Authorization`, so RFC 9111 section 3.5 does not keep
# a shared cache off the request: a response with a lifetime and no `private`
# may be stored by a proxy and served to somebody who never presented the
# token. `private` is what keeps an answer behind EDIT_TOKEN out of one.
CACHE_IMMUTABLE_PRIVATE = "private, max-age=31536000, immutable"
CACHE_NONE = "no-cache"

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

HTML_TYPE = "text/html; charset=utf-8"
OCTET_TYPE = "application/octet-stream"
# The two types the `/start` artefacts are served as. Markdown so the skill can
# be read in a browser as text — with `nosniff` on every reply, no browser
# renders it as a document — and gzip for the template, which is a tar.
MARKDOWN_TYPE = "text/markdown; charset=utf-8"
GZIP_TYPE = "application/gzip"

# The site icon, and the one asset with two URLs. The pages link it by its real
# name; `/favicon.ico` serves the same file for the clients that never parsed any
# HTML to find that link.
FAVICON_ASSET = "favicon.svg"

# The pages load everything from this origin, so the policy is strict. It is
# the backstop for the validation on the way in (`render._plain_text`,
# `render.check_view_file`), not a substitute: it stops script, not a <form> or
# an overlaid <a>.
#
# `img-src 'self' data: blob:`: the vendored viewer css carries its toolbar
# icons as `data:image/svg+xml` custom properties (SPEC 2.2), and the KiCad
# viewer (`/_v/ecad-viewer.js`) draws its panel icons from an SVG sprite it
# builds into a `blob:` URL; `'self'` covers neither scheme, and an SVG loaded
# as an image cannot run script.
#
# `script-src 'self' 'wasm-unsafe-eval'`: the KiCad viewer triangulates its
# polygons with a WebAssembly module embedded in its own file, and the Gerber
# renderer (`/_v/wasm_gerber_processor.js`) is a WebAssembly module fetched
# from beside it. The keyword allows compiling WebAssembly and nothing else —
# no `eval` of JS, no inline script, no source but this origin (SPEC 7.4).
#
# `style-src 'unsafe-inline'`: the viewer writes `style="flex: 1"` attributes at
# runtime with model-dependent values (no hash or nonce possible), and without
# it the tab bar collapses. Inline styles cannot execute code.
CSP_HTML = ("default-src 'self'; img-src 'self' data: blob:; "
            "script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'")

# Extra headers on the three HTML pages: they are rendered in the theme the
# cookie asks for (`render.cookie_theme`), so one URL has two documents. The
# pages are `no-cache`, but a stored copy may still be revalidated.
PAGE_HEADERS = {"Vary": "Cookie"}

# Per-connection socket timeout, in seconds. See HubHandler.timeout below.
SOCKET_TIMEOUT = 30

# Ceiling on how long ONE request body may take to arrive, end to end.
#
# The socket timeout is rearmed by every packet, so a byte every 29 s would
# hold a thread forever (slowloris). A push has no size ceiling, so this is
# also what a big one has to beat: 300 s moves ~1 GB at ~27 Mbit/s sustained.
BODY_DEADLINE_SECONDS = 300

# Ceiling on the body of a resolve (one optional `note`, itself capped by
# `records.MAX_FIELD_CHARS`), so the endpoint is never handed a megabyte.
MAX_RESOLVE_BODY_BYTES = 8 * 1024

# The rename body: one JSON object with one short string (`render` refuses a
# title past MAX_TEXT).
MAX_TITLE_BODY_BYTES = 2 * 1024

# What `POST /api/v1/projects/<pid>/names` renames, each a key of project.json
# (`prereceive._rename`).
RENAMED_KINDS = ("project", "variant", "view", "document")

# The pre-receive hook's call: the ref lines of one push, a few quarantine
# paths and the push options, as JSON.
MAX_HOOK_BODY_BYTES = 1024 * 1024

# The header the hook presents the secret in, made by this process at start
# and handed to git's environment only (`githttp.hook_environment`).
HOOK_SECRET_HEADER = "X-Hammerola-Hook-Secret"

# The header carrying EDIT_TOKEN. Its own, so `Authorization` stays free for a
# password proxy in front of the hub (Traefik basicAuth forwards its
# `Authorization: Basic` to the backend); the hub never reads `Authorization`.
TOKEN_HEADER = "X-Hammerola-Token"

# What a missing or wrong token is answered with. 403 and never 401, and with no
# `WWW-Authenticate`: a browser that gets a 401 without the proxy's Basic
# challenge drops the credentials it holds for that proxy and asks for them
# again, so a stale token in the interface would cost the reader the proxy's
# login. A 401 therefore only ever comes from a proxy in front of the hub.
TOKEN_REFUSED_STATUS = 403

# A view id passes `cadbuild.hubspec.MEMBER_RE` at build time, but the
# comparison cache spells it as a directory, which is stricter. A sentence
# rather than a bare 404, because the author can rename the view. The name is
# not echoed (see `_handle_compare`).
VIEW_NOT_NAMEABLE_ERROR = (
    "this view cannot be compared: its name has to be a plain directory "
    "segment — letters, digits, dot, dash and underscore, starting with a "
    "letter or a digit, at most 128 characters. Rename the view and publish "
    "again."
)

# A view declared by only one of the two revisions has nothing to compare
# against: an ordinary case, still a 404, explained in words. The view is not
# echoed.
VIEW_NOT_IN_BOTH_ERROR = (
    "this view is not published in both revisions, so there is no pair of "
    "documents to build a comparison from. Compare a view both of them declare."
)

# The body of a snapshot or a measurement: a view, an angle and a few part
# names, as JSON.
MAX_INSPECT_BODY_BYTES = 8 * 1024

# The view a snapshot or a measurement is of when the request names none, if
# the build has it; otherwise its first. A copy of
# `cadbuild.artifacts.ASSEMBLED_VIEW_ID`, which the serving side may not
# import; `tests/test_inspect.py` holds the two equal.
DEFAULT_INSPECT_VIEW = "assembled"

# What a snapshot or a measurement of a build this hub does not hold is told.
NO_SUCH_BUILD_ERROR = "this project has no such build"

# Types our OWN files are served as — templates and generated JSON only.
CONTENT_TYPES = {
    ".html": HTML_TYPE,
    ".json": "application/json",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".map": "application/json",
    ".txt": "text/plain; charset=utf-8",
    # The Gerber renderer's module (static/_v/PROVENANCE.md): under any other
    # type `WebAssembly.instantiateStreaming` refuses it, and the module falls
    # back to the slower compile with a console warning.
    ".wasm": "application/wasm",
}

# Types a file that ARRIVED IN A PUSH is served as; everything else is an
# opaque attachment. The models' formats, and every type a build's documents
# may be (`render.DOCUMENT_TYPES`). HTML and SVG are among them and are
# served as themselves, scripts and all, WITHOUT the hub's CSP (`_send_file`):
# the owner's decision of 2026-10-23 (SPEC §4), on a hub with one user, so that
# a page or a drawing pushed by its author works as its author wrote it.
BUILD_CONTENT_TYPES = {
    ".json": "application/json",
    ".stl": "model/stl",
    ".step": "model/step",
    ".stp": "model/step",
    ".3mf": "model/3mf",
    ".png": "image/png",
    ".md": MARKDOWN_TYPE,
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".html": HTML_TYPE,
    ".htm": HTML_TYPE,
    ".svg": "image/svg+xml",
    # A KiCad design's files, which the page's viewer fetches and parses itself.
    **dict.fromkeys(render.KICAD_SUFFIXES, "text/plain; charset=utf-8"),
    # The 3D model of a board, and a board's Gerbers (`render.DOCUMENT_TYPES`).
    ".glb": "model/gltf-binary",
    ".zip": "application/zip",
    # The text documents, which the page reads and shows as they are; `.json`
    # among them keeps its own type, above.
    **{suffix: "text/plain; charset=utf-8" for suffix in render.TEXT_SUFFIXES
       if suffix != ".json"},
}

# A build file opens to anybody holding the build's address for one of two
# reasons, and this is the first of them: its EXTENSION. The documents the page
# draws the model from (meta.json and each view's tessellation), the pictures
# the front page shows through `<img>`, which carries no token, every type a
# document is DRAWN as, and the files of a KiCad design (decision of
# 2026-10-23, SPEC §4).
#
# The second reason is the build's OWN LIST, asked by `_listed_document`: a
# document may be a file of any extension (`render.FILE_TYPE`), so no table of
# extensions can answer for one, and a link with `?d=` has to show it without a
# key. That question is asked only of a request carrying neither the token nor
# a key, and it is about THIS build's meta.json, so what one project lists
# opens nothing in another.
#
# Everything else — the STEP, STL and 3MF a part exports, the overview meshes,
# and any format a later export adds — leaves only to EDIT_TOKEN or to a link
# carrying the key of its address (`files_key`). A list of what is OPEN rather
# than of what is closed, so a new format starts closed, and a part's exports
# stay closed however many files of their extension a project lists beside them.
OPEN_SUFFIXES = {".json", *render.DOCUMENT_TYPES, *render.KICAD_SUFFIXES}

# The body of the refusal of a closed file asked for without the token or the
# key; the status is `TOKEN_REFUSED_STATUS`, for its reasons.
FILES_REFUSED_ERROR = "this link does not include the files of this build"


def files_key(token: str, pid: str, build: str) -> str:
    """The key that opens the files of one build address, `<pid>/<build>`.

    The ONLY place a key is derived. `build` is the address past
    `/project/<pid>/` as asked for — `latest`, `dev`, a revision, or
    `v/<variant>/latest` and `v/<variant>/dev` — so a key opens exactly the
    address it was made for: the key of `latest` opens whatever `latest` is
    now and later, a revision's key that revision only, and one variant's
    `latest` key no other variant's. Derived from EDIT_TOKEN and stored
    nowhere, so there is no second secret and no table of links, and changing
    the token revokes every key at once. No id can hold a `/`
    (`store.SAFE_ID`), so the joined message is unambiguous. 32 hex
    characters, 128 bits.
    """
    return hmac.new(token.encode("utf-8"), f"{pid}/{build}".encode("utf-8"),
                    hashlib.sha256).hexdigest()[:32]


# Types a comment attachment may be served as: the three extensions
# `comments.sniff_image` stores, decided from the file's leading bytes. No SVG.
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


def _safe_name(name: str) -> bool:
    """One ordinary filename under `/_v/`, and nothing that navigates.

    The shared name rule, `buildnames.unservable_reason`, on the one segment
    `/_v/<file>` takes; a build's files go through `_safe_build_path`.
    Rejecting a leading dot kills `.` and `..`; a URL segment arrives via
    `unquote` with `errors='replace'`, so it never carries a lone surrogate.

    Module-level so tests can call it without a server.
    """
    return buildnames.unservable_reason(name) is None


def _safe_build_path(path: str) -> bool:
    """A file under `/project/<pid>/<commit>/`, which may sit in a subdirectory.

    The name rule on every segment (`buildnames.unservable_path_reason`), the
    rule a document's path is declared under; a model's pointers are held to
    the same name rule on a single segment (`render._check_declared_file`), so a
    build can never declare a file this then refuses (`tests/test_publish.py`
    compares them), and the client re-checks both before writing
    (`hammerola/artifacts.py`).

    Rejecting a leading dot on every segment kills `.` and `..` at any depth and
    hides the store's bookkeeping files (`.payload.sha256`). Non-printable names
    (categories Cc, Cf) are refused too. Output names get no alphabet elsewhere
    (`runner._verify_output_file` checks shape, symlinks and existence only); an
    honest `cadbuild` writes only `<stem>.stl|.step|.3mf`, `<vid>.json`,
    `<stem>_preview.png`, `meta.json` and `metrics.json`, all at the top.

    Module-level so tests can call it without a server.
    """
    return buildnames.unservable_path_reason(path) is None


def _route_rest(pattern, segments: list[str]) -> list[str] | None:
    """The segments past `pattern`'s prefix, or None when it does not match.

    A pattern is `(prefix, count)`: the leading segments a route claims and,
    for a route of one fixed length, how many segments the whole path has. A
    `count` of None hands everything under the prefix to the route.
    """
    prefix, count = pattern
    if tuple(segments[:len(prefix)]) != prefix:
        return None
    if count is not None and len(segments) != count:
        return None
    return segments[len(prefix):]


def _route_comment(handler, rest, query, trailing_slash, with_body):
    return (handler._handle_comment_resolve(rest[0])
            if rest[1] == "resolve"
            else handler._handle_comment_post(rest[0], rest[1]))


def _route_variant_comment(handler, rest, query, trailing_slash, with_body):
    return (handler._handle_comment_post(rest[0], rest[3], variant=rest[2])
            if rest[1] == VARIANT_SEGMENT
            else handler._error(404, "not found", {"Connection": "close"}))


def _route_proposal(handler, rest, query, trailing_slash, with_body):
    return (handler._handle_proposal_post(rest[0])
            if len(rest) == 1
            else handler._error(404, "not found", {"Connection": "close"}))


class InspectRefused(ValueError):
    """A snapshot or a measurement that cannot be taken: the status it is
    answered with, and the sentence."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def inspection(kind: str, payload, meta: dict) -> dict:
    """What a snapshot or a measurement asks of one build, checked against that
    build's meta.json. -> `{"view", "angle", "hide", "parts"}`.

    The view and every part name are held to what meta.json declares (a view's
    `parts` are exactly the keys its file shows, `render._match_selection`),
    so a name that is not there is refused before anything is queued, with a
    sentence listing what is; the caller's own words are not echoed. The angle
    goes on as it came: `preview_png.camera_angles` reads it, in the child.
    """
    if not isinstance(payload, dict):
        raise InspectRefused(422, "the body must be a JSON object")
    views = [view for view in meta.get("views") or []
             if isinstance(view, dict)]
    ids = [view.get("id") for view in views]
    if not ids:
        raise InspectRefused(404, "this build holds documents only, so there "
                                  "is no view to picture or measure")
    view = payload.get("view")
    if view is None:
        view = DEFAULT_INSPECT_VIEW if DEFAULT_INSPECT_VIEW in ids else ids[0]
    if view not in ids or not Store.valid_view_id(view):
        raise InspectRefused(404, f"this build has no such view; its views "
                                  f"are {', '.join(map(str, ids))}")
    shown = views[ids.index(view)].get("parts") or []
    asked = {"view": view, "angle": None, "hide": (), "parts": ()}
    if kind == INSPECT_SNAPSHOT:
        angle, named = payload.get("angle"), payload.get("hide", [])
        if not isinstance(angle, str) or not isinstance(named, list):
            raise InspectRefused(422, "a snapshot takes `angle`, a string, "
                                      "and `hide`, a list of part names")
        asked.update(angle=angle, hide=tuple(named))
    else:
        named = payload.get("parts")
        if not isinstance(named, list) or len(named) != 2:
            raise InspectRefused(422, "a measurement takes `parts`, a list "
                                      "of two part names")
        asked["parts"] = tuple(named)
    if any(name not in shown for name in named):
        raise InspectRefused(404, f"view {view} shows no such part; its parts "
                                  f"are {', '.join(map(str, shown))}")
    return asked


def _route_project(handler, rest, query, trailing_slash, with_body):
    if len(rest) == 2 and rest[1] == "title":
        return handler._handle_rename(rest[0])
    if len(rest) == 2 and rest[1] == "names":
        return handler._handle_names(rest[0])
    return handler._error(404, "not found", {"Connection": "close"})


# One entry per route, tried in order: a narrow route must stay above a wider
# one that would also match.
GET_ROUTES = (
    (((), 0),
     lambda handler, rest, query, trailing_slash, with_body:
         handler._serve_page(render.index_page_html, with_body)),
    ((("health",), 1),
     lambda handler, rest, query, trailing_slash, with_body:
         handler._json(200, {"status": "ok"}, CACHE_NONE,
                       with_body=with_body)),
    (((SITE_INDEX_FILE,), 1),
     lambda handler, rest, query, trailing_slash, with_body:
         handler._serve_index_json(with_body)),
    ((("_v",), None),
     lambda handler, rest, query, trailing_slash, with_body:
         handler._serve_asset(rest, with_body)),
    (((onboarding.START_SEGMENT,), None),
     lambda handler, rest, query, trailing_slash, with_body:
         handler._serve_start(rest, with_body)),
    # SVG bytes at a `.ico` URL, deliberately: pages link the icon by
    # its real name, and the Content-Type comes from the file's own
    # extension.
    ((("favicon.ico",), 1),
     lambda handler, rest, query, trailing_slash, with_body:
         handler._serve_asset([FAVICON_ASSET], with_body)),
    ((("project",), None),
     lambda handler, rest, query, trailing_slash, with_body:
         handler._serve_project(rest, trailing_slash, with_body, query)),
    ((("api", "v1", "comments"), None),
     lambda handler, rest, query, trailing_slash, with_body:
         handler._serve_comments(rest, query, with_body)),
    ((("api", "v1", "proposals"), None),
     lambda handler, rest, query, trailing_slash, with_body:
         handler._serve_proposal(rest, with_body)),
    ((("api", "v1", "jobs"), None),
     lambda handler, rest, query, trailing_slash, with_body:
         handler._serve_jobs(rest, with_body)),
    ((("api", "v1", "logs"), None),
     lambda handler, rest, query, trailing_slash, with_body:
         handler._serve_build_log(rest, with_body)),
    # HEAD reaches this entry too, and is none of the three git requests.
    (((githttp.ROUTE,), None),
     lambda handler, rest, query, trailing_slash, with_body:
         handler._serve_git("GET" if with_body else "HEAD", rest, query,
                            with_body)),
)

# One entry per route, tried in order.
POST_ROUTES = (
    # Two routes share this shape: `<pid>/<commit>` to leave a
    # comment and `<id>/resolve` to close one. A build named
    # `resolve` can be published and served but not commented on.
    ((("api", "v1", "comments"), 5), _route_comment),
    ((("api", "v1", "comments"), 7), _route_variant_comment),
    ((("api", "v1", "proposals"), None), _route_proposal),
    ((("api", "v1", "projects"), None), _route_project),
    ((("api", "v1", "compare"), None),
     lambda handler, rest, query, trailing_slash, with_body:
         handler._handle_compare(rest)),
    ((("api", "v1", INSPECT_SNAPSHOT), None),
     lambda handler, rest, query, trailing_slash, with_body:
         handler._handle_inspect(INSPECT_SNAPSHOT, rest)),
    ((("api", "v1", INSPECT_MEASURE), None),
     lambda handler, rest, query, trailing_slash, with_body:
         handler._handle_inspect(INSPECT_MEASURE, rest)),
    (((githttp.ROUTE,), None),
     lambda handler, rest, query, trailing_slash, with_body:
         handler._serve_git("POST", rest, query, with_body)),
    ((tuple(githttp.HOOK_PATH.strip("/").split("/")), 2),
     lambda handler, rest, query, trailing_slash, with_body:
         handler._handle_pre_receive()),
)

DELETE_ROUTES = (
    ((("api", "v1", "projects"), 4),
     lambda handler, rest, query, trailing_slash, with_body:
         handler._remove_project(rest[0])),
    ((("api", "v1", "proposals"), 4),
     lambda handler, rest, query, trailing_slash, with_body:
         handler._remove_proposal(rest[0])),
)


class HubHandler(BaseHTTPRequestHandler):
    # HTTP/1.1 for keep-alive: a build page pulls meta.json, a 2 MB view and,
    # for the owner, builds.json, and a fresh connection for each is pure
    # latency. Every reply below therefore carries an accurate Content-Length,
    # which is what makes persistent connections legal.
    protocol_version = "HTTP/1.1"
    server_version = "hammerola"
    sys_version = ""

    # Passed to the socket; without it a read blocks forever, and the
    # connection is accepted before the token (in a header) can be checked.
    timeout = SOCKET_TIMEOUT

    # -- plumbing --------------------------------------------------
    def log_message(self, fmt, *args):
        # Access logs at DEBUG: at INFO they would bury the startup line the
        # CI smoke gate greps for, and every 2 MB view fetch is one more line.
        logger.debug(f"{self.address_string()} {fmt % args}")

    def _headers(self, status: int, content_type: str, length: int,
                 cache: str, extra: dict | None = None, own: bool = True):
        """The one place a response line and its headers are written.

        `nosniff` on every reply, so the browser cannot override the
        content-type policy; on the hub's OWN HTML, the CSP. `own` is False for
        a file that arrived in a push: an HTML document of a build is its
        author's page and runs as written (see BUILD_CONTENT_TYPES).
        """
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        if own and content_type.startswith("text/html"):
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

        Unquoted BEFORE validation, so `%2e%2e` becomes `..` and the
        whitelist sees it.
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
            for pattern, call in GET_ROUTES:
                rest = _route_rest(pattern, segments)
                if rest is not None:
                    return call(self, rest, query, trailing_slash, with_body)
        except (BrokenPipeError, ConnectionResetError):
            # The client went away mid-download: ordinary, not an error.
            self.close_connection = True
            return None

        return self._error(404, "not found", with_body=with_body)

    def _serve_page(self, page, with_body: bool):
        """One of the three HTML documents, in this reader's own theme.

        One place for all three: the theme comes from the cookie and the reply
        carries `Vary: Cookie`. `page` makes the document for a theme.
        """
        theme = render.cookie_theme(self.headers.get("Cookie", ""))
        self._send(200, page(theme).encode("utf-8"), HTML_TYPE, CACHE_NONE,
                   PAGE_HEADERS, with_body)
        return None

    def _serve_index_json(self, with_body: bool):
        """The project cards — EDIT_TOKEN. Absent until the first push.

        The enumeration of the hub, hence behind the token (see the module
        docstring). The token is checked before the file is touched, so the
        refusal reveals nothing about the volume, not even by timing.

        `status` (what the project's draft is doing now) is live, so
        `render.index_card` writes it as null and it is filled here from the
        draft pointer and the job registry. Commit builds in flight write no
        pointer and stay invisible: a card describes what was published
        (SPEC 7.6).

        A file that is not a valid index is answered `[]` with a log line, as
        an absent one is.
        """
        if not self._require_token(with_body):
            return None
        path = self.server.store.site_index_path()
        if not path.is_file():
            return self._json(200, [], CACHE_NONE, with_body=with_body)
        try:
            cards = json.loads(path.read_bytes())
            for card in cards:
                card["status"] = self._draft_status(card["pid"])
        except (ValueError, OSError, TypeError, KeyError) as error:
            logger.warning(
                f"the site index could not be read ({error}); answering "
                f"with an empty list")
            return self._json(200, [], CACHE_NONE, with_body=with_body)
        return self._json(200, cards, CACHE_NONE, with_body=with_body)

    def _draft_status(self, pid: str) -> str:
        """One card's `status`: what this project's draft is doing.

        No pointer, an unknown job or any state: `render.card_status` maps
        each to one of its three words.
        """
        job_id = self.server.store.draft_job(pid)
        record = None if job_id is None else self.server.jobs.get(job_id)
        return render.card_status(None if record is None
                                  else record["state"])

    # -- getting started -------------------------------------------
    def _serve_start(self, rest: list[str], with_body: bool):
        """`/start` and the three files it names. PUBLIC, all four.

        Read before login; see `src/onboarding.py` for why the manifest may
        say whether the hub is empty and nothing else. No cache: the files
        change with the image under stable names.

        Defects of the ARTEFACT are logged and answered 404: OSError (a file
        missing from the image, cf. `ci/smoke.py` REQUIRED_PATHS), ValueError
        (`onboarding._refuse_unservable` or `_refuse_unimportable`) and
        ImportError (a client module missing from the image, met by the
        template builder). The manifest reads the skill's files for their
        digest and is held to the same rule.
        """
        if not rest:
            # The manifest reads every file of the skill for its digest, so it
            # can fail the same way: a logged 404.
            try:
                document = onboarding.manifest(empty=self.server.store.empty())
            except OSError as error:
                logger.error(f"cannot serve /start: {error}. A file of the "
                             f"image's skill cannot be read.")
                return self._error(404, "not found", with_body=with_body)
            return self._json(200, document, CACHE_NONE,
                              with_body=with_body)
        if len(rest) != 1:
            return self._error(404, "not found", with_body=with_body)
        builders = {
            onboarding.SKILL_NAME: (onboarding.skill_bytes, GZIP_TYPE,
                                    {"Content-Disposition": "attachment"}),
            # An attachment: a zip with a shebang.
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
            # The three artefact defects named in the docstring.
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

        Defence in depth over whitelisted segments, done on the RESOLVED path
        (`store.resolve_inside`): `latest` is a symlink and following it is
        intended; the question is where it lands.

        `uploaded` says whether the bytes came out of a push, which decides
        how narrowly the content type is whitelisted. `content` overrides
        both the type and the extra headers outright, for the one file whose
        type is not a property of its NAME: a revision's source archive is
        served as an opaque attachment whatever it is called.
        """
        try:
            resolved = self.server.store.resolve_inside(path)
        except (OSError, ValueError):
            return self._error(404, "not found", with_body=with_body)

        # Opened before the first header: the file may vanish (e.g. the `dev`
        # slot being swapped), and a sent Content-Length cannot be retracted.
        try:
            handle = open(resolved, "rb")
        except OSError:
            return self._error(404, "not found", with_body=with_body)
        with handle:
            info = os.fstat(handle.fileno())
            if content is not None:
                ctype, extra = content
            elif uploaded:
                ctype, extra = build_content_type(resolved.name)
            else:
                ctype, extra = content_type_for(resolved.name), {}
            # A pointer (`latest`, `dev`) is `no-cache`, and with no validator
            # that is the whole file again on every visit: 40 MB for the 3D
            # model of a board. The weak tag comes from the open file's size,
            # mtime and inode, which change whenever its bytes do (`dev` is
            # rewritten in place) and stay put when a revision change leaves
            # a file as it was (the same hard link).
            if cache == CACHE_NONE:
                tag = 'W/"{:x}-{:x}-{:x}"'.format(
                    info.st_size, info.st_mtime_ns, info.st_ino)
                extra = {**extra, "ETag": tag}
                if self.headers.get("If-None-Match") == tag:
                    self._headers(304, ctype, 0, cache, extra,
                                  own=not uploaded)
                    return None
            # Size from the open handle: the bytes about to be sent.
            self._headers(200, ctype, info.st_size, cache, extra,
                          own=not uploaded)
            if not with_body:
                return None
            # In chunks: views and STEP files are megabytes.
            while True:
                chunk = handle.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
        return None

    def _serve_asset(self, rest: list[str], with_body: bool):
        """/_v/<file> — the shared viewer bundle, from the IMAGE not from data/.

        One copy for the entire site, not per build (SPEC 2.3).
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
            # No immutable year here: every file under `static/_v/` changes
            # under a stable name with the image (`make viewer` rewrites
            # `three-cad-viewer.esm.js` too).
            #
            # `no-cache` is affordable only with a validator, or every visit
            # refetches megabytes. Weak, from size and mtime rather than a
            # hash: every file here is written by `make ui`, `make viewer` or
            # the image build, which set a fresh mtime.
            etag = 'W/"{:x}-{:x}"'.format(info.st_size, info.st_mtime_ns)
            # Browsers echo the tag they were given; equality suffices.
            if self.headers.get("If-None-Match") == etag:
                self._headers(304, content_type_for(path.name), 0,
                              CACHE_NONE, {"ETag": etag})
                return None
            self._headers(200, content_type_for(path.name), info.st_size,
                          CACHE_NONE, {"ETag": etag})
            if not with_body:
                return None
            while True:
                chunk = handle.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
        return None

    def _serve_build_page(self, build_dir: Path, with_body: bool, page: str):
        """The shell of a build page — from the IMAGE, never from the build.

        The same for every build and changing with the image, so it is served
        from the template with no-cache rather than frozen into an immutable
        build directory. Everything build-specific comes from meta.json at
        runtime, except the link-preview tags a messenger reads, since it runs
        no script (`_link_preview`).

        Existence is decided by meta.json, not the directory (a restore or a
        hand-copy can leave a directory without one).
        """
        try:
            self.server.store.resolve_inside(build_dir / BUILD_META_FILE)
        except (OSError, ValueError):
            return self._error(404, "not found", with_body=with_body)
        preview = self._link_preview(build_dir, page)
        return self._serve_page(
            lambda theme: render.build_page_html(theme, preview), with_body)

    def _link_preview(self, build_dir: Path, page: str) -> str:
        """The link-preview tags of the build in `build_dir`
        (`render.link_preview`), or "" when its meta.json cannot be read. Their
        picture is named against `page`, the path of that build's directory,
        made absolute with the request's `X-Forwarded-Proto` and `Host`.
        """
        scheme = self.headers.get("X-Forwarded-Proto") or "http"
        try:
            meta = self.server.store.resolve_inside(build_dir / BUILD_META_FILE)
            return render.link_preview(
                json.loads(meta.read_bytes()),
                f"{scheme}://{self.headers.get('Host', '')}{page}")
        except (ValueError, OSError, TypeError, KeyError):
            return ""

    def _serve_pointer_page(self, pid: str, with_body: bool):
        """`/project/<pid>/` — the tiny page that picks a pointer (SPEC 9).

        `no-cache`: a cached decision page would freeze the decision. 404 for
        a project never pushed; the project directory is the test, not a
        build inside it.

        It is the link a reader most often copies, so it unfurls in a
        messenger as the project's `latest` does (`_link_preview`); a project
        with no `latest` gets no tags.
        """
        if not self.server.store.project_dir(pid).is_dir():
            return self._error(404, "not found", with_body=with_body)
        preview = self._link_preview(
            self.server.store.build_dir(pid, LATEST_LINK),
            f"/project/{pid}/{LATEST_LINK}/")
        return self._serve_page(
            lambda theme: render.pointer_page_html(theme, preview), with_body)

    def _serve_builds_json(self, pid: str, with_body: bool,
                           variant: str = MAIN_BRANCH):
        """A variant's build picker, with the key to each build's files —
        EDIT_TOKEN.

        `files_keys` maps every address the picker offers to its key
        (`files_key`): `latest`, each revision of `builds`, and `dev` while the
        slot is occupied — another variant's `latest` and `dev` by the key of
        its own address, under the same two names. The owner's page puts them
        into its download links and its Share window's links, because a
        browser download cannot carry the token. Added here and never written:
        a key is derived from the secret and does not belong on the volume (the
        file is `render.builds_json`'s).

        A file that does not parse is served as it is, without keys, with a log
        line: the picker still works and only the downloads are lost.
        """
        try:
            path = self.server.store.resolve_inside(
                self.server.store.builds_json_path(pid, variant))
            raw = path.read_bytes()
        except (OSError, ValueError):
            return self._error(404, "not found", with_body=with_body)
        token = self.server.edit_token
        prefix = ("" if variant == MAIN_BRANCH
                  else f"{VARIANT_SEGMENT}/{variant}/")
        try:
            picker = json.loads(raw)
            keys = {"latest": files_key(token, pid, f"{prefix}latest")}
            for entry in picker["builds"]:
                keys[entry["commit"]] = files_key(token, pid, entry["commit"])
            if picker.get("has_dev"):
                keys["dev"] = files_key(token, pid, f"{prefix}dev")
            picker["files_keys"] = keys
        except (ValueError, TypeError, KeyError) as error:
            logger.warning(
                f"the build picker of {pid} could not be read ({error}); "
                f"serving it without the download keys")
            return self._send(200, raw, content_type_for(path.name),
                              CACHE_NONE, with_body=with_body)
        return self._json(200, picker, CACHE_NONE, with_body=with_body)

    def _presents_files_key(self, pid: str, build: str, query: str) -> bool:
        """Does `?files=` carry the key of `<pid>/<build>`, `build` being the
        address past the project (`files_key`)?

        Constant time over bytes, for the reason `_authorized` gives.
        """
        presented = (parse_qs(query).get("files") or [""])[0]
        return hmac.compare_digest(
            presented.encode("utf-8"),
            files_key(self.server.edit_token, pid, build).encode("utf-8"))

    def _redirect(self, location: str, with_body: bool):
        self._json(302, {"location": location}, CACHE_NONE,
                   {"Location": location}, with_body)

    def _listed_document(self, build_dir: Path, name: str) -> bool:
        """Does THIS build publish the file at `name` as a document?

        The second half of the open/closed rule (`OPEN_SUFFIXES`), and the only
        one that can answer for a document the page does not draw: such a file
        has whatever extension its author gave it, so the question is not about
        extensions at all. `documents` in meta.json is rebuilt by
        `render._documents` from the push, and every `file` in it was checked
        at publish time against the same path rule the request went through.

        The cost is one `json.loads` of a file that is already PUBLIC —
        anybody may fetch meta.json from this very address — so it hands an
        attacker nothing he could not fetch himself, and it is paid only when
        neither the token nor a key was presented.

        A missing or unreadable meta.json answers "not open" rather than
        raising: `data/` is writable by every build (SPEC §7.4), and a reader
        who should get a 403 must not get a 500 instead.
        """
        try:
            path = self.server.store.resolve_inside(
                build_dir / BUILD_META_FILE)
            meta = json.loads(path.read_bytes())
        except (OSError, ValueError):
            return False
        documents = meta.get("documents") if isinstance(meta, dict) else None
        if not isinstance(documents, list):
            return False
        for entry in documents:
            if isinstance(entry, dict) and entry.get("file") == name:
                return True
        return False

    def _serve_project(self, rest: list[str], trailing_slash: bool,
                       with_body: bool, query: str = ""):
        """Everything under /project/.

        `query` is read by the comparison branch (`?v=<view>`, SPEC 3) and by
        the gate on a build's closed files (`?files=<key>`).
        """
        if not rest:
            return self._error(404, "not found", with_body=with_body)
        pid = rest[0]
        if not self.server.store.valid_pid(pid):
            return self._error(404, "not found", with_body=with_body)

        # /project/<pid>/ opens whichever pointer this reader last looked at
        # (SPEC 9), a localStorage key, so a page reads it and leaves.
        if len(rest) == 1:
            # The trailing slash matters: the page navigates by relative URL.
            if not trailing_slash:
                return self._redirect(f"/project/{pid}/", with_body)
            return self._serve_pointer_page(pid, with_body)

        second = rest[1]
        if second == PROJECT_BUILDS_FILE and len(rest) == 2:
            if not self._require_token(with_body):
                return None
            return self._serve_builds_json(pid, with_body)
        if second == VARIANTS_FILE and len(rest) == 2:
            # Public: the owner chose that a reader without the token sees
            # and switches every variant (SPEC §4).
            return self._send_file(self.server.store.variants_json_path(pid),
                                   CACHE_NONE, with_body)

        # Another variant's address. Before the comparison below, which reads
        # `compare` in the fourth position: `/v/compare/latest/` is the
        # `latest` of the variant `compare`.
        if second == VARIANT_SEGMENT:
            return self._serve_variant(pid, rest[2:], trailing_slash,
                                       with_body, query)

        # A comparison of two revisions. `compare` is in the fourth position
        # because it is a valid build id, so `/project/<pid>/compare/` could
        # be a published build. A build's file may sit deeper than that (a
        # document keeps its path), so a document path that starts with
        # `compare/` is refused where it is declared (`docsbuild`).
        if len(rest) in (4, 5) and rest[2] == "compare":
            return self._serve_compare(
                pid, rest[1], rest[3],
                rest[4] if len(rest) == 5 else None,
                query, trailing_slash, with_body)

        # `latest` and `dev` (SPEC 7.6) are the only moving targets, so no
        # cache; a commit directory never changes and gets a year (SPEC 3.2,
        # 7.4). Checked FIRST: `dev` is rewritten in place and must never
        # reach the immutable branch.
        if second in POINTER_NAMES:
            cache = CACHE_NONE
        elif self.server.store.valid_build_id(second):
            cache = CACHE_IMMUTABLE
        else:
            return self._error(404, "not found", with_body=with_body)
        return self._serve_build(pid, second,
                                 self.server.store.build_dir(pid, second),
                                 rest[2:], cache, trailing_slash, with_body,
                                 query)

    def _serve_variant(self, pid: str, rest: list[str], trailing_slash: bool,
                       with_body: bool, query: str):
        """`/project/<pid>/v/<variant>/…`: another variant's `latest`, `dev`
        and `builds.json`, from `.variants/<variant>/`.

        The default variant has one address, its old one, so `v/main/` is a
        404, as is a variant with nothing there. A draft's variant whose
        branch the hub does not have yet answers for its `dev`.
        """
        store = self.server.store
        if len(rest) == 2 and rest[1] == PROJECT_BUILDS_FILE:
            if not self._require_token(with_body):
                return None
        if (len(rest) < 2 or not store.valid_variant(rest[0])
                or rest[0] == MAIN_BRANCH):
            return self._error(404, "not found", with_body=with_body)
        variant = rest[0]
        if len(rest) == 2 and rest[1] == PROJECT_BUILDS_FILE:
            return self._serve_builds_json(pid, with_body, variant)
        if rest[1] not in POINTER_NAMES:
            return self._error(404, "not found", with_body=with_body)
        return self._serve_build(
            pid, f"{VARIANT_SEGMENT}/{variant}/{rest[1]}",
            store.pointer_dir(pid, variant, rest[1]), rest[2:], CACHE_NONE,
            trailing_slash, with_body, query)

    def _serve_build(self, pid: str, address: str, build_dir: Path,
                     tail: list[str], cache: str, trailing_slash: bool,
                     with_body: bool, query: str):
        """One build's page or one of its files.

        `address` is the build's address past `/project/<pid>/` — a revision,
        `latest`, `dev` or `v/<variant>/latest` — which a redirect repeats and
        whose key opens its closed files (`files_key`); `tail` is the path
        under it. `cache` is the year for a revision and `no-cache` for a
        pointer, which a key never makes private.
        """
        if not tail:
            # The viewer fetches relative to its directory, so the slash
            # matters.
            if not trailing_slash:
                return self._redirect(f"/project/{pid}/{address}/", with_body)
            return self._serve_build_page(build_dir, with_body,
                                          f"/project/{pid}/{address}/")

        # The rest of the address is one file of the build: a name at the top,
        # or a document's path in the tree.
        name = "/".join(tail)
        if not _safe_build_path(name):
            return self._error(404, "not found", with_body=with_body)
        # Generated, never read from the build directory.
        if name == "index.html":
            return self._serve_build_page(build_dir, with_body,
                                          f"/project/{pid}/{address}/")
        # A file whose extension does not open it leaves to the token, to the
        # key of THIS address, or because this build lists it as a document.
        # The first two are checked before the volume is touched, and their
        # year is `private` on a revision: the answer depends on what was
        # presented, and a shared cache must not hand it to somebody who
        # presented nothing. The pointers stay `no-cache`.
        #
        # The third costs a read of meta.json, so it is asked last — of a
        # request that presented nothing, which is the only one that needs it.
        # A file open because it is a document keeps the PUBLIC year: it is
        # open to every reader of this address, exactly like a document whose
        # extension opens it, so there is nothing for a shared cache to leak.
        if Path(name).suffix.lower() not in OPEN_SUFFIXES:
            if (self._authorized()
                    or self._presents_files_key(pid, address, query)):
                if cache == CACHE_IMMUTABLE:
                    cache = CACHE_IMMUTABLE_PRIVATE
            elif not self._listed_document(build_dir, name):
                logger.warning(
                    f"refused: no token and no files key from "
                    f"{self.address_string()} for {self.path.split('?', 1)[0]}")
                return self._error(TOKEN_REFUSED_STATUS, FILES_REFUSED_ERROR,
                                   with_body=with_body)
        # meta.json is written by the hub after validation; everything else in
        # a build directory arrived in the tarball and is served under the
        # narrow uploaded-file content-type whitelist.
        uploaded = name not in render.GENERATED_FILES
        return self._send_file(build_dir / name, cache, with_body,
                               uploaded=uploaded)

    # -- one comparison of two revisions ----------------------------
    def _serve_compare(self, pid: str, old: str, new: str,
                       name: str | None, query: str, trailing_slash: bool,
                       with_body: bool):
        """`/project/<pid>/<a>/compare/<b>/` and the two files under it.

        The page is public (the build page's shell, identical everywhere,
        no-cache per SPEC 7.4); the files are a computed answer behind the
        token, like asking for the computation (`_handle_compare`).

        The files get the year: both ends are always commits. Pointers are
        refused, as on the POST, because the cache is filed under the names
        asked with; the client resolves `latest` from `builds.json` first, and
        `dev` has no commit id.
        """
        # The token first for the files, and BEFORE the ids are looked at,
        # for the reason `_serve_jobs` gives: an unauthenticated caller must
        # not be able to tell "no such revision" from "wrong token".
        if name is not None and not self._require_token(with_body):
            return None
        for revision in (old, new):
            # The POST's check: `latest` and `dev` fail it.
            if not self.server.store.valid_build_id(revision):
                return self._error(404, "not found", with_body=with_body)

        if name is None:
            return self._serve_compare_page(pid, old, new, trailing_slash,
                                            with_body)
        if name not in COMPARE_FILES:
            # A whitelist, so the answer never depends on what is on disk.
            return self._error(404, "not found", with_body=with_body)
        view = (parse_qs(query).get("v") or [None])[0]
        try:
            entry = self.server.store.compare_dir(pid, old, new, view)
        except ValueError:
            # No `?v=`, or a name no entry could be filed under
            # (`store.valid_view_id`). A plain 404: the page asks the POST
            # next, which explains the name.
            return self._error(404, "not found", with_body=with_body)
        # Uncomputed means a missing file and a 404. The year is safe: both
        # ends are commits. Private, because it is behind the token.
        return self._send_file(entry / name, CACHE_IMMUTABLE_PRIVATE,
                               with_body)

    def _serve_compare_page(self, pid: str, old: str, new: str,
                            trailing_slash: bool, with_body: bool):
        """The shell, once both ends of the pair are really there.

        Existence is decided by each revision's meta.json, as in
        `_serve_build_page`; whether the comparison is computed is asked by
        the page, behind the token.

        The same bytes as `<a>`'s build page: the bundle reads the pathname as
        build `<a>` compared against `<b>` (`pageFrom` in ui/src/hub.js).
        """
        if not trailing_slash:
            # The viewer fetches relative to its own directory.
            return self._redirect(f"/project/{pid}/{old}/compare/{new}/",
                                  with_body)
        for revision in (old, new):
            try:
                self.server.store.resolve_inside(
                    self.server.store.build_meta_path(pid, revision))
            except (OSError, ValueError):
                return self._error(404, "not found", with_body=with_body)
        return self._serve_page(render.build_page_html, with_body)

    # -- comment queue, read side ----------------------------------
    def _serve_comments(self, rest: list[str], query: str, with_body: bool):
        """Everything under GET /api/v1/comments (SPEC 7A.2).

        The token is checked BEFORE the shape of the request is, so a caller
        without it cannot use the difference between 403 and 404 to find out
        which comment ids exist.
        """
        if not self._require_token(with_body):
            return None

        if not rest:
            return self._serve_comment_list(query, with_body)

        cid = rest[0]
        if len(rest) == 1:
            record = self.server.comment_store.get(cid)
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
        if project is not None and not self.server.store.valid_pid(project):
            return self._error(422, "invalid project", with_body=with_body)
        if status is not None and status not in ("open", "resolved"):
            return self._error(422, "invalid status", with_body=with_body)
        if since is not None:
            since = normalize_since(since)
            if since is None:
                return self._error(
                    422, "invalid since: expected an ISO-8601 timestamp",
                    with_body=with_body)
        records = self.server.comment_store.list(project=project,
                                                 status=status, since=since)
        return self._json(200, {"comments": records}, CACHE_NONE,
                          with_body=with_body)

    def _serve_attachment(self, cid: str, kind: str, with_body: bool):
        """An uploaded photo, or the viewer's render of the frame.

        Bytes that arrived outside the archive rules: the content type comes
        from the closed set above, never the request, plus
        `Content-Disposition: attachment`. Not cached.

        `O_NOFOLLOW` guards against a mistake, not an attacker: builds can
        write `data/comments/`, and a stray symlink in a model would otherwise
        make the hub serve another file under this URL.
        """
        path = self.server.comment_store.attachment(cid, kind)
        if path is None:
            return self._error(404, "not found", with_body=with_body)
        ctype = ATTACHMENT_CONTENT_TYPES.get(path.suffix.lower())
        if ctype is None:
            return self._error(404, "not found", with_body=with_body)
        try:
            with open(path, "rb", opener=lambda p, f: os.open(
                    p, f | os.O_NOFOLLOW)) as handle:
                data = handle.read()
        except OSError:
            return self._error(404, "not found", with_body=with_body)
        return self._send(200, data, ctype, CACHE_NONE,
                          {"Content-Disposition": "attachment"}, with_body)

    # -- the stored proposal, read side ----------------------------
    def _serve_proposal(self, rest: list[str], with_body: bool):
        """GET /api/v1/proposals/<pid> — this project's one proposal.

        The token is checked before the shape of the request, as in
        `_serve_comments`. A missing proposal and an invalid id get the same
        404; the id is checked before it touches the store's root.
        """
        if not self._require_token(with_body):
            return None
        if len(rest) != 1 or not self.server.store.valid_pid(rest[0]):
            return self._error(404, "not found", with_body=with_body)
        record = self.server.proposal_store.get(rest[0])
        if record is None:
            return self._error(404, "not found", with_body=with_body)
        return self._json(200, record, CACHE_NONE, with_body=with_body)

    # -- publish ---------------------------------------------------
    def _authorized(self) -> bool:
        """Constant-time check of the token in `TOKEN_HEADER` (SPEC 7, 7A.2).

        One secret, so no parameter. `hmac.compare_digest` rather than `==`,
        which short-circuits and leaks the token byte by byte through timing.
        Encoded to bytes first: compare_digest raises on non-ASCII str.
        `Authorization` is not read: it belongs to a proxy in front of the hub.
        """
        presented = self.headers.get(TOKEN_HEADER, "").strip()
        if not presented:
            return False
        return hmac.compare_digest(
            presented.encode("utf-8"),
            self.server.edit_token.encode("utf-8"))

    def _require_token(self, with_body: bool = True,
                       close: bool = False) -> bool:
        """Answer 403 and return False unless the caller presented the token.

        `close` for the verbs that carry a body: refusing before reading it
        leaves the remains on the socket, and on a keep-alive connection
        those would be parsed as the next request.
        """
        if self._authorized():
            return True
        logger.warning(
            f"refused: bad or missing token from {self.address_string()} "
            f"for {self.path.split('?', 1)[0]}")
        extra = {"Connection": "close"} if close else {}
        self._error(TOKEN_REFUSED_STATUS, f"invalid or missing {TOKEN_HEADER}",
                    extra, with_body=with_body)
        return False

    def do_POST(self):
        try:
            return self._handle_post()
        except (BrokenPipeError, ConnectionResetError):
            # The client went away mid-upload: ordinary, not a traceback.
            logger.info("request aborted: the client closed the connection")
            self.close_connection = True
            return None

    def _handle_post(self):
        path, _, query = self.path.partition("?")
        segments = self._split(path)

        for pattern, call in POST_ROUTES:
            rest = _route_rest(pattern, segments)
            if rest is not None:
                return call(self, rest, query, path.endswith("/"), True)
        return self._error(404, "not found", {"Connection": "close"})

    def _handle_pre_receive(self):
        """POST /internal/pre-receive — the hook of a push asking whether it
        may go in (`githooks/pre-receive`).

        Behind the secret this process made at start, which only git's
        environment carries, so a stray request on the loopback cannot
        publish; EDIT_TOKEN never reaches git. The answer is text, written as
        the push goes — building, the build's log, published or the refusal —
        and its last line is the verdict (`prereceive.VERDICT`).
        """
        presented = self.headers.get(HOOK_SECRET_HEADER, "")
        if not hmac.compare_digest(presented.encode("utf-8"),
                                   self.server.hook_secret.encode("utf-8")):
            logger.warning(f"refused: a pre-receive call without this hub's "
                           f"secret from {self.address_string()}")
            return self._error(TOKEN_REFUSED_STATUS, "not this hub's hook",
                               {"Connection": "close"})
        body = self._take_body(MAX_HOOK_BODY_BYTES,
                               too_large="the hook's call is too large")
        if body is None:
            return None
        try:
            request = prereceive.parse(body, self.server.store)
        except ValueError as error:
            return self._error(400, str(error), {"Connection": "close"})

        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Cache-Control", CACHE_NONE)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        present = True

        def say(line: str) -> None:
            # The push goes on to its end whether the hook still reads or not,
            # as `githttp.serve` lets it.
            nonlocal present
            if not present:
                return
            try:
                self.wfile.write(line.encode("utf-8", "replace") + b"\n")
                self.wfile.flush()
            except OSError:
                present = False

        try:
            accepted = prereceive.run(self.server.store, self.server.jobs,
                                      self.server.builds, request, say)
        except Exception:
            logger.exception(f"push {request.pid}: the hook could not be "
                             f"answered")
            say("the hub failed while answering this push")
            accepted = False
        say(prereceive.VERDICT
            + (prereceive.ACCEPTED if accepted else prereceive.REFUSED))
        return None

    def _handle_compare(self, rest: list[str]):
        """POST /api/v1/compare/<pid>/<old>/<new> — 202 and a job.

        The comparison runs in a child, like a build: importing the CAD kernel
        costs ~450 MB resident, which the hub must not pay. The job's log is
        the report.

        The token is checked before the segments, as in `_serve_jobs`.

        Revisions are path segments, no body. `latest` and `dev` are refused:
        clients resolve them first (`hammerola/revdiff.py`, `commitOf` in
        ui/src/HammerolaViewer.jsx), since a result cached under a moving name
        would go stale (`store.compare_dir`).

        An optional fourth segment names a view: the job then also builds and
        caches the scene for `/project/<pid>/<old>/compare/<new>/`.
        `hammerola diff --material` omits it and reads only the log.

        Every reply closes the connection: this handler reads no body, and
        unread bytes on an HTTP/1.1 connection would be parsed as the next
        request.
        """
        if not self._require_token(close=True):
            return None
        if len(rest) not in (3, 4):
            return self._error(404, "not found", {"Connection": "close"})
        pid, old, new = rest[:3]
        view = rest[3] if len(rest) == 4 else None
        if not (self.server.store.valid_pid(pid)
                and self.server.store.valid_build_id(old)
                and self.server.store.valid_build_id(new)):
            return self._error(404, "not found", {"Connection": "close"})
        for revision in (old, new):
            if not self.server.store.build_dir(pid, revision).is_dir():
                return self._error(404, "not found", {"Connection": "close"})
        if view is not None:
            # Asked of the store, which names the cache entry. A 422 with a
            # sentence (VIEW_NOT_NAMEABLE_ERROR), so the author knows to
            # rename the view; the caller's bytes are not echoed.
            if not self.server.store.valid_view_id(view):
                return self._error(
                    422, VIEW_NOT_NAMEABLE_ERROR, {"Connection": "close"})
            # The view must be in both revisions, or the job would certainly
            # fail. A 404 with a sentence, since the panel prints the body.
            for revision in (old, new):
                document = (self.server.store.build_dir(pid, revision)
                            / f"{view}.json")
                if not document.is_file():
                    return self._error(404, VIEW_NOT_IN_BOTH_ERROR,
                                       {"Connection": "close"})

        # The job is filed under the newer revision; both are in the log's
        # first line (`jobs._compare_and_record`).
        record = self.server.jobs.create(pid, new)
        job_id = record["id"]
        outcome = self.server.builds.submit(
            CompareTask(job_id=job_id, pid=pid, old=old, new=new,
                        view=view))
        if outcome == SUBMIT_QUEUE_FULL:
            # Failed rather than left `queued`.
            self.server.jobs.finish(job_id, state=STATE_FAILED, code=503,
                                    error=QUEUE_FULL_ERROR)
            logger.warning(
                f"compare {pid} {old} -> {new} refused: the build queue is "
                f"full")
            return self._json(
                503, {"error": QUEUE_FULL_ERROR}, CACHE_NONE,
                {"Retry-After": str(QUEUE_FULL_RETRY_AFTER_SECONDS),
                 "Connection": "close"})
        if outcome != SUBMIT_ACCEPTED:
            # The hub is stopping, and the JOB has already been answered by
            # the drain or by `submit` itself — so nothing is written over
            # it here.
            logger.warning(
                f"compare {pid} {old} -> {new} refused: the hub is stopping")
            return self._json(503, {"error": STOPPED_ERROR}, CACHE_NONE,
                              {"Connection": "close"})

        status_url = f"/api/v1/jobs/{job_id}"
        logger.info(f"compare {pid} {old} -> {new}: queued as job {job_id}")
        return self._json(
            202,
            {"job": job_id, "status_url": status_url,
             "log_url": f"{status_url}/log"},
            CACHE_NONE, {"Location": status_url, "Connection": "close"})

    def _handle_inspect(self, kind: str, rest: list[str]):
        """POST /api/v1/snapshot|measure/<pid>/<build> — 202 and a job.

        `<build>` is a revision, or `latest` or `dev` of the default variant;
        `<pid>/v/<variant>/<pointer>` is another variant's pointer. A pointer is
        taken, unlike in a comparison, because nothing is cached under its
        name; `latest` is followed here, so the job reads the revision it
        pointed at when asked, while `dev` is read where it stands.

        The token first, then the body, then the build and what the body asks
        of it (`inspection`). The work runs in a child, as a comparison's does
        (`jobs.InspectTask`). Every reply closes the connection, as
        `_handle_compare`'s.
        """
        close = {"Connection": "close"}
        if not self._require_token(close=True):
            return None
        body = self._take_body(MAX_INSPECT_BODY_BYTES,
                               too_large="the request is too large")
        if body is None:
            return None
        located = self._inspected_build(rest)
        if located is None:
            return self._error(404, NO_SUCH_BUILD_ERROR, close)
        pid, revision, directory = located
        try:
            meta = json.loads((directory / BUILD_META_FILE).read_bytes())
        except (OSError, ValueError):
            return self._error(404, NO_SUCH_BUILD_ERROR, close)
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return self._error(422, "the body is not valid JSON", close)
        try:
            asked = inspection(kind, payload, meta if isinstance(meta, dict)
                               else {})
        except InspectRefused as refusal:
            return self._error(refusal.status, str(refusal), close)

        record = self.server.jobs.create(pid, revision)
        job_id = record["id"]
        outcome = self.server.builds.submit(InspectTask(
            job_id=job_id, pid=pid, revision=revision, build_dir=directory,
            kind=kind, **asked))
        if outcome == SUBMIT_QUEUE_FULL:
            self.server.jobs.finish(job_id, state=STATE_FAILED, code=503,
                                    error=QUEUE_FULL_ERROR)
            logger.warning(f"{kind} {pid} {revision} refused: the build queue "
                           f"is full")
            return self._json(
                503, {"error": QUEUE_FULL_ERROR}, CACHE_NONE,
                {"Retry-After": str(QUEUE_FULL_RETRY_AFTER_SECONDS),
                 "Connection": "close"})
        if outcome != SUBMIT_ACCEPTED:
            logger.warning(f"{kind} {pid} {revision} refused: the hub is "
                           f"stopping")
            return self._json(503, {"error": STOPPED_ERROR}, CACHE_NONE, close)

        status_url = f"/api/v1/jobs/{job_id}"
        logger.info(f"{kind} {pid} {revision}: queued as job {job_id}")
        return self._json(
            202,
            {"job": job_id, "status_url": status_url,
             "log_url": f"{status_url}/log", "view": asked["view"]},
            CACHE_NONE, {"Location": status_url, "Connection": "close"})

    def _inspected_build(self, rest: list[str]):
        """`(pid, revision, directory)` of the build a snapshot or a
        measurement names, or None when this hub holds no such build.

        `revision` is what the job is filed under: the commit `latest` points
        at, a revision's own name, or `dev`.
        """
        store = self.server.store
        if len(rest) == 2:
            pid, variant, name = rest[0], MAIN_BRANCH, rest[1]
        elif (len(rest) == 4 and rest[1] == VARIANT_SEGMENT
              and rest[3] in POINTER_NAMES):
            pid, variant, name = rest[0], rest[2], rest[3]
        else:
            return None
        if not (store.valid_pid(pid) and store.valid_variant(variant)):
            return None
        if name in POINTER_NAMES:
            directory = store.pointer_dir(pid, variant, name)
        elif store.valid_build_id(name):
            directory = store.build_dir(pid, name)
        else:
            return None
        try:
            directory = store.resolve_inside(directory)
        except (OSError, ValueError):
            return None
        if not directory.is_dir():
            return None
        return pid, (DEV_LINK if name == DEV_LINK else directory.name), \
            directory

    # -- build jobs ------------------------------------------------
    def _serve_jobs(self, rest: list[str], with_body: bool):
        """GET /api/v1/jobs/<id>[/log] — for whoever pushed (SPEC 8A.2).

        The token is checked before the id, so 403 vs 404 reveals nothing.
        """
        if not self._require_token(with_body):
            return None
        if not rest or len(rest) > 2:
            return self._error(404, "not found", with_body=with_body)
        if len(rest) == 2 and rest[1] not in ("log", SNAPSHOT_NAME):
            return self._error(404, "not found", with_body=with_body)

        job_id = rest[0]
        record = self.server.jobs.get(job_id)
        if record is None:
            return self._error(404, "not found", with_body=with_body)

        if len(rest) == 2 and rest[1] == SNAPSHOT_NAME:
            # What a snapshot job drew, in its own directory; 404 until the
            # job has written it, and for a job of any other kind.
            try:
                picture = self.server.jobs.snapshot_path(job_id).read_bytes()
            except OSError:
                return self._error(404, "not found", with_body=with_body)
            return self._send(200, picture, "image/png", CACHE_NONE,
                              with_body=with_body)

        if len(rest) == 2:
            # text/plain, never HTML: output the model produced, on an origin
            # serving other people's builds.
            return self._send(
                200, (self.server.jobs.log(job_id) or "").encode("utf-8"),
                "text/plain; charset=utf-8", CACHE_NONE,
                with_body=with_body)

        payload = dict(record)
        payload["log_url"] = f"/api/v1/jobs/{job_id}/log"
        return self._json(200, payload, CACHE_NONE, with_body=with_body)

    # -- the log of a revision -------------------------------------
    def _serve_build_log(self, rest: list[str], with_body: bool):
        """GET /api/v1/logs/<pid>/<revision> — what its build printed.

        The revision's own `.build.log`; 404 when there is none, and for every
        malformed id. The token is checked first, as on every private route.
        """
        if not self._require_token(with_body):
            return None
        store = self.server.store
        if len(rest) != 2 or not store.valid_pid(rest[0]) \
                or not store.valid_build_id(rest[1]):
            return self._error(404, "not found", with_body=with_body)
        try:
            raw = store.build_log_path(rest[0], rest[1]).read_bytes()
        except OSError:
            return self._error(404, "not found", with_body=with_body)
        # text/plain, never HTML: output the model produced.
        return self._send(200, raw, "text/plain; charset=utf-8", CACHE_NONE,
                          with_body=with_body)

    # -- the git server --------------------------------------------
    def _serve_git(self, method: str, rest: list[str], query: str,
                   with_body: bool):
        """Everything under /git/: each project's repository, by git itself.

        The token first, before the shape of the request, as on every private
        route. Only the three requests of the smart protocol reach
        `git http-backend` (`githttp.smart_request`); everything else under
        /git/, the dumb protocol's files included, is a 404. A project whose
        import failed is a 503 with the reason (`Store.ensure_repo`). Every
        answer closes the connection: a git answer has no length, and a
        refusal may leave a body unread.
        """
        close = {"Connection": "close"}
        if not self._require_token(with_body, close=True):
            return None
        request = githttp.smart_request(method, rest, query)
        if request is None:
            return self._error(404, "not found", close, with_body=with_body)
        length = 0
        if method == "POST":
            if self.headers.get("Transfer-Encoding", "").strip().lower() \
                    == "chunked":
                length = None
            else:
                length = self._body_length()
                if length is None:
                    return None
        try:
            self.server.store.ensure_repo(request.pid)
            code = githttp.serve(
                self, request, self.server.store.repos_dir, length,
                BODY_DEADLINE_SECONDS,
                githttp.hook_environment(self.server.server_address[1],
                                         self.server.hook_secret))
        except ImportFailed as error:
            return self._error(
                503, f"the import of this project's builds failed: {error}",
                close)
        except (OSError, subprocess.CalledProcessError):
            logger.exception(f"git {request.pid}: git could not be started")
            return self._error(500, "internal error", close)
        if code != 0:
            logger.warning(f"git {request.pid}: git http-backend exited {code}")
        githttp.end_of_request(self.server.store, request)
        return None

    # -- the project itself: rename, and remove ---------------------
    def _handle_rename(self, pid: str):
        """POST /api/v1/projects/<pid>/title — the TITLE and nothing else.

        No route changes an id (SPEC 3.1): every permanent URL is built from
        it. The token is checked first; a missing project and an invalid id
        get the same 404.
        """
        if not self._require_token(close=True):
            return None
        body = self._take_body(MAX_TITLE_BODY_BYTES,
                               too_large="title body is too large")
        if body is None:
            return None
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return self._error(422, "body is not valid JSON")
        if not isinstance(payload, dict):
            return self._error(422, "body must be a JSON object")
        try:
            # The same rule a build's own title goes through.
            title = render.project_title(payload.get("title"))
        except ValueError as error:
            return self._error(422, str(error))

        # Validated before the project is looked up, so no refusal above
        # reveals whether it exists.
        if not self.server.store.valid_pid(pid) or \
                not self.server.store.set_title(pid, title):
            return self._error(404, "not found")
        logger.info(f"project {pid} renamed")
        return self._json(200, {"pid": pid, "title": title})

    def _handle_names(self, pid: str):
        """POST /api/v1/projects/<pid>/names — a name changed on the page:
        `{"variant": <branch>, "kind": "project" | "variant" | "view" |
        "document", "id": <the view's or the document's id>, "name": ...}`;
        the project's name goes on `main` whatever `variant` says.

        Committed into project.json on the variant's branch and published
        before the answer, as a copy of a build of the tip's project with the
        name rewritten, or built where neither the tip's own build nor the
        variant's `latest` holds that tree (`prereceive.commit_name`): 200 with the commit and the revision's
        address, 422 with the build's error. No id changes, as on `/title`.
        The token is checked first, then the body, then whether the project
        and the variant exist.
        """
        if not self._require_token(close=True):
            return None
        body = self._take_body(MAX_TITLE_BODY_BYTES,
                               too_large="names body is too large")
        if body is None:
            return None
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return self._error(422, "body is not valid JSON")
        if not isinstance(payload, dict):
            return self._error(422, "body must be a JSON object")
        kind, item = payload.get("kind"), payload.get("id")
        if kind not in RENAMED_KINDS:
            return self._error(
                422, f"`kind` must be one of {', '.join(RENAMED_KINDS)}")
        if kind in ("view", "document") and not isinstance(item, str):
            return self._error(422, f"`id` must name the {kind}")
        try:
            # Every kind's own rule (`render.project_title`, `variant_label`,
            # `view_name`) is this one, worded for the body's field.
            name = render.name_text(payload.get("name"), "name")
        except ValueError as error:
            return self._error(422, str(error))
        store = self.server.store
        # The project's name goes on the default variant whichever the page
        # shows: the front page's card and the title a rename of `/title`
        # left (`Store.clear_title`) follow that one.
        variant = MAIN_BRANCH if kind == "project" else payload.get("variant")
        if not (store.valid_pid(pid) and store.valid_variant(variant)
                and store.repo_dir(pid).is_dir()):
            return self._error(404, "not found")
        status, answer = prereceive.commit_name(
            store, self.server.jobs, self.server.builds, pid, variant, kind,
            item, name)
        if status != 200:
            return self._error(status, answer)
        return self._json(200, answer)

    def do_DELETE(self):
        try:
            return self._handle_delete()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
            return None

    def _handle_delete(self):
        """DELETE /api/v1/projects/<pid> — the whole project, all of it,
        and DELETE /api/v1/proposals/<pid> — the stored proposal alone.

        The only ways anything leaves the volume: there is no retention
        (SPEC 5.3) and no route removes a single build, whose URL is a
        permanent promise. Removing the project removes its builds, pointers,
        comment queue, proposal and stored code. A proposal is a working
        document nobody was given a link to, so it can be removed alone.

        The token is checked first; every miss is the same 404.
        """
        if not self._require_token(close=True):
            return None
        path, _, query = self.path.partition("?")
        segments = self._split(path)

        # Tried in order, as in `_handle_get`. The checks below run only after
        # a match, so an unknown path is a 404, not a complaint about a body.
        for pattern, call in DELETE_ROUTES:
            rest = _route_rest(pattern, segments)
            if rest is None:
                continue
            # An unread body would be parsed as the next request; refused.
            if self.headers.get("Transfer-Encoding") or \
                    (self.headers.get("Content-Length") or "0").strip() \
                    not in ("", "0"):
                return self._error(400, "this endpoint takes no body",
                                   {"Connection": "close"})
            if not self.server.store.valid_pid(segments[3]):
                return self._error(404, "not found")
            return call(self, rest, query, path.endswith("/"), True)
        return self._error(404, "not found", {"Connection": "close"})

    def _remove_proposal(self, pid: str):
        """DELETE /api/v1/proposals/<pid> — the reader's working document.

        200 either way; the boolean says whether anything was stored.
        """
        return self._json(
            200, {"removed": self.server.proposal_store.remove(pid)})

    def _remove_project(self, pid: str):
        """DELETE /api/v1/projects/<pid> — the project and all of it."""
        removed = self.server.store.remove_project(pid)
        if removed is None:
            return self._error(404, "not found")
        # Only for a project that existed: comments anchor to <pid>/<commit>
        # (SPEC 7A.1).
        removed["comments"] = self.server.comment_store.remove_project(pid)
        removed["proposal"] = self.server.proposal_store.remove_project(pid)
        logger.info(f"project {pid} removed: {removed}")
        return self._json(200, removed)

    # -- comment queue, write side ---------------------------------
    def _handle_comment_resolve(self, cid: str):
        """POST /api/v1/comments/<id>/resolve — the agent closing an item."""
        if not self._require_token(close=True):
            return None
        length = self.headers.get("Content-Length")
        note = None
        # The body is optional: no Content-Length means no note, not a 411
        # (`test_resolve_without_a_note_is_fine`). The shared preamble runs
        # only when there is a body, or a framing it must refuse.
        if self.headers.get("Transfer-Encoding") or (
                length and length.isdigit() and int(length) > 0):
            body = self._take_body(MAX_RESOLVE_BODY_BYTES,
                                   too_large="resolve body is too large")
            if body is None:
                return None
            try:
                payload = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self._error(422, "body is not valid JSON")
            if not isinstance(payload, dict):
                return self._error(422, "body must be a JSON object")
            note = payload.get("note")
        try:
            record = self.server.comment_store.resolve(cid, note)
        except CommentError as error:
            return self._error(error.status, error.message)
        if record is None:
            return self._error(404, "not found")
        logger.info(f"comment {cid} resolved")
        return self._json(200, record)

    def _handle_comment_post(self, pid: str, commit: str,
                             variant: str = None):
        """POST /api/v1/comments/<pid>/<commit> — EDIT_TOKEN (SPEC 7A.2) —
        and /api/v1/comments/<pid>/v/<variant>/dev, on another variant's
        draft, with `variant`.

        The token is checked first, before the route and Content-Length, so
        no unauthenticated caller makes the hub read and parse a body (SPEC
        8A.1). Then everything refusable without reading, then the read.
        Early refusals close the connection (unread body bytes).
        """
        if not self._require_token(close=True):
            return None

        store = self.server.store
        # Commits and the local slot can be commented on (SPEC 7.6); `latest`
        # cannot, since it will name a different build tomorrow. Another
        # variant has only its slot here: its revisions are revisions.
        if variant is None:
            known = store.valid_build_id(commit) or commit == DEV_LINK
            meta = store.build_meta_path(pid, commit)
        else:
            known = (store.valid_variant(variant) and variant != MAIN_BRANCH
                     and commit == DEV_LINK)
            meta = store.pointer_dir(pid, variant, DEV_LINK) / BUILD_META_FILE
        if not store.valid_pid(pid) or not known:
            return self._error(404, "not found", {"Connection": "close"})
        # The build has to exist at write time; a comment whose build is
        # later removed stays in the queue (SPEC 7A.3).
        if not meta.is_file():
            return self._error(404, "not found", {"Connection": "close"})

        # No rate limit (SPEC 7A.4): the only caller holds EDIT_TOKEN.
        # Everything from here down is about size.
        body = self._take_body(
            self.server.settings.comment_max_body_bytes,
            too_large="body is {length} bytes, limit is {limit}")
        if body is None:
            return None

        try:
            return self._store_comment(pid, commit, body, variant)
        except CommentError as error:
            logger.warning(
                f"comment on {pid}/{commit} refused: {error.message}")
            return self._error(error.status, error.message)
        except (BrokenPipeError, ConnectionResetError):
            raise
        except Exception:
            logger.exception(f"comment on {pid}/{commit} failed")
            return self._error(500, "internal error")

    def _store_comment(self, pid: str, commit: str, body: bytes,
                       variant: str = None):
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
        payload = validate_payload(
            raw, self.server.settings.comment_max_text_chars)

        # The attachments are taken by FIELD NAME and read as bytes. Their
        # filenames and their declared content types are dropped here and go
        # no further: `comments.sniff_image` decides what they are.
        attachments = {}
        for kind in (PHOTO_KIND, SHOT_KIND):
            part = parts.get(kind)
            if part is not None and part.data:
                attachments[kind] = part.data

        record = self.server.comment_store.add(pid, commit, payload,
                                               attachments, variant=variant)
        # Only the id comes back; the text is never echoed (SPEC 7A.4). The
        # build page renders the queue as text, never markup
        # (`ui/tests/feed.test.js`); `_body_text` refuses control characters.
        return self._json(201, {"id": record["id"]})

    # -- the stored proposal, write side ---------------------------
    def _handle_proposal_post(self, pid: str):
        """POST /api/v1/proposals/<pid> — EDIT_TOKEN.

        ONE PROPOSAL PER PROJECT: this replaces whatever was stored rather
        than adding to it, which is what saving a working document means.

        The token is checked first, as in `_handle_comment_post`; early
        refusals close the connection. The project need not exist and is not
        looked up: only the validated id touches the store's root.
        """
        if not self._require_token(close=True):
            return None
        if not self.server.store.valid_pid(pid):
            return self._error(404, "not found", {"Connection": "close"})
        body = self._take_body(
            self.server.settings.proposal_max_body_bytes,
            too_large="body is {length} bytes, limit is {limit}")
        if body is None:
            return None

        try:
            payload = proposals.validate_payload(proposals.parse_body(body))
            record = self.server.proposal_store.put(pid, payload["doc"],
                                                    payload["text"],
                                                    payload["published"],
                                                    payload["view"])
        except proposals.ProposalError as error:
            logger.warning(f"proposal on {pid} refused: {error.message}")
            return self._error(error.status, error.message)
        return self._json(200, record)

    def _body_length(self, limit: int | None = None, *,
                     too_large: str = "") -> int | None:
        """The declared length of a body this route will read. Or None.

        None means the request has already been answered. The preamble every
        body-taking route shares; each refusal closes the connection, since
        unread body bytes would be parsed as the next request.

        `limit` and the 413 text `too_large` (formatted with `length` and
        `limit`) are the caller's; the 413 is answered without reading. A
        `limit` of None means the route has no ceiling: a push, whose body goes
        to `git http-backend` as it arrives.

        A chunked body is refused like a missing length: the length is what
        these routes read the body by. The git route alone takes a chunked
        body, and decodes it itself (`githttp.copy_chunked`).
        """
        if self.headers.get("Transfer-Encoding"):
            self._error(411, "Content-Length is required",
                        {"Connection": "close"})
            return None
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self._error(411, "Content-Length is required",
                        {"Connection": "close"})
            return None
        if length < 0:
            self._error(400, "invalid Content-Length",
                        {"Connection": "close"})
            return None
        if limit is not None and length > limit:
            self._error(413, too_large.format(length=length, limit=limit),
                        {"Connection": "close"})
            return None
        return length

    def _take_body(self, limit: int, *, too_large: str) -> bytes | None:
        """The whole body, or None once the refusal has been written.

        For the routes that read their body into memory.
        """
        length = self._body_length(limit, too_large=too_large)
        if length is None:
            return None
        body, problem = self._read_body(length)
        if problem is not None:
            status, message = problem
            self._error(status, message, {"Connection": "close"})
            return None
        return body

    def _read_body(self, length: int):
        """Read exactly `length` bytes into memory. (bytes, problem or None).

        For bodies of a few megabytes at most, already bounded by the caller.
        `read1`, not `read`: `BufferedReader.read(n)` loops until it has all n
        bytes, so the deadline would go unchecked; `read1` returns after one
        syscall.
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

def create_server(settings, *, build_runner=None, compare_runner=None,
                  inspect_runner=None, build_workers=None,
                  build_queue_size=None) -> ThreadingHTTPServer:
    """Bind the listening socket and return the server, not yet serving.

    Binding here lets a test ask for port 0 and read back the real port.

    `build_runner`, `compare_runner`, `inspect_runner`, `build_workers` and
    `build_queue_size` are test seams, not configuration: they replace
    `src.buildproc.run_build` / `run_compare` / `run_inspect` and the
    `src.jobs` defaults so a test can drive the pipeline without CadQuery or
    observe a full queue.
    """
    store = Store(data_dir=settings.data_dir)
    # A separate tree: a comment must not inherit a build directory's
    # immutable caching or public reach (SPEC 7A.3).
    comment_store = CommentStore(
        data_dir=settings.data_dir,
        max_text_chars=settings.comment_max_text_chars,
        max_photo_bytes=settings.comment_max_photo_bytes,
    )
    # A third tree, for the same reason (src/proposals.py).
    proposal_store = proposals.ProposalStore(data_dir=settings.data_dir)
    # Constructed eagerly: its constructor fails the jobs a previous run left
    # `queued` or `building`, before the first status poll.
    job_store = JobStore(settings.data_dir)
    extra = {}
    if build_workers is not None:
        extra["workers"] = build_workers
    if build_queue_size is not None:
        extra["queue_size"] = build_queue_size
    builds = BuildQueue(store, job_store, build_runner=build_runner,
                        compare_runner=compare_runner,
                        inspect_runner=inspect_runner, **extra)

    class Server(ThreadingHTTPServer):
        # Threads die with the process: a hung 2 MB download must never keep the
        # container alive after a stop signal.
        daemon_threads = True
        allow_reuse_address = True

        def server_close(self):
            # One call stops the socket and the workers. A worker mid-build is
            # waited for, so a build is never half-published.
            #
            # The socket closes first so it stops LISTENING: otherwise the
            # kernel keeps completing handshakes into the backlog during the
            # stop, and those clients wait for an answer nobody writes.
            super().server_close()
            builds.shutdown()

    server = Server((settings.host, settings.port), HubHandler)
    server.settings = settings
    server.store = store
    server.comment_store = comment_store
    server.proposal_store = proposal_store
    server.jobs = job_store
    server.builds = builds
    server.edit_token = settings.edit_token
    # What the pre-receive hook presents (`_handle_pre_receive`): 128 bits, made
    # here and handed to git's environment only.
    server.hook_secret = secrets.token_hex(16)
    # Last, so a bind that fails leaves no threads behind to be joined by nobody.
    builds.start()
    # The import, the derived state of every project and the pass over
    # `sources/`, off the start path (`Store.catch_up`); a test that needs it
    # done joins this.
    server.catching_up = threading.Thread(target=store.catch_up,
                                          name="hammerola-catch-up",
                                          daemon=True)
    server.catching_up.start()
    return server
