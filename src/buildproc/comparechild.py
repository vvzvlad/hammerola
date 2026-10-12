#!/usr/bin/env python3
"""Two published revisions, compared part by part, from inside the isolated process.

    python -m src.buildproc.comparechild --old-dir DIR --new-dir DIR \
                                         [--out-dir DIR --view VIEW_ID] \
                                         [--occt-threads N]

The only caller of `src.cadbuild.shapediff`. It runs here rather than in the
hub because importing OCCT costs ~270 MB resident (12 MB for a bare
interpreter, 271 MB after `from OCP.OSD import OSD_ThreadPool`; this path never
imports cadquery), so the kernel runs behind the wrapper, under the same
ceilings, in a process that ends when the answer is printed.

Stdout is always the answer; without `--out-dir` it is the whole of it and
nothing is written (the shape `hammerola diff --material` uses).

With `--out-dir` and `--view` (together or not at all) the walk also writes
`scene.json`, the viewer document, and `report.json`, the per-part summary.
Both cover only the parts that view shows (see `_write_artefacts`). The parent
names the directory and renames it into the comparison cache
(`store.publish_compare`). Unlike `child.py`'s result file nothing here needs
checking: no model runs in this process, only hub code reading two revisions
the hub published.

The part set is the `*.step` files of the two build directories, unioned by
stem (the build writes one per printable, `src/cadbuild/printables.py`). A stem
in both is compared; a stem on one side is named with the volume from its own
revision's metrics.json, no kernel needed.

A failure is the run not happening: bad invocation, uncappable thread pool, a
crash. A part the kernel cannot measure gets its reason on its own line and the
walk continues.
"""

import json
import sys
from pathlib import Path

# The thread-pool cap and exit codes are imported, not copied: same reasoning
# as `child.py`, and the parent reads the codes through one table
# (`runner._read_outcome`).
from src.buildproc.child import (
    EXIT_CRASHED,
    EXIT_INVOCATION,
    EXIT_OK,
    EXIT_UNCAPPED,
    _cap_occt_threads,
    _print_exc_quietly,
    _say,
)
# Imported at the top, unlike `child.py`'s deferred `src.cadbuild.build`:
# `shapediff` imports its OCP names inside functions, so the module costs 3 MB.
# The 271 MB arrives in `_run`, with the thread-pool cap.
from src.cadbuild import shapediff


_OPTIONS = {
    "--old-dir": "old_dir",
    "--new-dir": "new_dir",
    "--out-dir": "out_dir",
    "--view": "view",
    "--occt-threads": "occt_threads",
}

# Everything this process writes. Also spelled in `runner._COMPARE_ARTEFACTS`
# (the parent checks both arrived) and `store.COMPARE_FILES` (the file server
# refuses other names); the hub half may not import the build half, and
# `tests/test_compare.py` holds the three equal.
ARTEFACTS = ("scene.json", "report.json")


def main(argv):
    """`_run`, under the same blanket handler as `child.py`.

    An uncaught exception would exit 1, which the parent reads as a crash
    anyway, but the interpreter's traceback would go to a stderr the model may
    have closed. No watchdog is armed here, so 1 means nothing else; see
    `_compare_outcome`.
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

    # Checked before the cap imports the kernel (271 MB). The route checked
    # these before queueing, but the project can be erased in between, and
    # `Path.glob` on a missing directory yields nothing, so the report would say
    # "0 parts" and exit 0.
    old_dir = Path(opts["old_dir"])
    new_dir = Path(opts["new_dir"])
    out_dir = None if opts["out_dir"] is None else Path(opts["out_dir"])
    for flag, directory in (("--old-dir", old_dir), ("--new-dir", new_dir),
                            ("--out-dir", out_dir)):
        if directory is not None and not directory.is_dir():
            _say(f"compareproc: {flag} {directory} is not a directory")
            return EXIT_INVOCATION

    # The view documents, checked before the kernel for the same reason: a
    # view one revision never published cannot produce an artefact.
    view_files = ()
    if out_dir is not None:
        view_files = tuple(directory / f"{opts['view']}.json"
                           for directory in (old_dir, new_dir))
        for path in view_files:
            if not path.is_file():
                _say(f"compareproc: --view {opts['view']} is not a view of "
                     f"{path.parent.name}")
                return EXIT_INVOCATION

    # Every return above happens before the kernel (and its pool) exists, so
    # none of them leaves an uncapped pool.
    try:
        _cap_occt_threads(opts["occt_threads"])
    except RuntimeError as exc:
        _say(f"compareproc: {exc}")
        return EXIT_UNCAPPED

    diffs, refused, covered = _compare(shapediff, old_dir, new_dir,
                                       keep_shapes=out_dir is not None)
    if out_dir is None:
        return EXIT_OK

    # Deferred: the scene half tessellates and pulls in `ocp-tessellate` and
    # numpy, which the mode without an artefact must not pay for.
    from src.cadbuild import comparescene

    try:
        _write_artefacts(comparescene, out_dir, opts["view"], view_files,
                         diffs, refused, covered)
    except ValueError as exc:
        # `comparescene` answers a document it cannot merge with a ValueError,
        # and a view document that is not JSON reads the same. Print the
        # reason instead of a traceback; no dedicated exit code exists.
        _say(f"compareproc: {exc}")
        return EXIT_CRASHED
    return EXIT_OK


def _write_artefacts(scene, out_dir, view, view_files, diffs, refused, covered):
    """The viewer's document and the summary beside it, into `out_dir`.

    The published view documents go in unchanged, so the scene is built from
    what a reader would otherwise see; `diffs` is the difference geometry the
    walk kept (see `_compare`).

    `refused` and `covered` go only to the summary: a part nobody measured has
    no pieces to draw, so the scene shows it unhighlighted, while the summary
    must say something about every part the view shows.

    Both halves describe the parts the compared view shows. The walked stems
    are every printable both builds exported (what the printed report covers);
    using those would list parts in no picture.

    Not atomic: `out_dir` is a staging directory the parent publishes by rename
    after a clean exit (`store.publish_compare`).
    """
    document_a, document_b = (json.loads(path.read_text(encoding="utf-8"))
                              for path in view_files)
    documents = {
        "scene.json": scene.build_scene(document_a, document_b, diffs,
                                        view_id=view),
        "report.json": scene.report(diffs, document_a, document_b,
                                    view_id=view, refused=refused,
                                    covered=covered),
    }
    # Keyed by ARTEFACTS, so a name added there without a document fails here.
    for name in ARTEFACTS:
        (out_dir / name).write_text(json.dumps(documents[name]),
                                    encoding="utf-8")
    print(f"wrote {' and '.join(ARTEFACTS)} for view {view}", flush=True)


def _compare(shapediff, old_dir, new_dir, keep_shapes=False):
    """The walk itself: one line per part, then the tally.

    Returns `(diffs, refused, covered)` for the artefact. Which parts an
    artefact covers is decided by the view documents in `_write_artefacts`;
    this walk covers every part both builds exported, as the printed report
    needs.

    All three are keyed by STEP file stem, the catalogue key the model declared
    (`cadbuild.printables`). `diffs` holds only parts called changed, with the
    sliver-filtered measurement (its `added_mm3`/`removed_mm3` are unfiltered
    totals; `drop_slivers` only shrinks the piece lists). `refused` maps each
    part that could not be measured to the sentence its log line carries; it is
    kept apart so a refusal is never reported as "unchanged".

    `covered` is the set of stems actually compared (by digest or fuse). A view
    also shows `hardware` and `mock` entries, which have no STEP and are never
    walked, and `new`/`removed` stems were not fused; without this set
    `comparescene.report` would call those "unchanged". In the document a key
    in `refused` reads `not measured`, a key outside `covered` `not compared`.

    `keep_shapes` makes the engine return the solids so pieces are drawable;
    without it only numbers come back.
    """
    old_parts = _step_files(old_dir)
    new_parts = _step_files(new_dir)
    stems = sorted(set(old_parts) | set(new_parts))

    print(f"comparing {old_dir.name} -> {new_dir.name}, {len(stems)} parts",
          flush=True)

    diffs = {}
    refused = {}
    covered = set()
    tally = {"unchanged": 0, "changed": 0, "new": 0, "removed": 0,
             "not measured": 0}
    for stem in stems:
        found = None
        try:
            verdict, line, found = _one_part(
                shapediff, stem, old_parts.get(stem), new_parts.get(stem),
                old_dir, new_dir, keep_shapes=keep_shapes)
        except OSError as exc:
            # A part that raises (e.g. a `lid.step` that is a directory in the
            # writable `data/` volume) is recorded as not measured rather than
            # ending the walk and losing the parts already measured.
            verdict, line, found = ("not measured", f"not measured -- {exc}",
                                    str(exc))
        tally[verdict] += 1
        # Routed by the verdict, so the log's word and `report.json`'s word are
        # one decision.
        if verdict == "not measured":
            refused[stem] = found
        elif found is not None:
            diffs[stem] = found
        # `new` and `removed` were never fused, so nothing may call them
        # "unchanged"; every other verdict was compared.
        if verdict not in ("new", "removed"):
            covered.add(stem)
        print(f"  {stem}: {line}", flush=True)

    print(", ".join(f"{count} {name}" for name, count in tally.items()),
          flush=True)
    return diffs, refused, covered


def _one_part(shapediff, stem, old_step, new_step, old_dir, new_dir,
              keep_shapes=False):
    """One part's verdict, its sentence, and what the walk keeps about it.

    Returns `(tally key, text, found)`: the sliver-filtered measurement for
    `changed`, the gate's reason for `not measured`, None otherwise. `_compare`
    tells the two apart by the verdict.
    """
    if old_step is None:
        return "new", _sided(new_dir, stem, "new in", "volume"), None
    if new_step is None:
        return "removed", _sided(old_dir, stem, "gone since", "volume was"), None

    # The fast path, and the only sound direction of it: equal bytes are equal
    # geometry, so there is nothing for the kernel to do. Different bytes mean
    # nothing on their own -- a STEP header carries a timestamp -- so this can
    # only ever answer "unchanged".
    if shapediff.step_digest(old_step) == shapediff.step_digest(new_step):
        return "unchanged", "unchanged", None

    # The solids are requested only when a scene will be drawn: keeping every
    # fused piece is not free.
    measurement = (shapediff.measure(old_step, new_step, keep_shapes=True)
                   if keep_shapes else shapediff.measure(old_step, new_step))
    reason = shapediff.check(measurement)
    if reason is not None:
        return "not measured", f"not measured -- {reason}", reason

    # After `check`, never before: the gate's identities are sums over every
    # piece, and filtering first would break them.
    filtered = shapediff.drop_slivers(measurement)
    if not filtered["removed"] and not filtered["added"]:
        # Either the fuse found nothing (the ordinary case: STEP headers carry
        # a timestamp, so untouched parts miss the digest fast path), or every
        # piece was thinner than kernel noise. Only the second says "slivers".
        only_slivers = bool(measurement["removed"] or measurement["added"])
        return "unchanged", ("unchanged (only slivers)" if only_slivers
                             else "unchanged"), None
    return "changed", (f"+{measurement['added_mm3']:.3f} mm3 added, "
                       f"-{measurement['removed_mm3']:.3f} mm3 removed"), filtered


def _sided(build_dir, stem, phrase, volume_phrase):
    """The line for a part only one revision has, with no kernel involved.

    Its volume comes from that revision's metrics.json. Without one, or without
    this part in it, the part is reported by name only.
    """
    volume = _recorded_volume(build_dir, stem)
    if volume is None:
        return f"{phrase} {build_dir.name}"
    return f"{phrase} {build_dir.name}, {volume_phrase} {volume:.3f} mm3"


def _recorded_volume(build_dir, stem):
    try:
        metrics = json.loads(
            (build_dir / "metrics.json").read_text(encoding="utf-8"))
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
    # Together or neither: either alone is the hub composing the command line
    # wrong.
    if (opts["out_dir"] is None) != (opts["view"] is None):
        raise ValueError("--out-dir and --view go together or not at all")
    opts["occt_threads"] = int(opts["occt_threads"])
    if opts["occt_threads"] < 1:
        raise ValueError("--occt-threads must be at least 1")
    return opts


if __name__ == "__main__":
    sys.exit(main(sys.argv))
