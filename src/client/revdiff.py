"""`hammerola diff` — what changed between two revisions, in geometry and in code.

TWO QUESTIONS, AND THEY ARE NOT THE SAME QUESTION. "The volume dropped 3.5% and
the bbox is 2 mm shorter" is what a person wants to know about a part; "line 61
changed from 30 to 28" is why. Either one alone leaves the other to be guessed
at, and guessing wrong is how an afternoon goes, so this prints both — the
measurements first, because it is the shorter answer and the one being asked, and
the source diff under it as the explanation.

NEITHER HALF IS COMPUTED HERE. The measurements come out of `metrics.json`, which
the build wrote and the hub serves from the build directory, and the comparison
is `src/metricsdiff.metrics_diff` — the same function the build itself prints
after every run. It is imported rather than reimplemented, and that is the whole
point of it having been moved out of `src/cadbuild/metrics.py`: two readers of one
file, one implementation, nothing to drift. (`cad_publish/hubspec.py` is what a
second copy looks like a year later, and it is why publication broke.)

The source diff is `difflib` over the two stored archives, which is possible at
all only because the hub keeps a revision's code now (SPEC 7.8). Before that this
command could have answered the first question and not the second.

THE TWO HALVES COME FROM DIFFERENT SIDES OF THE TOKEN, and that shows up here as
two kinds of request: `metrics.json` is fetched from the public build directory,
the archives from `/api/v1/sources/<revision>` under the publishing secret. It is
the same split `artifacts` and `source` are two verbs over.
"""

import difflib
import json

from src.client import project, unpack
from src.client.errors import ClientError
from src.client.sources import SHORT_ID_CHARS, hub_for, resolve_revision
from src.metricsdiff import METRICS_NAME, metrics_diff, unchanged_code_moved_geometry


def run(args) -> int:
    """Print what moved between two revisions. -> exit code."""
    # A project is REQUIRED here, unlike in `source`: metrics.json lives in the
    # build directory, which is addressed by `<pid>/<revision>`, so there is no
    # way to ask for it without knowing whose build it is.
    root = project.find_project_root(args.directory)
    pid = project.read_project_id(root)
    hub = hub_for(root)

    old = resolve_revision(hub, root, args.old)
    new = resolve_revision(hub, root, args.new)
    if old == new:
        # Not an error: `hammerola diff <rev> latest` is exactly how somebody
        # asks "is latest still that one", and the answer "yes" is useful.
        print(f"{old} and {new} are the same revision — nothing to compare.")
        return 0

    print(f"{pid}: {old[:SHORT_ID_CHARS]} -> {new[:SHORT_ID_CHARS]}")
    print(f"  {old}\n  {new}")

    before, after = _metrics(hub, pid, old), _metrics(hub, pid, new)
    print()
    _print_geometry(before, after)
    print()
    _print_code(hub, old, new)
    return 0


def _metrics(hub, pid: str, revision: str):
    """One revision's metrics.json, or None when that build shipped none.

    None rather than a refusal: a build published before the model wrote metrics
    — or one whose gate ran without them — is an ordinary thing to run into, and
    it costs the geometry half of the answer rather than the whole command.
    """
    body = hub.build_file(pid, revision, METRICS_NAME)
    if body is None:
        return None
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        # `RecursionError` BESIDE THE VALUE ERRORS, for the same reason as in
        # `hub._payload`: `json.loads` recurses per nesting level, so a body of
        # `[[[[...]]]]` raises it rather than a `ValueError`, and 400 kB of
        # brackets is nothing against the reply ceiling. This body comes off the
        # wire like any other, and uncaught it left the command as a traceback.
        return None
    return payload if isinstance(payload, dict) else None


def _print_geometry(before, after) -> None:
    print("geometry:")
    missing = [name for name, value in (("the older", before), ("the newer", after))
               if value is None]
    if missing:
        print(f"  {' and '.join(missing)} revision published no {METRICS_NAME}, "
              f"so there is nothing to compare.")
        return
    lines = metrics_diff(before, after)
    if not lines:
        print("  every measured number is the same.")
    for line in lines:
        print(f"  {line}")

    # Last, and after the numbers it is a conclusion about. It reads the hash of
    # the root *.py with comments stripped, so a rewritten comment does not
    # raise it — when it fires, the same model source built into a different
    # solid and the cause is outside the source.
    shifted = unchanged_code_moved_geometry(before, after)
    if shifted:
        print(f"  ! the geometry moved while the model's code did not "
              f"({', '.join(shifted)}).")
        print("    The same source built into a different solid: compare the "
              "CAD stack the two")
        print("    builds ran on, or the model is not deterministic.")


def _print_code(hub, old: str, new: str) -> None:
    print("code:")
    before = unpack.read_members(hub.revision_archive(old),
                                 where=f"the code of {old}")
    after = unpack.read_members(hub.revision_archive(new),
                                where=f"the code of {new}")

    printed = False
    for name in sorted(set(before) | set(after)):
        block = _one_file(name, before.get(name), after.get(name), old, new)
        if block:
            printed = True
            for line in block:
                print(f"  {line}")
    if not printed:
        # Impossible for two DIFFERENT revisions — the id is the digest of the
        # sources (SPEC 7.7), so distinct ids mean distinct trees — which is why
        # it is said out loud rather than passed over: seeing it means one of
        # those two things is not what it claims to be.
        print("  no difference, which two different revisions cannot have: "
              "their ids are the")
        print("  digests of these trees. Something served one revision's code "
              "under the other's name.")


def _one_file(name: str, old_body, new_body, old: str, new: str) -> list:
    """The diff of one member, as lines. Empty when it did not change."""
    if old_body == new_body:
        return []
    if old_body is None:
        return [f"+ {name}  (added, {len(new_body)} bytes)"]
    if new_body is None:
        return [f"- {name}  (removed, was {len(old_body)} bytes)"]

    before, after = _text(old_body), _text(new_body)
    if before is None or after is None:
        # A .step or a .png in `ref/`. There is nothing useful to print about
        # the bytes, and printing them would fill a terminal with a file nobody
        # can read anyway.
        return [f"~ {name}  (changed, not text: "
                f"{len(old_body)} -> {len(new_body)} bytes)"]

    lines = list(difflib.unified_diff(
        before, after,
        fromfile=f"{old[:SHORT_ID_CHARS]}/{name}",
        tofile=f"{new[:SHORT_ID_CHARS]}/{name}",
        lineterm=""))
    # Two files can differ in bytes and not in decoded lines — a trailing
    # newline, a CRLF rewrite. Saying so is more useful than printing nothing
    # about a file the digest says changed.
    return lines or [f"~ {name}  (changed in bytes only: line endings or a "
                     f"trailing newline)"]


def _text(body: bytes):
    """The file as lines, or None when it is not text.

    Two rules, and the second is the one that is easy to leave out. Strict utf-8
    rather than `errors="replace"`, because a replaced byte is a change the diff
    would then either show as noise or hide. And a NUL anywhere means binary
    whatever the decoder says — this is git's own heuristic, and it is here for a
    concrete reason: plenty of binary formats are accidentally valid UTF-8 (every
    byte under 0x80 is), so decoding alone would happily print a mesh into
    somebody's terminal, control characters and all.
    """
    if b"\0" in body:
        return None
    try:
        return body.decode("utf-8").splitlines(keepends=True)
    except UnicodeDecodeError:
        return None
