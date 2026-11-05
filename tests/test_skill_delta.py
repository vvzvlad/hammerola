"""`skill/scripts/delta.py`: what a layout agent is told after each batch of board edits.

Pinned here:

  * an unconnected end is one finding whichever pad or track of its net kicad-cli names for it: on an unchanged
    board it names a different one on each run, and a diff that follows the name reports false gone/new pairs;
  * a uuid that two findings share does not make them one on its own: every item must still lie within the
    distance limit (one board-edge segment against two different tracks is two findings);
  * the stop rule: three batches without a new low of the count print STOP, and a count of 0 never does;
  * a state file kept for another board is refused and left as it was.

The script is stdlib-only and is loaded from `skill/scripts/` by path; nothing here needs KiCad.
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location("skill_delta", ROOT / "skill" / "scripts" / "delta.py")
delta = importlib.util.module_from_spec(_SPEC)
# no skill/scripts/__pycache__: the hub packs and digests every file under skill/
_bytecode, sys.dont_write_bytecode = sys.dont_write_bytecode, True
_SPEC.loader.exec_module(delta)
sys.dont_write_bytecode = _bytecode


def item(desc, x, y, uuid):
    return {"description": desc, "pos": {"x": x, "y": y}, "uuid": uuid}


def report(violations=(), unconnected=(), source="board.kicad_pcb"):
    return {"source": source, "date": "2026-11-05T00:00:00", "violations": list(violations),
            "unconnected_items": list(unconnected)}


def errors(n):
    return [{"type": "clearance", "severity": "error", "description": "Clearance violation",
             "items": [item("Track [N%d] on F.Cu, length 1.0000 mm" % k, k, 0, "t%d" % k),
                       item("Via [GND] on F.Cu - B.Cu", k, 1, "v%d" % k)]} for k in range(n)]


def edge(track_x, track_uuid):
    return {"type": "copper_edge_clearance", "severity": "error", "description": "Board edge clearance violation",
            "items": [item("Segment on Edge.Cuts", 50.0, 68.0, "edge-1"),
                      item("Track [/CAN_RXD] on F.Cu, length 2.0000 mm", track_x, 68.2, track_uuid)]}


@pytest.fixture
def run(tmp_path, capsys, monkeypatch):
    """One delta.py run on a report and gate findings; returns its stdout. The state file persists across calls."""
    state = tmp_path / "state.json"

    def go(rep, geo=()):
        d, g = tmp_path / "drc.json", tmp_path / "geo.json"
        d.write_text(json.dumps(rep))
        g.write_text(json.dumps(list(geo)))
        monkeypatch.setattr(sys, "argv", ["delta.py", str(d), str(g), str(state)])
        delta.main()
        return capsys.readouterr().out

    go.state = state
    return go


def first_line(out):
    return out.splitlines()[0]


def test_unconnected_end_named_by_another_item_is_unchanged(run):
    pad = item("Pad 2 [/mcu/LED_DATA_A] of D603", 10.0, 10.0, "pad-2")
    far = item("Track [/mcu/LED_DATA_A] on F.Cu, length 3.0000 mm", 20.0, 10.0, "track-1")
    near = item("Track [/mcu/LED_DATA_A] on F.Cu, length 2.2250 mm", 12.2, 10.0, "track-2")
    run(report(unconnected=[{"type": "unconnected_items", "severity": "error", "description": "Missing connection",
                             "items": [pad, far]}]))
    out = run(report(unconnected=[{"type": "unconnected_items", "severity": "error", "description": "Missing connection",
                                   "items": [near, far]}]))
    assert "0 new, 0 gone, 1 unchanged" in first_line(out)
    assert "unconnected by net 1" in first_line(out)


def test_shared_uuid_beyond_the_distance_limit_is_a_new_finding(run):
    run(report([edge(10.0, "track-a")]))
    assert "1 new, 1 gone, 0 unchanged" in first_line(run(report([edge(85.0, "track-b")])))


def test_kept_uuid_and_position_matches_are_counted_apart(run):
    run(report([edge(10.0, "track-a")]))
    assert "one uuid kept 1, by position 0" in first_line(run(report([edge(10.5, "track-b")])))
    moved = edge(10.5, "track-c")
    moved["items"][0]["uuid"] = "edge-2"
    assert "one uuid kept 0, by position 1" in first_line(run(report([moved])))


@pytest.mark.parametrize("counts, stop_runs", [
    ([10, 12, 11, 10], [4]),
    ([10, 8, 9, 9, 9], [5]),
    ([3, 3, 3, 3], [4]),
    ([5, 0, 0, 0, 0], []),
])
def test_stop_rule(run, counts, stop_runs):
    lines = [[l for l in run(report(errors(c))).splitlines() if l.startswith("stop rule:")][0] for c in counts]
    assert [k + 1 for k, l in enumerate(lines) if "STOP" in l] == stop_runs
    for c, l in zip(counts, lines):
        assert ("nothing is open" in l) == (c == 0)


def test_state_of_another_board_is_refused(run):
    run(report(errors(2), source="dionis.kicad_pcb"))
    kept = run.state.read_text()
    with pytest.raises(SystemExit) as e:
        run(report(errors(1), source="ukuetis_panel.kicad_pcb"))
    assert "ukuetis_panel.kicad_pcb" in str(e.value) and "dionis.kicad_pcb" in str(e.value)
    assert run.state.read_text() == kept
