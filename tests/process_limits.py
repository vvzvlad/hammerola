"""Which rlimits the suite watches, taken from the code that puts them on.

A module of its own rather than a few lines inside `tests/conftest.py`, for the
reason `tests/buildproc/probes.py` gives about itself: three directories under
tests/ carry a conftest.py and every one of them lands on sys.path, so
`import conftest` from a test module resolves to whichever of the three pytest
inserted first. The guard in tests/conftest.py needs a TEST of its own (a guard
that quietly stops guarding is the failure this whole area is about), and that
test has to see the same set the guard uses -- which is what a plain importable
module buys and a conftest cannot.
"""

import resource

from src.buildproc.limits import RLIMIT_NAMES


# Read from the code that APPLIES the ceilings; never written out a second time
# here. `src.buildproc.limits.apply_process_limits` is the only thing in this
# repository that fences a process in, it walks exactly this list, and the guard
# built on it has to cover the same ground. A hand-copied list fails in two ways
# that both leave the suite GREEN: a seventh ceiling added to limits.py is
# simply never watched, and a name that goes wrong -- a typo, a filter that
# drops it -- leaves the guard comparing {} against {}, which passes forever.
WATCHED_RLIMITS = RLIMIT_NAMES

# And no `hasattr` filter over that tuple, deliberately. Which of these a
# platform HAS and which it will let a process SET are two different questions
# and only the second one differs in practice: Darwin has RLIMIT_AS and refuses
# it at every value there is (measured -- see `limits.memory_limit_supported`),
# while all six attributes exist on darwin and on linux alike (measured
# 2026-08-26). A filter therefore drops nothing today, and on the day it did
# drop something it would drop it silently, which is precisely the shape of bug
# the guard downstream exists to catch.
#
# So a missing attribute refuses to start the suite instead of narrowing the
# watch. That is the loud choice on purpose: `apply_process_limits` applies the
# table IN ORDER and only raises when it REACHES the name the platform lacks, so
# every ceiling before it is already on the process by then -- a guard that had
# quietly stopped watching those would be worse than a suite that says it does
# not know this platform.
_MISSING = tuple(name for name in WATCHED_RLIMITS if not hasattr(resource, name))
if _MISSING:
    raise RuntimeError(
        f"this platform's `resource` module has no {', '.join(_MISSING)}, so "
        f"tests/conftest.py::guard_process_limits cannot watch "
        f"{'them' if len(_MISSING) > 1 else 'it'} -- and the ceilings applied "
        "BEFORE that name in `src.buildproc.limits._RLIMIT_TABLE` would still "
        "land on the pytest process. Decide what this platform should do "
        "deliberately (support it in limits.py, or exempt the name here and say "
        "why) rather than letting the guard watch less than the wrapper sets.")


def rlimits():
    """Every watched ceiling of THIS process, as {name: (soft, hard)}."""
    return {name: resource.getrlimit(getattr(resource, name))
            for name in WATCHED_RLIMITS}
