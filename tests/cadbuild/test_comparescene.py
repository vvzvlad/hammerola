"""The comparison scene: two revisions merged, the difference put where it belongs.

Split where the CAD kernel is, like `test_shapediff.py` and for the same reason:
everything except the last test runs on a python with no OCCT at all, which is
CI (issue #27). What is arithmetic here is nearly all of it -- merging two
documents, rebuilding ids, recolouring leaves, placing pieces and counting
volumes are operations over dicts, and a dict can be typed by hand.

THE ONE SEAM IS `_tessellate`, and the tests below monkeypatch it. It is the
single function in the module that reaches for the kernel; standing a fake in
its place is what lets the placement rule -- the one thing in this module that
can be wrong without anything looking wrong -- be pinned in CI. The fake hands
back leaves with a DELIBERATELY WRONG colour and alpha, so a test that finds the
right ones has watched `build_scene` set them rather than the tessellator.

The last test is the one that has to agree with the kernel and with the
tessellator: it fuses two real revisions of a part and checks that the bright
geometry comes out in the part's own coordinates and is placed with the part's
loc. It skips where the kernel is missing.
"""

import json

import pytest

from src.cadbuild import comparescene
from src.cadbuild.comparescene import (ADDED_COLOR, DIFFERENCE_ALPHA,
                                       IDENTITY_LOC, REMOVED_COLOR,
                                       SHELL_ALPHA, SHELL_COLOR, STATUSES,
                                       build_scene, report)


BOX = {"xmin": -10.0, "ymin": -10.0, "zmin": 0.0,
       "xmax": 10.0, "ymax": 10.0, "zmax": 20.0}

# A sentinel rather than `or`: a test that passes `bb=None` means it.
_UNSET = object()


def at(z):
    """A leaf loc that is not the identity: the part stands z above the plate."""
    return [[0.0, 0.0, float(z)], [0.0, 0.0, 0.0, 1.0]]


def leaf(name, key=None, loc=None):
    """A tessellated part, in the shape `export_views` publishes one."""
    return {"id": f"/Group/{name}", "type": "shapes", "subtype": "solid",
            "name": name, "key": name if key is None else key,
            "shape": {"vertices": [0.0, 0.0, 0.0]}, "state": [1, 1],
            "color": "#c9a227", "alpha": 1.0, "material": None,
            "normalize_uvs": True, "texture": None,
            "loc": IDENTITY_LOC if loc is None else loc,
            "renderback": False, "accuracy": None, "bb": None}


def group(name, *nodes):
    return {"version": 3, "name": name, "id": f"/Group/{name}",
            "loc": IDENTITY_LOC, "parts": list(nodes)}


def document(*nodes, bb=_UNSET, version=3):
    """A published view document: the root the tessellator writes, with a tree."""
    return {"version": version, "name": "Group", "id": "/Group",
            "loc": IDENTITY_LOC, "normal_len": 0,
            "bb": dict(BOX) if bb is _UNSET else bb, "parts": list(nodes)}


def measurement(removed=(), added=()):
    """What `measure(..., keep_shapes=True)` returns, with sentinels for solids.

    The shapes are strings on purpose: nothing in the module under test looks
    inside one, it only carries them to the tessellator, so a sentinel says
    WHICH solid arrived where in a way a TopoDS_Shape could not.
    """
    def pieces(marks):
        return [{"volume_mm3": 10.0 * (index + 1), "area_mm2": 100.0,
                 "shape": mark} for index, mark in enumerate(marks)]

    return {"reason": None, "volume_a": 1000.0, "volume_b": 1200.0,
            "common_mm3": 900.0, "removed_mm3": 100.0, "added_mm3": 300.0,
            "removed": pieces(removed), "added": pieces(added),
            "bboxes_overlap": True}


@pytest.fixture
def tessellator(monkeypatch):
    """The kernel's one seam in this module, replaced by a fake that records.

    Returns the list of plans it was handed. Each leaf it gives back carries the
    sentinel it was asked to draw, an identity loc (which is what the real one
    produces for a piece of a fuse -- measured) and a colour and alpha that are
    both wrong, so that nothing downstream can pass by inheriting them.
    """
    plans = []

    def fake(plan):
        plans.append([dict(entry) for entry in plan])
        return ([{"id": f"/Group/piece {index}", "type": "shapes",
                  "subtype": "solid", "name": f"piece {index}",
                  "shape": {"drawn": entry["shape"]}, "state": [1, 1],
                  "color": "#000000", "alpha": 0.5, "material": None,
                  "normalize_uvs": True, "texture": None, "loc": IDENTITY_LOC,
                  "renderback": False, "accuracy": None, "bb": None}
                 for index, entry in enumerate(plan)], 3)

    monkeypatch.setattr(comparescene, "_tessellate", fake)
    return plans


def scene(document_a, document_b, diffs=None, view_id="assembled"):
    return build_scene(document_a, document_b, diffs or {}, view_id=view_id)


def children(built):
    return {node["name"]: node for node in built["parts"]}


def leaves(node):
    """Every leaf under a node, in document order -- the viewer's own descent."""
    if "parts" not in node:
        return [node]
    return [found for child in node["parts"] for found in leaves(child)]


# --------------------------------------------------------------------------
# The shape of the scene
# --------------------------------------------------------------------------

def test_the_scene_is_one_root_with_the_four_children_the_browser_matches_on(
        tessellator):
    """The names are a contract: the interface shows and hides a revision by
    matching these id prefixes, so a renamed group is toggles that do nothing."""
    built = scene(document(leaf("body")), document(leaf("body")))

    assert built["name"] == "cmp" and built["id"] == "/cmp"
    assert [node["id"] for node in built["parts"]] == [
        "/cmp/rev a", "/cmp/rev b", "/cmp/removed", "/cmp/added"]
    assert [node["name"] for node in built["parts"]] == [
        "rev a", "rev b", "removed", "added"]


def test_every_id_from_each_revision_is_rebuilt_under_its_own_prefix(tessellator):
    """Merging two trees without this does not raise -- it LOSES the parts whose
    paths collide, which in the browser was 5 parts in and 3 leaves in the tree,
    with the duplicate drawn and addressable by nothing."""
    tree = (group("housing", leaf("body"), leaf("lid")), leaf("screw"))
    built = scene(document(*tree), document(*tree))

    paths = [node["id"] for node in leaves(children(built)["rev a"])
             + leaves(children(built)["rev b"])]
    assert paths == [
        "/cmp/rev a/housing/body", "/cmp/rev a/housing/lid", "/cmp/rev a/screw",
        "/cmp/rev b/housing/body", "/cmp/rev b/housing/lid", "/cmp/rev b/screw"]
    assert len(set(paths)) == len(paths)
    # The group in between is re-ided too, or its children hang off a path that
    # is not there.
    assert children(built)["rev a"]["parts"][0]["id"] == "/cmp/rev a/housing"


def test_both_revisions_are_drawn_neutral_and_see_through(tessellator):
    """One colour for both, which is what masks the flicker of two transparent
    shells swapping places on a slow rotation."""
    built = scene(document(leaf("body"), leaf("lid")), document(leaf("body")))

    for revision in ("rev a", "rev b"):
        for shell in leaves(children(built)[revision]):
            assert shell["color"] == SHELL_COLOR
            assert shell["alpha"] == SHELL_ALPHA


def test_the_documents_handed_in_are_not_modified(tessellator):
    """The caller holds them and may hand them to something else afterwards."""
    original = document(group("housing", leaf("body", loc=at(3))))
    before = json.dumps(original, sort_keys=True)

    scene(original, document(leaf("body")))

    assert json.dumps(original, sort_keys=True) == before


def test_the_scene_frames_on_both_revisions(tessellator):
    """The viewer takes the scene's extent off the root and nowhere else."""
    wider = dict(BOX, xmax=31.0, zmin=-4.0)
    built = scene(document(leaf("body"), bb=dict(BOX)),
                  document(leaf("body"), bb=wider))

    assert built["bb"] == dict(BOX, xmax=31.0, zmin=-4.0)


@pytest.mark.parametrize("box", [None, {"xmin": 0.0}, "big"])
def test_a_revision_with_no_usable_bounding_box_is_refused(tessellator, box):
    """Without one the viewer's own bbox stays null, and the camera, the view
    cube and the section planes all read it."""
    with pytest.raises(ValueError) as exc:
        scene(document(leaf("body"), bb=box), document(leaf("body")))
    assert "bounding box" in str(exc.value)


def test_the_scene_declares_one_payload_version(tessellator):
    """Two documents written to different formats cannot be one scene: the root
    says once how the buffers under it are encoded."""
    with pytest.raises(ValueError) as exc:
        scene(document(leaf("body"), version=3),
              document(leaf("body"), version=4))
    assert "payload version" in str(exc.value)
    # And it says which side disagrees, or the reader has two documents and no
    # reason to open either.
    assert "rev a: 3, rev b: 4" in str(exc.value)


@pytest.mark.parametrize("field", ["name", "loc", "key"])
def test_a_node_missing_what_the_merge_needs_is_refused(tessellator, field):
    """Defaulted instead, each of these draws a scene that is WRONG rather than
    one that fails: one path for every part, a part at the origin, or a part
    that quietly loses its difference geometry."""
    part = leaf("body")
    del part[field]
    with pytest.raises(ValueError) as exc:
        scene(document(part), document(leaf("body")), {"body": measurement()})
    assert field in str(exc.value) and "assembled" in str(exc.value)


# --------------------------------------------------------------------------
# Where the difference is drawn -- the point of the module
# --------------------------------------------------------------------------

def test_the_difference_is_drawn_where_the_part_stands(tessellator):
    """THE correctness point of this module.

    A part's STEP is exported in the part's OWN coordinates, so the pieces come
    out in those coordinates too; the part's place in the view is the loc of the
    leaf that references it. Without this the bright geometry lands at the
    origin -- which looks like a scene rather than like a defect.
    """
    built = scene(document(leaf("cap", loc=at(15))),
                  document(leaf("cap", loc=at(17))),
                  {"cap": measurement(removed=["cut"], added=["put"])})

    removed = children(built)["removed"]["parts"]
    added = children(built)["added"]["parts"]
    # Each side takes its loc from ITS OWN revision: what was removed was part
    # of A and stands where A shows it, what was added is part of B.
    assert [piece["loc"] for piece in removed] == [at(15)]
    assert [piece["loc"] for piece in added] == [at(17)]
    assert [piece["shape"] for piece in removed] == [{"drawn": "cut"}]
    assert [piece["shape"] for piece in added] == [{"drawn": "put"}]


def test_a_part_the_view_shows_twice_gets_its_difference_at_both_places(
        tessellator):
    """A view references the catalogue and may reference one entry many times
    (`pin` x5, issue #75). A part that changed changed at every occurrence."""
    both = document(leaf("pin", key="pin", loc=at(1)),
                    leaf("pin(2)", key="pin", loc=at(9)))
    built = scene(both, both, {"pin": measurement(removed=["cut"])})

    removed = children(built)["removed"]["parts"]
    assert [piece["loc"] for piece in removed] == [at(1), at(9)]
    assert [piece["id"] for piece in removed] == [
        "/cmp/removed/pin #1", "/cmp/removed/pin(2) #1"]
    # Both pieces say which catalogue entry they belong to, stated rather than
    # parsed back out of the name.
    assert {piece["key"] for piece in removed} == {"pin"}


def test_several_pieces_of_one_part_each_get_a_path_of_their_own(tessellator):
    """A boolean produces several routinely -- a vent slot widened by 0.4 mm
    came out as twelve pieces -- and two nodes sharing an id is one of them
    unaddressable in the viewer."""
    built = scene(document(leaf("body")), document(leaf("body")),
                  {"body": measurement(removed=["one", "two", "three"])})

    removed = children(built)["removed"]["parts"]
    assert [piece["id"] for piece in removed] == [
        "/cmp/removed/body #1", "/cmp/removed/body #2", "/cmp/removed/body #3"]


def test_the_difference_is_bright_and_opaque(tessellator):
    """Opaque is load-bearing: it writes depth, which is what keeps the two
    translucent shells from flickering over the bright layer."""
    built = scene(document(leaf("body")), document(leaf("body")),
                  {"body": measurement(removed=["cut"], added=["put"])})

    removed = children(built)["removed"]["parts"][0]
    added = children(built)["added"]["parts"][0]
    assert (removed["color"], removed["alpha"]) == (REMOVED_COLOR,
                                                    DIFFERENCE_ALPHA)
    assert (added["color"], added["alpha"]) == (ADDED_COLOR, DIFFERENCE_ALPHA)


# --------------------------------------------------------------------------
# A part only one of the two revisions has -- the difference with no
# measurement behind it
# --------------------------------------------------------------------------

def test_a_part_only_the_new_revision_has_is_drawn_bright_and_whole(tessellator):
    """A part that APPEARED is added material in its entirety.

    Nothing fused it against anything, so `diffs` cannot hold it and `_planned`
    passes it by; without this it reaches the scene as a neutral shell inside
    `rev b` and nothing else -- indistinguishable, on screen, from geometry
    nobody touched, while the report beside it calls the part new.
    """
    built = scene(document(leaf("body")),
                  document(leaf("body"), leaf("hinge", loc=at(7))))

    added = children(built)["added"]["parts"]
    assert [piece["id"] for piece in added] == ["/cmp/added/hinge #1"]
    assert added[0]["key"] == "hinge" and added[0]["loc"] == at(7)
    assert (added[0]["color"], added[0]["alpha"]) == (ADDED_COLOR,
                                                      DIFFERENCE_ALPHA)
    # The geometry is the leaf's OWN mesh, out of the document being
    # re-labelled: the tessellator was never asked for any of it.
    assert added[0]["shape"] == leaf("hinge")["shape"]
    assert tessellator == []
    assert children(built)["removed"]["parts"] == []


def test_a_part_only_the_old_revision_has_is_drawn_bright_and_whole(tessellator):
    """The mirror image: all of it went, and it stands where A shows it."""
    built = scene(document(leaf("body"), leaf("lid", loc=at(2))),
                  document(leaf("body")))

    removed = children(built)["removed"]["parts"]
    assert [piece["id"] for piece in removed] == ["/cmp/removed/lid #1"]
    assert removed[0]["key"] == "lid" and removed[0]["loc"] == at(2)
    assert (removed[0]["color"], removed[0]["alpha"]) == (REMOVED_COLOR,
                                                          DIFFERENCE_ALPHA)
    assert children(built)["added"]["parts"] == []


def test_a_part_that_appeared_is_drawn_bright_at_every_place_it_stands(
        tessellator):
    """A view may reference one catalogue entry many times (`pin` x5, issue
    #75), each occurrence its own leaf with its own loc. A part that appeared
    appeared at every one of them."""
    built = scene(document(leaf("body")),
                  document(leaf("body"),
                           leaf("pin", key="pin", loc=at(1)),
                           leaf("pin(2)", key="pin", loc=at(9))))

    added = children(built)["added"]["parts"]
    assert [piece["id"] for piece in added] == [
        "/cmp/added/pin #1", "/cmp/added/pin(2) #1"]
    assert [piece["loc"] for piece in added] == [at(1), at(9)]
    assert {piece["key"] for piece in added} == {"pin"}


def test_the_part_that_appeared_keeps_its_neutral_shell_as_well(tessellator):
    """The bright leaf is a COPY. The shell stays translucent under `rev b` --
    the bright one is opaque, writes depth and wins where the two overlap --
    and the document handed in is not touched at all."""
    document_b = document(leaf("body"), leaf("hinge", loc=at(7)))
    before = json.dumps(document_b, sort_keys=True)

    built = scene(document(leaf("body")), document_b)

    shell = leaves(children(built)["rev b"])[1]
    assert shell["id"] == "/cmp/rev b/hinge"
    assert (shell["color"], shell["alpha"]) == (SHELL_COLOR, SHELL_ALPHA)
    assert json.dumps(document_b, sort_keys=True) == before


def test_a_part_dropped_from_this_view_is_gone_from_this_view(tessellator):
    """THE CASE THE TWO HALVES USED TO CONTRADICT EACH OTHER ON.

    Both revisions still export `clip` -- it is in the catalogue of each, and
    the fuse found nothing to say about it -- but this view stopped showing it.
    A comparison describes the parts the compared VIEW shows, so in this view
    the whole part is gone, and the picture and the list say that together.
    """
    built = scene(document(leaf("body"), leaf("clip", loc=at(3))),
                  document(leaf("body")))
    made = rows(report({}, document(leaf("body"), leaf("clip", loc=at(3))),
                       document(leaf("body")), view_id="assembled",
                       refused={}, covered={"body", "clip"}))

    removed = children(built)["removed"]["parts"]
    assert [piece["id"] for piece in removed] == ["/cmp/removed/clip #1"]
    assert (removed[0]["color"], removed[0]["loc"]) == (REMOVED_COLOR, at(3))
    assert made["clip"]["status"] == "removed"
    assert set(made) == {"body", "clip"}


def test_a_part_dropped_from_this_view_is_drawn_whole_and_not_by_its_pieces(
        tessellator):
    """The same case with a measurement behind it, which changes nothing here.

    A fuse can measure how the PART changed between the two revisions; this
    view did not lose those pieces, it lost the part. So the whole leaf is
    drawn -- once, with the path its own name gives it -- the measured pieces
    are not, and the report says `removed` rather than `changed`.
    """
    shows_clip = document(leaf("body"), leaf("clip", loc=at(3)))
    diffs = {"clip": measurement(removed=["cut"], added=["put"])}

    built = scene(shows_clip, document(leaf("body")), diffs)
    made = rows(report(diffs, shows_clip, document(leaf("body")),
                       view_id="assembled", refused={},
                       covered={"body", "clip"}))

    removed = children(built)["removed"]["parts"]
    assert [piece["id"] for piece in removed] == ["/cmp/removed/clip #1"]
    # The leaf's own mesh, not a tessellated piece of the fuse -- and the fuse's
    # `added` piece is not drawn on the other side either.
    assert removed[0]["shape"] == leaf("clip")["shape"]
    assert children(built)["added"]["parts"] == []
    assert tessellator == []
    assert made["clip"] == {"key": "clip", "status": "removed",
                            "added_mm3": 0.0, "removed_mm3": 0.0}


def test_the_scene_and_the_report_agree_on_what_appeared_and_what_vanished(
        tessellator):
    """One statement in two forms, out of the same two documents: what the
    report calls `new` is bright in `added`, what it calls `removed` is bright
    in `removed`."""
    document_a = document(leaf("body"), leaf("lid"))
    document_b = document(leaf("body"), leaf("hinge"))

    built = scene(document_a, document_b)
    made = report({}, document_a, document_b, view_id="assembled", refused={},
                  covered={"body", "lid", "hinge"})

    for group_name, status in (("added", "new"), ("removed", "removed")):
        assert {piece["key"]
                for piece in children(built)[group_name]["parts"]} == {
                    line["key"] for line in made["parts"]
                    if line["status"] == status}
    # And it is not two empty sets agreeing with each other.
    assert {line["key"] for line in made["parts"]
            if line["status"] == "new"} == {"hinge"}


def test_a_measured_part_this_view_does_not_show_draws_nothing(tessellator):
    """Ordinary rather than a failure: a view shows a subset of the catalogue,
    while a build exports a STEP for every printable in it."""
    built = scene(document(leaf("body")), document(leaf("body")),
                  {"gasket": measurement(removed=["cut"])})

    assert children(built)["removed"]["parts"] == []
    assert children(built)["added"]["parts"] == []
    # And nothing was handed to the tessellator at all.
    assert tessellator == []


def test_a_view_with_nothing_changed_in_it_asks_the_tessellator_for_nothing(
        tessellator):
    built = scene(document(leaf("body")), document(leaf("body")))

    assert tessellator == []
    assert children(built)["removed"]["parts"] == []
    assert built["version"] == 3


def test_the_pieces_go_to_the_tessellator_in_one_call(tessellator):
    """Flat and once, for the reason `export_views` exports flat: handed a dict
    the tessellator loses the leaf names and colours the group."""
    scene(document(leaf("body"), leaf("lid")),
          document(leaf("body"), leaf("lid")),
          {"body": measurement(removed=["a"], added=["b"]),
           "lid": measurement(added=["c"])})

    assert len(tessellator) == 1
    assert [entry["shape"] for entry in tessellator[0]] == ["a", "b", "c"]


def test_a_piece_with_no_shape_on_it_says_which_option_puts_one_there(
        tessellator):
    """`measure` throws the solids away by default, and that default is what the
    text half reads."""
    without = measurement(removed=["cut"])
    del without["removed"][0]["shape"]

    with pytest.raises(ValueError) as exc:
        scene(document(leaf("body")), document(leaf("body")),
              {"body": without})
    assert "keep_shapes=True" in str(exc.value)


def test_a_refused_measurement_is_not_quietly_drawn_as_no_difference(
        tessellator):
    """`check` runs before this, never after: a measurement it refused carries
    ONLY `reason`, and the KeyError here is the contract `drop_slivers` holds.

    The walk keeps such a part out of `diffs` altogether and hands its reason to
    `report` instead (`buildproc.comparechild._compare`), so this is a caller
    that put one in anyway -- and the scene has nothing it could draw for it.
    """
    with pytest.raises(KeyError):
        scene(document(leaf("body")), document(leaf("body")),
              {"body": {"reason": "b.step holds 2 solids"}})


def test_a_tessellation_that_does_not_line_up_with_the_plan_is_refused(
        monkeypatch):
    """Everything is aligned by POSITION, so a short list is pieces drawn under
    the wrong part."""
    monkeypatch.setattr(comparescene, "_tessellate", lambda plan: ([], 3))

    with pytest.raises(ValueError) as exc:
        scene(document(leaf("body")), document(leaf("body")),
              {"body": measurement(removed=["cut"])})
    assert "placed by its position" in str(exc.value)


def test_a_piece_that_arrives_with_a_location_of_its_own_is_refused(monkeypatch):
    """Measured: a piece of a fuse over two solids read out of STEP comes back
    with an identity location, so the mesh is in the part's own coordinates.
    One that arrived with a location would have it DROPPED here -- drawn in the
    right place with the wrong shape."""
    def moved(plan):
        return ([dict(leaf(f"piece {index}"), loc=at(4))
                 for index, _ in enumerate(plan)], 3)

    monkeypatch.setattr(comparescene, "_tessellate", moved)

    with pytest.raises(ValueError) as exc:
        scene(document(leaf("body")), document(leaf("body")),
              {"body": measurement(removed=["cut"])})
    assert "location of its own" in str(exc.value)


# --------------------------------------------------------------------------
# The report beside the scene
# --------------------------------------------------------------------------

def rows(made):
    """The report as `{key: line}`, which is not the shape it is published in."""
    return {line["key"]: line for line in made["parts"]}


def summary(diffs=None, shows_a=(), shows_b=(), view_id="assembled",
            refused=None, covered=None):
    """The report for two revisions whose views show exactly these parts.

    `report` reads its parts out of the two view documents, the same two the
    scene is built from, so a list of names here is a view that shows those
    parts: `leaf` keys each one by its own name. `refused` is what the walk
    could not measure, `{key: reason}`, and no default hides it: `report`
    demands the argument, so every test here says which parts were refused --
    usually none.

    `covered` IS THE SET THE WALK COMPARED, and the default here spells out the
    assumption every test in this file used to make silently: an ALL-PRINTABLE
    view, where the walk covered every part both views show. That assumption is
    what let a `hardware` leaf be published as unchanged for three rounds, so a
    test about a part nothing measured passes the set itself.
    """
    shown_in_both = set(shows_a) & set(shows_b)
    return report(diffs or {}, document(*[leaf(key) for key in shows_a]),
                  document(*[leaf(key) for key in shows_b]), view_id=view_id,
                  refused=refused or {},
                  covered=shown_in_both if covered is None else covered)


def test_the_report_lists_its_parts_the_way_the_browser_reads_them():
    """A LIST with the key inside each row, and not a map keyed by part.

    `compareRows` (ui/src/HammerolaViewer.jsx) takes `report.parts` as an array
    and drops every row without a string `key`. Handed a map it finds no rows at
    all, and the panel then says "this report lists no parts" over a comparison
    that found plenty -- an error on neither side, and nothing anywhere saying
    so.
    """
    made = summary({"body": measurement(removed=["a"])}, ["body"], ["body"])

    assert made["parts"] == [{"key": "body", "status": "changed",
                              "added_mm3": 0.0, "removed_mm3": 10.0}]


def test_the_parts_are_listed_in_the_order_the_printed_report_walks_them():
    """Sorted by key, which is what `comparechild` prints its lines in, and not
    the order the two documents happen to list their parts in."""
    made = summary({}, ["plate", "post", "cap"], ["post", "plate", "clip"])

    assert [line["key"] for line in made["parts"]] == [
        "cap", "clip", "plate", "post"]


def test_a_part_only_one_of_the_two_views_shows_is_new_or_gone():
    made = rows(summary({}, ["body", "lid"], ["body", "hinge"]))

    assert made["hinge"]["status"] == "new"
    assert made["lid"]["status"] == "removed"
    # No material either way: nothing fused a part against nothing, and the
    # volume that would be honest is in that revision's own metrics.json.
    assert made["hinge"]["added_mm3"] == 0.0
    assert made["lid"]["removed_mm3"] == 0.0


def test_a_part_with_no_measurement_at_all_is_unchanged():
    """The digest fast path: two STEP files equal byte for byte, nothing for the
    kernel to do, and no entry in `diffs` to show for it."""
    made = rows(summary({}, ["body"], ["body"]))

    assert made["body"] == {"key": "body", "status": "unchanged",
                            "added_mm3": 0.0, "removed_mm3": 0.0}


def test_a_measured_part_reports_the_volume_of_the_pieces_that_are_drawn():
    """The pieces' own volumes and not the measurement's totals, so that the
    report and the scene beside it are one statement."""
    made = rows(summary({"body": measurement(removed=["a", "b"], added=["c"])},
                        ["body"], ["body"]))

    assert made["body"]["status"] == "changed"
    # 10 + 20 out, 10 in -- and not the 100/300 the measurement's own totals say.
    assert made["body"]["removed_mm3"] == 30.0
    assert made["body"]["added_mm3"] == 10.0


def test_a_part_whose_pieces_were_all_slivers_is_unchanged_and_costs_nothing():
    """`drop_slivers` empties the lists and leaves the totals as measured, on
    purpose. Reading those totals here would report a part as unchanged and
    give a volume for the change in the same line."""
    made = summary({"body": measurement()}, ["body"], ["body"])

    assert rows(made)["body"] == {"key": "body", "status": "unchanged",
                                  "added_mm3": 0.0, "removed_mm3": 0.0}
    assert made["totals"] == {"added_mm3": 0.0, "removed_mm3": 0.0}


def test_the_totals_add_up_every_part():
    made = summary({"body": measurement(removed=["a"], added=["b"]),
                    "lid": measurement(added=["c", "d"])},
                   ["body", "lid"], ["body", "lid", "clip"])

    assert made["totals"] == {"added_mm3": 10.0 + 30.0, "removed_mm3": 10.0}
    assert rows(made)["clip"]["status"] == "new"


def test_every_status_is_one_of_the_six_and_the_report_is_json():
    made = summary({"body": measurement(removed=["a"])},
                   ["body", "lid", "cap", "reference_spacer"],
                   ["body", "hinge", "cap", "reference_spacer"],
                   refused={"cap": "the two revisions share no volume at all"},
                   covered={"body", "cap"})

    assert {line["status"] for line in made["parts"]} <= set(STATUSES)
    assert json.loads(json.dumps(made)) == made


def test_a_part_the_gate_refused_says_so_instead_of_saying_unchanged():
    """THE REFUSAL PUBLISHED AS A REFUSAL, which is the whole of this status.

    `shapediff.check` turns down a measurement exactly where the kernel may
    have lied -- a part moved 0.1 mm came back with an intersection of nothing
    and no errors to show for it -- so the one answer this row may not give is
    "no difference". It carries the sentence the job log carries beside it, and
    no volumes: there is nothing here that may be added up.
    """
    made = summary({}, ["body", "lid"], ["body", "lid"],
                   refused={"lid": "the two revisions share no volume at all "
                                   "while their bounding boxes overlap"})

    assert rows(made)["lid"] == {
        "key": "lid", "status": "not measured", "added_mm3": 0.0,
        "removed_mm3": 0.0,
        "reason": "the two revisions share no volume at all while their "
                  "bounding boxes overlap"}
    # The part nobody refused is untouched by any of it, and the totals are
    # still only what was measured.
    assert rows(made)["body"]["status"] == "unchanged"
    assert made["totals"] == {"added_mm3": 0.0, "removed_mm3": 0.0}


def test_a_refused_measurement_is_not_reported_as_unchanged():
    """The same contract the scene holds, and the same reason: `check` first.

    A refusal travels in `refused` and never in `diffs` -- the test above is
    what that looks like -- so this shape is a caller that mixed the two, and
    the KeyError is what keeps it from being read as a part with no pieces.
    """
    with pytest.raises(KeyError):
        summary({"body": {"reason": "a.step is not a STEP file"}},
                ["body"], ["body"])


def test_a_part_nothing_ever_measured_is_published_as_not_compared():
    """THE SECOND ROAD TO THE SAME DEFECT, and the one every test here missed.

    A view's leaves are every kind of catalogue entry (`parts.KINDS`), while the
    walk behind `diffs` and `refused` is over `*.step` files -- and a build
    exports one of those per PRINTABLE. So `reference_spacer`, the `hardware`
    entry in `ui/tests/fixtures/assembled.json`, is in neither map for the one
    reason that nothing ever looked at it, and it used to come out
    `{"status": "unchanged"}`: swap an M3x8 for an M3x12 and the panel says
    "identical -- all N parts unchanged".

    ITS OWN WORD, AND NOT THE GATE'S. Nothing is wrong with a bought screw
    having no geometry of ours -- it is a property of the part rather than an
    event in this revision -- so it says `not compared`, which the browser draws
    muted and sorts with the parts nothing happened to. Sharing `not measured`
    with the gate's refusal put the warning colour and the top of the list on
    every bought part a model has, and most have several.

    NOTHING IN THE DOCUMENT SAYS WHICH KIND A LEAF IS -- a published leaf is a
    mesh with a key on it, and hardware looks exactly like a printable here --
    so the set of parts the walk covered has to be HANDED IN. That is why
    `covered` is spelled out below while every other test lets the helper
    assume an all-printable view.
    """
    made = rows(summary({}, ["body", "reference_spacer"],
                        ["body", "reference_spacer"], covered={"body"}))

    assert made["reference_spacer"]["status"] == "not compared"
    # The reason is the whole content of the row: the status alone says nobody
    # looked and not why nobody would.
    assert made["reference_spacer"]["reason"] == (
        "the two builds did not both export it as STEP, so nothing was fused "
        "-- hardware and mocks most often")
    # No volumes on it, like every other row nothing was measured for.
    assert made["reference_spacer"]["added_mm3"] == 0.0
    assert made["reference_spacer"]["removed_mm3"] == 0.0
    # And no seventh status was invented to say it.
    assert {line["status"] for line in made.values()} <= set(STATUSES)


def test_the_reason_is_true_of_a_part_that_changed_KIND_between_revisions():
    """THE CATEGORY IS WIDER THAN HARDWARE, and the sentence has to be too.

    A part that was `printable` in one revision and `hardware` -- or a mock --
    in the other is shown by both views and is outside `covered` all the same:
    the walk saw one `<key>.step` and called it `new` or `removed`, which is
    exactly the verdict that keeps a key out of the set
    (`comparechild._compare`). So this row is given to a part ONE BUILD DID
    EXPORT A STEP FOR, and a sentence saying hardware and mocks have no
    geometry of ours is then simply false about the part it is printed under.

    What is true of every row that carries the word is that no PAIR of files
    came from the two builds, so nothing was fused -- which is what the sentence
    now leads with, hardware and mocks following as the example they are. The
    order is asserted rather than the wording, because the wording is prose and
    the order is the claim.
    """
    made = rows(summary({}, ["body", "bushing"], ["body", "bushing"],
                        covered={"body"}))

    reason = made["bushing"]["reason"]
    assert made["bushing"]["status"] == "not compared"
    assert "did not both export it as STEP" in reason
    assert "nothing was fused" in reason
    # The example comes after the definition and is marked as the usual case
    # rather than as the rule.
    assert reason.index("hardware and mocks") > reason.index("nothing was fused")
    assert "most often" in reason
    # And it does not claim anything about THIS part's geometry, which is the
    # half that was false: one of the two builds may well have exported it.
    assert "no geometry of ours" not in reason


def test_the_two_silences_are_two_words_the_browser_can_tell_apart():
    """ONE REPORT, BOTH KINDS OF SILENCE, AND THEY MAY NOT SHARE A ROW SHAPE.

    The browser gives them different chips and different places in the list
    (`isQuiet` in ui/src/HammerolaViewer.jsx), and the only thing it has to go
    on is this word: `lid` is a printable whose measurement the gate turned
    down, which is a question outstanding, and `reference_spacer` is hardware
    nobody was ever going to compare, which is not news at all. Published under
    one word, the routine case pushes the alarming one -- and everything that
    changed -- down the list behind it.

    NEITHER MAY BE `unchanged`, which is what the two still have in common and
    what the invariant below holds whatever else moves.
    """
    made = rows(summary({}, ["body", "lid", "reference_spacer"],
                        ["body", "lid", "reference_spacer"],
                        refused={"lid": "the fused volume does not add up"},
                        covered={"body", "lid"}))

    assert made["lid"]["status"] == "not measured"
    assert made["reference_spacer"]["status"] == "not compared"
    assert made["lid"]["status"] != made["reference_spacer"]["status"]
    # Each carries its own sentence, and they are not the same sentence either.
    assert made["lid"]["reason"] == "the fused volume does not add up"
    assert "hardware and mocks" in made["reference_spacer"]["reason"]
    # The part between them is untouched: only these two rows are silent.
    assert made["body"]["status"] == "unchanged"


def test_a_printable_the_walk_did_cover_still_reads_exactly_as_before():
    """The other half of the fix: nothing changes for a part that WAS measured.

    Both rows are asserted whole -- the digest fast path's `unchanged` and a
    measured `changed` with the pieces' own volumes -- beside a part the walk
    never covered, so a `covered` set that leaked into the ordinary rows would
    show up here rather than in a project's panel.
    """
    made = rows(summary({"body": measurement(removed=["a"], added=["b"])},
                        ["body", "lid", "reference_spacer"],
                        ["body", "lid", "reference_spacer"],
                        covered={"body", "lid"}))

    assert made["body"] == {"key": "body", "status": "changed",
                            "added_mm3": 10.0, "removed_mm3": 10.0}
    assert made["lid"] == {"key": "lid", "status": "unchanged",
                           "added_mm3": 0.0, "removed_mm3": 0.0}
    assert made["reference_spacer"]["status"] == "not compared"


@pytest.mark.parametrize("diffs, refused", [
    ({}, {}),                                             # the ordinary case
    ({"spacer": measurement()}, {}),                      # nothing found
    ({"spacer": measurement(removed=["cut"])}, {}),       # pieces found
    ({}, {"spacer": "the fused volume does not add up"}),  # the gate refused
])
def test_a_key_the_walk_did_not_cover_is_never_unchanged(diffs, refused):
    """THE INVARIANT ITSELF, and it holds whatever the two maps happen to say.

    `unchanged` is a positive claim, so it may only be concluded from a
    membership: the key is one the walk covered and neither map holds it. Read
    off an ABSENCE instead -- "in neither map, so nothing changed" -- it is the
    most confident possible answer to a question nobody asked, and the shape of
    this defect twice over. The value in `diffs` is irrelevant on purpose: a
    row for a key nothing measured is decided before anything looks at one.

    TWO ACCEPTABLE ANSWERS NOW AND NOT ONE, because the silence has two words:
    the gate's refusal travels in `refused` and keeps `not measured`, and
    everything else the walk never covered is `not compared`. Which of the two
    is the parametrisation's business; that neither is `unchanged` is this
    test's, and that is the part which may not move.
    """
    made = rows(summary(diffs, ["spacer"], ["spacer"], refused=refused,
                        covered=set()))

    assert made["spacer"]["status"] != "unchanged"
    assert made["spacer"]["status"] in ("not measured", "not compared")
    assert made["spacer"]["status"] in STATUSES
    # And whichever it is, the row says why rather than only saying nothing.
    assert made["spacer"]["reason"]


def test_the_report_is_about_the_view_and_not_about_the_catalogue():
    """A part the two builds exported and this view does not show has no row.

    The scene draws nothing for it -- there is no leaf to draw -- so a row here
    would be one a reader cannot click through to, over geometry that is in no
    picture. The printed report walks every exported part and is a different
    question; `comparechild` still prints its line.
    """
    made = summary({"gasket": measurement(removed=["cut"])},
                   ["body"], ["body"])

    assert [line["key"] for line in made["parts"]] == ["body"]
    assert made["totals"] == {"added_mm3": 0.0, "removed_mm3": 0.0}


def test_a_leaf_with_no_key_is_refused_by_the_report_too():
    """The report names parts by that key: dropped silently, the part would be
    missing from the list while the picture still had to draw it."""
    part = leaf("body")
    del part["key"]

    with pytest.raises(ValueError) as exc:
        report({}, document(part), document(leaf("body")), view_id="assembled",
               refused={}, covered={"body"})
    assert "key" in str(exc.value) and "assembled" in str(exc.value)


def test_the_report_and_the_scene_agree_on_which_parts_changed(tessellator):
    """One statement in two forms, out of the same two documents: a part the
    report calls changed has bright geometry in the scene, and a part it calls
    unchanged has none."""
    diffs = {"body": measurement(removed=["cut"]), "lid": measurement()}
    both = document(leaf("body"), leaf("lid"))

    built = scene(both, both, diffs)
    made = report(diffs, both, both, view_id="assembled", refused={},
                  covered={"body", "lid"})

    bright = {piece["key"] for piece in children(built)["removed"]["parts"]
              + children(built)["added"]["parts"]}
    changed = {line["key"] for line in made["parts"]
               if line["status"] == "changed"}
    assert bright == changed == {"body"}


# --------------------------------------------------------------------------
# The one test that runs the kernel
# --------------------------------------------------------------------------

def test_a_real_difference_is_drawn_in_the_part_coordinates_and_placed(tmp_path):
    """The whole path, with a real fuse and a real tessellation behind it.

    Everything above stands a fake in front of the tessellator, so nothing above
    can catch the fact this rests on: the pieces of a fuse over two solids read
    out of STEP come back in the PART'S own coordinates, and the loc that puts
    them where the part stands is the view's. This asserts both halves -- the
    mesh sits where the part's geometry sits, and the leaf carries the view's
    loc -- so a change that started baking the placement into either one would
    show up as the geometry being applied twice.

    Skips where the kernel is missing, i.e. in CI on both workflows (issue #27).
    """
    cq = pytest.importorskip("cadquery", exc_type=ImportError,
                             reason="a real fuse and tessellation need the kernel")
    from src.cadbuild.shapediff import check, drop_slivers, measure

    def grooved(width):
        # The groove grows on ONE side, so widening it removes a single piece.
        return (cq.Workplane("XY").box(20, 20, 10)
                .faces(">Z").workplane()
                .moveTo(width / 2, 0).rect(width, 20).cutBlind(-3))

    def written_like_the_hub_writes_it(shape, path):
        # Through an assembly, because `printables.export_printables` exports
        # every `<part>.step` as `cq.Assembly(obj, name=name)`.
        cq.Assembly(shape, name="part").export(str(path), exportType="STEP")

    narrow, wide = tmp_path / "a.step", tmp_path / "b.step"
    written_like_the_hub_writes_it(grooved(4), narrow)
    written_like_the_hub_writes_it(grooved(6), wide)

    plain = measure(narrow, wide)
    assert set(plain["removed"][0]) == {"volume_mm3", "area_mm2"}, (
        "the default contract is two floats per piece and nothing else -- the "
        "text half reads it and prints it into a job log")

    kept = drop_slivers(measure(narrow, wide, keep_shapes=True))
    assert check(kept) is None
    assert len(kept["removed"]) == 1 and kept["added"] == []

    # The part stands 50 mm up in this view, which is the whole question: the
    # STEP it was measured from knows nothing about that.
    standing = at(50)
    built = build_scene(document(leaf("body", loc=standing)),
                        document(leaf("body", loc=standing)),
                        {"body": kept}, view_id="assembled")

    piece = built["parts"][2]["parts"][0]
    assert piece["id"] == "/cmp/removed/body #1"
    assert piece["loc"] == standing
    assert piece["color"] == REMOVED_COLOR and piece["alpha"] == DIFFERENCE_ALPHA

    # The mesh itself is in the part's coordinates: the groove spans x = 0..4 in
    # the narrow revision and x = 0..6 in the wide one, so what the widening
    # removed is the slab from x = 4 to x = 6, 3 mm deep into the top of a box
    # that runs z = -5..5 -- and NOWHERE near the 50 mm the loc moves it by.
    vertices = piece["shape"]["vertices"]
    assert vertices, "the tessellation produced no geometry at all"
    xs, zs = vertices[0::3], vertices[2::3]
    assert (min(xs), max(xs)) == pytest.approx((4.0, 6.0))
    assert (min(zs), max(zs)) == pytest.approx((2.0, 5.0))

    # And the whole thing is what the hub hands to a browser: plain JSON.
    assert json.loads(json.dumps(built))["id"] == "/cmp"
