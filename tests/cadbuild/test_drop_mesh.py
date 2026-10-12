"""What a triangulation does to a bounding box, measured on the real kernel.

`test_geometry.test_drop_mesh_walks_every_body` stands `OCP.BRepTools` up out of
a stub and watches which shapes `Clean_s` was called for -- the right test for
the WALK, and silent on why the walk is needed. This file is the evidence for
the claim underneath it ("an export leaves a triangulation, and from then on
the bounding box is the mesh's"), written as PROPERTIES rather than numbers:

  * the box after a mesh reads BIGGER, never smaller -- the direction is the
    whole content, because it decides which checks fail loudly and which pass
    in silence (geometry.drop_mesh has the accounting);
  * it grows along an axis bounded by FLAT faces too, so it is not the
    "straight chords fall inside a curve" effect, which would point the other
    way;
  * `drop_mesh` puts it back;
  * and a `translate()` copy does NOT share the triangulation with the shape it
    came from, while `.moved()` and `.located()` do.

The last one is why this is a test rather than a comment: "the copies share it
through the TShape" reads as "clean the original and you have cleaned the
copies", and for a `translate()` copy that is false in both directions -- it
keeps its own triangulation when the original is cleaned, and meshing it leaves
the original clean. A build that reasoned the other way would measure a copy off
a mesh nobody dropped.

No literal millimetres are pinned here. The size of the error follows the
tolerances the shape was meshed at -- the ANGULAR one, measurably, which for
the export path is `artifacts.STL_ANGULAR_TOLERANCE` -- and which axis is read
(on this cylinder one axis does not move while the other two do), and two
benches on the same cadquery 2.8.0 parted company above an angular tolerance
of 0.1. Every assertion below compares two measurements of the same shape
instead; `geometry.drop_mesh` is where the figures are written down.

Needs the CAD kernel and skips without it, like test_material_at.py.
"""

import pytest

from src.cadbuild import geometry
from src.cadbuild.artifacts import STL_ANGULAR_TOLERANCE, STL_TOLERANCE

# Both tolerances the direct `mesh()` tests use, passed explicitly:
# `Shape.mesh(tolerance, angularTolerance=0.1)` defaults the second to a value
# that happens to equal the build's STL_ANGULAR_TOLERANCE. The angular tolerance
# is what moves the result -- the linear one left the cylinder's Z extent
# unchanged from 0.001 to 0.1 -- and at 0.1 it moves Z by about three microns,
# six orders of magnitude above the 1e-9 mm the restore test compares at. 0.1 is
# where two independent benches agreed to the last digit (see
# geometry.drop_mesh); no assertion below depends on that.
MESH_LINEAR_TOL = 0.1
MESH_ANGULAR_TOL = 0.1


def _cq():
    return pytest.importorskip(
        "cadquery", exc_type=ImportError,
        reason="the CAD kernel does not import in this interpreter, so nothing "
               "can be meshed here -- see this module's docstring")


def _cylinder():
    """r=5, h=10. Round in X and Y, and bounded by FLAT faces in Z."""
    return _cq().Workplane("XY").circle(5).extrude(10)


def _extents(obj):
    box = (obj.val() if hasattr(obj, "val") else obj).BoundingBox()
    return (box.xlen, box.ylen, box.zlen)


def test_a_mesh_makes_the_bounding_box_read_bigger():
    """The sign, on the shape whose Z axis cannot be a chord effect."""
    cylinder = _cylinder()
    before = _extents(cylinder)
    cylinder.val().mesh(MESH_LINEAR_TOL, MESH_ANGULAR_TOL)
    after = _extents(cylinder)

    assert all(a >= b for a, b in zip(after, before)), (
        f"the mesh made an axis read SMALLER: {before} -> {after}. Everything "
        "written about this in geometry.drop_mesh assumes the one direction")
    assert after != before, "nothing moved at all; this test is measuring nothing"


def test_it_grows_even_along_an_axis_bounded_by_flat_faces():
    """NOT a chord effect, which is the reading that reverses the sign.

    "A curve cut into straight segments falls inside itself, so the box
    shrinks" is the intuition, and it would make the error harmless in the
    direction that matters. The cylinder's Z runs between two planar faces --
    nothing is approximated along it -- and it grows regardless.
    """
    cylinder = _cylinder()
    _, _, before_z = _extents(cylinder)
    cylinder.val().mesh(MESH_LINEAR_TOL, MESH_ANGULAR_TOL)
    _, _, after_z = _extents(cylinder)

    assert after_z > before_z, (
        f"Z is bounded by flat faces and read {after_z} against {before_z}; if "
        "the flat axis ever stops growing, the chord explanation is back on the "
        "table and drop_mesh's note needs rewriting")


def test_a_second_shape_grows_the_same_way():
    """Two shapes, because "it always grows" off one is not a general claim.

    A filleted box: every axis carries a fillet, and every axis came back
    larger.
    """
    cq = _cq()
    part = cq.Workplane("XY").box(30, 20, 10).edges("|Z").fillet(3)
    before = _extents(part)
    part.val().mesh(MESH_LINEAR_TOL, MESH_ANGULAR_TOL)
    after = _extents(part)

    assert all(a > b for a, b in zip(after, before)), (
        f"{before} -> {after}: expected every axis to grow on this one")


def test_the_export_this_build_actually_makes_does_it_too(tmp_path):
    """Through `exportStl` at the build's own tolerances, not `mesh()`.

    `mesh()` is the mechanism; this is the code path. The tolerances come from
    `artifacts` rather than from here, so the day they change this test still
    measures the export the hub performs.
    """
    cylinder = _cylinder()
    before = _extents(cylinder)
    cylinder.val().exportStl(
        str(tmp_path / "part.stl"), tolerance=STL_TOLERANCE,
        angularTolerance=STL_ANGULAR_TOLERANCE, ascii=False, relative=False)
    after = _extents(cylinder)

    assert all(a >= b for a, b in zip(after, before)) and after != before, (
        f"{before} -> {after} at the build's own export tolerances")


def test_drop_mesh_puts_the_box_back():
    """The function's whole job: after it, the shape measures itself again."""
    cylinder = _cylinder()
    before = _extents(cylinder)
    cylinder.val().mesh(MESH_LINEAR_TOL, MESH_ANGULAR_TOL)
    assert _extents(cylinder) != before, "the premise: it was meshed"

    geometry.drop_mesh(cylinder)
    assert _extents(cylinder) == pytest.approx(before, abs=1e-9), (
        "the triangulation was dropped and the box did not come back to the "
        "shape's own extents")


def test_a_translated_copy_does_not_share_the_triangulation():
    """`translate()` is a new shape; `.moved()` and `.located()` are the same
    one somewhere else.

    THE MISTAKE THIS PINS is "the copies share it, so cleaning the original
    cleans them". Cleaning the original does clean a `.moved()` copy -- and
    leaves a `translate()` copy exactly as meshed.
    """
    cq = _cq()
    original = _cylinder()
    body = original.val()
    moved = body.moved(cq.Location(cq.Vector(100, 0, 0)))
    located = body.located(cq.Location(cq.Vector(200, 0, 0)))
    translated = original.translate((300, 0, 0))

    clean = _extents(body)
    body.mesh(MESH_LINEAR_TOL, MESH_ANGULAR_TOL)
    meshed = _extents(body)
    assert meshed != clean, "the premise: meshing the original changed its box"

    assert _extents(moved) == pytest.approx(meshed, abs=1e-9), (
        ".moved() is the same TShape and reads the mesh")
    assert _extents(located) == pytest.approx(meshed, abs=1e-9), (
        ".located() is the same TShape and reads the mesh")
    assert _extents(translated) == pytest.approx(clean, abs=1e-9), (
        "the translate() copy is a shape of its own and was never meshed -- "
        "this is the half the TShape story gets wrong")


def test_the_sharing_is_asserted_on_the_shapes_and_not_only_through_a_number():
    """`IsPartner` is OCCT's own question: do these two share a TShape?

    Asked directly as well as through the bounding boxes above, so the test
    above cannot pass for some other reason -- and so the mechanism is named
    where somebody looking for it will find it.
    """
    cq = _cq()
    original = _cylinder()
    body = original.val()

    assert body.wrapped.IsPartner(
        body.moved(cq.Location(cq.Vector(100, 0, 0))).wrapped) is True
    assert body.wrapped.IsPartner(
        body.located(cq.Location(cq.Vector(200, 0, 0))).wrapped) is True
    assert body.wrapped.IsPartner(
        original.translate((300, 0, 0)).val().wrapped) is False


def test_cleaning_the_original_leaves_a_translated_copy_meshed():
    """The consequence, in the direction a build would get it wrong.

    Both ways round: `drop_mesh` on the original does not reach the copy, and
    meshing the copy does not dirty the original. This is why drop_mesh walks
    what it is handed rather than one shape somebody thinks the rest hang off.
    """
    original = _cylinder()
    body = original.val()
    copy = original.translate((300, 0, 0))
    clean = _extents(body)

    copy.val().mesh(MESH_LINEAR_TOL, MESH_ANGULAR_TOL)
    assert _extents(body) == pytest.approx(clean, abs=1e-9), (
        "meshing the copy dirtied the original")

    body.mesh(MESH_LINEAR_TOL, MESH_ANGULAR_TOL)
    meshed_copy = _extents(copy)
    geometry.drop_mesh(original)
    assert _extents(body) == pytest.approx(clean, abs=1e-9), "the original is clean"
    assert _extents(copy) == pytest.approx(meshed_copy, abs=1e-9), (
        "the copy is still meshed: cleaning the original did NOT clean it")
