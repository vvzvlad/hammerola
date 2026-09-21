"""The two halves of `meta.json`, checked against each other for real.

THE DOCUMENT HAS ONE WRITER AND ONE VALIDATOR AND THEY LIVE IN DIFFERENT
WORLDS. `src/cadbuild/build.py` writes it at the end of a build; `src/render.py`
reads it on the way in and rebuilds it for the viewer. Every other test of
either half hands the other half's work over BY HAND — `tests/harness.py`
writes a meta.json and a stand-in view file that agree because one function
wrote both, and `tests/cadbuild/` reads what the build produced without ever
asking whether the hub would take it. Two hand-written documents agreeing with
each other is exactly the shape of the failure that broke publication once
already: the client packed one thing and the hub expected another, and no test
could see both because the halves lived in two repositories.

Issue #75 moved the seam. `parts()` became a CATALOGUE keyed by part name and
`views[].parts` became the LIST OF KEYS a view shows, and the hub now holds
that list against the view file's own leaves in both directions
(`render._match_selection`). That is a claim about a document the hub does not
write, checked against a document the build does not read — so nothing but a
real build feeding a real validator can say whether the two agree. This file is
that, and it is deliberately the ONLY test here that does no hand-writing at
all: the model is written, and everything the assertions look at is computed
from it by the same code a push runs.

IT SKIPS WHERE THE CAD KERNEL DOES NOT IMPORT, which is no longer CI: the test
image carries the kernel's libraries (issue #27), so the pairing is verified
on every push. On a machine without the kernel it still skips, and there the two
halves are each checked against a hand-written stand-in of the other.
"""

from __future__ import annotations

import json
import textwrap
from pathlib import Path

import pytest

from src import render, store
from src.buildproc import run_build
from src.buildproc.limits import DEFAULT_LIMITS, memory_limit_supported
from src.buildproc.runner import STATUS_OK

PID = "abc123def456"

# The production ceilings, less the one macOS cannot apply — the same derivation
# `tests/test_template.py` makes and for the same measured reason: Darwin refuses
# RLIMIT_AS at every value, so a workstation would report `limits_error` before
# the build started and the failure would say nothing about this pairing.
BUILD_LIMITS = (DEFAULT_LIMITS if memory_limit_supported()
                else DEFAULT_LIMITS.replace(memory_bytes=None))

# TWO PARTS OF DIFFERENT KINDS AND TWO VIEWS SHOWING DIFFERENT SUBSETS, which is
# the smallest model that can disagree with itself in a way this file is here to
# catch. One part and one view would pass with the selection unread: every set
# comparison would be a comparison of two one-element sets that any bug making
# them both empty would satisfy. The boxes are placed apart so the gate's
# interference and coverage checks have nothing to say — the geometry is not
# what is under test, and a gate failure here would read as a broken hub.
MODEL = """
    import cadquery as cq


    def parts():
        return {
            "lid": {"shape": cq.Workplane("XY").box(20, 10, 4),
                    "kind": "printable"},
            "screw": {"shape": cq.Workplane("XY").box(4, 4, 12).translate((40, 0, 0)),
                      "kind": "hardware"},
        }


    def views():
        return [
            {"id": "assembled", "name": "assembled", "parts": ["lid", "screw"]},
            {"id": "print", "name": "as printed", "parts": ["lid"]},
        ]
"""


@pytest.fixture
def built(tmp_path):
    """Run the real build, and hand back what the hub would have to publish.

    `run_build` rather than `cadbuild.build()` called in this process, because
    that is the entry point `src/jobs.py` takes on the push path: the spawned
    interpreter, the ceilings, the OCCT cap, the gate, the exports and the
    tessellation, in that order.
    """
    pytest.importorskip(
        "cadquery", exc_type=ImportError,
        reason="the CAD kernel does not import in this interpreter, so no real "
               "build can be run to pair its meta.json with the hub — see the "
               "module docstring for what skipping it costs")

    project = tmp_path / "project"
    project.mkdir()
    (project / "project.json").write_text(
        json.dumps({"id": PID, "title": "Pairing test box"}), encoding="utf-8")
    (project / "model.py").write_text(textwrap.dedent(MODEL), encoding="utf-8")

    out = tmp_path / "out"
    outcome = run_build(project, out, pid=PID, limits=BUILD_LIMITS)
    assert outcome.status == STATUS_OK, (
        f"the model this file is built on no longer builds ({outcome.status}), "
        f"so nothing below is a statement about the pairing. Its whole log:\n"
        f"{outcome.log}")
    return out, outcome


def _publish(out: Path, outcome) -> dict:
    """Everything `Store._finish_staging` does to a meta.json, and nothing else.

    The two arguments the validator cannot be given by hand are assembled the
    way the store assembles them: `files` is `_hash_output` over the names the
    build DECLARED (the only mapping `build_meta` consults about whether a
    declared file exists), and the raw document is read off disk rather than
    reconstructed.
    """
    raw = json.loads((out / "meta.json").read_text(encoding="utf-8"))
    files = store._hash_output(out, outcome.files)
    return render.build_meta(
        pid=PID, commit="abc123", raw=raw, staging=out, files=files,
        published="2026-09-01T00:00:00Z")


def test_a_real_build_s_meta_is_one_the_hub_accepts(built):
    """The whole point: the build's own document, through the real validator.

    A `ValueError` out of `build_meta` is a 422 on the push route, so a failure
    here is a model that builds and cannot be published — the exact silence
    two hand-written halves cannot detect.
    """
    out, outcome = built
    meta = _publish(out, outcome)

    assert meta["pid"] == PID
    assert sorted(meta["parts"]) == ["lid", "screw"]
    assert meta["parts"]["lid"]["kind"] == "printable"
    assert meta["parts"]["screw"]["kind"] == "hardware"
    assert [view["id"] for view in meta["views"]] == ["assembled", "print"]


def test_the_selection_the_build_wrote_is_the_one_its_view_files_show(built):
    """`views[].parts` against the view files, both directions — for real.

    This is the assertion the file exists for. `export_views` names the field
    off the nodes it has just tessellated
    (`list(dict.fromkeys(node["key"] for node in nodes))`) and the hub demands
    SET EQUALITY with the keys its own walk finds in the file. The two are
    written and read by code that never meets, so agreeing here is evidence and
    agreeing in `tests/harness.py` is not.

    The expected selections are named rather than read back out of the meta,
    which would be the document agreeing with itself. They are what `views()`
    in MODEL asks for.
    """
    out, outcome = built
    meta = _publish(out, outcome)
    catalogue = meta["parts"]

    selections = {view["id"]: view for view in meta["views"]}
    assert set(selections["assembled"]["parts"]) == {"lid", "screw"}
    assert set(selections["print"]["parts"]) == {"lid"}

    for view in meta["views"]:
        shown = render.check_view_file(
            out / view["file"], view["id"], catalogue)
        assert shown == set(view["parts"]), (
            f"view {view['id']!r} declares {sorted(view['parts'])} and its file "
            f"shows {sorted(shown)} — the build and the hub disagree about what "
            f"a view's `parts` names")


def test_every_leaf_a_real_export_writes_carries_a_key(built):
    """The rule that refuses a push, asserted against what a build really writes.

    The hub refuses a leaf with no `key` (issue #75): a node with nothing under
    it and no key makes `views[].parts` an unsigned promise. That is a rule
    about a document the exporter produces, so it is worth one assertion that
    reads the file directly rather than through the validator — the validator
    passing proves the rule was satisfied, and this says WHERE, so a future
    exporter that starts nesting its leaves fails with something legible.
    """
    out, outcome = built
    meta = _publish(out, outcome)

    for view in meta["views"]:
        document = json.loads(
            (out / view["file"]).read_text(encoding="utf-8"))
        leaves = list(_leaves(document))
        assert leaves, f"view {view['id']!r} exported no leaves at all"
        for leaf in leaves:
            assert leaf.get("key") in meta["parts"], (
                f"a leaf named {leaf.get('name')!r} in view {view['id']!r} names "
                f"no catalogue record")


def _leaves(node):
    """Every node with nothing under it — the hub's own leaf/group test.

    `parts` is what decides it, here and in `render.check_view_file` and in the
    vendored viewer (`isShapeTree(shape) { return "parts" in shape; }`). Written
    out a third time rather than imported because the point is that all three
    ask the same question — which means asking it the same way: the PRESENCE of
    the field, never `is None`, since a null `parts` is a group to the viewer
    and reading it as a leaf is how a build publishes and never opens.
    """
    if "parts" not in node:
        yield node
        return
    for child in node["parts"]:
        yield from _leaves(child)
