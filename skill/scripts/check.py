"""Routing aesthetics report on a board JSON written by dump.py: findings grouped by rule R1, R2, R3, R6.
usage: check.py board.json [--quiet] [--max-bends=N]   (exit 1 on any R1/R2/R3/R6 finding)
needs: python3 with shapely (e.g. a venv: python3 -m venv v && v/bin/pip install shapely)

R1  a track leaves a pad from its centre along the pad axis (0/90 deg to the pad; round pads and
    vias any multiple of 45 deg) and bends only after it has cleared the pad (first bend vertex
    at least w/2 outside the pad copper).
R2  a track end lies on a pad centre, a via centre, or another track end of the same net and
    layer (a T onto the centreline of a same-net track is reported separately as info).
R3  every segment at 0/45/90 deg; no segment shorter than 0.5 mm; no acute (135 deg) turn;
    no jog (two opposite bends with a short middle segment); chains with more than N bends.
R6  no via under silkscreen or inside a footprint courtyard; no same-net crossing or overlap on
    one layer; no loop in a net's track graph; no pad wired to a via when a same-net via sits
    clearly nearer (straight-line distance at least 1 mm shorter than the wired path).
"""
import sys, json, math, collections
from shapely.geometry import Polygon, Point, LineString
from shapely.strtree import STRtree

args = [a for a in sys.argv[1:] if not a.startswith('--')]
quiet = '--quiet' in sys.argv
MAXB = 2
for a in sys.argv:
    if a.startswith('--max-bends='):
        MAXB = int(a.split('=')[1])
D = json.load(open(args[0]))
EPS = 0.005
F = collections.defaultdict(list)


def add(rule, msg, where=None):
    F[rule].append((msg, where))


def poly(pl):
    return Polygon(pl['outer'], pl['holes']).buffer(0)


def key(p):
    return (round(p[0], 3), round(p[1], 3))


def ang(a, b):
    return math.degrees(math.atan2(b[1] - a[1], b[0] - a[0])) % 360


def is_mult(a, step, tol=0.15):
    r = a % step
    return min(r, step - r) < tol


# ---- pads and vias
pads = []  # dict: ref,num,net,pos,rot,shape,round,polys{layer:shapely}
for f in D['fps']:
    for p in f['pads']:
        polys = {l: [poly(x) for x in pls] for l, pls in p['poly'].items()}
        rnd = p['shape'] == 0 or (p['shape'] == 2 and abs(p['size'][0] - p['size'][1]) < 1e-3)
        pads.append(dict(ref=f['ref'], num=p['num'], net=p['net'], pos=tuple(p['pos']), rot=p['rot'],
                         round=rnd, polys=polys, name=f"{f['ref']}.{p['num']}"))
vias = [dict(pos=tuple(v['pos']), d=v['d'], net=v['net'], c=Point(v['pos']).buffer(v['d'] / 2)) for v in D['vias']]

tracks = [t for t in D['tracks'] if not t.get('arc')]
for t in D['tracks']:
    if t.get('arc'):
        add('R3', f"arc track on {t['net']} {t['layer']} (arcs not expected)", t['a'])

# endpoint index per (net, layer)
ends = collections.defaultdict(list)  # (net,layer,key) -> [(track idx, end idx)]
for i, t in enumerate(tracks):
    ends[(t['net'], t['layer'], key(t['a']))].append((i, 0))
    ends[(t['net'], t['layer'], key(t['b']))].append((i, 1))


def pad_at(net, layer, pt):
    P = Point(pt)
    for p in pads:
        if p['net'] != net or layer not in p['polys']:
            continue
        if math.hypot(p['pos'][0] - pt[0], p['pos'][1] - pt[1]) > 6:
            continue
        for g in p['polys'][layer]:
            if g.covers(P):
                return p
    return None


def via_at(net, pt):
    for v in vias:
        if v['net'] == net and math.hypot(v['pos'][0] - pt[0], v['pos'][1] - pt[1]) <= v['d'] / 2 + 1e-6:
            return v
    return None


# ---- node classification
NODE = {}  # (net,layer,key) -> ('pad', pad) | ('via', via) | ('junction', n) | ('bend', 2) | ('end', 1)
for (net, layer, k), lst in ends.items():
    p = pad_at(net, layer, k)
    v = via_at(net, k) if p is None else None
    if p is not None:
        NODE[(net, layer, k)] = ('pad', p)
    elif v is not None:
        NODE[(net, layer, k)] = ('via', v)
    elif len(lst) >= 3:
        NODE[(net, layer, k)] = ('junction', len(lst))
    elif len(lst) == 2:
        NODE[(net, layer, k)] = ('bend', 2)
    else:
        NODE[(net, layer, k)] = ('end', 1)


def other(i, e):
    t = tracks[i]
    return t['b'] if e == 0 else t['a']


def here(i, e):
    t = tracks[i]
    return t['a'] if e == 0 else t['b']


# ---- R2: where track ends land
for (net, layer, k), (kind, obj) in NODE.items():
    if kind == 'pad':
        d = math.hypot(obj['pos'][0] - k[0], obj['pos'][1] - k[1])
        if d > EPS:
            add('R2', f"{net} {layer}: track ends {d:.3f} mm off the centre of pad {obj['name']}", k)
    elif kind == 'via':
        d = math.hypot(obj['pos'][0] - k[0], obj['pos'][1] - k[1])
        if d > EPS:
            add('R2', f"{net} {layer}: track ends {d:.3f} mm off the via centre at {obj['pos']}", k)
    elif kind == 'end':
        # T onto a same-net track centreline?
        P = Point(k)
        tee = False
        for j, t in enumerate(tracks):
            if t['net'] == net and t['layer'] == layer and LineString([t['a'], t['b']]).distance(P) < EPS:
                if key(t['a']) != k and key(t['b']) != k:
                    tee = True
                    break
        if tee:
            add('R2-info', f"{net} {layer}: T-junction onto a track centreline", k)
        else:
            add('R2', f"{net} {layer}: dangling track end (no pad, via or track)", k)

# ---- R3: segment angles and lengths
for i, t in enumerate(tracks):
    L = math.hypot(t['b'][0] - t['a'][0], t['b'][1] - t['a'][1])
    if L < 1e-6:
        add('R3', f"{t['net']} {t['layer']}: zero-length segment", t['a'])
        continue
    a = ang(t['a'], t['b'])
    if not is_mult(a, 45):
        add('R3', f"{t['net']} {t['layer']}: segment at {a:.1f} deg (not 0/45/90)", t['a'])
    if L < 0.5:
        # allowed only if it is a straight continuation (collinear vertex) - still report
        add('R3', f"{t['net']} {t['layer']}: segment {L:.2f} mm < 0.5 mm", t['a'])


# ---- chains between terminal nodes; bends, jogs, R1 pad exits
def is_terminal(n):
    return NODE[n][0] in ('pad', 'via', 'junction', 'end')


visited = set()
chains = []
for (net, layer, k), (kind, obj) in NODE.items():
    if not is_terminal((net, layer, k)):
        continue
    for (i, e) in ends[(net, layer, k)]:
        if (i, e) in visited:
            continue
        pts = [tuple(here(i, e))]
        segs = []
        ci, ce = i, e
        while True:
            visited.add((ci, ce))
            nxt = tuple(other(ci, ce))
            segs.append(ci)
            pts.append(nxt)
            nk = (net, layer, key(nxt))
            visited.add((ci, 1 - ce))
            if is_terminal(nk) or nk not in NODE:
                break
            # bend node: continue on the other track
            cand = [(j, f) for (j, f) in ends[nk] if j != ci]
            if not cand:
                break
            ci, ce = cand[0]
            if (ci, ce) in visited:
                break
        chains.append(dict(net=net, layer=layer, pts=pts, segs=segs, start=(net, layer, k), end=(net, layer, key(pts[-1]))))


def turn(a, b, c):
    a1 = ang(a, b)
    a2 = ang(b, c)
    d = (a2 - a1 + 540) % 360 - 180
    return d


for ch in chains:
    pts = ch['pts']
    bends = []
    for j in range(1, len(pts) - 1):
        d = turn(pts[j - 1], pts[j], pts[j + 1])
        if abs(d) > 0.2:
            bends.append((j, d))
            if abs(d) > 90.5:
                add('R3', f"{ch['net']} {ch['layer']}: acute turn of {abs(d):.0f} deg", pts[j])
    ch['bends'] = bends
    # jogs: two consecutive opposite bends with a short middle segment, ending parallel
    for (j1, d1), (j2, d2) in zip(bends, bends[1:]):
        mid = math.hypot(pts[j2][0] - pts[j1][0], pts[j2][1] - pts[j1][1])
        if d1 * d2 < 0 and abs(abs(d1) - abs(d2)) < 0.5 and mid < 1.5:
            add('R3', f"{ch['net']} {ch['layer']}: jog (S-bend, middle {mid:.2f} mm)", pts[j1])
    if len(bends) > MAXB:
        add('R3-review', f"{ch['net']} {ch['layer']}: {len(bends)} bends between {NODE[ch['start']][0]} and "
                         f"{NODE.get(ch['end'], ('?',))[0]}", pts[0])
    # R1 at both ends of the chain
    for side in (0, 1):
        n = ch['start'] if side == 0 else ch['end']
        if n not in NODE:
            continue
        kind, obj = NODE[n]
        if kind not in ('pad', 'via'):
            continue
        P = pts if side == 0 else pts[::-1]
        a = ang(P[0], P[1])
        w = tracks[ch['segs'][0] if side == 0 else ch['segs'][-1]]['w']
        if kind == 'pad':
            rel = (a - obj['rot']) % 360
            ok = is_mult(rel, 45) if obj['round'] else is_mult(rel, 90)
            if not ok:
                add('R1', f"{ch['net']} {ch['layer']}: leaves pad {obj['name']} at {rel:.0f} deg to its axis", P[0])
            shapes = obj['polys'][ch['layer']]
        else:
            if not is_mult(a, 45):
                add('R1', f"{ch['net']} {ch['layer']}: leaves via at {a:.0f} deg", P[0])
            shapes = [obj['c']]
        # first bend vertex must clear the pad by w/2
        bl = ch['bends'] if side == 0 else [(len(pts) - 1 - j, -d) for (j, d) in ch['bends'][::-1]]
        if bl:
            V = Point(P[bl[0][0]])
            dist = min(g.exterior.distance(V) if g.covers(V) else -g.distance(V) for g in shapes)
            inside = any(g.covers(V) for g in shapes)
            clear = min(g.distance(V) for g in shapes)
            if inside or clear < w / 2 - 0.01:
                tgt = obj['name'] if kind == 'pad' else 'via'
                add('R1', f"{ch['net']} {ch['layer']}: bends {clear:.2f} mm from {tgt} (needs >= {w/2:.2f})", P[bl[0][0]])

# ---- R6: vias under silk / inside courtyards
silk = [poly(pl) for s in D['silk'] for pl in s['poly']]
silk_tree = STRtree(silk)
cy = []
cy_ref = []
for f in D['fps']:
    for c in f['courtyard']:
        cy.append(poly(c))
        cy_ref.append(f['ref'])
cy_tree = STRtree(cy)
for v in vias:
    hit = [silk[i] for i in silk_tree.query(v['c']) if silk[i].intersects(v['c'])]
    if hit:
        add('R6', f"via {v['net']} at {v['pos']} under silkscreen", v['pos'])
    hc = [cy_ref[i] for i in cy_tree.query(v['c']) if cy[i].intersects(v['c'])]
    if hc:
        add('R6', f"via {v['net']} at {v['pos']} inside courtyard of {','.join(sorted(set(hc)))}", v['pos'])

# same-net crossings and overlaps
bylay = collections.defaultdict(list)
for i, t in enumerate(tracks):
    bylay[(t['net'], t['layer'])].append(i)
for (net, layer), idx in bylay.items():
    segs = [(i, LineString([tracks[i]['a'], tracks[i]['b']])) for i in idx]
    for x in range(len(segs)):
        for y in range(x + 1, len(segs)):
            i, A = segs[x]
            j, B = segs[y]
            if not A.intersects(B):
                continue
            inter = A.intersection(B)
            ea = {key(tracks[i]['a']), key(tracks[i]['b'])}
            eb = {key(tracks[j]['a']), key(tracks[j]['b'])}
            if inter.geom_type == 'Point':
                k = key((inter.x, inter.y))
                if k in ea and k in eb:
                    continue
                if k in ea or k in eb:
                    continue  # T-junction, reported under R2-info
                add('R6', f"{net} {layer}: same-net tracks cross", (inter.x, inter.y))
            elif inter.length > 0.02:
                add('R6', f"{net} {layer}: same-net tracks overlap for {inter.length:.2f} mm", tuple(inter.coords[0]))

# loops in a net's track graph (pads and vias as nodes, chains as edges)
parent = {}


def find(x):
    while parent.setdefault(x, x) != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


def node_id(n):
    kind, obj = NODE.get(n, ('?', None))
    if kind == 'pad':
        return ('pad', obj['name'])
    if kind == 'via':
        return ('via', key(obj['pos']))
    return ('pt', n[0], n[1], n[2])


for ch in chains:
    a, b = node_id(ch['start']), node_id(ch['end'])
    # vias join layers: a via node is the same on every layer, so ids above already merge them
    ra, rb = find(a), find(b)
    if ra == rb:
        add('R6', f"{ch['net']} {ch['layer']}: loop / doubled path (chain closes a cycle)", ch['pts'][0])
    else:
        parent[ra] = rb

# pad wired to a via when a nearer same-net via exists
for ch in chains:
    s, e = NODE.get(ch['start'], ('?',)), NODE.get(ch['end'], ('?',))
    for (pk, vk) in ((s, e), (e, s)):
        if pk[0] == 'pad' and vk[0] == 'via':
            pad, via = pk[1], vk[1]
            plen = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(ch['pts'], ch['pts'][1:]))
            best = min((math.hypot(v['pos'][0] - pad['pos'][0], v['pos'][1] - pad['pos'][1]), v['pos'])
                       for v in vias if v['net'] == pad['net'])
            if best[0] < plen - 1.0 and key(best[1]) != key(via['pos']):
                add('R6', f"{pad['net']}: pad {pad['name']} wired to a via {plen:.1f} mm away, a same-net via is "
                          f"{best[0]:.1f} mm away at {best[1]}", pad['pos'])

# ---- report
order = ['R1', 'R2', 'R3', 'R6', 'R3-review', 'R2-info']
tot = 0
for r in order:
    lst = F.get(r, [])
    if r in ('R1', 'R2', 'R3', 'R6'):
        tot += len(lst)
    print(f'== {r}: {len(lst)}')
    if not quiet:
        for msg, w in lst:
            ws = f' @({w[0]:.2f},{w[1]:.2f})' if w else ''
            print('  ', msg + ws)
nb = collections.Counter(len(c['bends']) for c in chains)
print('chains', len(chains), 'bend histogram', dict(sorted(nb.items())))
print('TOTAL R1+R2+R3+R6 findings:', tot)
sys.exit(1 if tot else 0)
