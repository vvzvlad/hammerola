"""`hammerola proposal` and `hammerola proposal rm`, against a real hub.

The proposal these tests read is STORED THE WAY THE BROWSER STORES ONE — a POST
to `/api/v1/proposals/<pid>` with the document, its projection and the build
stamp — so what the command prints is a record the hub validated, wrote to its
volume and read back, and not a fixture handed to the client.

WHAT THEY ARE REALLY ABOUT is the asymmetry between the two verbs:

  * reading is an ordinary question with three ordinary answers — there is one,
    there is none, and there is one that says nothing — and NONE of them is a
    failure. A project with no proposal is the commonest of the three, so it
    exits zero;
  * removing cannot be undone by anything: a person drew the thing by hand, the
    hub keeps no copy and no build contains it. So it asks, it asks for the
    project id rather than a y/n, and EOF — an agent with no terminal to answer
    on — is a REFUSAL. That last one is the point of the command and is pinned
    twice: nothing is removed, and the exit code says so.

Nothing here publishes: the proposal routes deliberately do not ask the volume
whether the project exists (`tests/test_proposals.py`), so a model directory and
a hub are the whole of what a test needs.
"""

import pytest
from modeldir import make_model

from hammerola.cli import main

# The address and the token, from tests/client/conftest.py (issue #99).
pytestmark = pytest.mark.usefixtures("configured")

# The projection the panel renders, as `ui/src/proposal.js` builds it: a few
# aligned lines, and the columns are part of what makes them readable — which is
# why the test below asserts the LINES rather than a substring.
TEXT = ("units: mm\n"
        "solid  box  \"motor\"  42 × 42 × 20  at (0, 0, 12.5)\n"
        "move \"bracket ×2\" by (0, -3, 0)\n"
        "result = union(solid) - union(hole)")

DOC = {
    "version": 1,
    "units": "mm",
    "nodes": [
        {"id": "n1", "role": "body", "op": "box", "name": "motor",
         "size": [42.0, 42.0, 20.0], "at": [0.0, 0.0, 12.5],
         "rot": [0.0, 0.0, 0.0]},
    ],
}


def run(model, *args):
    return main(["-C", str(model), *args])


def store(hub, pid="demo0001", text=TEXT,
          published="2026-09-19T10:11:12.345Z"):
    """Save one proposal the way the browser panel saves it."""
    reply = hub.proposal(pid, method="POST",
                         payload={"doc": DOC, "text": text,
                                  "published": published})
    assert reply.status_code == 200, reply.text
    return reply.json()


# -- reading -----------------------------------------------------------------
def test_reading_prints_the_text_the_hub_stored(hub, model, capsys):
    saved = store(hub)["saved"]

    assert run(model, "proposal") == 0
    out = capsys.readouterr().out

    assert f"proposal on demo0001  saved {saved}" in out
    # Every line of the projection, indented and otherwise untouched: the panel
    # aligned those columns and the command may not re-wrap them.
    for line in TEXT.splitlines():
        assert f"  {line}" in out


def test_a_project_with_no_proposal_says_so_and_succeeds(hub, model, capsys):
    """An absent proposal is an ANSWER: one exists only after somebody drew it,
    so most projects have none and a non-zero exit would make the ordinary case
    look like a failure."""
    assert run(model, "proposal") == 0

    printed = capsys.readouterr()
    assert "no proposal on demo0001" in printed.out
    # Not a refusal, so nothing on stderr either: `cli.main` writes there only
    # for the failures it turns into an exit code.
    assert printed.err == ""


def test_a_stored_proposal_that_says_nothing_never_prints_the_word_none(
        hub, model, capsys):
    """`text` is null for a document with nothing drawn in it, or one whose
    every node the reader ticked off. There IS a record, which is not the same
    answer as having none — and `None` is not a sentence."""
    store(hub, text=None)

    assert run(model, "proposal") == 0
    out = capsys.readouterr().out

    assert "None" not in out
    assert "proposal on demo0001" in out
    assert "it says nothing" in out


def test_reading_says_nothing_about_a_project_the_directory_is_not(hub,
                                                                   tmp_path,
                                                                   capsys):
    """One proposal per project, addressed by the id in `project.json`."""
    store(hub, pid="other001")
    model = make_model(tmp_path / "demo")

    assert run(model, "proposal") == 0
    out = capsys.readouterr().out

    assert "no proposal on demo0001" in out
    assert "motor" not in out


# -- rm ----------------------------------------------------------------------
def test_rm_removes_the_proposal_after_the_id_is_typed(hub, model, capsys,
                                                       monkeypatch):
    store(hub)
    assert hub.proposal_path("demo0001").is_file()

    monkeypatch.setattr("builtins.input", lambda _prompt: "demo0001")
    assert run(model, "proposal", "rm") == 0
    out = capsys.readouterr().out

    assert not hub.proposal_path("demo0001").exists()
    assert "removed the proposal on demo0001" in out


def test_rm_does_nothing_until_the_id_is_typed(hub, model, capsys, monkeypatch):
    """Not a y/n: a y/n is answered by reflex, and nothing can bring a proposal
    back."""
    store(hub)

    for answer in ("y", "yes", "", "demo000"):
        monkeypatch.setattr("builtins.input", lambda _prompt, a=answer: a)
        assert run(model, "proposal", "rm") == 1
        assert "cancelled" in capsys.readouterr().err
        assert hub.proposal_path("demo0001").is_file()


def test_rm_with_nothing_to_read_refuses_rather_than_assuming_yes(hub, model,
                                                                  capsys,
                                                                  monkeypatch):
    """THE ONE THIS COMMAND EXISTS FOR. An agent reading a terminal it cannot
    type into gets EOF from `input`, and that has to be a refusal — the decision
    belongs to whoever drew the proposal."""
    store(hub)

    def eof(_prompt):
        raise EOFError

    monkeypatch.setattr("builtins.input", eof)
    assert run(model, "proposal", "rm") == 1

    assert "--yes" in capsys.readouterr().err
    assert hub.proposal_path("demo0001").is_file()
    assert hub.proposal("demo0001").status_code == 200


def test_rm_yes_skips_the_prompt(hub, model, capsys, monkeypatch):
    store(hub)

    def refuse(_prompt):
        raise AssertionError("--yes must not ask")

    monkeypatch.setattr("builtins.input", refuse)
    assert run(model, "proposal", "rm", "--yes") == 0
    capsys.readouterr()

    assert not hub.proposal_path("demo0001").exists()


def test_rm_says_what_is_about_to_go_before_asking(hub, model, capsys):
    """The prompt is only a safety if what it is confirming has been read, and
    here what is about to go is the drawing itself — so it is printed rather
    than counted."""
    store(hub)
    asked = {}

    def answer(prompt):
        asked["prompt"] = prompt
        return "no"

    import builtins
    original = builtins.input
    builtins.input = answer
    try:
        assert run(model, "proposal", "rm") == 1
    finally:
        builtins.input = original

    out = capsys.readouterr().out
    assert "about to remove the proposal on demo0001" in out
    assert "  units: mm" in out
    assert "cannot be undone" in out
    assert "project id" in asked["prompt"]


def test_rm_of_a_project_with_no_proposal_removes_nothing_and_says_so(
        hub, model, capsys, monkeypatch):
    monkeypatch.setattr("builtins.input", lambda _prompt: "demo0001")

    assert run(model, "proposal", "rm") == 0
    out = capsys.readouterr().out

    assert "nothing stored under this id" in out
    assert "nothing was removed" in out
