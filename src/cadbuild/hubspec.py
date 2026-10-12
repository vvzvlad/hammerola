#!/usr/bin/env python3
"""Limits and names fixed by cad_snapshot_hub docs/SPEC.md sections 7 and 7.1.

Mirrored here so a bad model fails locally with a readable message instead of
coming back as an opaque 422 from the hub. Do not improvise: the hub validates
every field.
"""

import re
import unicodedata


# Hub-side limits, mirrored so a bad model fails here with a readable message
# instead of coming back as an opaque 422 from the hub (SPEC 7.1).
MEMBER_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
RESERVED_NAMES = {"meta.json", "index.html", "metrics.json"}

# The author's note on a part: free text from the catalogue shown to whoever
# opens the build (a catalogue name, a datasheet link, the fit taken). Not the
# reader's own browser-local note, nor a viewer's comment to the agent
# (SPEC 7A).
#
# Never above the hub's ceiling (`render.MAX_TEXT`): the hub re-checks every
# note, and a refused note would waste a whole build on a 422.
# tests/cadbuild/test_views.py holds these numbers against the hub's.
MAX_NOTE_CHARS = 200
# The catalogue size, capped by the hub too (`render.MAX_PARTS`): a
# per-record ceiling leaves the total unbounded, and a huge meta.json is
# served `immutable` for a year. It counts records, not notes, since records
# without notes cost the same. tests/cadbuild/test_naming.py compares the two
# by name.
MAX_PARTS = 200
# The view's own name (the picker caption), written into meta.json by
# export_views and re-checked by the hub (`render._plain_text(..., "view
# name")`).
MAX_VIEW_NAME_CHARS = 200

# How deep a view file's part tree may nest, counted the hub's way: the root
# document is 0, a part directly under it 1, a part in a group one deeper.
# Mirrored from `render.MAX_VIEW_DEPTH` for the same reason as above; the hub
# walks the tree, so an unbounded nest would turn a 422 into a 500.
MAX_VIEW_DEPTH = 64

# No part-name ceiling here: a part name in a view file is a catalogue key (or
# a group name under the same rule), and MEMBER_RE is strictly narrower than
# the hub's `_check_part_name` (128 against 200 characters, a smaller
# alphabet), so anything accepted here the hub accepts.
# tests/cadbuild/test_views.py asserts the containment.


def hub_text_problem(value, limit, *, angle_brackets_ok=False):
    """Why the hub would refuse this text on the way in, or None if it would not.

    A transcription of `render._plain_text` and the angle-bracket rule beside
    it, not an import: this runs inside the build process
    (src/buildproc/child.py), which must not import serving code.
    tests/test_notes.py runs one set of inputs through both and asserts they
    agree.

    The three rules, and why each is the hub's:

      * the ceiling, so one build cannot push every other card off a page;
      * nothing in Unicode category C (Cc, Cf, Cs, Co, Cn). Cf matters: U+202E
        RIGHT-TO-LEFT OVERRIDE looks printable and reverses the text around
        the field;
      * no angle bracket: a build page is permanent, immutable for a year and
        shares an origin with every other project, so text must not be able
        to become markup.

    The third rule is a flag because the hub applies it only to notes and part
    names (`render._check_part_name`), not to titles, project names or view
    names: our pages write those with `textContent`, while the vendored viewer
    puts part names into `innerHTML`. Matching the hub keeps the verdicts
    equal; banning brackets everywhere would refuse titles the hub accepts.
    `False` is the default so a silent caller gets the rule.

    A reason string rather than an exception: the caller knows the view and the
    part, and every message built on this names both.
    """
    if not isinstance(value, str):
        # As the hub's `_check_part_name` does: `len()` works on a list, and
        # `unicodedata.category` of its first element would then raise a bare
        # TypeError out of the build.
        return f"is {type(value).__name__}, not a string"
    if len(value) > limit:
        return f"is {len(value)} characters, over the {limit} the hub accepts"
    for char in value:
        if unicodedata.category(char).startswith("C"):
            return f"carries a non-printable character {char!r}"
    if not angle_brackets_ok and ("<" in value or ">" in value):
        return "carries an angle bracket"
    return None


# The slot name `hammerola build` publishes under. Reserved on the hub side,
# where it is a pointer that gets overwritten rather than a snapshot id
# (SPEC 7.6).
DEV_LABEL = "dev"

# The project id reserved for a test project.json (hand-written or carried
# over). Chosen on purpose:
#
#   * not 12 hex characters, so nobody mistakes it for a generated id;
#   * it says what it is in the URL, where an id is seen;
#   * project.refuse_test_id() matches this exact string and stops any run
#     that would push under it, with a message.
#
# It passes MEMBER_RE, so it exercises the real pipeline. It lives here, with
# the other shared names, because project.py must recognise it.
TEST_ID = "local-test-do-not-publish"
