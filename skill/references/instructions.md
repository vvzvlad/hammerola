# Assembly instructions: an IKEA-style PDF

Read when the person asks how the product goes together for someone else: an
assembly guide, a build sheet, «инструкция по сборке», «как у IKEA / LEGO». The
result is a PDF published beside the model, drawn from the model itself:

* page 1 — the guide's title over the finished assembly;
* one page per step — a big step number, a bold heading and a line of text; a
  line drawing in which parts fitted in earlier steps are grey and this step's
  parts are black, pulled out along the way they go in, with a dashed line along
  the path to their seat; and a box of what this step adds, each piece drawn
  alone with `N×`, its record's key and `note`.

The steps are a file of their own, `instructions.json` beside `model.py`. They
are not views: `views()` stays what the viewer shows.

```json
{"title": "Sensor box",
 "angle": [25, -60],
 "steps": [
   {"title": "Press in the inserts", "text": "Iron at 220 °C, flush with the rim.",
    "add": ["base", {"part": "insert", "explode": [0, 0, 12]}]},
   {"title": "Lay in the board", "add": [{"part": "board", "explode": [0, 0, 30]}]},
   {"title": "Close the lid", "text": "Hand tight.",
    "add": [{"part": "lid", "explode": [0, 0, 40]},
            {"part": "screws", "bodies": [0, 1, 2, 3], "explode": [0, 0, 25]}],
    "angle": [35, 30]}]}
```

* **An instance is a body.** The bodies of every reference of a key in
  `assembled`, in the view's order, are numbered from 0. An `add` entry is a
  key (every body of it not added yet), `{"part": k, "count": N}` (the next N),
  or `{"part": k, "bodies": [i, ...]}` (exactly those) — so the nuts of a
  product kept in one record still go in each at the step where it goes on.
  Every run prints
  the bodies of each record of more than one: index, kind (volume and size) and
  centre in mm. Read it, and the code that builds the record, before choosing
  `bodies`. An index is a position: after any change to such a record, read
  the inventory again and check every `bodies` that names it.
* **A body is a connected piece of the model.** Pieces the model fused into one
  solid — a nut and its lock nut, a screw with its washer — are one body,
  drawn and counted as one. Fasteners are never fused
  (`references/model-py.md`): a model that fuses them is fixed before the
  guide is made, never written around. A step's text promises no more than its
  drawing shows.
* `explode` on an entry moves its bodies out by `[dx, dy, dz]` mm **in the
  part's own frame**: a screw modelled along Z goes out along its own axis
  however `at` turns it. An entry without one is drawn seated, and every later
  step draws them all seated.
* `angle` is `[ELEV, AZIM]` in degrees, the camera of `hammerola snapshot
  --angle ELEV,AZIM`, for the whole guide or for one step.
* `"upside_down": true` on a step draws the assembly turned over, the camera
  unchanged: for the steps the hands do with it that way up. The step that
  turns it over or back says so in its title. The box beside it still shows
  each piece the right way up. `explode` is still in the part's own frame,
  not the page's: on such a step a part that goes in from above on the page,
  and is not turned by its `at`, is exploded along −Z.
* Every body of every printable and hardware record of `assembled` is added by
  some step, or the run refuses, naming the key and the bodies left over. A
  mock is added only when the person handles it (the board the case closes
  over); the wall stays out.
* `N×` counts bodies. Identical bodies — four studs, two bearings — are one
  piece four or two times. A record whose bodies all differ (a motor and its
  terminal box) is one piece, added whole.

## Writing the steps

* **A step is one action of the hands**: one part with what fastens it, or a
  set of identical parts done the same way (four inserts). Two unrelated parts
  are two steps.
* **The order is one a person can actually follow**: nothing goes in behind a
  part already fitted, inserts before the lid that covers them, the screw
  after the part it holds and in the same step. Check each step against the
  model, not memory.
* **A nut goes on before whatever it would have to travel past.** A nut that
  would have to run the whole length of a stud past parts already fitted goes
  on with the stud, in its step or the one before. (A pump guide set four bare
  studs and then the head on them: each nut under the head would have been run
  down the whole stud.)
* **Every loose part is held at every step** — by gravity with the assembly
  the right way up, by a part fitted next, or by what fastens it. A nut in a
  pocket that opens downwards falls out unless the assembly is upside down or
  the pocket is closed: then the step says to turn it over, or the part goes
  in at the step that fastens it. Check how a pocket opens and what lies below
  it in the model. (A pump guide laid embedded nuts into pockets open towards
  a chamber two steps before the studs, with nothing under them.)
* **Fasteners are the steps that matter.** Each nut, washer and lock nut is
  drawn at the step where it goes on, in the order it goes on; the order of
  tightening is the reason the guide exists. A step's text that names a nut its
  drawing does not show is a step written wrong.
* **Explode along the way the part goes in, by at least its own size** along
  that line, so the dashed path between it and its seat shows; a screw by a
  little more than its length. A part slid in from the side is pulled out
  sideways, not up.
* **One camera for the whole guide** unless a step's part goes in from a side
  that camera does not see. Try angles on the published `assembled` with
  `hammerola snapshot`: it costs no build.
* **The text says what the drawing cannot**: hand tight, the side that faces
  out, a temperature, a click. Short, imperative, in the person's language;
  no text when the drawing says it all.
* **The box prints each record's `note`**, so a hardware part without one shows
  only its key: write `"note": "M3x8 DIN912"` on the record first. A record
  whose bodies are of several kinds, some of them repeated (a product's
  screws, washers and nuts in one), names the bag, not the piece, so its
  pieces show only `N×` and the picture: the step's text names them.

## Making it

```sh
bash <skill>/scripts/instructions.sh [PROJECT_DIR] [-o OUT.pdf]
```

It runs the project's `model.py` in the hub's own image, with the kernel the
hub builds with, through `docker`, which may be a remote daemon: nothing is
mounted, the directory travels as a copy. A model that places a board
(`import kicadboard`) gets the hub's KiCad service beside it, started from its
image for the run and removed after. It takes as long as a build. The PDF
is written to `PROJECT_DIR/instructions.pdf` unless `-o` says otherwise, and
its path is printed.

What travels is what a commit could carry — the tracked files and the untracked
ones git does not ignore — as they are in the working copy, committed or not.

**Look at every page before publishing** (`Read` renders a PDF): a new part
hidden behind an old one, a step whose drawing shows nothing new, a fastener
in the air before the part it holds, a step whose text names what its drawing
lacks. Each is fixed in the steps, the camera or the explode, and the PDF made
again.

## Publishing

Commit `instructions.json` and the PDF together, and list the PDF in
`documents` (`references/documents.md`):

```json
"documents": [{"file": "instructions.pdf", "title": "Assembly instructions"}]
```

**The hub does not redraw it.** The PDF shows the model as it was when the
script ran: a commit that moves, adds or renames a part of a step makes it
again and commits it in the same commit.
