"""KiCad's interactive router (PCBWorld-Engine's kicad_rl_router) behind a line protocol: one JSON request per stdin line, one JSON response per stdout line.
usage: python3 pns_bridge.py   (inside the pns.Dockerfile image; pns_mcp.py starts it with docker create -i and docker start -ai; a request is {"tool": name, "args": {...}}, a response is that tool's result or {"error": message}, and the bridge keeps running after an error)
needs: python3 with kicad_rl_router on PYTHONPATH (the image sets it)"""
import itertools
import json
import math
import os
import shutil
import sys

import kicad_rl_router as krl

MODES = {"mark": krl.MODE_MARK_OBSTACLES, "push": krl.MODE_SHOVE, "walk": krl.MODE_WALKAROUND}
SEVERITY = {0x10: "warning", 0x20: "error", 0x40: "ignore"}
TUNE_MODES = {"single": 0, "pair": 1, "skew": 2}
TUNE_STATUS = {0: "too short", 1: "too long", 2: "tuned"}   # MEANDER_PLACER_BASE::TUNING_STATUS
ALL_COPPER = -2   # RL_LAYER_SPANS_COPPER: a through pad or anchor
WORK = "/work"   # the container's directory the bridge's user owns
DIRS = itertools.count(1)


def mm(v):
    # KiCad's internal unit is 1 nm: six decimals of a mm keep a coordinate exact, so a point copied
    # from a reply lands on the copper it came from.
    return round(v, 6)


class Board:
    """One loaded board and the router session on it."""

    def __init__(self, path):
        # the board, its project and rules are copied into a directory this user owns: the
        # engine writes its project lock beside the project
        self.dir = os.path.join(WORK, "run%d" % next(DIRS))
        os.mkdir(self.dir)
        stem = os.path.splitext(os.path.basename(path))[0]
        for ext in (".kicad_pcb", ".kicad_pro", ".kicad_dru"):
            src = os.path.join(os.path.dirname(path), stem + ext)
            if os.path.exists(src):
                shutil.copyfile(src, os.path.join(self.dir, stem + ext))
        self.stem = stem
        self.r = krl.RLRouter(os.path.join(self.dir, stem + ".kicad_pcb"))
        dru = os.path.join(self.dir, stem + ".kicad_dru")
        self.rules = dru if os.path.exists(dru) else ""
        # as in pcbnew, routing keeps the custom rules as well as the net classes
        if self.rules:
            self.r.set_routing_rules(self.rules)
        n = self.r.get_copper_layer_count()
        ids = [0] + [4 + 2 * i for i in range(n - 2)] + [2]
        names = ["F.Cu"] + ["In%d.Cu" % (i + 1) for i in range(n - 2)] + ["B.Cu"]
        self.layer_id = dict(zip(names, ids))
        self.layer_name = dict(zip(ids, names))
        self.layer_name[ALL_COPPER] = "*.Cu"
        self.before = None   # copper at the start of the open route
        self.start_at = None   # where the open route goes on from
        self.fixed = []        # where it went on from before each fixed step, for undo_segment
        self.pair = None       # {net code: name} of an open diff pair route, P first
        # engine checkpoint handles are 64-bit, more than a JSON number keeps in a JavaScript
        # client: the tools hand out small ids instead
        self.checkpoints = []

    # -- lookups ------------------------------------------------------------------------------

    def mode(self, name):
        if name not in MODES:
            raise ValueError("mode is push, walk or mark, not %r" % name)
        self.r.set_routing_mode(MODES[name])

    def layer(self, name):
        if name not in self.layer_id:
            raise ValueError("unknown copper layer %r; the board has %s" % (name, ", ".join(self.layer_id)))
        return self.layer_id[name]

    def net_name(self, code):
        for item in self.r.get_pads() + self.r.get_tracks():
            if item.net_code == code:
                return item.net_name
        return str(code)

    def net_code(self, name):
        for p in self.r.get_pads():
            if p.net_name == name:
                return p.net_code
        for t in self.r.get_tracks():
            if t.net_name == name:
                return t.net_code
        raise ValueError("no net %r on the board" % name)

    def copper(self):
        """uuid -> item for every track and via, the state a commit is measured against."""
        items = {}
        for t in self.r.get_tracks():
            items[t.uuid] = ("track", mm(t.x1_mm), mm(t.y1_mm), mm(t.x2_mm), mm(t.y2_mm),
                             self.layer_name.get(t.layer, t.layer), mm(t.width_mm), t.net_name)
        for v in self.r.get_vias():
            items[v.uuid] = ("via", mm(v.x_mm), mm(v.y_mm), mm(v.diameter_mm), mm(v.drill_mm), v.net_name)
        return items

    def diff(self, before):
        """What a commit wrote: new items in full, removed and reshaped ones counted per net."""
        after = self.copper()
        added = [after[u] for u in after if u not in before]
        removed = [before[u] for u in before if u not in after]
        changed = [after[u] for u in after if u in before and after[u] != before[u]]
        tracks = [list(i[1:]) for i in added if i[0] == "track"]
        vias = [list(i[1:]) for i in added if i[0] == "via"]
        nets = sorted({i[-1] for i in added + removed + changed})
        return {"tracks": tracks, "vias": vias, "removed": len(removed), "changed": len(changed),
                "nets": nets, "unrouted": self.r.get_unrouted_count()}

    def head(self):
        x, y, layer = self.r.get_route_head()
        if self.pair:
            # the pair's head is the cursor even where the pair did not follow it: the middle of
            # the two lines' ends is where the pair is
            x, y = self.pair_mid(self.pair_ends()) or self.start_at
        return [mm(x), mm(y)], self.layer_name.get(int(layer), int(layer))

    def pair_ends(self):
        """{net code: (x, y)}: the far end of each line of the open pair's head."""
        ends = {}
        for t in self.r.get_wip_segments():
            if (t.x1_mm, t.y1_mm) != (t.x2_mm, t.y2_mm):
                ends[t.net_code] = (t.x2_mm, t.y2_mm)
        return ends

    @staticmethod
    def pair_mid(ends):
        if len(ends) == 2:
            (ax, ay), (bx, by) = ends.values()
            return (ax + bx) / 2, (ay + by) / 2
        return None

    def pair_added(self, before):
        """The pair's tracks the board gained since `before`, each with its net."""
        return [t for t in self.diff(before)["tracks"] if t[-1] in self.pair.values()]

    def on_net_copper(self, x, y, layer, code):
        """True when (x, y) lies on a pad, track or via of net `code` on board layer `layer`, or on
        any copper layer when `layer` is None. Zones do not count: the engine shows keepouts only."""
        on = lambda item_layer: layer is None or item_layer in (layer, ALL_COPPER)
        for p in self.r.get_pads():
            if p.net_code == code and on(p.layer) \
                    and abs(p.x_mm - x) <= p.width_mm / 2 and abs(p.y_mm - y) <= p.height_mm / 2:
                return True
        for t in self.r.get_tracks():
            if t.net_code == code and on(t.layer) \
                    and seg_dist(x, y, t.x1_mm, t.y1_mm, t.x2_mm, t.y2_mm) <= t.width_mm / 2:
                return True
        return any(v.net_code == code and math.hypot(v.x_mm - x, v.y_mm - y) <= v.diameter_mm / 2
                   for v in self.r.get_vias())

    def track_list(self, tracks):
        return [[mm(t.x1_mm), mm(t.y1_mm), mm(t.x2_mm), mm(t.y2_mm),
                 self.layer_name.get(t.layer, t.layer), mm(t.width_mm)] for t in tracks]

    def need_route(self):
        if not self.r.is_routing():
            raise RuntimeError("no route is open; start_route first")

    def end_route(self, out):
        """Fills in the session state after a step: the head, or the commit when the route ended."""
        if self.r.is_routing():
            out["head"], out["layer"] = self.head()
        else:
            out["committed"] = self.diff(self.before)
        out["routing"] = self.r.is_routing()
        return out


def seg_dist(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - x1 - t * dx, py - y1 - t * dy)


def seg_in_box(x1, y1, x2, y2, bx1, by1, bx2, by2):
    """Liang-Barsky: does the segment touch the box?"""
    t0, t1, dx, dy = 0.0, 1.0, x2 - x1, y2 - y1
    for p, q in ((-dx, x1 - bx1), (dx, bx2 - x1), (-dy, y1 - by1), (dy, by2 - y1)):
        if p == 0:
            if q < 0:
                return False
        else:
            t = q / p
            if p < 0:
                t0 = max(t0, t)
            else:
                t1 = min(t1, t)
            if t0 > t1:
                return False
    return True


B = None


def board():
    if B is None:
        raise RuntimeError("no board is open; open_board first")
    return B


def class_sizes(cls, default):
    """A net class's sizes; -1 is a value the class leaves to Default."""
    pick = lambda own, base: mm(own if own >= 0 else base)
    return {"name": cls.name or default.name,
            "track_width": pick(cls.track_width_mm, default.track_width_mm),
            "clearance": pick(cls.clearance_mm, default.clearance_mm),
            "via_diameter": pick(cls.via_diameter_mm, default.via_diameter_mm),
            "via_drill": pick(cls.via_drill_mm, default.via_drill_mm)}


def open_board(path):
    global B
    # one router at a time: the old one goes before the new one is made
    B = None
    B = Board(path)
    r = B.r
    rules = r.get_design_rules()
    default = rules.default_netclass
    bb = r.get_board_bbox()
    return {
        "board": B.stem,
        "bbox": [mm(bb.x_mm), mm(bb.y_mm), mm(bb.x_mm + bb.width_mm), mm(bb.y_mm + bb.height_mm)],
        "copper_layers": list(B.layer_id),
        "rules": {
            "min_clearance": mm(rules.min_clearance_mm), "min_track_width": mm(rules.min_track_width_mm),
            "min_via_diameter": mm(rules.min_via_diameter_mm), "min_via_drill": mm(rules.min_through_hole_mm),
            "min_hole_to_hole": mm(rules.min_hole_to_hole_mm),
            "copper_edge_clearance": mm(rules.copper_edge_clearance_mm),
            "netclasses": [class_sizes(c, default) for c in [default] + list(rules.netclasses)],
            "custom_rules_file": bool(B.rules),
        },
        "nets": r.get_board_net_count(),
        "unrouted": r.get_unrouted_count(),
    }


def get_net(name):
    b = board()
    r = b.r
    code = b.net_code(name)
    edges = [e for e in r.get_ratsnest() if e.net_code == code]
    return {
        "net": name,
        "class": class_sizes(r.get_netclass_for_net(code), r.get_design_rules().default_netclass),
        "pads": [{"ref": p.footprint_ref, "pad": p.pad_name, "xy": [mm(p.x_mm), mm(p.y_mm)],
                  "layer": b.layer_name.get(p.layer, p.layer), "size": [mm(p.width_mm), mm(p.height_mm)]}
                 for p in r.get_pads() if p.net_code == code],
        "tracks": b.track_list(t for t in r.get_tracks() if t.net_code == code),
        "vias": [[mm(v.x_mm), mm(v.y_mm), mm(v.diameter_mm), mm(v.drill_mm)]
                 for v in r.get_vias() if v.net_code == code],
        "unrouted": [[mm(e.x1_mm), mm(e.y1_mm), b.layer_name.get(e.layer1, e.layer1),
                      mm(e.x2_mm), mm(e.y2_mm), b.layer_name.get(e.layer2, e.layer2)] for e in edges],
    }


def query_area(x1, y1, x2, y2, layer=None):
    b = board()
    r = b.r
    bx1, bx2, by1, by2 = min(x1, x2), max(x1, x2), min(y1, y2), max(y1, y2)
    lid = None if layer is None else b.layer(layer)
    on = lambda item_layer: lid is None or item_layer in (lid, ALL_COPPER)
    pads = [{"ref": p.footprint_ref, "pad": p.pad_name, "net": p.net_name, "xy": [mm(p.x_mm), mm(p.y_mm)],
             "layer": b.layer_name.get(p.layer, p.layer), "size": [mm(p.width_mm), mm(p.height_mm)]}
            for p in r.get_pads() if on(p.layer)
            and p.x_mm + p.width_mm / 2 >= bx1 and p.x_mm - p.width_mm / 2 <= bx2
            and p.y_mm + p.height_mm / 2 >= by1 and p.y_mm - p.height_mm / 2 <= by2]
    tracks = [t for t in r.get_tracks() if on(t.layer)
              and seg_in_box(t.x1_mm, t.y1_mm, t.x2_mm, t.y2_mm, bx1, by1, bx2, by2)]
    vias = [[mm(v.x_mm), mm(v.y_mm), mm(v.diameter_mm), v.net_name] for v in r.get_vias()
            if bx1 - v.diameter_mm / 2 <= v.x_mm <= bx2 + v.diameter_mm / 2
            and by1 - v.diameter_mm / 2 <= v.y_mm <= by2 + v.diameter_mm / 2]
    keepouts = []
    for z in r.get_keepouts():
        xs, ys = [p[0] for p in z.pts], [p[1] for p in z.pts]
        if on(z.layer) and xs and min(xs) <= bx2 and max(xs) >= bx1 and min(ys) <= by2 and max(ys) >= by1:
            keepouts.append({"name": z.name, "layer": b.layer_name.get(z.layer, z.layer),
                             "tracks": z.keepout_tracks, "vias": z.keepout_vias, "pads": z.keepout_pads,
                             "outline": [[mm(x), mm(y)] for x, y in z.pts]})
    return {"pads": pads,
            "tracks": [row + [t.net_name] for row, t in zip(b.track_list(tracks), tracks)],
            "vias": vias, "keepouts": keepouts}


def start_route(net, x, y, layer, pair=False):
    b = board()
    r = b.r
    if r.is_routing():
        raise RuntimeError("a route is open; finish or cancel_route it first")
    code = b.net_code(net)
    b.before = b.copper()
    if not r.start_route(x, y, b.layer(layer), diff_pair=pair):
        return {"started": False, "reason": r.get_failure_reason() or "no anchor at that point on that layer"}
    codes = r.get_current_net_codes()
    if code not in codes:
        r.cancel_route()
        return {"started": False, "reason": "the copper at (%s, %s) on %s is not on net %s" % (x, y, layer, net)}
    b.start_at, b.fixed = r.get_route_head()[:2], []
    b.pair = {c: b.net_name(c) for c in codes} if pair else None
    width, via, drill, clearance = r.get_route_sizes()
    tx, ty, tl = r.get_routing_target()
    out = {"started": True, "net": net,
           "sizes": {"track_width": mm(width), "via_diameter": mm(via), "via_drill": mm(drill),
                     "clearance": mm(clearance)},
           "target": None if int(tl) == -1 else [mm(tx), mm(ty), b.layer_name.get(int(tl), int(tl))]}
    if pair:
        width, gap, via_gap = r.get_diff_pair_sizes()
        out["pair"] = list(b.pair.values())
        out["sizes"].update(track_width=mm(width), gap=mm(gap), via_gap=mm(via_gap))
    return b.end_route(out)


def line_to(points, mode, via_at_end=False, end=False):
    """Moves the head to each point in turn and fixes it there, as a click does in KiCad. A point
    the head cannot reach ends the call; the route stays at the last fixed point. A point where
    the head already is is skipped. A last point on copper of the routed net ends the route there
    and commits it: on the route's layer for a line, on any copper layer for a via_at_end, which
    commits with its via. With end, the last point commits the route whatever is under it, as
    KiCad's End key does."""
    b = board()
    r = b.r
    b.need_route()
    b.mode(mode)
    if b.pair:
        return b.end_route({"steps": pair_steps(b, points, via_at_end, end)})
    width, via_d, _, _ = r.get_route_sizes()
    code = r.get_current_net_code()
    steps = []
    for i, (x, y) in enumerate(points):
        last = i == len(points) - 1
        via = last and via_at_end
        if via:
            r.set_via_placement(True)
        r.move(x, y)
        head_at = r.get_route_head()[:2]
        hx, hy = mm(head_at[0]), mm(head_at[1])
        # PNS's own notion of arrival: the copper of the placed item covers the point
        if math.hypot(hx - x, hy - y) > (via_d if via else width) / 2:
            if via:
                r.set_via_placement(False)
            steps.append({"to": [x, y], "reached": False, "head": [hx, hy],
                          "reason": r.get_failure_reason() or "blocked"})
            break
        line = [s for s in b.track_list(r.get_wip_segments()) if s[:2] != s[2:4]]
        layer = r.get_current_layer()
        # a via joins every copper layer, so it ends the route on the net's copper of any of them;
        # end ends it anywhere, as for a via into a zone, which the router does not see
        on_net = last and b.on_net_copper(x, y, None if via else layer, code)
        if on_net or last and end:
            # as a click on the net's copper does in KiCad, the line commits with its via;
            # require_via keeps a head the via did not fit on from committing as a bare line
            if r.fix_route(x, y, force_finish=True, require_via=via):
                step = {"to": [x, y], "reached": True, "fixed": line, "ended_on_net": on_net}
                steps.append(dict(step, via=True) if via else step)
                break
            if not r.is_routing():
                steps.append({"to": [x, y], "reached": True, "fixed": False,
                              "reason": "the via does not fit here; the engine dropped the open route"})
                return {"steps": steps, "routing": False}
            if via:
                r.set_via_placement(False)
            steps.append({"to": [x, y], "reached": True, "fixed": False,
                          "reason": r.get_failure_reason() or "the router refused to commit here"})
            break
        # a head already at the point is a line of no length (or none): fixing it adds no stage
        # to KiCad's fixed tail, and with a via it parks one in a node the next move drops
        if not line:
            if via:
                r.set_via_placement(False)
                steps.append({"to": [x, y], "reached": True, "fixed": False,
                              "reason": "a via needs a line ending at it, and the head is already here"})
                break
            steps.append({"to": [x, y], "reached": True, "fixed": False, "skipped": "the head is already there"})
            continue
        r.fix_route(x, y, force_finish=False)
        # a fixed waypoint clears the head; a refused one (a collision) leaves it
        if r.get_wip_segments():
            if via:
                r.set_via_placement(False)
            steps.append({"to": [x, y], "reached": True, "fixed": False,
                          "reason": r.get_failure_reason() or "collision"})
            break
        b.fixed.append(b.start_at)
        b.start_at = head_at
        step = {"to": [x, y], "reached": True, "fixed": line}
        if via:
            # KiCad's layer pair F.Cu/B.Cu: the other side, or F.Cu from an inner layer. The
            # router changes layer only after a line that ended in a via.
            target = 2 if layer == 0 else 0
            step["via"] = bool(r.switch_layer(target))
        steps.append(step)
    return b.end_route({"steps": steps})


def pair_steps(b, points, via_at_end, end):
    """line_to for a diff pair. KiCad's DIFF_PAIR_PLACER writes each step it fixes to the board at
    once, keeps showing that step as its head after the fix, and keeps its last head when a move
    does not fit: a step is read off the board, and a move off whether the head changed."""
    r = b.r
    width, gap, _ = r.get_diff_pair_sizes()
    steps = []
    for i, (x, y) in enumerate(points):
        last = i == len(points) - 1
        via = last and via_at_end
        if math.hypot(x - b.start_at[0], y - b.start_at[1]) < 1e-4:
            if via:
                steps.append({"to": [x, y], "reached": True, "fixed": False,
                              "reason": "a via needs a line ending at it, and the head is already here"})
                break
            steps.append({"to": [x, y], "reached": True, "fixed": False, "skipped": "the head is already there"})
            continue
        if via:
            r.set_via_placement(True)
        was = b.pair_ends()
        r.move(x, y)
        ends = b.pair_ends()
        layer = r.get_current_layer()
        on_net = last and any(b.on_net_copper(x, y, None if via else layer, c) for c in b.pair)
        # as the cursor on a pad in KiCad: the placer fits the pair onto that pad, via or track end
        # and its partner's, and both lines end on their nets' copper
        snapped = on_net and not via and len(ends) == 2 and all(
            b.on_net_copper(ex, ey, layer, c) for c, (ex, ey) in ends.items())
        mid = b.pair_mid(ends)
        # a head the move left as it was did not fit, and after a fix it lies on the copper it
        # wrote; otherwise the point is the pair's centre line, reached when it lies between the
        # two lines' ends
        if ends == was or not mid or not snapped and math.hypot(mid[0] - x, mid[1] - y) > (width + gap) / 2:
            if via:
                r.set_via_placement(False)
            reason = r.get_failure_reason() or ("the pair did not fit onto this copper and its partner's"
                                                if on_net else "the pair does not fit to this point")
            steps.append({"to": [x, y], "reached": False, "head": b.head()[0], "reason": reason})
            break
        copper = b.copper()
        # a via onto the pair's copper or the End key commits the pair where it is; a pair fitted
        # onto its target finishes by itself
        ending = via and on_net or last and end
        done = r.fix_route(x, y, force_finish=ending, require_via=via)
        if not r.is_routing():
            if not done:
                steps.append({"to": [x, y], "reached": True, "fixed": False,
                              "reason": "the vias do not fit here; the engine dropped the open route"})
                break
            step = {"to": [x, y], "reached": True, "fixed": b.pair_added(copper),
                    "ended_on_net": snapped or on_net}
            steps.append(dict(step, via=True) if via else step)
            break
        fixed = b.pair_added(copper)
        if not fixed:
            if via:
                r.set_via_placement(False)
            steps.append({"to": [x, y], "reached": True, "fixed": False,
                          "reason": r.get_failure_reason() or "collision"})
            break
        # the next step goes on from this point, as KiCad's placer from its cursor
        b.start_at = [x, y]
        step = {"to": [x, y], "reached": True, "fixed": fixed}
        if via:
            step["via"] = bool(r.switch_layer(2 if layer == 0 else 0))
        steps.append(step)
    return steps


def finish(mode):
    b = board()
    r = b.r
    b.need_route()
    b.mode(mode)
    if r.finish():
        return b.end_route({"finished": True})
    # ROUTER::Finish moves the head to the nearest unconnected anchor and fixes the route only
    # when the head got there on a layer the anchor is on: it never changes layer
    (hx, hy), layer = b.head()
    lid, code = r.get_current_layer(), r.get_current_net_code()
    other = [name for name, l in b.layer_id.items() if l != lid and b.on_net_copper(hx, hy, l, code)]
    if other and not b.on_net_copper(hx, hy, lid, code):
        reason = ("the head reached copper of its net at (%s, %s) on %s, but the route is on %s and finish "
                  "does not change layer: a via does (line_to with via_at_end)" % (hx, hy, ", ".join(other), layer))
    else:
        reason = r.get_failure_reason() or "the router did not get the head to the nearest unconnected anchor and fix it there"
    return b.end_route({"finished": False, "reason": reason})


def cancel_route():
    b = board()
    b.need_route()
    b.r.cancel_route()
    out = {"cancelled": True, "routing": False}
    if b.pair:
        # the steps KiCad's diff pair placer fixed are on the board and stay there
        out["kept"] = b.diff(b.before)
    return out


def undo_segment():
    """Takes back the last fixed step of the open route; the head goes back to where it began."""
    b = board()
    r = b.r
    b.need_route()
    if b.pair:
        return b.end_route({"undone": False, "reason": "KiCad's diff pair placer writes each fixed step to the "
                            "board and cannot take one back (DIFF_PAIR_PLACER has no UnfixRoute); after "
                            "cancel_route, delete the step's tracks"})
    if not b.fixed:
        return b.end_route({"undone": False, "reason": "nothing is fixed since start_route"})
    # KiCad's UnfixRoute answers with the first point of the head, and a fix has just cleared
    # the head: it reports nothing even when it took a step back, so the steps are counted here
    r.undo_last_segment()
    b.start_at = b.fixed.pop()
    # a step that ended in a via comes back with via placement on
    r.set_via_placement(False)
    r.move(*b.start_at)
    return b.end_route({"undone": True})


def delete(x, y, kind, layer=None):
    b = board()
    r = b.r
    if r.is_routing():
        raise RuntimeError("a route is open; finish or cancel_route it first")
    lid = None if layer is None else b.layer(layer)
    if kind == "track":
        hits = [(seg_dist(x, y, t.x1_mm, t.y1_mm, t.x2_mm, t.y2_mm), t) for t in r.get_tracks()
                if lid is None or t.layer == lid]
        hits = [h for h in hits if h[0] <= h[1].width_mm / 2]
        if not hits:
            raise ValueError("no track at (%s, %s)" % (x, y))
        t = min(hits, key=lambda h: h[0])[1]
        ok = r.delete_track_near(t.x1_mm, t.y1_mm, t.x2_mm, t.y2_mm, t.layer, t.net_code, 0.001)
        item = b.track_list([t])[0] + [t.net_name]
    elif kind == "via":
        hits = [(math.hypot(v.x_mm - x, v.y_mm - y), v) for v in r.get_vias()]
        hits = [h for h in hits if h[0] <= h[1].diameter_mm / 2]
        if not hits:
            raise ValueError("no via at (%s, %s)" % (x, y))
        v = min(hits, key=lambda h: h[0])[1]
        ok = r.delete_via_near(v.x_mm, v.y_mm, v.net_code, 0.001)
        item = [mm(v.x_mm), mm(v.y_mm), mm(v.diameter_mm), v.net_name]
    else:
        raise ValueError("kind is track or via")
    return {"deleted": item if ok else None, "unrouted": r.get_unrouted_count()}


def delete_net_routing(net):
    b = board()
    if b.r.is_routing():
        raise RuntimeError("a route is open; finish or cancel_route it first")
    n = b.r.delete_routing_of_nets([b.net_code(net)])
    return {"deleted": n, "unrouted": b.r.get_unrouted_count()}


def drag(x, y, to_x, to_y):
    """Drags the track or via at (x, y) to (to_x, to_y) in push mode."""
    b = board()
    r = b.r
    if r.is_routing():
        raise RuntimeError("a route is open; finish or cancel_route it first")
    hits = [(seg_dist(x, y, t.x1_mm, t.y1_mm, t.x2_mm, t.y2_mm) - t.width_mm / 2, t.layer)
            for t in r.get_tracks()]
    hits += [(math.hypot(v.x_mm - x, v.y_mm - y) - v.diameter_mm / 2, 0) for v in r.get_vias()]
    hits = [h for h in hits if h[0] <= 0]
    if not hits:
        raise ValueError("no track or via at (%s, %s)" % (x, y))
    before = b.copper()
    b.mode("push")
    if not r.start_drag(x, y, min(hits)[1]):
        return {"dragged": False, "reason": r.get_failure_reason() or "the router would not pick it up"}
    r.move(to_x, to_y)
    # a first drag step whose shove fails drops KiCad's dragger into mark-obstacles mode, and a
    # forced commit would write that state with its collisions
    if not r.fix_drag(force_commit=False):
        r.cancel_drag()
        return {"dragged": False, "reason": r.get_failure_reason() or "the router refused the move"}
    return {"dragged": True, "committed": b.diff(before)}


def tune(x, y, layer, length, mode):
    """Tunes the routed line through (x, y) with KiCad's meander placer and commits the result."""
    b = board()
    r = b.r
    if r.is_routing():
        raise RuntimeError("a route is open; finish or cancel_route it first")
    if mode not in TUNE_MODES:
        raise ValueError("mode is single, pair or skew, not %r" % mode)
    before = b.copper()
    got = r.tune(x, y, b.layer(layer), length, TUNE_MODES[mode])
    if not got.committed:
        return {"committed": False, "reason": got.reason}
    key = "skew" if mode == "skew" else "length"
    return {"status": TUNE_STATUS[got.status], key: mm(got.result_mm), "before": mm(got.before_mm),
            "target": length, "committed": b.diff(before)}


def drc():
    b = board()
    found = b.r.run_drc(b.rules)
    out = []
    for v in found:
        out.append({"type": v.error_key, "severity": SEVERITY.get(v.severity, v.severity),
                    "xy": [mm(v.x_mm), mm(v.y_mm)], "layer": b.layer_name.get(v.layer, v.layer),
                    "nets": list(v.net_names), "items": [d for d in (v.item_a_desc, v.item_b_desc) if d],
                    "message": v.message})
    counts = {}
    for v in out:
        key = "%s %s" % (v["severity"], v["type"])
        counts[key] = counts.get(key, 0) + 1
    return {"count": len(out), "by_type": counts, "violations": out}


def checkpoint():
    b = board()
    # the engine re-opens a checkpointed route only at its start anchor: checkpoints are taken
    # between routes, and restore never re-opens one
    if b.r.is_routing():
        raise RuntimeError("a route is open; finish or cancel_route it first")
    b.checkpoints.append(b.r.checkpoint())
    return {"id": len(b.checkpoints)}


def restore(id):
    b = board()
    # the engine's restore drops an open route first
    if not 1 <= id <= len(b.checkpoints) or not b.r.restore(b.checkpoints[id - 1]):
        raise ValueError("no checkpoint %s" % id)
    return {"restored": id, "unrouted": b.r.get_unrouted_count(), "routing": False}


def save():
    """Writes the board as <stem>.kicad_pcb with its .kicad_pro into a new directory; returns their paths."""
    b = board()
    out = os.path.join(WORK, "out%d" % next(DIRS))
    os.mkdir(out)
    pcb = os.path.join(out, b.stem + ".kicad_pcb")
    b.r.save(pcb)
    return {"files": [pcb, os.path.join(out, b.stem + ".kicad_pro")], "routing": b.r.is_routing()}


TOOLS = {f.__name__: f for f in (open_board, get_net, query_area, start_route, line_to, finish, cancel_route,
                                  undo_segment, delete, delete_net_routing, drag, tune, drc, checkpoint, restore,
                                  save)}


def main():
    # KiCad's own writes to stdout would break the protocol: the protocol keeps a private copy of
    # the stdout descriptor, and descriptor 1 goes to stderr
    proto = os.fdopen(os.dup(1), "w", buffering=1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            req = json.loads(line)
            fn = TOOLS.get(req.get("tool"))
            if fn is None:
                raise ValueError("unknown tool %r" % req.get("tool"))
            reply = fn(**req.get("args", {}))
        except Exception as e:
            reply = {"error": "%s: %s" % (type(e).__name__, e)}
        proto.write(json.dumps(reply) + "\n")


if __name__ == "__main__":
    main()
