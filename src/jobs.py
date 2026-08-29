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
it just published, with a second copy of this same captured log beside it (issue
#17); every other ending deletes the body. So the sources of a build that
FAILED are not kept — a stored tree belonging to no published revision is one
nothing can answer for, and the author is looking at that failure with the tree
still on their own disk.

THAT IS ABOUT THE WRITE PATH ONLY, and must not be read as a reason to trust
what comes back. `data/jobs/` is under the data volume, and the volume is FULLY
WRITABLE BY EVERY BUILD — `src/buildproc/__init__.py` says so in as many words,
and SPEC 8A.4 explains why no boundary is available from inside this container.
So a model can overwrite another job's `log.txt`, read one off the volume
without an id and without a token, and create job directories of its own that
the next start reads through. What the unguessable id and EDIT_TOKEN separate is
one PUSHER from another OVER HTTP; neither is a boundary on the volume, and this
module cannot make one.

What it can do, and does, is stop being harmed by what it reads back: the
ceilings below on how much of a record and of a log it will read, and
`_read_record` rebuilding every field into a known shape instead of believing
one. The failure that motivates this is not subtle — `json.loads` accepts `NaN`
while `json.dumps(allow_nan=False)` refuses it, so one planted record used to be
enough to make the hub fail to start, permanently, on every run after it.

AND THE CORRECTION HAS TO REACH THE VOLUME. A value normalized only in MEMORY
leaves the planted one on disk, so the next start reads it again and begins from
scratch, and the record on disk goes on being a shape this module does not
write. `_load` therefore writes back every record it CHANGED — not only the ones
it had to fail, and not the ones it did not touch, which on a volume with no
retention is nearly all of them. The one that MUST land is the failure itself: a
job stranded `queued` or `building` by a restart has to be recorded terminal, or
every subsequent start finds it in flight again and warns about it again.

NOTHING SHARED BETWEEN RECORDS IS STORED PER RECORD, and that is a rule to hold
every change here to rather than an observation about today's fields. A pass
that writes N files has N places to stop, so anything spread ACROSS those files
comes out of a partial write half old and half new — with the halves chosen by
whoever made one write fail. On this volume that is the model, and it needs no
bug to do it: `chmod 0500` on one job directory fails exactly one record's write
and no other. The creation ORDER was once spread that way, a number per record,
and one unwritable directory was enough to leave the registry holding two
numbering spaces at once. It is not stored at all now — nothing reads it (see
`_load`) — but a field whose meaning depends on another record's field would
bring the same failure back, and it belongs in something written with one rename
rather than in a record.

NO JOB IS EVER DELETED BECAUSE OF ITS AGE OR ITS NUMBER (decision of 2026-08-27,
SPEC 5.3 and 7.4). There is no count ceiling and no age ceiling on the registry:
a record and its log stay until somebody removes the directory. The one thing
that still deletes is `_sweep_strangers`, and it deletes what is NOT a job of
this registry — a directory with no readable record, a stray file, a symlink, a
temporary file of a write that was killed. That is garbage collection on a
volume every build can write into, not retention, and the distinction is the one
to keep: a ceiling on the NUMBER of jobs is a decision about which of the
pusher's builds to destroy, and this module does not make one.

BUILD PARALLELISM IS ITS OWN NUMBER, deliberately not `MAX_CONCURRENT_PUBLISHES`.
The four accept slots in app.py are sized by what RECEIVING costs — a body on
disk, a tar reader, a staging tree — and a build is sized by cores and memory
instead. Sharing one number would mean the day either ceiling is retuned, the
other moves with it for no reason anybody could reconstruct.

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
)
from src.store import (DEV_LINK, JSON_TMP_PREFIX,
                       PublishError, atomic_write_bytes, utcnow_iso)

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
# contract `src/client/hub.py` mirrors, so it is stated once, here, on the side
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
# What the order file taught survives as the rule in the module docstring:
# anything that is a property of the SET of records must not be stored per
# record. Reintroducing such a field is what would bring the file back, and it
# would have to come back as one atomic rename rather than as a number in each
# `job.json`.

# How many entries under `data/jobs/` that are NOT a job of this registry are
# remembered in one start, for the age sweep to look at.
#
# The sweep needs a list and a list needs a ceiling: the directory is writable by
# every build, so the number of things in it is not a number this hub decides.
# What is NOT bounded is how many entries the scan WALKS — `os.scandir` streams,
# so walking a flooded directory costs time and O(1) memory. That is the right
# way round: time at the next start is recoverable, and a hub killed for memory
# while starting never gets to sweep the flood that killed it.
MAX_STRANGERS_SWEPT = 1024

# Ceilings on what this module reads back off the volume AND on what it writes
# there. They are sized by the paragraph at the top of this file — the directory
# these files live in is writable by every build, so the file that comes back is
# not necessarily the file that was written, and reading one without a ceiling
# turns a planted 20 MiB `job.json` into 20 MiB of a request thread's memory.
#
# The two answer differently on purpose. A record that does not fit is not a
# record this hub wrote, so it is skipped entirely; a log that does not fit is
# served truncated, because a log is prose and the first megabytes of one are
# still worth reading.
MAX_RECORD_BYTES = 64 * 1024
# DERIVED from the build's own log ceiling rather than picked, because the two
# are not counted in the same bytes and the difference is a factor of three.
# `runner._Drain` keeps `Limits.log_bytes` (1 MiB) of RAW output and decodes it
# with `errors="replace"`: every byte that is not valid UTF-8 becomes U+FFFD,
# which encodes BACK to three bytes. So a model printing binary — exactly the
# build whose log somebody needs — makes the hub write up to three times the
# ceiling the build ran under, and a smaller number here made the hub serve its
# own log truncated under a warning saying the log was larger than a build can
# produce. It was not: the hub wrote it. Move `Limits.log_bytes` and this moves
# with it; `tests/test_jobs.py` pins the relation by writing the worst case.
MAX_LOG_BYTES = 3 * Limits.log_bytes
LOG_TRUNCATED_NOTE = "\n[truncated by the hub: this log is larger than it should be]\n"

# How many builds may run at once.
#
# PROVISIONAL, and the number is honest about that: nothing has ever been
# measured, because the hub has never been deployed and has never built a model.
# Two is a starting point that cannot be obviously wrong — a build is CPU-bound
# and holds an OCCT thread pool, so more of them than cores is pure contention —
# and it is meant to be replaced by a measurement the first time this service is
# rolled out, exactly like the container's resource limits in step 0 of the plan.
# Do not talk yourself into a bigger number here from first principles; take it
# from a real build.
MAX_CONCURRENT_BUILDS = 2

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

# How old an entry under `data/jobs/` that is NOT a job of this registry has to
# be before the startup sweep removes it. NOT a retention window: no job record
# and no log is ever deleted by age or by count (see the module docstring). What
# this measures is garbage — a directory with no readable record, a stray file,
# a symlink, anything a build left in a directory it can write freely.
#
# Fourteen days rather than at once, because such a directory may be somebody's
# evidence about a build that misbehaved, and being unreadable is not proof of
# who put it there. `.wip-` names are the exception and get an hour instead
# (WIP_MAX_AGE_SECONDS, just below); see `_sweep_strangers`.
STRANGER_MAX_AGE_SECONDS = 14 * 24 * 3600

# The hour that exception gets, and it is ITS OWN NUMBER since 2026-08-29 rather
# than `store.LEFTOVER_MAX_AGE_SECONDS`, which is what it used to read.
#
# The two were the same hour for the same-sounding reason — "far longer than the
# thing can honestly be in use" — and that hid the fact that the things are not
# alike. The store's number covers `.src-`/`.body-`, which live from the request
# until the build ENDS, so it is a function of the queue wait; raising
# `Limits.wall_seconds` to 900 s took it to four hours. What is swept HERE is a
# `.wip-` file: the hub's own half-finished write of a record or a log, abandoned
# in milliseconds, and belonging to nothing by the time this runs at all
# (`_sweep_strangers` is called from `JobStore.__init__`, before the pool exists
# and before the socket is bound).
#
# So the shared name would have quadrupled this wait as a side effect of a change
# about something else — and a `.wip-log.txt-*` is up to MAX_LOG_BYTES apiece,
# i.e. megabytes sitting there for no reason. Same value as before, different
# reason, and now it moves only when its own reason moves.
WIP_MAX_AGE_SECONDS = 3600

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
# be allowed to finish. A build may run to `wall_seconds` (900 s), and the
# compose file declares no `stop_grace_period`, so docker sends SIGKILL 10 s after
# its SIGTERM whatever this number says. A join longer than that grace period
# therefore saves no build — it just converts every ordinary stop into a SIGKILL,
# which is the abrupt ending the join exists to avoid. So: deliberately UNDER the
# grace period, and spent by the whole pool between them.
#
# A BUDGET FOR THE POOL and not a timeout per worker, which is the version of
# this that looks identical and is not. `shutdown` joins the workers one after
# another, so a per-worker timeout is multiplied by however many are busy: at
# MAX_CONCURRENT_BUILDS = 2 a busy pool would spend 2 x 5 s = the ENTIRE grace
# period on the joins alone, before the queue drain and before `serve_forever`
# has even noticed the stop (it polls). The number meant to keep an ordinary stop
# away from SIGKILL would then be what guarantees one — and worse every time the
# pool grows, which it is expected to once there is a measurement to grow it by.
# So the joins share one deadline.
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
    """

    job_id: str
    pid: str
    commit: str
    sources: Path
    archive: Path
    digest: str


def build_arguments(sources: Path, staging: Path, pid: str):
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
    """
    return (sources, staging), {"pid": pid}


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

    def __init__(self, data_dir, *,
                 stranger_max_age_seconds=STRANGER_MAX_AGE_SECONDS):
        self.root = Path(data_dir).resolve() / "jobs"
        # ONLY for `_sweep_strangers`, which collects what is not a job of this
        # registry. There is deliberately no ceiling beside it on how many jobs
        # the registry holds or how old they may be: nothing here deletes a job.
        self.stranger_max_age_seconds = stranger_max_age_seconds
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
        jobs to destroy, and every ordering this could sort them by is a value
        off a volume the build writes. What IS bounded is one record —
        MAX_RECORD_BYTES — and what stays streaming is the listing itself, so a
        flooded directory costs this start time rather than a hub that cannot
        come up. Time at the next start is recoverable; a hub killed for memory
        while starting is not.

        WHATEVER THIS NORMALIZED IS WRITTEN BACK. `_read_record` rebuilds every
        field into a known shape — but in MEMORY, and the volume is writable by
        every build, so without the write-back the volume keeps the planted
        value and the next start reads it again. The one write-back that is not
        merely tidiness is the FAILURE above: a job left `queued` or `building`
        must be recorded terminal, or the same warning is printed at every start
        for the rest of the volume's life. The loop is per-record, which is all
        it is allowed to be: `_rewrite_locked` stopping half way damages the
        records it did not reach and nothing between them.

        AND NOTHING ELSE IS WRITTEN BACK, which is a startup budget rather than
        tidiness. One write is an `atomic_write_bytes`: two fsyncs and a rename.
        There is no retention (see the module docstring), so the number of
        records is the number of pushes over the volume's whole life rather than
        anything bounded — and this runs from `JobStore.__init__`, which runs
        from `create_server` BEFORE the socket is bound, so each of those fsyncs
        is time in which `/health` does not answer at all. At ten thousand jobs
        a write-everything pass is tens of seconds, against a `start_period` of
        30 s in the compose file and an auto-update rollback gate that gives up
        at about 120. A record the rebuild did not change is byte-for-byte what
        this module would write anyway, so writing it buys nothing and costs
        that. `_read_record` is what answers "did it change", by comparing the
        bytes this module WOULD write against the bytes that are there — a
        comparison that cannot miss a correction the way a per-field check
        could.

        NOTHING IN HERE MAY RAISE. It runs from `JobStore.__init__`, which runs
        from `create_server`, which runs from `main()` — so an exception escaping
        this loop is a hub that does not come up, and it comes up next time from
        the same volume, so it does not come up ever again. One unreadable
        directory out of two hundred is not a reason to take the service down,
        and the directory in question is one every build can write. That covers
        the LISTING as well as the records: `_scan` goes to the same volume, and
        an EIO or an EACCES out of it is a hub that never starts rather than a
        hub that starts with no job history.
        """
        candidates, others, unscanned = self._scan()
        loaded, unreadable, corrected = [], [], set()
        for job_id in candidates:
            record, differs = _read_record(self.root / job_id / RECORD_NAME)
            if record is None or record["id"] != job_id:
                # Not one we wrote, or written by a hand that got it wrong, or
                # one this hub itself failed half way through creating. Not
                # believed, and collected by age rather than at once — see
                # `_sweep_strangers`.
                unreadable.append(job_id)
                continue
            loaded.append(record)
            if differs:
                corrected.add(job_id)
        stranded = set()
        for record in loaded:
            if record["state"] in (STATE_QUEUED, STATE_BUILDING):
                record.update(state=STATE_FAILED, code=RESTART_CODE,
                              error=RESTART_ERROR, finished=utcnow_iso())
                stranded.add(record["id"])
            self._records[record["id"]] = record
        self._sweep_strangers(unreadable + others, unscanned=unscanned)
        with self._lock:
            # The failed ones are in the set by construction: this method just
            # changed them, and the read that answered `differs` happened before
            # it did.
            self._rewrite_locked(corrected | stranded, stranded)
        # Counted from what is still here rather than from what was found: a
        # record the volume refused to take the failure for is not one this hub
        # is keeping.
        failed = [job_id for job_id in stranded if job_id in self._records]
        if failed:
            logger.warning(
                f"{len(failed)} build job(s) were still in flight when the hub "
                f"last stopped; they are now marked failed")

    def _scan(self) -> tuple:
        """What is under `data/jobs/` right now, without holding the listing.

        -> (job-shaped directories, everything else, and how many of the latter
        were seen past MAX_STRANGERS_SWEPT).

        EVERY job-shaped directory comes back, without a ceiling, because every
        one of them is read: no job is ever dropped for being one too many, so
        there is no number this could cut at that would not be deciding which of
        the pusher's jobs to destroy. Only the STRANGERS are capped — they are
        the ones this start is going to DELETE, and a delete list whose length
        the volume chooses is a different thing entirely.

        `os.scandir` rather than `iterdir`, and the difference is the point:
        `iterdir` goes through `os.listdir`, which materializes every name in
        the directory before the first one is looked at. Here the WALK streams,
        so a flooded directory costs time and O(1) memory on the way through —
        time at the next start is recoverable, and a hub killed for memory while
        starting never gets to sweep the flood that killed it.

        SYMLINKS ARE NOT FOLLOWED. A symlink to a directory would otherwise read
        as a job directory, be read through, and never be removed —
        `shutil.rmtree` refuses a symlink and `ignore_errors` would swallow the
        refusal, so it would sit there for the life of the volume. Not followed,
        it is a stranger like any other and `_sweep_strangers` unlinks it.
        """
        candidates, others = [], []
        unscanned = 0
        try:
            with os.scandir(self.root) as entries:
                for entry in entries:
                    name = entry.name
                    try:
                        looks_like_a_job = entry.is_dir(follow_symlinks=False)
                    except OSError:
                        # `DirEntry.is_dir` swallows the errors that mean "no"
                        # and raises the ones that mean "the volume would not
                        # say" — which is not a reason to refuse to start.
                        continue
                    if looks_like_a_job and SAFE_JOB_ID.match(name):
                        candidates.append(name)
                    elif len(others) < MAX_STRANGERS_SWEPT:
                        others.append(name)
                    else:
                        unscanned += 1
        except OSError:
            logger.exception(
                f"the job registry in {self.root} could not be listed; this hub "
                f"starts with no job history rather than not at all")
        return candidates, others, unscanned

    def _rewrite_locked(self, dirty: set, stranded: set) -> None:
        """Put the records this start CHANGED back on the volume. Caller locks.

        BEST EFFORT, one record at a time, because this runs on the path that
        must not raise — but not optional: everything `_read_record` normalized
        lives only in memory until this writes it, and memory is not what the
        next start reads.

        `dirty` IS THE WHOLE LIST, and a record outside it is not written at
        all. It holds the records `_read_record` corrected plus the ones this
        start just failed, which is exactly the set whose disk copy disagrees
        with memory; the rest are byte-for-byte what `_write` would produce, so
        the two fsyncs of writing one would buy nothing. `_load`'s docstring has
        the cost that makes the distinction worth drawing — this loop runs
        before the socket is bound, and nothing bounds how many records a volume
        with no retention accumulates.

        WHAT MAY BE FIXED HERE IS PER-RECORD, and that is a rule rather than an
        observation about today's fields. This loop has one stopping place per
        job and the model chooses which one it stops at, so anything shared
        BETWEEN records would come back half converted — which is exactly how
        the creation order was damaged, back when it was a number in each
        record. A field whose meaning depends on another record's field does not
        belong in a record; it belongs in something written with one rename.

        WHAT MUST LAND is the failure of a job the last stop stranded. Everything
        else here is the record being put back in the shape this hub writes; that
        one is the difference between a job that is finished and a job the next
        start finds `building` all over again, and warns about all over again,
        for the life of the volume.

        A record that cannot be written back is DROPPED from memory only if this
        run is the one that failed it. That asymmetry is deliberate: a job whose
        failure did not reach the volume comes back `queued` or `building` at the
        next start regardless, so keeping it here would only make this run
        disagree with the next one about a job nobody can do anything for. A
        record that was already terminal is kept — the volume holds a stale copy
        of it, which is what the next start will normalize again, and forgetting
        it here would 404 a job whose log is still there.
        """
        for job_id in list(dirty):
            record = self._records.get(job_id)
            if record is None:
                continue
            try:
                self._write(record)
            except (OSError, ValueError):
                logger.exception(
                    f"job {job_id}: the record read off the volume could "
                    f"not be written back in the shape this hub uses")
                if job_id in stranded:
                    self._records.pop(job_id, None)

    def _sweep_strangers(self, names, *, unscanned: int = 0) -> None:
        """Remove what is under `data/jobs/` and is not a job, once it is old.

        WHAT THIS ACTUALLY COVERS, stated as what it is rather than as a
        guarantee it cannot give: every entry the scan met that this registry
        does not hold as a job — a directory with no readable record in it, a
        name of any other shape, a stray file, a symlink, the leftover of a write
        this hub was killed inside. It is the ONLY thing in this module that
        deletes anything, and it deletes no job: a record and its log stay until
        somebody removes the directory (see the module docstring). What it
        collects is what a build left in a directory it can write freely, and
        which would otherwise sit there for the life of the volume.

        WHAT IT DOES NOT COVER is the entries past MAX_STRANGERS_SWEPT: they are
        counted and reported, and the next start meets them again. That is a
        rate rather than a hole — a flood is collected over several starts —
        and the alternative was a list whose length the volume chooses.

        BY AGE, and not at once, because a directory with no record may be
        somebody's evidence about a build that misbehaved, and being unreadable
        is not proof of who wrote it. At STARTUP only, because that is the one
        moment this module reads the volume at all — a sweep per `create` would
        be a directory scan on the push path, and what this defends against
        accumulates over months.

        WITH ONE EXCEPTION, and it is what makes the temporary files of `_write`
        and `_write_log` safe to keep here (see `_write`). A `JSON_TMP_PREFIX`
        entry is the remains of a write this hub was killed in the middle of: it
        is nobody's evidence — it is half of something the hub itself was
        writing — and it is not small, because `.wip-log.txt-*` runs to
        MAX_LOG_BYTES, which is 3 MiB apiece. Fourteen days of those is not what
        moving them here was for, and `Store._sweep_leftovers` does not collect
        them: that sweep walks the data root and the project directories, and
        `data/jobs/` is neither. So they get a cutoff of their own, the same one
        the store uses for its own leftovers.

        SAFE BECAUSE OF WHEN THIS RUNS, which is the only reason a short cutoff
        is allowed at all: `JobStore.__init__`, before the pool exists and
        before the socket is bound, so nothing in this process is writing into
        `data/jobs/`. The store's hour is kept rather than shortened further
        because the volume can be shared with another hub, and an hour is what
        that same question was already answered with there.

        AN mtime IN THE FUTURE IS TREATED AS OLD. The mtime is a value a build
        sets freely, and one dated 2999 is never past any cutoff, so a directory
        carrying it would be immune for the life of the volume — this sweep
        beaten by a date rather than by anything the hub did. It is not
        CORRECTED, because the mtime is the evidence and rewriting it would
        destroy the thing this method is being careful about; a date in the
        future simply buys no immunity.
        """
        now = time.time()
        cutoff = now - self.stranger_max_age_seconds
        # `min`, so a registry configured with a shorter stranger age than the
        # hour below does not accidentally grant its own half-written files a
        # longer life than the strangers around them.
        tmp_cutoff = now - min(self.stranger_max_age_seconds,
                               WIP_MAX_AGE_SECONDS)
        removed = kept = 0
        for name in names:
            entry = self.root / name
            try:
                info = os.lstat(entry)
            except OSError:
                continue
            against = (tmp_cutoff if name.startswith(JSON_TMP_PREFIX)
                       else cutoff)
            if against <= info.st_mtime <= now:
                kept += 1
                continue
            try:
                if os.path.isdir(entry) and not os.path.islink(entry):
                    shutil.rmtree(entry, ignore_errors=True)
                else:
                    # A file or a symlink: `rmtree` refuses both, and refusing
                    # under `ignore_errors` is how one would stay for ever.
                    os.unlink(entry)
            except OSError:
                continue
            removed += 1
        if removed or kept or unscanned:
            # ONE line, whatever the count. A line per entry meant a build could
            # write 988 warnings into every start of the hub, and the compose
            # file caps the log at 5 files of 10 MB — so the entries a build
            # planted would push out the service's own logs, which is the thing
            # somebody would have been reading to find out about them.
            logger.warning(
                f"{self.root}: {removed} entry(ies) that hold no job of this "
                f"registry were removed as past the stranger age ceiling, "
                f"{kept} kept until they reach it, {unscanned} not examined "
                f"this start")

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
        deciding this process's resident size. `_write_log` caps what the hub
        itself puts there, so what this ceiling is really for is everything
        else: the directory is writable by every build (see the module
        docstring), so the size of the file that comes back is not a number this
        hub gets to decide.

        THE TRUNCATION IS NOT WRITTEN BACK, and that is deliberate. The cap
        bounds every single read, so nothing is gained by making the file
        smaller — and a log is EVIDENCE about a build that misbehaved, so
        rewriting one to make a read cheaper would destroy the thing somebody
        came to look at. Nothing else on the volume grows because of it: an
        oversized `log.txt` sits inside a job directory that is not going
        anywhere either way.
        """
        if not isinstance(job_id, str) or not SAFE_JOB_ID.match(job_id):
            return None
        with self._lock:
            if job_id not in self._records:
                return None
        try:
            with open(self.root / job_id / LOG_NAME, "rb") as handle:
                # One byte over the ceiling, which is what makes "too big"
                # distinguishable from "exactly at the ceiling".
                raw = handle.read(MAX_LOG_BYTES + 1)
        except OSError:
            # Queued, still building, or ended before there was anything to
            # say. An empty log is the honest answer; a 404 would mean the job
            # does not exist, which is a different thing entirely.
            return ""
        if len(raw) > MAX_LOG_BYTES:
            logger.warning(
                f"job {job_id}: its log is over {MAX_LOG_BYTES} bytes, which is "
                f"more than a build can produce; serving it truncated")
            return (raw[:MAX_LOG_BYTES].decode("utf-8", errors="replace")
                    + LOG_TRUNCATED_NOTE)
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
            # `exist_ok=False`: 128 bits of id do not collide, and if one ever
            # did, silently sharing a directory with another job is the worst
            # possible way to find out.
            (self.root / job_id).mkdir(parents=True, exist_ok=False)
            # THE VOLUME FIRST, `_records` second — the one write in this class
            # that is not best effort, and the order is what makes the failure
            # leave nothing behind. `finish` can afford a volume that refuses it,
            # because the record is already in memory and memory is what every
            # status poll is answered from. Here there is nobody to serve: the
            # push is answered 500 and the id never leaves this method, so a
            # record inserted before a write that then failed would sit in
            # memory until the process ends, `queued`, for a build nobody is
            # running. In this order the caller gets the exception with no trace
            # in memory, and the empty directory left on the volume is collected
            # by `_sweep_strangers` at a later start.
            self._write(record)
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
                          # Through the same normalizer the read path uses: a
                          # duration of NaN or infinity is one `json.dumps` will
                          # not write and `json.dumps` in app.py WILL — as the
                          # bare literal `NaN`, which is not JSON at all.
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
        # THE BYTES COME FROM `_record_bytes`, which `_read_record` also uses to
        # decide whether a record needs writing at all. One function, so the two
        # answers cannot drift: a serialization detail changed here without
        # changing there would make every record on the volume look corrected,
        # and the whole registry would be rewritten at every start again.
        #
        # `indent=1` costs about 16 bytes against the compact separators, and
        # that is not free at the very top of the range: a record of 65521..65536
        # bytes is one `_read_record` accepts and one this write turns into a
        # file the NEXT read refuses. Left as it is, deliberately. The hub's own
        # records are a few hundred bytes, so the boundary is unreachable for
        # anything it wrote; a record that big is a planted one, and what the
        # non-idempotence does to it is stop it being adopted after one restart,
        # after which `_sweep_strangers` collects the directory by age. The
        # readable form on the volume is worth more than sixteen bytes of
        # headroom in a band only an attacker can reach.
        atomic_write_bytes(
            self.root / record["id"] / RECORD_NAME,
            _record_bytes(record),
            # The temporary file goes in `data/jobs/`, not in the job's own
            # directory: same filesystem, so the rename is still a rename, and
            # a leftover from a write this process was killed in the middle of
            # then lands where `_sweep_strangers` looks. Inside a live job's
            # directory nothing collects one — the sweep removes whole entries
            # that are not jobs, and that directory IS a job.
            #
            # AND THE SWEEP THAT COLLECTS IT IS THIS MODULE'S, not the store's:
            # `Store._sweep_leftovers` walks the data root and the project
            # directories, and `data/jobs/` is neither, so nothing it does
            # reaches here. That is why `_sweep_strangers` carries a cutoff of
            # its own for these names — collected in an hour, not in fourteen
            # days, which for a `.wip-log.txt-*` of up to MAX_LOG_BYTES is the
            # difference between a stray and 3 MiB of one.
            tmp_dir=self.root)

    def _write_log(self, job_id: str, log: str) -> None:
        atomic_write_bytes(self.root / job_id / LOG_NAME, _capped_log(log),
                           tmp_dir=self.root)


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
                 workers=MAX_CONCURRENT_BUILDS, queue_size=MAX_QUEUED_JOBS):
        self._store = store
        self._jobs = jobs
        # Injected rather than imported at the call site so a test can drive
        # the whole pipeline without CadQuery, a subprocess or a real model —
        # none of which this class is about.
        self._run_build = run_build if build_runner is None else build_runner
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

    def submit(self, task: BuildTask) -> str:
        """Hand a push to the pool. One of the three SUBMIT_ constants.

        CHECKED ON BOTH SIDES of the insertion, because a request thread runs
        straight through a shutdown: `daemon_threads = True`, so the thread
        serving a push carries on while `shutdown` drains the queue on another
        one. A task put down after that drain has gone past sits in a queue no
        worker will ever read again — and every visible consequence of that is
        wrong. The pusher is told 202 about a build nobody is going to run; the
        unpacked source tree the task owns stays on the volume, and the sweep
        that would collect it (`Store._sweep_leftovers`) runs at startup and
        skips everything younger than an hour, while a container comes back in
        seconds.

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
            staging = self._store.build_staging(task.pid, task.commit)
            args, keywords = build_arguments(task.sources, staging, task.pid)
            outcome = self._run_build(*args, **keywords)
            if outcome.ok:
                if task.commit == DEV_LINK:
                    status, payload = self._store.publish_dev_built(
                        task.pid, staging, outcome.files, task.digest)
                else:
                    status, payload = self._store.publish_built(
                        task.pid, task.commit, staging, outcome.files,
                        task.digest)
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

    Cut on the WAY IN, not only on the way out. MAX_LOG_BYTES is what the read
    path is willing to serve, so anything written past it comes back truncated
    under a warning about a log larger than a build can produce — and on these
    paths the hub itself wrote it. The ceiling is derived to fit the worst case a
    build can hand over (see MAX_LOG_BYTES), so the cut is unreachable for a log
    this hub captured; it is what keeps the file inside the ceiling anyway on the
    day either number moves.

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
    """One record as this module writes it. The ONLY spelling of that.

    Shared by `JobStore._write` and by the comparison in `_read_record` below,
    which is the point: "what would be written" and "what is on disk" have to be
    the same question, or the second one answers about a format the first does
    not produce.
    """
    return json.dumps(record, indent=1, ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def _read_record(path: Path) -> tuple:
    """One `job.json` rebuilt into the shape this module writes, and whether the
    rebuild CHANGED it -> `(record, differs)`. `(None, False)` if it is not one.

    `differs` IS A BYTE COMPARISON, not a list of the fields that were touched:
    what this module would write against what the file holds. That is the only
    form that cannot go stale — a field added to the rebuild below, a key that
    moved, a spelling `_record_bytes` changed are all covered without anybody
    remembering to cover them, and the caller needs the answer for exactly one
    purpose (`_load`: writing back the records nothing corrected is what makes a
    hub with a long-lived volume slow to come up).

    EVERY field is rebuilt rather than taken, because this file sits on a volume
    every build can write (see the top of this module). Three shapes in
    particular are not survivable if the file is believed:

      * a number that is `NaN` or `Infinity`. Those are not JSON — they are a
        Python extension `json.loads` accepts by default and
        `json.dumps(allow_nan=False)` refuses — so a record carrying one is a
        record this module can READ and cannot WRITE. `_load` rewrites every job
        it keeps, so one planted `"duration_seconds": NaN` used to be a
        `ValueError` out of `JobStore.__init__`, out of `create_server` and out
        of `main()`: a hub that does not start, from the same volume, every time,
        for ever;
      * a `state` outside KNOWN_STATES: neither running nor finished, so `_load`
        never fails it, and the status endpoint serves a word no client has a
        branch for, for ever;
      * an `id` that is not the directory's name, which points one job's record
        at another job's log. The caller compares them; this is what makes the
        comparison possible by guaranteeing the field is a string of the right
        shape at all.

    A NUMBER is normalized rather than fatal, while an unusable `state` or `id`
    throws the whole record away, and the asymmetry is deliberate: `None` is a
    value every numeric field here already has ("not measured"), so the record
    can be ADOPTED — failed like any other stranded job and served like any
    other. A state or an id would have to be guessed instead.

    THE STAMPS ARE NOT VALIDATED, only typed. `created` may say 2999 and nothing
    here minds: no ceiling measures it, nothing sorts by it, and it is a string
    shown to whoever is reading the record. That was NOT true while jobs were
    pruned by age — a date in the future was then immunity from the sweep, and
    had to be pulled back to "now" and written down — so if anything ever
    measures a stamp on this volume again, it has to answer that first.

    Everything corrected here is corrected in memory; `_load` is what puts it
    back on disk. Anything added to this rebuild inherits that requirement — and
    inherits it automatically, because `differs` is computed from the finished
    record rather than declared field by field.

    None means "not a record this hub wrote". The caller does not delete the
    directory on the spot — it is somebody's evidence, and being unreadable is
    not proof of who put it there — but it does not leave it for ever either:
    `_sweep_strangers` collects it once it is past the same age ceiling the
    records get.
    """
    raw = _read_capped(path, MAX_RECORD_BYTES)
    if raw is None:
        return None, False
    try:
        loaded = json.loads(raw)
    except (ValueError, RecursionError):
        return None, False
    if not isinstance(loaded, dict):
        return None, False
    job_id = loaded.get("id")
    if not isinstance(job_id, str) or not SAFE_JOB_ID.match(job_id):
        return None, False
    if loaded.get("state") not in KNOWN_STATES:
        return None, False
    record = {
        "id": job_id,
        "pid": _text(loaded.get("pid")),
        "commit": _text(loaded.get("commit")),
        "state": loaded["state"],
        "created": _text(loaded.get("created")),
        "started": _text(loaded.get("started")),
        "finished": _text(loaded.get("finished")),
        "status": _text(loaded.get("status")),
        "code": _whole(loaded.get("code")),
        "build_url": _text(loaded.get("build_url")),
        "error": _text(loaded.get("error")),
        "log_truncated": bool(loaded.get("log_truncated")),
        "duration_seconds": _number(loaded.get("duration_seconds")),
        # NO ORDERING FIELD. Anything read here is a field of ONE record, so a
        # write-back that stops half way can only leave one record unconverted.
        # An order is not like that — it is a statement ABOUT the set — and a
        # per-record copy of one made a partial write mix two orders. Nothing
        # reads an order any more, and a field that would need the same
        # all-or-nothing must not be added here.
    }
    try:
        return record, _record_bytes(record) != raw
    except ValueError:
        # Unreachable with the fields above — `_number` is what removes the only
        # values `allow_nan=False` refuses, and every other field here is a
        # string, an int, a bool or None. Answered as "differs" rather than
        # guarded away so that if a field is ever added that CAN fail to
        # serialize, the write-back attempts it and the failure is logged where
        # every other write failure of this registry is, instead of the record
        # silently never being written again.
        return record, True


def _read_capped(path: Path, limit: int) -> bytes | None:
    """At most `limit` bytes of a file; None if it is bigger, or unreadable.

    One byte over the limit is read so that "too big" can be told from "exactly
    the limit", and nothing beyond that ever reaches memory.
    """
    try:
        with open(path, "rb") as handle:
            data = handle.read(limit + 1)
    except OSError:
        return None
    if len(data) > limit:
        logger.warning(
            f"{path} is over {limit} bytes, which is far more than anything "
            f"this hub writes there; it was not read")
        return None
    return data


def _text(value) -> str | None:
    """A string field, or None. Length is bounded by MAX_RECORD_BYTES already."""
    return value if isinstance(value, str) else None


def _whole(value) -> int | None:
    """An integer field, or None. `bool` is not one, whatever Python says."""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _number(value) -> float | None:
    """A FINITE number, or None — which is what NaN and Infinity become here.

    Used on the way in and on the way out: `finish` normalizes through it too,
    so a runner that ever reported a non-finite duration cannot put one in a
    record the hub then fails to write, nor in a JSON body served to a client
    (`json.dumps` defaults to writing the bare literal `NaN`, which no strict
    parser accepts).
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None
