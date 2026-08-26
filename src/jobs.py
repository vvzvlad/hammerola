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
    BuildTask   what the request hands over: a job id and an unpacked tree
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

THAT IS ABOUT THE WRITE PATH ONLY, and must not be read as a reason to trust
what comes back. `data/jobs/` is under the data volume, and the volume is FULLY
WRITABLE BY EVERY BUILD — `src/buildproc/__init__.py` says so in as many words,
and SPEC 8A.4 explains why no boundary is available from inside this container.
So a model can overwrite another job's `log.txt`, read one off the volume
without an id and without a token, and create job directories of its own that
count against MAX_JOBS. What the unguessable id and PUBLISH_TOKEN separate is
one PUSHER from another OVER HTTP; neither is a boundary on the volume, and this
module cannot make one.

What it can do, and does, is stop being harmed by what it reads back: the
ceilings below on how much of a record and of a log it will read, and
`_read_record` rebuilding every field into a known shape instead of believing
one. The failure that motivates this is not subtle — `json.loads` accepts `NaN`
while `json.dumps(allow_nan=False)` refuses it, so one planted record used to be
enough to make the hub fail to start, permanently, on every run after it.

AND THE CORRECTION HAS TO REACH THE VOLUME. This is the rule to check every
change here against, because it has been got wrong twice in the same way: a
value normalized only in MEMORY leaves the planted one on disk, so the next
start reads it again and begins from scratch — and a defence that has to be
re-applied on every start is not a defence, it is a loop. `_load` therefore
writes back every record it keeps, not only the ones it had to fail; the
exceptions are named where they are made (`JobStore.log`, `_created`) and each
one is an exception because nothing about it accumulates across a restart.

AND THE RULE ABOVE HAS A SECOND HALF, which the write-back itself taught: a pass
that writes N files has N places to stop, so anything spread ACROSS those files
comes out of a partial write half old and half new — with the halves chosen by
whoever made one write fail. On this volume that is the model, and it needs no
bug to do it: `chmod 0500` on one job directory fails exactly one record's write
and no other. The creation ORDER used to be spread that way, a number per
record, and one unwritable directory was therefore enough to leave the registry
holding two numbering spaces at once — an order the running hub had never been
in, plus duplicate numbers for the reader to break with 128 random bits of id.
So the order is not in the records any more. It is ONE file (`ORDER_NAME`),
written with ONE rename, and that is a claim about the failure rather than about
the success: a write that does not land leaves the PREVIOUS order intact, whole.
The property to hold every change here to is not "the order is correct" — no
write can promise that — but "the order the next start reads is never worse than
the one before the attempt, and nobody gets to choose how it is worse". What is
left in the records is per-record only, so a pass that stops half way now
damages exactly the records it did not reach and nothing between them.

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
from datetime import datetime, timezone
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
from src.store import (DEV_LINK, JSON_TMP_PREFIX, LEFTOVER_MAX_AGE_SECONDS,
                       PublishError, atomic_write_bytes, utcnow_iso)

# -- what a job can be -------------------------------------------------------
# `queued` and `building` are the two states a restart can strand, which is why
# they are separate: a job that never reached a worker and one that was killed
# half way through are the same to the pusher but not to whoever reads the log.
STATE_QUEUED = "queued"
STATE_BUILDING = "building"
STATE_DONE = "done"
STATE_FAILED = "failed"

TERMINAL_STATES = (STATE_DONE, STATE_FAILED)
# The four, as a set to check a record against. A state outside it is not a
# harmless typo: retention only ever drops a TERMINAL job and `_load` only ever
# fails a job that is `queued` or `building`, so a fifth word is a record no
# rule here can reach — permanent, and counting against every ceiling.
KNOWN_STATES = frozenset((STATE_QUEUED, STATE_BUILDING, STATE_DONE, STATE_FAILED))

# 16 bytes from `secrets`, base64url-encoded: 22 characters out of the alphabet
# below. UNGUESSABLE rather than sequential, because the id is the only thing
# guarding a job — the status and the log are readable by anyone holding
# PUBLISH_TOKEN, and a counter would let one pusher walk every other project's
# build logs by subtracting one.
JOB_ID_BYTES = 16
SAFE_JOB_ID = re.compile(r"\A[A-Za-z0-9_-]{22}\Z")

# The two files one job owns on the volume.
RECORD_NAME = "job.json"
LOG_NAME = "log.txt"

# ...and the one file the REGISTRY owns: the ids of every job it holds, oldest
# first. Retention counts by creation order (`_prune_locked`), so the order has
# to survive a restart, and this is the only thing on the volume that expresses
# it — the records carry no ordering field at all.
#
# A FILE RATHER THAN A NUMBER PER RECORD, and the reason is the second paragraph
# of the module docstring: a number per record makes the order a property of N
# files, so a write that lands only partly mixes two orders and the model
# chooses where the mixing happens. This is one atomic rename, which has no
# half. It is also why the order is a LIST OF IDS and not a list of numbers:
# a number read off this volume has to be clamped into some range to keep it
# from being absurd, the clamp is what collapsed a planted number into a tie
# with real ones, and the renumbering that answered THAT is what had to reach
# every record. Ordinal information written down as an order carries no
# magnitude, so there is nothing left to be absurd.
#
# The file is on the same writable volume as everything else here, and that is
# accepted rather than solved. Be exact about what "accepted" covers, because
# the generous reading of it is false: a build can WRITE this file, so it can
# write a well-formed one — real ids, permuted — and `_load` takes it without a
# word. Arbitrary rewriting of the order is available to a build and is
# indistinguishable from the hub's own, exactly as it is for a `log.txt` (the
# top of this module says so about the log already, and this is the same
# sentence about a different file). There is no escalation in it: the same build
# can `rmtree` another job's directory outright, which is strictly more than
# reordering the queue that directory is deleted from.
#
# WHAT THIS FILE BUYS IS NARROWER, and it is about a POINTWISE failure rather
# than about a write: a build that makes ONE record's write fail — `chmod 0500`
# on one job directory, no vulnerability needed — no longer reorders the
# registry, because there is no per-record order left for a pass that stops half
# way to mix two generations of. That is the whole claim, and it is the one the
# rest of this file is arranged around.
ORDER_NAME = "order.json"

# What `_read_order` will take off the volume, both derived rather than picked.
#
# The entry ceiling is what the hub itself can have written: retention bounds
# the registry at `max_jobs`, plus the jobs in flight that `_prune_locked`
# deliberately exempts — the pool plus the queue, and nothing else. The byte
# ceiling follows from it with room to spare, because an id is 22 characters and
# a line of this file is about 27: generous per entry on purpose, so that no
# file this hub could have written is ever refused, while a planted one still
# cannot be read into memory unbounded.
ORDER_ENTRY_BYTES = 64
ORDER_ENVELOPE_BYTES = 256

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

# Jobs accumulate: one per push, for ever, each with a log next to it. Both
# ceilings exist because either one alone leaves a hole — a count with no age
# keeps a job from 2026 alive on a hub nobody pushes to, and an age with no
# count lets a CI loop gone wrong write ten thousand of them in a day. Swept
# when a new job is created, which is the only moment anything here changes.
#
# 200 is roughly ten times RETENTION_BUILDS: the interesting jobs are the recent
# ones and the FAILED ones, and a failed build publishes nothing, so the job list
# has to be longer than the build list to still hold them.
MAX_JOBS = 200
MAX_JOB_AGE_SECONDS = 14 * 24 * 3600

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
# be allowed to finish. A build may run to `wall_seconds` (120 s), and the
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
# is the one state nothing here can reclaim: `_prune_locked` never drops a job
# that has not finished, so it holds a MAX_JOBS slot until the hub restarts,
# while the status endpoint goes on saying `queued` about a build that does not
# exist. Used by `app._queue_build`, which is the only place that gap is.
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
    """

    job_id: str
    pid: str
    commit: str
    sources: Path
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

    def __init__(self, data_dir, *, max_jobs=MAX_JOBS,
                 max_age_seconds=MAX_JOB_AGE_SECONDS):
        self.root = Path(data_dir).resolve() / "jobs"
        # At least one, or `create` would sweep away the job it just made.
        self.max_jobs = max(1, int(max_jobs))
        self.max_age_seconds = max_age_seconds
        # Workers write, request threads read. Every access to `_records` and
        # every write to the volume happens under this.
        self._lock = threading.Lock()
        # The order jobs were created in IS this dict's order, and that is the
        # whole of it in memory — retention counts by it (`_prune_locked`) and
        # nothing else needs a number. `ORDER_NAME` is the same list on the
        # volume, which is what carries it across a restart.
        self._records: dict[str, dict] = {}
        # Derived from this store's own ceiling rather than from the module's,
        # so a registry configured smaller does not go on accepting an order
        # file larger than it could ever write.
        #
        # THE OTHER TWO TERMS ARE THE MODULE CONSTANTS ON PURPOSE, and the
        # asymmetry is worth stating because it looks like an oversight: the
        # jobs `_prune_locked` exempts are the pool plus the queue, and
        # `BuildQueue` takes both as PARAMETERS. Those parameters exist for
        # tests and only ever go DOWN (`create_server` passes them through for
        # `tests/harness.py` to stand up a one-worker pool with a queue of one);
        # a deployment gets the defaults, because there is nothing to configure
        # them from — no setting, no environment variable. A pool built larger
        # than the defaults would make the hub refuse its own `order.json` on
        # every start, so if either ever becomes configurable, this has to be
        # derived from the real pool instead of from these names.
        self._max_order_entries = (self.max_jobs + MAX_QUEUED_JOBS
                                   + MAX_CONCURRENT_BUILDS)
        self._max_order_bytes = (ORDER_ENVELOPE_BYTES
                                 + ORDER_ENTRY_BYTES * self._max_order_entries)
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

        THE ORDER IS READ, NOT RECONSTRUCTED. `ORDER_NAME` gives the ids oldest
        first and this method keeps that sequence exactly — there is no sort
        here and no ordering field in a record to sort on. That is what makes
        the guarantee at the top of this module hold: the order this start reads
        is the order the last successful write put there, whole, and a write
        that did not land left the one before it, also whole.

        A DIRECTORY THE ORDER FILE DOES NOT NAME sorts OLDEST, and that end is
        chosen rather than convenient. It is the end retention drops first, so a
        build planting directories can crowd out no real job; the same rule
        covers a job of this hub whose order entry never reached the volume, and
        for that one being swept early is the honest outcome — the volume never
        heard it was created.

        WHATEVER THIS NORMALIZED IS WRITTEN BACK, and that is the half the loop
        is really for. `_read_record` rebuilds every field into a known shape —
        but in MEMORY, and the volume is writable by every build. A
        normalization that does not reach the volume leaves the value the
        attacker chose sitting on disk, so the next start begins from it again:
        the date in 2999 is pulled back to "now" once per start and never ages,
        and the record is failed and counted but never swept. So the write-back
        covers EVERY record that survives, not only the ones this run had to
        fail. It is per-record, and after the order moved out of the records
        that is all it is: `_rewrite_locked` stopping half way now damages the
        records it did not reach and nothing between them.

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
        order = _read_order(self.root / ORDER_NAME, self._max_order_entries,
                            self._max_order_bytes)
        present, orphans, others, unscanned = self._scan(frozenset(order or ()))
        if not order and orphans:
            # Said out loud because losing the order WHOLESALE is what makes
            # retention go on working on an order nobody put there — quietly,
            # unless this line is here.
            #
            # `not order` AND NOT `order is None`, which is the whole of the
            # difference and was got wrong once: an empty order is what a
            # registry holding no jobs has, but an empty order NEXT TO job
            # directories is the same total loss spelled differently, and a
            # planted `{"jobs": []}` must not be quieter than a deleted file.
            # `_read_order` still tells the two apart — that distinction is
            # about believing a damaged order, not about announcing an empty
            # one.
            #
            # There is exactly one false positive, and it is worth the line too:
            # a `create` on an empty registry whose record landed and whose
            # order write did not. The volume genuinely never heard that job was
            # created, and the next start genuinely reads it as the oldest.
            logger.warning(
                f"{self.root} holds {len(orphans)} job directory(ies) and no "
                f"order to put them in; their creation order is lost, and "
                f"until new jobs arrive retention drops them in the order the "
                f"volume happens to list them")
        order = order or []
        # The creation order as the order file gives it, restricted to what is
        # really on the volume: an id whose directory is gone was pruned by an
        # earlier run, and is simply not here to be counted.
        known = [job_id for job_id in order if job_id in present]
        # A COUNT IS CUT BEFORE ANYTHING IS READ, and that is what bounds this
        # method. Every record loaded below is terminal by the time the loop
        # after it has run — a job in flight at the last stop cannot be resumed
        # — so `_prune_locked` would drop these and more anyway, and dropping
        # them here costs one `rmtree` each instead of one read of up to
        # MAX_RECORD_BYTES each. Without it, that ceiling bounded ONE record
        # and nothing bounded their NUMBER: 2000 planted records at the largest
        # size the reader accepts came to 128 MiB of heap before the first prune
        # ran — a build that filled the volume deciding how much memory the next
        # start needs, which is the one outcome this registry may not have.
        #
        # AND THE CUT IS `_max_order_entries` WIDE, NOT `max_jobs`, because the
        # argument above holds for a record that can be READ and for no other.
        # An unreadable one never reaches `self._records`, so `_prune_locked`
        # counts one fewer and keeps one fewer — while a cut at `max_jobs`
        # deleted by POSITION, before the read, and could not know. Corrupting N
        # records at the newest end therefore cost up to N REAL jobs at the
        # oldest end, with the build choosing both N and which ones: measured at
        # 20 jobs, `max_jobs` of 5 and five broken `job.json`, the registry came
        # up EMPTY. The slack is what makes the sentence true again, and the
        # number is derived rather than picked — the widest order this hub can
        # have written is `max_jobs` plus the jobs in flight that
        # `_prune_locked` exempts, which is exactly `_max_order_entries`, so a
        # cut there can never remove an entry the hub itself put in the file.
        #
        # `_read_order` caps its own output at the same number, so in the
        # ordinary case this removes nothing and `_prune_locked` below does the
        # whole job, after the read, where it can count what it actually has.
        # That coincidence is deliberate rather than redundant: `_load`'s bound
        # on how much it reads is then stated HERE, in `_load`, instead of being
        # inherited from an argument passed to a helper — and the cut still
        # fires the day the two are given different numbers.
        overflow = max(0, len(known) - self._max_order_entries)
        surplus, known = known[:overflow], known[overflow:]
        # Read as far into the strangers as there is room under the ceiling and
        # no further. The rest wait for the age sweep like any other stranger:
        # adopting them only to prune them in the same call would spend the
        # reads this ceiling exists to avoid, and delete by COUNT what the sweep
        # deliberately deletes by AGE.
        #
        # THE CEILING HERE AND THE WIDER CUT ABOVE, deliberately not the same
        # number. The slack up there exists because a record past the cut is
        # DELETED unread; a stranger left out is not deleted by anything, it
        # simply waits for the age sweep, so widening this would buy nothing and
        # spend reads.
        room = max(0, self.max_jobs - len(known))
        adopted, spare = orphans[:room], orphans[room:]
        loaded, unreadable = [], []
        for job_id in adopted + known:
            record = _read_record(self.root / job_id / RECORD_NAME)
            if record is None or record["id"] != job_id:
                # Not one we wrote, or written by a hand that got it wrong, or
                # one this hub itself failed half way through creating. Not
                # believed, and collected by age rather than at once — see
                # `_sweep_strangers`.
                unreadable.append(job_id)
                continue
            loaded.append(record)
        stranded = set()
        for record in loaded:
            if record["state"] in (STATE_QUEUED, STATE_BUILDING):
                record.update(state=STATE_FAILED, code=RESTART_CODE,
                              error=RESTART_ERROR, finished=utcnow_iso())
                stranded.add(record["id"])
            self._records[record["id"]] = record
        self._drop_surplus(surplus)
        self._sweep_strangers(unreadable + spare + others, unscanned=unscanned)
        with self._lock:
            # PRUNED FIRST, so the write-back below does not spend an fsync on a
            # record this same call is about to remove — and so a planted stamp
            # that retention can now reach is collected rather than rewritten.
            self._prune_locked()
            self._rewrite_locked(stranded)
            # LAST, and once: everything above may have changed which jobs the
            # registry holds, and this is the single write that tells the next
            # start what order they are in.
            self._commit_order_locked()
        # Counted from what is still here rather than from what was found, so
        # the number is the one a reader can go and look at: retention may have
        # swept a stranded job that was also too old, and a record the volume
        # refused to take the failure for is not one this hub is keeping.
        failed = [job_id for job_id in stranded if job_id in self._records]
        if failed:
            logger.warning(
                f"{len(failed)} build job(s) were still in flight when the hub "
                f"last stopped; they are now marked failed")

    def _scan(self, order: frozenset) -> tuple:
        """What is under `data/jobs/` right now, without holding the listing.

        -> (ids the order file names and that are really here, job-shaped
        directories it does NOT name, everything else, and how many entries
        were seen past the ceiling on the last two).

        `os.scandir` rather than `iterdir`, and the difference is the point:
        `iterdir` goes through `os.listdir`, which materializes every name in
        the directory before the first one is looked at, and the number of
        names in there is chosen by whatever last wrote to the volume. What is
        retained here is bounded by construction — the ids the order file names
        (bounded by the order ceiling) plus MAX_STRANGERS_SWEPT of everything
        else — while the WALK is not, on purpose (see MAX_STRANGERS_SWEPT).

        SYMLINKS ARE NOT FOLLOWED. A symlink to a directory would otherwise read
        as a job directory, be read through, and never be removed —
        `shutil.rmtree` refuses a symlink and `ignore_errors` would swallow the
        refusal, so it would sit there for the life of the volume. Not followed,
        it is a stranger like any other and `_sweep_strangers` unlinks it.
        """
        present, orphans, others = set(), [], []
        unscanned = 0
        try:
            with os.scandir(self.root) as entries:
                for entry in entries:
                    name = entry.name
                    if name == ORDER_NAME:
                        continue
                    try:
                        looks_like_a_job = entry.is_dir(follow_symlinks=False)
                    except OSError:
                        # `DirEntry.is_dir` swallows the errors that mean "no"
                        # and raises the ones that mean "the volume would not
                        # say" — which is not a reason to refuse to start.
                        continue
                    if looks_like_a_job and SAFE_JOB_ID.match(name):
                        if name in order:
                            present.add(name)
                            continue
                        target = orphans
                    else:
                        target = others
                    if len(orphans) + len(others) < MAX_STRANGERS_SWEPT:
                        target.append(name)
                    else:
                        unscanned += 1
        except OSError:
            logger.exception(
                f"the job registry in {self.root} could not be listed; this hub "
                f"starts with no job history rather than not at all")
        return present, orphans, others, unscanned

    def _rewrite_locked(self, stranded: set) -> None:
        """Put every record just read back on the volume. Caller holds the lock.

        BEST EFFORT, one record at a time, because this runs on the path that
        must not raise — but not optional: everything `_read_record` normalized
        lives only in memory until this writes it, and memory is not what the
        next start reads.

        WHAT MAY BE FIXED HERE IS PER-RECORD, and that is a rule rather than an
        observation about today's fields. This loop has one stopping place per
        job and the model chooses which one it stops at, so anything shared
        BETWEEN records would come back half converted — which is exactly how
        the creation order was damaged before it was moved out into
        `ORDER_NAME`. A field whose meaning depends on another record's field
        does not belong in a record; it belongs in something written with one
        rename.

        The failure that made this loop necessary in the first place was
        `created`: a stamp dated in the future is pulled back to now by
        `_created`, but a record that is already terminal was never rewritten,
        so the volume kept 2999 and the next start pulled it back to the new
        "now" again. The age ceiling could not reach it as long as the hub
        restarted more often than once every MAX_JOB_AGE_SECONDS, i.e. always.

        A record that cannot be written back is DROPPED from memory only if this
        run is the one that failed it. That asymmetry is deliberate: a job whose
        failure did not reach the volume comes back `queued` or `building` at the
        next start regardless, so keeping it here would only make this run
        disagree with the next one about a job nobody can do anything for. A
        record that was already terminal is kept — the volume holds a stale copy
        of it, which is what the next start will normalize again, and forgetting
        it here would 404 a job whose log is still there.
        """
        for record in list(self._records.values()):
            try:
                self._write(record)
            except (OSError, ValueError):
                logger.exception(
                    f"job {record['id']}: the record read off the volume could "
                    f"not be written back in the shape this hub uses")
                if record["id"] in stranded:
                    self._records.pop(record["id"], None)

    def _drop_surplus(self, job_ids) -> None:
        """Remove the jobs no order this hub wrote could name, without reading.

        These are the OLDEST entries of the order file, past
        `_max_order_entries` — wider than `max_jobs`, and the width is the
        point. Deleting by POSITION before the read is only the same removal
        `_prune_locked` makes if every record can be read; one that cannot never
        reaches `_prune_locked` to be counted, and a cut at `max_jobs` therefore
        paid for a corrupted record with a real job at the other end. At
        `_max_order_entries` it cannot: that is the longest order the hub itself
        can have produced.

        Which is also why this is normally a no-op — `_read_order` truncates to
        the same number — and why it stays: `_load`'s bound on what it reads
        belongs in `_load`, and this is that bound made local.
        """
        if not job_ids:
            return
        for job_id in job_ids:
            shutil.rmtree(self.root / job_id, ignore_errors=True)
        logger.info(
            f"{len(job_ids)} job(s) past the longest order this hub could have "
            f"written ({self._max_order_entries} entries) were removed at "
            f"startup")

    def _sweep_strangers(self, names, *, unscanned: int = 0) -> None:
        """Remove what is under `data/jobs/` and is not a job, once it is old.

        WHAT THIS ACTUALLY COVERS, stated as what it is rather than as a
        guarantee it cannot give: every entry the scan met that this registry
        does not hold as a job — a directory with no readable record in it, a
        job-shaped directory the order file does not name and the ceiling left
        no room to adopt, a name of any other shape, a stray file, a symlink.
        Not `ORDER_NAME`, which is the registry's own. It is what keeps MAX_JOBS
        from bounding only the records the hub can READ while everything it
        cannot read accumulates beside them for the life of the volume.

        WHAT IT DOES NOT COVER is the entries past MAX_STRANGERS_SWEPT: they are
        counted and reported, and the next start meets them again. That is a
        rate rather than a hole — a flood is collected over several starts —
        and the alternative was a list whose length the volume chooses.

        BY AGE, and by the same age the records get. Not at once, because a
        directory with no record may be somebody's evidence about a build that
        misbehaved, and being unreadable is not proof of who wrote it. At
        STARTUP only, because that is the one moment this module reads the
        volume at all — a sweep per `create` would be a directory scan on the
        push path, and the ceiling this defends is a long-term one.

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

        AN mtime IN THE FUTURE IS TREATED AS OLD, which is this method's version
        of `_created` and the reverse of it. The mtime is a value a build sets
        freely, and one dated 2999 is never past any cutoff, so a directory
        carrying it would be immune for the life of the volume — the age ceiling
        beaten by a date rather than by anything the hub did. What cannot be
        done here is `_created`'s answer: a record's stamp is corrected and the
        corrected value written back, but the mtime IS the evidence, so writing
        a corrected one back would destroy the thing this method is being
        careful about. So it is not corrected — a date in the future simply buys
        no immunity.
        """
        now = time.time()
        cutoff = now - self.max_age_seconds
        # `min`, so a registry configured with an age ceiling SHORTER than the
        # store's hour does not accidentally grant its own half-written files a
        # longer life than the records they belong to.
        tmp_cutoff = now - min(self.max_age_seconds, LEFTOVER_MAX_AGE_SECONDS)
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
                f"registry were removed as past the job age ceiling, {kept} "
                f"kept until they reach it, {unscanned} not examined this start")

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
        runs to megabytes and there are up to MAX_JOBS of them, and it is
        fetched roughly once per push. `_write_log` caps what the hub itself
        puts there, so what this ceiling is really for is everything else: the
        directory is writable by every build (see the module docstring), so the
        size of the file that comes back is not a number this hub gets to
        decide.

        THE TRUNCATION IS NOT WRITTEN BACK, and that is the one deliberate
        exception to the rule `_load` follows for records. It can be, because
        nothing here accumulates: the cap bounds every single read, and the
        oversized file itself is bounded by retention, which removes the whole
        job directory. A record was the opposite case — the planted value came
        back at the next START and defeated the ceiling that was supposed to
        collect it. And a log is EVIDENCE about a build that misbehaved, so
        rewriting one to make a read cheaper would destroy the thing somebody
        came to look at.
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
            # NO ORDERING FIELD, deliberately: which job came first is expressed
            # by the position of its id in `ORDER_NAME` and nowhere else. See
            # that constant for why a number per record could not hold it.
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
            # memory until the process ends — `_prune_locked` only ever drops a
            # TERMINAL job, and nothing is ever going to finish this one. In
            # this order the caller gets the exception with no trace in memory,
            # and the empty directory left on the volume is collected by
            # `_sweep_strangers` at a later start.
            self._write(record)
            self._records[job_id] = record
            # After the insert, never before: pruning first would leave room for
            # MAX_JOBS + 1, and pruning after keeps the newest by construction.
            # This sweep is what bounds a hub nobody pushes to often enough for
            # the age ceiling to matter; `finish` runs the other one.
            self._prune_locked()
            # The set of jobs changed — one added, and possibly some pruned — so
            # the order on the volume is now a start behind. BEST EFFORT, unlike
            # the record write above, and the difference is which failure is
            # survivable: the job now EXISTS, in memory, and a build is about to
            # run for it, so a 500 here would refuse a push that is already
            # under way. What the missed write costs is that the next start
            # finds this job with no place in the order and reads it as the
            # oldest — the fallback `_load` documents, and the very definition
            # of "no worse than before the attempt".
            self._commit_order_locked()
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
                # Dropped between the two sections above, which takes a second
                # `finish` for a job that was already terminal — retention never
                # touches a live one. Nothing is left behind by it: the prune
                # removed the whole job directory, and `atomic_write_bytes` does
                # not create a parent, so the log write above either landed
                # before the prune and went with it, or failed with ENOENT and
                # was logged. There is no orphaned log.txt on either path.
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
            # Here as well as in `create`, and both are needed for the ceiling to
            # mean what it says. Retention only ever drops FINISHED jobs, so a
            # sweep at creation cannot count the job that is about to finish —
            # pruning only there leaves one extra behind per build in flight.
            if self._prune_locked():
                # Only when something was actually dropped. `finish` does not
                # change the ORDER — the record it just updated keeps its place
                # — so an unconditional write here would be one fsync per build
                # for a file whose contents did not move.
                self._commit_order_locked()

    # -- disk --------------------------------------------------------------
    def _write(self, record: dict) -> None:
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
            json.dumps(record, indent=1, ensure_ascii=False,
                       allow_nan=False).encode("utf-8"),
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

    def _commit_order_locked(self) -> None:
        """Put the creation order on the volume. ONE write. Caller holds the lock.

        `self._records` is in creation order (`create` appends, `_load` inserts
        oldest first), so the order is `list(self._records)` and nothing has to
        be computed to find it.

        BEST EFFORT, like every other write here except `create`'s first one —
        but unlike the others, its failure mode is the property this module is
        built around. `atomic_write_bytes` writes a temporary file and renames
        it, so this either replaces the order completely or leaves the previous
        one completely: there is no state in which half the registry is ordered
        by this call and half by the last one. A call that fails costs the
        registry the changes since the last successful write — the newest job
        has no place and is read as the oldest, older ones keep the places they
        had — and costs it nothing else. That is the whole reason the order is
        here rather than a field in each of N records.
        """
        try:
            atomic_write_bytes(self.root / ORDER_NAME,
                               _order_bytes(self._records))
        except (OSError, ValueError):
            logger.exception(
                f"the creation order could not be written to {self.root}; the "
                f"next start reads the last one that landed, and any job "
                f"created since then as the oldest")

    def _write_log(self, job_id: str, log: str) -> None:
        # Cut on the WAY IN, not only on the way out. MAX_LOG_BYTES is what the
        # read path is willing to serve, so anything written past it comes back
        # truncated under a warning about a log larger than a build can produce
        # — and on this path the hub itself wrote it. The ceiling is derived to
        # fit the worst case a build can hand over (see MAX_LOG_BYTES), so this
        # cut is unreachable for a log this hub captured; it is what keeps the
        # file inside the ceiling anyway on the day either number moves.
        raw = log.encode("utf-8", errors="replace")
        if len(raw) > MAX_LOG_BYTES:
            note = LOG_TRUNCATED_NOTE.encode("utf-8")
            # A slice of UTF-8 bytes is not necessarily UTF-8: the cut can land
            # inside a multi-byte sequence. Decoding with `errors="ignore"` and
            # encoding back drops exactly that stump, so what is stored is
            # always something a reader can decode.
            raw = (raw[:MAX_LOG_BYTES - len(note)]
                   .decode("utf-8", errors="ignore").encode("utf-8")) + note
        atomic_write_bytes(self.root / job_id / LOG_NAME, raw,
                           tmp_dir=self.root)

    def _prune_locked(self) -> list:
        """Drop jobs that are too old or too many. -> the ids it dropped.

        Caller holds the lock. The ids come back because dropping a job changes
        the registry's ORDER, and the caller is the one that decides whether to
        put the new one on the volume (`_commit_order_locked`).

        Oldest first is INSERTION ORDER, not the `created` stamp, and the
        difference is not academic: `utcnow_iso` has second resolution, so a
        burst of pushes shares one timestamp, and sorting by it would put the
        tiebreak — whatever it was — in charge of which of them survives. A hub
        under a CI storm is exactly when that burst happens, and the visible
        symptom would be the newest job of the second being the one that
        disappeared. `_load` restores that same order across a restart from
        `ORDER_NAME`, which is why that file exists at all: `created` provably
        cannot express the order, so a restart that sorted by the stamp would
        break retention exactly in the case this paragraph is about.

        A job that has not FINISHED is never dropped, whichever ceiling it falls
        foul of. Retention is here to stop old evidence accumulating, and a build
        that is still running is not evidence of anything yet — deleting it would
        take a live job's status and log out from under the pusher who is at that
        moment polling them. The cost is that both ceilings can be exceeded by
        however many jobs are in flight, which is the pool plus the queue and
        nothing more.
        """
        ordered = [record for record in self._records.values()
                   if record.get("state") in TERMINAL_STATES]
        cutoff = time.time() - self.max_age_seconds
        doomed = [record["id"] for record in ordered
                  if _epoch(record.get("created")) < cutoff]
        # Built ONCE. Inline in the comprehension below it was rebuilt per
        # record, which is MAX_JOBS x MAX_JOBS on a full registry — and this runs
        # on the push path, from `create` and again from `finish`.
        condemned = set(doomed)
        keep = [record for record in ordered if record["id"] not in condemned]
        overflow = len(keep) - self.max_jobs
        if overflow > 0:
            doomed += [record["id"] for record in keep[:overflow]]
        for job_id in doomed:
            self._records.pop(job_id, None)
            shutil.rmtree(self.root / job_id, ignore_errors=True)
        return doomed


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
    # `create_server`'s two keyword arguments — and a pool built LARGER than the
    # module defaults would put more jobs in flight than `JobStore` allows for
    # when it sizes the ceiling on `order.json`, so the hub would refuse a file
    # it had written itself, on every start. Made real numbers, they belong in
    # `Settings` and `JobStore._max_order_entries` has to follow them.
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
                # for ever, which is the one state retention cannot reclaim
                # (`_prune_locked` drops only terminal jobs) and which therefore
                # holds a MAX_JOBS slot until the hub is restarted.
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
        entries older than LEFTOVER_MAX_AGE_SECONDS — an hour — while a
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
        what lets `_finish_staging`, the atomic rename, `latest`, retention and
        the pickers stay as they are.

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


def _read_record(path: Path) -> dict | None:
    """One `job.json`, rebuilt into the shape this module writes. None if it is
    not one.

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
      * a `state` outside KNOWN_STATES: neither running nor finished, so
        retention never drops it and `_load` never fails it, and it counts
        against MAX_JOBS permanently;
      * an `id` that is not the directory's name, which points one job's record
        at another job's log. The caller compares them; this is what makes the
        comparison possible by guaranteeing the field is a string of the right
        shape at all.

      * a `created` dated in the future, which no cutoff is ever past, so
        retention could never reach the record and MAX_JOBS would count it for
        the life of the volume (`_created`).

    A NUMBER is normalized rather than fatal — so is that stamp — while an
    unusable `state` or `id` throws the whole record away, and the asymmetry is
    deliberate: `None` is a value every numeric field here already has ("not
    measured") and "now" is the truthful reading of a date this hub cannot
    believe, so the record can be ADOPTED — failed like any other stranded job,
    counted by retention and eventually swept, directory and all. A state or an
    id would have to be guessed instead, so guessing less means collecting more.

    "ADOPTED" IS A CLAIM ABOUT THE VOLUME, not about this function: everything
    corrected here is corrected in memory, and `_load` is what puts it back on
    disk. Without that half the sentence above is false for the age ceiling —
    the planted stamp is still there at the next start, and a record that is
    re-corrected on every start is never swept at all. Anything added to this
    rebuild inherits the same requirement.

    None means "not a record this hub wrote". The caller does not delete the
    directory on the spot — it is somebody's evidence, and being unreadable is
    not proof of who put it there — but it does not leave it for ever either:
    `_sweep_strangers` collects it once it is past the same age ceiling the
    records get.
    """
    raw = _read_capped(path, MAX_RECORD_BYTES)
    if raw is None:
        return None
    try:
        loaded = json.loads(raw)
    except (ValueError, RecursionError):
        return None
    if not isinstance(loaded, dict):
        return None
    job_id = loaded.get("id")
    if not isinstance(job_id, str) or not SAFE_JOB_ID.match(job_id):
        return None
    if loaded.get("state") not in KNOWN_STATES:
        return None
    return {
        "id": job_id,
        "pid": _text(loaded.get("pid")),
        "commit": _text(loaded.get("commit")),
        "state": loaded["state"],
        "created": _created(loaded.get("created")),
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
        # The creation order is not like that — it is a statement ABOUT the set —
        # and a per-record copy of it made a partial write mix two orders. It
        # lives in `ORDER_NAME` now, and a field that would need the same
        # all-or-nothing must go there too rather than be added here.
    }


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


def _order_bytes(job_ids) -> bytes:
    """The creation order as the bytes that go on the volume, oldest first.

    A JSON object rather than a bare array, so a later version of this file can
    say something else about the registry without the reader having to guess
    which shape it is looking at.

    `indent=1`, like a record: this is a file somebody will read with `cat` when
    they are trying to work out why retention dropped what it dropped, and 200
    ids on one line is not that file. It costs about two bytes per entry against
    the compact separators, which ORDER_ENTRY_BYTES already covers twice over.
    """
    return json.dumps({"jobs": list(job_ids)}, indent=1, ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def _read_order(path: Path, max_entries: int, max_bytes: int) -> list | None:
    """The creation order off the volume, oldest first. None if there is none.

    Rebuilt rather than believed, exactly like a record, because this file is on
    the same volume every build can write. What comes back is a list of
    well-shaped, DISTINCT ids and nothing else — and the thing worth noticing is
    what is not in it: a magnitude. That is the whole reason the order is a list
    rather than a number per record. A number off this volume has to be clamped
    into some range to stop it being absurd; the clamp is what collapsed a
    planted number into a tie with real ones; and the renumbering that answered
    the collapse is what had to reach every record to be true, which is the
    write that could land only partly. An order written down AS an order carries
    ordinal information and nothing else, so there is nothing in it to be
    absurd: an id naming no directory is dropped, a directory named by no id is
    read as the oldest, and neither moves anything else.

    THE TAIL survives the entry ceiling, not the head: the newest jobs are at the
    end and they are the ones retention keeps. Duplicates are dropped keeping the
    OLDEST position, which is the same safe end `_load` puts a stranger at.

    None IS RETURNED FOR EVERY FAILURE — missing file, unreadable, over the byte
    ceiling, not JSON, not the right shape — rather than a best guess at what
    the file was trying to say. Losing the order WHOLESALE costs the hub one
    thing it can recompute the shape of; believing a partly-damaged one is a
    reordering nobody would find out about, and there is no version of this
    function that can tell the difference from inside.

    NONE AND THE EMPTY LIST ARE STILL DIFFERENT VALUES, but the difference is
    narrower than it looks and was once read too widely: it is about whether to
    BELIEVE a damaged order, not about whether the caller announces one. An
    empty order beside job directories is the same total loss as a missing file
    — every one of them becomes a stranger — so `_load` says so for both, and
    planting `{"jobs": []}` is no quieter than deleting the file.

    WHAT NONE IS NOT is a defence against a build rewriting this file. A
    well-formed order of real ids, permuted, comes back from here intact and is
    believed; see `ORDER_NAME` for why that is accepted rather than solved.
    """
    raw = _read_capped(path, max_bytes)
    if raw is None:
        return None
    try:
        loaded = json.loads(raw)
    except (ValueError, RecursionError):
        return None
    if not isinstance(loaded, dict):
        return None
    jobs = loaded.get("jobs")
    if not isinstance(jobs, list):
        return None
    order, seen = [], set()
    for item in jobs[-max_entries:]:
        if not isinstance(item, str) or not SAFE_JOB_ID.match(item):
            continue
        if item in seen:
            continue
        seen.add(item)
        order.append(item)
    return order


def _created(value) -> str | None:
    """The creation stamp, with one dated in the FUTURE pulled back to now.

    The age ceiling is what bounds `data/jobs/` on a hub nobody pushes to, and
    the stamp it measures is a string on a volume every build can write. A
    record dated 2999 is never older than any cutoff, so retention could not
    reach it and it would count against MAX_JOBS for the life of the volume —
    the ceiling defeated by a date rather than by anything the hub does.

    Pulled back rather than thrown away, for the same reason a non-finite number
    is: a record that is dropped stays on the volume for good, while one that is
    adopted can be failed, counted and eventually swept. "Now" is also the
    truthful reading — it is when this hub first saw the record.

    AND THE PULL-BACK ONLY WORKS BECAUSE `_load` WRITES IT DOWN. Corrected in
    memory alone it bought nothing: the volume still said 2999, so the next
    start read that and pulled it back to a fresh "now" all over again, and the
    age ceiling could never reach the record as long as the hub restarted more
    often than once every MAX_JOB_AGE_SECONDS — which is to say always.

    An UNREADABLE stamp is left exactly as it is: `_epoch` already reads it as
    0.0, the oldest possible, so retention takes it at the first opportunity,
    which is the right end to fail towards. It reaches the volume unchanged, and
    that is fine precisely because it does not survive to be read twice.
    """
    text = _text(value)
    if text is None:
        return None
    return utcnow_iso() if _epoch(text) > time.time() else text


def _epoch(stamp) -> float:
    """`utcnow_iso` back into seconds. Unreadable sorts oldest, so it is swept.

    The `except` is wide because the argument comes off a volume every build can
    write, and there is more to a stamp than a parse: `datetime.timestamp()`
    raises `OverflowError` or `OSError` on the extreme years, depending on the
    platform's own conversion. This runs from `_prune_locked` <- `_load` <-
    `JobStore.__init__` <- `create_server` <- `main()`, so anything escaping it
    is the failure `_read_record` exists to prevent: a hub that does not start,
    from the same volume, every time.
    """
    try:
        return (datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ")
                .replace(tzinfo=timezone.utc).timestamp())
    except (TypeError, ValueError, OverflowError, OSError):
        return 0.0
