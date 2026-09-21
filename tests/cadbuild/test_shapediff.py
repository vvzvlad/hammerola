"""The revision diff: the arithmetic that gates an answer, and one real fuse.

The module under test is split where the CAD kernel is, and so is this file.
Everything except the last test runs on a python that has no OCCT at all --
which is any machine without the kernel, CI's container having it (issue #27) --
because the rule that decides whether a measurement
may be shown is arithmetic over a dict, and a dict can be typed by hand. The
last test is the one that has to agree with the kernel, so it skips where the
kernel is missing and `make cad-test` is what runs it.

The gate tests all break ONE thing about the same consistent measurement, so
each proves that the rule it is named for is what fired, rather than that some
mess was caught somewhere on the way past.
"""

import hashlib
import os
import threading

import pytest

from src.cadbuild.shapediff import (check, drop_slivers, measure,
                                    step_digest)

# Long enough that a loaded machine never trips it, short enough that a wedged
# open is reported rather than waited out. The digest under test takes
# microseconds.
DEADLINE_SECONDS = 5


def _measurement(**overrides):
    """A part of 1000 mm3 that became 1200: 100 mm3 cut away, 300 mm3 added."""
    base = {
        "reason": None,
        "volume_a": 1000.0,
        "volume_b": 1200.0,
        "common_mm3": 900.0,
        "removed_mm3": 100.0,
        "added_mm3": 300.0,
        "removed": [],
        "added": [],
        "bboxes_overlap": True,
    }
    base.update(overrides)
    return base


def test_a_measurement_that_could_not_be_taken_hands_its_reason_on():
    """One place to ask whether an answer may be believed, refusals included.

    The dict `measure` returns when it could not measure carries ONLY `reason`
    -- no volumes, no lists -- so this is not merely a convenience: it is what
    makes the order of the rules in `check` load-bearing. A rule moved above
    this branch, or a `volume_a` lifted out of one, turns every unreadable STEP
    and every two-bodied part into a KeyError in the hub instead of a sentence
    the owner can read, and the arithmetic tests below would all stay green.
    """
    assert check({"reason": "b.step holds 2 solids"}) == "b.step holds 2 solids"


def test_the_sliver_filter_refuses_a_measurement_that_was_never_taken():
    """`drop_slivers` before `check` is a KeyError, and that is the contract.

    Called in the right order this input cannot arrive; called in the wrong one
    it is the FIRST thing that does. Pinned here because the docstring saying
    so is an assertion about behaviour, and those belong in a test.
    """
    with pytest.raises(KeyError):
        drop_slivers({"reason": "a.step is not a STEP file this kernel can read"})


def test_a_revision_that_measures_no_volume_is_refused():
    # The consistent measurement every test below starts from is accepted, so
    # none of them is passing merely because the gate refuses everything.
    assert check(_measurement()) is None

    assert "no volume" in check(_measurement(volume_a=0.0))
    assert "no volume" in check(_measurement(volume_b=-1.0))


def test_pieces_that_do_not_add_up_to_a_are_refused():
    reason = check(_measurement(removed_mm3=100.5))
    assert reason is not None and "pieces of A" in reason


def test_pieces_that_do_not_add_up_to_b_are_refused():
    reason = check(_measurement(added_mm3=300.5))
    assert reason is not None and "pieces of B" in reason


def test_a_net_change_that_misses_the_change_in_volume_is_refused():
    """The rule that only bites when the two identities above lean apart.

    Each of them passing bounds this one to twice their own tolerance and no
    tighter, so the case to build is both of them sitting just inside the
    tolerance in OPPOSITE directions: A short by 9e-4 mm3 (9e-7 of A) and B
    long by the same (7.5e-7 of B), which is a net change wrong by 1.8e-3 mm3
    -- 1.5e-6 of the larger volume, and over the line.
    """
    leaning_apart = _measurement(removed_mm3=100.0 - 9e-4,
                                 added_mm3=300.0 + 9e-4)
    reason = check(leaning_apart)
    assert reason is not None and "net change" in reason


def test_a_zero_intersection_under_overlapping_boxes_is_refused():
    """The boolean's silent lie -- see the rule's own comment for the measurement."""
    disjoint = _measurement(common_mm3=0.0, removed_mm3=1000.0,
                            added_mm3=1200.0)
    reason = check(disjoint)
    assert reason is not None and "share no volume" in reason
    # And it is the overlap that makes it a lie: two revisions whose boxes do
    # not even meet really can share nothing.
    assert check(dict(disjoint, bboxes_overlap=False)) is None


def test_a_sliver_is_dropped_and_the_volume_it_took_with_it_is_reported():
    sliver = {"volume_mm3": 1e-9, "area_mm2": 200.0}    # 2V/S = 1e-11 mm
    real = {"volume_mm3": 100.0, "area_mm2": 240.0}     # 2V/S = 0.83 mm
    raw = _measurement(removed=[real, sliver], added=[sliver])

    filtered = drop_slivers(raw)

    assert filtered["removed"] == [real]
    assert filtered["added"] == []
    assert filtered["removed_slivers_mm3"] == 1e-9
    assert filtered["added_slivers_mm3"] == 1e-9
    # The totals the gate reads are the raw ones still, which is what keeps the
    # filter from breaking the identity that checks it.
    assert filtered["removed_mm3"] == raw["removed_mm3"]
    assert filtered["added_mm3"] == raw["added_mm3"]
    assert check(filtered) is None


def test_a_kept_shape_rides_through_the_sliver_filter_and_a_sliver_takes_its_own():
    """`keep_shapes` puts the solid on the piece, and the filter is upstream of
    the scene: what a sliver must not reach is the picture as much as the log.

    The shapes here are sentinels rather than solids because that is all the
    filter ever sees of one -- it reads the two floats beside it and nothing
    else, which is exactly what the option was shaped not to disturb.
    """
    sliver = {"volume_mm3": 1e-9, "area_mm2": 200.0, "shape": "<sliver>"}
    real = {"volume_mm3": 100.0, "area_mm2": 240.0, "shape": "<solid>"}

    filtered = drop_slivers(_measurement(removed=[real, sliver]))

    assert [piece["shape"] for piece in filtered["removed"]] == ["<solid>"]
    assert filtered["removed_slivers_mm3"] == 1e-9


def test_a_ten_micron_difference_survives_the_sliver_filter():
    """10 um is the smallest change this must never hide -- one layer.

    A 10 x 10 mm patch 10 um thick is 1 mm3 over 200.4 mm2: a characteristic
    thickness of 9.98e-3 mm, three orders above the threshold, which is where
    SLIVER_THICKNESS_MM was put on purpose.
    """
    layer = {"volume_mm3": 10 * 10 * 0.01,
             "area_mm2": 2 * 10 * 10 + 4 * 10 * 0.01}

    filtered = drop_slivers(_measurement(removed=[layer]))

    assert filtered["removed"] == [layer]
    assert filtered["removed_slivers_mm3"] == 0.0


def test_the_digest_is_the_bytes_and_a_difference_in_it_says_nothing(tmp_path):
    """Equal digests are the whole answer; different ones are not an answer.

    Two exports of one unchanged shape differ in the header STEP stamps them
    with, so the caller may skip the kernel on a match and may conclude nothing
    at all from a mismatch.
    """
    payload = b"ISO-10303-21;\nHEADER;\n"
    one, other, changed = (tmp_path / "one.step", tmp_path / "other.step",
                           tmp_path / "changed.step")
    one.write_bytes(payload)
    other.write_bytes(payload)
    changed.write_bytes(payload + b" ")

    assert step_digest(one) == hashlib.sha256(payload).hexdigest()
    assert step_digest(one) == step_digest(other)
    assert step_digest(one) != step_digest(changed)


@pytest.mark.skipif(not hasattr(os, "mkfifo"),
                    reason="this platform has no os.mkfifo, so no fifo can "
                           "reach the volume")
def test_a_part_that_is_a_fifo_is_refused_rather_than_waited_on(tmp_path):
    """THE FIRST TOUCH OF EACH FILE, and the reason it is not a plain `open`.

    `mkfifo` needs no privilege and `data/` is one volume every build can write
    anywhere in, so a `lid.step` that is a fifo is an ordinary `model.py`
    mistake. A plain open on one never returns; this digest runs before
    `measure` on every part, which is what makes it the place to refuse — a few
    lines further on, OCCT's own `ReadFile` would block in C++ with no way back
    at all. The refusal is an `OSError`, which is what lets `comparechild` turn
    it into one part's line instead of losing the whole report.

    The deadline is a daemon thread rather than an alarm: `signal.alarm` fires
    only on the main thread, and without it a regression here would hang the
    suite instead of failing it.
    """
    path = tmp_path / "lid.step"
    os.mkfifo(path)
    box = {}

    def run():
        try:
            box["value"] = step_digest(path)
        except BaseException as error:  # noqa: BLE001 - reported, not handled
            box["error"] = error

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join(timeout=DEADLINE_SECONDS)

    assert not thread.is_alive(), (
        f"step_digest did not come back within {DEADLINE_SECONDS}s on a fifo — "
        f"this is the defect open_regular is here to prevent")
    assert isinstance(box.get("error"), OSError), box


def test_two_real_step_files_measure_the_change_between_them(tmp_path):
    """The one test here that runs the kernel, and the only one that can.

    Everything above is arithmetic over a dict somebody typed. This is the half
    that has to agree with OCCT, and it asserts two things. A part compared
    with ITSELF is wholly common -- the assertion that fails without the
    same-domain map, where the two copies of every face look like two different
    shapes and the whole part comes out removed and added again. And a groove
    widened from 4 mm to 6 mm takes 2 x 20 x 3 mm out of the part and puts
    nothing back, which is a number to be counted by hand rather than read off
    the run.

    Skips where the kernel is missing, like every other test that needs real
    geometry; CI's container installs it (issue #27), and `make cad-test` runs
    this one without the rest of the suite.
    """
    cq = pytest.importorskip("cadquery", exc_type=ImportError,
                             reason="a real boolean needs the CAD kernel")

    def grooved(width):
        # moveTo, so the groove grows on ONE side: centred, a widening would
        # take a slab off either wall and the difference would be two pieces.
        return (cq.Workplane("XY").box(20, 20, 10)
                .faces(">Z").workplane()
                .moveTo(width / 2, 0).rect(width, 20).cutBlind(-3))

    def written_like_the_hub_writes_it(shape, path):
        # THROUGH AN ASSEMBLY, because that is what puts the bytes this engine
        # will actually be handed: `printables.export_printables` exports every
        # `<part>.step` as `cq.Assembly(obj, name=name)` and not through
        # `cq.exporters.export`. It is a different writer -- XCAF, a different
        # product structure in the file -- and `_one_solid` counts solids in
        # whatever structure it finds.
        cq.Assembly(shape, name="part").export(str(path), exportType="STEP")

    narrow, wide = tmp_path / "a.step", tmp_path / "b.step"
    written_like_the_hub_writes_it(grooved(4), narrow)
    written_like_the_hub_writes_it(grooved(6), wide)

    volume_a = 20 * 20 * 10 - 4 * 20 * 3
    volume_b = 20 * 20 * 10 - 6 * 20 * 3

    same = measure(narrow, narrow)
    assert check(same) is None
    assert same["common_mm3"] == pytest.approx(volume_a, rel=1e-6)
    assert same["removed_mm3"] == 0.0 and same["added_mm3"] == 0.0
    assert same["removed"] == [] and same["added"] == []

    widened = measure(narrow, wide)
    assert check(widened) is None
    assert widened["volume_a"] == pytest.approx(volume_a, rel=1e-6)
    assert widened["volume_b"] == pytest.approx(volume_b, rel=1e-6)
    assert widened["common_mm3"] == pytest.approx(volume_b, rel=1e-6)
    assert widened["removed_mm3"] == pytest.approx(2 * 20 * 3, rel=1e-6)
    assert widened["added_mm3"] == 0.0
    assert widened["added"] == []
    assert [piece["volume_mm3"] for piece in widened["removed"]] == \
        [pytest.approx(2 * 20 * 3, rel=1e-6)]
    assert widened["bboxes_overlap"]
