"""`hammerola update` — the tool replacing itself with the hub's copy.

THE HUB IS THE ONLY CHANNEL, and that is issue #26's decision rather than a
starting point to build on. The client is served by the very hub it publishes
to, out of the image that hub runs (`/start/hammerola`, public, built by
`src/onboarding.py`), so the copy on a laptop and the half of the contract it
talks to move together and there is nothing to reconcile between an index, a
release page and a deployment. No second source is added here and none should
be: two channels would mean a client that can be newer than the hub it is
talking to for a reason nobody chose.

THE DIFFERENCE FROM `skill update`, whose shape this copies in every other
respect: that one writes a DOCUMENT into a directory nothing is reading at the
time, and this one writes the RUNNING PROGRAM. A half-written file there is a
stale skill; a half-written file here is a machine with no `hammerola` on it and
no way to fetch one, because the tool that fetches is the file that was being
written. So the download lands in a temporary file beside the target, wearing
the target's own mode, and `os.replace` puts it in place in a single step: the
program on PATH is the old one or the new one at every instant and never half of
either.

WHAT IS CHECKED BEFORE THE REPLACEMENT, for the same reason `skill update`
parses the document it is about to install: a hub answering with a proxy's login
page, or an error document carrying a 200, would otherwise land on PATH as the
tool. A zipapp is a shebang followed by a zip (`onboarding.CLIENT_SHEBANG`), and
the archive has to state a version — that last part is what makes it THIS
program rather than any zip somebody could serve.

THE VERSION IT REPORTS COMES OUT OF THE ARCHIVE and not out of the manifest, so
what is printed is what was actually written. The manifest's `client_version` is
a different job one route earlier: `refuse_if_behind`, which is what stops a
stale client from publishing at all and is the only reason this tool ever spends
a round trip on a question about itself.
"""

import ast
import io
import os
import stat
import tempfile
import zipfile
from pathlib import Path

from hammerola import VERSION, changelog, config
from hammerola.errors import ClientError
from hammerola.hub import QUERY_TIMEOUT, Hub, HubError

# The two manifest keys this follows: where the client is, and which version the
# hub serves. Constants rather than literals at the call sites, for the reason
# `skill.SKILL_KEY` is one — both sides of the contract live in this repository,
# and a test compares these strings against `src/onboarding.py`'s own.
CLIENT_KEY = "client"
VERSION_KEY = "client_version"

# What a zipapp begins with, byte for byte the hub's `CLIENT_SHEBANG`. A second
# copy for the reason `skill.py` carries a second copy of the frontmatter
# patterns: this package may import nothing from the serving half. The
# duplication is held by a test rather than by care.
SHEBANG = b"#!/usr/bin/env python3\n"

# Where inside the archive each fact is read from, and the name it is assigned
# to. Both name members of THIS package as it will be after the update, so a
# release that moved either is one an older client cannot read — which is
# exactly why only the version is required and the changelog is not.
VERSION_MEMBER = "hammerola/__init__.py"
VERSION_NAME = "VERSION"
CHANGELOG_MEMBER = "hammerola/changelog.py"
CHANGELOG_NAME = "ENTRIES"

UPDATE_HINT = "hammerola update"


def run(args) -> int:
    """Fetch the hub's client and become it. -> exit code.

    THE TARGET IS RESOLVED FIRST, before anything is fetched: a copy running out
    of a checkout has nothing this can write over, and finding that out after a
    download would be the same refusal a second later.
    """
    target = _target()

    hub_url = config.hub_url(None)
    # NO TOKEN, exactly as `skill` presents none: `/start` and the file it names
    # are public on purpose, and a machine whose client is too old to publish
    # may well be one that was never logged in.
    hub = Hub(hub_url, "", timeout=QUERY_TIMEOUT)
    manifest = hub.start()
    where = manifest.get(CLIENT_KEY)
    if not isinstance(where, str) or not where:
        raise HubError(f"{hub_url} answered the start manifest without naming "
                       f"the client.\n  Nothing was written.")
    body = hub.fetch_path(where)
    served, entries = _read_client(hub_url, body)

    _write_over(target, body)

    print(f"wrote {config.display_path(target)}")
    if served == VERSION:
        # It writes anyway — the verb is "make this the hub's copy", not "apply
        # a difference" — and saying the version did not move keeps a re-run
        # from reading as though it had fixed something.
        print(f"  version {VERSION}, unchanged")
        return 0
    print(f"  version {VERSION} -> version {served}")
    _print_changes(entries, VERSION, served)
    return 0


def refuse_if_behind(hub) -> None:
    """Stop a client the hub has outgrown before it publishes anything.

    TWO VERBS ASK AND NOT EVERY VERB, and what decides that is the cost: this is
    one more round trip, paid before the push itself. `status`, `log`,
    `comments`, `source` and `artifacts` READ, and a client a version behind
    reads them well enough or fails loudly on its own; what a stale client does
    that nobody undoes is WRITE. So the question is asked where the writing is,
    and `build` and `commit` are the whole of that list.

    A HUB THAT DOES NOT ANSWER THE QUESTION DOES NOT STOP THE PUSH. An image
    older than this tool carries no `client_version` in its manifest at all, and
    a hub that cannot be reached is about to be reported by the push itself with
    the message that path already has. Neither is evidence that this client is
    stale, and refusing on either would make a hub that is down look like a
    laptop that is out of date.

    ONLY BEHIND IS REFUSED AND NEVER AHEAD. The author's own checkout is
    routinely newer than the hub it pushes to — that is what publishing a new
    image looks like from this side — and the answer to that direction is
    updating the hub, which is not something this can do or should mention.
    """
    try:
        manifest = hub.start()
    except HubError:
        return
    served = manifest.get(VERSION_KEY)
    here, there = changelog.as_tuple(VERSION), changelog.as_tuple(served)
    if here is None or there is None or not here < there:
        return
    raise ClientError(
        f"this hammerola is version {VERSION} and {hub.url} serves version "
        f"{served}, so it is out of date. Nothing was published.\n"
        f"  `{UPDATE_HINT}` writes the hub's copy over this one and prints what "
        f"changed between the two.")


def _target() -> Path:
    """The file this program IS, and the only thing `update` writes.

    A zipapp is imported out of the archive itself, so `__file__` here reads
    `<archive>/hammerola/update.py` and two parents up is the single file on
    PATH. Under either other door those same two parents land on a DIRECTORY —
    the package inside a checkout, or inside site-packages — which is what tells
    the doors apart without asking anything about how the process was started.
    """
    running = Path(__file__).resolve().parent.parent
    if not running.is_file():
        raise ClientError(
            f"this hammerola is the package in {config.display_path(running)}, "
            f"not the one-file client the hub serves, so there is no single "
            f"file to write over. Nothing was fetched.\n"
            f"  A checkout is updated with git and an installed copy with pip; "
            f"`{UPDATE_HINT}` is for the file `curl -o ~/.local/bin/hammerola` "
            f"wrote.")
    return running


def _read_client(hub_url: str, body: bytes):
    """(version, changelog entries) out of what the hub served, or refuse.

    -> (str, dict)

    THE VERSION IS REQUIRED AND THE CHANGELOG IS NOT, and the asymmetry is the
    point. Reading a version is how this tells the tool from anything else that
    could arrive with a 200, so a file it cannot read one out of is refused
    before it can land on PATH. The changelog is what the update SAYS
    afterwards; a future release that renames or drops that module would
    otherwise make itself uninstallable by every client alive today, which is a
    trap laid for the one version nobody can test against.
    """
    if not body.startswith(SHEBANG):
        raise ClientError(
            f"{hub_url} served something that does not begin with the client's "
            f"shebang, so it is not the tool.\n  Nothing was written.")
    try:
        archive = zipfile.ZipFile(io.BytesIO(body[len(SHEBANG):]))
    except zipfile.BadZipFile as error:
        raise ClientError(
            f"{hub_url} served a file that is not a zipapp: {error}\n"
            f"  Nothing was written.") from error

    version = _member_value(archive, VERSION_MEMBER, VERSION_NAME)
    if changelog.as_tuple(version) is None:
        raise ClientError(
            f"{hub_url} served a file this cannot read a version out of, so "
            f"there is no telling what it is.\n  Nothing was written.")
    entries = _member_value(archive, CHANGELOG_MEMBER, CHANGELOG_NAME)
    return version, entries if isinstance(entries, dict) else {}


def _member_value(archive: zipfile.ZipFile, member: str, name: str):
    """The literal a module in the archive assigns to `name`, or None.

    PARSED AND NEVER EXECUTED. What is wanted is two constants out of a file
    that has just come off the network, and importing it to get them would run
    the whole download to answer a question asked BEFORE deciding whether to
    install it. `ast.literal_eval` reads the value of the assignment and nothing
    else in the module.

    None for every way of not having the value — no such member, not text, not
    parseable, no such assignment, an expression that is not a literal — because
    each caller does the same thing with all of them: the version's absence is a
    refusal, the changelog's is silence.
    """
    try:
        source = archive.read(member).decode("utf-8")
    except (KeyError, UnicodeDecodeError, zipfile.BadZipFile):
        return None
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(target, ast.Name) and target.id == name
                   for target in node.targets):
            continue
        try:
            return ast.literal_eval(node.value)
        except (ValueError, TypeError):
            return None
    return None


def _write_over(target: Path, body: bytes) -> None:
    """Put `body` in `target`'s place, all at once or not at all.

    THE PROPERTY THIS BUYS is that there is no instant at which the file on PATH
    is half a program — and the machine it is protecting is the one that cannot
    fetch a replacement, since the tool that fetches is the file being written.
    The bytes go to a temporary file in the SAME directory, because a rename
    across filesystems is a copy and copies are interruptible; the target's own
    mode goes on it, the EXECUTE BIT above all, a client that lost that being as
    unusable as a truncated one; and `os.replace` swaps the two names in one
    step.

    WHAT IT REFUSES RATHER THAN TRACEBACKS THROUGH is a target that cannot be
    written. A client installed under a directory the account does not own is
    the ordinary case of that, and what it has to produce is one sentence naming
    the file, not an OSError out of a temporary-file helper.
    """
    try:
        mode = stat.S_IMODE(target.stat().st_mode)
        handle, temporary = tempfile.mkstemp(dir=str(target.parent),
                                             prefix=target.name + ".",
                                             suffix=".new")
    except OSError as error:
        raise ClientError(_unwritable(target, error)) from error
    try:
        with os.fdopen(handle, "wb") as writing:
            writing.write(body)
            writing.flush()
            # So that a machine losing power between the write and the rename
            # comes back to one of the two whole programs rather than to a name
            # pointing at nothing.
            os.fsync(writing.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, target)
    except OSError as error:
        _discard(temporary)
        raise ClientError(_unwritable(target, error)) from error


def _discard(path: str) -> None:
    """Take the half-written temporary away, and never raise over it.

    It is already being reported that the update did not happen; a second
    failure while tidying up would replace that sentence with a worse one.
    """
    try:
        os.unlink(path)
    except OSError:
        pass


def _unwritable(target: Path, error) -> str:
    """The refusal, said the same way whichever step of the write failed."""
    return (f"cannot write over {config.display_path(target)}: {error}\n"
            f"  Nothing was written and the client that is running is "
            f"untouched. The download was already fetched and checked, so what "
            f"is in the way is the file's own permissions or its directory's — "
            f"a copy installed where this account cannot write has to be "
            f"replaced by whoever owns it.")


def _print_changes(entries, old: str, new: str) -> None:
    """What the new client does differently, for the agent that has to use it.

    AFTER THE WRITE AND NEVER INSTEAD OF IT: the update has happened by the time
    this runs, so a changelog with nothing to say is a quiet success and not a
    failure to explain one. What it prints is the entries STRICTLY between the
    two versions — see `changelog.between` for why that is the only honest
    range.
    """
    moved = changelog.between(entries, old, new)
    if not moved:
        return
    print("what changed:")
    for version, lines in moved:
        for line in lines:
            print(f"  {version}: {line}")
