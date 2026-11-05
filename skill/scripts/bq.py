"""Board queries for layout agents: what is near a point, copper clearance between two items, legal via sites, a track corridor, legal designator spots, placement score (HPWL and airwire crossings of signal nets); compact text, or JSON with --json.
usage: "$PY" bq.py <board.kicad_pcb> near X Y [--r 2] [--layer L] | clearance A B | via X Y --net NET [--r 3] [--n 5] [--size D --drill d] | corridor X1 Y1 X2 Y2 --layer L --width W --net NET | labels REF | score [X1 Y1 X2 Y2] [--n 5]   (mm; A/B = REF, REF.PAD or net:NAME; cmd "-" reads one query per line from stdin, board loaded once; reads the saved file, zones refilled in memory; clearance, hole_clearance and edge_clearance rules of the .kicad_dru beside the board are applied, see boardgeo.py)
needs: KiCad's bundled Python with pcbnew ($PY), e.g. /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3; boardgeo.py beside this file"""
import sys, json, math, shlex, argparse, collections
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
    X1 Y1 X2 Y2 the crossing count and lists keep only crossings whose point lies in it; HPWL stays whole-board."""
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
    s = sp.add_parser("score"); s.add_argument("box", type=float, nargs="*"); s.add_argument("--n", type=int, default=5)
    for s in sp.choices.values():
        s.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
    return p


CMDS = dict(near=near, clearance=clearance, via=via, corridor=corridor, labels=labels, score=score)


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
