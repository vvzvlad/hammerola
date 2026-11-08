"""`kicadboard`: a KiCad board loaded for model.py, on the committed fixture.

The sidecar is `kicadstub`, answering with exports the real one made of
`tests/fixtures/kicad/board.kicad_pcb` (its parts are listed there). Every
frame claim is checked against those exports: the laminate's faces, where
KiCad put each part, and the KiCad file's own track ends for the pads.
"""

import contextlib
import io
import os
import re
import shutil

import pytest
from kicadstub import BOARD, FIXTURES, KicadStub

import kicadboard as top_level
from src.cadbuild import kicadboard, parts, paths
from src import kicadcli
from src.cadbuild.errors import BuildError
from src.kicadcli import URL_ENV

PATH = "kicad/board.kicad_pcb"
ANSWERS = {("glb", kicadboard.GLB_FLAGS): "board.glb",
           ("step", kicadboard.STEP_FLAGS): "board.step"}
# glTF (metres, Y up, z = KiCad y) to the board frame, as a rotation.
AXES = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]


@pytest.fixture(scope="module")
def loaded(tmp_path_factory):
    """The fixture board, loaded once: (board, the stub's requests, the log)."""
    pytest.importorskip("cadquery")
    pytest.importorskip("trimesh")
    root = tmp_path_factory.mktemp("project")
    (root / "kicad").mkdir()
    shutil.copyfile(BOARD, root / PATH)
    saved = os.environ[URL_ENV]
    log = io.StringIO()
    with KicadStub(ANSWERS) as stub:
        os.environ[URL_ENV] = stub.url
        paths.set_project_root(root)
        try:
            with contextlib.redirect_stdout(log):
                board = kicadboard.load(PATH)
        finally:
            paths.set_project_root(None)
            os.environ[URL_ENV] = saved
    return board, stub.requests, log.getvalue()


SEGMENT = re.compile(r'\(segment\s+\(start (\S+) (\S+)\)\s+\(end (\S+) (\S+)\)'
                     r'\s+\(width \S+\)\s+\(layer "([FB])\.Cu"\)')


def tracks():
    """The fixture's two tracks as KiCad wrote them: side -> (start, end)."""
    return {side: ((float(sx), float(sy)), (float(ex), float(ey)))
            for sx, sy, ex, ey, side in SEGMENT.findall(BOARD.read_text())}


def test_it_asks_for_the_two_exports_with_the_board_alone(loaded):
    _, requests, log = loaded
    # Side by side, so in either order.
    assert sorted(requests) == [
        ("glb", kicadboard.GLB_FLAGS, "board.kicad_pcb", ["board.kicad_pcb"]),
        ("step", kicadboard.STEP_FLAGS, "board.kicad_pcb", ["board.kicad_pcb"])]
    assert f"kicadboard: {PATH}: Could not add 3D model for U9." in log
    assert re.search(rf"kicadboard: {PATH}: 3 parts; GLB \d+\.\d s and STEP "
                     rf"\d+\.\d s, exported side by side; processed in \d+\.\d s",
                     log), log


def test_the_two_exports_run_side_by_side(tmp_path, monkeypatch):
    """Each export waits until the other has started: one after the other,
    the first would wait out its timeout."""
    import threading

    started = threading.Barrier(2, timeout=10)

    def export(source, fmt, flags, *, url, cache):
        started.wait()
        raise kicadcli.KicadError(f"{fmt} stops here")

    monkeypatch.setattr(kicadcli, "export_cached", export)
    paths.set_project_root(tmp_path)
    try:
        with pytest.raises(BuildError, match="stops here"):
            kicadboard.load(PATH)
    finally:
        paths.set_project_root(None)
    assert not started.broken


def test_without_kicad_url_the_build_is_told_who_exports_boards(monkeypatch):
    monkeypatch.delenv(URL_ENV)
    with pytest.raises(BuildError) as caught:
        kicadboard.load(PATH)
    message = str(caught.value)
    assert message.startswith(f"kicadboard: {PATH}: a board is exported by the hub's "
                              f"KiCad service, whose address is KICAD_URL"), message
    assert "KICAD_URL is not set here" in message


def test_the_frame_is_kicads_step_frame(loaded):
    board, _, _ = loaded
    box = board.laminate.BoundingBox()
    assert board.thickness == pytest.approx(1.51)
    assert (box.xmin, box.xmax, box.ymin, box.ymax, box.zmin, box.zmax) == pytest.approx(
        (100, 140, -115, -100, 0, board.thickness))


def test_every_footprint_is_read_with_its_side_and_pads(loaded):
    board, _, _ = loaded
    fp = board.footprints
    assert {ref: (f.side, f.x, f.y, f.angle) for ref, f in fp.items()} == {
        "H1": ("F", 105, -111, 0), "R1": ("F", 108, -106, 90),
        "R2": ("F", 124, -104, 0), "C1": ("B", 118, -108, 30),
        "J1": ("F", 133, -104, 0), "J2": ("F", 133, -110, 0),
        "H2": ("F", 137.5, -104, 0)}
    assert {n: p.net for n, p in fp["R1"].pads.items()} == {"1": "VCC", "2": "SIG"}
    assert fp["H1"].pads[""].net is None
    # The SIG pads are where KiCad's own tracks end: R1's on the top, C1's on
    # the bottom, flipped and turned.
    (r1x, r1y), _ = tracks()["F"]
    _, (c1x, c1y) = tracks()["B"]
    assert (fp["R1"].pads["2"].x, fp["R1"].pads["2"].y) == pytest.approx((r1x, -r1y))
    assert (fp["C1"].pads["1"].x, fp["C1"].pads["1"].y) == pytest.approx((c1x, -c1y))


def test_a_location_is_where_kicad_put_the_part(loaded):
    """The footprint's frame turned as KiCad turned the part's model in the
    GLB, top and bottom, and on its side's face, which KiCad's model origin
    sits 0.085 mm outside of."""
    import numpy as np
    import trimesh

    board, _, _ = loaded
    scene = trimesh.load(FIXTURES / "board.glb", force="scene", process=False)
    axes = np.array(AXES, dtype=float)
    for ref, outward in (("R1", 1), ("C1", -1)):
        placed = scene.graph.get(ref)[0]
        trsf = board.footprints[ref].location.wrapped.Transformation()
        matrix = np.array([[trsf.Value(i, j) for j in (1, 2, 3, 4)] for i in (1, 2, 3)])
        assert matrix[:, :3] == pytest.approx(axes @ placed[:3, :3] @ axes.T, abs=1e-9)
        shift = axes @ placed[:3, 3] * 1000 - matrix[:, 3]
        assert shift[:2] == pytest.approx((0, 0), abs=1e-6)
        assert shift[2] == pytest.approx(outward * 0.085, abs=1e-6)


def test_the_parts_start_at_their_faces_and_the_unfitted_have_no_bounds(loaded):
    board, _, _ = loaded
    fp = board.footprints
    assert [ref for ref in sorted(fp) if fp[ref].bounds is None] == ["H1", "H2", "J2", "R2"]
    r1, c1 = fp["R1"].bounds, fp["C1"].bounds
    assert 0 < r1[2] - board.thickness <= 0.09
    assert 0 < -c1[5] <= 0.09
    # R1 is a 1.6 x 0.8 mm 0603 turned a quarter: long along y.
    assert (r1[3] - r1[0], r1[4] - r1[1]) == pytest.approx((0.8, 1.6), abs=0.01)
    # ...and centred on its footprint: the GLB's z is KiCad's y, turned.
    assert ((r1[0] + r1[3]) / 2, (r1[1] + r1[4]) / 2) == pytest.approx(
        (fp["R1"].x, fp["R1"].y), abs=0.01)
    # Nothing of the DNP R2 is in the part meshes, where it would stand (its
    # silkscreen and pads stay on the board).
    for name, (vertices, _, _, _) in board.meshes.items():
        near = ((abs(vertices[:, 0] - 124) < 1) & (abs(vertices[:, 1] + 104) < 0.6))
        assert not (name.startswith("parts_") and near.any()), name


def test_the_records_are_a_catalogue_moved_by_at(loaded):
    import cadquery as cq
    import numpy as np

    board, _, _ = loaded
    at = cq.Location(cq.Vector(10, 20, 30), cq.Vector(0, 0, 1), 90)
    here, moved = board.records("amp"), board.records("amp", at=at)
    colors = sorted(key for key in here if key.startswith("amp_parts_"))
    assert sorted(here) == sorted(["amp_pcb", "amp_mask", "amp_copper", "amp_silk",
                                   *colors]) and colors
    assert here["amp_pcb"]["kind"] == "hardware"
    assert here["amp_pcb"]["color"] == kicadboard.PCB_COLOR
    assert {here[key]["kind"] for key in here if key != "amp_pcb"} == {"mock"}
    for key in colors:
        assert here[key]["color"] == "#" + key.rsplit("_", 1)[1]
        assert all(int(key[-6:][i:i + 2], 16) % 17 == 0 for i in (0, 2, 4)), key
    assert here["amp_copper"]["color"] == "#b29c00"
    turn = np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1]])
    for key in here:
        if key == "amp_pcb":
            box = moved[key]["shape"].BoundingBox()
            assert (box.xmin, box.ymin, box.zmin) == pytest.approx((110, 120, 30))
        else:
            assert moved[key]["mesh"].vertices == pytest.approx(
                here[key]["mesh"].vertices @ turn.T + (10, 20, 30))

    class Model:
        @staticmethod
        def parts():
            return here
    assert sorted(parts.read_catalogue(Model)) == sorted(here)


def _holes(shape, thickness):
    """The holes in `shape`'s top face: {(x, y) of the centre, to 0.01 mm: wire}."""
    (top,) = [face for face in shape.Faces()
              if abs(face.Center().z - thickness) < 1e-3 and face.geomType() == "PLANE"]
    return {(round(w.BoundingBox().center.x, 2), round(w.BoundingBox().center.y, 2)): w
            for w in top.innerWires()}


def test_the_laminate_closes_only_the_drills_a_fitted_part_fills(loaded):
    """J1's two plated holes are closed: its pin header is in the GLB. The
    rest stay: H1's unplated one, the outline's cut-out, and the plated holes
    of H2 (a mounting hole, no model) and J2 (DNP)."""
    import math

    import cadquery as cq

    board, _, _ = loaded
    step = cq.importers.importStep(str(FIXTURES / "board.step")).val()
    j1 = [(133.0, -104.0), (133.0, -106.54)]
    kept = [(105.0, -111.0), (133.0, -112.54), (133.0, -110.0), (137.5, -111.0),
            (137.5, -104.0)]
    holes = _holes(step, board.thickness)
    assert sorted(holes) == sorted(j1 + kept)
    assert sorted(_holes(board.laminate, board.thickness)) == kept
    # A hole is a drill by its centre and its size: H2's 2.2 mm one is not a
    # 1 mm drill on the same spot.
    h2 = holes[(137.5, -104.0)]
    assert kicadboard._filled(h2, [(137.5, -104, 2.2)])
    assert not kicadboard._filled(h2, [(137.5, -104, 1.0)])
    assert board.laminate.isValid()
    # J1's 1 mm drills are solid now, through the whole thickness.
    assert board.laminate.Volume() == pytest.approx(
        step.Volume() + 2 * math.pi * 0.5 ** 2 * board.thickness, rel=1e-6)
    # A solid with no flat top at the board's thickness is kept as it came.
    ball = cq.Solid.makeSphere(1)
    assert kicadboard._laminate(ball, board.thickness, []) is ball


def test_a_footprint_s_plated_drills_are_read_with_their_larger_size():
    tree = kicadboard._sexpr(
        '(kicad_pcb (footprint "J" (layer "F.Cu") (at 10 20 90)'
        ' (property "Reference" "J5")'
        ' (pad "1" thru_hole circle (at 1 0) (drill 1))'
        ' (pad "2" thru_hole oval (at 0 2) (drill oval 1.2 2 (offset 0.1 0)))'
        ' (pad "" np_thru_hole circle (at 0 0) (drill 3.2))'
        ' (pad "3" smd rect (at -1 0))))')
    (found,) = kicadboard._footprints(tree)
    assert found["drills"] == pytest.approx([(10, -19, 1), (12, -20, 2)])


def test_a_part_colour_is_on_sixteen_levels_a_channel():
    """KiCad's models come in near-identical blacks: one record, not three."""
    assert {kicadboard._quantised(c) for c in ("#000000", "#020202", "#050505")} == {
        "#000000"}
    assert kicadboard._quantised("#a5a392") == "#aaaa99"
    assert kicadboard._quantised("#ffffff") == "#ffffff"


def test_the_layers_are_their_outer_faces_merged(loaded):
    """KiCad writes copper and pads as slabs whose inner faces lie on the
    laminate's; the records keep each layer's flat outer faces, where KiCad put
    them, with no vertex on or inside the laminate and none twice."""
    import numpy as np
    import trimesh

    board, _, _ = loaded
    raw = trimesh.load(FIXTURES / "board.glb", force="scene", process=False)
    copper = np.concatenate([
        trimesh.transform_points(raw.geometry[name].vertices, matrix)[:, 1] * 1000
        for matrix, name in map(raw.graph.get, raw.graph.nodes_geometry)
        if re.fullmatch(r"board_(copper|pad)(_\d+)*", name)])
    for face in (0, board.thickness):
        assert np.isclose(copper, face, atol=1e-3).any(), (
            f"the fixture's copper no longer touches the face at z = {face}")
    records = board.records("amp")
    for key in ("amp_mask", "amp_copper", "amp_silk"):
        mesh = records[key]["mesh"]
        z = mesh.vertices[:, 2]
        assert not ((z > -1e-3) & (z < board.thickness + 1e-3)).any(), key
        assert z.min() < 0 and z.max() > board.thickness, key
        # Flat: a face's three corners at one height, so no wall is left.
        assert np.ptp(z[mesh.faces], axis=1).max() < 1e-6, key
        grid = np.round(mesh.vertices / kicadboard.MERGE_GRID)
        assert len(np.unique(grid, axis=0)) == len(grid), key
        assert len(np.unique(mesh.faces)) == len(grid), key
    # The copper's outer faces: 35 um out on both sides, the pads' 40 um.
    assert sorted(set(np.round(records["amp_copper"]["mesh"].vertices[:, 2], 3))) == (
        pytest.approx([-0.04, -0.035, board.thickness + 0.035, board.thickness + 0.04]))


def test_a_kicad_6_footprint_is_read_by_its_fp_text_reference():
    tree = kicadboard._sexpr(
        '(kicad_pcb (footprint "R" (layer "B.Cu") (at 1 2)'
        ' (fp_text reference "R7" (at 0 0)) (pad "1" smd rect (at 1 0) (net 3 "GND"))'
        ' (pad "2" smd rect (at -1 0) (net 0 ""))))')
    (found,) = kicadboard._footprints(tree)
    assert (found["reference"], found["side"], found["angle"]) == ("R7", "B", 0.0)
    assert found["pads"]["1"] == kicadboard.Pad(2.0, -2.0, "GND")
    assert found["pads"]["2"].net is None


def test_a_prefix_that_is_no_catalogue_key_is_refused(loaded):
    board, _, _ = loaded
    with pytest.raises(BuildError, match="is not a catalogue key"):
        board.records("bad prefix")


def test_import_kicadboard_is_the_implementation():
    assert top_level.load is kicadboard.load
    assert sorted(top_level.__all__) == sorted(
        name for name in vars(top_level)
        if not name.startswith("_") and name not in ("importlib", "os", "sys"))
