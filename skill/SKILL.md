---
name: hammerola
description: Design a 3D-printable part and publish it from this repository to a hammerola hub, which builds the geometry from code and serves it in a browser viewer. Use whenever the task is to design, fix or measure a physical part — a bracket, mount, holder, cover, enclosure, adapter, jig, anything heading for a printer — and whenever the working directory is (or is becoming) a model project: a model.py with views() and printables(), or a project.json with a hammerola id. It carries the client's commands and the working discipline that keeps a part from being printed wrong. Triggers: "design a part", "спроектируй кронштейн", "сделай крышку", "нужен держатель", "make a mount / holder / enclosure", "модель не лезет", "деталь не собирается", "the part does not fit", "3D print this", "3D-печать", "publish the model", "push this to the hub", "why did the build fail", "read the comments left on a build", "комментарии к модели", "hammerola build/commit", "start a new part".
---

# hammerola

The hub builds CAD models from code. You push a source tree, it runs `model.py`
inside its own image, gates the geometry and serves the result as a browser
viewer with STL/STEP/3MF downloads on a permanent URL. Your machine needs no CAD
kernel and installs none.

You talk to it with one command, `hammerola`. Everything below is that command
and the working discipline around it — not style advice: it comes out of nine
reviewed sessions, 177 hours of work, two ruined prints, dozens of hours redone.

## Set up, once per machine

The hub's address is whatever you were given; write it as `<hub>` below. It has
no default anywhere — never guess one, and never write one into a repository.

```sh
mkdir -p ~/.local/bin ~/.claude/skills/hammerola
curl -fsSL <hub>/start/skill.md -o ~/.claude/skills/hammerola/SKILL.md   # this file
curl -fsSL <hub>/start/hammerola -o ~/.local/bin/hammerola && chmod +x ~/.local/bin/hammerola
hammerola login <hub>
```

`login` asks for the hub's password at the terminal and stores it 0600 in
`~/.config/hammerola/env`. **Ask the owner of the instance for that password.**
It is one shared secret for the whole system, not a per-person key: whoever has
it can publish, read any project's source and delete a project outright. Do not
put it in a repository, a CI variable or a command line — an argument is in the
shell history and in every `ps` on the machine.

Nothing else is installed. `hammerola` is one file and imports only the Python
standard library, so a machine's own interpreter runs it — **python 3.9 or
newer**, which covers the stock `/usr/bin/python3` on macOS and on Debian 11. An
older one is told so and does nothing. If `hammerola` is not on your PATH after
this, `~/.local/bin` is not on it: run the file by its path, or add it.

## The working cycle, and why a commit is not optional

```sh
hammerola build            # -> the dev slot. Draft. Overwritten by the next build.
hammerola commit -m "..."  # -> an immutable revision, and `latest` moves to it
```

**`build` publishes into `dev`, and a project with only a `dev` build does not
appear on the hub's front page.** That is not a defect to work around: `dev` is
one directory that every push overwrites, it has no history, its URL is served
with no caching, and the hub stores neither source nor log under that slot. It
is the draft you refresh while you are shaping the part.

`commit` is what makes a version exist. The hub names the revision itself, from
the digest of the sources it received — git is not involved and the client never
invents an id — stores the code and the log under that name, moves `latest`, and
the project gets its card. Finished work is committed. If you leave a session
with the last thing you did being a `build`, nothing you did is on the site.

The URL of a commit is the thing the person opens, turns over and prints from.
Hand it over every time you commit, not once at the end of the job — a person
with no link either waits or prints something you have already superseded.

Afterwards `hammerola` prints a suggested `git commit` line recording what was
published. It never stages or commits anything itself; run the line or ignore it.

Both commands print the build log and exit non-zero unless a build was
published. That exit code is the whole verdict — treat a non-zero exit as "this
did not ship", not as a warning.

## Starting a project

```sh
hammerola create --title "Ceiling mount for a T13 sensor"
```

In an empty directory. It writes `project.json` with a fresh twelve-character id
and unpacks the starter template beside it — a `model.py` that builds as it
stands, and a `.gitignore`. It overwrites nothing: an existing `project.json`,
or a template file already there, stops the whole command.

**Commit `project.json` and never edit the id.** Every permanent URL of the
project is built from it, so changing it does not rename anything — it starts a
different project and orphans everything published under the old one. The title
is changed with `hammerola rename "..."`; there is no command that changes an id
because there is no route for it.

`hammerola create --no-template` skips the download for a directory that already
has a model, and is the one form that needs no hub at all.

## Before there is any geometry

Nearly all the wasted time in the reviewed sessions was decided here, in the
minutes before the first solid existed. A short phase, and not a skippable one.

**A word is not a specification.** "Bracket", "mount", "holder", "cover" each
name five different objects, and the one in the person's head is not the one in
yours. Say back what the object is as a shape, what it touches and what holds
it, then put up a block preview — the whole layout in boxes and cylinders, in
`views()`, pushed with `build` so the person can turn it round. That preview
closes this phase and is not optional. A build needs a non-empty `printables()`,
so the part goes in there as a box of its overall size and the things around it
stay mocks in the views. And `checks()` is still the template's, measuring its own
box and lid: it reddens on the first body of yours (`bracket.stl is 684 bytes,
which is not a printable mesh`; other geometry hits its lid-gap assert first).
Rewrite it to what little is known — envelope ≤ space available — or delete it;
gutting it is the form that fails. ("Semicircular bracket" went into geometry 36 seconds
after it was read: 3 h 48 min of work and a 227-line file were thrown away.)

**A constraint that is not a body does not exist.** Bought hardware, the wall,
the human hand, the hose, the panel behind it — all of them are modelled, even
though none of them is ever printed. (A motor appeared as a body 4 h 32 min
after the parts that mount on it, and immediately produced two interferences.
Trigger ergonomics took 5 h 02 min and four rejections while no hand existed as
a body; one iteration was enough once it did. A wall and a plywood stack that
existed only in the chat produced, twice in a row, a resonance calculation for a
cantilever that was not there.) Anything flexible — hose, cable, strap — is
mocked at its minimum bend radius, and its route is a decision you state out
loud rather than a thing that happens. A mock never carries a printable's word
in its name — `blank`, `panel`, never `lid mock`: coverage counts whole words,
so such a mock answers for the printable `lid` and the build goes green with the
real `lid` in no picture. The hub says so in a `warning:` line and publishes.

**Ask whether the assembly is already sold before you design it.** A make-or-buy
line, with a price and a link, comes before the first geometry. (Four hours went
into a home-made siphon assembled from four elbows; the ready-made one costs
309 ₽.) Start that search on your own disk, in your past projects, before the
internet: there the part comes with a drawing and a decision somebody argued
through. They are findable — grep the transcripts under `~/.claude/projects/`
(below), and the `cwd` in a file that hits names the directory. (A tension latch
with the manufacturer's drawing sat in a neighbouring project; finding it took 8
seconds, after a day spent on a wrong premise.)

**Hardware is named, not described.** "A bolt into the wall" is not a
specification: no thread, no length, no head, no drive, no material, nothing
about what holds it. Every fastener and bought item carries a designation that
names exactly one product — `M6×30 DIN 912 A2`, `Ø8×60 nylon anchor with a 5×50
screw`, or a shop's article number where no standard covers it. The mock is
built from that designation, and `checks()` measures against it.

**Hardware changes as the design goes, and what it replaced stays visible.**
A superseded item stays in `ref/hardware/` as the record of what was tried,
marked so nothing can be built against it by mistake: the line
`SUPERSEDED <date> -> <what replaced it>` at the top of its file, and the current
designation in exactly one place — the constant `model.py` builds the mock from
and `checks()` measures against, which `ref/` and every message quote rather than
repeat. (One siphon changed identity four
times — McAlpine A10 → Wavin 5V812 → two article numbers — and asked for "the
model of the siphon we chose" the agent handed over the second of the four.
Elsewhere a carbide drill bit, struck out as useless in aerated concrete, was
back in the parts list fourteen minutes later out of sheer momentum.)

**A picture the person sent is already on disk** — base64, in the session
transcript — so asking the person to save it for you is work you did not do. Pull
it out yourself, in the same turn, into `ref/`, name it for what it shows, and add
a line to `ref/README.md`: what is visible and what constraint follows from it.
Then scale them down before the first `build`: `ref/` is pushed whole every time,
and one session's paste runs to tens of megabytes. Settle the resizer before you
run the snippet below, which fills `ref/` regardless. On macOS,
`find ref -type f -exec sips -Z 1600 {} \; 2>/dev/null`: it takes the `.jpeg` the
snippet names from `media_type`, and survives an empty `ref/`, where `ref/*.png`
is a zsh error that runs nothing. Elsewhere test `python3 -c "import PIL"` and use
Pillow. With neither, do not run the snippet: no photograph enters `ref/`, its
number goes to `ref/measurements.md`. (Asked outright to file five photographs
into the refs, an agent answered "save them yourself" while sitting on the file
that held them; in another session the same agent spent 41 minutes digging base64
out of other people's transcripts to recover what had been lost.) The transcript
is one JSON object per line — 100 MB and more, so read it a line at a time — under
`~/.claude/projects/`, in a directory named for the working directory with every
non-alphanumeric character replaced by `-`; your own session id is not in your
context, so take the newest `*.jsonl` by mtime, and a `None` means the slug is not
what you guessed — list `~/.claude/projects/` and find the one holding your work.
Images sit in the `user` records **and** in the `type: "attachment"` records,
whose `attachment.prompt` holds everything pasted while you were working — often
the only place it appears, so `message.content` alone misses it:

```python
import base64, hashlib, json, pathlib, re

slug = re.sub(r"[^A-Za-z0-9]", "-", str(pathlib.Path.cwd()))
folder = pathlib.Path.home() / ".claude" / "projects" / slug
tx = max(folder.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, default=None)
if tx is None:                       # wrong slug: list ~/.claude/projects/ and look
    raise SystemExit(f"no transcript under {folder}")
ref = pathlib.Path.cwd() / "ref"
ref.mkdir(parents=True, exist_ok=True)
seen, n = set(), 0
with tx.open(encoding="utf-8") as f:
    for line in f:                                    # transcripts reach 100 MB
        try:
            rec = json.loads(line)
        except ValueError:
            continue                                  # the live session is still writing
        if not isinstance(rec, dict):
            continue                                  # a line that parses to a scalar
        msg = rec.get("message")
        blocks = msg.get("content") if isinstance(msg, dict) else None
        if not isinstance(blocks, list):              # pasted while you were working
            att = rec.get("attachment")
            blocks = att.get("prompt") if isinstance(att, dict) else None
        for b in blocks if isinstance(blocks, list) else []:
            if not (isinstance(b, dict) and b.get("type") == "image"):
                continue
            src = b.get("source")
            if not isinstance(src, dict) or not src.get("data"):
                continue                              # by url, or no source at all
            data = base64.b64decode(src["data"])
            digest = hashlib.sha1(data).hexdigest()
            if digest in seen:
                continue                              # the same picture twice over
            seen.add(digest)
            n += 1
            # "image/svg+xml" -> "svgxml": a `+` in the name refuses the push
            ext = re.sub(r"[^A-Za-z0-9]",
                         "", (src.get("media_type") or "").split("/")[-1])
            # A placeholder name: rename each for what it shows, then scale down.
            (ref / f"clamp-on-pipe-{n}.{ext or 'bin'}").write_bytes(data)
print(f"{n} images -> {ref}")
```

Rename them as they land. A second run counts from one again, so point it at an
empty directory or it restores what you renamed, as duplicates.

**`ref/measurements.md` is the log of raw measurements**: date, what was
measured, with what, the number. Every constant of a fit, a clearance or an
interference cites a line in it. The word "measured" in a comment with no line
behind it is a lie written into the source. (`thread_clearance = 0.30`, carrying
the comment `# measured fit on the printer`, was never measured: two ruined
prints, 100 g of plastic, and the part never worked.)

**`ref/` is published with every build**, and two things follow from that. Its
names obey rule 1 below — ASCII, no `×`, no `Ø`, no Cyrillic — and one bad name
refuses the **whole** push, so a hardware designation goes inside the file and
never into its name (`ref/hardware/m6x30-din912-a2.md`, not
`M6×30 DIN 912 A2.md`). And a push carries at most 1024 files and 64 MiB
unpacked — the client says "67 MB", counting in millions — re-sent in full every
time, which is why `sips` runs before the first `build`. That 64 MiB is only the
client's default; a deployment may set its own, and its 413 has the real number.

**A size the person names for the space is a ceiling, not a target.** "About",
"for reference", "could be smaller", "maximum" are the markers of a ceiling;
write those words down as a literal quote next to the number. The size of the
part is derived from what has to be inside it, and the available space enters
exactly one statement: needed ≤ available. (A drawer height was computed as
"ceiling minus clearance" while the person said "could be smaller" six times
over three days; the final edit removed 129 mm and neither the water, nor the
mirror, nor the cut-off moved by a millimetre. In another project a dimension
along a wall went 170 → 139 → 112 → 100 → 88 → 78 → 48.5 mm over eight rounds of
shouting.)

## The contract with model.py

The template `create` unpacks is the live example — read it rather than this
section: a working model with the rules written next to the geometry. In short:

* **`views()`** — a list of tabs, each `{"id", "name", "parts": [...]}`, each
  part `{"shape": <CadQuery object>, "name": "<label>"}` with optional `color`
  and `alpha`. Every printable has to appear in some view. Two ids mean more
  than that: an `assembled` view, if the project has one, must show every
  printable, and in `print` no two parts may stand inside one another — that
  view is the bed, unless the pair really is nested and the view says so in its
  `"nested_ok": [("a", "b")]`.
* **`printables()`** — `{name: <CadQuery object>}`, one entry per part somebody
  prints, and **each entry is one fused body**. Each becomes `name.stl`,
  `name.step` and `name.3mf`. The gate reads `.val()`, the first body on the
  stack and only that one: it alone is validated, measured, written to the STL
  and rendered, and the log's `valid, volume … cm3, watertight, one body` is
  about it. So a Workplane holding several unfused bodies — `plate.add(bosses)` —
  publishes green with everything after the first missing from that part's own STL
  and preview, while the 3MF and the STEP are written from the whole object.
  `pushPoints(...).box(..., combine=False)` is worse: it REPLACES the stack, so the
  base itself is the body that goes missing. `assembled` is glued from every body of
  every object, so `assembled.stl: N parts` in the log, `N parts` in that picture's
  footer, counts bodies: more than the view should hold is a printable not fused (a
  plate with three bosses added logs `volume 9.60 cm3` and `4 parts`; with them
  replacing it, `0.22 cm3` and `3 parts`). Only the other half is refused, one body
  in disconnected pieces: `N disconnected pieces, not one body`. Fuse the
  part, or hand each piece back under a name of its own. **Each part is built
  in the orientation it is printed in, and the views move copies of it into
  place**: the orientation that counts is the one on the bed, not the one in
  the assembly. No gate checks that; a part modelled upside down publishes
  green, and the one thing that catches it is the render below, which you fetch
  yourself. `MIN_PRINTER_MM` in the template is nobody's real bed but the size
  below which FDM printers barely exist; a part that outgrows it is the moment
  to ask which printer this is for and to put that machine's volume in.
* **`checks()`** — optional, and the place for everything specific to this part:
  fits, clearances, hardware, bed size. It fails by `assert cond, "why"` or by
  returning a list of problem strings. A `checks()` that provably contains no
  check fails the build, because a log saying "checks passed" for a function
  that looks at nothing is worse than no function at all.
* **`import checklib`** — reusable geometry checks (`pairwise_interference`,
  `mating_face_flat`, `material_under_head`). The module lives inside the hub's
  image; there is nothing to install and nothing to vendor.

Those three functions are all that `checklib` checks, and the gate is all of
the hub. Nothing anywhere checks an overhang, a minimum wall, whether a tool
reaches a screw, or where a number came from. Every rule in the next section is
a check you write yourself or something you go and look at. Of the bed the gate
reads one thing: `check_print_layout` compares bounding boxes in `print`, and
parts standing inside one another — by more than 0.05 mm on all three axes —
refuse the build. Orientation, the air between parts, how much of each sticks
to the plate, whether any of it fits the machine: none of that is read. And no
command of the client brings back a picture: `artifacts` downloads only what
`meta.json` declares, and that list is built from `printables()`.

**The pictures exist all the same, and fetching one is the cheapest check there
is.** A build renders one isometric PNG per printable and one of the stem
`assembled`, and nothing else: `print` has no picture, nor has any tab you add,
so the bed layout is what no picture answers. Each comes off that stem's STL, so
a part's preview shows exactly what will print, while `assembled.stl` is glued
from the `assembled` view — or from the printables themselves, where the project
has no such view. Under each is a footer: `Bounding box: 60.0 x 20.0 x 6.0 mm`,
the triangle count, and `watertight` — which on the assembly reads `N parts`. The
build directory is published whole, so they are served — undeclared, public, no
secret — at `<hub>/project/<pid>/<build>/<part>_preview.png`, with
`assembled_preview.png` beside them: `<build>` is `dev`, `latest` or a revision,
`<pid>` the id in `project.json`. A `.png` is off the whitelist of types a build
directory serves inline, so it arrives as an attachment: `curl -o` it and read
the file. You can read a picture and the gate cannot.

Shape is otherwise judged in the browser viewer, and **a size comes back three
ways**: that footer, `metrics.json`, and whatever the model prints. The second
sits in the same build directory, and `.json` IS on the inline whitelist, so
`curl <hub>/project/<pid>/dev/metrics.json` gives `bbox_mm` for every part
straight after a `build`, with no commit. The log itself carries no size — per
part it says `valid, volume … cm3, watertight, one body, N triangles` — so
a `print()` in `model.py` or `checks()` is the third. Print every printable's
bounding box from `checks()` all the same, for a different reason: the log is
what `commit` keeps, while a picture and a `metrics.json` have to be fetched. That
log is the child process's stdout and stderr merged and kept to the FIRST 1 MiB — a
flood loses its tail, not its head — so print short and early. `hammerola diff
<old> <new>` reads the same file over the same public URL into memory, takes two
*published* revisions (it refuses `dev`) and prints only the numbers that moved.

## Checks that actually check

**Measure the solids rather than restating the constants that drove them.** A
check that repeats the arithmetic passes for the wrong reason, and it goes on
passing after the geometry has drifted away from it — it is the single most
expensive habit in the reviewed sessions. A constant compared against a constant
is not a check at all. (`assert DOWEL_SEAT_CLEARANCE >= 0.3` is a constant
checking itself. It passed two reviews, and both end screws fell out of the
printed part.)

**Measure the thing the part exists for, not the proxy you happened to pick.**
If what matters is how far a lever protrudes, cut it against the housing and
measure what is left, and do not measure the variable you set the drop from.
(Protrusion was checked through `GRIP_DROP` instead of a boolean with the body:
the checks were green exactly while the defect was plainly visible in the
picture — 5 hours and four rejections.)

**Repeated features are weighed one by one, never by an extremum.** A `min` or a
`max` over the whole part is green when one of four bosses is missing, because
the other three still answer. Count them and measure each. (A `union` silently
returned a body without the boss; the check stayed green for 3 h 38 min.)

**Every fit number has a provenance**: measured, with its line in the
measurements log; derived, from a number you name; or an estimate — and an
estimate never drives geometry. It is printed from `checks()` instead, which is
what puts it in the build log; commit, and `hammerola log <revision>` still has
it. Print it from a `build` and it lives at that build's job and nowhere else,
addressed by an id rather than by the slot (below). (43 minutes of argument
about sediment washout in which both sides were estimates: the velocity differed
by 5.5×, the threshold had a 3× spread.)

**A printed pair that has to move relative to its partner — a thread, a sliding
fit, a snap, a hinge — is never printed whole the first time.** First a gauge: a
stub of the pair as a ladder over the clearance, each step with its number
embossed on it, then the full part once a human has printed it and said which
step works.

**The gauge is a build of its own, into `dev`, and never a part of the
product.** It comes before the product does — the clearance is not chosen yet,
so neither is the part that uses it — so `printables()` returns the one gauge,
`assembled` shows that same gauge, `print` stands it on the bed. That passes the
view gates whole; no view is deleted or bent around a part that is not the product.

The ladder is one fused body — the steps on a common base, the embossed digits
unioned to it — for the reason under `printables()`; fetch `<gauge>_preview.png`
and count the steps in it, where a ladder of separate boxes shows up as one
step. `checks()` is rewritten for the gauge, a check per step measured on the
solids, and the reason is that nothing will make you: `run_checks` looks up the
function named `checks` and knows nothing of `printables()`, while the product's
`checks()` builds its parts by calling the builders, which swapping
`printables()` leaves alone. So it runs to the end and the log says `checks: N
passed` about parts the build has not got. (Template, `printables()` cut to one
gauge, `checks()` verbatim: `checks: 6 passed`, BUILD GREEN.) Only a `checks()`
indexing `printables()` by name refuses by itself. The rest holds — a gutted one
fails the empty-checks gate, no flag skips checks, deleting it passes and throws
away every complaint ever turned into an assertion — so commit the product's
`checks()` to git first: the hub keeps no `dev` source and the slot is overwritten.

The person prints it and names a step, the number goes into the part, the next
`build` overwrites `dev`, and not a line of the gauge is left. That is what the
slot is for. (The same thread: two prints, 100 g.)

**A complaint becomes a check.** When the person says a thing is wrong, it goes
into `checks()` as an assertion before the next push into that area of the part,
so that the same wrongness cannot come back quietly.

**Fasteners are checked for tool access, as a body**: a cylinder from the head
along the axis, driver length, swept through the assembly. A fastener with no
such check is a hole, not a fastener. (Twice in twenty minutes: first an
invented inaccessibility for screws that had 51.5 mm of clear side access, then
a cone that genuinely closed access to the nuts.)

**Every body in the assembly names what holds it along +Z, along −Z, and in
rotation.** "It rests on that" is one direction, not two, and a part that is
only held downwards is held by gravity. (A wheel was retained only downwards
against an upward axial pull; the bearing cap made the day before was holding
something that was not going anywhere in the first place.)

## Four rules that break a push, in the order they bite

**1. File names.** Every component of every path in the project must match
`[A-Za-z0-9][A-Za-z0-9._-]{0,127}` — ASCII only, first character a letter or a
digit, no leading underscore, no spaces, no Cyrillic. One bad name refuses the
**whole push**, not that file, so `детали.py` or `My Model.py` next to
`model.py` stops the project publishing at all. Rename them. The alphabet is
deliberate and is not relaxed: it is what makes a path inside the archive
incapable of naming anything outside it. Hidden entries (`.git`, `.env`,
`.venv`) are dropped instead of refusing it, so a normal repository publishes
fine. Paths are at most 8 components deep, files at most 1024.

**2. Never put a `checklib.py` at the root of a model.** A model is imported
with its own directory first on `sys.path`, so your copy wins over the one in
the image — and then `checklib` records the interference volumes it measured
into one copy while the build reads them out of the other. Nothing goes red. The
build warns and publishes, and `metrics.json` simply has no interference numbers
in it. The same applies to any file that shadows a module the build imports.

**3. Nothing is installed for a model.** The image has `cadquery`, `trimesh`,
`numpy`, `matplotlib`, `Pillow` and the standard library. A `requirements.txt`
beside `model.py` is read by nothing, and that is a security decision rather
than an omission: installing a package executes code inside the build. Write
what you need in the project, in files the model imports.

**4. `model.py` is executed by the hub.** Anything you write there runs on the
hub's machine under a CPU limit, a wall clock and a memory ceiling. Do not read
the network, do not read the environment, do not spawn anything — a build that
takes longer than the ceiling is killed and reported as a timeout with a stack.

## While the work is running

**The geometry is edited by the hand that owns the task.** Changing a number, a
clearance, the position of a primitive — above all any edit that follows from a
review — is an `Edit` you make yourself, not a brief you hand to somebody else.
(One session: zero `Edit` calls in 2808 lines of transcript, the whole geometry
driven through 38 subagents; changing `27` to `26` was delegated, 41 minutes.)

**A brief is a goal, absolute paths to what has already been found, and a
criterion for being done.** "Find the drawing" is not a subagent task at all:
finding the source data is the lead's own work, and the subagent builds from the
numbers that were found. (A 9.5 KB brief carried a retelling of the problem and
a ban on the one correct link; ten minutes later the lead found the drawing
himself and sent "stop searching, I should have given you this at the start".)

**A round of edits that moves no physical number is not started.** Before the
round, one line: which quantity changes — envelope, volume, clearance, fit — and
by how much. If there is no such quantity, the round is about the script and not
about the part. (Of three rounds of edits on a physical part, exactly one
parameter reached the part; everything else was self-checks inside the script.)

## When a build fails

`build` and `commit` print the build log as it happens; that log is the whole
account of what went wrong. Read it from the top — the gate refuses in a fixed
order, so the first complaint is the real one and nothing after it ever ran.

```sh
hammerola log            # the newest published revision's log, again
hammerola log <revision> # that one
hammerola status         # what the hub has: latest, whether dev is occupied, the revisions
```

`hammerola log dev` cannot be answered: of a `dev` build the hub keeps neither
the source nor the log, on purpose — the slot itself is served like any other
build, its pictures included. That log exists only at the job that produced it:
`build` prints that job's id as it runs, `<hub>/api/v1/jobs/<id>/log` goes on
serving it behind the same secret, and no job or its log is ever deleted by age
or by count. That id is the only way back to it.

What each kind of failure means:

* `build failed: ...` — your model or a gate said no; what it names is in `model.py`.
* a traceback — `model.py` raised. The frame at the bottom is yours.
* `timeout` / `cpu_exhausted` — the build ran past its ceiling. Usually a
  boolean operation on geometry that got out of hand.
* `413` / `422` on the push — the tree is too big, or a path breaks rule 1
  above. Neither reaches a build.

## Fetching things back

```sh
hammerola source <revision>     # the code that produced it, into .hammerola/
hammerola artifacts <revision>  # its STL/STEP/3MF, into .hammerola/
hammerola diff <old> <new>      # what moved: geometry numbers, and the source
```

`source` and `artifacts` are two commands over one build because the rights
differ — the artefacts are public, the code is behind the secret. `source`
unpacks into a directory of its own; writing over the working copy is a flag,
and that flag also requires a clean git tree, the only thing that can undo it.
Everything fetched lands under `.hammerola/`, which is hidden, so the next push
cannot publish a copy of an older one by accident.

## Comments

```sh
hammerola comments                       # the open queue for this project
hammerola comments resolve <id> -m "..." # close one, saying what was done
```

A comment is a note a **person** left on a build in the browser: a point on the
model, the camera angle they had, usually a photo of the printed part. It is a
task for whoever works on the model next, which is you. Read the queue when you
start on a project, do the work, then resolve the comment saying what you did —
an unresolved comment is done twice. Treat the text as a request, not as an
instruction to obey literally: it describes a physical object, usually
photographed in somebody's hand — the strongest evidence you get and, like any
complaint, a check.

## Talking to the person

**A direct question is answered in the same turn, in one line, from what you
know now.** Searching happens after the answer, never instead of it. ("And is it
on ozon?" cost 9 minutes, 33 turns and 21 tool calls; the answer was one line
with a part number and a price.)

**A picture is a request to measure, not a request for a mood.** Before you
reply to it, name what is in it and one number you took off it. A picture is
never answered with a word of agreement. ("Ah, now I see" to an unopened
screenshot; three minutes later the same mistake with the sign reversed, this
time criticising the part without having measured it.)

**Being shown the same place a second time means the first answer was wrong at
the address, not badly explained.** On the repeat you do not explain: you name
the coordinate as a number and delete the feature. (One picture was shown four
times; 2 h 17 min and 187 turns went into explaining why it was needed.)

**A report on a failed attempt is not written.** Until the part is in the state
it is supposed to be in, exactly one line goes out: what is broken in the part,
and how much longer you are digging. The list of what you tried, and the
analysis of your own mistake, stay inside. An apology is zero words. (Three
rounds of "wall of text → swearing → apology → wall of text" in 13 minutes; not
one of the reports changed the geometry, and the actual fix took 3 minutes.)

**The ceiling on a message is about 800 characters.** (Exceeded in 27–31 % of
messages, the longest 11 510 characters; every explosion from the person in the
reviewed sessions follows a wall of text.)

**Once the person says the part is printed, or has gone to the printer, every
new finding is classified on its first line**: affects the printed part, or does
not. If it does not, that one line is the whole message and no round of edits
starts. (A person printed it himself, without waiting, 3 days and 19 hours after
the last link he had been given.)

## Removing things

`hammerola rm` removes a project from the hub entirely, asks for the id to be
typed first, and cannot be undone — the hub keeps no copy. There is no way to
remove one build: that would break a permanent URL somebody was given while
leaving the project standing. Do not run it to "clean up"; ask the owner.
