---
name: hammerola
description: Design a 3D-printable part and publish it from this repository to a hammerola hub, which builds the geometry from code and serves it in a browser viewer. Use whenever the task is to design, fix or measure a physical part — a bracket, mount, holder, cover, enclosure, adapter, jig, anything heading for a printer — and whenever the working directory is (or is becoming) a model project: a model.py with parts() and views(), or a project.json with a hammerola id. It carries the client's commands and the working discipline that keeps a part from being printed wrong. Triggers: "design a part", "спроектируй кронштейн", "сделай крышку", "нужен держатель", "make a mount / holder / enclosure", "модель не лезет", "деталь не собирается", "the part does not fit", "3D print this", "3D-печать", "publish the model", "push this to the hub", "why did the build fail", "read the comments left on a build", "комментарии к модели", "hammerola build/commit", "start a new part", "CadQuery", "STL".
version: 18
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

That first `curl` is how this file arrives before there is a client to fetch it;
afterwards the client keeps it current. `hammerola skill` says which version is
installed here and which the hub serves, and `hammerola skill update` replaces
the file with the hub's copy. Nothing checks it for you: a stale skill is the
one thing here that fails silently — it goes on confidently teaching commands
that no longer exist — so ask when you start on a project. Both verbs take
`--path FILE`, and it matters more than it looks: the path above is a guess the
tool has to make, while the instructions you are actually reading may be a
plugin's copy or one scoped to this project. Name the file when it is not that
default, or `skill update` reports on and overwrites one nobody reads.

**`hammerola update` does the same for the tool itself**, fetching the hub's
copy over the running file and printing what changed between the two versions.
That one you will be told about rather than having to ask: `build` and `commit`
check, and a client older than the hub is refused before it packs anything.

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
hammerola build            # -> the dev slot. YOUR OWN eyes. Overwritten by the next build or commit.
hammerola commit -m "..."  # -> an immutable revision, and `latest` moves to it
```

**The two verbs are split by AUDIENCE, not by how finished the part is:
`build` is what YOU look at, `commit` is what the PERSON looks at.** Everything
shown to a person goes through `commit`. A `dev` URL is never handed over — not
as a link, not as "have a look meanwhile", not under a picture.

**`build` publishes into `dev`, and a project with only a `dev` build does not
appear on the hub's front page.** That is not a defect to work around: `dev` is
one directory that every push overwrites, it has no history, its URL is served
with no caching, and the hub stores neither source nor log under that slot. It
is what you push in order to look at the thing yourself — fetch a picture, read
`metrics.json` (both below), see whether a number landed where you meant it to.
A link into it names something the next push destroys, so a person who opens it
tomorrow is shown a different part and is not told.

**Nothing here rations `build`, and the slot exists so that nothing has to.**
It is the only pair of eyes you have: there is no CAD kernel on your machine —
that is the point of the hub — so a model you have not pushed is one nobody has
looked at, you included. What is left in its place is re-deriving the arithmetic
by hand, in scripts that restate the constants the part was built from, which is
the tautology of "Checks that actually check" with the geometry unseen as well.
Push after every change that moves a number. (51 minutes, eight edits, four of
them redoing the other four — the console under the barb, the tail, the skirt,
the centre of mass — and not one build in the whole of it: each was re-derived
on paper because nothing had been looked at.) A brief that forbids pushing is a
brief that blinds; `dev` is overwritten by design, so there is nothing to spend.

`commit` is what makes a version exist. The hub names the revision itself, from
the digest of the sources it received — git is not involved and the client never
invents an id — stores the code and the log under that name, moves `latest`, and
the project gets its card. Finished work is committed. If you leave a session
with the last thing you did being a `build`, nothing you did is on the site.

**`commit -m` (`--message` in full) is what a person picks a revision by** — the
flag is `commit`'s alone, and `build -m` is exit 2. It is kept with the revision,
stands beside it in the build picker, and becomes the subject of the git commit
suggested afterwards — so a revision published without one is a 64-character id
and nothing else, and somebody choosing between two of yours has nothing to
read.

**The first thing a person is shown is already a commit.** The block layout of
the next section — the whole part in boxes, before one real solid exists — is
committed, not built: it is shown, so it is a revision, and being crude does not
make it a draft in the sense `dev` means. Every later "done, here it is" is a
commit as well, quoted to the person by its revision. A round of edits that ends
in a `build` is a round the person has no way to see.

The URL of a commit is the thing the person opens, turns over and prints from.
Hand it over every time you commit, not once at the end of the job — a person
with no link either waits or prints something you have already superseded. (A
person printed it himself, without waiting, 3 days and 19 hours after the last
link he had been given.)

Afterwards `hammerola` prints a suggested `git commit` line recording what was
published. It never stages or commits anything itself.

Both commands print the build log and exit non-zero unless a build was
published. That exit code is the whole verdict — treat a non-zero exit as "this
did not ship", not as a warning.

**`-C DIR` (`--directory DIR`) goes BEFORE the verb, not after it** — `hammerola
-C ../bracket commit -m "..."`, never `hammerola commit -C ../bracket`, which is
rejected outright with exit 2. It is the one flag that sits on the tool rather
than on a verb, and every verb that works with a project then runs as if it had
started in `DIR`. That is how you push or read a project that is not the
directory your shell is in, without a `cd` whose effect on every later command
you then have to carry in your head.

## Starting a project

```sh
mkdir t13-ceiling-mount && cd t13-ceiling-mount
hammerola create --title "Ceiling mount for a T13 sensor (t13-ceiling-mount)"
```

In an empty directory. It writes `project.json` with a fresh twelve-character id
and unpacks the starter template beside it — a `model.py` that builds as it
stands, and a `.gitignore`. It overwrites nothing: an existing `project.json`,
or a template file already there, stops the whole command.

**The title is what it is and what it is for, then the directory's own slug in
brackets** — `Ceiling mount for a T13 sensor (t13-ceiling-mount)`, `Насос для
шликера (slip-pump)`. The bracketed half is not decoration: projects are made by
copying an existing one, and the title is the field a copy forgets to change, so
a slug that no longer matches is how you find out. A title with no slug in it
builds and publishes; the log says so in a `warning:` line, because there is
then nothing tying the words on the card to this project rather than another.

`create` writes that slug into `project.json` as a third key, `project` — the
name the hub publishes under, the one on the index card and in the build page
header. **The directory is where it comes from, so name the directory first**:
the hub never sees the directory (a push is unpacked under a name of the hub's
own), which is why the name has to travel in the file. Where the directory does
not yield a name the hub will publish under — spaces, Cyrillic, a leading dot,
or, when a `--title` was given, simply longer than the 200 characters the hub
shows — `create` falls back to the slug in the title's own brackets, and only
when neither yields one does it write no key at all. With no `--title` an
over-long directory name stops the command instead, because it would have become
the title as well. A project that reaches the hub with nothing naming it publishes
under its id, which is the card with no name on it that this key exists to
prevent.

That key is written once, at `create`. `hammerola rename "..."` moves the TITLE
and nothing else, and there is no command that changes `project` — renaming the
directory afterwards leaves the file saying what it said, and `create` says so
at the time with a `note:` when the directory and the title's brackets disagree.

**Commit `project.json`. The `id` is the key never edited by hand; `project` is
the one key that is.** Every permanent URL of the project is built from the id,
so changing it does not rename anything — it starts a different project and
orphans everything published under the old one, and there is no command for it
because there is no route. The title moves with `hammerola rename`. `project`
has no command either, so changing the published name means editing that one
line and pushing — knowingly: every later build publishes under the new name,
while everything already published keeps the old one.

`hammerola create --no-template` skips the download for a directory that already
has a model, and is the one form that needs no hub at all.

## Before there is any geometry

Nearly all the wasted time in the reviewed sessions was decided here, in the
minutes before the first solid existed. A short phase, and not a skippable one.

**A word is not a specification.** "Bracket", "mount", "holder", "cover" each
name five different objects, and the one in the person's head is not the one in
yours. Say back what the object is as a shape, what it touches and what holds
it, then put up a block preview — the whole layout in boxes and cylinders, as a
catalogue and an `assembled` view, published with `commit` so the person can
turn it round. That preview closes this phase and is not optional; it is shown,
so it is a commit, and it is the project's first revision. A build needs at
least one `printable` in the catalogue, so the part goes in as a box of its
overall size and the things around it go in beside it as `mock` and `hardware`.
And `checks()` is still the template's. What reddens is the one section of it
NOT written about the template's own parts: the last one walks `parts()` rather
than naming anything, so it lands on YOUR catalogue — and a block preview is a
box (`bracket.stl is 684 bytes, which is not a printable mesh`).
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
cantilever that was not there.) Each of them is a catalogue record of its own:
`hardware` for what is bought and goes into the product, `mock` for what is
there so the picture makes sense. Which of the two you write is what the gates
then read — hardware is asked whether it shares space with anything, a mock is
scenery and is not asked, and neither of them may stand on the plate.

**An operation nobody named does not exist either.** The part is what comes off
the printer. Tapping a hole, reaming it, drilling it out, gluing, pressing in a
heat-set insert, bending, sanding to fit — every one of those is a step somebody
has to own, with a tool, and it exists only once a person has named it and
agreed to it. A model that works only after an unnamed operation does not work:
what will be printed is the `printable` record of the catalogue, and the
operation lives nowhere but in your head. Where a step IS agreed, it is written
down the way
hardware is — named, with the tool's designation, in `ref/` — and the geometry
stays the state that comes off the bed. (A socket was drawn as a smooth Ø8.43
hole "under a tap", so that the nozzle's Ø9.35 thread would have something to
cut into. Nobody had said a word about tapping, there was no tap, and the
assembly worked only in a description of it. Threads that are printed are
printed.)

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

**Stock that is cut to length is answered with a cut list, never with a
length.** Threaded rod, tube, extrusion, strip and cable are bought in sticks
and cut, and two things decide the order, neither of which is the sum. First
the stick: the requirement is *packed* into the stock length, not added up.
Four 357.6 mm studs and one 405.7 mm shaft are 1836 mm against two 1000 mm
sticks, which reads as 164 mm spare — but three studs do not fit one stick, so
two sticks give either four studs and no shaft, or three studs and the shaft.
The spare exists only as two offcuts too short to be anything.

Second, and this is the one that bites at assembly rather than at the order:
**the allowance goes on the member that can absorb the others' error, and the
cut list must name which member that is.** Find it by asking what each end of
each cut piece runs into. In a chain closed by adjustable joints — threads,
clamps, grub screws — one member usually has an end that runs into *air*:
surplus there costs nothing, because it is taken up by screwing that piece
further in. That member is the compensator. It is cut long by a stated amount
and cut **last**, off the assembly rather than off the drawing; everything else
is cut to nominal. Surplus flows one way only — extra length in the compensator
absorbs error anywhere in the chain, extra length anywhere else is absorbed by
nothing. A chain with no compensator at all is a design defect, not a cutting
problem: it cannot be assembled without filing something.

This also settles how the tolerance is written: **directional per member
(`+2/−0`, `+0/−0.5`, `+free`), never `±`.** A symmetric tolerance on a member
whose freedom is one-sided looks right on paper and is discovered at assembly,
with the stock already cut.

(In the slip pump the column studs run up a socket bore that exits the top of
the head's cone — open air, so a stud cut 20 mm long simply pokes out and its
nut still turns. The rotor shaft ends inside the coupling under a `gap < -0.5`
assert against the motor shaft, where surplus is a collision. The studs are
therefore the compensator and every millimetre of doubt belonged on them. What
was handed over instead was two nominal lengths with a tolerance note; the
shaft came out slightly long and there was no stud length left to trade
against it.)

**Hardware changes as the design goes, and what it replaced stays visible.**
A superseded item stays in `ref/hardware/` as the record of what was tried,
marked so nothing can be built against it by mistake: the line
`SUPERSEDED <date> -> <what replaced it>` at the top of its file, and the current
designation in exactly one place — the constant `model.py` builds the mock from
and `checks()` measures against, which `ref/` and every message quote rather than
repeat. (One siphon changed identity four times — McAlpine A10 → Wavin 5V812 →
two article numbers — and asked for "the model of the siphon we chose" the agent
handed over the second of the four. Elsewhere a carbide drill bit, struck out as
useless in aerated concrete, was back in the parts list fourteen minutes later
out of sheer momentum. A SPEC and an AGENTS file rewritten an hour earlier both
named `DIN 933 M6×65`, a hex head, where the model was built around
`DIN 912 M6×20`, a socket head: the designation lived in three files, and the
two a buyer reads had drifted from the one the part was built from.)

**A picture the person sent is already on disk** — base64, in the session
transcript — so asking the person to save it for you is work you did not do. Pull
it out yourself, in the same turn, into `ref/`, name it for what it shows, and add
a line to `ref/README.md`: what is visible and what constraint follows from it.
(Asked outright to file five photographs into the refs, an agent answered "save
them yourself" while sitting on the file that held them; in another session the
same agent spent 41 minutes digging base64 out of other people's transcripts to
recover what had been lost.) Four things about the transcript you cannot work
out for yourself. It is under `~/.claude/projects/`, in a directory named for
the working directory with every non-alphanumeric character replaced by `-`;
your own session id is not in your context, so take the newest `*.jsonl` by
mtime, and no match means the slug is not what you guessed — list
`~/.claude/projects/` and find the one holding your work. It is one JSON object
per line and reaches 100 MB, so read it a line at a time. The images sit in the
`user` records **and** in the `type: "attachment"` records, whose
`attachment.prompt` holds what was pasted while you were working — often the
only place it appears, so `message.content` alone misses it. And a name taken
from `media_type` unedited carries the `+` of `image/svg+xml`, which refuses
the whole push by rule 1 below.

**`ref/measurements.md` is the log of raw measurements**: date, what was
measured, with what, the number. Every constant that CLAIMS to be measured cites
a line in it — `checklib.measured(v, "ref/measurements.md#screw")`, and the
build refuses the push when the file or the heading is not there. A constant
nobody measured says so with `checklib.estimated(...)` instead; what is refused
is the third option, a number with no statement about it at all. Most fits and
clearances start out estimated and that is honest — the starter template's
`LIP_CLEARANCE`, `BOSS_RELIEF` and `BOARD_CLEARANCE` all are. The word
"measured" in a comment with no line behind it is a lie written into the source.
(`thread_clearance = 0.30`, carrying the comment `# measured fit on the
printer`, was never measured: two ruined prints, 100 g of plastic, and the part
never worked.)

**That is the special case of a general rule: a justification is an assertion,
and it is checked like one.** "Measured", "in practice", "standard", "in the
usual case" each claim something the reader cannot see, and a claim with no
number, no line and no source behind it is worth less than no comment at all —
it is what stops the next reader from going to look. The failure is not
carelessness and does not yield to care: through a review, the most expensive
defect of each round sits not in the original work but in the edit written FOR
the previous round, and the commonest shape it takes is a smoother-sounding
general phrase written where the real measurement was lying right there in the
file. A figure taken off one build is a property of that run, not of the kernel
or of the process, and the sentence has to say which — write the number and
where it came from, or write that you do not know.

**A number the person hands you is their claim, not your measurement.** A
dimension in a comment, a figure typed into the chat, a size written on a
photograph — each arrives with somebody standing behind it and nothing at all
saying how they got it. They may have put a caliper on the thing, read a
datasheet, or picked what looked right, and those are `measured`, `derived` and
`estimated`: three different statements to whoever reads the file next, and only
the first of them earns a row in `ref/measurements.md`. Which one it is, is a
question for them and never a guess for you, so ask it in the same turn and
before the number reaches any geometry — what was it measured with, or where is
it written down. Answered, a measurement goes into `ref/measurements.md` with
the person and the date as its source, and `checklib.measured(...)` then points
at something real. Unanswered, it is an estimate and says so, which is honest.
What it may never become is a `measured` you assumed on their behalf — the same
lie as the paragraph above, written by a different hand.

**`ref/` is published with every build**, and two things follow. Its names obey
rule 1 below — ASCII, no `×`, no `Ø`, no Cyrillic — and one bad name refuses the
**whole** push, so a hardware designation goes inside the file and never into its
name (`ref/hardware/m6x30-din912-a2.md`, not `M6×30 DIN 912 A2.md`). And every
file in it counts against the push limits in rule 1, on every build, because the
tree is re-sent whole each time.

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

## What the printer does to your numbers

None of what follows is a property of geometry: it is what ONE machine was
measured to do — calipers on real PETG parts, 0.4 nozzle. So a constant that
carries one of these corrections is `checklib.derived(value, note)` and the note
says which correction it carries. `measured` is for a line in this project's own
`ref/measurements.md`, and nothing here was measured on your part.

| Feature | Comes out | Measured on |
|---|---|---|
| Hole | **0.22 mm under** nominal | Ø5.00 bore printed 4.78 |
| Straight wall | **0.18 mm under** nominal | a 4.60 D-flat printed 4.42 |
| Outside diameter | **0.20 mm under** nominal | Ø8.00 journal printed 7.80 |

Everything comes out smaller here, holes and shafts alike, and that cuts both
ways. A **hole** gains interference for free: a Ø22 bearing seat at zero nominal
clearance pressed onto a Ø22 608 exactly right, so a seat like that is not
"corrected" for shrinkage — the shrinkage IS the press fit. A **shaft** loses
it: the Ø8 journal for that same bearing printed 7.80 against an 8.05 bore, and
had to go to Ø8.35 nominal to land at 8.15. So `nominal = what you want
measured + the loss above`, and **do not carry over the common "holes shrink,
shafts grow" rule** — it is wrong on this machine and it gets the shaft
correction backwards, which is exactly how a journal ends up 0.25 mm loose in
its bearing.

Bias each correction toward whichever error is cheaper to rescue on a print that
came out wrong: a shaft 0.05 too fat is sandpaper, a round hole that binds opens
with a drill, but **a flat wall cannot be rescued at all** — leave that one the
loosest of the three. That is about rescuing a bad print, not about designing
against one: an operation nobody named still does not exist (above).

**The minimums below are the defaults for a 0.4 nozzle**, and nothing checks a
single one of them — the gate reads the layout of the bed, not the printing. A
minimum that matters on THIS part is an `assert` in `checks()`, where it fails
the build, rather than a number in a comment.

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

TPU wants larger clearances (~0.5 mm) because it flexes, PETG is stickier and
takes +0.1 mm on a fit, ABS shrinks 0.5–0.7 % so critical dimensions scale up.
For a fit that has to work on the FIRST print, use the measured offsets above
instead of any of this.

**The orientation you model is the orientation it prints in.** A view may not
re-orient a part onto the plate — the gate refuses that — so a part stands in
`parts()` the way it will stand on the bed, and Z is up, which is what
`checklib` assumes as well (`material_under_head` probes along Z,
`mating_face_flat` takes the height of the joint). Design around the overhangs
rather than around supports, keep a flat face down, and chamfer the bottom edges
rather than filleting them: a fillet on the bed edge needs support to print.
Write the intended orientation next to the geometry — nothing else records it.

**Fasteners: M3 is the standard, M2 is not.** Unless the part is genuinely tiny,
or it mates with bought hardware that dictates otherwise, use M3: M2 threads in
printed PETG strip almost immediately and buy back nothing worth having.

| | |
|---|---|
| Clearance hole | 3.4 |
| Self-tapping pilot, PETG/PLA | 2.5 |
| Socket cap head, DIN 912 | Ø5.5 × 3.0 |
| Countersunk, cross-recessed, DIN 965 | head Ø**5.6** max, cone depth **1.65** |
| Countersunk, hex socket, ISO 10642 / DIN 7991 | head Ø**6.0** nominal (5.81 max), cone depth **1.70** |

**Never type a countersink depth — derive it.** The cone is 90°, so
`depth = (head diameter − clearance diameter) / 2`, which in the model is a
`checklib.derived(...)` off the two constants above it; writing it out by hand is
how 1.5 gets into a part that needed 1.3. Cut it deeper than that and the head
never touches the cone at all — it lands on the sharp lip of the mouth and works
as a wedge splitting the plate.

**Name the standard next to the number, and say WHICH diameter it is.** The two
countersunk M3 heads differ by about 0.4 mm — DIN 965 is Ø5.6, ISO 10642 is
Ø6.0 — so a socket head dropped into a DIN 965 pocket stands ~0.2 mm proud, and
proud is not cosmetic when the face has to seat flat against a slide, a mating
part or a wall. DIN and its ISO "equivalent" are not one table either: at M4 the
head is Ø7.5 against Ø8.4. And one screw carries three published head diameters
— for ISO 10642 M3 you will find 6.72 (theoretical, to the sharp corner), 6.0
(nominal) and 5.81 (dk max, the real head) — of which only the last two describe
metal you can touch. So the designation in `ref/hardware/` names the standard
AND which of the three the number is. Beware the source, too: fasteners.eu
serves the DIN 7991 table under an address with ISO 10642 in it, which is how
the wrong pairing gets copied in the first place.

## CadQuery, where it bites

**Hollow with a boolean, not with `.shell()`.** `.shell()` is fragile: it fails
on tapered bodies, on lofts, on unions of several primitives and on anything
carrying many fillets. The pattern that holds:

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

Reach for `.shell()` only on a single simple primitive with one wall thickness
on every side.

**Fillet before you cut, and from the largest radius down.** A fillet on a clean
primitive succeeds; the same fillet on the edges left behind by holes, slots and
pockets fails or returns bad geometry. Chamfers likewise.

**Never wrap a fillet in `try/except` that shrinks the radius until it works.**
A fillet that fails is telling you the radius or the geometry is wrong — a wall
thinner than the radius, adjacent faces the fillet would degenerate — and the
`except` publishes a part whose radius nobody chose, with a log saying the build
passed.

**Give a cut meant to pass just through a face 0.01 mm of overshoot.** Coplanar
faces are where invalid, non-watertight bodies come from, and the build log is
where you see it (`valid, volume … cm3, watertight, one body`). Fix the boolean;
there is nothing to paper over it with here.

**`centered=(True, True, False)` on `.box()`** puts the bottom at Z = 0, so
`.faces("<Z")` is the bed and the part sits where the checks expect it.

**`.hole()` cuts through the whole part** by default; `.cboreHole()` and
`.cskHole()` are the counterbore and the countersink.

**A positive `taper` in `.extrude()` narrows the shape**, a negative one flares
it out — the opposite of what most people expect, and silent either way.

**`.loft()` is fragile.** Between a profile and a scaled copy of itself use
`.extrude(taper=…)`; keep the loft for genuinely different profiles, a circle
into a rectangle.

**A screw boss is pushed, drawn and extruded — and only then drilled**, so the
hole is cut in the boss rather than through the wall it stands on:

```python
.pushPoints(SEATS).circle(BOSS_OD / 2).extrude(BOSS_H)
.pushPoints(SEATS).hole(SCREW_D + FIT_CLEARANCE)
```

## The contract with model.py

The template `create` unpacks is the live example — read it rather than this
section: a working model with the rules written next to the geometry. In short,
`model.py` defines `parts()` and `views()`, may define `checks()`, and may
`import checklib`.

* **`parts()` — the catalogue, and the one place geometry lives.** A non-empty
  dict of records: `{"lid": {"shape": <CadQuery object>, "kind": "printable"}}`,
  with `color` and `note` optional. **The key IS the part's identity** — the
  stem it is exported under, the row the viewer's tree shows, the name every
  view points at, what it is filed under in `meta.json`. There is no display
  name beside it, deliberately: a second name is a second identity to keep in
  step with the first. A key is letters, digits, dot, dash and underscore,
  starting with a letter or a digit, up to 128 characters; `assembled` and
  `print` are refused, because the build keeps those two stems for the assembly
  and for the plate. A key inside a record that the build does not read — a
  misspelt `colour` — is a warning rather than a refusal, and the part is
  painted by its KIND as if you had written nothing: the palette for a
  printable, dark grey for hardware, light grey for a mock. A misspelt `colour`
  on a screw therefore leaves it grey, not in the colour you wrote.
* **`kind` is required and has no default**, and it decides what the build does
  with the entry: `printable` is exported and gets download buttons, `hardware`
  is bought and goes into the product (a screw, a bearing, a heat-set insert),
  `mock` is only there so the picture makes sense (the wall the bracket bolts
  to, the barrel the frame stands in, the board the case closes over). There is
  no default on purpose — one would put download buttons under a mock of a
  bought bearing. At least one entry has to be `printable`. Colour follows the
  kind unless the record names its own: a palette entry for a printable, dark
  grey for hardware, light grey for a mock, so a glance at the picture says what
  is being printed and what is not. The palette entry is chosen by the KEY, so a
  part keeps its colour while the catalogue around it is edited.
* **`views()` — tabs made of REFERENCES into the catalogue.** A list of
  `{"id", "name", "parts": [...]}`, where `name` is the caption in the picker
  and falls back to the id. **A view carries no geometry of its own**, so it
  cannot show a part the catalogue does not have and cannot show a look-alike in
  place of one. Each entry of `parts` is written as:
  * `"lid"` — the catalogue key: the part exactly as the catalogue holds it;
  * `{"part": "pin", "at": cq.Location(...), "alpha": 0.6}` — the same part,
    placed. `at` is a rigid motion the build applies to the catalogue's own
    solid; `alpha` runs 0..1 and is 1.0 unless you say otherwise;
  * `{"part": "strap", "shape": bent, "deformed": "clamped round the pipe"}` —
    the one way geometry reaches a view, for a part that is genuinely a
    different shape in place. The reason is required, it is printed into the
    build log, and it is refused in `print`;
  * `{"group": "housing", "parts": [...]}` — a group, and groups nest. It is
    presentation and nothing else: **no gate sees a group**, every one of them
    reads the flat list of leaves. Its name obeys the key rule and may not BE a
    catalogue key. There is a ceiling on the nesting and it is a REFUSAL, not a
    trim: 64 levels, which no assembly a reader could follow comes near — a
    group is how a person is shown the assembly, not a place to hide depth in.

  One part may be referenced as often as you like — five pins are five
  references to `pin`.
* **Two view ids carry the gates.** **`assembled` is required**: it is what the
  product is judged by and the only view the build counts parts from, and
  **every `printable` key has to be named in it**. A reference at alpha 0 does
  not count — a part nobody can see is not shown. Nothing in it may occupy the
  same space as anything else unless the view says why:
  `"interference_ok": [("nozzle", "seat", "threaded joint")]`, triples, read
  only here, the reason required and printed in the log. A `mock` is scenery and
  is never asked about — the wall overlaps by construction — but **`hardware`
  is**, and that is the case the mechanism is for: a screw's thread biting into
  its printed hole is an overlap you declare, with a reason.

  **`print` is optional and is the bed.** Only printable parts may stand on it —
  `print.stl` is a file somebody opens in a slicer, and a bought part on it is
  an offer to print the thing that was bought. `at` there may move a part and
  turn it about Z, and that is all: a tilt re-orients the part, and a MIRROR of
  a chiral part is a different part from the one published under that key. No
  two parts may stand inside one another, unless the view says the pair really
  is nested: `"nested_ok": [("shim", "ring")]`, pairs, read only here.

  An exemption in either list names two CATALOGUE KEYS, so it covers every
  instance of that pair at once. There is no way to exempt one reference and not
  another, and that follows from the shape of the declaration rather than from
  an omission: a reference has no name of its own to point at.
* **`"note"`, an optional key on a catalogue record** — `{"shape": screw,
  "kind": "hardware", "note": "M3x8 DIN912"}`.
  It is the AUTHOR's note — written in the model, published with the build,
  shown beside the part to whoever opens the model in the browser. Not the
  reader's note (that one is theirs, lives in their browser and never comes back
  here) and not a comment (written by a viewer, queued, addressed to you). Put
  in it what the geometry cannot say: the catalogue name of the screw, a link to
  the datasheet, the fit that was taken, why a number is the number it is. One
  line, not documentation. It is **plain text always** — a link in it is not
  clickable, nothing in it is parsed, and a `<`, a `>` or a control character is
  refused by the build, and by the hub again on the way in. At most 200
  characters, and a catalogue holds at most 200 records. An empty note is an
  error rather than "no note" — a part there is nothing to say about leaves the
  key out. **The note belongs to the part**, and since the part exists once, so
  does its note: the same part shown in five views carries one text, and there
  is nothing to keep in step.
* **What a `printable` record owes.** Each becomes `<key>.stl`, `<key>.step`
  and `<key>.3mf`, and **each is one fused body**. The gate reads `.val()`, the
  first body on the stack and only that one: it alone is validated, measured,
  written to the STL and rendered, and the log's `valid, volume … cm3,
  watertight, one body` is about it. So a Workplane holding several unfused
  bodies — `plate.add(bosses)` — publishes green with everything after the first
  missing from that part's own STL and preview, while the 3MF and the STEP are
  written from the whole object. `pushPoints(...).box(..., combine=False)` is
  worse: it REPLACES the stack, so the base itself is the body that goes
  missing. `assembled.stl` is glued from every body of every leaf of the
  `assembled` view, so `assembled.stl: N parts` in the log, `N parts` in that
  picture's
  footer, counts bodies: more than the view should hold is a printable not fused (a
  plate with three bosses added logs `volume 9.60 cm3` and `4 parts`; with them
  replacing it, `0.22 cm3` and `3 parts`). Only the other half is refused, one body
  in disconnected pieces: `N disconnected pieces, not one body`. Fuse the
  part, or give each piece a catalogue entry of its own. **Each part is built
  in the orientation it is printed in, and the `print` view moves copies of it
  into place**: the orientation that counts is the one on the bed, not the one
  in the assembly — which is why `at` on the plate may only turn about Z.
  Nothing checks which way up you built it; a part modelled upside down
  publishes green, and the one thing that catches it is the render below, which
  you fetch yourself. Where a check measures a part against a bed, that bed is
  nobody's real machine until somebody says which machine this is for — a part
  that outgrows it is the moment to ask, and to put that printer's volume in.
* **`checks()`** — optional, and the place for everything specific to this part:
  fits, clearances, hardware, bed size. It fails by `assert cond, "why"` or by
  returning a list of problem strings. A `checks()` that provably contains no
  check fails the build, because a log saying "checks passed" for a function
  that looks at nothing is worse than no function at all.
* **`import checklib`** — reusable geometry checks, none of which runs unless
  you call it. Assembly: `pairwise_interference`, `mating_face_flat`,
  `material_under_head`, `swept_clearance` (does a moving part sweep through a
  fixed one), `tool_access` (does a driver reach that screw and turn there).
  Manufacture: `unsupported_area` (how much of a part hangs over nothing at the
  orientation it prints in), `thin_walls`, `minimum_feature` (the smallest thing
  this nozzle can put down). The fast "is there material at this point" probe is
  `material_at`; `volume` and `is_empty` say whether a boolean left anything at
  all (`assert wp.vals()` cannot answer that — it is true of an emptied body);
  and `section` marks a stretch of `checks()` so the build log prints what it
  cost. `check` is the odd one out: it registers a check as a unit the hub runs
  in a worker of its own rather than measuring anything itself (see «Keeping
  checks fast enough to run»). Every one of them reads EVERY body of the part it
  is handed — including
  a part assembled with `.add()`, whose bodies may touch or sit inside one
  another — rather than whichever body happens to be first. The module lives
  inside the hub's image; there is nothing to install and nothing to vendor.

Those are all that `checklib` offers, and the gate is all of
the hub. Read the two sentences above together: an overhang, a thin wall and a
driver that cannot reach a screw all have a helper now, and NOTHING calls any of
them for you — a model that never mentions `unsupported_area` publishes green
with a face hanging in the air. Where a number CAME FROM is the one exception,
and it is
checked strictly — a module-level float with no `measured`, `derived` or
`estimated` around it stops the build (above). Every rule in the next section is
a check you write yourself or something you go and look at. Of the BED the gate
reads the layout and not the printing: parts standing inside one another — by
more than 0.05 mm on all three axes — refuse the build, and so does a view that
re-orients a part onto the plate, but the air between parts, how much of each
sticks to it and whether any of it fits the machine are read by nothing. A
picture is what answers that, and there is one of the bed.

**The `print` picture is the cheapest check there is, and the only thing that
shows the BED.** A build renders one isometric PNG per printable, one of the
stem `assembled` and one of `print`, and no tab you add gets a picture. (It also
writes a `<stem>_card.png` beside each of the last two — the same frame with the
title and the footer cut off, drawn for the tile on the hub's front page. It
carries none of the facts below, so it is not the picture you look at, and
`artifacts` does not bring it down.) `print_preview.png` is what a part lying
face down, standing on edge or
hanging off the plate looks like, and no gate reads any of that: look at it
after every build that moved a part or a view. (A project with no `print` view
has no plate, so no `print.stl` and no picture of one; the build says so in a
line of its own.) Each picture comes off that stem's own STL, so a part's
preview shows exactly what will print, `assembled.stl` is glued from the
`assembled` view, and `print.stl` is the bed as it is laid out. Under each
picture is
a footer: `Bounding box: 60.0 x 20.0 x 6.0 mm`, the triangle count, and
`watertight` — which on a plate or an assembly reads `N parts`.

**One way to a picture.** `hammerola artifacts <build>` brings every picture
worth looking at into `.hammerola/` — the per-part `<part>_preview.png` ones
included, the front page's cards excluded — along with the parts' STL/STEP/3MF
and the two whole-build meshes
(`assembled.stl` and, where the project has a `print` view, `print.stl`). It
takes `dev` and `latest` as well as a revision, so it works straight after a
`build`. Do not assemble a picture's URL by hand: the command asks the build
what it published and fetches that, so a file that is renamed goes on arriving
while a hand-written path stops. You can read a picture and the gate cannot.

Shape is otherwise judged in the browser viewer, and **a size comes back three
ways**: that footer, `metrics.json`, and the build log. The second
sits in the same build directory and is served as plain JSON, so
`curl <hub>/project/<pid>/dev/metrics.json` gives `bbox_mm` for every PRINTABLE
straight after a `build`, with no commit. Printable and not part, and the
difference is the catalogue's: measuring is done on the way out of the exporter,
so a `hardware` or a `mock` record is measured nowhere and appears in that file
not at all. **The log carries the sizes too, and that is new** — on top of the
gate's per-printable `valid, volume … cm3, watertight, one body, N triangles` a
build now prints what it measured, one line per part —
`<part>: … cm3, …x…x… mm, first layer … mm2, overhang … mm2` — with
the assembly's own line under them, and — when the project has a previous `dev`
build — a `metrics vs dev:` block saying what moved since it. So a `print()` in
`model.py` or `checks()` is for what the build does NOT measure: a clearance, a
wall thickness, the one gap this round is about. Printing a bounding box from
`checks()` is now a second copy of a line the log already has. The log is
what `commit` keeps, while a picture and a `metrics.json` have to be fetched. That
log is the child process's stdout and stderr merged and kept to the FIRST 1 MiB — a
flood loses its tail, not its head — so print short and early. `hammerola diff
<old> <new>` reads the same file over the same public URL, takes two *published*
revisions (it refuses `dev`) and prints only the numbers that moved.

## Checks that actually check

**Measure the solids rather than restating the constants that drove them.** A
check that repeats the arithmetic passes for the wrong reason, and it goes on
passing after the geometry has drifted away from it — it is the single most
expensive habit in the reviewed sessions. A constant compared against a constant
is not a check at all. (`assert DOWEL_SEAT_CLEARANCE >= 0.3` is a constant
checking itself. It passed two reviews, and both end screws fell out of the
printed part.)

**An assert you cannot make go red is decorative.** Name the geometry that
reddens it and make it red once, while you are writing the check — that is part
of writing one, not a round of edits on the part. Reading the code is what lets
this class through: the tautology is in the arithmetic, never in the wording.
(The trap was caught four times in one file in a day, the fourth inside an
assert written against the third — "the cone must open outwards" could not fail
for any shape of cone. What caught the others was breaking the solid on purpose:
a 20 mm drill jig, where the design says 48, passed the check whose entire
subject was its length.)

**When a check goes red, either the part is wrong or the check is — and which
one is a decision made out loud, never by reflex.** The cheapest move is always
to nudge the model until the complaint stops, and it is the one that destroys
the instrument: the log goes green, the part stays wrong, and that check is
decorative from then on. The tell is mechanical, and it is the same question as
"a round of edits that moves no physical number is not started" further down —
name the physical quantity your edit moved. If the answer is "none, but it
passes now", you edited the instrument and not the part. (A nozzle's Ø9.35
thread interfered with its Ø8.43 seat, correctly. Rather than fix the fit, the
nozzle in the assembly was swapped for a stand-in turned down to the thread's
root diameter, which slid through — the check went green, and the model of
record stopped being the thing that gets printed. `assembled.stl` is glued from
the assembled view, so the downloadable assembly was made of the stand-in too.)
A view is a list of references now, so it cannot quietly hold a second solid: the
one form that carries geometry has to say why, and the reason goes into the build
log. That leaves the swap one place to happen — the catalogue record itself,
where the stand-in becomes the part, and its own downloadable `.stl` with it. And
the overlap the stand-in was made to silence is what the assembly gate reports:
declare it with a reason, or fix the fit.

**Four traps in the CadQuery API itself, and every one of them makes a check
silently GREEN rather than red.** None raises, so the price is never a failed
build — it is a check believed to work for years. Measured on cadquery 2.8.0:

* **`.vals()` is true whether or not anything survived a boolean.** A Workplane
  after `intersect` holds a list of one `Compound`, empty or not, so
  `assert wp.vals()` cannot go red — `bool(vals)` was `True` at a total volume
  of `0.0`. Ask for the volume. (In one model that assert counted as a live
  check for months, and the line under it read the bounding box of an empty
  compound.)
* **`BoundingBox()` on an empty solid raises** `Standard_Failure: Bnd_Box is
  void` — the only loud member of the family, and only if you get that far.
* **A body a boolean emptied answers as its previous self.**
  `Workplane.intersect` calls `findSolid(searchParents=True)` and fetches a
  solid out of the parent chain, so the emptying is invisible one line later: a
  body of volume 8000 emptied to 0.00 answered the next `intersect` with a
  4×4×4 probe with **64.00 mm³** — the probe's whole volume, exactly as if the
  body were intact. The same question put to a bare `Shape`, which has no
  parent chain behind it, raises `ValueError: Null TopoDS_Shape object`.
* **A point classifier on a body with no solids in it answers IN everywhere.**
  probe(0,0,0), probe(1000,1000,1000) and probe(−50000,30000,7000) all came
  back IN, so a part that quietly came back empty greens every
  `assert solid(...)` in the file. Here the kernel now covers you:
  `checklib.material_at` — the point probe below — refuses loudly on a body
  with no solids in it. That guard is new: it was not there while the traps
  above were being found, so a check written before it may have been passing on
  nothing.

All four are found by one question, and it is the cheapest one to put to a
check, to a review round and to your own last edit: what does this do on the
input that should FAIL, rather than on the one that passes? Every trap above is
an answer to it.

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
estimate is DECLARED as one rather than avoided. `checklib.estimated(v, "what
would settle it")` builds, drives geometry like any other number, and is the
right answer for most fits before anything has been printed — most of the
starter template's own numbers are estimates, and they drive its geometry. What
an estimate must never do is be quoted back as though it were a measurement.
Each estimate prints an `estimate:` line of its
own in the build log and travels into `metrics.json` with its note, so a
`commit` keeps both and `hammerola log <revision>` still has the log. Estimate
from a `build` and the note is in the dev slot's `metrics.json` like any other
number's; it is the LOG that lives only at that build's job, addressed by an id
rather than by the slot (below). (43 minutes of argument about sediment washout
in which both sides were estimates: the velocity differed by 5.5×, the threshold
had a 3× spread. Neither was labelled — that is the failure, not that they were
estimates.)

**A number is quoted against what reproduces it.** Below what the process holds,
a difference stops being an argument about the part: an FDM machine lays layers
0.1–0.3 mm thick and puts down a bead about 0.4 mm wide, and no print tells
0.003 mm from zero. A number that small can still be load-bearing — but then it
is not a tolerance of the part, and the sentence has to say what it IS a
property of: the CAD kernel, the machine, the step of the knob. State the
consequence in the same terms, in what the person sets rather than in the
quantity you were computing. (An agent defended a constant by the 0.0034 mm of
clearance it left and got "how much? do you know what the accuracy of printing
is?" back. The real quantity was the ~30 µm at which the boolean silently
stopped cutting, and the whole decision was worth one position out of 91 on a
knob that steps 0.5 mm.)

**A printed pair that has to move relative to its partner — a thread, a sliding
fit, a snap, a hinge — is never printed whole the first time.** First a gauge: a
stub of the pair as a ladder over the clearance, each step with its number
embossed on it, then the full part once a human has printed it and said which
step works.

**The gauge is a commit of its own, and never a part of the product.** A person
prints it, so it is committed like anything else a person prints: the link they
work from has to outlive the next push. It comes before the product does — the
clearance is not chosen yet, so neither is the part that uses it — so the
catalogue holds the one gauge, `assembled` shows that same gauge, `print`
stands it on the bed. That passes the view gates whole; no view is deleted or
bent around a part that is not the product. `latest` sits on the gauge until the
part that uses its number is committed, and the project's card shows a ladder of
steps meanwhile: that is the price, and it is smaller than handing over a link
that dies under the person holding it.

The ladder is one fused body — the steps on a common base, the embossed digits
unioned to it — for the reason under the catalogue; fetch `<gauge>_preview.png`
and count the steps in it, where a ladder of separate boxes shows up as one
step. `checks()` is rewritten for the gauge, a check per step measured on the
solids, and the reason is that nothing will make you: `run_checks` looks up the
function named `checks` and knows nothing of `parts()`, while the product's
`checks()` builds its parts by calling the builders, which cutting the catalogue
down to the gauge leaves alone. So it runs to the end and the log says
`checks: N passed` about parts the build has not got. (Measured on the starter
model: the catalogue cut to the one gauge, `assembled` and `print` rewritten to
reference it, `checks()` left verbatim — the build went green and the log said
`checks: 12 passed`, every section of it but the last one measuring a box and a
lid the catalogue no longer held.) Only a `checks()` that indexes the
catalogue by key refuses by itself. The rest holds — a gutted one
fails the empty-checks gate above, no flag skips checks, and deleting it passes
and throws away every complaint ever turned into an assertion — so commit the
product's `checks()` to git first: the revision the hub keeps is the GAUGE's
file, with the product's `checks()` already swapped out of it, so
`hammerola source <gauge>` brings back the gauge's checks and not the product's.

The person prints it and names a step, the number goes into the part, and the
next commit is the product. The gauge's revision stays where it is — the record
of what was printed and which step won — and nothing overwrites it.

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

## Keeping checks fast enough to run

**A build has five minutes of wall clock, and running past it is not a
polite refusal** — the build is killed mid-run and what comes back is a timeout
instead of an answer. Geometry is rarely what gets there; `checks()` is, because
it is the part that grows every time the part teaches you something.

You will usually have no way to time this before pushing: the CAD kernel lives
in the hub's image, so a model that imports `cadquery` does not necessarily run
anywhere else at all. Do not calibrate against whatever machine you are on —
calibrate against the hub, which now tells you. After every `build` and
`commit` that actually rebuilt something, under the log, the client prints one
line off the hub's own clock:

```
built in 4m12s (queued 8s)
```

The first number is your build. The second is time your push spent waiting for
a free worker and is nothing to do with the model; it is absent when there was
no wait. **Past three minutes the same line is followed by a warning** naming
the fixes in this section. The warning is not a refusal — a slow build
publishes exactly like a fast one — and it is not printed for a build the hub
killed on a ceiling, because a timeout has already said what happened. A push
the hub answers with `unchanged` prints no line at all, and that is not a fault:
nothing was rebuilt, so there is no build to report a time for. Otherwise the
number arrives by itself, so calibrate a change against the build before it
instead of guessing at what the fix bought.

**Four clocks run over one push, and the one that stops you first is your own.**
The hub kills a build at 300 seconds of wall clock. It runs four builds at a
time, so a queue in front of yours is time before your build starts, and the
client waits out both — its own ceiling is 2700 seconds and you will never see
it (`--timeout SECONDS` on `build` and `commit` moves that one, and nothing
moves the hub's 300). That first number was 900 until the heavy models moved
their measurements into check units, which are killed one at a time on a budget
of their own. The
warning at three minutes therefore leaves far less room ahead of the ceiling
than it used to, and is worth acting on the first time it appears rather than
the third. What you WILL see is the timeout on the tool you launched
`hammerola build` with: a shell call that defaults to two minutes cuts the
command off around the time a heavy model is getting started, with most of the
build's wall clock still ahead of it. The build does not die with it — it goes
on in the hub, finishes, and publishes — but the log was on that command's
standard output, and it is gone. So run a push you expect to be slow with the
timeout raised well past the hub's own ceiling, or in the background. Twice, in
transcripts, the output of a finished build was lost exactly this way.

**When it does arise anyway, mark `checks()` up with `checklib.section("...")`
and let the hub say where the time went.** It is a context manager around a
piece of the function; the hub prints the table itself, on a FAILED build as
well as on a green one, so the marks are the whole of what the model owes.
Measure before you cut anything: in the model that prompted this the checks
phase ran 495 seconds and 52% of IT sat in ONE loop inside one section — no
split by build phase would have shown that — while the check named beforehand
as the main suspect measured 8.9 s against the ~150 s it had been predicted at.

**The shape of a boolean is measured and not read about, because the sign of
the effect changes with the geometry.** On one model a single `Common` against
a compound of 13 bodies came out five times dearer than cutting the 13 bodies
one at a time — and the geometry it was measured on was never written down,
which is half the lesson by itself. The same experiment on 13 plain boxes
against a long bar came out the other way round: 0.020 s as the compound
against 0.062 s one at a time, three times CHEAPER. There is no rule in that
pair, and none worth taking from anybody else either: put both forms of your
question behind a section mark on your own geometry and read the table.

None of what follows is a reason to check less. All three are the same check,
written so it costs what it should.

**Ask about a point with `checklib.material_at`, never with a boolean.** "Is
there material here" written as `body.intersect(small_cube)` costs milliseconds
to tens of milliseconds; the point probe costs microseconds. A scan along a
channel or a grid over a seat is hundreds of those, and on the model that
prompted this it was the single largest line of a 495-second check run.

```python
solid = checklib.material_at(body)          # once, not per point
for z in range(...):
    if not solid(x, y, z):
        problems.append(f"the wall is hollow at z={z}")
```

**They are not the same question, so move your points when you switch.** A
0.6 mm cube reaches 0.3 mm in every direction — it answers about a
*neighbourhood*. `material_at` answers about the *point*. Away from surfaces
they agree exactly; within that reach they need not, so a probe grid written to
sit right against a face will flip answers when ported. Put each point where
material is *required* — half a millimetre inside the wall, not on it — and the
question becomes the one you meant either way. A probe is bound to the shape you
took it from: take a fresh one after a transform or a rebuild.

**A scan step is a price, and you set it.** Halving the step doubles the run,
and a scan nested inside a sweep of angles multiplies instead of adding: nine
checks in one model, stepping 0.02–0.1 mm across 18 angles, put 156 seconds on
a build on their own — the same model went from 15 seconds at 58 checks to 171
at 67. Pick the step from what the check has to resolve, not from what looks
careful: a scan that would catch a 0.3 mm ledge does not need 0.02 mm, and if
you cannot say what the smallest thing you are hunting is, the scan is not yet
a check.

**A `while` walking a coordinate must be able to reach its end, and you have to
be able to say why.** The loop that steps until it leaves a face, or until the
material stops, ends only if every branch moves the coordinate — and one that
does not does not fail: it holds the whole build until the hub kills it, and
what comes back is a timeout naming nothing. Four builds were lost that way to a
single `while` in one edge-walking helper, 891 seconds each. Prefer a `for` over
a range you computed up front, which cannot do this at all. When it really must
be a `while`, bound it by a count as well as by the condition, and make the
check fail loudly when the bound is what stopped it — a silent bail-out turns a
runaway loop into a check that passes.

**Split `checks()` into units and the hub runs them at the same time.** A check
marked with `@checklib.check` is a UNIT: the hub queues it and drains the queue
across two worker processes, so two checks run at once instead of one after the
other. Nothing else changes — a unit still fails by `assert cond, "why"`, still
appears in the timings table under the name you gave it, and the function is
returned unchanged, so `checks()` can still call it directly.

```python
@checklib.check("lip joint", needs={"body": build_body, "lid": build_lid})
def check_lip_joint(body, lid):
    assert lip_overlap(body, lid) > MIN_LIP, "lip joint too shallow"
```

`needs` maps this check's OWN parameter names to the builders that produce those
arguments — the two lines a `checks()` opens with (`base = build_base()`) are
literally what becomes one `needs`. It is not a selection out of `parts()`:
the catalogue is computed whole, so naming a part of it would build every part.
Everything is verified at the `@` rather than at the call, because the call
happens in another process — a `needs` key naming no parameter of the function
would otherwise surface as a bare `TypeError` out of a worker on a build that
has already spent its geometry phase.

**A unit has its own budget: 120 seconds, enforced by killing the worker.** That
is the point of the split for a check that hangs — one runaway costs one worker
and two minutes, and the rest of the queue drains on the other, where before it
cost the build's whole five-minute wall clock and came back as a timeout
naming nothing. The log's verdict line is a count: `check units: 4 passed` when
they all pass, `check units: 3 of 4 passed` when one does not.

**Two things read differently once checks are units.** Section rows sum across
workers, so the table's total can exceed the phase's wall clock — that is the
parallelism showing, not a bug. And a builder cached with `@cache` is cached PER
WORKER: each worker imports the model once and builds what its own units ask
for, so a part needed on both workers is built twice. That is the price of the
split and it is usually small against what the split buys, but it is why the
caching rule below still matters rather than being made redundant by it.

**Build each part once per `checks()`.** Builders are pure functions of the
constants at the top of the file, and `checks()` typically calls four or five of
them from a dozen places, rebuilding the whole assembly every time. One
decorator ends it:

```python
from functools import cache

@cache
def build_lid():
    ...
```

Worth about a fifth of the run on a model of any size. It is safe because
CadQuery operations return new objects rather than mutating in place — but if
you ever mutate a builder's result, do not cache that builder.

**The one in-place change that does happen is not yours: triangulating a shape
leaves the mesh on it, and `BoundingBox()` then measures the mesh.** A cylinder
r=5 h=10 read `zlen` 10.000000, and 10.003108 after `mesh(0.1)` — which is also
what the tolerances the hub meshes with give it. The FLAT Z axis grew, so this
is not the chord of an arc; the box simply reads bigger.

Past that direction, carry no number away from here and take none off a mesh of
your own. The angular tolerance moves the figure strongly. The axes do not move
together either: at that same setting the Y axis did not shift AT ALL while X
and Z both went to 10.003108, because what grows, and by how much, is settled
by where the triangulation's vertices happened to land. That one figure is
quoted because two independent runs agreed on it — the rest of the sweep it
came from did not, a second person on the same version of the kernel getting a
different number at one of its settings, with neither side finding out why. So
a bounding box read off a meshed shape says something only with the shape, BOTH
tolerances and the AXIS named beside it, and even then it is a fact about one
machine. The direction is what survives all of that, and it tells in
both signs of the answer: "does it fit the printer" can go falsely red, while a
clearance reads tighter than it is and an inequality whose grown side is the
weak one buys itself slack and passes without a word.

The hub drops the triangulation after each export it performs, which is what
keeps the catalogue and `checks()` measuring the same part. Two things it does
not cover, both of them yours. A `@cache`d builder hands the SAME object to
every caller, so a mesh or an export of your own moves what the next reader
measures — in the run above, the first reader of the cached cylinder got
10.000000 and the one after that mesh got 10.003108, off a line somewhere else
in the file. And copies do not share alike: `translate()` builds a fresh TShape
and stays clean (10.000000 beside a meshed original, and clean too when the
copy is taken after the `mesh()`), while `.moved()` and `.located()` share the
original's TShape and read 10.003108 with it. So cache the builders — and do
not mesh or export inside `checks()`.

**Do not pre-filter pairs before `checklib.pairwise_interference`.** It already
rejects pairs whose bounding boxes cannot touch, before doing any boolean.
Hand-written filtering in front of it buys nothing and can only remove pairs the
check was meant to see.

**If you profile, use a sampling profiler — or the section marks above.**
`cProfile` reports almost nothing here: the CAD kernel spends ~89% of its time
in a thread pool that a profiler watching the main thread cannot see, so the
ordinary tool will tell you the build is fast while it is actually slow. A
wall clock around a labelled block cannot be fooled that way, which is the
second reason to mark the sections up.

## Four rules that break a push, in the order they bite

**1. File names.** Every component of every path in the project must match
`[A-Za-z0-9][A-Za-z0-9._-]{0,127}` — ASCII only, first character a letter or a
digit, no leading underscore, no spaces, no Cyrillic. One bad name refuses the
**whole push**, not that file, so `детали.py` or `My Model.py` next to
`model.py` stops the project publishing at all. Rename them. The alphabet is
deliberate and is not relaxed: it is what makes a path inside the archive
incapable of naming anything outside it. Hidden entries (`.git`, `.env`,
`.venv`) are dropped instead of refusing it, so a normal repository publishes
fine. A path is at most 8 components deep, a push carries at most 1024 files,
and the tree is at most 64 MiB unpacked — the client says "67 MB", counting in
millions, and that ceiling is only its default: a deployment may set its own,
and its 413 carries the real number.

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

**The part is finished when its numbers stop moving.** A build that prints the
same measurements as the one before it is the signal, and the build now says so
itself: after the first `build` of a project the log carries a `metrics vs dev:`
block near its end, and `every measured number is the same (N part numbers
compared)` is that signal
in one line — no reading two logs side by side, and the count is there because
silence would be indistinguishable from a comparison that never ran. A second
such build in a row means the rounds have left the part
and moved onto the instrument that measures it and the prose around it. Say it
can be printed, and stop. (Asked "so, can it be printed?", an agent said no and ran
three more review rounds over 2 h 18 min. The first was paid for — it found a
joint that would not have assembled. Through the other two the part's three
measured numbers were identical from build to build, and the person ended it
with "what are you digging at, enough".)

## When a build fails

`build` and `commit` print the build log as it happens; that log is the whole
account of what went wrong. Read it from the top — the gate refuses in a fixed
order, so the first complaint is the real one and nothing after it ever ran.
The `built in ...` line comes after the log here too: a build that died in its
twelfth minute is exactly the one whose time you need.

```sh
hammerola log            # the newest published revision's log, again
hammerola log <revision> # that one
hammerola log dev        # the last build's log, whether or not it was committed
hammerola status         # what the hub has: latest, whether dev is occupied, the revisions
```

`status` lists the newest handful of revisions; `-n COUNT` (`--limit`) widens
that when the one you are looking for is further back than the default.

**Never rebuild to read a log you have already produced.** `hammerola log dev`
answers with the log of whichever push last filled the slot, and it says in its
header which push that was — a `build`, or the commit that copied itself in. The
slot records the id of the job that built it, and jobs are kept forever: no
retention by age and none by count, so the log of a build is readable for as
long as the slot points at it. A rebuild costs the whole build again and can
only produce the same text; in one set of transcripts 41% of pushes carried no
edit at all, 27 minutes spent re-earning output that was already on the hub.

Two things it does not reach. The SOURCE of a `dev` build is still not kept —
only a revision has one, and `hammerola source dev` refuses. And a slot filled
before the hub started recording the job says so plainly; one `hammerola build`
fills it again with the field.

What each kind of failure means:

* `build failed: ...` — your model or a gate said no; what it names is in `model.py`.
* a traceback — `model.py` raised. The frame at the bottom is yours.
* `timeout` / `cpu_exhausted` — the build ran past its ceiling. Usually a
  boolean operation on geometry that got out of hand.
* `413` / `422` on the push — the tree breaks rule 1 above, by its size or by
  one of its paths. Neither reaches a build.

**When the thing that is wrong is your own `checks()`, `--force` publishes
anyway.** `hammerola build --force` and `hammerola commit --force` skip the call
to `checks()` and nothing else: the hub's own gates — provenance, the catalogue,
the print layout, interference, the per-part export checks — all still run, and
a build that breaks one of those is still refused. The log says `checks: not
run` where the verdict would be, and the metrics record the check count as
unknown rather than as zero, so a forced build never looks like a passing one
later. Use it when your check is wrong, slow or asserting something you already
know to be false — not to get past a check that is right. The next ordinary push
runs them all again.

## Fetching things back

```sh
hammerola source <revision>     # the code that produced it, into .hammerola/
hammerola artifacts <revision>  # its STL/STEP/3MF and pictures, into .hammerola/
hammerola diff <old> <new>      # what moved: geometry numbers, and the source
```

`source` and `artifacts` are two commands over one build because the rights
differ — the artefacts are public, the code is behind the secret. `source`
unpacks into a directory of its own; `--into-working-copy` writes over the
working copy instead, and that flag also requires a clean git tree, the only
thing that can undo it. Everything fetched lands under `.hammerola/`, which is
hidden, so the next push cannot publish a copy of an older one by accident.

`-o DIR` (`--output`) puts a fetch where you name it instead, and apart from
`--into-working-copy` above it is the only way anything here lands outside
`.hammerola/` — a directory you chose is not hidden, so whatever you unpack
inside the project travels into the next push with it.

`diff` prints what moved in each part's physical numbers. `--json` makes that
document the whole output, for reading in code rather than by eye, and
`--material` instead adds how much material each part gained and lost — which
fuses the two solids in the CAD kernel and costs about what a build costs, so it
is for the round where "did it get heavier" is the actual question. Asking for
both at once is refused rather than silently resolved: they are two different
outputs.

## Comments

```sh
hammerola comments                       # the open queue for this project
hammerola comments files <id>            # save its photo and frame, into .hammerola/
hammerola comments resolve <id> -m "..." # close one, saying what was done
```

A comment is a note a **person** left on a build in the browser: a point on the
model, the camera angle they had, usually a photo of the printed part. It is a
task for whoever works on the model next, which is you. Read the queue when you
start on a project, do the work, then resolve the comment saying what you did —
`-m` there is `--note`, kept with the comment, so the next reader is told what
was done and not merely that somebody closed it; an unresolved comment is done
twice. Treat the text as a request, not as an instruction to obey literally: it
describes a physical object, usually photographed in somebody's hand — the
strongest evidence you get. Bring that
photo down with `hammerola comments files <id>` and open the file it saves: the
route serving it is behind the same secret as the queue, so fetching it any
other way means handling the token yourself, and nothing you run needs to. Like
any complaint it becomes an assertion in `checks()` before the next push into
that area, so the same wrongness cannot come back quietly.

The listing shows the open ones. `--all` adds the resolved, which is what you
read before answering something that has already been answered, and
`--since TIMESTAMP` cuts the queue to what arrived at or after an ISO-8601
moment — the form for picking a project back up rather than reading its whole
history again.

## Proposals

```sh
hammerola proposal     # the standing proposal on this project, if there is one
hammerola proposal rm  # remove it — asks for the project id, so ask the owner
```

A proposal is a rough body a **person** drew over the model in the browser: the
motor the bracket has to clear, the wall it bolts to, a bought part it holds, or
an example of the layout they want. It reaches you as a few aligned lines of
numbers — what each thing is, how big, where it sits, and which parts of your
model they dragged and by how much — because that is a constraint you can design
against and "it is about four centimetres" is not. It is a STATEMENT and not an
edit: none of it is in the model, nothing was built from it, and none of it is
code to paste. There is one per project and it stands, so read it when you start
the same way you read the queue — a comment saying "make it clear the motor"
usually means the motor is drawn in the proposal with its size on it. Unlike a
comment it is never resolved: it describes the world around the part and stays
true after you have satisfied it, which is why a comment may tell you it is
there.

`hammerola proposal rm` cannot be undone and the hub keeps no copy — somebody
drew it by hand and it is in no build. It asks for the project id on the
terminal, which is a prompt you cannot answer: that is deliberate, and it means
the decision is not yours. Ask the owner. Do not remove one because it looks
stale, because the work it describes is done, or to tidy up — nothing you do to
the model obliges it to go.

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

## Removing things

`hammerola rm` removes a project from the hub entirely, asks for the id to be
typed first, and cannot be undone — the hub keeps no copy. There is no way to
remove one build: that would break a permanent URL somebody was given while
leaving the project standing. Do not run it to "clean up"; ask the owner.
