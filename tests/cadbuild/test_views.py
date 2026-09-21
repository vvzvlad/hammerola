"""The view contract, checked before a single triangle is computed.

Everything in here is a rule about the source, so it costs milliseconds and
runs first. The alternative -- and this is what it used to be -- is finding out
after the tessellation, which is the slow half of a build.

A VIEW CARRIES NO GEOMETRY any more: it is a list of references into the
catalogue. So the tests that used to check a view's own `shape`, its own `name`
and its own `color` are gone rather than ported -- those are catalogue rules now
and live in test_naming.py. What is left here is what a view still decides: WHICH
parts, WHERE they stand, how see-through they are, and how they are grouped for
a reader.
"""

import json

import pytest

from src.cadbuild.errors import BuildError
from src.cadbuild.hubspec import MAX_VIEW_DEPTH, MAX_VIEW_NAME_CHARS
from src.cadbuild.palette import HARDWARE_COLOR, MOCK_COLOR, PART_PALETTE
from src.cadbuild.views import (interference_pairs, prepare_views,
                                shaped_document)

from fakes import Location, catalogue, part, turned


_UNSET = object()


def one_view(vid="assembled", parts=_UNSET, **extra):
    # A sentinel rather than `or`: a test that passes an EMPTY list means it.
    return dict({"id": vid,
                 "parts": ["body"] if parts is _UNSET else parts}, **extra)


def prepare(views, cat=None, **kinds):
    """prepare_views over a catalogue of printables named by the tests."""
    return prepare_views(views, cat if cat is not None
                         else catalogue(**(kinds or {"body": "printable"})))


def refusal(views, **kinds):
    with pytest.raises(BuildError) as exc:
        prepare(views, **kinds)
    return str(exc.value)


# --------------------------------------------------------------------------
# The view itself
# --------------------------------------------------------------------------

def test_a_minimal_view_prepares():
    prepared = prepare([one_view()])
    assert len(prepared) == 1
    view = prepared[0]
    assert view["id"] == "assembled"
    assert view["label"] == "assembled"
    assert view["file"] == "assembled.json"
    assert [node["key"] for node in view["nodes"]] == ["body"]
    assert view["tree"] == [0]


def test_views_must_return_a_non_empty_list():
    for bad in ([], (), None, {}):
        with pytest.raises(BuildError) as exc:
            prepare_views(bad, catalogue(body="printable"))
        assert "non-empty list" in str(exc.value)


def test_a_view_with_a_bad_id_is_refused():
    assert "bad id" in refusal([one_view(vid="with space")])


def test_two_views_may_not_share_an_id():
    assert "duplicate view id" in refusal([one_view(), one_view()])


def test_a_view_that_is_not_a_dict_is_refused():
    assert "not a dict" in refusal(["not a view"])


def test_a_view_named_meta_would_overwrite_the_hub_s_own_file():
    assert "which the hub owns" in refusal(
        [one_view(), one_view(vid="meta")])


def test_a_model_with_no_assembled_view_is_refused():
    """It is what the product is judged by and the only view the build counts
    parts from, so every model has one."""
    message = refusal([one_view(vid="print")])
    assert "no 'assembled' view" in message
    # The message shows the one line a single-part model needs.
    assert '"parts"' in message


def test_a_view_with_no_parts_is_refused():
    assert "has no parts" in refusal([one_view(parts=[])])


def test_a_view_name_the_hub_would_refuse_is_refused_here():
    """The caption of the view itself.

    export_views writes it into meta.json and the hub reads it back with
    `_plain_text(..., "view name")`, so a 201-character caption or a newline in
    one is a 422 answering a build that has already been computed. An angle
    bracket is NOT refused here, because the hub does not refuse it either --
    that rule is the part name's, and tests/test_notes.py holds the pair.
    """
    assert "non-printable" in refusal([one_view(name="assembled\nview")])
    assert "non-printable" in refusal([one_view(name="assembled‮")])
    assert str(MAX_VIEW_NAME_CHARS) in refusal(
        [one_view(name="x" * (MAX_VIEW_NAME_CHARS + 1))])
    # The last legal caption still prepares, and an angle bracket still does.
    assert prepare([one_view(name="x" * MAX_VIEW_NAME_CHARS)])[0]["label"] == \
        "x" * MAX_VIEW_NAME_CHARS
    assert prepare([one_view(name="lid <> body")])[0]["label"] == "lid <> body"


def test_an_unknown_view_key_is_said_out_loud(capsys):
    """A misspelt `nestedok` used to be an exemption that was not there."""
    prepare([one_view(nestedok=[("a", "b")])])
    printed = capsys.readouterr().out
    assert "'nestedok'" in printed
    assert "Known keys: id, interference_ok, name, nested_ok, parts" in printed


# --------------------------------------------------------------------------
# References into the catalogue
# --------------------------------------------------------------------------

def test_a_bare_string_is_a_reference():
    prepared = prepare([one_view(parts=["body"])])
    assert prepared[0]["nodes"][0]["key"] == "body"


def test_a_reference_with_no_part_is_refused():
    assert 'has no "part"' in refusal([one_view(parts=[{"alpha": 0.5}])])


def test_a_part_key_that_is_not_a_string_is_refused():
    assert "not a catalogue key" in refusal([one_view(parts=[{"part": 42}])])


def test_a_reference_to_something_not_in_the_catalogue_is_refused():
    """The whole point of the catalogue: a view cannot show what parts() does
    not hold, so there is no second copy of a part to disagree with the first."""
    message = refusal([one_view(parts=["body", "ghost"])])
    assert "'ghost'" in message
    assert "not in the catalogue" in message
    assert "'body'" in message


def test_an_entry_that_is_neither_a_key_nor_a_dict_is_refused():
    assert "not a catalogue key or a dict" in refusal([one_view(parts=[42])])


def test_the_same_part_may_be_referenced_several_times():
    """Five pins are five references. No quantity is written anywhere."""
    prepared = prepare([one_view(parts=["pin", "pin", "pin"])],
                       pin="printable")
    assert [node["key"] for node in prepared[0]["nodes"]] == ["pin"] * 3


def test_repeated_references_are_told_apart_in_messages():
    prepared = prepare([one_view(parts=["pin", "pin"])], pin="printable")
    assert [node["label"] for node in prepared[0]["nodes"]] == \
        ["'pin' #1", "'pin' #2"]


def test_a_single_reference_is_labelled_by_its_key_alone():
    prepared = prepare([one_view(parts=["body"])])
    assert prepared[0]["nodes"][0]["label"] == "'body'"


# --------------------------------------------------------------------------
# Where a part stands
# --------------------------------------------------------------------------

def test_at_must_be_a_location():
    message = refusal([one_view(parts=[{"part": "body", "at": (10, 0, 0)}])])
    assert "cq.Location" in message


def test_at_is_applied_once_here():
    """Everything downstream -- the gates, the plate, the tessellation -- reads
    one solid standing where the view says it stands."""
    prepared = prepare([one_view(parts=[{"part": "body", "at": Location(50, 0, 0)}])])
    box = prepared[0]["nodes"][0]["shape"].val().BoundingBox()
    assert box.xmin == 50.0


def test_the_catalogue_s_own_object_is_not_moved():
    """`Shape.moved` returns a copy; the catalogue is read by every view."""
    cat = catalogue(body="printable")
    original = cat["body"]["shape"].val().BoundingBox().xmin
    prepare([one_view(parts=[{"part": "body", "at": Location(50, 0, 0)}])], cat)
    assert cat["body"]["shape"].val().BoundingBox().xmin == original


def test_a_multi_body_object_keeps_every_body_when_it_is_placed():
    """An object built with `.add()` is several solids, and a placed copy has to
    be all of them -- rebuilt with `newObject`, not reduced to `val()`."""
    from fakes import Box, Shape, Workplane
    both = Workplane(Shape(Box(0, 0, 0, 10, 10, 10)),
                     Shape(Box(50, 0, 0, 60, 10, 10)))
    cat = catalogue(combo=("printable", both))
    prepared = prepare_views(
        [one_view(parts=[{"part": "combo", "at": Location(0, 0, 5)}])], cat)
    moved = prepared[0]["nodes"][0]["shape"].vals()
    assert [shape.BoundingBox().zmin for shape in moved] == [5.0, 5.0]


def test_a_rotation_is_carried_through_to_the_gate():
    """The print gate reads the matrix off the Location the view kept."""
    prepared = prepare([one_view(parts=[{"part": "body", "at": turned(90, "z")}])])
    assert prepared[0]["nodes"][0]["at"].rows[2] == (0.0, 0.0, 1.0)


# --------------------------------------------------------------------------
# The one hatch geometry gets in through
# --------------------------------------------------------------------------

def test_a_shape_in_a_view_without_a_reason_is_refused():
    message = refusal([one_view(parts=[{"part": "body", "shape": part()}])])
    assert '"deformed"' in message
    assert 'Placing a part is "at"' in message


def test_a_reason_without_a_shape_is_refused():
    assert "hands over no" in refusal(
        [one_view(parts=[{"part": "body", "deformed": "bent"}])])


def test_an_empty_reason_is_refused():
    for bad in ("", "   ", 42):
        assert "deformed" in refusal(
            [one_view(parts=[{"part": "body", "shape": part(),
                              "deformed": bad}])])


def test_a_declared_deformation_is_printed_and_kept(capsys):
    """The one place a view may hold geometry, so a reader of the log has to see
    every one of them without opening the model."""
    bent = part(x=5)
    prepared = prepare([one_view(parts=[{"part": "body", "shape": bent,
                                         "deformed": "  clamped round the pipe  "}])])
    node = prepared[0]["nodes"][0]
    assert node["deformed"] == "clamped round the pipe"
    assert node["shape"] is bent
    printed = capsys.readouterr().out
    assert "carries geometry of its own" in printed
    assert "clamped round the pipe" in printed
    # No `warning:` prefix -- it is legal and the author has explained it.
    assert "warning" not in printed


def test_a_deformed_reference_is_refused_on_the_plate():
    """The hatch is shut in `print`, and it is a REFUSAL because a file exists.

    `assembly.export_print_plate` builds `print.stl` out of what stands in this
    view while each part's own `<key>.stl` comes from the CATALOGUE, so a
    deformed reference here publishes a bed carrying a shape no downloadable
    part holds -- and nothing compares the two. It is also the way round the
    tilt gate, which reads `at` and therefore cannot see geometry handed over
    directly. And it means nothing here in the first place: the hatch is for a
    part that is a different shape IN PLACE, and a part's place on a bed is the
    bed.
    """
    message = refusal(
        [one_view(), one_view(vid="print", parts=[
            {"part": "body", "shape": part(x=5), "deformed": "clamped"}])])
    assert "carries geometry of its own" in message
    assert "the part on the plate is the part" in message
    assert "'body'" in message


def test_a_deformed_reference_is_still_allowed_in_the_assembled_view():
    """The refusal is the plate's, not the hatch's: `assembled` keeps it."""
    prepared = prepare([one_view(parts=[{"part": "body", "shape": part(x=5),
                                         "deformed": "clamped round the pipe"}])])
    assert prepared[0]["nodes"][0]["deformed"] == "clamped round the pipe"


# --------------------------------------------------------------------------
# Transparency
# --------------------------------------------------------------------------

def test_a_part_with_no_alpha_is_opaque():
    assert prepare([one_view()])[0]["nodes"][0]["alpha"] == 1.0


def test_an_alpha_that_is_not_a_number_is_refused():
    for bad in ("0.5", None, True):
        assert "not a number" in refusal(
            [one_view(parts=[{"part": "body", "alpha": bad}])])


def test_an_alpha_outside_the_range_is_refused():
    for bad in (-0.1, 1.5):
        assert "outside 0..1" in refusal(
            [one_view(parts=[{"part": "body", "alpha": bad}])])


def test_a_nearly_opaque_alpha_is_warned_about_and_still_builds(capsys):
    prepare([one_view(parts=[{"part": "body", "alpha": 0.9}])])
    assert "worst value available" in capsys.readouterr().out


def test_an_alpha_of_zero_is_warned_about(capsys):
    prepare([one_view(parts=[{"part": "body", "alpha": 0.0}])])
    assert "not drawn at all" in capsys.readouterr().out


def test_a_view_with_nothing_opaque_is_warned_about(capsys):
    prepare([one_view(parts=[{"part": "body", "alpha": 0.5}])])
    assert "no fully opaque part" in capsys.readouterr().out


def test_an_unknown_reference_key_is_said_out_loud(capsys):
    """A misspelt `alfa` leaves the part opaque and used to say nothing at all,
    which is the same failure as a misspelt `nestedok`: the author reads a green
    build as agreement."""
    prepare([one_view(parts=[{"part": "body", "alfa": 0.5, "notes": "typo"}])])
    printed = capsys.readouterr().out
    assert "'alfa'" in printed and "'notes'" in printed
    assert "Known keys: alpha, at, deformed, part, shape" in printed


# --------------------------------------------------------------------------
# Colour comes from the catalogue, not from the view
# --------------------------------------------------------------------------

def test_a_leaf_is_painted_by_what_the_catalogue_says_the_part_is():
    prepared = prepare([one_view(parts=["body", "screw", "wall"])],
                       catalogue(body="printable", screw="hardware",
                                 wall="mock"))
    colors = {node["key"]: node["color"] for node in prepared[0]["nodes"]}
    assert colors["body"] in PART_PALETTE
    assert colors["screw"] == HARDWARE_COLOR
    assert colors["wall"] == MOCK_COLOR


def test_one_part_is_the_same_colour_in_every_view():
    """The point of keying the palette by the catalogue key: a part followed
    from `assembled` to `print` has to be recognisable."""
    prepared = prepare([one_view(), one_view(vid="print")])
    assert prepared[0]["nodes"][0]["color"] == prepared[1]["nodes"][0]["color"]


# --------------------------------------------------------------------------
# Groups
# --------------------------------------------------------------------------

def test_a_group_holds_references_and_the_leaves_stay_flat():
    """Every gate reads the flat list; the tree is only for the reader."""
    prepared = prepare(
        [one_view(parts=[{"group": "housing", "parts": ["body", "lid"]},
                         "screw"])],
        catalogue(body="printable", lid="printable", screw="hardware"))
    view = prepared[0]
    assert [node["key"] for node in view["nodes"]] == ["body", "lid", "screw"]
    assert view["tree"] == [{"group": "housing", "parts": [0, 1]}, 2]


def test_groups_nest():
    prepared = prepare(
        [one_view(parts=[{"group": "outer", "parts": [
            {"group": "inner", "parts": ["body"]}]}])])
    assert prepared[0]["tree"] == [
        {"group": "outer", "parts": [{"group": "inner", "parts": [0]}]}]


def test_a_group_name_is_held_to_the_same_alphabet_as_a_key():
    """It is a node name in the view file and the viewer builds a path out of
    it, exactly as it does for a leaf."""
    assert "not usable" in refusal(
        [one_view(parts=[{"group": "the housing", "parts": ["body"]}])])


def test_a_group_name_that_is_not_a_string_is_refused():
    assert "not a string" in refusal(
        [one_view(parts=[{"group": 42, "parts": ["body"]}])])


def test_a_group_may_not_be_called_after_a_catalogue_key():
    """One name in the tree would mean two things, and neither the viewer's path
    nor a reader could tell them apart."""
    message = refusal(
        [one_view(parts=[{"group": "body", "parts": ["body"]}])])
    assert "also a catalogue key" in message


def test_an_empty_group_is_refused():
    assert "empty" in refusal(
        [one_view(parts=[{"group": "housing", "parts": []}])])


def test_an_entry_that_is_both_a_group_and_a_part_is_refused():
    assert 'both "group" and "part"' in refusal(
        [one_view(parts=[{"group": "housing", "part": "body", "parts": []}])])


def test_an_unknown_group_key_is_said_out_loud(capsys):
    prepare([one_view(parts=[{"group": "housing", "parts": ["body"],
                              "colour": "red"}])])
    printed = capsys.readouterr().out
    assert "'colour'" in printed
    assert "Known keys: group, parts" in printed


def test_two_groups_at_one_level_may_not_share_a_name():
    """One row of the tree would be two different things.

    Leaves are safe without a rule of their own -- the tessellator writes `pin`,
    `pin(2)` for repeats of a name -- but a group's name is written by this
    build straight into its id, so two `housing` groups side by side both come
    out as `/Group/housing`. `render.check_view_file` on the hub does not look
    at ids, so it publishes into an immutable build with nothing saying so.
    """
    message = refusal(
        [one_view(parts=[{"group": "housing", "parts": ["body"]},
                         {"group": "housing", "parts": ["lid"]}])],
        body="printable", lid="printable")
    assert "already a group called 'housing'" in message


def test_the_same_group_name_at_different_depths_is_fine():
    """The parent's id is part of the child's, so they cannot collide."""
    prepared = prepare(
        [one_view(parts=[{"group": "housing", "parts": [
            {"group": "housing_inner", "parts": ["body"]}]}])])
    assert prepared[0]["tree"] == [
        {"group": "housing", "parts": [
            {"group": "housing_inner", "parts": [0]}]}]


def test_a_group_name_repeated_inside_a_sibling_group_is_fine():
    prepared = prepare(
        [one_view(parts=[{"group": "left", "parts": [
                             {"group": "side", "parts": ["body"]}]},
                         {"group": "right", "parts": [
                             {"group": "side", "parts": ["lid"]}]}])],
        catalogue(body="printable", lid="printable"))
    assert len(prepared[0]["nodes"]) == 2


def test_a_nest_deeper_than_the_hub_accepts_is_refused():
    """Mirrored from render.MAX_VIEW_DEPTH: the hub walks the tree and refuses
    one deeper, so a build that emitted it would be a 422 -- and the ceiling is
    what keeps the recursion here from being a RecursionError."""
    entry = "body"
    for _ in range(MAX_VIEW_DEPTH + 1):
        entry = {"group": "g", "parts": [entry]}
    assert str(MAX_VIEW_DEPTH) in refusal([one_view(parts=[entry])])


# --------------------------------------------------------------------------
# The exemption lists
# --------------------------------------------------------------------------

def test_nested_ok_outside_the_print_view_is_said_out_loud(capsys):
    prepare([one_view(parts=["body", "lid"], nested_ok=[("body", "lid")])],
            catalogue(body="printable", lid="printable"))
    assert "only the 'print' view is checked against" in capsys.readouterr().out


def test_nested_ok_naming_a_part_that_is_not_in_the_view_is_refused():
    message = refusal([one_view(), one_view(vid="print", parts=["body"],
                                            nested_ok=[("body", "ghost")])])
    assert "'ghost'" in message
    assert "exempts nothing" in message


def test_nested_ok_is_keyed_by_catalogue_key():
    prepared = prepare([one_view(), one_view(vid="print", parts=["body", "lid"],
                                             nested_ok=[("body", "lid")])],
                       catalogue(body="printable", lid="printable"))
    assert prepared[1]["nested_ok"] == {frozenset(("body", "lid"))}


def test_interference_ok_outside_the_assembled_view_is_said_out_loud(capsys):
    prepare([one_view(), one_view(vid="print", parts=["body", "lid"],
                                  interference_ok=[("body", "lid", "why")])],
            catalogue(body="printable", lid="printable"))
    assert "only the 'assembled' view is checked" in capsys.readouterr().out


def test_an_interference_declaration_is_a_triple_with_a_reason():
    prepared = prepare(
        [one_view(parts=["body", "lid"],
                  interference_ok=[("body", "lid", "  threaded joint  ")])],
        catalogue(body="printable", lid="printable"))
    assert prepared[0]["interference_ok"] == {
        frozenset(("body", "lid")): "threaded joint"}


def test_a_two_element_interference_declaration_is_refused():
    """The reason is what separates a joint from a part standing inside another
    one by accident, so it cannot be optional."""
    message = refusal([one_view(parts=["body", "lid"],
                                interference_ok=[("body", "lid")])],
                      body="printable", lid="printable")
    assert "exactly two catalogue keys and the reason" in message


def test_an_empty_interference_reason_is_refused():
    message = refusal([one_view(parts=["body", "lid"],
                                interference_ok=[("body", "lid", "   ")])],
                      body="printable", lid="printable")
    assert "gives no reason" in message


def test_a_bare_string_instead_of_a_list_of_triples_is_refused():
    """A string is iterable, so without this it would be read character by
    character and exempt nothing."""
    with pytest.raises(BuildError) as exc:
        interference_pairs("body", {"body"}, "assembled")
    assert "got the string" in str(exc.value)


def test_an_interference_ok_that_cannot_be_iterated_is_named_not_crashed():
    """A BuildError, not a bare TypeError out of a loop.

    The string above is the mistake somebody actually makes; a number is every
    other way of getting it wrong, and it used to come out of the walk below as
    `'int' object is not iterable` -- from a file where every other refusal
    names the option and the view.
    """
    with pytest.raises(BuildError) as exc:
        interference_pairs(5, {"body"}, "assembled")
    assert "cannot be iterated" in str(exc.value)
    assert "interference_ok" in str(exc.value)


def test_a_nested_ok_that_cannot_be_iterated_is_named_not_crashed():
    """The same answer from the other half, which lives in checklib."""
    message = refusal([one_view(), one_view(vid="print", parts=["body"],
                                            nested_ok=5)])
    assert "cannot be iterated" in message
    assert "nested_ok" in message


def test_one_declaration_covers_every_reference_to_that_pair_of_keys():
    """A declaration names KEYS, so it collapses to one entry for one pair.

    Five references to `pin` are ten pin-against-pin pairs and `("pin", "pin",
    ...)` takes the check off all ten -- gate.check_interference looks the pair
    up as `frozenset((key_i, key_j))`, which for two references to one key is
    the single-element set this produces. Nothing can exempt one reference and
    not another, because a reference has no name of its own to point at.
    """
    prepared = prepare(
        [one_view(parts=["pin"] * 5,
                  interference_ok=[("pin", "pin", "pressed together")])],
        pin="printable")
    assert prepared[0]["interference_ok"] == {
        frozenset(("pin",)): "pressed together"}
    # ...and the same reading for nested_ok, which is the plate's half of it.
    plate = prepare(
        [one_view(), one_view(vid="print", parts=["body"] * 3,
                              nested_ok=[("body", "body")])])
    assert plate[1]["nested_ok"] == {frozenset(("body",))}


def test_interference_ok_naming_a_part_that_is_not_in_the_view_is_refused():
    message = refusal([one_view(parts=["body"],
                                interference_ok=[("body", "ghost", "why")])])
    assert "'ghost'" in message


@pytest.mark.parametrize("declared", [0, False, ""])
def test_a_falsy_nested_ok_is_named_rather_than_read_as_nothing(declared):
    """"The key is not there" and "the key is there and unusable" are different.

    `view.get("nested_ok") or ()` collapsed them: `nested_ok: 5` was named by
    the refusal above while `nested_ok: ""` one character away became "declared
    nothing" and passed in silence -- an exemption that is simply not there,
    from a view that says it is, which is the failure the `nestedok` warning
    beside it exists for.
    """
    message = refusal([one_view(), one_view(vid="print", parts=["body"],
                                            nested_ok=declared)])
    assert "nested_ok" in message


@pytest.mark.parametrize("declared", [0, False, ""])
def test_a_falsy_interference_ok_is_named_rather_than_read_as_nothing(declared):
    """The same asymmetry on the other list, and the one that was visible on a
    single line: `interference_ok: "abc"` was refused by name, `""` vanished."""
    message = refusal([one_view(parts=["body"], interference_ok=declared)])
    assert "interference_ok" in message


def test_an_interference_declaration_naming_a_mock_is_said_out_loud(capsys):
    """A correct-looking declaration that exempts nothing, and MISREADS.

    A mock is scenery: gate.check_interference never asks whether it shares
    space with anything. But it prints every entry of this list into the build
    log as an exemption it ran with, so a declaration naming a mock reads there
    as an overlap that was seen and excused, when nothing looked at all.
    """
    prepare([one_view(parts=["body", "wall"],
                      interference_ok=[("body", "wall", "bolted to it")])],
            catalogue(body="printable", wall="mock"))
    out = capsys.readouterr().out
    assert "'wall'" in out
    assert "takes no check off" in out


def test_an_interference_declaration_between_real_parts_is_not_warned_about(capsys):
    """Hardware stays under the gate, so a declaration about it is live."""
    prepare([one_view(parts=["body", "screw"],
                      interference_ok=[("body", "screw", "thread bites in")])],
            catalogue(body="printable", screw="hardware"))
    assert "takes no check off" not in capsys.readouterr().out


# --------------------------------------------------------------------------
# The document that is written
# --------------------------------------------------------------------------

def flat_document(*names):
    """What the tessellator hands back for a flat export: one entry per leaf."""
    return {"version": 3, "name": "Group", "id": "/Group",
            "loc": [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]],
            "parts": [{"name": name, "id": f"/Group/{name}", "shape": {}}
                      for name in names]}


def test_every_leaf_is_stamped_with_its_catalogue_key():
    """REDUNDANT with the leaf's name, and that is the point: resting on two
    strings being equal is the reconstruction this whole change removes."""
    prepared = prepare([one_view(parts=["body", "lid"])],
                       catalogue(body="printable", lid="printable"))
    doc = shaped_document(flat_document("body", "lid"), prepared[0])
    assert [leaf["key"] for leaf in doc["parts"]] == ["body", "lid"]


def test_repeated_keys_are_stamped_by_position_not_by_name():
    """The tessellator disambiguates two parts called `pin` as `pin` and
    `pin(2)`, so a lookup by name would file the second one nowhere."""
    prepared = prepare([one_view(parts=["pin", "pin"])], pin="printable")
    doc = shaped_document(flat_document("pin", "pin(2)"), prepared[0])
    assert [leaf["key"] for leaf in doc["parts"]] == ["pin", "pin"]
    assert [leaf["name"] for leaf in doc["parts"]] == ["pin", "pin(2)"]


def test_a_document_that_does_not_line_up_with_the_view_is_refused():
    """Silently, and permanently, into an immutable build: the key of each part
    is taken from the view BY POSITION."""
    prepared = prepare([one_view(parts=["body", "lid"])],
                       catalogue(body="printable", lid="printable"))
    with pytest.raises(BuildError) as exc:
        shaped_document(flat_document("body"), prepared[0])
    assert "have to line up" in str(exc.value)


@pytest.mark.parametrize("name", [None, "", 42])
def test_a_leaf_the_tessellator_gave_no_name_is_refused(name):
    """Demanded rather than defaulted, for the reason the length is checked.

    Every id is built as `<parent>/<name>`, so a document that stopped carrying
    names would come out as a tree of leaves all called `/Group/None` -- every
    path identical, no part distinguishable from its neighbours in the viewer,
    published into an immutable build with nothing anywhere saying so.
    """
    prepared = prepare([one_view(parts=["body", "lid"])],
                       catalogue(body="printable", lid="printable"))
    doc = flat_document("body", "lid")
    doc["parts"][1]["name"] = name
    with pytest.raises(BuildError) as exc:
        shaped_document(doc, prepared[0])
    assert "no usable name" in str(exc.value)


@pytest.mark.parametrize("root", [None, "", 42])
def test_a_document_the_tessellator_gave_no_root_id_is_refused(root):
    """The other end of the very string the leaf name above is one half of.

    Every node's id is `<parent>/<name>`, and the first parent is the document's
    own. Taken with `.get()` it would build the whole tree under `None/...` --
    and `render.check_view_file` on the hub does not look at an id, so that
    publishes into an immutable build with nothing anywhere saying so.
    """
    prepared = prepare([one_view(parts=["body"])])
    doc = flat_document("body")
    doc["id"] = root
    with pytest.raises(BuildError) as exc:
        shaped_document(doc, prepared[0])
    assert "no usable id" in str(exc.value)


def test_a_document_with_no_id_key_at_all_is_refused():
    """The absence has to be built: `flat_document` always carries one, which
    is why the case above cannot reach this one."""
    prepared = prepare([one_view(parts=["body"])])
    doc = flat_document("body")
    del doc["id"]
    with pytest.raises(BuildError) as exc:
        shaped_document(doc, prepared[0])
    assert "no usable id" in str(exc.value)


def test_the_groups_are_put_back_into_the_document():
    prepared = prepare(
        [one_view(parts=[{"group": "housing", "parts": ["body", "lid"]},
                         "screw"])],
        catalogue(body="printable", lid="printable", screw="hardware"))
    doc = shaped_document(flat_document("body", "lid", "screw"), prepared[0])
    top = doc["parts"]
    assert [node["name"] for node in top] == ["housing", "screw"]
    # A group is a node with `parts`, which is exactly what the viewer's
    # `isShapeTree` tests for, and what the hub's check_view_file walks.
    assert [leaf["name"] for leaf in top[0]["parts"]] == ["body", "lid"]
    assert "key" not in top[0]


def test_every_id_is_rebuilt_as_the_path_to_the_node():
    """The leaf ids the tessellator wrote are for a FLAT document and would not
    match the tree; the viewer builds its paths out of names."""
    prepared = prepare(
        [one_view(parts=[{"group": "housing", "parts": ["body"]}])])
    doc = shaped_document(flat_document("body"), prepared[0])
    group = doc["parts"][0]
    assert group["id"] == "/Group/housing"
    assert group["parts"][0]["id"] == "/Group/housing/body"


def test_a_group_moves_nothing():
    """Every leaf under it already stands where the view put it, and the viewer
    reads `loc` off every node it renders."""
    prepared = prepare(
        [one_view(parts=[{"group": "housing", "parts": ["body"]}])])
    doc = shaped_document(flat_document("body"), prepared[0])
    assert doc["parts"][0]["loc"] == [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]]


def test_a_real_export_is_a_document_the_hub_would_accept(out_dir):
    """The one test here that runs the tessellator, and the reason it exists.

    Everything above is about a document this build SHAPES; this is about the
    one it actually produces. The export is flat and then rewritten because the
    tessellator's own nesting cannot carry what the viewer needs -- handed a
    dict it repeats the group's name a level down (`/Group/housing/housing`),
    replaces every leaf name with `Workplane(Solid)` and colours per group
    instead of per part. So the rewrite is the only thing standing between the
    author's grouping and a tree nobody can read, and it is written against two
    consumers this build cannot import: the vendored viewer, whose `isShapeTree`
    is "does this node have `parts`", and the hub's own check on the way in.

    The hub's check is the half that can be run here, and running it is what
    makes this more than a shape assertion: a document it refuses is a 422 on a
    push whose geometry has already been computed.

    Skips where the kernel is missing, like every other test that needs real
    geometry; CI's image carries it (issue #27).
    """
    cq = pytest.importorskip("cadquery", exc_type=ImportError,
                             reason="a real export needs the CAD kernel")
    pytest.importorskip("ocp_tessellate", exc_type=ImportError,
                        reason="a real export needs the tessellator")
    from src import render
    from src.cadbuild.views import export_views

    def box(x):
        return cq.Workplane("XY").box(10, 10, 10).translate((x, 0, 0))

    cat = {key: {"shape": box(index * 20), "kind": kind, "color": None,
                 "note": None}
           for index, (key, kind) in enumerate(
               (("lid", "printable"), ("pin", "printable"),
                ("board", "mock")))}
    prepared = prepare_views(
        [one_view(parts=[{"group": "housing", "parts": [
            "lid", {"group": "inner", "parts": ["pin", "pin"]}]}, "board"])],
        cat)
    entries = export_views(prepared, out_dir)

    assert entries[0]["parts"] == ["lid", "pin", "board"]
    # The hub reads the file off disk, so this is fed the path rather than a
    # document -- it is the real check, not a transcription of it. The
    # catalogue goes with it because the hub holds every `key` in the file
    # against the one meta.json declares (issue #75), and THIS is the pairing
    # that check exists for: what export_views stamped on the leaves has to be
    # what the same build published as its catalogue.
    render.check_view_file(out_dir / entries[0]["file"], entries[0]["id"], cat)

    doc = json.loads((out_dir / entries[0]["file"]).read_text(encoding="utf-8"))
    housing = doc["parts"][0]
    assert housing["name"] == "housing"
    assert [leaf["key"] for leaf in housing["parts"][1]["parts"]] == \
        ["pin", "pin"]
    # The tessellator disambiguates the two references by name, and the ids are
    # rebuilt from those names -- so the viewer's own paths stay unique.
    ids = [leaf["id"] for leaf in housing["parts"][1]["parts"]]
    assert len(set(ids)) == 2
    assert all(one.startswith("/Group/housing/inner/") for one in ids)
    # Every leaf keeps its own colour, which the tessellator's own nesting
    # cannot do: a mock is grey where the printables next to it are not.
    board = doc["parts"][1]
    assert board["key"] == "board" and board["color"] == MOCK_COLOR
