"""`hammerola proposal` — read the one a person drew, and put it away.

A PROPOSAL IS A STATEMENT AND NOT AN EDIT. Somebody opened a published model in
the browser and assembled a rough body over it out of primitives — the motor the
bracket has to clear, the wall it bolts to, a bought part it holds — or dragged
a part of the build to where they want it. None of that is in the model, nothing
was built from it, and none of it is code to paste: what travels here is the
projection the panel renders, a few aligned lines saying how big each thing is
and where it sits, because that is a constraint an agent can design against and
"it is about four centimetres" is not (`ui/src/proposal.js`).

THERE IS ONE PER PROJECT AND IT STANDS. Unlike a comment it is never resolved —
it describes the world AROUND the part and goes on being true after the part
clears it, so this is read at the start of a session the way the queue is, and
a comment saying "make it clear the motor" usually means the motor is drawn
here with its size on it.

A PROJECT WITH NO PROPOSAL IS THE ORDINARY CASE AND EXITS ZERO. One exists only
after somebody drew it, so most projects have none; a non-zero exit for that
would make every caller treat the normal answer as a failure. `hub.proposal`
returns None rather than raising for exactly this reason.

`rm` ASKS BEFORE IT DOES IT, and the same way `hammerola rm` asks: the project
id has to be typed, not a y/n, because a y/n is answered by reflex. What is
behind this one is not a volume of builds but a DRAWING — a person made it by
hand, the hub keeps no copy, no build contains it and no revision can be
unpacked to get it back, so there is nothing anywhere that could bring it back.
`--yes` exists for a script, and it is the flag a person should have to think
about typing. EOF is a refusal and never an implicit yes: an agent cannot answer
the prompt, which is deliberate — the decision belongs to whoever drew the
thing.

THE PROMPT AND ITS TWO REFUSALS ARE A COPY OF `admin.py`'s, not an import of
them. The two commands unmake different things and say different sentences
about what cannot be brought back, and the shared part is four lines of `input`
handling; a common helper here would be a place for one command's wording to
start describing the other's.
"""

from hammerola import project
from hammerola.errors import ClientError
from hammerola.sources import hub_for

# What has to be typed to confirm a removal. The ID rather than a y/n, for the
# reason `admin.CONFIRM_PROMPT` gives: it is unambiguous, it is what the hub is
# addressed by, and it is printed above the prompt together with what is about
# to go — so confirming means having read it.
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
    if getattr(args, "proposal_command", None) == "rm":
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

    # READ BEFORE ASKING, because a prompt is only a safety if what it is
    # confirming has been seen. This is the whole of what is about to go — it
    # is a few lines — so it is printed rather than counted.
    record = hub.proposal(pid)
    print(f"about to remove the proposal on {pid}")
    if record is None:
        # Said before the prompt rather than turned into an early exit, exactly
        # as `admin.remove` says that the hub lists no builds: it changes what
        # is being confirmed, and the answer to "was there one" comes from the
        # hub's own reply to the DELETE below.
        print("  the hub has nothing stored under this id.")
    else:
        print(f"  saved {record.get('saved')}")
        _print_text(record)
    print("  this cannot be undone: somebody drew it by hand, the hub keeps no "
          "copy, and it is in\n"
          "  no build — so nothing can bring it back.")

    _confirm(pid, getattr(args, "yes", False))

    if hub.remove_proposal(pid):
        print(f"removed the proposal on {pid}")
    else:
        # The hub answers the same 200 either way (`Hub.remove_proposal`), so
        # this is not a failure: what was asked for is true. It is said out loud
        # because "removed" over an empty store would be a claim about bytes
        # that were never there.
        print(f"no proposal was stored on {pid}, so nothing was removed")
    return 0


def _print_proposal(pid: str, record: dict) -> None:
    """Which project and when it was saved, then what it says."""
    print(f"proposal on {pid}  saved {record.get('saved')}")
    _print_text(record)


def _print_text(record: dict) -> None:
    """The text the hub stored, indented two spaces.

    INDENTED FOR THE REASON `queue._print_comment` INDENTS A COMMENT: it is
    several lines of somebody else's writing, and unindented it cannot be told
    from the tool's own output. The lines themselves are printed as the hub
    stored them — the panel aligned them into columns, and re-wrapping or
    re-spacing them here would throw that away.
    """
    text = record.get("text")
    if not isinstance(text, str) or not text.strip():
        # `text` IS NULL FOR A DOCUMENT THAT SAYS NOTHING — one with no nodes
        # in it, or one whose every node the reader ticked off
        # (`src/proposals.py`). There is a record and it is empty, which is not
        # the same answer as having none, so it gets a sentence of its own
        # rather than the word `None` printed where the numbers go.
        print("  it says nothing: either there is nothing drawn in it, or "
              "every node is ticked off.")
        return
    for line in text.splitlines():
        # A BLANK LINE STAYS BLANK. The projection separates its blocks with
        # empty lines, and indenting one prints two spaces and nothing else —
        # trailing whitespace in output somebody may paste, diff or grep.
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
