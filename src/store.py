"""On-disk layout and atomic publication.

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
    <data>/compare/<pid>/<a>/<b>/<view>/   one computed comparison (issue #10)

`compare/` IS OUTSIDE THE BUILD DIRECTORIES for the two reasons SPEC 8A.3 gives,
and neither of them is survival: the pair's ends are published revisions and
nothing deletes those. It is RIGHTS — a build directory is public and this is
behind EDIT_TOKEN — and it is CACHING: a build URL carries a year of
`immutable`, while a comparison whose end is a pointer moves whenever the
pointer does. Putting it inside `<pid>/<a>/` would have given away both.

It is a CACHE and it is written like a build: a staging directory beside the
entry, then one rename. Recomputing costs about as much as a build (issue #10
measured 1.49 s a pair) and nothing here prunes it, exactly as nothing prunes
anything else on this volume.

`sources/` IS THE CODE OF EVERY PUBLISHED REVISION, and three things about it are
decisions rather than arrangement (issue #17).

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

The naming rule that carries security weight here is enforced by whitelist
rather than by blacklist, because a whitelist cannot be walked around by an
encoding nobody thought of: `<pid>` and `<commit>` come from the URL and may
only be `[A-Za-z0-9_-]`, so they can never contain a separator or a dot
component. `latest` and `dev` are reserved.

THE UPLOADED TAR IS READ SOMEWHERE ELSE. Opening one, walking it and writing
the source tree out is `src/archive.py`, together with the ceilings and the
per-component alphabet that say what a member may be called. Those names are
re-exported below, so `store.SAFE_COMPONENT` and the rest go on meaning what
they always did; `Store._unpack` is a call into that module.
"""

import hashlib
import json
import os
import re
import shutil
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger

# The name of the file a build writes and the next build of the same project is
# handed back as its baseline (`dev_metrics_path` is what names it here). Taken
# from the module both readers already share rather than spelled again — a
# second copy of the string is exactly the drift that module exists to prevent.
from hammerola.metricsdiff import METRICS_NAME
from src import render
# The archive reader. Re-exported rather than merely imported, because these
# names are reached as `store.<name>` from outside: `app.py` and
# `onboarding.py` quote `store.SAFE_COMPONENT`, `tests/client/test_limits.py`
# holds the client's copies of three of the ceilings against this module's, and
# `CHUNK` is the buffer `_hash_output` below reads with. One import here and no
# caller of any of them has to know where they are defined.
from src.archive import (ALPHABET_FAULT, ARCHIVE_OVERHEAD_BYTES, CHUNK,
                         CORRUPT_ARCHIVE_ERRORS, ELLIPSIS, LAYOUT_ERRNOS,
                         MAX_COMPONENT_CHARS, MAX_HEADER_READS_PER_MEMBER,
                         MAX_MEMBER_NAME_CHARS, MAX_MEMBERS, MAX_PATH_DEPTH,
                         MAX_PAX_HEADER_CHARS, MAX_REFUSED_NAME_CHARS,
                         MAX_REFUSED_NAMES_REPORTED, MAX_SINGLE_READ_BYTES,
                         PAX_WIRE_BYTES_PER_CHAR, PER_ENTRY_OVERHEAD_BYTES,
                         SAFE_COMPONENT, _CountingReader, _create_member_file,
                         _cut_middle, _is_the_disk, _member_parts, _members_of,
                         _open_member_dir, _pax_header_chars,
                         _refused_names_error, _shown_untrusted, unpack)
from src.errors import PublishError
from src.safeio import open_regular, read_regular_text

# Identifiers that arrive in the URL. No dot at all: that keeps a build directory
# from ever colliding with `builds.json`, and keeps it from being a dot-entry the
# file server hides.
# `\A`/`\Z` and not `^`/`$`: in Python `$` also matches just before a trailing
# newline, so `^...$` accepts "proj1\n" — which would create a directory with a
# newline in its name and put a bare LF into the `Location` header of the reply.
SAFE_ID = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")

# A VIEW ID, WHICH IS THE FOURTH SEGMENT OF A COMPARISON CACHE ENTRY and is NOT
# an id this hub mints. `SAFE_ID` was the rule here for a while and it is the
# wrong one: it is what a PROJECT and a BUILD are named with, while a view id is
# the model author's own string, held at build time to
# `cadbuild.hubspec.MEMBER_RE` -- which allows a dot and 128 characters. So a
# model with a view called `top.v2` publishes, shows its tab, and answered a
# comparison of that tab with a bare 404: the name was refused by a rule nobody
# had ever told the author about, in the first place a view id becomes a path
# segment.
#
# THE RULE IS "A NAME THAT MAY BE A DIRECTORY SEGMENT" and nothing narrower.
# Written out here rather than imported from `cadbuild`: the serving half does
# not import the build half (see COMPARE_FILES below for the same trade), and
# `tests/test_compare.py` holds the two patterns equal so a view id a build
# accepts and this cache refuses fails there instead of in somebody's panel.
# It is also NOT `SAFE_COMPONENT` in `src/archive.py`, however identical the two
# look today: that one is the alphabet of an ARCHIVE MEMBER's path on the way
# IN, a different door with its own suite, and `hammerola/buildnames.py` records
# the decision to keep the doors apart.
#
# What the alphabet buys is the whole point: a component must START
# alphanumeric, so `.`, `..`, `.hidden` and the empty string are out, and the
# class holds no `/`, no backslash, no NUL and nothing outside ASCII -- so a
# name that passes can never be a separator, a traversal hop, or a lookalike of
# one in another script. `\Z` and not `$` for the reason `SAFE_ID` gives.
SAFE_VIEW_ID = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")

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
# The build log, beside the code rather than only at the job (issue #17).
# The job's copy is not going anywhere — no job is ever deleted — but it is
# addressed by a JOB id, which is per attempt and recorded against nothing, so a
# month later the log of a revision is unreachable from the revision. This copy is
# the one half of "how did this revision come about" that would otherwise be
# reachable only by whoever still had the id from the push.
SOURCE_LOG_NAME = "log.txt"

# The comparison cache (issue #10): `compare/<pid>/<a>/<b>/<view>/`, holding
# exactly the two files below. Not dot-prefixed, for the reason `sources/` is
# not: nothing serves this tree by path — `_serve_compare` in app.py composes
# the entry's path itself, from ids it has already checked — and a name somebody
# will one day go looking for by hand is better plainly visible.
#
# THE THREE IDS ARE THREE DIRECTORIES AND NOT ONE NAME, because a name needs a
# separator and no separator is safe here. `SAFE_ID` accepts `_`, so a build may
# legally be called `a__b`: joined with any run of underscores, `<a>="x"` with
# `<b>="y__z"` and `<a>="x__y"` with `<b>="z"` spell the same directory, and one
# comparison is then served the other's geometry. A directory boundary cannot be
# spelled inside a segment `SAFE_ID` passed, so the nesting is unambiguous by
# construction and needs no separator at all. The VIEW segment answers to
# `SAFE_VIEW_ID` instead, and the argument survives that unchanged: no `/` is in
# that alphabet either.
COMPARE_DIR_NAME = "compare"
# What one entry holds, and the only names the file server will serve out of
# one. `src/buildproc/comparechild.py` writes them and `runner._COMPARE_ARTEFACTS`
# checks they arrived; the hub half may not import the build half, so the tuple
# is spelled three times and `tests/test_compare.py` holds the three equal.
COMPARE_FILES = ("scene.json", "report.json")

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

# The job of the last build pushed into this project's `dev` slot, written when
# that build STARTS (issue #32). It is what lets the front page say that a
# project's draft is building or has failed: the slot's own meta.json also
# carries a `job`, but only a build that SUCCEEDED ever writes one there, so a
# build in flight and a build that failed leave no trace inside the slot at all.
#
# BESIDE `title.json` AND NOT INSIDE THE SLOT, and both halves matter.
# `_swap_dev_slot` replaces the slot wholesale, so a file written into it before
# the build is thrown away by the publish it was recording. And the slot's `job`
# means "the job that FILLED this slot", which is a different fact from "the job
# that was last asked to fill it" — a failed attempt must not overwrite the one
# name from which the log of what is actually being served can be found.
#
# Unreachable from the outside for the same reason `title.json` is: `SAFE_ID` has
# no dot in it, and `_serve_project` only takes a second segment that is a
# pointer name or passes `valid_build_id`.
PROJECT_DRAFT_JOB_FILE = "draft.json"

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
# Any atomic write this module makes, for as long as it is not yet renamed into
# place — a rule rather than a list, because naming three of them invites the
# fourth to be forgotten. All of them land where the sweep below looks; the one
# that has to ask for it is `_restate_message`, whose target lives in a build
# directory the sweep does not walk.
JSON_TMP_PREFIX = ".wip-"
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
#
# THAT IS THE ARITHMETIC THAT BROKE, and it broke silently exactly as predicted.
# At 16, 120 s and 2 it was sixteen minutes, comfortably inside the hour. The
# 2026-08-29 raise of `wall_seconds` to 900 s made it TWO HOURS — past an hour,
# so this sweeper would have deleted the unpacked sources of a build still
# sitting in the queue, and the build would then have failed on a tree that was
# there when it was accepted. Nothing tests this and nothing would have said so;
# the only reason it was caught is that the comment above did the multiplication
# out loud.
#
# THE WAIT HAS COME DOWN TWICE SINCE, AND THIS NUMBER MOVED NEITHER TIME. The
# workers went from two to four on 2026-09-09 (issue #80), halving it to an hour,
# and `wall_seconds` came back down to 300 s on 2026-09-10 (issue #81), leaving
# 16 × 300 / 4 = TWENTY MINUTES. Both times the reason for standing still was the
# same: this side of the comparison is the safe one, and only a RISE in the wait
# can break it. `tests/test_build_ceilings.py` is what says so rather than this
# paragraph — it computes the worst honest wait out of the live constants and
# asserts this one clears it.
#
# Four hours against twenty minutes is a great deal of room, and it is kept
# rather than trimmed because the cost of the room is the cheap end: a killed
# 64 MiB upload sits on the volume for up to four hours instead of one. A
# leftover wastes space, a swept-out source loses a build, and only one of those
# two is worth being close about.
LEFTOVER_MAX_AGE_SECONDS = 4 * 3600


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
        # NOT created here either, and for the same reason: a hub nobody has
        # asked for a comparison on has no `compare/` at all.
        self.compare_root = self.root / COMPARE_DIR_NAME
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

        Only entries older than `LEFTOVER_MAX_AGE_SECONDS` — four hours, and the
        block at its definition says what fixes that figure — are touched,
        because a concurrent publish in this very process is using names of
        exactly the same shape. This runs from `Store.__init__` and from nowhere
        else, so it is a sweep at startup rather than a periodic one.
        """
        cutoff = time.time() - LEFTOVER_MAX_AGE_SECONDS
        directories = [self.root]
        # A PROJECT DIRECTORY, where a build stages. One level down from
        # `projects/`, so walking the root does not reach it and a `.tmp-` left
        # in one by a SIGKILL is swept by this or by nothing.
        try:
            directories += [p for p in self.projects_dir.iterdir() if p.is_dir()]
        except OSError:
            pass
        # AND WHERE A COMPARISON STAGES, which is `compare/<pid>/<a>/<b>/` —
        # THREE levels down, because the cache entry is the `<view>` inside it
        # and staging sits beside the entry (`compare_staging`). The depth is the
        # one thing this has to be told: the glob is the layout `compare_dir`
        # builds, read from the other end.
        directories += [p for p in self.compare_root.glob("*/*/*") if p.is_dir()]
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
    def valid_view_id(name) -> bool:
        """Can a comparison of this view be filed in the cache at all?

        The one door onto `SAFE_VIEW_ID`, so the shape of a view id is decided
        in this module and not spelled again in the route: `_handle_compare` in
        app.py asks this to refuse a name IN WORDS rather than with a blank 404,
        and `compare_dir` asks it to keep the path it assembles honest.

        NO RESERVED NAMES ON IT, unlike `valid_build_id`. `latest` and `dev`
        are names of BUILDS this hub answers to, and the fourth segment sits
        under a pair of commits where nothing of ours ever writes a name of its
        own — a model may call a view whatever `MEMBER_RE` accepts, `dev`
        included, and refusing that would be this hub taking a word away from
        the author for no reason it could name.
        """
        return isinstance(name, str) and bool(SAFE_VIEW_ID.match(name))

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
            # leave an unpacked tree that only the STARTUP sweep would ever
            # remove, and only four hours later (`_sweep_leftovers`).
            shutil.rmtree(sources, ignore_errors=True)
            raise
        return AcceptedPush(sources=sources, archive=archive, digest=digest,
                            commit=name)

    def settled(self, pid: str, commit: str, digest: str,
                message: str = None) -> tuple[int, dict] | None:
        """Has this exact push already been published? (status, body), or None.

        Raises PublishError(409) when the name is taken by different content.

        `message` is the ONE thing a repeat push can still change (issue #67).
        The tree is identical, so there is nothing to rebuild and nothing else to
        write — but what the author says this revision is may well be the reason
        they pushed again, and the answer to "which revision was that" lives in
        the picker rather than in the geometry.

        Asked BEFORE a build is queued, which is the whole point: rebuilding a
        commit that is already on disk costs minutes of CPU to arrive at an
        answer that was on disk all along, and answering 200 or 409 from the
        request keeps both of those codes where the pusher already expects them —
        immediately, rather than through a job it would have to poll.

        Not under the project lock, on purpose. THE COMPARISON is a read whose
        answer can only go stale in one direction — another push landing the same
        commit between here and the rename — and `publish_built` makes exactly
        the same comparison again, under the lock, where it is authoritative.
        The one WRITE that can follow from it takes the lock for itself, because
        it is not a comparison and a lost update there is a lost update
        (`_restate_message`).
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
            self._restate_message(pid, commit, final, message)
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

    def _restate_message(self, pid: str, commit: str, final: Path,
                         message: str) -> None:
        """Put a new message on a revision that is already published.

        ONLY WHEN THERE IS ONE AND IT DIFFERS. A push without `-m` leaves the
        stored message alone, and that is a decision rather than an omission:
        there is no way to clear a message and this is not it — `commit` with the
        flag left off is the ordinary re-push, not a statement that the revision
        has nothing to say.

        UNDER THE PROJECT LOCK, unlike the comparison that leads here: that one
        is a read whose answer can only go stale in one direction, and this
        WRITES — to the very file `_write_builds_json` reads back through
        `builds_of` on the next line.

        WHAT A READER SEES IS ALWAYS THE NEW TEXT, and it is worth writing down
        why, because the arrangement looks like it should go stale and does not.
        Every surface that SHOWS a message reads `builds.json`
        (`render._picker_entry` -> the revision list), and that file is served
        `no-cache` and rewritten on the line below — so the picker is current the
        moment anybody opens it. The copy that does get frozen is the `message`
        key inside the revision's own meta.json, which is served `immutable` for
        a year; nothing renders it. It is read exactly twice, both times on this
        side of the wire and both times off the disk rather than out of a cache:
        here, to compare against, and by `builds_of` when the picker is composed.

        So nothing here busts a cache and nothing needs to: the immutability of a
        build URL is what the whole scheme rests on (SPEC 3.2), and what this
        rewrite puts out of date is a field no page fetches.

        BEST EFFORT. The revision is published and the answer is 200 either way,
        so a volume that will not take this write costs the message and never the
        push.
        """
        if not message:
            return
        try:
            with self._lock_for(pid):
                path = final / "meta.json"
                meta = json.loads(read_regular_text(path))
                if meta.get("message") == message:
                    return
                meta["message"] = message
                # THE TEMPORARY GOES ONE LEVEL UP, into `<pid>/`: the only
                # target in this module that sits where the sweep cannot reach.
                # `_atomic_write_json` explains the parameter, and
                # `test_a_restate_writes_its_temporary_where_the_startup_sweep_looks`
                # holds it.
                _atomic_write_json(path, meta, tmp_dir=final.parent)
                self._write_builds_json(pid)
            logger.info(f"publish {pid}/{commit}: message updated")
        except Exception:
            logger.exception(
                f"publish {pid}/{commit}: the revision is published, but its "
                f"message could not be updated")

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
                      digest: str, job=None, message=None) -> tuple[int, dict]:
        """Put one built tree at `<pid>/<commit>`. Returns (status, response).

        201 published, 200 identical retry, 409 same commit / different content.
        Anything else is raised as PublishError.

        `staging` is the directory the build wrote into and `names` are the files
        it declared it ships (`BuildOutcome.files`, every one of them already
        checked by the parent to be a regular file under `staging`). The caller
        owns `staging`: on the success path it is renamed away and there is
        nothing left, and on every other path the caller removes it.

        `job` reaches only the COPY this makes into the slot: the revision's own
        document does not carry one (issue #79, `render.build_meta`).

        `message` goes the other way — into the REVISION's document, because it
        is what that revision says about itself (issue #67). The mirror below
        copies it into the slot along with everything else that is the same
        build's.
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

            meta = self._finish_staging(pid, commit, staging, files, digest,
                                        message=message)
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
            # ORDER STILL MATTERS on the success path, and there are three steps
            # in it: the slot is filled with this revision, then `latest` moves
            # onto it, then the picker is written — last, from what is on disk
            # once both have settled. The symlink still moves before the picker,
            # so a reader following `latest` is on the new build before the
            # picker starts offering it.
            #
            # What the MIRROR has to come before is `_write_builds_json` and
            # `_refresh_index`, because both are written from what is on disk:
            # `has_dev` in `builds.json` and the card on the front page are
            # answers about the slot, and a slot filled after they were written
            # would not appear in either until the next publish of this project.
            # Against `_switch_latest` there is no such argument either way, and
            # it sits after the mirror only because the three steps are stated
            # in the order above. The price of that is that `latest` moves later
            # by however long a full `copytree` takes, and it is acceptable: the
            # revision is already published at its own permanent URL — `latest`
            # is a pointer to it, not the publication.
            try:
                self._mirror_into_dev_slot(pid, pdir, final, meta, digest, job)
                # A rename is superseded by the push that follows it: the build
                # carries the project's own title, and that is the newer
                # statement of what the project is called. Before the picker is
                # written, so the file is rebuilt from the state that survives.
                self.clear_title(pid)
                # AND SO IS A DRAFT, for the same reason and one line later. The
                # mirror above has just put this revision INTO the slot, so
                # `_uncommitted_in_slot` is false and the `dev` chip goes -- and
                # a draft status left behind would outlive the draft it is about:
                # a card whose local work is gone would keep saying that work
                # failed, until some later DRAFT push, which may be weeks away.
                #
                # THE COST, so it is a decision: a draft build in flight right
                # now loses its `building` chip to this commit. That is the
                # right way round -- the chip comes back wrong for the rest of
                # one build, against a red chip that is wrong for ever.
                self.clear_draft_job(pid)
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
            f"{len(meta['views'])} views")
        return 201, _build_url(pid, commit)

    def publish_dev_built(self, pid: str, staging: Path, names,
                          digest: str, job=None) -> tuple[int, dict]:
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

        `job` goes into the slot's meta.json (issue #79). The slot is the one
        build no revision addresses, so the job that filled it is the only place
        its log exists, and this field is what remembers which job that was.
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
            meta = self._finish_staging(pid, DEV_LINK, staging, files, digest,
                                        job=job)
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
        # the project holds work no commit has published
        # (`_uncommitted_in_slot`). Without this line the chip would wait for
        # the next `_refresh_index` from anywhere at all, and this project's own
        # next commit is not it: that one fills the slot with the revision, so
        # the chip this push earned would be cleared without ever having been
        # drawn. With it, a local push costs one index rebuild, which is nothing
        # beside the build that produced the push.
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
            f"{len(meta['views'])} views")
        return 201, url

    @staticmethod
    def _swap_dev_slot(pdir: Path, source: Path) -> None:
        """Put a prepared tree into `<pid>/dev/`, replacing what is there.

        `source` is a directory beside the slot that is ready to BE the slot, and
        it comes from two places now: the tree a `build` push unpacked
        (`publish_dev_built`), and a copy of a revision that has just been
        published (`_mirror_into_dev_slot`). It is consumed either way — the
        rename below is what empties it.

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
        Store._replace_directory(pdir / DEV_LINK, source)

    @staticmethod
    def _replace_directory(target: Path, source: Path) -> None:
        """The two renames `_swap_dev_slot` describes, with the target named.

        One copy of the dance, because there are two names on this volume that
        are REPLACED rather than only created — the `dev` slot and a comparison
        cache entry — and the ordering above is the whole of what makes either
        of them safe to read while it is being written.
        """
        parked = target.parent / f"{TRASH_PREFIX}{uuid.uuid4().hex}"
        occupied = os.path.lexists(target)
        if occupied:
            os.rename(target, parked)
        try:
            os.rename(source, target)
        except OSError:
            if occupied:
                os.rename(parked, target)
            raise
        if occupied:
            shutil.rmtree(parked, ignore_errors=True)

    # -- the comparison cache (issue #10) -----------------------------------
    def compare_dir(self, pid: str, old: str, new: str, view: str) -> Path:
        """Where one computed comparison lives. Raises ValueError on a bad id.

        `compare/<pid>/<a>/<b>/<view>/`, and every one of the four segments has
        to be a name this store would put in a path — the first three to
        `SAFE_ID`, the id a project and a build are held to, and the VIEW to
        `SAFE_VIEW_ID`, because a view id is the author's own string and not an
        id this hub mints (see the constant). Both rules keep a `..`, a `/` and
        a leading dot out of a path assembled here, which is the whole of what
        either is for. RAISED rather than returned as a bool: the callers are
        the route, which turns it into an answer, and the worker, which never
        gets that far because the route already asked.

        FOUR DIRECTORIES AND NOT ONE NAME, for the reason the constant block
        above gives at length: `SAFE_ID` accepts `_`, so any separator a joined
        name could use is a character a build id may itself contain, and two
        different pairs would then name one entry.

        NEITHER END IS EVER A POINTER, and that is what makes every entry here
        immutable. An entry is filed under the names it was ASKED with, so one
        under `latest` would go on answering for a pair that has moved on — a
        stale file, which no cache header fixes. Both routes that name an entry
        (`_serve_compare` and `_handle_compare` in app.py) refuse `latest` and
        `dev` outright, and the client resolves `latest` to a commit before it
        asks; `dev` has no commit id at all, so the slot is not comparable.
        """
        for segment in (pid, old, new):
            if not isinstance(segment, str) or not SAFE_ID.match(segment):
                raise ValueError(f"{segment!r} is not an id this store names a "
                                 f"comparison with")
        if not self.valid_view_id(view):
            raise ValueError(f"{view!r} is not a name this store can file a "
                             f"comparison under")
        return self.compare_root / pid / old / new / view

    def compare_staging(self, pid: str, old: str, new: str, view: str) -> Path:
        """Where a comparison writes: the directory that becomes that entry.

        CREATED HERE, unlike `build_staging`, and the difference is whose code
        writes into it. A build's output directory has to arrive absent because
        `cadbuild.build` insists on making it itself; a comparison's is written
        by `comparechild`, which refuses an `--out-dir` that is not there — so
        the directory existing is what says the parent meant this one.

        Beside the entry it becomes, so publication is a rename inside one
        directory: the same reason `build_staging` sits inside the project.
        """
        final = self.compare_dir(pid, old, new, view)
        final.parent.mkdir(parents=True, exist_ok=True)
        staging = final.parent / f"{STAGING_PREFIX}{final.name}-{uuid.uuid4().hex}"
        staging.mkdir()
        return staging

    def publish_compare(self, pid: str, old: str, new: str, view: str,
                        staging: Path) -> Path:
        """Put a computed comparison at its cache entry. -> where it landed.

        `staging` is consumed by the rename, exactly as the `dev` slot's source
        is: the caller owns it until this returns and owns nothing afterwards.

        REPLACING WHAT IS THERE IS THE ORDINARY CASE and not an error. A pair
        recomputed is the same answer again, and there is nothing here worth a
        409 besides: nothing in this tree is a permanent URL somebody was
        handed. Under the project's own lock, which is what serialises two
        workers asked for the same pair at once.
        """
        final = self.compare_dir(pid, old, new, view)
        with self._lock_for(pid):
            final.parent.mkdir(parents=True, exist_ok=True)
            self._replace_directory(final, staging)
        logger.info(f"compare {pid} {old} -> {new} ({view}): cached")
        return final

    def _mirror_into_dev_slot(self, pid: str, pdir: Path, final: Path,
                              meta: dict, digest: str, job=None) -> None:
        """Put a revision that has just been published into `<pid>/dev/` too.

        The slot is the freshest state the hub knows about the project, not the
        last call to `build` (issue #78): without this a commit leaves the slot
        showing geometry OLDER than `latest`.

        A COPY of the published tree, because the rename that publishes it is
        what emptied the staging directory. Nothing is validated a second time
        and `_finish_staging` is not called again: AT THIS MOMENT a revision's
        meta.json and the slot's differ in exactly three keys, `commit`, `dev`
        and `job` (`render.build_meta`), and every other field is the same
        build's. The third one is why this takes a `job` at all — the slot names
        the build that filled it, and a commit fills it as much as a `build`
        does, so the id has to be carried across with the tree (issue #79).

        "AT THIS MOMENT" IS LOAD-BEARING AND THE SENTENCE USED TO LACK IT. The
        three hold at publication and a fourth can appear afterwards: a repeat
        push of the same tree rewrites `message` on the REVISION alone
        (`_restate_message`, issue #67), and this copy is not made again — the
        build never runs — so the slot keeps the text the revision carried when
        it filled the slot. That is a difference in the documents, not a defect
        in either: nothing reads the slot's `message`, because the picker lists
        commits and the slot is not one of them (SPEC 7.6). Left as a copy that
        goes stale rather than as a second place to keep in step, which is what
        the field would become the moment anything did read it.

        THE SWAP IS UNCONDITIONAL, including where the slot already holds these
        very sources — the case `publish_dev_built` short-circuits on, to spare
        an open page a needless re-render. It is not an oversight to optimise
        away: what has to end up in the slot is THIS REVISION's meta.json, and a
        slot filled by an earlier `build` of the same sources holds a different
        document — a build's `built` and `published` stamps rather than the
        revision's. Skipping the copy would leave the two disagreeing about when
        the thing on screen was made.

        NEVER RAISES. It runs past the point of no return, so a slot that could
        not be written must not unpublish the revision or fail the job that
        pushed it — and the slot has no history to lose, because the next writer
        overwrites it.
        """
        tmp = pdir / f"{STAGING_PREFIX}{DEV_LINK}-{uuid.uuid4().hex}"
        try:
            shutil.copytree(final, tmp)
            (tmp / "meta.json").write_text(
                json.dumps(dict(meta, commit=DEV_LINK, dev=True, job=job),
                           indent=1),
                encoding="utf-8")
            # Redundant against the `copytree` above, which already brought
            # this exact digest across, and written anyway: the slot's digest is
            # what makes a later `build` of these same sources answer 200 out of
            # the slot instead of rebuilding, and what tells the front page the
            # slot holds nothing the commit does not (`_uncommitted_in_slot`).
            # A link that load-bearing belongs in the method that establishes
            # it, not inherited from a tree copy where nothing names it.
            (tmp / PAYLOAD_DIGEST_FILE).write_text(digest, encoding="utf-8")
            self._swap_dev_slot(pdir, tmp)
        except Exception:
            shutil.rmtree(tmp, ignore_errors=True)
            logger.exception(
                f"publish {pid}/{final.name}: the revision is published, but "
                f"the {DEV_LINK} slot was not updated to match it")

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
        """Extract the archive into `dest`. The rules are `src/archive.py`."""
        return unpack(body_path, dest, self.max_build_bytes)

    # -- staging -> publishable directory ----------------------------------
    def _finish_staging(self, pid, commit, staging: Path, files, digest,
                        job=None, message=None) -> dict:
        """Validate meta.json and write everything the build page needs.

        `staging` is what the BUILD wrote (SPEC 8A.2 step 5), so the meta.json
        read here is the build's own — the same wire format the archive used to
        carry, produced one step closer to the model. Nothing else about this
        changed, which is the point of pointing the build at the directory that
        gets renamed into place.

        `job` is the id of the job that produced this tree. It is handed on and
        not read here: `build_meta` records it in the SLOT's document only
        (issue #79), so it is ignored on the revision path.

        `message` is the mirror image of that: what the PUSH said this revision
        is (issue #67). It came off a header rather than out of the tree, which
        is why it arrives as an argument at all — nothing in `staging` knows
        about it — and it is already validated (`render.revision_message`).
        """
        raw = self._read_meta(staging)
        try:
            meta = render.build_meta(
                pid=pid, commit=commit, raw=raw, staging=staging, files=files,
                published=published_stamp(), dev=(commit == DEV_LINK), job=job,
                message=message)
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
        """The build's own meta.json, off the staging directory it wrote.

        `is_file()` STAYS, and it is not the type check: it is what tells "the
        build produced no meta.json" — a 422 naming the actual mistake — apart
        from every other way a read can fail. The type check is `safeio`'s, on
        the handle, which is what closes the gap between the two: a fifo swapped
        in after the `is_file()` used to be a publish worker gone for good, and
        is now the same `OSError` an unreadable file was always answered with.
        """
        path = staging / "meta.json"
        if not path.is_file():
            raise PublishError(422, "the build produced no meta.json")
        try:
            raw = json.loads(read_regular_text(path))
        except (ValueError, UnicodeDecodeError) as error:
            raise PublishError(422, f"meta.json is not valid JSON: {error}") from error
        if not isinstance(raw, dict):
            raise PublishError(422, "meta.json must be a JSON object")
        return raw

    # -- project-level state -----------------------------------------------
    def empty(self) -> bool:
        """Has anything ever been published here? The ONE fact given anonymously.

        Read by `/start` (src/onboarding.py), which is the only route on this
        service that answers a question about the deployment without a token —
        so what this returns is a boolean and there is deliberately nothing here
        that could turn into a count, a name or a date.

        THE QUESTION IS "IS THERE A PROJECT", NOT "IS THERE A CARD". A project
        whose only build sits in the `dev` slot has no entry in `index.json` —
        the index is built from committed revisions (SPEC 7.6) — and this hub is
        emphatically not empty: somebody has pushed to it and `hammerola status`
        has something to say about it. Reading the index instead would call that
        hub empty and hand its owner instructions for a first push they have
        already made.

        A PROJECT DIRECTORY WITH NOTHING IN IT DOES NOT COUNT, and that is the
        difference between this and "does `project/` have entries". The reason
        is `build_staging`: it creates `project/<pid>/` before the build runs,
        and NOTHING removes that directory when the build then fails the gate —
        the caller removes the staging tree inside it and leaves the shell. So
        counting bare directories meant the first push of a new hub turned
        `empty` false FOREVER by failing, which lands on precisely the person
        the answer exists for: somebody whose very first build did not pass.
        The old wording defended the in-flight case with "which is what the
        answer will be a moment later anyway" — true of a build that succeeds,
        and false of one that does not.

        A directory in flight still counts, and now for a reason rather than by
        accident: the staging tree is INSIDE it while the build runs, so it is
        not empty. A `dev`-only project counts too, because its slot is a
        directory in there. What is left out is exactly the residue.

        THE DRAFT'S POINTER IS RESIDUE TOO, and it is the second thing a build
        that fails can leave behind (issue #32). `set_draft_job` writes
        `draft.json` when a draft build STARTS, before there is a slot or
        anything else under the id — so without this name being skipped, a hub
        whose very first push was a draft that did not build would answer "not
        empty" for ever, which is the exact failure the paragraph above is
        about, arriving by a second road.

        FAILS CLOSED. An unreadable `project/` answers "not empty", so no
        onboarding block is shown on a hub that could not be asked; the
        alternative would be to tell somebody their hub is empty on the strength
        of an error.

        WHAT CONSUMES THE ANSWER is the sign-in page: `/start` serves this
        boolean and the door draws its block for an agent when it is true
        (`ui/src/HammerolaEntry.jsx`, issue #48; `src/onboarding.py` has
        the accounting). The fail-closed rule was pinned before that page
        existed, and it held: it is a property of the answer, so the page
        inherited it rather than having to reinvent it.
        """
        try:
            return not any(
                entry.is_dir() and any(child.name != PROJECT_DRAFT_JOB_FILE
                                       for child in entry.iterdir())
                for entry in self.projects_dir.iterdir())
        except OSError as error:
            # Both `iterdir()`s are inside this, and the inner one is the reason
            # it is worth saying: a project directory the hub cannot read is not
            # evidence that the hub is empty, so it fails closed like the outer
            # one does.
            logger.warning(f"cannot tell whether {self.projects_dir} is empty: "
                           f"{error}")
            return False

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
                meta = json.loads(read_regular_text(meta_path))
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
            meta = json.loads(read_regular_text(
                self.projects_dir / pid / DEV_LINK / "meta.json"))
        except (ValueError, OSError, RecursionError):
            return None
        return meta if _usable_meta(meta, DEV_LINK) else None

    def dev_metrics_path(self, pid: str) -> Path | None:
        """The local slot's metrics.json, or None when there is nothing there.

        A path rather than the parsed file: the only caller hands it to a build
        process, and parsing it here would mean two readers of the same file
        disagreeing about what a broken one is. Tolerant like `_dev_meta` next
        to it — an unreadable slot is a missing baseline, never an exception on
        the publish path, and `is_file()` answers False for every way a path can
        refuse to be looked at rather than raising.
        """
        path = self.projects_dir / pid / DEV_LINK / METRICS_NAME
        return path if path.is_file() else None

    def _uncommitted_in_slot(self, pid: str) -> bool:
        """Whether the local slot holds sources that no commit has published.

        The question behind the `dev` chip on the front page, and deliberately
        NOT the `has_dev` that `_write_builds_json` writes: that one asks whether
        the slot EXISTS, because the picker uses it to decide whether to offer a
        `/dev/` link at all. The two were the same question until a commit began
        filling the slot with itself (issue #78); since then "occupied" is true
        of every project that has ever committed, so a chip built on it would sit
        on every card and say nothing.

        THE DIGEST IS WHAT SEPARATES THEM. It is the digest of the SOURCES a
        push carried, and the mirror writes the revision's own digest into the
        slot — so a slot whose digest equals the newest commit's publishes
        nothing that commit does not, while a `build` push of edited sources
        lands a different one. Comparing the trees would answer a weaker
        question anyway: two builds of the same sources can differ byte for byte
        in their timestamps alone.

        ERRING TOWARDS TRUE on a digest that will not read is deliberate: the
        slot is there, nothing accounts for what is in it, and True is the answer
        this gave for the whole time before the slot could hold a commit. The
        failure it chooses is a chip on a card that did not need one, rather than
        work on somebody's laptop that the front page quietly stops mentioning.
        """
        if self._dev_meta(pid) is None:
            return False
        commit = self.latest_commit(pid)
        if commit is None:
            # `latest` does not read: the symlink is gone, or a previous
            # publish did not get as far as setting it. There is nothing to
            # compare the slot against, so the chip stays -- see ERRING TOWARDS
            # TRUE above. Not "no commits at all": the only caller reaches this
            # with the project's commit builds already in hand.
            return True
        pdir = self.projects_dir / pid
        in_slot = _read_digest(pdir / DEV_LINK)
        published = _read_digest(pdir / commit)
        return not (in_slot is not None and in_slot == published)

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
        whether the slot holds sources no commit has published
        (`_uncommitted_in_slot` — the front page says only THAT there is such
        work, never what it is), and the oldest build still on disk, which is as
        close to "since when" as anything here gets. `render.index_card` says
        what each is for.

        The first of those is NOT the `has_dev` that `_write_builds_json` writes
        from `_dev_meta`, and the two must not be collapsed back into one call:
        that one asks whether the slot exists, which a commit filling the slot
        with itself (issue #78) made true of every committed project.
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
                        dev=self._uncommitted_in_slot(pdir.name),
                        first_built=metas[-1]["built"],
                    )
                    renamed = self.project_title(pdir.name)
                    if renamed is not None:
                        card["title"] = renamed
                    cards.append(card)
            cards.sort(key=lambda c: c["built"], reverse=True)
            _atomic_write_json(self.root / "index.json", cards)

    # -- the draft's last build --------------------------------------------
    def draft_job(self, pid: str) -> str | None:
        """The job of the last build pushed AS A DRAFT, or None.

        "As a draft" and not "into the slot", and the difference is the one this
        repository has already tripped over once: a commit fills the slot with
        itself too (issue #78), so "the last build in the slot" is a description
        a commit build answers — and a commit build deliberately moves no
        pointer here (`test_a_commit_build_moves_no_pointer`). What is published
        as a commit has a revision to be addressed by and a card of its own; only
        the local slot has a state nothing else can report.

        None for a project nobody has ever pushed a draft to, and None for
        anything unreadable — a torn file, a payload of the wrong shape, a
        volume that refuses the read. The caller turns every one of those into
        the same answer it gives for a job the registry no longer has, so there
        is nothing here for a second kind of failure to mean.

        A JOB ID AND NOT A STATUS WORD, which is the whole reason this file is
        worth having rather than a `state` written twice. The job is the thing
        that knows how it ended, and it keeps knowing across a restart: a job
        left `building` by a SIGKILL is failed by `JobStore._load` at the next
        start, so the card reads `failed` instead of sticking on `building` for
        the life of the volume. A word copied in here would have to be corrected
        by somebody, and there is nobody: the process that would have written it
        is the one that died.

        Read off the volume on every call rather than cached, like
        `project_title` — a cache would have to be invalidated from the BUILD
        thread, which is the sort of coupling `data/` is deliberately free of.
        The cost is stated rather than waved at, because this is the line
        somebody will read while pricing the front page: it is one small open
        per card, and it is the only thing `/index.json` reads besides
        `index.json` itself, which until this pointer existed was the one file
        that route touched.
        """
        try:
            payload = json.loads(read_regular_text(
                self.projects_dir / pid / PROJECT_DRAFT_JOB_FILE))
        except (ValueError, OSError, RecursionError):
            return None
        if not isinstance(payload, dict):
            return None
        job = payload.get("job")
        return job if isinstance(job, str) and job else None

    def set_draft_job(self, pid: str, job_id: str) -> None:
        """Point this project's draft at the job that has just started building it.

        `mkdir` rather than a check that the project exists, which is where this
        differs from `set_title`: the pointer is written at the START of a build,
        and the first build of a brand new project starts before anything has
        been published under its id, so there is no directory yet.
        """
        pdir = self.projects_dir / pid
        with self._lock_for(pid):
            pdir.mkdir(parents=True, exist_ok=True)
            _atomic_write_json(pdir / PROJECT_DRAFT_JOB_FILE, {"job": job_id})

    def clear_draft_job(self, pid: str) -> None:
        """Forget the draft, because a commit has just replaced what was in the slot.

        The exact shape of `clear_title` above and for the same kind of reason:
        a commit mirrors itself into the slot (issue #78), so after it there is
        no draft to have a state — and a pointer left behind would go on
        reporting the last draft build's ending on a card whose local work is
        gone. `publish_built` is the only caller, one line after `clear_title`.

        Best effort, and called from inside the publish path: a volume that will
        not take the unlink must not turn a published build into a failed one.
        """
        try:
            (self.projects_dir / pid / PROJECT_DRAFT_JOB_FILE).unlink()
        except FileNotFoundError:
            return
        except OSError as error:
            logger.warning(f"could not clear the draft pointer of {pid}: {error}")

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
            payload = json.loads(read_regular_text(
                self.projects_dir / pid / PROJECT_TITLE_FILE))
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
        big rare hammer rather than a tidying tool (issue #26).

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

        THE COMPARISONS GO WITH IT, and they are the one tree here that is
        removed rather than reasoned about: an entry under `compare/<pid>/` is
        derived from two of this project's revisions and is addressed by that
        project's id, so leaving it behind would go on serving the geometry of
        a project that no longer exists — under a URL a re-pushed project of the
        same id would inherit. It is a cache, so losing it costs a recomputation
        and nothing else; `ignore_errors` because a project with no comparisons
        has no such directory at all.

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
            shutil.rmtree(self.compare_root / pid, ignore_errors=True)

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

        The `dev` slot is included, and since issue #78 the ORDINARY case is
        that its digest is a published revision's: a commit fills the slot with
        itself, and that revision's own directory carries the same digest, so
        including the slot changes no answer. The other case is a slot filled by
        a `build` push, whose sources are never stored — that digest matches
        nothing in `sources/`. Leaving the slot out would answer the same and be
        a special case to explain.
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

    WHAT IT ASKS OF EACH FIELD IS WHAT THE SUBSCRIPT DOWNSTREAM NEEDS, and
    issue #75 moved two of them without moving the question. `views` replaced
    `variants` and `index_card` sums `v["gzip"]` over it, so that is asked of
    every entry. `parts` used to be an int on each view — the biggest of which
    was the card's part count — and is now the CATALOGUE, out of which the card
    counts the printables; so the type asked about has to move from the view to
    the record, and the field checked has to be the one actually read.
    `isinstance(v.get("parts"), list)` would be the shape of the old line with
    none of its content: nothing subscripts a view's key list here, while a
    record whose `kind` is missing is exactly what makes that count raise.
    """
    if not isinstance(meta, dict):
        return False
    for key in ("pid", "project", "title", "commit", "built", "published"):
        if not isinstance(meta.get(key), str):
            return False
    if meta["commit"] != dir_name:
        return False
    views = meta.get("views")
    if not isinstance(views, list) or not views:
        return False
    if not all(isinstance(v, dict) and isinstance(v.get("gzip"), int)
               for v in views):
        return False
    # Non-empty for the reason `render._catalogue` refuses an empty one on the
    # way in: the two are one decision, and a build this side accepted and that
    # side would not is a build published into a URL and left off every list.
    parts = meta.get("parts")
    if not isinstance(parts, dict) or not parts:
        return False
    return all(isinstance(record, dict) and isinstance(record.get("kind"), str)
               for record in parts.values())


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

    The same shape `_unpack` produces — `{path: sha256}` — but not the same
    journey, and this said "because it feeds the same consumer" until
    2026-08-31, which is no longer so: `_unpack`'s mapping is of an upload's
    members and goes to `_payload_digest` alone. THIS one is what
    `render.build_meta` reads, and it is the only mapping that reaches it:
    build_meta decides whether a view or a download names a file that is really
    there by asking whether it is a KEY of this mapping.

    The names come from `BuildOutcome.files`, which the build process claimed and
    the PARENT then checked one by one — inside `directory`, in normal form, no
    symlink in any component, a regular file that exists (`runner._verified_files`).
    That check is why this can open them directly. Taking the list rather than
    walking the tree is also what keeps the mapping to what the build SHIPS: an
    output directory may hold files a build wrote and never declared, and a view
    file that was never declared has no business validating.

    WHAT THIS DOES NOT DO IS PRUNE, and issue #53 did not change it: publication
    is a whole-directory move — `os.rename(staging, final)` on the commit route,
    the two renames of `_swap_dev_slot` on the `dev` one — and nothing anywhere
    deletes a file that is not a key of this mapping. So a model can write an
    arbitrary file into its output, never declare it, and have it land at a
    permanent public URL without `render._check_declared_file` ever seeing the
    name. #53 closed the other half — the maps are all declared now, and a
    declared name has to be one the file server will answer — so read that as
    "nothing DECLARED can be unservable", never as "nothing undeclared can be
    served".

    WHAT HOLDS THE UNDECLARED HALF IS THE FILE SERVER, and it answers in more
    than one place. Read the list below as what is really there rather than as
    a claim of completeness: an undeclared file it lets through is served, and
    that is the accepted position rather than an oversight.

      * the NAME. `app._safe_name` asks `buildnames.unservable_reason` of every
        name requested under `/project/<pid>/<commit>/`, so a name that starts
        with a dot or carries a character of the C category is not served at
        all. That, and not the content type, is what covers a
        `.payload.sha256`-shaped name;
      * WHERE IT LANDS. `app._send_file` resolves the path and refuses anything
        outside `store.root` — on the RESOLVED path, because `latest` is a
        symlink and following it is the point;
      * WHAT IT IS, in TWO places rather than one, and reading them as one is
        what hid a descriptor leak for a round. A DIRECTORY is refused by the
        `open()` in `app._send_file` itself — `FileIO` fstats what it was handed
        and raises `IsADirectoryError` — so it never reaches the check below. A
        FIFO or a device passes the open and is refused by `stat.S_ISREG` on the
        handle. A model writes its own output directory and nothing on the build
        path stops it calling `makedirs` or `mkfifo` there, so both are
        reachable in practice — and the fifo is REACHED only because the open is
        `O_RDONLY | O_NONBLOCK`: a plain `open()` on a fifo blocks until a writer
        appears, which is the serving thread gone for good before anything gets
        to refuse it. THE PERIMETER OF THIS LIST IS `/project/<pid>/<commit>/`,
        and what is outside it is no longer a second question: every other read
        of this volume goes through `src/safeio.py`, which opens the same way
        and refuses the same things, and `tests/test_volume_reads.py` is what
        keeps a new one from being written any other way (issue #74). Reading
        the list below as "so a fifo is handled" was never safe while that was
        an inventory somebody maintained — it went stale twice inside one issue
        — and it is safe now only because the rule is checked rather than
        recited;
      * the TYPE. `app.build_content_type` serves the whitelist
        (`BUILD_CONTENT_TYPES`) as itself and hands back everything else as
        `application/octet-stream` with `Content-Disposition: attachment`.
    """
    files: dict[str, str] = {}
    for name in names:
        digest = hashlib.sha256()
        with open_regular(directory / name) as handle:
            while True:
                chunk = handle.read(CHUNK)
                if not chunk:
                    break
                digest.update(chunk)
        files[name] = digest.hexdigest()
    return files


def _read_digest(build_dir: Path) -> str | None:
    """The payload digest of one build directory, or None if there is not one.

    `_digests_of` sweeps EVERY project's directories to decide what a removal
    may delete, so one poisoned name here does not cost the caller's own
    project: it costs the removal of any project at all.
    """
    try:
        return read_regular_text(build_dir / PAYLOAD_DIGEST_FILE).strip()
    except OSError:
        return None


def _atomic_write_json(path: Path, payload, *, tmp_dir: Path = None) -> None:
    """Write JSON so a reader sees the old file or the new one, never a torn one.

    `tmp_dir` is passed straight through, and it exists for ONE caller:
    `_restate_message`, whose target sits inside `<pid>/<commit>/`. Every other
    write here lands in `self.root` or in `<pid>/`, which are exactly the two
    levels `_sweep_leftovers` walks — so their temporaries are collectable where
    a build directory's would not be, the sweep never descending into one. Same
    volume either way, so the rename stays a rename.
    """
    atomic_write_bytes(path, json.dumps(payload, indent=1).encode("utf-8"),
                       tmp_dir=tmp_dir)


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
        # is tolerable after a SIGKILL and not tolerable once per failed
        # request, which is the rate the comment queue can produce them at: a
        # caller retrying a rejected write drives this path as fast as it likes.
        # (It is not a PUBLIC endpoint -- both halves of the comment API have
        # taken EDIT_TOKEN since step 0 -- but the rate argument never needed
        # that and is what this line is about.)
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
