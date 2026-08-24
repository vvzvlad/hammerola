"""Test-session setup that has to happen BEFORE any test module is imported.

pytest imports this file ahead of collection, and that ordering is the whole reason the
environment assignment below works: `src.settings` builds its `Settings()` at import time, so
by the moment a test module's own `import` line runs, the variable it needed was already read
or already missing. Anything with that shape — configuration that is consumed at import, a
logging sink installed on import, an env var some library latches onto once — belongs here,
at MODULE level. A fixture would be too late: fixtures run after collection, i.e. after every
test module has already been imported.
"""

import os

# Provide the required credentials BEFORE any test module imports src.settings
# (Settings() is instantiated at import time and would otherwise fail). CI arrives at the same
# state by a different route, and `setdefault` is what makes the two compose: the test step in
# both workflows passes `-e PUBLISH_TOKEN=...` on the `docker run` that starts the suite's
# container, inside the step's `run:` body — so the variable is already in the environment
# before pytest is invoked and this line leaves CI's value alone. It is NOT injected through a
# workflow `env:` block: those carry the container names, RUNTIME_IMAGE and the smoke gate's
# SMOKE_* variables, none of which the suite reads.
os.environ.setdefault("PUBLISH_TOKEN", "test-token")


# --- Global-state guard: a pattern to copy, not code that runs ------------------------------
# Commented out ON PURPOSE, and the reason is that nothing in this skeleton needs it YET — not
# that there is nothing here it could be pointed at. There is, and the example below is written
# against it rather than against an invented module, so it can be uncommented as it stands:
# `src/settings.py` ends with `settings = load_settings_or_exit(Settings)`, which is a
# module-level singleton by definition, and a pydantic v2 model is mutable unless its
# model_config says `frozen=True` — this one does not. So `settings.log_level = "DEBUG"` inside
# a test is a perfectly ordinary-looking line that outlives that test and is seen by every test
# after it, in whatever order pytest happened to collect them.
#
# What is true today is narrower and worth stating exactly: the template's own two test files
# never touch that object. test_settings.py imports the Settings CLASS and builds fresh
# instances with `_env_file=None`; test_config_errors.py declares throwaway BaseSettings models
# of its own. Importing `src.settings` constructs the singleton and nothing then reads or
# writes it, so there is nothing to guard and an autouse fixture here would only cost every
# test in every copied project a pointless assertion. The moment a test in YOUR project assigns
# to a field of `settings` — or the project grows any other module-level state, a singleton
# client, a cache or registry, a connection pool, a monkeypatched attribute — uncomment this
# and widen it. Adapt this fixture rather than inventing a variant, so that every project in
# the fleet fails this class of bug the same way and the message is one somebody has read
# before.
#
# Why an assertion in a fixture rather than careful cleanup in the test that mutates: a test
# that dirties shared state and does not restore it PASSES. It has done its own job; the
# damage is invisible to it. The failure surfaces later, in some unrelated test that assumed a
# clean start — usually in a different file, frequently only under a particular collection
# order, and reliably never under `pytest path/to/that_one_test.py`, which is the first thing
# anybody tries. So the investigation starts from the victim and works backwards through
# everything that ran before it. The pre- and post-conditions below put the blame back on the
# test that actually did it, at the moment it does it.
#
# import pytest
#
# from src.settings import settings
#
# # Snapshotted at import — i.e. below the os.environ line above, which is what lets
# # `src.settings` be imported at all, and before pytest has run a single test. `model_dump()`
# # rather than the object itself because the object is the very thing being watched: keeping a
# # reference to it would compare it against itself and pass no matter what a test did to it.
# _SETTINGS_AT_IMPORT = settings.model_dump()
#
#
# @pytest.fixture(autouse=True)
# def guard_module_state():
#     """Fail the test that dirties shared state, not the one that trips over it."""
#     # BEFORE: if this fires, THIS test is the victim — something earlier left the mess.
#     assert settings.model_dump() == _SETTINGS_AT_IMPORT, (
#         "the src.settings.settings singleton was already modified when this test started, "
#         "so an EARLIER test left it behind; this test is where it surfaced, not where it "
#         "was caused")
#     yield
#     # AFTER: if this fires, this test is the culprit, and it is named in the failure.
#     assert settings.model_dump() == _SETTINGS_AT_IMPORT, (
#         "this test modified the src.settings.settings singleton and did not put it back. "
#         "Without this assertion the failure would have landed on some unrelated test later, "
#         "in another file, under one particular collection order")
