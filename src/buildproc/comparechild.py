#!/usr/bin/env python3
"""Two published revisions, compared part by part, from inside the isolated process.

    python -m src.buildproc.comparechild --old-dir DIR --new-dir DIR \
                                         [--occt-threads N]

This is the only caller of `src.cadbuild.shapediff`, and it lives here rather
than in the hub for one measured reason: measuring a difference means importing
OCCT, which costs ~270 MB resident in whatever process does it (measured: 12 MB
for a bare interpreter, 271 MB after `from OCP.OSD import OSD_ThreadPool`, and
nothing further for the STEP reader and the boolean on top of it -- the ~450 MB
quoted around the BUILD is `import cadquery`, which this path never does). The
hub serves requests in that process, so the kernel goes where the build already
goes -- behind the wrapper, under the same ceilings, in a process that ends when
the answer is printed.

THE STDOUT OF THIS PROCESS IS THE ANSWER. There is no result file and no
artefact directory: nothing here is published, nothing is stored, and the report
is read by a person through the job log. That also means nothing on this path
has to be checked the way `child.py`'s result file is checked -- the parent is
not deciding anything from what this prints.

The part set is the `*.step` files of the two build directories, unioned by
stem, because that is what the build writes one of per printable
(`src/cadbuild/printables.py`). A stem present in both is compared; a stem on
one side only is named with the volume its own revision's metrics.json recorded,
which needs no kernel at all.

WHAT COUNTS AS A FAILURE HERE is the run not happening -- a bad invocation, an
uncappable thread pool, a crash. A part the kernel cannot measure is not one:
its reason is printed on its own line and the walk carries on to the next part,
because "eleven parts moved and the twelfth could not be measured" is an answer
and an exit code is not.
"""

import json
import sys
from pathlib import Path

# THE THREAD-POOL CAP IS IMPORTED AND NEVER COPIED. It is the same reasoning
# `child.py` documents at length -- RLIMIT_CPU sums the processor time of every
# thread, so an uncapped pool reaches the ceiling n times sooner than the number
# says -- and a second copy of it here would be a second thing to keep in step
# with the kernel's API. The exit codes come with it for the same reason: the
# parent reads them through one table (`runner._read_outcome`).
from src.buildproc.child import (
    EXIT_CRASHED,
    EXIT_INVOCATION,
    EXIT_OK,
    EXIT_UNCAPPED,
    _cap_occt_threads,
    _print_exc_quietly,
    _say,
)
# The one file this module reads that a BUILD wrote (metrics.json, out of a
# published build directory). `data/` is one volume every build can write
# anywhere in, so it is read the way the hub reads that volume: non-blocking,
# and refusing anything that is not a regular file. A plain open on a fifo never
# returns, and this process would then sit there until the parent's deadline
# killed it -- with nothing printed and nothing said about which part it was on.
from src.safeio import read_regular_text
# THE ENGINE, AT THE TOP AND NOT DEFERRED the way `child.py` defers
# `src.cadbuild.build`. That deferral is there because importing the build half
# imports cadquery; this half imports no kernel at all -- every OCP name
# `shapediff` uses is imported inside the function that uses it, so the module
# costs 3 MB and brings nothing else with it (measured, with `sys.modules`
# holding no `OCP*` afterwards). The 271 MB arrives in `_run`, with the
# thread-pool cap, and that is the only line it can arrive on.
from src.cadbuild import shapediff


_OPTIONS = {
    "--old-dir": "old_dir",
    "--new-dir": "new_dir",
    "--occt-threads": "occt_threads",
}


def main(argv):
    """`_run`, under the same blanket handler `child.py` explains.

    Nothing leaves this function by raising, and here the reason is the LOG
    rather than the code: an uncaught exception exits 1, which this path's
    parent reads as a crash exactly like `EXIT_CRASHED`, but the interpreter's
    own traceback goes out through a stderr a model may have closed under it --
    which is the failure `_print_exc_quietly` was written for. No watchdog is
    armed on this path, so 1 means nothing else here; see `_compare_outcome`.
    """
    try:
        return _run(argv)
    except BaseException:
        _print_exc_quietly()
        return EXIT_CRASHED


def _run(argv):
    try:
        opts = _parse(argv[1:])
    except ValueError as exc:
        _say(f"compareproc: {exc}")
        return EXIT_INVOCATION

    # BEFORE THE KERNEL IS IMPORTED, and the cap below is the line that imports
    # it: a directory that is not there costs one stat to find out about, and
    # `_cap_occt_threads` reaches into `OCP.OSD` for 271 MB resident. The route
    # checked both of these before the job was queued; what puts them back is
    # the same EDIT_TOKEN erasing the project in the window between the queue
    # and this process. Checked rather than walked into: `Path.glob` on a
    # directory that does not exist yields nothing and raises nothing, so the
    # report would say "0 parts" and exit 0 -- which reads as "that build
    # exported nothing" rather than "that build is not there".
    old_dir = Path(opts["old_dir"])
    new_dir = Path(opts["new_dir"])
    for flag, directory in (("--old-dir", old_dir), ("--new-dir", new_dir)):
        if not directory.is_dir():
            _say(f"compareproc: {flag} {directory} is not a directory")
            return EXIT_INVOCATION

    # Still ahead of everything this cap has to be ahead of. It configures a
    # pool that comes into being with the kernel, so a return above this line
    # cannot leave one uncapped: nothing above it has imported one.
    try:
        _cap_occt_threads(opts["occt_threads"])
    except RuntimeError as exc:
        _say(f"compareproc: {exc}")
        return EXIT_UNCAPPED

    _compare(shapediff, old_dir, new_dir)
    return EXIT_OK


def _compare(shapediff, old_dir, new_dir):
    """The walk itself: one line per part, then the tally."""
    old_parts = _step_files(old_dir)
    new_parts = _step_files(new_dir)
    stems = sorted(set(old_parts) | set(new_parts))

    print(f"comparing {old_dir.name} -> {new_dir.name}, {len(stems)} parts",
          flush=True)

    tally = {"unchanged": 0, "changed": 0, "new": 0, "removed": 0,
             "not measured": 0}
    for stem in stems:
        try:
            verdict, line = _one_part(shapediff, stem, old_parts.get(stem),
                                      new_parts.get(stem), old_dir, new_dir)
        except OSError as exc:
            # THE CONTRACT AT THE TOP OF THIS MODULE, held for the failures that
            # RAISE and not only for the ones `check` puts into words. `data/`
            # is one volume every build can write anywhere in, so a `lid.step`
            # that is a directory or a fifo is an ordinary `model.py` mistake --
            # and letting it out of this loop would throw away the eleven parts
            # already measured and end the job as a crash with no report at all.
            verdict, line = "not measured", f"not measured -- {exc}"
        tally[verdict] += 1
        print(f"  {stem}: {line}", flush=True)

    print(", ".join(f"{count} {name}" for name, count in tally.items()),
          flush=True)


def _one_part(shapediff, stem, old_step, new_step, old_dir, new_dir):
    """One part's verdict and the sentence for it. Returns (tally key, text)."""
    if old_step is None:
        return "new", _sided(new_dir, stem, "new in", "volume")
    if new_step is None:
        return "removed", _sided(old_dir, stem, "gone since", "volume was")

    # The fast path, and the only sound direction of it: equal bytes are equal
    # geometry, so there is nothing for the kernel to do. Different bytes mean
    # nothing on their own -- a STEP header carries a timestamp -- so this can
    # only ever answer "unchanged".
    if shapediff.step_digest(old_step) == shapediff.step_digest(new_step):
        return "unchanged", "unchanged"

    measurement = shapediff.measure(old_step, new_step)
    reason = shapediff.check(measurement)
    if reason is not None:
        return "not measured", f"not measured -- {reason}"

    # AFTER `check` AND NEVER BEFORE: the gate's identities are sums over every
    # piece, so filtering first would break the arithmetic that vouches for the
    # numbers.
    filtered = shapediff.drop_slivers(measurement)
    if not filtered["removed"] and not filtered["added"]:
        # TWO WAYS TO GET HERE, AND THEY ARE DIFFERENT NEWS. The fuse found
        # nothing between the two solids -- which is the ORDINARY case, because
        # a STEP header carries a timestamp and so an untouched part fails the
        # digest fast path above and gets measured anyway. Or it found pieces
        # and every one of them was thinner than the kernel's own noise, which
        # is the sentence that explains a part somebody did edit coming back
        # unchanged. Saying the second about the first would have most of a
        # report accusing untouched parts of drifting on numerical noise.
        only_slivers = bool(measurement["removed"] or measurement["added"])
        return "unchanged", ("unchanged (only slivers)" if only_slivers
                             else "unchanged")
    return "changed", (f"+{measurement['added_mm3']:.3f} mm3 added, "
                       f"-{measurement['removed_mm3']:.3f} mm3 removed")


def _sided(build_dir, stem, phrase, volume_phrase):
    """The line for a part only one revision has, with no kernel involved.

    Its volume comes from that revision's own metrics.json, which the build
    wrote next to the STEP files. A revision without one -- or without this part
    in it -- is reported by name and nothing else: the part is the news, and the
    number is what would have been nice to have beside it.
    """
    volume = _recorded_volume(build_dir, stem)
    if volume is None:
        return f"{phrase} {build_dir.name}"
    return f"{phrase} {build_dir.name}, {volume_phrase} {volume:.3f} mm3"


def _recorded_volume(build_dir, stem):
    try:
        metrics = json.loads(read_regular_text(build_dir / "metrics.json"))
        volume = metrics["parts"][stem]["volume_mm3"]
    except (OSError, ValueError, TypeError, KeyError, IndexError):
        return None
    return volume if isinstance(volume, (int, float)) else None


def _step_files(build_dir):
    """{stem: path} for the build's parts, which are its `*.step` files."""
    return {path.stem: path for path in sorted(build_dir.glob("*.step"))}


def _parse(args):
    """`--key value` pairs, nothing else -- composed by the hub, as in child.py."""
    opts = {name: None for name in _OPTIONS.values()}
    opts["occt_threads"] = 1
    rest = list(args)
    while rest:
        key = rest.pop(0)
        if key not in _OPTIONS:
            raise ValueError(f"unknown option {key!r}")
        if not rest:
            raise ValueError(f"{key} needs a value")
        opts[_OPTIONS[key]] = rest.pop(0)
    for required in ("old-dir", "new-dir"):
        if not opts[required.replace("-", "_")]:
            raise ValueError(f"--{required} is required")
    opts["occt_threads"] = int(opts["occt_threads"])
    if opts["occt_threads"] < 1:
        raise ValueError("--occt-threads must be at least 1")
    return opts


if __name__ == "__main__":
    sys.exit(main(sys.argv))
