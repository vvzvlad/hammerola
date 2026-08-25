"""The hub's own environment, read from inside a build -- before and after.

`child_environment` composes the build's environment key by key and hands it no
credential, and test_isolation.py proves that. This file is about the hole that
leaves open, which is not in `child_environment` at all: the build runs under
the SAME uid as the hub and in the SAME pid namespace, and on Linux
`/proc/<pid>/environ` is readable by anyone who passes PTRACE_MODE_READ_FSCREDS
-- which same-uid satisfies, without going anywhere near the ATTACH check that
`ptrace_scope` restricts. The tokens arrive in the hub through compose's
`environment:`, so they are in that file from the moment it execs.

So the shape of every test here is the same, and the FIRST half is what makes
the second one mean anything: a hub process that has NOT hardened itself has its
environment read out of /proc by a build, token and all; a hub process that has
is refused. Without the first half this file would pass just as happily on a
kernel where /proc is not there at all, on a container with hidepid, or against
a version of `hide_process_from_same_uid` that does nothing.

The hub is a REAL SUBPROCESS in both halves rather than this pytest process, for
two reasons. `/proc/<pid>/environ` shows the environment as it was at EXEC time
-- a `monkeypatch.setenv` afterwards changes `os.environ` and never appears in
that file -- so a token has to be there before the process starts. And
PR_SET_DUMPABLE is a property of a process that nothing resets except an exec:
setting it on the pytest process would leave every later test running under it.
"""

import subprocess
import sys
import textwrap
import time

import pytest

from src.buildproc import hardening
from src.buildproc.hardening import HardeningFailed, hide_process_from_same_uid
from src.buildproc.runner import HUB_ROOT

from probes import payload


linux_proc_only = pytest.mark.skipif(
    not sys.platform.startswith("linux"),
    reason="/proc/<pid>/environ is a Linux thing; there is nothing to hide on "
           "this platform and nothing to read either (macOS has no procfs, and "
           "its KERN_PROCARGS2 already refuses another process's environment "
           "to a non-root caller)")

# The token the fake hub carries, in its environment from exec time. Distinctive
# so the tests can look for the VALUE and not merely for the variable name.
HUB_TOKEN = "publish-token-must-not-leak-from-proc-8e41"

# A stand-in for main.py: hardens if told to, says it is up, and waits. The
# import is the real one -- that is the point of running it from HUB_ROOT.
FAKE_HUB = """
import os, sys, time
sys.path.insert(0, {root!r})
from src.buildproc.hardening import hide_process_from_same_uid

if "harden" in sys.argv:
    hide_process_from_same_uid()
open(sys.argv[1], "w").write(str(os.getpid()))
time.sleep(60)
"""

# What a model does. Nothing exotic: one open() of a path it can compose from a
# pid, which it could equally find by walking /proc for the listening process.
# The token is spliced in by `str.replace` and not by `str.format`, because the
# program itself is full of dict literals.
READER = """
import json, os, sys
pid = sys.argv[1]
try:
    with open("/proc/%s/environ" % pid, "rb") as handle:
        blob = handle.read()
except OSError as exc:
    print("PAYLOAD " + json.dumps({"read": False, "error": exc.strerror}))
else:
    print("PAYLOAD " + json.dumps({
        "read": True,
        "found_token": b"__TOKEN__" in blob,
        "bytes": len(blob),
    }))
"""


def reader_program():
    """The reader, with the token it is looking for spliced in."""
    return READER.replace("__TOKEN__", HUB_TOKEN)


def start_fake_hub(tmp_path, name, *, harden):
    """A process with the hub's token in its environment, optionally hardened."""
    script = tmp_path / f"{name}.py"
    script.write_text(FAKE_HUB.format(root=str(HUB_ROOT)), encoding="utf-8")
    pidfile = tmp_path / f"{name}.pid"

    process = subprocess.Popen(
        [sys.executable, "-s", str(script), str(pidfile)]
        + (["harden"] if harden else []),
        cwd=str(HUB_ROOT),
        # Composed rather than inherited so the token is the only interesting
        # thing in there, and so the assertion below is about THIS string.
        env={"PATH": "/usr/bin:/bin", "PUBLISH_TOKEN": HUB_TOKEN,
             "PYTHONUNBUFFERED": "1"},
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
    )
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if pidfile.exists() and pidfile.read_text().strip():
            return process, int(pidfile.read_text())
        if process.poll() is not None:
            raise AssertionError(
                f"the fake hub died before it was up: {process.stderr.read()}")
        time.sleep(0.02)
    raise AssertionError("the fake hub never came up")


@linux_proc_only
def test_a_build_reads_an_unhardened_hubs_environment(run_program, tmp_path):
    """The attack, run against a hub that has not closed it. It works.

    This is the test that makes the next one worth having. It is deliberately
    NOT an assertion that the hub is broken -- it is a hub with the hardening
    left out on purpose, so that "the read fails" in the test below is known to
    be the hardening's doing and not the platform's.
    """
    hub, pid = start_fake_hub(tmp_path, "open-hub", harden=False)
    try:
        result = run_program(reader_program(), args=(str(pid),))
        seen = payload(result)
    finally:
        hub.kill()
        hub.wait(timeout=10)

    if not seen["read"]:
        pytest.skip(f"something on this system already refuses /proc/<pid>/"
                    f"environ between same-uid processes ({seen['error']}), so "
                    f"this box cannot show the hardening making a difference")
    assert seen["found_token"], (
        "the fake hub's own token was not in its /proc entry, so this test is "
        "not measuring what it thinks it is")


@linux_proc_only
def test_a_build_cannot_read_a_hardened_hubs_environment(run_program, tmp_path):
    """...and with `prctl(PR_SET_DUMPABLE, 0)` on, the same read is refused.

    EACCES, from the kernel, because /proc/<pid>/ of a non-dumpable task is
    owned by root. Nothing about the build changed between this test and the one
    above -- same fence, same environment, same program.
    """
    hub, pid = start_fake_hub(tmp_path, "hardened-hub", harden=True)
    try:
        result = run_program(reader_program(), args=(str(pid),))
        seen = payload(result)
    finally:
        hub.kill()
        hub.wait(timeout=10)

    assert seen["read"] is False, (
        "a build read the hub's environment out of /proc; the publish token "
        "lives in there")
    assert seen["error"] == "Permission denied", seen
    assert HUB_TOKEN not in result.log


# --------------------------------------------------------------------------
# the call itself
# --------------------------------------------------------------------------

def test_the_hardening_says_what_it_did():
    """One line, and a DIFFERENT one where the call does not apply.

    The hub logs whatever this returns. "It was applied" and "this platform has
    no /proc to protect" have to be distinguishable six months later in a log,
    because the second one silently becomes the wrong answer the day somebody
    runs the hub somewhere new.

    In a subprocess because on Linux the call WORKS, and nothing but an exec
    puts the flag back: run in-process it would leave every later test in the
    session -- and anything attached to the runner -- looking at a pytest
    process whose /proc entry belongs to root.
    """
    finished = subprocess.run(
        [sys.executable, "-s", "-c",
         "import sys; sys.path.insert(0, %r);"
         "from src.buildproc.hardening import hide_process_from_same_uid;"
         "print(hide_process_from_same_uid())" % str(HUB_ROOT)],
        cwd=str(HUB_ROOT), capture_output=True, text=True, timeout=60)
    assert finished.returncode == 0, finished.stderr
    message = finished.stdout.strip()

    if sys.platform.startswith("linux"):
        assert "PR_SET_DUMPABLE=0" in message
    else:
        assert "no-op" in message and sys.platform in message


def test_a_prctl_that_does_not_take_refuses_to_be_ignored(monkeypatch):
    """Fail LOUD, in both of the two ways the call can quietly not work.

    A hub whose environment stayed readable serves traffic perfectly and looks
    exactly like one whose environment did not, which is why this cannot be a
    warning. The read-back is the second half and not decoration: a seccomp
    filter can be configured to return success for a prctl it did not perform,
    and the return code alone would agree with it.
    """
    monkeypatch.setattr(hardening.sys, "platform", "linux")

    class FakePrctl:
        def __init__(self, answers):
            self.answers = list(answers)
            self.restype = None
            self.argtypes = None

        def __call__(self, option, *_rest):
            return self.answers.pop(0)

    def libc_with(answers):
        fake = type("FakeLibc", (), {})()
        fake.prctl = FakePrctl(answers)
        return lambda *_a, **_kw: fake

    monkeypatch.setattr(hardening.ctypes, "CDLL", libc_with([-1]))
    with pytest.raises(HardeningFailed, match="failed with errno"):
        hide_process_from_same_uid()

    # The set says it worked and the flag reads back unchanged.
    monkeypatch.setattr(hardening.ctypes, "CDLL", libc_with([0, 1]))
    with pytest.raises(HardeningFailed, match="reads back as 1"):
        hide_process_from_same_uid()

    # The negative control: succeeded, and reads back cleared.
    monkeypatch.setattr(hardening.ctypes, "CDLL", libc_with([0, 0]))
    assert "PR_SET_DUMPABLE=0" in hide_process_from_same_uid()


def test_a_libc_without_prctl_is_a_refusal_too(monkeypatch):
    """The platform that claims to be Linux and has no prctl to call.

    Not a hypothetical worth much on its own; it is here because the `except`
    around the CDLL lookup would otherwise be unexecuted code, and unexecuted
    error handling is how a refusal turns into an AttributeError traceback on
    the one day it runs.
    """
    monkeypatch.setattr(hardening.sys, "platform", "linux")

    class NoPrctl:
        def __getattr__(self, name):
            raise AttributeError(name)

    monkeypatch.setattr(hardening.ctypes, "CDLL", lambda *_a, **_kw: NoPrctl())
    with pytest.raises(HardeningFailed, match="cannot reach prctl"):
        hide_process_from_same_uid()


def test_the_hub_refuses_to_start_when_the_hardening_fails(tmp_path):
    """main.py's half: the hub does not come up, and the log says why.

    Checked end to end because the wiring is the part that can be lost -- the
    function can keep working perfectly while nobody calls it, and the hub would
    then run with its environment readable and nothing anywhere saying so.
    """
    # The name is replaced on `src.buildproc`, which is where main.py imports it
    # from -- patching `src.buildproc.hardening` would leave the package's
    # already-bound re-export in place and this test would pass against a hub
    # that never calls anything.
    launcher = tmp_path / "run_the_hub.py"
    launcher.write_text(textwrap.dedent(f"""
        import sys
        sys.path.insert(0, {str(HUB_ROOT)!r})

        import src.buildproc as buildproc

        def refuse():
            raise buildproc.HardeningFailed("the kernel said no")

        buildproc.hide_process_from_same_uid = refuse

        import main
        main.main()
    """), encoding="utf-8")

    finished = subprocess.run(
        [sys.executable, "-s", str(launcher)],
        cwd=str(HUB_ROOT),
        env={"PATH": "/usr/bin:/bin", "PUBLISH_TOKEN": "x",
             "COMMENT_READ_TOKEN": "y", "DATA_DIR": str(tmp_path / "data")},
        capture_output=True, text=True, timeout=60,
    )

    assert finished.returncode == 1, (finished.stdout, finished.stderr)
    assert "Refusing to start" in finished.stderr
    assert "the kernel said no" in finished.stderr
    assert "Serving on" not in finished.stderr, "the hub came up anyway"
