"""Set each footprint's mounting type from its pads (SMD if it has an SMD pad, else THT if it has a PTH pad) and save to a new file.
usage: stepA.py in.kicad_pcb out.kicad_pcb   (footprints that are board-only or excluded from position files keep their attributes)
needs: KiCad's bundled Python with pcbnew, e.g. /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3"""
import pcbnew, sys
src, dst = sys.argv[1], sys.argv[2]
b = pcbnew.LoadBoard(src)
ntype = 0
for f in b.GetFootprints():
    a = f.GetAttributes()
    # non-components (mounting holes, test and joint pads) are not placed by the assembler
    if a & (pcbnew.FP_EXCLUDE_FROM_POS_FILES | pcbnew.FP_BOARD_ONLY):
        continue
    pth = any(p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH for p in f.Pads())
    smd = any(p.GetAttribute() == pcbnew.PAD_ATTRIB_SMD for p in f.Pads())
    a &= ~(pcbnew.FP_SMD | pcbnew.FP_THROUGH_HOLE)
    a |= pcbnew.FP_SMD if smd else (pcbnew.FP_THROUGH_HOLE if pth else 0)
    f.SetAttributes(a); ntype += 1
# True: do not rewrite the .kicad_pro next to dst (copperpour-gaps.md, pcbnew / kipy pitfalls)
pcbnew.SaveBoard(dst, b, True)
print('typed', ntype)
