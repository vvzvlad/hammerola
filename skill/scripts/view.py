"""Board region to PNG for layout agents: KiCad's own SVG plot of the layers (zones refilled in memory), cropped, with an mm grid in board coordinates, reference designators, net names and numbered markers; prints what is in the region.
usage: "$PY" view.py <board.kicad_pcb> X1 Y1 X2 Y2 | ref REF | full  [--margin 2] [--layers F.Cu,F.Silkscreen,F.Courtyard,Edge.Cuts (ref REF: the layers of REF's side)] [--drc drc.json] [--marks marks.json] [--px 1000] [-o view.png]   (mm as KiCad shows them; --margin pads ref and full; marks = bq.py --json output or a list of {x,y,label}; reads the saved file only; listing on stdout, PNG path last)
needs: KiCad's bundled Python with pcbnew ($PY), e.g. /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3; rsvg-convert on PATH"""
import sys, os, re, json, math, argparse, tempfile, shutil, subprocess
from xml.sax.saxutils import escape
import pcbnew

MM = 1e6
V = pcbnew.VECTOR2I
BG = "#001023"
# KiCad's default colour theme (what kicad-cli plots with); other layers in OTHER
COLORS = {pcbnew.F_Cu: "#C83434", pcbnew.In1_Cu: "#7FC87F", pcbnew.In2_Cu: "#CE7D2C", pcbnew.In3_Cu: "#4FCBCB",
          pcbnew.In4_Cu: "#DB628B", pcbnew.B_Cu: "#4D7FC4", pcbnew.F_SilkS: "#F2EDA1", pcbnew.B_SilkS: "#E8B2A7",
          pcbnew.F_Mask: "#D864FF", pcbnew.B_Mask: "#02FFEE", pcbnew.F_Paste: "#B4A09A", pcbnew.B_Paste: "#00C2C2",
          pcbnew.F_CrtYd: "#FF26E2", pcbnew.B_CrtYd: "#26E9FF", pcbnew.F_Fab: "#AFAFAF", pcbnew.B_Fab: "#585D84",
          pcbnew.Edge_Cuts: "#D0D2CD", pcbnew.Dwgs_User: "#C2C2C2", pcbnew.Cmts_User: "#5994DC"}
OPACITY = {pcbnew.F_Mask: 0.4, pcbnew.B_Mask: 0.4, pcbnew.F_Paste: 0.9, pcbnew.B_Paste: 0.9}
OTHER = "#C2C2C2"
STEPS = (0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100)
FONT = "Helvetica,Arial,sans-serif"
GRID_FS, REF_FS, NET_FS, MARK_FS = 12, 13, 11, 12   # font sizes, px
CHAR_W = 0.62                                       # bold sans glyph width per font size
REF_SHIFTS = ((0, 0), (0, -18), (0, 18), (-36, 0), (36, 0))   # designator spots tried around the part, px


def mm(v):
    return v / MM


def nat(s):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s)]


def overlap(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def clip(p, q, box):
    """Part of segment p-q inside box (Liang-Barsky), or None."""
    t0, t1 = 0.0, 1.0
    dx, dy = q[0] - p[0], q[1] - p[1]
    for d, e in ((-dx, p[0] - box[0]), (dx, box[2] - p[0]), (-dy, p[1] - box[1]), (dy, box[3] - p[1])):
        if d == 0:
            if e < 0:
                return None
            continue
        t = e / d
        if d < 0:
            t0 = max(t0, t)
        else:
            t1 = min(t1, t)
    if t0 > t1:
        return None
    return (p[0] + t0 * dx, p[1] + t0 * dy), (p[0] + t1 * dx, p[1] + t1 * dy)


class View:
    def __init__(self, a):
        self.path = os.path.abspath(a.board)
        b = self.b = pcbnew.LoadBoard(self.path)
        pcbnew.ZONE_FILLER(b).Fill(b.Zones())
        self.cu = list(b.GetEnabledLayers().CuStack())
        names = a.layers
        if names is None:
            # the side the footprint sits on for `ref REF`, the front otherwise
            fp = b.FindFootprintByReference(a.region[1]) if len(a.region) == 2 and a.region[0] == "ref" else None
            side = "B" if fp is not None and fp.IsFlipped() else "F"
            names = "%s.Cu,%s.Silkscreen,%s.Courtyard,Edge.Cuts" % (side, side, side)
        self.layers = []
        for n in names.split(","):
            l = b.GetLayerID(n)
            if l < 0:
                sys.exit("view: no layer %s" % n)
            self.layers.append(l)
        self.box = self.region(a)
        x0, y0, x1, y1 = self.box
        self.s = a.px / max(x1 - x0, y1 - y0)
        self.W, self.H = round((x1 - x0) * self.s), round((y1 - y0) * self.s)
        self.rect = pcbnew.SHAPE_RECT(V(round(x0 * MM), round(y0 * MM)), round((x1 - x0) * MM), round((y1 - y0) * MM))
        self.placed = []   # label boxes in px
        self.out = []      # overlay SVG elements

    # ---------------------------------------------------------------- region
    def region(self, a):
        r = a.region
        if r == ["full"]:
            bb = self.b.GetBoardEdgesBoundingBox()
            m = a.margin
        elif len(r) == 2 and r[0] == "ref":
            fp = self.b.FindFootprintByReference(r[1])
            if fp is None:
                sys.exit("view: no footprint %s" % r[1])
            bb = fp.GetBoundingBox(False)
            m = a.margin
        elif len(r) == 4:
            x1, y1, x2, y2 = (float(v) for v in r)
            return (min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2))
        else:
            sys.exit(__doc__)
        return (mm(bb.GetLeft()) - m, mm(bb.GetTop()) - m, mm(bb.GetRight()) + m, mm(bb.GetBottom()) + m)

    def inside(self, x, y):
        return self.box[0] <= x <= self.box[2] and self.box[1] <= y <= self.box[3]

    def px(self, x, y):
        return (x - self.box[0]) * self.s, (y - self.box[1]) * self.s

    # ---------------------------------------------------------------- plot
    def plot(self):
        """Each layer plotted by KiCad to SVG in board mm, recoloured, far side to near side."""
        tmp = tempfile.mkdtemp(prefix="view.")
        pc = pcbnew.PLOT_CONTROLLER(self.b)
        po = pc.GetPlotOptions()
        po.SetOutputDirectory(tmp)
        po.SetPlotFrameRef(False)
        po.SetAutoScale(False)
        po.SetScale(1)
        po.SetMirror(False)
        po.SetUseAuxOrigin(False)

        # seen from the back when every shown F./B. layer is a B layer, from the front otherwise:
        # far-side technical layers, copper from far to near, the rest (near side, User.*), the edge
        sided = [n for n in (self.b.GetLayerName(l) for l in self.layers) if n[:2] in ("F.", "B.")]
        back = bool(sided) and all(n.startswith("B.") for n in sided)
        far = "F." if back else "B."

        def order(l):
            if l in self.cu:
                i = self.cu.index(l)
                return (1, i if back else -i)
            if l == pcbnew.Edge_Cuts:
                return (3, 0)
            return (0 if self.b.GetLayerName(l).startswith(far) else 2, l)

        parts = []
        for l in sorted(self.layers, key=order):
            # without colour settings (not reachable from Python) KiCad plots in black, drill marks white on copper
            # and black elsewhere: holes are drawn on copper layers only, so black is the layer's own ink
            po.SetDrillMarksType(pcbnew.DRILL_MARKS_FULL_DRILL_SHAPE if l in self.cu else pcbnew.DRILL_MARKS_NO_DRILL_SHAPE)
            pc.SetLayer(l)
            pc.OpenPlotfile("l%d" % l, pcbnew.PLOT_FORMAT_SVG, "")
            fn = pc.GetPlotFileName()
            pc.PlotLayer()
            pc.ClosePlot()
            svg = open(fn).read()
            body = svg[svg.index(">", svg.index("<svg")) + 1:svg.rindex("</svg>")]
            body = re.sub(r"<title>.*?</title>", "", body, flags=re.S)
            body = body.replace("#000000", COLORS.get(l, OTHER)).replace("#FFFFFF", BG)
            parts.append('<g opacity="%g">%s</g>' % (OPACITY.get(l, 1), body))
        shutil.rmtree(tmp)
        return parts

    # ---------------------------------------------------------------- overlay primitives
    def label(self, x, y, text, fs, fg, bg, edge=None, anchor="c", force=True):
        """Text box centred on (or, anchor 'tl', starting at) board point x, y; kept inside the image.
        Returns False without drawing when force is off and the box hits an earlier label."""
        w, h = len(text) * fs * CHAR_W + 6, fs + 4
        px, py = self.px(x, y)
        if anchor == "c":
            px, py = px - w / 2, py - h / 2
        px = min(max(px, 0), self.W - w)
        py = min(max(py, 0), self.H - h)
        bx = (px, py, px + w, py + h)
        if not force and any(overlap(bx, o) for o in self.placed):
            return False
        self.placed.append(bx)
        u = 1 / self.s
        X, Y = self.box[0] + px * u, self.box[1] + py * u
        self.out.append('<rect x="%.4f" y="%.4f" width="%.4f" height="%.4f" rx="%.4f" fill="%s" fill-opacity="0.75"%s/>' % (
            X, Y, w * u, h * u, 2 * u, bg, ' stroke="%s" stroke-width="%.4f"' % (edge, u) if edge else ""))
        self.out.append('<text x="%.4f" y="%.4f" font-family="%s" font-weight="bold" font-size="%.4f" fill="%s" '
                        'text-anchor="middle" dominant-baseline="central">%s</text>' % (
                            X + w * u / 2, Y + h * u / 2, FONT, fs * u, fg, escape(text)))
        return True

    # ---------------------------------------------------------------- grid
    def grid(self):
        x0, y0, x1, y1 = self.box
        step = next((st for st in STEPS if max(x1 - x0, y1 - y0) / st <= 10), STEPS[-1])
        nd = max(0, -math.floor(math.log10(step) + 1e-9))
        u = 1 / self.s
        lines = []
        xs = [k * step for k in range(math.ceil(x0 / step - 1e-9), math.floor(x1 / step + 1e-9) + 1)]
        ys = [k * step for k in range(math.ceil(y0 / step - 1e-9), math.floor(y1 / step + 1e-9) + 1)]
        for x in xs:
            lines.append('<line x1="%.4f" y1="%.4f" x2="%.4f" y2="%.4f"/>' % (x, y0, x, y1))
        for y in ys:
            lines.append('<line x1="%.4f" y1="%.4f" x2="%.4f" y2="%.4f"/>' % (x0, y, x1, y))
        self.out.append('<g stroke="#FFFFFF" stroke-opacity="0.45" stroke-width="%.4f" stroke-dasharray="%.4f %.4f">%s</g>' % (
            u, 4 * u, 3 * u, "".join(lines)))
        for x in xs:
            self.label(x + 2 * u, y0, "%.*f" % (nd, x), GRID_FS, "#FFFFFF", "#000000", anchor="tl")
        for y in ys:
            self.label(x0, y + 2 * u, "%.*f" % (nd, y), GRID_FS, "#FFFFFF", "#000000", anchor="tl")
        return step

    # ---------------------------------------------------------------- footprints
    def footprints(self):
        x0, y0, x1, y1 = self.box
        shown = set(self.layers)
        rows = []
        for fp in self.b.GetFootprints():
            bb = fp.GetBoundingBox(False)
            fx0, fy0, fx1, fy1 = mm(bb.GetLeft()), mm(bb.GetTop()), mm(bb.GetRight()), mm(bb.GetBottom())
            if fx1 < x0 or fx0 > x1 or fy1 < y0 or fy0 > y1:
                continue
            rows.append(fp)
            layers = {g.GetLayer() for g in fp.GraphicalItems()}
            for p in fp.Pads():
                layers.update(p.GetLayerSet().Seq())
            if layers & shown:
                cx = (max(fx0, x0) + min(fx1, x1)) / 2
                cy = (max(fy0, y0) + min(fy1, y1)) / 2
                u, ref = 1 / self.s, fp.GetReference()
                if not any(self.label(cx + dx * u, cy + dy * u, ref, REF_FS, "#FFFFFF", "#1060D0", force=False)
                           for dx, dy in REF_SHIFTS):
                    self.label(cx, cy, ref, REF_FS, "#FFFFFF", "#1060D0")
        rows.sort(key=lambda f: nat(f.GetReference()))
        return rows

    # ---------------------------------------------------------------- nets
    def nets(self):
        """Net -> copper layers with copper of it in the crop; one label per net per shown copper layer."""
        b, box, R = self.b, self.box, self.rect
        found = {}
        cand = {}   # (layer, net) -> [(rank, x, y)]

        def add(l, net, rank=None, x=None, y=None):
            found.setdefault(net, set()).add(l)
            if rank is not None and l in self.layers:
                cand.setdefault((l, net), []).append((rank, x, y))

        for t in b.GetTracks():
            net = t.GetNetname()
            if not net:
                continue
            if t.GetClass() == "PCB_VIA":
                p = t.GetPosition()
                for l in self.cu:
                    if t.IsOnLayer(l) and t.FlashLayer(l) and pcbnew.SHAPE.Collide(R, t.GetEffectiveShape(l), 0):
                        add(l, net, (1, 0), mm(p.x), mm(p.y))
                continue
            l = t.GetLayer()
            if not pcbnew.SHAPE.Collide(R, t.GetEffectiveShape(l), 0):
                continue
            s, e = t.GetStart(), t.GetEnd()
            if t.GetClass() == "PCB_ARC":
                m = t.GetMid()
                if self.inside(mm(m.x), mm(m.y)):
                    add(l, net, (0, 0), mm(m.x), mm(m.y))
                else:
                    add(l, net)
                continue
            c = clip((mm(s.x), mm(s.y)), (mm(e.x), mm(e.y)), box)
            if c is None:
                add(l, net)
                continue
            (ax, ay), (bx, by) = c
            add(l, net, (0, -math.hypot(bx - ax, by - ay)), (ax + bx) / 2, (ay + by) / 2)
        for fp in b.GetFootprints():
            for p in fp.Pads():
                net = p.GetNetname()
                if not net:
                    continue
                c = p.GetPosition()
                for l in self.cu:
                    if p.IsOnLayer(l) and p.FlashLayer(l) and pcbnew.SHAPE.Collide(R, p.GetEffectiveShape(l), 0):
                        if self.inside(mm(c.x), mm(c.y)):
                            add(l, net, (2, 0), mm(c.x), mm(c.y))
                        else:
                            add(l, net)
        x0, y0, x1, y1 = box
        for z in b.Zones():
            net = z.GetNetname()
            if z.GetIsRuleArea() or not net:
                continue
            for l in z.GetLayerSet().Seq():
                if l not in self.cu or not z.HasFilledPolysForLayer(l):
                    continue
                fill = z.GetFilledPolysList(l)
                if not fill.OutlineCount() or not pcbnew.SHAPE.Collide(R, fill, 0):
                    continue
                add(l, net)
                if l in self.layers:
                    for i in range(1, 8):
                        for j in range(1, 8):
                            x, y = x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * j / 8
                            if fill.Contains(V(round(x * MM), round(y * MM))):
                                add(l, net, (3, math.hypot(i - 4, j - 4)), x, y)
        # a net label goes only where it hits no earlier label; the listing names every net
        for (l, net), cs in sorted(cand.items(), key=lambda kv: (kv[0][0], nat(kv[0][1]))):
            cs.sort()
            col = COLORS.get(l, OTHER)
            for _, x, y in cs:
                if self.label(x, y, net, NET_FS, "#FFFFFF", "#000000", col, force=False):
                    break
        return found

    # ---------------------------------------------------------------- markers
    def drc_markers(self, path):
        """One marker per report entry, numbered in report order: at the closest points of its two items
        (both ends for a missing connection), else at the item's reported position."""
        d = json.load(open(path))
        out = []
        n = 0
        for key in ("violations", "unconnected_items", "schematic_parity"):
            for v in d.get(key, []):
                n += 1
                items = v.get("items", [])
                desc = "%s %s: %s" % (v.get("severity", ""), v.get("type", ""), v.get("description", ""))
                desc += "".join("; " + it.get("description", "") for it in items)
                pts = [(it["pos"]["x"], it["pos"]["y"]) for it in items[:1] if "pos" in it]
                if len(items) == 2:
                    shapes = [self.item_shape(it, items[1 - k]) for k, it in enumerate(items)]
                    pa, pb = V(), V()
                    pcbnew.SHAPE.NearestPoints(shapes[0], shapes[1], pa, pb)
                    a, c = (mm(pa.x), mm(pa.y)), (mm(pb.x), mm(pb.y))
                    pts = [a, c] if v.get("type") == "unconnected_items" else [((a[0] + c[0]) / 2, (a[1] + c[1]) / 2)]
                out.append((str(n), pts, desc))
        return out

    def item_shape(self, it, other):
        """Shape of a report item on a layer it shares with the other item (else its own layer), or a point at its
        reported position when the board has no item with its uuid."""
        o = self.b.ResolveItem(pcbnew.KIID(it.get("uuid", "")), True)
        if o is None:
            return pcbnew.SHAPE_CIRCLE(V(round(it["pos"]["x"] * MM), round(it["pos"]["y"] * MM)), 0)
        q = self.b.ResolveItem(pcbnew.KIID(other.get("uuid", "")), True)
        mine = list(o.GetLayerSet().Seq())
        theirs = set(q.GetLayerSet().Seq()) if q is not None else set()
        l = next((x for x in mine if x in theirs), o.GetLayer())
        return o.GetEffectiveShape(l)

    def mark_list(self, path):
        """Markers from a bq.py --json result or a plain list of {x, y, label}, numbered in order."""
        d = json.load(open(path))
        pts = []
        if isinstance(d, list):
            pts = [(m["x"], m["y"], m.get("label", "")) for m in d]
        elif d.get("cmd") == "via":
            pts = [(s["x"], s["y"], "via site %s d %.3f drill %.3f, slack %.3f (%s)" % (
                d["net"], d["size"], d["drill"], s["slack"], s["limit"])) for s in d["sites"]]
        elif d.get("cmd") == "corridor":
            pts = [(o["point"][0], o["point"][1], "corridor %s obstacle %s, deficit %.3f" % (
                d["net"], o["what"], o["deficit"])) for o in d["obstacles"]]
        elif d.get("cmd") == "clearance":
            for r in d["layers"]:
                for k in ("min", "worst"):
                    if k in r:
                        e = r[k]
                        pts.append(((e["a"]["at"][0] + e["b"]["at"][0]) / 2, (e["a"]["at"][1] + e["b"]["at"][1]) / 2,
                                    "%s %s %.3f need %.3f %s: %s %s %s ~ %s %s %s" % (
                                        r["layer"], k, e["dist"], e["need"], "ok" if e["ok"] else "VIOLATION",
                                        e["a"]["kind"], e["a"]["name"], e["a"]["net"] or "-",
                                        e["b"]["kind"], e["b"]["name"], e["b"]["net"] or "-")))
        elif d.get("cmd") == "labels":
            pts = [(s["x"], s["y"], "%s designator spot, angle %d, gap %.3f, cost %.2f" % (
                d["ref"], s["angle"], s["gap"], s["cost"])) for s in d["spots"]]
        elif d.get("cmd") == "near":
            pts = [(d["x"], d["y"], "near r %.2f: %d items" % (d["r"], len(d["items"])))]
        elif d.get("cmd") == "score":
            pts = [(c["at"][0], c["at"][1], "airwire crossing %s %s-%s x %s %s-%s" % (
                c["a"]["net"], c["a"]["wire"][0], c["a"]["wire"][1], c["b"]["net"], c["b"]["wire"][0], c["b"]["wire"][1]))
                for c in d["crossing_list"]]
        return [("M%d" % (i + 1), [(x, y)], t) for i, (x, y, t) in enumerate(pts)]

    def markers(self, ms, col):
        u = 1 / self.s
        shown = []
        for num, pts, desc in ms:
            inn = [p for p in pts if self.inside(*p)]
            if not inn:
                continue
            shown.append((num, pts, desc))
            for x, y in inn:
                # white ring in a black one and a white dot: visible on every layer colour
                for c, w in (("#000000", 4), ("#FFFFFF", 2)):
                    self.out.append('<circle cx="%.4f" cy="%.4f" r="%.4f" fill="none" stroke="%s" stroke-width="%.4f"/>' % (
                        x, y, 7 * u, c, w * u))
                self.out.append('<circle cx="%.4f" cy="%.4f" r="%.4f" fill="#FFFFFF" stroke="#000000" stroke-width="%.4f"/>' % (
                    x, y, 1.5 * u, u))
                self.label(x + 8 * u, y - (MARK_FS + 12) * u, num, MARK_FS, "#FFFFFF", col, "#FFFFFF", anchor="tl")
        return shown

    # ---------------------------------------------------------------- render
    def render(self, parts, outpath):
        x0, y0, x1, y1 = self.box
        svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="%.4f %.4f %.4f %.4f">' % (
            self.W, self.H, x0, y0, x1 - x0, y1 - y0),
            '<rect x="%.4f" y="%.4f" width="%.4f" height="%.4f" fill="%s"/>' % (x0, y0, x1 - x0, y1 - y0, BG)]
        svg += parts + self.out + ["</svg>"]
        subprocess.run(["rsvg-convert", "-o", outpath], input="\n".join(svg).encode(), check=True)


def main():
    p = argparse.ArgumentParser(prog="view.py")
    p.add_argument("board")
    p.add_argument("region", nargs="+")
    p.add_argument("--margin", type=float, default=2.0)
    p.add_argument("--layers")
    p.add_argument("--drc")
    p.add_argument("--marks")
    p.add_argument("--px", type=int, default=1000)
    p.add_argument("-o", default="view.png")
    a = p.parse_args()
    v = View(a)
    parts = v.plot()
    dm = v.markers(v.drc_markers(a.drc), "#E02020") if a.drc else []
    mk = v.markers(v.mark_list(a.marks), "#00A050") if a.marks else []
    step = v.grid()
    fps = v.footprints()
    nets = v.nets()
    out = os.path.abspath(a.o)
    v.render(parts, out)
    x0, y0, x1, y1 = v.box
    print("board %s (zones refilled in memory)" % v.path)
    print("crop %.3f %.3f %.3f %.3f (%.3f x %.3f mm), %.2f px/mm, %dx%d px, grid %g mm, layers %s" % (
        x0, y0, x1, y1, x1 - x0, y1 - y0, v.s, v.W, v.H, step, ",".join(v.b.GetLayerName(l) for l in v.layers)))
    print("footprints %d:" % len(fps))
    for f in fps:
        c = f.GetPosition()
        print("  %-8s %-24s %8.3f %8.3f  %s" % (f.GetReference(), f.GetValue(), mm(c.x), mm(c.y), "B" if f.IsFlipped() else "F"))
    print("nets %d:" % len(nets))
    order = {l: i for i, l in enumerate(v.cu)}
    for n in sorted(nets, key=nat):
        print("  %-28s %s" % (n, ",".join(v.b.GetLayerName(l) for l in sorted(nets[n], key=order.get))))
    print("markers %d:" % (len(dm) + len(mk)))
    for num, pts, desc in dm + mk:
        print("  %-4s %s  %s" % (num, " ~ ".join("%.3f %.3f" % p for p in pts), desc))
    print(out)


if __name__ == "__main__":
    main()
