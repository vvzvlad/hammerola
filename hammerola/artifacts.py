"""`hammerola artifacts` — the STL, STEP and 3MF a build produced.

A separate verb from `source` because the rights differ: a build's files are
served to the publishing secret or to a link that carries their key, while the
code that produced it is behind the secret alone. Two verbs make fetching one
or the other a deliberate choice. The route used here takes the secret for the
STL, STEP and 3MF, which the client sends with every request, so the command
expects a logged-in machine.

It fetches what `meta.json` declares; the hub never lists a build directory. A file
belongs to one of two owners:

  * a CATALOGUE RECORD, under `parts`, keyed by the part's name. `files` is
    `{extension: filename}` (the STL, STEP and 3MF a printable was exported to)
    and `preview` is that part's picture. Other record kinds carry neither;
  * a VIEW, under `views`, addressed by its `id`. `overview` is the mesh of the
    whole view (`assembled.stl`, and `print.stl` for a `print` view), `plates`
    is the `print` view's beds for a slicer, `{bed number: filename}`
    (`print.3mf`, `print-2.3mf`, ...), and `preview` is its picture.

A DOCUMENT, under `documents`, owns one `file`: the files project.json lists to
be read, published under their paths in the tree (`docs/cut-list.md`) and
written under the same paths here. A KiCad schematic or board owns, besides,
the files its `kicad` names: a schematic's sheets, and the project either one
is published with. A model's build carries documents after its views; a build
with no model (`"kind": "documents"`) carries nothing else.

The build page draws download buttons only for a printable's `files` and a
view's `plates`, so every declared pointer here is fetchable without implying a
button.

A view's `file` is not fetched: it is the viewer's tessellation payload, of no use
outside the browser. A view's `card` is not fetched either: it is `preview` cropped
for the front-page tile. `DECLARING_FIELDS` enforces both, and
`tests/client/test_fetching.py` pins it.

`dev` and `latest` are accepted here, unlike in `source`: the hub serves them like
any other build directory. They are those of the variant of the branch checked
out (`variant.current_variant`).
"""

import reprlib
from pathlib import Path

from hammerola.buildnames import unservable_path_reason, unservable_reason
from hammerola import project
from hammerola.errors import ClientError
from hammerola.limits import DEFAULT_VARIANT, DEV_SLOT, SAFE_ID
from hammerola.sources import LATEST, SHORT_ID_CHARS, hub_for, scratch_dir
from hammerola.variant import current_variant

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
# written; `_fields_sentence` builds the "declares nothing" message from it. The
# one exception is the sheets and the project of a KiCad document, which sit in
# an object of their own and are read by `_design_files`: a document with them
# always declares its `file` too, so that message is never theirs to say.
DECLARING_FIELDS = {
    "part": {"files": MANY, "preview": ONE},
    "view": {"overview": ONE, "plates": MANY, "preview": ONE},
    "document": {"file": ONE},
}

# What a build with no model says it is (`render.DOCUMENTS_KIND` on the hub).
DOCUMENTS_KIND = "documents"

# The prefix of `where` for a document's file, the one pointer that may be a
# path into subdirectories (`buildnames.unservable_path_reason`).
DOCUMENT_WHERE = "document "


def run(args) -> int:
    """Download one build's declared artefacts. -> exit code."""
    root = project.find_project_root(args.directory)
    pid = project.read_project_id(root)
    hub = hub_for(root)

    name = _build_name(args.revision)
    # Only a pointer has a variant: a revision has one address.
    variant = (current_variant(root) if name in POINTER_NAMES
               else DEFAULT_VARIANT)
    meta = hub.build_meta(pid, name, variant)
    if meta is None:
        of = ("" if name not in POINTER_NAMES or variant == DEFAULT_VARIANT
              else f" of variant {variant}")
        raise ClientError(
            f"the hub has no build {name}{of} for project {pid}.\n"
            f"  `hammerola status` lists what it does have.")

    declared = _declared(meta)
    if not declared:
        # NOT ONE POINTER ON THE WHOLE DOCUMENT, which no build of a model
        # produces: `cadbuild.build` writes the `assembled` view's overview mesh
        # whatever the catalogue holds, a catalogue with nothing printable in
        # it included. So an honest answer cannot land here; what
        # can is a hand-made push, a document edited on the volume, a hub of
        # another version, or something in between that rewrote the reply.
        #
        # It stays a message and a zero all the same, because the answer is
        # well formed and merely empty — there is nothing here to download and
        # nothing that could be downloaded WRONGLY, which is what the refusals
        # below are for.
        print(f"{name} declares no downloadable artefacts.")
        print(f"  Nothing in its meta.json names one: {_fields_sentence()} are "
              f"all absent.")
        print("  A build of a model always writes the assembled mesh, so this "
              "document was not written by one.")
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
        # A document keeps its path, every other file sits at the top; the
        # path rule is the name rule per segment, so nothing it passes climbs
        # out of `dest`.
        is_document = where.startswith(DOCUMENT_WHERE)
        reason = (unservable_path_reason if is_document
                  else unservable_reason)(filename)
        if reason is not None:
            raise ClientError(
                f"{name} declares the {field!r} of {where} pointing at "
                f"{filename!r}, which {reason}.\n"
                f"  That is not a name a build can serve, so this answer did "
                f"not come from a build the hub published.")
        body = hub.build_file(pid, name, filename, variant)
        if body is None:
            raise ClientError(
                f"{name} declares the {field!r} of {where} -> {filename}, and "
                f"the hub does not serve it.\n"
                f"  The build is there and the file is not; nothing was left "
                f"half-written.")
        target = dest / filename
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
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

    A field of the wrong shape is a refusal, never a drop or a fetch. `files` and
    `plates` are the multi-name fields and the hub publishes each only as a
    non-empty object of `{label: filename}`; a string there (`"files":
    "assembled.stl"`) passes the file-name rule, so it is refused here rather than
    by the caller.
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


def _design_files(document: dict, where: str) -> list:
    """The files a KiCad document is published with, as `(field, filename)`.

    Only a schematic or a board has a `kicad`: a schematic's lists its
    `schematics`, itself first, and either names its `project` or null. A
    `kicad` that is not an object, or `schematics` that is not a list, is
    refused like every wrong shape here.
    """
    design = document.get("kicad")
    if design is None:
        return []
    if not isinstance(design, dict):
        raise _not_from_the_hub(f"the 'kicad' of {where}", design)
    schematics = design.get("schematics")
    if schematics is None:
        schematics = []
    if not isinstance(schematics, list):
        raise _not_from_the_hub(f"the 'kicad' of {where}", design)
    project = design.get("project")
    return [("schematic", name) for name in schematics] + (
        [("project", project)] if project is not None else [])


def _declared(meta: dict) -> list:
    """Every file the build declares, as `(where, field, filename)`, once each.

    Each entry says whose file it is (`part 'lid'`, `view 'assembled'`). Parts are
    walked in key order (a catalogue reads best alphabetically), views in the
    document's order (the author's tab order, as `render._view_parts` keeps it),
    and documents last, in the order project.json lists them.

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

    def take_documents(documents) -> None:
        if not isinstance(documents, list):
            raise _not_from_the_hub("the `documents` of this build", documents)
        for index, document in enumerate(documents):
            if not isinstance(document, dict):
                raise _not_from_the_hub(f"document #{index}", document)
            doc_id = document.get("id")
            where = (f"{DOCUMENT_WHERE}{doc_id!r}" if isinstance(doc_id, str)
                     else f"{DOCUMENT_WHERE}#{index}")
            for field, filename in _pointers(document, "document", where):
                take(where, field, filename)
            for field, filename in _design_files(document, where):
                take(where, field, filename)

    if meta.get("kind") == DOCUMENTS_KIND:
        take_documents(meta.get("documents"))
        return found

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
    # A model's build carries documents only when its project.json lists
    # them, so absent is the ordinary case and not a wrong shape.
    if meta.get("documents") is not None:
        take_documents(meta.get("documents"))
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
