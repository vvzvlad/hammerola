"""Where the hub's address and the token come from, and how they got there.

Three places, first hit wins:

  1. the process environment     — a one-off `HUB_URL=... hammerola build`, and
                                   how CI passes the organisation secrets.
  2. `.env` in the project       — optional, for overriding a single model.
  3. `~/.config/hammerola/env`   — this machine's settings, same `KEY=value`
                                   format, written once and read by every model
                                   directory on it.

The third one is what `hammerola login` WRITES (`write_settings` below), and it
is deliberately the last place looked at rather than the first: a login is the
machine's standing answer, and both an explicit env var and a project's own
`.env` are more specific than that.

NEITHER SETTING HAS A DEFAULT, and HUB_URL is the one where that is a project
rule rather than a preference (AGENTS.md): the address of our own service is
never guessed. When nothing carries it the answer is an error naming the file to
write, and it is raised BEFORE the tree is walked or packed, so `hammerola` on
an unconfigured machine fails in a second instead of after a minute of work.

THE TOKEN IS NEVER PRINTED. Not in an error, not in a banner, not in a
traceback. Its length and where it was found are printable; its value is not —
an edit token that reaches a terminal scrollback or a CI log is an edit token
that has to be rotated, and there is no smaller one to rotate: this is the whole
system's secret. The same rule is why `pack.py` drops `.env` from
the archive, why `login` reads it with `getpass` instead of taking it as an
argument (a command line is in the shell's history and in every `ps` on the
machine), and why the file it lands in is created 0600.

ONE SECRET FOR THE WHOLE SYSTEM, decided 2026-08-27 (SPEC §8 entry 26) and true
on BOTH SIDES since step 0 of the plan: `EDIT_TOKEN` is the only credential this
tool knows and the only one the hub declares. There is no second key for the
comment queue, and there was one — the hub used to check `PUBLISH_TOKEN` on a
push and `COMMENT_READ_TOKEN` on the queue, which meant a deployment could set
them differently and get a client that published perfectly while `hammerola
comments` answered 401. That failure mode is gone, along with the sentence
`hub.py` used to print about it.

Vaultwarden is deliberately NOT a fourth source. `cad_publish` shelled out to
`rbw` here; `login` writes the file instead, and the note that used to stand
here about per-person tokens still holds — the hub compares one shared secret
for equality, so "logging in" means storing that secret and nothing more.
"""

import os
from pathlib import Path

HUB_URL_VAR = "HUB_URL"
EDIT_TOKEN_VAR = "EDIT_TOKEN"

# Which machine-wide file to read. An override rather than a constant so a test
# run cannot be steered — or rescued — by the developer's real settings; the
# default is what an actual run uses.
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
    """The bearer token. The VALUE is returned and never logged or printed."""
    hint = EDIT_TOKEN_HINT.format(file=display_path(machine_env_file()))
    return _require(EDIT_TOKEN_VAR, hint, project_dir)


# -- the write half: what `hammerola login` puts in the machine file ---------
# The mode the file is created with and forced back to on every write. It holds
# the one secret of the whole system, so `0600` is the point of the exercise
# rather than tidiness — and it is applied AFTER the rename as well, because a
# file that already existed keeps whatever mode it had.
FILE_MODE = 0o600
DIRECTORY_MODE = 0o700


def write_settings(values: dict, path: Path = None) -> Path:
    """Store `KEY -> value` in the machine's env file. Returns where it landed.

    EVERY OTHER LINE OF THE FILE SURVIVES. A key that is already there is
    rewritten in place, one that is not is appended, and everything else —
    comments, blank lines, settings this tool does not know about — is copied
    through untouched. Writing the file from a parsed dict instead would be the
    same operation with one silent side effect: `login` would delete whatever
    somebody else's tool, or a future setting, had put in there.

    Written through a temporary file and renamed, so an interrupted login leaves
    the previous settings intact rather than a truncated file: this is the file
    that holds the credential, and the run that discovers it is empty is the
    next push.

    THE NEW TEXT IS READ BACK BEFORE IT IS WRITTEN, with the same parser every
    run uses, and the write only happens if every value survives that. It closes
    the way this could fail quietly — a value the `KEY=value` format cannot
    carry would otherwise be stored as something else and noticed as a 401 days
    later — and the ORDER is what makes the failure harmless: checking after the
    write would leave the wrong token in the file it just reported an error
    about.
    """
    path = machine_env_file() if path is None else Path(path)
    for name, value in values.items():
        check_storable(name, value)

    parent = path.parent
    # Only a directory this call CREATES is narrowed. `HAMMEROLA_ENV_FILE` can
    # name any path, and chmod-ing a directory that was already there would mean
    # a login could tighten a directory holding somebody else's files.
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

    A token is one of these, so nothing in this message may echo it — the
    refusal names the variable and the shape, and the caller decides what to say
    about it.

    Public because `login` asks it of the password the MOMENT it is typed,
    before the value is used for anything. A credential that cannot be stored
    must not be tried against the hub first: a line break in it is also a line
    break in an `Authorization` header, which is a request nobody meant to send.
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
        # come back as the thing INSIDE them. Refused here rather than left to
        # the read-back check in `write_settings`, so the answer arrives at the
        # prompt that produced it instead of after a round trip to the hub.
        raise ConfigError(
            f"{name} cannot be stored: it begins and ends with a quote "
            f"character, and this file format takes one layer of those off "
            f"again when it reads a value back")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        # Wider than the line-break rule above and kept separate from it because
        # the reason differs: a NUL or a form feed is not a line the parser
        # would mis-split, it is a byte nothing downstream handles predictably.
        # This file holds one secret; a value with a C0 control in it is a paste
        # that went wrong, whatever the parser would do with it.
        raise ConfigError(
            f"{name} cannot be stored: it contains a control character")


def header_value_problem(value):
    """Why `value` cannot travel as an HTTP header value, or None. No echo.

    THE PREDICATE, SHARED BY THE TWO PLACES THAT ASK IT, and shared rather than
    written twice because they answer for the same wire: `check_sendable_as_header`
    below is what `login` asks at the prompt, and `hub._refuse_unsendable_token`
    is what catches a token that never went through `login` — out of the
    environment, or out of a hand-edited file. Two copies of this would have
    drifted into the state that made the split necessary in the first place,
    where a password the prompt accepted was refused by the constructor a few
    lines later.

    The reason is returned rather than raised so each caller can put it in its
    own sentence: the advice differs completely, and "run `hammerola login`" is
    wrong when said to somebody who is running `hammerola login`.

    THE WIDTH IS A DECISION, not a limit of the wire. A TAB is legal in a header
    value and http.client would send one; it is refused here anyway, because a
    secret with a tab in it is a paste that went wrong. Latin-1 is the limit of
    the wire: `http.client` encodes header values with it, so anything outside
    it cannot be sent at all.
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

    THE COMPANION TO `check_storable`, AND SEPARATE FROM IT ON PURPOSE. That one
    is about this FILE and is asked of everything written to it, `HUB_URL`
    included; this one is about the `Authorization` header and is asked only of
    the secret. They stay apart because the two values are answerable to
    different things, and the answers are not the same shape: a token has to
    survive one header, while an ADDRESS has to survive three encodings in a row
    — the request line's ASCII, the `Host` header's latin-1 and the host's IDNA,
    which also bounds every dotted label at 63 characters. `hub._origin` is
    where that is asked, by performing the encodings rather than describing
    them, and it is strictly stricter than a latin-1 rule would be.

    THE JUSTIFICATION THAT USED TO STAND HERE WAS FALSE and is named so it is
    not restored: it said `https://хаб.example` is a legal address urllib
    resolves through IDNA, so a latin-1 rule in `check_storable` would reject a
    working hub. It is not legal for this client — it reaches the wire and dies
    on the `Host` header — and `_origin` now refuses it outright. The split is
    right for the reason above; that example was not a reason for anything.

    `login` asks both, at the prompt, which is what makes the constructor's
    check in `hub.py` unreachable from inside `login` — it advises running
    `hammerola login`, and saying that to somebody already running it was a loop
    with no way out of it.
    """
    problem = header_value_problem(value)
    if problem is not None:
        raise ConfigError(
            f"{name} cannot be used as the hub's password: {problem}.\n"
            f"  Nothing was saved. (The value is not shown here.)")


def _merge_env_text(text: str, values: dict) -> str:
    """The file's text with `values` applied, everything else left alone."""
    remaining = dict(values)
    lines = []
    for line in text.splitlines():
        key = _assigned_key(line)
        if key is None or key not in remaining:
            lines.append(line)
            continue
        # `export ` is kept when it was there: the file is also something a
        # person can `source`, and dropping the keyword would change what that
        # does for a line this call did not come to change the meaning of.
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
        # `os.open` with the mode rather than `write_text` and a chmod after:
        # the window between the two is a window in which the secret is on disk
        # world-readable, and it is the file's whole reason for existing.
        handle = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, FILE_MODE)
        try:
            stream = os.fdopen(handle, "w", encoding="utf-8")
        except BaseException:
            # Only until `fdopen` has taken the descriptor over. Closing it
            # after that point would close a descriptor the stream still owns —
            # and one another thread may by then have been given.
            os.close(handle)
            raise
        with stream:
            stream.write(text)
        os.replace(tmp, path)
        # The mode again, because the file may have existed with another one:
        # os.replace keeps the SOURCE's mode, but a file created 0644 by an
        # older version and then rewritten would otherwise keep 0644 forever.
        os.chmod(path, FILE_MODE)
    except OSError as error:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise ConfigError(
            f"cannot write {display_path(path)}: {error}") from error
