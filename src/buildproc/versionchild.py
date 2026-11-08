#!/usr/bin/env python3
"""A project's version, asked of its `version.py` from inside the isolated process.

    python -m src.buildproc.versionchild --project DIR --result FILE

What `runner.run_version` runs before every build of a tree holding a
`version.py` (`jobs._build_and_publish`). The file is the project's code, so it
runs here, behind the wrapper, and never in the hub. The working directory and
`sys.path[0]` are the project's directory, so `version()` reads a ChangeLog by
a relative path and imports the project's own modules.

`version()` returning a str is written to `--result` as `{"version": ...}` and
said in the log. Anything else -- an exception, no `version()`, a value that is
not a str -- is a traceback or one line in the log and EXIT_BUILD_FAILED.
"""

import json
import os
import sys
from pathlib import Path

# Imported, not copied, as `inspectchild` does: the parent reads the codes
# through one table (`runner._inspect_outcome`).
from src.buildproc.child import (
    EXIT_BUILD_FAILED,
    EXIT_CRASHED,
    EXIT_INVOCATION,
    EXIT_OK,
    _absolutise_sys_path,
    _print_exc_quietly,
    _say,
)

_OPTIONS = {"--project": "project", "--result": "result"}


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
        _say(f"versionproc: {exc}")
        return EXIT_INVOCATION

    project = str(Path(opts["project"]).resolve())
    _absolutise_sys_path()
    os.chdir(project)
    sys.path.insert(0, project)

    # BaseException: a `sys.exit()` in version.py is its failure too, and
    # must not leave with a code of its own choosing.
    try:
        import version
        found = version.version()
    except BaseException:
        _print_exc_quietly()
        _say("version.py: version() gave no version")
        return EXIT_BUILD_FAILED
    if not isinstance(found, str):
        _say(f"version.py: version() returned {type(found).__name__}, "
             f"not a str")
        return EXIT_BUILD_FAILED

    Path(opts["result"]).write_text(json.dumps({"version": found}),
                                    encoding="utf-8")
    _say(f"version: {found}")
    return EXIT_OK


def _parse(args):
    """`--key value` pairs, nothing else -- composed by the hub, as in child.py."""
    opts = {name: None for name in _OPTIONS.values()}
    rest = list(args)
    while rest:
        key = rest.pop(0)
        if key not in _OPTIONS:
            raise ValueError(f"unknown option {key!r}")
        if not rest:
            raise ValueError(f"{key} needs a value")
        opts[_OPTIONS[key]] = rest.pop(0)
    for name in _OPTIONS.values():
        if not opts[name]:
            raise ValueError(f"--{name} is required")
    return opts


if __name__ == "__main__":
    sys.exit(main(sys.argv))
