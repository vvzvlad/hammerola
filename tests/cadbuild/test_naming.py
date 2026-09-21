"""The catalogue, and the rules about strings that run before any geometry.

Every one of these is knowable from the source alone. They used to be applied
inside the export loop, so a name two characters over the hub's limit went red
only after every part ahead of it had been built, exported and meshed -- a whole
build spent arriving at an answer that was in model.py all along.
"""

import pytest

from src import render
from src.cadbuild.errors import BuildError
from src.cadbuild.hubspec import (MAX_NOTE_CHARS, MAX_PARTS,
                                  MAX_VIEW_DEPTH, MAX_VIEW_NAME_CHARS,
                                  MEMBER_RE, RESERVED_NAMES, hub_text_problem)
from src.cadbuild.palette import HARDWARE_COLOR, MOCK_COLOR, PART_PALETTE
from src.cadbuild.parts import (KINDS, catalogue_colors, check_stem,
                                printable_keys, read_catalogue)
from src.cadbuild.project import MAX_TITLE_CHARS

from fakes import part


class Model:
    """The two functions the build asks a model.py for."""

    def __init__(self, catalogue, views=()):
        self._catalogue = catalogue
        self._views = list(views)

    def parts(self):
        return self._catalogue

    def views(self):
        return self._views


def entry(kind="printable", **extra):
    return dict({"shape": part(), "kind": kind}, **extra)


def refusal(catalogue):
    """The message this catalogue is refused with."""
    with pytest.raises(BuildError) as exc:
        read_catalogue(Model(catalogue))
    return str(exc.value)


# --------------------------------------------------------------------------
# The rules the hub owns, transcribed
# --------------------------------------------------------------------------

def test_member_rule_matches_the_hub_spec():
    assert MEMBER_RE.match("body.stl")
    assert MEMBER_RE.match("a" * 128)
    assert not MEMBER_RE.match("a" * 129)
    assert not MEMBER_RE.match(".hidden")
    assert not MEMBER_RE.match("with space")
    assert not MEMBER_RE.match("dir/file")
    assert not MEMBER_RE.match("")


def test_reserved_names_cover_everything_the_build_writes_itself():
    assert RESERVED_NAMES == {"meta.json", "index.html", "metrics.json"}


def test_every_name_this_accepts_the_hub_accepts_too():
    """Why hubspec carries no part-name ceiling of its own any more.

    A part's name in a view file is a catalogue key (or a group name, held to
    the same rule), and MEMBER_RE is strictly narrower than the hub's
    `_check_part_name`: 128 characters against 200, and an alphabet with no
    angle bracket, no control character and no space in it. A second ceiling
    here would be dead text that still reads like a working check -- so the
    containment is asserted instead of described.
    """
    for name in ("body", "a" * 128, "lid.v2", "left-front_bracket", "0"):
        assert MEMBER_RE.match(name)
        render._check_part_name(name, "a part")
    # ...and the containment is not vacuous: the hub really does accept things
    # this refuses, which is why one of the two rules has to be the narrow one.
    render._check_part_name("with space", "a part")
    assert not MEMBER_RE.match("with space")


def test_every_text_ceiling_here_equals_the_hub_s():
    """The numbers this half copies from the hub, held to EQUALITY.

    A build ceiling ABOVE the hub's is the bug the pair exists to prevent: the
    hub checks the same text again on the way in and answers 422 on a push
    whose build already ran, so minutes of geometry are spent to be told the
    text was two characters too long. A ceiling BELOW it refuses a model for a
    rule that does not exist. Equality is the contract; one-sided strictness is
    allowed only as a NAMED exception written where it is made (tests/
    test_notes.py carries the one there is).

    The numbers are written in files that do not import each other -- the build
    half may not import the serving half -- so this is the only thing holding
    them together.
    """
    assert MAX_NOTE_CHARS == render.MAX_TEXT
    # How big the catalogue may be. It was `MAX_NOTES` on both sides and it
    # counted the parts carrying a note; what makes meta.json enormous is the
    # number of RECORDS, so the ceiling and both its names moved to that
    # (issue #75).
    assert MAX_PARTS == render.MAX_PARTS
    # The view's caption reaches the hub through meta.json's `views`, and the
    # project's title and slug through `title` and `project`. All three are
    # `_plain_text` on the far side.
    assert MAX_VIEW_NAME_CHARS == render.MAX_TEXT
    assert MAX_TITLE_CHARS == render.MAX_TEXT
    # How deep a view file's part tree may nest. This one is not about a string
    # at all, but it is the same trade: the hub walks the tree and refuses one
    # deeper than this, so a build that emitted one would be a 422.
    assert MAX_VIEW_DEPTH == render.MAX_VIEW_DEPTH


def test_the_three_kinds_are_the_three_the_hub_publishes():
    """What a record may say a part IS, held to EQUALITY across the wire.

    The hub transcribes this list (`render.PART_KINDS`) and refuses a kind that
    is not on it, because the browser draws a record by its kind and one nothing
    recognises is a part nobody can draw. Equality rather than containment, and
    both directions cost something real: a kind this half invents is a whole
    build answered with a 422, and a kind the hub would take that no build emits
    is a case on the serving side that nothing produces.
    """
    assert set(KINDS) == set(render.PART_KINDS)
    # ...and the one the rest of the document is keyed off: only a printable
    # ships files, on both sides of the wire.
    assert render.KIND_PRINTABLE in KINDS


def test_hub_text_problem_answers_a_non_string_rather_than_crashing():
    """The first line of the transcription, and the one with no caller today.

    Every call site checks the type before it gets here. `len()` is perfectly
    happy with a list, so without that line the walk reaches
    `unicodedata.category(<element of it>)` and raises a bare TypeError out of a
    build: the gate crashes where it was supposed to tell the author which field
    is wrong. The hub's own `_check_part_name` opens with the same isinstance.
    """
    assert "not a string" in hub_text_problem(["body"], MAX_NOTE_CHARS)
    assert "not a string" in hub_text_problem(42, MAX_NOTE_CHARS)
    assert "not a string" in hub_text_problem(None, MAX_NOTE_CHARS)
    # ...and it is answered the same way whichever rule set the caller asked
    # for: a non-string has no characters to hold to either of them.
    assert "not a string" in hub_text_problem(42, MAX_NOTE_CHARS,
                                              angle_brackets_ok=True)


# --------------------------------------------------------------------------
# What a catalogue is
# --------------------------------------------------------------------------

def test_a_minimal_catalogue_reads():
    read = read_catalogue(Model({"body": entry()}))
    assert list(read) == ["body"]
    assert read["body"]["kind"] == "printable"
    # Normalised to the same four keys whatever the entry left out, so nothing
    # downstream has to ask whether a key is there.
    assert set(read["body"]) == {"shape", "kind", "color", "note"}
    assert read["body"]["color"] is None and read["body"]["note"] is None


def test_parts_must_return_a_non_empty_dict():
    for bad in ({}, [], None, "body"):
        assert "non-empty dict" in refusal(bad)


def test_the_order_of_the_catalogue_is_kept():
    """Everything downstream walks this dict, so a reordering would change the
    log of a model nobody edited."""
    read = read_catalogue(Model({"c": entry(), "a": entry(), "b": entry()}))
    assert list(read) == ["c", "a", "b"]


def test_a_key_that_is_not_a_filename_stem_is_refused():
    assert "not usable as a filename stem" in refusal({"my part": entry()})


def test_a_key_that_is_not_a_string_is_refused():
    """str() would invent a name nobody wrote and then export a file under it."""
    assert "not a string" in refusal({42: entry()})


def test_a_part_called_assembled_collides_with_the_build_output():
    message = refusal({"assembled": entry()})
    assert "'assembled' is reserved" in message
    assert "assembled.stl" in message
    assert "the glued-together assembly" in message


def test_a_part_called_print_collides_with_the_plate():
    """Same reservation as `assembled`, and a worse one to leave open.

    On a project that HAS a `print` view the part would be exported to
    print.stl by the loop, the plate would overwrite that file afterwards, and
    the hub would hash what was left -- so the published print.stl would be the
    bed under the part's own name, with nothing anywhere reporting it.

    The refusal itself is unconditional and does not promise that file: a
    project with no `print` view writes no plate, and `print` is an entirely
    ordinary name for a single printed part, so this is the likelier of the two
    refusals to be read by somebody who has done nothing wrong.
    """
    message = refusal({"print": entry()})
    assert "'print' is reserved" in message
    assert "print.stl" in message
    assert "the print plate" in message
    assert "collides with" not in message


def test_the_reservation_applies_to_every_kind():
    """The key is a node name in every view file and a key in meta.json, so it
    would read as the build's own artefact whether or not anything is exported
    for it -- and the day somebody changes its kind, the collision is real."""
    assert "reserved" in refusal({"assembled": entry("mock"),
                                  "body": entry()})


def test_an_entry_that_is_not_a_dict_is_refused():
    assert "not a dict" in refusal({"body": part()})


def test_an_entry_with_no_shape_is_refused():
    assert "nothing to build" in refusal({"body": {"kind": "printable"}})


def test_something_that_is_not_geometry_is_refused_by_name():
    assert "expected a CadQuery object" in refusal(
        {"body": {"shape": "not a solid", "kind": "printable"}})


# --------------------------------------------------------------------------
# The kind
# --------------------------------------------------------------------------

def test_an_entry_with_no_kind_is_refused():
    """No default, on purpose: `printable` would export a bought bearing and put
    a download button under it."""
    message = refusal({"body": {"shape": part()}})
    assert 'has no "kind"' in message
    assert "'printable'" in message and "'hardware'" in message
    assert "'mock'" in message


def test_an_unknown_kind_is_refused_and_the_three_are_named():
    message = refusal({"body": entry("bought")})
    assert "'bought'" in message
    assert "'printable'" in message and "'hardware'" in message
    assert "'mock'" in message


def test_a_catalogue_with_nothing_to_print_is_refused():
    """A model project exists to produce a part."""
    message = refusal({"screw": entry("hardware"), "wall": entry("mock")})
    assert "nothing to print" in message


def test_printable_keys_are_the_printable_ones_in_order():
    read = read_catalogue(Model({"lid": entry(), "screw": entry("hardware"),
                                 "base": entry()}))
    assert printable_keys(read) == ["lid", "base"]


def test_an_unknown_record_key_is_said_out_loud(capsys):
    """A misspelt "colour" leaves the part painted by the palette and would
    otherwise say nothing at all. A warning rather than an error, because this
    contract is shared by every project in the organisation."""
    read_catalogue(Model({"body": entry(colour="#ff0000", qty=4)}))
    printed = capsys.readouterr().out
    assert "'colour'" in printed and "'qty'" in printed
    assert "Known keys: color, kind, note, shape" in printed


# --------------------------------------------------------------------------
# The author's note (issue #11)
#
# Not the reader's note (that one lives in a browser's localStorage and never
# leaves it) and not a comment (written by a viewer, addressed to the agent).
# This one is written HERE, in the model, and travels with the build.
# --------------------------------------------------------------------------

def test_a_note_is_kept_against_the_part_stripped():
    read = read_catalogue(Model({"body": entry(note="  M3x8 DIN912  ")}))
    assert read["body"]["note"] == "M3x8 DIN912"


def test_a_note_that_is_not_a_string_is_refused():
    """str() would invent a sentence nobody wrote."""
    for bad in (42, ["M3x8"], {"text": "M3x8"}):
        assert "not a string" in refusal({"body": entry(note=bad)})


def test_an_empty_note_is_refused_rather_than_dropped():
    """A part with nothing to say leaves the key out; an empty string is a
    sentence that was started and not finished, and dropping it in silence is
    how the author never learns which."""
    for bad in ("", "   ", "\t"):
        assert "empty" in refusal({"body": entry(note=bad)})


def test_a_note_longer_than_the_hub_accepts_is_refused_here():
    message = refusal({"body": entry(note="x" * (MAX_NOTE_CHARS + 1))})
    assert str(MAX_NOTE_CHARS) in message and str(MAX_NOTE_CHARS + 1) in message


def test_a_note_carrying_an_angle_bracket_is_refused_here():
    """`clearance < 0.2 mm` is ordinary CAD prose and the hub refuses it, so a
    build that accepted it would be minutes of geometry spent on a 422."""
    assert "angle bracket" in refusal({"body": entry(note="clearance < 0.2 mm")})
    assert "angle bracket" in refusal(
        {"body": entry(note="see <a href=/>the datasheet</a>")})


def test_a_note_carrying_a_non_printable_character_is_refused_here():
    # U+202E RIGHT-TO-LEFT OVERRIDE is the one worth naming: it passes a naive
    # "is this printable" check and reverses the text around it.
    assert "non-printable" in refusal({"body": entry(note="M3x8‮gnitset")})
    assert "non-printable" in refusal({"body": entry(note="one\ntwo")})
    assert "non-printable" in refusal({"body": entry(note="M3x8\x00DIN912")})


def test_a_catalogue_bigger_than_the_hub_accepts_is_refused():
    """The COUNT of records, which is what really decides meta.json's size.

    It used to count the parts carrying a NOTE, and the case below is the one
    that ceiling could not see: not one of these entries has a note, and the
    document they make is just as unloadable. The hub refuses it on arrival
    (`render.MAX_PARTS`), so a build that accepted it would be a whole model
    computed and then answered with a 422.
    """
    assert str(MAX_PARTS) in refusal(
        {f"part{i}": entry() for i in range(MAX_PARTS + 1)})
    # ...and the last legal size is legal, so this is a ceiling rather than an
    # off-by-one nobody can reach.
    read = read_catalogue(Model({f"part{i}": entry() for i in range(MAX_PARTS)}))
    assert len(read) == MAX_PARTS


# --------------------------------------------------------------------------
# Colour
# --------------------------------------------------------------------------

def test_a_printable_gets_a_palette_entry():
    read = read_catalogue(Model({"body": entry()}))
    assert catalogue_colors(read)["body"] in PART_PALETTE


def test_a_mock_is_grey_and_hardware_is_the_dark_grey():
    """The promise of the picture: at a glance, what is printed, what is bought
    and what is only there so the picture makes sense."""
    read = read_catalogue(Model({"body": entry(), "wall": entry("mock"),
                                 "screw": entry("hardware")}))
    colors = catalogue_colors(read)
    assert colors["wall"] == MOCK_COLOR
    assert colors["screw"] == HARDWARE_COLOR
    assert colors["body"] in PART_PALETTE


def test_an_explicit_colour_wins_for_every_kind_and_comes_back_as_hex():
    """A named colour is validated with the tessellator's own parser, so this
    one test needs the CAD stack. Everything else about the catalogue does not.

    WHAT COMES BACK IS THE PARSER'S SPELLING, which is why neither colour is
    written here the way it comes out. The parser takes a CSS name and a
    three-digit hex; the rasteriser that draws the previews reads exactly six
    hex digits, so a catalogue that handed on the author's own string put
    `"red"` in front of `preview_png._hex_rgb` and killed the build inside the
    picture of a part that was perfectly fine.
    """
    # `exc_type=ImportError` because the failure this guard is FOR is an
    # ImportError that is NOT a ModuleNotFoundError: on a machine whose kernel is
    # installed but cannot load, the distribution is on disk and its extension
    # refuses to load (`libGL.so.1`). pytest 9.1 narrows the default to
    # ModuleNotFoundError, so without this the guard would stop skipping and that
    # machine would go red on a pytest bump.
    pytest.importorskip("ocp_tessellate", exc_type=ImportError,
                        reason="colour parsing uses the tessellator's parser")
    read = read_catalogue(Model({"body": entry(color="red"),
                                 "wall": entry("mock", color="#0f0")}))
    colors = catalogue_colors(read)
    assert colors["body"] == "#ff0000"
    # "Do not colour a mock" is a rule of the SKILL and deliberately not of this
    # build: an author who has a reason to paint one is not wrong.
    assert colors["wall"] == "#00ff00"


def test_an_empty_colour_is_refused_without_reaching_the_parser():
    assert "Leave the key out" in refusal({"body": entry(color="  ")})


# --------------------------------------------------------------------------
# The stems the build keeps for itself
# --------------------------------------------------------------------------

def test_check_stem_names_the_rename_that_could_reach_it():
    """Every catalogue key passed MEMBER_RE already, so what this catches is a
    rename of one of the build's own constants -- which would otherwise reach
    the hub as an opaque 422 with the build reporting success."""
    with pytest.raises(BuildError) as exc:
        check_stem("not a stem", "the mesh")
    message = str(exc.value)
    assert "cadbuild.artifacts" in message
    assert "ASSEMBLED_STEM" in message and "PRINT_VIEW_ID" in message


def test_check_stem_hands_a_good_stem_back():
    assert check_stem("assembled", "the mesh assembled.stl") == "assembled"
