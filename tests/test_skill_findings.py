"""`skill/scripts/findings.py`: the filter a layout agent runs over its DRC and geometry-gate reports.

Pinned here:

  * ref, pad and net are read off kicad-cli's item descriptions, and a quoted zone name or text never passes for
    a footprint;
  * every filter must hold, each for some item of the finding, and a geometry finding has no ref;
  * `--by` counts a finding once under each ref or net it names, "-" for an item without one.

The script is stdlib-only and is loaded from `skill/scripts/` by path; nothing here needs KiCad.
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location("skill_findings", ROOT / "skill" / "scripts" / "findings.py")
findings = importlib.util.module_from_spec(_SPEC)
# no skill/scripts/__pycache__: the hub packs and digests every file under skill/
_bytecode, sys.dont_write_bytecode = sys.dont_write_bytecode, True
_SPEC.loader.exec_module(findings)
sys.dont_write_bytecode = _bytecode


def item(desc, x, y):
    return {"description": desc, "pos": {"x": x, "y": y}, "uuid": None}


def row(typ, *items, severity="error"):
    return {"type": typ, "severity": severity, "description": typ, "items": list(items)}


DRC = {"source": "board.kicad_pcb", "violations": [
    row("clearance", item("Pad 3 [GND] of U19 on F.Cu", 10, 10), item("Track [/SDA] on F.Cu, length 1.0000 mm", 10.2, 10)),
    row("clearance", item("Via [GND] on F.Cu - B.Cu", 50, 50), item("Pad 1 [/SCL] of R5 on F.Cu", 50.3, 50)),
    row("silk_overlap", item("Zone 'top of U1' [GND] on In1.Cu, priority 0", 20, 20), item("Footprint U19", 21, 20),
        severity="warning")],
    "unconnected_items": [
    row("unconnected_items", item("PTH pad SH [GND] of J3", 30, 30), item("Pad 5 [GND] of U19 on B.Cu", 11, 11))]}
GEO = [{"kind": "jog", "net": "GND", "x": 10.5, "y": 10.5, "layer": "F.Cu", "msg": "jog segment 0.3 mm"}]


@pytest.fixture
def run(tmp_path, capsys, monkeypatch):
    """One findings.py run on DRC and GEO with the given options; returns its stdout."""
    d, g = tmp_path / "drc.json", tmp_path / "geo.json"
    d.write_text(json.dumps(DRC))
    g.write_text(json.dumps(GEO))

    def go(*opts):
        monkeypatch.setattr(sys, "argv", ["findings.py", str(d), str(g), *opts])
        findings.main()
        return capsys.readouterr().out
    return go


@pytest.mark.parametrize("desc, ref, pad, net", [
    ("Pad 3 [GND] of U19 on F.Cu", "U19", "3", "GND"),
    ("PTH pad SH [GND] of J3", "J3", "SH", "GND"),
    ("Track [/SDA] on F.Cu, length 1.0000 mm", None, None, "/SDA"),
    ("Zone 'top of U1' [GND] on In1.Cu, priority 0", None, None, "GND"),
    ("Footprint U19", "U19", None, None),
    ("Footprint text of R35 (R35)", "R35", None, None),
    ("Circle [<no net>] of U202 on F.Cu", "U202", None, None),
])
def test_item_description(desc, ref, pad, net):
    f = findings.parse({"src": "drc", "items": [{"d": desc}]})
    assert (f["items"][0]["ref"], f["items"][0]["pad"], f["items"][0]["net"]) == (ref, pad, net)


def test_filters_combine_and_a_geometry_finding_has_no_ref(run):
    rows = json.loads(run("--ref", "U19", "--json"))
    assert [(f["src"], f["type"]) for f in rows] == [("drc", "clearance"), ("drc", "silk_overlap"),
                                                     ("unconnected", "unconnected_items")]
    assert [f["src"] for f in json.loads(run("--net", "GND", "--near", "10", "10", "1.5", "--json"))] == ["drc", "unconnected", "geo"]
    assert run("--net", "/SCL", "--box", "60", "60", "40", "40", "--type", "clearance,jog").splitlines()[0] == "findings: 1 of 5"
    assert "U19.3 GND (10.000, 10.000) ~ - /SDA (10.200, 10.000)" in run("--type", "clearance")


def test_by_counts_each_ref_or_net_once_per_finding(run):
    assert json.loads(run("--by", "ref", "--json")) == {"-": 4, "U19": 3, "R5": 1, "J3": 1}
    assert json.loads(run("--by", "net", "--json")) == {"GND": 5, "/SCL": 1, "/SDA": 1, "-": 1}
    assert json.loads(run("--type", "clearance", "--by", "type", "--json")) == {"clearance": 2}
