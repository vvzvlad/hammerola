"""What this build measured, and what moved since the last one.

TWO BLOCKS, AND THIS FILE HOLDS THEM TO DIFFERENT PROMISES. The summary is what
this build measured and is printed on EVERY run, baseline or no baseline: the
log is the only channel that arrives at whoever pushed without a second action
from them, so it may not depend on there having been a previous build. The diff
is what moved since `dev` and is printed whenever there is a baseline -- INCLUDING
when nothing moved, with how many numbers were compared, because silence there
reads exactly like a comparison that never happened.

THIS ONCE SAID THE OPPOSITE -- that what matters is printing ONLY differences,
a block saying the same numbers after every build being one that stops being
read. That argument is still right about the DIFF and was wrong about the
summary, which is why there are now two blocks instead of one.

The five tests of `check_project_match` that used to sit here went back to
cad_publish with the function itself: it refuses to publish over a snapshot
belonging to somebody else, which is a question a laptop asks a hub over HTTP.
See the note at the top of src/cadbuild/metrics.py.
"""

import json

import pytest

from fakes import Box
from src.cadbuild.metrics import (
    METRICS_NAME,
    METRICS_VERSION,
    collect_metrics,
    metrics_diff,
    metrics_summary,
    read_baseline,
    report_metrics,
    source_fingerprints,
    unchanged_code_moved_geometry,
    write_metrics,
)


def build(parts=None, checks=1, shared=None, source=None, assembly=None):
    return {
        "version": METRICS_VERSION,
        "project": "scratch-project",
        "parts": parts or {},
        # `assembly` merges over the interference the shorthand above writes, so
        # a test about the plate or a swept pair says only what it is about.
        "assembly": dict({"interference_mm3": shared or {}}, **(assembly or {})),
        "checks_passed": checks,
        "source": source or {"files": "aa", "code": "bb"},
    }


def measured(volume=1000.0, faces=6, bbox=(10.0, 10.0, 10.0),
             first_layer=100.0, overhang=0.0, **extra):
    return dict({"volume_mm3": volume, "bbox_mm": list(bbox), "faces": faces,
                 "first_layer_mm2": first_layer, "overhang_mm2": overhang,
                 "edges": 12, "solids": 1, "triangles": 12, "watertight": True},
                **extra)


# The two boxes `collect_metrics` is HANDED: what `export_assembled` and
# `export_print_plate` measured before they meshed anything. Boxes rather than
# lists of three, because that is the object OCC hands back and the shape those
# two return.
PRODUCT = Box(0.0, 0.0, 0.0, 100.0, 50.0, 20.0)
PLATE = Box(0.0, 0.0, 0.0, 180.0, 180.0, 8.0)


# --------------------------------------------------------------------------
# The diff
# --------------------------------------------------------------------------

def test_two_identical_builds_print_nothing():
    one = build({"body": measured()})
    assert metrics_diff(one, build({"body": measured()})) == []


def test_a_changed_volume_is_reported_with_a_percentage():
    old = build({"body": measured(volume=1000.0)})
    new = build({"body": measured(volume=900.0)})
    line, = metrics_diff(old, new)
    assert "body:" in line
    assert "volume 1.00 -> 0.90 cm3" in line
    assert "-10.0%" in line


def test_a_new_part_is_reported_as_new():
    old = build({"body": measured()})
    new = build({"body": measured(), "lid": measured(volume=500.0)})
    line, = [text for text in metrics_diff(old, new)
             if text.startswith("lid: new part")]

    # EVERYTHING MEASURED, TESSELLATION INCLUDED, and this is what holds
    # `_part_summary`'s default where its docstring only claims it: nobody has
    # seen this part before, so there is nothing to leave out. The build's own
    # summary narrows the per-part line to PHYSICAL_FIELDS; narrowing the
    # DEFAULT would take these three off this line and off `hammerola diff`
    # with it, and nothing else in this suite would notice.
    assert "1 solid" in line and "12 triangles" in line, line
    assert "watertight" in line, line


def test_a_removed_part_is_reported_as_gone():
    old = build({"body": measured(), "lid": measured()})
    new = build({"body": measured()})
    line, = [text for text in metrics_diff(old, new)
             if text.startswith("lid: gone")]

    # The other half of the same sentence: a part that went away is described
    # in full for the same reason, and by the same default.
    assert "1 solid" in line and "12 triangles" in line, line


def test_a_moved_bounding_box_is_reported():
    old = build({"body": measured(bbox=(10.0, 10.0, 10.0))})
    new = build({"body": measured(bbox=(10.0, 12.0, 10.0))})
    line, = metrics_diff(old, new)
    assert "bbox 10.00x10.00x10.00 mm -> 10.00x12.00x10.00 mm" in line


def test_a_halved_first_layer_is_reported_with_a_percentage():
    """The line this whole measurement exists for.

    Adhesion that halves between two revisions is a part that will start coming
    off the bed, and it is invisible in every other number here: the volume
    barely moves, the bounding box does not move at all, and the part is still
    watertight and still one body. The percentage is what makes it read as a
    change rather than as two numbers.
    """
    old = build({"body": measured(first_layer=640.0)})
    new = build({"body": measured(first_layer=210.0)})
    line, = metrics_diff(old, new)
    assert "first layer 640.0 -> 210.0 mm2" in line
    assert "-67.2%" in line


def test_a_grown_overhang_is_reported():
    """The other half of the same question, and it moves the other way: an edit
    that removes support material adds overhang without touching anything the
    gate refuses."""
    old = build({"body": measured(overhang=12.0)})
    new = build({"body": measured(overhang=40.0)})
    line, = metrics_diff(old, new)
    assert "overhang 12.0 -> 40.0 mm2" in line
    assert "+233.3%" in line


def test_an_overhang_that_appeared_out_of_nothing_has_no_percentage():
    """A part that had none: there is no percentage of zero to print, and the
    two numbers say it plainly enough."""
    old = build({"body": measured(overhang=0.0)})
    new = build({"body": measured(overhang=8.0)})
    line, = metrics_diff(old, new)
    assert "overhang 0.0 -> 8.0 mm2" in line
    assert "%" not in line


def test_the_areas_are_printed_in_square_millimetres_and_named_in_the_summary():
    """Square millimetres, one decimal: a first layer is often under a cm2, and
    a part's whole contact patch rounded to two decimal places of a cm2 reads
    as a number nobody measured.

    AND EACH CARRIES ITS NAME, which the counts beside them do not need: two
    areas in one unit print as `212.5 mm2, 3.0 mm2` and leave the reader to
    guess which of them is the bed contact.
    """
    lines = metrics_summary(build({"body": measured(first_layer=212.5,
                                                    overhang=3.0)}))
    assert "first layer 212.5 mm2" in lines[0]
    assert "overhang 3.0 mm2" in lines[0]


def test_arithmetic_noise_is_not_a_change():
    old = build({"body": measured(volume=1000.0)})
    new = build({"body": measured(volume=1000.0000000001)})
    assert metrics_diff(old, new) == []


def test_a_part_that_stopped_being_watertight_is_reported():
    old = build({"body": measured(watertight=True)})
    new = build({"body": measured(watertight=False)})
    assert "NOT watertight" in metrics_diff(old, new)[0]


def test_a_changed_check_count_is_reported():
    lines = metrics_diff(build(checks=4), build(checks=6))
    assert lines == ["checks passed: 4 -> 6"]


def test_a_baseline_from_before_the_measurement_reports_no_static_asserts():
    """A missing `checks_static` and a zero are the same answer: none.

    Every project's baseline predates this number, so a comparison that tells
    the two apart prints `checks decided by constants: None -> 0` on the first
    build after the rollout -- a line saying nothing moved, in a document whose
    whole rule is to print only what did. Between two immutable revisions
    astride the rollout it would print for ever.
    """
    assert metrics_diff(build(), {**build(), "checks_static": 0}) == []


def test_a_static_assert_that_appeared_or_went_away_is_reported():
    """...and the normalization above must not swallow a real difference.

    Both directions across zero are movement and both are the whole point of
    the number: an assert degenerating into a tautology, and one being repaired.
    """
    assert metrics_diff({**build(), "checks_static": 0},
                        {**build(), "checks_static": 2}) == [
        "checks decided by constants: 0 -> 2"]
    assert metrics_diff({**build(), "checks_static": 2},
                        {**build(), "checks_static": 0}) == [
        "checks decided by constants: 2 -> 0"]


def test_interference_that_appeared_is_reported():
    old = build({"body": measured()})
    new = build({"body": measured()}, shared={"body|lid": 4.1})
    assert any("now share 4.100 mm3" in line for line in metrics_diff(old, new))


def test_interference_that_grew_is_reported():
    old = build({"body": measured()}, shared={"body|lid": 0.0})
    new = build({"body": measured()}, shared={"body|lid": 4.1})
    assert any("0.000 -> 4.100 mm3" in line for line in metrics_diff(old, new))


def test_a_product_that_changed_size_is_reported():
    """The assembly's own bounding box: how big the thing IS, which no per-part
    number answers -- parts can each keep their size and stand further apart."""
    old = build(assembly={"bbox_mm": [100.0, 50.0, 20.0]})
    new = build(assembly={"bbox_mm": [100.0, 50.0, 24.0]})
    line, = metrics_diff(old, new)
    assert line == ("assembly: bbox 100.00x50.00x20.00 mm -> "
                    "100.00x50.00x24.00 mm")


def test_a_plate_that_grew_is_reported_separately_from_the_product():
    """`print_bbox_mm` is the BED, not the product, and the two move
    independently: relaying the same parts flat changes this and nothing
    else."""
    old = build(assembly={"print_bbox_mm": [180.0, 180.0, 8.0]})
    new = build(assembly={"print_bbox_mm": [260.0, 180.0, 8.0]})
    line, = metrics_diff(old, new)
    assert "plate 180.00x180.00x8.00 mm -> 260.00x180.00x8.00 mm" in line


def test_the_assembly_volume_is_reported_like_a_part_s():
    old = build(assembly={"volume_mm3": 33060.0})
    new = build(assembly={"volume_mm3": 31900.0})
    line, = metrics_diff(old, new)
    assert "assembly: volume 33.06 -> 31.90 cm3" in line
    assert "-3.5%" in line


def test_a_swept_pair_that_appeared_is_reported():
    """What `checklib.swept_clearance` recorded, published for the first time
    by this issue: the tightest gap along a pair's travel."""
    new = build(assembly={"clearance": {"lid|body": {"positions": 12,
                                                     "min_gap_mm": 0.40,
                                                     "at": 7}}})
    line, = metrics_diff(build(), new)
    assert line == "lid|body: now swept, min gap 0.40 mm at position 7 of 12"


def test_a_swept_pair_that_went_away_is_reported():
    """Absence means "not measured", never "touching" -- so a sweep that
    stopped being run is said out loud rather than passed over."""
    old = build(assembly={"clearance": {"lid|body": {"positions": 12,
                                                     "min_gap_mm": 0.40,
                                                     "at": 7}}})
    line, = metrics_diff(old, build())
    assert line.startswith("lid|body: no longer swept")


def test_a_mating_pair_growing_together_is_reported():
    """0.40 mm today and 0.05 mm tomorrow is a pair that will not go together,
    and the sweep passed both times: neither gap is an interference."""
    old = build(assembly={"clearance": {"lid|body": {"positions": 12,
                                                     "min_gap_mm": 0.40,
                                                     "at": 7}}})
    new = build(assembly={"clearance": {"lid|body": {"positions": 12,
                                                     "min_gap_mm": 0.05,
                                                     "at": 7}}})
    line, = metrics_diff(old, new)
    assert line == "lid|body: min gap 0.40 -> 0.05 mm"


def test_a_sweep_run_at_more_stops_is_not_the_parts_having_moved():
    """`positions` and `at` are how the sweep was RUN. A model that swept ten
    stops and now sweeps twenty measured the same pair more carefully; saying
    the geometry moved would be a line printed after an edit to checks()."""
    old = build(assembly={"clearance": {"lid|body": {"positions": 10,
                                                     "min_gap_mm": 0.40,
                                                     "at": 6}}})
    new = build(assembly={"clearance": {"lid|body": {"positions": 20,
                                                     "min_gap_mm": 0.40,
                                                     "at": 13}}})
    assert metrics_diff(old, new) == []


def test_a_baseline_from_before_these_numbers_existed_still_compares():
    """THE ROLLOUT, and the one test here that is about it.

    Every revision already published carries none of the fields this issue
    added -- no first layer, no overhang, no assembly box -- and those
    revisions are immutable, so they will never carry them. Comparison with
    them has to go on working: the fields the two documents share are compared,
    the rest are passed over, and nothing raises on the way past.
    """
    old = {"version": METRICS_VERSION, "project": "scratch-project",
           "parts": {"body": {"volume_mm3": 1000.0, "bbox_mm": [10.0, 10.0, 10.0],
                              "faces": 6, "watertight": True}},
           "assembly": {"interference_mm3": {}},
           "checks_passed": 1, "source": {"files": "aa", "code": "bb"}}
    new = build({"body": measured(volume=900.0)},
                assembly={"bbox_mm": [100.0, 50.0, 20.0], "volume_mm3": 900.0,
                          "clearance": {}})
    line, = metrics_diff(old, new)
    assert line == "body: volume 1.00 -> 0.90 cm3 (-10.0%)"


def test_the_summary_says_which_box_is_the_product_and_which_is_the_bed():
    """Two of the three assembly numbers are bounding boxes, so the summary
    labels them: `100.00x50.00x20.00 mm, 180.00x180.00x8.00 mm` on its own says
    nothing about which is which."""
    lines = metrics_summary(build(assembly={"bbox_mm": [100.0, 50.0, 20.0],
                                            "print_bbox_mm": [180.0, 180.0, 8.0],
                                            "volume_mm3": 33060.0}))
    assert lines == ["assembly: bbox 100.00x50.00x20.00 mm, "
                     "plate 180.00x180.00x8.00 mm, volume 33.06 cm3",
                     "checks passed: 1"]


def test_the_summary_lists_every_number_it_was_given():
    # NOT "when there is nothing to diff", which is what this was called: the
    # summary is printed on every run now, with a baseline as much as without.
    # This is about its DEFAULT `fields`, which is the whole of METRIC_FIELDS.
    lines = metrics_summary(build({"body": measured()}, checks=3))
    assert lines[0].startswith("body: ")
    assert "1.00 cm3" in lines[0]
    assert "1 solid" in lines[0]       # singular, deliberately
    assert lines[-1] == "checks passed: 3"


# --------------------------------------------------------------------------
# "the code did not change and the geometry did"
# --------------------------------------------------------------------------

def test_unchanged_code_with_moved_geometry_is_flagged():
    source = {"files": "aa", "code": "same"}
    old = build({"body": measured(volume=1000.0)}, source=source)
    new = build({"body": measured(volume=900.0)}, source=source)
    assert unchanged_code_moved_geometry(old, new)


def test_changed_code_with_moved_geometry_is_ordinary_work():
    old = build({"body": measured(volume=1000.0)}, source={"files": "a", "code": "one"})
    new = build({"body": measured(volume=900.0)}, source={"files": "b", "code": "two"})
    assert not unchanged_code_moved_geometry(old, new)


def test_nothing_is_claimed_when_the_code_hash_is_empty():
    """An empty hash means a file did not tokenize; no claim may rest on it."""
    source = {"files": "aa", "code": ""}
    old = build({"body": measured(volume=1000.0)}, source=source)
    new = build({"body": measured(volume=900.0)}, source=source)
    assert not unchanged_code_moved_geometry(old, new)


# --------------------------------------------------------------------------
# Source fingerprints
# --------------------------------------------------------------------------

def test_only_a_comment_changing_leaves_the_code_hash_alone(isolated_project):
    (isolated_project / "model.py").write_text("x = 1  # one\n", encoding="utf-8")
    first = source_fingerprints()
    (isolated_project / "model.py").write_text("x = 1  # something else\n",
                                               encoding="utf-8")
    second = source_fingerprints()
    assert first["files"] != second["files"]
    assert first["code"] == second["code"]


def test_a_real_edit_moves_the_code_hash(isolated_project):
    (isolated_project / "model.py").write_text("x = 1\n", encoding="utf-8")
    first = source_fingerprints()
    (isolated_project / "model.py").write_text("x = 2\n", encoding="utf-8")
    assert first["code"] != source_fingerprints()["code"]


def test_a_file_that_will_not_tokenize_empties_the_code_hash(isolated_project):
    (isolated_project / "model.py").write_text("def (\n", encoding="utf-8")
    assert source_fingerprints()["code"] == ""


def test_only_the_project_root_is_fingerprinted(isolated_project):
    (isolated_project / "model.py").write_text("x = 1\n", encoding="utf-8")
    first = source_fingerprints()
    nested = isolated_project / "cad"
    nested.mkdir()
    (nested / "extra.py").write_text("y = 2\n", encoding="utf-8")
    assert source_fingerprints() == first


# --------------------------------------------------------------------------
# Writing it out
# --------------------------------------------------------------------------

def test_metrics_json_is_written_with_readable_floats(out_dir):
    write_metrics(out_dir, collect_metrics("scratch-project",
                                           {"body": measured(volume=1.23456789)},
                                           3, 0, {}, PRODUCT, PLATE))
    data = json.loads((out_dir / METRICS_NAME).read_text(encoding="utf-8"))
    assert data["version"] == METRICS_VERSION
    assert data["project"] == "scratch-project"
    assert data["checks_passed"] == 3
    assert data["parts"]["body"]["volume_mm3"] == 1.234568
    assert data["parts"]["body"]["watertight"] is True


def test_a_build_that_never_ran_the_checks_writes_no_key_of_its_own(out_dir):
    """A forced build is NOT MARKED, and this is where a mark would appear.

    `build(force=True)` skips the model's own checks() and hands both counts in
    as None -- "count unknown", which this file has always been able to say
    about `checks_passed`. What must not happen is a `forced: true` beside them:
    metrics.json is read back by the next build and rendered in the diff, so a
    key here would be the badge the flag deliberately does not have.
    """
    counted = collect_metrics("scratch-project", {"body": measured()}, 3, 0, {},
                              PRODUCT, PLATE)
    write_metrics(out_dir, collect_metrics(
        "scratch-project", {"body": measured()}, None, None, {}, PRODUCT, PLATE))
    data = json.loads((out_dir / METRICS_NAME).read_text(encoding="utf-8"))

    assert set(data) == set(counted)
    assert data["checks_passed"] is None
    assert data["checks_static"] is None


def test_the_assembly_block_is_written_out_of_what_the_exports_measured(out_dir):
    """The three numbers about the whole build, and where each comes from.

    The two boxes are HANDED IN -- measured by the exports before they meshed
    anything -- and the volume is summed from the parts the gate already
    measured. Nothing here computes geometry, which is the rule this whole file
    is written under.
    """
    write_metrics(out_dir, collect_metrics(
        "scratch-project",
        {"body": measured(volume=1000.0), "lid": measured(volume=250.0)},
        3, 0, {}, PRODUCT, PLATE))
    assembly = json.loads(
        (out_dir / METRICS_NAME).read_text(encoding="utf-8"))["assembly"]
    assert assembly["bbox_mm"] == [100.0, 50.0, 20.0]
    assert assembly["print_bbox_mm"] == [180.0, 180.0, 8.0]
    assert assembly["volume_mm3"] == 1250.0
    # EMPTY, not absent: this build swept no pair and shared no volume, and a
    # reader has one way of asking each question.
    assert assembly["interference_mm3"] == {}
    assert assembly["clearance"] == {}


def test_a_build_with_no_plate_declares_no_plate_at_all(out_dir):
    """ABSENT rather than empty, and rather than zeroes: a project whose single
    part is already in print orientation has no `print` view, and three zeroes
    would be this build claiming it occupies no bed."""
    write_metrics(out_dir, collect_metrics("scratch-project",
                                           {"body": measured()},
                                           3, 0, {}, PRODUCT, None))
    assembly = json.loads(
        (out_dir / METRICS_NAME).read_text(encoding="utf-8"))["assembly"]
    assert "print_bbox_mm" not in assembly
    assert assembly["bbox_mm"] == [100.0, 50.0, 20.0]


def test_a_build_that_measured_no_product_declares_no_size_at_all(out_dir):
    """ABSENT rather than zeroes, exactly as the plate above: an `assembled`
    view holding nothing but mocks has no product in it to be the size of, and
    `export_assembled` hands back None. Three zeroes would be this build saying
    it made something of no size."""
    write_metrics(out_dir, collect_metrics("scratch-project",
                                           {"body": measured()},
                                           3, 0, {}, None, PLATE))
    assembly = json.loads(
        (out_dir / METRICS_NAME).read_text(encoding="utf-8"))["assembly"]
    assert "bbox_mm" not in assembly
    assert assembly["print_bbox_mm"] == [180.0, 180.0, 8.0]


def test_a_swept_pair_reaches_metrics_json(out_dir):
    """`checklib.swept_clearance` recorded this and nothing published it until
    now -- which is the half of issue #58 that is a wire and not a
    measurement."""
    from src.cadbuild import checklib

    checklib._CLEARANCE["lid|body"] = {"positions": 12, "min_gap_mm": 0.4,
                                       "at": 7}
    try:
        metrics = collect_metrics("scratch-project", {"body": measured()},
                                  3, 0, {}, PRODUCT, PLATE)
    finally:
        checklib._CLEARANCE.clear()
    assert metrics["assembly"]["clearance"] == {"lid|body": {"positions": 12,
                                                             "min_gap_mm": 0.4,
                                                             "at": 7}}


def test_a_declared_number_is_written_out_as_an_ordinary_number(out_dir):
    """`checklib.Number` is a float SUBCLASS, and provenance now reaches here.

    Two claims, and the order of the two branches in `trim` is what makes both
    true at once. A subclass has to come out as JSON's own number, with nothing
    of the wrapper left in the file. And the `bool` branch has to stay ABOVE the
    `float` branch: `True` is an int rather than a float, so it does not enter
    that branch today — but `round(True, 6)` is `1`, so the day something puts
    a bool where the walk sees a float, the reversed order writes `1` in place
    of `true` and `watertight` stops being a yes/no.
    """
    from src.cadbuild import checklib

    write_metrics(out_dir, collect_metrics(
        "scratch-project",
        {"body": measured(volume=checklib.measured(1.23456789, "ref/m.md"))},
        3, 0, {"measured": 1, "derived": 0, "estimated": 0, "estimates": []},
        PRODUCT, PLATE))
    text = (out_dir / METRICS_NAME).read_text(encoding="utf-8")
    data = json.loads(text)
    assert data["parts"]["body"]["volume_mm3"] == 1.234568
    assert data["parts"]["body"]["watertight"] is True
    assert "1.234568" in text        # a number, not a quoted repr of one
    assert data["provenance"]["measured"] == 1


def test_the_recorded_arguments_have_no_default():
    """"A REQUIRED argument rather than one with a default" was a comment.

    `collect_metrics`'s docstring argues the point -- a default would let a
    caller drop the whole record by forgetting it, and metrics.json would still
    look complete -- and giving the parameter `provenance={}` left every test in
    this repository green, which is exactly the silence the argument describes.
    One line of `inspect.signature` is what makes the claim fail on the edit
    that falsifies it. `checks_static` is held to it for the same reason: a
    default of 0 is the file saying the constants settled none of the checks,
    which is a claim, not an absence. `bbox` and `print_bbox` join them for a
    third turn of the same argument -- a default of None on the first would
    publish an assembly block with no size in it, and one on the second would
    say every build has no plate.
    """
    import inspect

    for name in ("checks_static", "provenance", "bbox", "print_bbox"):
        parameter = inspect.signature(collect_metrics).parameters[name]
        assert parameter.default is inspect.Parameter.empty, (
            f"collect_metrics({name}=...) now defaults to "
            f"{parameter.default!r}, so a caller that forgets it publishes a "
            f"metrics.json with an empty {name} record and nothing goes red")


def test_the_metrics_file_name_passes_the_hub_s_member_rule():
    from src.cadbuild.hubspec import MEMBER_RE, RESERVED_NAMES

    assert MEMBER_RE.match(METRICS_NAME)
    assert METRICS_NAME in RESERVED_NAMES


# --------------------------------------------------------------------------
# The baseline, and what the build prints about it
# --------------------------------------------------------------------------
#
# The file being read here is one somebody else's build published, and the
# promise both functions carry is that nothing in it can fail a build: the whole
# value of a printed diff is gone the moment it can turn a modelled, gated,
# ready-to-ship build red.

def test_being_handed_no_baseline_is_a_clause_and_not_silence():
    """None is what the parent passes when it had no file to copy, and it is a
    reason rather than a failure: the build says it in one line and publishes.

    THE NAME NO LONGER SAYS "a project with no dev build", and that is the
    assertion here rather than a tidier wording. None also covers a slot that
    IS there and could not be copied out of, so the clause deliberately reports
    what this side can see -- that nothing arrived -- and not a conclusion about
    the project that only the parent could draw.
    """
    baseline, why = read_baseline(None)

    assert baseline is None
    assert why == "this build was handed no dev metrics.json"


@pytest.mark.parametrize("text, fragment", [
    (None, "published no metrics.json"),
    ("{not json at all", "is not readable"),
    ("[]", "is not readable"),
    ('{"version": 999, "parts": {}}', "is version 999"),
])
def test_a_baseline_this_build_cannot_use_is_a_clause_and_never_a_raise(
        isolated_project, text, fragment):
    """Four refusals, and every one of them ends as a sentence in the log.

    The file is on the volume and was written by an older build, by hand, or by
    a version of this code that does not exist yet — so each of these is an
    ordinary thing to run into, and `read_baseline` settles them all without
    raising. The version case is the one the comment on METRICS_VERSION promises
    out loud: a build refuses to compare against a version it does not know and
    SAYS so, rather than diffing fields whose meaning has quietly changed.
    """
    path = isolated_project / "baseline.json"
    if text is not None:
        path.write_text(text, encoding="utf-8")

    baseline, why = read_baseline(path)

    assert baseline is None
    assert fragment in why, why


def test_a_baseline_this_build_can_use_comes_back_with_no_complaint(
        isolated_project):
    """The other direction, without which every test above is satisfied by a
    function that refuses everything."""
    published = build({"body": measured()})
    path = isolated_project / "baseline.json"
    path.write_text(json.dumps(published), encoding="utf-8")

    assert read_baseline(path) == (published, None)


def test_the_summary_is_printed_with_a_baseline_as_well_as_without(out_dir,
                                                                   capsys):
    """WHAT THIS BUILD MEASURED IS PRINTED EVERY RUN, and that is the point of
    the block: the numbers are in metrics.json too, but that file has to be
    fetched by name, while the log arrives on its own and arrives at whoever
    pushed. It must not depend on whether there was a previous build."""
    write_metrics(out_dir, build({"body": measured(volume=1000.0)}))

    report_metrics(out_dir, None, "this project has no dev build yet")
    alone = capsys.readouterr().out
    report_metrics(out_dir, build({"body": measured(volume=900.0)}), None)
    compared = capsys.readouterr().out

    assert "this project has no dev build yet" in alone
    assert "body: 1.00 cm3" in alone
    assert "body: 1.00 cm3" in compared, (
        "the summary went missing the moment there was something to diff "
        "against, which is the branch it used to live under")
    assert "metrics vs dev:" in compared


def test_the_summary_line_carries_millimetres_and_not_the_mesh(out_dir, capsys):
    """PHYSICAL_FIELDS, and the reason is what a build log is read for.

    A face count moves when a fillet is drawn out of two surfaces instead of
    one, and a triangle count moves on a tolerance nobody touched — neither is
    the part coming out another shape. Both stay in metrics.json and in the diff
    below, where they answer WHY something moved.
    """
    write_metrics(out_dir, build({"body": measured(triangles=999, faces=777)}))

    report_metrics(out_dir, None, "this project has no dev build yet")

    line, = [text for text in capsys.readouterr().out.splitlines()
             if text.strip().startswith("body:")]
    assert "10.00x10.00x10.00 mm" in line, "the size it came out is the point"
    assert "999" not in line and "777" not in line, line


def test_a_baseline_that_moved_nothing_says_how_many_numbers_were_compared(
        out_dir, capsys):
    """Silence is indistinguishable from a comparison that never happened.

    Two documents with no field in common — a baseline written before a field
    existed against a build that writes it — compare nothing and move nothing,
    and without the count that reads exactly like a build where nothing changed.

    `revdiff._print_geometry` says the same thing for the same reason, and the
    wording was taken from there — but it is a SECOND COPY of the sentence and
    not one string used twice (that one ends in a full stop, this one does not),
    so nothing holds the two together and this test speaks only for this side.
    Said out loud because the drift has already started at the punctuation, and
    a docstring claiming the halves cannot answer differently would be claiming
    a guarantee no test here provides.
    """
    write_metrics(out_dir, build({"body": measured()}))

    report_metrics(out_dir, build({"body": measured()}), None)

    out = capsys.readouterr().out
    assert "metrics vs dev:" in out
    assert "every measured number is the same (9 part numbers compared)" in out


def test_rubbish_inside_a_well_shaped_baseline_costs_the_diff_and_not_the_summary(
        out_dir, capsys):
    """The promise in `report_metrics`'s docstring, made to fail if it stops.

    `{"version": 1, "parts": {"body": 42}}` parses, is an object and carries a
    version this build knows — everything `read_baseline` can settle cheaply —
    and it is a TypeError in the middle of the comparison. A guard around the
    whole walk is what turns that into a sentence, and the lines being built
    before anything is printed is what keeps a half-written block off the log.

    AND IT COSTS THE DIFF ONLY. The summary walks the document THIS build just
    wrote and has a guard of its own, so a baseline nobody can read cannot take
    the sizes with it — a build that printed no numbers at all is the defect
    issue #59 exists to fix, and the previous build's file must not be able to
    bring it back by another road.
    """
    write_metrics(out_dir, build({"body": measured()}))

    report_metrics(out_dir, {"version": METRICS_VERSION,
                             "parts": {"body": 42}}, None)

    out = capsys.readouterr().out
    assert "is not shaped like one" in out
    assert "body: 1.00 cm3" in out, (
        "the rubbish baseline took this build's own sizes down with it")
    assert "metrics vs dev:" not in out, (
        "the block was half printed before the walk fell over")


def test_each_block_answers_for_the_document_it_walked(out_dir, capsys):
    """TWO GUARDS AND NOT ONE, which nothing else here can tell apart.

    The test above pins the ORDER — the summary is printed before the baseline
    is ever walked — and a single `try` around both blocks passes it, because
    the summary has already reached the terminal by the time the diff falls
    over. So this is the input that separates them: rubbish in the document THIS
    build wrote, with a baseline that is perfectly good.

    Under two guards each block says which document defeated it, and the second
    still runs. Under one, the first exception takes the rest of the function
    with it and the log blames the file somebody else published for a problem in
    this build's own — which is the wrong sentence printed to the wrong person.

    This is also the only test that reaches the summary's `except` at all.
    """
    (out_dir / METRICS_NAME).write_text(
        json.dumps({"version": METRICS_VERSION, "parts": {"body": 42}}),
        encoding="utf-8")

    report_metrics(out_dir, build({"body": measured()}), None)

    out = capsys.readouterr().out
    assert "could not be summarised" in out, (
        "this build's own document was blamed on the baseline, so the two "
        "blocks are under one guard again")
    assert "is not shaped like one" in out, (
        "the summary's failure took the diff with it")
    # The other half of "each block's lines are built first": the heading is in
    # `lines` before the walk that fails, so a failed summary prints its one
    # sentence and no part of the block it was going to print.
    assert "metrics, this build:" not in out, (
        "the summary's heading reached the terminal before the walk fell over")
