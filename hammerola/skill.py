"""`hammerola skill` and `skill update` — the instructions, and whether they are stale.

WHY THIS VERB EXISTS AT ALL. Four things in this system are versioned: the
client, the template, the model contract and the skill. The first three break
LOUDLY — a stale contract fails the build, and a stale client refuses to publish
and names the command that replaces it (`update.py`, issue #77, which is what
made that half of this sentence true rather than merely written down). The skill
is the one that fails in silence: it goes on confidently teaching
a command that was renamed, a flag that went away, a ceiling that was raised,
and the agent reading it then gets a refusal whose cause is a file on its own
disk. Nothing goes red. That cost has already been paid in real prints
(issue #51), which is what bought this verb.

WHAT IT DELIBERATELY DOES NOT DO IS CHECK BY ITSELF. No look at the version
inside `build`, `commit` or `status`, no line printed on every run, and nothing
in this tool touches the agent's skills directory unless somebody typed the word
`skill`. Two reasons, and the second is the load-bearing one: a line on every
run is a line every reader learns to skip, and THIS TOOL CANNOT KNOW WHICH SKILL
AN AGENT IS READING — the path below is a default, an agent may be running from
a plugin, a project-scoped copy, or a file it was handed. So the command answers
when it is asked instead of pretending to know. It is also not issue #31's
"refuse to work when stale": nothing here blocks a push, because a skill one
version behind is usually still right about most of what it says.

NO TOKEN IS USED. `/start` and the file it names are public on purpose
(`src/onboarding.py`) — the reader of the instructions may not have a secret
yet, and the very first thing the skill tells them to do is install itself with
a bare `curl`.

THE VERSION IS READ OUT OF THE FRONTMATTER, with a second copy of the hub's two
patterns, because this package may import nothing from the serving half. That
duplication is the known risk and it is held by a test rather than by care:
`tests/test_onboarding.py` runs both parsers over the shipped `SKILL.md` and
compares the answers, so the copies cannot drift into disagreeing about a number
that is about to be printed as "you are out of date".
"""

import re
import sys
from pathlib import Path

from hammerola import config
from hammerola.errors import ClientError
from hammerola.hub import QUERY_TIMEOUT, Hub, HubError

# WHERE A CLAUDE CODE SKILL LIVES, and the same path the skill's own setup block
# writes with `curl -o`. Written here as one string rather than assembled, so
# the file this command talks about and the file that document tells a reader to
# create are the same characters in both places.
DEFAULT_PATH = "~/.claude/skills/hammerola/SKILL.md"

# The two manifest keys this follows: where the file is, and which version it
# is. Constants rather than literals for the reason `setup.TEMPLATE_KEY` is one
# — both sides of the contract are in this repository, and a test compares these
# strings against `src/onboarding.py`'s own.
SKILL_KEY = "skill"
VERSION_KEY = "skill_version"

# The frontmatter, and the one integer in it. A tight pair of patterns rather
# than a YAML parser: there is none in the standard library and this package may
# import nothing else. Kept character-for-character the same as the hub's — see
# the module docstring for what holds them together.
_FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)
_VERSION_LINE = re.compile(r"^version:[ \t]*(\d+)[ \t]*$", re.MULTILINE)

UPDATE_HINT = "hammerola skill update"


def run(args) -> int:
    """`skill`, or `skill update` — whichever the parser reached."""
    if args.skill_command == "update":
        return update(args)
    return show(args)


def show(args) -> int:
    """Say which version is here and which the hub serves. -> exit code.

    ZERO IN EVERY CASE THAT ANSWERS THE QUESTION, stale included, and that is a
    decision rather than an oversight. "Not installed" is explicitly not a
    failure (there is a file to write and this says where it goes), so "one
    version behind" cannot be one either — it is less wrong than the case above
    it. What is non-zero is what always is in this tool: a hub that cannot be
    reached, a machine with no address configured, a file that cannot be read.
    Those raise, and `cli.main` turns every one of them into the same sentence
    and the same code.
    """
    path = _path(args)
    text = _read(path)
    local = version_of(text)

    # THE LOCAL FACT FIRST, and printed BEFORE the network is touched: half the
    # answer is knowable without a hub, and on a machine that cannot reach one
    # the refusal then lands under that half rather than instead of it.
    if text is None:
        print(f"not installed: nothing at {config.display_path(path)}")
    elif local is None:
        print(f"installed at {config.display_path(path)}, naming no version — "
              f"a copy from before the skill was versioned")
    else:
        print(f"version {local} installed at {config.display_path(path)}")
    sys.stdout.flush()

    hub_url = config.hub_url(None)
    served = _served_version(hub_url)
    print(f"version {served} served by {hub_url}")

    if local == served:
        print("up to date")
    elif text is None:
        # NOT "out of date": there is nothing to date. The line a reader acts on
        # is the same one either way, and saying it the other way round would
        # describe a file that does not exist.
        print(f"`{UPDATE_HINT}` installs it")
    else:
        print(f"out of date. `{UPDATE_HINT}` writes the hub's copy over it")
    return 0


def update(args) -> int:
    """Fetch the hub's copy and write it where a skill is read from. -> exit code.

    THE ONE THING IN THIS TOOL THAT WRITES INTO THE AGENT'S SKILLS DIRECTORY,
    and it happens only because somebody typed the word. It overwrites, which is
    the point of the verb — unlike `create`, which refuses over anything already
    there — so what protects a reader is that the destination is named in the
    output and can be moved with `--path`.

    CHECKED BEFORE IT IS WRITTEN, like everything else here: what comes back has
    to be a document this can read a version out of. A hub serving something
    else — a login page from a proxy in front of it, an error document with a
    200 on it — would otherwise land on disk as the agent's instructions, and
    the next run of `skill` could only say that the file names no version.
    """
    path = _path(args)
    before_text = _read(path)
    before = version_of(before_text)

    hub_url = config.hub_url(None)
    hub = Hub(hub_url, "", timeout=QUERY_TIMEOUT)
    manifest = hub.start()
    where = manifest.get(SKILL_KEY)
    if not isinstance(where, str) or not where:
        raise HubError(f"{hub_url} answered the start manifest without naming "
                       f"the skill.\n  Nothing was written.")
    body = hub.fetch_path(where)

    try:
        served_text = body.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ClientError(
            f"{hub_url} served a skill that is not utf-8 text: {error}\n"
            f"  Nothing was written.") from error
    served = version_of(served_text)
    if served is None:
        raise ClientError(
            f"{hub_url} served a document with no version in its frontmatter, "
            f"so it is not a skill this can install.\n  Nothing was written.")

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
    except OSError as error:
        raise ClientError(f"cannot write {path}: {error}") from error

    print(f"wrote {config.display_path(path)}")
    print(f"  {_before(before_text, before, served)} -> version {served}")
    return 0


def version_of(text):
    """The version in a skill's frontmatter, or None. Never raises.

    None for all three ways of not having one — no text at all, no frontmatter
    block, no `version:` line in it — because the caller does the same thing
    with each: say what is there and offer the update. The HUB parses the same
    file strictly and raises instead (`onboarding.skill_version`), and that
    asymmetry is deliberate: a hub with no version is a broken IMAGE, while a
    laptop with no version is the ordinary case of a file installed before this
    existed.
    """
    if text is None:
        return None
    block = _FRONTMATTER.match(text)
    if block is None:
        return None
    found = _VERSION_LINE.search(block.group(1))
    if found is None:
        return None
    return int(found.group(1))


def _path(args) -> Path:
    """Where the installed skill is. `--path` first, then the usual place."""
    return Path(args.path or DEFAULT_PATH).expanduser()


def _read(path: Path):
    """The installed file as text, or None when there is nothing there."""
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except IsADirectoryError as error:
        raise ClientError(f"{path} is a directory, not a skill file") from error
    except UnicodeDecodeError as error:
        raise ClientError(
            f"{path} is not utf-8 text, so it is not a skill file: {error}\n"
            f"  `{UPDATE_HINT} --path {path}` would write over it.") from error
    except OSError as error:
        raise ClientError(f"cannot read {path}: {error}") from error


def _served_version(hub_url: str) -> int:
    """The version the hub says it ships. NO TOKEN — `/start` is public."""
    manifest = Hub(hub_url, "", timeout=QUERY_TIMEOUT).start()
    version = manifest.get(VERSION_KEY)
    # `bool` is an `int` in python and `True` would sail through the check
    # below, which is worth one clause here: the manifest carries a boolean of
    # its own next to this number, and reading the wrong key would then print
    # "version True".
    if isinstance(version, bool) or not isinstance(version, int):
        raise HubError(
            f"{hub_url} answered the start manifest without a skill version.\n"
            f"  A hub older than this tool does not carry one; its "
            f"/start/skill.md still serves the file, which is what the "
            f"`curl` in the skill's own setup block fetches.")
    return version


def _before(text, version, served) -> str:
    """What the file WAS, said in the same breath as what it now is."""
    if text is None:
        return "nothing installed"
    if version is None:
        return "a copy from before versioning"
    if version == served:
        return f"version {version}, unchanged"
    return f"version {version}"
