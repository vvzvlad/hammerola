"""Reading a revision's archive back: in memory for `diff`, onto disk for `source`.

WHY THE MEMBERS ARE CHECKED AGAIN HERE, when the hub already refused everything
this refuses on the way in (`Store._unpack`, SPEC 7.1). Because "the other side
validated it" is not a control on the machine doing the WRITING. What runs here
runs on the author's laptop, under their account, with their home directory in
reach, and it is being handed a tar by a network service over a token that a
compromised hub — or a hub somebody was talked into pointing at — also holds. A
tar member named `../.ssh/authorized_keys` costs nothing to refuse and everything
to accept once.

It is also not the same check twice for a second reason: what the hub enforces is
what it will SERVE, and it may relax that one day for its own reasons. This one is
about what may be written into somebody's directory, and the two happen to agree
today.

NOT `tarfile.extractall(filter="data")`. The filter is the right idea and it is
what a fresh interpreter would use, but this tool has to import and run under
whatever python3 a laptop has (`hammerola/__init__.py`), and `filter=` arrived in
3.11.4/3.12 — on an older one the keyword is a TypeError and the default is the
unfiltered extraction. The rules below are stricter anyway, because they are the
hub's own alphabet rather than a general-purpose safety net.

THE CEILINGS ARE THE SAME NUMBERS THE PUSH USES, from `limits.py`, and they are
what makes this safe against an archive that is small on the wire and enormous
unpacked: the total is counted from the member headers before a byte is written,
and again as it is written, because a header can lie.
"""

import io
import re
import tarfile
from pathlib import Path
from typing import NamedTuple

from hammerola.errors import ClientError
from hammerola.limits import (
    MAX_BUILD_BYTES,
    MAX_MEMBERS,
    MAX_PATH_DEPTH,
    SAFE_COMPONENT,
)

# How much of one member is moved at a time. A source file is kilobytes; this
# exists so that a member which lied about its size is caught partway rather than
# after it has been written whole.
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

# The one archive that is NOT a push: the starter template `hammerola create`
# fetches from `<hub>/start/template.tar.gz`. It has to be able to write a
# `.gitignore`, which a push never can — `SAFE_COMPONENT` requires an
# alphanumeric first character, which is exactly why `pack.py` DROPS hidden
# entries on the way up.
#
# AN EXACT NAME IN THE LAST COMPONENT, and not "a leading dot is allowed". The
# wider rule was written first and it was a remote code execution: applied per
# component it also accepts `.git/config` and `.ssh/authorized_keys`, and the
# first of those is executed by the next `git status` anybody runs in the
# project — `core.fsmonitor` is a shell command, git does not overwrite an
# existing config on `git init`, and the skill tells the author to commit
# `project.json`. Writing INSIDE the project directory is no defence when
# `.git/` is inside the project directory.
#
# So the exception is exactly as wide as its reason: one file name, in the leaf
# position, where a name cannot name a directory to descend into. Adding an
# entry here is adding a file the hub can drop into somebody's fresh checkout —
# weigh it against what reads that file and when.
TEMPLATE_RULES = Rules(SAFE_COMPONENT, frozenset({".gitignore"}))


def read_members(body: bytes, where: str = "the archive",
                 rules: Rules = PUSH_RULES) -> dict:
    """Every file in the archive as `{path: bytes}`, checked. Never touches disk.

    For `diff`, which compares two revisions' sources and has no reason to write
    either of them anywhere — and for `create`, which has to know what the
    template would write before it writes any of it.
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

    `dest` is created if it is not there. Directories are created by this
    function rather than taken from the archive, exactly as the hub does it: a
    tar's own directory entries carry modes and can be members of shapes nobody
    wants, and every path here is already known to be a chain of checked
    components.
    """
    dest = Path(dest)
    written = []
    with _open(body, where) as tar:
        for info in _checked(tar, where, rules):
            target = dest.joinpath(*info.name.split("/"))
            # Defence in depth over an already-checked name: the components
            # cannot be `.`, `..` or absolute, so this can only fail if the rule
            # above is loosened one day. It costs one resolve per file.
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

    The header is the only thing the ceilings were counted from, so a member that
    goes on producing bytes past its declared size would be a way past all of
    them. tarfile does not itself promise to stop.
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

    REFUSES RATHER THAN SKIPS, for the reason `pack.py` gives from the other
    direction: a silently dropped member produces a tree that is missing a file
    and fails later at something that looks unrelated. Here it would be worse
    still — a `diff` would report the missing file as deleted.
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

    total = 0
    for info in files:
        if not info.isfile():
            # Symlinks, hard links, devices, fifos. The hub refuses all of them
            # on the way in, so one arriving here means the archive did not come
            # from a push this hub accepted.
            raise ClientError(
                f"{where} holds {info.name!r}, which is not a regular file; "
                f"only regular files are unpacked")
        check_name(info.name, where, rules)
        if info.size < 0:
            raise ClientError(f"{where} is damaged: {info.name!r} has no size")
        total += info.size
        if total > MAX_BUILD_BYTES:
            raise ClientError(
                f"{where} unpacks to more than "
                f"{MAX_BUILD_BYTES / 1e6:.0f} MB, which is past the ceiling a "
                f"push is allowed; nothing was written")
    return files


def check_name(name: str, where: str = "the archive",
               rules: Rules = PUSH_RULES) -> None:
    """One member path: `/`-separated, every component on the rules' alphabet.

    That alphabet is what makes traversal impossible rather than a separate
    check: `SAFE_COMPONENT` requires an alphanumeric first character, so `..`,
    `.`, an empty component and a leading `/` are all outside it, and a
    backslash or a colon cannot appear anywhere in a component either.

    `hidden_leaves` is the one way past it and it is checked ONLY on the last
    component — an exact name, in a position that cannot be descended into. Any
    exception applied to every component would accept `.git/config` and
    `.ssh/authorized_keys`, and the first of those is a shell command the next
    `git status` runs.

    PUBLIC because there is a second caller and it must not be a second COPY of
    this loop: the hub checks the template tree against these very rules before
    it serves it (`src/onboarding._refuse_unservable`). A hand-written copy there
    already drifted once — it checked the alphabet and forgot the depth, so the
    hub built and served an archive its own client then refused.
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
