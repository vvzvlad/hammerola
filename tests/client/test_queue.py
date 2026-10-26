"""`hammerola comments` and its `files` and `resolve`, against a real queue.

The comments here are POSTED THE WAY A VIEWER POSTS THEM — multipart, no token,
at a build the hub's own queue published a moment earlier — so what
the command prints is a record the hub validated, stored and read back, not a
fixture. That matters more here than anywhere else in this suite: the text comes
from a stranger's keyboard (SPEC 7A.4), and the reason it is safe to print is
that the hub already refused everything that would not be.

One secret, on both sides: the queue and the push check the same
`EDIT_TOKEN`.
"""

import json

import pytest
from harness import JPEG_BYTES, PNG_BYTES, TOKEN, comment_payload
from modeldir import make_model, publish_model

from hammerola import queue, sources
from hammerola.cli import main
from src import app, comments


@pytest.fixture
def hub(hub_factory, monkeypatch):
    """A hub running the way a deployment runs: one secret, and one
    variable to put it in."""
    instance = hub_factory()
    monkeypatch.setenv("HUB_URL", instance.url)
    monkeypatch.setenv("EDIT_TOKEN", TOKEN)
    return instance


def run(model, *args):
    return main(["-C", str(model), *args])


def publish_dev(hub, model):
    """Fill the draft slot with the model directory, which the comments are
    left on."""
    publish_model(hub, model, "dev")


def leave_comment(hub, model, pid="demo0001", commit="dev", **extra):
    """Post one comment the way the build page does, and return its id."""
    publish_dev(hub, model)
    reply = hub.post_comment(pid, commit, payload=comment_payload(**extra))
    assert reply.status_code == 201, reply.text
    return reply.json()["id"]


# -- reading -----------------------------------------------------------------
def test_the_queue_shows_what_is_really_in_it(hub, model, capsys):
    cid = leave_comment(hub, model)
    capsys.readouterr()

    assert run(model, "comments") == 0
    out = capsys.readouterr().out

    assert "1 comment on demo0001" in out
    # The id first, because it is the argument `resolve` takes.
    assert cid in out
    assert "the bracket fouls the standoff" in out
    assert "build dev" in out
    assert "part /root/bracket" in out
    assert "view assembled" in out
    assert "hammerola comments resolve" in out


def test_the_face_a_comment_was_left_on_is_printed(hub, model, capsys):
    leave_comment(hub, model, normal=[0.0, -1.0, 0.0])
    capsys.readouterr()

    assert run(model, "comments") == 0
    assert "at 1.0 2.0 3.5  facing 0.00 -1.00 0.00" in capsys.readouterr().out


def test_a_point_in_the_parts_frame_says_so(hub, model, capsys):
    leave_comment(hub, model, normal=[0.0, -1.0, 0.0], frame="part")
    capsys.readouterr()

    assert run(model, "comments") == 0
    assert ("at 1.0 2.0 3.5 (part coords)  facing 0.00 -1.00 0.00"
            in capsys.readouterr().out)


ON_SHEET = {"doc": "kicad/board.kicad_sch", "frame": "sheet",
            "sheet": "kicad/amp.kicad_sch", "area": [10, 20.5, 30, 4],
            "items": ["C502", "OUT_C", "R501"]}


@pytest.mark.parametrize("place, line", [
    (ON_SHEET,
     "build dev  doc kicad/board.kicad_sch  sheet kicad/amp.kicad_sch  "
     "area 10.0 20.5 30.0 4.0 mm  near C502, OUT_C, R501"),
    ({**ON_SHEET, "doc": "kicad/board.kicad_pcb", "frame": "board",
      "sheet": None, "layer": "F.Cu"},
     "build dev  doc kicad/board.kicad_pcb  layer F.Cu  "
     "area 10.0 20.5 30.0 4.0 mm  near C502, OUT_C, R501"),
    ({"doc": "notes/note.md", "frame": "text",
      "quote": {"text": "the gap", "before": "so ", "after": "\nis 2"}},
     'build dev  doc notes/note.md  quote "so [the gap]\\nis 2"'),
    ({"doc": "kicad/board.glb", "frame": "part", "part": "R501",
      "normal": [0.0, 0.0, 1.0]},
     "build dev  doc kicad/board.glb  part R501  view assembled  "
     "at 1.0 2.0 3.5 (part coords)  facing 0.00 0.00 1.00"),
])
def test_the_place_in_a_document_is_printed(hub, model, capsys, place, line):
    """The document a comment was left on, then the place in it by the kind
    of anchor; a part's point in a document reads as on the model."""
    leave_comment(hub, model, **place)
    capsys.readouterr()

    assert run(model, "comments") == 0
    assert f"\n  {line}\n" in capsys.readouterr().out


def test_the_client_prints_every_document_frame_the_hub_takes():
    """`DOCUMENT_FRAMES` is the hub's `FRAMES` but the part's, whose place is a
    point and prints as on the model."""
    assert set(queue.DOCUMENT_FRAMES) == set(comments.FRAMES) - {"part"}


def test_several_comments_are_all_listed(hub, model, capsys):
    first = leave_comment(hub, model, text="the first one")
    second = leave_comment(hub, model, text="the second one")
    capsys.readouterr()

    assert run(model, "comments") == 0
    out = capsys.readouterr().out
    assert "2 comments on demo0001" in out
    for cid in (first, second):
        assert cid in out


def test_an_empty_queue_is_a_success(hub, model, capsys):
    publish_dev(hub, model)
    capsys.readouterr()
    assert run(model, "comments") == 0
    out = capsys.readouterr().out
    assert "no open comments on demo0001" in out
    assert "--all" in out


def test_only_this_projects_queue_is_read(hub, tmp_path, capsys):
    """The queue is per project, and the filter is applied by the hub."""
    mine = make_model(tmp_path / "mine", pid="mine0001")
    theirs = make_model(tmp_path / "theirs", pid="theirs01")
    ours = leave_comment(hub, mine, pid="mine0001", text="about mine")
    yours = leave_comment(hub, theirs, pid="theirs01", text="about theirs")
    capsys.readouterr()

    assert run(mine, "comments") == 0
    out = capsys.readouterr().out
    assert ours in out
    assert yours not in out


def test_an_attachment_is_reported_as_the_command_that_fetches_it(hub, model,
                                                                  capsys):
    """Not as the URL. The bytes are behind the same token as the queue, so a
    reader given the URL could only open it by taking the secret out of the
    configuration."""
    publish_dev(hub, model)
    reply = hub.post_comment("demo0001", "dev", payload=comment_payload(),
                             photo=("part.png", PNG_BYTES, "image/png"))
    assert reply.status_code == 201, reply.text
    cid = reply.json()["id"]
    capsys.readouterr()

    assert run(model, "comments") == 0
    out = capsys.readouterr().out
    assert f"{hub.url}/api/v1/comments/{cid}/photo" not in out
    assert "photo" in out
    assert f"hammerola comments files {cid}" in out


def test_since_is_the_hubs_filter_and_reaches_it(hub, model, capsys):
    """Applied at the hub, not after the fact — and it is the one filter with a
    format the hub has to normalise, so it is worth sending a real one."""
    cid = leave_comment(hub, model)
    capsys.readouterr()

    assert run(model, "comments", "--since", "2000-01-01T00:00:00Z") == 0
    assert cid in capsys.readouterr().out

    assert run(model, "comments", "--since", "2999-01-01T00:00:00Z") == 0
    assert "no open comments" in capsys.readouterr().out


def test_a_since_the_hub_cannot_read_is_a_clean_failure(hub, model, capsys):
    assert run(model, "comments", "--since", "yesterday") == 1
    assert "invalid since" in capsys.readouterr().err


def test_a_comment_of_several_lines_stays_one_comment(hub, model, capsys):
    """Every line of the text is indented, so prose cannot be misread as the
    start of the next entry."""
    leave_comment(hub, model, text="first line\nsecond line")
    capsys.readouterr()
    assert run(model, "comments") == 0
    out = capsys.readouterr().out
    assert "  first line" in out
    assert "  second line" in out


# -- fetching the attachments ------------------------------------------------
def with_attachments(hub, model, pid="demo0001"):
    """One comment carrying both a photo and the viewer's frame. -> its id.

    TWO FORMATS AND NOT ONE, because each attachment keeps the extension its own
    bytes earned: a phone photograph arrives as JPEG and the viewer's frame is
    always a PNG, so a client that took one extension for both would write the
    photo under a name nothing opens. That is the ordinary case, not an odd one.
    """
    publish_dev(hub, model)
    reply = hub.post_comment(pid, "dev", payload=comment_payload(),
                             photo=("part.jpg", JPEG_BYTES, "image/jpeg"),
                             shot=("frame.png", PNG_BYTES, "image/png"))
    assert reply.status_code == 201, reply.text
    return reply.json()["id"]


def test_files_saves_the_bytes_that_were_posted(hub, model, capsys):
    """The point of the verb: the caller gets the picture without ever holding
    the token the route behind it takes."""
    cid = with_attachments(hub, model)
    capsys.readouterr()

    assert run(model, "comments", "files", cid) == 0
    out = capsys.readouterr().out

    # Under `.hammerola/`, never in the working copy: a photo beside model.py is
    # a file the next push would try to publish.
    fetched = model / sources.SCRATCH_DIR / "comments"
    assert (fetched / f"{cid}.jpg").read_bytes() == JPEG_BYTES
    assert (fetched / f"{cid}.shot.png").read_bytes() == PNG_BYTES
    assert str(fetched) in out


def test_files_takes_an_output_directory(hub, model, tmp_path, capsys):
    cid = with_attachments(hub, model)
    where = tmp_path / "elsewhere"
    capsys.readouterr()

    assert run(model, "comments", "files", cid, "-o", str(where)) == 0
    assert (where / f"{cid}.jpg").read_bytes() == JPEG_BYTES
    assert not (model / sources.SCRATCH_DIR / "comments").exists()


def test_a_comment_with_no_attachments_is_a_success(hub, model, capsys):
    """Most comments carry neither, so the ordinary answer must not look like a
    failure — the same reasoning an empty queue is printed with."""
    cid = leave_comment(hub, model)
    capsys.readouterr()

    assert run(model, "comments", "files", cid) == 0
    assert f"no photo or frame on {cid}" in capsys.readouterr().out


def test_the_client_takes_exactly_the_extensions_the_hub_stores():
    """THE SENTENCE OVER `ATTACHMENT_EXTENSIONS`, WRITTEN AS A TEST.

    That tuple is a fourth copy of one decision — `comments.sniff_image`,
    `comments._safe_attachment_name` and `app.ATTACHMENT_CONTENT_TYPES` are the
    other three — and a copy that drifts fails in the direction that reads as
    the hub's fault: `files` would refuse a real photo with a message saying the
    record did not come from a hub that kept the bytes.
    """
    served = {suffix.removeprefix(".")
              for suffix in app.ATTACHMENT_CONTENT_TYPES}
    assert set(queue.ATTACHMENT_EXTENSIONS) == served


def test_a_record_naming_a_file_this_hub_never_writes_is_refused(
        hub, model, capsys):
    """REFUSED RATHER THAN SKIPPED, for the reason `hammerola/artifacts.py`
    refuses a name it was handed: a photo missing from a directory reported as
    complete is the outcome worth avoiding, and this record cannot have come
    from a hub that stored the bytes — the serving gate
    (`comments._safe_attachment_name`) would never hand out a `.gif`.

    Staged by rewriting the record on the volume, because no upload can carry
    such a name past the hub's sniffer in the first place.
    """
    cid = with_attachments(hub, model)
    record_path = hub.comment_dir("demo0001") / f"{cid}.json"
    record = json.loads(record_path.read_text(encoding="utf-8"))
    record["photo"] = f"{cid}.gif"
    record_path.write_text(json.dumps(record), encoding="utf-8")
    capsys.readouterr()

    assert run(model, "comments", "files", cid) == 1
    assert "not a file this hub stores" in capsys.readouterr().err
    # AND NOTHING WAS WRITTEN: the refusal is raised while the list of names is
    # built, before the first byte lands, so the directory is not left holding
    # the frame and calling itself the comment's attachments.
    assert not (model / sources.SCRATCH_DIR / "comments").exists()


# -- resolving ---------------------------------------------------------------
def test_resolving_closes_it_and_the_next_read_says_so(hub, model, capsys):
    cid = leave_comment(hub, model)
    capsys.readouterr()

    assert run(model, "comments", "resolve", cid, "-m", "fixed the standoff") == 0
    assert "resolved" in capsys.readouterr().out

    # Gone from the default listing — which is the point of the command.
    assert run(model, "comments") == 0
    assert "no open comments" in capsys.readouterr().out

    # And still there, with the note, for whoever asks what was done.
    assert run(model, "comments", "--all") == 0
    out = capsys.readouterr().out
    assert cid in out
    assert "resolved" in out
    assert "note: fixed the standoff" in out


def test_a_note_is_optional(hub, model, capsys):
    cid = leave_comment(hub, model)
    capsys.readouterr()
    assert run(model, "comments", "resolve", cid) == 0
    assert run(model, "comments", "--all") == 0
    assert "resolved" in capsys.readouterr().out


def test_resolving_needs_no_project_directory(hub, model, tmp_path, capsys):
    """A comment id is unique across the hub, and whoever closes an item is
    often not sitting in the model that produced it."""
    cid = leave_comment(hub, model)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    capsys.readouterr()
    assert main(["-C", str(elsewhere), "comments", "resolve", cid]) == 0


def test_an_id_the_hub_does_not_have_is_a_clean_failure(hub, model, capsys):
    assert run(model, "comments", "resolve", "0" * 32) == 1
    assert "no comment" in capsys.readouterr().err


# -- failures ----------------------------------------------------------------
def test_an_unreachable_hub_is_a_clean_failure(model, monkeypatch, capsys):
    monkeypatch.setenv("HUB_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("EDIT_TOKEN", TOKEN)
    assert run(model, "comments") == 1
    assert "cannot reach" in capsys.readouterr().err


def test_a_machine_that_has_not_logged_in_is_told_to(hub, model, monkeypatch,
                                                     capsys):
    monkeypatch.delenv("EDIT_TOKEN", raising=False)
    assert run(model, "comments") == 1
    assert "hammerola login" in capsys.readouterr().err

