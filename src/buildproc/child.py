#!/usr/bin/env python3
"""The build, as seen from inside the isolated process.

    python -m src.buildproc.child --project DIR --out DIR --result FILE \
                                  [--preview-mode iso] [--occt-threads N] \
                                  [--hang-dump-seconds N]

This is the first code in the process that knows anything about CAD, and it is
already behind the fence: the wrapper set the rlimits and exec'd this, the
parent is holding a wall-clock timer, and the environment it runs in was built
key by key and carries no credential (`runner.child_environment`).

Everything it does before `build()` is in a deliberate order:

  1. arm `faulthandler`, so a hang or a native crash produces a STACK rather
     than only an exit code;
  2. cap the OCCT thread pool, which has to happen before anything imports
     cadquery and creates the pool at its default size -- every core on the
     host;
  3. chdir into the model's tree and pin it as the project root;
  4. import the build half;
  5. re-arm the hang watchdog, so its budget measures the MODEL rather than
     the age of this process, and only then run the build.

Standard output and standard error are the build log and nothing else: the
parent captures them together, caps them and hands them back to whoever pushed
(SPEC 8A.2 step 5). The RESULT does not travel that way -- a model prints
whatever it likes, so the structured answer goes into a file the parent named.

NOTHING THIS PROCESS SAYS IS TRUSTED, AND THE RESULT FILE IS NOT AN EXCEPTION.
The exit code is the obvious case: a model can call `os._exit(0)` from its own
import and this process is gone before `build()` is ever called. The result file
is the same case one step along, and it took a working exploit to see it -- the
model runs in THIS interpreter, so it can read `--result` out of `sys.argv`,
write a result of its own choosing and exit 0, and a parent that believed the
file would report a build that never happened, with a project id and a file list
the model picked. No secret passed to this process fixes that: the model shares
its memory and can read anything this module knows.

So the file is a CLAIM the parent CHECKS, and it carries only claims that CAN be
checked (`runner._verified_files`): file names, each of which has to exist under
the output directory, be a regular file and not go through a symlink. The
project id is not in it -- the parent takes that from the push it accepted --
and neither is `meta`, which is a file in the output directory already.
"""

import faulthandler
import json
import os
import sys
import traceback
from pathlib import Path


# --- exit codes owned by the CHILD -----------------------------------------
# 1 is missing on purpose and is documented rather than assigned: that is what
# `faulthandler.dump_traceback_later(..., exit=True)` exits with when its
# deadline passes (it calls `_exit(1)` after printing the stack). Everything
# this module does itself therefore avoids 1, so a 1 coming out of here means
# the in-child watchdog fired and the log holds the stack it printed.
EXIT_OK = 0
EXIT_HANG_DUMP = 1
EXIT_BUILD_FAILED = 3      # BuildError: the model or a gate said no
EXIT_CRASHED = 4           # anything else, with a traceback in the log
EXIT_INVOCATION = 5        # this module was called wrongly (a hub bug)
EXIT_UNCAPPED = 6          # OCCT is present and would not be capped

# Where this repository is, resolved from this file rather than from the
# working directory -- step 3 below chdirs into the model's tree, and every
# `import` after that point still has to find the hub.
HUB_ROOT = Path(__file__).resolve().parents[2]

_OPTIONS = {
    "--project": "project",
    "--out": "out",
    "--result": "result",
    "--preview-mode": "preview_mode",
    "--occt-threads": "occt_threads",
    "--hang-dump-seconds": "hang_dump_seconds",
}


def main(argv):
    try:
        opts = _parse(argv[1:])
    except ValueError as exc:
        print(f"buildproc: {exc}", file=sys.stderr, flush=True)
        return EXIT_INVOCATION

    # 1. The second echelon against a hang, and the only one that says where.
    # This arming covers the START -- steps 2 to 4 below; step 5 arms it a
    # second time for the model itself, and the two windows are separate on
    # purpose (see there).
    #
    # `faulthandler` is implemented in C and does not take the GIL, so it fires
    # where a watchdog thread and a signal handler both cannot: a native call
    # that never returns to the interpreter -- an OCCT boolean, which is
    # precisely the operation this project has watched run for 45 minutes.
    # `enable()` covers the other native ending, a segfault or an abort inside
    # the kernel, which would otherwise leave nothing but a signal number.
    #
    # It is second echelon and not the defence: this runs inside the untrusted
    # process, so the model can call `faulthandler.cancel_dump_traceback_later()`
    # and switch it off. The parent's timer is the one that cannot be reached
    # from in here.
    faulthandler.enable()
    if opts["hang_dump_seconds"] is not None:
        faulthandler.dump_traceback_later(opts["hang_dump_seconds"], exit=True)

    # 2. Before cadquery exists in this process.
    try:
        _cap_occt_threads(opts["occt_threads"])
    except RuntimeError as exc:
        print(f"buildproc: {exc}", file=sys.stderr, flush=True)
        return EXIT_UNCAPPED

    # 3. Into the model's tree. Models read their own files by relative path
    # and have done since long before the hub built anything, so the working
    # directory is part of the contract with them.
    _absolutise_sys_path()
    os.chdir(opts["project"])

    # 4. The build half, imported only now: this module has to stay importable
    # on a python with no CAD stack at all, because that is what the tests of
    # the machinery around it run on.
    try:
        from src.cadbuild import paths
        from src.cadbuild.build import build
        from src.cadbuild.errors import BuildError
    except Exception:
        traceback.print_exc()
        return EXIT_CRASHED

    # Pinned rather than searched for. `project_root()` would otherwise walk UP
    # from the working directory looking for a project.json, and one directory
    # above an unpacked upload is the hub's own staging area.
    paths.set_project_root(opts["project"])

    # 5. Re-arm the watchdog, now that nothing preparatory is left and the next
    # call goes into the build half -- which reads project.json and then
    # IMPORTS model.py, the first line of somebody else's code in this process.
    #
    # `hang_dump_seconds` has to mean "the model has been stuck this long", not
    # "this process has existed this long", and the arming in step 1 measures
    # the second: it starts before the two expensive things above it. The OCP
    # import inside `_cap_occt_threads` costs 2-3 s on a workstation with the
    # CAD stack (measured; the build half's own import is 0.1 s), and the hub
    # is now the builder, so several of these start at once. Left on the first
    # arming, the deadline is reached during the START, and what the dump
    # prints is a stack inside runpy and the import machinery -- a build log
    # that accuses the model of a hang that never happened, handed to whoever
    # pushed (SPEC 8A.2 step 5).
    #
    # THE FIRST ARMING STAYS, and not as belt and braces: it is the only cover
    # for a hang in the start ITSELF -- a thread pool that never comes back, an
    # import that deadlocks -- and nothing else is watching that window. So
    # there are two windows, each getting the whole budget, rather than one
    # budget split between them.
    #
    # Calling it a second time REPLACES the pending timer instead of adding
    # one: `dump_traceback_later` cancels the previous one before arming. So
    # nothing has to be cancelled here, and no dump can arrive twice.
    #
    # WHAT IT COSTS, because it is not free. The model's deadline now falls at
    # `start + hang_dump_seconds` on the parent's clock rather than at
    # `hang_dump_seconds`, so it eats into the gap between the budget and the
    # parent's `wall_seconds` -- 10 s as the two are configured (limits.py:
    # 110 against 120). A start slower than that gap loses the dump: the
    # parent's SIGKILL lands first and the build is reported as a timeout with
    # no stack. Measured starts are 0.8-7.6 s on a workstation, the top of that
    # range at a load average of 300 on ten cores, so the gap covers everything
    # short of a host that has stopped working -- and losing the stack there is
    # the lesser harm next to printing one that blames the wrong code.
    if opts["hang_dump_seconds"] is not None:
        faulthandler.dump_traceback_later(opts["hang_dump_seconds"], exit=True)

    try:
        pid, _meta, files = build(Path(opts["out"]), preview_mode=opts["preview_mode"])
    except BuildError as exc:
        # The expected failure: the model does not build, or a gate refused it.
        # Distinguished from a crash by its own exit code because the hub
        # reports the two differently -- one is the pusher's problem and the
        # other is ours (SPEC 8A.2 step 6).
        print(f"build failed: {exc}", file=sys.stderr, flush=True)
        return EXIT_BUILD_FAILED
    except BaseException:  # noqa: B036 -- see below
        # BaseException, not Exception: a model that calls sys.exit() or gets a
        # KeyboardInterrupt would otherwise leave through the interpreter's own
        # path with a code this component never assigned, and the parent would
        # read the model's chosen number as if the machinery had produced it.
        traceback.print_exc()
        return EXIT_CRASHED

    # A CLAIM, not a report -- see the module docstring. It carries the one
    # thing the parent cannot work out on its own and CAN check: which of the
    # files under --out this build considers shippable. The project id does not
    # travel here (the parent has it from the push that was accepted) and
    # neither does `meta` (it is out/meta.json, a file the hub serves; a second
    # copy in here would be a second version of the same fact, and the wrong one
    # would be the one nobody looks at).
    try:
        Path(opts["result"]).write_text(
            json.dumps({"files": files}, ensure_ascii=False),
            encoding="utf-8")
    except OSError:
        traceback.print_exc()
        return EXIT_CRASHED
    print(f"build ok: {pid}, {len(files)} files", flush=True)
    return EXIT_OK


def _parse(args):
    """`--key value` pairs, nothing else. Composed by the hub, so any deviation
    is a bug in the hub rather than user input -- hence a ValueError with the
    offending token in it and no attempt at a friendly CLI."""
    opts = {name: None for name in _OPTIONS.values()}
    opts["preview_mode"] = "iso"
    opts["occt_threads"] = 1
    rest = list(args)
    while rest:
        key = rest.pop(0)
        if key not in _OPTIONS:
            raise ValueError(f"unknown option {key!r}")
        if not rest:
            raise ValueError(f"{key} needs a value")
        opts[_OPTIONS[key]] = rest.pop(0)
    for required in ("project", "out", "result"):
        if not opts[required]:
            raise ValueError(f"--{required} is required")
    opts["occt_threads"] = int(opts["occt_threads"])
    if opts["occt_threads"] < 1:
        raise ValueError("--occt-threads must be at least 1")
    if opts["hang_dump_seconds"] is not None:
        opts["hang_dump_seconds"] = float(opts["hang_dump_seconds"])
        if opts["hang_dump_seconds"] <= 0:
            raise ValueError("--hang-dump-seconds must be positive")
    return opts


def _cap_occt_threads(count):
    """Hold the OCCT pool to `count` threads, or refuse to run.

    Two reasons, and the first is the one that bites without ever looking like
    a limit at all: `RLIMIT_CPU` counts the processor time of every thread
    added together, while OCCT's default pool takes one thread per logical
    core. On a twenty-core host a 300-second CPU ceiling is therefore reached
    after fifteen seconds of wall clock, and the build dies "at the CPU limit"
    having run for a quarter of a minute. The second is ordinary neighbourliness
    -- the hub shares its host with everything else on it.

    A python with no USABLE OCP is not a hole and does not stop the build:
    without the kernel there is no pool and no model can compute anything
    either. OCP being present, loading, and REFUSING to be capped is the case
    that stops it, because that is an uncapped pool the CPU ceiling has already
    been sized against.
    """
    try:
        from OCP.OSD import OSD_ThreadPool
    except ImportError as exc:
        # `exc.name` IS the discrimination, and a blanket `except Exception`
        # threw it away. It names the module the import system had given up on:
        #
        #   name == "OCP"  -- the kernel is not usable in this interpreter at
        #       all. Either the package is absent (ModuleNotFoundError) or it is
        #       installed and its extension will not load -- measured, in a bare
        #       `python:3.11-slim` with requirements.txt but without the system
        #       libraries the Dockerfile installs, this is
        #       `ImportError(name="OCP"): libGL.so.1: cannot open shared object
        #       file`, and `import cadquery` fails with exactly the same error.
        #       No pool exists because no kernel does, and no model can compute
        #       anything either. Not a hole, and not a reason to refuse.
        #   anything else -- "OCP.OSD", from a missing submodule or a missing
        #       OSD_ThreadPool -- means OCP ITSELF loaded. The pool is there and
        #       will come up at one thread per logical core, against an
        #       RLIMIT_CPU sized for `occt_threads`. That is the case the old
        #       `except Exception` waved through, and it fails in the direction
        #       that hurts: on a twenty-core host the CPU ceiling then fires ten
        #       times sooner than its number says, with nothing in the log
        #       connecting the two.
        if exc.name != "OCP":
            raise RuntimeError(
                f"OCP loaded but its thread pool could not be reached ({exc}), "
                f"so the pool would come up uncapped") from exc
        print(f"buildproc: no usable OCP in this interpreter, so no thread pool "
              f"to cap ({exc})", file=sys.stderr, flush=True)
        return None
    try:
        pool = OSD_ThreadPool.DefaultPool_s(count)
        actual = pool.NbThreads()
    except Exception as exc:
        raise RuntimeError(
            f"OCP is importable but its thread pool would not be capped to "
            f"{count}: {exc}") from exc
    print(f"buildproc: OCCT thread pool capped at {actual}", flush=True)
    return actual


def _absolutise_sys_path():
    """Make every sys.path entry absolute before the chdir.

    `python -m` puts the working directory on sys.path, and the working
    directory is about to become somebody else's tree. A relative entry left
    behind would then resolve INSIDE the upload -- so an upload carrying its
    own `src/buildproc/` could answer an import made after this point. Current
    CPython already absolutises that entry; this does not depend on it.
    """
    sys.path[:] = [str(Path(entry).resolve()) if entry else str(Path.cwd())
                   for entry in sys.path]
    if str(HUB_ROOT) not in sys.path:
        sys.path.append(str(HUB_ROOT))


if __name__ == "__main__":
    sys.exit(main(sys.argv))
