"""What goes into the archive, and what the client refuses to send at all.

Two kinds of claim here, and they are answered differently on purpose:

  * a name the hub CANNOT accept but every repository has — anything hidden —
    is dropped silently. Refusing would make no ordinary checkout publishable;
  * a name the hub cannot accept that is NOT ordinary is a refusal, naming the
    file. Skipping it would produce a build missing a file, which fails later,
    inside the hub, as a confusing message about an import.

And a refusal names EVERYTHING at once — the second half of this file is about
nothing else (issue #42). One run has to be enough to fix the tree,
because the real case is nineteen cyrillic file names in a `ref/` and refusing
one at a time turned one rename job into nineteen pushes.

The archive itself is checked by unpacking it with the same `tarfile` the hub
opens it with, so what is asserted is the bytes that would be sent.
"""

import io
import os
import tarfile
from pathlib import Path

import pytest
from modeldir import make_model

from hammerola.limits import MAX_MEMBERS, MAX_PATH_DEPTH
from hammerola.pack import (MAX_REFUSAL_PATH_CHARS, MAX_REFUSALS_LISTED,
                            PackError, collect, pack)


def members(root, **kw):
    """The member names inside the real archive, in the order tar holds them."""
    archive = pack(root, **kw)
    with tarfile.open(fileobj=io.BytesIO(archive.body), mode="r:gz") as tar:
        return [info.name for info in tar]


def listed_paths(message):
    """Every path a refusal message LISTS, as opposed to merely mentions.

    A refusal indents its group headlines by two spaces and the paths under them
    by four, so this is the whole parse. Worth having rather than asserting on
    substrings: `_out` is a substring of `_out.tar.gz`, and a path that happens
    to be the last line of the message has no newline after it — both of which
    made an earlier version of these tests pass and fail for the wrong reasons.

    What comes back is what is PRINTED, quotes and escapes included, so compare
    against `shown(...)` rather than against a bare path.
    """
    return [line[4:] for line in message.splitlines()
            if line.startswith("    ") and not line[4:].startswith("...")]


def shown(path):
    """One path as a refusal prints it — escaped, and quoted by `repr`."""
    return repr(path)


def advice_for(message, path):
    """The group HEADLINE a path is listed under, i.e. the advice it was given.

    `listed_paths` answers whether a path was named at all; this answers the
    question that actually decides whether the message is useful, which is what
    the reader is told to DO about it. A path in the wrong group is named
    correctly and instructed wrongly, and every assertion on substrings alone
    passes right through that.

    The parse is the message's own indentation: a headline is indented two
    spaces, the paths under it four.

    A LISTED LINE IS NOT ALWAYS JUST THE PATH, which an exact comparison here
    got wrong: a refusal may carry a `detail`, and the `unreadable` group is the
    one that does — `    'locked' ('Permission denied')`. So the only group whose
    lines have the other shape was invisible to this, silently, as a `None` that
    reads exactly like "that path was never listed". Matched by prefix instead,
    and the detail's ` (` is required rather than assumed: `repr` closes every
    path with a quote, so `'_out'` cannot prefix `'_out.tar.gz'`, but a bare
    `startswith` would still be one rule looser than the message's own shape.
    """
    headline = None
    for line in message.splitlines():
        if line.startswith("  ") and not line.startswith("   "):
            headline = line.strip()
        elif line.startswith("    ") and (line[4:] == path
                                          or line[4:].startswith(path + " (")):
            return headline
    return None


# -- what is packed ----------------------------------------------------------
def test_the_source_tree_is_packed_with_relative_paths(tmp_path):
    root = make_model(tmp_path / "demo", extra={
        "scripts/gen.py": "print('hi')\n",
        "ref/vendor/part.step": "ISO-10303-21;\n",
    })
    # `lid.stl` and `pin.stl` are the exports the model directory's own
    # catalogue names (`modeldir.make_model`), not something the packer added.
    assert members(root) == [
        "assembled.json", "lid.stl", "meta.json", "model.py", "pin.stl",
        "project.json", "ref/vendor/part.step", "scripts/gen.py",
    ]


def test_hidden_entries_are_dropped_rather_than_refused(tmp_path):
    """Every one of these is a name `SAFE_COMPONENT` forbids and every
    repository has. `.env` is the one that matters most: it is where the publish
    token lives on a laptop, and it must never leave the machine."""
    root = make_model(tmp_path / "demo")
    (root / ".git").mkdir()
    (root / ".git" / "config").write_text("[core]\n")
    (root / ".venv").mkdir()
    (root / ".venv" / "pyvenv.cfg").write_text("home = /usr\n")
    (root / ".gitignore").write_text("_out/\n")
    (root / ".env").write_text("EDIT_TOKEN=super-secret\n")
    (root / ".DS_Store").write_bytes(b"\x00\x01")
    # An AppleDouble sidecar: what macOS `tar` adds beside a file carrying an
    # extended attribute, and the reason this tool never shells out to tar.
    (root / "._model.py").write_bytes(b"\x00\x05\x16\x07")

    packed = pack(root)
    assert packed.names == ("assembled.json", "lid.stl", "meta.json",
                            "model.py", "pin.stl", "project.json")
    assert b"super-secret" not in packed.body


def test_build_output_and_caches_are_dropped(tmp_path):
    """Every name here is one that COMES BACK — which is the whole list's rule."""
    root = make_model(tmp_path / "demo")
    for directory in ("__pycache__", "out", "build", "node_modules"):
        (root / directory).mkdir()
        (root / directory / "junk.json").write_text("{}")
    (root / "model.pyc").write_bytes(b"\x00")
    (root / "model.py~").write_text("older\n")

    assert members(root) == ["assembled.json", "lid.stl", "meta.json",
                             "model.py", "pin.stl", "project.json"]


def test_the_old_publishers_output_is_refused_rather_than_dropped(tmp_path):
    """`_out` is off the exclusion list now, and being refused is the point.

    NOT BECAUSE NOTHING WRITES IT ANY MORE — `make build` in a model repository
    still does, from the Makefile the project template hands out, and this client
    has no local build to replace it with, so an author who runs the geometry
    before publishing meets this refusal after every build. The list is off by a
    different rule: it exists for what the author's OWN tools regenerate, and
    `_out` belongs to the publisher this client replaces (`cad_publish`, moved
    into the hub by SPEC 8A.2 step 3). Excluding it would mean packing by the
    conventions of the thing being retired — and silently, so a push goes out
    while its author believes the `_out/` on screen went with it.

    AND BOTH HALVES OF THE PAIR HAVE TO BE TOLD THE SAME THING, which is the part
    naming the paths does not check. `_out.tar.gz` is a FILE, so it landed in a
    group whose only instruction was "rename them" — wrong advice for build
    output, and wrong for the half of the pair a listing puts first at that. The
    group it is in and the sentence over that group are therefore asserted, not
    just the line with its name on it.
    """
    root = make_model(tmp_path / "demo")
    (root / "_out").mkdir()
    (root / "_out" / "model.stl").write_text("solid\n")
    (root / "_out.tar.gz").write_bytes(b"\x1f\x8b")

    with pytest.raises(PackError) as caught:
        collect(root)
    message = str(caught.value)
    listed = listed_paths(message)
    assert shown("_out") in listed      # the directory, named in its own right
    assert shown("_out.tar.gz") in listed
    # And nothing from inside it: `_out/` is deleted, not descended into.
    assert shown("_out/model.stl") not in listed

    # The pair is in two groups — a file and a directory — and BOTH sentences
    # have to offer deleting it, or one half of one leftover is told to rename
    # something it should throw away.
    for path in ("_out", "_out.tar.gz"):
        advice = advice_for(message, shown(path))
        assert advice is not None, f"{path} was named under no group at all"
        assert "delete" in advice, f"{path} was only told to rename: {advice}"
    assert (advice_for(message, shown("_out"))
            != advice_for(message, shown("_out.tar.gz"))), (
        "the file and the directory ended up in one group")


def test_two_runs_over_an_unchanged_tree_produce_the_same_bytes(tmp_path):
    """Ownership and mtime are scrubbed, and the member order is sorted.

    Not something the hub cares about — it hashes file CONTENTS — but it is what
    makes "did anything change" answerable locally by comparing two archives.
    """
    root = make_model(tmp_path / "demo")
    assert pack(root).body == pack(root).body


def test_the_archive_carries_nothing_about_the_machine(tmp_path):
    root = make_model(tmp_path / "demo")
    with tarfile.open(fileobj=io.BytesIO(pack(root).body), mode="r:gz") as tar:
        for info in tar:
            assert (info.uid, info.gid, info.uname, info.gname) == (0, 0, "", "")
            assert info.mtime == 0
            assert info.isfile()


# -- what is refused ---------------------------------------------------------
def test_a_name_the_hub_cannot_accept_is_refused_by_name(tmp_path):
    root = make_model(tmp_path / "demo")
    (root / "My Model.py").write_text("x = 1\n")
    with pytest.raises(PackError) as caught:
        collect(root)
    assert "My Model.py" in str(caught.value)


def test_a_symlink_is_refused_rather_than_followed(tmp_path):
    outside = tmp_path / "outside.py"
    outside.write_text("secret = 1\n")
    root = make_model(tmp_path / "demo")
    (root / "linked.py").symlink_to(outside)
    with pytest.raises(PackError) as caught:
        collect(root)
    assert "linked.py" in str(caught.value)
    assert "symlink" in str(caught.value)


def test_a_tree_deeper_than_the_hub_accepts_is_refused(tmp_path):
    """MAX_PATH_DEPTH counts the file name too, so eight components is the
    deepest member and the ninth level is where this has to stop."""
    root = make_model(tmp_path / "demo")
    deep = root.joinpath(*[f"d{n}" for n in range(MAX_PATH_DEPTH)])
    deep.mkdir(parents=True)
    (deep / "part.py").write_text("x = 1\n")
    with pytest.raises(PackError) as caught:
        collect(root)
    assert str(MAX_PATH_DEPTH) in str(caught.value)


def test_a_member_at_exactly_the_ceiling_is_accepted(tmp_path):
    root = make_model(tmp_path / "demo")
    deep = root.joinpath(*[f"d{n}" for n in range(MAX_PATH_DEPTH - 1)])
    deep.mkdir(parents=True)
    (deep / "part.py").write_text("x = 1\n")
    names = members(root)
    assert any(name.count("/") == MAX_PATH_DEPTH - 1 for name in names)


def test_too_many_files_are_refused_before_anything_is_sent(tmp_path):
    root = make_model(tmp_path / "demo")
    for index in range(MAX_MEMBERS):
        (root / f"part{index:04d}.py").write_text("x = 1\n")
    with pytest.raises(PackError) as caught:
        collect(root)
    assert str(MAX_MEMBERS) in str(caught.value)


def test_a_tree_over_the_size_ceiling_is_refused(tmp_path):
    root = make_model(tmp_path / "demo")
    (root / "big.bin").write_bytes(b"\x00" * 4096)
    with pytest.raises(PackError) as caught:
        pack(root, max_bytes=1024)
    assert "ceiling" in str(caught.value)


@pytest.mark.skipif(os.geteuid() == 0,
                    reason="root reads a 0000 directory regardless of its mode")
def test_a_directory_that_cannot_be_listed_is_refused_by_name(tmp_path):
    """An unreadable subdirectory is a message, not a traceback.

    `cli.main` prints exactly five exception families as a sentence, and an
    `OSError` out of `iterdir` is not one of them — so before this the whole
    command ended in a traceback that did not even name the directory, for
    somebody whose real problem is one `chmod`.

    THE GROUP IS ASSERTED, not just the name, and this is the one case where
    doing so exercises something extra: a line here carries the errno's text
    beside the path, so it is the only group whose listed lines are not the path
    alone. `advice_for` compared the whole line for equality once, which made
    exactly this group unreachable — and unreachable as a `None` indistinguishable
    from "never listed at all".
    """
    root = make_model(tmp_path / "demo")
    locked = root / "ref"
    locked.mkdir()
    (locked / "part.step").write_text("ISO-10303-21;\n")
    locked.chmod(0o000)
    try:
        with pytest.raises(PackError) as caught:
            collect(root)
        message = str(caught.value)
        assert "ref" in message
        advice = advice_for(message, shown("ref"))
        assert advice is not None, (
            f"the locked directory was named under no group at all: {message}")
        assert "cannot be listed" in advice
    finally:
        # Restored whatever the assertion did, or pytest cannot clean tmp_path.
        locked.chmod(0o755)


def test_the_detail_beside_a_refused_path_is_escaped_and_cut_like_the_path(
        tmp_path, monkeypatch):
    """`detail` was the one string a message printed exactly as it arrived.

    The whole point of `_shown` is to be the single door every refused path goes
    through, and this went round it: `_walk` records `error.strerror or
    str(error)` for a directory it cannot list, and the fallback half of that is
    an OSError's own text, which repeats the FULL PATH it was raised for. So a
    directory whose name carries an escape sequence cleared the terminal through
    the one line nothing escaped — and an OSError with a long message printed all
    of it, under a group whose every other line is capped at
    MAX_REFUSAL_PATH_CHARS.

    The fallback is what has to be provoked, since `strerror` is set for every
    ordinary errno: an OSError built with a single argument has no errno and no
    `strerror`, which is what this raises.
    """
    root = make_model(tmp_path / "demo")
    (root / "ref").mkdir()
    hostile = "\x1b[2Jwiped\r" + "z" * 5000
    real_iterdir = Path.iterdir

    def failing(self):
        if self.name == "ref":
            raise OSError(hostile)
        return real_iterdir(self)

    monkeypatch.setattr(Path, "iterdir", failing)

    with pytest.raises(PackError) as caught:
        collect(root)
    message = str(caught.value)

    line = next(entry for entry in listed_paths(message)
                if entry.startswith(shown("ref")))
    # Escaped: neither the terminal-clearing sequence nor the carriage return
    # reaches the terminal as itself.
    assert "\x1b" not in message and "\r" not in message
    # And cut: the detail is held to the same ceiling as the path beside it.
    detail = line[len(shown("ref")):]
    assert detail.startswith(" (") and detail.endswith(")")
    assert len(detail) - len(" ()") <= MAX_REFUSAL_PATH_CHARS


def test_an_empty_tree_is_refused(tmp_path):
    """The hub answers 422 "archive is empty"; there is no reason to make it."""
    root = tmp_path / "nothing"
    root.mkdir()
    (root / ".hidden").write_text("x\n")
    with pytest.raises(PackError):
        collect(root)


# -- one message, every path (issue #42) -----------------------------
def test_every_unpublishable_name_arrives_in_one_message(tmp_path):
    """The case this was written for, at its real size: nineteen of them.

    Nineteen files with cyrillic names in a `ref/`, on the project
    `clay-settler`. Before this the author learned about one per push.
    """
    root = make_model(tmp_path / "demo")
    (root / "ref").mkdir()
    names = [f"сифон-{index}-чертёж.jpg" for index in range(19)]
    for name in names:
        (root / "ref" / name).write_text("x\n")

    with pytest.raises(PackError) as caught:
        collect(root)
    message = str(caught.value)
    assert [name for name in names if f"ref/{name}" not in message] == []


def test_an_unpublishable_directory_name_is_a_group_of_its_own(tmp_path):
    """What forces the split is NOT the instruction — both groups offer both.

    `чертежи/` is a directory the author wants published, so it gets renamed;
    `_out/` is what a local `make build` writes, so it gets deleted. Nothing
    visible from here tells the two apart, so each group says both — the file
    group included, since `_out.tar.gz` is a file (see the build-output test
    above).

    The directory group exists for the thing only a directory has: the walk does
    NOT go inside one, so dealing with it uncovers more, and its sentence has to
    say so. That costs the `чертежи/` case an extra round, and it is the right
    trade: going inside `_out/` would print a line per file about renaming files
    that are about to be deleted — on a real project, dozens of them, since a
    part's name may perfectly well be cyrillic.
    """
    root = make_model(tmp_path / "demo")
    (root / "чертежи").mkdir()
    (root / "чертежи" / "план.step").write_text("x\n")
    (root / "чертежи" / "fine.step").write_text("x\n")
    (root / "My Model.py").write_text("x = 1\n")

    with pytest.raises(PackError) as caught:
        collect(root)
    message = str(caught.value)
    listed = listed_paths(message)
    assert shown("чертежи") in listed
    assert shown("My Model.py") in listed
    # Both groups offer deleting; only the directory one can say that what is
    # under it was never looked at, which is the reason it is a group at all.
    assert "delete" in advice_for(message, shown("чертежи"))
    assert "delete" in advice_for(message, shown("My Model.py"))
    assert "inside" in advice_for(message, shown("чертежи"))
    # Nothing from inside it, whether its own name is usable or not.
    assert [path for path in listed if "чертежи/" in path] == []
    # And the two are not in the same section, so neither instruction is
    # attached to the other's paths.
    dir_group = message.index("These directories cannot be published")
    assert message.index("These files cannot be published") < dir_group
    assert message.index("My Model.py") < dir_group < message.index("чертежи")


def test_refusals_of_every_kind_arrive_together(tmp_path):
    """A bad name, a symlink and a too-deep directory in ONE answer.

    None of these kinds is allowed to end the walk on its own: an author who has
    a symlink AND nineteen bad names would otherwise fix the symlink, push, and
    only then hear about the names — the same defect wearing a different hat.
    """
    outside = tmp_path / "outside.py"
    outside.write_text("secret = 1\n")
    root = make_model(tmp_path / "demo")
    (root / "My Model.py").write_text("x = 1\n")
    (root / "linked.py").symlink_to(outside)
    deep = root.joinpath(*[f"d{n}" for n in range(MAX_PATH_DEPTH)])
    deep.mkdir(parents=True)
    (deep / "part.py").write_text("x = 1\n")

    with pytest.raises(PackError) as caught:
        collect(root)
    message = str(caught.value)
    assert "My Model.py" in message
    assert "linked.py" in message and "symlink" in message
    assert f"d{MAX_PATH_DEPTH - 1}" in message
    assert str(MAX_PATH_DEPTH) in message


def test_nothing_below_a_too_deep_directory_is_reported(tmp_path):
    """The one refusal that does NOT walk on, and the reason is not tidiness.

    Flattening the tree destroys every path underneath it, so names collected
    from down there are advice about paths that are about to stop existing. The
    depth ceiling is also the only thing bounding the recursion.
    """
    root = make_model(tmp_path / "demo")
    deep = root.joinpath(*[f"d{n}" for n in range(MAX_PATH_DEPTH)])
    deep.mkdir(parents=True)
    (deep / "My Buried Model.py").write_text("x = 1\n")

    with pytest.raises(PackError) as caught:
        collect(root)
    assert "My Buried Model.py" not in str(caught.value)


def test_the_number_of_paths_one_group_lists_is_capped(tmp_path):
    """A wall of text is not a to-do list, and the tail says what to do instead."""
    over = 5
    root = make_model(tmp_path / "demo")
    for index in range(MAX_REFUSALS_LISTED + over):
        (root / f"bad name {index:04d}.py").write_text("x = 1\n")

    with pytest.raises(PackError) as caught:
        collect(root)
    message = str(caught.value)
    assert message.count("bad name ") == MAX_REFUSALS_LISTED
    assert f"and {over} more" in message


def test_a_refused_path_is_escaped_before_it_reaches_the_terminal(tmp_path):
    """The names in a model directory are NOT the author's own.

    A model directory is normally a clone, so putting a file into one takes no
    vulnerability at all. `\\x1b[2J` clears the terminal and `\\r` rewrites the
    line that was supposed to report the file, so an unescaped refusal is a way
    to hide what it just said — and a name with a newline in it breaks the
    indentation this message is read by, and the parse above with it.
    """
    root = make_model(tmp_path / "demo")
    (root / "\x1b[2Jwiped\rboom.py").write_text("x = 1\n")
    (root / "two\nlines.py").write_text("x = 1\n")

    with pytest.raises(PackError) as caught:
        collect(root)
    message = str(caught.value)

    assert "\x1b" not in message and "\r" not in message
    assert "\\x1b" in message and "\\r" in message
    # The newline is escaped rather than printed, so the message still has one
    # line per path and the group structure survives.
    assert "\\n" in message
    assert len(listed_paths(message)) == 2


def test_a_refused_path_that_is_very_long_is_cut(tmp_path):
    """Escaping expands, so the ceiling is applied to the escaped form — the
    same two-step as the hub's, for the same reason."""
    root = make_model(tmp_path / "demo")
    (root / ("\x1b" * 200 + ".py")).write_text("x = 1\n")

    with pytest.raises(PackError) as caught:
        collect(root)

    for path in listed_paths(str(caught.value)):
        assert len(path) <= MAX_REFUSAL_PATH_CHARS


def test_a_file_that_is_not_a_regular_file_is_named_with_the_rest(tmp_path):
    """The `special` group, which nothing else here reaches.

    A fifo is the easy one to make; a socket or a device node lands in the same
    branch. It is collected rather than raised for the same reason as all the
    others — an author who has one AND a bad name should hear both once.
    """
    root = make_model(tmp_path / "demo")
    os.mkfifo(root / "pipe")
    (root / "My Model.py").write_text("x = 1\n")

    with pytest.raises(PackError) as caught:
        collect(root)
    message = str(caught.value)
    assert "pipe" in message
    assert "regular file" in message
    assert "My Model.py" in message


def test_every_kind_the_walk_can_produce_has_a_group(tmp_path):
    """A kind with no group would vanish from the message.

    `_refusal_message` walks REFUSAL_GROUPS, so a `Refusal` kind that is not in
    that tuple prints nothing while `collect` still refuses — a header over an
    empty list, or no section at all. The code has a last-resort group for it;
    this is what makes the mismatch fail at the commit instead.
    """
    import ast
    import inspect

    from hammerola import pack as pack_module

    tree = ast.parse(inspect.getsource(pack_module))
    produced = {
        node.args[0].value
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "Refusal"
        and node.args
        and isinstance(node.args[0], ast.Constant)
    }
    assert produced, "no Refusal(...) call found — this test stopped looking"
    assert produced == {kind for kind, _ in pack_module.REFUSAL_GROUPS}


def test_a_kind_with_no_group_is_still_printed(tmp_path, monkeypatch):
    """What the code does on the day the test above is not yet green."""
    from hammerola import pack as pack_module

    monkeypatch.setattr(
        pack_module, "REFUSAL_GROUPS",
        tuple(group for group in pack_module.REFUSAL_GROUPS
              if group[0] != "symlink"))
    outside = tmp_path / "outside.py"
    outside.write_text("secret = 1\n")
    root = make_model(tmp_path / "demo")
    (root / "linked.py").symlink_to(outside)

    with pytest.raises(PackError) as caught:
        collect(root)
    message = str(caught.value)
    assert "linked.py" in message
    assert pack_module.UNGROUPED_HEADLINE in message


def test_a_tree_of_nothing_but_bad_names_is_not_called_empty(tmp_path):
    """`found` ends up empty here, and "everything is hidden or excluded" would
    send the author off to read a `.gitignore` that has nothing to do with it."""
    root = tmp_path / "demo"
    root.mkdir()
    (root / "модель.py").write_text("x = 1\n")

    with pytest.raises(PackError) as caught:
        collect(root)
    message = str(caught.value)
    assert "модель.py" in message
    assert "no source files" not in message
