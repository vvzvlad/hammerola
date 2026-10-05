"""`resolve_settled` IS HERE FOR PROXIMITY RATHER THAN FOR KIND — it resolves a
path and reads nothing. It belongs beside the readers because it is about the
same volume and the same instant: `latest` is a symlink the publisher swaps
under a reader, and both routes that resolve it live in `app.py`, which already
imports this module — one to open the file it just resolved, the other only to
ask whether it is there. Its own docstring carries the measurement.
"""

import errno
import time


def resolve_settled(path, attempts=3, delay=0.001):
    """`path.resolve(strict=True)`, retried while the answer is EINVAL.

    THE ONLY ERRNO RETRIED IS EINVAL, and everything else — ENOENT above all —
    is raised on the first try, unslept. A file that is genuinely not there is
    the ordinary case on these routes and has to stay a fast 404; a helper that
    slept twice over every 404 would be a worse defect than the one it fixes.

    WHAT WAS MEASURED (issue #70). `tests/test_atomicity.py::
    test_readers_never_see_a_missing_or_partial_latest` failed about one run in
    fifteen on an idle machine, as a 404 on `latest/`. The publisher swaps the
    pointer with `os.symlink` to a temporary name and `os.rename` over the old
    one, which is a single step and leaves no window with no pointer — that much
    was already tested. The 404 came from the READER: on macOS/APFS,
    `os.readlink()` on that symlink returns EINVAL (errno 22) while the rename
    is in flight, and `Path.resolve` calls `os.readlink` uncaught, so the whole
    resolve fails. Three tries a millisecond apart took 3 000 observed failures
    to 0.

    ON LINUX IT DOES NOT HAPPEN AT ALL: the same harness ran ~320 000 readlinks
    across the same rename storm without a single EINVAL, so the production
    container has never had this defect and this is not a repair of the
    publisher. WHAT INSIDE APFS PRODUCES THE EINVAL WAS NOT ESTABLISHED — only
    that it does, that it is transient, and that three tries a millisecond apart
    outlast it. On Linux no EINVAL is raised here at all, so the retry is never
    taken and this costs the loop around the call it would have made anyway.
    """
    for remaining in range(attempts - 1, -1, -1):
        try:
            return path.resolve(strict=True)
        except OSError as error:
            if error.errno != errno.EINVAL or not remaining:
                raise
            time.sleep(delay)
