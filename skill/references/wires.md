# Wires and cables in the model

Read when the model shows a wire, a lead, a cable or a harness: speaker leads
from a terminal block to a driver, a jumper between two connectors, an antenna
cable, a pair twisted by hand.

**A wire is a smooth curve, not a pipe.** A polyline of cylinders with a ball
at each corner reads as plumbing: sharp elbows, legs at right angles, the wire
hovering in the middle of the cavity. (A speaker's wiring was built that way —
a cylinder per leg, a sphere per corner — and looked like copper tubing.)
`wire()` below is what CAD routing tools do as well: a straight lead out of
each held end along its terminal's axis, a spline through a few waypoints
between them, a circle swept along the path. It is not in `checklib`; paste it
into `model.py`.

```python
def wire(points, d, start_dir, end_dir, dirs=None, lead=None):
    """A flexible wire, insulation diameter d (mm), as one solid.

    points: the conductor's end in the first holder, the waypoints, its end
    in the last holder. start_dir points OUT of the first holder, end_dir
    INTO the last -- each along the axis of the terminal, tab, plug boot or
    hole that holds that end. dirs: {index in points: direction} for a
    waypoint the wire must pass in a given direction; the others are free.
    The wire runs straight for `lead` mm out of each end, then on a smooth
    spline through the waypoints."""
    lead = 3.0 * d if lead is None else lead
    p = [cq.Vector(*q) for q in points]
    t0 = cq.Vector(*start_dir).normalized()
    t1 = cq.Vector(*end_dir).normalized()
    a, b = p[0] + t0 * lead, p[-1] - t1 * lead
    dirs = dirs or {}
    tangents = [t0, *(cq.Vector(*dirs[i]).normalized() if i in dirs else None
                      for i in range(1, len(p) - 1)), t1]
    spline = cq.Edge.makeSpline([a, *p[1:-1], b], tangents=tangents)
    # The sweep self-intersects where the bend radius drops under d / 2, and
    # isValid() still says True; R >= d keeps a margin.
    k = max(spline.curvatures([i / 200 for i in range(201)]))
    assert k * d <= 1.0, (f"wire bends at R{1.0 / k:.2f} mm, tighter than its "
                          f"{d} mm diameter: move the waypoints apart, or "
                          f"start_dir points into its holder")
    path = cq.Wire.assembleEdges(
        [cq.Edge.makeLine(p[0], a), spline, cq.Edge.makeLine(b, p[-1])])
    return cq.Solid.sweep(cq.Wire.makeCircle(d / 2.0, p[0], t0), [], path)
```

**Waypoints go where something holds or turns the wire, and nowhere else.**
A clip, a cable tie, a hole in a wall, an edge it wraps round, the two ends of
a stretch that lies on a surface: one point each. A wire across a box has two
to four waypoints, not ten — every extra point is a wiggle.

**A spline swings past its points.** Free waypoints on a floor let the wire
dip into it between them: give each the floor's direction in `dirs`, the
point `d / 2` off the surface — `wire(pts, 1.6, (1, 0, 0), (1, 0, 0),
dirs={1: (1, 0, 0), 2: (1, 0, 0)})`. (Two waypoints on a floor, the ends
coming in at 10 mm: 3.4 mm into the floor free, 0.0 with `dirs`.) Square
through a hole: one waypoint at its centre, the hole's axis in `dirs`.

**The ends sit inside what holds them.** The first and last points are where
the conductor ends in the screw terminal, the solder cup or on the tab.
`start_dir` points out of the first holder — out of a terminal's mouth, out
of a plug's boot against the mating direction, along a solder tab away from
it — and `end_dir` into the last one. The `assembled` gate then sees the wire
inside its holder: declare each such pair, `"interference_ok":
[("wire_tweeter_p", "terminal_j2", "wire clamped in the terminal")]`. A
bought driver is `hardware`, so the wire on its tab is a declared pair the
same way. A wire through a printed wall, a bought part or another wire is
refused by the same gate with nothing for you to write; a `mock` (a wall, the
board the case closes over) it never asks, so clearance to one is yours in
`checks()`.

**One wire, one record.** `kind: "hardware"`, the insulation's colour under
`"color"` (red for plus, black for minus), the gauge in the note. A harness
that branches is a `cq.Compound.makeCompound([...])` of its wires, never a
`fuse()` (fusing a wire's pieces in one call once dropped its last leg without
an error). A twisted pair or a tied bundle is one `wire()` of the bundle's
outer diameter, with each lead its own `wire()` from where it leaves the
bundle. The length to cut, for the note or a cut list: `shape.Volume() /
(math.pi * (d / 2) ** 2)` — exact for a swept circle.

**A swept wire is heavy**: a 120 mm one is about 63 000 triangles in
`assembled.stl`, the same route in cylinders and balls 3 700. A dozen wires
are fine; a harness of dozens is drawn as its bundles, one `wire()` each, not
conductor by conductor.
