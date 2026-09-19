# Соглашения

Правила проекта с обоснованиями. Вынесено из `AGENTS.md` 2026-09-09;
короткий список самих правил остался там.

## Naming — one name for the project, everywhere
The repository, the local working directory, the compose service, the
`container_name`, the Portainer stack and the published image all carry the SAME
name, spelled with underscores (`ukuetis_logger`, not `ukuetis-logger` and not
`ukuetislogger`). Pick it once, at creation, and do not let a short form appear
anywhere.

This is not tidiness. Every one of those names is a lookup key for somebody:
`docker ps` and `docker logs` take the container name, Portainer lists the stack
name, the registry path is the repo name, and an agent asked about "the X service"
greps for one string. When they disagree, every lookup needs a translation table
that exists only in somebody's head — and the failure is silent, because each
individual name still resolves. A real example from this fleet: repo
`proxmox_dns`, directory `proxdns`, container `proxdns`, stack `proxmox-dns`,
image `proxmox_dns` — four spellings of one service, so `docker ps | grep
proxmox_dns` finds nothing on the host that runs it.

Underscores rather than hyphens because the name also has to be a legal Python
package/module name — otherwise the repo name and the import name diverge the
moment anything is imported. The only place a hyphen is acceptable is a DNS name
(`proxdns.example.lc`), which is a separate, externally-visible identifier: it may
be shorter, and renaming it breaks links, so it is not covered by this rule.

## Conventions
- **Commit messages are written in English.** Subject in conventional-commit style, body
  explaining WHY rather than restating the diff. This holds even though the design
  documents under `docs/` are in Russian: the log is read with `git log` by tooling and
  by people who did not take part in the discussion, while the documents are read by
  whoever continues the work.
- All mutable state goes under `data/`.
- All config comes from ENV / `.env` (see `.env.example`).
- Credentials / addresses of our own services that the user provides go ONLY into
  `.env` (never into code, never via inline env vars); read them through `Settings`.
- No default/example credentials in code; missing ENV var → fail at startup.
- A default address is allowed ONLY for public third-party APIs (Google, GitHub).
  Addresses of self-hosted services have no default.
- In the compose file, configuration goes in the service's own `environment:` block or in a
  file that TRAVELS with the stack (committed beside `docker-compose.yml` and deployed from
  the repository). Never reference an absolute host path from `env_file:`
  (`/data/<project>/app.env` and the like). Portainer executes compose INSIDE ITS OWN
  container, so that path is resolved in the Portainer server's filesystem, not on the host
  the stack runs on — the file you can see over SSH on the target host is not the file
  compose looks for. An absolute path that happens to line up under today's control plane
  works indefinitely and proves nothing; deployed by a different control plane it fails with
  "env file not found" while the container already running keeps serving traffic. The stack
  therefore stops being DEPLOYABLE without stopping being UP, which means the breakage is
  invisible until the next redeploy — and the redeploy that discovers it is usually a
  migration, i.e. the one moment when everything else is moving too. That is how it went on
  this fleet during the 2026-08-17 consolidation: the affected stacks only deployed again
  after their env files were copied into the Portainer server's own volume.
- Code comments are in English.
- The user-facing interface is in English too — UI text, CLI output, log lines and
  messages a user sees — unless the task explicitly asks for another language.
- All repeated actions (env setup, tests, run) go through `make` targets — add or
  extend a target instead of running ad-hoc commands.
- Python always runs inside a local `.venv`, created automatically by `make` on
  first use (`make test` / `make run` bootstrap it) — never the system Python.
- Python tooling is invoked as `$(VENV)/bin/python -m pip` and `$(VENV)/bin/python -m pytest`,
  never as `.venv/bin/pip` or `.venv/bin/pytest`. A virtualenv that was copied or moved from
  another directory keeps the ORIGINAL absolute path in its console scripts' shebang line, so
  `.venv/bin/pip` would go on installing into a different project's environment while every
  message it prints looks entirely normal. `python -m` resolves the module against the
  interpreter that was actually invoked — the one `make` just created, here.
- Tests are required for new code; in CI `build` depends on `test`.
- **An assertion about how the code behaves, which has to stay true, belongs in a TEST rather
  than in a comment or a document.** A comment that says what the code does is a claim with no
  enforcement: it goes false on an ordinary edit, nothing reports it, and the next reader spends
  their time discovering that the file lied; a test making the same claim fails on the edit that
  falsifies it. Much here already works that way — `tests/test_workflow_steps.py` compares the
  `run:` bodies this file requires to be byte-identical across the two workflows (no count
  here: the one below is pinned, a second copy would not be), `ci/smoke.py` counts its own
  verdicts, `tests/test_metricsdiff.py` checks an identity where an equality would pass, and
  `tests/test_template.py` refuses a template that still defines `printables` — the build
  ignores that function outright, so a leftover one publishes fine and nothing else would
  notice. The corollary is what makes the rule actionable: when you
  catch yourself writing "keep X and Y in step" or "this must match Z", that sentence is the
  specification for a test, and the comment is the version that cannot fail.
- **A comment says WHY, and three things it does not say** (decided 2026-09-19, issue #109).
  The why-rule works and stays. What was measured is its price: `ui/src/HammerolaViewer.jsx`
  carried 5812 lines of comment on 3197 lines of code — 72 % of the file, more bytes than the
  whole of `docs/` — and the last three features came out at 70–88 % prose, of which the Ctrl+Z
  one was 33 lines of behaviour under 239 lines of explanation. So:
  1. **History goes in git and in the issue, not in the code.** "Used to be X", "was called Y",
     "issue #N moved it here" — one reference, `#N` or a sha, and the story is a `git log -S`
     away. This is the part that drifts silently: `PUBLISH_TOKEN` was explained as removed in ten
     places, `cad_publish` in twenty-four files, `MAX_NOTES` in four — each of them a paragraph
     about something no reader can find.
  2. **Twelve lines is the ceiling for one block.** What does not fit is not shorter than it
     should be — it belongs in the module's docstring or in `docs/`, where it is read once
     instead of at every opening of the function. In the Viewer 195 blocks of 489 ran past ten
     lines, forty past thirty, and the longest `//` run in the repository was 79.
  3. **Do not explain what the next line does.** The code says that already, and about a third
     of the blocks measured were doing it.

  NOT a mandate to go and cut what is already written: that is weeks of work with nothing to
  show, and it is not what was decided. This changes the cost of the NEXT feature; old prose is
  tidied when a file is open for another reason anyway.
- Runtime dependencies are pinned with `==`, and a dependency the code imports DIRECTLY is
  named in `requirements.txt` even when it already arrives through another package's extra.
  Inheriting it means an unrelated upgrade up the tree can take it away, and the import then
  fails at startup in production on a commit that changed nothing near it. Comment a
  requirement with what BREAKS without it, not with what it is.
- If a module exposes a singleton, a cache, a registry or any other module-level mutable
  state, the suite gets an autouse fixture that asserts it is clean BOTH before and after each
  test. Before-only is not enough: without the after-check the test that corrupted the state
  goes green and the failure surfaces in an unrelated test later — usually whichever one
  happened to run next, which is where the debugging then starts.
- Between building the image and publishing it there is a GATE — `ci/smoke.py`, run as a
  step of its own in both workflows. Nothing reaches the registry until it is green, and
  `docker login` deliberately runs *after* it: until the gate passes there is nothing to
  publish, so the registry PAT is never on the runner while the Dockerfile's `RUN` steps
  and the image's own code are executing. Do not reorder those steps and do not move the
  login back to the top of the job.
  The gate answers what a green test suite cannot, because the suite runs against a
  checkout and never looks at the artefact: the declared ENTRYPOINT/CMD/WORKDIR, that the
  missing-variable guard still fires *and still names the variable*, that privileges are
  really dropped to `app` (nothing in the image declares a user — the entrypoint is the
  only thing that does it, and if it stops, everything still looks fine), that
  `.dockerignore` kept `tests/`, `.env` and `.venv` out of the image, and that the image's
  own command reaches its startup marker. When you add a check, add it there.
- `docker login` runs AFTER the gate, and that placement is the load-bearing half: until the
  gate is green there is nothing to publish, so there is no moment before it at which the
  registry PAT needs to be in the job's docker config — and everything above that line executes
  untrusted code on a runner shared with every other repository (the Dockerfile's `RUN` steps,
  including whatever `pip install` pulls in, and then the image's own code under the gate). Do
  not move the login back to the top of the job.
  The explicit `docker logout` at the end, under `if: always()`, is defence in depth rather
  than the thing preventing a leak: `docker/login-action` already logs out in its post step
  (`logout:` defaults to true, and act_runner does run post steps), and this job's docker config
  lives inside act_runner's own container anyway. Keep the step regardless — it is what still
  covers the day the login becomes a plain `docker login` run step, or `logout: false` is set,
  or a runner build stops executing post steps, each of which fails silently and leaves a PAT
  behind.
- `ci/smoke.py` counts its own verdicts: every probe declares how many targets it returns and
  the gate fails if the count does not match. That is the gate's guard against its own worst
  failure — a probe that quietly stops probing prints nothing, fails nothing and exits 0, so
  the run is green precisely BECAUSE a check disappeared. When you add or remove a check,
  update the declared count deliberately, as part of the same change; never "fix" a mismatch
  by editing the number to whatever the run happened to produce.
- Exactly six `run:` bodies are BYTE-IDENTICAL between the two workflows and move in lockstep:
  the Python test step, the JS test step, the gate, the smoke-container cleanup and the two
  test-container cleanups — one per suite. That whitelist IS the rule — it is the whole
  mechanism keeping the PR gate from drifting into testing less than the publishing one, so
  when you edit one of the six, edit its twin to match exactly, and verify it mechanically
  (hash the bodies) rather than by eye. `tests/test_workflow_steps.py` is that hashing, run on
  every push: it compares all six and also asserts that the two look-alike steps named below
  have NOT been unified, so the rule is now checked rather than merely written down — keep the
  count there and the word "six" here in step with each other. Everything outside
  the whitelist is free to differ and much of it does: the comments, the `env:` values, the
  timeouts, and the login/push/logout steps that exist in the publishing workflow only. Two
  steps LOOK like they belong on the list and deliberately do not — the BUILD step (the
  publishing workflow computes and builds the registry tags there, the PR workflow builds a
  single local tag it never pushes; unifying them would either put a registry path into a
  workflow a pull request can trigger or take the tag computation out of the one that
  publishes) and the IMAGE-cleanup step (a loop over `$TAGS` in the publishing workflow, a
  single `docker rmi "$SMOKE_IMAGE"` in the PR one). Naming both here is what keeps someone
  from "fixing" them in either direction.
- Every container CI starts is `--name`d, and EVERY removal of one carries `-v` — the cleanup
  steps in both workflows *and* `remove_container()` in `ci/smoke.py`. There are two removal
  paths for the smoke containers, not one, and the flag has to be on both: `ci/smoke.py` removes
  its own containers on the normal path (each one before it starts it, the long-lived ones again
  in a `finally`), so by the time the workflow's `if: always()` step runs there is usually
  nothing left for its flag to apply to. That step exists for the other run — the one where
  `ci/smoke.py` was killed by the smoke step's `timeout-minutes` before reaching its `finally`.
  A `-v` carried only in the workflows would therefore cover exactly the runs that do not
  normally happen, and the day a Dockerfile here declares a `VOLUME`, every ordinary run would
  leak an anonymous volume through smoke.py's own removal. `--rm` does not close that gap
  either: it is removal-on-exit performed by the daemon, so it never fires for a container whose
  docker CLI was killed by a step timeout — the container simply keeps running — and an unnamed
  leftover cannot be removed by anything afterwards, because every cleanup here works by name. On
  a shared, persistent daemon that leak is permanent. `-v` takes the container's anonymous
  volumes with it (there are none until a Dockerfile declares a `VOLUME` — exactly the change
  nobody remembers to pair with a CI edit) and can never touch a named volume.
- `concurrency:` on image-check-publish.yml serialises the runs of a branch, and that
  serialisation is the GROUP's doing on its own: the newest commit's `:latest` is written last
  whatever `cancel-in-progress` is set to, so production never lands on an older commit.
  `cancel-in-progress: false` buys exactly one further thing — be precise about which, because
  the generous reading of it is wrong. It buys that a run which has already STARTED is never
  killed mid-flight, so the `:<sha>` it is building is not lost to a newer push. It does NOT
  buy an image for every commit: a new run of the group always cancels the previous runs that
  are still `Waiting`/`Blocked` — on Gitea (`PrepareToStartRunWithConcurrency` →
  `CancelPreviousJobsByRunConcurrency`, which adds `Running` to that list only when
  `cancel-in-progress` is true) exactly as on GitHub ("any previously pending job or workflow
  in the concurrency group will be canceled"). Three quick pushes therefore still lose the
  middle commit's `:<sha>`, and with an image build measured in tens of minutes that is an
  ordinary occurrence rather than a corner case. Do not build anything on the assumption that
  every commit has an image; when a specific commit needs one, re-run the workflow for it by
  hand.
- `concurrency:` also requires Gitea >= 1.26 — the release that added the syntax to Actions, and
  that removed the built-in "cancel the previous run of this workflow" behaviour it replaced.
  An older instance does not reject the block, it IGNORES it — silently, with nothing in the
  run list or the logs saying so — and the symptom is NOT runs piling up in parallel: the
  built-in cancellation is still there, so a superseded run gets cancelled either way. In
  tests.yml that makes the block a no-op and costs nothing. In image-check-publish.yml it takes
  away the one guarantee named above: the built-in cancellation did not spare a RUNNING run, so
  a build already twenty minutes into producing its `:<sha>` dies when the next push lands, and
  gaps appear from ordinary well-spaced pushes rather than only from bursts. Missing `:<sha>`
  images are therefore not by themselves evidence of an old instance — they happen on a current
  one too. What points at the version is WHICH run was cancelled: a queued one is normal, a run
  that was already building is the older behaviour.
- CI installs no Python on the runner: both workflows run pytest inside a
  `python:3.11-slim` container (the same base the Dockerfile uses), with the workspace
  streamed in as a tar over stdin. Do not "simplify" this to `actions/setup-python` or to
  a bind mount — setup actions are unverified on this runner and fail by silently doing
  nothing, and a bind mount would resolve on the host daemon rather than in this job.
- `ci/smoke.py` publishes no ports and never talks to `127.0.0.1`: the job runs inside a
  container while `docker` drives the host's daemon, so a published port is not reachable
  from the job. Anything that has to be observed inside a container goes through
  `docker exec`.
- No `EXPOSE` in the Dockerfile — Traefik publishes the service via compose labels.
- The container runs as non-root user `app` (uid 1000) — the entrypoint starts as
  root, fixes `/app/data` ownership and drops privileges via gosu. Do not add a
  `USER` directive to the Dockerfile and do not remove the entrypoint.
- The compose file carries one auto-update label, `io.portainer.update.enable`,
  read by the ContainerAutomation auto-update in OUR Portainer build (our fork of
  Portainer — the Gitea repository `projects/portainer` on `gitea.vvzvlad.xyz`, not a
  directory in this repository) — upstream Portainer, CE or BE, has no such mechanism
  at all. Do not add the watchtower-family key beside it — that is unconditional and
  not merely a default: as of the 2026-08-17 consolidation no watchtower and no
  autoheal container was left on any environment of this fleet, and no
  `com.centurylinklabs.watchtower.*` or bare `autoheal` label either (that bare
  key is the sidecar's own — not `io.portainer.autoheal.enable`, which our Portainer
  build reads and which the next bullet is about), so a second key would be dead text
  that still reads like a working fallback.
  What the label buys — the polling, the health gate, the rollback — is a property of
  the CONTROL PLANE that owns the target host, not of the label and not of this
  project. Check WHICH control plane owns the host before relying on it. A host owned
  by a different one — a stock Portainer, say — has no ContainerAutomation at all, so
  the label is an unread string there and the failure mode is silence: the stack
  deploys green and the container simply keeps running the image it was first started
  with, with nothing anywhere reporting that updates stopped. Do not answer this by
  memorising a list of hosts: this fleet has run more than one Portainer at a time and
  ownership of a host has already changed once, which is exactly how the previous
  version of this paragraph went stale. Check the ownership, not the list.
- Do not add `io.portainer.autoheal.enable` beside the update label without deciding to: the
  same Portainer build's auto-heal restarts containers docker reports `unhealthy`, and it can
  MASK the auto-update's rollback gate. The gate polls health every 3 s, so it OBSERVES the
  first `unhealthy` sample within one poll interval (≤3 s) and begins the rollback from there
  — 3 s is when it notices, not when the rollback is finished; auto-heal sweeps every 30 s
  over running containers filtered on `health=unhealthy`, so it cannot see a container that is
  still `starting` and for most of the gate's window the two never meet. The overlap is the
  `unhealthy` state alone — but when auto-heal's tick lands in it first, its restart resets
  health to `starting`, the gate waits out its deadline, and a container that comes up healthy
  on the retry gets the update ACCEPTED: the bad image stays deployed and the log shows a
  normal successful update. That is the right trade where being back up beats a faithful
  rollback (a checker bot, a scraper) and the wrong one where a reproducible deploy matters —
  a trade either way, never an upgrade.
- The healthcheck's timings are part of the deploy mechanism, not cosmetics. After our
  Portainer build recreates a container on that label it waits for docker to report the
  container `healthy` within `max(RollbackTimeout ≈ 120s, start_period + 15s)`, and rolls the
  image back if the window closes first. Docker runs the first probe only after a full
  `interval` unless `start_period` is set, so a long interval without one gets a perfectly
  healthy image rolled back and then suppressed for 24 hours, leaving the service quietly on
  the OLD code. Dropping the healthcheck does not make that gate pass — it disables it
  entirely, and a broken image is never rolled back.
- A compose volume KEY is not the volume NAME: docker-compose prefixes the key with the
  project name, and Portainer uses the STACK name as the project name. When attaching a
  compose file to a deployment that already exists, the resulting `<stack>_<key>` must match
  the volume already on the host — or the volume has to be pinned with `external: true` plus
  an explicit `name:`. A mismatch does not fail anything: docker creates a new, empty volume,
  and the stack comes up looking perfectly healthy with all of its state gone.
