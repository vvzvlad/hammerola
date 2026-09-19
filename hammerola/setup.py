"""`hammerola login` and `hammerola create` — the two things done once.

They have nothing in common at runtime and everything in common in the story: a
machine that has never published anything needs both, exactly once each, and
after that neither is ever run again. `login` answers WHERE and AS WHOM, and it
answers it for every model directory on the machine; `create` answers WHICH
PROJECT, and it answers it for one directory, for the life of that project.

NEITHER OF THEM PUBLISHES ANYTHING, and the ID IS STILL MINTED LOCALLY: it is a
name the repository carries, not a registration (SPEC §3.1). `create` does now
reach the hub, for one thing only — the starter template, a model.py that builds
as it stands. That download is a convenience and the id is not, so the two are
separated by a flag rather than tangled together: `--no-template` starts a
project on a train, with no hub, no address and no secret, exactly as before.

WHAT `create` NEVER READS IS THE TOKEN. The template is public (see
`src/onboarding.py`), so a project can be started against a hub this machine has
never logged in to — and a command whose whole job is to write a file into a new
directory has no business touching the one secret of the system.

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

from hammerola import config, project, unpack
from hammerola.errors import ClientError
from hammerola.hub import QUERY_TIMEOUT, Hub, HubError
from hammerola.projectslug import slug_from_title

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

# Said when the DIRECTORY and the TITLE name two different slugs. The directory
# wins, silently — `project._project_slug` asks it first — and the disagreement
# is worth a line because nothing later resolves it:
# `cadbuild.project_title.title_problem` reads it as a title copied from another
# project, and `cadbuild/build.py` prints that warning on every build. This is
# the only place both names are in front of somebody: the build log names the
# two slugs and never says that one of them is a directory.
#
# THE REMEDY IT NAMES HAS TO BE ONE THAT WORKS, and the first version's was not:
# it said "rename the directory", which changes nothing at all. The `project`
# key is written once, here, by `create_project`, and `load_project` reads that
# key before it looks at anything else — so after creation neither the directory
# nor the title can move the slug the project publishes under. What is left is
# the two below: bring the TITLE's brackets to the key (`hammerola rename`
# rewrites the title and leaves `project` alone), or edit the key itself.
SLUG_DISAGREEMENT = (
    "note: the directory is named {directory!r}, and the title's brackets say "
    "{titled!r}.\n"
    "  The directory wins: the \"project\" key now says {directory!r} and "
    "nothing recomputes it,\n"
    "  so renaming the directory later changes nothing. Every build warns until "
    "the two agree:\n"
    "  `hammerola rename \"<what and what for> ({directory})\"`, or edit that "
    "key to {titled!r}.")


def login(args) -> int:
    """Ask where and as whom, check it, store it. -> exit code."""
    url = _hub_address(args.url)
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
    # BOTH CHECKS, HERE, AT THE PROMPT. `check_storable` answers for the file
    # and `check_sendable_as_header` for the `Authorization` header, and the
    # second one is not a duplicate of the first: the file is UTF-8 and takes a
    # Cyrillic password happily, while an HTTP header value is latin-1 and
    # cannot. With only the first, such a password passed the prompt, was tried
    # against the hub, and was refused by `Hub.__init__` with "the stored secret
    # ... run `hammerola login`" — said to somebody in the middle of running
    # `hammerola login`, about a secret that had not been stored. A loop with no
    # way out of it, from inside the one command that exists to fix it.
    config.check_storable(config.EDIT_TOKEN_VAR, token)
    config.check_sendable_as_header(config.EDIT_TOKEN_VAR, token)
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


# What the template archive is called in messages. It is fetched from a path the
# hub names, so nothing here spells a URL.
TEMPLATE_WHERE = "the starter template"

# The manifest key this command follows to find the template. A constant so the
# two sides of that contract can be COMPARED: `src.onboarding.TEMPLATE_KEY` is
# the hub's, and a test asserts they are the same string. It was a literal here
# before, and the test that claimed to check it compared the hub with itself.
TEMPLATE_KEY = "template"

# Said when the template cannot be fetched. The refusal is total — nothing is
# written, not even project.json — because the alternative is a directory
# holding an id and no model, from a command that reported a failure.
TEMPLATE_UNREACHABLE = (
    "  Nothing was created. `hammerola create --no-template` writes just the "
    "project.json\n  and needs no hub at all.")

# ...and the one failure that CAN leave a half-made project: the disk refusing a
# write after project.json has landed. Everything checkable is checked before
# anything is written, so what is left is a filesystem error — and the message
# has to say what state the directory is in, because "cannot write model.py" on
# its own leaves somebody guessing whether the id was minted.
PARTLY_WRITTEN = (
    "\n  The project.json was written first, so this directory now holds an id "
    "and no model.\n  A re-run of `create` refuses over that file: fix the "
    "cause and unpack the template by\n  hand, or delete the directory and "
    "start again.")


def create(args) -> int:
    """Write a `project.json` with a fresh id, and unpack the template. -> exit code."""
    root = Path(args.directory).expanduser() if args.directory else Path.cwd()
    _refuse_inside_a_project(root)

    # FETCHED AND CHECKED BEFORE ANYTHING IS WRITTEN, and the order is the whole
    # of what makes this command safe to run twice. A download that fails, or a
    # file that is already there, has to stop the command while the directory is
    # still untouched — a half-created project holds a permanent id and no
    # model, and the second run then refuses over the project.json the first one
    # left behind.
    template = () if args.no_template else _template_for(root)
    _refuse_to_overwrite(root, template)

    payload = project.create_project(root, args.title)
    written = _write_template(root, template)

    print(f"created {root / project.PROJECT_FILE}")
    print(f"  id       {payload['id']}")
    print(f"  title    {payload['title']}")
    # Printed only when it was written, exactly as the file carries it: this is
    # the name the hub publishes under -- the one on the index card and in the
    # build page header -- and a line saying nothing would be indistinguishable
    # from a project that has one. Its absence is said by the build log instead,
    # where the id that stood in for it is also printed.
    if project.PROJECT_KEY in payload:
        print(f"  project  {payload[project.PROJECT_KEY]}")
    for name in written:
        print(f"  wrote    {name}")
    # The key differing from the title's brackets means it came from the
    # DIRECTORY: `_project_slug` returns one or the other unchanged, so a key
    # that is not the title's slug is the directory's name.
    slug = payload.get(project.PROJECT_KEY, "")
    titled = slug_from_title(payload["title"])
    if slug and titled and slug != titled:
        print(SLUG_DISAGREEMENT.format(directory=slug, titled=titled))
    # The one rule about the file, said at the one moment somebody is looking at
    # it. Every permanent URL of this project is built from that id, so an edit
    # to it does not rename anything — it starts a different project and leaves
    # the old one on the hub with nobody pointing at it.
    print("commit this file. The id is what every published URL is built from, "
          "and it is\nnot edited by hand (SPEC §3.1) — rename the title "
          "instead, never the id.")
    if written:
        print("model.py is a working example and builds as it stands: read the "
              "contract\nwritten next to the geometry, then replace it.")
    print("next: `hammerola build` publishes the working copy into dev.")
    return 0


def _template_for(root: Path):
    """Fetch the starter template. -> ((member, bytes), ...), or a HubError.

    The hub is asked WHERE the template is rather than told: `/start` names the
    path and this follows it (`Hub.fetch_path` checks that what came back is a
    path on that same hub). One string in this tool, one on the other side, and
    a test compares them.
    """
    # THE MISSING SETTING GETS THE SAME SENTENCE AS THE UNREACHABLE HUB, and it
    # is the more important of the two: "the hub is down" happens to somebody
    # who has used this before, while "HUB_URL is not set" is the FIRST command
    # a new person runs, and the whole point of this branch is that they have a
    # way forward. `config.hub_url` explains what the variable is; only this
    # knows that the id is minted locally and that a flag gets them a project
    # without a hub at all.
    try:
        hub_url = config.hub_url(root)
    except config.ConfigError as error:
        raise config.ConfigError(f"{error}\n{TEMPLATE_UNREACHABLE}") from error
    try:
        # INSIDE the try, because building a Hub is where an address that cannot
        # be requested at all is refused (`hub._origin`) — a `HUB_URL` with a
        # letter in the port is exactly the shape of typo this command meets,
        # and it needs the same "here is how to start anyway" sentence as a hub
        # that is merely down.
        #
        # No token, deliberately — see the module docstring.
        hub = Hub(hub_url, "", timeout=QUERY_TIMEOUT)
        manifest = hub.start()
        path = manifest.get(TEMPLATE_KEY)
        if not isinstance(path, str) or not path:
            raise HubError(
                f"{hub_url} answered the start manifest without naming a "
                f"template.")
        body = hub.fetch_path(path)
    except HubError as error:
        raise HubError(f"{error}\n{TEMPLATE_UNREACHABLE}") from error

    # INSIDE A WRAPPER OF ITS OWN, because reading the archive is the one way
    # this command can fail without saying how to get past it. A template that
    # is corrupt, or that names a member no client will unpack, raises
    # ClientError — a different class from everything above — and it used to be
    # the single refusal of `create` that lost the `--no-template` sentence,
    # which is the way forward for a reader stuck at their first command.
    try:
        members = unpack.read_members(body, where=TEMPLATE_WHERE,
                                      rules=unpack.TEMPLATE_RULES)
    except ClientError as error:
        raise ClientError(f"{error}\n{TEMPLATE_UNREACHABLE}") from error
    if not members:
        raise HubError(f"{hub_url} served an empty template.\n"
                       f"{TEMPLATE_UNREACHABLE}")
    return tuple(sorted(members.items()))


def _refuse_to_overwrite(root: Path, template) -> None:
    """Stop if the template would land on top of something already here.

    ALL OR NOTHING, and never a merge: a directory holding half a template and
    half of somebody's own work is a state neither of them can be recovered
    from, and this command is run in a directory somebody has just made — so
    anything already in it was put there on purpose.

    `lexists` and not `exists`, which is the difference between a check and a
    hole: `exists()` follows a symlink, so a DANGLING one is not a collision to
    it — and the write that followed opened the link's target, landing a file
    outside the project entirely. The link itself is what is already there, so
    the link itself is what this has to see.
    """
    clashes = [name for name, _data in template
               if os.path.lexists(root / Path(name))]
    if not clashes:
        return
    listed = "\n".join(f"    {name}" for name in clashes)
    raise project.ProjectError(
        f"{root} already holds file(s) the template would write over:\n"
        f"{listed}\n"
        f"  Nothing was written. Run this in an empty directory, or "
        f"`hammerola create --no-template`\n"
        f"  to write only the project.json.")


def _write_template(root: Path, template) -> list:
    """Write the template's files. -> the member paths, sorted.

    Every name has already been checked against `unpack.TEMPLATE_RULES`, so no
    component can be `..`, empty or absolute; the `relative_to` below is defence
    in depth over that and costs one resolve per file.

    EACH FILE IS CREATED, NEVER OPENED. `O_CREAT|O_EXCL` fails if the path
    exists at all — a symlink included, dangling or not — and `O_NOFOLLOW` says
    the same thing a second way. That closes two things at once: the window
    between the collision check above and this write, and the case that check
    could not see on its own, where the name is a link and the bytes land at its
    target. `write_bytes` would have followed it.

    `O_NOFOLLOW` IS FETCHED WITH A DEFAULT because it is the one non-portable
    constant in the whole client: Windows has no such flag, and naming it
    directly would make this line an `AttributeError` — a traceback where the
    tool is supposed to print a sentence — on the first `create` there. Falling
    back to 0 loses nothing that matters: `O_EXCL` already refuses every path
    that exists, symlinks included, so the second flag is defence in depth
    rather than the control, and where it exists it is still passed.
    """
    written = []
    for name, data in template:
        target = root.joinpath(*name.split("/"))
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.parent.resolve().relative_to(root.resolve())
        except ValueError as error:
            raise project.ProjectError(
                f"{TEMPLATE_WHERE} holds a member that would be written "
                f"outside {root}: {name!r}") from error
        except OSError as error:
            raise project.ProjectError(
                f"cannot create {target.parent}: {error}{PARTLY_WRITTEN}"
            ) from error
        try:
            flags = (os.O_WRONLY | os.O_CREAT | os.O_EXCL
                     | getattr(os, "O_NOFOLLOW", 0))
            handle = os.open(target, flags, 0o644)
            try:
                stream = os.fdopen(handle, "wb")
            except BaseException:
                # Only until `fdopen` has taken the descriptor over; closing it
                # afterwards would close one the stream still owns.
                os.close(handle)
                raise
            # Through a file object rather than `os.write`, which is allowed to
            # write short.
            with stream:
                stream.write(data)
        except FileExistsError as error:
            raise project.ProjectError(
                f"{target} appeared while this was running, so the template was "
                f"not written over it.{PARTLY_WRITTEN}") from error
        except OSError as error:
            raise project.ProjectError(
                f"cannot write {target}: {error}{PARTLY_WRITTEN}") from error
        written.append(name)
    return sorted(written)


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
