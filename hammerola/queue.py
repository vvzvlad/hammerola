"""The comment queue in a shell: `comments`, `resolve` and `files`.

A transport over the HTTP API in `src/app.py` (alongside the MCP design in
SPEC 7A.5); nothing here decides anything, it prints what the hub returned.

The output is for an agent reading a terminal: one line per comment starting
with the id `resolve` needs, then where and what, then the text, all indented
so a multi-paragraph comment is not read as several. The text is a stranger's
(SPEC 7A.4); the hub has already refused control characters in it.

Default is the open ones: resolved items are never deleted (SPEC 5.3). `--all`
lists them too.
"""

from pathlib import Path

from hammerola import project
from hammerola.errors import ClientError
from hammerola.sources import hub_for, scratch_dir

# The statuses the hub filters on (SPEC 7A.2). `None` asks for every one.
STATUS_OPEN = "open"

HINT = ("close one with: hammerola comments resolve <id> -m "
        "\"what was done about it\"")

# (record key, label): `shot` is the viewer's render of what the person was
# looking at, shown as "frame".
PHOTO_KIND = "photo"
ATTACHMENTS = ((PHOTO_KIND, "photo"), ("shot", "frame"))

# The extensions the hub stores an attachment under; a copy pinned to the hub's
# by `test_the_client_takes_exactly_the_extensions_the_hub_stores`.
ATTACHMENT_EXTENSIONS = ("jpg", "png", "webp")

# The frames of a comment on a document whose place is not a part's point
# (`FRAMES` in src/comments.py): a schematic's sheet, a board, a markdown text.
DOCUMENT_FRAMES = ("sheet", "board", "text")


def run(args) -> int:
    """`comments`, `resolve` or `files` — whichever the parser reached."""
    command = args.comment_command
    if command == "resolve":
        return resolve(args)
    if command == "files":
        return files(args)
    return read(args)


def read(args) -> int:
    """Print this project's queue. -> exit code.

    An empty queue is a success: it is the usual answer.
    """
    root = project.find_project_root(args.directory)
    pid = project.read_project_id(root)
    hub = hub_for(root)

    status = None if args.all else STATUS_OPEN
    records = hub.comments(pid, status=status, since=args.since)

    if not records:
        which = "comments" if status is None else "open comments"
        print(f"no {which} on {pid}")
        if status is not None:
            print("  (`--all` also lists the ones already resolved)")
        return 0

    which = "comment" if len(records) == 1 else "comments"
    print(f"{len(records)} {which} on {pid}")
    for record in records:
        print()
        _print_comment(record)
    if any(r.get("status") == STATUS_OPEN for r in records):
        print()
        print(HINT)
    return 0


def resolve(args) -> int:
    """Close one comment, with an optional note. -> exit code.

    No project is needed: a comment id is unique across the hub, so this works
    from any directory.
    """
    hub = hub_for(None)
    record = hub.resolve_comment(args.id, args.note)
    print(f"resolved {record.get('id', args.id)} at {record.get('resolved')}")
    if record.get("note"):
        print(f"  note: {record['note']}")
    return 0


def files(args) -> int:
    """Save one comment's attachments to disk. -> exit code.

    The bytes, not the URL: the attachment route needs `EDIT_TOKEN`, so a URL
    would push the reader to dig the secret out of the configuration. No
    project is needed, as in `resolve`.
    """
    hub = hub_for(None)
    record = hub.comment(args.id)
    cid = record.get("id", args.id)

    # The same test `_print_comment` makes, so the two agree.
    wanted = [(kind, label, _local_name(cid, kind, record[kind]))
              for kind, label in ATTACHMENTS if record.get(kind)]
    if not wanted:
        # A success: most comments carry no photo.
        print(f"no photo or frame on {cid}")
        return 0

    dest = _destination(args)
    dest.mkdir(parents=True, exist_ok=True)
    print(f"{cid} -> {dest}")
    for kind, label, name in wanted:
        body = hub.comment_attachment(cid, kind)
        target = dest / name
        try:
            target.write_bytes(body)
        except OSError as error:
            raise ClientError(f"cannot write {target}: {error}") from error
        print(f"  {label:<6} {name}  {len(body) / 1e3:.1f} kB")
    return 0


def _local_name(cid: str, kind: str, declared) -> str:
    """The name to write, composed HERE out of the id and the extension.

    The record names the stored file (`<id>.jpg`, `<id>.shot.png`,
    `src/comments.py:_attachment_name`); that string is never joined onto a
    path, only its extension is taken, and only from the set the hub stores.
    Anything else is refused rather than skipped.
    """
    extension = (declared.rpartition(".")[2].lower()
                 if isinstance(declared, str) else None)
    if extension not in ATTACHMENT_EXTENSIONS:
        raise ClientError(
            f"the comment names its {kind!r} {declared!r}, which is not a file "
            f"this hub stores.\n"
            f"  It writes one of {', '.join(ATTACHMENT_EXTENSIONS)}, so this "
            f"record did not come from a hub that kept the bytes.")
    if kind == PHOTO_KIND:
        return f"{cid}.{extension}"
    return f"{cid}.{kind}.{extension}"


def _destination(args) -> Path:
    """Where the attachments land: `-o DIR`, or `.hammerola/comments/`.

    Under `.hammerola/` so the next push does not pick it up
    (`sources.SCRATCH_DIR`). One flat directory: the names carry the comment id.
    """
    base = Path(args.directory).expanduser() if args.directory else Path.cwd()
    given = args.output
    if given:
        dest = Path(given).expanduser()
    else:
        dest = scratch_dir(base, "comments")
    return dest if dest.is_absolute() else (base / dest).resolve()


def _print_comment(record: dict) -> None:
    """One queue entry: what it is about, then what it says."""
    cid = record.get("id", "?")
    state = record.get("status", "?")
    stamp = (f"resolved {record.get('resolved')}" if state != STATUS_OPEN
             else f"open, written {record.get('created')}")
    print(f"{cid}  {stamp}")

    # Where, on one line: build, the variant of a comment on a variant's dev
    # slot (none for the default one), then the document a comment was left
    # on, if any, and the place in it (`_document_place`); else the optional
    # part, view, point and the face normal. With `frame: "part"` the point
    # and the normal are in the part's own frame, which every view of the
    # build shares; without it, in the world of the view named.
    where = [f"build {record.get('commit')}"]
    if record.get("variant"):
        where.append(f"variant {record['variant']}")
    if record.get("doc"):
        where.append(f"doc {record['doc']}")
    if record.get("doc") and record.get("frame") in DOCUMENT_FRAMES:
        where += _document_place(record)
    else:
        where += _model_place(record)
    print(f"  {'  '.join(where)}")

    for line in str(record.get("text", "")).splitlines() or [""]:
        print(f"  {line}")

    # Which attachments exist and the command that fetches them (not the URL,
    # which needs the token; see `files`).
    present = [label for kind, label in ATTACHMENTS if record.get(kind)]
    if present:
        print(f"  attachments: {', '.join(present)} -> "
              f"hammerola comments files {cid}")
    if record.get("note"):
        print(f"  note: {record['note']}")


def _document_place(record: dict) -> list:
    """Where in a document: a schematic's sheet, a board's layer, the area
    drawn in the document's millimetres and what is in it, or a quoted
    passage with the characters around it. Newlines in the quote are written
    `\\n`, so the place stays one line."""
    place = []
    if record.get("sheet"):
        place.append(f"sheet {record['sheet']}")
    if record.get("layer"):
        place.append(f"layer {record['layer']}")
    area = record.get("area")
    if isinstance(area, list) and len(area) == 4:
        place.append("area " + " ".join(f"{float(v):.1f}" for v in area)
                     + " mm")
    if record.get("items"):
        place.append("near " + ", ".join(record["items"]))
    quote = record.get("quote")
    if isinstance(quote, dict):
        passage = (f"{quote.get('before', '')}[{quote.get('text', '')}]"
                   f"{quote.get('after', '')}").replace("\n", "\\n")
        place.append(f'quote "{passage}"')
    return place


def _model_place(record: dict) -> list:
    """Where on the model, or on a part of a document: the part, the view,
    the point and the face normal."""
    where = []
    if record.get("part"):
        where.append(f"part {record['part']}")
    if record.get("view"):
        where.append(f"view {record['view']}")
    point = record.get("point")
    if isinstance(point, list) and len(point) == 3:
        frame = " (part coords)" if record.get("frame") == "part" else ""
        where.append("at " + " ".join(f"{float(v):.1f}" for v in point) + frame)
    # The outward normal of the face that was clicked: which side of the part
    # the comment is on.
    normal = record.get("normal")
    if isinstance(normal, list) and len(normal) == 3:
        where.append("facing " + " ".join(f"{float(v):.2f}" for v in normal))
    return where
