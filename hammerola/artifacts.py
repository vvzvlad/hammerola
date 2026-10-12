"""`hammerola artifacts` — the STL, STEP and 3MF a build produced.

A separate verb from `source` because the rights differ: a build directory is
public (served to anyone with the URL, cached for a year), while the code that
produced it is behind the publishing secret. Two verbs make fetching one or the
other a deliberate choice. The route used here needs no secret, but the command
still expects a logged-in machine, since that is how it knows the hub.

It fetches what `meta.json` declares; the hub never lists a build directory. A file
belongs to one of two owners:

  * a CATALOGUE RECORD, under `parts`, keyed by the part's name. `files` is
    `{extension: filename}` (the STL, STEP and 3MF a printable was exported to)
    and `preview` is that part's picture. Other record kinds carry neither;
  * a VIEW, under `views`, addressed by its `id`. `overview` is the mesh of the
    whole view (`assembled.stl`, and `print.stl` for a `print` view) and
    `preview` is its picture.

The build page draws download buttons only for a printable's `files`, so every
declared pointer here is fetchable without implying a button.

A view's `file` is not fetched: it is the viewer's tessellation payload, of no use
outside the browser. A view's `card` is not fetched either: it is `preview` cropped
for the front-page tile. `DECLARING_FIELDS` enforces both, and
`tests/client/test_fetching.py` pins it.

`dev` and `latest` are accepted here, unlike in `source`: the hub serves them like
any other build directory.
"""

import reprlib
from pathlib import Path

from hammerola.buildnames import unservable_reason
from hammerola import project
from hammerola.errors import ClientError
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

# Every field of `meta.json` naming a file this command fetches, by owner, in the
# order entries are printed. The list is closed: a view's `file` and `card` are not
# on it (see the module docstring). It is also the only place these names are
# written; `_fields_sentence` builds the "declares nothing" message from it.
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
        # No pointer at all: an honest build cannot produce this (the build and
        # `render._catalogue` both require a printable with `files`), so this is a
        # document edited on the volume or from another hub version. Still a zero
        # exit, because the answer is well formed and merely empty.
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
        # The hub's own rule (`hammerola/buildnames.py`), already applied at publish
        # time (`render._check_declared_file`), so a failure means the answer did
        # not come from a published build: refuse rather than skip. The
        # non-printable clause matters here because the name is printed and
        # written to disk, and a U+202E would reverse the report.
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
        # Every string on this line is quoted or already checked: `field` can
        # carry a label from the document (the keys of `files`), and a U+202E in
        # it would reverse the rest of the line in the terminal.
        print(f"  {where:<22} {field!r:<12} {filename}  "
              f"{len(body) / 1e3:.1f} kB")

    print(f"  {len(declared)} files, {total / 1e6:.2f} MB")
    return 0


def _fields_sentence() -> str:
    """Every field `_declared` reads, built from `DECLARING_FIELDS` so the message
    and the walk cannot disagree.
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

    The hub validates the whole document at publish time (`parts` a non-empty
    object of objects, `views` a non-empty list of objects, `files` a non-empty
    object: `render._catalogue`, `render.build_meta`), so any other shape did not
    come from a published build. A refusal rather than a skip: skipping a wrong
    `parts` would download only the views' files and report an incomplete set as
    complete.
    """
    return ClientError(
        f"{what} is {_brief(value)}, which is not a shape this document "
        f"carries.\n"
        f"  The hub checks every one of these at publish time, so this answer "
        f"did not come from a build the hub published.")


# `repr`, cut short before it is built: the value comes from somebody else's
# document, which may be large. `reprlib` slices strings before `repr` and walks
# lists through `islice`, and still escapes control characters in the leaves.
# On a dict it is only a constant factor cheaper: `repr_dict` sorts every key
# before cutting (8 bytes per key, O(n log n)), which is small next to the
# already-parsed reply. Dicts therefore print with sorted keys, not in document
# order. `tests/client/test_brief.py` pins this.
_SHORT = reprlib.Repr()
_SHORT.maxstring = _SHORT.maxother = 120
_SHORT.maxdict = _SHORT.maxlist = _SHORT.maxtuple = 6
# The ceilings are per level, so depth multiplies them. Four is one more than this
# document nests (`parts` -> a record -> `files` -> a name).
_SHORT.maxlevel = 4


def _brief(value) -> str:
    """One refused value, short enough to be read in a terminal.

    The final slice cuts a string the ceilings above already bounded.
    """
    text = _SHORT.repr(value)
    return text if len(text) <= 120 else text[:117] + "..."


def _pointers(record: dict, owner: str, where: str):
    """Every `(field, filename)` one record names, in the declared order.

    A field of the wrong shape is a refusal, never a drop or a fetch. `files` is the
    only multi-name field and the hub publishes it only as a non-empty object of
    `{extension: filename}`; a string there (`"files": "assembled.stl"`) passes the
    file-name rule, so it is refused here rather than by the caller.
    One-name fields (`preview`, `overview`) are handed on whole, and the file-name
    rule in `run` is the right check for them.
    """
    for field, many in DECLARING_FIELDS[owner].items():
        value = record.get(field)
        # Absent and `null` are the same thing, as on the hub side
        # (`render._catalogue`).
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

    Each entry says whose file it is (`part 'lid'`, `view 'assembled'`). Parts are
    walked in key order (a catalogue reads best alphabetically), views in the
    document's order (the author's tab order, as `render._view_parts` keeps it).

    Deduplicated by filename, since two owners may name one file; a non-string
    filename skips the dedup and is refused by the caller.

    Every shape this walk relies on is checked, and a wrong one is refused (see
    `_not_from_the_hub`): `data/` is writable by every build (SPEC §7.4), so a
    `meta.json` may have been rewritten by another project's build.
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
        # By id, as everywhere else in the document; the position is the fallback
        # for a document with no usable id.
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
    given = args.output
    if given:
        dest = Path(given).expanduser()
    else:
        short = name if name in POINTER_NAMES else name[:SHORT_ID_CHARS]
        dest = scratch_dir(base, f"artifacts-{short}")
    return dest if dest.is_absolute() else (base / dest).resolve()
