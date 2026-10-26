"""The git server: each project's repository, served by `git http-backend`.

The hub checks the token and passes the request on (`app._serve_git`); git
itself answers. This module is the CGI host in between. The standard library's
`CGIHTTPRequestHandler` does not fit: it neither decodes a chunked request
body, which is how git sends a big push, nor hands the output on as it arrives.

Only the three requests of git's smart protocol reach the backend
(`smart_request`). For each of them the host:

* starts `git http-backend` with a CLEAN environment, `store.git_environment`
  plus the CGI variables, so EDIT_TOKEN never reaches git or a hook;
* gives it the server's git configuration through `GIT_CONFIG_COUNT`
  (`SERVER_CONFIG`), so the configuration lives in this file and changes with
  the image, with no repository on the volume to migrate;
* copies the request body, by Content-Length or chunked, to its stdin within
  the caller's deadline, and closes stdin after the last byte: no
  CONTENT_LENGTH is passed, so the end of stdin is the end of the body;
* streams its output back as it comes, without Content-Length, and the
  connection closes after it;
* reads its output to the end even when the client has gone away and drops
  the rest, so a push the hub has started finishes on the hub;
* logs its stderr with the project's id.
"""

import re
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs

from loguru import logger

from src.store import REPO_SUFFIX, Store, git_environment

# The first segment of every URL this module answers: `/git/<pid>.git/...`.
ROUTE = "git"

UPLOAD_PACK = "git-upload-pack"
RECEIVE_PACK = "git-receive-pack"
SERVICES = (UPLOAD_PACK, RECEIVE_PACK)

# The hub's own hooks, found beside `src/` wherever the hub runs from: `/app` in
# the image, `/src` in CI's test container.
HOOKS_DIR = Path(__file__).resolve().parent.parent / "githooks"

# Who `http-backend` is told the request comes from. The token has been checked
# by then, and `receive-pack` is enabled only when REMOTE_USER is set.
REMOTE_USER = "hammerola"

# Without a hook in `core.hooksPath` git accepts every push without a word;
# ci/smoke.py checks the image carries it.
SERVER_CONFIG = (
    ("receive.fsckObjects", "true"),
    ("receive.denyNonFastForwards", "true"),
    ("receive.denyDeletes", "true"),
    ("core.hooksPath", str(HOOKS_DIR)),
)

# The longest line read from either side: a CGI header line from the backend, or
# the size line of one chunk of the request body.
LINE_LIMIT = 8192
# How much is read at a time, from the socket and from the backend.
COPY_BYTES = 256 * 1024

HEX = re.compile(rb"[0-9A-Fa-f]+")


@dataclass(frozen=True)
class GitRequest:
    """One request of the smart protocol, already checked."""

    method: str
    pid: str
    path_info: str
    query: str


class BodyError(Exception):
    """The request body did not arrive whole; the message says how."""


def smart_request(method: str, rest: list[str], query: str):
    """The request, if it is one of the three of the smart protocol. Or None.

    `rest` is the path past `/git/`, as decoded segments. `PATH_INFO` and
    `QUERY_STRING` are written here from what was checked, so the backend sees
    nothing else.
    """
    if not rest or not rest[0].endswith(REPO_SUFFIX):
        return None
    pid = rest[0][:-len(REPO_SUFFIX)]
    if not Store.valid_pid(pid):
        return None
    tail = rest[1:]
    if method == "GET" and tail == ["info", "refs"]:
        services = parse_qs(query).get("service") or []
        if len(services) != 1 or services[0] not in SERVICES:
            return None
        return GitRequest(method, pid, f"/{pid}{REPO_SUFFIX}/info/refs",
                          f"service={services[0]}")
    if method == "POST" and len(tail) == 1 and tail[0] in SERVICES:
        return GitRequest(method, pid, f"/{pid}{REPO_SUFFIX}/{tail[0]}", "")
    return None


def environment(request: GitRequest, repos: Path, headers) -> dict:
    """The whole environment of one `git http-backend`."""
    env = git_environment()
    env.update({
        "GIT_PROJECT_ROOT": str(repos),
        "GIT_HTTP_EXPORT_ALL": "1",
        "REMOTE_USER": REMOTE_USER,
        "REQUEST_METHOD": request.method,
        "PATH_INFO": request.path_info,
        "QUERY_STRING": request.query,
        "CONTENT_TYPE": headers.get("Content-Type", ""),
    })
    # The git client gzips a big fetch request; the backend inflates it itself.
    encoding = headers.get("Content-Encoding")
    if encoding:
        env["HTTP_CONTENT_ENCODING"] = encoding
    protocol = headers.get("Git-Protocol")
    if protocol:
        env["GIT_PROTOCOL"] = protocol
    env["GIT_CONFIG_COUNT"] = str(len(SERVER_CONFIG))
    for index, (key, value) in enumerate(SERVER_CONFIG):
        env[f"GIT_CONFIG_KEY_{index}"] = key
        env[f"GIT_CONFIG_VALUE_{index}"] = value
    return env


def copy_exact(rfile, out, length: int, deadline: float) -> None:
    """Copy exactly `length` bytes of the body. Raises BodyError.

    `read1` returns after one read of the socket, so the deadline is checked
    between reads; `read` would wait for all of them.
    """
    remaining = length
    while remaining > 0:
        if time.monotonic() > deadline:
            raise BodyError("the request body did not arrive in time")
        chunk = rfile.read1(min(remaining, COPY_BYTES))
        if not chunk:
            raise BodyError("the request body ended early")
        out.write(chunk)
        remaining -= len(chunk)


def copy_chunked(rfile, out, deadline: float) -> None:
    """Decode a chunked body onto `out`, trailer included. Raises BodyError."""
    while True:
        if time.monotonic() > deadline:
            raise BodyError("the request body did not arrive in time")
        line = rfile.readline(LINE_LIMIT)
        if not line:
            raise BodyError("the request body ended early")
        size = line.split(b";", 1)[0].strip()
        if not line.endswith(b"\n") or not HEX.fullmatch(size):
            raise BodyError(f"a chunk of the request body is malformed: {line!r}")
        if int(size, 16) == 0:
            break
        copy_exact(rfile, out, int(size, 16), deadline)
        if rfile.readline(LINE_LIMIT) not in (b"\r\n", b"\n"):
            raise BodyError("a chunk of the request body is not followed by "
                            "its line end")
    # The trailer: header lines up to an empty one, read and dropped.
    while True:
        line = rfile.readline(LINE_LIMIT)
        if line in (b"\r\n", b"\n"):
            return
        if not line.endswith(b"\n"):
            raise BodyError("the request body ended inside its trailer")


def read_cgi_head(stream):
    """The CGI header of the backend's output. -> (status, reason, headers).

    `Status:` becomes the status line; every other header is kept as it is.
    None when the output ends, or stops being a header, before the empty line
    that closes it.
    """
    status, reason, headers = 200, "OK", []
    while True:
        line = stream.readline(LINE_LIMIT)
        if not line.endswith(b"\n"):
            return None
        line = line.rstrip(b"\r\n").decode("latin-1")
        if not line:
            return status, reason, headers
        name, colon, value = line.partition(":")
        if not colon:
            return None
        name, value = name.strip(), value.strip()
        if name.lower() == "status":
            code, _, reason = value.partition(" ")
            if not code.isdigit():
                return None
            status = int(code)
        else:
            headers.append((name, value))


def _feed(rfile, stdin, length, deadline: float, pid: str) -> None:
    """Copy the request body to the backend's stdin, then close it.

    Runs on a thread of its own, so the backend can write while it still
    reads. A body that does not arrive whole is logged; the backend sees its
    stdin end early and fails on its own.
    """
    try:
        if length is None:
            copy_chunked(rfile, stdin, deadline)
        else:
            copy_exact(rfile, stdin, length, deadline)
    except BodyError as error:
        logger.warning(f"git {pid}: {error}")
    except OSError as error:
        logger.warning(f"git {pid}: the request body could not be passed "
                       f"on: {error}")
    finally:
        try:
            stdin.close()
        except OSError:
            pass


def _log_stderr(stream, pid: str) -> None:
    with stream:
        for line in stream:
            text = line.decode("utf-8", "replace").rstrip()
            if text:
                logger.warning(f"git {pid}: {text}")


def serve(handler, request: GitRequest, repos: Path, length,
          deadline_seconds: float) -> int:
    """Run `git http-backend` for one request and stream its answer.

    -> the backend's exit code. `handler` is the hub's request handler: its
    `headers` and `rfile` are the request, its `wfile` the answer. `length` is
    the body's Content-Length, or None for a chunked body.

    Returns only once the backend has exited and its output has been read to
    the end, whether the client is still there or not. Raises OSError only when
    the backend cannot be started, before anything has been written.
    """
    process = subprocess.Popen(
        ["git", "http-backend"], env=environment(request, repos, handler.headers),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    feeder = threading.Thread(
        target=_feed, daemon=True,
        args=(handler.rfile, process.stdin, length,
              time.monotonic() + deadline_seconds, request.pid))
    errors = threading.Thread(target=_log_stderr, daemon=True,
                              args=(process.stderr, request.pid))
    feeder.start()
    errors.start()

    head = read_cgi_head(process.stdout)
    if head is None:
        logger.error(f"git {request.pid}: git http-backend ended without a "
                     f"CGI header")
        head = (500, "Internal Server Error", [])
    status, reason, headers = head
    present = True
    try:
        handler.send_response(status, reason)
        for name, value in headers:
            handler.send_header(name, value)
        handler.send_header("X-Content-Type-Options", "nosniff")
        handler.send_header("Connection", "close")
        handler.end_headers()
    except OSError:
        present = False
    while True:
        chunk = process.stdout.read1(COPY_BYTES)
        if not chunk:
            break
        if not present:
            continue
        try:
            handler.wfile.write(chunk)
            handler.wfile.flush()
        except OSError:
            present = False
    if not present:
        logger.info(f"git {request.pid}: the client went away; the rest of "
                    f"the answer was read and dropped")
    process.stdout.close()
    code = process.wait()
    feeder.join()
    errors.join()
    return code


def end_of_request(store: Store, pid: str) -> None:
    """Runs once `git http-backend` has exited, before the connection closes.

    The git client returns when the connection closes, so whatever is done here
    is done by the time `git push` or `git fetch` returns. Nothing is done here
    yet.
    """
