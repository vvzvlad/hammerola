"""The gzipped tar of a model's SOURCE tree, and the local refusals around it.

WHAT GOES IN is the source, not a build: `model.py`, `project.json`, whatever
`scripts/` and `ref/` the project keeps. The hub computes the geometry itself
now (SPEC 8A.2), so shipping an `out/` would be shipping the answer to the
question being asked.

NEVER SHELL OUT TO `tar`. Two things go wrong when you do, both of them
observed: `tar -czf x.tar.gz .` writes an entry for `.` itself and one per
subdirectory, and macOS `tar` adds an AppleDouble `._name` member beside every
file that carries an extended attribute. The hub skips directory entries and
refuses `._name` on the alphabet, so the first is noise and the second is a
publish that fails for a reason nobody can see in their own checkout. `tarfile`
writes exactly the members it is given.

HIDDEN ENTRIES ARE DROPPED, NOT REFUSED, and that single rule does most of the
excluding here. `SAFE_COMPONENT` requires an alphanumeric first character, so
`.git`, `.venv`, `.pytest_cache`, `.DS_Store`, an AppleDouble `._model.py` and
`.gitignore` are all names the hub CANNOT accept — and refusing on them would
mean no ordinary repository could ever be published. Dropping them is right on
the merits too: nothing a build reads is hidden.

The consequence worth saying out loud is `.env`. It is hidden, so it never
enters the archive, and that is not incidental — it is where the publish token
lives on a laptop. The token travels in one HTTP header and nowhere else; the
same rule is stated in `config.py` from the other end.

A NON-HIDDEN NAME THAT STILL CANNOT BE A MEMBER IS A REFUSAL, not a skip. A
skipped `My Model.py` produces a build that is missing a file and fails inside
the hub with a message about an import; a refusal names the file while the
author is still looking at it. Same reasoning as `Store._unpack`, which refuses
rather than skips for the same reason.
"""

import fnmatch
import io
import tarfile
from dataclasses import dataclass
from pathlib import Path

from src.client.limits import (
    MAX_BUILD_BYTES,
    MAX_MEMBERS,
    MAX_PATH_DEPTH,
    SAFE_COMPONENT,
)

# Directories that are build output, a virtualenv or a package cache. Every
# hidden one (`.git`, `.venv`, `.tox`, `.pytest_cache`) is already gone by the
# rule above; these are the ones that are not hidden and would otherwise be
# packed. `_out` cannot be a member anyway — a leading underscore fails
# SAFE_COMPONENT — and is listed so it is DROPPED rather than refused, because
# it is the output directory the model Makefiles have always used.
EXCLUDED_DIRS = frozenset({
    "__pycache__", "node_modules", "venv", "out", "_out", "build", "dist",
    "htmlcov", "site-packages",
})

# File patterns, matched against the base name.
EXCLUDED_FILES = ("*.pyc", "*.pyo", "*~")


class PackError(Exception):
    """The tree cannot be sent as it stands, and here is which file is why."""


@dataclass(frozen=True)
class Packed:
    """One archive, ready to POST."""

    body: bytes
    names: tuple
    unpacked_bytes: int

    @property
    def size(self) -> int:
        return len(self.body)


def collect(root: Path) -> list:
    """Every file that goes into the archive, as (member path, real path).

    Sorted, so two runs over an unchanged tree produce byte-identical archives
    and a diff of two of them means something.
    """
    root = Path(root)
    found = []
    _walk(root, root, (), found)
    found.sort(key=lambda item: item[0])

    if not found:
        raise PackError(
            f"{root} holds no source files to publish (everything under it is "
            f"hidden or excluded)")
    if len(found) > MAX_MEMBERS:
        raise PackError(
            f"{len(found)} files to publish, and the hub accepts at most "
            f"{MAX_MEMBERS} per push.\n"
            f"  Something that is not source is being packed — check for an "
            f"output or cache directory this tool does not know to skip.")
    return found


def _walk(root: Path, directory: Path, prefix: tuple, found: list) -> None:
    for entry in sorted(directory.iterdir(), key=lambda path: path.name):
        name = entry.name
        if name.startswith("."):
            continue

        if entry.is_symlink():
            # The hub refuses links outright, whatever they point at, so a tree
            # that relies on one cannot be published as it stands. Said here,
            # naming the link, instead of as a 422 after the upload.
            raise PackError(
                f"{_shown(root, entry)} is a symlink, and the hub refuses "
                f"links: it has no way to know the file is inside the push.\n"
                f"  Replace it with the file itself.")

        if entry.is_dir():
            if name in EXCLUDED_DIRS:
                continue
            _check_component(root, entry, name)
            if len(prefix) + 1 >= MAX_PATH_DEPTH:
                # +1 for the directory itself, `>=` because anything inside it
                # would be one deeper still. Refused at the directory rather
                # than at each of its files, so the message names the level that
                # has to move rather than one arbitrary leaf.
                raise PackError(
                    f"{_shown(root, entry)} is nested deeper than the hub "
                    f"accepts: a file's path may be at most {MAX_PATH_DEPTH} "
                    f"components, the file name included.")
            _walk(root, entry, prefix + (name,), found)
            continue

        if not entry.is_file():
            raise PackError(
                f"{_shown(root, entry)} is not a regular file, and only regular "
                f"files can be published.")
        if any(fnmatch.fnmatch(name, pattern) for pattern in EXCLUDED_FILES):
            continue
        _check_component(root, entry, name)
        found.append(("/".join(prefix + (name,)), entry))


def _check_component(root: Path, entry: Path, name: str) -> None:
    if SAFE_COMPONENT.match(name):
        return
    raise PackError(
        f"{_shown(root, entry)} cannot be published: every part of a file's "
        f"path has to match {SAFE_COMPONENT.pattern}, and {name!r} does not.\n"
        f"  Rename it — the hub applies the same rule and would refuse the "
        f"whole push.")


def _shown(root: Path, path: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def pack(root: Path, max_bytes: int = MAX_BUILD_BYTES) -> Packed:
    """Collect the tree and gzip it. Raises PackError, never writes to disk.

    In memory rather than through a temporary file: what a source tree weighs is
    kilobytes, the body has to be held for the POST anyway, and a file written
    into the project would be one more thing to exclude from the NEXT push.

    Both ceilings the hub applies are checked here — the unpacked total and the
    body — with its DEFAULT number, since the deployment's real one is unknown
    (see `limits.MAX_BUILD_BYTES`).
    """
    members = collect(Path(root))

    total = 0
    for member, path in members:
        try:
            total += path.stat().st_size
        except OSError as error:
            raise PackError(f"cannot read {member}: {error}") from error
    if total > max_bytes:
        raise PackError(
            f"the source tree unpacks to {total / 1e6:.1f} MB and the hub's "
            f"ceiling is {max_bytes / 1e6:.0f} MB")

    buffer = io.BytesIO()
    try:
        with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
            for member, path in members:
                tar.add(str(path), arcname=member, recursive=False,
                        filter=_scrub)
    except OSError as error:
        raise PackError(f"cannot pack {root}: {error}") from error

    body = buffer.getvalue()
    if len(body) > max_bytes:
        raise PackError(
            f"the archive is {len(body) / 1e6:.1f} MB and the hub's ceiling is "
            f"{max_bytes / 1e6:.0f} MB")
    return Packed(body=body, names=tuple(name for name, _ in members),
                  unpacked_bytes=total)


def _scrub(info: tarfile.TarInfo) -> tarfile.TarInfo:
    """Strip everything about the machine that packed this.

    The hub reads a member's name, type and content and nothing else, so uid,
    group, mode and mtime are pure leakage — whose laptop, which user, when. Two
    of them are also the reason an unchanged tree used to produce a different
    archive on every run: with mtime and ownership zeroed, the same sources pack
    to the same bytes, which makes a local comparison of two archives mean
    something. It does not affect the hub's own idea of "the same push" either
    way — its digest is over the file CONTENTS (`Store.accept_sources`).
    """
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mode = 0o644
    info.mtime = 0
    return info
