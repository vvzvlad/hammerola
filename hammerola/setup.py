"""`hammerola login` and `hammerola create` — the two things done once.

`login` answers WHERE and AS WHOM for every model directory on the machine;
`create` answers WHICH PROJECT for one directory.

Neither publishes. The id is minted locally (SPEC §3.1). `create` reaches the
hub only for the public starter template and never reads the token;
`--no-template` needs no hub at all.

The password is prompted for, never an argument (shell history, `ps`); it lives
only in the 0600 file. The address may be an argument.
"""

import getpass
import os
from pathlib import Path

from hammerola import config, project, unpack
from hammerola.errors import ClientError
from hammerola.hub import QUERY_TIMEOUT, Hub, HubError
from hammerola.projectslug import slug_from_title
from hammerola.sources import public_hub

# Prompts, named so tests can drive them.
HUB_PROMPT = "hub address"
TOKEN_PROMPT = "hub password (not echoed): "
PROXY_LOGIN_PROMPT = "proxy login"
PROXY_PASSWORD_PROMPT = "proxy password (not echoed): "

# Column the settings line up in when they are reported back — the longest
# variable name plus a space.
_LABEL = len(config.HUB_BASIC_AUTH_VAR) + 1

# Said after login when the environment also sets the variable: the
# environment outranks the file (`config.resolve`).
SHADOWED = ("note: {name} is set in this shell's environment, and that wins "
            "over the file above.\n"
            "  `unset {name}` for the login to take effect here.")

# Said when the directory and the title's brackets name different slugs. The
# directory wins (`project._project_slug`), and every build then warns
# (`cadbuild.project_title.title_problem`). The `project` key is never
# recomputed, so the remedies are renaming the title or editing the key.
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
    """Ask where and as whom, check it, store it. -> exit code.

    A password proxy in front of the hub (Traefik basicAuth and the like) is
    noticed, not configured: `/start` asked with no credentials answers 401,
    which the hub never does. Only then are its login and password asked for,
    and stored as `HUB_BASIC_AUTH`.
    """
    url = _hub_address(args.url)
    try:
        proxied = Hub(url, "", timeout=QUERY_TIMEOUT).behind_a_password_proxy()
    except HubError as error:
        raise HubError(f"{error}\n  Nothing was saved.") from error
    proxy_login, basic_auth = _proxy_credentials() if proxied else ("", "")
    token = _password()

    # Checked against the hub before it is stored, and stored only if it
    # passes. A proxy that refuses its login is told apart by `check_token`.
    try:
        hub = Hub(url, token, timeout=QUERY_TIMEOUT, basic_auth=basic_auth)
        if not hub.check_token():
            raise HubError(
                "the hub refused that password.\n"
                "  It is one shared secret for the whole system, not a "
                "per-person one — the same value the hub runs with.")
    except HubError as error:
        raise HubError(f"{error}\n  Nothing was saved.") from error

    # None when there is no proxy: an earlier login's proxy password must not
    # go on travelling to this address.
    values = {config.HUB_URL_VAR: url, config.EDIT_TOKEN_VAR: token,
              config.HUB_BASIC_AUTH_VAR: basic_auth or None}
    path = config.write_settings(values)

    print(f"saved to {config.display_path(path)} (mode 0600)")
    print(f"  {config.HUB_URL_VAR:<{_LABEL}}{url}")
    # Only the length: the value must not reach a scrollback (see `config.py`).
    print(f"  {config.EDIT_TOKEN_VAR:<{_LABEL}}stored, {len(token)} "
          f"characters")
    if basic_auth:
        # The login and never the password.
        print(f"  {config.HUB_BASIC_AUTH_VAR:<{_LABEL}}stored, login "
              f"{proxy_login}")
    for name in values:
        if os.environ.get(name, "").strip():
            print(SHADOWED.format(name=name))
    return 0


def _proxy_credentials():
    """The proxy's login and password. -> (login, "login:password")."""
    proxy_login = _ask(PROXY_LOGIN_PROMPT)
    try:
        proxy_password = getpass.getpass(PROXY_PASSWORD_PROMPT)
    except EOFError as error:
        raise config.ConfigError(_NOTHING_TO_READ) from error
    return proxy_login, f"{proxy_login}:{proxy_password}"


def _hub_address(given) -> str:
    """The address, from the argument or from the prompt, checked for shape.

    The current setting is offered as the default, read without a project
    directory: a project's `.env` has nothing to do with the machine file.
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
    # Both checks at the prompt: the file takes UTF-8, but a header value must
    # be latin-1. Otherwise `Hub.__init__` would refuse it with advice to run
    # `hammerola login`.
    config.check_storable(config.EDIT_TOKEN_VAR, token)
    config.check_sendable_as_header(config.EDIT_TOKEN_VAR, token)
    return token


_NOTHING_TO_READ = (
    "`hammerola login` asks for the password on the terminal and there is "
    "nothing to read.\n"
    "  On a machine being set up by a script, pass the values in the "
    "environment for\n"
    "  one run instead: `HUB_URL=... EDIT_TOKEN=... hammerola status`, plus\n"
    "  `HUB_BASIC_AUTH=login:password` for a password proxy in front of the "
    "hub.")


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

# The manifest key for the template; a test compares it with
# `src.onboarding.TEMPLATE_KEY`.
TEMPLATE_KEY = "template"

# Said when the template cannot be fetched. Nothing is written, not even
# project.json.
TEMPLATE_UNREACHABLE = (
    "  Nothing was created. `hammerola create --no-template` writes just the "
    "project.json\n  and needs no hub at all.")

# The one failure that can leave a half-made project: a filesystem error after
# project.json has landed. The message says what state the directory is in.
PARTLY_WRITTEN = (
    "\n  The project.json was written first, so this directory now holds an id "
    "and no model.\n  A re-run of `create` refuses over that file: fix the "
    "cause and unpack the template by\n  hand, or delete the directory and "
    "start again.")


def create(args) -> int:
    """Write a `project.json` with a fresh id, and unpack the template. -> exit code."""
    root = Path(args.directory).expanduser() if args.directory else Path.cwd()
    _refuse_inside_a_project(root)

    # Fetched and checked before anything is written, so a failure leaves the
    # directory untouched and a re-run works.
    template = () if args.no_template else _template_for(root)
    _refuse_to_overwrite(root, template)

    payload = project.create_project(root, args.title)
    written = _write_template(root, template)

    print(f"created {root / project.PROJECT_FILE}")
    print(f"  id       {payload['id']}")
    print(f"  title    {payload['title']}")
    # The name the hub publishes under; printed only when written.
    if project.PROJECT_KEY in payload:
        print(f"  project  {payload[project.PROJECT_KEY]}")
    for name in written:
        print(f"  wrote    {name}")
    # A key that differs from the title's slug came from the directory.
    slug = payload.get(project.PROJECT_KEY, "")
    titled = slug_from_title(payload["title"])
    if slug and titled and slug != titled:
        print(SLUG_DISAGREEMENT.format(directory=slug, titled=titled))
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

    `/start` names the path and this follows it (`Hub.fetch_path` checks it).
    """
    # A missing HUB_URL gets the same `--no-template` way forward as an
    # unreachable hub: it is what a new user meets first.
    try:
        hub_url = config.hub_url(root)
    except config.ConfigError as error:
        raise config.ConfigError(f"{error}\n{TEMPLATE_UNREACHABLE}") from error
    try:
        # Inside the try: building a Hub refuses a malformed address
        # (`hub._origin`), which needs the same way forward.
        hub = public_hub(hub_url, root)
        manifest = hub.start()
        path = manifest.get(TEMPLATE_KEY)
        if not isinstance(path, str) or not path:
            raise HubError(
                f"{hub_url} answered the start manifest without naming a "
                f"template.")
        body = hub.fetch_path(path)
    except HubError as error:
        raise HubError(f"{error}\n{TEMPLATE_UNREACHABLE}") from error

    # A corrupt template raises ClientError; it gets the same way forward.
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

    All or nothing, never a merge. `lexists`, not `exists`: a dangling
    symlink is a collision too.
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

    Each file is created, never opened: `O_CREAT|O_EXCL` fails if the path
    exists at all, symlinks included, closing the race with the collision
    check. `O_NOFOLLOW` is defence in depth and fetched with a default because
    Windows lacks it.
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

    `create_project` covers the file in `root` itself. This covers
    `cd scripts/ && hammerola create`: `find_project_root` stops at the nearest
    project.json, so an inner one would silently take over every command run
    below it. The message names the enclosing project.
    """
    try:
        existing = project.find_project_root(root)
    except project.ProjectError:
        return
    if existing == Path(root).expanduser().resolve():
        # `create_project` refuses this case itself.
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
