# Makefile — single entry point for every repeated action in this project.
# Run `make` (or `make help`) to list the available targets.
#
# All routine commands (environment setup, tests, run, the browser bundle) live
# here so they stay documented, consistent and hard to get wrong. Prefer adding
# a target over writing a one-off command in the shell or in CI.
#
# THE IMAGE IS NOT BUILT HERE, and there is no target for it. This line used to
# claim "docker build/push" among the above; nothing of the sort ever existed,
# and a wrapper would be worse than its absence: the build is a bare
# `docker build .` with no arguments, while the tags, the gate and the push are
# the publishing workflow's (.gitea/workflows/image-check-publish.yml), which is
# the one place they may be computed. A target that built an image locally would
# read like the thing CI does and be a different thing.

# --- Configuration -----------------------------------------------------------
VENV   ?= .venv
PY     := $(VENV)/bin/python
PIP    := $(PY) -m pip
PYTEST := $(PY) -m pytest

# Where the built browser bundle lands, and exactly which files it consists of.
# Written once because several files have to agree on them — these variables,
# templates/build.html's <script src>, the Dockerfile's `COPY --from=ui` lines,
# REQUIRED_PATHS in ci/smoke.py and vite's own output names.
# tests/test_ui_bundle.py reads these lines to check the others against them.
#
# The output goes FLAT into static/_v/, beside the committed assets, because the
# hub serves `/_v/<one path component>` and nothing deeper (src/app.py,
# `_serve_asset`/`_safe_name` — a path-traversal defence, not an oversight).
#
# UI_FILES IS AN EXPLICIT LIST for the same reason the Dockerfile copies by name:
# built and committed files share this directory, so a `cp -R` of the build
# output would let a chunk vite happened to call `pointer.js` overwrite the
# hub's own. Naming the files means nothing reaches static/_v/ unless it is asked for,
# and a build that stops producing one fails the `cp` loudly — `cp: ui/dist/x: No
# such file or directory`, then `make: *** [ui] Error 1` — instead of shipping
# whatever the build did emit under a name nobody chose.
#
# LOUD IN MAKE IS NOT THE SAME AS EMPTY IN static/_v/, and the difference is the
# price of the atomic publish in the `ui` recipe below: the copy goes to a
# temporary name and only a successful `mv` replaces the destination, so a build
# that stops producing a file leaves the PREVIOUS one exactly where it was. Both
# happen at once — verified by renaming vite's output: make stopped with Error 1
# and static/_v/hammerola.js was byte-for-byte the bundle from before the run. The
# trade is worth it, because the alternative (delete, then copy) hands a truncated
# file to any request that arrives mid-copy; but it means a red `make ui` has to be
# read as "the bundle is STALE", never as "the bundle is gone". `make run` right
# afterwards serves yesterday's bundle with a status 200 and nothing in the log.
#
# A new output gets a name here, a COPY line in the Dockerfile and a row in
# REQUIRED_PATHS — one commit, three edits.
UI_OUT   := static/_v
UI_FILES := hammerola.js

.DEFAULT_GOAL := help

# --- Help --------------------------------------------------------------------
.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# --- Environment -------------------------------------------------------------
# The project ALWAYS runs inside a local .venv. Every Python target depends on
# the virtualenv, so it is created automatically on first use and reused after —
# the system Python is never used directly.
#
# pip and pytest are invoked as `$(PY) -m pip` / `$(PY) -m pytest` rather than as
# the console scripts `$(VENV)/bin/pip` / `$(VENV)/bin/pytest`, and that is not a
# stylistic preference. A virtualenv is not relocatable: every console script in
# `.venv/bin/` carries the ORIGINAL absolute path of its interpreter in its
# shebang line, baked in at creation time. So a `.venv` that arrived by being
# COPIED or MOVED rather than created here — a duplicated project folder, a
# restored backup, a checkout renamed after the venv was made, a `cp -r` used to
# "start from the working one" — keeps pointing at the interpreter of the
# directory it came from, and which of two failures that produces depends on
# whether that interpreter is still there:
#
#  * It still exists — the `cp -r` and the duplicated folder, where the original
#    is sitting right next to the copy. This is the dangerous one, because it
#    SUCCEEDS: `.venv/bin/pip install` installs into THAT environment and
#    `.venv/bin/pytest` imports from it, every line on screen says success, the
#    packages land in another project's site-packages, and this project goes on
#    running against whatever it had before — which is how a dependency bump
#    appears to be applied and simply is not.
#  * It does not — the renamed checkout and the restored backup, where the path
#    in the shebang no longer names anything. This one is loud and harmless:
#    `.venv/bin/pip` fails immediately with `bad interpreter: No such file or
#    directory`, which looks alarming and is in fact the good outcome, because
#    nothing was silently installed anywhere.
#
# `$(PY) -m pip` fixes both: it has no shebang to be stale and always acts on the
# interpreter it is run with, so it either does the right thing or fails loudly
# because $(PY) itself is missing.
.PHONY: venv
venv: $(VENV)/bin/python ## Create the local virtualenv (.venv) if missing

$(VENV)/bin/python:
	python3 -m venv $(VENV)

# Sentinel: dependencies are (re)installed only when a requirements file changes,
# not on every `make test` / `make run`.
$(VENV)/.deps-installed: requirements-dev.txt requirements.txt | $(VENV)/bin/python
	$(PIP) install -r requirements-dev.txt
	touch $@

.PHONY: install
install: $(VENV)/.deps-installed ## Create .venv (if missing) and install dev/test deps

.PHONY: env
env: ## Create .env from the template if it does not exist
	@test -f .env || cp .env.example .env

# --- The lock ----------------------------------------------------------------
# requirements.lock is the WHOLE resolved runtime environment — every distribution
# `==` pinned and hashed — compiled from requirements.txt, and it is the file the
# Dockerfile installs. This target is the only thing that writes it.
#
# MANUAL AND DELIBERATE. It is wired into nothing: not the image build, not either
# CI workflow, not `install`, not `test`. That is the whole purchase — with the lock
# in place a dependency moves only when somebody runs this and commits the diff, on a
# commit that can be read and reverted, instead of moving on whichever rebuild
# happened to run after PyPI did. A target that ran on its own, or a build step that
# recompiled the lock, would hand back exactly the drift the lock was bought to stop.
#
# IT RESOLVES FOR THE IMAGE'S PLATFORM, NEVER FOR THIS LAPTOP, and that is why there
# is a container here at all. pip-compile resolves against the interpreter and the
# platform it is running on: environment markers (`python_version`, `sys_platform`,
# `platform_machine`), which wheels exist, and therefore the versions themselves. Run
# on an arm64 mac against python 3.13 it would write a lock naming files that do not
# exist for linux/amd64 python 3.11 — and `--require-hashes` turns that into a failed
# image build rather than a silently different install, which is the good half of an
# otherwise wasted round trip. So it runs inside the same base image the Dockerfile
# uses, with --platform pinned to what the runner builds for, exactly as both CI
# workflows run the test suite inside that image.
#
# The tar over stdin is the same arrangement as those steps, for the same reasons: it
# is correct whatever the daemon is and wherever the checkout lives, and nothing in
# the container can write into the working tree. One file goes in — pip-compile reads
# requirements.txt and nothing else. The compiled lock comes back on stdout, which is
# why every other thing the container says (pip's install log, pip-compile's
# progress) is sent to stderr: a stray line on stdout would land in the file.
#
# THE PIP-TOOLS VERSION IS READ OUT OF requirements-dev.txt rather than written here.
# It is pinned there like every other dev dependency, and a second copy of a version
# that has to agree with the first is the drift this project keeps out everywhere
# else. Written nowhere twice, it cannot go stale. Only the VERSION is taken from
# there: the pip-tools `make install` puts into .venv is never run by anything — this
# target installs its own copy inside the container, because that is where the resolve
# has to happen. Removing it from requirements-dev.txt leaves the variable empty — `awk` with
# no match prints nothing and still exits 0 — and the target then dies one line later, on a
# `pip install` with no operand, with the old lock untouched. So it stays there as the single
# place the version is declared.
#
# EVERY RUN IS A FRESH RESOLVE, not an update of what the lock already says. The
# existing requirements.lock is not an input — it is not even in the tar — so the
# resolver starts from requirements.txt alone and is free to pick a newer release of
# anything this file does not pin, whatever the reason for running it was. A run
# meant to bump one package will move the others that have moved on PyPI since the
# last run, and that is the intended shape: the diff shows all of it and gets read
# before it is committed. What it is not is a way to bump one package in isolation.
#
# The output lands in a temporary and is renamed over the lock only after the whole
# pipeline succeeded, so a resolution that fails — an unsatisfiable pin, a network
# that dropped, an index that answered 500 — leaves the previous lock exactly where it
# was instead of truncating it to nothing. The `trap` takes the temporary with it,
# Ctrl-C included; its name carries the lock's own prefix so a leftover is obvious in
# `git status` rather than hidden behind a dot.
#
# EXPECT IT TO BE SLOW AND HEAVY, and do not read that as something being stuck:
# `--generate-hashes` hashes the FILES, so pip-compile fetches every distribution it
# pins — every wheel of every platform for each one, and the OpenCASCADE binding alone
# is ~271 MB apiece. Measured once, on an arm64 laptop running the amd64 image under
# emulation: about half an hour and some 13 GB pulled, with nothing printed until the
# lock appears at the end. This runs when a dependency is deliberately bumped, which is
# the whole reason that cost is affordable.
LOCK_IMAGE    := python:3.11-slim
LOCK_PLATFORM := linux/amd64

.PHONY: lock
lock: ## Regenerate requirements.lock from requirements.txt (resolved inside the image's base)
	piptools=$$(awk '/^pip-tools==/ {print $$1}' requirements-dev.txt); \
	tmp=requirements.lock.tmp.$$$$; \
	trap 'rm -f "$$tmp"' EXIT; \
	tar -cf - requirements.txt \
	  | docker run --rm -i --pull always --platform $(LOCK_PLATFORM) \
	      -e PIP_DISABLE_PIP_VERSION_CHECK=1 \
	      $(LOCK_IMAGE) \
	      sh -c "set -e; mkdir -p /src; tar -xf - -C /src; cd /src; \
	             pip install --no-cache-dir $$piptools 1>&2; \
	             pip-compile --quiet --generate-hashes \
	               --output-file requirements.lock requirements.txt 1>&2; \
	             cat requirements.lock" > "$$tmp" \
	  && mv -f "$$tmp" requirements.lock

# --- Develop -----------------------------------------------------------------
# BOTH suites, and the JS half is conditional on npm being installed — a machine
# without node must still be able to test and run the service (the `ui` target
# below has the full reasoning: node is not part of this project's toolchain, the
# image builds the bundle in a stage of its own, and nothing under src/ imports
# anything from ui/).
#
# THE SKIP IS ANNOUNCED, and that is the entire reason this is written out rather
# than as `-cd ui && npm test`. A suite that quietly disappears makes the run
# GREEN BECAUSE IT CHECKED LESS, which is the failure this project chases
# everywhere else — it is why ci/smoke.py counts its own verdicts and why the two
# workflows keep a whitelist of identical step bodies. The message therefore names
# what did not run, where it lives and how to get it back; "skipped" on its own
# would be another way of saying nothing.
#
# `$(MAKE) ui-test` rather than a prerequisite, because a prerequisite is exactly
# what cannot work here: `ui-test` needs ui/node_modules, whose rule begins with
# $(REQUIRE_NPM) and exits 1 — make would try to BUILD it on a machine with no
# npm and fail before the branch below ever ran.
define RUN_JS_TESTS
if command -v npm >/dev/null 2>&1; then \
		$(MAKE) --no-print-directory ui-test; \
	else \
		echo ""; \
		echo "make test: SKIPPED the JS suite in ui/tests — npm was not found."; \
		echo "           The Python suite above ran in full; the browser half did"; \
		echo "           not run at all. Install Node.js (>= 22.12) and re-run, or"; \
		echo "           run 'make ui-test' where it is available. CI runs both."; \
	fi
endef

.PHONY: test
test: install ## Run both test suites: pytest always, the JS suite when npm is present
	$(PYTEST)
	@$(RUN_JS_TESTS)

# --- The six tests CI cannot run ----------------------------------------------
# `libgl1` is deliberately NOT in the CI test container (issue #27, decided
# 2026-08-31): it would buy six tests, four of which compute real geometry, at
# the price of ~222 MB of OCCT mapped on import and a `--memory` ceiling that
# would have to be measured again. The cost of that decision is named in the
# issue and it is real — a change to `src/cadbuild/views.py` or `assembly.py`
# that moves the payload's shape rides through a green CI, while vitest goes on
# checking the browser half against `ui/tests/fixtures/assembled.json`, a
# document no build produces any more. This target is the hand that catches it,
# and "we catch it by hand" without one means we do not catch it.
#
# THE TARGET FAILS WHEN A TEST SKIPS, which is the whole point: run on a machine
# with no kernel, all six would skip and pytest would exit 0 — a green run that
# checked nothing, which is the same failure `make test` announces the JS skip
# for and `ci/smoke.py` counts its own verdicts against. A rotted node id is
# caught by pytest itself ("ERROR: not found"), loudly, for the same reason.
CAD_TESTS := \
	tests/cadbuild/test_views.py::test_a_real_export_is_a_document_the_hub_would_accept \
	tests/test_view_fixture.py::test_the_exporter_still_produces_the_committed_structure \
	tests/buildproc/test_build_child.py::test_a_simple_model_builds_and_reports_what_it_wrote \
	tests/buildproc/test_build_child.py::test_the_occt_pool_is_capped_before_the_model_runs \
	tests/cadbuild/test_shapediff.py::test_two_real_step_files_measure_the_change_between_them \
	tests/cadbuild/test_comparescene.py::test_a_real_difference_is_drawn_in_the_part_coordinates_and_placed

.PHONY: cad-test
cad-test: install ## Run the six tests that need the CAD kernel — CI skips them (#27)
	@out=$$($(PYTEST) -q -rs $(CAD_TESTS) 2>&1); status=$$?; \
	printf '%s\n' "$$out"; \
	if printf '%s' "$$out" | grep -qi 'skipped'; then \
		echo ""; \
		echo "make cad-test: FAILED — a test skipped, so nothing was checked."; \
		echo "               These five exist to run on a machine that HAS the CAD"; \
		echo "               kernel; CI has none on purpose (issue #27). Install the"; \
		echo "               kernel here, or run this where it imports."; \
		exit 1; \
	fi; \
	exit $$status

.PHONY: run
run: install ## Run the application (auto-creates .venv if missing)
	$(PY) main.py

# --- The client --------------------------------------------------------------
# THERE IS NO `client` TARGET, AND IT IS NOT MISSING — it was removed, and this
# note is what keeps it from being helpfully added back.
#
# It ran `ln -sf $(CURDIR)/bin/hammerola ~/.local/bin/hammerola`: a symlink INTO
# the checkout, so the command followed the working copy. The hub's own bootstrap
# writes the tool to the same name — `curl -fsSL <hub>/start/hammerola -o
# ~/.local/bin/hammerola` — and `curl -o` writes THROUGH a symlink, into its
# target. So on a machine that had run this target, the downloaded zipapp landed
# on top of `bin/hammerola` IN THE REPOSITORY: the link stayed a link, the
# command went on working, and nothing said a word. It surfaced as "git status
# says the client is modified" (measured, not supposed). `bin/hammerola` went
# with the target — it existed only to be linked, and the zipapp is built from
# `hammerola/` and never from it.
#
# One name, one place it is installed from: the hub (README). Whoever is WORKING
# on the client runs it out of the checkout instead, with no venv and nothing to
# build, because this package imports the standard library and nothing else:
#
#     python3 -m hammerola -C <model dir> status
#
# STARTED HERE, IN THE CHECKOUT ROOT, which is why the model directory is an
# argument rather than the shell's cwd: `-m` resolves `hammerola` against the
# directory the command was started in, so the same line run inside a model
# fails with `No module named 'hammerola'`. From inside the model it is
# `PYTHONPATH=$(CURDIR) python3 -m hammerola status` instead. There is no target
# for either — a target would be a fourth place the same two lines are written,
# and the failure it would head off is one message that says exactly what is
# wrong. `hammerola/__main__.py` has the whole argument, and `make test` is what
# holds it.
#
# THE PACKAGE HAS A DISTRIBUTION NAME NOW (`pyproject.toml`), so `pip install .`
# would work — and there is deliberately no target for that either: installing
# the tool from the checkout is the collision above wearing different clothes,
# and the hub is still the one place it is installed from.

# --- Frontend ----------------------------------------------------------------
# The browser bundle is BUILT, never committed — see .gitignore for why — so it
# has to be produced twice, by two toolchains that must not disagree: here for a
# workstation, and by the Dockerfile's `ui` stage for the image. This target is
# the workstation half.
#
# DELIBERATELY NOT A PREREQUISITE of `run` or `test`, and that is a decision
# rather than an omission. node is not part of this project's toolchain: the
# image builds the bundle in a stage of its own and the Python side neither
# imports nor executes anything from `ui/`. Wiring this into `run` would make a
# machine without node unable to START THE SERVICE — over one static asset, on a
# service whose actual job is receiving pushes and computing geometry. So
# building the UI is an explicit step, and `make run` on a machine that never
# ran it serves the page without the React mount while the existing viewer keeps
# working.
#
# npm is needed by the frontend recipes and by nothing else here, so the check is
# written once and invoked from each of them — it has to be the FIRST thing any of
# them does, because the alternative failure is npm's own "command not found",
# which says nothing about node being optional in this project.
#
# `$@` rather than a fixed target name: the same check now guards `ui`, `ui-test`
# and the node_modules rule, and a message naming the wrong one of them sends the
# reader to the wrong place.
#
# This is a REFUSAL, and `make test` deliberately does not use it — asking for a
# frontend target on a machine with no node is an error, while running the whole
# suite there is not. That difference is the reason RUN_JS_TESTS above exists as a
# separate block instead of calling this one.
define REQUIRE_NPM
command -v npm >/dev/null 2>&1 || { \
		echo "make $@: npm not found. Install Node.js (>= 22.12) for the frontend targets."; \
		echo "         Only they need it — the docker image builds the bundle in a stage of"; \
		echo "         its own, 'make run' does not use node, and 'make test' runs the Python"; \
		echo "         suite and says out loud that it skipped the JS one."; \
		exit 1; }
endef

# Sentinel for the node dependencies, the same arrangement as $(VENV)/.deps-installed
# above and for a sharper reason: `npm ci` DELETES node_modules and reinstalls it
# from scratch, so running it unconditionally spends tens of seconds on the most
# frequent iteration this target has — editing one component. npm writes
# node_modules/.package-lock.json itself at the end of an install, describing what
# it just installed, so it is a truthful stamp and needs no `touch`.
#
# `npm ci` rather than `npm install`: it installs the committed lockfile exactly
# and fails when package.json disagrees with it, instead of quietly resolving
# something else and rewriting the lockfile as a side effect of a build. The
# fallback exists only so a checkout that somehow lost the lockfile still
# builds; it is not the normal path — the lockfile is committed.
#
# That fallback is why the lockfile is a prerequisite through $(wildcard) instead
# of by name. Named directly, a checkout without it would leave this rule
# depending on a file no rule can build, and make would stop with "No rule to make
# target 'ui/package-lock.json'" — a worse outcome than the fallback, since the
# recipe handles that case perfectly well. Through $(wildcard) the missing name
# expands to nothing, the rule keeps its remaining prerequisite, and the recipe
# takes its `npm install` branch.
ui/node_modules/.package-lock.json: ui/package.json $(wildcard ui/package-lock.json)
	@$(REQUIRE_NPM)
	cd ui && if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Each file is copied to a temporary name IN THE DESTINATION DIRECTORY and then
# renamed over its predecessor. A plain `cp` truncates and rewrites in place, so a
# `make ui` run while `make run` is serving hands out whatever had been written by
# then — `_serve_asset` in src/app.py opens the file, fstats it and streams it in
# chunks, so a half-written bundle goes out with status 200 and nothing logged
# anywhere. Removing the file first, which this target used to do, closes only one
# of the two windows: a request that had ALREADY opened the file keeps its inode
# and finishes intact, but one arriving mid-copy opens the new inode and reads a
# truncated file. A rename closes both at once — it is atomic, so every reader
# gets either the whole old file or the whole new one.
#
# The temporary sits in $(UI_OUT) rather than in /tmp because rename is only
# atomic WITHIN a filesystem; across one it degrades into exactly the copy this is
# avoiding.
#
# ITS NAME KEEPS THE PREFIX OF THE FILE IT REPLACES — `hammerola.js.tmp.<pid>` —
# and that is load-bearing, not cosmetic. `static/_v/hammerola*` is the glob in
# BOTH .gitignore and .dockerignore, so a temporary an interrupted run left behind
# is already untracked-and-ignored and already outside the build context. A name
# beginning with a dot, which this used to use, is matched by NEITHER net: nothing
# stops `.hammerola.js.tmp` from riding into the next `git add -A`, and nothing
# stops `COPY static/ static/` from baking it into the image as a slice of a bundle
# no commit accounts for and no check ever looks at. The dot bought exactly one
# thing — `_safe_name` in src/app.py rejects a leading dot, so the file could not be
# fetched over HTTP — and that is the smaller worry by a wide margin: a file that
# exists for milliseconds and is reachable only by guessing a pid, against a stray
# artefact that lives forever in a commit and in a published image.
#
# The pid suffix is what keeps two concurrent `make ui` runs from writing the same
# temporary and then atomically publishing a mixture of the two.
#
# The `trap` deletes the temporary when the shell running this line goes away —
# including a Ctrl-C in the middle of a copy, which otherwise leaves a partial
# bundle in static/_v/ for good, since `make clean` only knows about the venv and
# the Python caches. Each recipe line is its own shell, so one trap covers the whole
# loop and nothing outside it. It does not change the failure path: the `exit 1`
# below still reaches make as Error 1, with the half-written temporary removed.
#
# Still name by name, never a glob and never `cp -R`: static/_v/ also holds
# committed assets that only a fresh checkout could bring back.
.PHONY: ui
ui: ui/node_modules/.package-lock.json ## Build the browser bundle from ui/ into static/_v/
	@$(REQUIRE_NPM)
	cd ui && npm run build
	mkdir -p $(UI_OUT)
	for f in $(UI_FILES); do \
		tmp=$(UI_OUT)/$$f.tmp.$$$$; \
		trap 'rm -f "$$tmp"' EXIT; \
		cp ui/dist/$$f "$$tmp" && mv -f "$$tmp" $(UI_OUT)/$$f || exit 1; \
	done

# The JS suite: vitest over ui/tests, in jsdom. It covers the halves of the
# `<hmr-viewport>` adapter that have no GPU in them — the camera arithmetic, the
# zoom law, the section plane's algebra, the part tree, the state diffing and the
# hold key — plus the one thing the interface stores for somebody else to read,
# the remembered pointer in ui/src/store.js. What only a GPU can answer for (does
# the pixel under the cursor stay put, does the cut land on the face that was
# clicked) is not here and is not meant to be.
#
# A REFUSAL rather than a skip when npm is missing, unlike `make test`: this
# target was asked for by name, so it cannot silently do nothing.
#
# It reads ui/tests/fixtures/assembled.json, which is COMMITTED — see
# `ui-fixture` below for why, and for how to regenerate it.
.PHONY: ui-test
ui-test: ui/node_modules/.package-lock.json ## Run the JS test suite (vitest + jsdom)
	@$(REQUIRE_NPM)
	cd ui && npm test

# The fixture the JS suite reads, regenerated by the REAL exporter — the same
# calls `src/cadbuild/build.py` runs a push through, so the payload under
# test is output rather than an impression of it. Committed rather than generated
# at test time, because the JS suite runs in a node container in CI where there
# is no Python and no CAD kernel; the generator's docstring has the rest.
#
# Needs the kernel, so it hangs off `install` — and this is the only target in
# the frontend section that needs no node at all.
#
# Run it, read the diff, then commit the result. A diff bigger than a few floats
# after an unrelated change is the drift the whole arrangement exists to make
# visible, and is worth reading rather than committing blind.
.PHONY: ui-fixture
ui-fixture: install ## Regenerate the JS test fixture with the real exporter
	$(PY) ui/tests/fixtures/make_fixture.py

# The same generation, plus a real build published into data/ through the hub's
# own Store, so `make run` has something to show at
# http://<host>/project/fixture0000/dev/ — the direct URL, because the `dev` slot
# is deliberately kept out of the index (SPEC 7.6) and the front page will not
# list it. For looking at the interface by hand; the JS suite does not use it.
.PHONY: ui-fixture-data
ui-fixture-data: install ## ...and publish it into data/ as a build `make run` can serve
	$(PY) ui/tests/fixtures/make_fixture.py --data data

# --- Housekeeping ------------------------------------------------------------
.PHONY: clean
clean: ## Remove the venv and Python caches
	rm -rf $(VENV) .pytest_cache
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
