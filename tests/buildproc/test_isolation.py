"""What the build process is CUT OFF from: the hub's memory, its environment,
its standard input, and its own leftovers.

The ceilings live in test_ceilings.py. This file is about the other half of
SPEC 8A.2 step 4 -- that the thing running untrusted code shares as little as
possible with the thing holding the tokens.
"""

import io
import os
import signal
import textwrap
import time
import tokenize
from pathlib import Path

import pytest

from src.buildproc import child_environment, runner

from probes import TEST_LIMITS, alive, payload


BUILDPROC_DIR = Path(runner.__file__).resolve().parent


# --------------------------------------------------------------------------
# spawn/exec, not fork
# --------------------------------------------------------------------------

def test_the_build_runs_in_a_fresh_interpreter_and_not_a_copy_of_the_hub(run_program):
    """A forked child would arrive carrying everything the parent had imported.

    This is the empirical half of the rule in SPEC 8A.2 step 4 -- "spawn/exec,
    NOT fork, the OCCT thread pool hangs after a fork". A fork of this pytest
    process would have `_pytest`, `src.buildproc` and several hundred other
    modules already in `sys.modules`, because that is what a fork IS: the same
    memory, minus the threads that were holding its locks. An exec has none of
    them, and the count is the difference nobody can argue with.
    """
    result = run_program(textwrap.dedent("""
        import json, sys
        print("PAYLOAD " + json.dumps({
            "inherited": sorted(m for m in sys.modules
                                if m.split(".")[0] in ("pytest", "_pytest",
                                                       "src", "py", "pluggy")),
            "modules": len(sys.modules),
        }))
    """))

    assert result.ok, result.log
    data = payload(result)
    assert data["inherited"] == [], (
        "the build process started with the hub's own modules already loaded, "
        "which only happens if it is a fork of it rather than a fresh exec")
    # A bare interpreter is well under a hundred modules; this process is well
    # over three hundred. The exact numbers are not the point, the gap is.
    assert data["modules"] < 200, result.log


def test_no_fork_and_no_preexec_anywhere_in_the_component():
    """The rule, checked against the code rather than against its comments.

    Every name here is DISCUSSED at length in this component's docstrings --
    that is what makes a plain `grep` useless and this test necessary. The
    tokenizer throws comments and strings away and leaves the code, so the
    check is about what the module DOES.

    `os.fork` and `multiprocessing` would give the child a copy of a
    multi-threaded interpreter, whose OCCT pool then deadlocks. `preexec_fn`
    runs Python between fork and exec of a threaded parent, where the
    documentation says not to and where the interpreter's own locks may be held
    by threads that no longer exist.
    """
    forbidden = ("fork", "preexec_fn", "multiprocessing")
    for path in sorted(BUILDPROC_DIR.glob("*.py")):
        code = []
        with io.open(path, encoding="utf-8") as handle:
            for token in tokenize.generate_tokens(handle.readline):
                if token.type in (tokenize.COMMENT, tokenize.STRING):
                    continue
                code.append(token.string)
        text = " ".join(code)
        for name in forbidden:
            assert name not in text, (
                f"{path.name} uses {name!r} in executable code. A build must be "
                f"exec'd into a fresh interpreter, and its ceilings must go on "
                f"in a process of their own -- see limits.py")


# --------------------------------------------------------------------------
# the environment
# --------------------------------------------------------------------------

def test_the_environment_is_built_key_by_key_and_not_filtered(run_program, hub_secrets):
    """Nothing the hub has in its environment reaches the build.

    The decoy in `hub_secrets` is the one that matters: a component that
    removed the one name it knows about would pass every assertion about
    EDIT_TOKEN and still hand a build every credential added after this file
    was written.
    """
    result = run_program(textwrap.dedent("""
        import json, os
        print("PAYLOAD " + json.dumps(dict(os.environ)))
    """))

    assert result.exit_code == 0, result.log
    seen = payload(result)
    expected = child_environment(home="/nowhere", tmp="/nowhere",
                                 threads=TEST_LIMITS.occt_threads)

    for name, value in hub_secrets.items():
        assert name not in seen, f"{name} reached the build environment"
        assert value not in result.log, f"the value of {name} reached the build log"

    assert set(expected) <= set(seen), "the build lost part of its own environment"
    # `__CF_USER_TEXT_ENCODING` is added by CoreFoundation to every process on
    # macOS that links it, from outside the environment we compose. Naming it
    # here rather than loosening the assertion keeps the check exact on Linux,
    # which is where the hub runs.
    assert set(seen) - set(expected) <= {"__CF_USER_TEXT_ENCODING"}, (
        "something other than child_environment() put a variable in there")
    # Spot-check a few of the parent's ordinary variables by name, so the test
    # still says something if the comparison above is ever weakened.
    for ordinary in ("VIRTUAL_ENV", "PWD", "SHELL", "USER", "TERM", "PYTEST_VERSION"):
        assert ordinary not in seen


def test_the_build_writes_its_caches_into_a_scratch_home(run_program):
    """HOME, TMPDIR and the matplotlib cache all point away from the real home.

    A build that wrote into the `app` user's home would be leaving files where
    the NEXT interpreter to start reads them -- and a `.pth` dropped in the
    right place is executed at every interpreter start, without an import,
    which is exactly the mechanism SPEC 8A.3 refuses to let a model near.
    """
    result = run_program(textwrap.dedent("""
        import json, os
        home = os.environ["HOME"]
        probe = os.path.join(home, "written-by-the-build")
        open(probe, "w").write("x")
        print("PAYLOAD " + json.dumps({
            "home": home,
            "tmp": os.environ["TMPDIR"],
            "mpl": os.environ["MPLCONFIGDIR"],
            "wrote": os.path.exists(probe),
        }))
    """))

    assert result.exit_code == 0, result.log
    data = payload(result)
    assert data["wrote"] is True
    assert data["mpl"].startswith(data["home"])
    assert data["tmp"] != data["home"]
    assert Path(data["home"]).exists()


def test_standard_input_is_closed(run_program):
    """A model that reads stdin gets EOF, not a socket the hub is holding."""
    result = run_program(textwrap.dedent("""
        import json, sys
        print("PAYLOAD " + json.dumps({"stdin": sys.stdin.read()}))
    """))

    assert result.exit_code == 0, result.log
    assert payload(result) == {"stdin": ""}


# --------------------------------------------------------------------------
# what the build leaves behind
# --------------------------------------------------------------------------

def test_a_process_the_model_spawned_dies_with_it(run_program, tmp_path):
    """The kill goes to the process GROUP, not to the one process we started.

    Without `start_new_session=True` plus `killpg`, a model that spawns
    anything at all leaves it running on the host after the build is killed --
    holding memory, holding a slot in the container's pid limit, and holding
    the write end of the pipe the parent is still reading, which turns every
    later build into a five-second wait for an EOF that is not coming.

    The straggler is watched through a heartbeat file rather than by asking
    whether its pid is alive: a killed process that nothing has reaped yet is
    still a pid. A file that stopped being touched is unambiguous.
    """
    heartbeat = tmp_path / "heartbeat"
    pidfile = tmp_path / "straggler.pid"
    limits = TEST_LIMITS.replace(wall_seconds=2.0)
    result = run_program(textwrap.dedent(f"""
        import subprocess, sys, time
        child = subprocess.Popen([sys.executable, "-c", (
            "import os, sys, time\\n"
            "while True:\\n"
            "    open({str(heartbeat)!r}, 'w').write(str(time.time()))\\n"
            "    time.sleep(0.05)\\n")])
        open({str(pidfile)!r}, "w").write(str(child.pid))
        # No CPU burned here: only the parent's wall clock can end this.
        time.sleep(600)
    """), limits=limits)

    straggler = None
    try:
        assert result.timed_out, result.log
        assert heartbeat.exists(), "the straggler never started"
        straggler = int(pidfile.read_text())

        first = heartbeat.read_text()
        time.sleep(0.5)
        assert heartbeat.read_text() == first, (
            "the process the model spawned outlived the build and is still "
            "running on the host")
        # The contrast with the setsid test below: a descendant that stayed in
        # the group dies with it, so the pipe reaches EOF and there is nothing
        # left holding a thread of the hub's.
        assert not result.stragglers, result.log
    finally:
        if straggler is not None and alive(straggler):
            os.kill(straggler, signal.SIGKILL)


def test_a_setsid_descendant_survives_the_kill_and_the_hub_is_told(
        run_program, tmp_path, monkeypatch):
    """The hole in the process group, made visible instead of denied.

    `killpg` reaches everything the build spawned that stayed in its group --
    the test above. It cannot reach a descendant that called `setsid()` for
    itself: that one has a group of its own, by a number nothing here can
    enumerate, and it survives. It also inherited the write end of the output
    pipe, so the parent's drain never sees EOF and the hub keeps one thread and
    one descriptor for as long as that process lives.

    None of that can be FIXED here (see runner.py's docstring -- the container's
    pid limit is where it belongs), which is exactly why it has to be reported.
    An unread boolean is a leak nobody can see; the assertion below is that it
    reaches the build log, where the outcome of every build is already read.

    DRAIN_GRACE_SECONDS is shortened so this costs a second rather than five.
    The production value is not what is under test -- the behaviour at the end
    of it is.
    """
    monkeypatch.setattr(runner, "DRAIN_GRACE_SECONDS", 1.0)
    heartbeat = tmp_path / "setsid-heartbeat"
    pidfile = tmp_path / "setsid.pid"
    limits = TEST_LIMITS.replace(wall_seconds=2.0)

    result = run_program(textwrap.dedent(f"""
        import subprocess, sys, time
        # start_new_session=True is the whole test: one setsid() call, and this
        # process is out of the group the hub is about to kill. It keeps the
        # inherited stdout, which is what holds the parent's pipe open.
        child = subprocess.Popen([sys.executable, "-c", (
            "import time\\n"
            "while True:\\n"
            "    open({str(heartbeat)!r}, 'w').write(str(time.time()))\\n"
            "    time.sleep(0.05)\\n")], start_new_session=True)
        open({str(pidfile)!r}, "w").write(str(child.pid))
        time.sleep(600)
    """), limits=limits)

    straggler = None
    try:
        assert result.timed_out, result.log
        straggler = int(pidfile.read_text())

        assert result.stragglers, (
            "a setsid() descendant outlived the kill and the hub was not told")
        assert "outlived the kill of its process group" in result.log, (
            "the straggler is recorded in a field nobody reads and nowhere else")

        first = heartbeat.read_text()
        time.sleep(0.3)
        assert heartbeat.read_text() != first, (
            "the straggler stopped on its own, so this run proves nothing "
            "about what killpg does and does not reach")
    finally:
        if straggler is not None and alive(straggler):
            os.kill(straggler, signal.SIGKILL)


def test_the_output_reader_closes_the_pipe_on_every_path(tmp_path):
    """The descriptor is closed whether the read ended at EOF or in an error.

    The reader owns the stream because the parent CANNOT close it: `close()` on
    a buffered reader waits for the lock `read1` holds, so a parent closing it
    on the straggler path -- the one path where the reader is still blocked --
    would hang a request thread instead of leaking a descriptor. Which makes the
    close the reader's own job on both of its exits, and this is the test that
    says it happens on the second one too.
    """
    read_fd, write_fd = os.pipe()
    stream = open(read_fd, "rb")
    with open(write_fd, "wb") as writer:
        writer.write(b"a line\n")

    drain = runner._Drain(stream, cap=1024)
    drain.run()
    assert drain.text() == "a line\n"
    assert stream.closed, "the pipe was left open after a clean EOF"

    class Exploding:
        def __init__(self):
            self.closed = False

        def read1(self, _size):
            raise OSError("the pipe went away under us")

        def close(self):
            self.closed = True

    exploding = Exploding()
    runner._Drain(exploding, cap=1024).run()
    assert exploding.closed, "the pipe was left open after a failed read"


def test_output_written_before_a_kill_is_still_returned(run_program):
    """The log of a build that gets killed is the log that matters most.

    Buffered output dies with the process, and a killed build would come back
    with an empty log and a signal number -- which says nothing about which of
    the model's own steps it was on. PYTHONUNBUFFERED in `child_environment` is
    what this pins down.
    """
    limits = TEST_LIMITS.replace(wall_seconds=2.0)
    result = run_program(textwrap.dedent("""
        import json, time
        print("PAYLOAD " + json.dumps({"reached": "the slow part"}))
        time.sleep(600)
    """), limits=limits)

    assert result.timed_out
    assert payload(result) == {"reached": "the slow part"}


def test_the_parent_returns_promptly_when_a_child_is_killed(run_program):
    """The hub is `ThreadingHTTPServer`: a request thread that never comes back
    is a thread lost for the life of the process. So the kill path has a
    deadline of its own, and this is the assertion that the whole sequence --
    wall clock, SIGKILL, reap, drain -- fits inside it."""
    limits = TEST_LIMITS.replace(wall_seconds=1.0)
    started = time.monotonic()
    result = run_program("import time; time.sleep(600)\n", limits=limits)
    elapsed = time.monotonic() - started

    assert result.timed_out
    assert result.signal is not None
    assert elapsed < 5, (
        f"the parent took {elapsed:.1f}s to get rid of a one-second build")
    assert not result.stragglers


# --------------------------------------------------------------------------
# the kill, and the pid it is aimed at
# --------------------------------------------------------------------------

def test_a_pid_that_cannot_be_waited_for_is_a_state_of_its_own(monkeypatch):
    """ECHILD is not "it exited", and the difference is who gets the SIGKILL.

    The whole reason `_wait_without_reaping` uses `waitid(WNOWAIT)` is that a
    zombie holds its pid, so the `killpg` after it is aimed at this build for
    certain. ECHILD means there is no zombie -- something already reaped it --
    and every word of that argument has stopped applying: the number is free,
    the kernel may have handed it to somebody else, and a group kill would be a
    SIGKILL to every process in a stranger's session.
    """
    def no_child(*_args, **_kw):
        raise ChildProcessError(10, "No child processes")

    monkeypatch.setattr(os, "waitid", no_child)
    assert runner._wait_without_reaping(os.getpid(), time.monotonic() + 5) == (
        runner._WAIT_UNOBSERVABLE, None)


def test_an_unvouchable_pid_is_never_killed_as_a_group(run_program, monkeypatch):
    """...and the wiring: no `killpg` is sent on that path, at all.

    Written as a spy on `os.killpg` rather than as an assertion about the
    outcome, because the outcome is IDENTICAL either way -- the build dies, the
    log comes back, the test would be green with the group kill still in there.
    The damage of that bug lands on a process this test does not own and would
    never see.
    """
    killpg_targets = []
    monkeypatch.setattr(os, "killpg",
                        lambda pgid, _sig: killpg_targets.append(pgid))
    monkeypatch.setattr(os, "waitid", lambda *_a, **_kw: (_ for _ in ()).throw(
        ChildProcessError(10, "No child processes")))

    result = run_program("import time; time.sleep(600)\n")

    assert killpg_targets == [], (
        "a process group was killed by number after the pid stopped being ours "
        "to vouch for")
    assert not result.timed_out
    # It still ends: the single-process kill is what may be sent here, and it
    # was, so nothing is left running on the host either.
    assert result.signal == int(signal.SIGKILL), result.log


def test_a_group_that_is_ours_still_gets_the_group_kill(run_program, monkeypatch):
    """The negative control for the test above.

    Without it, deleting `_kill_group` from the ordinary path would leave every
    assertion in this file green -- including the one that a spawned descendant
    dies with the build, on the day that test is the one that breaks.
    """
    killpg_targets = []
    real_killpg = os.killpg

    def spy(pgid, sig):
        killpg_targets.append(pgid)
        return real_killpg(pgid, sig)

    monkeypatch.setattr(os, "killpg", spy)
    limits = TEST_LIMITS.replace(wall_seconds=1.0)
    result = run_program("import time; time.sleep(600)\n", limits=limits)

    assert result.timed_out
    assert killpg_targets, "the ordinary path stopped killing the group"


def test_the_payload_helper_fails_loudly(run_program):
    """A program that prints nothing must fail the test that reads it, not
    return an empty answer that every assertion then agrees with. Every test in
    this directory is built on `payload`, so this is the one that keeps a
    broken probe from being reported as a passing suite."""
    result = run_program("print('nothing marked here')\n")
    with pytest.raises(AssertionError, match="printed no"):
        payload(result)
