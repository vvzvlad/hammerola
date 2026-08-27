"""Renaming a project, and removing one — the two routes that unmake something.

WHAT EACH IS ALLOWED TO TOUCH IS THE SUBJECT HERE, more than the mechanics.

  * `rename` moves the NAME and nothing else. There is no route that changes an
    id, and there must not be: every permanent URL of the project is built from
    it and the builds behind those URLs went out with a year of `immutable`. The
    tests below therefore check as hard for what a rename LEAVES ALONE — the
    published builds, their own meta.json — as for what it changes.
  * `rm` removes the project WHOLE. There is no route that removes one build,
    for the same reason turned around: that would break a permanent URL while
    the project went on standing.

AND THE PART THAT IS EASY TO GET WRONG: the stored code is addressed by the
digest of a source tree and not by project (SPEC 7.8), so the same tree published
in two projects is ONE directory serving both. Removing a project may not take
code another project's revision still points at, and may not leave behind code
nothing points at — the store's invariant is "an archive exists exactly when a
published revision does", in both directions.
"""

import json

import httpx
from harness import TOKEN, comment_payload, good_build

from src.store import SOURCE_ARCHIVE_NAME, SOURCES_DIR_NAME


def _publish(hub, pid="proj1", body=None):
    """Publish on the minting route. -> the revision the hub named."""
    reply = hub.publish(pid, None, good_build() if body is None else body)
    assert reply.status_code == 201, reply.text
    return reply.record["commit"]


def _rename(hub, pid, title, token=TOKEN, body=None):
    headers = {"Content-Type": "application/json"}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    payload = json.dumps({"title": title}).encode() if body is None else body
    return httpx.post(f"{hub.url}/api/v1/projects/{pid}/title",
                      content=payload, headers=headers, timeout=10,
                      trust_env=False)


def _remove(hub, pid, token=TOKEN):
    headers = {"Authorization": f"Bearer {token}"} if token is not None else {}
    return httpx.request("DELETE", f"{hub.url}/api/v1/projects/{pid}",
                         headers=headers, timeout=10, trust_env=False)


def _sources(hub, revision=None):
    root = hub.data / SOURCES_DIR_NAME
    return root if revision is None else root / revision


# -- rename ------------------------------------------------------------------
def test_a_rename_shows_up_where_a_project_is_named(hub):
    revision = _publish(hub)
    assert _rename(hub, "proj1", "The bracket, mk2").status_code == 200

    picker = hub.get("/project/proj1/builds.json").json()
    assert picker["title"] == "The bracket, mk2"
    card, = hub.index().json()
    assert card["title"] == "The bracket, mk2"
    # And the id is what it always was: the URLs still resolve.
    assert card["pid"] == "proj1"
    assert hub.get(f"/project/proj1/{revision}/meta.json").status_code == 200


def test_a_rename_does_not_rewrite_a_published_build(hub):
    """The one thing it may not do. A build directory is immutable and served
    with a year of `immutable`; the copies already handed out cannot be
    recalled, so rewriting the file on disk would only make it disagree with
    them."""
    revision = _publish(hub)
    before = hub.get(f"/project/proj1/{revision}/meta.json").json()

    assert _rename(hub, "proj1", "Renamed").status_code == 200

    after = hub.get(f"/project/proj1/{revision}/meta.json").json()
    assert after == before
    assert after["title"] == "Demo project"


def test_the_next_push_supersedes_a_rename(hub):
    """A build carries the project's own title, so a push is a newer statement
    of the name than a rename made before it — otherwise one rename would
    outrank every future push for ever."""
    _publish(hub)
    assert _rename(hub, "proj1", "Renamed on the hub").status_code == 200
    assert hub.get("/project/proj1/builds.json").json()["title"] == \
        "Renamed on the hub"

    _publish(hub, body=good_build("second"))
    assert hub.get("/project/proj1/builds.json").json()["title"] == \
        "Demo project"


def test_renaming_needs_the_publishing_secret_and_says_nothing_without_it(hub):
    _publish(hub)
    for token in (None, "not-the-token"):
        refused = _rename(hub, "proj1", "nope", token=token)
        assert refused.status_code == 401
        assert refused.headers["WWW-Authenticate"] == "Bearer"
        # Checked BEFORE the project is looked at, so a caller without the
        # secret learns exactly as much about a project that exists as about
        # one that does not.
        unknown = _rename(hub, "nosuchproject", "nope", token=token)
        assert unknown.status_code == 401
        assert unknown.json() == refused.json()
    assert hub.get("/project/proj1/builds.json").json()["title"] == \
        "Demo project"


def test_every_miss_is_the_same_404(hub):
    _publish(hub)
    misses = [_rename(hub, "nosuchproject", "x"),
              _rename(hub, "not a pid", "x"),
              _rename(hub, "x" * 65, "x")]
    for reply in misses:
        assert reply.status_code == 404, reply.text
        assert reply.json() == misses[0].json()


def test_a_title_that_could_rewrite_the_line_around_it_is_refused(hub):
    """The same rule a build's own title goes through (`render.project_title`),
    because both end up in the same caption."""
    _publish(hub)
    for bad in ("with a ‮ override", "line\nbreak", "", " "):
        assert _rename(hub, "proj1", bad).status_code == 422, bad
    assert _rename(hub, "proj1", None).status_code == 422
    assert _rename(hub, "proj1", "x", body=b"not json").status_code == 422
    assert hub.get("/project/proj1/builds.json").json()["title"] == \
        "Demo project"


# -- rm ----------------------------------------------------------------------
def test_removing_a_project_takes_everything_it_had(hub):
    revision = _publish(hub)
    assert hub.publish_dev("proj1", good_build("slot")).status_code == 201
    posted = hub.post_comment("proj1", revision, payload=comment_payload())
    assert posted.status_code == 201, posted.text

    removed = _remove(hub, "proj1")
    assert removed.status_code == 200
    assert removed.json()["builds"] == 1
    assert removed.json()["comments"] == 1
    assert removed.json()["sources"] == 1

    assert not (hub.project_dir("proj1")).exists()
    assert not (hub.comment_dir("proj1")).exists()
    assert not _sources(hub, revision).exists()
    # The public surfaces stop naming it in the same breath.
    assert hub.index().json() == []
    assert hub.get(f"/project/proj1/{revision}/meta.json").status_code == 404
    assert hub.get("/project/proj1/").status_code == 404
    # And the code is gone from behind the secret too, not merely unlisted.
    assert hub.get(f"/api/v1/sources/{revision}",
                   headers={"Authorization": f"Bearer {TOKEN}"}
                   ).status_code == 404


def test_code_another_project_still_points_at_is_kept(hub):
    """`sources/` is addressed by content, so one directory can serve two
    projects. Removing one of them may not take the other's code with it."""
    shared = good_build("shared source")
    revision = _publish(hub, pid="proj1", body=shared)
    assert _publish(hub, pid="proj2", body=shared) == revision

    removed = _remove(hub, "proj1")
    assert removed.status_code == 200
    assert removed.json()["sources"] == 0

    assert (_sources(hub, revision) / SOURCE_ARCHIVE_NAME).is_file()
    assert hub.get(f"/api/v1/sources/{revision}",
                   headers={"Authorization": f"Bearer {TOKEN}"}
                   ).status_code == 200
    # And proj2 is untouched in every other way.
    assert hub.get(f"/project/proj2/{revision}/meta.json").status_code == 200


def test_removing_one_project_leaves_the_others_alone(hub):
    kept = _publish(hub, pid="proj2", body=good_build("other"))
    _publish(hub, pid="proj1")
    assert hub.post_comment("proj2", kept,
                            payload=comment_payload()).status_code == 201

    assert _remove(hub, "proj1").status_code == 200

    assert hub.get(f"/project/proj2/{kept}/meta.json").status_code == 200
    assert (hub.comment_dir("proj2")).is_dir()
    assert [c["pid"] for c in hub.index().json()] == ["proj2"]
    # The queue still answers for the surviving project, and the counters were
    # rebuilt rather than decremented.
    listed = hub.read_comments("?project=proj2").json()["comments"]
    assert len(listed) == 1


def test_removing_needs_the_publishing_secret(hub):
    revision = _publish(hub)
    for token in (None, "not-the-token"):
        refused = _remove(hub, "proj1", token=token)
        assert refused.status_code == 401
        assert refused.headers["WWW-Authenticate"] == "Bearer"
        unknown = _remove(hub, "nosuchproject", token=token)
        assert unknown.status_code == 401
        assert unknown.json() == refused.json()
    # Nothing was touched by any of that.
    assert hub.get(f"/project/proj1/{revision}/meta.json").status_code == 200


def test_removing_something_that_is_not_there_is_one_answer(hub):
    _publish(hub)
    misses = [_remove(hub, "nosuchproject"),
              _remove(hub, "not a pid"),
              _remove(hub, "x" * 65)]
    for reply in misses:
        assert reply.status_code == 404, reply.text
        assert reply.json() == misses[0].json()


def test_there_is_no_route_that_removes_one_build(hub):
    """The absence IS the feature: a build's URL is permanent, so removing one
    build turns a promise into a 404 while the project goes on standing. Pinned
    as a test because "add a narrower delete" is the obvious next request."""
    revision = _publish(hub)
    headers = {"Authorization": f"Bearer {TOKEN}"}
    for path in (f"/api/v1/projects/proj1/{revision}",
                 f"/project/proj1/{revision}",
                 f"/project/proj1/{revision}/",
                 "/api/v1/projects/proj1/title"):
        reply = httpx.request("DELETE", f"{hub.url}{path}", headers=headers,
                              timeout=10, trust_env=False)
        assert reply.status_code == 404, path
    assert hub.get(f"/project/proj1/{revision}/meta.json").status_code == 200


def test_a_project_with_no_builds_can_still_be_removed(hub):
    """A directory with nothing in it is what a build cleared out by hand
    leaves, and it is still a project as far as every other answer here is
    concerned (`_serve_pointer_page`)."""
    (hub.store.projects_dir / "empty1").mkdir(parents=True)
    assert hub.get("/project/empty1/").status_code == 200

    removed = _remove(hub, "empty1")
    assert removed.status_code == 200
    assert removed.json() == {"pid": "empty1", "builds": 0, "sources": 0,
                              "comments": 0}
    assert hub.get("/project/empty1/").status_code == 404
