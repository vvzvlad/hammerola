"""Taking a push asynchronously: 202, a job, a status and a log (SPEC 8A.2 step 5).

The rest of the suite pushes through `Hub.publish`, which waits for the job and
reports what it decided — because the rest of the suite is about what ends up on
disk. This file is about the HANDOVER itself, so everything here goes through
`publish_async` and looks at the job.

Two claims are worth stating before the tests, because they are what the file is
really pinning down:

  * a push is answered from what the UPLOAD says and nothing else. The token, the
    size, the archive and "is this exact push already published" are all decided
    in the request, so a broken archive is still a 4xx on the push. Everything
    that needs the BUILD — and only that — moves into a job.
  * a build that fails publishes nothing. `latest` does not move, the local slot
    is not touched, no build directory appears, and the pusher is told why with
    the log the build produced.
"""

import builtins
import errno
import inspect
import json
import os
import queue
import signal
import threading
import time
from pathlib import Path

import httpx
import pytest
from harness import (DEFAULT_EXPORTS, TOKEN, PublishReply, copying_builder,
                     failing_builder, good_build, meta_bytes, start_hub,
                     stop_hub, tar_gz, view_bytes)
from loguru import logger

from src import jobs as jobs_module
from src.buildproc import (STATUS_FAILED, STATUS_LIMITS_ERROR, STATUS_OK,
                           Limits, run_build)
from src.jobs import (HANDOVER_ERROR, LOG_TRUNCATED_NOTE,
                      MAX_LOG_BYTES, MAX_RECORD_BYTES,
                      QUEUE_FULL_RETRY_AFTER_SECONDS, RESTART_CODE,
                      STATE_BUILDING, STATE_DONE, STATE_FAILED, STATE_QUEUED,
                      STOPPED_ERROR, SUBMIT_ACCEPTED, SUBMIT_STOPPED,
                      WORKER_THREAD_PREFIX, BuildQueue, BuildTask, JobStore,
                      build_arguments)
from src import store as store_module
from src.store import (BODY_PREFIX, JSON_TMP_PREFIX, LEFTOVER_PREFIXES,
                       SOURCE_PREFIX, PublishError, Store, utcnow_iso)

# TOKEN comes from the harness rather than being spelled again here: the hub
# under test is built with that value, and a copy of it in this file was one
# rename away from a suite that asserted 401 for the right reason by accident.


def _leftovers(hub, pid):
    """Every transient of a push, wherever it could still be sitting."""
    found = [p.name for p in hub.data.iterdir()
             if p.name.startswith(LEFTOVER_PREFIXES)]
    project = hub.project_dir(pid)
    if project.is_dir():
        found += [p.name for p in project.iterdir()
                  if p.name.startswith(LEFTOVER_PREFIXES)]
    return found


def _plant_job(data, job_id, **fields):
    """Write a job.json by hand — the way a BUILD can, and that is the point.

    `data/jobs/` is on the volume, and the volume is fully writable by every
    build (src/buildproc/__init__.py, SPEC 8A.4). So every field here is
    attacker-controlled in the only sense that matters, and `json.dumps` is
    called with its default `allow_nan=True` on purpose: that is exactly the
    asymmetry — Python writes `NaN` happily and the hub's own writer refuses it.
    """
    directory = Path(data) / "jobs" / job_id
    directory.mkdir(parents=True, exist_ok=True)
    record = {"id": job_id, "pid": "proj1", "commit": "abc123",
              "state": STATE_BUILDING, "created": utcnow_iso(),
              "started": None, "finished": None, "status": None, "code": None,
              "build_url": None, "error": None, "log_truncated": False,
              "duration_seconds": None}
    record.update(fields)
    (directory / "job.json").write_text(json.dumps(record), encoding="utf-8")
    return directory


def _job_dirs(data):
    """The job directories on the volume, by name."""
    return sorted(entry.name for entry in (Path(data) / "jobs").iterdir()
                  if entry.is_dir())


def _volume_records(data):
    """Every job.json as it really is ON THE VOLUME — not as memory has it.

    The distinction is the whole subject of several tests below: `_read_record`
    and `_load` normalize what they read, and a normalization that stays in
    memory leaves the planted value on disk for the next start to read again.
    `JobStore.get` cannot see that, because it answers from memory by design.
    """
    jobs_dir = Path(data) / "jobs"
    return {entry.name: json.loads((entry / "job.json").read_text())
            for entry in sorted(jobs_dir.iterdir())
            if (entry / "job.json").exists()}


def _live_workers():
    """The build threads alive right now, by the name the pool gives them."""
    return sorted(thread.name for thread in threading.enumerate()
                  if thread.name.startswith(WORKER_THREAD_PREFIX))


def _await_no_workers(timeout=10):
    """Wait for a released pool to actually finish, before the guard looks.

    A test that stops a pool while its builds are gated has to hand the workers
    back to the interpreter itself: `shutdown` has already forgotten them by
    then, so nothing else joins them and the autouse guard in conftest would
    otherwise fail whichever test ran next.
    """
    deadline = time.monotonic() + timeout
    while _live_workers() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert _live_workers() == []


def _bare_store(data):
    """A Store on `data`, without a server around it."""
    return Store(data_dir=data, max_build_bytes=8 * 1024 * 1024)


def _accepted_body(data, index):
    """The pushed BODY a task owns beside its unpacked tree.

    Not a real archive: nothing on the paths these tests drive ever reads it.
    What matters is that the file EXISTS, because every ending in `BuildQueue`
    promises either to remove it or to hand it to the store, and a test passing a
    name that points at nothing could not tell a removal from a no-op.
    """
    body = data / f"{BODY_PREFIX}{index:032x}"
    body.write_bytes(b"a pushed body")
    return body


def _staged(store, pid, commit, marker):
    """A finished build's output, sitting in its staging directory."""
    staging = store.build_staging(pid, commit)
    staging.mkdir()
    (staging / "meta.json").write_bytes(meta_bytes())
    (staging / "assembled.json").write_bytes(view_bytes(marker))
    # The exports the default catalogue names: a printable that declares none is
    # a 422, so a "finished build's output" that left them out is not one.
    for name, data in DEFAULT_EXPORTS.items():
        (staging / name).write_bytes(data)
    return staging, ("meta.json", "assembled.json", *DEFAULT_EXPORTS)


class _CountedHandle:
    """A file object that remembers the size argument every read was given.

    Enough of one for `_read_capped`, which opens, reads once and leaves. What
    it is for is the difference between "the file was refused" and "the file was
    refused without being read" — the second is the claim a byte ceiling on a
    volume somebody else writes to actually makes.
    """

    def __init__(self, handle, sizes):
        self._handle = handle
        self._sizes = sizes

    def read(self, size=-1):
        self._sizes.append(size)
        return self._handle.read(size)

    def __enter__(self):
        return self

    def __exit__(self, *exception):
        return self._handle.__exit__(*exception)


class GatedBuilder:
    """A builder that stops in the middle, so a test can look at a live job.

    Also counts how many builds are in it at once, which is the only way to
    observe that build parallelism is its own number rather than the accept one.
    """

    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.running = 0
        self.peak = 0
        self.started = 0
        self._lock = threading.Lock()

    def __call__(self, project_dir, out_dir, *, pid, **kw):
        with self._lock:
            self.running += 1
            self.started += 1
            self.peak = max(self.peak, self.running)
        self.entered.set()
        try:
            assert self.release.wait(timeout=30), "the test never released the build"
        finally:
            with self._lock:
                self.running -= 1
        return copying_builder(project_dir, out_dir, pid=pid)


class SwitchableBuilder:
    """Copies the tree, until a test flips it into refusing."""

    def __init__(self):
        self.fail = False
        self.status = STATUS_FAILED
        self.log = "build failed: the model has no printables\n"

    def __call__(self, project_dir, out_dir, *, pid, **kw):
        if self.fail:
            return failing_builder(status=self.status, log=self.log)(
                project_dir, out_dir, pid=pid)
        return copying_builder(project_dir, out_dir, pid=pid)


class RecordingBuilder:
    """Copies the tree and remembers exactly what it was handed."""

    def __init__(self):
        self.seen = None

    def __call__(self, project_dir, out_dir, *, pid, **kw):
        self.seen = {
            "pid": pid,
            "project_dir": Path(project_dir),
            "out_dir": Path(out_dir),
            "out_dir_existed": Path(out_dir).exists(),
            "sources": sorted(p.name for p in Path(project_dir).iterdir()),
        }
        return copying_builder(project_dir, out_dir, pid=pid)


@pytest.fixture
def gated_hub(tmp_path):
    """A hub whose builds stop until the test lets them go. One worker."""
    builder = GatedBuilder()
    hub = start_hub(tmp_path / "data", build_runner=builder, build_workers=1)
    hub.builder = builder
    try:
        yield hub
    finally:
        # Released before the hub is closed, always: `server_close` waits for a
        # worker that is mid-build, so a test that failed early would otherwise
        # hang for the join timeout and then fail again on the worker guard.
        builder.release.set()
        stop_hub(hub)


# -- the handover ------------------------------------------------------------
def test_a_push_is_accepted_with_202_and_a_job_to_follow(hub):
    reply = hub.publish_async("proj1", "abc123", good_build())
    assert reply.status_code == 202
    body = reply.json()
    assert set(body) == {"job", "status_url", "log_url"}

    job_id = body["job"]
    # Unguessable, not sequential: the id is the only thing between one pusher's
    # build log and another's, and a counter would let anyone walk the lot.
    assert len(job_id) == 22
    assert body["status_url"] == f"/api/v1/jobs/{job_id}"
    assert body["log_url"] == f"/api/v1/jobs/{job_id}/log"
    # `Location` says the same thing in the header the status code is about.
    assert reply.headers["Location"] == body["status_url"]

    second = hub.publish_async("proj1", "def456", good_build("second"))
    assert second.json()["job"] != job_id

    for pending in (job_id, second.json()["job"]):
        hub.await_job(pending)


def test_the_job_goes_queued_then_building_then_done(gated_hub):
    hub = gated_hub
    first = hub.publish_async("proj1", "aaa111", good_build("one")).json()["job"]
    assert hub.builder.entered.wait(timeout=10)

    # One worker, and it is inside the first build, so the second push cannot
    # have started: it is queued, which is a state of its own precisely because
    # "not finished" covers two very different situations.
    second = hub.publish_async("proj1", "bbb222", good_build("two")).json()["job"]
    assert hub.job(first).json()["state"] == STATE_BUILDING
    assert hub.job(second).json()["state"] == STATE_QUEUED

    building = hub.job(first).json()
    assert building["pid"] == "proj1"
    assert building["commit"] == "aaa111"
    assert building["created"] and building["started"]
    assert building["finished"] is None
    assert building["build_url"] is None

    hub.builder.release.set()
    done = hub.await_job(first).record
    assert done["state"] == STATE_DONE
    assert done["code"] == 201
    assert done["status"] == STATUS_OK
    assert done["build_url"] == "/project/proj1/aaa111/"
    assert done["error"] is None
    assert done["finished"] and done["duration_seconds"] is not None
    hub.await_job(second)


def test_a_successful_build_publishes_exactly_as_it_used_to(hub):
    reply = hub.publish_async("proj1", "abc123", good_build())
    record = hub.await_job(reply.json()["job"]).record

    assert record["state"] == STATE_DONE
    build = hub.project_dir("proj1") / "abc123"
    assert (build / "meta.json").is_file()
    assert (build / "assembled.json").is_file()
    assert os.readlink(hub.project_dir("proj1") / "latest") == "abc123"
    assert json.loads((hub.project_dir("proj1") / "builds.json").read_text()
                      )["builds"][0]["commit"] == "abc123"
    assert json.loads((hub.data / "index.json").read_text())[0]["pid"] == "proj1"
    assert hub.get(record["build_url"]).status_code == 200
    # And nothing of the machinery is left behind on the volume.
    assert _leftovers(hub, "proj1") == []


def test_the_local_slot_goes_through_the_same_job(hub):
    reply = hub.publish_async("proj1", "dev", good_build("local"))
    assert reply.status_code == 202
    record = hub.await_job(reply.json()["job"]).record

    assert record["commit"] == "dev"
    assert record["build_url"] == "/project/proj1/dev/"
    assert (hub.project_dir("proj1") / "dev" / "meta.json").is_file()

    # Every assertion below is the difference between the worker having taken
    # the slot route and having taken the commit one. The URL alone cannot tell
    # them apart — a commit build called `dev` would answer at the same address
    # — so what is checked is the machinery only `publish` runs: `latest` moves,
    # the project gets an index CARD and the build appears in the picker's
    # list. None of that may happen for the local slot (SPEC 7.6).
    #
    # The index is asserted on its CONTENT and not on the file's absence: a local
    # push rewrites index.json now, because a card has to be able to say that a
    # project's slot is occupied. What it may never do is put a card there, and
    # this project has no commit build, so there is none.
    assert not (hub.project_dir("proj1") / "latest").exists()
    assert json.loads((hub.data / "index.json").read_text()) == []
    picker = json.loads((hub.project_dir("proj1") / "builds.json").read_text())
    assert picker["builds"] == []
    assert picker["has_dev"] is True
    assert picker["latest"] is None


def test_an_answer_that_needs_no_build_is_given_on_the_push(hub):
    """200 and 409 stay on the push, and cost no build at all.

    Rebuilding a commit that is already on disk would spend minutes of CPU to
    arrive at an answer that was on disk all along — and CI, which retries, is
    exactly the caller that would pay for it.
    """
    body = good_build()
    assert hub.publish("proj1", "abc123", body).status_code == 201

    retry = hub.publish_async("proj1", "abc123", body)
    assert retry.status_code == 200
    assert retry.json() == {"url": "/project/proj1/abc123/"}
    assert "job" not in retry.json()

    clash = hub.publish_async("proj1", "abc123", good_build("different"))
    assert clash.status_code == 409

    # Neither of them left an unpacked tree waiting for a worker.
    assert _leftovers(hub, "proj1") == []


def test_a_broken_archive_is_refused_on_the_push_and_never_becomes_a_job(hub):
    """An archive that is not an archive needs no build to be refused."""
    before = len(list((hub.data / "jobs").iterdir()))
    assert hub.publish_async("proj1", "abc123", b"not a tarball").status_code == 422
    assert len(list((hub.data / "jobs").iterdir())) == before
    assert _leftovers(hub, "proj1") == []


# -- what the build is handed ------------------------------------------------
def test_the_build_gets_the_sources_and_a_separate_output_directory(hub_factory):
    """The tree the model wrote into may not be the tree that gets published.

    The sources are unpacked into one directory and the build writes into
    another, which is the one that is renamed onto `<pid>/<commit>`. Anything a
    model puts in the tree it was GIVEN therefore reaches nobody unless the build
    deliberately writes it as output.
    """
    recorder = RecordingBuilder()
    hub = hub_factory(build_runner=recorder)
    assert hub.publish("proj1", "abc123", good_build()).status_code == 201

    seen = recorder.seen
    assert seen["pid"] == "proj1"
    assert seen["project_dir"] != seen["out_dir"]
    assert seen["sources"] == sorted(
        ["assembled.json", "meta.json", *DEFAULT_EXPORTS])
    # The sources sit at the root of the data directory, under a dot name the
    # file server refuses; the output sits inside the project, because that is
    # where it has to be for the publish to be one rename.
    assert seen["project_dir"].parent == hub.data
    assert seen["project_dir"].name.startswith(".src-")
    assert seen["out_dir"].parent == hub.project_dir("proj1")
    assert seen["out_dir"].name.startswith(".tmp-")
    # And the build creates its own output directory (cadbuild.build insists on
    # a clean one), so the hub must not have created it first.
    assert not seen["out_dir_existed"]


def test_build_parallelism_is_its_own_number(gated_hub):
    """Accepting is not building, and the two ceilings are separate.

    Four pushes are accepted while ONE build runs: the accept slots are sized by
    a body on disk and a tar reader, the build pool by cores. A test that only
    counted accepted pushes could not tell the two apart, so this counts how many
    builds were inside the builder at once.
    """
    hub = gated_hub
    accepted = [hub.publish_async("proj1", f"c{n}", good_build(f"v{n}"))
                for n in range(4)]
    assert [r.status_code for r in accepted] == [202] * 4
    assert hub.builder.entered.wait(timeout=10)
    time.sleep(0.2)  # long enough for a second worker to have started, if any

    assert hub.builder.peak == 1, (
        "more builds ran at once than the pool was given workers")
    hub.builder.release.set()
    for reply in accepted:
        assert hub.await_job(reply.json()["job"]).status_code == 201


def test_a_full_queue_is_refused_with_503_and_a_retry_after(tmp_path):
    """A bounded queue, because an unbounded one lies about capacity.

    A hub that accepts everything and gets to it in an hour has told CI the push
    succeeded while holding an unpacked tree per entry. 503 is the truth and CI
    already knows what to do with it.
    """
    builder = GatedBuilder()
    hub = start_hub(tmp_path / "data", build_runner=builder, build_workers=1,
                    build_queue_size=1)
    try:
        first = hub.publish_async("proj1", "c1", good_build("one"))
        assert first.status_code == 202
        assert builder.entered.wait(timeout=10)   # the worker is busy

        second = hub.publish_async("proj1", "c2", good_build("two"))
        assert second.status_code == 202          # ...and now the queue is full

        third = hub.publish_async("proj1", "c3", good_build("three"))
        assert third.status_code == 503
        assert third.headers["Retry-After"] == str(QUEUE_FULL_RETRY_AFTER_SECONDS)
        assert "queue is full" in third.json()["error"]

        # The refused push left no tree behind and no job pretending to wait: a
        # job nothing will ever pick up is a status that never changes its answer.
        states = [json.loads(p.read_text())["state"]
                  for p in sorted((hub.data / "jobs").glob("*/job.json"))]
        assert states.count(STATE_FAILED) == 1, states

        builder.release.set()
        for reply in (first, second):
            assert hub.await_job(reply.json()["job"]).status_code == 201
    finally:
        builder.release.set()
        stop_hub(hub)


@pytest.mark.parametrize("blows_up", [
    RuntimeError("the pool itself broke"),
    BrokenPipeError(errno.EPIPE, "Broken pipe"),
])
def test_a_job_the_handover_threw_under_is_failed_not_left_queued(
        tmp_path, monkeypatch, blows_up):
    """`jobs.create` has returned and `builds.submit` has not been reached.

    Every other way out of `_queue_build` answers its JOB as well as its pusher:
    the queue was full, the pool was stopping, a worker took it. This one used
    to answer only the pusher — with a 500, or with nothing at all when the
    socket had already gone — and neither is something a job can read. The
    record stayed `queued`, and nothing here ever fails a job on its own, so the
    status endpoint went on saying `queued` about a build nobody was running
    until the hub restarted.

    BOTH HANDLERS, because both are on that path and the disconnect one is the
    easier to overlook: it re-raises rather than replying, so there is no answer
    anywhere in it to notice the job is missing from.
    """
    hub = start_hub(tmp_path / "data")
    try:
        def explodes(_task):
            raise blows_up

        monkeypatch.setattr(hub.server.builds, "submit", explodes)
        try:
            reply = hub.publish_async("proj1", "abc123", good_build())
            # The ordinary failure is a 500; a client that has gone away gets
            # no reply at all, which httpx reports as a protocol error.
            assert reply.status_code == 500
        except httpx.HTTPError:
            assert isinstance(blows_up, BrokenPipeError)
        monkeypatch.undo()

        issued = _job_dirs(hub.data)
        assert len(issued) == 1, issued
        record = hub.server.jobs.get(issued[0])
        assert record["state"] == STATE_FAILED, (
            "the job stayed queued, so until the hub restarts the status "
            "endpoint answers `queued` about a build that does not exist")
        assert record["code"] == 500
        assert record["error"] == HANDOVER_ERROR
        assert record["finished"]
        # ...and the sources went with it, as on every path that did not hand
        # the tree over to a worker.
        assert _leftovers(hub, "proj1") == []
    finally:
        stop_hub(hub)


def test_a_job_a_worker_already_owns_is_not_failed_by_a_late_throw(tmp_path,
                                                                    monkeypatch):
    """The other direction, which is the one that would damage a live build.

    Once `submit` has returned SUBMIT_ACCEPTED the task belongs to a worker and
    that worker is going to answer the job itself. Anything thrown after that
    point — the log line, the reply tuple — must not fail a build that is at
    that moment running, which is why the handover failure is conditional on
    not having handed over.
    """
    hub = start_hub(tmp_path / "data")
    try:
        exploded = threading.Event()
        real_info = jobs_module.logger.info

        def explode_once(message, *args, **keywords):
            if "queued as job" in str(message) and not exploded.is_set():
                exploded.set()
                raise RuntimeError("the log itself broke")
            return real_info(message, *args, **keywords)

        monkeypatch.setattr("src.app.logger.info", explode_once)
        reply = hub.publish_async("proj1", "abc123", good_build())
        monkeypatch.undo()
        assert exploded.is_set(), "the throw never happened, so this proves nothing"
        assert reply.status_code == 500

        issued = _job_dirs(hub.data)
        assert len(issued) == 1, issued
        # The worker owned it and published it, and the push's own 500 did not
        # take that away.
        record = hub.server.jobs.get(issued[0])
        deadline = time.monotonic() + 10
        while record["state"] not in (STATE_DONE, STATE_FAILED):
            assert time.monotonic() < deadline, record
            time.sleep(0.02)
            record = hub.server.jobs.get(issued[0])
        assert record["state"] == STATE_DONE, record
        assert record["error"] is None
        assert (hub.project_dir("proj1") / "abc123").is_dir()
    finally:
        stop_hub(hub)


# -- a build that fails ------------------------------------------------------
def test_a_failed_build_moves_neither_latest_nor_the_slot(hub_factory):
    builder = SwitchableBuilder()
    hub = hub_factory(build_runner=builder)
    assert hub.publish("proj1", "good1", good_build("good")).status_code == 201
    assert hub.publish("proj1", "dev", good_build("slot")).status_code == 201
    slot_before = (hub.project_dir("proj1") / "dev" / "assembled.json").read_bytes()

    builder.fail = True
    failed = hub.publish_async("proj1", "bad1", good_build("bad"))
    record = hub.await_job(failed.json()["job"]).record
    assert record["state"] == STATE_FAILED
    assert record["status"] == STATUS_FAILED
    assert record["code"] == 422
    assert record["build_url"] is None
    assert "refused" in record["error"]

    failed_dev = hub.publish_async("proj1", "dev", good_build("bad slot"))
    assert hub.await_job(failed_dev.json()["job"]).record["state"] == STATE_FAILED

    assert not (hub.project_dir("proj1") / "bad1").exists()
    assert os.readlink(hub.project_dir("proj1") / "latest") == "good1"
    assert (hub.project_dir("proj1") / "dev" / "assembled.json"
            ).read_bytes() == slot_before
    listed = json.loads((hub.project_dir("proj1") / "builds.json").read_text())
    assert [b["commit"] for b in listed["builds"]] == ["good1"]
    # And neither the sources nor the half-built output outlived the job.
    assert _leftovers(hub, "proj1") == []


def test_a_build_the_hub_could_not_fence_is_ours_not_the_pushers(hub_factory):
    """`limits_error` is a 500: the ceilings would not go on, and that says
    nothing at all about the model that was pushed."""
    builder = SwitchableBuilder()
    builder.status = STATUS_LIMITS_ERROR
    builder.log = "buildproc: RLIMIT_CPU could not be set\n"
    hub = hub_factory(build_runner=builder)
    builder.fail = True

    reply = hub.publish_async("proj1", "abc123", good_build())
    record = hub.await_job(reply.json()["job"]).record
    assert record["state"] == STATE_FAILED
    assert record["code"] == 500


def test_a_job_is_never_left_building_when_something_throws(hub_factory):
    """The one failure a job registry must not have.

    A job that leaves the worker without a terminal state stays `building` until
    the hub is restarted, and the pusher polls a status that will never change
    again — which looks exactly like a build that is taking a long time.
    """
    def exploding(project_dir, out_dir, *, pid, **kw):
        raise RuntimeError("the runner itself broke")

    hub = hub_factory(build_runner=exploding)
    reply = hub.publish_async("proj1", "abc123", good_build())
    record = hub.await_job(reply.json()["job"]).record

    assert record["state"] == STATE_FAILED
    assert record["code"] == 500
    assert record["error"] == "internal error"
    assert record["finished"]
    assert _leftovers(hub, "proj1") == []


def test_a_build_that_produced_nothing_publishable_is_422(hub_factory):
    """The build ran and the hub refused what it produced.

    A tree with no meta.json is what `_finish_staging` turns down, and it is the
    same 422 the push used to get — it just arrives through the job now, because
    only a finished build can be asked the question.
    """
    hub = hub_factory()
    reply = hub.publish_async("proj1", "abc123",
                              tar_gz({"assembled.json": view_bytes()}))
    record = hub.await_job(reply.json()["job"]).record
    assert record["state"] == STATE_FAILED
    assert record["code"] == 422
    assert "meta.json" in record["error"]
    assert not (hub.project_dir("proj1") / "abc123").exists()
    assert _leftovers(hub, "proj1") == []


# -- the log -----------------------------------------------------------------
def test_the_build_log_is_handed_back_to_whoever_pushed(hub_factory):
    """The whole reason this step exists.

    Until now the model was built by a CI runner and a failed build was read in
    the runner's job log. Building on the hub takes that away, and nothing
    replaces it by itself.
    """
    builder = SwitchableBuilder()
    builder.log = "exporting printables:\nbuild failed: bracket fouls standoff\n"
    hub = hub_factory(build_runner=builder)
    builder.fail = True

    reply = hub.publish_async("proj1", "abc123", good_build())
    job_id = reply.json()["job"]
    hub.await_job(job_id)

    log = hub.job_log(job_id)
    assert log.status_code == 200
    assert log.headers["Content-Type"] == "text/plain; charset=utf-8"
    assert log.text == builder.log
    # It is on the volume beside the record, not only in memory.
    assert (hub.data / "jobs" / job_id / "log.txt").read_text() == builder.log


def test_a_successful_build_keeps_its_log_too(hub):
    reply = hub.publish_async("proj1", "abc123", good_build())
    job_id = reply.json()["job"]
    hub.await_job(job_id)
    assert "copying builder" in hub.job_log(job_id).text


def test_the_log_of_a_job_that_has_not_spoken_yet_is_empty_not_missing(gated_hub):
    """Empty and 404 are different answers: one is "nothing yet", the other is
    "no such job", and a poller has to be able to tell them apart."""
    hub = gated_hub
    job_id = hub.publish_async("proj1", "abc123", good_build()).json()["job"]
    assert hub.builder.entered.wait(timeout=10)

    log = hub.job_log(job_id)
    assert log.status_code == 200
    assert log.text == ""
    hub.builder.release.set()
    hub.await_job(job_id)


# -- who may look ------------------------------------------------------------
def test_both_job_endpoints_need_the_edit_token(hub):
    job_id = hub.publish_async("proj1", "abc123", good_build()).json()["job"]
    hub.await_job(job_id)

    for path in (f"/api/v1/jobs/{job_id}", f"/api/v1/jobs/{job_id}/log"):
        assert hub.get(path).status_code == 401, path
        assert hub.get(path, headers={"Authorization": "Bearer nope"}
                       ).status_code == 401, path
        # A near miss, because equality is the whole check: one secret for the
        # system means the only wrong token is a wrong string, and a prefix of
        # the right one is the string a timing attack would be building.
        assert hub.get(path, headers={"Authorization": f"Bearer {TOKEN[:-1]}"}
                       ).status_code == 401, path
        assert hub.get(path, headers={"Authorization": f"Bearer {TOKEN}"}
                       ).status_code == 200, path


def test_an_unknown_job_answers_exactly_as_a_malformed_one_does(hub):
    """A job id nobody issued and a job id belonging to somebody else must be
    indistinguishable — the id is the only thing separating one pusher's build
    log from another's."""
    real = hub.publish_async("proj1", "abc123", good_build()).json()["job"]
    hub.await_job(real)

    stranger = "A" * 22          # well formed, never issued
    malformed = ["short", "..", "x" * 40, f"{real}extra"]
    headers = {"Authorization": f"Bearer {TOKEN}"}

    baseline = hub.get(f"/api/v1/jobs/{stranger}", headers=headers)
    assert baseline.status_code == 404
    for candidate in malformed:
        reply = hub.get(f"/api/v1/jobs/{candidate}", headers=headers)
        assert reply.status_code == 404, candidate
        assert reply.json() == baseline.json(), candidate
    assert hub.get(f"/api/v1/jobs/{stranger}/log", headers=headers
                   ).status_code == 404
    # And an id that is really a path is not one either.
    assert hub.get(f"/api/v1/jobs/{real}/log/extra", headers=headers
                   ).status_code == 404


# -- the registry itself -----------------------------------------------------
def test_a_job_stranded_by_a_restart_is_failed_at_startup(tmp_path):
    """A job left `building` by a SIGKILL would otherwise never change again.

    The process that was building it is gone and nothing resumes it — the
    sources were unpacked into a directory the sweeper removes — so the pusher
    would poll a status that stays `building` for the life of the volume.
    """
    data = tmp_path / "data"
    first = JobStore(data)
    queued = first.create("proj1", "aaa111")["id"]
    building = first.create("proj1", "bbb222")["id"]
    first.start(building)
    finished = first.create("proj1", "ccc333")["id"]
    first.finish(finished, state=STATE_DONE, code=201,
                 build_url="/project/proj1/ccc333/")

    after = JobStore(data)
    for stranded in (queued, building):
        record = after.get(stranded)
        assert record["state"] == STATE_FAILED, stranded
        assert record["code"] == 503
        assert "restarted" in record["error"]
        assert record["finished"]
    # ...and a job that had already finished is left exactly as it was.
    assert after.get(finished)["state"] == STATE_DONE
    assert after.get(finished)["build_url"] == "/project/proj1/ccc333/"


def test_a_start_rewrites_only_the_records_it_changed(tmp_path):
    """Every write back is two fsyncs, and no retention bounds how many there are.

    The number of job records is the number of pushes over the volume's whole
    life (SPEC 5.3), and `_load` runs from `JobStore.__init__`, which runs from
    `create_server` BEFORE the socket is bound. A pass that rewrote all of them
    would put that whole cost in front of the first `/health` on an old volume —
    against a `start_period` of 30 s in the compose file and an auto-update
    rollback gate that gives up around 120. So a record the rebuild did not
    change must not be written at all.

    Measured by INODE rather than by mtime: `atomic_write_bytes` writes a
    temporary file and renames it over the target, so a rewrite always changes
    the inode, while two writes inside one clock tick can share an mtime.
    """
    data = tmp_path / "data"
    first = JobStore(data)
    untouched = []
    for index in range(5):
        job_id = first.create("proj1", f"ccc{index}")["id"]
        first.finish(job_id, state=STATE_DONE, code=201,
                     build_url=f"/project/proj1/ccc{index}/")
        untouched.append(job_id)
    # One record this start really does have to correct, so the test cannot pass
    # by the write-back having stopped happening at all.
    planted = "P" * 22
    _plant_job(data, planted, state=STATE_BUILDING,
               duration_seconds=float("nan"))

    def inode(job_id):
        return (data / "jobs" / job_id / "job.json").stat().st_ino

    before = {job_id: inode(job_id) for job_id in [*untouched, planted]}
    again = JobStore(data)

    for job_id in untouched:
        assert again.get(job_id)["state"] == STATE_DONE
        assert inode(job_id) == before[job_id], (
            f"{job_id} was written again although nothing about it changed")

    # And the one that DID change reached the volume, which is the guarantee
    # this must not trade away: a correction left in memory is read back off the
    # volume at the next start and corrected again, for the life of the volume.
    assert inode(planted) != before[planted]
    on_disk = _volume_records(data)[planted]
    assert on_disk["state"] == STATE_FAILED
    assert on_disk["duration_seconds"] is None


def test_a_stranded_job_is_reported_over_http_too(tmp_path):
    data = tmp_path / "data"
    store = JobStore(data)
    job_id = store.create("proj1", "abc123")["id"]
    store.start(job_id)

    hub = start_hub(data)
    try:
        record = hub.job(job_id).json()
        assert record["state"] == STATE_FAILED
        assert "restarted" in record["error"]
    finally:
        stop_hub(hub)


def test_a_pushed_job_survives_a_restart_and_is_still_readable(tmp_path):
    """The log is on the volume, so it outlives the process that captured it."""
    data = tmp_path / "data"
    hub = start_hub(data)
    try:
        job_id = hub.publish_async("proj1", "abc123", good_build()).json()["job"]
        assert hub.await_job(job_id).status_code == 201
    finally:
        stop_hub(hub)

    again = start_hub(data)
    try:
        assert again.job(job_id).json()["state"] == STATE_DONE
        assert "copying builder" in again.job_log(job_id).text
    finally:
        stop_hub(again)


def test_the_registry_holds_nothing_a_reader_can_corrupt(tmp_path):
    """`get` hands out a copy, not the worker's live record."""
    store = JobStore(tmp_path / "data")
    job_id = store.create("proj1", "abc123")["id"]
    handed_out = store.get(job_id)
    handed_out["state"] = "nonsense"
    assert store.get(job_id)["state"] == STATE_QUEUED


def test_the_default_ceilings_are_the_documented_ones(tmp_path):
    """Numbers other parts of the system are reasoned about with.

    `MAX_CONCURRENT_BUILDS` is deliberately NOT `app.MAX_CONCURRENT_PUBLISHES`:
    one is sized by a body on disk and a tar reader, the other by cores, and the
    day either is retuned the other must not move with it.
    """
    from src.app import MAX_CONCURRENT_PUBLISHES

    assert jobs_module.MAX_CONCURRENT_BUILDS == 2
    assert jobs_module.MAX_CONCURRENT_BUILDS != MAX_CONCURRENT_PUBLISHES
    assert jobs_module.MAX_QUEUED_JOBS >= jobs_module.MAX_CONCURRENT_BUILDS
    assert jobs_module.MAX_STRANGERS_SWEPT == 1024
    assert jobs_module.STRANGER_MAX_AGE_SECONDS == 14 * 24 * 3600

    # AND THERE IS NO CEILING ON THE REGISTRY ITSELF, which is a fact about this
    # module rather than about a number, so it is asserted as one: no job is
    # ever deleted for being old or for being one too many (SPEC 5.3, 7.4).
    # Named explicitly because a ceiling is exactly the kind of thing that comes
    # back as an obvious improvement — and the day it does, it has to be a
    # decision, not a constant somebody added while tidying.
    for gone in ("MAX_JOBS", "MAX_JOB_AGE_SECONDS", "ORDER_NAME"):
        assert not hasattr(jobs_module, gone), (
            f"{gone} is back; retention was removed deliberately")
    assert not [name for name in vars(JobStore) if "prune" in name]

    # And the WHOLE stop fits inside docker's default stop grace period (10 s;
    # the compose file sets no `stop_grace_period`). Pinned as the arithmetic it
    # is, not as a bare "under ten": the stop costs one `serve_forever` poll
    # before `shutdown` is even entered, and then the budget — which covers the
    # queue drain AND the joins, because `shutdown` starts the clock before the
    # drain. A budget over the grace period saves no build — SIGKILL arrives on
    # docker's schedule, not ours — it only turns every ordinary stop into the
    # abrupt ending the join is there to avoid.
    #
    # What is NOT in this sum is the pool size, and that is the point of writing
    # it out: the joins share one deadline (`BuildQueue.shutdown`), so growing
    # MAX_CONCURRENT_BUILDS cannot grow the stop. Multiplied per worker, today's
    # two would already spend the entire grace period on the joins alone.
    #
    # The one thing the sum cannot promise is a drain that OVERRUNS the budget
    # on its own — it is up to MAX_QUEUED_JOBS `rmtree`s and record writes, and
    # cutting it short would leave exactly the trees and unanswered jobs it
    # exists to collect. What the floor bounds is the stop's own waiting on top
    # of that: the total is `poll + max(JOIN, drain + FLOOR)`, which is why the
    # floor is never allowed to exceed the budget.
    docker_stop_grace_seconds = 10
    serve_forever_poll_seconds = 0.5     # the default `main.py` serves with
    assert jobs_module.WORKER_JOIN_SECONDS > 0
    assert 0 < jobs_module.WORKER_JOIN_FLOOR_SECONDS
    assert (jobs_module.WORKER_JOIN_FLOOR_SECONDS
            <= jobs_module.WORKER_JOIN_SECONDS)
    assert (serve_forever_poll_seconds + jobs_module.WORKER_JOIN_SECONDS
            < docker_stop_grace_seconds)


# -- what a build can leave on the volume ------------------------------------
def test_a_record_the_hub_cannot_write_back_does_not_stop_it_starting(tmp_path):
    """One planted `NaN` used to be a hub that never started again.

    `json.loads` accepts `NaN` and `Infinity` — a Python extension, on by
    default — and `json.dumps(allow_nan=False)`, which is what this module
    writes with, refuses them. `_load` rewrites every job it finds in flight, so
    a record left `building` with a non-finite number in it raised out of
    `JobStore.__init__`, out of `create_server` and out of `main()`. From the
    volume, on every start, for ever — and the volume is writable by every
    build.
    """
    data = tmp_path / "data"
    real = JobStore(data)
    kept = real.create("proj1", "abc123")["id"]
    real.finish(kept, state=STATE_DONE, code=201,
                build_url="/project/proj1/abc123/")

    poisoned = "P" * 22
    _plant_job(data, poisoned, state=STATE_BUILDING,
               duration_seconds=float("nan"))

    again = JobStore(data)
    # The hub is up, and the jobs it really wrote are exactly as they were.
    assert again.get(kept)["state"] == STATE_DONE
    # The planted one was read into the shape this module writes: no non-finite
    # number survived, so it could be failed like any other stranded job.
    record = again.get(poisoned)
    assert record["state"] == STATE_FAILED
    assert record["duration_seconds"] is None


def test_a_record_this_hub_did_not_write_is_skipped_rather_than_believed(tmp_path):
    """Three shapes, three reasons, one answer: it is not a record.

    A state outside the four is the worst of them — `_load` only ever fails a
    `queued`/`building` one, so a fifth word is a record no rule can reach, and
    the status endpoint would serve it to a client that has no branch for it,
    for the life of the volume.
    """
    data = tmp_path / "data"
    JobStore(data)
    wrong_state, wrong_id, too_big = "S" * 22, "I" * 22, "B" * 22
    _plant_job(data, wrong_state, state="pending-for-ever")
    _plant_job(data, wrong_id, id="J" * 22)
    _plant_job(data, too_big, error="x" * (MAX_RECORD_BYTES + 1024))

    store = JobStore(data)
    for planted in (wrong_state, wrong_id, too_big):
        assert store.get(planted) is None, planted
        # Left where it is rather than deleted: unreadable is not proof of who
        # wrote it, and somebody may want to look at it.
        assert (data / "jobs" / planted).is_dir(), planted


# -- what is under data/jobs/ and is not a job -------------------------------
# No job is ever swept, whatever its age (SPEC 5.3): the sweep below is about
# everything ELSE in that directory, which is writable by every build.


def test_a_directory_with_no_record_in_it_is_swept_once_it_ages_out(tmp_path):
    """A job directory is kept for ever; a directory that is not one is not.

    A directory under `data/jobs/` is not necessarily a job — the volume is
    writable by every build — and the hub makes one itself a moment before it
    writes the record into it, so a volume that fills up leaves one too.
    Refusing to believe them was never the same as collecting them, and until
    this sweep nothing ever removed one.
    """
    data = tmp_path / "data"
    store = JobStore(data)
    kept = store.create("proj1", "abc123")["id"]
    store.finish(kept, state=STATE_DONE, code=201,
                 build_url="/project/proj1/abc123/")

    old_empty = data / "jobs" / ("E" * 22)
    old_empty.mkdir()
    old_garbage = data / "jobs" / ("G" * 22)
    old_garbage.mkdir()
    (old_garbage / "job.json").write_bytes(b"this is not a job record")
    fresh_empty = data / "jobs" / ("N" * 22)
    fresh_empty.mkdir()
    stale = time.time() - 7200
    for directory in (old_empty, old_garbage):
        os.utime(directory, (stale, stale))

    reopened = JobStore(data, stranger_max_age_seconds=3600)

    assert not old_empty.exists()
    assert not old_garbage.exists()
    # The fresh one stays: being unreadable is not proof of who wrote it, and it
    # may be evidence somebody wants. It goes the same way once it is as old.
    assert fresh_empty.is_dir()
    assert reopened.get(kept) is not None


def test_the_startup_sweep_reaches_everything_that_is_not_a_job(tmp_path):
    """The sweep reaches every SHAPE of stranger, not just one.

    The previous version of it missed in two directions at once. By NAME: only directories whose
    name was a well-formed job id ever reached the sweep, so a stray file, a
    directory called anything else, or a symlink was skipped before the age
    ceiling could look at it and stayed for the life of the volume. By TIME: the
    mtime is a value a build sets freely, and one dated in the future is never
    past any cutoff, so a directory carrying one would be immune for the life of
    the volume.

    The mtime is not CORRECTED, and that is worth saying rather than working
    around: writing a corrected one back would destroy the evidence the sweep is
    being careful about, because the mtime IS the evidence. So a date in the
    future simply buys no immunity.
    """
    data = tmp_path / "data"
    store = JobStore(data)
    kept = store.create("proj1", "abc123")["id"]
    store.finish(kept, state=STATE_DONE, code=201,
                 build_url="/project/proj1/abc123/")

    stale = time.time() - 7200
    jobs_dir = data / "jobs"
    odd_name = jobs_dir / "not-a-job-id"
    odd_name.mkdir()
    stray_file = jobs_dir / "leftover.tmp"
    stray_file.write_bytes(b"x" * 16)
    link = jobs_dir / ("L" * 22)
    link.symlink_to(jobs_dir / kept)
    for entry in (odd_name, stray_file):
        os.utime(entry, (stale, stale))
    os.utime(link, (stale, stale), follow_symlinks=False)
    # A directory dated in 2999 — with a name the sweep DOES recognise, so this
    # is the time hole on its own and not the name one over again.
    future = jobs_dir / ("U" * 22)
    future.mkdir()
    os.utime(future, (time.time() + 10 * 365 * 24 * 3600,) * 2)

    reopened = JobStore(data, stranger_max_age_seconds=3600)

    assert not odd_name.exists(), "a directory outside the id alphabet was skipped"
    assert not stray_file.exists(), "a stray file was skipped"
    assert not link.is_symlink(), "a symlink was skipped"
    assert not future.exists(), "a date in the future bought immunity"
    # The real job, and its log, are untouched — including the one the symlink
    # was pointing at, which must go with the LINK and not with its target.
    assert reopened.get(kept) is not None
    assert (jobs_dir / kept / "job.json").is_file()


def test_a_half_written_record_lands_where_the_sweep_looks(tmp_path,
                                                           monkeypatch):
    """The registry's temporary files go in `data/jobs/`, not inside a job.

    `atomic_write_bytes` writes a temporary file and renames it, so a process
    killed between the two leaves the temporary behind. Beside its target it
    would be INSIDE a job directory, and nothing collects one there: the sweep
    removes whole entries under `data/jobs/` that are not jobs of this registry,
    and a live job's directory is a job. In the shared directory it is a
    stranger like any other and ages out with everything else.

    THIS IS NOT A DEFENCE against a build making one write fail, which is what
    the relocation was first proposed for. `rename(tmp, dir/name)` needs write
    permission on the DESTINATION directory exactly as `open(dir/tmp)` did, so
    `chmod 0500` on a job directory refuses both — measured, both ways. What
    makes a pointwise failure survivable is that nothing shared between records
    is written per record any more.
    """
    data = tmp_path / "data"
    store = JobStore(data)
    job_id = store.create("proj1", "abc123")["id"]

    renamed = []
    landing = store_module.os.rename
    monkeypatch.setattr(
        store_module.os, "rename",
        lambda src, dst: (renamed.append(Path(src)), landing(src, dst))[1])
    store.finish(job_id, state=STATE_DONE, code=201,
                 build_url="/project/proj1/abc123/", log="a build said this\n")
    monkeypatch.undo()

    assert renamed, "nothing was written, so this test proves nothing"
    assert all(path.parent == data / "jobs" for path in renamed), (
        f"a temporary file was written inside a job directory, where nothing "
        f"ever collects a leftover: {[str(p) for p in renamed]}")

    # And the halves of the reason, on the volume: a leftover in the shared
    # directory ages out, one inside a job directory does not — which is why
    # the writer no longer puts one there.
    stale = time.time() - 7200
    shared = data / "jobs" / f"{JSON_TMP_PREFIX}job.json-{'a' * 32}"
    shared.write_bytes(b"half a record")
    inside = data / "jobs" / job_id / f"{JSON_TMP_PREFIX}job.json-{'b' * 32}"
    inside.write_bytes(b"half a record")
    for leftover in (shared, inside):
        os.utime(leftover, (stale, stale))

    reopened = JobStore(data, stranger_max_age_seconds=3600)
    assert not shared.exists()
    assert inside.exists()
    assert reopened.get(job_id) is not None


def test_a_leftover_of_a_killed_write_is_not_kept_for_fourteen_days(tmp_path):
    """Landing where the sweep looks is only half of it; WHEN matters too.

    `Store._sweep_leftovers` — the thing that collects a `.wip-` file everywhere
    else — walks the data root and the project directories, and `data/jobs/` is
    neither, so it never enters this tree at all. That leaves
    `_sweep_strangers`, and on the record ceiling a stray would wait fourteen
    days and a restart. In the old place it went with the job at the next prune,
    i.e. in hours — so the relocation, taken on its own, made the wait LONGER.
    A `.wip-log.txt-*` is up to MAX_LOG_BYTES, so that wait is measured in
    megabytes apiece.

    The short cutoff is safe here and only here: `_sweep_strangers` runs from
    `JobStore.__init__`, before the pool exists and before the socket is bound,
    so nothing in this process is writing into `data/jobs/` while it looks.
    """
    data = tmp_path / "data"
    store = JobStore(data)
    kept = store.create("proj1", "abc123")["id"]
    store.finish(kept, state=STATE_DONE, code=201,
                 build_url="/project/proj1/abc123/")

    two_hours_ago = time.time() - 7200
    stray = data / "jobs" / f"{JSON_TMP_PREFIX}log.txt-{'c' * 32}"
    stray.write_bytes(b"half a log")
    # The same age, and NOT of that shape: this one is somebody's evidence about
    # a build, so it keeps the record ceiling. Here to show the short cutoff
    # belongs to the PREFIX rather than to the sweep as a whole.
    evidence = data / "jobs" / ("E" * 22)
    evidence.mkdir()
    for entry in (stray, evidence):
        os.utime(entry, (two_hours_ago, two_hours_ago))

    # The DEFAULT age ceiling — fourteen days — which is the whole point: on it,
    # nothing else on this volume would have collected the stray.
    reopened = JobStore(data)

    assert not stray.exists(), (
        "a half-written file of the hub's own is sitting in data/jobs/ under "
        "the record ceiling, and nothing else there ever collects one")
    assert evidence.is_dir()
    assert reopened.get(kept) is not None


def test_a_flooded_registry_does_not_flood_the_log(tmp_path):
    """One aggregated line, whatever the count.

    The sweep used to warn once per entry, so the 988 directories of the
    experiment were 988 warnings in every start of the hub — for ever, because
    the entries are on the volume and the sweep keeps them until they age out.
    The compose file caps the container log at 5 files of 10 MB, so what the
    planted directories push out is the service's own logs: the thing somebody
    would have been reading to find out about them.
    """
    data = tmp_path / "data"
    JobStore(data)
    for index in range(30):
        (data / "jobs" / f"q{index:02d}".ljust(22, "z")).mkdir()

    said = []
    sink = logger.add(said.append, level="WARNING")
    try:
        JobStore(data)
    finally:
        logger.remove(sink)

    # ONE line, and it does not count up: the sweep's aggregate, written
    # per-START rather than per-entry. That is the property under test — the
    # number of warnings must not be a number a build gets to choose.
    assert len(said) == 1, (
        f"the start wrote {len(said)} warnings for 30 planted directories; a "
        f"build gets to choose that number")
    assert "past the stranger age ceiling" in said[0]
    assert "30" in said[0]


def test_a_corrupted_record_does_not_take_a_real_job_down_with_it(tmp_path):
    """A build that corrupts N records costs the registry exactly those N.

    This used to be false, and the way it was false is worth keeping a test for.
    A count ceiling was applied BEFORE the records were read, by position, so it
    could not know which of them would turn out to be unreadable: corrupting
    five records at one end deleted five real jobs at the other, and the build
    chose both the number and which ones. Twenty jobs, a ceiling of five and
    five broken `job.json` emptied the registry completely.

    There is no count ceiling at all now (SPEC 5.3), so the arithmetic that made
    that possible is gone — but the property it was supposed to have is the one
    to assert, because it is what any future ceiling would have to preserve.
    """
    data = tmp_path / "data"
    store = JobStore(data)
    made = []
    for index in range(20):
        record = store.create("proj1", f"c{index}")
        store.finish(record["id"], state=STATE_DONE, code=201,
                     build_url=f"/project/proj1/c{index}/")
        made.append(record["id"])

    broken = made[-5:]
    for job_id in broken:
        (data / "jobs" / job_id / "job.json").write_bytes(b"not a record")

    reopened = JobStore(data)

    survivors = [job_id for job_id in made if reopened.get(job_id) is not None]
    assert survivors == made[:-5], (
        "a build that corrupted five records took real jobs down with them")
    # The broken ones are not believed and not deleted on the spot either —
    # being unreadable is not proof of who wrote it, so they go by age like any
    # other stranger.
    for job_id in broken:
        assert reopened.get(job_id) is None
        assert (data / "jobs" / job_id).is_dir()


def test_a_job_the_volume_refuses_to_record_leaves_nothing_in_memory(
        tmp_path, monkeypatch):
    """The one write here that is not best effort, and the order proves it.

    `finish` can lose its writes and carry on, because the record is already in
    memory and memory is what every status poll is answered from. `create` has
    nobody to serve: the push is answered 500 and the id never reaches the
    pusher. A record inserted before a write that then failed would therefore
    sit in memory until the process ends, `queued`, for a build nobody is
    running.
    """
    store = JobStore(tmp_path / "data")
    issued = "K" * 22
    monkeypatch.setattr(jobs_module.secrets, "token_urlsafe", lambda _n: issued)

    def full_volume(*_args, **_kw):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(store, "_write", full_volume)
    with pytest.raises(OSError):
        store.create("proj1", "abc123")

    assert store.get(issued) is None


def test_a_log_that_cannot_be_written_at_all_still_finishes_the_job(tmp_path,
                                                                    monkeypatch):
    """OSError is not the only way a write goes wrong.

    `_write` next to it catches `(OSError, ValueError)` for exactly this reason,
    and the guard around the log has to be the same pair: a job that loses its
    terminal state to a failure in a file that is only EVIDENCE is the one
    failure this registry must not have.
    """
    store = JobStore(tmp_path / "data")
    job_id = store.create("proj1", "abc123")["id"]

    def refuses(*_args, **_kw):
        raise ValueError("I/O operation on closed file")

    monkeypatch.setattr(store, "_write_log", refuses)
    store.finish(job_id, state=STATE_DONE, code=201,
                 build_url="/project/proj1/abc123/", log="a build said this\n")

    assert store.get(job_id)["state"] == STATE_DONE
    assert store.get(job_id)["build_url"] == "/project/proj1/abc123/"


def test_a_build_writing_its_log_does_not_hold_up_everybody_elses_status_poll(
        tmp_path, monkeypatch):
    """`_lock` is the registry's ONLY lock, so it is also the status endpoint's.

    Every `get` takes it — every poll, from every pusher, of every job. Held
    across `_write_log`, one finishing build blocked all of them for as long as
    the volume took to fsync up to MAX_LOG_BYTES. The log still goes down before
    the state changes, because a poller that reads `done` is about to fetch the
    log; what it must not cost is the lock.
    """
    store = JobStore(tmp_path / "data")
    watched = store.create("proj1", "watched")["id"]
    finishing = store.create("proj1", "finishing")["id"]

    inside, release = threading.Event(), threading.Event()
    writing_the_log = store._write_log

    def slow_volume(job_id, log):
        inside.set()
        assert release.wait(timeout=10), "the test never released the write"
        writing_the_log(job_id, log)

    monkeypatch.setattr(store, "_write_log", slow_volume)
    finisher = threading.Thread(
        target=lambda: store.finish(finishing, state=STATE_DONE, code=201,
                                    build_url="/project/proj1/finishing/",
                                    log="a build said this\n"),
        name="finishing-build", daemon=True)
    finisher.start()
    assert inside.wait(timeout=10)

    # Polled on a thread of its own so a lock that IS held fails this test
    # instead of hanging it.
    polled = []
    poller = threading.Thread(target=lambda: polled.append(store.get(watched)),
                              name="status-poll", daemon=True)
    poller.start()
    poller.join(timeout=5)
    assert not poller.is_alive(), (
        "a status poll waited on another job's build log reaching the volume")
    assert polled[0]["state"] == STATE_QUEUED
    # And the order the log write is done in first for: the state does not turn
    # terminal until the log has landed.
    assert store.get(finishing)["state"] == STATE_QUEUED

    release.set()
    finisher.join(timeout=10)
    assert store.get(finishing)["state"] == STATE_DONE
    assert store.log(finishing) == "a build said this\n"


def test_a_registry_the_volume_will_not_list_does_not_stop_the_hub_starting(
        tmp_path, monkeypatch):
    """`_load` says NOTHING IN HERE MAY RAISE, and the listing is in here.

    `os.scandir` and `DirEntry.is_dir` go to the same volume every build can
    write, and neither is total: opening the directory raises on EIO or EACCES,
    and `is_dir` swallows only the errors that mean "no". Either one escaping
    is `JobStore.__init__` raising out of `create_server` and out of `main()` —
    a hub that does not come up, from the same volume, every time. Starting with
    no job history is bad; not starting is worse, and it is not recoverable
    without a person on the host.
    """
    data = tmp_path / "data"
    store = JobStore(data)
    kept = store.create("proj1", "abc123")["id"]
    store.finish(kept, state=STATE_DONE, code=201,
                 build_url="/project/proj1/abc123/")

    listing = os.scandir

    def volume_refuses_the_listing(path=".", *args, **keywords):
        if Path(path).name == "jobs":
            raise OSError(errno.EIO, "Input/output error")
        return listing(path, *args, **keywords)

    monkeypatch.setattr(jobs_module.os, "scandir", volume_refuses_the_listing)
    assert JobStore(data).get(kept) is None
    monkeypatch.undo()

    class RefusingEntry:
        """A directory entry the volume will not answer a question about."""

        def __init__(self, entry):
            self.name = entry.name

        def is_dir(self, *_args, **_keywords):
            raise OSError(errno.EACCES, "Permission denied")

    class RefusingScan:
        """`os.scandir`'s context manager, over entries that refuse."""

        def __init__(self, entries):
            self._entries = entries

        def __enter__(self):
            return iter(self._entries)

        def __exit__(self, *_exc):
            return False

    def volume_refuses_the_entry(path=".", *args, **keywords):
        if Path(path).name != "jobs":
            return listing(path, *args, **keywords)
        with listing(path, *args, **keywords) as entries:
            return RefusingScan([RefusingEntry(entry) for entry in entries])

    monkeypatch.setattr(jobs_module.os, "scandir", volume_refuses_the_entry)
    assert JobStore(data).get(kept) is None
    monkeypatch.undo()

    # And nothing was destroyed on the way past: the volume answering again is
    # a hub that reads its jobs again.
    assert JobStore(data).get(kept)["state"] == STATE_DONE


def test_the_biggest_log_a_build_can_hand_over_is_served_whole(tmp_path):
    """The read ceiling has to fit what the WRITE path can produce.

    `runner._Drain` keeps `Limits.log_bytes` of RAW output and decodes it with
    `errors="replace"`, and a byte that is not valid UTF-8 becomes U+FFFD, which
    encodes back to THREE bytes. So a model printing binary — precisely the
    build whose log somebody needs — makes the hub write three times the ceiling
    the build ran under. With a smaller number here the hub served its OWN log
    truncated, under a warning saying the log was larger than a build can
    produce; it was not, the hub wrote it.
    """
    data = tmp_path / "data"
    store = JobStore(data)
    job_id = store.create("proj1", "abc123")["id"]
    captured = (b"\xff" * Limits.log_bytes).decode("utf-8", errors="replace")

    store.finish(job_id, state=STATE_FAILED, code=422,
                 error="the model or a gate refused the build", log=captured)

    served = store.log(job_id)
    assert LOG_TRUNCATED_NOTE not in served
    assert served == captured


def test_a_log_handed_to_the_registry_is_cut_before_it_reaches_the_volume(
        tmp_path):
    """The cut belongs on the WRITE, not only on the read.

    MAX_LOG_BYTES is what the read path is willing to serve, so a file written
    past it comes back truncated under a warning about a log larger than a build
    can produce — and on this path the hub itself wrote it. The ceiling is
    derived to fit the worst case a build can hand over, so this cut is
    unreachable in production, which is exactly why it needs a test: it is what
    keeps what the hub writes inside what the hub will read on the day either
    number moves.
    """
    data = tmp_path / "data"
    store = JobStore(data)
    job_id = store.create("proj1", "abc123")["id"]
    # A three-byte character, in a count that makes the cut land INSIDE one of
    # them: a slice of UTF-8 bytes is not UTF-8, and this file is served as text.
    store.finish(job_id, state=STATE_FAILED, code=422,
                 log="中" * (MAX_LOG_BYTES // 2))

    raw = (data / "jobs" / job_id / "log.txt").read_bytes()
    assert len(raw) <= MAX_LOG_BYTES
    # Strict, because "it decodes" is the claim: nothing was left half written.
    assert raw.decode("utf-8").endswith(LOG_TRUNCATED_NOTE)
    # And what comes back is that file whole, rather than a second truncation.
    assert store.log(job_id) == raw.decode("utf-8")


def test_a_log_larger_than_a_build_can_produce_is_served_truncated(tmp_path):
    """The log is read off the volume on every request, and capped there.

    The hub writes it from an already-capped `BuildOutcome.log`, so a file this
    size was not written by the hub — and without a ceiling, serving it is a
    request thread holding however many megabytes somebody chose.
    """
    data = tmp_path / "data"
    store = JobStore(data)
    job_id = store.create("proj1", "abc123")["id"]
    (data / "jobs" / job_id / "log.txt").write_bytes(b"A" * (MAX_LOG_BYTES + 4096))

    served = store.log(job_id)
    assert served.endswith(LOG_TRUNCATED_NOTE)
    assert len(served) == MAX_LOG_BYTES + len(LOG_TRUNCATED_NOTE)


# -- a job that ends when the volume will not take it ------------------------
def test_a_build_whose_log_cannot_be_written_still_finishes(hub_factory,
                                                            monkeypatch):
    """The published build that reported itself as still building.

    ENOSPC on the log — a megabyte — is the ordinary way for this to happen, and
    the log used to be written before the record was updated with nothing
    between them. The result was a job stuck `building` while its build was on
    disk and `latest` already pointed at it: the pusher polls a status that
    never changes, and after a restart is told to push again about a build that
    landed.
    """
    hub = hub_factory()

    def full_volume(*_args, **_kw):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(hub.server.jobs, "_write_log", full_volume)

    job_id = hub.publish_async("proj1", "abc123", good_build()).json()["job"]
    record = hub.await_job(job_id, timeout=10).record

    assert record["state"] == STATE_DONE
    assert record["code"] == 201
    assert record["build_url"] == "/project/proj1/abc123/"
    # ...and the build really is published, which is what made the stuck state a
    # lie rather than merely a delay.
    assert (hub.project_dir("proj1") / "abc123" / "meta.json").is_file()
    # The log is simply missing, which is the honest consequence and the small
    # half of the trade.
    assert hub.job_log(job_id).text == ""


def test_a_record_the_volume_refuses_still_changes_the_status_served(tmp_path,
                                                                     monkeypatch):
    """Memory and disk disagree, and memory wins — it is the one being served."""
    store = JobStore(tmp_path / "data")
    job_id = store.create("proj1", "abc123")["id"]

    def full_volume(*_args, **_kw):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(store, "_write", full_volume)
    store.finish(job_id, state=STATE_DONE, code=201,
                 build_url="/project/proj1/abc123/")

    assert store.get(job_id)["state"] == STATE_DONE
    assert store.get(job_id)["code"] == 201


# -- publishing, and everything after it -------------------------------------
def test_a_failure_after_the_rename_still_reports_the_build_as_published(
        hub_factory, monkeypatch):
    """The rename IS the publication; what follows it is bookkeeping.

    `latest`, the picker and the index are all recomputed from disk
    by the next publish, so a failure in them is recoverable. Reporting the job
    as failed is not: the build is at its permanent URL and `latest` may already
    name it, and CI would be told to push a commit that is live.
    """
    hub = hub_factory()

    def broken(_pid):
        raise OSError(errno.EIO, "the pointer could not be written")

    monkeypatch.setattr(hub.store, "_switch_latest", broken)

    job_id = hub.publish_async("proj1", "abc123", good_build()).json()["job"]
    record = hub.await_job(job_id, timeout=10).record

    assert record["state"] == STATE_DONE
    assert record["code"] == 201
    assert record["build_url"] == "/project/proj1/abc123/"
    assert (hub.project_dir("proj1") / "abc123" / "meta.json").is_file()
    assert _leftovers(hub, "proj1") == []


def test_a_commit_taken_while_the_build_ran_is_caught_under_the_lock(tmp_path):
    """`settled` answers from the request; `publish_built` answers for real.

    The gap between the two used to be milliseconds and is now a whole build, so
    the recheck immediately before the rename is the only thing standing between
    two pushes of one commit and a silently replaced immutable build.
    """
    store = _bare_store(tmp_path / "data")
    staging, names = _staged(store, "proj1", "abc123", "a")
    assert store.publish_built("proj1", "abc123", staging, names, "digest-a"
                               )[0] == 201

    # A second build of the same commit, finishing minutes later with different
    # content. `settled` said nothing was there — because when it looked, there
    # was nothing there.
    other, names = _staged(store, "proj1", "abc123", "b")
    with pytest.raises(PublishError) as refused:
        store.publish_built("proj1", "abc123", other, names, "digest-b")
    assert refused.value.status == 409

    # And the identical retry of a build that landed while it was running is the
    # 200 it would have got on the push.
    same, names = _staged(store, "proj1", "abc123", "a")
    assert store.publish_built("proj1", "abc123", same, names, "digest-a") == (
        200, {"url": "/project/proj1/abc123/"})


def test_two_builds_of_one_commit_race_to_one_answer(tmp_path):
    """The same thing through the whole pipeline, with both builds in flight."""
    builder = GatedBuilder()
    hub = start_hub(tmp_path / "data", build_runner=builder, build_workers=2)
    try:
        pushes = [hub.publish_async("proj1", "abc123", good_build(marker))
                  for marker in ("one", "two")]
        assert [reply.status_code for reply in pushes] == [202, 202]

        deadline = time.monotonic() + 10
        while builder.started < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert builder.started == 2, "both builds have to be in flight at once"

        builder.release.set()
        codes = sorted(hub.await_job(reply.json()["job"]).status_code
                       for reply in pushes)
        assert codes == [201, 409]
        assert _leftovers(hub, "proj1") == []
    finally:
        builder.release.set()
        stop_hub(hub)


# -- stopping ----------------------------------------------------------------
def test_stopping_the_pool_takes_the_queued_sources_with_it(tmp_path):
    """A dropped job still owns an unpacked tree, and nothing else removes it.

    `Store._sweep_leftovers` was the answer this used to give and it is not one:
    it runs from `Store.__init__` only, and it skips everything younger than an
    hour, while a container comes back in seconds. So a tree dropped by a stop
    survived the very restart that was supposed to collect it.
    """
    data = tmp_path / "data"
    store = _bare_store(data)
    jobs = JobStore(data)
    # Workers deliberately NOT started: nothing consumes the queue, so what the
    # shutdown does with it is the only thing this can be observing.
    pool = BuildQueue(store, jobs, build_runner=copying_builder)
    queued = []
    for index in range(3):
        sources = data / f"{SOURCE_PREFIX}{index:032x}"
        sources.mkdir(parents=True)
        (sources / "model.py").write_text("# a pushed source tree\n")
        body = _accepted_body(data, index)
        record = jobs.create("proj1", f"c{index}")
        assert pool.submit(BuildTask(
            job_id=record["id"], pid="proj1", commit=f"c{index}",
            sources=sources, archive=body,
            digest=f"digest-{index}")) == SUBMIT_ACCEPTED
        queued.append((record["id"], sources, body))

    pool.shutdown()

    for job_id, sources, body in queued:
        assert not sources.exists(), "an unpacked source tree outlived the stop"
        # And the body it came out of, which is owned exactly the same way: this
        # task never published, so it is not the code of any revision.
        assert not body.exists(), "a pushed body outlived the stop"
        record = jobs.get(job_id)
        assert record["state"] == STATE_FAILED, job_id
        # 503 and "push again": nothing was wrong with the push.
        assert record["code"] == 503
        assert "push again" in record["error"]


def test_the_stop_budget_is_spent_by_the_pool_not_by_each_worker(tmp_path,
                                                                 monkeypatch):
    """One deadline for all the workers, not a timeout each.

    The join exists to keep an ordinary stop away from SIGKILL: docker sends one
    10 s after its SIGTERM and the compose file asks for no longer. Multiplied
    per worker, the budget reaches that grace period all by itself — at the
    pool's own default of two it IS the grace period — so the number meant to
    avoid a SIGKILL would be what guaranteed one, and worse with every worker
    added. Four workers here, all of them stuck, so the difference between the
    two readings is four times the budget rather than two.
    """
    monkeypatch.setattr(jobs_module, "WORKER_JOIN_SECONDS", 0.5)
    builder = GatedBuilder()
    hub = start_hub(tmp_path / "data", build_runner=builder, build_workers=4)
    try:
        for index in range(4):
            assert hub.publish_async("proj1", f"c{index}",
                                     good_build(f"v{index}")).status_code == 202
        deadline = time.monotonic() + 10
        while builder.running < 4 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert builder.running == 4, "every worker has to be busy for this"

        started = time.monotonic()
        hub.server.builds.shutdown()
        elapsed = time.monotonic() - started

        assert elapsed < 1.0, (
            f"the stop spent {elapsed:.2f}s joining four workers that were "
            f"given {jobs_module.WORKER_JOIN_SECONDS}s between them, so the "
            f"budget is being spent per thread and grows with the pool")
    finally:
        builder.release.set()
        _await_no_workers()
        stop_hub(hub)


def test_the_drain_is_paid_for_out_of_the_stop_budget(tmp_path, monkeypatch):
    """The budget is what the STOP spends, not what the joins spend.

    `WORKER_JOIN_SECONDS` is sized against docker's 10 s grace period, and the
    drain runs before the joins: up to MAX_QUEUED_JOBS trees to remove and a job
    record to write, with an fsync, for each, on the volume the joins are then
    waiting for. Started after it, the clock said 5 s while a real stop cost the
    drain PLUS 5 s — so SIGKILL landed inside the join the number exists to
    protect, and both the comment and the test said otherwise.

    The floor is what keeps the correction from going too far the other way: a
    drain that ate the whole budget would join for nothing at all.
    """
    monkeypatch.setattr(jobs_module, "WORKER_JOIN_SECONDS", 2.0)
    monkeypatch.setattr(jobs_module, "WORKER_JOIN_FLOOR_SECONDS", 0.2)
    slow_drain_seconds = 2.0
    builder = GatedBuilder()
    hub = start_hub(tmp_path / "data", build_runner=builder, build_workers=1)
    try:
        assert hub.publish_async("proj1", "c0",
                                 good_build()).status_code == 202
        assert builder.entered.wait(timeout=10), "the worker has to be busy"

        draining = hub.server.builds._drop_queued

        def slowly():
            time.sleep(slow_drain_seconds)
            return draining()

        monkeypatch.setattr(hub.server.builds, "_drop_queued", slowly)
        started = time.monotonic()
        hub.server.builds.shutdown()
        elapsed = time.monotonic() - started

        assert elapsed < slow_drain_seconds + 1.0, (
            f"the stop took {elapsed:.2f}s: {slow_drain_seconds:.1f}s of drain "
            f"and then a full {jobs_module.WORKER_JOIN_SECONDS}s of join on top "
            f"of it, so the budget describes the joins rather than the stop")
        # ...and the join was not starved to nothing by the drain either.
        assert elapsed >= slow_drain_seconds + jobs_module.WORKER_JOIN_FLOOR_SECONDS
    finally:
        builder.release.set()
        _await_no_workers()
        stop_hub(hub)


def test_a_task_a_worker_already_took_is_not_torn_down_by_the_stop(tmp_path):
    """The third holder of a task, and the one the old reasoning left out.

    `submit`'s post-check used to drain the queue, find nothing, and conclude
    from "the queue hands one item to exactly one caller" that the task must
    have come back to it. It need not have: a WORKER may have taken it and be
    inside `_build_and_publish` with it. The caller then does what a refusal
    tells it to — `app._queue_build` removes the source tree in its `finally`
    and fails the job — under a build that is reading that tree and is minutes
    from renaming its output into an immutable URL.
    """
    data = tmp_path / "data"
    jobs = JobStore(data)
    builder = GatedBuilder()
    pool = BuildQueue(_bare_store(data), jobs, build_runner=builder, workers=1)
    pool.start()

    class StopOnceTheWorkerHasIt(queue.Queue):
        """A queue that lets the worker take the task, then stops the hub.

        Substituted rather than raced against a real stop because the window is
        two statements wide: a test that hoped to hit it would pass whether or
        not `submit` can tell a worker from itself.
        """

        def put_nowait(self, item):
            super().put_nowait(item)
            assert builder.entered.wait(timeout=10), "no worker took the task"
            pool._stopping.set()

    pool._queue = StopOnceTheWorkerHasIt(maxsize=4)

    sources = data / f"{SOURCE_PREFIX}{2:032x}"
    sources.mkdir(parents=True)
    (sources / "meta.json").write_bytes(meta_bytes())
    (sources / "assembled.json").write_bytes(view_bytes("a"))
    for name, data_bytes in DEFAULT_EXPORTS.items():
        (sources / name).write_bytes(data_bytes)
    record = jobs.create("proj1", "c2")

    try:
        assert pool.submit(BuildTask(
            job_id=record["id"], pid="proj1", commit="c2", sources=sources,
            archive=_accepted_body(data, 2),
            digest="digest-2")) == SUBMIT_ACCEPTED, (
            "the stop reported a refusal for a task a worker already had, so "
            "the request thread is about to delete a live build's sources")
        # Nothing was taken from the build: its tree is where it left it and its
        # job is not carrying somebody else's verdict.
        assert sources.is_dir()
        assert jobs.get(record["id"])["state"] == STATE_BUILDING

        builder.release.set()
        deadline = time.monotonic() + 10
        while (jobs.get(record["id"])["state"] not in (STATE_DONE, STATE_FAILED)
               and time.monotonic() < deadline):
            time.sleep(0.01)
        # And it published, which is the only proof that the tree was whole when
        # the build read it.
        assert jobs.get(record["id"])["state"] == STATE_DONE
    finally:
        # In a `finally` and in this order, so a failed assertion above leaves no
        # worker behind for the guard in conftest to find on some later test.
        builder.release.set()
        pool.shutdown()
        _await_no_workers()


def test_a_push_that_lands_on_a_stopping_hub_is_told_that_and_not_queue_full(
        tmp_path):
    """One refusal code, two entirely different reasons, and they are not the same.

    `submit` refuses a full queue and a hub on its way out alike, and the push
    path used to sign both "the build queue is full, retry later". That is not a
    small inaccuracy: the queue is empty, the advice to wait 60 s and retry the
    same hub is wrong, and when the stop's own drain had already written the job
    the true sentence — "the hub was stopped, push again" — this replaced it
    with the false one, on the job record as well as in the reply.
    """
    hub = start_hub(tmp_path / "data")
    try:
        # Stopped without closing the socket, which is the state a push landing
        # during a stop really meets: request threads are daemon threads and run
        # straight through the shutdown that is happening beside them.
        hub.server.builds.shutdown()

        reply = hub.publish_async("proj1", "abc123", good_build())
        assert reply.status_code == 503
        assert reply.json()["error"] == STOPPED_ERROR
        # No Retry-After: nothing is going to free up here, the hub is going
        # away. Telling CI to come back in a minute to this process is a lie.
        assert "Retry-After" not in reply.headers

        # The job says the same thing, so a pusher who polls it is not told a
        # different story from the one the reply told.
        records = list(_volume_records(hub.data).values())
        assert len(records) == 1
        assert records[0]["state"] == STATE_FAILED
        assert records[0]["code"] == 503
        assert records[0]["error"] == STOPPED_ERROR
        # And the tree the push unpacked went with it.
        assert _leftovers(hub, "proj1") == []
    finally:
        stop_hub(hub)


def test_a_push_handed_over_after_the_stop_began_is_refused(tmp_path):
    """`daemon_threads = True`, so a request thread outlives the drain.

    The thread serving a push keeps running while `shutdown` empties the queue
    on another one. Queued after that, the task is one no worker will ever read:
    the pusher is told 202 about a build nobody will run, and the unpacked tree
    it owns stays on the volume — `Store._sweep_leftovers` runs at startup and
    skips everything younger than an hour, while a container comes back in
    seconds.

    And the refusal says WHICH refusal it is, because the caller does different
    things with the two: a full queue leaves the job for the request thread to
    fail, a stop has already answered it.
    """
    data = tmp_path / "data"
    jobs = JobStore(data)
    # Workers deliberately not started: what `submit` does with a stopping pool
    # is the only thing this can be observing.
    pool = BuildQueue(_bare_store(data), jobs, build_runner=copying_builder)
    pool.shutdown()

    sources = data / f"{SOURCE_PREFIX}{0:032x}"
    sources.mkdir(parents=True)
    (sources / "model.py").write_text("# a pushed source tree\n")
    record = jobs.create("proj1", "c0")

    assert pool.submit(BuildTask(
        job_id=record["id"], pid="proj1", commit="c0", sources=sources,
        archive=_accepted_body(data, 0), digest="digest-0")) == SUBMIT_STOPPED
    # Answered by `submit` itself: the task never entered the queue, so no drain
    # is ever going to find it and say so.
    answered = jobs.get(record["id"])
    assert answered["state"] == STATE_FAILED
    assert answered["code"] == 503
    assert "push again" in answered["error"]


def test_a_push_that_races_the_drain_is_taken_back_out_of_the_queue(tmp_path):
    """The same thing one moment later: the stop lands mid-insertion.

    Checking before the insertion only narrows the window; the task can still be
    put down after the drain has gone past it. The queue is substituted here
    rather than raced against a real thread because the window is two statements
    wide, and a test that hoped to hit it would pass whether or not the second
    check exists.
    """
    data = tmp_path / "data"
    jobs = JobStore(data)
    pool = BuildQueue(_bare_store(data), jobs, build_runner=copying_builder)

    class StopMidInsertion(queue.Queue):
        """A queue that runs the whole stop between the put and the check."""

        def put_nowait(self, item):
            super().put_nowait(item)
            pool.shutdown()

    pool._queue = StopMidInsertion(maxsize=4)

    sources = data / f"{SOURCE_PREFIX}{1:032x}"
    sources.mkdir(parents=True)
    (sources / "model.py").write_text("# a pushed source tree\n")
    body = _accepted_body(data, 1)
    record = jobs.create("proj1", "c1")

    assert pool.submit(BuildTask(
        job_id=record["id"], pid="proj1", commit="c1", sources=sources,
        archive=body, digest="digest-1")) == SUBMIT_STOPPED
    # And the task was answered rather than merely refused: its sources are gone
    # and its job says what happened, which is the last thing the hub can say.
    # Note WHO answered it: `shutdown`'s drain, running inside `put_nowait`, not
    # the drain `submit` runs afterwards — which by then finds an empty queue.
    # That is the case the shared record of dropped ids exists for.
    assert not sources.exists()
    assert not body.exists()
    assert jobs.get(record["id"])["state"] == STATE_FAILED
    assert jobs.get(record["id"])["error"] == STOPPED_ERROR


def test_a_submit_whose_drain_throws_still_answers_its_job(tmp_path,
                                                           monkeypatch):
    """`submit`'s drain gets the wrapper `shutdown`'s call to it already has.

    The reasoning transfers one for one: the drain is a loop over directories
    and job records on a volume this module gets to assume nothing about, and it
    runs at the moment there is nothing after it. Escaping here it does two
    things at once, and the second is the permanent one. The pusher gets a 500
    out of the request handler — recoverable, they retry. The task stays in a
    queue no worker will read again, so its job stays `queued` FOR EVER: nothing
    else answers a task the drain did not take, and nothing here ever fails a
    job on its own, so the `queued` it is left in comes back only with a
    restart.

    So a drain that threw is not read as "a worker has it". It cannot be — the
    drain did not finish, so the task may equally be sitting in a queue nobody
    will read — and between a job that is answered wrongly and a job that is
    never answered, this answers it.
    """
    data = tmp_path / "data"
    jobs = JobStore(data)
    pool = BuildQueue(_bare_store(data), jobs, build_runner=copying_builder)

    def drain_that_throws():
        raise OSError(errno.EIO, "Input/output error")

    class StopMidInsertion(queue.Queue):
        """The stop lands between the put and the check, as it really can."""

        def put_nowait(self, item):
            super().put_nowait(item)
            pool._stopping.set()

    pool._queue = StopMidInsertion(maxsize=4)
    monkeypatch.setattr(pool, "_drop_queued", drain_that_throws)

    sources = data / f"{SOURCE_PREFIX}{2:032x}"
    sources.mkdir(parents=True)
    (sources / "model.py").write_text("# a pushed source tree\n")
    record = jobs.create("proj1", "c1")

    # The assertion is first of all that this RETURNS rather than raising.
    assert pool.submit(BuildTask(
        job_id=record["id"], pid="proj1", commit="c1", sources=sources,
        archive=_accepted_body(data, 2), digest="digest-2")) == SUBMIT_STOPPED
    # And that the job is terminal, so it does not leave a pusher polling a
    # status that will never change again.
    answered = jobs.get(record["id"])
    assert answered["state"] == STATE_FAILED
    assert answered["code"] == RESTART_CODE
    assert answered["error"] == STOPPED_ERROR


def test_a_stop_whose_drain_throws_still_joins_its_workers(tmp_path,
                                                           monkeypatch):
    """`shutdown` runs when there is nothing after it.

    The drain walks the volume — a directory per queued task, a record per job —
    so it is not a step that cannot fail. Letting it out would skip every join
    below it and come out of `server_close`, leaving a worker mid-publish to be
    killed between the rename and the pointer writes: the exact ending the join
    exists to prevent.
    """
    data = tmp_path / "data"
    pool = BuildQueue(_bare_store(data), JobStore(data),
                      build_runner=copying_builder)
    pool.start()

    def explode():
        raise RuntimeError("the volume went away in the middle of the drain")

    monkeypatch.setattr(pool, "_drop_queued", explode)
    pool.shutdown()
    _await_no_workers()


def test_the_listening_socket_is_closed_before_the_pool_is_drained(tmp_path,
                                                                   monkeypatch):
    """A hub on its way out must stop accepting, not accept and then refuse.

    The pool's shutdown drains the queue and then waits out its join budget, and
    with the socket still open every moment of that is a moment in which the hub
    takes a connection, spools a body, unpacks a tree and hands it to a pool
    that is stopping — work whose only possible ending is a job saying to push
    again.
    """
    hub = start_hub(tmp_path / "data")
    seen = {}
    draining = hub.server.builds.shutdown

    def watched():
        # -1 is what `socket.close()` leaves behind, so this is the question
        # "had the socket already been closed when the drain started".
        seen["socket_closed"] = hub.server.socket.fileno() == -1
        draining()

    monkeypatch.setattr(hub.server.builds, "shutdown", watched)
    stop_hub(hub)
    assert seen["socket_closed"] is True


def test_the_hub_answers_sigterm_by_shutting_down(tmp_path):
    """SIGTERM is how `docker stop` ends this service, i.e. every deploy.

    Under the default disposition the process is just terminated: `serve_forever`
    never returns, `server_close` never runs, and the build pool's shutdown —
    the queue drain and the wait for a worker mid-publish — never runs in
    production at all, only under Ctrl+C on somebody's laptop.
    """
    from main import install_stop_handler

    hub = start_hub(tmp_path / "data")
    previous = signal.getsignal(signal.SIGTERM)
    try:
        install_stop_handler(hub.server)
        os.kill(os.getpid(), signal.SIGTERM)
        hub._thread.join(timeout=10)
        assert not hub._thread.is_alive(), (
            "SIGTERM did not stop the server; if this hangs rather than fails, "
            "the handler called shutdown() on the thread that serves")
    finally:
        signal.signal(signal.SIGTERM, previous)
        stop_hub(hub)


def test_the_sigterm_handler_never_waits_on_threadings_own_lock():
    """The handler wakes a thread; it must not START one.

    `Thread.start()` takes `threading._active_limbo_lock`, and the main thread
    holds that same lock every time `ThreadingHTTPServer` spawns a thread for an
    incoming connection. A Python signal handler runs ON THE MAIN THREAD between
    two bytecodes, so it can be entered while that thread is inside `start()` —
    and a `start()` from the handler would then wait for a lock its own thread
    holds. Nothing would release it: the handler never returns, the serve loop
    never comes round, and the stop hangs until SIGKILL, which is the ending the
    handler was written to prevent.

    The lock is held by another thread here rather than by this one, so the
    failure shows up as a DELAY instead of a deadlock and this test can report
    it rather than hang on it.
    """
    from main import install_stop_handler

    limbo_lock = getattr(threading, "_active_limbo_lock", None)
    if limbo_lock is None:
        pytest.skip("this interpreter does not expose threading's limbo lock")

    class StubServer:
        def __init__(self):
            self.stopped = threading.Event()

        def shutdown(self):
            self.stopped.set()

    server = StubServer()
    holding, release = threading.Event(), threading.Event()

    def hold_the_lock():
        with limbo_lock:
            holding.set()
            # Bounded whatever happens: before the fix the handler blocks on
            # this lock, so the main thread cannot reach the line below that
            # would otherwise release it.
            release.wait(timeout=1.0)

    holder = threading.Thread(target=hold_the_lock, name="limbo-holder",
                              daemon=True)
    previous = signal.getsignal(signal.SIGTERM)
    try:
        install_stop_handler(server)
        holder.start()
        assert holding.wait(timeout=5)

        started = time.monotonic()
        os.kill(os.getpid(), signal.SIGTERM)
        assert server.stopped.wait(timeout=5)
        took = time.monotonic() - started

        assert took < 0.5, (
            f"the stop took {took:.2f}s to start while another thread held "
            f"threading's limbo lock, so the handler is waiting on it — held "
            f"by the main thread instead, that wait never ends")
    finally:
        release.set()
        holder.join(timeout=5)
        signal.signal(signal.SIGTERM, previous)


# -- the seam nothing else in this suite crosses -----------------------------
def test_the_worker_calls_the_real_run_build_the_way_it_is_declared(hub_factory,
                                                                    monkeypatch):
    """Every other test in this suite substitutes the builder, on purpose.

    Computing geometry per test is minutes and needs CadQuery, so the stand-in
    stays — but with it in place NOTHING exercises the join between
    `_build_and_publish` and `src.buildproc.run_build`. Renaming a parameter
    there leaves the whole suite green and breaks production on the first push.

    So the call is captured as the worker really made it and then bound against
    the real function's signature. Both halves are needed: binding an expression
    written out here would only check a copy that stops following the worker,
    and `build_arguments` is what makes the two the same expression rather than
    two that happen to agree today.

    WHICH IS WHY THE HELPER IS WATCHED RATHER THAN RE-EVALUATED. Comparing the
    captured call against `build_arguments(...)` called again here proves only
    that the two AGREE, and a worker that spelled the same expression out by
    hand agrees perfectly — right up until `build_arguments` is changed and the
    hand-written copy is not, which is the whole failure this is guarding. So
    the helper itself reports whether it was the one that built the call.
    """
    class CallRecorder:
        def __init__(self):
            self.call = None

        def __call__(self, *args, **keywords):
            self.call = (args, keywords)
            return copying_builder(*args, **keywords)

    built_by_the_helper = []
    helper = jobs_module.build_arguments

    def watched(*args, **keywords):
        call = helper(*args, **keywords)
        built_by_the_helper.append(call)
        return call

    monkeypatch.setattr(jobs_module, "build_arguments", watched)
    recorder = CallRecorder()
    hub = hub_factory(build_runner=recorder)
    assert hub.publish("proj1", "abc123", good_build()).status_code == 201

    args, keywords = recorder.call
    # `bind` raises TypeError the moment `run_build`'s signature stops accepting
    # what the worker passes — a renamed keyword, an argument that moved.
    inspect.signature(run_build).bind(*args, **keywords)
    # ...and the call the worker made is the one the helper handed it, so the
    # check above is pointed at the real call rather than at a copy of it.
    assert built_by_the_helper == [(args, keywords)], (
        "the worker did not get its arguments from `build_arguments`, so "
        "nothing keeps the call it makes and the call this test binds together")
    # Belt and braces on the helper itself: it is the expression, not a wrapper
    # that could quietly start returning something else.
    assert build_arguments(args[0], args[1], keywords["pid"]) == (args, keywords)


def test_a_publish_reply_is_reconstructed_from_the_job(hub):
    """The harness helper the rest of the suite leans on, pinned once here.

    Two hundred tests call `Hub.publish` and read a status code off it; if this
    translation were wrong they would all be asserting against a fiction.
    """
    reply = hub.publish_async("proj1", "abc123", good_build())
    record = hub.job(reply.json()["job"], token=TOKEN)
    hub.await_job(reply.json()["job"])
    finished = hub.job(reply.json()["job"]).json()

    rebuilt = PublishReply(finished)
    assert rebuilt.status_code == finished["code"] == 201
    assert rebuilt.json() == {"url": "/project/proj1/abc123/"}
    assert json.loads(rebuilt.text) == rebuilt.json()
    assert record.status_code == 200
