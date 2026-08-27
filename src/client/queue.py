"""`hammerola comments` and `comments resolve` — the queue, in a shell.

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

from src.client import config, project
from src.client.hub import QUERY_TIMEOUT, Hub

# The statuses the hub filters on (SPEC 7A.2). `None` asks for every one.
STATUS_OPEN = "open"

HINT = ("close one with: hammerola comments resolve <id> -m "
        "\"what was done about it\"")


def run(args) -> int:
    """`comments`, or `comments resolve` — whichever the parser reached."""
    if getattr(args, "comment_command", None) == "resolve":
        return resolve(args)
    return read(args)


def read(args) -> int:
    """Print this project's queue. -> exit code.

    An empty queue is a SUCCESS and says so: "nothing to do" is the answer the
    question has most of the time, and a non-zero exit for it would make every
    caller treat the normal case as a failure.
    """
    root = project.find_project_root(args.directory)
    pid = project.read_project_id(root)
    hub = _hub(root)

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
        _print_comment(hub, record)
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
    hub = _hub(None)
    record = hub.resolve_comment(args.id, getattr(args, "note", None))
    print(f"resolved {record.get('id', args.id)} at {record.get('resolved')}")
    if record.get("note"):
        print(f"  note: {record['note']}")
    return 0


def _hub(root) -> Hub:
    return Hub(config.hub_url(root), config.edit_token(root),
               timeout=QUERY_TIMEOUT)


def _print_comment(hub: Hub, record: dict) -> None:
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

    # The attachments are behind the same token as the queue, so what is printed
    # is the URL rather than the bytes: whoever is reading has the token, and a
    # photo of a printed part is not something a terminal can show anyway.
    for kind, label in (("photo", "photo"), ("shot", "frame")):
        if record.get(kind):
            print(f"  {label}: "
                  f"{hub.absolute(f'/api/v1/comments/{cid}/{kind}')}")
    if record.get("note"):
        print(f"  note: {record['note']}")
