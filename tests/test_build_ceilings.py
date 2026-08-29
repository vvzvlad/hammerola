"""The build ceilings have to agree with each other, and nothing made them.

Four numbers in three files are derived from `Limits.wall_seconds`, none of them
imports it, and every one of them fails SILENTLY when it goes stale -- which is
why they are here rather than in a comment. The 2026-08-29 raise (120 s -> 900 s,
made because the first real model needed ~500 s of checks) walked into two of
them at once, and both were caught by reading, not by running:

  * `LEFTOVER_MAX_AGE_SECONDS` would have started sweeping the unpacked sources
    of builds still sitting in the queue -- the build then fails on a tree that
    was there when the hub accepted it;
  * `cpu_seconds` at the requested 900 would have become the BINDING ceiling
    rather than the backstop it is documented as: at `occt_threads` = 2 a
    parallel build may legitimately burn 2 x the wall clock, so the kernel would
    have killed exactly the builds the raise was made to allow.

A comment cannot catch either. These are one multiplication each, so they cost
nothing to run and they fail on the commit that breaks them.
"""

from src.buildproc.limits import DEFAULT_LIMITS
from src.client.hub import JOB_TIMEOUT
from src.jobs import MAX_CONCURRENT_BUILDS, MAX_QUEUED_JOBS
from src.store import LEFTOVER_MAX_AGE_SECONDS


def worst_honest_wait():
    """Longest a queued push can honestly take: the queue ahead, then its build.

    Deliberately a function rather than a constant, so every assertion below is
    read off the SAME arithmetic. A copy of this multiplication in two tests is
    how the two stop agreeing.
    """
    return MAX_QUEUED_JOBS * DEFAULT_LIMITS.wall_seconds / MAX_CONCURRENT_BUILDS


def test_the_cpu_ceiling_stays_a_backstop_and_not_the_binding_limit():
    """RLIMIT_CPU sums over threads, so it has to clear wall x threads.

    Its documented job is to hold the leash when the parent is gone -- the one
    case the wall timer cannot cover. Below `wall_seconds * occt_threads` it
    stops doing that job and starts doing a different one: killing a healthy
    parallel build from inside its wall clock, reported as a signal rather than
    as a timeout, which sends whoever reads the log looking for a bug in the
    model.
    """
    limits = DEFAULT_LIMITS
    assert limits.cpu_seconds is not None
    assert limits.cpu_seconds >= limits.wall_seconds * limits.occt_threads, (
        f"cpu_seconds={limits.cpu_seconds} is under "
        f"wall_seconds={limits.wall_seconds} x occt_threads={limits.occt_threads}"
        f" = {limits.wall_seconds * limits.occt_threads}: the kernel would kill a "
        f"fully parallel build before its wall clock ran out.")


def test_the_hang_dump_has_room_to_land_before_the_parent_kills():
    """`__post_init__` enforces the ORDER; this enforces the GAP.

    The child arms its own timer after starting, so the gap has to cover the
    slowest start (measured 0.8-7.6 s, the top of that under a load average of
    300). A gap of a second satisfies the constructor and loses every stack.
    """
    limits = DEFAULT_LIMITS
    assert limits.hang_dump_seconds is not None
    gap = limits.wall_seconds - limits.hang_dump_seconds
    assert gap >= 10, (
        f"only {gap} s between hang_dump_seconds={limits.hang_dump_seconds} and "
        f"wall_seconds={limits.wall_seconds}: a slow start loses the traceback, "
        f"and a timeout with no stack is the failure the dump exists to prevent.")


def test_the_leftover_sweep_cannot_reach_a_build_that_is_still_queued():
    """`.src-` lives from the request until the build ENDS, not until it starts.

    So the sweeper's age has to clear the whole queue wait plus one build. Under
    it, the deletion is silent on both sides: the sweep says nothing, and the
    build fails later on a missing tree.
    """
    assert LEFTOVER_MAX_AGE_SECONDS > worst_honest_wait(), (
        f"LEFTOVER_MAX_AGE_SECONDS={LEFTOVER_MAX_AGE_SECONDS} does not clear the "
        f"worst honest wait of {worst_honest_wait()} s: a queued build's sources "
        f"can be swept out from under it.")


def test_the_client_waits_at_least_as_long_as_the_hub_may_honestly_take():
    """The client's copy of this arithmetic cannot import its source.

    `src/client/` is stdlib-only and may not reach into `src.buildproc`, so
    JOB_TIMEOUT is a literal that goes stale in silence. Stale, it reports a
    timeout on a build that is still legitimately queued -- and that build then
    publishes with nobody watching, which reads as the hub having lost a push.
    The test may import both sides; the client may not.
    """
    assert JOB_TIMEOUT > worst_honest_wait(), (
        f"JOB_TIMEOUT={JOB_TIMEOUT} is under the hub's own worst honest wait of "
        f"{worst_honest_wait()} s: the client gives up on a build that is still "
        f"waiting its turn.")
