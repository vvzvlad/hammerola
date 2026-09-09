"""What moved since the last build.

The diff is what a person reads after a build, so what matters is that it
prints ONLY differences: a block that appears after every build saying the same
numbers is a block that stops being read some builds before the one where it
mattered.

The five tests of `check_project_match` that used to sit here went back to
cad_publish with the function itself: it refuses to publish over a snapshot
belonging to somebody else, which is a question a laptop asks a hub over HTTP.
See the note at the top of src/cadbuild/metrics.py.
"""

import json

from fakes import Box
from src.cadbuild.metrics import (
    METRICS_NAME,
    METRICS_VERSION,
    collect_metrics,
    metrics_diff,
    metrics_summary,
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
    assert any("lid: new part" in line for line in metrics_diff(old, new))


def test_a_removed_part_is_reported_as_gone():
    old = build({"body": measured(), "lid": measured()})
    new = build({"body": measured()})
    assert any("lid: gone" in line for line in metrics_diff(old, new))


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


def test_the_summary_lists_every_number_when_there_is_nothing_to_diff():
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
