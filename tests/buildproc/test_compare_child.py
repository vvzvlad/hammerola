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

THE SCENE MODULE IS STUBBED THE SAME WAY THE ENGINE IS, and it has to be: it is
`src.cadbuild.comparescene`, it tessellates, and it is imported by this module
only inside the branch that writes an artefact. What belongs here is which
documents it is handed, which parts reach it, and that the two files land — not
what a scene looks like.
"""

import ast
import hashlib
import json
import sys
from pathlib import Path

import pytest

from src import cadbuild
# THE REAL REPORT HALF, and it costs nothing to import: `comparescene` is
# arithmetic over dicts at the top and every import that reaches for a kernel is
# inside the one function that tessellates. What the test below needs from it is
# exactly what CI can run.
from src.cadbuild import comparescene
from src.buildproc import comparechild
from src.buildproc.child import EXIT_INVOCATION, EXIT_OK

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
        self.kept_shapes = []
        self.filtered = []

    def step_digest(self, path):
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()

    def measure(self, old_step, new_step, *, keep_shapes=False):
        # DEFAULTED HERE AND PASSED ONLY IN ONE MODE, exactly as the real
        # engine takes it: the walk that only prints a report asks for numbers,
        # and the solids behind them are what a scene costs.
        stem = Path(old_step).stem
        self.measured.append(stem)
        self.kept_shapes.append(keep_shapes)
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


class Scene:
    """`src.cadbuild.comparescene`, with nothing tessellated behind it.

    Both functions record what they were handed and answer with something JSON
    can hold. What the child owes the geometry half is the ARGUMENTS — the two
    published view documents, the difference geometry per part, and the view id
    — so those are what this remembers. BOTH halves take the documents, because
    both describe the parts that view shows and neither is told them any other
    way.
    """

    def __init__(self):
        self.scene_calls = []
        self.report_calls = []

    def build_scene(self, document_a, document_b, diffs, *, view_id):
        self.scene_calls.append((document_a, document_b, diffs, view_id))
        return {"name": "cmp", "view": view_id}

    def report(self, diffs, document_a, document_b, *, view_id, refused,
               covered):
        # WHAT NOBODY MEASURED GOES TO THIS HALF AND NOT TO THE OTHER, which is
        # the asymmetry the real pair has: neither a refused measurement nor a
        # part the walk never saw has pieces to draw, and both have a word of
        # their own to publish.
        self.report_calls.append((diffs, document_a, document_b, view_id,
                                  refused, covered))
        return {"parts": sorted(diffs), "totals": {"changed": len(diffs)},
                "refused": sorted(refused), "covered": sorted(covered)}


def view_document(marker):
    return {"name": "/cmp", "parts": [{"name": marker}]}


IDENTITY_LOC = [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]]


def published_view(*keys):
    """A view document in the shape `views.export_views` publishes one.

    Enough of one for the REAL `comparescene` to read: a root with a version and
    a bounding box, and one leaf per part carrying the catalogue key both halves
    name it by. `view_document` above is the marker the stubbed scene is handed
    and cannot be read by anything.
    """
    return {"version": 3, "name": "Group", "id": "/Group",
            "loc": IDENTITY_LOC, "normal_len": 0,
            "bb": {"xmin": 0.0, "ymin": 0.0, "zmin": 0.0,
                   "xmax": 1.0, "ymax": 1.0, "zmax": 1.0},
            "parts": [{"id": f"/Group/{key}", "name": key, "key": key,
                       "loc": IDENTITY_LOC, "shape": {"vertices": []},
                       "color": "#c9a227", "alpha": 1.0} for key in keys]}


def with_view(directory, view, marker):
    """Put a published view document into a build directory. -> that directory."""
    (directory / f"{view}.json").write_text(json.dumps(view_document(marker)),
                                            encoding="utf-8")
    return directory


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


# -- the artefact ------------------------------------------------------------
@pytest.mark.parametrize("extra", [
    ["--out-dir", "/tmp/out"],                     # nowhere to put a scene of
    ["--view", "assembled"],                       # nothing to build one from
])
def test_the_output_directory_and_the_view_go_together(extra, tmp_path,
                                                       capsys):
    """Either alone is the hub composing a command line wrong.

    A directory with no view names no scene to build; a view with no directory
    names nowhere to put one. Refused rather than defaulted, and refused by the
    parser — so it costs one exit code and no kernel.
    """
    old = build_dir(tmp_path, "old", {})
    new = build_dir(tmp_path, "new", {})

    code = comparechild.main(["comparechild", "--old-dir", str(old),
                              "--new-dir", str(new), *extra])

    assert code == EXIT_INVOCATION
    assert "--out-dir and --view go together" in capsys.readouterr().err


def test_an_output_directory_that_is_not_there_is_an_invocation_error(
        tmp_path, monkeypatch, capsys):
    """The parent creates it (`store.compare_staging`), so its absence is a bug
    here — and one worth catching BEFORE the kernel is imported, for the reason
    the missing-build-directory test gives: the check standing after the cap
    saves nothing."""
    capped = []
    monkeypatch.setattr(comparechild, "_cap_occt_threads", capped.append)
    old = with_view(build_dir(tmp_path, "old", {}), "assembled", "a")
    new = with_view(build_dir(tmp_path, "new", {}), "assembled", "b")
    gone = tmp_path / "out"

    code = comparechild.main([
        "comparechild", "--old-dir", str(old), "--new-dir", str(new),
        "--out-dir", str(gone), "--view", "assembled"])

    assert code == EXIT_INVOCATION
    assert f"--out-dir {gone} is not a directory" in capsys.readouterr().err
    assert capped == []


def test_a_view_a_revision_never_published_is_an_invocation_error(
        tmp_path, monkeypatch, capsys):
    """A scene is built out of BOTH documents, so one of them missing is a run
    that cannot produce anything — and finding that out after every part has
    been fused costs the whole comparison for an answer one stat had."""
    capped = []
    monkeypatch.setattr(comparechild, "_cap_occt_threads", capped.append)
    old = with_view(build_dir(tmp_path, "old", {}), "assembled", "a")
    new = build_dir(tmp_path, "new", {})
    out = tmp_path / "out"
    out.mkdir()

    code = comparechild.main([
        "comparechild", "--old-dir", str(old), "--new-dir", str(new),
        "--out-dir", str(out), "--view", "assembled"])

    assert code == EXIT_INVOCATION
    assert "--view assembled is not a view of new" in capsys.readouterr().err
    assert capped == []
    assert list(out.iterdir()) == []


def test_the_shapes_are_kept_only_when_an_artefact_is_asked_for(tmp_path,
                                                                capsys):
    """What `keep_shapes` costs is what a report does not need.

    The pieces the fuse found are solids, and keeping them is what makes them
    drawable; a walk that only prints "+80 mm3 added" has no use for one. So the
    log-only mode calls the engine exactly as it always did.
    """
    engine = Engine({"lid": measurement(added=80.0)})
    old = build_dir(tmp_path, "old", {"lid": STEP_A})
    new = build_dir(tmp_path, "new", {"lid": STEP_B})

    comparechild._compare(engine, old, new)
    assert engine.kept_shapes == [False]

    comparechild._compare(engine, old, new, keep_shapes=True)
    assert engine.kept_shapes == [False, True]
    report(capsys)


def test_only_a_part_the_walk_called_changed_reaches_the_scene(tmp_path,
                                                               capsys):
    """THE CONTRACT BETWEEN THE TWO REPORTS, and it is three rules now: a part
    is in `diffs` exactly when the printed line said `changed`, in `refused`
    exactly when it said `not measured`, and in `covered` exactly when this walk
    COMPARED it -- which `new` and `removed` are not, because the two builds did
    not both export those parts and nothing was fused.

    The ways of being in neither are different news to a reader and the same
    news to both halves of an artefact — nothing changed here worth drawing —
    and a part that is in one report and not the other is the failure this
    prevents: `report.json` calling a part changed while the log says the gate
    refused to measure it.

    THE REFUSAL IS NOT IN `diffs` AND MUST NOT BE. A measurement `check` turned
    down carries only its reason, with no piece lists at all, so the scene has
    nothing it could draw for that part — and it says nothing about it, which is
    right. What the sentence buys is the ROW: `report` has a word for a part
    nobody could measure, and it is the word the log prints.
    """
    engine = Engine({
        "lid": measurement(added=80.0, removed=120.0),          # changed
        "pin": measurement(added=1e-9, sliver=True),            # only slivers
        "rib": measurement(),                                   # nothing found
        "cap": measurement(reason="the fused volume does not add up"),
    })
    old = build_dir(tmp_path, "old", dict.fromkeys(
        ("lid", "pin", "rib", "cap", "nut"), STEP_A))
    new = build_dir(tmp_path, "new", dict.fromkeys(
        ("lid", "pin", "rib", "cap", "bolt"), STEP_B))

    diffs, refused, covered = comparechild._compare(engine, old, new,
                                                    keep_shapes=True)

    assert sorted(diffs) == ["lid"]
    assert refused == {"cap": "the fused volume does not add up"}
    # Everything the walk actually put two solids (or two digests) together for,
    # and nothing else: `nut` and `bolt` were exported by one build each, so
    # nothing was established about how either of them changed.
    assert sorted(covered) == ["cap", "lid", "pin", "rib"]
    # The FILTERED measurement, so the pieces are the difference rather than the
    # kernel's noise — and its totals are the measured ones, which is what
    # `drop_slivers` promises to leave alone.
    assert diffs["lid"]["added_mm3"] == 80.0
    assert diffs["lid"]["removed_mm3"] == 120.0
    # Every exported part is still WALKED and still printed — the two the other
    # revision does not have included. What an artefact is about is decided by
    # the view documents and not here.
    printed = report(capsys)
    assert "  nut: gone since old" in printed
    assert "  bolt: new in new" in printed


def test_a_part_the_gate_refused_is_not_measured_in_the_document_too(tmp_path,
                                                                     capsys):
    """THE ROAD THE DEFECT TOOK, walked end to end with the real report half.

    `shapediff.check` refuses a measurement exactly where the kernel may have
    lied — a part moved 0.1 mm came back intersecting its own copy in nothing,
    with no errors to show for it (issue #10) — and the walk used to answer that
    refusal by keeping nothing at all. `report` then read the absence as the
    digest fast path and published `unchanged`: the job log said the part could
    not be measured and `report.json` beside it said the part did not change,
    which is a refusal to answer published as the most confident answer there
    is.

    ONLY THE ENGINE IS STUBBED HERE, because only the engine needs a kernel.
    The walk and the summary are the real ones, so this is the pair of accounts
    a reader actually gets, and the assertion is that they use the same word.
    """
    refusal = ("the two revisions share no volume at all while their bounding "
               "boxes overlap")
    engine = Engine({"lid": measurement(reason=refusal),
                     "pin": measurement(added=5.0)})
    old = build_dir(tmp_path, "old", {"lid": STEP_A, "pin": STEP_A})
    new = build_dir(tmp_path, "new", {"lid": STEP_B, "pin": STEP_B})
    shows_both = published_view("lid", "pin")

    diffs, refused, covered = comparechild._compare(engine, old, new,
                                                    keep_shapes=True)
    made = comparescene.report(diffs, shows_both, shows_both, view_id="iso",
                               refused=refused, covered=covered)

    lines = {line["key"]: line for line in made["parts"]}
    assert lines["lid"] == {"key": "lid", "status": "not measured",
                            "added_mm3": 0.0, "removed_mm3": 0.0,
                            "reason": refusal}
    # THE TWO ACCOUNTS OF ONE PART, and the word is the same in both.
    printed = report(capsys)
    assert f"  lid: not measured -- {refusal}" in printed
    assert "1 not measured" in printed
    # The part that WAS measured is untouched by any of this, and so are the
    # totals: nothing about a refusal may be added up.
    assert lines["pin"]["status"] == "changed"
    assert made["totals"] == {"added_mm3": 5.0, "removed_mm3": 0.0}


def test_a_part_no_build_exports_is_not_compared_in_the_document(
        tmp_path, capsys):
    """THE SECOND ROAD TO THE SAME DEFECT, walked end to end with both real
    halves.

    This walk is over `*.step` files and a build exports one per PRINTABLE, so a
    `hardware` or `mock` entry the view shows -- `reference_spacer` here, as in
    `ui/tests/fixtures/assembled.json` -- is a part it never sees. `report` used
    to read that absence from both maps as the digest fast path and publish
    `unchanged`, which is a confident claim about a part nothing looked at:
    swap an M3x8 for an M3x12 and the panel says "identical".

    AND IT IS `not compared` RATHER THAN THE GATE'S WORD, which is the routing
    this pair of processes has to agree on: the walk hands over `covered` and
    `refused` as two different maps, and only one of them is a part something
    went wrong on. Here nothing went wrong at all -- no build was ever going to
    export a bought part -- so the row is the quiet word, and the test above is
    the alarming one keeping `not measured`.

    THE LOG LISTING FEWER PARTS THAN `report.json` IS DELIBERATE and asserted
    here as well. The printed report answers a different question -- what the
    two builds exported -- so `reference_spacer` has no line in it at all, while
    the document, which is about the parts the VIEW shows, owes the part a row.
    Its tally has no word for this case and needs none.
    """
    engine = Engine({"lid": measurement(added=80.0)})
    old = build_dir(tmp_path, "old", {"lid": STEP_A})
    new = build_dir(tmp_path, "new", {"lid": STEP_B})
    shows_both = published_view("lid", "reference_spacer")

    diffs, refused, covered = comparechild._compare(engine, old, new,
                                                    keep_shapes=True)
    made = comparescene.report(diffs, shows_both, shows_both, view_id="iso",
                               refused=refused, covered=covered)

    assert covered == {"lid"} and refused == {}
    lines = {line["key"]: line for line in made["parts"]}
    assert lines["reference_spacer"] == {
        "key": "reference_spacer", "status": "not compared",
        "added_mm3": 0.0, "removed_mm3": 0.0,
        "reason": "the two builds did not both export it as STEP, so nothing "
                  "was fused -- hardware and mocks most often"}
    # The part that WAS measured reads as it always did, and the totals count
    # only what was measured.
    assert lines["lid"]["status"] == "changed"
    assert made["totals"] == {"added_mm3": 80.0, "removed_mm3": 0.0}
    # THE PRINTED REPORT IS UNTOUCHED: one line per exported part, and the
    # tally counts the same parts it always did.
    printed = report(capsys)
    assert "reference_spacer" not in printed
    assert "comparing old -> new, 1 parts" in printed
    assert "1 changed" in printed


def test_a_part_that_changed_kind_is_not_compared_either_and_says_why(
        tmp_path, capsys):
    """ONE BUILD DID EXPORT A STEP HERE, and the row is the same word.

    A part that was `printable` in one revision and `hardware` — or a mock — in
    the other is shown by both views and exported by exactly one build. The walk
    calls that `removed` and leaves it out of `covered` deliberately: nothing was
    fused, so nothing was established about how the part changed. The document
    therefore owes it `not compared`, like a bought screw, and for the same
    reason as a bought screw — no PAIR of files — which is precisely what the
    row's sentence has to say. It said hardware and mocks have no geometry of
    ours to compare, which is a false statement about this part: the old build
    exported one.

    The two halves that carry this word are the printed report, which calls it
    `removed` because that is what the walk of the FILES saw, and the document,
    which is about the parts the VIEW shows. Both are asserted here so the two
    accounts cannot quietly start contradicting each other over one part.
    """
    engine = Engine()
    old = build_dir(tmp_path, "old", {"lid": STEP_A, "bushing": STEP_A},
                    volumes={"bushing": 4.0})
    new = build_dir(tmp_path, "new", {"lid": STEP_A})
    shows_both = published_view("lid", "bushing")

    diffs, refused, covered = comparechild._compare(engine, old, new,
                                                    keep_shapes=True)
    made = comparescene.report(diffs, shows_both, shows_both, view_id="iso",
                               refused=refused, covered=covered)

    assert covered == {"lid"} and refused == {}
    line = {row["key"]: row for row in made["parts"]}["bushing"]
    assert line["status"] == "not compared"
    assert line["reason"] == ("the two builds did not both export it as STEP, "
                              "so nothing was fused -- hardware and mocks most "
                              "often")
    # And the printed half says what the files said, which is a different word
    # about the same part and not a contradiction.
    assert "  bushing: gone since old, volume was 4.000 mm3" in report(capsys)


def test_the_artefacts_are_written_from_the_two_published_documents(tmp_path,
                                                                    capsys):
    """The two files, and the arguments the geometry half is handed.

    The documents go in unchanged: they are what a browser already loads for
    each revision, so the scene is built out of exactly what a reader would
    otherwise be looking at.
    """
    scene = Scene()
    old = with_view(build_dir(tmp_path, "old", {}), "assembled", "a")
    new = with_view(build_dir(tmp_path, "new", {}), "assembled", "b")
    out = tmp_path / "out"
    out.mkdir()
    diffs = {"lid": {"added_mm3": 80.0}}
    refused = {"gasket": "b.step holds 2 solids"}
    covered = {"lid", "gasket"}

    comparechild._write_artefacts(
        scene, out, "assembled",
        (old / "assembled.json", new / "assembled.json"), diffs, refused,
        covered)

    assert scene.scene_calls == [(view_document("a"), view_document("b"), diffs,
                                  "assembled")]
    # THE SAME TWO DOCUMENTS TO BOTH HALVES, which is what keeps the list and
    # the picture describing one set of parts: the view's. What nobody measured
    # -- the refusals, and the set the walk covered -- goes to the summary
    # alone: there is nothing about either for a scene to draw.
    assert scene.report_calls == [(diffs, view_document("a"),
                                   view_document("b"), "assembled", refused,
                                   covered)]
    assert json.loads((out / "scene.json").read_text(encoding="utf-8")) == {
        "name": "cmp", "view": "assembled"}
    assert json.loads((out / "report.json").read_text(encoding="utf-8")) == {
        "parts": ["lid"], "totals": {"changed": 1}, "refused": ["gasket"],
        "covered": ["gasket", "lid"]}
    # Named in the log too: the report is read by a person, and "there is an
    # artefact now" is part of what happened.
    assert "wrote scene.json and report.json for view assembled" in report(capsys)


def test_the_scene_half_is_imported_inside_the_function_that_writes_one():
    """THE DEFERRED IMPORT, pinned rather than described — and off the SYNTAX
    TREE, because importing the module is the very thing this forbids.

    `shapediff` costs 3 MB and brings no kernel, which is why it sits at the top
    of the module. The scene half tessellates, so importing it drags in numpy
    and `ocp-tessellate` — and `hammerola diff --material`, which is every call
    without `--out-dir`, must not pay for a scene it never fetches. Read the way
    `tests/cadbuild/test_module_imports.py` reads the package it watches.
    """
    tree = ast.parse(Path(comparechild.__file__).read_text(encoding="utf-8"))
    at_top = {alias.name for node in tree.body
              if isinstance(node, ast.ImportFrom) for alias in node.names}
    anywhere = {alias.name for node in ast.walk(tree)
                if isinstance(node, ast.ImportFrom) for alias in node.names}

    assert "shapediff" in at_top, "the cheap half belongs at the top"
    assert "comparescene" not in at_top
    assert "comparescene" in anywhere, (
        "nothing imports the scene half at all, so no run can write one")


def test_the_scene_is_built_only_by_the_run_that_writes_one(
        tmp_path, monkeypatch, capsys):
    """The other half of the same claim: no `--out-dir`, no scene.

    BOTH the package attribute and `sys.modules` are patched, and the first one
    is what makes this hold in any collection order: once anything in the
    session has imported the real module, `src.cadbuild` carries it as an
    attribute and `from src.cadbuild import comparescene` never consults
    `sys.modules` again.
    """
    engine = Engine({"lid": measurement(added=80.0)})
    monkeypatch.setattr(comparechild, "shapediff", engine)
    monkeypatch.setattr(comparechild, "_cap_occt_threads", lambda _threads: None)
    scene = Scene()
    monkeypatch.setattr(cadbuild, "comparescene", scene, raising=False)
    monkeypatch.setitem(sys.modules, "src.cadbuild.comparescene", scene)
    old = with_view(build_dir(tmp_path, "old", {"lid": STEP_A}), "iso", "a")
    new = with_view(build_dir(tmp_path, "new", {"lid": STEP_B}), "iso", "b")
    out = tmp_path / "out"
    out.mkdir()

    without = comparechild.main(["comparechild", "--old-dir", str(old),
                                 "--new-dir", str(new)])
    assert without == EXIT_OK
    assert scene.scene_calls == [] and list(out.iterdir()) == []

    with_artefact = comparechild.main([
        "comparechild", "--old-dir", str(old), "--new-dir", str(new),
        "--out-dir", str(out), "--view", "iso"])

    assert with_artefact == EXIT_OK
    assert len(scene.scene_calls) == 1
    assert sorted(path.name for path in out.iterdir()) == ["report.json",
                                                           "scene.json"]
    # And the per-part report is printed in BOTH modes: the artefact is an
    # addition to it, not a replacement.
    assert report(capsys).count("  lid: +80.000 mm3 added") == 2


def test_a_changed_part_no_view_shows_is_in_the_log_and_not_in_the_artefact(
        tmp_path, monkeypatch, capsys):
    """TWO REPORTS, TWO QUESTIONS, and both are answered in full.

    `gasket` changed and this view does not show it. The printed report walks
    every part the two builds exported and names it, because that is what a
    person asked `hammerola diff` gets; `report.json` lists the parts of the
    VIEW, because a row there is something a reader clicks through to in the
    picture beside it — and there is no picture of a part no view shows.

    THE REAL SCENE HALF RUNS HERE: nothing is stubbed between the walk and the
    two files, so this is also what keeps the artefact and the log from drifting
    apart through a fake that agrees with whatever it is handed.
    """
    engine = Engine({"gasket": measurement(added=80.0)})
    monkeypatch.setattr(comparechild, "shapediff", engine)
    monkeypatch.setattr(comparechild, "_cap_occt_threads", lambda _threads: None)
    old = build_dir(tmp_path, "old", {"lid": STEP_A, "gasket": STEP_A})
    new = build_dir(tmp_path, "new", {"lid": STEP_A, "gasket": STEP_B})
    for directory in (old, new):
        (directory / "iso.json").write_text(json.dumps(published_view("lid")),
                                            encoding="utf-8")
    out = tmp_path / "out"
    out.mkdir()

    assert comparechild.main([
        "comparechild", "--old-dir", str(old), "--new-dir", str(new),
        "--out-dir", str(out), "--view", "iso"]) == EXIT_OK

    made = json.loads((out / "report.json").read_text(encoding="utf-8"))
    assert [line["key"] for line in made["parts"]] == ["lid"]
    # And nothing bright in the scene either: the two difference groups are the
    # last two children of the root.
    built = json.loads((out / "scene.json").read_text(encoding="utf-8"))
    assert [group["parts"] for group in built["parts"][2:]] == [[], []]
    # The log is untouched by any of that.
    assert ("  gasket: +80.000 mm3 added, -0.000 mm3 removed"
            in report(capsys))


def test_a_scene_that_cannot_be_built_is_a_sentence_and_not_a_stack(
        tmp_path, monkeypatch, capsys):
    """`comparescene` refuses with a ValueError, and that is not a crash of ours.

    Its docstring says why the type is what it is: nothing in that module runs a
    model, so a document it cannot merge is news about the DOCUMENT. There is no
    exit code for it — the parent reads this as a comparison that did not finish
    either way — but a person reading the job log gets the sentence instead of
    the interpreter's traceback.
    """
    engine = Engine({"lid": measurement(added=80.0)})
    monkeypatch.setattr(comparechild, "shapediff", engine)
    monkeypatch.setattr(comparechild, "_cap_occt_threads", lambda _threads: None)
    scene = Scene()

    def refuse(*_args, **_keywords):
        raise ValueError("view 'iso' shows a part twice")

    scene.build_scene = refuse
    monkeypatch.setattr(cadbuild, "comparescene", scene, raising=False)
    monkeypatch.setitem(sys.modules, "src.cadbuild.comparescene", scene)
    old = with_view(build_dir(tmp_path, "old", {"lid": STEP_A}), "iso", "a")
    new = with_view(build_dir(tmp_path, "new", {"lid": STEP_B}), "iso", "b")
    out = tmp_path / "out"
    out.mkdir()

    code = comparechild.main([
        "comparechild", "--old-dir", str(old), "--new-dir", str(new),
        "--out-dir", str(out), "--view", "iso"])

    assert code != 0
    captured = capsys.readouterr()
    assert "compareproc: view 'iso' shows a part twice" in captured.err
    assert "Traceback" not in captured.err
    # And the walk's own report survives: it measured every part before the
    # scene refused, and that is worth reading.
    assert "  lid: +80.000 mm3 added" in captured.out
    assert list(out.iterdir()) == []
