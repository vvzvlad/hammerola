"""`skill/scripts/drc.sh`: the schematic parity check runs only with `<name>.kicad_sch` beside the board, and its
count is printed only when kicad-cli actually compared the two. kicad-cli is a stub written here."""

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "skill" / "scripts" / "drc.sh"

FAKE_KICAD_CLI = f"""#!{sys.executable}
import json, os, sys
args = sys.argv[1:]
if args == ["version"]:
    print("10.0.7")
    sys.exit(0)
with open(os.environ["FAKE_LOG"], "a") as log:
    log.write(" ".join(args) + "\\n")
parity = []
if "--schematic-parity" in args:
    if os.environ.get("FAKE_PARITY_FAIL"):
        print("Failed to fetch schematic netlist for parity tests.", file=sys.stderr)
    else:
        parity = [{{"type": "extra_footprint", "severity": "warning", "items": []}}]
with open(args[args.index("-o") + 1], "w") as f:
    json.dump({{"violations": [], "unconnected_items": [], "schematic_parity": parity}}, f)
"""


def drc(tmp_path, schematic, parity_fails=False):
    cli = tmp_path / "kicad-cli"
    cli.write_text(FAKE_KICAD_CLI)
    cli.chmod(cli.stat().st_mode | stat.S_IXUSR)
    board = tmp_path / "board"
    board.mkdir()
    (board / "b.kicad_pcb").write_text("(kicad_pcb)")
    if schematic:
        (board / "b.kicad_sch").write_text("(kicad_sch)")
    env = dict(os.environ, KICAD_CLI=str(cli), FAKE_LOG=str(tmp_path / "log"), KICAD_TEMPLATE_DIR=str(tmp_path))
    env.pop("FAKE_PARITY_FAIL", None)
    if parity_fails:
        env["FAKE_PARITY_FAIL"] = "1"
    r = subprocess.run(["bash", str(SCRIPT), str(board / "b.kicad_pcb"), "-", str(tmp_path / "out")],
                       capture_output=True, text=True, env=env)
    return r, (tmp_path / "log").read_text()


def test_parity_is_checked_and_counted_with_the_schematic_beside_the_board(tmp_path):
    r, log = drc(tmp_path, schematic=True)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "--schematic-parity" in log
    assert "parity: 1" in r.stdout


def test_parity_is_not_claimed_without_a_schematic_or_when_kicad_cli_could_not_compare(tmp_path):
    r, log = drc(tmp_path, schematic=False)
    assert "--schematic-parity" not in log
    assert "parity: not checked (no b.kicad_sch beside the board)" in r.stdout
    failing = tmp_path / "failing"
    failing.mkdir()
    r, log = drc(failing, schematic=True, parity_fails=True)
    assert "--schematic-parity" in log
    assert "parity: not checked (kicad-cli could not compare" in r.stdout
    assert json.loads((failing / "out" / "drc.json").read_text())["schematic_parity"] == []
