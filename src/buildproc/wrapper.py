#!/usr/bin/env python3
"""The outer wrapper: put the ceilings on, then become the child.

    python -m src.buildproc.wrapper '<rlimit-spec-json>' -- <argv...>

One process, three statements: set the rlimits on ITSELF, say what it set, then
`execv` the target. The target inherits every limit, because rlimits survive
exec and the pid does not change -- so by the time the interpreter that will
import the model exists, the ceilings are already the kernel's business.

WHY THIS IS A PROCESS AND NOT A CALLBACK is argued in limits.py: `preexec_fn`
runs between fork and exec of a MULTI-THREADED parent (the hub is
`ThreadingHTTPServer`), where only async-signal-safe code is allowed and the
interpreter's own locks may be held by threads that no longer exist. Nothing
here runs in that window -- this is a plain fresh interpreter with one thread.

WHY IT DOES NOT SIMPLY LET THE CHILD LIMIT ITSELF: the ceilings are then in
force for the child's whole existence, including its imports. A bug or a hang
in the import chain -- `src.cadbuild`, cadquery, VTK -- is inside the fence
rather than outside it, and the fence is up before any code that could be
influenced by the request has been read from disk.

THE TARGET ARGV IS COMPOSED BY THE HUB AND NEVER BY REQUEST DATA. This module
will `execv` whatever it is handed; that is what makes it reusable and what
makes it dangerous if the composition ever moves. `runner.py` builds it out of
`sys.executable` and module names that are literals in this repository -- the
untrusted tree contributes a directory PATH and nothing else.
"""

import json
import os
import sys

from src.buildproc.limits import (
    EXIT_EXEC_FAILED,
    EXIT_LIMITS_UNAVAILABLE,
    EXIT_WRAPPER_INVOCATION,
    LimitsUnavailable,
    apply_process_limits,
)


USAGE = "usage: python -m src.buildproc.wrapper '<rlimit-spec-json>' -- <argv...>"


def main(argv):
    if len(argv) < 4 or argv[2] != "--":
        _say(USAGE)
        return EXIT_WRAPPER_INVOCATION
    try:
        spec = json.loads(argv[1])
    except ValueError as exc:
        _say(f"buildproc: the rlimit spec is not JSON: {exc}\n{USAGE}")
        return EXIT_WRAPPER_INVOCATION
    if not isinstance(spec, dict):
        _say(f"buildproc: the rlimit spec must be an object\n{USAGE}")
        return EXIT_WRAPPER_INVOCATION
    target = argv[3:]

    try:
        applied = apply_process_limits(spec)
    except LimitsUnavailable as exc:
        # Fail closed. Nothing untrusted has run yet and nothing will: the
        # build is refused here rather than started without a ceiling it was
        # configured to have.
        _say(f"buildproc: refusing to start the build -- {exc}")
        return EXIT_LIMITS_UNAVAILABLE

    # Into the build log, where it is the only record of what was actually
    # applied as opposed to requested (apply_process_limits clamps down to an
    # inherited hard limit without complaining).
    _say("buildproc: ceilings in force: " + " ".join(applied))

    try:
        # execv, not spawn: the wrapper does not stay around to be a second
        # thing that can hang, and the child keeps this pid -- so the parent's
        # SIGKILL, and the process group it kills, need know about one pid only.
        os.execv(target[0], target)
    except OSError as exc:
        _say(f"buildproc: cannot exec {target[0]}: {exc}")
        return EXIT_EXEC_FAILED
    # Unreachable: execv either replaces this process or raises.
    return EXIT_EXEC_FAILED


def _say(message):
    """Write to stderr and FLUSH -- execv does not flush anything for us."""
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
