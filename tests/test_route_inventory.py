"""The routing table in the `src/app.py` docstring, against the dispatcher.

`docs/SPEC.md` §3 carries no list of routes: it points at that docstring, next to
the dispatcher. This file checks the two agree in BOTH directions: a route the
table promises and no dispatcher answers, and a route a dispatcher answers that the
table never mentions.

Both halves are IMPORTED: the docstring is `src.app.__doc__`, and the routes are
the three tables the dispatchers walk. Whether a row falls under an entry is
asked of `_route_rest`, the matcher the dispatchers use, so this file holds no
second reading of a pattern.

A TABLE ENTRY CLAIMS A PREFIX and, for a fixed-length route, a segment count:
`/api/v1/comments/<id>/photo` and `/api/v1/comments/<id>/shot` are ONE entry in
the GET table, and which of them exists is decided inside `_serve_comments`. So
the docstring is free to say more than the tables do (a row per document) while
every row has to fall under an entry that is really there.
"""

import re

import pytest

from harness import TOKEN
from src import app

# One row of the table: the verb, then the URL. What follows is the description,
# which is prose and is not read here.
ROW = re.compile(r"^    (GET|POST|DELETE) +(/\S*)", re.M)

TABLES = {"GET": "GET_ROUTES", "POST": "POST_ROUTES",
          "DELETE": "DELETE_ROUTES"}


def dispatched(verb: str) -> list:
    """Every pattern that verb dispatches on."""
    return [pattern for pattern, _ in getattr(app, TABLES[verb])]


def documented_path(url: str) -> list[str]:
    """A row's URL as the dispatcher would split it.

    The query is dropped: `?v=<view>` says which view a comparison's file
    belongs to, and no route is chosen by it (`_handle_get` splits the path off
    before it looks at anything).
    """
    return [part for part in url.split("?", 1)[0].split("/") if part]


def answers(pattern, path: list[str]) -> bool:
    return app._route_rest(pattern, path) is not None


def example_path(pattern) -> str:
    """A path this pattern matches, with `probe` wherever a segment is free."""
    prefix, count = pattern
    filler = ["probe"] * ((count or len(prefix)) - len(prefix))
    return "/" + "/".join([*prefix, *filler])


@pytest.fixture(scope="module")
def documented() -> dict[str, list[list[str]]]:
    rows: dict[str, list[list[str]]] = {verb: [] for verb in TABLES}
    for verb, url in ROW.findall(app.__doc__):
        rows[verb].append(documented_path(url))
    return rows


@pytest.mark.parametrize("verb", sorted(TABLES))
def test_both_halves_were_really_found(verb, documented):
    """The guard against a vacuous pass, which this shape invites.

    Everything below compares two sets, and two EMPTY sets agree perfectly. An
    edit that emptied a table or changed how a row is spelled would otherwise
    leave this file green while checking nothing at all.
    """
    assert documented[verb], (
        f"the docstring table lists no {verb} route — either the table moved "
        f"out of the module docstring or its rows are no longer spelled the way "
        f"ROW reads them")
    assert getattr(app, TABLES[verb]), f"{TABLES[verb]} has no entries"


@pytest.mark.parametrize("verb", sorted(TABLES))
def test_every_documented_route_is_one_the_hub_answers(verb, documented):
    for path in documented[verb]:
        assert any(answers(pattern, path) for pattern in dispatched(verb)), (
            f"the docstring promises {verb} /{'/'.join(path)} and no entry in "
            f"{TABLES[verb]} matches it: whoever follows the table gets a 404")


@pytest.mark.parametrize("verb", sorted(TABLES))
def test_every_route_the_hub_answers_is_documented(verb, documented):
    for pattern in dispatched(verb):
        assert any(answers(pattern, path) for path in documented[verb]), (
            f"{TABLES[verb]} answers {verb} /{'/'.join(pattern[0])} and the "
            f"docstring table has no row under it — the table is what "
            f"docs/SPEC.md §3 points at, so a route missing from it is a route "
            f"nothing documents")


@pytest.mark.parametrize("verb", sorted(TABLES))
def test_each_entry_answers_its_own_path(verb, hub, monkeypatch):
    """No branch in a dispatcher takes a path an entry of its table claims.

    Each entry's `call` is wrapped in a recorder of its own and a request is
    made on a path the entry matches; the recorder that fired has to be that
    entry's. The CALL is wrapped and not the method it reaches: `/health`, `/`
    and `favicon.ico` answer through `_json`, `_serve_page` and `_serve_asset`,
    which other answers go through too, so a branch that intercepted one of
    those paths would reach the same method and pass. A branch for a NEW path,
    one no entry claims, is not caught here: that would need reading the source.
    """
    fired = []

    def recording(index, call):
        def recorder(handler, rest, query, trailing_slash, with_body):
            fired.append(index)
            return call(handler, rest, query, trailing_slash, with_body)
        return recorder

    table = getattr(app, TABLES[verb])
    monkeypatch.setattr(app, TABLES[verb], tuple(
        (pattern, recording(index, call))
        for index, (pattern, call) in enumerate(table)))
    for index, (pattern, _) in enumerate(table):
        fired.clear()
        path = example_path(pattern)
        # The token, because DELETE checks it before its table is consulted.
        reply = hub.request(verb, path,
                            headers={"X-Hammerola-Token": TOKEN})
        assert fired == [index], (
            f"{verb} {path} (answered {reply.status_code}) should have reached "
            f"entry {index} of {TABLES[verb]} and reached {fired} instead: "
            f"something in the dispatcher answers it before the table does")

    # And every documented row, with `probe` in each free segment: a narrow
    # branch for a real sub-path under a wide prefix leaves the
    # bare prefix above to the entry and is only seen here. The row's own URL
    # is requested, trailing slash kept: without it a page answers 302.
    for row_verb, url in ROW.findall(app.__doc__):
        if row_verb != verb:
            continue
        row = documented_path(url)
        owner = next((index for index, (pattern, _) in enumerate(table)
                      if answers(pattern, row)), None)
        assert owner is not None, f"no entry of {TABLES[verb]} claims {url}"
        fired.clear()
        path = re.sub(r"<[^>]+>", "probe", url.split("?", 1)[0])
        reply = hub.request(verb, path,
                            headers={"X-Hammerola-Token": TOKEN})
        assert fired == [owner], (
            f"{verb} {path} (answered {reply.status_code}) should have reached "
            f"entry {owner} of {TABLES[verb]} and reached {fired} instead: "
            f"something in the dispatcher answers it before the table does")
