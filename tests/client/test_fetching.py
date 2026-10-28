"""`artifacts`, `log` and `diff`, against a real hub over a real socket.

Each of these verbs stands on a contract with the other half — which route
serves what, behind which secret, in which shape — and two suites each green
about their own side would not catch a break. So every test here drives
`cli.main` with argv and looks at what came back or what landed on the disk, at
a hub started by `harness.start_hub`.

The builds are published through the hub's own queue (`harness.Hub.publish`),
and by `git push` where `diff` needs the two revisions as commits in the
working copy: its code section is `git diff` between them.

What is being pinned, beyond "it works":

  * what `artifacts` fetches lands by DEFAULT in a hidden directory git
    ignores — a fetched file beside model.py is a file the next commit, and the
    next draft, would carry;
  * `log dev` is answered through the JOB the slot names, and the
    header says which kind of push filled the slot — a draft, or the revision
    that copied itself into it;
  * `diff` answers both halves of the question — what the geometry did, and what
    the source did — and the geometry half runs through the very function the
    build itself prints with.
"""

import json

import pytest
from harness import failing_comparer, meta_bytes, view_bytes
from modeldir import (git, git_repo, make_model, model_archive, publish_model,
                      push_version)

from hammerola import artifacts, sources
from hammerola.cli import main
from hammerola.hub import Hub, HubError

# The address and the token, from tests/client/conftest.py.
pytestmark = pytest.mark.usefixtures("configured")


def run(model, *args):
    return main(["-C", str(model), *args])


def metrics_bytes(volume=1000.0, faces=6, code="cc", parts=("body",)):
    """A metrics.json in the shape `cadbuild.metrics` writes.

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


PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32

# The catalogue `with_artifacts` publishes, spelled once because several tests
# read names out of it: a printable owning both kinds of pointer a record can
# carry, a bought part owning neither, and a second printable whose only export
# is a file the first one already named.
LID_FILES = {"stl": "lid.stl", "step": "lid.step"}
CATALOGUE = {
    "lid": {"kind": "printable", "files": dict(LID_FILES),
            "preview": "lid_preview.png"},
    "m3": {"kind": "hardware", "note": "M3x8 DIN912"},
    # The repeated pointer: the dedup it exercises is a property of the walk
    # over the WHOLE document, and nothing on the hub side forbids two records
    # naming one file. It sorts after `lid`, so `lid` is the record that gets the file and this
    # one is the repeat that must not be fetched, printed or counted a second
    # time.
    "shim": {"kind": "printable", "files": {"stl": LID_FILES["stl"]}},
}
ASSEMBLED_VIEW = {
    "id": "assembled", "name": "assembled", "file": "assembled.json",
    "parts": sorted(CATALOGUE), "overview": "assembled.stl",
    "preview": "assembled_preview.png", "card": "assembled_card.png",
}
# What a fetch of that build has to land on the disk, and nothing else. Built
# out of LID_FILES so the two cannot spell a name differently.
#
# `assembled_card.png` is declared above and deliberately absent here: that
# absence keeps the walk from following a pointer meant for the hub's front
# page. The card is the
# view's picture with the title and the footer cut off; the author already has
# the sheet that carries those, and the cropped twin beside it on their disk
# would answer nothing (`hammerola/artifacts.py`, `DECLARING_FIELDS`).
FETCHED = sorted([*LID_FILES.values(), "lid_preview.png",
                  "assembled.stl", "assembled_preview.png"])


def with_artifacts(root, **kw):
    """A model directory declaring a file in every field there is to declare in.

    ALL FIVE deliberately — `files` and `preview` on a part, `overview`,
    `preview` and `card` on a view — because of the five only ONE is drawn on
    the build page (a printable's `files`) and one more is fetched by the hub's
    front page (a view's `card`), so THIS COMMAND IS THE ONLY READER of the
    remaining three. A walk that quietly stopped following any of those three
    would be invisible to every other test in the repository — and the card is
    here for the opposite reason: it must be declared and must NOT be fetched,
    which only a fixture that declares it can pin (see `FETCHED`).

    The catalogue also holds a record with no files at all: a bought screw is
    exported nothing, so the walk has to step over it rather than trip on it.
    """
    model = make_model(root, **kw)
    (model / "lid.stl").write_bytes(b"solid lid\nendsolid lid\n")
    (model / "lid.step").write_bytes(b"ISO-10303-21;\n")
    (model / "lid_preview.png").write_bytes(PNG)
    (model / "assembled.stl").write_bytes(b"solid all\nendsolid all\n")
    (model / "assembled_preview.png").write_bytes(PNG)
    (model / "assembled_card.png").write_bytes(PNG)
    (model / "meta.json").write_bytes(
        meta_bytes(views=[dict(ASSEMBLED_VIEW)], parts=CATALOGUE))
    # The view file names exactly the keys the view declares, in both
    # directions — the hub refuses anything else (`render._match_selection`).
    (model / "assembled.json").write_bytes(view_bytes(keys=sorted(CATALOGUE)))
    return model


def publish_job(hub, model, commit=None):
    """Publish the model directory through the harness. -> (job, build name).

    For the tests about the job a build records; the rest use
    `modeldir.publish_model`, which returns the name alone.
    """
    reply = hub.publish("demo0001", commit, model_archive(model))
    assert reply.status_code in (200, 201), reply.text
    return (reply.record["id"],
            reply.json()["url"].rstrip("/").rsplit("/", 1)[1])


def slot_meta_path(hub, pid="demo0001"):
    return hub.project_dir(pid) / "dev" / "meta.json"


def slot_meta(hub, pid="demo0001"):
    return json.loads(slot_meta_path(hub, pid).read_text(encoding="utf-8"))


# -- artifacts ---------------------------------------------------------------
def test_the_default_directory_is_one_git_does_not_pick_up(hub, model, capsys):
    """A fetched file beside model.py would go into the next commit, and into
    the next draft `hammerola build` makes of the working copy. The scratch
    directory ignores itself, so `git add -A` stages nothing out of it."""
    git_repo(model)
    revision = publish_model(hub, model)

    assert run(model, "artifacts", revision) == 0
    capsys.readouterr()

    assert (model / sources.SCRATCH_DIR / ".gitignore").read_text().endswith("*\n")
    assert git(model, "status", "--porcelain").stdout == ""


def test_artifacts_brings_back_the_files_of_a_part_by_its_catalogue_key(
        hub, tmp_path, capsys):
    """The exports of one printable, reached through the record they sit on.

    The key is the part's identity: the files are `{extension: filename}`
    UNDER `lid`.
    """
    model = with_artifacts(tmp_path / "demo")
    revision = publish_model(hub, model)

    assert run(model, "artifacts", revision) == 0
    out = capsys.readouterr().out

    fetched = model / sources.SCRATCH_DIR / f"artifacts-{revision[:12]}"
    assert (fetched / "lid.stl").read_bytes() == b"solid lid\nendsolid lid\n"
    assert (fetched / "lid.step").is_file()
    # The report says WHOSE each file is, which is the thing the flat maps could
    # not say and every reader of them had to work out from a key.
    assert "part 'lid'" in out and "lid.stl" in out
    # The viewer payload is NOT an artefact and is not fetched: it is megabytes
    # of tessellation nothing outside the browser has a use for.
    assert not (fetched / "assembled.json").exists()


def test_artifacts_brings_back_the_pictures_and_the_whole_build_meshes(
        hub, tmp_path, capsys):
    """The three pointers that draw no button, and the reason this verb exists.

    A part's picture is the cheapest check there is on a part that came out
    lying face down. A picture belongs to the part or the view it is OF, so all
    three are declared and none of them is a button on the build page.
    """
    model = with_artifacts(tmp_path / "demo")
    revision = publish_model(hub, model)

    assert run(model, "artifacts", revision) == 0
    out = capsys.readouterr().out

    fetched = model / sources.SCRATCH_DIR / f"artifacts-{revision[:12]}"
    assert (fetched / "lid_preview.png").read_bytes().startswith(b"\x89PNG")
    assert (fetched / "assembled.stl").is_file()
    assert (fetched / "assembled_preview.png").is_file()
    assert "view 'assembled'" in out
    # FIVE FILES OUT OF SIX POINTERS, counted once each and reported as such —
    # `shim` names `lid.stl` too, so the count and the report are what the dedup
    # shows up in. Nothing on the disk can say it: both spellings write one file,
    # so the directory holds five names either way.
    assert f"{len(FETCHED)} files" in out
    assert out.count("lid.stl") == 1, out


def test_a_record_that_exports_nothing_is_stepped_over(hub, tmp_path, capsys):
    """A bought screw and a mock carry no `files` and no `preview` at all.

    The kind is what decides that, and the walk has to read such a record
    without dropping the ones beside it. It is a shape the old flat maps could
    not even express: a part appeared in them only if it had a file, so nothing
    ever had to step over one.
    """
    model = with_artifacts(tmp_path / "demo")
    meta = json.loads((model / "meta.json").read_text(encoding="utf-8"))
    meta["parts"]["wall"] = {"kind": "mock"}
    meta["views"][0]["parts"] = sorted(meta["parts"])
    (model / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    (model / "assembled.json").write_bytes(
        view_bytes(keys=sorted(meta["parts"])))
    revision = publish_model(hub, model)

    assert run(model, "artifacts", revision) == 0
    out = capsys.readouterr().out

    fetched = model / sources.SCRATCH_DIR / f"artifacts-{revision[:12]}"
    assert sorted(p.name for p in fetched.iterdir()) == FETCHED
    assert "wall" not in out and "m3" not in out


def test_artifacts_can_fetch_the_dev_slot(hub, tmp_path, capsys):
    """`dev` is a slot and not a revision, and still a BUILD with files: this
    verb asks a build for them."""
    model = with_artifacts(tmp_path / "demo")
    publish_model(hub, model, "dev")

    assert run(model, "artifacts", "dev") == 0
    fetched = model / sources.SCRATCH_DIR / "artifacts-dev"
    assert (fetched / "lid.stl").is_file()


def test_a_build_declaring_nothing_at_all_says_so_and_still_succeeds(
        hub, tmp_path, capsys):
    """A shape no BUILD produces — staged on the volume.

    `cadbuild.build` puts the `assembled` view's overview mesh on every
    document, a catalogue of nothing but bought parts included. Only a
    hand-made push or an edited document can land here.

    The branch is not dead code. `data/` is writable by every build (SPEC §7.4), so one project's build can
    empty another's `meta.json`; and a hub of another version, or anything that
    rewrote the reply on the way, answers whatever it likes. The technique is
    the one
    test_a_declared_name_the_hub_could_never_serve_is_refused uses and for the
    same reason: the case exists only in an answer no build wrote.

    It still succeeds, and that is the decision the message carries: the
    document is well formed and merely empty, so there is nothing to download
    and nothing that could be downloaded WRONGLY — which is what the refusals
    below are for.
    """
    model = with_artifacts(tmp_path / "demo")
    revision = publish_model(hub, model)

    build = hub.project_dir("demo0001") / revision
    meta = json.loads((build / "meta.json").read_text(encoding="utf-8"))
    # Every pointer taken off, and taken off BY THE WALK'S OWN TABLE: a field
    # added to `DECLARING_FIELDS` and not to a hand-written list here would
    # leave one pointer standing, and this test would then be asserting the
    # message of a build that declares something.
    for record in meta["parts"].values():
        for field in artifacts.DECLARING_FIELDS["part"]:
            record.pop(field, None)
    for view in meta["views"]:
        for field in artifacts.DECLARING_FIELDS["view"]:
            view.pop(field, None)
    (build / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

    assert run(model, "artifacts", revision) == 0
    out = capsys.readouterr().out
    assert "no downloadable artefacts" in out
    # EVERY FIELD THE WALK READS HAS TO BE NAMED IN THAT ONE MESSAGE, and the
    # list is taken from the walk's own table rather than from a copy of the
    # words: a field added there and nowhere else would otherwise be fetched
    # perfectly while the one sentence about it stayed wrong, with this green.
    for fields in artifacts.DECLARING_FIELDS.values():
        for field in fields:
            assert f"`{field}`" in out


# A file name no build the hub published can carry: U+202E RIGHT-TO-LEFT
# OVERRIDE, written as an escape rather than pasted, because a literal one
# reverses this very source line in every editor that reads it.
BAD_NAME = "body\u202elts.stl"


def _plant(meta: dict, owner: str, field: str, value) -> None:
    """Put `value` where one owner's one field sits, on a document that was
    good until this was done to it.

    A plain assignment, because the VALUE is what each case varies: a `files`
    case hands the whole map (or the whole wrong thing standing in for one),
    rather than a name this helper wraps in a map of its own choosing.
    """
    if owner == "view":
        meta["views"][0][field] = value
    else:
        meta["parts"]["lid"][field] = value


@pytest.mark.parametrize("owner,field,planted,said,because", [
    ("part", "files", {"stl": BAD_NAME}, "files.stl", "non-printable"),
    ("part", "preview", BAD_NAME, "preview", "non-printable"),
    ("view", "overview", BAD_NAME, "overview", "non-printable"),
    ("view", "preview", BAD_NAME, "preview", "non-printable"),
    # The wrong shape, on the one field that has one. A string would pass
    # `unservable_reason` as a perfectly good file name, and `{}` is refused by
    # `render._catalogue` outright, so neither can come off a build the hub
    # published.
    ("part", "files", "assembled.stl", "'files'", "not a shape"),
    ("part", "files", {}, "'files'", "not a shape"),
])
def test_a_declared_name_the_hub_could_never_serve_is_refused(
        hub, tmp_path, capsys, owner, field, planted, said, because):
    """The case the client's re-check exists for.

    The hub validates every one of these pointers at publish time
    (`render._check_declared_file`), so a name of this shape cannot come from a
    build it published — which is exactly why the client refuses instead of
    skipping: the answer did not come from where it should have. That makes a
    DISHONEST OR CORRUPTED ANSWER the only case the check is ever exercised by,
    and it is staged here by rewriting the published meta.json on the volume,
    because the hub refuses such a name in anything it publishes.

    One case per place a pointer can sit: a part's files are a map inside a
    record and a view's mesh is a bare name on a list entry, so a check written
    against one of those shapes would leave a whole owner unwatched.

    U+202E RIGHT-TO-LEFT OVERRIDE, and not a leading dot, because this
    command is the reason for that clause of the shared rule: the filename is printed on the line reporting the
    save and then written to the author's disk, so an override in it reverses
    the report of what just landed.

    A name and a shape are one subject here, which is why the last two rows are
    in this table rather than in a test of their own: both say "the hub checks
    this at publish time, so this answer did not come from a build it
    published", both are staged the same way, and both have to name where in
    the document to look. What they exercise is the other half of the walk —
    the fields it reads BEFORE it has a name to ask `unservable_reason` about.
    """
    model = with_artifacts(tmp_path / "demo")
    revision = publish_model(hub, model)

    build = hub.project_dir("demo0001") / revision
    meta = json.loads((build / "meta.json").read_text(encoding="utf-8"))
    _plant(meta, owner, field, planted)
    (build / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

    assert run(model, "artifacts", revision) == 1
    err = capsys.readouterr().err
    assert BAD_NAME not in err, (
        "the refusal printed the name raw; an override in it reverses the very "
        "line reporting it, which is what the check is about")
    # WHAT WAS PLANTED, QUOTED — the name for a pointer case, the value itself
    # for a shape one. Both are somebody else's document arriving in a terminal,
    # so both are shown through `repr`.
    shown = planted["stl"] if isinstance(planted, dict) and planted else planted
    assert repr(shown) in err
    assert because in err
    # WHICH FIELD OF WHICH RECORD, because "somewhere in this document" is not
    # something a reader can act on — and with two owners it is now the only
    # way to say where to look.
    assert said in err
    assert ("part 'lid'" if owner == "part" else "view 'assembled'") in err


def test_a_document_path_that_climbs_out_of_the_destination_is_refused(
        hub, tmp_path, capsys):
    """A document keeps its path, so `artifacts` writes into subdirectories;
    the path rule, the name rule per segment, is what keeps every write inside
    the destination. Staged as the table above is: the hub refuses such a path
    at publish time (`render._check_declared_file`)."""
    model = with_artifacts(tmp_path / "demo")
    revision = publish_model(hub, model)

    build = hub.project_dir("demo0001") / revision
    meta = json.loads((build / "meta.json").read_text(encoding="utf-8"))
    meta["documents"] = [{"id": "escape.md", "name": "escape.md",
                          "type": "markdown", "file": "../escape.md"}]
    (build / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

    assert run(model, "artifacts", revision) == 1
    err = capsys.readouterr().err
    assert "document 'escape.md'" in err
    assert "'../escape.md', which has the segment '..'" in err
    assert not list(tmp_path.rglob("escape.md"))


@pytest.mark.parametrize("planted,said", [
    ({"parts": []}, "`parts` catalogue"),
    ({"parts": {"lid": "lid.stl"}}, "part 'lid'"),
    ({"views": {}}, "`views` of this build"),
    ({"views": ["assembled"]}, "view #0"),
])
def test_a_document_shaped_wrong_is_refused_rather_than_walked_past(
        hub, tmp_path, capsys, planted, said):
    """Four nodes the walk refuses rather than steps over.

    A `parts` that is not an object, a record that is not one, a `views` that
    is not a list, an entry of it that is not an object: a skip is the one
    outcome this command must not produce. `data/` is writable by every build
    (SPEC §7.4), so one project's build can rewrite another's meta.json, and a
    skip would hand the author an incomplete set reported as complete.

    The hub checks every one of these at publish time (`render._catalogue`,
    `render.build_meta`), which is why the refusal says the same thing the
    file-name one says — this answer did not come from a build the hub
    published — and why the case has to be staged on the volume.

    Nothing is fetched first: the walk runs before the destination directory is
    made, so a refusal leaves no half-filled directory to be mistaken for a
    complete one.
    """
    model = with_artifacts(tmp_path / "demo")
    revision = publish_model(hub, model)

    build = hub.project_dir("demo0001") / revision
    meta = json.loads((build / "meta.json").read_text(encoding="utf-8"))
    meta.update(planted)
    (build / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

    assert run(model, "artifacts", revision) == 1
    err = capsys.readouterr().err
    assert said in err
    assert "not a shape this document carries" in err
    assert not (model / sources.SCRATCH_DIR
                / f"artifacts-{revision[:12]}").exists()


def test_artifacts_of_a_build_that_is_not_there(hub, model, capsys):
    publish_model(hub, model)
    assert run(model, "artifacts", "f" * 64) == 1
    assert "no build" in capsys.readouterr().err


def test_artifacts_with_a_stale_token_blames_the_token(hub, tmp_path, capsys,
                                                       monkeypatch):
    """meta.json is open, so a wrong token gets past the first request and is
    refused only on the first closed file (the STEP): that refusal must send the reader to
    `hammerola login`, not read as a broken hub."""
    model = with_artifacts(tmp_path / "demo")
    revision = publish_model(hub, model)
    monkeypatch.setenv("EDIT_TOKEN", "not-the-token")

    assert run(model, "artifacts", revision) == 1
    assert "hammerola login" in capsys.readouterr().err


# -- log ---------------------------------------------------------------------
def test_log_without_an_argument_reads_the_newest_revision(hub, model, capsys):
    publish_model(hub, model)
    assert run(model, "log") == 0
    out = capsys.readouterr().out
    assert "copying builder" in out
    assert "--- build log of " in out


def test_log_of_a_named_revision(hub, model, capsys):
    first = publish_model(hub, model)
    (model / "model.py").write_text("# second\n")
    publish_model(hub, model)

    assert run(model, "log", first) == 0
    out = capsys.readouterr().out
    assert first in out


def test_the_slot_names_its_job_and_a_revision_names_none(hub, model, capsys):
    """The slot's `job` field, and its absence from a revision.

    The slot's meta.json and a revision's differ in exactly three keys, and
    `job` is the third: the slot is not addressed by a revision, so no log is
    stored under its name and the JOB that filled it is the only way back to
    one. A revision needs no such field — its log is in the store — and must
    not grow one, because that document is what a build page and every
    comparison read.
    """
    revision = publish_model(hub, model)
    # The revision filled the slot with itself, so the sources have to move
    # before a draft is anything but "unchanged, nothing rebuilt".
    (model / "model.py").write_text("# moved on since\n")
    job, _ = publish_job(hub, model, "dev")

    assert slot_meta(hub)["job"] == job
    published = json.loads(
        (hub.project_dir("demo0001") / revision / "meta.json").read_text(
            encoding="utf-8"))
    assert "job" not in published


def test_log_dev_prints_the_log_of_the_job_that_filled_the_slot(hub, model,
                                                                capsys):
    """What comes back is the log of the very build whose geometry is in the
    slot, not `latest`'s under another name."""
    job, _ = publish_job(hub, model, "dev")

    assert run(model, "log", "dev") == 0
    out = capsys.readouterr().out
    assert f"--- build log of job {job} (build, state done) ---" in out
    assert "copying builder" in out
    assert "--- end of build log ---" in out


def test_log_dev_says_when_a_commit_is_what_filled_the_slot(hub, model,
                                                            capsys):
    """A commit copies itself into the slot, so `log dev` is often
    a revision's log — and the header has to say so rather than leave the
    reader to work it out from the contents afterwards."""
    job, revision = publish_job(hub, model)
    assert slot_meta(hub)["job"] == job

    assert run(model, "log", "dev") == 0
    printed = capsys.readouterr().out
    assert f"--- build log of job {job} (commit {revision}, state done) ---" \
        in printed
    assert "copying builder" in printed


def test_log_dev_of_a_slot_that_does_not_name_a_job(hub, model, capsys):
    """A slot that names no job: one filled before the hub recorded the field,
    or a revision published without a build (a name changed on the page). It
    is not an error on the hub's side — the slot is published and serves its
    geometry — so the refusal says what to run rather than sounding like a
    broken build."""
    publish_model(hub, model, "dev")
    meta = slot_meta(hub)
    del meta["job"]
    slot_meta_path(hub).write_text(json.dumps(meta), encoding="utf-8")

    assert run(model, "log", "dev") == 1
    err = capsys.readouterr().err
    assert "does not say which job filled it" in err
    assert "`hammerola log`" in err


def test_log_dev_when_the_hub_does_not_have_that_job(hub, model, capsys):
    """A job id means nothing on another hub, and jobs have no retention. The
    refusal names the hub, because the usual cause is that the configured one
    is not the hub that built this."""
    publish_model(hub, model, "dev")
    meta = slot_meta(hub)
    meta["job"] = "0" * 22
    slot_meta_path(hub).write_text(json.dumps(meta), encoding="utf-8")

    assert run(model, "log", "dev") == 1
    err = capsys.readouterr().err
    assert "does not have it" in err
    assert hub.url in err


def test_log_dev_with_a_stale_token_blames_the_token(hub, model, capsys,
                                                     monkeypatch):
    """The slot's meta.json is PUBLIC, so a wrong token gets through the first
    request of this command and is refused only by the second. That must not be
    reported as a job the hub has lost: the advice attached to that reading is
    `hammerola build`, and a push fails on the same 403 a moment later."""
    publish_model(hub, model, "dev")
    monkeypatch.setenv("EDIT_TOKEN", "not-the-token")

    assert run(model, "log", "dev") == 1
    err = capsys.readouterr().err
    assert "403" in err and "hammerola login" in err
    assert "does not have it" not in err
    assert "wiped" not in err


def test_log_of_a_revision_the_hub_never_published(hub, model, capsys):
    publish_model(hub, model)
    assert run(model, "log", "f" * 64) == 1
    assert "no build log for revision" in capsys.readouterr().err


# -- diff --------------------------------------------------------------------
def test_diff_answers_both_questions(hub, tmp_path, capsys):
    model = make_model(tmp_path / "demo")
    (model / "metrics.json").write_bytes(metrics_bytes(volume=1000.0))
    first = push_version(hub, model)

    (model / "model.py").write_text("import cadquery as cq\n\nBOX = 12\n")
    (model / "metrics.json").write_bytes(metrics_bytes(volume=900.0, code="dd"))
    second = push_version(hub, model)

    assert run(model, "diff", first, second) == 0
    out = capsys.readouterr().out

    # The geometry half, through the same function the build prints with.
    assert "geometry:" in out
    assert "volume 1.00 -> 0.90 cm3" in out
    # The code half, out of the local repository.
    assert "code:" in out
    assert "-import cadquery as cq" not in out       # unchanged first line
    assert "+BOX = 12" in out


def test_diff_says_when_the_measurements_are_missing(hub, model, capsys):
    """A build published before the model wrote metrics.json costs the geometry
    half of the answer, not the whole command."""
    first = push_version(hub, model)
    (model / "model.py").write_text("# changed\n")
    second = push_version(hub, model)

    assert run(model, "diff", first, second) == 0
    out = capsys.readouterr().out
    assert "published no metrics.json" in out
    assert "code:" in out


def test_diff_of_a_revision_against_itself_is_not_an_error(hub, model, capsys):
    """`hammerola diff <rev> latest` is how somebody asks whether latest is
    still that one, and "yes" is a useful answer."""
    revision = publish_model(hub, model)
    assert run(model, "diff", revision, "latest") == 0
    assert "the same revision" in capsys.readouterr().out


def test_diff_raises_the_alarm_when_the_code_did_not_move_but_the_solid_did(
        hub, tmp_path, capsys):
    """The one line here that says something the numbers do not: the same model
    source built into a different solid."""
    model = make_model(tmp_path / "demo")
    (model / "metrics.json").write_bytes(metrics_bytes(volume=1000.0, code="cc"))
    first = push_version(hub, model)

    # The comment changes the tree (so it is a new revision) while the metrics
    # keep the same `source.code` hash — which is exactly the shape of "built
    # somewhere else" that the alarm is for.
    (model / "model.py").write_text("import cadquery as cq  # a comment\n")
    (model / "metrics.json").write_bytes(metrics_bytes(volume=1200.0, code="cc"))
    second = push_version(hub, model)

    assert run(model, "diff", first, second) == 0
    out = capsys.readouterr().out
    assert "the geometry moved while the model's code did not" in out
    assert "body" in out


def test_diff_json_prints_one_document_and_nothing_else(hub, tmp_path, capsys):
    """`--json` is read by a script, so the whole output has to parse.

    Which means the header, the source diff and the "same revision" sentence
    are all absent — none of them is JSON, and any one of them turns the answer
    into text somebody has to strip before parsing it.
    """
    model = make_model(tmp_path / "demo")
    (model / "metrics.json").write_bytes(metrics_bytes(volume=1000.0))
    first = publish_model(hub, model)

    (model / "model.py").write_text("import cadquery as cq\n\nBOX = 12\n")
    (model / "metrics.json").write_bytes(metrics_bytes(volume=900.0, code="dd"))
    second = publish_model(hub, model)

    assert run(model, "diff", "--json", first, second) == 0
    answer = json.loads(capsys.readouterr().out)
    assert answer["moved"] == [{"part": "body", "field": "volume_mm3",
                                "old": 1000.0, "new": 900.0}]
    # volume and bbox, the two PHYSICAL fields this fixture's metrics carry.
    assert answer["compared"] == 2


def test_diff_json_returns_zero_when_nothing_physical_moved(hub, tmp_path,
                                                            capsys):
    """THE RETURN CODE IS NOT THE ANSWER, and that is the decision: `diff`
    returns 0 whether or not anything moved, and other people's scripts already
    depend on it. What moved is in the document."""
    model = make_model(tmp_path / "demo")
    (model / "metrics.json").write_bytes(metrics_bytes(volume=1000.0))
    first = publish_model(hub, model)

    # A new revision — the tree changed — whose geometry is identical.
    (model / "notes.txt").write_text("nothing to do with the solid\n")
    second = publish_model(hub, model)

    assert run(model, "diff", "--json", first, second) == 0
    assert json.loads(capsys.readouterr().out) == {"moved": [], "compared": 2}


def test_diff_says_how_many_numbers_it_compared_when_none_of_them_moved(
        hub, tmp_path, capsys):
    """"The same" is also what two documents with nothing in common produce.

    A revision published before a field existed against one published after
    compares nothing and reports nothing moved — so the sentence carries the
    count, and a zero in it is the reader's clue that the two files have no
    number in common rather than the same ones.
    """
    model = make_model(tmp_path / "demo")
    (model / "metrics.json").write_bytes(metrics_bytes(volume=1000.0))
    first = push_version(hub, model)
    (model / "notes.txt").write_text("nothing to do with the solid\n")
    second = push_version(hub, model)

    assert run(model, "diff", first, second) == 0
    # Five: the fields of METRIC_FIELDS this fixture's metrics.json carries —
    # volume, bbox, faces, solids and watertight. It carries neither of the two
    # areas, which is exactly the rollout case the count exists to make visible.
    assert "every measured number is the same (5 part numbers compared)." in \
        capsys.readouterr().out


def test_diff_material_prints_what_the_hub_measured(hub, model, capsys):
    """The one section of `diff` that is not arithmetic over fetched files.

    The measurement itself runs in the hub's own child process with the CAD
    kernel in it — the suite substitutes that runner (`harness.reading_comparer`)
    for the same reason it substitutes the builder — so what is being pinned
    here is the ROUND TRIP: the client submits, waits for the job, and prints
    the job's LOG under the heading, because that log IS the report.

    Its place in the output is part of the answer too: after the numbers the
    build already wrote down and before the code that explains them.
    """
    first = push_version(hub, model)
    (model / "model.py").write_text("import cadquery as cq\n\nBOX = 12\n")
    second = push_version(hub, model)

    assert run(model, "diff", "--material", first, second) == 0
    out = capsys.readouterr().out

    assert f"  comparing demo0001: {first} -> {second}" in out
    assert (out.index("geometry:") < out.index("material:")
            < out.index("code:"))


def test_diff_material_that_ended_badly_costs_the_section_and_not_the_command(
        hub_factory, monkeypatch, model, capsys):
    """A COMPARISON THAT DIED IS ONE SECTION SHORT, not a failed command.

    Two things are pinned, and the second is why this test is here rather than
    only in `tests/test_compare.py`, which owns the hub's half. The log comes
    out BEFORE the sentence saying the run did not finish, because a comparison
    that died halfway has already said something useful about the parts it did
    reach. And the CODE section still prints: it comes from the local
    repository and does not depend on the kernel having survived, so "why did
    it change" must not be swallowed along with "by how much".
    """
    hub = hub_factory(compare_runner=failing_comparer())
    monkeypatch.setenv("HUB_URL", hub.url)
    first = push_version(hub, model)
    (model / "model.py").write_text("import cadquery as cq\n\nBOX = 12\n")
    second = push_version(hub, model)

    assert run(model, "diff", "--material", first, second) == 0
    out = capsys.readouterr().out

    assert "  compareproc: the kernel died" in out
    assert (out.index("compareproc: the kernel died")
            < out.index("the hub could not finish the comparison"))
    assert out.index("the hub could not finish the comparison") < \
        out.index("code:")
    assert "BOX = 12" in out


def test_diff_material_that_loses_the_hub_mid_wait_still_prints_the_code(
        hub, model, monkeypatch, capsys):
    """THE SAME PROMISE AS THE TEST ABOVE, for the failure that RAISES.

    Its neighbour pins a comparison that ended badly ON the hub, which comes
    back as an ordinary `failed` record. This one pins the other half: a
    connection that drops on the last poll of a long wait, or a wait that runs
    out, which `await_job` reports by raising — the only path through the
    section's `except HubError`, and the reason all three requests sit inside
    one `try`. The code diff below comes from the local repository and does not
    depend on the comparison having happened at all, so "why did it change"
    must survive losing "by how much".

    The second assertion is the wait's NOTICES: they go to stderr, because a
    line about the connection is not part of the report and must not land in
    the middle of it.
    """
    def lost(self, job_id, *args, on_notice=None, **kw):
        on_notice("the hub stopped answering")
        raise HubError("the wait ran out")

    first = push_version(hub, model)
    (model / "model.py").write_text("import cadquery as cq\n\nBOX = 12\n")
    second = push_version(hub, model)
    monkeypatch.setattr(Hub, "await_job", lost)

    assert run(model, "diff", "--material", first, second) == 0
    captured = capsys.readouterr()

    assert "  the hub could not be asked for it: the wait ran out" in captured.out
    assert "the hub stopped answering" in captured.err
    assert "the hub stopped answering" not in captured.out
    assert captured.out.index("the hub could not be asked for it") < \
        captured.out.index("code:")
    assert "BOX = 12" in captured.out


def test_diff_material_cannot_be_asked_for_together_with_json(hub, model,
                                                              capsys):
    """A request with no answer, refused before anything is sent.

    `--json` is the whole output or none of it, and `--material` adds a section
    to the printed output — so one of the two would have to be ignored. Argparse
    says so itself, which is why this exits 2 rather than 1: it never reaches a
    handler.
    """
    with pytest.raises(SystemExit) as refused:
        run(model, "diff", "--json", "--material", "a" * 64, "b" * 64)
    assert refused.value.code == 2
    assert "not allowed with" in capsys.readouterr().err


def test_diff_needs_a_project_because_metrics_live_in_a_build_directory(
        hub, model, capsys, tmp_path):
    revision = publish_model(hub, model)
    elsewhere = tmp_path / "not-a-project"
    elsewhere.mkdir()
    assert main(["-C", str(elsewhere), "diff", revision, "latest"]) == 1
    assert "project.json" in capsys.readouterr().err


def test_a_view_file_is_not_confused_for_an_artefact(hub, tmp_path, capsys):
    """A view's `file` is the one pointer on this document NOT walked.

    Its two neighbours ON THE SAME VIEW are — `overview` and `preview` — so this
    cannot be asserted by "the command fetches what is declared": the directory
    below is compared WHOLE, and the tessellation is the name that has to be
    missing from it while the view's own mesh and picture are present. It is
    megabytes nothing outside the browser can use, and `DECLARING_FIELDS` is
    where the line is drawn.
    """
    model = with_artifacts(tmp_path / "demo")
    (model / "assembled.json").write_bytes(
        view_bytes("big", keys=sorted(CATALOGUE)))
    revision = publish_model(hub, model)

    assert run(model, "artifacts", revision) == 0
    fetched = model / sources.SCRATCH_DIR / f"artifacts-{revision[:12]}"
    assert sorted(p.name for p in fetched.iterdir()) == FETCHED
