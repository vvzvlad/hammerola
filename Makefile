# Makefile — single entry point for every repeated action in this project.
# Run `make` (or `make help`) to list the available targets.
#
# Prefer adding a target over writing a one-off command in the shell or in CI.
# There is no image target on purpose: tags, the gate and the push belong to
# .gitea/workflows/image-check-publish.yml.

# --- Configuration -----------------------------------------------------------
VENV   ?= .venv
PY     := $(VENV)/bin/python
PIP    := $(PY) -m pip
PYTEST := $(PY) -m pytest

# Where the built browser bundle lands, and exactly which files it consists of.
# These must agree with templates/build.html's <script src>, the Dockerfile's
# `COPY --from=ui` lines, REQUIRED_PATHS in ci/smoke.py and vite's output names;
# tests/test_ui_bundle.py reads these lines to check the others against them.
# The output goes flat into static/_v/ because the hub serves `/_v/<one path
# component>` only (`_serve_asset`/`_safe_name` in src/app.py).
# UI_FILES is an explicit list: built and committed files share the directory, so a
# `cp -R` could let a chunk named e.g. `pointer.js` overwrite the hub's own. A build
# that stops producing a listed file fails the `cp`, and because the publish is atomic
# the previous file stays in place: a red `make ui` means the bundle is stale.
# A new output needs a name here, a COPY line in the Dockerfile and a row in
# REQUIRED_PATHS.
UI_OUT   := static/_v
UI_FILES := hammerola.js

# The viewer library's outputs, published into the same directory by the same rules.
# three is outside the viewer bundle (`external: three`), so the page shares one
# instance; three.module.js imports ./three.core.js, so both are copied with their
# names. Unminified on purpose: picking.js and the hatch/outline tests read three's
# source.
VIEWER_FILES := three-cad-viewer.esm.js three-cad-viewer.css
VIEWER_THREE := three.module.js three.core.js

# The KiCad viewer's outputs, published by the same rules: the element, and the parser
# worker it starts from beside its own URL, which is why both keep their names.
ECAD_FILES := ecad-viewer.js parser.worker.js

.DEFAULT_GOAL := help

# --- Help --------------------------------------------------------------------
.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# --- Environment -------------------------------------------------------------
# The project ALWAYS runs inside a local .venv, created on first use; the system
# Python is never used directly.
# pip and pytest run as `$(PY) -m ...` rather than `.venv/bin/pip`: console scripts
# carry their interpreter's absolute path in the shebang, so a copied or moved .venv
# would install into another project's environment or fail with `bad interpreter`.
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
# requirements.lock is the whole resolved runtime environment, every distribution
# `==` pinned and hashed, compiled from requirements.txt; the Dockerfile installs it.
# Manual and deliberate: nothing else runs this target, so a dependency moves only on
# a reviewed commit.
# It resolves inside the image's base with --platform pinned, because pip-compile
# resolves for the platform it runs on. Only requirements.txt goes in over stdin; the
# lock comes back on stdout, so everything else the container prints goes to stderr.
# The pip-tools version is read from requirements-dev.txt (single place it is pinned).
# Every run is a fresh resolve from requirements.txt alone, so it may move any
# unpinned package; read the diff before committing.
# Output goes to a temporary renamed over the lock only on success; the `trap`
# removes it on failure or Ctrl-C.
# Slow and heavy: `--generate-hashes` downloads every wheel it pins (about half an
# hour and ~13 GB under emulation on an arm64 laptop).
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
# Both suites; the JS one runs only when npm is installed, since node is not part of
# the project's toolchain. The skip is announced so a run never goes green by
# silently checking less. `$(MAKE) ui-test` rather than a prerequisite, because the
# node_modules rule refuses without npm and make would fail before the branch.
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

# --- The six tests that need the CAD kernel -----------------------------------
# CI runs them too (ci/Dockerfile.test carries the kernel's libraries); this target is
# for the edit-run loop on the export half. It fails when a test skips, because on a
# machine without the kernel all six would skip and pytest would exit 0.
CAD_TESTS := \
	tests/cadbuild/test_views.py::test_a_real_export_is_a_document_the_hub_would_accept \
	tests/test_view_fixture.py::test_the_exporter_still_produces_the_committed_structure \
	tests/buildproc/test_build_child.py::test_a_simple_model_builds_and_reports_what_it_wrote \
	tests/buildproc/test_build_child.py::test_the_occt_pool_is_capped_before_the_model_runs \
	tests/cadbuild/test_shapediff.py::test_two_real_step_files_measure_the_change_between_them \
	tests/cadbuild/test_comparescene.py::test_a_real_difference_is_drawn_in_the_part_coordinates_and_placed

.PHONY: cad-test
cad-test: install ## Run just the six tests that need the CAD kernel (CI runs them too)
	@out=$$($(PYTEST) -q -rs $(CAD_TESTS) 2>&1); status=$$?; \
	printf '%s\n' "$$out"; \
	if printf '%s' "$$out" | grep -qi 'skipped'; then \
		echo ""; \
		echo "make cad-test: FAILED — a test skipped, so nothing was checked."; \
		echo "               These six need the CAD kernel, and it does not import"; \
		echo "               on this machine. Install it here, or run this where it"; \
		echo "               does — CI's test container has it (issue #27)."; \
		exit 1; \
	fi; \
	exit $$status

.PHONY: run
run: install ## Run the application (auto-creates .venv if missing)
	$(PY) main.py

# --- The client --------------------------------------------------------------
# There is no `client` target on purpose. The hub's bootstrap writes the tool to
# ~/.local/bin/hammerola with `curl -o`, which writes through a symlink, so linking
# that name into the checkout lets a download overwrite repository files. The client
# is installed from the hub (README); to work on it, run it from the checkout root
# (it imports only the standard library):
#
#     python3 -m hammerola -C <model dir> status
#
# From inside a model directory it is `PYTHONPATH=$(CURDIR) python3 -m hammerola status`.
# See hammerola/__main__.py.

# --- Frontend ----------------------------------------------------------------
# The browser bundle is built, never committed: here for a workstation, and by the
# Dockerfile's `ui` stage for the image. Not a prerequisite of `run` or `test`: node
# is not part of the project's toolchain, and without the bundle `make run` still
# serves the page with the existing viewer.
# REQUIRE_NPM is the first thing every frontend recipe runs, so a missing npm gets a
# message saying node is optional instead of "command not found". `$@` names the
# target that asked. `make test` uses RUN_JS_TESTS instead, because there a missing
# npm is a skip, not an error.
define REQUIRE_NPM
command -v npm >/dev/null 2>&1 || { \
		echo "make $@: npm not found. Install Node.js (>= 22.12) for the frontend targets."; \
		echo "         Only they need it — the docker image builds the bundle in a stage of"; \
		echo "         its own, 'make run' does not use node, and 'make test' runs the Python"; \
		echo "         suite and says out loud that it skipped the JS one."; \
		exit 1; }
endef

# Sentinel for the node dependencies: `npm ci` deletes and reinstalls node_modules, so
# it runs only when package.json or the lockfile changes. npm writes
# node_modules/.package-lock.json itself, so it needs no `touch`.
# `npm ci` installs the committed lockfile exactly; the `npm install` fallback is for a
# checkout without a lockfile, which is why the lockfile is a prerequisite through
# $(wildcard) (named directly, make would stop with "No rule to make target").
ui/node_modules/.package-lock.json: ui/package.json $(wildcard ui/package-lock.json)
	@$(REQUIRE_NPM)
	cd ui && if [ -f package-lock.json ]; then npm ci; else npm install; fi

# The same sentinel arrangement for the vendored library.
# `--legacy-peer-deps` is required: `postprocessing@6.39.0` declares a peer range of
# `>= 0.168.0 < 0.184.0` while the library pins `three@0.184.0`, and npm refuses that
# outright. The lockfile still pins every version.
viewer/node_modules/.package-lock.json: viewer/package.json $(wildcard viewer/package-lock.json)
	@$(REQUIRE_NPM)
	cd viewer && if [ -f package-lock.json ]; then npm ci --legacy-peer-deps; \
		else npm install --legacy-peer-deps; fi

# And for the KiCad viewer, whose one package.json and lockfile stand at the root of
# ecad-viewer/.
ecad-viewer/node_modules/.package-lock.json: ecad-viewer/package.json $(wildcard ecad-viewer/package-lock.json)
	@$(REQUIRE_NPM)
	cd ecad-viewer && if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Each file is copied to a temporary in the destination directory and renamed over its
# predecessor, so a running `make run` serves either the whole old file or the whole new
# one (a plain `cp` would serve a truncated bundle with status 200). Same directory,
# because rename is only atomic within a filesystem.
# The temporary keeps the file's prefix (`hammerola.js.tmp.<pid>`), so a leftover is
# matched by the `static/_v/hammerola*` glob in .gitignore and .dockerignore; the pid
# keeps concurrent runs apart. The `trap` removes it on failure or Ctrl-C.
# Name by name, never a glob or `cp -R`: static/_v/ also holds committed assets.
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

# Unlike `make ui`, this output is committed: the library changes only on a deliberate
# rebase or patch, and the bundle is read by the test suite and served by a hub that
# never runs node. three's files are copied out of the install, not rebuilt.
.PHONY: viewer
viewer: viewer/node_modules/.package-lock.json ## Build the vendored CAD viewer (viewer/) into static/_v/
	@$(REQUIRE_NPM)
	cd viewer && SOURCEMAP=false npm run build
	mkdir -p $(UI_OUT)
	for f in $(VIEWER_FILES); do \
		tmp=$(UI_OUT)/$$f.tmp.$$$$; \
		trap 'rm -f "$$tmp"' EXIT; \
		cp viewer/dist/$$f "$$tmp" && mv -f "$$tmp" $(UI_OUT)/$$f || exit 1; \
	done
	for f in $(VIEWER_THREE); do \
		tmp=$(UI_OUT)/$$f.tmp.$$$$; \
		trap 'rm -f "$$tmp"' EXIT; \
		cp viewer/node_modules/three/build/$$f "$$tmp" \
			&& mv -f "$$tmp" $(UI_OUT)/$$f || exit 1; \
	done

# Committed, as the CAD viewer's output is and for the same reasons. The build is the
# fork's own script (packages/ecad-viewer-app/scripts/build.js), which writes into the
# app's build/ directory.
.PHONY: ecad
ecad: ecad-viewer/node_modules/.package-lock.json ## Build the vendored KiCad viewer (ecad-viewer/) into static/_v/
	@$(REQUIRE_NPM)
	cd ecad-viewer && npm run build
	mkdir -p $(UI_OUT)
	for f in $(ECAD_FILES); do \
		tmp=$(UI_OUT)/$$f.tmp.$$$$; \
		trap 'rm -f "$$tmp"' EXIT; \
		cp ecad-viewer/packages/ecad-viewer-app/build/$$f "$$tmp" \
			&& mv -f "$$tmp" $(UI_OUT)/$$f || exit 1; \
	done

# The JS suite: vitest over ui/tests, in jsdom, covering the GPU-free parts of the
# `<hmr-viewport>` adapter and the remembered pointer in ui/src/store.js.
# Refuses rather than skips without npm, since it was asked for by name.
# It reads the committed ui/tests/fixtures/assembled.json (see `ui-fixture`).
.PHONY: ui-test
ui-test: ui/node_modules/.package-lock.json ## Run the JS test suite (vitest + jsdom)
	@$(REQUIRE_NPM)
	cd ui && npm test

# The fixture the JS suite reads, regenerated by the real exporter (the same calls
# `src/cadbuild/build.py` makes). Committed because the JS suite runs in a node
# container in CI with no Python or CAD kernel. Needs the kernel, not node.
# Read the diff before committing: more than a few floats after an unrelated change is
# drift worth understanding.
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
