"""Reading a file off the data volume without losing the thread that reads it.

`data/` IS ONE VOLUME AND A BUILD CAN WRITE ANYWHERE IN IT — `src/buildproc`
says so at length ("THE DATA VOLUME IS FULLY WRITABLE TO A BUILD") — so "a path
under our own root" says nothing at all about what is at the end of it. A plain
`open()` on a FIFO blocks until a writer appears, and for one a build planted
there is never: the thread is gone for good, with no exception, no log line and
nothing observable from outside except that one worker fewer answers. `mkfifo`
takes no privilege, so this needs no attacker and no vulnerability — an
ordinary `model.py` mistake lays the same trap.

TWO OF THOSE WERE FOUND AND CLOSED ONE AT A TIME (issues #53, #74) before the
third, the fourth and the fifth showed that what was missing was a RULE rather
than a third fix. The rule is:

    nothing reads a file off that volume with a bare
    `open` / `read_text` / `read_bytes`; it goes through this module, which
    opens `O_NONBLOCK` and refuses anything that is not a regular file.

`tests/test_volume_reads.py` is what keeps that rule. This paragraph is not:
an inventory of the places that needed fixing went stale twice inside one
issue, which is exactly why the criterion is a scan that has to come back empty
rather than a list somebody maintains.

NOTHING FROM `src/` IS IMPORTED HERE, deliberately. `src/buildproc/runner.py`
reads the build's result file and imports only its own package (the build half
is kept clear of the hub half), so a helper reaching for `store`, `app`, `jobs`
or `comments` would be one the runner could not use — and the runner is one of
the places the rule has to hold.

A DIRECTORY AND A FIFO ARE REFUSED IN TWO DIFFERENT PLACES, and they are not
one check: `open()` fstats what the opener handed it and raises
`IsADirectoryError` before anything here looks, while a FIFO, a socket or a
device passes the open and is refused by `S_ISREG` below. Both are `OSError`,
which is the single property that let every caller keep the handler it already
had.
"""

import os
import stat
from contextlib import contextmanager


class NotRegularFile(OSError):
    """What is at that path is not a regular file: a fifo, a socket, a device.

    AN `OSError` ON PURPOSE, and that is the hinge of the whole repair rather
    than a taxonomy choice. Every place that reads this volume already catches
    `OSError` — a file that is not there, a permission, an EIO — usually as part
    of a wider tuple like `(ValueError, OSError, RecursionError)`. Making the
    new refusal one of those means a site converted to this module needs no
    second edit to go on answering the way it always did, and a site whose
    handler is too narrow fails loudly at the same place a missing file already
    would rather than in some new way.
    """


def nonblocking(path, flags):
    """`open()`'s opener, adding O_NONBLOCK — see this module's docstring for why.

    An opener rather than `os.fdopen(os.open(...))`, and the difference is a
    descriptor leak rather than style: `os.open` SUCCEEDS on a directory, and
    the `os.fdopen` that follows then raises `IsADirectoryError` without closing
    what it was handed. Through an opener the descriptor belongs to CPython's
    `FileIO` the moment this returns, and `FileIO` closes it on every failure
    path of its own.

    NOT a rule for the whole repository, and the counter-example is deliberate:
    `Store._extract_members` keeps the `os.fdopen` shape with a hand-rolled
    `os.close` in its error branch, correctly, because its `os.open` carries
    `dir_fd=parent_fd`, which an opener's `(path, flags)` signature cannot pass.

    PUBLIC, and the one name here that is used outside `open_regular`:
    `app._send_file` streams a build file through `open()` directly, because it
    needs the size off the very handle it is about to send and the refusal has
    to become a 404 rather than an exception. It gets the same opener rather
    than a second copy of this line.
    """
    return os.open(path, flags | os.O_NONBLOCK)


def _nofollow(path, flags):
    """`nonblocking` plus O_NOFOLLOW: the last component may not be a symlink.

    For the reads where the NAME has already been checked and the only escape
    left is the file itself being a link somewhere else. `lstat`-then-open would
    answer the same question with a window between the two answers; the flag
    answers it in the open, so there is no moment to swap the file in.
    """
    return os.open(path, flags | os.O_NONBLOCK | os.O_NOFOLLOW)


@contextmanager
def open_regular(path, mode="rb", *, follow_symlinks=True):
    """An open handle on `path`, and only if it is a regular file.

    Raises `NotRegularFile` — an `OSError` — for a fifo, a socket or a device,
    with the descriptor already closed by the time it leaves. A DIRECTORY never
    reaches that check: `open()` refuses it with `IsADirectoryError`, which is
    an `OSError` too, so a caller sees one kind of failure for both.

    `follow_symlinks=False` adds O_NOFOLLOW, for a caller that has checked the
    name and needs the last component to be the file itself. It is not the
    default because most of these paths are ours by construction and one of them
    — `latest` — is a symlink whose whole purpose is to be followed.
    """
    opener = nonblocking if follow_symlinks else _nofollow
    with open(path, mode, opener=opener) as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise NotRegularFile(f"{path} is not a regular file")
        yield handle


def read_regular_bytes(path, limit=None, *, follow_symlinks=True):
    """The bytes of a regular file; at most `limit` of them when one is given.

    THE LIMIT CUTS AND SAYS NOTHING, and what a full buffer means is the
    caller's to decide: every caller that passes a limit passes `ceiling + 1`,
    which is what makes "too big" distinguishable from "exactly at the ceiling"
    without pulling the rest of whatever is there into memory. A
    ceiling matters on this volume for the same reason the type check does — the
    size of the file that comes back is not a number the hub gets to decide.
    """
    with open_regular(path, "rb", follow_symlinks=follow_symlinks) as handle:
        return handle.read() if limit is None else handle.read(limit)


def read_regular_text(path, *, encoding="utf-8", follow_symlinks=True):
    """The same, decoded. `UnicodeDecodeError` is a `ValueError`, as before.

    NO NEWLINE TRANSLATION, which is the one way this differs from the
    `Path.read_text()` calls it replaced: text mode rewrites CRLF and this does
    not. Every caller parses JSON or strips the result, and neither can tell.
    """
    return read_regular_bytes(
        path, follow_symlinks=follow_symlinks).decode(encoding)
