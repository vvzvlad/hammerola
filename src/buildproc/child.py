#!/usr/bin/env python3
"""The build, as seen from inside the isolated process.

    python -m src.buildproc.child --project DIR --out DIR --result FILE \
                                  [--preview-mode iso] [--occt-threads N] \
                                  [--hang-dump-seconds N] [--force true|false] \
                                  [--baseline FILE]

Runs behind the fence: the wrapper set the rlimits and exec'd this, the parent
holds a wall-clock timer, and the environment carries no credential
(`runner.child_environment`).

Before `build()`, in this order:

  1. arm `faulthandler`, so a hang or a native crash produces a stack;
  2. cap the OCCT thread pool, before anything imports cadquery and creates
     the pool at one thread per core;
  3. chdir into the model's tree and pin it as the project root;
  4. import the build half;
  5. re-arm the hang watchdog, so its budget measures the model rather than
     the age of this process, then run the build.

Stdout and stderr are the build log only; the parent captures and caps them
(SPEC 8A.2 step 5). The result goes into a file the parent named, because a
model prints whatever it likes.

Nothing this process says is trusted, the result file included: the model runs
in this interpreter, can read `--result` from `sys.argv`, write its own result
and exit 0. So the file is a claim the parent checks (`runner._verified_files`)
and carries only checkable claims: file names, each of which must be a regular
file under the output directory, not reached through a symlink. The project id
comes from the accepted push and `meta` is already a file in the output
directory, so neither is in it.
"""

import faulthandler
import json
import os
import sys
import traceback
from pathlib import Path


# --- exit codes owned by the CHILD -----------------------------------------
# 1 is not assigned: it is what `faulthandler.dump_traceback_later(...,
# exit=True)` exits with (`_exit(1)` after printing the stack), and `runner`
# maps it to STATUS_HANG. CPython also exits 1 on an uncaught exception, so
# nothing in this module may exit 1: `main` catches BaseException and answers
# EXIT_CRASHED, and every failure-path print goes through `_say` or
# `_print_exc_quietly`, which never raise (a model can close stdout/stderr).
# Each guard has its own test in `tests/buildproc/test_build_child.py`.
EXIT_OK = 0
EXIT_HANG_DUMP = 1
EXIT_BUILD_FAILED = 3      # BuildError: the model or a gate said no
EXIT_CRASHED = 4           # anything else, with a traceback in the log
EXIT_INVOCATION = 5        # this module was called wrongly (a hub bug)
EXIT_UNCAPPED = 6          # OCCT is present and would not be capped

# Resolved from this file, not the working directory: step 3 chdirs into the
# model's tree and later imports still have to find the hub.
HUB_ROOT = Path(__file__).resolve().parents[2]

_OPTIONS = {
    "--project": "project",
    "--out": "out",
    "--result": "result",
    "--preview-mode": "preview_mode",
    "--occt-threads": "occt_threads",
    "--hang-dump-seconds": "hang_dump_seconds",
    "--force": "force",
    # The previous `dev` build's metrics.json, already copied into this
    # process's scratch by the parent (`runner.run_build`), never a path into
    # the store. Absent when there is no `dev` build to compare against.
    "--baseline": "baseline",
}

# `--force` takes a value because the parser only understands `--key value`
# pairs; a word other than these two is an invocation error, not False.
_BOOLEAN_VALUES = {"true": True, "false": False}


def _say(text):
    """One line of the build log, or none. Never raises.

    A model.py can close `sys.stdout`/`sys.stderr`; an unguarded raise would
    leave `main` and exit 1, which the parent reads as the watchdog. Both
    streams land in one log (`stderr=subprocess.STDOUT` in `runner`).
    """
    try:
        print(text, file=sys.stderr, flush=True)
    except BaseException:  # nowhere left to report to
        pass


def _print_exc_quietly():
    """`traceback.print_exc()`, and never a second exception out of it.

    If the model closed the log stream, writing the traceback raises and the
    interpreter would exit 1, which reads as a hang. `BaseException` because
    anything that escapes exits 1.
    """
    try:
        traceback.print_exc()
    except BaseException:  # nowhere left to report to
        pass


def main(argv):
    """`_run`, with the guarantee the parent reads the exit code under.

    Nothing leaves by raising, because the interpreter would exit 1, the
    watchdog's code. A blanket handler keeps the property in one place;
    `BaseException` because the interpreter exits 1 for anything uncaught.
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
        _say(f"buildproc: {exc}")
        return EXIT_INVOCATION

    # 1. Hang watchdog for the start (steps 2-4); step 5 re-arms it for the
    # model. `faulthandler` is C code that fires even inside a native call that
    # never returns (an OCCT boolean); `enable()` covers segfaults and aborts.
    # It runs inside the untrusted process and the model can cancel it; the
    # parent's timer is the defence.
    faulthandler.enable()
    if opts["hang_dump_seconds"] is not None:
        faulthandler.dump_traceback_later(opts["hang_dump_seconds"], exit=True)

    # 2. Before cadquery exists in this process.
    try:
        _cap_occt_threads(opts["occt_threads"])
    except RuntimeError as exc:
        _say(f"buildproc: {exc}")
        return EXIT_UNCAPPED

    # 3. Into the model's tree: models read their own files by relative path,
    # so the working directory is part of the contract with them.
    _absolutise_sys_path()
    os.chdir(opts["project"])

    # 4. Imported only now: this module must stay importable without the CAD
    # stack, which is what the tests of the surrounding machinery run on.
    try:
        from src.cadbuild import paths
        from src.cadbuild.build import build
        from src.cadbuild.errors import BuildError
    except Exception:
        _print_exc_quietly()
        return EXIT_CRASHED

    # Pinned rather than searched for: `project_root()` would walk up from the
    # working directory, and the directory above an upload is the hub's staging.
    paths.set_project_root(opts["project"])

    # 5. Re-arm the watchdog before the build half imports model.py, so
    # `hang_dump_seconds` means "the model has been stuck this long", not "this
    # process has existed this long". The start (OCP import 2-3 s, more when
    # several builds start at once) would otherwise use up the budget and the
    # dump would blame runpy and the import machinery.
    #
    # The first arming covers hangs in the start itself; each window gets the
    # whole budget. A second call replaces the pending timer.
    #
    # Cost: the model's deadline falls at `start + hang_dump_seconds`, eating
    # into the gap to the parent's `wall_seconds` (10 s, see limits.py). A start
    # slower than that loses the dump to the parent's SIGKILL. Measured starts
    # are 0.8-7.6 s.
    if opts["hang_dump_seconds"] is not None:
        faulthandler.dump_traceback_later(opts["hang_dump_seconds"], exit=True)

    try:
        pid, _meta, files = build(Path(opts["out"]),
                                  preview_mode=opts["preview_mode"],
                                  force=opts["force"],
                                  baseline=opts["baseline"])
    except BuildError as exc:
        # The expected failure: the model does not build, or a gate refused it.
        # The expected failure: the model does not build or a gate refused it.
        # Its own exit code because the hub reports it as the pusher's problem,
        # not ours (SPEC 8A.2 step 6).
        _say(f"build failed: {exc}")
        return EXIT_BUILD_FAILED
    except BaseException:  # noqa: B036 -- see below
        # BaseException, not Exception: a model that calls sys.exit() or gets a
        # KeyboardInterrupt would otherwise leave through the interpreter's own
        # path with a code this component never assigned, and the parent would
        # read the model's chosen number as if the machinery had produced it.
        _print_exc_quietly()
        return EXIT_CRASHED

    # A claim, not a report (see the module docstring): only which files under
    # --out this build considers shippable. The project id comes from the push
    # and `meta` is out/meta.json already.
    try:
        Path(opts["result"]).write_text(
            json.dumps({"files": files}, ensure_ascii=False),
            encoding="utf-8")
    except OSError:
        _print_exc_quietly()
        return EXIT_CRASHED
    _say(f"build ok: {pid}, {len(files)} files")
    return EXIT_OK


def _parse(args):
    """`--key value` pairs, nothing else. Composed by the hub, so any deviation
    is a bug in the hub rather than user input -- hence a ValueError with the
    offending token in it and no attempt at a friendly CLI."""
    opts = {name: None for name in _OPTIONS.values()}
    opts["preview_mode"] = "iso"
    opts["occt_threads"] = 1
    opts["force"] = "false"
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
    if opts["force"] not in _BOOLEAN_VALUES:
        raise ValueError(f"--force takes true or false, not {opts['force']!r}")
    opts["force"] = _BOOLEAN_VALUES[opts["force"]]
    if opts["hang_dump_seconds"] is not None:
        opts["hang_dump_seconds"] = float(opts["hang_dump_seconds"])
        if opts["hang_dump_seconds"] <= 0:
            raise ValueError("--hang-dump-seconds must be positive")
    return opts


def _cap_occt_threads(count):
    """Hold the OCCT pool to `count` threads, or refuse to run.

    `RLIMIT_CPU` counts all threads together and OCCT's default pool has one
    thread per logical core, so on a twenty-core host a 300-second CPU ceiling
    fires after fifteen seconds of wall clock. The host is also shared.

    A python with no usable OCP does not stop the build: without the kernel
    there is no pool. OCP loading and refusing to be capped does, because the
    CPU ceiling is sized for a capped pool.
    """
    try:
        from OCP.OSD import OSD_ThreadPool
    except ImportError as exc:
        # `exc.name` tells the cases apart:
        #   "OCP" -- the kernel is unusable here: absent, or its extension will
        #       not load (e.g. `libGL.so.1` missing without the Dockerfile's
        #       system libraries). No kernel, no pool; not a reason to refuse.
        #   anything else ("OCP.OSD") -- OCP itself loaded, so the pool exists
        #       and would come up at one thread per core against an RLIMIT_CPU
        #       sized for `occt_threads`.
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

    `python -m` puts the working directory on sys.path; left relative, it would
    resolve inside the upload after the chdir, so an upload carrying its own
    `src/buildproc/` could answer imports. Does not rely on CPython already
    absolutising it.
    """
    sys.path[:] = [str(Path(entry).resolve()) if entry else str(Path.cwd())
                   for entry in sys.path]
    if str(HUB_ROOT) not in sys.path:
        sys.path.append(str(HUB_ROOT))


if __name__ == "__main__":
    sys.exit(main(sys.argv))
