"""`skill/scripts/sch.py`: the schematic review helper, ported from Wiren Board's kicad_review.py.

Pinned here, on a hand-written KiCad 10 project (tests/fixtures/sch/rev1: a root that holds only sheets, a power sheet,
one channel sheet placed twice as ch1 and ch2) and its second revision (rev2: R3 renumbered R4, VIN_SENSE renamed
BAT_SENSE, C2 added):

  * texts and around read every sheet reachable from the root; a note is matched to the parts of its own sheet
    placement, and a sheet placed twice gets each placement's references from (instances);
  * diff of two directories takes the root named like the .kicad_pro, else the sheet no other sheet places;
  * rails counts a net by its name without the sheet path, by a power: symbol on it, by the pins on it; VBUS, VIN,
    VBAT, VSYS only as whole names; a name ending in a signal word (3V3_EN, POWER_GOOD) is no rail; a --rail that
    names no single net ends the run;
  * a net is found by its name without the sheet path before a substring other nets share;
  * a D whose value or library part says LED is a load, not a path; a TP is a test point, not a feeding connector;
    a K (relay coil) is a load and a JP (jumper) a series element, neither a connector;
  * KiCad 10 writes a pin name as NAME_NUMBER, the number is cut off;
  * the netlist is exported once and reused until a sheet changes; --variant reaches kicad-cli.

The script is stdlib-only and is loaded from `skill/scripts/` by path. kicad-cli is never run: a command that needs
the netlist of a .kicad_sch finds the committed kicadxml export already in its cache; the relay board is a kicadxml
netlist its fixture writes.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location("skill_sch", ROOT / "skill" / "scripts" / "sch.py")
sch = importlib.util.module_from_spec(_SPEC)
# no skill/scripts/__pycache__: the hub packs and digests every file under skill/
_bytecode, sys.dont_write_bytecode = sys.dont_write_bytecode, True
_SPEC.loader.exec_module(sch)
sys.dont_write_bytecode = _bytecode

FX = ROOT / "tests" / "fixtures" / "sch"
REV1, REV2 = FX / "rev1", FX / "rev2"
SCH1, SCH2 = REV1 / "fixture_board.kicad_sch", REV2 / "fixture_board.kicad_sch"
XML1, XML2 = REV1 / "fixture_board.xml", REV2 / "fixture_board.xml"
NOTE = "Pull-up for the channel output.\nKeep it at 4k7."


@pytest.fixture
def run(capsys, monkeypatch, tmp_path):
    """One sch.py run; returns stdout, or the parsed JSON when --json is among the arguments. The cache lives in
    tmp_path, seeded with the committed netlists of both revisions, and kicad-cli must not be called."""
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    for sch_file, xml in ((SCH1, XML1), (SCH2, XML2)):
        cache = Path(sch.cache_file(str(sch_file)))
        cache.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(xml, cache)
        os.utime(cache, (2e9, 2e9))  # newer than any checkout of the sheets
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: pytest.fail("kicad-cli called: %s" % (a,)))

    def go(*args):
        monkeypatch.setattr(sys, "argv", ["sch.py", *map(str, args)])
        sch.main()
        out = capsys.readouterr().out
        return json.loads(out) if "--json" in args else out
    return go


def rails_by_name(res):
    return {r["name"]: r for r in res["rails"]}


@pytest.mark.parametrize("fn, pin, name", [("VIN_2", "2", "VIN"), ("Pin_1_1", "1", "Pin_1"), ("A_2", "2", "A"),
                                           ("VDD_3", "2", "VDD_3"), (None, "1", "")])
def test_a_kicad10_pin_name_loses_its_number(fn, pin, name):
    nd = {"pin": pin, **({"pinfunction": fn} if fn else {})}
    assert sch.pin_name(nd) == name


def test_parts_and_nets_come_from_the_netlist_with_their_sheet(run):
    out = run("parts", XML1)
    assert out.splitlines()[-1] == "# 13 parts"
    assert "R11    4k7" in out and out.split("R11 ", 1)[1].splitlines()[0].endswith("/ch1/")
    parts = {p["ref"]: p for p in run("parts", XML1, "--json")["parts"]}
    assert (parts["R21"]["sheet"], parts["D1"]["lib"], parts["TP1"]["value"]) == ("/ch2/", "Device:LED", "AVDD")
    assert run("nets", XML1, "--json")["nets"][:2] == [dict(name="GND", nodes=7), dict(name="+3V3", nodes=6)]
    assert run("nets", SCH1).splitlines()[-1] == "# 8 nets"


def test_a_net_is_found_exactly_then_by_case_then_by_a_substring_only_it_has(run):
    assert run("net", XML1, "gnd", "--json")["name"] == "GND"
    avdd = run("net", XML1, "vdd", "--json")
    assert avdd == dict(cmd="net", name="/power/AVDD", nodes=[dict(ref="L1", pin="2", name="2"), dict(ref="TP1", pin="1", name="1")])
    assert run("net", XML1, "LED_K").splitlines() == ["/power/LED_K  (2 nodes)", "  D1     pin 1      K", "  R1     pin 1"]
    with pytest.raises(SystemExit, match="no net OUT; candidates: /ch1/OUT, /ch2/OUT"):
        run("net", XML1, "OUT")


def test_texts_reads_every_sheet_and_matches_a_note_to_its_own_placement(run):
    # the root holds sheets only, as the owner's roots do
    assert [(s["path"], s["sym"], s["notes"]) for s in sch.sheets(str(SCH1))][0] == ("/", {}, [])
    notes = run("texts", SCH1, "--json")["notes"]
    assert [(n["sheet"], n["text"]) for n in notes] == [
        ("/power/", "LDO input comes straight from the battery connector."), ("/ch1/", NOTE), ("/ch2/", NOTE)]
    # TP1 lies at the channel note's very point, but on the power sheet
    assert [n["near"][0] for n in notes] == [dict(ref="U1", dist=12.7), dict(ref="R11", dist=12.7), dict(ref="R21", dist=12.7)]
    assert all("TP1" not in [x["ref"] for x in n["near"]] for n in notes[1:])
    out = run("texts", SCH1)
    assert "[  1] /ch1/ text     (50.8,50.8)        near: R11(12.7mm), C11(22.7mm)\n" \
           "      Pull-up for the channel output.\n      Keep it at 4k7.\n" in out
    assert out.splitlines()[-1] == "# 3 text notes"


def test_a_sheet_placed_twice_gets_each_placements_references():
    assert '(property "Reference" "R21"' in (REV1 / "ch.kicad_sch").read_text()  # KiCad keeps the last placement's
    placed = {s["path"]: sorted(s["sym"]) for s in sch.sheets(str(SCH1))}
    assert placed == {"/": [], "/power/": ["C1", "D1", "J1", "L1", "R1", "R2", "R3", "TP1", "U1"],
                      "/ch1/": ["C11", "R11"], "/ch2/": ["C21", "R21"]}


def test_around_lists_pins_nets_and_the_notes_of_the_parts_own_sheet(run):
    r11, tp1 = run("around", SCH1, "R11", "TP1", "--json")["parts"]
    assert r11["pins"] == [dict(pin="1", net="+3V3", name=""), dict(pin="2", net="/ch1/OUT", name="")]
    assert r11["nets"][1] == dict(name="/ch1/OUT", nodes=2, members=["C11.1", "R11.2"])
    assert r11["notes"] == [dict(dist=12.7, sheet="/ch1/", text=NOTE)]
    # the channel notes lie 0 mm from TP1 on other sheets; the power sheet's own note is 38.1 mm off
    assert tp1["notes"] == [dict(dist=38.1, sheet="/power/", text="LDO input comes straight from the battery connector.")]
    out = run("around", SCH1, "R21")
    assert out.splitlines()[:3] == ["===== R21  4k7  Resistor_SMD:R_0603_1608Metric  (Device:R)  /ch2/ =====",
                                    "  pins -> nets:", "    pin 1      -> +3V3"]
    assert "    [ 12.7mm] Pull-up for the channel output. / Keep it at 4k7." in out
    with pytest.raises(SystemExit, match="no part R99"):
        run("around", SCH1, "R99")


@pytest.mark.parametrize("args, msg", [(("parts", "b.kicad_pcb"), "is a board"), (("texts", XML1), "is a netlist"),
                                       (("around", XML1, "R1"), "is a netlist"), (("nets", "b.txt"), "not a .kicad_sch")])
def test_what_is_not_a_schematic_is_refused(run, args, msg):
    with pytest.raises(SystemExit, match=msg):
        run(*args)


def test_the_netlist_is_exported_once_until_a_sheet_changes_and_carries_the_variant(tmp_path, monkeypatch):
    proj = tmp_path / "proj"
    shutil.copytree(REV1, proj)
    root = str(proj / "fixture_board.kicad_sch")
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    monkeypatch.setattr(sch, "KICAD_CLI_APP", str(tmp_path / "no-kicad-app"))
    calls = []

    def fake(cmd, **kw):
        calls.append(cmd)
        shutil.copy(XML1, cmd[cmd.index("-o") + 1])
        return subprocess.CompletedProcess(cmd, 0, b"", b"")
    monkeypatch.setattr(subprocess, "run", fake)
    cache = sch.cache_file(root, "lite")
    assert cache != sch.cache_file(root)
    assert sch.netlist(root, "lite").find("components") is not None
    sch.netlist(root, "lite")
    assert calls == [["kicad-cli", "sch", "export", "netlist", "--format", "kicadxml", "-o", cache, "--variant", "lite", root]]
    future = os.path.getmtime(cache) + 60
    os.utime(proj / "ch.kicad_sch", (future, future))
    sch.netlist(root, "lite")
    assert len(calls) == 2


@pytest.mark.parametrize("net, rail", [("+V_BUS", True), ("/dac_amp/AVDD", True), ("PVDD", True), ("GVDD_AB", True),
                                       ("/meter/VDDISO", True), ("/can/+12V_CAN", True), ("VBUS", True), ("V_BUS", True),
                                       ("VIN", True), ("VBAT", True), ("VSYS", True), ("VCC_IO", True),
                                       ("/mcu/VBUS_SENSE", False), ("/power/LED_PVDD_A", False), ("/a2b/AD_VIN", False),
                                       ("+5V_ISO", True), ("PWR_5V", True), ("3V3_EN", False), ("5V_PG", False),
                                       ("PWR_EN", False), ("POWER_GOOD", False), ("PWRGD", False), ("PWROK", False),
                                       ("PWR_LED", False), ("POWER_FAIL", False), ("5V_FAULT", False), ("3V3-EN", False),
                                       ("PWR_INT", False), ("PWR", True), ("POWER_IN", True), ("PWR_IN_12V", True)])
def test_a_rail_name_is_matched_without_its_sheet_path(net, rail):
    assert bool(sch.RAIL_NAME_RE.match(sch.bare(net))) is rail


def test_rails_by_bare_name_by_power_symbol_and_by_pins(run):
    res = run("rails", SCH1, "--json")
    assert res["grounds"] == ["GND"]
    assert [(r["name"], r["how"]) for r in res["rails"]] == [
        ("BAT_RAW", "power-symbol"), ("+3V3", "power-symbol"), ("/power/AVDD", "name")]
    # kicadxml leaves power symbols out: from the netlist alone BAT_RAW is a rail by U1's VIN pin
    assert {r["name"]: r["how"] for r in run("rails", XML1, "--json")["rails"]} == {
        "BAT_RAW": "implicit", "+3V3": "name", "/power/AVDD": "name"}
    bat = rails_by_name(res)["BAT_RAW"]
    assert (bat["connectors"], bat["sinks"]) == (["J1.Pin_1"], ["U1.VIN"])
    assert bat["resistors"] == [dict(ref="R2", pin="1", far="/power/VIN_SENSE", members=["R3.1"])]
    assert rails_by_name(run("rails", SCH1, "--rail", "LED_K", "--json"))["/power/LED_K"]["how"] == "user"
    with pytest.raises(SystemExit, match="no net NOPE$"):
        run("rails", SCH1, "--rail", "NOPE")
    with pytest.raises(SystemExit, match="no net OUT; candidates: /ch1/OUT, /ch2/OUT$"):
        run("rails", SCH1, "--rail", "OUT")


def test_an_led_named_d_is_a_load_and_a_test_point_feeds_nothing(run):
    res = run("rails", SCH1, "--json")
    rails = rails_by_name(res)
    assert rails["+3V3"]["leds"] == ["D1.A"] and "/power/LED_K" not in rails
    assert (rails["/power/AVDD"]["testpoints"], rails["/power/AVDD"]["connectors"]) == (["TP1"], [])
    # AVDD has only TP1 on it: as a connector it would count as fed, and L1 would stay an undirected series link
    assert res["edges"] == [{"from": "+3V3", "to": "/power/AVDD", "via": "L1", "kind": "feed"},
                            {"from": "BAT_RAW", "to": "+3V3", "via": "U1", "kind": "regulator"}]
    part = lambda value, lib: dict(value=value, lib=lib)
    assert [sch.part_kind("D1", part("RED", "Device:LED")), sch.part_kind("D2", part("LED_GREEN", "Diode:X")),
            sch.part_kind("D3", part("SS34", "Device:D_Schottky")), sch.part_kind("TP1")] == ["led", "led", "path", "testpoint"]


@pytest.fixture
def relay_board(tmp_path):
    """A kicadxml netlist of a relay coil and a jumper on +12V from J1, the coil switched by Q1 on /relay/COIL."""
    parts = {"J1": ("PWR", "Connector_Generic:Conn_01x02"), "K1": ("G5V-1", "Relay:G5V-1"),
             "Q1": ("AO3400A", "Transistor_FET:AO3400A"), "R5": ("100k", "Device:R"),
             "JP1": ("Jumper_2_Open", "Jumper:Jumper_2_Open"), "C5": ("10u", "Device:C")}
    nets = {"+12V": [("J1", "1", "Pin_1"), ("K1", "1", ""), ("JP1", "1", "A")],
            "/relay/COIL": [("K1", "2", ""), ("Q1", "3", "D")],
            "/relay/COIL_DRV": [("Q1", "1", "G"), ("R5", "1", "")],
            "Net-(JP1-B)": [("JP1", "2", "B"), ("C5", "1", "")],
            "GND": [("J1", "2", "Pin_2"), ("Q1", "2", "S"), ("R5", "2", ""), ("C5", "2", "")]}
    comps = "".join('<comp ref="%s"><value>%s</value><libsource lib="%s" part="%s"/><sheetpath names="/"/></comp>'
                    % (ref, value, *lib.split(":")) for ref, (value, lib) in parts.items())
    node = lambda r, p, fn: '<node ref="%s" pin="%s"%s/>' % (r, p, ' pinfunction="%s_%s"' % (fn, p) if fn else "")
    xml = tmp_path / "relay.xml"
    xml.write_text('<export version="E"><components>%s</components><nets>%s</nets></export>' % (
        comps, "".join('<net name="%s">%s</net>' % (n, "".join(node(*t) for t in m)) for n, m in nets.items())))
    return xml


def test_a_relay_coil_is_a_load_and_a_jumper_a_series_element(run, relay_board):
    res = run("rails", relay_board, "--json")
    assert [(r["name"], r["how"]) for r in res["rails"]] == [("+12V", "name"), ("Net-(JP1-B)", "via JP1")]
    rail = rails_by_name(res)["+12V"]
    assert (rail["connectors"], rail["other"], rail["passives"]) == (["J1.Pin_1"], ["K1.1"], {"JP": ["JP1"]})
    assert res["edges"] == [{"from": "+12V", "to": "Net-(JP1-B)", "via": "JP1", "kind": "feed"}]
    assert "| K1 [G5V-1] (1) — pin not classified, check | +12V | — | — | — |" in run("rails", relay_board, "--md")


def test_a_net_is_found_by_its_name_without_the_sheet_path_before_a_substring(run, relay_board):
    assert run("net", relay_board, "COIL", "--json")["name"] == "/relay/COIL"  # /relay/COIL_DRV has COIL in it too


def test_rails_text_and_markdown(run):
    out = run("rails", SCH1)
    assert "\n== /power/AVDD  [name]\n   fed by  : +3V3 → via L1 (feed)\n   passives: L×1 (L1)\n   test points: TP1\n" in out
    assert "   LEDs    : D1 [RED].A\n" in out
    md = run("rails", SCH1, "--md")
    assert "| D1 [RED] (A) | +3V3 | — | — | — |" in md
    assert "| **/power/AVDD** | L1 [BLM18] ← +3V3 | — / — | — | — |" in md
    assert "| U1 [LDO-3V3] (BAT_RAW → +3V3) | — | — | — | — |" in md


def test_a_project_directorys_root_is_named_like_its_project_else_placed_by_no_sheet(tmp_path):
    sheets = sorted(str(p) for p in REV1.glob("*.kicad_sch"))
    assert min(sheets, key=len).endswith("ch.kicad_sch")  # the shortest name, which a length rule would take
    assert sch.project_root(str(REV1)) == str(SCH1)
    for p in sheets:
        shutil.copy(p, tmp_path)
    assert sch.project_root(str(tmp_path)) == str(tmp_path / "fixture_board.kicad_sch")


def test_diff_matches_a_renumbered_part_and_compares_nets_by_members(run):
    res = run("diff", REV1, REV2, "--json")
    assert (res["old"], res["new"]) == (str(SCH1), str(SCH2))
    assert res["parts"] == dict(old=13, new=14, added=[dict(ref="C2", value="100n", footprint="Capacitor_SMD:C_0603_1608Metric")],
                                removed=[], changed=[],
                                renamed=[dict(old="R3", ref="R4", value="10k", footprint="Resistor_SMD:R_0603_1608Metric")])
    assert res["nets"] == dict(old=8, new=8, added=["/power/BAT_SENSE"], removed=["/power/VIN_SENSE"],
                               changed=[dict(name="+3V3", gained=["C2.1"], lost=[])], added_auto=[], removed_auto=[],
                               renumbered_auto=0)
    assert {**run("diff", XML1, XML2, "--json"), "old": None, "new": None} == {**res, "old": None, "new": None}
    out = run("diff", REV1, REV2)
    assert "\n  = R3 -> R4     10k " in out and "\n  + C2     100n " in out
    assert "\n### New nets (named) (1): /power/BAT_SENSE\n### Removed nets (named) (1): /power/VIN_SENSE\n" in out
    assert "\n  ~ +3V3: +[C2.1] -[]\n" in out
