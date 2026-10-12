"""Nothing is ever thrown away, or refused, for being one too many (SPEC 5.3, 7.3, 7A.4).

There is no build retention window, no job retention, and no comment ceiling: a
revision is tens of megabytes, and disk is cheaper than a mechanism that has to be
written, tested, explained and can delete the wrong thing. A comment ceiling would
be the harsher shape, refusing the NEXT comment on a build for good. There is no
rate limit either: writing takes EDIT_TOKEN, and its holder can delete the project
outright.

This file tests the ABSENCE of these mechanisms, which does not fail on its own.
Other tests publish a handful of builds and comments and would pass with a window
of twenty put back, so the numbers here are past the obvious ceilings (20 builds,
200 jobs, 100 comments per build).
"""

import json
import os

from harness import (DEFAULT_EXPORTS, comment_payload, meta_bytes, tar_gz,
                     view_bytes)

from src.jobs import STATE_DONE, JobStore
from src.store import DEV_LINK

# Past a 20-build window. Small enough that the suite stays fast.
BUILDS = 25

# One past MAX_JOBS, which was 200. Records only — no build runs for these, and
# none needs to: what is under test is whether the registry drops any.
JOBS = 205

# Past a per-build ceiling of 100 and a rate limit of 30 per ten minutes (the
# suite raises no rate limit out of the way, so a reinstated one would fire). All
# on ONE build, where a per-build wall would be terminal.
COMMENTS = 120


def _build(marker, built):
    return tar_gz({
        "meta.json": meta_bytes(built=built),
        "assembled.json": view_bytes(marker),
        **DEFAULT_EXPORTS,
    })


def _commits_on_disk(hub, pid):
    # The slot is not a commit; every commit mirrors itself into it, so it is
    # there whichever build was published last.
    return sorted(p.name for p in hub.project_dir(pid).iterdir()
                  if p.is_dir() and not p.is_symlink()
                  and not p.name.startswith(".") and p.name != DEV_LINK)


def test_no_number_of_builds_makes_an_older_one_disappear(hub):
    """Push past every window that ever existed; every build is still served."""
    stamps = {}
    for index in range(BUILDS):
        # Hour-by-hour rather than day-by-day: `built` is what orders the picker
        # and what `latest` follows, and 25 of them have to fit in a month.
        stamps[f"c{index}"] = f"2026-08-01T{index // 60:02d}:{index % 60:02d}:00Z"
        hub.publish("proj1", f"c{index}", _build(f"v{index}", stamps[f"c{index}"]))

    expected = sorted(stamps)
    assert _commits_on_disk(hub, "proj1") == expected

    # On disk is not enough: a build the picker stopped listing is a build
    # nobody can reach from the site, which is most of what deleting it costs.
    builds = json.loads((hub.project_dir("proj1") / "builds.json").read_text())
    assert sorted(b["commit"] for b in builds["builds"]) == expected

    # And the OLDEST one — the one every window would have taken first — is
    # still served, byte for byte, at its permanent URL.
    first = hub.get("/project/proj1/c0/assembled.json")
    assert first.status_code == 200
    assert b"v0" in first.content

    # `latest` still means the newest, which is the property a window was
    # supposed to protect and is now simply true.
    assert os.readlink(hub.project_dir("proj1") / "latest") == f"c{BUILDS - 1}"


def test_the_oldest_build_survives_a_pointer_pinned_somewhere_else(hub):
    """The oldest build survives while `latest` is parked somewhere else.

    With any window, a rollback pinning `latest` at an old revision protects that
    one build and no other. This is the state a window makes dangerous: a pointer
    parked on the oldest build while pushes keep arriving.
    """
    for index in range(5):
        hub.publish("proj1", f"c{index}",
                    _build(f"v{index}", f"2026-08-0{index + 1}T00:00:00Z"))
    pdir = hub.project_dir("proj1")
    os.remove(pdir / "latest")
    os.symlink("c0", pdir / "latest")

    # Publishing after the pin moves `latest` back to the newest, and under the
    # old rule that is the moment c1..c3 lost their protection.
    for index in range(5, 10):
        hub.publish("proj1", f"c{index}",
                    _build(f"v{index}", f"2026-08-{index + 1:02d}T00:00:00Z"))

    assert _commits_on_disk(hub, "proj1") == sorted(f"c{i}" for i in range(10))


def test_no_number_of_jobs_makes_an_older_one_disappear(tmp_path):
    """Registry only: `create` and `finish`, past a 200-job ceiling.

    Driven through `JobStore` rather than pushes because a push per job would be
    205 builds; `create`/`finish` are where a sweep would run.
    """
    store = JobStore(tmp_path / "data")
    ids = []
    for index in range(JOBS):
        record = store.create("proj1", f"c{index}")
        ids.append(record["id"])
        store.finish(record["id"], state=STATE_DONE, code=201,
                     log=f"build {index}")

    assert len(store._records) == JOBS
    for index, job_id in enumerate(ids):
        assert store.get(job_id) is not None, f"job {index} was dropped"
        assert store.log(job_id) == f"build {index}"

    # And they are still all there after a restart, the other place a count
    # ceiling could be applied, before the records are even read.
    reopened = JobStore(tmp_path / "data")
    assert len(reopened._records) == JOBS
    assert all(reopened.get(job_id) is not None for job_id in ids)


def test_a_job_from_years_ago_is_still_there(tmp_path):
    """No age ceiling either, and a restart is where one would have fired.

    MAX_JOB_AGE_SECONDS was fourteen days and it was measured against `created`,
    a string on a volume every build can write. A record dated 2019 is what that
    ceiling was for; here it is simply a record.
    """
    store = JobStore(tmp_path / "data")
    record = store.create("proj1", "c1")
    job_id = record["id"]
    store.finish(job_id, state=STATE_DONE, code=201, log="ancient")

    on_disk = store.root / job_id / "job.json"
    planted = json.loads(on_disk.read_text())
    planted["created"] = "2019-01-01T00:00:00Z"
    planted["finished"] = "2019-01-01T00:00:00Z"
    on_disk.write_text(json.dumps(planted))
    # The DIRECTORY's mtime is aged too, so an age ceiling that went by the
    # volume's own dates rather than by the record would be caught here as well:
    # a directory this old holding a readable record must be left where it is.
    old = 0.0
    os.utime(store.root / job_id, (old, old))

    reopened = JobStore(tmp_path / "data")
    kept = reopened.get(job_id)
    assert kept is not None, "a job was dropped for being old"
    assert kept["created"] == "2019-01-01T00:00:00Z", (
        "the stamp was rewritten; nothing measures it any more, so nothing "
        "should be correcting it either")
    assert reopened.log(job_id) == "ancient"


def test_no_number_of_comments_on_one_build_is_refused(hub):
    """A review is as long as it is: 120 comments on one build, all accepted.

    One build, one uninterrupted run, on default settings: the shape a per-build
    wall at a hundred or a rate limit of thirty per ten minutes would catch.
    Every reply is checked, since a ceiling that fires mid-way leaves a
    green-looking last answer.
    """
    hub.publish("proj1", "c1", _build("v1", "2026-08-01T00:00:00Z"))

    ids = []
    for index in range(COMMENTS):
        reply = hub.post_comment("proj1", "c1",
                                 comment_payload(text=f"note {index}"))
        assert reply.status_code == 201, (
            f"comment {index + 1} of {COMMENTS} was refused with "
            f"{reply.status_code}: {reply.text}")
        ids.append(reply.json()["id"])

    # Accepted is half of it. The other half is that none of the earlier ones
    # was quietly dropped to make room — the failure mode a count ceiling has
    # when somebody implements it as eviction rather than refusal.
    assert len(set(ids)) == COMMENTS
    on_disk = {p.stem for p in hub.comment_dir("proj1").glob("*.json")}
    assert on_disk == set(ids)

    # And the queue an agent reads hands back every one of them, text and all.
    # Compared as SETS, not as sequences: `created` has one-second resolution and
    # a hundred and twenty comments land inside a second or two, so the listing
    # falls back to sorting by a random uuid. Insertion order is not a promise
    # this endpoint makes, and asserting it here would make this test fail for a
    # reason that has nothing to do with ceilings.
    listed = hub.read_comments().json()["comments"]
    assert {c["id"] for c in listed} == set(ids)
    assert ({c["text"] for c in listed}
            == {f"note {i}" for i in range(COMMENTS)})
