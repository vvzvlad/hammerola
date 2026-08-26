"""The hub keeps the CODE of every revision it publishes (SPEC 8, entry 17).

Three claims, and each of them fails in a different direction:

  * a published revision has its pushed body and its build log on disk, and the
    body is BYTE FOR BYTE what was pushed — a repacked tree would still look like
    a source archive and would no longer be the thing that built the revision;
  * the code is NOT public. It leaves only through `GET /api/v1/sources/...`,
    under the same secret that publishes, and every miss answers the same 404 —
    while the build the code produced is served to the world with a year of
    `immutable`. Getting that backwards is not repairable: the copies are handed
    out;
  * a build that FAILED leaves nothing. That is the invariant the store's whole
    shape rests on — an archive exists only for a revision that was published —
    and it is cheap to state and easy to lose, because "keep the body around in
    case somebody wants it" is one line away from here at all times.

The suite pushes finished artefacts rather than model source (see `harness`), so
what is stored below is an archive of those. That changes nothing here: the store
holds the request body whatever was in it.
"""

import json

from harness import TOKEN, failing_builder, good_build

from src.store import (BODY_PREFIX, PAYLOAD_DIGEST_FILE, SOURCE_ARCHIVE_NAME,
                       SOURCE_LOG_NAME, SOURCES_DIR_NAME)


def _sources(hub, revision=None):
    """The store's tree, or one revision's directory in it."""
    root = hub.data / SOURCES_DIR_NAME
    return root if revision is None else root / revision


def _fetch(hub, revision, suffix="", token=TOKEN):
    headers = {"Authorization": f"Bearer {token}"} if token is not None else {}
    return hub.get(f"/api/v1/sources/{revision}{suffix}", headers=headers)


def _published(hub, body=None, pid="proj1"):
    """Publish on the MINTING route and return the revision the hub named.

    The route with no name in it is the one the client uses, and it is the one
    where the revision id and the address of the code are the same string — so it
    is what nearly every test here drives.
    """
    reply = hub.publish(pid, None, good_build() if body is None else body)
    assert reply.status_code == 201, reply.text
    return reply.record["commit"]


def test_a_published_revision_keeps_the_body_that_produced_it(hub):
    body = good_build("kept")
    revision = _published(hub, body)

    stored = _sources(hub, revision) / SOURCE_ARCHIVE_NAME
    assert stored.is_file(), "the revision was published without its code"
    # Byte for byte, and not merely "unpacks to the same thing": the promise is
    # that the hub holds what was pushed, so a re-tarred tree would be a
    # different artefact that only looks like the right answer.
    assert stored.read_bytes() == body

    # The log is the other half of "how did this revision come about", and it is
    # here rather than only at the job because a job id is per attempt and
    # recorded against nothing — a month later it is the only way to the log.
    assert (_sources(hub, revision) / SOURCE_LOG_NAME).read_text()

    # And the transient the body travelled in is gone. It is dot-prefixed, so a
    # leak would be invisible to every reader and would sit on the volume until
    # some later start swept it.
    assert [p.name for p in hub.data.iterdir()
            if p.name.startswith(BODY_PREFIX)] == []


def test_the_code_is_outside_the_build_directory_and_not_served(hub):
    """The one thing on this site that is held and not shown.

    A build directory is public and cached for a year, which is precisely why
    the code may not be in one: a mistake there cannot be recalled.
    """
    revision = _published(hub)

    build = hub.project_dir("proj1") / revision
    assert not (build / SOURCE_ARCHIVE_NAME).exists()
    assert not (build / SOURCE_LOG_NAME).exists()
    # The store is a sibling of `project/`, so no URL under /project/ can reach
    # into it however the last segment is spelled.
    assert _sources(hub).parent == hub.data
    assert hub.get(f"/project/proj1/{revision}/{SOURCE_ARCHIVE_NAME}"
                   ).status_code == 404

    # The build itself is public, unchanged: this is about the code only.
    assert hub.get(f"/project/proj1/{revision}/assembled.json").status_code == 200


def test_the_code_leaves_only_under_the_publishing_secret(hub):
    revision = _published(hub)

    for token in (None, "not-the-token"):
        for suffix in ("", "/log"):
            refused = _fetch(hub, revision, suffix, token=token)
            assert refused.status_code == 401, (token, suffix)
            assert refused.headers["WWW-Authenticate"] == "Bearer"
            # The token is checked BEFORE the revision, so a caller without it
            # is told exactly as much about a revision that exists as about one
            # that does not.
            unknown = _fetch(hub, "f" * 64, suffix, token=token)
            assert unknown.status_code == 401
            assert unknown.json() == refused.json()

    assert _fetch(hub, revision).status_code == 200


def test_a_revision_the_hub_has_no_code_for_answers_like_any_other_miss(hub):
    """No answer here may confirm what is on disk.

    A revision that was never published, one whose build failed, and a segment
    that is not a revision id at all are one reply, body included.
    """
    _published(hub)  # so the store exists and the miss is not "no store at all"

    misses = [_fetch(hub, "f" * 64),            # well-formed, never published
              _fetch(hub, "not a revision"),    # not an id
              _fetch(hub, "dev"),               # a name the store may not hold
              _fetch(hub, "f" * 64, "/log"),
              _fetch(hub, "x" * 65)]            # past the id ceiling
    for reply in misses:
        assert reply.status_code == 404, reply.text
        assert reply.json() == misses[0].json()


def test_the_archive_comes_back_whole_and_as_an_opaque_attachment(hub):
    body = good_build("over the wire")
    revision = _published(hub, body)

    got = _fetch(hub, revision)
    assert got.status_code == 200
    assert got.content == body
    # Never a type a browser will act on. These are bytes a pusher supplied,
    # handed back on an origin that serves everybody's builds.
    assert got.headers["Content-Type"] == "application/octet-stream"
    assert got.headers["Content-Disposition"] == (
        f'attachment; filename="{revision}.tar.gz"')
    assert got.headers["X-Content-Type-Options"] == "nosniff"
    # Never cached: the reader is a tool holding the token, and there is nothing
    # to gain from a copy of the code in an intermediary.
    assert got.headers["Cache-Control"] == "no-cache"

    log = _fetch(hub, revision, "/log")
    assert log.status_code == 200
    # text/plain and not text/html, for the same reason the job log is: this is
    # output the MODEL produced.
    assert log.headers["Content-Type"] == "text/plain; charset=utf-8"
    assert "copying builder" in log.text


def test_pushing_the_same_sources_again_stores_no_second_archive(hub):
    """The address IS the digest, so an unchanged tree cannot be stored twice."""
    body = good_build("once")
    revision = _published(hub, body)
    stored = _sources(hub, revision) / SOURCE_ARCHIVE_NAME
    before = stored.stat()

    again = hub.publish("proj1", None, body)
    # Not rebuilt and not republished: this exact push is already on disk, so
    # the answer comes from the PUSH itself and never becomes a job at all.
    assert again.status_code == 200
    assert again.json()["revision"] == revision

    assert [p.name for p in _sources(hub).iterdir()] == [revision]
    assert sorted(p.name for p in _sources(hub, revision).iterdir()) == [
        SOURCE_LOG_NAME, SOURCE_ARCHIVE_NAME]
    after = stored.stat()
    # The same FILE, not merely the same bytes: a rewrite would be a new inode,
    # and a stored archive changing under a revision that is already published
    # is the one thing content addressing is supposed to make impossible.
    assert (after.st_ino, after.st_mtime_ns) == (before.st_ino, before.st_mtime_ns)
    assert stored.read_bytes() == body


def test_a_build_that_failed_leaves_no_code_at_all(hub_factory):
    """The invariant: nothing is stored for a build that published nothing.

    Not a space argument — an archive is kilobytes. The author is looking at the
    failure the moment the command returns, with the tree still on their own
    disk, and a stored tree that belongs to no published revision is one the
    store cannot answer for.
    """
    hub = hub_factory(build_runner=failing_builder())
    reply = hub.publish_async("proj1", None, good_build())
    assert reply.status_code == 202
    revision = reply.json()["revision"]
    record = hub.await_job(reply.json()["job"]).record
    assert record["state"] == "failed"

    # No archive, no log beside one, no directory — and no store at all, because
    # nothing was ever published on this hub.
    assert not _sources(hub).exists()
    assert _fetch(hub, revision).status_code == 404
    assert _fetch(hub, revision, "/log").status_code == 404
    assert [p.name for p in hub.data.iterdir()
            if p.name.startswith(BODY_PREFIX)] == []

    # What the pusher DOES get is the job's own log, which is where they read it
    # anyway — immediately, in the terminal, from the command they just ran.
    log = hub.job_log(record["id"])
    assert log.status_code == 200
    assert "build failed" in log.text


def test_the_local_slot_is_not_a_revision_and_its_code_is_not_kept(hub):
    """`dev` has no history to go back to, so there is nothing to keep it for.

    The slot is overwritten by every push and is deliberately absent from
    `builds_of`, the picker, `latest` and the index. Its sources would be an
    entry in the store that nothing published ever points at.
    """
    assert hub.publish_dev("proj1", good_build("slot")).status_code == 201
    assert (hub.project_dir("proj1") / "dev" / "meta.json").is_file()
    assert not _sources(hub).exists()

    # And the moment the same tree is published as a revision, it is stored —
    # the slot took nothing away.
    revision = _published(hub, good_build("slot"))
    assert (_sources(hub, revision) / SOURCE_ARCHIVE_NAME).is_file()


def test_a_caller_named_revision_is_stored_under_its_digest(hub):
    """The route that still takes a `<commit>` stores by CONTENT, like the rest.

    Worth pinning because the two ids then differ: the build is at the name the
    caller chose and its code is at the digest, so that URL is not derivable from
    this one. That is a property of the route that is on its way out (step 7),
    not of the store — and the alternative, storing nothing for such a push,
    would break the invariant that every published revision has its code.
    """
    body = good_build("named")
    assert hub.publish("proj1", "abc123", body).status_code == 201

    digest = (hub.project_dir("proj1") / "abc123"
              / PAYLOAD_DIGEST_FILE).read_text().strip()
    assert (_sources(hub, digest) / SOURCE_ARCHIVE_NAME).read_bytes() == body
    assert _fetch(hub, digest).status_code == 200
    # The name in the URL is not the address of the code.
    assert _fetch(hub, "abc123").status_code == 404


def test_the_stored_log_is_the_one_the_parent_captured(hub):
    """The log beside the code is the hub's copy, not the build's own file.

    Same text as the job endpoint serves, because both come from
    `BuildOutcome.log` — what the PARENT captured and capped. Nothing the build
    process writes reaches either of them.
    """
    reply = hub.publish_async("proj1", None, good_build())
    record = hub.await_job(reply.json()["job"]).record
    revision = record["commit"]

    from_the_job = hub.job_log(record["id"]).text
    from_the_revision = _fetch(hub, revision, "/log").text
    assert from_the_revision == from_the_job
    assert from_the_revision.startswith("copying builder:")


def test_the_store_is_not_pruned_by_number(hub):
    """No retention here either (SPEC 5.3): every revision keeps its code."""
    revisions = [_published(hub, good_build(f"v{index}")) for index in range(12)]
    assert sorted(p.name for p in _sources(hub).iterdir()) == sorted(revisions)
    for revision in revisions:
        assert _fetch(hub, revision).status_code == 200

    # And the picker still lists all of them, so nothing about the store is
    # quietly deciding what a project has.
    listed = json.loads((hub.project_dir("proj1") / "builds.json").read_text())
    assert sorted(b["commit"] for b in listed["builds"]) == sorted(revisions)
