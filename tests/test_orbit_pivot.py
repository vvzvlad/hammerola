"""The model turns about the point under the cursor, the way Fusion does.

The trackball in the vendored viewer turns about `target`, and `target` is
always in the middle of the canvas: its `update()` rebuilds the camera position
as `target + eye` and ends in `lookAt(target)`. So the pivot is not a setting
left on the wrong value — it is where the axis of that trackball lives, and
swapping `target` for the picked point does not work, because `lookAt` would
then turn the whole view the moment the press landed.

What `static/_v/viewer.js` does instead is the shape the cursor zoom already
has: let the library rotate exactly as it always has, then slide the camera
sideways so the grabbed point lands back on the pixel it was grabbed at. The
arithmetic of that slide is the first half of this file, replicated in Python
and checked against the projection it claims to invert; the second half pins the
shape of the code around it, which is where the failure modes live (a pivot
re-picked every frame, a listener parked on a controls object the library has
since replaced, a correction that re-enters itself).

MEASURED IN CHROME against this branch, driven through CDP with trusted pointer
events, ortho camera, 1266x722 canvas, a 15-step drag of (+140, -70) px:

    grabbed point                     before        after
    edge, 430,563 (off centre)        148.7 px      0.70 px
    vertex, 506,274 (off centre)      --            0.95 px
    face at the canvas centre         137.4 px      0.71 px
    background (nothing picked)       target unmoved, as before

0.70 px is not drift: the picker reads a PIXEL, so the point it returns is up to
half a pixel off that pixel's centre, and the same 0.70 px is already there
before the press. The gesture itself adds 0.00 px. Everything else measured
unchanged to the last digit with the patch in and out: wheel zoom to cursor
0.29 px, pinch 1.03 px on a x2.0000 gesture, swipe pan 480.0 px for 480 px of
delta, right-button pan, the section click and the hold key, the comment anchor.
"""

import math
import re
from pathlib import Path

VIEWER = Path(__file__).resolve().parent.parent / "static" / "_v" / "viewer.js"
BUNDLE = (Path(__file__).resolve().parent.parent / "static" / "_v"
          / "three-cad-viewer.esm.js")


def _source():
    return VIEWER.read_text(encoding="utf-8")


def _function(name):
    """The body of a top-level `function name(...)` in viewer.js."""
    source = _source()
    start = source.index(f"function {name}(")
    end = source.index("\n}\n", start)
    return source[start:end]


def _code(name):
    """`_function`, with the `//` commentary stripped out.

    These functions are more comment than code, and the comments name the very
    things some of the tests below assert are absent -- the note saying that
    nothing here calls preventDefault reads, to a substring check, exactly like
    a call to preventDefault.
    """
    return "\n".join(line.split("//")[0] for line in _function(name).splitlines())


# -- the arithmetic, in Python -----------------------------------------------
# An orthographic camera is a position C and three unit axes: right, up and the
# view axis. A world point lands on the canvas at
#
#     px = w/2 + s * (P - C).right,   py = h/2 - s * (P - C).up
#
# with s the pixels per world unit, which zoom scales and which cancels out of
# everything below. That is the whole projection this feature inverts.

def _sub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def _add(a, b):
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _scale(a, k):
    return [a[0] * k, a[1] * k, a[2] * k]


def _cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]]


def _unit(a):
    n = math.sqrt(_dot(a, a))
    return [a[0] / n, a[1] / n, a[2] / n]


def _rotate(v, axis, angle):
    """Rodrigues, which is how the trackball turns its eye vector too."""
    k = _unit(axis)
    c, s = math.cos(angle), math.sin(angle)
    return _add(_add(_scale(v, c), _scale(_cross(k, v), s)),
                _scale(k, _dot(k, v) * (1 - c)))


class Camera:
    """The ortho camera this page draws with, and nothing more of it."""

    W, H, S = 1266.0, 722.0, 8.0     # canvas pixels, and pixels per world unit

    def __init__(self, position, right, up, target_distance=300.0):
        self.C = list(position)
        self.right = _unit(right)
        self.up = _unit(up)
        self.view = _cross(self.up, self.right)   # right x up is -view
        self.view = _unit(_scale(self.view, -1))
        self.L = target_distance

    @property
    def target(self):
        return _add(self.C, _scale(self.view, self.L))

    def project(self, p):
        rel = _sub(p, self.C)
        return (self.W / 2 + self.S * _dot(rel, self.right),
                self.H / 2 - self.S * _dot(rel, self.up))

    def ndc_offset(self, px, py):
        """viewer.js `ndcOffset`: where the ray through a pixel runs, from C."""
        return _add(_scale(self.right, (px - self.W / 2) / self.S),
                    _scale(self.up, (self.H / 2 - py) / self.S))

    def perp(self, p):
        """The part of `p - C` an ortho projection keeps."""
        rel = _sub(p, self.C)
        return _sub(rel, _scale(self.view, _dot(rel, self.view)))

    def orbit(self, axis, angle):
        """What the trackball does: turn the camera about its own target."""
        t = self.target
        turned = Camera.__new__(Camera)
        turned.C = _add(t, _rotate(_sub(self.C, t), axis, angle))
        turned.right = _rotate(self.right, axis, angle)
        turned.up = _rotate(self.up, axis, angle)
        turned.view = _rotate(self.view, axis, angle)
        turned.L = self.L
        return turned

    def pan(self, d):
        moved = Camera.__new__(Camera)
        moved.C = _add(self.C, d)
        moved.right, moved.up, moved.view, moved.L = (
            self.right, self.up, self.view, self.L)
        return moved


def _correction(cam, pivot, pixel):
    """viewer.js `orbitChange`, in Python. Kept identical on purpose."""
    return _sub(cam.perp(pivot), cam.ndc_offset(*pixel))


def _grab(cam, pixel, depth):
    """viewer.js `orbitDown`: the picked point snapped onto the cursor ray."""
    return _add(_add(cam.C, cam.ndc_offset(*pixel)), _scale(cam.view, depth))


def _camera():
    return Camera([120.0, -160.0, 90.0], [0.8, 0.6, 0.0], [-0.3, 0.4, 0.866])


# -- what the correction is for ----------------------------------------------
def test_nothing_moves_until_the_model_does():
    """The first frame of every gesture corrects by exactly zero.

    Not a tolerance and not a small number: the pivot is taken ON the ray under
    the cursor, so before anything has turned the two terms of the correction
    are the same vector. Any residue here would be a twitch at the start of
    every drag, which is precisely what a reader notices.
    """
    cam = _camera()
    pixel = (354.0, 217.0)
    pivot = _grab(cam, pixel, 280.0)
    d = _correction(cam, pivot, pixel)
    assert max(abs(v) for v in d) < 1e-12
    # And the pixel it was grabbed at is where it draws.
    assert math.dist(cam.project(pivot), pixel) < 1e-9


def test_the_grabbed_point_comes_back_to_its_pixel_after_the_rotation():
    """The measurement in the docstring, done in arithmetic instead of Chrome.

    Same shape as the browser run: a point well off centre, a rotation of a
    realistic size, and the drift with and without the correction.
    """
    cam = _camera()
    pixel = (354.0, 217.0)
    pivot = _grab(cam, pixel, 280.0)
    turned = cam.orbit([0.2, -0.4, 1.0], math.radians(35))

    # Where the trackball alone leaves it: this is the number the branch exists
    # to remove, and it is not a subtle one.
    drifted = turned.project(pivot)
    assert math.dist(drifted, pixel) > 100

    d = _correction(turned, pivot, pixel)
    fixed = turned.pan(d).project(pivot)
    assert math.dist(fixed, pixel) < 1e-9

    # The same subtraction, component by component, as viewer.js writes it. The
    # replication above is what says this formula is the right one; this is what
    # says the file still contains that formula and not one with a sign in it
    # that a browser would show as the model sliding the wrong way.
    body = _code("orbitChange")
    for i in range(3):
        assert f"rel[{i}] - along * b.view[{i}] - off[{i}]" in body, i
    assert "const rel = [a.pivot[0] - b.C[0]" in body
    assert "const off = ndcOffset(g, b.eye, b.view, a.ndc[0], a.ndc[1]);" in body


def test_the_correction_holds_for_any_rotation_and_any_pixel():
    """No lucky axis, no lucky corner of the canvas."""
    cam = _camera()
    for px, py in ((10.0, 10.0), (1250.0, 700.0), (633.0, 361.0), (900.0, 120.0)):
        pivot = _grab(cam, (px, py), 420.0)
        for axis in ([1, 0, 0], [0, 1, 0], [0, 0, 1], [0.3, -0.9, 0.4]):
            for deg in (-120, -17, 0.5, 60, 179):
                turned = cam.orbit(axis, math.radians(deg))
                d = _correction(turned, pivot, (px, py))
                back = turned.pan(d).project(pivot)
                assert math.dist(back, (px, py)) < 1e-9, (px, py, axis, deg)


def test_the_correction_is_a_pan_and_leaves_the_rotation_alone():
    """Camera AND target by the same vector, which is the whole trick.

    The view direction is untouched, the distance along it is untouched, and the
    trackball keeps no state in either — which is why this can ride on top of
    the controls instead of fighting them. The same sentence is true of the
    cursor zoom and the swipe pan, and it is why all three can share a camera.
    """
    cam = _camera()
    pixel = (354.0, 217.0)
    pivot = _grab(cam, pixel, 280.0)
    turned = cam.orbit([0.2, -0.4, 1.0], math.radians(35))
    moved = turned.pan(_correction(turned, pivot, pixel))

    assert math.dist(moved.view, turned.view) < 1e-12
    assert abs(math.dist(moved.C, moved.target)
               - math.dist(turned.C, turned.target)) < 1e-12
    # The camera moved sideways only: nothing along the axis of view, which an
    # ortho projection would throw away anyway and which would move the target
    # off the far side of the model for no reason.
    assert abs(_dot(_sub(moved.C, turned.C), turned.view)) < 1e-9


def test_the_pivot_is_snapped_onto_the_ray_and_that_is_not_cosmetic():
    """Why `orbitDown` does not simply keep the point the picker returned.

    The picker reads a pixel of a render target, so its point is up to half a
    pixel off the ray through the cursor. Kept raw, that half pixel is a
    correction applied on the FIRST frame of every gesture — the model jumping
    before it has turned. Snapped, the first correction is identically zero and
    the point is the same point to within the pixel it was read from.
    """
    cam = _camera()
    pixel = (354.0, 217.0)
    snapped = _grab(cam, pixel, 280.0)
    # The same point as the picker would have handed over: half a pixel to the
    # side, at the same depth.
    raw = _add(snapped, _scale(cam.right, 0.5 / Camera.S))
    assert math.dist(cam.project(raw), pixel) == 0.5

    assert max(abs(v) for v in _correction(cam, snapped, pixel)) < 1e-12
    assert max(abs(v) for v in _correction(cam, raw, pixel)) > 1e-3

    # And the pivot viewer.js stores is that snapped one: the camera, plus the
    # offset of the ray under the cursor, plus the picked depth along the view
    # axis. The picked point contributes its DEPTH and nothing else.
    body = _code("orbitDown")
    for i in range(3):
        assert f"b.C[{i}] + off[{i}] + along * b.view[{i}]" in body, i
    assert "const along = dot3(rel, b.view);" in body


# -- the shape of the code around it -----------------------------------------
def test_the_state_numbers_are_the_vendored_trackball_s_own():
    """`orbitDown` asks the controls whether this press rotates.

    It cannot ask in words — the state is a number — so the two numbers are
    named constants here and checked against the bundle they came from. If an
    upgrade renumbers them this test fails instead of the page quietly
    anchoring a pan.
    """
    state = re.search(
        r"const STATE(?:\$\d+)? = \{\s*NONE: (-?\d+),\s*ROTATE: (-?\d+),"
        r"\s*ZOOM: (-?\d+),\s*PAN: (-?\d+),?\s*\};",
        BUNDLE.read_text(encoding="utf-8"))
    assert state, "the trackball's STATE block is not where it was"
    source = _source()
    assert f"const TRACKBALL_NONE = {state.group(1)};" in source
    assert f"const TRACKBALL_ROTATE = {state.group(2)};" in source
    # And it is the trackball's verdict that is read, not a second copy of its
    # rule: which button and which modifier mean "pan" is the library's to
    # decide, and KeyMapper permutes the modifiers under it.
    body = _function("orbitDown")
    assert "tb.state !== TRACKBALL_ROTATE" in body
    assert "tb.keyState !== TRACKBALL_NONE" in body
    assert "ctrlKey" not in body and "shiftKey" not in body


def test_the_pivot_is_taken_once_at_the_press():
    """Re-picking mid-gesture is the bug this is written against.

    A pivot read every frame is whatever the rotation has just brought under the
    cursor, and the model slides out from under the finger. The picker is called
    in `orbitDown` and nowhere else in the feature.
    """
    assert "pickAt(" in _function("orbitDown")
    for name in ("orbitChange", "orbitEnd", "orbitRelease", "setupOrbit"):
        assert "pickAt" not in _function(name), f"{name} re-picks the pivot"
    # And what the correction reads every frame is the anchor taken back then.
    assert "a.pivot" in _function("orbitChange")


def test_the_cursor_over_the_background_gets_no_invented_point():
    """No hit is not a failure; it is the page's old behaviour, on purpose.

    A press on the background rotates about `target`, which is what this viewer
    has always done. Anything else would be a pivot conjured out of the grid
    size or the bounding box, i.e. a rule the reader cannot see.
    """
    body = _function("orbitDown")
    assert "if (!point) return;" in body
    assert body.index("if (!point) return;") < body.index("orbitAnchor = {")
    # Nothing else in the feature reaches for a fallback point either.
    for name in ("orbitChange", "orbitEnd"):
        assert "bbox" not in _function(name) and "gridSize" not in _function(name)


def test_the_library_is_reached_through_the_one_guarded_door():
    """`sectionInternals()` (via `wheelInternals`) stays the way in.

    The controls object rides along on it unguarded, exactly like `clipping`, so
    a viewer upgrade that moves the controls costs this page its pivot and
    leaves the section tool alone. Everything the pivot then calls on that
    object is checked in `orbitTrackball`.
    """
    assert "wheelInternals(e)" in _function("orbitDown")
    assert "sectionInternals()" in _function("orbitChange")
    for name in ("orbitDown", "orbitChange", "orbitEnd", "orbitRelease"):
        body = _function(name)
        for internal in ("viewer.idPicker", "viewer.camera", "viewer.renderer",
                         "viewer.controls", "getCamera("):
            assert internal not in body, f"{name} reaches past the door for {internal}"
    guard = _function("orbitTrackball")
    for method in ("addEventListener", "removeEventListener", "update"):
        assert f'typeof tb.{method} !== "function"' in guard, method
    assert "controls" in _function("sectionInternals")


def test_the_listener_is_hooked_per_gesture_and_let_go_on_the_release():
    """`render()` builds a NEW controls object on every variant switch and every
    live reload, and this page calls it often.

    A listener added once at startup would be parked on the old one and the
    pivot would silently stop working after the first reload — measured in the
    browser by switching variant and re-running the drag: 0.70 px, i.e. still
    the pixel the picker read. Between gestures nothing of this feature is
    hooked into the library at all.
    """
    assert 'tb.addEventListener("change", orbitChange);' in _function("orbitDown")
    assert 'removeEventListener("change", orbitChange);' in _function("orbitRelease")
    setup = _function("setupOrbit")
    assert "change" not in setup, "the change listener moved back to startup"
    assert 'box.addEventListener("pointerdown", orbitDown);' in setup
    # A press that finds the last gesture still hooked up starts clean rather
    # than stacking a second listener: a pointerup can go astray.
    assert "orbitRelease();" in _function("orbitDown")
    # And the scene can be rebuilt mid-drag, in which case the pivot was
    # measured against a camera that no longer exists.
    assert "orbitTrackball(g) !== a.tb" in _function("orbitChange")


def test_an_anchor_that_outlived_its_gesture_costs_nothing():
    """A release can go missing: Cmd+Tab in the middle of a drag is enough.

    The listener would then still be hooked up, and the reader's next wheel — a
    zoom, which also moves the camera and also dispatches "change" — would be
    answered by holding a point they grabbed minutes ago. Asking the controls
    whether they are still rotating costs one comparison and makes a lost
    release harmless.
    """
    assert "a.tb.state !== TRACKBALL_ROTATE" in _code("orbitChange")


def test_our_own_camera_move_cannot_re_enter_the_correction():
    """Moving the camera makes the trackball dispatch "change" again.

    Without the flag that is unbounded recursion from inside the library's own
    update, which is a frozen tab rather than a wrong pixel.
    """
    body = _function("orbitChange")
    assert "if (!a || orbitBusy) return;" in body
    assert "orbitBusy = true;" in body
    assert "finally {" in body and "orbitBusy = false;" in body
    assert body.index("orbitBusy = true;") < body.index("setCameraLocationSettings")


def test_camera_and_target_move_together_through_the_shared_call():
    """The same call, with the same two arguments left null, as the cursor zoom
    and the swipe pan.

    One description of how this camera moves sideways. A separate one here would
    be a second chance to get the sign or the target wrong, and only one of the
    two would be fixed when somebody noticed.
    """
    body = _function("orbitChange")
    assert "ndcOffset(" in body and "cameraBasis(" in body
    call = body[body.index("setCameraLocationSettings"):]
    for i in range(3):
        assert f"b.C[{i}] + d[{i}]" in call
        assert f"b.target[{i}] + d[{i}]" in call
    assert call.count("null") == 2, "the quaternion or the zoom is being written"


def test_the_press_is_never_taken_away_from_the_controls():
    """The rotation stays entirely the library's.

    This feature adds a pan after the fact and nothing else: it does not
    swallow the press, does not preventDefault it and does not re-implement a
    trackball. The section tool is the one that takes presses, in the capture
    phase, and it must keep them — hence the bubble phase here, which is also
    what lets the state above be read at all.
    """
    for name in ("orbitDown", "orbitChange", "orbitEnd", "setupOrbit"):
        body = _code(name)
        assert "preventDefault" not in body, f"{name} eats the press"
        assert "stopPropagation" not in body, f"{name} eats the press"
    source = _source()
    assert 'box.addEventListener("pointerdown", sectionDown, true);' in source
    assert 'box.addEventListener("pointerdown", orbitDown);' in source


def test_the_release_flushes_the_last_rotation_before_it_unhooks():
    """With holroyd on, the trackball rotates inside the pointermove handler and
    there is never anything pending; the plain trackball rotates in the
    animation loop instead.

    A release that lands between the last move and the next frame would then
    leave one rotation with no correction after it — the grabbed point jumping
    off the cursor at the very end of the gesture, which is the one moment the
    reader is watching it.
    """
    body = _function("orbitEnd")
    assert "a.tb.update();" in body
    assert body.index("a.tb.update();") < body.index("orbitRelease();")
    # The release itself is reachable from anywhere the gesture can end.
    down = _function("orbitDown")
    assert 'addEventListener("pointerup", orbitEnd, true);' in down
    assert 'addEventListener("pointercancel", orbitEnd, true);' in down


def test_the_feature_is_wired_into_the_page():
    """A setup function nobody calls is a feature nobody gets."""
    source = _source()
    assert "  setupOrbit();\n" in source
    # After setupWheel, so the two camera-moving features are set up together
    # and in the order they read in the file.
    assert source.index("setupWheel();\n  setupOrbit();") > 0
