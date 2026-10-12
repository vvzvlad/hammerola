"""The model.py printed in README.md, built the way a real push is built.

`parts()`, `views()`, `checks()` and `import checklib` are one agreement between a
model and the hub, written down in two places on purpose: `model_template/`, which
`hammerola create` unpacks, and the block in README.md, readable by someone
deciding whether to use the tool at all (the comment above the block says why both
are kept). Two copies are safe only because both are executed: this file builds
one and tests/test_template.py builds the other.

The block is lifted out of the file, written into a scratch project beside the
smallest legal project.json and handed to `src.buildproc.run_build`, the same call
`src/jobs.py` makes, in a process of its own, under ceilings. It catches what an
author would hit: the model does not import, a name or a label in a view changed
meaning, the gate refuses the layout, `checks()` cannot be called or counted,
`import checklib` no longer resolves from inside a model or stops being called, an
export stopped being produced.

The block going away is a REGRESSION, so it FAILS the run rather than skipping
(neither `-W error` nor `--strict` raises a skip). If the decision to keep the
example is ever reversed, change the comment in README.md and delete this file in
the same commit.

The CAD kernel is not assumed: on a checkout that installed requirements.txt
without the Dockerfile's system libraries, `import cadquery` dies on `libGL.so.1`,
so the guard is an import attempt naming ImportError, not `find_spec`. CI installs
those libraries, so the example is executed on every push. Same guard as
tests/test_view_fixture.py.
"""

import json
import re
import sys
import types
from collections import namedtuple
from pathlib import Path

import pytest

from src.buildproc import DEFAULT_LIMITS, STATUS_OK, run_build
from src.buildproc.limits import memory_limit_supported
# THE REAL MODULE, reached through the package rather than through
# `sys.modules["checklib"]` -- which one test below replaces with a stand-in.
# Both DECLARATIONS and that stand-in's fall-through read it.
from src.cadbuild import checklib as checklib_declarations
from src.cadbuild import provenance


README = Path(__file__).resolve().parent.parent / "README.md"

# The id the hub accepted for this push. `run_build` takes it as a parameter
# because it decides whose `latest` a build replaces; here it only has to be a
# legal one in shape (SPEC 3.1), since `load_project` refuses anything else and
# the refusal would then be what this test was measuring.
PID = "abc123def456"

# The production ceilings, minus the address-space one where the platform cannot
# carry it: RLIMIT_AS is unsettable on darwin and `apply_process_limits` refuses
# to start a build whose ceiling will not go on. `memory_limit_supported()`
# exists to answer exactly this, so on Linux (production) the example is held to
# every ceiling a real push gets.
LIMITS = (DEFAULT_LIMITS if memory_limit_supported()
          else DEFAULT_LIMITS.replace(memory_bytes=None))

# ```python ... ``` at the start of a line. The README's other fenced blocks are
# shell, and this is the one that claims to be a model.
PYTHON_BLOCK = re.compile(r"^```python\n(.*?)^```", re.DOTALL | re.MULTILINE)

GONE = ("README.md no longer carries a python block, so the model example is "
        "gone -- and the comment above it in README.md asks for it to STAY. "
        "It is one of the two copies of the contract that are kept precisely "
        "because both are executed, and this is the execution of that one, so "
        "its disappearance is a regression rather than a step in some plan: "
        "put the example back. If the decision really has changed, change that "
        "comment and delete tests/test_readme_example.py in the same commit -- "
        "but do not answer this with a skip, which is a green run.")

# Set on the stand-in module below, so the guard can tell THIS file's `checklib`
# from the real one without importing either.
RECORDER_MARK = "_readme_example_recorder"

# The half of `checklib` that is not a check and is therefore NOT stood in for:
# saying where a number came from. The example declares its constants with these
# at module level, so the stand-in has to hand back the real ones (see the
# Recorder below). Derived from `KINDS`, the property that tells a declaration
# from a check, so a rename in checklib is an ImportError here.
DECLARATIONS = ({"Number", "KINDS"} | set(checklib_declarations.KINDS)
                | {kind.upper() for kind in checklib_declarations.KINDS})


def _recorder_installed():
    """Is this file's stand-in sitting under the name `checklib` right now?"""
    return getattr(sys.modules.get("checklib"), RECORDER_MARK, False)


def _no_addresses(value):
    """`repr(value)` with every object address blanked out.

    The default repr of a Workplane carries its id, which is stable within one
    call to checks() and different on the next -- so a comparison built on it
    answers about identity when the question is about arguments.
    """
    return re.sub(r"0x[0-9a-fA-F]+", "0x...", repr(value))


@pytest.fixture(autouse=True)
def guard_the_checklib_stand_in():
    """Fail the test that leaves the stand-in in sys.modules, not the next one.

    `sys.modules` is process-wide, and one test below puts a recording stand-in
    under the name `checklib`; left behind, the next importer gets a `checklib`
    that agrees with everything. `monkeypatch` restores it today (including the
    delete when the name was absent); this guard is for a stand-in installed by
    hand. Before AND after, so the blame lands on the test that leaks rather than
    on whatever runs next.
    """
    assert not _recorder_installed(), (
        "a checklib stand-in was already in sys.modules when this test "
        "started, so an EARLIER test left it there; this test is where it "
        "surfaced, not where it was caused")
    yield
    assert not _recorder_installed(), (
        "this test left a checklib stand-in in sys.modules. Without this "
        "assertion the failure would have landed on some unrelated test later, "
        "under one collection order")


def readme_model_source():
    """The example. Exactly one block, or a failure that says why."""
    blocks = PYTHON_BLOCK.findall(README.read_text(encoding="utf-8"))
    if not blocks:
        pytest.fail(GONE)
    assert len(blocks) == 1, (
        f"README.md has {len(blocks)} python blocks and this file assumes the "
        "model example is the only one. Whichever of them is the model, say so "
        "here rather than letting this test build whichever came first")
    return blocks[0]


Built = namedtuple("Built", "source outcome out")


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    """The example, built once, for every assertion in this file to read.

    Module scope because the build is the expensive thing: a fresh interpreter
    importing the CAD kernel, meshing a part, exporting three formats,
    tessellating two views and rebuilding matplotlib's font cache, which every
    build pays for by design (`child_environment` points MPLCONFIGDIR into a
    per-build scratch home). On a workstation it takes about 5 s quiet and 13 s
    busy, against production's `wall_seconds`, which is taken rather than widened.

    Nothing here is shared state a test can dirty: `BuildOutcome` is a frozen
    dataclass and the output directory is only ever read.

    Both ways out are decided here: no python block in the README means the
    example is gone, a regression that FAILS every test (see GONE); no importable
    CAD kernel is a property of the interpreter and skips. `exc_type=ImportError`
    is explicit because the case it is for is an ImportError that is not a
    ModuleNotFoundError (the module is found and its extension refuses to load),
    and pytest narrows the default to ModuleNotFoundError.
    """
    source = readme_model_source()
    pytest.importorskip(
        "cadquery", exc_type=ImportError,
        reason="the CAD kernel does not import in this interpreter, so the "
               "README's example cannot be built -- see this module's "
               "docstring for what skipping it costs")

    tmp_path = tmp_path_factory.mktemp("readme-example")
    root = tmp_path / "project"
    root.mkdir()
    (root / "project.json").write_text(
        json.dumps({"id": PID, "title": "The README example"}),
        encoding="utf-8")
    (root / "model.py").write_text(source, encoding="utf-8")
    out = tmp_path / "staging"

    return Built(source, run_build(root, out, pid=PID, limits=LIMITS), out)


def test_the_readme_example_builds_and_passes_the_gate(built):
    """An author copying the block out of the README gets a published build.

    The whole path, on real geometry: the model imports, the print layout and
    the coverage gates accept the views, the printable is exported, the parts
    are tessellated. `outcome.files` is the PARENT's list -- every name in it
    was checked to exist under the output directory before it got there -- so
    asserting on it says the files were written and not merely claimed.
    """
    outcome = built.outcome

    assert outcome.status == STATUS_OK, outcome.log
    assert outcome.pid == PID
    # `plate` is the catalogue key and the export is named after it -- which is
    # the claim the block's own parts() docstring makes ("the stem it is
    # exported under"), measured here against what the build actually wrote.
    assert "plate.stl" in outcome.files, outcome.log
    assert "meta.json" in outcome.files, outcome.log
    for name in outcome.files:
        assert (built.out / name).is_file(), f"{name} was reported but not written"


def test_the_example_declares_checks_the_build_can_call_and_count(built):
    """The build calls the example's `checks()` and counts both checks in it.

    `checks_call_args` hands over the output directory positionally and accepts
    none, one, or a declared parameter (`src/cadbuild/modelchecks.py`), so this
    says nothing about the signature; the example takes no argument because a
    parameter it never reads would teach one that does nothing.

    It holds down the count, which nothing else sees. The number is read out of
    the source, so a body the counter cannot read prints "count unknown" and
    publishes anyway. Two here: the `assert`, and the `problems +=` that collects
    `checklib`'s verdict.
    """
    assert built.outcome.status == STATUS_OK, built.outcome.log
    assert "checks: 2 passed" in built.outcome.log, built.outcome.log


def test_the_example_exercises_checklib_and_the_name_resolves(built):
    """The fourth element of the contract, held down the same way as the three.

    Asserted on the source because the paragraph above the block calls `checklib`
    part of the contract, and no build failure would report the block ceasing to
    use it.

    The build half is the only place the lookup happens: the image's smoke gate
    proves the file arrived (check (g)) and nothing else imports it, so whether
    `import checklib` resolves from inside a model (past the project's own
    directory, first on sys.path, to the hub root behind it) is answered here. An
    unresolved name fails as `importing model.py failed`; a `checklib` returning
    something `problems +=` cannot take raises inside `checks()`. Moving the screws
    over the edge (`INSET` 3 mm rather than 8) turns this red with four verdicts
    from `material_under_head`, so the shared check is RUN, not merely counted.
    """
    assert "import checklib" in built.source, (
        "the README's example no longer imports checklib, but the paragraph "
        "above it still counts that import as part of the contract. Either put "
        "it back in the example or take it out of the sentence")
    assert "checklib." in built.source, (
        "the README's example imports checklib and never calls it, so the "
        "import is decoration rather than the demonstration the paragraph "
        "above the block promises")
    assert built.outcome.status == STATUS_OK, built.outcome.log


def test_the_example_calls_the_shared_check_once_per_hole(built, monkeypatch):
    """The call is WATCHED, because nothing else can see the call itself.

    The mutation this exists for is a loop that runs its full number of times and
    asks the same question every time: the geometry is untouched (green build),
    `count_checks` reads the count from the source, and the source still imports
    and calls `checklib`.

    Degenerate cases are the build's job: a `hole_centres()` that is empty or
    repeats a point also breaks the geometry, so the example's own
    `assert len(holes) == 4` fails. A loop that never iterates leaves the geometry
    alone and fails here. The expected number comes from the example's own
    `hole_centres()`, so an example redrawn with six holes stays green.

    This is not the hub running a model (`exec()` of a model in the hub's process
    is something this project never does, SPEC 8A.4): it is a test reading a code
    block out of a file in this repository. `cadquery` is NOT stood in for: the
    assert in `checks()` counts bores on the actual solid.
    """
    calls = []

    class Recorder(types.ModuleType):
        """Every attribute is a check that finds nothing, and records the ask.

        Generic rather than a stub of `material_under_head` by name: the
        example is free to reach for a different shared check, and this should
        then still be able to say it reached for one.

        EXCEPT THE NUMBER DECLARATIONS, which are handed through to the real
        module. They are not checks, they run at module level rather than
        inside `checks()`, and a stand-in returning `[]` for them would bind
        every constant in the block to a list -- the example then dies on
        `LENGTH - 2 * INSET` before `checks()` is ever reached, with a
        TypeError that says nothing about the calls this test is watching.
        """

        def __getattr__(self, attribute):
            if attribute in DECLARATIONS:
                return getattr(checklib_declarations, attribute)

            def check(*args, **kwargs):
                calls.append((attribute, _no_addresses(args), _no_addresses(kwargs)))
                return []
            return check

    stand_in = Recorder("checklib")
    setattr(stand_in, RECORDER_MARK, True)
    monkeypatch.setitem(sys.modules, "checklib", stand_in)

    namespace = {"__name__": "readme_example_under_test"}
    exec(compile(built.source, "README.md#model", "exec"), namespace)
    assert "hole_centres" in namespace, (
        "this test takes the expected number of calls from the example's own "
        "hole_centres(), and the block no longer has one. Point it at whatever "
        "the loop in checks() now iterates -- do not write the number here")
    holes = namespace["hole_centres"]()
    problems = namespace["checks"]()

    assert problems == [], problems
    assert len(calls) == len(holes), (
        f"the example's checks() called checklib {len(calls)} times for "
        f"{len(holes)} holes: {calls}")
    assert len({name for name, _args, _kwargs in calls}) == 1, (
        f"the calls did not all go to one shared check: {calls}")
    # Calls differ by a printable argument. Addresses are normalised out of the
    # repr, otherwise four identical probes on four freshly built copies of one
    # part would read as four asks. So after normalisation ANY TWO SHAPES LOOK
    # ALIKE: right for today's check, where the varying argument is a coordinate,
    # but a check whose varying argument is the SHAPE would fail this line.
    assert len(set(calls)) == len(calls), (
        f"the calls were not all different asks, so the loop is not visiting "
        f"a distinct hole each time: {calls}")


def test_the_views_the_example_declares_are_the_ones_it_publishes(built):
    """Both tabs reach meta.json, with the ids AND the labels the block gives.

    `meta.json` is what the viewer builds the tab strip from, so `as printed` is a
    string a reader can see in the README's screenshot; comparing ids alone would
    let the caption drift away from the block that produced it.
    """
    assert built.outcome.status == STATUS_OK, built.outcome.log
    meta = json.loads((built.out / "meta.json").read_text(encoding="utf-8"))
    assert [(view["id"], view["name"]) for view in meta["views"]] == [
        ("assembled", "assembled"), ("print", "as printed")]
    # And the catalogue reaches meta.json under the key the example gives it,
    # with the file it was exported to filed under the part it is of -- the
    # other half of the same claim the block's parts() docstring makes about
    # its key, checked against the document the viewer reads.
    assert meta["parts"]["plate"]["kind"] == "printable"
    assert meta["parts"]["plate"]["files"]["stl"] == "plate.stl"


# The prose sentence about what metrics.json carries, and the number in it.
NOTES_CEILING = re.compile(r"up to the first (\d+) of them")


def test_the_readme_gives_the_ceiling_metrics_json_really_holds(capsys):
    """The README's figure for the metrics.json list ceiling is the real one.

    `provenance.MAX_LISTED` cuts the two author-text lists, `notes` and
    `estimates`, while the counts stay exact and the file says how many it
    dropped; the README gives that ceiling and names both lists. A figure in a
    document fails on nothing unless something reads it. No kernel and no build:
    it runs even where the example itself cannot be built.
    """
    found = NOTES_CEILING.findall(README.read_text(encoding="utf-8"))
    assert len(found) == 1, (
        f"README.md states the metrics.json note ceiling {len(found)} times "
        f"and this expects exactly one. If the sentence was reworded, reword "
        f"NOTES_CEILING with it -- a pattern that stops matching is a claim "
        f"that stops being checked while the suite stays green")
    assert int(found[0]) == provenance.MAX_LISTED, (
        f"README.md promises the first {found[0]} notes and "
        f"provenance.MAX_LISTED is {provenance.MAX_LISTED}")

    # BOTH LISTS, because one number in the document stands for both cuts. A
    # ceiling that grew a second constant would leave the sentence true of one
    # list and false of the other, with nothing saying which.
    entries = [
        provenance.Entry(
            name=f"WALL_{index}",
            number=checklib_declarations.estimated(1.0, f"settle {index}"),
            line=index + 1)
        for index in range(provenance.MAX_LISTED + 3)]
    summary = provenance.report(entries)
    capsys.readouterr()  # report() prints a line per estimate; not the subject
    assert len(summary["notes"]) == provenance.MAX_LISTED
    assert len(summary["estimates"]) == provenance.MAX_LISTED
    assert summary["notes_omitted"] == summary["estimates_omitted"] == 3
