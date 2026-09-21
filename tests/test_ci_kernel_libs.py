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
WORKFLOWS = sorted((ROOT / ".gitea" / "workflows").glob("*.yml"))

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


def packages(text):
    """Every package named by the first such install command in `text`."""
    match = INSTALL.search(text)
    assert match, "no `apt-get install -y --no-install-recommends` found"
    # Continuations and newlines are separators like any other whitespace.
    return {token for token in match.group(1).replace("\\", " ").split()
            if not token.startswith("#")}


def test_the_image_and_the_test_container_install_the_same_kernel_libraries():
    """One list, two places, equal apart from the two named exceptions.

    Asserted as sets with the exceptions subtracted rather than by comparing the
    text: the Dockerfile writes one package per line for the sake of the diff,
    the workflows write them on one line because that command is also what a
    developer runs by hand, and neither spelling is the one to standardise on.
    """
    image = packages(DOCKERFILE.read_text()) - RUNTIME_ONLY
    # A guard against the whole test passing vacuously the day somebody rewrites
    # the Dockerfile's install into a form the expression above does not match.
    assert "libgl1" in image, (
        "the Dockerfile no longer installs libgl1 by a line this test can read; "
        "`import cadquery` fails without it, so check the install command rather "
        "than this expectation")
    for workflow in WORKFLOWS:
        suite = packages(workflow.read_text()) - TEST_ONLY
        assert suite == image, (
            f"{workflow.name}: the test container and the image install "
            f"different kernel libraries. Only in the image: "
            f"{sorted(image - suite)}; only in the test container: "
            f"{sorted(suite - image)}. The image is the environment the code "
            f"ships into and the suite has to run in the same one — keep the "
            f"two lists in step, and read the Dockerfile for why each library "
            f"is on the list")
