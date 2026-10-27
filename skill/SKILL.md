---
name: hammerola
description: Design a 3D-printable part in CadQuery and publish it to a hammerola hub, which builds it from code. Use for any part heading for a printer (bracket, mount, holder, cover, enclosure, jig), in a directory with a model.py or a hammerola project.json, and for failed builds and comments on a build. Triggers include "спроектируй кронштейн", "сделай крышку", "деталь не лезет", "3D print this", "publish the model", "hammerola".
---

# hammerola

The hub builds CAD models from code: you push a git commit, it runs `model.py`
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
hammerola connect                # once per project, in its git repository
hammerola build                  # the working copy -> the dev slot: YOUR eyes
git commit -m "..."              # a version is a commit on main
git push hammerola-<pid> main    # -> an immutable revision; `latest` moves to it
```

**`build` is what YOU look at, a pushed commit is what the PERSON looks at** —
split by audience, not by how finished the part is. Never hand over a `dev`
URL, not even as "have a look meanwhile": the next `build` replaces it. `dev`
keeps no history, and a `dev`-only project is not on the front page.

**Push after every change that moves a number.** Nothing rations `build`, and
with no kernel here an unpushed model is one nobody has looked at. A brief that
forbids pushing blinds you.

`git push hammerola-<pid> main` makes a version exist: the hub builds the newest
pushed commit that touched the project's directory, names the revision by that
commit, keeps its log, moves `latest`, and the project gets its card. A commit
that touched only another directory of the repository builds nothing. A
session ending on a `build` published nothing. **Everything a person is shown
is a pushed commit**, the block preview included. **Hand over its URL every
time** — `published: /project/<pid>/<sha>/` in the push's output, under the
hub's address — not once at the end, or the person waits or prints something
superseded. The commit's subject is what a person picks a revision by.

It pushes the local branch `main` from any worktree: there is no need to switch
to it. `main` is the project's default variant, and its addresses are the
project's own.

**A variant of the project is a git branch** — a ceiling and a wall version of
one case. Each has its own history, `latest`, draft and documents; the page
switches between them by the project's title.

* Make one with `git switch -c <name>`, label it with `"variant": "Ceiling
  case"` in its `project.json` (without the key the switcher shows the branch
  name), publish it with `git push hammerola-<pid> <name>`. Its `latest` is
  `/project/<pid>/v/<name>/latest/`.
* A pushed branch stays a variant for good and is visible to everyone with the
  link: the hub never deletes a branch. **Never push a working branch that is
  not a variant.**
* `build` writes the draft of the branch checked out, from a worktree too:
  `/project/<pid>/v/<branch>/dev/`, the address it prints, and `/dev/` is
  `main`'s alone. A branch name is letters, digits, `-` and `_` — no `/`: the
  hub refuses `feat/x`, its draft included, and `build` refuses a detached HEAD.
* A change every variant needs (the board, a datasheet, the shared case code)
  goes into each branch: `git merge` or `git cherry-pick`.

**The push waits for the whole build** and exits non-zero unless the commit was
published: the hook refusing it is the build failing, with its log in the
output — "did not ship", not a warning. `build` likewise prints the log and
exits with `git push`'s code. A quarter of the hub's builds take over two
minutes: raise the timeout of the tool you push with, or push in the background
(`references/checks.md`).

**Rejected without the hook refusing** (`! [remote rejected]`, or `rejected
(fetch first)`): somebody published in between. `git pull --no-rebase
hammerola-<pid> main`, then push again. The flag is required: a bare `git pull`
on diverged branches refuses, and `--rebase` gives your commit a new sha, so its
published build drops out of the history and is built again. A push that broke
off and was then rejected on retry: first `git ls-remote hammerola-<pid> main`
— if your commit is there, the version is published.

**`-C DIR` (`--directory`) goes BEFORE the verb** —
`hammerola -C ../bracket build` — and is exit 2 after it; the verb then runs as
if started in that directory.

## Four rules that break a push

**1. Only what is committed is published.** The hub takes the project's
directory from the commit as it is. A file the model reads and a document
`project.json` names have to be in git; what `.gitignore` lists is not
published, by a push or by `build`. `git status --ignored` shows what will not
be. A symlink or a submodule in the project's directory refuses the push.

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
* **The tool's own timeout.** `git push` or `hammerola build` run under a
  timeout shorter than the build publishes the build and loses the log
  (`references/checks.md`).
* **A number with no provenance**, or an `estimated` quoted back afterwards as
  a measurement (`references/brief.md`).

## When a build fails

The log `build` and `git push` print is the whole account. **Read it from the
top**: the gate refuses in a fixed order, so the first complaint is the real
one.

```sh
hammerola log            # the newest revision's log
hammerola log <revision> # that one
hammerola log dev        # the last build's, committed or not
hammerola status         # latest, whether dev is occupied, the revisions (-n/--limit)
```

**Never rebuild to read a log you already have**: `log dev` serves it, its
header naming the push, and jobs are kept forever.

* `build failed: ...` — your model or a gate said no; what it names is in `model.py`.
* a traceback — `model.py` raised; the bottom frame is yours.
* `timeout` / `cpu_exhausted` — past a ceiling; usually a boolean out of hand.
* a refusal with no log — the push itself was refused before any build: a
  branch other than `main`, a forced push, no `project.json` with this id, a
  symlink (rule 1).

**When what is wrong is your own `checks()`, `--force` publishes anyway.** It
skips `checks()` and nothing else: every gate of the hub still refuses. The log
says `checks: not run`, and the metrics record the count as unknown, not zero.
Use it for a check that is wrong, slow or asserting a known falsehood — never
to get past a right one.
