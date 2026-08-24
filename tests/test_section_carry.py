"""The section plane survives a live reload, and only a live reload (SPEC 8.8).

Autoupdate already kept the camera; the cut was thrown away. Carrying it is not
a matter of remembering the slider, and that is the whole content of this file:
the slider's zero is the centre of the CLIPPING REGION, which is the centre of
the grid, which is sized from the model's bounding box. Republish the model one
millimetre taller and the same number names a different physical plane.

Measured in a browser over CDP against a real hub, with a real CadQuery build
republished under an open page. Two runs, one model, `BOX_HEIGHT` 30 -> 50:

    grid              90     ->  120
    grid centre z     18     ->  28
    plane world z     11.9650 -> 11.9650   (carried)
    clip slider       -6.0350 -> -16.0350  (recomputed)
    the same NUMBER carried instead would put the plane at z = 21.9650

-- 10 mm of silent drift, on a change that moved nothing near the cut. What is
pinned here is the handful of rules that decide whether it comes out right:

  * a world normal and a world POINT cross the swap, never the value;
  * the value is recomputed by the SAME affine relation the placement uses, from
    one function, so the two cannot drift into two subtly different subtractions;
  * the restore does not re-aim the plane at the camera -- the normal it is
    handed is already the oriented one, and re-deciding would invert the cut for
    anybody who had turned the model since they made it;
  * a cut placed through the library's own Clip tab (`From view` + the slider)
    has no seed point, and is carried anyway;
  * and a change of VIEW is not a reload: `assembled` -> `print` is a reader
    choosing a different shape, and the cut still goes.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VIEWER = ROOT / "static" / "_v" / "viewer.js"


def _source():
    return VIEWER.read_text(encoding="utf-8")


def _function(name):
    """The body of a top-level `function name(...)` in viewer.js.

    Crude on purpose, and the same reader test_section_hold.py uses: it runs to
    the next line that starts in column zero with a closing brace, which is what
    every function in that file ends with.
    """
    source = _source()
    start = source.index(f"function {name}(")
    end = source.index("\n}\n", start)
    return source[start:end]


def _code(name):
    """`_function`, with the `//` commentary stripped out.

    These functions are more comment than code, and the comments name the very
    things some of the tests below assert are absent -- the note explaining why
    the restore does NOT call sectionViewDir reads, to a substring check,
    exactly like a call to sectionViewDir.
    """
    return "\n".join(line.split("//")[0] for line in _function(name).splitlines())


# -- what crosses the swap ----------------------------------------------------
def test_the_plane_crosses_the_swap_as_a_normal_and_a_point():
    """Not as a slider value. The bug this whole feature is about.

    Both are WORLD quantities: they describe the plane in the model's own space,
    where nothing about a rebuild can move them. The value is a reading on a
    ruler whose zero rides the bounding box.
    """
    code = _code("captureSection")
    assert "return { normal, point, placed:" in code, \
        "captureSection no longer returns a world normal and a world point"
    # The slider is READ -- that is how "is there a cut" is answered -- but it
    # must not be what leaves the function.
    assert "return { value" not in code and "slider" not in code.split("return {")[-1]


def test_the_captured_point_is_on_the_plane_and_not_where_the_seed_was():
    """The seed is where the reader CLICKED; the plane has been dragged since.

    Stepping the seed back along the normal by the plane's signed distance to it
    is what folds every drag in. Without it the carry would restore the plane to
    the face it was laid on, undoing the reader's depth.
    """
    code = _code("captureSection")
    assert "g.plane.distanceToPoint(point)" in code
    assert "point.x - normal[0] * d" in code, \
        "the captured point is no longer projected onto the plane"


def test_a_cut_the_page_never_placed_is_carried_too():
    """`From view` is the library's own Clip tab, and leaves no seed behind.

    So the question "is there a cut" is asked of the SLIDER -- a value below the
    limit means something is being cut, whichever tool did it -- and the point
    is taken from the origin instead of from a seed that does not exist. Driven
    in a browser: a From-view plane at n=(-0.58, 0.58, -0.58) came back with the
    same world constant 22.5958 after a rebuild that moved the grid centre by
    10 mm and its slider from 6.4300 to 0.6565.
    """
    code = _code("captureSection")
    assert "if (!sectionSeed) return" not in code, \
        "captureSection gives up without a seed; the From-view cut is lost again"
    assert "const lim = sectionLimit();" in code and "v >= lim" in code, \
        "'is there a cut' is no longer decided by the slider"
    assert "point.set(0, 0, 0)" in code, "no fallback point for a seedless cut"


def test_a_carried_cut_keeps_the_habits_of_the_tool_that_made_it():
    """A placed cut survives a trip to the Tree tab; a From-view one never has.

    `sectionSeed` is the difference (keepSectionCut reads exactly that), so the
    flag has to cross the swap with the plane. Without it a reload would quietly
    grant the library's cut a behaviour the reader never saw it have.
    """
    assert "placed: !!sectionSeed" in _code("captureSection")
    assert "if (keep.placed) sectionSeed = {" in _code("restoreSection"), \
        "the restore seeds unconditionally, or not at all"


# -- one relation, not two ----------------------------------------------------
def test_the_placement_and_the_carry_go_through_the_same_subtraction():
    """`v_new = v - plane.distanceToPoint(P)`, in ONE function (SPEC 7B/8.8).

    It is the same slope-of-1 relation both need, and a second copy of it is how
    the two end up disagreeing by a bias, a sign or a clamp.
    """
    slide = _code("slideSectionTo")
    assert "viewer.getClipSlider(SECTION_INDEX)" in slide
    assert "v0 - g.plane.distanceToPoint(pointVec) - back" in slide
    assert "viewer.setClipSlider(SECTION_INDEX, value, true)" in slide
    for caller in ("placeSectionPlane", "restoreSection"):
        code = _code(caller)
        assert "slideSectionTo(" in code, f"{caller} no longer shares the relation"
        assert "distanceToPoint" not in code, f"{caller} does the subtraction itself"
        assert "setClipSlider" not in code, f"{caller} writes the slider itself"


def test_the_carried_value_is_held_inside_the_sliders():
    """Geometry can change enough that the plane misses the part.

    Landing outside it is the honest answer -- the cut is plainly elsewhere and
    one drag brings it back. Running off to a number the sliders cannot express
    is not: `sectionValue` clamps to half the grid, the same bound a drag gets.
    """
    assert "sectionValue(v0 -" in _code("slideSectionTo"), \
        "the carried value is no longer clamped to the grid"


def test_the_restore_does_not_re_aim_the_plane_at_the_camera():
    """The normal in hand is already the oriented one.

    placeSectionPlane flips a face normal to point away from the camera, because
    that is the half-space a section opens. Doing it again on the way back would
    invert the cut for a reader who had turned the model past a quarter turn --
    the same plane, the wrong side kept.
    """
    code = _code("restoreSection")
    assert "sectionViewDir" not in code
    assert "dot3" not in code
    assert "-normal[0]" not in code and "-keep.normal" not in code
    assert "viewer.setClipNormal(SECTION_INDEX, keep.normal, null, true)" in code, \
        "the captured normal is no longer put back verbatim"


# -- where it is wired in -----------------------------------------------------
def test_the_swap_captures_the_plane_and_puts_it_back_after_the_tab():
    """Order is load-bearing.

    The library turns clipping on when its Clip tab is selected and off when it
    is left, so a plane restored before the tab moved is a plane the library
    then un-cuts. keepSectionCut at the end is what carries it onto every other
    tab, and it has to run: `render` left local clipping off.
    """
    assert "section: captureSection()" in _code("captureLive")
    restore = _code("restoreLive")
    assert "restoreSection(keep.section)" in restore
    assert restore.index("setActiveTab") < restore.index("restoreSection"), \
        "the plane is restored before the tab, where the library will drop it"
    assert "keepSectionCut();" in _code("restoreSection")


def test_a_change_of_view_still_drops_the_cut():
    """`assembled` -> `print` is a choice, not a republish.

    A depth measured on one shape says nothing about the other, so showVariant
    clears the seed unconditionally and restores nothing. Only swapBuild -- which
    captured the plane on the way in -- puts one back.
    """
    show = _code("showVariant")
    assert "sectionSeed = null;" in show
    assert "restoreSection" not in show and "captureSection" not in show, \
        "showVariant now carries the cut, and a view switch keeps a stale plane"
    swap = _code("swapBuild")
    assert "captureLive()" in swap and "restoreLive(keep)" in swap


def test_the_carry_reaches_the_library_through_the_guarded_accessor():
    """`sectionInternals()` is the one door, and it checks what these lean on.

    It refuses a plane with no `distanceToPoint` -- which is the single method
    the value maths needs -- so a library upgrade that moves it costs the carry
    and nothing else.
    """
    for name in ("captureSection", "restoreSection", "slideSectionTo"):
        code = _code(name)
        if name != "slideSectionTo":
            assert "sectionInternals()" in code, f"{name} skips the guarded door"
        assert "viewer.clipping" not in code and "viewer.renderer" not in code, \
            f"{name} reaches into the library on its own"
    assert 'typeof plane.distanceToPoint !== "function"' in _code("sectionInternals")
