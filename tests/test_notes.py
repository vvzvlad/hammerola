"""The author's note on a part, on the receiving side (SPEC 8, entry 11).

A note is written by the AUTHOR in model.py, travels with the build in
meta.json and is addressed to whoever opens the model. That makes it the third
kind of text on this hub and the two neighbours are worth naming, because they
are not this one: the READER's note lives in a browser's localStorage and never
leaves it, and a COMMENT is written by a viewer, goes into a queue and is
addressed to the agent (SPEC 7A). Different source, different direction,
different rights.

WHAT THIS FILE IS ACTUALLY GUARDING is the boundary rather than the feature.
`build_meta` drops every key of the uploaded document it does not read, so an
unvalidated `notes` would simply never reach the browser — and a `notes` passed
through unchecked is a stored-XSS hole on a URL that is permanent, immutable
for a year and shares an origin with every other project on the host. The text
comes from a push, i.e. from anybody who can land a commit in a model
repository, so it is held to the rules `title` and a part name are held to,
whatever the browser half later decides to do with it.

THE LAST SECTION IMPORTS THE BUILD HALF, which nothing else on this side does,
and that is the point of putting it here: `src/cadbuild/views.py` checks the
same text before the geometry is computed and may not import this module, so
the two rules are written twice and this file is the only place allowed to see
both at once.
"""

import json

from harness import good_build, meta_bytes, tar_gz, view_bytes

from src.cadbuild.errors import BuildError
from src.cadbuild.views import MAX_NAME_CHARS, MAX_NOTE_CHARS, read_parts
from src.render import MAX_NOTES, MAX_TEXT


def publish_notes(hub, notes, commit="abc123"):
    """Push one build whose meta.json carries this `notes` value, whatever it is."""
    body = tar_gz({"meta.json": meta_bytes(notes=notes),
                   "assembled.json": view_bytes()})
    return hub.publish("proj1", commit, body)


def refused(hub, notes):
    """The push is a 422 AND nothing of it was published."""
    reply = publish_notes(hub, notes)
    assert reply.status_code == 422, reply.text
    assert not (hub.project_dir("proj1") / "abc123").exists()
    return reply.json()["error"]


def test_a_note_survives_a_publish_and_is_served(hub):
    notes = {"lid": "M3x8 DIN912", "корпус": "PETG, 4 walls"}
    assert publish_notes(hub, notes).status_code == 201

    on_disk = json.loads(
        (hub.project_dir("proj1") / "abc123" / "meta.json").read_text())
    assert on_disk["notes"] == notes
    # And through the route the viewer actually fetches, which is the only one
    # that matters: a note the hub stored and does not serve is not a note.
    assert hub.get("/project/proj1/abc123/meta.json").json()["notes"] == notes


def test_a_build_with_no_notes_serves_no_notes_key(hub):
    """A build that declares nothing and a build from before notes existed have
    to be the same document here — otherwise the browser half grows two ways of
    asking one question, and every older build answers only one of them."""
    assert hub.publish("proj1", "abc123", good_build()).status_code == 201
    meta = hub.get("/project/proj1/abc123/meta.json").json()
    assert "notes" not in meta

    # An empty object is the same statement and gets the same treatment: it is
    # accepted (nothing was described wrongly) and it is not stored.
    assert publish_notes(hub, {}, commit="def456").status_code == 201
    assert "notes" not in hub.get("/project/proj1/def456/meta.json").json()


def test_a_note_carrying_markup_is_refused(hub):
    """The angle-bracket ban, and it is about the boundary rather than about
    today's renderer: text that cannot open an element cannot become markup
    whatever ends up putting it on the page."""
    error = refused(hub, {"lid": "see <a href=/>the datasheet</a>"})
    assert "angle bracket" in error


def test_a_note_key_carrying_markup_is_refused(hub):
    """The KEY is a part name — it is matched against the names in the view
    file — so it is held to the part-name rule, which is the stricter one."""
    error = refused(hub, {"<img src=x onerror=alert(1)>": "harmless text"})
    assert "angle bracket" in error


def test_a_control_character_in_a_note_is_refused(hub):
    # U+202E RIGHT-TO-LEFT OVERRIDE is the one worth naming: it is printable as
    # far as a naive check goes, textContent renders it faithfully, and it
    # reverses the text AROUND whatever field it was smuggled into.
    assert "non-printable" in refused(hub, {"lid": "M3x8‮gnitset"})
    assert "non-printable" in refused(hub, {"lid": "first line\nsecond line"})


def test_a_notes_that_is_not_an_object_is_refused(hub):
    # `[]` and `""` are the interesting ones: a falsy non-object would be turned
    # into "no notes at all" by the spelling `downloads` uses, publishing a push
    # that described something else entirely without a word about it.
    for bad in ([], [["lid", "M3x8"]], "", "M3x8", 0, 7):
        assert "must be an object" in refused(hub, bad), bad


def test_a_note_that_is_not_a_string_is_refused(hub):
    for bad in (42, None, ["M3x8"], {"text": "M3x8"}):
        assert "not a string" in refused(hub, {"lid": bad}), bad


def test_a_note_longer_than_the_free_text_ceiling_is_refused(hub):
    """The same ceiling `title` gets: it is displayed text arriving from a push."""
    error = refused(hub, {"lid": "x" * (MAX_TEXT + 1)})
    assert str(MAX_TEXT) in error
    # The last legal length still publishes, under a commit of its own: the
    # refused push above left `abc123` unused, and reusing it with different
    # content is the one thing this hub answers with a 409 rather than a 422.
    assert publish_notes(hub, {"lid": "x" * MAX_TEXT},
                         commit="def456").status_code == 201


def test_more_notes_than_the_ceiling_are_refused(hub):
    """The COUNT, which a per-note ceiling does not bound on its own: every one
    of these entries is legal, and the document they make is not."""
    error = refused(hub, {f"part {i}": "x" for i in range(MAX_NOTES + 1)})
    assert str(MAX_NOTES) in error
    # ...and the last legal size still publishes, so the ceiling is a ceiling
    # rather than an off-by-one nobody can push through.
    assert publish_notes(hub, {f"part {i}": "x" for i in range(MAX_NOTES)},
                         commit="def456").status_code == 201


# --------------------------------------------------------------------------
# The build gate and this one, held to ONE answer
#
# `src/cadbuild/views.py` checks a note before the geometry is computed and
# this module checks it again on the way in. That is deliberate -- the build
# half may not import the serving half, because it runs inside the build
# process -- so the rules are written twice, and the two copies are held
# together HERE, from the one side that is allowed to import both.
#
# What the duplication buys, and what its failure costs, are the same fact seen
# from two ends: a note the build accepts and the hub then refuses is minutes
# of geometry answered with a 422, over a character. `clearance < 0.2 mm` is
# ordinary CAD prose and was exactly that until the gate learned the rule.
# --------------------------------------------------------------------------

class Shape:
    """The one attribute `cadbuild.geometry.as_shapes` looks for.

    tests/cadbuild/fakes.py has a fuller stand-in, and reaching for it from
    here would be a bet on collection order: that directory lands on sys.path
    only because pytest inserted it while collecting the suite next door, so
    `pytest tests/test_notes.py` on its own would not find it. Nothing below
    needs geometry anyway -- read_parts only asks whether it was handed some.
    """

    def isValid(self):
        return True


DISAGREEMENT = (
    "{what} {value!r}: the build gate {here} it, the hub {there} it.\n"
    "These two rules are transcriptions of each other and this test is the "
    "only thing holding them together.\n"
    "  build ACCEPTS / hub REFUSES is the bug the pair exists to prevent: the "
    "model is computed for minutes and then answered with a 422, so the author "
    "pays for the geometry to be told about a character. Teach "
    "`cadbuild.views.hub_text_problem` whatever rule was just added here.\n"
    "  build REFUSES / hub ACCEPTS is safe but not free: a model is turned "
    "away for a reason the hub does not have. Make that a decision rather than "
    "drift.")


def text_cases(limit):
    """One set of inputs for both sides, plus the two lengths around a ceiling.

    Nothing here carries leading or trailing whitespace, on purpose: the build
    half strips a note and a name before anything else, so the hub never sees
    the outside of one and a padded input would compare two different strings.
    """
    return [
        ("ordinary text", "M3x8 DIN912"),
        ("text that is not English", "корпус, PETG, 4 walls"),
        ("a less-than sign", "clearance < 0.2 mm"),
        ("a greater-than sign", "gap > 0.1 mm"),
        ("a whole tag", "see <a href=/>the datasheet</a>"),
        ("a NUL", "M3x8\x00DIN912"),
        ("an ESC", "M3x8\x1bDIN912"),
        ("a newline", "first line\nsecond line"),
        ("a tab", "M3x8\tDIN912"),
        ("an RTL override", "M3x8‮gnitset"),
        ("exactly the ceiling", "x" * limit),
        ("one character over the ceiling", "x" * (limit + 1)),
    ]


def hub_refuses(hub, notes, commit):
    """Does a real push carrying this `notes` get turned away?"""
    reply = publish_notes(hub, notes, commit=commit)
    # 409 or 413 here would mean the push was answered for a reason that has
    # nothing to do with the text, and the comparison below would be a
    # coincidence rather than a verdict.
    assert reply.status_code in (201, 422), reply.text
    return reply.status_code == 422


def build_refuses(**fields):
    """Does the gate turn away a part written this way, before any geometry?"""
    try:
        read_parts({"id": "assembled", "parts": [dict(fields, shape=Shape())]},
                   "assembled")
    except BuildError:
        return True
    return False


def test_the_two_halves_agree_about_a_note_s_text(hub):
    for index, (what, text) in enumerate(text_cases(MAX_NOTE_CHARS)):
        here = build_refuses(name="lid", note=text)
        there = hub_refuses(hub, {"lid": text}, commit=f"note{index:02d}")
        assert here == there, DISAGREEMENT.format(
            what=f"as the note {what}", value=text,
            here="refuses" if here else "accepts",
            there="refuses" if there else "accepts")


def test_the_two_halves_agree_about_a_part_name(hub):
    """The name is the KEY the note is stored under, so it is the same
    question asked about the other half of the entry -- and the hub holds it to
    the stricter part-name rule, which is the one the gate has to match."""
    for index, (what, name) in enumerate(text_cases(MAX_NAME_CHARS)):
        here = build_refuses(name=name)
        there = hub_refuses(hub, {name: "harmless text"},
                            commit=f"name{index:02d}")
        assert here == there, DISAGREEMENT.format(
            what=f"as the part name {what}", value=name,
            here="refuses" if here else "accepts",
            there="refuses" if there else "accepts")
