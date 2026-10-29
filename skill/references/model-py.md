# model.py: the contract, and where CadQuery bites

Read when writing or changing `model.py`: what the hub requires of it, and
which CadQuery operations fail quietly.

Contents: CadQuery traps — hollowing, fillets, coincident faces, a mesh that is
not watertight · the contract — `parts()`, the record types, `views`,
`checks()`, what `checklib` offers, the artifacts a build leaves.

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
  underscore, a letter or digit first, up to 128 characters; `assembled`,
  `print` and `print-<number>` (the files of the beds) are reserved. An unknown key in a record (a misspelt `colour`) is a
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
  the id, and `"views": {"<id>": "<name>"}` in `project.json` overrides it
  (where a rename on the hub's page writes it). **A view carries no geometry of
  its own.** Each entry of `parts` is:
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
  must be in it** (alpha 0 does not count). A printed part that is not part of
  the product — an assembly jig — is left out by name and reason instead:
  `"absent_ok": [("drill_jig", "assembly jig, not part of the product")]`,
  the reason logged; show it in a view of its own. Nothing in `assembled` may
  overlap anything unless declared: `"interference_ok": [("nozzle", "seat", "threaded joint")]`,
  the reason required and logged. A `mock` is never asked; **`hardware` is** —
  a screw biting into its printed hole is a declared overlap.

  **`print` is the bed, and it is downloaded whole.** The build writes
  `print.3mf` from it: each reference an object of its own, where its `at` put
  it, standing on z = 0, offered on the page as `print plate` under 3MF and
  opened in Bambu Studio in one click. So a model of more than one printable
  lays out every one of them here, as many copies as one product takes; without
  a `print` view there is only each part's own 3MF. When the owner has named
  the printer and the parts do not fit its bed, split them over beds:
  `{"part": "pin", "at": ..., "plate": 2}` puts a reference on bed 2 (no
  `plate` is bed 1), and each bed is a file of its own — `print.3mf`,
  `print-2.3mf`, … Lay the beds side by side in the view, clear of each other,
  and assert each bed's footprint against the printer in `checks()`; the hub
  does not know the printer. Not knowing it, keep one bed. Printables only; `at` may move a part
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
  so the no-meshing rule in `references/checks.md` does not reach it.
  `material_at` is the fast
  point probe; `volume` and `is_empty` say whether a boolean left anything
  (`assert wp.vals()` cannot); `section` times a stretch of `checks()` in the
  log; `check` registers a unit the hub runs in a worker of its own (see
  «Keeping checks fast enough to run» in `references/checks.md`). Each reads
  EVERY body of the part it is
  handed, `.add()` assemblies included. It lives in the hub's image; nothing to
  install or vendor.

That is all of `checklib`, and the gate is all of the hub: **nothing calls a
helper for you**, so a model that never calls `unsupported_area` publishes green
with a face hanging in the air. Provenance (`references/brief.md`) is the one
thing checked
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
`print` view, `print.stl` and the 3MF of each bed. It takes `dev` and `latest` too, so it works straight
after a `build`. Never assemble a picture's URL by hand: the command asks the
build what it published.

**`hammerola snapshot <build>`** draws one view of a build that exists, on the
hub, without building it again: `--view VIEW` (default `assembled`), `--angle`
one of `iso`, `front`, `right`, `back`, `top`, `bottom`, `multi` for all six on
one sheet, or `ELEV,AZIM` in degrees (a negative one as `--angle=-30,45`),
`--hide NAME` for each part in the way, `--output FILE` (default
`.hammerola/snapshots/`). It prints where the PNG landed. A part's name is its
key in the catalogue, as the view lists it; a wrong one is refused with the
list.

**`hammerola measure <build> <a> <b>`** prints the smallest distance between two
parts of one view (`--view`, default `assembled`), the two closest points and
how it was measured: two printables exactly, on their STEP; a pair with
anything else, or with a `deformed` reference, on the view's mesh, which can
differ from the true gap by up to the tolerance it names either way — larger on
convex faces, smaller on concave ones such as a hole — and reads a part wholly
inside the other as the gap between their surfaces. `0 mm` is touching or
overlapping, and on the mesh also within that tolerance; a part placed several
times gives its nearest pair, named.

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
