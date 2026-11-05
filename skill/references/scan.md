# Rebuilding a part from a scan or an STL

Read when the person hands over a mesh of an existing part to rebuild as a
model: a 3D scan of a real part (a broken one to replace, one to fit against),
or an STL whose CAD source is lost (a download, an old export). The method is
CNC Kitchen's ScanRuler reverse-engineering guides, put into this hub's terms.

The mesh goes into the project as `ref/scan.stl` and is never edited. Numbers
are read off it with a script — trimesh, numpy and scipy, on your machine
(install them there if missing; the hub's image has them for `model.py`).
`mesh.section(plane_origin=..., plane_normal=...)` cuts it; least squares fits
a plane, a circle or a cylinder to the points of one face.

## First: a CAD export or a scan?

Decide before measuring anything, because the two are read in opposite ways.

| | CAD export | 3D scan |
|---|---|---|
| Vertices | on the true surface, to ~1e-5 mm | noisy samples near it |
| A flat face | long slivers, no vertex inside, plane residual ~1e-6 | thousands of small triangles, residual 0.01 mm and up |
| Round faces | rings that fit a circle with a round radius | rings that fit no circle exactly |
| Numbers | read exactly, then recognised as the design value | fitted, then snapped to a nominal within the tolerance |

A remeshed or decimated export reads like a scan: treat it as one and say why.

## A CAD export: read, don't fit

- **Group the faces** by the surface their vertices lie on: planes, cylinders,
  cones. The values come out exact; name the design value each one is (R3, a
  10.00 level, a 45° chamfer).
- **Find the frame.** Faces not square to the axes mean a part exported in its
  assembly position or tilted on a bed: work in the part's own frame and turn
  the result back as the last step.
- **Find the build axis**: the axis with most area in faces square to it and
  walls along it. A plate builds along its thickness, a bracket often along its
  extrusion axis, not Z. Mostly coaxial round faces and planes square to that
  axis is a turned part: one profile through the axis, revolved once.
- **Build in slabs**: every level square to the build axis is a step; between
  two levels the section is one exact profile — lines and arcs at their read
  centres and radii — extruded. Holes along other axes are cuts of their own,
  chamfers and rounds go on last, grouped by size. Each connected piece of the
  mesh is a body of its own.
- **Check by volume, not by eye**: the difference between model and mesh,
  extra and missing, as a share of the part's volume — about 1 % or less, and
  every cluster of difference over ~1 mm³ fixed or explained.
  `checklib.deviation` at a tolerance of 0.01 mm shows where.
- **Scaled after export** (a slicer's scale, inch to mm): 45° chamfers read as
  other angles in one direction, and heights are round only after dividing by
  one factor. Rebuild with the factor and report it with the design values.
- Say what it is: an exact geometric rebuild, not the designer's own feature
  tree.

## A scan: the method

**Measure from what the scan really shows, build the way the part's designer
did, and keep visible what is guessed.**

### 1. Check the scan before modelling

- **Noise floor σ**: fit a plane to the largest clean face; its residual is
  the scan's noise. Nothing finer than about 3σ can be trusted.
- **Tilt between faces the part has parallel** (two sides of a plate): over
  about 0.3° is the scan or its alignment, not the part. Say so before
  modelling, and ask for another scan if there is one. (A plate's scan was
  1.3° out; a whole session went into whether its faces were tapered.)
- **Open rims are missing data, not holes**: through or blind is inferred
  unless both ends are seen.
- **List at the start what the scan does not show** — the inside of pockets,
  deep channels, the far side of bosses — and say it once.

### 2. Classify, then set the tolerance T

The process, from what the surface shows: tool marks and sharp inside corners
are machined; draft, a parting line and even walls are moulded or die cast; a
rough skin and big fillets are cast or forged; layer lines are printed;
constant thickness with bends is sheet metal. Often two at once (a casting with
machined faces). Ask when unsure.

| Process | T, ± mm |
|---|---|
| Machined, ground | 0.02–0.05 |
| Injection moulded, die cast | 0.05–0.1 |
| Sand cast, forged, FDM printed | 0.3–0.5 |
| Worn, hand-finished, deformed | wider — say so |

**T = max(the process value, 3σ)**, plus about 0.1 % of the span on castings
and mouldings; machined faces of a casting are held to the machined T. T is
the `tolerance` of every `checklib.deviation` from here on, and it is said in
the report. In `model.py` it is `checklib.derived(...)` naming the process and
σ it came from.

On a moulded or cast part, **measure the draft early**: walls leaning 0.5–3°
explain faces that otherwise miss by the lean everywhere. Build the lean in
from the start.

### 3. The plan: regions, features, the target

- **Region inventory** before any geometry, from views of the scan from every
  side: each wall, tab, notch, lip, seat, rib, boss, slot, groove and parting
  line, small ones too, each with its function. (A mirror holder's three tabs,
  a notch in its bore and a lip were never on a list, so never built.)
- **Feature inventory with intent**: every hole, bore, pocket, boss and rib
  with its function and the nominal that function implies — clearance holes
  M4 → 4.5, M5 → 5.5, M6 → 6.6, M8 → 9; tap drill M6 → 5.0; catalogue bores 6,
  8, 10, 12, 15, 17, 20, 22, 25, 30; bosses 2–2.5 × the screw; ribs 0.5–0.7 of
  the wall; draft 0.5, 1, 1.5, 2, 3°; angles 15, 30, 45, 60°.
- **Snap to the nominal only when the measurement is within T of it**; record
  both, never snap across T. Positions too: a feature centred on what it
  belongs to and on its pitch, not where the scan put it.
- **How are such parts designed?** Name the part's class and write down how
  parts of that class are built — what the form grows from, which features
  share lines and planes. Build in that order: machined — stock, then every
  feature a cut; turned — one profile revolved, then off-axis features;
  moulded — outline on the parting plane, draft, shell, bosses, ribs; sheet
  metal — one skin at a gauge with its bends. (A pump housing built twice from
  the scan's shapes was withdrawn twice; the third, from how volutes are
  designed, stood.)
- **The target**: the share of the scan's surface within ±T —
  **90 %** on analytic parts (plates, turned, machined, sheet metal), **85 %**
  on castings and mouldings, **75 %** on freeform shells. He may set another.

### 4. Ask once, before the first feature

One message: the class, T, the target, the inventory, and these defaults —
then end the turn on it.

- One continuous body, even where the real part is two mouldings.
- Steps and warps under T are one surface.
- One round radius all the way round each edge loop.
- Functional markings modelled (polarity, arrows, scales); lettering and logos
  left off.
- Features on their design positions, not where the scan put them.
- Anything the scan cannot settle — through or blind, which face is the datum.

### 5. Datums

Align the scan by function: the face the part mates on, not the largest one.
A plate: its mounting plane, a line through two hole axes, a hole as origin. A
turned part: the longest clean cylinder as the axis, a shoulder as origin. A
symmetric part: find its mirror plane and report how far the scan is from
symmetric; symmetry is planned from the start, and the scan's asymmetry never
leaks into the model. A tilt that moves the far end by less than T is noise:
round it. `checklib.deviation` never moves the scan: apply the transform to
the mesh yourself.

### 6. Measure

- Fit each face whole, not a patch of it, and say which surface you mean (a
  bore's inside, a boss's outside).
- Cut every pocket and hole at several heights: a circle in one slice may be a
  rounded rectangle in the next.
- Read profiles from sections as lines and arcs, never as polylines; tangent
  where the scan is smooth.
- A face that looks flat is tried as a plane first; a doubly curved wall as a
  sphere or a torus before anything freeform.
- **Broken parts — read the break first.** A fracture is rough where its
  neighbours are smooth, has no draft or rounds where they have them, stops a
  wall mid-span, or leaves a feature with no twin across the part's symmetry.
  Rebuild the missing piece from its neighbours, mark it guessed, and ask when
  a "feature" sits at a break. (A bracket's broken-away end was read as a tooth
  and modelled; the person's notes undid it.)
- Threads on small holes: a striped wall, a fit with high σ. Size from the
  crest diameter: a crest of 5.1–5.2 rules out M5, so it is M6×1.

Every number goes into the model with its provenance (`SKILL.md`): a fitted
value is a line in `ref/measurements.md` — what was fitted, on which file, the
value, σ and the number of points — cited by `checklib.measured`.

### 7. The loop: deviation map → worst place

The deviation map drives the design from the first feature to the last; it is
not a report written at the end. After every group of features:

1. Build with the scan measured against the model, behind a cached builder
   (each check worker imports the model afresh), its bands in `parts()` and a
   `deviation` view listing them:

   ```python
   @cache
   def measured():
       scan = trimesh.load("ref/scan.stl", force="mesh")
       bands, report = checklib.deviation(scan, bracket(), tolerance=T,
                                          thresholds=(T, 2 * T, 3 * T))
       print(f"deviation: {report.within} within, median "
             f"{report.median_absolute:.3f} mm, {report.minimum:.2f}.."
             f"{report.maximum:.2f} mm")
       return bands, report
   ```

   The print lands in the build log. Read `report.within[T]` there against
   the target, and look at the deviation view.
2. Take the worst place — the largest red or blue area. Before changing
   anything, cut a section across it and read the scan against the model
   there: a band along every blend is one decision about blends, a field
   across a wall is the wall's form, a spot is a feature missing.
3. Fix the design there — the profile, the radius, the missing feature — not
   the symptom.
4. Build again. A place that has not moved after two tries: say so with its
   numbers and what you tried, and ask.

Done is the target met with every region built or named as left out — or his
sign-off on less after you said what is left. Short of that the reply says
**"not done"** with the open places, never "done with limitations". (A mirror
holder was measured once at the end and handed over at 62 % within T, its map
unseen. A fan reached 88.9 % with its blade roots removed and its blades
0.5 mm off, and was called done.)

### 8. The report

Only numbers from the last build — after the last change, never an earlier
run's. In the reply:

- class and T with its reason; σ of the scan; what the scan does not show;
- how it was modelled (the order from §3);
- every feature: function, measured value, nominal, and **M**, **P** or **I**:

  | Mark | Means | In `model.py` |
  |---|---|---|
  | M — measured | read off the scan within T | `checklib.measured`, a line in `ref/measurements.md` |
  | P — partly supported | snapped to a nominal, one end seen, a break rebuilt from its neighbours | `checklib.derived`, naming the measured line it came from |
  | I — inferred | no scan behind it: hidden inside, missing | `checklib.estimated`, with what would settle it |

- validation: share within ±T against the target, the signed and absolute
  medians, the extremes, and every place still over T with its cause — an
  error left, a documented omission, surface texture, or the real part's warp
  or asymmetry.
