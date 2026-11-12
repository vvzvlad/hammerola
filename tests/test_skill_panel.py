"""The panel scripts in `skill/scripts/`: `panel_rules.py`, `gerbers.sh`, `gerber_diff.py`.

Pinned here:

  * panel_rules.py gives the panel the board's net classes under their own names, the board's netclass patterns and
    the nets the schematic assigns a class to as `Board_?-` patterns, the board's rules with net names prefixed and
    rule areas matched as `<name>*` while `A.NetClass == 'X'` stays as written; the old panel files go to `*.bak`;
    a board without `.kicad_dru` skips that step with a message and leaves the panel's own;
  * gerbers.sh refuses a non-empty output folder without --force and writes nothing; with it runs both kicad-cli
    exports with the board's plot settings and PTH / NPTH apart; a panel whose NPTH drill has no hole (kicad-cli
    writes the file even without one) fails unless --vcuts; a failed kicad-cli export is exit 1 even over an old
    set with --force;
  * gerber_diff.py replicates a board's picture by a shift and a 180° turn (gerbv's export) and by a mirror (the
    picture flipped), takes the paired layer for a mirrored copy, finds copies by the PTH drill, gives DIFF and
    exit 1 for missing copper, and drops a 1-px strip as raster.

kicad-cli and gerbv are stubs written here (a fake kicad-cli that writes the expected files; a gerbv that knows the
rectangular regions the synthetic Gerbers are made of), so nothing here needs KiCad or gerbv. gerber_diff.py needs
numpy and pillow, which requirements.txt already pins.
"""

import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skill" / "scripts"
FIXTURES = ROOT / "tests" / "fixtures" / "panel"

_SPEC = importlib.util.spec_from_file_location("skill_gerber_diff", SCRIPTS / "gerber_diff.py")
gd = importlib.util.module_from_spec(_SPEC)
# no skill/scripts/__pycache__: the hub packs and digests every file under skill/
_bytecode, sys.dont_write_bytecode = sys.dont_write_bytecode, True
_SPEC.loader.exec_module(gd)
sys.dont_write_bytecode = _bytecode


def executable(path, text):
    path.write_text(text)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


# ----------------------------------------------------------------------------- panel_rules.py
def rules(tmp_path, *names):
    for name in names:
        shutil.copy(FIXTURES / name, tmp_path / name)
    return subprocess.run([sys.executable, str(SCRIPTS / "panel_rules.py"), str(tmp_path / "board.kicad_pcb"),
                           str(tmp_path / "panel.kicad_pcb")], capture_output=True, text=True)


def test_panel_rules_carries_classes_patterns_assignments_and_rules(tmp_path):
    (tmp_path / "panel.kicad_dru").write_text("(version 1)\n\n")
    r = rules(tmp_path, "board.kicad_pro", "board.kicad_dru", "panel.kicad_pro")
    assert r.returncode == 0, r.stderr
    ns = json.loads((tmp_path / "panel.kicad_pro").read_text())["net_settings"]
    assert [c["name"] for c in ns["classes"]] == ["Default", "HV"]
    assert ns["netclass_patterns"] == [{"netclass": "HV", "pattern": "Board_?-/mains/L*"},
                                       {"netclass": "HV", "pattern": "Board_?-/mains/N"}]
    assert ns["netclass_assignments"] is None
    assert json.loads((tmp_path / "panel.kicad_pro").read_text())["meta"]["filename"] == "panel.kicad_pro"
    dru = (tmp_path / "panel.kicad_dru").read_text()
    assert "\"A.NetClass == 'HV' && B.NetClass != 'HV'\"" in dru
    assert "A.NetName == 'Board_?-/mains/L' && A.intersectsArea('mains*')" in dru
    assert "A.NetName != 'Board_?-GND'" in dru
    assert (tmp_path / "panel.kicad_pro.bak").read_text() == (FIXTURES / "panel.kicad_pro").read_text()
    assert (tmp_path / "panel.kicad_dru.bak").read_text() == "(version 1)\n\n"


def test_panel_rules_without_a_board_dru_skips_that_step_and_without_a_panel_pro_writes_nothing(tmp_path):
    (tmp_path / "panel.kicad_dru").write_text("(version 1)\n\n")
    r = rules(tmp_path, "board.kicad_pro", "panel.kicad_pro")
    assert r.returncode == 0 and "the .kicad_dru step is skipped" in r.stdout, r.stdout + r.stderr
    assert (tmp_path / "panel.kicad_dru").read_text() == "(version 1)\n\n"
    assert not (tmp_path / "panel.kicad_dru.bak").exists()
    assert json.loads((tmp_path / "panel.kicad_pro").read_text())["net_settings"]["classes"][1]["name"] == "HV"
    (tmp_path / "panel.kicad_pro").unlink()
    (tmp_path / "panel.kicad_pro.bak").unlink()
    r = rules(tmp_path, "board.kicad_dru")
    assert r.returncode != 0 and "panel.kicad_pro" in r.stderr
    assert not (tmp_path / "panel.kicad_pro").exists() and not (tmp_path / "panel.kicad_pro.bak").exists()


# ----------------------------------------------------------------------------- gerbers.sh
FAKE_KICAD_CLI = f"""#!{sys.executable}
import os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_LOG"], "a") as log:
    log.write(" ".join(args) + "\\n")
if os.environ.get("FAKE_FAIL"):
    print("Failed to load board", file=sys.stderr)
    sys.exit(1)
out, name = args[args.index("-o") + 1], os.path.basename(args[-1])[:-len(".kicad_pcb")]
if args[:3] == ["pcb", "export", "gerbers"]:
    files = [name + "-F_Cu.gbr", name + "-job.gbrjob"]
else:
    files = [name + "-PTH.drl", name + "-NPTH.drl"]   # the real kicad-cli writes NPTH.drl even without a hole
for f in files:
    with open(os.path.join(out, f), "w") as fh:
        if f.endswith("-NPTH.drl") and os.environ.get("FAKE_NPTH"):
            fh.write("M48\\nMETRIC\\nT1C0.600\\n%\\nT1\\nX1Y1\\nM30\\n")
print('assert "m_choices.GetCount() > 0" failed', file=sys.stderr)
"""


def gerbers(tmp_path, *args, npth=False, fail=False):
    cli = executable(tmp_path / "kicad-cli", FAKE_KICAD_CLI)
    (tmp_path / "b.kicad_pcb").write_text("(kicad_pcb)")
    env = dict(os.environ, KICAD_CLI=str(cli), FAKE_LOG=str(tmp_path / "log"))
    env.pop("FAKE_NPTH", None)
    env.pop("FAKE_FAIL", None)
    if npth:
        env["FAKE_NPTH"] = "1"
    if fail:
        env["FAKE_FAIL"] = "1"
    return subprocess.run(["bash", str(SCRIPTS / "gerbers.sh"), str(tmp_path / "b.kicad_pcb"), str(tmp_path / "out"),
                           *args], capture_output=True, text=True, env=env)


def test_gerbers_refuses_a_non_empty_folder_and_writes_with_force(tmp_path):
    (tmp_path / "out").mkdir()
    (tmp_path / "out" / "old.gbr").write_text("old")
    r = gerbers(tmp_path, npth=True)
    assert r.returncode == 2 and "--force" in r.stderr
    assert not (tmp_path / "log").exists() and os.listdir(tmp_path / "out") == ["old.gbr"]
    r = gerbers(tmp_path, "--force", npth=True)
    assert r.returncode == 0, r.stderr
    assert r.stdout.split()[-5:] == ["b-F_Cu.gbr", "b-NPTH.drl", "b-PTH.drl", "b-job.gbrjob", "old.gbr"]
    assert "m_choices" not in r.stdout + r.stderr
    log = (tmp_path / "log").read_text().splitlines()
    assert log[0].startswith("pcb export gerbers --board-plot-params -o ")
    assert log[1].startswith("pcb export drill --excellon-separate-th -o ")


def test_gerbers_panel_without_npth_holes_fails_unless_v_cut(tmp_path):
    r = gerbers(tmp_path, "--panel")
    assert r.returncode == 1 and "mouse bites" in r.stderr
    assert (tmp_path / "out" / "b-NPTH.drl").exists()   # the file is there; it is the holes that are missing
    r = gerbers(tmp_path, "--panel", "--vcuts", "--force")
    assert r.returncode == 0 and "V-cut, as expected" in r.stdout, r.stdout + r.stderr
    r = gerbers(tmp_path, "--panel", "--force", npth=True)
    assert r.returncode == 0 and "mouse bites" not in r.stderr, r.stdout + r.stderr


def test_gerbers_fails_when_kicad_cli_fails_even_over_old_files(tmp_path):
    r = gerbers(tmp_path, npth=True)
    assert r.returncode == 0, r.stderr
    r = gerbers(tmp_path, "--force", fail=True)
    assert r.returncode == 1 and "kicad-cli pcb export gerbers failed" in r.stderr, r.stdout + r.stderr


# ----------------------------------------------------------------------------- gerber_diff.py
# The synthetic Gerbers: rectangles (x0, y0, x1, y1) mm as G36/G37 regions in 4.6 mm
REGION = "G36*\nX{0}Y{1}D02*\nX{2}Y{1}D01*\nX{2}Y{3}D01*\nX{0}Y{3}D01*\nG37*\n"
GERBER = "%FSLAX46Y46*%\n%MOMM*%\n{regions}M02*\n"


def gerber_text(rects):
    return GERBER.format(regions="".join(REGION.format(*(round(v * 1e6) for v in r)) for r in rects))


# gerbv for those Gerbers: `-x rs274x -T dxXdyRrot` turns about (0,0), then shifts, as gerber_diff.py expects of
# gerbv; `-x png` fills the pixels whose centres lie inside a region
FAKE_GERBV = f"""#!{sys.executable}
import re, sys
import numpy as np
from PIL import Image
REGION, GERBER = {REGION!r}, {GERBER!r}
a = sys.argv[1:]
opt = lambda k: a[a.index(k) + 1]
rects = []
for region in re.findall(r"G36\\*(.*?)G37\\*", open(a[-1]).read(), re.S):
    xs, ys = zip(*((int(x) / 1e6, int(y) / 1e6) for x, y in re.findall(r"X(-?\\d+)Y(-?\\d+)", region)))
    rects.append((min(xs), min(ys), max(xs), max(ys)))
if opt("-x") == "rs274x":
    tx, ty, rot = re.fullmatch(r"(-?[0-9.]+)x(-?[0-9.]+)r(\\d+)", opt("-T")).groups()
    s, tx, ty = (-1 if rot == "180" else 1), float(tx), float(ty)
    moved = [(min(s * x0, s * x1) + tx, min(s * y0, s * y1) + ty, max(s * x0, s * x1) + tx, max(s * y0, s * y1) + ty)
             for x0, y0, x1, y1 in rects]
    open(opt("-o"), "w").write(GERBER.format(regions="".join(
        REGION.format(*(round(v * 1e6) for v in r)) for r in moved)))
else:
    px = 25.4 / int(opt("-D"))
    ox, oy = (float(v) * 25.4 for v in opt("-O").split("x"))
    w, h = (round(float(v) * 25.4 / px) for v in opt("-W").split("x"))
    cx, cy = ox + (np.arange(w) + 0.5) * px, oy + h * px - (np.arange(h) + 0.5) * px
    img = np.zeros((h, w), bool)
    for x0, y0, x1, y1 in rects:
        img |= ((cy >= y0) & (cy < y1))[:, None] & ((cx >= x0) & (cx < x1))[None, :]
    Image.fromarray(img.astype(np.uint8) * 255).save(opt("-o"))
"""


def gerber(path, rects):
    path.write_text(gerber_text(rects))
    return str(path)


@pytest.fixture
def gerbv(tmp_path):
    return str(executable(tmp_path / "gerbv", FAKE_GERBV))


BOARD = [(1, 1, 3, 2), (1, 3, 1.5, 4)]   # asymmetric: a wrong turn or mirror does not land on itself


@pytest.mark.parametrize("ops, expected", [
    ("T5,2", [(6, 3, 8, 4), (6, 5, 6.5, 6)]),
    ("R180@5,5", [(7, 8, 9, 9), (8.5, 6, 9, 7)]),
    ("Mx6", [(9, 1, 11, 2), (10.5, 3, 11, 4)]),
    ("My5 T1,0", [(2, 8, 4, 9), (2, 6, 2.5, 7)]),
])
def test_a_copy_is_the_board_shifted_turned_or_mirrored(tmp_path, gerbv, ops, expected):
    frame = gd.Frame(-1, -1, 13, 11, 25.4 / 254)
    got = gd.copy_image(gerbv, gerber(tmp_path / "board.gbr", BOARD), gd.mat_ops(ops), frame, 254, {})
    want = gd.render(gerbv, gerber(tmp_path / "want.gbr", expected), frame, 254)
    assert want.sum() == 250 and (got == want).all()


def test_a_mirrored_copy_takes_the_paired_layer(tmp_path):
    job = {"FilesAttributes": [{"Path": f"b-{s}.gbr", "FileFunction": f} for s, f in (
        ("F_Cu", "Copper,L1,Top"), ("In1_Cu", "Copper,L2,Inr"), ("In2_Cu", "Copper,L3,Inr"), ("B_Cu", "Copper,L4,Bot"),
        ("F_Silkscreen", "Legend,Top"), ("B_Silkscreen", "Legend,Bot"), ("F_Mask", "SolderMask,Top"),
        ("B_Mask", "SolderMask,Bot"), ("Edge_Cuts", "Profile"))]}
    (tmp_path / "b-job.gbrjob").write_text(json.dumps(job))
    layers, pair, _ = gd.discover_layers(str(tmp_path), str(tmp_path))
    assert [n for n, *_ in layers][:4] == ["L1 F_Cu", "L2 In1_Cu", "L3 In2_Cu", "L4 B_Cu"]
    assert pair == {"L1 F_Cu": "L4 B_Cu", "L2 In1_Cu": "L3 In2_Cu", "L3 In2_Cu": "L2 In1_Cu", "L4 B_Cu": "L1 F_Cu",
                    "F_Silkscreen": "B_Silkscreen", "B_Silkscreen": "F_Silkscreen", "F_Mask": "B_Mask",
                    "B_Mask": "F_Mask", "Edge_Cuts": "Edge_Cuts"}


def excellon(path, holes):
    tools = sorted({d for _, _, d in holes})
    lines = ["M48", "; DRILL file KiCad", "FMAT,2", "METRIC"] + [f"T{i + 1}C{d:.3f}" for i, d in enumerate(tools)]
    lines += ["%", "G90", "G05"]
    for i, d in enumerate(tools):
        lines += [f"T{i + 1}"] + [f"X{x:.3f}Y{y:.3f}" for x, y, dd in holes if dd == d]
    path.write_text("\n".join(lines + ["T0", "M30"]) + "\n")
    return str(path)


def test_copies_are_found_by_the_pth_drill(tmp_path):
    board = [(1, 1, 0.3), (3, 1, 0.3), (1, 4, 0.3), (4, 3, 0.8)]
    panel = board + [(12 - x, y, d) for x, y, d in board] + [(20 - x, 10 - y, d) for x, y, d in board]
    single = gd.load_drills(excellon(tmp_path / "s-PTH.drl", board))
    assert single == {(float(x), float(y), d) for x, y, d in board}
    mats = gd.auto_copies(single, gd.load_drills(excellon(tmp_path / "p-PTH.drl", panel)))
    assert [(tuple(round(v, 3) for v in gd.apply_pt(0, 0, M)), round(np.linalg.det(M[:2, :2]))) for M in mats] == [
        ((0, 0), 1), ((12, 0), -1), ((20, 10), 1)]


TOP, BOTTOM = BOARD, [(2, 3, 3, 4)]
MIRROR = lambda rects: [(12 - x1, y0, 12 - x0, y1) for x0, y0, x1, y1 in rects]   # Mx6


@pytest.mark.parametrize("variant, panel_top, code, verdict", [
    ("agrees", TOP + MIRROR(BOTTOM), 0, "SAME"),
    ("a region missing", TOP, 1, "DIFF"),
    ("the mirror took the same layer", TOP + MIRROR(TOP), 1, "DIFF"),
    ("an edge 1 px off", [(1, 1, 3.1, 2)] + TOP[1:] + MIRROR(BOTTOM), 0, "SAME"),
])
def test_the_verdict_per_layer(tmp_path, gerbv, variant, panel_top, code, verdict):
    job = {"FilesAttributes": [{"Path": "b-F_Cu.gbr", "FileFunction": "Copper,L1,Top"},
                               {"Path": "b-B_Cu.gbr", "FileFunction": "Copper,L2,Bot"}]}
    for d in ("single", "panel"):
        (tmp_path / d).mkdir()
    (tmp_path / "single" / "b-job.gbrjob").write_text(json.dumps(job))
    gerber(tmp_path / "single" / "b-F_Cu.gbr", TOP)
    gerber(tmp_path / "single" / "b-B_Cu.gbr", BOTTOM)
    gerber(tmp_path / "panel" / "p-F_Cu.gbr", panel_top)
    gerber(tmp_path / "panel" / "p-B_Cu.gbr", BOTTOM + MIRROR(TOP))
    r = subprocess.run([sys.executable, str(SCRIPTS / "gerber_diff.py"), "--single", str(tmp_path / "single"),
                        "--panel", str(tmp_path / "panel"), "--copy", "T0,0", "--copy", "Mx6", "--dpi", "254",
                        "--gerbv", gerbv, "-o", str(tmp_path / "out")], capture_output=True, text=True)
    assert r.returncode == code, variant + "\n" + r.stdout + r.stderr
    summary = (tmp_path / "out" / "summary.txt").read_text().splitlines()
    assert summary[0].startswith(f"{verdict} L1 F_Cu") and summary[1].startswith("SAME L2 B_Cu")
    red = (np.asarray(Image.open(tmp_path / "out" / "L1_F_Cu.png")) == (220, 0, 0)).all(axis=2).sum()
    assert (red > 0) == (verdict == "DIFF")
    if variant == "an edge 1 px off":
        assert "dropped as raster 0.100 mm²" in summary[0]
