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
  * `log dev` is answered through the JOB the slot names (issue #79), and the
    header says which kind of push filled the slot — a `build`, or the commit
    that copied itself into it;
  * `diff` answers both halves of the question — what the geometry did, and what
    the source did — and the geometry half runs through the very function the
    build itself prints with.
"""

import json
import tarfile

import pytest
from harness import TOKEN, failing_comparer, meta_bytes, view_bytes
from modeldir import git, git_repo, make_model

from hammerola import artifacts, sources
from hammerola.cli import main
from hammerola.hub import Hub, HubError


@pytest.fixture(autouse=True)
def configured(monkeypatch, hub):
    monkeypatch.setenv("HUB_URL", hub.url)
    monkeypatch.setenv("EDIT_TOKEN", TOKEN)


def run(model, *args):
    return main(["-C", str(model), *args])


def metrics_bytes(volume=1000.0, faces=6, code="cc", parts=("body",)):
    """A metrics.json in the shape `cadbuild.metrics` writes (issue #26).

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
    # THE REPEATED POINTER, and it is here rather than in one test because the
    # dedup it exercises is a property of the walk over the WHOLE document.
    # Nothing on the hub side forbids two records naming one file, and until
    # this record existed no fixture had two: the six pointers below made five
    # names, so `seen` could be deleted outright with the suite green. It sorts
    # after `lid`, so `lid` is the record that gets the file and this one is the
    # repeat that must not be fetched, printed or counted a second time.
    "shim": {"kind": "printable", "files": {"stl": LID_FILES["stl"]}},
}
ASSEMBLED_VIEW = {
    "id": "assembled", "name": "assembled", "file": "assembled.json",
    "parts": sorted(CATALOGUE), "overview": "assembled.stl",
    "preview": "assembled_preview.png",
}
# What a fetch of that build has to land on the disk, and nothing else. Built
# out of LID_FILES rather than beside it: the two used to be one list written
# twice, so a name changed in the catalogue and not here would have been fetched
# under one spelling and expected under another.
FETCHED = sorted([*LID_FILES.values(), "lid_preview.png",
                  "assembled.stl", "assembled_preview.png"])


def with_artifacts(root, **kw):
    """A model directory declaring a file in every field there is to declare in.

    ALL FOUR deliberately — `files` and `preview` on a part, `overview` and
    `preview` on a view — because only ONE of them is drawn on the build page
    (a printable's `files`) and THIS COMMAND IS THE ONLY READER of the other
    three. A walk that quietly stopped following any of them would be invisible
    to every other test in the repository.

    The catalogue also holds a record with no files at all: a bought screw is
    exported nothing, so the walk has to step over it rather than trip on it.
    """
    model = make_model(root, **kw)
    (model / "lid.stl").write_bytes(b"solid lid\nendsolid lid\n")
    (model / "lid.step").write_bytes(b"ISO-10303-21;\n")
    (model / "lid_preview.png").write_bytes(PNG)
    (model / "assembled.stl").write_bytes(b"solid all\nendsolid all\n")
    (model / "assembled_preview.png").write_bytes(PNG)
    (model / "meta.json").write_bytes(
        meta_bytes(views=[dict(ASSEMBLED_VIEW)], parts=CATALOGUE))
    # The view file names exactly the keys the view declares, in both
    # directions — the hub refuses anything else (`render._match_selection`).
    (model / "assembled.json").write_bytes(view_bytes(keys=sorted(CATALOGUE)))
    return model


def publish(model, capsys, *args):
    """`hammerola commit` and the revision it printed."""
    assert run(model, "commit", *args) == 0
    return revision_of(capsys.readouterr().out)


def revision_of(out):
    for line in out.splitlines():
        if line.startswith("revision "):
            return line.split()[1].rstrip(":")
    raise AssertionError(f"no revision in the output:\n{out}")


def job_of(out):
    """The job id `build` and `commit` print, out of what they printed."""
    for line in out.splitlines():
        if line.startswith("queued as job "):
            return line.split()[3].rstrip(":")
    raise AssertionError(f"no job in the output:\n{out}")


def slot_meta_path(hub, pid="demo0001"):
    return hub.project_dir(pid) / "dev" / "meta.json"


def slot_meta(hub, pid="demo0001"):
    return json.loads(slot_meta_path(hub, pid).read_text(encoding="utf-8"))


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
    """`dev` is a slot, not a revision: the hub stores no CODE for it, on
    purpose (SPEC 7.8). Its log is a different matter since #79 — the slot names
    the job that filled it, and `hammerola log dev` reads that."""
    assert run(model, "build") == 0
    capsys.readouterr()
    assert run(model, "source", "dev") == 1
    assert "not a revision" in capsys.readouterr().err


# -- artifacts ---------------------------------------------------------------
def test_artifacts_brings_back_the_files_of_a_part_by_its_catalogue_key(
        hub, tmp_path, capsys):
    """The exports of one printable, reached through the record they sit on.

    The key is the part's identity now (issue #75): the files are `{extension:
    filename}` UNDER `lid`, rather than entries of a flat map whose label a
    reader had to split back into a part and a suffix.
    """
    model = with_artifacts(tmp_path / "demo")
    revision = publish(model, capsys)

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
    lying face down, and while every file was declared through one flat map
    there was no way to ask for one: declaring ten pictures meant ten buttons
    under a menu whose other rows are things you print, and the instruction
    that survived instead told an agent to assemble the URL by hand out of the
    part name and a suffix. Ownership is what answers it — a picture belongs to
    the part or the view it is OF — so all three are declared and none of them
    is a button.
    """
    model = with_artifacts(tmp_path / "demo")
    revision = publish(model, capsys)

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
    revision = publish(model, capsys)

    assert run(model, "artifacts", revision) == 0
    out = capsys.readouterr().out

    fetched = model / sources.SCRATCH_DIR / f"artifacts-{revision[:12]}"
    assert sorted(p.name for p in fetched.iterdir()) == FETCHED
    assert "wall" not in out and "m3" not in out


def test_artifacts_reads_the_public_route_and_source_does_not(hub, tmp_path,
                                                              capsys):
    """The two verbs exist because the rights differ. The build's files are
    served to anybody with the URL; the code is not."""
    model = with_artifacts(tmp_path / "demo")
    revision = publish(model, capsys)

    assert hub.get(f"/project/demo0001/{revision}/lid.stl").status_code == 200
    assert hub.get(f"/api/v1/sources/{revision}").status_code == 401


def test_artifacts_can_fetch_the_dev_slot(hub, tmp_path, capsys):
    """Unlike `source`: this asks a BUILD for its files, and the slot is one."""
    model = with_artifacts(tmp_path / "demo")
    assert run(model, "build") == 0
    capsys.readouterr()

    assert run(model, "artifacts", "dev") == 0
    fetched = model / sources.SCRATCH_DIR / "artifacts-dev"
    assert (fetched / "lid.stl").is_file()


def test_a_build_declaring_nothing_at_all_says_so_and_still_succeeds(
        hub, tmp_path, capsys):
    """A shape NEITHER HALF produces any more — staged on the volume, as it must be.

    IT USED TO BE A PUSH, and it cannot be one now. The build guaranteed the
    shape was impossible on its side (`read_catalogue` refuses a catalogue with
    nothing printable in it, and every printable is exported), while the hub
    took a document of nothing but bought screws quite happily; the review of
    this change closed that gap, so `render._catalogue` refuses both a
    catalogue with no printable in it and a printable declaring no files, and
    there is no longer any push that lands here.

    THE BRANCH IS NOT DEAD CODE, which is why the test moved rather than went.
    `data/` is writable by every build (SPEC §7.4), so one project's build can
    empty another's `meta.json`; and a hub of another version, or anything that
    rewrote the reply on the way, answers whatever it likes. The technique is
    the one
    test_a_declared_name_the_hub_could_never_serve_is_refused uses and for the
    same reason: the case exists only in an answer the hub did not write.

    IT STILL SUCCEEDS, and that is the decision the message carries: the
    document is well formed and merely empty, so there is nothing to download
    and nothing that could be downloaded WRONGLY — which is what the refusals
    below are for.
    """
    model = with_artifacts(tmp_path / "demo")
    revision = publish(model, capsys)

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
    # THE WRONG SHAPE, ON THE ONE FIELD THAT HAS ONE. A string is the case the
    # walk used to hand on whole — `unservable_reason` passes a perfectly good
    # file name, so one part's entire export was fetched and reported as a
    # single file — and `{}` is refused by `render._catalogue` outright rather
    # than dropped, so an empty map cannot come off a build the hub published
    # either.
    ("part", "files", "assembled.stl", "'files'", "not a shape"),
    ("part", "files", {}, "'files'", "not a shape"),
])
def test_a_declared_name_the_hub_could_never_serve_is_refused(
        hub, tmp_path, capsys, owner, field, planted, said, because):
    """THE CASE THE CLIENT'S RE-CHECK EXISTS FOR, and the one it used to miss.

    The hub validates every one of these pointers at publish time
    (`render._check_declared_file`), so a name of this shape cannot come from a
    build it published — which is exactly why the client refuses instead of
    skipping: the answer did not come from where it should have. That makes a
    DISHONEST OR CORRUPTED ANSWER the only case the check is ever exercised by,
    and it is staged here by rewriting the published meta.json on the volume,
    because no push can carry such a name through the archive alphabet in the
    first place.

    ONE CASE PER PLACE A POINTER CAN SIT, because the document is no longer one
    walk over three maps of the same shape: a part's files are a map inside a
    record and a view's mesh is a bare name on a list entry, so a check written
    against one of those shapes would leave a whole owner unwatched.

    U+202E RIGHT-TO-LEFT OVERRIDE, and not a leading dot, because the dot is
    what the hand-rolled version of this check already caught. This one is the
    clause the shared rule has and the copy did not — and it names this very
    command as its reason: the filename is printed on the line reporting the
    save and then written to the author's disk, so an override in it reverses
    the report of what just landed.

    A NAME AND A SHAPE ARE ONE SUBJECT HERE, which is why the last two rows are
    in this table rather than in a test of their own: both say "the hub checks
    this at publish time, so this answer did not come from a build it
    published", both are staged the same way, and both have to name where in
    the document to look. What they exercise is the other half of the walk —
    the fields it reads BEFORE it has a name to ask `unservable_reason` about.
    """
    model = with_artifacts(tmp_path / "demo")
    revision = publish(model, capsys)

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


@pytest.mark.parametrize("planted,said", [
    ({"parts": []}, "`parts` catalogue"),
    ({"parts": {"lid": "lid.stl"}}, "part 'lid'"),
    ({"views": {}}, "`views` of this build"),
    ({"views": ["assembled"]}, "view #0"),
])
def test_a_document_shaped_wrong_is_refused_rather_than_walked_past(
        hub, tmp_path, capsys, planted, said):
    """THE FOUR NODES THE WALK USED TO STEP OVER IN SILENCE.

    A `parts` that is not an object, a record that is not one, a `views` that
    is not a list, an entry of it that is not an object: each was skipped, and a
    skip is the one outcome this command must not produce. `data/` is writable
    by every build (SPEC §7.4), so one project's build can rewrite another's
    meta.json — and `"parts": []` then fetched the views' two pointers, printed
    "2 files" and exited 0. An author handed an incomplete set of parts, told it
    was complete, with nothing anywhere saying otherwise.

    The hub checks every one of these at publish time (`render._catalogue`,
    `render.build_meta`), which is why the refusal says the same thing the
    file-name one says — this answer did not come from a build the hub
    published — and why the case has to be staged on the volume.

    NOTHING IS FETCHED FIRST: the walk runs before the destination directory is
    made, so a refusal leaves no half-filled directory to be mistaken for a
    complete one.
    """
    model = with_artifacts(tmp_path / "demo")
    revision = publish(model, capsys)

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


def test_the_slot_names_its_job_and_a_revision_names_none(hub, model, capsys):
    """The one field the whole of issue #79 rests on, and its other half.

    The slot's meta.json and a revision's differ in exactly three keys now, and
    `job` is the third: the slot is not addressed by a revision, so no log is
    stored under its name and the JOB that filled it is the only way back to
    one. A revision needs no such field — its log is in the store — and must
    not grow one, because that document is what a build page and every
    comparison read.
    """
    revision = publish(model, capsys)
    # The commit filled the slot with itself (issue #78), so the sources have
    # to move before a `build` is anything but "unchanged, nothing rebuilt".
    (model / "model.py").write_text("# moved on since\n")
    assert run(model, "build") == 0
    job = job_of(capsys.readouterr().out)

    assert slot_meta(hub)["job"] == job
    published = json.loads(
        (hub.project_dir("demo0001") / revision / "meta.json").read_text(
            encoding="utf-8"))
    assert "job" not in published


def test_log_dev_prints_the_log_of_the_job_that_filled_the_slot(hub, model,
                                                                capsys):
    """The command that used to refuse. What comes back is the log of the very
    build whose geometry is in the slot, not `latest`'s under another name."""
    assert run(model, "build") == 0
    job = job_of(capsys.readouterr().out)

    assert run(model, "log", "dev") == 0
    out = capsys.readouterr().out
    assert f"--- build log of job {job} (build, state done) ---" in out
    assert "copying builder" in out
    assert "--- end of build log ---" in out


def test_log_dev_says_when_a_commit_is_what_filled_the_slot(hub, model,
                                                            capsys):
    """A commit copies itself into the slot (issue #78), so `log dev` is often
    a revision's log — and the header has to say so rather than leave the
    reader to work it out from the contents afterwards."""
    assert run(model, "commit") == 0
    out = capsys.readouterr().out
    job, revision = job_of(out), revision_of(out)
    assert slot_meta(hub)["job"] == job

    assert run(model, "log", "dev") == 0
    printed = capsys.readouterr().out
    assert f"--- build log of job {job} (commit {revision}, state done) ---" \
        in printed
    assert "copying builder" in printed


def test_log_dev_of_a_slot_that_does_not_name_a_job(hub, model, capsys):
    """A slot filled before the hub recorded the field. It is not an error on
    the hub's side — the slot is published and serves its geometry — so the
    refusal says what to run rather than sounding like a broken build."""
    assert run(model, "build") == 0
    capsys.readouterr()
    meta = slot_meta(hub)
    del meta["job"]
    slot_meta_path(hub).write_text(json.dumps(meta), encoding="utf-8")

    assert run(model, "log", "dev") == 1
    err = capsys.readouterr().err
    assert "does not say which job filled it" in err
    assert "hammerola build" in err


def test_log_dev_when_the_hub_does_not_have_that_job(hub, model, capsys):
    """A job id means nothing on another hub, and jobs have no retention. The
    refusal names the hub, because the usual cause is that the configured one
    is not the hub that built this."""
    assert run(model, "build") == 0
    capsys.readouterr()
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
    `hammerola build`, and a push fails on the same 401 a moment later."""
    assert run(model, "build") == 0
    capsys.readouterr()
    monkeypatch.setenv("EDIT_TOKEN", "not-the-token")

    assert run(model, "log", "dev") == 1
    err = capsys.readouterr().err
    assert "401" in err and "hammerola login" in err
    assert "does not have it" not in err
    assert "wiped" not in err


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


def test_diff_json_prints_one_document_and_nothing_else(hub, tmp_path, capsys):
    """`--json` is read by a script, so the whole output has to parse.

    Which means the header, the source diff and the "same revision" sentence
    are all absent — none of them is JSON, and any one of them turns the answer
    into text somebody has to strip before parsing it.
    """
    model = make_model(tmp_path / "demo")
    (model / "metrics.json").write_bytes(metrics_bytes(volume=1000.0))
    first = publish(model, capsys)

    (model / "model.py").write_text("import cadquery as cq\n\nBOX = 12\n")
    (model / "metrics.json").write_bytes(metrics_bytes(volume=900.0, code="dd"))
    second = publish(model, capsys)

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
    first = publish(model, capsys)

    # A new revision — the tree changed — whose geometry is identical.
    (model / "notes.txt").write_text("nothing to do with the solid\n")
    second = publish(model, capsys)

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
    first = publish(model, capsys)
    (model / "notes.txt").write_text("nothing to do with the solid\n")
    second = publish(model, capsys)

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
    first = publish(model, capsys)
    (model / "model.py").write_text("import cadquery as cq\n\nBOX = 12\n")
    second = publish(model, capsys)

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
    reach. And the CODE section still prints: it is fetched over requests of its
    own and does not depend on the kernel having survived, so "why did it
    change" must not be swallowed along with "by how much".
    """
    hub = hub_factory(compare_runner=failing_comparer())
    monkeypatch.setenv("HUB_URL", hub.url)
    first = publish(model, capsys)
    (model / "model.py").write_text("import cadquery as cq\n\nBOX = 12\n")
    second = publish(model, capsys)

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
    one `try`. The code diff below is fetched over requests of its own and does
    not depend on the comparison having happened at all, so "why did it change"
    must survive losing "by how much".

    The second assertion is the wait's NOTICES: they go to stderr, as they do in
    `build`, because a line about the connection is not part of the report and
    must not land in the middle of it.
    """
    def lost(self, job_id, *args, on_notice=None, **kw):
        on_notice("the hub stopped answering")
        raise HubError("the wait ran out")

    first = publish(model, capsys)
    (model / "model.py").write_text("import cadquery as cq\n\nBOX = 12\n")
    second = publish(model, capsys)
    # After both publishes, which wait on jobs of their own through this method.
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
    revision = publish(model, capsys)
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
    revision = publish(model, capsys)

    assert run(model, "artifacts", revision) == 0
    fetched = model / sources.SCRATCH_DIR / f"artifacts-{revision[:12]}"
    assert sorted(p.name for p in fetched.iterdir()) == FETCHED


def test_a_metrics_body_that_blows_the_JSON_parser_is_not_a_traceback():
    """The third copy of one hole, and the reason it is worth naming: `_metrics`
    reads a body off the wire exactly like `hub._payload` and
    `hub._carries_the_hubs_error_shape`, and all three caught
    `(ValueError, UnicodeDecodeError)`.

    `json.loads` recurses per nesting level, so `[[[[...]]]]` raises
    `RecursionError` instead — 400 kB of brackets, against a reply ceiling
    measured in megabytes — and it escaped `cli.main`, which catches five
    exception classes and not that one. Fixing two of three would have left the
    rule reading as local to one file.
    """
    from hammerola import revdiff

    class Stub:
        def build_file(self, pid, revision, name):
            return b"[" * 200000 + b"]" * 200000

    assert revdiff._metrics(Stub(), "demo0001", "abcdef123456") is None
