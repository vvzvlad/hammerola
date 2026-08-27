"""`source`, `artifacts`, `log` and `diff`, against a real hub over a real socket.

THE SAME REASON `test_publishing.py` GIVES, pointed at the four verbs that READ.
Each of them stands on a contract with the other half — which route serves what,
behind which secret, in which shape — and the way that contract broke last time
was two suites each staying green about their own side of it. So every test here
drives `cli.main` with argv and looks at what came back or what landed on the
disk, at a hub started by `harness.start_hub`.

WHAT IS BEING PINNED, beyond "it works":

  * `source` unpacks into a directory of its own, and the one that lands there
    by DEFAULT is hidden — a fetched tree beside model.py is a tree the next
    push would publish;
  * `artifacts` reaches for the PUBLIC build files while `source` reaches for
    the code behind the secret. The split is the reason there are two verbs;
  * `log dev` is the address the hub cannot answer, and it says so rather than
    quietly answering with `latest`'s log, which would be a different build;
  * `diff` answers both halves of the question — what the geometry did, and what
    the source did — and the geometry half runs through the very function the
    build itself prints with.
"""

import json
import tarfile

import pytest
from harness import TOKEN, meta_bytes, view_bytes
from modeldir import git, git_repo, make_model

from src.client import sources
from src.client.cli import main


@pytest.fixture(autouse=True)
def configured(monkeypatch, hub):
    monkeypatch.setenv("HUB_URL", hub.url)
    monkeypatch.setenv("EDIT_TOKEN", TOKEN)


def run(model, *args):
    return main(["-C", str(model), *args])


def metrics_bytes(volume=1000.0, faces=6, code="cc", parts=("body",)):
    """A metrics.json in the shape `cadbuild.metrics` writes (SPEC §8, entry 26).

    Written into the model directory because the suite's stand-in builder
    publishes the pushed tree unchanged — so this is what a real build's
    metrics.json would be, arriving by a shorter road.
    """
    measured = {name: {"volume_mm3": volume, "bbox_mm": [10.0, 10.0, 10.0],
                       "faces": faces, "solids": 1, "watertight": True}
                for name in parts}
    return json.dumps({
        "version": 1, "project": "demo", "built": "2026-08-27T00:00:00Z",
        "source": {"files": "ff", "code": code},
        "parts": measured,
        "assembly": {"interference_mm3": {}},
        "checks_passed": 3,
    }).encode("utf-8")


def with_downloads(root, **kw):
    """A model directory whose meta.json declares printable artefacts."""
    model = make_model(root, **kw)
    (model / "body.stl").write_bytes(b"solid body\nendsolid body\n")
    (model / "body.step").write_bytes(b"ISO-10303-21;\n")
    (model / "meta.json").write_bytes(meta_bytes(
        downloads={"stl": "body.stl", "step": "body.step"}))
    return model


def publish(model, capsys, *args):
    """`hammerola commit` and the revision it printed."""
    assert run(model, "commit", *args) == 0
    out = capsys.readouterr().out
    for line in out.splitlines():
        if line.startswith("revision "):
            return line.split()[1].rstrip(":")
    raise AssertionError(f"no revision in the output:\n{out}")


# -- source ------------------------------------------------------------------
def test_source_brings_the_tree_back_into_a_directory_of_its_own(hub, model,
                                                                 capsys):
    revision = publish(model, capsys)
    (model / "model.py").write_text("# moved on since\n")

    assert run(model, "source", revision) == 0
    out = capsys.readouterr().out

    fetched = model / sources.SCRATCH_DIR / f"source-{revision[:12]}"
    assert (fetched / "model.py").read_text().startswith("import cadquery")
    assert (fetched / "project.json").is_file()
    # The working copy is exactly as it was: this command does not restore.
    assert (model / "model.py").read_text() == "# moved on since\n"
    assert str(fetched) in out


def test_the_default_directory_is_one_the_next_push_cannot_pick_up(hub, model,
                                                                   capsys):
    """A fetched tree beside model.py would be published by the next `commit` —
    a source tree carrying a copy of an older source tree. `pack` drops hidden
    entries, so a dot directory is excluded by a rule that already exists."""
    revision = publish(model, capsys)
    assert run(model, "source", revision) == 0
    capsys.readouterr()

    # The digest is over the members, so an unchanged tree republishes as the
    # same revision — which is the observable form of "nothing was added".
    assert publish(model, capsys) == revision

    # And git is not offered the fetched tree either: the scratch directory
    # ignores itself, so `git add -A` in the suggested commit stages nothing.
    assert (model / sources.SCRATCH_DIR / ".gitignore").read_text().endswith("*\n")


def test_source_refuses_a_directory_with_something_in_it(hub, model, capsys,
                                                         tmp_path):
    revision = publish(model, capsys)
    busy = tmp_path / "busy"
    busy.mkdir()
    (busy / "keep.txt").write_text("mine")

    assert run(model, "source", revision, "-o", str(busy)) == 1
    assert "already has something in it" in capsys.readouterr().err
    assert (busy / "keep.txt").read_text() == "mine"


def test_source_takes_an_output_directory(hub, model, capsys, tmp_path):
    revision = publish(model, capsys)
    where = tmp_path / "elsewhere"

    assert run(model, "source", revision, "-o", str(where)) == 0
    assert (where / "model.py").is_file()


def test_source_resolves_latest(hub, model, capsys):
    publish(model, capsys)
    (model / "model.py").write_text("# second revision\n")
    second = publish(model, capsys)

    assert run(model, "source", "latest") == 0
    capsys.readouterr()
    fetched = model / sources.SCRATCH_DIR / f"source-{second[:12]}"
    assert (fetched / "model.py").read_text() == "# second revision\n"


def test_source_is_the_body_that_was_pushed(hub, model, capsys):
    """Byte for byte, which is what makes it the code that built the revision
    rather than a repacking of it (SPEC 7.8)."""
    revision = publish(model, capsys)
    assert run(model, "source", revision, "-o", str(model.parent / "out")) == 0
    capsys.readouterr()

    stored = (hub.data / "sources" / revision / "source.tar.gz").read_bytes()
    with tarfile.open(fileobj=__import__("io").BytesIO(stored), mode="r:gz") as tar:
        names = sorted(m.name for m in tar.getmembers() if m.isfile())
    written = sorted(
        str(p.relative_to(model.parent / "out"))
        for p in (model.parent / "out").rglob("*") if p.is_file())
    assert written == names


def test_source_into_the_working_copy_needs_a_clean_repository(hub, model,
                                                               capsys):
    revision = publish(model, capsys)

    # No git at all: nothing could undo this, so it is refused.
    assert run(model, "source", revision, "--into-working-copy") == 1
    assert "not a git repository" in capsys.readouterr().err

    git_repo(model)
    (model / "model.py").write_text("# uncommitted\n")
    assert run(model, "source", revision, "--into-working-copy") == 1
    err = capsys.readouterr().err
    assert "uncommitted changes" in err
    assert (model / "model.py").read_text() == "# uncommitted\n"


def test_source_into_a_clean_working_copy_restores_the_revision(hub, model,
                                                                capsys):
    revision = publish(model, capsys)
    git_repo(model)
    (model / "model.py").write_text("# a later idea\n")
    (model / "extra.py").write_text("GONE = 1\n")
    git(model, "add", "-A")
    git(model, "commit", "-q", "-m", "later work")

    assert run(model, "source", revision, "--into-working-copy") == 0
    out = capsys.readouterr().out

    assert (model / "model.py").read_text().startswith("import cadquery")
    # Tracked by git and not in the revision, so it goes — and git can put it
    # back, which is the only reason removing anything is allowed here.
    assert not (model / "extra.py").exists()
    assert "extra.py" in out
    assert git(model, "status", "--porcelain").stdout.strip()


def test_source_into_the_working_copy_keeps_what_git_cannot_restore(hub, model,
                                                                    capsys):
    """A gitignored file is not recoverable, so no flag may delete it."""
    revision = publish(model, capsys)
    (model / ".gitignore").write_text("secrets.txt\n")
    git_repo(model)
    (model / "secrets.txt").write_text("not in git")

    assert run(model, "source", revision, "--into-working-copy") == 0
    out = capsys.readouterr().out
    assert (model / "secrets.txt").read_text() == "not in git"
    assert "secrets.txt" in out and "left alone" in out


def test_source_of_something_the_hub_does_not_have(hub, model, capsys):
    publish(model, capsys)
    assert run(model, "source", "f" * 64) == 1
    assert "no stored code" in capsys.readouterr().err


def test_source_with_the_wrong_secret_says_which_command_fixes_it(hub, model,
                                                                  capsys,
                                                                  monkeypatch):
    revision = publish(model, capsys)
    monkeypatch.setenv("EDIT_TOKEN", "not-the-token")
    assert run(model, "source", revision) == 1
    err = capsys.readouterr().err
    assert "401" in err and "hammerola login" in err


def test_source_will_not_fetch_the_dev_slot(hub, model, capsys):
    """`dev` is a slot, not a revision: the hub stores neither its code nor its
    log, on purpose (SPEC 7.8)."""
    assert run(model, "build") == 0
    capsys.readouterr()
    assert run(model, "source", "dev") == 1
    assert "not a revision" in capsys.readouterr().err


# -- artifacts ---------------------------------------------------------------
def test_artifacts_brings_back_what_the_build_declared(hub, tmp_path, capsys):
    model = with_downloads(tmp_path / "demo")
    revision = publish(model, capsys)

    assert run(model, "artifacts", revision) == 0
    out = capsys.readouterr().out

    fetched = model / sources.SCRATCH_DIR / f"artifacts-{revision[:12]}"
    assert (fetched / "body.stl").read_bytes() == b"solid body\nendsolid body\n"
    assert (fetched / "body.step").is_file()
    assert "body.stl" in out
    # The viewer payload is NOT an artefact and is not fetched: it is megabytes
    # of tessellation nothing outside the browser has a use for.
    assert not (fetched / "assembled.json").exists()


def test_artifacts_reads_the_public_route_and_source_does_not(hub, tmp_path,
                                                              capsys):
    """The two verbs exist because the rights differ. The build's files are
    served to anybody with the URL; the code is not."""
    model = with_downloads(tmp_path / "demo")
    revision = publish(model, capsys)

    assert hub.get(f"/project/demo0001/{revision}/body.stl").status_code == 200
    assert hub.get(f"/api/v1/sources/{revision}").status_code == 401


def test_artifacts_can_fetch_the_dev_slot(hub, tmp_path, capsys):
    """Unlike `source`: this asks a BUILD for its files, and the slot is one."""
    model = with_downloads(tmp_path / "demo")
    assert run(model, "build") == 0
    capsys.readouterr()

    assert run(model, "artifacts", "dev") == 0
    fetched = model / sources.SCRATCH_DIR / "artifacts-dev"
    assert (fetched / "body.stl").is_file()


def test_a_build_that_exported_nothing_says_so_and_succeeds(hub, model, capsys):
    """An empty `downloads` is a fact about the model, not a failure of the
    command."""
    revision = publish(model, capsys)
    assert run(model, "artifacts", revision) == 0
    assert "no downloadable artefacts" in capsys.readouterr().out


def test_artifacts_of_a_build_that_is_not_there(hub, model, capsys):
    publish(model, capsys)
    assert run(model, "artifacts", "f" * 64) == 1
    assert "no build" in capsys.readouterr().err


# -- log ---------------------------------------------------------------------
def test_log_without_an_argument_reads_the_newest_revision(hub, model, capsys):
    publish(model, capsys)
    assert run(model, "log") == 0
    out = capsys.readouterr().out
    assert "copying builder" in out
    assert "--- build log of " in out


def test_log_of_a_named_revision(hub, model, capsys):
    first = publish(model, capsys)
    (model / "model.py").write_text("# second\n")
    publish(model, capsys)

    assert run(model, "log", first) == 0
    out = capsys.readouterr().out
    assert first in out


def test_log_dev_says_the_hub_keeps_none_rather_than_answering_with_another(
        hub, model, capsys):
    """The one of the three addresses the hub cannot answer. Answering with
    `latest`'s log instead would be a different build's log under this one's
    name, which is worse than refusing."""
    publish(model, capsys)
    assert run(model, "build") == 0
    capsys.readouterr()

    assert run(model, "log", "dev") == 1
    err = capsys.readouterr().err
    assert "keeps no build log for the local slot" in err
    # It says where the log CAN be read, which is the point of refusing well.
    assert "hammerola build" in err and "jobs/<id>/log" in err


def test_log_of_a_revision_the_hub_never_published(hub, model, capsys):
    publish(model, capsys)
    assert run(model, "log", "f" * 64) == 1
    assert "no stored code" in capsys.readouterr().err


def test_log_needs_a_project_only_when_it_has_to_resolve_latest(hub, model,
                                                                capsys,
                                                                tmp_path):
    """A revision id is unique across the whole hub, so fetching one needs no
    project; `latest` is a pointer INSIDE a project and does."""
    revision = publish(model, capsys)
    elsewhere = tmp_path / "not-a-project"
    elsewhere.mkdir()

    assert main(["-C", str(elsewhere), "log", revision]) == 0
    assert "copying builder" in capsys.readouterr().out

    assert main(["-C", str(elsewhere), "log"]) == 1
    assert "no project.json" in capsys.readouterr().err


# -- diff --------------------------------------------------------------------
def test_diff_answers_both_questions(hub, tmp_path, capsys):
    model = make_model(tmp_path / "demo")
    (model / "metrics.json").write_bytes(metrics_bytes(volume=1000.0))
    first = publish(model, capsys)

    (model / "model.py").write_text("import cadquery as cq\n\nBOX = 12\n")
    (model / "metrics.json").write_bytes(metrics_bytes(volume=900.0, code="dd"))
    second = publish(model, capsys)

    assert run(model, "diff", first, second) == 0
    out = capsys.readouterr().out

    # The geometry half, through the same function the build prints with.
    assert "geometry:" in out
    assert "volume 1.00 -> 0.90 cm3" in out
    # The code half, which only became possible when the hub started keeping
    # sources (SPEC 7.8).
    assert "code:" in out
    assert "-import cadquery as cq" not in out       # unchanged first line
    assert "+BOX = 12" in out
    assert f"{first[:12]}/model.py" in out


def test_diff_names_a_file_that_appeared_and_one_that_went(hub, tmp_path,
                                                           capsys):
    model = make_model(tmp_path / "demo")
    first = publish(model, capsys)
    (model / "helper.py").write_text("HELP = 1\n")
    second = publish(model, capsys)

    assert run(model, "diff", first, second) == 0
    assert "+ helper.py" in capsys.readouterr().out

    assert run(model, "diff", second, first) == 0
    assert "- helper.py" in capsys.readouterr().out


@pytest.mark.parametrize("before,after", [
    # Not decodable at all: 0xff can never begin a UTF-8 sequence.
    (b"\xff\xfe mesh", b"\xff\xfe other mesh"),
    # Decodable and still binary — every byte here is a valid code point, which
    # is exactly why decoding alone is not the test. A NUL is git's heuristic
    # and it is the one that keeps a mesh out of somebody's terminal.
    (b"\x00\x01\x02", b"\x00\x01\x03\x04"),
])
def test_diff_does_not_print_a_binary_file_at_a_terminal(hub, tmp_path, capsys,
                                                         before, after):
    model = make_model(tmp_path / "demo", extra={"ref/part.bin": before})
    first = publish(model, capsys)
    (model / "ref" / "part.bin").write_bytes(after)
    second = publish(model, capsys)

    assert run(model, "diff", first, second) == 0
    out = capsys.readouterr().out
    assert "ref/part.bin" in out and "not text" in out
    assert after.decode("utf-8", "replace") not in out


def test_diff_says_when_the_measurements_are_missing(hub, model, capsys):
    """A build published before the model wrote metrics.json costs the geometry
    half of the answer, not the whole command."""
    first = publish(model, capsys)
    (model / "model.py").write_text("# changed\n")
    second = publish(model, capsys)

    assert run(model, "diff", first, second) == 0
    out = capsys.readouterr().out
    assert "published no metrics.json" in out
    assert "code:" in out


def test_diff_of_a_revision_against_itself_is_not_an_error(hub, model, capsys):
    """`hammerola diff <rev> latest` is how somebody asks whether latest is
    still that one, and "yes" is a useful answer."""
    revision = publish(model, capsys)
    assert run(model, "diff", revision, "latest") == 0
    assert "the same revision" in capsys.readouterr().out


def test_diff_raises_the_alarm_when_the_code_did_not_move_but_the_solid_did(
        hub, tmp_path, capsys):
    """The one line here that says something the numbers do not: the same model
    source built into a different solid."""
    model = make_model(tmp_path / "demo")
    (model / "metrics.json").write_bytes(metrics_bytes(volume=1000.0, code="cc"))
    first = publish(model, capsys)

    # The comment changes the tree (so it is a new revision) while the metrics
    # keep the same `source.code` hash — which is exactly the shape of "built
    # somewhere else" that the alarm is for.
    (model / "model.py").write_text("import cadquery as cq  # a comment\n")
    (model / "metrics.json").write_bytes(metrics_bytes(volume=1200.0, code="cc"))
    second = publish(model, capsys)

    assert run(model, "diff", first, second) == 0
    out = capsys.readouterr().out
    assert "the geometry moved while the model's code did not" in out
    assert "body" in out


def test_diff_needs_a_project_because_metrics_live_in_a_build_directory(
        hub, model, capsys, tmp_path):
    revision = publish(model, capsys)
    elsewhere = tmp_path / "not-a-project"
    elsewhere.mkdir()
    assert main(["-C", str(elsewhere), "diff", revision, "latest"]) == 1
    assert "project.json" in capsys.readouterr().err


def test_a_view_file_is_not_confused_for_an_artefact(hub, tmp_path, capsys):
    """`variants` and `downloads` are different lists with different jobs, and
    only one of them is what a person wants on their disk."""
    model = with_downloads(tmp_path / "demo")
    (model / "assembled.json").write_bytes(view_bytes("big"))
    revision = publish(model, capsys)

    assert run(model, "artifacts", revision) == 0
    fetched = model / sources.SCRATCH_DIR / f"artifacts-{revision[:12]}"
    assert sorted(p.name for p in fetched.iterdir()) == ["body.step", "body.stl"]
