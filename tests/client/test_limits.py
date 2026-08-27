"""The client's copy of the hub's ceilings must be the hub's ceilings.

THIS IS THE TEST THAT DID NOT EXIST, and its absence is why publication is
broken today. `cad_publish/hubspec.py` carried the same numbers in a repository
that could not see the hub's; when the hub changed, nothing anywhere compared
the two. Both halves are in this repository now, so the comparison is a test —
and one that runs in the same CI job as everything else, so a change to either
side fails at the commit that makes it rather than at the next attempt to
publish a model.

`src/client/limits.py` explains why it is a copy at all: the client has to
import under a laptop's bare python3, and `src.store` brings loguru and the
service with it. The copy is the price; this file is what makes the price
bearable.
"""

from src import store
from src.client import limits
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
