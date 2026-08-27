"""`hammerola login` and `hammerola create` — the two things done once.

They have nothing in common at runtime and everything in common in the story: a
machine that has never published anything needs both, exactly once each, and
after that neither is ever run again. `login` answers WHERE and AS WHOM, and it
answers it for every model directory on the machine; `create` answers WHICH
PROJECT, and it answers it for one directory, for the life of that project.

NEITHER OF THEM PUBLISHES ANYTHING, and `create` does not even reach the
network: an id is a name the repository carries, not a registration (SPEC §3.1),
so a project can be started on a train and pushed a week later.

THE PASSWORD IS ASKED FOR, NEVER PASSED IN. There is no `--token` flag here and
there will not be one: an argument is in the shell's history file and in every
`ps` on the machine for as long as the process runs, and the whole point of the
file `login` writes is that the secret lives in one 0600 file instead of in
several places nobody remembers. The address CAN be an argument, because it is
not a secret and scripting a machine's setup is a reasonable thing to want.
"""

import getpass
import os
from pathlib import Path

from src.client import config, project
from src.client.hub import QUERY_TIMEOUT, Hub, HubError

# Prompts. Written out here rather than inline so the two questions read as one
# form, and so a test can drive them by name.
HUB_PROMPT = "hub address"
TOKEN_PROMPT = "hub password (not echoed): "

# Column the two settings line up in when they are reported back — the longer
# variable name plus a space.
_LABEL = len(config.EDIT_TOKEN_VAR) + 1

# Said after a successful login when the environment ALSO carries one of these.
# It is the one way a correct login still leads to the wrong hub: `resolve`
# takes the environment first (`config.py`), on purpose, so a leftover
# `export HUB_URL=` from an experiment silently outranks the file that was just
# written and every push goes on going where it went before.
SHADOWED = ("note: {name} is set in this shell's environment, and that wins "
            "over the file above.\n"
            "  `unset {name}` for the login to take effect here.")


def login(args) -> int:
    """Ask where and as whom, check it, store it. -> exit code."""
    url = _hub_address(getattr(args, "url", None))
    token = _password()

    # CHECKED BEFORE IT IS STORED, and stored only if the check passes. A
    # credential that was never tried is the one that turns up wrong at the next
    # push, several minutes into a build somebody was waiting for; asking the
    # hub costs one request now and moves the whole class of typos into the
    # thirty seconds a person is still looking at the prompt.
    try:
        if not Hub(url, token, timeout=QUERY_TIMEOUT).check_token():
            raise HubError(
                "the hub refused that password.\n"
                "  It is one shared secret for the whole system, not a "
                "per-person one — the same value the hub runs with.")
    except HubError as error:
        # The sentence every failure of this block needs, added in one place:
        # whatever went wrong, the machine's settings were not touched, and that
        # is the thing somebody about to retype a password wants to know.
        raise HubError(f"{error}\n  Nothing was saved.") from error

    path = config.write_settings({
        config.HUB_URL_VAR: url,
        config.EDIT_TOKEN_VAR: token,
    })

    print(f"saved to {config.display_path(path)} (mode 0600)")
    print(f"  {config.HUB_URL_VAR:<{_LABEL}}{url}")
    # The LENGTH and nothing else. It is enough to tell "I pasted the wrong
    # thing" from "I pasted nothing", which is all anybody ever needs from it,
    # and the value itself must not reach a scrollback (see `config.py`).
    print(f"  {config.EDIT_TOKEN_VAR:<{_LABEL}}stored, {len(token)} "
          f"characters")
    for name in (config.HUB_URL_VAR, config.EDIT_TOKEN_VAR):
        if os.environ.get(name, "").strip():
            print(SHADOWED.format(name=name))
    return 0


def _hub_address(given) -> str:
    """The address, from the argument or from the prompt, checked for shape.

    The current setting is offered as the default, so re-running `login` to
    change only the password is pressing Enter once. It is read WITHOUT a
    project directory: this is the machine's own answer, and a project's `.env`
    override has nothing to do with what gets written here.
    """
    current, _source = config.resolve(config.HUB_URL_VAR)
    url = (given or "").strip() or _ask(HUB_PROMPT, current)
    if not url:
        raise config.ConfigError(
            "no hub address given. It has no default — the address of our own "
            "service is never guessed (AGENTS.md).")
    if not url.startswith(("http://", "https://")):
        raise config.ConfigError(
            f"{url!r} is not an address this tool can use: it needs the scheme "
            f"too, as in https://{url.lstrip('/')}")
    return url.rstrip("/")


def _password() -> str:
    try:
        token = getpass.getpass(TOKEN_PROMPT).strip()
    except EOFError as error:
        raise config.ConfigError(_NOTHING_TO_READ) from error
    if not token:
        raise config.ConfigError("no password given; nothing was saved")
    # Asked here, at the prompt, and not left to `write_settings` at the end: a
    # value with a line break in it cannot be stored AND cannot be sent as an
    # `Authorization` header, so checking it late would mean the run fails
    # somewhere inside urllib instead of at the question that produced it.
    config.check_storable(config.EDIT_TOKEN_VAR, token)
    return token


_NOTHING_TO_READ = (
    "`hammerola login` asks for the password on the terminal and there is "
    "nothing to read.\n"
    "  On a machine being set up by a script, pass the two values in the "
    "environment for\n"
    "  one run instead: `HUB_URL=... EDIT_TOKEN=... hammerola status`.")


def _ask(prompt: str, default=None) -> str:
    suffix = f" [{default}]" if default else ""
    try:
        answer = input(f"{prompt}{suffix}: ").strip()
    except EOFError as error:
        raise config.ConfigError(_NOTHING_TO_READ) from error
    return answer or (default or "")


def create(args) -> int:
    """Write a `project.json` with a fresh id. -> exit code."""
    root = Path(args.directory).expanduser() if args.directory else Path.cwd()
    _refuse_inside_a_project(root)
    payload = project.create_project(root, getattr(args, "title", None))

    print(f"created {root / project.PROJECT_FILE}")
    print(f"  id     {payload['id']}")
    print(f"  title  {payload['title']}")
    # The one rule about the file, said at the one moment somebody is looking at
    # it. Every permanent URL of this project is built from that id, so an edit
    # to it does not rename anything — it starts a different project and leaves
    # the old one on the hub with nobody pointing at it.
    print("commit this file. The id is what every published URL is built from, "
          "and it is\nnot edited by hand (SPEC §3.1) — rename the title "
          "instead, never the id.")
    print("next: `hammerola build` publishes the working copy into dev.")
    return 0


def _refuse_inside_a_project(root: Path) -> None:
    """Refuse when a project.json already stands ABOVE this directory.

    `create_project` refuses to overwrite the file in `root` itself, and that
    covers `hammerola create` run twice in the same place. It does not cover the
    case that actually costs something, because there is nothing to overwrite
    there: `cd scripts/ && hammerola create`. The id is minted in a
    SUBDIRECTORY of a project that already has one, nothing fails, and from then
    on every command run from that directory addresses the new, empty project —
    `find_project_root` walks up and stops at the NEAREST project.json, which is
    now the inner one. The next `build` publishes a subtree of the model under
    an id nobody meant to create, and the loss is invisible until somebody goes
    looking for the history (`project.create_project` says the same thing about
    the case it does catch).

    Looked up rather than assumed: the message names the project that is already
    here, because "you are inside one" is only actionable if it says which.
    """
    try:
        existing = project.find_project_root(root)
    except project.ProjectError:
        return
    if existing == Path(root).expanduser().resolve():
        # `create_project` owns this one and says it better — it is about the
        # file it is holding rather than about the directory being inside
        # something.
        return
    raise project.ProjectError(
        f"{root} is already inside the project in {existing}.\n"
        f"  A second {project.PROJECT_FILE} below that one would not fail "
        f"anything: it would quietly take over\n"
        f"  every command run from here, and the next `hammerola build` would "
        f"publish this subtree as\n"
        f"  a project of its own. Run this outside "
        f"{existing}, or pass a directory that is."
    )
