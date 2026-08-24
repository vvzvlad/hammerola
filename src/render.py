"""Turning an accepted push into the files the browser reads.

Three things are generated here and nothing else writes them:

  * the normalized `meta.json` that the viewer fetches for one build,
  * `builds.json`, the per-project build picker,
  * the root `index.json` that feeds the public index page.

Page HTML is not templated in any interesting sense: both pages are static and get
everything they show from JSON at runtime, which is exactly why the same viewer.js
serves every project and every build. They are read from `templates/` — files in
the image, never in `data/`, because the volume would shadow them.

Validation lives here too, because "is this meta.json usable" and "what does the
page need" are the same question asked twice. Failures are raised as ValueError;
store.py turns them into a 422, which keeps this module free of HTTP concepts and
avoids an import cycle with the thing that calls it.
"""

import gzip
import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"

# A download label ends up as a button caption. Kept to the same shape as a file
# name so it can never carry markup, a quote or a control character: the pages
# build their DOM with textContent, and this is the second line of that defence.
SAFE_LABEL = re.compile(r"\A[A-Za-z0-9._-]{1,32}\Z")

# Free-text fields shown on the index and the build page. Long enough for a real
# title, short enough that one push cannot push every other card off the screen.
MAX_TEXT = 200

# `built` is displayed like the rest but it is a TIMESTAMP, so its ceiling is the
# length of one, with room for a long timezone spelling — not the free-text one.
# It ends up in three places at once (the index card, the build page header and an
# <option> caption) and, unlike a title, in the SHARED /index.json that every
# visitor of `/` downloads with `no-cache`: 200 projects each carrying 200 KB of
# `built` is a public index nobody can load, from pushes that were each accepted.
MAX_BUILT = 64

# Names inside a build directory that belong to the hub, not to the push. A view
# or a download pointing at one of them would be measured against the uploaded
# file and then serve something else entirely, so the push is refused instead:
# `meta.json` and the digest file are overwritten after this validation, and
# `index.html` is the URL of the generated page, which app.py renders from the
# template and never reads out of the build directory.
GENERATED_FILES = {"meta.json", "index.html", ".payload.sha256"}

# A part colour, as the vendored viewer will hand it to the browser. Either a hex
# literal or a bare CSS keyword — what matters is that neither shape can contain a
# quote, an angle bracket, a semicolon or a parenthesis, because the library ends
# up interpolating this into `style="color:${color}"` without escaping anything.
# The exact set of keyword names is the browser's business, not ours; an unknown
# word renders as no colour, which is a cosmetic problem rather than a security
# one. `rgb(...)` and `hsl(...)` are refused: they buy nothing a hex cannot say and
# they are the shapes that carry parentheses.
SAFE_COLOR = re.compile(r"\A(#[0-9A-Fa-f]{3,8}|[A-Za-z]{1,32})\Z")

# The only keys of a view file this module looks at. Everything else — the vertex,
# index and normal buffers that make up ~99% of a 2 MB view — is dropped as the
# parser produces it (see `_view_fields`), so validating a view costs the size of
# its largest single buffer rather than the size of the whole parsed document.
VIEW_KEPT_KEYS = ("name", "color", "parts")

# Depth ceiling for the part tree. A real assembly nests a handful of levels; this
# only exists so a hand-made file cannot make the walk below run forever.
MAX_VIEW_DEPTH = 64


def _plain_text(value: str, field: str, limit: int = MAX_TEXT) -> str:
    """One line of printable text, or a ValueError naming the field.

    Control characters are the thing being kept out: they are what turns a title
    into a second header line in a log, and they have no business in a caption.
    Category Cf goes with them, which is not pedantry — U+202E RIGHT-TO-LEFT
    OVERRIDE is a Cf character, and `textContent` renders it faithfully, so it
    reverses the text AROUND the field it was smuggled into. Everything else
    Unicode considers printable is allowed — model names are not required to be
    English.
    """
    if len(value) > limit:
        raise ValueError(f"`{field}` is longer than {limit} characters")
    for char in value:
        # Cc control, Cf format, Cs surrogate, Co private use, Cn unassigned.
        if unicodedata.category(char).startswith("C"):
            raise ValueError(
                f"`{field}` contains a non-printable character {char!r}")
    return value


@lru_cache(maxsize=None)
def _template(name: str) -> str:
    """Read a page template once per process.

    Cached because these are immutable inside the image: a template edit ships as
    a new image, so re-reading per request would buy nothing and cost a syscall on
    the hot path.
    """
    return (TEMPLATES_DIR / name).read_text(encoding="utf-8")


def build_page_html() -> str:
    """The page for ONE build, written into the build directory at publish time."""
    return _template("build.html")


def index_page_html() -> str:
    """The public index at `/`. Served from the image, not from data/."""
    return _template("index.html")


def pointer_page_html() -> str:
    """`/project/<pid>/` — the URL that names no pointer (SPEC 9).

    A page and not a 302, because what decides the destination is a localStorage
    key and only the browser can read it. It carries no project-specific text at
    all: the script reads the pid off its own URL, exactly as the build page
    does, so this stays one template rather than a per-project render.
    """
    return _template("pointer.html")


def _view_fields(pairs):
    """`object_pairs_hook` that keeps only the fields the part tree renders.

    The alternative is `json.load` as it comes, which materializes every vertex
    and index buffer of a 2 MB view as Python floats and ints — several times the
    file in resident memory, four publish slots at a time, to look at two string
    fields. Dropping the rest here frees each buffer the moment its parent object
    is built, so the peak is one buffer instead of the whole document.
    """
    return {key: value for key, value in pairs if key in VIEW_KEPT_KEYS}


def _check_part_name(value, where: str) -> None:
    """A part name, checked harder than `project` and `title` are.

    The asymmetry is deliberate. Our own pages render `project` and `title` with
    `textContent`, where `<b>` is three characters on screen; the vendored viewer
    assigns a part name to `innerHTML`, where the same three characters are a tag.
    So a part name gets the ordinary printable-text rules AND no angle brackets:
    without a `<` there is no element to open, and the whole class — an `<a>`
    stretched over the page, a `<form>` posting a token somewhere else, an
    `<iframe>` — is gone with one comparison.
    """
    if not isinstance(value, str):
        raise ValueError(f"{where} has a non-string name {value!r}")
    _plain_text(value, where)
    if "<" in value or ">" in value:
        raise ValueError(f"{where} contains an angle bracket: {value!r}")


def _check_color(value, where: str) -> None:
    """A part colour, or a list of them (edges carry one colour per segment).

    Flattened with a stack rather than by recursing: the nesting depth here is
    whatever the upload chose, and a recursive walk over a list nested a few
    hundred deep would exhaust the interpreter's stack — turning a check that
    exists to produce a 422 into a 500.
    """
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, list):
            stack.extend(item)
            continue
        if not isinstance(item, str) or not SAFE_COLOR.match(item):
            raise ValueError(
                f"{where} has colour {item!r}, which must match "
                f"{SAFE_COLOR.pattern}")


def check_view_file(path: Path, view_id: str) -> None:
    """Refuse a view whose part tree could inject markup into the page.

    This is the ONLY thing standing between a push and the DOM here. The vendored
    viewer builds its tree with

        label.innerHTML = node.name;
        label.innerHTML += `<span style="color:${color}"> ⚈</span>`;

    and `name`/`color` come straight out of this file. Patching the library is not
    an option — it is vendored, 3.6 MB, and replaced wholesale by its next
    release — so the check has to happen on the way in, once, rather than on every
    render. The CSP is a backstop for what this misses, not a substitute for it:
    it stops an injected <script> from running but says nothing about a `<form>`
    posting elsewhere or an `<a>` covering the page, and a build URL is permanent,
    immutable and shares an origin with every other project on the host.

    Walked iteratively, with a depth ceiling, so neither a deeply nested tree nor
    a wide one can turn a malformed upload into a RecursionError.
    """
    try:
        with open(path, "rb") as handle:
            doc = json.load(handle, object_pairs_hook=_view_fields)
    # RecursionError is in the list because it is what a few thousand nested
    # arrays produce in the parser itself, and it is the push's fault, not ours.
    except (ValueError, UnicodeDecodeError, RecursionError) as error:
        raise ValueError(
            f"view {view_id!r} is not valid JSON: {error}") from error
    if not isinstance(doc, dict):
        raise ValueError(f"view {view_id!r} must be a JSON object")

    stack = [(doc, 0)]
    while stack:
        node, depth = stack.pop()
        if depth > MAX_VIEW_DEPTH:
            raise ValueError(
                f"view {view_id!r} nests parts deeper than {MAX_VIEW_DEPTH}")
        where = f"view {view_id!r}"
        name = node.get("name")
        if name is not None:
            _check_part_name(name, f"part name in {where}")
        if node.get("color") is not None:
            _check_color(node["color"], f"part {name!r} in {where}")
        parts = node.get("parts")
        if parts is None:
            continue
        if not isinstance(parts, list):
            raise ValueError(f"{where} has a non-list `parts`")
        for part in parts:
            if not isinstance(part, dict):
                raise ValueError(f"{where} has a part that is not an object")
            stack.append((part, depth + 1))


class _ByteCounter:
    """A write-only sink that counts and drops. The gzip stream goes nowhere."""

    def __init__(self):
        self.total = 0

    def write(self, data) -> int:
        self.total += len(data)
        return len(data)

    def flush(self) -> None:
        pass


def measure_view(path: Path) -> tuple[int, int]:
    """(size, compressed size) of one view, without holding either in memory.

    The compressed number is what the picker shows, so it has to be the number
    that goes over the wire: level 6, the same as Traefik's compress middleware
    (SPEC 2.3: 2 MB -> 310 KB).

    Streamed through a counter rather than `len(gzip.compress(data))`, because
    that spelling holds the file AND its compressed copy at once — for four
    concurrent publishes, of files that are 2 MB each on a real model and up to
    MAX_BUILD_BYTES on a hostile one. That is the same peak `_spool_body` went to
    some trouble to avoid, put back one module over.
    """
    counter = _ByteCounter()
    raw = 0
    with open(path, "rb") as handle:
        with gzip.GzipFile(fileobj=counter, mode="wb", compresslevel=6) as gz:
            while True:
                chunk = handle.read(256 * 1024)
                if not chunk:
                    break
                raw += len(chunk)
                gz.write(chunk)
    return raw, counter.total


def build_meta(pid: str, commit: str, raw: dict, staging: Path,
               files: dict, published: str, dev: bool = False) -> dict:
    """Validate the uploaded meta.json and normalize it for the viewer.

    Two renames happen on purpose. The wire format calls the list `views` (SPEC 7)
    because that is what it is to whoever writes a model; the viewer inherited
    `variants` from the prototype and there is no reason to touch working frontend
    code over a word. The mapping is one line and lives here.

    `bytes` and `gzip` are measured SERVER-SIDE rather than trusted from the
    upload: they are shown in the view picker, so a wrong number is a wrong
    promise about what clicking costs, and CI has no reason to compute them.
    """
    views = raw.get("views")
    if not isinstance(views, list) or not views:
        raise ValueError("meta.json must list at least one view in `views`")

    variants = []
    seen: set[str] = set()
    for view in views:
        if not isinstance(view, dict):
            raise ValueError("every entry of `views` must be an object")
        view_id = view.get("id")
        if not isinstance(view_id, str) or not view_id.strip():
            raise ValueError("every view needs a non-empty string `id`")
        _plain_text(view_id, "view id")
        if view_id in seen:
            raise ValueError(f"view id {view_id!r} appears twice")
        seen.add(view_id)

        name = view.get("file")
        # The archive is flat and its member names were whitelisted during
        # extraction, so membership in `files` is the whole check: a view can only
        # ever point at a file that was actually unpacked into this build.
        if not isinstance(name, str) or name not in files:
            raise ValueError(
                f"view {view_id!r} points at {name!r}, which is not in the archive")
        # A view pointing at one of those names would be measured here and then
        # answered by the hub's own file — the rewritten meta.json, or the
        # generated page at index.html — so the viewer would fetch something
        # other than what these numbers describe.
        if name in GENERATED_FILES:
            raise ValueError(
                f"view {view_id!r} points at {name!r}, which the hub rewrites "
                f"after this check; pick another file name")

        # The bytes of this file are handed to `viewer.render()` verbatim, so the
        # push does not stop being untrusted input at the archive boundary: what
        # is inside a view reaches the DOM as well.
        check_view_file(staging / name, view_id)

        try:
            parts = int(view.get("parts") or 0)
        except (TypeError, ValueError) as error:
            raise ValueError(
                f"view {view_id!r} has a non-numeric `parts`") from error

        # Measured SERVER-SIDE, from the file that was actually unpacked.
        size, compressed = measure_view(staging / name)
        variants.append({
            "id": view_id,
            "name": _plain_text(str(view.get("name") or view_id), "view name"),
            "file": name,
            "parts": parts,
            "bytes": size,
            "gzip": compressed,
        })

    downloads = raw.get("downloads") or {}
    if not isinstance(downloads, dict):
        raise ValueError("`downloads` must be an object mapping label -> filename")
    for label, name in downloads.items():
        # The label becomes a button caption, so it is whitelisted rather than
        # escaped: nothing that matches this can be markup in any context.
        if not isinstance(label, str) or not SAFE_LABEL.match(label):
            raise ValueError(
                f"download label {label!r} must match {SAFE_LABEL.pattern}")
        if not isinstance(name, str) or name not in files:
            raise ValueError(
                f"download {label!r} points at {name!r}, which is not in the archive")
        if name in GENERATED_FILES:
            raise ValueError(
                f"download {label!r} points at {name!r}, which the hub rewrites "
                f"after this check; pick another file name")

    # Both are shown verbatim on the index and the build page. The pages render
    # them with textContent, but a push is not allowed to smuggle control
    # characters or a page-wide banner through them either.
    project = _plain_text(str(raw.get("project") or pid), "project")
    title = _plain_text(str(raw.get("title") or project), "title")

    # `built` is the model's own timestamp and is what retention and the build
    # picker order by. It is optional: a project that does not set it gets the
    # moment the hub accepted the push, which is monotonic in practice and keeps a
    # missing field from being a publish failure.
    #
    # It is NOT parsed as a date — `_built_key` deliberately tolerates an
    # unparseable one so a single odd timestamp cannot break a project's picker —
    # but it is displayed exactly like `project` and `title`, so it gets exactly
    # their validation. Skipping it here was worth a 500 KB `built` served to
    # every visitor of `/` and an RTL override reversing its neighbours.
    raw_built = raw.get("built")
    built = (_plain_text(raw_built, "built", MAX_BUILT)
             if isinstance(raw_built, str) and raw_built.strip() else published)

    return {
        "pid": pid,
        "project": project,
        "title": title,
        "commit": commit,
        # True for the one build that is not addressed by a commit at all: the
        # local slot (SPEC 7.6), where `commit` reads `dev` because that is the
        # slot's name. Recorded so the page can say "local build" instead of
        # showing `dev` where a commit hash belongs, and so the viewer knows the
        # thing on screen can be overwritten under it.
        "dev": bool(dev),
        "built": built,
        # Arrival time, recorded separately so two builds carrying the same
        # `built` still have a stable order.
        "published": published,
        "variants": variants,
        "downloads": {str(k): str(v) for k, v in downloads.items()},
    }


def builds_json(pid: str, metas: list[dict], dev: bool = False,
                latest: str | None = None, fallback: dict | None = None) -> dict:
    """The build picker for one project.

    `builds` is the project's HISTORY and therefore a list of commits, newest
    first: the local slot is deliberately not one of them (SPEC 7.6), because it
    is one directory that gets overwritten and a list of one thing that keeps
    changing is not a history.

    The two moving names ride alongside instead, so the picker can offer them as
    the destinations they are without inventing entries: `has_dev` says the local
    slot is occupied, `latest` names the commit it currently resolves to. Either
    can be absent — a project whose only build is local has no `latest`, and one
    that has never been pushed from a laptop has no slot — and the picker must
    offer neither in that case, or it offers a link to a 404. They are answers
    about NAMES, which is why one is a flag and the other is a commit id: `dev`
    resolves to itself and there is nothing more to say about it.

    `fallback` is the local slot's own meta, used for the project name only when
    there is no commit build to take it from.
    """
    header = metas[0] if metas else (fallback or {})
    return {
        "pid": pid,
        "project": header.get("project", pid),
        "title": header.get("title", pid),
        "has_dev": bool(dev),
        "latest": latest,
        "builds": [{"commit": m["commit"], "built": m["built"]} for m in metas],
    }


def index_card(meta: dict) -> dict:
    """One project's card on the public index, built from its newest build."""
    total_gzip = sum(v["gzip"] for v in meta["variants"])
    return {
        "pid": meta["pid"],
        "project": meta["project"],
        "title": meta["title"],
        "commit": meta["commit"],
        "built": meta["built"],
        "parts": max(v["parts"] for v in meta["variants"]),
        "variants": len(meta["variants"]),
        "mb": f"{total_gzip / 1e6:.1f}",
    }
