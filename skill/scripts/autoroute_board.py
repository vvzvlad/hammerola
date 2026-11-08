"""Board steps of autoroute_run.sh: lock tracks/vias, export the DSN with fastroute options, import a SES, print the summary.
usage: autoroute_board.py lock <board> <locked.txt> | dsn <board> <out.dsn> <plain|plugin> <on|off> | ses <board> <in.ses> <out.kicad_pcb> [locked.txt] | summary <run_dir> <board>
needs: python3 with KiCad 10 pcbnew (the autoroute image: fastroute on PATH, plugin in /opt/fastroute-kicad)"""
import collections, json, math, os, re, shutil, subprocess, sys
import pcbnew

PLUGIN = "/opt/fastroute-kicad/plugins"
# the plugin's route_cli.py with PLANE_LAYER_MIN_COVERAGE 0 instead of 0.5: the plugin keeps a power-type layer, with
# its planes, only when one plane covers that share of the board and retypes the other power layers to signal; at 0
# every power layer with a plane stays one (a split plane too). Neither fastroute nor Freerouting puts a track of
# another net on it; fastroute joins a via just outside a plane's outline to that plane with a short stub of its net
EXPORT = f"import sys; sys.path.insert(0, {PLUGIN!r}); import core, route_cli; core.PLANE_LAYER_MIN_COVERAGE = 0; sys.exit(route_cli.main())"


def lock(board, record):
    """Locks every track/via for the router and writes the uuids it locked to record, for ses to unlock."""
    b = pcbnew.LoadBoard(board)
    items = list(b.GetTracks())
    mine = [t for t in items if not t.IsLocked()]
    for t in mine:
        t.SetLocked(True)
    pcbnew.SaveBoard(board, b, True)
    open(record, "w").write("".join(t.m_Uuid.AsString() + "\n" for t in mine))
    print(f"locked {len(mine)} of {len(items)} existing tracks/vias")


def dsn(board, out, export, minw):
    """Writes the DSN and prints the fastroute options that belong to it, one per line."""
    if export == "plain":
        b = pcbnew.LoadBoard(board)
        if not pcbnew.ExportSpecctraDSN(b, out):
            sys.exit("ExportSpecctraDSN failed")
        w = b.GetDesignSettings().m_TrackMinWidth / 1000
        args = [f"--router.min_trace_width_um={w:g}", f"--router.neck_width_um={w:g}"] if minw == "on" else []
    else:
        # the plugin's own exporter: .kicad_dru clearances and widths, zones, keepouts; its options in args.txt
        wd = os.path.splitext(out)[0] + "_plugin"
        subprocess.run([sys.executable, "-c", EXPORT, board, "--work-dir", wd, "--export-only", "--fastroute", shutil.which("fastroute")]
                       + (["--ignore-min-width"] if minw == "off" else []), check=True, stdout=sys.stderr)
        shutil.move(os.path.join(wd, "board.dsn"), out)
        a = open(os.path.join(wd, "args.txt")).read().split("\n")
        args = [x for i, x in enumerate(a) if x and x not in ("-de", "-do") and a[i - 1] not in ("-de", "-do")]
    print("\n".join(args))


def key(t):
    """Same copper: net, layer(s), ends (arcs also the middle) or position, width, drill. Coordinates are rounded
    to 100 nm, the DSN/SES resolution (um 10): a locked item off that grid comes back from the session snapped to it."""
    def g(v):
        return round(v.x / 100), round(v.y / 100)
    if t.GetClass() == "PCB_VIA":
        return ("via", t.GetNetCode(), t.TopLayer(), t.BottomLayer(), g(t.GetPosition()), t.GetWidth(t.TopLayer()), t.GetDrillValue())
    s, e = g(t.GetStart()), g(t.GetEnd())
    mid = g(t.GetMid()) if t.GetClass() == "PCB_ARC" else None
    return (t.GetClass(), t.GetNetCode(), t.GetLayer(), min(s, e), max(s, e), mid, t.GetWidth())


def ses(board, session, out, record=None):
    """Imports the session; with record (lock's uuids), the tracks/vias lock locked are unlocked again, so the routed
    copy has the locks of the board it came from."""
    b = pcbnew.LoadBoard(board)
    if not pcbnew.ImportSpecctraSES(b, session):
        sys.exit(f"ImportSpecctraSES failed: {session}")
    # the session repeats some locked segments; KiCad adds them as unlocked copies beside the locked originals
    locked = {key(t) for t in b.GetTracks() if t.IsLocked()}
    dup = [t for t in b.GetTracks() if not t.IsLocked() and key(t) in locked]
    for t in dup:
        b.Delete(t)
    mine = set(open(record).read().split()) if record else set()
    back = [t for t in b.GetTracks() if t.m_Uuid.AsString() in mine]
    for t in back:
        t.SetLocked(False)
    pcbnew.SaveBoard(out, b, True)
    print(f"removed {len(dup)} unlocked tracks/vias that duplicate locked ones; unlocked {len(back)} locked for the run")


def jload(path):
    return json.load(open(path)) if os.path.exists(path) else None


def summary(run, board):
    times = [l.split() for l in open(os.path.join(run, "times.txt"))]
    draft = jload(os.path.join(run, "draft.json"))
    drc = jload(os.path.join(run, "drc.json"))
    geo = jload(os.path.join(run, "geo.json"))
    fin = open(os.path.join(run, "finish.txt")).read().strip()
    st = "  ".join(f"{s} {float(ms) / 1000:.1f}" for s, ms in times)
    print(f"stage wall times, s: {st}  total {sum(float(ms) for _, ms in times) / 1000:.1f}")
    diag = any("diagnosis" in u for u in (draft or {}).get("unrouted", []))
    if draft:
        ts = draft["time_s"]
        dt = f" + diagnose {ts['diagnose']:.1f}" if ts["diagnose"] is not None else ""
        print(f"  draft: fastroute route {ts['route']:.1f}{dt}; finish: {fin}")
        cls = collections.Counter(u["diagnosis"]["class"] for u in draft["unrouted"] if "diagnosis" in u)
        print(f"fastroute draft: {draft['stats']['unrouted']} of {draft['stats']['connections']} connections unrouted"
              + (f" ({', '.join(f'{k} {v}' for k, v in sorted(cls.items()))})" if cls else ""))
    # the layers the router was handed as power type: no track of another net than their planes' goes on them
    free = re.findall(r'\(layer\s+"?([^\s"()]+)"?\s*\(type\s+power\)', open(os.path.join(run, "draft.dsn")).read())
    print(f"power-type layers handed to the router (no new tracks of other nets): {', '.join(free) or 'none'}")
    print(open(os.path.join(run, "import.log")).read().strip().splitlines()[-1])
    v, un = drc["violations"], drc["unconnected_items"]
    err = collections.Counter(x["type"] for x in v if x["severity"] == "error")
    print(f"KiCad DRC, zones refilled: unrouted {len(un)}, errors {sum(err.values())}")
    for k, n in err.most_common():
        print(f"  {k:32} {n}")
    if geo is None:
        print("geocheck.py: FAILED, no geo.json; its stdout and stderr are in run/geo.log next to summary.txt")
    else:
        g = collections.Counter(f["kind"] for f in geo)
        print(f"geocheck.py: findings {len(geo)}" + (" " + json.dumps(dict(sorted(g.items()))) if geo else ""))
    if un:
        print("unrouted connections (KiCad)" + (", with fastroute's class from the draft diagnosis:" if diag else ":"))
    by_net = collections.defaultdict(list)
    for u in (draft or {}).get("unrouted", []):
        by_net[u["net"]].append(u)
    for x in un:
        a, b = x["items"][0], x["items"][-1]
        m = re.search(r"\[(.*?)\]", a["description"])
        net = m.group(1) if m else "?"
        pa, pb = (a["pos"]["x"], a["pos"]["y"]), (b["pos"]["x"], b["pos"]["y"])
        pair = f"{net:20} {a['description']} @ ({pa[0]:.3f}, {pa[1]:.3f})  <->  {b['description']} @ ({pb[0]:.3f}, {pb[1]:.3f})"
        if not diag:
            print(f"  {pair}")
            continue

        def d(u):
            f, t = u["from_xy"], u["to_xy"]
            return min(math.dist(pa, f) + math.dist(pb, t), math.dist(pa, t) + math.dist(pb, f))

        # the draft connection of the same net whose ends lie closest to this pair; the distance says how good the match is
        u = min(by_net[net], key=d) if by_net[net] else None
        c = f"{u['diagnosis']['class']} (ends {d(u):.2f} mm off)" if u else "not in draft report"
        print(f"  {c:30} {pair}")


if __name__ == "__main__":
    {"lock": lock, "dsn": dsn, "ses": ses, "summary": summary}[sys.argv[1]](*sys.argv[2:])
