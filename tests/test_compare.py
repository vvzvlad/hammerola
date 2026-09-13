"""`POST /api/v1/compare/<pid>/<old>/<new>` — the way to the engine (issue #10).

`src/cadbuild/shapediff.py` can say how much material a part gained and lost
between two revisions. NOTHING IN THE SERVICE COULD REACH IT until this route
existed, and everything between the request and the engine is what this file is
about: the door, the two revisions being real, the job the request is answered
with, and the worker taking that job to the COMPARER rather than to the builder.

THE GEOMETRY ITSELF IS NOT HERE AND CANNOT BE. Measuring two solids needs the
CAD kernel, which costs ~450 MB resident and minutes per part — that is the
entire reason the comparison runs in a child process — so the suite substitutes
the runner exactly as it substitutes the builder (`harness.reading_comparer`).
The one test that crosses back over to the real function is the last one, which
binds the call the worker makes against `run_compare`'s real signature.

WHAT THE JOB CARRIES is worth stating before the tests, because it is the whole
of the contract with the client: the record names the NEWER revision, since
`jobs.create` takes one commit and that is the one a person means by "which
build was this about" — and the LOG's first line names BOTH, because the report
is the log and a report that did not say what it compared would be unreadable.
"""

import inspect
import queue

import pytest
from harness import (TOKEN, copying_builder, failing_comparer, good_build,
                     reading_comparer)

from src import jobs as jobs_module
from src.buildproc import STATUS_CRASHED, STATUS_OK, run_compare
from src.jobs import (QUEUE_FULL_ERROR, RESTART_CODE, STATE_DONE, STATE_FAILED,
                      STOPPED_ERROR, BuildQueue, CompareTask, JobStore,
                      compare_arguments)
from src.store import Store

PID = "proj1"
OLD = "aaa111"
NEW = "bbb222"


def ask(hub, pid=PID, old=OLD, new=NEW, token=TOKEN, tail=""):
    """POST the comparison and return the raw reply, 4xx included."""
    headers = {"Authorization": f"Bearer {token}"} if token is not None else {}
    return hub.request("POST", f"/api/v1/compare/{pid}/{old}/{new}{tail}",
                       headers=headers)


def two_revisions(hub, pid=PID):
    """Publish two builds of one project, so there is something to compare."""
    assert hub.publish(pid, OLD, good_build(marker="a")).status_code == 201
    assert hub.publish(pid, NEW, good_build(marker="b")).status_code == 201


def finished(hub, reply, token=TOKEN):
    """Wait for the job a 202 named and hand back its record and its log."""
    assert reply.status_code == 202, reply.text
    job_id = reply.json()["job"]
    record = hub.await_job(job_id, token=token).record
    return record, hub.job_log(job_id, token=token).text


# -- the door ----------------------------------------------------------------
@pytest.mark.parametrize("token", [None, "not-the-token"])
def test_a_comparison_is_refused_without_the_token(hub, token):
    """One secret guards this like it guards a push (SPEC 7.4, issue #26).

    A comparison reads two revisions and spends what a build spends, so it is on
    the writing side of the token whichever way you look at it.
    """
    two_revisions(hub)
    assert ask(hub, token=token).status_code == 401


@pytest.mark.parametrize("pid,old,new", [
    ("nobody-has-this", OLD, NEW),      # a project that does not exist
    (PID, "cccccc", NEW),               # a revision that was never published
    (PID, OLD, "not$a$name"),           # a name no build could ever have
])
def test_the_token_is_checked_before_the_url_is_looked_at(hub, pid, old, new):
    """401 AND NOT 404, and the difference is the point.

    Every one of these would be a 404 with the token — the project is unknown,
    the revision is not there, the name could never be a build id. Answering
    them differently from a well-formed request would make this route a way to
    ask "does this hub hold that project" without holding the secret.
    """
    two_revisions(hub)
    assert ask(hub, pid=pid, old=old, new=new, token=None).status_code == 401


# -- what there is to compare ------------------------------------------------
@pytest.mark.parametrize("pid,old,new", [
    # The SHAPE of a name, through `store.valid_pid` / `valid_build_id`.
    ("not a pid", OLD, NEW),
    (PID, "not$a$name", NEW),
    (PID, OLD, "not$a$name"),
    # THE TWO RESERVED NAMES, and they are the interesting refusal in this list:
    # `<pid>/dev` and `<pid>/latest` are both real directories on this hub. They
    # are refused because they are POINTERS — a comparison against a slot that
    # is rewritten while it runs is a report about nothing in particular.
    (PID, "dev", NEW),
    (PID, OLD, "latest"),
    # A project nobody pushed, and a revision this project never had, in either
    # position.
    ("nobody-has-this", OLD, NEW),
    (PID, "cccccc", NEW),
    (PID, OLD, "cccccc"),
])
def test_a_comparison_of_something_the_hub_does_not_hold_is_404(hub, pid, old,
                                                                new):
    two_revisions(hub)
    # The slot exists too, so `dev` above is refused for being reserved rather
    # than for being absent.
    assert hub.publish_dev(PID, good_build(marker="d")).status_code == 201
    assert ask(hub, pid=pid, old=old, new=new).status_code == 404


@pytest.mark.parametrize("path", [
    "/api/v1/compare",
    f"/api/v1/compare/{PID}",
    f"/api/v1/compare/{PID}/{OLD}",
    f"/api/v1/compare/{PID}/{OLD}/{NEW}/and-another",
])
def test_a_comparison_takes_exactly_three_segments(hub, path):
    """Two revisions of one project, said in the URL and nowhere else."""
    two_revisions(hub)
    reply = hub.request("POST", path,
                        headers={"Authorization": f"Bearer {TOKEN}"})
    assert reply.status_code == 404


def test_a_comparison_of_a_revision_against_itself_is_taken(hub):
    """Not refused: the answer "nothing moved" is a real answer, and the client
    already declines to ask when the two ids it resolved are equal. A rule here
    would be a second opinion about the same question in another process."""
    two_revisions(hub)
    record, _log = finished(hub, ask(hub, old=NEW, new=NEW))
    assert record["state"] == STATE_DONE


# -- the handover ------------------------------------------------------------
def test_a_comparison_is_answered_with_a_job_to_poll(hub):
    """202 and the three URLs, the same handover a push gets (SPEC 8A.2 step 5).

    The comparison takes as long as a build takes, for the same reason — the CAD
    kernel — so the request cannot wait for it and the answer is where to look.
    """
    two_revisions(hub)
    reply = ask(hub)

    assert reply.status_code == 202
    payload = reply.json()
    job_id = payload["job"]
    assert payload["status_url"] == f"/api/v1/jobs/{job_id}"
    assert payload["log_url"] == f"/api/v1/jobs/{job_id}/log"
    # The header a well-behaved client follows, saying the same thing as the
    # body rather than something else.
    assert reply.headers["Location"] == payload["status_url"]

    record, log = finished(hub, reply)
    assert record["state"] == STATE_DONE
    assert log


def test_a_comparison_goes_to_the_comparer_and_never_to_the_builder(
        hub_factory):
    """THE POINT OF THE TWO SEAMS BEING TWO, and not one runner told which job.

    `BuildQueue` dispatches on the TYPE of the task, so a comparison that ended
    up in `_build_and_publish` would try to publish two revisions over each
    other. Counting both runners is what says the dispatch happened; asserting
    the comparer's arguments is what says it got the right two directories.
    """
    built, compared = [], []

    def watched_builder(*args, **keywords):
        built.append((args, keywords))
        return copying_builder(*args, **keywords)

    def watched_comparer(*args, **keywords):
        compared.append((args, keywords))
        return reading_comparer(*args, **keywords)

    hub = hub_factory(build_runner=watched_builder,
                      compare_runner=watched_comparer)
    two_revisions(hub)
    assert len(built) == 2 and compared == []

    record, _log = finished(hub, ask(hub))
    assert record["state"] == STATE_DONE

    assert len(built) == 2, "the comparison was handed to the BUILDER"
    assert len(compared) == 1
    (old_dir, new_dir), keywords = compared[0]
    assert old_dir == hub.project_dir(PID) / OLD
    assert new_dir == hub.project_dir(PID) / NEW
    assert keywords == {"pid": PID}


def test_the_job_names_the_newer_revision_and_the_log_names_both(hub):
    """The record has ONE commit field and the comparison has two revisions.

    So the newer one goes in the record — it is what a person means by "which
    build was this about" — and both go in the log's first line, which is the
    only place the pair is written down at all.
    """
    two_revisions(hub)
    record, log = finished(hub, ask(hub))

    assert record["commit"] == NEW
    assert record["pid"] == PID
    first = log.splitlines()[0]
    assert OLD in first and NEW in first and PID in first


def test_the_log_names_both_revisions_even_when_the_comparison_said_nothing(
        hub_factory):
    """THE FIRST LINE IS THE HUB'S, and that is why it survives this.

    A child that died before printing a word leaves an empty log, and the job
    record carries only the newer revision — so a log written entirely by the
    child would leave nothing, anywhere, saying what this job was comparing.
    Which is exactly the moment somebody needs to know.
    """
    hub = hub_factory(compare_runner=failing_comparer(log=""))
    two_revisions(hub)
    record, log = finished(hub, ask(hub))

    assert record["state"] == STATE_FAILED
    assert log.splitlines()[0] == f"comparing {PID}: {OLD} -> {NEW}"


def test_a_comparison_that_ends_badly_is_the_hub_s_own_problem(hub_factory):
    """500, and not the 422 a broken push gets.

    Both revisions being compared were built and published by this hub: there is
    no upload to blame, so a crash, a hang or an exhausted ceiling is the hub's
    fault, and saying 422 would send somebody looking for a mistake in a model
    that is fine. The log is still delivered, because a comparison that died
    halfway has already said something useful about the parts it reached.
    """
    hub = hub_factory(compare_runner=failing_comparer(
        status=STATUS_CRASHED, log="compareproc: the kernel died\n"))
    two_revisions(hub)
    record, log = finished(hub, ask(hub))

    assert record["state"] == STATE_FAILED
    assert record["code"] == 500
    assert record["status"] == STATUS_CRASHED
    assert STATUS_CRASHED in record["error"]
    assert "the kernel died" in log


def test_a_comparison_refused_by_a_full_queue_does_not_leave_a_job_queued(
        hub_factory):
    """The same ending `_queue_build` gives a push it cannot take.

    A job nothing will ever pick up is a status endpoint that answers `queued`
    for ever, so the route fails it on the spot — and the 503 carries the wait,
    because the caller's only sensible move is to ask again later.
    """
    held = queue.Queue()

    def blocked_comparer(old_dir, new_dir, *, pid, **kw):
        held.get()
        return reading_comparer(old_dir, new_dir, pid=pid, **kw)

    hub = hub_factory(compare_runner=blocked_comparer, build_workers=1,
                      build_queue_size=1)
    two_revisions(hub)
    try:
        # One in the worker (blocked on `held`), one filling the queue of one.
        assert ask(hub).status_code == 202
        assert ask(hub).status_code == 202
        refused = ask(hub)
    finally:
        for _ in range(3):
            held.put(None)

    assert refused.status_code == 503
    assert refused.json()["error"] == QUEUE_FULL_ERROR
    assert int(refused.headers["Retry-After"]) > 0


def test_a_queued_comparison_is_dropped_by_the_stop_without_a_tree_to_remove(
        tmp_path):
    """A `CompareTask` owns no sources and no body, and the drain must know it.

    `_drop_queued` removes a build task's unpacked tree and its pushed body,
    neither of which exists here: the two revisions are in the store and stay
    there. Reaching for `task.sources` would raise inside the one loop that runs
    when there is nothing after it — taking every worker join with it — so the
    task type is what decides, and the job is answered either way.
    """
    data = tmp_path / "data"
    jobs = JobStore(data)
    pool = BuildQueue(Store(data_dir=data, max_build_bytes=8 * 1024 * 1024),
                      jobs, compare_runner=reading_comparer)
    record = jobs.create(PID, NEW)
    # Put straight into the queue rather than through `submit`, so nothing can
    # take it before the stop does: the pool was never started.
    pool._queue.put_nowait(CompareTask(job_id=record["id"], pid=PID, old=OLD,
                                       new=NEW))

    pool.shutdown()

    answered = jobs.get(record["id"])
    assert answered["state"] == STATE_FAILED
    assert answered["code"] == RESTART_CODE
    assert answered["error"] == STOPPED_ERROR


# -- the seam nothing else in this file crosses ------------------------------
def test_the_worker_calls_the_real_run_compare_the_way_it_is_declared(
        hub_factory, monkeypatch):
    """The comparer is substituted everywhere above, exactly as the builder is.

    So nothing else in the suite exercises the join between
    `_compare_and_record` and `src.buildproc.run_compare`, and a parameter
    renamed there would leave every test green and fail on the first real
    request. This is the copy of `test_jobs.py`'s builder-side test, pointed at
    the other runner, and it holds the same two things: the call is captured as
    the worker really made it, and `compare_arguments` reports that it is the
    one that built it — so the signature check below is aimed at the real call
    rather than at a copy that has stopped following the worker.
    """
    class CallRecorder:
        def __init__(self):
            self.call = None

        def __call__(self, *args, **keywords):
            self.call = (args, keywords)
            return reading_comparer(*args, **keywords)

    built_by_the_helper = []
    helper = jobs_module.compare_arguments

    def watched(*args, **keywords):
        call = helper(*args, **keywords)
        built_by_the_helper.append(call)
        return call

    monkeypatch.setattr(jobs_module, "compare_arguments", watched)
    recorder = CallRecorder()
    hub = hub_factory(compare_runner=recorder)
    two_revisions(hub)
    record, _log = finished(hub, ask(hub))
    assert record["state"] == STATE_DONE

    args, keywords = recorder.call
    # `bind` raises TypeError the moment `run_compare`'s signature stops
    # accepting what the worker passes.
    inspect.signature(run_compare).bind(*args, **keywords)
    assert built_by_the_helper == [(args, keywords)], (
        "the worker did not get its arguments from `compare_arguments`, so "
        "nothing keeps the call it makes and the call this test binds together")
    # EVERY KEYWORD NAMED BY HAND, for the reason the builder-side test gives: a
    # new argument the worker passes and this does not leaves the assertion
    # comparing two calls that both lack it.
    assert compare_arguments(args[0], args[1], keywords["pid"]) == (args,
                                                                    keywords)


def test_the_stand_in_comparer_answers_what_the_job_machinery_expects(tmp_path):
    """The suite's comparer stands in for a runner whose shape is fixed.

    `_compare_and_record` reads five fields off whatever comes back, and a
    stand-in that drifted from `BuildOutcome` would take every test above with
    it while saying nothing about the hub.
    """
    old_dir, new_dir = tmp_path / "old", tmp_path / "new"
    for directory in (old_dir, new_dir):
        directory.mkdir()
        (directory / "lid.step").write_bytes(b"ISO-10303-21;\n")

    outcome = reading_comparer(old_dir, new_dir, pid=PID)
    assert outcome.status == STATUS_OK and outcome.ok
    assert outcome.pid == PID
    assert outcome.files == ()
    assert outcome.log_truncated is False
    assert outcome.duration_seconds >= 0
    assert "old -> new" in outcome.log and "1 parts" in outcome.log
