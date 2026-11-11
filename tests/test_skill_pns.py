"""`skill/scripts/pns_mcp.py` and `pns_bridge.py`: the MCP server an agent drives KiCad's interactive router
through, and the bridge it speaks to inside the container.

Pinned here:

  * the MCP handshake and the exact tool set an agent sees;
  * a tool call goes to the bridge in the container: open_board copies the board with its project and rules
    in; save copies the result out into a new directory, with the board's rules, and never to a path the
    caller names;
  * a bridge that dies (the engine can segfault) fails the call that killed it and every call after it, and
    the next open_board starts a fresh container;
  * the bridge's bookkeeping of the open route: a point where the head already is fixes nothing and is not
    counted for undo_segment, and checkpoints are taken only between routes.

A fake `docker` on PATH runs a fake bridge as the container's main process and maps container paths under
a directory of the test; the bridge itself runs in-process on a fake `kicad_rl_router`. Nothing here needs
docker or KiCad.
"""

import importlib.util
import itertools
import json
import os
import select
import subprocess
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skill" / "scripts"
SERVER = SCRIPTS / "pns_mcp.py"
TOOLS = {"open_board", "get_net", "query_area", "start_route", "line_to", "finish", "cancel_route",
         "undo_segment", "delete", "delete_net_routing", "drag", "drc", "checkpoint", "restore", "save"}

FAKE_DOCKER = r'''
import json, os, shutil, sys
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "container")
args = sys.argv[1:]
with open(os.path.join(HERE, "..", "docker.log"), "a") as log:
    log.write(json.dumps(args) + "\n")

def local(p):
    return os.path.join(ROOT, p.split(":", 1)[1].lstrip("/")) if ":" in p else p

if args[0] == "rm":
    shutil.rmtree(os.path.join(ROOT, "work"), ignore_errors=True)
if args[0] == "start":
    os.execv(sys.executable, [sys.executable, os.path.join(HERE, "bridge.py"), ROOT])
if args[0] == "cp":
    src, dst = local(args[-2]), local(args[-1])
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    (shutil.copytree if os.path.isdir(src) else shutil.copyfile)(src, dst)
'''

FAKE_BRIDGE = r'''
import json, os, sys
root, stem = sys.argv[1], None
for line in sys.stdin:
    req = json.loads(line)
    tool, args = req["tool"], req["args"]
    if tool == "drc":
        sys.exit(3)
    if tool == "open_board":
        stem = os.path.basename(args["path"])[:-len(".kicad_pcb")]
        folder = os.path.join(root, os.path.dirname(args["path"]).lstrip("/"))
        reply = {"opened": args["path"], "files": sorted(os.listdir(folder))}
    elif tool == "save":
        os.makedirs(os.path.join(root, "work/out9"), exist_ok=True)
        files = ["/work/out9/%s.kicad_pcb" % stem, "/work/out9/%s.kicad_pro" % stem]
        for f in files:
            open(os.path.join(root, f.lstrip("/")), "w").write("saved " + f)
        reply = {"files": files, "routing": False}
    else:
        reply = {"tool": tool, "args": args}
    print(json.dumps(reply), flush=True)
'''


def seg(a, b):
    return types.SimpleNamespace(x1_mm=a[0], y1_mm=a[1], x2_mm=b[0], y2_mm=b[1], width_mm=0.2, layer=0)


def pad(x, y, layer):
    return types.SimpleNamespace(net_name="N", net_code=1, layer=layer, x_mm=x, y_mm=y, width_mm=1, height_mm=1)


class FakeRouter:
    """What of KiCad's line placer the bridge's bookkeeping leans on, as the engine behaves: the head is a
    line from the route's start to the last move, of no length when the move went to the start; a fix
    clears the head and, unless the line has no length, adds a stage to the fixed tail and moves the start
    to the head; undo pops a stage, keeping the first as FIXED_TAIL::PopStage does, and leaves the head's
    end where it was; a forced fix commits the route, with a via when one is being placed."""

    def __init__(self, path):
        self.routing = self.placing_via = False
        self.pads, self.committed = [pad(-9, -9, -2)], None

    def start_route(self, x, y, layer):
        self.routing, self.start, self.end, self.layer, self.tail = True, (x, y), (x, y), layer, [(x, y)]
        self.line = self.placing_via = False
        return True

    def move(self, x, y):
        self.end, self.line = (x, y), True
        return True

    def get_wip_segments(self):
        return [seg(self.start, self.end)] if self.line else []

    def fix_route(self, x, y, force_finish, require_via=False):
        if force_finish:
            self.routing, self.committed = False, {"via": self.placing_via}
            return True
        if self.end != self.start:
            self.tail.append(self.start)
            self.start, self.placing_via = self.end, False
        self.line = False
        return False   # a waypoint, not the end of the route

    def undo_last_segment(self):
        self.start, self.line = self.tail.pop() if len(self.tail) > 1 else self.tail[0], False
        return None   # UnfixRoute answers with the head's first point, and the fix has cleared the head

    def set_via_placement(self, on):
        self.placing_via = on

    def switch_layer(self, layer):
        self.layer = layer
        return True

    def get_route_head(self):
        return self.end + (self.layer,)

    def cancel_route(self):
        self.routing = False

    def checkpoint(self):
        return 1 << 40

    def get_tracks(self):
        return []

    get_vias = get_tracks
    get_pads = lambda self: self.pads
    finish = lambda self: False
    get_unrouted_count = lambda self: 0
    is_routing = lambda self: self.routing
    get_current_layer = lambda self: self.layer
    get_copper_layer_count = lambda self: 2
    get_current_net_code = lambda self: 1
    get_route_sizes = lambda self: (0.2, 0.6, 0.3, 0.2)
    get_routing_target = lambda self: (0.0, 0.0, -1.0)
    get_failure_reason = lambda self: ""
    set_routing_mode = lambda self, mode: None


def load(name, **modules):
    """A skill script as a module, with `modules` in sys.modules while it imports."""
    spec = importlib.util.spec_from_file_location("skill_" + name, SCRIPTS / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    saved = {k: sys.modules.get(k) for k in modules}
    # no skill/scripts/__pycache__: the hub packs and digests every file under skill/
    bytecode, sys.dont_write_bytecode = sys.dont_write_bytecode, True
    sys.modules.update(modules)
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = bytecode
        for k, v in saved.items():
            if v is None:
                del sys.modules[k]
            else:
                sys.modules[k] = v
    return module


KRL = types.ModuleType("kicad_rl_router")
KRL.RLRouter, KRL.MODE_MARK_OBSTACLES, KRL.MODE_SHOVE, KRL.MODE_WALKAROUND = FakeRouter, 0, 1, 2
BRIDGE = load("pns_bridge", kicad_rl_router=KRL)
MCP = load("pns_mcp")


@pytest.fixture(autouse=True)
def clean_module_state():
    def clean():
        assert BRIDGE.B is None and repr(BRIDGE.DIRS) == "count(1)" and MCP.ENGINE is None
    clean()
    yield
    clean()


@pytest.fixture
def bridge(tmp_path, monkeypatch):
    """The bridge with a board open on the fake engine, its directories under the test's."""
    monkeypatch.setattr(BRIDGE, "WORK", str(tmp_path))
    monkeypatch.setattr(BRIDGE, "DIRS", itertools.count(1))
    monkeypatch.setattr(BRIDGE, "B", BRIDGE.Board(str(tmp_path / "b.kicad_pcb")))
    return BRIDGE


class Server:
    def __init__(self, tmp_path):
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        docker = bin_dir / "docker"
        docker.write_text("#!%s\n%s" % (sys.executable, FAKE_DOCKER))
        docker.chmod(0o755)
        (bin_dir / "bridge.py").write_text(FAKE_BRIDGE)
        self.log = tmp_path / "docker.log"
        self.tmp = tmp_path / "tmp"
        self.tmp.mkdir()
        env = dict(os.environ, PATH="%s%s%s" % (bin_dir, os.pathsep, os.environ["PATH"]), TMPDIR=str(self.tmp))
        self.proc = subprocess.Popen([sys.executable, "-B", str(SERVER)], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, text=True, env=env)
        self.next_id = 0

    def send(self, msg):
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def request(self, method, params=None):
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params or {}})
        ready, _, _ = select.select([self.proc.stdout], [], [], 30)
        assert ready, "no response to %s in 30 s" % method
        reply = json.loads(self.proc.stdout.readline())
        assert reply["id"] == self.next_id and reply["jsonrpc"] == "2.0"
        return reply

    def call(self, tool, **arguments):
        result = self.request("tools/call", {"name": tool, "arguments": arguments})["result"]
        return json.loads(result["content"][0]["text"]), result["isError"]

    def runs(self):
        """The containers made: `docker create` calls."""
        lines = self.log.read_text().splitlines() if self.log.exists() else []
        return [a for a in map(json.loads, lines) if a[0] == "create"]

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=30)


@pytest.fixture
def server(tmp_path):
    s = Server(tmp_path)
    yield s
    s.close()


@pytest.fixture
def board(tmp_path):
    folder = tmp_path / "project"
    folder.mkdir()
    for ext in (".kicad_pcb", ".kicad_pro", ".kicad_dru"):
        (folder / ("b" + ext)).write_text(ext)
    (folder / "b.kicad_sch").write_text("not copied")
    return folder / "b.kicad_pcb"


def test_the_handshake_and_the_tool_set(server):
    reply = server.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                          "clientInfo": {"name": "test", "version": "0"}})
    assert reply["result"]["protocolVersion"] == "2025-06-18"
    assert reply["result"]["capabilities"] == {"tools": {}}
    # a notification gets no response: the next line read is the answer to tools/list
    server.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
    tools = server.request("tools/list")["result"]["tools"]
    assert {t["name"] for t in tools} == TOOLS and len(tools) == len(TOOLS)
    assert all(t["description"] and t["inputSchema"]["type"] == "object" for t in tools)
    assert server.request("resources/list")["error"]["code"] == -32601


def test_calls_go_to_the_bridge_and_files_cross_with_docker_cp(server, board):
    reply, failed = server.call("get_net", name="GND")
    assert failed and "open_board first" in reply["error"]
    assert server.runs() == []

    reply, failed = server.call("open_board", path=str(board))
    assert not failed
    assert reply == {"opened": "/work/in1/b.kicad_pcb", "files": ["b.kicad_dru", "b.kicad_pcb", "b.kicad_pro"]}
    made = server.runs()[0]
    assert made[:3] == ["create", "-i", "--rm"] and made[-2:] == ["python3", "/opt/pns/pns_bridge.py"]

    assert server.call("line_to", points=[[1, 2]], mode="push") == (
        {"tool": "line_to", "args": {"points": [[1, 2]], "mode": "push"}}, False)


def test_save_writes_a_new_directory_with_the_rules_and_never_a_caller_path(server, board):
    server.call("open_board", path=str(board))
    reply, failed = server.call("save", path=str(board))
    assert failed and "no arguments" in reply["error"] and board.read_text() == ".kicad_pcb"

    first, failed = server.call("save")
    second, _ = server.call("save")
    out = Path(first["dir"])
    assert not failed and out.parent == server.tmp and second["dir"] != first["dir"]
    assert first["pcb"] == str(out / "b.kicad_pcb") and sorted(os.listdir(out)) == [
        "b.kicad_dru", "b.kicad_pcb", "b.kicad_pro"]
    assert (out / "b.kicad_pcb").read_text() == "saved /work/out9/b.kicad_pcb"
    assert (out / "b.kicad_dru").read_text() == ".kicad_dru"


def test_a_dead_engine_fails_its_calls_until_open_board_starts_a_new_one(server, board):
    server.call("open_board", path=str(board))
    reply, failed = server.call("drc")
    assert failed and "engine exited (code 3)" in reply["error"]
    reply, failed = server.call("get_net", name="GND")
    assert failed and "open_board starts a fresh one" in reply["error"]
    assert len(server.runs()) == 1

    reply, failed = server.call("open_board", path=str(board))
    assert not failed and len(server.runs()) == 2
    assert server.call("get_net", name="GND") == ({"tool": "get_net", "args": {"name": "GND"}}, False)


def test_a_point_where_the_head_already_is_fixes_nothing(bridge):
    bridge.start_route("N", 0, 0, "F.Cu")
    steps = bridge.line_to([[1, 0], [2, 0], [2, 0]], "push")["steps"]
    # undo goes back along the steps the engine fixed: to the start of the second one
    assert bridge.undo_segment()["head"] == [1, 0]
    assert steps[2] == {"to": [2, 0], "reached": True, "fixed": False, "skipped": "the head is already there"}

    step = bridge.line_to([[1, 0]], "push", via_at_end=True)["steps"][-1]
    assert "via" not in step and "a via needs a line" in step["reason"] and not bridge.B.r.placing_via


def test_checkpoints_are_taken_between_routes(bridge):
    bridge.start_route("N", 0, 0, "F.Cu")
    with pytest.raises(RuntimeError, match="a route is open"):
        bridge.checkpoint()
    bridge.cancel_route()
    assert bridge.checkpoint() == {"id": 1}


def test_a_last_point_on_the_nets_copper_ends_the_route(bridge):
    r = bridge.B.r
    r.pads += [pad(0, 0, 0), pad(3, 0, 2)]   # an F.Cu pad at the start, a B.Cu pad under the route
    bridge.start_route("N", 0, 0, "F.Cu")
    step = bridge.line_to([[3, 0]], "push", via_at_end=True)["steps"][-1]
    assert step["ended_on_net"] and step["via"] and r.committed == {"via": True} and not r.routing
    # a head already on the net's copper commits rather than being skipped
    bridge.start_route("N", 0, 0, "F.Cu")
    assert bridge.line_to([[0, 0]], "push")["steps"][-1]["ended_on_net"] and r.committed == {"via": False}


def test_finish_says_when_the_head_is_on_its_nets_copper_on_another_layer(bridge):
    r = bridge.B.r
    bridge.start_route("N", 0, 0, "F.Cu")
    r.pads.append(pad(0, 0, 2))
    assert "does not change layer" in bridge.finish("walk")["reason"]
    r.pads[-1].layer = 0
    assert "does not change layer" not in bridge.finish("walk")["reason"]


def test_end_commits_at_the_last_point_whatever_is_under_it(bridge):
    r = bridge.B.r
    bridge.start_route("N", 0, 0, "F.Cu")
    out = bridge.line_to([[3, 0]], "push", via_at_end=True, end=True)
    assert out["steps"][-1]["via"] and not out["routing"] and r.committed == {"via": True}
