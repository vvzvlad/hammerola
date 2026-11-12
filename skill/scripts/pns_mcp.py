"""Stdio MCP server: KiCad's interactive router (push-and-shove, walkaround, vias, diff pairs, length tuning, delete and reroute, drag, DRC) on a copy of a saved board, run in docker.
usage: python3 pns_mcp.py   (an MCP client starts it; open_board copies the saved board with its .kicad_pro and .kicad_dru into the engine, save writes the result into a new temporary directory on this machine with a copy of that .kicad_dru, so drc.sh on it checks the board's own rules, and put.py then puts that .kicad_pcb in place of the board KiCad has open; the project is never written)
needs: python3 (stdlib only), docker that runs linux/amd64 images, pns.Dockerfile, pns_engine.patch and pns_bridge.py next to this script; the first open_board builds the image (about half an hour)"""
import hashlib
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
IMAGE_FILES = ("pns.Dockerfile", "pns_engine.patch", "pns_bridge.py")
PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
MODE = {"type": "string", "enum": ["push", "walk", "mark"],
        "description": "push: shove other nets' copper aside; walk: go around it; mark: ignore it (a colliding "
                       "line is not fixed)"}
NUM = {"type": "number"}
LAYER = {"type": "string", "description": "copper layer name: F.Cu, In1.Cu, ..., B.Cu"}


def tool(name, description, properties=None, required=()):
    return {"name": name, "description": description,
            "inputSchema": {"type": "object", "properties": properties or {}, "required": list(required)}}


TOOLS = [
    tool("open_board", "Load a copy of a saved .kicad_pcb (with its .kicad_pro and .kicad_dru) into the router. "
         "Returns the board outline box [x1, y1, x2, y2], copper layers, design rules and net classes, net count "
         "and unrouted connection count. All coordinates and sizes are mm. Routing, push and drag keep the net "
         "classes and the board's .kicad_dru, as in KiCad.",
         {"path": {"type": "string", "description": "absolute path of the .kicad_pcb"}}, ["path"]),
    tool("get_net", "A net: its class sizes, pads (ref, pad, xy, layer, size), tracks [x1, y1, x2, y2, layer, "
         "width], vias [x, y, diameter, drill] and unrouted connections [x1, y1, layer1, x2, y2, layer2]. "
         "Layer *.Cu is a through pad.", {"name": {"type": "string"}}, ["name"]),
    tool("query_area", "Pads, tracks, vias and keepout areas inside a box, optionally on one copper layer.",
         {"x1": NUM, "y1": NUM, "x2": NUM, "y2": NUM, "layer": LAYER}, ["x1", "y1", "x2", "y2"]),
    tool("start_route", "Open a route of a net at (x, y) on a layer: the router snaps to the pad, track end or "
         "via there, which must be on that net. Returns the net class sizes the route uses and the nearest "
         "unconnected target. With pair, the route is a differential pair from that pad, via or free track end "
         "and the nearest one of the same kind of the coupled net, which KiCad finds by the N/P or +/- name "
         "suffix; width and gap come from the net class diff pair settings and the board's rules, and a pair "
         "that cannot start reports KiCad's reason.",
         {"net": {"type": "string"}, "x": NUM, "y": NUM, "layer": LAYER,
          "pair": {"type": "boolean", "default": False}},
         ["net", "x", "y", "layer"]),
    tool("line_to", "Move the route head through the points in turn and fix it at each, like clicks in KiCad. "
         "Each step reports the line it fixed, or that the head could not reach the point (the call stops "
         "there and the route stays at the last fixed point); a point where the head already is is skipped. "
         "A last point on copper of the routed net on the route's layer ends "
         "the route and commits it, reporting what was written to the board, other nets' copper moved by "
         "push included. via_at_end puts a via at the last point and continues on the other outer layer "
         "(from an inner layer, on F.Cu); a via_at_end on copper of the routed net on any layer (a pad, "
         "track or via; zones do not count) ends the route with that via. For a pair the points are its "
         "centre line (a step bends the pair once, by 45 degrees: turn a corner in two steps), and a step "
         "reports the tracks it fixed with their nets: KiCad's diff pair placer "
         "writes each fixed step to the board at once. A point on a pad, via or free track end of either net "
         "of the pair fits the pair onto it and its partner's and ends the route, as the cursor on a pad does "
         "in KiCad; via_at_end puts a via on each line.",
         {"points": {"type": "array", "items": {"type": "array", "items": NUM, "minItems": 2, "maxItems": 2}},
          "mode": MODE, "via_at_end": {"type": "boolean", "default": False},
          "end": {"type": "boolean", "default": False,
                  "description": "commit the route at the last point, as KiCad's End key (with via_at_end in the "
                                 "same call, a via into a zone ends the route; zones are not visible to the router)"}},
         ["points", "mode"]),
    tool("finish", "Route the head to the nearest unconnected anchor of its net and commit the route; reports "
         "what was written to the board.", {"mode": MODE}, ["mode"]),
    tool("cancel_route", "Drop the open route: nothing of it reaches the board. The steps a pair has fixed are on "
         "the board already and stay there; they are reported as kept."),
    tool("undo_segment", "Unfix the last fixed step of the open route; the head goes back to where that step began. "
         "Not for a pair: KiCad's diff pair placer cannot take a fixed step back."),
    tool("delete", "Delete the track segment or via at (x, y), optionally only on one layer.",
         {"x": NUM, "y": NUM, "kind": {"type": "string", "enum": ["track", "via"]}, "layer": LAYER},
         ["x", "y", "kind"]),
    tool("delete_net_routing", "Delete every track and via of a net.", {"net": {"type": "string"}}, ["net"]),
    tool("drag", "Drag the track or via at (x, y) to (to_x, to_y) in push mode and commit the result.",
         {"x": NUM, "y": NUM, "to_x": NUM, "to_y": NUM}, ["x", "y", "to_x", "to_y"]),
    tool("tune", "Tune the length of the routed line through (x, y) on a layer with KiCad's meander placer and "
         "commit it, as KiCad's length tuning does: meanders of the board's meander settings go anywhere on that "
         "line between its ends (pads, vias, junctions), clear of the pads and vias there, and for a pair only "
         "where both of its lines run. single tunes the net's pad-to-pad length to length mm; "
         "pair tunes the diff pair the line is part of (the longer of its two lines) to length; skew tunes this "
         "line against its partner so that this line minus the partner is length. Returns the length or skew "
         "reached, the one before, KiCad's status (tuned, too short: the meanders that fit fall short, too "
         "long: already longer) and what was written to the board.",
         {"x": NUM, "y": NUM, "layer": LAYER, "length": NUM,
          "mode": {"type": "string", "enum": ["single", "pair", "skew"]}},
         ["x", "y", "layer", "length", "mode"]),
    tool("drc", "KiCad's DRC on the committed board with its .kicad_dru (copper clearance, connectivity, track "
         "width, via and hole sizes; zones are not refilled): each violation's type, severity, position, layer, "
         "nets and items."),
    tool("checkpoint", "Remember the board between routes; returns an id for restore."),
    tool("restore", "Return the board to a checkpoint; an open route is dropped.", {"id": {"type": "integer"}},
         ["id"]),
    tool("save", "Write the board (committed copper only) with its .kicad_pro, and a copy of the .kicad_dru it "
         "was opened with, into a new directory on this machine; returns the .kicad_pcb path and the directory. "
         "put.py puts that .kicad_pcb in place of the board KiCad has open."),
]
TOOL_NAMES = {t["name"] for t in TOOLS}


class ToolError(Exception):
    pass


def docker(*args, **kw):
    return subprocess.run(("docker",) + args, **kw)


def image_tag():
    """The image is named by the bytes it is built from, so a changed patch or bridge builds anew."""
    h = hashlib.sha256()
    for name in IMAGE_FILES:
        with open(os.path.join(HERE, name), "rb") as f:
            h.update(name.encode() + b"\0" + f.read() + b"\0")
    return "kicad-pns:" + h.hexdigest()[:12]


def ensure_image(tag):
    if docker("image", "inspect", tag, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        return
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name in IMAGE_FILES:
            tar.add(os.path.join(HERE, name), arcname=name)
    # no bind mounts and the context as a tar stream: the docker daemon may run on another machine;
    # the memory cap keeps KiCad's compile from exhausting a shared host
    built = docker("build", "--force-rm", "--memory", "8g", "-t", tag, "-f", "pns.Dockerfile", "-",
                   input=buf.getvalue(), stdout=sys.stderr, stderr=sys.stderr)
    if built.returncode != 0:
        raise ToolError("docker build of %s failed (exit %d); its log is on this server's stderr"
                        % (tag, built.returncode))


class Engine:
    """One container with pns_bridge.py as its main process, spoken to over its stdin and stdout."""

    def __init__(self):
        tag = image_tag()
        ensure_image(tag)
        self.name = "pns-%d" % os.getpid()
        docker("rm", "-f", self.name, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        # created first, so that it exists for docker cp by the time start returns
        made = docker("create", "-i", "--rm", "--memory", "4g", "--name", self.name, tag,
                      "python3", "/opt/pns/pns_bridge.py", stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if made.returncode != 0:
            raise ToolError("docker create: %s" % made.stderr.decode(errors="replace").strip())
        self.proc = subprocess.Popen(["docker", "start", "-ai", self.name],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr)
        self.dirs = 0
        self.rules = None   # the .kicad_dru bytes of the board open_board loaded, for save

    def alive(self):
        return self.proc.poll() is None

    def call(self, tool, args):
        try:
            self.proc.stdin.write((json.dumps({"tool": tool, "args": args}) + "\n").encode())
            self.proc.stdin.flush()
            line = self.proc.stdout.readline()
        except (BrokenPipeError, OSError):
            line = b""
        if not line:
            raise ToolError("the engine exited (code %s) during %s; open_board starts a fresh one"
                            % (self.proc.wait(), tool))
        return json.loads(line)

    def copy_in(self, files):
        """Copies local files into a new directory of the container; returns that directory."""
        self.dirs += 1
        dest = "/work/in%d" % self.dirs
        stage = tempfile.mkdtemp(prefix="pns.")
        # docker cp keeps the mode, and mkdtemp's 0700 would shut the container's user out
        os.chmod(stage, 0o755)
        try:
            for f in files:
                shutil.copyfile(f, os.path.join(stage, os.path.basename(f)))
            self.cp(stage, "%s:%s" % (self.name, dest))
        finally:
            shutil.rmtree(stage)
        return dest

    def cp(self, src, dst):
        done = docker("cp", "-q", src, dst, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if done.returncode != 0:
            raise ToolError("docker cp %s %s: %s" % (src, dst, done.stderr.decode(errors="replace").strip()))

    def stop(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            pass
        docker("rm", "-f", self.name, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


ENGINE = None


def board_path(path):
    path = os.path.abspath(os.path.expanduser(path))
    if not path.endswith(".kicad_pcb"):
        raise ToolError("not a .kicad_pcb path: %s" % path)
    return path


def run_tool(name, args):
    global ENGINE
    if name == "open_board":
        pcb = board_path(args["path"])
        if not os.path.isfile(pcb):
            raise ToolError("no such board: %s" % pcb)
        if ENGINE is None or not ENGINE.alive():
            if ENGINE is not None:
                ENGINE.stop()
            ENGINE = None
            ENGINE = Engine()
        stem = pcb[:-len(".kicad_pcb")]
        files = [f for f in (pcb, stem + ".kicad_pro", stem + ".kicad_dru") if os.path.isfile(f)]
        dest = ENGINE.copy_in(files)
        ENGINE.rules = None
        if stem + ".kicad_dru" in files:
            with open(stem + ".kicad_dru", "rb") as f:
                ENGINE.rules = f.read()
        return ENGINE.call("open_board", {"path": dest + "/" + os.path.basename(pcb)})
    if ENGINE is None:
        raise ToolError("no board is open; open_board first")
    if not ENGINE.alive():
        raise ToolError("the engine exited (code %s); open_board starts a fresh one" % ENGINE.proc.returncode)
    if name == "save":
        # never a caller's path: a new directory cannot overwrite the owner's project files
        if args:
            raise ToolError("save takes no arguments; it writes into a new directory")
        reply = ENGINE.call("save", {})
        if "error" in reply:
            return reply
        out = tempfile.mkdtemp(prefix="pns-save.")
        for f in reply["files"]:
            ENGINE.cp("%s:%s" % (ENGINE.name, f), os.path.join(out, os.path.basename(f)))
        pcb = os.path.join(out, os.path.basename(reply["files"][0]))
        if ENGINE.rules is not None:
            with open(pcb[:-len(".kicad_pcb")] + ".kicad_dru", "wb") as f:
                f.write(ENGINE.rules)
        return {"pcb": pcb, "dir": out, "routing": reply["routing"]}
    return ENGINE.call(name, args)


def handle(msg):
    """The response to one JSON-RPC message, or None for a notification."""
    if "id" not in msg:
        return None
    rid, method, params = msg["id"], msg.get("method"), msg.get("params") or {}
    if method == "initialize":
        asked = params.get("protocolVersion")
        result = {"protocolVersion": asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
                  "capabilities": {"tools": {}}, "serverInfo": {"name": "pns", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        name = params.get("name")
        if name not in TOOL_NAMES:
            return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32602, "message": "unknown tool: %s" % name}}
        try:
            reply = run_tool(name, params.get("arguments") or {})
            failed = "error" in reply
        except ToolError as e:
            reply, failed = {"error": str(e)}, True
        except (KeyError, TypeError, ValueError, OSError) as e:
            reply, failed = {"error": "%s: %s" % (type(e).__name__, e)}, True
        result = {"content": [{"type": "text", "text": json.dumps(reply)}], "isError": failed}
    else:
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "method not found: %s" % method}}
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def main():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                out = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}
            else:
                out = handle(msg)
            if out is not None:
                sys.stdout.write(json.dumps(out) + "\n")
                sys.stdout.flush()
    finally:
        if ENGINE is not None:
            ENGINE.stop()


if __name__ == "__main__":
    main()
