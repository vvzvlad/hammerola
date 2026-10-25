# The brief: what he said, and where every number comes from

Read this before any geometry exists, and again whenever a number arrives from
the person. `SKILL.md` carries the few rules that lose a session on their own;
here is the rest of them, and what to do with a comment or a proposal left on
a build.

Contents: before there is any geometry — say-back and block preview,
fastening, hardware, stock cut to length, a picture the person sent,
provenance of every number · comments on a build · proposals.

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
