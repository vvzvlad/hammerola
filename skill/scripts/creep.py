"""Air gap and creepage between two isolation groups on a board JSON written by dump.py: on each copper layer and in plan view (every copper layer projected together), the shortest straight line between the groups' copper (pads, plated barrels, tracks, arcs, vias, zone fills) and the shortest path over the board's surface around its internal cut-outs (the holes of the board outline), with the copper items at both ends; ported from Wiren Board's wb-clearance (MIT): the visibility graph over the cut-outs' vertices is built once per board, and the path's ends are searched together with the path rather than fixed at the air gap's ends.
usage: creep.py board.json A B [--air MM] [--creep MM] [--near 6] [--json]   (A/B = class:NAME, every net of that net class (class:Default: the nets in no other class), or net:NAME; VIOLATION and exit 1 when a distance is below --air or --creep by any amount, no rounding; creepage is computed where the air gap is at most --near or below --creep, farther it is at least the air gap)
needs: python3 with shapely"""
import sys, json, math, heapq, argparse, itertools, collections
from shapely.geometry import Polygon, Point, LineString, box
from shapely.ops import unary_union, nearest_points
from shapely.prepared import prep

PTH = 0   # pcbnew.PAD_ATTRIB_PTH
# shapely's round buffers put their 64 vertices per turn on the circle, so the polygon lies inside it; this radius
# puts the polygon's sides on the circle instead, and no distance comes out larger than the copper's
GROW = 1 / math.cos(math.pi / 64)


def poly(pl):
    return Polygon(pl['outer'], pl['holes']).buffer(0)


def arc_points(a, m, b):
    """Points along the circular arc through a, m, b, at most 0.35 degrees apart: the chords stay within 5e-6 of the
    radius of the arc."""
    (ax, ay), (mx, my), (bx, by) = a, m, b
    d = 2 * (ax * (my - by) + mx * (by - ay) + bx * (ay - my))
    if abs(d) < 1e-12:
        return [a, b]
    ux = ((ax * ax + ay * ay) * (my - by) + (mx * mx + my * my) * (by - ay) + (bx * bx + by * by) * (ay - my)) / d
    uy = ((ax * ax + ay * ay) * (bx - mx) + (mx * mx + my * my) * (ax - bx) + (bx * bx + by * by) * (mx - ax)) / d
    r = math.hypot(ax - ux, ay - uy)
    t0, tm, t1 = (math.atan2(p[1] - uy, p[0] - ux) for p in (a, m, b))
    ccw = (tm - t0) % (2 * math.pi) < (t1 - t0) % (2 * math.pi)
    sweep = (t1 - t0) % (2 * math.pi) if ccw else -((t0 - t1) % (2 * math.pi))
    n = max(2, math.ceil(abs(sweep) / (2 * math.pi / 1024)))
    return [(ux + r * math.cos(t0 + sweep * i / n), uy + r * math.sin(t0 + sweep * i / n)) for i in range(n + 1)]


def members(D, spec):
    """The nets of class:NAME (a net in several classes counts in each) or net:NAME. KiCad 10 ends every net's list of
    classes with Default ("ISO,Default"), so class:Default is the nets in no other class."""
    kind, _, name = spec.partition(':')
    if kind == 'class':
        nets = {n for n, c in D['netclass'].items() if (c == 'Default' if name == 'Default' else name in c.split(','))}
    elif kind == 'net':
        nets = {name} & set(D['netclass'])
    else:
        raise SystemExit('creep: %s: a group is class:NAME or net:NAME' % spec)
    if not nets:
        raise SystemExit('creep: no net in %s' % spec)
    return nets


def copper(D, nets):
    """{layer: [(item, geometry)]}: the copper of these nets."""
    out = collections.defaultdict(list)
    for f in D['fps']:
        for p in f['pads']:
            if p['net'] not in nets:
                continue
            it = dict(kind='pad', name='%s.%s' % (f['ref'], p['num']), net=p['net'])
            for L, pls in p['poly'].items():
                out[L].append((dict(it, layer=L), unary_union([poly(x) for x in pls])))
            # a plated hole is copper on the layers where its pad is not flashed too
            if p['attr'] == PTH and max(p['drill']) > 0:
                for L in p['layers']:
                    if L not in p['poly']:
                        out[L].append((dict(it, layer=L, barrel=True), Point(p['pos']).buffer(max(p['drill']) / 2 * GROW)))
    for t in D['tracks']:
        if t['net'] in nets:
            pts = arc_points(t['a'], t['mid'], t['b']) if t.get('arc') else [t['a'], t['b']]
            out[t['layer']].append((dict(kind='arc' if t.get('arc') else 'track', net=t['net'], layer=t['layer'], uuid=t['uuid']),
                                    LineString(pts).buffer(t['w'] / 2 * GROW)))
    for v in D['vias']:
        if v['net'] in nets:
            for L in v['layers']:
                out[L].append((dict(kind='via', net=v['net'], layer=L, uuid=v['uuid']), Point(v['pos']).buffer(v['d'] / 2 * GROW)))
    for z in D['zones']:
        if z['net'] in nets and not z['rule_area']:
            for L, pls in z['fill'].items():
                for pl in pls:
                    out[L].append((dict(kind='zone', name=z['name'], net=z['net'], layer=L, uuid=z['uuid']), poly(pl)))
    return out


def context(D):
    """The board's cut-outs and the visibility graph over their vertices (straight segments through free surface),
    built once per board; None when the outline has no holes."""
    holes = [Polygon(h) for o in D['outline'] for h in o['holes']]
    if not holes:
        return None
    slots = unary_union(holes)
    nodes = [c for h in holes for c in h.exterior.coords[:-1]]
    x0, y0, x1, y1 = unary_union([Polygon(o['outer']) for o in D['outline']]).bounds
    free = prep(box(x0 - 5, y0 - 5, x1 + 5, y1 + 5).difference(slots).buffer(1e-6))
    adj = collections.defaultdict(list)
    for i, j in itertools.combinations(range(len(nodes)), 2):
        seg = LineString([nodes[i], nodes[j]])
        if free.covers(seg):
            adj[i].append((j, seg.length))
            adj[j].append((i, seg.length))
    return dict(slots=slots, free=free, nodes=nodes, adj=adj, count=len(holes))


def surface(a, b, ctx):
    """(length, points) of the shortest path over the surface from copper a to copper b around the cut-outs; (None,
    None) when none is found. The path's ends are not the air gap's: from each cut-out vertex the nearest point of
    each group starts a leg, so a path that starts where going around is shorter is found (wb-clearance measured
    5.115 mm from the air gap's ends where the true path was 4.053 at a 4.0 limit); a straight line between two such
    points that clears the cut-outs is tried too (a cut-out shorter than the approach)."""
    d = a.distance(b)
    pa, pb = nearest_points(a, b)
    straight = [(pa.x, pa.y), (pb.x, pb.y)]
    if d == 0 or ctx is None or not LineString(straight).intersects(ctx['slots']):
        return d, straight
    nodes, free = ctx['nodes'], ctx['free']
    ends = {}
    for tag, geom in (('A', a), ('B', b)):
        for k, nd in enumerate(nodes):
            q = nearest_points(geom, Point(nd))[0]
            seg = LineString([(q.x, q.y), nd])
            if seg.length == 0 or free.covers(seg):
                ends[(tag, k)] = ((q.x, q.y), seg.length)
    direct = None
    for k in range(len(nodes)):
        if ('A', k) in ends and ('B', k) in ends:
            seg = LineString([ends[('A', k)][0], ends[('B', k)][0]])
            if free.covers(seg) and (direct is None or seg.length < direct[0]):
                direct = (seg.length, [ends[('A', k)][0], ends[('B', k)][0]])
    best, prev, heap, n = {'A': 0.0}, {}, [(0.0, 0, 'A')], 0
    while heap:
        dd, _, u = heapq.heappop(heap)
        if u == 'B':
            break
        if dd > best[u]:
            continue
        if u == 'A':
            nbrs = [(k, ends[('A', k)][1]) for k in range(len(nodes)) if ('A', k) in ends] + ([('B', direct[0])] if direct else [])
        else:
            nbrs = ctx['adj'][u] + ([('B', ends[('B', u)][1])] if ('B', u) in ends else [])
        for v, w in nbrs:
            if dd + w < best.get(v, math.inf):
                best[v], prev[v] = dd + w, u
                n += 1
                heapq.heappush(heap, (dd + w, n, v))
    if 'B' not in best:
        return None, None
    idx = ['B']
    while idx[-1] != 'A':
        idx.append(prev[idx[-1]])
    idx.reverse()
    if len(idx) == 2:
        return direct
    return best['B'], [ends[('A', idx[1])][0]] + [nodes[k] for k in idx[1:-1]] + [ends[('B', idx[-2])][0]]


def at(items, p):
    """The item whose copper is nearest point p, with p."""
    it = min(items, key=lambda e: e[1].distance(Point(p)))[0]
    return dict(it, at=[round(p[0], 4), round(p[1], 4)])


def measure(name, A, B, ctx, a):
    ga, gb = unary_union([g for _, g in A]), unary_union([g for _, g in B])
    air = ga.distance(gb)
    pa, pb = nearest_points(ga, gb)
    row = dict(layer=name, air=dict(dist=round(air, 4), a=at(A, (pa.x, pa.y)), b=at(B, (pb.x, pb.y))), creep=None, violations=[])
    if a.air is not None and air < a.air:
        row['violations'].append('air')
    if air <= max(a.near, a.creep or 0):
        crp, pts = surface(ga, gb, ctx)
        row['creep'] = dict(dist=None if crp is None else round(crp, 4), path=pts and [[round(x, 4), round(y, 4)] for x, y in pts],
                            a=pts and at(A, pts[0]), b=pts and at(B, pts[-1]))
        if a.creep is not None and (crp is None or crp < a.creep):
            row['violations'].append('creep')
    return row


def show(e):
    return '%s %s %s (%.4f, %.4f)' % (e['kind'], e.get('name') or e['uuid'][:8], e['net'], e['at'][0], e['at'][1])


def main(argv=None):
    p = argparse.ArgumentParser(prog='creep.py')
    p.add_argument('board'); p.add_argument('a'); p.add_argument('b')
    p.add_argument('--air', type=float); p.add_argument('--creep', type=float); p.add_argument('--near', type=float, default=6.0)
    p.add_argument('--json', action='store_true')
    a = p.parse_args(argv)
    D = json.load(open(a.board))
    na, nb = members(D, a.a), members(D, a.b)
    ca, cb = copper(D, na), copper(D, nb)
    ctx = context(D)
    rows = [measure(L, ca[L], cb[L], ctx, a) for L in D['copper'] if ca.get(L) and cb.get(L)]
    rows.append(measure('plan', [e for L in ca for e in ca[L]], [e for L in cb for e in cb[L]], ctx, a))
    bad = sum(len(r['violations']) for r in rows)
    res = dict(a=a.a, b=a.b, nets_a=sorted(na), nets_b=sorted(nb), air=a.air, creep=a.creep, near=a.near,
               cutouts=ctx['count'] if ctx else 0, rows=rows, violations=bad)
    if a.json:
        print(json.dumps(res))
    else:
        print('creep %s (%d nets) %s (%d nets): %d cut-outs, limits air %s creep %s; %d violations' % (
            a.a, len(na), a.b, len(nb), res['cutouts'], a.air, a.creep, bad))
        for r in rows:
            e = r['air']
            print('  %-7s air   %8.4f %-9s %s ~ %s' % (r['layer'], e['dist'], 'VIOLATION' if 'air' in r['violations'] else '',
                                                    show(e['a']), show(e['b'])))
            c = r['creep']
            if c is None:
                print('  %-7s creep  not computed: air gap above %.4f' % ('', max(a.near, a.creep or 0)))
            elif c['dist'] is None:
                print('  %-7s creep  no path found around the cut-outs %s' % ('', 'VIOLATION' if 'creep' in r['violations'] else ''))
            else:
                print('  %-7s creep %8.4f %-9s %s ~ %s, path %s' % ('', c['dist'], 'VIOLATION' if 'creep' in r['violations'] else '',
                                                               show(c['a']), show(c['b']),
                                                               ' '.join('(%.4f, %.4f)' % tuple(q) for q in c['path'])))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
