#!/usr/bin/env python3
"""The asynchronous half of a push: a job to follow, and a pool to build it in.

A push used to be one HTTP request from end to end — receive, unpack, publish,
201 — and that worked only because the hub did no arithmetic: it took a finished
artefact and moved it into place. Now the hub BUILDS what it was pushed (SPEC
8A.2 steps 4 and 5), and a CadQuery build is minutes, not milliseconds. It does
not fit in a request: the socket timeout is 30 s, the body deadline is 300 s,
and a `ThreadingHTTPServer` spends one thread per connection for the whole of it.
So the request stops at "I have your sources", and everything after that is a
JOB.

    JobStore    the registry: one directory per job under data/jobs/, with the
                record in job.json and the build log beside it in log.txt
    BuildTask   what the request hands over: a job id, an unpacked tree and the
                pushed body it came out of
    CompareTask the other kind of work on the same pool: two PUBLISHED revisions
                to measure against each other, owning nothing and publishing
                nothing — its product is the log
    BuildQueue  the pool: a bounded queue and N worker threads that run the
                build and then publish its output

WHAT THE PUSHER GETS OUT OF THIS, and why it is the point rather than a
consolation prize: `GET /api/v1/jobs/<id>/log` is the replacement for the job
log in Gitea. Until now the model was built by a CI runner, so when it failed
the person who pushed read the runner's log. Building on the hub takes that away
and nothing replaces it by itself — a 500 with no text is not a build system.

THE LOG IS WRITTEN BY THE PARENT, from `BuildOutcome.log`, and never by the
build process itself. `src/buildproc/__init__.py` is explicit that nothing the
build process says is believed; a log file the child appended to directly would
be a file of arbitrary size and arbitrary content, written by the model, under a
name the hub then serves. What the parent captures is already capped and already
decoded (`runner._Drain`), so writing it here is the only place the hub is
repeating something it measured itself.

A PUBLISHED BUILD ALSO LEAVES ITS CODE BEHIND, and the worker is where that is
decided because it is the only place that knows whether a revision happened.
`_keep_the_code` hands the pushed body to the store as the code of the revision
it just published, with a second copy of this same captured log beside it
(issue #17); every other ending deletes the body. So the sources of a build that
FAILED are not kept — a stored tree belonging to no published revision is one
nothing can answer for, and the author is looking at that failure with the tree
still on their own disk.

WHAT A START READS BACK IS PARSED, NOT REBUILT. A record is taken when it is a
JSON object whose `id` is its directory's name and whose `state` is one of
KNOWN_STATES; anything else is skipped with a warning naming the directory, and
the directory stays where it is. The hub does not write a torn record
(`atomic_write_bytes`) or a non-finite number (`finish` goes through `_number`),
so what fails the parse is a hand edit, a failing disk, a hub killed between
`create`'s `mkdir` and its write, or a model's mistake on a volume every build
can write (`src/buildproc/__init__.py`) — none of them a
reason to keep the hub from starting, or to delete what somebody may want to
look at.

THE ONLY RECORDS A START WRITES are the jobs a restart stranded `queued` or
`building`: each is failed with RESTART_CODE, and that failure has to reach the
volume, or every later start finds it in flight again and warns about it again.
Every other record is left on the volume exactly as it is.

NO JOB IS EVER DELETED BECAUSE OF ITS AGE OR ITS NUMBER (decision of 2026-08-27,
SPEC 5.3 and 7.4). There is no count ceiling and no age ceiling on the registry:
a record and its log stay until somebody removes the directory, and so does a
directory whose record a start could not take. A ceiling on the NUMBER of jobs
is a decision about which of the pusher's builds to destroy, and this module
does not make one.

BUILD PARALLELISM IS ITS OWN NUMBER, deliberately not `MAX_CONCURRENT_PUBLISHES`.
The four accept slots in app.py are sized by what RECEIVING costs — a body on
disk, a tar reader, a staging tree — and a build is sized by memory and by how
long one hung build may hold a worker. Since 2026-09-09 both numbers happen to
read four, and that is a COINCIDENCE of two independent decisions rather than a
link — only ONE of the two is a measurement (this one, issue #80); the accept
slots are an argument about a body on disk and CI retries, and nobody has ever
measured them. Sharing one number would mean the day either ceiling is retuned,
the other moves with it for no reason anybody could reconstruct.

NOTHING IN THIS MODULE IS MODULE-LEVEL STATE. `JobStore` and `BuildQueue` are
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
from src.store import (DEV_LINK, PublishError, atomic_write_bytes,
                       utcnow_iso)

# -- what a job can be -------------------------------------------------------
# `queued` and `building` are the two states a restart can strand, which is why
# they are separate: a job that never reached a worker and one that was killed
# half way through are the same to the pusher but not to whoever reads the log.
STATE_QUEUED = "queued"
STATE_BUILDING = "building"
STATE_DONE = "done"
STATE_FAILED = "failed"

# The two a poller may stop on. Nothing inside this module reads it any more —
# no rule here selects jobs by whether they have finished — but it is the wire
# contract `hammerola/hub.py` mirrors, so it is stated once, here, on the side
# that issues the states.
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

# THE REGISTRY OWNS NO FILE OF ITS OWN, and the one it used to own is worth
# naming here so the question is not reopened: `data/jobs/order.json` held the
# ids of every job, oldest first, because RETENTION counted by creation order
# and had to decide which end to drop. Retention is gone (see the module
# docstring), and with it the order's only reader — the two job endpoints look a
# record up by id, nothing lists jobs, and a restart no longer has to reproduce
# a sequence. So the order is not written, not read and not reconstructed.
#
# What the order file taught still holds: anything that is a property of the
# SET of records must not be stored per record. Reintroducing such a field is
# what would bring the file back, and it would have to come back as one atomic
# rename rather than as a number in each `job.json`.

# DERIVED from the build's own log ceiling rather than picked, because the two
# are not counted in the same bytes and the difference is a factor of three.
# `runner._Drain` keeps `Limits.log_bytes` (1 MiB) of RAW output and decodes it
# with `errors="replace"`: every byte that is not valid UTF-8 becomes U+FFFD,
# which encodes BACK to three bytes. So a model printing binary — exactly the
# build whose log somebody needs — makes the hub write up to three times the
# ceiling the build ran under, and a smaller number here would cut the build's
# own log. Move `Limits.log_bytes` and this moves with it; `tests/test_jobs.py`
# pins the relation by writing the worst case.
MAX_LOG_BYTES = 3 * Limits.log_bytes
LOG_TRUNCATED_NOTE = "\n[truncated by the hub: this log is larger than it should be]\n"

# How many builds may run at once.
#
# MEASURED on the deployed hub, 2026-09-09, and raised from two: 145 real jobs on
# a 20-core host sitting at a load average of 0.6. What the measurement says is
# that this number buys no SPEED — a build is effectively single-threaded, the
# cores idle through it, and widening the OCCT pool from 2 to 8 bought about 7%.
# What it buys is ISOLATION. Every serious queue wait in those jobs — up to 513 s
# — came from TWO HUNG BUILDS holding both workers for 891 s each, so the queue
# was starved by two bad builds rather than by a hub that could not keep up. More
# workers do not make one build finish sooner; they stop one bad project from
# starving everybody else.
#
# MEMORY is what bounds it, not cores. The one figure actually measured is
# ~450 MB resident right after `import cadquery` (buildproc/limits.py), which is
# a FLOOR and not a peak — the model's geometry is on top of it, by an amount
# nobody has measured. Four builds at that floor are 1.8 GB against the ~12 GB
# the host has free, so the headroom carries a working set several times the
# floor. The next move comes from another measurement, not from first principles.
MAX_CONCURRENT_BUILDS = 4

# How many pushes may be WAITING for a worker. Bounded on purpose: an unbounded
# queue turns a hub that cannot keep up into a hub that accepts everything,
# holds an unpacked source tree per entry, and reports success to CI for work it
# will get to in an hour. Refusing with a 503 tells the truth immediately, and
# 503 plus Retry-After is something CI already knows how to handle.
MAX_QUEUED_JOBS = 16
QUEUE_FULL_RETRY_AFTER_SECONDS = 60
# Written down once, beside the other two sentences a refused push can be given,
# because it goes to two places that must not drift: the HTTP body and the job
# record. A pusher who reads the 503 and then polls the job has to find the same
# reason in both.
QUEUE_FULL_ERROR = "the build queue is full, retry later"

# What `BuildQueue.submit` answers, and why it is three words rather than a
# boolean. A refusal has two entirely different causes — a full queue and a hub
# on its way out — and they need different things said to the pusher AND
# different things done to the job: a full queue leaves the job untouched for
# the caller to fail, while a stop has already answered it. Told apart by asking
# whether the pool is stopping, they were told apart WRONG, because the flag is
# set on the way out of a hub whose queue may also be full.
SUBMIT_ACCEPTED = "accepted"
SUBMIT_QUEUE_FULL = "queue-full"
SUBMIT_STOPPED = "stopped"

# The name every worker thread carries. Tests assert on it — a pool that is not
# shut down is otherwise invisible until an unrelated test hangs.
WORKER_THREAD_PREFIX = "hammerola-build"

# How long the POOL — all of it, not one worker — is given to finish what it is
# DOING when the hub is stopped, which is not the same as finishing its BUILD,
# and the difference is the whole reason this is not `Limits.wall_seconds`.
#
# What is worth waiting for is the PUBLISH: `os.rename` onto `<pid>/<commit>` and
# the pointer writes right after it, which together are milliseconds. Being
# killed in the middle of that is how a build ends up on disk with `latest`
# pointing somewhere else.
#
# Waiting out a BUILD instead would be waiting for something that is not going to
# be allowed to finish. A build may run to `wall_seconds` (300 s), and the
# compose file declares no `stop_grace_period`, so docker sends SIGKILL 10 s after
# its SIGTERM whatever this number says. A join longer than that grace period
# therefore saves no build — it just converts every ordinary stop into a SIGKILL,
# which is the abrupt ending the join exists to avoid. So: deliberately UNDER the
# grace period, and spent by the whole pool between them.
#
# A BUDGET FOR THE POOL and not a timeout per worker, which is the version of
# this that looks identical and is not. `shutdown` joins the workers one after
# another, so a per-worker timeout is multiplied by however many are busy: at
# MAX_CONCURRENT_BUILDS = 4 a busy pool would spend 4 x 5 s = 20 s on the joins
# alone, TWICE the whole grace period, before the queue drain and before
# `serve_forever` has even noticed the stop (it polls). The number meant to keep
# an ordinary stop away from SIGKILL would then be what guarantees one — and it
# gets worse every time the pool grows, as it did on 2026-09-09 when this number
# went from two to four without the stop moving at all. So the joins share one
# deadline.
#
# A build still computing is abandoned. Its job is marked failed by `_load` at the
# next start, and it leaves TWO directories behind, not one: the unpacked sources
# (`.src-...`, at the root of the data directory) and the output staging
# (`.tmp-...`, inside the project, and usually the larger of the two because it
# holds whatever the build had written by then). Both wait for
# `Store._sweep_leftovers` at a later start. The QUEUED tasks' sources are not
# among them — `shutdown` removes those itself.
#
# THE DRAIN COMES OUT OF THIS BUDGET, not out of nowhere. It is the first thing
# `shutdown` does and it is real work on the same volume the joins are waiting
# for: up to MAX_QUEUED_JOBS unpacked source trees to remove and a job record to
# write, with an fsync, for each. Started after it, the clock would say 5 s while
# a real stop cost the drain PLUS 5 s — and this number is sized to keep the stop
# under docker's 10 s grace period, so the difference is a SIGKILL landing inside
# the join the number exists to protect.
WORKER_JOIN_SECONDS = 5

# ...but the joins never get nothing, whatever the drain spent. A stop that had
# used the whole budget dropping trees would join for zero seconds, which is the
# abrupt ending the join is here to avoid: a worker at that moment is holding a
# staging directory and may be between the rename and the pointer writes.
#
# So the stop is bounded by max(WORKER_JOIN_SECONDS, drain + this) rather than by
# WORKER_JOIN_SECONDS alone, and that is the honest statement: the DRAIN itself
# is not cut short. It cannot be — abandoning it half way would leave exactly the
# unpacked trees and the unanswered jobs it exists to collect, which is the state
# `Store._sweep_leftovers` cannot find anything in for an hour. What this bounds
# is the stop's own WAITING, which is the part a clock can decide.
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

# ...and the third of that family: the hub threw BETWEEN creating the job and
# handing it to the pool, so nothing downstream exists to answer it. A narrow
# window — `create` returns, `submit` is the next statement — and the invariant
# at the top of `finish` has no window in it, deliberately. A job left `queued`
# is the one state nothing here can reclaim: only a restart's `_load` ever fails
# one, so until then the status endpoint goes on saying `queued` about a build
# that does not exist. Used by `app._queue_build`, which is the only place that
# gap is.
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
    """One push, handed from the request thread to a worker.

    `sources` is an unpacked tree the request already validated (SPEC 7.1) and
    the worker OWNS: it is removed when the job ends, whichever way it ends.
    `digest` is of those sources and travels with the task because it is what
    tells an identical retry from a colliding one, and it has to be the same
    number the request compared against.

    `archive` is the request body the tree came out of, owned exactly the same
    way and removed at the same moment — with one exception, which is the point
    of carrying it at all: a build that PUBLISHES gives it to the store instead,
    and it becomes the code of that revision (issue #17). Everything else
    deletes it, so the sources of a build that failed are never kept.

    `force` is the one field about HOW to build rather than about what was
    pushed: the push asked for the model's own checks() to be skipped (issue
    #52). It defaults to False because the absence of the request is the
    ordinary build, and because that is the direction a forgotten argument has
    to fail in — a build that runs the checks nobody asked it to skip is slow,
    and one that skips checks nobody waived is wrong.

    `message` is about NEITHER: it is what the push said this revision is (issue
    #67), and it rides here because this dataclass is the only thing that crosses
    into the build thread. The build never reads it — it is written into the
    published document on the other side — and the `dev` route ignores it, the
    slot being the working copy rather than a version of anything.
    """

    job_id: str
    pid: str
    commit: str
    sources: Path
    archive: Path
    digest: str
    force: bool = False
    message: str | None = None


@dataclass(frozen=True)
class CompareTask:
    """One comparison of two PUBLISHED revisions, handed to a worker.

    Nothing here is owned the way a `BuildTask`'s tree is: both revisions are in
    the store, they are served over HTTP while this runs, and this task removes
    nothing when it ends. It exists for the same reason the build task does —
    the kernel may not be imported in the hub's own process, so the work goes to
    a child and a worker waits for it.

    `old` and `new` are revision ids the request already validated, and they are
    what the child is pointed at. The JOB carries only `new`: `jobs.create` takes
    one commit, and the newer revision is the one a person means when they ask
    which build a job was about. Both of them are in the log's first line, which
    is the report itself.

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
                    baseline: Path | None):
    """The call the worker makes into `run_build`, written down ONCE.

    A seam nothing else in the test suite crosses: every test substitutes the
    builder, because computing geometry per test costs minutes and needs
    CadQuery. So the only thing between a parameter renamed in
    `src.buildproc.run_build` and a hub that fails on the first real push is a
    test that checks the call against that function's signature — and a test
    that spells the call out by hand stops FOLLOWING the worker the moment the
    worker changes, which is exactly the change it is there to catch. Returned
    as `(args, keywords)` so both sides use this one expression: the worker to
    make the call, the test to bind it.

    `baseline` is the published `dev` metrics.json this build compares itself
    against, or None when the project has none. It is a PATH IN THE STORE and
    the build process never opens it: `run_build` copies the file into its own
    scratch first (see there for why the copy is the correctness).
    """
    return (sources, staging), {"pid": pid, "force": force,
                                "baseline": baseline}


def compare_arguments(old_dir: Path, new_dir: Path, pid: str, *,
                      out_dir: Path | None = None, view: str | None = None):
    """The call the worker makes into `run_compare`, written down ONCE.

    The same seam as `build_arguments` and for the same reason: every test
    substitutes the runner, because a real comparison needs the CAD kernel, so
    the only thing between a parameter renamed in `src.buildproc.run_compare`
    and a hub that fails on the first real request is a test binding this
    expression against that function's signature.

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

        EVERY JOB DIRECTORY IS READ, and there is no ceiling on how many. That
        is the direct consequence of there being no retention (see the module
        docstring): a cut by count would have to choose which of the pusher's
        jobs to destroy. A record `_parse_record` will not take is skipped with
        a warning naming its directory, and the directory is left where it is.

        ONLY THE STRANDED ARE WRITTEN BACK, and the reason is the startup
        budget. One write is an `atomic_write_bytes`: two fsyncs and a rename.
        There is no retention (see the module docstring), so the number of
        records is the number of pushes over the volume's whole life rather than
        anything bounded — and this runs from `JobStore.__init__`, which runs
        from `create_server` BEFORE the socket is bound, so each of those fsyncs
        is time in which `/health` does not answer at all. At ten thousand jobs
        a write-everything pass is tens of seconds, against a `start_period` of
        30 s in the compose file and an auto-update rollback gate that gives up
        at about 120.

        NOTHING IN HERE MAY RAISE. It runs from `JobStore.__init__`, which runs
        from `create_server`, which runs from `main()` — so an exception escaping
        this loop is a hub that does not come up, and it comes up next time from
        the same volume, so it does not come up ever again. One unreadable
        directory out of two hundred is not a reason to take the service down.
        That covers the LISTING as well as the records: `_scan` goes to the same
        volume, and an EIO or an EACCES out of it is a hub that never starts
        rather than a hub that starts with no job history.
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

        EVERY one of them comes back, without a ceiling, because every one of
        them is read: no job is ever dropped for being one too many, so there is
        no number this could cut at that would not be deciding which of the
        pusher's jobs to destroy.

        A symlink is not one: `create` makes every job directory with `mkdir`.
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

        Caller locks. BEST EFFORT, one record at a time, because this runs on
        the path that must not raise — but not optional: a failure that stays
        in memory is the difference between a job that is finished and a job
        the next start finds `building` all over again, and warns about all over
        again, for the life of the volume.

        A record that cannot be written is DROPPED from memory: its failure did
        not reach the volume, so it comes back `queued` or `building` at the
        next start regardless, and keeping it here would only make this run
        disagree with the next one about a job nobody can do anything for.
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
            # (`BuildOutcome.status`); `code` is the HTTP status the push would
            # have been answered with had it stayed synchronous. Both, because
            # they answer different questions: one says what happened, the other
            # says whose problem it is — and step 6 hands the second one out.
            "status": None,
            "code": None,
            "build_url": None,
            "error": None,
            "log_truncated": False,
            "duration_seconds": None,
            # NO ORDERING FIELD, deliberately: nothing here reads jobs in the
            # order they were made, because nothing here chooses one over
            # another. `created` is a stamp for whoever is looking at the record,
            # not a key anything sorts by.
        }
        with self._lock:
            directory = self.root / job_id
            # `exist_ok=False`: 128 bits of id do not collide, and if one ever
            # did, silently sharing a directory with another job is the worst
            # possible way to find out.
            directory.mkdir(parents=True, exist_ok=False)
            # THE VOLUME FIRST, `_records` second — the one write in this class
            # that is not best effort, and the order is what makes the failure
            # leave nothing behind. `finish` can afford a volume that refuses it,
            # because the record is already in memory and memory is what every
            # status poll is answered from. Here there is nobody to serve: the
            # push is answered 500 and the id never leaves this method, so a
            # record inserted before a write that then failed would sit in
            # memory until the process ends, `queued`, for a build nobody is
            # running. The directory goes too: nothing else removes it, and
            # every later start would warn about it.
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

        NOTHING HERE MAY LEAVE THE JOB WITHOUT ITS TERMINAL STATE — that is the
        one failure this registry must not have. A job that stays `building` is
        a status the pusher polls that will never change again, and the build it
        is asking about may be published and serving: the answer after the next
        restart is then "the hub restarted, push again" about a build that
        landed. So the in-memory record, which is what every status poll is
        answered from, is updated whatever the volume does, and BOTH writes to
        disk are best effort with the failure in the log.

        `log` is still written BEFORE the record is updated, for the same reason
        the comment queue writes a photo before its record: a finished job whose
        log has not landed yet is a status somebody is polling and a log they are
        about to fetch, and the wrong order shows an empty log for a build that
        has one. What changed is that a log which cannot be written no longer
        takes the state with it — ENOSPC hits the write of a megabyte long
        before it hits the write of a 400-byte record, and it was the megabyte
        that used to abandon the job.

        IT IS WRITTEN OUTSIDE THE LOCK, and that is not a detail. `_lock` is the
        registry's only lock, so every `get` takes it — which means every status
        poll, from every pusher, of every job. Writing up to MAX_LOG_BYTES with
        an fsync inside it made one build finishing block the status endpoint for
        as long as the volume took to sync. The order the paragraph above is
        about survives regardless: what a poller sees is the IN-MEMORY record,
        and that is not touched until the log write has returned.

        When the RECORD cannot be written, memory and disk disagree until the
        next start, and memory wins on purpose: it is the one being served.
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
                # Gone between the two sections above. Nothing in this module
                # removes a live record any more, so reaching this needs
                # something outside it; it is kept because the alternative is
                # writing through `None` on a path that must not raise.
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

    # `workers` and `queue_size` ARE FOR TESTS, and only downward. Nothing
    # configures them — there is no setting and no environment variable behind
    # `create_server`'s two keyword arguments — and a test only ever wants a
    # SMALLER pool: a one-worker pool with a queue of one is what makes a full
    # queue observable. Made real numbers, they belong in `Settings`.
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

        CHECKED ON BOTH SIDES of the insertion, because a request thread runs
        straight through a shutdown: `daemon_threads = True`, so the thread
        serving a push carries on while `shutdown` drains the queue on another
        one. A task put down after that drain has gone past sits in a queue no
        worker will ever read again — and every visible consequence of that is
        wrong. The pusher is told 202 about a build nobody is going to run; the
        unpacked source tree the task owns stays on the volume, and the sweep
        that would collect it (`Store._sweep_leftovers`) runs at startup and
        skips everything younger than `store.LEFTOVER_MAX_AGE_SECONDS` — four
        hours — while a container comes back in seconds.

        WHAT THE SECOND CHECK MAY CONCLUDE is narrower than it looks, and the
        previous version of it got this wrong in a way that damaged a LIVE build.
        Seeing the flag set, it drained the queue and reported a refusal on the
        grounds that "the queue hands one item to exactly one caller, so either
        this call took it back or the drain did". There is a third holder: a
        WORKER, which may have taken this very task out of the queue and be
        inside `_build_and_publish` with it. The caller then does what a refusal
        tells it to — removes the source tree and fails the job — under a build
        that is reading that tree and is about to publish it.

        So the question is answered with the FACT rather than with the argument:
        every drain writes down which jobs it took out of the queue, and a
        refusal is reported only for a task that is in that record. A task that
        is not in it went to a worker, which owns it and its tree — and the
        pusher is told 202 about a build that is genuinely running.

        SUBMIT_STOPPED CARRIES ITS OWN ANSWER: by the time it is returned the
        job has been told the hub is stopping, either by the drain that took it
        or by the line below. The caller does not have to (and must not) invent
        one — it still owns whatever is left of the source tree, which the drain
        may already have removed.
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
            # Drained here as well as in `shutdown`, because whichever of the two
            # runs second is the one that finds this task. Then the shared record
            # rather than this call's own return value: `shutdown`'s drain may
            # have taken this very task a moment ago, and asking only what THIS
            # call took would read that as "a worker has it" and answer 202 for a
            # job the stop has already failed.
            drained = True
            try:
                self._drop_queued()
            except Exception:
                # Wrapped for the same reason `shutdown` wraps its own call to
                # this, and the reason applies here one for one: the drain is a
                # loop over directories and job records on a volume this module
                # gets to assume nothing about. Escaping, it would come out of
                # the request handler as a 500 AND leave the task sitting in a
                # queue no worker will read again — so the job stays `queued`
                # for ever, which is the one state nothing here can reclaim
                # without a restart.
                drained = False
                logger.exception(
                    f"job {task.job_id}: the queue could not be drained after "
                    f"the stop began")
            with self._dropped_lock:
                if task.job_id in self._dropped:
                    return SUBMIT_STOPPED
            if not drained:
                # "Not in `_dropped`" normally means a WORKER has the task, and
                # answering a refusal for it is what tore a live build's sources
                # down once already. It cannot mean that here: the drain did not
                # finish, so the task may equally be in a queue nobody will read.
                # Between the two, this answers the job — a permanently `queued`
                # job is unrecoverable without a restart, while the tree the
                # caller then removes belongs to a build the stop was going to
                # abandon anyway.
                self._jobs.finish(task.job_id, state=STATE_FAILED,
                                  code=RESTART_CODE, error=STOPPED_ERROR)
                return SUBMIT_STOPPED
        return SUBMIT_ACCEPTED

    def shutdown(self) -> None:
        """Stop the workers, drop what is still queued, wait for the rest.

        Whatever is still queued is DROPPED rather than built: waiting for the
        queue would make a stop take as long as everything in it put together,
        and the container is not given that long anyway. But dropping it is a
        job of its own, not the absence of one, because each of those tasks OWNS
        an unpacked source tree (`app._queue_build` hands ownership over with
        the task) and the worker that would have removed it is not going to run.
        So this removes the tree and answers the job.

        Leaving them to `Store._sweep_leftovers` is what the previous version of
        this said, and it was wrong in a way worth spelling out so it does not
        come back: that sweep runs only from `Store.__init__` and only touches
        entries older than LEFTOVER_MAX_AGE_SECONDS — four hours — while a
        container comes back in seconds. A tree dropped here would therefore
        survive the restart that was supposed to collect it and sit on the
        volume until some later restart happened to find it aged out. Up to
        MAX_QUEUED_JOBS trees, each of them a full model source.

        THE DRAIN AND THE JOINS SHARE ONE BUDGET, and the clock starts before
        the drain rather than after it: dropping a queued task is an `rmtree` and
        a job record with an fsync, on the same volume, and a budget that began
        afterwards described the joins while the stop cost both. What the budget
        cannot do is cut the drain short — see WORKER_JOIN_FLOOR_SECONDS for what
        that leaves unbounded and why it is the right way round.
        """
        self._stopping.set()
        # STARTED BEFORE THE DRAIN, because the drain is part of what the stop
        # spends — see WORKER_JOIN_SECONDS. Taken after it, the budget would
        # describe only the joins while the stop cost the drain as well.
        deadline = time.monotonic() + WORKER_JOIN_SECONDS
        try:
            dropped = self._drop_queued()
            if dropped:
                logger.warning(
                    f"{len(dropped)} queued build(s) were dropped by the stop; "
                    f"their sources are gone and their jobs say to push again")
        except Exception:
            # The drain is a loop over directories and job records on the
            # volume, i.e. over things this module does not get to assume
            # anything about, and it runs at the one moment there is nothing
            # after it. Letting it escape would skip every join below and come
            # out of `server_close` — so a worker mid-publish, which is the one
            # thing the join is here to protect, would be left to be SIGKILLed
            # between the rename and the pointer writes.
            logger.exception(
                "the queued builds could not all be dropped by the stop")
        # ONE deadline for the pool, not a timeout each: see WORKER_JOIN_SECONDS.
        # Pushed out to the floor if the drain left less than that, so a slow
        # volume cannot turn the join into a no-op — see WORKER_JOIN_FLOOR_SECONDS.
        #
        # The floor is capped by the budget itself, and that is not paranoia: the
        # two are separate numbers, so a hub retuned to a stop SHORTER than the
        # floor would otherwise find the floor making its stop longer than the
        # number it was given. A floor may rescue a starved join; it may never
        # extend a healthy one.
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

        THE JOB IDS, and not a count, because `submit` has to know whether the
        task it just put down is one of these. "The queue hands one item to
        exactly one caller" says only that this call and the concurrent drain
        cannot both have it; it does NOT say a worker has not got it, and a
        `submit` that concluded otherwise removed the sources out from under a
        running build. The count is still available — it is the size of the set.

        The same ids also go into `self._dropped`, which is what `submit` reads:
        the return value answers "what did I take", and `submit`'s question is
        the wider "did anybody take mine".
        """
        dropped = set()
        while True:
            try:
                task = self._queue.get_nowait()
            except queue.Empty:
                return dropped
            # Recorded before the removal rather than after it: from the moment
            # the task left the queue this call owns it, and that is the fact
            # `submit` is asking about. Whether the tree and the record then went
            # the way they were meant to is a different question, and one the
            # caller cannot answer by pretending it never held the task.
            dropped.add(task.job_id)
            with self._dropped_lock:
                self._dropped.add(task.job_id)
            try:
                # A comparison owns no tree and no body: both revisions are in
                # the store and stay there. Only the job has to be answered.
                if not isinstance(task, CompareTask):
                    shutil.rmtree(task.sources, ignore_errors=True)
                    # And the body, for the same reason and with no exception to
                    # make: this task is never going to publish, so it is never
                    # going to be the code of a revision.
                    _discard(task.archive)
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
        # EVERYTHING is inside the try, the two lines below included. A job that
        # leaves this method without a terminal state stays `building` until the
        # hub is restarted, and the pusher polls a status that will never change
        # again — so the one thing that must not happen here is an exception
        # escaping before `finish` is called. Creating the project directory is
        # not exempt: it is a `mkdir` on the data volume, and a volume with no
        # space left is the ordinary way for that to fail.
        staging = None
        outcome = None
        verdict = None
        try:
            self._jobs.start(task.job_id)
            if task.commit == DEV_LINK:
                # THE DRAFT'S POINTER, AT THE START AND NOT AT THE END, which is
                # the whole of what makes the front page able to say `building`
                # or `failed` (issue #32). The slot's meta.json carries a `job`
                # too, but only a build that reached the publish ever writes one
                # — so a build in flight and a build that failed are, from the
                # slot's side, indistinguishable from a project nobody has
                # touched.
                #
                # GUARDED, like the bookkeeping tails in `src/store.py`: this is
                # a write to the data volume for the sake of a chip on a card,
                # and a volume that will not take it must cost the chip and
                # never the build.
                try:
                    self._store.set_draft_job(task.pid, task.job_id)
                except Exception:
                    logger.exception(
                        f"job {task.job_id}: {task.pid}'s draft pointer could "
                        f"not be written; the front page will not show this "
                        f"build until it finishes")
            staging = self._store.build_staging(task.pid, task.commit)
            # WHAT THE BUILD COMPARES ITSELF AGAINST, asked for here and not
            # inside the build: the slot belongs to the hub, and the build
            # process is handed a copy of the file rather than a way to reach
            # into the store. None is the ordinary answer for a project's first
            # build, and the build then says so in one line.
            args, keywords = build_arguments(
                task.sources, staging, task.pid, force=task.force,
                baseline=self._store.dev_metrics_path(task.pid))
            outcome = self._run_build(*args, **keywords)
            if outcome.ok:
                # THE JOB ID GOES WITH THE TREE, and this is the only place that
                # has it: the slot's meta.json records which job filled it, so
                # `hammerola log dev` can read that build's log back without
                # rebuilding (issue #79). Both routes fill the slot — a commit
                # mirrors itself into it (issue #78) — so both carry the id.
                if task.commit == DEV_LINK:
                    status, payload = self._store.publish_dev_built(
                        task.pid, staging, outcome.files, task.digest,
                        job=task.job_id)
                else:
                    status, payload = self._store.publish_built(
                        task.pid, task.commit, staging, outcome.files,
                        task.digest, job=task.job_id, message=task.message)
                logger.info(
                    f"job {task.job_id}: published {task.pid}/{task.commit} "
                    f"-> {payload['url']}")
                verdict = {"state": STATE_DONE, "code": status,
                           "build_url": payload["url"]}
                self._keep_the_code(task, outcome)
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
            # status PublishError carries is the answer the pusher gets, exactly
            # as it was when the push was synchronous.
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
            # The body, on every path too — and UNCONDITIONALLY rather than "if
            # this build did not publish", because the publishing path has
            # already renamed it into the store and this then finds nothing.
            # Written that way round on purpose: a flag saying whether to keep it
            # would have to be right on every exit from the block above, while a
            # rename that happened is a fact this cannot get wrong. What it
            # collects is every OTHER ending — a build that failed, one the hub
            # refused to publish, one that threw — and for all of them the answer
            # is the same: the sources of a build that produced no revision are
            # not kept (issue #17).
            _discard(task.archive)

        # BELOW the cleanup, and that order is the observable one: a poller that
        # reads `done` is entitled to assume the hub has finished with the push.
        # Marking the job first leaves a window in which the build is published,
        # the pusher has been told so, and an unpacked source tree is still on
        # the volume — which is exactly the state a leftover sweep is meant to be
        # unable to find anything in.
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
            # `finish` is written not to raise — every write inside it is best
            # effort — and this is here for the day that stops being true. It is
            # the last thing between the pusher and a job that stays `building`
            # for ever, and letting it reach `_serve`'s handler would file it as
            # "build worker failed", i.e. as a failed BUILD, which by this point
            # it is not: the build is done and may well be published.
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

        THE FIRST LINE IS WRITTEN HERE and not by the child, because it has to
        be there whatever the child did: the job record carries only the NEWER
        revision (`jobs.create` takes one commit), so a log that did not name
        both would leave nothing anywhere saying what this job compared — and a
        comparison that crashed before printing a word is exactly when somebody
        needs to know.
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

    def _keep_the_code(self, task: BuildTask, outcome) -> None:
        """Keep the pushed body and the log as the code of a published revision.

        Called only from the branch that has just published, which is the whole
        of the rule: the hub is a forge now and has to hold the code of what it
        serves, and it holds the code of NOTHING ELSE (issue #17). A build
        that failed leaves no archive, no log beside one and no directory — the
        author is looking at that failure the moment their command returns, with
        the tree still on their own disk, and a stored tree belonging to no
        published revision is one this store could not answer for.

        THE LOCAL SLOT IS NOT A REVISION and is skipped for that reason, not for
        space. `dev` has no history by construction: the next push overwrites it,
        it is kept out of `builds_of`, `builds.json`, `latest` and the site index,
        and there is nothing to "go back to". Its sources would be an entry in
        the store that nothing published ever points at — and the moment the same
        tree is committed, the digest is the same and the archive lands anyway.

        BEST EFFORT, AND AFTER THE VERDICT. Everything above this call has
        already happened: the build is at its permanent URL and the job is about
        to be told so. An exception escaping here would be caught by
        `_build_and_publish`'s handler and turn a published build into a failed
        job — the exact reversal `publish_built` refuses to make for its own
        bookkeeping, for the same reason. So a volume that will not take the code
        costs the code, and nothing else.
        """
        if task.commit == DEV_LINK:
            return
        try:
            self._store.keep_sources(task.digest, task.archive)
            # Whether or not the archive was already there: the log is of THIS
            # build, and the one already beside it is of an earlier build of the
            # same sources.
            self._store.keep_build_log(task.digest, _capped_log(outcome.log))
        except Exception:
            logger.exception(
                f"job {task.job_id}: {task.pid}/{task.commit} is published, but "
                f"its sources could not be stored; the revision is served "
                f"without its code")


def _capped_log(log: str) -> bytes:
    """One build log as bytes, cut to MAX_LOG_BYTES with a note if it did not fit.

    The ceiling is derived to fit the worst case a build can hand over (see
    MAX_LOG_BYTES), so the cut is unreachable for a log this hub captured; it is
    what keeps the file inside the ceiling anyway on the day either number moves.

    ONE function for BOTH copies of the log — the job's and the one stored beside
    a revision's code — because the alternative is two ceilings on the same text
    that drift apart, and then a log that the job endpoint serves whole while the
    revision's copy is missing its tail, or the reverse.
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


def _discard(path: Path) -> None:
    """Remove one file that may already be gone. NEVER RAISES.

    The file-shaped twin of `shutil.rmtree(..., ignore_errors=True)`, and it
    exists for the same reason that call carries that flag: every caller here is
    in a `finally` on a path whose one duty is to reach a terminal job state.
    `Path.unlink(missing_ok=True)` covers only the missing file, and "missing" is
    the ORDINARY outcome on the publishing path — the archive has been renamed
    into the store — while the rest of what a volume can say still has to not
    take a job down with it.
    """
    try:
        os.unlink(path)
    except OSError:
        pass


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
