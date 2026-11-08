"""`run_version` and `versionchild`: a project's version.py asked its version
by a real process behind the wrapper. No CAD stack: version.py is plain Python.
"""

import textwrap

import pytest

from src.buildproc import STATUS_FAILED, STATUS_OK, run_version

from probes import TEST_LIMITS


def ask(tmp_path, source, files=None):
    project = tmp_path / "project"
    project.mkdir()
    (project / "version.py").write_text(textwrap.dedent(source),
                                        encoding="utf-8")
    for name, text in (files or {}).items():
        (project / name).write_text(textwrap.dedent(text), encoding="utf-8")
    return run_version(project, pid="p", limits=TEST_LIMITS)


def test_the_version_is_read_in_the_project_s_directory_by_its_own_module(
        tmp_path):
    outcome, version = ask(tmp_path, """
        import changelog

        def version():
            return changelog.top()
    """, {"ChangeLog": "hammerola (1.4.2) stable; urgency=low\n",
          "changelog.py": """
        def top():
            return open("ChangeLog").read().split("(")[1].split(")")[0]
    """})

    assert outcome.status == STATUS_OK, outcome.log
    assert version == "1.4.2"
    assert "version: 1.4.2" in outcome.log


@pytest.mark.parametrize("source, said", [
    ("def version():\n    raise RuntimeError('no entry in ChangeLog')\n",
     "RuntimeError: no entry in ChangeLog"),
    ("def version():\n    return 3\n", "version() returned int, not a str"),
])
def test_a_version_py_that_gives_no_str_fails_saying_why(tmp_path, source,
                                                         said):
    outcome, version = ask(tmp_path, source)

    assert outcome.status == STATUS_FAILED, outcome.log
    assert version is None
    assert said in outcome.log


def test_a_tree_without_version_py_runs_nothing(tmp_path):
    assert run_version(tmp_path, pid="p", limits=TEST_LIMITS) == (None, None)
