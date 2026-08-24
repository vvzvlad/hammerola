"""The PUBLIC half of the comment queue (SPEC 7A.2, 7A.4).

`POST /api/v1/comments/<pid>/<commit>` is the only endpoint on this service that
reads a body from someone who presented no credential at all. Everything here is
about what has to hold at that door: the ceilings, the address a rate limit is
keyed on, and the rule that what a file IS gets decided by its bytes rather than
by what the sender called it.

The tests talk HTTP to a real server, like the rest of the suite, because the
promises being checked are made in status codes.
"""

import json
import os
from pathlib import Path

import httpx
import pytest
from harness import (GIF_BYTES, JPEG_BYTES, NOTHING, PNG_BYTES, SVG_BYTES,
                     WEBP_BYTES, comment_payload, good_build, multipart_body,
                     start_hub, stop_hub)

from src import comments, store

STATIC = Path(__file__).resolve().parent.parent / "static"


def _publish(hub, pid="proj1", commit="abc123", marker="a"):
    assert hub.publish(pid, commit, good_build(marker)).status_code == 201
    return pid, commit


def _records(hub, pid="proj1"):
    return sorted(hub.comment_dir(pid).glob("*.json"))


# -- the happy paths --------------------------------------------------------
def test_a_comment_without_a_photo_is_accepted(hub):
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, comment_payload())
    assert r.status_code == 201
    cid = r.json()["id"]

    record = json.loads((hub.comment_dir(pid) / f"{cid}.json").read_text())
    assert record["pid"] == pid and record["commit"] == commit
    assert record["part"] == "/root/bracket"
    assert record["point"] == [1.0, 2.0, 3.5]
    assert record["camera"]["zoom"] == 1.25
    assert record["status"] == "open"
    assert record["photo"] is None and record["shot"] is None


def test_a_comment_with_a_photo_and_a_shot_is_accepted(hub):
    pid, commit = _publish(hub)
    r = hub.post_comment(
        pid, commit, comment_payload(),
        photo=("printed.jpg", JPEG_BYTES, "image/jpeg"),
        shot=("frame.png", PNG_BYTES, "image/png"))
    assert r.status_code == 201
    cid = r.json()["id"]

    record = json.loads((hub.comment_dir(pid) / f"{cid}.json").read_text())
    assert record["photo"] == f"{cid}.jpg"
    assert record["shot"] == f"{cid}.shot.png"
    assert (hub.comment_dir(pid) / record["photo"]).read_bytes() == JPEG_BYTES
    assert (hub.comment_dir(pid) / record["shot"]).read_bytes() == PNG_BYTES


def test_webp_is_accepted(hub):
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, comment_payload(),
                         photo=("p.webp", WEBP_BYTES, "image/webp"))
    assert r.status_code == 201
    cid = r.json()["id"]
    assert (hub.comment_dir(pid) / f"{cid}.webp").is_file()


def test_a_body_from_an_ordinary_client_encoder_is_accepted(hub):
    """The hand-rolled parser must read what a real HTTP client produces.

    Every other test here builds the body itself, which is what makes the hostile
    cases expressible — and would also make a parser that only understands THIS
    encoder look perfectly healthy. So one test goes through httpx's own
    multipart encoder instead.
    """
    pid, commit = _publish(hub)
    r = httpx.post(
        f"{hub.url}/api/v1/comments/{pid}/{commit}",
        data={"comment": json.dumps(comment_payload())},
        files={"photo": ("printed.jpg", JPEG_BYTES, "image/jpeg")},
        timeout=10, trust_env=False)
    assert r.status_code == 201


def test_the_reply_carries_the_id_and_nothing_else(hub):
    """The text is never echoed back and never rendered (SPEC 7A.4).

    Echoing it would put attacker-supplied text into a response the attacker can
    make somebody else's browser fetch, which is the XSS surface this feature
    exists without.
    """
    pid, commit = _publish(hub)
    payload = comment_payload(text="<script>alert(1)</script>")
    r = hub.post_comment(pid, commit, payload)
    assert r.status_code == 201
    assert set(r.json()) == {"id"}
    assert b"script" not in r.content


def test_a_comment_needs_no_token(hub):
    """Stated as a test because it is a decision, not an oversight (SPEC 7A.2)."""
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, comment_payload())
    assert r.status_code == 201
    assert "Authorization" not in r.request.headers


# -- what the endpoint refuses ----------------------------------------------
def test_a_comment_on_a_build_that_was_never_published_is_404(hub):
    r = hub.post_comment("proj1", "abc123", comment_payload())
    assert r.status_code == 404
    assert not (hub.data / "comments" / "proj1").exists()


def test_a_comment_on_an_unsafe_pid_is_404(hub):
    r = hub.post_comment("..", "abc123", comment_payload())
    assert r.status_code == 404


def test_a_missing_comment_field_is_422(hub):
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, NOTHING,
                         photo=("p.jpg", JPEG_BYTES, "image/jpeg"))
    assert r.status_code == 422
    assert not _records(hub)


def test_a_comment_field_that_is_not_json_is_422(hub):
    pid, commit = _publish(hub)
    body, ctype = multipart_body({"comment": "{not json"})
    r = hub.post_comment(pid, commit, body=body, content_type=ctype)
    assert r.status_code == 422
    assert not _records(hub)


def test_empty_text_is_422(hub):
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, comment_payload(text="   \n  "))
    assert r.status_code == 422


def test_a_non_finite_camera_value_is_422(hub):
    """`json.loads` accepts NaN; `json.dumps` writes it back as invalid JSON.

    So a NaN that got through would produce a stored comment no strict parser can
    read — including the agent's. It has to be refused at the door.
    """
    pid, commit = _publish(hub)
    body, ctype = multipart_body({
        "comment": '{"text": "x", "camera": {"position": [NaN, 0, 0], '
                   '"quaternion": [0,0,0,1], "target": [0,0,0]}}'})
    r = hub.post_comment(pid, commit, body=body, content_type=ctype)
    assert r.status_code == 422
    assert not _records(hub)


def test_a_control_character_in_the_part_name_is_422(hub):
    # U+202E RIGHT-TO-LEFT OVERRIDE. It is not a control character in the ASCII
    # sense and it survives every naive filter, but it reverses the text around
    # it in whatever the agent reads the queue in.
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, comment_payload(part="a‮b"))
    assert r.status_code == 422


def test_a_malformed_multipart_body_is_422(hub):
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, body=b"not multipart at all",
                         content_type="multipart/form-data; boundary=zzz")
    assert r.status_code == 422


def test_a_truncated_multipart_body_is_422(hub):
    pid, commit = _publish(hub)
    body, ctype = multipart_body({"comment": json.dumps(comment_payload())})
    r = hub.post_comment(pid, commit, body=body[:-20], content_type=ctype)
    assert r.status_code == 422


def test_a_duplicate_field_is_refused(hub):
    """Two `comment` fields is a request about which parser wins. Neither does."""
    pid, commit = _publish(hub)
    body, ctype = multipart_body({"comment": json.dumps(comment_payload())})
    doubled = body.replace(b"--TestBoundary--123--\r\n", b"") + body
    r = hub.post_comment(pid, commit, body=doubled, content_type=ctype)
    assert r.status_code == 422


def test_a_body_of_unknown_length_is_411(hub):
    """Chunked has no Content-Length, and the ceiling is applied to that.

    Accepting one would mean either decoding a body of unknown size — the exact
    thing the ceiling exists to prevent — or answering while leaving its remains
    on a keep-alive socket, where they become the next request.
    """
    pid, commit = _publish(hub)

    def streamed():
        yield multipart_body({"comment": json.dumps(comment_payload())})[0]

    r = httpx.post(f"{hub.url}/api/v1/comments/{pid}/{commit}", content=streamed(),
                   headers={"Content-Type": multipart_body({})[1]},
                   timeout=10, trust_env=False)
    assert r.status_code == 411
    assert not _records(hub)


def test_a_non_multipart_body_is_422(hub):
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, body=json.dumps(comment_payload()).encode(),
                         content_type="application/json")
    assert r.status_code == 422


# -- image types are decided by the bytes -----------------------------------
def test_svg_is_refused_and_says_so(hub):
    """SPEC 7A.4. An SVG is a script container, and this service has met one."""
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, comment_payload(),
                         photo=("drawing.svg", SVG_BYTES, "image/svg+xml"))
    assert r.status_code == 422
    assert "SVG" in r.json()["error"]
    assert list(hub.comment_dir(pid).glob("*")) == []


def test_svg_disguised_as_a_png_is_still_refused(hub):
    """The filename says png, the header says png, the BYTES say svg.

    This is the exact shape of the attack the magic-byte rule exists for: if
    either of the two things the sender controls were believed, an executable
    document would be stored and later served back.
    """
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, comment_payload(),
                         photo=("innocent.png", SVG_BYTES, "image/png"))
    assert r.status_code == 422
    assert "SVG" in r.json()["error"]
    assert not _records(hub)


def test_an_unsupported_type_declared_as_png_is_refused(hub):
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, comment_payload(),
                         photo=("x.png", GIF_BYTES, "image/png"))
    assert r.status_code == 422
    assert "JPEG" in r.json()["error"]


def test_a_jpeg_declared_as_text_is_stored_as_a_jpeg(hub):
    """The rule cuts both ways: the bytes decide, so a wrong label is harmless."""
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, comment_payload(),
                         photo=("notes.txt", JPEG_BYTES, "text/plain"))
    assert r.status_code == 201
    cid = r.json()["id"]
    assert (hub.comment_dir(pid) / f"{cid}.jpg").is_file()


def test_the_stored_name_never_comes_from_the_upload(hub):
    """A filename is not a name here; it is discarded before anything uses it."""
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, comment_payload(),
                         photo=("../../escape.jpg", JPEG_BYTES, "image/jpeg"))
    assert r.status_code == 201
    cid = r.json()["id"]
    assert sorted(p.name for p in hub.comment_dir(pid).glob("*")) == [
        f"{cid}.jpg", f"{cid}.json"]


def test_sniff_image_unit():
    assert comments.sniff_image(PNG_BYTES) == "png"
    assert comments.sniff_image(JPEG_BYTES) == "jpg"
    assert comments.sniff_image(WEBP_BYTES) == "webp"
    # RIFF alone is WAV and AVI too, so the second marker has to be checked.
    with pytest.raises(comments.CommentError):
        comments.sniff_image(b"RIFF\x24\x00\x00\x00WAVEfmt ")
    with pytest.raises(comments.CommentError) as caught:
        comments.sniff_image(b"   \n<svg xmlns='...'></svg>")
    assert "SVG" in caught.value.message


# -- ceilings ---------------------------------------------------------------
def test_an_oversized_photo_is_413(hub_factory):
    small = hub_factory(comment_max_photo_bytes=1024)
    pid, commit = _publish(small)
    r = small.post_comment(pid, commit, comment_payload(),
                           photo=("p.jpg", JPEG_BYTES + os.urandom(4096),
                                  "image/jpeg"))
    assert r.status_code == 413
    assert not _records(small)


def test_an_oversized_body_is_413_before_it_is_read(hub_factory):
    """The ceiling is applied to Content-Length, like the publish one is.

    A 413 issued after reading the body has already done the work it was meant
    to refuse, which on a PUBLIC endpoint is the whole point of having a ceiling.
    """
    small = hub_factory(comment_max_body_bytes=4096)
    pid, commit = _publish(small)
    r = small.post_comment(pid, commit, comment_payload(),
                           photo=("p.jpg", JPEG_BYTES + os.urandom(32768),
                                  "image/jpeg"))
    assert r.status_code == 413
    assert not small.comment_dir(pid).exists()


def test_oversized_text_is_413(hub_factory):
    small = hub_factory(comment_max_text_chars=64)
    pid, commit = _publish(small)
    r = small.post_comment(pid, commit, comment_payload(text="x" * 200))
    assert r.status_code == 413
    assert not _records(small)


def test_a_build_stops_accepting_comments_at_its_ceiling(hub_factory):
    limited = hub_factory(comment_max_per_build=2)
    pid, commit = _publish(limited)
    for _ in range(2):
        assert limited.post_comment(
            pid, commit, comment_payload()).status_code == 201
    r = limited.post_comment(pid, commit, comment_payload())
    assert r.status_code == 429
    assert len(_records(limited)) == 2


def test_the_queue_stops_accepting_comments_at_its_global_ceiling(hub_factory):
    """Per-build ceilings alone leave a patient writer one build per bucket."""
    limited = hub_factory(comment_max_total=2, comment_max_per_build=100)
    _publish(limited, commit="aaa")
    _publish(limited, commit="bbb", marker="b")
    assert limited.post_comment("proj1", "aaa",
                                comment_payload()).status_code == 201
    assert limited.post_comment("proj1", "bbb",
                                comment_payload()).status_code == 201
    assert limited.post_comment("proj1", "bbb",
                                comment_payload()).status_code == 429


def test_the_ceilings_survive_a_restart(tmp_path):
    """The counters are in memory, so they have to be rebuilt from the volume.

    Without the rescan a restart would reset every ceiling, and "restart the
    container" is not something an attacker has to arrange — it happens on every
    deploy. Two hubs on ONE data directory, one after the other, which is why
    this test cannot use the hub_factory fixture: that gives each hub its own.
    """
    data = tmp_path / "shared"
    first = start_hub(data, comment_max_per_build=1)
    try:
        pid, commit = _publish(first)
        assert first.post_comment(pid, commit,
                                  comment_payload()).status_code == 201
    finally:
        stop_hub(first)

    second = start_hub(data, comment_max_per_build=1)
    try:
        assert second.post_comment(pid, commit,
                                   comment_payload()).status_code == 429
    finally:
        stop_hub(second)


# -- the rate limit ---------------------------------------------------------
def test_the_rate_limit_refuses_with_429_and_a_retry_after(hub_factory):
    limited = hub_factory(comment_rate_limit=2, comment_rate_window_seconds=600)
    pid, commit = _publish(limited)
    for _ in range(2):
        assert limited.post_comment(
            pid, commit, comment_payload()).status_code == 201
    r = limited.post_comment(pid, commit, comment_payload())
    assert r.status_code == 429
    assert int(r.headers["Retry-After"]) > 0
    assert len(_records(limited)) == 2


def test_the_rate_limit_is_not_bypassed_by_a_forged_forwarded_header(hub_factory):
    """The invariant of SPEC 7A.4, and the reason the RIGHTMOST entry is read.

    The header sent here is what Traefik actually produces when a client supplies
    one of its own: the proxy APPENDS the address it saw, so the client's forgery
    lands on the left and the real address on the right. Reading the leftmost
    entry — the common way to write this — would give the attacker a fresh bucket
    per request and no ceiling at all.
    """
    limited = hub_factory(comment_rate_limit=1)
    pid, commit = _publish(limited)
    first = limited.post_comment(
        pid, commit, comment_payload(),
        headers={"X-Forwarded-For": "9.9.9.9, 203.0.113.7"})
    assert first.status_code == 201
    second = limited.post_comment(
        pid, commit, comment_payload(),
        headers={"X-Forwarded-For": "8.8.8.8, 203.0.113.7"})
    assert second.status_code == 429


def test_two_real_clients_behind_the_proxy_get_their_own_budgets(hub_factory):
    """The other half of the same claim: the header is USED, not ignored.

    Without it every visitor behind Traefik would share one bucket, because the
    peer address is the proxy's for all of them.
    """
    limited = hub_factory(comment_rate_limit=1)
    pid, commit = _publish(limited)
    assert limited.post_comment(
        pid, commit, comment_payload(),
        headers={"X-Forwarded-For": "203.0.113.7"}).status_code == 201
    assert limited.post_comment(
        pid, commit, comment_payload(),
        headers={"X-Forwarded-For": "203.0.113.8"}).status_code == 201


def test_client_address_unit():
    # Reachable directly: the header is not the proxy's, so it is not read.
    assert comments.client_address("203.0.113.5", "9.9.9.9") == "203.0.113.5"
    # Behind a trusted proxy: the last entry is the one the proxy itself saw.
    assert comments.client_address("10.0.0.2", "9.9.9.9, 203.0.113.7") \
        == "203.0.113.7"
    # No header at all, and a junk one, both fall back to the peer.
    assert comments.client_address("10.0.0.2", "") == "10.0.0.2"
    assert comments.client_address("10.0.0.2", "9.9.9.9, not-an-address") \
        == "10.0.0.2"


def test_the_rate_limiter_table_stays_bounded():
    limiter = comments.RateLimiter(limit=1, window=600)
    for index in range(comments.MAX_TRACKED_ADDRESSES + 500):
        limiter.allow(f"10.1.{index // 256}.{index % 256}")
    assert len(limiter._hits) <= comments.MAX_TRACKED_ADDRESSES


def test_the_rate_limit_window_expires():
    limiter = comments.RateLimiter(limit=1, window=10)
    assert limiter.allow("a", now=1000.0)[0]
    assert not limiter.allow("a", now=1005.0)[0]
    assert limiter.allow("a", now=1011.0)[0]


# -- storage: outside the build, atomic ------------------------------------
def test_a_comment_outlives_the_build_retention_deletes(hub_factory):
    """SPEC 7A.3. The queue is not under the build directory, deliberately."""
    tight = hub_factory(retention_builds=1)
    _publish(tight, commit="aaa", marker="a")
    posted = tight.post_comment("proj1", "aaa", comment_payload())
    assert posted.status_code == 201
    cid = posted.json()["id"]

    # Two more builds: `aaa` is neither in the window nor `latest` any more.
    _publish(tight, commit="bbb", marker="b")
    _publish(tight, commit="ccc", marker="c")
    assert not (tight.project_dir("proj1") / "aaa").exists()

    record = json.loads((tight.comment_dir("proj1") / f"{cid}.json").read_text())
    assert record["commit"] == "aaa"
    listed = tight.read_comments().json()["comments"]
    assert [c["id"] for c in listed] == [cid]


def test_comments_are_not_served_from_the_public_site(hub):
    """They live under <data>/comments, which no public route can reach."""
    pid, commit = _publish(hub)
    cid = hub.post_comment(pid, commit, comment_payload()).json()["id"]
    for path in (f"/project/{pid}/{commit}/{cid}.json",
                 f"/comments/{pid}/{cid}.json",
                 f"/project/comments/{pid}/{cid}.json"):
        assert hub.get(path).status_code in (302, 404)


# -- the page that writes into the queue ------------------------------------
def test_the_build_page_ships_the_comment_form(hub):
    """viewer.js fills these in by id; a template without them fails silently."""
    _publish(hub)
    body = hub.get("/project/proj1/abc123/").text
    for element in ("comment_btn", "comment_panel", "comment_text",
                    "comment_photo", "comment_send", "comment_cancel",
                    "comment_status", "comment_hint"):
        assert element in body, element


def test_the_viewer_never_builds_markup_from_a_string():
    """The rule the whole comment UI is written under (SPEC 7A.4).

    This page takes text from a stranger's keyboard and lives on one origin
    shared with every project on the host. Two stored XSS bugs in this project
    were assignments to innerHTML, so the absence is asserted rather than
    reviewed.
    """
    # The property ACCESS, not the word: both files talk about innerHTML in a
    # comment explaining why they do not use it, and a test that failed on prose
    # would be deleted the first time it cried wolf.
    for name in ("viewer.js", "index.js"):
        source = (STATIC / "_v" / name).read_text(encoding="utf-8")
        for forbidden in (".innerHTML", ".outerHTML", '["innerHTML"]',
                          ".insertAdjacentHTML(", "document.write("):
            assert forbidden not in source, f"{name}: {forbidden}"


class _RenameWatcher:
    """A stand-in for `os` inside src.store, recording what rename() saw.

    Same trick as tests/test_atomicity.py, and for the same reason: patching the
    real os module would record every unrelated rename the server does.
    """

    def __init__(self, seen):
        self._seen = seen

    def __getattr__(self, name):
        return getattr(os, name)

    def rename(self, src, dst, *a, **kw):
        # Read the SOURCE before the rename: what matters is that the bytes were
        # already whole under the temporary name, since the rename is the moment
        # they become visible under the real one.
        try:
            content = open(src, "rb").read()
        except OSError:
            content = None
        self._seen.append((str(src), str(dst), content))
        return os.rename(src, dst, *a, **kw)


def test_a_comment_becomes_visible_by_rename_and_never_half_written(hub,
                                                                    monkeypatch):
    pid, commit = _publish(hub)
    seen = []
    monkeypatch.setattr(store, "os", _RenameWatcher(seen))
    r = hub.post_comment(pid, commit, comment_payload(),
                         photo=("p.jpg", JPEG_BYTES, "image/jpeg"))
    assert r.status_code == 201
    cid = r.json()["id"]

    landings = {dst: content for _, dst, content in seen}
    record_path = str(hub.comment_dir(pid) / f"{cid}.json")
    photo_path = str(hub.comment_dir(pid) / f"{cid}.jpg")
    # Both files arrived at their final name by rename, and both were already
    # complete at that moment — a reader can only ever see all of it or none.
    assert record_path in landings and photo_path in landings
    assert json.loads(landings[record_path])["id"] == cid
    assert landings[photo_path] == JPEG_BYTES
    # And every rename came from a temp name, not from the final one.
    assert all(os.path.basename(src).startswith(".wip-")
               for src, dst, _ in seen if dst in (record_path, photo_path))


def test_a_write_that_fails_leaves_nothing_behind(hub, monkeypatch):
    """A failed comment must not leave an orphan photo or a partial record."""
    pid, commit = _publish(hub)

    class _FailingRename(_RenameWatcher):
        def rename(self, src, dst, *a, **kw):
            if str(dst).endswith(".json"):
                raise OSError("disk says no")
            return os.rename(src, dst, *a, **kw)

    monkeypatch.setattr(store, "os", _FailingRename([]))
    r = hub.post_comment(pid, commit, comment_payload(),
                         photo=("p.jpg", JPEG_BYTES, "image/jpeg"))
    assert r.status_code == 500
    monkeypatch.undo()
    assert list(hub.comment_dir(pid).glob("*.json")) == []
    assert list(hub.comment_dir(pid).glob("*.jpg")) == []
    # And the ceiling did not count a comment that never landed.
    assert hub.read_comments().json()["comments"] == []
