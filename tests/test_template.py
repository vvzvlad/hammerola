"""The starter template, held to the contract by BUILDING it.

THIS IS WHY THE TEMPLATE IS FILES AND NOT A PARAGRAPH OF DOCUMENTATION. What
`hammerola create` unpacks is the first model anybody here writes, and it is
copied rather than read — so a template that stopped satisfying the gate would
be a project that cannot publish, handed to somebody who has no way of telling
whether the fault is theirs. Written as prose in a README it would rot in
silence. As a directory the suite pushes through the real build, it cannot.

TWO TESTS, AND ONLY ONE OF THEM RUNS IN CI. The kernel is not importable in the
test container (both workflows run the suite in a bare `python:3.11-slim`, where
`import cadquery` dies on `libGL.so.1`), so the build test skips there exactly as
`tests/test_view_fixture.py` does — its docstring carries the full accounting of
what that costs. The other test needs no kernel at all and is the one that keeps
running on every push: it asks whether the template is a tree the hub would
ACCEPT, which is the half that breaks from an ordinary edit — a file added under
a name the path alphabet refuses takes the whole push down, and takes it down for
every project created from the template afterwards.
"""

import ast
import tarfile
import io
from pathlib import Path

import pytest

from src import onboarding
from src.buildproc import run_build
from src.cadbuild.printables import RESERVED_STEMS
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
    """views(), printables(), checks() and `import checklib`, read out of the
    source rather than by importing it — this test runs where there is no CAD
    kernel to import it with."""
    tree = ast.parse((TEMPLATE_DIR / "model.py").read_text(encoding="utf-8"))
    defined = {node.name for node in tree.body
               if isinstance(node, ast.FunctionDef)}
    assert {"views", "printables", "checks"} <= defined
    imported = {alias.name for node in ast.walk(tree)
                if isinstance(node, ast.Import) for alias in node.names}
    assert "checklib" in imported, (
        "the template is the only worked example of `import checklib`, which is "
        "the fourth part of the contract and the one nothing else demonstrates")
    assert "cadquery" in imported


def test_the_template_warns_about_every_stem_the_build_takes_for_itself():
    """`printables()` must name all of RESERVED_STEMS, not just `assembled`.

    The template is the one worked example every author copies, and a stem it
    fails to mention is a `BuildError` on somebody else's first build with no
    warning anywhere ahead of it — `print` above all, which is a completely
    ordinary name for a single printed part. The names cannot be derived there:
    model.py is a MODEL, it may import nothing from `src`, and a docstring is a
    literal besides. So the copy is checked instead of avoided.
    """
    tree = ast.parse((TEMPLATE_DIR / "model.py").read_text(encoding="utf-8"))
    doc = next(ast.get_docstring(node) for node in tree.body
               if isinstance(node, ast.FunctionDef) and node.name == "printables")
    for stem in RESERVED_STEMS:
        # The FILE, not the bare stem: `print` on its own also appears in this
        # docstring as the name of a view, so a docstring that had dropped the
        # warning would still contain the word.
        assert f"{stem}.stl" in doc, (
            f"the build refuses a printable called {stem!r} (RESERVED_STEMS in "
            "cadbuild.printables) and the template never says so")


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
    # The one file `hammerola create` writes and the template does not carry.
    (project / PROJECT_FILE).write_text(
        '{"id": "abc123def456", "title": "Template under test"}',
        encoding="utf-8")

    outcome = run_build(project, tmp_path / "out", pid="abc123def456",
                        limits=BUILD_LIMITS)

    assert outcome.status == STATUS_OK, (
        f"the template no longer builds ({outcome.status}). Its whole log:\n"
        f"{outcome.log}")
    assert set(EXPECTED_ARTEFACTS) <= set(outcome.files), (
        f"the build published {sorted(outcome.files)}, missing "
        f"{sorted(set(EXPECTED_ARTEFACTS) - set(outcome.files))}")

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
