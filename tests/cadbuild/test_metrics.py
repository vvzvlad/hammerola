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


def build(parts=None, checks=1, shared=None, source=None):
    return {
        "version": METRICS_VERSION,
        "project": "scratch-project",
        "parts": parts or {},
        "assembly": {"interference_mm3": shared or {}},
        "checks_passed": checks,
        "source": source or {"files": "aa", "code": "bb"},
    }


def measured(volume=1000.0, faces=6, bbox=(10.0, 10.0, 10.0), **extra):
    return dict({"volume_mm3": volume, "bbox_mm": list(bbox), "faces": faces,
                 "edges": 12, "solids": 1, "triangles": 12, "watertight": True},
                **extra)


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


def test_interference_that_appeared_is_reported():
    old = build({"body": measured()})
    new = build({"body": measured()}, shared={"body|lid": 4.1})
    assert any("now share 4.100 mm3" in line for line in metrics_diff(old, new))


def test_interference_that_grew_is_reported():
    old = build({"body": measured()}, shared={"body|lid": 0.0})
    new = build({"body": measured()}, shared={"body|lid": 4.1})
    assert any("0.000 -> 4.100 mm3" in line for line in metrics_diff(old, new))


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
                                           {"body": measured(volume=1.23456789)}, 3))
    data = json.loads((out_dir / METRICS_NAME).read_text(encoding="utf-8"))
    assert data["version"] == METRICS_VERSION
    assert data["project"] == "scratch-project"
    assert data["checks_passed"] == 3
    assert data["parts"]["body"]["volume_mm3"] == 1.234568
    assert data["parts"]["body"]["watertight"] is True


def test_the_metrics_file_name_passes_the_hub_s_member_rule():
    from src.cadbuild.hubspec import MEMBER_RE, RESERVED_NAMES

    assert MEMBER_RE.match(METRICS_NAME)
    assert METRICS_NAME in RESERVED_NAMES
