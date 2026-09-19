"""The comment queue in a shell: `comments`, `resolve` and `files`.

WHY A CLI VERB WHEN AN MCP SERVER FOR THE SAME QUEUE IS ALREADY DESIGNED
(SPEC 7A.5). The objection "two interfaces to one set of data" does not apply
here, because there is one INTERFACE — the HTTP API in `src/app.py` — and these
are two TRANSPORTS over it. What is harmful is two implementations of the rules
drifting apart; nothing here decides anything, it prints what the hub returned.
And MCP only works where an MCP client is: from a shell, from a script, from
somebody else's agent, it is not.

THE OUTPUT IS FOR AN AGENT READING A TERMINAL, which decides its shape: one
line per comment starting with the id it will need for `resolve`, then the
where-and-what indented under it, then the text — indented too, so that a
comment somebody wrote as three paragraphs cannot be mistaken for three
comments. The text comes from a STRANGER's keyboard (SPEC 7A.4), and the hub
has already refused control characters in it, which is what makes printing it
here safe.

DEFAULT IS THE OPEN ONES. A queue is read to find what still needs doing, and
resolved items pile up forever — nothing deletes them (SPEC 5.3). `--all` is
there for the times the question is "what did we already answer".
"""

from pathlib import Path

from hammerola import project
from hammerola.errors import ClientError
from hammerola.sources import hub_for, scratch_dir

# The statuses the hub filters on (SPEC 7A.2). `None` asks for every one.
STATUS_OPEN = "open"

HINT = ("close one with: hammerola comments resolve <id> -m "
        "\"what was done about it\"")

# The two attachments a comment can carry, as the record spells each one and as
# this tool says it out loud: `shot` is the viewer's render of what the person
# was looking at, and "frame" is what that is called to a reader.
PHOTO_KIND = "photo"
ATTACHMENTS = ((PHOTO_KIND, "photo"), ("shot", "frame"))

# The extensions the hub stores an attachment under. A fourth copy of one
# decision, so it is pinned to the hub's own by
# `test_the_client_takes_exactly_the_extensions_the_hub_stores` rather than by
# this comment: drift here refuses a real photo and blames the hub for it.
ATTACHMENT_EXTENSIONS = ("jpg", "png", "webp")


def run(args) -> int:
    """`comments`, `resolve` or `files` — whichever the parser reached."""
    command = getattr(args, "comment_command", None)
    if command == "resolve":
        return resolve(args)
    if command == "files":
        return files(args)
    return read(args)


def read(args) -> int:
    """Print this project's queue. -> exit code.

    An empty queue is a SUCCESS and says so: "nothing to do" is the answer the
    question has most of the time, and a non-zero exit for it would make every
    caller treat the normal case as a failure.
    """
    root = project.find_project_root(args.directory)
    pid = project.read_project_id(root)
    hub = hub_for(root)

    status = None if getattr(args, "all", False) else STATUS_OPEN
    records = hub.comments(pid, status=status,
                           since=getattr(args, "since", None))

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

    NO PROJECT IS NEEDED and none is looked for: a comment id is unique across
    the whole hub, so this works from any directory — which is the point, since
    whoever is closing an item is often not sitting in the model that produced
    it. `read` above needs a project because a QUEUE belongs to one.
    """
    hub = hub_for(None)
    record = hub.resolve_comment(args.id, getattr(args, "note", None))
    print(f"resolved {record.get('id', args.id)} at {record.get('resolved')}")
    if record.get("note"):
        print(f"  note: {record['note']}")
    return 0


def files(args) -> int:
    """Save one comment's attachments to disk. -> exit code.

    THE BYTES AND NOT THE URL, which is the whole reason this verb exists. The
    route serving an attachment takes `EDIT_TOKEN` like the queue itself, so a
    reader handed the URL could only open it by digging the secret out of the
    configuration and calling something else with it — and the photo of the
    printed part is the strongest evidence there is about a model, so it was
    always going to be opened.

    NO PROJECT IS LOOKED FOR, exactly as in `resolve` above and for the same
    reason: a comment id is unique across the hub.
    """
    hub = hub_for(None)
    record = hub.comment(args.id)
    cid = record.get("id", args.id)

    # THE SAME TEST THE LISTING MAKES, and it has to stay the same one: read
    # differently, the two halves of this file would disagree about which
    # attachments a comment has — one printing a name the other refuses.
    wanted = [(kind, label, _local_name(cid, kind, record[kind]))
              for kind, label in ATTACHMENTS if record.get(kind)]
    if not wanted:
        # A SUCCESS, for the reason `read` states about an empty queue: most
        # comments carry no photo, so a non-zero exit here would make the
        # ordinary answer look like a failure.
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

    The record names the file the hub stored — `<id>.jpg`, `<id>.shot.png`
    (`src/comments.py:_attachment_name`) — and that string is not joined onto a
    path: only its extension is taken, and only from the set the hub stores.
    Anything else is refused rather than skipped, in the same tone
    `hammerola/artifacts.py` refuses a file name it was handed: the case is an
    answer that did not come from a hub that wrote the file, and a photo missing
    from a directory reported as complete is the outcome worth avoiding.
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

    Under `.hammerola/` and not the working copy, for the reason
    `sources.SCRATCH_DIR` gives: a photo dropped next to model.py is a file the
    next push tries to publish. ONE FLAT DIRECTORY FOR EVERY COMMENT, unlike
    `artifacts` — the names carry the comment id, so two comments cannot collide
    and nothing is gained by a directory per id.
    """
    base = Path(args.directory).expanduser() if args.directory else Path.cwd()
    given = getattr(args, "output", None)
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

    # WHERE, on one line: which build, which part, which view, which point. All
    # four are optional except the build — a comment left without clicking a
    # part carries none of the rest — so the line is assembled rather than
    # formatted, or an ordinary comment prints three empty labels.
    where = [f"build {record.get('commit')}"]
    if record.get("part"):
        where.append(f"part {record['part']}")
    if record.get("view"):
        where.append(f"view {record['view']}")
    point = record.get("point")
    if isinstance(point, list) and len(point) == 3:
        where.append("at " + " ".join(f"{float(v):.1f}" for v in point))
    print(f"  {'  '.join(where)}")

    for line in str(record.get("text", "")).splitlines() or [""]:
        print(f"  {line}")

    # WHICH ATTACHMENTS THERE ARE AND THE COMMAND THAT FETCHES THEM, on one
    # line, where the URL that serves them used to be. Both are behind the same
    # token as the queue, and a reader given the URL has no way to open it but
    # to take the secret out of the configuration and hand it to something else
    # — which is exactly what a reader did. The bytes cannot be shown in a
    # terminal either way, so the useful half is the next command to run.
    present = [label for kind, label in ATTACHMENTS if record.get(kind)]
    if present:
        print(f"  attachments: {', '.join(present)} -> "
              f"hammerola comments files {cid}")
    if record.get("note"):
        print(f"  note: {record['note']}")
