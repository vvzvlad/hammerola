---
name: hammerola
description: Design a 3D-printable part in CadQuery and publish it to a hammerola hub, which builds it from code. Use for any part heading for a printer (bracket, mount, holder, cover, enclosure, jig), in a directory with a model.py or a hammerola project.json, and for failed builds and comments on a build. Triggers include "спроектируй кронштейн", "сделай крышку", "деталь не лезет", "3D print this", "publish the model", "hammerola".
version: 36
---

# hammerola

The hub builds CAD models from code: you push a source tree, it runs `model.py`
in its own image, gates the geometry and serves a viewer with STL/STEP/3MF
downloads on a permanent URL. You drive it with `hammerola` and need no CAD
kernel.

A note in brackets is a case from another project. It shows why a rule
exists; nothing in it is a fact or a decision about the part in front of you.

## What to read, and when

This file is the whole of what you must not get wrong by default. Everything
else sits beside it and is read at the moment it applies — the files are in
`references/` next to this one, and each is opened with `Read`, not guessed at:

| Moment | File |
|---|---|
| Before any geometry: what he said, what it touches, where the numbers come from, comments and proposals on a build | `references/brief.md` |
| Writing or fixing `checks()`; a build that is slow or killed | `references/checks.md` |
| Writing `model.py`: the contract, the record types, CadQuery's traps | `references/model-py.md` |
| Putting a dimension on the drawing: shrinkage, minimum walls, orientation, fasteners | `references/printing.md` |
| A file published beside the model: document, drawing, PDF, picture, report, or any file to hand over (DXF, STEP, CSV) | `references/documents.md` |
| A KiCad schematic, a board, its 3D model, Gerbers, a part's datasheet | `references/boards.md` |
| Starting a project, fetching a revision back, removing one, setting up a machine | `references/cli.md` |

## Talking to the person

**A direct question gets a one-line answer in the same turn**, from what you
know now. Searching comes after, never instead.

**A question to the person ends your turn.** Whatever depends on the answer —
geometry, a brief, a check, a default to use meanwhile — waits for it. A
question followed by work on an assumed answer has not asked anything.

**A picture is a request to measure.** Before replying, name what is in it and
one number you took off it; never answer it with agreement. The picture is
already on disk, in the session transcript — extract it yourself, in the same
turn (`references/brief.md`), and never ask the person to save it.

**Shown the same place twice, the first answer was wrong at the address.** Name
the coordinate as a number and remove the feature; do not explain again.

**No report on a failed attempt.** Until the part is right, one line: what is
broken in the part, and how much longer. No list of attempts, no self-analysis,
zero words of apology.

## Before there is any geometry

Nearly all the wasted time in the reviewed sessions was decided here, before
the first solid existed. The whole of it is in `references/brief.md`; these
five lose the session on their own.

**A word is not a specification.** "Bracket", "mount", "holder" each name five
different objects. Say back what the object is as a shape, what it touches and
what holds it, what passes through it from end to end — water, air, silicone, a
trigger over its full stroke and back — and how it is made past the printer,
and end the turn there: the say-back is a question. Once he has answered,
commit a **block preview**: the whole layout in boxes and cylinders, as a
catalogue and an `assembled` view. It closes this phase, is not optional, and
is the project's first revision. ("Semicircular bracket" went into geometry
36 seconds after it was read, and 3 h 48 min of work was thrown away.)

**A constraint that is not a body does not exist.** Bought hardware, the wall,
the hand, the hose, the panel behind — all are modelled, though none is
printed, each as its own catalogue record: `hardware` for what is bought and
goes into the product, `mock` for scenery, and neither may stand on the plate
(the record types are in `references/model-py.md`). (Trigger ergonomics took
five hours while no hand existed as a body, and one iteration once it did.)

**Fastening is what he named, driven by what he drives it with.** Hardware the
owner fits himself and did not ask you to model is not added, pocketed or
studied for access. Where a fastener IS in the model, ask once which tool he
actually turns it with, and end the turn on that question — never derive the
tool from a standard table.

**Ask whether the assembly is already sold before designing it.** A make-or-buy
line with a price and a link comes before the first geometry. (Four hours went
into a siphon of four elbows; the ready-made one costs 309 ₽.)

**Every number has a provenance.** A constant claiming to be measured cites a
line in `ref/measurements.md` through `checklib.measured(...)`, one derived from
a number you name is `checklib.derived(...)`, and an unmeasured one is DECLARED
with `checklib.estimated(v, "what would settle it")` — it builds and drives
geometry like any other. A module-level float with none of the three around it
is refused. The word "measured" in a comment with no line behind it is a lie.

**A size the person names for the space is a ceiling, not a target.** The part's
size comes from what must fit inside it, and the space enters one statement
only: needed ≤ available. (A dimension went 170 → 139 → 112 → 100 → 88 → 78 →
48.5 mm over eight rounds.)

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
shown is a commit**, the block preview included. **Hand over the commit's URL
every time**, not once at the end, or the person waits or prints something
superseded.

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
`.env`, `.venv`) are dropped, not refused, and so is what an open KiCad keeps
beside a design: any file starting with `~` (its `~*.lck` locks), `_autosave-*`
and any directory named `*-backups`. At most 8 components deep and
1024 files; there is no size limit, but the upload has to arrive within 300 s
(`408` otherwise).

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

## What publishes green and is wrong

Each of these builds, passes and is published with nothing red. None announces
itself; the file beside each names the rest.

* **A `printable` made of parts added to each other** — `plate.add(bosses)` is
  a compound: the STL has the plate and no bosses. One fused solid
  (`references/model-py.md`).
* **A helper nobody called.** `checklib` measures nothing by itself: a model
  that never calls `unsupported_area` publishes with a face hanging in the air
  (`references/model-py.md`).
* **A part modelled upside down.** The orientation is the one it is printed in,
  and `print_preview.png` is the only thing that shows it — look at it after
  every build that moved the part (`references/printing.md`).
* **A check that re-does the arithmetic of the constants** instead of measuring
  the bodies: green whatever the geometry did (`references/checks.md`).
* **A `checks()` that meshes or exports.** It breaks the numbers it then
  measures, and the build is killed for time (`references/checks.md`).
* **The tool's own timeout.** `hammerola build` run under a timeout shorter than
  the build publishes the build and loses the log (`references/checks.md`).
* **A number with no provenance**, or an `estimated` quoted back afterwards as
  a measurement (`references/brief.md`).

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
* `422` on the push — rule 1, by a path; no build ran.

**When what is wrong is your own `checks()`, `--force` publishes anyway.** It
skips `checks()` and nothing else: every gate of the hub still refuses. The log
says `checks: not run`, and the metrics record the count as unknown, not zero.
Use it for a check that is wrong, slow or asserting a known falsehood — never
to get past a right one.
