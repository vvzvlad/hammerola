"""The git commit `hammerola commit` OFFERS after it has published.

Two claims are under test and they pull in opposite directions. The first is
that this never acts: no test here may find a commit that it did not make
itself. The second is that what it prints has to be RUNNABLE — a line a person
pastes into a shell — which is where the message goes from being data to being
part of a command line, and where a quote or a `$(...)` in it stops being
harmless. `shlex.split` is what settles the second claim: it is the shell's own
argument splitting, so parsing the printed line back and finding the message
intact as ONE argument is the proof, rather than eyeballing the quotes.
"""

import shlex

import pytest
from modeldir import git, git_repo, make_model

from hammerola import gitsuggest

REVISION = "f" * 64


@pytest.fixture
def project(tmp_path):
    return make_model(tmp_path / "demo")


def parse(line):
    """The suggested command as the shell would see it -> the argv list."""
    return shlex.split(line)


# -- when there is nothing to offer ------------------------------------------
def test_a_directory_with_no_git_gets_no_suggestion(project):
    """Not an error, and not a fallback either: the publish already happened
    and never depended on git."""
    assert gitsuggest.suggestion(project, REVISION, "anything") is None


def test_a_clean_repository_gets_no_suggestion(project):
    """`git commit` on a clean tree fails. Offering it would be offering a
    command that cannot work."""
    git_repo(project)
    assert gitsuggest.suggestion(project, REVISION, "anything") is None


# -- what is offered ---------------------------------------------------------
def test_an_uncommitted_change_is_offered_a_commit(project):
    git_repo(project)
    (project / "model.py").write_text("# edited after the publish\n")

    offer = gitsuggest.suggestion(project, REVISION, "the bracket got thicker")
    assert offer is not None
    assert gitsuggest.HEADLINE in offer
    argv = parse(offer.splitlines()[-1])
    assert argv[:4] == ["git", "add", "-A", "&&"]
    assert "the bracket got thicker" in argv
    assert f"{gitsuggest.TRAILER}: {REVISION}" in argv


def test_an_untracked_file_counts(project):
    """It is packed and published like any other source, so a commit that left
    it out would not record what was published."""
    git_repo(project)
    (project / "extra.py").write_text("x = 1\n")
    assert gitsuggest.suggestion(project, REVISION) is not None


def test_a_file_git_ignores_does_not_count(project):
    """It is not published either, so there is nothing for a commit to record."""
    (project / ".gitignore").write_text("_out/\n")
    git_repo(project)
    (project / "_out").mkdir()
    (project / "_out" / "model.stl").write_text("solid\n")
    assert gitsuggest.suggestion(project, REVISION) is None


def test_the_message_and_the_trailer_are_two_separate_arguments(project):
    """Two `-m` flags, so the blank line a trailer paragraph needs is git's own
    doing rather than something the printed command has to spell out."""
    git_repo(project)
    (project / "model.py").write_text("# edited\n")

    argv = parse(gitsuggest.command(project, REVISION, "subject line"))
    flags = [argv[i + 1] for i, token in enumerate(argv) if token == "-m"]
    assert flags == ["subject line", f"{gitsuggest.TRAILER}: {REVISION}"]


def test_without_a_message_only_the_trailer_is_passed(project):
    git_repo(project)
    (project / "model.py").write_text("# edited\n")

    argv = parse(gitsuggest.command(project, REVISION))
    flags = [argv[i + 1] for i, token in enumerate(argv) if token == "-m"]
    assert flags == [f"{gitsuggest.TRAILER}: {REVISION}"]


# -- the message is user input that lands in a command line ------------------
HOSTILE = "it's $(touch /tmp/pwned) `id` \"quoted\" \\ and more"


def test_a_hostile_message_survives_as_one_literal_argument(project):
    """The message comes from the person running the tool and ends up in a
    command they will paste. Every character of it has to arrive as TEXT."""
    git_repo(project)
    (project / "model.py").write_text("# edited\n")

    argv = parse(gitsuggest.command(project, REVISION, HOSTILE))
    assert HOSTILE in argv
    # And nothing the shell would act on leaked out of the quoting: the only
    # token the shell treats as syntax is the `&&` this line puts there itself.
    assert [token for token in argv if token in ("&&", ";", "|")] == ["&&"]


def test_a_message_with_a_newline_survives(project):
    git_repo(project)
    (project / "model.py").write_text("# edited\n")

    message = "first line\nsecond line"
    argv = parse(gitsuggest.command(project, REVISION, message))
    assert message in argv


def test_suggesting_never_commits_anything(project):
    """The whole design in one assertion: after the offer, the tree is exactly
    as dirty as it was and the history is exactly as long."""
    git_repo(project)
    (project / "model.py").write_text("# edited\n")
    before = git(project, "rev-parse", "HEAD").stdout.strip()

    gitsuggest.suggestion(project, REVISION, "a message")

    assert git(project, "rev-parse", "HEAD").stdout.strip() == before
    assert git(project, "status", "--porcelain").stdout.strip()
