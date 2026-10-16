---
name: hammerola
description: Design a 3D-printable part in CadQuery and publish it to a hammerola hub, which builds it from code. Use for any part heading for a printer (bracket, mount, holder, cover, enclosure, jig), in a directory with a model.py or a hammerola project.json, and for failed builds and comments on a build. Triggers include "спроектируй кронштейн", "сделай крышку", "деталь не лезет", "3D print this", "publish the model", "hammerola".
version: 22
---

# hammerola

The hub builds CAD models from code: you push a source tree, it runs `model.py`
in its own image, gates the geometry and serves a viewer with STL/STEP/3MF
downloads on a permanent URL. You drive it with `hammerola` and need no CAD
kernel. The modelling discipline comes first and the command reference after
it, because a compacted conversation gets back only the start of this file.

A note in brackets is a case from another project. It shows why a rule
exists; nothing in it is a fact or a decision about the part in front of you.

## Talking to the person

**A direct question gets a one-line answer in the same turn**, from what you
know now. Searching comes after, never instead.

**A question to the person ends your turn.** Whatever depends on the answer —
geometry, a brief, a check, a default to use meanwhile — waits for it. A
question followed by work on an assumed answer has not asked anything.

**A picture is a request to measure.** Before replying, name what is in it and
one number you took off it; never answer it with agreement.

**Shown the same place twice, the first answer was wrong at the address.** Name
the coordinate as a number and remove the feature; do not explain again.

**No report on a failed attempt.** Until the part is right, one line: what is
broken in the part, and how much longer. No list of attempts, no self-analysis,
zero words of apology.

## Before there is any geometry

Nearly all the wasted time in the reviewed sessions was decided here, before
the first solid existed.

**A word is not a specification.** "Bracket", "mount", "holder" each name five
different objects. Say back what the object is as a shape, what it touches and
what holds it, what passes through it from end to end — water, air, silicone, a
trigger over its full stroke and back — and how it is made past the printer,
and end the turn there: the say-back is a question. Once he has answered,
commit a **block preview**: the whole layout in boxes and
cylinders, as a catalogue and an `assembled` view. It closes this phase, is not
optional, and is the project's first revision. The part goes in as a
`printable` box of its overall size, its surroundings beside it as `mock` and
`hardware`. The template's `checks()` then reddens in its last section, which
walks `parts()` and so lands on YOUR box:
`bracket.stl is 684 bytes, which is not a printable mesh`.
Rewrite `checks()` to what is known (envelope ≤ space available) or delete it;
gutting it fails. ("Semicircular bracket" went into geometry 36 seconds after
it was read, and 3 h 48 min of work was thrown away.)

**Fastening is what he named, driven by what he drives it with.** Hardware the
owner fits himself on site and did not ask you to model — a magnet, a latch, a
screw through a hole he drills by hand — is not added, pocketed or studied for
access: it is one line in `ref/`. (Six magnet pockets and a frame went onto a
booth door whose owner was fitting latches himself.) Where a fastener IS in the
model, ask once which tool he actually turns it with, and end the turn on that
question: no access or clearance study and no tool assumed meanwhile — a
screwdriver has no elbow, a hex key does — and never derive the tool from a
standard table. (Four review rounds computed the sweep of a hex key, down to the
long series of ISO 2936, for a screw its owner drives with a screwdriver.)

**A constraint that is not a body does not exist.** Bought hardware, the wall,
the hand, the hose, the panel behind — all are modelled, though none is
printed, each as its own catalogue record: `hardware` for what is bought and
goes into the product, `mock` for scenery. The gates read which: hardware is
asked whether it shares space with anything, a mock is not, and neither may
stand on the plate. (Trigger ergonomics took five hours while no hand existed
as a body, and one iteration once it did.)

**An operation nobody named does not exist.** The part is what comes off the
printer. Tapping, reaming, drilling out, gluing, a heat-set insert, bending,
sanding to fit — each exists only once a person has named and agreed to it, and
a model that works only after an unnamed one does not work. An agreed step is
written down like hardware, with the tool's designation, in `ref/`; the geometry
stays what comes off the bed. Printed threads are printed.

**Ask whether the assembly is already sold before designing it.** A make-or-buy
line with a price and a link comes before the first geometry. (Four hours went
into a siphon of four elbows; the ready-made one costs 309 ₽.) Search your own
past projects first: grep the transcripts under `~/.claude/projects/`, and the
`cwd` in a matching file names the directory.

**Hardware is named, not described.** Every fastener and bought item carries a
designation naming exactly one product — `M6×30 DIN 912 A2`, `Ø8×60 nylon
anchor with a 5×50 screw`, or a shop's article number. The mock is built from
it and `checks()` measures against it.

**Stock cut to length is answered with a cut list, never a length.** Rod, tube,
extrusion, strip and cable come in sticks, and the requirement is *packed* into
them, not summed: four 357.6 mm studs and a 405.7 mm shaft are 1836 mm, yet do
not come out of two 1000 mm sticks. **The allowance goes on the member that can
absorb the others' error, and the cut list names it.** In a chain closed by
adjustable joints, the member with an end running into *air* — screwed further
in, poking out past its nut — is the compensator: cut long by a stated amount,
and cut **last**, off the assembly. The rest are cut to nominal; surplus
anywhere else is absorbed by nothing, and a chain with no compensator is a
design defect. So tolerances are **directional per member (`+2/−0`, `+0/−0.5`,
`+free`), never `±`**.

**Superseded hardware stays visible.** It stays in `ref/hardware/` as the record
of what was tried, with `SUPERSEDED <date> -> <what replaced it>` at the top of
its file. The current designation lives in exactly one place — the constant
`model.py` builds the mock from and `checks()` measures against — and `ref/`
and every message quote it rather than repeat it. (One kept in three files
drifted in the two a buyer reads.)

**A picture the person sent is already on disk**, base64 in the session
transcript. Extract it yourself, in the same turn, into `ref/`, named for what
it shows, with a line in `ref/README.md` on what is visible and what constraint
follows; never ask the person to save it. The transcript is under
`~/.claude/projects/`, in a directory named for the working directory with
every non-alphanumeric character replaced by `-`. Your session id is not in
your context: take the newest `*.jsonl` by mtime, and if nothing matches, list
the directory and find the one holding your work. One JSON object per line, up
to 100 MB, so read it a line at a time. Images sit in `user` records **and** in
the `attachment.prompt` of `type: "attachment"` records (what was pasted while
you worked), which `message.content` alone misses. A name taken from
`media_type` keeps the `+` of `image/svg+xml` and refuses the push by rule 1.

**Every number has a provenance, and `ref/measurements.md` is the log of raw
measurements**: date, what was measured, with what, the number. A constant that
CLAIMS to be measured cites a line in it —
`checklib.measured(v, "ref/measurements.md#screw")` — and the build refuses the
push when the file or the heading is missing. One derived from a number you
name is `checklib.derived(...)`. An unmeasured one is DECLARED with
`checklib.estimated(v, "what would settle it")`: it builds, drives geometry like
any other number, and is right for most fits before anything is printed — the
starter template's `LIP_CLEARANCE`, `BOSS_RELIEF` and `BOARD_CLEARANCE` all are.
Each estimate prints an `estimate:` line in the build log and goes into
`metrics.json` with its note, and it is never quoted back as a measurement. What
is refused is a module-level float with none of the three around it. The word
"measured" in a comment with no line behind it is a lie. (A clearance commented
`# measured fit on the printer` was never measured: two ruined prints.)

**A justification is an assertion, and is checked like one.** "Measured", "in
practice", "standard" with no number, line or source behind them are worse than
no comment: they stop the next reader from looking. In a review the costliest
defect sits in the edit written FOR the previous round — a smooth general phrase
where the real measurement was in the file. A figure off one build is a property
of that run: write the number and where it came from, or that you do not know.

**A number the person hands you is their claim, not your measurement.** A
caliper, a datasheet or a guess make it `measured`, `derived` or `estimated`;
which, ask them in the same turn, before it reaches geometry. Answered, a
measurement goes into `ref/measurements.md` with the person and the date as its
source. Unanswered, it is an estimate — never a `measured` assumed for them.

**`ref/` is published with every build**, so its names obey rule 1 — a
designation goes inside the file, never into its name
(`ref/hardware/m6x30-din912-a2.md`) — and every file in it counts against the
push limits each time.

**A size the person names for the space is a ceiling, not a target.** "About",
"could be smaller", "maximum" mark one; quote the words next to the number. The
part's size comes from what must fit inside it, and the space enters one
statement only: needed ≤ available. (A dimension went 170 → 139 → 112 → 100 →
88 → 78 → 48.5 mm over eight rounds.)

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
`checks()` to git first: `hammerola source <gauge>` brings back the gauge's.
The person names a step, the number goes into the part, the next commit is the
product, and the gauge's revision stays as the record of what won.

**Fasteners are checked for tool access, as a body** of the tool he named: a
cylinder from the head along the axis, that tool's length, swept through the
assembly. A fastener with no such check is a hole, not a fastener.

**Every body in the assembly names what holds it along +Z, along −Z and in
rotation.** "It rests on that" is one direction; a part held only downwards is
held by gravity.

## While the work is running

**Edit the geometry yourself.** A number, a clearance, a primitive's position —
above all an edit following a review — is your own `Edit`, not a brief for a
subagent.

**A brief is a goal, absolute paths to what was found, and a criterion for
done.** Finding the source data is the lead's job; a subagent builds from it.

**A round of edits that moves no physical number is not started.** First write
one line: which quantity changes — envelope, volume, clearance, fit — and by
how much.

**The part is done when its numbers stop moving.** The log's `metrics vs dev:`
block saying `every measured number is the same (N part numbers compared)` is
the signal; twice in a row, the rounds have left the part for the instrument.
Say it can be printed, and stop.

## The working cycle

```sh
hammerola build            # -> the dev slot: YOUR eyes; the next push overwrites it
hammerola commit -m "..."  # -> an immutable revision; `latest` moves to it
```

**`build` is what YOU look at, `commit` is what the PERSON looks at** — split by
audience, not by how finished the part is. Never hand over a `dev` URL, not
even as "have a look meanwhile": the next push replaces it. `dev` keeps no
history, source or log, and a `dev`-only project is not on the front page.

**Push after every change that moves a number.** Nothing rations `build`, and
with no kernel here an unpushed model is one nobody has looked at. A brief that
forbids pushing blinds you.

`commit` makes a version exist: the hub names the revision by the sources'
digest (not git), keeps code and log, moves `latest`, and the project gets its
card. A session ending on a `build` published nothing. **Everything a person is
shown is a commit**, the block preview (above) included. **Hand over the
commit's URL every time**, not once at the end, or the person waits or prints
something superseded.

`-m` (`--message`) is `commit`'s alone (`build -m` is exit 2) and is what a
person picks a revision by. A `git commit` line is suggested afterwards;
nothing is staged.

Both verbs print the build log and **exit non-zero unless a build was
published**: that is "did not ship", not a warning.

**`-C DIR` (`--directory`) goes BEFORE the verb** —
`hammerola -C ../bracket commit -m "..."` — and is exit 2 after it; the verb
then runs as if started in that directory.

## Four rules that break a push

**1. File names.** Every path component must match
`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`: ASCII, a letter or digit first, so no
spaces, Cyrillic, `×`, `Ø` or leading underscore. One bad name refuses the
**whole push** — `детали.py` beside `model.py` stops the project publishing.
The alphabet is a security boundary, not relaxed. Hidden entries (`.git`,
`.env`, `.venv`) are dropped, not refused. At most 8 components deep,
1024 files and 64 MiB unpacked ("67 MB" to the client; a deployment's own
limit is in its 413).

**2. No `checklib.py` at a model's root.** The model's directory is first on
`sys.path`, so your copy shadows the image's: interference volumes go into one
copy and the build reads the other. Nothing goes red — the build warns,
publishes, and `metrics.json` lacks them. Likewise any file shadowing a module
the build imports.

**3. Nothing is installed for a model.** The image has `cadquery`, `trimesh`,
`numpy`, `matplotlib`, `Pillow` and the standard library; a `requirements.txt`
is read by nothing, since installing runs code inside the build. Put what you
need in project files the model imports.

**4. `model.py` runs on the hub** under CPU, wall-clock and memory ceilings: no
network, no environment, no subprocesses. Past a ceiling it is killed and
reported as a timeout.

## When a build fails

The log `build` and `commit` print is the whole account. **Read it from the
top**: the gate refuses in a fixed order, so the first complaint is the real
one.

```sh
hammerola log            # the newest revision's log
hammerola log <revision> # that one
hammerola log dev        # the last build's, committed or not
hammerola status         # latest, whether dev is occupied, the revisions (-n/--limit)
```

**Never rebuild to read a log you already have**: `log dev` serves it, its
header naming the push, and jobs are kept forever. A `dev` build's SOURCE is
not kept: `hammerola source dev` refuses.

* `build failed: ...` — your model or a gate said no; what it names is in `model.py`.
* a traceback — `model.py` raised; the bottom frame is yours.
* `timeout` / `cpu_exhausted` — past a ceiling; usually a boolean out of hand.
* `413` / `422` on the push — rule 1, by size or by a path; no build ran.

**When what is wrong is your own `checks()`, `--force` publishes anyway.** It
skips `checks()` and nothing else: every gate of the hub still refuses. The log
says `checks: not run`, and the metrics record the count as unknown, not zero.
Use it for a check that is wrong, slow or asserting a known falsehood — never
to get past a right one.

## What the printer does to your numbers

This was measured on ONE machine (calipers on PETG, 0.4 nozzle), not on your
part, so a constant carrying one of these corrections is
`checklib.derived(value, note)` naming it, never `measured`.

| Feature | Comes out | Measured on |
|---|---|---|
| Hole | **0.22 mm under** nominal | Ø5.00 bore printed 4.78 |
| Straight wall | **0.18 mm under** nominal | a 4.60 D-flat printed 4.42 |
| Outside diameter | **0.20 mm under** nominal | Ø8.00 journal printed 7.80 |

Holes and shafts alike come out smaller. A **hole** gains interference for free:
a Ø22 seat at zero nominal clearance pressed onto a 608 bearing exactly right —
the shrinkage IS the press fit, so it is not corrected. A **shaft** loses it:
the Ø8 journal printed 7.80 against an 8.05 bore and needed Ø8.35 nominal to
land at 8.15. So `nominal = what you want measured + the loss above`, and **do
not carry over "holes shrink, shafts grow"**: here it gets the shaft backwards.

Bias each correction toward the error cheaper to rescue: a fat shaft is
sandpaper, a binding round hole takes a drill, but **a flat wall cannot be
rescued** — leave it the loosest. That is rescuing a bad print, not designing
for one: an unnamed operation still does not exist.

**The minimums for a 0.4 nozzle are checked by nothing.** One that matters on
THIS part is an `assert` in `checks()`.

| Property | Minimum | Comfortable |
|---|---|---|
| Wall thickness | 1.2 mm | 2.0 mm |
| Layer height | 0.08 mm | 0.2 mm |
| Hole clearance | 0.2 mm | 0.3 mm |
| Press-fit interference | 0.1 mm | 0.15 mm |
| Feature size | 0.4 mm (the nozzle) | 0.8 mm |
| Fillet radius on the bottom | 0.5 mm | 1.0 mm |
| Unsupported bridge | — | under 20 mm |
| Overhang | — | under 45° from vertical |

TPU wants ~0.5 mm clearances, PETG takes +0.1 mm on a fit, ABS shrinks
0.5–0.7 % so critical dimensions scale up. For a fit that must work on the
FIRST print, use the measured offsets above instead.

**The orientation you model is the one it prints in**, Z up, as `checklib`
assumes: `print` may only move a part and turn it about Z. A part modelled
upside down publishes green, and only the render shows it. Design around
overhangs rather than supports, keep a flat face down, chamfer the bottom edges
rather than filleting them (a bed-edge fillet needs support), and write the
orientation next to the geometry.

**Fasteners: M3, unless the part is tiny or bought hardware dictates
otherwise.** M2 threads in printed PETG strip almost at once.

| | |
|---|---|
| Clearance hole | 3.4 |
| Self-tapping pilot, PETG/PLA | 2.5 |
| Socket cap head, DIN 912 | Ø5.5 × 3.0 |
| Countersunk, cross-recessed, DIN 965 | head Ø**5.6** max, cone depth **1.65** |
| Countersunk, hex socket, ISO 10642 / DIN 7991 | head Ø**6.0** nominal (5.81 max), cone depth **1.70** |

**Never type a countersink depth — derive it.** The cone is 90°, so
`depth = (head diameter − clearance diameter) / 2`, a `checklib.derived(...)`
of the two constants. Cut deeper and the head lands on the mouth's sharp lip
and wedges the plate apart.

**Name the standard, and WHICH diameter.** DIN 965 M3 is Ø5.6 and ISO 10642 is
Ø6.0, so a socket head in a DIN 965 pocket stands ~0.2 mm proud — not cosmetic
on a face that must seat flat. DIN and its ISO "equivalent" differ (at M4, Ø7.5
against Ø8.4), and one screw has three published head diameters — ISO 10642 M3:
6.72 theoretical, 6.0 nominal, 5.81 dk max — of which only the last two are
metal. `ref/hardware/` names the standard AND which one a number is.
fasteners.eu serves the DIN 7991 table under an address saying ISO 10642.

## CadQuery, where it bites

**Hollow with a boolean, not with `.shell()`**, which fails on tapered bodies,
lofts, unions of primitives and anything carrying many fillets:

```python
outer = (cq.Workplane("XY")
         .box(WIDTH, DEPTH, HEIGHT, centered=(True, True, False))
         .edges("|Z").fillet(CORNER_R))
inner = (cq.Workplane("XY")
         .workplane(offset=FLOOR_T)
         .box(WIDTH - 2 * WALL, DEPTH - 2 * WALL, HEIGHT,
              centered=(True, True, False))
         .edges("|Z").fillet(max(0.1, CORNER_R - WALL)))
body = outer.cut(inner)
```

`.shell()` only on a single simple primitive with one wall thickness all round.

**Fillet before you cut, largest radius first.** The same fillet that succeeds
on a clean primitive fails on edges left by holes, slots and pockets. Chamfers
too.

**Never wrap a fillet in a `try/except` that shrinks the radius until it
works.** A failing fillet says the radius or the geometry is wrong, and the
`except` publishes a radius nobody chose with a log saying the build passed.

**Overshoot a cut meant to pass just through a face by 0.01 mm.** Coplanar
faces make invalid, non-watertight bodies; the log shows it (`valid, volume …
cm3, watertight, one body`). Fix the boolean.

**`centered=(True, True, False)` on `.box()`** puts the bottom at Z = 0, so
`.faces("<Z")` is the bed.

**`.hole()` cuts through the whole part**; `.cboreHole()` and `.cskHole()` are
the counterbore and the countersink.

**A positive `taper` in `.extrude()` narrows the shape**, a negative one flares
it — silently, either way.

**`.loft()` is fragile.** For a profile and a scaled copy use
`.extrude(taper=…)`; keep loft for genuinely different profiles.

**A screw boss is pushed, drawn and extruded, then drilled**, so the hole is cut
in the boss rather than through the wall under it:

```python
.pushPoints(SEATS).circle(BOSS_OD / 2).extrude(BOSS_H)
.pushPoints(SEATS).hole(SCREW_D + FIT_CLEARANCE)
```

## The contract with model.py

The template `create` unpacks is the live example — read it rather than this
section. In short: `model.py` defines `parts()` and `views()`, may define
`checks()`, and may `import checklib`.

* **`parts()` — the catalogue, the one place geometry lives.** A non-empty dict
  of records, `{"lid": {"shape": <CadQuery object>, "kind": "printable"}}`, with
  `color` and `note` optional. Instead of `shape` a record may carry `mesh`, a
  `trimesh.Trimesh` the model loaded (`trimesh.load("ref/scan.stl",
  force="mesh")`) to show somebody else's geometry: it must be a `mock`, nothing
  is exported from it, and `at` is refused on it — place it with
  `mesh.apply_transform(...)`. **The key IS the part's identity**: its export
  stem, its row in the viewer's tree, what views point at, its entry in
  `meta.json`; there is no display name. Letters, digits, dot, dash and
  underscore, a letter or digit first, up to 128 characters; `assembled` and
  `print` are reserved. An unknown key in a record (a misspelt `colour`) is a
  warning, and the part is painted by its kind.
* **`kind` is required and has no default**: `printable` is exported with
  download buttons; `hardware` is bought and goes into the product (a screw, a
  bearing, a heat-set insert); `mock` is scenery (the wall, the board the case
  closes over). No `printable` is required: a catalogue of only `hardware` and
  `mock` publishes, with nothing to download. Colour follows the kind unless
  the record names one: a palette entry chosen by the KEY for a printable, dark
  grey for hardware, light grey for a mock.
* **`views()` — tabs of REFERENCES into the catalogue.** A list of
  `{"id", "name", "parts": [...]}`; `name` captions the picker and falls back to
  the id. **A view carries no geometry of its own.** Each entry of `parts` is:
  * `"lid"` — the catalogue part as it is;
  * `{"part": "pin", "at": cq.Location(...), "alpha": 0.6}` — placed by a rigid
    motion; `alpha` runs 0..1 and defaults to 1.0;
  * `{"part": "strap", "shape": bent, "deformed": "clamped round the pipe"}` —
    the one way geometry enters a view, for a part genuinely another shape in
    place. The reason is required and logged, and it is refused in `print`;
  * `{"group": "housing", "parts": [...]}` — groups nest and are presentation
    only: **no gate sees a group**. Its name obeys the key rule and may not be a
    catalogue key; nesting past 64 levels is refused.

  One part may be referenced any number of times — five pins, five references.
* **Two view ids carry the gates.** **`assembled` is required**: the product is
  judged by it, parts are counted from it alone, and **every `printable` key
  must be in it** (alpha 0 does not count). Nothing in it may overlap anything
  unless declared: `"interference_ok": [("nozzle", "seat", "threaded joint")]`,
  the reason required and logged. A `mock` is never asked; **`hardware` is** —
  a screw biting into its printed hole is a declared overlap.

  **`print` is optional and is the bed.** Printables only; `at` may move a part
  and turn it about Z and nothing else — a tilt re-orients it, a mirror makes
  another part. No two parts inside one another unless declared:
  `"nested_ok": [("shim", "ring")]`. Both lists name CATALOGUE KEYS and cover
  every instance of the pair; one reference cannot be exempted alone.
* **`"note"` on a record** — `{"shape": screw, "kind": "hardware", "note":
  "M3x8 DIN912"}` — is the AUTHOR's note, shown beside the part in the browser:
  what the geometry cannot say (catalogue name, datasheet, the fit taken, why a
  number is what it is). One line of **plain text**: nothing in it is parsed, a
  link is not clickable, and `<`, `>` and control characters are refused. At
  most 200 characters, at most 200 records a catalogue; an empty note is an
  error, so leave the key out. It is neither the viewer's own note nor a
  comment.
* **What a `printable` owes.** It becomes `<key>.stl`, `<key>.step` and
  `<key>.3mf`, and **it is one fused body**. The gate reads `.val()`, the first
  body on the stack, alone: only it is validated, measured, written to the STL
  and rendered. So `plate.add(bosses)` publishes green with the bosses missing
  from the STL and the preview while the 3MF and STEP have them, and
  `pushPoints(...).box(..., combine=False)` REPLACES the stack and loses the
  base. `assembled.stl` is glued from every body of the view, so its `N parts`
  in the log and the footer counts bodies, and more than the view holds means a
  printable not fused (a plate with three bosses added: `volume 9.60 cm3`,
  `4 parts`; replacing it: `0.22 cm3`, `3 parts`). Only disconnected pieces are
  refused (`N disconnected pieces, not one body`): fuse them, or give each its
  own record.
* **`checks()`** — optional, for what is specific to this part: fits,
  clearances, hardware, bed size (nobody's real machine until someone says
  which printer this is for). It fails by `assert cond, "why"` or by
  returning a list of problem strings. A `checks()` that provably holds no check
  fails the build.
* **`import checklib`** — reusable checks, none of which runs unless you call
  it. Assembly: `pairwise_interference`, `mating_face_flat`,
  `material_under_head`, `swept_clearance` (a moving part through a fixed one),
  `tool_access` (does a driver reach the screw and turn). Manufacture:
  `unsupported_area` (overhang at the print orientation), `thin_walls`,
  `minimum_feature` (the smallest thing the nozzle lays). Against a sample:
  `deviation` measures a scan of the real part against the model and returns
  coloured bands for `parts()` — blue where the scan is inside the model, green
  inside your band, red outside — with signed and absolute medians, the
  extremes and the fraction inside each threshold; it cleans up its own mesh,
  so the no-meshing rule below does not reach it. `material_at` is the fast
  point probe; `volume` and `is_empty` say whether a boolean left anything
  (`assert wp.vals()` cannot); `section` times a stretch of `checks()` in the
  log; `check` registers a unit the hub runs in a worker of its own (see
  «Keeping checks fast enough to run»). Each reads EVERY body of the part it is
  handed, `.add()` assemblies included. It lives in the hub's image; nothing to
  install or vendor.

That is all of `checklib`, and the gate is all of the hub: **nothing calls a
helper for you**, so a model that never calls `unsupported_area` publishes green
with a face hanging in the air. Provenance (above) is the one thing checked
strictly. Of the bed the gate reads the layout, not the printing: parts inside
one another by over 0.05 mm on all three axes, or a part re-oriented onto the
plate, refuse the build, and the air between parts, adhesion and the machine's
size are read by nothing but a picture.

**The `print` picture is the cheapest check, and the only one of the BED.** A
build renders an isometric PNG per printable, one of `assembled` and one of
`print`, and none of any other view (the `<stem>_card.png` beside the last two
is the front page's tile, not for you). Look at `print_preview.png` after every
build that moved a part or a view: a part face down, on edge or off the plate
shows there and nowhere else. No `print` view means no plate, and the log says
so. Each picture comes off its stem's own STL, with a footer:
`Bounding box: 60.0 x 20.0 x 6.0 mm`, the triangle count, and `watertight` — on
a plate or an assembly, `N parts`.

**`hammerola artifacts <build>`** brings every picture worth looking at into
`.hammerola/`, with each part's STL/STEP/3MF, `assembled.stl` and, given a
`print` view, `print.stl`. It takes `dev` and `latest` too, so it works straight
after a `build`. Never assemble a picture's URL by hand: the command asks the
build what it published.

**A size comes back three ways**: the footer, `metrics.json` and the log.
`curl <hub>/project/<pid>/dev/metrics.json` gives `bbox_mm` for every PRINTABLE
right after a `build`; hardware and mocks are measured nowhere. A hub behind a
password proxy refuses a bare `curl`; the log's per-part line gives the same
sizes. The log prints
`<part>: … cm3, …x…x… mm, first layer … mm2, overhang … mm2` per part, the
assembly's line, and, after an earlier `dev` build, a `metrics vs dev:` block of
what moved. So a `print()` is for what the build does NOT measure — a
clearance, the one gap this round is about. The log keeps the FIRST 1 MiB of
stdout and stderr merged: print short and early. `hammerola diff <old> <new>`
compares two *published* revisions and refuses `dev`.

## Keeping checks fast enough to run

**A build has five minutes of wall clock**, and past it the build is killed
mid-run: a timeout instead of an answer. What gets there is rarely geometry and
usually `checks()`, which grows with everything the part teaches you.

The kernel lives in the hub's image, so you cannot time this locally: calibrate
against the hub. After every `build` and `commit` that rebuilt something,
failed ones included, the client prints one line off the hub's clock:

```
built in 4m12s (queued 8s)
```

The first number is your build; the second, absent when there was no wait, is
time queued for a worker. **Past three minutes a warning follows**, naming this
section's fixes; it is not a refusal, and a slow build publishes. A push the hub
answers with `unchanged` rebuilt nothing and prints no line. Judge a fix by this
line against the build before it, not by guessing.

**Four clocks run over one push, and the one that stops you first is your
own.** The hub kills a build at 300 seconds of wall clock and runs four builds
at a time. The client waits out the queue and the build, and its own ceiling is
2700 seconds (`--timeout SECONDS` on `build` and `commit` moves it; nothing
moves the hub's). Act on the three-minute warning the first time. What you WILL
hit is the timeout of the tool you launched `hammerola build` with: a two-minute
shell call cuts the command off, the build goes on and publishes, and its log,
on that command's stdout, is lost. Run a slow push with that timeout raised past
the hub's ceiling, or in the background.

**When it is slow, mark `checks()` up with `checklib.section("...")`** and read
the table the hub prints, on a failed build too. Measure before cutting: in one
model 52% of a 495-second checks phase sat in ONE loop, while the check
suspected beforehand took 8.9 s against a predicted ~150.

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

**Profile with section marks or a sampling profiler, not `cProfile`**: the
kernel spends ~89% of its time in a thread pool a main-thread profiler cannot
see, so it reports a slow build as fast.

## Comments

```sh
hammerola comments                       # the open queue for this project
hammerola comments files <id>            # its photo and camera frame, into .hammerola/
hammerola comments resolve <id> -m "..." # close it, saying what was done
```

A comment is a note a **person** left on a build in the browser: a point on the
model, their camera angle, usually a photo of the printed part — the strongest
evidence you get. Read the queue when you start, do the work, resolve it with
`-m` (`--note`) saying what was done; an unresolved one gets done twice. It is
a request, not a literal instruction. Fetch the photo with `comments files`
(its route is behind the secret), and before the next push into that area turn
the comment into an assertion in `checks()`. `--all` adds the resolved, to read
before answering; `--since TIMESTAMP` (ISO-8601) cuts to what came after.

## Proposals

```sh
hammerola proposal     # the standing proposal on this project, if any
hammerola proposal rm  # remove it — asks for the project id, so ask the owner
```

A proposal is rough bodies a **person** drew over the model — the motor to
clear, the wall it bolts to, the layout wanted — reaching you as lines of
numbers: what, how big, where, and which of your parts they dragged how far. It
is a STATEMENT, not an edit or code to paste. One per project, never resolved:
read it at the start with the queue. `proposal rm` cannot be undone and prompts
for the id, which you cannot answer — deliberately: the decision is the
owner's. Ask; never remove one to tidy up.

## Starting a project

```sh
mkdir t13-ceiling-mount && cd t13-ceiling-mount
hammerola create --title "Ceiling mount for a T13 sensor (t13-ceiling-mount)"
```

In an empty directory `create` writes `project.json` (a fresh twelve-character
`id`) and unpacks the starter template, a `model.py` that builds as it stands;
it overwrites nothing. `--no-template` skips the template for a directory that
has a model, and needs no hub.

**The title is what it is and what for, then the directory's slug in
brackets**: a copied project forgets its title, and a mismatched slug shows it.
A title without one gets a `warning:`.

`create` also writes the slug as `project`, the name the hub publishes under,
taken from the directory — so **name the directory first**. One the hub cannot
publish (spaces, Cyrillic, a leading dot, over 200 characters) falls back to
the title's slug; with neither, the project publishes under its bare id.

**Commit `project.json`, and never edit its `id`**: every permanent URL is
built from it, so a new id is a new project orphaning the old.
`hammerola rename "..."` changes the title only. `project` has no command —
edit the line, and only later builds carry it.

## Fetching things back

```sh
hammerola source <revision>     # the code that produced it, into .hammerola/
hammerola artifacts <revision>  # its STL/STEP/3MF and pictures, into .hammerola/
hammerola diff <old> <new>      # what moved: geometry numbers, and the source
```

Artefacts are public; source is behind the secret. `.hammerola/` is hidden, so
the next push skips what you fetched. `-o DIR` (`--output`) lands it elsewhere,
and a visible directory in the project travels with the next push.
`source --into-working-copy` overwrites the working copy and needs a clean git
tree. `diff --json` prints a document for code; `--material` adds material
gained and lost per part, costing about a build; not both.

## Removing things

`hammerola rm` deletes a project from the hub, asks for its id to be typed, and
cannot be undone. One build cannot be removed: that would break a permanent URL.
Never run it to "clean up"; ask the owner.

## Set up, once per machine

`<hub>` is the address you were given. It has no default: never guess one, or
write one into a repository.

```sh
mkdir -p ~/.local/bin ~/.claude/skills/hammerola
curl -fsSL <hub>/start/skill.md -o ~/.claude/skills/hammerola/SKILL.md   # this file
curl -fsSL <hub>/start/hammerola -o ~/.local/bin/hammerola && chmod +x ~/.local/bin/hammerola
hammerola login <hub>
```

Behind a password proxy, add `-u <login>` to both `curl` lines (curl asks the
password); `hammerola login` notices the proxy and asks its login and password.

`hammerola skill` compares this file's version with the hub's;
`hammerola skill update` replaces it. A stale skill fails silently, teaching
commands that no longer exist — ask when you start on a project. Not at that
default path? Pass `--path FILE`, or both verbs act on a file nobody reads.
`hammerola update` replaces the client, which `build` and `commit` refuse when
older than the hub.

`login` asks for the password at the terminal and stores it 0600 in
`~/.config/hammerola/env`. **Ask the instance's owner for it.** One shared
secret publishes, reads any project's source and deletes any project: never put
it in a repository, a CI variable or a command line.

`hammerola` is one stdlib-only file: **python 3.9 or newer** (stock on macOS
and Debian 11). Not on PATH means `~/.local/bin` is not: run it by path.
