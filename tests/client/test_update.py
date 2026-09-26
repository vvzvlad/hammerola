"""`hammerola update`, and the refusal that sends somebody to it.

WHAT IS WORTH PINNING HERE, in the order it would hurt to get wrong:

  * the WRITE. This verb replaces the running program, and the machine it hurts
    is the one that cannot fetch a replacement — the tool that fetches IS the
    file being written. So the mode has to survive (a client without its execute
    bit is as gone as a truncated one), nothing may be left beside it, and a
    target that cannot be written has to be a sentence rather than an OSError
    out of a temporary-file helper;
  * the CHECK BEFORE IT, because what lands on PATH is whatever came off the
    wire. A proxy's login page carrying a 200 must not become the tool;
  * the RANGE of the changelog. Off by one in either direction and every update
    either repeats what the reader already knew or silently hides the change it
    was run for;
  * the REFUSAL to publish, in both directions: behind is stopped and named,
    ahead is not — the author's own checkout is routinely newer than the hub it
    pushes to, and a client that refused there would be unusable on the machine
    that builds the hub.

THE LAST TEST RUNS THE REAL ZIPAPP, out of a process that cannot see this
checkout, and it is the only one that can speak for `_target`: which file this
tool writes over is decided by where `hammerola/update.py` was imported FROM, so
every in-process test here is running from the package and has to be told the
target instead. Zipimport is the thing under test there, and it cannot be
simulated by a monkeypatch.
"""

import errno
import io
import os
import re
import stat
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from modeldir import make_model

from src import onboarding
from hammerola import VERSION, changelog, config, update
from hammerola import hub as hub_module
from hammerola.cli import main
from hammerola.errors import ClientError

# The address and the token, from tests/client/conftest.py (issue #99). The
# token is for the publishing half of this file only: `update` itself presents
# none — `/start` and the client it names are public on purpose, and a machine
# whose tool is too old to publish may be one that was never logged in.
pytestmark = pytest.mark.usefixtures("configured")

ROOT = Path(update.__file__).resolve().parent.parent


@pytest.fixture
def installed(tmp_path):
    """A client on this machine's PATH, executable, ready to be replaced."""
    path = tmp_path / "bin" / "hammerola"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"#!/usr/bin/env python3\nthe old client\n")
    path.chmod(0o755)
    return path


@pytest.fixture
def target(monkeypatch, installed):
    """...and the file `update` will write, since this process is a package.

    Every in-process test needs this: `_target` reads `__file__`, which here is
    the checkout, so the real one refuses (see the test that says so). What is
    left under test is everything after that decision.
    """
    monkeypatch.setattr(update, "_target", lambda: installed)
    return installed


def rebuilt(version, entries=None):
    """The client the hub really serves, restated as a different version.

    Rebuilt from the served archive rather than invented, so what a test hands
    over is a working zipapp differing in exactly the one member the code under
    test reads — which is what a real release is.
    """
    served = onboarding.client_bytes()
    inner = io.BytesIO(served[len(onboarding.CLIENT_SHEBANG):])
    out = io.BytesIO()
    with zipfile.ZipFile(inner) as source, \
            zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as target:
        for info in source.infolist():
            data = source.read(info.filename)
            if info.filename == update.VERSION_MEMBER:
                data, count = re.subn(rb'(?m)^VERSION = "[^"]*"$',
                                      f'VERSION = "{version}"'.encode(), data)
                assert count == 1, (
                    f"{update.VERSION_MEMBER} no longer states VERSION as a "
                    f"plain literal, so this helper is rebuilding nothing")
            elif info.filename == update.CHANGELOG_MEMBER and entries is not None:
                data = f"{update.CHANGELOG_NAME} = {entries!r}\n".encode()
            target.writestr(info, data)
    return onboarding.CLIENT_SHEBANG + out.getvalue()


# -- reading a version, and the range of what changed ------------------------
@pytest.mark.parametrize("text,expected", [
    ("0.1.0", (0, 1, 0)),
    ("1.20.3", (1, 20, 3)),
    ("2", (2,)),
    ("", None),
    ("0.1.0a1", None),
    ("v0.1.0", None),
    ("0.1.", None),
    (None, None),
    (3, None),
])
def test_a_version_is_integers_and_dots_and_anything_else_is_not_one(text,
                                                                      expected):
    """None rather than a raise, because both readers are reading a number
    written somewhere else — a hub's manifest and a downloaded archive — and
    what they do about one they cannot order is documented: nothing."""
    assert changelog.as_tuple(text) == expected


BOOK = {
    "0.1.0": ("one",),
    "0.2.0": ("two",),
    "0.10.0": ("ten",),
    "1.0.0": ("hundred",),
}


@pytest.mark.parametrize("old,new,expected", [
    # The ordinary case, and the one that says which end is open: the reader has
    # already lived with its own entry, and has not seen the one it is moving to.
    ("0.1.0", "0.2.0", ["two"]),
    ("0.1.0", "1.0.0", ["two", "ten", "hundred"]),
    # Ordered as integers and never as text, or 0.10.0 sorts before 0.2.0.
    ("0.2.0", "0.10.0", ["ten"]),
    ("0.1.0", "0.1.0", []),
    # Ahead of the hub: nothing to say, and nothing invented to say.
    ("1.0.0", "0.2.0", []),
    # A version with no entry of its own is not a hole in the range.
    ("0.1.0", "0.3.0", ["two"]),
    (None, "1.0.0", []),
    ("0.1.0", "not-a-version", []),
])
def test_the_entries_are_strictly_after_the_old_version_and_up_to_the_new(
        old, new, expected):
    assert [line for _v, lines in changelog.between(BOOK, old, new)
            for line in lines] == expected


def test_an_entry_filed_under_something_that_is_not_a_version_is_skipped():
    """This dict arrives out of an archive newer than the code reading it, so a
    key added to the file later must not stop the rest from being printed."""
    book = dict(BOOK, unreleased=("nothing",))
    assert [line for _v, lines in changelog.between(book, "0.2.0", "1.0.0")
            for line in lines] == ["ten", "hundred"]


def test_the_shipped_changelog_is_shaped_the_way_the_reader_expects():
    """The printer walks the values, so a bare string in one is printed a
    character per line — by a client too old to have been written against it,
    which is the only kind of client that ever reads this file."""
    for version, lines in changelog.ENTRIES.items():
        assert changelog.as_tuple(version) is not None, (
            f"{version!r} is not a version, so no client can place it")
        assert isinstance(lines, tuple), (
            f"the entry for {version} is {type(lines).__name__} and not a "
            f"tuple of lines")
        assert lines and all(isinstance(line, str) and line for line in lines)


def test_the_version_this_client_is_has_an_entry_of_its_own():
    """THE RANGE OF THE CHANGELOG, from the other end (issue #98).

    The test above holds the SHAPE of what is in `ENTRIES` and would pass on an
    empty dict. What an update prints, though, is the entries strictly after the
    running version and up to the one it fetched — so the release that ships a
    version and does not file it here is the release whose own change is the one
    nobody is told about.

    THE FAILURE IS A RUN THAT LOOKS LIKE IT WORKED. `_print_changes` returns
    silently on an empty range, so `hammerola update` prints "version X ->
    version Y" and then nothing at all: the agent it replaced itself under reads
    that as "nothing about the interface moved" and goes on writing the flags it
    knew. Nothing fails, and the one moment the reader was going to look is
    spent.

    The pairing is between this checkout's two halves — the VERSION the tool
    states and the book it ships beside it — because the client that prints the
    line reads both out of the archive it downloaded.
    """
    assert VERSION in changelog.ENTRIES, (
        f"this client calls itself {VERSION} and `changelog.ENTRIES` has no "
        f"entry under that version, so `hammerola update` onto it prints "
        f"'version <old> -> version {VERSION}' with nothing under it — an "
        f"update that says, to the one reader it has, that nothing changed")


# -- which file this writes over ---------------------------------------------
def test_a_tool_running_out_of_a_package_directory_has_nothing_to_write_over():
    """THE STATE THIS SUITE IS IN, which is what makes it worth asserting here:
    the checkout and an installed distribution both put this module inside a
    package DIRECTORY, and only the zipapp puts it inside a file. Neither of the
    two is updatable by this verb, and what they must get is the sentence naming
    the tool that does update them — not a traceback out of a rename."""
    with pytest.raises(ClientError) as raised:
        update._target()

    message = str(raised.value)
    assert str(ROOT) in message
    assert "not the one-file client" in message
    assert "Nothing was fetched" in message


def test_the_write_keeps_the_mode_it_found_and_leaves_nothing_beside_it(
        installed):
    """THE EXECUTE BIT IS THE POINT. A temporary file is created 0600, so a
    client written the obvious way comes back not executable — and a `hammerola`
    on PATH that cannot be run is exactly as broken as one that is half
    written, with the further problem that the tool which would fix it is the
    one that just broke."""
    update._write_over(installed, b"#!/usr/bin/env python3\nthe new client\n")

    assert installed.read_bytes().endswith(b"the new client\n")
    assert stat.S_IMODE(installed.stat().st_mode) == 0o755
    assert [entry.name for entry in installed.parent.iterdir()] == ["hammerola"]


@pytest.mark.skipif(os.geteuid() == 0,
                    reason="root writes a directory regardless of its mode")
def test_a_target_that_cannot_be_written_is_a_sentence_and_not_a_traceback(
        installed):
    """A client installed where the account cannot write is the ordinary case —
    `/usr/local/bin` put there by somebody with root — and it fails on the
    DIRECTORY rather than on the file, because that is what a rename needs. What
    it has to produce is one line naming the file and the old client still
    there."""
    installed.parent.chmod(0o500)
    try:
        with pytest.raises(ClientError) as raised:
            update._write_over(installed, b"the new client\n")
    finally:
        installed.parent.chmod(0o700)

    message = str(raised.value)
    assert str(installed) in message
    assert "Nothing was written" in message
    assert installed.read_bytes().endswith(b"the old client\n")


def test_a_write_that_fails_halfway_leaves_no_temporary_beside_the_client(
        installed, monkeypatch):
    """The rollback branch, which the test above never reaches.

    An unwritable DIRECTORY fails in `mkstemp`, before there is anything to
    clean up. The branch that matters is the other one — the temporary file
    exists, and then the disk fills or the rename is refused. What must not
    happen is `hammerola.ab12cd.new` left sitting next to the tool: the account
    that finds it cannot tell whether it is a broken client or a spare one, and
    the sentence the failure printed said nothing about a file it did not
    name.
    """
    def full_disk(*_args):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(os, "replace", full_disk)

    with pytest.raises(ClientError) as raised:
        update._write_over(installed, b"#!/usr/bin/env python3\nthe new one\n")

    assert "Nothing was written" in str(raised.value)
    assert [entry.name for entry in installed.parent.iterdir()] == ["hammerola"]
    assert installed.read_bytes().endswith(b"the old client\n")
    assert stat.S_IMODE(installed.stat().st_mode) == 0o755


# -- `hammerola update` against a real hub -----------------------------------
def test_update_writes_the_hubs_client_over_the_running_file(hub, target,
                                                             capsys):
    assert main(["update"]) == 0

    assert target.read_bytes() == hub.get("/start/hammerola").content
    assert stat.S_IMODE(target.stat().st_mode) == 0o755
    out = capsys.readouterr().out
    assert str(target) in out
    assert f"version {VERSION}" in out


def test_update_over_a_client_of_the_same_version_says_it_was_unchanged(
        target, capsys):
    """It writes anyway — the verb is "make this the hub's copy", not "apply a
    difference" — and says the version did not move, so a re-run does not read
    as though it had fixed something."""
    assert main(["update"]) == 0
    assert "unchanged" in capsys.readouterr().out


def test_update_prints_what_changed_between_the_two_versions(monkeypatch,
                                                             target, capsys):
    """THE OUTPUT THE VERB EXISTS FOR, and its reader is a program that has just
    been replaced under itself: what it needs is the statements about the
    interface between the version it WAS and the version it now is.

    Read out of the archive that was downloaded, which is the only place they
    can come from — the running client's own copy of the changelog knows nothing
    about the versions that came after it, so printing from there would print
    nothing, always.
    """
    doctored = rebuilt("9.9.9", entries={
        "9.9.9": ("`hammerola frobnicate` is gone; use `build`.",),
        "0.0.1": ("something the running client has already lived with",),
    })
    monkeypatch.setattr(onboarding, "client_bytes", lambda: doctored)

    assert main(["update"]) == 0

    out = capsys.readouterr().out
    assert f"version {VERSION} -> version 9.9.9" in out
    assert "9.9.9: `hammerola frobnicate` is gone; use `build`." in out
    assert "already lived with" not in out, (
        "an entry OLDER than the running client was printed as news")


def test_update_still_installs_a_client_whose_changelog_it_cannot_read(
        monkeypatch, target, capsys):
    """THE ASYMMETRY, asserted rather than left to be discovered. The version is
    what says this is the tool at all and its absence is a refusal; the
    changelog is what the update SAYS afterwards. A release that renamed or
    dropped that module would otherwise be uninstallable by every client alive
    on the day it shipped — a trap laid for the one version nobody can test
    against."""
    doctored = rebuilt("9.9.9", entries="not a table of entries")
    monkeypatch.setattr(onboarding, "client_bytes", lambda: doctored)

    assert main(["update"]) == 0

    assert target.read_bytes() == doctored
    assert "what changed:" not in capsys.readouterr().out


@pytest.mark.parametrize("served,why", [
    (b"<html>you are not signed in</html>\n", "no shebang at all"),
    (b"#!/usr/bin/env python3\nprint('hello')\n", "a script and not a zipapp"),
])
def test_update_refuses_a_download_that_is_not_the_tool(monkeypatch, target,
                                                        capsys, served, why):
    """CHECKED BEFORE IT IS WRITTEN, for the reason `skill update` parses the
    document it is about to install — with more at stake, because what lands
    here goes on PATH under the name of the tool. A proxy's login page and an
    error document carrying a 200 are the two that arrive with a 200."""
    monkeypatch.setattr(onboarding, "client_bytes", lambda: served)
    before = target.read_bytes()

    assert main(["update"]) == 1

    assert target.read_bytes() == before, f"{why} was installed"
    assert "Nothing was written" in capsys.readouterr().err


def test_update_refuses_a_zipapp_that_states_no_version(monkeypatch, target,
                                                        capsys):
    """A zip with a shebang is not evidence of anything much; a version this can
    read is what makes it THIS program. Without it there would also be nothing
    to print, and nothing to compare against on the next push."""
    doctored = rebuilt("not-a-version")
    monkeypatch.setattr(onboarding, "client_bytes", lambda: doctored)
    before = target.read_bytes()

    assert main(["update"]) == 1

    assert target.read_bytes() == before
    assert "no telling what it is" in capsys.readouterr().err


# -- the refusal to publish --------------------------------------------------
def publish(model, *args):
    return main(["-C", str(model), *args, "--timeout", "60"])


@pytest.fixture
def model(tmp_path):
    return make_model(tmp_path / "demo")


@pytest.mark.parametrize("verb", ["build", "commit"])
def test_a_client_older_than_the_hub_refuses_to_publish(hub, monkeypatch, model,
                                                        capsys, verb):
    """BOTH VERSIONS ARE NAMED, because the reader has to be able to tell this
    from "the hub is down" and from "the push was rejected" — and because a
    number it can see is what makes the next line, `hammerola update`, worth
    running rather than worth retrying.

    Nothing is published and nothing is even packed: the question is asked
    before the tree is walked.
    """
    monkeypatch.setattr(onboarding, "CLIENT_VERSION", "9.9.9")

    assert publish(model, verb) == 1

    error = capsys.readouterr().err
    assert f"version {VERSION}" in error
    assert "9.9.9" in error
    assert "hammerola update" in error
    assert not hub.project_dir("demo0001").exists(), "a stale client published"


def test_a_client_newer_than_the_hub_publishes(monkeypatch, model):
    """ONLY BEHIND IS REFUSED. The author's checkout is routinely newer than the
    hub it pushes to — that is what shipping an image looks like from this side
    — and a client that refused in this direction would be unusable on the
    machine that builds the hub."""
    monkeypatch.setattr(onboarding, "CLIENT_VERSION", "0.0.1")

    assert publish(model, "build") == 0


def test_a_hub_that_states_no_client_version_does_not_stop_a_push(monkeypatch,
                                                                   model):
    """An image older than this tool answers a manifest without the key at all,
    and that is not evidence that the laptop is stale. The same reasoning covers
    a hub that cannot be reached: the push itself is about to report it, with
    the message that path already has."""
    real = onboarding.manifest
    monkeypatch.setattr(onboarding, "manifest", lambda *, empty: {
        key: value for key, value in real(empty=empty).items()
        if key != onboarding.CLIENT_VERSION_KEY})

    assert publish(model, "build") == 0


def test_only_the_verbs_that_publish_ask_the_hub_about_the_client(monkeypatch,
                                                                   model):
    """THE COST IS THE WHOLE ARGUMENT: this is one more round trip, and a check
    on every verb would charge `status`, `log` and `comments` for a question
    only a WRITE can get wrong. Counted on the request itself rather than on the
    call site, so moving the call somewhere convenient does not pass.

    AND ON WHAT BUDGET, which is the same argument one step further. The Hub the
    push builds carries `HTTP_TIMEOUT`, five minutes, because the request that
    matters is uploading an archive; asking an 80-byte question with it hangs
    the terminal for five silent minutes on an address that black-holes packets
    — before any output at all, since this runs ahead of `pack()` — and then
    hangs it again on the push. Reusing the caller's Hub is the one-word edit
    that brings that back, and it would pass every other test in this file.
    """
    asked = []
    real = hub_module.Hub.start

    def counted(self):
        asked.append((self.url, self.timeout))
        return real(self)

    monkeypatch.setattr(hub_module.Hub, "start", counted)

    assert publish(model, "build") == 0
    assert asked == [(config.hub_url(model), hub_module.QUERY_TIMEOUT)], (
        "the question a push asks about the client's own version was not sent "
        "to the project's hub on a query's budget")
    asked.clear()

    assert main(["-C", str(model), "status"]) == 0
    assert asked == [], "a reading verb paid for a round trip about itself"


# -- the real thing, replacing itself ----------------------------------------
def test_the_downloaded_client_replaces_itself_and_says_what_changed(hub,
                                                                     tmp_path):
    """THE ONE TEST THAT CAN SPEAK FOR `_target`, and it runs the zipapp.

    Which file this verb writes over is decided by where `hammerola/update.py`
    was imported from: inside the archive, `__file__` is
    `<archive>/hammerola/update.py`, and two parents up is the file on PATH.
    Every other test in here runs out of the checkout, where that same
    expression lands on a directory and the verb refuses — so a `_target` that
    silently resolved to the wrong file, or to nothing, would be invisible to
    all of them.

    The process cannot see this checkout (`-s`, `-E`, an environment built from
    nothing), the tool on disk is the served client restated as an older
    version, and what is asserted afterwards is the whole point of the verb: the
    file is now the hub's, byte for byte, it is still executable, and the run
    said what changed between the two versions out of the changelog inside the
    archive it fetched.
    """
    tool = tmp_path / "bin" / "hammerola"
    tool.parent.mkdir(parents=True)
    tool.write_bytes(rebuilt("0.0.1"))
    tool.chmod(0o755)

    finished = subprocess.run(
        [sys.executable, "-s", "-E", str(tool), "update"],
        capture_output=True, text=True, timeout=120, cwd=str(tmp_path),
        env={"PATH": "/usr/bin:/bin", "HOME": str(tmp_path),
             "HUB_URL": hub.url})

    assert finished.returncode == 0, (
        f"the downloaded client could not update itself:\n{finished.stdout}\n"
        f"{finished.stderr}")
    assert tool.read_bytes() == hub.get("/start/hammerola").content
    assert stat.S_IMODE(tool.stat().st_mode) == 0o755
    assert [entry.name for entry in tool.parent.iterdir()] == ["hammerola"]
    assert f"version 0.0.1 -> version {VERSION}" in finished.stdout
    for _version, lines in changelog.between(changelog.ENTRIES, "0.0.1",
                                             VERSION):
        for line in lines:
            assert line in finished.stdout
