"""How fast a pinch zooms, and why that number is not a matter of taste.

`static/_v/viewer.js` intercepts the pinch instead of letting the trackball zoom
on it, and scales the zoom by the browser's own encoding of the gesture. The
measurement behind it, from Chrome 151 on macOS driven through CDP's
`Input.synthesizePinchGesture` (gestureSourceType "mouse", the touchpad-pinch
path a real trackpad goes down):

    gesture scale   events   sum of deltaY      -100 * ln(scale)
         2.00         11         -69.31             -69.31
         1.50         10         -40.55             -40.55
         1.25          6         -22.31             -22.31
         0.50         17         +69.31             +69.31

-- exact to five digits, and the same total however fast the gesture is run. So
the browser has already put `ln(scale)` in the deltas and the viewer only has to
read it back. That is what `PINCH_DELTA_PER_E_FOLD` is, and it is why there is no
feel to re-tune here: the model's zoom follows the gesture's own scale exactly.

A browser cannot be opened from pytest, so what is pinned here is the arithmetic
and the shape of the code around it. Measured in Chrome against this branch: one
scale-2.0 pinch moved the zoom x2.0003 (x1.0353 before, i.e. twenty gestures to
double the view), with the point under the cursor drifting 0.000 px.
"""

import math
import re

import pytest
from pathlib import Path

VIEWER = Path(__file__).resolve().parent.parent / "static" / "_v" / "viewer.js"


def approx(expected, rel=1e-9):
    """`pytest.approx` with a default tolerance, so the tests read as arithmetic."""
    return pytest.approx(expected, rel=rel)


def _source():
    return VIEWER.read_text(encoding="utf-8")


def _function(name):
    """The body of a top-level `function name(...)` in viewer.js."""
    source = _source()
    start = source.index(f"function {name}(")
    end = source.index("\n}\n", start)
    return source[start:end]


def _rate():
    """`PINCH_DELTA_PER_E_FOLD` as viewer.js declares it."""
    found = re.search(r"const PINCH_DELTA_PER_E_FOLD = (\d+(?:\.\d+)?);", _source())
    assert found, "the pinch zoom rate is gone from viewer.js"
    return float(found.group(1))


def _zoom_after(deltas, start=1.0):
    """The viewer's zoom rule, in Python. Kept identical on purpose."""
    zoom = start
    for delta in deltas:
        zoom *= math.exp(-delta / _rate())
    return zoom


# -- the number itself -------------------------------------------------------
def test_the_rate_is_the_browsers_own_encoding_of_the_gesture():
    """Not tuned by feel: it inverts a formula that was measured.

    Chrome emits `sum(deltaY) == -100 * ln(scale)` for a touchpad pinch, so a
    rate of 100 px per e-fold turns the deltas back into the scale the fingers
    asked for. Any other value is a deliberate departure from the gesture, and
    would have to say why.
    """
    assert _rate() == 100

    for scale in (2.0, 1.5, 1.25, 0.5, 4.0):
        emitted = -100 * math.log(scale)          # what the browser sends
        assert _zoom_after([emitted]) == approx(scale)


def test_a_comfortable_pinch_doubles_the_view():
    """The acceptance criterion, in the units it was stated in.

    A couple of centimetres of finger travel is a gesture scale of about 2, and
    that has to be about a doubling — not "faster than before".
    """
    whole_gesture = [-69.31]                      # measured, scale 2.0
    assert _zoom_after(whole_gesture) == approx(2.0, rel=1e-4)
    # And the old rate for contrast: the same gesture through the trackball's
    # wheel path, `deltaY * 0.00025 * zoomSpeed` with zoomSpeed 2.0. Measured in
    # the browser as x1.0353, which is 20 gestures to a doubling.
    old = math.exp(69.31 * 0.00025 * 2.0)
    assert old == approx(1.0353, rel=1e-3)
    assert math.log(2) / math.log(old) == approx(20.0, rel=1e-2)


# -- exponential, not linear -------------------------------------------------
def test_the_zoom_is_exponential_in_the_delta():
    """The same finger travel must mean the same RATIO, wherever the reader is.

    A linear rule reads differently at different zooms — it crawls close up and
    jumps far out — and it is also not invertible: the way back would not land
    where the way out started.
    """
    assert "Math.exp(-e.deltaY / PINCH_DELTA_PER_E_FOLD)" in _function("pinchWheel")

    # Ratio, not amount: the same gesture from a different starting zoom is the
    # same multiplication.
    gesture = [-6.2, -5.5, -4.1, -3.3]
    for start in (0.05, 1.0, 37.0):
        assert _zoom_after(gesture, start) / start == approx(_zoom_after(gesture))

    # It composes: a gesture chopped into more events is the same gesture. That
    # is what makes the speed of the fingers irrelevant, which is what the
    # measurement above found the browser already guarantees.
    assert _zoom_after([-69.31]) == approx(_zoom_after([-34.655] * 2))
    assert _zoom_after([-69.31]) == approx(_zoom_after([-6.931] * 10))

    # And it is reversible: pinch in, pinch back out, and the zoom is where it
    # started rather than somewhere near it.
    there_and_back = gesture + [-d for d in reversed(gesture)]
    assert _zoom_after(there_and_back) == approx(1.0)


def test_the_rate_is_spent_on_the_pinch_and_on_nothing_else():
    """The mouse wheel keeps the speed it has.

    Its deltas are ~100 px per notch, a hundredth of which is an e-fold PER
    NOTCH — nobody asked for that, and the wheel was never the complaint. So the
    constant may not appear outside `pinchWheel`, which only ever sees a pinch.
    """
    source = _source()
    assert source.count("PINCH_DELTA_PER_E_FOLD") == 3, \
        "the pinch rate is being used somewhere new"
    # One declaration, one mention in the comment above it, one use.
    assert "const PINCH_DELTA_PER_E_FOLD" in source
    assert _function("pinchWheel").count("PINCH_DELTA_PER_E_FOLD") == 1
    assert "PINCH_DELTA_PER_E_FOLD" not in _function("panWheel")
    assert "PINCH_DELTA_PER_E_FOLD" not in _function("zoomWheelBefore")
    assert "PINCH_DELTA_PER_E_FOLD" not in _function("zoomWheelAfter")


def test_the_comment_carries_the_measurement_and_what_would_invalidate_it():
    """A calibration constant without its derivation is a number nobody may touch.

    The next reader has to be able to see where 100 came from, redo the
    measurement, and know what change would move it.
    """
    source = _source()
    head = source[:source.index("const PINCH_DELTA_PER_E_FOLD")]
    comment = head[head.rindex("/**"):]
    assert "synthesizePinchGesture" in comment, "the measurement is not reproducible"
    assert "-69.31" in comment and "-40.55" in comment, "the measured numbers are gone"
    assert "zoomSpeed" in comment, "nothing says what would invalidate this"


# -- when the pinch is taken, and from whom ----------------------------------
def test_only_the_trackpad_setting_takes_the_pinch():
    """A reader on the mouse setting has told us they are on a mouse.

    They HAVE no pinch, so there is no gesture here to speed up; ctrl+wheel is
    whatever their browser makes of it — page zoom on Windows and Linux — and the
    page has to behave exactly as it did before this existed.
    """
    body = _function("pinchWheel")
    switch = body.index("if (!trackpad) return false;")
    ctrl = body.index("if (!e.ctrlKey) return false;")
    internals = body.index("wheelInternals(e)")
    assert switch < ctrl < internals, "the pinch is claimed before it is known to be one"
    # Nothing touches the camera before both of those have passed.
    assert "setCameraZoom" not in body[:ctrl]
    assert "zoomWheelBefore" not in body[:ctrl]


def test_the_pinch_and_the_swipe_can_never_both_claim_an_event():
    """One gesture, one answer.

    `panWheel` declines anything with `ctrlKey` and `pinchWheel` accepts nothing
    else, so the two partition the wheel between them and the order they are
    tried in cannot matter.
    """
    assert "if (e.ctrlKey) return false;" in _function("panWheel")
    assert "if (!e.ctrlKey) return false;" in _function("pinchWheel")
    assert "if (panWheel(e) || pinchWheel(e)) {" in _function("wheelCapture")


def test_a_spent_pinch_never_reaches_the_controls():
    """Or the trackball would zoom a second time, at its own speed, on top.

    Same two calls the swipe pan relies on, for the same reason, and the anchor
    is cleared because the bubble listener that would have spent it never runs.
    """
    body = _function("wheelCapture")
    assert "e.preventDefault();" in body
    assert "e.stopPropagation();" in body
    assert "zoomAnchor = null;" in body


# -- the cursor keeps its point ----------------------------------------------
def test_the_cursor_correction_is_the_wheels_own_one_reused():
    """Not a second copy of it.

    The zoom-to-cursor maths is delicate and already written; a pinch-flavoured
    duplicate would be a second chance to get the sign or the scaling wrong, and
    only one of the two would get fixed when somebody noticed. So `pinchWheel`
    calls the existing pair by name with its own zoom in between, and contains no
    camera maths of its own.
    """
    body = _function("pinchWheel")
    assert "zoomWheelBefore(e);" in body
    assert "zoomWheelAfter();" in body
    before = body.index("zoomWheelBefore(e);")
    zoom = body.index("viewer.setCameraZoom(")
    after = body.index("zoomWheelAfter();")
    assert before < zoom < after, "the anchor is not taken before the zoom it anchors"
    # No maths, no internals, no second way of moving the camera sideways.
    assert "setCameraLocationSettings" not in body
    assert "ndcOffset" not in body
    assert "unproject" not in body


def test_the_one_guarded_door_into_the_library():
    """Same door the section cut and the swipe pan use, and no other.

    A viewer upgrade that moves the internals has to break in ONE place, not in
    however many places reached past it.
    """
    body = _function("pinchWheel")
    assert "wheelInternals(e)" in body
    assert "viewer.idPicker" not in body
    assert "viewer.camera" not in body
    assert "viewer.renderer" not in body


# -- how it fails ------------------------------------------------------------
def test_a_failure_before_the_camera_moves_hands_the_gesture_back():
    """Slow is still better than dead.

    Nothing has moved yet at that point, so the cheapest honest answer is to let
    the controls have the event: the reader gets the zoom this page had before,
    which is exactly the degradation the rest of this file already chose.
    """
    body = _function("pinchWheel")
    head = body[:body.index("zoomWheelBefore(e);")]
    assert head.count("return false;") == 7, \
        "an early exit in the pinch no longer falls back to the library's zoom"
    assert 'console.warn("pinch zoom"' in head


def test_a_failure_after_the_camera_moves_keeps_the_gesture():
    """Past that line the controls must not get a second helping.

    Whatever the camera did, it was done here; handing the event on would add the
    trackball's own zoom to a zoom that has already happened.
    """
    body = _function("pinchWheel")
    tail = body[body.index("zoomWheelBefore(e);"):]
    assert "return false;" not in tail, "a half-applied pinch is being handed to the controls"
    assert "zoomAnchor = null;" in tail, "a stale anchor is left for the next gesture"
    assert tail.rstrip().endswith("return true;")
