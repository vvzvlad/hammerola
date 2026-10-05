"""`src/safeio.py`'s `resolve_settled`: what a fake can pin about its retry."""

import errno
import os

import pytest

from src.safeio import resolve_settled


# -- resolving a pointer that is being swapped -------------------------------
class Clock:
    """`src.safeio`'s `time`, recording what it was asked to wait for.

    The module's own name is replaced rather than `time.sleep` itself: patching
    the attribute on the stdlib module would hand this list to every other
    thread in the process — this suite runs hubs on them — and a stray entry
    would make the assertions below flaky in a way that looks like a defect in
    the code under test.
    """

    def __init__(self, waits):
        self.sleep = waits.append


@pytest.fixture
def waits(monkeypatch):
    """Every wait `resolve_settled` makes, in order, taken instead of made.

    A SPY AND NOT A SPEED-UP. Half of "retry EINVAL and nothing else" is about
    sleeping, and the call count cannot see that half: an implementation that
    slept BEFORE it looked at the errno would answer identically on every input
    while putting two waits into the hot path of every 404 this service serves.
    """
    recorded = []
    monkeypatch.setattr("src.safeio.time", Clock(recorded))
    return recorded


class Flaky:
    """A stand-in for a `Path` whose `resolve` fails a set number of times.

    A FAKE AND NOT A REAL RACE, deliberately. The EINVAL this exists for was
    measured on macOS/APFS and never once on Linux (issue #70), so a test that
    tried to provoke it would assert nothing on the platform CI runs on and
    would be timing-dependent on the platform it does happen on. What has to
    hold is the POLICY — which errno is retried, how many times, that nothing
    else is slept over, and that the resolve stays STRICT — and a fake pins all
    four. `strict_seen` is there because dropping `strict=True` would answer
    every one of these tests the same way and turn `_serve_build_page`'s
    "existence is decided by meta.json" into a page served for a build
    directory that has no meta.json at all.
    """

    def __init__(self, failures, code=errno.EINVAL):
        self.failures = failures
        self.code = code
        self.calls = 0
        self.strict_seen = []

    def resolve(self, strict=False):
        self.calls += 1
        self.strict_seen.append(strict)
        if self.calls <= self.failures:
            raise OSError(self.code, os.strerror(self.code))
        return "the settled path"


def test_a_transient_einval_is_retried_and_the_answer_returned(waits):
    path = Flaky(failures=2)
    assert resolve_settled(path) == "the settled path"
    assert path.calls == 3
    assert path.strict_seen == [True, True, True]
    # One wait between tries and none after the answer, at the delay measured
    # rather than at some round number that happens to work.
    assert waits == [0.001, 0.001]


def test_the_retry_is_bounded(waits):
    """An EINVAL that never settles must raise, not spin.

    The whole helper sits on a request-serving thread, so "keep trying" is the
    one failure mode worse than the 404 it replaces.
    """
    path = Flaky(failures=99)
    with pytest.raises(OSError) as caught:
        resolve_settled(path)
    assert caught.value.errno == errno.EINVAL
    assert path.calls == 3
    assert waits == [0.001, 0.001]


def test_a_missing_file_is_refused_on_the_first_try(waits):
    """ENOENT is the ORDINARY case on these routes and must not be slept over.

    `_send_file` answers 404 for every URL that names nothing, which is most of
    the 404s this service serves. Retrying those would put two waits into the
    hot path of a public route to fix a race that cannot produce ENOENT — and
    the empty `waits` is what says so, because a call count alone cannot tell a
    helper that checks the errno first from one that sleeps first.
    """
    path = Flaky(failures=1, code=errno.ENOENT)
    with pytest.raises(FileNotFoundError):
        resolve_settled(path)
    assert path.calls == 1
    assert waits == []
