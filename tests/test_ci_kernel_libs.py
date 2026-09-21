"""The CI test container and the image install the SAME kernel libraries.

`import cadquery` needs libGL, libX11 and libexpat from outside the wheel — the
derivation is in the Dockerfile and belongs there, not here. What this file
guards is that the two places which install them cannot drift apart: the image's
`RUN apt-get install` and the `apt-get install` inside the test step of both
workflows.

Drift is silent in the direction that matters. Add a library to the Dockerfile
because the kernel started needing it, and the suite goes on running in a
container that lacks it: the tests that touch the kernel skip (a skip is not a
failure), CI stays green, and the missing library surfaces on the hub. Drop one
from the Dockerfile and the suite proves the kernel imports in an environment the
image no longer provides — green here, `ImportError` in production.

Only the packaging is checked. Whether the list is CORRECT is answered by
`ci/smoke.py`, which imports cadquery inside the built image before anything is
pushed.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCKERFILE = ROOT / "Dockerfile"
# BY NAME rather than by globbing the directory, as tests/test_workflow_steps.py
# names them: a glob that stops matching — a rename to `.yaml`, a directory that
# moved — leaves this file comparing nothing and still green, and a third
# workflow that legitimately installs nothing would fail it for no drift at all.
WORKFLOWS = (ROOT / ".gitea" / "workflows" / "tests.yml",
             ROOT / ".gitea" / "workflows" / "image-check-publish.yml")

# The image's own runtime tools, on the Dockerfile's line and deliberately not in
# the test container: `curl` is the healthcheck's, `gosu` the entrypoint's, and
# nothing in the suite runs either. `git` is the other way round — the test
# container installs it for tests/test_no_conflict_markers.py, and the image has
# no use for it.
RUNTIME_ONLY = {"curl", "gosu"}
TEST_ONLY = {"git"}

# `apt-get install -y --no-install-recommends` followed by the packages: a
# backslash-continued block in the Dockerfile, a single `;`-terminated command in
# the workflows. One expression reads both, and the package list is whatever
# stands between the flags and the end of that command.
INSTALL = re.compile(
    r"apt-get install -y --no-install-recommends\s+(.*?)(?:&&|;|$)", re.S)


def packages(path):
    """Every package named by the one such install command in `path`.

    ONE, asserted rather than assumed: a second `apt-get install` — a build stage
    of its own in the Dockerfile, a tool added to the workflow's step — would
    otherwise make this file compare whichever came first and go on looking like
    it was comparing the kernel's libraries.
    """
    text = path.read_text()
    # Whole comment lines go before the match, not tokens starting with `#`
    # after it: the Dockerfile writes prose ABOVE its install and this file's
    # own continuation lines are commented in places, and a word from a comment
    # counted as a package is a failure that reads like drift.
    stripped = "\n".join(line for line in text.splitlines()
                         if not line.lstrip().startswith("#"))
    found = INSTALL.findall(stripped)
    assert len(found) == 1, (
        f"{path.name}: expected exactly one `apt-get install -y "
        f"--no-install-recommends`, found {len(found)}. Two of them and this "
        f"comparison silently describes the wrong one — name the kernel's "
        f"libraries in a single command, or teach this test which one is which")
    # Continuations and newlines are separators like any other whitespace.
    return set(found[0].replace("\\", " ").split())


def test_the_image_and_the_test_container_install_the_same_kernel_libraries():
    """One list, two places, equal apart from the two named exceptions.

    Asserted as sets with the exceptions subtracted rather than by comparing the
    text: the Dockerfile writes one package per line for the sake of the diff,
    the workflows write them on one line because that command is also what a
    developer runs by hand, and neither spelling is the one to standardise on.
    """
    image = packages(DOCKERFILE) - RUNTIME_ONLY
    # Two guards against the whole test passing vacuously: the day somebody
    # rewrites the Dockerfile's install into a form the expression above does not
    # match, and the day the loop below iterates over nothing.
    assert "libgl1" in image, (
        "the Dockerfile no longer installs libgl1 by a line this test can read; "
        "`import cadquery` fails without it, so check the install command rather "
        "than this expectation")
    missing = [path.name for path in WORKFLOWS if not path.is_file()]
    assert not missing, (
        f"the workflows this file compares are not where it looks for them: "
        f"{missing}. Renamed or moved, the loop below would compare nothing — "
        f"point it at the new paths rather than deleting the row")
    for workflow in WORKFLOWS:
        suite = packages(workflow) - TEST_ONLY
        assert suite == image, (
            f"{workflow.name}: the test container and the image install "
            f"different kernel libraries. Only in the image: "
            f"{sorted(image - suite)}; only in the test container: "
            f"{sorted(suite - image)}. The image is the environment the code "
            f"ships into and the suite has to run in the same one — keep the "
            f"two lists in step, and read the Dockerfile for why each library "
            f"is on the list")
