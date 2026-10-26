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

# The file-name rule lives in hammerola/buildnames.py, so this module, the file
# server (`app._safe_build_path`) and hammerola/artifacts.py share one object
# (tests/test_buildnames.py asserts it). `first_nonprintable` comes with it so
# `_plain_text` agrees with it on what "printable" means.
from hammerola.buildnames import (first_nonprintable, unservable_path_reason,
                                  unservable_reason)

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"

# The key a part files an exported file under — `stl`, `step`, `3mf` — shown as
# a download button's caption. Kept to the shape of a file name so it can never
# carry markup, a quote or a control character: the pages build their DOM with
# textContent, and this is the second line of that defence.
SAFE_LABEL = re.compile(r"\A[A-Za-z0-9._-]{1,32}\Z")

# Free-text fields shown on the index and the build page. Long enough for a real
# title, short enough that one push cannot push every other card off the screen.
MAX_TEXT = 200

# How many parts one build's catalogue may carry. Every record is legal at its
# own ceilings, so 100 000 of them would make a 20 MB meta.json served under a
# year of `immutable`; it also bounds the validation loop per push. It counts
# records, not notes: records without a note cost the same megabytes. Equal to
# `cadbuild.hubspec.MAX_PARTS` (tests/cadbuild/test_naming.py). The number of
# FILES the catalogue points at is bounded by `_spend_file_budget`.
MAX_PARTS = 200

# What a catalogue entry may say a part is. A transcription of
# `cadbuild.parts.KINDS`, not an import: the serving side never imports the
# build half. Held equal by tests/cadbuild/test_naming.py. An unknown kind is
# refused rather than carried through: the browser draws a record by its kind,
# so a kind nothing recognises is a part nobody sees.
KIND_PRINTABLE = "printable"
PART_KINDS = (KIND_PRINTABLE, "hardware", "mock")

# A project lists the files it publishes to be read under `documents` in its
# project.json (`src/docsbuild.py`); a model's build carries them beside its
# views. A tree with no model publishes nothing else, and its meta.json says
# `"kind": "documents"` instead of carrying views and parts; the page picks
# its shell by that word alone (`DOCUMENTS_KIND` in `ui/src/DocShell.jsx`).
DOCUMENTS_KIND = "documents"

# What the page DRAWS, by extension. Not what may be listed: a document of any
# other extension is published as `FILE_TYPE` below. `app.OPEN_SUFFIXES` and
# `app.BUILD_CONTENT_TYPES` cover every key (tests/test_documents.py).
DOCUMENT_TYPES = {
    ".md": "markdown",
    ".pdf": "pdf",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".gif": "image",
    ".webp": "image",
    ".html": "html",
    ".htm": "html",
    ".svg": "svg",
    ".kicad_sch": "schematic",
    ".kicad_pcb": "board",
    # The 3D model of a board, as `kicad-cli pcb export glb` writes it.
    ".glb": "board3d",
    # The Gerber and drill files of a board, the one zip that goes to the fab.
    # The page unpacks it and draws the layers (ui/src/GerberView.jsx); the hub
    # neither opens nor checks it.
    ".zip": "gerbers",
}
SCHEMATIC_TYPE = DOCUMENT_TYPES[".kicad_sch"]
BOARD_TYPE = DOCUMENT_TYPES[".kicad_pcb"]

# A document the page does not draw: a file published to be taken rather than
# read — the DXF a glass shop cuts from, a CSV of measurements, a supplier's
# STEP the model does not build. The page gives it a row that downloads the
# file instead of showing it, and the hub serves it to a plain link like every
# other document (`app.OPEN_SUFFIXES`). A DXF not listed with `download` also
# carries `preview`, the path of the SVG the hub drew of it (`dxf_preview`,
# `docsbuild._draw_dxf`), which the page shows in place of the file; it stays
# a plain file all the same, offered by the Downloads menu and the page's bar
# and handed over as an attachment.
#
# DELIBERATELY NOT A KEY OF `DOCUMENT_TYPES`: that table answers "which
# extension does the page draw, and how", and three places ask it that way —
# `src/docsbuild.py` picks a schematic and a board out of a list by it, and
# `app.OPEN_SUFFIXES` and `app.BUILD_CONTENT_TYPES` are built from its keys. A
# plain file has no extension of its own; it is every extension the table does
# not name, so there is no row to put it in.
FILE_TYPE = "file"

# A KiCad schematic or board is a document of its own and arrives as the files
# the page's viewer reads raw (`src/docsbuild.py` finds a schematic's sheets and
# the project beside either): every one of them is served as text and opens
# without a key, like a document (`app.BUILD_CONTENT_TYPES`,
# `app.OPEN_SUFFIXES`). The project is never listed on its own.
KICAD_PROJECT = ".kicad_pro"
KICAD_SCHEMATIC = ".kicad_sch"
KICAD_BOARD = ".kicad_pcb"
KICAD_SUFFIXES = (KICAD_PROJECT, KICAD_SCHEMATIC, KICAD_BOARD)

# How many schematic files one schematic may bring, itself among them. A ceiling
# rather than a measurement: a real hierarchy is a handful, and the hub reads
# every one of them to find the next.
MAX_KICAD_SHEETS = 64

# `built` is displayed like the rest but it is a timestamp, so its ceiling is the
# length of one, with room for a long timezone spelling. It lands in the shared
# /index.json every editor downloads with `no-cache` (`_serve_index_json` in
# src/app.py), where a free-text ceiling across 200 projects would make an index
# nobody can load.
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

# The only keys of a view file this module looks at. Everything else — the
# vertex, index and normal buffers that make up ~99% of a view — is dropped as
# the parser produces it (see `_view_fields`), so validating a view costs the
# size of its largest single buffer rather than the whole parsed document. A key
# not on this list is never validated: `key` is here because `export_views`
# stamps the catalogue key on every leaf and the browser looks records up by it.
VIEW_KEPT_KEYS = ("name", "color", "parts", "key")

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
    bad = first_nonprintable(value)
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


# -- the theme, which the server decides --------------------------------------
#
# The whole interface is painted from `data-theme` on `<html>`: the bundle draws
# inline styles, so only a `var()` resolved against an ancestor can repaint them
# (see `css()` in ui/src/style.jsx). The attribute has to be right in the first
# byte the browser parses. An inline pre-paint script is refused by the CSP
# (`CSP_HTML` in src/app.py) and the resolver page runs no bundle, so the
# reader's choice arrives as a cookie, with the request for the page.

THEME_COOKIE = "hammerola.theme"

# The two the palette defines and the vendored library takes. Spelled here as
# well as in ui/src/store.js because the two sides cannot share a module;
# `tests/test_ui_source.py` holds the name and the values equal across them, the
# way `tests/test_pointer_memory.py` does for the pointer key.
THEMES = ("light", "dark")
DEFAULT_THEME = "light"

# What the templates carry, and therefore what a swap has to replace. Writing the
# default INTO the files rather than a placeholder into them keeps each template
# a working light page on its own — openable from disk, and correct if this
# substitution ever stops happening.
THEME_ATTRIBUTE = 'data-theme="{}"'
DEFAULT_STAMP = THEME_ATTRIBUTE.format(DEFAULT_THEME)

# The swap is confined to the opening `<html>` tag: templates/build.html quotes
# the library's `[data-theme="light"]` selector in a comment, which a plain
# `str.replace` over the file would stamp instead of the element.
HTML_TAG = re.compile(r"<html\b[^>]*>")


def cookie_theme(header: str) -> str:
    """The theme this request asks for: one of THEMES, always.

    Absent, unparseable or unknown all mean light, as `readTheme` in
    ui/src/store.js answers: the header carries whatever any version of this site
    or anything else on this host wrote, and a value nobody recognises opens the
    page the way a first visit does.

    Parsed by hand rather than with `http.cookies`: SimpleCookie drops the rest
    of the header when it meets a pair it cannot parse, so another cookie on this
    host could take ours with it.
    """
    for part in (header or "").split(";"):
        name, _, value = part.partition("=")
        if name.strip() == THEME_COOKIE:
            value = value.strip()
            return value if value in THEMES else DEFAULT_THEME
    return DEFAULT_THEME


@lru_cache(maxsize=None)
def _template(name: str, theme: str) -> str:
    """One page template, read once per process and stamped with one theme.

    Templates are immutable inside the image, so re-reading per request would buy
    nothing. The theme is part of the cache key, which stays tiny only because
    `_page` normalizes it: `maxsize=None` keyed on a string a request chose would
    let a client fill memory.
    """
    html = (TEMPLATES_DIR / name).read_text(encoding="utf-8")
    return HTML_TAG.sub(
        lambda tag: tag.group(0).replace(
            DEFAULT_STAMP, THEME_ATTRIBUTE.format(theme), 1),
        html, count=1)


def _page(name: str, theme: str) -> str:
    """One page, in a theme this module recognises — whatever it was handed.

    Normalized here, in front of the cache, so an unknown string never mints a
    cache entry.
    """
    return _template(name, theme if theme in THEMES else DEFAULT_THEME)


def build_page_html(theme: str) -> str:
    """The shell of one build's page, served from the image on every request.

    Not written into the build directory (`app._serve_build_page`): the shell is
    identical for every build and changes with the image, so a copy served under
    a commit URL's year of `immutable` would freeze each build on the markup of
    the day it was pushed.
    """
    return _page("build.html", theme)


def index_page_html(theme: str) -> str:
    """The public index at `/`. Served from the image, not from data/."""
    return _page("index.html", theme)


def pointer_page_html(theme: str) -> str:
    """`/project/<pid>/` — the URL that names no pointer (SPEC 9).

    A page and not a 302, because what decides the destination is a localStorage
    key and only the browser can read it. It carries no project-specific text at
    all: the script reads the pid off its own URL, exactly as the build page
    does, so this stays one template rather than a per-project render.

    The THEME is the one thing about this page the browser cannot work out for
    itself — it loads no bundle and reads no storage — so the stamp above is the
    only reason it can be dark at all.
    """
    return _page("pointer.html", theme)


def _view_fields(pairs):
    """`object_pairs_hook` that keeps only the fields the part tree renders.

    The alternative is `json.load` as it comes, which materializes every vertex
    and index buffer of a 2 MB view as Python floats and ints — several times the
    file in resident memory, four publish slots at a time, to look at two string
    fields. Dropping the rest here frees each buffer the moment its parent object
    is built, so the peak is one buffer instead of the whole document.
    """
    return {key: value for key, value in pairs if key in VIEW_KEPT_KEYS}


def document_type(name: str) -> str | None:
    """The type a document called `name` is shown as, or None if it is none."""
    return DOCUMENT_TYPES.get(Path(name).suffix.lower())


def published_type(name: str) -> str:
    """The type a document called `name` is published under: what the page
    draws it as, else a plain file.

    A SECOND FUNCTION rather than a changed `document_type`, because the two
    answer different questions and both are asked. "Does the page draw this
    extension" has the answer "no" — `src/docsbuild.py` reads it that way to
    find the schematics and the boards in a list, and would find every DXF a
    schematic if "no" became a type. "What does this document's entry say it
    is" has no "no": every published document carries a type, and for a file
    the page cannot draw that type is `FILE_TYPE`.
    """
    return document_type(name) or FILE_TYPE


def dxf_preview(name: str) -> str | None:
    """Where the picture of the document at `name` is published if it is a
    DXF, of any case: beside it, its path with `.svg` after it
    (`cut/glass.dxf.svg`). None for any other document."""
    return name + ".svg" if Path(name).suffix.lower() == ".dxf" else None


# What stands for `/` in a document's id, which the page carries as `?d=<id>`.
DOCUMENT_ID_SEPARATOR = "__"


def document_id(path: str) -> str:
    """The id of the document at `path`: the path, with `/` spelled `__`.

    Readable in an address (`?d=docs__cut-list.md`) where a slash would be
    `%2F`. Two paths can meet under one id (`a/b.md` and `a__b.md`), and a
    build listing both is refused (`_documents`, `docsbuild`), so within one
    build an id names one document.
    """
    return path.replace("/", DOCUMENT_ID_SEPARATOR)


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


def _check_declared_file(name, files: dict, where: str, *,
                         path: bool = False) -> None:
    """Every file this document points at, wherever it is pointed at from.

    Callers: a view's `file`, `overview`, `preview` and `card`, a catalogue
    record's exported `files` and `preview`, and a document's `file` and a
    DXF's `preview`. They all claim "this build wrote a file called that, and
    the hub will hand it back". Each check below is a way a push could be
    accepted and then serve something other than what was measured here, so
    they apply to every pointer together.

    `path` is for a document, which keeps its place in the tree and so may sit
    in a subdirectory (`buildnames.unservable_path_reason`); every other
    pointer names a file at the top of the build.
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
    reason = (unservable_path_reason if path else unservable_reason)(name)
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
    """How many entries one file-declaring list (`views`, `documents`) may carry.

    Every view entry costs a full parse (`check_view_file`) and a full gzip
    (`measure_view`) of its file, ~18 ms on a 0.9 MB view, and many entries may
    point at one file (`seen` forbids duplicate view ids, not duplicate file
    names). Counted before the loop, so refusing does not pay for what the
    ceiling exists to refuse.

    The ceiling is `len(files)`, derived rather than chosen: every entry has to
    name a file the build declared, and `export_views` writes one `<vid>.json`
    per view. It is loose — on the build path `files` is bounded by
    `limits.output_files` (4096), so a meta.json of a few megabytes is possible —
    unlike `MAX_PARTS` or `MAX_BUILT`. The cost falls on one build page rather
    than the shared /index.json, and the project can be deleted with the secret
    that published it.

    It does not bound the input: `Store._read_meta` reads meta.json without a
    size cap of its own, held only by `limits.file_bytes`. `files` here is always
    `_hash_output(staging, names)` from `Store._finish_staging`, never archive
    members, so MAX_MEMBERS plays no part.
    """
    if len(value) > len(files):
        raise ValueError(
            f"`{field}` carries {len(value)} entries, more than the "
            f"{len(files)} files this build published; every entry has to name "
            f"one of them")


def _spend_file_budget(left: int, count: int, where: str, files: dict) -> int:
    """How many file pointers the catalogue may hold in total, spent as counted.

    The bound `_check_map_size` applies to a list, applied across records. Per
    record it would be far weaker: MAX_PARTS records could each point at
    `len(files)` names, a fifty-megabyte meta.json.

    An honest build spends less than it is given: every pointer names a
    published file, a printable owns its three exports plus its picture, no two
    records own one file, and `meta.json` and `metrics.json` are pointed at by
    nobody. The views' pointers are not on this budget; `_check_map_size` bounds
    them as entries.
    """
    left -= count
    if left < 0:
        raise ValueError(
            f"the catalogue points at more files than the {len(files)} this "
            f"build published, and {where} is where it ran past them; every "
            f"one of them has to name a file the build shipped")
    return left


def _check_note(value, key: str) -> None:
    """The author's note on a part: text written in model.py, shown to a reader.

    Angle brackets are banned at the boundary rather than for one renderer: the
    text comes from a push and lands on a permanent page sharing an origin with
    every other project, and text that cannot open an element cannot become
    markup whatever renders it. `title` and `project` deliberately go through
    `_plain_text` alone, so a bracket in a title is published.

    An empty string and padding are refused, not normalized:
    `cadbuild.parts._check_note` strips a note and refuses an empty one, so this
    side accepts exactly what the build can produce (stripped, non-empty) and
    refuses the rest. Normalizing here would be the hub editing a document it did
    not write, and would let one note publish as two different byte strings. Only
    a hand-made push reaches these refusals: `cadbuild.build` writes the key
    under `if record["note"]:`.
    """
    if not isinstance(value, str):
        raise ValueError(
            f"the note on part {key!r} is {value!r}, which is not a string")
    if not value:
        raise ValueError(
            f"the note on part {key!r} is empty; a note with no text is not a "
            f"note — leave the key out rather than writing \"\"")
    if value != value.strip():
        raise ValueError(
            f"the note on part {key!r} starts or ends with whitespace: "
            f"{value!r}; the build strips a note before it publishes one, so "
            f"this is text no build can write — send it without the padding, "
            f"and leave the key out when the padding is all there is to it")
    _plain_text(value, f"note on part {key!r}")
    if "<" in value or ">" in value:
        raise ValueError(
            f"the note on part {key!r} contains an angle bracket: {value!r}")


def _catalogue(raw: dict, files: dict) -> dict:
    """`parts`: every part of this build, filed under the key that is its name.

    The key is the identity: it travels from the model's own parts() through the
    view files and this document into the browser unchanged, so no reader
    reconstructs which part is which from a shape or a file name.

    REQUIRED AND NON-EMPTY, exactly like `views`: the build refuses a `parts()`
    that returns an empty dict, so a document with no catalogue is not one this
    hub can have written — and `_usable_meta` in store.py refuses the same
    shape from the other end, which is the pairing that has to stay true.
    Accepting an empty one here would publish a build the index then silently
    declines to list.

    Optional fields are read with an explicit `is None`, never
    `record.get(field) or {}`, which would turn a falsy non-object (`[]`, `""`,
    `0`) into "nothing here" in silence. Absent rather than empty: an empty
    spelling (`files: {}`, `note: ""`) is refused, never dropped — the hub does
    not edit a document it did not write, and `cadbuild.build` writes each of
    those keys only when it has something to put there. A field written `null`
    reads as absent and is not emitted; `kind` is not optional, so `kind: null`
    is refused.

    A printable carries files, mirroring the build side:
    `cadbuild.printables.export_printables` exports STEP, STL and 3MF for every
    printable. A catalogue with no printable in it publishes like any other.

    A FIELD WRITTEN `null` IS THEREFORE AN ABSENT ONE, uniformly, and that is a
    reading rather than an oversight: `null` is the JSON spelling of "nothing
    here", and this document is REBUILT rather than passed through, so the two
    spellings collapse into the one a reader sees. `notes: {"lid": null}` used to
    be a 422 -- the flat map's VALUES were notes, and a null one was a broken
    row -- and the danger that refusal covered is still closed, from the other
    end: a null never reaches the browser, because the key is not emitted. What
    changed is the verdict on the push, not what is served. `kind` is the one
    field this does not apply to, because it is not optional: `kind: null` is
    refused with every other non-kind.

    A PRINTABLE CARRIES FILES. That is the claim this side makes about what a
    BUILD can produce, and it arrived late because its MIRROR IMAGE was already
    here: a non-printable that declares files is a 422 four lines from the
    printable that declared none and was accepted. It is checked on the build
    side and can be read there: `cadbuild.printables.export_printables` writes
    STEP, STL and 3MF for EVERY printable and `cadbuild.build` files them under
    the record, so a printable with no `files` is a record no build wrote. A
    catalogue with NO printable in it is a build like any other — a bought
    enclosure around factory boards has nothing to print and is still worth
    looking at.

    WHAT IS DELIBERATELY NOT ASKED HERE, so that nobody completes the symmetry
    later: the build ALSO guarantees a view called `assembled` and an
    `overview` on it (`cadbuild.views`), and neither is required by this side.
    `assembled` is an id the BUILD half invented; the serving half knows
    nothing about a view beyond its `id`, its `file` and the keys it selects,
    and demanding a particular id would write the build half's vocabulary into
    the receiving side — a coupling that does not exist today and costs more
    than the hole it closes. The rule above needs no such vocabulary:
    `printable` is a word this module already spells (`KIND_PRINTABLE`) and
    `files` is a field it already reads.
    """
    catalogue = raw.get("parts")
    if not isinstance(catalogue, dict) or not catalogue:
        raise ValueError(
            "meta.json must carry a non-empty `parts` catalogue: an object "
            "keyed by part name, one entry per part, `kind` on every entry")
    # Counted BEFORE the walk, for the reason `_check_map_size` gives at length:
    # refusing after walking the document is paying for exactly what the ceiling
    # exists to refuse to pay for.
    if len(catalogue) > MAX_PARTS:
        raise ValueError(
            f"`parts` carries {len(catalogue)} entries, more than the "
            f"{MAX_PARTS} one build may declare")

    budget = len(files)
    read = {}
    for key, record in catalogue.items():
        # The key is a part NAME — it is what the viewer puts on a tree row and
        # what every other side of this document points at — so it is held to
        # the part-name rule. SAFE_LABEL would be the wrong rule in the
        # direction that refuses honest pushes: it caps at 32 characters, and
        # the ceilings a part name really has are far above that — 128 on the
        # build side (MEMBER_RE) and MAX_TEXT here. A key has a ceiling; what it
        # does not have is a CAPTION's ceiling.
        _check_part_name(key, "a key in `parts`")
        where = f"part {key!r}"
        if not isinstance(record, dict):
            raise ValueError(
                f"{where} is {record!r}, which is not an object; every entry "
                f"is written {{\"kind\": \"printable\", ...}}")

        kind = record.get("kind")
        if kind not in PART_KINDS:
            raise ValueError(
                f"{where} has kind {kind!r}, which is not one of "
                f"{', '.join(repr(k) for k in PART_KINDS)}")
        entry = {"kind": kind}

        declared = record.get("files")
        if declared is None:
            # A build exports STEP, STL and 3MF for every printable, so a
            # printable with no files is a record no build wrote, and the
            # browser would draw a row promising buttons that are not there.
            if kind == KIND_PRINTABLE:
                raise ValueError(
                    f"{where} is {kind!r} and declares no files; every "
                    f"printable is exported, so a printable with nothing "
                    f"exported is a record no build writes")
        else:
            # A kind that ships nothing may not name a file, and the pair is
            # refused rather than half-read: `kind` is how the browser decides
            # whether to offer a download at all, so a bought screw carrying an
            # STL is a record whose two halves say different things and no
            # reader can be right about both.
            if kind != KIND_PRINTABLE:
                raise ValueError(
                    f"{where} is {kind!r} and still declares files; only "
                    f"{KIND_PRINTABLE!r} is exported")
            if not isinstance(declared, dict):
                raise ValueError(
                    f"the files of {where} must be an object mapping extension "
                    f"-> filename")
            # Refused, not dropped: see the docstring.
            if not declared:
                raise ValueError(
                    f"{where} declares an empty `files`; a record with nothing "
                    f"exported leaves the key out rather than writing {{}}, "
                    f"which the hub would otherwise have to edit away")
            budget = _spend_file_budget(
                budget, len(declared), f"the files of {where}", files)
            exported = {}
            for extension, name in declared.items():
                # The extension captions the download button, so it is
                # whitelisted rather than escaped.
                if not isinstance(extension, str) or not SAFE_LABEL.match(
                        extension):
                    raise ValueError(
                        f"{where} declares a file under {extension!r}, which "
                        f"must match {SAFE_LABEL.pattern}")
                _check_declared_file(name, files, f"the {extension} of {where}")
                exported[extension] = name
            # Unconditional: `declared` was refused if it was empty, and every
            # entry of it either produced one here or raised.
            entry["files"] = exported

        preview = record.get("preview")
        if preview is not None:
            budget = _spend_file_budget(
                budget, 1, f"the picture of {where}", files)
            _check_declared_file(preview, files, f"the picture of {where}")
            entry["preview"] = preview

        note = record.get("note")
        if note is not None:
            _check_note(note, key)
            entry["note"] = note

        read[key] = entry

    return read


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


def check_view_file(path: Path, view_id: str, catalogue: dict) -> set:
    """Refuse a view whose part tree could inject markup into the page, and
    report which catalogue keys it names.

    This is the ONLY thing standing between a push and the DOM here. The vendored
    viewer builds its tree with

        label.innerHTML = node.name;
        label.innerHTML += `<span style="color:${color}"> ⚈</span>`;

    and `name`/`color` come straight out of this file. The library is vendored
    (3.6 MB, replaced wholesale by its next release), so the check happens once,
    on the way in. The CSP is a backstop: it stops an injected <script> but not a
    `<form>` posting elsewhere or an `<a>` covering the page.

    `key` is the third string: `export_views` stamps the catalogue key on every
    leaf and the browser looks the record up by it, so it gets the same rule and
    has to name a record the catalogue declares. That is referential integrity
    only; which solid carries which key is decided by the model's own code.

    Every leaf has to carry a `key`, and every key seen (on leaves or groups) is
    returned for `_match_selection`, so `views[].parts` in meta.json can be
    trusted without fetching the view file. A node is a group when the field
    `parts` is present, whatever its value — the vendored viewer's own rule
    (`"parts" in shape`) — so `"parts": null` is a group, refused by the list
    check, rather than a leaf. `VIEW_KEPT_KEYS` keeps `parts` so its presence
    survives the parse.

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

    seen: set[str] = set()
    stack = [(doc, 0)]
    while stack:
        node, depth = stack.pop()
        if depth > MAX_VIEW_DEPTH:
            raise ValueError(
                f"view {view_id!r} nests parts deeper than {MAX_VIEW_DEPTH}")
        where = f"view {view_id!r}"
        # THE TWO STRINGS THAT REACH THE DOM COME FIRST, and the order is about
        # the MESSAGE rather than about safety — every clause below refuses the
        # same push. A node that is hostile AND has no key is hostile, and being
        # told about a missing key would send its author looking at the wrong
        # thing; it would also let the day a build writes a keyed hostile node
        # go unnoticed here.
        name = node.get("name")
        if name is not None:
            _check_part_name(name, f"part name in {where}")
        if node.get("color") is not None:
            _check_color(node["color"], f"part {name!r} in {where}")
        # Read before the key is judged, because it is what says whether this
        # node is a leaf at all — the same question the descent below asks, and
        # the one the vendored viewer asks as `"parts" in shape`. PRESENCE, not
        # value: see the docstring on why `null` may not be read as "leaf".
        has_parts = "parts" in node
        parts = node.get("parts")
        key = node.get("key")
        if key is not None:
            _check_part_name(key, f"part key in {where}")
            if key not in catalogue:
                raise ValueError(
                    f"{where} shows a part keyed {key!r}, which the `parts` "
                    f"catalogue does not declare")
            seen.add(key)
        elif not has_parts:
            raise ValueError(
                f"{where} has a leaf with no `key`: a node with no `parts` "
                f"under it is one part, and every part names the `parts` "
                f"catalogue record it is of")
        if not has_parts:
            continue
        if not isinstance(parts, list):
            raise ValueError(f"{where} has a non-list `parts`")
        for part in parts:
            if not isinstance(part, dict):
                raise ValueError(f"{where} has a part that is not an object")
            stack.append((part, depth + 1))
    return seen


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
    that spelling holds the file AND its compressed copy at once — in each of
    the builds publishing at the same time (`jobs.MAX_CONCURRENT_BUILDS`), of
    files that are 2 MB each on a real model and far bigger on a broken one.
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


def _view_parts(view: dict, view_id: str, catalogue: dict) -> list:
    """`views[].parts`: which parts this view shows, by catalogue key.

    Every key has to be one the catalogue declares; membership is stricter than
    `_check_part_name`, since every catalogue key already passed it.

    Counted against the size of the catalogue before the walk, so a list of a
    hundred thousand repeats is refused before any of it is walked; the
    duplicate refusal is what makes that count exact.

    Called before the view file is opened, because what follows in `build_meta`
    is a full parse and gzip of it; the comparison with the file is the separate
    `_match_selection`.
    """
    refs = view.get("parts")
    if not isinstance(refs, list):
        raise ValueError(
            f"view {view_id!r} must list the catalogue keys it shows in "
            f"`parts`, as an array of strings")
    if len(refs) > len(catalogue):
        raise ValueError(
            f"view {view_id!r} names {len(refs)} parts, more than the "
            f"{len(catalogue)} the catalogue declares")
    seen: set[str] = set()
    for ref in refs:
        if not isinstance(ref, str):
            raise ValueError(
                f"view {view_id!r} names {ref!r} as a part, which is not a "
                f"catalogue key")
        if ref not in catalogue:
            raise ValueError(
                f"view {view_id!r} shows {ref!r}, which the `parts` catalogue "
                f"does not declare")
        if ref in seen:
            raise ValueError(
                f"view {view_id!r} names {ref!r} twice; the list says WHICH "
                f"parts a view shows, not how many times each appears in it")
        seen.add(ref)
    return list(refs)


def _match_selection(declared: list, shown: set, view_id: str) -> None:
    """`views[].parts` has to be exactly the keys its view file names.

    `_view_parts` checks the list against the catalogue and `check_view_file`
    checks the file against it; this holds the two together, so a tab cannot
    promise parts it does not show.

    Equality, not containment: `cadbuild.views.export_views` writes the field as
    `list(dict.fromkeys(node["key"] for node in nodes))`, so a disagreement in
    either direction is a document that lies about itself. Order is not
    compared: the list keeps the author's order and the stack walk that produced
    `shown` has none.
    """
    missing = [key for key in declared if key not in shown]
    extra = sorted(shown.difference(declared))
    if not missing and not extra:
        return
    problems = []
    if missing:
        problems.append(
            f"declares {', '.join(repr(key) for key in missing)}, which its "
            f"view file never shows")
    if extra:
        problems.append(
            f"shows {', '.join(repr(key) for key in extra)}, which it does not "
            f"declare")
    raise ValueError(
        f"view {view_id!r} " + " and ".join(problems) + "; `parts` has to be "
        f"exactly the catalogue keys the view file names")


def build_meta(pid: str, commit: str, raw: dict, staging: Path,
               files: dict, published: str, dev: bool = False,
               job: str = None, message: str = None) -> dict:
    """Validate the uploaded meta.json and normalize it for the page.

    What the build is OF decides the body: a model's `views` and `parts`
    (`_model_body`), with the `documents` its project.json lists when it lists
    any, or — a tree with no model — `kind` and `documents` alone. The fields
    around the body are the same for both.
    """
    if raw.get("kind") == DOCUMENTS_KIND:
        body = {"kind": DOCUMENTS_KIND,
                "documents": _documents(raw, staging, files)}
    else:
        body = _model_body(raw, staging, files)
        # Only when the hub put them there (`docsbuild.add_documents`): a
        # model's build without a list writes the document it always wrote.
        if "documents" in raw:
            body["documents"] = _documents(raw, staging, files)

    # Both are shown verbatim on the index and the build page. The pages render
    # them with textContent, but a push is not allowed to smuggle control
    # characters or a page-wide banner through them either.
    project = _plain_text(str(raw.get("project") or pid), "project")
    title = _plain_text(str(raw.get("title") or project), "title")

    # `built` is the model's own timestamp, which the build picker and `latest`
    # order by. Optional: without it the moment the hub accepted the push is
    # used. Not parsed as a date (`_built_key` tolerates an unparseable one) but
    # displayed like `project` and `title`, so it gets their validation.
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
        # REBUILT, not passed through. The body was assembled field by field
        # out of the upload, so a key of the pushed document that nothing here
        # reads cannot reach the browser by riding along — which is what makes
        # "an unvalidated field is a field that does not exist here" true
        # rather than aspirational.
        **body,
    }
    # The slot is not addressed by a revision, so no log is stored under its
    # name; `job` records the job that produced it so `hammerola log dev` can
    # find the log. Added only for the slot so a revision's meta.json does not
    # carry it, and None-able because a slot can be written without one.
    if dev:
        meta["job"] = job
    # The one field that comes from the push rather than the build: the
    # subject of the commit. Written only when present, like `job`; the picker
    # reads it back (`Store.builds_of`). Cleaned on the way in
    # (`prereceive.revision_message`).
    if message:
        meta["message"] = message
    return meta


def _documents(raw: dict, staging: Path, files: dict) -> list:
    """`documents`: the files a build publishes to be read, one tab each.

    Each entry is rebuilt: `file` is held to the rule every pointer is
    (`_check_declared_file`, as a path: a document keeps its place in the
    tree), `type` has to be one the file's extension gives it, `id` is
    derived from the path (`document_id`) rather than read, and `bytes` is
    measured off the file rather than read from the upload. `name` falls back
    to the path. `hidden` is carried only when true: the page lists no row for
    such a document and still opens it by its id. A KiCad schematic or board
    also carries `kicad`, the files published with it (`_kicad`), and its
    `bytes` are the sum of all of them; a `FILE_TYPE` document carries no
    `kicad`, since what the page does not draw it does not draw from a design.
    A `FILE_TYPE` DXF may carry `preview`, the picture drawn of it
    (`dxf_preview`), and its `bytes` stay the DXF's own: they are what
    Download hands over.
    """
    documents = raw.get("documents")
    if not isinstance(documents, list) or not documents:
        raise ValueError(
            "`documents` in meta.json must list at least one document")
    _check_map_size(documents, "documents", files)

    read = []
    seen: dict[str, str] = {}
    for entry in documents:
        if not isinstance(entry, dict):
            raise ValueError("every entry of `documents` must be an object")
        name = entry.get("file")
        _check_declared_file(name, files, f"document {name!r}", path=True)
        # Two types are honest for one extension and no more: the one the page
        # draws it as, and `FILE_TYPE`, which any document may be published as
        # (`"download": true` in project.json, resolved by `docsbuild._copy`).
        # What may not happen is a document claiming a drawing its extension
        # does not give — a `.dxf` that says `markdown` would reach the
        # markdown renderer, and a `.txt` that says `gerbers` the zip reader.
        allowed = tuple(dict.fromkeys((published_type(name), FILE_TYPE)))
        shown_as = entry.get("type")
        if shown_as not in allowed:
            raise ValueError(
                f"document {name!r} says it is {shown_as!r}, and its "
                f"extension makes it "
                f"{' or '.join(repr(one) for one in allowed)}")
        doc_id = document_id(name)
        if doc_id in seen:
            raise ValueError(
                f"documents {seen[doc_id]!r} and {name!r} get the same id "
                f"{doc_id!r}, so one address would name both")
        seen[doc_id] = name
        one = {
            "id": doc_id,
            "name": _plain_text(str(entry.get("name") or name),
                                "document name"),
            "type": shown_as,
            "file": name,
            "bytes": (staging / name).stat().st_size,
        }
        hidden = entry.get("hidden", False)
        if not isinstance(hidden, bool):
            raise ValueError(
                f"document {name!r} has a `hidden` that is not true or false")
        if hidden:
            one["hidden"] = True
        # Held to the rule every pointer is, and to the one path a DXF's
        # picture is published at. Any other entry has no picture, and a
        # `preview` on it is dropped like every key not read here.
        expected = dxf_preview(name) if shown_as == FILE_TYPE else None
        if expected is not None and "preview" in entry:
            preview = entry["preview"]
            _check_declared_file(preview, files, f"document {name!r}'s preview",
                                 path=True)
            if preview != expected:
                raise ValueError(
                    f"document {name!r} names the preview {preview!r}, and "
                    f"its preview is {expected!r}")
            one["preview"] = preview
        if shown_as in (SCHEMATIC_TYPE, BOARD_TYPE):
            design = _kicad(entry.get("kicad"), name, shown_as, files)
            # The schematic itself is counted above; its sheets and the
            # project are the rest of what is published for it.
            besides = design.get("schematics", [name])[1:]
            if design["project"] is not None:
                besides.append(design["project"])
            one["bytes"] += sum((staging / part).stat().st_size
                                for part in besides)
            one["kicad"] = design
        read.append(one)
    return read


def _kicad(raw, name: str, shown_as: str, files: dict) -> dict:
    """`kicad` of the schematic or the board at `name`, rebuilt.

    A schematic's is `{"schematics": [name, ...its sheets], "project": path or
    None}`, a board's `{"project": path or None}`. Every file is held to the
    rule every pointer is; the first schematic is `name` itself, there are at
    most `MAX_KICAD_SHEETS`, each once, and the project is the one with
    `name`'s path minus its extension, as `docsbuild` found it.
    """
    where = f"document {name!r}"
    if not isinstance(raw, dict):
        raise ValueError(f"{where} is a KiCad {shown_as} with no `kicad` object")
    design = {}
    if shown_as == SCHEMATIC_TYPE:
        schematics = raw.get("schematics")
        if (not isinstance(schematics, list) or not schematics
                or len(schematics) > MAX_KICAD_SHEETS):
            raise ValueError(
                f"{where} has to list between 1 and {MAX_KICAD_SHEETS} "
                f"schematics, itself first")
        for sheet in schematics:
            _check_declared_file(sheet, files,
                                 f"{where}'s schematic {sheet!r}", path=True)
            if not sheet.endswith(KICAD_SCHEMATIC):
                raise ValueError(f"{where} lists {sheet!r} as a schematic")
        if schematics[0] != name:
            raise ValueError(
                f"{where} lists {schematics[0]!r} first, and has to list "
                f"itself first")
        if len(set(schematics)) != len(schematics):
            raise ValueError(f"{where} lists a schematic twice")
        design["schematics"] = list(schematics)
    project = raw.get("project")
    if project is not None:
        _check_declared_file(project, files, f"{where}'s project", path=True)
        expected = name[:-len(Path(name).suffix)] + KICAD_PROJECT
        if project != expected:
            raise ValueError(
                f"{where} names the project {project!r}, and its project is "
                f"{expected!r}")
    design["project"] = project
    return design


def _model_body(raw: dict, staging: Path, files: dict) -> dict:
    """`views` and `parts`: what a build of a model publishes.

    The catalogue is read first: every view names the keys it shows and every
    leaf of every view file carries one, so `parts` has to exist before any of
    them can be checked against it.

    `bytes` and `gzip` are measured server-side rather than trusted from the
    upload: they are shown in the view picker as what clicking costs.
    """
    catalogue = _catalogue(raw, files)

    views = raw.get("views")
    if not isinstance(views, list) or not views:
        raise ValueError("meta.json must list at least one view in `views`")
    # COUNTED BEFORE THE WALK, and more urgently than the catalogue is: an entry
    # here costs a parse and a gzip of a whole view file rather than a dict
    # lookup. Same bound and same derivation — every entry has to name a file
    # this build published, and an honest build writes one view file per view.
    _check_map_size(views, "views", files)

    rendered = []
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

        # The same check every other file pointer gets.
        name = view.get("file")
        _check_declared_file(name, files, f"view {view_id!r}")

        # Before the file is touched: this is a lookup per key, while the next
        # two lines parse and gzip the whole view file.
        selected = _view_parts(view, view_id, catalogue)

        # The bytes of this file are handed to `viewer.render()` verbatim, so
        # what is inside a view reaches the DOM too; every leaf names a
        # catalogue key, checked against the catalogue.
        shown = check_view_file(staging / name, view_id, catalogue)
        # The half that CANNOT be asked before the walk, because it is about
        # what the walk found: the summary above and the file have to name the
        # same parts, or the summary is a promise nothing keeps.
        _match_selection(selected, shown, view_id)

        # Measured SERVER-SIDE, from the file that was actually unpacked.
        size, compressed = measure_view(staging / name)
        entry = {
            "id": view_id,
            "name": _plain_text(str(view.get("name") or view_id), "view name"),
            "file": name,
            "parts": selected,
            "bytes": size,
            "gzip": compressed,
        }
        # The whole-view mesh and the whole-view pictures: `assembled.stl`,
        # `assembled_preview.png` and `assembled_card.png`, and the same three
        # for `print` where the project has that view. OPTIONAL because most
        # views have none of them — the build hangs them on the two ids it
        # renders — and read with an explicit `is None` like every other
        # optional field here.
        overview = view.get("overview")
        if overview is not None:
            _check_declared_file(
                overview, files, f"the mesh of view {view_id!r}")
            entry["overview"] = overview
        preview = view.get("preview")
        if preview is not None:
            _check_declared_file(
                preview, files, f"the picture of view {view_id!r}")
            entry["preview"] = preview
        # The same picture without the title band and the footer, for the front
        # page's card, which fits it rather than cropping
        # (`ui/src/HammerolaEntry.jsx`). Optional: builds made before the build
        # side wrote it have none, and their cards fall back to `preview`.
        card = view.get("card")
        if card is not None:
            _check_declared_file(
                card, files, f"the card picture of view {view_id!r}")
            entry["card"] = card
        rendered.append(entry)

    return {"views": rendered, "parts": catalogue}


def builds_json(pid: str, metas: list[dict], dev: bool = False,
                latest: str | None = None, fallback: dict | None = None) -> dict:
    """The build picker for one project.

    `builds` is the project's HISTORY and therefore a list of commits, newest
    first: the local slot is deliberately not one of them (SPEC 7.6), because it
    is one directory that gets overwritten and a list of one thing that keeps
    changing is not a history.

    The two moving names ride alongside instead: `has_dev` says the local slot
    is occupied, `latest` names the commit it currently resolves to. Either can
    be absent, and the picker must then not offer it, or it offers a link to a
    404. A commit fills the slot with itself, so `has_dev` is true of every
    project that has ever committed. `dev` resolves to itself, which is why it is
    a flag and `latest` is a commit id.

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
        "builds": [_picker_entry(m) for m in metas],
    }


def _picker_entry(meta: dict) -> dict:
    """One row of the picker: which revision, when, and what it says it is.

    A PROJECTION AND NOT A COPY, which is why it is spelled out rather than
    filtered: a build's meta.json is several hundred kilobytes of catalogue and
    view records, and this file is re-read on every load and every revision
    switch of the owner's page. Only what a row draws is carried.

    `message` is present only when the revision has one.
    """
    entry = {"commit": meta["commit"], "built": meta["built"]}
    message = meta.get("message")
    if message:
        entry["message"] = message
    return entry


# The three words a project card may say about its draft. Here rather than in
# src/jobs.py because jobs imports store, which imports this module. The mapping
# takes a plain string, never a job record; a test importing both modules holds
# that every job state lands on one of these words.
CARD_IDLE = "idle"
CARD_BUILDING = "building"
CARD_FAILED = "failed"


def card_status(state: str | None) -> str:
    """What a project's card says about its draft, given that job's state.

    `idle` for everything that is not one of the two answers worth a chip, and
    that deliberately swallows both shapes of "there is nothing to say": no
    pointer at all (`None`), and a pointer at a job the registry no longer has.
    Neither is a failure of the PROJECT, and the front page is about projects.
    """
    # The job registry's own words, spelled out rather than imported for the
    # reason above. That two of them are spelled like card words is a
    # coincidence of vocabulary and not a shortcut: `queued` maps onto
    # `building` because "waiting for a worker" is not a distinction the front
    # page exists to draw.
    if state in ("queued", "building"):
        return CARD_BUILDING
    if state == "failed":
        return CARD_FAILED
    return CARD_IDLE


def index_card(meta: dict, *, dev: bool, first_built: str) -> dict:
    """One project's card in the index payload (`/index.json`, EDIT_TOKEN).

    Built from its newest commit build, plus two project-level facts the caller
    (`Store._refresh_index`) passes in.

    `dev` is whether the local slot holds sources no commit has published
    (`Store._uncommitted_in_slot`, by digest), not whether the slot is occupied:
    a commit fills the slot with itself, so "occupied" would put the chip on
    every card. `has_dev` in `builds_json` asks the other question on purpose:
    the picker needs it to decide whether a `/dev/` link resolves.

    The card describes the newest commit and never the slot (SPEC 7.6).

    `first_built` is the oldest build still here: the hub never learns when a
    project was created (`hammerola create` runs locally), and with no retention
    (SPEC 5.3) the oldest build stays the oldest. The page labels it as that.

    A build with no model has no views and no catalogue: its card counts the
    documents and their bytes. A model's card is the model's whether or not
    it lists documents, and its `documents` is None.
    """
    documents = (meta["documents"] if meta.get("kind") == DOCUMENTS_KIND
                 else None)
    views = meta["views"] if documents is None else []
    records = meta["parts"] if documents is None else {}
    size = (sum(v["gzip"] for v in views) if documents is None
            else sum(d["bytes"] for d in documents))
    # The picture is the first one any view of this build declares. It is not a
    # promise about what the card's link opens: pictures hang only on the view
    # ids the build knows while view order is the model's, and the link opens
    # whichever of `latest` and `dev` the reader was last on (SPEC 9). Not looked
    # up by view id, because the serving side does not import the build half
    # (`cadbuild.artifacts.ASSEMBLED_VIEW_ID`; see docs/repo-map.md). `None` is a
    # normal answer: an image with no rendering stack ships no PNGs.
    preview = next((view["preview"] for view in views
                    if view.get("preview") is not None), None)
    # The same pick for the card picture (the sheet without its title band and
    # footer). `None` also means a build made before the build side wrote it; the
    # front page falls back to `preview` (`ui/src/HammerolaEntry.jsx`).
    card = next((view["card"] for view in views
                 if view.get("card") is not None), None)
    return {
        "pid": meta["pid"],
        "project": meta["project"],
        "title": meta["title"],
        "commit": meta["commit"],
        "built": meta["built"],
        "first_built": first_built,
        "dev": bool(dev),
        # Answered by the route: `_serve_index_json` in src/app.py fills it per
        # request from the project's pointer and the job registry
        # (`card_status`). Declared here so the field the browser reads is one
        # this function writes (tests/test_ui_source.py).
        "status": None,
        # How many parts get printed: catalogue records of kind printable, so
        # bought screws and scenery are not counted.
        "printables": sum(1 for record in records.values()
                          if record["kind"] == KIND_PRINTABLE),
        "views": len(views),
        "documents": None if documents is None else len(documents),
        "mb": f"{size / 1e6:.1f}",
        "preview": preview,
        "card": card,
    }
