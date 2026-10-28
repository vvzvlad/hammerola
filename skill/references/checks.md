# checks(): what they measure, and what they cost

Read when writing or fixing `checks()`, and when a build is slow or killed for
time.

Contents: checks that actually check — what a check measures, the four traps of
the API, a printed moving pair · keeping checks fast enough to run — the
ceilings, how to measure what a check costs, the recipes that make one cheap.

## Checks that actually check

**Measure the solids, not the constants that drove them.** A check repeating
the arithmetic passes for the wrong reason and goes on passing after the
geometry drifts — the costliest habit in the reviewed sessions.
(`assert DOWEL_SEAT_CLEARANCE >= 0.3` passed two reviews; both end screws fell
out of the printed part.)

**An assert you cannot make go red is decorative.** Name the geometry that
reddens it and make it red once while writing it. Reading the code does not
catch this; breaking the solid on purpose does. (A 20 mm drill jig, where the
design says 48, passed the check whose whole subject was its length.)

**When a check goes red, the part or the check is wrong, and which is decided
out loud.** Nudging the model until the complaint stops greens the log, leaves
the part wrong and the check decorative. Name the physical quantity your edit
moved; "none, but it passes now" means you edited the instrument. (A nozzle in
the assembly was swapped for a stand-in turned down to its thread's root, and
the interference check went green.) A view cannot hide a second solid, so such
a swap can only happen in the catalogue record, where it becomes the part.
Declare the overlap with a reason, or fix the fit.

**Four traps in the CadQuery API make a check silently GREEN**; none raises.
Measured on cadquery 2.8.0:

* **`.vals()` is true whether or not a boolean left anything**: after
  `intersect` it holds one `Compound`, empty or not, so `assert wp.vals()` was
  `True` at volume `0.0`. Ask for the volume.
* **`BoundingBox()` on an empty solid raises** `Standard_Failure: Bnd_Box is
  void` — the only loud one, if you get that far.
* **A body a boolean emptied answers as its previous self.**
  `Workplane.intersect` calls `findSolid(searchParents=True)`, so a body of 8000
  emptied to 0.00 answered the next `intersect` with a 4×4×4 probe with
  **64.00 mm³**. A bare `Shape` raises `ValueError: Null TopoDS_Shape object`.
* **A point classifier on a body with no solids answers IN everywhere**, so an
  empty part greens every `assert solid(...)`. `checklib.material_at` refuses
  such a body; a check written before that guard may be passing on nothing.

One question finds all four, in a check, a review round or your own last edit:
what does it do on the input that should FAIL?

**Measure what the part exists for, not a proxy.** If what matters is how far a
lever protrudes, cut it against the housing and measure what is left, not the
variable you set the drop from. (Checked through `GRIP_DROP`, it stayed green
while the defect was plain in the picture.)

**Repeated features are weighed one by one, never by an extremum.** A `min` or
`max` stays green with one of four bosses missing. Count them and measure each.

**A number is quoted against what reproduces it.** An FDM machine lays 0.1–0.3
mm layers and a ~0.4 mm bead, and no print tells 0.003 mm from zero. A number
that small can matter, but then say what it is a property of — the CAD kernel,
the machine, a knob's step — and state the consequence in what the person sets.
(A 0.0034 mm "clearance" was really the ~30 µm at which a boolean stopped
cutting: one position of 91 on a knob stepping 0.5 mm.)

**A printed pair that has to move — a thread, a sliding fit, a snap, a hinge —
is never printed whole the first time.** First a gauge: a stub of the pair as a
ladder over the clearance, each step's number embossed, then the full part once
a human has printed it and said which step works.

**The gauge is a commit of its own and never part of the product.** A person
prints it, so its link must outlive the next push. It comes before the product:
the catalogue holds the one gauge, `assembled` shows it, `print` stands it on
the bed, and `latest` sits on it until the product is committed. The ladder is
one fused body (steps on a common base, digits unioned to it); count the steps
in `<gauge>_preview.png`. **Rewrite `checks()` for the gauge**, a check per step
measured on the solids — nothing makes you, because the product's `checks()`
calls its own builders and runs to the end about parts the build no longer has.
(The starter model cut down to one gauge with `checks()` left verbatim: green,
`checks: 12 passed`, every section but the last measuring a box and a lid that
were gone.) Gutting it fails the empty-checks gate, and deleting it throws away
every complaint ever turned into an assertion, so commit the product's
`checks()` to git first: the gauge's stays in its commit (`git show
<gauge>:model.py`).
The person names a step, the number goes into the part, the next commit is the
product, and the gauge's revision stays as the record of what won.

**Fasteners are checked for tool access, as a body** of the tool he named: a
cylinder from the head along the axis, that tool's length, swept through the
assembly. A fastener with no such check is a hole, not a fastener.

**Every body in the assembly names what holds it along +Z, along −Z and in
rotation.** "It rests on that" is one direction; a part held only downwards is
held by gravity.

## Keeping checks fast enough to run

**A build has five minutes of wall clock**, and past it the build is killed
mid-run: a timeout instead of an answer. What gets there is rarely geometry and
usually `checks()`, which grows with everything the part teaches you.

The kernel lives in the hub's image, so you cannot time this locally: calibrate
against the hub. After every `git push` and `hammerola build` that rebuilt
something, failed ones included, the hub prints one line off its clock, under
the build's log:

```
built in 4m12s (queued 8s)
```

The first number is your build; the second, absent when there was no wait, is
time queued for a worker. **Past three minutes a warning follows**, naming this
section's fixes; it is not a refusal, and a slow build publishes. A push the hub
answers with `unchanged` rebuilt nothing and prints no line. Judge a fix by this
line against the build before it, not by guessing.

**Three clocks run over one push, and the one that stops you first is your
own.** The hub kills a build at 300 seconds of wall clock and runs four builds
at a time; `git push` and `hammerola build` wait out the queue and the build,
with no ceiling of their own. Act on the three-minute warning the first time.
What you WILL hit is the timeout of the tool you launched the push with: a
two-minute shell call cuts the command off, the build goes on and publishes,
and its log, on that command's output, is lost. Run a slow push with that
timeout raised past the hub's ceiling, or in the background.

**When it is slow, mark `checks()` up with `checklib.section("...")`** and read
the table the hub prints, on a failed build too. Measure before cutting: in one
model 52% of a 495-second checks phase sat in ONE loop, while the check
suspected beforehand took 8.9 s against a predicted ~150. A row that dominates
is split before its cost is put down to anything: wrap each step inside its
loop in a section of its own. A label used again adds up over the iterations; a
section inside another counts its own time, and the outer row includes it.
(The time left in one wire clearance check was put down to building the wire
tubes, by the names of the functions; split, more than half of it was boxes
and faces rebuilt for every wire piece.)

**A distance the hub has measured before costs nothing.** Every
`shape.distance(other)` and `BRepExtrema_DistShapeShape` in a project's builds
is remembered by the exact geometry and placement of the two bodies, and a
repeat is answered from that memory. The log says how many, under the build:
`distance cache: 1060 of 1060 distances answered from the cache`. A build that
moved one part pays only for the distances that part is in; the first build
after a change to a body everything is measured against pays for all of them.
What stays slow when every distance was answered is the check's own work —
building the bodies it measures, boxes, booleans — and that is what the section
table points at. (One model's checks phase went from 80 s to 14 s with all
1060 distances answered.) Read a fast build as that, never as a check that
stopped running, and never thin a clearance check for speed before reading that
line.

**The cost of a boolean's shape is measured, not read about**: its sign flips
with the geometry. One `Common` against a compound of 13 bodies was five times
dearer than 13 separate cuts on one model, and three times cheaper on 13 plain
boxes. Put both forms behind section marks on your own geometry.

None of what follows is a reason to check less; each is the same check, written
to cost what it should.

**Ask about a point with `checklib.material_at`, never with a boolean.**
`body.intersect(small_cube)` costs milliseconds, the probe microseconds, and a
scan is hundreds of them.

```python
solid = checklib.material_at(body)          # once, not per point
for z in range(...):
    if not solid(x, y, z):
        problems.append(f"the wall is hollow at z={z}")
```

A cube answers about a *neighbourhood*, the probe about the *point*; they agree
away from surfaces, not within the cube's reach. Put each point where material
is *required* — half a millimetre inside the wall, not on it. A probe is bound
to its shape: take a fresh one after a transform or a rebuild.

**A scan step is a price you set.** Halving it doubles the run, and a scan
nested in a sweep of angles multiplies (nine such checks put 156 s on one
build). Pick the step from the smallest thing you are hunting; if you cannot
name that, the scan is not yet a check.

**A `while` walking a coordinate must provably reach its end.** One that does
not holds the build until the hub kills it, with a timeout naming nothing. Use a
`for` over a range computed up front; when it must be a `while`, bound it by a
count too, and fail loudly when the bound is what stopped it.

**Split `checks()` into units and the hub runs them side by side.** A check
marked `@checklib.check` is a UNIT: the hub queues it and drains the queue
across two worker processes. It still fails by `assert`, appears in the timings
table under its name, and is returned unchanged, so `checks()` can still call
it.

```python
@checklib.check("lip joint", needs={"body": build_body, "lid": build_lid})
def check_lip_joint(body, lid):
    assert lip_overlap(body, lid) > MIN_LIP, "lip joint too shallow"
```

`needs` maps the check's OWN parameter names to the builders producing them —
the `base = build_base()` a `checks()` opens with. It is not a selection out of
`parts()`, which would build every part. It is verified at the `@`, not at the
call, which happens in another process.

**A unit has its own budget: 120 seconds, enforced by killing the worker.** A
runaway costs one worker and two minutes, not the whole five-minute wall clock.
The verdict is a count: `check units: 4 passed`, or `check units: 3 of 4 passed`.
Section rows sum across workers, so the table's total can exceed the wall clock;
and a `@cache` is PER WORKER, so a part both workers need is built twice.

**Build each part once per `checks()`.** Builders are pure functions of the
constants and `checks()` calls them from a dozen places; one decorator is worth
about a fifth of the run:

```python
from functools import cache

@cache
def build_lid():
    ...
```

It is safe because CadQuery returns new objects; never cache a builder whose
result you mutate.

**What a check derives from a body is derived once, not once per pair.** A loop
of pieces against bodies recomputes whatever depends on one side only.
`BoundingBox()` is not a stored field: it computes an optimal box on every
call. Faces built from a mesh's triangles and numpy's min and max over a mesh
are the same. Put each under `@cache` or above the loop. A shape is a valid
`@cache` key while nothing moves it in place: its hash is its TShape and
location, so `move()` or `locate()` changes it while it sits in the cache. (One
wire clearance check rebuilt the boxes and the board faces for every wire
piece; computed once, the checks phase went from 132 s to 80 s, every printed
line unchanged.)

**Triangulating a shape leaves the mesh on it, and `BoundingBox()` then
measures the mesh**, which reads bigger: a cylinder r=5 h=10 read `zlen`
10.000000, then 10.003108 after `mesh(0.1)`, on its flat axis. How much, and on
which axis, depends on both tolerances and where the vertices landed, so take
no number off a mesh of your own. The direction holds: "does it fit the
printer" can go falsely red, a clearance reads tighter than it is, and an
inequality whose grown side is the weak one passes on that slack. The hub
drops the triangulation after each of its own exports; yours stay. A `@cache`d
builder hands the SAME object to every caller, so one caller's mesh moves what
the next measures; `.moved()` and `.located()` share the meshed TShape,
`translate()` does not. **So cache the builders, and do not mesh or export
inside `checks()`.**

**Do not pre-filter pairs before `checklib.pairwise_interference`.** It already
skips pairs whose bounding boxes cannot touch; your filter can only remove pairs
it was meant to see.

**`cProfile` names functions, not lines.** It does count the kernel's time:
while OCC's thread pool computes, the main thread waits inside the OCC call and
the wait lands on that call. Which line of `model.py` made the call, only
section marks say.
