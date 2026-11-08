"""`src/kicadcli.py`, the KiCad sidecar's client, against the suite's stub of it."""

import pytest
from kicadstub import FIXTURES, KicadStub

from src import kicadcli


def test_it_sends_the_board_its_project_and_its_own_models(tmp_path):
    (tmp_path / "hw" / "3d").mkdir(parents=True)
    (tmp_path / "hw" / "amp.kicad_pcb").write_text(
        '(kicad_pcb (footprint "A" (model "${KIPRJMOD}/3d/a.step"))'
        ' (footprint "B" (model "${KIPRJMOD}/3d/a.step"))'
        ' (footprint "C" (model "${KIPRJMOD}/3d/gone.step"))'
        ' (footprint "D" (model "${KIPRJMOD}/../x.step"))'
        ' (footprint "E" (model "${KICAD10_3DMODEL_DIR}/R.step"))'
        # A VRML model goes with what `--subst-models` would put in its place.
        ' (footprint "F" (model "${KIPRJMOD}/3d/b.wrl")))')
    for name in ("hw/amp.kicad_pro", "hw/3d/a.step", "x.step", "hw/3d/b.wrl",
                 "hw/3d/b.step", "hw/3d/b.igs"):
        (tmp_path / name).write_text("x")
    with KicadStub({("glb", ("--subst-models",)): "document.glb"}) as stub:
        data, said = kicadcli.export(tmp_path / "hw" / "amp.kicad_pcb", "glb",
                                     ["--subst-models"], url=stub.url)
    assert data == (FIXTURES / "document.glb").read_bytes()
    assert said == ["Could not add 3D model for U9."]
    assert stub.requests == [("glb", ("--subst-models",), "amp.kicad_pcb",
                              ["3d/a.step", "3d/b.igs", "3d/b.step", "3d/b.wrl",
                               "amp.kicad_pcb", "amp.kicad_pro"])]


def test_a_refusal_raises_with_the_last_lines_kicad_cli_printed(tmp_path):
    board = tmp_path / "amp.kicad_pcb"
    board.write_text("(kicad_pcb)")
    printed = "\n".join(f"line {n:02}" for n in range(1, 31))
    with KicadStub({("step", ()): (422, printed)}) as stub:
        with pytest.raises(kicadcli.KicadError) as caught:
            kicadcli.export(board, "step", [], url=stub.url)
    message = str(caught.value)
    assert "kicad-cli pcb export step amp.kicad_pcb failed (HTTP 422)" in message
    assert "line 11" in message and "line 30" in message
    assert "line 10" not in message


def test_a_sidecar_that_does_not_answer_is_named_with_the_error(tmp_path):
    board = tmp_path / "amp.kicad_pcb"
    board.write_text("(kicad_pcb)")
    with pytest.raises(kicadcli.KicadError) as caught:
        kicadcli.export(board, "glb", [], url="http://127.0.0.1:1", timeout=5)
    message = str(caught.value)
    assert message.startswith(
        "the KiCad service at KICAD_URL=http://127.0.0.1:1 did not answer the "
        "export of amp.kicad_pcb: "), message
    assert message.endswith("Connection refused"), message


def test_a_cached_export_is_asked_again_only_for_another_request(tmp_path):
    board = tmp_path / "amp.kicad_pcb"
    board.write_text("(kicad_pcb)")
    cache = tmp_path / "cache"
    answers = {("glb", ("--a",)): "document.glb", ("glb", ("--b",)): "document.glb"}
    with KicadStub(answers) as stub:
        def ask(flags):
            data, _, cached = kicadcli.export_cached(board, "glb", flags, url=stub.url,
                                                     cache=cache)
            assert data == (FIXTURES / "document.glb").read_bytes()
            return cached
        assert [ask(["--a"]), ask(["--a"]), ask(["--b"])] == [False, True, False]
        board.write_text("(kicad_pcb (version 2))")
        assert ask(["--a"]) is False
    assert [flags for _, flags, _, _ in stub.requests] == [("--a",), ("--b",), ("--a",)]
