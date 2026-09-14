# Карта репозитория

Что где лежит и почему именно так. Вынесено из `AGENTS.md` 2026-09-09.

## Project structure
- `src/` — application code (`settings.py` is the single config entry point)
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
  is the bounded queue and the worker threads that build and then publish. Read
  its docstring before touching it: `data/jobs/` is on a volume every build can
  write, so NOTHING there is evidence about who wrote it, and everything the
  registry reads back is rebuilt into a known shape and capped in size on the
  way in and on the way out — and whatever that normalization changed is WRITTEN
  BACK, because a correction that stays in memory leaves the planted value on
  disk for the next start to read again. A build can overwrite another job's
  `log.txt`, or `rmtree` its directory outright, and the hub believes what is
  left; that is accepted rather than fixed, because there is no boundary on the
  volume to fix it with (SPEC 8A.4). Records are never deleted — no retention,
  by decision of 2026-08-27 (SPEC §5.3) — so no count ceiling decides which jobs
  to throw away; only strangers get swept, and only by age. The second rule is
  the one that cost three rounds and outlives the file that taught it: anything
  that is a property of the SET of records must not be stored per record. A pass
  writes them one at a time, a build chooses which of those writes fails
  (`chmod 0500` on one directory, no vulnerability needed), and a half-applied
  pass then leaves a state the hub was never in. Creation order used to be
  stored that way; it is now stored nowhere at all, because retention was its
  only reader
- `hammerola/` — the OTHER side of the wire: the `hammerola` command an author
  runs in a model's directory (issue #26). `build` publishes the `dev`
  slot, `commit` publishes an immutable revision; both pack the
  source tree, POST it, poll the job from step 5 and print the build log. THE
  REVISION IS NAMED BY THE HUB, not by the client and not by git (SPEC §7.7):
  the id is the digest of the sources, so `commit` means "publish a version of
  this" and a directory that is not a repository publishes exactly like one that
  is. git is touched once, afterwards: `gitsuggest` prints a `git commit` line
  that RECORDS what was published, for a person to run or ignore — the tool
  never stages and never commits. It is
  in THIS repository on purpose — the client and the hub share one contract (the
  archive shape, the path alphabet, the ceilings, the codes, the job states), and
  publication broke precisely because the two halves used to live in two
  repositories where no test could see both. `tests/client/` now drives the real
  hub over a real socket, and `tests/client/test_limits.py` compares the client's
  copy of the ceilings (`hammerola/limits.py`) against `src/store.py` and
  `src/settings.py`. STDLIB ONLY, every module of it: the tool runs under
  whatever python3 a laptop has, so it imports nothing from `requirements.txt` —
  not loguru, not pydantic, not `src.store`, not `src.cadbuild` — and talks HTTP
  with `urllib.request`; `tests/client/test_stdlib_only.py` is what enforces
  that, since the test environment has every dependency installed and would
  never notice on its own. Around the two publishing verbs sit the rest:
  `login` (`setup.py`, writes the machine's `KEY=value`
  file 0600 after checking the password against the hub — ONE secret for the
  whole system, `EDIT_TOKEN`, no second key for comments), `create`
  (`project.py`, mints the
  twelve hex characters of SPEC §3.1 and refuses to write over an existing id.
  It writes a THIRD key, `project` — the latin slug the hub publishes under,
  taken from the author's DIRECTORY and, failing that, from the brackets of the
  title. That key exists because this is the only machine where the question has
  an answer: on the hub a push is unpacked into `.src-<uuid4 hex>`, so a build
  that worked the name out for itself put a card called
  `.src-89fb7abdeb1d48b5985bcb519850b284` on the front page. It is ABSENT rather
  than empty when neither source yields a slug — a missing key lets the hub
  answer with the project id, while `""` is a file asserting the project has no
  name. BOTH NAMES IT WRITES ARE HELD TO `limits.MAX_TEXT_CHARS`, because the
  directory's name can become either of them and a path component may be 255
  characters; they are held to it DIFFERENTLY, and that asymmetry is the
  decision: an over-long slug is passed over (the title's brackets are asked
  next, and the id stands behind them), while an over-long title stops the
  command — nothing to fall through to but a name nobody chose. WHICH of the two
  fires follows from that, and it is never both: with no `--title` the title IS
  the directory's name, so the title's ceiling stops the command before the slug
  is asked at all; the slug's ceiling fires only when a `--title` WAS given and
  the directory alone is over-long, and then the brackets answer instead. `create` also
  prints a `note:` when the directory and the title's brackets name two
  different slugs: the directory wins silently, and this is the only machine
  that can see both. Nothing changes the key afterwards: `rename` moves the
  TITLE, and a directory renamed later leaves the file saying what it said;
  `setup.py` then unpacks the starter template beside it, fetching it from
  `/start` — the one family of routes this tool asks for with NO token, and
  that is a property of the ROUTE and not of this command: `skill` asks the
  same way, for the manifest and for the instructions themselves, because the
  reader of them may not have a token yet. The id is still minted locally and
  `--no-template` is what keeps that true offline; the download is fetched and
  its collisions are checked BEFORE anything is written, so a failure leaves
  the directory untouched rather than holding a permanent id and no model),
  `status` (`status.py`, assembled out of `builds.json` and the dev slot's own
  `meta.json`, i.e. what the project page already fetches), `comments`
  (`queue.py`, the queue, its `resolve` and `files`, which brings a comment's
  photo and the viewer's frame down into `.hammerola/comments/` — the listing
  names that command where it used to print the URL, because the route serving
  an attachment is behind `EDIT_TOKEN` and a reader handed the URL could only
  open it by taking the secret out of the configuration), `skill` (`skill.py`,
  the version installed on this machine against the one the hub serves, and
  `skill update`, which writes the hub's copy over it and refuses a document it
  cannot read a version out of — what this fetches goes into the agent's skills
  directory, so it is parsed before it lands there), and the six added once the
  hub began keeping a revision's sources (issue #17): `source` and `log`
  (`sources.py`), `artifacts` (`artifacts.py`), `diff` (`revdiff.py`), `rename`
  and `rm` (`admin.py`, over the two routes `src/app.py` grew for them). FOUR
  OF THOSE ARE SHAPED BY WHAT THEY MAY NOT DO, and the shape is the decision:
  `source` and `artifacts` are two verbs because the code is behind the secret
  and the artefacts are public; `source` unpacks into a directory of its own and
  writes over the working copy only behind a flag AND a clean git tree; `rename`
  moves the TITLE and there is no way to rename an id, because every permanent
  URL is built from it; `rm` removes the project whole and never one build, and
  asks for the id to be typed first. What each of those fetches lands under
  `.hammerola/` in the project — hidden, so `pack` drops it and the next push
  cannot publish a copy of an older push. `skill` IS THE ONE VERB HERE THAT ASKS
  ABOUT THE MACHINE AND NOT ABOUT A PROJECT: every other command addresses a
  project or a revision, while this one reads a file in the home directory of
  whoever ran it (`~/.claude/skills/hammerola/SKILL.md` unless `--path` says
  otherwise), needs no project directory and presents no secret — `/start` is
  public precisely because the reader of the instructions may not have one yet.
  Nothing checks that version automatically, and that is a decision rather than
  an unfinished half: no ordinary command says a word about the skill, because
  this tool cannot know which copy an agent is actually reading. `update`
  (`update.py`, issue #77) is the same shape one level down and differs in what
  it writes: the RUNNING PROGRAM rather than a document, so what comes back is
  checked before it lands (a zipapp is a shebang and a zip, and it has to state
  a version) and lands through a temporary file beside the target wearing the
  target's own mode — the execute bit included — and an `os.replace`. There is
  no `--path`: the file it writes is the one it is running from, which is the
  archive `hammerola/update.py` was imported out of, and a copy running from a
  checkout or from site-packages is told to use git or pip instead. What it
  PRINTS is the point of the verb — `changelog.py` rides inside the archive with
  the code it describes, so the old client reads the entries out of what it just
  downloaded and prints those strictly between its own version and the new one;
  reading its own copy would print nothing, always. The version both halves
  compare is `hammerola.VERSION`, which the hub repeats in its manifest as
  `client_version` and which `build` and `commit` — and no other verb, because
  the check costs a round trip and only a WRITE can go wrong — refuse to publish
  from when the hub's is higher. Three things are of a different
  kind and are worth knowing before reaching for them: "the last build
  job" cannot be shown at all, because a job is addressable only by its id and
  job order is stored nowhere (see `src/jobs.py`); `hammerola log dev` IS
  answered, and not out of the store — a log is kept per revision and the slot
  is not addressed by one, so nothing is stored under its name, but since issue
  #79 the slot's meta.json carries a `job` field naming the build that filled
  it, and the command reads that build's log through `/api/v1/jobs/<id>/log`.
  Both kinds of push fill the slot, so the header says which one this was: a
  `build`, or the commit that copied itself in (issue #78). The slot still has
  no SOURCE — `hammerola source dev` refuses as it always did, and its refusal
  names the log as the half that no longer needs a commit; and the comment
  routes check the same `EDIT_TOKEN` as everything else — the hub's second
  variable went away in step 0, along with the client's sentence explaining a
  401 that meant "this deployment set its other variable differently"
- `hammerola/buildnames.py` — what a build file may be CALLED, and the one place that
  decides it. Three sides ask the question and they live in three different
  worlds: the file server, of every request for
  `/project/<pid>/<commit>/<name>` (`app._safe_name`); the declaration, of every
  name a push names in `meta.json` (`render._check_declared_file`, from all six
  of the places a pointer can sit — a view's `file`, its `overview`, its
  `preview` and its `card`, and a catalogue record's exported `files` and its
  own `preview`);
  and the client, of every name the hub hands back before it writes that name to
  the author's disk (`hammerola/artifacts.py`). Before this module the rule was
  written out inline in all three, and no two copies agreed: the server refused a
  leading dot, the declaration accepted one, the client had a third and weaker
  approximation. That is the failure it exists to end, and it is silent — a name
  the declaration takes and the server refuses publishes with a 201 into an
  IMMUTABLE directory under a year of cache and then 404s on every GET, so the
  build is accepted and impossible to open, from a push that can never be taken
  back (issue #53). ONE PIECE OF IT IS SHARED WIDER THAN THAT RULE:
  `first_nonprintable`, the category-C scan, is also what `render._plain_text`
  holds every displayed field to and what `hammerola/project.py::_clean_title`
  refuses a project title with. It is public for that last caller, which arrived
  after spelling the scan itself as `ord(char) < 0x20 or ord(char) == 0x7F` — a
  SUBSET of category Cc (the C0 controls and DEL, not the C1 block
  U+0080–U+009F), so U+202E passed `hammerola create` and killed the build.
  THAT IMPORT ALSO SETS THE BLAST RADIUS of the stdlib rule below:
  `hammerola/project.py` is imported by `admin`, `artifacts`, `cli`, `queue`,
  `revdiff`, `setup`, `sources` and `status`, so a dependency added to
  `buildnames` fails EVERY `hammerola` command at import time — not just the one
  verb that reads a build's file names.
  IT IS A MODULE OF ITS OWN because none of the three could
  host it: the import edge runs `app → store → render`, so `render` may import
  neither `app` nor `store` — which also closes `store.py`, the obvious address
  next door to `SAFE_COMPONENT` — and the client is stdlib-only and may not
  import the service at all. STDLIB ONLY for that last reason, and it LIVES IN
  the client package beside `hammerola/metricsdiff.py` and
  `hammerola/projectslug.py` — three modules, all shared for the same reason and
  all held to the same rule. They used to sit in `src/` and travel into the
  zipapp through a list named `onboarding.CLIENT_EXTRA_MODULES`; that list is
  gone, and they moved here when the tool got a distribution name, because an
  installed `hammerola` that imported `src.buildnames` would have to ship `src`
  — which is the very name that may not be installed onto a laptop. WHAT ENFORCES
  the stdlib rule is TWO tests, and they are not the same rule:
  `tests/test_buildnames.py::test_the_shared_module_imports_nothing_but_the_standard_library`
  names this file and allows the standard library and nothing else, while
  `tests/client/test_stdlib_only.py::test_every_client_module_imports_only_the_standard_library`
  reaches it by walking `onboarding.client_members()` — which is now simply
  every module of `hammerola/` — and allows `hammerola` on top of the standard
  library, since the modules it sweeps are the ones that import each other.
  `test_every_client_module_imports_only_the_standard_library` IS WHAT CLOSES
  `src` ACROSS THE WHOLE PACKAGE, and it has to be named rather than numbered,
  because the other test closes it by a rule that is stricter still — it allows
  no first-party name at all — over the ONE file it names.
  `test_the_client_never_reaches_into_the_service_or_the_build_half` beside it
  looks at two halves of `src` only, so it cannot fail while the sweep above
  passes — it is kept for the NAMES of those halves and their reasons, and is
  not a safety net under it.
  Both read the syntax tree rather than importing, so an import buried inside a
  function is caught too. THE ZIPAPP DOES NOT CATCH IT:
  `onboarding._refuse_unimportable` refuses on what
  `_import_closure` reports MISSING, and that walk skips every import whose
  module is not `hammerola` or `hammerola.*` outright. A `numpy` added here therefore enters
  no closure, refuses nothing and is served with a 200 — and the laptop that
  downloaded it is exactly what breaks. `store.SAFE_COMPONENT` deliberately did
  NOT move in beside it: that is a different rule about a different door — the
  alphabet each COMPONENT of an archive member's path is held to on the way IN,
  capped at 128 characters — where this one is about the name of a file a build
  already wrote, on the way out
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
- **The client has THREE doors now, and only two of them are used here.** Out of
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
  the only symptom. THE PACKAGING ENTRY POINT NOW EXISTS, and this paragraph used
  to say the opposite: while the client was `src/client/`, the repo's one
  importable top-level name was `src`, and `pip install`ing that onto a laptop
  would have shadowed every other project's `src`. So the client moved OUT of
  `src/` and became the top-level package `hammerola/`, taking the three shared
  stdlib-only modules with it — an installed distribution that imported
  `src.buildnames` would have to ship `src` as well, which is the shadowing all
  over again. `pyproject.toml` declares the name, the `>=3.9` floor (equal to
  `onboarding.MIN_PYTHON`), no dependencies at all and the console script, so
  `pip install <this checkout>` puts a `hammerola` on the PATH — the THIRD door,
  counted the same way `hammerola/__init__.py` and `hammerola/__main__.py` count
  it. IT IS NOT A NEW RECOMMENDED INSTALL, and nothing here uses it: no target
  runs it, the hub is still where the tool comes from, and if a `pip install`
  and the bootstrap `curl -o` both land in `~/.local/bin` the download wins.
  The name exists because
  `hammerola update` had nowhere to install to; that mechanism (issue #77) IS
  built now and lives in `hammerola/update.py`, and this door is the one it
  cannot serve — a `pip install`ed copy is a package directory rather than a
  single file, so `update` names pip instead of writing into site-packages.
  `pyproject.toml`'s `version` is the fourth thing in it nothing would notice
  going stale, and it is held equal to `hammerola.VERSION` by
  `tests/test_packaging.py`
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
  is public and carries a year-long `immutable`, while a comparison is served
  behind the token and only earns that year when both ends of the pair are
  commits. The path is nested rather than one joined name because `SAFE_ID`
  allows `_`: `<a>__<b>` would let the pair `x` + `y__z` and the pair `x__y` +
  `z` collide, and a collision here serves one comparison the other's geometry
- `templates/` — page templates that ship inside the image: `index.html`,
  `build.html`, `pointer.html`, one per URL the hub serves
- `static/` — the viewer payload that ships inside the image (`static/_v/`):
  `three-cad-viewer.esm.js`, the scripts for the pointer page, `tokens.css` (THE
  PALETTE — every colour the site paints with, named once per theme, linked by
  all three templates; issue #35), the resolver's `site.css` and `favicon.svg`.
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
  bundle in this directory is 3.5 MB, which is why). So a new `.svg` dropped in
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
  promises. Only `mark-on-light.svg` is rendered today, because the interface is
  light everywhere; `mark-on-dark.svg` is wired in by issue #35, and is
  kept — rather than dropped as dead weight — because its geometry is held to
  the same check meanwhile
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
  of being handed to somebody who cannot tell whose fault it is. That test skips
  where the CAD kernel does not import, i.e. in CI; the shape checks beside it
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
- `ui/` — the React sources for the browser UI, and the only place node is used
  here. Built twice, by two toolchains that must not disagree: `make ui` for a
  workstation and the Dockerfile's `ui` stage for the image. Nothing under
  `src/` imports or executes anything in it, which is why `make run` and
  `make test` work on a machine with no node at all. The output path is written
  in five files that never import each other, and `tests/test_ui_bundle.py` is
  what keeps them in step; `ui/README.md` has the layout and the pins
- `ci/smoke.py` — the gate between build and publish: eight checks (a)–(h) the
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
- `main.py` — thin entry point over `src/`
- `pyproject.toml` — packaging metadata for the CLIENT and for nothing else: the
  distribution name `hammerola`, the `>=3.9` floor, no dependencies at all and
  the `hammerola` console script. `packages` names the one package explicitly
  rather than letting setuptools discover them, because `src/` is the SERVICE and
  must never be packaged. The hub is not installable and is not meant to be — it
  ships as the image — so nothing here describes it

