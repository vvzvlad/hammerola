"""`run_inspect` and `inspectchild`: one published view, pictured and measured
by a real process behind the wrapper.

The hub's tests stand a fake in for this (`harness.naming_inspector`); these
are the ones that run the child, on the real view document the browser loads
(`ui/tests/fixtures/assembled.json`). With no STEP beside it, every pair is
measured on the mesh, so neither test needs the CAD kernel.
"""

import shutil
from pathlib import Path

import pytest

from src.buildproc import (INSPECT_MEASURE, INSPECT_SNAPSHOT, STATUS_FAILED,
                           STATUS_OK, run_inspect)

from probes import BUILD_LIMITS, import_works

FIXTURE = (Path(__file__).resolve().parents[2] / "ui" / "tests" / "fixtures"
           / "assembled.json")

pytestmark = pytest.mark.skipif(
    not import_works("src.cadbuild.measure"),
    reason="the renderer's stack does not import in this interpreter")


@pytest.fixture
def build(tmp_path):
    directory = tmp_path / "build"
    directory.mkdir()
    shutil.copy(FIXTURE, directory / "assembled.json")
    return directory


def test_a_snapshot_writes_its_picture_where_it_was_told(build, tmp_path):
    out = tmp_path / "job" / "snapshot.png"
    out.parent.mkdir()

    outcome = run_inspect(build, pid="p", kind=INSPECT_SNAPSHOT,
                          view="assembled", angle="top", hide=("post",),
                          out=out, limits=BUILD_LIMITS)

    assert outcome.status == STATUS_OK, outcome.log
    assert outcome.files == ("snapshot.png",)
    assert out.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    assert "view assembled, angle top, hidden: post" in outcome.log


def test_a_measurement_prints_its_answer_and_a_refusal_is_a_failure(build):
    outcome = run_inspect(build, pid="p", kind=INSPECT_MEASURE,
                          view="assembled", parts=("plate", "reference_spacer"),
                          limits=BUILD_LIMITS)
    assert outcome.status == STATUS_OK, outcome.log
    assert "method: the view's mesh -- plate and reference_spacer are not " \
           "printable" in outcome.log
    assert "distance: " in outcome.log

    refused = run_inspect(build, pid="p", kind=INSPECT_MEASURE, view="print",
                          parts=("plate", "post"), limits=BUILD_LIMITS)
    assert refused.status == STATUS_FAILED
    assert "this revision has no view 'print'" in refused.log
