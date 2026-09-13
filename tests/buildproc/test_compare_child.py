"""`comparechild` — the walk that turns two build directories into a report.

THE ENGINE IS STUBBED HERE AND THE WALK IS NOT, which is the opposite way round
from `tests/cadbuild/test_shapediff.py` and is the whole reason this file exists.
What `src.cadbuild.shapediff` measures is geometry and needs the CAD kernel; what
this module does with those measurements is a decision tree — skip the kernel
when the bytes are equal, print a reason instead of numbers when the gate says
so, call `drop_slivers` only after that gate and let it change the verdict — and
none of it involves a solid. `_compare` takes the engine as an argument for
exactly this reason, so the tree can be walked on a python with no CAD stack.

WHAT MUST NOT BECOME AN EXIT CODE is half of what is pinned below: a part the
kernel could not measure is a LINE, because "eleven parts moved and the twelfth
could not be measured" is an answer and an exit code is not. What is left as a
failure is the run not happening at all — a bad invocation, an uncappable pool —
and those are the codes `runner._compare_outcome` reads.
"""

import hashlib
import json
from pathlib import Path

import pytest

from src.buildproc import comparechild
from src.buildproc.child import EXIT_INVOCATION

STEP_A = b"ISO-10303-21;\nDATA;\n#1=SOLID('a');\nENDSEC;\n"
STEP_B = b"ISO-10303-21;\nDATA;\n#1=SOLID('b');\nENDSEC;\n"


class Engine:
    """`shapediff`'s three steps, with no geometry behind them.

    `step_digest` is not stubbed at all — it is a sha256 of the file in the real
    engine too, and the fast path it feeds is about equal BYTES, which no kernel
    is needed to decide. The other three answer from a table the test writes, so
    a test says "this part is unmeasurable" instead of building a solid that is.
    """

    def __init__(self, measurements=None):
        self.measurements = measurements or {}
        self.measured = []
        self.filtered = []

    def step_digest(self, path):
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()

    def measure(self, old_step, new_step):
        stem = Path(old_step).stem
        self.measured.append(stem)
        return self.measurements[stem]

    def check(self, measurement):
        return measurement["reason"]

    def drop_slivers(self, measurement):
        self.filtered.append(measurement)
        # The real one leaves the totals alone and only shrinks the lists, which
        # is what makes an empty list the only thing this can change.
        return dict(
            measurement,
            removed=[p for p in measurement["removed"] if not p.get("sliver")],
            added=[p for p in measurement["added"] if not p.get("sliver")])


def measurement(added=0.0, removed=0.0, reason=None, sliver=False):
    """One `measure` answer, in the shape `shapediff` returns."""
    piece = {"volume_mm3": max(added, removed), "area_mm2": 1.0}
    if sliver:
        piece["sliver"] = True
    return {
        "reason": reason,
        "added_mm3": added, "removed_mm3": removed,
        "added": [dict(piece)] if added else [],
        "removed": [dict(piece)] if removed else [],
    }


def build_dir(root, name, parts, volumes=None):
    """A published build directory: its STEP files and its metrics.json."""
    directory = root / name
    directory.mkdir()
    for stem, body in parts.items():
        (directory / f"{stem}.step").write_bytes(body)
    if volumes is not None:
        (directory / "metrics.json").write_text(json.dumps({
            "parts": {stem: {"volume_mm3": value}
                      for stem, value in volumes.items()}}), encoding="utf-8")
    return directory


def report(capsys):
    return capsys.readouterr().out


# -- the walk ----------------------------------------------------------------
def test_a_part_whose_bytes_did_not_move_never_reaches_the_kernel(tmp_path,
                                                                  capsys):
    """The one sound direction of the fast path, and the cheap one.

    Equal bytes are equal geometry, so there is nothing to fuse. (The converse
    is not true and is not claimed anywhere: a STEP header carries a timestamp,
    so different bytes mean nothing on their own.)
    """
    engine = Engine()
    old = build_dir(tmp_path, "old", {"lid": STEP_A, "pin": STEP_A})
    new = build_dir(tmp_path, "new", {"lid": STEP_A, "pin": STEP_A})

    comparechild._compare(engine, old, new)

    assert engine.measured == []
    out = report(capsys)
    assert "  lid: unchanged" in out and "  pin: unchanged" in out
    assert "2 unchanged" in out


def test_a_changed_part_reports_what_was_added_and_what_was_removed(tmp_path,
                                                                    capsys):
    """BOTH NUMBERS, which is the entire reason this half of `diff` exists.

    `metrics.json` already says the volume dropped by 40 mm3; it cannot say that
    120 went and 80 arrived somewhere else on the same part.
    """
    engine = Engine({"lid": measurement(added=80.0, removed=120.0)})
    old = build_dir(tmp_path, "old", {"lid": STEP_A})
    new = build_dir(tmp_path, "new", {"lid": STEP_B})

    comparechild._compare(engine, old, new)

    out = report(capsys)
    assert "  lid: +80.000 mm3 added, -120.000 mm3 removed" in out
    assert "1 changed" in out


def test_a_part_the_gate_refuses_is_a_line_and_the_walk_carries_on(tmp_path,
                                                                   capsys):
    """The refusal is `shapediff.check`'s sentence, printed where the numbers
    would have been — and the NEXT part is still compared, because a report that
    stopped at the first unmeasurable part would be worth less than one that
    says which part it could not do."""
    engine = Engine({
        "lid": measurement(reason="the fused volume does not add up"),
        "pin": measurement(added=5.0),
    })
    old = build_dir(tmp_path, "old", {"lid": STEP_A, "pin": STEP_A})
    new = build_dir(tmp_path, "new", {"lid": STEP_B, "pin": STEP_B})

    comparechild._compare(engine, old, new)

    out = report(capsys)
    assert "  lid: not measured -- the fused volume does not add up" in out
    assert "  pin: +5.000 mm3 added" in out
    assert "1 changed" in out and "1 not measured" in out
    # And the refused part was never filtered: `drop_slivers` may only run over
    # a measurement the gate vouched for, because its identities are sums over
    # every piece.
    assert engine.filtered == [engine.measurements["pin"]]


def test_a_difference_made_only_of_slivers_is_reported_as_unchanged(tmp_path,
                                                                    capsys):
    """WHAT CALLING `drop_slivers` IS FOR, and the only thing it can change.

    It leaves `added_mm3` and `removed_mm3` exactly as measured — so the totals
    are not what says "nothing happened here". The filtered LISTS coming back
    empty is: the two solids differ, and everything the fuse found between them
    is thinner than the kernel's own noise.
    """
    engine = Engine({"lid": measurement(added=1e-9, sliver=True)})
    old = build_dir(tmp_path, "old", {"lid": STEP_A})
    new = build_dir(tmp_path, "new", {"lid": STEP_B})

    comparechild._compare(engine, old, new)

    out = report(capsys)
    assert "  lid: unchanged (only slivers)" in out
    assert "1 unchanged" in out and "0 changed" in out


def test_a_part_the_fuse_found_nothing_in_says_only_unchanged(tmp_path, capsys):
    """"unchanged" AND NOT "unchanged (only slivers)" — the ORDINARY case.

    A STEP header carries a timestamp, so a part nobody touched still fails the
    digest fast path above and gets fused anyway; the fuse then finds nothing
    between two identical solids and both lists come back empty without a
    sliver ever being dropped. Saying "only slivers" about that would have most
    of a report accusing untouched parts of drifting on numerical noise, so the
    sentence stays with the case the previous test pins: pieces were found, and
    every one of them was thinner than the kernel's own noise.
    """
    engine = Engine({"lid": measurement()})
    old = build_dir(tmp_path, "old", {"lid": STEP_A})
    new = build_dir(tmp_path, "new", {"lid": STEP_B})

    comparechild._compare(engine, old, new)

    assert engine.measured == ["lid"]
    out = report(capsys)
    assert "  lid: unchanged\n" in out
    assert "only slivers" not in out
    assert "1 unchanged" in out


def test_a_part_whose_file_cannot_be_read_is_a_line_and_not_a_crash(tmp_path,
                                                                    capsys):
    """THE SAME CONTRACT AS THE GATE'S REFUSAL, for the failures that RAISE.

    `data/` is one volume every build can write anywhere in, so a `lid.step`
    that is a directory rather than a file is an ordinary `model.py` mistake.
    Letting that `OSError` out of the walk would throw away every part already
    measured and end the job as a crash with no report at all.
    """
    engine = Engine({"pin": measurement(added=5.0)})
    old = build_dir(tmp_path, "old", {"pin": STEP_A})
    new = build_dir(tmp_path, "new", {"pin": STEP_B})
    (old / "lid.step").mkdir()
    (new / "lid.step").mkdir()

    comparechild._compare(engine, old, new)

    out = report(capsys)
    assert "  lid: not measured -- " in out
    assert "  pin: +5.000 mm3 added" in out
    assert "1 changed" in out and "1 not measured" in out


def test_a_part_only_one_revision_has_is_named_with_its_recorded_volume(
        tmp_path, capsys):
    """NO KERNEL FOR THESE, and that is the point of reading metrics.json.

    There is nothing to fuse a new part against, so the number beside it is the
    one the build already wrote down — and the engine is not called at all.
    """
    engine = Engine()
    old = build_dir(tmp_path, "old", {"lid": STEP_A}, volumes={"lid": 300.5})
    new = build_dir(tmp_path, "new", {"pin": STEP_B}, volumes={"pin": 12.25})

    comparechild._compare(engine, old, new)

    assert engine.measured == []
    out = report(capsys)
    assert "  pin: new in new, volume 12.250 mm3" in out
    assert "  lid: gone since old, volume was 300.500 mm3" in out
    assert "1 new" in out and "1 removed" in out


def test_a_part_with_no_recorded_volume_is_still_named(tmp_path, capsys):
    """The part is the news and the number is what would have been nice.

    A build published before the model wrote metrics.json — or one whose
    document does not carry this part — costs the number, not the line.
    """
    engine = Engine()
    old = build_dir(tmp_path, "old", {})
    new = build_dir(tmp_path, "new", {"pin": STEP_B}, volumes={"lid": 1.0})

    comparechild._compare(engine, old, new)

    out = report(capsys)
    assert "  pin: new in new" in out
    assert "mm3" not in out


def test_the_report_opens_by_saying_what_is_being_compared(tmp_path, capsys):
    """The first line, before any part: which two builds, and how many parts.

    A count of zero is a real answer and reads as one — a revision that
    published no STEP files at all is a build that exported nothing.
    """
    engine = Engine()
    old = build_dir(tmp_path, "old", {})
    new = build_dir(tmp_path, "new", {})

    comparechild._compare(engine, old, new)

    assert report(capsys).splitlines()[0] == "comparing old -> new, 0 parts"


# -- being called wrongly ----------------------------------------------------
@pytest.mark.parametrize("argv", [
    [],                                             # neither directory
    ["--old-dir", "/tmp/old"],                      # only one of them
    ["--new-dir", "/tmp/new"],
    ["--old-dir", "/tmp/old", "--new-dir"],         # a flag with no value
    ["--old-dir", "/tmp/old", "--new-dir", "/tmp/new", "--wat", "1"],
    ["--old-dir", "/tmp/old", "--new-dir", "/tmp/new", "--occt-threads", "0"],
    ["--old-dir", "/tmp/old", "--new-dir", "/tmp/new", "--occt-threads", "x"],
])
def test_a_wrong_invocation_is_its_own_exit_code(argv, capsys):
    """5 AND NOT A TRACEBACK, which is the difference the LOG shows.

    Nothing here is a user's mistake — the argv is composed by
    `runner.run_compare` — so this code says the HUB has a bug, and it is
    answered by returning rather than by raising: one sentence lands in the log
    where an exception would have put a stack. It is also answered before
    anything imports the kernel.
    """
    assert comparechild.main(["comparechild", *argv]) == EXIT_INVOCATION
    assert "compareproc:" in capsys.readouterr().err


def test_a_build_directory_that_is_gone_is_an_invocation_error(tmp_path,
                                                               monkeypatch,
                                                               capsys):
    """CHECKED RATHER THAN WALKED INTO, and BEFORE THE KERNEL IS IMPORTED.

    `Path.glob` on a directory that does not exist yields nothing and raises
    nothing, so without this check the report would say "0 parts" and exit 0 —
    which reads as "that build exported nothing" rather than "that build is not
    there". The route checked both directories before the job was queued; what
    puts them back here is the same EDIT_TOKEN erasing the project in the window
    between the queue and this process.

    The spy is the other half, and it is the half that has to be a test rather
    than a comment: `_cap_occt_threads` is the line that imports the kernel
    (`OCP.OSD`, measured at 271 MB resident against 12 MB for a bare
    interpreter), so a check standing after it saves nothing at all. Asserting
    the cap was never reached is what keeps the order from drifting back — and
    it is also what lets this test run on a machine with no kernel on it.
    """
    capped = []
    monkeypatch.setattr(comparechild, "_cap_occt_threads", capped.append)
    old = build_dir(tmp_path, "old", {})
    gone = tmp_path / "gone"

    code = comparechild.main(["comparechild", "--old-dir", str(old),
                              "--new-dir", str(gone)])

    assert code == EXIT_INVOCATION
    assert f"--new-dir {gone} is not a directory" in capsys.readouterr().err
    assert capped == []
