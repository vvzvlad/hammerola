"""On-disk layout and atomic publication.

Nothing here ever deletes a published build: there is no retention window and no
age ceiling (SPEC 5.3, 7.3). Every build URL is served with a year of
`immutable`, so a pasted link resolves for as long as the volume does; the
volume grows monotonically, and running out of space is manual work.

It grows by what changed rather than by what was pushed: after every publish
`_dedupe` makes each file of a project's builds with the same sha256 a hard link
to one copy, so a part that did not change between revisions is one file on
disk. That is safe only because nothing writes into a published file in
place, and the files the hub writes into a build itself (meta.json and the dot
files) are never linked.

Layout under DATA_DIR (SPEC 3, 7.2). Everything here is runtime state and lives on
the docker volume; templates and viewer assets deliberately live outside it,
because the volume would shadow them.

    <data>/index.json                      cards for the front page
    <data>/project/<pid>/builds.json       build picker of the default variant
    <data>/project/<pid>/latest            SYMLINK -> <commit>, the nearest built
                                           commit on the first-parent line of `main`
    <data>/project/<pid>/dev/              the default variant's local slot — one
                                           directory, rewritten by every draft
                                           (SPEC 7.6)
    <data>/project/<pid>/variants.json     the variants: every branch, with its label
    <data>/project/<pid>/.variants/<b>/    any other variant `b` (a branch, or a
                                           draft `refs/drafts/<b>`): its `latest`
                                           (-> ../../<commit>), `dev/` and
                                           `builds.json`
    <data>/project/<pid>/<commit>/         one immutable build, whichever branch
                                           it was published from
    <data>/project/<pid>/<commit>/.build.log   what that build printed
    <data>/project/<pid>/.tmp-<commit>-<uuid>/   staging, never served
    <data>/jobs/<id>/                      one build job (src/jobs.py)
    <data>/.src-<uuid>/                    one SOURCE tree checked out of a pushed
                                           commit, being built
    <data>/sources/<digest>/source.tar.gz  the archive an older hub kept for a
                                           revision published before git: read
                                           by the import, until the pass at
                                           start deletes it
    <data>/sources/<digest>/log.txt        what the build of that revision printed
    <data>/compare/<pid>/<a>/<b>/<view>/   one computed comparison
    <data>/repos/<pid>.git/                the project's bare git repository,
                                           served by src/githttp.py

A revision is published by `git push` (src/prereceive.py): the pre-receive hook
hands the pushed commit to the hub, which builds it in the ordinary queue and
publishes it under the commit's sha before git writes the ref. The repository
is the canon of history; `latest`, `builds.json`, `variants.json` and
`index.json` are derived from it and from the build directories, at the end of
every push and at start (`recompute`, `catch_up`).

A variant is a branch, named as the author's local branch is (SPEC §4). The
default one, `main`, keeps the old places; every other lives in
`.variants/<b>/`. The dot keeps it out of every walk that takes a directory of
the project for a build (`builds_of`, `_dedupe`, `_import_builds`); `_dedupe`
and the sweep are told about it on purpose.

Builds published before git are taken into the repository by the import
(`ensure_repo`): one commit per build, oldest first, out of its archive in
`sources/`, each carrying the trailer `Hammerola-Import: <pid>/<build>` and
checked against the build's `.payload.sha256`; the log kept beside the archive
becomes the build's `.build.log`. Every start imports what needs it before the
pass over `sources/` (`catch_up`).

`compare/` is outside the build directories (SPEC 8A.3) for rights — a build
directory opens its JSON and pictures to anybody with its address and the rest
to the token or a key, a comparison is behind EDIT_TOKEN — and for caching: a
build URL carries a year of `immutable`, while a comparison whose end is a
pointer moves with the pointer. It is a cache written like a build (a staging
directory beside the entry, then one rename); recomputing costs about as much
as a build (~1.5 s a pair), and nothing prunes it.

`sources/` is addressed by `_payload_digest` of an archive's members, the
`.payload.sha256` of the builds published from it. Nothing writes it, and
nothing serves it: the file server's `_safe_build_path` looks only inside a
build directory. At start `drop_sources` deletes each archive whose builds'
import commits give its digest back, and keeps every other one.

An archive is read in `src/archive.py`, together with the ceilings and the
per-component alphabet for member names; the import calls into that module.

`latest`, `dev` and `v` are the names a build directory may not claim, for
different reasons: `latest` is a symlink the store moves, `dev` is the local
slot itself, a real directory the store rewrites, and `v` begins the address of
a variant (`/project/<pid>/v/<b>/latest/`).

The naming rule that carries security weight here is enforced by whitelist
rather than by blacklist, because a whitelist cannot be walked around by an
encoding nobody thought of: `<pid>` and `<commit>` come from the URL and may
only be `[A-Za-z0-9_-]`, so they can never contain a separator or a dot
component. `latest` and `dev` are reserved.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger

# The name of the file a build writes and the next build of the same project is
# handed back as its baseline (`dev_metrics_path` is what names it here). Taken
# from the module both readers already share rather than spelled again — a
# second copy of the string is exactly the drift that module exists to prevent.
from hammerola.metricsdiff import METRICS_NAME
from src import render
from src.archive import unpack
from src.errors import PublishError

# The read buffer of `_commit_digest` and `_hash_output`.
CHUNK = 64 * 1024

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
# `SAFE_COMPONENT` in `hammerola/limits.py`, the alphabet of the member paths of
# an archive the client reads (see `hammerola/buildnames.py`). `\Z` and not `$`
# for the reason `SAFE_ID` gives.
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

# The segment that begins a variant's address, `/project/<pid>/v/<b>/latest/`.
VARIANT_SEGMENT = "v"

# Names a build may not claim, because the hub already answers to them: `latest`
# is a pointer symlink, `dev` is the local slot's directory, and `v` begins a
# variant's address. A revision is named by its commit, and the builds published
# before git carry none of the three.
# `resolve` is deliberately NOT here: it is reserved by the COMMENT api only
# (SPEC 7A.2), where it costs a build the ability to be commented on and nothing
# else, and app.py documents that trade.
RESERVED_BUILD_NAMES = {*POINTER_NAMES, VARIANT_SEGMENT}

# Where a variant other than the default keeps its `latest`, `dev/` and
# `builds.json` (`variant_dir`). Dot-prefixed: see the module docstring.
VARIANTS_DIR = ".variants"
# The list of variants, `{"default", "variants": [{"name", "label"}, ...]}`,
# beside the default variant's `builds.json`. Public (`app._serve_project`).
VARIANTS_FILE = "variants.json"

# The three documents this hub generates, one per level of the layout above: a
# build's `meta.json`, a project's `builds.json` and the root `index.json`. Named
# here because the layout is this module's to know, and the URL of each is its
# file name.
BUILD_META_FILE = "meta.json"
PROJECT_BUILDS_FILE = "builds.json"
SITE_INDEX_FILE = "index.json"

# Where the payload digest of a build is remembered, so a retry of the same commit
# can be told apart from a different build claiming the same commit (SPEC 7). For
# a build of a pushed commit it is the git id of the project's directory in that
# commit; for a build published before git, `_payload_digest` of its archive.
# Dot-prefixed: the file server refuses to serve dot entries.
PAYLOAD_DIGEST_FILE = ".payload.sha256"

# `{relative path: sha256}` of the files a build ships, written beside it at
# publication so `_dedupe` finds identical files without reading them again.
# Dot-prefixed for the reason the digest file above is.
FILE_DIGESTS_FILE = ".files.sha256"

# What the build of a revision printed, in the revision's own directory: one
# commit can be a revision of several projects, so a log kept by commit would be
# overwritten. Written into staging before the rename; dot-prefixed, so the file
# server does not serve it and `GET /api/v1/logs/<pid>/<rev>` is its only way out.
BUILD_LOG_FILE = ".build.log"

# The archives an older hub kept, one directory per revision, named by the
# digest of the archive's members, with the log of its build beside the archive.
# Only the import reads them, and `drop_sources` deletes them.
SOURCES_DIR_NAME = "sources"
SOURCE_ARCHIVE_NAME = "source.tar.gz"
SOURCE_LOG_NAME = "log.txt"

# The comparison cache: `compare/<pid>/<a>/<b>/<view>/`, holding exactly the two
# files below. Not dot-prefixed: nothing serves this tree by path —
# `_serve_compare` in app.py composes the entry's path from ids it has already
# checked.
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

# Each project's git repository: `repos/<pid>.git`, bare, created by `ensure_repo`
# for the first git request to the project, or by the import.
REPOS_DIR_NAME = "repos"
REPO_SUFFIX = ".git"

# The default branch, the default variant. `HEAD` of every repository is
# `git init --initial-branch=main` and never moves.
MAIN_BRANCH = "main"
BRANCH_PREFIX = "refs/heads/"
MAIN_REF = f"{BRANCH_PREFIX}{MAIN_BRANCH}"

# The trailer of an imported commit: `Hammerola-Import: <pid>/<build>`. A key of
# the hub's own, so a trailer an author writes means nothing here; the pid is in
# the value because one history can carry the imports of several projects.
IMPORT_TRAILER = "Hammerola-Import"
# Who imported commits are by, set explicitly: a guessed identity can be refused
# by git, and a fixed one keeps the import's shas the same every time it runs.
IMPORT_NAME = "hammerola import"
IMPORT_EMAIL = "import@hammerola"

# A build named by a commit: the full sha.
COMMIT_NAME = re.compile(r"\A[0-9a-f]{40}\Z")

# The only variables a git process the hub starts inherits from the hub: enough
# to find programs and a home directory. EDIT_TOKEN in particular never reaches
# git or a hook.
GIT_INHERITED_VARIABLES = ("PATH", "HOME")

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
# A directory renamed out of the way while a new one takes its name: the `dev`
# slot, a comparison cache entry, a repository the import replaces. POSIX
# cannot replace a non-empty directory under a fixed name in one step — see
# `_swap_dev_slot`. Published builds are never parked: they are never deleted.
TRASH_PREFIX = ".trash-"
# Any atomic write this module makes, for as long as it is not yet renamed into
# place — a rule rather than a list, because naming three of them invites the
# fourth to be forgotten. All of them land where the sweep below looks; the ones
# that have to ask for it are `_file_digests` and the import's log copies, whose
# targets live in a build directory the sweep does not walk, and `_dedupe`,
# which makes its temporary link in the project directory for the same reason.
# A temporary git index is one too.
JSON_TMP_PREFIX = ".wip-"
# One SOURCE tree, from the moment it is checked out of a pushed commit (or
# unpacked from an archive by the import) until its build ends. At the root and
# not inside the project directory, and that is deliberate: it is not a build,
# it is never renamed anywhere, and a project directory that exists means the
# project has been pushed to. It also survives the request that created it — the
# worker owns it (src/jobs.py) — so it is the one transient here that is expected
# to outlive its creator.
SOURCE_PREFIX = ".src-"
LEFTOVER_PREFIXES = (STAGING_PREFIX, LATEST_LINK_PREFIX, TRASH_PREFIX,
                     JSON_TMP_PREFIX, SOURCE_PREFIX)

# A leftover younger than this may belong to a publish running right now, in
# this process or another one sharing the volume. `.src-` lives from the push
# until the build ends, so this has to exceed the worst honest queue
# wait: jobs.MAX_QUEUED_JOBS × buildproc's `wall_seconds` / the number of
# workers. `tests/test_build_ceilings.py` computes that from the live constants
# and asserts this clears it. The margin is generous on purpose: a leftover only
# wastes space, while sweeping a queued build's sources fails that build.
LEFTOVER_MAX_AGE_SECONDS = 4 * 3600


class ImportFailed(Exception):
    """The import of a project's old builds did not go through; says which and why."""


def git_environment() -> dict:
    """The environment every git process the hub starts begins from."""
    return {name: os.environ[name] for name in GIT_INHERITED_VARIABLES
            if name in os.environ}


def run_git(repo, subcommand: str, *args, work_tree=None, env=None,
            input=None, cwd=None) -> str:
    """One git command against `repo` (None: none). -> its stdout, as it is.

    Raises CalledProcessError with git's stderr on it and `cmd[1]` the
    subcommand, for a message that names it (`git_failure`).
    """
    environment = git_environment()
    if repo is not None:
        environment["GIT_DIR"] = str(repo)
    environment.update(env or {})
    command = ["git"]
    if work_tree is not None:
        command += ["--work-tree", str(work_tree)]
    try:
        return subprocess.run(
            [*command, subcommand, *args], env=environment, input=input,
            cwd=cwd, capture_output=True, text=True, encoding="utf-8",
            errors="replace", check=True).stdout
    except subprocess.CalledProcessError as error:
        error.cmd = ["git", subcommand]
        raise


def git_failure(error: subprocess.CalledProcessError) -> str:
    """`git <subcommand>: <its last line of stderr>`."""
    lines = (error.stderr or "").strip().splitlines()
    return f"git {error.cmd[1]}: {lines[-1] if lines else f'exit {error.returncode}'}"


# The separators of `_trailed_log`'s format: neither can occur in a sha or in
# a trailer's value.
_RECORD = "\x1e"
_FIELD = "\x1f"


def _trailed_log(repo, rev: str, *extra, env=None) -> list:
    """`[(sha, [Hammerola-Import values]), ...]`, as `git log <rev>` lists them.

    Empty when there is no such repository or revision.
    """
    try:
        run_git(repo, "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}",
                env=env)
    except subprocess.CalledProcessError:
        return []
    out = run_git(
        repo, "log", *extra,
        f"--format=%H%x1f%(trailers:key={IMPORT_TRAILER},valueonly,"
        f"separator=%x1f)%x1e", rev, "--", env=env)
    commits = []
    for record in out.split(_RECORD):
        record = record.strip("\n")
        if not record:
            continue
        sha, *values = record.split(_FIELD)
        commits.append((sha, [value.strip() for value in values
                              if value.strip()]))
    return commits


def _commit_digest(repo: Path, commit: str) -> str:
    """`_payload_digest` of a commit's regular files, read off `git archive`.

    The directory entries `git archive` writes are not in it, as the archives a
    build was published from carried none.
    """
    environment = git_environment()
    environment["GIT_DIR"] = str(repo)
    process = subprocess.Popen(["git", "archive", "--format=tar", commit],
                               env=environment, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE)
    files = {}
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as tar:
            for member in tar:
                if not member.isreg():
                    continue
                digest = hashlib.sha256()
                handle = tar.extractfile(member)
                while True:
                    chunk = handle.read(CHUNK)
                    if not chunk:
                        break
                    digest.update(chunk)
                files[member.name] = digest.hexdigest()
        # `tarfile` stops at the end-of-archive blocks, and git may still be
        # writing the padding of its last record: closing the pipe before it
        # is done kills git with SIGPIPE.
        while process.stdout.read(CHUNK):
            pass
    finally:
        process.stdout.close()
        errors = process.stderr.read().decode("utf-8", "replace")
        process.stderr.close()
        code = process.wait()
    if code != 0:
        raise subprocess.CalledProcessError(code, ["git", "archive"],
                                            stderr=errors)
    return _payload_digest(files)


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


def build_path(pid: str, name: str, variant: str = MAIN_BRANCH) -> str:
    """The address of a build: a revision, or a pointer of one variant.

    `/project/<pid>/<name>/` for a revision and for the default variant's
    pointers, `/project/<pid>/v/<variant>/<name>/` for another variant's.
    """
    if name in POINTER_NAMES and variant != MAIN_BRANCH:
        return f"/project/{pid}/{VARIANT_SEGMENT}/{variant}/{name}/"
    return f"/project/{pid}/{name}/"


def _build_url(pid: str, name: str, variant: str = MAIN_BRANCH) -> dict:
    """The body of a successful publish: where the thing just published lives.

    One URL, for both routes. A commit push answers with its permanent
    `/<commit>/`; a local push answers with its variant's `dev/`, which is the
    only address a local build has ever needed — it is the slot, and the author
    keeps it open in a tab (SPEC 7.6).
    """
    return {"url": build_path(pid, name, variant)}


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

    One instance per process. `data_dir` is passed in rather than read from
    the settings singleton so tests can build a Store on a tmp_path without
    touching the process environment.
    """

    def __init__(self, data_dir):
        self.root = Path(data_dir).resolve()
        self.projects_dir = self.root / "project"
        # Read by the import, pruned by `drop_sources`, written by nothing.
        self.sources_dir = self.root / SOURCES_DIR_NAME
        # NOT created here, unlike `projects_dir`: a hub nobody has asked for a
        # comparison on has no `compare/` at all.
        self.compare_root = self.root / COMPARE_DIR_NAME
        # Created by the first `ensure_repo`, for the same reason.
        self.repos_dir = self.root / REPOS_DIR_NAME
        # Publication is serialized per project: builds.json and the `latest`
        # symlink are both derived from the full set of builds, so two concurrent
        # pushes to the SAME project could interleave into a builds.json and a
        # pointer that describe different moments. Different projects never touch
        # each other's state and are free to run in parallel.
        self._locks: dict[str, threading.Lock] = {}
        # A project's repository has a lock of its own (`ensure_repo`), so
        # creating one never waits behind a publish. Where both are held, the
        # repository's is taken first.
        self._repo_locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        # The root index spans every project, so it gets its own global lock.
        self._index_lock = threading.Lock()
        # `{pid: why}` for every project whose import failed in this process.
        # Its git requests are answered 503 with the reason and its `latest` is
        # not recomputed; the next start tries again.
        self._import_failures: dict[str, str] = {}
        self.projects_dir.mkdir(parents=True, exist_ok=True)
        self._sweep_leftovers()

    # -- leftovers ---------------------------------------------------------
    def _sweep_leftovers(self) -> None:
        """Delete transient entries an earlier run died in the middle of.

        Nothing else ever will. Every name here is dot-prefixed, so `builds_of`
        skips it and the file server refuses to serve it — a SIGKILL during a
        push therefore leaves a whole spooled body plus a half-unpacked staging
        tree on the volume, permanently.

        Only entries older than `LEFTOVER_MAX_AGE_SECONDS` — four hours, and the
        block at its definition says what fixes that figure — are touched,
        because a concurrent publish in this very process is using names of
        exactly the same shape. This runs from `Store.__init__` and from nowhere
        else, so it is a sweep at startup rather than a periodic one. The git
        repositories are swept last and with no age at all (`_sweep_repos`).
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
        # A variant's directory, where its slot is swapped and its `latest`
        # moved (`variant_dir`).
        directories += [p for p in self.projects_dir.glob(f"*/{VARIANTS_DIR}/*")
                        if p.is_dir()]
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
        self._sweep_repos()

    def _sweep_repos(self) -> None:
        """Delete what a git process killed mid-request left under `repos/`.

        No age threshold: every git process is a child of the hub, so at
        startup none is running, and a ref lock a redeploy left a minute ago
        has to go — until it does, every push to that branch fails on "cannot
        lock ref". Swept: the ref locks (`refs/**/*.lock`, `packed-refs.lock`),
        the quarantine of a push never accepted (`objects/tmp_objdir-incoming-*`),
        a repository `ensure_repo` never renamed into place (`.tmp-*.git`) and
        the old repository a re-import parked and never deleted (`.trash-*`,
        `_replace_directory`).
        """
        try:
            entries = list(self.repos_dir.iterdir())
        except OSError:
            return
        doomed = []
        for entry in entries:
            if entry.name.startswith((STAGING_PREFIX, TRASH_PREFIX)):
                doomed.append(entry)
                continue
            doomed += (entry / "refs").rglob("*.lock")
            doomed.append(entry / "packed-refs.lock")
            doomed += (entry / "objects").glob("tmp_objdir-incoming-*")
        for path in doomed:
            try:
                if path.is_dir() and not path.is_symlink():
                    shutil.rmtree(path)
                else:
                    path.unlink()
            except FileNotFoundError:
                continue
            except OSError as error:
                logger.warning(f"could not sweep leftover {path}: {error}")
                continue
            logger.info(f"swept leftover {path}")

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
    def valid_variant(name) -> bool:
        """Is this a name a variant may have? A branch whose name passes
        `SAFE_ID`, the rule of every other id in an address."""
        return isinstance(name, str) and bool(SAFE_ID.match(name))

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

    def _lock_for(self, pid: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(pid, threading.Lock())

    def _repo_lock_for(self, pid: str) -> threading.Lock:
        with self._locks_guard:
            return self._repo_locks.setdefault(pid, threading.Lock())

    # -- addresses on the volume -------------------------------------------
    # The one place that knows the layout: callers ask these for addresses
    # rather than assembling paths themselves, so the layout can move. None of
    # the six below touches the disk; `resolve_inside` does, on the terms its
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

    def build_log_path(self, pid: str, name: str) -> Path:
        """What the build of one revision printed."""
        return self.build_dir(pid, name) / BUILD_LOG_FILE

    def variant_dir(self, pid: str, variant: str = MAIN_BRANCH) -> Path:
        """Where one variant's `latest`, `dev/` and `builds.json` are: the
        project's own directory for the default variant, `.variants/<b>/`
        for any other."""
        if variant == MAIN_BRANCH:
            return self.project_dir(pid)
        return self.project_dir(pid) / VARIANTS_DIR / variant

    def pointer_dir(self, pid: str, variant: str, name: str) -> Path:
        """One variant's `latest` or `dev`."""
        return self.variant_dir(pid, variant) / name

    def builds_json_path(self, pid: str, variant: str = MAIN_BRANCH) -> Path:
        """One variant's build picker."""
        return self.variant_dir(pid, variant) / PROJECT_BUILDS_FILE

    def variants_json_path(self, pid: str) -> Path:
        """The project's list of variants."""
        return self.project_dir(pid) / VARIANTS_FILE

    def site_index_path(self) -> Path:
        """The front page's cards. Absent until the first push."""
        return self.root / SITE_INDEX_FILE

    def repo_dir(self, pid: str) -> Path:
        """The project's bare git repository."""
        return self.repos_dir / f"{pid}{REPO_SUFFIX}"

    def ensure_repo(self, pid: str) -> Path:
        """The project's repository: imported, created empty, or as it is.

        Run by every git request before `git http-backend` starts, and at start
        for every project with builds published before git (`catch_up`). Under
        the repository's own lock, so two first requests do not both create it
        and a request that meets an import in progress waits for it.

        A project with builds named otherwise than by a commit — published
        before git (`_import_builds`) — is imported (`_needs_import` says
        when), and every other one gets an empty repository. A build named by
        a commit was published by a push and is never imported: its commit is
        in the repository, or went with a push git did not finish. Either
        repository is written under a staging name and renamed into place, so
        a repository is whole or absent; a staging directory a crash leaves
        behind is swept at the next start (`_sweep_repos`).

        Raises ImportFailed when the import fails, now or earlier in this
        process: nothing is changed, the line `import <pid>: <build>: <why>` is
        logged once, and the next start tries again.
        """
        repo = self.repo_dir(pid)
        with self._repo_lock_for(pid):
            failure = self._import_failures.get(pid)
            if failure is not None:
                raise ImportFailed(failure)
            builds = self._import_builds(pid)
            try:
                if builds and self._needs_import(pid, repo, builds):
                    self._import(pid, repo, builds)
                    return repo
            except ImportFailed as error:
                self._import_failures[pid] = str(error)
                logger.error(f"import {pid}: {error}")
                raise
            if repo.is_dir():
                return repo
            self.repos_dir.mkdir(parents=True, exist_ok=True)
            staging = self._repo_staging(pid)
            subprocess.run(
                ["git", "init", "--quiet", "--bare", "--initial-branch=main",
                 str(staging)],
                env=git_environment(), stdout=subprocess.DEVNULL, check=True)
            staging.rename(repo)
        logger.info(f"created the git repository of {pid}")
        return repo

    def _import_builds(self, pid: str) -> list[dict]:
        """The builds of `pid` published before git, oldest first (`_built_key`).

        Every build named otherwise than by a commit, each of which the import
        takes into git and `drop_sources` holds to its import commit: the ones
        `builds_of` lists, and the ones whose meta.json is of an older format
        it skips. No list of the hub shows those, but they are versions of the
        project all the same, still served by their URL, and their code goes
        into git like the rest. Such a directory without a `.payload.sha256`
        was never published (a restore that ran out halfway) and is left out,
        so it does not fail the whole import; a missing archive fails it as it
        does for any build (`_import`).
        """
        metas = {meta["commit"]: meta for meta in self.builds_of(pid)}
        pdir = self.projects_dir / pid
        for entry in (pdir.iterdir() if pdir.is_dir() else ()):
            if (entry.name in metas or entry.name.startswith(".")
                    or entry.name in RESERVED_BUILD_NAMES
                    or entry.is_symlink() or not entry.is_dir()):
                continue
            try:
                meta = json.loads(
                    (entry / BUILD_META_FILE).read_text(encoding="utf-8"))
            except (ValueError, OSError, RecursionError):
                continue
            if (isinstance(meta, dict) and meta.get("commit") == entry.name
                    and _read_digest(entry)):
                metas[entry.name] = meta
        builds = [meta for meta in metas.values()
                  if not COMMIT_NAME.match(meta["commit"])]
        builds.sort(key=_built_key)
        return builds

    def _repo_staging(self, pid: str) -> Path:
        return self.repos_dir / (
            f"{STAGING_PREFIX}{pid}-{uuid.uuid4().hex}{REPO_SUFFIX}")

    def import_failure(self, pid: str) -> str | None:
        """Why this project's import failed in this process, or None."""
        return self._import_failures.get(pid)

    def _needs_import(self, pid: str, repo: Path, builds: list) -> bool:
        """Does a project with these builds have to be imported (again)?

        `builds` are the project's builds named otherwise than by a commit
        (`_import_builds`), at least one. Yes when there is no repository, when
        `main` is empty (a git request created the repository, or a push
        published a build and git never wrote the branch), and when `main`
        holds nothing but imported commits while one of `builds` has no import
        commit: a hub of the previous image published it from an archive after
        the import, or it is of the older format an earlier import skipped.
        The import is redone whole. It is deterministic: the commits older
        than the first build it adds get the same shas, every later one a new
        sha.

        A missing import commit under commits of the author's own is an
        ImportFailed: redoing the import would drop them, and leaving it would
        let `latest` fall back to the old import's tip.
        """
        if not repo.is_dir():
            return True
        commits = _trailed_log(repo, MAIN_REF)
        if not commits:
            return True
        imported = {value for _sha, values in commits for value in values}
        missing = [meta["commit"] for meta in builds
                   if f"{pid}/{meta['commit']}" not in imported]
        if not missing:
            return False
        if any(not values for _sha, values in commits):
            raise ImportFailed(
                f"{missing[0]}: it has no import commit, and {MAIN_BRANCH} "
                f"already has commits of the author's own")
        return True

    def _import(self, pid: str, repo: Path, builds: list) -> None:
        """Take a project's old builds into a new repository, oldest first.

        `builds` are the builds published before git (`_import_builds`). The
        tip of `main` is the newest of them, and `latest` the nearest to it
        that `builds_of` serves (`_branch_latest`): the build `latest` was
        before git. One commit per build out of its archive, checked against
        the build's `.payload.sha256`; then each build's old log is copied
        beside it, `main` is pointed at the last commit and the repository
        renamed into place, over an existing one. Raises ImportFailed, leaving
        everything as it was.
        """
        self.repos_dir.mkdir(parents=True, exist_ok=True)
        staging = self._repo_staging(pid)
        try:
            try:
                run_git(None, "init", "--quiet", "--bare",
                        f"--initial-branch={MAIN_BRANCH}", str(staging))
            except subprocess.CalledProcessError as error:
                raise ImportFailed(git_failure(error)) from error
            parent = None
            logs = []
            for meta in builds:
                name = meta["commit"]
                digest = _read_digest(self.build_dir(pid, name))
                if not digest:
                    raise ImportFailed(f"{name}: it has no {PAYLOAD_DIGEST_FILE}")
                try:
                    parent = self._import_build(pid, staging, meta, digest,
                                                parent)
                except subprocess.CalledProcessError as error:
                    raise ImportFailed(f"{name}: {git_failure(error)}") from error
                except tarfile.TarError as error:
                    raise ImportFailed(
                        f"{name}: git archive gave an unreadable tar: {error}"
                    ) from error
                logs.append((name, self.sources_dir / digest / SOURCE_LOG_NAME))
            try:
                run_git(staging, "update-ref", MAIN_REF, parent)
            except subprocess.CalledProcessError as error:
                raise ImportFailed(git_failure(error)) from error
            for name, log in logs:
                try:
                    if log.is_file():
                        atomic_write_bytes(
                            self.build_dir(pid, name) / BUILD_LOG_FILE,
                            log.read_bytes(), tmp_dir=self.project_dir(pid))
                except OSError as error:
                    raise ImportFailed(
                        f"{name}: its log cannot be copied: {error}") from error
            try:
                if repo.is_dir():
                    self._replace_directory(repo, staging)
                else:
                    staging.rename(repo)
            except OSError as error:
                raise ImportFailed(
                    f"the repository cannot be put in place: {error}") from error
        finally:
            shutil.rmtree(staging, ignore_errors=True)
        logger.info(f"import {pid}: {len(builds)} commits")

    def _import_build(self, pid: str, repo: Path, meta: dict, digest: str,
                      parent: str | None) -> str:
        """One build as one commit on top of `parent`. -> the commit's sha.

        The archive is unpacked by the rules that once accepted it, added with
        `--force` (no ignore rules apply to what was published), and the
        commit's content checked against `digest` before it is used.
        """
        name = meta["commit"]
        archive = self.sources_dir / digest / SOURCE_ARCHIVE_NAME
        tree_dir = self.root / f"{SOURCE_PREFIX}{uuid.uuid4().hex}"
        index = self.root / f"{JSON_TMP_PREFIX}index-{uuid.uuid4().hex}"
        try:
            tree_dir.mkdir()
            try:
                unpack(archive, tree_dir)
            except PublishError as error:
                raise ImportFailed(
                    f"{name}: its archive cannot be read: {error.message}"
                ) from error
            except OSError as error:
                raise ImportFailed(
                    f"{name}: its archive cannot be read: {error}") from error
            env = {"GIT_INDEX_FILE": str(index)}
            run_git(repo, "add", "--force", "-A", work_tree=tree_dir, env=env,
                    cwd=tree_dir)
            tree = run_git(repo, "write-tree", env=env).strip()
            stamp = f"@{int(_built_key(meta)[0])} +0000"
            identity = {
                "GIT_AUTHOR_NAME": IMPORT_NAME, "GIT_AUTHOR_EMAIL": IMPORT_EMAIL,
                "GIT_AUTHOR_DATE": stamp,
                "GIT_COMMITTER_NAME": IMPORT_NAME,
                "GIT_COMMITTER_EMAIL": IMPORT_EMAIL,
                "GIT_COMMITTER_DATE": stamp}
            subject = meta.get("message") or f"Revision {name} imported from the hub"
            message = f"{subject}\n\n{IMPORT_TRAILER}: {pid}/{name}\n"
            parents = ["-p", parent] if parent else []
            commit = run_git(repo, "commit-tree", tree, *parents,
                             env=identity, input=message).strip()
            found = _commit_digest(repo, commit)
            if found != digest:
                raise ImportFailed(
                    f"{name}: the imported commit holds other content than the "
                    f"build was published from ({found} against {digest})")
            return commit
        finally:
            shutil.rmtree(tree_dir, ignore_errors=True)
            try:
                index.unlink()
            except OSError:
                pass

    # -- what the repository says ------------------------------------------
    def _built_name(self, pid: str, sha: str, values, names) -> str | None:
        """The build a commit is, among `names`, or None if it is none of them.

        A commit is built when a build is named by its sha, or when it is an
        import commit of THIS project naming an existing build: an import of a
        neighbouring project, come with an author's shared history, is not.
        """
        if sha in names:
            return sha
        for value in values:
            owner, _, name = value.partition("/")
            if owner == pid and name in names:
                return name
        return None

    def built_build(self, pid: str, commit: str, env: dict = None) -> str | None:
        """The build of `pid` this commit already is, or None.

        `env` reaches the git process: the pre-receive hook passes the push's
        quarantine, where a commit not yet accepted is found.
        """
        names = {meta["commit"] for meta in self.builds_of(pid)}
        if commit in names:
            return commit
        commits = _trailed_log(self.repo_dir(pid), commit, "-1", env=env)
        if not commits:
            return None
        sha, values = commits[0]
        return self._built_name(pid, sha, values, names)

    def _branches(self, pid: str) -> list:
        """The project's branches, the variants, by name. [] with no repository."""
        repo = self.repo_dir(pid)
        if not repo.is_dir():
            return []
        out = run_git(repo, "for-each-ref", "--format=%(refname)",
                      BRANCH_PREFIX)
        return sorted(name for line in out.splitlines()
                      if self.valid_variant(name := line.removeprefix(
                          BRANCH_PREFIX)))

    def _branch_latest(self, pid: str, branch: str, names) -> str | None:
        """The build of the nearest built commit on `branch`'s first-parent
        line, among `names`."""
        for sha, values in _trailed_log(self.repo_dir(pid),
                                        f"{BRANCH_PREFIX}{branch}",
                                        "--first-parent"):
            name = self._built_name(pid, sha, values, names)
            if name is not None:
                return name
        return None

    def _reached(self, pid: str, branch: str, names) -> set:
        """The builds among `names` whose commits `branch` reaches, through
        every parent: the imported versions stand behind `connect`'s merge as
        its second parent."""
        found = set()
        for sha, values in _trailed_log(self.repo_dir(pid),
                                        f"{BRANCH_PREFIX}{branch}"):
            name = self._built_name(pid, sha, values, names)
            if name is not None:
                found.add(name)
        return found

    def _variants_on_disk(self, pid: str) -> set:
        """The variants with a directory of their own: a branch's, or a draft's
        whose branch the hub does not have."""
        try:
            entries = list((self.project_dir(pid) / VARIANTS_DIR).iterdir())
        except OSError:
            return set()
        return {entry.name for entry in entries
                if entry.is_dir() and self.valid_variant(entry.name)
                and entry.name != MAIN_BRANCH}

    def recompute(self, pid: str, index: bool = True) -> None:
        """Every variant's `latest` and `builds.json`, `variants.json`, then
        the index.

        Run at the end of every push (`githttp.end_of_request`) and at start
        (`catch_up`). Under the project's lock, the index outside it: holding
        one project's lock across a walk of every project is how two of them
        would deadlock (see `publish_built`). Nothing for a project whose import
        failed.
        """
        if pid in self._import_failures:
            return
        with self._lock_for(pid):
            self._derive(pid)
        if index:
            self._refresh_index()

    def _derive(self, pid: str) -> None:
        """What `recompute` writes, under the project lock its callers hold.

        A variant's `latest` is the nearest built commit of its branch's
        first-parent line; its `builds.json` lists the builds its branch
        reaches. The default variant's lists besides every build no branch
        reaches (the loser of a race), so no build drops out of every history.
        A variant with only a draft gets a `builds.json` with its slot alone.
        """
        metas = self.builds_of(pid)
        names = {meta["commit"] for meta in metas}
        branches = self._branches(pid)
        reached = {branch: self._reached(pid, branch, names)
                   for branch in branches}
        unreached = names.difference(*reached.values())
        for variant in {MAIN_BRANCH, *branches, *self._variants_on_disk(pid)}:
            if variant in reached:
                self._switch_latest(pid, variant, names)
            own = reached.get(variant, set())
            if variant == MAIN_BRANCH:
                own = own | unreached
            self._write_builds_json(
                pid, variant, [meta for meta in metas if meta["commit"] in own])
        self._write_variants_json(pid, branches, metas)

    def _write_variants_json(self, pid: str, branches: list,
                             metas: list) -> None:
        """`variants.json`: every branch, the default first, the rest by label.

        A branch's label is the `variant_label` of the newest revision
        published from it (`variant` in its meta.json, absent on a build older
        than variants and meaning the default), else the branch's name: a
        branch just cut from `main` is not labelled as `main` is.

        No branch, no file: a refused first push leaves a repository and the
        empty project directory `build_staging` made, and that is no project. A
        `variants.json` in that directory would make `empty()` count it, and
        the sign-in page would lose its first steps for good.
        """
        if not branches:
            self.variants_json_path(pid).unlink(missing_ok=True)
            return
        variants = []
        for branch in branches:
            newest = next((meta for meta in metas
                           if (meta.get("variant") or MAIN_BRANCH) == branch),
                          {})
            label = newest.get("variant_label")
            variants.append({"name": branch,
                             "label": label if isinstance(label, str) and label
                             else branch})
        variants.sort(key=lambda v: (v["name"] != MAIN_BRANCH,
                                     v["label"].casefold(), v["name"]))
        _atomic_write_json(self.variants_json_path(pid),
                           {"default": MAIN_BRANCH, "variants": variants})

    def variant_count(self, pid: str) -> int:
        """How many variants `variants.json` lists; 1 when it cannot say."""
        try:
            listed = json.loads(self.variants_json_path(pid).read_text(
                encoding="utf-8"))["variants"]
        except (OSError, ValueError, TypeError, KeyError, RecursionError):
            return 1
        return max(1, len(listed)) if isinstance(listed, list) else 1

    def catch_up(self) -> None:
        """At start: import what needs it, recompute every project, then
        `drop_sources`.

        Run on a thread of its own (`app.create_server`): neither the start nor
        the healthcheck waits for it, and the site serves the builds off the
        disk meanwhile. A git request to a project not yet imported does the
        import itself, or waits for it on the repository's lock. The pass comes
        after every import, so the archives one start imports it also deletes.
        """
        pids = set()
        for directory in (self.projects_dir, self.repos_dir):
            try:
                entries = list(directory.iterdir())
            except OSError:
                continue
            for entry in entries:
                if entry.name.startswith(".") or not entry.is_dir():
                    continue
                pid = entry.name.removesuffix(REPO_SUFFIX)
                if self.valid_pid(pid):
                    pids.add(pid)
        for pid in sorted(pids):
            try:
                if self._import_builds(pid):
                    self.ensure_repo(pid)
                if self.repo_dir(pid).is_dir():
                    self.recompute(pid, index=False)
            except ImportFailed:
                continue
            except Exception:
                logger.exception(f"start: {pid} could not be brought up to date")
        try:
            self._refresh_index()
        except Exception:
            logger.exception("start: the site index was not refreshed")
        try:
            self.drop_sources()
        except Exception:
            logger.exception("start: the pass over sources/ stopped")

    # -- the archives of the builds published before git --------------------
    def drop_sources(self) -> None:
        """Delete each archive in `sources/` that its import commits give back.

        `sources/<d>/` goes whole when every build carrying `d` as its
        `.payload.sha256` (`_import_builds`, across every project) has its
        import commit in its project's `main`, and its `.build.log` if the
        directory holds a `log.txt`, and when the content of at least one of
        those commits has the digest `d` (`_commit_digest`). The digest is the
        build's and not its name: a build named otherwise shares it with the
        build of the same tree.

        Everything else stays: a directory whose digest no such build carries
        silently, as not imported, because there is nothing to check it against;
        one that fails the check with the line `sources <d>: <why>` at ERROR.
        One line sums the pass up. Builds, logs and repositories are only read.
        """
        try:
            directories = sorted(entry for entry in self.sources_dir.iterdir()
                                 if entry.is_dir() and not entry.is_symlink())
        except FileNotFoundError:
            return
        owners = {}
        # An empty `sources/`, as every pass after the first finds it, has no
        # reason to read the builds of every project.
        for pid in (self._pids() if directories else ()):
            for meta in self._import_builds(pid):
                name = meta["commit"]
                digest = _read_digest(self.build_dir(pid, name))
                if digest:
                    owners.setdefault(digest, []).append((pid, name))
        commits = {}
        deleted = kept = unowned = 0
        for directory in directories:
            builds = owners.get(directory.name)
            if not builds:
                unowned += 1
                continue
            try:
                why = self._unverified(directory, builds, commits)
                if why is None:
                    shutil.rmtree(directory)
            except subprocess.CalledProcessError as error:
                why = git_failure(error)
            except tarfile.TarError as error:
                why = f"git archive gave an unreadable tar: {error}"
            except OSError as error:
                why = str(error)
            if why is None:
                deleted += 1
            else:
                kept += 1
                logger.error(f"sources {directory.name}: {why}")
        logger.info(f"sources: deleted {deleted}, kept {kept}, "
                    f"not imported {unowned}")

    def _pids(self) -> list:
        """Every project with a directory under `project/`, by id."""
        return sorted(entry.name for entry in self.projects_dir.iterdir()
                      if not entry.name.startswith(".") and entry.is_dir()
                      and self.valid_pid(entry.name))

    def _unverified(self, directory: Path, builds: list, commits: dict):
        """Why `directory` in `sources/` may not go yet, or None if it may.

        `builds` are the `(pid, build)` carrying its digest; `commits` caches
        each project's import commits, `{pid: {"<pid>/<build>": [sha, ...]}}`.
        """
        log = (directory / SOURCE_LOG_NAME).is_file()
        found = []
        for pid, name in builds:
            if pid not in commits:
                imports = {}
                for sha, values in _trailed_log(self.repo_dir(pid), MAIN_REF):
                    for value in values:
                        imports.setdefault(value, []).append(sha)
                commits[pid] = imports
            shas = commits[pid].get(f"{pid}/{name}")
            if not shas:
                return f"{pid}/{name} has no import commit in {MAIN_BRANCH}"
            if log and not self.build_log_path(pid, name).is_file():
                return f"{pid}/{name} has no {BUILD_LOG_FILE}"
            found += [(pid, name, sha) for sha in shas]
        others = []
        for pid, name, sha in found:
            digest = _commit_digest(self.repo_dir(pid), sha)
            if digest == directory.name:
                return None
            others.append(f"{pid}/{name} {sha} gives {digest}")
        return "no import commit gives this digest: " + "; ".join(others)

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
                      digest: str, job=None, message=None,
                      variant: str = MAIN_BRANCH,
                      variant_label: str = None) -> tuple[int, dict]:
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
        the rest. `variant` is the branch the revision is published from: it
        goes into the document, and the revision fills that variant's slot.
        `variant_label` is the checked `"variant"` of its project.json.
        """
        files = _hash_output(staging, names)
        pdir = self.projects_dir / pid
        with self._lock_for(pid):
            pdir.mkdir(parents=True, exist_ok=True)
            final = pdir / commit

            # Under the project lock and immediately before the rename, so a
            # second push of the same commit that was building at the same time
            # finds this one's directory and passes as a retry.
            if final.exists():
                existing = _read_digest(final)
                if existing is not None and existing == digest:
                    logger.info(f"publish {pid}/{commit}: identical retry, kept")
                    return 200, _build_url(pid, commit)
                raise PublishError(
                    409, f"build {commit} already exists with different content")

            meta = self._finish_staging(pid, commit, staging, files, digest,
                                        message=message, variant=variant,
                                        variant_label=variant_label)
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
            # what is on disk — `latest`, the picker, the index — and the end of
            # the push and every start recompute it (`recompute`), so a failure
            # here is logged rather than reported (reporting it would mark a
            # live build's job `failed`).
            #
            # Order: fill the slot with this revision, then the picker from what
            # is on disk. The mirror has to come before `_derive` and
            # `_refresh_index`, which describe the slot (`has_dev`, the
            # front-page card). `latest` follows the branch, which git has not
            # moved yet: it stays where it was until the end of the push.
            try:
                self._mirror_into_dev_slot(
                    pid, self.pointer_dir(pid, variant, DEV_LINK), final, meta,
                    digest, job)
                if variant == MAIN_BRANCH:
                    # A rename is superseded by the push that follows it: the
                    # build carries the project's own title, and that is the
                    # newer statement of what the project is called. Before the
                    # picker is written, so the file is rebuilt from the state
                    # that survives.
                    self.clear_title(pid)
                    # The draft status goes too: the mirror has just put this
                    # revision into the slot, so a draft status left behind
                    # would outlive the draft it is about. A draft build in
                    # flight loses its `building` chip to this commit, which is
                    # the lesser error. Both belong to the front page's card,
                    # which shows the default variant, so another variant's
                    # revision touches neither.
                    self.clear_draft_job(pid)
                self._derive(pid)
                # Last: after the mirror, so the slot's fresh copy is linked
                # too, and inside this guard, because linking only saves space.
                self._dedupe(pid)
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
            f"{_contents(meta)}")
        return 201, _build_url(pid, commit)

    def publish_dev_built(self, pid: str, staging: Path, names,
                          digest: str, job=None, variant: str = MAIN_BRANCH,
                          variant_label: str = None) -> tuple[int, dict]:
        """Overwrite a variant's ONE local slot, `<pid>/dev/` for the default
        variant and `.variants/<b>/dev/` for another (SPEC 7.6).

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
        already in it — the second answer normally comes from the pre-receive
        hook before a build is even queued (`unchanged`), and is repeated here
        for the draft that arrived while an identical one was building.

        `job` goes into the slot's meta.json: the slot is the one build no
        revision addresses, so the job that filled it is the only place its log
        exists. `variant` and `variant_label` go there too, as on a revision.
        """
        files = _hash_output(staging, names)
        slot = self.pointer_dir(pid, variant, DEV_LINK)
        url = _build_url(pid, DEV_LINK, variant)
        where = f"{pid}/{DEV_LINK}" if variant == MAIN_BRANCH \
            else f"{pid}/{VARIANT_SEGMENT}/{variant}/{DEV_LINK}"
        with self._lock_for(pid):
            slot.parent.mkdir(parents=True, exist_ok=True)
            if _read_digest(slot) == digest:
                # Same sources as the slot already holds. Nothing to write, and
                # nothing SHOULD be written: a swap here would take the page the
                # author has open through a needless re-render.
                logger.info(f"publish {where}: identical, kept")
                return 200, url
            meta = self._finish_staging(pid, DEV_LINK, staging, files, digest,
                                        job=job, variant=variant,
                                        variant_label=variant_label)
            self._swap_dev_slot(slot, staging)

            # `latest` is not touched: a local build is not a commit, so it
            # cannot be the newest one. `builds.json` is rewritten because the picker shows
            # whether the slot is occupied at all — and, like the tail of
            # `publish_built`, it runs AFTER the swap that publishes and so
            # cannot be allowed to unpublish it by raising. The next push
            # rewrites the file from scratch.
            try:
                # Same as the commit route: this push carries the project's own
                # title, so an earlier rename has been answered — by the
                # default variant, whose name the card shows.
                if variant == MAIN_BRANCH:
                    self.clear_title(pid)
                self._derive(pid)
                self._dedupe(pid)
            except Exception:
                logger.exception(
                    f"publish {where}: the slot is published, but the "
                    f"bookkeeping after it did not finish; the next push "
                    f"redoes it")

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
                f"publish {where}: the slot is published, but the site "
                f"index was not refreshed")

        logger.info(f"publish {where}: {len(files)} files, {_contents(meta)}")
        return 201, url

    @staticmethod
    def _swap_dev_slot(slot: Path, source: Path) -> None:
        """Put a prepared tree into a slot, `dev/`, replacing what is there.

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
        Store._replace_directory(slot, source)

    @staticmethod
    def _replace_directory(target: Path, source: Path) -> None:
        """The two renames `_swap_dev_slot` describes, with the target named.

        One copy of the dance, because there are three names on this volume
        that are REPLACED rather than only created — the `dev` slot, a
        comparison cache entry and a repository the import redoes — and the
        ordering above is the whole of what makes each of them safe to read
        while it is being written.
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

    def _mirror_into_dev_slot(self, pid: str, slot: Path, final: Path,
                              meta: dict, digest: str, job=None) -> None:
        """Put a revision that has just been published into its variant's slot.

        The slot is the freshest state the hub knows about the project, not the
        last call to `build`; without this a commit would leave the slot showing
        geometry older than `latest`.

        A copy of the published tree, since the publishing rename emptied the
        staging directory. Nothing is validated again: at publication a
        revision's meta.json and the slot's differ in exactly `commit`, `dev` and
        `job` (`render.build_meta`).

        The swap is unconditional, even when the slot already holds these
        sources: the slot has to carry this revision's meta.json, not the
        `built` and `published` stamps of an earlier `build`.

        Never raises: it runs past the point of no return, and the slot has no
        history to lose.
        """
        tmp = self.project_dir(pid) / f"{STAGING_PREFIX}{DEV_LINK}-{uuid.uuid4().hex}"
        try:
            slot.parent.mkdir(parents=True, exist_ok=True)
            # A copy and not hard links: the two writes below go into these
            # files in place, and through a link they would rewrite the
            # revision. `_dedupe` links the rest once the slot is in place.
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
            self._swap_dev_slot(slot, tmp)
        except Exception:
            shutil.rmtree(tmp, ignore_errors=True)
            logger.exception(
                f"publish {pid}/{final.name}: the revision is published, but "
                f"the {DEV_LINK} slot was not updated to match it")

    # -- one file per content ----------------------------------------------
    def _dedupe(self, pid: str) -> int:
        """Hard-link identical files across one project's builds. -> files linked.

        Every build directory of the project, the `dev` slot included, then
        every other variant's slot, is walked in name order with the sha256 of
        each file it ships
        (`_file_digests`), and a file whose content was already seen is
        replaced by a hard link to the first copy in that order — which may be
        the build just published, the others then relinked to it. Run after
        every publish under the project lock, which every writer of the
        project's directories holds; another process running this without that
        lock could link a revision's file to a slot that was swapped meanwhile.

        Within one project only: across projects the live volume held no
        identical file, and this scope keeps the whole walk under the one lock
        every writer of the project already takes.

        The replacement is a link under a temporary name renamed over the file,
        so a reader opens the old inode or the new one, both with the same
        bytes, and never finds the name missing. The temporary sits in the
        project directory, where `_sweep_leftovers` collects one a SIGKILL left.

        A file that will not link is logged and skipped: the build is published
        either way, and the next publish of the project tries again.
        """
        pdir = self.projects_dir / pid
        first: dict[str, Path] = {}
        linked = 0
        # A variant's slot is filled with a COPY of its revision
        # (`_mirror_into_dev_slot`), and only this links the two.
        slots = sorted(pdir.glob(f"{VARIANTS_DIR}/*/{DEV_LINK}"))
        for build in [*sorted(pdir.iterdir()), *slots]:
            if (build.name.startswith(".") or build.is_symlink()
                    or not build.is_dir()):
                continue
            for name, sha in self._file_digests(pid, build).items():
                path = build / name
                seen = first.setdefault(sha, path)
                if seen is path:
                    continue
                tmp = pdir / f"{JSON_TMP_PREFIX}{uuid.uuid4().hex}"
                try:
                    if os.path.samefile(seen, path):
                        continue
                    os.link(seen, tmp)
                    os.rename(tmp, path)
                except OSError as error:
                    logger.warning(f"dedupe {pid}: could not link {path} to "
                                   f"{seen}: {error}")
                    try:
                        os.unlink(tmp)
                    except OSError:
                        pass
                    continue
                linked += 1
        if linked:
            logger.info(f"dedupe {pid}: {linked} files linked")
        return linked

    def _file_digests(self, pid: str, build: Path) -> dict:
        """`{relative path: sha256}` of one build directory, for `_dedupe`.

        Read off the record publication writes (`FILE_DIGESTS_FILE`). A build
        published before that record existed has none, so its files are hashed
        here once and the record written: every regular file outside a dot
        entry, less the ones the hub writes itself (`_linkable`).
        """
        record = build / FILE_DIGESTS_FILE
        try:
            digests = json.loads(record.read_text(encoding="utf-8"))
            if isinstance(digests, dict):
                return digests
        except (OSError, ValueError):
            pass
        names = []
        for path in sorted(build.rglob("*")):
            relative = path.relative_to(build)
            if (path.is_file() and not path.is_symlink()
                    and not any(part.startswith(".") for part in relative.parts)):
                names.append(str(relative))
        digests = _linkable(_hash_output(build, names))
        # The temporary in the project directory: the sweep never walks a build
        # directory.
        atomic_write_bytes(record, json.dumps(digests).encode("utf-8"),
                           tmp_dir=self.projects_dir / pid)
        return digests

    # -- staging -> publishable directory ----------------------------------
    def _finish_staging(self, pid, commit, staging: Path, files, digest,
                        job=None, message=None, variant=MAIN_BRANCH,
                        variant_label=None) -> dict:
        """Validate meta.json and write everything the build page needs.

        `staging` is what the build wrote (SPEC 8A.2 step 5), so the meta.json
        read here is the build's own.

        `job` is handed on to `build_meta`, which records it in the slot's
        document only. `message` is the subject of the pushed commit, already
        cleaned to what a message may be (`prereceive.revision_message`).
        `variant` and `variant_label` go into the document as they are.
        """
        raw = self._read_meta(staging)
        try:
            meta = render.build_meta(
                pid=pid, commit=commit, raw=raw, staging=staging, files=files,
                published=published_stamp(), dev=(commit == DEV_LINK), job=job,
                message=message, variant=variant, variant_label=variant_label)
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
        (staging / FILE_DIGESTS_FILE).write_text(
            json.dumps(_linkable(files)), encoding="utf-8")
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

    def latest_commit(self, pid: str, variant: str = MAIN_BRANCH) -> str | None:
        """The build a variant's `latest` currently points at, or None."""
        try:
            return os.path.basename(os.readlink(
                self.pointer_dir(pid, variant, LATEST_LINK)))
        except OSError:
            return None

    def _switch_latest(self, pid: str, variant: str, names) -> None:
        """Point a variant's `latest` at the nearest built commit of its
        branch, as it stands.

        Only a commit build can be one — the local slot is not in `builds_of` —
        which is the rule `latest` exists to keep (SPEC 7.6): it is the link
        that gets pasted into chat, and it has to go on meaning "the project as
        of some commit". Nothing built on the branch leaves it where it is.
        """
        name = self._branch_latest(pid, variant, names)
        if name is None or name == self.latest_commit(pid, variant):
            return
        directory = self.variant_dir(pid, variant)
        directory.mkdir(parents=True, exist_ok=True)
        # From `.variants/<b>/` the build is two levels up.
        target = name if variant == MAIN_BRANCH else f"../../{name}"
        self._point(directory, LATEST_LINK, target)

    @staticmethod
    def _point(directory: Path, name: str, target: str) -> None:
        """Move one pointer symlink, atomically.

        `os.symlink` to a temporary name followed by `os.rename` over the old link
        replaces it in ONE step. The obvious alternative — unlink the old link,
        then create the new one — leaves a window in which /project/<pid>/latest/
        is a 404, and that window is open on every single publish.

        The link is RELATIVE. An absolute one would bake in the path the hub
        happened to have when it wrote it, and break the day the same tree is
        mounted somewhere else — which is exactly what the container does with
        /app/data.
        """
        tmp_link = directory / f"{LATEST_LINK_PREFIX}{uuid.uuid4().hex}"
        os.symlink(target, tmp_link)
        os.rename(tmp_link, directory / name)

    def _write_builds_json(self, pid: str, variant: str, metas: list) -> None:
        """Rewrite one variant's build picker: `metas`, its builds, newest first.

        Called AFTER the pointer has moved, so `latest` in the file names the
        build a reader following that link will actually land on. Temp file plus
        rename, so a reader sees the old list or the new one and never a
        half-written file.

        The local slot is not one of the entries and never will be — that is the
        point of it being a slot (SPEC 7.6) — but the picker still has to be able
        to OFFER it, so whether it is occupied is recorded alongside the list.
        Which is also why this runs for a variant that has no commit builds yet:
        a draft-only one has an empty history and a slot worth linking to.
        """
        dev_meta = self._dev_meta(pid, variant)
        if not metas and dev_meta is None:
            return
        picker = render.builds_json(pid, metas, dev=dev_meta is not None,
                                    latest=self.latest_commit(pid, variant),
                                    fallback=dev_meta)
        renamed = self.project_title(pid)
        if renamed is not None:
            picker["title"] = renamed
        self.variant_dir(pid, variant).mkdir(parents=True, exist_ok=True)
        _atomic_write_json(self.builds_json_path(pid, variant), picker)

    def _dev_meta(self, pid: str, variant: str = MAIN_BRANCH) -> dict | None:
        """A variant's local slot's meta.json, or None if the slot is empty.

        Read rather than assumed: with no commit build in the project it is the
        only source of the project's name and title, and `builds.json` needs
        those to render a header.
        """
        try:
            meta = json.loads((self.pointer_dir(pid, variant, DEV_LINK)
                               / BUILD_META_FILE).read_text(encoding="utf-8"))
        except (ValueError, OSError, RecursionError):
            return None
        return meta if _usable_meta(meta, DEV_LINK) else None

    def dev_metrics_path(self, pid: str,
                         variant: str = MAIN_BRANCH) -> Path | None:
        """A variant's slot's metrics.json, or None when there is nothing there.

        A path rather than the parsed file: the only caller hands it to a build
        process, and parsing it here would mean two readers of the same file
        disagreeing about what a broken one is. Tolerant like `_dev_meta` next
        to it — an unreadable slot is a missing baseline, never an exception on
        the publish path, and `is_file()` answers False for every way a path can
        refuse to be looked at rather than raising. Each variant's build
        measures itself against its own slot, not the default variant's.
        """
        path = self.pointer_dir(pid, variant, DEV_LINK) / METRICS_NAME
        return path if path.is_file() else None

    def _uncommitted_in_slot(self, pid: str) -> bool:
        """Whether the local slot holds sources that no commit has published.

        The question behind the `dev` chip on the front page, deliberately not
        the `has_dev` that `_write_builds_json` writes: that asks whether the
        slot exists, and since a commit fills the slot with itself it is true of
        every committed project.

        Answered by digest: the mirror writes the revision's own source digest
        into the slot, so a slot whose digest equals that of the build
        `latest` points at holds nothing that build does not, while a draft of
        edited sources lands a different one. Comparing the trees would be
        weaker: two builds of the same sources differ in their timestamps.

        Errs towards True on a digest that will not read: a needless chip is
        better than the front page silently not mentioning local work.
        """
        if self._dev_meta(pid) is None:
            return False
        commit = self.latest_commit(pid)
        pdir = self.projects_dir / pid
        in_slot = _read_digest(pdir / DEV_LINK)
        published = _read_digest(pdir / commit)
        return not (in_slot is not None and in_slot == published)

    def _refresh_index(self) -> None:
        """Rebuild the root index.json from the build each project's `latest` is.

        The card shows the default variant: its `latest` and its slot. The
        local slot is left out for the same reason it does not move `latest`
        (SPEC 7.6): the front page must not describe uncommitted work. A
        project whose `latest` names no build — only a draft so far, a first
        push whose branch git has not written yet, or no `main` on the hub at
        all — has no card yet. The build `latest` names and not the newest
        one: after two pushes raced, the newest is the loser's, which is not
        on the branch.

        Three of the card's fields belong to the project rather than the build,
        so they are read here and handed over: whether the slot holds sources
        no commit has published (`_uncommitted_in_slot`, not the same question
        as `has_dev` in `builds.json`), the oldest build still on disk, and how
        many variants the project has (`variant_count`). `render.index_card`
        says what each is for.
        """
        with self._index_lock:
            cards = []
            for pdir in sorted(self.projects_dir.iterdir()):
                if pdir.name.startswith(".") or not pdir.is_dir():
                    continue
                metas = self.builds_of(pdir.name)
                latest = self.latest_commit(pdir.name)
                head = next((meta for meta in metas
                             if meta["commit"] == latest), None)
                if head is not None:
                    # `builds_of` sorts newest first, so the last entry is the
                    # oldest build — and `built` is required of every meta it
                    # returns, which is what makes the subscript safe.
                    card = render.index_card(
                        head,
                        dev=self._uncommitted_in_slot(pdir.name),
                        first_built=metas[-1]["built"],
                        variants=self.variant_count(pdir.name),
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

        The pickers and the index are rewritten from what is on disk, in that
        order and for the reason `publish_built` gives: the per-project files
        first, the site-wide one after it.
        """
        pdir = self.projects_dir / pid
        with self._lock_for(pid):
            if not pdir.is_dir():
                return False
            _atomic_write_json(pdir / PROJECT_TITLE_FILE,
                               {"title": title, "renamed": utcnow_iso()})
            self._derive(pid)
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

        THE COMPARISONS GO WITH IT, and they are the one tree here that is
        removed rather than reasoned about: an entry under `compare/<pid>/` is
        derived from two of this project's revisions and is addressed by that
        project's id, so leaving it behind would go on serving the geometry of
        a project that no longer exists — under a URL a re-pushed project of the
        same id would inherit. It is a cache, so losing it costs a recomputation
        and nothing else; `ignore_errors` because a project with no comparisons
        has no such directory at all.

        THE GIT REPOSITORY GOES TOO, and a project EXISTS when it has either its
        directory under `project/` or its repository: a repository a git request
        to a mistyped pid created has no directory, and must still be removable.

        The comment queue is NOT removed here: it lives under `data/comments/`,
        which belongs to CommentStore, and app.py removes both. Nor is an
        archive in `sources/`: it is `drop_sources`'s, and with its builds gone
        it counts as not imported.
        """
        pdir = self.projects_dir / pid
        repo = self.repo_dir(pid)
        with self._repo_lock_for(pid), self._lock_for(pid):
            if not pdir.is_dir() and not repo.is_dir():
                return None
            # A project pushed again after this starts with nothing to import.
            self._import_failures.pop(pid, None)
            builds = len(self.builds_of(pid))
            if pdir.is_dir():
                shutil.rmtree(pdir)
            shutil.rmtree(self.compare_root / pid, ignore_errors=True)
            if repo.is_dir():
                shutil.rmtree(repo)
        self._refresh_index()
        logger.info(f"removed project {pid}: {builds} builds")
        return {"pid": pid, "builds": builds}


def _contents(meta: dict) -> str:
    """What a published build holds, for the line that reports it."""
    if meta.get("kind") == render.DOCUMENTS_KIND:
        return f"{len(meta['documents'])} documents"
    return f"{len(meta['views'])} views"


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
    string (the card counts printables). A build with no model has neither:
    every document a `bytes` int instead, which the card sums.
    """
    if not isinstance(meta, dict):
        return False
    for key in ("pid", "project", "title", "commit", "built", "published"):
        if not isinstance(meta.get(key), str):
            return False
    if meta["commit"] != dir_name:
        return False
    if meta.get("kind") == render.DOCUMENTS_KIND:
        documents = meta.get("documents")
        return (isinstance(documents, list) and bool(documents)
                and all(isinstance(d, dict) and isinstance(d.get("bytes"), int)
                        for d in documents))
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
    """A digest of a SOURCE tree, given `{relative path: sha256}` of its files.

    The `.payload.sha256` of a build published before git, taken over the
    members of the archive it was published from — independent of their order
    and timestamps — and the name of that archive's directory in `sources/`.
    `_commit_digest` takes it over a commit, which is how the import and
    `drop_sources` hold an import commit to its build.
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

    The same shape `_commit_digest` collects, but a different consumer: that
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

      * the NAME. `app._safe_build_path` asks
        `buildnames.unservable_path_reason` of every path requested under
        `/project/<pid>/<commit>/`, so a path with a segment that starts with a
        dot or carries a character of the C category is not served at all.
        That, and not the content type, is what covers a
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


def _linkable(files: dict) -> dict:
    """The part of a `_hash_output` mapping `_dedupe` may link.

    Less the files the hub writes into a build itself (`render.GENERATED_FILES`):
    their hash is taken before the hub rewrites them, so it does not describe
    what ends up on disk. Two builds whose own meta.json matched would otherwise
    share one meta.json naming one of the two commits.
    """
    return {name: sha for name, sha in files.items()
            if name not in render.GENERATED_FILES}


def _read_digest(build_dir: Path) -> str | None:
    """The payload digest of one build directory, or None if there is not one.

    None rather than an error: `drop_sources` reads the digest of every
    project's builds, and one unreadable file must not stop the pass.
    """
    try:
        return (build_dir / PAYLOAD_DIGEST_FILE).read_text(
            encoding="utf-8").strip()
    except OSError:
        return None


def _atomic_write_json(path: Path, payload) -> None:
    """Write JSON so a reader sees the old file or the new one, never a torn one.

    Every write through this function lands in `self.root`, in `<pid>/` or in
    a variant's `<pid>/.variants/<b>/`, the three levels `_sweep_leftovers`
    walks, so the temporary beside the target is collectable.
    """
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
    (see the comment on the registry owning no file of its own in `src/jobs.py`).
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
