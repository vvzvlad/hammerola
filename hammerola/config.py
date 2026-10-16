"""Where the hub's address and the secrets come from, and how they got there.

Three places, first hit wins:

  1. the process environment     — a one-off `HUB_URL=... hammerola build`, and
                                   how CI passes the organisation secrets.
  2. `.env` in the project       — optional, for overriding a single model.
  3. `~/.config/hammerola/env`   — this machine's settings, same `KEY=value`
                                   format, written once and read by every model
                                   directory on it.

The third one is what `hammerola login` writes (`write_settings` below); it is
looked at last because an env var or a project's `.env` is more specific.

NEITHER `HUB_URL` NOR `EDIT_TOKEN` HAS A DEFAULT: the address of our own service
is never guessed (AGENTS.md). A missing one is an error naming the file to
write, raised before the tree is walked or packed.

THE TOKEN IS NEVER PRINTED — not in an error, a banner or a traceback; only its
length and where it was found. It is the whole system's one secret
(`EDIT_TOKEN`, used for pushes, the comment queue and every write), which is
also why `pack.py` drops `.env`, `login` reads it with `getpass` rather than an
argument, and the file is created 0600. The hub compares it for equality, so
"logging in" means storing it and nothing more. It travels in the hub's own
header, `X-Hammerola-Token`.

`HUB_BASIC_AUTH` (`login:password`) is OPTIONAL: it is for a password proxy in
front of the hub (Traefik basicAuth and the like), which wants the
`Authorization` header the hub leaves alone. Unset means no proxy. Its password
half is never printed either, only the login.
"""

import os
from pathlib import Path

HUB_URL_VAR = "HUB_URL"
EDIT_TOKEN_VAR = "EDIT_TOKEN"
HUB_BASIC_AUTH_VAR = "HUB_BASIC_AUTH"

# Which machine-wide file to read: an override so tests do not see the
# developer's real settings.
ENV_FILE_VAR = "HAMMEROLA_ENV_FILE"

PROJECT_ENV_NAME = ".env"


class ConfigError(Exception):
    """A setting is missing, with a message that says what to do about it."""


def _home() -> Path:
    """$HOME, or a path that exists nowhere.

    `Path.home()` RAISES when HOME is unset and the uid has no passwd entry,
    which is an ordinary state inside a container started with `--user`.
    Importing this module must not be the thing that breaks such a run.
    """
    try:
        return Path.home()
    except (RuntimeError, KeyError, OSError):
        return Path("/nonexistent")


def machine_env_file() -> Path:
    override = os.environ.get(ENV_FILE_VAR, "").strip()
    if override:
        return Path(override).expanduser()
    return _home() / ".config" / "hammerola" / "env"


def display_path(path: Path) -> str:
    """The path as a person writes it: $HOME back to `~`."""
    try:
        return f"~/{path.relative_to(_home()).as_posix()}"
    except ValueError:
        return str(path)


def parse_env_file(path: Path) -> dict:
    """`KEY=value` lines to a dict. Blank keys and blank values are dropped.

    Deliberately not a shell: `KEY=value`, `#` comments, an optional `export`
    and one layer of surrounding quotes. Nothing here is executed, which is what
    matters in a file that can hold a token.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as error:
        raise ConfigError(f"cannot read {display_path(path)}: {error}") from error
    return parse_env_text(text)


def parse_env_text(text: str) -> dict:
    """The reading half, over text rather than a path.

    Split out so `write_settings` can check what it is ABOUT to write by reading
    it back with the very same rules, without having written it first.
    """
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, separator, value = line.partition("=")
        if not separator:
            continue
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and value:
            values[key] = value
    return values


def resolve(name: str, project_dir=None):
    """(value, where it came from), or (None, None). Empty counts as absent.

    A stray `HUB_URL=` in a file therefore falls through to the next source
    instead of arriving later as an unusable URL.
    """
    value = os.environ.get(name, "").strip()
    if value:
        return value, "the environment"

    if project_dir is not None:
        project_env = Path(project_dir) / PROJECT_ENV_NAME
        value = parse_env_file(project_env).get(name, "").strip()
        if value:
            return value, f"{PROJECT_ENV_NAME} in this project"

    machine = machine_env_file()
    value = parse_env_file(machine).get(name, "").strip()
    if value:
        return value, display_path(machine)

    return None, None


def _require(name: str, hint: str, project_dir=None) -> str:
    value, _source = resolve(name, project_dir)
    if value:
        return value
    raise ConfigError(
        f"{name} is not set.\n"
        f"  {hint}\n"
        f"  Looked in: the environment, {PROJECT_ENV_NAME} in this project, "
        f"{display_path(machine_env_file())}."
    )


HUB_URL_HINT = (
    "It is the address of the hammerola hub, and this tool carries no default\n"
    "  for it — the address of our own service is never guessed. Write\n"
    "  `HUB_URL=https://your-hub.example` into\n"
    "  {file} once; every model directory on this machine then finds it."
)

EDIT_TOKEN_HINT = (
    "It is the one secret the hub checks — on a push, on the comment queue,\n"
    "  and on everything else that changes something. Run `hammerola login` to\n"
    "  store it in {file},\n"
    "  or pass it for a single run in the environment."
)


def hub_url(project_dir=None) -> str:
    """The hub's base address, with the trailing slash removed."""
    hint = HUB_URL_HINT.format(file=display_path(machine_env_file()))
    return _require(HUB_URL_VAR, hint, project_dir).rstrip("/")


def edit_token(project_dir=None) -> str:
    """The hub's token. The VALUE is returned and never logged or printed."""
    hint = EDIT_TOKEN_HINT.format(file=display_path(machine_env_file()))
    return _require(EDIT_TOKEN_VAR, hint, project_dir)


def hub_basic_auth(project_dir=None) -> str:
    """`login:password` for a password proxy in front of the hub, or "".

    Optional, so unset is not an error: no proxy. The VALUE is returned and
    never logged or printed.
    """
    value, _source = resolve(HUB_BASIC_AUTH_VAR, project_dir)
    return value or ""


# -- the write half: what `hammerola login` puts in the machine file ---------
# The file holds the system's secret: created with this mode and forced back to
# it after every rename.
FILE_MODE = 0o600
DIRECTORY_MODE = 0o700


def write_settings(values: dict, path: Path = None) -> Path:
    """Store `KEY -> value` in the machine's env file. Returns where it landed.

    Every other line of the file survives: an existing key is rewritten in
    place, a new one is appended, comments and unknown settings are copied
    through. A value of None removes the key, every line of it. Written through
    a temporary file and renamed, so an interrupted login leaves the previous
    settings intact.

    The new text is parsed back with the same parser BEFORE it is written, and
    nothing is written unless every value survives, so a value the format
    cannot carry is never stored as something else.
    """
    path = machine_env_file() if path is None else Path(path)
    for name, value in values.items():
        if value is not None:
            check_storable(name, value)

    parent = path.parent
    # Only a directory this call creates is narrowed: `HAMMEROLA_ENV_FILE` can
    # point into a directory holding somebody else's files.
    fresh = not parent.exists()
    try:
        parent.mkdir(parents=True, exist_ok=True)
        if fresh:
            os.chmod(parent, DIRECTORY_MODE)
    except OSError as error:
        raise ConfigError(
            f"cannot create {display_path(parent)}: {error}") from error

    try:
        existing = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        existing = ""
    except OSError as error:
        raise ConfigError(f"cannot read {display_path(path)}: {error}") from error

    merged = _merge_env_text(existing, values)
    stored = parse_env_text(merged)
    for name, value in values.items():
        if stored.get(name) != value:
            raise ConfigError(
                f"{name} cannot be stored in {display_path(path)}: the file "
                f"holds one `KEY=value` per line and this value does not "
                f"survive being read back from that. Nothing was written, and "
                f"nothing about the value is printed here on purpose; a token "
                f"generated with `secrets.token_urlsafe` always survives.")

    _write_private(path, merged)
    return path


def check_storable(name: str, value) -> None:
    """Refuse a value the file cannot carry, WITHOUT printing the value.

    The refusal names the variable and the shape, never the value. Public
    because `login` asks it of the password as soon as it is typed, before it is
    tried against the hub (a line break would also break the header it travels
    in).
    """
    if not isinstance(value, str) or not value:
        raise ConfigError(f"{name} cannot be stored: it is empty")
    if value != value.strip():
        raise ConfigError(
            f"{name} cannot be stored: it starts or ends with whitespace, "
            f"which this file format strips off again when it is read back")
    if "\n" in value or "\r" in value:
        raise ConfigError(
            f"{name} cannot be stored: it contains a line break, and this file "
            f"holds one `KEY=value` per line")
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        # The parser strips one layer of surrounding quotes, so this value would
        # come back as what is inside them. Refused here so it fails at the prompt.
        raise ConfigError(
            f"{name} cannot be stored: it begins and ends with a quote "
            f"character, and this file format takes one layer of those off "
            f"again when it reads a value back")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        # Any other C0 control: a byte nothing downstream handles predictably,
        # and in a secret a sign of a broken paste.
        raise ConfigError(
            f"{name} cannot be stored: it contains a control character")


def header_value_problem(value):
    """Why `value` cannot travel as an HTTP header value, or None. No echo.

    Shared by `check_sendable_as_header` (asked by `login` at the prompt) and
    `hub._refuse_unsendable_token` (a token from the environment or a
    hand-edited file), so the two cannot disagree. The reason is returned rather
    than raised because each caller gives different advice.

    A tab is legal in a header value but refused anyway, as a broken paste.
    Latin-1 is the wire's limit: `http.client` encodes header values with it.
    """
    if not isinstance(value, str):
        return f"it is a {type(value).__name__} rather than a string"
    if "\r" in value or "\n" in value:
        return "it contains a line break, which is where an HTTP header ends"
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        return ("it contains a control character (a tab included, which the "
                "wire would carry — this refuses it anyway)")
    try:
        value.encode("latin-1")
    except UnicodeEncodeError:
        return ("it contains a character outside latin-1, which is the "
                "encoding an HTTP header value is written in")
    return None


def check_sendable_as_header(name: str, value) -> None:
    """Refuse a secret that could never be presented to the hub. No echo.

    Separate from `check_storable`, which is about the FILE and applies to
    every value including `HUB_URL`; this is about the header the secret
    travels in (`X-Hammerola-Token`) and applies only to the secret. The
    address has its own, stricter check in `hub._origin` (ASCII request line,
    latin-1 `Host`, IDNA labels).

    `login` asks both at the prompt, so the constructor's check in `hub.py`
    (which advises running `hammerola login`) is never reached from `login`.
    """
    problem = header_value_problem(value)
    if problem is not None:
        raise ConfigError(
            f"{name} cannot be used as the hub's password: {problem}.\n"
            f"  Nothing was saved. (The value is not shown here.)")


def _merge_env_text(text: str, values: dict) -> str:
    """The file's text with `values` applied, everything else left alone.

    A key whose value is None loses every line that assigns it.
    """
    remaining = {key: value for key, value in values.items()
                 if value is not None}
    lines = []
    for line in text.splitlines():
        key = _assigned_key(line)
        if key is not None and key in values and values[key] is None:
            continue
        if key is None or key not in remaining:
            lines.append(line)
            continue
        # `export ` is kept when it was there: the file can also be `source`d.
        prefix = "export " if line.lstrip().startswith("export ") else ""
        lines.append(f"{prefix}{key}={remaining.pop(key)}")
    for key, value in remaining.items():
        lines.append(f"{key}={value}")
    return "\n".join(lines) + "\n"


def _assigned_key(line: str):
    """The KEY of a `KEY=value` line, or None. Same reading as parse_env_file."""
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    if stripped.startswith("export "):
        stripped = stripped[len("export "):].lstrip()
    key, separator, _ = stripped.partition("=")
    if not separator:
        return None
    return key.strip() or None


def _write_private(path: Path, text: str) -> None:
    """Write `text` where nothing but this account can read it."""
    tmp = path.parent / f".{path.name}.wip-{os.getpid()}"
    try:
        # Created with the mode, so the secret is never on disk world-readable.
        handle = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, FILE_MODE)
        try:
            stream = os.fdopen(handle, "w", encoding="utf-8")
        except BaseException:
            # Only until `fdopen` owns the descriptor.
            os.close(handle)
            raise
        with stream:
            stream.write(text)
        os.replace(tmp, path)
        # The mode again, in case the file existed with another one.
        os.chmod(path, FILE_MODE)
    except OSError as error:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise ConfigError(
            f"cannot write {display_path(path)}: {error}") from error
