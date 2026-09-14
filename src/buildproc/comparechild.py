#!/usr/bin/env python3
"""Two published revisions, compared part by part, from inside the isolated process.

    python -m src.buildproc.comparechild --old-dir DIR --new-dir DIR \
                                         [--out-dir DIR --view VIEW_ID] \
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

THE STDOUT OF THIS PROCESS IS ALWAYS THE ANSWER, and WITHOUT `--out-dir` it is
the whole of it: nothing is written anywhere, and the report is read by a person
through the job log. That is the shape `hammerola diff --material` uses and it
did not change when the second mode arrived.

WITH `--out-dir` AND `--view` -- and they are given together or not at all --
the same walk also leaves an artefact behind: `scene.json`, the viewer document
a browser opens, and `report.json`, the per-part summary beside it. BOTH ARE
ABOUT THE PARTS THAT VIEW SHOWS and nothing else -- a narrower question than
the one the stdout below answers, and `_write_artefacts` says why. The parent
names that directory and renames it into the comparison cache afterwards
(`store.publish_compare`), so nothing here decides where anything lands. Nothing
here has to be checked the way `child.py`'s result file is checked either: the
model does not run in this process at all -- this is the hub's own code reading
two revisions the hub itself published -- so the parent's only question about
the artefact is whether the two files it asked for are there.

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
    "--out-dir": "out_dir",
    "--view": "view",
    "--occt-threads": "occt_threads",
}

# Everything this process ever writes, and the ONLY names under it. Spelled
# again in `runner._COMPARE_ARTEFACTS`, which is the parent checking that both
# arrived, and in `store.COMPARE_FILES`, which is the file server refusing every
# other name under a comparison URL. Three copies because the hub half may not
# import the build half (src/cadbuild/__init__.py says why, and runner.py is on
# the serving side); `tests/test_compare.py` holds them equal, which is the
# arrangement `render.py` already uses for `cadbuild.parts.KINDS`.
ARTEFACTS = ("scene.json", "report.json")


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
    out_dir = None if opts["out_dir"] is None else Path(opts["out_dir"])
    for flag, directory in (("--old-dir", old_dir), ("--new-dir", new_dir),
                            ("--out-dir", out_dir)):
        if directory is not None and not directory.is_dir():
            _say(f"compareproc: {flag} {directory} is not a directory")
            return EXIT_INVOCATION

    # THE TWO VIEW DOCUMENTS, CHECKED HERE FOR THE REASON THE DIRECTORIES ARE.
    # A scene is built out of them, so a view one of the revisions never
    # published cannot produce an artefact -- and finding that out after the
    # kernel is imported and every part is fused costs the whole run for an
    # answer one stat had. The route checked the same thing before queueing the
    # job; what puts it back is the window between the queue and this process.
    view_files = ()
    if out_dir is not None:
        view_files = tuple(directory / f"{opts['view']}.json"
                           for directory in (old_dir, new_dir))
        for path in view_files:
            if not path.is_file():
                _say(f"compareproc: --view {opts['view']} is not a view of "
                     f"{path.parent.name}")
                return EXIT_INVOCATION

    # Still ahead of everything this cap has to be ahead of. It configures a
    # pool that comes into being with the kernel, so a return above this line
    # cannot leave one uncapped: nothing above it has imported one.
    try:
        _cap_occt_threads(opts["occt_threads"])
    except RuntimeError as exc:
        _say(f"compareproc: {exc}")
        return EXIT_UNCAPPED

    diffs, refused, covered = _compare(shapediff, old_dir, new_dir,
                                       keep_shapes=out_dir is not None)
    if out_dir is None:
        return EXIT_OK

    # DEFERRED, AND NOT WHERE `shapediff` IS IMPORTED. `shapediff` costs 3 MB and
    # brings no kernel with it, which is why the top of this module can afford
    # it; the scene half tessellates, so importing it pulls in `ocp-tessellate`
    # and numpy -- work the mode WITHOUT an artefact must not pay for. It is the
    # same reasoning `child.py` uses to defer `src.cadbuild.build`, and the cap
    # above is already in place, which is the property this import needs.
    from src.cadbuild import comparescene

    try:
        _write_artefacts(comparescene, out_dir, opts["view"], view_files,
                         diffs, refused, covered)
    except ValueError as exc:
        # A REFUSAL AND NOT A STACK. `comparescene` answers a document it cannot
        # merge with a ValueError, deliberately — its docstring says the fault
        # is in the document rather than in a model — and a view document that
        # is not JSON any more reads the same way. There is no exit code for
        # "these two revisions cannot be put in one scene", and inventing one
        # would be a table the parent has to learn; what this saves is the
        # interpreter's traceback landing in a log a person reads.
        _say(f"compareproc: {exc}")
        return EXIT_CRASHED
    return EXIT_OK


def _write_artefacts(scene, out_dir, view, view_files, diffs, refused, covered):
    """The viewer's document and the summary beside it, into `out_dir`.

    The two published view documents go in unchanged -- they are what the
    browser already loads for each revision, so the scene is built from exactly
    what a reader would otherwise see -- and `diffs` is the difference geometry
    the walk kept (see `_compare`).

    `refused` AND `covered` GO TO THE SUMMARY AND NOT TO THE SCENE, and that is
    the whole asymmetry between the two halves. A part nobody measured -- turned
    down by the gate, or never walked at all because no build exports a STEP for
    it -- has no piece lists to draw, so the picture stays as it is: nothing
    bright, which is already the honest answer. The document is the half that
    has to say something about every part the view shows, so it is the half that
    is told what was measured and what was not. Anything else there is a
    "unchanged" said about a part nobody looked at.

    BOTH HALVES ARE HANDED THE SAME TWO DOCUMENTS, and that is the whole of what
    an artefact is about: a comparison describes the parts the compared VIEW
    shows. The stems this process walked are every printable the two builds
    exported, which is the question the PRINTED report answers; handing those to
    `scene.report` instead would list parts that are in no picture, and would
    disagree with the scene over a part kept in the catalogue and dropped from
    this view.

    NOT ATOMIC AND NOT MEANT TO BE. `out_dir` is a staging directory of the
    parent's, published by a rename once this process has exited cleanly
    (`store.publish_compare`), so a half-written file here is a directory that
    is thrown away rather than a cache entry anybody can read.
    """
    document_a, document_b = (json.loads(read_regular_text(path))
                              for path in view_files)
    documents = {
        "scene.json": scene.build_scene(document_a, document_b, diffs,
                                        view_id=view),
        "report.json": scene.report(diffs, document_a, document_b,
                                    view_id=view, refused=refused,
                                    covered=covered),
    }
    # Keyed by ARTEFACTS rather than written one call at a time, so a name added
    # to that tuple without a document behind it fails here instead of leaving
    # the parent looking for a file nothing writes.
    for name in ARTEFACTS:
        (out_dir / name).write_text(json.dumps(documents[name]),
                                    encoding="utf-8")
    print(f"wrote {' and '.join(ARTEFACTS)} for view {view}", flush=True)


def _compare(shapediff, old_dir, new_dir, keep_shapes=False):
    """The walk itself: one line per part, then the tally.

    Returns `(diffs, refused, covered)` -- the harvest an artefact is built
    from, and nothing the log needs. WHICH PARTS AN ARTEFACT IS ABOUT IS NOT
    DECIDED HERE: the two view documents say that, and `_write_artefacts` hands
    them to both halves. This walk covers every part the two builds exported,
    including the ones no view shows, because that is what the PRINTED report is
    asked for.

    ALL THREE ARE KEYED the way every part is keyed here: by the stem of its
    STEP file, which is the catalogue key the model declared
    (`cadbuild.printables`). `diffs` holds only the parts this walk called
    CHANGED; `refused` holds, for every part it could not measure at all, the
    sentence that part's line in the log carries.

    THE TWO MAPS ARE KEPT APART BECAUSE THEY ARE DIFFERENT NEWS, and that is
    what keeps `report.json` and the printed report from saying the same thing
    about the same part. A part in NEITHER map, of the ones this walk COMPARED,
    is one it called unchanged -- its bytes did not move, the fuse found
    nothing, or what it found was all slivers -- and there is no difference
    geometry to draw for it and nothing to say about it. A part in `refused` has
    no geometry to draw either, since a measurement the gate turned down carries
    no piece lists at all; what it has is a reason, and publishing that instead
    of "unchanged" is the whole point of the split. Reported as unchanged, a
    refusal to answer becomes the most confident answer there is.

    `covered` IS THAT "OF THE ONES THIS WALK COMPARED", HANDED OVER RATHER THAN
    ASSUMED. The parts a VIEW shows are not the parts this walk sees: a build
    exports a STEP per printable, and a view also shows `hardware` and `mock`
    entries, which have no geometry of ours and no STEP file, so nothing here
    ever looks at them. Without this set `comparescene.report` reads a key's
    absence from both maps as "unchanged" and publishes an M3x8 swapped for an
    M3x12 as a part nobody touched. A stem the walk called `new` or `removed` is
    out of it too: the two builds did not both export that part, so nothing was
    fused and nothing was established about how it changed.

    THE TWO MAPS ARE THE TWO SILENCES, AND THE DOCUMENT SPELLS THEM DIFFERENTLY.
    A key in `refused` is `not measured` there and something is wrong with it; a
    key merely outside `covered` is `not compared`, which is the ordinary state
    of every bought screw a view shows. This walk needs no such word -- it never
    sees those parts at all -- so its lines and its tally are untouched by the
    split, and the one place the two accounts still have to agree on a word is
    the refusal.

    The value is the SLIVER-FILTERED measurement, because that is the one whose
    piece lists are the difference rather than the kernel's noise. Its
    `added_mm3` and `removed_mm3` are untouched by that filter (`drop_slivers`
    only shrinks the lists), so the totals are the measured ones.

    `keep_shapes` is what makes those pieces drawable at all: without it the
    engine returns numbers and no solids, which is all the printed report needs
    and all it is asked for on the path that publishes nothing.
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
            # THE CONTRACT AT THE TOP OF THIS MODULE, held for the failures that
            # RAISE and not only for the ones `check` puts into words. `data/`
            # is one volume every build can write anywhere in, so a `lid.step`
            # that is a directory or a fifo is an ordinary `model.py` mistake --
            # and letting it out of this loop would throw away the eleven parts
            # already measured and end the job as a crash with no report at all.
            # The sentence goes into `refused` for the same reason the gate's
            # does: this part was not measured, and only the wording differs.
            verdict, line, found = ("not measured", f"not measured -- {exc}",
                                    str(exc))
        tally[verdict] += 1
        # ROUTED BY THE VERDICT AND NOT BY WHAT CAME BACK, so the word the log
        # prints and the word `report.json` carries are one decision made in one
        # place. Asked of the value instead -- a dict here, a string there --
        # this would be a second rule to keep in step with `_one_part`.
        if verdict == "not measured":
            refused[stem] = found
        elif found is not None:
            diffs[stem] = found
        # BY THE VERDICT AGAIN, and `new` and `removed` are the two it excludes:
        # they say the two builds did not both export this part, so no pair of
        # solids was ever put together and nothing was established about how the
        # part changed. Everything else here was compared -- by digest or by
        # fuse -- and only about those may anything say "unchanged".
        if verdict not in ("new", "removed"):
            covered.add(stem)
        print(f"  {stem}: {line}", flush=True)

    print(", ".join(f"{count} {name}" for name, count in tally.items()),
          flush=True)
    return diffs, refused, covered


def _one_part(shapediff, stem, old_step, new_step, old_dir, new_dir,
              keep_shapes=False):
    """One part's verdict, its sentence, and what the walk keeps about it.

    Returns `(tally key, text, found)`: the SLIVER-FILTERED measurement for
    `changed`, the gate's own reason for `not measured`, and None for the
    verdicts that leave nothing behind. The caller sorts the two apart by the
    verdict (`_compare`), which is why one slot carries both.

    THE REASON IS HANDED ON RATHER THAN DROPPED, and it is the difference
    between a document that says "not measured" where the log does and one that
    says "unchanged" about a part the kernel could not be trusted about.
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

    # ASKED FOR ONLY WHERE THEY ARE DRAWN. The solids are what a scene is made
    # of and they are not free -- the fuse has to keep every piece it found
    # instead of measuring it and dropping it -- so the log-only mode calls this
    # exactly as it always did, with two arguments and nothing else.
    measurement = (shapediff.measure(old_step, new_step, keep_shapes=True)
                   if keep_shapes else shapediff.measure(old_step, new_step))
    reason = shapediff.check(measurement)
    if reason is not None:
        return "not measured", f"not measured -- {reason}", reason

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
                             else "unchanged"), None
    return "changed", (f"+{measurement['added_mm3']:.3f} mm3 added, "
                       f"-{measurement['removed_mm3']:.3f} mm3 removed"), filtered


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
    # TOGETHER OR NEITHER, and refused here rather than defaulted. An output
    # directory with no view names no scene to build; a view with no output
    # directory names nowhere to put one. Either alone is the hub composing a
    # command line wrong, which is what this exit code says.
    if (opts["out_dir"] is None) != (opts["view"] is None):
        raise ValueError("--out-dir and --view go together or not at all")
    opts["occt_threads"] = int(opts["occt_threads"])
    if opts["occt_threads"] < 1:
        raise ValueError("--occt-threads must be at least 1")
    return opts


if __name__ == "__main__":
    sys.exit(main(sys.argv))
