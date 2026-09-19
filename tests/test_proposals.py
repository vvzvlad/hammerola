"""The stored Proposal: one per project, behind EDIT_TOKEN (src/proposals.py).

The document a reader assembles in the browser panel used to live in page state
and nowhere else, so a reload lost it. These tests are about the hub half of
where it goes instead — the three routes on `/api/v1/proposals/<pid>` and the
one file per project behind them.

MOST OF THEM PUBLISH NOTHING, and that is the behaviour rather than a shortcut:
a proposal is a statement somebody is drafting and the route deliberately does
not ask the volume whether the project exists. The two tests that do push are
the ones about a project being REMOVED, where the build directory is the thing
under test.

They talk HTTP to a real server, like the rest of the suite, because the
promises being checked are made in status codes.
"""

import json
import os

import httpx
import pytest
from harness import TOKEN, good_build
from loguru import logger

# The document as `ui/src/proposal.js` builds it: a version, the units and the
# nodes. Spelled out here rather than imported from anywhere, because the whole
# point of the hub half is that it stores this VERBATIM and knows nothing about
# what is in it — a fixture derived from a Python definition of the shape would
# be testing a schema this side deliberately does not have.


def proposal_doc(**extra):
    doc = {
        "version": 1,
        "units": "mm",
        "nodes": [
            {"id": "n1", "role": "body", "op": "box", "name": "motor",
             "size": [42.0, 42.0, 20.0], "at": [0.0, 0.0, 12.5],
             "rot": [0.0, 0.0, 0.0]},
            {"id": "n2", "role": "move", "name": "bracket ×2",
             "paths": ["/model/bracket", "/model/bracket(2)"],
             "delta": [0.0, -3.0, 0.0], "turn": [0.0, 0.0, 15.0]},
        ],
    }
    doc.update(extra)
    return doc


def payload(doc=None, text="units: mm\nmotor  42 × 42 × 20",
            published="2026-09-19T10:11:12.345Z", view="assembled"):
    """The body a POST carries: the document, its projection and where it stands.

    WHERE IT STANDS IS TWO FIELDS AND NOT ONE. A move's paths are numbered in
    one revision's tree as ONE VIEW groups it, and `published` is identical
    across the views of a build — so the browser sends the view beside the
    stamp and restores the moves only where both match (`adoptProposal`).
    """
    return {"doc": proposal_doc() if doc is None else doc,
            "text": text, "published": published, "view": view}


def _remove_project(hub, pid, token=TOKEN):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return httpx.request("DELETE", f"{hub.url}/api/v1/projects/{pid}",
                         headers=headers, timeout=10, trust_env=False)


# -- the round trip ----------------------------------------------------------
def test_a_proposal_comes_back_exactly_as_it_was_sent(hub):
    written = hub.proposal("proj1", method="POST", payload=payload())
    assert written.status_code == 200, written.text
    record = written.json()
    assert record["pid"] == "proj1"
    assert record["doc"] == proposal_doc()
    assert record["text"] == "units: mm\nmotor  42 × 42 × 20"
    assert record["published"] == "2026-09-19T10:11:12.345Z"
    assert record["view"] == "assembled"
    assert record["saved"]

    read = hub.proposal("proj1")
    assert read.status_code == 200
    assert read.json() == record
    # And it is on the volume, not only in the reply.
    assert json.loads(hub.proposal_path("proj1").read_text()) == record


def test_the_text_and_the_stamps_may_be_null(hub):
    """A document whose every node is ticked off sends nothing (`sendsNothing`),
    and a document with no move in it was measured against no build and no
    view."""
    written = hub.proposal("proj1", method="POST",
                           payload=payload(text=None, published=None,
                                           view=None))
    assert written.status_code == 200, written.text
    record = hub.proposal("proj1").json()
    assert record["text"] is None and record["published"] is None
    assert record["view"] is None
    assert record["doc"] == proposal_doc()


def test_the_view_is_stored_beside_the_build_and_is_its_own_field(hub):
    """BOTH HALVES OF WHERE THE MOVES WERE MEASURED travel, because `published`
    is one number for the whole build and identical across its views.

    A view is a separate tree of references with its own grouping
    (`src/cadbuild/views.py`), so `/model/pin(2)` in another view is a different
    part or the same part in a different layout — and the page that reads this
    record back restores the moves only where the view matches too. A hub that
    dropped the field would leave that comparison with nothing to compare.
    """
    assert hub.proposal("proj1", method="POST",
                        payload=payload(view="exploded")).status_code == 200
    assert hub.proposal("proj1").json()["view"] == "exploded"
    # And it is replaced with the rest of the record rather than accumulating.
    assert hub.proposal("proj1", method="POST",
                        payload=payload(view="assembled")).status_code == 200
    assert hub.proposal("proj1").json()["view"] == "assembled"


def test_a_second_post_replaces_the_first(hub):
    """ONE PER PROJECT. The queue of comments grows; this does not."""
    assert hub.proposal("proj1", method="POST",
                        payload=payload()).status_code == 200
    later = proposal_doc(nodes=[{"id": "n9", "role": "body", "op": "cyl",
                                 "size": [8.0, 30.0], "at": [1.0, 2.0, 3.0]}])
    assert hub.proposal("proj1", method="POST",
                        payload=payload(doc=later, text="units: mm\npin ⌀8")
                        ).status_code == 200

    record = hub.proposal("proj1").json()
    assert record["doc"] == later
    assert record["text"] == "units: mm\npin ⌀8"
    # One file, and no second copy of anything beside it.
    assert sorted(path.name for path in (hub.data / "proposals").iterdir()) \
        == ["proj1.json"]


def test_each_project_has_its_own(hub):
    assert hub.proposal("proj1", method="POST",
                        payload=payload(text="one")).status_code == 200
    assert hub.proposal("proj2", method="POST",
                        payload=payload(text="two")).status_code == 200
    assert hub.proposal("proj1").json()["text"] == "one"
    assert hub.proposal("proj2").json()["text"] == "two"


def test_a_project_with_no_proposal_is_404(hub):
    assert hub.proposal("proj1").status_code == 404
    assert hub.proposal("proj1", method="POST",
                        payload=payload()).status_code == 200
    assert hub.proposal("proj2").status_code == 404


# -- the door ----------------------------------------------------------------
def test_every_route_refuses_a_missing_token(hub):
    assert hub.proposal("proj1", method="POST",
                        payload=payload()).status_code == 200
    for method, extra in (("GET", {}),
                          ("POST", {"payload": payload(text="overwritten")}),
                          ("DELETE", {})):
        refused = hub.proposal("proj1", method=method, token=None, **extra)
        assert refused.status_code == 401, method
        assert refused.headers["WWW-Authenticate"] == "Bearer"
    # None of that touched what was stored.
    assert hub.proposal("proj1").json()["text"] == \
        "units: mm\nmotor  42 × 42 × 20"


def test_the_token_is_checked_before_the_hub_says_whether_there_is_one(hub):
    """No oracle: without it, a project with a proposal answers like one without.

    The same property `test_comments_read.py` pins on the queue, and it is the
    reason the token is checked ahead of the SHAPE of the request rather than
    after it.
    """
    assert hub.proposal("proj1", method="POST",
                        payload=payload()).status_code == 200
    for pid in ("proj1", "nosuchproject"):
        for method, extra in (("GET", {}), ("DELETE", {}),
                              ("POST", {"payload": payload()})):
            refused = hub.proposal(pid, method=method, token=None, **extra)
            assert refused.status_code == 401, (pid, method)
            assert refused.json() == hub.proposal("proj1", method="GET",
                                                  token=None).json()
    # With the token, the two projects answer differently — which is exactly
    # what the refusals above must not have revealed.
    assert hub.proposal("proj1").status_code == 200
    assert hub.proposal("nosuchproject").status_code == 404


def test_a_token_prefix_is_not_accepted(hub):
    assert hub.proposal("proj1", method="POST", payload=payload(),
                        token=TOKEN[:-1]).status_code == 401
    assert hub.proposal("proj1", token=TOKEN[:-1]).status_code == 401


def test_an_id_that_could_never_name_a_file_is_one_answer(hub):
    """Every miss is the same 404, and none of them is a path."""
    for method in ("GET", "DELETE"):
        for bad in ("..", "%2e%2e", "not a pid", "x" * 65):
            reply = hub.proposal(bad, method=method)
            assert reply.status_code == 404, (method, bad)
    assert hub.proposal("..", method="POST",
                        payload=payload()).status_code == 404
    # And a longer path under the same prefix is not a route at all.
    assert hub.proposal("proj1/extra").status_code == 404
    assert hub.proposal("proj1/extra", method="POST",
                        payload=payload()).status_code == 404
    # Nothing of any of that reached the volume, temp files included.
    assert list((hub.data / "proposals").iterdir()) == []


# -- deletion ----------------------------------------------------------------
def test_deleting_removes_it_and_a_second_delete_says_false(hub):
    assert hub.proposal("proj1", method="POST",
                        payload=payload()).status_code == 200

    first = hub.proposal("proj1", method="DELETE")
    assert first.status_code == 200
    assert first.json() == {"removed": True}
    assert not hub.proposal_path("proj1").exists()
    assert hub.proposal("proj1").status_code == 404

    second = hub.proposal("proj1", method="DELETE")
    assert second.status_code == 200
    assert second.json() == {"removed": False}


def test_deleting_one_project_leaves_the_others_alone(hub):
    assert hub.proposal("proj1", method="POST",
                        payload=payload()).status_code == 200
    assert hub.proposal("proj2", method="POST",
                        payload=payload()).status_code == 200
    assert hub.proposal("proj1", method="DELETE").json() == {"removed": True}
    assert hub.proposal("proj2").status_code == 200


def test_removing_the_project_takes_its_proposal_with_it(hub):
    """It is a statement about THIS project's geometry, so it goes when the
    builds do — the same reason the comment queue goes (SPEC 7A.3)."""
    assert hub.publish("proj1", "abc123", good_build()).status_code == 201
    assert hub.proposal("proj1", method="POST",
                        payload=payload()).status_code == 200

    removed = _remove_project(hub, "proj1")
    assert removed.status_code == 200
    assert removed.json()["proposal"] is True
    assert not hub.proposal_path("proj1").exists()
    assert hub.proposal("proj1").status_code == 404


def test_removing_a_project_that_never_had_one_says_so(hub):
    assert hub.publish("proj1", "abc123", good_build()).status_code == 201
    assert _remove_project(hub, "proj1").json()["proposal"] is False


# -- what is checked about the bytes -----------------------------------------
def test_an_oversized_body_is_413(hub_factory):
    """An unbounded parse and an unbounded store are not made safe by a
    credential — the same sentence `src/comments.py` writes about a photo."""
    small = hub_factory(proposal_max_body_bytes=2048)
    fat = proposal_doc(nodes=[{"id": f"n{i}", "role": "body", "op": "box",
                               "size": [1.0, 2.0, 3.0]} for i in range(200)])
    refused = small.proposal("proj1", method="POST", payload=payload(doc=fat))
    assert refused.status_code == 413
    assert not small.proposal_path("proj1").exists()
    # The ceiling is a ceiling and not a wall: an ordinary document still fits.
    assert small.proposal("proj1", method="POST",
                          payload=payload()).status_code == 200


def test_a_number_that_cannot_be_read_back_is_refused_at_the_door(hub):
    """NaN and infinity, in every spelling that reaches the parser.

    `json.loads` accepts `NaN`, `Infinity` and `-Infinity` as an extension, and
    `1e999` is an ordinary JSON number that overflows to `inf` on the way in.
    `json.dumps(..., allow_nan=False)` then refuses to write any of them, so
    without this the bad number would be a 500 on a request that had already
    been accepted. Nobody is attacking here: this is our own drag arithmetic
    producing a value no strict parser could ever read back.
    """
    bodies = {
        # What `json.dumps` itself writes for a float NaN, i.e. what a
        # hand-rolled client sending Python floats would actually send.
        "NaN": json.dumps(payload(doc=proposal_doc(
            nodes=[{"id": "n1", "at": [float("nan"), 0.0, 0.0]}]))),
        "Infinity": json.dumps(payload(doc=proposal_doc(
            nodes=[{"id": "n1", "at": [float("inf"), 0.0, 0.0]}]))),
        # The one no `parse_constant` can see: a plain literal that overflows.
        "1e999": ('{"doc": {"version": 1, "units": "mm", '
                  '"nodes": [{"id": "n1", "at": [1e999, 0.0, 0.0]}]}, '
                  '"text": null, "published": null}'),
    }
    for spelling, body in bodies.items():
        assert spelling in body, spelling
        refused = hub.proposal("proj1", method="POST", content=body,
                               headers={"Content-Type": "application/json"})
        assert refused.status_code == 422, spelling
        # And nothing was written, which is the half a 422 does not state.
        assert not hub.proposal_path("proj1").exists(), spelling


def test_the_four_fields_are_the_only_thing_checked_about_the_payload(hub):
    """`doc` is an object, `text` a string or null, `published` and `view` one
    printable line each.

    What is NOT here is the whole point: nothing looks inside `doc`. A node
    shape this hub has never heard of goes to disk and comes back unchanged,
    because the definition of the document lives in `ui/src/proposal.js` and a
    second copy of it in Python would be a schema to keep in step for no named
    benefit.
    """
    for bad in ({"text": "x"},
                {"doc": "not an object", "text": None},
                {"doc": proposal_doc(), "text": 17},
                {"doc": proposal_doc(), "text": None, "published": ["a"]},
                {"doc": proposal_doc(), "text": None,
                 "published": "two\nlines"},
                {"doc": proposal_doc(), "text": None,
                 "published": "x" * 201},
                {"doc": proposal_doc(), "text": None, "view": ["a"]},
                {"doc": proposal_doc(), "text": None, "view": "two\nlines"},
                {"doc": proposal_doc(), "text": None, "view": "x" * 201}):
        refused = hub.proposal("proj1", method="POST", payload=bad)
        assert refused.status_code == 422, bad
    assert hub.proposal("proj1", method="POST", content=b"not json",
                        headers={"Content-Type": "application/json"}
                        ).status_code == 422
    assert hub.proposal("proj1", method="POST", payload=[1, 2, 3]
                        ).status_code == 422
    assert not hub.proposal_path("proj1").exists()

    # And a document full of things nobody here has ever defined is stored.
    strange = {"version": 99, "units": "furlong",
               "nodes": [{"id": "n1", "role": "whatever", "wat": {"deep": [1]}}]}
    assert hub.proposal("proj1", method="POST",
                        payload=payload(doc=strange)).status_code == 200
    assert hub.proposal("proj1").json()["doc"] == strange


def test_a_control_character_in_the_projection_is_refused(hub):
    """`text` IS THE ONE FIELD THAT IS PRINTED INTO A TERMINAL.

    `hammerola proposal` writes it straight out for an agent to read, and U+202E
    reverses the text around it in any terminal or editor — which is the reason
    `comments._body_text` records for refusing it there. This is an argument
    about the BYTES and not about the sender, and it is the same bytes: the same
    projection pasted into a COMMENT is a 422, so accepting it here would be the
    door left open beside the one that is shut.
    """
    for bad in ("motor ‮42 × 42", "motor\x00", "motor\x1b[2Jcleared",
                "motor\x07"):
        refused = hub.proposal("proj1", method="POST",
                               payload=payload(text=bad))
        assert refused.status_code == 422, repr(bad)
        assert not hub.proposal_path("proj1").exists(), repr(bad)


def test_an_ordinary_multi_line_projection_is_stored_as_it_was_written(hub):
    """THE ONE WAY THE CHECK ABOVE COULD BREAK THE WORKING PATH, pinned.

    The projection is a TABLE — several lines, aligned into columns — so a
    `text` checked the way `published` is would refuse nearly every real
    document and the browser's save would start failing silently. Newline and
    tab survive, exactly as they do for a comment's body.
    """
    projection = ("units: mm\n"
                  "\n"
                  "motor   42 × 42 × 20   at 0, 0, 12.5\n"
                  "\twall  120 × 80 × 3    at 0, −40, 0")
    assert hub.proposal("proj1", method="POST",
                        payload=payload(text=projection)).status_code == 200
    assert hub.proposal("proj1").json()["text"] == projection


# -- what a BUILD can leave in this directory --------------------------------
# `data/proposals/` is on the same volume as everything else and a build can
# write anywhere in it (src/buildproc). Neither of these needs a token or a
# vulnerability: an `os.mkfifo` in `model.py` lays the trap and whoever opens
# the panel springs it.
def test_a_file_that_is_not_a_proposal_reads_as_none(hub):
    assert hub.proposal("proj1", method="POST",
                        payload=payload()).status_code == 200
    hub.proposal_path("proj1").write_text("{ torn half of a document")
    assert hub.proposal("proj1").status_code == 404
    # And the route still works for everything else.
    assert hub.proposal("proj2", method="POST",
                        payload=payload()).status_code == 200
    assert hub.proposal("proj2").status_code == 200


def test_a_record_that_names_another_project_is_not_served(hub):
    """The `pid` is read back off the volume, so it is checked against the
    file's own name rather than believed."""
    assert hub.proposal("proj1", method="POST",
                        payload=payload()).status_code == 200
    path = hub.proposal_path("proj1")
    record = json.loads(path.read_text())
    record["pid"] = "someone-else"
    path.write_text(json.dumps(record))
    assert hub.proposal("proj1").status_code == 404


@pytest.mark.skipif(not hasattr(os, "mkfifo"),
                    reason="this platform has no os.mkfifo, so no fifo can "
                           "reach the proposal store in the first place")
def test_a_fifo_where_the_proposal_was_is_refused_rather_than_waited_on(hub):
    """The deadline is as much of the assertion as the status code is.

    A plain `open()` on a fifo blocks until a writer appears, and none is
    coming: the request thread would be gone for good, with no exception and
    nothing observable except one worker fewer. Without a deadline here a
    regression would hang this test rather than fail it.
    """
    assert hub.proposal("proj1", method="POST",
                        payload=payload()).status_code == 200
    path = hub.proposal_path("proj1")
    path.unlink()
    os.mkfifo(path)
    assert hub.proposal("proj1", timeout=5).status_code == 404


# -- and what the log is told about all that ---------------------------------
def _warnings(hub, *, pid, times=1):
    """The WARNING lines a GET of this project's proposal writes."""
    said = []
    sink = logger.add(said.append, level="WARNING")
    try:
        for _ in range(times):
            assert hub.proposal(pid).status_code == 404
    finally:
        logger.remove(sink)
    return [line for line in said if "proposal" in line]


def test_a_project_nobody_has_drawn_on_is_absence_and_says_nothing(hub):
    """A MISSING FILE IS NOT A FAULT AND MUST NOT BE REPORTED AS ONE.

    Unlike `comments._read_record`, whose caller is a glob and so only ever
    hands it a path something just listed, this one is handed a path built from
    the id in the URL. Most projects have no proposal, so the ordinary answer
    went through the `unreadable proposal …` arm and every page load of every
    such project wrote a warning naming a file that was never supposed to exist.
    """
    assert _warnings(hub, pid="proj1", times=2) == []


def test_but_a_damaged_one_still_warns_because_nothing_else_would(hub):
    """The other arm, and the reason the one above is not simply a deleted line:
    a torn file or a directory where the record should be is real, and this
    warning is the only sign of it anywhere."""
    assert hub.proposal("proj1", method="POST",
                        payload=payload()).status_code == 200
    hub.proposal_path("proj1").write_text("{ torn half of a document")
    assert len(_warnings(hub, pid="proj1")) == 1

    hub.proposal_path("proj2").mkdir()
    assert len(_warnings(hub, pid="proj2")) == 1
