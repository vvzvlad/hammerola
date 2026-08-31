"""Turning an accepted push into the files the browser reads.

Three things are generated here and nothing else writes them:

  * the normalized `meta.json` that the viewer fetches for one build,
  * `builds.json`, the per-project build picker,
  * the root `index.json` that feeds the front page (behind EDIT_TOKEN — see
    `_serve_index_json` in src/app.py for where the line runs and why).

Page HTML is not templated in any interesting sense: both pages are static and get
everything they show from JSON at runtime, which is exactly why one copy of the
browser code serves every project and every build. They are read from `templates/` — files in
the image, never in `data/`, because the volume would shadow them.

Validation lives here too, because "is this meta.json usable" and "what does the
page need" are the same question asked twice. Failures are raised as ValueError;
store.py turns them into a 422, which keeps this module free of HTTP concepts and
avoids an import cycle with the thing that calls it.
"""

import gzip
import json
import re
from functools import lru_cache
from pathlib import Path

# THE RULE ABOUT FILE NAMES IS IMPORTED, NOT WRITTEN HERE, and that import is
# the subject of issue #53. This module used to ask the question with checks
# inlined in `build_meta` — membership in what the build wrote, `/`,
# `GENERATED_FILES` — while `app._safe_name` asked it with a rule of its own
# that ALSO refused a leading dot, and `src/client/artifacts.py` approximated it
# a third time. Three copies, no two alike, and the disagreement published a
# build that could never be opened. `src/buildnames.py` is the single place that
# answers it now, and `tests/test_buildnames.py` asserts the three sides hold
# the same OBJECT rather than a copy of it — which is what fails on the day
# somebody inlines one again.
# `_first_nonprintable` travels with it because `_plain_text` below asks the same
# question of every displayed field, and the two must not drift apart on what
# "printable" means.
from src.buildnames import _first_nonprintable, unservable_reason

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"

# A download label ends up as a button caption. Kept to the same shape as a file
# name so it can never carry markup, a quote or a control character: the pages
# build their DOM with textContent, and this is the second line of that defence.
SAFE_LABEL = re.compile(r"\A[A-Za-z0-9._-]{1,32}\Z")

# Free-text fields shown on the index and the build page. Long enough for a real
# title, short enough that one push cannot push every other card off the screen.
MAX_TEXT = 200

# How many parts of one build may carry an author's note. A per-note length
# ceiling is not enough on its own, and the count is not a tidiness rule: every
# note is legal at 200 characters, so 100 000 of them make a 20 MB meta.json
# that every visitor of that build page downloads — under a year of `immutable`,
# from a push that can never be taken back. It also bounds the work the
# validation loop below does per push, which is the other half of accepting a
# document whose size the sender chooses.
MAX_NOTES = 200

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
    bad = _first_nonprintable(value)
    if bad is not None:
        raise ValueError(
            f"`{field}` contains a non-printable character {bad!r}")
    return value


def project_title(value) -> str:
    """A project's name, checked exactly as a build's own title is.

    Public where `_plain_text` is not, because a title now arrives from two
    directions — inside a build's meta.json, and from `POST
    /api/v1/projects/<pid>/title` — and both end up in the same two captions, on
    the index card and on the build page. A second rule for the second door would
    be a way to put on the site what a push cannot.

    A non-string is refused rather than coerced: `str(None)` is a perfectly
    printable title reading "None", and a caller that sent the wrong field has to
    hear about it instead of renaming a project to that.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError("`title` must be a non-empty string")
    return _plain_text(value.strip(), "title")


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


def _check_declared_file(name, files: dict, where: str) -> None:
    """The file one entry of a build's four file-declaring maps points at.

    FOUR CALLERS: `views[].file`, and one entry each of `downloads`, `overview`
    and `previews`. One helper for all four because they make the same claim
    about a name — "this build wrote a file called that, and the hub will hand
    it back" — and differ only in what the KEY beside it means: a view id, a
    button caption, a part's stem. Each of the questions below is a way the push
    is accepted and then serves something other than what was measured here, so
    they move together or not at all. `views` was the last to arrive and it
    arrived through a bug: it kept an inline check of its own that asked
    membership, `/` and `GENERATED_FILES` and neither of the two clauses the
    shared rule had grown, so the exact defect issue #53 exists to kill was
    still live on the one map without which a build page is empty.
    """
    # `files` is what the build DECLARED it wrote, hashed by `_hash_output`. It
    # is a real file under this build — `runner._verify_output_file` checked
    # that, along with the path shape and every symlink on the way down — and
    # that is all it is: no alphabet is applied to an output name anywhere on
    # that path, and the names are chosen by model code (see the threat model in
    # src/buildproc/child.py). So membership answers "is it there", and the rule
    # the file server goes by has to be asked separately, below.
    if not isinstance(name, str) or name not in files:
        # "declare", not "write": `files` is `BuildOutcome.files`, curated as
        # `shipped` in cadbuild/build.py, and never a walk of the directory — a
        # build may write a file and leave it undeclared (`store._hash_output`),
        # and telling that author it "did not write" the file sends them looking
        # at the wrong half.
        raise ValueError(
            f"{where} points at {name!r}, which this build did not declare "
            "(the list is what the build shipped, not what its directory holds)")
    # The name the file server will and will not answer for, asked in the one
    # place that decides it. An entry the server refuses would publish with a
    # 201 and 404 in the browser — a build that is accepted and cannot be opened.
    reason = unservable_reason(name)
    if reason is not None:
        raise ValueError(f"{where} points at {name!r}, which {reason}")
    # A name the hub writes itself would be measured here and then answered by
    # the hub's own file — the rewritten meta.json, or the generated page at
    # index.html — so what is served is not what these checks looked at. NOT part
    # of the shared rule above: the server answers these three names perfectly
    # well, and it is this side that must not point at one.
    if name in GENERATED_FILES:
        raise ValueError(
            f"{where} points at {name!r}, which the hub rewrites after this "
            f"check; pick another file name")


def _check_map_size(value, field: str, files: dict) -> None:
    """How many entries one file-declaring map may carry, counted before the loop.

    FOUR CALLERS, AND ONE OF THEM IS A LIST: `downloads`, `overview` and
    `previews` are objects, `views` is an array of objects. The argument is
    therefore any sized collection rather than a dict — nothing here looks
    inside it, and "entries" is the right word for a row of either. `views` is
    the most expensive of the four by orders of magnitude, which is why it may
    least of all go uncounted: every entry costs a full parse of its view file
    (`check_view_file`) and a full gzip of it (`measure_view`), measured at
    ~18 ms on a 0.9 MB view, and N entries may point at ONE file — `seen`
    forbids a duplicate view id, not a duplicate file name. A hundred thousand
    of them is hours of CPU inside `_finish_staging`, in a build worker thread,
    with two of those in the whole process.

    Counted FIRST, before the loop, exactly as `notes` is counted below — the
    ORDER is what the two share and it is the whole of what they share: refusing
    after walking the document is paying for precisely what the ceiling exists
    to refuse to pay for. What it stops is the shape a per-entry rule cannot
    see: every entry legal, in enormous numbers.

    IT IS NOT PARITY WITH `MAX_NOTES` AND MUST NOT BE READ AS ONE. That number
    is 200; this ceiling is `len(files)`, and on the build path `files` is
    bounded by `limits.output_files` — 4096. So a model that writes 4096 tiny
    files may legally declare on the order of four thousand entries in EACH of
    `downloads`, `overview` and `previews`, with the `overview`/`previews` keys
    running to MAX_TEXT and the file names to no length ceiling at all
    (`buildnames.unservable_reason` has none, deliberately). That is a
    `meta.json` of a few megabytes, served under a year of `immutable` to every
    visitor of that build — where the notes ceiling permits tens of kilobytes.
    Different orders of magnitude, so "for the same reason" is exactly what must
    not be said about the pair: what they share is the ORDER of the count, and
    nothing else.

    STILL WORTH HAVING, AND ACCEPTED RATHER THAN TIGHTENED. What it buys is the
    shape check it was added for: "unbounded" becomes "bounded by what the build
    actually wrote", so no map can be enormous without the FILES being enormous
    too, and the millions-pointing-at-one-file shape is gone. What is left is a
    ceiling that is loose rather than absent, and three things are why no number
    is put in front of it. Reaching it takes a model that really writes
    thousands of files — nothing stops one, since a build names and counts its
    own output, but it is a deliberate act by whoever holds the secret rather
    than something an honest project drifts into. The cost falls on the visitors
    of that ONE build page, not on the shared `/index.json` every visitor of `/`
    downloads with `no-cache` — which is the asymmetry MAX_BUILT above exists
    for and the reason its ceiling is a number. And the build is not beyond
    reach afterwards: the project can be removed whole with the same secret that
    published it (`DELETE /api/v1/projects/<pid>`), so "can never be taken back"
    is true of the URL and not of the deployment.

    WHAT IT DOES NOT BOUND AT ALL is the document on the way IN.
    `Store._read_meta` reads `meta.json` with a single `read_text()` and no size
    cap of its own, and the build that wrote that file was held only by
    `limits.file_bytes` — 256 MiB. So the INPUT side is still unbounded in the
    sense that matters for memory; this ceiling is about what gets PUBLISHED,
    and nothing here should be read as covering the parse.

    THE BOUND IS THE BUILD'S OWN FILE COUNT, and it is derived rather than
    chosen: every entry here has to name a member of `files`, so a build that
    really produced what it describes cannot declare more entries than it
    published files — `downloads` names three per part, `previews` one per part
    plus one of each whole-build mesh, `overview` at most two, `views` one file
    per view (`export_views` writes `<vid>.json`), and every one of those names
    is on that list. Beyond it, entries are repeats of a name already declared,
    which is the millions-pointing-at-one-file shape and nothing an honest build
    does.

    A constant would be worse here, not tidier. MAX_NOTES is a count of PARTS,
    so `downloads` would need three times it and the four callers would stop
    sharing a rule. `files` is already capped — by `limits.output_files`, on the
    build path — so this inherits a ceiling instead of inventing a second one
    that can drift from it. ONE SOURCE, NOT TWO, and MAX_MEMBERS is not the
    second: there is no archive path here at all.
    `build_meta` is called from `Store._finish_staging` alone, and the `files`
    it is handed is always `_hash_output(staging, names)` — what the BUILD
    declared it wrote. The mapping `_unpack` builds out of an archive's members
    goes to `_payload_digest` and nowhere else, so MAX_MEMBERS never bounds
    anything this reads.
    """
    if len(value) > len(files):
        raise ValueError(
            f"`{field}` carries {len(value)} entries, more than the "
            f"{len(files)} files this build published; every entry has to name "
            f"one of them")


def _stem_map(raw: dict, field: str, files: dict) -> dict:
    """One of the two maps a build declares keyed by a STEM: `overview`,
    `previews`.

    `overview` is the whole build's own meshes (`assembled.stl`, and the print
    plate where the project has a `print` view); `previews` is every picture it
    rendered, one per part plus one of each of those two. They are two maps and
    not one for exactly one reason: keyed by the stem, `assembled` names
    `assembled.stl` in the first and `assembled_preview.png` in the second, so
    one map loses one of them.

    Neither is `downloads`, and that is the other half of the same decision:
    that map is read as PER PART — cut up by splitting `<part>.<ext>` off each
    file name — so a whole-build file left in it is attributed to a part called
    `assembled`, a name a view part may legally carry.

    READ WITH AN EXPLICIT `is None`, never `raw.get(field) or {}`: that spelling
    turns a falsy non-object — `[]`, `""`, `0` — into "nothing here" and
    publishes a push that described something else, in silence. It is the rule
    for every optional object on this document, and `downloads` was the last
    place it was not followed: it read `or {}` until the review of issue #53, so
    `downloads: 0` published a build with no download buttons and told nobody.
    """
    value = raw.get(field)
    if value is None:
        value = {}
    if not isinstance(value, dict):
        raise ValueError(f"`{field}` must be an object mapping stem -> filename")
    _check_map_size(value, field, files)
    for stem, name in value.items():
        # The key is a part NAME — it is what a reader matches against the parts
        # in the view file to find the picture of one — so it is held to a part
        # name's rule, exactly as a note's key is. SAFE_LABEL would be the wrong
        # rule in the direction that refuses honest pushes: it caps at 32
        # characters, and the ceilings a part name really has are far above that
        # — 128 on the build side (MEMBER_RE) and MAX_TEXT here — so a name of,
        # say, 48 characters publishes today. It publishes on a single-printable
        # build in particular, where the download labels degenerate to
        # `stl`/`step`/`3mf` with the name gone from them, so nothing about that
        # project ever met the caption rule. The key has a ceiling; what it does
        # not have is a CAPTION's ceiling.
        _check_part_name(stem, f"a stem in `{field}`")
        _check_declared_file(name, files, f"`{field}` entry {stem!r}")
    return value


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
    # COUNTED BEFORE THE WALK, like the three maps below and more urgently than
    # any of them: an entry here costs a parse and a gzip of a whole view file
    # rather than a dict lookup. Same bound and same derivation — every entry
    # has to name a file this build published, and an honest build writes one
    # view file per view.
    _check_map_size(views, "views", files)

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

        # THE SAME QUESTION THE OTHER THREE MAPS ARE ASKED, through the same
        # helper. This loop used to ask a version of it inline — membership, `/`
        # and `GENERATED_FILES` — and that version never grew the leading-dot
        # and non-printable clauses the shared rule has, so a view file called
        # `.assembled.json` published with a 201 and 404'd on every GET, on the
        # one map without which the build page has nothing to draw at all.
        name = view.get("file")
        _check_declared_file(name, files, f"view {view_id!r}")

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

    # READ WITH AN EXPLICIT `is None`, for the reason `_stem_map` gives at
    # length: `raw.get("downloads") or {}` — which is what stood here — turns
    # every falsy non-object into "no downloads at all", so `downloads: 0`
    # published a build whose buttons had silently vanished, with nothing
    # anywhere saying the push had described something else.
    downloads = raw.get("downloads")
    if downloads is None:
        downloads = {}
    if not isinstance(downloads, dict):
        raise ValueError("`downloads` must be an object mapping label -> filename")
    # THE SAME CEILING AS THE TWO MAPS BELOW, from the same helper: this map had
    # the gap first and for longer — a label is capped at 32 characters and a
    # count of them was capped at nothing, so a hundred thousand legal labels
    # made the same enormous, permanent, `immutable` meta.json.
    _check_map_size(downloads, "downloads", files)
    for label, name in downloads.items():
        # The label becomes a button caption, so it is whitelisted rather than
        # escaped: nothing that matches this can be markup in any context.
        if not isinstance(label, str) or not SAFE_LABEL.match(label):
            raise ValueError(
                f"download label {label!r} must match {SAFE_LABEL.pattern}")
        _check_declared_file(name, files, f"download {label!r}")

    # What the build published about the WHOLE of itself, and about each part in
    # a picture. Neither map draws anything on either page — they are how a
    # CLIENT is told a file exists, since the hub enumerates no directory — and
    # both are validated all the same, because a name in either is a name this
    # service will be asked for.
    overview = _stem_map(raw, "overview", files)
    previews = _stem_map(raw, "previews", files)

    # The AUTHOR's note on a part: text written in model.py, keyed by part name,
    # shown to whoever opens the build. Absent is the ordinary case, and stays
    # absent below — a build with no notes and a build from before notes existed
    # have to be one document here.
    #
    # NOT `raw.get("notes") or {}`: that spelling turns a falsy non-object —
    # `[]`, `""`, `0` — into "no notes at all" and publishes a push that
    # described something else entirely, in silence. Every optional object on
    # this document is read this way now; `downloads` above was the last one
    # that was not, and it stood here as the counter-example until issue #53.
    notes = raw.get("notes")
    if notes is None:
        notes = {}
    if not isinstance(notes, dict):
        raise ValueError("`notes` must be an object mapping part name -> text")
    # Counted BEFORE the loop: refusing after walking the document is paying for
    # exactly what the ceiling exists to refuse to pay for.
    if len(notes) > MAX_NOTES:
        raise ValueError(
            f"`notes` carries {len(notes)} entries, more than the {MAX_NOTES} "
            f"one build may declare")
    for name, text in notes.items():
        # The key IS a part name — it is matched against the ones in the view
        # file — so it is held to the part-name rule and not to the softer
        # free-text one.
        _check_part_name(name, "a note's part name")
        if not isinstance(text, str):
            raise ValueError(
                f"the note on part {name!r} is {text!r}, which is not a string")
        _plain_text(text, f"note on part {name!r}")
        # Angle brackets are banned here for the BOUNDARY rather than for any
        # one renderer: this text arrives from a push, i.e. from anybody who can
        # land a commit in a model repository, and where the browser half ends
        # up putting it is a decision made later, on a page that is permanent,
        # immutable and shares an origin with every other project on the host.
        # Text that cannot open an element cannot become markup whatever renders
        # it — the same argument that holds for a part name. NOT for `title` and
        # `project`, and that is the code rather than an omission here: those two
        # go through `_plain_text` alone, so a bracket in a title is published.
        # Read this sentence before "fixing" either side into agreement.
        if "<" in text or ">" in text:
            raise ValueError(
                f"the note on part {name!r} contains an angle bracket: {text!r}")

    # Both are shown verbatim on the index and the build page. The pages render
    # them with textContent, but a push is not allowed to smuggle control
    # characters or a page-wide banner through them either.
    project = _plain_text(str(raw.get("project") or pid), "project")
    title = _plain_text(str(raw.get("title") or project), "title")

    # `built` is the model's own timestamp and is what the build picker and
    # `latest` order by. It is optional: a project that does not set it gets the
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

    meta = {
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
    # Emitted only when there is something to emit: an empty object here would
    # be a build SAYING it has no notes, and the browser half would then have
    # two ways of asking the same question — one of which no older build gives.
    # The same rule, and the same reason, for the two maps beside it: a build
    # that rendered no pictures and a build made before `previews` existed have
    # to reach a reader as one document.
    if overview:
        meta["overview"] = dict(overview)
    if previews:
        meta["previews"] = dict(previews)
    if notes:
        meta["notes"] = dict(notes)
    return meta


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


def index_card(meta: dict, *, dev: bool, first_built: str) -> dict:
    """One project's card on the public index.

    Built from its NEWEST commit build, plus two facts that belong to the project
    rather than to any single build and are therefore passed in by the caller
    (`Store._refresh_index`, which is already holding both).

    `dev` is whether the local slot is occupied. The card still describes the
    newest COMMIT and never the slot — that is SPEC 7.6 and the front page is
    exactly where it matters — but "there is uncommitted work in this project"
    is a different statement from "this is what the project looks like", and only
    the second one is a promise about the link.

    `first_built` is the honest answer to a question the hub cannot answer. It
    does not know when a project was CREATED: `hammerola create` mints an id in
    the author's own directory and nothing reaches this side until the first
    push, so the earliest moment on record is a build. The card therefore carries
    the OLDEST build still here and the page labels it as that rather than as a
    creation date. It is a stable answer and not a drifting one only because
    there is no retention (SPEC 5.3): builds are never swept, so the oldest one
    stays the oldest.
    """
    total_gzip = sum(v["gzip"] for v in meta["variants"])
    return {
        "pid": meta["pid"],
        "project": meta["project"],
        "title": meta["title"],
        "commit": meta["commit"],
        "built": meta["built"],
        "first_built": first_built,
        "dev": bool(dev),
        "parts": max(v["parts"] for v in meta["variants"]),
        "variants": len(meta["variants"]),
        "mb": f"{total_gzip / 1e6:.1f}",
    }
