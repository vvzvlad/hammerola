"""The gate's output parsers, tested without docker.

`ci/smoke.py` is the publish gate and normally runs only on the runner, against a
built image. `parse_cad_verdicts()` is a PURE function over a string that decides
whether every CAD target is reported green or red, over output from libraries
nobody here controls: OpenCASCADE and VTK print during interpreter finalisation and
`docker()` folds stderr into stdout, so noise lands on both sides of the payload.
The number of targets is not spelled out: it derives from CAD_IMPORTS and PINS.

`parse_marked_verdicts()` is what checks (h), (i) and (j) read their answers with, and
it must never read a key the probe said nothing about as a key that answered (the
gate would print `ok` about a question it never asked). It is exercised through
`parse_start_routes()`, which binds check (h)'s mark, and separately with check
(i)'s mark.

The gate's copies of the hub's constants are held here too, at the bottom: the
routes check (h) asks for and the port it asks on, and check (j)'s token header,
git route and hook directory. They are literals in `ci/smoke.py` because that
file imports nothing from the application, and a drifted copy would be a FALSE RED
on a healthy image.

Imported as `ci.smoke` on the strength of `pythonpath = .` in pytest.ini: `ci/` has
no `__init__.py` and python 3 treats it as a namespace package. Importing the module
is safe: `main()` runs from the `__main__` block only, so nothing here shells out
to docker.
"""

import ast
import json
from urllib.parse import urlsplit

from ci.smoke import (BUILD_MARK, BUILD_PROBE_SOURCE, BUILD_TARGETS, CAD_SENTINEL,
                      EXPECTED_TARGETS, GIT_HOOK, GIT_MARK, GIT_PROBE_SOURCE,
                      GIT_TARGETS, GIT_URL, SKILL_ARCHIVE_KEY, SKILL_ENTRY, SKILL_URL,
                      START_MARK, START_ORIGIN, START_PROBE_SOURCE,
                      START_ROUTES, TOKEN_HEADER, parse_cad_verdicts,
                      parse_marked_verdicts, parse_start_routes)
from src import app, githttp, onboarding
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
    """Noise after the payload is ignored.

    Static destructors in OCCT and VTK run during interpreter finalisation, after
    the payload is printed, and `docker()` merges stderr into the same stream.
    Parsing the whole remainder would raise `JSONDecodeError: Extra data` and fail
    every CAD target on a healthy image.
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
    seen = parse_start_routes("{} ok /start/skill.tar.gz\n".format(START_MARK))

    assert seen == {"/start/skill.tar.gz": None}


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
        "{} ok /start/skill.tar.gz\n"
        "Exception ignored in: <module 'threading'>\n".format(START_MARK))

    assert parse_start_routes(output) == {"/start/skill.tar.gz": None}


def test_a_route_the_probe_never_reported_is_simply_absent():
    """THE ONE THIS PARSER EXISTS FOR.

    "The probe said nothing about this route" is a third answer, and the caller can only give
    it that name if the mapping does not carry the path at all. A parser that defaulted a
    missing route to either verdict would make check (h) print `ok` about a question it never
    asked — which is the gate's own worst failure, and the one no run on the runner shows.
    """
    seen = parse_start_routes("{} ok /start/skill.tar.gz\n".format(START_MARK))

    assert set(seen) == {"/start/skill.tar.gz"}
    for path in START_ROUTES:
        if path != "/start/skill.tar.gz":
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
    the gate's list — the files the manifest opens are the skill's, which the archive route
    opens too — so it is asserted absent rather than left to be re-added by whoever reads this
    as an oversight.
    """
    assert set(START_ROUTES) == {onboarding.SKILL_URL, onboarding.CLIENT_URL,
                                 onboarding.TEMPLATE_URL}
    assert onboarding.MANIFEST_URL not in START_ROUTES


def test_the_gate_opens_the_skill_archive_by_the_hubs_own_names():
    """The archive row asks two more strings of the hub, and each is a copy.

    A drifted one fails the same expensive way as a renamed route: the gate
    reports a healthy image's skill as broken (a wrong path or entry name).
    """
    assert SKILL_URL == onboarding.SKILL_URL
    assert SKILL_ENTRY == onboarding.SKILL_ENTRY


def test_the_onboarding_probe_reports_the_archive_row_the_gate_declares():
    """The key crosses a process boundary as JSON, exactly as check (i)'s do.

    A key renamed on one side only comes back as "the probe returned no verdict
    for the skill archive" — a red gate over an image with nothing wrong.
    """
    assert '"{}"'.format(SKILL_ARCHIVE_KEY) not in START_PROBE_SOURCE, (
        "the probe spells the key itself instead of reading it out of the "
        "request, so the two can drift without anything saying so")
    assert 'report(request["skill_key"]' in START_PROBE_SOURCE


def test_the_gate_declares_a_row_for_every_route_plus_the_archive():
    """(h)'s declared count is what catches a probe that quietly stops probing."""
    declared = dict(EXPECTED_TARGETS)["(h) onboarding routes"]
    assert declared == len(START_ROUTES) + 1


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


# -- check (i): the build wrapper and the ceilings it puts on ---------------------------------
def probe_constant(source, name):
    """One top-level string constant out of a probe's source, as the container would see it.

    The probe is a string in `ci/smoke.py` and a program in the container, and the one below is
    a string INSIDE that string — so reading it back out of the parse tree is the only way to
    get at the text the innermost interpreter is really handed.
    """
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == name for target in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError(f"the probe has no top-level {name} to read")


def test_the_build_probe_the_image_runs_is_valid_python():
    """Same reason as check (h)'s: a syntax error here is a red gate about a healthy image."""
    ast.parse(BUILD_PROBE_SOURCE)


def test_the_program_the_build_probe_fences_is_valid_python():
    """The innermost program — a string inside the probe, run on the far side of the execv.

    Nothing else can look at it. A syntax error there makes the fenced process die without
    printing its ceilings, which the probe reports as "the fenced process did not report the
    ceilings it runs under" — i.e. as a finding about the IMAGE, for a fault in this repository.
    """
    ast.parse(probe_constant(BUILD_PROBE_SOURCE, "READBACK"))


def test_the_build_probe_answers_every_question_the_gate_declares():
    """The keys are written twice — once in BUILD_TARGETS, once in the probe's report() calls.

    They cross a process boundary as a JSON list, so nothing can reconcile them at runtime: a
    key renamed on one side only comes back as "the probe returned no verdict for this one",
    which is a red gate over an image with nothing wrong with it.
    """
    for key, _target in BUILD_TARGETS:
        assert f'"{key}"' in BUILD_PROBE_SOURCE, (
            f"BUILD_TARGETS declares {key!r} and the probe never reports it")


def test_the_two_marked_probes_do_not_share_a_mark():
    """One parser reads both, so a shared mark would let (h)'s lines answer (i)'s questions."""
    assert BUILD_MARK != START_MARK


def test_a_build_question_that_passed_parses_as_a_pass():
    seen = parse_marked_verdicts("{} ok resolve\n".format(BUILD_MARK), BUILD_MARK)

    assert seen == {"resolve": None}


def test_a_failed_build_question_keeps_its_whole_reason():
    """The reason carries the wrapper's own refusal, collapsed to one line by the probe."""
    output = ("{} bad apply the wrapper refused, with one of its own exit codes -- exit 90"
              "\n".format(BUILD_MARK))

    seen = parse_marked_verdicts(output, BUILD_MARK)

    assert seen == {"apply": "the wrapper refused, with one of its own exit codes -- exit 90"}


def test_another_probes_verdicts_are_not_read_as_this_one_s():
    """Both probes exec into containers whose output this gate reads with the same function."""
    output = "{} ok /start/skill.tar.gz\n{} ok force\n".format(START_MARK, BUILD_MARK)

    assert parse_marked_verdicts(output, BUILD_MARK) == {"force": None}
    assert parse_marked_verdicts(output, START_MARK) == {"/start/skill.tar.gz": None}


# -- check (j): the git server -----------------------------------------------------------------
# The same FALSE RED as (h)'s when a copy drifts: the gate holds its own literals of the hub's
# header, route and hook directory.
def test_the_git_probe_the_image_runs_is_valid_python():
    """Same reason as check (h)'s: a syntax error here is a red gate about a healthy image."""
    ast.parse(GIT_PROBE_SOURCE)


def test_the_git_probe_presents_the_token_in_the_hubs_own_header():
    assert TOKEN_HEADER == app.TOKEN_HEADER


def test_the_git_probe_asks_for_a_request_the_hub_answers():
    """A renamed route or a request the hub refuses would turn the 200 row red."""
    path, _, query = GIT_URL.partition("?")
    assert path.startswith(f"/{githttp.ROUTE}/")
    rest = [segment for segment in path.split("/") if segment][1:]
    assert githttp.smart_request("GET", rest, query) is not None


def test_the_git_probe_looks_for_the_hook_where_the_hub_points_git():
    assert GIT_HOOK.endswith(f"/{githttp.HOOKS_DIR.name}/pre-receive")


def test_the_git_probe_answers_every_question_the_gate_declares():
    """As in check (i): a key renamed on one side only is a verdict that never comes back."""
    for key, _target in GIT_TARGETS:
        assert f'report("{key}"' in GIT_PROBE_SOURCE, (
            f"GIT_TARGETS declares {key!r} and the probe never reports it")


def test_the_git_probe_has_a_mark_of_its_own():
    """One parser reads all three, so a shared mark would let another probe's lines answer."""
    assert GIT_MARK not in (START_MARK, BUILD_MARK)
