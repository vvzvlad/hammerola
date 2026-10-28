"""`POST /api/v1/snapshot|measure/<pid>/<build>`, the way to the child.

A snapshot pictures one published build from an angle, a measurement gives the
smallest gap between two of its parts; neither rebuilds anything. This file
covers what the hub owns of both: the door, the build being real, the view and
the part names held to the build's meta.json before anything is queued, the job
the request is answered with, and the picture served from the job's directory.

The drawing and the measuring are not tested here: the suite substitutes the
runner (`harness.naming_inspector`), whose log and picture repeat what it was
asked, so a test reads the request back off the answer. Two tests bind the
worker's call against `run_inspect`'s real signature, one per kind.
"""

import inspect
from dataclasses import replace

import pytest
from harness import FAKE_PNG, TOKEN, good_build, naming_inspector

from src import app as app_module
from src import jobs as jobs_module
from src.buildproc import STATUS_FAILED, inspectchild, run_inspect
from src.buildproc.runner import INSPECT_KINDS
from src.cadbuild.artifacts import ASSEMBLED_VIEW_ID
from src.jobs import STATE_DONE, STATE_FAILED
from src.store import MAIN_BRANCH

PID = "proj1"
REVISION = "aaa111"
# The default catalogue of `harness.meta_bytes`: one view showing two parts.
VIEW = "assembled"
PARTS = ("lid", "pin")


def ask(hub, kind, body, build=REVISION, token=TOKEN, pid=PID):
    """POST one snapshot or measurement and return the raw reply."""
    headers = {"X-Hammerola-Token": token} if token is not None else {}
    return hub.request("POST", f"/api/v1/{kind}/{pid}/{build}", json=body,
                       headers=headers)


def snapshot(hub, angle="iso", hide=(), **kw):
    return ask(hub, "snapshot", {"angle": angle, "hide": list(hide)}, **kw)


def measure(hub, parts=PARTS, **kw):
    return ask(hub, "measure", {"parts": list(parts)}, **kw)


def published(hub, name=REVISION):
    assert hub.publish(PID, name, good_build()).status_code in (200, 201)


def finished(hub, reply):
    """The record and the log of the job a 202 named."""
    assert reply.status_code == 202, reply.text
    job_id = reply.json()["job"]
    return hub.await_job(job_id).record, hub.job_log(job_id).text, job_id


def picture(hub, job_id, token=TOKEN):
    headers = {"X-Hammerola-Token": token} if token is not None else {}
    return hub.get(f"/api/v1/jobs/{job_id}/snapshot.png", headers=headers)


# -- the door ----------------------------------------------------------------
@pytest.mark.parametrize("kind", INSPECT_KINDS)
@pytest.mark.parametrize("token", [None, "not-the-token"])
def test_both_are_refused_without_the_token_before_the_url_is_read(hub, kind,
                                                                   token):
    """403 even for a project nobody has: a 404 here would answer "does this
    hub hold that project" to someone without the secret."""
    published(hub)
    body = {"angle": "iso", "hide": [], "parts": list(PARTS)}
    assert ask(hub, kind, body, token=token).status_code == 403
    assert ask(hub, kind, body, token=token,
               pid="nobody-has-this").status_code == 403


# -- what there is to inspect -------------------------------------------------
@pytest.mark.parametrize("pid,build", [
    ("nobody-has-this", REVISION),      # a project that does not exist
    (PID, "cccccc"),                    # a revision never published
    (PID, "v/nobranch/latest"),         # a variant nobody pushed
    (PID, "not$a$name"),                # a name no build could have
])
def test_a_build_the_hub_does_not_hold_is_404(hub, pid, build):
    published(hub)
    reply = measure(hub, pid=pid, build=build)
    assert reply.status_code == 404
    assert reply.json()["error"] == app_module.NO_SUCH_BUILD_ERROR


def test_a_view_the_build_does_not_have_is_404_naming_the_ones_it_has(hub):
    published(hub)
    reply = ask(hub, "measure", {"view": "print", "parts": list(PARTS)})
    assert reply.status_code == 404
    assert reply.json()["error"].endswith(f"its views are {VIEW}")


@pytest.mark.parametrize("kind,body", [
    ("measure", {"parts": ["lid", "bolt"]}),
    ("snapshot", {"angle": "iso", "hide": ["bolt"]}),
])
def test_a_part_the_view_does_not_show_is_404_naming_the_ones_it_does(
        hub, kind, body):
    """Refused before a job exists, and without echoing the caller's word."""
    published(hub)
    reply = ask(hub, kind, body)
    assert reply.status_code == 404
    error = reply.json()["error"]
    assert error.endswith(f"its parts are {', '.join(PARTS)}")
    assert "bolt" not in error


@pytest.mark.parametrize("kind,body", [
    ("measure", {"parts": ["lid"]}),
    ("measure", {"parts": "lid,pin"}),
    ("snapshot", {"hide": []}),
    ("snapshot", {"angle": "iso", "hide": "lid"}),
    ("snapshot", ["iso"]),
])
def test_a_request_shaped_wrong_is_422(hub, kind, body):
    published(hub)
    assert ask(hub, kind, body).status_code == 422


# -- the job -----------------------------------------------------------------
def test_a_snapshot_is_a_job_whose_picture_is_served_under_the_token(hub):
    published(hub)
    reply = snapshot(hub, angle="top", hide=["pin"])
    assert reply.json()["view"] == VIEW
    record, log, job_id = finished(hub, reply)

    assert record["state"] == STATE_DONE
    assert log.startswith(f"snapshot of {PID} {REVISION}\n")
    asked = f"{REVISION} view {VIEW} angle top hide pin parts "
    assert f"snapshot: {asked}" in log
    served = picture(hub, job_id)
    assert served.status_code == 200
    assert served.headers["content-type"] == "image/png"
    assert served.content == FAKE_PNG + asked.encode("utf-8")
    assert picture(hub, job_id, token=None).status_code == 403


def test_a_measurement_is_a_job_whose_log_is_the_answer_and_has_no_picture(
        hub):
    published(hub)
    record, log, job_id = finished(hub, measure(hub))

    assert record["state"] == STATE_DONE
    assert f"measure: {REVISION} view {VIEW} angle None hide  parts lid,pin" \
        in log
    assert picture(hub, job_id).status_code == 404


def test_latest_is_read_as_the_revision_it_points_at_and_dev_where_it_stands(
        hub):
    """The job is filed under the revision `latest` named when it was asked,
    so its log says which one was measured; `dev` has no other name."""
    published(hub)
    assert hub.publish_dev(PID, good_build(marker="d")).status_code in (200,
                                                                        201)
    target = hub.store.pointer_dir(PID, MAIN_BRANCH, "latest").resolve().name

    _record, log, _job = finished(hub, measure(hub, build="latest"))
    assert log.startswith(f"measure of {PID} {target}\n")
    for address in ("dev", f"v/{MAIN_BRANCH}/dev"):
        _record, log, _job = finished(hub, measure(hub, build=address))
        assert log.startswith(f"measure of {PID} dev\n")
        assert "measure: dev view" in log


def test_a_question_the_child_refuses_is_a_422_with_its_sentence_in_the_log(
        hub_factory):
    def refusing(build_dir, *, pid, **kw):
        return replace(naming_inspector(build_dir, pid=pid, **kw),
                       status=STATUS_FAILED, log="inspectproc: no STEP\n")

    hub = hub_factory(inspect_runner=refusing)
    published(hub)
    record, log, _job = finished(hub, measure(hub))
    assert record["state"] == STATE_FAILED and record["code"] == 422
    assert "inspectproc: no STEP" in log


# -- the seam to the child ---------------------------------------------------
@pytest.mark.parametrize("kind", INSPECT_KINDS)
def test_the_worker_calls_the_real_run_inspect_the_way_it_is_declared(
        hub_factory, monkeypatch, kind):
    """Both kinds, because only a snapshot passes `out` and only a
    measurement `parts`: a keyword renamed under one would still bind None."""
    calls, built = [], []
    helper = jobs_module.inspect_arguments

    def watched(*args, **keywords):
        built.append(helper(*args, **keywords))
        return built[-1]

    def recorder(*args, **keywords):
        calls.append((args, keywords))
        return naming_inspector(*args, **keywords)

    monkeypatch.setattr(jobs_module, "inspect_arguments", watched)
    hub = hub_factory(inspect_runner=recorder)
    published(hub)
    record, _log, _job = finished(
        hub, snapshot(hub) if kind == "snapshot" else measure(hub))
    assert record["state"] == STATE_DONE

    (args, keywords), = calls
    inspect.signature(run_inspect).bind(*args, **keywords)
    assert built == [(args, keywords)]
    assert keywords["kind"] == kind
    assert (keywords["out"] is not None) == (kind == "snapshot")


def test_the_names_the_hub_spells_again_are_the_ones_they_copy():
    """The serving side may not import the child or the build half."""
    assert INSPECT_KINDS == (inspectchild.SNAPSHOT, inspectchild.MEASURE)
    assert app_module.DEFAULT_INSPECT_VIEW == ASSEMBLED_VIEW_ID
