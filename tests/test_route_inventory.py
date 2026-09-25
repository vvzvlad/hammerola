"""The routing table in the `src/app.py` docstring, against the dispatcher.

`docs/SPEC.md` §3 carries no list of routes any more: it points at that
docstring, because the copy that used to stand in the spec drifted by thirteen
routes before anybody noticed — a whole family of endpoints missing, and a
redirect promised where the hub serves a page. Moving the list next to the
dispatcher takes away the second file to forget; nothing yet made the one that is
left agree with the code beside it.

This file is that agreement, and it is checked in BOTH directions: a route the
table promises and no dispatcher answers, and a route a dispatcher answers that
the table never mentions. Both failures are silent — a reader following the table
gets a 404 nobody can account for, or goes looking for an endpoint that is not
written down and adds a second one beside it.

Read as TEXT, like `tests/test_workflow_steps.py` and `tests/test_ui_source.py`,
because a docstring's table is prose to everything that imports the module. Both
halves are DERIVED: the prefixes come out of the three route tables themselves,
and the segments those tables name through a constant are imported rather than
copied, so a rename moves both sides at once.

WHAT IS COMPARED IS THE DISPATCH PREFIX and not the whole path, because the
prefix is all the three tables know: `/api/v1/comments/<id>/photo` and
`/api/v1/comments/<id>/shot` are ONE entry in the GET table, and which of them
exists is decided inside `_serve_comments`. So the docstring is free to say more
than the tables do — a row per document, which is what a reader needs — while
every row of it has to fall under an entry that is really there.
"""

import re
from pathlib import Path

import pytest

from src import onboarding
from src.store import SITE_INDEX_FILE

APP = Path(__file__).resolve().parents[1] / "src" / "app.py"
SOURCE = APP.read_text(encoding="utf-8")
# The table lives in the module docstring, which is the first triple-quoted
# block in the file.
DOCSTRING = SOURCE.split('"""')[1]

# One row of the table: the verb, then the URL. What follows is the description,
# which is prose and is not read here.
ROW = re.compile(r"^    (GET|POST|DELETE) +(/\S*)", re.M)

# The dispatcher of each verb. Every route table is inside one of these three
# methods, and so is the one route deliberately left BELOW its table: publish,
# whose answer is the body of `_handle_post` rather than a handler.
HANDLERS = {"GET": "_handle_get", "POST": "_handle_post",
            "DELETE": "_handle_delete"}

# The segments one predicate matches on. `!=` counts with `==`, because publish
# is spelled as a refusal of everything that is not it — the same statement about
# which prefix that method answers.
PREDICATE = re.compile(r"segments(\[:(\d+)\])?\s*[=!]=\s*\[([^\]]*)\]")

# Segments a table names through a constant instead of spelling. Imported, so
# that this file cannot end up agreeing only with itself.
NAMED_SEGMENTS = {
    "onboarding.START_SEGMENT": onboarding.START_SEGMENT,
    "SITE_INDEX_FILE": SITE_INDEX_FILE,
}


def handler_body(name: str) -> str:
    """One handler, from its `def` to the next method at the same indent."""
    start = SOURCE.index(f"        def {name}(self")
    end = SOURCE.index("\n        def ", start + 1)
    return SOURCE[start:end]


def prefixes_in(body: str) -> set[tuple[bool, tuple[str, ...]]]:
    """Every prefix that handler dispatches on, as (whole path, segments).

    `whole path` says the predicate compared ALL of `segments` rather than a
    slice of it, which is the difference between a route that is one URL and a
    route that hands everything under it to a sub-dispatcher.
    """
    found = set()
    if re.search(r"lambda: not segments\b", body):
        # The front page — the one route whose match is the EMPTY path, so it
        # cannot be written as a comparison against a list.
        found.add((True, ()))
    for sliced, width, items in PREDICATE.findall(body):
        segments = []
        for item in (piece.strip() for piece in items.split(",")):
            if not item:
                continue
            if item.startswith('"'):
                segments.append(item.strip('"'))
                continue
            assert item in NAMED_SEGMENTS, (
                f"a route table matches on {item}, which this file cannot "
                f"resolve to a URL segment. Import it into NAMED_SEGMENTS "
                f"rather than leaving the route unchecked")
            segments.append(NAMED_SEGMENTS[item])
        assert not sliced or int(width) == len(segments), (
            f"segments[:{width}] is compared against {len(segments)} segments, "
            f"so this predicate does not mean what it looks like")
        found.add((not sliced, tuple(segments)))
    return found


def documented_path(url: str) -> tuple[str, ...]:
    """A row's URL as the dispatcher would split it.

    The query is dropped: `?v=<view>` says which view a comparison's file
    belongs to, and no route is chosen by it (`_handle_get` splits the path off
    before it looks at anything).
    """
    return tuple(part for part in url.split("?", 1)[0].split("/") if part)


def answers(prefix: tuple[bool, tuple[str, ...]],
            path: tuple[str, ...]) -> bool:
    whole, segments = prefix
    if whole:
        return path == segments
    return path[:len(segments)] == segments


@pytest.fixture(scope="module")
def documented() -> dict[str, set[tuple[str, ...]]]:
    rows: dict[str, set[tuple[str, ...]]] = {verb: set() for verb in HANDLERS}
    for verb, url in ROW.findall(DOCSTRING):
        rows[verb].add(documented_path(url))
    return rows


@pytest.fixture(scope="module")
def dispatched() -> dict[str, set[tuple[bool, tuple[str, ...]]]]:
    return {verb: prefixes_in(handler_body(name))
            for verb, name in HANDLERS.items()}


@pytest.mark.parametrize("verb", sorted(HANDLERS))
def test_both_halves_were_really_found(verb, documented, dispatched):
    """The guard against a vacuous pass, which this shape invites.

    Everything below compares two sets, and two EMPTY sets agree perfectly. An
    edit that renamed a handler, moved a table out of one or changed how a
    predicate is spelled would otherwise leave this file green while checking
    nothing at all.
    """
    assert documented[verb], (
        f"the docstring table lists no {verb} route — either the table moved "
        f"out of the module docstring or its rows are no longer spelled the way "
        f"ROW reads them")
    assert dispatched[verb], (
        f"no route prefix could be read out of {HANDLERS[verb]}; PREDICATE no "
        f"longer matches how that dispatcher decides")
    assert "routes = (" in handler_body(HANDLERS[verb]), (
        f"{HANDLERS[verb]} no longer dispatches from a table of "
        f"(predicate, handler) pairs. One if-chain among three tables is how a "
        f"route stops being visible to this file (issue #105)")


@pytest.mark.parametrize("verb", sorted(HANDLERS))
def test_every_documented_route_is_one_the_hub_answers(verb, documented,
                                                       dispatched):
    for path in sorted(documented[verb]):
        assert any(answers(prefix, path) for prefix in dispatched[verb]), (
            f"the docstring promises {verb} /{'/'.join(path)} and no entry in "
            f"{HANDLERS[verb]} matches it: whoever follows the table gets a 404")


@pytest.mark.parametrize("verb", sorted(HANDLERS))
def test_every_route_the_hub_answers_is_documented(verb, documented,
                                                   dispatched):
    for prefix in sorted(dispatched[verb]):
        assert any(answers(prefix, path) for path in documented[verb]), (
            f"{HANDLERS[verb]} answers {verb} /{'/'.join(prefix[1])} and the "
            f"docstring table has no row under it — the table is what "
            f"docs/SPEC.md §3 points at, so a route missing from it is a route "
            f"nothing documents")
