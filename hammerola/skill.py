"""`hammerola skill` and `skill update` — the instructions, and whether they are stale.

The client, the template and the model contract fail loudly when stale (a
stale client refuses to publish, see `update.py`); a stale skill fails
silently, teaching renamed commands and removed flags. This verb checks it.

It never checks by itself: nothing else in the tool looks at the agent's skills
directory, because the tool cannot know which skill file an agent is reading
(plugin, project copy, ...). Nothing blocks a push on a stale skill.

No token: `/start` and the skill file are public (`src/onboarding.py`).

The version is read from the frontmatter with a copy of the hub's two patterns
(this package imports nothing from the service); `tests/test_onboarding.py`
runs both parsers over the shipped `SKILL.md` and compares.
"""

import re
import sys
from pathlib import Path

from hammerola import config
from hammerola.errors import ClientError
from hammerola.hub import HubError
from hammerola.sources import public_hub

# Where a Claude Code skill lives; the same path the skill's own setup block
# writes with `curl -o`.
DEFAULT_PATH = "~/.claude/skills/hammerola/SKILL.md"

# Manifest keys; a test compares them with `src/onboarding.py`.
SKILL_KEY = "skill"
VERSION_KEY = "skill_version"

# The frontmatter and its version integer (no YAML parser in the stdlib).
# Kept identical to the hub's; see the module docstring.
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

    Zero whenever the question is answered, stale or not installed included.
    Unreachable hub, missing address or unreadable file raise.
    """
    path = _path(args)
    text = _read(path)
    local = version_of(text)

    # The local half is printed before the network is touched.
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
        print(f"`{UPDATE_HINT}` installs it")
    else:
        print(f"out of date. `{UPDATE_HINT}` writes the hub's copy over it")
    return 0


def update(args) -> int:
    """Fetch the hub's copy and write it where a skill is read from. -> exit code.

    Overwrites; the destination is printed and can be moved with `--path`.
    What comes back must carry a version in its frontmatter before it is
    written, so a proxy's login page never lands as the agent's instructions.
    """
    path = _path(args)
    before_text = _read(path)
    before = version_of(before_text)

    hub_url = config.hub_url(None)
    hub = public_hub(hub_url)
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

    None for no text, no frontmatter or no `version:` line. The hub parses
    strictly and raises (`onboarding.skill_version`): there a missing version
    is a broken image, here an old installed copy.
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
    manifest = public_hub(hub_url).start()
    version = manifest.get(VERSION_KEY)
    # `bool` is an `int`; the manifest also carries a boolean (`empty`).
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
