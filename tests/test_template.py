"""The starter template, held to the contract by building it.

What `hammerola create` unpacks is copied, not read, so a template that stopped
satisfying the gate would hand every new project a push that cannot publish.

Two tests need the CAD kernel and run in CI (`ci/Dockerfile.test` carries its
libraries); they skip where `import cadquery` fails, as
`tests/test_view_fixture.py` does: the build test at the foot of this file and
the one comparing the stubbed kernel with the real one.

Everything else runs on every push, the provenance guard included: it imports
the template with the kernel stubbed and asks the hub's own rule. Most tests ask
whether the template is a tree the client unpacks and the hub would publish.

Two pins are about a document: the skill quotes this template (the number of
checks a run reports, and the wording of an assertion its `checks()` emits).
They are pinned here because the edit that falsifies them is an edit to
model.py. The skill is a directory of documents and the quotation may be in any
of them, so they read the whole set (`harness.one_text`). Neither needs the
kernel.
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
from harness import one_text, skill_files
from src import onboarding
from src.buildproc import run_build
from src.cadbuild import checklib, paths, provenance
from src.cadbuild.errors import BuildError
from src.cadbuild.artifacts import PREVIEW_SUFFIX
from src.cadbuild.modelchecks import count_checks
from src.cadbuild.parts import KIND_PRINTABLE, KINDS, RESERVED_STEMS
from src.buildproc.limits import DEFAULT_LIMITS, memory_limit_supported
from src.buildproc.runner import STATUS_OK
from hammerola.limits import MAX_MEMBERS
from hammerola.errors import ClientError
from hammerola.project import PROJECT_FILE
from hammerola.unpack import TEMPLATE_RULES, check_name

TEMPLATE_DIR = onboarding.TEMPLATE_DIR

# The production ceilings, less RLIMIT_AS on macOS, which Darwin refuses at
# every value (`limits.memory_limit_supported`).
BUILD_LIMITS = (DEFAULT_LIMITS if memory_limit_supported()
                else DEFAULT_LIMITS.replace(memory_bytes=None))

# What the model in the template is expected to produce. Named here rather than
# derived from the build, so a template that quietly stopped exporting a part
# fails instead of agreeing with itself.
EXPECTED_ARTEFACTS = (
    "meta.json", "metrics.json", "assembled.json", "print.json",
    "base.stl", "base.step", "base.3mf", "lid.stl", "lid.step", "lid.3mf",
    # The whole-build artefacts and the pictures, which must be written and
    # declared.
    "assembled.stl", "print.stl",
    "assembled_preview.png", "print_preview.png",
    "base_preview.png", "lid_preview.png",
    # The band-less cut of each whole-view render, for the project card. Only
    # whole views have one; there is no `base_card.png`.
    "assembled_card.png", "print_card.png",
)
# `outcome.files` is the verification list (what the parent checks and the hub
# hashes), assembled from `plate` and `written` rather than from the
# `downloads`/`overview`/`previews` maps, so narrowing what is offered cannot
# stop a file on disk from being verified.


@pytest.fixture(autouse=True)
def no_model_left_in_the_interpreter(tmp_path_factory):
    """Nothing a judged project supplied may outlive the test that judged it.

    `hub_verdict` imports a model into this interpreter; a name it leaves in
    `sys.modules` answers every later import. Checked before and after, so a leak
    is reported against the test that caused it.

    A stray is a module whose code lives under pytest's base temp directory
    (`modulesource`, which also handles namespace packages without `__file__`),
    not "anything new": `pytest.importorskip("cadquery")` legitimately adds
    hundreds. A leftover `_StubbedKernel` in `sys.modules` would let a later test
    compute geometry out of `_Opaque` stand-ins.
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

    The hub tars this directory, so a file `unpack.TEMPLATE_RULES` refuses would
    make every `hammerola create` fail. Hidden names are checked as leaves, as the
    rules do: a hidden directory such as `.git/config` could carry shell commands.
    """
    offenders = []
    for path in template_files():
        relative = path.relative_to(TEMPLATE_DIR).as_posix()
        try:
            # The client's own check, not a copy (see
            # `onboarding._refuse_unservable`).
            check_name(relative, "the template", TEMPLATE_RULES)
        except ClientError as error:
            offenders.append(str(error))
    assert offenders == [], (
        f"the template holds paths the client would refuse to unpack: "
        f"{offenders}")
    assert len(template_files()) <= MAX_MEMBERS


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
    # printables() was replaced by parts(); the build ignores it, so a leftover
    # would publish while teaching a contract that no longer exists.
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
# A stub kernel is enough for the template to execute; `provenance` then gives
# the hub's own verdict. EDITS below is a corpus of edits to the real template,
# each with the verdict the real rule gives it.


class _Opaque:
    """Whatever a kernel call hands back, for a python with no kernel.

    It lets the module execute and must never be a number: the rule asks
    `isinstance(value, float)` of every module global, so a float would invent
    bare numbers no real build sees.

    Multiplication by a scalar only, like `cq.Vector.__mul__`
    (`cq.Vector(0, 0, 1) * HEIGHT`); anything else returns `NotImplemented` so
    python raises the TypeError the kernel raises. An unsupported operation fails
    the import loudly rather than changing a verdict.
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
# declared, and what it found bare — as plain tuples so two runs can be compared
# (`test_the_stub_answers_what_the_real_kernel_answers`).
Verdict = collections.namedtuple("Verdict", "refusal declared bare")


def hub_verdict(project, stub=True):
    """Import the model in `project` and run the rule the build runs on it.

    `provenance.collect`, `provenance.unwrapped` and `provenance.check` are the
    calls `cadbuild.build` makes before any geometry, called rather than imitated.

    `sys.modules` is swept by where a module came from
    (`modulesource.came_from`, as `tests/cadbuild/test_provenance.py::_importable`
    does), never blanket-purged: the root `checklib.py` shim loads
    `src/cadbuild/checklib.py` by path, so a re-import mints a second `Number`
    class and every declared number would read as bare. Removing what the project
    supplied matters because a project's own `checklib.py` left in `sys.modules`
    makes the pristine template fail its own guard later.

    `cadquery` and the project root are put back as found. The root is pinned
    because the rule resolves the file it parses against it
    (`provenance._model_source`), not the module's `__file__`.
    """
    from src.cadbuild import provenance

    displaced = sys.modules.get("cadquery")
    present = "cadquery" in sys.modules
    displaced_root = paths._root
    paths.set_project_root(project)
    if stub:
        sys.modules["cadquery"] = _StubbedKernel("cadquery")
    # After the stub, so restoring `cadquery` is only the branch below's job.
    before = set(sys.modules)
    # The model's directory first on sys.path, as `geometry.load_model` does.
    sys.path.insert(0, str(project))
    spec = importlib.util.spec_from_file_location("model_under_test",
                                                  project / "model.py")
    module = importlib.util.module_from_spec(spec)
    try:
        try:
            spec.loader.exec_module(module)
        except Exception as error:
            # Under the stub, a bare AttributeError would read as a broken
            # model; say it is the stub.
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

# The pin on the guard itself: what it refuses and what it publishes. Every entry
# was run through the real rule and the real CAD kernel; the refused ones are
# shapes an author actually writes, the accepted ones are geometry lines a naive
# float check would wrongly flag.
EDITS = (
    UNCHANGED,
    # -- refused: provenance does not survive arithmetic -------------------
    # The likeliest mistake: a constant derived by arithmetic is a plain float.
    Edit("a constant derived by arithmetic", None,
         "\nRIM = WALL * 2\n", refused=True),
    # The shape the rule is named for.
    Edit("a bare float", None, "\nRIM = 4.8\n", refused=True),
    # A number taken back out of a container: a dict of estimates is accepted,
    # arithmetic over one of its values is not.
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
    # The template's own line, one character away; it is geometry and the hub
    # publishes it.
    Edit("a float literal inside a kernel call",
         "cq.Vector(1, 0, 0), 180)", "cq.Vector(1, 0, 0), 180.0)",
         refused=False),
    Edit("a location built from literals", None,
         "\nSEATED = cq.Location((0, 0, 1.5))\n", refused=False),
    Edit("a vector scaled by a dimension", None,
         "\nOFFSET = cq.Vector(0, 0, 1) * HEIGHT\n", refused=False),
    Edit("a string formatted from a number", None,
         "\nLABEL = '%.1f mm' % SCREW_DIA\n", refused=False),
    # A bool is not a float subclass, so this is outside the rule
    # (`tests/cadbuild/test_provenance.py` states it).
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

    Runs without a CAD kernel: the kernel is stubbed, the rule is real.
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
    """A namespace package passes through the sweep and the fixture cleanly.

    `hub_verdict` puts the project first on sys.path, as `geometry.load_model`
    does. Mocks kept in a directory without `__init__.py` form a namespace
    package (`__file__` is None, the location is in `__path__`), which must be
    swept like any other module. The autouse fixture re-checks `sys.modules`
    after this test as well.
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
    """Each shape in EDITS, put through the real rule."""
    verdict = hub_verdict(template_under(tmp_path, edit))
    refused = verdict.refusal is not None
    assert refused == edit.refused, (
        f"EDITS says the hub would "
        f"{'refuse' if edit.refused else 'publish'} the template with "
        f"{edit.label}, and it {'refused' if refused else 'published'} it"
        + (f":\n{verdict.refusal}" if refused else ""))


@pytest.mark.parametrize("edit", EDITS, ids=[edit.label for edit in EDITS])
def test_the_stub_answers_what_the_real_kernel_answers(edit, tmp_path):
    """The stub changes no verdict: the second test here needing a kernel.

    Compares the whole verdict on the same corpus — refusal text, every declared
    number with its kind and value, every bare one — stubbed against real.

    It skips where the kernel does not import (CI installs it). The guard itself
    does not skip; only the stub's faithfulness goes unchecked, which matters as
    the kernel moves on its `requirements.txt` pins.
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
    """`_Opaque` refuses non-scalar multiplication, as `cq.Vector` does.

    `cq.Vector(0, 0, 1) * cq.Vector(1, 0, 0)` raises TypeError in the real
    kernel. The EDITS corpus cannot hold this case: an edit has to import under
    both kernels to be compared. The second half needs the kernel and skips
    without it.
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
    """The import failure names the stub, which is usually the cause.

    `_Opaque` supports only what the models here need, and a bare
    `AttributeError: '_Opaque' object has no attribute 'Length'` reads as a
    broken model on every parametrised case at once.
    """
    project = template_under(tmp_path, Edit(
        "an attribute _Opaque does not have", None,
        "\nDIAG = cq.Vector(1, 2, 3).Length\n", refused=False))
    with pytest.raises(AssertionError, match="STUBBED kernel"):
        hub_verdict(project)


def test_every_measurement_in_the_template_points_at_a_real_line_of_the_journal():
    """`ref/measurements.md#screw` has to name a file and a heading that exist.

    Checked by the build's own resolver, so a renamed heading or a moved journal
    fails here rather than in someone's first `hammerola build`. The provenance
    guard also catches an unresolved source; this test additionally requires that
    the template measures something at all, as the worked example of
    `measured()`.
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
    """Every section the template's model cites carries a date.

    The skill describes the journal as "date, what was measured, with
    what, the number", and the template is the worked example; the date says
    whether a figure predates a change that should have moved it.

    Headings are read with the resolver's own regex (all six levels, closing
    hashes allowed), not a `^## ` of this test's own. Only cited sections need a
    date: `# Measurements` is the file's title.
    """
    from src.cadbuild.provenance import _HEADING, heading_slug

    text = (TEMPLATE_DIR / "ref" / "measurements.md").read_text(encoding="utf-8")
    # Off the syntax tree: the template's comments spell
    # `checklib.measured(v, "ref/measurements.md#heading")` as an example, which
    # a text search would read as a citation.
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


# One backticked constant, and a run of them. The names the skill lists as this
# template's estimated clearances are found by the substituted values, not by
# the surrounding prose, so a reword cannot silently stop the match. Two or more
# names: the skill also backticks `GRIP_DROP` alone, about another model.
QUOTED_NAME = re.compile(r"`([A-Z][A-Z0-9_]{2,})`")
QUOTED_NAME_RUN = re.compile(
    QUOTED_NAME.pattern + r"(?:(?:,| and)\s+" + QUOTED_NAME.pattern + r")+")

# The three constructors, as `checklib.<attr>` is written in a model.
DECLARING_CALLS = ("measured", "derived", "estimated")


def _one_level(name, node):
    """`(name, node)` for a value and, one level in, for what a literal holds.

    The same one level `provenance._one_level` walks: the hub counts what is
    inside a dict or list of constants (`GAPS = {'lid': checklib.estimated(...)}`).
    Named `GAPS['lid']` and `SIZES[0]`, as `provenance` names them.
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

    Positional or keyword (`note=`): the constructor takes either.
    """
    if len(call.args) > 1:
        return call.args[1]
    return next((word.value for word in call.keywords if word.arg == "note"),
                None)


def checklib_names(tree):
    """`(modules, constructors)` -- which names in this module mean checklib.

    Two shapes: `import checklib` binds a module (`checklib.estimated(...)`), and
    `from checklib import estimated` binds the constructor (`estimated(...)`);
    the hub counts both. `ast.walk` rather than the module body, because an
    import inside `try:` still binds a module global. Aliases
    (`import checklib as cl`) are followed, since the hub sees the object, not
    the word.
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

    Checks which module the attribute is on, so `self.estimated(...)` or
    `numpy.derived(...)` does not count.
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

    Which names a module binds is `provenance.module_bindings`, the hub's own
    walk (tuple and starred targets, declarations inside a module-level `if` or
    `try`, walrus). On top of it, one level into a literal (see `_one_level`).

    Outside it: a call not written where the name is bound (`WALL = _pick()`, or
    a number from another module). `provenance` reaches those through the
    imported module, so the hub's rule stays the wider of the two.

    Sharing the walk means a bug in `module_bindings` makes the hub and this
    wrong together; `tests/cadbuild/test_provenance.py` covers the walk itself.
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

    A declaration in a dict, in a list, a note as `note=`, a chained assignment,
    an annotated one, a tuple target, a starred one, inside a module-level `if`
    or `try`, a walrus, and the bare-name call `from checklib import estimated`
    leaves.

    The last four lines are the boundary: local names, class attributes, lambda
    bodies and a non-checklib `.estimated` are not module-level declarations.
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
        # A starred target takes an unknown number of elements, so the hub's walk
        # hands the whole list to both names (`provenance._paired`); both are
        # named after the list.
        "HEAD[0]": "estimated",
        "REST[0]": "estimated",
        "BOSS": "estimated",
        "GAP": "estimated",
        "SLOP": "estimated",
    }
    assert estimate_note(found["GAPS['lid']"][1]).value == "settled by the pair"


def test_the_skill_is_right_about_what_an_estimate_does_in_this_template():
    """Two sentences of the skill, pinned to the file they describe.

    The template's clearances are estimates, and its estimates drive geometry.
    Pinned here because the edit that falsifies them is an edit to model.py. The
    names are read out of the document, not transcribed, so deleting the
    sentences from the skill fails this too.
    """
    skill = one_text(skill_files())
    tree = ast.parse((TEMPLATE_DIR / "model.py").read_text(encoding="utf-8"))
    kinds = {name: kind for name, (kind, _, _) in declared_in_template().items()}

    # The constants the document names as estimates.
    named = sorted({name for run in QUOTED_NAME_RUN.finditer(skill)
                    for name in QUOTED_NAME.findall(run.group(0))})
    assert named, (
        "the skill no longer lists any of this template's constants as its "
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
            f"the skill names {name} as one of this template's estimated "
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
        "the skill says an estimate drives geometry like any other number "
        "and points at this template; not one of its estimates is named by the "
        "geometry any more")


# The one estimate whose note answers by negation: PRINTER_TOL is a rounding
# allowance, not a dimension, so no measurement would settle it.
SETTLED_BY_NEGATION = {"PRINTER_TOL"}


def test_every_estimate_in_the_template_says_what_would_settle_it():
    """Every estimate's note says what would settle it.

    `checklib.estimated(value, note)` documents `note` as "what would settle
    it", and this template is the example every author copies. A note that
    reports a result answers a different question. This checks the shape, not
    the truth: it catches a note without a settling clause. Needs no kernel.
    Which estimates it sees is `declared_in_template()` (dicts, `note=`,
    chained assignments included).
    """
    notes = {}
    for name, (kind, call, line) in declared_in_template().items():
        # The kind the selector worked out, not `call.func.attr`: a constructor
        # imported by name is a call on an `ast.Name`, which has no `.attr`.
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


# The author-text arguments of each constructor, in order after `value`. Both of
# `measured()`'s count: `checklib._text_problem` holds a source to the same
# ceiling as a note.
AUTHOR_TEXT = {"measured": ("source", "note"),
               "derived": ("note",),
               "estimated": ("note",)}


def author_text_in(source):
    """Every string this module hands a checklib constructor.

    -> `[(chars, line, field, text)]`, and a list of arguments that are not
    literals, which the caller asserts is empty so nothing goes unmeasured.
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
    """`MAX_NOTE_CHARS` has room over this directory.

    Asserts the longest note so the message says which note is over and by how
    much. Covers every `.py` in the directory and both of `measured()`'s text
    fields, since the ceiling belongs to the constructor, not to model.py.
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
    """`MAX_LISTED` has room over this directory.

    Pins the claim, not a number: a real model sits under the ceiling, so the
    truncation `notes_omitted` and `estimates_omitted` report happens to a
    pathological push, not to the worked example. Needs no kernel: the count
    comes from `declared_in`.
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

    A stem the template does not mention is a `BuildError` on someone's first
    build (`print` is an ordinary part name). model.py may import nothing from
    `src`, so the copy in its docstring is checked instead.
    """
    tree = ast.parse((TEMPLATE_DIR / "model.py").read_text(encoding="utf-8"))
    doc = next(ast.get_docstring(node) for node in tree.body
               if isinstance(node, ast.FunctionDef) and node.name == "parts")
    for stem in RESERVED_STEMS:
        # The file, not the bare stem: `print` also appears in the docstring as
        # a view name.
        assert f"{stem}.stl" in doc, (
            f"the build refuses a catalogue key {stem!r} (RESERVED_STEMS in "
            "cadbuild.parts) and the template never says so")


def test_the_archive_the_hub_serves_is_this_directory():
    """The bytes a `create` receives, compared against the files on disk, so the
    assertions above are about what is actually shipped."""
    with tarfile.open(fileobj=io.BytesIO(onboarding.template_bytes()),
                      mode="r:gz") as tar:
        served = {info.name: tar.extractfile(info).read()
                  for info in tar.getmembers()}
    on_disk = {str(path.relative_to(TEMPLATE_DIR)): path.read_bytes()
               for path in template_files()}
    assert served == on_disk


# -- what the skill quotes out of this directory -----------------------------
# The quotations in the skill are found by the substituted values (a count; a
# `.stl` name with a byte count), never by the fixed words, which are what is
# being pinned: a pattern spelling them out would stop matching on a reword
# instead of failing. (QUOTED_CHECK_COUNT's fixed words are `run_checks`'s own
# print, not the skill's prose.)

# `checks: N passed` is `modelchecks.run_checks`'s own print. Only a literal
# count matches; the skill also writes the shape with `N`.
QUOTED_CHECK_COUNT = re.compile(r"`checks: (\d+) passed`")

# A backticked sentence beginning with a `.stl` file name and holding a number:
# `stl.name` and `size`, the two values the template substitutes in.
QUOTED_STL_MESSAGE = re.compile(r"`([A-Za-z0-9_.-]+\.stl\b[^`\n]*?\d[^`\n]*)`")

# The stretch of that message the template is searched by: enough to tell this
# f-string from the other messages in checks(), and small so the rest is left
# for the comparison.
STL_MESSAGE_NEEDLE = "printable mesh"


def test_the_skill_quotes_the_number_of_checks_this_template_reports():
    """`checks: 10 passed` in the skill, against what the counter says.

    The skill's worked example of checks going green about parts the catalogue
    no longer holds rests on that number, and the document is served to every
    agent, so a check added to or removed from `checks()` must update it.

    Counted with `modelchecks.count_checks` on the template's real `checks`. The
    build prints `count_checks(...) - len(static_asserts(...))`; the two agree
    because the template has no static assert, which
    `test_the_template_builds_the_way_the_hub_builds_it` holds (each one prints a
    `warning:` line). `static_asserts` needs the imported module, and importing
    model.py needs the kernel, so it is not called here: this pin must run on
    every push without a kernel.
    """
    source = (TEMPLATE_DIR / "model.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    # Every match: python binds the name to the last `def checks`.
    functions = [node for node in tree.body
                 if isinstance(node, ast.FunctionDef)
                 and node.name == "checks"]
    assert functions, (
        "the template no longer defines `checks` as a plain function at module "
        "level -- an `async def` is an ast.AsyncFunctionDef, and one moved "
        "inside another block is not in `tree.body` at all. Either is a change "
        "to the shape the skill quotes a run of, so say which it is here rather "
        "than leaving the next reader a wordless IndexError")
    assert len(functions) == 1, (
        f"the template defines checks() {len(functions)} times at module "
        f"level. Python binds the name to the LAST of them, so that is the one "
        f"the build runs, while this test would go on measuring the FIRST -- "
        f"and hold the skill to a count of a function nothing ever executes. "
        f"Define checks() once rather than leaving this test to choose")
    function = functions[0]

    # Executing the `def` alone is safe only while it is bare: decorators,
    # default arguments and annotations are evaluated at definition time, and
    # that would run template code that reaches for the kernel.
    assert function.decorator_list == [], (
        "the template's checks() has grown a decorator, which this test would "
        "evaluate: it executes the `def` to hand the real function to "
        "count_checks. Count it another way rather than running template code "
        "here")
    assert not function.args.defaults and not any(function.args.kw_defaults), (
        "the template's checks() has grown a default argument, which is an "
        "expression this test would evaluate when it executes the `def`")
    # Annotations are lazy under PEP 649 (3.14) but evaluated at `def` time on
    # 3.11, where CI runs this suite; the template's builders are annotated
    # `-> cq.Workplane`, so annotating checks() is an ordinary edit.
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

    # The padding is load-bearing: `count_checks` reads the body through
    # `inspect.getsource`, which locates the function by `co_firstlineno`. Without
    # it the `def` compiles at line 1 and the counter reads model.py's docstring.
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
        one_text(skill_files()))
    assert quoted, (
        "the skill no longer quotes a `checks: <n> passed` line from a run of "
        "this template, and the two ways that happens want opposite fixes. If "
        "the passage went away, delete this test with it -- leaving it here "
        "green would be a pin that stopped pinning. If the passage is still "
        "there, QUOTED_CHECK_COUNT is what stopped matching it and the PATTERN "
        "is what to fix: it wants the count as digits inside one pair of "
        "backticks, so a reflow that breaks the line, or an `N` written in for "
        "consistency with the shape spelled a few lines above it, hides a "
        "quotation that is still being read by every agent")
    assert {int(number) for number in quoted} == {counted}, (
        f"the skill tells its reader a run of the starter model reports "
        f"{sorted({int(n) for n in quoted})} checks; count_checks makes it "
        f"{counted}. The document is served to every agent that installs the "
        f"skill, so the number has to be the one this template really prints")


def test_the_skill_quotes_the_wording_of_the_message_this_template_emits():
    """`<name>.stl is <n> bytes, which is not a printable mesh`, by its form.

    The skill quotes that assertion so an agent recognises it when the block
    preview phase reddens (boxes export tiny meshes) as expected rather than a
    fault.

    The form, not the run: the fixed words the f-string puts around its
    substitutions are read by AST and required in the document's sentence, in
    order and anchored at whichever end the f-string ends in a literal. `stl.name`
    and `size` are values this test cannot know.
    """
    source = (TEMPLATE_DIR / "model.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    # Found by the words it contains, not by position. Every match is collected:
    # `ast.walk` is breadth-first, so the first one reached need not be the
    # first in the file.
    messages = [node for node in ast.walk(tree)
                if isinstance(node, ast.JoinedStr)
                and any(isinstance(piece, ast.Constant)
                        and isinstance(piece.value, str)
                        and STL_MESSAGE_NEEDLE in piece.value
                        for piece in node.values)]
    assert messages, (
        f"no f-string in the template says {STL_MESSAGE_NEEDLE!r} any more. "
        f"the skill quotes that message to an agent as the one a block preview "
        f"produces, so either the quotation goes with it or this is the wrong "
        f"needle to find it by")
    assert len(messages) == 1, (
        f"{len(messages)} f-strings in the template say "
        f"{STL_MESSAGE_NEEDLE!r}, so the needle no longer identifies one "
        f"message and the skill quotes ONE of them. Narrow the needle -- or say "
        f"here which of them is the quoted one -- rather than letting this "
        f"test pin whichever ast.walk happened to reach first")
    message = messages[0]
    # Read the same way the selector reads it, down to the `str` test.
    literals = [piece.value for piece in message.values
                if isinstance(piece, ast.Constant)
                and isinstance(piece.value, str)]
    # Unreachable while the selector demands a string Constant holding the
    # needle; guards a looser selector, since everything below assumes literals.
    assert literals, (
        "the template's message is now all substitution and holds no fixed "
        "words, so there is nothing in it for the skill to quote")

    quoted = QUOTED_STL_MESSAGE.findall(
        one_text(skill_files()))
    assert quoted, (
        "the skill no longer quotes a `<name>.stl ... <n> ...` message from this "
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
                f"the skill quotes {sentence!r} as this template's message, and "
                f"the template writes {literal!r} where that sentence does not "
                f"have it (or has it out of order). The document teaches the "
                f"wording of a message an agent is told to recognise")
            cursor = found + len(literal)
        # The ends, which the ordered search cannot see: nothing may come after
        # the last literal or before the first.
        if isinstance(message.values[-1], ast.Constant):
            assert sentence.endswith(literals[-1]), (
                f"the skill's {sentence!r} runs on past the end of the message "
                f"the template emits, which finishes at {literals[-1]!r}")
        if isinstance(message.values[0], ast.Constant):
            assert sentence.startswith(literals[0]), (
                f"the skill's {sentence!r} does not open the way the template's "
                f"message does, at {literals[0]!r}")


# -- the build ---------------------------------------------------------------
def test_the_template_builds_the_way_the_hub_builds_it(tmp_path):
    """Run the template through `run_build`, as the hub does.

    `run_build` is the entry point `src/jobs.py` uses on the push path: spawned
    interpreter, ceilings, OCCT cap, gate, exports and tessellation. A template
    that passes this publishes.

    It skips where the CAD kernel does not import (CI installs it).
    `exc_type=ImportError` is explicit because the skip is for an ImportError
    that is not a ModuleNotFoundError (an installed extension that refuses to
    load), and pytest 9.1 changes that default.
    """
    pytest.importorskip(
        "cadquery", exc_type=ImportError,
        reason="the CAD kernel does not import in this interpreter, so the "
               "template cannot be built here — see the module docstring for "
               "what skipping it costs")
    # And the rendering stack: without it `render_previews` writes no PNGs by
    # design and prints a `warning:` line, which this test would fail on twice
    # for a supported degradation. Asking for the module covers numpy, trimesh
    # and Pillow; `run_build` spawns this same interpreter.
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
    # The file `hammerola create` writes, in its real shape with the slug in the
    # title: a title without one is a `warning:` line, which the absolute
    # warnings assertion below would fail on.
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

    # Nothing is exported for a part that is not printed, which the subset above
    # cannot see: (a) no `files` under its meta.json record, (b) no declared
    # file named after it. Asked of the published catalogue, so renaming a part
    # keeps it covered. Not a strict equality against EXPECTED_ARTEFACTS, which
    # would fail on every unrelated addition. A catalogue record without a kind
    # is refused earlier (`cadbuild.parts.read_catalogue`), and `outcome.files`
    # is the declared list, not a directory listing.
    meta = json.loads(
        (tmp_path / "out" / "meta.json").read_text(encoding="utf-8"))
    # All three kinds are represented, so the loop below has something to check
    # and the template stays the worked example of every kind.
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

    # The gate's warnings are failures here only: this model is the example
    # everybody copies.
    warnings = [line for line in outcome.log.splitlines()
                if line.startswith("warning:")]
    assert warnings == [], (
        f"the template built, but the gate warned about it:\n"
        + "\n".join(warnings))

    # A body the counter cannot read reports "count unknown"; one that provably
    # holds no check fails the build.
    assert any(line.startswith("checks: ") and " passed" in line
               and "unknown" not in line
               for line in outcome.log.splitlines()), (
        f"the template's checks() no longer reports a COUNT of checks passed, "
        f"so the example teaches a shape the counter cannot read:\n"
        f"{outcome.log}")

    # The interference section leaves its number: the gate records nothing, so
    # `assembly.interference_mm3` is where a joint that starts sharing volume
    # shows up between revisions (`hammerola diff` reads it); the template's
    # comment against deleting that section rests on this. The pair is asserted,
    # not the value: a seated lid may yield a rounding error.
    metrics = json.loads(
        (tmp_path / "out" / "metrics.json").read_text(encoding="utf-8"))
    measured = (metrics.get("assembly") or {}).get("interference_mm3") or {}
    assert "base|lid" in measured, (
        f"metrics.json records interference for {sorted(measured)}, not for "
        f"the base-to-lid pair the template's checks() measures. The comment "
        f"arguing that section is not a duplicate of the gate has nothing left "
        f"to stand on")
