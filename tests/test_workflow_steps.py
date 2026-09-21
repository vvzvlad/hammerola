"""The whitelist of `run:` bodies the two workflows share, checked mechanically.

AGENTS.md states the rule and the reason: a handful of step bodies must be
BYTE-IDENTICAL between `.gitea/workflows/tests.yml` and
`image-check-publish.yml`, because that is the whole mechanism keeping the PR
gate from drifting into testing less than the publishing one. It also says to
verify it by hashing rather than by eye.

This file is that hashing, run on every push. Until it existed the rule was
prose, and a prose rule about two files that are edited months apart is a rule
that holds until the first hurried edit — which, by the shape of the failure,
would be an edit that made the PR side check LESS while both files still looked
right.

Read as text, deliberately, with no YAML parser anywhere near it: a parser
normalises whitespace, and whitespace is precisely what is under test.

The two steps that LOOK like they belong on the list and deliberately do not get
an assertion of their own at the bottom — that they still DIFFER — so that
"fixing" them into agreement is caught in the same place as breaking one of the
six.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

import pytest

WORKFLOWS = Path(__file__).resolve().parents[1] / ".gitea" / "workflows"
PR = WORKFLOWS / "tests.yml"
PUBLISH = WORKFLOWS / "image-check-publish.yml"

# The whitelist, by step name. Both files spell these steps the same way, which
# is what makes the name usable as the key.
IDENTICAL = (
    "Run the test suite in a container",
    "Run the JS test suite in a container",
    "Remove the test container from the runner",
    "Remove the JS test container from the runner",
    "Smoke-test the built image",
    "Remove the smoke containers from the runner",
)

# Named in AGENTS.md as the steps that must NOT be unified, with the reason for
# each: the build step would either put a registry path into a workflow a pull
# request can trigger or take the tag computation out of the one that publishes,
# and the image cleanup is a loop over $TAGS on one side and a single `docker
# rmi` on the other.
DELIBERATELY_DIFFERENT = (
    ("Build the Docker image", "Build the Docker image"),
    ("Remove the built image from the runner", "Remove the built images from the runner"),
)

STEP = re.compile(r"^    - name: (.+)$")
RUN = re.compile(r"^      run: \|\s*$")


def bodies(path: Path) -> dict[str, str]:
    """Every step's `run:` body, keyed by the step's name.

    A block literal ends at the first line that is neither blank nor indented
    past the block's own indent — the same rule YAML itself uses, applied here
    without importing anything that would also strip the text.
    """
    found: dict[str, str] = {}
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    name = None
    index = 0
    while index < len(lines):
        match = STEP.match(lines[index].rstrip("\n"))
        if match:
            name = match.group(1)
        if RUN.match(lines[index].rstrip("\n")):
            index += 1
            block: list[str] = []
            while index < len(lines):
                line = lines[index]
                if line.strip() and not line.startswith("        "):
                    break
                block.append(line)
                index += 1
            assert name is not None, f"{path.name}: a run: block with no step name"
            assert name not in found, f"{path.name}: two steps named {name!r}"
            found[name] = "".join(block)
            continue
        index += 1
    return found


@pytest.fixture(scope="module")
def pr_bodies() -> dict[str, str]:
    return bodies(PR)


@pytest.fixture(scope="module")
def publish_bodies() -> dict[str, str]:
    return bodies(PUBLISH)


def test_both_workflows_are_readable(pr_bodies, publish_bodies):
    """The extractor found steps at all — the guard against a vacuous pass.

    Everything below compares two dictionaries. Two EMPTY dictionaries compare
    equal just as happily, so a change of indentation that made the regexes stop
    matching would turn this whole file green while checking nothing.
    """
    assert len(pr_bodies) >= len(IDENTICAL)
    assert len(publish_bodies) >= len(IDENTICAL)


@pytest.mark.parametrize("step", IDENTICAL)
def test_whitelisted_bodies_are_byte_identical(step, pr_bodies, publish_bodies):
    assert step in pr_bodies, f"{PR.name} has no step named {step!r}"
    assert step in publish_bodies, f"{PUBLISH.name} has no step named {step!r}"

    left, right = pr_bodies[step], publish_bodies[step]
    digest = hashlib.sha256(left.encode()).hexdigest()[:16]
    assert left == right, (
        f"the {step!r} bodies have drifted apart ({PR.name} sha256 {digest}, "
        f"{PUBLISH.name} sha256 "
        f"{hashlib.sha256(right.encode()).hexdigest()[:16]}). Edit one, edit the "
        f"other to match exactly — see the whitelist paragraph in AGENTS.md for "
        f"why this is not merely tidiness")


@pytest.mark.parametrize("pr_step,publish_step", DELIBERATELY_DIFFERENT)
def test_the_two_look_alike_steps_stay_different(pr_step, publish_step,
                                                 pr_bodies, publish_bodies):
    assert pr_bodies[pr_step] != publish_bodies[publish_step], (
        f"{pr_step!r} is now identical in both workflows. AGENTS.md names it as "
        f"one of the two steps that must NOT be unified; if that decision has "
        f"really changed, change it there and move the step onto the whitelist "
        f"above — do not let it happen by accident")


def test_the_whitelist_here_matches_the_one_in_agents_md():
    """Six, and AGENTS.md has to say six.

    The prose carries the REASON and this file carries the enforcement, so the
    two have to agree on the count at least. A number left behind at "four"
    while six bodies are checked is how the paragraph stops being read.
    """
    agents = (WORKFLOWS.parents[1] / "AGENTS.md").read_text(encoding="utf-8")
    assert "Exactly six `run:` bodies are BYTE-IDENTICAL" in agents, (
        "AGENTS.md no longer states the whitelist's size, or states a different "
        f"one — this file checks {len(IDENTICAL)} bodies")


# The gate's worst case, written down in THREE places: `ci/smoke.py` sums it from
# its own per-call budgets, and each workflow repeats the total in the comment
# that justifies the step's `timeout-minutes`.
SMOKE = WORKFLOWS.parents[1] / "ci" / "smoke.py"
SMOKE_SUM = re.compile(r"^#\s*=\s*(\d+) s,", re.M)
WORKFLOW_SUM = re.compile(r"sums from its individual per-call bounds: (\d+) s")
STEP_TIMEOUT = re.compile(r"timeout-minutes:\s*(\d+)")


def test_the_gates_worst_case_is_the_same_number_in_all_three_places():
    """One number, three files, and it has already drifted once in silence.

    Before check (i) was added, `ci/smoke.py` declared 765 s while both workflows
    declared 735 — each file consistent with ITSELF (840 − 75, 840 − 105) and
    with neither the other nor the truth. Nothing said so, because the rule was
    a sentence: "Raise this number whenever that sum grows past it, in BOTH
    workflows". AGENTS.md is explicit that a sentence like that is the
    specification for a test, and this is it.

    WHAT THE DRIFT COSTS is not a wrong comment. The step's `timeout-minutes` is
    sized off this sum, and a gate killed by its own timeout never reaches the
    `finally` that removes the containers it started — so the next run on that
    runner meets a name that is already taken. The margin is 45 s now, the
    narrowest it has been, which is exactly when the number stops tolerating a
    silent copy.

    The sum cannot be DERIVED from the constants: it is a sequence of calls, not
    a set of them, and only the script knows which ones it makes. Agreement
    between the three writings is all that is available, and it is enough to
    catch what actually went wrong.
    """
    declared = SMOKE_SUM.search(SMOKE.read_text(encoding="utf-8"))
    assert declared, (
        "ci/smoke.py no longer sums its worst case as a `#  = N s,` line — the "
        "arithmetic above IDLE_COMMAND is what this reads")
    worst = int(declared.group(1))

    for path in (PR, PUBLISH):
        text = path.read_text(encoding="utf-8")
        stated = WORKFLOW_SUM.search(text)
        assert stated, (
            f"{path.name} no longer repeats the gate's worst case in the "
            f"comment above its `timeout-minutes`")
        assert int(stated.group(1)) == worst, (
            f"{path.name} says the gate's worst case is {stated.group(1)} s and "
            f"ci/smoke.py sums it to {worst} s. One of the two was edited "
            f"alone; the sum in ci/smoke.py is the one derived from real "
            f"budgets, so fix the workflow to match it")

        # The step's own ceiling is the next `timeout-minutes` after that
        # comment, which is the one the comment is about.
        budget = STEP_TIMEOUT.search(text, stated.end())
        assert budget, f"{path.name} has no `timeout-minutes` after that comment"
        allowed = int(budget.group(1)) * 60
        assert worst < allowed, (
            f"{path.name} allows the gate {allowed} s and its own worst case is "
            f"{worst} s: a slow but healthy run is killed mid-gate, and the "
            f"`finally` that removes its containers never runs")


# The suite runs as TWO pytest invocations, and which tests each one takes is
# load-bearing rather than a tidy split.
SUITE_STEP = "Run the test suite in a container"
BUILDPROC_RUN = "pytest -n 4 --dist loadfile tests/buildproc "
REST_RUN = "pytest -n 4 --dist loadfile --ignore=tests/buildproc "


def test_buildproc_runs_in_a_pytest_of_its_own(pr_bodies, publish_bodies):
    """Merge the two invocations back into one and CI starts flipping a coin.

    `tests/buildproc/conftest.py` opens every test there by asserting the real
    kernel is not imported in this process -- a test that reached the live OCCT
    pool would resize it for everything after. Serially that held for free:
    `tests/buildproc/` is collected before `tests/cadbuild/`, whose real-geometry
    tests `importorskip("cadquery")` into the pytest process. Under xdist a
    worker takes whole files as they free up, so one worker can run a buildproc
    file, then a kernel file, then another buildproc file -- and every buildproc
    test after that errors at SETUP, blaming "a stub planted without monkeypatch"
    for something no test did. 91 errors on the run that caught it, against four
    green runs before, i.e. this is a coin rather than a regression.

    Two things hold it up besides the split, and neither is checked here because
    neither can be read off the workflow: nothing under `src/` imports the kernel
    at module level (it is reached inside functions), and no test under
    `tests/buildproc/` imports it either -- `probes.py` asks a SUBPROCESS. Break
    one of those and this test still passes while the coin comes back.
    """
    for name, body in (("tests.yml", pr_bodies[SUITE_STEP]),
                       ("image-check-publish.yml", publish_bodies[SUITE_STEP])):
        assert BUILDPROC_RUN in body, (
            f"{name}: tests/buildproc no longer runs in a pytest of its own. "
            f"Sharing a process with the tests that import the kernel is what "
            f"turns its autouse guard into a scheduling lottery")
        assert REST_RUN in body, (
            f"{name}: the second invocation no longer ignores tests/buildproc, "
            f"so those tests run twice -- the second time in workers that may "
            f"have the kernel imported, which is the failure the split avoids")


# THE TEST IMAGE'S TAG IS A HASH OF ITS INPUTS, and "its inputs" has to mean the
# same set of files in three places: the `cat` that hashes them, the `tar` that
# makes the build context, and the `COPY` in ci/Dockerfile.test that puts them in
# the image. A file that reaches the image without reaching the hash is a stale
# image answering to a CURRENT tag — the single failure the hash exists to rule
# out, arriving through the back door.
TEST_DOCKERFILE = WORKFLOWS.parents[1] / "ci" / "Dockerfile.test"
HASHED = re.compile(r'TEST_IMAGE="hammerola-test:\$\(cat ([^|]+)\| sha256sum')
CONTEXT = re.compile(r"tar -cf - (ci/Dockerfile\.test[^\\\n]*)")
COPIED = re.compile(r"^COPY (.+) /reqs/$", re.M)


def test_the_test_images_tag_hashes_every_file_that_can_change_it(pr_bodies,
                                                                 publish_bodies):
    """Three lists, one set, in both workflows.

    Read as text rather than executed, because what goes wrong is an edit: a
    requirements file added to the `COPY` and forgotten in the `cat`, and every
    run afterwards reuses an image built from the older set while the tag says it
    is current. Nothing about that run looks wrong — the suite passes, against
    dependencies nobody chose.

    The build context is in the set for the same reason, from the other side: a
    file the hash names but the context does not is a build that fails outright,
    which is loud, but it also means the hash is measuring something the image
    cannot contain.
    """
    copied = COPIED.search(TEST_DOCKERFILE.read_text(encoding="utf-8"))
    assert copied, (
        "ci/Dockerfile.test no longer has a `COPY <files> /reqs/` line this test "
        "can read — it is the only place the image's inputs are listed, so point "
        "this expression at the new shape rather than dropping the check")
    inputs = {TEST_DOCKERFILE.relative_to(WORKFLOWS.parents[1]).as_posix(),
              *copied.group(1).split()}

    for name, body in (("tests.yml", pr_bodies[SUITE_STEP]),
                       ("image-check-publish.yml", publish_bodies[SUITE_STEP])):
        hashed = HASHED.search(body)
        assert hashed, (
            f"{name}: the test image's tag is no longer a sha256 of a `cat` of "
            f"its inputs. A floating tag on a persistent daemon is one branch's "
            f"suite running against another branch's dependencies")
        assert set(hashed.group(1).split()) == inputs, (
            f"{name}: the tag hashes {sorted(hashed.group(1).split())} while the "
            f"image is built from {sorted(inputs)}. Whatever is in the image and "
            f"not in the hash can change without changing the tag")
        context = CONTEXT.search(body)
        assert context, (
            f"{name}: the build context is no longer a `tar -cf -` of named "
            f"files — this test reads that list to compare it with the hash")
        assert set(context.group(1).split()) == inputs, (
            f"{name}: the build context carries "
            f"{sorted(context.group(1).split())} against hashed "
            f"{sorted(inputs)}. The two lists are the same statement — nothing "
            f"else can affect the image, so nothing else can make it stale")


def test_the_suite_runs_in_the_image_the_step_builds(pr_bodies, publish_bodies):
    """The link that used to be mechanical and became prose.

    While the kernel's libraries were installed by the `docker run` itself,
    tests/test_ci_kernel_libs.py read the executed line. They live in
    ci/Dockerfile.test now, so that file is what it reads — and an edit putting
    any other image back on the `docker run` would leave all of it green while
    about ninety tests quietly went back to being skips, which is the failure
    issue #27 closed.
    """
    for name, body in (("tests.yml", pr_bodies[SUITE_STEP]),
                       ("image-check-publish.yml", publish_bodies[SUITE_STEP])):
        assert "| docker run" in body, (
            f"{name}: the suite is no longer started by a `docker run` this test "
            f"can find")
        started = body.split("| docker run", 1)[1].split("sh -c", 1)[0]
        assert '"$TEST_IMAGE"' in started, (
            f"{name}: the suite runs in something other than the image built "
            f"above. A bare python:3.11-slim there passes every check in this "
            f"file and silently turns the kernel's tests back into skips")
