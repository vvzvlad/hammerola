"""Two-finger swipe pans the model; the pinch is what zooms.

The feature lives in `static/_v/viewer.js` and only a browser can say whether it
feels right. What can be pinned from here is the rule it stands on, which is
short on purpose:

  * a swipe and a mouse-wheel notch are THE SAME EVENT as far as the browser is
    concerned, so nothing in the viewer tries to tell them apart. Every attempt
    at that is a guess at the shape of the deltas, tuned to whatever hardware the
    author owned, and this file exists partly to keep such a guess from being
    added back later;
  * on macOS a pinch arrives as `wheel` with a synthetic `ctrlKey` and a swipe
    as `wheel` without it, so there the pinch zooms and everything else pans;
  * everywhere else the wheel keeps zooming, because the page is public and most
    of the world opens it on an ordinary mouse;
  * which of the two rules is in force is not a switch of its own. It is the
    answer to ONE question — what is the reader pointing with — because a
    trackpad has a swipe and a pinch and no wheel while a mouse has a wheel and
    neither of the other two. The platform supplies the opening answer, the
    reader can say otherwise in Settings, and the answer is remembered: a Mac
    with a plain mouse must not be left with no zoom.
"""

import re
from pathlib import Path

from harness import good_build

VIEWER = Path(__file__).resolve().parent.parent / "static" / "_v" / "viewer.js"


def _source():
    return VIEWER.read_text(encoding="utf-8")


def _function(name):
    """The body of a top-level `function name(...)` in viewer.js.

    Crude on purpose: it runs to the next line that starts in column zero with a
    closing brace, which is what every function in that file ends with.
    """
    source = _source()
    start = source.index(f"function {name}(")
    end = source.index("\n}\n", start)
    return source[start:end]


def _wants_trackpad(saved, is_mac):
    """The viewer's default choice, in Python. Kept identical on purpose."""
    return saved == "trackpad" or (saved != "mouse" and is_mac)


# -- the rule, and the guess that must not come back -------------------------
def test_the_viewer_never_measures_a_wheel_delta_to_decide():
    """The whole point of the current design, as a regression test.

    Telling a trackpad swipe from a mouse wheel by the size, the units or the
    fractionality of the deltas is guesswork — the W3C issue on this says the two
    are "exactly the same mouse event" — and every published version of that
    guess is defeated by some real device, a free-spinning mouse wheel being the
    easy one. If `deltaMode` or a magnitude comparison ever shows up in here
    again, somebody has re-introduced a heuristic that cannot work, and the
    decision has quietly moved out of `panWheel` where it can be read.

    ONE `deltaMode` is allowed, and only inside `pinchWheel`, which divides
    `deltaY` by a constant counted in PIXELS and so has to know it was handed
    pixels. That is a unit check on a number about to be used, not a guess at
    which device sent it: it decides nothing about pan versus zoom, and a gesture
    it declines keeps the library's own zoom. Anywhere else — and in `panWheel`
    above all, where the pan/zoom decision actually lives — it is the heuristic
    coming back.
    """
    source = _source()
    outside_the_unit_check = source.replace(_function("pinchWheel"), "")
    assert "deltaMode" not in outside_the_unit_check, "a delta-shape heuristic is back"
    assert "wheelDelta" not in source, "a delta-shape heuristic is back"
    body = _function("panWheel")
    assert "Math.abs" not in body, "panWheel is sizing up the delta again"
    assert "Math.abs" not in _function("pinchWheel"), "pinchWheel is sizing up the delta"
    # The deltas are used to MOVE, and for nothing else: two references, both
    # feeding the screen displacement below.
    assert body.count("e.delta") == 2


def test_a_pinch_zooms_and_is_the_first_thing_panwheel_looks_at():
    """`ctrlKey` is the one signal here that is not a guess.

    macOS synthesises it on a two-finger pinch and on nothing else this code
    sees. It is also the only way to zoom at all once the wheel has stopped
    zooming, so it must be answered before any other consideration can go wrong.
    """
    body = _function("panWheel")
    device = body.index("if (!trackpad) return false;")
    pinch = body.index("if (e.ctrlKey) return false;")
    assert pinch > device, "the pinch check now runs even on the mouse setting"
    # Nothing between the switch and the pinch but the comment explaining it, and
    # nothing that touches the camera before either.
    assert "setCameraLocationSettings" not in body[:pinch]
    assert "wheelInternals" not in body[:pinch]


def test_a_failure_anywhere_in_the_pan_leaves_the_zoom_alone():
    """Every exit in `panWheel` is `return false`, which means "not handled".

    The caller then hands the event to the controls untouched, so a viewer
    upgrade that moves the internals costs the page its swipe pan and nothing
    else: the wheel goes back to zooming, which is what it did before.
    """
    body = _function("panWheel")
    assert "return true;" in body, "nothing in panWheel claims an event any more"
    assert "catch (err)" in body and "return false;" in body[body.index("catch (err)"):]
    # And the one door into the library's internals is the shared, guarded one.
    assert "wheelInternals(e)" in body
    assert "viewer.idPicker" not in body and "viewer.camera" not in body


# -- which rule is in force --------------------------------------------------
def test_the_platform_is_asked_both_ways_and_neither_is_load_bearing_alone():
    """`navigator.platform` is deprecated; `userAgentData` is Chromium-only.

    Safari and Firefox — a good share of the Macs this matters for — have no
    `userAgentData`, so the deprecated call cannot simply be dropped, and the
    modern one cannot be relied on. This is the line that will break on some
    future browser, and it has to break towards "not a Mac", i.e. towards the
    wheel zooming as it always did.
    """
    body = _function("isMacPlatform")
    assert "navigator.userAgentData" in body
    assert "navigator.platform" in body
    assert "return false;" in body[body.index("catch (e)"):], \
        "a navigator that throws no longer falls back to the wheel zoom"
    # And a navigator that answers with nothing at all: neither `undefined` nor a
    # non-string may reach the regex and come back truthy.
    assert 'typeof name === "string" && /mac/i.test(name)' in body


def test_the_default_follows_the_platform_and_a_choice_overrides_it():
    """A Mac on a plain mouse and a Windows laptop on a trackpad are both real.

    Neither is detectable, so the platform only supplies the default and a stored
    answer wins on either side.
    """
    assert _wants_trackpad(None, True) is True
    assert _wants_trackpad(None, False) is False
    # An explicit answer beats the platform in BOTH directions. The first of
    # these is the one that matters most: without it a Mac user on a mouse could
    # never get the zoom back.
    assert _wants_trackpad("mouse", True) is False
    assert _wants_trackpad("trackpad", False) is True
    # Anything else in storage is not an answer, so the platform decides.
    assert _wants_trackpad("", True) is True
    assert _wants_trackpad("yes", False) is False


def test_the_python_copy_of_that_choice_still_matches_the_viewer():
    """The assertions above are written against `_wants_trackpad`; pin it."""
    assert 'saved === "trackpad" || (saved !== "mouse" && isMacPlatform()), false)' \
        in _source()


def test_the_choice_is_remembered():
    source = _source()
    key = re.search(r'const INPUT_KEY = "([^"]+)";', source)
    assert key, "INPUT_KEY is gone from viewer.js"
    # Same namespace as the live-reload setting, so the two are recognisably one
    # page's settings rather than two unrelated keys in somebody's browser.
    assert key.group(1).startswith("hammerola.")
    # Named for what it holds. The key used to be `swipe_pan`, which described
    # one consequence of the answer rather than the answer, and a key that has
    # to be translated in the reader's head is a key that gets misread.
    assert "swipe" not in key.group(1) and "pan" not in key.group(1)
    assert "localStorage.setItem(INPUT_KEY" in source
    assert "localStorage.getItem(INPUT_KEY" in source
    # The two values it ever holds, spelled the way a person would read them out
    # of devtools. No migration from the old key and none wanted: the answer is
    # one click to give again, and a platform default stands in until it is.
    assert 'on ? "trackpad" : "mouse"' in source
    assert "swipe_pan" not in source, "the retired key is still being consulted"
    # Storage that throws (private mode, storage turned off) must cost the page
    # the memory of the setting and nothing more.
    assert source.count('console.warn("pointing device"') == 2


# -- how the event is taken away from the controls ---------------------------
def test_the_capture_listener_can_preventdefault():
    """A passive listener may not, and this one has to.

    On a consumed swipe nothing else is left to call it — the trackball's own
    wheel handler never sees the event — and without it a horizontal swipe is a
    back/forward navigation, i.e. the page leaves. The bubble half stays passive:
    it only ever reads.
    """
    source = _source()
    assert 'box.addEventListener("wheel", wheelCapture, ' \
           '{ capture: true, passive: false });' in source
    assert 'box.addEventListener("wheel", zoomWheelAfter, ' \
           '{ capture: false, passive: true });' in source


def test_a_consumed_swipe_is_kept_off_the_canvas_and_clears_the_zoom_anchor():
    """Both halves of "the controls must not see this".

    `stopPropagation` is what keeps the event off the canvas, where the trackball
    would zoom on it. It also stops the bubble phase, so `zoomWheelAfter` never
    runs — which is why the anchor it would have spent is cleared here instead of
    being left to go stale.
    """
    body = _function("wheelCapture")
    assert "e.preventDefault();" in body
    assert "e.stopPropagation();" in body
    assert "zoomAnchor = null;" in body
    # And the fall-through: anything not spent on a pan is handed to the zoom.
    assert "zoomWheelBefore(e);" in body


def test_the_pan_and_the_zoom_share_one_piece_of_maths():
    """One description of how this camera moves sideways, not two.

    Both gestures move camera and target by the same world vector, and both get
    that vector out of `ndcOffset`. A second copy of the projection maths would
    be a second chance to get the sign or the zoom scaling wrong, and only one of
    the two would get fixed when somebody noticed.
    """
    body = _function("panWheel")
    assert "ndcOffset(" in body
    assert "setCameraLocationSettings(" in body
    assert "ndcOffset(" in _function("zoomWheelBefore")


# -- the page side -----------------------------------------------------------
def test_the_build_page_ships_the_two_pointing_device_radios(hub):
    """Both are addressed by id from viewer.js and never checked for existence.

    Two radios and not one checkbox: an unticked box labelled "Trackpad" does not
    say what the page IS doing, and this setting has two named answers rather
    than a thing that is on or off.
    """
    hub.publish("proj1", "abc123", good_build())
    body = hub.get("/project/proj1/abc123/").text
    for element in ("pointer_trackpad", "pointer_mouse", "pointer_hint"):
        assert f'id="{element}"' in body, element
    # One group, so picking either un-picks the other without a line of script.
    assert body.count('name="pointer"') == 2


def test_the_setting_lives_in_the_settings_panel_and_not_in_the_header(hub):
    """It is set once per machine and then never thought about again.

    The header is for what somebody reaches for while looking at a model —
    variant, build, Comment, Section, Downloads. A control that is touched once
    and then only ever misread as a button costs header room every session to
    save a click in the first one.
    """
    hub.publish("proj1", "abc123", good_build())
    body = hub.get("/project/proj1/abc123/").text
    bar = body[body.index('<div id="bar">'):body.index('id="setbox"')]
    assert "pointer_trackpad" not in bar and "pointer_mouse" not in bar
    assert "swipe_btn" not in body, "the old header switch is still shipped"
    # And the panel it moved into is the same <details> dropdown Downloads uses,
    # so the toggle, the keyboard handling and the focus behaviour stay the
    # browser's rather than being written again.
    assert '<details id="setbox">' in body
    panel = body[body.index('<details id="setbox">'):]
    panel = panel[:panel.index("</details>")]
    assert "<summary" in panel
    assert 'id="pointer_trackpad"' in panel and 'id="pointer_mouse"' in panel


def test_the_two_header_dropdowns_are_one_at_a_time():
    """Downloads and Settings share an anchor, so they may not share the screen.

    Both panels are pinned to the right edge of `#bar` — anchored to their own
    button they would run off a narrow screen the moment the button wrapped onto
    a new line — and `<details>` has no notion of siblings, so two of them open at
    once is one panel drawn over the other. The close is hung on `toggle` rather
    than on a click so that every way a panel opens is covered.
    """
    body = _function("setupPanels")
    assert '$("dlbox")' in body and '$("setbox")' in body
    assert '"toggle"' in body
    assert "other.open = false;" in body


def test_the_viewer_cannot_paint_through_the_header():
    """The dropdowns are only opaque because `#cad_viewer` is a stacking context.

    `position:relative` with `z-index:auto` does not make one, so the glass
    tree's own z-index — in the hundreds, inside the vendored bundle — competed
    directly with `#bar`'s 10 and won: checked in the browser at 470px, the tree
    painted straight through the open panel and the settings were unreadable.
    `z-index:0` on the viewer keeps everything the bundle draws inside it, and
    the next upgrade cannot renumber its way back out.
    """
    css = (VIEWER.parent / "site.css").read_text(encoding="utf-8")
    rule = re.search(r"#cad_viewer\{([^}]*)\}", css)
    assert rule, "the #cad_viewer rule is gone"
    assert "z-index:0" in rule.group(1), "the viewer can paint over the header again"
    assert "position:relative" in rule.group(1)


def test_neither_radio_is_picked_in_the_markup(hub):
    """The markup must not show an answer the page has not worked out yet.

    viewer.js reads the platform and storage as it wires the panel up, and that
    runs after the model has loaded; until then `trackpad` is false. A radio
    showing "Trackpad" over a wheel that is still zooming is a setting nobody
    will trust again — so the markup shows neither, and the first thing
    `setPointingDevice` does is tick the right one.
    """
    hub.publish("proj1", "abc123", good_build())
    body = hub.get("/project/proj1/abc123/").text
    panel = body[body.index('<details id="setbox">'):]
    inputs = re.findall(r"<input[^>]*>", panel[:panel.index("</details>")])
    assert len(inputs) == 3, "the settings panel no longer has the controls it had"
    assert not any("checked" in tag for tag in inputs)
    assert "let trackpad = false;" in _source()
    assert '$("pointer_trackpad").checked = on;' in _function("setPointingDevice")
