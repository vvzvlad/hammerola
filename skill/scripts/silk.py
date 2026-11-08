"""Designators without the model: plans a legal spot for every reference (boardgeo.Labels candidates, greedy start + simulated annealing, fixed seed) and applies the plan to a closed board (pcbnew) or the live one (kipy); prints placed N of M and why each unplaced ref is unplaced.
usage: "$PY" silk.py plan <board.kicad_pcb> [--refs R1,R2] -o plan.json | "$PY" silk.py apply plan.json <board.kicad_pcb> | uv run --with 'kicad-python==0.8.0' python silk.py apply plan.json --live   (default refs: visible references minus mounting holes, fiducials, logos, test pads; an unplaced ref keeps its current spot)
needs: plan and file apply - KiCad's bundled Python with pcbnew ($PY), e.g. /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3, boardgeo.py beside this file; --live - kicad-python 0.8.0 and a running KiCad with its IPC API"""
import sys, json, math, random, time, re, argparse, collections

SKIP_FP = re.compile(r"MountingHole|Fiducial|FID_|Logo|TestPoint|TP_Probe", re.I)
SKIP_REF = re.compile(r"(H|MH|FID|TP|LOGO)\d+$")
UNPLACED = 30.0              # cost of a label left at its current spot
CONFLICT = (5.0, 300.0)      # weight of a clash between labels, raised linearly over the run
ORIENT = 0.3                 # neighbouring labels at different angles
NEIGHBOUR = 2000000          # part bodies this close (nm) are neighbours
STEPS = 400                  # annealing moves per label
TEMP = (3.0, 0.02)
SEED = 1
BIN = 4000000                # clash binning cell, nm


def nm(v):
    return int(round(v * 1e6))


def poses(b):
    """Position (nm), orientation and side of every footprint of a pcbnew board, by UUID."""
    return {f.m_Uuid.AsString(): dict(ref=f.GetReference(), x=f.GetPosition().x, y=f.GetPosition().y,
                                      angle=f.GetOrientationDegrees(), side="B" if f.IsFlipped() else "F")
            for f in b.GetFootprints()}


def refuse_moved(p, now):
    """Exits before any write when a footprint's position, orientation or side differs from the plan's."""
    was = p.get("footprints", {})
    bad = set()
    for k in set(was) | set(now):
        a, b = was.get(k), now.get(k)
        if (a is None or b is None or (a["x"], a["y"], a["side"]) != (b["x"], b["y"], b["side"])
                or abs((a["angle"] - b["angle"] + 180) % 360 - 180) > 1e-6):
            bad.add((a or b)["ref"])
    if bad:
        sys.exit("silk.py: footprints differ from the plan (moved, rotated, flipped, added or removed): %s; "
                 "nothing applied, re-run plan" % ", ".join(sorted(bad)))


def plan(a):
    sys.dont_write_bytecode = True  # no __pycache__ beside the installed scripts
    import boardgeo
    from boardgeo import clash, box_gap, LINE_GAP, TEXT_SIZE, TEXT_STROKE
    t0 = time.time()
    g = boardgeo.Geo(a.board)
    if a.refs:
        refs = a.refs.split(",")
    else:
        refs = [r for r, f in sorted(g.fps.items()) if f.Reference().IsVisible()
                and not SKIP_REF.match(r) and not SKIP_FP.search(f.GetFPIDAsString())]
    lg = boardgeo.Labels(g, refs)
    n = len(refs)
    cands, why, old, body = [], [], [], []
    for r in refs:
        c, w = lg.candidates(r)
        cands.append(c)
        why.append(w)
        old.append(lg.old(g.fps[r]))
        body.append(lg.body(g.fps[r]))

    def lab(i, s):
        """State -1 = the label stays at its current spot (None when hidden), s >= 0 = candidate s."""
        if s < 0:
            return old[i]
        return (cands[i][s]["box"], cands[i][s]["angle"])

    # clashes between states of different labels; two labels both left in place are not a clash of this plan
    conf = [[{} for _ in range(len(cands[i]) + 1)] for i in range(n)]
    bins = collections.defaultdict(list)
    for i in range(n):
        for s in range(-1, len(cands[i])):
            L = lab(i, s)
            if L is None:
                continue
            x0, y0, x1, y1 = L[0]
            for bx in range((x0 - LINE_GAP) // BIN, (x1 + LINE_GAP) // BIN + 1):
                for by in range((y0 - LINE_GAP) // BIN, (y1 + LINE_GAP) // BIN + 1):
                    bins[(bx, by)].append((i, s, L))
    for es in bins.values():
        for u in range(len(es)):
            i, s, L1 = es[u]
            for v in range(u + 1, len(es)):
                j, t, L2 = es[v]
                if i == j or (s < 0 and t < 0) or (j in conf[i][s + 1] and t in conf[i][s + 1][j]):
                    continue
                if clash(L1, L2):
                    conf[i][s + 1].setdefault(j, set()).add(t)
                    conf[j][t + 1].setdefault(i, set()).add(s)
    nbr = [[j for j in range(n) if j != i and box_gap(body[i], body[j]) <= NEIGHBOUR] for i in range(n)]
    state = [-1] * n

    def cost(i, s):
        return UNPLACED if s < 0 else cands[i][s]["cost"]

    def nconf(i, s):
        return sum(1 for j, ss in conf[i][s + 1].items() if state[j] in ss)

    def orient(i, s):
        if s < 0:
            return 0.0
        an = cands[i][s]["angle"]
        return ORIENT * sum(1 for j in nbr[i] if state[j] >= 0 and cands[j][state[j]]["angle"] != an)

    def fill():
        """Place every label left in place at its cheapest spot that clashes with nothing."""
        for i in sorted(range(n), key=lambda i: len(cands[i])):
            if state[i] < 0:
                for s in range(len(cands[i])):
                    if nconf(i, s) == 0:
                        state[i] = s
                        break

    fill()
    base = sum(cost(i, state[i]) for i in range(n)) + sum(orient(i, state[i]) for i in range(n)) / 2
    nclash = 0
    best, best_state = base, state[:]
    rng = random.Random(SEED)
    movable = [i for i in range(n) if cands[i]]
    steps = STEPS * len(movable)
    for k in range(steps):
        T = TEMP[0] * (TEMP[1] / TEMP[0]) ** (k / steps)
        W = CONFLICT[0] + (CONFLICT[1] - CONFLICT[0]) * k / steps
        i = rng.choice(movable)
        so, sn = state[i], rng.randrange(-1, len(cands[i]))
        if sn == so:
            continue
        db = cost(i, sn) - cost(i, so) + orient(i, sn) - orient(i, so)
        dc = nconf(i, sn) - nconf(i, so)
        d = db + W * dc
        if d <= 0 or rng.random() < math.exp(-d / T):
            state[i] = sn
            base += db
            nclash += dc
            if nclash == 0 and base < best - 1e-9:
                best, best_state = base, state[:]
    # the last state usually beats the best clash-free one but may keep a clash: leave clashing labels in place, refill
    changed = True
    while changed:
        changed = False
        for i in range(n):
            if state[i] >= 0 and nconf(i, state[i]):
                state[i] = -1
                changed = True
    fill()
    last = state[:]
    state[:] = best_state
    fill()

    def energy():
        return sum(cost(i, state[i]) + orient(i, state[i]) / 2 for i in range(n))

    e_best = energy()
    state[:] = last
    if energy() > e_best:
        state[:] = best_state
        fill()
    placed, unplaced = [], []
    for i, r in enumerate(refs):
        if state[i] >= 0:
            c = cands[i][state[i]]
            placed.append(dict(ref=r, x=c["x"] / 1e6, y=c["y"] / 1e6, angle=c["angle"], side=c["side"],
                               size=TEXT_SIZE / 1e6, stroke=TEXT_STROKE / 1e6))
            continue
        if not cands[i]:
            reason = "no legal candidate (rejected: %s)" % ", ".join("%s %d" % kv for kv in why[i].most_common())
        else:
            blockers = set()
            for s in range(len(cands[i])):
                for j, ss in conf[i][s + 1].items():
                    if state[j] in ss:
                        blockers.add(refs[j] + (" (current spot)" if state[j] < 0 else ""))
            reason = "lost a conflict to " + ", ".join(sorted(blockers))
        unplaced.append(dict(ref=r, reason=reason))
    json.dump(dict(board=a.board, placed=placed, unplaced=unplaced, footprints=poses(g.board)), open(a.o, "w"), indent=1)
    print("placed %d of %d in %.1f s -> %s" % (len(placed), n, time.time() - t0, a.o))
    for u in unplaced:
        print("  %s: %s" % (u["ref"], u["reason"]))


def apply_file(p, board):
    import pcbnew
    b = pcbnew.LoadBoard(board)
    refuse_moved(p, poses(b))
    for e in p["placed"]:
        t = b.FindFootprintByReference(e["ref"]).Reference()
        t.SetLayer(pcbnew.F_SilkS if e["side"] == "F" else pcbnew.B_SilkS)
        t.SetMirrored(e["side"] == "B")
        t.SetTextSize(pcbnew.VECTOR2I(nm(e["size"]), nm(e["size"])))
        t.SetTextThickness(nm(e["stroke"]))
        t.SetTextAngle(pcbnew.EDA_ANGLE(e["angle"], pcbnew.DEGREES_T))
        t.SetTextPos(pcbnew.VECTOR2I(nm(e["x"]), nm(e["y"])))
        t.SetVisible(True)
    pcbnew.SaveBoard(board, b, True)
    print("applied %d designators to %s" % (len(p["placed"]), board))


def apply_live(p):
    from kipy import KiCad
    from kipy.board_types import BoardLayer
    from kipy.geometry import Vector2
    board = KiCad().get_board()
    fps = {fp.reference_field.text.value: fp for fp in board.get_footprints()}
    refuse_moved(p, {fp.id.value: dict(ref=fp.reference_field.text.value, x=fp.position.x, y=fp.position.y,
                                       angle=fp.orientation.degrees, side="B" if fp.layer == BoardLayer.BL_B_Cu else "F")
                     for fp in board.get_footprints()})
    items = []
    for e in p["placed"]:
        fp = fps[e["ref"]]
        fld = fp.reference_field
        fld.layer = BoardLayer.BL_F_SilkS if e["side"] == "F" else BoardLayer.BL_B_SilkS
        fld.text.position = Vector2.from_xy(nm(e["x"]), nm(e["y"]))
        at = fld.text.attributes
        at.angle = e["angle"]
        at.size = Vector2.from_xy(nm(e["size"]), nm(e["size"]))
        at.stroke_width = nm(e["stroke"])
        at.mirrored = e["side"] == "B"
        fld.visible = True
        items.append(fp)
    board.update_items(items)
    print("applied %d designators to the live board" % len(items))


def main():
    ap = argparse.ArgumentParser(prog="silk.py")
    sp = ap.add_subparsers(dest="cmd", required=True)
    s = sp.add_parser("plan")
    s.add_argument("board")
    s.add_argument("--refs")
    s.add_argument("-o", required=True)
    s = sp.add_parser("apply")
    s.add_argument("plan")
    s.add_argument("board", nargs="?")
    s.add_argument("--live", action="store_true")
    a = ap.parse_args()
    if a.cmd == "plan":
        plan(a)
    elif a.live:
        apply_live(json.load(open(a.plan)))
    elif a.board:
        apply_file(json.load(open(a.plan)), a.board)
    else:
        ap.error("apply needs a board file or --live")


if __name__ == "__main__":
    main()
