"""`checklib.deviation` -- the scan of the real part against the model of it.

Two claims are worth separating, because a test of either alone can pass while
the other is false. THE SEARCH IS EXACT: the KD-tree over facet centres plus the
`bound + reach` ball returns the same nearest facet brute force does, held here
against `trimesh.proximity.closest_point_naive` over the very same triangle
soup. AND THE SOUP IS THE MODEL'S SURFACE: the bisection that makes the ball
narrow splits facets without moving the surface they cover, and the whole of it
-- tessellation, bisection, sign -- lands on the number a sphere of a known
radius must give. The first test cannot see a bisection that lost area (it
compares against the same soup) and the second cannot localise an error; both
are needed.

Everything but the one refusal needs the CAD kernel and skips without it, the
same split `test_checklib_printability.py` makes. CI's test container has the
kernel (issue #27), so it all runs there.

The known case throughout is a pair of spheres: a model of radius 10 and a scan
of radius 10.5 is +0.5 mm everywhere by construction, with the tessellation's own
sag -- measured 12 um at this radius and the one angular tolerance this module
has -- as the only thing between that and the reading. Nothing about the answer
depends on where the scan sits relative to the model's centre, which is the
point: `deviation` moves nothing, so a scan is measured where the author put it.
"""

import pytest

from src.cadbuild import checklib
from src.cadbuild.palette import MOCK_COLOR
from src.cadbuild.parts import KIND_MOCK, catalogue_colors, read_catalogue

def _cq():
    return pytest.importorskip(
        "cadquery", exc_type=ImportError,
        reason="the CAD kernel does not import in this interpreter, so a model "
               "cannot be tessellated -- see this module's docstring")


def _numpy():
    return pytest.importorskip("numpy")


def _trimesh():
    return pytest.importorskip("trimesh")


class Model:
    """The one door `read_catalogue` opens."""

    def __init__(self, catalogue):
        self._catalogue = catalogue

    def parts(self):
        return self._catalogue


def _sphere_scan(radius, subdivisions=4):
    """An icosphere whose vertices sit exactly `radius` from the origin."""
    return _trimesh().creation.icosphere(subdivisions=subdivisions, radius=radius)


# --------------------------------------------------------------------------
# The refusal -- plain Python, so it runs wherever pytest does
# --------------------------------------------------------------------------

def test_deviation_refuses_a_band_of_no_width():
    """Before the scan or the model is looked at -- which is why None stands in."""
    for tolerance in (0.0, -0.1):
        with pytest.raises(ValueError, match="half-width"):
            checklib.deviation(None, None, tolerance)


# --------------------------------------------------------------------------
# The measurements -- these need the kernel
# --------------------------------------------------------------------------

def test_the_bisection_splits_the_surface_without_moving_it():
    """The facets get smaller and the surface stays where it was.

    Both halves matter and neither implies the other: an area that survives says
    nothing was lost, and a reach under the limit is what makes the search ball
    narrow. A bisection that dropped a facet would leave the exactness test below
    perfectly green, because that test measures against the soup this produces.
    """
    cq, numpy = _cq(), _numpy()
    corners, faces = (cq.Workplane("XY").box(20, 14, 8).faces(">Z").hole(6)
                      .val().tessellate(0.02, checklib._TESSELLATION_ANGLE))
    coarse = numpy.array([(v.x, v.y, v.z) for v in corners],
                         dtype=float)[numpy.array(faces, dtype=numpy.int64)]
    fine = checklib._bisected(coarse, 0.5)

    def area(triangles):
        return float(numpy.linalg.norm(
            numpy.cross(triangles[:, 1] - triangles[:, 0],
                        triangles[:, 2] - triangles[:, 0]), axis=1).sum() / 2.0)

    assert checklib._reach(coarse).max() > 0.5 and len(fine) > len(coarse)
    assert checklib._reach(fine).max() <= 0.5
    assert area(fine) == pytest.approx(area(coarse), rel=1e-9)


def test_the_distance_is_the_one_brute_force_measures():
    """The ball query against `closest_point_naive`, which looks at every facet.

    The shape is chosen to be the case an approximation fails on: a 1 mm wall
    with a hole through it, so most of the volume is within a millimetre of two
    surfaces at once. Measured 2026-09-26 the two agree EXACTLY -- the assertion
    leaves a bit of room because the two compute the length of the same vector by
    different routes, not because the facet chosen can differ.

    A DELIBERATELY COARSE `facet`, which is both halves of what this measures.
    `closest_point_naive` is quadratic in space -- it builds one array of
    points x facets -- so 2 479 facets here against the 307 127 the default would
    bisect this shape into is 24 MB rather than 2.9 GB, and it also leaves the
    widest `reach` at 2 mm: the ball then holds a hundred-odd candidates per point
    instead of a handful, which is more of the search exercised rather than less
    -- the per-facet exclusion included, since the radii now span a decade.
    """
    cq, numpy, trimesh = _cq(), _numpy(), _trimesh()
    soup, normals, tree, reach = checklib._facets(
        cq.Workplane("XY").box(20, 14, 8).faces(">Z").shell(-1.0).faces(">X").hole(4),
        0.1, 2.0, "deviation(t)")
    brute = trimesh.Trimesh(vertices=soup.reshape(-1, 3),
                            faces=numpy.arange(3 * len(soup)).reshape(-1, 3),
                            process=False)
    points = numpy.random.default_rng(7).uniform(
        [-14, -11, -6], [14, 11, 12], size=(400, 3))

    mine = checklib._signed_distance(points, soup, normals, tree, reach)
    _, theirs, _ = trimesh.proximity.closest_point_naive(brute, points)
    assert numpy.abs(numpy.abs(mine) - theirs).max() < 1e-12


def test_the_sign_is_the_nearest_facets_and_a_reversed_face_keeps_it():
    """In the WALL of a shelled box the reading is negative; in the cavity, positive.

    Which way round this is decides where the map paints blue and where red, and
    it rests on `Shape.tessellate` reversing the winding of a reversed face --
    which the inner surface of a shell is. The magnitudes are identical either
    way, so the one other test that shells a box cannot see the sign flip: it
    compares `abs()` against brute force.

    The two points are 0.3 mm inside the outer wall of a 1 mm shell, and the
    middle of the cavity, whose nearest surface is the inner floor 3 mm below.
    Neither is near a tie, so the case `_signed_distance` leaves undecided -- a
    point exactly in the plane of the facet that won -- is not in play.
    """
    cq, numpy = _cq(), _numpy()
    walled = cq.Workplane("XY").box(20, 14, 8).faces(">Z").shell(-1.0)
    at = checklib._signed_distance(
        numpy.array([[-9.7, 0.0, 0.0], [0.0, 0.0, 0.0]]),
        *checklib._facets(walled, 0.1, 2.0, "deviation(t)"))

    assert at[0] == pytest.approx(-0.3, abs=0.01)
    assert at[1] == pytest.approx(3.0, abs=0.01)


def test_the_answer_does_not_depend_on_what_meshed_the_shape_before():
    """A shape carrying somebody else's triangulation reads like a fresh one.

    `Shape.mesh` remeshes only when the shape has no triangulation at the LINEAR
    tolerance asked for, so a shape meshed once already answers with THAT mesh
    and the angular tolerance this module steers by is dropped on the floor. Two
    ordinary things reach it: a `@cache`-decorated builder handing the same
    object to a second call, and the STL export the build runs before `checks()`.

    Measured 2026-09-26, the pre-meshed sphere read `maximum` 0.51998 against the
    0.51166 a fresh one reads -- a tenth of the band being measured, off a model
    and a scan that had not moved.
    """
    cq = _cq()
    scan = _sphere_scan(10.5)
    twice = cq.Workplane("XY").sphere(10)
    first = vars(checklib.deviation(scan, twice, 0.1)[1])
    again = vars(checklib.deviation(scan, twice, 0.1)[1])

    meshed = cq.Workplane("XY").sphere(10)
    meshed.val().mesh(0.001, 0.5)
    borrowed = vars(checklib.deviation(scan, meshed, 0.1)[1])

    fresh = vars(checklib.deviation(scan, cq.Workplane("XY").sphere(10), 0.1)[1])
    assert again == first == borrowed == fresh


def test_a_scan_larger_than_the_model_reads_as_missing_material():
    """+0.5 mm everywhere, and one band holding the whole of it."""
    bands, report = checklib.deviation(
        _sphere_scan(10.5), _cq().Workplane("XY").sphere(10), 0.1)

    assert sorted(bands) == ["deviation_outside"]
    assert report.points == len(_sphere_scan(10.5).vertices)
    # A tessellation lies INSIDE a convex surface and never outside it, so
    # nothing can read nearer than the 0.5 mm the two radii differ by, and the
    # sag -- measured 12 um at this radius -- is the whole of the spread above it.
    assert report.minimum >= 0.5
    assert 0.5 < report.maximum < 0.52
    # Everything is out the SAME way here, so the two medians coincide. The test
    # below on a scan that strays both ways is what separates them.
    assert 0.5 < report.median_signed < 0.51
    assert report.median_absolute == report.median_signed
    assert report.within[0.1] == 0.0


def test_a_scan_smaller_than_the_model_reads_as_a_model_too_thick():
    """The same distance with the other sign -- the half of it a normal decides."""
    bands, report = checklib.deviation(
        _sphere_scan(9.5), _cq().Workplane("XY").sphere(10), 0.1)

    assert sorted(bands) == ["deviation_inside"]
    # The same 0.5 mm floor read from the other side: the tessellation stands
    # inside the true sphere, so a scan inside that is nearer to it than to the
    # surface it stands for -- never further.
    assert report.minimum >= -0.5
    assert -0.5 < report.maximum < -0.48
    assert -0.5 < report.median_signed < -0.49
    assert report.median_absolute == -report.median_signed


def test_the_two_medians_are_not_one_number():
    """A scan that strays both ways: the signed median says 0.05, the truth is 0.5.

    The failure this is here for is a reading of `median_signed` as "how far off
    the print is". Three zones of roughly a third of the surface each -- 0.6 mm
    in, 0.05 mm out, 0.5 mm out -- put the SIGNED median in the middle zone,
    because the zone that straddles the crossing is the one that is nearly right,
    while two thirds of the surface is half a millimetre out or worse. A single
    `median` printed next to `within` reads as the second of those and is the
    first, which is why neither of them is called that.
    """
    numpy, trimesh = _numpy(), _trimesh()
    base = _sphere_scan(10.0)
    corner = numpy.asarray(base.vertices)
    outward = corner / numpy.linalg.norm(corner, axis=1)[:, None]
    # A sphere's zones have area in proportion to their height (Archimedes), so
    # cutting at z = -2 and z = 4 is roughly 40/30/30 of the surface.
    strayed = numpy.where(corner[:, 2] < -2.0, -0.6,
                          numpy.where(corner[:, 2] > 4.0, 0.5, 0.05))
    scan = trimesh.Trimesh(vertices=corner + outward * strayed[:, None],
                           faces=base.faces, process=False)

    _, report = checklib.deviation(scan, _cq().Workplane("XY").sphere(10), 0.1)

    assert report.median_signed == pytest.approx(0.05, abs=0.02)
    assert report.median_absolute == pytest.approx(0.5, abs=0.02)
    assert report.within[0.1] == pytest.approx(0.31, abs=0.06)


def test_the_bands_are_the_scan_cut_by_how_far_it_strayed():
    """Three bands, each a piece of the scan, each a catalogue entry as it stands.

    The scan is pushed 0.3 mm in below one latitude and 0.3 mm out above another
    and left alone in between, so all three bands exist and every face of the
    scan lands in exactly one of them.

    IT GOES THROUGH `read_catalogue` AND `catalogue_colors` rather than being
    inspected field by field, because that is where the two things this design
    rests on are decided: that `"mock"` is a kind the build accepts for a mesh,
    and that a colour written into the entry BEATS the grey a mock is otherwise
    painted. Without the second, all three bands come out one colour.
    """
    cq, numpy, trimesh = _cq(), _numpy(), _trimesh()
    model = cq.Workplane("XY").sphere(10)
    base = _sphere_scan(10.0)
    corner = numpy.asarray(base.vertices)
    outward = corner / numpy.linalg.norm(corner, axis=1)[:, None]
    strayed = numpy.where(corner[:, 2] < -4.0, -0.3,
                          numpy.where(corner[:, 2] > 4.0, 0.3, 0.0))
    scan = trimesh.Trimesh(vertices=corner + outward * strayed[:, None],
                           faces=base.faces, process=False)

    bands, report = checklib.deviation(scan, model, 0.1, name="gap")

    assert sorted(bands) == ["gap_inside", "gap_outside", "gap_within"]
    # Every face of the scan is in exactly one band and none is invented.
    assert sum(len(record["mesh"].faces)
               for record in bands.values()) == len(scan.faces)
    assert all(record["kind"] == KIND_MOCK for record in bands.values())
    assert report.minimum == pytest.approx(-0.3, abs=0.03)
    assert report.maximum == pytest.approx(0.3, abs=0.03)

    read = read_catalogue(Model(
        dict(bands, ball={"shape": model, "kind": "printable"})))
    painted = {key: colour for key, colour in catalogue_colors(read).items()
               if key in bands}
    assert len(set(painted.values())) == 3
    assert MOCK_COLOR not in painted.values()


def _strayed_scan(base, out_beyond_z):
    """`base` with every vertex past +-`out_beyond_z` pushed 0.3 mm outwards."""
    numpy, trimesh = _numpy(), _trimesh()
    corner = numpy.asarray(base.vertices)
    outward = corner / numpy.linalg.norm(corner, axis=1)[:, None]
    strayed = numpy.where(numpy.abs(corner[:, 2]) > out_beyond_z, 0.3, 0.0)
    return trimesh.Trimesh(vertices=corner + outward * strayed[:, None],
                           faces=base.faces, process=False)


def test_the_report_counts_the_surface_under_each_threshold():
    """`within` is a fraction, it is nested, and 0.5 mm covers a 0.3 mm stray."""
    _, report = checklib.deviation(
        _strayed_scan(_sphere_scan(10.0), 4.0),
        _cq().Workplane("XY").sphere(10), 0.1, thresholds=(0.05, 0.1, 0.5))

    assert sorted(report.within) == [0.05, 0.1, 0.5]
    assert report.within[0.5] == pytest.approx(1.0)
    assert 0.3 < report.within[0.1] < 0.7
    assert report.within[0.05] <= report.within[0.1]


def test_the_figures_follow_the_area_and_not_how_many_points_fell_on_it():
    """Measuring one zone more densely must not make the report about that zone.

    The same scan twice, the second with the UNTOUCHED middle subdivided twice
    over: sixteen times the faces in that zone and six times the vertices in the
    whole scan, over exactly the same surface standing in exactly the same place.
    A fraction counted per vertex would move a
    long way -- most of the scan's points are now in the middle -- and one
    weighted by area does not move at all, which is what `_weighted_median` and
    `within` claim about themselves. Measured 2026-09-26, a per-vertex `within`
    reads 0.42 on the first and 0.91 on the second, so both assertions below turn
    red if the weighting is ever dropped.
    """
    numpy, trimesh = _numpy(), _trimesh()
    model = _cq().Workplane("XY").sphere(10)
    base = _sphere_scan(10.0, subdivisions=3)
    thicker, refaced = numpy.asarray(base.vertices), numpy.asarray(base.faces)
    for _ in range(2):
        thicker, refaced = trimesh.remesh.subdivide(
            thicker, refaced,
            face_index=numpy.flatnonzero(numpy.abs(
                thicker[refaced][:, :, 2]).max(axis=1) <= 4.0))

    _, sparse = checklib.deviation(_strayed_scan(base, 4.0), model, 0.1)
    _, dense = checklib.deviation(
        _strayed_scan(trimesh.Trimesh(vertices=thicker, faces=refaced, process=False),
                      4.0), model, 0.1)

    assert dense.points > 3 * sparse.points
    assert dense.within[0.1] == pytest.approx(sparse.within[0.1], abs=0.02)
    assert dense.median_absolute == pytest.approx(sparse.median_absolute, abs=0.02)


# --------------------------------------------------------------------------
# The machinery that holds the cost down, and what it must not move
# --------------------------------------------------------------------------

def test_the_passes_cover_every_point_and_a_fat_one_stands_alone():
    """Plain arithmetic, so it runs without the kernel -- and it is the only
    place the multi-pass path is exercised at all.

    A build's scan is cut into passes by CANDIDATE ROWS rather than by points,
    because rows are what the memory is made of. Two edges decide whether that
    is safe: a point whose own row count exceeds the whole budget still has to
    be measured, alone, rather than skipped; and no point may fall between two
    passes. Both are invisible in every other test here, whose scans fit in one
    pass by three orders of magnitude.
    """
    numpy = _numpy()
    assert list(checklib._passes(numpy.array([], dtype=int), 10)) == []
    assert list(checklib._passes(numpy.array([50]), 10)) == [(0, 1)]
    assert list(checklib._passes(numpy.array([50, 1, 1]), 10)) == [(0, 1), (1, 3)]
    assert list(checklib._passes(numpy.array([4, 4, 4]), 10)) == [(0, 2), (2, 3)]


def test_the_row_budget_moves_the_memory_and_not_the_answer(monkeypatch):
    """The specification of the cut: it is a cut, not a measurement.

    Forced narrow enough that nearly every point is a pass of its own, the
    answer has to come out the same as it does in one pass -- otherwise the
    budget is quietly deciding what the scan reads.
    """
    model = _cq().Workplane("XY").sphere(10)
    scan = _sphere_scan(10.3, subdivisions=2)

    _, whole = checklib.deviation(scan, model, 0.1)
    monkeypatch.setattr(checklib, "_DEVIATION_ROWS", 31)
    _, chopped = checklib.deviation(scan, model, 0.1)

    assert vars(chopped) == vars(whole)


def test_the_facet_limit_moves_the_clock_and_not_the_answer(monkeypatch):
    """Why `_FACET_PER_DIAGONAL` may be retuned without reading the model again.

    The bisection exists to narrow the search ball, and the whole argument for
    tuning it on a stopwatch is that it cannot reach the reading: a facet split
    in two covers what it covered before, and the exclusion radius is read off
    whatever facets came out. Retune it here and the figures have to sit still.
    """
    model = _cq().Workplane("XY").sphere(10)
    scan = _sphere_scan(10.3, subdivisions=3)

    monkeypatch.setattr(checklib, "_FACET_PER_DIAGONAL", 50)
    _, coarse = checklib.deviation(scan, model, 0.1)
    monkeypatch.setattr(checklib, "_FACET_PER_DIAGONAL", 400)
    _, fine = checklib.deviation(scan, model, 0.1)

    for field, value in vars(coarse).items():
        assert value == pytest.approx(getattr(fine, field), abs=1e-9)


def test_the_shape_is_left_without_the_triangulation_this_call_made():
    """The half of `_tessellated` that protects everybody ELSE.

    OCCT computes a bounding box off whatever triangulation a shape carries, so
    a mesh left behind makes every later `BoundingBox()` read big -- never
    small, which is what makes it pass unnoticed. `geometry.drop_mesh` exists
    for this one reason and `tests/cadbuild/test_drop_mesh.py` for that one; the
    same claim is made here, so it is held here too.
    """
    model = _cq().Workplane("XY").sphere(5)
    before = model.val().BoundingBox().zlen

    checklib.deviation(_sphere_scan(5.2, subdivisions=2), model, 0.1)

    assert model.val().BoundingBox().zlen == pytest.approx(before, abs=1e-12)


def test_the_model_is_measured_at_the_angle_the_stls_are_written_at():
    """Two constants that have to stay equal, and nothing else says so.

    A reading taken at one angular tolerance and a printed part written at
    another disagree by the difference between the two tessellations, and
    neither number carries a note about which mesh it came from.
    """
    from src.cadbuild import artifacts

    assert checklib._TESSELLATION_ANGLE == artifacts.STL_ANGULAR_TOLERANCE
