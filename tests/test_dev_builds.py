"""The local slot: `<pid>/dev/`, one directory per project (SPEC 7.6).

The author edits model.py, runs the build and wants to see the result at once,
without committing. That work has no commit to be addressed by — and, the part
that decides the whole design, no history worth keeping: attempt seventeen of an
evening is not a version of the project, it is the working copy as it stands.

So there is exactly one slot, like there is exactly one `latest`, and every push
overwrites it. Four claims carry it and all four are tested here:

  * nothing accumulates. Three pushes leave one directory and no entry anywhere;
  * the slot is served `no-cache`, on the page and on every file under it. That
    is the whole licence to rewrite a URL in place, and the commit route's year
    of `immutable` is never allowed anywhere near it;
  * `latest` does not move, and the site index gains no CARD for the project.
    Those are the shared surfaces and they go on meaning "the project as of some
    commit". The index file is rewritten by a local push — a card carries a
    `dev` chip saying the slot is occupied — but a project with no commit build
    still has no card at all;
  * a push is still atomic: the tree is unpacked out of sight and swapped in.
"""

import json
import os

from harness import good_build, meta_bytes, tar_gz, view_bytes


def _build(marker, built="2026-08-21T04:16:00Z"):
    return tar_gz({
        "meta.json": meta_bytes(built=built),
        "assembled.json": view_bytes(marker),
    })


def _dirs_on_disk(hub, pid):
    pdir = hub.project_dir(pid)
    if not pdir.is_dir():
        return []
    return sorted(p.name for p in pdir.iterdir()
                  if p.is_dir() and not p.is_symlink()
                  and not p.name.startswith("."))


def _builds_json(hub, pid):
    return json.loads((hub.project_dir(pid) / "builds.json").read_text())


# -- one slot, no history ----------------------------------------------------
def test_a_local_push_answers_with_the_slot_and_nothing_else(hub):
    r = hub.publish_dev("proj1", _build("v1"))
    assert r.status_code == 201
    # ONE url. There is no second address a local build could be reached at —
    # that is the point of the slot — so there is no second field either.
    assert r.json() == {"url": "/project/proj1/dev/"}

    assert (hub.project_dir("proj1") / "dev" / "assembled.json").is_file()
    assert hub.get("/project/proj1/dev/").status_code == 200
    assert hub.get("/project/proj1/dev/meta.json").status_code == 200


def test_three_pushes_leave_one_directory_and_no_history(hub):
    """The failure this whole change exists to remove.

    Minting an id per payload made every local attempt a build of its own: they
    landed in `builds.json`, showed up in the build picker as `dev-e9a448df778c`
    next to real commits, and piled up there for good. A working copy is not a
    version of anything.
    """
    for marker in ("v1", "v2", "v3"):
        assert hub.publish_dev("proj1", _build(marker)).status_code == 201

    assert _dirs_on_disk(hub, "proj1") == ["dev"]
    # Not "one entry" and not "an entry marked local" — none at all. `builds` is
    # the history of the project, and the history is a history of commits.
    assert _builds_json(hub, "proj1")["builds"] == []
    # And the slot shows the last push, not the first.
    assert hub.get("/project/proj1/dev/assembled.json").content == view_bytes("v3")


def test_the_slot_is_a_directory_and_not_a_pointer_at_a_build(hub):
    """The slot IS the build. Nothing else on disk holds a copy of it.

    A symlink would put the build back under an id of its own, which is exactly
    the shape being removed — and would be a second thing to prune.
    """
    hub.publish_dev("proj1", _build("v1"))
    slot = hub.project_dir("proj1") / "dev"
    assert slot.is_dir()
    assert not slot.is_symlink()
    assert (slot / "meta.json").is_file()


def test_the_same_payload_twice_is_a_200_that_writes_nothing(hub):
    """Idempotency survives, as an optimisation rather than as an address.

    The digest is still compared, and it still buys the 200 — but nothing in the
    URL is derived from it any more. What it buys now is a page somebody has open
    NOT being taken through a swap for a build identical to the one on screen.
    """
    body = _build("v1")
    assert hub.publish_dev("proj1", body).status_code == 201
    stamp = hub.get("/project/proj1/dev/meta.json").json()["published"]

    again = hub.publish_dev("proj1", body)
    assert again.status_code == 200
    assert again.json() == {"url": "/project/proj1/dev/"}
    assert _dirs_on_disk(hub, "proj1") == ["dev"]
    # Nothing was rewritten, which is what "no work" means here.
    assert hub.get("/project/proj1/dev/meta.json").json()["published"] == stamp


def test_a_changed_payload_replaces_the_slot_whole(hub):
    """Every file under the slot comes from the push that is in it now.

    Overwriting file by file would leave a directory that is part one build and
    part another — the one outcome a reader must never be shown.
    """
    hub.publish_dev("proj1", tar_gz({
        "meta.json": meta_bytes(views=[{"id": "a", "name": "a",
                                        "file": "old.json", "parts": 1}]),
        "old.json": view_bytes("v1")}))
    assert hub.get("/project/proj1/dev/old.json").status_code == 200

    hub.publish_dev("proj1", tar_gz({
        "meta.json": meta_bytes(views=[{"id": "a", "name": "a",
                                        "file": "new.json", "parts": 1}]),
        "new.json": view_bytes("v2")}))

    assert hub.get("/project/proj1/dev/new.json").content == view_bytes("v2")
    assert hub.get("/project/proj1/dev/old.json").status_code == 404, (
        "a file from the previous local build survived the swap, so the slot is "
        "being written into rather than replaced")


# -- what the slot is never allowed to touch ---------------------------------
def test_a_local_push_does_not_move_latest(hub):
    """The rule the separate route exists for (SPEC 7.6).

    `latest` is the link that gets pasted into chat, so it has to keep meaning
    "the project as of some commit". If uncommitted work from one laptop moved
    it, the promise would break retroactively for everybody already holding the
    link — and there is no way to un-send it.
    """
    hub.publish("proj1", "abc123", _build("c1", "2026-08-01T00:00:00Z"))
    assert os.readlink(hub.project_dir("proj1") / "latest") == "abc123"

    # A local build with a LATER timestamp than the commit build: if anything
    # ordered the two together, this is the push that would steal `latest`.
    hub.publish_dev("proj1", _build("d1", "2026-08-09T00:00:00Z"))

    assert os.readlink(hub.project_dir("proj1") / "latest") == "abc123"
    assert hub.get("/project/proj1/latest/assembled.json").content == view_bytes("c1")
    # Both are served at once, each showing its own build.
    assert hub.get("/project/proj1/dev/assembled.json").content == view_bytes("d1")


def test_local_builds_stay_out_of_the_public_index(hub):
    """The front page is the most public surface there is.

    A card that quietly starts describing somebody's uncommitted work is the
    same broken promise as a moved `latest`, in the one place everybody looks.
    """
    hub.publish_dev("proj1", _build("d1", "2026-08-09T00:00:00Z"))
    # Read over HTTP, which is the only thing that matters. A local push DOES
    # rewrite the index now — that is how the `dev` chip on a card appears — so
    # this is a claim about the CARDS and not about the file being untouched: a
    # project whose only build is a local one gets none.
    assert hub.index().json() == []

    hub.publish("proj1", "abc123", _build("c1", "2026-08-01T00:00:00Z"))
    cards = hub.index().json()
    assert [c["commit"] for c in cards] == ["abc123"]
    # ...and now that there is a card, it says the slot is occupied without
    # letting the slot describe the project: the commit on the card is the
    # commit, never `dev`.
    assert cards[0]["dev"] is True
    # And a later local push does not slip into the card that is now there.
    hub.publish_dev("proj1", _build("d2", "2026-08-10T00:00:00Z"))
    assert [c["commit"] for c in hub.index().json()] == ["abc123"]


def test_a_project_with_only_a_local_build_has_no_latest(hub):
    """Nothing has been published from a commit, so there is nothing to promise.

    Inventing a `latest` out of a laptop build would be the broken promise in its
    purest form: the link would exist, be public, and have never described a
    commit at all.
    """
    hub.publish_dev("proj1", _build("v1"))

    assert not (hub.project_dir("proj1") / "latest").exists()
    assert hub.get("/project/proj1/latest/meta.json").status_code == 404
    assert hub.get("/project/proj1/dev/meta.json").status_code == 200


def test_local_pushes_never_touch_the_commit_history(hub):
    """An evening at the laptop is twenty-odd pushes, and none of them count.

    The slot is one directory that every push overwrites, so thirty local
    pushes leave the commit side of the project exactly as they found it: the
    same directories, the same `latest`, the same picker. That is what removed
    RETENTION_DEV_BUILDS long before retention itself went; there was never a
    second bucket for it to size.
    """
    commits = [f"c{i}" for i in range(1, 5)]
    for i, commit in enumerate(commits, start=1):
        hub.publish("proj1", commit, _build(f"c{i}", f"2026-08-0{i}T00:00:00Z"))

    for i in range(30):
        assert hub.publish_dev(
            "proj1", _build(f"d{i}", f"2026-08-20T00:00:{i:02d}Z")).status_code == 201

    assert _dirs_on_disk(hub, "proj1") == sorted([*commits, "dev"])
    for commit in commits:
        assert hub.get(f"/project/proj1/{commit}/meta.json").status_code == 200
    assert os.readlink(hub.project_dir("proj1") / "latest") == commits[-1]
    assert [b["commit"] for b in _builds_json(hub, "proj1")["builds"]] == \
        sorted(commits, reverse=True)


# -- caching -----------------------------------------------------------------
def test_the_slot_is_never_cached_on_any_path(hub):
    """`no-cache` is the entire licence to rewrite a URL in place.

    A commit directory earns its year of `immutable` by never changing again;
    the slot changes on every push, so a single response from it carrying that
    header would make somebody's browser show a build that no longer exists,
    for a year, with no way to recall it. Every route into the slot is checked,
    because it only takes one to fall through to the immutable branch.
    """
    hub.publish("proj1", "abc123", _build("c1", "2026-08-01T00:00:00Z"))
    hub.publish_dev("proj1", _build("v1"))

    for path in ("/project/proj1/dev/",
                 "/project/proj1/dev/index.html",
                 "/project/proj1/dev/meta.json",
                 "/project/proj1/dev/assembled.json"):
        r = hub.get(path)
        assert r.status_code == 200, path
        assert r.headers["Cache-Control"] == "no-cache", path

    # The commit route is asserted alongside so the two cannot drift together.
    assert hub.get("/project/proj1/abc123/assembled.json").headers[
        "Cache-Control"] == "public, max-age=31536000, immutable"


# -- names -------------------------------------------------------------------
def test_dev_is_still_a_reserved_build_name(hub):
    """The slot owns the name, and the URL is the reason.

    `/project/<pid>/dev/` is the slot and `/api/v1/publish/<pid>/dev` is the
    route into it, so a build directory could never live there anyway.
    """
    from src.store import Store
    assert Store.valid_build_id("dev") is False
    assert Store.valid_build_id("latest") is False
    # Not a ban on the letters: only the two exact names are taken.
    assert hub.publish("proj1", "devbuild", good_build()).status_code == 201

    # With nothing pushed from a laptop the slot does not exist, and the URL
    # 404s rather than falling back to something.
    assert hub.get("/project/proj1/dev/").status_code == 404


def test_a_commit_may_now_be_called_dev_1234(hub):
    """The `dev-` PREFIX is no longer reserved, and nothing needs it to be.

    It was reserved for exactly one reason: local ids were `dev-<digest>`, so a
    commit called `dev-1234` would have been filed with the throwaway local
    builds instead of with the real ones. There is no bucket of local builds
    now, so the rule went with it and `dev-1234` is an ordinary commit id.
    """
    assert hub.publish("proj1", "dev-1234", good_build("one")).status_code == 201
    assert hub.get("/project/proj1/dev-1234/assembled.json").content == \
        view_bytes("one")
    # Ordinary in every respect: permanent URL, its own entry, `latest` on it,
    # and the same 409 protecting it as any other commit.
    assert hub.get("/project/proj1/dev-1234/assembled.json").headers[
        "Cache-Control"] == "public, max-age=31536000, immutable"
    assert [b["commit"] for b in _builds_json(hub, "proj1")["builds"]] == ["dev-1234"]
    assert os.readlink(hub.project_dir("proj1") / "latest") == "dev-1234"
    assert hub.publish("proj1", "dev-1234", good_build("two")).status_code == 409

    # And it does not collide with the slot in either direction.
    hub.publish_dev("proj1", _build("local"))
    assert hub.get("/project/proj1/dev/assembled.json").content == view_bytes("local")
    assert hub.get("/project/proj1/dev-1234/assembled.json").content == \
        view_bytes("one")


def test_commit_builds_still_refuse_to_be_overwritten(hub):
    """SPEC 7's 409, unchanged. The local slot exists so this can stay strict.

    A commit id names one immutable build; the slot is the answer for the case
    that used to tempt one into relaxing this — content that changes under a
    name that does not — and it answers it by giving that content a URL where
    nothing was ever promised to stay put.
    """
    assert hub.publish("proj1", "abc123", good_build("one")).status_code == 201
    assert hub.publish("proj1", "abc123", good_build("two")).status_code == 409
    assert hub.get("/project/proj1/abc123/assembled.json").content == \
        view_bytes("one")


# -- meta.json and the picker ------------------------------------------------
def test_the_slots_meta_says_it_is_a_local_build(hub):
    """The one thing that stayed: the page has to be able to say what it shows.

    Its `commit` reads `dev` — the slot's name is the only id it has — so
    without the flag the header would print `dev` where a commit hash belongs.
    """
    hub.publish_dev("proj1", _build("v1"))
    meta = json.loads(
        (hub.project_dir("proj1") / "dev" / "meta.json").read_text())
    assert meta["dev"] is True
    assert meta["commit"] == "dev"

    hub.publish("proj1", "abc123", _build("c1"))
    other = json.loads(
        (hub.project_dir("proj1") / "abc123" / "meta.json").read_text())
    assert other["dev"] is False


def test_builds_json_offers_the_two_names_only_when_they_resolve(hub):
    """What the picker needs, and no entry that leads to a 404.

    The two moving names are not builds and are not in the list; they are
    recorded beside it so the picker can offer them as destinations. Each is
    offered only while it actually resolves to something.
    """
    hub.publish_dev("proj1", _build("d1"))
    info = _builds_json(hub, "proj1")
    # A local-only project: a slot, no commits, so no `latest` to offer.
    assert info["has_dev"] is True
    assert info["latest"] is None
    assert info["builds"] == []
    # And it still knows what the project is called, which it can only have
    # taken from the slot's own meta.
    assert info["project"] == "demo"

    hub.publish("proj1", "abc123", _build("c1", "2026-08-01T00:00:00Z"))
    info = _builds_json(hub, "proj1")
    assert info["has_dev"] is True
    assert info["latest"] == "abc123"
    assert [b["commit"] for b in info["builds"]] == ["abc123"]
    # No `dev` flag on an entry any more: there is no entry to carry one.
    assert set(info["builds"][0]) == {"commit", "built"}


def test_a_project_with_no_local_build_offers_no_slot(hub):
    hub.publish("proj1", "abc123", _build("c1"))
    info = _builds_json(hub, "proj1")
    assert info["has_dev"] is False
    assert info["latest"] == "abc123"


# -- the ordinary publish path still applies ---------------------------------
def test_a_local_push_needs_the_token_like_any_other(hub):
    assert hub.publish_dev("proj1", _build("v1"), token=None).status_code == 401
    assert hub.publish_dev("proj1", _build("v1"), token="wrong").status_code == 401
    assert _dirs_on_disk(hub, "proj1") == []


def test_a_broken_local_archive_is_refused_like_any_other(hub):
    """Validation is the ordinary path: the route only decides where it lands."""
    assert hub.publish_dev("proj1", b"not a tarball").status_code == 422
    no_view = tar_gz({"meta.json": meta_bytes(views=[])})
    assert hub.publish_dev("proj1", no_view).status_code == 422
    assert _dirs_on_disk(hub, "proj1") == []


def test_a_refused_push_leaves_the_slot_showing_what_it_had(hub):
    """A build that fails validation must not take the previous one down.

    The author is looking at the slot while they work; a typo in meta.json that
    blanked the page would be the worst possible moment for it.
    """
    hub.publish_dev("proj1", _build("good"))
    assert hub.publish_dev("proj1", b"not a tarball").status_code == 422
    assert hub.publish_dev(
        "proj1", tar_gz({"meta.json": meta_bytes(views=[])})).status_code == 422

    assert hub.get("/project/proj1/dev/assembled.json").content == view_bytes("good")
    assert _dirs_on_disk(hub, "proj1") == ["dev"]


def test_the_local_slot_can_be_commented_on(hub):
    """It is the build somebody looking over the author's shoulder is looking at."""
    from harness import comment_payload

    hub.publish_dev("proj1", _build("v1"))
    r = hub.post_comment("proj1", "dev", payload=comment_payload())
    assert r.status_code == 201
