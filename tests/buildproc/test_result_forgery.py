"""The model writing the build's result for it, and the parent not believing it.

Everything in this file is one attack with variations, and it is a REPRODUCED
one rather than a hypothetical: the model runs in the same interpreter as the
code that writes the result file, so it can read `--result` out of `sys.argv`,
write a result of its own and end the process with a zero. Before the parent
started checking, that returned `status: ok` with a project id and a file list
the model had chosen, for a staging directory that had never been created.

No secret fixes this. Anything the child knows -- a nonce in the environment, a
token in a variable, an inherited descriptor -- is in memory the model can read,
which is the whole reason this had to be closed on the PARENT's side instead.
So the shape of every test here is the same: run a model that forges, and assert
the hub reports what it could VERIFY rather than what it was told.

They need no CAD stack. Every one of these models ends the process from its own
import, long before `build()` or `import cadquery` is reached -- which is also
what makes them fast and what makes the forgery total: not one line of the real
build half runs.
"""

import os
import stat

import pytest

from src.buildproc import (
    STATUS_BAD_RESULT,
    STATUS_CRASHED,
    STATUS_OK,
    run_build,
)
from src.buildproc.runner import _verify_output_file

from probes import BUILD_LIMITS


# A model that writes whatever it is told into the result file the parent named,
# then leaves through `os._exit` so that nothing else in the child runs. The
# `--result` path is found the way an attacker finds it: by reading argv.
FORGER = """
    import json, os, sys

    argv = sys.argv
    result = argv[argv.index("--result") + 1]
    open(result, "w").write({payload!r})
    os._exit(0)
"""


def forge(project, payload):
    """Run a model that writes `payload` into the result file and exits 0."""
    return project.build(FORGER.format(payload=payload), limits=BUILD_LIMITS)


# --------------------------------------------------------------------------
# the attack itself
# --------------------------------------------------------------------------

def test_a_model_that_writes_the_result_file_itself_does_not_get_a_build(project):
    """THE test this file exists for: the forgery, run, and refused.

    The payload is what a plausible attacker writes -- a well-formed result
    naming files with ordinary names. Nothing about it is malformed; the only
    thing wrong with it is that it is not true, and the parent finds that out by
    looking at the output directory rather than by inspecting the claim.

    The staging directory is asserted absent as well, because that is what makes
    the difference legible: a hub that believed this would have reported a
    finished build for a directory that does not exist, and step 6 would then
    have published it over the project's `latest`.
    """
    outcome = forge(project, '{"files": ["meta.json", "body.stl"]}')

    assert outcome.exit_code == 0, outcome.log
    assert outcome.status == STATUS_BAD_RESULT, outcome.log
    assert not outcome.ok
    assert outcome.files == ()
    assert "cannot confirm" in outcome.log
    assert "meta.json" in outcome.log, "the refusal does not say what it refused"
    assert not project.out.exists(), (
        "the build never created its output directory, which is exactly what "
        "the forged result was claiming to have filled")


def test_a_forged_result_cannot_choose_which_project_was_built(project):
    """The project id is the hub's, and there is nowhere for a model to put one.

    A pid taken from anything the child wrote is a pid the model chose, and a
    model that chose somebody ELSE's would publish itself over their project --
    the one bug in this area that is not merely a wrong answer. So it does not
    travel through the result file at all: `run_build` is given the id of the
    push the hub accepted and reports that, on every path, including the ones
    where there is no result.
    """
    outcome = forge(project, '{"pid": "somebody-elses-project", "files": []}')

    # The extra key alone makes the file unreadable -- the shape is exact --
    # so this never even reaches the file check.
    assert outcome.status == STATUS_CRASHED, outcome.log
    assert outcome.pid == project.PID
    assert "no readable result" in outcome.log


def test_the_hubs_pid_is_reported_and_the_trees_own_id_is_not_consulted(project):
    """`run_build(pid=...)` is what comes back, whatever the tree says.

    The two agree in every other test in this suite, which is exactly why this
    one passes a different id explicitly: with them equal, an implementation
    reading the id back out of the build would be indistinguishable from this
    one.
    """
    outcome = forge(project, '{"files": []}')

    assert outcome.pid == project.PID

    outcome = run_build(project.root, project.out, pid="a-different-push",
                        limits=BUILD_LIMITS)
    assert outcome.pid == "a-different-push"


# --------------------------------------------------------------------------
# what a claimed file has to survive
# --------------------------------------------------------------------------

def test_a_claimed_file_that_does_not_exist_is_refused(project):
    """The cheapest half of the check, and the one the forgery above trips on.

    Worth its own test even so: a name for a file nobody wrote is what a build
    half with an ordinary BUG produces too -- a rename that missed one caller --
    and the hub would otherwise report a complete build and then serve 404s for
    part of it.
    """
    project.out.mkdir(parents=True)
    (project.out / "meta.json").write_text("{}", encoding="utf-8")

    outcome = forge(project, '{"files": ["meta.json", "never-written.stl"]}')

    assert outcome.status == STATUS_BAD_RESULT, outcome.log
    assert "never-written.stl" in outcome.log
    assert "is not there" in outcome.log


def test_a_claimed_file_outside_the_output_directory_is_refused(project, tmp_path):
    """`..` in a name is a build reaching into another project, or off the volume.

    The data volume holds every project's builds under one root, and the hub
    runs as the same user that runs the build (see the package docstring). A
    name the parent repeated without checking would be a path the publish step
    then copies from -- so this is where it stops.
    """
    project.out.mkdir(parents=True)
    (tmp_path / "elsewhere.json").write_text("{}", encoding="utf-8")

    outcome = forge(project, '{"files": ["../elsewhere.json"]}')

    assert outcome.status == STATUS_BAD_RESULT, outcome.log
    assert "does not stay inside" in outcome.log


def test_a_claimed_file_that_is_a_symlink_is_refused(project, tmp_path):
    """A link is refused even when it points at a file that is really there.

    The interesting half is the SECOND link below, which points back INSIDE the
    output directory: `resolve()` follows it and lands on a path any containment
    test agrees with, so a check written that way would wave it through -- and
    the hub would still be serving a link rather than a file. Checking each
    component with `lstat` on the way down is what makes both cases the same
    answer.

    The first link is the ordinary one: it points at a file of the hub's, and it
    is how a build would otherwise hand out `/etc/passwd` under the name of an
    STL.
    """
    project.out.mkdir(parents=True)
    secret = tmp_path / "the-hubs-own-file"
    secret.write_text("not yours", encoding="utf-8")
    (project.out / "meta.json").write_text("{}", encoding="utf-8")
    os.symlink(secret, project.out / "outward.stl")
    os.symlink(project.out / "meta.json", project.out / "inward.stl")

    outcome = forge(project, '{"files": ["outward.stl"]}')
    assert outcome.status == STATUS_BAD_RESULT, outcome.log
    assert "symlink" in outcome.log

    outcome = forge(project, '{"files": ["inward.stl"]}')
    assert outcome.status == STATUS_BAD_RESULT, outcome.log
    assert "symlink" in outcome.log


def test_a_result_that_is_not_the_shape_we_asked_for_is_not_a_result(project):
    """Exactly `{"files": [...]}`, and everything else is a build that crashed.

    Strictness costs nothing here -- the only honest writer of this file is
    child.py -- and it is what keeps a forged result from carrying a field past
    a reader that only looked at the ones it knew.
    """
    for payload in ('[]',
                    '{"files": "meta.json"}',
                    '{"files": [], "meta": {}}',
                    'not json at all',
                    ''):
        outcome = forge(project, payload)
        assert outcome.status == STATUS_CRASHED, (payload, outcome.log)
        assert outcome.files == ()
        assert "no readable result" in outcome.log


def test_an_empty_file_list_is_not_a_build(project):
    """A build that shipped nothing did not build anything.

    Reported as an unconfirmable claim rather than as a success with no files,
    because the caller in step 6 has one question -- may this replace `latest`?
    -- and "yes, with nothing in it" is the wrong answer to it.
    """
    outcome = forge(project, '{"files": []}')

    assert outcome.status == STATUS_BAD_RESULT, outcome.log
    assert "no files at all" in outcome.log


def test_more_files_than_one_build_may_write_is_refused(project):
    """The claim is bounded before the filesystem is touched once per name.

    A list of a million names costs a million `lstat`s to reject one at a time,
    inside the request thread that is waiting for this build. The ceiling that
    already exists for what a build may WRITE is the same number, so it is the
    one used here.
    """
    limits = BUILD_LIMITS.replace(output_files=4)
    names = ", ".join(f'"f{n}.stl"' for n in range(9))
    outcome = project.build(
        FORGER.format(payload='{"files": [%s]}' % names), limits=limits)

    assert outcome.status == STATUS_BAD_RESULT, outcome.log
    assert "over the 4" in outcome.log


# --------------------------------------------------------------------------
# the checker itself, without a process around it
# --------------------------------------------------------------------------

def test_the_file_check_refuses_everything_it_cannot_confirm(tmp_path):
    """The verifier on its own, over the cases a whole build is a slow way to reach.

    A unit test here and process-level tests above, deliberately: the ones above
    prove the check is WIRED to the thing a model can reach, and this one covers
    the shapes cheaply enough to enumerate.
    """
    out = tmp_path / "out"
    out.mkdir()
    (out / "real.stl").write_bytes(b"solid\n")
    (out / "sub").mkdir()
    (out / "sub" / "nested.stl").write_bytes(b"solid\n")
    os.mkfifo(out / "fifo")

    assert _verify_output_file("real.stl", out) is None
    assert _verify_output_file("sub/nested.stl", out) is None

    for name, expected in (
        ("", "not a usable file name"),
        (None, "not a usable file name"),
        (17, "not a usable file name"),
        ("with\x00nul", "not a usable file name"),
        (str(tmp_path / "real.stl"), "absolute path"),
        ("../real.stl", "does not stay inside"),
        ("sub/../real.stl", "does not stay inside"),
        # Not a traversal -- `Path` folds these away, so they name the file that
        # is really there. Refused anyway: one file, one name, or the index the
        # hub publishes and the directory it lists stop agreeing.
        ("./real.stl", "normal form"),
        ("sub//nested.stl", "normal form"),
        ("real.stl/", "normal form"),
        ("missing.stl", "is not there"),
        ("sub", "not a regular file"),
        ("fifo", "not a regular file"),
    ):
        complaint = _verify_output_file(name, out)
        assert complaint is not None and expected in complaint, (name, complaint)


def test_the_check_does_not_follow_a_symlinked_directory(tmp_path):
    """The link one component UP, which is the version that is easy to miss.

    A check that only looked at the last component would accept
    `sub/nested.stl` while `sub` is a link into somebody else's build -- the
    file exists, it is regular, and every one of those answers is about a file
    that is not in this build's output directory at all.
    """
    out = tmp_path / "out"
    out.mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "nested.stl").write_bytes(b"solid\n")
    os.symlink(elsewhere, out / "sub")

    complaint = _verify_output_file("sub/nested.stl", out)
    assert complaint is not None and "symlink" in complaint, complaint


def test_the_check_accepts_a_real_build_directory(tmp_path):
    """The negative control: nothing in the check refuses an honest build.

    Without it, a verifier that refused EVERYTHING would pass every other test
    in this file.
    """
    out = tmp_path / "out"
    out.mkdir()
    for name in ("meta.json", "metrics.json", "body.stl"):
        (out / name).write_bytes(b"x")
        assert _verify_output_file(name, out) is None
        info = os.lstat(out / name)
        assert stat.S_ISREG(info.st_mode)


@pytest.mark.parametrize("payload", ['{"files": ["meta.json"]}'])
def test_a_claim_that_is_true_is_accepted(project, payload):
    """The other negative control, at process level.

    The same forging model, writing a claim that happens to be TRUE about a file
    it really put there. It has to come back OK -- otherwise every assertion in
    this file would also hold for a parent that refuses all results, and the
    check would be indistinguishable from a component that never works.
    """
    outcome = project.build("""
        import json, os, sys

        argv = sys.argv
        out = argv[argv.index("--out") + 1]
        os.makedirs(out, exist_ok=True)
        open(os.path.join(out, "meta.json"), "w").write("{}")
        open(argv[argv.index("--result") + 1], "w").write(%r)
        os._exit(0)
    """ % payload, limits=BUILD_LIMITS)

    assert outcome.status == STATUS_OK, outcome.log
    assert outcome.files == ("meta.json",)
    assert outcome.pid == project.PID
