"""`distcache` -- a distance measured by an earlier build, answered again.

Each "build" here is an `install` on the same file, with an `uninstall` before
the next one: that empties everything the process remembered, as a new build
process starts empty, and leaves only the file to carry the answer over.

Every test needs the CAD kernel and skips without it; the CI image carries it.
"""

import pytest

from src.cadbuild import distcache


def _cq():
    return pytest.importorskip(
        "cadquery", exc_type=ImportError,
        reason="the CAD kernel does not import in this interpreter, so there "
               "is no distance to cache")


@pytest.fixture
def cache(tmp_path):
    """Where the project's cache lives, and the patch taken off afterwards."""
    yield tmp_path / "cache" / "abc123def456" / "distance.sqlite"
    distcache.uninstall()


def _kernel(*args):
    """The kernel's own answer, from the class the cache stands in for."""
    return distcache._original(*args).Value()


def _pair(gap=4.0):
    """Two unit cubes `gap` apart along X, built afresh as a new build would."""
    cq = _cq()
    left = cq.Workplane().box(1, 1, 1).val()
    right = cq.Workplane().box(1, 1, 1).translate((gap + 1, 0, 0)).val()
    return left, right


def _kernel_performs(monkeypatch):
    """Every Perform the kernel itself runs, under the cache or not."""
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape as kernel

    calls = []
    real = kernel.Perform

    def spy(self, *args):
        calls.append(args)
        return real(self, *args)

    monkeypatch.setattr(kernel, "Perform", spy)
    return calls


def _measure_once(cache):
    """The first build: measures the pair and leaves it in the file."""
    distcache.install(cache)
    left, right = _pair()
    assert left.distance(right) == pytest.approx(4.0)
    distcache.uninstall()


def test_the_next_build_takes_the_distance_from_the_file(cache, monkeypatch):
    _measure_once(cache)
    performs = _kernel_performs(monkeypatch)

    distcache.install(cache)
    left, right = _pair()
    assert left.distance(right) == pytest.approx(4.0)
    assert performs == [], "the kernel computed a distance the file holds"
    assert distcache.counts() == (1, 1)


def test_a_moved_body_is_measured_again(cache, monkeypatch):
    _measure_once(cache)
    performs = _kernel_performs(monkeypatch)

    distcache.install(cache)
    left, right = _pair(gap=6.0)
    assert left.distance(right) == pytest.approx(6.0)
    assert len(performs) == 1
    assert distcache.counts() == (0, 1)


def test_a_body_moved_in_place_is_measured_where_it_is_now(cache):
    """`move` changes the shape under the same Python object, so anything kept
    for that object is about a shape that is no longer there. Twenty moves,
    because what such a cache gets wrong after one move depends on where the
    moved shape's hash happens to land in a dict."""
    distcache.install(cache)
    left, right = _pair()
    for step in range(20):
        expected = _kernel(left.wrapped, right.wrapped)
        assert expected == pytest.approx(4.0 + step), "the premise: it moved"
        assert left.distance(right) == pytest.approx(expected)
        left.move(-1, 0, 0)


def test_a_compound_added_to_after_a_measurement_is_measured_whole(cache):
    """`BRep_Builder.Add` changes a compound under the same Python object."""
    cq = _cq()
    from OCP.BRep import BRep_Builder

    distcache.install(cache)
    probe = cq.Workplane().box(1, 1, 1).val()
    group = cq.Compound.makeCompound(
        [cq.Workplane().box(1, 1, 1).translate((10, 0, 0)).val()])
    assert probe.distance(group) == pytest.approx(9.0)

    BRep_Builder().Add(group.wrapped,
                       cq.Workplane().box(1, 1, 1).translate((3, 0, 0)).val().wrapped)
    expected = _kernel(probe.wrapped, group.wrapped)
    assert expected == pytest.approx(2.0), "the premise: the add happened"
    assert probe.distance(group) == pytest.approx(expected)


def test_a_shape_moved_between_load_and_perform_is_measured_as_loaded(cache):
    """The kernel copies a shape when it is loaded, so a later `move` does not
    reach what it measures -- and the row has to be the loaded pair's, or the
    moved pair inherits the loaded pair's distance."""
    distcache.install(cache)
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    reference, right = _pair()
    kernel = distcache._original()
    kernel.LoadS1(reference.wrapped)
    kernel.LoadS2(right.wrapped)
    reference.move(2, 0, 0)
    kernel.Perform()
    assert kernel.Value() == pytest.approx(4.0), "the premise: as loaded"

    left, _ = _pair()
    measure = BRepExtrema_DistShapeShape()
    measure.LoadS1(left.wrapped)
    measure.LoadS2(right.wrapped)
    left.move(2, 0, 0)
    measure.Perform()
    assert measure.Value() == pytest.approx(kernel.Value())
    assert left.distance(right) == pytest.approx(_kernel(left.wrapped,
                                                         right.wrapped))


def test_another_flag_is_another_key(cache):
    from OCP.Extrema import Extrema_ExtFlag_MAX, Extrema_ExtFlag_MIN

    distcache.install(cache)
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    left, right = _pair()
    for flag in (Extrema_ExtFlag_MIN, Extrema_ExtFlag_MAX):
        measure = BRepExtrema_DistShapeShape(left.wrapped, right.wrapped, flag)
        assert measure.Value() == pytest.approx(
            _kernel(left.wrapped, right.wrapped, flag))
    assert distcache.counts() == (0, 2), (
        "the second flag was answered from the first one's row")


def test_the_points_after_a_cached_answer_are_the_kernels(cache):
    """A cached answer holds only the value; asking for a point computes."""
    _measure_once(cache)
    distcache.install(cache)
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    left, right = _pair()
    measure = BRepExtrema_DistShapeShape(left.wrapped, right.wrapped)
    assert distcache.counts() == (1, 1), "the premise: the value came from the file"
    assert measure.Value() == pytest.approx(4.0)
    assert measure.PointOnShape1(1).X() == pytest.approx(0.5)
    assert measure.PointOnShape2(1).X() == pytest.approx(4.5)


def test_the_points_after_a_hit_are_of_the_body_as_it_was_loaded(cache):
    """The points are computed from the copy taken at load, not from the
    caller's object: moving that in place after the hit changes nothing."""
    _measure_once(cache)
    distcache.install(cache)
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    left, right = _pair()
    measure = BRepExtrema_DistShapeShape(left.wrapped, right.wrapped)
    assert distcache.counts() == (1, 1), "the premise: the value came from the file"
    left.move(2, 0, 0)
    assert measure.PointOnShape1(1).X() == pytest.approx(0.5)
    assert measure.Value() == pytest.approx(4.0)


def test_a_cache_that_cannot_be_opened_still_measures(cache, capsys):
    cache.parent.parent.mkdir(parents=True)
    cache.parent.write_text("a file where the directory should be")

    distcache.install(cache)
    left, right = _pair()
    assert left.distance(right) == pytest.approx(4.0)

    warnings = [line for line in capsys.readouterr().out.splitlines()
                if line.startswith("warning:")]
    assert len(warnings) == 1 and str(cache) in warnings[0]


def test_a_cache_that_fails_mid_build_gives_the_kernels_answers(cache, capsys):
    distcache.install(cache)
    distcache._connection.close()

    left, right = _pair()
    for _measurement in range(2):
        assert left.distance(right) == pytest.approx(
            _kernel(left.wrapped, right.wrapped))

    warnings = [line for line in capsys.readouterr().out.splitlines()
                if line.startswith("warning:")]
    assert len(warnings) == 1, warnings
