"""One uploaded tar, read into a directory, and everything it refuses.

A push arrives as a gzipped tar, packed by the owner's client or by hand with
`tar`. This module is the door it comes through: it opens the archive, walks it
member by member and writes a source tree into a staging directory
`src/store.py` made. Nothing here knows what a project or a build is, and
nothing here is served.

What it guards against is MISTAKES. The path rules are a second line behind
the packer: a bug there that lets `../` or an absolute path into a member name
must not turn into a write outside staging. The ceilings are there so that an
honest error — the wrong directory packed, a gigantic file in `ref/` — comes
back as a refusal saying what was measured, not as a full volume or a 500.

WHAT IT REFUSES. Every one of these is a refusal of the whole push rather than
a skipped member, and that is the point: a skipped member produces a build that
is missing a file and looks fine.

  * a member name that is not a RELATIVE PATH of `SAFE_COMPONENT` components,
    `/`-separated and at most `MAX_PATH_DEPTH` deep. `../`, `/etc/passwd`,
    `a/../../b`, `a//b` and `a/./b` are all rejected on the name alone —
    before the member's TYPE is even considered — because no component may be
    empty, `.` or `..`, and none may start with a dot at all;
  * anything that is not a regular file. Links above all, but devices and
    fifos too; a directory ENTRY is skipped rather than refused, because
    directories are created by US, from the paths of the files that need them;
  * two members whose paths fold to one name on a filesystem ignoring case;
  * an archive carrying more members or more bytes than the ceilings below
    admit — each of which says what it was measured against;
  * an archive that is corrupt, whichever way the parser fails on it.

THE DISK IS NOT THE ARCHIVE, and the rule holds absolutely: a failure of the
archive is the pusher's and comes back as a refusal, while a failure of the
filesystem — ENOSPC above all — stays an OSError and becomes a 500. Answering
"your archive is corrupt" to a dying volume sends the pusher off to debug a
file that is fine. `_is_the_disk` is what keeps the two apart, including inside
the handlers that refuse by WHERE a failure happened rather than by its type.

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

# ONE COMPONENT of a member's path inside the uploaded tar. The archive carries a
# TREE now — a model's source is `model.py`, `enclosure.py`, `scripts/`, `ref/` —
# so a member name is a relative path and this is the rule each of its
# `/`-separated pieces has to pass. The alphabet is exactly the one a whole member
# name had to match while the archive was flat, which is what makes the move to
# trees an addition rather than a relaxation: dots are allowed (file extensions)
# but a component must START alphanumeric, so `.hidden`, `.`, `..` and the empty
# string are all out, and the class contains no `/`, no backslash, no NUL and
# nothing outside ASCII — so a component can never itself be a separator, a
# traversal hop, or a lookalike of one in some other script.
# `\Z` for the same reason `store.SAFE_ID` gives: `$` also matches just before a
# trailing newline, so `^...$` would let "model.stl\n" through.
MAX_COMPONENT_CHARS = 128
SAFE_COMPONENT = re.compile(
    rf"\A[A-Za-z0-9][A-Za-z0-9._-]{{0,{MAX_COMPONENT_CHARS - 1}}}\Z")

# Ceiling on the DEPTH of a member's path, counted in components including the
# file name itself: `model.py` is 1, `scripts/gen/parts.py` is 3.
#
# Eight, for two reasons that both need a number rather than "deep enough". A
# model's source is shallow by nature (`ref/vendor/rev2/part.step` is 4 and
# already contrived), so eight leaves room without inviting anything. And it
# bounds the longest path this can produce: 8 components of 128 characters plus 7
# separators is 1031 bytes, which added to the deepest staging path the hub can
# build — data dir, `project/`, a 64-character pid, `.tmp-` + a 64-character
# commit + a 32-hex uuid — stays far below PATH_MAX (4096 on Linux). Without a
# ceiling here a legal archive could push a path past it and turn a publish into
# an ENAMETOOLONG deep inside extraction, i.e. a 500 on an archive that broke no
# rule. It also caps the directory walk at 8 `mkdir`+`openat` pairs per member.
MAX_PATH_DEPTH = 8

# Ceiling on the number of entries in one archive, directory entries included —
# every entry costs an iteration whether or not anything is extracted from it.
#
# 1024 rather than the 256 that fitted a flat build: what arrives is now a source
# TREE, where a `scripts/` and a `ref/` with a few dozen files each are ordinary,
# and 256 is close enough to a real project to be hit by an honest push. 1024 is
# still far below anything that costs us: the work per member is one `openat` and
# one write loop, and the only state kept per member is its path in the
# duplicate map — 1024 × ~1 KiB worst case, ~1 MiB, against four concurrent
# publish slots. The bytes are bounded separately and much lower (see
# `max_build_bytes`), so this number governs SYSCALLS and bookkeeping, not disk.
MAX_MEMBERS = 1024

# How many refused member names one 422 carries.
#
# A refusal names EVERY member whose path this hub cannot take, not just the
# first (issue #42): a `ref/` holding nineteen cyrillic file names is one rename
# job, and answering one name at a time made it nineteen pushes. But a tar packed
# by hand together with `.git/` carries hundreds of such names, and a 422 listing
# all of them cannot be read; ten say "this is not one file", and the total is
# reported beside them. The side that names every single one is the client,
# before anything is sent (`hammerola/pack.py`). Each name goes through `repr()`,
# so a control character, or the lone surrogate `tarfile` decodes undecodable
# bytes into, prints as an escape while a cyrillic name still reads as one.
MAX_REFUSED_NAMES_REPORTED = 10


# The fault nearly every refused name has, and the one the message does NOT
# repeat beside each name: the opening sentence of the refusal already states
# the alphabet, so annotating ten names with it is the repetition the message
# exists to avoid. Depth is the rare one and does get said, per name.
ALPHABET_FAULT = "forbidden path component"

# Errno values that mean "this archive's own layout is impossible", as opposed to
# "the disk said no". A member whose parent directory is another member's file, a
# file name already taken by a directory, a component that turned out to be a
# symlink: every one of those is the pusher's problem and gets a 422. Everything
# else — ENOSPC above all — stays an OSError and becomes a 500, per the rule
# `unpack` spells out. Getting this set wrong in the generous direction is how a
# full volume starts being reported to the pusher as a bad archive.
LAYOUT_ERRNOS = frozenset({errno.EEXIST, errno.ENOTDIR, errno.EISDIR,
                           errno.ELOOP, errno.ENAMETOOLONG})

# Everything a damaged archive can raise once the header has been read. Opening
# the file proves the gzip header is there and nothing else: the member table, the
# per-member data and the gzip CRC are all read lazily, on the iteration and the
# `read()` calls further down, so this set is what actually decides whether a
# truncated upload is a 422 or a 500 with a stack trace.
#
# `gzip.BadGzipFile` is listed by name because it is a subclass of OSError, and
# OSError here means "the DISK failed" — a distinction worth keeping, since one of
# those is the pusher's problem and the other is ours.
CORRUPT_ARCHIVE_ERRORS = (tarfile.TarError, EOFError, zlib.error, gzip.BadGzipFile)

# Copy buffer for extraction. Small enough that the running total below is checked
# often, large enough not to syscall per byte.
CHUNK = 64 * 1024


# -- member paths ----------------------------------------------------------
def _member_parts(name: str) -> tuple[list[str], str]:
    """Split one member name into path components. -> (parts, why not, or "").

    `name` is what the archive said with a leading `./` removed, which is what
    actually gets checked. RETURNS the fault instead of raising it, so the walk
    can collect every unusable name in the archive and answer with all of them
    at once (issue #42); `parts` is meaningful only when the fault is
    empty.

    Everything a traversal needs is refused by the component rule alone, and it
    is worth listing which shape dies on which clause, because the whitelist
    reads like it only bans exotic characters:

      * `../evil` and `a/../../b` — a `..` component does not start alphanumeric;
      * `/etc/passwd` and a leading `/` — splitting gives an EMPTY first
        component, and the empty string does not match either;
      * `a//b` — an empty component in the middle, same clause;
      * `a/./b` and a trailing `a/` — `.` and `` again;
      * `a\\..\\b`, a NUL, a non-ASCII lookalike — none of those characters is in
        the class at all.

    So there is no separate list of forbidden shapes to keep in sync with the
    pattern: the pattern IS the list, applied per component.
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

    THE ONE EXCEPTION TO "CATCH BY FACT". The two broad handlers below refuse by
    WHERE the failure happened rather than by its type, because enumerating types
    is what let a `RecursionError` out as a 500. But `tarfile` reads the body off
    the disk through the gzip layer while it parses, so a genuine read error —
    EIO, and whatever else a failing volume produces — is raised from inside those
    same calls, and answering "your archive is corrupt" to it would send the
    pusher off to debug a file that is fine. That is the rule `unpack` states
    absolutely, and this is what keeps it absolute.

    THE TEST IS THE SET THAT ALREADY EXISTS rather than a second list of errnos:
    `CORRUPT_ARCHIVE_ERRORS` names `gzip.BadGzipFile` explicitly BECAUSE it is an
    OSError subclass, i.e. it already encodes which OSErrors are the archive's
    doing. Reusing it means the two mechanisms cannot drift apart — a fourth
    archive-shaped OSError added there is understood here on the same commit.
    Everything that is not an OSError at all (TarError, ValueError, RecursionError
    and every type nobody has met yet) stays the pusher's problem.
    """
    return (isinstance(error, OSError)
            and not isinstance(error, CORRUPT_ARCHIVE_ERRORS))


def _members_of(tar):
    """Iterate an archive, turning any failure of the PARSER into a 422.

    BY FACT, NOT BY TYPE. A sparse map whose numbers are not numbers raises a
    `ValueError`, and a long chain of pax pseudo-headers RECURSES until the
    interpreter raises `RecursionError`; neither is a TarError nor in
    CORRUPT_ARCHIVE_ERRORS, so a catch by type let both out as a 500 with a
    traceback about an archive that is simply broken. What decides is WHERE it
    was raised, and `tarfile` is what runs inside these calls.

    IT IS NOT THE ONLY THING RUNNING THERE: `tarfile` reads through the gzip
    layer, off the disk, so a real read failure is raised from inside the same
    call and would be answered as a corrupt archive. `_is_the_disk` is what lets
    it past.

    WRAPPING THE ITERATION AND NOT THE LOOP BODY is what makes a catch this broad
    safe: around our own code it would swallow our own bugs, which must stay 500s.
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

    `refused` is (name ALREADY escaped, why not), at most
    MAX_REFUSED_NAMES_REPORTED of them; `count` is how many there really were,
    which is a plain integer precisely so that the ones past the ceiling cost
    nothing to know about. The rule is stated ONCE, in the opening sentence,
    rather than repeated beside each name: with nineteen of them the repetition
    is the message and the list of names is what the pusher has to act on.
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
        # Said because it is not obvious and it changes what a green retry
        # means: from the first of these onwards the walk only looked at NAMES,
        # so links, duplicates and everything else went unchecked. Fixing the
        # names can therefore be answered by a different refusal rather than by
        # a publish, and that is not the hub changing its mind.
        + ". Nothing else about this archive was checked once the first of "
          "these was found — links and duplicate names among them")


def _open_member_dir(dest_fd: int, parts: list[str], raw_name: str) -> int:
    """Create and open one member's directory chain, one component at a time.

    Returns a descriptor for the directory the member's file belongs in; the
    caller closes it unless it IS `dest_fd`, which the caller owns.

    The whole point is that no path of more than one component is ever handed to
    the kernel. Each component is created with `mkdirat` and then opened with
    `openat` under O_NOFOLLOW|O_DIRECTORY, so a symlink at any level is an ELOOP
    rather than a redirection, and a regular file at any level is an ENOTDIR
    rather than a write into somebody else's file. That is what makes the
    "symlink planted by an earlier member" family of attacks structurally
    impossible rather than merely refused: the archive cannot create a symlink
    (links are rejected outright), and even if something else planted one between
    two members, this walk would not follow it.

    Directories are OURS: mode 0o755, never the mode a directory entry in the
    archive asked for, and created from the paths of the files that need them.
    A pre-existing directory is accepted (EEXIST) because two members of the same
    tree legitimately share a parent.
    """
    current = dest_fd
    for part in parts:
        try:
            os.mkdir(part, 0o755, dir_fd=current)
        except FileExistsError:
            # Already made by an earlier member of this same archive — or
            # already something else entirely, which the open below is what
            # decides. `mkdir` does not follow a symlink at the final component,
            # so a dangling symlink lands here too and is caught one line later.
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
        # On the descriptor, and unconditionally: `mkdir`'s mode argument is
        # filtered through the process umask, so a hub started under `umask 077`
        # would create 0o700 directories and the non-root `app` user would then
        # be unable to READ the build it just published. The files below get the
        # same treatment for the same reason.
        try:
            os.fchmod(opened, 0o755)
        except OSError:
            os.close(opened)
            raise
        current = opened
    return current


def _create_member_file(parent_fd: int, leaf: str, raw_name: str) -> int:
    """Create one member's file inside an already-opened directory. -> fd.

    O_EXCL and O_NOFOLLOW carry the same weight they did while the archive was
    flat. What the tree adds is a NEW way for an archive to be impossible — a
    member `a/b.py` after a member `a`, so the name is taken by a directory — and
    that has to come out as a 422 rather than as an unhandled OSError, which is
    a 500 with a stack trace about an archive that is plainly the pusher's fault.
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


def unpack(body_path: Path, dest: Path, max_build_bytes: int) -> dict:
    """Extract the archive into `dest`, refusing anything unusual.

    Deliberately NOT `tar.extractall(filter="data")`. That filter exists (it
    was backported to 3.11.4, and the image's python has it), but relying on
    it would make this depend on a runtime detail we do not pin, and it
    permits things we do not want at all — it merely CLAMPS permissions and
    strips special files, where we refuse the whole push. What is written
    here is a whitelist: a member has to be a regular file whose name is a
    relative path of `SAFE_COMPONENT` components, or nothing is published.

    Refusing rather than skipping is the point. A skipped member produces a
    build that is missing a file and looks fine, and the meta.json check
    `store` makes later would then fail with a confusing message about a broken
    link; refusing names the actual problem.
    """
    # The gzip layer is opened here rather than by `tarfile`, so opening the
    # body is a line with an arm of its own and the stream is OURS to close
    # (both below). `mode="r:"` because what `tarfile` is handed is already
    # an uncompressed tar stream.
    files: dict[str, str] = {}
    # `gzip.open` IS THE ONE LINE OUTSIDE THE BLOCK, because it is the line
    # that creates the thing the block has to release, and there is nothing
    # to close until it returns.
    #
    # `gzip.open` reads nothing here — the gzip header is parsed lazily on
    # the first read — so the only way this line fails is the open itself,
    # which is the disk and therefore a 500. BEING OUTSIDE THE BLOCK IS NOT
    # A REASON TO GO UNATTRIBUTED, so it carries a narrow arm of its own
    # instead. It is the first touch of the filesystem in this function and
    # it fails in the ordinary ways: EMFILE/ENFILE while several pushes are
    # unpacked at once (MAX_CONCURRENT_PUBLISHES), EIO on a volume that is
    # going, ENOENT if the spool went away underneath us. ENOSPC is the one
    # that does NOT arrive here, since this is an open for reading. Without
    # the arm, exactly one kind of disk failure in `unpack` would reach the
    # log as a bare traceback while every other kind named the file and the
    # cause — the same gap, one line up, that widening the arm below closed.
    # It says "failed on the filesystem" like that arm on purpose, so one
    # grep finds every unpack that died on the disk rather than on the
    # archive.
    try:
        stream = gzip.open(body_path, "rb")
    except OSError as error:
        logger.error(
            f"opening {body_path} failed on the filesystem: {error}")
        raise
    # ONE `finally` over the whole thing, because the gzip stream is OURS to
    # close: a TarFile releases only a file object it opened itself, so
    # handing one in moved this from explicit release to whenever the
    # collector happens to get to it. That is invisible until the day
    # something keeps a reference to the tarball — one traceback frame held
    # by a log handler is enough — in a process that stays up for weeks.
    try:
        try:
            tar = tarfile.open(fileobj=stream, mode="r:")
        except Exception as error:
            # BY FACT, NOT BY TYPE, exactly as in `_members_of` and for the
            # same reason: opening READS — `TarFile.__init__` parses the
            # first header — so every way the parser can fail arrives here
            # too, RecursionError from a chain of pseudo-headers included.
            # `tarfile` is the only thing running inside this narrow block,
            # which is why it is only this call and not the lines around it.
            # The gzip layer it reads THROUGH is the one qualification, and
            # `_is_the_disk` is what carries a real read failure on out — to
            # the `except OSError` arm below, which is why that arm sits on
            # the OUTER block rather than around the extraction alone.
            if _is_the_disk(error):
                raise
            raise PublishError(
                422, f"body is not a gzipped tar: {repr(str(error))}") from error

        # Resolved once: every member's landing spot is compared against this.
        real_dest = os.path.realpath(dest)
        try:
            _extract_members(tar, dest, real_dest, files, max_build_bytes)
        except CORRUPT_ARCHIVE_ERRORS as error:
            # The open() above only proved there was a gzip header. Everything
            # else — the member table, each member's data, the trailing CRC — is
            # read here, so a truncated body or a member that lies about its size
            # fails at THIS point, and it is still an unusable upload rather than
            # a bug in the hub. Without this it left as a 500 and a stack trace,
            # and the pusher was told `{"error": "internal error"}` about an
            # archive of its own making.
            raise PublishError(
            422, f"archive is corrupt: {repr(str(error))}") from error
    except OSError as error:
        # Deliberately NOT turned into a 422. This is the disk saying no —
        # ENOSPC above all — and answering "your archive is bad" would send
        # the pusher off to debug a file that is fine while the volume
        # quietly fills up.
        # BOTH DIRECTIONS land here: writing the extracted file, and READING
        # the body, which the parser does through the gzip layer inside the
        # broad catches above. Those refuse by fact rather than by type, so
        # `_is_the_disk` is what hands a read error on to this arm instead of
        # dressing it up as a corrupt archive.
        # WRAPPED AROUND THE WHOLE BLOCK for exactly that second direction.
        # It used to sit on the extraction alone, and a read error raised
        # while `tarfile.open` parsed the FIRST header therefore went past
        # it. NOT into silence, though — that is what this comment used to
        # claim and it was never true: `accept_sources` is called inside a
        # `try` in `app.py` whose `except Exception` logs the traceback under
        # "publish <target> failed", so an OSError from here has always been
        # recorded. What this arm buys is ATTRIBUTION, which is the half of
        # it that does any work: one line naming `dest` and saying the
        # filesystem is what refused, instead of a stack the reader has to
        # work through to decide whether the volume is dying or the hub has a
        # bug. `PublishError` is not an OSError, so nothing this block
        # answers deliberately is swallowed on the way.
        logger.error(
            f"unpacking into {dest} failed on the filesystem: {error}")
        raise
    finally:
        stream.close()

    if not files:
        raise PublishError(422, "archive is empty")
    return files


def _extract_members(tar, dest: Path, real_dest: str,
                     files: dict, max_build_bytes: int) -> None:
    """The member loop of `unpack`. Fills `files` with path -> sha256.

    Split out so its caller can wrap the WHOLE walk — iteration and reads
    included, not just the open — in one place, and so `files` is still
    readable for the caller after a failure.

    Keys of `files` are the member's RELATIVE PATH with `/` separators, not a
    bare name: two files called `part.step` in different directories are two
    different members and have to hash as two.
    """
    total = 0
    # Folded PATH -> the path that claimed it, for the message below.
    seen_names: dict[str, str] = {}
    # Member names this archive cannot have, as (name ALREADY escaped, why
    # not) — and separately how many there were. Collected instead of
    # raised, so one 422 names every one of them (issue #42).
    # The first one also turns the rest of this walk into a SURVEY: the
    # push is refused whatever else is in the archive, nothing more is
    # extracted, and the only thing left worth learning is which OTHER names
    # have to change. That is why no check below this one runs once the
    # count is non-zero — a link or a duplicate further down would otherwise
    # raise and throw away the list that was the point of collecting it.
    #
    # The list stops growing at MAX_REFUSED_NAMES_REPORTED while the counter
    # does not: what is past the ceiling will never be printed.
    refused: list[tuple[str, str]] = []
    refused_count = 0
    # The staging directory, held open for the whole walk. Every directory
    # and every file below is opened RELATIVE to this descriptor, so the
    # kernel never resolves a path of ours from the root and there is no
    # prefix for anything to have swapped underneath us.
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

                # `tar -czf build.tar.gz .` is the obvious way to build this
                # archive, and it stores an entry for the directory itself
                # (`.`) and one for every subdirectory. Those entries are
                # skipped without comment — and, more to the point, the
                # directories are created by US, from the paths of the FILES
                # that need them, with our own mode. A directory entry is
                # therefore never trusted for its name, its mode or its
                # existence: an archive that lists `scripts/` and an archive
                # that only lists `scripts/gen.py` unpack identically.
                if member.isdir():
                    continue

                # Name first: an absolute path, a `..` hop, an empty
                # component or a `.` component can never match the
                # whitelist, so traversal is refused before the member type
                # is even looked at.
                parts, fault = _member_parts(name)
                if fault or refused_count:
                    # SURVEYING, and the badly-named member goes through
                    # here too — that is the whole reason this is one branch
                    # and not two. `tarfile` reaches the next header by
                    # decompressing past a member's data whether anyone
                    # reads it or not, so the size ceiling is the only thing
                    # bounding the work a gzip bomb can make a survey do,
                    # and counting only the WELL-named members left it at
                    # zero for the archive where every name is bad. Measured
                    # before it was: a 1 MB body decompressed to 1.07 GB and
                    # answered 422 rather than 413.
                    total += member.size
                    if total > max_build_bytes:
                        raise PublishError(
                            413,
                            f"archive expands beyond "
                            f"{max_build_bytes} bytes")
                    if fault:
                        refused_count += 1
                        if len(refused) < MAX_REFUSED_NAMES_REPORTED:
                            # Escaped HERE, so what this list holds is
                            # printable by construction.
                            refused.append((repr(member.name), fault))
                    continue

                # Then the type. A symlink or a hardlink pointing outside
                # would be a write outside the build directory; a device,
                # fifo or directory is simply not something a build contains.
                if member.issym() or member.islnk():
                    raise PublishError(
                        422,
                        f"archive member {name!r} is a link; links are refused")
                if not member.isfile():
                    raise PublishError(
                        422,
                        f"archive member {name!r} is not a regular file "
                        f"(type {member.type!r})")
                # Case-INSENSITIVELY and over the WHOLE path, which is not
                # pedantry on either count: the check decides whether two
                # members can land on one filesystem, and APFS and a Docker
                # Desktop bind mount both fold case. `data.json` plus
                # `DATA.JSON` passed an exact-match check, then hit the
                # O_EXCL below and turned an unusable archive into a 500 with
                # a stack trace — on macOS, i.e. exactly where `make test`
                # runs. Folding only the last component instead of the path
                # would call `a/model.py` and `b/model.py` a collision, which
                # they are not; folding the path catches `a/File` against
                # `A/file`, which they are.
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
                # Second, INDEPENDENT line of defence. The name whitelist
                # above is the primary control, but it is one regexp: relax
                # it by a character in some future edit and traversal is
                # back. This asks the only question that actually matters —
                # where would the write land — of the filesystem rather than
                # of the string. realpath collapses `..` and follows symlinks
                # over the WHOLE prefix, so a member whose parent directory
                # is a symlink out of staging is refused here even though its
                # own name is impeccable. "Inside" rather than the old
                # "directly in", because the archive is a tree now — which is
                # exactly the edit that could have quietly become
                # `startswith(real_dest)` and accepted `<staging>-evil/`.
                real_target = os.path.realpath(target)
                if not real_target.startswith(real_dest + os.sep):
                    raise PublishError(
                        422,
                        f"archive member {member.name!r} would be written "
                        f"outside the build directory")

                # Third: the walk itself, which is the one that cannot be
                # raced. Every component is created and opened one at a time
                # with O_NOFOLLOW|O_DIRECTORY relative to the previous one,
                # so a symlink anywhere along the path is an error rather
                # than a redirection — including one planted a microsecond
                # ago by something outside this process.
                parent_fd = _open_member_dir(dest_fd, parts[:-1], member.name)
                try:
                    # O_EXCL: never write over something already at that
                    # name. O_NOFOLLOW: never follow a symlink sitting at
                    # that name — which closes the same hole a moment later
                    # than realpath does, but atomically, so the two together
                    # leave no window.
                    fd = _create_member_file(parent_fd, parts[-1], member.name)
                finally:
                    if parent_fd != dest_fd:
                        os.close(parent_fd)
                # The ceiling is applied to the bytes actually written, not
                # to the `size` the header claims: what reaches the disk is
                # what has to stay under it, whatever a header says.
                try:
                    out = os.fdopen(fd, "wb")
                except BaseException:
                    # `fdopen` adopts the descriptor only once it has
                    # succeeded; if it raises, nothing owns `fd` any more and
                    # nothing will ever close it — one leaked descriptor per
                    # member, on a process that also serves every read.
                    #
                    # An `open()` opener would not need this guard: what it
                    # returns is owned by `FileIO` on every failure path of
                    # its own, while this is owned only because the guard
                    # here exists. What keeps this one off
                    # the opener is `dir_fd=parent_fd` in
                    # `_create_member_file` — `open()`'s opener is called
                    # with `(path, flags)` and nothing else, so the directory
                    # descriptor would have to ride in on a closure. It
                    # could; this is a choice rather than an impossibility.
                    os.close(fd)
                    raise
                with out:
                    # The mode is set on the DESCRIPTOR rather than on the
                    # path — by then the file is the one we just created, so
                    # there is nothing left for a name lookup to resolve to
                    # instead — and inside the `with`, so a failure here
                    # cannot leak the descriptor. It is set at all because
                    # `open`'s mode argument is filtered through the umask.
                    os.fchmod(out.fileno(), 0o644)
                    while True:
                        chunk = source.read(CHUNK)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > max_build_bytes:
                            raise PublishError(
                                413,
                                f"archive expands beyond "
                                f"{max_build_bytes} bytes")
                        digest.update(chunk)
                        out.write(chunk)
                files["/".join(parts)] = digest.hexdigest()
                seen_names[folded] = name
    finally:
        os.close(dest_fd)

    if refused_count:
        raise _refused_names_error(refused, refused_count)
