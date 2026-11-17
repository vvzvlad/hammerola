"""The backup copy of each project's code in a third-party git forge.

The address is the `mirror` key of the project's project.json on `main`
(`_address`): every variant has its own project.json and the project has one
copy. The hub sends the copy itself, in the background, once it has accepted a
push that moved a branch and after the commit it makes for a name changed on
the page (`Mirror.schedule`), so the copy holds what the hub accepted and the
client does not change. Only branches go; drafts, which every build rewrites,
do not.

One thread sends the projects one by one. Each send is one `git push` of every
branch of the project, without `--force`: a branch whose history in the forge
has gone its own way is refused, named in the failure, and left as it is. A
branch deleted on the hub is deleted in the copy too; the deletion is kept
until a send succeeds as a whole, and dropped if the branch exists on the hub
again (`_push`), since an explicit deletion beats the glob and would erase the
recreated branch. It is held in memory only. Branches the hub never had are
not touched.

The forge's token comes from `MIRROR_CREDENTIALS` (`parse_credentials`) and
goes only into the environment of the `git push` that sends the copy, as a
header for that forge's host. A failure is kept per project in memory
(`Mirror.last_failure`): the next push of the project prints it first
(`prereceive.run`), and the log of the hub has it as a warning.

`git push` over https starts a helper that inherits stderr, so a push killed
at its deadline would leave the helper holding the pipe: the push runs in a
process group of its own and the group is killed.
"""

import base64
import json
import os
import signal
import subprocess
import threading
from datetime import datetime, timezone
from urllib.parse import unquote, urlsplit

from loguru import logger

from src.prereceive import PROJECT_FILE, _project_directory
from src.store import (BRANCH_PREFIX, MAIN_REF, Store, git_environment,
                       git_failure, run_git)

# How long one push may take. The first copy of the largest repository
# (270 MB) fits in an hour at 75 KB/s; a forge that stops answering does not
# hold the queue for longer.
MIRROR_SECONDS = 3600

THREAD_NAME = "hammerola-mirror"

# The key of project.json that holds the address.
ADDRESS_KEY = "mirror"
NOT_AN_ADDRESS = f'"{ADDRESS_KEY}" in {PROJECT_FILE} is not a git address'

# Every branch; drafts are not among them.
BRANCHES_REFSPEC = f"{BRANCH_PREFIX}*:{BRANCH_PREFIX}*"


def _origin(address: str) -> tuple[str, str]:
    """`(scheme, host[:port])` of an address, the login left out."""
    parts = urlsplit(address)
    return parts.scheme, parts.netloc.rpartition("@")[2].lower()


def parse_credentials(text: str) -> dict:
    """`{(scheme, host[:port]): (login, token)}` of entries written as
    git-credentials writes them, `https://<login>:<token>@<host[:port]>`,
    separated by spaces or line breaks. ValueError for an entry without a
    login, a token or a host; the message never holds the entry."""
    records = {}
    for number, entry in enumerate(text.split(), 1):
        parts = urlsplit(entry)
        login, token = unquote(parts.username or ""), unquote(parts.password or "")
        scheme, host = _origin(entry)
        if not (login and token and scheme and host):
            raise ValueError(
                f"entry {number} is not https://<login>:<token>@<host>")
        records[(scheme, host)] = (login, token)
    return records


def _reason(error: Exception) -> str:
    if isinstance(error, subprocess.CalledProcessError):
        return git_failure(error)
    return str(error) or type(error).__name__


def _push_failure(output: str, errors: str, code: int) -> str:
    """Why `git push --porcelain` failed: each refused branch and what git
    said of it, else the first `fatal:` or `error:` line."""
    refused = []
    for line in output.splitlines():
        flag, _, rest = line.partition("\t")
        if flag == "!":
            refspec, _, summary = rest.partition("\t")
            branch = refspec.rpartition(":")[2].removeprefix(BRANCH_PREFIX)
            refused.append(f"{branch}: {summary}")
    if refused:
        return "; ".join(refused)
    for line in errors.splitlines():
        if line.startswith(("fatal:", "error:")):
            return line
    return f"git push exited {code}"


class Mirror:
    """The queue of projects to copy and the thread that sends them.

    All the memory is here, under one lock: nothing at module level.
    """

    def __init__(self, records: dict, store: Store):
        self._records = records
        self._store = store
        self._cond = threading.Condition()
        # Pids in the order they are waiting; a dict for its order.
        self._queue: dict[str, None] = {}
        self._deleted: dict[str, set[str]] = {}
        self._failures: dict[str, str] = {}
        self._current: str | None = None
        self._process: subprocess.Popen | None = None
        self._thread: threading.Thread | None = None
        self._closed = False

    def schedule(self, pid: str, deleted=()) -> None:
        """Queue the project for a send and remember the branches deleted on
        the hub. Returns at once. Nothing without credentials."""
        if not self._records:
            return
        with self._cond:
            if self._closed:
                return
            self._queue[pid] = None
            self._deleted.setdefault(pid, set()).update(deleted)
            if self._thread is None:
                self._thread = threading.Thread(
                    target=self._run, name=THREAD_NAME, daemon=True)
                self._thread.start()
            self._cond.notify_all()

    def last_failure(self, pid: str) -> str | None:
        with self._cond:
            return self._failures.get(pid)

    def wait_idle(self, timeout: float = 60) -> bool:
        """Wait until nothing is queued and nothing is sending. -> whether
        that came before `timeout`."""
        with self._cond:
            return self._cond.wait_for(
                lambda: not self._queue and self._current is None, timeout)

    def close(self) -> None:
        """Kill the push that is running, stop the thread, wait for it briefly."""
        with self._cond:
            self._closed = True
            process, thread = self._process, self._thread
            self._cond.notify_all()
        if process is not None:
            _kill(process)
        if thread is not None:
            thread.join(timeout=5)

    def _run(self) -> None:
        while True:
            with self._cond:
                self._cond.wait_for(lambda: self._queue or self._closed)
                if self._closed:
                    return
                pid = next(iter(self._queue))
                del self._queue[pid]
                self._current = pid
                deleted = sorted(self._deleted.get(pid, ()))
            try:
                self._send(pid, deleted)
            finally:
                with self._cond:
                    self._current = None
                    self._cond.notify_all()

    def _send(self, pid: str, deleted: list) -> None:
        address = None
        try:
            address = self._address(pid)
            if address is None:
                with self._cond:
                    self._failures.pop(pid, None)
                return
            reason = self._push(pid, address, deleted)
        except Exception as error:
            logger.exception(f"mirror {pid}: the copy could not be sent")
            reason = _reason(error)
        if self._closed:
            return
        with self._cond:
            if reason is None:
                self._failures.pop(pid, None)
                remaining = self._deleted.get(pid, set()) - set(deleted)
                if remaining:
                    self._deleted[pid] = remaining
                else:
                    self._deleted.pop(pid, None)
                return
            self._failures[pid] = (
                f"the copy{f' to {address}' if address else ''} failed at "
                f"{datetime.now(timezone.utc):%Y-%m-%d %H:%M:%S} UTC: {reason}")
        logger.warning(f"mirror {pid}: {reason}")

    def _address(self, pid: str) -> str | None:
        """The `mirror` of the project.json on `main`; None for no copy."""
        repo = self._store.repo_dir(pid)
        try:
            tip = run_git(repo, "rev-parse", "--verify", "--quiet",
                          f"{MAIN_REF}^{{commit}}").strip()
        except subprocess.CalledProcessError as error:
            if error.returncode == 1:
                return None
            raise
        directory = _project_directory(repo, pid, tip, MAIN_REF, {})
        path = f"{directory}/{PROJECT_FILE}" if directory else PROJECT_FILE
        address = json.loads(run_git(repo, "cat-file", "-p",
                                     f"{tip}:{path}")).get(ADDRESS_KEY)
        if address is None or address == "":
            return None
        if not isinstance(address, str):
            raise ValueError(NOT_AN_ADDRESS)
        return address

    def _push(self, pid: str, address: str, deleted: list) -> str | None:
        """One `git push` of every branch and the deletions. -> None, or why
        it failed."""
        live = set(run_git(
            self._store.repo_dir(pid), "for-each-ref",
            "--format=%(refname:strip=2)", BRANCH_PREFIX).split())
        with self._cond:
            if pid in self._deleted:
                # Only this send's names: a deletion queued after `live` was
                # read is of a branch deleted since, and stays.
                self._deleted[pid] -= live & set(deleted)
                if not self._deleted[pid]:
                    del self._deleted[pid]
        deleted = [name for name in deleted if name not in live]
        env = {**git_environment(), "GIT_TERMINAL_PROMPT": "0"}
        scheme, host = _origin(address)
        if (scheme, host) in self._records:
            login, token = self._records[(scheme, host)]
            sign = base64.b64encode(f"{login}:{token}".encode()).decode()
            env.update(
                GIT_CONFIG_COUNT="1",
                GIT_CONFIG_KEY_0=f"http.{scheme}://{host}/.extraHeader",
                GIT_CONFIG_VALUE_0=f"Authorization: Basic {sign}")
        command = ["git", "-c", "credential.helper=",
                   "-c", "advice.pushUpdateRejected=false", "push",
                   "--porcelain", address, BRANCHES_REFSPEC,
                   *(f":{BRANCH_PREFIX}{name}" for name in deleted)]
        with self._cond:
            if self._closed:
                return None
            process = subprocess.Popen(
                command, cwd=self._store.repo_dir(pid), env=env, text=True,
                encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                start_new_session=True)
            self._process = process
        try:
            output, errors = process.communicate(timeout=MIRROR_SECONDS)
        except subprocess.TimeoutExpired:
            _kill(process)
            process.communicate()
            return f"no answer in {MIRROR_SECONDS} s"
        finally:
            with self._cond:
                self._process = None
        if process.returncode == 0:
            return None
        return _push_failure(output, errors, process.returncode)


def _kill(process: subprocess.Popen) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
