"""The author's note on a part, on the receiving side.

A note is written by the AUTHOR in model.py, travels with the build in meta.json
and is addressed to whoever opens the model. It is not the READER's note (kept in a
browser's localStorage) and not a COMMENT (written by a viewer into a queue for the
agent, SPEC 7A). It sits inside the catalogue record it is about,
`parts[<key>]["note"]`.

What this file guards is the boundary. `build_meta` rebuilds every record field by
field and drops what it does not read, and a note passed through unchecked would be
a stored-XSS hole on a permanent URL, immutable for a year, sharing an origin with
every other project. The text comes from anybody who can land a commit in a model
repository, so it is held to the rules `title` and a part name are held to.

The last two sections import the build half: `src/cadbuild/views.py` and
`src/cadbuild/project.py` check the same text before the geometry is computed and
may not import this module, so the rules are written twice and this file is the one
place that sees both copies. Four texts cross that boundary and all are paired
here: a note, a part name, a view's caption, and the project's title and slug.
"""

import json

from harness import (DEFAULT_EXPORTS, good_build, meta_bytes, tar_gz,
                     view_bytes)

from src.cadbuild import paths
from src.cadbuild.errors import BuildError
from src.cadbuild.project import MAX_TITLE_CHARS, load_project
from src.cadbuild.hubspec import MAX_NOTE_CHARS, MAX_VIEW_NAME_CHARS, MEMBER_RE
from src.cadbuild.parts import read_catalogue
from src.cadbuild.views import prepare_views
from src.render import MAX_PARTS, MAX_TEXT

# The part-name ceiling below: the build half has no length ceiling of its own (a
# part name is a catalogue key held to `hubspec.MEMBER_RE`, 128 characters), and
# the hub's `render._check_part_name` defers to `_plain_text`, whose ceiling is
# `MAX_TEXT`. So the cases are generated from `MAX_TEXT` directly, not from a local
# alias. What the two sides owe each other there is containment, not equality:
# see test_the_gate_takes_no_part_key_the_hub_would_refuse below.


# THE EXPORT THE CATALOGUE'S ONE PRINTABLE DECLARES — an archive member and a
# pointer in the document at once, because a `printable` declaring no files is
# a 422 (`render._catalogue`). One name whatever the keys are, and
# deliberately so: nothing in this file is about the export, so
# `lid.stl` beside a key spelled `корпус` is a stand-in rather than a claim
# about how a build names what it writes.
PRINTABLE_EXPORT = "lid.stl"
PRINTABLE_EXPORT_BYTES = b"solid lid\nendsolid lid\n"


def publish_notes(hub, notes, commit="abc123"):
    """Push one build whose catalogue carries these notes, keyed by part.

    The view and the view file both name every key: the hub holds a view's
    declared `parts` against the keys its file carries (`render._match_selection`),
    so a stand-in naming the default pair would answer every case with a mismatch
    instead of a verdict about the note.

    The first key is the printable and the rest are hardware: the hub refuses a
    printable with nothing exported, and making them all printable would spend one
    pointer of the file budget per key (test_a_catalogue_bigger_than_the_ceiling_is_refused
    pushes MAX_PARTS through here). `_catalogue` reads `note` independently of
    `kind`, so the kind changes no verdict.
    """
    parts = {}
    for index, (key, note) in enumerate(notes.items()):
        parts[key] = (
            {"kind": "printable", "files": {"stl": PRINTABLE_EXPORT},
             "note": note} if index == 0
            else {"kind": "hardware", "note": note})
    body = tar_gz({"meta.json": meta_bytes(
        parts=parts,
        views=[{"id": "assembled", "name": "assembled",
                "file": "assembled.json", "parts": list(parts)}]),
        "assembled.json": view_bytes(keys=tuple(parts)),
        PRINTABLE_EXPORT: PRINTABLE_EXPORT_BYTES})
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
    """A catalogue that is not a non-empty object is refused.

    `[]`, `""` and `0` matter most: read as `raw.get("parts") or {}`, a falsy
    non-object becomes "no parts at all" and publishes a push that described
    something else. `{}` is refused because a build cannot have written it, and
    accepting it would publish a document `store._usable_meta` then declines to
    list.
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


def test_a_catalogue_record_that_is_not_an_object_is_refused(hub):
    """The map is an object; so is every ROW of it.

    Without the row check in `render._catalogue`, the next line,
    `record.get("kind")`, fails on a string with a 500 instead of a 422, so the
    message is read too.

    THE RECORD BESIDE IT IS A GOOD ONE, and `views` names only that good key,
    which is what keeps `_view_parts` and `_match_selection` out of the way.
    """
    for bad in ("lid.stl", ["lid.stl"], 3, True, []):
        body = tar_gz({
            "meta.json": meta_bytes(
                parts={"lid": {"kind": "printable",
                               "files": {"stl": PRINTABLE_EXPORT}},
                       "pin": bad},
                views=[{"id": "assembled", "name": "assembled",
                        "file": "assembled.json", "parts": ["lid"]}]),
            "assembled.json": view_bytes(keys=("lid",)),
            PRINTABLE_EXPORT: PRINTABLE_EXPORT_BYTES})
        reply = hub.publish("proj1", "abc123", body)
        assert reply.status_code == 422, (bad, reply.text)
        assert (f"part 'pin' is {bad!r}, which is not an object"
                in reply.json()["error"]), (bad, reply.text)
        assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_note_that_is_not_a_string_is_refused(hub):
    for bad in (42, ["M3x8"], {"text": "M3x8"}):
        assert "not a string" in refused(hub, {"lid": bad}), bad


def test_a_note_written_null_is_a_part_with_no_note(hub):
    """A note written `null` is a part with no note.

    Every optional field in `_catalogue` is read `is None`, so `null` is the JSON
    spelling of "no note", the same as leaving the key out. A non-string note still
    never reaches the browser: the key is not emitted, and the served record is
    byte-identical to one from a push that never mentioned a note.
    """
    assert publish_notes(hub, {"lid": None}).status_code == 201
    served = hub.get("/project/proj1/abc123/meta.json").json()["parts"]
    # An EXACT comparison: the record must carry no `note` key at all, not merely
    # a falsy one. It includes the export `publish_notes` declares for the hub to
    # take the push (see PRINTABLE_EXPORT).
    assert served["lid"] == {"kind": "printable",
                             "files": {"stl": PRINTABLE_EXPORT}}


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

    It counts RECORDS, not notes: the second half below carries no note and is
    refused the same, because a hundred thousand bought screws make the same
    unloadable meta.json, served under a year of `immutable`.
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
# this module checks it again on the way in. The build half may not import the
# serving half (it runs inside the build process), so the rules are written
# twice and held together HERE, from the one side allowed to import both. A note
# the build accepts and the hub then refuses is minutes of geometry answered
# with a 422 over a character (`clearance < 0.2 mm` is ordinary CAD prose).
# --------------------------------------------------------------------------

class Shape:
    """The one attribute `cadbuild.geometry.as_shape` looks for.

    tests/cadbuild/fakes.py has a fuller stand-in, but that directory is on
    sys.path only when pytest collects the suite next door, so
    `pytest tests/test_notes.py` alone would not find it. read_catalogue only asks
    whether it was handed a shape.
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

    Whitespace-only text is included, as the last entry before the ceilings: the
    hub sees whatever a hand-made push sends. As a note both halves refuse it (the
    gate because it is empty once stripped, the hub because `render._check_note`
    refuses text that did not arrive stripped); a caption is stripped by neither
    side and a blank title falls back to the directory name, so the other two
    loops answer "accepted by both".

    Padded text with content (` M3x8 `) stays out: its verdicts differ by design
    (the gate publishes `M3x8`, the hub refuses the padded spelling), pinned in
    test_the_hub_refuses_the_padding_the_gate_strips_off.

    Nothing here is empty: this set is read by three loops (a note, a view's
    caption, a title) and an empty string means something different on each, so it
    is pinned per field; the note's answer is
    test_both_halves_refuse_an_empty_note_and_only_the_gate_an_empty_key.
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

    A part's name is a CATALOGUE KEY: the build holds it to `hubspec.MEMBER_RE`
    (128 characters of letters, digits, dot, dash and underscore), the hub to
    `_check_part_name` (200 characters of anything printable without an angle
    bracket). MEMBER_RE is strictly narrower, so a key with a space, a Cyrillic key
    or a 129-character key is refused by the gate and accepted by the hub. That is
    the safe direction; what must never happen is a key the build accepts and the
    hub refuses. The implication is checked through a REAL PUSH;
    tests/cadbuild/test_naming.py compares the two rules as functions.

    The gate can be the narrow one because a key must survive being a FILE STEM
    (`lid.stl`) and a path component. The cases are key-shaped, not `text_cases`:
    MEMBER_RE refuses every free-text entry, so the implication would hold with no
    key ever reaching the hub. The first entries are keys the gate ACCEPTS.
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

    `text_cases` carries nothing empty because an empty string means something
    different for a note, a caption and a title (see its docstring).

    An empty NOTE is refused by both halves. The document's rule is "absent rather
    than empty", so a reader never has two ways of asking whether there is
    something to say about a part; `_check_note` refuses `""` rather than dropping
    it, because dropping it would be the hub editing a document it did not write.
    Only a hand-made push can carry it: `cadbuild.build` writes the key under
    `if record["note"]:`.

    An empty KEY is refused only by the gate: it is a label the viewer's tree
    cannot show and a nested_ok pair cannot point at, fixable in model.py, while
    the hub has a string and no model to judge it against. The gate refusing what
    the hub would take is the safe direction.
    """
    assert build_refuses(name="lid", note="")
    assert hub_refuses(hub, {"lid": ""}, commit="empty01")
    assert build_refuses(name="")
    assert not hub_refuses(hub, {"": "harmless text"}, commit="empty02")


def test_an_empty_files_map_is_refused_exactly_as_an_empty_note_is(hub):
    """The record's OTHER optional field, and the same question asked of it.

    `files` answers the empty spelling like `note`: `{}` is refused rather than
    dropped, since a silent drop would publish a 201 byte-identical to a push that
    never mentioned a file. Neither value can come off a build (`cadbuild.build`
    writes each key only when it has something: `if key in part_files:`,
    `if record["note"]:`), so there is no gate-side verdict to pair with and this
    is one test over two fields rather than an entry in the loops above.

    `preview` is not a third case: `""` is not a file the build declared, so
    `_check_declared_file` refuses it.
    """
    # The note case carries a real `files`: a printable that declares none is
    # refused before the walk reaches `note`, and the wrong message would be
    # asserted.
    for record, fragment in (
            ({"kind": "printable", "files": {}}, "empty `files`"),
            ({"kind": "printable", "files": {"stl": PRINTABLE_EXPORT},
              "note": ""}, "is empty")):
        body = tar_gz({"meta.json": meta_bytes(
            parts={"lid": record},
            views=[{"id": "assembled", "name": "assembled",
                    "file": "assembled.json", "parts": ["lid"]}]),
            "assembled.json": view_bytes(keys=("lid",)),
            PRINTABLE_EXPORT: PRINTABLE_EXPORT_BYTES})
        reply = hub.publish("proj1", "abc123", body)
        assert reply.status_code == 422, reply.text
        assert fragment in reply.json()["error"], record
        assert not (hub.project_dir("proj1") / "abc123").exists()


def test_the_hub_refuses_the_padding_the_gate_strips_off(hub):
    """` M3x8 `: the one input whose two verdicts differ on purpose.

    The gate normalizes and the hub does not: `cadbuild.parts._check_note` returns
    the STRIPPED string, which `cadbuild.build` writes into meta.json, while
    `render._check_note` refuses a note that did not arrive stripped. "Build
    accepts / hub refuses" is safe here only because the build never sends the
    padded string, and the three lines below assert that: what the gate makes of
    it, what the hub does with the padded spelling, and what the hub does with the
    gate's output.

    The hub refuses it because ` M3x8 ` and `M3x8` are one authored note, and two
    spellings would make a byte comparison of revisions report a change nobody
    made; `render._check_note` explains why it refuses instead of stripping.
    """
    padded = " M3x8 "
    catalogue = read_catalogue(Model(
        {"lid": {"shape": Shape(), "kind": "printable", "note": padded}}))
    assert catalogue["lid"]["note"] == padded.strip()
    assert hub_refuses(hub, {"lid": padded}, commit="padded01")
    assert not hub_refuses(hub, {"lid": padded.strip()}, commit="padded02")


def test_a_note_that_is_falsy_and_not_a_string_is_still_refused(hub):
    """`0`, `[]` and `False` are refused as NON-STRINGS, not as empty ones.

    The two verdicts come from two lines in `_check_note`; moving the
    `if not value:` clause above the isinstance check would turn these into
    "empty note", a message about the wrong thing. `null` is absent from this list:
    it is the JSON spelling of "no note" and publishes
    (test_a_note_written_null_is_a_part_with_no_note).
    """
    for bad in (0, [], False):
        assert "not a string" in refused(hub, {"lid": bad}), bad


# --------------------------------------------------------------------------
# The same pairing for the other two texts that cross the boundary
#
# The caption of a view and the project's title and slug travel in the same
# meta.json and are checked there by the same `_plain_text`, so the build-side
# checks must be at least as strict as the hub's (a 201-character view name or a
# title carrying U+202E must not pass the gate).
#
# Angle brackets are the one rule NOT shared here, and that is the hub's
# asymmetry rather than a gap: our own pages write a title, a project name and a
# view name with `textContent`, while the vendored viewer assigns a PART name to
# `innerHTML`. See `cadbuild.views.hub_text_problem`.
# --------------------------------------------------------------------------

def hub_refuses_meta(hub, commit, **fields):
    """Does a real push whose meta.json carries these fields get turned away?"""
    body = tar_gz({"meta.json": meta_bytes(**fields),
                   "assembled.json": view_bytes(),
                   **DEFAULT_EXPORTS})
    reply = hub.publish("proj1", commit, body)
    assert reply.status_code in (201, 422), reply.text
    return reply.status_code == 422


def build_refuses_view_name(name):
    """Does the gate turn away a view captioned this way, before any geometry?

    The view names one catalogue key, and the catalogue is built by
    `read_catalogue`, so `prepare_views` is asked with the shape it is really
    handed at build time.
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
