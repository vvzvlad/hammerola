"""The guard's own guard: that it still watches every ceiling the wrapper applies.

`tests/conftest.py::guard_process_limits` is what fails a test that fences the pytest
process in with `apply_process_limits`, instead of letting the kernel kill the suite
somewhere else entirely. Its worst failure is the one every check of this shape has: it
stops watching, and says nothing about it. Both routes there are silent and both leave
the suite green --

  * DRIFT: a seventh ceiling is added to `_RLIMIT_TABLE` in src/buildproc/limits.py, the
    wrapper starts applying it, and a hand-written watch list goes on covering six;
  * NARROWING TO NOTHING: a mistyped name, or a filter that drops one, and in the limit
    the guard compares {} against {}, which passes for every test forever.

So the watch set is derived from `RLIMIT_NAMES` rather than copied (tests/process_limits.py
has the reasoning), and this is the test that fails if it ever stops being derived.
"""

import process_limits

from src.buildproc.limits import RLIMIT_NAMES


def test_the_guard_watches_every_ceiling_the_wrapper_applies(rlimit_guard_snapshot):
    """Asserted against the SNAPSHOT the guard really compares against.

    Not against `process_limits.WATCHED_RLIMITS`, which would only prove that module
    consistent with itself: what decides whether a dirtied ceiling is noticed is the dict
    `guard_process_limits` took at import, so that dict is what has to name every ceiling
    `apply_process_limits` can put on this process.
    """
    assert RLIMIT_NAMES, (
        "src.buildproc.limits.RLIMIT_NAMES is empty, so there is nothing to watch and "
        "nothing to apply — the table the wrapper walks has lost its rows")
    assert set(rlimit_guard_snapshot) == set(RLIMIT_NAMES), (
        "the rlimit guard in tests/conftest.py watches "
        f"{sorted(rlimit_guard_snapshot)}, while the wrapper applies "
        f"{sorted(RLIMIT_NAMES)}. Every name in the second list and not the first is a "
        "ceiling a test can put on the pytest process with nothing noticing — which ends "
        "as `Killed`, exit 137 and no traceback in some unrelated test later. Derive the "
        "watch set from RLIMIT_NAMES (tests/process_limits.py) rather than listing it.")
    assert set(process_limits.rlimits()) == set(RLIMIT_NAMES), (
        "the snapshot names the right ceilings but a fresh reading does not, so the guard "
        "compares two different sets of keys and its equality check means less than it "
        "looks like it does")


def test_every_watched_ceiling_reads_back_as_a_soft_hard_pair():
    """A watch that returns junk is a watch that compares junk to junk.

    Cheap, and it covers the version of the failure the set-comparison above cannot see:
    the names are right, the readings are not, and an equality check over two identical
    piles of nothing passes just as happily.
    """
    seen = process_limits.rlimits()

    for name, value in seen.items():
        soft, hard = value
        assert isinstance(soft, int) and isinstance(hard, int), f"{name}: {value!r}"
