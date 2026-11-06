"""Findings filter: the rows of a DRC report (drc.sh) and, when given, the geometry-gate findings (geocheck.py), kept by type, net, footprint, box or distance from a point; one line per finding (source, type, severity, each item's ref, net and position), or the counts by type, ref or net.
usage: python3 findings.py <drc.json> [geo.json] [--type T1,T2] [--net NET] [--ref REF] [--box X1 Y1 X2 Y2] [--near X Y R] [--by type|ref|net] [--json]   (mm; every filter given must hold, each for at least one item of the finding; ref and net come from kicad-cli's item descriptions, "Pad 3 [NET] of U19 on F.Cu" is U19.3 on NET; a geometry finding has a net and a point but no ref, so --ref drops it; --by counts a finding once under each ref or net its items name, "-" for an item without one)
needs: python3; delta.py beside this file"""
import sys, os, re, json, math, argparse, collections, importlib.util

sys.dont_write_bytecode = True  # no __pycache__ beside the installed scripts
_spec = importlib.util.spec_from_file_location("delta", os.path.join(os.path.dirname(os.path.abspath(__file__)), "delta.py"))
delta = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(delta)


def parse(f):
    """Adds ref, pad and net to each item of a finding row of delta.findings()."""
    for i in f["items"]:
        if f["src"] == "geo":
            i.update(ref=None, pad=None, net=i["d"].rsplit(" ", 1)[0])  # delta writes "NET LAYER"
            continue
        d = re.sub(r"'[^']*'", "''", i["d"])  # a quoted zone name or text may hold " of " or brackets
        net = re.search(r"\[([^\]]*)\]", d)
        plain = re.sub(r"\[[^\]]*\]", "[]", d)
        # "of REF" first: "Footprint text of R35 (R35)" belongs to R35, not to "text"
        ref = re.search(r"\bof (\S+)", plain) or re.match(r"Footprint (\S+)", plain)
        pad = re.search(r"\bpad (\S+) \[", plain, re.I)
        i.update(ref=ref.group(1) if ref else None, pad=pad.group(1) if pad else None,
                 net=net.group(1) if net and net.group(1) != "<no net>" else None)
    return f


def keep(f, a):
    its = f["items"]
    if a.type and f["type"] not in a.type.split(","):
        return False
    if a.net and not any(i["net"] == a.net for i in its):
        return False
    if a.ref and not any(i["ref"] == a.ref for i in its):
        return False
    if a.box:
        x0, x1, y0, y1 = sorted(a.box[0::2]) + sorted(a.box[1::2])
        if not any(x0 <= i["x"] <= x1 and y0 <= i["y"] <= y1 for i in its):
            return False
    return not a.near or any(math.hypot(i["x"] - a.near[0], i["y"] - a.near[1]) <= a.near[2] for i in its)


def item(i):
    ref = "%s.%s" % (i["ref"], i["pad"]) if i["ref"] and i["pad"] else i["ref"] or "-"
    return "%s %s (%.3f, %.3f)" % (ref, i["net"] or "-", i["x"], i["y"])


def parser():
    p = argparse.ArgumentParser(prog="findings.py")
    p.add_argument("drc")
    p.add_argument("geo", nargs="?")
    p.add_argument("--type"); p.add_argument("--net"); p.add_argument("--ref")
    p.add_argument("--box", type=float, nargs=4, metavar=("X1", "Y1", "X2", "Y2"))
    p.add_argument("--near", type=float, nargs=3, metavar=("X", "Y", "R"))
    p.add_argument("--by", choices=("type", "ref", "net"))
    p.add_argument("--json", action="store_true")
    return p


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    a = parser().parse_intermixed_args()
    rows = [parse(f) for f in delta.findings(json.load(open(a.drc)), json.load(open(a.geo)) if a.geo else [])]
    kept = [f for f in rows if keep(f, a)]
    if a.by:
        c = collections.Counter()
        for f in kept:
            c.update({f["type"]} if a.by == "type" else {i[a.by] or "-" for i in f["items"]})
        counts = sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))
        if a.json:
            print(json.dumps(dict(counts)))
            return
        print("findings: %d of %d, by %s:" % (len(kept), len(rows), a.by))
        for k, n in counts:
            print("  %6d  %s" % (n, k))
    elif a.json:
        print(json.dumps(kept))
    else:
        print("findings: %d of %d" % (len(kept), len(rows)))
        for f in kept:
            print("  %-11s %-26s %-7s %s" % (f["src"], f["type"], f["sev"], " ~ ".join(item(i) for i in f["items"])))


if __name__ == "__main__":
    main()
