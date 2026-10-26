"""`hammerola skill` and `skill update` — the instructions, and whether they are stale.

The client, the template and the model contract fail loudly when stale (a
stale client refuses to publish, see `update.py`); a stale skill fails
silently, teaching renamed commands and removed flags. This verb checks it.

It never checks by itself: nothing else in the tool looks at the agent's skills
directory, because the tool cannot know which copy of the skill an agent is
reading (plugin, project copy, ...). Nothing blocks a push on a stale skill.

No token: `/start` and the skill archive are public (`src/onboarding.py`).

The installed copy and the hub's are compared by `tree_digest`, a digest of
every file of the skill. The hub imports this same function for the manifest's
`skill_digest` (this package imports nothing from the service), so both sides
compute it one way and any change to any file of the skill changes it.
"""

import hashlib
import re
import sys
from pathlib import Path

from hammerola import config
from hammerola.errors import ClientError
from hammerola.hub import HubError
from hammerola.sources import public_hub
from hammerola.unpack import extract, read_members

# The DIRECTORY a Claude Code skill lives in: the hub serves `SKILL.md` and the
# `references/` beside it as one archive, and the entry document points at those
# references by relative path, so they land together or not at all.
DEFAULT_PATH = "~/.claude/skills/hammerola"

# The entry document under that directory, whose frontmatter names the skill.
# The hub spells it too (`onboarding.SKILL_ENTRY`) and a test compares the two.
ENTRY = "SKILL.md"

# Manifest keys; a test compares them with `src/onboarding.py`.
SKILL_KEY = "skill"
DIGEST_KEY = "skill_digest"

# How many hex digits of a digest are printed: enough to tell two copies apart
# by eye, short enough to read.
SHOWN = 12

# The frontmatter block (no YAML parser in the stdlib).
_FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)

# What makes an installed document OURS rather than somebody else's skill with
# the same file name: the `name:` a Claude Code skill is addressed by, which is
# this one's. It decides whether a directory may be written into and swept
# (`_prune`), so it reads the name and not merely the presence of a frontmatter.
# `tests/test_onboarding.py` holds it against the document the hub serves.
OUR_NAME = "hammerola"
_NAME_LINE = re.compile(rf"^name:[ \t]*{re.escape(OUR_NAME)}[ \t]*$",
                        re.MULTILINE)
# Any `name:` at all: a frontmatter that names a skill is somebody's skill, one
# that names none cannot be told from ours and is answered differently.
_ANY_NAME_LINE = re.compile(r"^name:", re.MULTILINE)

UPDATE_HINT = "hammerola skill update"


def run(args) -> int:
    """`skill`, or `skill update` — whichever the parser reached."""
    if args.skill_command == "update":
        return update(args)
    return show(args)


def show(args) -> int:
    """Say which copy is here and which the hub serves. -> exit code.

    Zero whenever the question is answered, stale or not installed included.
    Unreachable hub, missing address or unreadable file raise.
    """
    path = _path(args)
    text = _read(path / ENTRY)
    # Asked before anything is printed: it touches no network, and a document
    # that is not ours must not first be reported as our installation.
    refused = why_not_here(path, text)
    # Only our own installation is read whole: a refused `--path` may be
    # `~/.claude/skills` or somebody's folder.
    local = None if refused is not None or text is None else tree_digest(path)

    # The local half is printed before the network is touched.
    if refused is not None:
        print(f"found at {config.display_path(path)}, not an installation of "
              f"this skill")
    elif local is None:
        print(f"not installed: nothing at {config.display_path(path / ENTRY)}")
    else:
        print(f"digest {local[:SHOWN]} installed at "
              f"{config.display_path(path)}")
    sys.stdout.flush()

    hub_url = config.hub_url(None)
    served = _served_digest(hub_url)
    print(f"digest {served[:SHOWN]} served by {hub_url}")

    if refused is not None:
        # `update` refuses this directory, so do not send anybody at it.
        print(f"`{UPDATE_HINT}` will not write here: {refused}")
    elif local == served:
        print("up to date")
    elif local is None:
        print(f"`{UPDATE_HINT}` installs it")
    else:
        print(f"out of date. `{UPDATE_HINT}` writes the hub's copy over it")
    return 0


def update(args) -> int:
    """Fetch the hub's copy and write it where a skill is read from. -> exit code.

    Overwrites the whole directory; the destination is printed and can be moved
    with `--path`. What comes back must be an archive carrying an `ENTRY`
    before anything is written, so a proxy's login page never lands as the
    agent's instructions.

    ONLY AN EMPTY DIRECTORY OR OUR OWN INSTALLATION IS WRITTEN INTO, anything
    else refused. Writing into somebody else's directory gains nothing, and the
    run after it would find our document there, read the place as ours and
    sweep their files — which is the same accident whether their directory held
    a skill of their own or no skill at all.
    """
    path = _path(args)
    before_text = _read(path / ENTRY)
    _refuse_a_place_of_somebody_elses(path, before_text)
    before = None if before_text is None else tree_digest(path)

    hub_url = config.hub_url(None)
    hub = public_hub(hub_url)
    manifest = hub.start()
    where = manifest.get(SKILL_KEY)
    if not isinstance(where, str) or not where:
        raise HubError(f"{hub_url} answered the start manifest without naming "
                       f"the skill.\n  Nothing was written.")
    body = hub.fetch_path(where)

    # Read whole before a single file is opened for writing: `read_members`
    # checks every member path against the same alphabet a push is held to and
    # touches no disk.
    served_from = f"the skill {hub_url} served"
    documents = read_members(body, served_from)
    entry = documents.get(ENTRY)
    if entry is None:
        raise ClientError(
            f"{hub_url} served an archive with no {ENTRY} in it, so it is not a "
            f"skill this can install.\n  Nothing was written.")

    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise ClientError(f"cannot create {path}: {error}") from error
    written = extract(body, path, served_from)

    print(f"wrote {len(written)} files to {config.display_path(path)}")

    # Only an installation of OURS is swept, decided by the name in the document
    # that was there BEFORE this write. `--path` one level up
    # (`~/.claude/skills`) or at somebody else's skill would otherwise have the
    # sweep take their files: the first is caught by there being no document of
    # ours, but the run after it would find the one we just wrote, and the
    # second has a `SKILL.md` of its own. A withdrawn reference, which is what
    # the sweep exists for, can only be in a directory that held our skill.
    removed = _prune(path, written) if is_ours(before_text) else []
    if removed:
        print(f"  removed {', '.join(removed)}, which this version "
              f"does not have")
    # Read once the sweep is done, so it is the digest `hammerola skill` finds.
    print(f"  {_moved(before, tree_digest(path))}")
    return 0


def _prune(directory: Path, written) -> list:
    """Delete what this version did not write, WHERE this version writes.

    A reference withdrawn in a later version would otherwise stay on disk,
    where an agent finds it with `ls` and reads a rule that was taken back as
    one that still stands — nothing about it looks stale, since the entry
    document beside it is current.

    Only the directories this archive itself writes into are swept — today the
    root and `references/`. The caller has established that the installation
    here was ours (`update` writes nowhere else at all), and this is the second
    line: a subdirectory nothing of ours lands in — `~/.claude/skills/konnect`
    under a mistyped `--path`, were the first line ever to let one through — is
    never descended into.

    Deepest first, so a directory is empty by the time it is tried; a directory
    that still holds something is one this version writes into and is kept. Only
    the FILES are returned: a directory emptied by them goes with them and is
    not worth a line of the answer.

    A symlink is removed as itself, never followed: `is_dir()` says yes to one
    that points at a directory, and `rmdir` would then ask about the target.
    """
    keep = {directory.joinpath(*name.split("/")) for name in written}
    # The directories the archive puts files in, as paths: `{directory,
    # directory/references}` for today's set.
    ours = {directory.joinpath(*name.split("/")).parent for name in written}
    removed = []
    for path in sorted(directory.rglob("*"), reverse=True):
        if path.is_dir() and not path.is_symlink():
            if path not in ours:
                continue
            try:
                path.rmdir()
            except OSError:
                # It still holds something, which is the ordinary case for the
                # directories this version itself wrote into.
                pass
            continue
        if path in keep or path.parent not in ours:
            continue
        try:
            path.unlink()
        except OSError as error:
            # Not a failed update: the skill itself is written, and the lines
            # above have said so. This is the one thing left undone, and it is
            # said out loud, because a withdrawn document nobody knows is still
            # there is exactly what this removal exists to prevent.
            print(f"  cannot remove {config.display_path(path)}: {error}")
            continue
        removed.append(path.relative_to(directory).as_posix())
    return sorted(removed)


def _refuse_a_place_of_somebody_elses(directory: Path, before_text) -> None:
    """Raise unless `directory` is ours to write into. -> None.

    Three ways in: it does not exist, it is empty, or the entry document in it
    is ours — and in none of them may its own name be the entry document's,
    which is the old `--path FILE` form. Everything else stops here, BEFORE the
    network, so a mistyped `--path` costs an error message and nothing on disk.

    The reason is the sweep: a directory we have written our document into
    reads as ours to the next run, which then removes what the archive does not
    have. Refusing the first write is what keeps somebody's notes, downloads or
    other skill out of that.

    An entry document of ours whose frontmatter cannot be read is refused too
    — it cannot be told from another skill's — and the message says what to do
    with it, because that one IS ours to delete.
    """
    reason = why_not_here(directory, before_text)
    if reason is not None:
        raise ClientError(f"{reason}\n  Nothing was written.")


def why_not_here(directory: Path, before_text):
    """Why `update` will not write into `directory`, or None when it will.

    One answer for both verbs: `skill update` refuses on it, and `skill` says
    it instead of recommending an update that would be refused.

    What is found is listed rather than summarised, because the cases that
    surprise are the ones `ls` shows as empty — a `.DS_Store` Finder left, an
    empty subdirectory — and the reader has to see what to clear.
    """
    shown = config.display_path(directory)
    if directory.name == ENTRY:
        # The form an older skill taught (`--path FILE`), on a machine where
        # the file is not there: without this it would become a DIRECTORY
        # named SKILL.md with the skill inside, which nothing reads.
        return (f"{shown} names the entry document, and `--path` names the "
                f"DIRECTORY it sits in: try `--path "
                f"{config.display_path(directory.parent)}`.")
    try:
        found = sorted(entry.name for entry in directory.iterdir())
    except FileNotFoundError:
        return None
    except OSError as error:
        return f"cannot read {shown}: {error}"
    if not found or is_ours(before_text):
        return None
    if before_text is None:
        listed = ", ".join(found[:5]) + (", ..." if len(found) > 5 else "")
        return (f"{shown} is not empty ({listed}) and holds no {ENTRY} of "
                f"this skill's.\n"
                f"  `--path` names the directory THIS skill is installed in: "
                f"one that does not exist yet, an empty one, or one holding "
                f"this skill's {ENTRY}. Writing here would put our documents "
                f"among somebody else's, and the next update would remove "
                f"those as stale.\n"
                f"  If {shown} is this skill's, delete that whole directory and "
                f"the update installs the skill into it fresh.")
    block = _FRONTMATTER.match(before_text)
    if block is None or _ANY_NAME_LINE.search(block.group(1)) is None:
        return (f"{config.display_path(directory / ENTRY)} names no skill, so "
                f"it cannot be told from another skill's.\n"
                f"  If {shown} is this skill's, delete that whole directory and "
                f"the update installs the skill into it fresh.")
    return (f"{config.display_path(directory / ENTRY)} is another skill's: its "
            f"frontmatter names something other than `{OUR_NAME}`.\n"
            f"  `--path` names the directory THIS skill is installed in.")


def is_ours(text) -> bool:
    """Whether an installed document is THIS skill's. Never raises.

    False for no text, no frontmatter and any other `name:`, so a directory
    holding somebody else's skill is never swept.
    """
    if text is None:
        return False
    block = _FRONTMATTER.match(text)
    if block is None:
        return False
    return _NAME_LINE.search(block.group(1)) is not None


def tree_digest(directory) -> str:
    """sha256 hex over every file `tree_files` lists under `directory`.

    Each file goes in as `<relative path>\\0<sha256 hex of its bytes>\\n`, in
    path order, so an edited, added, removed or renamed file changes the
    digest. The hub computes the manifest's `skill_digest` with this function
    over `skill/`, and `skill` over the installed copy.
    """
    digest = hashlib.sha256()
    for name, path in tree_files(directory):
        content = hashlib.sha256(path.read_bytes()).hexdigest()
        digest.update(f"{name}\0{content}\n".encode("utf-8"))
    return digest.hexdigest()


def tree_files(directory) -> list:
    """(relative POSIX path, path) for every file `tree_digest` covers, sorted.

    Regular files only, never a symlink, and nothing under a name that starts
    with `.`: macOS leaves `.DS_Store` in an installed directory, and the hub
    refuses to serve a hidden file in the skill (`onboarding.skill_bytes`).
    """
    root = Path(directory)
    found = []
    for path in root.rglob("*"):
        name = path.relative_to(root).as_posix()
        if (not path.is_file() or path.is_symlink()
                or any(part.startswith(".") for part in name.split("/"))):
            continue
        found.append((name, path))
    return sorted(found)


def _path(args) -> Path:
    """The DIRECTORY the skill is in. `--path` first, then the usual place."""
    return Path(args.path or DEFAULT_PATH).expanduser()


def _read(path: Path):
    """The installed entry document as text, or None when there is nothing there.

    NotADirectoryError is what `--path` naming the old single-file install
    gives: `<file>/SKILL.md` has a FILE where it needs a directory. It is said
    in those words rather than as the errno, because the reader's notes have
    the path that used to be right and nothing else here tells them the flag
    now takes a directory.
    """
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except NotADirectoryError as error:
        # Only when the file named IS an entry document is the directory above
        # it the install: `--path ~/notes.md` would otherwise be answered with
        # "try `--path ~`", which is a home directory to write a skill into.
        where = (f": try `--path {config.display_path(path.parent.parent)}`"
                 if path.parent.name == ENTRY else ".")
        raise ClientError(
            f"{config.display_path(path.parent)} is a file, and `--path` names "
            f"the DIRECTORY the skill is installed in, not a file in it"
            f"{where}") from error
    except IsADirectoryError as error:
        raise ClientError(f"{path} is a directory, not a skill file") from error
    except UnicodeDecodeError as error:
        # The way out is the DIRECTORY: removing only this file leaves the
        # references beside it, and a directory holding files and no entry
        # document is one `update` refuses in turn.
        raise ClientError(
            f"{config.display_path(path)} is not utf-8 text, so it is not a "
            f"skill file: {error}\n"
            f"  Both `hammerola skill` and `{UPDATE_HINT}` stop here. If "
            f"{config.display_path(path.parent)} is this skill's, delete that "
            f"whole directory and the update installs the skill into it "
            f"fresh.") from error
    except OSError as error:
        raise ClientError(f"cannot read {path}: {error}") from error


def _served_digest(hub_url: str) -> str:
    """The digest of the skill the hub ships. NO TOKEN — `/start` is public."""
    digest = public_hub(hub_url).start().get(DIGEST_KEY)
    if not isinstance(digest, str) or not digest:
        raise HubError(
            f"{hub_url} answered the start manifest without `{DIGEST_KEY}`, "
            f"so this cannot say whether the installed copy is current.")
    return digest


def _moved(before, after) -> str:
    """What the directory WAS, said in the same breath as what it now is."""
    if before is None:
        return f"nothing installed -> digest {after[:SHOWN]}"
    if before == after:
        return f"digest {before[:SHOWN]}, unchanged"
    return f"digest {before[:SHOWN]} -> digest {after[:SHOWN]}"
