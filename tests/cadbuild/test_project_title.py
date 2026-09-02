"""The title check that goes on the build log — what it says and when it shuts up.

IT HAD NO CALLER AND NO TEST until the slug incident, and the two facts belong
together: `title_problem` was written for a tool that ran on the author's machine
and compared the title against the project DIRECTORY. That tool is gone, the
directory inside the hub is a `.src-<uuid>` of the hub's own making, and the
function sat unreachable while a project published under that name.

So what is pinned here is mostly the SILENCE. A warning on a build log is read
once, by somebody who is looking at something else; one that fires on correct
work is a warning that stops being read, and it takes the two real complaints
with it. Every title already on this hub carries its slug in brackets, and none
of them may produce a line.
"""

import json

from src.cadbuild.hubspec import MEMBER_RE
from src.cadbuild.project import load_project
from src.cadbuild.project_title import SLUG_RE, title_problem

# A project id that is NOT the name the build publishes under. Every case that
# is about the title passes it, so the clause about the id firing first is out
# of the way; the cases that are about the id pass it as both arguments.
PID = "2486c8fd2b05"


def warning_for(root, **project_json) -> str:
    """Write a project.json, resolve it the way a build does, and ask.

    THROUGH THE REAL `load_project` rather than a transcription of its chain,
    because the chain is exactly what the remedy tests below are about: which
    of the three sources wins is the thing a message is allowed to teach, and a
    copy of it here could agree with the message while the build did something
    else. `build()` calls these two in the same order on the same values.
    """
    (root / "project.json").write_text(json.dumps(project_json),
                                       encoding="utf-8")
    pid, project, title = load_project()
    return title_problem(title, project, pid)


# -- quiet -------------------------------------------------------------------
def test_a_title_in_the_form_says_nothing():
    assert title_problem("Насос для шликера (slip-pump)", "slip-pump", PID) is None


def test_the_descriptive_half_is_not_required_to_be_russian():
    """THE CLAUSE THAT WAS REMOVED, pinned so it is not reinstated.

    The rule used to demand Cyrillic in front of the brackets, from a fleet
    whose titles happened to all be Russian. One of the projects on this hub is
    titled "Foam cover reverse-engineered from a 3D scan", and this repository's
    own convention is that what a user reads is English unless somebody asked
    otherwise — so that clause fired on correct work, which is the one thing a
    warning may not do.
    """
    assert title_problem("Foam cover for a 3D scan (foam-cover)",
                         "foam-cover", PID) is None


def test_a_slug_the_project_key_carried_across_is_matched_the_same_way():
    """The ordinary case after `hammerola create`: the key and the brackets say
    the same thing, because the author's directory is where both came from."""
    assert title_problem("Ceiling mount for T13 (t13-ceiling-mount)",
                         "t13-ceiling-mount", PID) is None


# -- the incident ------------------------------------------------------------
def test_a_project_publishing_under_its_id_is_told_that_and_not_told_to_type_it():
    """The failure that produced this warning, from the title that produced it,
    and the ONE repair the message must not teach.

    Naming the consequence is half the message: "your title has no slug" leaves
    somebody looking for what it costs, and what it costs is a card on the front
    page reading twelve hex characters. But the general sentence asks for the
    name the build publishes under to be put in the brackets — and here that
    name IS the id, so following it writes `(2486c8fd2b05)` into the title. The
    next test is what pins the cost of that.
    """
    problem = title_problem("Foam cover reverse-engineered from a 3D scan",
                            PID, PID)
    assert problem is not None
    assert PID in problem
    assert "project" in problem
    # Not the general sentence, which would be advice to type the id.
    assert "does not end with the project's slug" not in problem


def test_putting_the_id_in_the_brackets_does_not_silence_it():
    """WHAT THE WARNING WOULD HAVE CEMENTED, had it kept naming the brackets.

    Twelve hex characters match SLUG_RE, so a title ending `(2486c8fd2b05)`
    satisfies every clause about the FORM: the brackets hold a slug, and the
    slug equals the name the build publishes under. The line would go quiet
    permanently, publication under the id would be settled, and the id would now
    be in the human-readable half of the card as well.
    """
    problem = title_problem(f"Foam cover for a 3D scan ({PID})", PID, PID)
    assert problem is not None
    assert PID in problem


def test_each_remedy_the_id_message_names_ends_with_the_warning_gone(
        isolated_project):
    """THE FINDING THAT BLOCKED THIS CHANGE, pinned by walking it to the end.

    The message used to say "put the latin name ... in the `project` key --
    not in the title's brackets, where it would only silence this line". Both
    halves were wrong, and a substring assertion could not see either: the
    brackets are the SECOND source `load_project` reads, so a name there clears
    the warning outright, while the key alone clears this clause and lands on
    the general no-brackets sentence, which asks for those brackets.

    So this asserts the only thing that matters about advice — that following
    it ends in silence — for both remedies, FROM THE START STATE `hammerola
    create` can actually leave behind: a file with no `project` key. That is the
    state the first remedy is written for, and the qualification in the message
    ("when project.json has no \"project\" key") is what limits it to that one.
    The other start state that reaches this clause is a hand-written key holding
    the id, where `rename` cannot move anything; it is walked in the test below.
    """
    title = "Foam cover reverse-engineered from a 3D scan"
    root = isolated_project

    # Where it starts: no key, no brackets, published under the id. The message
    # has to point at a remedy that ends in silence, and the two below are the
    # ones that do -- so it names the command that writes the first of them.
    start = warning_for(root, id=PID, title=title)
    assert PID in start
    assert "hammerola rename" in start

    # The brackets, which is what `hammerola rename` writes.
    assert warning_for(root, id=PID, title=f"{title} (foam-cover)") is None

    # The key. On its own it moves the published name and leaves the general
    # sentence behind it -- which is why the message says the brackets have to
    # carry the same slug, and why THAT is what is walked to the end here.
    key_only = warning_for(root, id=PID, title=title, project="foam-cover")
    assert key_only is not None and "brackets" in key_only
    assert warning_for(root, id=PID, title=f"{title} (foam-cover)",
                       project="foam-cover") is None


def test_a_key_holding_the_id_is_the_one_state_the_first_remedy_cannot_move(
        isolated_project):
    """THE OTHER WAY INTO THE SAME CLAUSE, where `rename` is inert.

    `project == pid` is reachable twice over: with no `project` key, which is
    what the test above walks, and with the key PRESENT and holding the id --
    hand-written, since `create` only ever puts a slug there. The key is read
    first, so in the second state the brackets `hammerola rename` writes change
    nothing at all and the message comes back the same. Editing the key is the
    only exit, which is what the message's last sentence is for.
    """
    title = "Foam cover reverse-engineered from a 3D scan"
    root = isolated_project

    start = warning_for(root, id=PID, project=PID, title=title)
    assert PID in start

    # What `hammerola rename` writes, from this state: byte-identical, because
    # the key wins over the brackets it just filled in.
    assert warning_for(root, id=PID, project=PID,
                       title=f"{title} (foam-cover)") == start

    # The key edited, and then the brackets the general sentence asks for.
    key_only = warning_for(root, id=PID, project="foam-cover", title=title)
    assert key_only is not None and "brackets" in key_only
    assert warning_for(root, id=PID, project="foam-cover",
                       title=f"{title} (foam-cover)") is None


def test_the_id_in_either_place_leaves_publication_under_the_id(
        isolated_project):
    """The other half of the same message, and the reason it is not simply
    "put a name in the brackets": the id IS a slug as far as SLUG_RE goes, so
    both places accept it and neither changes what the project publishes as."""
    for placement in ({"title": f"Foam cover ({PID})"},
                      {"title": "Foam cover", "project": PID}):
        problem = warning_for(isolated_project, id=PID, **placement)
        assert problem is not None and PID in problem, placement


def test_a_title_with_no_slug_is_told_which_name_the_build_publishes_under():
    """The general no-brackets sentence, on a project that HAS a name.

    This is the one the id case is held out of: with a real slug to name, the
    fallback is worth printing, because "your title has no slug" leaves somebody
    looking for the consequence.
    """
    problem = title_problem("Foam cover reverse-engineered from a 3D scan",
                            "foam-cover", PID)
    assert problem is not None
    assert "foam-cover" in problem
    assert "brackets" in problem


def test_a_slug_from_another_project_is_named_together_with_this_ones():
    """The reason the rule exists at all: a project is made by copying another
    one, and the title is the field the copy forgets."""
    problem = title_problem("Насос для шликера (slip-pump)", "t13-case", PID)
    assert problem is not None
    assert "slip-pump" in problem and "t13-case" in problem


def test_brackets_holding_a_comment_rather_than_a_slug_are_refused():
    problem = title_problem("Крышка (вторая версия)", "cover", PID)
    assert problem is not None
    assert "not a slug" in problem


def test_a_title_that_is_only_its_own_slug_says_nothing_the_slug_did_not():
    problem = title_problem("(slip-pump)", "slip-pump", PID)
    assert problem is not None
    assert "what the thing is" in problem


def test_a_project_with_no_title_at_all_is_said_plainly():
    assert title_problem("", "slip-pump", PID) == "the project has no title"


def test_a_hand_written_project_key_that_is_not_a_slug_is_blamed_first():
    """The published name before the title, because when it is wrong no title
    can satisfy the rule and every other message would blame the wrong half.
    """
    problem = title_problem("Корпус (Корпус)", "Корпус", PID)
    assert problem is not None
    assert "project" in problem and "not a latin slug" in problem


def test_an_id_that_is_a_legal_path_component_but_not_a_slug_lands_here_too():
    """TWO OF THE THREE SOURCES CAN REACH THAT CLAUSE, not one.

    An earlier version of this file said the branch above was reachable only
    through a hand-written `project` key, "because the two values the build
    falls back to are slugs by construction". Only ONE of them is:
    `slug_from_title` returns what SLUG_RE matched or nothing, while `pid` is
    held to MEMBER_RE, which is weaker on the ALPHABET — `trailing-`, `foo--bar`,
    `a_-b` and `wb.mge..v2` are all legal ids and none of them is a slug. So a
    project.json with such an id and no `project` key reaches the clause with no
    key to blame, which is why the message names both places the name can come
    from.

    "Weaker on the alphabet" and not "weaker", which is a correction rather than
    a nicety: the test below is what stops the shorter word coming back.
    """
    problem = title_problem("Ceiling mount (trailing-)", "trailing-", "trailing-")
    assert problem is not None
    assert "not a latin slug" in problem
    assert "project id" in problem


def test_neither_id_alphabet_implies_the_other():
    """WHAT "STRICTLY WEAKER" GOT WRONG, three times in one change.

    The comment beside the clause above claimed MEMBER_RE was strictly weaker
    than SLUG_RE, which reads as "every slug is a legal id". It is not: SLUG_RE
    carries no length at all, MEMBER_RE caps at 128 characters, so a 200
    character slug is refused as a path component. The alphabet half is the
    true half and it is the half the clause uses; this pins both directions so
    the claim cannot be shortened back.
    """
    only_a_slug = "a" * 200
    assert SLUG_RE.match(only_a_slug) and not MEMBER_RE.match(only_a_slug)
    for only_an_id in ("trailing-", "foo--bar", "a_-b", "wb.mge..v2"):
        assert MEMBER_RE.match(only_an_id) and not SLUG_RE.match(only_an_id), \
            only_an_id


def test_the_bare_slug_is_told_what_is_actually_wrong_with_it():
    """`hammerola create` with no `--title` writes the directory name into BOTH
    fields, and the general message is incoherent for that: it would say nothing
    ties `'t13-ceiling-mount'` to `'t13-ceiling-mount'`.

    The warning stays — a folder name says nothing about what the thing is or
    what it is for, which is the entire job of the half in front of the
    brackets — but it has to name that, and to show the fix.
    """
    problem = title_problem("t13-ceiling-mount", "t13-ceiling-mount", PID)
    assert problem is not None
    assert "bare slug" in problem
    assert "hammerola rename" in problem
    # The general no-brackets sentence, which would be nonsense here.
    assert "nothing in it ties" not in problem
