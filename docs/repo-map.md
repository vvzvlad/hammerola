# Карта репозитория

Что где лежит и почему именно так. Вынесено из `AGENTS.md` 2026-09-09.

## Project structure
- `src/` — application code (`settings.py` is the single config entry point)
- `src/archive.py` — reading the pushed tarball: the ceilings, the alphabet each
  path COMPONENT is held to, and the unpack that refuses a member before it
  becomes a file. It was a third of `src/store.py` and knows nothing about
  projects, builds or pointers, which is why it could leave. The import edge
  runs `store → archive` and only that way, so it raises `PublishError` from
  `src/errors.py` rather than from `store`. **Every name here is re-exported by
  `src/store.py`** — `store.SAFE_COMPONENT` is what `app.py`, `onboarding.py`
  and `tests/client/test_limits.py` already quote, and the re-export is what
  kept the move from touching any of them. A RE-EXPORT BINDS A NAME, IT DOES
  NOT REDIRECT A LOOKUP: code in this module resolves `SAFE_COMPONENT` and
  `gzip` in THIS module's globals, so a test that replaces
  one of them has to patch `src.archive` — patching `src.store` sets an
  attribute nothing reads, and the test then passes without exercising
  anything. Three tests in `tests/test_archive_security.py` did exactly that
  for one commit
- `src/cadbuild/` — the build half, moved in from `cad_publish` (SPEC 8A.2 step
  3): take a model's source, compute the geometry, gate it, export the
  artefacts and the viewer payload. Kept as a subpackage rather than spread
  through `src/` because it is a different job from serving: nothing in it
  touches HTTP, the data volume or a credential. Three things import it, and
  all three are deliberate: `src/buildproc/child.py` does it INSIDE the build
  process (step 4), `src/buildproc/comparechild.py` does it inside the
  COMPARISON process for the same reason (step 8, issue #10 — the OCCT boolean
  that measures a revision diff costs ~270 MB resident, measured, so it goes
  where the build already goes; that is OCP alone, less than the build's ~450 MB
  because nothing on the comparison path imports cadquery itself), and the root
  `checklib.py` shim re-exports one module of
  it under the name every model.py imports (see the next entry). Nothing on the
  serving side imports it, and step 6 did not change that: the gate now runs on the
  receiving side, but it runs INSIDE the build process, so `src/render.py` still
  transcribes `cadbuild.parts.KINDS` as `PART_KINDS` rather than importing it and
  `tests/cadbuild/test_naming.py` is what holds the two equal
- `src/jobs.py` — the asynchronous half of a push (SPEC 8A.2 step 5): `JobStore`
  is the registry (a directory per job under `data/jobs/`, `job.json` and
  `log.txt` beside it), `BuildTask` is what the request hands over, `BuildQueue`
  is the bounded queue and the worker threads that build and then publish. At
  start a record that does not parse, names another directory or carries an
  unknown state is logged and skipped, its directory left where it is; jobs a
  restart stranded in `queued`/`building` are failed and only those are
  rewritten. Records are never deleted — no retention, by decision of
  2026-08-27 (SPEC §5.3). Anything that is a property of the SET of records
  must not be stored per record: a pass writes them one at a time, one write
  can fail, and a half-applied pass leaves a state the hub was never in.
  Creation order used to be stored that way; it is now stored nowhere at all,
  because retention was its only reader
- `src/docsbuild.py` — the documents a project publishes to be read (issue
  #122): the paths its `project.json` lists under `documents` (markdown, PDF,
  pictures, HTML, SVG, and a KiCad schematic, board or 3D model — `render.DOCUMENT_TYPES`),
  published under the same paths, an entry optionally `hidden` (no row in the
  list, still served and opened by `?d=`). A schematic, a board and a `.glb`
  are each a document with a row of their own (issue #123); for a schematic this
  module finds every sheet it names by `Sheetfile` (`Sheet file` in KiCad 6),
  relative to the schematic that names it, as KiCad resolves it (`_kicad_schematic`),
  and for a schematic or a board the `.kicad_pro` with the same path minus the
  extension (`_kicad_project`); all of them are published, and the document's
  `kicad` in meta.json lists them.
  `BuildQueue._build_and_publish` checks the list before anything runs
  (a wrong entry is a 422 naming it); with a model in the tree the model is
  built as always and the documents are copied in beside it afterwards
  (`add_documents`); with none they are the whole build (`run_documents_build`,
  no process, `"kind": "documents"` in meta.json), answering with the same
  `BuildOutcome` a model's build does, so `publish_built`, `latest`,
  `builds.json` and the card are the ordinary path
- `hammerola/` — the OTHER side of the wire: the `hammerola` command an author runs
  in a model's directory (issue #26). `build` fills the `dev` slot, `commit`
  publishes an immutable revision; around them sit `login`, `create`, `status`,
  `source`, `artifacts`, `diff`, `log`, `comments`, `proposal`, `rename`, `rm`,
  `skill` and `update`. The verb table with what each one may and may not do is the
  docstring of `hammerola/cli.py`, next to the parser that defines them — read it
  there rather than here.
  IT IS IN THIS REPOSITORY ON PURPOSE: the client and the hub share one contract —
  the archive shape, the path alphabet, the ceilings, the codes, the job states —
  and publication once broke precisely because the two halves lived in two
  repositories where no test could see both. `tests/client/` drives the real hub
  over a real socket, and `tests/client/test_limits.py` compares the client's copy
  of the ceilings (`hammerola/limits.py`) against `src/store.py` and
  `src/settings.py`.
  STDLIB ONLY, every module of it: the tool runs under whatever python3 a laptop
  has, so it imports nothing from `requirements.txt` and talks HTTP with
  `urllib.request`. `tests/client/test_stdlib_only.py` enforces it, since the test
  environment has every dependency installed and would never notice on its own.
  THE REVISION IS NAMED BY THE HUB, not by the client and not by git (SPEC §7.7):
  the id is the digest of the sources, so `commit` means "publish a version of
  this", and a directory that is not a repository publishes exactly like one that
  is. git is touched once, afterwards: `gitsuggest` PRINTS a `git commit` line for
  a person to run or ignore — the tool never stages and never commits.
  Two things are worth knowing before reaching for them: "the last build job"
  cannot be shown at all, because a job is addressable only by its id and job order
  is stored nowhere (see `src/jobs.py`); and `hammerola source dev` refuses, while
  `hammerola log dev` is answered — the slot's `meta.json` carries a `job` field
  naming the build that filled it (issue #79)
- `hammerola/buildnames.py` — what a build file may be CALLED, and the ONE place
  that decides it. Three sides ask: the file server (`app._safe_build_path` for a
  build's files, every segment of the path; `app._safe_name` for `/_v/`), the
  declaration of every name a push names in `meta.json`
  (`render._check_declared_file`), and the client, before it writes a name the hub
  handed back (`hammerola/artifacts.py`). Before this module each of the three had
  its own rule and no two agreed — a name the declaration took and the server
  refused published with a 201 into an immutable directory and 404'd on every GET
  (issue #53). `first_nonprintable` is shared wider than that rule:
  `render._plain_text` and `hammerola/project.py::_clean_title` hold displayed text
  to it too, and `src/records.py` answers 422 with it at the comment and proposal
  write doors. STDLIB ONLY, and it lives in the client package for that reason — see
  the module's own docstring for why it could live in none of the three callers,
  and `tests/test_buildnames.py` plus `tests/client/test_stdlib_only.py` for what
  holds both rules. `store.SAFE_COMPONENT` is deliberately NOT here: that is the
  alphabet of a path component on the way IN, this is the name of a file on the
  way OUT
- `hammerola/metricsdiff.py` — reading `metrics.json`: what a build measured, and what
  moved between two of them. It is NOT a copy of anything and that is the point:
  the document has one writer (the build) and two readers — `cadbuild.metrics`,
  printing what moved since `dev`, and `hammerola diff`, printing what moved
  between two revisions — and the client cannot import the build half. Rather
  than duplicate the comparison (which is exactly the shape of
  `cad_publish/hubspec.py`, the copy that broke publication), the pure half was
  MOVED here and both sides import it; `src/cadbuild/metrics.py` re-exports every
  name it used to define. `tests/test_metricsdiff.py` asserts the two sides hold
  the same objects (`is`, not `==`) and that this module imports only the
  standard library, which is what lets the client have it at all
- `hammerola/projectslug.py` — what a project is CALLED, as against what it is
  identified by: the slug alphabet, the brackets at the end of a title, and the
  two ways of arriving at one. TWO READERS ON TWO MACHINES, which is the whole
  reason it is here rather than in either of them. `hammerola create` asks on the
  AUTHOR's machine, where the directory is the answer, and writes it into
  project.json as the `project` key; `src/cadbuild/project_title.py` re-exports
  it inside the hub's build process, which is rooted at the directory a push was
  unpacked into and therefore must never ask that question — `slug_from_directory`
  is the one name it deliberately does NOT import, because the answer there is
  `.src-<uuid4 hex>` and that is the incident (a front-page card reading
  `.src-89fb7abdeb1d48b5985bcb519850b284`). It is NOT a copy: the shape of a copy
  is `cad_publish/hubspec.py`, which held the same rule in a repository that
  could not see the original and broke publication, so the rule was MOVED here
  and both sides import it, exactly as `hammerola/metricsdiff.py` did. STDLIB ONLY,
  and enforced the same two ways as `hammerola/buildnames.py` above:
  `tests/test_projectslug.py` names this file and allows nothing but the standard
  library, and `tests/client/test_stdlib_only.py` reaches it through
  `onboarding.client_members()`. THE ZIPAPP DOES NOT CATCH IT either — same
  reason, `_import_closure` walks only `hammerola` imports — so a dependency added here
  is served with a 200 and breaks the laptop that downloaded it. The same suite
  asserts the two sides hold the same objects (`is`, not `==`), which is what
  makes the re-export a shared rule rather than a second one that agrees today
- `src/onboarding.py` — what the hub hands somebody who has just found it, and
  the only place the `/start` routes are named: the agent skill, the client as
  ONE executable file (a zipapp built at request time out of `hammerola/` —
  which works only because the tool is stdlib-only, so a client that grew a
  compiled dependency breaks here rather than on a laptop), the starter
  template, and a manifest naming all three. ALL FOUR ARE PUBLIC on purpose:
  they are the software rather than a statement about what is published here,
  they are byte-identical on every deployment, and the manifest exists to be
  read by somebody who does not have the token yet. The manifest carries ONE
  fact about the deployment — `empty` — and that is the single thing on this
  service answered without authentication. It is deliberately a boolean and must
  never become a count, a name or a date: a count leaks the size of the fleet to
  anyone who polls, and a name is the prefix of every permanent URL that project
  will ever have, which is exactly what `/index.json` sits behind the token to
  withhold. "Empty" means no project directory on the volume WITH ANYTHING IN
  IT (`Store.empty`) — not "no cards on the front page" (a project whose only
  build is in the `dev` slot has no card and is not an empty hub), and not "no
  project directory" either: `build_staging` creates one before the build runs
  and nothing removes it when the build fails the gate, so counting bare
  directories made a hub permanently non-empty the moment its first push failed
  — landing on exactly the reader the answer is for. ALL FIVE MANIFEST FIELDS
  HAVE A READER: `hammerola create` follows `template`; `hammerola skill`
  compares the copy installed on a laptop against `skill_version`, which is a
  constant of the IMAGE and not a second statement about this deployment —
  `empty` is still the only one of those; and the SIGN-IN PAGE reads `empty` —
  the gate on everything below — and then follows `skill` and
  `client` when it says this hub has nothing on it
  (issue #48). That block — five lines a person copies and hands to their
  agent — is what the route was built for and what collects on the argument for
  answering a question about the deployment anonymously. It is on the DOOR and
  not on the list, because the list is behind the very token somebody opening an
  empty hub does not have. Its addresses are BUILT, never written down: the
  origin off the browser (`hubOrigin` in `ui/src/hub.js`) and the paths out of
  the manifest. The page asks LAZILY — a
  reader who already has a token goes to the list and never touches this route —
  and every failure of that fetch is silence: a hint must not be able to take a
  sign-in form down (`loadStart` in `ui/src/hub.js`)
- **The client has TWO doors.** Out of
  a checkout it
  is `python3 -m hammerola`, STARTED IN THE CHECKOUT ROOT because that is where
  `hammerola` is importable — so the model directory is an argument and not the
  shell's cwd: `python3 -m hammerola -C <model dir> status`, or
  `PYTHONPATH=<checkout> python3 -m hammerola status` from inside the model.
  Plain `python3 -m hammerola` run in a model directory fails with
  `No module named 'hammerola'`, which is the mistake this bullet exists to head
  off. No venv, nothing to build, because the package
  imports the standard library and nothing else; everywhere else it is the
  one-file zipapp the hub serves at `/start/hammerola`. There is no
  `bin/hammerola` and no `make client` any more, and that is a correction rather
  than an omission: the target symlinked that file into `~/.local/bin`, which is
  the very name the hub's bootstrap writes with `curl -o`, and a write through a
  symlink lands in the link's TARGET — so the download quietly overwrote the
  repository's own copy while the command went on working, with `git status` as
  the only symptom. The client is the top-level package `hammerola/` rather
  than a part of `src/`, and carries the three shared stdlib-only modules with
  it, so the zipapp holds no `src` at all. `hammerola update` (issue #77,
  `hammerola/update.py`) replaces the zipapp in place; a checkout is not a
  single file and is updated with git
- `checklib.py` — at the ROOT, and not a stray file: `import checklib` is part
  of the contract with every model.py in the fleet, exactly like `parts()` and
  `views()`. It re-exports `src/cadbuild/checklib.py` under that name, and
  it has to sit at the root because a model is imported with its own directory
  FIRST on `sys.path` (so a project may deliberately shadow it) and the name
  then has to resolve on the path behind it — `/app` in the image. Smoke check
  (g) is what proves it reached the image
- `tests/` — pytest. `tests/cadbuild/` is the moved suite and has a `conftest.py`
  of its own: its `isolated_project` fixture is autouse and would otherwise
  chdir every hub test into a scratch project. `tests/client/` has one too, and
  it takes two things AWAY from every test in it: the `EDIT_TOKEN` that
  `tests/conftest.py` puts in the environment for `src.settings` (the client
  reads the same name and would push with the wrong secret), and the developer's
  real `~/.config/hammerola/env` (a suite that read it could pass only on a
  configured machine — or push at a live hub)
- `data/` — runtime state: builds, pointers, comments and build JOBS as a
  directory tree with JSON alongside, no database (gitignored, mounted as a
  docker volume). Note what that last one means: `data/jobs/` is on a volume
  every build can write anywhere in, so nothing there is evidence about who
  wrote it — see the docstring of `src/jobs.py` and SPEC §7.4.
  `data/compare/<pid>/<a>/<b>/<view>/` is the one subtree that is neither a
  build nor a job: the cached scene of a revision comparison (step 8, issue
  #10). It sits OUTSIDE the build directories deliberately — a build directory
  opens its JSON and pictures to anybody with the link (the STEP, STL and 3MF
  to the token or a key in the link) and carries a year-long `immutable`,
  while a comparison is served behind the token and only earns that year when
  both ends of the pair are commits. The path is nested rather than one
  joined name because `SAFE_ID` allows `_`: `<a>__<b>` would let the pair
  `x` + `y__z` and the pair `x__y` + `z` collide, and a collision here serves
  one comparison the other's geometry
- `templates/` — page templates that ship inside the image: `index.html`,
  `build.html`, `pointer.html`, one per URL the hub serves
- `static/` — the viewer payload that ships inside the image (`static/_v/`):
  `three-cad-viewer.esm.js` and its stylesheet, `three.module.js` /
  `three.core.js` (three itself, outside the bundle since the fork — see
  `viewer/` and `PROVENANCE.md` beside them), the scripts for the pointer page,
  `tokens.css` (THE
  PALETTE — every colour the site paints with, named once per theme, linked by
  all three templates; issue #35), the resolver's `site.css` and `favicon.svg`,
  and the KiCad viewer: `ecad-viewer.js` with the `parser.worker.js` it starts
  from beside itself, taken BUILT out of KiCAD-Prism's repository and never
  rebuilt here (where from, the commits, the hashes and what the hub's CSP cuts
  out of it — `PROVENANCE.md`; its licence — `ecad-viewer-LICENSE.md`).
  A separate tree with its own `COPY` line in the Dockerfile and its own smoke
  check (g), which names `tokens.css` because its absence looks like nothing —
  every page still answers 200 and every `var(--…)` in it resolves to nothing.
  FIVE OF THESE FILES ARE READ BY `ui/tests/chrome.test.js`, so all five are
  named on the JS tar line of both workflows: `tokens.css` and `site.css` (the
  resolver's copy of the header) at module scope, `favicon.svg` through a walk
  of this directory for `.svg`, and `pointer.js` / `pointer_pref.js` through the
  walk that sweeps for a second copy of the mark. `favicon.svg` is held to two
  document-level checks and nothing about geometry — the icon is a related
  drawing, not the mark (see `brand/`). It is found by WALKING this directory
  for `*.svg` rather than by being named, but that walk only ever sees what CI
  put on the runner, and the JS tar names files here ONE AT A TIME (the viewer
  and three together are 3.6 MB, which is why). So a new `.svg` dropped in
  here is checked on a workstation and INVISIBLE to both workflows until the two
  tar lines name it as well — the asymmetry is deliberate and worth knowing:
  `brand/` travels whole, so a new drawing there is checked everywhere at once.
  NOT EVERYTHING IN `static/_v/` IS COMMITTED: files matching `hammerola*` are
  the browser bundle, produced by `make ui` or by the image's `ui` stage, and
  they are in `.gitignore` and `.dockerignore` both. Never commit one, and do
  not expect one in a fresh checkout — an asset that belongs in the repository
  has to be a name outside that prefix
- `brand/` — the mark as the designer drew it, and the SOURCE the two inline
  copies of it are transcribed from: `Mark` in `ui/src/style.jsx` and the
  `<svg>` in `templates/pointer.html`, neither of which can import a file (one
  would make the bundle emit a second output, the other is on the page whose
  whole job is to leave quickly). `ui/tests/chrome.test.js` compares all three
  element for element, so these are derived copies rather than similar ones —
  every attribute as the union of both sides, the `<svg>` ROOT included, with a
  named exception list that itself has to keep excusing something. Two of its
  checks are about a file being a VALID drawing rather than the same one, and
  both close a way of rendering wrong while comparing equal: every attribute
  name has to be spelled the way SVG spells it (`strokewidth` draws the ribbon
  as a hairline, `CX` slides a hole off it to the left edge), and nothing may
  sit inside the `<svg>` but shapes (a `<style>` block — which is what an editor
  exports by default, and what the old favicon had — repaints the drawing past
  every comparison there is). Those two apply to `static/_v/favicon.svg` as
  well, which is otherwise held to nothing here: the icon is a RELATED drawing,
  not this one, so comparing its geometry would be wrong — but it is the SVG
  that ships in the image and is served to browsers, and it is where the
  `<style>` block came from. Every one of those per-document lists is itself
  checked by name against a single naming of the four files, because a list
  entry deleted is a check that vanishes with the suite still green — the same
  failure `ci/smoke.py` counts its verdicts to avoid.
  Nothing here is served or copied into the image: it is a source asset, named
  in `.dockerignore` so that stays true the day somebody widens a `COPY`, and
  the site icon it shares a design with is a served one, so that lives at
  `static/_v/favicon.svg` and is deliberately NOT duplicated here.
  **THE TWO FILES ARE NAMED AFTER THE BACKGROUND, NOT THE INK** —
  `mark-on-light.svg` is the DARK ink, for a light page. They arrived named the
  other way (`-dark` for dark ink) and that reading is a coin toss whose losing
  side is an invisible logo, so the test asserts the naming: each file's ribbon
  has to be on the opposite side of mid-grey from the background its name
  promises. `mark-on-dark.svg` is the reference for the dark palette: the dark
  theme's tokens in `static/_v/tokens.css` are taken from its inks, and
  `ui/tests/chrome.test.js` checks them against this file
- `model_template/` — the starter project `hammerola create` unpacks, served at
  `/start/template.tar.gz`: a `model.py` that BUILDS AS IT STANDS, a
  `.gitignore`, a `ref/measurements.md` for the numbers the model claims to
  have measured, and an `AGENTS.md` with a `CLAUDE.md` pointing at it — the
  template lands in a repository an agent opens cold, and those two say what
  the file is for before it is edited into something it is not. Everything
  under the directory ships: the tarball is an `rglob`, so a file added here
  reaches every project ever made from it. It is files rather than a section of
  documentation for one reason, and that reason is the only thing keeping it
  honest:
  `tests/test_template.py` runs it through `run_build` — the same entry point a
  push takes — so a template that stopped satisfying the gate fails here instead
  of being handed to somebody who cannot tell whose fault it is. That test runs in
  CI, whose test image installs the kernel's libraries (issue #27), and skips
  only where the kernel does not import; the shape checks beside it
  do not, and they are what catch the edit that actually happens (a file added
  under a name the path alphabet refuses, which takes down the whole push of
  every project made from it). It carries NO `project.json`: `create` mints the
  id, and an id shared by every project made from a template is the one thing an
  id may never be. The NAME is not `template/`, deliberately: that is one letter
  from `templates/` next to it, both are copied to the root of the image by
  adjacent COPY lines, and two names that differ by a letter are how a COPY or an
  ignore rule ends up on the wrong one while each still resolves
- `skill/SKILL.md` — instructions for an agent working in a MODEL's repository,
  not in this one, served at `/start/skill.md` and installed into
  `~/.claude/skills/hammerola/`. ITS FRONTMATTER IS READ BY THE HUB, AND READ
  STRICTLY: editing that header is editing what the service serves, not
  cosmetics in a document written for agents. `onboarding.skill_version` lifts
  `version:` out of it and raises `ValueError` on a file with no frontmatter
  block or no such key, and `manifest()` calls it — so a header this cannot be
  read out of takes the whole `/start` document down to a 404, which is why
  `ci/smoke.py` deliberately holds `/start` out of `START_ROUTES` and leans on
  check (g), which already requires `/app/skill/SKILL.md` by name. THE
  STRICTNESS IS THE DECISION and not an oversight to be softened into a
  default: a version that cannot be read has to be a REFUSAL rather than
  "version unknown", because a default would make a shipped skill that lost its
  version indistinguishable from a fresh one — the exact silence the versioning
  exists to end. What it exists to say, and what nothing else
  says anywhere: `build` fills the draft slot and leaves the project off the
  front page, `commit` is what makes a version exist, and finished work is
  committed. The rest is the model contract (pointing at `model_template/` as the
  example rather than restating it) and the four rules whose breach refuses a
  push — the path alphabet, a `checklib.py` of one's own, dependencies, and the
  fact that `model.py` is executed by the hub. It carries no address: the reader
  substitutes their own hub
- `ui/` — the React sources for the browser UI, and one of the two places node
  is used here (`viewer/` below is the other). Built twice, by two toolchains
  that must not disagree: `make ui` for a workstation and the Dockerfile's `ui`
  stage for the image. Nothing under
  `src/` imports or executes anything in it, which is why `make run` and
  `make test` work on a machine with no node at all. The output path is written
  in five files that never import each other, and `tests/test_ui_bundle.py` is
  what keeps them in step; `ui/README.md` has the layout and the pins
- `ui/src/DocShell.jsx` — the page of a build with no model
  (`"kind": "documents"`): `ui/src/main.jsx` mounts it instead of
  `HammerolaViewer.jsx`. A header, the document, and the list of
  `ui/src/viewlist.jsx` floating at the bottom with the documents in it;
  `?d=<id>` picks the document, and a row rewrites it. It holds only the id of
  the open document
- `ui/src/viewlist.jsx` — the list of views both pages choose from: the
  button at the bottom, the card it opens upwards with the views and then
  the documents (`documentRows`: a row each but for a hidden one), and the
  styles of the bar, the card and the document's layer. `chromeview.js` builds the model page's rows and DocShell
  its own; `viewList` draws them on both
- `ui/src/DocumentView.jsx` — one document, as both pages draw it: markdown
  drawn by `ui/src/docmd.js` (markdown-it with HTML off, its tokens turned into
  React elements, relative links resolved from the document's directory, short
  table cells kept on one line), PDF, HTML and SVG in an `<iframe>`, a picture
  as `<img>`, a KiCad design by `ui/src/KicadView.jsx`. DocShell draws it
  under its list; the model page draws it over the
  3D area when a document is chosen in the view list (the rows are built in
  `chromeview.js`, `?d=` is read on arrival in `HammerolaViewer.load`)
- `ui/src/KicadView.jsx` — a KiCad DESIGN: the listed schematic, board and 3D
  model with one path minus the extension (`designKey`), one view per listed
  member — a `<ecad-viewer source-mode="host">` for the schematic and for the
  board, `BoardView3D` for the `.glb` — all mounted, the one on screen the open
  document the page hands down (`doc`; the rows that choose it are the page's
  list), the others hidden by `visibility` and the viewers told
  `setActive(false)`. It fetches the files out of the build and hands each
  element its own (`designSources`), and it is where the views are LINKED: a
  single click selecting a part in one view selects it in the others
  (`ecad-viewer:selection`), a click on nothing or Escape clears it in all of
  them, and a right click opens the menu `Show in …` (`menuFor` says which views
  take a part or a net) whose choice asks the page to open the sibling (`onOpen`)
  and, once it is on screen, calls `requestCrossProbe` on its element with the
  designator or the net. The viewer cannot be asked what is under a point, so a
  right click replays its own left click there and builds the menu from the
  selection it reports. The viewer is `static/_v/ecad-viewer.js`,
  imported by URL on first use (`loadEcadViewer`)
- `ui/src/BoardView3D.jsx`, `ui/src/board3d.js` — the 3D view of a board: three,
  `GLTFLoader.js` and `OrbitControls.js` imported by URL from `static/_v/` (three's
  own add-ons, `static/_v/PROVENANCE.md`) on first use, the `.glb` of
  `kicad-cli pcb export glb` drawn on demand and only while on screen. `board3d.js`
  is the part that needs no WebGL: which nodes are parts (a child of the scene
  root named by its designator), merging a part's meshes, lighting one part on
  copies of its materials, framing it
- `ui/src/PcbPanel.jsx` — the board view's own panel over its canvas (the
  viewer's panels are hidden by `hide-chrome`): layer presets, a row per layer
  with an eye and an active-layer click, the zone fill opacity (dimmed to
  `ZONE_OPACITY` on open), and the net of the last click, lit whole through the
  viewer's own highlight. The viewer owns the state; the panel re-reads it
- `ui/src/kicadsheets.js` — which file a part's `Datasheet` field names:
  reference → value from the placed symbols of the schematics and the
  footprints of the board, the value read as KiCad reads `${KIPRJMOD}` and
  matched to a listed document (`KicadView` offers it as an item of the part's menu and shows it in a window over the view)
- `ui/src/kicadpins.js` — a schematic's text with the `(pin "N" (uuid …))`
  entries the viewer draws a placed symbol's pins from, added from the sheet's
  `lib_symbols` to every symbol that has none (konnect writes none); text it
  cannot read comes back as it was. `KicadView.designSources` runs every
  schematic through it
- `viewer/` — the viewer LIBRARY's own source: `three-cad-viewer` forked into
  this tree (MIT, issue #14; the tag and commit it sits on are recorded in
  `static/_v/PROVENANCE.md` and nowhere else, so an upgrade moves one file),
  because what we need from it are two edits to
  its BUILD — `external: three`, so three ships once beside the bundle instead
  of inside it, and an index that re-exports three's namespace. A fork kept as
  SOURCE is what makes those two rebasable onto the next tag; a patched artefact
  would not be. `make viewer` builds it into `static/_v/` and copies three's two
  files in beside the bundle. The outputs are committed and the inputs are not:
  `viewer/node_modules/` and `viewer/dist/` are gitignored, and the directory as
  a whole is in `.dockerignore` — the image serves the built files and has no
  use for a node toolchain. `static/_v/PROVENANCE.md` has the commit it was
  taken at, the two edits, and how to upgrade
- `ci/Dockerfile.test` — the container the Python suite runs in, in both workflows.
  Not the artefact: the shipped image is the Dockerfile at the root, which installs
  requirements.lock with `--require-hashes` and no test dependency at all. This one
  is python:3.11-slim plus git, the CAD kernel's system libraries and
  requirements-dev.txt, all of which the test step would otherwise install on every
  single run. Its tag is a hash of this file and the two requirements files — the
  same three that make up its build context — which is what makes reuse on the
  runner's persistent daemon safe: a stale image cannot answer to a current name.
  `tests/test_ci_kernel_libs.py` holds its library list to the Dockerfile's
- `ci/smoke.py` — the gate between build and publish: nine checks (a)–(i) the
  test suite structurally cannot make, because it runs against a checkout and
  never looks at the artefact. (b) proves the startup guard fires and NAMES the
  missing variable. It used to prove more — that the guard names EVERY missing
  variable, not just the first — and it could, because there were two
  credentials; with one (`EDIT_TOKEN`, step 0) that property moved to
  `tests/test_config_errors.py`, which can hand the guard a settings class with
  several required fields. Read `REQUIRED_VARIABLES` there before assuming the
  gate still covers it.
  (h) is the only check here that makes a REQUEST — it asks the running
  container for the three `/start` files, two of which are assembled when the
  request arrives and so cannot be checked by naming a path at all. It is a
  witness for the whole client only because the assembly REFUSES when a module
  reachable from `hammerola/cli.py` did not reach the image
  (`onboarding._refuse_unimportable`); the glob that collects those modules
  cannot see a file that is not there, so without that refusal a stripped image
  served a 200 and an archive that died on the laptop that downloaded it
- `docs/SPEC.md` — requirements, verified facts and the work plan (section 8A)
- `docs/ui-brief.md` — what the interface is FOR, and the vocabulary its panels
  use; `docs/viewer-api.md` — which of the vendored viewer is a public API and
  what `ui/src/viewport/` reaches into at its own risk. Listed here because the
  only way in used to be a comment inside the code that needed them (#100)
- `main.py` — thin entry point over `src/`

