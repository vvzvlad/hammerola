"""The publish protocol: SPEC 7 status codes, atomicity and immutability."""

import inspect
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
    hub.publish("proj1", "abc123", good_build(
        parts={"lid": {"kind": "printable", "files": {"stl": "model.stl"}}},
        views=[{"id": "assembled", "name": "assembled",
                "file": "assembled.json", "parts": ["lid"]}],
        view_keys=("lid",),
        extra_files={"model.stl": b"solid"}))
    meta = json.loads((hub.project_dir("proj1") / "abc123" / "meta.json").read_text())

    # `views` STAYS `views` (issue #75). It used to be renamed to `variants` on
    # the way through, and the rename is gone rather than moved: the browser is
    # the only reader, one word is what the author wrote, and a second word for
    # it made every question about a view ("which name does this side use?") a
    # lookup. The sizes are still measured here rather than trusted.
    assert [v["id"] for v in meta["views"]] == ["assembled"]
    view = meta["views"][0]
    assert view["bytes"] == len(view_bytes("a", keys=("lid",)))
    assert view["gzip"] > 0
    assert meta["commit"] == "abc123"
    assert meta["pid"] == "proj1"
    # A file a build exported hangs off the PART it belongs to, not off a flat
    # map keyed by extension: that map could name one `.stl` for a build with
    # eleven printables, which is how a whole-build `downloads` came to mean
    # something no build could write.
    assert meta["parts"]["lid"] == {"kind": "printable",
                                    "files": {"stl": "model.stl"}}
    assert view["parts"] == ["lid"]


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


# -- every place this document names a file ----------------------------------
# There are FIVE and they are enumerated here once. The old document had three
# flat maps of file pointers (`downloads`, `overview`, `previews`) beside
# `views[].file`, and issue #75 moved every pointer next to the thing it is
# about: a view names its own file, its overview and its picture, and a part
# names what it was exported to and its own picture.
#
# ONE LIST FOR EVERY TEST BELOW, rather than a parametrize per test, because a
# pointer that quietly stops being checked is a 404 under an immutable URL a
# year of cache is served for — and a per-test list is one that goes stale an
# entry at a time, silently, exactly like the four inline copies of the name
# rule that issue #53 was about.
FILE_POINTERS = ("view file", "view overview", "view preview",
                 "part files", "part preview")


def _pointing_at(where, name):
    """meta.json fields naming `name` in one of the five places, and nowhere else.

    Returns kwargs for `meta_bytes`, so the document around the pointer is the
    ordinary one — a catalogue of one printable and a view that selects it.
    """
    view = {"id": "assembled", "name": "assembled",
            "file": "assembled.json", "parts": ["lid"]}
    part = {"kind": "printable"}
    if where == "view file":
        view["file"] = name
    elif where == "view overview":
        view["overview"] = name
    elif where == "view preview":
        view["preview"] = name
    elif where == "part files":
        part["files"] = {"stl": name}
    elif where == "part preview":
        part["preview"] = name
    else:
        raise AssertionError(f"no such file pointer: {where!r}")
    return {"views": [view], "parts": {"lid": part}}


def test_the_five_file_pointers_are_the_five_the_document_has():
    """The list above, checked against the document rather than trusted.

    `_pointing_at` refuses a name it does not know, so a sixth pointer added to
    `build_meta` without a row here would be checked by nothing below and this
    would not notice — the list has to be compared against something. What it is
    compared against is the number of places `build_meta` calls the shared name
    rule, which is the one thing every pointer has in common.
    """
    source = inspect.getsource(render)
    assert source.count("_check_declared_file(") == len(FILE_POINTERS) + 1, (
        "render.py names `_check_declared_file` a different number of times "
        "than FILE_POINTERS has entries (+1 for the definition). A file "
        "pointer was added or removed; give it a row in `_pointing_at`.")


def test_view_pointing_at_a_missing_file_is_422(hub):
    body = tar_gz({
        "meta.json": meta_bytes(views=[
            {"id": "assembled", "file": "nowhere.json", "parts": ["lid"]}]),
        "assembled.json": view_bytes(),
    })
    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422
    assert "nowhere.json" in r.json()["error"]
    assert not (hub.project_dir("proj1") / "abc123").exists()


@pytest.mark.parametrize("where", FILE_POINTERS)
def test_a_pointer_at_a_missing_file_is_422(hub, where):
    """A name the archive never carried, in every place a name can be written.

    The two pictures carry no button and nothing on either page would go
    visibly wrong, which is exactly why the check has to be here rather than
    left to the browser: the client fetches every name in the document, so a
    name the archive never carried turns `hammerola artifacts` into a refusal
    against a build the hub accepted.
    """
    body = tar_gz({
        "meta.json": meta_bytes(**_pointing_at(where, "absent.stl")),
        # The one-part catalogue `_pointing_at` builds, named in the view file
        # too: the pointer is what this is about, so the two halves of the
        # document have to agree about the parts or the 422 is about them
        # instead.
        "assembled.json": view_bytes(keys=("lid",)),
    })
    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, where
    assert "absent.stl" in r.json()["error"], where
    assert not (hub.project_dir("proj1") / "abc123").exists()


# -- what a view SELECTS out of the catalogue --------------------------------
# `views[].parts` used to be a COUNT and is a list of catalogue keys now
# (issue #75). The count was a fact about the view FILE that no reader could
# reconcile with anything else — five pins are five references to one record, so
# it disagreed with the map beside it — and answering "what is in this tab"
# meant fetching a multi-megabyte view file.


def _selecting(refs):
    """A document whose one view selects `refs` out of the standard catalogue."""
    return meta_bytes(views=[{"id": "assembled", "name": "assembled",
                              "file": "assembled.json", "parts": refs}])


def _refuse_selection(hub, refs, commit="abc123"):
    body = tar_gz({"meta.json": _selecting(refs),
                   "assembled.json": view_bytes()})
    r = hub.publish("proj1", commit, body)
    assert r.status_code == 422, r.text
    assert not (hub.project_dir("proj1") / commit).exists()
    return r.json()["error"]


@pytest.mark.parametrize("refs", (2, "lid", {"lid": 1}, None))
def test_a_view_whose_parts_are_not_a_list_is_refused(hub, refs):
    """`2` is the shape this field had until issue #75, and it must not linger.

    A hub that read the old number as "two parts" would publish a build whose
    views claim to show parts nothing can name — and a client asking what is in
    a tab gets an integer where it expects keys, which is the failure mode of
    every silent format change. Refusing is what makes the change visible on the
    push that still writes the old shape.
    """
    assert "catalogue keys" in _refuse_selection(hub, refs), refs


def test_a_view_naming_a_part_the_catalogue_does_not_declare_is_refused(hub):
    assert "does not declare" in _refuse_selection(hub, ["lid", "ghost"])


def test_a_view_naming_the_same_part_twice_is_refused(hub):
    """The list says WHICH parts a view shows, not how many times each appears.

    Refused rather than deduplicated, because deduplicating would make the hub
    the author of a document that disagrees with the file it was handed — and
    because the repeat is what makes the ceiling below exact.
    """
    assert "twice" in _refuse_selection(hub, ["lid", "lid"])


def test_a_view_naming_more_parts_than_the_catalogue_holds_is_refused(hub):
    """The ceiling, and it is DERIVED rather than invented.

    Every entry has to be a distinct key of the catalogue, so a legal list can
    never be longer than the catalogue — which makes the catalogue's own size the
    exact bound, with no second number to keep in step with anything. It is
    counted BEFORE the walk for the reason every ceiling on this document is:
    a list of a hundred thousand repeats would otherwise be refused one entry at
    a time, having already been read.

    Bracketed on both sides: the standard catalogue holds two parts and a view
    naming both has to publish, so a `>=` written where `>` belongs fails here.
    """
    error = _refuse_selection(hub, ["lid", "pin", "lid", "pin"])
    assert "more than the 2" in error, error
    body = tar_gz({"meta.json": _selecting(["lid", "pin"]),
                   "assembled.json": view_bytes()})
    assert hub.publish("proj1", "def456", body).status_code == 201


def test_a_view_s_selection_reaches_the_reader_in_the_order_it_was_written(hub):
    """Order is the author's, and the hub copies rather than sorts it.

    The tree in the browser is read top to bottom, so the order parts are named
    in is a statement about the assembly. `list(refs)` rather than `refs` in
    `_view_parts` is what keeps the served document from sharing a list with the
    parsed upload, and this is what would notice a sort creeping in.
    """
    body = tar_gz({"meta.json": _selecting(["pin", "lid"]),
                   "assembled.json": view_bytes()})
    assert hub.publish("proj1", "abc123", body).status_code == 201
    meta = hub.get("/project/proj1/abc123/meta.json").json()
    assert meta["views"][0]["parts"] == ["pin", "lid"]


@pytest.mark.parametrize("kind", ("printable", "hardware", "mock"))
def test_every_kind_the_build_can_write_publishes(hub, kind):
    """The three words a record may use, held to the build's own list.

    `render.PART_KINDS` is a TRANSCRIPTION of `cadbuild.parts.KINDS` — the
    serving half may not import the build half — and the two are compared
    directly in tests/cadbuild/test_naming.py. This is the other witness: that
    each word really survives a push, rather than only appearing in a tuple.
    """
    body = tar_gz({
        "meta.json": meta_bytes(
            parts={"lid": {"kind": kind}},
            views=[{"id": "assembled", "name": "assembled",
                    "file": "assembled.json", "parts": ["lid"]}]),
        "assembled.json": view_bytes(keys=("lid",))})
    assert hub.publish("proj1", "abc123", body).status_code == 201
    meta = hub.get("/project/proj1/abc123/meta.json").json()
    assert meta["parts"]["lid"]["kind"] == kind


@pytest.mark.parametrize("kind", ("printed", "PRINTABLE", "", None, 3, ["mock"]))
def test_a_kind_the_hub_does_not_know_is_refused(hub, kind):
    """Refused, not dropped, and that is the decision worth writing down.

    "Render what you know and ignore the rest" would let a push choose which
    parts a reader never sees: `kind` is how the browser decides whether to
    offer a download and how a part is painted, so a record with an unreadable
    one either vanishes from the page or shows up as something it is not. A
    misspelling is also the likeliest thing to go wrong here — `printed` for
    `printable` — and a refusal names it on the push instead of leaving an
    author to notice a missing button.
    """
    body = tar_gz({
        "meta.json": meta_bytes(
            parts={"lid": {"kind": kind}},
            views=[{"id": "assembled", "name": "assembled",
                    "file": "assembled.json", "parts": ["lid"]}]),
        "assembled.json": view_bytes()})
    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    assert "kind" in r.json()["error"], r.text
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_part_that_ships_nothing_may_not_declare_files(hub):
    """The two halves of such a record say different things, so neither is read.

    `kind` is what the browser reads to decide whether a download belongs under
    a part at all, so a bought screw carrying an STL is a record no reader can be
    right about: honour `kind` and the file is dead weight nobody can reach,
    honour `files` and the page offers to print a part that was bought.
    """
    body = tar_gz({
        "meta.json": meta_bytes(
            parts={"screw": {"kind": "hardware",
                             "files": {"stl": "model.stl"}}},
            views=[{"id": "assembled", "name": "assembled",
                    "file": "assembled.json", "parts": ["screw"]}]),
        "assembled.json": view_bytes(),
        "model.stl": b"solid demo"})
    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    assert "only 'printable' is exported" in r.json()["error"], r.text


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


def _publish_view(hub, view, **meta):
    """Push a document whose one view file is `view`.

    `**meta` reaches `meta_bytes`, because the file and the document are held
    against each other now (`render._match_selection`): a view naming parts the
    default catalogue does not declare needs the catalogue to say so, and the
    forwarding is what lets a case say it in one line.
    """
    body = tar_gz({"meta.json": meta_bytes(**meta), "assembled.json": view})
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


# -- the leaf's `key`, which is the identity the whole document is built on ---
# It is new with issue #75 and it is the string this walk had NO opinion about
# for as long as it existed: `_view_fields` keeps only the four keys the walk
# reads, so a `key` was thrown away by the PARSER before the walk could see it —
# and it then reached the browser through the very same file, because
# `check_view_file` validates a copy while the file itself is served untouched.
# That is the one shape of hole this walk cannot have: a push-borne string on an
# immutable same-origin URL that nothing looked at.


def test_a_leaf_key_the_catalogue_declares_publishes(hub):
    """The ordinary case, and the one that has to keep working.

    `meta_bytes` declares `lid` and `pin`, so a view naming either is a document
    whose two halves agree — which is exactly what the cross-check exists to
    require and what a rule written slightly too tight would break.
    """
    view = _view([{"name": "lid", "key": "lid"},
                  {"name": "group", "parts": [{"name": "pin", "key": "pin"}]}])
    assert _publish_view(hub, view).status_code == 201


def test_a_leaf_key_the_catalogue_does_not_declare_is_refused(hub):
    """Referential integrity, and that is ALL this buys — deliberately.

    Whether the key on a leaf is the key of the solid actually meshed into it is
    decided inside the build process and cannot be checked here at all; the file
    could name `lid` on the pin's triangles and this would publish. What it does
    close is the other half: a browser resolving a leaf against `parts` never
    gets nothing back, so the picture and the catalogue cannot describe two
    different sets of parts.
    """
    view = _view([{"name": "ghost", "key": "ghost"}])
    r = _publish_view(hub, view)
    assert r.status_code == 422
    assert "does not declare" in r.json()["error"], r.text
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_markup_in_a_leaf_key_is_refused(hub):
    """The key is held to the part-name rule before it is looked up.

    Order matters here and the assertion is on the MESSAGE for that reason: a
    key that is checked only by membership would be refused too — nothing hostile
    is in the catalogue — but for the wrong reason, and it would sail through the
    day a build declares a part under a hostile name.
    """
    view = _view([{"name": "lid", "key": "<img src=x onerror=alert(1)>"}])
    r = _publish_view(hub, view)
    assert r.status_code == 422
    assert "angle bracket" in r.json()["error"], r.text


def test_a_leaf_key_is_checked_at_any_depth(hub):
    # Same reason the name is: an assembly nests, and the parser keeps `key` at
    # every level now, so the walk has to look at it at every level too.
    view = _view([{"name": "sub", "parts": [
        {"name": "deep", "parts": [{"name": "lid", "key": "ghost"}]}]}])
    assert _publish_view(hub, view).status_code == 422


def test_a_leaf_with_no_key_is_refused(hub):
    """The document this refusal exists for, and it used to publish.

    Everything else in this section is about a key that is WRONG. This is about
    the file that carries none at all — the shape that made `views[].parts` a
    promise nothing kept: two unkeyed leaves published under
    `"parts": ["lid", "pin"]`, and the reader was told about two parts the
    browser could resolve to nothing. Into an immutable directory.

    A GROUP IS STILL FINE WITHOUT ONE, which is the other half of the rule and
    the reason it can be written at all: `grp` below carries `parts` and no key,
    exactly as `cadbuild.views.export_views` writes it, and the push is refused
    for the leaves rather than for it. What a node IS is read off `parts` — the
    same question this walk asks to decide whether to descend, and the same one
    the vendored viewer's `isShapeTree` asks.
    """
    view = _view([{"name": "lid"}, {"name": "grp", "parts": [{"name": "pin"}]}])
    r = _publish_view(hub, view)
    assert r.status_code == 422
    assert "no `key`" in r.json()["error"], r.text
    assert not (hub.project_dir("proj1") / "abc123").exists()

    # The same document with the leaves keyed publishes, so what was refused is
    # the missing key and not the tree around it.
    keyed = _view([{"name": "lid", "key": "lid"},
                   {"name": "grp", "parts": [{"name": "pin", "key": "pin"}]}])
    assert _publish_view(hub, keyed).status_code == 201


def test_a_view_promising_parts_its_file_does_not_show_is_refused(hub):
    """The list and the file are one claim, checked in both directions.

    This is the finding the two rules above exist for, stated as a push: the
    summary a reader is given without downloading a multi-megabyte view file has
    to be the file. Both directions are here because only one of them is caught
    by the leaf rule on its own — a file naming FEWER parts than the list, and a
    list naming fewer than the file.
    """
    keyed = _view([{"name": "lid", "key": "lid"}])
    over = _publish_view(hub, keyed)
    assert over.status_code == 422
    error = over.json()["error"]
    assert "'pin'" in error and "never shows" in error, error

    under = _publish_view(
        hub, _view([{"name": "lid", "key": "lid"},
                    {"name": "pin", "key": "pin"}]),
        views=[{"id": "assembled", "name": "assembled",
                "file": "assembled.json", "parts": ["lid"]}])
    assert under.status_code == 422
    error = under.json()["error"]
    assert "'pin'" in error and "does not declare" in error, error
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_view_declaring_no_parts_beside_a_file_full_of_them_is_refused(hub):
    """`"parts": []` published, and that is the same hole written the other way.

    Worth its own case rather than a row in the test above: an empty list passes
    every rule `_view_parts` has — it is a list, it is under the ceiling, it
    names no key the catalogue lacks and repeats nothing — so it was the one
    spelling of "this tab shows nothing" that a file full of parts could sit
    behind.
    """
    r = _publish_view(
        hub, _view([{"name": "lid", "key": "lid"}]),
        views=[{"id": "assembled", "name": "assembled",
                "file": "assembled.json", "parts": []}])
    assert r.status_code == 422
    assert "does not declare" in r.json()["error"], r.text


def test_the_selection_is_checked_before_the_view_file_is_read(hub):
    """A `parts` the hub can refuse by lookup must not cost a parse and a gzip.

    The order is the point and it is observable: the view file below is not JSON
    at all, so a hub that opened it first would answer "not valid JSON" — the
    422 it really gives names the list instead, which is the only evidence that
    `_view_parts` ran before `check_view_file` and `measure_view`. On a real
    push the file is up to MAX_BUILD_BYTES and the work happens in one of two
    build workers.
    """
    r = _publish_view(
        hub, b"not json at all",
        views=[{"id": "assembled", "name": "assembled",
                "file": "assembled.json", "parts": "lid"}])
    assert r.status_code == 422
    assert "catalogue keys" in r.json()["error"], r.text


def test_ordinary_part_names_and_colours_still_publish(hub):
    # The guard rail must leave a real export alone: nested groups, hex colours,
    # the per-segment colour list edges carry, and a non-English part name.
    # Every LEAF names the record it is of and the group in the middle does not,
    # which is what a real export writes — and the catalogue is declared to
    # match, because that pairing is now part of what "a real export" means.
    view = _view([
        {"name": "корпус", "key": "корпус", "color": "#e8b024"},
        {"name": "cover", "color": "steelblue", "parts": [
            {"name": "screw", "key": "screw", "color": "#abc"},
            {"name": "edges", "key": "edges", "color": ["#ff0000", "#00ff00"]},
        ]},
    ])
    catalogue = {key: {"kind": "printable"}
                 for key in ("корпус", "screw", "edges")}
    reply = _publish_view(
        hub, view, parts=catalogue,
        views=[{"id": "assembled", "name": "assembled",
                "file": "assembled.json", "parts": list(catalogue)}])
    assert reply.status_code == 201, reply.text


def test_markup_in_an_exported_file_s_extension_is_refused(hub):
    """The extension is what the download button is captioned with.

    It was the key of the flat `downloads` map and it is the key of a part's own
    `files` now, which is the one thing that changed: the caption rule
    (`SAFE_LABEL`, 32 characters of a short token) followed the job rather than
    the field name. The page builds the button with textContent, so this is the
    second line of defence rather than the only one — but an extension is a
    short token by nature and there is no reason to accept anything else.

    The KEY OF `parts` ITSELF is a different rule and is checked elsewhere: it
    is a part name, held to `_check_part_name`, and a real push carrying markup
    in one is refused in tests/test_notes.py, which is where the part-name rule
    is paired against the build gate's copy of it.
    """
    body = tar_gz({
        "meta.json": meta_bytes(parts={"lid": {
            "kind": "printable",
            "files": {"<script>alert(1)</script>": "model.stl"}}}),
        "assembled.json": view_bytes(),
        "model.stl": b"solid demo",
    })
    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422
    assert not (hub.project_dir("proj1") / "abc123").exists()


@pytest.mark.parametrize("where", FILE_POINTERS)
def test_a_pointer_at_a_generated_file_is_refused(hub, where):
    # meta.json and index.html are rewritten by the hub AFTER this validation, so
    # a pointer aiming at one would be measured against the upload and then
    # served as ours.
    for name in ("meta.json", "index.html"):
        body = tar_gz({
            "meta.json": meta_bytes(**_pointing_at(where, name)),
            "assembled.json": view_bytes(keys=("lid",)),
            "index.html": b"<p>hi</p>",
        })
        r = hub.publish("proj1", "abc123", body)
        assert r.status_code == 422, (where, name)


@pytest.mark.parametrize("where", ("part files", "part preview",
                                   "view overview", "view preview"))
@pytest.mark.parametrize("value", (0, [], ""))
def test_an_optional_field_that_is_falsy_but_not_an_object_is_refused(
        hub, where, value):
    """`0` is not "no pictures", and reading it as one would publish in silence.

    Every optional field on this document is read with an explicit `is None` for
    this: `record.get(field) or {}` swallows every falsy non-object, so a push
    that described something entirely different would be accepted and the
    difference would show up nowhere. `downloads` was the last field that did not
    follow the rule — it read `or {}` until the review of issue #53, so
    `downloads: 0` published a build whose download buttons had silently
    vanished — and the map is gone, but the reading it got wrong is the reading
    every field below is written to.

    `parts` itself is on the same rule and is checked in tests/test_notes.py,
    where the catalogue's own shape lives; `views` has had a non-empty list
    check since long before this.
    """
    fields = _pointing_at(where, "model.stl")
    if where.startswith("part"):
        fields["parts"]["lid"][where.split()[1]] = value
    else:
        fields["views"][0][where.split()[1]] = value
    body = tar_gz({"meta.json": meta_bytes(**fields),
                   # `_pointing_at` declares a catalogue of one, so the view
                   # file names one: the refusal has to be about the falsy
                   # field and not about the two halves disagreeing.
                   "assembled.json": view_bytes(keys=("lid",)),
                   "model.stl": b"solid demo"})
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_part_key_longer_than_a_button_caption_still_publishes(hub):
    """The regression that decided which rule a part's KEY is held to.

    A part name has a ceiling of its own and it is four times a caption's — 128
    characters on the build side (MEMBER_RE), MAX_TEXT here — which is what
    makes the difference reachable at all: the key below is legal under both and
    refused by SAFE_LABEL. It used to be the STEM of the `overview` and
    `previews` maps; issue #75 made it the key of the catalogue, which is a
    stronger version of the same trap, because now every part in the document is
    filed under one. Holding it to SAFE_LABEL — the 32-character rule for a
    button caption — would refuse an ordinary project with the name of its own
    part as the reason, and nothing about a key is a caption.
    """
    key = "bracket_" + "x" * 40
    body = tar_gz({
        "meta.json": meta_bytes(
            parts={key: {"kind": "printable", "preview": "model.stl"}},
            views=[{"id": "assembled", "name": "assembled",
                    "file": "assembled.json", "parts": [key]}]),
        "assembled.json": view_bytes(keys=(key,)),
        "model.stl": b"solid demo",
    })
    assert hub.publish("proj1", "abc123", body).status_code == 201
    meta = hub.get("/project/proj1/abc123/meta.json").json()
    assert meta["parts"][key] == {"kind": "printable", "preview": "model.stl"}
    assert meta["views"][0]["parts"] == [key]


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
        views=[{"id": "assembled", "file": name, "parts": ["lid"]}]))
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
            # One leaf, keyed `lid`, because that is what the entry
            # `_view_declarable` builds declares: the hub compares the two
            # halves, so a file naming more would refuse every row for a reason
            # that has nothing to do with its NAME.
            (staging / name).write_bytes(view_bytes(keys=("lid",)))
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
    staging, names = _built(
        store, "proj1", "abc123",
        meta_bytes(parts={"lid": {"kind": "printable", "preview": name}},
                   views=[{"id": "assembled", "name": "assembled",
                           "file": "assembled.json", "parts": ["lid"]}]),
        extra=(name,))

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
    meta = meta_bytes(views=[{"id": "assembled", "file": name,
                              "parts": ["lid"]}])
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
                {"id": f"v{i}", "file": "assembled.json", "parts": ["lid"]}
                for i in range(count)]),
            "assembled.json": view_bytes(keys=("lid",)),
            "model.stl": b"solid demo",
        })

    # Three members in the archive, so three views is the ceiling itself.
    assert hub.publish("proj1", "abc123", archive(3)).status_code == 201
    r = hub.publish("proj1", "def456", archive(4))
    assert r.status_code == 422
    assert "entries" in r.json()["error"], r.text
    assert not (hub.project_dir("proj1") / "def456").exists()


@pytest.mark.parametrize("spread", ("one record", "one pointer each"))
def test_more_file_pointers_than_the_build_has_files_is_refused(hub, spread):
    """Every entry legal, in numbers no build produces: the `notes` failure again.

    A hundred thousand pointers each naming one real file pass every per-entry
    check there is and make a `meta.json` that every visitor of that build
    downloads, under a year of `immutable`, from a push that cannot be taken
    back. It was three flat maps and each was bounded by the build's own file
    count; issue #75 spread the pointers over the catalogue's records, and the
    bound had to move with them — ONE BUDGET FOR THE WHOLE CATALOGUE and not a
    ceiling per record, because `MAX_PARTS` records of `len(files)` pointers each
    is 200 × the archive's member limit, an order of magnitude worse than the
    maps this replaced, out of a change that was supposed to move a bound rather
    than loosen one.

    BOTH SPREADS ARE HERE because a per-record ceiling passes the first and fails
    only the second: piling the pointers into one record is what a per-record
    bound catches, and handing each record a single pointer is what only a
    document-wide budget can see.

    The bound is the build's OWN file count, so the first half of each case
    matters as much as the second: a catalogue naming every file the build
    published sits AT the ceiling and has to publish.
    """
    def archive(count):
        if spread == "one record":
            parts = {"lid": {"kind": "printable",
                             "files": {f"stl{i}": "model.stl"
                                       for i in range(count)}}}
        else:
            parts = {f"part{i}": {"kind": "printable", "preview": "model.stl"}
                     for i in range(count)}
        return tar_gz({
            "meta.json": meta_bytes(
                parts=parts,
                views=[{"id": "assembled", "name": "assembled",
                        "file": "assembled.json", "parts": list(parts)}]),
            "assembled.json": view_bytes(keys=tuple(parts)),
            "model.stl": b"solid demo",
        })

    # Three members in the archive, so three pointers is the ceiling itself.
    assert hub.publish("proj1", "abc123", archive(3)).status_code == 201, spread
    r = hub.publish("proj1", "def456", archive(4))
    assert r.status_code == 422, r.text
    # The message names the budget AND where it ran out, which is the whole
    # difference between a document-wide bound and a per-record one: with the
    # pointers spread over 200 records, "somewhere in the catalogue" is not an
    # answer anybody can act on.
    error = r.json()["error"]
    assert "more files than the 3" in error, error
    assert "part" in error, error
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
