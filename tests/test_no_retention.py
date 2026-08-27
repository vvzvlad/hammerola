"""Nothing is ever thrown away, or refused, for being one too many (SPEC 5.3, 7.3, 7A.4).

There used to be two retention windows here — the newest N builds per project,
and 200 jobs for 14 days — and both were removed by the decision of 2026-08-27:
a revision is tens of megabytes, disk is cheaper than a mechanism that has to be
written, tested, explained and that can delete the wrong thing.

THE COMMENT CEILINGS WENT WITH THEM, and they belong in this file even though
they never deleted anything. A comment ceiling refused the NEXT comment instead
of dropping an old one, which made it the harsher of the two shapes: nothing here
deletes a comment, so a build that reached its hundredth could never be commented
on again. Same decision, same reasoning, same units — a JSON file and a photo on
a volume that is allowed to grow. The rate limit that used to sit in front of
them went too, but for a different reason and it is tested elsewhere by its
absence from the codebase: writing takes EDIT_TOKEN, and whoever holds EDIT_TOKEN
can delete the project outright.

THE ABSENCE OF A MECHANISM IS WHAT THIS FILE TESTS, which is worth saying out
loud because absences do not fail on their own. Every other test in the suite
publishes a handful of builds and posts two or three comments, and would pass
unchanged with a window of twenty quietly put back; the numbers below are
deliberately past the ceilings that used to exist (20 builds, 200 jobs, 100
comments per build), so a reintroduced one fails here rather than in production a
month later, on somebody's oldest revision or in the middle of a review.
"""

import json
import os

from harness import comment_payload, meta_bytes, tar_gz, view_bytes

from src.jobs import STATE_DONE, JobStore

# One past RETENTION_BUILDS, which was 20. Small enough that the suite stays
# fast, large enough that the ceiling that used to be here would fire.
BUILDS = 25

# One past MAX_JOBS, which was 200. Records only — no build runs for these, and
# none needs to: what is under test is whether the registry drops any.
JOBS = 205

# Past BOTH ceilings a comment used to meet: COMMENT_MAX_PER_BUILD was 100, and
# COMMENT_RATE_LIMIT was 30 per ten minutes — which this test would also trip,
# since the suite no longer raises a rate limit out of the way and a reinstated
# one would arrive with its production default. All on ONE build, because the
# per-build wall was the terminal one.
COMMENTS = 120


def _build(marker, built):
    return tar_gz({
        "meta.json": meta_bytes(built=built),
        "assembled.json": view_bytes(marker),
    })


def _commits_on_disk(hub, pid):
    return sorted(p.name for p in hub.project_dir(pid).iterdir()
                  if p.is_dir() and not p.is_symlink()
                  and not p.name.startswith("."))


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
    """The carve-out is gone because there is nothing left to carve out of.

    Retention refused to delete the target of `latest`, which meant every
    OTHER build was fair game — a rollback that pinned the symlink at an old
    revision protected exactly one build and no more. With no window at all the
    question does not arise, and this is the state that used to be the dangerous
    one: a pointer parked on the oldest build while pushes keep arriving.
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
    """Registry only: `create` and `finish`, past the count ceiling that was.

    Driven through `JobStore` rather than through pushes because a push per job
    would be 205 builds; what is under test is the registry's own bookkeeping,
    and `create`/`finish` are the two places a sweep used to run.
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

    # And they are still all there after a restart, which is the other place a
    # count ceiling used to be applied — before the records were even read.
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
    # The DIRECTORY's mtime is aged too. `_sweep_strangers` goes by mtime, and
    # this is what proves it is not reaching a real job: a directory this old
    # holding a readable record must be left exactly where it is.
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

    Deliberately on ONE build and in one uninterrupted run, because that is the
    shape both removed mechanisms would have caught — the per-build wall at a
    hundred and the rate limit at thirty per ten minutes. Every reply is checked,
    not just the last: a ceiling that fires mid-way leaves a green-looking suffix
    if only the final answer is read.

    One build carries all of them and the hub runs on its default settings — a
    test that raised a ceiling out of its own way would be testing the override
    rather than the absence.
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
