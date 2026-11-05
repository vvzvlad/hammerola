"""Board geometry core for bq.py and silk.py: loads a board, refills its zones in memory, indexes copper, holes, courtyards, mask openings, silk and edge, and tests them with KiCad's own shapes (Collide / GetClearance); also the designator spot generator.
usage: import boardgeo; g = boardgeo.Geo("board.kicad_pcb")   (required clearance: pad/footprint override, else the last matching clearance / hole_clearance / edge_clearance rule of the .kicad_dru beside the board, else net classes and board minimums; a condition form it cannot evaluate is named on stderr and that rule is not applied)
needs: KiCad's bundled Python with pcbnew, e.g. /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3"""
import math, collections, sys, re, os
import pcbnew

MM = 1e6
V = pcbnew.VECTOR2I
CELL = 2000000             # spatial grid cell, nm
SILK_GAP = 150000          # designator ink to pads, mask openings and other silk (layout-rules.md, Silkscreen)
LINE_GAP = 800000          # two texts on one line, along the reading direction
TEXT_SIZE = 1000000        # designator height and width
TEXT_STROKE = 150000       # designator stroke
LABEL_GAPS = [50000, 150000, 250000, 400000, 600000, 800000, 1000000, 1300000, 1600000, 2000000]
LABEL_SLIDE = 250000       # step along a side of the part
LABEL_SNAP = 50000         # anchor grid
LABEL_SPREAD = 300000      # two kept spots of one label differ by at least this in x or y


def nm(v):
    return int(round(v * MM))


# Called through the base class: SWIG hides SHAPE's overloads on some subclasses (SHAPE_CIRCLE takes only SEG),
# and SHAPE_COMPOUND.Distance ignores stroke widths, so distances always go through GetClearance.
def hit(a, b, clearance):
    """True when b is closer to a than clearance (touching counts), as KiCad's Collide."""
    return pcbnew.SHAPE.Collide(a, b, clearance)


def dist(a, b):
    """Edge-to-edge distance, 0 when the shapes touch or overlap."""
    return pcbnew.SHAPE.GetClearance(a, b)


def nearest(a, b):
    pa, pb = V(), V()
    pcbnew.SHAPE.NearestPoints(a, b, pa, pb)
    return pa, pb


def point(x, y):
    return pcbnew.SHAPE_CIRCLE(V(int(x), int(y)), 0)


def mm(v):
    return v / MM


def box_of(shape):
    b = shape.BBox()
    return (b.GetLeft(), b.GetTop(), b.GetRight(), b.GetBottom())


def box_gap(a, b):
    dx = max(a[0] - b[2], b[0] - a[2], 0)
    dy = max(a[1] - b[3], b[1] - a[3], 0)
    return math.hypot(dx, dy)


def rect(box):
    return pcbnew.SHAPE_RECT(V(box[0], box[1]), box[2] - box[0], box[3] - box[1])


def line_class(deg):
    """0 for horizontal text, 90 for vertical, None for any other angle."""
    a = round(deg) % 180
    return a if a in (0, 90) else None


def clash(a, b):
    """Two ink boxes with their line classes: closer than SILK_GAP, or on one line closer than LINE_GAP along it.
    One line = the second box lies in the row of a horizontal text or the column of a vertical one, whatever its own angle
    (a vertical label after a horizontal one reads as one more glyph of it)."""
    (ax0, ay0, ax1, ay1), aa = a
    (bx0, by0, bx1, by1), ba = b
    dx = max(bx0 - ax1, ax0 - bx1)
    dy = max(by0 - ay1, ay0 - by1)
    if math.hypot(max(dx, 0), max(dy, 0)) < SILK_GAP:
        return True
    if 0 in (aa, ba) and dy < 0 and dx < LINE_GAP:
        return True
    if 90 in (aa, ba) and dx < 0 and dy < LINE_GAP:
        return True
    return False


class Item:
    __slots__ = ("kind", "layer", "shape", "box", "obj", "ref", "pad", "net", "code", "nc", "ovr", "plated", "text", "angle", "isref", "r")

    def __init__(self, kind, layer, shape, obj, ref="", pad="", net="", code=0, nc=0, ovr=None, plated=False, text="", angle=None, isref=False):
        self.kind, self.layer, self.shape, self.obj = kind, layer, shape, obj
        self.box = box_of(shape)
        self.ref, self.pad, self.net, self.code, self.nc, self.ovr = ref, pad, net, code, nc, ovr
        self.plated, self.text, self.angle, self.isref = plated, text, angle, isref
        self.r = None

    def name(self):
        if self.pad:
            return "%s.%s" % (self.ref, self.pad)
        if self.kind == "silk" and self.text:
            return "%s '%s'" % (self.ref, self.text) if self.ref else "'%s'" % self.text
        return self.ref or "-"


class Grid:
    def __init__(self):
        self.cells = collections.defaultdict(list)

    def add(self, it):
        x0, y0, x1, y1 = it.box
        for ix in range(x0 // CELL, x1 // CELL + 1):
            for iy in range(y0 // CELL, y1 // CELL + 1):
                self.cells[(ix, iy)].append(it)

    def query(self, box):
        x0, y0, x1, y1 = box
        out, seen = [], set()
        for ix in range(x0 // CELL, x1 // CELL + 1):
            for iy in range(y0 // CELL, y1 // CELL + 1):
                for it in self.cells.get((ix, iy), ()):
                    if id(it) in seen:
                        continue
                    seen.add(id(it))
                    b = it.box
                    if b[0] <= x1 and b[2] >= x0 and b[1] <= y1 and b[3] >= y0:
                        out.append(it)
        return out


# ---------------------------------------------------------------- .kicad_dru
# Semantics from docs.kicad.org/10.0/en/pcbnew, "Custom design rules": rules are checked from the last one in the
# file up and the first match wins; both A/B orders are tried; NetClass equals a string matching any class of its comma list or the whole list; memberOfFootprint takes a
# reference or library:footprint with * and ?. Against the manual's "board minimums are absolute", KiCad 10.0.6
# DRC applies a matching rule even below the net class and the board minimum, so a matching rule wins outright.
# Against the manual's "same precedence, left to right", || binds tighter than && (libeval grammar.lemon declares
# %left G_BOOL_AND before %left G_BOOL_OR; kicad-cli 10.0.6 DRC reads "a && b || c" as "a && (b || c)").
RULE_TYPES = ("clearance", "hole_clearance", "edge_clearance")
RULE_PROPS = ("NetClass", "NetName", "Name", "Reference", "Type", "Library_Link")
RULE_CALLS = ("isPlated", "memberOfFootprint")
UNITS = {"mm": 1e6, "mil": 25400, "in": 25.4e6, "um": 1e3, "": 1e6}
_warned = set()


def warn_once(msg):
    if msg not in _warned:
        _warned.add(msg)
        print("boardgeo: " + msg, file=sys.stderr)


def wild(pattern, s):
    """KiCad string match: * and ? wildcards, case-insensitive."""
    rx = "".join(".*" if c == "*" else "." if c == "?" else re.escape(c) for c in pattern)
    return re.fullmatch(rx, s, re.I) is not None


def sexpr(text):
    toks = re.findall(r"\(|\)|\"[^\"]*\"|'[^']*'|[^\s()]+",
                      "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#")))
    stack = [[]]
    for t in toks:
        if t == "(":
            stack.append([])
        elif t == ")":
            x = stack.pop()
            stack[-1].append(x)
        else:
            stack[-1].append(t[1:-1] if t[0] in "\"'" else t)
    return stack[0]


class Unsupported(Exception):
    pass


_TOK = re.compile(r"\s*(?:(&&|\|\||==|!=|!|\(|\)|,)|'([^']*)'|\"([^\"]*)\"|([AB])\.(\w+)|(\S))")


def parse_cond(text):
    """Condition string to a tree: ('and'|'or', l, r), ('not', x), ('cmp', op, l, r), ('prop', obj, name),
    ('call', obj, name, args), ('lit', s). Raises Unsupported naming the first form it cannot evaluate."""
    toks = []
    for m in _TOK.finditer(text):
        op, s1, s2, obj, name, other = m.groups()
        if other:
            raise Unsupported(repr(other))
        toks.append(("op", op) if op else ("lit", s1 if s1 is not None else s2) if (s1 is not None or s2 is not None) else ("ref", obj, name))
    pos = [0]

    def peek():
        return toks[pos[0]] if pos[0] < len(toks) else ("end",)

    def take():
        t = peek()
        pos[0] += 1
        return t

    def operand():
        t = take()
        if t[0] == "lit":
            return ("lit", t[1])
        if t[0] != "ref":
            raise Unsupported(str(t[1:]))
        obj, name = t[1], t[2]
        if peek() == ("op", "("):
            take()
            args = []
            while peek() != ("op", ")"):
                a = take()
                if a == ("op", ","):
                    continue
                if a[0] != "lit":
                    raise Unsupported("%s.%s(...)" % (obj, name))
                args.append(a[1])
            take()
            if name not in RULE_CALLS or (name == "memberOfFootprint" and (len(args) != 1 or args[0].startswith("${"))):
                raise Unsupported("%s.%s(%s)" % (obj, name, ", ".join("'%s'" % x for x in args)))
            return ("call", obj, name, args)
        if name not in RULE_PROPS:
            raise Unsupported("%s.%s" % (obj, name))
        return ("prop", obj, name)

    def primary():
        if peek() == ("op", "!"):
            take()
            if peek() in (("op", "("), ("op", "!")):
                return ("not", primary())
            x = operand()
            # libeval binds ! tighter than == and != (grammar.lemon: %right G_BOOL_NOT after them), so
            # "!A.x == 'y'" is "(!A.x) == 'y'", a form this evaluator does not model
            if peek() in (("op", "=="), ("op", "!=")):
                raise Unsupported("! before a comparison without parentheses")
            if x[0] != "call":
                raise Unsupported("bare !%s" % (x[1] if x[0] == "lit" else "%s.%s" % x[1:3]))
            return ("not", x)
        if peek() == ("op", "("):
            take()
            e = expr()
            if take() != ("op", ")"):
                raise Unsupported("unbalanced parentheses")
            return e
        left = operand()
        if peek() in (("op", "=="), ("op", "!=")):
            op = take()[1]
            return ("cmp", op, left, operand())
        if left[0] != "call":
            raise Unsupported("bare %s" % (left[1] if left[0] == "lit" else "%s.%s" % left[1:3]))
        return left

    def expr():
        e = disjunction()
        while peek() == ("op", "&&"):
            take()
            e = ("and", e, disjunction())
        return e

    def disjunction():
        e = primary()
        while peek() == ("op", "||"):
            take()
            e = ("or", e, primary())
        return e

    tree = expr()
    if pos[0] != len(toks):
        raise Unsupported("trailing %s" % (peek()[1:],))
    return tree


class RObj:
    """What a rule condition can see of one object (KiCad property names in the comments)."""
    __slots__ = ("type", "net", "netclass", "name", "ref", "fpid", "plated", "sig")

    def __init__(self, type, net=None, netclass=None, name=None, ref=None, fpid=None, plated=False):
        self.type, self.net, self.netclass, self.name = type, net, netclass, name   # Type, NetName, NetClass, Name
        self.ref, self.fpid, self.plated = ref, fpid, plated                        # Reference, Library_Link, isPlated()
        self.sig = (type, net, netclass, name, ref, fpid, plated)


def _value(node, A, B):
    """Operand value: ('nc', classes), ('str', s), ('lit', s) or None when the object has no such property."""
    if node[0] == "lit":
        return node
    o = A if node[1] == "A" else B
    v = {"NetClass": o.netclass, "NetName": o.net, "Name": o.name, "Reference": o.ref, "Type": o.type,
         "Library_Link": o.fpid}[node[2]]
    if v is None:
        return None
    return ("nc", v) if node[2] == "NetClass" else ("str", v)


def _same(a, b):
    if a[0] == "nc" and b[0] == "nc":
        return a[1] == b[1]
    if b[0] == "nc":
        a, b = b, a
    if a[0] == "nc":
        return any(wild(b[1], c) for c in a[1].split(",") + [a[1]])
    if a[0] == "lit" and b[0] != "lit":
        a, b = b, a
    return wild(b[1], a[1]) if b[0] == "lit" else a[1].lower() == b[1].lower()


def _eval(node, A, B):
    k = node[0]
    if k == "and":
        return _eval(node[1], A, B) and _eval(node[2], A, B)
    if k == "or":
        return _eval(node[1], A, B) or _eval(node[2], A, B)
    if k == "not":
        return not _eval(node[1], A, B)
    if k == "call":
        o = A if node[1] == "A" else B
        if node[2] == "isPlated":
            return o.plated
        return o.ref is not None and (wild(node[3][0], o.ref) or wild(node[3][0], o.fpid))
    l, r = _value(node[2], A, B), _value(node[3], A, B)
    if l is None or r is None:
        return False  # a property the object does not have compares false both ways
    return _same(l, r) == (node[1] == "==")


class Rules:
    """clearance, hole_clearance and edge_clearance (min) rules of a .kicad_dru, with layer clauses."""

    def __init__(self, path):
        self.rules = []
        self.cache = {}
        if not os.path.exists(path):
            return
        for r in sexpr(open(path, encoding="utf-8").read()):
            if not isinstance(r, list) or not r or r[0] != "rule":
                continue
            name, layer, cond, cons = r[1], None, None, {}
            for c in r[2:]:
                if c[0] == "layer":
                    layer = c[1]
                elif c[0] == "condition":
                    cond = c[1]
                elif c[0] == "constraint" and c[1] in RULE_TYPES:
                    for arg in c[2:]:
                        if isinstance(arg, list) and arg[0] == "min":
                            m = re.fullmatch(r"(-?[\d.]+)\s*([a-z]*)", arg[1])
                            cons[c[1]] = int(round(float(m.group(1)) * UNITS[m.group(2)]))
            if not cons:
                continue
            try:
                tree = parse_cond(cond) if cond else None
            except Unsupported as e:
                warn_once(".kicad_dru rule '%s': cannot evaluate %s; rule not applied" % (name, e))
                continue
            self.rules.append((name, layer, tree, cons))

    def value(self, ctype, a, b, layer):
        """Minimum of the last rule whose layer and condition match (a, b) in either order, or None."""
        key = (ctype, a.sig, b.sig, layer)
        if key in self.cache:
            return self.cache[key]
        v = None
        for name, lay, tree, cons in reversed(self.rules):
            if ctype not in cons:
                continue
            if lay and not (lay == layer or (lay == "outer" and layer in ("F.Cu", "B.Cu")) or
                            (lay == "inner" and layer.startswith("In"))):
                continue
            if tree is None or _eval(tree, a, b) or _eval(tree, b, a):
                v = cons[ctype]
                break
        self.cache[key] = v
        return v

    def largest(self):
        return max([v for _, _, _, cons in self.rules for v in cons.values()] + [0])


class Geo:
    def __init__(self, path):
        b = self.board = pcbnew.LoadBoard(path)
        pcbnew.ZONE_FILLER(b).Fill(b.Zones())
        ds = b.GetDesignSettings()
        self.min_clr = ds.m_MinClearance
        self.hole_clr = ds.m_HoleClearance
        self.h2h = ds.m_HoleToHoleMin
        self.edge_clr = ds.m_CopperEdgeClearance
        self.ns = ds.m_NetSettings
        self._nc = {}
        self.cu = [l for l in b.GetEnabledLayers().CuStack()]
        self.ln = lambda l: b.GetLayerName(l)
        self.grid = collections.defaultdict(Grid)
        self.zones = []
        self.keepouts = []         # (area, forbids vias, forbids tracks, copper layer names): board and footprint rule areas
        self.fps = {f.GetReference(): f for f in b.GetFootprints()}
        self.outline = pcbnew.SHAPE_POLY_SET()
        b.GetBoardPolygonOutlines(self.outline, False)
        self.rules = Rules(os.path.splitext(path)[0] + ".kicad_dru")
        self._build()
        self.max_need = max([self.min_clr, self.hole_clr, self.h2h, self.edge_clr, self.rules.largest()] +
                            [max(it.nc, it.ovr or 0) for g in self.grid.values() for c in g.cells.values() for it in c] +
                            [max(z.nc, z.ovr or 0) for z in self.zones])

    def ncclr(self, net):
        if net not in self._nc:
            self._nc[net] = self.ns.GetEffectiveNetClass(net).GetClearance()
        return self._nc[net]

    def robj(self, it):
        """Rule view of a board item (cached on it); a hole is seen as its pad or via."""
        if it.r is None:
            o, kind = it.obj, it.kind
            if kind == "hole":
                kind = "via" if o.GetClass() == "PCB_VIA" else "pad"
            typ = {"pad": "Pad", "via": "Via", "track": "Track", "arc": "Track", "zone": "Zone", "text": "Text"}.get(kind, "Graphic")
            wired = kind in ("pad", "via", "track", "arc", "zone", "shape", "text")
            fp = o.GetParentFootprint() if hasattr(o, "GetParentFootprint") else None
            it.r = RObj(typ, it.net if wired else None, self.ns.GetEffectiveNetClass(it.net).GetName() if wired else None,
                        o.GetZoneName() if kind == "zone" else None, fp.GetReference() if fp else None,
                        fp.GetFPIDAsString() if fp else None,
                        kind == "via" or (kind == "pad" and o.GetAttribute() == pcbnew.PAD_ATTRIB_PTH))
        return it.r

    def probe(self, kind, net):
        """A via or track of net that is not on the board yet."""
        p = Item.__new__(Item)
        p.kind, p.net, p.nc, p.ovr = kind, net, self.ncclr(net), None
        p.r = RObj("Via" if kind == "via" else "Track", net, self.ns.GetEffectiveNetClass(net).GetName(), plated=kind == "via")
        return p

    def need(self, a, b, layer):
        """Copper clearance between two items on a layer: a pad/footprint override (never below the board minimum),
        else the matching .kicad_dru clearance rule, else the larger net-class clearance and the board minimum."""
        oa, ob = a.ovr or 0, b.ovr or 0
        if oa or ob:
            return max(oa, ob, self.min_clr)
        v = self.rules.value("clearance", self.robj(a), self.robj(b), layer)
        return v if v is not None else max(a.nc, b.nc, self.min_clr)

    def need_hole(self, a, b, layer):
        """Hole of a (pad or via) to copper of b on a layer: the matching hole_clearance rule, else the board minimum."""
        v = self.rules.value("hole_clearance", self.robj(a), self.robj(b), layer)
        return v if v is not None else self.hole_clr

    def need_edge(self, a, b, layer):
        """Copper of a on a layer to the edge item b: the matching edge_clearance rule, else the board minimum."""
        v = self.rules.value("edge_clearance", self.robj(a), self.robj(b), layer)
        return v if v is not None else self.edge_clr

    def add(self, it):
        self.grid[it.layer].add(it)

    def query(self, layer, box, pad=0):
        return self.grid[layer].query((box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad))

    def _graphic(self, g, ref, owner_ref_field=False):
        L = g.GetLayer()
        cls = g.GetClass()
        if cls in ("PCB_TEXT", "PCB_FIELD") and not g.IsVisible():
            return
        if cls in ("PCB_TEXT", "PCB_FIELD"):
            shape = g.GetEffectiveTextShape()
            text, angle = g.GetShownText(True), line_class(g.GetDrawRotation().AsDegrees())
        else:
            shape = g.GetEffectiveShape(L)
            text, angle = "", None
        if L in (pcbnew.F_SilkS, pcbnew.B_SilkS):
            self.add(Item("silk", self.ln(L), shape, g, ref, text=text, angle=angle, isref=owner_ref_field))
        elif L in (pcbnew.F_Mask, pcbnew.B_Mask):
            self.add(Item("mask", self.ln(L), shape, g, ref))
        elif L == pcbnew.Edge_Cuts:
            # KiCad's edge clearance test measures to the zero-width edge line
            w = g.GetWidth()
            g.SetWidth(0)
            self.add(Item("edge", self.ln(L), g.GetEffectiveShape(L), g, ref))
            g.SetWidth(w)
        elif L in self.cu:
            net = g.GetNetname() if hasattr(g, "GetNetname") else ""
            code = g.GetNetCode() if hasattr(g, "GetNetCode") else 0
            self.add(Item("shape" if not text else "text", self.ln(L), shape, g, ref, net=net, code=code, nc=self.ncclr(net)))

    def _build(self):
        b = self.board
        for f in b.GetFootprints():
            ref = f.GetReference()
            for p in f.Pads():
                net, code, num = p.GetNetname(), p.GetNetCode(), p.GetNumber()
                nc, ovr = self.ncclr(net), p.GetClearanceOverrides(None)
                for l in self.cu:
                    if p.IsOnLayer(l) and p.FlashLayer(l):
                        self.add(Item("pad", self.ln(l), p.GetEffectiveShape(l), p, ref, num, net, code, nc, ovr))
                if p.HasHole():
                    self.add(Item("hole", "hole", p.GetEffectiveHoleShape(), p, ref, num, net, code, nc, ovr,
                                  plated=p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH))
                for ml, cl in ((pcbnew.F_Mask, pcbnew.F_Cu), (pcbnew.B_Mask, pcbnew.B_Cu)):
                    if p.IsOnLayer(ml):
                        ps = pcbnew.SHAPE_POLY_SET()
                        p.TransformShapeToPolygon(ps, cl, p.GetSolderMaskExpansion(cl), 5000, pcbnew.ERROR_OUTSIDE)
                        self.add(Item("mask", self.ln(ml), ps, p, ref, num, net, code))
            for g in f.GraphicalItems():
                self._graphic(g, ref)
            for fld in f.GetFields():
                self._graphic(fld, ref, fld.IsReference())
            for cl in (pcbnew.F_CrtYd, pcbnew.B_CrtYd):
                cy = f.GetCourtyard(cl)
                if cy.OutlineCount():
                    self.add(Item("courtyard", self.ln(cl), pcbnew.SHAPE_POLY_SET(cy), f, ref))
        for d in b.GetDrawings():
            self._graphic(d, "")
        for t in b.GetTracks():
            net, code = t.GetNetname(), t.GetNetCode()
            nc, ovr = self.ncclr(net), t.GetClearanceOverrides(None)
            if t.GetClass() == "PCB_VIA":
                for l in self.cu:
                    if t.IsOnLayer(l) and t.FlashLayer(l):
                        self.add(Item("via", self.ln(l), t.GetEffectiveShape(l), t, net=net, code=code, nc=nc, ovr=ovr))
                self.add(Item("hole", "hole", t.GetEffectiveHoleShape(), t, net=net, code=code, nc=nc, ovr=ovr, plated=True))
                for ml, cl in ((pcbnew.F_Mask, pcbnew.F_Cu), (pcbnew.B_Mask, pcbnew.B_Cu)):
                    if t.IsOnLayer(ml):
                        r = t.GetWidth(cl) // 2 + t.GetSolderMaskExpansion()
                        self.add(Item("mask", self.ln(ml), pcbnew.SHAPE_CIRCLE(t.GetPosition(), r), t, net=net, code=code))
            else:
                l = t.GetLayer()
                self.add(Item("arc" if t.GetClass() == "PCB_ARC" else "track", self.ln(l), t.GetEffectiveShape(l), t,
                              net=net, code=code, nc=nc, ovr=ovr))
        for z in list(b.Zones()) + [z for f in b.GetFootprints() for z in f.Zones() if z.GetIsRuleArea()]:
            if z.GetIsRuleArea():
                cu = {self.ln(l) for l in z.GetLayerSet().Seq() if l in self.cu}
                if cu and (z.GetDoNotAllowVias() or z.GetDoNotAllowTracks()):
                    fp = z.GetParentFootprint()
                    self.keepouts.append((Item("keepout", "", pcbnew.SHAPE_POLY_SET(z.Outline()), z,
                                               z.GetZoneName() or (fp.GetReference() if fp else "")),
                                          z.GetDoNotAllowVias(), z.GetDoNotAllowTracks(), cu))
                continue
            net, code = z.GetNetname(), z.GetNetCode()
            for l in z.GetLayerSet().Seq():
                if not z.HasFilledPolysForLayer(l):
                    continue
                fill = z.GetFilledPolysList(l)
                if not fill.OutlineCount():
                    continue
                if l in self.cu:
                    self.zones.append(Item("zone", self.ln(l), fill, z, z.GetZoneName(), net=net, code=code,
                                           nc=self.ncclr(net), ovr=z.GetClearanceOverrides(None)))
                elif l in (pcbnew.F_Mask, pcbnew.B_Mask):
                    self.add(Item("mask", self.ln(l), fill, z, z.GetZoneName()))

    def inside(self, x, y):
        return self.outline.Contains(V(int(x), int(y)))


SIDE = {"F": (pcbnew.F_SilkS, pcbnew.F_Mask, pcbnew.F_Cu, pcbnew.F_CrtYd),
        "B": (pcbnew.B_SilkS, pcbnew.B_Mask, pcbnew.B_Cu, pcbnew.B_CrtYd)}


class Labels:
    """Legal designator spots: ink box outside every courtyard of its side (own included), >= SILK_GAP from pads, mask
    openings and other silk, off vias, inside the edge, 1.0 mm text / 0.15 mm stroke at 0 or 90 deg, back side mirrored.
    Reference fields of the refs in `movable` are not obstacles (they are the ones being moved)."""

    def __init__(self, geo, movable):
        self.g = geo
        self.movable = set(movable)

    def side(self, fp):
        return "B" if fp.IsFlipped() else "F"

    def body(self, fp):
        cy = fp.GetCourtyard(SIDE[self.side(fp)][3])
        bb = cy.BBox() if cy.OutlineCount() else fp.GetBoundingBox(False, False)
        return (bb.GetLeft(), bb.GetTop(), bb.GetRight(), bb.GetBottom())

    def ink(self, fp, angle):
        """Ink box of the reference at the target style, relative to its anchor."""
        f = fp.Reference()
        sz = f.GetTextSize()  # getters return live references: copy the values
        keep = (V(sz.x, sz.y), f.GetTextThickness(), f.GetLayer(), f.IsMirrored(), f.GetTextAngleDegrees(), f.IsVisible())
        side = self.side(fp)
        f.SetLayer(SIDE[side][0])
        f.SetMirrored(side == "B")
        f.SetTextSize(V(TEXT_SIZE, TEXT_SIZE))
        f.SetTextThickness(TEXT_STROKE)
        f.SetTextAngle(pcbnew.EDA_ANGLE(angle, pcbnew.DEGREES_T))
        f.SetVisible(True)
        p = f.GetTextPos()
        b = f.GetEffectiveTextShape().BBox()
        off = (b.GetLeft() - p.x, b.GetTop() - p.y, b.GetRight() - p.x, b.GetBottom() - p.y)
        f.SetTextSize(keep[0]); f.SetTextThickness(keep[1]); f.SetLayer(keep[2]); f.SetMirrored(keep[3])
        f.SetTextAngle(pcbnew.EDA_ANGLE(keep[4], pcbnew.DEGREES_T)); f.SetVisible(keep[5])
        return off

    def old(self, fp):
        """Current ink box and line class of the reference, or None when it is hidden or off silk."""
        f = fp.Reference()
        if not f.IsVisible() or f.GetLayer() not in (pcbnew.F_SilkS, pcbnew.B_SilkS):
            return None
        return (box_of(f.GetEffectiveTextShape()), line_class(f.GetDrawRotation().AsDegrees()))

    def check(self, box, side, angle):
        """None when the ink box is a legal spot, else the first rule it breaks."""
        g = self.g
        silk, mask, cu, cyl = (g.ln(l) for l in SIDE[side])
        R = rect(box)
        if not g.inside((box[0] + box[2]) // 2, (box[1] + box[3]) // 2):
            return "edge", ""
        for it in g.query(g.ln(pcbnew.Edge_Cuts), box):
            if hit(R, it.shape, 0):
                return "edge", ""
        for it in g.query(cyl, box):
            if hit(R, it.shape, 0):
                return "courtyard", it.ref
        for it in g.query(cu, box, SILK_GAP):
            if it.kind == "pad" and hit(R, it.shape, SILK_GAP):
                return "pad", it.name()
            if it.kind == "via" and hit(R, it.shape, 0):
                return "via", it.net
        for it in g.query(mask, box, SILK_GAP):
            if hit(R, it.shape, SILK_GAP):
                return "mask", it.name()
        for it in g.query(silk, box, LINE_GAP):
            if it.isref and it.ref in self.movable:
                continue
            if hit(R, it.shape, SILK_GAP):
                return "silk", it.name()
            if it.text and clash((box, angle), (it.box, it.angle)):
                return "text line", it.name()
        return None

    def candidates(self, ref, k=24):
        """Up to k legal spots for ref, cheapest first: dict(x, y, angle, side, box, cost, gap); plus a Counter of rejections."""
        fp = self.g.fps[ref]
        side = self.side(fp)
        body = self.body(fp)
        bx0, by0, bx1, by1 = body
        bcx, bcy = (bx0 + bx1) / 2, (by0 + by1) / 2
        raw = []
        offs = {}
        for angle in (0, 90):
            o = offs[angle] = self.ink(fp, angle)
            w, h = o[2] - o[0], o[3] - o[1]
            for gap in LABEL_GAPS:
                for half, along in (((bx1 - bx0 + w) / 2, "x"), ((by1 - by0 + h) / 2, "y")):
                    n = int(half // LABEL_SLIDE)
                    for i in range(-n, n + 1):
                        s = i * LABEL_SLIDE
                        cost = mm(gap) + 0.25 * mm(abs(s)) + (0.1 if angle else 0)
                        if along == "x":
                            for cy in (by0 - gap - h / 2, by1 + gap + h / 2):
                                raw.append((cost, angle, bcx + s, cy))
                        else:
                            for cx in (bx0 - gap - w / 2, bx1 + gap + w / 2):
                                raw.append((cost, angle, cx, bcy + s))
        raw.sort()
        out, why = [], collections.Counter()
        for cost, angle, cx, cy in raw:
            o = offs[angle]
            ax = int(round((cx - (o[0] + o[2]) / 2) / LABEL_SNAP)) * LABEL_SNAP
            ay = int(round((cy - (o[1] + o[3]) / 2) / LABEL_SNAP)) * LABEL_SNAP
            if any(c["angle"] == angle and abs(c["x"] - ax) < LABEL_SPREAD and abs(c["y"] - ay) < LABEL_SPREAD for c in out):
                continue
            box = (ax + o[0], ay + o[1], ax + o[2], ay + o[3])
            bad = self.check(box, side, angle)
            if bad:
                why[bad[0]] += 1
                continue
            out.append(dict(x=ax, y=ay, angle=angle, side=side, box=box, cost=cost, gap=box_gap(box, body)))
            if len(out) >= k:
                break
        return out, why
