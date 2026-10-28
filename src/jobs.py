#!/usr/bin/env python3
"""The asynchronous half of a push: a job to follow, and a pool to build it in.

The hub builds what it was pushed (SPEC 8A.2 steps 4 and 5), and a CadQuery
build takes minutes. The pre-receive hook (src/prereceive.py) checks a pushed
commit out into a source tree, hands it over as a job and waits for the job:
the build runs in the pool here, with every other build, and the hook only
reads its verdict.

    JobStore    the registry: one directory per job under data/jobs/, with the
                record in job.json and the build log beside it in log.txt
    BuildTask   what the hook hands over: a job id and a source tree
    CompareTask the other kind of work on the same pool: two PUBLISHED revisions
                to measure against each other, owning nothing and publishing
                nothing — its product is the log
    BuildQueue  the pool: a bounded queue and N worker threads that run the
                build and then publish its output

The log is written by the parent, from `BuildOutcome.log`, never by the build
process: nothing the child says is believed (`src/buildproc/__init__.py`), and
what the parent captured is already capped and decoded (`runner._Drain`). A
revision keeps a copy in its own directory (`store.BUILD_LOG_FILE`); its code
is the commit it was built from, in the project's repository.

A start parses what it reads back rather than rebuilding it. A record is taken
when it is a JSON object whose `id` is its directory's name and whose `state` is
in KNOWN_STATES; anything else is skipped with a warning and left in place. The
hub never writes a torn record (`atomic_write_bytes`), so what fails the parse is
a hand edit, a failing disk, a kill between `create`'s `mkdir` and its write, or
a build writing into `data/jobs/`, which every build can (`src/buildproc/__init__.py`).

The only records a start writes are jobs stranded `queued` or `building`: each
is failed with RESTART_CODE, persisted so later starts do not warn again.

No job is ever deleted for its age or number (SPEC 5.3, 7.4): a record and its
log stay until somebody removes the directory.

Nothing in this module is module-level state. `JobStore` and `BuildQueue` are
built per server, like `Store` and `CommentStore`, so two hubs in one test
process share no registry and no worker pool. The one thing that IS process-wide
is the worker THREADS, which is what `tests/conftest.py` guards before and after
every test.
"""

from dataclasses import dataclass
import json
import math
import os
import queue
import re
import secrets
import shutil
import threading
import time
from pathlib import Path

from loguru import logger

from src.buildproc import (
    STATUS_BAD_RESULT,
    STATUS_CPU_EXHAUSTED,
    STATUS_CRASHED,
    STATUS_FAILED,
    STATUS_HANG,
    STATUS_KILLED,
    STATUS_LIMITS_ERROR,
    STATUS_OUTPUT_LIMIT,
    STATUS_TIMEOUT,
    Limits,
    run_build,
    run_compare,
)
from src import docsbuild
from src.store import (BUILD_LOG_FILE, DEV_LINK, MAIN_BRANCH, PublishError,
                       atomic_write_bytes, utcnow_iso)

# -- what a job can be -------------------------------------------------------
# `queued` and `building` are the two states a restart can strand, which is why
# they are separate: a job that never reached a worker and one that was killed
# half way through are the same to the pusher but not to whoever reads the log.
STATE_QUEUED = "queued"
STATE_BUILDING = "building"
STATE_DONE = "done"
STATE_FAILED = "failed"

# The two a poller may stop on. Unused here; it is the wire contract
# `hammerola/hub.py` mirrors.
TERMINAL_STATES = (STATE_DONE, STATE_FAILED)
# The four, as a set to check a record against. A state outside it is not a
# harmless typo: `_load` only ever fails a job that is `queued` or `building`,
# so a fifth word is a record no rule here can reach, served to whoever polls it
# as a status no client has a branch for.
KNOWN_STATES = frozenset((STATE_QUEUED, STATE_BUILDING, STATE_DONE, STATE_FAILED))

# 16 bytes from `secrets`, base64url-encoded: 22 characters out of the alphabet
# below. UNGUESSABLE rather than sequential, because the id is the only thing
# guarding a job — the status and the log are readable by anyone holding
# EDIT_TOKEN, and a counter would let one pusher walk every other project's
# build logs by subtracting one.
JOB_ID_BYTES = 16
SAFE_JOB_ID = re.compile(r"\A[A-Za-z0-9_-]{22}\Z")

# The two files one job owns on the volume.
RECORD_NAME = "job.json"
LOG_NAME = "log.txt"

# The registry owns no file of its own: jobs are looked up by id only. Anything
# that is a property of the set of records must not be stored per record; it
# would need its own file, written by one atomic rename.

# DERIVED from the build's own log ceiling rather than picked, because the two
# are not counted in the same bytes and the difference is a factor of three.
# `runner._Drain` keeps `Limits.log_bytes` (1 MiB) of RAW output and decodes it
# with `errors="replace"`: every byte that is not valid UTF-8 becomes U+FFFD,
# which encodes BACK to three bytes. So a model printing binary — exactly the
# build whose log somebody needs — makes the hub write up to three times the
# ceiling the build ran under. `tests/test_jobs.py` pins the relation.
MAX_LOG_BYTES = 3 * Limits.log_bytes
LOG_TRUNCATED_NOTE = "\n[truncated by the hub: this log is larger than it should be]\n"

# How many builds may run at once.
#
# Measured on the deployed hub (145 jobs, 20 cores, load average 0.6): a build
# is effectively single-threaded, so more workers buy isolation, not speed. The
# long queue waits came from hung builds holding every worker; more workers keep
# one bad project from starving the rest.
#
# Memory bounds it: ~450 MB resident after `import cadquery`
# (buildproc/limits.py) is a floor, not a peak. Four at that floor are 1.8 GB
# against ~12 GB free on the host.
MAX_CONCURRENT_BUILDS = 4

# How many pushes may be WAITING for a worker. Bounded on purpose: an unbounded
# queue turns a hub that cannot keep up into a hub that accepts everything,
# holds an unpacked source tree per entry, and reports success to CI for work it
# will get to in an hour. Refusing with a 503 tells the truth immediately, and
# 503 plus Retry-After is something CI already knows how to handle.
MAX_QUEUED_JOBS = 16
QUEUE_FULL_RETRY_AFTER_SECONDS = 60
# Written once because it goes into both the HTTP body and the job record.
QUEUE_FULL_ERROR = "the build queue is full, retry later"

# What `BuildQueue.submit` answers. Three values, not a boolean: a full queue
# leaves the job for the caller to fail, while a stop has already answered it.
# The stopping flag alone cannot tell them apart, since a stopping hub's queue
# may also be full.
SUBMIT_ACCEPTED = "accepted"
SUBMIT_QUEUE_FULL = "queue-full"
SUBMIT_STOPPED = "stopped"

# The name every worker thread carries. Tests assert on it — a pool that is not
# shut down is otherwise invisible until an unrelated test hangs.
WORKER_THREAD_PREFIX = "hammerola-build"

# How long the whole pool is given to finish what it is doing when the hub
# stops. What is worth waiting for is the publish (a rename plus pointer
# writes, milliseconds), not a build: docker sends SIGKILL 10 s after SIGTERM
# (no `stop_grace_period` in the compose file), so this stays under that.
#
# One budget for the pool, not a timeout per worker: `shutdown` joins workers
# one after another, and per-worker timeouts would multiply. The queue drain
# also comes out of this budget, since it is real work on the same volume.
#
# A build still computing is abandoned: `_load` fails its job at the next start,
# and its `.src-...` sources and `.tmp-...` staging wait for
# `Store._sweep_leftovers`. Queued tasks' sources are removed by `shutdown`.
WORKER_JOIN_SECONDS = 5

# ...but the joins always get at least this, whatever the drain spent: a worker
# may be between the rename and the pointer writes. The stop is bounded by
# max(WORKER_JOIN_SECONDS, drain + this); the drain itself is never cut short,
# or it would leave the trees and unanswered jobs it exists to collect.
WORKER_JOIN_FLOOR_SECONDS = 1

# How often an idle worker wakes to check whether it is being shut down. The
# queue's own `get(timeout=...)` is what does the waiting, so this is not a poll
# loop with work in it: it costs one wakeup per worker per interval and nothing
# else.
WORKER_POLL_SECONDS = 0.05

# What a job left `queued` or `building` by a restart is told. It cannot be
# resumed: the sources were in a directory the sweeper removes, and the process
# that was building is gone. 503 rather than 500 because the honest advice is
# "push again" — nothing about the push was wrong.
RESTART_ERROR = "the hub restarted while this build was in flight; push again"
RESTART_CODE = 503

# The same answer, one moment earlier: a job dropped from the queue by a stop
# never reached a worker at all. Said separately from RESTART_ERROR because it
# is the one case the hub can still report BEFORE it goes away, so a pusher
# polling at that moment gets the truth instead of a status that only changes
# after the next start.
STOPPED_ERROR = "the hub was stopped before this build started; push again"

# ...and the third: the hub threw between creating the job and handing it to
# the pool. A job left `queued` is otherwise reclaimed only by a restart's
# `_load`. Used by `prereceive`.
HANDOVER_ERROR = "the hub failed while handing this build to the pool; push again"

# One line per way a build can end badly, because "the build failed" is not an
# answer anybody can act on and the status alone is a word from another module's
# vocabulary. The log always says more; this says which KIND of more to look for.
BUILD_FAILURE_REASONS = {
    STATUS_FAILED: "the model or a gate refused the build",
    STATUS_CRASHED: "the build crashed",
    STATUS_TIMEOUT: "the build ran past its wall-clock ceiling and was killed",
    STATUS_HANG: "the build stopped responding; its stack is in the log",
    STATUS_CPU_EXHAUSTED: "the build used up its CPU allowance",
    STATUS_KILLED: "the build was killed from outside (out of memory, most likely)",
    STATUS_OUTPUT_LIMIT: "the build wrote more than one build is allowed to write",
    STATUS_BAD_RESULT: "the build claimed a result the hub could not confirm",
    STATUS_LIMITS_ERROR: "the hub could not put its ceilings on the build process",
}


@dataclass(frozen=True)
class BuildTask:
    """One push, handed from the pre-receive hook to a worker.

    `commit` is the name it publishes under: the pushed commit's sha, or `dev`
    for a draft. `sources` is the project's directory checked out of that
    commit, a tree the worker OWNS: it is removed when the job ends, whichever
    way it ends. `digest` is the git id of that directory, written beside the
    build: it tells an identical retry from a colliding one, and a draft of the
    same tree from a changed one.

    `force` asks for the model's own checks() to be skipped. It defaults to
    False, the safe direction for a forgotten argument.

    `message` is what the commit says it is. The build never reads it; it is
    written into the published document, and a draft has none.

    `variant` is the branch the push was for, `refs/heads/<b>` or
    `refs/drafts/<b>`: a draft fills that variant's slot, and a revision says
    in its document which branch it was published from.
    """

    job_id: str
    pid: str
    commit: str
    sources: Path
    digest: str
    force: bool = False
    message: str | None = None
    variant: str = MAIN_BRANCH


@dataclass(frozen=True)
class CompareTask:
    """One comparison of two PUBLISHED revisions, handed to a worker.

    Nothing here is owned the way a `BuildTask`'s tree is: both revisions are in
    the store, they are served over HTTP while this runs, and this task removes
    nothing when it ends. It exists for the same reason the build task does —
    the kernel may not be imported in the hub's own process, so the work goes to
    a child and a worker waits for it.

    `old` and `new` are revision ids the request already validated. The job
    record carries only `new` (`jobs.create` takes one commit); both are in the
    log's first line.

    `view` is the one field that changes what this job PRODUCES rather than what
    it reads: with it the comparison also builds the scene a browser opens and
    the summary beside it, into the comparison cache. None is the ordinary
    measurement — that is what `hammerola diff --material` asks for, and its
    answer is the log — so the artefact is what the URL has to say out loud
    (`/api/v1/compare/<pid>/<old>/<new>/<view>`), never a default.
    """

    job_id: str
    pid: str
    old: str
    new: str
    view: str | None = None


def build_arguments(sources: Path, staging: Path, pid: str, *, force: bool,
                    baseline: Path | None, distance_cache: Path):
    """The call the worker makes into `run_build`, written down ONCE.

    Every test substitutes the builder, so a test binds this expression
    against `src.buildproc.run_build`'s signature to catch a renamed parameter.
    Returned as `(args, keywords)` so the worker and the test share it.

    `baseline` is the published `dev` metrics.json this build compares itself
    against, or None when the project has none. It is a PATH IN THE STORE and
    the build process never opens it: `run_build` copies the file into its own
    scratch first (see there for why the copy is the correctness).

    `distance_cache` is the project's distance cache
    (`store.distance_cache_path`), also a path in the store, which the build
    process opens itself: it is shared by every build of the project.
    """
    return (sources, staging), {"pid": pid, "force": force,
                                "baseline": baseline,
                                "distance_cache": distance_cache}


def compare_arguments(old_dir: Path, new_dir: Path, pid: str, *,
                      out_dir: Path | None = None, view: str | None = None):
    """The call the worker makes into `run_compare`, written down ONCE.

    The same seam as `build_arguments`, bound by a test against
    `src.buildproc.run_compare`'s signature.

    Both directories are PATHS IN THE STORE, and no copy is taken of them: the
    child only reads, and what it reads is a published revision — immutable by
    construction, unlike the `dev` slot `build_arguments` has to copy.

    `out_dir` is the STAGING directory of a comparison that was asked for an
    artefact, and `view` says which view the scene is of; they travel together
    or not at all, and `run_compare` refuses a call that carries one of them.
    Both are None for the measurement-only comparison, which writes nothing.
    """
    return (old_dir, new_dir), {"pid": pid, "out_dir": out_dir, "view": view}


class JobStore:
    """Every job the hub knows about, in memory and mirrored to the volume.

    One directory per job under `data/jobs/`, holding `job.json` and `log.txt`.
    A directory tree with JSON alongside, like everything else here: there is no
    database in this service and a job is read by exactly one query — by its id.

    The records are held in memory and WRITTEN THROUGH to disk rather than read
    back per request, because the readers are request threads and the writers
    are workers: a status poll must not turn into a stat and a parse. Disk is
    what survives a restart, and the restart is the one moment it is read.
    """

    def __init__(self, data_dir):
        self.root = Path(data_dir).resolve() / "jobs"
        # Workers write, request threads read. Every access to `_records` and
        # every write to the volume happens under this.
        self._lock = threading.Lock()
        # Keyed by id and read by id — the ONLY query this registry answers. The
        # dict's own ordering is incidental and nothing depends on it: a restart
        # reads the directory in whatever order the volume lists it.
        self._records: dict[str, dict] = {}
        self.root.mkdir(parents=True, exist_ok=True)
        self._load()

    # -- startup -----------------------------------------------------------
    def _load(self) -> None:
        """Read what the last run left, and fail whatever it left in flight.

        A job in `queued` or `building` at this moment is a job whose worker no
        longer exists — the pool is created empty by the process that is
        starting. Without this it stays `building` for ever, and the pusher
        polls a status that will never change while the hub that would have
        changed it is not running any more. There is nothing to resume: the
        sources were unpacked into a directory `Store._sweep_leftovers` removes.

        Every job directory is read, with no ceiling (there is no retention). A
        record `_parse_record` will not take is skipped with a warning and left
        in place.

        Only the stranded are written back: each write is two fsyncs and a
        rename, the record count is unbounded, and this runs before the socket
        is bound, against the compose `start_period` of 30 s.

        Nothing in here may raise, the listing included: an exception would stop
        the hub from starting, permanently, on the same volume.
        """
        stranded = set()
        for job_id in self._scan():
            directory = self.root / job_id
            try:
                record = _parse_record(directory / RECORD_NAME, job_id)
            except Exception as error:
                logger.warning(
                    f"{directory}: not a job record this hub can take "
                    f"({error}); skipped, and the directory is left where it "
                    f"is")
                continue
            if record["state"] in (STATE_QUEUED, STATE_BUILDING):
                record.update(state=STATE_FAILED, code=RESTART_CODE,
                              error=RESTART_ERROR, finished=utcnow_iso())
                stranded.add(job_id)
            self._records[job_id] = record
        with self._lock:
            self._rewrite_locked(stranded)
        # Counted from what is still here rather than from what was found: a
        # record the volume refused to take the failure for is not one this hub
        # is keeping.
        failed = [job_id for job_id in stranded if job_id in self._records]
        if failed:
            logger.warning(
                f"{len(failed)} build job(s) were still in flight when the hub "
                f"last stopped; they are now marked failed")

    def _scan(self) -> list:
        """The job-shaped directories under `data/jobs/` right now.

        Every one of them, without a ceiling. A symlink is not one: `create` makes every job directory with `mkdir`.
        """
        candidates = []
        try:
            with os.scandir(self.root) as entries:
                for entry in entries:
                    try:
                        looks_like_a_job = entry.is_dir(follow_symlinks=False)
                    except OSError:
                        # `DirEntry.is_dir` swallows the errors that mean "no"
                        # and raises the ones that mean "the volume would not
                        # say" — which is not a reason to refuse to start.
                        continue
                    if looks_like_a_job and SAFE_JOB_ID.match(entry.name):
                        candidates.append(entry.name)
        except OSError:
            logger.exception(
                f"the job registry in {self.root} could not be listed; this hub "
                f"starts with no job history rather than not at all")
        return candidates

    def _rewrite_locked(self, stranded: set) -> None:
        """Put the failure of every job the last stop stranded on the volume.

        Caller locks. Best effort, one record at a time, since this must not
        raise. A record that cannot be written is dropped from memory: it will
        come back stranded at the next start anyway.
        """
        for job_id in stranded:
            try:
                self._write(self._records[job_id])
            except (OSError, ValueError):
                logger.exception(
                    f"job {job_id}: its failure after the restart could not be "
                    f"written to the volume")
                self._records.pop(job_id, None)

    # -- reading -----------------------------------------------------------
    def get(self, job_id) -> dict | None:
        """One job's record, or None for an id this hub has never issued.

        A COPY, always. The record is the worker's live object; handing it to a
        request thread would be two threads on one dict, and the reader is
        about to serialize it.
        """
        if not isinstance(job_id, str) or not SAFE_JOB_ID.match(job_id):
            return None
        with self._lock:
            record = self._records.get(job_id)
            return dict(record) if record is not None else None

    def log(self, job_id) -> str | None:
        """The build log of one job. None for an unknown id, "" for no log yet.

        Read off the volume on every request rather than held in memory: a log
        runs to megabytes, the registry keeps one per push for ever, and it is
        fetched roughly once per push. Holding them all would be the volume
        deciding this process's resident size.
        """
        if not isinstance(job_id, str) or not SAFE_JOB_ID.match(job_id):
            return None
        with self._lock:
            if job_id not in self._records:
                return None
        try:
            raw = (self.root / job_id / LOG_NAME).read_bytes()
        except OSError:
            # Queued, still building, or ended before there was anything to
            # say. An empty log is the honest answer; a 404 would mean the job
            # does not exist, which is a different thing entirely.
            return ""
        return raw.decode("utf-8", errors="replace")

    # -- writing -----------------------------------------------------------
    def create(self, pid: str, commit: str) -> dict:
        """Register a queued job and return its record."""
        job_id = secrets.token_urlsafe(JOB_ID_BYTES)
        record = {
            "id": job_id,
            "pid": pid,
            "commit": commit,
            "state": STATE_QUEUED,
            "created": utcnow_iso(),
            "started": None,
            "finished": None,
            # `status` is the build's own word for how it ended
            # (`BuildOutcome.status`); `code` is the HTTP status it maps to,
            # saying whose problem it is.
            "status": None,
            "code": None,
            "build_url": None,
            "error": None,
            "log_truncated": False,
            "duration_seconds": None,
            # No ordering field: `created` is for readers, nothing sorts by it.
        }
        with self._lock:
            directory = self.root / job_id
            # `exist_ok=False`: 128 bits of id do not collide, and if one ever
            # did, silently sharing a directory with another job is the worst
            # possible way to find out.
            directory.mkdir(parents=True, exist_ok=False)
            # The volume first, `_records` second: the one write here that is
            # not best effort. On failure the push gets a 500 and the id never
            # leaves this method, so nothing may stay behind in memory or on
            # disk.
            try:
                self._write(record)
            except BaseException:
                shutil.rmtree(directory, ignore_errors=True)
                raise
            self._records[job_id] = record
        return dict(record)

    def start(self, job_id: str) -> None:
        """A worker picked this job up."""
        with self._lock:
            record = self._records.get(job_id)
            if record is None:
                return
            record.update(state=STATE_BUILDING, started=utcnow_iso())
            self._write(record)

    def finish(self, job_id: str, *, state: str, code: int, status=None,
               build_url=None, error=None, log=None, log_truncated=False,
               duration_seconds=None) -> None:
        """The job is over, one way or the other.

        Nothing here may leave the job without its terminal state: a job stuck
        `building` is polled forever, and its build may be published. So the
        in-memory record (what every poll is served from) is updated whatever
        the volume does, and both disk writes are best effort.

        `log` is written before the record is updated, so a finished job never
        shows an empty log; a log that cannot be written (e.g. ENOSPC on a
        megabyte) does not take the state with it.

        It is written outside the lock: every status poll takes `_lock`, and an
        fsync of up to MAX_LOG_BYTES must not block them.

        When the record cannot be written, memory wins until the next start.
        """
        with self._lock:
            # Only to decide whether there is a job to write a log for. Doing it
            # under the lock and then letting go is what keeps this from creating
            # a `log.txt` — and with it a directory — for an id that was never
            # issued.
            if job_id not in self._records:
                return
        if log is not None:
            try:
                self._write_log(job_id, log)
            except (OSError, ValueError):
                # The same pair `_write` is guarded with, and for the same
                # reason: the caller must not be able to lose a job's terminal
                # state to a failure in a file that is only evidence. OSError is
                # the volume; ValueError is everything the encode-and-write path
                # can raise that is not — an already-closed file object, a bad
                # path.
                logger.exception(
                    f"job {job_id}: its build log could not be written; the "
                    f"job is finished regardless")
        with self._lock:
            record = self._records.get(job_id)
            if record is None:
                # Gone between the two sections above; nothing here removes a
                # live record, but this path must not raise.
                return
            record.update(state=state, code=code, status=status,
                          build_url=build_url, error=error,
                          log_truncated=bool(log_truncated),
                          # A duration of NaN or infinity is one `json.dumps`
                          # here will not write and `json.dumps` in app.py WILL
                          # — as the bare literal `NaN`, which is not JSON.
                          duration_seconds=_number(duration_seconds),
                          finished=utcnow_iso())
            try:
                self._write(record)
            except (OSError, ValueError):
                logger.exception(
                    f"job {job_id}: its record could not be written to the "
                    f"volume; the status served from memory is the true one "
                    f"until the hub restarts")

    # -- disk --------------------------------------------------------------
    def _write(self, record: dict) -> None:
        atomic_write_bytes(
            self.root / record["id"] / RECORD_NAME,
            _record_bytes(record),
            # The temporary file goes in the DATA ROOT, not in the job's own
            # directory: same filesystem, so the rename is still a rename, and
            # a leftover from a write this process was killed in the middle of
            # lands where `Store._sweep_leftovers` collects `.wip-` names. That
            # sweep walks the data root and the project directories, and
            # neither `data/jobs/` nor a job directory is one of them.
            tmp_dir=self.root.parent)

    def _write_log(self, job_id: str, log: str) -> None:
        atomic_write_bytes(self.root / job_id / LOG_NAME, _capped_log(log),
                           tmp_dir=self.root.parent)


class BuildQueue:
    """A bounded queue of pushes and the threads that build them.

    Threads rather than processes, and that is not a compromise: the build
    ITSELF already runs in a process of its own (`src.buildproc.run_build`), so
    a worker here spends its life waiting on `waitid` and then moving a
    directory. What it must not do is run in a request thread, which is the
    whole reason this class exists.
    """

    # `workers` and `queue_size` are for tests only (a one-worker pool with a
    # queue of one makes a full queue observable). Made configurable, they
    # belong in `Settings`.
    def __init__(self, store, jobs: JobStore, *, build_runner=None,
                 compare_runner=None,
                 workers=MAX_CONCURRENT_BUILDS, queue_size=MAX_QUEUED_JOBS):
        self._store = store
        self._jobs = jobs
        # Injected rather than imported at the call site so a test can drive
        # the whole pipeline without CadQuery, a subprocess or a real model —
        # none of which this class is about.
        self._run_build = run_build if build_runner is None else build_runner
        # The same seam for the other kind of task. Separate from the builder
        # rather than one runner told which job it is doing: a test that
        # substitutes both is what shows a comparison did not go to the builder.
        self._run_compare = (run_compare if compare_runner is None
                             else compare_runner)
        self._queue: queue.Queue = queue.Queue(maxsize=queue_size)
        self._worker_count = max(1, int(workers))
        self._workers: list[threading.Thread] = []
        self._stopping = threading.Event()
        # Which jobs a drain has taken back out of the queue, so `submit` can ask
        # rather than deduce. Written by `_drop_queued`, read by `submit`, and
        # bounded by MAX_QUEUED_JOBS: only a stopping pool ever drains, and a
        # pool stops once.
        self._dropped: set[str] = set()
        self._dropped_lock = threading.Lock()

    def start(self) -> None:
        for index in range(self._worker_count):
            thread = threading.Thread(
                target=self._serve, name=f"{WORKER_THREAD_PREFIX}-{index}",
                daemon=True)
            thread.start()
            self._workers.append(thread)

    def submit(self, task: BuildTask | CompareTask) -> str:
        """Hand a push to the pool. One of the three SUBMIT_ constants.

        Checked on both sides of the insertion: a request thread can run through
        a shutdown (`daemon_threads = True`), and a task put down after the
        drain would sit in a queue no worker reads, with its sources left for a
        sweep that skips anything younger than four hours.

        After the insertion, a refusal is reported only for a task the drain
        recorded in `_dropped`. A task not there went to a worker, which owns it
        and its tree, so the pusher gets 202 for a build that is running.

        SUBMIT_STOPPED carries its own answer: the job has already been failed,
        by the drain or below. The caller must not answer it again.
        """
        if self._stopping.is_set():
            # Never queued at all, so nothing else will ever answer this job.
            # Said here rather than left to the caller so that SUBMIT_STOPPED
            # means one thing on both paths.
            self._jobs.finish(task.job_id, state=STATE_FAILED,
                              code=RESTART_CODE, error=STOPPED_ERROR)
            return SUBMIT_STOPPED
        try:
            self._queue.put_nowait(task)
        except queue.Full:
            return SUBMIT_QUEUE_FULL
        if self._stopping.is_set():
            # Drained here as well as in `shutdown`: whichever runs second finds
            # this task. The shared `_dropped` record is checked, since
            # `shutdown`'s drain may have taken this task.
            drained = True
            try:
                self._drop_queued()
            except Exception:
                # Wrapped as in `shutdown`: escaping would be a 500 and leave
                # the job `queued` forever.
                drained = False
                logger.exception(
                    f"job {task.job_id}: the queue could not be drained after "
                    f"the stop began")
            with self._dropped_lock:
                if task.job_id in self._dropped:
                    return SUBMIT_STOPPED
            if not drained:
                # The drain did not finish, so the task may be in a dead queue
                # rather than with a worker. Fail the job: a permanently
                # `queued` job is worse than removing a tree the stop would
                # abandon anyway.
                self._jobs.finish(task.job_id, state=STATE_FAILED,
                                  code=RESTART_CODE, error=STOPPED_ERROR)
                return SUBMIT_STOPPED
        return SUBMIT_ACCEPTED

    def queued(self) -> int:
        """How many tasks are waiting for a worker right now."""
        return self._queue.qsize()

    def shutdown(self) -> None:
        """Stop the workers, drop what is still queued, wait for the rest.

        Whatever is still queued is DROPPED rather than built: waiting for the
        queue would make a stop take as long as everything in it put together,
        and the container is not given that long anyway. But dropping it is a
        job of its own, not the absence of one, because each of those tasks OWNS
        a source tree (`prereceive` hands ownership over with the task) and the worker that would have removed it is not going to run.
        So this removes the tree and answers the job.

        Not left to `Store._sweep_leftovers`: it skips entries younger than
        LEFTOVER_MAX_AGE_SECONDS (four hours), while a container restarts in
        seconds.

        The drain and the joins share one budget, started before the drain (see
        WORKER_JOIN_SECONDS and WORKER_JOIN_FLOOR_SECONDS).
        """
        self._stopping.set()
        # Started before the drain: see WORKER_JOIN_SECONDS.
        deadline = time.monotonic() + WORKER_JOIN_SECONDS
        try:
            dropped = self._drop_queued()
            if dropped:
                logger.warning(
                    f"{len(dropped)} queued build(s) were dropped by the stop; "
                    f"their sources are gone and their jobs say to push again")
        except Exception:
            # Escaping would skip the joins below and leave a worker
            # mid-publish to be SIGKILLed.
            logger.exception(
                "the queued builds could not all be dropped by the stop")
        # ONE deadline for the pool, not a timeout each: see WORKER_JOIN_SECONDS.
        # Pushed out to the floor if the drain left less than that, so a slow
        # volume cannot turn the join into a no-op — see WORKER_JOIN_FLOOR_SECONDS.
        #
        # The floor is capped by the budget, so it can rescue a starved join but
        # never lengthen the configured stop.
        deadline = max(deadline, time.monotonic()
                       + min(WORKER_JOIN_FLOOR_SECONDS, WORKER_JOIN_SECONDS))
        for thread in self._workers:
            thread.join(timeout=max(0.0, deadline - time.monotonic()))
            if thread.is_alive():
                # Said out loud because the process is about to carry on as if
                # the pool were gone: this thread is still holding a staging
                # directory and may still rename it into place.
                logger.warning(
                    f"{thread.name} did not stop within the stop budget "
                    f"({WORKER_JOIN_SECONDS}s, shared by the pool and by the "
                    f"queue drain before it) and is still building")
        self._workers = []

    def _drop_queued(self) -> set:
        """Empty the queue, taking each task's sources with it. -> whose jobs.

        A task that never reached a worker is answered here rather than left to
        `_load` at the next start: this is the last moment the hub can tell the
        pusher anything at all, and "the queue was dropped" is something it
        knows now. A worker racing this for the same task cannot lose — the
        queue hands one item to exactly one caller.

        Returns job ids, not a count. They also go into `self._dropped`, which
        `submit` reads to know whether any drain took its task (as opposed to a
        worker).
        """
        dropped = set()
        while True:
            try:
                task = self._queue.get_nowait()
            except queue.Empty:
                return dropped
            # Recorded before the removal: from here this call owns the task.
            dropped.add(task.job_id)
            with self._dropped_lock:
                self._dropped.add(task.job_id)
            try:
                # A comparison owns no tree and no body: both revisions are in
                # the store and stay there. Only the job has to be answered.
                if not isinstance(task, CompareTask):
                    shutil.rmtree(task.sources, ignore_errors=True)
                self._jobs.finish(task.job_id, state=STATE_FAILED,
                                  code=RESTART_CODE, error=STOPPED_ERROR)
            finally:
                # Balanced with the `get_nowait` above, so the queue's own
                # counter stays honest for anything that ever joins it.
                self._queue.task_done()

    # -- the worker --------------------------------------------------------
    def _serve(self) -> None:
        while not self._stopping.is_set():
            try:
                task = self._queue.get(timeout=WORKER_POLL_SECONDS)
            except queue.Empty:
                continue
            try:
                # ON THE TYPE OF THE TASK, because the two are different work
                # with different endings: one publishes a tree and owns it, the
                # other reads two published ones and owns nothing.
                if isinstance(task, CompareTask):
                    self._compare_and_record(task)
                else:
                    self._build_and_publish(task)
            except Exception:
                # Nothing below is supposed to raise — it all ends in a job
                # record — but a worker that dies takes a build slot with it
                # for the life of the process, so the loop keeps going and says
                # what happened.
                logger.exception(f"build worker failed on job {task.job_id}")
            finally:
                self._queue.task_done()

    def _build_and_publish(self, task: BuildTask) -> None:
        """Run one build and publish what it produced.

        THE OUTPUT DIRECTORY IS THE STAGING DIRECTORY. The build writes straight
        into the `.tmp-` directory that is later renamed onto `<pid>/<commit>`,
        so a successful build leaves a tree holding its own meta.json — which is
        exactly the shape the publishing half already knew how to take. That is
        what lets `_finish_staging`, the atomic rename, `latest` and the pickers
        stay as they are.

        The SOURCES are a different directory, and deliberately: the model must
        not be able to put anything into the tree that gets published except by
        writing it as build output.
        """
        # Everything is inside the try, so no exception escapes before `finish`
        # (even the staging `mkdir` can fail on a full volume).
        staging = None
        outcome = None
        verdict = None
        try:
            self._jobs.start(task.job_id)
            if task.commit == DEV_LINK and task.variant == MAIN_BRANCH:
                # Set at the start, so the front page can show `building` or
                # `failed`; the slot's meta.json records a job only on publish.
                # Guarded: a failed write costs the front-page chip, not the
                # build. The default variant's draft only: the card shows that
                # variant, and another's would light its chip.
                try:
                    self._store.set_draft_job(task.pid, task.job_id)
                except Exception:
                    logger.exception(
                        f"job {task.job_id}: {task.pid}'s draft pointer could "
                        f"not be written; the front page will not show this "
                        f"build until it finishes")
            staging = self._store.build_staging(task.pid, task.commit)
            # The variant's label and the documents project.json lists,
            # checked before anything runs: a wrong one is a 422 now rather
            # than after a model's build.
            label = docsbuild.variant_label(task.sources)
            documents = docsbuild.declared_documents(task.sources)
            if documents and not docsbuild.has_model(task.sources):
                # Files to read, not a model to run: nothing from the tree is
                # executed, so no build process (`src/docsbuild.py`).
                outcome = docsbuild.run_documents_build(
                    task.sources, staging, documents, pid=task.pid)
            else:
                # The names project.json gives the model's views, checked
                # before the build like the label and the documents.
                view_names = docsbuild.view_names(task.sources)
                # The baseline is looked up here: the build process gets a copy
                # of the file, not access to the store. None for a first build.
                # The slot of the build's own variant, so a variant measures
                # itself against itself and not against the default one.
                args, keywords = build_arguments(
                    task.sources, staging, task.pid, force=task.force,
                    baseline=self._store.dev_metrics_path(task.pid,
                                                          task.variant),
                    distance_cache=self._store.distance_cache_path(task.pid))
                outcome = self._run_build(*args, **keywords)
                if outcome.ok:
                    docsbuild.name_views(staging, view_names)
                if outcome.ok and documents:
                    outcome = docsbuild.add_documents(
                        task.sources, staging, documents, outcome)
            if outcome.ok:
                # The job id goes into meta.json so `hammerola log dev` can read
                # the build's log back. Both routes fill the slot (a commit
                # mirrors itself into it), so both carry it. A revision keeps
                # its log in its own directory, renamed into place with it.
                if task.commit == DEV_LINK:
                    status, payload = self._store.publish_dev_built(
                        task.pid, staging, outcome.files, task.digest,
                        job=task.job_id, variant=task.variant,
                        variant_label=label, forced=task.force)
                else:
                    (staging / BUILD_LOG_FILE).write_bytes(
                        _capped_log(outcome.log))
                    status, payload = self._store.publish_built(
                        task.pid, task.commit, staging, outcome.files,
                        task.digest, job=task.job_id, message=task.message,
                        variant=task.variant, variant_label=label,
                        forced=task.force)
                logger.info(
                    f"job {task.job_id}: published {task.pid}/{task.commit} "
                    f"-> {payload['url']}")
                verdict = {"state": STATE_DONE, "code": status,
                           "build_url": payload["url"]}
            else:
                reason = BUILD_FAILURE_REASONS.get(
                    outcome.status, "the build did not finish")
                # 500 for the one status that is the HUB's fault: the ceilings
                # would not go on, which says nothing about the model. Everything
                # else is the pushed source's problem and is a 4xx, so CI can
                # tell "fix your model" from "the hub is broken" without reading
                # the log first.
                code = 500 if outcome.status == STATUS_LIMITS_ERROR else 422
                logger.warning(
                    f"build {task.pid}/{task.commit} ({task.job_id}) "
                    f"{outcome.status}: {reason}")
                verdict = {"state": STATE_FAILED, "code": code,
                           "error": f"{reason} ({outcome.status})"}
        except PublishError as error:
            # The build produced something; the hub refused to publish it. The
            # status PublishError carries is the answer the pusher gets.
            logger.warning(
                f"publish {task.pid}/{task.commit} ({task.job_id}) refused: "
                f"{error.message}")
            verdict = {"state": STATE_FAILED, "code": error.status,
                       "error": error.message}
        except Exception:
            logger.exception(f"build {task.pid}/{task.commit} failed")
            verdict = {"state": STATE_FAILED, "code": 500,
                       "error": "internal error"}
        finally:
            # Both trees, on every path. `staging` is gone already when the
            # publish renamed it into place, which is what `ignore_errors`
            # covers; on every other path it is a half-built tree nothing will
            # ever look at again. None when the failure came before there was a
            # directory to name.
            shutil.rmtree(task.sources, ignore_errors=True)
            if staging is not None:
                shutil.rmtree(staging, ignore_errors=True)

        # After the cleanup: a poller that reads `done` may assume the hub has
        # finished with the push.
        try:
            self._jobs.finish(
                task.job_id,
                status=None if outcome is None else outcome.status,
                log=None if outcome is None else outcome.log,
                log_truncated=False if outcome is None else outcome.log_truncated,
                duration_seconds=(None if outcome is None
                                  else outcome.duration_seconds),
                **verdict)
        except Exception:
            # `finish` should not raise; if it does, this must not be logged as
            # a failed build, which may already be published.
            logger.exception(
                f"job {task.job_id}: could not record how the build ended")

    def _compare_and_record(self, task: CompareTask) -> None:
        """Compare two published revisions and record what came back.

        The sibling of `_build_and_publish`, and shorter by everything that
        method is careful about: nothing is unpacked and nothing is unmade at
        the end. THE LOG IS ALWAYS THE PRODUCT — the child prints its report to
        stdout, the runner captures it, and this files it under the job so
        `hammerola diff --material` can read it back. The log is the same
        whichever mode this ran in, deliberately: the artefact is an addition to
        the report and not a replacement for it.

        A TASK CARRYING A VIEW ALSO PUBLISHES, and the shape is the build path's
        one step down: a staging directory from the store, the child writing
        into it, and one rename once the run came back ok. A job that produced
        no artefact must leave no cache entry at all — a half-written one is a
        comparison page that loads a scene of nothing — so the staging directory
        is removed on every path that did not rename it away.

        The first line is written here, not by the child, so the log names both
        revisions even when the child crashed (the job record carries only the
        newer one).
        """
        outcome = None
        verdict = None
        staging = None
        try:
            self._jobs.start(task.job_id)
            if task.view is not None:
                staging = self._store.compare_staging(
                    task.pid, task.old, task.new, task.view)
            # Both were validated by the request and both exist — it checked
            # that too — and neither can change under this call, a published
            # revision being immutable.
            args, keywords = compare_arguments(
                self._store.build_dir(task.pid, task.old),
                self._store.build_dir(task.pid, task.new),
                task.pid, out_dir=staging, view=task.view)
            outcome = self._run_compare(*args, **keywords)
            if outcome.ok:
                if staging is not None:
                    self._store.publish_compare(
                        task.pid, task.old, task.new, task.view, staging)
                    # Consumed by the rename, so the cleanup below has nothing
                    # left to remove — and must not go looking for it.
                    staging = None
                verdict = {"state": STATE_DONE, "code": 200}
            else:
                # 500 FOR EVERY WAY THIS ENDS BADLY, unlike the build path. Both
                # inputs are revisions this hub built and published itself, so
                # there is no push to blame: a comparison that crashed, hung or
                # ran out of its ceilings is the hub's own problem, and saying
                # 422 would send somebody looking for a mistake in their model.
                logger.warning(
                    f"compare {task.pid} {task.old} -> {task.new} "
                    f"({task.job_id}) {outcome.status}")
                verdict = {
                    "state": STATE_FAILED, "code": 500,
                    "error": f"the comparison did not finish ({outcome.status})"}
        except Exception:
            logger.exception(
                f"compare {task.pid} {task.old} -> {task.new} failed")
            verdict = {"state": STATE_FAILED, "code": 500,
                       "error": "internal error"}
        finally:
            # Whatever the comparison did NOT publish. None on the two paths
            # where there is nothing to remove: no artefact was asked for, or
            # the rename already took the directory.
            if staging is not None:
                shutil.rmtree(staging, ignore_errors=True)

        log = f"comparing {task.pid}: {task.old} -> {task.new}\n"
        if outcome is not None:
            log += outcome.log
        try:
            self._jobs.finish(
                task.job_id,
                status=None if outcome is None else outcome.status,
                log=log,
                log_truncated=False if outcome is None else outcome.log_truncated,
                duration_seconds=(None if outcome is None
                                  else outcome.duration_seconds),
                **verdict)
        except Exception:
            # The same last line as the build path has, and it is here for the
            # same reason: a job that never reaches a terminal state is a status
            # somebody polls for ever.
            logger.exception(
                f"job {task.job_id}: could not record how the comparison ended")


def _capped_log(log: str) -> bytes:
    """One build log as bytes, cut to MAX_LOG_BYTES with a note if it did not fit.

    The ceiling is derived to fit the worst case a build can hand over (see
    MAX_LOG_BYTES), so the cut is unreachable for a log this hub captured; it is
    what keeps the file inside the ceiling anyway on the day either number moves.

    One function for both copies of the log (the job's and the one in a
    revision's directory), so they share one ceiling.
    """
    raw = log.encode("utf-8", errors="replace")
    if len(raw) <= MAX_LOG_BYTES:
        return raw
    note = LOG_TRUNCATED_NOTE.encode("utf-8")
    # A slice of UTF-8 bytes is not necessarily UTF-8: the cut can land inside a
    # multi-byte sequence. Decoding with `errors="ignore"` and encoding back
    # drops exactly that stump, so what is stored is always something a reader
    # can decode.
    return (raw[:MAX_LOG_BYTES - len(note)]
            .decode("utf-8", errors="ignore").encode("utf-8")) + note


def _record_bytes(record: dict) -> bytes:
    """One record as this module writes it. The ONLY spelling of that."""
    return json.dumps(record, indent=1, ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def _parse_record(path: Path, job_id: str) -> dict:
    """One `job.json` taken as it is; raises with the reason it is not one.

    Three rules, each one a record no other rule here could cope with: not an
    object; an `id` other than the directory's name, which points one job's
    record at another job's log (`job_id` passed SAFE_JOB_ID in `_scan`, so an
    id equal to it is a string of that shape too); a `state` outside
    KNOWN_STATES, which `_load` never fails and no client has a branch for.
    """
    record = json.loads(path.read_bytes())
    if not isinstance(record, dict):
        raise ValueError("it is not a JSON object")
    if record.get("id") != job_id:
        raise ValueError("its id is not the name of its directory")
    if record.get("state") not in KNOWN_STATES:
        raise ValueError("its state is not one this hub writes")
    return record


def _number(value) -> float | None:
    """A FINITE number, or None — which is what NaN and Infinity become here.

    `finish` normalizes through it, so a runner that ever reported a non-finite
    duration cannot put one in a record the hub then fails to write, nor in a
    JSON body served to a client (`json.dumps` defaults to writing the bare
    literal `NaN`, which no strict parser accepts).
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None
