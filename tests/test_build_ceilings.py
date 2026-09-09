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

from src.buildproc.limits import BUILDS_SHARING_THE_HOST, DEFAULT_LIMITS
from hammerola.hub import JOB_TIMEOUT, SLOW_BUILD_SECONDS
from src.jobs import MAX_CONCURRENT_BUILDS, MAX_QUEUED_JOBS, WIP_MAX_AGE_SECONDS
from src.buildproc.limits import _usable_cores
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

    `hammerola/` is stdlib-only and may not reach into `src.buildproc`, so
    JOB_TIMEOUT is a literal that goes stale in silence. Stale, it reports a
    timeout on a build that is still legitimately queued -- and that build then
    publishes with nobody watching, which reads as the hub having lost a push.
    The test may import both sides; the client may not.
    """
    assert JOB_TIMEOUT > worst_honest_wait(), (
        f"JOB_TIMEOUT={JOB_TIMEOUT} is under the hub's own worst honest wait of "
        f"{worst_honest_wait()} s: the client gives up on a build that is still "
        f"waiting its turn.")


def test_the_slow_build_warning_fires_well_inside_the_hubs_own_wall():
    """The client's threshold is only worth having BELOW the ceiling.

    Every other number in this file is a copy that goes stale; this one is a
    judgement and a copy of nothing, so what has to hold is not equality but the
    ORDER. `SLOW_BUILD_SECONDS` exists for the zone where a build is green and
    slow -- between it and `wall_seconds` -- and at or above the wall there is
    no such zone: the only builds that could reach it are the ones the hub has
    already killed, which carry their own diagnosis and are the two the client
    deliberately says nothing to (`cli.SELF_DIAGNOSING`). The warning would then
    be advice nobody sees, on runs that were answered already.
    """
    assert SLOW_BUILD_SECONDS < DEFAULT_LIMITS.wall_seconds, (
        f"SLOW_BUILD_SECONDS={SLOW_BUILD_SECONDS} is not under the hub's own "
        f"wall of {DEFAULT_LIMITS.wall_seconds} s: no green build can reach it, "
        f"so the client's slow-build warning is unreachable.")


def test_the_thread_share_knows_how_many_builds_share_the_machine():
    """`limits` spells MAX_CONCURRENT_BUILDS a second time, and must not drift.

    It cannot import the first spelling -- `jobs` imports `buildproc`, so the
    arrow points one way -- and the number decides how much of the machine one
    build's OCCT pool takes. Too small and every build is throttled; too large
    and the concurrent builds contend for the cores the pool cap exists to stop
    them contending for. Neither shows up as an error, only as a slower hub.
    """
    assert BUILDS_SHARING_THE_HOST == MAX_CONCURRENT_BUILDS, (
        f"limits.BUILDS_SHARING_THE_HOST={BUILDS_SHARING_THE_HOST} and "
        f"jobs.MAX_CONCURRENT_BUILDS={MAX_CONCURRENT_BUILDS} are the same fact "
        f"written twice, and they disagree.")


def test_one_build_never_claims_the_whole_machine():
    """The pool is a SHARE, so all the builds together fit on the cores.

    The floor of two is the exception and is deliberate: on a one- or two-core
    machine the shares would round to nothing and a build would be slower than
    it was before this number was derived at all. So the assertion is the real
    invariant -- either everything fits, or we are on the floor.
    """
    limits = DEFAULT_LIMITS
    total = limits.occt_threads * MAX_CONCURRENT_BUILDS
    # THE EXCUSE IS "THE SHARE ROUNDED BELOW THE FLOOR", not "the pool happens
    # to be two". Written as the first thing because the second one silently
    # widens with the divisor: at two builds it excused machines under four
    # cores, at four builds it would excuse everything under eight -- so a
    # 4-core machine running 4 x 2 = 8 threads would have passed while reading
    # like it could not. This spelling means the same thing at any divisor.
    on_the_floor = _usable_cores() // MAX_CONCURRENT_BUILDS < 2
    assert total <= _usable_cores() or on_the_floor, (
        f"{MAX_CONCURRENT_BUILDS} builds x {limits.occt_threads} threads = "
        f"{total} on {_usable_cores()} usable cores, and the floor of 2 does "
        f"not explain it.")


def test_the_two_sweep_cutoffs_are_not_one_number_again():
    """`.wip-` files and `.src-`/`.body-` trees are swept on different clocks.

    They read the same constant until 2026-08-29, both spelled "an hour" for
    the same-sounding reason, and that hid the fact that they are not alike.
    The store's cutoff covers entries that live from the request until the
    build ENDS, so it is a function of the queue wait and rose to four hours
    with `wall_seconds`; a `.wip-` file is the hub's own half-finished write,
    abandoned in milliseconds and belonging to nothing by the time the sweep
    runs at all. Collapsing them again would quadruple the second wait as a
    side effect of a change about the first, leaving megabytes of `.wip-log`
    on the volume for no reason.

    IT IS ALSO WHAT KEPT THE PROSE WRONG. Four comments across `jobs.py` and
    `store.py` still said "an hour" about the store's sweep long after it
    became four (issue #88), because the split was written down once, in one
    paragraph, and nowhere executable.
    """
    assert WIP_MAX_AGE_SECONDS < LEFTOVER_MAX_AGE_SECONDS, (
        f"jobs.WIP_MAX_AGE_SECONDS={WIP_MAX_AGE_SECONDS} and "
        f"store.LEFTOVER_MAX_AGE_SECONDS={LEFTOVER_MAX_AGE_SECONDS}: the first "
        f"sweeps writes abandoned in milliseconds and the second sweeps trees "
        f"that live for the length of a build, so the first is the smaller of "
        f"the two or one of them is being read for the other's reason")
