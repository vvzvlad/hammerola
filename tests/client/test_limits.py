"""The client's copy of the hub's ceilings must be the hub's ceilings.

Both halves are in this repository, so the comparison is a test in the same
CI job as everything else: a change to either side fails at the commit that
makes it rather than at the next attempt to publish a model.

`hammerola/limits.py` explains why it is a copy at all: the client has to
import under a laptop's bare python3, and `src.store` brings loguru and the
service with it. The copy is the price; this file is what makes the price
bearable.
"""

from src import prereceive, store
from hammerola import limits


def test_the_path_alphabets_are_the_hubs():
    assert limits.SAFE_ID.pattern == store.SAFE_ID.pattern
    assert limits.SAFE_COMPONENT.pattern == store.SAFE_COMPONENT.pattern


def test_the_tree_ceilings_are_the_hubs():
    assert limits.MAX_PATH_DEPTH == store.MAX_PATH_DEPTH
    assert limits.MAX_MEMBERS == store.MAX_MEMBERS


def test_the_reserved_build_names_are_the_hubs():
    assert set(limits.RESERVED_BUILD_NAMES) == set(store.RESERVED_BUILD_NAMES)
    assert limits.DEV_SLOT == store.DEV_LINK
    assert limits.VARIANT_SEGMENT == store.VARIANT_SEGMENT
    assert limits.DEFAULT_VARIANT == store.MAIN_BRANCH
    assert limits.VARIANT_NAME_REFUSAL == prereceive.VARIANT_NAME_REFUSAL


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


def test_the_token_header_is_spelled_the_same_on_both_sides():
    """The name of the header the token travels on.

    Spelled twice for the reason everything in this file is: the client must
    import under a bare python3 and cannot see `src`.
    """
    from src.app import TOKEN_HEADER as hub_token_header

    from hammerola.hub import TOKEN_HEADER as client_token_header

    assert client_token_header == hub_token_header


def test_the_states_a_poller_stops_on_are_the_hubs():
    """The two words `Hub.await_job` waits to see.

    The hub is the side that ISSUES them, and the tuple in `src/jobs.py` is the
    wire contract this client mirrors. The
    client's copy is a copy for the reason everything in this file is one — it
    has to import under a bare python3.

    Drift is a green suite and a broken wait. A word this side does not
    recognise is not an error anywhere: the job runs and ends, while
    `await_job` goes on polling a record that will never change again until its
    deadline runs out. `diff --material` then reports a timeout on a comparison
    the hub finished.
    """
    from src.jobs import TERMINAL_STATES as hub_states

    from hammerola.hub import TERMINAL_STATES as client_states

    # As SETS, because the order decides nothing on either side: both are only
    # ever asked whether a state is in them.
    assert set(client_states) == set(hub_states), (
        f"the client stops polling on {sorted(client_states)} and the hub ends "
        f"a job in {sorted(hub_states)} — a state missing from this side is a "
        f"`diff --material` that reports a timeout on a comparison that "
        f"finished")


def test_the_attachment_kinds_are_the_hubs():
    """What `hammerola comments files` asks the hub FOR.

    Both spellings travel, and each of the two is the same string in two
    places: the kind is the KEY a comment record carries the stored file name
    under (`comments.CommentStore`, which writes `photo` and `shot`), and it is
    the last segment of the URL those bytes are served at (`app._serve_comments`
    routes `<id>/<kind>` for exactly those two). `queue.PHOTO_KIND` is the first
    member of `ATTACHMENTS` by construction, so comparing the kinds this tool
    knows against the hub's two covers it as well.

    `tests/client/test_queue.py` already pins the EXTENSIONS such a file is
    stored under and says nothing about the kinds.

    Drift is silent in both halves. A kind the record does not carry reads as
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
    """The trick `hammerola login` stands on.

    `check_token` asks the jobs route for an id no job can have and reads the
    answer as a verdict on the SECRET: 403 is "wrong token", anything else is
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
