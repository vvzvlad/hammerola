# hammerola

Builds CAD models from code and serves them through a browser viewer. The name is from
"pianola" — a mechanism that plays itself: push a model source, get back a page you can
open, rotate and download printable files from.

**Status: the hub is the builder, and the migration is not finished.** What a push
carries is a model's SOURCE tree; the hub unpacks it, computes the geometry itself — in a
separate process, with the CadQuery kernel that ships in the image — and publishes the
result under a revision **it names itself**, from a digest of those sources. The push does
not wait for that: it answers `202` with a job id, and `GET /api/v1/jobs/<id>` and
`.../log` are where the outcome and the build's own output come from.

What is still open is the checklist in `AGENTS.md`, worked out in `docs/SPEC.md` §8A. The
two that are about the build path: the geometry gate on the receiving side (step 6) and
the comparison of two revisions (step 8).

## Publishing a model

The client is `hammerola`, and it lives in this repository on purpose: the client and the
hub share one contract — the archive shape, the path alphabet, the ceilings, the job
states — and it used to be split across two repositories where no test could see both
halves, which is exactly how publication came to be broken without anyone noticing. It
imports nothing outside the standard library, so whatever `python3` a laptop has is enough.

```bash
make client                          # symlink bin/hammerola into ~/.local/bin
hammerola login https://hub.example  # once per machine; the password is prompted for
```

From a checkout, that is. **A machine that has no checkout gets it from the hub**, which
serves the three things a first run needs and needs no token for any of them — they are
the software, identical on every deployment, and the person downloading them does not have
a token yet by definition:

```bash
mkdir -p ~/.local/bin ~/.claude/skills/hammerola
curl -fsSL <hub>/start/hammerola -o ~/.local/bin/hammerola && chmod +x ~/.local/bin/hammerola
curl -fsSL <hub>/start/skill.md -o ~/.claude/skills/hammerola/SKILL.md   # for an agent
```

The downloaded client is a zipapp built out of `src/client/` — one file, no
install, python 3.9 and up (`src/onboarding.MIN_PYTHON`, which is also what the
skill tells the reader and what a test holds the syntax to: a stock
`/usr/bin/python3` is 3.9 on macOS and on Debian 11, so "newer than that" is a
first onboarding step that fails on the ordinary machine).

`GET /start` is the manifest that names both, plus the template below — and one boolean,
`empty`, which is the only thing on this service that says anything about the deployment
without the token. It is there so that the front page of a hub nobody has pushed to yet
will be able to show somebody what to do instead of a login form and nothing else. **That
page has not been written**: the browser UI is untouched here, and the one reader of the
manifest today is `hammerola create`, which follows `template` and fetches nothing else.
`src/onboarding.py` carries the argument for the boolean and for why it is never a count.

Then, in a model's directory:

```bash
hammerola create --title "T13 ceiling mount"   # once per project: project.json + the template
hammerola build                                # publish the working copy into `dev`
hammerola commit -m "thicker bracket"          # publish an immutable revision
hammerola status                               # what the hub has for this project
hammerola comments                             # notes left on this project's builds
```

`create` fetches the starter template from the hub and unpacks it beside the `project.json`
it mints — a `model.py` that builds as it stands. It never writes over anything that is
already there, and `--no-template` is the form for a directory that already has a model (or
a machine with no hub to reach: the id has always been minted locally and still is).

**The revision is named by the hub**, not by the pusher and not by git: it is the digest of
the sources it received. So `commit` means "publish a version of this" — a directory that
is not a git repository publishes exactly like one that is, and the same tree pushed twice
lands at the same address. git is consulted once, afterwards: `commit` PRINTS a
`git commit` line recording what was published, for a person to run or ignore. It never
runs it.

`hammerola --help` lists the rest.

## Running the hub

Everything routine is wrapped in the `Makefile` (`make help` lists all targets):

```bash
make install                # create .venv + install dev/test deps
cp .env.example .env        # fill in the values
make test                   # run tests
make run                    # run the app
```

Python targets create and reuse a local `.venv` automatically — you never need the system
Python. `make ui` builds the browser bundle and is the only target that needs node.

## What's here

| Path | Purpose |
| --- | --- |
| `Makefile` | Single entry point for repeated actions: `install`, `test`, `run`, `client`, `ui`. Run `make help`. |
| `src/` | Application code; `settings.py` reads all config from ENV / `.env`. `app.py` is the HTTP surface, `store.py` the on-disk layout and the atomic publish, `jobs.py` the build queue a push hands over to, `buildproc/` the separate process a model actually runs in, `cadbuild/` the build half moved in from `cad_publish`, and `onboarding.py` the four things `/start` serves to somebody who has just found the hub. |
| `src/client/` | The other side of the wire: the `hammerola` command an author runs in a model's directory. Standard library only — it must import under a laptop's bare `python3`, so it takes nothing from `requirements.txt` and talks HTTP with `urllib.request`. `tests/client/` drives it against a real hub over a real socket. |
| `bin/hammerola` | The command itself, a plain script `make client` symlinks onto PATH. Deliberately not a packaging entry point: this repo's one importable top-level name is `src`, and `pip install`ing that onto a laptop would shadow every other project's. |
| `model_template/` | The starter project `hammerola create` unpacks: a `model.py` that builds as it stands, and a `.gitignore`. Files rather than a section of documentation, because the suite BUILDS it through the real build path (`tests/test_template.py`) — a template that stopped satisfying the gate would otherwise be handed to somebody with no way of telling whose fault it is. |
| `skill/SKILL.md` | Instructions for an agent working in a MODEL's repository, served at `/start/skill.md` and installed into `~/.claude/skills/`. It is about the workflow (`build` is a draft, `commit` is what makes a version exist), the model contract, and the four rules whose breach refuses a push. |
| `checklib.py` | At the repository ROOT on purpose, and not a stray file: `import checklib` is part of the contract with every model.py, like `views()` and `printables()`. It re-exports `src/cadbuild/checklib.py` under that name, and it has to sit at the root because a model is imported with its own directory FIRST on `sys.path` — the name then has to resolve on the path behind it, which in the image is `/app`. |
| `tests/` | pytest suite (runs in CI before the image is built). |
| `ci/smoke.py` | The gate between building the image and publishing it, run as a step of its own in both workflows. It answers the seven things a green test suite structurally cannot, because the suite runs against a checkout and never looks at the artefact: the declared ENTRYPOINT/CMD/WORKDIR, that the startup guard still fires *and still names the missing variable*, that privileges are really dropped to `app`, that `.dockerignore` kept `tests/`, `.env` and `.venv` out — and its mirror, that `templates/`, `static/` and `checklib.py` really are in — that the image's own command reaches its startup marker, and that the CAD kernel imports inside the image at the pinned versions. No ports, no secrets, no network, so the identical gate runs on pull requests too. |
| `data/` | Runtime state as a directory tree with JSON alongside — no database: builds, pointers, comments, build jobs, and the sources and log of every published revision. Gitignored, mounted as a volume. |
| `templates/` | Page templates baked into the image (`index.html`, `build.html`, `pointer.html`) — one per URL the hub serves. |
| `static/` | The viewer payload baked into the image (`static/_v/`). **Not everything in it is committed:** the browser bundle (`hammerola*`) is BUILT into that directory, gitignored and excluded from the build context — it arrives in the image from the `ui` stage instead. Do not commit a file matching that prefix, and do not expect one in a fresh checkout until `make ui` has run. |
| `ui/` | React sources for the browser UI, and the only place node is used. Built by `make ui` on a workstation and by the Dockerfile's `ui` stage for the image; the output is `static/_v/hammerola.js`. Nothing Python imports or executes anything here, so `make run` and `make test` work on a machine without node. `ui/README.md` explains the layout and the pins. |
| `Dockerfile` | Two stages: a `node:22-bookworm-slim` stage that compiles the browser bundle and is then discarded, and the `python:3.11-slim` runtime that copies out only its output — so no node toolchain ships in the published image. No `EXPOSE`, and no `USER`: privileges are dropped by `entrypoint.sh`. |
| `entrypoint.sh` | Postgres-style hybrid: starts as root, fixes `/app/data` ownership, drops to non-root `app` (uid 1000) via gosu. |
| `docker-compose.yml` | Deploy template — image from the Gitea registry, the data volume, Traefik labels, the healthcheck and one auto-update label. The comments in it are the rationale; `AGENTS.md` carries the rules. |
| `.env.example` | Full list of env vars with placeholders. Copy to `.env`. |
| `.gitea/workflows/` | `image-check-publish.yml` on push to `main`/`develop`: test → build → smoke gate → `docker login` → push to the Gitea registry. The login sits *after* the gate on purpose — until it is green there is nothing to publish, so the registry PAT never exists on the runner while untrusted build steps run. `tests.yml` is the same suite and the same gate for pull requests, and publishes nothing. |
| `docs/SPEC.md` | Requirements, the facts that were verified the hard way, and the work plan (§8A). |
| `AGENTS.md` | Conventions and onboarding for agents — the rules this repository is written by. |

## CI in one breath

Both workflows run the suite inside a `python:3.11-slim` container started by the same
docker the build uses — no `actions/setup-python`, because a setup action that quietly
fails on this runner produces a job that passes having checked nothing. The workspace
reaches that container as a **tar over stdin**, not a bind mount: the job itself runs
inside a container while `docker` drives the host's daemon, so `-v "$PWD:/src"` would
resolve on the host and mean something else entirely. The same split is why `ci/smoke.py`
publishes no ports and reads everything it needs through `docker exec`.
