"""One stored tar, read into a directory, and everything it refuses.

A revision published before git arrived as a gzipped tar, packed by the
owner's client or by hand with `tar`, and the hub kept it in `sources/`. The
import into git (`Store._import_build`) reads it back through this module, by
the rules that once accepted it: it opens the archive, walks it member by
member and writes a source tree into a staging directory `src/store.py` made.
Nothing here knows what a project or a build is, and nothing here is served.

What it guards against is MISTAKES. The path rules are a second line behind
the packer: a bug there that lets `../` or an absolute path into a member name
must not turn into a write outside staging. The ceilings are there so that an
honest error — the wrong directory packed — comes back as a refusal saying
what was measured.

WHAT IT REFUSES. Every one of these fails the import of the whole project
rather than skipping a member, and that is the point: a skipped member produces
a commit that is missing a file and looks fine.

  * a member name that is not a RELATIVE PATH of `SAFE_COMPONENT` components,
    `/`-separated and at most `MAX_PATH_DEPTH` deep. `../`, `/etc/passwd`,
    `a/../../b`, `a//b` and `a/./b` are all rejected on the name alone —
    before the member's TYPE is even considered — because no component may be
    empty, `.` or `..`, and none may start with a dot at all;
  * anything that is not a regular file. Links above all, but devices and
    fifos too; a directory ENTRY is skipped rather than refused, because
    directories are created by US, from the paths of the files that need them;
  * two members whose paths fold to one name on a filesystem ignoring case;
  * an archive carrying more members than the ceiling below admits — the
    refusal says what it was measured against;
  * an archive that is corrupt, whichever way the parser fails on it.

THE DISK IS NOT THE ARCHIVE: a failure of the archive comes back as a
`PublishError`, a failure of the filesystem (ENOSPC above all) stays an
OSError; the import reports either as `ImportFailed` (`Store._import_build`).
`_is_the_disk` keeps the two apart, including inside the handlers that refuse
by where a failure happened rather than by its type.

It refuses with `PublishError` and imports nothing else from the service:
`store` imports this module, and the edge only goes that way.
"""

import errno
import gzip
import hashlib
import os
import re
import tarfile
import zlib
from pathlib import Path

from loguru import logger

from src.errors import PublishError

# ONE `/`-separated COMPONENT of a member's path. Dots are allowed (file
# extensions) but a component must START alphanumeric, so `.hidden`, `.`, `..`
# and the empty string are out, and the class has no `/`, backslash, NUL or
# non-ASCII: a component can never be a separator, a traversal hop or a
# lookalike of one.
# `\Z` for the same reason `store.SAFE_ID` gives: `$` also matches just before a
# trailing newline, so `^...$` would let "model.stl\n" through.
MAX_COMPONENT_CHARS = 128
SAFE_COMPONENT = re.compile(
    rf"\A[A-Za-z0-9][A-Za-z0-9._-]{{0,{MAX_COMPONENT_CHARS - 1}}}\Z")

# Ceiling on the DEPTH of a member's path, counted in components including the
# file name itself: `model.py` is 1, `scripts/gen/parts.py` is 3.
#
# Model sources are shallow, and the bound keeps the longest path (8 x 128
# characters plus separators, 1031 bytes, plus the deepest staging prefix) far
# below PATH_MAX (4096 on Linux), so a legal archive cannot cause ENAMETOOLONG.
# It also caps the walk at 8 `mkdir`+`openat` pairs per member.
MAX_PATH_DEPTH = 8

# Ceiling on the number of entries in one archive, directory entries included —
# every entry costs an iteration whether or not anything is extracted from it.
#
# Per member: one `openat`, one write loop and ~1 KiB in the duplicate map
# (~1 MiB worst case). It governs syscalls and bookkeeping, not bytes: the
# archive's size has no ceiling.
MAX_MEMBERS = 1024

# How many refused member names one 422 carries.
#
# The refusal counts every bad name but lists at most this many (a tar packed
# with `.git/` has hundreds). Each name goes through `repr()`, so control characters
# and lone surrogates print as escapes while cyrillic stays legible.
MAX_REFUSED_NAMES_REPORTED = 10


# The common fault, stated once in the refusal's opening sentence rather than
# beside each name; depth faults are annotated per name.
ALPHABET_FAULT = "forbidden path component"

# Errnos meaning "this archive's own layout is impossible" (a parent that is
# another member's file, a name taken by a directory, a symlink component): a
# 422. Everything else, ENOSPC above all, stays an OSError and a 500. Do not
# widen it, or a full volume is reported as a bad archive.
LAYOUT_ERRNOS = frozenset({errno.EEXIST, errno.ENOTDIR, errno.EISDIR,
                           errno.ELOOP, errno.ENAMETOOLONG})

# What a damaged archive can raise after the header: the member table, data and
# gzip CRC are read lazily during iteration and `read()`. `gzip.BadGzipFile` is
# named because it subclasses OSError, which otherwise means "the disk failed".
CORRUPT_ARCHIVE_ERRORS = (tarfile.TarError, EOFError, zlib.error, gzip.BadGzipFile)

# Copy buffer.
CHUNK = 64 * 1024


# -- member paths ----------------------------------------------------------
def _member_parts(name: str) -> tuple[list[str], str]:
    """Split one member name into path components. -> (parts, why not, or "").

    `name` has a leading `./` removed. Returns the fault rather than raising,
    so the walk can collect every bad name; `parts` is meaningful only when the
    fault is empty.

    Every traversal shape is refused by the component rule alone:

      * `../evil` and `a/../../b` — a `..` component does not start alphanumeric;
      * `/etc/passwd` and a leading `/` — splitting gives an EMPTY first
        component, and the empty string does not match either;
      * `a//b` — an empty component in the middle, same clause;
      * `a/./b` and a trailing `a/` — `.` and `` again;
      * `a\\..\\b`, a NUL, a non-ASCII lookalike — none of those characters is in
        the class at all.
    """
    parts = name.split("/")
    if len(parts) > MAX_PATH_DEPTH:
        return parts, f"{len(parts)} path components deep"
    for part in parts:
        if not SAFE_COMPONENT.match(part):
            return parts, ALPHABET_FAULT
    return parts, ""


def _is_the_disk(error: BaseException) -> bool:
    """Whether a failure raised inside `tarfile` is the FILESYSTEM's, not the archive's.

    The broad handlers below refuse by where a failure happened, not by type;
    but `tarfile` reads through the gzip layer off the disk, so a real read
    error (EIO) is raised from the same calls and must not become "corrupt
    archive". An OSError that is not in CORRUPT_ARCHIVE_ERRORS is the disk's;
    anything that is not an OSError at all stays the pusher's.
    """
    return (isinstance(error, OSError)
            and not isinstance(error, CORRUPT_ARCHIVE_ERRORS))


def _members_of(tar):
    """Iterate an archive, turning any failure of the PARSER into a 422.

    By where, not by type: a malformed sparse map raises ValueError and a long
    chain of pax pseudo-headers raises RecursionError, neither a TarError.
    `_is_the_disk` lets real read failures through. Only the iteration is
    wrapped, never the loop body, so our own bugs stay 500s.
    """
    iterator = iter(tar)
    while True:
        try:
            member = next(iterator)
        except StopIteration:
            return
        except Exception as error:
            if _is_the_disk(error):
                # Not the archive. Let it go up to `unpack`'s own OSError arm,
                # which logs it and keeps it a 500.
                raise
            raise PublishError(
                422, f"archive is corrupt: {repr(str(error))}") from error
        yield member


def _refused_names_error(refused: list, count: int) -> PublishError:
    """The one 422 for every member name this archive cannot have.

    `refused` is (name already escaped, why not), at most
    MAX_REFUSED_NAMES_REPORTED of them; `count` is the real total. The rule is
    stated once, in the opening sentence.
    """
    listed = ", ".join(
        shown + ("" if fault == ALPHABET_FAULT else f" ({fault})")
        for shown, fault in refused)
    hidden = count - len(refused)
    return PublishError(
        422,
        f"unsafe archive member names: {count} of them. Every component "
        f"of a member's path must match {SAFE_COMPONENT.pattern}, and a path "
        f"may be at most {MAX_PATH_DEPTH} components deep. Names are shown "
        f"escaped: {listed}"
        + (f", and {hidden} more" if hidden > 0 else "")
        # After the first bad name the walk checked only names, so fixing them
        # may surface a different refusal.
        + ". Nothing else about this archive was checked once the first of "
          "these was found — links and duplicate names among them")


def _open_member_dir(dest_fd: int, parts: list[str], raw_name: str) -> int:
    """Create and open one member's directory chain, one component at a time.

    Returns a descriptor for the directory the member's file belongs in; the
    caller closes it unless it IS `dest_fd`, which the caller owns.

    No path of more than one component is ever handed to the kernel: each is
    created with `mkdirat` and opened with `openat` under
    O_NOFOLLOW|O_DIRECTORY, so a symlink at any level is ELOOP and a regular
    file is ENOTDIR. A planted symlink is never followed.

    Directories are ours: mode 0o755, created from the paths of the files that
    need them. EEXIST is accepted: members share parents.
    """
    current = dest_fd
    for part in parts:
        try:
            os.mkdir(part, 0o755, dir_fd=current)
        except FileExistsError:
            # Made by an earlier member, or something else, which the open
            # below decides (a dangling symlink lands here too).
            pass
        except OSError:
            if current != dest_fd:
                os.close(current)
            raise
        try:
            opened = os.open(
                part,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=current)
        except OSError as error:
            if error.errno in LAYOUT_ERRNOS:
                raise PublishError(
                    422,
                    f"archive member {raw_name!r} cannot be unpacked: {part!r} "
                    f"is not a directory this archive is allowed to write "
                    f"through") from error
            raise
        finally:
            if current != dest_fd:
                os.close(current)
        # On the descriptor, unconditionally: `mkdir`'s mode is filtered by the
        # umask, and under `umask 077` the `app` user could not read the build.
        try:
            os.fchmod(opened, 0o755)
        except OSError:
            os.close(opened)
            raise
        current = opened
    return current


def _create_member_file(parent_fd: int, leaf: str, raw_name: str) -> int:
    """Create one member's file inside an already-opened directory. -> fd.

    O_EXCL and O_NOFOLLOW. A name already taken by a directory (a member
    `a/b.py` after a member `a`) is a layout error and comes out as a 422.
    """
    try:
        return os.open(
            leaf,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
            0o644,
            dir_fd=parent_fd)
    except OSError as error:
        if error.errno in LAYOUT_ERRNOS:
            raise PublishError(
                422,
                f"archive member {raw_name!r} cannot be created: {leaf!r} is "
                f"already taken by something else in this archive") from error
        raise


def unpack(body_path: Path, dest: Path) -> dict:
    """Extract the archive into `dest`, refusing anything unusual.

    Not `tar.extractall(filter="data")`: that clamps permissions and strips
    special files, where this refuses the whole push. A member must be a
    regular file whose name is a relative path of `SAFE_COMPONENT` components.
    """
    # The gzip layer is opened here, not by `tarfile`, so the open has its own
    # arm and the stream is ours to close. `mode="r:"`: `tarfile` gets an
    # uncompressed stream.
    files: dict[str, str] = {}
    # Outside the block: it creates what the block releases. It reads nothing
    # (the header is parsed lazily), so it can only fail on the filesystem
    # (EMFILE, EIO, ENOENT); logged with the same "failed on the filesystem"
    # wording as the arm below, so one grep finds every disk failure.
    try:
        stream = gzip.open(body_path, "rb")
    except OSError as error:
        logger.error(
            f"opening {body_path} failed on the filesystem: {error}")
        raise
    # One `finally` over everything: a TarFile does not close a file object it
    # was handed.
    try:
        try:
            tar = tarfile.open(fileobj=stream, mode="r:")
        except Exception as error:
            # By where, not by type, as in `_members_of`: `TarFile.__init__`
            # parses the first header. `_is_the_disk` passes real read
            # failures to the outer `except OSError` arm.
            if _is_the_disk(error):
                raise
            raise PublishError(
                422, f"body is not a gzipped tar: {repr(str(error))}") from error

        # Resolved once: every member's landing spot is compared against this.
        real_dest = os.path.realpath(dest)
        try:
            _extract_members(tar, dest, real_dest, files)
        except CORRUPT_ARCHIVE_ERRORS as error:
            # A truncated body or a member lying about its size fails here,
            # when the data and CRC are actually read.
            raise PublishError(
            422, f"archive is corrupt: {repr(str(error))}") from error
    except OSError as error:
        # Not a 422: the disk said no. Covers both writing extracted files and
        # reading the body (handed on by `_is_the_disk`), hence around the whole
        # block, including `tarfile.open`. The log line attributes the failure
        # to the filesystem; `PublishError` is not an OSError, so deliberate
        # refusals pass through.
        logger.error(
            f"unpacking into {dest} failed on the filesystem: {error}")
        raise
    finally:
        stream.close()

    if not files:
        raise PublishError(422, "archive is empty")
    return files


def _extract_members(tar, dest: Path, real_dest: str, files: dict) -> None:
    """The member loop of `unpack`. Fills `files` with path -> sha256.

    Split out so the caller can wrap the whole walk in one place. Keys of
    `files` are relative paths with `/` separators.
    """
    # Folded PATH -> the path that claimed it, for the message below.
    seen_names: dict[str, str] = {}
    # Bad member names as (name already escaped, why not), plus their count,
    # collected so one 422 names them all. After the first, the walk becomes a
    # survey: nothing more is extracted and no other check runs, so a later
    # link or duplicate cannot raise and lose the list. The list stops at
    # MAX_REFUSED_NAMES_REPORTED; the count does not.
    refused: list[tuple[str, str]] = []
    refused_count = 0
    # Held open for the whole walk; everything is opened relative to it, so no
    # path prefix can be swapped underneath.
    dest_fd = os.open(dest, os.O_RDONLY | os.O_DIRECTORY)
    try:
        with tar:
            for index, member in enumerate(_members_of(tar)):
                if index >= MAX_MEMBERS:
                    raise PublishError(
                        422, f"archive has more than {MAX_MEMBERS} members")

                name = member.name
                if name.startswith("./"):
                    name = name[2:]

                # Directory entries (e.g. from `tar -czf x .`) are skipped:
                # directories are created from the file paths, with our mode.
                if member.isdir():
                    continue

                # Name first: an absolute path, a `..` hop, an empty
                # component or a `.` component can never match the
                # whitelist, so traversal is refused before the member type
                # is even looked at.
                parts, fault = _member_parts(name)
                if fault or refused_count:
                    # Surveying.
                    if fault:
                        refused_count += 1
                        if len(refused) < MAX_REFUSED_NAMES_REPORTED:
                            # Escaped here, so the list is printable.
                            refused.append((repr(member.name), fault))
                    continue

                # Then the type: links could write outside the build
                # directory; devices and fifos do not belong in a build.
                if member.issym() or member.islnk():
                    raise PublishError(
                        422,
                        f"archive member {name!r} is a link; links are refused")
                if not member.isfile():
                    raise PublishError(
                        422,
                        f"archive member {name!r} is not a regular file "
                        f"(type {member.type!r})")
                # Case-insensitively over the whole path: APFS and Docker
                # Desktop bind mounts fold case, so `a/File` and `A/file`
                # collide while `a/model.py` and `b/model.py` do not.
                folded = "/".join(parts).lower()
                if folded in seen_names:
                    raise PublishError(
                        422,
                        f"archive member {name!r} appears twice (names are "
                        f"compared case-insensitively over the whole path: "
                        f"the filesystem may not tell {name!r} from "
                        f"{seen_names[folded]!r})")

                source = tar.extractfile(member)
                if source is None:
                    raise PublishError(
                        422,
                        f"archive member {name!r} has no readable content")

                digest = hashlib.sha256()
                target = dest.joinpath(*parts)
                # Second, independent defence: ask the filesystem where the
                # write would land. realpath follows symlinks over the whole
                # prefix. `real_dest + os.sep`, not `real_dest`, so
                # `<staging>-evil/` is refused.
                real_target = os.path.realpath(target)
                if not real_target.startswith(real_dest + os.sep):
                    raise PublishError(
                        422,
                        f"archive member {member.name!r} would be written "
                        f"outside the build directory")

                # Third, race-free: the component-by-component walk with
                # O_NOFOLLOW|O_DIRECTORY (`_open_member_dir`).
                parent_fd = _open_member_dir(dest_fd, parts[:-1], member.name)
                try:
                    # O_EXCL: never overwrite. O_NOFOLLOW: never follow a
                    # symlink at the leaf, atomically.
                    fd = _create_member_file(parent_fd, parts[-1], member.name)
                finally:
                    if parent_fd != dest_fd:
                        os.close(parent_fd)
                try:
                    out = os.fdopen(fd, "wb")
                except BaseException:
                    # `fdopen` owns `fd` only once it succeeds.
                    os.close(fd)
                    raise
                with out:
                    # On the descriptor, inside the `with`: `open`'s mode is
                    # filtered by the umask.
                    os.fchmod(out.fileno(), 0o644)
                    while True:
                        chunk = source.read(CHUNK)
                        if not chunk:
                            break
                        digest.update(chunk)
                        out.write(chunk)
                files["/".join(parts)] = digest.hexdigest()
                seen_names[folded] = name
    finally:
        os.close(dest_fd)

    if refused_count:
        raise _refused_names_error(refused, refused_count)
