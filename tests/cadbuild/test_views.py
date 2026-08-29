"""The view contract, checked before a single triangle is computed.

Everything in here is a rule about the source, so it costs milliseconds and
runs first. The alternative -- and this is what it used to be -- is finding out
after the tessellation, which is the slow half of a build.
"""

import pytest

from src import render
from src.cadbuild.errors import BuildError
from src.cadbuild.palette import MOCK_COLOR, PART_PALETTE
from src.cadbuild.views import (MAX_NAME_CHARS, MAX_NOTE_CHARS, MAX_NOTES,
                                collect_notes, prepare_views, read_parts,
                                visible_names, names_mention)

from fakes import part


def one_view(vid="assembled", parts=None, **extra):
    return dict({"id": vid, "parts": parts or []}, **extra)


def test_a_minimal_view_prepares():
    body = part()
    prepared = prepare_views(
        [one_view(parts=[{"shape": body, "name": "body"}])], {"body": body})
    assert len(prepared) == 1
    assert prepared[0]["id"] == "assembled"
    assert prepared[0]["names"] == ["body"]
    assert prepared[0]["file"] == "assembled.json"


def test_views_must_return_a_non_empty_list():
    for bad in ([], (), None, {}):
        with pytest.raises(BuildError) as exc:
            prepare_views(bad, {})
        assert "non-empty list" in str(exc.value)


def test_a_view_with_a_bad_id_is_refused():
    body = part()
    with pytest.raises(BuildError) as exc:
        prepare_views([one_view(vid="with space",
                                parts=[{"shape": body, "name": "body"}])],
                      {"body": body})
    assert "bad id" in str(exc.value)


def test_two_views_may_not_share_an_id():
    body = part()
    entry = [{"shape": body, "name": "body"}]
    with pytest.raises(BuildError) as exc:
        prepare_views([one_view(parts=entry), one_view(parts=entry)], {"body": body})
    assert "duplicate view id" in str(exc.value)


def test_a_view_that_is_not_a_dict_is_refused():
    with pytest.raises(BuildError) as exc:
        prepare_views(["not a view"], {})
    assert "not a dict" in str(exc.value)


def test_a_view_named_meta_would_overwrite_the_hub_s_own_file():
    body = part()
    with pytest.raises(BuildError) as exc:
        prepare_views([one_view(vid="meta", parts=[{"shape": body, "name": "b"}])],
                      {"body": body})
    assert "which the hub owns" in str(exc.value)


# --------------------------------------------------------------------------
# The per-part entries
# --------------------------------------------------------------------------

def test_a_part_needs_a_shape_and_a_name():
    body = part()
    for entry in ({"name": "body"}, {"shape": body}):
        with pytest.raises(BuildError):
            read_parts({"id": "assembled", "parts": [entry]}, "assembled")


def test_two_parts_in_one_view_may_not_share_a_name():
    body, lid = part(), part()
    with pytest.raises(BuildError) as exc:
        read_parts({"id": "assembled",
                    "parts": [{"shape": body, "name": "same"},
                              {"shape": lid, "name": "same"}]}, "assembled")
    assert "same" in str(exc.value)


def test_an_explicit_colour_wins_over_the_palette():
    """A named colour is validated with the tessellator's own parser, so this
    one test needs the CAD stack. Everything else about views does not."""
    # `exc_type=ImportError` because the failure this guard is FOR is an
    # ImportError that is NOT a ModuleNotFoundError: in CI the distribution is
    # on disk and its extension refuses to load (`libGL.so.1`). pytest 9.1
    # narrows the default to ModuleNotFoundError, so without this the guard
    # would stop skipping and CI would go red on a pytest bump — the same trap
    # spelled out in tests/test_view_fixture.py's docstring.
    pytest.importorskip("ocp_tessellate", exc_type=ImportError,
                        reason="colour parsing uses the tessellator's parser")
    body = part()
    prepared = prepare_views(
        [one_view(parts=[{"shape": body, "name": "body", "color": "#ff0000"}])],
        {"body": body})
    assert prepared[0]["colors"] == ["#ff0000"]


def test_an_empty_colour_is_refused_without_reaching_the_parser():
    body = part()
    with pytest.raises(BuildError) as exc:
        read_parts({"id": "assembled",
                    "parts": [{"shape": body, "name": "body", "color": "  "}]},
                   "assembled")
    assert "Leave the key out" in str(exc.value)


def test_a_printable_with_no_colour_gets_a_palette_entry():
    body = part(volume=1000.0, areas=(100.0, 90.0))
    prepared = prepare_views([one_view(parts=[{"shape": body, "name": "body"}])],
                             {"body": body})
    assert prepared[0]["colors"][0] in PART_PALETTE


def test_something_that_is_not_printed_comes_out_grey():
    """The promise of the picture: grey means "not going on the bed"."""
    body = part(volume=1000.0, areas=(100.0, 90.0))
    motor = part(volume=5000.0, areas=(500.0, 400.0))
    prepared = prepare_views(
        [one_view(parts=[{"shape": body, "name": "body"},
                         {"shape": motor, "name": "motor"}])],
        {"body": body})
    assert prepared[0]["colors"][1] == MOCK_COLOR


def test_a_part_with_no_alpha_is_opaque():
    body = part()
    prepared = prepare_views([one_view(parts=[{"shape": body, "name": "body"}])],
                             {"body": body})
    assert prepared[0]["alphas"] == [1.0]


def test_a_nearly_opaque_alpha_is_warned_about_and_still_builds(capsys):
    body = part()
    prepare_views([one_view(parts=[{"shape": body, "name": "body", "alpha": 0.9}])],
                  {"body": body})
    assert "worst value available" in capsys.readouterr().out


def test_an_alpha_of_zero_is_warned_about(capsys):
    body = part()
    prepare_views([one_view(parts=[{"shape": body, "name": "body", "alpha": 0.0}])],
                  {"body": body})
    assert "not drawn at all" in capsys.readouterr().out


def test_a_view_with_nothing_opaque_is_warned_about(capsys):
    body = part()
    prepare_views([one_view(parts=[{"shape": body, "name": "body", "alpha": 0.5}])],
                  {"body": body})
    assert "no fully opaque part" in capsys.readouterr().out


def test_an_unknown_part_key_is_said_out_loud(capsys):
    """The part-level twin of the view-level warning below it.

    A misspelt `alfa` leaves the part opaque and used to say nothing at all,
    which is the same failure as a misspelt `nestedok`: the author reads a green
    build as agreement. It is a warning rather than an error for the reason
    written where it is printed -- this contract is shared by every project in
    the organisation, and a key somebody added for their own tooling must not
    turn into a red build.
    """
    body = part()
    prepare_views([one_view(parts=[{"shape": body, "name": "body",
                                    "alfa": 0.5, "notes": "typo"}])],
                  {"body": body})
    printed = capsys.readouterr().out
    assert "'alfa'" in printed
    assert "'notes'" in printed
    # ...and it lists the known ones, so the misspelling is VISIBLE rather than
    # merely reported. Written out rather than joined from PART_KEYS, which
    # would agree with itself: this line is the per-part contract, and a key
    # added to it is a change to what every model in the fleet may write.
    assert "Known keys: alpha, color, name, note, shape" in printed


def test_an_unknown_view_key_is_said_out_loud(capsys):
    """A misspelt `nestedok` used to be an exemption that was not there."""
    body = part()
    prepare_views([one_view(parts=[{"shape": body, "name": "body"}],
                            nestedok=[("a", "b")])], {"body": body})
    assert "'nestedok'" in capsys.readouterr().out


def test_nested_ok_outside_the_print_view_is_said_out_loud(capsys):
    body, lid = part(), part()
    prepare_views([one_view(parts=[{"shape": body, "name": "body"},
                                   {"shape": lid, "name": "lid"}],
                            nested_ok=[("body", "lid")])], {"body": body})
    assert "only the 'print' view is checked against" in capsys.readouterr().out


def test_nested_ok_naming_a_part_that_is_not_in_the_view_is_refused():
    body = part()
    with pytest.raises(BuildError):
        prepare_views([one_view(vid="print",
                                parts=[{"shape": body, "name": "body"}],
                                nested_ok=[("body", "ghost")])], {"body": body})


# --------------------------------------------------------------------------
# The author's note (SPEC 8, entry 11)
#
# Not the reader's note (that one lives in a browser's localStorage and never
# leaves it) and not a comment (written by a viewer, addressed to the agent).
# This one is written HERE, in the model, and travels with the build.
# --------------------------------------------------------------------------

def test_a_note_is_kept_against_the_part_name():
    body, lid = part(), part()
    prepared = prepare_views(
        [one_view(parts=[{"shape": body, "name": "body"},
                         {"shape": lid, "name": "lid",
                          "note": "  M3x8 DIN912  "}])],
        {"body": body})
    # Stripped, and keyed by NAME -- which is what survives a rebuild, and what
    # meta.json can carry (the per-part dicts themselves do not).
    assert prepared[0]["notes"] == {"lid": "M3x8 DIN912"}
    # A part that said nothing carries no entry at all, rather than an empty one.
    assert collect_notes(prepared) == {"lid": "M3x8 DIN912"}


def test_a_model_with_nothing_to_say_collects_no_notes():
    body = part()
    prepared = prepare_views([one_view(parts=[{"shape": body, "name": "body"}])],
                             {"body": body})
    assert collect_notes(prepared) == {}


def test_a_note_that_is_not_a_string_is_refused():
    """str() would invent a sentence nobody wrote -- the `name` lesson again."""
    body = part()
    for bad in (42, ["M3x8"], {"text": "M3x8"}):
        with pytest.raises(BuildError) as exc:
            read_parts({"id": "assembled",
                        "parts": [{"shape": body, "name": "body", "note": bad}]},
                       "assembled")
        assert "not a string" in str(exc.value)


def test_an_empty_note_is_refused_rather_than_dropped():
    """A part with nothing to say leaves the key out; an empty string is a
    sentence that was started and not finished, and dropping it in silence is
    how the author never learns which."""
    body = part()
    for bad in ("", "   ", "\t"):
        with pytest.raises(BuildError) as exc:
            read_parts({"id": "assembled",
                        "parts": [{"shape": body, "name": "body", "note": bad}]},
                       "assembled")
        assert "empty" in str(exc.value)


def test_a_note_longer_than_the_hub_accepts_is_refused_here():
    body = part()
    with pytest.raises(BuildError) as exc:
        read_parts({"id": "assembled",
                    "parts": [{"shape": body, "name": "body",
                               "note": "x" * (MAX_NOTE_CHARS + 1)}]},
                   "assembled")
    message = str(exc.value)
    assert str(MAX_NOTE_CHARS) in message and str(MAX_NOTE_CHARS + 1) in message


def note_refusal(note):
    """The message this note is refused with, here on the build side."""
    body = part()
    with pytest.raises(BuildError) as exc:
        read_parts({"id": "assembled",
                    "parts": [{"shape": body, "name": "body", "note": note}]},
                   "assembled")
    return str(exc.value)


def name_refusal(name):
    """The message this part NAME is refused with, here on the build side."""
    body = part()
    with pytest.raises(BuildError) as exc:
        read_parts({"id": "assembled", "parts": [{"shape": body, "name": name}]},
                   "assembled")
    return str(exc.value)


def test_a_note_carrying_an_angle_bracket_is_refused_here():
    """`clearance < 0.2 mm` is ordinary CAD prose and the hub refuses it, so a
    build that accepted it would be minutes of geometry spent on a 422."""
    assert "angle bracket" in note_refusal("clearance < 0.2 mm")
    assert "angle bracket" in note_refusal("see <a href=/>the datasheet</a>")


def test_a_note_carrying_a_non_printable_character_is_refused_here():
    # U+202E RIGHT-TO-LEFT OVERRIDE is the one worth naming: it passes a naive
    # "is this printable" check and reverses the text around it.
    assert "non-printable" in note_refusal("M3x8‮gnitset")
    assert "non-printable" in note_refusal("first line\nsecond line")
    assert "non-printable" in note_refusal("M3x8\x00DIN912")


def test_a_part_name_carrying_an_angle_bracket_is_refused_here():
    """The name is the KEY the note is stored under and the label in the view
    file, and the hub holds both to the stricter part-name rule."""
    assert "angle bracket" in name_refusal("<img src=x onerror=alert(1)>")


def test_a_part_name_carrying_a_non_printable_character_is_refused_here():
    assert "non-printable" in name_refusal("body\ttop")
    assert "non-printable" in name_refusal("lid‮")


def test_a_part_name_longer_than_the_hub_accepts_is_refused_here():
    message = name_refusal("x" * (MAX_NAME_CHARS + 1))
    assert str(MAX_NAME_CHARS) in message and str(MAX_NAME_CHARS + 1) in message
    # The last legal length is still a name, so the ceiling is a ceiling rather
    # than an off-by-one nothing can get through.
    names = read_parts(
        {"id": "assembled",
         "parts": [{"shape": part(), "name": "x" * MAX_NAME_CHARS}]},
        "assembled")[1]
    assert names == ["x" * MAX_NAME_CHARS]


def test_the_same_part_may_carry_the_same_note_in_two_views():
    """A part appears in several views -- that is how one is followed from
    `assembled` to `print` -- and the note belongs to the part."""
    body = part()
    entry = {"shape": body, "name": "body", "note": "PETG, 4 walls"}
    prepared = prepare_views([one_view(vid="assembled", parts=[dict(entry)]),
                              one_view(vid="print", parts=[dict(entry)])],
                             {"body": body})
    assert collect_notes(prepared) == {"body": "PETG, 4 walls"}


def test_two_different_notes_under_one_name_are_refused_naming_both_views():
    """meta.json has ONE slot per name, so silent last-wins would show one
    view's sentence next to the part the other one was written about."""
    body = part()
    with pytest.raises(BuildError) as exc:
        prepare_views(
            [one_view(vid="assembled",
                      parts=[{"shape": body, "name": "body", "note": "PETG"}]),
             one_view(vid="print",
                      parts=[{"shape": body, "name": "body", "note": "PLA"}])],
            {"body": body})
    message = str(exc.value)
    assert "'assembled'" in message and "'print'" in message
    assert "PETG" in message and "PLA" in message


def test_more_notes_than_the_hub_accepts_are_refused():
    """The count ceiling, checked against `collect_notes` directly: it is a
    property of the whole model, not of any one view."""
    prepared = [{"id": "assembled",
                 "notes": {f"part {i}": "x" for i in range(MAX_NOTES + 1)}}]
    with pytest.raises(BuildError) as exc:
        collect_notes(prepared)
    assert str(MAX_NOTES) in str(exc.value)


def test_the_note_ceilings_are_at_or_under_the_hub_s():
    """A note the build accepts must never be one the hub then refuses.

    The hub checks every note again on the way in, and its answer is a 422 on a
    push whose build already ran: minutes of geometry spent to be told the text
    was two characters too long. The two numbers are written in two files that
    do not import each other -- the build half may not import the serving half
    -- so this comparison is the only thing holding them together.
    """
    assert MAX_NOTE_CHARS <= render.MAX_TEXT
    assert MAX_NOTES <= render.MAX_NOTES
    # The part name goes the same way, under the hub's free-text ceiling: it is
    # the key of a note in meta.json and the label in every view file, and
    # `render._check_part_name` measures both against MAX_TEXT.
    assert MAX_NAME_CHARS <= render.MAX_TEXT


# --------------------------------------------------------------------------
# The retired parallel-list form
# --------------------------------------------------------------------------

def test_the_legacy_parallel_list_form_is_refused():
    body, lid = part(), part()
    with pytest.raises(BuildError) as exc:
        prepare_views([{"id": "assembled", "objects": [body, lid],
                        "names": ["body", "lid"]}], {"body": body})
    message = str(exc.value)
    assert "objects" in message
    assert '"parts"' in message or "parts" in message


def test_the_refusal_prints_the_view_rewritten():
    """The message is the migration: it prints the same view in the new form."""
    body, lid = part(), part()
    with pytest.raises(BuildError) as exc:
        prepare_views([{"id": "assembled", "objects": [body, lid],
                        "names": ["body", "lid"], "alphas": [1.0, 0.6]}],
                      {"body": body})
    message = str(exc.value)
    assert '"shape"' in message
    assert '"name": "body"' in message
    assert "0.6" in message


def test_a_half_converted_view_is_refused_too():
    """`parts` next to a leftover `colors` is exactly the state that bites."""
    body = part()
    with pytest.raises(BuildError):
        prepare_views([{"id": "assembled",
                        "parts": [{"shape": body, "name": "body"}],
                        "colors": ["#ff0000"]}], {"body": body})


# --------------------------------------------------------------------------
# Names
# --------------------------------------------------------------------------

def test_visible_names_skips_parts_drawn_at_alpha_zero():
    view = {"names": ["body", "ghost"], "alphas": [1.0, 0.0]}
    assert visible_names(view) == ["body"]


def test_names_mention_matches_whole_words_only():
    assert names_mention(["lid blank"], "lid")
    assert names_mention(["body"], "body")
    assert not names_mention(["bodywork"], "body")
    assert not names_mention([], "body")
