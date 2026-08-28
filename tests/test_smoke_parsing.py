"""The gate's two output parsers, tested without docker.

`ci/smoke.py` is the publish gate and normally runs only on the runner, against a built image —
which is why nothing in it was covered here before. `parse_cad_verdicts()` is the exception worth
pulling out: it is a PURE function over a string, it decides whether EVERY CAD target is
reported green or red, and the strings it has to survive are produced by libraries nobody here
controls. OpenCASCADE and VTK print during interpreter finalisation, `docker()` folds stderr into
stdout, so noise lands on both sides of the payload — and a parser that mishandled the trailing
kind failed the whole check on an image that was perfectly fine. Written without a count on
purpose: the number of targets is derived from CAD_IMPORTS and PINS and moves whenever either
list does, and a number spelled out here would be stale by the next import that gets added.

`parse_start_routes()` is here for the same reasons and one of its own: check (h) is the only
probe that makes a REQUEST, so its verdicts are the ones a person reads when the onboarding
routes go dark — and the thing it must never do is read a route the probe said nothing about as
a route that answered. That case has no observable symptom on the runner: the gate would simply
print `ok` about a question it never asked.

TWO OF THE GATE'S CONSTANTS ARE HELD HERE TOO, at the bottom: the routes check (h) asks for
and the port it asks on. They are literals in `ci/smoke.py` because that file imports nothing
from the application — a property of the gate worth keeping — and a literal copy of somebody
else's value drifts by being left alone. What it would cost is a FALSE RED on a healthy image,
which is the expensive direction: a renamed route or a changed default port makes every
onboarding row fail while the artefact is exactly right.

Imported as `ci.smoke` on the strength of `pythonpath = .` in pytest.ini: `ci/` has no
`__init__.py`, and none is needed — python 3 treats it as a namespace package. Importing the
module is safe because everything in it is a definition; `main()` runs from the `__main__` block
only, so nothing here shells out to docker.
"""

import ast
import json
from urllib.parse import urlsplit

from ci.smoke import (CAD_SENTINEL, START_MARK, START_ORIGIN, START_PROBE_SOURCE,
                      START_ROUTES, parse_cad_verdicts, parse_start_routes)
from src import onboarding
from src.settings import Settings

# What a real probe run answers with: the same shape CAD_PROBE_SOURCE builds — one key per
# import, one per pin, None meaning "this one is fine".
VERDICTS = {
    "import:cadquery:": None,
    "pin:cadquery": "the image has 2.7.0 instead",
}
PAYLOAD = json.dumps(VERDICTS)


def test_clean_output_parses():
    """The happy path: sentinel, payload, nothing else."""
    verdicts, problem = parse_cad_verdicts("{}\n{}\n".format(CAD_SENTINEL, PAYLOAD))

    assert problem is None
    assert verdicts == VERDICTS


def test_noise_before_the_sentinel_is_ignored():
    """OCCT and VTK warn on import, and those lines precede the sentinel."""
    output = (
        "Warning: OpenGl_Window::CreateWindow: no display\n"
        "vtkOpenGLRenderWindow: bad X server connection\n"
        "{}\n{}\n".format(CAD_SENTINEL, PAYLOAD))

    verdicts, problem = parse_cad_verdicts(output)

    assert problem is None
    assert verdicts == VERDICTS


def test_noise_after_the_payload_is_ignored():
    """The regression this parser exists for.

    Static destructors in OCCT and VTK run during interpreter finalisation — i.e. after the
    payload has been printed — and `docker()` merges stderr into the same stream. Parsing the
    whole remainder would raise `JSONDecodeError: Extra data` here and fail every CAD target
    over an image with nothing wrong with it.
    """
    output = "{}\n{}\nvtkDebugLeaks: leaked 3 instances of vtkPolyData\n".format(
        CAD_SENTINEL, PAYLOAD)

    verdicts, problem = parse_cad_verdicts(output)

    assert problem is None
    assert verdicts == VERDICTS


def test_sentinel_with_nothing_after_it_is_a_reason_not_an_exception():
    """A truncated run has to come back as a verdict-shaped refusal, never as a traceback.

    An exception out of here unwinds into the `__main__` handler and exits 3 — "the gate is
    broken" — sending whoever reads the run to inspect this file instead of the image that
    actually died mid-probe.
    """
    verdicts, problem = parse_cad_verdicts("some noise\n{}\n\n  \n".format(CAD_SENTINEL))

    assert verdicts is None
    # The reason has to say what happened, not just that something did: it is the whole of what
    # the CAD rows will carry in the log — and it has to distinguish this case from "no
    # sentinel at all", because the two point at different halves of the probe.
    assert "sentinel and then nothing" in problem
    # Blank lines after the sentinel are noise, not a payload: whitespace must not be handed to
    # json.loads and reported as a parse failure, which would name the wrong culprit.
    assert "did not parse as JSON" not in problem


def test_missing_sentinel_is_a_reason_not_an_exception():
    """No sentinel at all means the probe never reported — never an empty pass."""
    verdicts, problem = parse_cad_verdicts("Segmentation fault (core dumped)\n")

    assert verdicts is None
    assert "sentinel" in problem


def test_non_object_payload_is_rejected():
    """A JSON list parses fine and would then be indexed as a mapping by the caller."""
    verdicts, problem = parse_cad_verdicts("{}\n[1, 2, 3]\n".format(CAD_SENTINEL))

    assert verdicts is None
    assert "not an object" in problem


def test_last_sentinel_wins():
    """The probe prints the sentinel once; anything echoing it earlier must not shadow it."""
    output = "{}\n{}\n{}\n{}\n".format(
        CAD_SENTINEL, json.dumps({"import:cadquery:": "stale"}), CAD_SENTINEL, PAYLOAD)

    verdicts, problem = parse_cad_verdicts(output)

    assert problem is None
    assert verdicts == VERDICTS


# -- check (h): the onboarding routes ---------------------------------------------------------
def test_a_route_that_answered_parses_as_a_pass():
    seen = parse_start_routes("{} ok /start/skill.md\n".format(START_MARK))

    assert seen == {"/start/skill.md": None}


def test_a_refused_route_keeps_its_whole_reason():
    """The reason is the only thing the log carries about a dark route, so none of it is lost.

    It arrives on ONE line by construction — the probe collapses newlines before printing —
    and the parser must therefore not stop at the first space in it.
    """
    seen = parse_start_routes(
        "{} bad /start/hammerola the hub answered 404 Not Found\n".format(START_MARK))

    assert seen == {"/start/hammerola": "the hub answered 404 Not Found"}


def test_unmarked_noise_is_dropped_rather_than_read_as_a_verdict():
    """`docker()` folds stderr in, so anything the container writes lands in this stream.

    Read as malformed verdicts, those lines would fail an image with nothing wrong with it;
    read as verdicts about a path, they would report on routes nobody asked about.
    """
    output = (
        "DeprecationWarning: something in urllib\n"
        "{} ok /start/skill.md\n"
        "Exception ignored in: <module 'threading'>\n".format(START_MARK))

    assert parse_start_routes(output) == {"/start/skill.md": None}


def test_a_route_the_probe_never_reported_is_simply_absent():
    """THE ONE THIS PARSER EXISTS FOR.

    "The probe said nothing about this route" is a third answer, and the caller can only give
    it that name if the mapping does not carry the path at all. A parser that defaulted a
    missing route to either verdict would make check (h) print `ok` about a question it never
    asked — which is the gate's own worst failure, and the one no run on the runner shows.
    """
    seen = parse_start_routes("{} ok /start/skill.md\n".format(START_MARK))

    assert set(seen) == {"/start/skill.md"}
    for path in START_ROUTES:
        if path != "/start/skill.md":
            assert path not in seen


def test_a_truncated_verdict_line_is_not_a_verdict():
    """A `bad` line with no reason on it is malformed, and a malformed line is silence.

    Kept because the alternative is worse in both directions: stored with an empty reason it
    would print `FAIL <route> -> ` and say nothing, and stored as a pass it would be a green
    verdict off a line the probe never finished writing.
    """
    assert parse_start_routes("{} bad /start/hammerola\n".format(START_MARK)) == {}


def test_the_probe_the_image_runs_is_valid_python():
    """It is a string here and a program in the container, where nothing can check it.

    `python -c` on a source with a syntax error exits non-zero with a traceback, so the gate
    would report all three onboarding rows as broken — about an image that is fine — and the
    fault would be in this file. Parsing it here is the only place that can be noticed.
    """
    ast.parse(START_PROBE_SOURCE)


# -- what check (h) asks for, against what the hub serves -------------------------------------
# BOTH OF THESE FAIL THE SAME WAY WHEN THEY DRIFT: a FALSE RED on a healthy image, which is the
# expensive kind. The gate holds its own literals — `ci/smoke.py` imports nothing from the
# application and needs none of its dependencies, and that is a property of the gate worth
# keeping — so the comparison lives here, exactly as REQUIRED_VARIABLES is compared against
# Settings in tests/test_settings.py and REQUIRED_PATHS against the Dockerfile in
# tests/test_ui_bundle.py.
def test_the_gate_asks_for_the_routes_this_hub_really_serves():
    """A renamed route would make all three rows red about an image that is fine.

    Compared as a SET: the order the gate asks in is its own business, and pinning it here
    would fail a reordering that changes nothing. `/start` itself is deliberately absent from
    the gate's list — the manifest opens no file and cannot fail the way the three below can —
    so it is asserted absent rather than left to be re-added by whoever reads this as an
    oversight.
    """
    assert set(START_ROUTES) == {onboarding.SKILL_URL, onboarding.CLIENT_URL,
                                 onboarding.TEMPLATE_URL}
    assert onboarding.MANIFEST_URL not in START_ROUTES


def test_the_gate_asks_at_the_port_the_image_listens_on():
    """A changed default port would do the same, and from further away.

    Only the PORT is compared. The host is not: `Settings.host` is 0.0.0.0, the address the hub
    BINDS, while the gate asks on 127.0.0.1 — the container's own loopback, reached by
    `docker exec` — and those two are correctly different strings. SMOKE_ENV sets neither
    variable, so the default is what the container really runs with.
    """
    port = urlsplit(START_ORIGIN).port
    assert port == Settings.model_fields["port"].default, (
        f"check (h) asks on port {port} and the image listens on "
        f"{Settings.model_fields['port'].default}")
