"""The starter template, held to the contract by BUILDING it.

THIS IS WHY THE TEMPLATE IS FILES AND NOT A PARAGRAPH OF DOCUMENTATION. What
`hammerola create` unpacks is the first model anybody here writes, and it is
copied rather than read — so a template that stopped satisfying the gate would
be a project that cannot publish, handed to somebody who has no way of telling
whether the fault is theirs. Written as prose in a README it would rot in
silence. As a directory the suite pushes through the real build, it cannot.

TWO TESTS HERE NEED THE CAD KERNEL, AND THEY ARE THE ONES CI CANNOT RUN. The
kernel is not importable in the test container (both workflows run the suite in
a bare `python:3.11-slim`, where `import cadquery` dies on `libGL.so.1`), so
both skip there exactly as `tests/test_view_fixture.py` does — its docstring
carries the full accounting of what that costs. They are the BUILD test at the
foot of this file, which computes the geometry, and the one that holds the
stubbed kernel against the real one; what each of them costs when it skips is
written where it stands.

EVERYTHING ELSE RUNS ON EVERY PUSH, THE PROVENANCE GUARD INCLUDED — it imports
the template with the kernel STUBBED and then asks the hub's own rule about the
module that comes out. That guard used to be a second implementation of the
rule, written here on the belief that a template cannot be imported without a
kernel; it can, and the copy is gone. The rest is not all one thing: most of it
asks whether the template is a tree the hub would ACCEPT, which is what breaks
from an ordinary edit — a file added under a name the path alphabet refuses
takes the whole push down, and takes it down for every project created from the
template afterwards — while the pins described next ask about a document
instead. Stated by which group a test is in rather than by counting them,
because the count is what went stale here before.

AND THE GROUP THAT IS ABOUT A DOCUMENT RATHER THAN THE HUB. `skill/SKILL.md`
QUOTES this template — the number of checks a run of it reports, and the
wording of an assertion its `checks()` emits — to teach an agent that a green
count can be about parts the build no longer holds, and what a failing check
says when it lands on a catalogue of one's own. Both sentences are
claims about THIS directory, which is why they are pinned here rather than beside
the skill: the edit that falsifies them is an edit to model.py, and the failure
has to land on whoever makes it. Until then they were held to nothing, and the
document is not a comment — it is served to every agent that installs the skill,
and it is followed. Neither pin needs the CAD kernel (one measures the source of
`checks()`, the other reads an f-string out of it), so both keep running on every
push in the same containers the build test skips in.
"""

import ast
import collections
import importlib.util
import json
import re
import shutil
import sys
import tarfile
import types
import io
from pathlib import Path

import pytest

import modulesource
from src import onboarding
from src.buildproc import run_build
from src.cadbuild import checklib, paths, provenance
from src.cadbuild.errors import BuildError
from src.cadbuild.artifacts import PREVIEW_SUFFIX
from src.cadbuild.modelchecks import count_checks
from src.cadbuild.parts import KIND_PRINTABLE, KINDS, RESERVED_STEMS
from src.buildproc.limits import DEFAULT_LIMITS, memory_limit_supported
from src.buildproc.runner import STATUS_OK
from hammerola import pack
from hammerola.limits import MAX_BUILD_BYTES, MAX_MEMBERS, SAFE_COMPONENT
from hammerola.errors import ClientError
from hammerola.project import PROJECT_FILE
from hammerola.unpack import TEMPLATE_RULES, check_name

TEMPLATE_DIR = onboarding.TEMPLATE_DIR

# The production ceilings, less the one macOS cannot apply. `memory_bytes` is
# RLIMIT_AS, and Darwin refuses it at every value (see
# `limits.memory_limit_supported`), so a workstation would report
# `limits_error` before the build started — the failure would be about the
# platform and would say nothing about the template.
BUILD_LIMITS = (DEFAULT_LIMITS if memory_limit_supported()
                else DEFAULT_LIMITS.replace(memory_bytes=None))

# What the model in the template is expected to produce. Named here rather than
# derived from the build, so a template that quietly stopped exporting a part
# fails instead of agreeing with itself.
EXPECTED_ARTEFACTS = (
    "meta.json", "metrics.json", "assembled.json", "print.json",
    "base.stl", "base.step", "base.3mf", "lid.stl", "lid.step", "lid.3mf",
    # The whole-build artefacts and the pictures (issue #53). They used to reach
    # the site as stowaways — written into the output directory, declared by
    # nothing, and carried along only because publication happens to be a
    # directory rename. Named here for the reason everything above is: the day
    # one of them stops being written, or stops being DECLARED, this is what
    # says so instead of the build agreeing with itself.
    "assembled.stl", "print.stl",
    "assembled_preview.png", "print_preview.png",
    "base_preview.png", "lid_preview.png",
)
# THIS LIST DID NOT MOVE WHEN THE ONE MAP BECAME THREE, and that is a fact about
# `files` rather than an omission. `outcome.files` is the VERIFICATION list — the
# names the parent checks and the hub hashes — and `build` assembles it from the
# same evidence the maps are assembled from (`plate`, `written`) rather than from
# the maps themselves. So which of `downloads`, `overview` and `previews` a name
# is offered through is invisible here, by design: a narrowing of what is offered
# must not be able to stop a file that is on disk from being verified.


@pytest.fixture(autouse=True)
def no_model_left_in_the_interpreter(tmp_path_factory):
    """Nothing a judged project supplied may outlive the test that judged it.

    `hub_verdict` below IMPORTS a model into this interpreter, which is module
    state in the sense AGENTS.md means: a name the project put in `sys.modules`
    is answered to every later import in the session, and the test that then
    fails is not the one that planted it. Checked BOTH BEFORE AND AFTER for that
    exact reason -- an after-only check reports the leak against whichever test
    ran next.

    WHAT COUNTS AS A STRAY IS "IT CAME OUT OF A TMP DIRECTORY", not "it was not
    there before". A model is entitled to add modules that are nobody's project
    -- `pytest.importorskip("cadquery")` alone adds hundreds, permanently and
    correctly -- so the predicate is where a module's CODE lives, and every
    project this file judges is a copy under pytest's own base temp directory.
    That is also what makes the check safe to run before a test: it is a property
    of the interpreter rather than a diff against a snapshot.

    WHERE THE CODE LIVES IS `modulesource`, and it is a module rather than the
    one-liner that used to stand here because that one-liner read `__file__` and
    nothing else -- which a namespace package has not got, so a `mocks/`
    directory in a judged project walked through this fixture and through
    `hub_verdict`'s sweep below. Its docstring has the whole of it.

    The stubbed kernel is checked by the same clock: `_StubbedKernel` answers
    every attribute with `_Opaque`, so one left behind in `sys.modules` would let
    a later test "import cadquery" and compute geometry out of stand-ins.
    """
    base = str(tmp_path_factory.getbasetemp())

    def strays():
        return modulesource.modules_from(base)

    def stray_paths():
        return [entry for entry in sys.path if entry.startswith(base)]

    def check(when):
        assert not strays(), (
            f"{when} this test, sys.modules answers for a module out of a "
            f"scratch project: {strays()}. Every later import of that name in "
            f"this session gets the copy a judged project supplied")
        assert not stray_paths(), (
            f"{when} this test, sys.path still holds a scratch project: "
            f"{stray_paths()}")
        assert not isinstance(sys.modules.get("cadquery"), _StubbedKernel), (
            f"{when} this test, `import cadquery` answers with the stub, so "
            f"anything that computes geometry afterwards computes it out of "
            f"_Opaque stand-ins")

    check("before")
    yield
    check("after")


def template_files() -> list:
    return [path for path in sorted(TEMPLATE_DIR.rglob("*")) if path.is_file()]


# -- what the hub would accept ----------------------------------------------
def test_every_path_in_the_template_is_one_the_client_will_unpack():
    """The rules the template archive is read with, applied to the source.

    The hub tars whatever is in this directory, so a file added here that
    `unpack.TEMPLATE_RULES` refuses would produce an archive that every
    `hammerola create` downloads and then refuses to write — a failure on
    somebody else's machine, in the first command they ever run.

    THE HIDDEN NAME IS CHECKED AS A LEAF, exactly as the rules check it. A
    hidden DIRECTORY here would be the RCE that shaped those rules: `.git/config`
    holds shell commands and the next `git status` runs them.
    """
    offenders = []
    for path in template_files():
        relative = path.relative_to(TEMPLATE_DIR).as_posix()
        try:
            # The client's own check, called rather than reimplemented: a third
            # hand-written copy of this loop is how the hub came to serve a tree
            # the client refused (see `onboarding._refuse_unservable`).
            check_name(relative, "the template", TEMPLATE_RULES)
        except ClientError as error:
            offenders.append(str(error))
    assert offenders == [], (
        f"the template holds paths the client would refuse to unpack: "
        f"{offenders}")
    assert len(template_files()) <= MAX_MEMBERS
    assert sum(p.stat().st_size for p in template_files()) < MAX_BUILD_BYTES


def test_the_visible_half_of_the_template_is_one_the_hub_would_accept():
    """Everything not hidden has to satisfy the PUSH's alphabet as well.

    The two rules differ by one character — a leading dot — and only for the
    trip DOWN. `.gitignore` is dropped by `pack.py` on the way back up, but
    anything else in here is packed, and a name the hub refuses fails the whole
    push of every project made from this template.
    """
    offenders = [str(path.relative_to(TEMPLATE_DIR))
                 for path in template_files()
                 for part in path.relative_to(TEMPLATE_DIR).parts
                 if not part.startswith(".") and not SAFE_COMPONENT.match(part)]
    assert offenders == []


def test_the_template_packs_into_a_push_carrying_the_model():
    """`pack` is what a `hammerola build` in a fresh project would send."""
    packed = pack.pack(TEMPLATE_DIR)
    assert "model.py" in packed.names
    # Hidden entries never travel: the hub's path alphabet cannot carry them.
    assert ".gitignore" not in packed.names


def test_the_template_carries_no_project_json():
    """`hammerola create` mints the id, and it refuses to write over one.

    A project.json in here would be either overwritten by the file `create`
    writes or the collision that stops the command — and the id in it would be
    shared by every project ever created from the template, which is the one
    thing an id may never be.
    """
    assert not (TEMPLATE_DIR / PROJECT_FILE).exists()


def test_the_model_defines_the_contract_it_is_the_example_of():
    """parts(), views(), checks() and `import checklib`, read out of the
    source rather than by importing it — this test runs where there is no CAD
    kernel to import it with."""
    tree = ast.parse((TEMPLATE_DIR / "model.py").read_text(encoding="utf-8"))
    defined = {node.name for node in tree.body
               if isinstance(node, ast.FunctionDef)}
    assert {"parts", "views", "checks"} <= defined
    # AND printables() IS GONE. Presence is all the line above can see, and a
    # leftover printables() would sail through it: the build ignores the
    # function entirely, so the template would go on publishing while teaching
    # a half of the contract that no longer exists to everybody who copies it.
    assert "printables" not in defined, (
        "the template still defines printables(), which parts() replaced. The "
        "build ignores it, so nothing else in this suite would notice")
    imported = {alias.name for node in ast.walk(tree)
                if isinstance(node, ast.Import) for alias in node.names}
    assert "checklib" in imported, (
        "the template is the only worked example of `import checklib`, which is "
        "the fourth part of the contract and the one nothing else demonstrates")
    assert "cadquery" in imported


# -- the provenance rule, asked of the hub rather than imitated --------------
# WHAT STOOD HERE WAS A SECOND IMPLEMENTATION OF THE RULE, written over a syntax
# tree because importing the template was believed to need the CAD kernel that
# neither CI container has. It does not. The kernel is the one import a model
# makes that CI cannot satisfy, and a stub is enough to let the module EXECUTE --
# after which `provenance` answers with the hub's own verdict, which is what the
# copy was approximating.
#
# THE COPY IS GONE WITH EVERYTHING THAT EXISTED TO VALIDATE IT: three corpora of
# hand-written sources, the parity tests over them, and the paragraph naming the
# gap it could not close. That paragraph had been rewritten three times and was
# wrong in BOTH directions when it was finally measured against the real rule. It
# flagged lines the hub publishes -- `SEATED = cq.Location((0, 0, 1.5))`,
# `OFFSET = cq.Vector(0, 0, 1) * HEIGHT`, `LABEL = '%.1f mm' % SCREW_DIA`, and
# the template's own `LID_SEATED` line one edit away, with its 180 written 180.0
# -- and it was silent about lines the hub refuses: `LID_GAP = GAPS['lid'] * 2`
# above all, which is the next line an author writes after the dict of estimates
# the deleted corpus itself taught. The enforcement was circular besides: the
# list of "gaps" was derived FROM the paragraph, so a family the paragraph forgot
# could not be caught by the test written to catch a wrong paragraph.
#
# There is no approximation here now, so there is nothing left to diverge and no
# paragraph left to be wrong a fourth time. What is written down instead is a
# corpus of EDITS to the real template, each carrying the verdict the real rule
# gives it -- see EDITS below.


class _Opaque:
    """Whatever a kernel call hands back, for a python with no kernel.

    ITS ONE JOB IS TO LET THE MODULE EXECUTE, and the one thing it must never be
    is a number: the rule asks `isinstance(value, float)` of every module global,
    so a stub that answered with a float would invent bare numbers no real build
    ever sees, and the guard would refuse a template that publishes.

    `__mul__`/`__rmul__` are here because scaling a kernel object by a dimension
    is ordinary model code (`cq.Vector(0, 0, 1) * HEIGHT`). An operation this
    does not support fails the IMPORT, loudly, in whichever test asked for it --
    which is the right failure: a stub that quietly returned something plausible
    for an operation the kernel does differently would change a verdict without
    saying so.

    BY A SCALAR ONLY, and that is that same rule applied to multiplication
    itself. It took anything, while `cq.Vector.__mul__` takes a number and
    nothing else -- so `cq.Vector(0, 0, 1) * cq.Vector(1, 0, 0)` was published
    here and raises TypeError against the real kernel, which is exactly the
    "quietly plausible" answer the paragraph above forbids. `NotImplemented`
    rather than a raise, so python builds the TypeError the kernel builds.
    """

    def __init__(self, *args, **kwargs):
        pass

    def __mul__(self, other):
        # bool is an int and would pass; nothing here multiplies by one, and the
        # kernel accepts it too, so it is not worth a second branch.
        if isinstance(other, (int, float)):
            return _Opaque()
        return NotImplemented

    __rmul__ = __mul__


class _StubbedKernel(types.ModuleType):
    """`import cadquery` for an interpreter that has none: every name is _Opaque."""

    def __getattr__(self, name):
        return _Opaque


# The hub's answer about one model: why it refused (or None), what it counted as
# declared, and what it found bare. The last two are summarised down to plain
# tuples of plain values so that two runs can be COMPARED -- which is what
# `test_the_stub_answers_what_the_real_kernel_answers` does with them.
Verdict = collections.namedtuple("Verdict", "refusal declared bare")


def hub_verdict(project, stub=True):
    """Import the model in `project` and run the rule the build runs on it.

    `provenance.collect`, `provenance.unwrapped` and `provenance.check` are the
    three calls `cadbuild.build` makes before any geometry, called here rather
    than imitated. That is the whole of this change: what a second
    implementation of them cannot do is stay equal to them.

    SYS.MODULES IS SWEPT BY WHERE A MODULE CAME FROM, never blanket-purged, and
    the distinction is load-bearing rather than tidiness. The root `checklib.py`
    shim loads `src/cadbuild/checklib.py` BY PATH, so a re-import mints a SECOND
    `Number` class -- and both halves of the rule recognise a declared number by
    `isinstance`, so every declared number in the model would come back as a bare
    float and the template would "fail" its own guard. A sweep that took every
    name the import added would do exactly that, the first time a model's
    `import checklib` happened to be the first one in the process.

    SO WHAT IS REMOVED IS WHAT THE PROJECT SUPPLIED, by where its code lives
    (`modulesource.came_from`), which is the same rule
    `tests/cadbuild/test_provenance.py::_importable` sweeps by and for the same
    reason. It asks `__path__` as well as `__file__`, because a namespace package
    -- a `mocks/` directory with no `__init__.py`, which is an ordinary thing for
    a model project to have -- has only the second and slipped through both
    sweeps while they read only the first. Leaving them was a real leak with a
    measured victim: judge a
    project carrying a `checklib.py` of its own and `sys.modules['checklib']`
    stays pointed at THAT copy for the rest of the session, so the pristine
    template judged afterwards is refused by its own guard with every one of its
    28 declarations reported bare. Nothing in `EDITS` adds a file today, which is
    the only reason the suite is green -- and a leak that is invisible until
    somebody adds an ordinary case, and then lands in a different test, is the
    shape this repository has an autouse fixture rule for. There is one below.

    Exactly one name is swapped, `cadquery`, and it is put back the way it was
    found: replaced if something was there, removed if nothing was.

    THE PROJECT ROOT IS PINNED HERE and put back the same way, because the rule
    resolves the file it parses against it (`provenance._model_source`) rather
    than off the module's `__file__` -- which is the whole reason a model cannot
    aim it. `project` is what `check` is handed below in any case, so this
    pins one answer rather than introducing a second.
    """
    from src.cadbuild import provenance

    displaced = sys.modules.get("cadquery")
    present = "cadquery" in sys.modules
    displaced_root = paths._root
    paths.set_project_root(project)
    if stub:
        sys.modules["cadquery"] = _StubbedKernel("cadquery")
    # After the stub is in place, so that putting `cadquery` back is the business
    # of the branch below and of nothing else.
    before = set(sys.modules)
    # The model's own directory goes first on sys.path, the way
    # `geometry.load_model` puts it there, so a project that imports a module of
    # its own is imported here the way the hub imports it.
    sys.path.insert(0, str(project))
    spec = importlib.util.spec_from_file_location("model_under_test",
                                                  project / "model.py")
    module = importlib.util.module_from_spec(spec)
    try:
        try:
            spec.loader.exec_module(module)
        except Exception as error:
            # A model that will not execute under the stub says nothing about
            # the rule, and the bare traceback says nothing about the stub: an
            # `AttributeError: 'X' object has no attribute 'Length'` from
            # `DIAG = cq.Vector(1, 2, 3).Length` reads as a broken model, and
            # every parametrised case here fails with it at once.
            if not stub:
                raise
            raise AssertionError(
                f"the model did not execute against the STUBBED kernel: "
                f"{type(error).__name__}: {error}\n"
                f"_Opaque stands in for every kernel object here and supports "
                f"only what the models in this file have needed so far -- "
                f"construction, and multiplication by a scalar. Two ways out, "
                f"and they are not interchangeable: teach _Opaque the "
                f"operation, but ONLY once the real kernel is known to answer "
                f"the same way, or the stub starts deciding verdicts; or leave "
                f"it alone and keep the case out of the stubbed corpus, which "
                f"is the right answer when the kernel really does something "
                f"this cannot imitate") from error
        declared = provenance.collect(module)
        bare = provenance.unwrapped(module)
        try:
            provenance.check(declared, bare, project)
            refusal = None
        except BuildError as error:
            refusal = str(error)
    finally:
        paths.set_project_root(displaced_root)
        sys.path.remove(str(project))
        sys.modules.pop("model_under_test", None)
        for name in set(sys.modules) - before:
            if modulesource.came_from(sys.modules[name], str(project)):
                del sys.modules[name]
        if stub:
            if present:
                sys.modules["cadquery"] = displaced
            else:
                sys.modules.pop("cadquery", None)

    return Verdict(
        refusal,
        tuple(sorted((entry.name, entry.number.kind, float(entry.number))
                     for entry in declared)),
        tuple(sorted((item.name, item.value) for item in bare)))


# One edit to the template, and the verdict the rule gives what it produces.
# `find` is None for a line APPENDED to the file (module level, after
# everything, which is where a constant added by hand ends up); otherwise it is
# a stretch of the template that has to appear exactly once and is replaced.
Edit = collections.namedtuple("Edit", "label find replace refused")

UNCHANGED = Edit("nothing changed", None, "", refused=False)

# THE PIN ON THE GUARD ITSELF. A guard whose only subject is a file that passes
# it says nothing about what it would catch -- and the guard this replaces was
# rewritten three times, every time because it caught something other than what
# it claimed. Every entry below was run through the real rule AND through the
# real CAD kernel; the first three refused ones are the shapes an author
# actually writes, and the accepted ones are all lines the deleted guard flagged
# while the hub published them without a word.
EDITS = (
    UNCHANGED,
    # -- refused: provenance does not survive arithmetic -------------------
    # The likeliest mistake there is, and the reason a guard has to exist at
    # all: a derived constant written as arithmetic over other constants is the
    # ordinary way a CAD model is written, and the result is a plain float.
    Edit("a constant derived by arithmetic", None,
         "\nRIM = WALL * 2\n", refused=True),
    # The same thing with nothing to derive from: the shape the rule is named
    # for.
    Edit("a bare float", None, "\nRIM = 4.8\n", refused=True),
    # A NUMBER TAKEN BACK OUT OF A CONTAINER. The deleted guard was silent about
    # this one while its own corpus taught the line above it -- a dict of
    # estimates is walked one level and accepted, and the next line an author
    # writes takes a value out of it.
    Edit("arithmetic over a number out of a dict", None,
         "\nGAPS = {'lid': checklib.estimated(0.25, 'print it')}\n"
         "LID_GAP = GAPS['lid'] * 2\n", refused=True),
    Edit("arithmetic over numbers out of a list", None,
         "\nSIZES = [SCREW_DIA, WIDTH]\nX = SIZES[0] + SIZES[1]\n",
         refused=True),
    Edit("arithmetic over a conditional", None,
         "\nX = (SCREW_DIA if WIDTH else WIDTH) * 2\n", refused=True),
    Edit("arithmetic over a walrus", None,
         "\nX = (Y := SCREW_DIA) * 2\n", refused=True),
    # -- accepted: a float written in a line that is not a number ----------
    # THE TEMPLATE'S OWN LINE, one character from what it already says. It is
    # geometry, the hub publishes it, and a guard that flagged it would be red
    # on an edit that was fine -- which is the failure that gets a guard deleted
    # rather than fixed.
    Edit("a float literal inside a kernel call",
         "cq.Vector(1, 0, 0), 180)", "cq.Vector(1, 0, 0), 180.0)",
         refused=False),
    Edit("a location built from literals", None,
         "\nSEATED = cq.Location((0, 0, 1.5))\n", refused=False),
    Edit("a vector scaled by a dimension", None,
         "\nOFFSET = cq.Vector(0, 0, 1) * HEIGHT\n", refused=False),
    Edit("a string formatted from a number", None,
         "\nLABEL = '%.1f mm' % SCREW_DIA\n", refused=False),
    # A bool is not a float subclass, so this is outside the rule -- a fact
    # about python that `tests/cadbuild/test_provenance.py` states, since
    # nothing in the source can.
    Edit("a comparison against a number", None,
         "\nTIGHT = SCREW_DIA < 2.5\n", refused=False),
    Edit("a callable over a number", None,
         "\nSCALE = lambda x: x * 0.5\n", refused=False),
)


def template_under(tmp_path, edit):
    """A copy of the template with one edit applied, as a project to judge.

    A copy rather than the directory itself: the rule reads model.py off disk to
    find the lines it names, so an edited template has to BE an edited template.
    """
    project = tmp_path / "project"
    shutil.copytree(TEMPLATE_DIR, project)
    source = (TEMPLATE_DIR / "model.py").read_text(encoding="utf-8")
    if edit.find is None:
        source += edit.replace
    else:
        assert source.count(edit.find) == 1, (
            f"the edit {edit.label!r} replaces {edit.find!r}, which the "
            f"template holds {source.count(edit.find)} times. An anchor that "
            f"no longer matches would leave this case editing NOTHING and "
            f"passing as the unchanged template")
        source = source.replace(edit.find, edit.replace)
    (project / "model.py").write_text(source, encoding="utf-8")
    return project


def test_the_hub_would_publish_the_template_as_it_stands(tmp_path):
    """The rule the hub refuses a push with, run on the model everybody copies.

    Every project created from this template inherits whatever is here, and its
    author has no way of telling whose fault a refusal is -- so this must fail on
    a workstation AND in both CI containers, where there is no CAD kernel. It
    does, because the kernel is stubbed and the RULE is the real one.
    """
    verdict = hub_verdict(template_under(tmp_path, UNCHANGED))
    assert verdict.bare == (), (
        f"the template binds an UPPER_SNAKE name to a float that does not say "
        f"where it came from, which is what the hub refuses the push of: "
        f"{list(verdict.bare)}")
    assert verdict.refusal is None, (
        f"the hub would refuse the starter template:\n{verdict.refusal}")
    assert verdict.declared, (
        "the template declares no numbers at all, so the assertions above pass "
        "by having nothing to be about. It is the worked example of all three "
        "kinds -- either put the parameter block back or delete this test")


def test_a_project_that_keeps_its_mocks_in_a_directory_leaves_nothing_behind(
        tmp_path):
    """A namespace package walked through the sweep, and through the fixture too.

    `hub_verdict` puts the project FIRST on sys.path, exactly as
    `geometry.load_model` does and for the reason that function gives: `import
    mocks` in a model.py has to find the project's own. A project whose mocks are
    a DIRECTORY rather than a file gives a namespace package -- `__file__` is
    None, the location is in `__path__` alone -- so the sweep, which read
    `__file__` and nothing else, walked past it and left it in `sys.modules`
    answering every later `import mocks` in the session from a directory that had
    since been deleted.

    NOTHING IN `EDITS` ADDS A FILE, which is the only reason the suite was green,
    and a leak invisible until somebody adds an ordinary case is the shape this
    repository has an autouse-fixture rule for. This test is the ordinary case,
    and the autouse fixture above -- which had the identical hole and now shares
    the identical answer -- is the second assertion here even though it is not
    written out: it re-checks `sys.modules` after every test in this file.
    """
    project = template_under(tmp_path, UNCHANGED)
    (project / "mocks").mkdir()
    (project / "mocks" / "sizes.py").write_text("WIDTH = 4.0\n",
                                                encoding="utf-8")
    assert not (project / "mocks" / "__init__.py").exists(), (
        "the point of the case is the package with no __init__.py")
    source = (project / "model.py").read_text(encoding="utf-8")
    (project / "model.py").write_text(
        "import mocks.sizes\n" + source, encoding="utf-8")

    assert hub_verdict(project).refusal is None

    assert "mocks" not in sys.modules, (
        "the namespace package the model imported outlived the project it came "
        "from, so every later `import mocks` in this session answers from a "
        "directory pytest is about to delete")
    assert "mocks.sizes" not in sys.modules


@pytest.mark.parametrize("edit", EDITS, ids=[edit.label for edit in EDITS])
def test_the_rule_answers_every_edit_the_way_this_list_says(edit, tmp_path):
    """Each shape in EDITS, put through the real rule.

    This is what says the guard above GUARDS. It costs nothing to keep now that
    there is no second implementation to maintain: the sources are edits to the
    real template and the verdict is the hub's own.
    """
    verdict = hub_verdict(template_under(tmp_path, edit))
    refused = verdict.refusal is not None
    assert refused == edit.refused, (
        f"EDITS says the hub would "
        f"{'refuse' if edit.refused else 'publish'} the template with "
        f"{edit.label}, and it {'refused' if refused else 'published'} it"
        + (f":\n{verdict.refusal}" if refused else ""))


@pytest.mark.parametrize("edit", EDITS, ids=[edit.label for edit in EDITS])
def test_the_stub_answers_what_the_real_kernel_answers(edit, tmp_path):
    """WHAT KEEPS THE STUB HONEST: the second of the two tests here needing a kernel.

    Everything above runs against `_StubbedKernel`, which is a claim: that
    swapping the kernel out changes no verdict. Where the kernel really is
    importable -- a workstation -- the claim is checked rather than trusted, on
    the same corpus, comparing the whole verdict and not just its sign: the
    refusal text, every declared number with its kind and value, and every bare
    one.

    It SKIPS in both CI containers, and what that costs is worth being exact
    about: the guard itself does not skip there, because the rule it runs is the
    hub's either way -- what goes unchecked in CI is only whether the stub still
    stands in for the kernel faithfully. The kernel moves on its pins in
    `requirements.txt`, and this is what a workstation says about that move.
    """
    pytest.importorskip(
        "cadquery", exc_type=ImportError,
        reason="the CAD kernel does not import in this interpreter, so there "
               "is no real verdict to compare the stubbed one against — see "
               "this test's docstring for what that costs")
    stubbed = hub_verdict(template_under(tmp_path / "stubbed", edit), stub=True)
    real = hub_verdict(template_under(tmp_path / "real", edit), stub=False)
    assert stubbed == real, (
        f"the stubbed kernel and the real one disagree about the template with "
        f"{edit.label}, so every verdict in this file rests on a stand-in that "
        f"no longer stands in:\nstubbed: {stubbed}\nreal:    {real}")


def test_the_stub_refuses_the_multiplication_the_kernel_refuses():
    """`_Opaque` took any right-hand side; `cq.Vector` takes a number.

    So `cq.Vector(0, 0, 1) * cq.Vector(1, 0, 0)` was PUBLISHED by every verdict
    in this file and raises TypeError against the real kernel -- a stub quietly
    answering something plausible for an operation the kernel does differently,
    which is the one thing `_Opaque`'s docstring says it must never do. The
    corpus above cannot hold this case: an EDIT has to IMPORT under both kernels
    to be compared at all, and this one imports under neither.

    The second half needs the kernel and skips in the CI containers, exactly as
    the corpus comparison above does. What it costs is the same: the claim that
    the kernel really refuses this is checked on a workstation and trusted in CI.
    """
    with pytest.raises(TypeError):
        _Opaque() * _Opaque()

    cq = pytest.importorskip(
        "cadquery", exc_type=ImportError,
        reason="the CAD kernel does not import in this interpreter, so there "
               "is nothing to check the stub's refusal against")
    with pytest.raises(TypeError):
        cq.Vector(0, 0, 1) * cq.Vector(1, 0, 0)


def test_a_model_the_stub_cannot_execute_says_which_kernel_it_was(tmp_path):
    """The import failure has to name the stub, because it is usually the cause.

    `_Opaque` supports what the models here have needed and nothing else, so an
    ordinary kernel expression can fail the import -- and the bare traceback,
    `AttributeError: '_Opaque' object has no attribute 'Length'`, reads as a
    broken model. It arrives on every parametrised case at once, which is the
    least helpful moment to be guessing whose fault it is.
    """
    project = template_under(tmp_path, Edit(
        "an attribute _Opaque does not have", None,
        "\nDIAG = cq.Vector(1, 2, 3).Length\n", refused=False))
    with pytest.raises(AssertionError, match="STUBBED kernel"):
        hub_verdict(project)


def test_every_measurement_in_the_template_points_at_a_real_line_of_the_journal():
    """`ref/measurements.md#screw` has to name a file and a heading that exist.

    Checked by the build's own resolver against this directory, so a heading
    renamed in the journal — or the journal moved — fails here rather than in
    the first `hammerola build` somebody runs.

    THE GUARD ABOVE REACHES THIS TOO, now that it runs the real
    `provenance.check` rather than a copy of the rule over a syntax tree — a
    source that stopped resolving reddens in both places. This one stays for
    what that check cannot state: that the template MEASURES something at all.
    A model whose every number had become an estimate would satisfy the guard
    perfectly and would have stopped being the worked example of `measured()`,
    which is the one kind of number with a document behind it.
    """
    from src.cadbuild import checklib, provenance

    tree = ast.parse((TEMPLATE_DIR / "model.py").read_text(encoding="utf-8"))
    entries = []
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "measured" and node.args):
            source = node.args[1] if len(node.args) > 1 else None
            assert isinstance(source, ast.Constant) and isinstance(source.value, str), (
                f"line {node.lineno}: the template's measured() names its source "
                f"with something other than a literal, and this test can only "
                f"resolve a literal")
            entries.append(provenance.Entry(f"line {node.lineno}",
                                            checklib.measured(1.0, source.value)))
    assert entries, (
        "the template no longer measures anything. It is the worked example of "
        "all three kinds of number, so either put a measurement back or delete "
        "this test")
    # Raises BuildError naming every source that does not resolve.
    provenance.check(entries, [], TEMPLATE_DIR)


def test_every_section_of_the_template_journal_carries_a_date():
    """`skill/SKILL.md` describes this file as "date, what was measured, with
    what, the number", and the template is the worked example that sentence
    sends its reader to. It carried no date at all, so the one document an agent
    copies the FORM from was demonstrating a form the instructions do not
    describe. The date is what says whether a figure predates the change that
    should have moved it, which is exactly the failure the journal exists to
    catch.

    THE HEADINGS ARE READ WITH THE RESOLVER'S OWN REGEX, not with a `^## ` of
    this test's own. That split saw one heading level out of six, so a journal
    section written `#measurements` -- or `### Screw`, or with the closing
    hashes some editors add -- was silently not a section here while
    `provenance._source_problem` resolved a `measured()` straight at it. It is
    the failure a hand-written second reading of a rule always has, in a smaller
    place — and the reason the provenance guard above stopped being one.

    A DATE IS REQUIRED OF THE SECTIONS THE MODEL ACTUALLY CITES, which is the
    other half of reading all six levels: `# Measurements` is the file's own
    title, and it has no measurement under it to date. Asking the question of
    what is cited rather than of what is merely a heading is both narrower and
    exactly the subject the docstring above describes.
    """
    from src.cadbuild.provenance import _HEADING, heading_slug

    text = (TEMPLATE_DIR / "ref" / "measurements.md").read_text(encoding="utf-8")
    # Off the syntax tree, not off a regex over the file: the template's own
    # comments spell `checklib.measured(v, "ref/measurements.md#heading")` as
    # the worked example of the form, and a text search reads that as a citation
    # of a heading called `heading`.
    tree = ast.parse((TEMPLATE_DIR / "model.py").read_text(encoding="utf-8"))
    cited = {node.args[1].value.split("#", 1)[1]
             for node in ast.walk(tree)
             if isinstance(node, ast.Call)
             and isinstance(node.func, ast.Attribute)
             and node.func.attr == "measured" and len(node.args) > 1
             and isinstance(node.args[1], ast.Constant)
             and isinstance(node.args[1].value, str)
             and "#" in node.args[1].value}
    assert cited, (
        "the template cites no heading of its journal, so this test has nothing "
        "to be about -- either put a measured() back or delete it with the rest")

    sections, current = {}, None
    for line in text.splitlines():
        heading = _HEADING.match(line)
        if heading:
            current = heading_slug(heading.group(1))
            sections[current] = []
        elif current is not None:
            sections[current].append(line)
    missing = sorted(cited - set(sections))
    assert missing == [], (
        f"the template's model.py points at headings its journal does not "
        f"have: {missing}")
    undated = sorted(
        slug for slug in cited
        if not re.search(r"\b\d{4}-\d{2}-\d{2}\b", "\n".join(sections[slug])))
    assert undated == [], (
        f"these sections of the template journal record no date: {undated}")


# One backticked constant, and a RUN of them. The names SKILL.md lists as this
# template's estimated clearances are found by the SUBSTITUTED VALUES rather than
# by the prose around them -- the same argument the two patterns further down are
# built on, and for the same reason: a pattern spelling out "the starter
# template's ... all are" would locate the quotation by the very wording it then
# checks, so a reword would stop the match and the pin would quietly stop
# pinning.
#
# TWO OR MORE NAMES, and that is the pattern's whole discrimination: SKILL.md
# also backticks `GRIP_DROP` on its own, in a paragraph about somebody else's
# model, and a single-name pattern would hold this template to a constant it has
# no reason to define.
QUOTED_NAME = re.compile(r"`([A-Z][A-Z0-9_]{2,})`")
QUOTED_NAME_RUN = re.compile(
    QUOTED_NAME.pattern + r"(?:(?:,| and)\s+" + QUOTED_NAME.pattern + r")+")

# The three constructors, as `checklib.<attr>` is written in a model.
DECLARING_CALLS = ("measured", "derived", "estimated")


def _one_level(name, node):
    """`(name, node)` for a value and, ONE level in, for what a literal holds.

    The same one level `provenance._one_level` walks, and named after it: a dict
    or a list of constants is an ordinary way to hold them, the hub counts and
    refuses what is inside one, and a selector that stopped at the assignment
    could not see the very idiom EDITS teaches four lines apart from it
    (`GAPS = {'lid': checklib.estimated(0.25, ...)}`).

    Named `GAPS['lid']` and `SIZES[0]`, the way `provenance` names them, so a
    message here points at what the build's own message would point at.
    """
    yield name, node
    if isinstance(node, (ast.List, ast.Tuple)):
        for index, item in enumerate(node.elts):
            yield f"{name}[{index}]", item
    elif isinstance(node, ast.Dict):
        for key, item in zip(node.keys, node.values):
            label = repr(key.value) if isinstance(key, ast.Constant) else "?"
            yield f"{name}[{label}]", item


def estimate_note(call):
    """The note of a `checklib.estimated(...)` call, as an AST node, or None.

    POSITIONAL OR KEYWORD, because both are legal python and the constructor
    takes it either way. Reading `args[1]` alone reported `note=` as an estimate
    written "without a literal note" -- a diagnosis pointing at the wrong thing
    entirely, on a line that is correct.
    """
    if len(call.args) > 1:
        return call.args[1]
    return next((word.value for word in call.keywords if word.arg == "note"),
                None)


def checklib_names(tree):
    """`(modules, constructors)` -- which names in this module mean checklib.

    TWO SHAPES, and only one of them used to be read. `import checklib` binds a
    module, and `checklib.estimated(...)` is an attribute call on it; `from
    checklib import estimated` binds the constructor itself, and `estimated(...)`
    is a plain call. The second is legal python, the hub's rule counts it (it
    reads the imported module and never the spelling), and this walk reported
    nothing at all for it.

    `ast.walk` rather than the module body, because an import is not always
    written at the top level:

        try:
            import checklib
        except ImportError:
            checklib = _stub

    -- and the names an import binds are module globals wherever it is written.

    ALIASES ARE FOLLOWED (`import checklib as cl`) for the same reason the
    module is matched by name at all: what this returns is compared against the
    hub's answer, and the hub sees the object rather than the word.
    """
    modules = set()
    constructors = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "checklib":
                    modules.add(alias.asname or alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.module == "checklib" and not node.level:
                for alias in node.names:
                    if alias.name in DECLARING_CALLS:
                        constructors[alias.asname or alias.name] = alias.name
    return modules, constructors


def declaring_kind(node, modules, constructors):
    """`"estimated"` if this expression is a checklib constructor call, else None.

    IT ASKS WHICH MODULE, which the attribute test alone did not: `.estimated`
    on anything at all counted, so a model's own `self.estimated(...)` or a
    `numpy.derived(...)` was read as a declaration the hub would count. The hub
    holds the imported OBJECT and so cannot make that mistake; this holds the
    text and has to ask the imports.
    """
    if not isinstance(node, ast.Call):
        return None
    if (isinstance(node.func, ast.Attribute)
            and node.func.attr in DECLARING_CALLS
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id in modules):
        return node.func.attr
    if isinstance(node.func, ast.Name):
        return constructors.get(node.func.id)
    return None


def declared_in(source):
    """Every `checklib.measured/derived/estimated(...)` a module binds a name to.

    -> `{name: (kind, ast.Call, line)}`, over the module's own globals, which is
    the set the hub's rule is about.

    WHICH NAMES A MODULE BINDS IS `provenance.module_bindings`, THE HUB'S OWN
    WALK, and that is the whole of the change this function last needed. It used
    to answer the question itself -- `ast.Assign` and `ast.AnnAssign` over
    `tree.body`, plain-`Name` targets only -- and the docstring named the misses
    it knew about while four more went unnamed, because a hand-written walk
    cannot know what it does not look at: a TUPLE target
    (`WALL, LID = checklib.estimated(...), checklib.estimated(...)`), a STARRED
    one, a declaration inside a module-level `if` or `try`, and a walrus. Every
    one of those is a module global, every one is counted and refused by the
    hub, and every one was invisible here. Reusing the hub's walk closes all
    four at once and cannot drift from it afterwards -- which is the exact
    argument `module_bindings` makes for being public.

    WHAT IS STILL OUTSIDE IT, and stays outside, is now one thing rather than a
    list: a call this cannot SEE, because it is not written where the name is
    bound -- `WALL = _pick()` with the constructor inside the helper, or a
    number arriving from another module. `provenance` reaches those because it
    has the imported module and this has only the text, so the hub's rule stays
    the wider of the two by design. What this must never be is NARROWER than the
    shapes the template itself teaches, which is what it had become.

    ONE LEVEL INTO A LITERAL is this file's own addition on top of the walk
    (see `_one_level`), because `module_bindings` answers about NAMES and the
    idiom EDITS teaches four lines apart is a dict of declarations.

    WHAT REUSING THE WALK GAVE UP, said plainly because it is not free: this
    file can no longer catch a bug IN the walk. A second implementation
    disagreeing with the first is a signal, and there is now one implementation
    with two callers -- so an error in `module_bindings` makes the hub and this
    wrong together and silently. `tests/cadbuild/test_provenance.py` is what
    holds that end: mutating `provenance._DESCENDED_INTO` to `()` reddens eight
    tests there plus the selector's own. The trade was made deliberately -- a
    hand-written second walk had four holes the hub did not, which is a worse
    kind of silence -- but it is a trade, and the file that now carries the
    weight is named here so it is not thinned out later by somebody reading it
    as redundant.
    """
    tree = ast.parse(source)
    modules, constructors = checklib_names(tree)
    found = {}
    for bound, bindings in provenance.module_bindings(tree).items():
        for binding in bindings:
            for name, value in _one_level(bound, binding.value):
                kind = declaring_kind(value, modules, constructors)
                if kind is not None:
                    found[name] = (kind, value, binding.line)
    return found


def declared_in_template():
    """`declared_in`, over the model everybody copies."""
    return declared_in((TEMPLATE_DIR / "model.py").read_text(encoding="utf-8"))


def test_the_selector_sees_the_shapes_a_model_is_written_in():
    """What `declared_in` reads, over a source written to hold every shape.

    The two tests below rest on this walk, and it had gone narrower than the
    template's own teaching without either of them noticing -- a green pin over a
    set of constants it was no longer looking at. Each line here was a silent
    miss: a declaration inside a dict (the idiom EDITS teaches), one inside a
    list, a note given as `note=`, one assignment binding two names, and an
    annotated assignment.

    THE SECOND HALF OF THE LIST ARRIVED WITH THE HUB'S OWN WALK, and every one
    of them was a shape the hub counts and this reported nothing for: a tuple
    target, a starred one, a declaration inside a module-level `if` or `try`, a
    walrus, and the bare-name call `from checklib import estimated` leaves
    behind. They are here rather than in the docstring because a named blind
    spot and a closed one look identical from the outside.

    THE LAST FOUR LINES ARE THE BOUNDARY, and they matter as much as the rest: a
    walk that took local names would hold `checks()` and every helper to a rule
    the hub applies to module level alone, and one that took any `.estimated`
    at all would count a call on an object that is not checklib.
    """
    found = declared_in(
        "import checklib\n"
        "from checklib import estimated\n"
        "WALL = checklib.estimated(2.4, 'settled by printing one')\n"
        "GAPS = {'lid': checklib.estimated(0.25, note='settled by the pair')}\n"
        "SIZES = [checklib.derived(1.0, 'half of WALL')]\n"
        "A = B = checklib.measured(3.0, 'ref/m.md#screw')\n"
        "TALL: float = checklib.estimated(20.0, 'settled by the contents')\n"
        "LIP, SLOT = checklib.derived(1.2, 'half of WALL'), estimated(0.3, 'eye')\n"
        "HEAD, *REST = [checklib.estimated(5.0, 'settled by the screw')]\n"
        "if True:\n"
        "    BOSS = checklib.estimated(3.0, 'settled by the insert')\n"
        "try:\n"
        "    import calibration\n"
        "    GAP = calibration.GAP\n"
        "except ImportError:\n"
        "    GAP = checklib.estimated(0.2, 'settled by the first print')\n"
        "if (SLOP := checklib.estimated(0.35, 'settled by the fit')) > 0:\n"
        "    pass\n"
        "def helper():\n"
        "    LOCAL = checklib.estimated(1.0, 'not a module-level name')\n"
        "class Holder:\n"
        "    ATTR = checklib.estimated(1.0, 'a class attribute, not a global')\n"
        "PICK = lambda: (INNER := checklib.estimated(1.0, 'inside a lambda'))\n"
        "OTHER = numpy.estimated(1.0, 'not checklib at all')\n")

    assert {name: kind for name, (kind, _, _) in found.items()} == {
        "WALL": "estimated",
        "GAPS['lid']": "estimated",
        "SIZES[0]": "derived",
        "A": "measured",
        "B": "measured",
        "TALL": "estimated",
        "LIP": "derived",
        "SLOT": "estimated",
        # A STARRED TARGET CONSUMES AN UNKNOWN NUMBER OF ELEMENTS, so the hub's
        # walk hands the whole list to both names rather than guessing which
        # element each gets (`provenance._paired` says so). Both therefore
        # arrive named after the list they were cut out of, and this pins the
        # answer the hub actually gives rather than the tidier one.
        "HEAD[0]": "estimated",
        "REST[0]": "estimated",
        "BOSS": "estimated",
        "GAP": "estimated",
        "SLOP": "estimated",
    }
    assert estimate_note(found["GAPS['lid']"][1]).value == "settled by the pair"


def test_the_skill_is_right_about_what_an_estimate_does_in_this_template():
    """Two sentences of `skill/SKILL.md`, pinned to the file they describe.

    THEY WERE BOTH FALSE, and neither had anything to fail on. The document said
    "an estimate never drives geometry" while every estimate in this template
    drives geometry, and "every constant of a fit, a clearance or an
    interference cites a line in [the journal]" while the template's clearances
    are estimates -- a document served to every agent that installs the skill,
    teaching a rule the worked example it points at breaks. Pinned here, beside
    the other two SKILL.md quotes, because the edit that falsifies them is an
    edit to model.py and the failure has to land on whoever makes it.

    THE NAMES ARE READ OUT OF THE DOCUMENT, not written down here. They were
    transcribed by hand, which made this a pin on the template alone: deleting
    both sentences from SKILL.md left the file green, so the half of the claim
    that is about the DOCUMENT -- that it still says this at all -- was held to
    nothing. That is the same failure the two quotation pins below already avoid,
    and it is fixed the same way.
    """
    skill = onboarding.SKILL_FILE.read_text(encoding="utf-8")
    tree = ast.parse((TEMPLATE_DIR / "model.py").read_text(encoding="utf-8"))
    kinds = {name: kind for name, (kind, _, _) in declared_in_template().items()}

    # The constants the document names. It says they ARE estimates, which is the
    # correction: the sentence before claimed they cite the journal.
    named = sorted({name for run in QUOTED_NAME_RUN.finditer(skill)
                    for name in QUOTED_NAME.findall(run.group(0))})
    assert named, (
        "SKILL.md no longer lists any of this template's constants as its "
        "estimated clearances, and the two ways that happens want opposite "
        "fixes. If the passage went away, delete this half of the test with it "
        "-- leaving it green would be a pin that stopped pinning. If the "
        "passage is still there, QUOTED_NAME_RUN is what stopped matching it "
        "and the PATTERN is what to fix: it wants two or more UPPER_SNAKE names "
        "in backticks, joined by a comma or the word `and`, so a reflow that "
        "breaks the run across a line boundary hides a claim that is still "
        "being read by every agent")
    for name in named:
        assert kinds.get(name) == "estimated", (
            f"skill/SKILL.md names {name} as one of this template's estimated "
            f"clearances, and it is {kinds.get(name)!r} here")

    # ...and that estimates really do drive geometry, which is the other
    # sentence. Read off the functions rather than the constants: a name used
    # only in another constant's arithmetic would not settle it.
    geometry = [node for node in tree.body
                if isinstance(node, ast.FunctionDef) and node.name != "checks"]
    used = {inner.id for node in geometry for inner in ast.walk(node)
            if isinstance(inner, ast.Name)}
    driving = sorted(name for name, kind in kinds.items()
                     if kind == "estimated" and name in used)
    assert driving, (
        "skill/SKILL.md says an estimate drives geometry like any other number "
        "and points at this template; not one of its estimates is named by the "
        "geometry any more")


# The one estimate whose note answers BY NEGATION, named here rather than
# reworded: PRINTER_TOL is a rounding allowance and not a dimension, so "nothing
# measures it" IS the answer to what would settle it -- there is no measurement
# that would.
SETTLED_BY_NEGATION = {"PRINTER_TOL"}


def test_every_estimate_in_the_template_says_what_would_settle_it():
    """`checklib.estimated(value, note)` documents `note` as "what would settle
    it", and this template is the worked example every author copies.

    IT WAS NOT TRUE ONCE, and what went wrong is what this pins rather than any
    wording: BOSS_WALL's note reported an experiment -- "this held a thread on
    the first pair printed" -- on a number nobody had printed anything with, and
    which had in fact been back-computed from the post diameter. A note that
    reports a result is answering a different question from the one the
    constructor asks, and nothing here could tell.

    WHAT IT SEES IS THE SHAPE AND NOT THE TRUTH. No test can check that a
    settling clause is honest; this catches the note that does not carry one at
    all, which is the failure that actually happened, and it catches it in both
    CI containers because it needs no kernel.

    WHICH ESTIMATES IT SEES is `declared_in_template()`, and that is where the
    other half of this pin lives: the selector it replaces required the
    assignment to be one `Name` at module level with the note as the second
    POSITIONAL argument, so an estimate inside a dict -- the idiom EDITS itself
    teaches -- was never examined, `note=` written as a keyword was reported as
    "estimated without a literal note", and `A = B = ...` was skipped in silence.
    """
    notes = {}
    for name, (kind, call, line) in declared_in_template().items():
        # The KIND the selector worked out, not `call.func.attr`: a constructor
        # imported by name (`from checklib import estimated`) is a call on an
        # `ast.Name`, which has no `.attr` at all.
        if kind != "estimated":
            continue
        given = estimate_note(call)
        assert given is not None, (
            f"line {line}: {name} is estimated with no note at all, and the "
            f"note is where an estimate says what would settle it")
        assert isinstance(given, ast.Constant) and isinstance(given.value, str), (
            f"line {line}: {name}'s note is computed rather than written out, "
            f"and this test can only read a literal one -- so an estimate in "
            f"that shape is one nothing can hold to saying what would settle it")
        notes[name] = given.value
    assert notes, (
        "the template estimates nothing any more. It is the worked example of "
        "all three kinds of number, so either put an estimate back or delete "
        "this test")
    silent = {name for name, note in notes.items() if "ettle" not in note}
    assert silent == SETTLED_BY_NEGATION, (
        f"these estimates in the template do not say what would settle them: "
        f"{sorted(silent - SETTLED_BY_NEGATION)}, while "
        f"{sorted(SETTLED_BY_NEGATION - silent)} is named above as answering by "
        f"negation and now says 'settle' like the rest. `estimated()` documents "
        f"its second argument as \"what would settle it\", and this file is the "
        f"example every author copies")


# The author-text arguments of each constructor, in the order they are written
# after `value`. BOTH of `measured()`'s are here: `checklib._text_problem` holds
# a source to the same ceiling as a note, and the ceiling is what this is for.
AUTHOR_TEXT = {"measured": ("source", "note"),
               "derived": ("note",),
               "estimated": ("note",)}


def author_text_in(source):
    """Every string this module hands a checklib constructor.

    -> `[(chars, line, field, text)]`, and a second list of the arguments that
    are NOT literals -- which the caller asserts is empty rather than ignoring,
    because an f-string note would otherwise leave this walk measuring less than
    the file contains while staying green.
    """
    tree = ast.parse(source)
    modules, constructors = checklib_names(tree)
    literal, computed = [], []
    for node in ast.walk(tree):
        kind = declaring_kind(node, modules, constructors)
        if kind is None:
            continue
        fields = AUTHOR_TEXT[kind]
        given = list(zip(fields, node.args[1:]))
        given += [(word.arg, word.value) for word in node.keywords
                  if word.arg in fields]
        for field, value in given:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                literal.append((len(value.value), value.lineno, field,
                                value.value))
            else:
                computed.append((value.lineno, field))
    return literal, computed


def test_every_note_in_the_template_fits_under_the_ceiling():
    """`MAX_NOTE_CHARS` has room over this directory, and this is what says so.

    THE CLAIM USED TO BE A COMMENT AND THE COMMENT WAS WRONG. `checklib` said
    "the longest note in `model_template/` is 130 characters of the 200", and
    the round that wrote the sentence added a 182-character note in the same
    breath: 130 was the FOURTH longest, and the room was 18 characters rather
    than 70. A figure about ANOTHER FILE has nothing to fail on, which is why it
    is measured here instead -- the next note that outgrows the ceiling reddens
    on this line rather than rotting in a comment.

    IT ASSERTS THE LONGEST rather than each in turn, because the message is the
    output: what an author wants to be told is which note is over and by how
    much, not that some note somewhere is.

    EVERY `.py` IN THE DIRECTORY and both of `measured()`'s text fields, since
    the ceiling is a property of the CONSTRUCTOR and not of model.py -- a
    template that grows a second module has its notes measured the day it
    appears.
    """
    texts, computed = [], []
    for path in sorted(TEMPLATE_DIR.rglob("*.py")):
        found, skipped = author_text_in(path.read_text(encoding="utf-8"))
        texts += [(chars, path.name, line, field, text)
                  for chars, line, field, text in found]
        computed += [(path.name, line, field) for line, field in skipped]

    assert not computed, (
        f"these arguments are computed rather than written out: {computed}. "
        f"This test can only measure a literal, so one that is not would be "
        f"silently unmeasured -- write it out, or teach this walk to evaluate "
        f"it")
    assert texts, (
        "the template declares no number with a note any more. It is the worked "
        "example of all three kinds, so either put one back or delete this test")

    chars, name, line, field, text = max(texts)
    assert chars <= checklib.MAX_NOTE_CHARS, (
        f"{name} line {line}: the {field} is {chars} characters and the ceiling "
        f"is {checklib.MAX_NOTE_CHARS}. Every project made from this template "
        f"copies it, so the push that copies this one is refused -- shorten it "
        f"to what settles the number and put the working in the journal: "
        f"{text!r}")


def test_the_template_declares_fewer_numbers_than_metrics_json_lists():
    """`MAX_LISTED` has room over this directory, and this is what says so.

    THE SAME SHAPE AS THE NOTE CEILING ABOVE, and for the same reason.
    `provenance` carried the sentence "the starter template declares 28" in the
    paragraph justifying `MAX_LISTED` -- a live number about ANOTHER FILE, kept
    in a comment, with nothing to fail on. It was true the day it was written,
    exactly as `checklib`'s "the longest note is 130 characters" was true the
    day IT was written and false by the end of the same round.

    WHAT IT PINS IS THE CLAIM AND NOT THE NUMBER: that a real model sits under
    the ceiling, so the truncation `notes_omitted` and `estimates_omitted`
    report is a thing that happens to a pathological push and not to the worked
    example every author copies. It writes no count down -- the message prints
    both sides, and neither is asserted to be any particular value.

    IT NEEDS NO CAD KERNEL: the count comes off the syntax tree through
    `declared_in`, the selector `test_the_selector_sees_the_shapes_a_model_is_
    written_in` holds to the shapes the hub's own walk reads.
    """
    declared = declared_in_template()
    assert declared, (
        "the template declares no number at all any more, so there is nothing "
        "here to measure against the ceiling")
    assert len(declared) < provenance.MAX_LISTED, (
        f"the template declares {len(declared)} numbers and metrics.json lists "
        f"{provenance.MAX_LISTED} of them, so the worked example every author "
        f"copies is now one whose own provenance block comes out truncated. "
        f"Either the template has grown past what a starter model should be, or "
        f"the ceiling is too low for a real one -- decide which, rather than "
        f"raising the number to fit")


def test_the_template_warns_about_every_stem_the_build_takes_for_itself():
    """`parts()` must name all of RESERVED_STEMS, not just `assembled`.

    The template is the one worked example every author copies, and a stem it
    fails to mention is a `BuildError` on somebody else's first build with no
    warning anywhere ahead of it — `print` above all, which is a completely
    ordinary name for a single printed part. The names cannot be derived there:
    model.py is a MODEL, it may import nothing from `src`, and a docstring is a
    literal besides. So the copy is checked instead of avoided.
    """
    tree = ast.parse((TEMPLATE_DIR / "model.py").read_text(encoding="utf-8"))
    doc = next(ast.get_docstring(node) for node in tree.body
               if isinstance(node, ast.FunctionDef) and node.name == "parts")
    for stem in RESERVED_STEMS:
        # The FILE, not the bare stem: `print` on its own also appears in this
        # docstring as the name of a view, so a docstring that had dropped the
        # warning would still contain the word.
        assert f"{stem}.stl" in doc, (
            f"the build refuses a catalogue key {stem!r} (RESERVED_STEMS in "
            "cadbuild.parts) and the template never says so")


def test_the_archive_the_hub_serves_is_this_directory():
    """The bytes a `create` receives, compared against the files on disk.

    Cheap, and it is what makes every assertion above an assertion about the
    thing that is actually shipped rather than about a directory that happens to
    sit beside it.
    """
    with tarfile.open(fileobj=io.BytesIO(onboarding.template_bytes()),
                      mode="r:gz") as tar:
        served = {info.name: tar.extractfile(info).read()
                  for info in tar.getmembers()}
    on_disk = {str(path.relative_to(TEMPLATE_DIR)): path.read_bytes()
               for path in template_files()}
    assert served == on_disk


# -- what the skill quotes out of this directory -----------------------------
# The two sentences below are found in SKILL.md BY THE SUBSTITUTED VALUES, never
# by the fixed words around them. The fixed words are what is being pinned, so a
# pattern spelling them out would locate the quotation by the very wording it
# then checks: reword the document and the pattern simply stops matching, which
# is a pin that quietly stops pinning. Both patterns therefore key on what the
# template PUTS INTO the sentence -- a count, and a `.stl` name with a byte
# count -- and every match either finds is then held to the template.
# THAT ARGUMENT IS ABOUT QUOTED_STL_MESSAGE. The fixed words the other pattern
# spells out are printed by `run_checks`, not written by the skill's prose, so
# naming them cannot make the pin circular: they are pinned elsewhere or not at
# all, and never by this.

# `checks: N passed` is `modelchecks.run_checks`'s own print. Only a literal
# count matches: the skill also writes `checks: N passed` a few lines above, as
# the shape rather than as a measured run, and that one is not a claim about the
# template.
QUOTED_CHECK_COUNT = re.compile(r"`checks: (\d+) passed`")

# A backticked sentence beginning with a `.stl` file name and holding a number:
# `stl.name` and `size`, the two values the template substitutes in.
QUOTED_STL_MESSAGE = re.compile(r"`([A-Za-z0-9_.-]+\.stl\b[^`\n]*?\d[^`\n]*)`")

# The stretch of that message the template is searched by. Small on purpose: it
# is enough to tell this f-string from the other messages in checks(), and the
# less of the sentence it holds the more of it is left for the comparison to
# actually check.
STL_MESSAGE_NEEDLE = "printable mesh"


def test_the_skill_quotes_the_number_of_checks_this_template_reports():
    """`checks: 10 passed` in SKILL.md, against what the counter says.

    That sentence is the skill's worked example of a build whose checks ran to
    the end about parts the catalogue no longer held, and the NUMBER is the whole
    of the evidence: ten checks went green, and every section of that run but the
    LAST measured a box and a lid that were not being built any more -- the last
    one walks `parts()`, so it is the only one that landed on the catalogue that
    was really there. Nothing went red, which is the whole of the lesson: the log
    reports a count for a model none of the checks behind it were written about.
    A check added to `checks()` here, or taken out of it, moves that number --
    and the document is what the hub serves to every agent that installs the
    skill, so a stale one teaches a run that never happens.

    Counted with `modelchecks.count_checks`, applied to the template's real
    `checks`. That is the counter the build STARTS from and no longer the whole
    of what it prints: the build reports `count_checks(...) -
    len(static_asserts(...))`, taking off every assert the module's own
    constants settle on their own. The two numbers agree here because the
    template carries no such assert, and what holds THAT is
    `test_the_template_builds_the_way_the_hub_builds_it` below -- it fails the
    template's build on any `warning:` line, and each static assert prints one.
    `static_asserts` cannot be called from this test at all: it needs the
    imported module's `vars()`, and model.py is never IMPORTED because importing
    it needs the CAD kernel, which the test container has not got -- the pin
    would then carry an `importorskip` and skip in exactly the place it has to
    run, every push, in the containers the build test below already skips in.
    """
    source = (TEMPLATE_DIR / "model.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    # EVERY match is collected rather than the first one taken: `next` would
    # measure the first `def checks`, and python binds the name to the LAST.
    functions = [node for node in tree.body
                 if isinstance(node, ast.FunctionDef)
                 and node.name == "checks"]
    assert functions, (
        "the template no longer defines `checks` as a plain function at module "
        "level -- an `async def` is an ast.AsyncFunctionDef, and one moved "
        "inside another block is not in `tree.body` at all. Either is a change "
        "to the shape SKILL.md quotes a run of, so say which it is here rather "
        "than leaving the next reader a wordless IndexError")
    assert len(functions) == 1, (
        f"the template defines checks() {len(functions)} times at module "
        f"level. Python binds the name to the LAST of them, so that is the one "
        f"the build runs, while this test would go on measuring the FIRST -- "
        f"and hold SKILL.md to a count of a function nothing ever executes. "
        f"Define checks() once rather than leaving this test to choose")
    function = functions[0]

    # EXECUTING THE `def` ALONE IS SAFE ONLY WHILE IT STAYS A BARE ONE, so that
    # is asserted rather than assumed. THREE kinds of expression are evaluated
    # at definition time -- a decorator, a default argument, and an annotation
    # on a parameter or on the return -- and every one of them is template code
    # running inside this suite, whose first reach would be for the kernel that
    # is not here.
    assert function.decorator_list == [], (
        "the template's checks() has grown a decorator, which this test would "
        "evaluate: it executes the `def` to hand the real function to "
        "count_checks. Count it another way rather than running template code "
        "here")
    assert not function.args.defaults and not any(function.args.kw_defaults), (
        "the template's checks() has grown a default argument, which is an "
        "expression this test would evaluate when it executes the `def`")
    # THE ANNOTATION IS THE ONE THAT SPLITS BY PYTHON VERSION, which is what
    # makes it the dangerous one to leave unchecked. Under PEP 649 (3.14, this
    # workstation) annotations are lazy, so an annotated checks() passes here;
    # under 3.11 -- what BOTH workflows run this suite in, see the module
    # docstring -- the annotation is evaluated at `def` time and the test dies
    # with a bare NameError that says nothing about any of this. Every geometry
    # builder in the template is annotated `-> cq.Workplane`, so making checks()
    # match them is an ordinary edit rather than a far-fetched one.
    arguments = function.args
    annotated = [argument.arg
                 for argument in (*arguments.posonlyargs, *arguments.args,
                                  *arguments.kwonlyargs,
                                  arguments.vararg, arguments.kwarg)
                 if argument is not None and argument.annotation is not None]
    annotated += ["the return"] if function.returns is not None else []
    assert annotated == [], (
        f"the template's checks() now annotates {annotated}, and an annotation "
        f"is an expression evaluated when this test executes the `def` -- on "
        f"python 3.11, which is where this suite actually runs on every push. "
        f"Leave checks() unannotated, or count it another way rather than "
        f"running template code here")

    # THE PADDING IS LOAD-BEARING. `count_checks` reads the body through
    # `inspect.getsource`, which finds a function by the `co_firstlineno` of its
    # code object inside the file that code object names -- so the `def` has to
    # compile at the line it really occupies. Without the blank lines
    # `co_firstlineno` is 1, `getsource` hands the counter model.py's MODULE
    # DOCSTRING instead, and the count is of entirely the wrong text with nothing
    # to show for it.
    padded = ("\n" * (function.lineno - 1)
              + ast.get_source_segment(source, function))
    namespace = {}
    exec(compile(padded, str(TEMPLATE_DIR / "model.py"), "exec"), namespace)
    counted = count_checks(namespace["checks"])
    assert counted, (
        f"count_checks says {counted!r} of the template's checks(), so there is "
        f"no number for the skill to be quoting. None is a body it cannot read, "
        f"which reports `checks: passed (count unknown)`; 0 is a body that "
        f"provably holds no check, which makes `run_checks` raise BuildError "
        f"and fails the build outright -- and 0 is also what a broken padding "
        f"produces here, so suspect the line above before the template")

    quoted = QUOTED_CHECK_COUNT.findall(
        onboarding.SKILL_FILE.read_text(encoding="utf-8"))
    assert quoted, (
        "SKILL.md no longer quotes a `checks: <n> passed` line from a run of "
        "this template, and the two ways that happens want opposite fixes. If "
        "the passage went away, delete this test with it -- leaving it here "
        "green would be a pin that stopped pinning. If the passage is still "
        "there, QUOTED_CHECK_COUNT is what stopped matching it and the PATTERN "
        "is what to fix: it wants the count as digits inside one pair of "
        "backticks, so a reflow that breaks the line, or an `N` written in for "
        "consistency with the shape spelled a few lines above it, hides a "
        "quotation that is still being read by every agent")
    assert {int(number) for number in quoted} == {counted}, (
        f"SKILL.md tells its reader a run of the starter model reports "
        f"{sorted({int(n) for n in quoted})} checks; count_checks makes it "
        f"{counted}. The document is served to every agent that installs the "
        f"skill, so the number has to be the one this template really prints")


def test_the_skill_quotes_the_wording_of_the_message_this_template_emits():
    """`<name>.stl is <n> bytes, which is not a printable mesh`, by its form.

    The skill quotes that assertion so an agent recognises it when the block
    preview phase reddens -- boxes export tiny meshes, so it is the message the
    template's own `checks()` greets every first commit with, and being able to
    read it as expected rather than as a fault is the difference between
    rewriting `checks()` and abandoning the phase.

    THE FORM, NOT THE RUN. `bracket.stl` and `684` are one afternoon's build and
    must not be frozen here; what is pinned is the fixed words the f-string puts
    AROUND its substitutions -- one stretch between them and one after the last
    of them, which is the half that carries the sentence and the `endswith`
    anchor -- read out by AST and required to appear in the document's sentence,
    in order and anchored at whichever end the f-string itself ends in a
    literal. The message is not reassembled and no whole string is compared:
    `stl.name` and `size` are values this test cannot know.
    """
    source = (TEMPLATE_DIR / "model.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    # Found by the words it must contain rather than by where it sits: the
    # assertion moves every time a line is added above it. EVERY match is
    # collected rather than the first one taken, because taking the first says
    # nothing when there are several -- and `ast.walk` is breadth-first, so the
    # one it reaches first is not even the one that comes first in the file.
    messages = [node for node in ast.walk(tree)
                if isinstance(node, ast.JoinedStr)
                and any(isinstance(piece, ast.Constant)
                        and isinstance(piece.value, str)
                        and STL_MESSAGE_NEEDLE in piece.value
                        for piece in node.values)]
    assert messages, (
        f"no f-string in the template says {STL_MESSAGE_NEEDLE!r} any more. "
        f"SKILL.md quotes that message to an agent as the one a block preview "
        f"produces, so either the quotation goes with it or this is the wrong "
        f"needle to find it by")
    assert len(messages) == 1, (
        f"{len(messages)} f-strings in the template say "
        f"{STL_MESSAGE_NEEDLE!r}, so the needle no longer identifies one "
        f"message and SKILL.md quotes ONE of them. Narrow the needle -- or say "
        f"here which of them is the quoted one -- rather than letting this "
        f"test pin whichever ast.walk happened to reach first")
    message = messages[0]
    # Read the same way the selector above reads it, down to the `str` test:
    # two lines asking the same question of the same nodes should not ask it
    # two different ways.
    literals = [piece.value for piece in message.values
                if isinstance(piece, ast.Constant)
                and isinstance(piece.value, str)]
    # UNREACHABLE AS THE SELECTOR STANDS, and kept knowingly rather than by
    # oversight: `message` was chosen by a predicate that already demands a
    # string Constant holding the needle, so `literals` cannot come out empty
    # today. What it guards is the day that predicate is loosened -- found by
    # position, by the name it asserts on, by anything that stops implying a
    # literal -- because everything below reads `literals` as though it holds
    # something.
    assert literals, (
        "the template's message is now all substitution and holds no fixed "
        "words, so there is nothing in it for the skill to quote")

    quoted = QUOTED_STL_MESSAGE.findall(
        onboarding.SKILL_FILE.read_text(encoding="utf-8"))
    assert quoted, (
        "SKILL.md no longer quotes a `<name>.stl ... <n> ...` message from this "
        "template's checks(), and the two ways that happens want opposite "
        "fixes. If the passage went away, delete this test with it rather than "
        "leaving a pin that pins nothing. If the passage is still there, "
        "QUOTED_STL_MESSAGE is what stopped matching it and the PATTERN is what "
        "to fix: it wants the whole quotation on ONE line and a real byte count "
        "in it, so an ordinary markdown reflow -- or an `N` put in for "
        "consistency with the `assembled.stl: N parts` written elsewhere in "
        "the document -- breaks the match while the sentence a reader sees is "
        "untouched")

    for sentence in quoted:
        cursor = 0
        for literal in literals:
            found = sentence.find(literal, cursor)
            assert found != -1, (
                f"SKILL.md quotes {sentence!r} as this template's message, and "
                f"the template writes {literal!r} where that sentence does not "
                f"have it (or has it out of order). The document teaches the "
                f"wording of a message an agent is told to recognise")
            cursor = found + len(literal)
        # The ends, which the ordered search above cannot see: a sentence may
        # not carry anything after the f-string's last literal, or before its
        # first one, since neither could have come out of a substitution.
        if isinstance(message.values[-1], ast.Constant):
            assert sentence.endswith(literals[-1]), (
                f"SKILL.md's {sentence!r} runs on past the end of the message "
                f"the template emits, which finishes at {literals[-1]!r}")
        if isinstance(message.values[0], ast.Constant):
            assert sentence.startswith(literals[0]), (
                f"SKILL.md's {sentence!r} does not open the way the template's "
                f"message does, at {literals[0]!r}")


# -- the build ---------------------------------------------------------------
def test_the_template_builds_the_way_the_hub_builds_it(tmp_path):
    """THE TEST THIS FILE EXISTS FOR: run the template through `run_build`.

    Not `cadbuild.build()` called in this process — `run_build` is the entry
    point `src/jobs.py` uses on the push path, so what is exercised here is the
    spawned interpreter, the ceilings, the OCCT cap, the gate, the exports and
    the tessellation, in that order and with those arguments. A template that
    passes this is a template that publishes.

    It SKIPS where the CAD kernel does not import, which is both CI containers —
    see this module's docstring. `exc_type=ImportError` is explicit because the
    failure being skipped for is an ImportError that is NOT a
    ModuleNotFoundError: the distribution is installed and its extension refuses
    to load. pytest 9.1 changes that default, and without the argument this
    guard would stop skipping and CI would go red.
    """
    pytest.importorskip(
        "cadquery", exc_type=ImportError,
        reason="the CAD kernel does not import in this interpreter, so the "
               "template cannot be built here — see the module docstring for "
               "what skipping it costs")
    # AND THE RENDERING STACK, because this test asks for four PNGs. Without it
    # `render_previews` returns `[]` BY DESIGN — a python that cannot draw must
    # still be able to publish geometry — and says so with a `warning:` line, so
    # an interpreter carrying the kernel and not the renderer fails this test
    # twice over (on the missing artefacts and on the warnings assertion) for a
    # degradation the build supports on purpose. The MODULE is what is asked for
    # rather than matplotlib by name: that is the import `render_previews`
    # itself tries, so it covers numpy, trimesh and Pillow with it. `run_build`
    # spawns the same interpreter this runs in, so the answer here is the
    # child's answer.
    pytest.importorskip(
        "src.cadbuild.preview_png", exc_type=ImportError,
        reason="the preview renderer does not import in this interpreter, so "
               "the pictures this test expects are not produced — a supported "
               "degradation, not a broken template")

    project = tmp_path / "project"
    project.mkdir()
    for path in template_files():
        target = project / path.relative_to(TEMPLATE_DIR)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(path.read_bytes())
    # The one file `hammerola create` writes and the template does not carry,
    # in the shape that command really writes it: THREE keys, the third being
    # the slug the project publishes under. It matters here rather than being
    # decoration, because the warnings assertion below is absolute — a title
    # with no slug in its brackets is a `warning:` line of its own, and the
    # template would then fail its own build test over the fixture's wording.
    (project / PROJECT_FILE).write_text(
        '{"id": "abc123def456", "project": "template-under-test",'
        ' "title": "Template under test (template-under-test)"}',
        encoding="utf-8")

    outcome = run_build(project, tmp_path / "out", pid="abc123def456",
                        limits=BUILD_LIMITS)

    assert outcome.status == STATUS_OK, (
        f"the template no longer builds ({outcome.status}). Its whole log:\n"
        f"{outcome.log}")
    assert set(EXPECTED_ARTEFACTS) <= set(outcome.files), (
        f"the build published {sorted(outcome.files)}, missing "
        f"{sorted(set(EXPECTED_ARTEFACTS) - set(outcome.files))}")

    # AND NOTHING AT ALL FOR WHAT IS NOT PRINTED — the other direction, which
    # the subset above structurally cannot see: it catches a file that went
    # MISSING and never one that APPEARED. WHAT IT IS FOR IS A REGRESSION ON THE
    # BUILD SIDE, in the export path: the day exporting stops asking the kind and
    # writes screw.stl, screw.step, screw.3mf and screw_preview.png, the page
    # grows download buttons under a bought M3 screw — and the one model
    # everybody copies is what offers them. Half (a) below sees that through the
    # names filed under the record in meta.json, half (b) through the names the
    # build declared at all. Asked of the catalogue the build PUBLISHED rather
    # than of a list of names written out here, so renaming a part in the
    # template leaves this covering it. Deliberately not a strict equality
    # against EXPECTED_ARTEFACTS: that would freeze the whole list and fail on
    # every unrelated addition.
    #
    # TWO THINGS IT CANNOT SEE, so that nobody reads more into it. An entry whose
    # `kind` came back `printable` is not in `not_printed` at all, so neither
    # half ever looks at it — a catalogue record with no kind is refused earlier
    # and elsewhere, by `cadbuild.parts.read_catalogue`, which raises rather than
    # defaulting one. And `outcome.files` is the DECLARED list rather than a
    # listing of the output directory, so a file written and declared by nobody
    # is invisible to both halves here.
    meta = json.loads(
        (tmp_path / "out" / "meta.json").read_text(encoding="utf-8"))
    # ALL THREE KINDS ARE REPRESENTED, asserted rather than assumed: the loop
    # below passes by having nothing to say once the catalogue is printables
    # only, and `not_printed` being non-empty does not catch that — deleting the
    # screw leaves the board, and the template stops being the worked example of
    # `hardware` with every test in this file green.
    kinds = {entry["kind"] for entry in meta["parts"].values()}
    assert kinds == set(KINDS), (
        f"the template's catalogue covers {sorted(kinds)}, not {sorted(KINDS)}. "
        f"It is the one worked example of every kind there is, and the loop "
        f"below only says anything about the kinds that are in it")
    not_printed = {key: entry for key, entry in meta["parts"].items()
                   if entry["kind"] != KIND_PRINTABLE}
    for key, entry in sorted(not_printed.items()):
        assert "files" not in entry, (
            f"meta.json offers {entry.get('files')} for {key!r}, which is "
            f"{entry['kind']}: that is a download button under something "
            f"nobody prints")
        exported = sorted(name for name in outcome.files
                          if Path(name).stem == key
                          or name == f"{key}{PREVIEW_SUFFIX}")
        assert exported == [], (
            f"the build wrote {exported} for {key!r}, which is "
            f"{entry['kind']}. Nothing is exported for a part that is bought "
            f"or is only there to show what the design fits around")

    # THE GATE'S WARNINGS ARE FAILURES HERE, and only here: they are advice to
    # an author about their own model, and this model is the example everybody
    # copies. A template that publishes while telling its reader that a part is
    # invisible, that an alpha is the worst available value or that a key is
    # misspelt is teaching all three.
    warnings = [line for line in outcome.log.splitlines()
                if line.startswith("warning:")]
    assert warnings == [], (
        f"the template built, but the gate warned about it:\n"
        + "\n".join(warnings))

    # `checks()` is the third of the contract and the easiest to break into
    # something that looks fine: a body the counter cannot read reports "count
    # unknown", and one that provably holds no check fails the build outright.
    assert any(line.startswith("checks: ") and " passed" in line
               and "unknown" not in line
               for line in outcome.log.splitlines()), (
        f"the template's checks() no longer reports a COUNT of checks passed, "
        f"so the example teaches a shape the counter cannot read:\n"
        f"{outcome.log}")

    # AND THE INTERFERENCE SECTION LEFT ITS NUMBER BEHIND. The comment in the
    # template telling the reader not to delete that section as a duplicate of
    # the shared gate rests on exactly this file: the gate returns a verdict and
    # records nothing, so `assembly.interference_mm3` is the only place a joint
    # that started sharing volume shows up as a changed number between two
    # revisions — which is what `hammerola diff` reads. Without this the
    # argument is prose, and prose is what rots on this contract.
    #
    # THE PAIR, NOT THE VALUE. 0.0 today, but a seated lid is a face-to-face
    # touch and the kernel is free to answer a rounding error there; what has to
    # hold is that the pair is measured and written down at all.
    metrics = json.loads(
        (tmp_path / "out" / "metrics.json").read_text(encoding="utf-8"))
    measured = (metrics.get("assembly") or {}).get("interference_mm3") or {}
    assert "base|lid" in measured, (
        f"metrics.json records interference for {sorted(measured)}, not for "
        f"the base-to-lid pair the template's checks() measures. The comment "
        f"arguing that section is not a duplicate of the gate has nothing left "
        f"to stand on")
