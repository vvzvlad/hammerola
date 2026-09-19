"""The client's copy of the hub's ceilings must be the hub's ceilings.

THIS IS THE TEST THAT DID NOT EXIST, and its absence is why publication is
broken today. `cad_publish/hubspec.py` carried the same numbers in a repository
that could not see the hub's; when the hub changed, nothing anywhere compared
the two. Both halves are in this repository now, so the comparison is a test —
and one that runs in the same CI job as everything else, so a change to either
side fails at the commit that makes it rather than at the next attempt to
publish a model.

`hammerola/limits.py` explains why it is a copy at all: the client has to
import under a laptop's bare python3, and `src.store` brings loguru and the
service with it. The copy is the price; this file is what makes the price
bearable.
"""

from src import store
from hammerola import limits
from src.settings import Settings


def test_the_path_alphabets_are_the_hubs():
    assert limits.SAFE_ID.pattern == store.SAFE_ID.pattern
    assert limits.SAFE_COMPONENT.pattern == store.SAFE_COMPONENT.pattern


def test_the_tree_ceilings_are_the_hubs():
    assert limits.MAX_PATH_DEPTH == store.MAX_PATH_DEPTH
    assert limits.MAX_MEMBERS == store.MAX_MEMBERS


def test_the_reserved_build_names_are_the_hubs():
    assert set(limits.RESERVED_BUILD_NAMES) == set(store.RESERVED_BUILD_NAMES)
    assert limits.DEV_SLOT == store.DEV_LINK


def test_the_artifact_ceiling_is_what_a_build_may_write_into_one_file():
    """A build's OUTPUT is not bounded by what a push may be, and this is the
    number that says so.

    `hammerola artifacts` fetches STL/STEP/3MF, which the hub produced rather
    than received: a source tree is kilobytes and its meshes are not. Holding the
    fetch to MAX_BUILD_BYTES refused files the hub was serving perfectly happily
    — so the client carries the BUILD's per-file ceiling too, and this compares
    it against the rlimit a build actually runs under.
    """
    from src.buildproc.limits import Limits

    assert limits.MAX_ARTIFACT_BYTES == Limits().file_bytes
    assert limits.MAX_ARTIFACT_BYTES > limits.MAX_BUILD_BYTES, (
        "the two ceilings have converged, which makes one of them pointless — "
        "read the comment on MAX_ARTIFACT_BYTES before removing either")


def test_the_text_ceiling_is_the_hubs():
    """The number `hammerola create` holds the `project` key to.

    Two modules apply it and neither is importable from the client: `render`
    measures every field of a meta.json against MAX_TEXT on the way in, and
    `cadbuild.project.MAX_TITLE_CHARS` mirrors it so a build fails before the
    422 rather than after it. The client's copy is the third, and it is the one
    that keeps a long DIRECTORY name from being written into project.json at all
    — so all three are compared here, in the same direction.
    """
    from src.cadbuild.project import MAX_TITLE_CHARS
    from src.render import MAX_TEXT

    assert limits.MAX_TEXT_CHARS == MAX_TEXT
    assert limits.MAX_TEXT_CHARS == MAX_TITLE_CHARS


def test_the_message_header_is_spelled_the_same_on_both_sides():
    """The name of the header a revision's message travels on (issue #67).

    Spelled twice for the reason everything in this file is: the client must
    import under a bare python3 and cannot see `src`. Two spellings of one wire
    name is exactly the shape the module docstring above calls the thing that
    broke publication — and this one would break QUIETLY, because a header
    nobody reads is not an error: the push succeeds, the build publishes, and the
    message is simply gone from every row.
    """
    from src.app import MESSAGE_HEADER as hub_header

    from hammerola.hub import MESSAGE_HEADER as client_header

    assert client_header == hub_header


def test_the_size_ceiling_matches_the_hubs_default():
    """The DEFAULT, which is all the client can know.

    MAX_BUILD_BYTES is a setting: a deployment may raise or lower it and the
    client has no way to ask. So the local check exists to catch the archive
    nobody would accept, and the hub's 413 — carrying its own number — is the
    authority. What this test pins is that the client is not guessing at a
    number the project has since moved.
    """
    assert (limits.MAX_BUILD_BYTES
            == Settings.model_fields["max_build_bytes"].default)


def test_the_states_a_poller_stops_on_are_the_hubs():
    """The two words `Hub.await_job` waits to see (issue #98).

    The hub is the side that ISSUES them and says so over its own copy: nothing
    in `src/jobs.py` selects a job by whether it has finished any more, and the
    tuple is kept there because it is the wire contract this client mirrors. The
    client's copy is a copy for the reason everything in this file is one — it
    has to import under a bare python3.

    DRIFT IS A GREEN SUITE AND A BROKEN PUSH. A word this side does not
    recognise is not an error anywhere: the build runs, publishes and is served,
    while `await_job` goes on polling a record that will never change again
    until `--timeout` runs out. Every `build` and every `commit` then reports a
    timeout on a build that is on the hub, with a URL nobody printed.
    """
    from src.jobs import TERMINAL_STATES as hub_states

    from hammerola.hub import TERMINAL_STATES as client_states

    # As SETS, because the order decides nothing on either side: both are only
    # ever asked whether a state is in them.
    assert set(client_states) == set(hub_states), (
        f"the client stops polling on {sorted(client_states)} and the hub ends "
        f"a job in {sorted(hub_states)} — a state missing from this side is a "
        f"`build` that reports a timeout on a build that actually published")


def test_the_attachment_kinds_are_the_hubs():
    """What `hammerola comments files` asks the hub FOR (issue #98).

    Both spellings travel, and each of the two is the same string in two
    places: the kind is the KEY a comment record carries the stored file name
    under (`comments.CommentStore`, which writes `photo` and `shot`), and it is
    the last segment of the URL those bytes are served at (`app._serve_comments`
    routes `<id>/<kind>` for exactly those two). `queue.PHOTO_KIND` is the first
    member of `ATTACHMENTS` by construction, so comparing the kinds this tool
    knows against the hub's two covers it as well.

    `tests/client/test_queue.py` already pins the EXTENSIONS such a file is
    stored under and says nothing about the kinds.

    DRIFT IS SILENT IN BOTH HALVES. A kind the record does not carry reads as
    "this comment has no such attachment" — `files` prints "no photo or frame"
    and exits 0, on a comment whose photo the build page is showing — and a kind
    the hub does not serve is a 404 fetching bytes the hub has.
    """
    from src.comments import PHOTO_KIND as hub_photo
    from src.comments import SHOT_KIND as hub_shot

    from hammerola.queue import ATTACHMENTS

    assert {kind for kind, _label in ATTACHMENTS} == {hub_photo, hub_shot}, (
        f"this tool fetches {sorted(kind for kind, _ in ATTACHMENTS)} and the "
        f"hub stores and serves {sorted((hub_photo, hub_shot))} — `hammerola "
        f"comments files` would report no attachment on a comment that has "
        f"one, or ask for bytes at a URL this hub does not answer")


def test_the_id_login_probes_with_is_one_the_hub_would_look_up():
    """The trick `hammerola login` stands on (issue #98).

    `check_token` asks the jobs route for an id no job can have and reads the
    answer as a verdict on the SECRET: 401 is "wrong token", anything else is
    "the token was accepted and there is no such job". That reading is only
    worth anything while the id gets past the hub's SHAPE check and misses in
    the LOOKUP — which is what `IMPOSSIBLE_JOB_ID` is built for: 22 characters
    out of the alphabet `secrets.token_urlsafe(JOB_ID_BYTES)` produces.

    So the width is the pairing, and it is held here rather than restated:
    change `JOB_ID_BYTES` on the hub and this probe stops being an id at all.
    The client then has no way to tell what it is being told — the 404 it reads
    as "your password is right" is the shape check's answer about the id, and
    what `hammerola login` accepts or refuses rests on the order in which one
    route happens to make its two checks rather than on the secret it asked
    about.
    """
    from src.jobs import SAFE_JOB_ID

    from hammerola.hub import IMPOSSIBLE_JOB_ID

    assert SAFE_JOB_ID.match(IMPOSSIBLE_JOB_ID), (
        f"{IMPOSSIBLE_JOB_ID!r} is no longer an id this hub would look up "
        f"({SAFE_JOB_ID.pattern}), so the 404 `hammerola login` reads as "
        f"'the password was accepted' is now the hub refusing the id instead")
