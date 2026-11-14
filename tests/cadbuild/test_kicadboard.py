"""`kicadboard`: a KiCad board loaded for model.py, on the committed fixture.

The sidecar is `kicadstub`, answering with exports the real one made of
`tests/fixtures/kicad/board.kicad_pcb` (its parts are listed there). Every
frame claim is checked against those exports: the laminate's faces, where
KiCad put each part, and the KiCad file's own track ends for the pads.
"""

import contextlib
import io
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
    log = io.StringIO()
    with KicadStub(ANSWERS) as stub, pytest.MonkeyPatch.context() as patch:
        patch.setenv(URL_ENV, stub.url)
        paths.set_project_root(root)
        try:
            with contextlib.redirect_stdout(log):
                board = kicadboard.load(PATH)
        finally:
            paths.set_project_root(None)
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
    monkeypatch.setenv(URL_ENV, "http://kicad.invalid:8080")
    paths.set_project_root(tmp_path)
    try:
        with pytest.raises(BuildError, match="stops here"):
            kicadboard.load(PATH)
    finally:
        paths.set_project_root(None)
    assert not started.broken


def test_without_kicad_url_the_build_is_told_who_exports_boards(monkeypatch):
    monkeypatch.delenv(URL_ENV, raising=False)
    with pytest.raises(BuildError) as caught:
        kicadboard.load(PATH)
    assert str(caught.value) == (
        f"kicadboard: {PATH}: a board is exported by the hub's KiCad service, "
        f"and none is configured here (KICAD_URL is not set)")


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
    assert found["unplated"] == pytest.approx([(10, -20, 3.2)])


def test_a_part_colour_is_on_sixteen_levels_a_channel():
    """KiCad's models come in near-identical blacks: one record, not three."""
    assert {kicadboard._quantised(c) for c in ("#000000", "#020202", "#050505")} == {
        "#000000"}
    assert kicadboard._quantised("#a5a392") == "#aaaa99"
    assert kicadboard._quantised("#ffffff") == "#ffffff"


def test_linear_light_is_turned_to_srgb():
    """kicad-cli writes a part's STEP colour in linear light: shown raw, a
    connector's grey body (linear 0.07) is black."""
    assert [kicadboard._srgb(c) for c in ("#000000", "#121212", "#808080", "#ffffff")] == [
        "#000000", "#4b4b4b", "#bcbcbc", "#ffffff"]


def test_a_part_colour_is_its_material_s_in_srgb(loaded):
    """The parts' records carry their materials' colours in sRGB; the layers
    keep theirs as written (`test_the_records_are_a_catalogue_moved_by_at`)."""
    board, _, _ = loaded
    gltf, _ = kicadboard._gltf((FIXTURES / "board.glb").read_bytes())
    raw = {kicadboard._color(m) for m in gltf["materials"]}
    parts = {color for name, (*_, color) in board.meshes.items() if name.startswith("parts_")}
    assert parts <= {kicadboard._quantised(kicadboard._srgb(c)) for c in raw}
    assert not parts <= {kicadboard._quantised(c) for c in raw}


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
        # Flat: a face's three corners at one height, so no slab's wall is
        # left; what is not flat is a barrel's wall, through the laminate
        # (`test_an_open_plated_hole_shows_the_inner_face_of_its_barrel`).
        flat = np.ptp(z[mesh.faces], axis=1) < 1e-6
        assert (np.ptp(z[mesh.faces[~flat]], axis=1) > board.thickness).all(), key
        assert flat.all() or key == "amp_copper", key
        grid = np.round(mesh.vertices[np.unique(mesh.faces[flat])] / kicadboard.MERGE_GRID)
        assert len(np.unique(grid, axis=0)) == len(grid), key
        assert len(np.unique(mesh.faces)) == len(mesh.vertices), key
    # The copper's outer faces: 35 um out on both sides, the pads' 40 um.
    assert sorted(set(np.round(records["amp_copper"]["mesh"].vertices[:, 2], 3))) == (
        pytest.approx([-0.04, -0.035, board.thickness + 0.035, board.thickness + 0.04]))


# The board the edge tests cut copper with: 20 x 10 mm, 1.6 thick, a 2 mm
# square cut-out at (14, 4), a 1 mm drill at (5, 5) and a plated half-hole of
# 1 mm on its top edge at (10, 10); KiCad's copper heights over and under it.
EDGE_BOARD, EDGE_TOP, EDGE_BOTTOM = 1.6, 1.635, -0.035
EDGE_DRILLS = [(5, 5, 1.0), (10, 10, 1.0)]


@pytest.fixture(scope="module")
def edge():
    """The test board's edge, as `_edge` reads it from its laminate."""
    pytest.importorskip("cadquery")
    import cadquery as cq

    def hole(x, y):
        return (cq.Workplane().cylinder(EDGE_BOARD, 0.5, centered=(True, True, False))
                .translate((x, y, 0)))
    laminate = (cq.Workplane().box(20, 10, EDGE_BOARD, centered=False)
                .cut(cq.Workplane().box(2, 2, EDGE_BOARD, centered=False).translate((14, 4, 0)))
                .cut(hole(5, 5)).cut(hole(10, 10))).val()
    return kicadboard._edge(laminate, EDGE_BOARD, EDGE_DRILLS)


def _sheet(z, step=0.3, low=(-2.05, -2.05), high=(22.1, 12.1)):
    """A copper sheet at height `z` over a box larger than the test board, two
    triangles a square, facing up over the board and down under it, as
    `_merged` leaves a layer: (vertices, faces, normals)."""
    import numpy as np

    xs, ys = np.arange(low[0], high[0], step), np.arange(low[1], high[1], step)
    gx, gy = np.meshgrid(xs, ys, indexing="ij")
    vertices = np.column_stack([gx.ravel(), gy.ravel(), np.full(gx.size, z)])
    a = (np.arange(len(xs) - 1)[:, None] * len(ys) + np.arange(len(ys) - 1)).ravel()
    b, c, d = a + len(ys), a + len(ys) + 1, a + 1
    faces = np.vstack([np.column_stack([a, b, c]), np.column_stack([a, c, d])])
    if z < 0:
        faces = faces[:, ::-1]
    normals = np.tile([0.0, 0.0, 1.0 if z > 0 else -1.0], (len(vertices), 1))
    return kicadboard._merged(vertices, faces, normals)


def test_the_edge_is_the_outline_and_the_cut_outs_and_no_drill(edge):
    import numpy as np

    ends = edge.reshape(-1, 2)
    # The drill inside the board is no edge; the half-hole is the outline's,
    # its arc followed in chords.
    assert not (np.hypot(*(ends - (5, 5)).T) < 1).any()
    arc = np.abs(np.hypot(*(ends - (10, 10)).T) - 0.5) < 1e-9
    assert arc.sum() > 8
    for corner in ((0, 0), (20, 0), (20, 10), (0, 10), (14, 4), (16, 4), (16, 6), (14, 6)):
        assert (np.abs(ends - corner).max(axis=1) < 1e-9).any(), corner
    # Every ring closes exactly: each point ends one segment and starts the
    # next, bit for bit, as the even-odd test needs.
    _, counts = np.unique(ends, axis=0, return_counts=True)
    assert (counts % 2 == 0).all()


def test_the_board_s_edge_cuts_the_copper_and_a_drill_does_not(edge):
    """A sheet larger than the board, over it and under it, comes out as the
    board's shape: cut along the outline, the cut-out's edge and the
    half-hole's arc, while the sheet over the drill stays as it was."""
    import numpy as np

    sheets = [_sheet(EDGE_TOP), _sheet(EDGE_BOTTOM)]
    offset = len(sheets[0][0])
    vertices, faces, normals = kicadboard._merged(
        np.vstack([sheets[0][0], sheets[1][0]]),
        np.vstack([sheets[0][1], sheets[1][1] + offset]),
        np.vstack([sheets[0][2], sheets[1][2]]))
    out, cut, turned = kicadboard._on_board(vertices, faces, normals, edge)

    xy, z = out[:, :2], out[:, 2]
    assert ((xy >= -1e-9) & (xy <= (20 + 1e-9, 10 + 1e-9))).all()
    assert not ((np.abs(xy - (15, 5)) < 1 - 1e-9).all(axis=1)).any()
    # The half-hole's arc is followed in chords, and a point of the cut lands
    # on MERGE_GRID.
    assert np.hypot(*(xy - (10, 10)).T).min() >= (
        0.5 - kicadboard.EDGE_DEFLECTION - kicadboard.MERGE_GRID)
    corners = out[cut][:, :, :2]
    u, v = corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0]
    signed = (u[:, 0] * v[:, 1] - u[:, 1] * v[:, 0]) / 2
    below = z[cut].mean(axis=1) < 0
    # The board's area on each side: its 200 mm2 less the cut-out and the
    # half of the half-hole inside the outline, whose arc the cut follows in
    # chords at most EDGE_DEFLECTION inside it (2/3 of that along the arc).
    board = pytest.approx(200 - 4 - np.pi * 0.5 ** 2 / 2,
                          abs=np.pi * 0.5 * kicadboard.EDGE_DEFLECTION)
    assert signed[~below].sum() == board and -signed[below].sum() == board
    # Each piece on its triangle's height, with its normal and its turn.
    assert set(np.round(z, 9)) == {EDGE_TOP, EDGE_BOTTOM}
    assert (turned[z < 0] == (0, 0, -1)).all() and (turned[z > 0] == (0, 0, 1)).all()
    assert (signed[below] < 0).all() and (signed[~below] > 0).all()
    # The sheet over the drill, and a stretch of it away from the edge, as it was.
    before = vertices[faces]
    centres = before[:, :, :2].mean(axis=1)
    away = (np.hypot(*(centres - (5, 5)).T) < 1.5) | (
        (centres > 1).all(axis=1) & (centres < (13, 3)).all(axis=1))
    kept = {row.tobytes() for row in out[cut]}
    assert away.sum() > 100
    assert all(row.tobytes() in kept for row in before[away])


def test_copper_all_on_the_board_is_the_very_record(edge):
    """The record of a board with no copper off it comes back as it was given,
    the same arrays: the sheet's triangles away from the board's edge, over
    the drill among them."""
    import numpy as np

    vertices, faces, normals = _sheet(EDGE_TOP)
    corners = vertices[faces][:, :, :2]
    on = (corners > 0.5).all(axis=(1, 2)) & (corners < (9, 9.5)).all(axis=(1, 2))
    record = kicadboard._merged(vertices, faces[on], normals)
    assert len(record[1]) > 1000
    assert all(a is b for a, b in zip(kicadboard._on_board(*record, edge), record))


def _load_over(laminate, tmp_path, monkeypatch):
    """The fixture board loaded with `laminate` (a cadquery Workplane) as the
    sidecar's STEP, its GLB as KiCad wrote it."""
    import cadquery as cq

    step = tmp_path / "laminate.step"
    cq.exporters.export(laminate, str(step))
    root = tmp_path / "project"
    (root / "kicad").mkdir(parents=True)
    shutil.copyfile(BOARD, root / PATH)
    # The stub reads `FIXTURES / answer`, and an absolute answer is that file.
    answers = {("glb", kicadboard.GLB_FLAGS): "board.glb",
               ("step", kicadboard.STEP_FLAGS): str(step)}
    with KicadStub(answers) as stub:
        monkeypatch.setenv(URL_ENV, stub.url)
        paths.set_project_root(root)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                return kicadboard.load(PATH)
        finally:
            paths.set_project_root(None)


def test_load_cuts_the_copper_at_the_laminate_s_edge(loaded, tmp_path, monkeypatch):
    """`load` cuts the copper at the edge of the laminate the sidecar hands
    it: the fixture's GLB over a laminate half its length, x 100..120, keeps
    no copper past x = 120, and every triangle short of it as the whole
    board's record has it."""
    import cadquery as cq

    whole, _, _ = loaded
    board = _load_over(cq.Workplane().box(20, 15, whole.thickness, centered=False)
                       .translate((100, -115, 0)), tmp_path, monkeypatch)

    def short(record):
        corners = record[0][record[1]]
        return {row.tobytes() for row in corners[(corners[:, :, 0] < 119).all(axis=1)]}
    assert whole.meshes["copper"][0][:, 0].max() > 121
    assert board.meshes["copper"][0][:, 0].max() <= 120 + kicadboard.MERGE_GRID
    assert short(board.meshes["copper"]) == short(whole.meshes["copper"])
    assert short(whole.meshes["copper"])


# The fixture's open plated holes, (x, y, drill): J2's (a DNP header) and H2's
# (a mounting hole with no model). KiCad's plating is 25 um, and it draws a
# barrel in 24 facets of two triangles.
OPEN_HOLES = [(133, -110, 1.0), (133, -112.54, 1.0), (137.5, -104, 2.2)]
PLATING, BARREL = 0.025, 48


def _walls(record):
    """A copper record's barrel walls, its faces that are not flat: (their
    corners, n x 3 x 3, the vertex normals at those)."""
    import numpy as np

    vertices, faces, normals, _ = record
    corners = vertices[faces]
    wall = np.ptp(corners[:, :, 2], axis=1) > 1e-6
    return corners[wall], normals[faces[wall]]


def test_an_open_plated_hole_shows_the_inner_face_of_its_barrel(loaded):
    """Of a barrel KiCad draws as a tube, its outer face on the laminate's
    hole wall and its inner face the plating inside it, the copper keeps the
    inner face of each hole the laminate keeps open: through the board from
    the pads' faces under it to those over it, turned and lit toward the
    hole's axis, which is the side it is seen from."""
    import numpy as np

    board, _, _ = loaded
    corners, normals = _walls(board.meshes["copper"])
    for x, y, drill in OPEN_HOLES:
        near = np.hypot(*(corners[:, :, :2].mean(axis=1) - (x, y)).T) < drill
        wall = corners[near]
        assert len(wall) == BARREL, (x, y)
        assert np.hypot(wall[..., 0] - x, wall[..., 1] - y) == pytest.approx(
            drill / 2 - PLATING, abs=1e-4)
        assert sorted(set(np.round(wall[..., 2].ravel(), 3))) == pytest.approx(
            [-0.04, board.thickness + 0.04])
        axis = (x, y) - wall[..., :2]
        turn = np.cross(wall[:, 1] - wall[:, 0], wall[:, 2] - wall[:, 0])[:, :2]
        assert ((turn * axis.mean(axis=1)).sum(axis=1) > 0).all(), (x, y)
        assert ((normals[near][..., :2] * axis).sum(axis=2) > 0).all(), (x, y)


def test_a_filled_drill_a_via_and_an_unplated_hole_show_no_barrel(loaded):
    """KiCad draws the barrels of J1's drills, which its pin header fills and
    the laminate closes, and of the via, which the board-only STEP has no
    hole for; the copper keeps no wall of theirs, nor the outer face of an
    open hole's. H1's unplated hole has no barrel to begin with."""
    import numpy as np

    board, _, _ = loaded
    _, _, through = kicadboard._scene((FIXTURES / "board.glb").read_bytes(), board.thickness)
    drawn = through[0][through[1]][:, :, :2].mean(axis=1)
    kept = _walls(board.meshes["copper"])[0][:, :, :2].mean(axis=1)
    for (x, y), barrel in (((133, -104), True), ((133, -106.54), True), ((114, -106), True),
                           ((105, -111), False)):
        assert (np.hypot(*(drawn - (x, y)).T) < 2).any() == barrel, (x, y)
        assert not (np.hypot(*(kept - (x, y)).T) < 2).any(), (x, y)
    assert len(drawn) == 6 * 2 * BARREL
    assert len(kept) == len(OPEN_HOLES) * BARREL


def test_a_half_hole_keeps_the_half_of_its_barrel_on_the_board(loaded, tmp_path, monkeypatch):
    """A board milled through H2's plated hole: the fixture's GLB, its barrel
    whole, over a laminate that ends at x = 137.7, 0.2 mm past the hole's
    centre, the hole a notch in that edge. The inner face's part on the
    board stays, cut where the laminate behind it ends, within WALL_FRONT of
    the edge; the part past the edge goes."""
    import cadquery as cq
    import numpy as np

    whole, _, _ = loaded
    edge, (x, y, drill) = 137.7, OPEN_HOLES[2]
    board = _load_over(
        cq.Workplane().box(edge - 100, 15, whole.thickness, centered=False)
        .translate((100, -115, 0))
        .cut(cq.Workplane().cylinder(whole.thickness, drill / 2, centered=(True, True, False))
             .translate((x, y, 0))), tmp_path, monkeypatch)
    wall, _ = _walls(board.meshes["copper"])
    radius = np.hypot(wall[..., 0] - x, wall[..., 1] - y)
    assert len(wall) and (radius < drill / 2 - PLATING / 2).all()
    inner = drill / 2 - PLATING
    assert wall[..., 0].min() == pytest.approx(x - inner, abs=1e-4)
    assert edge - kicadboard.WALL_FRONT < wall[..., 0].max() <= edge
    # Cut, not only dropped: the pieces of the triangles the edge crosses
    # have corners on their chords, between the facets' and the pads' rows.
    assert (radius >= inner * np.cos(np.pi / 24) - 1e-4).all()
    assert (radius < inner - 1e-3).any()
    z = wall[..., 2]
    assert ((z > -0.04 + 1e-3) & (z < whole.thickness + 0.04 - 1e-3)).any()
    # The edge cuts the pad's copper at the hole's wall, and the plating is
    # closed at its ends: 10 um behind the top and the bottom edge of every
    # kept wall, on the board's side, there is flat copper at that height.
    vertices, faces, _, _ = board.meshes["copper"]
    corners = vertices[faces]
    for height in (whole.thickness + 0.04, -0.04):
        flat = corners[(np.abs(corners[:, :, 2] - height) < 1e-6).all(axis=1)][:, :, :2]
        behind = []
        for face in wall:
            at = np.abs(face[:, 2] - height) < 1e-6
            if at.sum() == 2:
                turn = np.cross(face[1] - face[0], face[2] - face[0])[:2]
                behind.append(face[at, :2].mean(axis=0) - 0.01 * turn / np.linalg.norm(turn))
        assert behind, height
        for point in behind:
            assert _over(flat, point).any(), (height, point)


def _over(triangles, point):
    """Which of `triangles` (n x 3 x 2) hold `point`, their edges included."""
    import numpy as np

    a, b, c = (triangles[:, i] for i in range(3))
    side = np.stack([(q[:, 0] - p[:, 0]) * (point[1] - p[:, 1])
                     - (q[:, 1] - p[:, 1]) * (point[0] - p[:, 0])
                     for p, q in ((a, b), (b, c), (c, a))], axis=1)
    return (side >= -1e-12).all(axis=1) | (side <= 1e-12).all(axis=1)


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
