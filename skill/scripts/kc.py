#!/usr/bin/env python3
"""Minimal MCP stdio client for the Copperpour server: a fresh copperpour process per run, toolsets loaded first.
usage: kc.py calls.json | kc.py - < calls.json   (a JSON list of {"tool": name, "args": {...}})
needs: python3 (stdlib only) and the copperpour binary (COPPERPOUR_BIN or `copperpour` on PATH)

Each call result is printed (text content) after a header line; a call with
"save_to": path writes it to that file instead. {"tool": "__list__", "save_to": path}
saves tools/list. Stops at the first call whose result isError==true unless KC_CONTINUE=1.

Environment:
  COPPERPOUR_BIN  path to the copperpour binary (default: `copperpour` on PATH)
  KC_TOOLSETS     comma-separated toolsets; replaces the default list (to add one, put
                  {"tool": "load_toolset", "args": {"name": [...]}} first in the calls)
  KC_MAXLEN       max printed chars per result (default 6000)
  KC_CONTINUE     1 = keep going after a failed call
"""
import json, os, shutil, subprocess, sys, threading, queue

DEFAULT_TOOLSETS = ("sch_components,sch_wiring,sch_analysis,sch_export,sch_hierarchy,"
                    "sch_batch,library,integration,pcb_board,pcb_components,pcb_routing,"
                    "pcb_export,verification")
COPPERPOUR = os.environ.get("COPPERPOUR_BIN") or shutil.which("copperpour")
TOOLSETS = [t.strip() for t in os.environ.get("KC_TOOLSETS", DEFAULT_TOOLSETS).split(",") if t.strip()]


def main():
    if not COPPERPOUR:
        sys.exit("copperpour binary not found: set COPPERPOUR_BIN or put copperpour on PATH")
    # Flush per line so results of finished calls survive a killed process.
    sys.stdout.reconfigure(line_buffering=True)
    src = sys.argv[1]
    calls = json.load(sys.stdin if src == "-" else open(src))
    maxlen = int(os.environ.get("KC_MAXLEN", "6000"))
    cont = os.environ.get("KC_CONTINUE") == "1"
    p = subprocess.Popen([COPPERPOUR], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, text=True, bufsize=1)
    q = queue.Queue()

    def reader():
        for line in p.stdout:
            line = line.strip()
            if line:
                q.put(line)
        q.put(None)
    threading.Thread(target=reader, daemon=True).start()

    nid = [0]

    def send(method, params=None, notify=False):
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        if not notify:
            nid[0] += 1
            msg["id"] = nid[0]
        p.stdin.write(json.dumps(msg) + "\n")
        p.stdin.flush()
        if notify:
            return None
        while True:
            line = q.get(timeout=600)
            if line is None:
                raise RuntimeError("server closed")
            try:
                m = json.loads(line)
            except Exception:
                continue
            if m.get("id") == nid[0]:
                return m

    send("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                        "clientInfo": {"name": "kc-script", "version": "0"}})
    send("notifications/initialized", notify=True)
    r = send("tools/call", {"name": "load_toolset", "arguments": {"name": TOOLSETS}})
    # Copperpour reports unknown toolsets in the result (isError or an "errors" list), not as an RPC error.
    res = r.get("result", {})
    txt = "\n".join(x.get("text", "") for x in res.get("content", []) if x.get("type") == "text")
    try:
        load_errors = json.loads(txt).get("errors")
    except Exception:
        load_errors = None
    if "error" in r or res.get("isError") or load_errors:
        print("LOAD ERROR", r.get("error") or txt[:2000])
        sys.exit(1)
    for i, c in enumerate(calls):
        if c["tool"] == "__list__":
            r = send("tools/list", {})
            with open(c["save_to"], "w") as f:
                json.dump(r.get("result"), f, indent=1)
            print(f"=== [{i}] tools/list saved to {c['save_to']}")
            continue
        r = send("tools/call", {"name": c["tool"], "arguments": c.get("args", {})})
        print(f"=== [{i}] {c['tool']}")
        if "error" in r:
            print("RPC ERROR:", json.dumps(r["error"])[:maxlen])
            if not cont:
                break
            continue
        res = r["result"]
        texts = [x.get("text", "") for x in res.get("content", []) if x.get("type") == "text"]
        out = "\n".join(texts)
        if c.get("save_to"):
            with open(c["save_to"], "w") as f:
                f.write(out)
            print(f"(saved {len(out)} chars to {c['save_to']})")
        else:
            print(out if len(out) <= maxlen else out[:maxlen] + f"\n...[truncated {len(out)-maxlen} chars]")
        if res.get("isError"):
            print("!!! isError")
            if not cont:
                break
    p.stdin.close()
    p.terminate()


if __name__ == "__main__":
    main()
