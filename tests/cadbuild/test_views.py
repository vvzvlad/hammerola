"""The view contract, checked before a single triangle is computed.

Everything in here is a rule about the source, so it costs milliseconds and
runs first. The alternative -- and this is what it used to be -- is finding out
after the tessellation, which is the slow half of a build.
"""

import pytest

from src.cadbuild.errors import BuildError
from src.cadbuild.palette import MOCK_COLOR, PART_PALETTE
from src.cadbuild.views import prepare_views, read_parts, visible_names, names_mention

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
    pytest.importorskip("ocp_tessellate",
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
