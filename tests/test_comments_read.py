"""The TOKEN-GUARDED half of the comment queue (SPEC 7A.2).

Writing is public and reading is not, and that asymmetry is the point: the queue
is raw input from anyone at all — it can be junk, duplicated or abusive — so
handing it back to every visitor would turn a showcase of projects into a message
board. These tests are mostly about the door: which endpoints demand the token,
that the PUBLISH token is not it, and that a caller without one cannot learn
anything from the difference between 401 and 404.
"""

import json
from datetime import datetime, timedelta, timezone

from harness import (JPEG_BYTES, PNG_BYTES, READ_TOKEN, TOKEN, comment_payload,
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


def test_every_read_endpoint_refuses_the_publish_token(hub):
    """The two tokens live in different places and are not interchangeable.

    PUBLISH_TOKEN is in CI, COMMENT_READ_TOKEN is in the agent's MCP server. A
    hub that accepted either for both would make rotating one pointless.
    """
    cid = _setup(hub)
    for path in READ_ENDPOINTS:
        r = hub.read_comments(path.format(cid=cid), token=TOKEN)
        assert r.status_code == 401, path


def test_resolve_refuses_a_missing_token(hub):
    cid = _setup(hub)
    r = hub.read_comments(f"/{cid}/resolve", token=None, method="POST")
    assert r.status_code == 401
    assert hub.read_comments(f"/{cid}").json()["status"] == "open"


def test_a_token_prefix_is_not_accepted(hub):
    _setup(hub)
    r = hub.read_comments("", token=READ_TOKEN[:-1])
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
    needs to render in a browser, and a stranger's file that renders in a browser
    is the whole class of problem this feature was designed around.
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
