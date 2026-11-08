"""Board edits on a copy: `apply` applies lists of edits to a copy of a board with pcbnew, saves it with the zones refilled and puts the project files beside it; a copy that passed its checks goes in place of the open board with put.py.
usage: "$PY" edit.py apply <in.kicad_pcb> <out.kicad_pcb> ops.json [ops.json ...]   (mm, degrees, KiCad layer names, full net names; ops.json is an object of lists, files concatenated per key and applied in this order: "del": [uuid or unique uuid prefix of a track, arc or via], "trk": [[net, layer, [[x, y], ...], width]] a polyline, "via": [[net, x, y, size, drill]] through, "flip": [[ref, "F"|"B"]] side, "rot": [[ref, deg]] absolute orientation, "mv": [[ref, dx, dy]], "mvto": [[ref, x, y]], "fp": [[src_ref, new_ref, x, y, {pad_num: net or ""}]] a copy of a footprint under a new reference for a trial placement, on the source's side and at its rotation, its unlisted pads without a net (flip, rot, mv, mvto and pad on the new reference go in a following apply; put.py refuses a copy that has it: footprints come from the schematic), "pad": [[ref, num, net or ""]] every pad with that number; apply exits naming it and writes nothing on an unknown key, a missing uuid, ref, pad, net or layer, an fp new_ref that already exists, a pad op on a pad with a track, arc or via attached, or a track or via that KiCad's connectivity moves to another net when the board is saved (new copper whose pads all belong to one other net, e.g. a track drawn onto another net's pad); copper between pads of two nets is a short apply does not refuse, drc.sh on the copy finds it)
needs: KiCad's bundled Python with pcbnew ($PY), e.g. /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3"""
import sys, os, json, shutil, argparse, collections
import pcbnew

V = pcbnew.VECTOR2I
OPS = ("del", "trk", "via", "flip", "rot", "mv", "mvto", "fp", "pad")  # apply's keys, in the order it applies them
FLIP = pcbnew.FLIP_DIRECTION_TOP_BOTTOM  # KiCad's default flip (Flip left/right off)
VIA_KIND = {pcbnew.VIATYPE_BLIND: "blind ", pcbnew.VIATYPE_BURIED: "buried ", pcbnew.VIATYPE_MICROVIA: "micro "}


def load(path):
    b = pcbnew.LoadBoard(path)
    if b is None:
        sys.exit("edit: cannot load %s" % path)
    return b


def nm(v):
    return int(round(v * 1e6))


def mm(v):
    return round(v / 1e6, 6)


def pt(p):
    return "(%g, %g)" % (mm(p.x), mm(p.y))


def desc(t):
    """A track, arc or via in one line: kind, net, layers, geometry."""
    b = t.GetBoard()
    if t.GetClass() == "PCB_VIA":
        return "%svia %s at %s %s-%s size %g drill %g" % (
            VIA_KIND.get(t.GetViaType(), ""), t.GetNetname(), pt(t.GetPosition()), b.GetLayerName(t.TopLayer()),
            b.GetLayerName(t.BottomLayer()), mm(t.GetWidth(t.TopLayer())), mm(t.GetDrillValue()))
    arc = t.GetClass() == "PCB_ARC"
    return "%s %s %s %s-%s%s width %g" % ("arc" if arc else "track", t.GetNetname(), b.GetLayerName(t.GetLayer()),
                                          pt(t.GetStart()), pt(t.GetEnd()), " mid " + pt(t.GetMid()) if arc else "",
                                          mm(t.GetWidth()))


def apply(a):
    if os.path.realpath(a.out) == os.path.realpath(a.board):
        sys.exit("edit: out is the input board; apply never writes its input")
    b = load(a.board)
    ops = collections.defaultdict(list)
    for f in a.ops:
        for k, v in json.load(open(f)).items():
            ops[k].extend(v)
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    cu = set(b.GetEnabledLayers().CuStack())
    # a misspelt key ("dell") would otherwise be an edit that silently never happens
    missing = ["op %s" % k for k in ops if k not in OPS]

    def net(name):
        n = b.FindNet(name)
        if n is None:
            missing.append("net %s" % name)
        return n

    def layer(name):
        l = b.GetLayerID(name)
        if l not in cu:
            missing.append("copper layer %s" % name)
        return l

    def fp(ref):
        if ref not in fps:
            missing.append("footprint %s" % ref)
        return fps.get(ref)

    items = list(b.GetTracks())
    kill = {}
    for u in ops["del"]:
        hits = [t for t in items if t.m_Uuid.AsString().startswith(u)]
        if len(hits) == 1:
            kill[hits[0].m_Uuid.AsString()] = hits[0]
        else:
            missing.append("track, arc or via %s (%d matches)" % (u, len(hits)))
    trk = [(net(n), layer(l), pts, w) for n, l, pts, w in ops["trk"]]
    via = [(net(n), x, y, size, drill) for n, x, y, size, drill in ops["via"]]
    flip = [(fp(ref), side) for ref, side in ops["flip"]]
    missing += ["side %s of %s" % (side, ref) for ref, side in ops["flip"] if side not in ("F", "B")]
    rot = [(fp(ref), deg) for ref, deg in ops["rot"]]
    mv = [(fp(ref), dx, dy) for ref, dx, dy in ops["mv"]]
    mvto = [(fp(ref), x, y) for ref, x, y in ops["mvto"]]
    dup, taken = [], []
    for src, new, x, y, pn in ops["fp"]:
        f = fp(src)
        if new in fps or new in [d[1] for d in dup]:
            taken.append(new)
        nums = {p.GetNumber() for p in f.Pads()} if f else set()
        missing += ["pad %s.%s" % (src, num) for num in pn if f and num not in nums]
        dup.append((f, new, x, y, {num: net(n) if n else None for num, n in pn.items()}))
    pad, routed = [], []
    cn = b.GetConnectivity()
    for ref, num, n in ops["pad"]:
        f = fp(ref)
        pads = [p for p in f.Pads() if p.GetNumber() == str(num)] if f else []
        if f and not pads:
            missing.append("pad %s.%s" % (ref, num))
        pad.append((pads, net(n) if n else None))
        # Pad nets come from the schematic. On a pad with copper the op leaves that copper on the old net, a short
        # when the copper also reaches another pad of it; KiCad renets it on save only when it reaches no such pad.
        # Copper the same ops delete does not count.
        for p in pads:
            attached = [t.Cast() for t in cn.GetConnectedTracks(p) if t.m_Uuid.AsString() not in kill]
            if attached:
                routed.append("%s.%s (%s)" % (ref, p.GetNumber(), ", ".join(desc(t) for t in attached)))
    if missing or taken or routed:
        sys.exit("edit: %s; nothing written" % "; ".join(
            (["not on %s: %s" % (a.board, ", ".join(missing))] if missing else []) +
            (["fp new reference already taken: %s" % ", ".join(taken)] if taken else []) +
            (["pad op on a pad with copper: %s" % ", ".join(routed)] if routed else [])))

    # the net every track, arc and via must still have when the board is written: as loaded, or as its op says
    expect = {t.m_Uuid.AsString(): t.GetNetname() for t in items}
    for t in kill.values():
        b.Delete(t)
    for n, l, pts, w in trk:
        for p, q in zip(pts, pts[1:]):
            t = pcbnew.PCB_TRACK(b)
            t.SetStart(V(nm(p[0]), nm(p[1])))
            t.SetEnd(V(nm(q[0]), nm(q[1])))
            t.SetWidth(nm(w))
            t.SetLayer(l)
            t.SetNet(n)
            b.Add(t)
            expect[t.m_Uuid.AsString()] = n.GetNetname()
    for n, x, y, size, drill in via:
        v = pcbnew.PCB_VIA(b)
        v.SetViaType(pcbnew.VIATYPE_THROUGH)
        v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
        v.SetPosition(V(nm(x), nm(y)))
        v.SetWidth(nm(size))
        v.SetDrill(nm(drill))
        v.SetNet(n)
        b.Add(v)
        expect[v.m_Uuid.AsString()] = n.GetNetname()
    for f, side in flip:
        if f.IsFlipped() != (side == "B"):
            f.Flip(f.GetPosition(), FLIP)
    for f, deg in rot:
        f.SetOrientationDegrees(deg)
    for f, dx, dy in mv:
        f.Move(V(nm(dx), nm(dy)))
    for f, x, y in mvto:
        f.SetPosition(V(nm(x), nm(y)))
    for f, new, x, y, pn in dup:
        g = pcbnew.Cast_to_FOOTPRINT(f.Duplicate(False))
        g.SetReference(new)
        b.Add(g)
        g.SetPosition(V(nm(x), nm(y)))
        for p in g.Pads():
            n = pn.get(p.GetNumber())
            if n is None:
                p.SetNetCode(0)
            else:
                p.SetNet(n)
    for pads, n in pad:
        for p in pads:
            if n is None:
                p.SetNetCode(0)
            else:
                p.SetNet(n)
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    # SaveBoard rebuilds connectivity, and that gives a track or via the net of the pad it touches (a track drawn onto
    # another net's pad, copper on a pad whose net an op changed). The same rebuild here shows it before anything is written.
    b.BuildConnectivity()
    renet = ["%s, %s before (%s)" % (desc(t), expect[t.m_Uuid.AsString()], t.m_Uuid.AsString())
             for t in b.GetTracks() if t.GetNetname() != expect[t.m_Uuid.AsString()]]
    if renet:
        sys.exit("edit: KiCad's connectivity moves these to another net: %s; nothing written" % "; ".join(renet))
    pcbnew.SaveBoard(a.out, b, True)
    # drc.sh and kicad-cli read the netclasses and custom rules from the project files beside the board
    for ext in (".kicad_pro", ".kicad_dru"):
        src, dst = os.path.splitext(a.board)[0] + ext, os.path.splitext(a.out)[0] + ext
        if os.path.exists(src):
            shutil.copyfile(src, dst)
    print("wrote %s: %s" % (a.out, ", ".join("%s %d" % (k, len(ops[k])) for k in OPS)))


def main():
    ap = argparse.ArgumentParser(prog="edit.py")
    sp = ap.add_subparsers(dest="cmd", required=True)
    s = sp.add_parser("apply")
    s.add_argument("board")
    s.add_argument("out")
    s.add_argument("ops", nargs="+")
    apply(ap.parse_args())


if __name__ == "__main__":
    main()
