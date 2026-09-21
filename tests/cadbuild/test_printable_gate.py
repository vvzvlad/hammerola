"""The two printability refusals that live in the GATE rather than in checklib.

Both are here for the same reason: the build already knows the answer and needs
no number from the author. A part whose smallest overall dimension is under one
extrusion width is not thin, it is a line; a part with no flat bottom of its own
has nothing for the first layer to stick to. Neither question has a threshold
somebody has to choose, so neither belongs in `checks()`.

WHAT `first_layer_area` MEANS is the load-bearing decision and the half worth
reading twice: the bed is the part's OWN lowest point, so a box centred on the
origin -- which is what the README and every fixture in this suite build --
stands on it perfectly. The other reading, "zmin must be 0", would redden all of
them, and a false red costs more than a miss here.

Half of this file needs no CAD kernel at all: `first_layer_area` reads a
trimesh.Trimesh, and a Trimesh can be written out by hand. The other half needs
the kernel, because what it checks is that the two refusals fire from inside
`export_printables` on geometry OCC really meshed -- and it skips where the
kernel does not import. CI's container installs it (issue #27), so it runs
there.
"""

import math

import numpy as np
import pytest
import trimesh

from fakes import catalogue
from src.cadbuild.checklib import minimum_feature
from src.cadbuild.errors import BuildError
from src.cadbuild.printables import (export_printables, first_layer_area,
                                     overhang_area)


# The eight corners of the unit cube and the twelve triangles over them, wound
# so every normal points OUT. Written down rather than fetched from
# trimesh.creation so the fixtures below are exactly what they claim to be --
# the winding is what the normal test in first_layer_area reads.
CUBE_FACES = [
    [0, 2, 1], [0, 3, 2],  # bottom, -Z
    [4, 5, 6], [4, 6, 7],  # top, +Z
    [0, 1, 5], [0, 5, 4],  # -Y
    [1, 2, 6], [1, 6, 5],  # +X
    [2, 3, 7], [2, 7, 6],  # +Y
    [3, 0, 4], [3, 4, 7],  # -X
]


def _box(sx, sy, sz, z0=0.0):
    """A box of that size with its bottom face at z0, as a real Trimesh."""
    vertices = [(0.0, 0.0, z0), (sx, 0.0, z0), (sx, sy, z0), (0.0, sy, z0),
                (0.0, 0.0, z0 + sz), (sx, 0.0, z0 + sz),
                (sx, sy, z0 + sz), (0.0, sy, z0 + sz)]
    return trimesh.Trimesh(vertices=np.array(vertices, dtype=float),
                           faces=np.array(CUBE_FACES, dtype=np.int64))


def _tilted(mesh, degrees):
    """The same mesh, turned about the X axis through its own centre."""
    turn = trimesh.transformations.rotation_matrix(
        math.radians(degrees), (1.0, 0.0, 0.0), mesh.centroid)
    turned = mesh.copy()
    turned.apply_transform(turn)
    return turned


def _pyramid_on_its_apex():
    """A square pyramid standing on its point: the apex is the whole contact."""
    vertices = [(0.0, 0.0, 0.0),
                (-2.0, -2.0, 5.0), (2.0, -2.0, 5.0),
                (2.0, 2.0, 5.0), (-2.0, 2.0, 5.0)]
    faces = [[1, 2, 3], [1, 3, 4],                    # the base, up at the top
             [0, 2, 1], [0, 3, 2], [0, 4, 3], [0, 1, 4]]
    return trimesh.Trimesh(vertices=np.array(vertices, dtype=float),
                           faces=np.array(faces, dtype=np.int64))


def test_a_box_on_the_bed_contributes_its_whole_bottom_face():
    assert first_layer_area(_box(20.0, 10.0, 4.0)) == pytest.approx(200.0)


def test_the_bed_is_the_part_s_own_lowest_point_not_z_zero():
    """The interpretation this gate is built on, asserted rather than described.

    A part floating 50 mm up is not the failure being looked for -- every box
    the README centres on the origin has a negative zmin, and refusing those
    would be the false red. What is looked for is a part with no flat bottom AT
    ALL, wherever its bottom happens to be.
    """
    assert first_layer_area(_box(20.0, 10.0, 4.0, z0=50.0)) == pytest.approx(200.0)
    assert first_layer_area(_box(20.0, 10.0, 4.0, z0=-2.0)) == pytest.approx(200.0)


def test_a_pyramid_standing_on_its_apex_touches_the_bed_at_nothing():
    assert first_layer_area(_pyramid_on_its_apex()) == 0.0


def test_a_part_lying_on_an_edge_touches_the_bed_at_nothing():
    """45 degrees about X: the contact is a line, and a line has no area."""
    assert first_layer_area(_tilted(_box(20.0, 10.0, 10.0), 45.0)) == 0.0


def test_a_slab_tilted_by_one_degree_is_refused_and_that_is_correct():
    """The near miss, and the one worth being explicit about.

    One degree looks like nothing and prints like nothing: over a 10 mm face
    the far edge stands 0.17 mm off the bed, which is two layers. This is a
    refusal the author wants, not a false red -- the part is resting on an
    edge, and a slicer will either bridge it or drop supports under it.
    """
    assert first_layer_area(_tilted(_box(20.0, 10.0, 2.0), 1.0)) == 0.0


def test_a_box_on_the_bed_has_no_overhang_at_all():
    """Its only downward face IS the first layer, and the plate holds that up.

    This is the whole reason the band is subtracted: without it every part ever
    published would report its own contact patch as overhang, and the number
    would say nothing about anything.
    """
    assert overhang_area(_box(20.0, 10.0, 4.0)) == 0.0


def test_a_lonely_box_brings_its_own_bed_and_a_ledge_is_what_counts():
    """Lifting a box off z=0 changes NOTHING, and that is the point of the pair.

    The bed is the part's own lowest point, so a box floating at z=50 has its
    underside in the first-layer band exactly as it did on the plate: it reports
    zero, and a metric that answered otherwise would be measuring where the
    author happened to place the part. What a ledge has and a lonely box does
    not is something ELSE below it -- so the second half stacks two boxes, and
    the upper one's overhanging underside is off the band and counts.

    A METRIC AND NOT A CHECK: nothing here refuses this part, and nothing here
    asks whether there IS support under it. `checklib.unsupported_area` is the
    check, and the author chooses its budget.
    """
    lifted = _box(20.0, 10.0, 4.0)
    lifted.apply_translation((0.0, 0.0, 50.0))
    # Two triangles of 100 mm2 each: the whole underside, since `first_layer_area`
    # reads the bed as the part's OWN lowest point and this face is it.
    assert first_layer_area(lifted) == pytest.approx(200.0)
    assert overhang_area(lifted) == 0.0

    # And with a floor under it -- one box on top of another, as a part with a
    # ledge is -- the ledge's underside is off the bed and counts.
    stacked = trimesh.util.concatenate(_box(40.0, 10.0, 2.0),
                                       _box(20.0, 10.0, 4.0, z0=2.0))
    assert overhang_area(stacked) == pytest.approx(200.0)


def test_a_wall_is_not_an_overhang():
    """45 degrees is the line, and a vertical face is nowhere near it: a box's
    four sides point sideways, so a part made of nothing but walls and a bed
    face measures zero."""
    assert overhang_area(_box(20.0, 10.0, 40.0)) == 0.0


def test_the_angle_a_slicer_stops_bridging_at_is_where_this_starts_counting():
    """45 degrees is a decision, so it is asserted rather than described.

    A box turned about X presents two candidate faces and the tilt picks which
    of them is an overhang: the underside leans `degrees` off horizontal, and
    the flank that turned downwards leans `90 - degrees`. Either line on its own
    would hold across a wide range of thresholds; the two together pin it
    between 44 and 46 degrees, which is as close as whole-degree tilts come.
    """
    underside, flank = 200.0, 80.0
    box = _box(20.0, 10.0, 4.0)
    assert overhang_area(_tilted(box, 44.0)) == pytest.approx(underside)
    assert overhang_area(_tilted(box, 46.0)) == pytest.approx(flank)


def test_a_degenerate_triangle_from_the_tessellator_changes_nothing():
    """A triangle with no area at all is what OCC emits at the poles of a
    spherical face, so a real mesh arrives carrying them.

    IT WOULD PASS WITH THE AREA FILTER REMOVED, and that is worth saying rather
    than leaving for somebody to discover: a mesh ASSEMBLED IN MEMORY gets its
    normals computed, and a degenerate triangle's comes out zero, which fails
    the steepness test on its own. That is not the shape the gate sees -- a mesh
    LOADED FROM AN STL carries the normals OCC wrote, degenerate facets
    included, so there the same triangle arrives pointing steeply down. Both
    routes end at the same number, which is what this pins; the class below is
    what plants the loaded shape, since trimesh will not build it.
    """
    stacked = trimesh.util.concatenate(_box(40.0, 10.0, 2.0),
                                       _box(20.0, 10.0, 4.0, z0=2.0))
    pole = trimesh.Trimesh(
        vertices=np.array([(0.0, 0.0, 6.0)] * 3, dtype=float),
        faces=np.array([[0, 1, 2]], dtype=np.int64), process=False)
    planted = trimesh.util.concatenate(stacked, pole)
    assert overhang_area(planted) == pytest.approx(overhang_area(stacked))


class _Mesh:
    """The four things `overhang_area` reads off a mesh, and nothing else.

    Written by hand because trimesh's own constructor will not produce the
    pairing: it COMPUTES the normals it is not given, so a face with no area
    gets a zero normal and drops out of the steepness test. The gate's mesh
    comes off an STL instead, where the normals are read from the file and are
    whatever OCC wrote — a face can therefore point steeply down and carry an
    area that is not a number, which is the one shape that reaches the sum,
    since a `nan` fails every comparison and no test on the NORMAL excludes it.
    """

    def __init__(self, mesh, normal, area):
        self.bounds = mesh.bounds
        # OFF THE BED, deliberately: a planted face inside the first-layer band
        # is excluded by the band and this would pass with the filter gone.
        planted = mesh.triangles[0] + (0.0, 0.0, 5.0)
        self.triangles = np.vstack([mesh.triangles, [planted]])
        self.face_normals = np.vstack([mesh.face_normals, [normal]])
        self.area_faces = np.append(mesh.area_faces, area)


def test_a_face_with_no_area_cannot_poison_the_sum():
    """A `nan` in this number reaches metrics.json as a bare `NaN`, which is not
    JSON: every reader of the file then fails to parse it — the next build's
    diff, `hammerola diff`, and the client that fetched it."""
    stacked = trimesh.util.concatenate(_box(40.0, 10.0, 2.0),
                                       _box(20.0, 10.0, 4.0, z0=2.0))
    planted = _Mesh(stacked, normal=(0.0, 0.0, -1.0), area=math.nan)
    assert not math.isnan(overhang_area(planted))
    assert overhang_area(planted) == pytest.approx(overhang_area(stacked))


def test_the_thinnest_dimension_this_nozzle_can_print():
    """The arithmetic the bbox refusal is made of, at the default nozzle.

    Not a test of `minimum_feature` -- that one is in
    test_checklib_printability.py -- but of the comparison this gate makes with
    it: half a millimetre is under one pass of a 0.4 nozzle laid twice, and 0.8
    is exactly it.
    """
    assert 0.5 < minimum_feature()
    assert not 0.8 < minimum_feature()


def _cq():
    return pytest.importorskip(
        "cadquery", exc_type=ImportError,
        reason="the CAD kernel does not import in this interpreter, so there "
               "is no mesh for the gate to measure -- see this module's "
               "docstring")


def test_a_slab_on_its_edge_is_refused_because_nothing_lies_flat(out_dir):
    """A sphere would NOT prove this: gate part 2 refuses it as not watertight
    before the bed is ever measured, so the message is what is asserted here."""
    cq = _cq()
    slab = cq.Workplane("XY").box(20, 10, 5).rotate((0, 0, 0), (1, 0, 0), 45)
    read = catalogue(tilted_slab=("printable", slab))
    with pytest.raises(BuildError) as refused:
        export_printables(read, out_dir)
    message = str(refused.value)
    assert "'tilted_slab'" in message and "touches the bed at nothing" in message


def test_a_half_millimetre_slab_is_refused_on_its_smallest_dimension(out_dir):
    cq = _cq()
    read = catalogue(shim=("printable", cq.Workplane("XY").box(20, 10, 0.5)))
    with pytest.raises(BuildError) as refused:
        export_printables(read, out_dir)
    message = str(refused.value)
    assert "'shim'" in message and "0.500" in message and "0.800" in message


def test_an_ordinary_part_standing_on_the_bed_passes_both(out_dir):
    cq = _cq()
    plate = cq.Workplane("XY").box(20, 10, 4).translate((0, 0, 2))
    files, metrics = export_printables(catalogue(plate=("printable", plate)),
                                       out_dir)
    assert set(files) == {"plate"}
    assert metrics["plate"]["bbox_mm"] == pytest.approx([20.0, 10.0, 4.0])
