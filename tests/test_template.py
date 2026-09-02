"""The starter template, held to the contract by BUILDING it.

THIS IS WHY THE TEMPLATE IS FILES AND NOT A PARAGRAPH OF DOCUMENTATION. What
`hammerola create` unpacks is the first model anybody here writes, and it is
copied rather than read — so a template that stopped satisfying the gate would
be a project that cannot publish, handed to somebody who has no way of telling
whether the fault is theirs. Written as prose in a README it would rot in
silence. As a directory the suite pushes through the real build, it cannot.

THE BUILD TEST IS THE ONLY ONE HERE THAT NEEDS THE CAD KERNEL, AND IT IS THE ONE
CI CANNOT RUN. The kernel is not importable in the test container (both workflows
run the suite in a bare `python:3.11-slim`, where `import cadquery` dies on
`libGL.so.1`), so it skips there exactly as `tests/test_view_fixture.py` does —
its docstring carries the full accounting of what that costs. Everything else in
this file needs no kernel at all and keeps running on every push, and it is not
all one thing: most of it asks whether the template is a tree the hub would
ACCEPT, which is what breaks from an ordinary edit — a file added under a name
the path alphabet refuses takes the whole push down, and takes it down for every
project created from the template afterwards — while the pins described next ask
about a document instead. Stated by which group a test is in rather than by
counting them, because the count is what went stale here before.

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
import json
import re
import tarfile
import io
from pathlib import Path

import pytest

from src import onboarding
from src.buildproc import run_build
from src.cadbuild.artifacts import PREVIEW_SUFFIX
from src.cadbuild.modelchecks import count_checks
from src.cadbuild.parts import KIND_PRINTABLE, KINDS, RESERVED_STEMS
from src.buildproc.limits import DEFAULT_LIMITS, memory_limit_supported
from src.buildproc.runner import STATUS_OK
from src.client import pack
from src.client.limits import MAX_BUILD_BYTES, MAX_MEMBERS, SAFE_COMPONENT
from src.client.errors import ClientError
from src.client.project import PROJECT_FILE
from src.client.unpack import TEMPLATE_RULES, check_name

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

    Counted with `modelchecks.count_checks`, which is the function the build
    prints that line with rather than a second implementation of it, applied to
    the template's real `checks`. model.py is never IMPORTED because importing
    it needs the CAD kernel, which the test container has not got: the pin would
    then carry an `importorskip` and skip in exactly the place it has to run --
    every push, in the containers the build test below already skips in.
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
