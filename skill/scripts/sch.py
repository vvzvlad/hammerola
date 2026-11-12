"""Schematic review of a KiCad project: parts, nets, one net, a part's pins and nets with the sheet notes near it, every sheet note with its nearest parts, power rails (what feeds each, what draws from it), and what changed between two revisions; compact text, or JSON with --json.
usage: python3 sch.py parts|nets|texts FILE | net FILE NAME | around FILE REF... | rails FILE [--md] [--rail NET]... | diff OLD NEW   [--variant NAME] [--json]   (FILE = the root .kicad_sch, or a kicadxml .xml netlist for parts, nets, net, rails and diff; OLD/NEW = root schematics, netlists or project directories, whose root is the .kicad_sch named like the .kicad_pro, else the sheet no other sheet places; texts and around read every sheet reachable from the root, a sheet placed twice once per placement with that placement's references; a net is found by exact name, then case-insensitively, then by its name without the sheet path, then by a substring only one net has; rails counts a net as a rail by its name without the sheet path, by a power: symbol on it (read from the sheets, so not from an .xml), or by the pins on it; the netlist is exported by kicad-cli with --variant and cached in $TMPDIR/hammerola-sch/ until a .kicad_sch or .kicad_sym under the root's directory changes; mm, y down)
needs: python3; for a .kicad_sch, kicad-cli of KiCad 10 (/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli, else the one on PATH)"""
# Ported from Wiren Board's kicad_review.py and its wb_eda package (wb-agent-tools, wb-eda-review skill), under the
# MIT License:
#
# Copyright (c) 2026 Wiren Board
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
# documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
# rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
# persons to whom the Software is furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
# Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
# WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
# COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
# OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import sys, os, re, glob, json, math, hashlib, argparse, subprocess, tempfile
import xml.etree.ElementTree as ET

KICAD_CLI_APP = "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"
NOTE_RADIUS = 40  # mm: how far from a part `around` looks for notes
BIG_NET = 24  # members: a net larger than this is a supply or a bus, listed by its count only


def die(msg):
    raise SystemExit("sch: " + msg)


def refdes_key(ref):
    """Natural sort key, type-stable (str, int, str): C2 < C10, U$1, +3V1, GND22."""
    m = re.match(r'^(\D*?)(\d+)', ref or '')
    return (m.group(1), int(m.group(2)), ref or '') if m else (ref or '', 0, ref or '')


# ---------------------------------------------------------------- netlist (kicad-cli)
def newest(sch):
    """Newest mtime of the .kicad_sch and .kicad_sym files under the root's directory: an edited child sheet or
    library makes the cached netlist stale."""
    d = os.path.dirname(os.path.abspath(sch))
    return max((os.path.getmtime(p) for ext in ("kicad_sch", "kicad_sym")
                for p in glob.glob(os.path.join(d, "**", "*." + ext), recursive=True)), default=0)


def cache_file(sch, variant=None):
    key = os.path.abspath(sch) + ("\0" + variant if variant else "")
    return os.path.join(tempfile.gettempdir(), "hammerola-sch", "nl_%s.xml" % hashlib.md5(key.encode()).hexdigest()[:10])


def netlist(path, variant=None):
    """The kicadxml netlist of a root .kicad_sch, exported by kicad-cli and cached, or of a ready .xml."""
    if path.endswith(".xml"):
        return ET.parse(path).getroot()
    need_sch(path)
    cache = cache_file(path, variant)
    if not os.path.exists(cache) or os.path.getmtime(cache) < newest(path):
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        cli = KICAD_CLI_APP if os.path.exists(KICAD_CLI_APP) else "kicad-cli"
        cmd = [cli, "sch", "export", "netlist", "--format", "kicadxml", "-o", cache]
        try:
            r = subprocess.run(cmd + (["--variant", variant] if variant else []) + [path],
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        except FileNotFoundError:
            die("kicad-cli not found: install KiCad 10, or pass a kicadxml .xml netlist")
        if r.returncode != 0:
            die("kicad-cli failed:\n" + r.stderr.decode("utf-8", "replace"))
    return ET.parse(cache).getroot()


def need_sch(path):
    """Refuses anything but a .kicad_sch."""
    if path.endswith(".kicad_pcb"):
        die("%s is a board: this script reads the schematic (the root .kicad_sch, or its kicadxml .xml netlist); "
            "board queries are bq.py's" % path)
    if path.endswith(".xml"):
        die("%s is a netlist: this command reads the sheets, give the root .kicad_sch" % path)
    if not path.endswith(".kicad_sch"):
        die("not a .kicad_sch or a kicadxml .xml: %s" % path)


def _norm_val(v):
    return re.sub(r"[\s/]", "", v).lower()


def parts_map(root):
    """ref -> dict(value, footprint, lib, sheet, valuesch, mismatch). VALUESCH is a dead field Altium imports leave;
    a value that disagrees with it is flagged."""
    out = {}
    comps = root.find("components")
    for c in (comps if comps is not None else []):
        ls, sp = c.find("libsource"), c.find("sheetpath")
        val = (c.findtext("value") or "").strip()
        valuesch = next(((f.text or "").strip() for f in c.findall(".//field") if f.get("name") == "VALUESCH"), "")
        out[c.get("ref")] = dict(value=val, footprint=(c.findtext("footprint") or "").strip(),
                                 lib="%s:%s" % (ls.get("lib"), ls.get("part")) if ls is not None else "",
                                 sheet=sp.get("names") if sp is not None else "", valuesch=valuesch,
                                 mismatch=bool(valuesch and val and _norm_val(valuesch) != _norm_val(val)))
    return out


def pin_name(nd):
    """The pin's name; KiCad 10 writes it as NAME_NUMBER (VIN_2, A_2, Pin_1_1), the number is cut off."""
    fn, p = nd.get("pinfunction") or "", nd.get("pin") or ""
    return fn[:-len(p) - 1] if p and fn.endswith("_" + p) else fn


def nets_map(root):
    """net name -> [(ref, pin number, pin name)]."""
    nets = root.find("nets")
    return {n.get("name") or "": [(nd.get("ref"), nd.get("pin"), pin_name(nd)) for nd in n.findall("node")]
            for n in (nets if nets is not None else [])}


def resolve_net(name, names):
    """exact, then case-insensitive, then the one net whose name without its sheet path is the name, then a substring
    only one net has: (net or None, candidates)."""
    if name in names:
        return name, []
    ci = [n for n in names if n.lower() == name.lower()]
    if ci:
        return ci[0], []
    by_bare = [n for n in names if bare(n) == name]
    if len(by_bare) == 1:
        return by_bare[0], []
    sub = sorted(n for n in names if name.lower() in n.lower())
    return (sub[0], []) if len(sub) == 1 else (None, sub)


def find_net(name, names):
    """resolve_net, or the end of the run naming the candidates."""
    found, cand = resolve_net(name, names)
    if found is None:
        die("no net %s%s" % (name, "; candidates: " + ", ".join(cand[:20]) if cand else ""))
    return found


# ---------------------------------------------------------------- sheets (S-expressions)
_TOK = re.compile(r'"((?:[^"\\]|\\.)*)"|([()])|([^\s()"]+)', re.S)
_ESC = {"n": "\n", "t": "\t", "r": "\r"}


def parse(text):
    """A KiCad S-expression as nested lists of strings; a quoted string is unescaped (KiCad writes a newline as \\n)."""
    stack, cur = [], []
    for s, paren, atom in _TOK.findall(text):
        if paren == "(":
            stack.append(cur)
            cur = []
        elif paren == ")":
            done, cur = cur, stack.pop()
            cur.append(done)
        elif atom:
            cur.append(atom)
        else:
            cur.append(re.sub(r'\\(.)', lambda m: _ESC.get(m.group(1), m.group(1)), s) if "\\" in s else s)
    return cur[0] if cur else []


def kids(node, tag):
    return [c for c in node[1:] if isinstance(c, list) and c and c[0] == tag]


def kid(node, tag):
    return next(iter(kids(node, tag)), None)


def at(node):
    a = kid(node, "at")
    return (float(a[1]), float(a[2])) if a else (None, None)


def prop(node, name):
    return next((p[2] for p in kids(node, "property") if len(p) > 2 and p[1] == name), None)


def sheets(root):
    """Every placement of every sheet reachable from the root .kicad_sch, root first, depth first in file order:
    dict(path="/power/", file, sym={ref: [(x, y)]}, notes=[dict(kind, text, at)], power={net}). A sheet placed twice
    is two placements, each with the references its symbols carry for that placement in (instances); a file is parsed
    once. Sheet files are relative to the placing sheet's directory, as KiCad resolves them."""
    trees, out = {}, []

    def tree(f):
        if f not in trees:
            with open(f, encoding="utf-8") as fh:
                trees[f] = parse(fh.read())
        return trees[f]

    def visit(f, path, upath):
        t = tree(f)
        sym, power = {}, set()
        for s in kids(t, "symbol"):
            ref = prop(s, "Reference")
            for proj in kids(kid(s, "instances") or [], "project"):
                for ip in kids(proj, "path"):
                    if ip[1] == upath and kid(ip, "reference"):
                        ref = kid(ip, "reference")[1]
            if (kid(s, "lib_id") or ["", ""])[1].startswith("power:"):
                power.add(prop(s, "Value"))
            if ref and not ref.startswith("#"):
                sym.setdefault(ref, []).append(at(s))
        notes = [dict(kind=k, text=n[1], at=at(n)) for k in ("text", "text_box") for n in kids(t, k)
                 if len(n) > 1 and isinstance(n[1], str)]
        out.append(dict(path=path, file=f, sym=sym, notes=notes, power=power))
        for sh in kids(t, "sheet"):
            visit(os.path.join(os.path.dirname(f), prop(sh, "Sheetfile")), path + prop(sh, "Sheetname") + "/",
                  upath + "/" + kid(sh, "uuid")[1])

    root = os.path.abspath(root)
    visit(root, "/", "/" + kid(tree(root), "uuid")[1])
    return out


def nearest(sym, x, y, k=3):
    """The k parts nearest to (x, y), each by its nearest placement: [(dist, ref)]."""
    if x is None:
        return []
    d = sorted((min(math.hypot(px - x, py - y) for px, py in pts), ref) for ref, pts in sym.items())
    return [(round(dd, 1), r) for dd, r in d[:k]]


# ---------------------------------------------------------------- parts, nets, net
def parts(a):
    pm = parts_map(netlist(a.file, a.variant))
    rows = [dict(ref=r, **pm[r]) for r in sorted(pm, key=refdes_key)]
    txt = ["%-6s %-22s %-24s %s  %s%s%s" % (d["ref"], d["value"], d["footprint"], d["lib"], d["sheet"],
                                           "  [VALUESCH=%s]" % d["valuesch"] if d["valuesch"] else "",
                                           "  <<< value/VALUESCH MISMATCH" if d["mismatch"] else "") for d in rows]
    return dict(cmd="parts", parts=rows), txt + ["", "# %d parts" % len(rows)]


def nets(a):
    nm = nets_map(netlist(a.file, a.variant))
    order = sorted(nm, key=lambda n: (-len(nm[n]), n))
    return (dict(cmd="nets", nets=[dict(name=n, nodes=len(nm[n])) for n in order]),
            ["%4d  %s" % (len(nm[n]), n) for n in order] + ["", "# %d nets" % len(nm)])


def net(a):
    nm = nets_map(netlist(a.file, a.variant))
    name = find_net(a.name, nm)
    nodes = sorted(nm[name], key=lambda t: (refdes_key(t[0]), refdes_key(t[1])))
    return (dict(cmd="net", name=name, nodes=[dict(ref=r, pin=p, name=fn) for r, p, fn in nodes]),
            ["%s  (%d nodes)" % (name, len(nodes))] + [("  %-6s pin %-6s %s" % t).rstrip() for t in nodes])


# ---------------------------------------------------------------- around, texts
def around(a):
    need_sch(a.file)
    x = netlist(a.file, a.variant)
    nm, pm, shs = nets_map(x), parts_map(x), sheets(a.file)
    res, txt = [], []
    for ref in a.refs:
        where = [(s, s["sym"][ref]) for s in shs if ref in s["sym"]]
        if ref not in pm and not where:
            die("no part %s" % ref)
        d = pm.get(ref, dict(value="?", footprint="", lib="", sheet="", valuesch="", mismatch=False))
        pins = sorted(((p, n, fn) for n, nodes in nm.items() for r, p, fn in nodes if r == ref), key=lambda t: refdes_key(t[0]))
        touched = []
        for n in sorted({n for _, n, _ in pins}):
            members = sorted("%s.%s" % (r, p) for r, p, _ in nm[n])
            touched.append(dict(name=n, nodes=len(members), members=members if len(members) <= BIG_NET else None))
        # a note belongs to its sheet placement: only the notes of the placements this part is on
        notes = sorted((round(min(math.hypot(px - nt["at"][0], py - nt["at"][1]) for px, py in pos), 1), s["path"], nt["text"])
                       for s, pos in where for nt in s["notes"] if nt["at"][0] is not None)
        notes = [t for t in notes if t[0] < NOTE_RADIUS][:6]
        res.append(dict(ref=ref, value=d["value"], footprint=d["footprint"], lib=d["lib"], sheet=d["sheet"],
                        pins=[dict(pin=p, net=n, name=fn) for p, n, fn in pins], nets=touched,
                        notes=[dict(dist=dd, sheet=sp, text=t) for dd, sp, t in notes]))
        txt += ["===== %s  %s  %s  (%s)  %s =====" % (ref, d["value"], d["footprint"], d["lib"], d["sheet"])]
        if d["mismatch"]:
            txt.append("  !! value/VALUESCH mismatch: value=%s VALUESCH=%s" % (d["value"], d["valuesch"]))
        txt += ["  pins -> nets:"] + [("    pin %-6s -> %-28s %s" % t).rstrip() for t in pins]
        txt.append("  touched nets membership:")
        txt += ["    %s: %s" % (t["name"], ", ".join(t["members"]) if t["members"] is not None
                                else "%d nodes (supply/bus, abbreviated)" % t["nodes"]) for t in touched]
        if notes:
            txt.append("  nearby notes (<%dmm):" % NOTE_RADIUS)
            txt += ["    [%5smm] %s" % (dd, t.replace("\n", " / ")) for dd, _, t in notes]
        txt.append("")
    return dict(cmd="around", parts=res), txt[:-1]


def texts(a):
    need_sch(a.file)
    rows = []
    for s in sheets(a.file):
        for nt in sorted(s["notes"], key=lambda n: (n["at"][1] if n["at"][1] is not None else 1e9,
                                                    n["at"][0] if n["at"][0] is not None else 1e9)):
            rows.append(dict(sheet=s["path"], kind=nt["kind"], at=list(nt["at"]), text=nt["text"],
                             near=[dict(ref=r, dist=dd) for dd, r in nearest(s["sym"], *nt["at"])]))
    txt = []
    for i, r in enumerate(rows):
        loc = "(%g,%g)" % tuple(r["at"]) if r["at"][0] is not None else "(no-pos)"
        txt.append("[%3d] %s %-8s %-18s near: %s" % (i, r["sheet"], r["kind"], loc,
                                                    ", ".join("%s(%smm)" % (n["ref"], n["dist"]) for n in r["near"])))
        txt.append("      " + r["text"].replace("\n", "\n      "))
    return dict(cmd="texts", notes=rows), txt + ["", "# %d text notes" % len(rows)]


# ---------------------------------------------------------------- power rails
# Which nets are power rails, what feeds each, what draws from it. Currents are never computed here: they come from
# datasheets; this only makes sure no rail and no consumer is forgotten.
RAIL_NAME_RE = re.compile(
    r'^(?!.*[_-](?:EN|PG|GD|GOOD|OK|SENSE|DET|FB|ON|BTN|LED|FAULT|FLT|FAIL|INT)$)'  # a signal named after its rail: 3V3_EN, 5V_FAULT
    r'(?:'
    r'[+-]?\d+(?:[.,]\d+)?V(?:\d+)?(?:[_-]\w+)?'       # +5V, +3V3, -12V, 3.3V, +5V_ISO, 12V0
    r'|\+.+'                                            # any +NAME: +V_BUS
    r'|V(?:CC|DD|EE|ISO|REF|PP|DDA|DDIO|CORE|IO)\w*'    # VCC1, VDD_MCU, VISO …
    r'|[A-Z]*VDD\w*'                                    # PVDD, AVDD, DVDD, GVDD_AB
    r'|[AD]VCC\w*'                                      # AVCC1
    r'|V_?BUS|VIN|VBAT|VSYS'                            # exactly: VBUS_SENSE, VIN_SENSE are signals
    r'|V[+-]'                                           # V+, V-
    r'|(?:POWER|PWR|POW)(?:[_-]?(?:IN|OUT|\d+V\d*)\w*)?'  # PWR, POWER_IN, PWR_5V; PWRGD, PWR_LED, POWER_FAIL are signals
    r')$', re.I)
SUPPLY_HINTS = ("GND", "AGND", "DGND", "VSS")

# pin-name classes (the kicadxml pin name)
_SINK_PIN_RE = re.compile(
    r'^(?:V?IN\+?|VI|VCC\w*|VDD\w*|[AD]V(?:CC|DD)\w*|V\+|VBAT\w*|VBUS|VSYS|VS|VIO|PVDD|'
    r'VREG|VP|VDRV|VPP|HVIN\+?|\+?VIN\w*|PVIN\w*|AVIN|VLOGIC|VL|VCCA|VCCB|VDDA|VDDB|VDDIO)$', re.I)
_SRC_PIN_RE = re.compile(
    r'^(?:VO|VOUT\+?|\+?VOUT\w*|VISO|OUT|VCCOUT|VREGOUT|VREG_OUT|VLDO|PGOUT|VO\d|VDDOUT)$', re.I)
_SWITCH_PIN_RE = re.compile(r'^(?:SW\w*|LX|BOOT|BST|BS|PH|SWITCH|DRAIN)$', re.I)
_CTRL_PIN_RE = re.compile(
    r'^(?:EN\w*|CE|SHDN|/?SHDN|PG|PGOOD|FB|COMP|SS|RT|SYNC|MODE|SEL|ADJ|TRIM|CTRL|ON/OFF|'
    r'STBY|STANDBY|NC|DNC)$', re.I)

PASSIVE_PREFIXES = ("C", "R", "L", "FB", "RN", "CR", "CN")
CONNECTOR_PREFIXES = ("TB", "X", "XP", "XS", "J", "P", "SV")
LED_PREFIXES = ("LED", "HL", "VD")


def bare(net):
    """A net's name without its sheet path: /dac_amp/AVDD is AVDD."""
    return net.rsplit("/", 1)[-1] if net.startswith("/") else net


def is_supply_net(name):
    u = (name or "").upper()
    return any(u.startswith(h) for h in SUPPLY_HINTS)


def ref_prefix(ref):
    m = re.match(r'^([A-Za-z]+)', ref or '')
    return (m.group(1) if m else '').upper()


def part_kind(ref, part=None):
    """'led' | 'path' | 'passive' | 'connector' | 'testpoint' | 'active' by reference prefix. KiCad names an LED D:
    a D whose value or library part says LED is one."""
    p = ref_prefix(ref)
    if p in LED_PREFIXES or (p == "D" and part and "LED" in (part["value"] + " " + part["lib"].split(":")[-1]).upper()):
        return 'led'
    if p in ("D", "SJ", "JP", "F"):
        return 'path'
    if p == "TP":
        return 'testpoint'
    if p in PASSIVE_PREFIXES:
        return 'passive'
    if p in CONNECTOR_PREFIXES:
        return 'connector'
    return 'active'


def classify_pin(pin):
    """'sink' | 'src' | 'sw' | 'ctrl' | None for a pin name; VDD_2 (a name with its pad number) classifies as VDD."""
    p = (pin or '').strip()
    for cand in dict.fromkeys((p, re.sub(r'_\d+$', '', p))):
        if _SINK_PIN_RE.match(cand):
            return 'sink'
        if _SRC_PIN_RE.match(cand):
            return 'src'
        if _SWITCH_PIN_RE.match(cand):
            return 'sw'
        if _CTRL_PIN_RE.match(cand):
            return 'ctrl'
    return None


def build_rails(netpins, parts, power=(), extra=()):
    """netpins: {net: [(ref, pin)]} (pin = pin name, else number); parts: parts_map(); power: nets a power: symbol
    names; extra: nets the user forces in. Returns dict(rails={net: rail}, grounds=[net], switch_nodes={net: (ref,
    pin)}, edges=[(from, to, via, kind)]), kind: regulator (sink pin -> source pin of one part) / switcher (VIN -> SW
    -> L -> rail) / diode (A -> K) / feed (series element oriented from its fed side) / series (direction unknown).
    rail = dict(name, how, sinks, srcs, other, ctrl, leds, connectors, testpoints, passives, resistors); resistors:
    [(ref, pin, far net, [far members])], an R whose other end is on a non-ground, non-rail net: a load to check."""
    kind = lambda r: part_kind(r, parts.get(r))
    pins_by_ref = {}
    for nm, mem in netpins.items():
        for ref, pin in mem:
            pins_by_ref.setdefault(ref, []).append((pin, nm))
    grounds = sorted(n for n in netpins if is_supply_net(bare(n)))
    gset = set(grounds)
    members = lambda nm: netpins.get(nm, [])

    # switch nodes (buck SW / boost LX): never rails, but they link a regulator to a rail
    switch_nodes = {}
    for nm in netpins:
        if nm in gset:
            continue
        for r, p in members(nm):
            if kind(r) == 'active' and classify_pin(p) == 'sw':
                switch_nodes[nm] = (r, p)
                break

    how = {}
    for nm in netpins:
        if nm in gset or nm in switch_nodes:
            continue
        if nm in extra:
            how[nm] = 'user'
        elif nm in power:
            how[nm] = 'power-symbol'
        elif RAIL_NAME_RE.match(bare(nm)):
            how[nm] = 'name'
        elif any(kind(r) == 'active' and classify_pin(p) == 'sink' for r, p in members(nm)):
            how[nm] = 'implicit'  # an unnamed net feeding a VDD/VCC/VIN pin
        elif (any(kind(r) == 'active' and classify_pin(p) == 'src' for r, p in members(nm))
              and any(ref_prefix(r) == 'C' for r, _ in members(nm))):
            how[nm] = 'implicit'  # a regulator output with its own decoupling; a VOx pin with no cap is a signal
    # closure through series path elements (fuse / inductor / jumper / diode): the unnamed nets between a connector
    # and the first named rail; an LED is a load, not a path
    changed = True
    while changed:
        changed = False
        for nm in list(how):
            for r, p in members(nm):
                if ref_prefix(r) not in ("F", "L", "FB", "SJ", "JP", "D") or kind(r) == 'led':
                    continue
                for p2, nm2 in pins_by_ref.get(r, []):
                    if nm2 == nm or nm2 in gset or nm2 in switch_nodes or nm2 in how:
                        continue
                    how[nm2] = 'via %s' % r
                    changed = True

    rails = {}
    for nm, h in how.items():
        rail = dict(name=nm, how=h, sinks=[], srcs=[], other=[], ctrl=[], leds=[], connectors=[], testpoints=[],
                    passives={}, resistors=[])
        seen_far = set()
        for r, p in members(nm):
            k = kind(r)
            if k == 'active':
                c = classify_pin(p)
                (rail['sinks'] if c == 'sink' else rail['srcs'] if c == 'src'
                 else rail['ctrl'] if c == 'ctrl' else rail['other']).append((r, p))
            elif k == 'led':
                rail['leds'].append((r, p))
            elif k == 'connector':
                rail['connectors'].append((r, p))
            elif k == 'testpoint':
                rail['testpoints'].append(r)
            else:
                rail['passives'].setdefault(ref_prefix(r), []).append(r)
                if ref_prefix(r) in ("R", "RN"):
                    for p2, nm2 in pins_by_ref.get(r, []):
                        if nm2 != nm and nm2 not in gset and nm2 not in how and (r, nm2) not in seen_far:
                            seen_far.add((r, nm2))
                            rail['resistors'].append((r, p, nm2, ["%s.%s" % (r2, pp) for r2, pp in members(nm2) if r2 != r]))
        for key in ('sinks', 'srcs', 'other', 'ctrl', 'leds', 'connectors'):
            rail[key].sort(key=lambda t: (refdes_key(t[0]), str(t[1])))
        rail['testpoints'] = sorted(set(rail['testpoints']), key=refdes_key)
        for k in rail['passives']:
            rail['passives'][k] = sorted(set(rail['passives'][k]), key=refdes_key)
        rails[nm] = rail

    # edges: what feeds what
    edges, seen = [], set()

    def add(a, b, via, k):
        if (a, b, via) in seen or a == b:
            return
        seen.add((a, b, via))
        edges.append((a, b, via, k))
    for r, pins in pins_by_ref.items():
        pre = ref_prefix(r)
        on_rails = [(p, nm) for p, nm in pins if nm in rails]
        if pre in ("F", "L", "FB", "SJ", "JP", "R", "RN"):
            rail_nets = sorted({nm for _, nm in on_rails})
            if len(rail_nets) >= 2 and (pre not in ("R", "RN") or len(rail_nets) == 2):
                for a in rail_nets:
                    for b in rail_nets:
                        if a < b:
                            add(a, b, r, 'series')
            # inductor from a switch node to a rail: regulator -> rail
            for p, nm in pins:
                if nm in switch_nodes and pre in ("L", "FB"):
                    reg = switch_nodes[nm][0]
                    src_rails = {n2 for p2, n2 in pins_by_ref.get(reg, []) if n2 in rails and classify_pin(p2) == 'sink'}
                    for _, nm2 in on_rails:
                        for a in sorted(src_rails):
                            add(a, nm2, "%s+%s" % (reg, r), 'switcher')
        elif pre == "D" and kind(r) != 'led':
            an = {nm for p, nm in on_rails if re.match(r'^(A\d*|\+|1)$', p or '')}
            ca = {nm for p, nm in on_rails if re.match(r'^(C\d*|K\d*|-|2)$', p or '')}
            for a in sorted(an):
                for b in sorted(ca):
                    add(a, b, r, 'diode')
        elif kind(r) == 'active':
            sinks = {nm for p, nm in on_rails if classify_pin(p) == 'sink'}
            srcs = {nm for p, nm in on_rails if classify_pin(p) == 'src'}
            for a in sorted(sinks):
                for b in sorted(srcs):
                    add(a, b, r, 'regulator')
    # orient series links from the side already fed (a connector, a source pin, a directed edge) to the side that is
    # not; iterate so a chain connector -> D -> F -> L -> rail resolves. A test point feeds nothing. Links that stay
    # ambiguous (both or neither side fed) remain 'series'.
    fed = {nm: bool(rails[nm]['srcs'] or rails[nm]['connectors']) for nm in rails}
    for a, b, _, k in edges:
        if k != 'series':
            fed[b] = True
    changed = True
    while changed:
        changed = False
        for i, (a, b, via, k) in enumerate(edges):
            if k != 'series':
                continue
            if fed.get(a) and not fed.get(b):
                edges[i] = (a, b, via, 'feed'); fed[b] = True; changed = True
            elif fed.get(b) and not fed.get(a):
                edges[i] = (b, a, via, 'feed'); fed[a] = True; changed = True
    edges.sort(key=lambda e: (str(e[0]), str(e[1]), refdes_key(e[2])))
    return dict(rails=rails, grounds=grounds, switch_nodes=switch_nodes, edges=edges)


def rail_order(rails, edges):
    """Rails upstream first: depth = the longest directed feed path from a root rail; ties by name."""
    preds = {}
    for a, b, _, k in edges:
        if k != 'series':
            preds.setdefault(b, set()).add(a)
    memo = {}

    def depth(n, stack=()):
        if n in memo:
            return memo[n]
        if n in stack:  # OR-ed rails feeding each other
            return 0
        memo[n] = max((depth(a, stack + (n,)) + 1 for a in preds.get(n, ())), default=0)
        return memo[n]
    return sorted(rails, key=lambda n: (depth(n), refdes_key(n)))


def format_rails(res, order, display, path, md=False):
    """Text dump of build_rails(), or with md the Markdown skeleton of the per-rail consumption tables, every current
    left as «—» to fill from datasheets."""
    rails, edges, out = res['rails'], res['edges'], []
    P = out.append
    fed_by = lambda nm: [(a, via, k) for a, b, via, k in edges if b == nm and k != 'series']
    feeds = lambda nm: [(b, via, k) for a, b, via, k in edges if a == nm and k != 'series']
    series_of = lambda nm: [(b if a == nm else a, via) for a, b, via, k in edges if k == 'series' and nm in (a, b)]
    pins = lambda lst: ", ".join("%s.%s" % t for t in lst)
    disp_via = lambda via: "+".join(display(v) for v in via.split("+"))
    if not md:
        P("# %s — power rails: %d candidate rail(s), %d ground net(s) %s" % (path, len(rails), len(res['grounds']), res['grounds']))
        if res['switch_nodes']:
            P("# switch nodes (not rails): " + ", ".join("%s (%s.%s)" % (n, r, p) for n, (r, p) in sorted(res['switch_nodes'].items())))
        P("# 'how' = why the net counts as a rail: name / power-symbol / implicit (feeds a VDD/VCC/VIN pin) / "
          "via <series part> / user")
        for nm in order:
            r = rails[nm]
            P("\n== %s  [%s]" % (nm, r['how']))
            if fed_by(nm):
                P("   fed by  : " + "; ".join("%s → via %s (%s)" % t for t in fed_by(nm)))
            if r['srcs']:
                P("   sources : " + ", ".join("%s.%s" % (display(x), p) for x, p in r['srcs']))
            if r['connectors']:
                P("   connectors: " + pins(r['connectors']))
            if r['sinks']:
                P("   sinks   :")
                P("\n".join("      %s.%s" % (display(x), p) for x, p in r['sinks']))
            if r['leds']:
                P("   LEDs    : " + ", ".join("%s.%s" % (display(x), p) for x, p in r['leds']))
            if r['other']:
                P("   other active pins (classify by hand): " + pins(r['other']))
            if r['ctrl']:
                P("   control pins (EN/FB/… — not loads): " + pins(r['ctrl']))
            if r['resistors']:
                P("   resistive branches (LED / pull-up / divider — loads to check):")
                for x, p, far, mem in r['resistors']:
                    P("      %s → %s: %s%s" % (display(x), far, ", ".join(mem[:4]), " …(+%d)" % (len(mem) - 4) if len(mem) > 4 else ""))
            if r['passives']:
                P("   passives: " + "; ".join("%s×%d (%s%s)" % (k, len(v), ", ".join(v[:8]), " …" if len(v) > 8 else "")
                                            for k, v in sorted(r['passives'].items())))
            if r['testpoints']:
                P("   test points: " + ", ".join(r['testpoints']))
            if feeds(nm):
                P("   feeds   : " + "; ".join("%s via %s (%s)" % t for t in feeds(nm)))
            if series_of(nm):
                P("   series  : " + "; ".join("%s — %s" % t for t in series_of(nm)))
        P("\n# Currents are NOT computed here: fill them from datasheets. Re-run with --md for the table skeleton.")
        return out

    P("<!-- skeleton from `rails --md` on %s; fill every «—» from a located datasheet or a computation, "
      "delete rows that are not loads -->" % path)
    P("\n### Consumers\n")
    P("| Consumer | Rail | Typical | Maximum | Data source |")
    P("|---|---|---|---|---|")
    for nm in order:
        r = rails[nm]
        for x, p in r['sinks'] + r['leds']:
            P("| %s (%s) | %s | — | — | — |" % (display(x), p, nm))
        for x, p in r['other']:
            P("| %s (%s) — pin not classified, check | %s | — | — | — |" % (display(x), p, nm))
        for x, p, far, mem in r['resistors']:
            P("| branch %s → %s (%s) | %s | — | — | computed |" % (display(x), far, ", ".join(mem[:3]), nm))
    P("\n### Per-rail summary\n")
    P("| Rail | Source, voltage | Load typ. / max. | Source capability | Margin, comment |")
    P("|---|---|---|---|---|")
    for nm in order:
        r = rails[nm]
        src = ("; ".join("%s ← %s" % (disp_via(via), a) for a, via, k in fed_by(nm))
               or ", ".join("%s.%s" % (display(x), p) for x, p in r['srcs']) or pins(r['connectors']) or "—")
        P("| **%s** | %s | — / — | — | — |" % (nm, src))
    P("\n### Dissipation and heating at T<sub>A</sub> = +85 °C (maximum load)\n")
    P("| Element | P, W | θ<sub>JA</sub> | T<sub>J</sub> | Verdict |")
    P("|---|---|---|---|---|")
    seen = set()
    for a, b, via, k in edges:
        if k in ('regulator', 'switcher', 'diode') and via not in seen:
            seen.add(via)
            P("| %s (%s → %s) | — | — | — | — |" % (disp_via(via), a, b))
    return out


def rails(a):
    x = netlist(a.file, a.variant)
    nm, pm = nets_map(x), parts_map(x)
    netpins = {n: [(r, fn or p) for r, p, fn in nodes] for n, nodes in nm.items()}
    # kicadxml leaves power symbols out: the nets they name are read from the sheets
    power = set().union(*(s["power"] for s in sheets(a.file))) & set(nm) if a.file.endswith(".kicad_sch") else set()
    extra = [find_net(e, netpins) for e in a.rail]
    res = build_rails(netpins, pm, power, extra)
    order = rail_order(res['rails'], res['edges'])
    display = lambda ref: "%s [%s]" % (ref, pm.get(ref, {}).get('value') or pm.get(ref, {}).get('lib') or '?')
    pin = lambda lst: ["%s.%s" % t for t in lst]
    js = dict(cmd="rails", grounds=res['grounds'], switch_nodes={n: "%s.%s" % rp for n, rp in res['switch_nodes'].items()},
              rails=[dict(name=n, how=r['how'], sources=pin(r['srcs']), sinks=pin(r['sinks']), leds=pin(r['leds']),
                          connectors=pin(r['connectors']), testpoints=r['testpoints'], other=pin(r['other']), ctrl=pin(r['ctrl']),
                          resistors=[dict(ref=x, pin=p, far=far, members=m) for x, p, far, m in r['resistors']],
                          passives=r['passives']) for n in order for r in [res['rails'][n]]],
              edges=[{"from": e[0], "to": e[1], "via": e[2], "kind": e[3]} for e in res['edges']])
    return js, format_rails(res, order, display, a.file, a.md)


# ---------------------------------------------------------------- diff
def is_backup(p):
    """A KiCad backup by file name or directory: -bak, _autosave, ~, <project>-backups/, .history/."""
    if any(b in os.path.basename(p) for b in ("-bak", "_autosave", "~", ".kicad_sch-bak")):
        return True
    return any(b in c for c in os.path.dirname(p).split(os.sep) for b in ("-backups", ".history"))


def project_root(d):
    """The root sheet of the project in directory d: the .kicad_sch named like the .kicad_pro beside it, else the one
    no other sheet places."""
    cands = ([p for p in glob.glob(os.path.join(d, "*.kicad_sch")) if not is_backup(p)]
             or [p for p in glob.glob(os.path.join(d, "**", "*.kicad_sch"), recursive=True) if not is_backup(p)])
    if not cands:
        die("no .kicad_sch in %s" % d)
    named = [p for p in cands if os.path.exists(p[:-len("kicad_sch")] + "kicad_pro")]
    if len(named) == 1:
        return named[0]
    placed = set()
    for p in cands:
        with open(p, encoding="utf-8") as f:
            for m in re.finditer(r'\(property "Sheetfile" "((?:[^"\\]|\\.)*)"', f.read()):
                placed.add(os.path.normpath(os.path.join(os.path.dirname(p), m.group(1))))
    roots = sorted(p for p in cands if os.path.normpath(p) not in placed)
    if len(roots) != 1:
        die("cannot tell the root sheet in %s: %s" % (d, ", ".join(roots or cands)))
    return roots[0]


AUTO_NET = r'^(Net-\(|unconnected-)'


def diff_parts(old, new):
    """old, new: {ref: (sig, display)}. A removed and an added ref with the same signature, unique on BOTH sides, are
    one part renumbered; an ambiguous signature stays added/removed. Returns dict(added, removed, changed=[(ref,
    old_disp, new_disp)], renamed=[(old_ref, new_ref, disp)], rename_map)."""
    so, sn = set(old), set(new)
    changed = sorted(((r, old[r][1], new[r][1]) for r in so & sn if old[r][0] != new[r][0]), key=lambda t: refdes_key(t[0]))
    rem, add = so - sn, sn - so
    rem_by, add_by = {}, {}
    for r in rem:
        rem_by.setdefault(old[r][0], []).append(r)
    for r in add:
        add_by.setdefault(new[r][0], []).append(r)
    renamed = sorted(((o[0], add_by[sig][0], new[add_by[sig][0]][1]) for sig, o in rem_by.items()
                      if len(o) == 1 and len(add_by.get(sig, ())) == 1), key=lambda t: refdes_key(t[0]))
    return dict(added=sorted(add - {n for _, n, _ in renamed}, key=refdes_key),
                removed=sorted(rem - {o for o, _, _ in renamed}, key=refdes_key),
                changed=changed, renamed=renamed, rename_map={o: n for o, n, _ in renamed})


def diff_nets(old, new, rename_map):
    """old, new: {name: {(ref, pin)}}; rename_map is applied to OLD members so a renumbered part changes no net.
    Named nets are matched by name (supply nets left out of 'changed'), auto-named ones by their member set so a
    renumbered Net-(…) collapses. Returns dict(new_named, gone_named, changed_named=[(name, gained, lost)],
    new_auto=[(name, members)], gone_auto, renumbered_auto)."""
    mkey = lambda m: (str(m[0]), str(m[1]))
    nkey = lambda s: (s is None, str(s))
    remap = lambda members: {(rename_map.get(p, p), pin) for p, pin in members}
    is_auto = lambda n: bool(re.match(AUTO_NET, n or ''))
    o_named = {n: remap(m) for n, m in old.items() if not is_auto(n)}
    n_named = {n: m for n, m in new.items() if not is_auto(n)}
    changed_named = [(nm, sorted(n_named[nm] - o_named[nm], key=mkey), sorted(o_named[nm] - n_named[nm], key=mkey))
                     for nm in sorted(set(o_named) & set(n_named), key=nkey)
                     if not is_supply_net(nm) and o_named[nm] != n_named[nm]]
    o_sig, n_sig = {}, {}
    for nm, m in old.items():
        if is_auto(nm):
            o_sig.setdefault(frozenset(remap(m)), []).append(nm)
    for nm, m in new.items():
        if is_auto(nm):
            n_sig.setdefault(frozenset(m), []).append(nm)
    renumbered, new_auto, gone_auto = 0, [], []
    for sig in set(o_sig) | set(n_sig):
        on, nn = o_sig.get(sig, []), n_sig.get(sig, [])
        renumbered += min(len(on), len(nn))
        members = sorted(sig, key=mkey)
        new_auto += [(nm, members) for nm in nn[len(on):]]
        gone_auto += [(nm, members) for nm in on[len(nn):]]
    return dict(new_named=sorted(set(n_named) - set(o_named), key=nkey), gone_named=sorted(set(o_named) - set(n_named), key=nkey),
                changed_named=changed_named, new_auto=sorted(new_auto, key=lambda t: nkey(t[0])),
                gone_auto=sorted(gone_auto, key=lambda t: nkey(t[0])), renumbered_auto=renumbered)


def diff(a):
    old = project_root(a.old) if os.path.isdir(a.old) else a.old
    new = project_root(a.new) if os.path.isdir(a.new) else a.new
    sys.stderr.write("# diff OLD=%s\n#      NEW=%s\n" % (old, new))
    ro, rn = netlist(old, a.variant), netlist(new, a.variant)
    po, pn, no, nn = parts_map(ro), parts_map(rn), nets_map(ro), nets_map(rn)
    vf = lambda d: "%-22s %s" % (d["value"], d["footprint"])
    pd = diff_parts({r: ((d["value"], d["footprint"]), vf(d)) for r, d in po.items()},
                    {r: ((d["value"], d["footprint"]), vf(d)) for r, d in pn.items()})
    o_nets = {n: {(r, p) for r, p, _ in nodes} for n, nodes in no.items()}
    n_nets = {n: {(r, p) for r, p, _ in nodes} for n, nodes in nn.items()}
    nd = diff_nets(o_nets, n_nets, pd['rename_map'])
    dot = lambda ms: ["%s.%s" % m for m in ms]
    first60 = lambda ns: ", ".join(ns[:60]) + (" ..." if len(ns) > 60 else "")
    fields = lambda r, d: dict(ref=r, value=d["value"], footprint=d["footprint"])
    js = dict(cmd="diff", old=old, new=new,
              parts=dict(old=len(po), new=len(pn), added=[fields(r, pn[r]) for r in pd['added']],
                         removed=[fields(r, po[r]) for r in pd['removed']],
                         renamed=[dict(old=o, **fields(n, pn[n])) for o, n, _ in pd['renamed']],
                         changed=[dict(ref=r, value=[po[r]["value"], pn[r]["value"]], footprint=[po[r]["footprint"], pn[r]["footprint"]])
                                  for r, _, _ in pd['changed']]),
              nets=dict(old=len(no), new=len(nn), added=nd['new_named'], removed=nd['gone_named'],
                        changed=[dict(name=n, gained=dot(g), lost=dot(l)) for n, g, l in nd['changed_named']],
                        added_auto=[dict(name=n, members=dot(m)) for n, m in nd['new_auto']],
                        removed_auto=[dict(name=n, members=dot(m)) for n, m in nd['gone_auto']],
                        renumbered_auto=nd['renumbered_auto']))
    added, removed, changed, renamed = pd['added'], pd['removed'], pd['changed'], pd['renamed']
    count = "+%d / -%d / ~%d changed / =%d renamed" % (len(added), len(removed), len(changed), len(renamed))
    T = ["# note: parts matched by refdes, a renumbered part by its value and footprint; nets by name, Net-(...) by members.",
         "", "## Parts: %d -> %d   (%s)" % (len(po), len(pn), count), "", "### Added in NEW (%d):" % len(added)]
    T += ["  + %-6s %s" % (r, vf(pn[r])) for r in added]
    T += ["", "### Removed (only in OLD) (%d):" % len(removed)] + ["  - %-6s %s" % (r, vf(po[r])) for r in removed]
    if renamed:
        T += ["", "### Renamed (refdes shift, same part) (%d):" % len(renamed)]
        T += ["  = %s -> %-6s %s" % (o, n, vf(pn[n])) for o, n, _ in renamed]
    T += ["", "### Changed value/footprint:"]
    for r, _, _ in changed:
        chg = (["value %r->%r" % (po[r]["value"], pn[r]["value"])] if po[r]["value"] != pn[r]["value"] else []) + \
              (["fp %r->%r" % (po[r]["footprint"], pn[r]["footprint"])] if po[r]["footprint"] != pn[r]["footprint"] else [])
        T.append("  ~ %-6s %s" % (r, "; ".join(chg)))
    T += ["  (%d changed)" % len(changed), "", "=== NETS ===",
          "## Nets: %d -> %d   (+%d named-new / -%d named-gone / ~%d named-changed; auto: +%d new / -%d gone / =%d renumbered)" % (
              len(no), len(nn), len(nd['new_named']), len(nd['gone_named']), len(nd['changed_named']),
              len(nd['new_auto']), len(nd['gone_auto']), nd['renumbered_auto']), "",
          "### New nets (named) (%d): %s" % (len(nd['new_named']), first60(nd['new_named'])),
          "### Removed nets (named) (%d): %s" % (len(nd['gone_named']), first60(nd['gone_named'])),
          "", "### Changed-membership nets (named, non-supply):"]
    for n, g, l in nd['changed_named']:
        a_, b_ = o_nets.get(n, set()), n_nets.get(n, set())
        T.append("  ~ %s: %d->%d nodes (supply/bus)" % (n, len(a_), len(b_)) if len(a_) > BIG_NET or len(b_) > BIG_NET
                 else "  ~ %s: +[%s] -[%s]" % (n, ", ".join(dot(g)), ", ".join(dot(l))))
    for title, rows, sign in (("New", nd['new_auto'], "+"), ("Removed", nd['gone_auto'], "-")):
        if rows:
            T += ["", "### %s local (auto-named) nets:" % title] + ["  %s %s: %s" % (sign, n, dot(m)) for n, m in rows]
    if nd['renumbered_auto']:
        T += ["", "###   (%d auto-named nets renumbered with no membership change — suppressed)" % nd['renumbered_auto']]
    T += ["", "# parts: old %d  new %d  (+%d / -%d / ~%d / =%d)" % (len(po), len(pn), len(added), len(removed), len(changed), len(renamed)),
          "# nets: old %d  new %d  (+%d / -%d / ~%d)" % (len(no), len(nn), len(nd['new_named']), len(nd['gone_named']), len(nd['changed_named']))]
    return js, T


# ---------------------------------------------------------------- main
def parser():
    p = argparse.ArgumentParser(prog="sch.py")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true")
    common.add_argument("--variant")
    sp = p.add_subparsers(dest="cmd", required=True)
    for name in ("parts", "nets", "texts"):
        sp.add_parser(name, parents=[common]).add_argument("file")
    s = sp.add_parser("net", parents=[common]); s.add_argument("file"); s.add_argument("name")
    s = sp.add_parser("around", parents=[common]); s.add_argument("file"); s.add_argument("refs", nargs="+")
    s = sp.add_parser("rails", parents=[common]); s.add_argument("file")
    s.add_argument("--md", action="store_true"); s.add_argument("--rail", action="append", default=[])
    s = sp.add_parser("diff", parents=[common]); s.add_argument("old"); s.add_argument("new")
    return p


CMDS = dict(parts=parts, nets=nets, net=net, around=around, texts=texts, rails=rails, diff=diff)


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    a = parser().parse_args()
    res, txt = CMDS[a.cmd](a)
    print(json.dumps(res, ensure_ascii=False) if a.json else "\n".join(txt))


if __name__ == "__main__":
    main()
