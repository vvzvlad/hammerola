"""On-disk layout, safe unpacking and atomic publication.

NOTHING HERE EVER DELETES A PUBLISHED BUILD. There is no retention window and no
age ceiling: a build that landed stays until somebody removes it by hand
(decision of 2026-08-27, SPEC 5.3 and 7.3). A revision is tens of megabytes and
disk is cheaper than a mechanism that has to be written, tested, explained and
that can delete the wrong thing — and what the absence buys is exact: every
build URL is served with a year of `immutable`, so a link that was pasted into
chat goes on resolving for as long as the volume does. The cost is that the
volume grows monotonically, and the day it runs out is manual work rather than
automatic.

Layout under DATA_DIR (SPEC 3, 7.2). Everything here is runtime state and lives on
the docker volume; templates and viewer assets deliberately live outside it,
because the volume would shadow them.

    <data>/index.json                      cards for the front page
    <data>/project/<pid>/builds.json       build picker for one project
    <data>/project/<pid>/latest            SYMLINK -> <commit>, newest build
    <data>/project/<pid>/dev/              THE local slot — one directory, rewritten
                                           on every laptop push (SPEC 7.6)
    <data>/project/<pid>/<commit>/         one immutable build
    <data>/project/<pid>/.tmp-<commit>-<uuid>/   staging, never served
    <data>/jobs/<id>/                      one build job (src/jobs.py)
    <data>/.src-<uuid>/                    one pushed SOURCE tree, being built
    <data>/.body-<uuid>                    the BODY that tree came out of, kept
                                           until its build says whether to store it
    <data>/sources/<digest>/source.tar.gz  that body, kept: the code of one revision
    <data>/sources/<digest>/log.txt        what the build of that revision printed

`sources/` IS THE CODE OF EVERY PUBLISHED REVISION, and three things about it are
decisions rather than arrangement (SPEC 8, entry 17).

It is OUTSIDE the build directory. A build directory is served publicly and with
a year of `immutable`, so a mistake there cannot be taken back — the copies are
already handed out. This tree is served by nothing: the only way out of it is
`GET /api/v1/sources/<revision>`, behind EDIT_TOKEN, and the file server's
`_safe_name` never reaches this far anyway.

It is CONTENT-ADDRESSED, and that is not a second naming scheme to keep in step
with anything: `<digest>` is `_payload_digest` of the sources, which is exactly
what `mint_revision` names the revision after. The address of the code and the
name of the revision are one string. It follows that pushing the same tree twice
cannot produce a second archive — the second push resolves to the same name — and
that a revision published under a name the CALLER chose (the route that still
takes a `<commit>`) is stored under its digest instead, i.e. not at the name in
its own URL.

It is written ONLY AFTER A PUBLISH LANDS. The sources of a build that failed are
not kept: the author is looking at the failure the moment the command returns and
the tree is on their own disk, so the hub would be storing what nobody comes back
for — and a stored tree that belongs to no published revision is a revision this
store cannot answer for. Nothing prunes it afterwards; a revision's code lives
exactly as long as the revision (SPEC 5.3).

`latest` and `dev` are the two names a build directory may not claim, for
different reasons: `latest` is a symlink the store moves, and `dev` is the local
slot itself, a real directory the store rewrites.

Two naming rules carry security weight and are enforced by whitelist rather than
by blacklist, because a whitelist cannot be walked around by an encoding nobody
thought of:

  * `<pid>` and `<commit>` come from the URL and may only be `[A-Za-z0-9_-]`, so
    they can never contain a separator or a dot component. `latest` and `dev` are
    reserved.
  * a member name inside the uploaded tar is a RELATIVE PATH: `/`-separated
    components, each of the same shape as a bare filename plus dots. `../`,
    `/etc/passwd`, `a/../../b`, `a//b` and `a/./b` are all rejected on the name
    alone — before the member's TYPE is even considered — because no component
    may be empty, `.` or `..`, and none may start with a dot at all.
"""

import errno
import gzip
import hashlib
import json
import os
import re
import shutil
import tarfile
import threading
import time
import uuid
import zlib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger

from src import render

# Identifiers that arrive in the URL. No dot at all: that keeps a build directory
# from ever colliding with `builds.json`, and keeps it from being a dot-entry the
# file server hides.
# `\A`/`\Z` and not `^`/`$`: in Python `$` also matches just before a trailing
# newline, so `^...$` accepts "proj1\n" — which would create a directory with a
# newline in its name and put a bare LF into the `Location` header of the reply.
SAFE_ID = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")

# The two moving names of a project. Neither may ever be cached, and that is the
# only thing they have in common — mechanically they are different objects.
#
#   latest -> a SYMLINK to the newest build made FOR A COMMIT. The link people
#             paste into chat, so it means one thing only: the project as of
#             some commit.
#   dev    -> THE local slot (SPEC 7.6): one directory, overwritten by every push
#             from the author's laptop. There is exactly one, like there is
#             exactly one `latest`, and it has no history because what it shows
#             is not a version of anything — it is the current state of a working
#             copy. Uncommitted work must never move `latest`, or the public link
#             starts meaning "whatever was on somebody's machine at the time".
LATEST_LINK = "latest"
DEV_LINK = "dev"
POINTER_NAMES = (LATEST_LINK, DEV_LINK)

# Names a build may not claim, because the hub already answers to them: `latest`
# is a pointer symlink, `dev` is the local slot's directory, and both are the
# last segment of a publish route.
# `resolve` is deliberately NOT here: it is reserved by the COMMENT api only
# (SPEC 7A.2), where it costs a build the ability to be commented on and nothing
# else, and app.py documents that trade.
RESERVED_BUILD_NAMES = set(POINTER_NAMES)

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
# `\Z` for the same reason as above: `$` would let "model.stl\n" through.
SAFE_COMPONENT = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")

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

# Errno values that mean "this archive's own layout is impossible", as opposed to
# "the disk said no". A member whose parent directory is another member's file, a
# file name already taken by a directory, a component that turned out to be a
# symlink: every one of those is the pusher's problem and gets a 422. Everything
# else — ENOSPC above all — stays an OSError and becomes a 500, per the rule
# `_unpack` spells out. Getting this set wrong in the generous direction is how a
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

# Where the payload digest of a build is remembered, so a retry of the same commit
# can be told apart from a different build claiming the same commit (SPEC 7).
# Dot-prefixed: the file server refuses to serve dot entries.
PAYLOAD_DIGEST_FILE = ".payload.sha256"

# The store of pushed SOURCES, one directory per revision, named by the digest of
# what was pushed. See the module docstring for why it is here and not inside the
# build directory. Not dot-prefixed and it does not need to be: nothing serves
# this tree by path, `builds_of` only ever looks inside `project/`, and a name
# that is plainly visible in a `ls data/` is the honest one for a tree somebody
# will one day go looking for by hand.
SOURCES_DIR_NAME = "sources"
# The pushed body, byte for byte. `.tar.gz` because that is what it IS: the
# request body of the push, unmodified, which is what makes it possible to say
# the code of a revision is the code that built it rather than a repacking of it.
SOURCE_ARCHIVE_NAME = "source.tar.gz"
# The build log, beside the code rather than only at the job (SPEC 8, entry 17).
# The job's copy is not going anywhere — no job is ever deleted — but it is
# addressed by a JOB id, which is per attempt and recorded against nothing, so a
# month later the log of a revision is unreachable from the revision. This copy is
# the one half of "how did this revision come about" that would otherwise be
# reachable only by whoever still had the id from the push.
SOURCE_LOG_NAME = "log.txt"

# The project's own title, when somebody has renamed it (`hammerola rename`).
# PROJECT-LEVEL STATE, beside `builds.json` and for the same reason: a title is a
# property of the PROJECT, not of any one build (SPEC 3.1 separates the id from
# the name for exactly this). Renaming could not be done by rewriting the builds
# instead — a published build is immutable and served with a year of `immutable`,
# so the copies already handed out would never see the change and the ones on
# disk would stop matching what was published.
#
# Dot-free, and unreachable from the outside anyway: `_serve_project` only
# accepts a second segment that is a pointer name or passes `valid_build_id`, and
# `SAFE_ID` has no dot in it, so `/project/<pid>/title.json` is a 404 by the same
# rule that makes `builds.json` reachable only because it is spelled out.
PROJECT_TITLE_FILE = "title.json"

# Every transient name the store writes. All dot-prefixed, so none of them is ever
# served or picked up by `builds_of` — which is exactly why nothing notices when
# one is left behind by a SIGKILL, and why they are swept explicitly at startup.
STAGING_PREFIX = ".tmp-"        # a build's OUTPUT, on its way to <pid>/<commit>
LATEST_LINK_PREFIX = ".latest-"  # a symlink about to be renamed over `latest`
UPLOAD_PREFIX = ".upload-"      # one spooled request body, up to MAX_BUILD_BYTES
# The `dev` slot renamed out of the way while a new one takes its name. POSIX
# cannot replace a non-empty directory under a fixed name in one step, so the old
# slot has to go somewhere before the new one can arrive — see `_swap_dev_slot`.
# This is the ONLY thing that parks a directory now: a published build is never
# deleted (see the top of this module), so nothing else ever moves one aside.
TRASH_PREFIX = ".trash-"
JSON_TMP_PREFIX = ".wip-"       # builds.json / index.json mid-write
# One pushed SOURCE tree, from the moment it is unpacked until its build ends.
# At the root and not inside the project directory, and that is deliberate: it is
# not a build, it is never renamed anywhere, and a project directory that exists
# means the project has been pushed to. It also survives the request that created
# it — the worker owns it (src/jobs.py) — so it is the one transient here that is
# expected to outlive its creator.
SOURCE_PREFIX = ".src-"
# The BODY the tree above was unpacked from, from the moment the push is accepted
# until the build says whether the revision was published. The same lifetime as
# `.src-` and the same owner, and it is a second name rather than the spool's
# because ownership changes at exactly that point: `.upload-` belongs to the
# request thread, which deletes it whatever happens, and this belongs to the push.
#
# Kept at all only because a repacked tree is not the same artefact: what makes
# `sources/` worth having is that it holds the bytes that were pushed, and those
# exist only while this file does. It is NOT put beside the unpacked tree, which
# would be the obvious place — the tree is handed to the build as its input, so an
# archive inside it would be one more file the model gets to see and to read.
BODY_PREFIX = ".body-"

LEFTOVER_PREFIXES = (STAGING_PREFIX, LATEST_LINK_PREFIX, UPLOAD_PREFIX,
                     TRASH_PREFIX, JSON_TMP_PREFIX, SOURCE_PREFIX, BODY_PREFIX)

# A leftover younger than this may belong to a publish running RIGHT NOW, in this
# process or another one sharing the volume. An hour is far longer than any push
# takes and short enough that a killed 64 MiB upload does not sit there for days.
#
# `.src-` and `.body-` stretched that assumption and still fit under it, which is
# worth writing down because the next change to either number could break it
# silently: both now live from the request until the build ENDS, so the longest
# either can honestly be in use is the queue wait plus one build —
# jobs.MAX_QUEUED_JOBS times buildproc's `wall_seconds`, divided by the workers.
# At today's 16, 120 s and 2 that is sixteen minutes.
LEFTOVER_MAX_AGE_SECONDS = 3600


class PublishError(Exception):
    """A publish that must be answered with a specific HTTP status.

    Carries the status so app.py does not have to classify failures a second
    time, and a message that is safe to hand back to the pusher — a 422 exists so
    that the person who pushed can see WHICH file was missing.
    """

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass(frozen=True)
class AcceptedPush:
    """A pushed source tree the hub has taken responsibility for.

    `sources` is unpacked and validated; whoever holds this owns that directory
    and has to remove it. `digest` is over those sources, and is the number every
    later "is this the same push?" question is answered with. `commit` is the
    name it will be published under: the segment the caller put in the URL, or —
    on the route that has no such segment — the digest itself (`mint_revision`).

    `archive` is the request body those sources came out of, moved somewhere the
    request thread does not delete. It is owned exactly like `sources` — the same
    holder, removed at the same moment — with one extra ending: a build that
    publishes hands it to `keep_sources` instead, and it is then the code of a
    revision rather than a transient (see the module docstring).
    """

    sources: Path
    archive: Path
    digest: str
    commit: str


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def published_stamp() -> str:
    """When a build arrived, to the millisecond.

    Finer than `utcnow_iso`, and the extra digits are load-bearing rather than
    decorative: `published` is half of the key an open page polls with
    (`commit@published`), and in the local slot it is the ONLY half that moves —
    that slot's `commit` is the constant `dev` for every build it will ever hold
    (SPEC 7.6). Two pushes inside one second are not a human edit-build-look
    loop, but a script that rebuilds on save is exactly that, and a second-
    resolution stamp would leave such a page showing the older of the two for
    good.

    Deliberately NOT a change to `utcnow_iso`: the comment queue stamps `created`
    with it and `?since=` filters that field by STRING comparison against a
    second-resolution timestamp, so widening the format there would quietly move
    the boundary of every such query.
    """
    now = datetime.now(timezone.utc)
    return f"{now:%Y-%m-%dT%H:%M:%S}.{now.microsecond // 1000:03d}Z"


def _build_url(pid: str, name: str) -> dict:
    """The body of a successful publish: where the thing just published lives.

    One URL, for both routes. A commit push answers with its permanent
    `/<commit>/`; a local push answers with `/dev/`, which is the only address a
    local build has ever needed — it is the slot, and the author keeps it open in
    a tab (SPEC 7.6).
    """
    return {"url": f"/project/{pid}/{name}/"}


def _built_key(meta: dict) -> tuple:
    """Sort key for "which build is newest" — `built`, then arrival time.

    `built` is whatever the build wrote; it is not validated beyond being a
    string, so it can be unparseable. An unparseable value sorts oldest instead of
    raising: a build that made it past validation must still be orderable, or one
    malformed timestamp would break the picker for the whole project.
    """
    raw = meta.get("built") or ""
    stamp = 0.0
    try:
        parsed = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        stamp = parsed.timestamp()
    except (TypeError, ValueError):
        stamp = 0.0
    return (stamp, str(meta.get("published") or ""))


# -- member paths ----------------------------------------------------------
def _member_parts(raw_name: str, name: str) -> list[str]:
    """Split one member name into checked path components, or raise a 422.

    `raw_name` is what the archive said and is used in messages; `name` is the
    same thing with a leading `./` removed, which is what actually gets checked.

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
        raise PublishError(
            422,
            f"archive member {raw_name!r} is {len(parts)} path components deep; "
            f"the ceiling is {MAX_PATH_DEPTH}")
    for part in parts:
        if not SAFE_COMPONENT.match(part):
            raise PublishError(
                422,
                f"unsafe archive member name {raw_name!r}: it must be a relative "
                f"path whose every component matches {SAFE_COMPONENT.pattern}, "
                f"and {part!r} does not")
    return parts


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


class Store:
    """Everything that touches DATA_DIR.

    One instance per process. `max_build_bytes` is passed in rather than read
    from the settings singleton so tests can build a Store on a tmp_path without
    touching the process environment.
    """

    def __init__(self, data_dir, max_build_bytes: int):
        self.root = Path(data_dir).resolve()
        self.max_build_bytes = max_build_bytes
        self.projects_dir = self.root / "project"
        # NOT created here, unlike `projects_dir`. It is created by the first
        # publish that puts something in it, so a hub that has never published a
        # revision has no `sources/` at all — which is what makes "a build that
        # failed leaves nothing behind" an observable fact rather than an empty
        # directory somebody has to interpret.
        self.sources_dir = self.root / SOURCES_DIR_NAME
        # Publication is serialized per project: builds.json and the `latest`
        # symlink are both derived from the full set of builds, so two concurrent
        # pushes to the SAME project could interleave into a builds.json and a
        # pointer that describe different moments. Different projects never touch
        # each other's state and are free to run in parallel.
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        # The root index spans every project, so it gets its own global lock.
        self._index_lock = threading.Lock()
        self.projects_dir.mkdir(parents=True, exist_ok=True)
        self._sweep_leftovers()

    # -- leftovers ---------------------------------------------------------
    def _sweep_leftovers(self) -> None:
        """Delete transient entries an earlier run died in the middle of.

        Nothing else ever will. Every name here is dot-prefixed, so `builds_of`
        skips it and the file server refuses to serve it — a SIGKILL during a
        push therefore leaves up to MAX_BUILD_BYTES of spooled body plus a
        half-unpacked staging tree on the volume, permanently.

        Only entries older than an hour are touched, because a concurrent publish
        in this very process is using names of exactly the same shape.
        """
        cutoff = time.time() - LEFTOVER_MAX_AGE_SECONDS
        directories = [self.root]
        try:
            directories += [p for p in self.projects_dir.iterdir() if p.is_dir()]
        except OSError:
            pass
        for directory in directories:
            try:
                entries = list(directory.iterdir())
            except OSError:
                continue
            for entry in entries:
                if not entry.name.startswith(LEFTOVER_PREFIXES):
                    continue
                try:
                    # lstat, not stat: a leftover `.latest-<uuid>` is a symlink
                    # and may already dangle.
                    if entry.lstat().st_mtime > cutoff:
                        continue
                    if entry.is_dir() and not entry.is_symlink():
                        shutil.rmtree(entry)
                    else:
                        entry.unlink()
                except OSError as error:
                    logger.warning(f"could not sweep leftover {entry}: {error}")
                    continue
                logger.info(f"swept leftover {entry}")

    # -- naming ------------------------------------------------------------
    @staticmethod
    def valid_pid(pid: str) -> bool:
        return bool(SAFE_ID.match(pid))

    @staticmethod
    def valid_build_id(name: str) -> bool:
        """Is this a name a commit build may be published and served under?

        Only the two reserved names are out. The `dev-` PREFIX is deliberately not
        reserved any more: it used to be, because dev ids were `dev-<digest>` and
        a commit called `dev-1234` would have been filed with the local builds
        rather than with the commit ones. There is no bucket of local builds now
        — there is one slot, with no history — so `dev-1234` is just a commit id
        like any other and gets the same permanent URL.
        """
        return bool(SAFE_ID.match(name)) and name not in RESERVED_BUILD_NAMES

    @staticmethod
    def mint_revision(digest: str) -> str:
        """The name the hub gives a revision it names itself: the payload digest.

        THE IDENTIFIER IS THE CONTENT, and every property the revision route
        needs falls out of that rather than being enforced on top of it:

          * "the same sources are the same revision" is an identity, not a
            check — an unchanged tree cannot be given a second address;
          * "this name is taken by different content" cannot arise, because
            different content hashes to a different name (the 409 that answers
            it survives for the reason `settled` gives, which is about a
            directory that has lost its digest file, not about a colliding id);
          * nothing has to be stored to hand out the next one, so two pushes
            racing each other need no coordination at all.

        NOT TRUNCATED, and that is the one number worth writing down. A sha256
        in hex is exactly 64 characters and `SAFE_ID` allows exactly 64, so the
        whole digest fits with nothing to spare and nothing to gain by cutting
        it: the URL was already carrying 40 hex characters when the id came from
        git, it is pasted rather than typed, and 24 more characters cost
        nothing. A truncated prefix would cost something real — with n published
        revisions and b bits kept, the chance that some pair collides is about
        n²/2^(b+1), so a 64-bit (16-character) prefix over a million revisions is
        ~3e-8. Small, but the FAILURE it buys is not small and not repairable:
        two different source trees would map to one URL, the second would be
        refused 409 for ever, and the pusher has no other name to publish under
        because the pusher does not choose the name any more.

        `digest` comes from `_payload_digest`, so this can only fail if that
        function's output shape changes — base64 (`+`, `/`), a prefix, a longer
        hash. It is checked rather than assumed because the failure would
        otherwise be a directory created under a name the file server refuses to
        serve, i.e. a build that publishes and then 404s.
        """
        if not Store.valid_build_id(digest):
            raise PublishError(
                500,
                "the hub could not name this revision: its digest is not a "
                "usable build id")
        return digest

    def _lock_for(self, pid: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(pid, threading.Lock())

    # -- publish -----------------------------------------------------------
    def upload_path(self) -> Path:
        """A private path under DATA_DIR for one request body.

        On the volume rather than in /tmp: a body is up to MAX_BUILD_BYTES, the
        container's writable layer is not where that belongs, and the dot prefix
        keeps it out of `builds_of` and out of the file server. Swept by
        `_sweep_leftovers` if the process dies before deleting it.

        This name belongs to the REQUEST THREAD, which deletes it whatever
        happens. A body that is accepted leaves under another name — see the
        rename at the end of `accept_sources` — because from that point it is
        owned by the push and may outlive the request by a whole build.
        """
        return self.root / f"{UPLOAD_PREFIX}{uuid.uuid4().hex}"

    # -- accepting a push (in the request thread) ---------------------------
    def accept_sources(self, pid: str, commit: str | None, body_path: Path,
                       body_size: int) -> "AcceptedPush":
        """Unpack one pushed SOURCE tree and hash it. Raises PublishError.

        The first half of what `publish` used to do in one go. It stays in the
        REQUEST because everything it can refuse is a property of the upload
        itself — the ids, the size, the archive — and an archive that is not an
        archive has to be a 4xx on the push, not a job the pusher has to poll to
        find out about. What it deliberately does NOT do is touch the project's
        directory: nothing here is published, and a push that never builds must
        leave no trace of a project that was never pushed to successfully.

        Takes a PATH, not bytes: the body is already on disk by the time it gets
        here, and reading it back into memory to hand it over would undo exactly
        the peak this avoids.

        The digest is of the SOURCES, and it is what tells an identical retry
        from a colliding one from here on. It has to be, now that the hub builds:
        the built output carries the wall clock of the build (`meta.json` and
        `metrics.json` both stamp `built`), so hashing THAT would make every
        rebuild of the same commit a 409 and take away the pusher's ability to
        retry — the exact failure `_payload_digest` already refuses to walk into
        with the rewritten meta.json. What the pusher supplied is the sources; that is
        what "the same push" can honestly mean.

        `commit` is None when the URL carried no name for this push, which is
        how a pusher asks the hub to name the revision: the digest computed here
        BECOMES that name (`mint_revision`). It is the same number either way —
        what changes is only whether it is also the address.
        """
        if not self.valid_pid(pid):
            raise PublishError(422, f"invalid project id: {pid!r}")
        # `dev` is the one commit name the URL may carry that is not a build id:
        # it is the local slot (SPEC 7.6), and it is validated by being exactly
        # that constant rather than by the build-id rule, which reserves it.
        # None is not a name at all — there is nothing to validate until the
        # sources have been hashed, further down.
        if commit is not None and commit != DEV_LINK \
                and not self.valid_build_id(commit):
            raise PublishError(422, f"invalid commit id: {commit!r}")
        if body_size > self.max_build_bytes:
            raise PublishError(
                413, f"body is {body_size} bytes, limit is {self.max_build_bytes}")

        sources = self.root / f"{SOURCE_PREFIX}{uuid.uuid4().hex}"
        sources.mkdir()
        try:
            files = self._unpack(body_path, sources)
            digest = _payload_digest(files)
            name = self.mint_revision(digest) if commit is None else commit
            # LAST, and the order is what decides who owns the body. Until this
            # rename the spool is the request thread's and its `finally` deletes
            # it, which is what every failure above wants; after it, the spool
            # path no longer exists, that same `finally` is a no-op, and the body
            # travels with the push. So an exception between the two can only
            # leave the body where the request was already going to remove it.
            archive = self.root / f"{BODY_PREFIX}{uuid.uuid4().hex}"
            os.rename(body_path, archive)
        except BaseException:
            # Every way out of the block above except the ordinary one,
            # BaseException included: a KeyboardInterrupt here would otherwise
            # leave an unpacked tree that only the hourly sweep would ever
            # remove.
            shutil.rmtree(sources, ignore_errors=True)
            raise
        return AcceptedPush(sources=sources, archive=archive, digest=digest,
                            commit=name)

    def settled(self, pid: str, commit: str,
                digest: str) -> tuple[int, dict] | None:
        """Has this exact push already been published? (status, body), or None.

        Raises PublishError(409) when the name is taken by different content.

        Asked BEFORE a build is queued, which is the whole point: rebuilding a
        commit that is already on disk costs minutes of CPU to arrive at an
        answer that was on disk all along, and answering 200 or 409 from the
        request keeps both of those codes where the pusher already expects them —
        immediately, rather than through a job it would have to poll.

        Not under the project lock, on purpose. It is a read whose answer can
        only go stale in one direction — another push landing the same commit
        between here and the rename — and `publish_built` makes exactly the same
        comparison again, under the lock, where it is authoritative.
        """
        pdir = self.projects_dir / pid
        if commit == DEV_LINK:
            # The slot has no 409: it is overwritten by every push by design
            # (SPEC 7.6). The comparison is here only so an unchanged rebuild
            # does no work — and now that the hub builds, "no work" means the
            # build itself, not just the swap.
            if _read_digest(pdir / DEV_LINK) == digest:
                logger.info(f"publish {pid}/{DEV_LINK}: identical, kept")
                return 200, _build_url(pid, DEV_LINK)
            return None

        final = pdir / commit
        if not final.exists():
            return None
        existing = _read_digest(final)
        if existing is not None and existing == digest:
            logger.info(f"publish {pid}/{commit}: identical retry, kept")
            return 200, _build_url(pid, commit)
        # The build directory is immutable and was served with a one-year
        # immutable cache, so silently replacing it would make every cached copy
        # a lie (SPEC 7).
        #
        # STILL REACHABLE ON A MINTED NAME, which is worth saying because the
        # arithmetic looks like it cannot be. When the hub names the revision the
        # name IS this digest, so "same name, different content" would take a
        # sha256 collision — but that is not the only way to get here. The other
        # way is a directory at that name whose `.payload.sha256` is missing or
        # unreadable, and `data/` is a volume every build can write anywhere in
        # (SPEC 8A.4): a half-written directory, a file removed by another
        # build, an unlink that lost its race. There is nothing to compare
        # against then, and answering 200 would claim a publication that may
        # never have finished. On the NAMED route — the one a caller still uses
        # with an id of its own — this is the ordinary case it always was.
        raise PublishError(
            409, f"build {commit} already exists with different content")

    def build_staging(self, pid: str, commit: str) -> Path:
        """Where a build writes: the directory that becomes `<pid>/<commit>`.

        Returned rather than created, because the build creates it itself (see
        `cadbuild.build`, which insists on a clean output directory). What this
        DOES create is the project directory, which has to exist before anything
        inside it can be renamed into place.

        Inside the project directory and not beside the sources, so publication
        is a rename within one filesystem directory — the atomic step the whole
        of SPEC 7.2 rests on.
        """
        pdir = self.projects_dir / pid
        pdir.mkdir(parents=True, exist_ok=True)
        return pdir / f"{STAGING_PREFIX}{commit}-{uuid.uuid4().hex}"

    # -- publishing what a build produced (in a worker thread) --------------
    def publish_built(self, pid: str, commit: str, staging: Path, names,
                      digest: str) -> tuple[int, dict]:
        """Put one built tree at `<pid>/<commit>`. Returns (status, response).

        201 published, 200 identical retry, 409 same commit / different content.
        Anything else is raised as PublishError.

        `staging` is the directory the build wrote into and `names` are the files
        it declared it ships (`BuildOutcome.files`, every one of them already
        checked by the parent to be a regular file under `staging`). The caller
        owns `staging`: on the success path it is renamed away and there is
        nothing left, and on every other path the caller removes it.
        """
        files = _hash_output(staging, names)
        pdir = self.projects_dir / pid
        with self._lock_for(pid):
            pdir.mkdir(parents=True, exist_ok=True)
            final = pdir / commit

            # The same comparison `settled` already made in the request, made
            # again here because THIS is the one that is authoritative: it is
            # under the project lock and immediately before the rename, so a
            # second push of the same commit that arrived while this one was
            # building cannot slip between the two.
            if final.exists():
                existing = _read_digest(final)
                if existing is not None and existing == digest:
                    logger.info(f"publish {pid}/{commit}: identical retry, kept")
                    return 200, _build_url(pid, commit)
                raise PublishError(
                    409, f"build {commit} already exists with different content")

            meta = self._finish_staging(pid, commit, staging, files, digest)
            try:
                os.rename(staging, final)
            except OSError as error:
                # Lost a race with another writer, or the directory appeared
                # between the check above and here. Re-run the same comparison
                # rather than reporting a filesystem error the pusher cannot act on.
                if not final.exists():
                    raise PublishError(
                        422, f"could not publish build: {error}") from error
                existing = _read_digest(final)
                if existing is not None and existing == digest:
                    return 200, _build_url(pid, commit)
                raise PublishError(
                    409,
                    f"build {commit} already exists with different content",
                ) from error

            # PAST THE POINT OF NO RETURN. The rename above IS the publication
            # (SPEC 7.2): the build is at its permanent URL and anyone can
            # already fetch it. Everything from here on is bookkeeping DERIVED
            # from what is now on disk — which build `latest` names, what the
            # picker lists, what the index shows — and every one of those is
            # recomputed from scratch by the next publish of this project, so a
            # failure is recoverable and a lie is not. Reporting failure here
            # would tell the pusher the push did not land
            # while its URL serves the build; since step 5 it would also mark a
            # job `failed` for a build that is live, which is the worst answer
            # available.
            #
            # RECOVERABLE IS NOT REPAIRED, and the difference is worth being
            # exact about. What repairs it is the next publish OF THIS PROJECT
            # and nothing else: startup recomputes none of this, and another
            # project's publish never touches these files. So a project that was
            # pushed to once and then abandoned keeps whatever this leaves —
            # `latest` on the previous build, a picker missing the newest one —
            # for as long as nobody pushes to it again, which for an abandoned
            # project is for ever.
            #
            # Order still matters on the success path: the symlink moves first,
            # so a reader following `latest` is on the new build before the
            # picker starts offering it, and the picker is written last, from
            # what is on disk once the pointer has settled.
            try:
                # A rename is superseded by the push that follows it: the build
                # carries the project's own title, and that is the newer
                # statement of what the project is called. Before the picker is
                # written, so the file is rebuilt from the state that survives.
                self.clear_title(pid)
                self._switch_latest(pid)
                self._write_builds_json(pid)
            except Exception:
                logger.exception(
                    f"publish {pid}/{commit}: the build is published, but the "
                    f"bookkeeping after it did not finish; the next publish of "
                    f"this project rebuilds all of it")

        try:
            self._refresh_index()
        except Exception:
            logger.exception(
                f"publish {pid}/{commit}: the build is published, but the site "
                f"index was not refreshed")
        logger.info(
            f"publish {pid}/{commit}: {len(files)} files, "
            f"{len(meta['variants'])} views")
        return 201, _build_url(pid, commit)

    def publish_dev_built(self, pid: str, staging: Path, names,
                          digest: str) -> tuple[int, dict]:
        """Overwrite the project's ONE local slot, `<pid>/dev/` (SPEC 7.6).

        The author is editing model.py on a laptop and wants to see the result
        now, without committing. That work has no commit to be addressed by, and
        — the part that decides this whole design — it has no history worth
        keeping either: attempt seventeen of an evening is not a version of the
        project, it is the working copy as it stands. So there is exactly one
        slot, like there is exactly one `latest`, and every push rewrites it.

        Rewriting a URL in place is only safe because that URL is served
        `no-cache`, which is what buys the simplicity: no minted ids, no local
        entries in `builds.json`. The commit route keeps its 409 and its year of
        `immutable` untouched — the two never meet.

        Returns 201 when the slot changed and 200 when the same sources are
        already in it — the second answer normally comes from `settled` before a
        build is even queued, and is repeated here for the push that arrived
        while an identical one was building.
        """
        files = _hash_output(staging, names)
        pdir = self.projects_dir / pid
        url = _build_url(pid, DEV_LINK)
        with self._lock_for(pid):
            pdir.mkdir(parents=True, exist_ok=True)
            if _read_digest(pdir / DEV_LINK) == digest:
                # Same sources as the slot already holds. Nothing to write, and
                # nothing SHOULD be written: a swap here would take the page the
                # author has open through a needless re-render.
                logger.info(f"publish {pid}/{DEV_LINK}: identical, kept")
                return 200, url
            meta = self._finish_staging(pid, DEV_LINK, staging, files, digest)
            self._swap_dev_slot(pdir, staging)

            # `latest` is not touched: a local build is not a commit, so it
            # cannot be the newest one. `builds.json` is rewritten because the picker shows
            # whether the slot is occupied at all — and, like the tail of
            # `publish_built`, it runs AFTER the swap that publishes and so
            # cannot be allowed to unpublish it by raising. The next push
            # rewrites the file from scratch.
            try:
                # Same as the commit route: this push carries the project's own
                # title, so an earlier rename has been answered.
                self.clear_title(pid)
                self._write_builds_json(pid)
            except Exception:
                logger.exception(
                    f"publish {pid}/{DEV_LINK}: the slot is published, but the "
                    f"build picker was not rewritten")

        # The site index too, and this is the one thing a local push changes
        # about the front page. The card still describes the newest COMMIT and
        # never the slot (SPEC 7.6) — what it gains is the `dev` chip, i.e. that
        # a slot exists. Without this line that chip appears only when the
        # project is next committed, which is the same class of staleness the
        # picker is rewritten to avoid; with it, a local push costs one index
        # rebuild, which is nothing beside the build that produced the push.
        #
        # OUTSIDE the project lock and after it, and guarded, exactly like
        # `publish_built`: `_refresh_index` takes the index lock and walks every
        # project, so holding a second lock across it is how two publishes to two
        # projects would deadlock — and it runs after the swap that publishes, so
        # it must not be able to turn a published slot into a failed push.
        try:
            self._refresh_index()
        except Exception:
            logger.exception(
                f"publish {pid}/{DEV_LINK}: the slot is published, but the site "
                f"index was not refreshed")

        logger.info(
            f"publish {pid}/{DEV_LINK}: {len(files)} files, "
            f"{len(meta['variants'])} views")
        return 201, url

    @staticmethod
    def _swap_dev_slot(pdir: Path, staging: Path) -> None:
        """Put a freshly unpacked tree into `<pid>/dev/`, replacing what is there.

        POSIX has no way to atomically replace a non-empty DIRECTORY under a fixed
        name — `rename` onto a directory only succeeds if the target is empty —
        so this is two renames with nothing between them: the old slot is moved
        aside whole, the new one takes the name, and only then are the old bytes
        deleted. That is deliberately NOT "empty the slot, then unpack into it":
        the difference is that a reader is never inside a directory that is being
        filled, which is the failure that actually matters. It can, for the width
        of one syscall, find the name absent — the price of the slot BEING the
        build rather than a symlink to one, and the reason `latest`, which has to
        survive being pasted into chat, is a symlink instead.

        If the second rename fails the old slot is put back, so a failed push
        leaves the author looking at what they had rather than at a 404.
        """
        slot = pdir / DEV_LINK
        parked = pdir / f"{TRASH_PREFIX}{uuid.uuid4().hex}"
        occupied = os.path.lexists(slot)
        if occupied:
            os.rename(slot, parked)
        try:
            os.rename(staging, slot)
        except OSError:
            if occupied:
                os.rename(parked, slot)
            raise
        if occupied:
            shutil.rmtree(parked, ignore_errors=True)

    # -- the code of a revision --------------------------------------------
    def source_archive(self, revision: str) -> Path:
        """Where one revision's pushed body lives. It may not be there.

        Existence of THIS file is what "the hub has the code of that revision"
        means, and the log below is not part of the question: a directory holding
        only a log is what a rename killed half way through leaves, and it must
        read as absent rather than as half a revision.
        """
        return self.sources_dir / revision / SOURCE_ARCHIVE_NAME

    def source_log(self, revision: str) -> Path:
        """Where the build log of one revision lives. It may not be there."""
        return self.sources_dir / revision / SOURCE_LOG_NAME

    def keep_sources(self, digest: str, archive: Path) -> bool:
        """Store the body of a push as the code of the revision it published.

        True when this call is what put it there. False when the archive was
        already stored, which is the ordinary outcome of publishing the same
        sources a second time and is not an error: the address is the digest of
        the SOURCES, so what is already there unpacks to the very tree this body
        does. The two bodies need not be byte-identical to each other — the same
        tree tarred twice differs in its gzip header alone — and the one kept is
        the one that got there first, which is the only choice that keeps a
        stored archive from changing under a revision that is already published.

        The caller still owns `archive` either way — on the False path it is
        untouched, and on the True path it has been renamed away, so the caller's
        unconditional cleanup finds nothing and does nothing.

        NOT ATOMIC AS A PAIR, deliberately: the directory is created first and
        the body is renamed into it second, so a hub killed between the two
        leaves an empty directory. That reads as "no code for this revision"
        (see `source_archive`) and the next publish of the same sources fills it
        in, so nothing has to collect it — which is the whole reason the failure
        is arranged this way round rather than through a staging name that would
        need sweeping.
        """
        target = self.sources_dir / digest / SOURCE_ARCHIVE_NAME
        if target.exists():
            return False
        target.parent.mkdir(parents=True, exist_ok=True)
        # On the descriptor-less path, but for the same reason `_open_member_dir`
        # does it on one: `mkdir`'s mode is filtered through the process umask,
        # so a hub started under `umask 077` would create a directory it can
        # write and nothing else can read.
        os.chmod(target.parent, 0o755)
        os.rename(archive, target)
        os.chmod(target, 0o644)
        return True

    def keep_build_log(self, digest: str, raw: bytes) -> None:
        """Put the build log beside the code of a revision. Bytes, already capped.

        Bytes rather than text because the ceiling belongs to whoever captured
        the log (`jobs.MAX_LOG_BYTES`, derived from what a build is allowed to
        print), and applying a second, different one here is how the two would
        drift into disagreeing about the same file.

        Written only into a directory that already holds the code. A log on its
        own would be a revision this store cannot answer for — and on the one
        path that gets here, `keep_sources` has just run.

        The temporary file goes at the DATA ROOT rather than beside the target,
        for the reason `atomic_write_bytes` spells out: `_sweep_leftovers` walks
        the root and the project directories, so that is where a `.wip-` left by
        a killed write is actually collected. Beside the target it would sit in
        `sources/<digest>/` for the life of the volume.
        """
        directory = self.sources_dir / digest
        if not directory.is_dir():
            return
        atomic_write_bytes(directory / SOURCE_LOG_NAME, raw, tmp_dir=self.root)

    # -- unpacking ---------------------------------------------------------
    def _unpack(self, body_path: Path, dest: Path) -> dict:
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
        further down would then fail with a confusing message about a broken
        link; refusing names the actual problem.
        """
        try:
            # Opened by path: `BytesIO(body)` would put a second full copy of the
            # body in memory next to the one already on disk.
            tar = tarfile.open(body_path, mode="r:gz")
        except (tarfile.TarError, EOFError, OSError) as error:
            raise PublishError(422, f"body is not a gzipped tar: {error}") from error

        files: dict[str, str] = {}
        # Resolved once: every member's landing spot is compared against this.
        real_dest = os.path.realpath(dest)
        try:
            self._extract_members(tar, dest, real_dest, files)
        except CORRUPT_ARCHIVE_ERRORS as error:
            # The open() above only proved there was a gzip header. Everything
            # else — the member table, each member's data, the trailing CRC — is
            # read here, so a truncated body or a member that lies about its size
            # fails at THIS point, and it is still an unusable upload rather than
            # a bug in the hub. Without this it left as a 500 and a stack trace,
            # and the pusher was told `{"error": "internal error"}` about an
            # archive of its own making.
            raise PublishError(422, f"archive is corrupt: {error}") from error
        except OSError as error:
            # Deliberately NOT turned into a 422. This is the disk saying no —
            # ENOSPC above all — and answering "your archive is bad" would send
            # the pusher off to debug a file that is fine while the volume
            # quietly fills up.
            # Logged loudly here because the 500 it becomes carries no detail.
            logger.error(f"unpacking into {dest} failed on the filesystem: {error}")
            raise

        if not files:
            raise PublishError(422, "archive is empty")
        return files

    def _extract_members(self, tar, dest: Path, real_dest: str,
                         files: dict) -> None:
        """The member loop of `_unpack`. Fills `files` with path -> sha256.

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
        # The staging directory, held open for the whole walk. Every directory
        # and every file below is opened RELATIVE to this descriptor, so the
        # kernel never resolves a path of ours from the root and there is no
        # prefix for anything to have swapped underneath us.
        dest_fd = os.open(dest, os.O_RDONLY | os.O_DIRECTORY)
        try:
            with tar:
                for index, member in enumerate(tar):
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
                    parts = _member_parts(member.name, name)

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
                    # The header's `size` is attacker-controlled, so the ceiling
                    # is applied to the bytes actually written, not to what it
                    # claims.
                    try:
                        out = os.fdopen(fd, "wb")
                    except BaseException:
                        # `fdopen` adopts the descriptor only once it has
                        # succeeded; if it raises, nothing owns `fd` any more and
                        # nothing will ever close it — one leaked descriptor per
                        # member, on a process that also serves every read.
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
                            if total > self.max_build_bytes:
                                raise PublishError(
                                    413,
                                    f"archive expands beyond "
                                    f"{self.max_build_bytes} bytes")
                            digest.update(chunk)
                            out.write(chunk)
                    files["/".join(parts)] = digest.hexdigest()
                    seen_names[folded] = name
        finally:
            os.close(dest_fd)

    # -- staging -> publishable directory ----------------------------------
    def _finish_staging(self, pid, commit, staging: Path, files, digest) -> dict:
        """Validate meta.json and write everything the build page needs.

        `staging` is what the BUILD wrote (SPEC 8A.2 step 5), so the meta.json
        read here is the build's own — the same wire format the archive used to
        carry, produced one step closer to the model. Nothing else about this
        changed, which is the point of pointing the build at the directory that
        gets renamed into place.
        """
        raw = self._read_meta(staging)
        try:
            meta = render.build_meta(
                pid=pid, commit=commit, raw=raw, staging=staging, files=files,
                published=published_stamp(), dev=(commit == DEV_LINK))
        except ValueError as error:
            # render.py validates without knowing about HTTP; every way it can
            # refuse is "the push described something that is not there", i.e. 422.
            raise PublishError(422, str(error)) from error

        # meta.json only. The page shell is NOT written here: it is identical for
        # every build and it changes with the image, so a per-build copy served
        # under a commit URL's year of `immutable` would pin every published build
        # to the viewer markup of the day it was pushed. app.py renders it from
        # the template instead, the same way it serves `/`.
        (staging / "meta.json").write_text(
            json.dumps(meta, indent=1), encoding="utf-8")
        (staging / PAYLOAD_DIGEST_FILE).write_text(digest, encoding="utf-8")
        return meta

    @staticmethod
    def _read_meta(staging: Path) -> dict:
        path = staging / "meta.json"
        if not path.is_file():
            raise PublishError(422, "the build produced no meta.json")
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, UnicodeDecodeError) as error:
            raise PublishError(422, f"meta.json is not valid JSON: {error}") from error
        if not isinstance(raw, dict):
            raise PublishError(422, "meta.json must be a JSON object")
        return raw

    # -- project-level state -----------------------------------------------
    def builds_of(self, pid: str) -> list[dict]:
        """Every published COMMIT build of one project, newest first.

        The `dev` slot is skipped, and skipping it here is what keeps it out of
        `builds.json`, out of `/index.json` and out of `latest` in one place
        instead of three (SPEC 7.6). It is a directory with a real meta.json — it
        would otherwise be listed like any build — but it is not a version of the
        project, and history is a history of commits.

        Reads each build's own meta.json rather than a project-level list, so the
        directory tree stays the single source of truth: a build removed by hand,
        or one restored by hand, needs no bookkeeping anywhere else.

        Which is exactly why a meta.json here cannot be assumed to be one WE
        wrote. Everything downstream — `_switch_latest`,
        `render.builds_json`, `render.index_card` — subscripts these dicts
        directly, so one `{}` left by a half-finished restore used to take out the
        next publish of that project with a 500, after the build was already on
        disk and before `latest` had moved. A meta that cannot answer those
        questions is skipped exactly like an unreadable one: the build stops being
        listed, and the project keeps working.
        """
        pdir = self.projects_dir / pid
        if not pdir.is_dir():
            return []
        metas = []
        for entry in pdir.iterdir():
            if entry.name.startswith(".") or not entry.is_dir() or entry.is_symlink():
                continue
            if entry.name in RESERVED_BUILD_NAMES:
                continue
            meta_path = entry / "meta.json"
            if not meta_path.is_file():
                continue
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (ValueError, OSError, RecursionError):
                logger.warning(f"unreadable meta.json in {entry}")
                continue
            if not _usable_meta(meta, entry.name):
                logger.warning(
                    f"ignoring build {pid}/{entry.name}: its meta.json is not "
                    f"one this hub wrote (missing or wrong required fields)")
                continue
            metas.append(meta)
        metas.sort(key=_built_key, reverse=True)
        return metas

    def latest_commit(self, pid: str) -> str | None:
        """What `latest` currently points at, or None if it is not set."""
        try:
            return os.readlink(self.projects_dir / pid / LATEST_LINK)
        except OSError:
            return None

    def _switch_latest(self, pid: str) -> None:
        """Point `latest` at the newest build.

        Every build `builds_of` returns is a commit build — the local slot is not
        in that list — which is the whole rule `latest` exists to keep (SPEC 7.6):
        it is the link that gets pasted into chat, and it has to go on meaning
        "the project as of some commit".
        """
        metas = self.builds_of(pid)
        if not metas:
            return
        self._point(pid, LATEST_LINK, metas[0]["commit"])

    def _point(self, pid: str, name: str, target: str) -> None:
        """Move one pointer symlink, atomically.

        `os.symlink` to a temporary name followed by `os.rename` over the old link
        replaces it in ONE step. The obvious alternative — unlink the old link,
        then create the new one — leaves a window in which /project/<pid>/latest/
        is a 404, and that window is open on every single publish.

        The link is RELATIVE (just the build name). An absolute one would bake in
        the path the hub happened to have when it wrote it, and break the day the
        same tree is mounted somewhere else — which is exactly what the container
        does with /app/data.
        """
        pdir = self.projects_dir / pid
        tmp_link = pdir / f"{LATEST_LINK_PREFIX}{uuid.uuid4().hex}"
        os.symlink(target, tmp_link)
        os.rename(tmp_link, pdir / name)

    def _write_builds_json(self, pid: str) -> None:
        """Rewrite the build picker from what is actually on disk.

        Called AFTER the pointer has moved, so `latest` in the file names the
        build a reader following that link will actually land on. Temp file plus
        rename, so a reader sees the old list or the new one and never a
        half-written file.

        The local slot is not one of the entries and never will be — that is the
        point of it being a slot (SPEC 7.6) — but the picker still has to be able
        to OFFER it, so whether it is occupied is recorded alongside the list.
        Which is also why this runs for a project that has no commit builds yet:
        a local-only project has an empty history and a slot worth linking to.
        """
        metas = self.builds_of(pid)
        dev_meta = self._dev_meta(pid)
        if not metas and dev_meta is None:
            return
        picker = render.builds_json(pid, metas, dev=dev_meta is not None,
                                    latest=self.latest_commit(pid),
                                    fallback=dev_meta)
        renamed = self.project_title(pid)
        if renamed is not None:
            picker["title"] = renamed
        _atomic_write_json(self.projects_dir / pid / "builds.json", picker)

    def _dev_meta(self, pid: str) -> dict | None:
        """The local slot's meta.json, or None if the slot is empty.

        Read rather than assumed: with no commit build in the project it is the
        only source of the project's name and title, and `builds.json` needs
        those to render a header.
        """
        try:
            meta = json.loads(
                (self.projects_dir / pid / DEV_LINK / "meta.json"
                 ).read_text(encoding="utf-8"))
        except (ValueError, OSError, RecursionError):
            return None
        return meta if _usable_meta(meta, DEV_LINK) else None

    def _refresh_index(self) -> None:
        """Rebuild the root index.json from every project's newest COMMIT build.

        The local slot is left out for the same reason it does not move `latest`
        (SPEC 7.6): the front page is the most public surface there is, and a card
        that quietly starts describing uncommitted work from somebody's laptop is
        that promise broken in the one place everybody looks. It costs nothing to
        arrange — `builds_of` already excludes the slot. A project whose only
        build is a local one therefore has no card yet, which is the honest
        answer: nothing has been published from a commit.

        Two of the card's fields are properties of the PROJECT rather than of the
        build the rest of it comes from, so they are read here and handed over:
        whether the slot is occupied (the same `_dev_meta` call `_write_builds_json`
        makes, and the front page says only that it exists — never what is in it),
        and the oldest build still on disk, which is as close to "since when" as
        anything here gets. `render.index_card` says what each is for.
        """
        with self._index_lock:
            cards = []
            for pdir in sorted(self.projects_dir.iterdir()):
                if pdir.name.startswith(".") or not pdir.is_dir():
                    continue
                metas = self.builds_of(pdir.name)
                if metas:
                    # `builds_of` sorts newest first, so the last entry is the
                    # oldest build — and `built` is required of every meta it
                    # returns, which is what makes the subscript safe.
                    card = render.index_card(
                        metas[0],
                        dev=self._dev_meta(pdir.name) is not None,
                        first_built=metas[-1]["built"],
                    )
                    renamed = self.project_title(pdir.name)
                    if renamed is not None:
                        card["title"] = renamed
                    cards.append(card)
            cards.sort(key=lambda c: c["built"], reverse=True)
            _atomic_write_json(self.root / "index.json", cards)

    # -- rename, and remove ------------------------------------------------
    def project_title(self, pid: str) -> str | None:
        """The title a rename gave this project, or None if nobody renamed it.

        None rather than the build's own title, so every caller can tell the two
        apart: an override REPLACES what the newest build says, and a caller that
        got a string back either way could not know whether it was doing that.

        Read off the volume on every call rather than cached. It is one small
        file, read on the two paths that rewrite `builds.json` and `index.json`
        — both already reading every build's meta.json — so a cache would buy
        nothing and would have to be invalidated from the publish path, which is
        the sort of coupling `data/` is deliberately free of.
        """
        try:
            payload = json.loads(
                (self.projects_dir / pid / PROJECT_TITLE_FILE
                 ).read_text(encoding="utf-8"))
        except (ValueError, OSError, RecursionError):
            return None
        if not isinstance(payload, dict):
            return None
        title = payload.get("title")
        return title if isinstance(title, str) and title else None

    def set_title(self, pid: str, title: str) -> bool:
        """Rename the project. True when it was renamed, False when there is no
        such project.

        THE ID IS NOT TOUCHED AND CANNOT BE. Every permanent URL of the project
        is built from the id (SPEC 3.1), the builds behind those URLs are served
        with a year of `immutable` and cannot be recalled, so renaming an id
        would break exactly the promise this service exists to keep. There is no
        route for it and there is not going to be one.

        Existence is decided by the project DIRECTORY, which is what every other
        project-level answer here uses (`_serve_pointer_page`, `builds_of`): a
        project whose builds somebody cleared out by hand is still a project.

        The picker and the index are rewritten from what is on disk, in that
        order and for the reason `publish_built` gives: the per-project file
        first, the site-wide one after it.
        """
        pdir = self.projects_dir / pid
        with self._lock_for(pid):
            if not pdir.is_dir():
                return False
            _atomic_write_json(pdir / PROJECT_TITLE_FILE,
                               {"title": title, "renamed": utcnow_iso()})
            self._write_builds_json(pid)
        self._refresh_index()
        return True

    def clear_title(self, pid: str) -> None:
        """Forget a rename, because a push has just said what the project is called.

        A build carries the title out of the project's own `project.json`
        (`cadbuild.project.load_project`), so a push is a fresh statement of the
        name and it is the more recent one. Without this, a rename made once
        would outrank every future push for ever — and the client's `rename`
        writes the new title into `project.json` as well, so the ordinary
        sequence keeps the name rather than reverting it.

        Best effort, and called from inside the publish path: a volume that will
        not take the unlink must not turn a published build into a failed one.
        """
        try:
            (self.projects_dir / pid / PROJECT_TITLE_FILE).unlink()
        except FileNotFoundError:
            return
        except OSError as error:
            logger.warning(f"could not clear the renamed title of {pid}: {error}")

    def remove_project(self, pid: str) -> dict | None:
        """Delete one project ENTIRELY. -> what was removed, or None if absent.

        THE WHOLE PROJECT AND NEVER ONE BUILD. Removing a single build breaks a
        permanent URL, which is the one thing the service promises; removing the
        project takes the promise away with the thing it was about. This is for
        "I made a test project and I am done with it", and it is meant to be the
        big rare hammer rather than a tidying tool (SPEC 8, entry 26).

        THE CODE OF THE REMOVED REVISIONS GOES TOO, AND ONLY IF NOTHING ELSE
        POINTS AT IT. `sources/` is addressed by the digest of a source tree and
        not by project (SPEC 7.8), so the same tree published in two projects is
        one directory serving both. The invariant that store keeps is "an archive
        exists exactly when a published revision does", so leaving these behind
        would break it in the direction SPEC 7.8 names as the bad one: a stored
        tree with no revision behind it is code the hub cannot answer for.

        THE ORDER IS WHAT MAKES THE SCAN SAFE against a publish running at the
        same moment. The project tree goes first, then the digests still
        referenced by OTHER projects are collected, and only unreferenced ones
        are deleted. A concurrent publish of the same sources elsewhere either
        has already renamed its build directory into place — in which case the
        scan sees it and the archive stays — or has not, in which case it has not
        stored the archive either (`jobs._keep_the_code` runs after the publish)
        and stores it once we are done.

        The comment queue is NOT removed here: it lives under `data/comments/`,
        which belongs to CommentStore, and app.py removes both.
        """
        pdir = self.projects_dir / pid
        with self._lock_for(pid):
            if not pdir.is_dir():
                return None
            mine = self._digests_of(pid)
            builds = len(self.builds_of(pid))
            shutil.rmtree(pdir)

        referenced = set()
        try:
            for other in self.projects_dir.iterdir():
                if other.name.startswith(".") or not other.is_dir():
                    continue
                referenced |= self._digests_of(other.name)
        except OSError as error:
            # Nothing may be deleted on a scan that did not finish: an
            # incomplete answer to "what else points at this" is indistinguishable
            # from "nothing does", and acting on it removes the code of somebody
            # else's live revision.
            logger.warning(
                f"remove {pid}: the source store was left alone, because the "
                f"scan for other projects' revisions failed: {error}")
            mine = set()

        removed_sources = 0
        for digest in sorted(mine - referenced):
            try:
                shutil.rmtree(self.sources_dir / digest)
            except FileNotFoundError:
                continue
            except OSError as error:
                logger.warning(f"remove {pid}: could not remove the code of "
                               f"revision {digest}: {error}")
                continue
            removed_sources += 1

        self._refresh_index()
        logger.info(f"removed project {pid}: {builds} builds, "
                    f"{removed_sources} stored source trees")
        return {"pid": pid, "builds": builds, "sources": removed_sources}

    def _digests_of(self, pid: str) -> set:
        """Every payload digest recorded in one project's build directories.

        The `dev` slot is included. Its sources are never stored, so its digest
        normally matches nothing in `sources/` — but if the same tree was also
        published as a revision, that revision's directory carries the digest
        too, so including it changes no answer and leaving it out would be a
        special case to explain.
        """
        digests = set()
        try:
            entries = list((self.projects_dir / pid).iterdir())
        except OSError:
            return digests
        for entry in entries:
            if entry.name.startswith(".") or not entry.is_dir():
                continue
            if entry.is_symlink():
                continue
            digest = _read_digest(entry)
            if digest:
                digests.add(digest)
        return digests


def _usable_meta(meta, dir_name: str) -> bool:
    """Can everything downstream read this meta.json without a KeyError?

    The fields listed here are the ones `_switch_latest` and the two
    renderers subscript directly; a build whose meta cannot answer for all of them
    is not servable, so it is better left out of the list than allowed to break
    the next publish of the whole project.

    `commit` is also required to MATCH the directory it was found in. It is what
    `latest` is pointed at, so a mismatch — a build copied under a new name, a
    meta restored into the wrong directory — would produce a dangling symlink,
    i.e. the one failure the atomic switch exists to prevent.
    """
    if not isinstance(meta, dict):
        return False
    for key in ("pid", "project", "title", "commit", "built", "published"):
        if not isinstance(meta.get(key), str):
            return False
    if meta["commit"] != dir_name:
        return False
    variants = meta.get("variants")
    if not isinstance(variants, list) or not variants:
        return False
    return all(isinstance(v, dict) and isinstance(v.get("parts"), int)
               and isinstance(v.get("gzip"), int) for v in variants)


def _payload_digest(files: dict) -> str:
    """A digest of WHAT WAS UPLOADED, independent of tar order and timestamps.

    What is uploaded is the model's SOURCE tree (SPEC 8A.2 step 5), so this is a
    digest of the source and not of the build: the same commit pushed twice is
    the same push, whatever wall clock the two builds happened to stamp into
    their output.

    Deliberately covers only the archive's own members, not the meta.json the
    hub rewrites from the build. That one is normalized by code which changes
    when the service is updated, so hashing it would turn a hub release into a
    spurious 409 on every retry of an already-published commit.
    """
    digest = hashlib.sha256()
    for name in sorted(files):
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(files[name].encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def _hash_output(directory: Path, names) -> dict:
    """`{relative path: sha256}` for the files a build declared it ships.

    The same shape `_unpack` produces, because it feeds the same consumer:
    `render.build_meta` decides whether a view or a download names a file that
    is really there by asking whether it is a KEY of this mapping.

    The names come from `BuildOutcome.files`, which the build process claimed and
    the PARENT then checked one by one — inside `directory`, in normal form, no
    symlink in any component, a regular file that exists (`runner._verified_files`).
    That check is why this can open them directly. Taking the list rather than
    walking the tree is also what keeps the mapping to what the build SHIPS: an
    output directory holds working files too (the preview renderer writes PNGs
    nothing in meta.json points at), and a view file that was never declared has
    no business validating.
    """
    files: dict[str, str] = {}
    for name in names:
        digest = hashlib.sha256()
        with open(directory / name, "rb") as handle:
            while True:
                chunk = handle.read(CHUNK)
                if not chunk:
                    break
                digest.update(chunk)
        files[name] = digest.hexdigest()
    return files


def _read_digest(build_dir: Path) -> str | None:
    try:
        return (build_dir / PAYLOAD_DIGEST_FILE).read_text(encoding="utf-8").strip()
    except OSError:
        return None


def _atomic_write_json(path: Path, payload) -> None:
    """Write JSON so a reader sees the old file or the new one, never a torn one."""
    atomic_write_bytes(path, json.dumps(payload, indent=1).encode("utf-8"))


def atomic_write_bytes(path: Path, data: bytes, *, tmp_dir: Path = None) -> None:
    """Write bytes so a reader sees the old file or the new one, never a torn one.

    The fsync before the rename is what makes that true across a power loss as
    well as across a concurrent read: rename is atomic with respect to other
    processes either way, but without the flush the new NAME can reach the disk
    while the new CONTENT has not, and the file comes back empty after a crash.

    Public, unlike everything else in this module's private half, because the
    comment queue (SPEC 7A.3) lives outside a build directory but has exactly the
    same requirement: a reader must never see half a comment. One implementation
    of "temp file, fsync, rename" rather than two that drift apart.

    `tmp_dir` puts the temporary file somewhere other than beside the target. It
    has to be ON THE SAME FILESYSTEM or the rename stops being a rename — it
    becomes EXDEV, and this function raises rather than silently copying. The
    caller is `src/jobs.py`, which keeps its temporaries in `data/jobs/` instead
    of inside each job directory, so that the one thing that collects strays
    from that tree — `JobStore._sweep_strangers`, at startup — is looking where
    a leftover of a killed write actually lands. Inside a live job's directory
    nothing ever collects one.

    NOT `_sweep_leftovers`, which is the near miss worth naming: the sweep above
    this one walks `self.root` and the project directories, and `data/jobs/` is
    neither, so a `.wip-` file under it is invisible here however familiar the
    prefix looks. `JobStore._sweep_strangers` carries its own short cutoff for
    that prefix for exactly this reason.

    WHAT IT IS NOT is a defence against a build making one write fail. That was
    the reason it was first proposed and it does not work, so it is written down
    here to stop it being proposed again: `rename(tmp, dir/name)` needs write
    permission on the DESTINATION directory, exactly as `open(dir/tmp)` did, so
    `chmod 0500` on a job directory refuses both. Measured, not reasoned:
    PermissionError either way. The only layout that would defuse it is one
    where no per-job directory exists at all, and what makes a pointwise
    failure survivable here is instead that nothing shared between records is
    written per record at all (see `JobStore._rewrite_locked` in `src/jobs.py`).
    """
    parent = path.parent if tmp_dir is None else Path(tmp_dir)
    tmp = parent / f"{JSON_TMP_PREFIX}{path.name}-{uuid.uuid4().hex}"
    try:
        with open(tmp, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o644)
        os.rename(tmp, path)
    except BaseException:
        # The temp name is dot-prefixed, so a leftover is invisible to every
        # reader and would sit on the volume until the next startup sweep. That
        # is tolerable after a SIGKILL and not tolerable per failed request on a
        # PUBLIC endpoint, which is what the comment queue is.
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    # And the DIRECTORY, because the rename is a change to the directory entry
    # rather than to the file. Flushing only the file leaves the new content
    # durable under a name that is not: after a power loss the old name can still
    # be the one on disk, which is precisely the outcome the sentence above
    # promises will not happen. Best effort — some filesystems refuse to fsync a
    # directory, and that is not a reason to fail a publish that has landed.
    try:
        dir_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except OSError as error:
        logger.warning(f"could not fsync the directory of {path}: {error}")
