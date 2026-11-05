"""Footprint and silk inventory: per footprint side, position, mounting type (SMD/THT/unspec), flags, models, reference field; silk texts.
usage: inv.py board.kicad_pcb   (read-only; exit 1 if a fitted footprint - not DNP, board-only or excluded from position files - is unspec)
needs: KiCad's bundled Python with pcbnew, e.g. /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3"""
import pcbnew, sys
b = pcbnew.LoadBoard(sys.argv[1])
MM = 1e6
bb = b.GetBoardEdgesBoundingBox()
print("board", bb.GetLeft()/MM, bb.GetTop()/MM, bb.GetRight()/MM, bb.GetBottom()/MM)
LN = lambda l: b.GetLayerName(l)
nvis = nhid = 0
types = {"SMD": 0, "THT": 0, "unspec": 0}
unspec_fitted = []
for f in sorted(b.GetFootprints(), key=lambda f: f.GetReference()):
    r = f.Reference()
    p = f.GetPosition()
    vis = r.IsVisible() and r.GetLayer() in (pcbnew.F_SilkS, pcbnew.B_SilkS)
    if vis: nvis += 1
    else: nhid += 1
    a = f.GetAttributes()
    typ = "SMD" if a & pcbnew.FP_SMD else ("THT" if a & pcbnew.FP_THROUGH_HOLE else "unspec")
    types[typ] += 1
    flags = [n for bit, n in ((pcbnew.FP_DNP, "DNP"), (pcbnew.FP_EXCLUDE_FROM_BOM, "noBOM"),
                              (pcbnew.FP_EXCLUDE_FROM_POS_FILES, "noPOS"), (pcbnew.FP_BOARD_ONLY, "boardonly")) if a & bit]
    if typ == "unspec" and not a & (pcbnew.FP_DNP | pcbnew.FP_EXCLUDE_FROM_POS_FILES | pcbnew.FP_BOARD_ONLY):
        unspec_fitted.append(f.GetReference())
    extra = []
    for fl in f.GetFields():
        if fl is not r and fl.IsVisible() and fl.GetLayer() in (pcbnew.F_SilkS, pcbnew.B_SilkS):
            extra.append("%s=%r@%s(%.2f,%.2f)" % (fl.GetName(), fl.GetText(), LN(fl.GetLayer()), fl.GetPosition().x/MM, fl.GetPosition().y/MM))
    rp = r.GetPosition()
    print("%-9s %s fp(%.2f,%.2f,%g) %s %s models=%d ref:%s %s (%.2f,%.2f) a%g h%.2f w%.2f t%.3f %s %s" % (
        f.GetReference(), "B" if f.IsFlipped() else "F", p.x/MM, p.y/MM, f.GetOrientationDegrees(),
        typ, ",".join(flags) or "-", len(f.Models()),
        "VIS" if vis else "hid", LN(r.GetLayer()), rp.x/MM, rp.y/MM, r.GetTextAngleDegrees(), r.GetTextHeight()/MM,
        r.GetTextWidth()/MM, r.GetTextThickness()/MM, f.GetFPIDAsString().split(":")[-1][:30], " ".join(extra)))
print("visible refs", nvis, "hidden", nhid)
print("mounting SMD %d THT %d unspec %d" % (types["SMD"], types["THT"], types["unspec"]))
for d in b.GetDrawings():
    if d.GetClass() in ("PCB_TEXT", "PCB_TEXTBOX"):
        p = d.GetPosition()
        print("TEXT %s %r (%.2f,%.2f) a%g h%.2f w%.2f t%.3f mir%d uuid %s" % (LN(d.GetLayer()), d.GetText(), p.x/MM, p.y/MM, d.GetTextAngleDegrees(),
              d.GetTextHeight()/MM, d.GetTextWidth()/MM, d.GetTextThickness()/MM, d.IsMirrored(), d.m_Uuid.AsString()))
    elif d.GetLayer() in (pcbnew.F_SilkS, pcbnew.B_SilkS):
        bx = d.GetBoundingBox()
        print("GFX %s %s (%.2f,%.2f)-(%.2f,%.2f)" % (LN(d.GetLayer()), d.GetClass(), bx.GetLeft()/MM, bx.GetTop()/MM, bx.GetRight()/MM, bx.GetBottom()/MM))
print("unspec fitted %d%s" % (len(unspec_fitted), (": " + " ".join(unspec_fitted)) if unspec_fitted else ""))
sys.exit(1 if unspec_fitted else 0)
