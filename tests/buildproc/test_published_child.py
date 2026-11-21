"""What the build's environment carries (`child_environment`'s `extra`), and
`run_published` with `publishedchild`: a project's `published(hub)` called by a
real process behind the wrapper.

The function is plain Python here and the model has no geometry, so the suite
needs no CAD stack; `Hub` itself (`src.cadbuild.publish`) is imported by the
child as it is.
"""

import json
import sys
import textwrap

from src.buildproc import (STATUS_FAILED, STATUS_OK, child_environment,
                           run_build, run_isolated, run_published)

from probes import BUILD_LIMITS, TEST_LIMITS, payload

ENVIRONMENT_PROGRAM = """
    import json, os
    print("PAYLOAD " + json.dumps(dict(os.environ)))
"""


def seen_by_a_program(tmp_path, **options):
    home, tmp = tmp_path / "home", tmp_path / "tmp"
    home.mkdir()
    tmp.mkdir()
    script = tmp_path / "program.py"
    script.write_text(textwrap.dedent(ENVIRONMENT_PROGRAM), encoding="utf-8")
    result = run_isolated(
        [sys.executable, "-s", str(script)], limits=TEST_LIMITS,
        env=child_environment(home=home, tmp=tmp,
                              threads=TEST_LIMITS.occt_threads, **options))
    assert result.exit_code == 0, result.log
    return payload(result)


def test_an_extra_variable_reaches_the_child_and_nothing_else_of_the_hub_does(
        tmp_path, hub_secrets):
    seen = seen_by_a_program(tmp_path, extra={
        "BUILD_ENV_UPLOAD_KEY": "key-for-the-site"})

    assert seen["BUILD_ENV_UPLOAD_KEY"] == "key-for-the-site"
    for name in hub_secrets:
        assert name not in seen


def test_an_extra_variable_cannot_replace_a_fixed_key(tmp_path):
    seen = seen_by_a_program(
        tmp_path, kicad_url="http://kicad.invalid:8080",
        extra={"PATH": "/evil", "HOME": "/evil", "OMP_NUM_THREADS": "99",
               "KICAD_URL": "http://evil.invalid", "BUILD_ENV_KEPT": "1"})

    assert seen["PATH"] == "/usr/local/bin:/usr/bin:/bin"
    assert seen["HOME"] == str(tmp_path / "home")
    assert seen["OMP_NUM_THREADS"] == str(TEST_LIMITS.occt_threads)
    assert seen["KICAD_URL"] == "http://kicad.invalid:8080"
    assert seen["BUILD_ENV_KEPT"] == "1"


def test_a_build_gets_the_environment_it_was_given(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    (project / "project.json").write_text(
        json.dumps({"id": "abc123def456", "title": "Env"}), encoding="utf-8")
    # Fails at import, which needs no kernel, with the value in the message.
    (project / "model.py").write_text(
        'import os\nraise RuntimeError("seen=%s/%s" % (\n'
        '    os.environ.get("BUILD_ENV_X"), os.environ.get("HAMMEROLA_REVISION")))\n',
        encoding="utf-8")

    outcome = run_build(project, tmp_path / "staging", pid="abc123def456",
                        limits=BUILD_LIMITS,
                        environment={"BUILD_ENV_X": "x-value",
                                     "HAMMEROLA_REVISION": "dev"})

    assert "seen=x-value/dev" in outcome.log


def tree(tmp_path, published_body):
    """A project whose `published(hub)` runs `published_body`."""
    project = tmp_path / "project"
    project.mkdir()
    (project / "project.json").write_text(
        json.dumps({"id": "abc123def456", "title": "Published"}),
        encoding="utf-8")
    (project / "model.py").write_text(
        "def parts():\n    return {}\n\n"
        "def views():\n    return []\n\n"
        "def published(hub):\n"
        + textwrap.indent(textwrap.dedent(published_body), "    "),
        encoding="utf-8")
    return project


def test_published_is_called_in_the_tree_with_the_environment_it_was_given(
        tmp_path, hub_secrets):
    out = tmp_path / "said.json"
    project = tree(tmp_path, """
        import json, os
        keys = ("HAMMEROLA_PROJECT", "HAMMEROLA_VARIANT", "HAMMEROLA_REVISION",
                "BUILD_ENV_UPLOAD_KEY", "EDIT_TOKEN")
        said = {key: os.environ.get(key) for key in keys}
        said["cwd"] = os.getcwd()
        with open(os.environ["BUILD_ENV_OUT"], "w") as handle:
            json.dump(said, handle)
    """)

    outcome = run_published(
        project, pid="abc123def456", limits=BUILD_LIMITS,
        environment={"BUILD_ENV_OUT": str(out),
                     "BUILD_ENV_UPLOAD_KEY": "key-for-the-site",
                     "HAMMEROLA_PROJECT": "abc123def456",
                     "HAMMEROLA_VARIANT": "ceiling",
                     "HAMMEROLA_REVISION": "c0ffee"})

    assert outcome.status == STATUS_OK, outcome.log
    assert json.loads(out.read_text(encoding="utf-8")) == {
        "HAMMEROLA_PROJECT": "abc123def456", "HAMMEROLA_VARIANT": "ceiling",
        "HAMMEROLA_REVISION": "c0ffee", "BUILD_ENV_UPLOAD_KEY":
        "key-for-the-site", "EDIT_TOKEN": None, "cwd": str(project.resolve())}
    assert "published(): done" in outcome.log


def test_a_published_that_raises_fails_with_its_traceback(tmp_path):
    project = tree(tmp_path, "raise RuntimeError('the bucket said no')\n")

    outcome = run_published(project, pid="abc123def456", limits=BUILD_LIMITS)

    assert outcome.status == STATUS_FAILED, outcome.log
    assert "RuntimeError: the bucket said no" in outcome.log
    assert "published() raised RuntimeError: the bucket said no" in outcome.log
    assert "Traceback" in outcome.log
