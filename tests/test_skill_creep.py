"""`skill/scripts/creep.py`: air gap and creepage between two isolation groups on a `dump.py` board JSON.

Pinned here, on hand-written boards of a 40 x 40 mm outline whose holes are the cut-outs:

  * a cut-out across the straight line makes the creepage the path around its end, and that path starts and ends
    where going around is shortest, not at the air gap's ends;
  * where the air gap's line meets a cut-out but a straight line past the cut-out's end is as short, the creepage is
    that line;
  * copper on F.Cu over copper on B.Cu shares no layer, and only the plan view sees it;
  * a distance below its limit by any amount is a violation and exits 1; one equal to it is not; creepage is not
    computed above both --near and --creep;
  * class:Default holds the nets in no other class, as KiCad 10 names every net's classes "X,Default".

The script needs shapely (requirements-dev.txt) and is loaded from `skill/scripts/` by path; nothing here needs KiCad.
"""

import importlib.util
import json
import math
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location("skill_creep", ROOT / "skill" / "scripts" / "creep.py")
creep = importlib.util.module_from_spec(_SPEC)
# no skill/scripts/__pycache__: the hub packs and digests every file under skill/
_bytecode, sys.dont_write_bytecode = sys.dont_write_bytecode, True
_SPEC.loader.exec_module(creep)
sys.dont_write_bytecode = _bytecode


def rect(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def pad(ref, net, box, layer="F.Cu"):
    return {"ref": ref, "pads": [{"num": "1", "net": net, "pos": [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2],
                                  "attr": 1, "drill": [0, 0], "layers": [layer],
                                  "poly": {layer: [{"outer": rect(*box), "holes": []}]}}]}


def zone(name, net, box, layer="F.Cu"):
    return {"name": name, "net": net, "rule_area": False, "uuid": name, "fill": {layer: [{"outer": rect(*box), "holes": []}]}}


def board(fps, zones=(), tracks=(), holes=()):
    return {"fps": fps, "tracks": list(tracks), "vias": [], "zones": list(zones), "copper": ["F.Cu", "B.Cu"],
            "netclass": {"HV": "HV,Default", "LV": "Default"},
            "outline": [{"outer": rect(0, 0, 40, 40), "holes": [rect(*h) for h in holes]}]}


# HV pad under, LV fill over, 6 mm apart across y = 17..23
HV, LV = pad("J1", "HV", (19, 15, 21, 17)), zone("LV_FILL", "LV", (19, 23, 21, 25))


@pytest.fixture
def run(tmp_path, capsys):
    """creep.py on a board with the given options: (exit status, JSON report)."""
    def go(D, *opts):
        f = tmp_path / "board.json"
        f.write_text(json.dumps(D))
        code = creep.main([str(f), "class:HV", "class:Default", "--json", *opts])
        return code, json.loads(capsys.readouterr().out)
    return go


def test_a_cut_out_across_the_line_sends_the_path_around_its_end(run):
    code, res = run(board([HV], [LV], holes=[(10, 19, 30, 21)]), "--air", "6", "--creep", "20.43")
    assert (code, res["nets_a"], res["nets_b"], res["cutouts"]) == (0, ["HV"], ["LV"], 1)
    f, plan = res["rows"]
    assert [r["layer"] for r in res["rows"]] == ["F.Cu", "plan"] and f["violations"] == []
    assert f["air"]["dist"] == 6 and (f["air"]["a"]["name"], f["air"]["b"]["name"]) == ("J1.1", "LV_FILL")
    # from a corner of the pad to the cut-out's end, along it, to a corner of the fill: from the air gap's ends it
    # would be 2 * sqrt(104) + 2 = 22.396
    assert f["creep"]["dist"] == pytest.approx(2 * math.sqrt(85) + 2, abs=1e-4)
    p = f["creep"]["path"]
    assert p in ([[21, 17], [30, 19], [30, 21], [21, 23]], [[19, 17], [10, 19], [10, 21], [19, 23]])
    assert plan["creep"]["dist"] == f["creep"]["dist"]
    code, res = run(board([HV], [LV], holes=[(10, 19, 30, 21)]), "--air", "6", "--creep", "20.44")
    assert code == 1 and [r["violations"] for r in res["rows"]] == [["creep"], ["creep"]]


def test_a_straight_line_past_the_cut_out_is_the_creepage(run):
    code, res = run(board([HV], [LV], holes=[(10, 19, 19.8, 21)]), "--creep", "6")
    f = res["rows"][0]
    # shapely's pick among the equal air lines is one through the cut-out, so the line past its end is searched for
    assert f["air"]["a"]["at"][0] < 19.8
    assert code == 0 and f["creep"]["dist"] == pytest.approx(6, abs=1e-6) == f["air"]["dist"]
    (x0, y0), (x1, y1) = f["creep"]["path"]
    assert x0 == pytest.approx(x1) and x0 >= 19.8 - 1e-6 and (y0, y1) == pytest.approx((17, 23))


def test_copper_over_copper_on_the_other_side_is_seen_in_plan_view_only(run):
    track = {"a": [10, 24], "b": [30, 24], "w": 0.5, "layer": "F.Cu", "net": "HV", "uuid": "t1"}
    code, res = run(board([], [zone("LV_B", "LV", (19, 23, 21, 25), "B.Cu")], [track]), "--air", "0.1")
    assert code == 1 and [r["layer"] for r in res["rows"]] == ["plan"]
    assert res["rows"][0]["air"]["dist"] == 0 and res["rows"][0]["violations"] == ["air"]
    assert (res["rows"][0]["air"]["a"]["kind"], res["rows"][0]["air"]["b"]["layer"]) == ("track", "B.Cu")


def test_creepage_is_left_out_only_above_both_near_and_the_limit(run):
    D = board([HV], [LV], holes=[(10, 19, 30, 21)])
    assert run(D, "--near", "5")[1]["rows"][0]["creep"] is None
    assert run(D, "--near", "5", "--creep", "7")[1]["rows"][0]["creep"]["dist"] > 20
