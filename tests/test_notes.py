"""The author's note on a part, on the receiving side (issue #11).

A note is written by the AUTHOR in model.py, travels with the build in
meta.json and is addressed to whoever opens the model. That makes it the third
kind of text on this hub and the two neighbours are worth naming, because they
are not this one: the READER's note lives in a browser's localStorage and never
leaves it, and a COMMENT is written by a viewer, goes into a queue and is
addressed to the agent (SPEC 7A). Different source, different direction,
different rights.

A NOTE IS NO LONGER A MAP OF ITS OWN (issue #75): it sits inside the catalogue
record it is about, `parts[<key>]["note"]`, which is the only thing that
changed. The rules are the ones it always had, and so is everything below.

WHAT THIS FILE IS ACTUALLY GUARDING is the boundary rather than the feature.
`build_meta` rebuilds every record field by field and drops what it does not
read, so an unvalidated note would simply never reach the browser — and a note
passed through unchecked is a stored-XSS hole on a URL that is permanent,
immutable for a year and shares an origin with every other project on the host.
The text comes from a push, i.e. from anybody who can land a commit in a model
repository, so it is held to the rules `title` and a part name are held to,
whatever the browser half later decides to do with it.

THE LAST TWO SECTIONS IMPORT THE BUILD HALF, which nothing else on this side
does, and that is the point of putting them here: `src/cadbuild/views.py` and
`src/cadbuild/project.py` check the same text before the geometry is computed
and may not import this module, so the rules are written twice and this file is
the only place allowed to see both copies at once. FOUR texts cross that
boundary and all four are paired here -- a note, a part name, a view's caption,
and the project's own title and slug. The file is named after the first pair
rather than after the boundary, which is the only reason the other three are
not in a file of their own.
"""

import json

from harness import good_build, meta_bytes, tar_gz, view_bytes

from src.cadbuild import paths
from src.cadbuild.errors import BuildError
from src.cadbuild.project import MAX_TITLE_CHARS, load_project
from src.cadbuild.hubspec import MAX_NOTE_CHARS, MAX_VIEW_NAME_CHARS, MEMBER_RE
from src.cadbuild.parts import read_catalogue
from src.cadbuild.views import prepare_views
from src.render import MAX_PARTS, MAX_TEXT

# NOTE ON THE PART-NAME CEILING BELOW, because it stopped being symmetrical.
# The build half no longer has one of its own: a part's name in a view file is a
# catalogue key now, held to `hubspec.MEMBER_RE` (128 characters, an alphabet
# rather than a length for text). What is left to compare against is the hub's,
# and the hub has no constant for it either -- `render._check_part_name` defers
# to `_plain_text`, whose ceiling is `MAX_TEXT`. So the cases below are
# generated from `MAX_TEXT` DIRECTLY, and deliberately not from a local alias of
# it: a second name for one number, sitting one line under the import of the
# number, is the shape this whole change is removing. What the two sides owe
# each other at that ceiling is answered in
# test_the_gate_takes_no_part_key_the_hub_would_refuse below: containment, not
# equality, and the asymmetry is argued there.


def publish_notes(hub, notes, commit="abc123"):
    """Push one build whose catalogue carries these notes, keyed by part.

    The view names every key, because that is what a real document does — the
    catalogue is what a view selects from — and because it keeps the two halves
    of the document in step whatever key a case puts in. THE VIEW FILE NAMES
    THEM TOO, for the same reason and now as a requirement: the hub holds a
    view's declared `parts` against the keys its file actually carries
    (`render._match_selection`), so a stand-in file naming the default pair
    would answer every case below with a mismatch instead of a verdict about
    the note.
    """
    parts = {key: {"kind": "printable", "note": note}
             for key, note in notes.items()}
    body = tar_gz({"meta.json": meta_bytes(
        parts=parts,
        views=[{"id": "assembled", "name": "assembled",
                "file": "assembled.json", "parts": list(parts)}]),
        "assembled.json": view_bytes(keys=tuple(parts))})
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
    assert {key: record["note"]
            for key, record in on_disk["parts"].items()} == notes
    # And through the route the viewer actually fetches, which is the only one
    # that matters: a note the hub stored and does not serve is not a note.
    served = hub.get("/project/proj1/abc123/meta.json").json()["parts"]
    assert served["lid"]["note"] == "M3x8 DIN912"


def test_a_part_with_nothing_to_say_carries_no_note_key(hub):
    """Absent, not empty — the rule the whole document is written to.

    An empty string here would be a build SAYING it has no note, so a reader
    would have two ways of asking one question and the answer to "is there
    something to tell me about this part" would depend on which was asked.
    """
    assert hub.publish("proj1", "abc123", good_build()).status_code == 201
    meta = hub.get("/project/proj1/abc123/meta.json").json()
    assert [record for record in meta["parts"].values() if "note" in record] == []


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


def test_a_catalogue_that_is_not_an_object_is_refused(hub):
    """The map the notes now live in, and the trap it must not fall into.

    `[]`, `""` and `0` are the interesting ones: a falsy non-object read as
    `raw.get("parts") or {}` becomes "no parts at all", which would publish a
    push that described something else entirely without a word about it. `{}`
    is on the list for a different reason — a catalogue with nothing in it is
    not a build this hub can have written, and accepting one here would publish
    a document `store._usable_meta` then silently declines to list.
    """
    for bad in ([], [["lid", "M3x8"]], "", "M3x8", 0, 7, {}):
        body = tar_gz({"meta.json": meta_bytes(
            parts=bad,
            views=[{"id": "assembled", "name": "assembled",
                    "file": "assembled.json", "parts": []}]),
            "assembled.json": view_bytes()})
        reply = hub.publish("proj1", "abc123", body)
        assert reply.status_code == 422, bad
        assert "`parts` catalogue" in reply.json()["error"], bad
        assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_note_that_is_not_a_string_is_refused(hub):
    for bad in (42, ["M3x8"], {"text": "M3x8"}):
        assert "not a string" in refused(hub, {"lid": bad}), bad


def test_a_note_written_null_is_a_part_with_no_note(hub):
    """`null` was on the list above until issue #75, and taking it off is a
    decision rather than a test bent around the code.

    A note used to be a VALUE in a flat `notes` map, where a null row is a
    broken row and nothing else. It is an optional field inside a record now,
    and every optional field in `_catalogue` is read `is None` -- so `null` is
    the JSON spelling of "no note", the same as leaving the key out.

    What the old refusal actually protected is still closed, and closed harder:
    a non-string note must never reach the browser. It does not, because the key
    is not emitted at all -- the served record is byte-identical to one from a
    push that never mentioned a note. The verdict on the PUSH changed; what is
    served did not.
    """
    assert publish_notes(hub, {"lid": None}).status_code == 201
    served = hub.get("/project/proj1/abc123/meta.json").json()["parts"]
    assert served["lid"] == {"kind": "printable"}


def test_a_note_longer_than_the_free_text_ceiling_is_refused(hub):
    """The same ceiling `title` gets: it is displayed text arriving from a push."""
    error = refused(hub, {"lid": "x" * (MAX_TEXT + 1)})
    assert str(MAX_TEXT) in error
    # The last legal length still publishes, under a commit of its own: the
    # refused push above left `abc123` unused, and reusing it with different
    # content is the one thing this hub answers with a 409 rather than a 422.
    assert publish_notes(hub, {"lid": "x" * MAX_TEXT},
                         commit="def456").status_code == 201


def test_a_catalogue_bigger_than_the_ceiling_is_refused(hub):
    """The COUNT, which a per-record ceiling does not bound on its own: every
    one of these entries is legal, and the document they make is not.

    IT COUNTS RECORDS AND NOT NOTES, which is the whole of the rename in
    issue #75: the second half below carries no note anywhere and is refused
    just the same, because a hundred thousand bought screws make the same
    unloadable meta.json — served under a year of `immutable`, from a push that
    can never be taken back — and the ceiling that counted notes could not see
    one of them.
    """
    error = refused(hub, {f"part {i}": "x" for i in range(MAX_PARTS + 1)})
    assert str(MAX_PARTS) in error
    # ...and the last legal size still publishes, so the ceiling is a ceiling
    # rather than an off-by-one nobody can push through.
    assert publish_notes(hub, {f"part {i}": "x" for i in range(MAX_PARTS)},
                         commit="def456").status_code == 201

    over = {f"part {i}": {"kind": "hardware"} for i in range(MAX_PARTS + 1)}
    body = tar_gz({"meta.json": meta_bytes(
        parts=over,
        views=[{"id": "assembled", "name": "assembled",
                "file": "assembled.json", "parts": []}]),
        "assembled.json": view_bytes()})
    reply = hub.publish("proj1", "ghi789", body)
    assert reply.status_code == 422, reply.text
    assert str(MAX_PARTS) in reply.json()["error"]


# --------------------------------------------------------------------------
# The build gate and this one, held to ONE answer
#
# `src/cadbuild/parts.py` checks a note before the geometry is computed and
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
    """The one attribute `cadbuild.geometry.as_shape` looks for.

    tests/cadbuild/fakes.py has a fuller stand-in, and reaching for it from
    here would be a bet on collection order: that directory lands on sys.path
    only because pytest inserted it while collecting the suite next door, so
    `pytest tests/test_notes.py` on its own would not find it. Nothing below
    needs geometry anyway -- read_catalogue only asks whether it was handed
    some.
    """

    def isValid(self):
        return True


class Model:
    """A model.py with a catalogue and nothing else, for `read_catalogue`."""

    def __init__(self, catalogue):
        self._catalogue = catalogue

    def parts(self):
        return self._catalogue


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

    WHITESPACE USED TO BE EXCLUDED HERE and the reason given was false, which
    is worth writing down because the exclusion was a blind spot in exactly the
    place these loops exist to look. It said the build half strips a note, a
    name and a title, "so the hub never sees the outside of one" — but the hub
    sees whatever a HAND-MADE push sends, and it was accepting `"   "` as a note
    while the gate refused it. That is in the set now, as the last entry before
    the ceilings, and both halves refuse it: the gate because a note is empty
    once stripped, the hub because `render._check_note` refuses text that did
    not arrive stripped. (A view's caption is stripped by neither side and a
    blank title falls back to the directory name, so the other two loops answer
    it "accepted by both" — which is why one entry can serve all three.)

    WHAT STAYS OUT IS PADDED TEXT WITH SOMETHING INSIDE IT — ` M3x8 ` — and it
    stays out because its two verdicts differ BY DESIGN while this loop asserts
    they are equal: the gate accepts it and publishes `M3x8`, the hub refuses
    the padded spelling outright. It is pinned in
    test_the_hub_refuses_the_padding_the_gate_strips_off, together with the
    reason that divergence is the safe kind.

    NOTHING HERE IS EMPTY EITHER, and that exclusion is a decision rather than
    a gap in the set: this one set is read by three loops — a note, a view's
    caption and a title — and an empty string means something different on
    each, so it is pinned per field instead. The note's answer is
    test_both_halves_refuse_an_empty_note_and_only_the_gate_an_empty_key, where
    the two halves now agree and the empty KEY is the divergence that is left.
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
        ("nothing but whitespace", "   "),
        ("exactly the ceiling", "x" * limit),
        ("one character over the ceiling", "x" * (limit + 1)),
    ]


def key_cases():
    """Catalogue KEYS, chosen to straddle both rules rather than one.

    A separate set from `text_cases` because a key is not free text: the first
    entries are names `MEMBER_RE` accepts, and they are the ones that make the
    containment below mean anything -- run against `text_cases`, where the gate
    refuses every single entry, the implication would be satisfied by nothing
    ever getting through. The rest straddle the gap between the two rules (a
    space, a non-Latin key, one character past MEMBER_RE's 128) and then the
    hub's own ceiling, which is where both sides refuse again.

    Nothing here is a RESERVED_STEM: `assembled` and `print` are refused by the
    gate for a reason that is not about the alphabet, and a reservation is not
    what this loop is comparing.
    """
    return [
        ("an ordinary key", "lid"),
        ("dots, dashes and underscores", "left-front_bracket.v2"),
        ("a digit for a first character", "0"),
        ("exactly the gate's ceiling", "x" * 128),
        ("one character over the gate's ceiling", "x" * 129),
        ("a space", "left lid"),
        ("a key that is not English", "корпус"),
        ("a whole tag", "<img src=x onerror=alert(1)>"),
        ("a newline", "lid\nother"),
        ("exactly the hub's ceiling", "x" * MAX_TEXT),
        ("one character over the hub's ceiling", "x" * (MAX_TEXT + 1)),
    ]


def hub_refuses(hub, notes, commit):
    """Does a real push carrying this `notes` get turned away?"""
    reply = publish_notes(hub, notes, commit=commit)
    # 409 or 413 here would mean the push was answered for a reason that has
    # nothing to do with the text, and the comparison below would be a
    # coincidence rather than a verdict.
    assert reply.status_code in (201, 422), reply.text
    return reply.status_code == 422


def build_refuses(name="lid", **fields):
    """Does the gate turn away a part written this way, before any geometry?"""
    try:
        read_catalogue(Model(
            {name: dict(fields, shape=Shape(), kind="printable")}))
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


def test_the_gate_takes_no_part_key_the_hub_would_refuse(hub):
    """CONTAINMENT here, not equality, and the asymmetry is a decision.

    The other loops in this file demand one answer from both sides. This one
    cannot and must not: a part's name is a CATALOGUE KEY now (issue #75), and
    the build holds a key to `hubspec.MEMBER_RE` — 128 characters of letters,
    digits, dot, dash and underscore — while the hub holds it to
    `_check_part_name`, which is 200 characters of anything printable without
    an angle bracket. MEMBER_RE is strictly the narrower of the two, so half
    the cases below are refused by the gate and accepted by the hub: a key with
    a space in it, a Cyrillic key, a key of 129 characters.

    THAT IS THE SAFE DIRECTION AND IT IS THE ONE THIS ASSERTS. What may never
    happen is the other one — a key the build accepts and the hub then refuses,
    which is a whole model computed and answered with a 422 over a character.
    So this checks the implication rather than the equality, and it checks it
    through a REAL PUSH: tests/cadbuild/test_naming.py compares the two rules as
    functions, which is a different witness and misses anything the document
    does to a key on the way (it is also, on its own, why neither file's version
    of this makes the other redundant).

    A key is why the gate can be the narrow one at all: unlike a note, it has to
    survive being a FILE STEM (`lid.stl`) and a path component, so the alphabet
    is not a second opinion about text — it is the rule that keeps the exported
    file nameable.

    THE CASES ARE KEY-SHAPED AND NOT `text_cases`, which is what this loop asks
    that the note loops do not: `text_cases` is free text and MEMBER_RE refuses
    every entry in it, so run against that set the implication below would hold
    without a single key ever reaching the hub's half. The first entries here
    are keys the gate ACCEPTS, and they are the ones the containment is about.
    """
    verdicts = []
    for index, (what, name) in enumerate(key_cases()):
        here = build_refuses(name=name)
        there = hub_refuses(hub, {name: "harmless text"},
                            commit=f"key{index:02d}")
        assert here or not there, DISAGREEMENT.format(
            what=f"as the part key {what}", value=name,
            here="accepts", there="refuses")
        verdicts.append((here, there))

    # The implication is not vacuous in EITHER direction, and both halves of
    # that matter. A gate that refused everything would satisfy the loop above
    # by never letting a case reach the comparison at all; and two rules that
    # happened to answer alike everywhere would make the asymmetry argued in
    # this docstring a story rather than a fact about the code.
    assert any(not here for here, _there in verdicts)
    assert any(here and not there for here, there in verdicts)
    # ...and the set really does straddle MEMBER_RE, which is the line the two
    # rules differ across. Asserted rather than trusted to the comments above,
    # because 128 is a number inside a regex and not a constant anybody can
    # import: a case shortened by one character would slide across it silently.
    assert ({bool(MEMBER_RE.match(name)) for _what, name in key_cases()}
            == {True, False})


def test_both_halves_refuse_an_empty_note_and_only_the_gate_an_empty_key(hub):
    """The empty string, on the two fields it can land on, kept out of the loops.

    `text_cases` carries nothing empty, and that exclusion is a DECISION rather
    than a hole in the set: the set is shared by three loops (a note, a view's
    caption, a title) and an empty string means something different on each, so
    the note's answer is pinned here instead. Whitespace-only text used to be
    excluded beside it and is not any more: the two halves answer it ALIKE on
    all three fields — refused by both as a note, accepted by both as a caption
    and as a title — which is the only thing those loops ask of an entry. That
    docstring has the story.

    THE NOTE IS NOW REFUSED BY BOTH HALVES, and the change is the hub's. It used
    to take `""` — there is no character in it to be too long, to file under
    category C or to be an angle bracket — and emit `"note": ""`, which is the
    one thing the document's own rule forbids: absent rather than empty, so a
    reader never has two ways of asking whether there is something to say about
    a part. `_check_note` refuses it now rather than dropping it, because
    dropping it would be the hub editing a document it did not write. Nothing
    honest is turned away: `cadbuild.build` writes the key under `if
    record["note"]:`, so only a hand-made push can carry the value at all.

    THE EMPTY KEY IS STILL THE HUB'S TO TAKE, and that half of the old
    divergence stands. An empty part name is a label the viewer's tree cannot
    show and a nested_ok pair cannot point at — visible in model.py, which is
    where it can still be fixed — while the hub, by the time a push arrives, has
    a string and no model to judge it against. The direction is the safe one:
    the gate refuses what the hub would take, so nothing is computed for minutes
    and then answered with a 422.

    This test is what keeps both halves decisions rather than untested gaps.
    """
    assert build_refuses(name="lid", note="")
    assert hub_refuses(hub, {"lid": ""}, commit="empty01")
    assert build_refuses(name="")
    assert not hub_refuses(hub, {"": "harmless text"}, commit="empty02")


def test_an_empty_files_map_is_refused_exactly_as_an_empty_note_is(hub):
    """The record's OTHER optional field, and the same question asked of it.

    A NOTE'S NEIGHBOUR IS `files`, and until this test the two answered the
    empty spelling in opposite ways inside one walk: `_check_note` refused
    `""` on the argument that the hub does not edit a document it did not
    write, while `entry["files"] = exported` sat under an `if exported:` a
    dozen lines away and DROPPED `{}` in silence — publishing a 201 whose
    served record is byte-identical to one from a push that never mentioned a
    file. One document, one rule, two answers, and the one nobody could see was
    the drop.

    Both are the hub's to answer alone: `cadbuild.build` writes each key under a
    test that it has something to put there (`if key in part_files:`, `if
    record["note"]:`), so neither value can come off a build at all and there is
    no gate-side verdict to pair with. That is why this is one test over two
    fields rather than another entry in the loops above.

    `preview` is deliberately not a third case here: `""` is not a file the
    build declared, so `_check_declared_file` has always refused it.
    """
    for record, fragment in (({"kind": "printable", "files": {}}, "empty `files`"),
                             ({"kind": "printable", "note": ""}, "is empty")):
        body = tar_gz({"meta.json": meta_bytes(
            parts={"lid": record},
            views=[{"id": "assembled", "name": "assembled",
                    "file": "assembled.json", "parts": ["lid"]}]),
            "assembled.json": view_bytes(keys=("lid",))})
        reply = hub.publish("proj1", "abc123", body)
        assert reply.status_code == 422, reply.text
        assert fragment in reply.json()["error"], record
        assert not (hub.project_dir("proj1") / "abc123").exists()


def test_the_hub_refuses_the_padding_the_gate_strips_off(hub):
    """` M3x8 `: the one input whose two verdicts differ on purpose.

    THE GATE NORMALIZES AND THE HUB DOES NOT, and that is the whole of it:
    `cadbuild.parts._check_note` strips a note and returns the STRIPPED string,
    which is what `cadbuild.build` then writes into meta.json, while
    `render._check_note` refuses a note that did not arrive stripped. So this
    pair answers "build accepts / hub refuses" — the direction DISAGREEMENT
    above calls the bug — and it is not one here for a reason that has to be
    ASSERTED rather than written in a comment: what the build sends is never the
    padded string. The three lines below are that assertion, in order: what the
    gate makes of it, what the hub does with the padded spelling, and what the
    hub does with the value the gate actually produced.

    WHY THE HUB REFUSES IT AT ALL, rather than shrugging at a spelling only a
    hand-made push can send: ` M3x8 ` and `M3x8` are one authored note, and
    while both published they were two different documents depending on which
    half wrote the push — so a byte comparison of two revisions reported a
    change nobody made (issue #10). `render._check_note` has the rest of the
    argument, including why the hub refuses instead of stripping.

    It is HERE and not in `text_cases` because that set is read by three loops
    asserting the two halves answer alike, and this input is the one where they
    must not.
    """
    padded = " M3x8 "
    catalogue = read_catalogue(Model(
        {"lid": {"shape": Shape(), "kind": "printable", "note": padded}}))
    assert catalogue["lid"]["note"] == padded.strip()
    assert hub_refuses(hub, {"lid": padded}, commit="padded01")
    assert not hub_refuses(hub, {"lid": padded.strip()}, commit="padded02")


def test_a_note_that_is_falsy_and_not_a_string_is_still_refused(hub):
    """`0`, `[]` and `False` are refused as NON-STRINGS, not as empty ones.

    Worth its own test beside the empty string, because the two verdicts come
    from two different lines and the new one sits right above the old. A reader
    of `_check_note` could take the `if not value:` clause for the check that
    covers all of these — it would, if it ran first — and then move it above the
    isinstance check, turning a `0` into "empty note" and a `[]` into the same,
    which is a message about the wrong thing. `null` is deliberately absent from
    this list: it is the JSON spelling of "no note" and publishes
    (test_a_note_written_null_is_a_part_with_no_note).
    """
    for bad in (0, [], False):
        assert "not a string" in refused(hub, {"lid": bad}), bad


# --------------------------------------------------------------------------
# The same pairing for the other two texts that cross the boundary
#
# A note and a part name were the first pair to be held together this way. They
# are not the only text a build hands the hub: the caption of a view and the
# project's own title and slug travel in the same meta.json and are checked
# there by the same `_plain_text`. Each got its own homemade check on the build
# side and each was WEAKER than the hub's -- a 201-character view name and a
# title carrying U+202E both passed the gate and were refused on arrival.
#
# Angle brackets are the one rule that is NOT shared here, and that is the
# hub's asymmetry rather than a gap: our own pages write a title, a project
# name and a view name with `textContent`, while the vendored viewer assigns a
# PART name to `innerHTML`. Transcribing that faithfully is what keeps these
# loops green; see `cadbuild.views.hub_text_problem`.
# --------------------------------------------------------------------------

def hub_refuses_meta(hub, commit, **fields):
    """Does a real push whose meta.json carries these fields get turned away?"""
    body = tar_gz({"meta.json": meta_bytes(**fields),
                   "assembled.json": view_bytes()})
    reply = hub.publish("proj1", commit, body)
    assert reply.status_code in (201, 422), reply.text
    return reply.status_code == 422


def build_refuses_view_name(name):
    """Does the gate turn away a view captioned this way, before any geometry?

    The view names one catalogue key, because that is all a view is now
    (issue #75) -- and the catalogue is built by `read_catalogue` rather than
    written out here, so this asks `prepare_views` the question with the shape
    it is really handed at build time.
    """
    catalogue = read_catalogue(
        Model({"lid": {"shape": Shape(), "kind": "printable"}}))
    try:
        prepare_views([{"id": "assembled", "name": name,
                        "parts": ["lid"]}], catalogue)
    except BuildError:
        return True
    return False


def build_refuses_project_field(tmp_path, where, **fields):
    """Does the gate turn away a project.json carrying this title or slug?"""
    root = tmp_path / where
    root.mkdir()
    (root / "project.json").write_text(
        json.dumps({"id": "abc123def456", **fields}), encoding="utf-8")
    paths.set_project_root(root)
    try:
        load_project()
    except BuildError:
        return True
    finally:
        # Module-level state that everything path-shaped in the build half
        # reads. Left behind, it fails the guard fixture that opens every test
        # in tests/cadbuild/ -- in another file, under one collection order.
        paths.set_project_root(None)
    return False


def test_the_two_halves_agree_about_a_view_s_name(hub):
    """The caption in the view picker, written into meta.json by export_views
    and read back by the hub as `view name`."""
    for index, (what, name) in enumerate(text_cases(MAX_VIEW_NAME_CHARS)):
        here = build_refuses_view_name(name)
        there = hub_refuses_meta(
            hub, f"viewname{index:02d}",
            views=[{"id": "assembled", "name": name,
                    "file": "assembled.json", "parts": ["lid", "pin"]}])
        assert here == there, DISAGREEMENT.format(
            what=f"as the view name {what}", value=name,
            here="refuses" if here else "accepts",
            there="refuses" if there else "accepts")


def test_the_two_halves_agree_about_a_project_s_title_and_slug(hub, tmp_path):
    """`title` and `project`: the two captions on the index card and in the
    build page header. The gate reads them out of project.json and the hub
    reads them back out of the meta.json the build wrote."""
    for field in ("title", "project"):
        for index, (what, text) in enumerate(text_cases(MAX_TITLE_CHARS)):
            here = build_refuses_project_field(
                tmp_path, f"{field}{index:02d}", **{field: text})
            there = hub_refuses_meta(hub, f"{field}{index:02d}",
                                     **{field: text})
            assert here == there, DISAGREEMENT.format(
                what=f"as the {field} {what}", value=text,
                here="refuses" if here else "accepts",
                there="refuses" if there else "accepts")
