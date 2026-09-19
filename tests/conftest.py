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

# Provide the required credential BEFORE any test module imports src.settings
# (Settings() is instantiated at import time and would otherwise fail). CI arrives at the same
# state by a different route, and `setdefault` is what makes the two compose: the test step in
# both workflows passes `-e EDIT_TOKEN=...` on the `docker run` that starts the suite's
# container, inside the step's `run:` body — so the variable is already in the environment
# before pytest is invoked and this line leaves CI's value alone. It is NOT injected through a
# workflow `env:` block: those carry the container names, RUNTIME_IMAGE and the smoke gate's
# SMOKE_* variables, none of which the suite reads.
#
# ONE line, because there is one secret for the whole system (issue #26). There were two
# here — the comment queue used to have a credential of its own for reading, while writing to
# it took none at all.
os.environ.setdefault("EDIT_TOKEN", "test-token")

import pytest  # noqa: E402  (must come after the env assignment above)

from harness import start_hub, stop_hub  # noqa: E402
from process_limits import rlimits as _rlimits  # noqa: E402
from src import jobs, onboarding  # noqa: E402
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


# --- Module-level state: the caches in src/onboarding.py -----------------------------------
# The project's rule about module-level mutable state, pointed at the one module in `src/` that
# holds an answer a TEST can plant. Four of its five `lru_cache`s are what that module's
# docstring says they are — pure functions of files inside the image, which cannot change while
# the process runs. `_import_verdict` is different IN KIND, and it is the reason this guard
# exists: it caches the REFUSAL, i.e. "this image has no client to serve". Plant that once and
# every later test in the session gets a 404 from /start/hammerola, in files that never mention
# onboarding — and `monkeypatch` does not save anybody, because restoring the function the
# verdict was computed from does not unremember the verdict.
#
# It is guarded at the ROOT rather than in tests/test_onboarding.py, where the only test that
# plants one lives, precisely because the victim is somewhere else: a guard that only ran for
# that file would watch the culprit and not the damage.
#
# DERIVED FROM THE MODULE, not written out here, for the reason `process_limits.WATCHED_RLIMITS`
# is derived from the table `apply_process_limits` walks: a list kept by hand covers what
# somebody remembered on the day, and the fifth cache added over there would be guarded by
# nothing while this block went on looking complete. The names below are a FLOOR, not the list —
# they are what makes the DERIVATION itself fail loudly the day it stops finding things (a
# rename, an `@lru_cache` dropped), which is the failure a derived list has and a written one
# does not. A cache ADDED there needs no edit here and is watched from its first commit.
_ONBOARDING_CACHES_AT_LEAST = frozenset(
    {"skill_bytes", "client_bytes", "template_bytes", "_import_verdict"})

_ONBOARDING_PLANTED = (
    "{names} in src.onboarding {verb} a cached value that was NOT computed from this "
    "checkout, so something handed one of those functions a doctored input and the answer "
    "STUCK. `monkeypatch` cannot undo that: putting the function back does not unremember "
    "what it returned, and `_import_verdict` in particular then answers 'this image has no "
    "client' for the rest of the session — every later /start/hammerola is a 404. A test that "
    "plants one deliberately asks for the `onboarding_cache_sandbox` fixture, whose teardown "
    "clears them; this guard has cleared them now so that the blame stops here instead of "
    "landing on the next twenty tests.")


def _onboarding_caches():
    """{name: wrapper} for every `lru_cache` src.onboarding exposes, whatever they are."""
    found = {name: value for name, value in vars(onboarding).items()
             if hasattr(value, "cache_clear") and hasattr(value, "cache_info")}
    missing = _ONBOARDING_CACHES_AT_LEAST - set(found)
    assert not missing, (
        f"src.onboarding no longer exposes {sorted(missing)} as an lru_cache, so this guard is "
        f"watching less than it claims to and would go on passing in silence. If the change "
        f"was deliberate, edit _ONBOARDING_CACHES_AT_LEAST in the same commit.")
    return found


@pytest.fixture(scope="session")
def _onboarding_truth():
    """What each of those caches holds when it is filled from the real checkout.

    Taken ONCE, with the caches cleared first so that nothing already remembered when the
    session started can be mistaken for the truth. Comparing every test against a snapshot,
    rather than recomputing, is what makes the guard affordable: a filled cache answers from
    its own hit, so the check costs one comparison and no archive is ever built twice.
    """
    caches = _onboarding_caches()
    for cache in caches.values():
        cache.cache_clear()
    truth = {name: cache() for name, cache in caches.items()}
    yield truth
    for cache in caches.values():
        cache.cache_clear()


def _planted_onboarding_caches(truth):
    """The names holding something other than the real image's answer."""
    return sorted(
        name for name, cache in _onboarding_caches().items()
        # An EMPTY cache cannot be holding a wrong answer, and asking it would FILL it —
        # from whatever the test still has patched, which is how a guard plants the very
        # thing it watches for.
        if cache.cache_info().currsize and cache() != truth[name])


@pytest.fixture(autouse=True)
def guard_onboarding_caches(_onboarding_truth):
    """Fail the test that plants a wrong answer in those caches, not the one that reads it.

    Before AND after, for the reason written above `guard_build_workers`: without the
    after-check the test that planted it goes green and the failure surfaces in an unrelated
    test later — and here "later" means any test in any file that touches `/start`, since the
    poison is one string in a process-wide cache.
    """
    planted = _planted_onboarding_caches(_onboarding_truth)
    assert not planted, (
        "an EARLIER test left this behind and escaped its own after-check; this test is where "
        "it surfaced, not where it was caused.\n"
        + _ONBOARDING_PLANTED.format(names=planted, verb="held"))
    yield
    planted = _planted_onboarding_caches(_onboarding_truth)
    if planted:
        for cache in _onboarding_caches().values():
            cache.cache_clear()
    assert not planted, (
        "THIS test planted it.\n"
        + _ONBOARDING_PLANTED.format(names=planted, verb="hold"))


@pytest.fixture
def onboarding_cache_sandbox():
    """For a test that fills those caches from a doctored image ON PURPOSE.

    Requesting it is how a test says so. It hands over cleared caches — which such a test needs
    anyway, since a cache already holding the real archive would answer before the doctored
    input was ever reached — and clears them again on the way out, so `guard_onboarding_caches`
    finds what it demands. The ordering that makes that work is pytest's own: the guard is
    autouse and therefore set up FIRST, so it finalises LAST, after this teardown.

    A test that plants a value without this fixture fails its own after-check, which is the
    entire point — the blame lands on the test that did it rather than on whichever one
    happened to run next.
    """
    for cache in _onboarding_caches().values():
        cache.cache_clear()
    yield
    for cache in _onboarding_caches().values():
        cache.cache_clear()


# --- What a hub costs to STOP, which every test using one pays ---------------
# `stop_hub` is `shutdown()` + `server_close()` + `join()`, and the middle one is
# where the time is: closing the server stops the build pool, and joining an idle
# worker cannot finish sooner than the `Queue.get(timeout=WORKER_POLL_SECONDS)`
# it is sitting in. At the production value that is 50 ms of pure waiting per
# hub, measured as ~44 ms of the ~57 ms a stop takes — and `hub` alone is asked
# for by over five hundred tests (issue #99).
#
# The constant is PRODUCTION TUNING and nothing reads it as a fact: it decides
# how often an idle worker wakes to notice it is being shut down, and no test
# asserts anything about that number or about how long a stop takes. So the
# suite is free to ask its workers to wake more often, which is all this does.
# `src/jobs.py` keeps the real value — do not change it there to make the suite
# faster; the hub's idle cost is a deployment's, not a test's.
TEST_WORKER_POLL_SECONDS = 0.002


@pytest.fixture
def hub(tmp_path, monkeypatch):
    """A live hub on an ephemeral port, with its own empty data directory.

    Function-scoped on purpose: publication mutates a directory tree, a symlink
    and two index files, so tests that shared one hub would depend on collection
    order the moment one of them published anything.
    """
    # BEFORE the pool exists, so every worker this hub starts is already waking
    # at the suite's interval rather than the deployment's.
    monkeypatch.setattr(jobs, "WORKER_POLL_SECONDS", TEST_WORKER_POLL_SECONDS)
    instance = start_hub(tmp_path / "data")
    try:
        yield instance
    finally:
        stop_hub(instance)


@pytest.fixture
def hub_factory(tmp_path, monkeypatch):
    """For tests that need a hub configured differently (size caps, mostly)."""
    started = []
    monkeypatch.setattr(jobs, "WORKER_POLL_SECONDS", TEST_WORKER_POLL_SECONDS)

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
