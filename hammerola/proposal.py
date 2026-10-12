"""`hammerola proposal` — read the one a person drew, and put it away.

A proposal is a rough body somebody assembled over a published model in the
browser (the motor a bracket must clear, the wall it bolts to) or a part they
dragged. It is not in the model; what travels here is the projection the panel
renders: aligned lines giving each thing's size and position
(`ui/src/proposal.js`).

One per project, never resolved: it describes the world around the part, so
read it at the start of a session along with the comment queue. A project with
no proposal is the ordinary case and exits zero (`hub.proposal` returns None).

`rm` asks like `hammerola rm`: the project id must be typed, because the
drawing exists nowhere else. `--yes` is for scripts; EOF is a refusal, so an
agent cannot answer the prompt. The prompt is deliberately a copy of
`admin.py`'s, since the two commands say different things.
"""

from hammerola import project
from hammerola.errors import ClientError
from hammerola.sources import hub_for

# The id rather than y/n, as in `admin.CONFIRM_PROMPT`.
CONFIRM_PROMPT = ("type the project id to remove its proposal "
                  "(anything else cancels): ")

_NOTHING_TO_READ = (
    "`hammerola proposal rm` asks for confirmation on the terminal and there "
    "is nothing to read.\n"
    "  Pass `--yes` to remove without being asked — but somebody drew this by "
    "hand, the hub keeps\n"
    "  no copy and no build contains it, so nothing can bring it back. Ask "
    "whoever drew it.")


def run(args) -> int:
    """`proposal` or `proposal rm` — whichever the parser reached."""
    if args.proposal_command == "rm":
        return remove(args)
    return read(args)


def read(args) -> int:
    """Print this project's proposal. -> exit code."""
    root = project.find_project_root(args.directory)
    pid = project.read_project_id(root)
    hub = hub_for(root)

    record = hub.proposal(pid)
    if record is None:
        print(f"no proposal on {pid}")
        return 0
    _print_proposal(pid, record)
    return 0


def remove(args) -> int:
    """Delete this project's proposal, after confirmation. -> exit code."""
    root = project.find_project_root(args.directory)
    pid = project.read_project_id(root)
    hub = hub_for(root)

    # Read and printed before asking, so the prompt confirms something seen.
    record = hub.proposal(pid)
    print(f"about to remove the proposal on {pid}")
    if record is None:
        # Not an early exit: the DELETE's reply is what says whether there
        # was one.
        print("  the hub has nothing stored under this id.")
    else:
        print(f"  saved {record.get('saved')}")
        _print_text(record)
    print("  this cannot be undone: somebody drew it by hand, the hub keeps no "
          "copy, and it is in\n"
          "  no build — so nothing can bring it back.")

    _confirm(pid, args.yes)

    if hub.remove_proposal(pid):
        print(f"removed the proposal on {pid}")
    else:
        # The hub answers 200 either way (`Hub.remove_proposal`).
        print(f"no proposal was stored on {pid}, so nothing was removed")
    return 0


def _print_proposal(pid: str, record: dict) -> None:
    """Which project and when it was saved, then what it says."""
    print(f"proposal on {pid}  saved {record.get('saved')}")
    _print_text(record)


def _print_text(record: dict) -> None:
    """The text the hub stored, indented two spaces.

    Indented so it is distinguishable from the tool's own output; otherwise
    printed as stored, since the panel aligned it into columns.
    """
    text = record.get("text")
    if not isinstance(text, str) or not text.strip():
        # `text` is null for a document with no nodes or with every node
        # ticked off (`src/proposals.py`): a record, but empty.
        print("  it says nothing: either there is nothing drawn in it, or "
              "every node is ticked off.")
        return
    for line in text.splitlines():
        # A blank line stays blank: no trailing whitespace.
        print(f"  {line}" if line else "")


def _confirm(pid: str, skip: bool) -> None:
    """Make the person say the id out loud, unless they passed `--yes`."""
    if skip:
        return
    try:
        answer = input(CONFIRM_PROMPT).strip()
    except EOFError as error:
        raise ClientError(_NOTHING_TO_READ) from error
    if answer != pid:
        raise ClientError("cancelled: that is not the project id. The proposal "
                          "is still there.")
