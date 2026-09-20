"""The WRITE half of the comment queue (SPEC 7A.2, 7A.4).

`POST /api/v1/comments/<pid>/<commit>` takes EDIT_TOKEN since step 0 of the plan
(SPEC 8A.1): a hub that executes the code it is sent cannot also accept anonymous
input into a queue an agent works from. It used to be the one endpoint here that
read a body from someone who presented no credential at all, and most of this
file is unchanged by that, deliberately — the SIZE ceilings and the rule that
what a file IS gets decided by its bytes are about what the hub does with a body
and what it later serves, not about who sent it.

What the token DID take away is everything that counted or throttled: the
per-build ceiling, the global one and the rate limit keyed on the client address
are gone (SPEC 7A.4, 2026-08-27), along with the tests that pinned them. That the
ceilings are not merely raised but absent is asserted in
tests/test_no_retention.py, beside the other absences — an absence that nothing
tests grows back.

`harness.Hub.post_comment` therefore sends the token by default; the tests about
the door pass `token=None`.

The tests talk HTTP to a real server, like the rest of the suite, because the
promises being checked are made in status codes.
"""

import json
import os
import shutil
from pathlib import Path

import httpx
import pytest
from harness import (GIF_BYTES, JPEG_BYTES, NOTHING, PNG_BYTES, SVG_BYTES,
                     TOKEN, WEBP_BYTES, comment_payload, good_build,
                     multipart_body)

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


def test_the_catalogue_key_is_stored(hub):
    """The anchor that outlives one revision (SPEC 7A.1).

    `part` is a path in the tree of the build the comment was left on, and the
    tessellator renumbers those; `key` names the entity in the catalogue, and it
    is what the build page follows to put the pin back on a later build.
    """
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, comment_payload(key="bracket"))
    assert r.status_code == 201
    cid = r.json()["id"]

    record = json.loads((hub.comment_dir(pid) / f"{cid}.json").read_text())
    assert record["key"] == "bracket"


def test_a_comment_with_no_key_stores_none(hub):
    """No key sent, no key stored — the page reads that as unanchored."""
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, comment_payload())
    assert r.status_code == 201
    cid = r.json()["id"]

    record = json.loads((hub.comment_dir(pid) / f"{cid}.json").read_text())
    assert record["key"] is None


def test_the_build_stamp_is_stored(hub):
    """WHICH build the comment was left on, and not just which name (SPEC 7A.1).

    `commit` does not answer that on the local slot: it is the constant `dev`
    for every build the slot ever holds (SPEC 7.6), so a comment from a previous
    incarnation would go on looking like one left on the geometry now on screen,
    and the page would draw its stale coordinate.

    THE STAMP THE CALLER SENT is what lands in the record, and the caller here
    sends one that is deliberately not the one on the hub's disk: only the page
    knows which build the coordinate was taken on, and reading the build
    directory at POST time would answer with whatever was built LAST instead.
    """
    pid, commit = _publish(hub)
    meta = json.loads(
        (hub.project_dir(pid) / commit / "meta.json").read_text())
    sent = "2020-01-01T00:00:00.000Z"
    assert sent != meta["published"]
    r = hub.post_comment(pid, commit, comment_payload(published=sent))
    assert r.status_code == 201
    cid = r.json()["id"]

    record = json.loads((hub.comment_dir(pid) / f"{cid}.json").read_text())
    assert record["published"] == sent


def test_a_comment_with_no_build_stamp_stores_none(hub):
    """No stamp sent, no stamp stored — the comment lands either way.

    A record without one anchors by its catalogue key like a comment from any
    other build, which is honest; refusing the comment, or borrowing a stamp off
    the build directory, would not be — that directory holds the newest build
    and not the one the caller was looking at.
    """
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, comment_payload())
    assert r.status_code == 201
    cid = r.json()["id"]

    record = json.loads((hub.comment_dir(pid) / f"{cid}.json").read_text())
    assert record["published"] is None


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
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=10, trust_env=False)
    assert r.status_code == 201


def test_the_reply_carries_the_id_and_nothing_else(hub):
    """The reply is a bare id: the text is never echoed back (SPEC 7A.4).

    ABOUT THE REPLY AND NOT ABOUT RENDERING, which is the half of the old
    sentence that stopped being true: since issue #33 the build page DOES draw
    the queue, as text and never as markup, and `ui/tests/feed.test.js` is where
    that is pinned. What stays true here is that a response nobody asked for
    carries nothing back — the caller already has its own text.
    """
    pid, commit = _publish(hub)
    payload = comment_payload(text="<script>alert(1)</script>")
    r = hub.post_comment(pid, commit, payload)
    assert r.status_code == 201
    assert set(r.json()) == {"id"}
    assert b"script" not in r.content


# -- the door ---------------------------------------------------------------
def test_a_comment_without_the_token_is_refused(hub):
    """The reversal of a decision, so it is pinned as one (SPEC 8A.1, step 0).

    Writing here used to be public and this test used to assert the opposite —
    that no Authorization header was sent and the comment landed anyway. That
    was the first step of a path with no vulnerability in it: anyone writes a
    comment, it lands in the queue, an agent reads the queue as a task, the
    agent edits model.py, the hub executes model.py.
    """
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, comment_payload(), token=None)
    assert r.status_code == 401
    assert r.headers["WWW-Authenticate"] == "Bearer"
    assert not _records(hub)


def test_a_wrong_token_is_refused_the_same_way(hub):
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, comment_payload(), token=TOKEN[:-1])
    assert r.status_code == 401
    assert not _records(hub)


def test_the_token_is_checked_before_the_body_is_read(hub_factory):
    """The ordering is the point of the change, not a detail.

    A caller without the secret must not be able to make this hub receive a
    multipart body and parse it just to be told no. Proved against a hub whose
    body ceiling is 4 KiB, with a body that is over it AND not multipart at all:
    either fact would answer 413 or 422 the moment it was looked at, so 401 is
    the only answer possible if NOTHING below the token check ran.
    """
    small = hub_factory(comment_max_body_bytes=4096)
    pid, commit = _publish(small)
    r = small.post_comment(pid, commit, body=b"x" * 8192,
                           content_type="text/plain", token=None)
    assert r.status_code == 401
    assert not _records(small)

    # And the same body WITH the token gets the answer it deserves, which is
    # what proves the two refusals above are not simply the ceiling misreported.
    r = small.post_comment(pid, commit, body=b"x" * 8192,
                           content_type="text/plain")
    assert r.status_code == 413


def test_an_unpublished_build_is_404_only_once_the_token_is_shown(hub):
    """Without the token the answer is 401, with it 404 — so the route says
    nothing about what exists to a caller who has not identified themselves."""
    assert hub.post_comment("proj1", "abc123", comment_payload(),
                            token=None).status_code == 401
    assert hub.post_comment("proj1", "abc123", comment_payload()
                            ).status_code == 404


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


def test_a_key_that_is_not_a_string_is_422(hub):
    """`key` goes through the same door as `part`: one printable line, or 422."""
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, comment_payload(key=["bracket"]))
    assert r.status_code == 422
    assert not _records(hub)


def test_a_multi_line_key_is_422(hub):
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, comment_payload(key="brac\nket"))
    assert r.status_code == 422
    assert not _records(hub)


@pytest.mark.parametrize("stamp", [["2026-01-01T00:00:00Z"],
                                   "2026-01-01\nT00:00:00Z"])
def test_a_build_stamp_that_is_not_one_printable_line_is_422(hub, stamp):
    """`published` comes from the caller now, so it goes through the same door.

    One printable line or a 422, exactly like `part` and `key`: the field is
    written into the record and read back by the page and by the agent, and a
    list or an embedded newline is neither a stamp nor readable there.
    """
    pid, commit = _publish(hub)
    r = hub.post_comment(pid, commit, comment_payload(published=stamp))
    assert r.status_code == 422
    assert not _records(hub)


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
                   headers={"Content-Type": multipart_body({})[1],
                            "Authorization": f"Bearer {TOKEN}"},
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
    to refuse, which is the whole point of having a ceiling — the token in front
    of it decides WHO can make the hub do that work, not how much of it there is.
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


# -- storage: outside the build, atomic ------------------------------------
def test_a_comment_outlives_the_build_it_is_about(hub):
    """SPEC 7A.3. The queue is not under the build directory, deliberately.

    The build is removed BY HAND here, which is the only way a build goes now
    (SPEC 5.3): retention used to make this happen on its own, and the test
    stood on a window of one. The property is the same either way — a comment
    is not a file inside the build it names, so nothing that removes the build
    can take it — and doing it by hand is if anything the more faithful
    rehearsal, because that is what will really happen the day somebody clears
    space on the volume.
    """
    _publish(hub, commit="aaa", marker="a")
    posted = hub.post_comment("proj1", "aaa", comment_payload())
    assert posted.status_code == 201
    cid = posted.json()["id"]

    _publish(hub, commit="bbb", marker="b")
    shutil.rmtree(hub.project_dir("proj1") / "aaa")
    assert not (hub.project_dir("proj1") / "aaa").exists()

    record = json.loads((hub.comment_dir("proj1") / f"{cid}.json").read_text())
    assert record["commit"] == "aaa"
    listed = hub.read_comments().json()["comments"]
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
def test_the_committed_page_scripts_never_build_markup_from_a_string():
    """The rule the whole site is written under (SPEC 7A.4).

    These pages take text from a stranger's keyboard and live on one origin
    shared with every project on the host. Two stored XSS bugs in this project
    were assignments to innerHTML, so the absence is asserted rather than
    reviewed.

    The scripts checked here are the COMMITTED ones, which today means the
    pointer resolver and the key it reads. The two pages that used to have one of
    their own — the build page and then the front page — are drawn by the
    compiled interface in `ui/src/` instead, and it is held to the same rule
    there, by tests/test_ui_source.py::test_nothing_writes_markup. Two checks
    rather than one because they can only be made differently: that side is
    source with comments stripped, and there is no point reading
    `static/_v/hammerola.js`, which is a build artefact a fresh checkout does not
    have.

    THE LIST IS DISCOVERED AND THEN CHECKED AGAINST WHAT IS EXPECTED, so that
    neither direction is silent. A page script added to this directory is covered
    without anybody remembering; a page script REMOVED — which is how the front
    page's `index.js` left — fails here and has to be accounted for in the same
    commit, rather than quietly leaving this test sweeping a shorter list. That
    is the failure mode worth the extra assertion: a check that still passes
    while checking less reads exactly like a check that passed.
    """
    directory = STATIC / "_v"
    # The viewer library DOES build markup from strings; it is not a page script
    # of ours and not ours to hold to this rule, and where it comes from is
    # written down (static/_v/PROVENANCE.md). `three.module.js` and
    # `three.core.js` are npm's builds of three, in this directory because the
    # viewer bundle imports three by URL instead of carrying it — a library, not
    # a page script, on the same grounds. The build artefact is not read for the
    # reason the docstring gives. Each is named rather than guessed at, so that a
    # further library file here is a decision somebody makes in this line.
    skipped = {"three-cad-viewer.esm.js", "three.module.js", "three.core.js"}
    ours = sorted(path.name for path in directory.glob("*.js")
                  if path.name not in skipped
                  and not path.name.startswith("hammerola"))

    assert ours == ["pointer.js", "pointer_pref.js"], (
        f"the committed page scripts in {directory} are {ours}, and this test "
        "expects ['pointer.js', 'pointer_pref.js']. If one was added, it is now "
        "covered and this list needs it. If one was REMOVED, say where its page "
        "went: a page drawn by the compiled interface is covered by "
        "tests/test_ui_source.py::test_nothing_writes_markup instead, and one "
        "that is simply gone needs nothing — but neither may happen silently."
    )

    # The property ACCESS, not the word: these files talk about innerHTML in a
    # comment explaining why they do not use it, and a test that failed on prose
    # would be deleted the first time it cried wolf.
    for name in ours:
        source = (directory / name).read_text(encoding="utf-8")
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
    # And the queue does not list a comment that never landed either.
    assert hub.read_comments().json()["comments"] == []
