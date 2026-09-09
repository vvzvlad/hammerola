"""What a project card says about the project's DRAFT (issue #32).

The front page shows one word per card — `idle`, `building` or `failed` — and it
is about the last build pushed into that project's `dev` slot. Three facts carry
it and each of them is a test here:

  * the pointer is written when the build STARTS, and only for a draft. The
    slot's own meta.json also names a job, but only a build that reached the
    publish ever writes one there, so a build in flight and a build that failed
    are invisible from inside the slot;
  * the word is computed WHEN THE CARD IS ASKED FOR, not when the index file is
    written. `_refresh_index` runs at a publish, which is the one moment nothing
    is building, so a word baked into the file would read `idle` for a project
    that is rebuilding as somebody looks at it. The file therefore still carries
    `status: null` and `_serve_index_json` fills it in;
  * the pointer stores a JOB ID rather than a state word, which is what makes
    the restart case come out right on its own: a job left `building` by a crash
    is failed by `JobStore._load` at the next start, so the card follows it
    instead of sticking on `building` for the life of the volume.

A COMMIT build in flight stays invisible on the front page. That is deliberate
(SPEC 7.6): the card describes what has been published from a commit, and there
is no pointer for a commit build to move.
"""

import json
import threading

import pytest
from harness import copying_builder, good_build, start_hub, stop_hub, tar_gz

from src import render
from src.jobs import (KNOWN_STATES, STATE_BUILDING, STATE_DONE, STATE_FAILED,
                      STATE_QUEUED)
from src.store import DEV_LINK


def _cards(hub):
    """The front page's cards, keyed by pid, as the ROUTE answers them."""
    reply = hub.index()
    assert reply.status_code == 200, reply.text
    return {card["pid"]: card for card in reply.json()}


def _status(hub, pid):
    return _cards(hub)[pid]["status"]


def _on_disk(hub):
    return json.loads((hub.data / "index.json").read_text(encoding="utf-8"))


class HeldBuilder:
    """Copies the tree, but stops first if the test asked it to.

    A gate the test can open per build rather than once for the whole hub: the
    projects under test need a COMMIT build published before they have a card at
    all, and that build has to run to completion before the draft's is allowed
    to hang.
    """

    def __init__(self):
        self.hold = False
        self.entered = threading.Event()
        self.release = threading.Event()

    def __call__(self, project_dir, out_dir, *, pid, **kw):
        if self.hold:
            self.entered.set()
            assert self.release.wait(timeout=30), (
                "the test never released the build it held")
        return copying_builder(project_dir, out_dir, pid=pid)


@pytest.fixture
def held_hub(tmp_path):
    """A hub whose builds run normally until a test says to hold one."""
    builder = HeldBuilder()
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


def _hold_a_draft(hub, pid):
    """Push a draft that stops inside the build. -> the job it was given."""
    hub.builder.hold = True
    reply = hub.publish_async(pid, DEV_LINK, good_build("draft"))
    assert reply.status_code == 202, reply.text
    assert hub.builder.entered.wait(timeout=30), "the build never started"
    return reply.json()["job"]


# -- the pointer -------------------------------------------------------------
def test_a_draft_build_records_its_job_the_moment_it_starts(held_hub):
    """Before the build, not after it — that is the whole of the feature.

    Written on the successful path only, which is what the slot's meta.json
    does, the pointer would exist exactly when it has nothing left to say.
    """
    held_hub.publish("proj1", "abc123", good_build())
    job_id = _hold_a_draft(held_hub, "proj1")

    assert held_hub.store.draft_job("proj1") == job_id
    # And beside `title.json`, never inside the slot: `_swap_dev_slot` replaces
    # the slot wholesale, so a pointer written into it before the build would be
    # thrown away by the publish it was recording.
    assert (held_hub.project_dir("proj1") / "draft.json").is_file()


def test_the_first_draft_of_a_new_project_has_nowhere_to_write_it_yet(held_hub):
    """The build starts before anything has been published under this id.

    `set_draft_job` therefore creates the project directory rather than
    refusing, which is where it differs from `set_title`.
    """
    assert not held_hub.project_dir("fresh").exists()
    job_id = _hold_a_draft(held_hub, "fresh")
    assert held_hub.store.draft_job("fresh") == job_id


def test_a_first_draft_that_failed_still_leaves_the_hub_empty(hub):
    """The pointer must not take the onboarding block away from a new hub.

    `Store.empty` counts a project directory that has ANYTHING in it, and the
    one case it deliberately does not count is the shell a failed build leaves
    behind — because a hub whose very first push did not build is exactly the
    hub whose owner still needs the block. `draft.json` is written before there
    is a slot or a build directory, so a failed first draft leaves it alone in
    there, and counting it would be that failure arriving by a second road.
    """
    assert hub.get("/start").json()["empty"] is True
    reply = hub.publish_dev("proj1", tar_gz({"meta.json": b"{ not json"}))
    assert reply.status_code == 422, reply.text

    assert [p.name for p in hub.project_dir("proj1").iterdir()] == ["draft.json"]
    assert hub.get("/start").json()["empty"] is True

    # ...and the moment anything survives a push, it is not empty any more.
    assert hub.publish_dev("proj1", good_build()).status_code == 201
    assert hub.get("/start").json()["empty"] is False


def test_a_commit_build_moves_no_pointer(held_hub):
    """The draft's pointer is about the draft. A commit build is not one.

    A commit fills the slot with itself (issue #78), so it would be an easy
    thing to record here as well — and it would be wrong: the front page's card
    already describes that commit, and pointing the draft at its job would make
    every publish light a chip that is about nothing.
    """
    held_hub.publish("proj1", "abc123", good_build())
    assert held_hub.store.draft_job("proj1") is None
    assert not (held_hub.project_dir("proj1") / "draft.json").exists()

    # Including one that is still running: the card must stay quiet for the
    # whole of a commit build, not merely after it.
    held_hub.builder.hold = True
    reply = held_hub.publish_async("proj1", "def456", good_build("second"))
    assert reply.status_code == 202
    assert held_hub.builder.entered.wait(timeout=30)
    assert held_hub.store.draft_job("proj1") is None
    assert _status(held_hub, "proj1") == render.CARD_IDLE


# -- what the card says ------------------------------------------------------
def test_the_card_follows_the_draft_from_building_to_idle(held_hub):
    held_hub.publish("proj1", "abc123", good_build())
    assert _status(held_hub, "proj1") == render.CARD_IDLE

    job_id = _hold_a_draft(held_hub, "proj1")
    assert _status(held_hub, "proj1") == render.CARD_BUILDING

    held_hub.builder.release.set()
    assert held_hub.await_job(job_id).status_code == 201
    assert _status(held_hub, "proj1") == render.CARD_IDLE


def test_a_draft_that_failed_says_so_until_the_next_draft_push(held_hub):
    """`failed` is what the slot alone could never report.

    A build that fails publishes nothing, so the slot keeps whatever was in it
    — the previous draft, or the commit that mirrored itself there — and its
    `job` goes on naming a build that succeeded.
    """
    held_hub.publish("proj1", "abc123", good_build())
    # A tree the build's own stand-in copies happily and the hub then refuses to
    # publish: the failure is on the publish side, which is one of the two ways
    # a job reaches `failed`.
    reply = held_hub.publish_dev("proj1", tar_gz({"meta.json": b"{ not json"}))
    assert reply.status_code == 422, reply.text

    assert _status(held_hub, "proj1") == render.CARD_FAILED
    # The card still describes the newest COMMIT, which the failure did not
    # touch. The word is about the draft and nothing else.
    assert _cards(held_hub)["proj1"]["commit"] == "abc123"

    # ...and a draft that then succeeds clears it.
    assert held_hub.publish_dev("proj1", good_build("ok")).status_code == 201
    assert _status(held_hub, "proj1") == render.CARD_IDLE


def test_a_commit_clears_a_failed_draft_because_it_replaces_the_slot(held_hub):
    """The other way out of `failed`, and the one that used to be missing.

    A commit MIRRORS ITSELF INTO THE SLOT (issue #78), which is why the `dev`
    chip goes when one lands: `_uncommitted_in_slot` compares digests and the
    slot now holds the revision. The draft the red chip was about is gone with
    it, so the chip has to go too — otherwise a project that has just published
    successfully, and holds no local work at all, carries "the last build of
    this project's draft failed" until somebody pushes another DRAFT, which may
    be weeks away or never.

    `publish_built` clears the pointer one line after `clear_title`, and for the
    same reason: the push that follows a statement supersedes it.
    """
    held_hub.publish("proj1", "abc123", good_build())
    reply = held_hub.publish_dev("proj1", tar_gz({"meta.json": b"{ not json"}))
    assert reply.status_code == 422, reply.text
    assert _status(held_hub, "proj1") == render.CARD_FAILED

    held_hub.publish("proj1", "def456", good_build("second"))
    assert held_hub.store.draft_job("proj1") is None
    assert _status(held_hub, "proj1") == render.CARD_IDLE
    # The card moved on to the new revision, and the `dev` chip is gone by the
    # digest rule -- the two facts this test is keeping in step.
    card = _cards(held_hub)["proj1"]
    assert card["commit"] == "def456"
    assert card["dev"] is False


def test_a_project_nobody_has_pushed_a_draft_to_is_idle(hub):
    hub.publish("proj1", "abc123", good_build())
    assert hub.store.draft_job("proj1") is None
    assert _status(hub, "proj1") == render.CARD_IDLE


def test_a_pointer_at_a_job_this_hub_does_not_have_is_idle(hub):
    """An id from a volume whose `data/jobs/` was cleared, or a hand-written one.

    `idle` rather than a word about the hub: the front page is about projects,
    and "the registry has forgotten which build that was" is not a state of the
    project.
    """
    hub.publish("proj1", "abc123", good_build())
    hub.store.set_draft_job("proj1", "N" * 22)
    assert _status(hub, "proj1") == render.CARD_IDLE


def test_an_unreadable_pointer_is_idle(hub):
    """The reader is tolerant, exactly like `project_title`'s.

    Anything that is not a `{"job": "<id>"}` object answers None, and None is
    the same answer as no pointer at all — there is nothing here for a second
    kind of failure to mean.
    """
    hub.publish("proj1", "abc123", good_build())
    for payload in (b"{ torn", b'"a string"', b"{}", b'{"job": 7}',
                    b'{"job": ""}'):
        (hub.project_dir("proj1") / "draft.json").write_bytes(payload)
        assert hub.store.draft_job("proj1") is None, payload
        assert _status(hub, "proj1") == render.CARD_IDLE, payload


def test_a_draft_stranded_by_a_restart_reads_failed(tmp_path):
    """Why the pointer stores an ID and not a word.

    The process that was building is gone and nothing resumes it, so a status
    word copied into the pointer would say `building` for the life of the
    volume — there is nobody left to correct it. The job registry corrects
    ITSELF at startup (`JobStore._load`), and a card that reads the job through
    the pointer inherits that for free.
    """
    data = tmp_path / "data"
    first = start_hub(data)
    try:
        first.publish("proj1", "abc123", good_build())
        # A job left exactly as a SIGKILL leaves one: started, never finished.
        registry = first.server.jobs
        job_id = registry.create("proj1", DEV_LINK)["id"]
        registry.start(job_id)
        first.store.set_draft_job("proj1", job_id)
        assert _status(first, "proj1") == render.CARD_BUILDING
    finally:
        stop_hub(first)

    # The same volume, a new process.
    again = start_hub(data)
    try:
        assert again.server.jobs.get(job_id)["state"] == STATE_FAILED
        assert again.store.draft_job("proj1") == job_id
        assert _status(again, "proj1") == render.CARD_FAILED
    finally:
        stop_hub(again)


# -- the file is not the answer ----------------------------------------------
def test_the_index_file_declares_the_field_and_answers_none(held_hub):
    """`render.index_card` writes the key; the ROUTE fills it.

    A word written into the file would be the word that was true at the last
    publish, which is the one moment nothing is building. The key is written all
    the same so the field the browser reads is one the hub declares.
    """
    held_hub.publish("proj1", "abc123", good_build())
    _hold_a_draft(held_hub, "proj1")

    on_disk = _on_disk(held_hub)
    assert [card["pid"] for card in on_disk] == ["proj1"]
    assert on_disk[0]["status"] is None
    # The same read, through the route, at the same moment.
    assert _status(held_hub, "proj1") == render.CARD_BUILDING


def test_an_unreadable_index_answers_with_an_empty_list(hub):
    """Like an absent one, which the route already answers `[]` for.

    Half a computed answer is not served, and neither is an exception out of a
    request handler — that reaches the browser as a dropped connection.
    """
    hub.publish("proj1", "abc123", good_build())
    for payload in (b"{ torn", b'{"pid": "proj1"}', b"[3]", b"[{}]"):
        (hub.data / "index.json").write_bytes(payload)
        reply = hub.index()
        assert reply.status_code == 200, payload
        assert reply.json() == [], payload


# -- the coupling ------------------------------------------------------------
def test_every_state_a_job_can_be_in_maps_onto_a_card_word():
    """`src/render.py` spells the job registry's words out; it cannot import them.

    `jobs` imports `store`, and `store` imports `render`, so the mapping is a
    plain string one — which means nothing but this test notices the day a fifth
    state is added to `src/jobs.py` and reaches the front page as `idle`.

    Both directions, and the second one is the one worth having: that every
    state maps SOMEWHERE is free (the mapping ends in a fallback), so what is
    actually pinned is which word each of them lands on.
    """
    words = {render.CARD_IDLE, render.CARD_BUILDING, render.CARD_FAILED}
    assert KNOWN_STATES == {STATE_QUEUED, STATE_BUILDING, STATE_DONE,
                            STATE_FAILED}, (
        "src/jobs.py knows a state this test has never seen; decide what the "
        "front page says about it and add it below")
    for state in KNOWN_STATES:
        assert render.card_status(state) in words, state

    assert render.card_status(STATE_QUEUED) == render.CARD_BUILDING
    assert render.card_status(STATE_BUILDING) == render.CARD_BUILDING
    assert render.card_status(STATE_FAILED) == render.CARD_FAILED
    assert render.card_status(STATE_DONE) == render.CARD_IDLE
    # And "there is nothing to say", which is not a state at all: no pointer,
    # and a pointer at a job the registry has forgotten, arrive here the same
    # way.
    assert render.card_status(None) == render.CARD_IDLE
