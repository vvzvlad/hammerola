"""The backup copy of a project's code in a third-party forge (`src/mirror.py`).

Driven against a real hub and the real `git`. The forge is a bare repository
on a local path; the hub is told it has a token for some other host, which is
what turns copies on, and a path matches no entry, so it is pushed to without
a header. `wait_idle` waits for the background thread.
"""

import base64
import json
import os
import signal
import socket
import subprocess

import httpx
import pytest
from harness import (TOKEN, commit_all, git, picky_builder, project_files,
                     push, start_hub, stop_hub, write_files)

from src import mirror
from src.settings import Settings

PID = "mirr0001"
CREDENTIALS = "https://alice:alice-token@forge.example"


def project_json(address, title="Demo project"):
    document = {"id": PID, "title": title}
    if address is not None:
        document["mirror"] = address
    return json.dumps(document).encode()


def commit_state(work, address, marker="a"):
    """Commit the project as of `marker`, naming `address` as its copy."""
    write_files(work, {**project_files(PID, marker),
                       "project.json": project_json(address)})
    return commit_all(work, f"state {marker}")


def bare(path):
    git("init", "--quiet", "--bare", "--initial-branch=main", path)
    return path


def ref(repository, name):
    return git("--git-dir", repository, "rev-parse", "--verify", "--quiet",
               name, check=False).stdout.strip()


def refs(repository):
    return set(git("--git-dir", repository, "for-each-ref",
                   "--format=%(refname)").stdout.split())


def copy_line(pushed):
    return [line for line in pushed.stderr.splitlines()
            if line.startswith("remote: copy:")]


@pytest.fixture
def hub(tmp_path):
    hub = start_hub(tmp_path / "data", build_runner=picky_builder(),
                    mirror_credentials=CREDENTIALS)
    yield hub
    stop_hub(hub)


@pytest.fixture
def forge(tmp_path):
    return bare(tmp_path / "forge.git")


@pytest.fixture
def work(tmp_path):
    path = tmp_path / "work"
    git("init", "--quiet", "--initial-branch=main", path)
    return path


def settle(hub):
    assert hub.server.mirror.wait_idle(timeout=60)


def count_sends(monkeypatch):
    """Every `git push --porcelain` the hub starts for a copy, as it starts
    them: the processes are real."""
    started = []
    popen = subprocess.Popen

    def spawn(args, *rest, **kw):
        process = popen(args, *rest, **kw)
        if "--porcelain" in args:
            started.append(process)
        return process

    monkeypatch.setattr(mirror.subprocess, "Popen", spawn)
    return started


def test_a_push_of_a_branch_sends_it_to_the_copy(hub, forge, work):
    sha = commit_state(work, str(forge))

    pushed = push(hub, work, PID, "main", "main:refs/heads/second")
    settle(hub)

    assert pushed.returncode == 0, pushed.stderr
    assert f"remote: published: /project/{PID}/{sha}/" in pushed.stderr
    assert ref(hub.store.repo_dir(PID), "refs/heads/main") == sha
    assert refs(forge) == {"refs/heads/main", "refs/heads/second"}
    assert ref(forge, "refs/heads/main") == sha
    assert ref(forge, "refs/heads/second") == sha
    assert hub.server.mirror.last_failure(PID) is None


def test_a_draft_does_not_start_a_copy_and_is_not_in_one(
        hub, forge, work, monkeypatch):
    started = count_sends(monkeypatch)
    commit_state(work, str(forge))
    assert push(hub, work, PID).returncode == 0
    settle(hub)
    assert len(started) == 1
    draft = commit_state(work, str(forge), "b")

    pushed = push(hub, work, PID, f"{draft}:refs/drafts/main")
    settle(hub)

    assert pushed.returncode == 0, pushed.stderr
    assert ref(hub.store.repo_dir(PID), "refs/drafts/main") == draft
    assert len(started) == 1
    newest = commit_state(work, str(forge), "c")

    assert push(hub, work, PID).returncode == 0
    settle(hub)

    assert len(started) == 2
    assert ref(hub.store.repo_dir(PID), "refs/drafts/main") == draft
    assert refs(forge) == {"refs/heads/main"}
    assert ref(forge, "refs/heads/main") == newest


def test_a_deleted_branch_goes_from_the_copy_and_a_branch_only_it_has_stays(
        hub, forge, work, tmp_path):
    sha = commit_state(work, str(forge))
    assert push(hub, work, PID, "main", "main:refs/heads/second"
                ).returncode == 0
    settle(hub)
    git("-C", work, "push", "--quiet", forge, "main:refs/heads/only-there")
    assert "refs/heads/second" in refs(forge)

    pushed = push(hub, work, PID, ":refs/heads/second")
    settle(hub)

    assert pushed.returncode == 0, pushed.stderr
    assert refs(forge) == {"refs/heads/main", "refs/heads/only-there"}
    assert ref(forge, "refs/heads/main") == sha


def test_a_branch_deleted_while_the_copy_was_down_goes_once_it_is_back(
        hub, forge, work, tmp_path):
    commit_state(work, str(forge))
    assert push(hub, work, PID, "main", "main:refs/heads/second"
                ).returncode == 0
    settle(hub)
    nowhere = str(tmp_path / "nowhere.git")
    commit_state(work, nowhere, "b")
    assert push(hub, work, PID).returncode == 0
    assert push(hub, work, PID, ":refs/heads/second").returncode == 0
    settle(hub)
    assert "refs/heads/second" in refs(forge)
    fixed = commit_state(work, str(forge), "c")

    assert push(hub, work, PID).returncode == 0
    settle(hub)

    assert refs(forge) == {"refs/heads/main"}
    assert ref(forge, "refs/heads/main") == fixed


def test_a_branch_made_again_is_not_deleted_from_the_copy_by_the_old_deletion(
        hub, forge, work, tmp_path):
    commit_state(work, str(tmp_path / "nowhere.git"))
    assert push(hub, work, PID, "main", "main:refs/heads/second"
                ).returncode == 0
    assert push(hub, work, PID, ":refs/heads/second").returncode == 0
    settle(hub)
    assert hub.server.mirror.last_failure(PID) is not None
    fixed = commit_state(work, str(forge), "b")

    assert push(hub, work, PID, "main", "main:refs/heads/second"
                ).returncode == 0
    settle(hub)

    assert hub.server.mirror.last_failure(PID) is None
    assert ref(forge, "refs/heads/main") == fixed
    assert ref(forge, "refs/heads/second") == fixed


def test_an_address_that_is_not_a_string_fails_the_copy(hub, work):
    commit_state(work, 5)
    assert push(hub, work, PID).returncode == 0
    settle(hub)
    commit_state(work, 5, "b")

    [line] = copy_line(push(hub, work, PID))

    assert line.rstrip().endswith(
        '"mirror" in project.json is not a git address')


def test_taking_the_address_out_of_the_project_clears_the_last_failure(
        hub, work, tmp_path):
    commit_state(work, str(tmp_path / "nowhere.git"))
    assert push(hub, work, PID).returncode == 0
    settle(hub)
    assert hub.server.mirror.last_failure(PID) is not None
    commit_state(work, None, "b")
    assert push(hub, work, PID).returncode == 0
    settle(hub)
    assert hub.server.mirror.last_failure(PID) is None
    commit_state(work, None, "c")

    assert copy_line(push(hub, work, PID)) == []


def test_a_branch_that_went_its_own_way_in_the_copy_is_left_and_named_on_the_next_push(
        hub, forge, work, tmp_path):
    commit_state(work, str(forge))
    assert push(hub, work, PID, "main", "main:refs/heads/second"
                ).returncode == 0
    settle(hub)
    other = tmp_path / "other"
    git("clone", "--quiet", forge, other)
    foreign = commit_all(other, "pushed by hand")
    git("-C", other, "push", "--quiet", "origin", "HEAD:main")
    newest = commit_state(work, str(forge), "b")

    pushed = push(hub, work, PID, "main", "main:refs/heads/second")
    settle(hub)

    assert pushed.returncode == 0, pushed.stderr
    assert ref(forge, "refs/heads/main") == foreign
    assert ref(forge, "refs/heads/second") == newest
    failure = hub.server.mirror.last_failure(PID)
    assert failure.startswith(f"the copy to {forge} failed at ")
    assert "main: [rejected]" in failure and "second" not in failure
    commit_state(work, str(forge), "c")

    later = push(hub, work, PID)

    [line] = copy_line(later)
    assert line.startswith(f"remote: copy: the copy to {forge} failed at ")
    assert "main: [rejected]" in line


def test_an_address_that_does_not_answer_fails_the_copy_and_not_the_push(
        hub, forge, work, tmp_path):
    nowhere = tmp_path / "nowhere.git"
    sha = commit_state(work, str(nowhere))

    pushed = push(hub, work, PID)
    settle(hub)

    assert pushed.returncode == 0, pushed.stderr
    assert f"remote: published: /project/{PID}/{sha}/" in pushed.stderr
    assert copy_line(pushed) == []
    assert hub.server.mirror.last_failure(PID).endswith(
        f"fatal: '{nowhere}' does not appear to be a git repository")
    commit_state(work, str(nowhere), "b")

    [line] = copy_line(push(hub, work, PID))
    assert f"the copy to {nowhere} failed" in line
    settle(hub)
    # Fixing the address does not clear the line at once: the push that
    # carries the fix still reads the last failure, then sends the copy.
    fixed = commit_state(work, str(forge), "c")
    assert len(copy_line(push(hub, work, PID))) == 1
    settle(hub)
    assert ref(forge, "refs/heads/main") == fixed
    commit_state(work, str(forge), "d")

    assert copy_line(push(hub, work, PID)) == []


def test_a_name_changed_on_the_page_reaches_the_copy(hub, forge, work):
    commit_state(work, str(forge))
    assert push(hub, work, PID).returncode == 0
    settle(hub)

    reply = httpx.post(
        f"{hub.url}/api/v1/projects/{PID}/names",
        json={"variant": "main", "kind": "project", "name": "Bracket mk2"},
        headers={"X-Hammerola-Token": TOKEN}, timeout=30, trust_env=False)
    settle(hub)

    assert reply.status_code == 200, reply.text
    renamed = reply.json()["commit"]
    assert ref(forge, "refs/heads/main") == renamed
    assert git("--git-dir", forge, "log", "-1", "--format=%s", renamed
               ).stdout.strip() == 'Rename the project to "Bracket mk2"'


def test_without_credentials_the_copy_is_not_sent(tmp_path, forge, work):
    hub = start_hub(tmp_path / "data", build_runner=picky_builder())
    try:
        commit_state(work, str(forge))

        pushed = push(hub, work, PID)
        settle(hub)

        assert pushed.returncode == 0, pushed.stderr
        assert refs(forge) == set()
        assert hub.server.mirror.last_failure(PID) is None
    finally:
        stop_hub(hub)


class SentProcess:
    """What the hub's `git push` becomes when it is not to leave the machine."""
    pid = 0
    returncode = 0

    def communicate(self, timeout=None):
        return "", ""


def watch_copies(monkeypatch):
    """Record the environment of every `git push --porcelain` the hub starts
    for a copy and answer it as a success; every other process is real."""
    sent = []
    popen = subprocess.Popen

    def spawn(args, *rest, **kw):
        if "--porcelain" not in args:
            return popen(args, *rest, **kw)
        sent.append(kw["env"])
        return SentProcess()

    monkeypatch.setattr(mirror.subprocess, "Popen", spawn)
    return sent


@pytest.mark.parametrize("address,entry", [
    ("https://forge-b.example:8443/o/r.git", ("bob", "bob-token")),
    ("https://forge-a.example/o/r.git", ("alice", "alice-token")),
    ("https://forge-b.example/o/r.git", None),
    ("https://elsewhere.example/o/r.git", None),
])
def test_the_token_goes_only_as_a_header_for_the_host_and_port_of_the_address(
        tmp_path, work, monkeypatch, address, entry):
    sent = watch_copies(monkeypatch)
    hub = start_hub(
        tmp_path / "data", build_runner=picky_builder(),
        mirror_credentials="https://alice:alice-token@forge-a.example\n"
                           "https://bob:bob-token@forge-b.example:8443")
    try:
        commit_state(work, address)

        assert push(hub, work, PID).returncode == 0
        settle(hub)
    finally:
        stop_hub(hub)

    [env] = sent
    assert env["GIT_TERMINAL_PROMPT"] == "0"
    config = {name: value for name, value in env.items()
              if name.startswith("GIT_CONFIG_")}
    if entry is None:
        assert config == {}
        return
    scheme_and_host = address.rpartition("/o/r.git")[0]
    login, token = entry
    sign = base64.b64encode(f"{login}:{token}".encode()).decode()
    assert config == {
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": f"http.{scheme_and_host}/.extraHeader",
        "GIT_CONFIG_VALUE_0": f"Authorization: Basic {sign}"}
    assert "EDIT_TOKEN" not in env


@pytest.mark.parametrize("value", [
    "https://alice@forge.example",
    "https://:alice-token@forge.example",
    "https://alice:alice-token@",
    "forge.example",
])
def test_an_entry_without_a_login_a_token_or_a_host_stops_the_start(
        monkeypatch, capsys, value):
    from src.config_errors import load_settings_or_exit
    monkeypatch.setenv("EDIT_TOKEN", "s3cret")
    monkeypatch.setenv("MIRROR_CREDENTIALS", value)

    with pytest.raises(SystemExit):
        load_settings_or_exit(lambda: Settings(_env_file=None))

    said = capsys.readouterr().err
    assert "MIRROR_CREDENTIALS" in said
    assert "alice-token" not in said


@pytest.mark.parametrize("value", [None, "", "  "])
def test_a_blank_credentials_variable_means_no_copies(monkeypatch, value):
    monkeypatch.setenv("EDIT_TOKEN", "s3cret")
    if value is None:
        monkeypatch.delenv("MIRROR_CREDENTIALS", raising=False)
    else:
        monkeypatch.setenv("MIRROR_CREDENTIALS", value)

    assert Settings(_env_file=None).mirror_credentials is None


def test_a_forge_that_never_answers_is_cut_off_with_its_helpers_and_the_queue_goes_on(
        hub, work, monkeypatch):
    monkeypatch.setattr(mirror, "MIRROR_SECONDS", 1)
    started = count_sends(monkeypatch)
    silent = socket.socket()
    silent.bind(("127.0.0.1", 0))
    silent.listen(8)
    try:
        address = f"http://127.0.0.1:{silent.getsockname()[1]}/x.git"
        commit_state(work, address)

        assert push(hub, work, PID).returncode == 0
        settle(hub)
        first = hub.server.mirror.last_failure(PID)
        commit_state(work, address, "b")
        assert push(hub, work, PID).returncode == 0
        settle(hub)
    finally:
        silent.close()

    assert first.endswith("no answer in 1 s")
    assert len(started) == 2
    for process in started:
        with pytest.raises(ProcessLookupError):
            os.killpg(process.pid, 0)
        assert process.returncode == -signal.SIGKILL
