#!/usr/bin/env python3
"""A project's `published(hub)`, called from inside the isolated process.

    python -m src.buildproc.publishedchild --project DIR [--occt-threads N]

What `runner.run_published` runs after a revision has been published
(`jobs._published_and_record`). `published` is the project's code, and it
uploads wherever the author wants with keys from the environment, so it runs
here, behind the wrapper, and never in the hub. `Hub` is the helpers it is
handed (`src.cadbuild.publish`: a view as a GLB, and its compression); it
needs the CAD kernel, which is why it is imported here and nowhere in the hub.

The start is `child.py`'s: arm `faulthandler`, cap the OCCT pool before
anything imports cadquery, chdir into the tree, pin the project root, and
import model.py as a build does. The working directory and `sys.path[0]` are
the project's directory.

Nothing comes back but the log and the exit code: `published()` returning is
EXIT_OK, and anything it raises (`sys.exit()` included) is a traceback, one
line saying so, and EXIT_BUILD_FAILED.
"""

import faulthandler
import os
import sys
from pathlib import Path

# Imported, not copied, as `versionchild` does: the parent reads the codes
# through one table (`runner._inspect_outcome`).
from src.buildproc.child import (
    EXIT_BUILD_FAILED,
    EXIT_CRASHED,
    EXIT_INVOCATION,
    EXIT_OK,
    EXIT_UNCAPPED,
    _absolutise_sys_path,
    _cap_occt_threads,
    _print_exc_quietly,
    _say,
)

_OPTIONS = {"--project": "project", "--occt-threads": "occt_threads"}


def main(argv):
    """`_run`, under the same blanket handler as `child.py`."""
    try:
        return _run(argv)
    except BaseException:
        _print_exc_quietly()
        return EXIT_CRASHED


def _run(argv):
    try:
        opts = _parse(argv[1:])
    except ValueError as exc:
        _say(f"publishedproc: {exc}")
        return EXIT_INVOCATION

    faulthandler.enable()
    try:
        _cap_occt_threads(opts["occt_threads"])
    except RuntimeError as exc:
        _say(f"publishedproc: {exc}")
        return EXIT_UNCAPPED

    _absolutise_sys_path()
    os.chdir(opts["project"])

    try:
        from src.cadbuild import paths
        from src.cadbuild.geometry import load_model
        from src.cadbuild.modeltext import shown
        from src.cadbuild.publish import Hub
    except Exception:
        _print_exc_quietly()
        return EXIT_CRASHED

    # Pinned rather than searched for, as in `child.py`.
    paths.set_project_root(opts["project"])

    # BaseException: a `sys.exit()` in the project's code is its failure too,
    # and must not leave with a code of its own choosing.
    try:
        model = load_model()
        model.published(Hub())
    except BaseException as exc:
        _print_exc_quietly()
        _say(f"published() raised {type(exc).__name__}: "
             f"{shown(exc, str)}")
        return EXIT_BUILD_FAILED
    _say("published(): done")
    return EXIT_OK


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
    if not opts["project"]:
        raise ValueError("--project is required")
    opts["project"] = str(Path(opts["project"]).resolve())
    opts["occt_threads"] = int(opts["occt_threads"])
    if opts["occt_threads"] < 1:
        raise ValueError("--occt-threads must be at least 1")
    return opts


if __name__ == "__main__":
    sys.exit(main(sys.argv))
