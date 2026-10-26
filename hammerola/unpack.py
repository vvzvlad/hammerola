"""Reading an archive the hub serves: the skill and the starter template.

Members are checked again here although the hub refused the same things on
the way in (`src/archive.py`, SPEC 7.1): this writes onto the author's machine,
and a compromised or wrong hub must not be able to write
`../.ssh/authorized_keys`.

Not `tarfile.extractall(filter="data")`: `filter=` needs Python 3.11.4+, and
the client must run on older ones (`hammerola/__init__.py`). The rules below
(the hub's alphabet) are stricter anyway.

The ceilings are the push's (`limits.py`), checked against the member headers
before anything is written. A member that yields more bytes than its header
declares is a damaged archive, and it is refused rather than written past the
size the header promised.
"""

import io
import re
import tarfile
from pathlib import Path
from typing import NamedTuple

from hammerola.errors import ClientError
from hammerola.limits import (
    MAX_MEMBERS,
    MAX_PATH_DEPTH,
    SAFE_COMPONENT,
)

# Copy chunk size, so a member that lied about its size is caught partway.
CHUNK = 64 * 1024


class Rules(NamedTuple):
    """What a member's path may look like, as a pair of answers.

    `component` is the alphabet EVERY component has to be on. `hidden_leaves` is
    a set of exact names the LAST component may be instead — nothing else, and
    never a directory.
    """

    component: re.Pattern
    hidden_leaves: frozenset = frozenset()


# What a pushed archive may hold, and the default everywhere: the hub's own
# alphabet, applied to every component, with no exceptions at all.
PUSH_RULES = Rules(SAFE_COMPONENT)

# The starter template `hammerola create` fetches from
# `<hub>/start/template.tar.gz`, which must be able to write a `.gitignore`.
#
# An EXACT name in the LAST component, never "a leading dot is allowed": that
# would accept `.git/config`, whose `core.fsmonitor` is a shell command the next
# `git status` runs. Every entry here is a file the hub can drop into a fresh
# checkout.
TEMPLATE_RULES = Rules(SAFE_COMPONENT, frozenset({".gitignore"}))


def read_members(body: bytes, where: str = "the archive",
                 rules: Rules = PUSH_RULES) -> dict:
    """Every file in the archive as `{path: bytes}`, checked. Never touches disk.

    For `diff`, and for `create`, which checks the template before writing.
    """
    members = {}
    with _open(body, where) as tar:
        for info in _checked(tar, where, rules):
            handle = tar.extractfile(info)
            if handle is None:
                # A regular file whose content cannot be read is a corrupt
                # archive, not a member to skip: skipping would make the diff
                # say the file is empty.
                raise ClientError(
                    f"{where} is damaged: {info.name!r} has no contents")
            members[info.name] = handle.read()
    return members


def extract(body: bytes, dest: Path, where: str = "the archive",
            rules: Rules = PUSH_RULES) -> list:
    """Unpack the archive under `dest`. -> the member paths, sorted.

    `dest` is created if needed. Directories are created here rather than
    taken from the archive's own entries, as the hub does.
    """
    dest = Path(dest)
    written = []
    with _open(body, where) as tar:
        for info in _checked(tar, where, rules):
            target = dest.joinpath(*info.name.split("/"))
            # Defence in depth over an already-checked name.
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.parent.resolve().relative_to(dest.resolve())
            except ValueError as error:
                raise ClientError(
                    f"{where} holds a member that would be written outside "
                    f"{dest}: {info.name!r}") from error
            except OSError as error:
                raise ClientError(
                    f"cannot create {target.parent}: {error}") from error
            source = tar.extractfile(info)
            if source is None:
                raise ClientError(
                    f"{where} is damaged: {info.name!r} has no contents")
            try:
                with open(target, "wb") as out:
                    _copy(source, out, info, where)
            except OSError as error:
                raise ClientError(f"cannot write {target}: {error}") from error
            written.append(info.name)
    return sorted(written)


def _copy(source, out, info, where: str) -> None:
    """Move one member, refusing to write more than its header declared.

    tarfile does not promise to stop at the declared size, and bytes past it
    mean the archive is damaged.
    """
    remaining = info.size
    while True:
        chunk = source.read(min(CHUNK, remaining + 1))
        if not chunk:
            return
        remaining -= len(chunk)
        if remaining < 0:
            raise ClientError(
                f"{where} is damaged: {info.name!r} holds more bytes than its "
                f"header declares")
        out.write(chunk)


def _open(body: bytes, where: str):
    try:
        return tarfile.open(fileobj=io.BytesIO(body), mode="r:gz")
    except (tarfile.TarError, EOFError, OSError) as error:
        raise ClientError(
            f"{where} is not a readable .tar.gz: {error}") from error


def _checked(tar, where: str, rules: Rules = PUSH_RULES) -> list:
    """The members that may be unpacked, or a refusal naming the first that may not.

    Refuses rather than skips: a dropped member would show up in `diff` as a
    deleted file.
    """
    try:
        infos = tar.getmembers()
    except (tarfile.TarError, EOFError, OSError) as error:
        raise ClientError(f"{where} is damaged: {error}") from error

    files = [info for info in infos if not info.isdir()]
    if len(files) > MAX_MEMBERS:
        raise ClientError(
            f"{where} holds {len(files)} members and at most {MAX_MEMBERS} are "
            f"accepted")

    for info in files:
        if not info.isfile():
            # Links, devices, fifos: the hub refuses them on the way in.
            raise ClientError(
                f"{where} holds {info.name!r}, which is not a regular file; "
                f"only regular files are unpacked")
        check_name(info.name, where, rules)
        if info.size < 0:
            raise ClientError(f"{where} is damaged: {info.name!r} has no size")
    return files


def check_name(name: str, where: str = "the archive",
               rules: Rules = PUSH_RULES) -> None:
    """One member path: `/`-separated, every component on the rules' alphabet.

    The alphabet makes traversal impossible: `SAFE_COMPONENT` requires an
    alphanumeric first character, so `..`, `.`, empty components and a leading
    `/` fail, and no backslash or colon can appear.

    `hidden_leaves` applies only to the last component (see TEMPLATE_RULES).

    Public: the hub checks the template tree with this same function before
    serving it (`src/onboarding._refuse_unservable`).
    """
    parts = name.split("/")
    if not name or len(parts) > MAX_PATH_DEPTH:
        raise ClientError(
            f"{where} holds {name!r}, whose path is deeper than the "
            f"{MAX_PATH_DEPTH} components a push may carry")
    last = len(parts) - 1
    for index, part in enumerate(parts):
        if rules.component.match(part):
            continue
        if index == last and part in rules.hidden_leaves:
            continue
        raise ClientError(
            f"{where} holds {name!r}: every part of a member's path has to "
            f"match {rules.component.pattern}, and {part!r} does not"
            + (f" (the only exception is a file named "
               f"{', '.join(sorted(rules.hidden_leaves))})"
               if rules.hidden_leaves else "") + ".\n"
            "  Nothing was written — an archive naming a path like that "
            "did not come from a push this hub accepted.")
