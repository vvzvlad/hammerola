"""The READ side of the comment queue (SPEC 7A.2).

The queue is not public to read, and that has not changed: it is raw input — it
can be junk, duplicated or abusive — so handing it back to every visitor would
turn a showcase of projects into a message board. What DID change is that
writing is not public either (step 0 of the plan, SPEC 8A.1), so the asymmetry
these tests were once about is gone and one secret opens both sides.

These tests are mostly about the door: which endpoints demand the token, that a
near miss is refused, and that a caller without one cannot learn anything from
the difference between 401 and 404. The test that used to sit here proving the
PUBLISH token is refused on this route was DELETED with the second variable —
its premise was that the two tokens rotate separately, and they no longer exist
to rotate. `test_the_same_secret_opens_both_sides` is what stands in its place,
and it asserts the opposite property on purpose: the collapse is a decision
(issue #26), so it is pinned rather than merely uncontradicted.
"""

import json
import os
from datetime import datetime, timedelta, timezone

import pytest
from harness import (JPEG_BYTES, PNG_BYTES, TOKEN, comment_payload,
                     good_build)

READ_ENDPOINTS = ("", "?project=proj1", "/{cid}", "/{cid}/photo", "/{cid}/shot")


def _setup(hub, pid="proj1", commit="abc123", **kw):
    assert hub.publish(pid, commit, good_build()).status_code == 201
    posted = hub.post_comment(pid, commit, comment_payload(**kw),
                              photo=("p.jpg", JPEG_BYTES, "image/jpeg"),
                              shot=("s.png", PNG_BYTES, "image/png"))
    assert posted.status_code == 201
    return posted.json()["id"]


# -- the door ---------------------------------------------------------------
def test_every_read_endpoint_refuses_a_missing_token(hub):
    cid = _setup(hub)
    for path in READ_ENDPOINTS:
        r = hub.read_comments(path.format(cid=cid), token=None)
        assert r.status_code == 401, path
        assert r.headers["WWW-Authenticate"] == "Bearer"


def test_the_same_secret_opens_both_sides(hub):
    """ONE secret for the whole system (issue #26, step 0 of the plan).

    The value that publishes a build is the value that reads the queue and the
    value that writes to it. This replaces a test asserting the reverse — that
    the publish token is refused here — which was true while the hub declared
    COMMENT_READ_TOKEN and became false the moment it stopped.
    """
    assert hub.publish("proj1", "abc123", good_build(), token=TOKEN
                       ).status_code == 201
    written = hub.post_comment("proj1", "abc123", comment_payload(),
                               token=TOKEN)
    assert written.status_code == 201
    cid = written.json()["id"]
    for path in READ_ENDPOINTS:
        r = hub.read_comments(path.format(cid=cid), token=TOKEN)
        # The two attachment routes 404 because this comment carries neither;
        # what matters is that none of them answers 401.
        assert r.status_code in (200, 404), path


def test_resolve_refuses_a_missing_token(hub):
    cid = _setup(hub)
    r = hub.read_comments(f"/{cid}/resolve", token=None, method="POST")
    assert r.status_code == 401
    assert hub.read_comments(f"/{cid}").json()["status"] == "open"


def test_a_token_prefix_is_not_accepted(hub):
    _setup(hub)
    r = hub.read_comments("", token=TOKEN[:-1])
    assert r.status_code == 401


def test_an_unknown_id_is_404_only_after_the_token_is_checked(hub):
    """No oracle: without the token, an id that exists looks like one that does not."""
    cid = _setup(hub)
    assert hub.read_comments(f"/{cid}", token=None).status_code == 401
    assert hub.read_comments("/" + "0" * 32, token=None).status_code == 401
    assert hub.read_comments("/" + "0" * 32).status_code == 404


def test_a_malformed_id_is_404_not_a_path(hub):
    _setup(hub)
    for bad in ("..", "%2e%2e", "abc", "0" * 31):
        assert hub.read_comments(f"/{bad}").status_code == 404, bad


# -- reading ----------------------------------------------------------------
def test_the_queue_lists_the_whole_record(hub):
    """The agent is the consumer, and it gets the text as DATA (SPEC 7A.4)."""
    cid = _setup(hub, text="the bracket fouls the standoff")
    listed = hub.read_comments().json()["comments"]
    assert len(listed) == 1
    record = listed[0]
    assert record["id"] == cid
    assert record["text"] == "the bracket fouls the standoff"
    assert record["part"] == "/root/bracket"
    assert record["camera"]["target"] == [0.0, 0.0, 0.0]
    assert record["photo"] == f"{cid}.jpg"


def test_one_comment_can_be_fetched_by_id(hub):
    cid = _setup(hub)
    r = hub.read_comments(f"/{cid}")
    assert r.status_code == 200
    assert r.json()["id"] == cid


def test_the_photo_comes_back_as_an_image_attachment(hub):
    """Uploaded bytes handed back, so the content type is ours and not the sender's.

    `attachment` and `nosniff` together: the reader is a tool, nothing about this
    needs to render in a browser, and an uploaded file that renders in a browser
    is the whole class of problem this feature was designed around — the bytes
    come back on the same origin as every project's builds, which is true
    whatever credential put them there.
    """
    cid = _setup(hub)
    r = hub.read_comments(f"/{cid}/photo")
    assert r.status_code == 200
    assert r.content == JPEG_BYTES
    assert r.headers["Content-Type"] == "image/jpeg"
    assert r.headers["Content-Disposition"] == "attachment"
    assert r.headers["X-Content-Type-Options"] == "nosniff"


def test_the_shot_comes_back_too(hub):
    cid = _setup(hub)
    r = hub.read_comments(f"/{cid}/shot")
    assert r.status_code == 200
    assert r.content == PNG_BYTES
    assert r.headers["Content-Type"] == "image/png"


def test_an_absent_attachment_is_404(hub):
    assert hub.publish("proj2", "def456", good_build()).status_code == 201
    cid = hub.post_comment("proj2", "def456",
                           comment_payload()).json()["id"]
    assert hub.read_comments(f"/{cid}/photo").status_code == 404


def test_an_attachment_named_by_a_hand_edited_record_is_not_served(hub):
    """The name is read back off the volume, so it is checked again on the way out."""
    cid = _setup(hub)
    path = next(hub.comment_dir("proj1").glob(f"{cid}.json"))
    record = json.loads(path.read_text())
    record["photo"] = "../../../etc/passwd"
    path.write_text(json.dumps(record))
    assert hub.read_comments(f"/{cid}/photo").status_code == 404


# -- what a BUILD can leave in this directory (issue #74) --------------------
# `data/comments/` is on the same volume as everything else and a build can
# write anywhere in it (src/buildproc). The queue's own module docstring already
# said the directory is not evidence about who wrote what; these three are about
# the other half of that — what is at the name need not be a FILE. Nothing here
# needs a vulnerability or a token: the trap is laid by an `os.mkfifo` or an
# `os.symlink` in `model.py`, by an author who never touches EDIT_TOKEN, and it
# is sprung by whoever reads the queue.
def test_an_attachment_that_is_a_symlink_is_refused_rather_than_followed(
        hub, tmp_path):
    """A link where the photo goes used to be served AS the photo.

    Not a way past anything: this route takes EDIT_TOKEN, and so does the build
    that would plant the link. It is what one stray `os.symlink` in `model.py`
    does — the hub answers `/comments/<cid>/photo` with somebody else's file,
    typed as a JPEG because the NAME ends in `.jpg`. The name was already
    checked as one ordinary component belonging to this comment, so the last
    component being a link was the only way left for the bytes and the URL to
    disagree, and `candidate.is_file()` did not close it: `is_file()` follows
    the link and said True. `O_NOFOLLOW` is what refuses it.
    """
    cid = _setup(hub)
    elsewhere = tmp_path / "not-a-photo"
    elsewhere.write_bytes(b"bytes of a file nobody asked this URL for")
    photo = hub.comment_dir("proj1") / f"{cid}.jpg"
    photo.unlink()
    photo.symlink_to(elsewhere)
    reply = hub.read_comments(f"/{cid}/photo")
    assert reply.status_code == 404
    assert b"nobody asked" not in reply.content


@pytest.mark.skipif(not hasattr(os, "mkfifo"),
                    reason="this platform has no os.mkfifo, so no fifo can "
                           "reach the comment queue in the first place")
def test_a_fifo_where_an_attachment_was_is_refused_rather_than_waited_on(hub):
    """The deadline is as much of the assertion as the status code is.

    A plain `open()` on a fifo blocks until a writer appears, and none is
    coming: without a deadline a regression would hang this test rather than
    fail it, and a test that hangs is not a test.
    """
    cid = _setup(hub)
    photo = hub.comment_dir("proj1") / f"{cid}.jpg"
    photo.unlink()
    os.mkfifo(photo)
    assert hub.read_comments(f"/{cid}/photo", timeout=5).status_code == 404


@pytest.mark.skipif(not hasattr(os, "mkfifo"),
                    reason="this platform has no os.mkfifo, so no fifo can "
                           "reach the comment queue in the first place")
def test_a_fifo_in_the_queue_directory_does_not_wedge_the_listing(hub):
    """THE WORST ONE, because it needs no id at all.

    `_read_all` collects `*/*.json` with a glob and a glob returns a fifo like
    any other name, so this fires on `GET /api/v1/comments` — the call
    `hammerola comments` makes in ordinary work — and every one of them used to
    cost another request thread, permanently, while the real comments went on
    looking fine.

    The poisoned entry is skipped exactly like an unreadable one and the queue
    keeps working, which is the behaviour `_read_record` already promised for a
    torn file and now keeps for this too.
    """
    cid = _setup(hub)
    os.mkfifo(hub.comment_dir("proj1") / f"{'f' * 32}.json")
    reply = hub.read_comments("", timeout=5)
    assert reply.status_code == 200
    assert [record["id"] for record in reply.json()["comments"]] == [cid]


# -- filters ----------------------------------------------------------------
def test_the_queue_can_be_filtered_by_project(hub):
    _setup(hub, pid="proj1", commit="aaa")
    _setup(hub, pid="proj2", commit="bbb")
    assert len(hub.read_comments().json()["comments"]) == 2
    listed = hub.read_comments("?project=proj2").json()["comments"]
    assert [c["pid"] for c in listed] == ["proj2"]


def test_the_queue_can_be_filtered_by_status(hub):
    cid = _setup(hub)
    _setup(hub, commit="bbb")
    assert hub.read_comments(f"/{cid}/resolve", method="POST").status_code == 200
    open_ids = [c["id"] for c in
                hub.read_comments("?status=open").json()["comments"]]
    resolved = [c["id"] for c in
                hub.read_comments("?status=resolved").json()["comments"]]
    assert cid not in open_ids and resolved == [cid]


def test_the_queue_can_be_filtered_by_since(hub):
    cid = _setup(hub)
    created = hub.read_comments(f"/{cid}").json()["created"]
    assert len(hub.read_comments(f"?since={created}").json()["comments"]) == 1
    assert hub.read_comments("?since=2099-01-01T00:00:00Z").json()["comments"] == []


def test_since_is_compared_as_an_instant_not_as_a_string(hub):
    """An offset timestamp is valid ISO-8601 and sorts wrong as text.

    `2026-01-01T03:00:00+03:00` is midnight UTC, but character by character it is
    "greater" than `2026-01-01T01:00:00Z`, so a filter that compared the raw
    strings would drop comments it should return.
    """
    cid = _setup(hub)
    created = hub.read_comments(f"/{cid}").json()["created"]
    # The same instant as `created`, spelled with a +03:00 offset.
    moment = datetime.strptime(created, "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=timezone.utc).astimezone(timezone(timedelta(hours=3)))
    # Written straight into the URL, `+03:00` included — which a query string
    # decodes as a space, so this also covers the retry that puts it back.
    listed = hub.read_comments(f"?since={moment.isoformat()}").json()["comments"]
    assert [c["id"] for c in listed] == [cid]
    # And percent-encoded, the way a client library would send it.
    encoded = moment.isoformat().replace("+", "%2B")
    listed = hub.read_comments(f"?since={encoded}").json()["comments"]
    assert [c["id"] for c in listed] == [cid]


def test_a_malformed_filter_is_422(hub):
    _setup(hub)
    assert hub.read_comments("?status=nonsense").status_code == 422
    assert hub.read_comments("?since=yesterday").status_code == 422
    assert hub.read_comments("?project=../etc").status_code == 422


# -- resolve ----------------------------------------------------------------
def test_resolve_marks_the_comment_handled(hub):
    """So the agent does not work the same item twice (SPEC 7A.5)."""
    cid = _setup(hub)
    r = hub.read_comments(f"/{cid}/resolve", method="POST",
                          content=json.dumps({"note": "fixed in 4c1f0a2"}),
                          headers={"Content-Type": "application/json"})
    assert r.status_code == 200
    record = hub.read_comments(f"/{cid}").json()
    assert record["status"] == "resolved"
    assert record["note"] == "fixed in 4c1f0a2"
    assert record["resolved"] is not None
    # And it is on disk, not just in the reply.
    stored = json.loads(
        (hub.comment_dir("proj1") / f"{cid}.json").read_text())
    assert stored["status"] == "resolved"


def test_resolve_without_a_note_is_fine(hub):
    cid = _setup(hub)
    assert hub.read_comments(f"/{cid}/resolve", method="POST").status_code == 200
    assert hub.read_comments(f"/{cid}").json()["note"] is None


def test_resolve_keeps_the_text_and_the_attachments(hub):
    cid = _setup(hub, text="mind the fillet")
    hub.read_comments(f"/{cid}/resolve", method="POST")
    record = hub.read_comments(f"/{cid}").json()
    assert record["text"] == "mind the fillet"
    assert hub.read_comments(f"/{cid}/photo").status_code == 200


def test_resolving_an_unknown_id_is_404(hub):
    _setup(hub)
    assert hub.read_comments(f"/{'0' * 32}/resolve",
                             method="POST").status_code == 404


def test_a_resolve_note_with_a_control_character_is_422(hub):
    cid = _setup(hub)
    r = hub.read_comments(f"/{cid}/resolve", method="POST",
                          content=json.dumps({"note": "done‮no"}),
                          headers={"Content-Type": "application/json"})
    assert r.status_code == 422
    assert hub.read_comments(f"/{cid}").json()["status"] == "open"


def test_an_oversized_resolve_body_is_413(hub):
    cid = _setup(hub)
    r = hub.read_comments(f"/{cid}/resolve", method="POST",
                          content=json.dumps({"note": "x" * 20000}),
                          headers={"Content-Type": "application/json"})
    assert r.status_code == 413
