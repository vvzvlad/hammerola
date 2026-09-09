"""What a build cost, printed on the side that waited for it.

THE NUMBER WAS ALWAYS THERE AND NOBODY EVER SAW IT. The parent times every build
on a monotonic clock, the job record has carried `duration_seconds` since step 5,
and the hub serves it on `GET /api/v1/jobs/<id>` — and nothing in the client read
it, so the agent that pushed learned only that the build was green. It cannot
measure this for itself either: the CAD kernel lives in the hub's image, so a
model that imports `cadquery` does not necessarily run on the machine it was
written on. Between three minutes and the hub's fifteen-minute wall is the whole
zone where everything is green and everything is slow, and nothing was reporting
it.

TWO NUMBERS AND THEY ARE NEVER SWAPPED. The BUILD comes from the parent's
monotonic clock and is read out of the record; the QUEUE WAIT is the gap between
two wall-clock stamps and is computed here. The tests below are written so that
one standing in for the other fails: every record whose build time is asserted
carries stamps that disagree with it.

The end-to-end runs are here for the wiring — the line is printed, on both
endings, and it does not displace the URL — and the rest drive
`cli._print_duration` with a record directly, because a threshold of three
minutes cannot be reached by a hub whose builder copies a directory.
"""

from datetime import datetime

import pytest
from harness import TOKEN, failing_builder

from hammerola import cli
from hammerola.cli import main
from hammerola.hub import SLOW_BUILD_SECONDS
from src.buildproc import runner
from src.store import utcnow_iso

# The two stamps of a job that waited eight seconds for a worker. Written out
# rather than computed, so a test that asserts `queued 8s` is asserting about
# these two strings and not about arithmetic it did itself.
CREATED = "2026-09-09T12:00:00Z"
STARTED = "2026-09-09T12:00:08Z"


@pytest.fixture(autouse=True)
def configured(monkeypatch, hub):
    """Point the client at the test hub, with the token that hub checks."""
    monkeypatch.setenv("HUB_URL", hub.url)
    monkeypatch.setenv("EDIT_TOKEN", TOKEN)


def run(model, *args):
    return main(["-C", str(model), *args, "--timeout", "60"])


def record(duration, **fields):
    """A finished job record, as the hub serves one.

    The stamps are eight seconds apart by default and the duration is whatever
    the caller says: a build time computed from the stamps would come out as 8
    against every assertion below.
    """
    base = {"state": "done", "status": "ok", "created": CREATED,
            "started": STARTED, "duration_seconds": duration}
    base.update(fields)
    return base


def printed(capsys):
    return capsys.readouterr().out


# -- the wiring, against a real hub ------------------------------------------
def test_a_build_says_how_long_it_took_without_taking_the_last_line(
        hub, model, capsys):
    """The line goes between the log and the URL, and the URL stays last.

    `_suggest_git` already prints in that gap and its docstring says why the URL
    has to be the last thing a run says: it gets copied out of a terminal and
    pasted somewhere, and anything after it stops it being a link. A second
    printer in the same gap is the one that could break that, so it is pinned
    here rather than left to the reading.
    """
    assert run(model, "build") == 0

    out = printed(capsys)
    lines = out.rstrip().splitlines()
    built = [line for line in lines if line.startswith("built in ")]
    assert len(built) == 1, f"expected one duration line, got {built}"
    assert lines.index(built[0]) > lines.index("--- end of build log ---")
    assert lines[-1] == f"{hub.url}/project/demo0001/dev/"


def test_the_line_is_read_out_of_the_record_the_hub_actually_served(
        hub, model, capsys):
    """The three fields the client reaches into a job record for.

    `duration_seconds`, `created` and `started` are the hub's names, read on a
    side that validates nothing: rename any of them there and this line stops
    being printed — or quietly loses its bracket — on a client that is otherwise
    working perfectly, with no error anywhere. So the names are pinned against a
    record this hub really answered with, and the number printed is compared
    with the one in it.
    """
    assert run(model, "build") == 0

    out = printed(capsys)
    job_id = next(line.split()[3].rstrip(":") for line in out.splitlines()
                  if line.startswith("queued as job "))
    served = hub.job(job_id).json()
    assert {"duration_seconds", "created", "started"} <= set(served)
    shown = cli._clock(cli._whole_seconds(served["duration_seconds"]))
    assert f"built in {shown}" in out


def test_a_failed_build_says_how_long_it_ran_for(hub_factory, model, monkeypatch,
                                                 capsys):
    """THE CASE THE LINE EXISTS FOR, and the reason it is not on the success
    branch: a build that died in its twelfth minute is precisely the one whose
    time somebody needs, and the failure says nothing about how long it took."""
    broken = hub_factory(build_runner=failing_builder())
    monkeypatch.setenv("HUB_URL", broken.url)

    assert run(model, "build") == 1
    assert "built in " in printed(capsys)


def test_a_push_that_rebuilt_nothing_says_nothing_about_time(hub, model,
                                                             capsys):
    """The 200 route has no job and no record — there is no build to report.

    A `built in 0s` there would be a claim about a build that never ran, on the
    one push whose whole point is that the hub already had this source.
    """
    assert run(model, "build") == 0
    capsys.readouterr()
    assert run(model, "build") == 0
    out = printed(capsys)
    assert "unchanged" in out
    assert "built in" not in out


# -- the line itself ---------------------------------------------------------
def test_the_build_time_is_the_records_own_number_and_not_the_stamps(capsys):
    """Both halves of the format, and the two numbers told apart.

    132 seconds of build against 8 seconds of queue: swap the two sources and
    neither number survives. Both are under the slow-build threshold, so what is
    asserted here is the whole of what an ordinary build prints.
    """
    cli._print_duration(record(132.0))
    assert printed(capsys) == "built in 2m12s (queued 8s)\n"


def test_a_build_that_measured_nothing_is_still_a_build(capsys):
    """`is not None` AND NOT A TRUTHINESS TEST, held here because the difference
    is invisible: a falsy check prints nothing for a zero-second build, and
    every hub in this suite copies a directory."""
    cli._print_duration(record(0.0))
    assert printed(capsys) == "built in 0s (queued 8s)\n"


def test_a_record_with_no_duration_says_nothing_rather_than_guessing(capsys):
    """The stamps are RIGHT THERE and are not used: a build time computed from
    them would answer 8s for a build that was never timed."""
    cli._print_duration(record(None))
    assert printed(capsys) == ""


# -- the queue bracket -------------------------------------------------------
def test_a_job_that_never_started_carries_no_queue_bracket(capsys):
    cli._print_duration(record(132.0, started=None))
    assert printed(capsys) == "built in 2m12s\n"


def test_stamps_that_ran_backwards_carry_no_queue_bracket(capsys):
    """The two stamps are WALL CLOCK and can jump — an NTP step, a container's
    clock catching up. A negative wait is that, and `(queued -3s)` would be the
    client reporting somebody else's clock as a fact about the queue."""
    cli._print_duration(record(132.0, created=STARTED, started=CREATED))
    assert printed(capsys) == "built in 2m12s\n"


def test_a_wait_under_a_second_is_not_worth_a_bracket(capsys):
    """The ordinary case on an idle hub: the stamps are equal, and `(queued 0s)`
    says nothing at all."""
    cli._print_duration(record(132.0, started=CREATED))
    assert printed(capsys) == "built in 2m12s\n"


# -- the warning -------------------------------------------------------------
def test_a_build_over_the_threshold_is_told_where_to_go(capsys):
    """The number, the threshold, and the three things to do about it.

    All three are written up in the skill and named rather than explained here:
    the point of the line is to get somebody to the section that has them.
    """
    cli._print_duration(record(SLOW_BUILD_SECONDS + 1))
    out = printed(capsys)
    assert "warning:" in out
    # The threshold is printed in the SAME format as the measured time, so the
    # comparison the line makes can be read without doing arithmetic on it.
    assert cli._clock(SLOW_BUILD_SECONDS) in out
    assert "checklib.material_at" in out
    assert "@cache" in out
    assert "pairwise_interference" in out
    # A WARNING AND NOT A REFUSAL — a slow build publishes, and the line has to
    # say so where somebody skimming a red-looking terminal will see it.
    assert "published" in out


def test_a_build_at_the_threshold_is_not_warned_about(capsys):
    """Strictly above, so the number reads as `over three minutes` rather than
    `three minutes or more`."""
    cli._print_duration(record(float(SLOW_BUILD_SECONDS)))
    out = printed(capsys)
    assert "built in 3m00s" in out
    assert "warning:" not in out


@pytest.mark.parametrize("status", [runner.STATUS_TIMEOUT,
                                    runner.STATUS_CPU_EXHAUSTED])
def test_a_build_killed_by_a_ceiling_is_not_asked_to_optimise(status, capsys):
    """Both carry their own diagnosis already.

    "This build was slow, try optimising" on top of "killed for running past a
    ceiling" is noise on top of an answer — and the answer is the one thing the
    reader has to act on. The TIME is still printed: that is what says how far
    past the ceiling the build got.
    """
    cli._print_duration(record(SLOW_BUILD_SECONDS + 720, state="failed",
                               status=status))
    out = printed(capsys)
    assert "built in 15m00s" in out
    assert "warning:" not in out


def test_the_two_self_diagnosing_statuses_are_the_hubs_own_words(capsys):
    """A copy, so it is compared against its source.

    The client is stdlib-only and may not import `src.buildproc`, so these two
    strings are literals in `cli.py`. Renamed on the hub and not here, the
    warning would come back on exactly the two endings it was taken off.
    """
    assert cli.SELF_DIAGNOSING == (runner.STATUS_TIMEOUT,
                                   runner.STATUS_CPU_EXHAUSTED)


@pytest.mark.parametrize("value", [
    "abc",                # a string where a number was promised
    float("nan"),         # int(round(nan)) -> ValueError
    float("inf"),         # int(round(inf)) -> OverflowError
    float("-inf"),
    -5.0,                 # a negative duration is not a duration
    [],
    {},
])
def test_a_duration_the_client_cannot_read_prints_nothing_and_ends_no_run(
        value, capsys):
    """Four refusals in `_whole_seconds`, and only one of them was held.

    The FAR END chooses this field, and this line is printed after a build that
    has already finished — so anything unreadable here has to fall out silently
    rather than raise into a run whose work is done and published. The exception
    tuple is the interesting part: `int(round(nan))` and `int(round(inf))` raise
    two DIFFERENT errors, and the next reader who trims the `except` to the one
    they can explain, or swaps the `>= 0` for a truthiness test, would do it to a
    green suite. That is what this pins.
    """
    cli._print_duration(record(value))
    assert printed(capsys) == ""


def test_the_client_parses_the_stamp_format_the_hub_actually_writes():
    """The second copy in this module, and the one that fails SILENTLY.

    `cli._STAMP` is a copy of what `store.utcnow_iso` prints, and the only thing
    that reads a stamp is the queue bracket. Add milliseconds to the hub's stamp,
    or spell the zone `+00:00` instead of `Z`, and `strptime` raises, `_queue_wait`
    answers None, and `(queued 8s)` is gone from every run for ever — with no
    error anywhere, on a client that is otherwise working. The stamps in this
    file are literals, so they share the assumption instead of checking it; this
    is the one assertion that crosses to the hub's own writer.

    `tests/client/test_limits.py` does the same thing for the ceilings, and for
    the same reason: a copy that nothing compares against is a copy that drifts.
    """
    assert datetime.strptime(utcnow_iso(), cli._STAMP)


# -- the format --------------------------------------------------------------
@pytest.mark.parametrize("seconds, shown", [
    (0, "0s"),
    (8, "8s"),
    (59, "59s"),
    (60, "1m00s"),
    (252, "4m12s"),
    (900, "15m00s"),
    (3600, "1h00m00s"),
    (3723, "1h02m03s"),
])
def test_the_clock_is_written_out_by_hand(seconds, shown):
    """The client installs nothing, so the format is code rather than a call.

    Zero-padded past the first field on purpose: two builds compared by eye in a
    transcript line up, and `4m2s` next to `4m12s` does not.
    """
    assert cli._clock(seconds) == shown
