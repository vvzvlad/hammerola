#!/usr/bin/env python3
"""One published revision, pictured or measured, from inside the isolated process.

    python -m src.buildproc.inspectchild --build-dir DIR --view VIEW \
        --kind snapshot --angle ANGLE --hide JSON --out FILE [--occt-threads N]
    python -m src.buildproc.inspectchild --build-dir DIR --view VIEW \
        --kind measure --part-a KEY --part-b KEY [--occt-threads N]

What `hammerola snapshot` and `hammerola measure` run on the hub
(`src/jobs.py`, `InspectTask`). A process of its own for the reason
`comparechild` is one: the rasteriser's stack and, for two printables, the
kernel are hundreds of megabytes the hub must not hold, so they run behind the
wrapper, under the same ceilings, in a process that ends with the answer.

Both read only what the build already wrote -- the view document
`<view>.json` and, to measure two printables, their `<key>.step` -- and build
nothing. Stdout is the answer and becomes the job's log; a snapshot also
writes its PNG to `--out`, a path the parent chose in the job's directory.

A question the revision cannot answer (a part the view does not show, every
part hidden, a STEP that is not one solid) is one sentence and
EXIT_BUILD_FAILED; a request composed wrongly is EXIT_INVOCATION, as in
`child.py`.
"""

import json
import sys
from pathlib import Path

# Imported, not copied, as `comparechild` does: the parent reads the codes
# through one table (`runner._inspect_outcome`).
from src.buildproc.child import (
    EXIT_BUILD_FAILED,
    EXIT_CRASHED,
    EXIT_INVOCATION,
    EXIT_OK,
    EXIT_UNCAPPED,
    _cap_occt_threads,
    _print_exc_quietly,
    _say,
)

# The two kinds of work, as `--kind` spells them. `runner.INSPECT_KINDS`
# spells them again on the hub's side, which may not import this module
# (it would bring `src.cadbuild` along).
SNAPSHOT = "snapshot"
MEASURE = "measure"

_OPTIONS = {
    "--build-dir": "build_dir",
    "--view": "view",
    "--kind": "kind",
    "--angle": "angle",
    "--hide": "hide",
    "--out": "out",
    "--part-a": "part_a",
    "--part-b": "part_b",
    "--occt-threads": "occt_threads",
}

# What each kind needs besides the build and the view.
_REQUIRED = {SNAPSHOT: ("angle", "hide", "out"), MEASURE: ("part_a", "part_b")}


def main(argv):
    """`_run`, under the same blanket handler as `child.py` and `comparechild`."""
    try:
        return _run(argv)
    except BaseException:
        _print_exc_quietly()
        return EXIT_CRASHED


def _run(argv):
    try:
        opts = _parse(argv[1:])
    except ValueError as exc:
        _say(f"inspectproc: {exc}")
        return EXIT_INVOCATION

    build_dir = Path(opts["build_dir"])
    scene = build_dir / f"{opts['view']}.json"
    if not scene.is_file():
        _say(f"inspectproc: this revision has no view {opts['view']!r}")
        return EXIT_BUILD_FAILED

    # Deferred: both modules bring numpy, trimesh and matplotlib with them.
    from src.cadbuild import measure, preview_png

    if opts["kind"] == SNAPSHOT:
        hidden = json.loads(opts["hide"])
        subtitle = f"angle {opts['angle']}" + (
            f", hidden: {', '.join(hidden)}" if hidden else "")
        try:
            preview_png.render_scene(scene, opts["out"], angle=opts["angle"],
                                     hide=hidden, title=opts["view"],
                                     subtitle=subtitle)
        except ValueError as exc:
            _say(f"inspectproc: {exc}")
            return EXIT_BUILD_FAILED
        print(f"view {opts['view']}, {subtitle}", flush=True)
        return EXIT_OK

    # Before anything can reach the kernel, which two printables do.
    try:
        _cap_occt_threads(opts["occt_threads"])
    except RuntimeError as exc:
        _say(f"inspectproc: {exc}")
        return EXIT_UNCAPPED
    print(f"view {opts['view']}: {opts['part_a']} and {opts['part_b']}",
          flush=True)
    try:
        found = measure.measure(build_dir, preview_png.load_scene(scene),
                                opts["part_a"], opts["part_b"])
    except ValueError as exc:
        _say(f"inspectproc: {exc}")
        return EXIT_BUILD_FAILED
    for line in measure.describe(found):
        print(line, flush=True)
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
    if opts["kind"] not in _REQUIRED:
        raise ValueError(f"--kind must be one of {', '.join(_REQUIRED)}")
    for name in ("build_dir", "view", *_REQUIRED[opts["kind"]]):
        if opts[name] is None:
            raise ValueError(f"--{name.replace('_', '-')} is required for "
                             f"--kind {opts['kind']}")
    opts["occt_threads"] = int(opts["occt_threads"])
    if opts["occt_threads"] < 1:
        raise ValueError("--occt-threads must be at least 1")
    return opts


if __name__ == "__main__":
    sys.exit(main(sys.argv))
