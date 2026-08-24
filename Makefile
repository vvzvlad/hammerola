# Makefile — single entry point for every repeated action in this project.
# Run `make` (or `make help`) to list the available targets.
#
# All routine commands (environment setup, tests, run, docker build/push) live
# here so they stay documented, consistent and hard to get wrong. Prefer adding
# a target over writing a one-off command in the shell or in CI.

# --- Configuration -----------------------------------------------------------
VENV   ?= .venv
PY     := $(VENV)/bin/python
PIP    := $(PY) -m pip
PYTEST := $(PY) -m pytest

.DEFAULT_GOAL := help

# --- Help --------------------------------------------------------------------
.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

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

# --- Develop -----------------------------------------------------------------
.PHONY: test
test: install ## Run the test suite (auto-creates .venv if missing)
	$(PYTEST)

.PHONY: run
run: install ## Run the application (auto-creates .venv if missing)
	$(PY) main.py

# --- Housekeeping ------------------------------------------------------------
.PHONY: clean
clean: ## Remove the venv and Python caches
	rm -rf $(VENV) .pytest_cache
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
