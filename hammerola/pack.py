"""The gzipped tar of a model's SOURCE tree, and the local refusals around it.

WHAT GOES IN is the source, not a build: `model.py`, `project.json`, any
`scripts/` and `ref/`. The hub computes the geometry itself (SPEC 8A.2).

`tarfile`, never the `tar` binary: `tar` adds entries for directories and, on
macOS, AppleDouble `._name` members that the hub refuses.

HIDDEN ENTRIES ARE DROPPED, NOT REFUSED. `SAFE_COMPONENT` requires an
alphanumeric first character, so `.git`, `.venv`, `.DS_Store`, `._model.py`
can never be members, and nothing a build reads is hidden. In particular `.env`,
where the token lives, never enters the archive (see `config.py`).

A non-hidden name that still cannot be a member is REFUSED, not skipped: a
skipped `My Model.py` would fail inside the hub as a missing import. The walk
collects every refusal and reports them all in one message. The path alphabet
itself is deliberate (SPEC §7.1).
"""

import fnmatch
import gzip
import io
import tarfile
from dataclasses import dataclass
from pathlib import Path

from hammerola.limits import (
    MAX_MEMBERS,
    MAX_PATH_DEPTH,
    SAFE_COMPONENT,
)

# Non-hidden names that regenerate on their own (caches, virtualenvs, generic
# output directories), so the author is not asked to sweep them before every
# push. Hidden ones are already dropped.
#
# `_out/` and `_out.tar.gz` (written by `make build` in a model repository) are
# deliberately NOT excluded: they fail SAFE_COMPONENT and are refused by name,
# so a push never goes out while its author believes `_out/` went with it.
EXCLUDED_DIRS = frozenset({
    "__pycache__", "node_modules", "venv", "out", "build", "dist",
    "htmlcov", "site-packages",
})

# Directory patterns, matched against the base name: KiCad's `<project>-backups/`,
# the zipped copies it writes on every save.
EXCLUDED_DIR_PATTERNS = ("*-backups",)

# File patterns, matched against the base name; same rule as the directories.
# `~*` and `_autosave-*` are what a KiCad with the project open keeps beside it:
# `~board.kicad_pcb.lck` and `_autosave-board.kicad_pcb`.
EXCLUDED_FILES = ("*.pyc", "*.pyo", "*~", "~*", "_autosave-*")

# How many paths of one kind a refusal lists. Past it, the problem is a
# directory that should not be packed at all, and the tail line says so.
MAX_REFUSALS_LISTED = 100


class PackError(Exception):
    """The tree cannot be sent as it stands, and here is which file is why."""


@dataclass(frozen=True)
class Refusal:
    """One thing in the tree that cannot be sent, and which group it is in."""

    kind: str
    path: str
    detail: str = ""


# The kinds, in the order a message lists them, each with the sentence that
# introduces the group and the one action that clears it. All kinds are
# collected in one walk; grouping keeps the different fixes apart. The
# directory group adds that nothing inside it was looked at (see `_walk`).
REFUSAL_GROUPS = (
    ("name",
     f"These files cannot be published under the names they have — every "
     f"component of a path has to match {SAFE_COMPONENT.pattern}. Rename each "
     f"one, or delete it if it is build output: only sources are published, and "
     f"a local build writes its output back every time it runs. The hub applies "
     f"the same rule and would refuse the whole push:"),
    ("dirname",
     f"These directories cannot be published under the names they have, by the "
     f"same rule ({SAFE_COMPONENT.pattern}). Rename each one, or delete it if "
     f"it is build output, which a local build writes back every time it runs — "
     f"nothing inside them was looked at, so expect more once they are dealt "
     f"with:"),
    ("depth",
     f"These are nested deeper than the hub accepts — a file's path may be at "
     f"most {MAX_PATH_DEPTH} components, the file name included. Move them up; "
     f"what is inside them was not looked at:"),
    ("symlink",
     "These are symlinks, and the hub refuses links whatever they point at: it "
     "has no way to know the file is inside the push. Replace each with the "
     "file itself:"),
    ("special",
     "These are not regular files, and only regular files can be published:"),
    ("unreadable",
     "These directories cannot be listed by this account, so what is inside "
     "them is unknown:"),
)

# Fallback section for a kind added to `_walk` without a group, so it cannot go
# missing from the message (`tests/client/test_pack.py` also compares the sets).
UNGROUPED_HEADLINE = "These cannot be published, and this tool has no advice:"


@dataclass(frozen=True)
class Packed:
    """One archive, ready to POST."""

    body: bytes
    names: tuple

    @property
    def size(self) -> int:
        return len(self.body)


def collect(root: Path) -> list:
    """Every file that goes into the archive, as (member path, real path).

    Sorted, so two runs over an unchanged tree produce byte-identical archives
    and a diff of two of them means something.

    A tree that cannot be sent is refused with every reason, in one message.
    """
    root = Path(root)
    found = []
    refusals = []
    _walk(root, root, (), found, refusals)

    if refusals:
        # Before the checks below: a tree whose every file was refused leaves
        # `found` empty, and "everything is hidden or excluded" would be wrong.
        raise PackError(_refusal_message(root, refusals))

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


def _walk(root: Path, directory: Path, prefix: tuple, found: list,
          refusals: list) -> None:
    """One directory, appending its files to `found` and its faults to `refusals`.

    Nothing here raises: every fault is recorded so one run sees the whole
    tree, and the caller builds the PackError.
    """
    try:
        entries = sorted(directory.iterdir(), key=lambda path: path.name)
    except OSError as error:
        # Unlistable, or gone since the parent's listing. `strerror` rather
        # than `str(error)`, which repeats the path.
        refusals.append(Refusal("unreadable", _shown(root, directory),
                                _shown_text(error.strerror or str(error))))
        return
    for entry in entries:
        name = entry.name
        if name.startswith("."):
            continue

        if entry.is_symlink():
            # The hub refuses links outright. Not followed: a link could walk
            # somebody else's tree, or this one twice.
            refusals.append(Refusal("symlink", _shown(root, entry)))
            continue

        if entry.is_dir():
            if name in EXCLUDED_DIRS or any(
                    fnmatch.fnmatch(name, pattern)
                    for pattern in EXCLUDED_DIR_PATTERNS):
                continue
            if not SAFE_COMPONENT.match(name):
                # Not entered: for build output like `_out/` the fix is to
                # delete it, and listing its contents would only be noise.
                refusals.append(Refusal("dirname", _shown(root, entry)))
                continue
            if len(prefix) + 1 >= MAX_PATH_DEPTH:
                # +1 for the directory itself, `>=` because anything inside it
                # is deeper still. Recorded at the directory and not entered:
                # this ceiling is also what bounds the recursion.
                refusals.append(Refusal("depth", _shown(root, entry)))
                continue
            _walk(root, entry, prefix + (name,), found, refusals)
            continue

        if not entry.is_file():
            refusals.append(Refusal("special", _shown(root, entry)))
            continue
        if any(fnmatch.fnmatch(name, pattern) for pattern in EXCLUDED_FILES):
            continue
        if not SAFE_COMPONENT.match(name):
            refusals.append(Refusal("name", _shown(root, entry)))
            continue
        found.append(("/".join(prefix + (name,)), entry))


def _refusal_message(root: Path, refusals: list) -> str:
    """Everything the walk refused, grouped, in the order REFUSAL_GROUPS sets."""
    lines = [f"{root} cannot be published as it stands, and every path below "
             f"has to be dealt with before the next push."]
    known = {kind for kind, _ in REFUSAL_GROUPS}
    groups = list(REFUSAL_GROUPS)
    # Anything `_walk` produced that no group claims goes in one final section
    # rather than nowhere; see UNGROUPED_HEADLINE.
    if any(item.kind not in known for item in refusals):
        groups.append((None, UNGROUPED_HEADLINE))
    for kind, headline in groups:
        listed = [item for item in refusals
                  if (item.kind == kind if kind is not None
                      else item.kind not in known)]
        if not listed:
            continue
        lines.append("")
        lines.append(f"  {headline}")
        for item in listed[:MAX_REFUSALS_LISTED]:
            suffix = f" ({item.detail})" if item.detail else ""
            lines.append(f"    {item.path}{suffix}")
        if len(listed) > MAX_REFUSALS_LISTED:
            lines.append(
                f"    ... and {len(listed) - MAX_REFUSALS_LISTED} more. That is "
                f"past the point of fixing them one by one — look for a "
                f"directory that should not be packed at all.")
    return "\n".join(lines)


def _shown(root: Path, path: Path) -> str:
    """One path as a refusal prints it: relative and escaped.

    Escaped because a file name can hold control characters or a newline.
    `repr` escapes what `str.isprintable()` rejects, so cyrillic stays legible,
    and its quotes make a trailing space visible.
    """
    try:
        shown = path.relative_to(root).as_posix()
    except ValueError:
        shown = str(path)
    return _shown_text(shown)


def _shown_text(text: str) -> str:
    """The escaping on its own, for the strings that are not paths.

    Used for a refusal's `detail`, whose fallback (`str(error)`) carries the
    full path and so needs the same escaping.
    """
    return repr(text)


def pack(root: Path) -> Packed:
    """Collect the tree and gzip it. Raises PackError, never writes to disk.

    In memory: the body is held for the POST anyway. Compressed through
    `gzip.GzipFile(mtime=0)` rather than `tarfile.open("w:gz")`, which stamps
    the current second into the gzip header, so two packs of one tree would
    differ whenever they straddle a second.
    """
    members = collect(Path(root))

    buffer = io.BytesIO()
    try:
        with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0) as compressed, \
                tarfile.open(fileobj=compressed, mode="w") as tar:
            for member, path in members:
                tar.add(str(path), arcname=member, recursive=False,
                        filter=_scrub)
    except OSError as error:
        raise PackError(f"cannot pack {root}: {error}") from error

    body = buffer.getvalue()
    return Packed(body=body, names=tuple(name for name, _ in members))


def _scrub(info: tarfile.TarInfo) -> tarfile.TarInfo:
    """Strip everything about the machine that packed this.

    The hub reads only a member's name, type and content, so uid, group, mode
    and mtime are leakage. Zeroing them also makes the same sources pack to
    the same bytes. The hub's digest is over file contents
    (`Store.accept_sources`) either way.
    """
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mode = 0o644
    info.mtime = 0
    return info
