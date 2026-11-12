"""Board queries for layout agents: what is near a point, copper clearance between two items, legal via sites, a track corridor, legal designator spots, a footprint's pads with what is attached to each, a net's copper, zones with their fill pieces, placement score (HPWL and airwire crossings of signal nets, bare pads once the board has tracks), a footprint's courtyard against the board outline, the routed copper length, vias and layers between two pads of one net or from a pad to the nearest via; compact text, or JSON with --json.
usage: "$PY" bq.py <board.kicad_pcb> near X Y [--r 2] [--layer L] | clearance A B | via X Y --net NET [--r 3] [--n 5] [--size D --drill d] | corridor X1 Y1 X2 Y2 --layer L --width W --net NET | labels REF | pads REF | net NAME | zones [--layer L] [--net N] [--at X Y] | score [X1 Y1 X2 Y2] [--n 5] | edge REF | path REF.PAD REF.PAD|via   (mm; A/B = REF, REF.PAD or net:NAME; path between pads of two nets gives the straight gap only; cmd "-" reads one query per line from stdin, board loaded once; reads the saved file, zones refilled in memory; clearance, hole_clearance and edge_clearance rules of the .kicad_dru beside the board are applied, see boardgeo.py; a bare pad has a net other than KiCad's unconnected-* and nothing attached: no track, arc or via, no zone fill, no touching pad that has one)
needs: KiCad's bundled Python with pcbnew ($PY), e.g. /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3; boardgeo.py beside this file"""
import sys, json, math, shlex, argparse, collections, heapq
import pcbnew
sys.dont_write_bytecode = True  # no __pycache__ beside the installed scripts
import boardgeo
from boardgeo import V, nm, mm, box_of, box_gap, hit, dist, nearest, point

VIA_STEP = 50000  # via site grid, nm


def f3(v):
    return round(mm(v), 3)


def at(p):
    return [f3(p.x), f3(p.y)]


def desc(it):
    return dict(kind=it.kind, name=it.name(), net=it.net, layer=it.layer)


def copper_layer(g, name):
    """The board's name of copper layer `name`; exits naming it when it is not one."""
    lid = g.board.GetLayerID(name)
    if lid not in g.cu:
        raise SystemExit("bq: %s is not a copper layer of this board (%s)" % (name, ", ".join(g.ln(l) for l in g.cu)))
    return g.ln(lid)


# ---------------------------------------------------------------- near
def near(g, a):
    x, y, r = nm(a.x), nm(a.y), nm(a.r)
    box = (x - r, y - r, x + r, y + r)
    lay = copper_layer(g, a.layer) if a.layer else None
    layers = [lay] if lay else list(g.grid.keys())
    found = {}
    cands = [it for L in layers if L in g.grid for it in g.grid[L].query(box)]
    cands += [z for z in g.zones if (not lay or z.layer == lay) and box_gap(z.box, box) == 0]
    p = point(x, y)
    for it in cands:
        d = dist(it.shape, p)
        if d > r:
            continue
        key = (it.kind, id(it.obj), d) if it.kind != "zone" else (it.kind, id(it.obj), it.layer)
        if key in found:
            found[key]["layers"].append(it.layer)
        else:
            found[key] = dict(kind=it.kind, name=it.name(), net=it.net, layers=[it.layer], dist=f3(d))
    items = sorted(found.values(), key=lambda e: (e["dist"], e["kind"], e["name"]))
    res = dict(cmd="near", x=a.x, y=a.y, r=a.r, items=items)
    txt = ["near %.3f %.3f r %.2f: %d items" % (a.x, a.y, a.r, len(items))]
    for e in items:
        txt.append("  %7.3f  %-9s %-14s %-18s %s" % (e["dist"], e["kind"], e["name"], e["net"] or "-", ",".join(e["layers"])))
    return res, txt


# ---------------------------------------------------------------- clearance
def resolve(g, spec):
    """Copper items of REF, REF.PAD or net:NAME, by layer."""
    out = {}
    if spec.startswith("net:"):
        net = spec[4:]
        for L, grid in g.grid.items():
            for c in grid.cells.values():
                for it in c:
                    if it.net == net and it.kind in ("pad", "via", "track", "arc", "shape"):
                        out.setdefault(L, {})[id(it)] = it
        for z in g.zones:
            if z.net == net:
                out.setdefault(z.layer, {})[id(z)] = z
    else:
        if spec not in g.fps and "." not in spec:
            raise SystemExit("bq: no footprint %s" % spec)
        ref, num = (spec, None) if spec in g.fps else spec.rsplit(".", 1)
        for L, grid in g.grid.items():
            for c in grid.cells.values():
                for it in c:
                    if it.kind == "pad" and it.ref == ref and (num is None or it.pad == num):
                        out.setdefault(L, {})[id(it)] = it
    if not out:
        raise SystemExit("bq: no copper for %s" % spec)
    return {L: list(d.values()) for L, d in out.items()}


def clearance(g, a):
    A, B = resolve(g, a.a), resolve(g, a.b)
    rows, txt = [], ["clearance %s %s" % (a.a, a.b)]
    for L in [g.ln(l) for l in g.cu]:
        if L not in A or L not in B:
            continue
        best = worst = None
        for ia in A[L]:
            for ib in B[L]:
                if ia is ib or (ia.code and ia.code == ib.code):
                    continue
                need = g.need(ia, ib, L)
                lb = box_gap(ia.box, ib.box)
                if best and lb >= best[0] and worst and lb - need >= worst[0] - worst[1]:
                    continue
                d = dist(ia.shape, ib.shape)
                if best is None or d < best[0]:
                    best = (d, need, ia, ib)
                if worst is None or d - need < worst[0] - worst[1]:
                    worst = (d, need, ia, ib)
        if best is None:
            continue
        row = dict(layer=L)
        for key, (d, need, ia, ib) in (("min", best), ("worst", worst)):
            pa, pb = nearest(ia.shape, ib.shape)
            row[key] = dict(dist=f3(d), need=f3(need), ok=d >= need, a=dict(desc(ia), at=at(pa)), b=dict(desc(ib), at=at(pb)))
        if worst[2] is best[2] and worst[3] is best[3]:
            del row["worst"]
        rows.append(row)
        for key in ("min", "worst"):
            if key not in row:
                continue
            e = row[key]
            txt.append("  %-7s %-5s %.3f need %.3f %-9s %s %s %s (%.3f,%.3f) ~ %s %s %s (%.3f,%.3f)" % (
                L, key, e["dist"], e["need"], "ok" if e["ok"] else "VIOLATION",
                e["a"]["kind"], e["a"]["name"], e["a"]["net"] or "-", e["a"]["at"][0], e["a"]["at"][1],
                e["b"]["kind"], e["b"]["name"], e["b"]["net"] or "-", e["b"]["at"][0], e["b"]["at"][1]))
    if not rows:
        txt.append("  no shared copper layer with copper of different nets")
    return dict(cmd="clearance", a=a.a, b=a.b, layers=rows), txt


# ---------------------------------------------------------------- via
def what(it):
    return "%s %s %s" % (it.kind, it.name() if it.ref else "-", it.net or "-")


class Obst:
    """One test a via site must pass: probe shape ('disk' or 'hole') against an item at a required distance."""
    __slots__ = ("box", "probe", "it", "need", "label")

    def __init__(self, probe, it, need, label, rad):
        self.probe, self.it, self.need, self.label = probe, it, need, label
        b, r = it.box, need + rad
        self.box = (b[0] - r, b[1] - r, b[2] + r, b[3] + r)


def via_obstacles(g, x0, y0, reach, code, probe, rad, hrad):
    """Every test for via sites within reach of (x0, y0), with its requirement, indexed by where it can bite."""
    area = (x0 - reach, y0 - reach, x0 + reach, y0 + reach)
    obs = []
    for l in g.cu:
        L = g.ln(l)
        for it in g.query(L, area):
            if it.kind not in ("pad", "via", "track", "arc", "shape", "text") or (code and it.code == code):
                continue
            obs.append(Obst("disk", it, g.need(probe, it, L), "%s %s" % (what(it), L), rad))
            obs.append(Obst("hole", it, g.need_hole(probe, it, L), "hole to %s %s" % (what(it), L), hrad))
    for it in g.query("hole", area):
        obs.append(Obst("hole", it, g.h2h, "hole to %s" % what(it), hrad))
        if not it.plated or not code or it.code != code:
            obs.append(Obst("disk", it, max(g.need_hole(it, probe, g.ln(l)) for l in g.cu), "copper to %s" % what(it), rad))
    for it in g.query(g.ln(pcbnew.Edge_Cuts), area):
        obs.append(Obst("disk", it, max(g.need_edge(probe, it, g.ln(l)) for l in g.cu), "edge", rad))
    for it, vias, tracks, layers in g.keepouts:
        if vias and box_gap(it.box, area) == 0:
            obs.append(Obst("disk", it, 0, "keepout %s" % it.name(), rad))
    for l in (pcbnew.F_CrtYd, pcbnew.B_CrtYd, pcbnew.F_SilkS, pcbnew.B_SilkS):
        for it in g.query(g.ln(l), area):
            obs.append(Obst("disk", it, 0, "%s %s" % ("courtyard" if it.kind == "courtyard" else "silk", it.name()), rad))
    grid = boardgeo.Grid()
    for o in obs:
        grid.add(o)
    return obs, grid


def via_site(g, x, y, rad, hrad, obs, grid):
    """None when (x, y) is a legal via site, else the first test it fails."""
    if not g.inside(x, y):
        return "outside the board"
    shapes = dict(disk=pcbnew.SHAPE_CIRCLE(V(x, y), rad), hole=pcbnew.SHAPE_CIRCLE(V(x, y), hrad))
    for o in grid.query((x, y, x, y)):
        if hit(shapes[o.probe], o.it.shape, o.need):
            return o.label
    return None


def via_slack(x, y, rad, hrad, obs):
    """Smallest margin over every test of a legal site, and the test that sets it."""
    shapes = dict(disk=pcbnew.SHAPE_CIRCLE(V(x, y), rad), hole=pcbnew.SHAPE_CIRCLE(V(x, y), hrad))
    best = (None, "")
    for o in obs:
        if best[0] is not None and box_gap(o.it.box, (x, y, x, y)) - o.need - rad >= best[0]:
            continue
        m = dist(shapes[o.probe], o.it.shape) - o.need
        if best[0] is None or m < best[0]:
            best = (m, o.label)
    return best


def via(g, a):
    net = a.net
    ni = g.board.FindNet(net)
    if ni is None:
        raise SystemExit("bq: no net %s" % net)
    code = ni.GetNetCode()
    nc_obj = g.ns.GetEffectiveNetClass(net)
    d = nm(a.size) if a.size else nc_obj.GetViaDiameter()
    dr = nm(a.drill) if a.drill else nc_obj.GetViaDrill()
    rad, hrad = d // 2, dr // 2
    probe = g.probe("via", net)
    x0, y0, r = nm(a.x), nm(a.y), nm(a.r)
    obs, grid = via_obstacles(g, x0, y0, r + rad + g.max_need + nm(1), code, probe, rad, hrad)
    n = int(r // VIA_STEP)
    gx, gy = int(round(x0 / VIA_STEP)), int(round(y0 / VIA_STEP))
    pts = []
    for i in range(-n - 1, n + 2):
        for j in range(-n - 1, n + 2):
            x, y = (gx + i) * VIA_STEP, (gy + j) * VIA_STEP
            dd = math.hypot(x - x0, y - y0)
            if dd <= r:
                pts.append((dd, x, y))
    pts.sort()
    sep = max(d, dr + g.h2h)
    sites, checked = [], 0
    for dd, x, y in pts:
        if any(math.hypot(x - s[0], y - s[1]) < sep for s in sites):
            continue
        checked += 1
        if via_site(g, x, y, rad, hrad, obs, grid) is None:
            m, why = via_slack(x, y, rad, hrad, obs)
            sites.append((x, y, dd, m, why))
            if len(sites) >= a.n:
                break
    res = dict(cmd="via", net=net, x=a.x, y=a.y, r=a.r, size=f3(d), drill=f3(dr), checked=checked,
               sites=[dict(x=f3(x), y=f3(y), dist=f3(dd), slack=f3(m), limit=w) for x, y, dd, m, w in sites])
    txt = ["via %s d %.3f drill %.3f near %.3f %.3f r %.2f: %d sites (%d points checked)" % (
        net, mm(d), mm(dr), a.x, a.y, a.r, len(sites), checked)]
    for e in res["sites"]:
        txt.append("  %8.3f %8.3f  at %.3f  slack %.3f (%s)" % (e["x"], e["y"], e["dist"], e["slack"], e["limit"]))
    return res, txt


# ---------------------------------------------------------------- corridor
def area_dist(shape, area):
    """Edge-to-edge distance from `shape` to a keep-out polygon set. GetClearance treats the area's holes as filled
    (0 inside a hole) while Collide and KiCad's DRC leave them open, so: 0 on contact, else the distance to the
    outline and hole rings taken as open polylines."""
    if hit(shape, area, 0):
        return 0
    best = None
    for i in range(area.OutlineCount()):
        for ring in [area.COutline(i)] + [area.CHole(i, j) for j in range(area.HoleCount(i))]:
            c = pcbnew.SHAPE_LINE_CHAIN(ring)
            c.SetClosed(False)
            c.Append(c.CPoint(0))
            d = dist(shape, c)
            best = d if best is None else min(best, d)
    return best


def corridor(g, a):
    L = copper_layer(g, a.layer)
    net = a.net
    ni = g.board.FindNet(net)
    if ni is None:
        raise SystemExit("bq: no net %s" % net)
    code = ni.GetNetCode()
    probe = g.probe("track", net)
    p1, p2 = V(nm(a.x1), nm(a.y1)), V(nm(a.x2), nm(a.y2))
    w = nm(a.width)
    seg = pcbnew.SHAPE_SEGMENT(p1, p2, 0)
    band = w // 2 + g.max_need + nm(1)
    box = box_of(seg)
    obst = []

    def add(it, need, label):
        d = dist(seg, it.shape)
        pa, pb = nearest(seg, it.shape)
        obst.append(dict(what=label, dist=d, need=need, at=math.hypot(pa.x - p1.x, pa.y - p1.y), p=at(pb)))

    def along(t):
        return V(int(round(p1.x + (p2.x - p1.x) * t)), int(round(p1.y + (p2.y - p1.y) * t)))

    def entry(shape, limit):
        """Smallest fraction t of the segment whose part p1..p(t) comes closer than `limit` to keep-out `shape`."""
        if area_dist(point(p1.x, p1.y), shape) < limit:
            return 0.0
        lo, hi = 0.0, 1.0
        for _ in range(32):
            mid = (lo + hi) / 2
            if area_dist(pcbnew.SHAPE_SEGMENT(p1, along(mid), 0), shape) < limit:
                hi = mid
            else:
                lo = mid
        return hi

    for it in g.query(L, box, band):
        if it.kind in ("pad", "via", "track", "arc", "shape", "text") and not (code and it.code == code):
            add(it, g.need(probe, it, L), what(it))
    for it in g.query("hole", box, band):
        if (not it.plated) or (it.code != code or not code):
            add(it, g.need_hole(it, probe, L), what(it))
    for it in g.query(g.ln(pcbnew.Edge_Cuts), box, band):
        add(it, g.need_edge(probe, it, L), "edge")
    for it, vias, tracks, layers in g.keepouts:
        if tracks and L in layers and box_gap(it.box, box) <= band:
            # a keep-out spans millimetres: report where the track first enters it, not KiCad's nearest-point pick
            d = area_dist(seg, it.shape)
            t = entry(it.shape, w // 2) if d < w // 2 else 0.0
            obst.append(dict(what="keepout %s" % it.name(), dist=d, need=0,
                             at=t * math.hypot(p2.x - p1.x, p2.y - p1.y), p=at(along(t))))
    blocks = sorted([o for o in obst if w // 2 + o["need"] - o["dist"] > 0], key=lambda o: o["at"])
    lim = min(obst, key=lambda o: o["dist"] - o["need"]) if obst else None
    widest = 2 * (lim["dist"] - lim["need"]) if lim else None
    cap = w + nm(2)  # items outside the searched band cannot limit a track narrower than this
    exact = widest is not None and widest < cap
    res = dict(cmd="corridor", layer=L, net=net, width=a.width, a=[a.x1, a.y1], b=[a.x2, a.y2], fits=not blocks,
               widest=f3(max(widest, 0)) if exact else None, widest_limit=lim["what"] if exact else None,
               widest_over=None if exact else f3(cap),
               obstacles=[dict(what=o["what"], at=f3(o["at"]), point=o["p"], dist=f3(o["dist"]), need=f3(w // 2 + o["need"]),
                               deficit=f3(w // 2 + o["need"] - o["dist"])) for o in blocks])
    head = "corridor %.3f %.3f -> %.3f %.3f %s w %.3f net %s: %s" % (
        a.x1, a.y1, a.x2, a.y2, L, a.width, net, "fits" if not blocks else "%d obstacles" % len(blocks))
    if not exact:
        head += ", widest > %.3f" % mm(cap)
    elif widest > 0:
        head += ", widest %.3f (%s)" % (res["widest"], lim["what"])
    else:
        head += ", no track fits (%s)" % lim["what"]
    txt = [head]
    for o in res["obstacles"]:
        txt.append("  at %7.3f  %-40s dist %.3f need %.3f deficit %.3f" % (o["at"], o["what"], o["dist"], o["need"], o["deficit"]))
    return res, txt


# ---------------------------------------------------------------- labels
def labels(g, a):
    if a.ref not in g.fps:
        raise SystemExit("bq: no footprint %s" % a.ref)
    lg = boardgeo.Labels(g, [a.ref])
    spots, why = lg.candidates(a.ref)
    res = dict(cmd="labels", ref=a.ref, side=lg.side(g.fps[a.ref]),
               spots=[dict(x=f3(s["x"]), y=f3(s["y"]), angle=s["angle"], cost=round(s["cost"], 2), gap=f3(s["gap"]),
                           ink=[f3(v) for v in s["box"]]) for s in spots],
               rejected=dict(why))
    txt = ["labels %s (%s side): %d spots; rejected %s" % (a.ref, res["side"], len(spots),
                                                          ", ".join("%s %d" % kv for kv in why.most_common()) or "none")]
    for s in res["spots"]:
        txt.append("  %8.3f %8.3f  %2d  gap %.3f  cost %.2f" % (s["x"], s["y"], s["angle"], s["gap"], s["cost"]))
    return res, txt


# ---------------------------------------------------------------- pads, net, zones
def conn(g):
    """KiCad's connectivity of the board with its zones refilled in memory, built once per load."""
    if not hasattr(g, "cn"):
        g.board.BuildConnectivity()
        g.cn = g.board.GetConnectivity()
    return g.cn


def bare(cn, p):
    """A pad with a net that needs copper (not KiCad's unconnected-*) and none attached: no track, arc or via on it, and
    its connectivity cluster holds pads only, so nothing but pads reaches it or the pads its copper touches (the other
    parts of an exposed pad)."""
    return (p.GetNetCode() > 0 and not p.GetNetname().startswith("unconnected-") and not len(cn.GetConnectedTracks(p))
            and all(i.Type() == pcbnew.PCB_PAD_T for i in cn.GetConnectedItems(p)))


def bare_pads(g):
    """Bare pads by footprint reference: {ref: [pad numbers]}."""
    cn = conn(g)
    out = collections.defaultdict(list)
    for f in g.board.GetFootprints():
        for p in f.Pads():
            if bare(cn, p):
                out[f.GetReference()].append(p.GetNumber())
    return out


def via_row(v):
    v = v.Cast()
    return dict(at=at(v.GetPosition()), size=f3(v.GetWidth(v.TopLayer())), drill=f3(v.GetDrillValue()), uuid=v.m_Uuid.AsString())


def track_row(g, t):
    return dict(kind="arc" if t.GetClass() == "PCB_ARC" else "track", layer=g.ln(t.GetLayer()), a=at(t.GetStart()),
                b=at(t.GetEnd()), width=f3(t.GetWidth()), uuid=t.m_Uuid.AsString())


def pieces(fill):
    """The separate pieces of one layer's zone fill, largest first: (piece as its own polygon set, area mm2, bbox)."""
    out = []
    for i in range(fill.OutlineCount()):
        u = fill.UnitSet(i)
        out.append((u, round(u.Area() / 1e12, 3), [f3(v) for v in box_of(u)]))
    return sorted(out, key=lambda e: -e[1])


def pads(g, a):
    """Every pad of a footprint and what KiCad's connectivity attaches to it: tracks and arcs (with their ends that lie
    on the pad or within half the track width of it), vias and touching pads; zone fills of its net that reach the pad on a flashed layer (geometry)."""
    if a.ref not in g.fps:
        raise SystemExit("bq: no footprint %s" % a.ref)
    cn = conn(g)
    rows = []
    for p in g.fps[a.ref].Pads():
        code, att = p.GetNetCode(), []
        for t in cn.GetConnectedTracks(p):
            if t.GetClass() == "PCB_VIA":
                att.append(dict(kind="via", **via_row(t)))
            else:
                e = track_row(g, t)
                # an end within half the track width of the pad still overlaps its copper, as KiCad's connectivity counts it
                e["on_pad"] = [at(q) for q in (t.GetStart(), t.GetEnd()) if p.HitTest(q, (t.GetWidth() + 1) // 2, t.GetLayer())]
                att.append(e)
        for name in sorted({"%s.%s" % (q.GetParentFootprint().GetReference(), q.GetNumber()) for q in cn.GetConnectedPads(p)}):
            att.append(dict(kind="pad", name=name))
        for l in g.cu:
            if code and p.IsOnLayer(l) and p.FlashLayer(l):
                shape = p.GetEffectiveShape(l)
                for z in g.zones:
                    if z.code == code and z.layer == g.ln(l) and box_gap(z.box, box_of(shape)) == 0 and hit(shape, z.shape, 0):
                        att.append(dict(kind="zone", name=z.ref, layer=z.layer))
        rows.append(dict(pad=p.GetNumber(), net=p.GetNetname(), at=at(p.GetPosition()),
                         layers=[g.ln(l) for l in g.cu if p.IsOnLayer(l)], bare=bare(cn, p), attached=att))

    def show(e):
        if e["kind"] in ("track", "arc"):
            return "%s %s w%.3f %s on pad %s" % (e["kind"], e["layer"], e["width"], e["uuid"],
                                                " ".join("(%.3f, %.3f)" % tuple(q) for q in e["on_pad"]) or "-")
        if e["kind"] == "via":
            return "via (%.3f, %.3f) %.3f/%.3f %s" % (e["at"][0], e["at"][1], e["size"], e["drill"], e["uuid"])
        return " ".join(filter(None, (e["kind"], e["name"], e.get("layer"))))

    res = dict(cmd="pads", ref=a.ref, bare=sum(r["bare"] for r in rows), pads=rows)
    txt = ["pads %s: %d pads, %d bare" % (a.ref, len(rows), res["bare"])]
    for r in rows:
        txt.append("  %-5s %-20s %8.3f %8.3f  %-24s %s" % (r["pad"] or "-", r["net"] or "-", r["at"][0], r["at"][1], ",".join(r["layers"]),
                                                       "BARE" if r["bare"] else "; ".join(show(e) for e in r["attached"]) or "-"))
    return res, txt


def net(g, a):
    ni = g.board.FindNet(a.name)
    if ni is None:
        raise SystemExit("bq: no net %s" % a.name)
    code = ni.GetNetCode()
    pl = ["%s.%s" % (f.GetReference(), p.GetNumber()) for f in g.board.GetFootprints() for p in f.Pads() if p.GetNetCode() == code]
    tracks, vias = [], []
    for t in g.board.GetTracks():
        if t.GetNetCode() == code:
            if t.GetClass() == "PCB_VIA":
                vias.append(via_row(t))
            else:
                tracks.append(track_row(g, t))
    tracks.sort(key=lambda e: (e["layer"], e["a"], e["b"]))
    fills = [dict(zone=z.ref, layer=z.layer, area=area, box=box) for z in g.zones if z.code == code for _, area, box in pieces(z.shape)]
    res = dict(cmd="net", net=a.name, pads=pl, tracks=tracks, vias=vias, fills=fills)
    txt = ["net %s: %d pads, %d tracks, %d vias, %d zone fill pieces" % (a.name, len(pl), len(tracks), len(vias), len(fills)),
           "  pads " + (" ".join(pl) or "-")]
    for e in tracks:
        txt.append("  %-5s %-7s (%.3f, %.3f) (%.3f, %.3f) w%.3f %s" % (e["kind"], e["layer"], e["a"][0], e["a"][1], e["b"][0], e["b"][1],
                                                                  e["width"], e["uuid"]))
    for e in vias:
        txt.append("  via   (%.3f, %.3f) %.3f/%.3f %s" % (e["at"][0], e["at"][1], e["size"], e["drill"], e["uuid"]))
    for e in fills:
        txt.append("  fill  %-7s %10.3f mm2  box %.3f %.3f %.3f %.3f  %s" % (e["layer"], e["area"], *e["box"], e["zone"] or "-"))
    return res, txt


def zones(g, a):
    """Board and footprint zones with net, layers, priority, rule-area flag and outline bbox; the pieces of each copper
    zone's fill (refilled in memory) with area, bbox and how many vias of the zone's net touch the piece (geometry);
    with --at X Y only the pieces that contain that point, and only the zones that have one."""
    lay = copper_layer(g, a.layer) if a.layer else None
    if a.net and g.board.FindNet(a.net) is None:
        raise SystemExit("bq: no net %s" % a.net)
    rows = []
    for z in list(g.board.Zones()) + [z for f in g.board.GetFootprints() for z in f.Zones()]:
        layers = [l for l in z.GetLayerSet().UIOrder() if g.board.IsLayerEnabled(l)]
        if (lay and lay not in [g.ln(l) for l in layers]) or (a.net and z.GetNetname() != a.net):
            continue
        fp, code, ps = z.GetParentFootprint(), z.GetNetCode(), []
        for l in layers:
            L = g.ln(l)
            if z.GetIsRuleArea() or (lay and L != lay) or not z.HasFilledPolysForLayer(l):
                continue
            for u, area, box in pieces(z.GetFilledPolysList(l)):
                if a.at and not u.Contains(V(nm(a.at[0]), nm(a.at[1]))):
                    continue
                nv = sum(1 for it in g.query(L, box_of(u)) if it.kind == "via" and it.code == code and hit(it.shape, u, 0))
                ps.append(dict(layer=L, area=area, box=box, vias=nv))
        if a.at and not ps:
            continue
        rows.append(dict(name=z.GetZoneName() or (fp.GetReference() if fp else ""), net=z.GetNetname() or None,
                         layers=[g.ln(l) for l in layers], priority=z.GetAssignedPriority(), rule_area=z.GetIsRuleArea(),
                         outline=[f3(v) for v in box_of(z.Outline())], pieces=ps))
    res = dict(cmd="zones", layer=lay, net=a.net, zones=rows)
    txt = ["zones%s%s: %d" % (" on " + lay if lay else "", " of net " + a.net if a.net else "", len(rows))]
    for r in rows:
        txt.append("  %-20s %-14s %-24s priority %d%s  outline %.3f %.3f %.3f %.3f  %d pieces" % (
            r["name"] or "-", r["net"] or "-", ",".join(r["layers"]), r["priority"], "  rule area" if r["rule_area"] else "",
            *r["outline"], len(r["pieces"])))
        for e in r["pieces"]:
            txt.append("    %-7s %10.3f mm2  box %.3f %.3f %.3f %.3f  vias %d" % (e["layer"], e["area"], *e["box"], e["vias"]))
    return res, txt


# ---------------------------------------------------------------- score
def meets(p1, p2, q1, q2):
    """Two segments meet, touching included (OmniLayout placement_metrics._segments_intersect)."""
    def o(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    def on(a, b, c):
        return min(a[0], c[0]) <= b[0] <= max(a[0], c[0]) and min(a[1], c[1]) <= b[1] <= max(a[1], c[1])
    o1, o2, o3, o4 = o(p1, p2, q1), o(p1, p2, q2), o(q1, q2, p1), o(q1, q2, p2)
    if (o1 == 0 and on(p1, q1, p2)) or (o2 == 0 and on(p1, q2, p2)) or (o3 == 0 and on(q1, p1, q2)) or (o4 == 0 and on(q1, p2, q2)):
        return True
    return (o1 > 0) != (o2 > 0) and (o3 > 0) != (o4 > 0)


def meet_point(p1, p2, q1, q2):
    """Where two meeting segments cross (an end of one for collinear contact), nm."""
    den = (p2[0] - p1[0]) * (q2[1] - q1[1]) - (p2[1] - p1[1]) * (q2[0] - q1[0])
    if den == 0:
        return next(e for e in (q1, q2, p1, p2) if meets(e, e, p1, p2) and meets(e, e, q1, q2))
    t = ((q1[0] - p1[0]) * (q2[1] - q1[1]) - (q1[1] - p1[1]) * (q2[0] - q1[0])) / den
    return (p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1]))


def score(g, a):
    """Placement numbers over signal nets (a net with a copper zone is a plane net and is left out): HPWL, the sum of
    each net's pad bounding-box half-perimeter, and airwire crossings, each pair of different nets' minimum-spanning-tree
    edges over pad centres that meet (OmniLayout placement_metrics compute_hpwl, compute_net_crossing). With a box
    X1 Y1 X2 Y2 the crossing count and lists keep only crossings whose point lies in it; HPWL stays whole-board. Once the
    board has a track or arc, also the bare pads of the whole board (see bare) and the footprints with the most of them."""
    if a.box and len(a.box) != 4:
        raise SystemExit("bq: score box takes four numbers X1 Y1 X2 Y2")
    box = (min(a.box[0], a.box[2]), min(a.box[1], a.box[3]), max(a.box[0], a.box[2]), max(a.box[1], a.box[3])) if a.box else None
    planes = sorted({z.GetNetname() for z in g.board.Zones()
                     if not z.GetIsRuleArea() and z.IsOnCopperLayer() and z.GetNetCode() > 0})
    pads = collections.defaultdict(dict)
    for f in g.board.GetFootprints():
        for p in f.Pads():
            if p.GetNetCode() > 0 and p.GetNetname() not in planes:
                pos = p.GetPosition()
                pads[p.GetNetname()].setdefault((pos.x, pos.y), "%s.%s" % (f.GetReference(), p.GetNumber()))
    nets = {n: pts for n, pts in pads.items() if len(pts) > 1}
    hpwl, wires = {}, []
    for n, pts in nets.items():
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        hpwl[n] = max(xs) - min(xs) + max(ys) - min(ys)
        ps = list(pts)
        best = {k: (math.hypot(ps[k][0] - ps[0][0], ps[k][1] - ps[0][1]), 0) for k in range(1, len(ps))}
        while best:   # Prim's minimum spanning tree
            k = min(best, key=lambda k: best[k][0])
            wires.append((n, ps[best.pop(k)[1]], ps[k]))
            for m in best:
                d = math.hypot(ps[m][0] - ps[k][0], ps[m][1] - ps[k][1])
                if d < best[m][0]:
                    best[m] = (d, k)
    wires.sort(key=lambda w: min(w[1][0], w[2][0]))
    crossings, per, on_board = [], collections.Counter(), 0
    for i, (n1, p1, p2) in enumerate(wires):
        x1 = max(p1[0], p2[0])
        for n2, q1, q2 in wires[i + 1:]:
            if min(q1[0], q2[0]) > x1:
                break
            if n1 == n2 or {p1, p2} & {q1, q2} or min(q1[1], q2[1]) > max(p1[1], p2[1]) or max(q1[1], q2[1]) < min(p1[1], p2[1]):
                continue
            if meets(p1, p2, q1, q2):
                c = meet_point(p1, p2, q1, q2)
                on_board += 1
                if box and not (box[0] <= mm(c[0]) <= box[2] and box[1] <= mm(c[1]) <= box[3]):
                    continue
                crossings.append(dict(at=[f3(c[0]), f3(c[1])], a=dict(net=n1, wire=[nets[n1][p1], nets[n1][p2]]),
                                      b=dict(net=n2, wire=[nets[n2][q1], nets[n2][q2]])))
                per[n1] += 1
                per[n2] += 1
    worst_h = sorted(hpwl, key=lambda n: -hpwl[n])[:a.n]
    worst_c = [n for n, _ in per.most_common(a.n)]
    res = dict(cmd="score", signal_nets=len(nets), plane_nets=planes, hpwl=f3(sum(hpwl.values())), airwires=len(wires),
               box=list(box) if box else None, crossings=len(crossings), board_crossings=on_board,
               worst_hpwl=[dict(net=n, hpwl=f3(hpwl[n]), pads=len(nets[n])) for n in worst_h],
               worst_crossings=[dict(net=n, crossings=per[n]) for n in worst_c], crossing_list=crossings)
    if box:
        txt = ["score: %d signal nets (%d plane nets left out: %s), HPWL %.3f mm (whole board), %d airwire crossings in box "
               "%.3f %.3f %.3f %.3f (%d on the whole board; %d airwires)" % (
                   len(nets), len(planes), ", ".join(planes) or "none", res["hpwl"], len(crossings), *box, on_board, len(wires))]
    else:
        txt = ["score: %d signal nets (%d plane nets left out: %s), HPWL %.3f mm, %d airwire crossings (%d airwires)" % (
            len(nets), len(planes), ", ".join(planes) or "none", res["hpwl"], len(crossings), len(wires))]
    for e in res["worst_hpwl"]:
        txt.append("  hpwl      %9.3f  %s (%d pads)" % (e["hpwl"], e["net"], e["pads"]))
    for e in res["worst_crossings"]:
        c = next(c for c in crossings if e["net"] in (c["a"]["net"], c["b"]["net"]))
        txt.append("  crossings %9d  %s, e.g. at (%.3f, %.3f): %s %s-%s x %s %s-%s" % (
            e["crossings"], e["net"], c["at"][0], c["at"][1], c["a"]["net"], c["a"]["wire"][0], c["a"]["wire"][1],
            c["b"]["net"], c["b"]["wire"][0], c["b"]["wire"][1]))
    # bare pads say where routing has not reached a pad yet, so they mean nothing before the first track
    bp = bare_pads(g) if any(t.GetClass() != "PCB_VIA" for t in g.board.GetTracks()) else None
    top = sorted(bp, key=lambda r: (-len(bp[r]), r))[:a.n] if bp is not None else []
    res.update(bare_pads=sum(map(len, bp.values())) if bp is not None else None,
               worst_bare=[dict(ref=r, bare=len(bp[r]), pads=bp[r]) for r in top])
    if bp is not None:
        txt[0] += ", %d bare pads" % res["bare_pads"]
        txt += ["  bare      %9d  %s" % (len(bp[r]), r) for r in top]
    return res, txt


def parser():
    p = argparse.ArgumentParser(prog="bq.py", add_help=True)
    p.add_argument("--json", action="store_true")
    sp = p.add_subparsers(dest="cmd", required=True)
    s = sp.add_parser("near"); s.add_argument("x", type=float); s.add_argument("y", type=float)
    s.add_argument("--r", type=float, default=2.0); s.add_argument("--layer")
    s = sp.add_parser("clearance"); s.add_argument("a"); s.add_argument("b")
    s = sp.add_parser("via"); s.add_argument("x", type=float); s.add_argument("y", type=float)
    s.add_argument("--net", required=True); s.add_argument("--r", type=float, default=3.0); s.add_argument("--n", type=int, default=5)
    s.add_argument("--size", type=float); s.add_argument("--drill", type=float)
    s = sp.add_parser("corridor")
    for k in ("x1", "y1", "x2", "y2"):
        s.add_argument(k, type=float)
    s.add_argument("--layer", required=True); s.add_argument("--width", type=float, required=True); s.add_argument("--net", required=True)
    s = sp.add_parser("labels"); s.add_argument("ref")
    s = sp.add_parser("pads"); s.add_argument("ref")
    s = sp.add_parser("net"); s.add_argument("name")
    s = sp.add_parser("zones"); s.add_argument("--layer"); s.add_argument("--net")
    s.add_argument("--at", type=float, nargs=2, metavar=("X", "Y"))
    s = sp.add_parser("score"); s.add_argument("box", type=float, nargs="*"); s.add_argument("--n", type=int, default=5)
    s = sp.add_parser("edge"); s.add_argument("ref")
    s = sp.add_parser("path"); s.add_argument("a"); s.add_argument("b")
    for s in sp.choices.values():
        s.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
    return p


# ---------------------------------------------------------------- edge
def edge(g, a):
    """A footprint's courtyard against the board outline: inside it, crossing it or outside; the nearest Edge.Cuts item
    with the distance to it and the direction from the courtyard's nearest point to that edge point, or from the
    footprint's centre when the courtyard crosses the outline (KiCad's y grows downwards), for judging whether a
    connector sits at an edge and opens outwards; the footprint's side and rotation."""
    if a.ref not in g.fps:
        raise SystemExit("bq: no footprint %s" % a.ref)
    f = g.fps[a.ref]
    side = "B" if f.IsFlipped() else "F"
    cy = f.GetCourtyard(boardgeo.SIDE[side][3])
    if not cy.OutlineCount():
        raise SystemExit("bq: %s has no courtyard on %s" % (a.ref, side))
    cy = pcbnew.SHAPE_POLY_SET(cy)
    o = cy.Outline(0)
    inside = sum(g.inside(o.CPoint(i).x, o.CPoint(i).y) for i in range(o.PointCount()))
    where = "inside" if inside == o.PointCount() else "outside" if inside == 0 else "crossing"
    edges = {id(it): it for c in g.grid[g.ln(pcbnew.Edge_Cuts)].cells.values() for it in c}
    if not edges:
        raise SystemExit("bq: the board has no Edge.Cuts")
    # measured to the outline's boundary segments, since a closed Edge.Cuts shape (a circle, a closed polyline) is
    # filled and measures 0 from anything inside it; holes are the board's slots and round cut-outs, polygonised
    best = None
    for i in range(g.outline.OutlineCount()):
        for chain in [g.outline.Outline(i)] + [g.outline.Hole(i, j) for j in range(g.outline.HoleCount(i))]:
            for k in range(chain.SegmentCount()):
                s = chain.CSegment(k)
                seg = pcbnew.SHAPE_SEGMENT(s.A, s.B, 0)
                d = dist(cy, seg)
                if best is None or d < best[0]:
                    best = (d, seg)
    d, seg = best
    if where == "inside" and d == 0:
        where = "crossing"
    pa, pb = nearest(cy, seg)
    it = min(edges.values(), key=lambda e: dist(point(pb.x, pb.y), e.shape))
    # the direction from the courtyard's nearest point to the edge is normal to the edge; a crossing courtyard has
    # pa == pb, so take the footprint's centre instead
    dx, dy = pb.x - pa.x, pb.y - pa.y
    if dx == 0 and dy == 0:
        dx, dy = pb.x - f.GetPosition().x, pb.y - f.GetPosition().y
    towards = ("+x (right)" if dx > 0 else "-x (left)") if abs(dx) >= abs(dy) else ("+y (down)" if dy > 0 else "-y (up)")
    res = dict(cmd="edge", ref=a.ref, side=side, rotation=round(f.GetOrientationDegrees(), 1), courtyard=where,
               edge=dict(dist=f3(d), item=desc(it), at=at(pb), courtyard_at=at(pa), towards=towards))
    txt = ["edge %s: side %s, rotation %.1f, courtyard %s the outline; nearest edge %.3f mm at (%.3f,%.3f), towards %s" % (
        a.ref, side, res["rotation"], where, res["edge"]["dist"], f3(pb.x), f3(pb.y), towards)]
    return res, txt


# ---------------------------------------------------------------- path
class Line:
    """A track's or arc's centreline: its length and the point at a fraction of it, nm."""

    def __init__(self, t):
        self.len = t.GetLength()
        self.a, self.b = t.GetStart(), t.GetEnd()
        self.arc = None
        if t.GetClass() == "PCB_ARC":
            t = t.Cast()
            c = t.GetCenter()
            self.arc = (c.x, c.y, t.GetRadius(), math.radians(t.GetArcAngleStart().AsDegrees()), math.radians(t.GetAngle().AsDegrees()))

    def at(self, f):
        if self.arc:
            cx, cy, r, a0, sweep = self.arc
            return cx + r * math.cos(a0 + f * sweep), cy + r * math.sin(a0 + f * sweep)
        return self.a.x + (self.b.x - self.a.x) * f, self.a.y + (self.b.y - self.a.y) * f

    def frac(self, x, y):
        """Fraction of the length at the centreline point nearest (x, y)."""
        if self.arc:
            cx, cy, r, a0, sweep = self.arc
            d = (math.atan2(y - cy, x - cx) - a0) % (2 * math.pi)
            if sweep < 0:
                d = (2 * math.pi - d) % (2 * math.pi)   # the angle run in the arc's own direction
            s = abs(sweep)
            if d <= s:
                return d / s if s else 0.0
            return 1.0 if d - s < 2 * math.pi - d else 0.0   # beyond the arc: its nearer end
        dx, dy = self.b.x - self.a.x, self.b.y - self.a.y
        n = dx * dx + dy * dy
        return min(max(((x - self.a.x) * dx + (y - self.a.y) * dy) / n, 0.0), 1.0) if n else 0.0

    def span(self, f0, shape):
        """The stretch of the centreline around fraction f0 that lies inside `shape`, as two fractions ((f0, f0) when
        the point at f0 is outside it)."""
        def inside(u):
            return hit(point(*self.at(u)), shape, 0)
        if not inside(f0):
            return f0, f0
        out = []
        for lim in (0.0, 1.0):
            lo, hi = f0, lim
            if inside(lim):
                lo = lim
            else:
                for _ in range(30):
                    mid = (lo + hi) / 2
                    lo, hi = (mid, hi) if inside(mid) else (lo, mid)
            out.append(lo)
        return tuple(out)


def path_pads(g, spec):
    """The pads named REF.PAD (several when a footprint repeats the number)."""
    ref, _, num = spec.rpartition(".")
    if ref not in g.fps:
        raise SystemExit("bq: no footprint %s (path takes REF.PAD)" % (ref or spec))
    ps = [p for p in g.fps[ref].Pads() if p.GetNumber() == num]
    if not ps:
        raise SystemExit("bq: no pad %s" % spec)
    return ps


def copper_graph(g, code):
    """The net's tracks, arcs, pads and vias (no zone fills) as a graph. A pad or via is one item on every layer. A track
    end joins a pad or via whose copper on its layer is within half the track width (KiCad's connectivity) at a port, the
    point where its centreline leaves that copper, so the part of the track inside it is not counted; the ports of one
    pad or via, and of two that touch, join each other at their straight distance. A track end on another track's copper
    joins it at that end or, mid-track, at the nearest centreline point.
    Returns adjacency {node: [(node, nm, label)]} (label: the track's uuid, or "through" inside a pad or via), the
    ports [(pad or via uuid, x, y)], the pads and vias {uuid: [Item per layer]}, their ports {uuid: [node]}, the
    tracks {uuid: (Item, Line)} and which pads and vias touch {uuid: {uuid}}."""
    its = {}
    for L, grid in g.grid.items():
        for c in grid.cells.values():
            for it in c:
                if it.code == code and it.kind in ("pad", "via", "track", "arc"):
                    its[id(it)] = it
    uid = {id(it): it.obj.m_Uuid.AsString() for it in its.values()}
    hubs = collections.defaultdict(list)
    for k, it in its.items():
        if it.kind in ("pad", "via"):
            hubs[uid[k]].append(it)
    tracks = {uid[k]: (it, Line(it.obj)) for k, it in its.items() if it.kind in ("track", "arc")}
    adj, ports, hub_ports = collections.defaultdict(list), [], collections.defaultdict(list)
    atts = {u: [(0.0, (u, 0)), (1.0, (u, 1))] for u in tracks}

    def edge(m, n, d, lab):
        adj[m].append((n, d, lab))
        adj[n].append((m, d, lab))

    def port(v, u, t):
        node = ("port", len(ports))
        ports.append((v,) + tracks[u][1].at(t))
        hub_ports[v].append(node)
        atts[u].append((t, node))

    for u, (it, line) in tracks.items():
        w = it.obj.GetWidth()
        for end, p in ((0, line.a), (1, line.b)):
            node = (u, end)
            for o in g.query(it.layer, (p.x, p.y, p.x, p.y), w):
                if id(o) not in its or o is it:
                    continue
                v = uid[id(o)]
                if o.kind in ("pad", "via"):
                    if hit(point(p.x, p.y), o.shape, w // 2):
                        port(v, u, line.span(end, o.shape)[1 - end])
                elif hit(point(p.x, p.y), o.shape, 0):
                    oline, ow = tracks[v][1], o.obj.GetWidth()
                    near = [k for k, q in ((0, oline.a), (1, oline.b)) if math.hypot(q.x - p.x, q.y - p.y) <= max(w, ow) / 2]
                    if near:
                        edge(node, (v, near[0]), 0, None)
                    else:
                        atts[v].append((oline.frac(p.x, p.y), node))
        # a pad or via whose centre lies on the track's copper (KiCad joins it there, also away from the track's
        # ends): ports where the centreline enters and leaves its copper
        for o in g.query(it.layer, it.box):
            if id(o) in its and o.kind in ("pad", "via"):
                q = o.obj.GetPosition()
                if hit(point(q.x, q.y), it.shape, 0):
                    for t in line.span(line.frac(q.x, q.y), o.shape):
                        port(uid[id(o)], u, t)
    for u, lst in atts.items():
        lst.sort(key=lambda e: e[0])
        for (f1, m), (f2, n) in zip(lst, lst[1:]):
            edge(m, n, tracks[u][1].len * (f2 - f1), u)
    touch = collections.defaultdict(set)
    for k, it in its.items():
        if it.kind in ("pad", "via"):
            for o in g.query(it.layer, it.box):
                if id(o) in its and o.kind in ("pad", "via") and uid[id(o)] != uid[k] and hit(it.shape, o.shape, 0):
                    touch[uid[k]].add(uid[id(o)])
    # 1 nm over the straight distance: on a tie the path stays on its track, so a via it only runs past is not entered
    for v, ps in list(hub_ports.items()):
        for o in {v} | touch[v]:
            for p in ps:
                for q in hub_ports[o]:
                    if p < q:
                        edge(p, q, math.hypot(ports[p[1]][1] - ports[q[1]][1], ports[p[1]][2] - ports[q[1]][2]) + 1, "through")
    return adj, ports, hubs, hub_ports, tracks, touch


def path(g, a):
    """Routed copper between two pads of one net, or from a pad to the nearest same-net via reachable from it, along
    tracks, arcs, vias and pads only (zone fills are not copper here): Dijkstra over copper_graph from the first pad's
    copper edge to the last pad's or via's. Every via the path enters is counted. With the straight pad-edge gap for
    comparison (on any layers); two pads of different nets give the straight gap only."""
    A = path_pads(g, a.a)
    B = None if a.b == "via" else path_pads(g, a.b)
    code, netname = A[0].GetNetCode(), A[0].GetNetname()
    for spec, P in ((a.a, A), (a.b, B or [])):
        for p in P:
            if p.GetNetCode() != P[0].GetNetCode():
                raise SystemExit("bq: %s has pads on %s and %s; path takes pads of one net each" % (
                    spec, P[0].GetNetname(), p.GetNetname()))

    def pad_gap(P, Q):
        return f3(min(dist(p.GetEffectiveShape(lp), q.GetEffectiveShape(lq)) for p in P for q in Q
                      for lp in g.cu if p.IsOnLayer(lp) for lq in g.cu if q.IsOnLayer(lq)))

    if B and B[0].GetNetCode() != code:
        res = dict(cmd="path", a=a.a, b=a.b, net=netname, net_b=B[0].GetNetname(), length=None, vias=None, layers=None,
                   items=None, gap=pad_gap(A, B), joined=None)
        return res, ["path %s %s nets %s and %s: different nets, no copper path; straight gap %.3f mm" % (
            a.a, a.b, netname, res["net_b"], res["gap"])]
    adj, ports, hubs, hub_ports, tracks, touch = copper_graph(g, code)
    src = {p.m_Uuid.AsString() for p in A}
    dst = {p.m_Uuid.AsString() for p in B} if B else {v for v, its in hubs.items() if its[0].kind == "via"}

    def gap_to(h, port):
        return min(dist(point(*ports[port[1]][1:]), it.shape) for it in hubs[h])

    # S and T stand for the two ends: a port starts or ends the path at its distance from the end pad's copper (a port
    # of a touching pad or via, such as a via in the pad, included), which is not 0 when a track only touches the pad
    for h in src:
        for o in {h} | touch[h]:
            for port in hub_ports[o]:
                adj["S"].append((port, gap_to(h, port), ("from", h)))
            if o in dst:
                adj["S"].append(("T", 0, ("touch", h, o)))
    for h in dst:
        for o in {h} | touch[h]:
            for port in hub_ports[o]:
                adj[port].append(("T", gap_to(h, port), ("to", h)))
    best, prev, heap, n = {"S": 0}, {}, [(0, 0, "S")], 0
    while heap:
        d, _, u = heapq.heappop(heap)
        if u == "T":
            break
        if d > best[u]:
            continue
        for v, w, lab in adj[u]:
            if d + w < best.get(v, float("inf")):
                best[v], prev[v] = d + w, (u, lab, w)
                n += 1
                heapq.heappush(heap, (d + w, n, v))
    res = dict(cmd="path", a=a.a, b=a.b, net=netname, length=None, vias=None, layers=None, items=None, gap=None, joined=None)
    if "T" not in best:
        # no track path: KiCad's connectivity, which counts zone fills, says whether a fill joins them
        cn = conn(g)
        joined = any((i.Type() == pcbnew.PCB_PAD_T and i.m_Uuid.AsString() in dst) if B else i.Type() == pcbnew.PCB_VIA_T
                     for p in A for i in cn.GetConnectedItems(p))
        res["joined"] = "fill" if joined else None
        if B:
            res["gap"] = pad_gap(A, B)
        txt = ["path %s %s net %s: %s%s" % (a.a, a.b, netname, "no track path; joined through a fill" if joined else "not connected",
                                             ", straight gap %.3f mm" % res["gap"] if res["gap"] is not None else "")]
        return res, txt
    steps, u = [], "T"
    while u != "S":
        steps.append((u,) + prev[u][1:])
        u = prev[u][0]
    steps.reverse()
    items, end = [], None

    def add_hub(h):
        if not items or items[-1].get("uuid") != h:
            it = hubs[h][0] if h in hubs else None
            items.append(dict(kind="via", at=at(it.obj.GetPosition()), uuid=h) if it and it.kind == "via" else
                         dict(kind="pad", name=it.name() if it else a.a, uuid=h))

    for i, (node, lab, d) in enumerate(steps):
        if isinstance(lab, tuple):          # an end: the pad itself, then the touching pad or via the port is on
            add_hub(lab[1])
            if d:
                items[-1]["through"] = items[-1].get("through", 0) + d
            if lab[0] == "touch":
                add_hub(lab[2])
            end = lab[2] if lab[0] == "touch" else lab[1] if lab[0] == "to" else end
        elif lab == "through":
            items[-1]["through"] = items[-1].get("through", 0) + d
        elif lab is not None:
            if items and items[-1].get("uuid") == lab:
                items[-1]["length"] += d
            else:
                items.append(dict(kind=tracks[lab][0].kind, layer=tracks[lab][0].layer, length=d, uuid=lab))
        # a port the path only runs past along its track does not enter that pad or via
        if node != "T" and node[0] == "port" and (not isinstance(lab, str) or not isinstance(steps[i + 1][1], str) or
                                                  "through" in (lab, steps[i + 1][1])):
            add_hub(ports[node[1]][0])
    for e in items:
        for k in ("length", "through"):
            if k in e:
                e[k] = f3(e[k])
    layers = list(dict.fromkeys(e["layer"] for e in items if "layer" in e))
    last = hubs[end][0].obj
    gap = min(dist(p.GetEffectiveShape(la), last.GetEffectiveShape(lb)) for p in A
              for la in g.cu if p.IsOnLayer(la) for lb in g.cu if last.IsOnLayer(lb))
    res.update(length=f3(best["T"]), vias=sum(e["kind"] == "via" for e in items), layers=layers, items=items, gap=f3(gap),
               joined="tracks")

    def show(e):
        s = "pad " + e["name"] if e["kind"] == "pad" else "via (%.3f, %.3f)" % tuple(e["at"]) if e["kind"] == "via" else \
            "%s %s %.3f" % (e["kind"], e["layer"], e["length"])
        return s + (" through %.3f" % e["through"] if e.get("through") else "")

    txt = ["path %s %s net %s: %.3f mm routed, %d vias, layers %s; straight gap %.3f mm" % (
        a.a, a.b, netname, res["length"], res["vias"], ",".join(layers) or "-", res["gap"]),
           "  " + " > ".join(show(e) for e in items)]
    return res, txt


CMDS = dict(near=near, clearance=clearance, via=via, corridor=corridor, labels=labels, pads=pads, net=net, zones=zones, score=score,
            edge=edge, path=path)


def run(g, argv, js):
    a = parser().parse_args(argv)
    res, txt = CMDS[a.cmd](g, a)
    print(json.dumps(res) if (js or a.json) else "\n".join(txt), flush=True)


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    g = boardgeo.Geo(sys.argv[1])
    rest = sys.argv[2:]
    if rest[0] == "-":
        js = "--json" in rest[1:]
        for line in sys.stdin:
            if line.strip() and not line.lstrip().startswith("#"):
                try:
                    run(g, shlex.split(line), js)
                except SystemExit as e:
                    print(json.dumps(dict(error=str(e), query=line.strip())) if js else "error: %s (%s)" % (e, line.strip()), flush=True)
    else:
        run(g, rest, False)


if __name__ == "__main__":
    main()
