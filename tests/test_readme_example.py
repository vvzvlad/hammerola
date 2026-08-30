"""The model.py printed in README.md, built the way a real push is built.

THIS FILE EXISTS BECAUSE THE README CARRIES A SECOND COPY OF THE CONTRACT.
`printables()`, `views()`, `checks()` and `import checklib` are one agreement
between a model and the hub, and it is written down in two places on purpose:
`model_template/`, which issue #31 put on the hub and which
`hammerola create` unpacks, and the block in README.md, which is the one a
person deciding whether to use the tool at all can read without downloading
anything. The comment above that block says why both are kept. WHAT MAKES TWO
COPIES SAFE IS THAT BOTH ARE EXECUTED -- this file builds one and
tests/test_template.py builds the other -- because a code block nobody executes
is exactly the silent drift issue #46 warns about: the example goes on looking
correct for as long as nobody tries it, and the first person to try it is an
author copying it.

So the block is lifted out of the file and run: written into a scratch project
beside the smallest legal project.json and handed to `src.buildproc.run_build`
-- the same call `src/jobs.py` makes on the request path, in a process of its
own, under ceilings. Nothing here re-implements a build or asserts against a
transcript of one; what it can catch is what an author would hit -- the model
does not import, a name or a label in a view no longer means what it meant, the
gate refuses the layout, `checks()` is written so the build cannot call it or
cannot count it, `import checklib` no longer resolves from inside a model or
stops being called at all, an export stopped being produced.

IT IS TIED TO THE BLOCK BEING THERE, NOT TO WHAT IS IN IT -- and the block
going away is a REGRESSION, so it FAILS the run rather than skipping it. That
is the opposite of what this file used to do, and the reversal is a decision
rather than an oversight. While the plan was "the template lands, the example
becomes a pointer to it, this file is deleted in the same commit", a skip was
right: a check on a second copy has to die with the second copy and must not
make removing the copy look like a regression. The template landed and the plan
was cancelled -- the comment above the block asks for the example to STAY -- so
the disappearance of the block is now the failure this file is here to catch,
and answering it with a skip would answer it with a GREEN run. Neither
`-W error` nor `--strict` raises a skip, so the only thing holding the example
to the contract would go quiet without a red character anywhere. If the
decision is ever reversed again, change that comment in README.md and delete
this file in the same commit.

THE CAD KERNEL IS NOT ASSUMED. Both CI workflows run this suite in a bare
`python:3.11-slim` with requirements.txt installed and none of the system
libraries the Dockerfile adds, where the distribution is on disk and
`import cadquery` still dies on `libGL.so.1` -- so the guard is an import
attempt and not `find_spec`, and it names ImportError explicitly. Same guard,
same reasoning and the same cost as tests/test_view_fixture.py: on a run
without the kernel this example is unwatched, and the README can go stale
through a green CI.
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


README = Path(__file__).resolve().parent.parent / "README.md"

# The id the hub accepted for this push. `run_build` takes it as a parameter
# because it decides whose `latest` a build replaces; here it only has to be a
# legal one in shape (SPEC 3.1), since `load_project` refuses anything else and
# the refusal would then be what this test was measuring.
PID = "abc123def456"

# The production ceilings -- minus the address-space one, and only where the
# platform cannot carry it. RLIMIT_AS is unsettable on darwin and
# `apply_process_limits` refuses, deliberately and loudly, to start a build
# whose ceiling will not go on; a workstation would therefore report its own
# platform as a broken README. ASKING `memory_limit_supported()` RATHER THAN
# DROPPING IT OUTRIGHT is the difference between a platform allowance and a
# weaker test: production is Linux, the function is exported to answer exactly
# this, and on Linux the example is then held to every ceiling a real push
# gets.
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

    The project's rule about module-level mutable state, pointed at the only
    piece of it this file has: `sys.modules` is process-wide, and one test
    below puts a recording stand-in under the name `checklib` to watch the
    example call it. Left behind, the next test to import that name gets a
    module whose every attribute is a function returning an empty list -- which
    is to say a `checklib` that agrees with everything.

    `monkeypatch` is what actually restores it (including the case where the
    name was never in sys.modules at all, where the undo is a delete), so today
    nothing can leak. This guard is for the next stand-in, installed by hand.

    Before AND after, because before-only puts the blame in the wrong place: the
    test that leaks passes, and the failure lands on whatever ran next.
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

    MODULE SCOPE BECAUSE THE BUILD IS THE EXPENSIVE THING and there is only
    ever one of it to look at. This runs the real pipeline in a process of its
    own -- a fresh interpreter importing the CAD kernel, meshing a part,
    exporting three formats, tessellating two views and rebuilding
    matplotlib's font cache, which the build pays for EVERY time by design
    (`child_environment` points MPLCONFIGDIR into a scratch home made and
    removed per build, and says so). The argument for one build rather than
    four does not rest on a number: four tests asking four questions about one
    build would run that pipeline four times.

    The number is worth having anyway, for whoever wonders whether the ceiling
    is close. On this workstation, quiet: 5.1 and 5.3 s; the same run with the
    machine busy: 13.2 s. `wall_seconds` is production's 900 s, taken rather
    than widened, so the margin is about 23x on a quiet machine and about 9x on
    a busy one -- comfortable at both ends, but only the first is an order of
    magnitude, and a timeout here would mean something is actually wrong rather
    than merely slow.

    Nothing here is shared state a test can dirty: `BuildOutcome` is a frozen
    dataclass and the output directory is only ever read.

    Both ways out of this file are decided here rather than in each test, and
    they are deliberately not the same kind of exit: no python block in the
    README means the example is gone, which is a regression and FAILS every
    test here (see GONE), while no importable CAD kernel means it cannot be
    built at all, which is a property of the interpreter and skips.
    `exc_type=ImportError` on the second is explicit, because the failure it is
    FOR is an ImportError that is NOT a ModuleNotFoundError: the module is
    found and its extension refuses to load. pytest 9.1 narrows the default to
    ModuleNotFoundError, and without the argument this guard would stop
    skipping and the CI container would go red on a pytest bump.
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
    # The key of `printables()` is the filename stem, which is what the README
    # says about it two paragraphs down.
    assert "plate.stl" in outcome.files, outcome.log
    assert "meta.json" in outcome.files, outcome.log
    for name in outcome.files:
        assert (built.out / name).is_file(), f"{name} was reported but not written"


def test_the_example_declares_checks_the_build_can_call_and_count(built):
    """The build calls the example's `checks()` and counts both checks in it.

    WHAT THIS DOES AND DOES NOT SAY. It says the build could call the function
    the example declares and did not refuse the body: `checks_call_args` hands
    over the output directory positionally and accepts none, one, or a
    declared parameter (`src/cadbuild/modelchecks.py`), so `def checks()` and
    `def checks(out_dir)` are both callable and this test stays green across
    that edit. It is NOT a check on the signature -- the reason the example
    takes no argument is that a parameter it never reads teaches a parameter
    that does nothing, and no test can hold a README to that.

    What it does hold down is the count, which nothing else in the suite sees.
    Zero is refused outright, and the number is read out of the source, so a
    body the counter cannot read prints "count unknown" and publishes anyway --
    a `checks()` that quietly stopped being counted is a `checks()` the log
    stops speaking for. Two here: the `assert`, and the `problems +=` that
    collects `checklib`'s verdict.
    """
    assert built.outcome.status == STATUS_OK, built.outcome.log
    assert "checks: 2 passed" in built.outcome.log, built.outcome.log


def test_the_example_exercises_checklib_and_the_name_resolves(built):
    """The fourth element of the contract, held down the same way as the three.

    THE PROSE HALF IS THE POINT OF ASSERTING ON THE SOURCE. The paragraph above
    the block calls `checklib` part of the contract; if the block stops using
    it, that sentence goes back to being a claim about something the reader
    cannot see in the example under it -- which is the shape of the whole
    finding this file was written for, and no build failure would report it.

    The build half comes free from the fixture and is worth naming, because
    this is the only place the lookup happens at all: the image's smoke gate
    proves the file ARRIVED (check (g)), and nothing else on the request path
    imports it, so whether `import checklib` still resolves from inside a model
    -- past the project's own directory, which goes on sys.path FIRST, onto the
    hub root behind it -- is answered here or nowhere. An unresolved name fails
    the build as `importing model.py failed`; a `checklib` that resolved and
    then handed back something `problems +=` cannot take raises inside
    `checks()`, which is a failed build too. Both were provoked to check it,
    and so was the opposite -- moving the screws out over the edge (`INSET`
    3 mm rather than 8) turns this green run red with four real verdicts out of
    `material_under_head`, which is what says the shared check is being RUN and
    not merely counted.
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

    THE MUTATION THIS EXISTS FOR is a loop that runs its full number of times
    and asks the same question every time -- four calls, one argument. Nothing
    else here can see it: the geometry is untouched, so the build is green; the
    count in the log is read out of the source by `count_checks`, so it is two
    either way; and the source text still contains `import checklib` and a call
    to it. The example would go on publishing while demonstrating a check of one
    hole four times over.

    THE DEGENERATE CASES ARE THE BUILD'S JOB, not this test's, and saying so is
    the honest version of what this covers. A `hole_centres()` that came back
    empty, or with one point repeated, ALSO breaks the geometry -- the same
    helper places the holes -- so the example's own `assert len(holes) == 4`
    fails and the build goes red without any help from here. Measured: each of
    those turns five tests in this file red, not one. The loop that never
    iterates at all (`for x, y in []`) is the one that leaves the geometry
    alone, and that one does fail here and nowhere else.

    THE NUMBER COMES FROM THE EXAMPLE, not from this file. `hole_centres()` is
    what the block itself iterates, so an example redrawn with six holes and a
    matching assert stays green -- which it did not when this test had a 4 in
    it, failing with "not once per hole" about a call that was exactly once per
    hole.

    THIS IS NOT THE HUB RUNNING A MODEL, and the distinction is worth keeping
    straight: `exec()` of a model in the hub's own process is on the list of
    things this project never does (SPEC 8A.4). This is a test reading a code
    block out of a file in this repository, to watch which functions it calls.
    The hub's way is the other four tests, in a process of its own under
    ceilings.

    `cadquery` is NOT stood in for -- the geometry has to be real, since the
    assert in `checks()` counts bores on the actual solid.
    """
    calls = []

    class Recorder(types.ModuleType):
        """Every attribute is a check that finds nothing, and records the ask.

        Generic rather than a stub of `material_under_head` by name: the
        example is free to reach for a different shared check, and this should
        then still be able to say it reached for one.
        """

        def __getattr__(self, attribute):
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
    # WHAT MAKES TWO CALLS DIFFERENT HERE IS A PRINTABLE ARGUMENT. Addresses are
    # normalised out of the repr, otherwise four identical probes on four
    # freshly built copies of one part would read as four different asks. The
    # price is the boundary: a geometry object's default repr is its class and
    # its address, so after normalisation ANY TWO SHAPES LOOK ALIKE. That is
    # right for today's check, where the varying argument is a coordinate --
    # but a shared check whose varying argument is the SHAPE would collapse to
    # one ask here and fail this line while doing nothing wrong.
    assert len(set(calls)) == len(calls), (
        f"the calls were not all different asks, so the loop is not visiting "
        f"a distinct hole each time: {calls}")


def test_the_views_the_example_declares_are_the_ones_it_publishes(built):
    """Both tabs reach meta.json, with the ids AND the labels the block gives.

    The labels are half the point: `meta.json` is what the viewer reads to
    build the tab strip, so `as printed` is a string a reader of this README
    can see in the screenshot above the example. Comparing ids alone let a
    renamed label through -- the caption in the picture drifting away from the
    block that produced it, in one document.
    """
    assert built.outcome.status == STATUS_OK, built.outcome.log
    meta = json.loads((built.out / "meta.json").read_text(encoding="utf-8"))
    assert [(view["id"], view["name"]) for view in meta["views"]] == [
        ("assembled", "assembled"), ("print", "as printed")]
    # A project with ONE printable labels its buttons by extension alone, so
    # the stem shows up in the filename rather than in the key
    # (src/cadbuild/printables.py::download_labels).
    assert meta["downloads"]["stl"] == "plate.stl"
