"""Track geometry gate, script part (layout-rules.md, checks 1-5): prints the finding count per kind.
usage: geocheck.py board.kicad_pcb [findings.json]   (reads the saved file; exit 1 on any finding)
needs: KiCad's bundled Python with pcbnew, e.g. /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3"""
import pcbnew, sys, math, json, collections
TOL = 5000  # 0.005 mm in nm
b = pcbnew.LoadBoard(sys.argv[1])
MM = 1e6
tracks = [t for t in b.GetTracks() if t.GetClass() == "PCB_TRACK"]
vias = [t for t in b.GetTracks() if t.GetClass() == "PCB_VIA"]
pads = [p for f in b.GetFootprints() for p in f.Pads()]
findings = []
def add(kind, net, x, y, layer, msg):
    findings.append(dict(kind=kind, net=net, x=round(x/MM, 3), y=round(y/MM, 3), layer=layer, msg=msg))
def P(v): return (v.x, v.y)
def d2(a, b): return math.hypot(a[0]-b[0], a[1]-b[1])
def seg_dist(p, a, b):
    ax, ay = a; bx, by = b; px, py = p
    dx, dy = bx-ax, by-ay; L2 = dx*dx+dy*dy
    if L2 == 0: return d2(p, a)
    t = max(0, min(1, ((px-ax)*dx+(py-ay)*dy)/L2))
    return math.hypot(px-(ax+t*dx), py-(ay+t*dy))
def ang(a, b): return math.degrees(math.atan2(b[1]-a[1], b[0]-a[0]))
# 1. direction
for t in tracks:
    a, c = P(t.GetStart()), P(t.GetEnd())
    if a == c: continue
    th = ang(a, c) % 45
    if min(th, 45-th) > 0.5:
        add("direction", t.GetNetname(), (a[0]+c[0])/2, (a[1]+c[1])/2, t.GetLayerName(), "angle %.2f" % (ang(a, c)))
# index
bylayer = collections.defaultdict(list)
for t in tracks: bylayer[(t.GetNetCode(), t.GetLayer())].append(t)
padsby = collections.defaultdict(list)
for p in pads:
    for l in p.GetLayerSet().CuStack():
        padsby[(p.GetNetCode(), l)].append(p)
viasby = collections.defaultdict(list)
for v in vias: viasby[v.GetNetCode()].append(v)
def pad_on(p, pt, layer):
    return p.HitTest(pcbnew.VECTOR2I(int(pt[0]), int(pt[1])))
# 2. track ends
endinfo = {}
for t in tracks:
    for which, e in (("s", P(t.GetStart())), ("e", P(t.GetEnd()))):
        net, L = t.GetNetCode(), t.GetLayer()
        kind = None
        for p in padsby[(net, L)]:
            if d2(P(p.GetPosition()), e) <= TOL: kind = ("pad", p); break
        if not kind:
            for v in viasby[net]:
                if d2(P(v.GetPosition()), e) <= TOL and v.IsOnLayer(L): kind = ("via", v); break
        if not kind:
            for o in bylayer[(net, L)]:
                if o is t: continue
                if d2(P(o.GetStart()), e) <= TOL or d2(P(o.GetEnd()), e) <= TOL: kind = ("track", o); break
            if not kind:
                for o in bylayer[(net, L)]:
                    if o is t: continue
                    if seg_dist(e, P(o.GetStart()), P(o.GetEnd())) <= TOL: kind = ("tee", o); break
        endinfo[(id(t), which)] = kind
        if not kind:
            # on a pad but not at centre?
            onpad = [p for p in padsby[(net, L)] if pad_on(p, e, L)]
            add("end_off_center" if onpad else "dangling", t.GetNetname(), e[0], e[1], t.GetLayerName(),
                ("on pad %s.%s off centre" % (onpad[0].GetParentFootprint().GetReference(), onpad[0].GetNumber())) if onpad else "end not on pad/via/track")
# adjacency at a point: tracks on same net/layer meeting at that point
def tracks_at(net, L, pt, excl):
    return [o for o in bylayer[(net, L)] if o is not excl and (d2(P(o.GetStart()), pt) <= TOL or d2(P(o.GetEnd()), pt) <= TOL)]
def other_end(t, pt):
    return P(t.GetEnd()) if d2(P(t.GetStart()), pt) <= TOL else P(t.GetStart())
# 3. pad exit
for t in tracks:
    for which, e in (("s", P(t.GetStart())), ("e", P(t.GetEnd()))):
        k = endinfo[(id(t), which)]
        if not k or k[0] != "pad": continue
        p = k[1]
        o = other_end(t, e)
        if d2(o, e) == 0: continue
        sh = p.GetShape(t.GetLayer())
        a = ang(e, o)
        poly = p.GetEffectivePolygon(t.GetLayer(), pcbnew.ERROR_INSIDE)
        if sh in (pcbnew.PAD_SHAPE_RECTANGLE, pcbnew.PAD_SHAPE_ROUNDRECT, pcbnew.PAD_SHAPE_OVAL, pcbnew.PAD_SHAPE_CHAMFERED_RECT, pcbnew.PAD_SHAPE_TRAPEZOID) or (sh == pcbnew.PAD_SHAPE_CUSTOM):
            if not (sh == pcbnew.PAD_SHAPE_CIRCLE):
                sz = p.GetSize(t.GetLayer())
                if not (sh == pcbnew.PAD_SHAPE_OVAL and sz.x == sz.y):
                    rel = (a - p.GetOrientationDegrees()) % 90
                    if min(rel, 90-rel) > 0.5:
                        add("pad_exit_diag", t.GetNetname(), e[0], e[1], t.GetLayerName(), "%s.%s exit %.1f deg rel pad" % (p.GetParentFootprint().GetReference(), p.GetNumber(), (a - p.GetOrientationDegrees()) % 360))
        # first bend outside pad copper by w/2
        nxt = tracks_at(t.GetNetCode(), t.GetLayer(), o, t)
        if len(nxt) == 1 and not any(d2(P(q.GetPosition()), o) <= TOL for q in padsby[(t.GetNetCode(), t.GetLayer())]) and not any(d2(P(v.GetPosition()), o) <= TOL for v in viasby[t.GetNetCode()]):
            a2 = ang(o, other_end(nxt[0], o))
            if abs(((a2 - a) + 180) % 360 - 180) > 0.5:
                # distance of bend point to pad copper
                dist = poly.SquaredDistance(pcbnew.VECTOR2I(int(o[0]), int(o[1]))) if hasattr(poly, "SquaredDistance") else None
                dd = math.sqrt(dist) if dist is not None else 0
                if poly.Contains(pcbnew.VECTOR2I(int(o[0]), int(o[1]))): dd = -1
                if dd < t.GetWidth()/2 - 1000:
                    add("bend_in_pad", t.GetNetname(), o[0], o[1], t.GetLayerName(), "%s.%s first bend %.3f mm from pad copper (< w/2 %.3f)" % (p.GetParentFootprint().GetReference(), p.GetNumber(), dd/MM, t.GetWidth()/2/MM))
# 4. jog: seg A - B - C with dir(A)==dir(C), B short (<1.5mm), B dir different
def direction(a, c): return ang(a, c)
for B in tracks:
    s, e = P(B.GetStart()), P(B.GetEnd())
    LB = d2(s, e)
    if LB >= 1.5*MM or LB == 0: continue
    As = tracks_at(B.GetNetCode(), B.GetLayer(), s, B)
    Cs = tracks_at(B.GetNetCode(), B.GetLayer(), e, B)
    if len(As) != 1 or len(Cs) != 1: continue
    A, C = As[0], Cs[0]
    if any(d2(P(v.GetPosition()), s) <= TOL for v in viasby[B.GetNetCode()]) or any(d2(P(v.GetPosition()), e) <= TOL for v in viasby[B.GetNetCode()]): continue
    da = ang(other_end(A, s), s); dc = ang(e, other_end(C, e)); db = ang(s, e)
    def eq(x, y): return abs(((x-y)+180) % 360 - 180) < 0.5
    if eq(da, dc) and not eq(da, db):
        add("jog", B.GetNetname(), (s[0]+e[0])/2, (s[1]+e[1])/2, B.GetLayerName(), "jog segment %.3f mm" % (LB/MM))
# 5a. same-net crossing / overlap
def inter(a, b, c, d):
    def cr(o, p, q): return (p[0]-o[0])*(q[1]-o[1]) - (p[1]-o[1])*(q[0]-o[0])
    d1, d2_, d3, d4 = cr(c, d, a), cr(c, d, b), cr(a, b, c), cr(a, b, d)
    return ((d1 > 0) != (d2_ > 0)) and ((d3 > 0) != (d4 > 0)) and d1 != 0 and d2_ != 0 and d3 != 0 and d4 != 0
for key, ts in bylayer.items():
    for i in range(len(ts)):
        for j in range(i+1, len(ts)):
            a, c = P(ts[i].GetStart()), P(ts[i].GetEnd()); bb, d = P(ts[j].GetStart()), P(ts[j].GetEnd())
            if inter(a, c, bb, d):
                add("cross", ts[i].GetNetname(), (a[0]+c[0])/2, (a[1]+c[1])/2, ts[i].GetLayerName(), "same-net crossing")
            else:
                # collinear overlap
                if seg_dist(bb, a, c) <= TOL and seg_dist(d, a, c) <= TOL and d2(a, c) > 0 and d2(bb, d) > 0:
                    add("overlap", ts[i].GetNetname(), (bb[0]+d[0])/2, (bb[1]+d[1])/2, ts[i].GetLayerName(), "same-net overlap")
                elif (seg_dist(bb, a, c) <= TOL and d2(bb, a) > TOL and d2(bb, c) > TOL and seg_dist(d, a, c) < 0.05*MM) or (seg_dist(a, bb, d) <= TOL and d2(a, bb) > TOL and d2(a, d) > TOL and seg_dist(c, bb, d) < 0.05*MM):
                    add("overlap", ts[i].GetNetname(), (bb[0]+d[0])/2, (bb[1]+d[1])/2, ts[i].GetLayerName(), "same-net partial overlap")
# 5b. loops: graph per net: nodes = rounded points per layer, vias join layers, pads join layers
class DSU:
    def __init__(s): s.p = {}
    def f(s, x):
        s.p.setdefault(x, x)
        while s.p[x] != x:
            s.p[x] = s.p[s.p[x]]; x = s.p[x]
        return x
    def u(s, a, b):
        a, b = s.f(a), s.f(b)
        if a == b: return False
        s.p[a] = b; return True
def node(net, L, pt):
    for p in padsby[(net, L)]:
        if d2(P(p.GetPosition()), pt) <= TOL: return ("pad", id(p))
    for v in viasby[net]:
        if d2(P(v.GetPosition()), pt) <= TOL: return ("via", id(v))
    return ("pt", L, round(pt[0]/2000), round(pt[1]/2000))
dsu = DSU()
for t in tracks:
    if d2(P(t.GetStart()), P(t.GetEnd())) == 0: continue
    a = node(t.GetNetCode(), t.GetLayer(), P(t.GetStart())); c = node(t.GetNetCode(), t.GetLayer(), P(t.GetEnd()))
    if not dsu.u(a, c):
        add("loop", t.GetNetname(), (t.GetStart().x+t.GetEnd().x)/2, (t.GetStart().y+t.GetEnd().y)/2, t.GetLayerName(), "track closes a loop")
# 5c. detour to via: pad -> (tracks only, no other pad) -> via ; another same-net via >=1mm closer than wired length
for p in pads:
    net = p.GetNetCode()
    if net <= 0: continue
    for L in p.GetLayerSet().CuStack():
        starts = [t for t in bylayer[(net, L)] if d2(P(t.GetStart()), P(p.GetPosition())) <= TOL or d2(P(t.GetEnd()), P(p.GetPosition())) <= TOL]
        for t0 in starts:
            # walk the chain
            cur, pt, length, seen = t0, P(p.GetPosition()), 0, set()
            while True:
                seen.add(id(cur))
                o = other_end(cur, pt); length += d2(pt, o); pt = o
                vv = [v for v in viasby[net] if d2(P(v.GetPosition()), pt) <= TOL]
                if vv:
                    v = vv[0]
                    best = min(((d2(P(w.GetPosition()), P(p.GetPosition())), w) for w in viasby[net] if w is not v), key=lambda x: x[0]) if len(viasby[net]) > 1 else None
                    if best and best[0] <= length - 1*MM and length > 0:
                        add("detour", p.GetNetname(), pt[0], pt[1], b.GetLayerName(L), "%s.%s wired %.2f mm to via, other via %.2f mm away" % (p.GetParentFootprint().GetReference(), p.GetNumber(), length/MM, best[0]/MM))
                    break
                if any(d2(P(q.GetPosition()), pt) <= TOL for q in padsby[(net, L)]): break
                nx = [q for q in tracks_at(net, L, pt, cur) if id(q) not in seen]
                if len(nx) != 1: break
                cur = nx[0]
c = collections.Counter(f["kind"] for f in findings)
print("geo findings:", len(findings), dict(sorted(c.items())))
if len(sys.argv) > 2:
    json.dump(findings, open(sys.argv[2], "w"), indent=0)
sys.exit(1 if findings else 0)
