"""`hammerola artifacts` — the STL, STEP and 3MF a build produced.

A SEPARATE VERB FROM `source`, AND THE REASON IS RIGHTS, NOT CONVENIENCE
(issue #26). A build directory is public: the viewer fetches it, the
download buttons link into it, and every file in it is served to anybody with
the URL, cached for a year. The CODE that produced it is behind the publishing
secret and lives in a tree the file server cannot reach at all. One verb with a
`--code` flag would put those two on the same word and make the difference
something a person has to remember; two verbs make it something they choose.

THE ROUTE THIS USES NEEDS NO SECRET — it is the same URL the build page fetches
— and the command still expects the machine to be logged in, exactly as `status`
does and for the same reason: this tool has one login, and a machine that cannot
say where the hub is has not been set up. What the split buys is not a command
that works without credentials; it is that fetching a model's CODE is a
different word from fetching its printable output, so neither can be done by
accident while meaning the other.

WHAT IT FETCHES IS WHAT `meta.json` DECLARES, and there is no directory listing
anywhere on the service to fetch instead — deliberately: the hub serves files by
name and never enumerates a build. A FILE BELONGS TO WHAT IT IS OF, and there
are exactly two owners (issue #75):

  * a CATALOGUE RECORD, under `parts`, filed under the key that IS the part's
    name. `files` is `{extension: filename}` — the STL, STEP and 3MF a
    printable was exported to — and `preview` is the picture of that one part.
    A record of any other kind carries neither: nothing is exported for a
    bought screw or for the wall a bracket bolts to;
  * a VIEW, under `views`, addressed by its `id`. `overview` is the mesh of the
    whole thing that tab shows — `assembled.stl`, and `print.stl` where the
    project has a `print` view — and `preview` is its picture.

OWNERSHIP IS WHAT LETS THE PICTURES AND THE OVERVIEW MESHES BE DECLARED AT ALL,
and it replaced an argument this file used to have to make. Only a printable's
`files` become download buttons on the build page: a picture is looked at rather
than downloaded, and a `print.stl` button on a public page would offer a plate
that may legitimately carry a mock of a purchased part. In the four flat maps
this document carried before, "a client may fetch this" and "the page draws a
button for this" were one sentence, so saying the first without the second took
two maps invented for the purpose — and a per-part picture could not be declared
at all without ten buttons appearing under it, which is why the instruction that
survived instead told an agent to assemble the URL by hand. The page now decides
what to draw from WHOSE a file is, so every pointer on the document is fetchable
and the button question is not asked on this side at all.

A view's `file` is NOT an artefact and is not fetched: it is the viewer's
tessellation payload, megabytes of it, and nothing outside the browser has a use
for it.

A view's `card` is not fetched either, and for the opposite reason — not too big
but too little. It is the same render as `preview` with the title and the footer
cut off, drawn for the tile on the hub's front page, where the page supplies the
caption itself. The author looking at a build on their own disk wants the sheet
with the bounding box, the triangle count and the watertight verdict under it;
the cropped twin next to it would answer nothing that picture does not. So the
declaration carries it — the front page fetches it by name, and a name the hub
serves has to be declared — and this command walks past it. `DECLARING_FIELDS`
below is where that decision is enforced, and `tests/client/test_fetching.py`
pins it.

`dev` AND `latest` ARE ACCEPTED HERE, unlike in `source`. This asks a BUILD for
its files and the hub serves those two names like any other build directory —
which is exactly what somebody who just ran `hammerola build` wants.
"""

import reprlib
from pathlib import Path

from hammerola.buildnames import unservable_reason
from hammerola import project
from hammerola.errors import ClientError
from hammerola.hub import Hub
from hammerola.limits import DEV_SLOT, SAFE_ID
from hammerola.sources import LATEST, SHORT_ID_CHARS, hub_for, scratch_dir

# The build names that are not revision ids and are still perfectly good targets:
# the two pointers. `latest` is passed through to the hub rather than resolved
# first — the file it serves under that name IS the newest revision's, and one
# fetch is better than two.
POINTER_NAMES = (LATEST, DEV_SLOT)

# Whether a field holds ONE file name or a MAP of them, spelled out because
# `True` at a call site says nothing about which of the two it means.
ONE, MANY = False, True

# EVERY FIELD OF `meta.json` THAT NAMES A FILE THIS COMMAND FETCHES, by the
# owner it sits on, in the order their entries are printed. See the module
# docstring for what each one is; what matters here is that the list is
# CLOSED — a view's `file` and its `card` are deliberately not on it, the first
# too big to be of use off the browser and the second too little.
#
# IT IS ALSO THE ONLY PLACE THOSE NAMES ARE WRITTEN, and that is a repair rather
# than tidiness. The message in `run` below used to name the old document's
# three maps BY HAND, and
# `test_a_build_declaring_nothing_at_all_says_so_and_still_succeeds` pinned that
# sentence as a literal substring — so a field added to the walk and nowhere
# else would have been fetched perfectly while the one message about it stayed
# wrong, with the suite green. `_fields_sentence` builds that sentence out of
# this dict, so the walk and the sentence cannot disagree about what was looked
# at; the test then asserts the message names every field this declares,
# reading the dict rather than a copy of the words.
DECLARING_FIELDS = {
    "part": {"files": MANY, "preview": ONE},
    "view": {"overview": ONE, "preview": ONE},
}


def run(args) -> int:
    """Download one build's declared artefacts. -> exit code."""
    root = project.find_project_root(args.directory)
    pid = project.read_project_id(root)
    hub = hub_for(root)

    name = _build_name(args.revision)
    meta = hub.build_meta(pid, name)
    if meta is None:
        raise ClientError(
            f"the hub has no build {name} for project {pid}.\n"
            f"  `hammerola status` lists what it does have.")

    declared = _declared(meta)
    if not declared:
        # NOT ONE POINTER ON THE WHOLE DOCUMENT, which no build of a model
        # produces and which the hub does not publish either. BOTH HALVES SAY
        # SO NOW, and they say it about different things:
        # `cadbuild.parts.read_catalogue` refuses a catalogue with nothing
        # printable in it and `export_printables` writes three files for every
        # printable it finds, while `render._catalogue` on the receiving side
        # refuses a catalogue with no printable in it AND a printable with no
        # `files`. So an honest answer cannot land here at all; what can is a
        # document edited on the volume, a hub of another version, or something
        # in between that rewrote the reply.
        #
        # It stays a message and a zero all the same, because the answer is
        # well formed and merely empty — there is nothing here to download and
        # nothing that could be downloaded WRONGLY, which is what the refusals
        # below are for.
        print(f"{name} declares no downloadable artefacts.")
        print(f"  Nothing in its meta.json names one: {_fields_sentence()} are "
              f"all absent.")
        print("  A build of a model exports at least one printable and writes "
              "the assembled mesh, so this document was not written by one.")
        return 0

    dest = _destination(args, name)
    dest.mkdir(parents=True, exist_ok=True)

    print(f"{pid}/{name} -> {dest}")
    total = 0
    for where, field, filename in declared:
        # THE HUB'S OWN RULE, IMPORTED RATHER THAN RESTATED (`hammerola/buildnames.py`).
        # The hub asked it of every one of these pointers at publish time
        # (`render._check_declared_file`), so this cannot happen from a build it
        # published — which is why it is a refusal rather than a
        # skip: a name of this shape means the answer did not come from where it
        # should have. That is also why the rule has to be the hub's whole one
        # and not an approximation of it: the case this defends against is a
        # dishonest or corrupted answer, and against that case the two
        # conditions that used to stand here — `/` and a leading dot — caught
        # nothing of what the check is FOR. The non-printable clause names this
        # very command as its beneficiary: the name is printed on the line below
        # and then written to the author's disk, so a U+202E in it reverses the
        # report of what was just saved.
        reason = unservable_reason(filename)
        if reason is not None:
            raise ClientError(
                f"{name} declares the {field!r} of {where} pointing at "
                f"{filename!r}, which {reason}.\n"
                f"  That is not a name a build can serve, so this answer did "
                f"not come from a build the hub published.")
        body = hub.build_file(pid, name, filename)
        if body is None:
            raise ClientError(
                f"{name} declares the {field!r} of {where} -> {filename}, and "
                f"the hub does not serve it.\n"
                f"  The build is there and the file is not; nothing was left "
                f"half-written.")
        target = dest / filename
        try:
            target.write_bytes(body)
        except OSError as error:
            raise ClientError(f"cannot write {target}: {error}") from error
        total += len(body)
        # THE FIELD IS QUOTED, AND SO IS EVERY OTHER STRING ON THIS LINE. Two of
        # the three were already safe — `where` is built with `!r` and
        # `filename` went through `unservable_reason` above — while `field`
        # carried a label lifted out of the document verbatim: `files` is a map
        # whose KEYS the document chooses, so a label carrying U+202E (written
        # as an escape here, never pasted — a literal one reverses this very
        # source line) printed a report line whose tail runs backwards in the
        # terminal, over the name of a file just written. That is the
        # very reader `buildnames.unservable_reason` names as the reason a file
        # name is held to the non-printable rule, and the label sat beside it
        # unheld. `!r` here and in the two refusals above, so the three places
        # this string is shown cannot drift apart on it.
        print(f"  {where:<22} {field!r:<12} {filename}  "
              f"{len(body) / 1e3:.1f} kB")

    print(f"  {len(declared)} files, {total / 1e6:.2f} MB")
    return 0


def _fields_sentence() -> str:
    """Every field `_declared` reads, named once, BUILT FROM THE TABLE IT READS.

    The one message about "this build declares nothing" has to list them, and
    listing them beside the table is how the two drift: see `DECLARING_FIELDS`
    for the failure that costs. Generated, so there is nothing to keep in step.
    """
    return ", and ".join(f"{_names(fields)} on a {owner}"
                         for owner, fields in DECLARING_FIELDS.items())


def _names(fields) -> str:
    """One owner's fields, quoted and joined: a, b and c."""
    quoted = [f"`{field}`" for field in fields]
    if len(quoted) < 2:
        return "".join(quoted)
    return f"{', '.join(quoted[:-1])} and {quoted[-1]}"


def _not_from_the_hub(what: str, value) -> ClientError:
    """The refusal a WRONG SHAPE gets, in one wording for every place it can sit.

    A SHAPE AND A NAME ARE THE SAME EVIDENCE, and this says so in the same tone
    as the file-name refusal in `run` above: the hub validates the whole of this
    document at publish time — `parts` is a non-empty object of objects,
    `views` a non-empty list of objects, `files` a non-empty object
    (`render._catalogue`, `render.build_meta`) — so a value of any other shape
    is not something a build it published can have produced.

    IT IS A REFUSAL AND NOT A SKIP, which is the whole reason this function
    exists rather than a `continue` at each of the five places. A skip is the
    one outcome worth avoiding here: `parts` arriving as a list dropped the
    CATALOGUE ENTIRE, and `hammerola artifacts` then downloaded the views'
    pointers, printed "2 files" and exited 0 — an author handed an incomplete
    set of parts, reported as complete. Refusing costs nothing an honest answer
    was going to spend.
    """
    return ClientError(
        f"{what} is {_brief(value)}, which is not a shape this document "
        f"carries.\n"
        f"  The hub checks every one of these at publish time, so this answer "
        f"did not come from a build the hub published.")


# `repr`, cut short — and cut short BEFORE it is built, which is the whole
# reason this is `reprlib` and not a slice of `repr(value)`. The value is
# somebody else's document: a refused `parts` can be the whole of it, and the
# ceiling on a reply is `MAX_REPLY_BYTES` (`hammerola/hub.py`), i.e. tens of
# megabytes. Slicing at 120 characters materialized every one of those bytes as
# a Python string first and threw all but 117 away — the docstring said "can be
# the whole megabyte of it" while the code built exactly that. `reprlib` builds
# only what it prints: `repr_str` slices to `maxstring` BEFORE calling `repr` on
# it, and `_repr_iterable` walks a list through `islice`. It calls `repr` on the
# leaves, so a control character in a part name is still escaped rather than
# printed into the terminal.
#
# WHAT THEY BUY DIFFERS BY SHAPE, and the claim that it was one property has
# now stood here wrongly twice: first as independence from the document's size,
# then — once the TIME had been measured — as "a statement about memory". Both
# readings were wrong about a dict. Every number below was measured on CPython
# 3.14.6 with `tracemalloc`, over keys eleven characters long:
#
# ON A `str` AND ON A `list` THEY BUY THE WHOLE STRING, because on both the cut
# happens before the rendering does (above). A four-megabyte string peaks at
# 616 bytes here against 4,194,508 for `repr(value)[:120]`; a list of 500,000
# numbers, 913 against 4,577,757.
#
# ON A `dict` THEY BUY A MULTIPLIER AND NOT THE STRING.
# `reprlib.Repr.repr_dict` is `islice(_possibly_sorted(x), self.maxdict)`, and
# `_possibly_sorted` is `sorted(x)` over EVERY key — a materialized list of
# pointers, cut only afterwards. So a dict costs its key count in memory as
# well as in time: 500,000 keys peak at 4,001,318 bytes against 9,155,518 for
# the naive slice, a factor of 2.3 and exactly 8.00 bytes per key, which is one
# pointer; in time it is O(n log n), 17 ms on two million keys.
#
# THE SCALE IS BOUNDED BY WHAT HAS ALREADY HAPPENED, which is what makes this a
# defect in the accuracy of load-bearing documentation rather than a hole to
# defend against. A value only reaches here out of a reply `json.loads` has
# already parsed, and holding the parsed dict is an order of magnitude dearer
# than sorting its keys: the same 500,000-key document peaks at 56,758,306
# bytes to parse and retains 41,379,136, against the 4,000,000 the sort adds.
#
# WHICH REFUSALS CAN CARRY SUCH A DICT WAS CHECKED RATHER THAN ASSUMED. Of the
# five calls to `_not_from_the_hub`, four hand over a value that has just
# failed `isinstance(..., dict)` — `parts`, a record, an entry of `views` — or,
# in `_pointers`, a dict already known to be EMPTY; the value itself is
# therefore never a large dict at any of them. The `views` that is not a list
# is the one that can be. Those four do not escape the sort, though, they only
# push it one level down: a dict nested inside a refused list is still sorted
# whole (4,001,517 bytes for the same 500,000 keys).
#
# THE ORDER IS A CONSEQUENCE OF THAT SORT: a dict prints with its keys sorted,
# not in the order the document wrote them. Nothing here reads the order and the
# refusal names the field it is about anyway (`_not_from_the_hub`), but this is
# a rendering rather than a quotation, and a reader holding it against the JSON
# they were handed should know which.
_SHORT = reprlib.Repr()
_SHORT.maxstring = _SHORT.maxother = 120
_SHORT.maxdict = _SHORT.maxlist = _SHORT.maxtuple = 6
# Every ceiling above is PER LEVEL, so depth multiplies them and the default of
# six levels is 6**6 entries in the worst case — smaller than the document and
# still nothing to build for one line of terminal output. Four is one more than
# this document ever nests (`parts` -> a record -> `files` -> a name).
_SHORT.maxlevel = 4


def _brief(value) -> str:
    """One refused value, short enough to be read in a terminal.

    The final cut is what it always was, and what it now slices is a string the
    ceilings above already bounded rather than one the size of the reply. WHAT
    THAT IS WORTH DEPENDS ON THE SHAPE, and the measurements are written over
    those ceilings: on a string or a list the reply's own megabytes are never
    built at all, while a dict has every key it was handed sorted into a list
    of pointers first — so there the ceilings buy a factor, in time and in
    memory both, and not the string.

    `tests/client/test_brief.py` is what holds all of it — the ceiling, the
    depth, the escaping, and both sides of that last one: the megabyte a string
    never builds, and the pointer per key a dict does.
    """
    text = _SHORT.repr(value)
    return text if len(text) <= 120 else text[:117] + "..."


def _pointers(record: dict, owner: str, where: str):
    """Every `(field, filename)` one record names, in the declared order.

    A FIELD OF THE WRONG SHAPE IS A REFUSAL — never a drop, and never a fetch.
    `files` is the only one of the four that holds several names, and the only
    shape the hub publishes it in is a NON-EMPTY object of
    `{extension: filename}`: `render._catalogue` refuses a `files` that is not
    an object, refuses `{}` outright rather than dropping it, and — since the
    review of this change — refuses a printable that declares none at all.

    THE STRING IS WHY THIS IS NOT LEFT TO THE CALLER, and it is the likeliest
    of the wrong shapes rather than an exotic one. This used to hand a
    non-object on whole and say the caller would refuse it by the file-name
    rule; that held for `[]`, `0`, `""` and `false`, which are not file names —
    and failed for exactly `"files": "assembled.stl"`, a perfectly good name
    that `unservable_reason` passes and the client then downloaded, reporting
    one part's whole export as a single file.

    A ONE-NAME FIELD IS STILL HANDED ON WHOLE, and that is not the same case:
    `preview` and `overview` hold a name, so whatever arrives there IS the
    pointer and the file-name rule is the right question to ask of it.
    """
    for field, many in DECLARING_FIELDS[owner].items():
        value = record.get(field)
        # ABSENT AND `null` ARE ONE THING HERE, which is the rule this document
        # is written to on the other side as well (`render._catalogue`):
        # optional fields are left out rather than emptied, and a `null` that
        # arrives anyway is read as the absence it spells.
        if value is None:
            continue
        if not many:
            yield field, value
            continue
        if not isinstance(value, dict) or not value:
            raise _not_from_the_hub(f"the {field!r} of {where}", value)
        for label in sorted(value, key=str):
            # The label comes off the document and is printed beside the file
            # name; `run` above is what quotes it, in the one place all three
            # of its appearances are built.
            yield f"{field}.{label}", value[label]


def _declared(meta: dict) -> list:
    """Every file the build declares, as `(where, field, filename)`, once each.

    ONE PASS OVER BOTH OWNERS, and what travels with each entry is WHOSE the
    file is — `part 'lid'`, `view 'assembled'` — because that is the whole of
    what issue #75 made knowable. It used to be the name of one of three flat
    maps, and the key beside it had to be read for what kind of thing it named:
    a part's stem in `previews`, a bare `stl` in a single-printable build's
    `downloads`. Both the report and the refusal now say what the pointer is
    ON, which is stated by the document instead of parsed out of a key.

    PARTS ARE WALKED IN KEY ORDER AND VIEWS IN THEIRS. Both come off a document
    whose order is already fixed, so neither choice is about determinism: a
    catalogue is a set of records and reads best alphabetically, while a list
    of views is the author's own statement of what order the tabs are in
    (`render._view_parts` copies rather than sorts it for the same reason).

    Deduplicated BY FILENAME, because nothing stops two owners naming one file
    — no rule on the hub side forbids it — and the cost of not noticing is
    fetching the same bytes twice and reporting a count nobody can reconcile
    with the directory. A filename that is not a string skips the dedup and is
    refused by the caller on sight.

    EVERY SHAPE THIS WALK RELIES ON IS CHECKED, AND CHECKING IT MEANS REFUSING.
    Four of the five ways this document can be shaped wrong were skipped in
    silence here — a `parts` that is not an object, a record that is not one, a
    `views` that is not a list, an entry of it that is not an object — while the
    policy twenty lines above said in as many words that a wrong shape must not
    be dropped, because a pointer missing from a report that COUNTS what it
    fetched is the outcome worth avoiding. It is not hypothetical: `data/` is
    writable by every build (SPEC §7.4), so one project's build can rewrite
    another's `meta.json`, and `"parts": []` then handed the author the views'
    files, "2 files", and a zero. See `_not_from_the_hub`.
    """
    found = []
    seen = set()

    def take(where: str, field: str, filename) -> None:
        if isinstance(filename, str):
            if filename in seen:
                return
            seen.add(filename)
        found.append((where, field, filename))

    catalogue = meta.get("parts")
    if not isinstance(catalogue, dict):
        raise _not_from_the_hub("the `parts` catalogue of this build",
                                catalogue)
    for key in sorted(catalogue, key=str):
        record = catalogue[key]
        where = f"part {key!r}"
        if not isinstance(record, dict):
            raise _not_from_the_hub(where, record)
        for field, filename in _pointers(record, "part", where):
            take(where, field, filename)

    views = meta.get("views")
    if not isinstance(views, list):
        raise _not_from_the_hub("the `views` of this build", views)
    for index, view in enumerate(views):
        if not isinstance(view, dict):
            raise _not_from_the_hub(f"view #{index}", view)
        view_id = view.get("id")
        # By id, which is how every other side of this document addresses a
        # view. The position is the fallback for a document that carries no
        # usable one — which the hub cannot publish, and which still has to
        # produce a sentence naming WHICH view rather than `None`.
        where = (f"view {view_id!r}" if isinstance(view_id, str)
                 else f"view #{index}")
        for field, filename in _pointers(view, "view", where):
            take(where, field, filename)
    return found


def _build_name(given: str) -> str:
    """The build to ask for: a pointer name, or a revision id."""
    if given in POINTER_NAMES:
        return given
    if not SAFE_ID.match(given or ""):
        raise ClientError(
            f"{given!r} is neither a revision id nor one of {', '.join(POINTER_NAMES)}.\n"
            f"  `hammerola status` lists this project's revisions.")
    return given


def _destination(args, name: str) -> Path:
    """Where the files land: `-o DIR`, or `artifacts-<name>` beside the caller.

    A directory of its own under `.hammerola/`, and NOT the working copy, for
    the reason `sources.SCRATCH_DIR` gives: an STL written next to model.py is a
    file the next push would try to publish. Unlike `source` this does not
    refuse a directory that already has something in it — the files are named by
    the build and fetching the same build twice writes the same names, so
    re-running is an update rather than a merge of two different things.
    """
    base = Path(args.directory).expanduser() if args.directory else Path.cwd()
    given = getattr(args, "output", None)
    if given:
        dest = Path(given).expanduser()
    else:
        short = name if name in POINTER_NAMES else name[:SHORT_ID_CHARS]
        dest = scratch_dir(base, f"artifacts-{short}")
    return dest if dest.is_absolute() else (base / dest).resolve()
