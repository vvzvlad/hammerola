"""Findings delta after a batch of edits: this run's DRC report (drc.sh) and geometry-gate findings (geocheck.py) against the previous run kept in a state file; prints what appeared and what went away (type, items with their nets and refs, coordinates), counts by type, the stop-rule count, then stores this run.
usage: python3 delta.py <drc.json> <geo.json> <state.json>   (no state file yet: everything is new and becomes the baseline; a state file of another board is refused; count = DRC errors + dangling tracks/vias + unconnected + geometry-gate findings, layout-rules.md "DRC errors": no new low for 3 batches means stop editing)
needs: python3"""
import sys, os, json, math, re, collections

TOL = 2.0        # mm: a finding whose items got new uuids (Copperpour modify_trace) or whose track kicad-cli names by
                 # another segment of it (1.4 mm seen) still matches if every item stays within this distance
STOP_AFTER = 3   # batches without a new low of the count


def findings(drc, geo):
    out = []
    for src, key in (("drc", "violations"), ("unconnected", "unconnected_items")):
        for v in drc.get(key, []):
            out.append(dict(src=src, type=v["type"], sev=v["severity"], desc=v["description"],
                            items=[dict(d=i["description"], x=i["pos"]["x"], y=i["pos"]["y"], uuid=i.get("uuid")) for i in v["items"]]))
    for f in geo:
        out.append(dict(src="geo", type=f["kind"], sev="gate", desc=f["msg"],
                        items=[dict(d="%s %s" % (f["net"], f["layer"]), x=f["x"], y=f["y"], uuid=None)]))
    return out


def counted(f):
    """Part of the stop-rule count: DRC errors, dangling tracks and vias, unconnected items, gate findings."""
    return f["src"] != "drc" or f["sev"] == "error" or f["type"] in ("track_dangling", "via_dangling")


def exact(f):
    if f["src"] == "geo":
        return (f["src"], f["type"], f["desc"], f["items"][0]["d"], f["items"][0]["x"], f["items"][0]["y"])
    return (f["src"], f["type"], tuple(sorted(i["uuid"] or "" for i in f["items"])))


def loose(f):
    """What stays when uuids are regenerated: type and item descriptions without track lengths."""
    if f["src"] == "geo":
        return (f["src"], f["type"], f["items"][0]["d"])
    return (f["src"], f["type"], tuple(sorted(re.sub(r", length [\d.]+ mm", "", i["d"]) for i in f["items"])))


def gap(a, b):
    """Largest distance between corresponding items of two findings with one loose key, mm."""
    ka = sorted(a["items"], key=lambda i: (re.sub(r", length [\d.]+ mm", "", i["d"]), i["x"], i["y"]))
    kb = sorted(b["items"], key=lambda i: (re.sub(r", length [\d.]+ mm", "", i["d"]), i["x"], i["y"]))
    return max(math.hypot(p["x"] - q["x"], p["y"] - q["y"]) for p, q in zip(ka, kb))


def nets(f):
    """Nets an unconnected finding joins: kicad-cli names a different pad or track of the same end on each run."""
    return tuple(sorted({n for i in f["items"] for n in re.findall(r"\[([^\]]*)\]", i["d"])}))


def centre(f):
    return (sum(i["x"] for i in f["items"]) / len(f["items"]), sum(i["y"] for i in f["items"]) / len(f["items"]))


def match(old, new):
    """Pairs old and new findings; returns the unpaired old and new ones and how many pairs each test made: same uuids
    (or the same gate finding), unconnected items of the same nets, then same type and item descriptions with every
    item within TOL, a uuid kept or none."""
    left_old, left_new, how = set(range(len(old))), set(range(len(new))), collections.Counter()

    def take(cand):
        for c in sorted(cand):
            i, j, kind = c[-3:]
            if i in left_old and j in left_new:
                left_old.discard(i)
                left_new.discard(j)
                how[kind] += 1

    groups = collections.defaultdict(list)
    for i in sorted(left_old, key=lambda i: (old[i]["items"][0]["x"], old[i]["items"][0]["y"])):
        groups[exact(old[i])].append(i)
    for j in sorted(left_new, key=lambda j: (new[j]["items"][0]["x"], new[j]["items"][0]["y"])):
        g = groups.get(exact(new[j]))
        if g:
            take([(g.pop(0), j, "uuid")])
    uo = [i for i in left_old if old[i]["src"] == "unconnected"]
    un = [j for j in left_new if new[j]["src"] == "unconnected"]
    take([(math.dist(centre(old[i]), centre(new[j])), i, j, "net") for i in uo for j in un if nets(old[i]) == nets(new[j])])
    rest = collections.defaultdict(list)
    for i in left_old:
        if old[i]["src"] != "unconnected":
            rest[loose(old[i])].append(i)
    cand = []
    for j in left_new:
        for i in rest.get(loose(new[j]), ()):
            d = gap(old[i], new[j])
            if d <= TOL:
                # one item kept its uuid (the other was re-created), or every item got a new one
                kept = bool({x["uuid"] for x in old[i]["items"]} & {x["uuid"] for x in new[j]["items"]} - {None})
                cand.append((not kept, d, i, j, "kept" if kept else "position"))
    take(cand)
    return sorted(left_old), sorted(left_new), how


def line(sign, f):
    items = " ~ ".join("(%.3f, %.3f) %s" % (i["x"], i["y"], i["d"]) for i in f["items"])
    return "  %s %s [%s] %s | %s" % (sign, f["type"], f["sev"], items, f["desc"])


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    drc = json.load(open(sys.argv[1]))
    now = findings(drc, json.load(open(sys.argv[2])))
    st = json.load(open(sys.argv[3])) if os.path.exists(sys.argv[3]) else dict(runs=[], findings=[])
    if st["runs"] and st["runs"][-1]["source"] != drc.get("source"):
        sys.exit("delta: %s is a report of %s, but %s holds the runs of %s" % (
            sys.argv[1], drc.get("source"), sys.argv[3], st["runs"][-1]["source"]))
    old = st["findings"]
    gone, new, how = match(old, now)
    n = len(st["runs"]) + 1
    if st["runs"]:
        print("delta: run %d vs run %d: %d new, %d gone, %d unchanged (same uuids or gate finding %d, one uuid kept %d, by position %d, "
              "unconnected by net %d)" % (n, n - 1, len(new), len(gone), sum(how.values()), how["uuid"], how["kept"],
                                          how["position"], how["net"]))
    else:
        print("delta: run 1, no previous run: every finding is new, stored as the baseline")
    for title, sign, src, idx in (("new", "+", now, new), ("gone", "-", old, gone)):
        if idx:
            print("%s:" % title)
            for k in sorted(idx, key=lambda k: (not counted(src[k]), src[k]["type"], src[k]["items"][0]["x"], src[k]["items"][0]["y"])):
                print(line(sign, src[k]))
    c_now = collections.Counter(f["type"] for f in now)
    c_old = collections.Counter(f["type"] for f in old)
    print("by type (now, change):")
    for t in sorted(set(c_now) | set(c_old)):
        print("  %-28s %5d  %+d" % (t, c_now[t], c_now[t] - c_old[t]))
    parts = collections.Counter()
    for f in now:
        if counted(f):
            parts["unconnected" if f["src"] == "unconnected" else "geometry" if f["src"] == "geo" else
                  "dangling" if f["type"] in ("track_dangling", "via_dangling") and f["sev"] != "error" else "errors"] += 1
    count = sum(parts.values())
    print("total: %d findings; count = %d DRC errors + %d dangling + %d unconnected + %d geometry = %d" % (
        len(now), parts["errors"], parts["dangling"], parts["unconnected"], parts["geometry"], count))
    counts = [r["count"] for r in st["runs"]] + [count]
    low, low_run = min((c, k + 1) for k, c in enumerate(counts))
    streak = 0
    for k in range(len(counts) - 1, 0, -1):
        if counts[k] < min(counts[:k]):
            break
        streak += 1
    if count == 0:
        print("stop rule: count 0, nothing is open")
    elif n == 1:
        print("stop rule: baseline count %d" % count)
    elif streak == 0:
        print("stop rule: new low %d (was %d)" % (count, min(counts[:-1])))
    elif streak < STOP_AFTER:
        print("stop rule: no new low for %d batch%s (lowest %d at run %d)" % (streak, "es" if streak > 1 else "", low, low_run))
    else:
        print("stop rule: STOP - the count set no new low for %d batches (runs %d-%d; lowest %d at run %d): stop editing and "
              "hand back the open list with what blocks each item, usually placement" % (streak, n - streak + 1, n, low, low_run))
    st["runs"].append(dict(run=n, date=drc.get("date"), source=drc.get("source"), count=count))
    st["findings"] = now
    json.dump(st, open(sys.argv[3], "w"), indent=1)


if __name__ == "__main__":
    main()
