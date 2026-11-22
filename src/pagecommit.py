"""The set of file changes the Files window commits, decided without git.

`POST /api/v1/source/<pid>/commit` (src/app.py) carries a message and a list of
changes to the files of the project directory: a file written, one deleted, one
moved. This module is the half of the answer that needs no repository: the body
is checked here, and the changes are laid against two file maps — path to
`(mode, blob sha)` — of the build the window showed (`base`) and of the
branch's tip, which says what to commit and what refuses. Reading the maps,
writing the commit and building it are `prereceive.commit_changes`.

A refusal is a `ChangeRefused`: the status, and the JSON the page reads.
"""

import re
from dataclasses import dataclass

# The id of a blob a change names: a full lowercase sha.
BLOB_ID = re.compile(r"\A[0-9a-f]{40}\Z")

# What `git update-index --index-info` reads as "take this path out".
REMOVE_MODE = "0"
REMOVE_ID = "0" * 40

# A file the window creates. Making a file executable is not something the
# page can do, so a new path never gets `100755`.
NEW_FILE_MODE = "100644"

# A path segment git drops without a word from an index it is given
# (`Ignoring path .git/config`, rc 0), in any case.
GIT_SEGMENT = ".git"

NO_MESSAGE = "the commit needs a message"
NO_CHANGES = "`changes` must be a non-empty list"

# Gitea's words for a path whose folder and file collide
# (`ChangeRepoFiles`), as the window's users meet them there.
FILE_IN_THE_WAY = ("a file exists where you’re trying to create a "
                   "subdirectory: {path}")
FOLDER_IN_THE_WAY = ("a directory exists where you’re trying to create a "
                     "file: {path}")
ALREADY_THERE = "{path} already exists"


class ChangeRefused(Exception):
    """A set of changes the hub will not commit: the status to answer with and
    the JSON body, `{"error": ...}` and what else the page reads."""

    def __init__(self, status: int, error: str, **extra):
        super().__init__(error)
        self.status = status
        self.payload = {"error": error, **extra}


@dataclass(frozen=True)
class Change:
    """One entry of `changes`, checked.

    `blob` is the bytes to write, None for a delete; a move (`source` set) with
    no `blob` carries the old file's bytes. `over` skips the conflict check for
    this change.
    """

    path: str
    blob: str | None
    source: str | None = None
    over: bool = False

    @property
    def sets(self) -> bool:
        """Does the change put a file at `path`?"""
        return self.blob is not None or self.source is not None

    @property
    def unsets(self) -> str | None:
        """The path the change takes a file from, if any: the one a delete
        names and a move's old one."""
        if self.source is not None:
            return self.source
        return None if self.sets else self.path

    @property
    def touched(self) -> tuple:
        return (self.path,) if self.source is None else (self.path, self.source)


def parse_message(payload: dict) -> str:
    """The commit's message, trimmed. Raises ChangeRefused when it is not a
    string or is empty."""
    message = payload.get("message")
    if not isinstance(message, str) or not message.strip():
        raise ChangeRefused(422, NO_MESSAGE)
    return message.strip()


def parse_changes(payload: dict) -> list:
    """`payload["changes"]` as `Change`s. Raises ChangeRefused naming what is
    wrong: a malformed entry, a path git would drop, or two entries that
    disagree about one path."""
    entries = payload.get("changes")
    if not isinstance(entries, list) or not entries:
        raise ChangeRefused(422, NO_CHANGES)
    changes = [_parse_change(entry) for entry in entries]
    _refuse_repeats(changes)
    return changes


def blob_ids(changes: list) -> list:
    """The blobs the changes name, each once, in order."""
    return list(dict.fromkeys(
        change.blob for change in changes if change.blob is not None))


def decide(changes: list, base: dict, tip: dict, base_name: str) -> list:
    """The changes still to make, laid against the files of the build the
    window showed (`base`) and of the branch's tip.

    A change whose every path is at the tip already as the set leaves it is
    done and drops out: the agent made the same edit, or this is a repeat of a
    request that went through. A move drops out only as a whole. Of the rest, a
    change that is not `over` conflicts when any path it touches differs
    between `base` and `tip` — by blob, so a mode change alone is none — and
    all the conflicts together refuse with 409, listing each conflicting
    change's `path`, and its `source` when that one differs. A move's `source`
    must be a file of `base`. A change that dropped out as done comes back when
    a change still to make takes a file from its path (a move's old path that
    the set writes anew): the removal would otherwise leave that path empty.
    -> [] when nothing is left to do.
    """
    for change in changes:
        if change.source is not None and change.source not in base:
            raise ChangeRefused(
                422, f"{change.source} is not in build {base_name}")
    wanted = {change.unsets: None for change in changes
              if change.unsets is not None}
    wanted.update({change.path: _blob_of(change, base)
                   for change in changes if change.sets})
    remaining, conflicts = [], []
    for change in changes:
        if all(_blob_at(tip, path) == wanted[path] for path in change.touched):
            continue
        remaining.append(change)
        if change.over:
            continue
        differing = [path for path in change.touched
                     if _blob_at(base, path) != _blob_at(tip, path)]
        if differing:
            conflicts += [change.path] + [
                path for path in differing if path != change.path]
    if conflicts:
        conflicts = list(dict.fromkeys(conflicts))
        raise ChangeRefused(
            409, "changed on the hub since the editor opened: "
                 + ", ".join(conflicts), conflicts=conflicts)
    while True:
        cleared = {change.unsets for change in remaining
                   if change.unsets is not None}
        back = [change for change in changes if change not in remaining
                and change.sets and change.path in cleared]
        if not back:
            return [change for change in changes if change in remaining]
        remaining += back


def index_records(changes: list, base: dict, tip: dict) -> list:
    """`[(mode, blob sha, path), ...]` for `git update-index --index-info`:
    the removals first, then the writes. `changes` is what `decide` left.

    Refuses, before git can swallow it, a path whose folder is a file of the
    result, one that is a folder of it, and a move onto a file of the tip that
    the set does not take away unless it is `over` (it then replaces it). The
    result is the tip's files, less what the set removes, plus what it writes.
    A write over a file keeps the tip's mode, a move keeps the old file's mode
    in `base`, and a new path gets `NEW_FILE_MODE`.
    """
    removed = [change.unsets for change in changes
               if change.unsets is not None]
    gone = set(removed)
    written = {change.path: _blob_of(change, base)
               for change in changes if change.sets}
    result = {path for path in tip if path not in gone} | set(written)
    folders = {folder for path in result for folder in _folders(path)}
    for change in changes:
        if not change.sets:
            continue
        for folder in _folders(change.path):
            if folder in result:
                raise ChangeRefused(422, FILE_IN_THE_WAY.format(path=folder))
        if change.path in folders:
            raise ChangeRefused(
                422, FOLDER_IN_THE_WAY.format(path=change.path))
        if (change.source is not None and not change.over
                and change.path in tip and change.path not in gone):
            raise ChangeRefused(422, ALREADY_THERE.format(path=change.path))
    records = [(REMOVE_MODE, REMOVE_ID, path) for path in removed]
    for change in changes:
        if change.sets:
            records.append((_mode_of(change, base, tip), written[change.path],
                            change.path))
    return records


def _parse_change(entry) -> Change:
    if not isinstance(entry, dict):
        raise ChangeRefused(422, "every change must be an object")
    path = _parse_path(entry.get("path"))
    source = _parse_path(entry["from"]) if "from" in entry else None
    if "blob" in entry:
        blob = entry["blob"]
        if blob is not None and not (isinstance(blob, str)
                                     and BLOB_ID.match(blob)):
            raise ChangeRefused(
                422, f"`blob` must be a 40-digit lowercase hex id or null: "
                     f"{path}")
        if source is not None and blob is None:
            raise ChangeRefused(
                422, f"a move takes `blob` as a 40-digit hex id or not at "
                     f"all: {path}")
    elif source is None:
        raise ChangeRefused(422, f"`blob` is missing: {path}")
    else:
        blob = None
    over = False
    if "over" in entry:
        if entry["over"] is not True:
            raise ChangeRefused(422, f"`over` must be true or absent: {path}")
        over = True
    return Change(path=path, blob=blob, source=source, over=over)


def _parse_path(path) -> str:
    """A path relative to the project directory, as the list of files writes it."""
    if not isinstance(path, str):
        raise ChangeRefused(422, "`path` and `from` must be strings")
    segments = path.split("/")
    if ("\0" in path or path.startswith("/") or path.endswith("/")
            or any(not segment or segment in (".", "..")
                   or segment.lower() == GIT_SEGMENT
                   for segment in segments)):
        raise ChangeRefused(422, f"not a path of the project: {path!r}")
    return path


def _refuse_repeats(changes: list) -> None:
    written = [change.path for change in changes if change.sets]
    removed = [change.unsets for change in changes
               if change.unsets is not None]
    for path in _repeated(written):
        raise ChangeRefused(422, f"{path} is written twice")
    for path in _repeated(removed):
        raise ChangeRefused(422, f"{path} is removed twice")
    written = set(written)
    for change in changes:
        if change.unsets == change.path and change.path in written:
            raise ChangeRefused(
                422, f"{change.path} is both removed and written")


def _repeated(paths: list) -> list:
    seen, again = set(), []
    for path in paths:
        if path in seen:
            again.append(path)
        seen.add(path)
    return again


def _folders(path: str) -> list:
    """The folders above `path`, from the top: `a/b/c` -> `a`, `a/b`."""
    segments = path.split("/")[:-1]
    return ["/".join(segments[:count]) for count in range(1, len(segments) + 1)]


def _blob_at(files: dict, path: str) -> str | None:
    entry = files.get(path)
    return None if entry is None else entry[1]


def _blob_of(change: Change, base: dict) -> str:
    """The bytes a change writes: its own, or the old file's for a move."""
    return change.blob if change.blob is not None else base[change.source][1]


def _mode_of(change: Change, base: dict, tip: dict) -> str:
    if change.source is not None:
        return base[change.source][0]
    return tip[change.path][0] if change.path in tip else NEW_FILE_MODE
