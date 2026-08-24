"""The publish protocol: SPEC 7 status codes, atomicity and immutability."""

import json
import os
import socket
import time

from harness import TOKEN, good_build, meta_bytes, tar_gz, view_bytes

from src import app


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
    # /index.json, which every visitor of `/` downloads with no-cache. A single
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
    # Retention and the build picker order by `built` (SPEC 7.3), so a build that
    # arrives late but is OLDER must not steal `latest`.
    hub.publish("proj1", "newer", tar_gz({
        "meta.json": meta_bytes(built="2026-08-22T10:00:00Z"),
        "assembled.json": view_bytes("newer")}))
    hub.publish("proj1", "older", tar_gz({
        "meta.json": meta_bytes(built="2026-08-01T10:00:00Z"),
        "assembled.json": view_bytes("older")}))
    assert os.readlink(hub.project_dir("proj1") / "latest") == "newer"
