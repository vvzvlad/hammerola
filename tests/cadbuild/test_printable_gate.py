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
kernel does not import, i.e. in CI.
"""

import math

import numpy as np
import pytest
import trimesh

from fakes import catalogue
from src.cadbuild.checklib import minimum_feature
from src.cadbuild.errors import BuildError
from src.cadbuild.printables import export_printables, first_layer_area


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


def test_the_thinnest_dimension_this_nozzle_can_print():
    """The arithmetic the bbox refusal is made of, at the default nozzle.

    Not a test of `minimum_feature` -- that is checklib's -- but of the
    comparison this gate makes with it: half a millimetre is under one pass of
    a 0.4 nozzle laid twice, and 0.8 is exactly it.
    """
    assert 0.5 < minimum_feature()
    assert not 0.8 < minimum_feature()


def _cq():
    return pytest.importorskip(
        "cadquery", exc_type=ImportError,
        reason="the CAD kernel does not import in this interpreter, so there "
               "is no mesh for the gate to measure -- see this module's "
               "docstring")


def test_a_sphere_is_refused_because_it_rests_on_a_point(out_dir):
    cq = _cq()
    read = catalogue(ball=("printable", cq.Workplane("XY").sphere(10)))
    with pytest.raises(BuildError) as refused:
        export_printables(read, out_dir)
    assert "'ball'" in str(refused.value)


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
