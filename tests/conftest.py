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
import threading

# Provide the required credentials BEFORE any test module imports src.settings
# (Settings() is instantiated at import time and would otherwise fail). CI arrives at the same
# state by a different route, and `setdefault` is what makes the two compose: the test step in
# both workflows passes `-e PUBLISH_TOKEN=...` on the `docker run` that starts the suite's
# container, inside the step's `run:` body — so the variable is already in the environment
# before pytest is invoked and this line leaves CI's value alone. It is NOT injected through a
# workflow `env:` block: those carry the container names, RUNTIME_IMAGE and the smoke gate's
# SMOKE_* variables, none of which the suite reads.
os.environ.setdefault("PUBLISH_TOKEN", "test-token")
# The second credential, for the same reason and by the same route: the comment
# queue is public to write and token-guarded to read (SPEC 7A.2), so Settings()
# requires COMMENT_READ_TOKEN too and importing src.settings without it fails.
os.environ.setdefault("COMMENT_READ_TOKEN", "test-read-token")

import pytest  # noqa: E402  (must come after the env assignment above)

from harness import start_hub, stop_hub  # noqa: E402
from process_limits import rlimits as _rlimits  # noqa: E402
from src.jobs import WORKER_THREAD_PREFIX  # noqa: E402


def _live_build_workers():
    return sorted(thread.name for thread in threading.enumerate()
                  if thread.name.startswith(WORKER_THREAD_PREFIX))


@pytest.fixture(autouse=True)
def guard_build_workers():
    """Fail the test that leaves a build pool running, not the one after it.

    The convention this implements is the project's rule about module-level
    mutable state, pointed at the only thing in `src/jobs.py` that HAS process
    scope. The registry and the queue deliberately do not: both are built per
    server, exactly like `Store` and `CommentStore`, so two hubs in one test
    process share neither. The worker THREADS are the exception — they belong to
    the interpreter, they outlive the fixture that made them if nobody stops
    them, and a hub that is never closed leaves two of them polling a queue
    nothing will ever put anything into.

    Before AND after, because before-only is the version that puts the blame in
    the wrong place: a test that leaks a pool passes, and the failure surfaces
    later, in whichever test happened to run next.
    """
    assert _live_build_workers() == [], (
        "build workers were already running when this test started, so an "
        "EARLIER test left a hub open; this test is where it surfaced, not "
        "where it was caused")
    yield
    assert _live_build_workers() == [], (
        "this test left build workers running — a hub was started and never "
        "closed. Without this assertion the failure would have landed on some "
        "unrelated test later, in another file, under one collection order")


# --- Process-level state: the rlimits ------------------------------------------------------
# The project's rule about module-level mutable state, pointed one level out at state that
# belongs to the PROCESS. It is the same failure with a worse ending: a test that dirties it
# passes, and something unrelated dies later — except that here "dies" can mean SIGKILL, so
# there is no traceback naming even the victim.
#
# WHICH ceilings `_rlimits()` reads is not decided here, and deliberately not:
# `process_limits.WATCHED_RLIMITS` IS `src.buildproc.limits.RLIMIT_NAMES`, i.e. exactly the
# table `apply_process_limits` walks. Written out here instead, the two would drift apart in
# silence — a seventh ceiling added to limits.py would be applied and not watched — and that
# module carries the rest of the reasoning, including why no `hasattr` filter narrows the set.
# `tests/test_process_limits_guard.py` is what fails if this guard ever watches less than the
# wrapper sets.
#
# Snapshotted at import — before pytest has run a single test — and compared against rather
# than against "unlimited", because a process inherits whatever started it and what it
# inherits is FINITE: measured on this workstation (darwin, 2026-08-26) the shell hands down
# RLIMIT_NPROC=(5333, 8000) and RLIMIT_CORE=(0, unlimited), and the CI container starts from
# the docker daemon's own defaults instead, which are a different set again. The question this
# guard asks is "did a TEST change one", not "are they infinite".
#
# Early ON PURPOSE, and not to be moved down into the fixture: taken at the first test
# instead, it would compare against limits that an IMPORTED test module had already changed
# and report nothing. That case is precisely the one worth catching, so the before-branch
# below has to blame "a test, or something imported during collection" rather than a test.
_RLIMITS_AT_IMPORT = _rlimits()

_RLIMITS_DIRTIED = (
    "the test process is no longer running under the rlimits it started with:\n"
    "  at import: {before}\n"
    "  now:       {after}\n"
    "Something applied ceilings to the test process ITSELF — "
    "`src.buildproc.limits.apply_process_limits` is the one in this repository, and it "
    "really does call `resource.setrlimit` on the process it runs in. TREAT IT AS ONE-WAY: "
    "it sets soft == hard on purpose, and an unprivileged process may not raise its own hard "
    "limit back (`ValueError: not allowed to raise maximum limit`), so no fixture teardown "
    "helps where it matters — a workstation, and the image, where everything runs as `app`. "
    "The CI container is the exception and not a way out: it runs the suite as root (no "
    "`--user` on the `docker run` in .gitea/workflows/tests.yml), where raising a hard limit "
    "back is permitted — do not build on that, it makes the suite pass in the one place the "
    "code under test never runs. What happens next if this assertion is removed: the WHOLE "
    "REMAINING SUITE shares that one budget and is killed by the kernel when it runs out — "
    "for RLIMIT_CPU that is SIGKILL, i.e. `Killed`, exit 137, no traceback, in whichever test "
    "happened to be running, and it reads exactly like an out-of-memory. Apply ceilings in a "
    "CHILD process instead; tests/buildproc/test_ceilings.py::_applied_in_a_process_of_its_own "
    "is how.")


@pytest.fixture(autouse=True)
def guard_process_limits():
    """Fail the test that fences in the test process, not the one the kernel kills.

    Before AND after, for the reason written above `guard_build_workers` and with one
    aggravating factor: the test this catches after itself is not merely the culprit, it is
    the ONLY place the culprit can still be named. Once the budget is spent the interpreter
    is gone mid-test, so a before-only check would report the tail of the suite, forever, as
    the thing that broke.
    """
    before = _rlimits()
    assert before == _RLIMITS_AT_IMPORT, (
        "an EARLIER test — or something imported while pytest was COLLECTING, since the "
        "snapshot is taken when this conftest is imported and that is before any test module "
        "is — already changed this process's rlimits. This test is where it surfaced, not "
        "where it was caused.\n"
        + _RLIMITS_DIRTIED.format(before=_RLIMITS_AT_IMPORT, after=before))
    yield
    after = _rlimits()
    assert after == _RLIMITS_AT_IMPORT, (
        "THIS test changed the rlimits of the test process itself.\n"
        + _RLIMITS_DIRTIED.format(before=_RLIMITS_AT_IMPORT, after=after))


@pytest.fixture
def rlimit_guard_snapshot():
    """What `guard_process_limits` above actually compares against, for its own test.

    Exposed as a fixture because a test module cannot import this conftest safely — three
    directories under tests/ have one and all three land on sys.path, so `import conftest`
    picks whichever pytest inserted first. The test on the other end is what makes the guard's
    OWN silent-failure mode visible: a watch set that has drifted from the ceilings
    `apply_process_limits` applies, or one that has emptied, guards nothing and says nothing.
    """
    return dict(_RLIMITS_AT_IMPORT)


@pytest.fixture
def hub(tmp_path):
    """A live hub on an ephemeral port, with its own empty data directory.

    Function-scoped on purpose: publication mutates a directory tree, a symlink
    and two index files, so tests that shared one hub would depend on collection
    order the moment one of them published anything.
    """
    instance = start_hub(tmp_path / "data")
    try:
        yield instance
    finally:
        stop_hub(instance)


@pytest.fixture
def hub_factory(tmp_path):
    """For tests that need a hub configured differently (size caps, mostly)."""
    started = []

    def make(**kw):
        instance = start_hub(tmp_path / f"data{len(started)}", **kw)
        started.append(instance)
        return instance

    try:
        yield make
    finally:
        for instance in started:
            stop_hub(instance)


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
