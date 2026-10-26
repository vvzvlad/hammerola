"""The git server: each project's repository behind the token (`src/githttp.py`).

Driven with the real `git` of the test image wherever a git client is the
subject, because what has to work is what that client sends: a chunked push, a
gzipped fetch, the protocol header. Pushes are refused here by the hub's own
hook (`githooks/pre-receive`), which is what proves a push reached git whole.
"""

import os
import socket
import struct
import subprocess
import threading

import httpx
from harness import TOKEN, good_build
from loguru import logger

from src import githttp
from src.store import Store

REFUSAL = "remote: this hub does not publish over git yet"
TOKEN_CONFIG = f"http.extraHeader=X-Hammerola-Token: {TOKEN}"

# A git client of its own: no system or user configuration, an identity for the
# commits the tests make, and no prompt for a password the hub never asks for.
CLIENT_ENV = {
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_AUTHOR_NAME": "test",
    "GIT_AUTHOR_EMAIL": "test@example.invalid",
    "GIT_COMMITTER_NAME": "test",
    "GIT_COMMITTER_EMAIL": "test@example.invalid",
}


def git(*args, env=None, check=True):
    return subprocess.run(
        ["git", *map(str, args)], env={**os.environ, **CLIENT_ENV, **(env or {})},
        capture_output=True, text=True, check=check, timeout=120)


def committed(path, size):
    """A repository on branch `main` with one commit of `size` random bytes."""
    git("init", "--quiet", "--initial-branch=main", path)
    (path / "blob.bin").write_bytes(os.urandom(size))
    git("-C", path, "add", "blob.bin")
    git("-C", path, "commit", "--quiet", "-m", "blob")
    return path


def advertise(hub, pid, service="git-upload-pack", token=TOKEN):
    headers = {"X-Hammerola-Token": token} if token is not None else {}
    return hub.get(f"/git/{pid}.git/info/refs?service={service}",
                   headers=headers)


def remove(hub, pid):
    return httpx.request("DELETE", f"{hub.url}/api/v1/projects/{pid}",
                         headers={"X-Hammerola-Token": TOKEN}, timeout=10,
                         trust_env=False)


def test_a_clone_needs_the_token_and_is_refused_403_without_it(hub, tmp_path):
    url = f"{hub.url}/git/clone1.git"
    refused = git("clone", url, tmp_path / "anonymous", check=False)
    assert refused.returncode != 0
    # The whole phrase: the hub's random port is in stderr too.
    assert "returned error: 403" in refused.stderr, refused.stderr
    assert "returned error: 401" not in refused.stderr
    # Refused before the repository is looked at, let alone created.
    assert not hub.store.repo_dir("clone1").exists()

    cloned = git("-c", TOKEN_CONFIG, "clone", url, tmp_path / "owner")
    assert "empty repository" in cloned.stderr, cloned.stderr
    assert git("-C", hub.store.repo_dir("clone1"), "symbolic-ref",
               "HEAD").stdout.strip() == "refs/heads/main"


def test_only_the_smart_protocol_is_answered(hub):
    """The dumb protocol's files and anything else under /git/ are a 404."""
    answered = advertise(hub, "smart1")
    assert answered.status_code == 200
    assert answered.headers["Content-Type"] == \
        "application/x-git-upload-pack-advertisement"
    assert answered.headers["Connection"] == "close"

    headers = {"X-Hammerola-Token": TOKEN}
    for path in ("/git/smart1.git/HEAD", "/git/smart1.git/info/refs",
                 "/git/smart1.git/info/refs?service=git-archive",
                 "/git/smart1.git/objects/info/packs", "/git/smart1",
                 "/git/not%20a%20pid.git/info/refs?service=git-upload-pack"):
        assert hub.get(path, headers=headers).status_code == 404, path
    assert hub.request("POST", "/git/smart1.git/info/refs",
                       headers=headers).status_code == 404
    # The token is asked for first, whatever the path.
    assert hub.get("/git/smart1.git/HEAD").status_code == 403
    assert advertise(hub, "smart1", token=None).status_code == 403


def test_a_chunked_push_reaches_the_hook_whole(hub, tmp_path):
    """Past `http.postBuffer` git sends the pack chunked.

    The hook runs only once `receive-pack` has unpacked the whole pack, so its
    line in the output says the body arrived in full.
    """
    work = committed(tmp_path / "work", 2 * 1024 * 1024)
    pushed = git("-C", work, "-c", TOKEN_CONFIG, "-c", "http.postBuffer=65536",
                 "push", f"{hub.url}/git/push1.git", "main",
                 env={"GIT_TRACE_CURL": "1", "GIT_TRACE_CURL_NO_DATA": "1"},
                 check=False)
    assert pushed.returncode != 0
    assert "Transfer-Encoding: chunked" in pushed.stderr
    assert REFUSAL in pushed.stderr, pushed.stderr
    assert git("-C", hub.store.repo_dir("push1"), "for-each-ref").stdout == ""


def test_a_fetch_git_gzips_reaches_the_backend(hub, tmp_path):
    """Past 1 KiB git gzips a fetch request, and `http-backend` inflates it.

    Forty branches, each on a commit of its own, are forty `want` lines.
    """
    work = tmp_path / "work"
    git("init", "--quiet", "--initial-branch=main", work)
    for number in range(40):
        git("-C", work, "commit", "--quiet", "--allow-empty", "-m", str(number))
        git("-C", work, "branch", f"branch-{number:02d}")
    git("-C", work, "push", "--quiet", hub.store.ensure_repo("gzip1"), "--all")
    tip = git("-C", work, "rev-parse", "HEAD").stdout.strip()

    cloned = git("-c", TOKEN_CONFIG, "clone", f"{hub.url}/git/gzip1.git",
                 tmp_path / "clone",
                 env={"GIT_TRACE_CURL": "1", "GIT_TRACE_CURL_NO_DATA": "1"})
    assert "Content-Encoding: gzip" in cloned.stderr
    assert git("-C", tmp_path / "clone", "cat-file", "-t",
               tip).stdout.strip() == "commit"


def test_git_runs_in_a_clean_environment(monkeypatch, tmp_path):
    """Neither EDIT_TOKEN nor a stray GIT_* of the hub's own reaches git."""
    monkeypatch.setenv("EDIT_TOKEN", "the-hub-secret")
    monkeypatch.setenv("GIT_DIR", str(tmp_path / "elsewhere"))
    monkeypatch.setenv("HOME", str(tmp_path))
    request = githttp.GitRequest("POST", "env1", "/env1.git/git-upload-pack", "")
    headers = {"Content-Type": "application/x-git-upload-pack-request",
               "Content-Encoding": "gzip", "Git-Protocol": "version=2",
               "X-Hammerola-Token": "the-hub-secret"}

    env = githttp.environment(request, tmp_path / "repos", headers)

    config = {f"GIT_CONFIG_{kind}_{index}" for kind in ("KEY", "VALUE")
              for index in range(len(githttp.SERVER_CONFIG))}
    assert set(env) == {
        "PATH", "HOME", "REQUEST_METHOD", "PATH_INFO", "QUERY_STRING",
        "CONTENT_TYPE", "GIT_PROJECT_ROOT", "GIT_HTTP_EXPORT_ALL",
        "REMOTE_USER", "GIT_PROTOCOL", "HTTP_CONTENT_ENCODING",
        "GIT_CONFIG_COUNT", *config}
    assert "the-hub-secret" not in env.values()


def test_the_server_configuration_reaches_receive_pack(hub, monkeypatch):
    """What `GIT_CONFIG_COUNT` carries is what `receive-pack` advertises."""
    service = "git-receive-pack"
    assert b"push-options" not in advertise(hub, "conf1", service).content
    monkeypatch.setattr(githttp, "SERVER_CONFIG", githttp.SERVER_CONFIG + (
        ("receive.advertisePushOptions", "true"),))
    answered = advertise(hub, "conf1", service)
    assert answered.status_code == 200
    assert b"push-options" in answered.content


def pkt_line(text):
    data = text.encode("ascii")
    return f"{len(data) + 4:04x}".encode("ascii") + data


def test_a_client_gone_mid_answer_does_not_stop_the_backend(
        hub, tmp_path, monkeypatch, capfd):
    """The answer to this fetch is a 16 MiB pack, the client reads 4 KiB of it."""
    work = committed(tmp_path / "work", 16 * 1024 * 1024)
    git("-C", work, "push", "--quiet", hub.store.ensure_repo("gone1"), "main")
    want = git("-C", work, "rev-parse", "HEAD").stdout.strip()

    started = []
    popen = subprocess.Popen

    def spawn(args, *rest, **kw):
        process = popen(args, *rest, **kw)
        if list(args) == ["git", "http-backend"]:
            started.append(process)
        return process

    monkeypatch.setattr(githttp.subprocess, "Popen", spawn)
    ended = threading.Event()
    monkeypatch.setattr(githttp, "end_of_request",
                        lambda store, pid: ended.set())
    said = []
    sink = logger.add(said.append, level="DEBUG")
    try:
        body = pkt_line(f"want {want}\n") + b"0000" + pkt_line("done\n")
        request = (
            f"POST /git/gone1.git/git-upload-pack HTTP/1.1\r\nHost: hub\r\n"
            f"X-Hammerola-Token: {TOKEN}\r\n"
            f"Content-Type: application/x-git-upload-pack-request\r\n"
            f"Content-Length: {len(body)}\r\n\r\n").encode("ascii") + body
        client = socket.socket()
        # A small window, so most of the pack is still the hub's to send.
        client.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
        client.connect(hub.server.server_address[:2])
        client.sendall(request)
        assert client.recv(4096).startswith(b"HTTP/1.1 200")
        # Closed with a reset, the way a killed client goes.
        client.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER,
                          struct.pack("ii", 1, 0))
        client.close()
        assert ended.wait(60), "the request never reached its end"
    finally:
        logger.remove(sink)

    [backend] = started
    assert backend.returncode == 0
    assert any("the client went away" in line for line in said), said
    assert not any("Traceback" in line for line in said), said
    assert "Traceback" not in capfd.readouterr().err


def test_a_ref_lock_left_by_a_killed_push_is_swept_at_start(tmp_path):
    store = Store(tmp_path / "data")
    repo = store.ensure_repo("swept1")
    leftovers = [repo / "refs" / "heads" / "main.lock",
                 repo / "refs" / "heads" / "feature" / "x.lock",
                 repo / "packed-refs.lock",
                 repo / "objects" / "tmp_objdir-incoming-a1b2c3",
                 store.repos_dir / ".tmp-swept1-0123abcd.git"]
    for path in leftovers:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.suffix == ".lock":
            path.write_text("0" * 40 + "\n")
        else:
            (path / "objects").mkdir(parents=True)

    Store(tmp_path / "data")

    assert [path for path in leftovers if path.exists()] == []
    assert git("-C", repo, "rev-parse", "--is-bare-repository").stdout.strip() \
        == "true"


def test_removing_a_project_takes_its_repository(hub):
    """A pid with nothing but a repository is a project that can be removed."""
    assert hub.publish("both1", "abc123", good_build()).status_code == 201
    for pid in ("both1", "typo1"):
        assert advertise(hub, pid).status_code == 200
        assert hub.store.repo_dir(pid).is_dir()

    for pid in ("both1", "typo1"):
        assert remove(hub, pid).status_code == 200, pid
        assert not hub.store.repo_dir(pid).exists(), pid
    assert not hub.project_dir("both1").exists()
    assert remove(hub, "typo1").status_code == 404
