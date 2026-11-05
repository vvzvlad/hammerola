"""`skill/scripts/instructions.py`: the IKEA-style assembly-instructions PDF of a project.

Pinned here, on a tiny model whose bodies are numbered base 0, lid 1, screw 2-3, pins 4-7,
pair 8-9 and bag 10-12 in `bodies`:

  * an explode vector is in the part's own frame: a body placed with a turning `at` moves
    along the turned axis;
  * `{"part": key, "count": N}` takes the next N bodies in the view's order, and
    `{"part": key, "bodies": [...]}` exactly those, refusing an index out of range, one already
    added and part of a composite piece;
  * a printable that no step adds is refused by key and body index;
  * the callout counts pieces by congruence: a record of four identical bodies is 4x of one
    body, a record of different bodies is one composite piece, two references are 2x, and the
    key of a record of pieces of several kinds is not printed beside them;
  * the travel line runs from the middle of the piece's leading end seated to the same point
    exploded, on the piece itself, a composite piece has one, and lines that overlap on one
    axis are one;
  * a step marked upside_down is drawn with the assembly turned over;
  * an edge between faces at a small angle is drawn only on the silhouette;
  * a run prints the inventory and writes the cover plus one page per step.

The script runs in the hub image; here it is loaded by path and needs the CAD kernel.
"""

import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest

cq = pytest.importorskip("cadquery")

ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location(
    "skill_instructions", ROOT / "skill" / "scripts" / "instructions.py")
instructions = importlib.util.module_from_spec(_SPEC)
# no skill/scripts/__pycache__: the hub packs and digests every file under skill/
_bytecode, sys.dont_write_bytecode = sys.dont_write_bytecode, True
_SPEC.loader.exec_module(instructions)
sys.dont_write_bytecode = _bytecode

# Two printables and two screws: the first turned 180 deg about X, the second 90 deg about Y.
# Three mocks, which no step has to add: four identical pins in one record, a box with a pin,
# and a bag of two nuts and a washer.
MODEL = """
import cadquery as cq

def parts():
    return {"base": {"shape": cq.Workplane().box(40, 30, 10), "kind": "printable"},
            "lid": {"shape": cq.Workplane().box(40, 30, 3), "kind": "printable"},
            "screw": {"shape": cq.Workplane().circle(1.5).extrude(12), "kind": "hardware",
                      "note": "M3x12, винт"},
            "pins": {"shape": cq.Compound.makeCompound(
                         [cq.Solid.makeCylinder(1, 5, cq.Vector(x, 40, 0)) for x in (0, 5, 10, 15)]),
                     "kind": "mock"},
            "pair": {"shape": cq.Compound.makeCompound(
                         [cq.Solid.makeBox(2, 2, 2, cq.Vector(0, 50, 0)),
                          cq.Solid.makeCylinder(1, 5, cq.Vector(10, 50, 0))]),
                     "kind": "mock"},
            "bag": {"shape": cq.Compound.makeCompound(
                        [cq.Solid.makeCylinder(2, 3, cq.Vector(x, 60, 0)) for x in (0, 10)]
                        + [cq.Solid.makeBox(4, 4, 1, cq.Vector(20, 60, 0))]),
                    "kind": "mock"}}

def views():
    return [{"id": "assembled", "parts": [
        "base",
        {"part": "lid", "at": cq.Location(cq.Vector(0, 0, 6.5))},
        {"part": "screw", "at": cq.Location(cq.Vector(-15, 0, 20), cq.Vector(1, 0, 0), 180)},
        {"part": "screw", "at": cq.Location(cq.Vector(30, 0, 0), cq.Vector(0, 1, 0), 90)},
        "pins", "pair", "bag"]}]
"""


@pytest.fixture(scope="module")
def project(tmp_path_factory):
    """The tiny project, loaded once: `(dir, catalogue, bodies)`.

    `import model` is one name for every project and load_model() leaves the project on
    sys.path, so both are taken back off, with the working directory.
    """
    path = tmp_path_factory.mktemp("project")
    (path / "model.py").write_text(MODEL, encoding="utf-8")
    (path / "project.json").write_text('{"id": "0123456789ab", "title": "tiny"}', encoding="utf-8")
    saved_path = list(sys.path)
    with pytest.MonkeyPatch.context() as patch:
        patch.chdir(path)
        sys.modules.pop("model", None)
        catalogue, bodies = instructions.load_assembled(path)
        yield path, catalogue, bodies
    sys.modules.pop("model", None)
    sys.path[:] = saved_path


def resolved(project, steps):
    path, catalogue, bodies = project
    (path / "instructions.json").write_text(json.dumps({"title": "Tiny", "steps": steps}),
                                            encoding="utf-8")
    doc = instructions.read_instructions(path / "instructions.json")
    return instructions.resolve_steps(doc, catalogue, bodies)


def refusal(project, steps):
    with pytest.raises(SystemExit) as refused:
        resolved(project, steps)
    return str(refused.value)


def test_explode_moves_along_the_turned_axis_of_each_body(project):
    steps = resolved(project, [{"title": "all", "add": [
        "base", "lid", {"part": "screw", "explode": [0, 0, 20]}]}])
    offset = steps[0]["offset"]
    assert sorted(offset) == [2, 3]
    assert offset[2].toTuple() == pytest.approx((0, 0, -20), abs=1e-9)
    assert offset[3].toTuple() == pytest.approx((20, 0, 0), abs=1e-9)


def test_count_takes_the_next_bodies_in_view_order(project):
    steps = resolved(project, [{"title": "one", "add": ["base", {"part": "screw", "count": 1}]},
                               {"title": "rest", "add": ["lid", "screw"]}])
    assert steps[0]["added"] == [0, 2]
    assert steps[1]["added"] == [1, 3]


def test_bodies_takes_exactly_those_and_refuses_the_rest(project):
    steps = resolved(project, [{"title": "two pins", "add": [
        "base", "lid", "screw", {"part": "pins", "bodies": [3, 1]}]}])
    assert steps[0]["added"] == [0, 1, 2, 3, 7, 5]
    assert "'pins' has bodies 0..3, not 4" in refusal(
        project, [{"title": "x", "add": [{"part": "pins", "bodies": [4]}]}])
    assert "body 1 of 'pins' is already added" in refusal(
        project, [{"title": "x", "add": [{"part": "pins", "bodies": [1]}]},
                  {"title": "y", "add": [{"part": "pins", "bodies": [1]}]}])
    assert "'pair' is one piece made of different bodies" in refusal(
        project, [{"title": "x", "add": [{"part": "pair", "bodies": [0]}]}])


def test_a_printable_no_step_adds_is_refused_by_key_and_body(project):
    assert "no step adds 'lid' body 0" in refusal(
        project, [{"title": "no lid", "add": ["base", "screw"]}])


def test_the_callout_counts_pieces_by_congruence(project):
    steps = resolved(project, [{"title": "all", "add": [
        "base", "lid", "screw", "pins", "pair", "bag"]}])
    items = instructions.callout_items(steps[0], project[2])
    assert [(key, count, len(piece.Solids())) for key, count, piece in items] == [
        ("base", 1, 1), ("lid", 1, 1), ("screw", 2, 1), ("pins", 4, 1), ("pair", 1, 2),
        ("bag", 2, 1), ("bag", 1, 1)]
    assert instructions.bag_keys(project[2]) == {"bag"}


def test_the_travel_line_ends_on_the_exploded_leading_face(project):
    """On the body: an upside-down L leads with the foot of its post, where the centre of its
    box's bottom face (15, 2.5, 0) is in the air. A composite piece gets one line."""
    box = cq.Solid.makeBox(10, 20, 30)
    ell = cq.Solid.makeBox(5, 5, 35).fuse(cq.Solid.makeBox(30, 5, 5, cq.Vector(0, 0, 35)))
    for shape, offset, seated, exploded in [
            (box, (0, 0, 50), (5, 10, 0), (5, 10, 50)),
            (box, (-40, 0, 0), (10, 10, 15), (-30, 10, 15)),
            (ell, (0, 0, 50), (2.5, 2.5, 0), (2.5, 2.5, 50))]:
        start, end = instructions.travel(shape, cq.Vector(*offset))
        assert start.toTuple() == pytest.approx(seated, abs=1e-6)
        assert end.toTuple() == pytest.approx(exploded, abs=1e-6)
    moved = box.moved(cq.Location(cq.Vector(0, 0, 50))).BoundingBox()
    start, end = instructions.travel(box, cq.Vector(0, 0, 50))
    assert end.z == pytest.approx(moved.zmin)

    steps = resolved(project, [{"title": "all", "add": [
        "base", "lid", {"part": "screw", "explode": [0, 0, 20]},
        {"part": "pair", "explode": [0, 0, 10]}]}])
    pieces = instructions.exploded_pieces(steps[0], project[2])
    assert sorted(len(shape.Solids()) for shape, _ in pieces) == [1, 1, 2]

    # on one axis: one apart listed first, then two that overlap, the second pointing back;
    # and one beside them
    v = cq.Vector
    lines = instructions.merged_travels([(v(0, 0, 100), v(0, 0, 90)), (v(0, 0, 0), v(0, 0, 50)),
                                         (v(0, 0, 60), v(0, 0, 10)), (v(5, 0, 0), v(5, 0, 50))])
    assert sorted((round(a.x, 9), *sorted((round(a.z, 9), round(b.z, 9)))) for a, b in lines) \
        == [(0, 0, 60), (0, 90, 100), (5, 0, 50)]


def test_upside_down_draws_the_assembly_turned_over(project):
    """A cone, apex up: from [25, -60] the apex is the top of the drawing, 30 cos 25 deg up,
    and the front of its base the bottom, 10 sin 25 deg down; turned over, the other way."""
    cone = cq.Solid.makeCone(10, 0, 30)
    for upside_down, low, high in [(False, -4.226, 27.189), (True, -27.189, 4.226)]:
        lines = instructions.hidden_line_view([cone], (25, -60), upside_down)[0]
        ys = [y for line in lines for _, y in line]
        assert (min(ys), max(ys)) == pytest.approx((low, high), abs=0.05)
    # Turned over, not mirrored: the base now faces the camera, so its far edge is drawn
    # too, which a vertically mirrored normal view would still hide behind the cone.
    assert any(abs(x) < 0.3 and abs(y + 4.226) < 0.3 for line in lines for x, y in line)
    assert '"upside_down" must be true or false' in refusal(
        project, [{"title": "x", "add": ["base"], "upside_down": "yes"}])


def test_a_faceted_prism_draws_its_rims_and_two_silhouette_edges():
    """48 sides meet at 7.5 deg: one surface, so only the silhouette of its side edges is drawn.

    From [25, -60] the top rim (48 edges) and the front half of the bottom rim (24) show, plus
    the two side edges where a face turned to the camera meets one turned away.
    """
    prism = cq.Workplane().polygon(48, 40).extrude(10).val()
    lines = instructions.hidden_line_view([prism], (25, -60))[0]
    upright = [line for line in lines
               if abs(line[0][0] - line[-1][0]) < 1e-6 and abs(line[0][1] - line[-1][1]) > 1]
    assert (len(upright), len(lines)) == (2, 48 + 24 + 2)


def test_a_run_prints_the_inventory_and_writes_one_page_per_step(project, tmp_path, capsys):
    resolved(project, [{"title": "Base", "text": "Положить на стол.", "add": ["base"]},
                       {"title": "Lid and screws", "add": [
                           {"part": "lid", "explode": [0, 0, 30]},
                           {"part": "screw", "explode": [0, 0, 15]}]}])
    out = tmp_path / "instructions.pdf"
    instructions.main(["instructions.py", str(project[0]), str(out)])
    assert len(re.findall(rb"/Type\s*/Page(?!s)", out.read_bytes())) == 3
    printed = capsys.readouterr().out
    assert "pins: 4 bodies" in printed and "#3" in printed
    assert "pair: 2 bodies (a composite piece" in printed
