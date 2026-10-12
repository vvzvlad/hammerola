#!/usr/bin/env python3
"""The outer wrapper: put the ceilings on, then become the child.

    python -m src.buildproc.wrapper '<rlimit-spec-json>' -- <argv...>

Sets the rlimits on itself, prints what it set, then `execv`s the target, which
inherits every limit (rlimits survive exec and the pid stays), so the ceilings
are in force before the interpreter that imports the model exists.

A process rather than `preexec_fn` (see limits.py): the hub is multi-threaded,
and between fork and exec only async-signal-safe code may run. This is a fresh
single-threaded interpreter.

Not the child limiting itself: this way the fence is up during the child's
imports too (`src.cadbuild`, cadquery, VTK), before any request-influenced code
is read from disk.

The target argv is composed by the hub, never by request data: this module
`execv`s whatever it is handed. `runner.py` builds it from `sys.executable` and
literal module names; the untrusted tree contributes only a directory path.
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
