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
# that ALSO refused a leading dot, and `hammerola/artifacts.py` approximated it
# a third time. Three copies, no two alike, and the disagreement published a
# build that could never be opened. `hammerola/buildnames.py` is the single place that
# answers it now, and `tests/test_buildnames.py` asserts the three sides hold
# the same OBJECT rather than a copy of it — which is what fails on the day
# somebody inlines one again.
# `first_nonprintable` travels with it because `_plain_text` below asks the same
# question of every displayed field, and the two must not drift apart on what
# "printable" means.
from hammerola.buildnames import first_nonprintable, unservable_reason

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"

# The key a part files an exported file under — `stl`, `step`, `3mf` — which
# ends up as a download button's caption. Kept to the same shape as a file name
# so it can never carry markup, a quote or a control character: the pages build
# their DOM with textContent, and this is the second line of that defence. It
# held the label of the flat `downloads` map before issue #75 moved those files
# under the part they belong to; the caption argument moved with them unchanged.
SAFE_LABEL = re.compile(r"\A[A-Za-z0-9._-]{1,32}\Z")

# Free-text fields shown on the index and the build page. Long enough for a real
# title, short enough that one push cannot push every other card off the screen.
MAX_TEXT = 200

# How many parts one build's catalogue may carry. Not a tidiness rule: every
# record is legal at its own ceilings — a 200-character key, a 200-character
# note — so 100 000 of them make a 20 MB meta.json that every visitor of that
# build page downloads, under a year of `immutable`, from a push that can never
# be taken back. It also bounds the work the validation loop below does per
# push, which is the other half of accepting a document whose size the sender
# chooses.
#
# IT WAS CALLED `MAX_NOTES` AND COUNTED THE PARTS THAT CARRIED A NOTE, back
# when notes were a flat map of their own. Issue #75 moved the note inside the
# record it is about, so there is no count of notes left to take — and the
# records WITHOUT one are exactly what a note-shaped ceiling could not see: a
# catalogue of a hundred thousand bought screws costs the same megabytes and
# carries no note at all. Renamed on both sides of the wire at once
# (`cadbuild.hubspec.MAX_PARTS`), because a ceiling whose name says notes and
# whose job is the catalogue is a number nobody can reason about; the two are
# held equal by tests/cadbuild/test_naming.py.
#
# WHAT IT DOES NOT BOUND is the number of FILES the catalogue points at — that
# is `_spend_file_budget` below, and it is a different bound from a different
# source.
MAX_PARTS = 200

# What a catalogue entry may say a part IS. A TRANSCRIPTION of
# `cadbuild.parts.KINDS` and deliberately not an import: nothing on the serving
# side may reach into the build half, which runs inside the build process. The
# two lists are held equal by tests/cadbuild/test_naming.py, from the one side
# allowed to see both.
#
# AN UNKNOWN KIND IS REFUSED rather than carried through. The browser draws a
# record BY its kind — a printable gets download buttons, a bought part gets
# none — so a kind nothing recognises is a part nobody can draw, and "render
# what you know and drop the rest" is a way for a push to choose which of its
# parts a reader never sees.
KIND_PRINTABLE = "printable"
PART_KINDS = (KIND_PRINTABLE, "hardware", "mock")

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
#
# `key` IS ON THIS LIST BECAUSE OF WHAT DROPPING IT COSTS. `export_views` stamps
# the catalogue key on every leaf (issue #75) and the browser looks the record
# up by it, so it is a string that travels from a push into the DOM — and while
# it was not on this list it was the one such string NOTHING checked: the parser
# threw it away before the walk below could see it. A key that is not on this
# list is a key that is not validated, which is the whole reason the list is
# written out rather than being "whatever the walk happens to read".
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
    """Every file this document points at, wherever it is pointed at from.

    FIVE CALLERS NOW, and they are no longer four flat maps: a view's `file`,
    its `overview` mesh and its `preview` picture, and — on a catalogue
    record — each of its exported `files` and its own `preview`. One helper for
    all of them because they make the same claim about a name — "this build
    wrote a file called that, and the hub will hand it back" — and differ only
    in what OWNS the name, which is now stated by where the pointer sits
    instead of being parsed out of a key (issue #75). Each of the questions
    below is a way the push is accepted and then serves something other than
    what was measured here, so they move together or not at all. `views` was
    the last of the old four to arrive and it arrived through a bug: it kept an
    inline check of its own that asked membership, `/` and `GENERATED_FILES`
    and neither of the two clauses the shared rule had grown, so the exact
    defect issue #53 exists to kill was still live on the one map without which
    a build page is empty.
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
    """How many entries one file-declaring collection may carry, counted first.

    ONE CALLER LEFT, AND IT IS A LIST: `views`. The three flat maps that shared
    this — `downloads`, `overview`, `previews` — are gone with issue #75, and
    what replaced them is bounded differently: a catalogue is counted against
    `MAX_PARTS` and the files its records point at are counted against
    `_spend_file_budget`. The argument is still any sized collection rather than
    a dict — nothing here looks inside it, and "entries" is the right word for a
    row of either. `views` was always the most expensive of the four by orders
    of magnitude, which is why it may least of all go uncounted: every entry
    costs a full parse of its view file (`check_view_file`) and a full gzip of
    it (`measure_view`), measured at ~18 ms on a 0.9 MB view, and N entries may
    point at ONE file — `seen` forbids a duplicate view id, not a duplicate file
    name. A hundred thousand of them is hours of CPU inside `_finish_staging`,
    in a build worker thread, with two of those in the whole process.

    Counted FIRST, before the loop, exactly as the catalogue is counted below —
    the ORDER is what the two share and it is the whole of what they share:
    refusing after walking the document is paying for precisely what the ceiling
    exists to refuse to pay for. What it stops is the shape a per-entry rule
    cannot see: every entry legal, in enormous numbers.

    IT IS NOT PARITY WITH `MAX_PARTS` AND MUST NOT BE READ AS ONE. That number
    is 200; this ceiling is `len(files)`, and on the build path `files` is
    bounded by `limits.output_files` — 4096. So a model that writes 4096 tiny
    files may legally declare on the order of four thousand views, each with a
    name running to MAX_TEXT and a file name with no length ceiling at all
    (`buildnames.unservable_reason` has none, deliberately). That is a
    `meta.json` of a few megabytes, served under a year of `immutable` to every
    visitor of that build — where the catalogue ceiling permits tens of
    kilobytes. Different orders of magnitude, so "for the same reason" is
    exactly what must not be said about the pair: what they share is the ORDER
    of the count, and nothing else.

    STILL WORTH HAVING, AND ACCEPTED RATHER THAN TIGHTENED. What it buys is the
    shape check it was added for: "unbounded" becomes "bounded by what the build
    actually wrote", so no list can be enormous without the FILES being enormous
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
    really produced what it describes cannot declare more views than it
    published files — `export_views` writes one `<vid>.json` per view, and every
    one of those names is on that list. Beyond it, entries are repeats of a name
    already declared, which is the millions-pointing-at-one-file shape and
    nothing an honest build does.

    A constant would be worse here, not tidier. MAX_PARTS is a count of
    CATALOGUE RECORDS, and a view is not one of those — a project may draw more
    tabs than it has parts, or one tab of two hundred. `files` is already
    capped — by `limits.output_files`, on the build path — so this inherits a
    ceiling instead of inventing a second one that can drift from it. ONE
    SOURCE, NOT TWO, and MAX_MEMBERS is not the second: there is no archive path
    here at all.
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


def _spend_file_budget(left: int, count: int, where: str, files: dict) -> int:
    """How many file pointers the CATALOGUE may hold in total, spent as counted.

    THE SAME BOUND `_check_map_size` APPLIES TO A LIST, applied to a document
    where the pointers are spread over records instead of sitting in one map —
    which is precisely what stops the bound getting weaker as the shape changes.
    Per record it would: a record may legally point at `len(files)` names, so
    MAX_PARTS records could point at 200 × 4096 of them, and that is a fifty-
    megabyte `meta.json` served under a year of `immutable` — an order worse
    than the three flat maps this replaced, from a change that was supposed to
    move a bound rather than loosen it. One budget for the whole catalogue keeps
    the old total exactly.

    IT IS DERIVED AND IT IS NOT TIGHT AGAINST AN HONEST BUILD, which is what
    makes it usable: every pointer here has to name a file this build published,
    a printable owns its own three exports plus its own picture, and no two
    records own one file — so an honest catalogue spends strictly less than it
    is given (`meta.json` and `metrics.json` are published and pointed at by
    nobody). Beyond the budget, pointers are repeats of a name already spoken
    for, which is nothing a build does.

    The views' own three pointers are NOT on this budget: they are bounded as
    ENTRIES by `_check_map_size`, at three pointers per entry, which is the same
    order the old document allowed across its three maps.
    """
    left -= count
    if left < 0:
        raise ValueError(
            f"the catalogue points at more files than the {len(files)} this "
            f"build published, and {where} is where it ran past them; every "
            f"one of them has to name a file the build shipped")
    return left


def _check_note(value, key: str) -> None:
    """The AUTHOR's note on a part: text written in model.py, shown to a reader.

    It used to be an entry of a flat `notes` map keyed by part name; issue #75
    moved it inside the record it is about, which is the only change — the rules
    are the ones it always had, and they are here rather than inline so the
    record reader stays readable.

    Angle brackets are banned for the BOUNDARY rather than for any one
    renderer: this text arrives from a push, i.e. from anybody who can land a
    commit in a model repository, and where the browser half ends up putting it
    is a decision made later, on a page that is permanent, immutable and shares
    an origin with every other project on the host. Text that cannot open an
    element cannot become markup whatever renders it — the same argument that
    holds for a part name. NOT for `title` and `project`, and that is the code
    rather than an omission here: those two go through `_plain_text` alone, so a
    bracket in a title is published. Read this sentence before "fixing" either
    side into agreement.

    AN EMPTY STRING IS REFUSED RATHER THAN NORMALIZED AWAY, and refusing is the
    decision. `_catalogue` below states the rule this closes — absent rather
    than empty on the way out, so a reader never has two ways of asking one
    question — and this field was where it was first kept honestly: `""` passed
    every rule here and was emitted as `"note": ""`, a second spelling of "no
    note" for every reader downstream. `files` is refused the same way now, and
    that is this argument applied where it used to be contradicted — an empty
    map was DROPPED there, in silence. Dropping it silently
    would be the hub editing a document it did not write; refusing teaches the
    one push that can reach this, which is a hand-made one. An honest client
    never lands here — `cadbuild.build` writes the key under `if
    record["note"]:` — so the strictness costs nobody anything.

    PADDING IS REFUSED FOR THE SAME REASON, and the fact that decides it was
    stated in neither half until now: `cadbuild.parts._check_note` NORMALIZES a
    note — it strips it, refuses what is left over when that is empty, and
    publishes the STRIPPED string — while nothing here normalizes anything. So
    the boundary between the two runs through "refuse what arrives padded", not
    through "tolerate it". A paragraph here used to claim the opposite, that
    `" "` is a note the build really does publish and refusing it would turn a
    legal build into a 422; both halves of that were false, and the hole it
    guarded was real. `"   "` published, which is a THIRD spelling of "nothing
    to say" beside an absent key and the `""` refused above; and one authored
    text published as two different documents — ` M3x8 ` from a hand-made push,
    `M3x8` from the build — so a byte comparison of two revisions reports a
    change nobody made (issue #10).

    WHAT THE RULE BUYS is that this side becomes the exact COMPLEMENT of the
    other: everything `cadbuild._check_note` can produce (stripped, non-empty)
    passes here, and everything it cannot produce is refused. That is the shape
    `kind` already has, where the two lists are asserted equal outright
    (tests/cadbuild/test_naming.py); stripping it here instead would be a second
    and opposite answer to the question the paragraph above answers, in the same
    function. Nothing honest is turned away, and for the same reason as above:
    `cadbuild.build` writes the key under `if record["note"]:`, and the value it
    writes came back stripped from the gate.
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
    """`parts`: every part of this build, filed under the key that IS its name.

    THE KEY IS THE IDENTITY (issue #75), and this map is where it is declared.
    It travels from the model's own parts() through the view files and this
    document into the browser unchanged, so nothing downstream reconstructs
    which part is which by matching a shape or by splitting a file name — which
    is what the four flat maps this replaces made every reader do, and what the
    viewer got wrong on a part with a dot in its name.

    REQUIRED AND NON-EMPTY, exactly like `views`: a build whose catalogue holds
    nothing printable is refused by the build's own gate, so a document with no
    catalogue is not one this hub can have written — and `_usable_meta` in
    store.py refuses the same shape from the other end, which is the pairing
    that has to stay true. Accepting an empty one here would publish a build the
    index then silently declines to list.

    EVERY OPTIONAL FIELD BELOW IS READ WITH AN EXPLICIT `is None`, never
    `record.get(field) or {}`. That spelling turns a falsy non-object — `[]`,
    `""`, `0` — into "nothing here" and publishes a push that described
    something else, in silence; it is the rule for every optional field on this
    document, and it outlived `_stem_map`, the helper whose docstring used to
    carry it. `downloads` was the last place it was not followed — it read
    `or {}` until the review of issue #53, so `downloads: 0` published a build
    with no download buttons and told nobody.

    ABSENT RATHER THAN EMPTY, AND EVERY FIELD IS HELD TO IT THE SAME WAY: by
    refusing the empty spelling, never by dropping it. `files: {}` is a 422
    exactly as `note: ""` is, and for the reason `_check_note` argues at
    length — the hub does not get to edit a document it did not write, and only
    a hand-made push can carry either value, since `cadbuild.build` writes each
    of those keys under a test that it has something to put there. `files` was
    the exception until the review of this change: `if exported:` dropped an
    empty map in SILENCE, in this same walk, a dozen lines from the field that
    refuses the identical claim — so one document's one rule had two opposite
    answers depending on which key it was asked about, and the drop was the very
    edit the refusal next door exists to avoid. `preview` needs no clause of its
    own and is not a third case: `""` is not a file this build declared, so
    `_check_declared_file` has already refused it.

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

    A PRINTABLE CARRIES FILES, AND THE CATALOGUE CARRIES A PRINTABLE. Those are
    the two claims this side makes about what a BUILD can produce, and both
    arrived late because their MIRROR IMAGES were already here: a non-printable
    that declares files is a 422 four lines from the printable that declared
    none and was accepted, and "the catalogue is non-empty" stood next to
    "something in it is printed" without it. Both are checked on the build side
    and can be read there: `cadbuild.printables.export_printables` writes STEP,
    STL and 3MF for EVERY printable and `cadbuild.build` files them under the
    record, so a printable with no `files` is a record no build wrote; and
    `cadbuild.parts.read_catalogue` refuses a catalogue whose every entry is
    hardware or a mock, in as many words ("the catalogue has nothing to
    print").

    WHAT IS DELIBERATELY NOT ASKED HERE, so that nobody completes the symmetry
    later: the build ALSO guarantees a view called `assembled` and an
    `overview` on it (`cadbuild.views`), and neither is required by this side.
    `assembled` is an id the BUILD half invented; the serving half knows
    nothing about a view beyond its `id`, its `file` and the keys it selects,
    and demanding a particular id would write the build half's vocabulary into
    the receiving side — a coupling that does not exist today and costs more
    than the hole it closes. The two rules above need no such vocabulary:
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
            # THE OTHER HALF OF THE CLAUSE BELOW, and it was missing while that
            # clause stood four lines away: a build exports STEP, STL and 3MF
            # for every printable it finds, so "printable" and "has files" are
            # one statement made twice, and a record making only half of it is
            # one no build wrote. Refused for the reason the other half is: the
            # browser draws a record BY its kind, so a printable with nothing to
            # download is a row promising buttons that are not there.
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
            # REFUSED, NOT DROPPED — the docstring above has the argument, and
            # it is the one `_check_note` makes about `""` on the field this
            # same loop reads two blocks down.
            if not declared:
                raise ValueError(
                    f"{where} declares an empty `files`; a record with nothing "
                    f"exported leaves the key out rather than writing {{}}, "
                    f"which the hub would otherwise have to edit away")
            budget = _spend_file_budget(
                budget, len(declared), f"the files of {where}", files)
            exported = {}
            for extension, name in declared.items():
                # The extension is what the download button is captioned with,
                # so it is whitelisted rather than escaped — the rule the old
                # `downloads` label was held to, on the field that inherited its
                # job.
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

    # THE MIRROR OF `read_catalogue` ON THE BUILD SIDE, which refuses a
    # catalogue whose every entry is hardware or a mock. A model project exists
    # to produce a part, so a document describing nothing but bought screws and
    # scenery was not written by a build of one — and the front page would list
    # it as a build with nothing in it to print. Checked AFTER the walk and not
    # before it, because `kind` is what answers it and the walk is what
    # validates `kind`; a pre-pass would be a second reading of the same field,
    # free to disagree with this one about what counts.
    if not any(entry["kind"] == KIND_PRINTABLE for entry in read.values()):
        raise ValueError(
            f"the catalogue has nothing to print: not one of its "
            f"{len(read)} entries is {KIND_PRINTABLE!r}, and a build of a "
            f"model produces at least one part")
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

    and `name`/`color` come straight out of this file. Patching the library is not
    an option — it is vendored, 3.6 MB, and replaced wholesale by its next
    release — so the check has to happen on the way in, once, rather than on every
    render. The CSP is a backstop for what this misses, not a substitute for it:
    it stops an injected <script> from running but says nothing about a `<form>`
    posting elsewhere or an `<a>` covering the page, and a build URL is permanent,
    immutable and shares an origin with every other project on the host.

    `key` IS THE THIRD STRING NOW, and it is why this takes a catalogue.
    `export_views` stamps the catalogue key on every leaf (issue #75) and the
    browser looks the record up by it, so it reaches the page exactly as `name`
    does and is held to the same rule. It is also the one field here that can be
    checked against something rather than only for shape: a key naming a record
    the catalogue does not declare is a part the reader can find nothing about,
    and refusing it is what makes "this view shows that part" a fact instead of
    two strings that happen to be equal.

    WHAT THE CROSS-CHECK IS NOT is a claim that the right geometry is under the
    right key. Which solid was stamped with which key is decided inside the
    build process, which runs the model's own code — so this can only hold the
    document together, never hold it to the truth. Referential integrity is the
    whole of what is on offer here, and it is worth having on its own.

    A LEAF HAS TO CARRY A `key`, AND THE KEYS SEEN ARE RETURNED. The two halves
    are one repair, and what they repair is the only promise `views[].parts` in
    meta.json makes: that a reader learns what is in a tab WITHOUT fetching a
    multi-megabyte view file. Until the two documents were compared, nothing
    signed that promise — a view file of unkeyed leaves published beside a list
    naming three parts, `hammerola status` and the build page repeated the
    three, and the only thing that could contradict them was the very download
    the field exists to avoid. Into an immutable directory, under a year of
    cache, undoable only by deleting the project.

    THE LEAF/GROUP DISTINCTION IS `parts`, and reading it is a transcription
    rather than the hub deciding the shape of a document it did not write. This
    walk already descends into a node precisely because it has `parts` (below);
    the vendored viewer decides the same way (`isShapeTree(shape) { return
    "parts" in shape; }`); and the build writes a group as
    `{"version", "name", "id", "loc", "parts"}` with no key and a leaf with one.
    So a node with no `parts` under it is a leaf, and a leaf with no key is a
    part a reader can find nothing about — the reconstruction-by-name the
    catalogue exists to end.

    IT IS THE PRESENCE OF THE FIELD AND NOT ITS VALUE, which is the viewer's
    rule quoted verbatim above: `"parts" in shape`. Asking `is None` instead
    made `{"key": "lid", "parts": null}` a LEAF here — a document this accepted,
    while the viewer read the same node as a group and ran
    `for (const shape of shapes.parts)` over a null. That is the failure issue
    #53 is about, arriving through the other door: a 201 into an immutable
    directory under a year of cache, and a build that never opens. Both
    spellings agree on every node a build writes and disagree on exactly one
    hand-made value, so the cheap way to keep them agreeing is to ask the
    question the same way. `null` now reaches the list check below and is
    refused in its words. `VIEW_KEPT_KEYS` is what makes the presence readable
    at all: the parser drops the fields not on it, and `parts` is on it, so a
    key written in the file is a key in the node here.

    EVERY `key` IN THE FILE GOES INTO THE SET, wherever it sits, because a key
    is a claim about what this view shows and this walk is not the place to
    decide which nodes a future viewer will read one from. A group carrying one
    is not something the build writes; if a push writes it anyway, it is
    declared like any other. What the set is FOR is `_match_selection`, which
    holds it against the view's declared `parts` — equality in both directions.

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


def _view_parts(view: dict, view_id: str, catalogue: dict) -> list:
    """`views[].parts`: WHICH parts this view shows, by catalogue key.

    A LIST OF KEYS AND NOT A COUNT, and that swap is the whole of issue #75 on
    this document. A number was a fact about the view FILE that no reader could
    reconcile with anything else: five pins are five references to one catalogue
    record, so the count disagreed with the parts map beside it, and a reader
    wanting to know what was in a tab had to fetch a multi-megabyte view file to
    find out.

    EVERY KEY HAS TO BE ONE THE CATALOGUE DECLARES, and that check is the reason
    the field is worth having at all: it turns "this view shows that part" from
    two strings that happen to be equal into something the hub can refuse. Held
    to no name rule of its own here — membership in the catalogue is stricter
    than `_check_part_name`, since every key in it already passed exactly that.

    COUNTED BEFORE THE WALK, against the size of the catalogue. Deduplication on
    the build side is not a bound on this side: the document arrives from a
    push, and the build that wrote it is not a witness the hub has. The
    duplicate refusal below is what makes the count exact — a list with no
    repeats, every entry a distinct catalogue key, cannot be longer than the
    catalogue — but it is reached one entry at a time, and the ceiling is here
    so a list of a hundred thousand repeats is refused before any of it is
    walked.

    ASKED BEFORE THE VIEW FILE IS OPENED, and that is why the comparison with
    the file is a second function rather than an argument to this one. Everything
    here is a dict lookup; what follows it in `build_meta` is a full parse of the
    view file and a full gzip of it, in a build worker of which the process has
    two. A push naming one 200 MB view and writing `"parts": "x"` used to pay
    both before this line could produce the 422 — precisely the bill
    `_check_map_size` refuses to pay one paragraph over.
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
    """`views[].parts` has to be EXACTLY the keys its view file names.

    THE TWO DOCUMENTS ARE ONE CLAIM, and until they were compared nothing here
    held them together: `_view_parts` above checked the list against the
    catalogue, `check_view_file` checked the file against the catalogue, and
    neither ever met the other. So a view file of two unkeyed leaves published
    beside `"parts": ["lid", "pin", "m3"]`, and so did a `"parts": []` beside a
    file full of them — a tab promising three parts and showing one, repeated by
    `hammerola status` and by the card on the build page, into an immutable
    directory under a year of cache.

    EQUALITY AND NOT CONTAINMENT, because the field is DERIVED and not chosen:
    `cadbuild.views.export_views` writes it as
    `list(dict.fromkeys(node["key"] for node in nodes))` — the keys of the
    leaves, deduplicated, in the order the author wrote them. So the set is the
    whole of what an honest build can put here, and either direction of
    disagreement is a document that lies about itself: a key declared and not
    shown is a part a reader is promised and cannot find, a key shown and not
    declared is a part in the tab that the summary never mentions.

    ORDER IS NOT COMPARED, and that is not laxity. The list's order is the
    author's statement about the assembly (`_view_parts` copies rather than
    sorts it), while the walk that produced `shown` descends a stack and cannot
    report an order at all. What is checked is membership, in both directions.
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
               job: str = None) -> dict:
    """Validate the uploaded meta.json and normalize it for the viewer.

    NOTHING IS RENAMED ANY MORE. `views` used to be handed to the browser as
    `variants` — a word the viewer had inherited from the prototype, translated
    here in one line so working frontend code did not have to be touched over
    it. Issue #75 rewrites that half around catalogue keys anyway, so the line
    stopped buying anything and started costing the usual price of two names for
    one thing. A view is called a view all the way through.

    THE CATALOGUE IS READ FIRST, and the order is load-bearing rather than
    tidy: every view names the keys it shows and every leaf of every view file
    carries one, so `parts` has to exist before any of them can be checked
    against it.

    `bytes` and `gzip` are measured SERVER-SIDE rather than trusted from the
    upload: they are shown in the view picker, so a wrong number is a wrong
    promise about what clicking costs, and CI has no reason to compute them.
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

        # THE SAME QUESTION EVERY OTHER POINTER IS ASKED, through the same
        # helper. This loop used to ask a version of it inline — membership, `/`
        # and `GENERATED_FILES` — and that version never grew the leading-dot
        # and non-printable clauses the shared rule has, so a view file called
        # `.assembled.json` published with a 201 and 404'd on every GET, on the
        # one map without which the build page has nothing to draw at all.
        name = view.get("file")
        _check_declared_file(name, files, f"view {view_id!r}")

        # BEFORE THE FILE IS TOUCHED, and the order is the whole point: what
        # this answers costs a lookup per key, while the two lines under it cost
        # a full parse of the view file and a full gzip of it — up to
        # MAX_BUILD_BYTES of it, in one of two build workers. It used to be
        # asked where its value is used, five lines down, so `"parts": "x"` was
        # a 422 bought at the price of the whole file.
        selected = _view_parts(view, view_id, catalogue)

        # The bytes of this file are handed to `viewer.render()` verbatim, so the
        # push does not stop being untrusted input at the archive boundary: what
        # is inside a view reaches the DOM as well — and, since issue #75, every
        # leaf of it names a catalogue key, which is checked against the
        # catalogue this document declares rather than merely for shape.
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
        # The whole-view mesh and the whole-view picture: `assembled.stl` and
        # `assembled_preview.png`, and the same pair for `print` where the
        # project has that view. OPTIONAL because most views have neither — the
        # build hangs them on the two ids it renders — and read with an explicit
        # `is None` like every other optional field here.
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
        rendered.append(entry)

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
        # REBUILT, not passed through. Both of these were assembled field by
        # field out of the upload above, so a key of the pushed document that
        # nothing here reads cannot reach the browser by riding along — which is
        # what makes "an unvalidated field is a field that does not exist here"
        # true rather than aspirational.
        "views": rendered,
        "parts": catalogue,
    }
    # THE THIRD KEY THE SLOT HAS AND A REVISION DOES NOT (issue #79). The slot
    # is not addressed by a revision, so no log is stored under its name and the
    # only copy of one is at the JOB that produced the build — which nothing
    # remembered, so `hammerola log dev` could only refuse. One field is that
    # memory. Added after the document rather than inside it so a revision's
    # meta.json does not change by a byte, and left None-able because a slot
    # written without one still has to be a published slot.
    if dev:
        meta["job"] = job
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
    that has never published anything at all has no slot — and the picker must
    offer neither in that case, or it offers a link to a 404. The slot's absence
    ends at the FIRST publication of either kind: since issue #78 a commit fills
    the slot with itself, so `has_dev` is true of every project that has ever
    committed, laptop push or no. They are answers
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

    `dev` is whether the local slot holds sources NO COMMIT HAS PUBLISHED, which
    is not the same as the slot being occupied: a commit fills the slot with
    itself (issue #78), so "occupied" is true of every project that has ever
    committed and a card built on it would carry the chip always.
    `Store._uncommitted_in_slot` is what answers it, by digest.

    THAT MAKES THIS FLAG AND `has_dev` IN `builds_json` TWO DIFFERENT QUESTIONS,
    on purpose. `has_dev` asks whether the slot exists, because the picker uses
    it to decide whether to OFFER a `/dev/` link at all — narrowing it to "the
    slot differs from `latest`" would hide a link that resolves, and would make
    `hammerola status` call an occupied slot empty. This flag asks whether there
    is anything to say about the project on the front page, where a chip on
    every card says nothing.

    The card still describes the newest COMMIT and never the slot — that is SPEC
    7.6 and the front page is exactly where it matters — but "there is
    uncommitted work in this project" is a different statement from "this is what
    the project looks like", and only the second one is a promise about the link.

    `first_built` is the honest answer to a question the hub cannot answer. It
    does not know when a project was CREATED: `hammerola create` mints an id in
    the author's own directory and nothing reaches this side until the first
    push, so the earliest moment on record is a build. The card therefore carries
    the OLDEST build still here and the page labels it as that rather than as a
    creation date. It is a stable answer and not a drifting one only because
    there is no retention (SPEC 5.3): builds are never swept, so the oldest one
    stays the oldest.
    """
    total_gzip = sum(v["gzip"] for v in meta["views"])
    return {
        "pid": meta["pid"],
        "project": meta["project"],
        "title": meta["title"],
        "commit": meta["commit"],
        "built": meta["built"],
        "first_built": first_built,
        "dev": bool(dev),
        # HOW MANY PARTS GET PRINTED, and the field is called `printables`
        # because it answers a different question from the one the old field
        # asked. That one was `max(v["parts"] for v in meta["variants"])` — the
        # part COUNT of the biggest view — and the literal translation of it now
        # that `parts` is a catalogue, `len(meta["parts"])`, would count the
        # bought screws and the scenery along with the printed parts: three
        # printed parts and nine screws would read "12 parts" on the front page.
        # The kind is what finally makes the honest number expressible.
        #
        # THE NAME CHANGES ON PURPOSE, and the same goes for `views` below. A
        # field that keeps its name and changes its meaning breaks its readers
        # in silence — a card would go on rendering a number that is no longer
        # the number it says — while a field that DISAPPEARS breaks them loudly,
        # at the one moment somebody is there to fix it. The browser half is
        # repointed at these in the step that rewrites it (issue #75).
        "printables": sum(1 for record in meta["parts"].values()
                          if record["kind"] == KIND_PRINTABLE),
        "views": len(meta["views"]),
        "mb": f"{total_gzip / 1e6:.1f}",
    }
