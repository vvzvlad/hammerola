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
"""

import json

from harness import good_build, meta_bytes, tar_gz, view_bytes

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
