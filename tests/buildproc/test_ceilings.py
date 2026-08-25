"""The ceilings: who puts each one on, and what each one actually catches.

SPEC 8A.2 step 4 is explicit that the three mechanisms do DIFFERENT things and
that confusing them is the mistake: `RLIMIT_CPU` kills on processor time burned
and cannot see a sleep; the parent's wall clock catches the sleep and the
deadlocked thread pool; `faulthandler` catches neither but says WHERE. So each
one is tested against the failure only IT can catch -- a busy loop for the CPU
ceiling, a sleep for the wall clock -- rather than against a program that would
be caught by any of them and would therefore prove nothing about which.
"""

import json
import os
import signal
import subprocess
import sys
import textwrap
import time

import pytest

from src.buildproc import (
    Limits,
    LimitsUnavailable,
    STATUS_OK,
    STATUS_OUTPUT_LIMIT,
    child_environment,
    run_isolated,
)
from src.buildproc.limits import (
    EXIT_LIMITS_UNAVAILABLE,
    MiB,
    apply_process_limits,
)
from src.buildproc import runner
from src.buildproc.runner import HUB_ROOT

from probes import BUILD_LIMITS, TEST_LIMITS, darwin_only, linux_only, payload


# --------------------------------------------------------------------------
# the rlimits, and who applies them
# --------------------------------------------------------------------------

def test_the_ceilings_are_on_the_child_process_itself(run_program):
    """Requested outside, in force inside -- with soft equal to hard.

    The equality is the part worth pinning. At the SOFT limit the kernel sends
    SIGXCPU, which a process may catch and ignore; at the HARD limit Linux
    sends SIGKILL, which it may not. A gap between the two is a documented way
    for untrusted code to keep running (see the SIGXCPU test below), so the
    numbers being equal is a property of this component and not an accident of
    how `setrlimit` was called.
    """
    result = run_program(textwrap.dedent("""
        import json, resource
        print("PAYLOAD " + json.dumps({
            "cpu": resource.getrlimit(resource.RLIMIT_CPU),
            "fsize": resource.getrlimit(resource.RLIMIT_FSIZE),
            "nofile": resource.getrlimit(resource.RLIMIT_NOFILE),
            "core": resource.getrlimit(resource.RLIMIT_CORE),
        }))
    """))

    assert result.exit_code == 0, result.log
    seen = payload(result)
    assert seen["cpu"] == [TEST_LIMITS.cpu_seconds, TEST_LIMITS.cpu_seconds]
    assert seen["fsize"] == [TEST_LIMITS.file_bytes, TEST_LIMITS.file_bytes]
    assert seen["nofile"] == [TEST_LIMITS.open_files, TEST_LIMITS.open_files]
    assert seen["core"] == [0, 0]


def test_the_ceilings_are_named_in_the_build_log(run_program):
    """What was applied is written where the person debugging a build can see it.

    `apply_process_limits` clamps a request DOWN to an inherited hard limit
    without complaining, so the number in the code and the number in force are
    not always the same one. This line is where that difference exists.
    """
    result = run_program("print('hello')\n")

    assert "buildproc: ceilings in force:" in result.log
    assert "RLIMIT_CPU=" in result.log


def test_the_cpu_ceiling_kills_a_busy_loop_before_the_wall_clock(run_program):
    """The failure only RLIMIT_CPU catches early: code that burns processor time.

    The wall clock is set thirty times longer than the CPU allowance here, so
    an implementation whose only ceiling is the parent's timer takes half a
    minute to fail this test instead of a second -- and `timed_out` says which
    one did the killing.

    Why the CPU ceiling is worth having when the wall clock exists at all: it
    is the kernel's, so it still holds for a build whose parent has DIED. An
    orphaned build cannot be killed by a timer that no longer runs anywhere.
    """
    limits = TEST_LIMITS.replace(wall_seconds=30.0, cpu_seconds=1)
    started = time.monotonic()
    result = run_program("while True:\n    pass\n", limits=limits)
    elapsed = time.monotonic() - started

    assert not result.timed_out, (
        "the wall clock killed it, so nothing here says the CPU ceiling works")
    # Linux sends SIGKILL at the hard limit; Darwin's default action for the
    # SIGXCPU it sends at the soft one is to terminate. Either is the ceiling
    # firing -- what matters is that it fired, quickly, and was not the timer.
    assert result.signal in (int(signal.SIGKILL), int(signal.SIGXCPU)), result.log
    assert elapsed < 15, f"a one-second CPU allowance took {elapsed:.1f}s to fire"


@linux_only
def test_a_sigxcpu_handler_cannot_extend_the_cpu_ceiling(run_program):
    """soft == hard, tested the only way that means anything: by fighting it.

    A model that installs a SIGXCPU handler and ignores the signal keeps
    running for as long as the gap between the soft and the hard limit allows.
    With the two equal, Linux sends SIGKILL and there is no gap to run in.

    Linux only, and the reason is a measured platform difference rather than
    caution: on Darwin this same program survives indefinitely -- the handler
    catches SIGXCPU at the soft limit and the hard limit is never enforced, so
    a macOS workstation has no CPU ceiling against hostile code at all. The hub
    runs on Linux; the parent's wall clock is what covers the workstation.
    """
    limits = TEST_LIMITS.replace(wall_seconds=30.0, cpu_seconds=1)
    result = run_program(textwrap.dedent("""
        import signal, sys
        signal.signal(signal.SIGXCPU, lambda *a: sys.stderr.write("ignored\\n"))
        while True:
            pass
    """), limits=limits)

    assert not result.timed_out, result.log
    assert result.signal == int(signal.SIGKILL), (
        "SIGXCPU was catchable and nothing followed it: the soft limit is "
        "below the hard one, and untrusted code can run as long as it likes")


def test_the_file_size_ceiling_stops_a_build_filling_the_volume(run_program):
    """RLIMIT_FSIZE, which the kernel enforces with SIGXFSZ.

    The data volume is shared with every published build, and a model that
    writes until the disk is full takes the hub down with it -- reading is what
    the hub is FOR, and it cannot serve anything from a full volume.
    """
    limits = TEST_LIMITS.replace(file_bytes=64 * 1024)
    result = run_program(textwrap.dedent("""
        import os
        with open(os.path.join(os.environ["TMPDIR"], "big"), "wb") as handle:
            while True:
                handle.write(b"x" * (1024 * 1024))
                handle.flush()
    """), limits=limits)

    assert not result.timed_out, result.log
    assert result.signal == int(signal.SIGXFSZ) or result.exit_code not in (0, None), (
        f"writing past the file ceiling was allowed: {result.log}")


@linux_only
def test_the_memory_ceiling_stops_a_runaway_allocation(run_program):
    """RLIMIT_AS: the allocation fails instead of the host swapping.

    Linux only, and not because the ceiling is optional -- because Darwin will
    not apply it at any value (see `limits.memory_limit_supported`, which
    records the measurement). The companion test below is what covers the
    workstation: there, this ceiling REFUSES the build rather than quietly
    running it unbounded.
    """
    limits = TEST_LIMITS.replace(memory_bytes=512 * MiB)
    result = run_program(textwrap.dedent("""
        import json
        try:
            hog = bytearray(4 * 1024 * 1024 * 1024)
        except MemoryError:
            print("PAYLOAD " + json.dumps({"refused": True}))
        else:
            print("PAYLOAD " + json.dumps({"refused": False, "got": len(hog)}))
    """), limits=limits)

    assert payload(result) == {"refused": True}, result.log


@darwin_only
def test_a_ceiling_the_platform_cannot_apply_refuses_the_build(run_program):
    """Fail closed, end to end, on the platform that really cannot do it.

    The alternative -- carry on without the ceiling -- is indistinguishable
    from success right up to the moment a model eats the machine. Here the
    build never starts, the exit code says which half refused, and the message
    names the limit.
    """
    limits = TEST_LIMITS.replace(memory_bytes=512 * MiB)
    result = run_program("print('PAYLOAD {}')\n", limits=limits)

    assert result.exit_code == EXIT_LIMITS_UNAVAILABLE, result.log
    assert "refusing to start the build" in result.log
    assert "RLIMIT_AS" in result.log
    assert "does not implement it at ANY value" in result.log
    assert "PAYLOAD" not in result.log, "the program ran without its ceiling"


def test_a_ceiling_that_will_not_go_on_raises_rather_than_warns(monkeypatch):
    """The unit-level half of fail-closed, on every platform.

    `apply_process_limits` runs inside the wrapper, one exec before untrusted
    code. A `setrlimit` that refuses has to end the process, and this is the
    only place that decision can be tested without a platform that happens to
    refuse something.
    """
    import resource

    def refuse(*_args, **_kw):
        raise ValueError("current limit exceeds maximum limit")

    monkeypatch.setattr(resource, "setrlimit", refuse)
    with pytest.raises(LimitsUnavailable) as caught:
        apply_process_limits(TEST_LIMITS.replace(cpu_seconds=5).rlimit_spec())
    assert "RLIMIT_CPU" in str(caught.value)


def test_a_spec_that_does_not_name_every_ceiling_is_refused():
    """Fail CLOSED on the SHAPE of the spec, not only on its values.

    The spec crosses a process boundary as JSON, and the obvious reader --
    `spec.get(field)`, skip what is not there -- cannot tell a ceiling
    deliberately switched off from one that went missing on the way. Both of
    those are silent, and both end with a build running under fewer limits than
    it was configured with while the log cheerfully lists the ones that did go
    on. An unknown key is the same failure from the other side: a field renamed
    on one half of this component and dropped without a word by the other.

    `None` still means "off" -- `processes` is the standing example -- and it
    has to be WRITTEN DOWN to mean it.
    """
    full = TEST_LIMITS.rlimit_spec()

    with pytest.raises(LimitsUnavailable, match="missing: .*cpu_seconds"):
        apply_process_limits({})
    with pytest.raises(LimitsUnavailable, match="missing: core_bytes"):
        apply_process_limits({k: v for k, v in full.items() if k != "core_bytes"})
    with pytest.raises(LimitsUnavailable, match="unknown: cpu_secondz"):
        apply_process_limits({**full, "cpu_secondz": 5})
    with pytest.raises(LimitsUnavailable, match="must be an object"):
        apply_process_limits([("cpu_seconds", 5)])

    # The negative control: the real spec, complete, goes on without complaint
    # and says so -- including the deliberately-off one.
    applied = apply_process_limits(full)
    assert any(line.startswith("RLIMIT_CPU=") for line in applied), applied
    assert "RLIMIT_NPROC=off" in applied, (
        "a ceiling that is None must be reported as off rather than omitted: "
        "silence is what the missing-field check above exists to forbid")


def test_the_wrapper_runs_nothing_under_an_empty_spec(tmp_path):
    """`wrapper.py '{}' -- <anything>` used to be "run it under no ceilings".

    End to end because that is where it was harmless-looking: the wrapper
    printed "ceilings in force:" with nothing after it and exec'd the target,
    so the one line anybody would look at said the fence was up.
    """
    marker = tmp_path / "the-target-ran"
    target = tmp_path / "target.py"
    target.write_text(f"open({str(marker)!r}, 'w').write('ran')\n", encoding="utf-8")

    finished = subprocess.run(
        [sys.executable, "-s", "-m", "src.buildproc.wrapper", "{}", "--",
         sys.executable, "-s", str(target)],
        cwd=str(HUB_ROOT),
        env=child_environment(home=tmp_path, tmp=tmp_path, threads=1),
        capture_output=True, text=True, timeout=60,
    )

    assert finished.returncode == EXIT_LIMITS_UNAVAILABLE, finished.stderr
    assert not marker.exists(), "the target ran with no ceilings at all"
    assert "must name exactly the fields" in finished.stderr


def test_the_wrapper_does_not_exec_the_target_when_a_ceiling_is_refused(tmp_path):
    """...and the refusal happens BEFORE the target exists as a process.

    Driven through the wrapper's own command line rather than through
    `run_isolated`, because `Limits` validates what it is given and the point
    here is what the wrapper does with a spec it cannot honour. A string where
    a number belongs is the shortest way to get a real `setrlimit` to fail on
    any platform.
    """
    marker = tmp_path / "the-target-ran"
    target = tmp_path / "target.py"
    target.write_text(f"open({str(marker)!r}, 'w').write('ran')\n", encoding="utf-8")

    finished = subprocess.run(
        [sys.executable, "-s", "-m", "src.buildproc.wrapper",
         json.dumps({**TEST_LIMITS.rlimit_spec(), "cpu_seconds": "not a number"}),
         "--", sys.executable, "-s", str(target)],
        cwd=str(HUB_ROOT),
        env=child_environment(home=tmp_path, tmp=tmp_path, threads=1),
        capture_output=True, text=True, timeout=60,
    )

    assert finished.returncode == EXIT_LIMITS_UNAVAILABLE, finished.stderr
    assert "refusing to start the build" in finished.stderr
    assert not marker.exists(), "the target was exec'd anyway"
    # The message names the field and the value it could not use. Asserted
    # because the refusal has two layers -- the type check and the `setrlimit`
    # that would raise anyway -- and without this the outer one could be
    # deleted with every test still green, leaving the diagnosis to a TypeError
    # from inside `min()`.
    assert "cpu_seconds='not a number' is not an integer" in finished.stderr


# --------------------------------------------------------------------------
# what the build may LEAVE BEHIND: the output ceiling
# --------------------------------------------------------------------------
#
# RLIMIT_FSIZE, tested above, caps ONE file. Nothing in the kernel caps the sum
# or the count, and this is the one ceiling in this component whose absence
# outlives the build that crossed it: CPU and memory are given back when the
# process dies, bytes on the data volume are not. A full volume is not a build
# that failed, it is a hub that cannot serve -- reading is what it exists for.

# A model that writes into --out until something stops it. It reads the path out
# of argv the way the forgery in test_result_forgery.py does; the `--out`
# directory does not exist yet at this point, because `build()` creates it only
# after `load_model()` has returned and this model never returns.
FLOOD = """
    import os, sys, time

    out = sys.argv[sys.argv.index("--out") + 1]
    os.makedirs(out, exist_ok=True)
    chunk = b"x" * {chunk}
    n = 0
    while True:
        with open(os.path.join(out, "part%06d.bin" % n), "wb") as handle:
            handle.write(chunk)
        n += 1
        time.sleep({pause})
"""


def test_a_build_that_fills_the_volume_is_stopped_while_it_is_writing(
        project, monkeypatch):
    """The total-size ceiling, enforced DURING the build rather than after it.

    Every individual write here is legal -- far under RLIMIT_FSIZE -- and the
    sum is what is not. The parent measures the output directory on the polls it
    is already doing for the wall clock, and kills when the sum crosses.

    The wall clock is left long on purpose: a component whose only ceiling was
    the timer would pass this test after thirty seconds of writing, having
    filled the volume first, and `status` is what tells the two apart.
    """
    monkeypatch.setattr(runner, "OUTPUT_POLL_SECONDS", 0.05)
    limits = BUILD_LIMITS.replace(wall_seconds=30.0, output_bytes=2 * MiB,
                                  output_files=None)
    started = time.monotonic()
    outcome = project.build(FLOOD.format(chunk=128 * 1024, pause=0.01),
                            limits=limits)
    elapsed = time.monotonic() - started

    assert outcome.status == STATUS_OUTPUT_LIMIT, outcome.log
    assert "more than 2097152 bytes" in outcome.log
    assert elapsed < 20, f"the wall clock got there first, after {elapsed:.1f}s"
    assert outcome.files == ()


def test_a_build_that_writes_endless_tiny_files_is_stopped_too(
        project, monkeypatch):
    """The other shape of the same attack, and the reason for a SECOND number.

    A million empty files costs inodes rather than bytes, and a byte ceiling
    never notices: the volume runs out of inodes with megabytes free, which
    fails every later write on the host with ENOSPC and a size that says there
    is room. So the count is its own ceiling, not a derived one.
    """
    monkeypatch.setattr(runner, "OUTPUT_POLL_SECONDS", 0.05)
    limits = BUILD_LIMITS.replace(wall_seconds=30.0, output_bytes=None,
                                  output_files=20)
    outcome = project.build(FLOOD.format(chunk=1, pause=0.005), limits=limits)

    assert outcome.status == STATUS_OUTPUT_LIMIT, outcome.log
    assert "more than 20 files" in outcome.log


def test_what_the_guard_did_not_see_is_still_refused_after_the_build(
        project, monkeypatch):
    """The half that cannot be outrun, and why the check exists on both sides.

    The guard polls; a build fast enough writes it all between two polls and
    exits cleanly with a perfectly honest result. Measuring once more after the
    process is gone is what makes sure nothing over the ceiling is ever
    PUBLISHED -- it cannot save the volume, which is what the guard is for, but
    it is the one that decides.

    The guard is disabled here by pushing its interval past the build, which is
    the only way to be sure THIS assertion is about the measurement after and
    not about the one during.
    """
    monkeypatch.setattr(runner, "OUTPUT_POLL_SECONDS", 3600.0)
    limits = BUILD_LIMITS.replace(output_bytes=MiB, output_files=None)
    outcome = project.build("""
        import json, os, sys

        argv = sys.argv
        out = argv[argv.index("--out") + 1]
        os.makedirs(out, exist_ok=True)
        for n in range(8):
            with open(os.path.join(out, "part%d.bin" % n), "wb") as handle:
                handle.write(b"x" * (512 * 1024))
        open(argv[argv.index("--result") + 1], "w").write(
            json.dumps({"files": ["part0.bin"]}))
        os._exit(0)
    """, limits=limits)

    assert outcome.status == STATUS_OUTPUT_LIMIT, outcome.log
    assert "more than 1048576 bytes" in outcome.log
    assert outcome.files == ()


def test_an_ordinary_build_is_nowhere_near_the_output_ceiling(
        project, monkeypatch):
    """The negative control, and the one that keeps the numbers honest.

    A ceiling that refuses real builds is not a ceiling, it is an outage. This
    writes what a small model's `_out/` looks like -- a handful of files, a few
    hundred kilobytes -- under the PRODUCTION numbers, and it has to come back
    ok.
    """
    monkeypatch.setattr(runner, "OUTPUT_POLL_SECONDS", 0.05)
    limits = BUILD_LIMITS.replace(output_bytes=Limits().output_bytes,
                                  output_files=Limits().output_files)
    outcome = project.build("""
        import json, os, sys

        argv = sys.argv
        out = argv[argv.index("--out") + 1]
        os.makedirs(out, exist_ok=True)
        names = ["meta.json", "metrics.json", "body.stl", "view.json",
                 "body.png"]
        for name in names:
            with open(os.path.join(out, name), "wb") as handle:
                handle.write(b"x" * (64 * 1024))
        open(argv[argv.index("--result") + 1], "w").write(
            json.dumps({"files": names}))
        os._exit(0)
    """, limits=limits)

    assert outcome.status == STATUS_OK, outcome.log
    assert len(outcome.files) == 5


def test_the_output_measurement_does_not_follow_a_symlink_out_of_the_build(
        tmp_path):
    """A link is charged as a link, not as everything behind it.

    Otherwise the cheapest way past this ceiling is to `ln -s /` -- the walk
    would then measure the whole filesystem, decide the build is enormous and
    refuse every build on the host. And the cheapest way to make the hub read
    files it should not is the same link with the walk following it.
    """
    out = tmp_path / "out"
    out.mkdir()
    big = tmp_path / "elsewhere"
    big.mkdir()
    (big / "huge.bin").write_bytes(b"x" * (4 * 1024))
    (out / "small.bin").write_bytes(b"x")
    os.symlink(big, out / "link")

    limits = Limits(output_bytes=2048, output_files=None)
    assert runner._measure_output(out, limits) is None, (
        "the walk followed a symlink out of the build directory")

    (out / "real.bin").write_bytes(b"x" * 4096)
    assert runner._measure_output(out, limits) is not None


# --------------------------------------------------------------------------
# the wall clock, and the watchdog inside the child
# --------------------------------------------------------------------------

def test_a_hang_that_burns_no_cpu_is_killed_by_the_wall_clock(run_program):
    """The failure NOTHING else here can catch.

    A sleeping process spends no processor time, so RLIMIT_CPU never fires on
    it however long it sleeps -- and a deadlocked OCCT thread pool, which is
    the real version of this, looks exactly the same from outside. The CPU
    allowance is left twenty times larger than the wall clock so that a
    component relying on it would simply never return.
    """
    limits = TEST_LIMITS.replace(wall_seconds=2.0, cpu_seconds=40)
    started = time.monotonic()
    result = run_program("import time; time.sleep(600)\n", limits=limits)
    elapsed = time.monotonic() - started

    assert result.timed_out
    assert result.signal == int(signal.SIGKILL)
    assert result.exit_code is None
    # The upper bound is tight ON PURPOSE, and it is what makes this test say
    # anything about the kill at all. `_wait_after_kill` fires a second
    # `killpg` when its own five-second grace expires, so a component that had
    # LOST the deliberate kill would still end this process -- five seconds
    # late, through the recovery path, with every loose assertion still green.
    assert 2.0 <= elapsed < 5, f"killed after {elapsed:.1f}s, wall clock was 2s"


def test_the_in_child_watchdog_dumps_the_stack_before_the_parent_kills(run_program):
    """`faulthandler.dump_traceback_later(N, exit=True)`, the second echelon.

    The parent's SIGKILL says a build hung; this says WHERE. It is implemented
    in C and takes no GIL, so it fires where a watchdog thread cannot -- and
    the function name in the dump is the whole reason it is worth running a
    second timer at all.

    Its deadline is deliberately under the parent's: the two together are
    "print the stack, and if that does not happen either, kill it anyway".
    """
    limits = TEST_LIMITS.replace(wall_seconds=20.0, hang_dump_seconds=1.0)
    result = run_program(textwrap.dedent("""
        import faulthandler, time
        faulthandler.dump_traceback_later(1.0, exit=True)
        def where_the_model_got_stuck():
            time.sleep(600)
        where_the_model_got_stuck()
    """), limits=limits)

    assert not result.timed_out, "the parent's kill got there first"
    assert result.exit_code == 1, result.log
    assert "Timeout (" in result.log
    assert "where_the_model_got_stuck" in result.log


def test_a_hang_dump_at_or_past_the_wall_clock_is_refused():
    """A watchdog that fires after the kill is a watchdog that never fires.

    Configuration, checked where it is written rather than discovered as a
    missing stack in a log six months later.
    """
    with pytest.raises(ValueError, match="under wall_seconds"):
        Limits(wall_seconds=10.0, hang_dump_seconds=10.0)
    with pytest.raises(ValueError, match="wall_seconds must be positive"):
        Limits(wall_seconds=0)


# --------------------------------------------------------------------------
# the log
# --------------------------------------------------------------------------

def test_the_log_is_capped_and_the_flood_does_not_stall_the_build(run_program):
    """A model printing in a loop is the model's problem, not the hub's memory.

    Both halves are asserted, and the second is the one that is easy to get
    wrong: a parent that stops READING at the cap leaves the child blocked
    writing into a full pipe. That child burns no CPU and looks exactly like a
    hang, so a runaway `print` would be reported as a timeout -- with the real
    cause, that the parent stopped listening, appearing nowhere. Here it exits
    cleanly, on its own, well inside the wall clock.
    """
    limits = TEST_LIMITS.replace(log_bytes=8 * 1024, wall_seconds=30.0)
    result = run_program(textwrap.dedent("""
        line = "flood " * 20
        for _ in range(60000):
            print(line)
        print("done")
    """), limits=limits)

    assert result.exit_code == 0, result.log[:2000]
    assert result.log_truncated
    assert result.dropped_bytes > 5 * MiB
    # The cap is on BYTES kept; decoding can add a few for a multi-byte
    # sequence the cut landed inside.
    assert len(result.log.encode("utf-8")) <= limits.log_bytes + 8


def test_both_streams_are_one_log(run_program):
    """stdout and stderr merged, because a traceback belongs where the progress
    line before it was printed -- and because whoever pushed gets ONE log."""
    result = run_program(textwrap.dedent("""
        import sys
        print("on stdout")
        sys.stderr.write("on stderr\\n")
    """))

    assert "on stdout" in result.log
    assert "on stderr" in result.log


def test_a_run_that_says_nothing_still_returns_a_log(run_program):
    """The wrapper's own line is always there, so `log` is never empty and a
    caller never has to distinguish "said nothing" from "was not captured"."""
    result = run_isolated(
        [sys.executable, "-s", "-c", "pass"],
        limits=TEST_LIMITS,
        env=child_environment(home="/tmp", tmp="/tmp", threads=1),
    )

    assert result.exit_code == 0
    assert result.log.strip()
    assert not result.log_truncated
