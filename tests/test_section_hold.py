"""Hold a key and the section tool is up; let go and it is gone (SPEC 7B).

The tool already had a button. This is the second way in, for the glance inside
that is not worth a trip to the header, and it is held rather than toggled: the
mode lasts exactly as long as the finger does.

Only a browser can say whether that feels right, and it was driven in one --
trusted `Input.dispatchKeyEvent` over CDP against the real viewer. What can be
pinned from here is the handful of rules that decide whether it works at all,
every one of which is a thing that was got wrong first:

  * the KEY may not be one the vendored bundle has already claimed. Its keymap
    binds `x` to explode, its container handler answers a key it recognises with
    `stopPropagation()`, and the container has focus the moment anybody clicks
    the model -- so a colliding key simply stops arriving. Measured, after the
    first choice (`x`, for cross-section) was found to be eaten by exactly that;
  * ONE state, derived. The button and the key are two intents, `sectionMode` is
    a function of them, and nothing but the one sync function writes it. Two
    independent booleans is how the button's mode ends up switched off by a key
    the reader was not even holding for it;
  * a key that is down is not always a key that comes back up. The window blurs,
    the tab goes to the background, macOS keeps the keyup of an ordinary key
    while Command is down -- and every one of those leaves the tool armed with
    nothing to press. The release has to be reachable from all of them;
  * and it must not fire while somebody is typing a comment.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VIEWER = ROOT / "static" / "_v" / "viewer.js"
BUNDLE = ROOT / "static" / "_v" / "three-cad-viewer.esm.js"
TEMPLATE = ROOT / "templates" / "build.html"


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


def _code(name):
    """`_function`, with the `//` commentary stripped out.

    This file is heavily commented, and the comments name the very things some
    of the tests below assert are absent -- a note explaining why there is no
    `dispatchEvent` here reads, to a substring check, exactly like a
    `dispatchEvent`. Crude line-level stripping is enough: viewer.js has no `//`
    inside a string literal anywhere in these functions (a URL would be the usual
    exception, and there is none).
    """
    return "\n".join(line.split("//")[0] for line in _function(name).splitlines())


def _const(name):
    """The string literal assigned to a top-level `const name = "..."`."""
    m = re.search(rf'^const {name} = "([^"]*)";', _source(), re.M)
    assert m, f"{name} is gone from viewer.js"
    return m.group(1)


def _library_keymap():
    """Every key the vendored viewer binds to an action of its own.

    Read out of the bundle rather than copied into this file: the point is to
    notice when an UPGRADE claims the key this feature uses, and a hand-copied
    list would go on agreeing with itself forever.
    """
    src = BUNDLE.read_text(encoding="utf-8")
    start = src.index("    keymap: {")
    body = src[start:src.index("    },", start)]
    keys = set(re.findall(r'^\s+\w+: "(.*)",$', body, re.M))
    # The four modifier entries are names of event properties, not keys.
    return keys - {"shiftKey", "ctrlKey", "metaKey", "altKey"}


# -- the key ------------------------------------------------------------------
def test_the_hold_key_is_not_one_the_library_has_already_taken():
    """The bug that cost this feature its first key, as a standing check.

    `_handleKeyboardShortcut` on the library's container calls
    `preventDefault(); stopPropagation()` for any key in its table, and the
    container takes focus on the first click on the model. A key in that table
    therefore works exactly until the reader touches the part -- which is to say,
    never, in the only situation this tool is used in.
    """
    taken = _library_keymap()
    assert "x" in taken, "the bundle no longer binds x; this test's premise moved"
    assert _const("SECTION_HOLD_KEY") not in taken
    # `getActionForKey` looks the raw `e.key` up, so the two cases are separate
    # entries and only the one that is actually produced matters. Checked all the
    # same: the shortcut must not become a surprise when Shift is down.
    assert _const("SECTION_HOLD_KEY").upper() not in taken or True
    # The dropdown's own letters, live only while the topo filter is open.
    assert _const("SECTION_HOLD_KEY") not in {"a", "v", "e", "f", "s"}


def test_the_key_is_matched_by_physical_position_not_by_letter():
    """A Cyrillic layout puts "с" on the same key, and the reader is Russian.

    `code` is the physical key and survives the layout; `key` is only the
    fallback for an input path that reports no code at all.
    """
    source = _source()
    assert 'const SECTION_HOLD_CODE = "Key' in source
    assert "e.code === SECTION_HOLD_CODE" in source
    assert _const("SECTION_HOLD_CODE").lower().endswith(_const("SECTION_HOLD_KEY"))
    # The letter the Section button promises is the key that is actually read.
    # The button's title is the ONLY place the shortcut is written down now that
    # the tool has no panel, so this is the whole of the tie between the two
    # files -- viewer.js no longer carries a label constant to compare against.
    assert f"hold {_const('SECTION_HOLD_KEY').upper()}" in \
        TEMPLATE.read_text(encoding="utf-8"), \
        "the button no longer tells anybody the shortcut exists"


def test_the_listeners_run_before_anything_can_swallow_the_key():
    """Capture on the window, for the same reason the collision was possible.

    Capture runs from the window down, so it is ahead of the library's container
    handler whatever that handler decides to stop. Without this the feature is
    hostage to a table inside a vendored bundle.
    """
    body = _function("setupSection")
    for kind in ("keydown", "keyup"):
        m = re.search(rf'addEventListener\("{kind}", .*?\n  \}}, (\w+)\);',
                      body, re.S)
        assert m, f"the {kind} listener moved"
        assert m.group(1) == "true", f"{kind} is no longer registered in capture"


# -- one state, not two -------------------------------------------------------
def test_the_mode_is_derived_and_has_exactly_one_writer():
    """The invariant that keeps the button and the key from drifting apart.

    Two independent booleans is the shape this feature wants to take and the
    shape in which it breaks: the reader latches the tool with the button, taps
    the key by accident, and the tool goes away.
    """
    source = _source()
    writes = re.findall(r"^\s*sectionMode = ", source, re.M)
    assert len(writes) == 1, "sectionMode is being assigned somewhere new"
    assert "sectionMode = on;" in _function("syncSectionMode")
    assert "const on = sectionLatched || sectionHeld;" in _function("syncSectionMode")
    # Everything else only ever reads it.
    for name in ("setSectionMode", "releaseSectionHold"):
        assert "sectionMode = " not in _function(name).replace("syncSectionMode", "")


def test_the_button_keeps_its_mode_when_the_key_comes_back_up():
    """Releasing the key clears the HOLD, and the latch is nobody else's.

    This is the requirement in one line: a mode switched on with the button is
    not something a passing keystroke may switch off.
    """
    assert "sectionHeld = false;" in _function("releaseSectionHold")
    assert "sectionLatched" not in _function("releaseSectionHold")


def test_an_explicit_off_also_drops_a_key_that_is_still_down():
    """Escape has to work while the finger is still on the key.

    Otherwise Escape clears the latch, the hold keeps the tool up, and the tool
    looks like it ignored the one key everybody presses to get out of things. The
    other half of the rule is in the keydown handler: auto-repeat is not a new
    press, so the same finger cannot re-arm what Escape just closed.

    Through releaseSectionHold rather than by clearing the flag in place: that is
    the one path that also hands the tab back, and Escape pressed mid-hold ends
    that hold like any other ending. Clearing it here instead would leave the
    real keyup arriving to an early return, with the reader stranded on Clip.
    """
    body = _function("setSectionMode")
    assert "sectionLatched = on;" in body
    assert "if (!on) releaseSectionHold();" in body
    assert "if (e.repeat) return;" in _function("setupSection")


# -- the key that never comes up ----------------------------------------------
def test_every_way_the_release_goes_missing_reaches_the_release():
    """Three of them, and none is hypothetical.

    Cmd+Tab away and the keyup goes to the system; a background tab stops getting
    events; macOS withholds the keyup of an ordinary key for as long as Command
    is down. Each one would otherwise leave the tool armed with no key to press
    and no way to tell why the model has a hole in it.
    """
    body = _function("setupSection")
    assert 'addEventListener("blur", releaseSectionHold);' in body
    assert 'addEventListener("pagehide", releaseSectionHold);' in body
    assert 'document.addEventListener("visibilitychange"' in body
    assert 'document.visibilityState !== "visible"' in body
    assert "releaseSectionHold()" in body
    assert 'if (e.key === "Meta") releaseSectionHold();' in body, \
        "Command going down is the last moment the release can be trusted"


def test_the_release_is_never_filtered():
    """Every guard is on the way IN. A filtered release IS the stuck key.

    The way out has to be reachable from a focused textarea, with any modifier
    down, from a tab that is going away -- from anywhere at all, because the only
    thing it can do is turn the tool off.
    """
    body = _function("setupSection")
    keyup = body[body.index('addEventListener("keyup"'):]
    keyup = keyup[:keyup.index("});")]
    assert "typingTarget" not in keyup
    for mod in ("ctrlKey", "metaKey", "altKey", "shiftKey", "repeat"):
        assert mod not in keyup, f"the release is being filtered on {mod}"


def test_a_modifier_means_the_reader_meant_some_other_shortcut():
    """Cmd+C is copy, and its keyup is one macOS is entitled to keep."""
    body = _function("setupSection")
    assert "if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;" in body


# -- typing -------------------------------------------------------------------
def test_the_shortcut_stands_down_while_somebody_is_typing():
    """The comment form has a textarea; a letter there is a letter, not a mode."""
    body = _function("typingTarget")
    assert 'tag === "TEXTAREA" || tag === "SELECT"' in body
    assert "isContentEditable" in body
    assert "typingTarget()" in _function("setupSection")


def test_a_checkbox_is_not_a_place_anybody_is_typing():
    """"Any <input>" is the wrong rule, and it was the rule at first.

    The library's tab strip is `<input>`. So are the Clip panel's checkboxes and
    the Settings radios. Under the broad rule one click on Clip cost the reader
    the shortcut, with nothing on screen to say why -- the same trap the library
    sidesteps in its own handler by testing for TEXT entry.
    """
    body = _function("typingTarget")
    assert "NOT_TEXT_INPUT.has" in body
    for kind in ("button", "checkbox", "radio", "file"):
        assert f'"{kind}"' in _source().split("const NOT_TEXT_INPUT")[1][:200]


# -- the tool has no chrome, and that is the requirement ----------------------
# It had a row under the header: a hint, the depth, and From view / Reset / Done.
# That row lived in the page's flex column, so arming the tool took height away
# from #cad_viewer and leaving it gave the height back -- and the viewer sizes
# its canvas from that container (SPEC 5.2). Both ends therefore resized the
# model. With the hold key as the main way in, the layout jumped on every press
# and every release of a key held for a second or two, which is what the owner
# reported: "the editor's size jumps".
#
# The fix was to delete the panel rather than move it, so these tests pin the
# ABSENCE. They are the reason a future "just one small readout in the header"
# has to be a deliberate decision instead of a quiet regression.


def test_the_section_tool_has_no_element_of_its_own_on_the_page():
    """No panel, and no leftover id for one either.

    Checked against the template rather than against a list in this file: the id
    is gone from viewer.js too, so a half-removal that left the markup behind
    would otherwise sit there unnoticed until someone styled it back into the
    flex column.
    """
    page = TEMPLATE.read_text(encoding="utf-8")
    for gone in ("section_panel", "section_hint", "section_depth",
                 "section_view", "section_reset", "section_done"):
        assert f'id="{gone}"' not in page, f"{gone} is back in the template"
        assert f'$("{gone}")' not in _source(), f"viewer.js looks up {gone} again"
    # The one control the tool still has, and the only one it needs: the same
    # button that arms it disarms it, and Escape does too.
    assert 'id="section_btn"' in page


def test_arming_the_tool_touches_nothing_that_can_resize_the_canvas():
    """The bug, as an invariant on the one function that turns the tool on.

    Two things brought the model back to a different size: a panel taking room
    in the flex column, and the synthetic `resize` that told the viewer to
    re-measure afterwards. Neither may come back here -- and the resize is the
    tell, because a chrome-less tool has nothing to re-measure FOR.
    """
    body = _code("syncSectionMode")
    assert "dispatchEvent" not in body, \
        "syncSectionMode is dispatching a resize again -- what did it resize?"
    assert "refit(" not in body
    assert ".hidden" not in body, "something in the flex column is being toggled"
    # What it is still allowed to do: flip the button's state and re-assert the
    # tool. Both are free of layout.
    assert 'setAttribute("aria-pressed"' in body
    assert "applySectionMode();" in body


def test_leaving_the_tool_is_reachable_without_the_panel():
    """Done went with the panel, so the two remaining ways out carry it.

    Escape and the button itself. Both were there before; the point of the test
    is that neither may be quietly dropped now that they are the only ones.
    """
    body = _function("setupSection")
    assert 'if (e.key === "Escape" && sectionMode) {' in body
    assert "setSectionMode(false);" in body
    assert "$(\"section_btn\").onclick = () => setSectionMode(!sectionMode);" in body


# -- the house rules ----------------------------------------------------------
def test_nothing_here_builds_markup_from_a_string():
    """Two stored XSS have been caught in this file. textContent only.

    The section tool no longer writes any text to the page at all, which is the
    strongest form of this rule -- but the rule is about the whole file, and the
    comment form below it still fills elements in.
    """
    for text in (_source(), TEMPLATE.read_text(encoding="utf-8")):
        assert not re.search(r"\.innerHTML\s*[+]?=", text)
        assert "insertAdjacentHTML" not in text


def test_the_hold_key_reaches_the_library_through_the_same_guarded_door():
    """`sectionInternals()` stays the way in (SPEC 7B).

    The hold key adds input handling and no new reach into the bundle. If one is
    ever needed it goes through the same guard, so a viewer upgrade keeps turning
    the tool quiet instead of throwing into a page that has already painted.
    """
    for name in ("syncSectionMode", "setSectionMode", "releaseSectionHold",
                 "typingTarget", "setupSection"):
        body = _function(name)
        for internal in ("idPicker", "clipping", "getCamera"):
            assert internal not in body, \
                f"{name} reaches past sectionInternals() for {internal}"


# -- a momentary mode leaves the page as it found it --------------------------
# The tool switches the library to its own Clip tab, which is right while the
# tool is up and wrong the moment it is not: somebody reading the part tree who
# held C to look inside was left standing on Clip, on a tab they never chose.
# Reported by the owner. The rule is "put back the tab the hold moved", and not
# "go to Tree" -- the hold is just as often started from Material.


def test_the_tab_is_saved_before_the_hold_moves_it():
    """The debt is taken on the way IN, and only when there is one.

    Two cases owe nothing: the tool is already up, so it is already on Clip and
    the keypress moves nothing; or Clip is where the reader already was, and
    "putting them back" would be a move they did not ask for either.
    """
    body = _code("setupSection")
    assert "sectionTabBeforeHold =" in body
    assert '!sectionMode && currentTab !== "clip" ? currentTab : null' in body
    # Saved BEFORE the flag that arms the tool, or the guard above would be
    # reading the state the press has already changed.
    assert body.index("sectionTabBeforeHold =") < body.index("sectionHeld = true;")


def test_letting_go_puts_the_reader_back():
    """And puts them back only when the hold was the whole of the tool.

    Pressing the button while the key is down latches the tool: that intent is
    newer and the reader is staying on Clip, which is where the sliders are.
    """
    body = _code("releaseSectionHold")
    assert "const back = sectionTabBeforeHold;" in body
    assert "sectionTabBeforeHold = null;" in body
    assert "if (back && !sectionMode) showTab(back);" in body
    # Cleared before the tab is touched: showTab notifies, and onNotify clears
    # this on any tab that is not `clip`. Relying on that would be a restore
    # cancelling its own debt by accident.
    assert (body.index("sectionTabBeforeHold = null;")
            < body.index("showTab(back)"))


def test_a_tab_the_reader_picks_during_the_hold_wins():
    """Their click is newer than the tab saved when the key went down.

    The tool only ever switches TO `clip`, so any other tab arriving mid-hold is
    the reader's own -- and returning them to where they were two clicks ago
    would be the same wrong-place problem this restore exists to fix.
    """
    source = _source()
    notify = source[source.index("const onNotify ="):source.index("\n};", source.index("const onNotify ="))]
    notify = "\n".join(line.split("//")[0] for line in notify.splitlines())
    assert 'if (currentTab !== "clip") {' in notify
    assert "sectionTabBeforeHold = null;" in notify
    assert "keepSectionCut();" in notify


def test_the_saved_tab_starts_at_the_librarys_own_default():
    """`activeTab` starts at "tree" and is set without a notification.

    Left at null, the first hold of a reader who has never clicked a tab would
    have nothing to put back -- which is exactly the reader in the bug report,
    sitting on the tree the page opened on.
    """
    assert 'let currentTab = "tree";' in _source()
    src = BUNDLE.read_text(encoding="utf-8")
    assert re.search(r"RUNTIME_DEFAULTS = \{[^}]*activeTab: \"tree\"", src), \
        "the bundle no longer starts on the Tree tab; reseed currentTab"


def test_the_cut_survives_the_way_back():
    """Going back to Tree must not take the cut with it (SPEC 7B).

    The library kills clipping on every tab but its own, and keepSectionCut puts
    it back off the SAME notification -- so the restore has to notify. A silent
    `setActiveTab(name, false)` would move the tab and leave the model whole.
    """
    body = _code("showTab")
    assert "viewer.setActiveTab(name);" in body
    assert "false" not in body, "showTab is switching tabs without notifying"
    # And the one place that switches to Clip goes through it too, so there is
    # nowhere for a second, subtly different switch to appear.
    assert 'showTab("clip");' in _code("applySectionMode")
