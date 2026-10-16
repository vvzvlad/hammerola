"""`hammerola update` — the tool replacing itself with the hub's copy.

The hub is the only channel: it serves the client out of its own image
(`/start/hammerola`, public, built by `src/onboarding.py`), so client and hub
move together. Do not add a second source.

Unlike `skill update`, this writes the RUNNING PROGRAM, and a half-written file
would leave no tool to fetch a fix with. The download goes to a temporary file
beside the target with the target's mode, and `os.replace` swaps it in one step.

Before that, the download must be a zipapp (shebang plus zip,
`onboarding.CLIENT_SHEBANG`) that states a version, so a proxy's login page
never lands on PATH. The version printed comes from the archive. The manifest's
`client_version` is used by `refuse_if_behind`.
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
from hammerola.hub import HubError
from hammerola.sources import public_hub

# Manifest keys; a test compares them with `src/onboarding.py`.
CLIENT_KEY = "client"
VERSION_KEY = "client_version"

# A copy of the hub's `CLIENT_SHEBANG` (this package imports nothing from the
# service); a test compares them.
SHEBANG = b"#!/usr/bin/env python3\n"

# Where inside the archive each fact is read from, and the name it is assigned
# to. A future release may move them, which is why only the version is required.
VERSION_MEMBER = "hammerola/__init__.py"
VERSION_NAME = "VERSION"
CHANGELOG_MEMBER = "hammerola/changelog.py"
CHANGELOG_NAME = "ENTRIES"

UPDATE_HINT = "hammerola update"


def run(args) -> int:
    """Fetch the hub's client and become it. -> exit code.

    The target is resolved first: a checkout has nothing to write over.
    """
    target = _target()

    hub_url = config.hub_url(None)
    hub = public_hub(hub_url)
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
        # Written anyway; the line says the version did not move.
        print(f"  version {VERSION}, unchanged")
        return 0
    print(f"  version {VERSION} -> version {served}")
    _print_changes(entries, VERSION, served)
    return 0


def refuse_if_behind(hub_url: str, root=None) -> None:
    """Stop a client the hub has outgrown before it publishes anything.

    Asked only by `build` and `commit`: reading verbs fail loudly on their own,
    while a stale client's writes are what nobody undoes.

    A hub that cannot answer (unreachable, or no `client_version` in an older
    image) does not stop the push. Only BEHIND is refused, never ahead: a
    checkout newer than the hub is normal.

    Takes an address and uses `sources.public_hub` (`QUERY_TIMEOUT`), not the
    push's Hub with its five-minute `HTTP_TIMEOUT`. `root` is the project being
    published, where `public_hub` also looks for `HUB_BASIC_AUTH`.
    """
    try:
        manifest = public_hub(hub_url, root).start()
    except HubError:
        return
    served = manifest.get(VERSION_KEY)
    here, there = changelog.as_tuple(VERSION), changelog.as_tuple(served)
    if here is None or there is None or not here < there:
        return
    raise ClientError(
        f"this hammerola is version {VERSION} and {hub_url} serves version "
        f"{served}, so it is out of date. Nothing was published.\n"
        f"  `{UPDATE_HINT}` writes the hub's copy over this one and prints what "
        f"changed between the two.")


def _target() -> Path:
    """The file this program IS, and the only thing `update` writes.

    In a zipapp `__file__` is `<archive>/hammerola/update.py`, so two parents
    up is the file on PATH; in a checkout it is a directory.
    """
    running = Path(__file__).resolve().parent.parent
    if not running.is_file():
        raise ClientError(
            f"this hammerola is the package in {config.display_path(running)}, "
            f"not the one-file client the hub serves, so there is no single "
            f"file to write over. Nothing was fetched.\n"
            f"  A checkout is updated with git; "
            f"`{UPDATE_HINT}` is for the file `curl -o ~/.local/bin/hammerola` "
            f"wrote.")
    return running


def _read_client(hub_url: str, body: bytes):
    """(version, changelog entries) out of what the hub served, or refuse.

    -> (str, dict)

    The version is required: it is how the tool is told apart from anything
    else served with a 200. The changelog is optional, so a future release that
    drops that module stays installable.
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

    Parsed with `ast.literal_eval`, never executed: the file just came off the
    network. None for every way of not having the value.
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

    The temporary file is in the same directory (a cross-filesystem rename is
    an interruptible copy) and gets the target's mode, execute bit included.
    An unwritable target is a ClientError naming the file.
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
            # Survive a power loss between the write and the rename.
            os.fsync(writing.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, target)
    except OSError as error:
        _discard(temporary)
        raise ClientError(_unwritable(target, error)) from error


def _discard(path: str) -> None:
    """Take the half-written temporary away, and never raise over it."""
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

    Runs after the write; an empty changelog is a quiet success. The range is
    `changelog.between`'s.
    """
    moved = changelog.between(entries, old, new)
    if not moved:
        return
    print("what changed:")
    for version, lines in moved:
        for line in lines:
            print(f"  {version}: {line}")
