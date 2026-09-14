"""`POST /api/v1/compare/<pid>/<old>/<new>[/<view>]` — the way to the engine (#10).

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

THE SECOND HALF OF THIS FILE IS THE ARTEFACT (cut 2). A fourth segment names a
VIEW, and with it the same job also leaves a viewer document and a summary in
the comparison cache — `data/compare/<pid>/<a>/<b>/<view>/` — which the page at
`/project/<pid>/<a>/compare/<b>/` then fetches. The geometry is still not here:
`scene_comparer` below writes two files a real child would write and says
nothing about what is in them, because what this file is about is the carrying —
which directory, which cache header, which door, and what happens to a job that
produced nothing.
"""

import inspect
import json
import os
import queue
import time
from dataclasses import replace
from pathlib import Path
from urllib.parse import quote

import pytest
from harness import (TOKEN, copying_builder, failing_comparer, good_build,
                     reading_comparer, view_bytes)

from src import jobs as jobs_module
from src.app import VIEW_NOT_IN_BOTH_ERROR, VIEW_NOT_NAMEABLE_ERROR
from src.buildproc import STATUS_CRASHED, STATUS_OK, run_compare
from src.buildproc import comparechild, runner as runner_module
from src.jobs import (QUEUE_FULL_ERROR, RESTART_CODE, STATE_DONE, STATE_FAILED,
                      STOPPED_ERROR, BuildQueue, CompareTask, JobStore,
                      compare_arguments)
from src.store import COMPARE_FILES, Store

PID = "proj1"
OLD = "aaa111"
NEW = "bbb222"
# The view `good_build` publishes, and therefore the only one a comparison of
# two of those builds can be asked for.
VIEW = "assembled"


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


def scene_comparer(old_dir, new_dir, *, pid, out_dir=None, view=None, **kw):
    """`reading_comparer`, plus the two files a real child leaves behind.

    The stand-in for the ARTEFACT half, and it stands in for exactly the part
    this suite cannot run: building a scene needs the kernel and the geometry
    module that tessellates with it. What it writes is two JSON documents naming
    the view they were made for, which is enough for every question here — is
    the directory the one the store named, did the rename happen, is the file
    served under the right cache header — and nothing about their CONTENT is
    asserted anywhere, because nothing in the hub reads it.

    It also declares the two names in `files`, because the real runner does: the
    parent checks they arrived and that check is what tells a job with something
    to publish from one without.
    """
    outcome = reading_comparer(old_dir, new_dir, pid=pid)
    if out_dir is None:
        return outcome
    for name, document in (("scene.json", {"view": view, "part": "cmp"}),
                           ("report.json", {"parts": [], "view": view})):
        (Path(out_dir) / name).write_text(json.dumps(document),
                                          encoding="utf-8")
    return replace(outcome, files=COMPARE_FILES)


def compared(hub, pid=PID, old=OLD, new=NEW, view=VIEW):
    """The cache entry one comparison of this hub would have written."""
    return hub.store.compare_dir(pid, old, new, view)


def fetch(hub, name, pid=PID, old=OLD, new=NEW, view=VIEW, token=TOKEN):
    """GET one file of a comparison, with the view in the query (SPEC 3)."""
    headers = {"Authorization": f"Bearer {token}"} if token is not None else {}
    tail = "" if view is None else f"?v={view}"
    return hub.get(f"/project/{pid}/{old}/compare/{new}/{name}{tail}",
                   headers=headers)


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
    # Four segments IS a shape — the fourth names a view — but `and-another` is
    # not a view either revision published, and a fifth segment is nothing at
    # all.
    f"/api/v1/compare/{PID}/{OLD}/{NEW}/and-another",
    f"/api/v1/compare/{PID}/{OLD}/{NEW}/{VIEW}/and-another",
])
def test_a_comparison_takes_three_segments_or_four(hub, path):
    """Two revisions of one project, and at most a view, said in the URL."""
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
    # No fourth segment, so no artefact: the runner is told to write nothing,
    # explicitly rather than by the argument being absent.
    assert keywords == {"pid": PID, "out_dir": None, "view": None}


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
    assert compare_arguments(args[0], args[1], keywords["pid"],
                             out_dir=keywords["out_dir"],
                             view=keywords["view"]) == (args, keywords)


def test_the_artefact_call_is_the_same_call_with_a_directory_and_a_view(
        hub_factory):
    """The OTHER mode crosses the same seam, and it is the one with arguments.

    The test above binds a call with `out_dir=None`, which would go on binding
    if the parameter that carries the artefact were renamed under it: None is
    accepted by any keyword that still exists. This asks for a comparison with a
    view and binds the call that really carries a directory.
    """
    calls = []

    def watched(*args, **keywords):
        calls.append((args, keywords))
        return scene_comparer(*args, **keywords)

    hub = hub_factory(compare_runner=watched)
    two_revisions(hub)
    record, _log = finished(hub, ask(hub, tail=f"/{VIEW}"))
    assert record["state"] == STATE_DONE

    (args, keywords) = calls[0]
    inspect.signature(run_compare).bind(*args, **keywords)
    assert keywords["view"] == VIEW
    # The STAGING directory and never the entry itself: what the child writes
    # into is renamed into place afterwards, so the name it was given is gone by
    # the time the job ends.
    staging = keywords["out_dir"]
    assert staging.parent == compared(hub).parent
    assert staging.name.startswith(".") and not staging.exists()
    assert compared(hub).is_dir()


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


# -- the artefact: what the job leaves behind (cut 2) ------------------------
def test_the_three_spellings_of_the_two_artefact_names_are_one_list():
    """The child writes them, the parent checks them, the server serves them.

    Three modules name the same two files and none of them may import another:
    `comparechild` runs in the build process and reaching it from the hub would
    put `src.cadbuild` in the hub's own interpreter, which is the one thing the
    serving side does not do. So the tuple is written three times and held equal
    here — the arrangement `render.py` already uses for the build half's
    constants. A name added in one place and not the others is a comparison the
    parent calls a crash, or a file nothing will serve.
    """
    assert comparechild.ARTEFACTS == COMPARE_FILES
    assert runner_module._COMPARE_ARTEFACTS == COMPARE_FILES


def test_a_view_makes_the_job_publish_a_scene_and_a_report(hub_factory):
    """The fourth segment, end to end: 202, a job, and a cache entry.

    The entry lives OUTSIDE the two build directories (SPEC 8A.3) — under
    `data/compare/`, keyed by the pair and the view — because a build directory
    is public and carries a year of `immutable`, and this is neither.
    """
    hub = hub_factory(compare_runner=scene_comparer)
    two_revisions(hub)

    record, log = finished(hub, ask(hub, tail=f"/{VIEW}"))

    assert record["state"] == STATE_DONE
    # The log is what it was without a view: the artefact is an addition to the
    # report, not a replacement for it.
    assert log.splitlines()[0] == f"comparing {PID}: {OLD} -> {NEW}"
    entry = compared(hub)
    assert entry == hub.data / "compare" / PID / OLD / NEW / VIEW
    assert sorted(path.name for path in entry.iterdir()) == sorted(COMPARE_FILES)
    # Nothing landed anywhere near the two published revisions.
    assert not (hub.project_dir(PID) / OLD / "scene.json").exists()


def test_a_comparison_without_a_view_writes_no_cache_entry_at_all(hub_factory):
    """The three-segment route is the CLI's and it is unchanged (cut 1).

    `hammerola diff --material` reads the log and fetches nothing, so a
    comparison it asks for must not spend a tessellation on a scene nobody will
    open — and must not leave a directory behind that says one exists.
    """
    hub = hub_factory(compare_runner=scene_comparer)
    two_revisions(hub)

    record, _log = finished(hub, ask(hub))

    assert record["state"] == STATE_DONE
    assert not (hub.data / "compare").exists()


def test_a_comparison_that_ended_badly_leaves_no_half_written_entry(
        hub_factory):
    """A job that produced nothing must not look like one that produced a scene.

    The staging directory is created before the child runs, so the failure this
    is about is not hypothetical: leaving it behind under its own name would be
    a `.tmp-` nobody sweeps for four hours, and renaming it into place would be
    a comparison page that loads an empty scene.
    """
    hub = hub_factory(compare_runner=failing_comparer())
    two_revisions(hub)

    record, _log = finished(hub, ask(hub, tail=f"/{VIEW}"))

    assert record["state"] == STATE_FAILED
    assert not compared(hub).exists()
    # Not under any name: the staging directory is what the child was writing
    # into, and it is dot-prefixed, so left behind it would be invisible until
    # the sweep four hours later. The empty `<a>/<b>/` the store made to hold it
    # is not an entry and nothing serves it.
    assert [path for path in (hub.data / "compare").rglob("*")
            if path.name.startswith(".tmp-")] == []


def test_a_second_comparison_of_the_same_pair_replaces_the_entry(hub_factory):
    """A cache entry is REPLACED and never refused, unlike a build.

    Nothing here is a permanent URL somebody was handed, so there is no 409 to
    give: a pair recomputed is the same answer again.
    """
    hub = hub_factory(compare_runner=scene_comparer)
    two_revisions(hub)

    for _ in range(2):
        record, _log = finished(hub, ask(hub, tail=f"/{VIEW}"))
        assert record["state"] == STATE_DONE

    assert sorted(path.name for path in compared(hub).iterdir()) == sorted(
        COMPARE_FILES)
    # And nothing parked beside it: the old entry is removed once the new one
    # has the name (`store._replace_directory`).
    assert [path.name for path in compared(hub).parent.iterdir()] == [VIEW]


def test_a_view_the_two_revisions_do_not_both_have_is_404(hub_factory):
    """Checked before the job is queued, exactly as the revisions are.

    A scene is built out of both revisions' published view documents, so a view
    one of them never had cannot produce one — and a job that is certain to fail
    is worse than a refusal, because it is answered minutes later and reads as a
    hub that is broken.
    """
    hub = hub_factory(compare_runner=scene_comparer)
    two_revisions(hub)

    reply = ask(hub, tail="/nobody-has-this")

    assert reply.status_code == 404
    # AND IT SAYS WHY, because the panel prints the body: `not found` under a
    # comparison of a view the author added or dropped between the two
    # revisions reads as a hub that lost something, when what happened is the
    # ordinary thing this sentence names.
    assert reply.json()["error"] == VIEW_NOT_IN_BOTH_ERROR
    # And it does not repeat the caller's own bytes back, the rule the 422
    # beside it is held to for the same reason.
    assert "nobody-has-this" not in reply.text
    assert not (hub.data / "compare").exists()


@pytest.mark.parametrize("view", [
    "not$a$view",     # an alphabet no view id passes on the way in either
    "with space",     # `render._plain_text` takes this, so a build may publish
                      # it; a directory segment of ours may not be one
    ".hidden",        # a segment this hub never writes
    "виды",           # legal text, and not a name this store puts in a path
    "x" * 129,        # one character past what a view id may be
])
def test_a_view_whose_name_cannot_be_a_directory_is_refused_in_words(
        hub_factory, view):
    """422 AND A SENTENCE, and this is the one refusal here that is not a 404.

    A view id is the author's own string, held on the way in to
    `hubspec.MEMBER_RE` and to `render._plain_text` — neither of which knows
    anything about directories. This route is the first place it has to BE one,
    so the restriction is new here, and a bare 404 told the reader nothing about
    the name being the reason: the view published, drew its tab, and answered a
    comparison with silence.

    PERCENT-ENCODED, because a space cannot travel in a request line as itself.

    TWO NAMES ARE DELIBERATELY NOT IN THIS LIST and both are in the store's own
    test below, which is where they can be asked at all. `a/b` in any spelling
    is a FIFTH segment — `_split` unquotes before it splits — so the shape check
    two lines earlier answers it. And `..` never reaches this hub from a client:
    httpx resolves `%2E%2E` back to `..` and collapses the path before it sends,
    so the request that arrives is a different URL entirely.

    Nothing is queued and nothing is written, exactly as for the 404s.
    """
    hub = hub_factory(compare_runner=scene_comparer)
    two_revisions(hub)

    reply = ask(hub, tail=f"/{quote(view, safe='')}")

    assert reply.status_code == 422
    assert reply.json()["error"] == VIEW_NOT_NAMEABLE_ERROR
    # The sentence says what to do about it, which is the reason it exists.
    assert "Rename" in VIEW_NOT_NAMEABLE_ERROR
    assert not (hub.data / "compare").exists()


def test_a_view_name_the_hub_cannot_file_is_not_echoed_back(hub_factory):
    """The refusal states the RULE and never repeats the caller's own bytes.

    `_refused_names_error` makes the argument at length for member names: a
    message built out of what was sent is this hub echoing attacker-chosen text
    into a JSON body and into whatever reads its logs, at whatever length the
    request line allowed. The reader has the name in their own URL.
    """
    hub = hub_factory(compare_runner=scene_comparer)
    two_revisions(hub)

    reply = ask(hub, tail="/scr%3Cipt%3E")

    assert reply.status_code == 422
    assert "cript" not in reply.text


def test_a_view_a_build_can_really_publish_is_comparable(hub_factory):
    """A DOT IN A VIEW NAME IS LEGAL, and this is the whole of issue's cut 2
    finding: the cache held every segment to `SAFE_ID`, which has no dot in it,
    while a view id is held at build time to `hubspec.MEMBER_RE`, which does.

    So `top.v2` published, showed its tab, and answered a comparison of that tab
    with a bare 404 — a name refused by a rule nobody had ever told the author
    about. The end-to-end path is what this asserts, because the defect was in
    the seam: the POST is taken, the entry is filed under the name as given, and
    the two files come back from the address the page fetches.
    """
    hub = hub_factory(compare_runner=scene_comparer)
    dotted = {"views": [{"id": "top.v2", "name": "top", "file": "top.v2.json",
                         "parts": ["lid", "pin"]}]}
    for revision, marker in ((OLD, "a"), (NEW, "b")):
        assert hub.publish(PID, revision, good_build(
            marker=marker, extra_files={"top.v2.json": view_bytes(marker)},
            **dotted)).status_code == 201

    record, _log = finished(hub, ask(hub, tail="/top.v2"))

    assert record["state"] == STATE_DONE
    entry = compared(hub, view="top.v2")
    assert entry == hub.data / "compare" / PID / OLD / NEW / "top.v2"
    assert sorted(path.name for path in entry.iterdir()) == sorted(COMPARE_FILES)
    for name in COMPARE_FILES:
        assert fetch(hub, name, view="top.v2").status_code == 200


def test_a_view_only_one_of_the_revisions_published_is_404(hub_factory):
    """The half that a name-shape check cannot answer: both, or neither.

    THE COMMON WAY TO REACH THAT REFUSAL, and the reason it is worded: `top` is
    a real view of a real revision, drawn as a tab on the page the reader is
    standing on, and the other end of the pair simply predates it. Nothing is
    broken and nothing needs renaming, so the sentence says which of the two
    revisions is short of what — not `not found`.
    """
    hub = hub_factory(compare_runner=scene_comparer)
    assert hub.publish(PID, OLD, good_build(
        marker="a", extra_files={"top.json": b"{}"})).status_code == 201
    assert hub.publish(PID, NEW, good_build(marker="b")).status_code == 201

    reply = ask(hub, tail="/top")

    assert reply.status_code == 404
    assert reply.json()["error"] == VIEW_NOT_IN_BOTH_ERROR


# -- the parent's one look at the disk ---------------------------------------
def finished_process(log="comparing old -> new, 1 parts\n"):
    """A child that exited 0, as `run_isolated` reports one."""
    return runner_module.ProcessResult(
        exit_code=0, signal=None, timed_out=False, log=log,
        log_truncated=False, dropped_bytes=0, duration_seconds=0.5,
        stragglers=False)


def test_the_parent_reports_the_two_files_it_asked_for(tmp_path):
    """`files` is the parent's answer on this path too, and it is a small one.

    There is no forgery to be worried about — the child is our own module, not
    somebody's model — so the question is only whether the artefact arrived:
    that is what tells a job with something to publish from one without.
    """
    out = tmp_path / "out"
    out.mkdir()
    for name in COMPARE_FILES:
        (out / name).write_text("{}", encoding="utf-8")

    outcome = runner_module._compare_outcome(finished_process(), pid=PID,
                                             out_dir=out)

    assert outcome.status == STATUS_OK
    assert outcome.files == COMPARE_FILES


def test_a_clean_exit_with_no_scene_beside_it_is_a_crash(tmp_path):
    """A bug HERE, and it has to be one: publishing that directory would put an
    empty cache entry at a URL the page then loads nothing out of. The reason
    goes into the log, because the log is what somebody reads."""
    out = tmp_path / "out"
    out.mkdir()
    (out / "report.json").write_text("{}", encoding="utf-8")

    outcome = runner_module._compare_outcome(finished_process(), pid=PID,
                                             out_dir=out)

    assert outcome.status == STATUS_CRASHED
    assert not outcome.ok and outcome.files == ()
    assert "without writing scene.json" in outcome.log
    # The child's own report is still in there: it measured every part before
    # failing to write the artefact, and that is worth reading.
    assert "1 parts" in outcome.log


def test_nothing_is_looked_for_when_no_artefact_was_asked_for(tmp_path):
    """The CLI's mode writes nothing, so there is nothing to miss."""
    outcome = runner_module._compare_outcome(finished_process(), pid=PID)

    assert outcome.status == STATUS_OK and outcome.files == ()


@pytest.mark.parametrize("keywords", [{"out_dir": "/tmp/out"},
                                      {"view": VIEW}])
def test_the_runner_refuses_half_of_the_artefact_pair(tmp_path, keywords):
    """One without the other is a programming error and is raised as one.

    Passed through to the child it would come back as an invocation error, and
    the job would report a crash instead of the mistake.
    """
    with pytest.raises(ValueError):
        run_compare(tmp_path, tmp_path, pid=PID, **keywords)


# -- reading it back ---------------------------------------------------------
def test_the_comparison_page_is_the_build_page_s_shell(hub):
    """The same generated HTML every build page gets, and always `no-cache`.

    SPEC 7.4: a generated page changes with the image, so a year on it would
    pin every reader to the markup of the day they first opened one. It is
    PUBLIC for the same reason the build page is — the bytes are identical for
    every project on this hub and say nothing about what it holds — while the
    files it then fetches are not.
    """
    two_revisions(hub)
    page = hub.get(f"/project/{PID}/{OLD}/compare/{NEW}/")

    assert page.status_code == 200
    assert page.headers["Cache-Control"] == "no-cache"
    assert page.headers["Content-Type"].startswith("text/html")
    assert page.text == hub.get(f"/project/{PID}/{NEW}/").text


def test_the_comparison_page_redirects_onto_its_trailing_slash(hub):
    """Load-bearing for the reason a build URL's slash is: the viewer derives
    every fetch it makes from its own directory, so without the slash
    `scene.json` would be looked for one level up."""
    two_revisions(hub)
    reply = hub.get(f"/project/{PID}/{OLD}/compare/{NEW}")

    assert reply.status_code == 302
    assert reply.headers["Location"] == f"/project/{PID}/{OLD}/compare/{NEW}/"


@pytest.mark.parametrize("old,new", [
    ("cccccc", NEW),                 # a revision this project never had
    (OLD, "not$a$name"),             # a name no build could ever have
])
def test_a_comparison_page_of_something_the_hub_does_not_hold_is_404(hub, old,
                                                                     new):
    """A page that resolves to a 404 one fetch later is worse than a 404."""
    two_revisions(hub)
    assert hub.get(f"/project/{PID}/{old}/compare/{new}/").status_code == 404


@pytest.mark.parametrize("token", [None, "not-the-token"])
def test_the_files_of_a_comparison_are_behind_the_token(hub_factory, token):
    """The page is public and its data is not, and that is the same line this
    service draws everywhere else: being handed a link gets you a BUILD, and a
    computed answer about two of them is on the writing side of the secret,
    exactly as asking for the computation is."""
    hub = hub_factory(compare_runner=scene_comparer)
    two_revisions(hub)
    finished(hub, ask(hub, tail=f"/{VIEW}"))

    assert fetch(hub, "scene.json", token=token).status_code == 401


def test_a_comparison_nobody_has_computed_is_404(hub):
    """Both revisions are real and the pair has never been asked for."""
    two_revisions(hub)
    assert fetch(hub, "scene.json").status_code == 404


@pytest.mark.parametrize("name", COMPARE_FILES)
def test_a_computed_comparison_is_served_with_a_year_when_both_ends_are_commits(
        hub_factory, name):
    """`immutable`, and the reasoning is the build URL's: a commit cannot
    change, so a comparison of two of them is an answer that cannot either.

    PRIVATE, AND THAT WORD IS THE DIFFERENCE FROM EVERY OTHER YEAR HERE. This
    is the only GET on the site that is both cacheable and behind the token,
    and RFC 9111 section 3.5 lets a shared cache keep a response to a request
    that carried `Authorization` exactly when the response says `public`,
    `must-revalidate` or `s-maxage`. Saying `public` would therefore hand a
    proxy written permission to hold a comparison for a year and serve it to
    somebody who never presented the token.
    """
    hub = hub_factory(compare_runner=scene_comparer)
    two_revisions(hub)
    finished(hub, ask(hub, tail=f"/{VIEW}"))

    reply = fetch(hub, name)

    assert reply.status_code == 200
    assert reply.headers["Cache-Control"] == "private, max-age=31536000, immutable"
    assert "public" not in reply.headers["Cache-Control"]
    assert reply.headers["Content-Type"] == "application/json"
    assert reply.json() == json.loads(
        (compared(hub) / name).read_text(encoding="utf-8"))


@pytest.mark.parametrize("old,new", [("dev", NEW), (OLD, "latest")])
def test_a_pointer_is_not_an_end_of_a_pair_on_the_SERVING_side_either(hub, old,
                                                                      new):
    """The page and the two files refuse a pointer exactly as the POST does.

    THE SAME REFUSAL IN BOTH HALVES, and this test is what holds them together:
    an entry in the comparison cache is filed under the names it was ASKED with,
    so one under `latest` goes on answering for a pair that has moved on — a
    stale file, which no `no-cache` header fixes. Both slots are real
    directories on this hub, so these 404s are about the names being POINTERS
    and not about the revisions being absent.

    The client resolves `latest` to the commit `builds.json` says it stands for
    and asks with that; `dev` has no commit id at all, which is why the picker
    offers no comparison of the local slot.
    """
    two_revisions(hub)
    assert hub.publish_dev(PID, good_build(marker="d")).status_code == 201

    assert hub.get(f"/project/{PID}/{old}/compare/{new}/").status_code == 404
    for name in COMPARE_FILES:
        assert fetch(hub, name, old=old, new=new).status_code == 404


@pytest.mark.parametrize("name,view", [
    ("meta.json", VIEW),        # a real file name, but not one of these two
    ("scene.json", None),       # no `?v=`, so no comparison is named
    ("scene.json", "not$a$view"),
])
def test_only_the_two_names_and_a_real_view_are_served(hub_factory, name, view):
    hub = hub_factory(compare_runner=scene_comparer)
    two_revisions(hub)
    finished(hub, ask(hub, tail=f"/{VIEW}"))

    assert fetch(hub, name, view=view).status_code == 404


def test_a_build_called_compare_keeps_its_own_urls(hub):
    """WHY THE WORD SITS IN THE FOURTH POSITION and is not reserved.

    `compare` passes `SAFE_ID`, so a project may already have published a build
    under that name, and `/project/<pid>/compare/<a>/<b>/` would have taken its
    permanent URL away — which is the one thing this service promises not to do.
    """
    assert hub.publish(PID, "compare", good_build(marker="c")).status_code == 201

    page = hub.get(f"/project/{PID}/compare/")
    assert page.status_code == 200
    meta = hub.get(f"/project/{PID}/compare/meta.json")
    assert meta.status_code == 200
    assert meta.json()["commit"] == "compare"


# -- the cache itself --------------------------------------------------------
@pytest.mark.parametrize("segments", [
    ("proj 1", OLD, NEW, VIEW),
    (PID, "../etc", NEW, VIEW),
    (PID, OLD, "new/er", VIEW),
    (PID, OLD, NEW, ".hidden"),
    (PID, OLD, NEW, None),
])
def test_the_cache_refuses_a_segment_that_is_not_an_id(tmp_path, segments):
    """Every one of the four names a directory, so every one is checked.

    Raised rather than returned as a bool because both callers want it that
    way: the route turns it into a 404 and the worker never reaches it.
    """
    store = Store(data_dir=tmp_path / "data", max_build_bytes=1024)
    with pytest.raises(ValueError):
        store.compare_dir(*segments)


def test_the_cache_can_name_every_view_a_build_is_allowed_to_publish(tmp_path):
    """THE FOURTH SEGMENT IS NOT AN ID THIS HUB MINTS, and holding it to
    `SAFE_ID` made a legal view uncomparable.

    A project id and a build id are the hub's own names; a view id is the
    author's, and what a build holds it to is `hubspec.MEMBER_RE` — a dot, and
    128 characters rather than 64. `SAFE_ID` has no dot at all, so `top.v2`
    published, showed its tab and had no comparison. The store's own rule is
    what has to cover that, and the two patterns are compared rather than
    described so a view id a build accepts and this cache refuses fails HERE
    instead of in somebody's panel.
    """
    from src.cadbuild.hubspec import MEMBER_RE
    from src.store import SAFE_VIEW_ID

    assert SAFE_VIEW_ID.pattern == MEMBER_RE.pattern

    store = Store(data_dir=tmp_path / "data", max_build_bytes=1024)
    for view in ("assembled", "top.v2", "a_b-c.d", "x" * 128, "9"):
        assert store.valid_view_id(view)
        assert store.compare_dir(PID, OLD, NEW, view).name == view


@pytest.mark.parametrize("view", [
    ".", "..", "../etc", ".hidden", "a/b", "a\\b", "with space", "", "x\n",
    "x" * 129, "виды", None, 7,
])
def test_the_cache_refuses_a_view_name_that_is_not_a_segment(tmp_path, view):
    """WIDER IS NOT ANYTHING. The rule the view is held to is "a name that may be
    a directory segment", so what it must go on refusing is every name that is
    not one: the two relative names, anything carrying a separator in any of its
    spellings, and the empty string. A leading alphanumeric is what does most of
    that work — it takes `.`, `..` and `.hidden` in one clause — and the alphabet
    does the rest, since it holds no `/`, no backslash, no NUL and nothing
    outside ASCII.

    `\\n` is in the list for the reason `SAFE_ID` uses `\\Z` rather than `$`, and
    a non-string for the reason the other three segments check their type: this
    is called with whatever a URL carried.
    """
    store = Store(data_dir=tmp_path / "data", max_build_bytes=1024)

    assert not store.valid_view_id(view)
    with pytest.raises(ValueError):
        store.compare_dir(PID, OLD, NEW, view)


def test_two_pairs_that_would_share_a_joined_name_land_in_different_places(
        tmp_path):
    """THE PAYOFF FOR A COLLISION HERE IS THE WRONG GEOMETRY, so there is none.

    `SAFE_ID` accepts `_`, so `a__b` is a build id somebody may publish today.
    Joined into one directory name with any separator — and `__` was the
    separator — `<a>="x"` against `<b>="y__z"` and `<a>="x__y"` against
    `<b>="z"` spell one entry, and whichever pair was computed second is served
    to both. Nested directories cannot express that: a `/` is the one character
    no segment `SAFE_ID` passed can contain.
    """
    store = Store(data_dir=tmp_path / "data", max_build_bytes=1024)

    one = store.compare_dir(PID, "x", "y__z", VIEW)
    other = store.compare_dir(PID, "x__y", "z", VIEW)

    assert one != other
    # Neither is a prefix of the other either, which is what says the two are
    # really separate directories rather than one nested inside the other.
    assert one.parent != other.parent
    for entry in (one, other):
        entry.mkdir(parents=True)
        (entry / "scene.json").write_text(entry.name, encoding="utf-8")
    assert one.is_dir() and other.is_dir()


def test_a_comparison_stages_beside_the_entry_it_becomes(tmp_path):
    """One rename inside one directory, which is what makes it atomic.

    The same shape the build path uses (`build_staging` / `publish_built`), and
    the staging name is dot-prefixed so the sweep at startup can collect one
    that a SIGKILL left behind.
    """
    store = Store(data_dir=tmp_path / "data", max_build_bytes=1024)
    entry = store.compare_dir(PID, OLD, NEW, VIEW)

    staging = store.compare_staging(PID, OLD, NEW, VIEW)

    assert staging.is_dir() and staging.parent == entry.parent
    assert staging.name.startswith(".tmp-")
    (staging / "scene.json").write_text("{}", encoding="utf-8")

    assert store.publish_compare(PID, OLD, NEW, VIEW, staging) == entry
    assert not staging.exists()
    assert (entry / "scene.json").read_text(encoding="utf-8") == "{}"


def test_a_staging_directory_left_by_a_kill_is_swept_at_startup(tmp_path):
    """The comparison cache is a second place staging directories live.

    The sweep walks the root and every project directory; a comparison stages
    beside its entry, which is `compare/<pid>/<a>/<b>/` — THREE levels down, and
    nothing else looks in there, so a `.tmp-` left by a SIGKILL would have
    stayed on the volume for good. The depth is the part a nested layout has to
    tell the sweep about, and this is what says it was told.
    """
    data = tmp_path / "data"
    store = Store(data_dir=data, max_build_bytes=1024)
    staging = store.compare_staging(PID, OLD, NEW, VIEW)
    entry = store.compare_dir(PID, OLD, NEW, VIEW)
    entry.mkdir()
    old = time.time() - 6 * 3600
    for path in (staging, entry):
        os.utime(path, (old, old))

    Store(data_dir=data, max_build_bytes=1024)

    assert not staging.exists()
    # And the entry itself is not a leftover: it is the cache.
    assert entry.is_dir()
