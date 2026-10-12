"""On-disk layout and atomic publication.

Nothing here ever deletes a published build: there is no retention window and no
age ceiling (SPEC 5.3, 7.3). Every build URL is served with a year of
`immutable`, so a pasted link resolves for as long as the volume does; the
volume grows monotonically, and running out of space is manual work.

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
    <data>/compare/<pid>/<a>/<b>/<view>/   one computed comparison

`compare/` is outside the build directories (SPEC 8A.3) for rights — a build
directory is public, a comparison is behind EDIT_TOKEN — and for caching: a
build URL carries a year of `immutable`, while a comparison whose end is a
pointer moves with the pointer. It is a cache written like a build (a staging
directory beside the entry, then one rename); recomputing costs about as much
as a build (~1.5 s a pair), and nothing prunes it.

`sources/` is the code of every published revision:

  * Outside the build directory, which is served publicly with a year of
    `immutable`. This tree is served only by `GET /api/v1/sources/<revision>`,
    behind EDIT_TOKEN; the file server's `_safe_name` never reaches it.
  * Content-addressed: `<digest>` is `_payload_digest` of the sources, the same
    string `mint_revision` names the revision after. Pushing the same tree twice
    cannot produce a second archive, and a revision published under a name the
    caller chose (the route that takes a `<commit>`) is stored under its digest,
    not under the name in its URL.
  * Written only after a publish lands; a failed build's sources are not kept.
    A revision's code lives exactly as long as the revision (SPEC 5.3).

`latest` and `dev` are the two names a build directory may not claim, for
different reasons: `latest` is a symlink the store moves, and `dev` is the local
slot itself, a real directory the store rewrites.

The naming rule that carries security weight here is enforced by whitelist
rather than by blacklist, because a whitelist cannot be walked around by an
encoding nobody thought of: `<pid>` and `<commit>` come from the URL and may
only be `[A-Za-z0-9_-]`, so they can never contain a separator or a dot
component. `latest` and `dev` are reserved.

The uploaded tar is read in `src/archive.py`, together with the ceilings and the
per-component alphabet for member names. Those names are re-exported below as
`store.<name>`, and `Store._unpack` calls into that module.
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
from src.archive import (ALPHABET_FAULT, CHUNK, CORRUPT_ARCHIVE_ERRORS,
                         LAYOUT_ERRNOS, MAX_COMPONENT_CHARS, MAX_MEMBERS,
                         MAX_PATH_DEPTH, MAX_REFUSED_NAMES_REPORTED,
                         SAFE_COMPONENT, _create_member_file, _is_the_disk,
                         _member_parts, _members_of, _open_member_dir,
                         _refused_names_error, unpack)
from src.errors import PublishError

# Identifiers that arrive in the URL. No dot at all: that keeps a build directory
# from ever colliding with `builds.json`, and keeps it from being a dot-entry the
# file server hides.
# `\A`/`\Z` and not `^`/`$`: in Python `$` also matches just before a trailing
# newline, so `^...$` accepts "proj1\n" — which would create a directory with a
# newline in its name and put a bare LF into the `Location` header of the reply.
SAFE_ID = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")

# A view id, the fourth segment of a comparison cache entry. It is the model
# author's own string, held at build time to `cadbuild.hubspec.MEMBER_RE` (a dot
# and 128 characters allowed), so `SAFE_ID` is the wrong rule for it.
#
# The rule is "a name that may be a directory segment": it must start
# alphanumeric, so `.`, `..`, `.hidden` and the empty string are out, and the
# class holds no `/`, no backslash, no NUL and nothing outside ASCII. Written out
# rather than imported because the serving half does not import the build half;
# `tests/test_compare.py` holds the two patterns equal. Kept separate from
# `SAFE_COMPONENT` in `src/archive.py`, the alphabet of archive member paths (see
# `hammerola/buildnames.py`). `\Z` and not `$` for the reason `SAFE_ID` gives.
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

# The three documents this hub generates, one per level of the layout above: a
# build's `meta.json`, a project's `builds.json` and the root `index.json`. Named
# here because the layout is this module's to know, and the URL of each is its
# file name.
BUILD_META_FILE = "meta.json"
PROJECT_BUILDS_FILE = "builds.json"
SITE_INDEX_FILE = "index.json"

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
# The build log, beside the code. The job keeps its own copy, but that is
# addressed by a per-attempt job id recorded against nothing, so it is not
# reachable from the revision.
SOURCE_LOG_NAME = "log.txt"

# The comparison cache: `compare/<pid>/<a>/<b>/<view>/`, holding exactly the two
# files below. Not dot-prefixed, for the reason `sources/` is not: nothing serves
# this tree by path — `_serve_compare` in app.py composes the entry's path from
# ids it has already checked.
#
# The ids are nested directories rather than one joined name because no
# separator is safe: `SAFE_ID` accepts `_`, so `x` + `y__z` and `x__y` + `z`
# would join to the same name. A directory boundary cannot appear inside a
# segment `SAFE_ID` or `SAFE_VIEW_ID` passed.
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
# that build starts, so the front page can say a draft is building or has
# failed: the slot's own meta.json carries a `job` only after a build succeeds.
#
# Beside `title.json` and not inside the slot: `_swap_dev_slot` replaces the slot
# wholesale, and the slot's `job` means "the job that filled this slot", which a
# failed attempt must not overwrite.
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
# cannot replace a non-empty directory under a fixed name in one step — see
# `_swap_dev_slot`. Nothing else parks a directory: published builds are never
# deleted.
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

# A leftover younger than this may belong to a publish running right now, in
# this process or another one sharing the volume. `.src-` and `.body-` live from
# the request until the build ends, so this has to exceed the worst honest queue
# wait: jobs.MAX_QUEUED_JOBS × buildproc's `wall_seconds` / the number of
# workers. `tests/test_build_ceilings.py` computes that from the live constants
# and asserts this clears it. The margin is generous on purpose: a leftover only
# wastes space, while sweeping a queued build's sources fails that build.
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

        Only the two reserved names are out; `dev-1234` is an ordinary commit id.
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
        because the pusher does not choose the name.

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

    # -- addresses on the volume -------------------------------------------
    # The one place that knows the layout: callers ask these for addresses
    # rather than assembling paths themselves, so the layout can move. None of
    # the five below touches the disk; `resolve_inside` does, on the terms its
    # docstring states.
    def project_dir(self, pid: str) -> Path:
        """Everything this hub holds about one project."""
        return self.projects_dir / pid

    def build_dir(self, pid: str, name: str) -> Path:
        """One build of it, by commit id or by either pointer name."""
        return self.project_dir(pid) / name

    def build_meta_path(self, pid: str, name: str) -> Path:
        """The document that decides whether that build can be served."""
        return self.build_dir(pid, name) / BUILD_META_FILE

    def builds_json_path(self, pid: str) -> Path:
        """The project's build picker."""
        return self.project_dir(pid) / PROJECT_BUILDS_FILE

    def site_index_path(self) -> Path:
        """The front page's cards. Absent until the first push."""
        return self.root / SITE_INDEX_FILE

    def resolve_inside(self, path: Path) -> Path:
        """The path with its symlinks followed, refused unless it lands in here.

        WHERE THE VOLUME ENDS IS THIS MODULE'S QUESTION, so the file server asks
        it rather than measuring against a root of its own. OSError when the path
        cannot be resolved and ValueError when it resolves outside DATA_DIR —
        which is the pair every caller already answers with one 404.
        """
        resolved = path.resolve(strict=True)
        resolved.relative_to(self.root)
        return resolved

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

        Runs in the request, because everything it can refuse is a property of
        the upload itself — the ids, the size, the archive — and has to be a 4xx
        on the push, not a job to poll. It does not touch the project's
        directory: a push that never builds leaves no trace of the project.

        Takes a path, not bytes: the body is already on disk, and reading it back
        into memory would undo the peak this avoids.

        The digest is of the sources, and it tells an identical retry from a
        colliding one. The built output stamps the wall clock (`built` in
        `meta.json` and `metrics.json`), so hashing it would make every rebuild
        of the same commit a 409.

        `commit` is None when the URL carried no name for this push; the digest
        computed here then becomes the name (`mint_revision`).
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

        `message` is the one thing a repeat push can still change.
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
            # The slot has no 409: every push overwrites it (SPEC 7.6). The
            # comparison only spares an unchanged rebuild the build itself.
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
        # Reachable on a minted name too, without a sha256 collision: a
        # directory at that name whose `.payload.sha256` is missing or
        # unreadable (`data/` is writable by every build, SPEC 8A.4) leaves
        # nothing to compare, and answering 200 would claim a publication that
        # may never have finished.
        raise PublishError(
            409, f"build {commit} already exists with different content")

    def _restate_message(self, pid: str, commit: str, final: Path,
                         message: str) -> None:
        """Put a new message on a revision that is already published.

        Only when there is one and it differs: a push without `-m` is the
        ordinary re-push and leaves the stored message alone; there is no way to
        clear a message.

        Under the project lock, unlike the comparison that leads here, because
        this writes the file `_write_builds_json` reads back through `builds_of`.

        Readers always see the new text: every surface that shows a message reads
        `builds.json` (`render._picker_entry`), which is served `no-cache` and
        rewritten here. The copy inside the revision's meta.json is served
        `immutable`, but nothing renders it; it is read only here and by
        `builds_of`, off the disk.

        Best effort: the revision is published and the answer is 200 either way,
        so a volume that will not take this write costs the message, never the
        push.
        """
        if not message:
            return
        try:
            with self._lock_for(pid):
                path = final / BUILD_META_FILE
                meta = json.loads(path.read_text(encoding="utf-8"))
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

        `job` reaches only the copy this makes into the slot; the revision's own
        document does not carry one (`render.build_meta`). `message` goes into
        the revision's document, and the mirror copies it into the slot with
        the rest.
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

            # Past the point of no return: the rename above is the publication
            # (SPEC 7.2). Everything from here on is bookkeeping derived from
            # what is on disk — `latest`, the picker, the index — and the next
            # publish of this project recomputes all of it, so a failure here is
            # logged rather than reported (reporting it would mark a live
            # build's job `failed`). Nothing else repairs it: startup recomputes
            # none of this, so an abandoned project keeps whatever this leaves.
            #
            # Order: fill the slot with this revision, move `latest`, then write
            # the picker from what is on disk. The mirror has to come before
            # `_write_builds_json` and `_refresh_index`, which describe the slot
            # (`has_dev`, the front-page card). `latest` moving before the picker
            # means a reader following it is on the new build before the picker
            # offers it.
            try:
                self._mirror_into_dev_slot(pid, pdir, final, meta, digest, job)
                # A rename is superseded by the push that follows it: the build
                # carries the project's own title, and that is the newer
                # statement of what the project is called. Before the picker is
                # written, so the file is rebuilt from the state that survives.
                self.clear_title(pid)
                # The draft status goes too: the mirror has just put this
                # revision into the slot, so a draft status left behind would
                # outlive the draft it is about. A draft build in flight loses
                # its `building` chip to this commit, which is the lesser error.
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

        `job` goes into the slot's meta.json: the slot is the one build no
        revision addresses, so the job that filled it is the only place its log
        exists.
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

    # -- the comparison cache ----------------------------------------------
    def compare_dir(self, pid: str, old: str, new: str, view: str) -> Path:
        """Where one computed comparison lives. Raises ValueError on a bad id.

        `compare/<pid>/<a>/<b>/<view>/`: the first three segments are held to
        `SAFE_ID` and the view to `SAFE_VIEW_ID`, which keeps `..`, `/` and a
        leading dot out of the path assembled here. Raised rather than returned
        as a bool: the route turns it into an answer, and the worker never gets
        that far. Four directories rather than one joined name — see
        COMPARE_DIR_NAME.

        Neither end is ever a pointer, which keeps every entry immutable: an
        entry under `latest` would go on answering for a pair that has moved on.
        `_serve_compare` and `_handle_compare` in app.py refuse `latest` and
        `dev`, and the client resolves `latest` to a commit before it asks;
        `dev` has no commit id, so the slot is not comparable.
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
        last call to `build`; without this a commit would leave the slot showing
        geometry older than `latest`.

        A copy of the published tree, since the publishing rename emptied the
        staging directory. Nothing is validated again: at publication a
        revision's meta.json and the slot's differ in exactly `commit`, `dev` and
        `job` (`render.build_meta`). A later repeat push can rewrite `message` on
        the revision alone (`_restate_message`); the slot's copy then goes stale,
        which is harmless because nothing reads the slot's `message`.

        The swap is unconditional, even when the slot already holds these
        sources: the slot has to carry this revision's meta.json, not the
        `built` and `published` stamps of an earlier `build`.

        Never raises: it runs past the point of no return, and the slot has no
        history to lose.
        """
        tmp = pdir / f"{STAGING_PREFIX}{DEV_LINK}-{uuid.uuid4().hex}"
        try:
            shutil.copytree(final, tmp)
            (tmp / BUILD_META_FILE).write_text(
                json.dumps(dict(meta, commit=DEV_LINK, dev=True, job=job),
                           indent=1),
                encoding="utf-8")
            # Already copied by `copytree`, written explicitly anyway: the
            # slot's digest makes a later `build` of these sources answer 200
            # and tells the front page the slot holds nothing the commit does
            # not (`_uncommitted_in_slot`).
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

        `staging` is what the build wrote (SPEC 8A.2 step 5), so the meta.json
        read here is the build's own.

        `job` is handed on to `build_meta`, which records it in the slot's
        document only. `message` came off a push header rather than out of the
        tree, and is already validated (`render.revision_message`).
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
        (staging / BUILD_META_FILE).write_text(
            json.dumps(meta, indent=1), encoding="utf-8")
        (staging / PAYLOAD_DIGEST_FILE).write_text(digest, encoding="utf-8")
        return meta

    @staticmethod
    def _read_meta(staging: Path) -> dict:
        """The build's own meta.json, off the staging directory it wrote.

        `is_file()` is what tells "the build produced no meta.json" — a 422
        naming the actual mistake — apart from every other way a read can fail.
        """
        path = staging / BUILD_META_FILE
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
    def empty(self) -> bool:
        """Has anything ever been published here? The one fact given anonymously.

        Read by `/start` (src/onboarding.py), the only route that answers a
        question about the deployment without a token — so this returns a
        boolean and nothing that could turn into a count, a name or a date. The
        sign-in page draws its onboarding block when it is true
        (`ui/src/HammerolaEntry.jsx`).

        The question is "is there a project", not "is there a card": a project
        whose only build is in the `dev` slot has no entry in `index.json`
        (SPEC 7.6), but the hub is not empty.

        A project directory holding nothing but residue does not count:
        `build_staging` creates `project/<pid>/` before the build runs and
        nothing removes it when the build fails, and `set_draft_job` writes
        `draft.json` before there is anything else under the id. Counting either
        would leave a new hub non-empty for ever after a failed first push. A
        directory with a build in flight counts, because its staging tree is
        inside it; so does a `dev`-only project.

        Fails closed: an unreadable `project/` answers "not empty".
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

        So a meta.json here cannot be assumed to be one this hub wrote:
        `_switch_latest`, `render.builds_json` and `render.index_card`
        subscript these dicts directly, so a meta that cannot answer them
        (`_usable_meta`) is skipped like an unreadable one, and the project
        keeps working.
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
            meta_path = entry / BUILD_META_FILE
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
        _atomic_write_json(self.builds_json_path(pid), picker)

    def _dev_meta(self, pid: str) -> dict | None:
        """The local slot's meta.json, or None if the slot is empty.

        Read rather than assumed: with no commit build in the project it is the
        only source of the project's name and title, and `builds.json` needs
        those to render a header.
        """
        try:
            meta = json.loads(self.build_meta_path(pid, DEV_LINK).read_text(
                encoding="utf-8"))
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

        The question behind the `dev` chip on the front page, deliberately not
        the `has_dev` that `_write_builds_json` writes: that asks whether the
        slot exists, and since a commit fills the slot with itself it is true of
        every committed project.

        Answered by digest: the mirror writes the revision's own source digest
        into the slot, so a slot whose digest equals the newest commit's holds
        nothing that commit does not, while a `build` push of edited sources
        lands a different one. Comparing the trees would be weaker: two builds
        of the same sources differ in their timestamps.

        Errs towards True on a digest that will not read: a needless chip is
        better than the front page silently not mentioning local work.
        """
        if self._dev_meta(pid) is None:
            return False
        commit = self.latest_commit(pid)
        if commit is None:
            # `latest` does not read: the symlink is gone, or a previous
            # publish did not get as far as setting it. Nothing to compare the
            # slot against, so the chip stays (see the docstring). The only
            # caller reaches this with the project's commit builds in hand.
            return True
        pdir = self.projects_dir / pid
        in_slot = _read_digest(pdir / DEV_LINK)
        published = _read_digest(pdir / commit)
        return not (in_slot is not None and in_slot == published)

    def _refresh_index(self) -> None:
        """Rebuild the root index.json from every project's newest COMMIT build.

        The local slot is left out for the same reason it does not move
        `latest` (SPEC 7.6): the front page must not describe uncommitted work.
        `builds_of` already excludes it, so a project whose only build is local
        has no card yet.

        Two of the card's fields belong to the project rather than the build, so
        they are read here and handed over: whether the slot holds sources no
        commit has published (`_uncommitted_in_slot`, not the same question as
        `has_dev` in `builds.json`), and the oldest build still on disk.
        `render.index_card` says what each is for.
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
            _atomic_write_json(self.site_index_path(), cards)

    # -- the draft's last build --------------------------------------------
    def draft_job(self, pid: str) -> str | None:
        """The job of the last build pushed as a draft, or None.

        "As a draft", not "into the slot": a commit fills the slot with itself
        too, and a commit build moves no draft pointer
        (`test_a_commit_build_moves_no_pointer`). Only the local slot has a
        state nothing else reports.

        None for a project nobody has pushed a draft to, and for anything
        unreadable — a torn file, a payload of the wrong shape, a refused read.
        The caller treats all of those like a job the registry no longer has.

        A job id rather than a status word: the job knows how it ended across a
        restart (`JobStore._load` fails a job left `building` by a SIGKILL),
        while a copied word would have nobody to correct it.

        Read off the volume on every call rather than cached, like
        `project_title`: a cache would have to be invalidated from the build
        thread. The cost is one small open per card on `/index.json`.
        """
        try:
            payload = json.loads(
                (self.projects_dir / pid / PROJECT_DRAFT_JOB_FILE
                 ).read_text(encoding="utf-8"))
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

        Same shape as `clear_title`: a commit mirrors itself into the slot, so
        afterwards there is no draft to have a state, and a pointer left behind
        would keep reporting the last draft build's ending on a card whose local
        work is gone. `publish_built` is the only caller, one line after
        `clear_title`.

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
        big rare hammer rather than a tidying tool.

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

        The `dev` slot is included. Usually its digest is a published
        revision's (a commit fills the slot with itself), so including it
        changes no answer; a slot filled by a `build` push has a digest nothing
        in `sources/` matches.
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

    Each field is asked what the subscript downstream needs: every view a
    `gzip` int (`index_card` sums them), and every catalogue record a `kind`
    string (the card counts printables).
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

    The same shape `_unpack` produces, but a different consumer: `_unpack`'s
    mapping goes to `_payload_digest` alone, while this one is the only mapping
    `render.build_meta` reads — a pointer is valid when its name is a key here.

    The names come from `BuildOutcome.files`, which the build process claimed and
    the PARENT then checked one by one — inside `directory`, in normal form, no
    symlink in any component, a regular file that exists (`runner._verified_files`).
    That check is why this can open them directly. Taking the list rather than
    walking the tree keeps the mapping to what the build ships: a file a build
    wrote and never declared has no business validating.

    This does not prune: publication moves the whole directory, so a file the
    model wrote and never declared lands at a public URL without
    `render._check_declared_file` seeing it. "Nothing declared can be
    unservable" holds; "nothing undeclared can be served" does not. The file
    server holds the undeclared half, and what it lets through is served by
    design:

      * the NAME. `app._safe_name` asks `buildnames.unservable_reason` of every
        name requested under `/project/<pid>/<commit>/`, so a name that starts
        with a dot or carries a character of the C category is not served at
        all. That, and not the content type, is what covers a
        `.payload.sha256`-shaped name;
      * WHERE IT LANDS. `app._send_file` resolves the path and refuses anything
        outside `store.root` — on the RESOLVED path, because `latest` is a
        symlink and following it is the point;
      * WHAT IT IS. A DIRECTORY is refused by the `open()` in `app._send_file`
        itself — `FileIO` fstats what it was handed and raises
        `IsADirectoryError`. A model writes its own output directory and
        nothing on the build path stops it calling `makedirs` there, so this is
        reachable in practice;
      * the TYPE. `app.build_content_type` serves the whitelist
        (`BUILD_CONTENT_TYPES`) as itself and hands back everything else as
        `application/octet-stream` with `Content-Disposition: attachment`.
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
    """The payload digest of one build directory, or None if there is not one.

    `_digests_of` sweeps EVERY project's directories to decide what a removal
    may delete, so one unreadable digest here does not cost the caller's own
    project: it costs the removal of any project at all.
    """
    try:
        return (build_dir / PAYLOAD_DIGEST_FILE).read_text(
            encoding="utf-8").strip()
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
    becomes EXDEV, and this function raises rather than silently copying.
    `src/jobs.py` passes the data root, so the temporaries of a job's record
    and log land where `_sweep_leftovers` collects a leftover of a killed write:
    that sweep walks `self.root` and the project directories, and neither
    `data/jobs/` nor a job directory is one of them.

    It is not a defence against a build making one write fail:
    `rename(tmp, dir/name)` needs write permission on the destination directory
    just as `open(dir/tmp)` does, so `chmod 0500` on a job directory refuses both
    (measured: PermissionError either way). What makes a pointwise failure
    survivable is that nothing shared between records is written per record
    (see the note on `order.json` in `src/jobs.py`).
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
        # The temp name is dot-prefixed, so a leftover would sit on the volume
        # until the next startup sweep. Tolerable after a SIGKILL, not once per
        # failed request: a caller retrying a rejected comment write can drive
        # this path as fast as it likes.
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
