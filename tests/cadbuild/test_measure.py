"""`cadbuild.measure`: the smallest gap between two parts of a published view.

Two boxes of 10 mm, 2.5 mm apart along their group's X, inside a group that is
turned a quarter about Z and moved -- so the gap runs along the view's Y, and a
placement composed the wrong way round moves the closest points off it.

The first three run without the CAD kernel: with a part that has no STEP the
measurement is on the view's own triangles, and flat faces make the mesh answer
exact. The last three read real STEP files, so they skip where the kernel is
missing and `make cad-test` runs them.
"""

import json
import math

import pytest

measure = pytest.importorskip(
    "src.cadbuild.measure", exc_type=ImportError,
    reason="the measuring half imports the preview renderer's stack, which "
           "this interpreter lacks")

import trimesh  # noqa: E402  (guarded by the importorskip above)

from src.cadbuild import preview_png  # noqa: E402

SIDE = 10.0
GAP = 2.5
QUARTER_TURN = [0.0, 0.0, math.sin(math.pi / 4), math.cos(math.pi / 4)]
# The group's own placement: X turned onto Y, then moved.
GROUP_LOC = [[1.0, 2.0, 3.0], QUARTER_TURN]
# Box `a` round the group's origin, box `b` GAP beyond its +X face; turned,
# that face is at y = 2 + 5 and `b`'s near face at y = 2 + 7.5.
NEAR_A, NEAR_B = 7.0, 9.5


def _shift(x):
    return [[x, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]]


def _box(name, key, x, own=(0.0, 0.0, 0.0), extents=(SIDE, SIDE, SIDE),
         deformed=False):
    """A leaf of the shape the build writes: vertices in the body's own frame,
    `at` the view's shift by `x`, and `loc` that shift after the body's `own`
    placement, as the tessellator composes it; `deformed` as
    `views.shaped_document` stamps it."""
    mesh = trimesh.creation.box(extents=extents)
    loc = [[x + own[0], own[1], own[2]], [0.0, 0.0, 0.0, 1.0]]
    leaf = {"name": name, "key": key, "loc": loc, "at": _shift(x),
            "color": "#c9a227", "alpha": 1.0,
            "shape": {"vertices": mesh.vertices.ravel().tolist(),
                      "triangles": mesh.faces.ravel().tolist()}}
    if deformed:
        leaf["deformed"] = True
    return leaf


def _scene(tmp_path, *leaves):
    path = tmp_path / "assembled.json"
    path.write_text(json.dumps({"name": "Group", "parts": [
        {"name": "turned", "loc": GROUP_LOC, "parts": list(leaves)}]}),
        encoding="utf-8")
    return preview_png.load_scene(path)


def test_a_pair_with_a_part_that_has_no_step_is_measured_on_the_mesh(
        tmp_path):
    """`a` is printable, `b` is not: the mesh, and the answer says why and how
    far a curved face could mislead it."""
    (tmp_path / "a.step").write_bytes(b"never read on this path")
    leaves = _scene(tmp_path, _box("a", "a", 0.0),
                    _box("b", "b", SIDE + GAP))

    found = measure.measure(tmp_path, leaves, "a", "b")

    assert found["method"] == measure.MESH and found["stepless"] == ["b"]
    assert found["distance"] == pytest.approx(GAP, abs=1e-9)
    assert found["point_a"][1] == pytest.approx(NEAR_A)
    assert found["point_b"][1] == pytest.approx(NEAR_B)
    lines = measure.describe(found)
    assert lines[0].startswith("method: the view's mesh -- b is not printable")
    assert lines[1] == "distance: 2.500 mm, between a and b"
    # (10 + 10 + 10) / 300 * 0.1 for each box.
    assert lines[-2].endswith(
        "by up to 0.02 mm either way: larger on convex faces, smaller on "
        "concave ones such as a hole (the two parts' tessellation "
        "tolerances: a 0.01 mm, b 0.01 mm)")
    assert lines[-1] == ("on the mesh a part wholly inside the other reads as "
                         "the gap between their surfaces, not as 0")


def test_parts_that_cross_measure_zero_and_the_nearest_of_several_is_named(
        tmp_path):
    leaves = _scene(tmp_path, _box("a", "a", 0.0),
                    _box("b", "b", 3 * SIDE), _box("b(2)", "b", SIDE - 1.0))

    found = measure.measure(tmp_path, leaves, "a", "b")

    assert (found["distance"], found["b"], found["pairs"]) == (0.0, "b(2)", 2)
    assert measure.describe(found)[1].startswith(
        "distance: 0 mm -- a and b(2) touch, overlap, or are within 0.02 mm "
        "of each other (the nearest of 2 pairs)")
    # A part against itself: its two leaves are one pair, not two.
    itself = measure.measure(tmp_path, leaves, "b", "b")
    assert itself["pairs"] == 1
    assert itself["distance"] == pytest.approx(SIDE + 1.0)


def test_a_part_the_view_does_not_show_or_shows_once_is_refused(tmp_path):
    leaves = _scene(tmp_path, _box("a", "a", 0.0), _box("b", "b", 20.0))

    with pytest.raises(ValueError, match="no part 'c'; its parts are a, b"):
        measure.measure(tmp_path, leaves, "a", "c")
    with pytest.raises(ValueError, match="stands in this view once"):
        measure.measure(tmp_path, leaves, "a", "a")


def _export(cq, path, own=(0.0, 0.0, 0.0), solid=None):
    """A printable's STEP as the build writes it, through an assembly
    (`printables.export_printables`): `solid`, a cube of SIDE by default, at
    its `own` placement."""
    solid = cq.Workplane("XY").box(SIDE, SIDE, SIDE) if solid is None else solid
    body = solid.val().moved(cq.Location(own))
    cq.Assembly(body, name=path.stem).export(str(path), exportType="STEP")


def test_two_printable_boxes_a_known_distance_apart_measure_exactly_that(
        tmp_path):
    """The exact path, with `b` carrying a placement of its own (3, 0, 7).

    The STEP holds `b` there already and the view's `loc` composes it again
    after `at`, so a STEP placed by `loc` stands 3 mm further off and 7 mm
    higher: the bounding-box check then sends the pair to the mesh, and both
    the method and the points below fail.
    """
    cq = pytest.importorskip("cadquery", exc_type=ImportError,
                             reason="measuring STEP solids needs the kernel")
    own = (3.0, 0.0, 7.0)
    _export(cq, tmp_path / "a.step")
    _export(cq, tmp_path / "b.step", own)
    leaves = _scene(tmp_path, _box("a", "a", 0.0),
                    _box("b", "b", SIDE + GAP - own[0], own=own))

    found = measure.measure(tmp_path, leaves, "a", "b")

    assert found["method"] == measure.STEP and found["stepless"] == []
    assert found["distance"] == pytest.approx(GAP, abs=1e-6)
    assert found["point_a"][1] == pytest.approx(NEAR_A, abs=1e-6)
    assert found["point_b"][1] == pytest.approx(NEAR_B, abs=1e-6)
    # In the view `a` spans z 3 - 5 .. 3 + 5 and `b` 3 + 2 .. 3 + 12: the
    # nearest faces face each other only over z 5 .. 8.
    for point in (found["point_a"], found["point_b"]):
        assert 5.0 - 1e-6 <= point[2] <= 8.0 + 1e-6
    assert measure.describe(found)[0].startswith("method: exact")


def test_a_deformed_reference_is_measured_on_what_the_view_draws(tmp_path):
    """The view draws `tab` as a shape of its own with the catalogue body's
    very bounding box: the 30 x 30 x 6 bar without its 8 x 8 x 3 pocket, the
    pocket potted, with `pin` standing in it. On `tab.step` the pin is 0.5 mm
    off the pocket's floor, which would read as exact; in the view it is
    inside solid material. The leaf is stamped `deformed`, so the pair goes to
    the mesh whatever the boxes say, and the answer says why."""
    cq = pytest.importorskip("cadquery", exc_type=ImportError,
                             reason="reading a STEP needs the kernel")
    pocketed = (cq.Workplane("XY").box(30.0, 30.0, 6.0)
                .faces(">Z").workplane().rect(8.0, 8.0).cutBlind(-3.0))
    _export(cq, tmp_path / "tab.step", solid=pocketed)
    pin_at = (0.0, 0.0, 1.5)
    _export(cq, tmp_path / "pin.step", pin_at,
            solid=cq.Workplane("XY").box(4.0, 4.0, 2.0))
    leaves = _scene(tmp_path,
                    _box("tab", "tab", 0.0, extents=(30.0, 30.0, 6.0),
                         deformed=True),
                    _box("pin", "pin", 0.0, own=pin_at,
                         extents=(4.0, 4.0, 2.0)))

    found = measure.measure(tmp_path, leaves, "pin", "tab")

    assert (found["method"], found["reshaped"]) == (measure.MESH, ["tab"])
    assert measure.describe(found)[0] == (
        "method: the view's mesh -- the view draws tab as a shape of its own, "
        "so its STEP is not what stands there")


def test_a_shape_its_step_does_not_match_goes_to_the_mesh_unmarked_too(
        tmp_path):
    """The second barrier, for a leaf NOT stamped `deformed`: `b` is drawn
    squashed to 4 mm while `b.step` is the catalogue's cube, with no motion
    in `at`. Placed, that cube would sit on `a` and read 0 as exact; the
    bounding boxes do not match, so the pair goes to the mesh and the answer
    says why."""
    cq = pytest.importorskip("cadquery", exc_type=ImportError,
                             reason="reading a STEP needs the kernel")
    _export(cq, tmp_path / "a.step")
    _export(cq, tmp_path / "b.step")
    bent = _box("b", "b", 0.0, own=(SIDE + GAP, 0.0, 0.0),
                extents=(SIDE, SIDE, 4.0))
    leaves = _scene(tmp_path, _box("a", "a", 0.0), bent)

    found = measure.measure(tmp_path, leaves, "a", "b")

    assert (found["method"], found["reshaped"]) == (measure.MESH, ["b"])
    assert found["distance"] == pytest.approx(GAP, abs=1e-9)
    assert measure.describe(found)[0] == (
        "method: the view's mesh -- the view draws b as a shape of its own, so "
        "its STEP is not what stands there")
