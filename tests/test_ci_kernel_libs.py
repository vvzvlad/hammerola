"""The test image and the shipped image install the SAME kernel libraries.

`import cadquery` needs libGL, libX11 and libexpat from outside the wheel — the
derivation is in the Dockerfile and belongs there, not here. What this file
guards is that the two places which install them cannot drift apart: the shipped
image's `RUN apt-get install` and the one in `ci/Dockerfile.test`, the image both
workflows run the suite in.

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
TEST_DOCKERFILE = ROOT / "ci" / "Dockerfile.test"

# The shipped image's own runtime tools, on its line and deliberately not in the
# test one: `curl` is the healthcheck's, `gosu` the entrypoint's, and nothing in
# the suite runs either. `git` is the other way round — the test image installs it
# for tests/test_no_conflict_markers.py, and the shipped one has no use for it.
RUNTIME_ONLY = {"curl", "gosu"}
TEST_ONLY = {"git"}

# `apt-get install -y --no-install-recommends` followed by the packages, a
# backslash-continued block in both files, so the package list is whatever stands
# between the flags and the `&&` that ends that command.
INSTALL = re.compile(
    r"apt-get install -y --no-install-recommends\s+(.*?)(?:&&|$)", re.S)


def packages(path):
    """Every package named by the one such install command in `path`.

    ONE, asserted rather than assumed: a second `apt-get install` — a build stage
    of its own in the Dockerfile, a tool added to the test image — would
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


def test_the_two_images_install_the_same_kernel_libraries():
    """One list, two files, equal apart from the two named exceptions.

    Asserted as sets with the exceptions subtracted rather than by comparing the
    text: both files write one package per line for the sake of the diff, but the
    order and the indentation are each file's own business and neither is worth a
    failure.

    A path that moved fails loudly here rather than vacuously — `packages()` reads
    the file, so a missing one raises — and the libgl1 row is the guard for the
    other way of checking nothing: an install command rewritten into a shape the
    expression cannot read.
    """
    image = packages(DOCKERFILE) - RUNTIME_ONLY
    assert "libgl1" in image, (
        "the Dockerfile no longer installs libgl1 by a line this test can read; "
        "`import cadquery` fails without it, so check the install command rather "
        "than this expectation")
    suite = packages(TEST_DOCKERFILE) - TEST_ONLY
    assert suite == image, (
        f"ci/Dockerfile.test and the shipped image install different kernel "
        f"libraries. Only in the image: {sorted(image - suite)}; only in the "
        f"test image: {sorted(suite - image)}. The image is the environment the "
        f"code ships into and the suite has to run in the same one — keep the "
        f"two lists in step, and read the Dockerfile for why each library is on "
        f"the list")
