"""The publish protocol: SPEC 7 status codes, atomicity and immutability."""

import json
import os
import socket
import time

import pytest

from harness import TOKEN, good_build, meta_bytes, tar_gz, view_bytes

from src import app, render
from src.store import PublishError, Store


def test_publish_creates_the_build_and_points_latest_at_it(hub):
    r = hub.publish("proj1", "abc123", good_build())
    assert r.status_code == 201
    assert r.json() == {"url": "/project/proj1/abc123/"}

    build = hub.project_dir("proj1") / "abc123"
    # The uploaded members, plus the normalized meta.json the hub writes. The
    # page shell is deliberately NOT here: it is the same for every build and
    # changes with the image, so it is rendered from the template per request.
    assert (build / "assembled.json").is_file()
    assert (build / "meta.json").is_file()
    assert not (build / "index.html").exists()
    assert hub.get("/project/proj1/abc123/").status_code == 200

    # `latest` is a SYMLINK, not a copy: SPEC 3.2 relies on that both for space
    # (a build is ~2 MB per view) and for the atomic flip.
    link = hub.project_dir("proj1") / "latest"
    assert link.is_symlink()
    assert os.readlink(link) == "abc123"

    # And it is a RELATIVE link. An absolute one would be correct on this machine
    # and dangling inside the container, where the same tree is mounted at
    # /app/data — the failure would only appear in production.
    assert not os.path.isabs(os.readlink(link))


def test_published_meta_is_normalized_for_the_viewer(hub):
    hub.publish("proj1", "abc123", good_build(downloads={"stl": "model.stl"},
                                              extra_files={"model.stl": b"solid"}))
    meta = json.loads((hub.project_dir("proj1") / "abc123" / "meta.json").read_text())

    # `views` on the wire becomes `variants` for the viewer, and the sizes are
    # measured here rather than trusted from the upload.
    assert [v["id"] for v in meta["variants"]] == ["assembled"]
    variant = meta["variants"][0]
    assert variant["bytes"] == len(view_bytes("a"))
    assert variant["gzip"] > 0
    assert meta["commit"] == "abc123"
    assert meta["pid"] == "proj1"
    assert meta["downloads"] == {"stl": "model.stl"}


def test_builds_json_and_root_index_are_written(hub):
    hub.publish("proj1", "abc123", good_build())
    builds = json.loads((hub.project_dir("proj1") / "builds.json").read_text())
    assert [b["commit"] for b in builds["builds"]] == ["abc123"]

    index = json.loads((hub.data / "index.json").read_text())
    assert [c["pid"] for c in index] == ["proj1"]
    assert index[0]["commit"] == "abc123"


def test_identical_retry_is_200_not_409(hub):
    body = good_build()
    assert hub.publish("proj1", "abc123", body).status_code == 201
    # Byte-identical retry: CI retries are safe (SPEC 7).
    again = hub.publish("proj1", "abc123", body)
    assert again.status_code == 200
    assert again.json() == {"url": "/project/proj1/abc123/"}


def test_identical_retry_ignores_tar_framing(hub):
    # Two archives of the SAME files, built separately: mtimes and member order
    # differ, the payload does not. A digest over the raw tar would 409 here, and
    # CI would be unable to retry anything.
    assert hub.publish("proj1", "abc123", good_build()).status_code == 201
    assert hub.publish("proj1", "abc123", good_build()).status_code == 200


def test_different_content_for_the_same_commit_is_409(hub):
    assert hub.publish("proj1", "abc123", good_build("a")).status_code == 201
    clash = hub.publish("proj1", "abc123", good_build("DIFFERENT"))
    assert clash.status_code == 409
    assert "error" in clash.json()

    # And the refusal is not cosmetic: the published build is untouched, which is
    # the entire justification for the one-year immutable cache on it.
    stored = (hub.project_dir("proj1") / "abc123" / "assembled.json").read_bytes()
    assert stored == view_bytes("a")


def test_missing_token_is_401(hub):
    r = hub.publish("proj1", "abc123", good_build(), token=None)
    assert r.status_code == 401
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_wrong_token_is_401(hub):
    r = hub.publish("proj1", "abc123", good_build(), token="not-the-token")
    assert r.status_code == 401
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_token_prefix_is_not_accepted(hub):
    # A prefix of the real token must fail exactly like garbage does. This is what
    # would break if compare_digest were replaced by a `startswith`-ish check.
    r = hub.publish("proj1", "abc123", good_build(), token="test-publish-toke")
    assert r.status_code == 401


def test_oversized_body_is_413(hub_factory):
    small = hub_factory(max_build_bytes=2048)
    # Incompressible payload, so the COMPRESSED body really does exceed the cap.
    r = small.publish("proj1", "abc123", good_build(
        extra_files={"model.stl": os.urandom(8192)}))
    assert r.status_code == 413
    assert not (small.project_dir("proj1") / "abc123").exists()


def test_a_dribbling_client_cannot_hold_a_publish_slot(hub, monkeypatch):
    """The body has a deadline of its own, not just a gap-between-packets one.

    `HubHandler.timeout` is a SOCKET timeout: it is rearmed by every packet, so a
    client sending one byte every 29 seconds never trips it. Four of those own
    every one of MAX_CONCURRENT_PUBLISHES and CI gets 503s until somebody
    restarts the container — for the price of four sockets and no bandwidth.

    Driven from a raw socket because that is the only way to be a bad client:
    httpx sends a body as fast as it can, which is exactly what this is not.
    """
    monkeypatch.setattr(app, "BODY_DEADLINE_SECONDS", 0.5)
    host, port = hub.server.server_address[:2]
    with socket.create_connection((host, port), timeout=30) as sock:
        sock.sendall(
            b"POST /api/v1/publish/proj1/abc123 HTTP/1.1\r\n"
            b"Host: hub\r\n"
            b"Authorization: Bearer " + TOKEN.encode() + b"\r\n"
            b"Content-Length: 100000\r\n"
            b"\r\n")
        # One byte at a time, slowly, and never anywhere near the declared length.
        deadline = time.monotonic() + 10
        reply = b""
        while time.monotonic() < deadline:
            try:
                sock.sendall(b"\0")
            except OSError:
                break  # the hub hung up on us, which is the point
            time.sleep(0.1)
            sock.settimeout(0.1)
            try:
                chunk = sock.recv(4096)
            except (TimeoutError, OSError):
                continue
            if not chunk:
                break
            reply += chunk
            break

    assert reply.startswith(b"HTTP/1.1 408"), reply[:200]
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_broken_meta_json_is_422(hub):
    body = tar_gz({"meta.json": b"{not json", "assembled.json": view_bytes()})
    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_missing_meta_json_is_422(hub):
    r = hub.publish("proj1", "abc123", tar_gz({"assembled.json": view_bytes()}))
    assert r.status_code == 422


def test_view_pointing_at_a_missing_file_is_422(hub):
    body = tar_gz({
        "meta.json": meta_bytes(views=[
            {"id": "assembled", "file": "nowhere.json", "parts": 1}]),
        "assembled.json": view_bytes(),
    })
    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422
    assert "nowhere.json" in r.json()["error"]
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_download_pointing_at_a_missing_file_is_422(hub):
    body = tar_gz({
        "meta.json": meta_bytes(downloads={"stl": "absent.stl"}),
        "assembled.json": view_bytes(),
    })
    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422
    assert "absent.stl" in r.json()["error"]


def test_no_views_is_422(hub):
    body = tar_gz({"meta.json": meta_bytes(views=[]),
                   "assembled.json": view_bytes()})
    assert hub.publish("proj1", "abc123", body).status_code == 422


def test_body_that_is_not_a_gzipped_tar_is_422(hub):
    assert hub.publish("proj1", "abc123", b"just some bytes").status_code == 422


# -- the route where the HUB names the revision ------------------------------
# `POST /api/v1/publish/<pid>`, with no id in the URL at all. Everything below
# is about the one thing that route adds: the name, where it comes from, and
# what follows from it being the content rather than a counter.
def test_a_push_with_no_name_is_published_under_its_payload_digest(hub):
    reply = hub.publish_async("proj1", None, good_build())
    assert reply.status_code == 202

    revision = reply.json()["revision"]
    assert len(revision) == 64
    assert hub.await_job(reply.json()["job"]).status_code == 201

    build = hub.project_dir("proj1") / revision
    # The name IS the digest, so the build carries its own name in the file the
    # store compares pushes with. Nothing has to be remembered anywhere else.
    assert (build / ".payload.sha256").read_text().strip() == revision
    assert hub.get(f"/project/proj1/{revision}/").status_code == 200


def test_the_minted_name_reaches_the_job_record_too(hub):
    """The 202 and the job agree about which revision this build publishes —
    the pusher can get it from either, and neither is the JOB id."""
    reply = hub.publish_async("proj1", None, good_build())
    payload = reply.json()
    record = hub.await_job(payload["job"]).record

    assert record["commit"] == payload["revision"]
    assert record["commit"] != payload["job"]
    assert record["build_url"] == f"/project/proj1/{payload['revision']}/"


def test_the_same_sources_mint_the_same_revision(hub):
    """Idempotence and identity are the same fact here: an unchanged tree
    cannot be given a second address, so the retry is 200 and there is exactly
    one directory.

    And the two archives are built SEPARATELY, so their member order and their
    mtimes differ — which is the property the address depends on. The digest is
    over `{path: sha256 of content}` sorted by path, so nothing about the
    machine that packed the tree reaches the name; two laptops publishing the
    same sources land on the same URL."""
    first = hub.publish_async("proj1", None, good_build())
    assert hub.await_job(first.json()["job"]).status_code == 201

    again = hub.publish_async("proj1", None, good_build())
    assert again.status_code == 200
    assert again.json()["revision"] == first.json()["revision"]
    assert again.json()["url"] == f"/project/proj1/{first.json()['revision']}/"

    builds = [entry.name for entry in (hub.project_dir("proj1")).iterdir()
              if entry.is_dir() and not entry.is_symlink()]
    assert builds == [first.json()["revision"]]


def test_different_sources_mint_a_different_revision(hub):
    one = hub.publish_async("proj1", None, good_build("a"))
    two = hub.publish_async("proj1", None, good_build("DIFFERENT"))
    assert one.json()["revision"] != two.json()["revision"]

    assert hub.await_job(one.json()["job"]).status_code == 201
    assert hub.await_job(two.json()["job"]).status_code == 201
    # Two names, so the 409 that answers "this name, other content" on the
    # NAMED route cannot arise here: different content is a different address.
    assert os.readlink(hub.project_dir("proj1") / "latest") in (
        one.json()["revision"], two.json()["revision"])


def test_a_minted_revision_is_served_immutable_like_any_other(hub):
    reply = hub.publish_async("proj1", None, good_build())
    revision = reply.json()["revision"]
    hub.await_job(reply.json()["job"])

    served = hub.get(f"/project/proj1/{revision}/assembled.json")
    assert served.status_code == 200
    assert "immutable" in served.headers["Cache-Control"]


def test_the_named_route_still_answers_and_reports_no_revision(hub):
    """A caller that brings its own id gets the reply it always got — no
    `revision` key, because it is not the hub that chose the name."""
    reply = hub.publish_async("proj1", "abc123", good_build())
    assert reply.status_code == 202
    assert "revision" not in reply.json()


def test_the_minting_route_refuses_a_bad_project_id(hub):
    assert hub.publish_async("proj1%0A", None, good_build()).status_code == 422


def test_the_minting_route_needs_the_token(hub):
    r = hub.publish_async("proj1", None, good_build(), token=None)
    assert r.status_code == 401


def test_the_local_slot_is_still_a_named_route(hub):
    """`dev` did not move. It is a name like any other in the URL, and the hub
    does not mint anything for it (SPEC 7.6)."""
    reply = hub.publish_async("proj1", "dev", good_build())
    assert reply.status_code == 202
    assert "revision" not in reply.json()
    assert hub.await_job(reply.json()["job"]).status_code == 201
    assert (hub.project_dir("proj1") / "dev" / "meta.json").is_file()
    assert not (hub.project_dir("proj1") / "latest").exists()


def test_reserved_commit_name_is_refused(hub):
    # `latest` is the symlink. A build allowed to take that name would either
    # collide with it or replace it, and /latest/ would stop tracking anything.
    assert hub.publish("proj1", "latest", good_build()).status_code == 422


def test_a_trailing_newline_in_the_pid_is_refused(hub):
    # `$` in a Python regexp also matches just before a trailing newline, so
    # `^[A-Za-z0-9_-]+$` accepts "proj1\n". That would create a directory whose
    # name contains a newline and put a bare LF into the `Location` header — a
    # response-splitting primitive handed over by an anchor character.
    r = hub.publish("proj1%0A", "abc123", good_build())
    assert r.status_code == 422
    assert [p.name for p in hub.store.projects_dir.iterdir()] == []


def test_a_trailing_newline_in_the_commit_is_refused(hub):
    r = hub.publish("proj1", "abc123%0A", good_build())
    assert r.status_code == 422
    assert not any("\n" in p.name for p in hub.store.projects_dir.rglob("*"))


def test_a_control_character_in_the_title_is_refused(hub):
    body = tar_gz({"meta.json": meta_bytes(title="Demo\nX-Injected: yes"),
                   "assembled.json": view_bytes()})
    assert hub.publish("proj1", "abc123", body).status_code == 422


def test_an_over_long_title_is_refused(hub):
    body = tar_gz({"meta.json": meta_bytes(title="x" * 500),
                   "assembled.json": view_bytes()})
    assert hub.publish("proj1", "abc123", body).status_code == 422


def test_an_over_long_built_is_refused(hub):
    # `built` is displayed exactly like `title` — index card, page header, and the
    # <option> caption in the picker — but it also goes into the SHARED
    # /index.json, which everyone who opens `/` downloads with no-cache. A single
    # project pushing half a megabyte of `built` degrades the index for everyone,
    # so it is capped on the way in like every other displayed string.
    body = tar_gz({"meta.json": meta_bytes(built="B" * 500_000),
                   "assembled.json": view_bytes()})
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert not (hub.store.root / "index.json").exists()


def test_a_bidi_override_in_built_is_refused(hub):
    # U+202E RIGHT-TO-LEFT OVERRIDE is category Cf, and textContent renders it
    # faithfully: it reverses the text AFTER it, i.e. the neighbouring fields of
    # the card, not just the value it was smuggled into. Escaping does not help
    # here, refusing does.
    body = tar_gz({"meta.json": meta_bytes(built="‮evil"),
                   "assembled.json": view_bytes()})
    assert hub.publish("proj1", "abc123", body).status_code == 422


def test_a_valid_built_still_publishes(hub):
    # The guard rail above must not have closed the ordinary path: the timestamp
    # CI actually sends has to survive it unchanged.
    assert hub.publish("proj1", "abc123", good_build()).status_code == 201
    meta = json.loads((hub.project_dir("proj1") / "abc123" / "meta.json")
                      .read_text(encoding="utf-8"))
    assert meta["built"] == "2026-08-21T04:16:00Z"


# -- what is INSIDE a view file ---------------------------------------------
# The archive's member names are whitelisted and meta.json is validated field by
# field, but the view file itself is handed to `viewer.render()` byte for byte.
# The vendored library builds its part tree with `label.innerHTML = node.name`
# and appends `<span style="color:${color}">`, so those two fields are markup on
# a permanent, immutable, same-origin URL unless they are refused here.
def _view(parts, **root):
    payload = {"version": 3, "name": "root", "parts": parts}
    payload.update(root)
    return json.dumps(payload).encode("utf-8")


def _publish_view(hub, view):
    body = tar_gz({"meta.json": meta_bytes(), "assembled.json": view})
    return hub.publish("proj1", "abc123", body)


def test_markup_in_a_part_name_is_refused(hub):
    view = _view([{"name": "<img src=x onerror=alert(document.domain)>"}])
    assert _publish_view(hub, view).status_code == 422
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_markup_in_a_part_name_is_refused_at_any_depth(hub):
    # The walk has to be recursive: an assembly nests, and a check that only
    # looked at the top level would be worth nothing to anyone who indents.
    view = _view([{"name": "sub", "parts": [
        {"name": "deep", "parts": [{"name": "<script>alert(1)</script>"}]}]}])
    assert _publish_view(hub, view).status_code == 422


def test_a_hostile_part_colour_is_refused(hub):
    # The colour is interpolated into a style attribute with no escaping at all,
    # so anything carrying a quote, an angle bracket or a semicolon is out.
    for color in ('red;" onmouseover="alert(1)', "url(javascript:alert(1))",
                  "#ff0000<script>", ["#00ff00", "\" onload=\"alert(1)"]):
        r = _publish_view(hub, _view([{"name": "part", "color": color}]))
        assert r.status_code == 422, color


def test_a_view_that_is_not_json_is_refused(hub):
    # 422, not a 500: a truncated export is a client-side mistake and CI has to
    # be told which file was wrong.
    r = _publish_view(hub, b"{\"parts\": [")
    assert r.status_code == 422
    assert "assembled" in r.json()["error"]


def _nested_view(depth: int) -> bytes:
    # Built as text, not with json.dumps: the encoder is recursive too and would
    # blow the stack in the test before the hub ever saw the file.
    return (b'{"name":"n","parts":[' * depth + b'{"name":"leaf"}'
            + b']}' * depth)


def test_a_view_nested_past_the_ceiling_is_refused(hub):
    # Deeper than any assembly, shallow enough that the JSON parser is happy —
    # so this is the walk's own ceiling doing the work.
    r = _publish_view(hub, _nested_view(200))
    assert r.status_code == 422, r.text
    assert r.json()["error"] != "internal error"


def test_a_view_nested_past_the_parsers_limit_is_refused(hub):
    # Deep enough that json itself gives up with a RecursionError, which is not a
    # ValueError and would otherwise have come back as a 500 with a stack trace.
    r = _publish_view(hub, _nested_view(200_000))
    assert r.status_code == 422, r.text
    assert "not valid JSON" in r.json()["error"], r.text


def test_ordinary_part_names_and_colours_still_publish(hub):
    # The guard rail must leave a real export alone: nested groups, hex colours,
    # the per-segment colour list edges carry, and a non-English part name.
    view = _view([
        {"name": "корпус", "color": "#e8b024"},
        {"name": "cover", "color": "steelblue", "parts": [
            {"name": "screw", "color": "#abc"},
            {"name": "edges", "color": ["#ff0000", "#00ff00"]},
        ]},
    ])
    assert _publish_view(hub, view).status_code == 201


def test_markup_in_a_download_label_is_refused(hub):
    # The label becomes a button caption. The page builds it with textContent, so
    # this is the second line of defence rather than the only one — but a label is
    # a short token by nature and there is no reason to accept anything else.
    body = tar_gz({
        "meta.json": meta_bytes(
            downloads={"<script>alert(1)</script>": "model.stl"}),
        "assembled.json": view_bytes(),
        "model.stl": b"solid demo",
    })
    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_view_pointing_at_a_generated_file_is_refused(hub):
    # meta.json and index.html are rewritten by the hub AFTER this validation, so
    # a view aiming at one would be measured against the upload and then served
    # as ours.
    for name in ("meta.json", "index.html"):
        body = tar_gz({
            "meta.json": meta_bytes(views=[
                {"id": "assembled", "file": name, "parts": 1}]),
            "assembled.json": view_bytes(),
            "index.html": b"<p>hi</p>",
        })
        r = hub.publish("proj1", "abc123", body)
        assert r.status_code == 422, name


def test_a_download_pointing_at_a_generated_file_is_refused(hub):
    body = tar_gz({"meta.json": meta_bytes(downloads={"meta": "meta.json"}),
                   "assembled.json": view_bytes()})
    assert hub.publish("proj1", "abc123", body).status_code == 422


@pytest.mark.parametrize("field", ("overview", "previews"))
def test_a_whole_build_map_pointing_at_a_missing_file_is_422(hub, field):
    """The same question `downloads` is asked, on the two maps that grew later.

    These carry no button, so nothing on either page would go visibly wrong —
    which is exactly why the check has to be here rather than left to the
    browser: the client fetches every name in them, and a name the archive never
    carried turns `hammerola artifacts` into a refusal against a build the hub
    accepted.
    """
    body = tar_gz({
        "meta.json": meta_bytes(**{field: {"assembled": "absent.stl"}}),
        "assembled.json": view_bytes(),
    })
    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422
    assert "absent.stl" in r.json()["error"]
    assert not (hub.project_dir("proj1") / "abc123").exists()


@pytest.mark.parametrize("field", ("overview", "previews"))
def test_markup_in_a_whole_build_stem_is_refused(hub, field):
    """The key is a part name, and a part name reaches the viewer's innerHTML.

    Nothing renders these two maps TODAY, and that is the argument for checking
    them rather than against it: the reader they exist for is the one that has
    not been written (a project card, a picture on a tree row), and it will look
    the stem up against the part names it already draws.
    """
    body = tar_gz({
        "meta.json": meta_bytes(
            **{field: {"<script>alert(1)</script>": "model.stl"}}),
        "assembled.json": view_bytes(),
        "model.stl": b"solid demo",
    })
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert not (hub.project_dir("proj1") / "abc123").exists()


@pytest.mark.parametrize("field", ("downloads", "overview", "previews"))
@pytest.mark.parametrize("value", (0, [], ""))
def test_a_whole_build_map_that_is_not_an_object_is_refused(hub, field, value):
    """`0` is not "no pictures", and reading it as one would publish in silence.

    Every one of these fields is read with an explicit `is None` for this:
    `raw.get(field) or {}` swallows every falsy non-object, so a push that
    described something entirely different would be accepted and the difference
    would show up nowhere.

    `downloads` IS ON THIS LIST NOW, and it is the reason the parametrization
    grew: it was the map read with `or {}` — the spelling the docstring beside
    it called a defect — so `downloads: 0` published a build whose download
    buttons had silently vanished, which is the most visible of the three maps
    disappearing and the one nobody was told about.
    """
    body = tar_gz({"meta.json": meta_bytes(**{field: value}),
                   "assembled.json": view_bytes()})
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert not (hub.project_dir("proj1") / "abc123").exists()


@pytest.mark.parametrize("field", ("overview", "previews"))
def test_a_stem_longer_than_a_button_caption_still_publishes(hub, field):
    """The regression that decided the rule these keys are held to.

    A part name has a ceiling of its own and it is four times a caption's — 128
    characters on the build side (MEMBER_RE), MAX_TEXT here — which is what
    makes the difference reachable at all: the stem below is legal under both
    and refused by SAFE_LABEL. It is also a name that publishes TODAY, because
    on a single-printable build the download labels degenerate to bare
    `stl`/`step`/`3mf` with the name gone from them, so nothing about such a
    project ever met the caption rule. Holding the stem to SAFE_LABEL — the
    32-character rule for a button caption — would start refusing that project,
    with the picture of its own part as the reason, and no map on this document
    is a caption.
    """
    stem = "bracket_" + "x" * 40
    body = tar_gz({
        "meta.json": meta_bytes(**{field: {stem: "model.stl"}}),
        "assembled.json": view_bytes(),
        "model.stl": b"solid demo",
    })
    assert hub.publish("proj1", "abc123", body).status_code == 201
    meta = hub.get("/project/proj1/abc123/meta.json").json()
    assert meta[field] == {stem: "model.stl"}


# -- what a build file may be called ----------------------------------------
# One row per name, and the answer both sides have to give: does the hub serve
# `/project/<pid>/<commit>/<name>`? The file server asks it of every request
# (`app._safe_name`) and the declaration asks it of every name a push offers
# (`render._check_declared_file`), and for as long as those were two rules they
# disagreed. Nothing here is a name the hub GENERATES: those are served happily
# and may not be declared, which is the one question only one side asks.
SERVABLE_NAMES = (
    ("lid_preview.png", True),
    # 124 characters: over a caption's 32, under MEMBER_RE's 128, so a real
    # build can produce it and neither side may refuse it.
    ("a" * 120 + ".stl", True),
    (".lid_preview.png", False),
    # The hub's own bookkeeping beside a build, and the reason the dot rule is
    # not cosmetic: it is what tells a retry from a collision.
    (".payload.sha256", False),
    ("..", False),
    (".", False),
    ("", False),
    ("sub/lid_preview.png", False),
    # U+202E RIGHT-TO-LEFT OVERRIDE. `hammerola artifacts` prints this name and
    # then writes it to the author's disk.
    ("lid\u202egnp.png", False),
    ("lid\npreview.png", False),
)


def _view_declarable(name, files: dict, staging) -> bool:
    """Would `build_meta` accept a `views` entry pointing at `name`?

    THROUGH `build_meta` AND NOT THROUGH THE HELPER, which is the whole reason
    this walk is a third one rather than a second call to the same function.
    The `views` loop had a check inlined in it for as long as the shared rule
    existed beside it, and a test that asked `_check_declared_file` directly
    would have been perfectly green the entire time.

    AN OSError MEANS THE NAME WAS ACCEPTED, and saying so is what keeps a
    reverted rule visible here. `build_meta` opens exactly one file — the view
    the entry points at — and it opens it only AFTER `_check_declared_file`, which
    is pure. So a name this walk wrongly accepts runs on into `check_view_file`
    and dies on a file the table never wrote (`FileNotFoundError` for a name that
    could be one, `IsADirectoryError` for `.`, `..` and `""`), and that exception
    is evidence the name got past the rule rather than evidence it was refused.
    Reporting it as "refused" would agree with the table for the wrong reason and
    go green on precisely the regression this exists for; letting it escape would
    make the same case an ERROR rather than an assertion. It is neither: the
    answer is True, and the assertion below is what fails.
    """
    raw = json.loads(meta_bytes(
        views=[{"id": "assembled", "file": name, "parts": 1}]))
    try:
        render.build_meta("proj1", "abc123", raw, staging, files,
                          "2026-08-30T00:00:00Z")
    except ValueError:
        return False
    except OSError:
        pass
    return True


def test_the_file_server_and_a_push_agree_on_what_a_build_file_may_be_called(
        tmp_path):
    """Three doors onto one rule, over a table of names, with the answers pinned.

    THE DEFECT THIS EXISTS FOR IS SILENT (issue #53): the declaration took a
    leading dot and the file server refuses one, so a build declaring
    `.lid_preview.png` published with a 201 into an immutable directory under a
    year of cache and answered 404 for every GET of a file it had named — a
    build accepted and impossible to open, from a push that can never be taken
    back. Neither side was wrong on its own; they were two copies of one rule.

    So the rule moved into `buildnames.unservable_reason` and this compares its
    CALLERS rather than the function — a re-inlined copy goes red here — and it
    compares each of them against the expected answer as well, so weakening the
    shared rule cannot leave the callers agreeing about the wrong thing. There
    are THREE of them now: the file server, the declaration helper the three
    file-declaring maps go through, and `views`, which kept a check of its own
    until the review of #53 and so had neither the dot clause nor the
    non-printable one — on the one map without which a build page draws nothing.
    """
    # Every row is in `files`, so the membership question — the one thing
    # `_check_declared_file` asks that the server does not — never fires and
    # what is left is exactly the shared rule.
    files = {name: "digest" for name, _ in SERVABLE_NAMES}
    # `build_meta` measures the view file it accepts, so the servable rows have
    # to be real files. The refused ones are refused before anything is opened.
    staging = tmp_path / "staging"
    staging.mkdir()
    for name, servable in SERVABLE_NAMES:
        if servable:
            (staging / name).write_bytes(view_bytes())
    for name, servable in SERVABLE_NAMES:
        assert app._safe_name(name) is servable, f"the file server on {name!r}"
        try:
            render._check_declared_file(name, files, "`previews` entry 'lid'")
            declarable = True
        except ValueError:
            declarable = False
        assert declarable is servable, f"the declaration on {name!r}"
        assert _view_declarable(name, files, staging) is servable, (
            f"the `views` declaration on {name!r}")


def _built(store, pid, commit, meta_json, extra=(),
           extra_bytes=b"\x89PNG\r\n\x1a\n"):
    """A finished build's output in staging, as the build process leaves it.

    THE BUILD PATH AND NOT THE ARCHIVE PATH, which is the whole reason the two
    tests below are written this way rather than as a push. An archive member
    has to match SAFE_COMPONENT, so an upload cannot carry a name with a leading
    dot at all and a declaration of one would be refused for not being in the
    archive — the right answer for the wrong reason, and a test that stays green
    with the rule deleted. A BUILD writes its own output directory and nothing
    applies an alphabet to a name in it: `runner._verify_output_file` checks the
    path shape, the symlinks and that the file exists, and the names themselves
    are chosen by model code (src/buildproc/child.py). This is the door those
    names come through, so this is the door they are refused at.

    `extra_bytes` IS THERE SO THE FAILURE STAYS ON THE NAME. The default is PNG
    magic, which is what a `previews` entry really points at; a `views` entry
    points at a view file, and PNG bytes there are refused for being undecodable
    JSON — by `check_view_file`, which runs AFTER the name rule. So the test
    below passed while asking nothing about the name, and would have gone red on
    a reverted rule with `'utf-8' codec can't decode byte 0x89` as its whole
    explanation. Handing that caller real view JSON is what makes the name the
    only thing left for the push to be refused over.
    """
    staging = store.build_staging(pid, commit)
    staging.mkdir()
    (staging / "meta.json").write_bytes(meta_json)
    (staging / "assembled.json").write_bytes(view_bytes())
    names = ["meta.json", "assembled.json"]
    for name in extra:
        (staging / name).write_bytes(extra_bytes)
        names.append(name)
    return staging, tuple(names)


@pytest.mark.parametrize("name", (".lid_preview.png", "lid\u202egnp.png"))
def test_a_build_declaring_a_file_the_hub_cannot_serve_is_refused(tmp_path, name):
    """The file is really there, really hashed — and would 404 or lie in a report.

    Both names below are files this build genuinely wrote and genuinely
    declared, so every check up to here passes: they are inside the output
    directory, in normal form, no symlink, regular files, and keys of the output
    hash. What they are not is names this service can hand back. The dotted one
    404s on every GET under a permanent URL; the other one carries U+202E, so
    the line `hammerola artifacts` prints while writing it to the author's disk
    reads backwards from the point the override lands.
    """
    store = Store(data_dir=tmp_path / "data", max_build_bytes=8 * 1024 * 1024)
    staging, names = _built(store, "proj1", "abc123",
                            meta_bytes(previews={"lid": name}), extra=(name,))

    with pytest.raises(PublishError) as refused:
        store.publish_built("proj1", "abc123", staging, names, "digest-a")

    assert refused.value.status == 422
    # NAMED, and named through `!r`: this message is what the pusher reads, so
    # an unprintable in it has to arrive escaped rather than reversing the line
    # that reports it.
    assert repr(name) in str(refused.value)
    # Refused BEFORE the rename, so there is no build at the permanent URL —
    # which is the whole point: a 201 here could never be taken back.
    assert not (store.projects_dir / "proj1" / "abc123").exists()


@pytest.mark.parametrize("name", (".assembled.json", "assembled\u202enosj.json"))
def test_a_build_declaring_a_view_the_hub_cannot_serve_is_refused(tmp_path, name):
    """The same two names, on the map whose loss empties the page.

    `views` is the map the viewer reads: a build whose only view 404s shows
    nothing at all, so this is the most expensive place for the declaration and
    the file server to disagree — and it is exactly where they still did after
    the rule was shared, because this loop kept an inline check that asked
    membership, `/` and the generated names and neither of the other two
    clauses.

    Through the BUILD path for the reason `_built` gives: an archive member
    cannot carry either of these names, so a push-based test would go green on
    the membership question and stay green with the rule deleted.

    AND THE FILE IS A REAL VIEW, for the reason `_built`'s `extra_bytes`
    explains: this member is the one `check_view_file` opens, so anything that
    is not view JSON refuses the push one step past the name rule and answers
    this test's question by accident.
    """
    store = Store(data_dir=tmp_path / "data", max_build_bytes=8 * 1024 * 1024)
    meta = meta_bytes(views=[{"id": "assembled", "file": name, "parts": 1}])
    staging, names = _built(store, "proj1", "abc123", meta, extra=(name,),
                            extra_bytes=view_bytes())

    with pytest.raises(PublishError) as refused:
        store.publish_built("proj1", "abc123", staging, names, "digest-a")

    assert refused.value.status == 422
    assert repr(name) in str(refused.value)
    assert not (store.projects_dir / "proj1" / "abc123").exists()


def test_more_views_than_the_build_has_files_is_refused(hub):
    """The ceiling the three maps had and the list did not — the expensive one.

    An entry here is not a dict lookup: it is a full parse of the view file
    (`check_view_file`) and a full gzip of it (`measure_view`), and nothing says
    N entries may not point at ONE file — `seen` forbids a repeated view id, not
    a repeated file name. Measured on a 0.9 MB view: ~18 ms per entry, so a
    hundred thousand of them is hours of CPU inside `_finish_staging`, in one of
    the two build worker threads this process has, with the queue behind it
    stopped for as long as it runs.

    Bracketed on both sides, like the map ceiling above: a list that names every
    file the build published sits AT the bound and has to publish, so a `>=`
    written where `>` belongs fails here.
    """
    def archive(count):
        return tar_gz({
            "meta.json": meta_bytes(views=[
                {"id": f"v{i}", "file": "assembled.json", "parts": 1}
                for i in range(count)]),
            "assembled.json": view_bytes(),
            "model.stl": b"solid demo",
        })

    # Three members in the archive, so three views is the ceiling itself.
    assert hub.publish("proj1", "abc123", archive(3)).status_code == 201
    r = hub.publish("proj1", "def456", archive(4))
    assert r.status_code == 422
    assert "entries" in r.json()["error"], r.text
    assert not (hub.project_dir("proj1") / "def456").exists()


@pytest.mark.parametrize("field", ("downloads", "overview", "previews"))
def test_a_map_carrying_more_entries_than_the_build_has_files_is_refused(
        hub, field):
    """Every entry legal, in numbers no build produces: the `notes` failure again.

    A hundred thousand entries each pointing at one real file pass every
    per-entry check there is and make a `meta.json` that every visitor of that
    build downloads, under a year of `immutable`, from a push that cannot be
    taken back — the scenario `MAX_NOTES` is written against, on the three maps
    beside it. The bound is the build's OWN file count, so the first half here
    matters as much as the second: a map that names every file the build
    published sits AT the ceiling and has to publish.
    """
    prefix = "stl" if field == "downloads" else "part"

    def archive(count):
        return tar_gz({
            "meta.json": meta_bytes(
                **{field: {f"{prefix}{i}": "model.stl" for i in range(count)}}),
            "assembled.json": view_bytes(),
            "model.stl": b"solid demo",
        })

    # Three members in the archive, so three entries is the ceiling itself.
    assert hub.publish("proj1", "abc123", archive(3)).status_code == 201
    r = hub.publish("proj1", "def456", archive(4))
    assert r.status_code == 422
    assert "entries" in r.json()["error"], r.text
    assert not (hub.project_dir("proj1") / "def456").exists()


def test_traversal_in_the_url_never_reaches_the_store(hub):
    # pid and commit come from the URL, so they are attacker-controlled too.
    r = hub.publish("..", "abc123", good_build())
    assert r.status_code in (404, 422)
    assert not (hub.data.parent / "abc123").exists()


def test_a_refused_push_leaves_no_staging_directory(hub):
    hub.publish("proj1", "abc123", tar_gz({"meta.json": b"{bad"}))
    leftovers = [p for p in hub.project_dir("proj1").iterdir()
                 if p.name.startswith(".tmp-")]
    assert leftovers == []


def test_second_build_moves_latest_and_keeps_the_old_one(hub):
    hub.publish("proj1", "aaa111", good_build("first"))
    body = tar_gz({
        "meta.json": meta_bytes(built="2026-08-22T10:00:00Z"),
        "assembled.json": view_bytes("second"),
    })
    assert hub.publish("proj1", "bbb222", body).status_code == 201

    assert os.readlink(hub.project_dir("proj1") / "latest") == "bbb222"
    # The old commit stays reachable and unchanged — that is the promise the URL
    # scheme makes (SPEC 1, scenario B).
    old = hub.project_dir("proj1") / "aaa111" / "assembled.json"
    assert old.read_bytes() == view_bytes("first")

    builds = json.loads((hub.project_dir("proj1") / "builds.json").read_text())
    assert [b["commit"] for b in builds["builds"]] == ["bbb222", "aaa111"]


def test_latest_follows_built_not_arrival_order(hub):
    # `latest` and the build picker order by `built`, so a build that arrives
    # late but is OLDER must not steal `latest`.
    hub.publish("proj1", "newer", tar_gz({
        "meta.json": meta_bytes(built="2026-08-22T10:00:00Z"),
        "assembled.json": view_bytes("newer")}))
    hub.publish("proj1", "older", tar_gz({
        "meta.json": meta_bytes(built="2026-08-01T10:00:00Z"),
        "assembled.json": view_bytes("older")}))
    assert os.readlink(hub.project_dir("proj1") / "latest") == "newer"
