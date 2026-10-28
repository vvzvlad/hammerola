"""`snapshot` and `measure`, against a real hub over a real socket.

The hub's runner is the suite's stand-in (`harness.naming_inspector`): its log
and its picture repeat what it was asked, so what is pinned here is the
client's half -- what goes on the wire for each flag, where the picture lands,
and that a refusal arrives as the hub's own sentence.
"""

import pytest
from harness import FAKE_PNG
from modeldir import make_model, publish_model

from hammerola import revinspect, sources
from hammerola.cli import build_parser, main

pytestmark = pytest.mark.usefixtures("configured")


def run(model, *args):
    return main(["-C", str(model), *args])


@pytest.fixture
def model(tmp_path):
    return make_model(tmp_path / "demo")


def test_a_snapshot_lands_under_the_scratch_directory_and_says_where(
        hub, model, capsys):
    revision = publish_model(hub, model)

    assert run(model, "snapshot", revision, "--angle", "top",
               "--hide", "pin", "--hide", "lid") == 0

    out = capsys.readouterr().out
    short = revision[:sources.SHORT_ID_CHARS]
    landed = (model / sources.SCRATCH_DIR / revinspect.SNAPSHOT_DIR
              / f"{short}-assembled-top.png").resolve()
    assert landed.read_bytes() == FAKE_PNG + (
        f"{revision} view assembled angle top hide pin,lid parts ").encode()
    assert f"wrote {landed}" in out
    assert "snapshot: " in out


def test_output_takes_the_picture_elsewhere_and_dev_is_a_build_too(
        hub, model, tmp_path, capsys):
    publish_model(hub, model, "dev")
    dest = tmp_path / "pictures" / "lid.png"

    assert run(model, "snapshot", "dev", "--angle=-30,45",
               "-o", str(dest)) == 0
    assert dest.read_bytes() == FAKE_PNG + (
        b"dev view assembled angle -30,45 hide  parts ")


def test_measure_prints_the_hub_s_answer(hub, model, capsys):
    revision = publish_model(hub, model)

    assert run(model, "measure", revision, "lid", "pin",
               "--view", "assembled") == 0
    assert (f"measure: {revision} view assembled angle None hide  "
            f"parts lid,pin") in capsys.readouterr().out


def test_a_part_the_view_does_not_show_is_refused_in_the_hub_s_words(
        hub, model, capsys):
    revision = publish_model(hub, model)

    assert run(model, "measure", revision, "lid", "bolt") == 1
    assert "its parts are lid, pin" in capsys.readouterr().err


@pytest.mark.parametrize("angle", ["sideways", "30", "30,", "nan,0"])
def test_an_angle_the_hub_would_refuse_is_refused_before_anything_is_sent(
        angle, capsys):
    with pytest.raises(SystemExit) as stopped:
        build_parser().parse_args(["snapshot", "latest", f"--angle={angle}"])
    assert stopped.value.code == 2
    assert "ELEV,AZIM" in capsys.readouterr().err


def test_the_default_angle_is_the_isometric_one():
    args = build_parser().parse_args(["snapshot", "latest"])
    assert (args.angle, args.view, args.hide, args.output) == (
        "iso", None, None, None)
