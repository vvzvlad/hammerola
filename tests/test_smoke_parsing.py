"""The CAD probe's output parser, tested without docker.

`ci/smoke.py` is the publish gate and normally runs only on the runner, against a built image —
which is why nothing in it was covered here before. `parse_cad_verdicts()` is the exception worth
pulling out: it is a PURE function over a string, it decides whether seven CAD targets are
reported green or red, and the strings it has to survive are produced by libraries nobody here
controls. OpenCASCADE and VTK print during interpreter finalisation, `docker()` folds stderr into
stdout, so noise lands on both sides of the payload — and a parser that mishandled the trailing
kind failed all seven targets on an image that was perfectly fine.

Imported as `ci.smoke` on the strength of `pythonpath = .` in pytest.ini: `ci/` has no
`__init__.py`, and none is needed — python 3 treats it as a namespace package. Importing the
module is safe because everything in it is a definition; `main()` runs from the `__main__` block
only, so nothing here shells out to docker.
"""

import json

from ci.smoke import CAD_SENTINEL, parse_cad_verdicts

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
    whole remainder would raise `JSONDecodeError: Extra data` here and fail all seven CAD targets
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
    # the seven CAD rows will carry in the log — and it has to distinguish this case from "no
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
