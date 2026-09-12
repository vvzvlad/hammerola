"""`src/safeio.py`: the one way the hub reads a file off the data volume.

Every test here is about a file that is NOT a file — a fifo, a directory, a
symlink somewhere else — because those are the three things a build can put at a
name the hub is about to read, and the module exists for exactly that. What the
routes do with the refusal is tested where the route is; this is the helper on
its own.

THE DEADLINE IS PART OF THE ASSERTION and not a convenience. A regression here
does not fail, it HANGS: a plain `open()` on a fifo blocks until a writer
appears, and there is not going to be one. There is no `pytest-timeout` in this
suite (deliberately — `requirements-dev.txt`), so the read runs on a thread and
the test insists it comes back. `tests/test_serving.py` spells the same
deadline out on an HTTP request for the same reason.

`resolve_settled` is the odd one out here for the same reason it is the odd one
out in the module — same volume, same instant, no read — and its own section
says what a fake can pin and why a real race cannot be raced for.

EVERY READ OF A FIFO HERE GOES THROUGH `within_deadline`, without exception, and
that rule was learnt on this file: the first draft had two tests calling
`read_regular_bytes` on a fifo directly, which passed while the module was
correct and, the moment the O_NONBLOCK was mutated away to check the deadline
worked, hung pytest until it was killed by hand. A deadline on one test out of
three is not a deadline.
"""

import errno
import os
import threading

import pytest

from src.safeio import (NotRegularFile, open_regular, read_regular_bytes,
                        read_regular_text, resolve_settled)

# Long enough that a loaded machine never trips it, short enough that a wedged
# read is reported rather than waited out. The read under test takes microseconds.
DEADLINE_SECONDS = 5

no_fifos = pytest.mark.skipif(
    not hasattr(os, "mkfifo"),
    reason="this platform has no os.mkfifo, so no fifo can reach the volume")


def within_deadline(call):
    """Run `call` on a thread and insist it comes back. -> {"value"} or {"error"}.

    A thread rather than a signal alarm: `signal.alarm` only fires on the main
    thread and the suite runs hubs on others, so an alarm here would be a tool
    that works today and stops working the day anything about the arrangement
    changes. The thread is a daemon — if the read really is wedged the
    interpreter can still exit, which is what keeps a regression a FAILING test
    rather than a hung suite that has to be killed by hand.
    """
    box = {}

    def run():
        try:
            box["value"] = call()
        except BaseException as error:  # noqa: BLE001 - reported, not handled
            box["error"] = error

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join(timeout=DEADLINE_SECONDS)
    assert not thread.is_alive(), (
        f"the read did not come back within {DEADLINE_SECONDS}s — this is the "
        f"defect the module exists for, and without this deadline it would "
        f"have hung the suite instead of failing")
    return box


# -- the refusals ------------------------------------------------------------
@no_fifos
def test_a_fifo_is_refused_rather_than_waited_on(tmp_path):
    """The whole point. `mkfifo` needs no privilege, so a model can do this."""
    path = tmp_path / "pipe.json"
    os.mkfifo(path)
    box = within_deadline(lambda: read_regular_bytes(path))
    assert isinstance(box.get("error"), NotRegularFile), box


@no_fifos
def test_the_refusal_is_an_oserror(tmp_path):
    """The property every converted caller depends on.

    Each site already caught `OSError` — for a missing file, a permission, an
    EIO — usually inside a wider tuple. `NotRegularFile` being one is what let
    the conversion be a one-line change at each of them instead of a second
    edit to every handler, so it is pinned here rather than left to inheritance
    nobody checks.
    """
    path = tmp_path / "pipe.json"
    os.mkfifo(path)
    box = within_deadline(lambda: read_regular_bytes(path))
    assert isinstance(box.get("error"), OSError), box


def test_a_directory_is_refused(tmp_path):
    """By `open()` itself, before `S_ISREG` is ever asked.

    `IsADirectoryError` rather than `NotRegularFile`, and the two are one answer
    only because both are `OSError`. Asserted as the concrete class because the
    day that stops being true, the callers that catch `OSError` and nothing else
    are the ones that would break.
    """
    (tmp_path / "subdir.json").mkdir()
    with pytest.raises(IsADirectoryError):
        read_regular_bytes(tmp_path / "subdir.json")


def test_a_missing_file_is_the_ordinary_error(tmp_path):
    with pytest.raises(FileNotFoundError):
        read_regular_bytes(tmp_path / "nothing.json")


# -- symlinks ----------------------------------------------------------------
def test_a_symlink_is_followed_by_default(tmp_path):
    """Because one of these paths IS a symlink on purpose.

    `latest` points at a build directory and following it is the entire feature,
    so refusing links by default would break the thing the store is built
    around. The refusal is asked for at the one site whose last component is a
    name off the volume.
    """
    (tmp_path / "real.json").write_bytes(b"{}")
    (tmp_path / "link.json").symlink_to(tmp_path / "real.json")
    assert read_regular_bytes(tmp_path / "link.json") == b"{}"
    # And on `open_regular` itself, which has a default of its own: the two are
    # only in step because they are both asserted. Flipping one and not the
    # other is invisible from every caller that passes the flag explicitly —
    # which is all of them except `store._hash_output` and `render`.
    with open_regular(tmp_path / "link.json") as handle:
        assert handle.read() == b"{}"


def test_a_symlink_is_refused_when_the_caller_says_so(tmp_path):
    """`app._serve_attachment` reads a name that came off the volume.

    The name has already been checked as one ordinary component belonging to
    this comment, so the last component BEING a link is the only way left for
    the bytes and the URL to disagree. Nothing here is against anybody: that
    route takes EDIT_TOKEN and so does the build that would plant the link. It
    is against an ORDINARY MISTAKE — one stray `os.symlink` in `model.py` and
    the hub serves somebody else's file under `/comments/<cid>/photo`, typed as
    a JPEG because the NAME ends in `.jpg`. O_NOFOLLOW settles it in the open,
    so there is no window between deciding and reading.
    """
    (tmp_path / "elsewhere.txt").write_bytes(
        b"bytes of a file nobody asked this URL for")
    (tmp_path / "link.jpg").symlink_to(tmp_path / "elsewhere.txt")
    with pytest.raises(OSError):
        read_regular_bytes(tmp_path / "link.jpg", follow_symlinks=False)
    # And the link really did lead to something readable, so the test is about
    # the flag rather than about a path that was never going to open.
    assert read_regular_bytes(tmp_path / "link.jpg").startswith(b"bytes of a")


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


# -- the ordinary case -------------------------------------------------------
def test_a_regular_file_reads(tmp_path):
    (tmp_path / "meta.json").write_bytes(b'{"a": 1}')
    assert read_regular_bytes(tmp_path / "meta.json") == b'{"a": 1}'
    assert read_regular_text(tmp_path / "meta.json") == '{"a": 1}'


def test_the_handle_is_the_caller_s_to_stream(tmp_path):
    """`open_regular` hands over a file object, for the readers that chunk.

    `store._hash_output` and `render.measure_view` walk files that can be
    megabytes, and holding one in memory per concurrent publish is the peak the
    store goes to some trouble to avoid.
    """
    (tmp_path / "view.json").write_bytes(b"0123456789")
    with open_regular(tmp_path / "view.json") as handle:
        assert handle.read(4) == b"0123"
        assert handle.read() == b"456789"


def test_the_limit_cuts(tmp_path):
    """One byte over the ceiling is what makes "too big" recognisable.

    Every caller that passes a limit passes `ceiling + 1` and compares the
    length, which only works if the read stops where it was told rather than
    raising or returning everything.
    """
    (tmp_path / "log.txt").write_bytes(b"x" * 100)
    assert read_regular_bytes(tmp_path / "log.txt", 10) == b"x" * 10
    assert read_regular_bytes(tmp_path / "log.txt", 1000) == b"x" * 100
    assert read_regular_bytes(tmp_path / "log.txt") == b"x" * 100


def test_undecodable_bytes_stay_a_valueerror(tmp_path):
    """`Path.read_text` raised `UnicodeDecodeError` and so does this.

    Every caller of `read_regular_text` parses JSON inside a `except
    (ValueError, ...)` arm, and a `UnicodeDecodeError` IS a `ValueError` — which
    is the only reason those arms still cover a file of binary junk.
    """
    (tmp_path / "meta.json").write_bytes(b"\xff\xfe not utf-8")
    with pytest.raises(ValueError):
        read_regular_text(tmp_path / "meta.json")


@no_fifos
def test_the_descriptor_does_not_leak_on_a_refusal(tmp_path):
    """The failure the last repair of this shape hid for a round.

    A refused read answers correctly whether or not it closed what it opened, so
    nothing about the result can tell the two apart — and one descriptor per
    refusal, on a route anybody can call in a loop, ends with `accept()` quietly
    taking no more connections. `/dev/fd` is taken deliberately and without a
    `skipif`, exactly as `test_serving.py` argues: it is present everywhere this
    suite runs, and a platform without it should fail loudly rather than skip,
    because a skip is how a leak check stops checking.
    """
    path = tmp_path / "pipe.json"
    os.mkfifo(path)
    (tmp_path / "subdir.json").mkdir()
    attempts = 50

    def refuse_them_all():
        # Both kinds, because they leave by different doors: the directory is
        # refused by `open()` itself, which owns the descriptor, and the fifo
        # passes the open and is refused afterwards, which is the door where a
        # descriptor could actually be dropped.
        for _ in range(attempts):
            for target in (path, tmp_path / "subdir.json"):
                try:
                    read_regular_bytes(target)
                except OSError:
                    continue
                raise AssertionError(f"{target} was not refused")

    before = len(os.listdir("/dev/fd"))
    box = within_deadline(refuse_them_all)
    assert "error" not in box, box["error"]
    grew = len(os.listdir("/dev/fd")) - before
    assert grew < attempts // 5, (
        f"{grew} descriptors left open across {attempts * 2} refused reads")
